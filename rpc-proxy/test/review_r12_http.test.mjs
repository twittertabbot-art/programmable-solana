// Round 12 review (V1): the HTTP side and the limiter against hostile input. A test named BUG asserts
// the behaviour the proxy SHOULD have and fails until it is fixed; a test named SOUND passes today and
// guards what works; a test named OBSERVED pins down a behaviour the report discusses (it passes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startAll, call, SECRET } from "./helpers.mjs";
import { AddressTable, clientAddress } from "../lib/limits.mjs";

test("SOUND: the allow-list cannot be talked around: case, whitespace, unicode escapes, duplicate keys, prototype names, odd ids", async () => {
  const t = await startAll();
  try {
    for (const m of ["GetSlot", "getSlot ", " getSlot", "getSlot\u0000", "getslot", "__proto__", "constructor", "hasOwnProperty", "toString"]) {
      const r = await t.rpc(call(1, m));
      assert.equal(r.body.error && r.body.error.code, -32601, JSON.stringify(m) + " is refused");
    }
    // an escape that decodes to an allowed name is that name; one that decodes to another is refused
    assert.equal((await t.rpc('{"jsonrpc":"2.0","id":1,"method":"get\\u0053lot"}')).status, 200);
    assert.equal((await t.rpc('{"jsonrpc":"2.0","id":1,"method":"\\u0072equestAirdrop","params":["x",1]}')).body.error.code, -32601);
    // duplicate keys: the proxy decides on the last one AND sends its own serialisation, so the upstream
    // sees exactly the method that was checked, once
    const before = t.fake.bodies.length;
    await t.rpc('{"jsonrpc":"2.0","id":1,"method":"requestAirdrop","method":"getSlot"}');
    const sent = t.fake.bodies.slice(before);
    assert.equal(sent.length, 1);
    assert.equal((sent[0].match(/"method"/g) || []).length, 1);
    assert.equal(JSON.parse(sent[0]).method, "getSlot");
    assert.equal((await t.rpc('{"jsonrpc":"2.0","id":1,"method":"getSlot","method":"requestAirdrop"}')).body.error.code, -32601);
    assert.equal(t.fake.calls.includes("requestAirdrop"), false, "never reached the upstream");
    // a __proto__ key in params is data, not a prototype
    assert.equal((await t.rpc('{"jsonrpc":"2.0","id":1,"method":"getSlot","params":{"__proto__":{"x":1}}}')).status, 200);
    // ids: a huge string id, an object id, a notification (no id) in a batch
    const big = "i".repeat(30000);
    const r1 = await t.rpc(call(big, "getSlot"));
    assert.equal(r1.body.id, big);
    const r2 = await t.rpc([{ jsonrpc: "2.0", method: "getSlot" }, call(2, "nope")]);
    assert.equal(r2.status, 200);
    assert.equal(t.lines.join("\n").includes(SECRET), false);
  } finally { await t.close(); }
});

test("FIXED (round 14): a batch of notifications plus one refused item is answered here, whole, with HTTP 200 and nothing sent up (it used to be 502 'upstream did not answer': the validator answers a notification-only batch with an empty 200 body)", async () => {
  const http = (await import("node:http")).default;
  const { loadConfig } = await import("../lib/config.mjs");
  const { createLogger } = await import("../lib/log.mjs");
  const { startProxy } = await import("../lib/server.mjs");
  let posts = 0;
  const up = http.createServer((q, s) => { posts++; q.resume(); q.on("end", () => { s.writeHead(200, { "content-type": "application/json" }); s.end(""); }); });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const cfg = loadConfig({ UPSTREAM_RPC: "http://127.0.0.1:" + up.address().port + "/", PORT: "0", SUMMARY_EVERY_SECONDS: "0" });
  const proxy = await startProxy(cfg, { log: createLogger(cfg.secrets, () => {}) });
  try {
    const res = await fetch("http://127.0.0.1:" + proxy.port + "/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", method: "getSlot" }, call(2, "nope")]) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.length, 2);
    assert.equal(body[0].id, null, "the notification's answer carries no id");
    assert.equal(body[0].error.code, -32600);
    assert.match(body[0].error.message, /refused item/);
    assert.equal(body[1].error.code, -32601);
    assert.equal(posts, 0, "nothing reached the upstream");
  } finally { await proxy.close(); up.closeAllConnections && up.closeAllConnections(); await new Promise((r) => up.close(r)); }
});

test("SOUND: X-Forwarded-For forms: only the last entry counts; IPv6 and IPv4-mapped loopback sockets trust it; a non-loopback socket ignores it", () => {
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  assert.equal(clientAddress(req("127.0.0.1", "1.1.1.1, 203.0.113.9")), "203.0.113.9");
  assert.equal(clientAddress(req("::1", "2001:db8::1")), "2001:db8::1");
  assert.equal(clientAddress(req("::ffff:127.0.0.1", " 203.0.113.9 ")), "203.0.113.9");
  assert.equal(clientAddress(req("203.0.113.5", "1.2.3.4")), "203.0.113.5");
  assert.equal(clientAddress(req("127.0.0.1", "")), "127.0.0.1");
  assert.equal(clientAddress(req("127.0.0.1", "a, b, " + "x".repeat(500))).length, 64);
});

test("FIXED (round 14): IPv6 addresses are charged by their /64: 2001:db8::1 to 2001:db8::32 (one /64, one machine) share one burst (each used to get the full burst)", () => {
  const table = new AddressTable({ ratePerMinute: 60, rateBurst: 120, sendPerMinute: 10 });
  const now = Date.now();
  assert.ok(table.get("2001:db8::1", now).requests.take(120, now), "the first address has the burst");
  for (let i = 2; i <= 50; i++) assert.equal(table.get("2001:db8::" + i.toString(16), now).requests.take(1, now), false, "address " + i + " shares the spent burst");
  assert.equal(table.size, 1);
  assert.ok(table.get("2001:db8:0:1::1", now).requests.take(120, now), "the next /64 is another budget");
});

test("BUG: the address table must stay at its cap: entries that are not idle are never dropped, so the table grows past maxEntries, and every new address past the cap scans the whole table", () => {
  const max = 20000;
  const table = new AddressTable({ ratePerMinute: 60, rateBurst: 120, sendPerMinute: 10, maxEntries: max });
  const now = Date.now();
  // what one request from each of 22,000 addresses within ten minutes leaves behind: a bucket one token short of full
  for (let i = 0; i < max; i++) table.get("a" + i, now).requests.take(1, now);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 2000; i++) table.get("b" + i, now + 1).requests.take(1, now + 1);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log("20,000 recent addresses, then 2,000 new ones: table size " + table.size + ", " + ms.toFixed(0) + " ms for the 2,000 (" + (ms / 2000).toFixed(2) + " ms each, a full scan per address)");
  assert.ok(table.size <= max, "table size " + table.size + " is past its cap of " + max);
});

test("FIXED (round 14): another website's origin is refused 403 before anything is charged, on the preflight, the POST and the WebSocket upgrade (CORS used to answer any origin)", async () => {
  const t = await startAll({ RATE_PER_MINUTE: "2", RATE_BURST: "2" });
  try {
    const evil = { origin: "https://some-other-dapp.example" };
    const pre = await fetch(t.origin + "/", { method: "OPTIONS", headers: { ...evil, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.equal(pre.status, 403);
    assert.equal(pre.headers.get("access-control-allow-origin"), null);
    for (let i = 0; i < 5; i++) {
      const r = await t.rpc(call(i, "getSlot"), evil);
      assert.equal(r.status, 403);
      assert.equal(r.headers.get("access-control-allow-origin"), null);
    }
    const WebSocket = (await import("ws")).default;
    const upgrade = await new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:" + t.proxy.port + "/", { headers: evil });
      ws.on("unexpected-response", (_q, res) => { res.resume(); resolve(res.statusCode); });
      ws.on("open", () => { ws.close(); resolve("open"); });
      ws.on("error", () => resolve("error"));
    });
    assert.equal(upgrade, 403);
    assert.deepEqual(t.fake.calls, [], "nothing reached the upstream");
    // the address's burst of 2 is untouched, and the site's own origin passes
    const site = await t.rpc([call(1, "getSlot"), call(2, "getSlot")], { origin: "https://programmableonsol.com" });
    assert.equal(site.status, 200);
    assert.equal(site.headers.get("access-control-allow-origin"), "https://programmableonsol.com");
    const h = await t.health();
    assert.equal(h.refused.origin, 7);
    assert.equal(h.requests.http, 1, "the refused requests were not even counted as requests");
  } finally { await t.close(); }
});

test("FIXED (round 14): the server's keep-alive timeout is 125 s, longer than Caddy's idle time for upstream connections (2 minutes by default), and the header time is above it (it used to be 5 s: the race where Caddy reuses a socket Node is closing)", async () => {
  const t = await startAll();
  try {
    assert.equal(t.proxy.server.keepAliveTimeout, 125000);
    assert.ok(t.proxy.server.headersTimeout > t.proxy.server.keepAliveTimeout);
    assert.ok(t.proxy.server.requestTimeout >= t.proxy.server.headersTimeout);
  } finally { await t.close(); }
});
