// When a pool with a hook is simulated again (lib/schedule.mjs), the feed's settings and its routes over HTTP
// (lib/config.mjs, lib/server.mjs). Offline: the HTTP test listens on 127.0.0.1 only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { decodePool, decodeGuardConfig, decodeRulesConfig, PROGRAMS } from "../../sdk/dist/index.js";
import { simKey, windowRuns, simulationDue, simToJson, simFromJson, keptNote, quietSkip, quietAfter, SIM_REASONS } from "../lib/schedule.mjs";
import { healthBody, startServer, tradesPathPool } from "../lib/server.mjs";
import { parseArgs, buildConfig, describeConfig } from "../lib/config.mjs";
import { guardConfig, rulesConfig, strictConfig, poolBytes, POOL, BASE_MINT } from "./bytes.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const base = { poolBytes: Uint8Array.of(1, 2, 3), cfgBytes: Uint8Array.of(4), manifestBytes: Uint8Array.of(5), extraMetasBytes: Uint8Array.of(6), deploySlot: "77", upgradeAuthority: null, platform: { paused: false, maxHookFeeBps: 1000 } };

test("the key of a simulation: the same inputs give the same key, any change gives another", () => {
  const k = simKey(base);
  assert.equal(simKey({ ...base }), k);
  const changes = [
    { poolBytes: Uint8Array.of(1, 2, 4) }, { cfgBytes: Uint8Array.of(9) }, { cfgBytes: null }, { manifestBytes: Uint8Array.of(0) }, { extraMetasBytes: null },
    { deploySlot: "78" }, { upgradeAuthority: "Auth111" }, { platform: { paused: true, maxHookFeeBps: 1000 } }, { platform: { paused: false, maxHookFeeBps: 900 } },
  ];
  const keys = changes.map((c) => simKey({ ...base, ...c }));
  for (const x of keys) assert.notEqual(x, k);
  assert.equal(new Set(keys).size, keys.length);
});

test("when a pool is simulated again: first, on a change, in a window, after an unfunded probe, when old; else kept", () => {
  const at = "2026-10-20T12:00:00.000Z";
  const t = Date.parse(at);
  const last = { at, key: "k", buy: { ok: true }, sell: { ok: true }, retry: false };
  const hour = 60 * 60_000;
  const due = (o) => simulationDue({ last, key: "k", nowMs: t + 60_000, maxAgeMs: hour, ...o });
  assert.deepEqual(due({ last: null }), { due: true, reason: "first" });
  assert.deepEqual(due({ last: { ...last, buy: null } }), { due: true, reason: "first" });
  assert.deepEqual(due({ key: "other" }), { due: true, reason: "changed" });
  assert.deepEqual(due({ windowRunning: true }), { due: true, reason: "window" });
  assert.deepEqual(due({ last: { ...last, retry: true } }), { due: true, reason: "retry" });
  assert.deepEqual(due({ nowMs: t + hour }), { due: true, reason: "age" });
  assert.deepEqual(due({ nowMs: t + hour - 1 }), { due: false, reason: null });
  assert.deepEqual(due({}), { due: false, reason: null });
  assert.deepEqual(SIM_REASONS, ["first", "changed", "window", "retry", "age"]);
  assert.ok(keptNote(at, 60).includes("at least every 60 minutes"));
  assert.ok(/^[\x20-\x7e]*$/.test(keptNote(at, 60)));
});

test("the windows that move with the slot: the launch guard's fee, a rules coin's sniper fee and buy limit, a strict coin's windows", () => {
  const pool = decodePool(POOL, poolBytes({ lpFeeBps: 100 }));
  const guard = { template: "launch_guard", guard: decodeGuardConfig(guardConfig({ startSlot: 1000n, guardSlots: 300n, startFeeBps: 3000 })) };
  assert.equal(windowRuns(guard, pool, 1100), true);
  assert.equal(windowRuns(guard, pool, 1300), false);
  assert.equal(windowRuns({ template: "launch_guard", guard: decodeGuardConfig(guardConfig({ startSlot: 0n })) }, pool, 5), false, "a guard never armed runs no window");
  const sniper = { template: "rules", rules: decodeRulesConfig(rulesConfig({ startSlot: 1000n, sniperSlots: 50n, sniperStartFeeBps: 2000 })) };
  assert.deepEqual([windowRuns(sniper, pool, 1010), windowRuns(sniper, pool, 1060)], [true, false]);
  const limit = { template: "rules", rules: decodeRulesConfig(rulesConfig({ startSlot: 1000n, maxBuyQuote: 1_000_000_000n, limitSlots: 100n })) };
  assert.deepEqual([windowRuns(limit, pool, 1050), windowRuns(limit, pool, 1200)], [true, false]);
  const strict = { template: "rules", rules: decodeRulesConfig(strictConfig({ startSlot: 1000n })) };
  // the max wallet runs 330 slots, the early lock 200 after the early window of 80
  assert.deepEqual([windowRuns(strict, pool, 1100), windowRuns(strict, pool, 1329), windowRuns(strict, pool, 2000)], [true, true, false]);
  const plain = { template: "rules", rules: decodeRulesConfig(rulesConfig({ startSlot: 1000n })) };
  assert.equal(windowRuns(plain, pool, 1001), false, "a rules coin without windows");
  assert.equal(windowRuns({ template: "tax", tax: {} }, pool, 1), false);
  assert.equal(windowRuns(guard, pool, null), false);
});

test("a crank that found nothing skips while what it depends on stays the same, and reads again after a while", () => {
  const max = 600_000;
  // a pass that found something to do leaves nothing to skip on
  assert.equal(quietAfter(null, "k1", false, 0, max), null);
  assert.equal(quietAfter(null, null, true, 0, max), null, "no key read: nothing to compare with");
  let q = quietAfter(null, "k1", true, 1000, max);
  assert.deepEqual(q, { key: "k1", since: 1000 });
  assert.equal(quietSkip(q, "k1", 2000, max), true);
  assert.equal(quietSkip(q, "k2", 2000, max), false, "a pool changed: read");
  assert.equal(quietSkip(q, "k1", 1000 + max, max), false, "ten minutes on: read anyway");
  assert.equal(quietSkip(null, "k1", 2000, max), false);
  // the quiet goes on with the same key, and starts again after the safety read or with a new key
  assert.deepEqual(quietAfter(q, "k1", true, 5000, max), { key: "k1", since: 1000 });
  assert.deepEqual(quietAfter(q, "k1", true, 1000 + max, max), { key: "k1", since: 1000 + max });
  assert.deepEqual(quietAfter(q, "k2", true, 7000, max), { key: "k2", since: 7000 });
  q = quietAfter(q, "k1", false, 8000, max);
  assert.equal(quietSkip(q, "k1", 9000, max), false, "work was found: the next pass reads");
});

test("a kept simulation goes through the state file and back unchanged", () => {
  const sim = { ok: true, error: null, amountOut: 123n, stage: null, holder: "H", amountIn: 50_000_000n, slot: 99, logs: ["x"], probeLimit: { maxBuyQuote: 7n, untilSlot: 1200n }, probeMaxWallet: { amount: 9n, untilSlot: 1300n } };
  const back = simFromJson(JSON.parse(JSON.stringify(simToJson(sim))));
  assert.deepEqual(back, { ok: true, error: null, amountOut: 123n, stage: null, holder: "H", amountIn: 50_000_000n, slot: 99, probeLimit: { maxBuyQuote: 7n, untilSlot: 1200n }, probeMaxWallet: { amount: 9n, untilSlot: 1300n } });
  const failed = simFromJson(simToJson({ ok: false, error: "swap: x", amountOut: null, stage: "swap" }));
  assert.deepEqual(failed, { ok: false, error: "swap: x", amountOut: null, stage: "swap", holder: null, amountIn: null, slot: null });
  assert.equal(simToJson(null), null);
});

test("the feed's settings: on by default, every 10 s, off with FEED=off, --no-feed or --pool, and the files", () => {
  const c = buildConfig({}, parseArgs([]), "/w");
  assert.deepEqual([c.feed, c.feedIntervalSeconds, c.feedMaxTxPerPass, c.marketRefreshSeconds, c.mintRefreshSeconds, c.metadataRefreshSeconds, c.metadataTimeoutMs, c.simMaxAgeMinutes], [true, 10, 200, 1800, 600, 21600, 3000, 60]);
  assert.deepEqual([c.marketFile, c.tradesDir, c.feedStateFile, c.marketCacheFile].map((p) => p.replace(/\\/g, "/")), ["/w/status/market.json", "/w/status/trades", "/w/state/feed.json", "/w/state/market-cache.json"]);
  assert.ok(describeConfig(c).feed.startsWith("every 10 s"));
  assert.equal(buildConfig({ FEED: "off" }, parseArgs([]), "/w").feed, false);
  assert.equal(buildConfig({}, parseArgs(["--no-feed"]), "/w").feed, false);
  assert.equal(buildConfig({}, parseArgs(["--pool", POOL.toBase58()]), "/w").feed, false, "one pool's run writes no feed");
  assert.equal(buildConfig({}, parseArgs(["--no-crank"]), "/w").feed, true, "the feed sends nothing: --no-crank leaves it on");
  assert.equal(buildConfig({ FEED_INTERVAL_SECONDS: "30", SIM_MAX_AGE_MINUTES: "15" }, parseArgs([]), "/w").feedIntervalSeconds, 30);
  assert.throws(() => buildConfig({ FEED_INTERVAL_SECONDS: "1" }, parseArgs([]), "/w"), /FEED_INTERVAL_SECONDS=1 is below the minimum 2/);
  assert.throws(() => buildConfig({ FEED: "maybe" }, parseArgs([]), "/w"), /FEED=maybe must be on or off/);
});

test("/health carries the feed: its last pass, the slot it is complete to, its lag behind the newest slot read", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const status = { updatedAt: "2026-10-20T11:59:30.000Z", pools: { a: {} } };
  const h = healthBody({ status, feed: { enabled: true, lastFeedAt: "2026-10-20T11:59:55.000Z", intervalSeconds: 10, feedSlot: 1000, latestSlot: 1012, pools: 3, transactions: 40, unreadable: 1, marketUpdatedAt: "x", marketPools: 3 }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.deepEqual([h.ok, h.feedEnabled, h.feedStale, h.feedSlot, h.feedLagSlots, h.feedPools, h.feedTransactions, h.feedUnreadable, h.marketPools], [true, true, false, 1000, 12, 3, 40, 1, 3]);
  const stuck = healthBody({ status, feed: { enabled: true, lastFeedAt: "2026-10-20T11:59:20.000Z", intervalSeconds: 10, feedSlot: 1000, latestSlot: 1100 }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.deepEqual([stuck.ok, stuck.feedStale, stuck.feedLagSlots], [false, true, 100], "no pass for three intervals: stale");
  const off = healthBody({ status, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.deepEqual([off.ok, off.feedEnabled, off.feedSlot, off.feedLagSlots], [true, false, null, null]);
});

test("the two routes over HTTP: CORS open, a five second cache, only addresses as file names, 503 and 404 in words", async () => {
  assert.equal(tradesPathPool(`/trades/${POOL.toBase58()}.json`), POOL.toBase58());
  for (const bad of ["/trades/../state/state.json", "/trades/%2e%2e%2fstate.json", "/trades/x.json", `/trades/${POOL.toBase58()}`, `/trades/${POOL.toBase58()}.json/x`, "/trades/"]) assert.equal(tradesPathPool(bad), null, bad);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
  const marketFile = path.join(dir, "market.json");
  const tradesDir = path.join(dir, "trades");
  fs.mkdirSync(tradesDir);
  const server = startServer({ port: 0, host: "127.0.0.1", statusFile: path.join(dir, "pools.json"), marketFile, tradesDir, cluster: "localnet", getStatus: () => null, staleAfterMs: 1000, log: quiet });
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const get = (p, method = "GET") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method }, (res) => { let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body })); });
    req.on("error", reject); req.end();
  });
  try {
    let r = await get("/market.json");
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.body).error, /no market.json yet/);
    fs.writeFileSync(marketFile, JSON.stringify({ version: 1, pools: [] }));
    r = await get("/market.json");
    assert.deepEqual([r.status, r.headers["access-control-allow-origin"], r.headers["cache-control"], r.headers["content-type"]], [200, "*", "public, max-age=5", "application/json; charset=utf-8"]);
    assert.deepEqual(JSON.parse(r.body), { version: 1, pools: [] });
    r = await get("/market.json", "HEAD");
    assert.deepEqual([r.status, r.body, r.headers["content-length"]], [200, "", String(JSON.stringify({ version: 1, pools: [] }).length)]);
    // a reader that takes gzip gets it compressed; the file changes, the compressed answer follows
    const gz = (p) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: p, headers: { "accept-encoding": "gzip, deflate, br" } }, (res) => { const parts = []; res.on("data", (c) => parts.push(c)); res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(parts) })); }).on("error", reject);
    });
    let z = await gz("/market.json");
    assert.deepEqual([z.headers["content-encoding"], z.headers.vary, JSON.parse(zlib.gunzipSync(z.body).toString("utf8"))], ["gzip", "Accept-Encoding", { version: 1, pools: [] }]);
    fs.writeFileSync(marketFile, JSON.stringify({ version: 1, pools: [{ address: "x" }] }));
    z = await gz("/market.json");
    assert.deepEqual(JSON.parse(zlib.gunzipSync(z.body).toString("utf8")), { version: 1, pools: [{ address: "x" }] });
    r = await get(`/trades/${POOL.toBase58()}.json`);
    assert.equal(r.status, 404);
    fs.writeFileSync(path.join(tradesDir, `${POOL.toBase58()}.json`), JSON.stringify({ version: 1, pool: POOL.toBase58(), events: [] }));
    r = await get(`/trades/${POOL.toBase58()}.json`);
    assert.deepEqual([r.status, r.headers["access-control-allow-origin"], r.headers["cache-control"], JSON.parse(r.body).pool], [200, "*", "public, max-age=5", POOL.toBase58()]);
    r = await get("/trades/..%2F..%2Fpools.json");
    assert.equal(r.status, 400);
    r = await get(`/trades/${BASE_MINT.toBase58()}.json`, "OPTIONS");
    assert.deepEqual([r.status, r.headers["access-control-allow-origin"]], [204, "*"]);
  } finally {
    server.close();
  }
  // without the feed the two routes say so
  const off = startServer({ port: 0, host: "127.0.0.1", statusFile: path.join(dir, "pools.json"), cluster: "localnet", getStatus: () => null, staleAfterMs: 1000, log: quiet });
  await new Promise((r) => off.once("listening", r));
  try {
    const p2 = off.address().port;
    const r = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: p2, path: "/market.json" }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); }));
    assert.equal(r.status, 404);
    assert.match(JSON.parse(r.body).error, /without the feed/);
  } finally { off.close(); }
  assert.ok(PROGRAMS.hookpool);
});
