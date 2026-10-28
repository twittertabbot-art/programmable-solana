# Handoff: a DEX with pool hooks, and a launchpad, for Solana

Written for the Programmable team, who take this code over and run it as their platform
on Solana. Fourth edition, 2026-10-16. Read this file first. Section 2 says exactly what was
run and what was not.

If you hold an earlier package of this code, discard it and use this one. The one dated
2026-10-12 has two flaws that are fixed here (`SECURITY.md`, findings 28 and 29); the
fix for the first changes an address that the pool and every hook must agree on, so that
code cannot be patched in place. The one dated 2026-10-14 has neither the strict coin
(section 9) nor the reference site in its current form. The third edition, also dated
2026-10-16, has no curve launch (section 8): its pools can only be seeded with the
creator's own SOL, and its pool account has an older layout of the reserved bytes.

## 1. What you are getting

A complete trading stack for Solana in which every pool can run a small program of its
own, a **hook**, the way Uniswap v4 pools do on Ethereum.

| Piece | Where | What it is |
|---|---|---|
| The DEX | `programs/hookpool` | Constant-product pools, seeded with real SOL or opened on a curve with 30 virtual SOL that graduates at 85 real SOL (section 8). A pool may name one hook. The pool calls it around swaps and liquidity changes, and holds every answer to hard caps. |
| The launchpad | `programs/hooklaunch` | Anyone creates a coin, its pool and its hook in two transactions. Fixed supply, no mint or freeze authority, a final name, and liquidity that is locked in the pool forever: the creator's own SOL, or none at all on the curve (section 8). |
| Five ready hooks | `programs/hook_tax`, `hook_launch_guard`, `hook_buyback`, `hook_rules`, `hook_collectible` | A tax to a treasury. A high buy fee that falls away after launch. Buyback and burn. Launch rules, called modules on the site: six rules a launcher combines, three of them with a buy rate and a sell rate of their own, fixed at launch, and a strict coin that adds a max wallet, an early lock and rewards for every registered holder (section 9). NFTs pegged to the coin, a Solana take on Unipeg (section 10). |
| A kit for other people's hooks, and the Custom hooks pages | `hook-template/`, `examples/hooks/`, `crates/hookpool-interface`, `web/workshop*` | A developer writes a hook, tests it against the real pool, deploys it frozen, and anyone can launch a coin on it. The pool accepts no outside hook whose code can still change. The Custom hooks pages list every such hook that has a coin, each with a page of its own, and the launch form builds its settings (section 12). |
| TypeScript SDK | `sdk/` | Everything a site or a bot does: list pools, quote, swap, launch, liquidity, collectibles, events. `sdk/README.md` is its reference. |
| A reference website | `web/` | Static pages, no framework, in the look of programmable.market: Explore, Launch a token (Module Mode, Collectible, Custom hook), the coin page, liquidity, the hook checker, Custom hooks, docs. Take the pages, or only read how they use the SDK. |
| A trade API | `web/api/`, `API.md` | Two HTTP calls: a quote, and a transaction ready to sign. For bots and other sites. |
| Integration documents | `INTEGRATORS.md`, `idl/`, `scripts/raw-swap-example.mjs` | What another DEX, an aggregator or an indexer needs to trade and index the pools with none of this code. |
| Jupiter adapter | `jupiter-adapter/` | The Rust adapter Jupiter asks a new DEX for, with the quote-parity proof they ask for. |
| The keeper and monitor | `watcher/` | A small service. It keeps the collectibles in line, runs the buybacks and burns, and simulates trades on every hooked pool, with alerts. |

Nothing is deployed to devnet or mainnet. No outside firm has audited it.

## 2. What was verified, and how

Everything below was run on 2026-10-16 on a local validator (Agave 4.3.0), first in the
working tree and then again from the zip itself, unpacked into an empty folder with an
empty build directory and fresh keys, following this file.

| What | How to run it | Result |
|---|---|---|
| The programs, in process | `bash build.sh build`, then `bash build.sh test` | 295 tests pass (2026-10-23): 242 run the real Token-2022 and Metaplex Core programs in LiteSVM, 53 are unit tests. They include a hostile hook that returns every forbidden answer and tries to reach other hooks with the pool's signature, random walks over the pegged coin, over every instruction of the rules template, over every instruction and every kind of transfer of the strict coin, and over a pool on the curve (300 buys and sells from four wallets with the fees on, then everybody sells everything back), with the invariants checked after each step. The 242 include the 11 adversarial tests the independent review of the curve left in `tests/tests/review_curve.rs`, which are not in the package (284 tests without them). |
| The SDK | `npm run typecheck -w sdk`, `npm run build -w sdk`, `node sdk/examples/quickstart.mjs` | Types clean. `npm test -w sdk`: 18 unit tests on the built bundle (the curve arithmetic, where `graduate` goes, and that the signed minimum is never lowered, the 89 SOL case from far below the target included). The quickstart launches a coin, buys and sells, then launches a coin on the curve, graduates it with its third buy and trades after; every quote equals what the chain pays, to the unit. |
| Launch and trade, the four standard coins | `node scripts/e2e.mjs localnet none`, then `tax`, `launch_guard`, `buyback` | All pass. Every launch leaves its liquidity locked in the pool. Quotes equal the chain. `tax`: with the treasury account closed the trade still goes through, the tax waits in the pool and is paid out later. `buyback`: the first call only records the pool, a call that comes too soon is refused, and the buy at the per-run limit burns exactly the quoted amount. |
| Modules (launch rules) | `node scripts/e2e-rules.mjs localnet` | 233 checks pass on four coins: every share of the fee against a book kept by hand, to the lamport; staking, the 0.1% threshold and rewards; the burn through every step, with a pumped price that makes it wait; the sniper fee and the buy limit inside and after their windows; a creator lock made in the launch transaction. |
| The strict coin | `node scripts/e2e-strict.mjs localnet` | 292 checks pass: every bound refused by name; the first buy early and under the cap; buys and sends above the max wallet refused by the SDK and by the chain, exactly the room accepted; early coins held until the unlock and free after it; the creator's floor; rewards to registered holders to the lamport; the share that goes to the burn below 0.1% registered; a token burn and `sync_holder`; closing a record; the burn through its steps; deposits refused while the max wallet runs; inside a sniper window the largest buy the SDK accepts for a wallet near the cap lands on chain, and the one the old sizing would have allowed is refused; a burn pot of one lamport gives an observe call and no error. |
| The curve | `node scripts/e2e-curve.mjs localnet` | 311 checks pass on eight coins. A plain coin: the first buy to the unit against the SDK's quote; a sell paid from real SOL only; a sell past the real reserve cannot be built; liquidity and `graduate` refused while the curve is open, by number; three wallets buy to 85 SOL and the buy that crosses the target carries `graduate`, the price before and after equal to the unit, the burn and the fee counter equal to the SDK's arithmetic; a second `graduate` lands and changes nothing (pool bytes and supply compared); liquidity works after. A modules coin on the curve, left open: its burn stores and compares effective prices and buys once. A strict coin on the curve with a 5% graduation fee: graduated by a fourth wallet, the platform collects the fee. A pool made directly with `create_curve_pool`, and a partial supply refused. A seeded launch unchanged, and refused by `graduate`. A pegged collectible coin refused on the curve by the SDK and, sent raw, by the chain. Where `graduate` goes: every trade checks its place and that the swap carries the trader's minimum unchanged; `graduate` sent by hand below the target lands and changes nothing; a crossing buy prepared with a 1% minimum, beaten to the target by another wallet's 30 SOL buy, fails on its slippage and leaves the wallet without coins, and the next buy graduates the coin first and fills exactly its quote; a sell on a pool past its target graduates it first and is paid on the graduated pool; a crossing buy, a sell back under the target and `graduate` in one transaction land, and the pool stays open. |
| The collectible hook, plain coin | `node scripts/e2e-collectible.mjs localnet` | Passes: a buy that decides nothing, a stranger's reveal, a mint that matches the revealed seed, a sell that burns the piece put last, a piece sent with its coins, a settle by a stranger, an art update for later pieces only, the lock. |
| The collectible hook, pegged coin | `node scripts/e2e-pegged.mjs localnet` | Passes: a wallet transfer that carries the piece, one that burns it, one chosen piece sent with exactly its coins, a sell that burns inside the swap. |
| A hook written by someone else | `hook-template/README.md`: `scripts/test.sh`, `scripts/deploy-freeze.sh localnet`, then `node scripts/e2e-custom.mjs localnet <program id>` | The template passes its 5 tests against the real pool, deploys frozen from a wallet that is not the platform's, and a coin launched on it trades with every fee right to the unit (20 checks). The two examples pass 4 and 5 tests and their proofs (21 and 28 checks). |
| The trade API | `node --test web/api/_test/*.test.mjs`, then `node scripts/e2e-api.mjs localnet` | 79 unit tests. Live: 303 checks (the count moves a little with what is on the chain), with 61 trades built by the API, signed, sent and compared with the chain, on every kind of pool, strict coins, curve coins and a third-party hook included. On a coin on the curve every quote carries its progress (raised, target, share sold) and says when the trade graduates the coin; a crossing buy graduates it on chain at the kept price; on a pool past its target the transaction graduates first and fills its quote to the unit, also when somebody else graduated the pool between the answer and the landing; a sell beyond the real SOL is answered 422 `CURVE_REAL_RESERVE`; and every one of the 69 swaps inspected carries a minimum at or above the quote less the slippage, never lowered. On a strict coin each refusal (max wallet, early lock, creator lock, a recipient without a record) comes from the API with its own code and, sent all the same, from the chain, also on a strict coin on the curve. Inside a sniper window the largest buy the API names lands, and the API counts what a buy really takes from the wallet (rents and the priority fee included) before it builds. |
| The integration document | `node scripts/check-integrators-doc.mjs http://127.0.0.1:8899`, and `node scripts/raw-swap-example.mjs` | Every address, layout, offset, discriminator, error number and formula of `INTEGRATORS.md` holds on the chain: 3,009 checks on a chain with 216 pools, 37 of them on the curve and 40 graduated, among them a simulated `graduate` with its arithmetic, its burn, the price kept and its event, a `graduate` below the target and a second one that change nothing, a trade with `graduate` in front on a pool past its target paid exactly the graduated quote, and a crossing buy and a sell back under the target in one transaction; and 1,826 on the smaller chain of the run from the zip. The no-SDK example trades right on nineteen kinds of pool, strict coins and seven kinds of curve pool included, graduates a pool, and sends on four. |
| The Jupiter adapter | `bash jupiter-adapter/test.sh` | 31 unit tests and 22 quote-parity tests on Jupiter's own test kit, curve pools included (no real SOL yet, after a first buy, with rules, past the target, graduated), and two sells the chain refuses with `CurveRealReserve` that the adapter refuses to quote. Strict and pegged coins are not offered, by design. |
| The watcher | `node --test watcher/test/*.test.mjs`, `node watcher/prove-settle.mjs`, `node watcher/prove-upkeep.mjs`, `node watcher/prove-burn.mjs`, `node watcher/prove-graduate.mjs` | 138 unit tests. Live: the keeper burns the pieces of a wallet whose coins left (29 checks), makes the NFTs of a pegged coin follow its transfers (53 checks), runs the buybacks and burns of a buyback coin, a rules coin, a strict coin and a rules coin on the curve, measured on the effective price, and lowers a strict coin's holder record that a token burn left too high (129 checks), and graduates a coin left past its target by a buyer whose client did not: nothing sent below the target or with the crank off, one `graduate` past it with the burn and the kept price checked, then nothing more (32 checks, `node watcher/prove-graduate.mjs`). |
| The reference site, in a browser | `node web/review/flow-launch.mjs http://localhost:8787 <prefix>`, `flow-curve.mjs`, `flow-rules.mjs`, `flow-templates.mjs`, `flow-workshop.mjs`, and the other `web/review/flow-*.mjs` | Headless Edge, real mouse and keyboard, a stand-in wallet that signs. The launch paths, a real launch of every type, and the strict coin from Module Mode to its coin page (a buy that registers, a buy above the cap and an early sell refused by the page and by the chain, the send form, Claim to the lamport, the burn), and a wallet that refuses to sign on the trade card, the liquidity page and a launch: 280 checks. The curve: the choice of how the pool starts, a plain coin and a modules coin launched on the curve and checked against the chain (the settings copied from the platform, every share locked, the first buy at the curve price, the total within 0.006 SOL of what the wallet spent), the coin page and the pool page while open, a sell the pool cannot pay, Explore and its filter, buys through the page up to graduation with the trader's minimum never lowered, a trade on a pool left past its target graduating it first and filling its quote, the Graduated mark and the burn, liquidity after it, a seeded launch, the pegged coin without a curve, the trade API agreeing with the page on the fill and the minimum: 158 checks. Modules against the chain: 411. The other launch types, trades, liquidity, the hook checker, a third-party hook: 481. Custom hooks: 163. The collectible, pegged, peg and supply-cap flows pass too. Run in the working tree only; the Custom hooks flow needs eight fixture hooks on the chain (its header says how to make them). |
| **Everything from the zip** | this file, sections 3, 6 and 12 | The zip was unpacked into an empty folder with an empty build directory and no keys. Built from nothing; every row above except the browser row was run again there, and all of it passed: the 225 Rust tests, the 18 SDK unit tests, the quickstart with its curve coin, the four standard coins, the modules rehearsal (233 checks), the strict coin's (292) and the curve's (311), the trade API (79 unit tests; 293 checks with 61 trades, and 302 once a third-party hook had a coin), the integration document (1,826 checks), the watcher (138 unit tests, a clean pass over all 35 pools, proofs of 31, 53, 129 and 32 checks), the hook kit and both examples (5, 4 and 5 tests; proofs of 21 and 28 checks), the adapter (31 and 22 tests). Then `scripts/rekey.mjs` gave the seven programs new ids and moved the six hook caller addresses the documents print with them (136 ids in 36 files). Everything was rebuilt and retested under the new ids (225 Rust tests, the SDK, 79 and 138 unit tests), deployed to an empty chain with `deploy.sh`, every rehearsal was run again with the same counts, the integration document was checked again against that chain (1,749 checks), and the adapter's fixtures were made again under the new ids, curve pools included (31 and 22 tests). No stage failed. The site's browser flows ran in the working tree on the same code. |

What was NOT verified:

* **Nothing was run on devnet or mainnet.** Every result here is from a local validator.
  The deploy script's devnet and mainnet paths were never completed.
* **Real wallets, only in part.** The browser tests drive the site with a stand-in wallet
  that signs like an extension. The real extensions were then tried on the local chain in
  a fresh browser profile with new throwaway wallets. Phantom (Localnet mode in its
  developer settings) signed every action of the site and all of them landed: a plain
  coin, a modules coin, a strict coin (the first buy registers the wallet), a collectible
  coin, a pegged coin, liquidity in and out, both transactions of a launch; because it
  cannot simulate against a private chain, each approval went through its "unsafe" double
  warning. Backpack, pointed at the local RPC, signed every action too. Solflare could not
  sign anything on a private chain (its server-side security check fails and it has no
  custom RPC setting). What no wallet could do on a private chain: show the coins (they
  list balances through their own indexers), so a send of a strict coin or a pegged coin
  from the wallet's own send screen, where the wallet itself must add the transfer hook's
  accounts, is NOT verified. Do it on a public network before the first strict or pegged
  launch (section 6, point 3).
* **No hosting.** The site and the server functions ran under `web/serve.js` only. The
  Vercel deployment and the uploads to Vercel Blob (a coin's metadata, a hook's
  description for the Custom hooks pages) were not exercised.
* **No load, and no long run.** No test of many trades at once, of a public RPC's rate
  limits, or of the watcher running for days. The keeper that runs buybacks and burns
  was proven on one coin at a time; its cost over many coins and many days is not
  measured.
* **Telegram alerts** of the watcher were not sent to a real chat in this round. Two
  paths of the burn keeper were tested in unit tests only: a run that waits because the
  price is above the record, and the alert after three failed passes.
* **The economics of the launch rules.** The tests prove that the rules do what
  `RULES.md` says and that the attacks tried on them lose money. Nobody has run a coin
  with real traders: whether a given set of rates, a staking share or a burn makes a
  coin better is not something a test shows.
* **Custom hooks with a real outside author.** The hooks listed in the tests were built
  with the kit by the same team, and their descriptions were served from the local
  server.
* **The strict coin on a real network.** Its rehearsal, its API section and its browser
  flow ran on a local validator. Two paths were tested in unit tests only: the trade
  API's answer for the creator lock after its date, and the watcher's holder sync when a
  transaction fails or its wallet cannot pay.
* **The SBPF v3 build**, needed only if a cluster stops accepting v0 programs.
* **The curve with real traders.** Graduation was rehearsed with scripted buyers on the
  local chain (section 2) and in process with random walks, including a buy that was beaten
  to the target, a sell on a pool past it, and a crossing buy and a sell in one
  transaction. Many traders racing for the same slot on a public network were not tried. A
  curve pool whose quote is not SOL, a plain collectible coin on the curve (traded once by
  the watcher's settle proof, not rehearsed), and a curve coin on the tax, launch guard or
  buyback hook or on a third-party hook were not run on a chain.
* **Jupiter's side.** The adapter passes Jupiter's test kit here; nobody at Jupiter has
  seen it.
* **Third-party hooks on liquidity callbacks**, and hooks deployed with loader v4: covered
  by the Rust suite or by reading the code, not by an outside developer's hook.
* **macOS.** Everything ran on Ubuntu 24.04 under WSL, and Node scripts also on Windows.
* **An outside audit.**

## 3. Try it: a local chain in a few minutes

You need Linux, macOS, or Windows with WSL, and: Rust, the Solana CLI (Agave) 4.3 or
newer, Anchor 1.2.0 (through `avm`), Node 22 or newer. The official installer sets them
up: https://solana.com/docs/intro/installation . Then `avm install 1.2.0` and
`avm use 1.2.0`.

From the folder of this file, one line at a time:

```
npm install
bash build.sh build
bash build.sh test
npm run build -w sdk
bash scripts/localnet.sh up
node scripts/init-platform.mjs localnet
node sdk/examples/quickstart.mjs
node scripts/e2e.mjs localnet tax
node scripts/e2e-rules.mjs localnet
node scripts/e2e-strict.mjs localnet
node scripts/e2e-curve.mjs localnet
node scripts/e2e-collectible.mjs localnet
node scripts/e2e-pegged.mjs localnet
node web/serve.js
```

* `build.sh build` takes several minutes the first time. Its output goes to
  `~/targets/sol-hooks`, outside this folder (`SOLHOOKS_TARGET_DIR` changes that).
* `localnet.sh up` starts a local validator with the seven programs already on it. It needs
  no key from anyone: it makes a local deployer wallet in `~/sol-secrets`.
* `quickstart.mjs` is the SDK in one file: launch a coin with a tax, quote, buy, sell;
  then launch a coin on the curve, buy it to graduation and trade it after.
* Each `e2e` script launches a coin and trades it, and prints every check it makes.
* The last line serves the reference site and the trade API at http://localhost:8787 .
  Open it in a browser with a wallet set to a custom RPC of `http://127.0.0.1:8899`.
* `bash scripts/localnet.sh stop` stops the validator.

`README.md` lists every script and what it rehearses.

## 4. How the pieces fit

```
                 wallets, bots, other sites
                          |
        +-----------------+------------------+
        |                 |                  |
   your website      trade API          aggregators
   (uses the SDK)    (web/api/v1)       (INTEGRATORS.md, jupiter-adapter)
        |                 |                  |
        +--------+--------+------------------+
                 |
            Solana programs
   hooklaunch --> hookpool <--> the pool's hook (a template, or anyone's frozen hook)
                     ^
                     |
                 watcher (keeper wallet): reveals, settles, upkeep, burns, graduations, alerts
```

* **Programs.** `hookpool` owns the vaults. A hook never touches funds: it is asked, it
  answers with a fee or a refusal, and the pool clamps the answer to the caps in the
  platform account. `hooklaunch` is a thin layer that creates the coin and calls
  `hookpool`.
* **Platform account.** One per cluster. It holds the admin, the treasury, the protocol
  fee, the caps for hooks, the launch fee, a pause switch, and a whitelist of up to eight
  upgrade authorities whose programs count as "platform templates".
* **The curve.** A pool opened on the curve prices trades with 30 SOL that are not there
  and pays out only what buyers put in. At 85 real SOL anyone graduates it in place: the
  virtual part goes, coins are burned from the vault, the price stays, the address stays
  (section 8).
* **Frozen or yours.** `create_pool` reads the hook program's upgrade authority. It takes
  the hook only if that authority is removed (a frozen third-party hook) or is on the
  whitelist (one of your templates). So nobody can change the code under a pool except
  you, for your own templates.

`HOOKS.md` is the specification. `SECURITY.md` is the security model and the log of
every review finding.

## 5. Putting it on your website

You do not have to take the reference site. The contract is the SDK.

* **SDK.** `sdk/README.md` is the reference and `sdk/examples/quickstart.mjs` the shortest
  complete use. `npm run build -w sdk` builds `sdk/dist/` for Node (with types),
  `web/js/hookpool.js` for the browser and `web/api/_sdk.js` for server functions.
* **Reference pages.** Each page is one HTML file and one JS file, on one stylesheet
  (`styles.css`, its tokens and components listed at its top) and one shell
  (`common.js`: header, menu, footer, wallet). `index.js` is Explore. `launch.js` is
  the "Launch a token" chooser; each launch path is its own page: `launch-modules.js`
  (Module Mode, with the strict modules in `launch-strict.js`), `launch-collectible.js`
  and `launch-hook.js` (the platform's single-purpose hooks and other people's hooks);
  `launch-core.js` holds what they share (coin details, review, the launch and its
  retry). `coin.js` is the coin page: one panel for price, chart and trade, then one panel
  per thing the coin has. `pool.js` is liquidity, `hooks.js` the hook checker,
  `workshop.js`, `workshop-hook.js` and `workshop-guide.js` the Custom hooks pages
  (section 12).
* **The look and the name.** The pages follow the look of programmable.market: its
  palette, type (Instrument Sans and IBM Plex Mono, both under the SIL Open Font License,
  self-hosted in `web/fonts/`), shapes and page structure. None of your files was copied:
  no logo, artwork, icon or text. The site's name and mark are ONE setting in
  `web/config.js` (`site: { name, mark }`): the name is "Programmable", the mark is
  empty until you put yours there.
  `web/SDK-GAPS.md` lists every place where a page needed something the SDK does not
  give, and what the page does instead. You will meet the same places on your own site.
* **Server functions you must host**, all under `web/api/`, written to run as Vercel
  functions and inside `web/serve.js`:
  * the trade API (`v1/quote.js`, `v1/swap.js`);
  * the piece renderer (`art.js`, served at `/art/...`). **Its address is forever.**
    Every collectible coin stores the renderer's base address on chain when it is
    launched, and every piece's metadata points there. If that address dies, the pieces
    lose their picture in every wallet. Launch collectible coins only against a domain
    you intend to keep.
  * the resolver of a launcher's own art (`_art.js` with `_artpack.js` and `_artpng.js`,
    served at `/art/u/<folder>/...` and `/art/settings`; HOOKS.md section 13, "A
    launcher's own art"). Its settings are environment variables: `ART_STORE` (`turbo` for
    Arweave through ArDrive Turbo, `irys`, or `local` for the stand-in), `ART_GATEWAYS`,
    `ART_NODE`, `ART_PAYMENT`, `ART_CACHE_DIR` and `ART_CACHE_MAX_MB` (default
    `<UPLOADS_DIR>/art-cache`, 1024 MB), `ART_HIDDEN_FILE` (default
    `<UPLOADS_DIR>/art-hidden.txt`, edited with `node scripts/art-hide.mjs`),
    `ART_FETCH_TIMEOUT_MS`, `ART_COMPOSITE_QUEUE`, `ART_COMPOSITE_WORKER`. No npm package:
    the PNG drawing is plain JavaScript on node:zlib (`node scripts/art-composite-bench.mjs`
    measures what a server can take). The browser stores of the real services,
    `web/js/art-store-turbo.js` and `web/js/art-store-irys.js`, are built apart in
    `sdk/art-vendor/` (`npm ci --ignore-scripts && npm run build` there).
  * the metadata upload (`metadata.js`): the JSON and image of a new coin. It uses
    Vercel Blob and needs `BLOB_READ_WRITE_TOKEN`. A coin's metadata address is final at
    launch, so this storage has to last too.
* **Modules on the form.** `launch-modules.js` holds the four presets and builds Module
  Mode and its review; `launch-strict.js` the strict modules and the panel that tells the
  launcher what a strict coin costs. It holds no bound of its own. The limits the form
  offers are `RULES_POLICY` in `sdk/src/rules.ts`: creator fee and rewards up to 2% a
  side, burn up to 1%, the three together up to 3%, a sniper fee from at most 50% over
  at most 5 minutes, a buy limit for at most 30 minutes, a creator lock of up to 90
  days. For the strict modules: `RULES_STRICT_POLICY` (a max wallet of 0.5% to 5% for up
  to 24 hours, an early window of up to 10 minutes with an unlock up to 24 hours after
  launch). The program's own ceilings are `RULES_CEILINGS` and `RULES_STRICT_CEILINGS`
  next to them. Change the policy there and rebuild the SDK: the form, its checks and the
  bounds table of the docs page follow.
* **The Custom hooks pages** read everything from the chain and from the files hook authors
  host. Two small files are yours: `web/workshop/reviewed.json`, the hooks you have read
  yourself (it ships empty), and `web/workshop/site.json`, which says whether your site
  stores a hook's description for its author (the same upload function as a coin's
  metadata). Section 12.
* **Configuration.** `web/config.js` picks the cluster and the RPC.
  `web/deployments/<cluster>.json` and `<cluster>-alt.json` are written by the deploy
  and setup scripts. The server functions read `PROGRAMMABLE_RPC` for a private RPC
  address and never return it. `API.md` lists the rate-limit settings.
* **The RPC proxy** (`rpc-proxy/`). The `rpc` of the deployments file is public: every
  visitor's browser reads it. A provider's key must not be in it, since a provider's origin
  lock does not stop a script. Run the proxy on the server (`rpc-proxy/README.md`: a systemd
  unit, its settings in `/etc/programmable/rpc.env`, a Caddy block for `/rpc`), and put
  `https://<your site>/rpc` in the deployments file. The proxy holds the key, passes only the
  methods the pages call, gives every visitor address a budget of requests a minute and the
  whole site one, and bridges the WebSocket that `confirmTransaction` needs. The trade API and
  the watcher keep their own private address; only the browser goes through the proxy.
* **The name.** The site's name is set in `web/config.js` (`site.name`, "Programmable");
  the mark stays empty until you put yours there (`site.mark`). Every string of the code
  is Programmable (section 14, "The name"). Set `HOOK_URI_BASE` to your own site before you run `scripts/init-platform.mjs`
  on a public cluster. The programs themselves are called `hookpool` and `hooklaunch`.
* **Wrapped SOL.** The pools trade wrapped SOL. The SDK wraps and unwraps around every
  trade, and it leaves a wallet's wrapped SOL account exactly as it found it: the default
  treasury of a tax coin is its dev's wrapped SOL account, and closing it would hold the
  tax back. If you build transactions yourself, keep that rule (`sdk/README.md`,
  "Wrapped SOL").
* **Pools the site shows.** The reference explore page lists every pool of the program,
  also pools somebody created directly, without the launchpad. The pool program
  guarantees less for those: section 11. Decide whether your site shows them.

## 6. Going live

1. **Program ids.** The repository ships with seven program ids. A program id is the
   public key of a keypair file, and only the first deploy on a cluster needs that file.
   The simple way is to make your own: `node scripts/rekey.mjs` creates seven keypairs in
   `~/sol-secrets/program-keys` and replaces the ids everywhere in this repository. Then
   rebuild and retest as it tells you. No secret has to travel. (The other way is to ask
   the previous owner for the seven files, privately.) Never run `anchor keys sync` in this
   repository: it would replace the ids in the programs with throwaway ones. `README.md`,
   "Toolchain", says why.
2. **The deployer.** Put the wallet that pays at `~/sol-secrets/<cluster>-deployer.json`.
   It becomes the upgrade authority of all seven programs and the platform admin.
   Mainnet needs about 21 SOL of rent for the programs, and about as much again for a
   moment while each one uploads. The rent comes back if you ever close a program.
3. **Devnet first.**
   ```
   bash deploy.sh devnet
   node scripts/init-platform.mjs devnet
   node scripts/e2e.mjs devnet tax
   ```
   A public devnet deployment is also what outside hook developers need (section 12).
   On devnet, test the real wallets before anything goes to mainnet: with Phantom,
   Solflare and Backpack, a buy and a sell of each kind of coin through the site, and a
   send of a strict coin and of a pegged coin from the wallet's OWN send screen to a
   wallet that never held it. The local chain could not give that test (section 2). On
   mainnet, Phantom simulates every transaction before it asks the user: the site's
   transactions use a lookup table (a v0 transaction) and must simulate clean there, or
   every user meets Phantom's "unsafe" screen.
4. **Mainnet.** `bash deploy.sh mainnet` is a dry run that prints sizes, rent and your
   balance, and sends nothing. `bash deploy.sh mainnet broadcast` deploys. Then
   `TREASURY=<address> HOOK_URI_BASE=https://<your site>/hooks node scripts/init-platform.mjs mainnet`.
   The script also sets the fees (0.2% protocol fee, caps of 10% for hook fees and 50%
   for fee overrides, 0.01 SOL launch fee; all overridable by environment variables
   named in the script), writes the curve settings (30 SOL virtual, graduation at 85 real
   SOL, no graduation fee; `CURVE_VIRTUAL_SOL`, `CURVE_TARGET_SOL` and `CURVE_FEE_BPS`
   change them, section 8) and creates the address lookup table.
5. **The program format.** The programs are built in the SBPF v0 format. A network
   feature (SIMD-0500), once active on a cluster, refuses new deploys in that format.
   It was inactive on mainnet and devnet on 2026-10-12, and `deploy.sh` checks it and
   stops if it is active. In that case build with `anchor build --arch v3`; the test
   suite then needs a newer LiteSVM. That path is not rehearsed.
6. **The 12-word phrase.** The Solana CLI (Agave 4.3) prints a 12-word recovery phrase
   for its buffer account during EVERY deploy, also one that finishes. Keep it out of
   logs you share. It matters only when a deploy is cut off: it then resumes the deploy,
   or takes the SOL in the buffer back (`solana program close`).
7. **Move the keys to a multisig** once it works: the upgrade authority of the seven
   programs (`solana program set-upgrade-authority`) and the platform admin
   (`transfer_admin`, then `accept_admin`). **Order matters:** add the multisig to the
   platform whitelist (`set_whitelist`) BEFORE you move a template hook's upgrade
   authority to it. A template whose authority is not on the whitelist is refused for
   new pools. Existing pools are not affected either way.
8. **Run the watcher** (`watcher/README.md`), with its keeper wallet funded with about
   0.1 SOL. Section 7.
9. **Point the site at mainnet** (`web/config.js`), with a paid RPC endpoint.
10. Optional, and asked for by explorers and listing venues: publish the IDLs on chain
    (`anchor idl init`) and verify the builds.

## 7. What must keep running

* **The watcher.** Collectible coins depend on three small jobs any wallet may do, and
  the watcher does them: it reveals the look of new pieces (a batch nobody reveals
  within about three and a half minutes falls to the common tier), it burns the pieces
  of wallets whose coins left, and on pegged coins it makes the NFTs follow the
  transfers. It also simulates a buy and a sell on every hooked pool each minute and
  alerts on Telegram when something changes. The burns of pieces pay the keeper the rent
  of what it burns.
* **The watcher again, for buyback, rules and strict coins.** The buyback of a buyback
  coin and the burn of a rules or strict coin are instructions anyone may call, and
  somebody has to. A run buys a slice at a time, at least 25 slots apart (section 9), so
  a pot is spent by calling on a timer. The watcher does that for every such coin. On a
  strict coin it also lowers a holder record that a token burn left above the wallet's
  real balance (`sync_holder`), so the burner does not keep earning rewards. Both jobs
  earn nothing back: each call costs the keeper the transaction fee, 5,000 lamports.
* **The watcher, for coins on the curve.** A coin graduates when anyone sends `graduate`
  once its pool holds 85 real SOL. The SDK and the trade API put that instruction after
  the buy that gets there and before any trade on a pool past it, so in practice a trader
  does it; the watcher sends it as well, every 15 seconds for a coin that needs it, for a
  coin whose last buyer used another client (section 8).
* **The renderer and the metadata storage** of section 5.
* **The trade API**, if bots use it.
* **The RPC proxy** (section 5, `rpc-proxy/`), when the site runs on a paid RPC: the pages
  read the chain through it. Without it they cannot read at all, unless the deployments file
  names an RPC directly, which puts that address in every visitor's hands.

No coin needs any of this to trade. Without the watcher a collectible coin loses its
rare pieces and its peg, and a buyback or rules coin keeps collecting SOL that nobody
spends.

## 8. How a launch starts: the curve

A coin can start in two ways. The site offers the curve first.

**The curve (no SOL from the creator).** The launchpad mints 1,000,000,000 coins (6
decimals) and puts all of them into the pool, with no SOL next to them. The pool prices
trades as if it held 30 SOL: that is the "virtual" part, written into the pool as
`virtual_quote`. Buyers put in real SOL and the price follows the usual constant product
on `reserve_quote + virtual_quote`. A sell is paid from the real SOL only. Liquidity
cannot be added or removed while the curve is open. When the pool holds 85 real SOL the
coin graduates: a permissionless instruction, `graduate`, drops the virtual part and burns
coins from the pool's own vault so that the price does not move. From then on it is an
ordinary pool of this DEX, at the same address, with the same hook and the same locked
liquidity. There is no second pool and no migration.

What the defaults give (the SDK computes the exact figures from the platform account and
the pool, `curveProgress` and `graduationBurn`; the site shows them):

| Moment | What the pool holds | Price and market cap |
|---|---|---|
| Opening | 1,000,000,000 coins, 0 SOL (30 virtual) | 0.00000003 SOL per coin; market cap 30 SOL |
| Graduation, before the burn | about 260.9M coins, 85 SOL (30 virtual) | 73.9% of the supply sold; market cap about 441 SOL |
| Graduation, after the burn | about 192.8M coins, 85 SOL | about 68.1M coins (6.8% of the supply) burned; the price is the same |

LP fees stay in the real reserve, so the real figures move a little in the holders'
favour. The burn at graduation keeps the price exactly or raises it by less than one unit
of the coin; it never lowers it.

**The seeded launch (the old way).** The creator puts real SOL into the pool next to the
supply, chooses the amount, and that SOL is locked forever. Nothing about it changed.

**Who graduates a coin.** Anyone may send `graduate`; it needs no signature beyond the
transaction fee, and it never fails a trade on a curve pool: it graduates the pool when it
holds its target, and does nothing on a pool below it or already graduated (only a seeded
pool refuses it). The SDK and the trade API place it by one rule:

* a buy that brings the pool to 85 SOL carries `graduate` right after the swap, so the
  buyer who gets there graduates the coin; if a sell lands first and leaves the pool under
  the target, the `graduate` does nothing and the buy still goes through;
* any trade on a pool that already stands at or past its target carries `graduate` right
  BEFORE the swap and is priced on the graduated pool, so its quote is exact whoever
  graduates first;
* nothing lowers the minimum a trader asked for. An earlier draft did, so that a trade
  would not fail when someone else graduated first; it let a buyer who pushed the pool to
  the target take a large buy that followed at almost any price (an 89 SOL buy signed a
  minimum 98.7% under its quote). A trade that meets a moved price now fails on its
  slippage, like any other.

The watcher sends `graduate` as well, for a coin whose last buyer used another client.
Until it lands, trades keep following the curve with the virtual part in; nothing clips a
buy at the target.

**What the creator pays.** The launch fee and the rents of the accounts, the same as a
seeded launch without the seed. The creator may still make a first buy inside the launch
transaction, at the curve price, and the modules apply to it (a sniper fee, a creator lock).

**Your settings.** Three values in the platform account, set by `init_platform` to 30 SOL,
85 SOL and a graduation fee of 0, and changed with `update_platform`
(`scripts/init-platform.mjs` takes `CURVE_VIRTUAL_SOL`, `CURVE_TARGET_SOL` and
`CURVE_FEE_BPS`). They are copied into each pool when its curve opens, so a change applies
to future launches only. The fee is a share of the target, at most 10%, taken from the
pool's real SOL at graduation into the protocol fees you collect like the others; the
burn then grows so that holders keep their price. A virtual quote of 0 or a target of 0
switches curve launches off; seeded launches go on.

**Why it is safe.** The pool can pay out only what it really holds, and the virtual part is
never owed to anyone, because: the pool holds the whole supply of a closed mint when the
curve opens (the pool program checks the supply and that the mint authority is gone, so a
coin that never came out of the pool cannot be sold into it); nothing but trades moves the
reserves until graduation (liquidity refused, fees kept outside the reserves, no
instruction that reads vault balances into the reserves); no hook that owns the price
curve may run a curve pool; and a sell is checked against the real reserve all the same
(`CurveRealReserve`, a belt that the arithmetic makes unreachable). The LP of a curve pool
goes to the pool's lock account at creation, so nobody holds shares in the buyers' SOL.
`SECURITY.md` has the guarantee and the tests: among them a random walk of 300 buys and
sells from four wallets with the fees on, after which everybody sells everything back,
coins and SOL sent straight to the vaults, and graduation with and without a fee.
An independent review then attacked the design (section 11, round 7): it found no way to
take the virtual part and two things to tighten, both done: a second `graduate` is now a
no-op, and the pool itself refuses a pegged coin on the curve, not only the launchpad. The
rehearsals of the trade API and the site then found the two placement problems above (a
`graduate` that failed the buy it was attached to when a sell came first, and the lowered
minimum); both were fixed before this package: `graduate` is a no-op below the target too,
and the rule above replaced the lowered minimum.

**What it means for the modules and for hooks.** A hook reads the pool account it is
given; the price of any pool is `(reserve_quote + virtual_quote) / reserve_base`
(`HOOKS.md`, section 2). The buyback template and the burn of the modules measure prices
and depths that way, so a buy that moves the real SOL from 1 to 2 does not read as a
doubled price. Every module runs on a curve coin as on a seeded one. A strict coin may
launch on the curve; its max wallet runs for its own window, whether or not the coin has
graduated. A pegged collectible coin cannot launch on the curve (the launchpad and the pool both
refuse it): the burn at graduation would have to be reconciled with its pieces, and that
was not built. A plain collectible coin may; it was traded on the curve only once, by the
watcher's settle proof (section 14).

**What it means for other DEXes, bots and indexers.** One pool, one address, before and
after graduation. The byte `curve_state` in the pool account says which (0 a seeded pool,
1 on the curve, 2 graduated), `reserve_quote` is what was raised and `graduation_target`
the goal. `INTEGRATORS.md` has the layout, the quoting formula with the virtual part and
the `graduate` instruction; the Jupiter adapter quotes curve pools with it (section 13).
The compute cost of `graduate` is about 16,000 units on a validator (about 20,500 in the
in-process tests).

## 9. Launch rules (modules)

A launcher who wants more than one of the simple templates picks **Module Mode** on the
launch page. It is one hook, `hook_rules`, with six rules that can be combined, three
of them with a buy rate and a sell rate of their own; the site and this document call
them modules, `RULES.md` and the program call them rules. Each rule is off or on, with
numbers inside fixed bounds. Everything is final when the coin
launches: the program has no instruction that changes a rule, for the launcher or for
anyone.

| Rule | What it does |
|---|---|
| Sniper fee | In the first slots after launch a buy pays a high pool fee that falls in a straight line to the pool's normal fee. The fee goes to the launch liquidity, which is locked; nobody can add liquidity while the window runs. Sells never pay it. |
| Creator fee | A share of every trade is set aside for the launcher, in SOL. |
| Rewards for holders who stake | A share of every trade is paid in SOL to the wallets that put the coin in the rule's stake vault. While less than 0.1% of the supply is staked, this share goes to the burn instead. Staked coins can be taken out about an hour after the last stake. |
| Burn | A share of every trade collects in a pot. Anyone may run a buy of the coin with it; what the buy brings is burned. |
| Separate buy and sell rates | Not a module of its own: each of the three shares above has one rate for buys and one for sells. |
| Buy limit | In the first slots after launch no single buy may spend more than a set amount of SOL. Sells are never limited. |
| Creator lock | The launcher's first buy goes into a lock vault inside the launch transaction and stays there until the date. |

The launch form offers four presets. A preset only fills in the numbers; the launcher
can change every one of them inside the form's bounds.

| Preset | What it switches on |
|---|---|
| Creator fee only | Creator fee of 1% on buys and on sells. |
| Built to hold | Sniper fee from 30% over 2 minutes. Creator fee of 0.5% each way. Rewards for stakers of 1% each way. A buy limit of one twentieth of the SOL that seeds the pool, for 10 minutes. Creator lock of 90 days. |
| Rewards and burn | Creator fee, rewards and burn of 0.5% each, on buys and on sells. |
| Sells pay stakers | Creator fee of 0.5% each way. Rewards of 2% on sells and none on buys. Creator lock of 30 days. |

Under the form a review shows, before anything is signed, what a buy and a sell will
pay, row by row and in total, where each part goes, what the launcher's first buy will
receive, the date the lock ends, and what the launch costs. A launch on this template
costs about 0.036 SOL on mainnet in rent and fees on top of the liquidity, the first buy
and the launch fee (0.045 on a local validator, whose rent is higher), and about 0.0024 SOL
more with a creator lock. The site prices every account at the rent of the chain it is on.

What a reader of the site, or your support, has to know:

* **These are ordinary SPL coins** unless a strict module is on (below), so every wallet
  handles them and aggregators can route them. The price of that: the rules act on trades
  in the pool, not on transfers. There is no
  cap on what a wallet holds, no lock on coins somebody bought, and "holders" means
  wallets that stake. The buy limit is per trade, so a buyer can split a buy and pay the
  sniper fee on each part. `RULES.md` says what the template cannot do and why.
* **Two sets of bounds.** The program's ceilings can never be passed (`RULES.md`,
  "Bounds"). The launch form offers less, on purpose, and you choose how much.
* **A burn or a buyback is slow and careful on purpose.** A run buys only against a
  record of the pool that the instruction itself took at least 25 slots (about ten
  seconds) earlier, buys nothing while the price is above that record by more than a
  small tolerance, and spends at most a slice of the pool's SOL (0.01% to 0.5%, following
  the coin's fees). So nobody can make a run buy at a price they just pushed up. On a
  coin whose price is climbing the pot waits for a calm stretch. The same rule now
  governs the buyback template. `HOOKS.md` section 7 has the formulas.
* **Quotes are exact**, with one exception the trade API marks: a buy while the sniper
  fee runs, where the fee falls every slot, so a trade that lands later gives the same
  amount or more.
* **The creator lock is what is in the lock vault.** The program cannot force a launcher
  to lock. The launch form puts the lock in the launch transaction, and the coin page
  shows the vault itself, not the launcher's promise.

### The strict coin

Three rules cannot work on an ordinary coin, because nothing of ours runs when an ordinary
coin moves from wallet to wallet. A launcher who wants them switches on a strict module,
and the coin becomes a **strict coin**: a Token-2022 coin whose transfer hook is
`hook_rules`, so the program runs inside every transfer of it.

| Strict module | What it does |
|---|---|
| Max wallet | For a window after launch, no wallet may hold more than a share of the supply. It applies to buys and to sends, never to a sell. While it runs nobody can add liquidity, so it cannot be passed by depositing and withdrawing. The form offers 0.5% to 5% for up to 24 hours; the program allows 0.1% to 50% for up to 30 days. |
| Early lock | Coins bought from the pool in a window after launch cannot be sold or sent until the unlock. Coins a wallet got in other ways stay free. The form offers a window of up to 10 minutes and an unlock up to 24 hours after launch; the program allows up to one hour and seven days. |
| Rewards without staking | The holders' share of every trade goes to the wallets that hold the coin and registered once, in proportion to what they hold. Nothing is staked or locked. The site registers a wallet inside its first buy. While less than 0.1% of the supply is registered, the share goes to the burn. |

A strict coin can also have every module of an ordinary coin except staking: its rewards
module pays registered holders instead. Two others work differently on it: the creator
lock keeps the launcher's coins in the launcher's own wallet, with a floor nobody can go
below before the date (also not through a delegate), and the burn buys through the pool's
`hook_buy_burn`, which burns the coins inside the pool.

What the launcher is told on the form, in plain words, before the coin is made:

* Aggregators such as Jupiter will probably not route it. It trades on your site and
  through the trade API.
* Fewer wallets and exchanges handle such coins well.
* A wallet can receive it only in its standard (associated) token account, so a program
  that keeps coins in other accounts cannot hold it.
* The max wallet is per wallet: one person with several wallets passes it.
* Like every module, it is final at launch.

And a buyer is told on the coin page, before buying, what applies to this buy: that the
coins will be locked until a date, how much room is left under the max wallet, that the
buy also registers the wallet for rewards. After the windows, coins that are not locked
can always be sold and sent. `RULES.md`, "What can make a sell or a send fail", lists
every reason a transfer of a strict coin can fail. One more thing for support to know:
the chain checks the max wallet on the wallet's balance after the buy, so a buy sized
right up to the cap can still be refused when the price falls between the quote and the
landing. The SDK and the trade API leave room for the sniper fee, which falls every slot,
but not for price moves; a buyer who must land keeps a margin.

`RULES.md` is the reference: every rule, the bounds, the accounts and their layouts,
every instruction, the events, the errors, the known limits, and what a client does.
`scripts/e2e-rules.mjs` and `scripts/e2e-strict.mjs` run all of it on a local chain. The
template was reviewed in rounds 5 and 6 (section 11).

## 10. The collectible hook, a Solana take on Unipeg

On Ethereum, Unipeg (uPEG) gives every holder one NFT per whole coin: buying mints one,
selling burns one, and a transfer carries it. `hook_collectible` does the same on Solana,
with one deliberate difference in how the look of a piece is decided.

* **Earning.** A buy earns one piece per fixed amount of coins (the `unit`), up to a
  maximum per buy and a maximum that may exist at once. All three are fixed at launch.
* **Rarity nobody can predict.** A buy only records that pieces were earned. The hash of
  a block two slots later decides their look. Nobody knows it when the buy is signed,
  simulating the buy shows nothing, and a later buy cannot re-roll an earlier one.
  (On Unipeg the previous swap sets the seed, so a buyer can see a piece before buying.)
  A piece is drawn with the art that was in force when it was bought.
* **The peg.** A wallet keeps at most one piece per `unit` of coins it holds. Pieces
  leave from the end of the holder's own ordered list, and the holder can reorder it.
* **Two kinds of coin, chosen at launch.**
  * A **plain coin** is an ordinary SPL coin. Selling or sending coins leaves pieces
    without backing, and anyone may then burn them (`settle`). The SDK does it inside
    its own sells; the watcher does it for everything else within seconds. A piece moves
    to another wallet only through `send_pieces`, together with its coins.
  * A **pegged coin** is a Token-2022 coin whose transfer hook is this program. The
    program runs inside every transfer of the coin: the piece moves with the coins (one
    piece per whole unit sent), or burns, in that same transfer, as on Unipeg. A sell
    burns inside the swap. The costs: the program runs in every transfer, sells
    included; fewer wallets and exchanges handle such coins; aggregators will probably
    not route them; a plain send to a wallet that never held the coin burns the piece.
* **The NFTs** are Metaplex Core assets, frozen by the program so that a piece can never
  be sold apart from its coins.
* **The launcher** can change the collection's name, renderer and art for FUTURE pieces
  until they lock the collection. No instruction changes an existing piece, or one that
  is already earned.

`HOOKS.md` has every rule. It is the most complex program here and the one to read most
carefully before real money. It was reviewed three times (rounds 2, 3 and 4 in
`SECURITY.md`), each time with exploits attempted in tests against the real Token-2022
and Metaplex Core programs. The last round found no way to duplicate a piece, keep one
without coins past a settle, exceed the supply, or make another wallet's trade fail. What
it did find is fixed; what was left as a known property is listed in `SECURITY.md` under
"What the pool does not guarantee" and in section 14. Round 5 then found that a hostile
hook on another pool could forge this hook's callbacks, pieces and their deciding block
included (finding 28). That is closed for every hook.

## 11. Security: what holds, who can do what, what was reviewed

What the pool guarantees, whoever wrote the hook (`SECURITY.md` has all of them with the
tests behind each):

* Only the pool moves the vaults. A vault always holds its reserve, the protocol fees
  owed and the hook fees owed. Rounding always favours the pool.
* A hook gets no signature of the trader and cannot move funds. A fee above the cap is
  clamped. A power the pool's flags do not grant fails the swap.
* A hook that is not flagged for sells is never called on a sell. It cannot tax or block
  one.
* A hook is frozen, or it is one of yours.
* A hook is called by the pool, for one of its own pools, or it refuses. The pool signs
  callbacks with a different address for every hook program, so a hostile hook cannot
  pass the pool's signature on to another hook.
* A hook fee is never lost and never stops a trade: if the treasury account is missing,
  the fee waits in the pool and is paid when the account is back.
* Liquidity can always be removed, also while the platform is paused.
* The coin of a pool cannot be frozen: the pool refuses a coin with a freeze authority,
  and a Token-2022 coin with any extension it does not know.
* A launched coin has a fixed supply, no mint authority, no freeze authority, a final
  name, and launch liquidity nobody can pull.
* A pool on the curve pays out its real SOL only. It prices with 30 virtual SOL, but a
  sell can never take more than the pool really holds, liquidity cannot be touched until
  it graduates, and graduation keeps the price (section 8).
* A buyback or a burn never buys at a price its caller just made, and never more than a
  slice of the pool at a time.
* The rules of a rules coin never change, and staked or locked coins can be taken out
  only by their owner, after the delay or the date.

What the operator (you) can do, and traders must trust you with:

* Upgrade any of the seven programs, the templates under existing coins included, and on
  a strict coin the code that runs inside every transfer. This covers everything above:
  "the pool has no instruction that moves the locked liquidity" is true of the code
  deployed, and an upgrade is new code.
* Pause swaps and new pools (never removals), change the protocol fee up to 1%, lower or
  raise the caps for hooks inside hard bounds, change the treasury, the launch fee and
  the whitelist.

What a launched coin's dev can do: on a tax coin, move the tax between zero and the
ceiling fixed at launch, hand it over, or renounce; on a collectible coin, change future
art until they lock; on a rules coin, claim the creator fee, and move its own lock to a
later date. Nothing else.

Pools created directly with `create_pool`, not through the launchpad, are ordinary AMM
pools: their creator keeps the LP tokens and can withdraw the liquidity, and the coin
may still have a mint authority. The launch record (`["launch", coin mint]`) tells the
two apart.

Reviews. All were done by AI review agents working read-only against the code, each
proving its findings with tests, not by an outside firm:

| Round | Date | Scope | Result |
|---|---|---|---|
| 1 | 2026-10-02 | pool, launchpad, three fee templates | 2 high, 2 medium, 1 low. All fixed. |
| 2 | 2026-10-04 | the collectible peg | 2 high, 2 medium, 1 low. All fixed. |
| 3 | 2026-10-04 | the pegged coin | no critical or high; 3 medium, 4 low. All fixed. |
| 4 | 2026-10-12 | everything, before the first handoff: two security reviews, an integrator and a hook author working from the documents alone, a browser test of the site | no critical or high; 2 medium, 8 low. All fixed. |
| 5 | 2026-10-13 | the launch rules template and what it shares with the other programs: its author's own review, then two rounds by a second agent | 1 high, 3 medium, 5 low, 1 note. All fixed. The high one and one medium were also in the code of 2026-10-12. |
| 7 | 2026-10-16 | the curve launch: its author's review while building (a proof that a sell can never reach the virtual part, random walks), then an independent agent's adversarial review against the final programs | no way found to take the virtual part, move the price at graduation, graduate early or twice, or starve a pool (fuzzed: 18,295 buys, 11,462 sells and 3,438 buy-burns on the pool's math at every fee cap; 300,000 random graduations). 1 medium in the design of the clients, not in the funds: a `graduate` attached to a trade failed the whole trade once anyone else had graduated; fixed by making a second `graduate` a no-op, and the SDK now prices such a trade on both states. 1 low: the rule that a pegged coin cannot open on the curve was enforced by the launchpad only; now by the pool too. 1 pre-existing: a dust trade on a pool without a hook failed with the hook's error; fixed. 5 notes, all in the documents. 11 adversarial tests kept in `tests/tests/review_curve.rs`. |
| 6 | 2026-10-15 | the strict coin and the pool's new `hook_buy_burn`: its author's review while building, then a second agent's read-only review against the running binaries | no exploitable bug. While building, the author found and closed one medium (the max wallet passed through liquidity). Two regression tests added at the reviewer's request. |

Every finding, with its fix and its regression test, is in the log at the end of
`SECURITY.md`, together with what was noted and deliberately not changed.

No outside audit. Get one before real volume. Jupiter and the chart sites ask for it
anyway (`LISTINGS.md`).

## 12. Letting other developers write hooks: Custom hooks

Anyone can write a hook. On the reference deployment it can open pools only once you, the
operator, have reviewed it and put its program on the approved list that the pool program
keeps (HOOKS.md section 6.1). What an author needs is in the repository:

* `hook-template/README.md` is the guide, and the folder is a complete hook: a fixed fee
  to a treasury. One script builds it, one tests it against the real pool program in
  process (no validator, no deploy), one deploys it frozen and publishes its manifest,
  one renames it.
* `examples/hooks/` holds two more hooks built with the same kit, each with tests and a
  script that proves its effect on chain. `early-bird` lowers the pool fee for early
  buyers (a fee override, state written from a callback). `loyalty-points` keeps a points
  account per trader (code that runs after the swap, an account the trader opens).
* `crates/hookpool-interface` is the one crate a hook builds against: the flags, the
  payloads, the answer type, the caller check, the helpers for extra accounts.
* `HOOKS.md` is the contract: what the pool passes, what a hook may answer, the caps.
  Section 4.1 lists the rules for hook authors.

How it goes for an author (`hook-template/README.md`, "Release on mainnet", has the
commands): write the hook and test it locally; publish the code at one commit; send a review
request on the site's review page, paying the review fee; once the code passes, deploy that
commit as a verifiable build, upload its build record while still holding the upgrade
authority, have the verification service rebuild it, freeze it (`scripts/freeze.sh` checks
the verification first), and give the program id on the request page. You then check it with
`node scripts/check-hook-release.mjs mainnet <program id> <repository> <commit>` and approve
it with `node scripts/hook-approval.mjs mainnet approve <program id>`. From then on
`launchInstructions({ template: "custom", custom: { program } })` in the SDK launches a coin
on it, and the hook checker of the reference site tells anyone whether a pool would accept a
given program.

**The approved list, on chain.** While the platform's rule is on
(`node scripts/hook-approval.mjs mainnet rule on`), the pool program refuses to open a pool
on an outside hook that is not on the list (`HookNotApproved`), on every path: directly,
through the launchpad, or from any other client. Only a frozen program can be approved, so the
approved code can never change. Taking a hook off the list (`revoke`) stops new pools only:
a pool's hook is fixed at its creation, so its coins keep it and keep trading, and the site
warns on their pages. Your own five templates need no approval. Their reports on the site say
plainly that your key can still upgrade them.

**The review requests.** The site's review page (`web/review-hook.html`) takes a request and
the review fee in one step: the developer's wallet pays 25 USD in SOL (the price is read from
CoinGecko, then Jupiter) to the platform treasury, with a memo that names the request, and the
server (`web/api/_reviews.js`) checks the payment on chain before it stores the request. The
requests live in one JSON file on the server (`REVIEWS_FILE`); `scripts/hook-reviews.mjs`
lists them and moves them through their statuses (waiting, in-review, changes-needed, passed,
checking, approved, rejected). Each request has a public status page; the developer's contact
stays on the server. Set `REVIEW_TELEGRAM_BOT_TOKEN` and `REVIEW_TELEGRAM_CHAT_ID` to get a
message for each new request. API.md has the endpoints. The review rules (ten of them) are on
the review page; reports for the five templates are under `web/reviews/`, written the same way
a report for an outside hook is.

What the pool does about a stranger's hook: it takes it only when its code is frozen; it
copies the hook's flags into the pool at creation and refuses any answer outside them; it
clamps fees to the platform caps; it never calls a hook on a sell unless the hook declared
that; it never gives a hook the trader's signature or a way to move funds; and it signs
each hook's callbacks with an address of that hook alone, so one hook cannot reach
another.

**Custom hooks** is how those hooks reach launchers. It is three pages of the reference
site; what it lists follows the approved list on chain. On the site they are called Custom hooks; their files,
`web/workshop*`, and the older documents call them the workshop. Both names mean these
pages:

* **The list** (`web/workshop.html`) shows, while the rule is on, the approved hooks (also
  those with no coin yet), each with the mark "Reviewed by Programmable" and its report.
  Outside hooks that have coins but are not on the list sit in a closed "Not reviewed"
  section with a warning and no launch button. With the rule off it lists every frozen
  outside hook that has a pool, and marks the approved ones.
* **A page per hook** (`web/workshop-hook.html`) shows the author's own rules next to what
  the chain allows the hook to do, five checks that the visitor's browser runs against
  the chain, the coins that use the hook and what it collected, and a button that opens
  the Custom hook launch page with this hook chosen.
* **The guide** (`web/workshop-guide.html`) walks an author from the kit to a listed hook
  in four numbered steps.
* **A hook describes itself.** Its author hosts a small JSON file, the descriptor, and
  the hook's manifest links to it: a name, a summary, the rules in plain words, a link to
  the source, and the hook's setup instruction with its settings. The launch form builds
  the hook's settings from it, so a launcher sets "their rules" without anyone writing a
  form for that hook. The format is in `hook-template/README.md`, and each kit hook ships
  one (`hook.json`).
* **The pin.** A manifest's link may end with `#s=` and 22 characters, the first 16 bytes
  of the SHA-256 of the descriptor. The site then refuses any other file at that address,
  and the hook's page says the description is pinned. `deploy-freeze.sh` adds the pin when
  it can read the hosted file. A pin proves that the file is the one the author pinned.
  It is not a signature and says nothing about the code.
* **What protects a launcher from a hostile setup.** A hook's setup instruction runs with
  the launcher's signature. The form accepts only a narrow set of accounts in it,
  simulates the transaction with and without the setup, refuses a setup that takes more
  than the rent plus 0.001 SOL, or more than 0.05 SOL in all, or touches an account that
  is not the hook's, and ends
  the transaction with a floor on the wallet's balance.
* **The reports.** `web/workshop/reviewed.json` is the registry of review reports
  (program, repository, commit, build hash, date, report page). The chain decides the mark;
  the registry only gives its report link. It ships empty. A review is not an audit, and the
  pages say so.

What was verified: the template and both examples were built with the kit, passed their
in-process tests (5, 4 and 5), were deployed frozen on a local validator by a wallet that
is not the platform's, and each had coins launched on it and traded, with every fee and
effect read back from the chain (20, 21 and 28 checks). The kit was also used from a
folder outside the repository. The Custom hooks pages were driven in a browser against eight
fixture hooks (with and without a descriptor, pinned, pinned with a file changed
afterwards, one that copies another hook's descriptor, one whose setup takes 0.25 SOL):
163 checks, launches through the form included.

What you still have to provide before outside developers can really use it:

* **A public devnet deployment.** The pool refuses hooks that are not frozen, and a frozen
  hook cannot be fixed, so an author tests in process and on a local validator, then goes
  to mainnet through the review. A devnet deployment would give authors a public chain to
  rehearse on; the deploy script refuses devnet today because the pool program is not there.
* **The interface crate on crates.io and the SDK on npm.** Neither is published. Both are
  ready: the crate names its own dependency versions, the SDK builds its type
  declarations. Until then an author copies the crate out of the repository. The copy
  must be this edition's: a hook built with the crate of 2026-10-12 deploys and freezes,
  and no pool can ever be created on it.
* **People to review.** Every request is read by a person against the ten rules. A hook
  that is called on sells may refuse them, and a frozen hook's own accounts (its settings,
  even its list of extra accounts) can still change where its code allows it. The watcher
  simulates a buy and a sell on every hooked pool, sells as recent buyers too, alerts when a
  hook rewrites its manifest or its accounts list, and logs every change of the approved
  list. None of that replaces reading the code.

## 13. Letting other DEXes, bots and aggregators trade the pools

* `API.md`: two HTTP calls. The fastest way in for a bot. A quote on a rules coin also
  says the coin's rates and windows, and a buy above a running buy limit is refused
  with an error of its own, so a bot can split the buy. On a strict coin, given the
  wallet, it says what this buy means for that wallet (locked until when, room under the
  cap, registered or not), refuses with a code of its own what the chain would refuse,
  and opens the wallet's holder record in front of its first buy.
* `INTEGRATORS.md`: the on-chain integration without any of this code. Addresses, account
  layouts by offset, the quote formula, the swap instruction byte by byte, hook
  accounts, events for indexers, the launch rules for quoting, the buyback and burn
  rule for anyone who wants to run a keeper, and pools on the curve. `scripts/raw-swap-example.mjs` is that document as one
  runnable file, and `scripts/check-integrators-doc.mjs` checks the document against a
  chain.
* `idl/`: the Anchor IDL of every program.
* `jupiter-adapter/`: the adapter and the parity proof Jupiter asks for.
* `LISTINGS.md`: what Jupiter, DexScreener, GeckoTerminal and the trading terminals ask
  of a new DEX, and what is left to do for each. The short version: the code side is
  ready; they also want an audit, open-sourced programs and real volume.

What was verified. For the first edition, a reviewer who had never seen the code built
quoting, swapping and indexing for every kind of pool from `INTEGRATORS.md` and `API.md`
alone; every raw swap paid exactly the quoted amount, and what the documents were missing
was added. Since then `INTEGRATORS.md` has grown with the rules template, the buyback and
burn rule, the hook caller of each hook, the strict coin (how to detect it, its extra
accounts for every instruction that moves it, its holder records, its windows, what makes
a sell or a send fail), the pool's `hook_buy_burn`, and pools on the curve (section 14:
the effective quote, the real-reserve rule, `graduate`, the two events, how an indexer
shows the progress and the graduation). `check-integrators-doc.mjs` compared every table
of the document with the IDLs and with the accounts on a chain holding 216 pools, 37 of
them on the curve and 40 graduated, and simulated trades, sends, burns, stakes, claims,
locks and graduations on each kind, where `graduate` goes in a trade included: 3,009
checks. The check was itself checked: four deliberate
errors put into the new tables were each reported alone, and nothing else was. The no-SDK
example trades right on nineteen kinds of pool, strict coins and seven kinds of curve pool
included (it opens the holder record in front of an early buy, prices a curve pool with
its virtual part, puts `graduate` before a trade on a pool past its target and after a
buy that crosses it, and refuses before sending what the chain would refuse), graduates a
pool past its target, and sends a strict coin, a pegged coin and two ordinary coins from
wallet to wallet. The adapter passes its 31 unit tests and its 22 parity tests on
Jupiter's own test kit, against the programs built from this source, and deliberate errors
put into the adapter (the virtual part dropped, a sell quoted past the real reserve, curve
pools left out) were caught by those tests.

What aggregators can route: pools without a hook, and pools on the tax, launch guard,
buyback and rules templates and on the collectible template with a plain coin, in both
directions, on the curve or not. A pool on the curve is offered from its first slot for
buys, and for sells once it holds real SOL. The adapter never sends `graduate`: a quote
on a pool past its target stays exact until the instruction lands, and the watcher sends it. A rules coin is quoted from its config alone, outside its windows to the
unit. Inside a sniper window the quote is exact for the slot it is computed for. A buy
above a running buy limit is answered with an error, not with a wrong amount.

What aggregators will not route, by design: coins with their own transfer hook (the
pegged coin and the strict coin), and pools on a third-party hook in the directions where
the hook can change the amounts, because no quote computed off chain can know its answer.
They trade on your site and through the trade API, which builds the extra accounts and
simulates each such trade. `LISTINGS.md` explains it.

What is left for you: the applications themselves. Jupiter reviews the adapter and adds
the program on its side; the chart sites ask for a small data feed in their format, which
is not built (`LISTINGS.md`, point 7). All of them ask for an audit, open-sourced programs
and real volume first. The venue requirements in `LISTINGS.md` were researched on
2026-10-04; read their pages again before you apply.

## 14. Known limits and open items

Decisions that are yours:

* **Program ids.** Deploy at the ids in the repository (you then need the seven program
  keypair files from the previous owner, sent privately) or run `scripts/rekey.mjs` and
  deploy at your own. Re-keying was rehearsed end to end (section 2).
* **Upgradeable or frozen.** The seven programs are upgradeable by your key. That is what
  lets you fix a bug, and it is also the one thing every guarantee in section 11 depends
  on. A multisig first; freezing a program is possible later and cannot be undone.
* **Which pools and hooks your site shows** (sections 5 and 12).
* **The name.** Every string is Programmable, on chain (the name each template program writes into its manifest, the
  default manifest address in `scripts/init-platform.mjs`) and off chain (the piece
  metadata, the documents, the `PROGRAMMABLE_*` environment variables, the descriptor key
  `programmable_hook`, the watcher's user and unit, the browser's storage key). A
  manifest's name cannot be changed after the first deploy. The site's mark is yours to
  set (`web/config.js`).
* **What the launch form offers.** The numbers a launcher may choose for the launch rules
  are limited twice: by the program, forever, and by the form, as you set it (section 9).
* **The curve's numbers.** 30 virtual SOL, graduation at 85 real SOL and no graduation fee
  are pump.fun's figures, chosen so that a coin here starts and graduates where traders
  expect. Set yours before the first launch; they apply to future launches only
  (section 8).

Limits of the design, known and accepted:

* **No outside audit.** The largest open item. Section 11.
* **A coin on the curve graduates when somebody sends `graduate`.** The SDK and the trade
  API put it after the buy that reaches 85 SOL and before any trade on a pool past it, and
  the watcher sends it too, so it is a matter of seconds; but a coin whose buyers all use a
  client that does none of this (an aggregator through the Jupiter adapter, which never
  sends it) stays on the curve, trading normally, until anyone sends the instruction. Until
  then trades follow the curve, with the virtual part in; nothing clips a buy at the
  target, and a large buy past it is priced on the curve, not on the pool that graduation
  makes.
* **The buy just before graduation can fail on its slippage.** A buy quoted on the curve
  that lands after someone else pushed the pool to the target and graduated it meets a
  moved price and a shallower pool, and fails on the trader's slippage instead of filling
  low. That is on purpose (section 8); the trader tries again and the next quote is exact.
* **Graduation tells the hook nothing.** The pool burns and rewrites its own fields; the
  coin's hook gets no callback. A module that should change at graduation (the competitor
  lifts its max wallet then) would read `curve_state` on its next call. Ours use windows.
* **A pegged collectible coin cannot launch on the curve**, and a plain collectible coin on
  the curve is allowed by the programs but was not exercised (section 8).
* **Graduation burns from the supply.** About 6.8% of the coins at the default numbers. A
  chart that reads the mint's supply sees it fall once; the price does not move.
* **On an ordinary rules coin, the rules act on trades, not on transfers.** It has no cap
  per wallet and no lock on coins somebody bought, the buy limit is per trade, and
  rewards go to wallets that stake. The strict coin has all three, at the costs section 9
  lists. A wallet can stake just before a large trade and take the holders' share of it;
  its coins then stay staked for about an hour.
* **A buyback or a burn can be slowed, and a patient attacker with a lot of capital can
  still take part of a large pot.** A run buys only in a calm stretch, so on a coin that
  keeps climbing the pot waits, and anyone can make one run wait by trading right before
  it, at the price of the fees. A wallet that pumps the price and leaves the pump in the
  pool, in the open, for 25 slots can have the next run buy at that price, if nobody
  sells into it first. What can be taken is never more than the pot, so a burn that is
  run regularly leaves little to take. `RULES.md`, "Known limits", has the measured
  figures.
* **On a strict coin, a wallet that buys just before a lot of trading earns a share of
  the holders' rate and can sell afterwards.** Measured: it pays when the volume that
  follows is above about four times the value of the coins already registered, so mostly
  in a coin's first minutes, when the sniper fee and the early lock make it expensive.
  There is no waiting time before new coins earn: that would make rewards need an action.
  `SECURITY.md` has the numbers.
* **A strict coin's holder record can stand above the real balance** after a token Burn
  (not a transfer), until anyone sends `sync_holder`; until then the burner keeps a share
  of the rewards. The watcher can do it.
* **A sniper fee or a launch guard fee goes to the pool's liquidity.** Through the
  launchpad that liquidity is locked. On a pool made without the launchpad it belongs to
  whoever created the pool.
* **A pegged coin** runs its hook inside every transfer, is handled by fewer wallets and
  exchanges, is not routed by aggregators, cannot be sent by a standard wallet to an
  address that never held it without first creating the account, and burns its piece
  when sent to a wallet without a ticket. `HOOKS.md` lists all of it. Launchers choose it
  knowingly; the plain collectible coin has none of these limits.
* **A collectible roll can be looked at for the price of a round trip**, and the
  validator that produces the deciding block can bias its own buys. `SECURITY.md`, "What
  the pool does not guarantee".
* **Rent that never comes back**: a collectible ticket (about 0.0024 SOL on mainnet, 346
  bytes at the chain's rent; 0.0033 on a local validator), and on a rules
  coin a stake record, the lock record and the two vaults. No instruction closes them. A
  strict coin's holder record is the exception: `close_holder` returns its rent once the
  record holds nothing.
* **A frozen third-party hook can still change its own settings** where its code allows
  it, including the list of accounts it asks for. It gains no power its flags do not
  show, but it can make the trades it is called on fail.
* **Custom hooks lists hooks; it does not vouch for them.** A hook appears there because
  it is frozen and has a coin, not because anyone read it. What its page says about its
  rules is the author's own text. The checks on the page say that the code is frozen,
  that the pool can read the hook, that its description loads, and that a simulated buy
  and sell went through a moment ago. They say nothing about what the code does.
* **A hook can be accepted by every check and still refuse its first pool.** The pool
  checks a hook before it calls it; whether the hook's own `on_pool_create` then agrees
  shows only at the first launch. A launch is two transactions, and the first has
  created the coin and paid for it by then. A hook built with the interface crate of
  2026-10-12 fails exactly there. The hook's page in Custom hooks says so while the hook
  has no pool.
* **The quote token is not checked for a freeze authority.** Pools against SOL depend on
  nobody. A pool against a token whose issuer can freeze accounts depends on that issuer.
* **Token-2022 coins with other extensions cannot be listed.** The pool accepts only a
  coin's own name and, for the pegged coin, its transfer hook.
* **Pools made without the launchpad** are ordinary AMM pools: their creator can withdraw
  the liquidity and the coin may still be mintable.
* **The same two tokens in the other order form a second pool.** A site should treat the
  coin's pool against SOL as its market.
* **The trade API's rate limit is per IP address and kept in memory**: fine for one
  server, not shared between instances.
* **The SDK sets no priority fee.** On a busy network add one yourself; the trade API
  takes `computeUnitPriceMicroLamports`.

Not built:

* The chart data feed for DexScreener and GeckoTerminal (`LISTINGS.md`, point 7).
* Publication of the interface crate (crates.io) and of the SDK (npm).
* A devnet deployment.
* A path for building the programs as SBPF v3 (section 6, point 5).
* For ordinary rules coins: a way to close stake records. (A strict coin's holder records
  can be closed, and their rent comes back.)

Operational facts to remember:

* The renderer address and the metadata storage of collectible coins are forever
  (section 5). The watcher must run for collectibles, and for the buybacks and burns
  (section 7). A coin with its own art also needs `/art/u/` on the same address for good;
  its files live on Arweave (or Irys), and the site can hide a folder without touching the
  chain (`scripts/art-hide.mjs`).
* Add your multisig to the whitelist BEFORE moving a template's upgrade authority to it
  (section 6, point 7).
* A local test validator forgets old transactions within minutes. Scripts that read
  history back do it right after they trade; on a real cluster this limit is the RPC
  provider's.
* The pool, the hooks and the clients of this package belong together. Do not mix them
  with programs or an SDK from the package of 2026-10-12: the address the pool signs
  callbacks with changed.

## 15. Where things are

`README.md` has the map of the repository, every script, and the toolchain traps that
the scripts already handle.
