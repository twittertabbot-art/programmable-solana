// The HTTP side against the fake upstream: allow-list, batches, body cap, the three budgets, the
// upstream failing in every way, CORS, paths, and the key never leaving the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startAll, call, SECRET, sleep } from "./helpers.mjs";

test("an allowed method is forwarded to the upstream's own address and its answer comes back as is", async () => {
  const t = await startAll();
  try {
    const r = await t.rpc(call(7, "getSlot"));
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 7);
    assert.equal(typeof r.body.result, "number");
    assert.deepEqual(t.fake.calls, ["getSlot"]);
    assert.equal(t.fake.paths[0], "/v1/" + SECRET, "the proxy posts to the provider's path, key included");
    assert.equal(r.headers.get("access-control-allow-origin"), null, "a request without an Origin (a script) gets no CORS header");
    assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
    const h = await t.health();
    assert.equal(h.methods.getSlot, 1);
    assert.equal(h.requests.http, 2 - 1, "the health read itself is not a request");
  } finally { await t.close(); }
});

test("a method outside the allow-list is refused with -32601 and never reaches the upstream", async () => {
  const t = await startAll();
  try {
    for (const m of ["requestAirdrop", "getBlock", "getProgramAccounts2", "getLargestAccounts", "ping"]) {
      const r = await t.rpc(call(1, m, []));
      assert.equal(r.status, 200, m);
      assert.equal(r.body.error.code, -32601, m);
      assert.match(r.body.error.message, /not allowed/);
    }
    assert.deepEqual(t.fake.calls, []);
    assert.equal((await t.health()).refused.method, 5);
  } finally { await t.close(); }
});

test("bodies that are not JSON-RPC are refused with 400 and the right code", async () => {
  const t = await startAll();
  try {
    let r = await t.rpc("{not json");
    assert.equal(r.status, 400); assert.equal(r.body.error.code, -32700);
    r = await t.rpc("42");
    assert.equal(r.status, 400); assert.equal(r.body.error.code, -32600);
    r = await t.rpc("[]");
    assert.equal(r.status, 400); assert.equal(r.body.error.code, -32600);
    r = await t.rpc({ jsonrpc: "2.0", id: 3, params: [] });
    assert.equal(r.status, 200); assert.equal(r.body.error.code, -32600); assert.equal(r.body.id, 3);
    r = await t.rpc(call(4, "getSlot", "not-params"));
    assert.equal(r.body.error.code, -32600);
    assert.deepEqual(t.fake.calls, []);
    const h = await t.health();
    assert.equal(h.refused.json, 5);
  } finally { await t.close(); }
});

test("a batch with a refused item is answered here, whole: the refused items with their own error, the allowed ones told to come alone, every id kept, nothing sent up, nothing charged", async () => {
  const t = await startAll({ RATE_PER_MINUTE: "3", RATE_BURST: "3" });
  try {
    const r = await t.rpc([call("a", "getSlot"), call("b", "getBlock", [1]), call("c", "getHealth"), { jsonrpc: "2.0", id: "d" }]);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.equal(r.body.length, 4);
    const byId = Object.fromEntries(r.body.map((x) => [x.id, x]));
    assert.equal(byId.a.error.code, -32600);
    assert.match(byId.a.error.message, /holds a refused item, so none of it was sent/);
    assert.equal(byId.c.error.code, -32600);
    assert.equal(byId.b.error.code, -32601);
    assert.equal(byId.d.error.code, -32600);
    assert.deepEqual(t.fake.calls, [], "the upstream saw nothing");
    // the burst of 3 is all there: the refused batch cost nothing
    assert.equal((await t.rpc([call(1, "getSlot"), call(2, "getSlot"), call(3, "getSlot")])).status, 200);
    assert.equal(t.responses.join("\n").includes(SECRET), false);
  } finally { await t.close(); }
});

test("a batch with nothing refused streams through, and one with everything refused never goes up", async () => {
  const t = await startAll();
  try {
    let r = await t.rpc([call(1, "getSlot"), call(2, "getSlot")]);
    assert.equal(r.status, 200); assert.equal(r.body.length, 2); assert.equal(r.body[1].id, 2);
    r = await t.rpc([call(1, "getBlock"), call(2, "getBlocks")]);
    assert.equal(r.status, 200); assert.equal(r.body.length, 2); assert.equal(r.body[0].error.code, -32601);
    assert.equal(t.fake.calls.length, 2);
  } finally { await t.close(); }
});

test("a batch longer than the cap is refused whole, and the cap is a setting", async () => {
  const t = await startAll({ BATCH_LIMIT: "3" });
  try {
    let r = await t.rpc([1, 2, 3, 4].map((i) => call(i, "getSlot")));
    assert.equal(r.status, 400); assert.equal(r.body.error.code, -32600); assert.match(r.body.error.message, /batch over 3/);
    r = await t.rpc([1, 2, 3].map((i) => call(i, "getSlot")));
    assert.equal(r.status, 200); assert.equal(r.body.length, 3);
    assert.equal((await t.health()).refused.batch, 1);
  } finally { await t.close(); }
});

test("a body over the cap gets 413 before anything is read into memory", async () => {
  const t = await startAll({ BODY_LIMIT_BYTES: "2048" });
  try {
    const big = JSON.stringify(call(1, "getSlot", ["x".repeat(4000)]));
    let r = await t.rpc(big);
    assert.equal(r.status, 413); assert.equal(r.body.error.code, -32600);
    // the same without a Content-Length: chunked, cut while it streams
    const res = await new Promise((resolve, reject) => {
      import("node:http").then(({ default: http }) => {
        const req = http.request(t.origin + "/", { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
        req.on("error", (e) => resolve({ status: 0, body: String(e) }));
        req.write(big.slice(0, 3000)); setTimeout(() => { try { req.end(big.slice(3000)); } catch (_) {} }, 20);
      }).catch(reject);
    });
    assert.equal(res.status, 413);
    assert.deepEqual(t.fake.calls, []);
    assert.equal((await t.health()).refused.body, 2);
  } finally { await t.close(); }
});

test("per address: the burst passes, the next request gets 429 with a JSON-RPC error and Retry-After; another address is not touched; only the LAST X-Forwarded-For entry counts", async () => {
  const t = await startAll({ RATE_PER_MINUTE: "5", RATE_BURST: "5" });
  try {
    const A = { "x-forwarded-for": "198.51.100.1" }, B = { "x-forwarded-for": "198.51.100.2" };
    for (let i = 0; i < 5; i++) assert.equal((await t.rpc(call(i, "getSlot"), A)).status, 200);
    const r = await t.rpc(call(9, "getSlot"), A);
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, -32029);
    assert.equal(r.body.id, 9);
    assert.match(r.body.error.message, /too many requests from this address/);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
    assert.equal((await t.rpc(call(1, "getSlot"), B)).status, 200, "another address still answers");
    // a forged first entry does not make a new address: Caddy's entry is the last one
    const spoof1 = { "x-forwarded-for": "1.1.1.1, 198.51.100.1" }, spoof2 = { "x-forwarded-for": "2.2.2.2, 198.51.100.1" };
    assert.equal((await t.rpc(call(1, "getSlot"), spoof1)).status, 429);
    assert.equal((await t.rpc(call(1, "getSlot"), spoof2)).status, 429);
    // a batch costs one token per item
    const C = { "x-forwarded-for": "198.51.100.3" };
    assert.equal((await t.rpc([1, 2, 3, 4].map((i) => call(i, "getSlot")), C)).status, 200);
    const rb = await t.rpc([1, 2].map((i) => call(i, "getSlot")), C);
    assert.equal(rb.status, 429);
    assert.ok(Array.isArray(rb.body) && rb.body.length === 2 && rb.body.every((x) => x.error.code === -32029));
    const h = await t.health();
    assert.equal(h.refused.rate, 4);
    assert.equal(h.addresses, 3);
    assert.equal(JSON.stringify(h).includes("198.51.100"), false, "no address in /health");
  } finally { await t.close(); }
});

test("sendTransaction has its own budget per address", async () => {
  const t = await startAll({ SEND_PER_MINUTE: "2" });
  try {
    const tx = ["AQAAAA==", { encoding: "base64" }];
    assert.equal((await t.rpc(call(1, "sendTransaction", tx))).status, 200);
    assert.equal((await t.rpc(call(2, "sendTransaction", tx))).status, 200);
    const r = await t.rpc(call(3, "sendTransaction", tx));
    assert.equal(r.status, 429);
    assert.match(r.body.error.message, /too many transactions/);
    assert.equal((await t.rpc(call(4, "getSlot"))).status, 200, "reads still pass");
    assert.equal((await t.health()).refused.rateSend, 1);
    assert.equal(t.fake.calls.filter((m) => m === "sendTransaction").length, 2);
  } finally { await t.close(); }
});

test("the global budget caps everybody together", async () => {
  const t = await startAll({ GLOBAL_PER_MINUTE: "3" });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await t.rpc(call(i, "getSlot"), { "x-forwarded-for": "203.0.113." + i })).status, 200);
    const r = await t.rpc(call(9, "getSlot"), { "x-forwarded-for": "203.0.113.9" });
    assert.equal(r.status, 429);
    assert.match(r.body.error.message, /busy/);
    assert.equal((await t.health()).refused.rateGlobal, 1);
  } finally { await t.close(); }
});

test("an upstream that does not answer in time becomes -32000 with 502, and is counted", async () => {
  const t = await startAll({ UPSTREAM_TIMEOUT_MS: "1000" }, { delayMs: 1600 });
  try {
    const t0 = Date.now();
    const r = await t.rpc(call(1, "getSlot"));
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, -32000);
    assert.equal(r.body.error.message, "upstream did not answer");
    assert.ok(Date.now() - t0 < 1500, "answered at the deadline, not after the upstream");
    assert.equal((await t.health()).upstream.timeouts, 1);
    await sleep(700);
  } finally { await t.close(); }
});

test("an upstream that answers 500 or 429, or refuses the connection, becomes -32000 and never leaks its address", async () => {
  const t = await startAll({}, { status: 500 });
  try {
    let r = await t.rpc(call(1, "getSlot"));
    assert.equal(r.status, 502); assert.equal(r.body.error.code, -32000);
    t.fake.set({ status: 429 });
    r = await t.rpc(call(2, "getSlot"));
    assert.equal(r.status, 429); assert.equal(r.body.error.code, -32000); assert.match(r.body.error.message, /busy/);
    // a batch with a refused item never goes up, whatever the upstream would say
    r = await t.rpc([call(3, "getSlot"), call(4, "getBlock")]);
    assert.equal(r.status, 200); assert.equal(r.body.length, 2); assert.equal(r.body[0].error.code, -32600); assert.equal(r.body[1].error.code, -32601);
    r = await t.rpc([call(5, "getSlot"), call(6, "getHealth")]);
    assert.equal(r.status, 429); assert.equal(r.body.length, 2); assert.ok(r.body.every((x) => x.error.code === -32000));
    assert.equal((await t.health()).upstream.badStatus, 3);
    assert.equal(t.responses.join("\n").includes(SECRET), false, "the upstream's own error body never reaches the client");
  } finally { await t.close(); }
  // nobody listens on the upstream's port any more: connection refused
  const dead = await startAll();
  const port = dead.fake.port;
  await dead.fake.close();
  try {
    const r = await dead.rpc(call(1, "getSlot"));
    assert.equal(r.status, 502); assert.equal(r.body.error.code, -32000);
    const h = await dead.health();
    assert.equal(h.upstream.errors, 1);
    const everything = dead.lines.join("\n") + "\n" + dead.responses.join("\n");
    assert.equal(everything.includes(SECRET), false, "the key is in no log line and no answer");
    assert.equal(everything.includes("/v1/"), false, "nor the path it sits in");
    assert.equal(h.upstreamHost, "127.0.0.1:" + port, "the host alone is said");
    assert.ok(dead.lines.some((l) => /upstream error/.test(l)), "the failure is logged");
  } finally { await dead.proxy.close(); }
});

test("the key is in no log line and no answer after a normal session, and the logger redacts it wherever it appears", async () => {
  const t = await startAll();
  try {
    await t.rpc(call(1, "getSlot"));
    await t.rpc(call(2, "getBlock"));
    await t.rpc("nope");
    t.log.warn("something quoted the address " + t.cfg.upstreamRpc + " and the socket " + t.cfg.upstreamWs);
    const everything = t.lines.join("\n") + "\n" + t.responses.join("\n");
    assert.equal(everything.includes(SECRET), false);
    assert.ok(t.lines.at(-1).includes("<upstream>"));
    assert.equal(t.lines.at(-1).includes("/v1/"), false);
  } finally { await t.close(); }
});

test("CORS: the site's origins only; a preflight from one answers 204 with the asked headers; another origin gets 403; GET / says what it is; other paths 404; GET is never JSON-RPC", async () => {
  const t = await startAll();
  try {
    const pre = await fetch(t.origin + "/", { method: "OPTIONS", headers: { origin: "https://programmableonsol.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type, solana-client" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://programmableonsol.com");
    assert.equal(pre.headers.get("vary"), "Origin");
    assert.equal(pre.headers.get("access-control-allow-headers"), "content-type, solana-client");
    const www = await fetch(t.origin + "/", { method: "OPTIONS", headers: { origin: "https://www.programmableonsol.com", "access-control-request-method": "POST" } });
    assert.equal(www.headers.get("access-control-allow-origin"), "https://www.programmableonsol.com");
    const other = await fetch(t.origin + "/", { method: "OPTIONS", headers: { origin: "https://example.org", "access-control-request-method": "POST" } });
    assert.equal(other.status, 403);
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    assert.equal((await t.health()).refused.origin, 1);
    const root = await fetch(t.origin + "/");
    assert.equal(root.status, 200);
    assert.equal((await root.json()).service, "programmable-rpc");
    assert.equal((await fetch(t.origin + "/nothing")).status, 404);
    assert.equal((await fetch(t.origin + "/nothing", { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(t.origin + "/", { method: "PUT", body: "{}" })).status, 405);
    // the Caddy block strips /rpc; a Caddy that does not still works
    const viaRpc = await fetch(t.origin + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call(1, "getHealth")) });
    assert.equal(viaRpc.status, 200); assert.equal((await viaRpc.json()).result, "ok");
    assert.equal((await fetch(t.origin + "/rpc/health")).status, 200);
    assert.equal((await t.health()).refused.path, 3);
  } finally { await t.close(); }
});

test("/health has the counters and names the upstream by its host only", async () => {
  const t = await startAll();
  try {
    await t.rpc([call(1, "getSlot"), call(2, "getAccountInfo", ["x"]), call(3, "getSlot")]);
    await t.rpc(call(4, "getBlock"));
    const h = await t.health();
    assert.equal(h.ok, true);
    assert.equal(h.upstreamHost, "127.0.0.1:" + t.fake.port);
    assert.equal(h.requests.http, 2);
    assert.equal(h.requests.items, 4);
    assert.equal(h.requests.batches, 1);
    assert.equal(h.requests.forwarded, 1);
    assert.deepEqual(h.methods, { getSlot: 2, getAccountInfo: 1 });
    assert.equal(h.refused.method, 1);
    assert.equal(h.limits.perMinute, 60);
    assert.equal(h.limits.batch, 50);
    assert.equal(JSON.stringify(h).includes(SECRET), false);
    assert.equal(typeof h.uptimeSeconds, "number");
  } finally { await t.close(); }
});

test("the default allow-list is what the site and the SDK call, no more", async () => {
  const t = await startAll();
  try {
    const used = ["getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getTokenAccountBalance", "getTokenAccountsByOwner", "getLatestBlockhash", "getBlockHeight", "getSlot", "getEpochInfo", "getSignatureStatuses", "getSignaturesForAddress", "getTransaction", "simulateTransaction", "sendTransaction", "getMinimumBalanceForRentExemption", "getFeeForMessage", "getVersion", "getHealth"];
    assert.deepEqual([...t.cfg.methods].sort(), used.sort());
    const own = await startAll({ METHODS: "getSlot, getHealth" });
    try {
      assert.equal((await own.rpc(call(1, "getSlot"))).body.error, undefined);
      assert.equal((await own.rpc(call(2, "getAccountInfo", ["x"]))).body.error.code, -32601);
    } finally { await own.close(); }
  } finally { await t.close(); }
});
