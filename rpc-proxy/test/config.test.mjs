// Settings: the defaults, the WebSocket address web3.js would derive, the secrets to redact, and
// what a description may say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, deriveWsUrl, describeConfig, DEFAULTS, hostOf } from "../lib/config.mjs";
import { createLogger } from "../lib/log.mjs";
import { Bucket, AddressTable, clientAddress, addressKey } from "../lib/limits.mjs";

test("UPSTREAM_RPC is required and must be http(s); the error never repeats the value", () => {
  assert.throws(() => loadConfig({}), /UPSTREAM_RPC is not set/);
  assert.throws(() => loadConfig({ UPSTREAM_RPC: "nope" }), /not a URL/);
  try { loadConfig({ UPSTREAM_RPC: "ftp://host/SECRETX" }); assert.fail("accepted ftp"); } catch (e) { assert.equal(e.message.includes("SECRETX"), false); }
  assert.throws(() => loadConfig({ UPSTREAM_RPC: "https://h/k", UPSTREAM_WS: "https://h/k" }), /UPSTREAM_WS must start with ws/);
});

test("the WebSocket address follows web3.js: wss and the same path for https without a port, the port plus one with one", () => {
  assert.equal(deriveWsUrl("https://solana-mainnet.example.com/abc123"), "wss://solana-mainnet.example.com/abc123");
  assert.equal(deriveWsUrl("http://127.0.0.1:8899"), "ws://127.0.0.1:8900/");
  assert.equal(deriveWsUrl("https://host.example/path?x=1"), "wss://host.example/path?x=1");
  const cfg = loadConfig({ UPSTREAM_RPC: "https://provider.example/KEYKEYKEY" });
  assert.equal(cfg.upstreamWs, "wss://provider.example/KEYKEYKEY");
  const own = loadConfig({ UPSTREAM_RPC: "https://provider.example/KEYKEYKEY", UPSTREAM_WS: "wss://ws.provider.example/OTHERKEY" });
  assert.equal(own.upstreamWs, "wss://ws.provider.example/OTHERKEY");
  assert.ok(own.secrets.includes("/OTHERKEY"));
});

test("defaults, ranges and lists", () => {
  const cfg = loadConfig({ UPSTREAM_RPC: "https://p.example/k" });
  assert.equal(cfg.port, DEFAULTS.port);
  assert.equal(cfg.ratePerMinute, 60); assert.equal(cfg.rateBurst, 120); assert.equal(cfg.sendPerMinute, 10); assert.equal(cfg.globalPerMinute, 1500);
  assert.equal(cfg.bodyLimitBytes, 65536); assert.equal(cfg.batchLimit, 50); assert.equal(cfg.upstreamTimeoutMs, 20000);
  assert.equal(cfg.wsConnectionsPerIp, 4); assert.equal(cfg.wsSubscriptionsPerConnection, 20);
  assert.equal(cfg.wsConnectionsMax, 200); assert.equal(cfg.wsIdleSeconds, 60); assert.equal(cfg.wsFramesPerMinute, 120);
  assert.equal(cfg.ratePerDay, 20000); assert.equal(cfg.globalPerDay, 600000);
  assert.equal(cfg.maxAnswerBytes, 8 * 1048576); assert.equal(cfg.bytesPerMinute, 50 * 1048576); assert.equal(cfg.globalBytesPerMinute, 200 * 1048576); assert.equal(cfg.globalBytesBurst, 32 * 1048576);
  assert.deepEqual([...cfg.allowedOrigins], ["https://programmableonsol.com", "https://www.programmableonsol.com"]);
  assert.deepEqual([...cfg.wsMethods], ["signatureSubscribe", "signatureUnsubscribe", "ping"]);
  const odd = loadConfig({ UPSTREAM_RPC: "https://p.example/k", RATE_PER_MINUTE: "100", RATE_BURST: "10", BODY_LIMIT_BYTES: "1", METHODS: "getSlot,getSlot, getHealth", WS_METHODS: "signatureSubscribe", MAX_ANSWER_BYTES: "4194304", BYTES_PER_MINUTE: "2048", ALLOWED_ORIGINS: "https://A.example/, http://127.0.0.1:8799" });
  assert.equal(odd.rateBurst, 100, "the burst is never under the rate");
  assert.equal(odd.bodyLimitBytes, 1024, "the body cap has a floor");
  assert.equal(odd.bytesPerMinute, 4194304, "the byte budget always holds one answer at the cap");
  assert.deepEqual([...odd.allowedOrigins], ["https://a.example", "http://127.0.0.1:8799"], "origins in lower case, without a slash");
  assert.deepEqual([...odd.methods], ["getSlot", "getHealth"]);
  assert.deepEqual([...odd.wsMethods], ["signatureSubscribe"]);
  assert.deepEqual([...loadConfig({ UPSTREAM_RPC: "https://p.example/k", ALLOWED_ORIGINS: "*" }).allowedOrigins], ["*"]);
  assert.throws(() => loadConfig({ UPSTREAM_RPC: "https://p.example/k", ALLOWED_ORIGINS: "https://a.example/path" }), /ALLOWED_ORIGINS/);
  assert.throws(() => loadConfig({ UPSTREAM_RPC: "https://p.example/k", ALLOWED_ORIGINS: "programmableonsol.com" }), /ALLOWED_ORIGINS/);
});

test("the secrets cover the address, its path, its query and the key alone; the description and the host say none of it", () => {
  const cfg = loadConfig({ UPSTREAM_RPC: "https://p.example/v1/THEKEY00001?token=THEKEY00002" });
  for (const s of ["https://p.example/v1/THEKEY00001?token=THEKEY00002", "/v1/THEKEY00001?token=THEKEY00002", "/v1/THEKEY00001", "THEKEY00001", "THEKEY00002", "?token=THEKEY00002"]) assert.ok(cfg.secrets.includes(s), s);
  const said = describeConfig(cfg);
  assert.equal(said.includes("THEKEY"), false);
  assert.ok(said.includes("p.example"));
  assert.equal(hostOf("https://p.example/v1/THEKEY00001"), "p.example");
  assert.equal(hostOf("not a url"), "the upstream");
  const lines = [];
  const log = createLogger(cfg.secrets, (_l, text) => lines.push(text));
  log.info("failed: " + cfg.upstreamRpc + " and THEKEY00001 alone and " + cfg.upstreamWs);
  assert.equal(lines[0].includes("THEKEY"), false);
  assert.ok(lines[0].includes("<upstream>"));
  log.error(new Error("connect ECONNREFUSED p.example:443 " + cfg.upstreamRpc));
  assert.equal(lines[1].includes("THEKEY"), false);
});

test("a bucket holds its capacity, refills smoothly and says how long to wait", () => {
  const b = new Bucket(5, 60, 0);
  assert.equal(b.take(5, 0), true);
  assert.equal(b.take(1, 0), false);
  assert.equal(b.waitSeconds(1, 0), 1);
  assert.equal(b.can(1, 1000), true, "one token a second at 60 a minute");
  assert.equal(b.take(1, 1000), true);
  assert.equal(b.can(5, 3000), false);
  assert.equal(b.can(5, 6000), true);
  assert.equal(b.waitSeconds(3, 6000), 0);
});

test("the address table: at its cap a new address takes the place of the least recently used one without a connection; idle addresses are forgotten", () => {
  const tbl = new AddressTable({ ratePerMinute: 60, rateBurst: 120, sendPerMinute: 10, idleMs: 1000, maxEntries: 3 });
  tbl.get("a", 0); tbl.get("b", 0).ws = 1; tbl.get("c", 0);
  assert.equal(tbl.size, 3);
  tbl.get("a", 5); // a is used again: c is now the least recently used without a connection
  tbl.get("d", 10);
  assert.equal(tbl.size, 3, "the table stays at its cap");
  assert.deepEqual([...tbl.map.keys()], ["b", "a", "d"], "c went, not b with its socket, not a used a moment ago");
  tbl.get("e", 20);
  assert.deepEqual([...tbl.map.keys()], ["b", "d", "e"]);
  tbl.prune(5000);
  assert.equal(tbl.size, 1);
  assert.ok(tbl.map.has("b"), "an address with a connection is never forgotten");
  // an address that spent much of its day is remembered past the idle time, until its day bucket is full again
  const day = new AddressTable({ ratePerMinute: 60, rateBurst: 120, sendPerMinute: 10, ratePerDay: 1440, idleMs: 1000 });
  day.get("x", 0).daily.take(100, 0);
  day.prune(5000);
  assert.equal(day.size, 1, "100 of 1440 spent: one a minute comes back, so it is remembered");
  day.prune(101 * 60_000);
  assert.equal(day.size, 0, "forgotten once the day bucket is full again");
});

test("addresses are charged by key: IPv4 as it is, IPv4-mapped IPv6 as IPv4, IPv6 by its /64", () => {
  assert.equal(addressKey("203.0.113.9"), "203.0.113.9");
  assert.equal(addressKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(addressKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(addressKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(addressKey("2001:DB8:0001:0002::ffff"), "2001:db8:1:2::/64");
  assert.equal(addressKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(addressKey("[2001:db8:1:2::5]"), "2001:db8:1:2::/64");
  assert.equal(addressKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(addressKey("::1"), "0:0:0:0::/64");
  assert.equal(addressKey("64:ff9b::192.0.2.1"), "64:ff9b:0:0::/64");
  assert.equal(addressKey("unknown"), "unknown");
  const tbl = new AddressTable({ ratePerMinute: 60, rateBurst: 120, sendPerMinute: 10 });
  assert.equal(tbl.get("2001:db8:1:2::1"), tbl.get("2001:db8:1:2::2"), "one /64, one entry");
  assert.notEqual(tbl.get("2001:db8:1:2::1"), tbl.get("2001:db8:1:3::1"));
});

test("the client address: the last X-Forwarded-For entry behind loopback, the socket address anywhere else", () => {
  const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  assert.equal(clientAddress(req("127.0.0.1", "1.1.1.1, 2.2.2.2")), "2.2.2.2");
  assert.equal(clientAddress(req("::1", "9.9.9.9")), "9.9.9.9");
  assert.equal(clientAddress(req("::ffff:127.0.0.1", "9.9.9.9")), "9.9.9.9");
  assert.equal(clientAddress(req("127.0.0.1")), "127.0.0.1");
  assert.equal(clientAddress(req("203.0.113.4", "1.1.1.1")), "203.0.113.4", "a direct client cannot name its address");
  assert.equal(clientAddress(req(undefined)), "unknown");
});
