// Round 14: the fixes of the round-12 review. getMultipleAccounts params, the answer cap, the byte
// budgets, the daily caps, the site's origins, the forced Content-Type, and on the WebSocket the
// proxy's own ids, the lazy upstream socket and its idle close, the queue and frame caps, the global
// connection cap and the subscription slots.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { loadConfig } from "../lib/config.mjs";
import { createLogger } from "../lib/log.mjs";
import { startProxy } from "../lib/server.mjs";
import { startAll, call, sleep, SECRET } from "./helpers.mjs";

const Server = WebSocket.Server || WebSocket.WebSocketServer;

/// An upstream for these tests. HTTP: every POST is answered with a JSON-RPC answer padded to `bytes`
/// (with a Content-Length, or chunked when `chunked`), with `contentType`. WebSocket: subscribe answers a
/// new id; `notify` sends the final notification 30 ms later, `received` a "receivedSignature" one first;
/// unsubscribe answers true for a live id it gets as one integer, an error otherwise; `upgradeDelayMs`
/// holds the upgrade back. Records what it got.
async function upstream(opts = {}) {
  const st = { bytes: 0, chunked: false, contentType: "application/json", notify: false, received: false, upgradeDelayMs: 0, ...opts };
  const out = { posts: 0, frames: [], connections: 0, open: 0, live: new Set(), socketsClosed: 0, set: (o) => Object.assign(st, o) };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      out.posts++;
      let p = null; try { p = JSON.parse(body); } catch (_) {}
      const one = (it) => ({ jsonrpc: "2.0", id: it && it.id !== undefined ? it.id : null, result: { pad: "" } });
      let text = JSON.stringify(Array.isArray(p) ? p.map(one) : one(p));
      if (st.bytes > text.length) {
        const pad = "A".repeat(st.bytes - text.length);
        text = JSON.stringify(Array.isArray(p) ? p.map((it, i) => ({ ...one(it), result: { pad: i === 0 ? pad : "" } })) : { ...one(p), result: { pad } });
      }
      if (st.chunked) {
        res.writeHead(200, { "content-type": st.contentType });
        const buf = Buffer.from(text);
        let i = 0;
        const more = () => { while (i < buf.length) { const ok = res.write(buf.subarray(i, i + 16384)); i += 16384; if (!ok) return res.once("drain", more); } res.end(); };
        more();
      } else {
        res.writeHead(200, { "content-type": st.contentType, "content-length": Buffer.byteLength(text) });
        res.end(text);
      }
    });
  });
  // the proxy keeps its upstream sockets alive between requests: one that closes was cut
  server.on("connection", (s) => s.on("close", () => { out.socketsClosed++; }));
  const wss = new Server({ noServer: true, perMessageDeflate: false });
  let next = 500;
  server.on("upgrade", (req, socket, head) => {
    const go = () => wss.handleUpgrade(req, socket, head, (ws) => {
      out.connections++; out.open++;
      ws.on("close", () => { out.open--; });
      ws.on("message", (d) => {
        const text = String(d);
        out.frames.push(text);
        let m; try { m = JSON.parse(text); } catch (_) { return; }
        if (m.id === undefined) return;
        if (m.method === "signatureSubscribe") {
          const id = next++;
          out.live.add(id);
          ws.send(JSON.stringify({ jsonrpc: "2.0", result: id, id: m.id }));
          const note = (value) => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "signatureNotification", params: { result: { context: { slot: 1 }, value }, subscription: id } }));
          if (st.received) setTimeout(() => { try { note("receivedSignature"); } catch (_) {} }, 10);
          if (st.notify) setTimeout(() => { try { out.live.delete(id); note({ err: null }); } catch (_) {} }, 30);
          return;
        }
        if (m.method === "signatureUnsubscribe") {
          const ok = Array.isArray(m.params) && m.params.length === 1 && Number.isInteger(m.params[0]) && out.live.has(m.params[0]);
          if (ok) { out.live.delete(m.params[0]); ws.send(JSON.stringify({ jsonrpc: "2.0", result: true, id: m.id })); }
          else ws.send(JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: "Invalid subscription id." }, id: m.id }));
          return;
        }
        ws.send(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id: m.id }));
      });
    });
    if (st.upgradeDelayMs > 0) setTimeout(go, st.upgradeDelayMs); else go();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  out.port = server.address().port;
  out.close = () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); });
  return out;
}

async function start(env = {}, upOpts = {}) {
  const up = await upstream(upOpts);
  const lines = [];
  const cfg = loadConfig({ UPSTREAM_RPC: "http://127.0.0.1:" + up.port + "/v1/" + SECRET, UPSTREAM_WS: "ws://127.0.0.1:" + up.port + "/v1/" + SECRET, PORT: "0", SUMMARY_EVERY_SECONDS: "0", ...env });
  const proxy = await startProxy(cfg, { log: createLogger(cfg.secrets, (level, text) => lines.push(level + " " + text)) });
  const base = "http://127.0.0.1:" + proxy.port;
  const rpc = async (body, headers = {}) => {
    const res = await fetch(base + "/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    let text = null, cut = false;
    try { text = await res.text(); } catch (_) { cut = true; }
    let parsed = null; try { parsed = JSON.parse(text); } catch (_) {}
    return { status: res.status, headers: res.headers, body: parsed, text, cut };
  };
  const health = async () => (await fetch(base + "/health")).json();
  return { up, proxy, cfg, lines, base, rpc, health, url: "ws://127.0.0.1:" + proxy.port + "/", close: async () => { await proxy.close(); await up.close(); } };
}

function open(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    const got = [];
    const waiters = [];
    ws.on("message", (d) => { const m = JSON.parse(String(d)); if (waiters.length) waiters.shift()(m); else got.push(m); });
    ws.on("error", reject);
    ws.on("unexpected-response", (_q, res) => { res.resume(); reject(new Error("refused " + res.statusCode)); });
    ws.on("open", () => resolve({
      ws, got,
      next: (ms = 2000) => new Promise((r, j) => { if (got.length) return r(got.shift()); const t = setTimeout(() => j(new Error("no message within " + ms + " ms")), ms); waiters.push((m) => { clearTimeout(t); r(m); }); }),
      closed: new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) }))),
    }));
  });
}
const sig = (i) => String(i).padStart(4, "1") + "5".repeat(83);
const gma = (id, keys) => call(id, "getMultipleAccounts", [keys, { encoding: "base64" }]);
const key = (i) => String(i).padStart(4, "1") + "1".repeat(40);

// ---- HTTP ------------------------------------------------------------------------------------------------

test("getMultipleAccounts: a key at most twice and at most 100 keys, else -32602 here and nothing sent; in a batch the whole batch is answered here", async () => {
  const t = await start();
  try {
    let r = await t.rpc(gma(1, [key(1), key(1), key(1)]));
    assert.equal(r.status, 200); assert.equal(r.body.id, 1); assert.equal(r.body.error.code, -32602); assert.match(r.body.error.message, /same key more than 2 times/);
    r = await t.rpc(gma(2, Array.from({ length: 101 }, (_, i) => key(i))));
    assert.equal(r.body.error.code, -32602); assert.match(r.body.error.message, /at most 100 keys/);
    r = await t.rpc(gma(3, [key(1), 5]));
    assert.equal(r.body.error.code, -32602);
    r = await t.rpc(call(4, "getMultipleAccounts", [key(1)]));
    assert.equal(r.body.error.code, -32602, "the keys must be a list");
    r = await t.rpc([call(5, "getSlot"), gma(6, [key(2), key(2), key(2)])]);
    assert.equal(r.status, 200); assert.equal(r.body.length, 2); assert.equal(r.body[0].error.code, -32600); assert.equal(r.body[1].error.code, -32602);
    assert.equal(t.up.posts, 0, "none of it reached the upstream");
    // what the site sends passes: 100 different keys, and one key twice (the SDK's strict coin read with no wallet)
    r = await t.rpc(gma(7, Array.from({ length: 100 }, (_, i) => key(i))));
    assert.equal(r.status, 200); assert.equal(r.body.error, undefined);
    r = await t.rpc(gma(8, [key(9), key(9)]));
    assert.equal(r.status, 200); assert.equal(r.body.error, undefined);
    assert.equal(t.up.posts, 2);
    assert.equal((await t.health()).refused.params, 5);
  } finally { await t.close(); }
});

test("an answer over MAX_ANSWER_BYTES with a Content-Length is refused cleanly: a JSON-RPC error with every id, its upstream socket cut, the proxy goes on", async () => {
  const t = await start({ MAX_ANSWER_BYTES: "100000" }, { bytes: 300000 });
  try {
    let r = await t.rpc(call(1, "getProgramAccounts", ["x"]));
    assert.equal(r.status, 502); assert.equal(r.body.id, 1); assert.equal(r.body.error.code, -32000);
    assert.match(r.body.error.message, /over 100000 bytes/);
    r = await t.rpc([call("a", "getProgramAccounts", ["x"]), call("b", "getSlot")]);
    assert.equal(r.status, 502); assert.deepEqual(r.body.map((x) => x.id), ["a", "b"]);
    await sleep(100);
    assert.equal(t.up.socketsClosed, 2, "the upstream sockets of both answers were cut, not read to the end");
    t.up.set({ bytes: 0 });
    r = await t.rpc(call(2, "getSlot"));
    assert.equal(r.status, 200); assert.equal(r.body.id, 2);
    r = await t.rpc(call(3, "getSlot"));
    await sleep(50);
    assert.equal(t.up.socketsClosed, 2, "a whole answer leaves its socket open for the next request");
    const h = await t.health();
    assert.equal(h.refused.answerSize, 2);
    assert.equal(h.limits.answerBytes, 100000);
    assert.equal(t.lines.join("\n").includes(SECRET), false);
  } finally { await t.close(); }
});

test("an answer without a Content-Length is cut where it passes the cap; the client sees a short answer, never more than the cap", async () => {
  const t = await start({ MAX_ANSWER_BYTES: "100000" }, { bytes: 400000, chunked: true });
  try {
    const r = await t.rpc(call(1, "getProgramAccounts", ["x"]));
    assert.ok(r.cut || r.text === null || r.text.length <= 100000 + 16384, "the client got at most the cap and a chunk");
    assert.equal(r.body, null, "what came is not a whole answer");
    await sleep(100);
    const h = await t.health();
    assert.equal(h.refused.answerSize, 1);
    assert.equal(h.answers.cut, 1);
    t.up.set({ bytes: 50000 });
    const ok = await t.rpc(call(2, "getProgramAccounts", ["x"]));
    assert.equal(ok.status, 200); assert.equal(ok.body.id, 2);
    assert.equal(ok.headers.get("content-length"), null, "chunked as the upstream sent it");
  } finally { await t.close(); }
});

test("the byte budget per address: answers are charged by their length; past the budget a clean 429 (-32029, Retry-After); another address is not touched; an empty budget refuses before the upstream is asked", async () => {
  const t = await start({ MAX_ANSWER_BYTES: "200000", BYTES_PER_MINUTE: "300000" }, { bytes: 120000 });
  try {
    const A = { "x-forwarded-for": "198.51.100.20" }, B = { "x-forwarded-for": "198.51.100.21" };
    assert.equal((await t.rpc(call(1, "getProgramAccounts", ["x"]), A)).status, 200);
    assert.equal((await t.rpc(call(2, "getProgramAccounts", ["x"]), A)).status, 200);
    const r = await t.rpc(call(3, "getProgramAccounts", ["x"]), A);
    assert.equal(r.status, 429); assert.equal(r.body.id, 3); assert.equal(r.body.error.code, -32029);
    assert.match(r.body.error.message, /too many bytes this minute, try again in \d+ s/);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
    assert.equal((await t.rpc(call(4, "getProgramAccounts", ["x"]), B)).status, 200, "another address has its own budget");
    // A has about 60 KB left: a small answer still fits
    t.up.set({ bytes: 1000 });
    assert.equal((await t.rpc(call(5, "getSlot"), A)).status, 200);
    const h = await t.health();
    assert.equal(h.refused.bytes, 1);
    assert.equal(h.answers.largest >= 120000, true);
    assert.equal(h.limits.bytesPerMinute, 300000);
  } finally { await t.close(); }
});

test("the byte budget, chunked: charged as the answer streams, the answer that passes it is cut, and the next request is refused before the upstream is asked", async () => {
  const t = await start({ MAX_ANSWER_BYTES: "250000", BYTES_PER_MINUTE: "250000" }, { bytes: 200000, chunked: true });
  try {
    const A = { "x-forwarded-for": "198.51.100.30" };
    assert.equal((await t.rpc(call(1, "getProgramAccounts", ["x"]), A)).status, 200);
    const second = await t.rpc(call(2, "getProgramAccounts", ["x"]), A);
    assert.equal(second.body, null, "the second answer was cut: 50 KB of budget for 200 KB");
    await sleep(50);
    const posts = t.up.posts;
    const third = await t.rpc(call(3, "getSlot"), A);
    assert.equal(third.status, 429); assert.match(third.body.error.message, /too many bytes/);
    assert.equal(t.up.posts, posts, "refused before the upstream was asked");
    const h = await t.health();
    assert.equal(h.refused.bytes, 2);
    assert.equal(h.answers.cut, 1);
  } finally { await t.close(); }
});

test("the proxy's byte budget caps everybody together, and its burst bounds the bytes in flight at once", async () => {
  const t = await start({ MAX_ANSWER_BYTES: "100000", BYTES_PER_MINUTE: "100000", GLOBAL_BYTES_PER_MINUTE: "1000000", GLOBAL_BYTES_BURST: "250000" }, { bytes: 90000 });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await t.rpc(call(i, "getProgramAccounts", ["x"]), { "x-forwarded-for": "203.0.113." + (60 + i) })).status, 200);
    const r = await t.rpc(call(9, "getProgramAccounts", ["x"]), { "x-forwarded-for": "203.0.113.69" });
    assert.equal(r.status, 429); assert.match(r.body.error.message, /busy/);
    // a small read still fits in what is left
    t.up.set({ bytes: 2000 });
    assert.equal((await t.rpc(call(10, "getSlot"), { "x-forwarded-for": "203.0.113.70" })).status, 200);
    const h = await t.health();
    assert.equal(h.refused.bytesGlobal, 1);
    assert.equal(h.limits.globalBytesBurst, 250000);
  } finally { await t.close(); }
  // the default burst is 32 MB, never under the answer cap
  const d = loadConfig({ UPSTREAM_RPC: "http://127.0.0.1:1/" });
  assert.equal(d.globalBytesBurst, 32 * 1048576);
  assert.equal(loadConfig({ UPSTREAM_RPC: "http://127.0.0.1:1/", MAX_ANSWER_BYTES: String(40 * 1048576), BYTES_PER_MINUTE: String(40 * 1048576) }).globalBytesBurst, 40 * 1048576);
});

test("the daily caps: per address and for the proxy, with their own 429 messages and counters", async () => {
  const t = await start({ RATE_PER_DAY: "5", GLOBAL_PER_DAY: "8" });
  try {
    const A = { "x-forwarded-for": "198.51.100.40" }, B = { "x-forwarded-for": "198.51.100.41" };
    for (let i = 0; i < 5; i++) assert.equal((await t.rpc(call(i, "getSlot"), A)).status, 200);
    let r = await t.rpc(call(5, "getSlot"), A);
    assert.equal(r.status, 429); assert.equal(r.body.error.code, -32029); assert.match(r.body.error.message, /used its 5 requests of the day/);
    for (let i = 0; i < 3; i++) assert.equal((await t.rpc(call(i, "getSlot"), B)).status, 200);
    r = await t.rpc(call(9, "getSlot"), B);
    assert.equal(r.status, 429); assert.match(r.body.error.message, /the proxy used its 8 requests of the day/);
    const h = await t.health();
    assert.equal(h.refused.rateDaily, 1); assert.equal(h.refused.rateGlobalDaily, 1);
    assert.equal(h.limits.perDay, 5); assert.equal(h.limits.globalPerDay, 8);
  } finally { await t.close(); }
});

test("streamed answers always say Content-Type application/json, whatever the upstream says", async () => {
  const t = await start({}, { contentType: "text/html" });
  try {
    const r = await t.rpc(call(1, "getSlot"));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
  } finally { await t.close(); }
});

test("origins: a page of the site gets its origin back on every answer, a 429 included (so the page can read it); no Origin is served without a CORS header; ALLOWED_ORIGINS=* answers *", async () => {
  const t = await start({ RATE_PER_MINUTE: "1", RATE_BURST: "1" });
  try {
    const site = { origin: "https://programmableonsol.com" };
    let r = await t.rpc(call(1, "getSlot"), site);
    assert.equal(r.status, 200); assert.equal(r.headers.get("access-control-allow-origin"), "https://programmableonsol.com");
    r = await t.rpc(call(2, "getSlot"), site);
    assert.equal(r.status, 429); assert.equal(r.headers.get("access-control-allow-origin"), "https://programmableonsol.com");
    r = await t.rpc(call(3, "getSlot"), { origin: "http://programmableonsol.com" });
    assert.equal(r.status, 403, "the scheme is part of the origin");
  } finally { await t.close(); }
  const any = await start({ ALLOWED_ORIGINS: "*" });
  try {
    const r = await any.rpc(call(1, "getSlot"), { origin: "https://example.org" });
    assert.equal(r.status, 200); assert.equal(r.headers.get("access-control-allow-origin"), "*");
  } finally { await any.close(); }
});

test("IPv6 visitors behind Caddy are charged by their /64", async () => {
  const t = await startAll({ RATE_PER_MINUTE: "2", RATE_BURST: "2" });
  try {
    assert.equal((await t.rpc(call(1, "getSlot"), { "x-forwarded-for": "2001:db8:5:6::1" })).status, 200);
    assert.equal((await t.rpc(call(2, "getSlot"), { "x-forwarded-for": "2001:db8:5:6::2" })).status, 200);
    assert.equal((await t.rpc(call(3, "getSlot"), { "x-forwarded-for": "2001:db8:5:6:ffff::3" })).status, 429);
    assert.equal((await t.rpc(call(4, "getSlot"), { "x-forwarded-for": "2001:db8:5:7::1" })).status, 200);
  } finally { await t.close(); }
});

// ---- WebSocket ---------------------------------------------------------------------------------------------

test("WebSocket: the upstream sees the proxy's own ids and serialisation; the client gets its own ids back, duplicates and strings included", async () => {
  const t = await start({}, {});
  try {
    const c = await open(t.url);
    c.ws.send(JSON.stringify(call("abc", "signatureSubscribe", [sig(1)])));
    c.ws.send(JSON.stringify(call(7, "signatureSubscribe", [sig(2)])));
    c.ws.send(JSON.stringify(call(7, "signatureSubscribe", [sig(3)])));
    c.ws.send('{"jsonrpc":"2.0","id":9,"method":"accountSubscribe","method":"signatureSubscribe","params":["' + sig(4) + '"]}');
    const got = [await c.next(), await c.next(), await c.next(), await c.next()];
    assert.deepEqual(got.map((m) => m.id), ["abc", 7, 7, 9]);
    assert.ok(got.every((m) => Number.isInteger(m.result)));
    assert.deepEqual(t.up.frames.map((f) => JSON.parse(f).id), [1, 2, 3, 4], "the proxy's ids went up");
    const last = t.up.frames[3];
    assert.equal((last.match(/"method"/g) || []).length, 1, "one method: the one that was checked");
    assert.equal(JSON.parse(last).method, "signatureSubscribe");
    const h = await t.health();
    assert.equal(h.ws.subscriptions, 4); assert.equal(h.ws.upstreams, 1); assert.equal(h.ws.open, 1);
    c.ws.close(); await c.closed; await sleep(50);
    const after = await t.health();
    assert.equal(after.ws.subscriptions, 0); assert.equal(after.ws.open, 0); assert.equal(after.ws.upstreams, 0);
  } finally { await t.close(); }
});

test("WebSocket: no upstream socket until the first subscribe; closed after WS_IDLE_SECONDS with nothing live while the client stays; the next subscribe opens a new one", async () => {
  const t = await start({ WS_IDLE_SECONDS: "1" }, { notify: true });
  try {
    const c = await open(t.url);
    await sleep(100);
    assert.equal(t.up.connections, 0, "the upgrade opened no upstream socket");
    // an unsubscribe with no upstream socket: nothing can be live, answered here as the node answers it
    c.ws.send(JSON.stringify(call(1, "signatureUnsubscribe", [123])));
    const un = await c.next();
    assert.equal(un.id, 1); assert.equal(un.error.code, -32602);
    assert.equal(t.up.connections, 0);
    c.ws.send(JSON.stringify(call(2, "signatureSubscribe", [sig(1)])));
    const ack = await c.next();
    assert.equal(ack.id, 2);
    const note = await c.next();
    assert.equal(note.method, "signatureNotification");
    assert.equal(t.up.connections, 1); assert.equal(t.up.open, 1);
    await sleep(1400);
    assert.equal(t.up.open, 0, "idle: the upstream socket was closed");
    assert.equal(c.ws.readyState, WebSocket.OPEN, "the client's socket stays open");
    c.ws.send(JSON.stringify(call(3, "signatureSubscribe", [sig(2)])));
    assert.equal((await c.next()).id, 3);
    assert.equal(t.up.connections, 2, "a new upstream socket for the new subscribe");
    const h = await t.health();
    assert.equal(h.ws.upstreamsOpened, 2);
    c.ws.close(); await c.closed;
  } finally { await t.close(); }
});

test("WebSocket: a live subscription keeps the upstream socket past the idle time", async () => {
  const t = await start({ WS_IDLE_SECONDS: "1" }, { notify: false });
  try {
    const c = await open(t.url);
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", [sig(1)])));
    await c.next();
    await sleep(1400);
    assert.equal(t.up.open, 1, "still open: a subscription is live");
    assert.equal((await t.health()).ws.subscriptions, 1);
    c.ws.close(); await c.closed;
  } finally { await t.close(); }
});

test("WebSocket: a slot is freed only by an unsubscribe the upstream confirms or by the final notification; a refused unsubscribe and a 'received' notification keep it", async () => {
  const t = await start({ WS_SUBSCRIPTIONS_PER_CONNECTION: "1" }, { received: true });
  try {
    const c = await open(t.url);
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", [sig(1)])));
    const ack = await c.next();
    const first = await c.next();
    assert.equal(first.params.result.value, "receivedSignature");
    c.ws.send(JSON.stringify(call(2, "signatureSubscribe", [sig(2)])));
    assert.equal((await c.next()).error.code, -32029, "the 'received' notification did not free the slot");
    c.ws.send(JSON.stringify(call(3, "signatureUnsubscribe", [String(ack.result)])));
    assert.equal((await c.next()).error.code, -32602, "the upstream refused a string id");
    c.ws.send(JSON.stringify(call(4, "signatureSubscribe", [sig(3)])));
    assert.equal((await c.next()).error.code, -32029, "the refused unsubscribe did not free the slot");
    c.ws.send(JSON.stringify(call(5, "signatureUnsubscribe", [ack.result])));
    assert.equal((await c.next()).result, true);
    c.ws.send(JSON.stringify(call(6, "signatureSubscribe", [sig(4)])));
    assert.ok(Number.isInteger((await c.next()).result), "room again");
    assert.equal(t.up.live.size, 1);
    c.ws.close(); await c.closed;
  } finally { await t.close(); }
});

test("WebSocket: at most 20 frames wait while the upstream socket opens; past them the client is closed with 1008", async () => {
  const t = await start({ WS_SUBSCRIPTIONS_PER_CONNECTION: "50" }, { upgradeDelayMs: 800 });
  try {
    const c = await open(t.url);
    for (let i = 0; i < 21; i++) c.ws.send(JSON.stringify(call(i, "signatureSubscribe", [sig(i)])));
    const end = await c.closed;
    assert.equal(end.code, 1008);
    assert.match(end.reason, /too many messages/);
  } finally { await t.close(); }
  // 20 wait and all go up once it opens
  const ok = await start({ WS_SUBSCRIPTIONS_PER_CONNECTION: "50" }, { upgradeDelayMs: 300 });
  try {
    const c = await open(ok.url);
    for (let i = 0; i < 20; i++) c.ws.send(JSON.stringify(call(i, "signatureSubscribe", [sig(i)])));
    for (let i = 0; i < 20; i++) assert.ok(Number.isInteger((await c.next(3000)).result));
    c.ws.close(); await c.closed;
  } finally { await ok.close(); }
});

test("WebSocket: frames a minute per connection have a budget; past it the client is closed with 1008", async () => {
  const t = await start({ WS_FRAMES_PER_MINUTE: "10" });
  try {
    const c = await open(t.url);
    for (let i = 0; i < 11; i++) c.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
    const end = await c.closed;
    assert.equal(end.code, 1008);
    assert.equal((await t.health()).ws.refusedFrames, 1);
    assert.equal(t.up.connections, 0);
  } finally { await t.close(); }
});

test("WebSocket: WS_CONNECTIONS_MAX caps the open connections of everybody together (503); a closed one makes room", async () => {
  const t = await start({ WS_CONNECTIONS_MAX: "2" });
  try {
    const a = await open(t.url, { "x-forwarded-for": "198.51.100.50" });
    const b = await open(t.url, { "x-forwarded-for": "198.51.100.51" });
    await assert.rejects(open(t.url, { "x-forwarded-for": "198.51.100.52" }), /refused 503/);
    a.ws.close(); await a.closed; await sleep(50);
    const c = await open(t.url, { "x-forwarded-for": "198.51.100.52" });
    const h = await t.health();
    assert.equal(h.ws.refusedFull, 1); assert.equal(h.ws.open, 2); assert.equal(h.limits.wsConnections, 2);
    for (const x of [b, c]) { x.ws.close(); await x.closed; }
  } finally { await t.close(); }
});

test("WebSocket: a subscribe over budget waits for its token (web3.js would resend a refused one in a loop) and then goes up; the next one waits behind it; one that would wait too long is refused", async () => {
  // 60 a minute is a token a second; a burst of 60: the upgrade takes one, the page's reads the rest
  const t = await start({ RATE_PER_MINUTE: "60", RATE_BURST: "60" }, {});
  try {
    const c = await open(t.url);
    // spend the address's budget over HTTP, as the page's own reads do
    const r = await t.rpc(Array.from({ length: 50 }, (_, i) => call(i, "getSlot")));
    assert.equal(r.status, 200);
    await t.rpc(Array.from({ length: 9 }, (_, i) => call(i, "getSlot")));
    const t0 = Date.now();
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", [sig(1)])));
    c.ws.send(JSON.stringify(call(2, "signatureSubscribe", [sig(2)])));
    const a = await c.next(5000), b = await c.next(5000);
    const took = Date.now() - t0;
    assert.equal(a.id, 1); assert.ok(Number.isInteger(a.result), "no error: it waited");
    assert.equal(b.id, 2); assert.ok(Number.isInteger(b.result));
    assert.ok(took >= 900, "about a second each: " + took + " ms");
    const h = await t.health();
    assert.ok(h.ws.waited >= 1);
    assert.equal(h.ws.refusedRate, 0);
    assert.equal(h.ws.waiting, 0);
    assert.equal(t.up.frames.length, 2);
    c.ws.close(); await c.closed;
  } finally { await t.close(); }
  // 2 a minute: a token every 30 s, past the 10 s a request may wait: refused at once
  const slow = await start({ RATE_PER_MINUTE: "2", RATE_BURST: "2" }, {});
  try {
    const c = await open(slow.url);
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", [sig(1)])));
    assert.ok(Number.isInteger((await c.next()).result));
    c.ws.send(JSON.stringify(call(2, "signatureSubscribe", [sig(2)])));
    const m = await c.next();
    assert.equal(m.id, 2); assert.equal(m.error.code, -32029);
    c.ws.close(); await c.closed;
  } finally { await slow.close(); }
});

test("WebSocket: the site's origin and no origin are served; the upgrade costs a token (429 past the burst)", async () => {
  const t = await start({ RATE_PER_MINUTE: "2", RATE_BURST: "2" });
  try {
    const a = await open(t.url, { origin: "https://programmableonsol.com" });
    const b = await open(t.url);
    await assert.rejects(open(t.url), /refused 429/);
    const h = await t.health();
    assert.equal(h.ws.refusedRate, 1);
    for (const x of [a, b]) { x.ws.close(); await x.closed; }
  } finally { await t.close(); }
});
