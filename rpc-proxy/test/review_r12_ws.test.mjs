// Round 12 review (V1): the WebSocket bridge against a client that tries to get more out of the upstream
// than its budget. A test named BUG asserts the behaviour the proxy SHOULD have and fails until it is
// fixed; a test named SOUND passes today and guards what works.
//
// The stand-in upstream here behaves like the validator's PubSub as measured on the local chain
// (ws://127.0.0.1:8900, round 12): a "ping" notification gets no answer; every signatureSubscribe for
// a new signature is a new live subscription; signatureUnsubscribe with anything but exactly one
// integer is refused with -32602 ("invalid length 2", "invalid type: floating point `230.0`") and the
// subscription stays live.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { loadConfig } from "../lib/config.mjs";
import { createLogger } from "../lib/log.mjs";
import { startProxy } from "../lib/server.mjs";
import { sleep, call } from "./helpers.mjs";

const SECRET = "R12SECRETKEY0123456789abcdef";
const Server = WebSocket.Server || WebSocket.WebSocketServer;

/// An upstream like the validator's PubSub. Records connections, raw frames and live subscriptions.
async function pubsubUpstream({ closeReason = null } = {}) {
  const out = { connections: 0, frames: 0, bytes: 0, subscribes: 0, live: new Set(), refusedUnsubscribes: 0 };
  // HTTP: every item answered with result 1, so that a 200 means "the budget let it through"
  const server = http.createServer((q, s) => {
    let b = ""; q.on("data", (c) => { b += c; });
    q.on("end", () => { let p = null; try { p = JSON.parse(b); } catch (_) {} const one = (it) => ({ jsonrpc: "2.0", result: 1, id: it && it.id !== undefined ? it.id : null }); s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify(Array.isArray(p) ? p.map(one) : one(p))); });
  });
  const wss = new Server({ noServer: true, perMessageDeflate: false });
  let next = 100;
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    out.connections++;
    if (closeReason) { setTimeout(() => ws.close(4000, closeReason), 50); }
    ws.on("message", (d) => {
      const text = String(d);
      out.frames++; out.bytes += text.length;
      let m; try { m = JSON.parse(text); } catch (_) { return; }
      if (m.id === undefined) return; // a notification: no answer
      if (m.method === "signatureSubscribe") { const id = next++; out.subscribes++; out.live.add(id); ws.send(JSON.stringify({ jsonrpc: "2.0", result: id, id: m.id })); return; }
      if (m.method === "signatureUnsubscribe") {
        const ok = Array.isArray(m.params) && m.params.length === 1 && Number.isInteger(m.params[0]) && !/\d\.\d/.test(text) && out.live.has(m.params[0]);
        if (ok) { out.live.delete(m.params[0]); ws.send(JSON.stringify({ jsonrpc: "2.0", result: true, id: m.id })); }
        else { out.refusedUnsubscribes++; ws.send(JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: "Invalid params" }, id: m.id })); }
        return;
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id: m.id }));
    });
  }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  out.port = server.address().port;
  out.close = () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); });
  return out;
}

async function startWith(env = {}, upOpts = {}) {
  const up = await pubsubUpstream(upOpts);
  const lines = [];
  const cfg = loadConfig({ UPSTREAM_RPC: "http://127.0.0.1:" + up.port + "/v1/" + SECRET, UPSTREAM_WS: "ws://127.0.0.1:" + up.port + "/v1/" + SECRET, PORT: "0", SUMMARY_EVERY_SECONDS: "0", ...env });
  const proxy = await startProxy(cfg, { log: createLogger(cfg.secrets, (level, text) => lines.push(level + " " + text)) });
  const url = "ws://127.0.0.1:" + proxy.port + "/";
  const health = async () => (await fetch("http://127.0.0.1:" + proxy.port + "/health")).json();
  return { up, proxy, url, lines, health, close: async () => { await proxy.close(); await up.close(); } };
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    const got = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    ws.on("error", reject);
    ws.on("unexpected-response", (_q, res) => { res.resume(); reject(new Error("refused " + res.statusCode)); });
    ws.on("open", () => resolve({ ws, got, closed: new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) }))) }));
  });
}
const sig = (i) => String(i).padStart(4, "1") + "5".repeat(83); // distinct 87-character signatures

test("BUG: the ping notification is free and unlimited: a client can push any number of frames (each up to 64 KB) to the upstream", async () => {
  const t = await startWith({ RATE_PER_MINUTE: "20", RATE_BURST: "20" });
  try {
    const c = await open(t.url);
    await sleep(100);
    const pad = "x".repeat(60_000);
    for (let i = 0; i < 1000; i++) c.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping", params: [pad] }));
    for (let i = 0; i < 100 && t.up.frames < 1000; i++) await sleep(50);
    const h = await t.health();
    console.log("1000 ping frames of 60 KB: the upstream received " + t.up.frames + " frames, " + Math.round(t.up.bytes / 1048576) + " MB; refusedRate " + h.ws.refusedRate);
    // the HTTP budget of this address is untouched: the burst of 20 is still all there
    const r = await fetch("http://127.0.0.1:" + t.proxy.port + "/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Array.from({ length: 20 }, (_, i) => call(i, "getSlot"))) });
    console.log("then a batch of 20 over HTTP: " + r.status);
    c.ws.close();
    assert.ok(t.up.frames <= 20, "at most the burst (20) of frames may reach the upstream, " + t.up.frames + " did");
  } finally { await t.close(); }
});

test("BUG: subscribes that share one request id are counted once: a connection holds more live upstream subscriptions than the cap", async () => {
  const t = await startWith({ WS_SUBSCRIPTIONS_PER_CONNECTION: "3" });
  try {
    const c = await open(t.url);
    for (let i = 0; i < 12; i++) c.ws.send(JSON.stringify(call(1, "signatureSubscribe", [sig(i), { commitment: "confirmed" }])));
    for (let i = 0; i < 40 && c.got.length < 12; i++) await sleep(25);
    const refused = c.got.filter((m) => m.error).length;
    console.log("cap 3, 12 subscribes with id 1: upstream live subscriptions " + t.up.live.size + ", refused here " + refused);
    c.ws.close(); await c.closed; await sleep(50);
    assert.ok(t.up.live.size <= 3, "the upstream holds " + t.up.live.size + " live subscriptions for one connection, the cap is 3");
  } finally { await t.close(); }
});

test("BUG: an unsubscribe the upstream refuses frees the slot anyway: subscribe, unsubscribe with a bad parameter, repeat", async () => {
  const t = await startWith({ WS_SUBSCRIPTIONS_PER_CONNECTION: "3" });
  try {
    const c = await open(t.url);
    let id = 1;
    for (let round = 0; round < 4; round++) {
      const acks = [];
      for (let i = 0; i < 3; i++) c.ws.send(JSON.stringify(call(id++, "signatureSubscribe", [sig(round * 10 + i), { commitment: "confirmed" }])));
      for (let i = 0; i < 40 && c.got.filter((m) => typeof m.result === "number").length < (round + 1) * 3; i++) await sleep(25);
      for (const m of c.got.filter((m) => typeof m.result === "number").slice(round * 3)) acks.push(m.result);
      // a float id: JSON.parse makes it the integer the proxy tracks, the validator refuses it
      for (const s of acks) c.ws.send('{"jsonrpc":"2.0","id":' + (id++) + ',"method":"signatureUnsubscribe","params":[' + s + '.0]}');
      await sleep(100);
    }
    console.log("cap 3, four rounds: upstream live subscriptions " + t.up.live.size + ", unsubscribes the upstream refused " + t.up.refusedUnsubscribes);
    c.ws.close(); await c.closed;
    assert.ok(t.up.live.size <= 3, "the upstream holds " + t.up.live.size + " live subscriptions for one connection, the cap is 3");
  } finally { await t.close(); }
});

test("BUG: /health ws.subscriptions does not come back to 0 after the duplicate-id subscribes of a closed connection", async () => {
  const t = await startWith();
  try {
    const c = await open(t.url);
    for (let i = 0; i < 5; i++) c.ws.send(JSON.stringify(call(7, "signatureSubscribe", [sig(i), { commitment: "confirmed" }])));
    for (let i = 0; i < 40 && c.got.length < 5; i++) await sleep(25);
    c.ws.close(); await c.closed; await sleep(100);
    const h = await t.health();
    console.log("after close: ws.open " + h.ws.open + ", ws.subscriptions " + h.ws.subscriptions);
    assert.equal(h.ws.subscriptions, 0, "no connection is open, so no subscription is live");
  } finally { await t.close(); }
});

// round 14: an upgrade now costs a token, so past the burst the loop's upgrades are refused with 429
// (the loop counts them instead of stopping at the first)
test("BUG: WebSocket connections cost nothing: opening and closing them in a loop opens as many upstream sockets", async () => {
  const t = await startWith({ RATE_PER_MINUTE: "20", RATE_BURST: "20" });
  try {
    let opened = 0, refused = 0;
    for (let i = 0; i < 60; i++) {
      try { const c = await open(t.url); opened++; c.ws.send(JSON.stringify(call(1, "signatureSubscribe", [sig(i), { commitment: "confirmed" }]))); c.ws.close(); await c.closed; }
      catch (e) { if (/refused 429/.test(String(e && e.message))) refused++; else throw e; }
    }
    await sleep(200);
    const r = await fetch("http://127.0.0.1:" + t.proxy.port + "/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Array.from({ length: 20 }, (_, i) => call(i, "getSlot"))) });
    console.log("60 open/close cycles from one address: " + opened + " opened, " + refused + " refused; upstream connections " + t.up.connections + "; a batch of 20 over HTTP afterwards: " + r.status);
    assert.ok(t.up.connections <= 20, t.up.connections + " upstream connections from one address in a few seconds, the burst is 20");
    assert.ok(opened <= 20, opened + " connections opened, the burst is 20");
    assert.equal(opened + refused, 60);
    assert.equal(r.status, 429, "the budget the sockets spent is the one HTTP spends too");
  } finally { await t.close(); }
});

test("SOUND: an upstream close reason is not passed on, and the log names no key", async () => {
  const t = await startWith({}, { closeReason: "bye " + SECRET });
  try {
    const c = await open(t.url);
    // round 14: the upstream socket opens on the first subscribe, not on the upgrade
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", [sig(1), { commitment: "confirmed" }])));
    const closed = await c.closed;
    assert.equal(closed.code, 4000, "a valid upstream code passes");
    assert.equal(closed.reason.includes(SECRET), false);
    assert.equal(closed.reason, "upstream closed");
    assert.equal(t.lines.join("\n").includes(SECRET), false);
  } finally { await t.close(); }
});

test("SOUND: duplicate keys reach the upstream as the client wrote them, but the proxy decides on the LAST one, as the validator does (the validator refuses a duplicate field outright: measured on the local chain)", async () => {
  const t = await startWith();
  try {
    const c = await open(t.url);
    c.ws.send('{"jsonrpc":"2.0","id":1,"method":"signatureSubscribe","method":"accountSubscribe","params":["x"]}');
    await sleep(150);
    assert.equal(c.got[0].error.code, -32601, "the last method decides here");
    assert.equal(t.up.frames, 0, "nothing went up");
    c.ws.close();
  } finally { await t.close(); }
});
