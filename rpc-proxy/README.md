# Programmable RPC proxy

The site's pages read the Solana chain in the visitor's browser. Until now they did it through the
provider's own address, key included, published in `web/deployments/mainnet.json`. A provider's
"origin lock" does not stop a script that sets its own Origin header, so anyone who read that file
could spend the site's quota. This small service closes that hole. The pages talk to
`https://<your site>/rpc`; the proxy talks to the provider; the key stays on the server.

It is one Node process with no dependencies of its own (`ws` comes with web3.js at the repository
root). It writes no file. It keeps no record of who asked what.

What it does, in order, for every request:

1. Looks at the `Origin` header. A page of another website is refused with HTTP 403 before anything
   is read or charged, on HTTP and on the WebSocket upgrade. Only the site's own origins pass
   (`ALLOWED_ORIGINS`). A request with no `Origin` header at all is a script, a bot or a server, not a
   page, and it is served as before, with the same budgets: a browser cannot leave the header out,
   and a script could write any value in it anyway.
2. Takes POST JSON-RPC at `/` or `/rpc` (Caddy passes the path as it is). Bodies over 64 KB are
   refused. Single requests and batches up to 50 pass; each item of a batch counts as one request
   everywhere below.
3. Checks every method against an allow-list: what the site and the SDK call, nothing else. Anything
   else is answered with JSON-RPC error -32601 and never reaches the provider. A `getMultipleAccounts`
   with more than 100 keys, or with one key more than twice, is answered with -32602: one program's
   data account named 100 times is an 80 MB answer for one request. A batch with any refused item is
   answered here, whole, and none of it goes up.
4. Charges the visitor's address: 60 requests a minute, up to 120 at once, 10 `sendTransaction` a
   minute, 20,000 requests a day, and 50 MB of answers a minute. An IPv6 address is charged by its
   /64, the network one machine usually gets. Charges the whole proxy: 1500 requests a minute, 600,000
   a day, 200 MB of answers a minute and at most 32 MB of them at once. Over a budget the answer is
   HTTP 429 with a JSON-RPC error
   (-32029) that names the budget, and a `Retry-After`. The site's pages already turn a 429 into "The
   RPC at <host> is rate limiting this browser"; web3.js itself retries a 429 a few times with growing
   pauses.
5. Forwards what is left to the provider over a keep-alive connection and streams the answer back,
   always as `Content-Type: application/json`. An answer over 8 MB is not passed on: when the
   provider names its length (the validator does), the client gets a JSON-RPC error and the provider's
   socket is cut before a byte goes out; when it does not, the answer is cut where it passes 8 MB and
   the client sees the connection end early. The bytes are charged to the two byte budgets: by the
   named length before the answer goes out (an answer that does not fit is refused like a request
   over budget), or piece by piece as it streams. A provider that does not answer within 20 seconds,
   answers an error status or cannot be reached becomes JSON-RPC error -32000 "upstream did not
   answer" (HTTP 502, or 429 when the provider itself said 429). The provider's address is in no
   answer and no log line.
6. Takes the WebSocket upgrade at the same path and bridges it to the provider's WebSocket (see "The
   WebSocket" below): one token per connection, 4 connections per address and 200 in all, 20 live
   subscriptions per connection, only `signatureSubscribe`, `signatureUnsubscribe` and web3.js's
   `ping` heartbeat, which the proxy answers itself.
7. Counts everything for `GET /health`: requests, refusals by reason, upstream failures, answer
   bytes, calls per method, WebSocket connections and subscriptions. No addresses.

## Settings

The environment, read by systemd from `/etc/programmable/rpc.env`. `.env.example` is the template.
Every value but the first has a default.

| Name | Default | Meaning |
|---|---|---|
| `UPSTREAM_RPC` | required | The provider's HTTP address, key included. |
| `UPSTREAM_WS` | derived | The provider's WebSocket address. Derived as web3.js does: `wss` for `https`, same host and path; a port, when one is named, plus one. |
| `UPSTREAM_ORIGIN` | empty | Sent as the `Origin` of every upstream request and WebSocket upgrade. Needed when the provider's node is locked to the site's origin (a Chainstack access rule): set it to the site's address, `https://programmableonsol.com`. Scheme and host only. |
| `ALLOWED_ORIGINS` | `https://programmableonsol.com,https://www.programmableonsol.com` | The browser origins served, comma separated, scheme and host only. Any other `Origin` gets 403. No `Origin` at all is served. `*` serves every origin (a run by hand only). A malformed entry stops the start with a sentence that says so. |
| `HOST`, `PORT` | `127.0.0.1`, `8797` | Where to listen. Caddy forwards `/rpc` here. |
| `WS_PORT` | off | A second port for WebSocket upgrades only (a client that derives the WebSocket port as the RPC port plus one). Not needed behind Caddy. |
| `RATE_PER_MINUTE`, `RATE_BURST` | `60`, `120` | Requests a minute per visitor address, and how many may come at once. |
| `SEND_PER_MINUTE` | `10` | `sendTransaction` a minute per visitor address. |
| `RATE_PER_DAY` | `20000` | Requests a day per visitor address: a budget of this size that refills over 24 hours. |
| `GLOBAL_PER_MINUTE` | `1500` | Requests a minute for the whole proxy. |
| `GLOBAL_PER_DAY` | `600000` | Requests a day for the whole proxy, refilled over 24 hours. The provider's plan holds 20 million a month. |
| `MAX_ANSWER_BYTES` | `8388608` (8 MB) | The largest answer passed on. |
| `BYTES_PER_MINUTE` | `52428800` (50 MB) | Bytes of answers a minute per visitor address. Never under `MAX_ANSWER_BYTES`. |
| `GLOBAL_BYTES_PER_MINUTE` | `209715200` (200 MB) | Bytes of answers a minute for the whole proxy. |
| `GLOBAL_BYTES_BURST` | `33554432` (32 MB) | Bytes of answers the whole proxy takes at once: what may be streaming at the same moment. Never under `MAX_ANSWER_BYTES`. Measured on the local chain: thirty 7 MB answers asked at once took the process to 128 MB with no such burst (the unit allows 150 MB), and to 85 MB with it. |
| `BODY_LIMIT_BYTES` | `65536` | The largest request body. |
| `BATCH_LIMIT` | `50` | The most requests in one batch. The coin page reads its history as one batch of 50. |
| `UPSTREAM_TIMEOUT_MS` | `20000` | How long to wait for the provider. |
| `WS_CONNECTIONS_PER_IP` | `4` | WebSocket connections per visitor address. |
| `WS_CONNECTIONS_MAX` | `200` | WebSocket connections open at once, everybody together. Past it an upgrade gets 503. |
| `WS_SUBSCRIPTIONS_PER_CONNECTION` | `20` | Live subscriptions per connection, the ones still waiting for their answer included. |
| `WS_IDLE_SECONDS` | `60` | A connection's upstream socket is closed after this long with no live subscription. |
| `WS_FRAMES_PER_MINUTE` | `120` | Messages a minute per connection, pings included. Past it the connection is closed (1008). |
| `METHODS` | the list in `lib/config.mjs` | The JSON-RPC methods that pass, comma separated. |
| `WS_METHODS` | `signatureSubscribe,signatureUnsubscribe,ping` | The methods that pass on the WebSocket. |
| `SUMMARY_EVERY_SECONDS` | `300` | A summary line in the log every so often. 0 turns it off. |

The default allow-list: `getAccountInfo`, `getMultipleAccounts`, `getProgramAccounts`, `getBalance`,
`getTokenAccountBalance`, `getTokenAccountsByOwner`, `getLatestBlockhash`, `getBlockHeight`,
`getSlot`, `getEpochInfo`, `getSignatureStatuses`, `getSignaturesForAddress`, `getTransaction`,
`simulateTransaction`, `sendTransaction`, `getMinimumBalanceForRentExemption`, `getFeeForMessage`,
`getVersion`, `getHealth`. web3.js names some of these differently in its own API
(`getMultipleAccountsInfo`, `getSignatureStatus`, `sendRawTransaction`, `getAddressLookupTable`,
which is a `getAccountInfo`).

What the defaults mean for a visitor: opening a coin page costs about 3 to 15 requests with the
watcher's feed, and about 15 to 70 without it (the collection panel's `getProgramAccounts`, the
history batch); then about 6 a minute while it stays open. A trade costs 3 to 6. Two coin pages
opened within a minute fit in the burst; a visitor who keeps ten tabs open meets the limit and the
pages tell them so. The site's answers are small. Measured through the proxy on every kind of page
of the local chain (84 pools, the watcher's feed off, so the pages read everything from the chain):
the largest single answer is 82,580 bytes (a `getProgramAccounts` of the hook checker and the
workshop; the Hook checker reads a program's data account by its first 45 bytes only), a coin page's
largest is under 7 KB, and the busiest page (Explore without the feed) reads 252 KB in 12 seconds.
That is a hundredth of the 8 MB cap and of the 50 MB a minute. The pool list grows by about 940
bytes a pool: it would meet the cap past about 8,000 pools, and only when the watcher's feed is down.
Raise `RATE_PER_MINUTE` and `RATE_BURST` in the env file if honest visitors meet the limits;
`GLOBAL_PER_MINUTE` and `GLOBAL_PER_DAY` are the ceilings that protect the provider quota whatever
happens.

## Install on the server

Everything below runs as root on the server. The repository is already at
`/home/programmable/sol-hooks` and `npm ci` has been run at its root (that is what installed `ws`).
One command per line.

1. Check that Node and `ws` are there:

   ```
   cd /home/programmable/sol-hooks
   node --version
   node -e "import('ws').then(() => console.log('ws ok'))"
   ```

2. Create the settings file from the template, lock it down, and put the provider's address in it:

   ```
   mkdir -p /etc/programmable
   cp /home/programmable/sol-hooks/rpc-proxy/.env.example /etc/programmable/rpc.env
   chmod 600 /etc/programmable/rpc.env
   nano /etc/programmable/rpc.env
   ```

   Set `UPSTREAM_RPC=` to the provider's HTTP address with its key (the value that is in
   `web/deployments/mainnet.json` today). Leave the rest as it is. Save and close.

3. The service runs as a user systemd makes for it at each start (`DynamicUser=yes`), not as the
   user who owns the repository. It sees an empty `/home` with two folders put back, read-only:
   `rpc-proxy/` and `node_modules/ws`. Both must be readable by everyone. Make sure they are:

   ```
   chmod -R o+rX /home/programmable/sol-hooks/rpc-proxy /home/programmable/sol-hooks/node_modules/ws
   ```

4. Install the service and start it:

   ```
   cp /home/programmable/sol-hooks/rpc-proxy/programmable-rpc.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now programmable-rpc
   systemctl status programmable-rpc --no-pager
   curl -s http://127.0.0.1:8797/health
   curl -s -X POST -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' http://127.0.0.1:8797/
   ```

   The last line must print a slot number. The log is `journalctl -u programmable-rpc -f`; its first
   line names the provider by its host only, and the origins it serves.

5. Give it a public address. In `/etc/caddy/Caddyfile`, inside the site's block, next to the
   existing `handle_path /watcher/*` block, add:

   ```
   @rpc path /rpc /rpc/*
   handle @rpc {
     reverse_proxy 127.0.0.1:8797
   }
   ```

   Then:

   ```
   caddy validate --config /etc/caddy/Caddyfile
   systemctl reload caddy
   curl -s https://YOUR_SITE/rpc/health
   ```

   The proxy takes `/rpc` and `/rpc/health` as they are. Caddy passes WebSocket upgrades through
   `reverse_proxy` as they are; nothing else is needed for the subscriptions.

6. Point the site at it. In `/home/programmable/sol-hooks/web/deployments/mainnet.json` change the
   `rpc` value to `"https://YOUR_SITE/rpc"`. Keep every other field. In `web/config.js` the `rpc`
   value must be empty (`""`) or the same address: a value there wins over the deployments file.
   The site's server reads these files from disk on every request, so nothing needs a restart.
   Check:

   ```
   curl -s https://YOUR_SITE/deployments/mainnet.json
   ```

   The provider's host must not appear anywhere in that answer.

7. Try it in a browser: open a coin page, then the browser's developer tools, Network tab. Every
   `POST` goes to `/rpc` and one WebSocket to `wss://YOUR_SITE/rpc`; nothing goes to the provider's
   host. Make a small trade: it confirms as before. `curl -s https://YOUR_SITE/rpc/health` then shows
   the methods the page called under `methods` and one connection under `ws`.

8. Rotate the key. The old key has been public since the site went live, so once the proxy carries
   the site, replace it:

   1. In the provider's console make a new endpoint (or regenerate the key of the current one).
      Chainstack: open the node, "Access and credentials", regenerate or add a key. Copy the new HTTP
      address.
   2. `nano /etc/programmable/rpc.env` and set `UPSTREAM_RPC=` to the new address. Save.
   3. `systemctl restart programmable-rpc`
   4. `curl -s -X POST -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' http://127.0.0.1:8797/` must print a slot again.
   5. The two other users of a provider key on the server: the site's trade API (`PROGRAMMABLE_RPC`
      in its environment) and the watcher (`RPC_URL` in `watcher/.env`). If either used the old key,
      give them the new address too and restart them (`systemctl restart` their units).
   6. Only then delete the old key in the provider's console. Pages a visitor still has open with
      the old `mainnet.json` cached stop working at that moment; a reload fixes them.

## Upgrading a running proxy to this version

For a server where the proxy already runs (the first version: `User=programmable`, CORS for every
origin). One command per line, as root.

1. Keep the running version, to go back to it:

   ```
   cp /etc/systemd/system/programmable-rpc.service /var/backups/programmable-rpc.service.before-r14
   tar -czf /var/backups/rpc-proxy-before-r14.tgz -C /home/programmable/sol-hooks rpc-proxy
   chmod 600 /var/backups/rpc-proxy-before-r14.tgz
   ```

2. Copy the new `rpc-proxy/` folder over the old one (`index.mjs`, `lib/`, `test/`, `package.json`,
   `README.md`, `.env.example`, `programmable-rpc.service`), then give it its owner back and make it
   readable by everyone:

   ```
   chown -R programmable:programmable /home/programmable/sol-hooks/rpc-proxy
   chmod -R o+rX /home/programmable/sol-hooks/rpc-proxy /home/programmable/sol-hooks/node_modules/ws
   ```

3. The settings. Nothing must change in `/etc/programmable/rpc.env`: every new setting has a default,
   and the default origins are the site's. Check that the file is still root's alone:

   ```
   stat -c '%a %U' /etc/programmable/rpc.env
   ```

   It must print `600 root`.

4. The new unit, and the restart:

   ```
   cp /home/programmable/sol-hooks/rpc-proxy/programmable-rpc.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl restart programmable-rpc
   systemctl status programmable-rpc --no-pager
   ```

5. Checks:

   ```
   ps -o user=,pid= -p $(systemctl show -p MainPID --value programmable-rpc)
   grep -o '/home/[^ ]* ro' /proc/$(systemctl show -p MainPID --value programmable-rpc)/mountinfo
   curl -s -X POST -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' http://127.0.0.1:8797/
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "origin: https://example.org" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' http://127.0.0.1:8797/
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "origin: https://programmableonsol.com" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' http://127.0.0.1:8797/
   curl -s https://programmableonsol.com/rpc/health
   journalctl -u programmable-rpc --no-pager -n 5
   systemd-analyze security programmable-rpc --no-pager | tail -1
   ```

   The first line names the user `programmable-rpc` (made by systemd), not `programmable`. The second
   prints the two folders the process sees under `/home`, each read-only:
   `/home/programmable/sol-hooks/node_modules/ws ro` and `/home/programmable/sol-hooks/rpc-proxy ro`,
   and nothing else. The third prints a slot. The fourth prints
   `403`, the fifth `200`. The health answer has `limits.origins`, `answers` and `ws.upstreams`. The
   journal's start line names the origins. Then open a coin page of the live site and make a small
   trade: it confirms as before, and `/rpc/health` shows `ws.total` one higher.

6. If it does not start, the journal says why (`journalctl -u programmable-rpc -n 30`). Status
   `200/CHDIR` means the dynamic user cannot read `rpc-proxy/`: run the `chmod` of step 2 again. To go
   back to the previous version:

   ```
   cp /var/backups/programmable-rpc.service.before-r14 /etc/systemd/system/programmable-rpc.service
   rm -rf /home/programmable/sol-hooks/rpc-proxy
   tar -xzf /var/backups/rpc-proxy-before-r14.tgz -C /home/programmable/sol-hooks
   systemctl daemon-reload
   systemctl restart programmable-rpc
   ```

7. The site and the watcher run as the user `programmable`; the proxy no longer does. Give those two
   units the same view of other processes as the proxy has, so that neither can look into another
   user's process. The two lines are

   ```
   [Service]
   ProtectProc=invisible
   ```

   in a drop-in file of each unit. These commands write them and restart the two services:

   ```
   mkdir -p /etc/systemd/system/programmable-site.service.d /etc/systemd/system/programmable-watcher.service.d
   printf '[Service]\nProtectProc=invisible\n' > /etc/systemd/system/programmable-site.service.d/protect-proc.conf
   printf '[Service]\nProtectProc=invisible\n' > /etc/systemd/system/programmable-watcher.service.d/protect-proc.conf
   systemctl daemon-reload
   systemctl restart programmable-site
   systemctl restart programmable-watcher
   systemctl show -p ProtectProc programmable-site programmable-watcher
   ```

   The last line prints `ProtectProc=invisible` twice. Then check the site and the watcher as after any
   restart (`curl -s -o /dev/null -w '%{http_code}\n' https://programmableonsol.com/` prints `200`,
   `curl -s http://127.0.0.1:8796/health` answers). The watcher's feed lock still sees a `--once` run
   started by root: it asks the system whether the process id runs, which works across users. To take
   the two lines away again: `rm` the two `protect-proc.conf` files, `systemctl daemon-reload`, and the
   two restarts.

## Watching it

```
journalctl -u programmable-rpc -f
curl -s http://127.0.0.1:8797/health
```

`/health` answers:

| Field | Meaning |
|---|---|
| `limits` | Every budget and cap in force, and the origins served. |
| `requests.http`, `requests.items`, `requests.batches` | POST requests seen, JSON-RPC items in them, how many were batches. |
| `requests.forwarded`, `requests.answered` | Requests that went to the provider, and that it answered. |
| `refused.origin` | Requests and upgrades from another website's page (403). |
| `refused.method`, `refused.params` | Items outside the allow-list; `getMultipleAccounts` items with too many keys or one key too often. |
| `refused.rate`, `refused.rateSend`, `refused.rateDaily` | Requests over a visitor's budget a minute, over its `sendTransaction` budget, over its budget a day. |
| `refused.rateGlobal`, `refused.rateGlobalDaily` | Requests over the proxy's budget a minute, a day. |
| `refused.bytes`, `refused.bytesGlobal`, `refused.answerSize` | Answers over a visitor's byte budget, over the proxy's, over the answer cap. |
| `refused.body`, `refused.json`, `refused.batch`, `refused.path` | Bodies too large, bodies that were not JSON-RPC, batches too long, requests to other paths. |
| `upstream.errors`, `upstream.timeouts`, `upstream.badStatus`, `upstream.unreadable`, `upstream.wsErrors` | The provider unreachable, late, answering an error status, answering something unreadable, refusing a WebSocket. |
| `answers.bytes`, `answers.largest`, `answers.cut` | Bytes of answers passed on, the largest single answer, answers cut on the way. |
| `methods` | Calls per method, most called first. |
| `ws.open`, `ws.upstreams`, `ws.subscriptions`, `ws.pending` | Counted from the live connections: client connections open now, upstream sockets open now, subscriptions the provider confirmed and has not ended, requests waiting for their answer. |
| `ws.total`, `ws.upstreamsOpened`, `ws.messages` | Client connections and upstream sockets since the start, messages from clients. |
| `ws.refusedConnections`, `ws.refusedFull`, `ws.refusedRate`, `ws.refusedSubscriptions`, `ws.refusedMethod`, `ws.refusedFrames` | Refusals on the WebSocket: too many connections from the address, too many in all, out of tokens, too many subscriptions, a method outside the list, too many messages. |
| `addresses` | How many visitor addresses the limiter remembers right now. |
| `memory.rssMb`, `memory.heapUsedMb` | The process's memory as the system sees it, and the JavaScript heap in use. The unit allows 150 MB. |
| `upstreamHost` | The provider's host. Never its path or key. |

A summary line is logged every five minutes. A rising `upstream.timeouts` or `upstream.errors`
means the provider is down or slow; `refused.rateGlobal` or `refused.rateGlobalDaily` rising means
the proxy's own ceiling is being hit and the budget may need to grow with the provider's plan. A
rising `refused.bytes` or `refused.answerSize` means somebody asks for big answers: the site never
does.

## The WebSocket

web3.js's `confirmTransaction` (which the site calls after every transaction) opens a WebSocket to
the RPC, derived from the HTTP address (`wss://`, same host, same path), subscribes to the
transaction's signature, and only once that subscription is live reads `getSignatureStatuses` once.
Without a WebSocket a confirmation waits until the blockhash expires and then reports the
transaction as expired, though it landed. So the proxy bridges the WebSocket too, and only for what
the pages use: `signatureSubscribe`, `signatureUnsubscribe`, and the `ping` notification web3.js
sends every five seconds to keep the socket open. The pages use no other subscription
(`onAccountChange`, `onLogs` and the like are not called anywhere in `web/` or `sdk/src`); anything
else is answered with -32601 and never reaches the provider.

Behind Caddy the pages derive `wss://YOUR_SITE/rpc`; Caddy forwards the upgrade to the proxy's
port. How the bridge works:

* The upgrade costs one token of the address's budget. It is refused for another website's origin
  (403), past 200 connections in all (503) and past 4 for the address (429).
* The provider's socket (`UPSTREAM_WS`, derived from `UPSTREAM_RPC` or set by hand) is opened on the
  first subscribe, not on the upgrade, and closed again after 60 seconds with no live subscription.
  The page's socket stays open meanwhile; its next subscribe opens a new one.
* Every message is parsed and checked: the allow-list, one token per request, 20 subscriptions live
  or waiting per connection, 120 messages a minute. What goes up is the proxy's own copy of what was
  checked, with an id of the proxy's own; the answer goes back to the page with the page's id. So the
  proxy knows what every answer answers.
* A request that finds the address's budget empty waits for its token, up to 10 seconds, and then
  goes up; one that would wait longer is refused (-32029). web3.js answers a refused subscribe by
  sending it again at once, in a loop: refusing it would turn a page that read a little fast into a
  flood of messages, and its confirmation into a socket closed for too many of them.
* A subscription counts once the provider confirms it. Its place is free again only when the
  provider confirms the unsubscribe or sends the signature's final notification (the node ends a
  signature subscription itself then). An unsubscribe the provider refuses frees nothing.
* `ping` never goes up. The proxy pings both sockets itself every 30 seconds, and drops a page that
  stops answering. A ping that carries an id is answered here, the way the validator answers it.
* While the provider's socket opens, up to 20 messages wait; one more closes the page's socket with
  1008. When the provider closes its socket on its own, the page's is closed too; when the page
  closes, so is the provider's.

## Running it by hand, and the tests

```
cd rpc-proxy
cp .env.example .env
npm test
UPSTREAM_RPC=http://127.0.0.1:8899 ALLOWED_ORIGINS=* node index.mjs
```

`npm test` runs 70 tests against stand-in providers: the allow-list, the `getMultipleAccounts`
rule, batches, the body cap, every budget (a minute, a day, bytes, for an address and for the
proxy), the answer cap with and without a length, every way the provider can fail, the key never
appearing in an answer or a log line, `/health`, the origins and CORS, the address table (least
recently used out first, IPv6 by /64), the WebSocket bridge (its ids, its slots, the upstream opened
late and closed when idle, its caps), web3.js's own `Connection` confirming a transaction through the
proxy, the service as the unit starts it under its memory cap, and a flood of 500 requests from one
address while another keeps reading. The `review_r12_*` files are the round-12 review's own tests,
kept as they were written where the behaviour they guard is unchanged.

With the local chain and the reference site running (`HANDOFF.md`, section 3),
`test/e2e-local.mjs` starts the proxy against the validator and a stand-in of the site whose
`deployments/localnet.json` names the proxy, then runs a browser flow through it:

```
node rpc-proxy/test/e2e-local.mjs --load -- node web/review/flow-launch.mjs ORIGIN out/e2e-launch C,P
RATE_BURST=240 node rpc-proxy/test/e2e-local.mjs -- node web/review/flow-collectible.mjs ORIGIN <pool> out/e2e-col
```

The word `ORIGIN` is replaced by the stand-in's address, and the proxy serves that origin only. The
proxy takes its other settings from the environment. flow-collectible buys, withdraws, sells and
withdraws again on one page within half a minute, with the watcher's feed off: about 140 requests,
more than the default burst of 120 and what refills in that time, so at the defaults its last reads
meet 429. A person is slower; the run takes `RATE_BURST=240`. The stand-in's address ends up in the
metadata the flows write on chain, so a stand-in on a port of four digits (`--standin 8799`, the
default) keeps the launch costs equal to a run against `http://localhost:8787`.
Nothing in `web/` is edited. The validator answers WebSocket upgrades on its RPC port plus one, and
so does the proxy here (`WS_PORT`), because web3.js derives the WebSocket port that way when an
address names a port.

## Design notes

* **Who is the visitor.** Behind Caddy the request's socket is loopback, and the visitor's address
  is the LAST entry of `X-Forwarded-For`, the one Caddy appends. A visitor cannot pick an address by
  sending the header: Caddy appends the real one after it. A request that does not come through
  loopback is charged to its socket address. An IPv6 address is charged by its /64.
* **Origins.** A browser always sends `Origin` on a cross-site request and on a WebSocket upgrade,
  and a page cannot change it, so another website's page is refused. A script can send any `Origin`,
  or none: the origin rule is not what limits scripts, the budgets are. That is why a request with no
  `Origin` is served.
* **Batches.** The items of a batch are checked one by one. When all of them pass, they go to the
  provider as one batch and the answer streams back. When any is refused, the whole batch is answered
  here: the refused items with their own error, the others with -32600 "send the allowed items on
  their own". Merging the provider's answer with the refusals would mean holding it in memory. A
  batch costs one token per item.
* **Big answers.** One item can ask for a lot: `getProgramAccounts` of a big program, or
  `getMultipleAccounts` of 100 large accounts. The answer cap bounds one answer, and the byte budgets
  bound what one address and the whole proxy pass on in a minute. The proxy never holds an answer in
  memory: it streams, and a slow reader slows the provider's socket down instead of filling memory.
  The SDK's rules view reads a strict coin's creator account and the wallet's in one call, which is
  the same key twice when no wallet is connected; that is why a key may appear twice.
* **Memory.** The limiter keeps its addresses in order of last use. An address is forgotten ten
  minutes after its last request once its day budget is full again (an address that spent much of its
  day is remembered until then), never while it holds a WebSocket connection, and at 20,000 addresses
  the least recently used one makes room at once. The service runs under `MemoryMax=150M`; Node is
  started with a 96 MB heap so it collects garbage before the cgroup acts.
* **Timeouts.** Node keeps an idle connection from Caddy for 125 seconds, longer than Caddy's own 2
  minutes, so Caddy never sends a request on a socket Node is closing.
* **The user.** The service runs as a user systemd makes at each start (`DynamicUser=yes`), in a
  view of the disk where `/home` holds only the proxy's code and `ws`, read-only. It cannot read the
  watcher's `.env`, the site's files or any key, and it cannot see other users' processes
  (`ProtectProc=invisible`). The settings file stays root's: systemd reads it before it starts the
  process.
* **What is not here.** No cache of answers, no priority for the site over bots (the limits protect
  the quota, not the site's place in it), no per-method prices. A visitor who respects the limits
  can use the proxy from a script; that is accepted.

## Files

| File | What it is |
|---|---|
| `index.mjs` | The entry point: settings, start, stop. |
| `lib/config.mjs` | The settings, their defaults, the allow-lists, the origins, the derived WebSocket address, the strings to redact. |
| `lib/http.mjs` | The HTTP side: origins, paths, CORS, the body cap, the checks, the budgets, forwarding, the answer cap. |
| `lib/ws.mjs` | The WebSocket bridge, its ids and its caps. |
| `lib/limits.mjs` | Token buckets, the address table, the address keys, the visitor's address. |
| `lib/jsonrpc.mjs` | Request shapes, the `getMultipleAccounts` rule, and error answers. |
| `lib/upstream.mjs` | The keep-alive client for the provider. |
| `lib/counters.mjs` | What `/health` answers. |
| `lib/log.mjs` | The logger that redacts the provider's address. |
| `lib/server.mjs` | Puts the pieces together. |
| `test/*.test.mjs` | The unit tests (`npm test`). |
| `test/fake-upstream.mjs`, `test/helpers.mjs` | The stand-in provider most tests use. |
| `test/e2e-local.mjs` | The end to end runner for the local chain. |
| `programmable-rpc.service` | The systemd unit. |
| `.env.example` | The settings template for `/etc/programmable/rpc.env`. |
