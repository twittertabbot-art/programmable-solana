// The WebSocket side against the fake upstream: a subscription through the bridge, the allow-list,
// the two caps, the upstream closing, the heartbeat notification, the paths, the side port, and
// web3.js's own Connection confirming a transaction through the proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Connection } from "@solana/web3.js";
import { startAll, call, freePort, sleep, SECRET } from "./helpers.mjs";

/// Open a client socket to the proxy; resolves with { ws, messages, next(), close() } once open, or
/// rejects with the HTTP status of a refused upgrade.
function connect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const messages = [];
    const waiters = [];
    ws.on("message", (d) => { const text = typeof d === "string" ? d : d.toString("utf8"); const m = JSON.parse(text); if (waiters.length) waiters.shift()(m); else messages.push(m); });
    ws.on("unexpected-response", (_req, res) => { res.resume(); reject(new Error("upgrade refused " + res.statusCode)); });
    ws.on("error", (e) => reject(e));
    ws.on("open", () => resolve({
      ws, messages,
      next: (ms = 2000) => new Promise((r, j) => { if (messages.length) return r(messages.shift()); const t = setTimeout(() => j(new Error("no message within " + ms + " ms")), ms); waiters.push((m) => { clearTimeout(t); r(m); }); }),
      closed: new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) }))),
      close: () => ws.close(),
    }));
  });
}

test("signatureSubscribe goes up, the id and the notification come down, the subscription is counted and then released", async () => {
  const t = await startAll();
  try {
    const c = await connect("ws://127.0.0.1:" + t.proxy.port + "/");
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", ["sig", { commitment: "confirmed" }])));
    const ack = await c.next();
    assert.equal(ack.id, 1); assert.equal(typeof ack.result, "number");
    await sleep(20);
    const note = await c.next();
    assert.equal(note.method, "signatureNotification");
    assert.equal(note.params.subscription, ack.result);
    assert.equal(t.fake.wsConnections, 1);
    assert.equal(JSON.parse(t.fake.wsMessages[0]).method, "signatureSubscribe");
    assert.equal(t.fake.paths.find((p) => p.startsWith("ws:")), "ws:/v1/" + SECRET, "the upstream socket is opened on the provider's own path");
    await sleep(20);
    let h = await t.health();
    assert.equal(h.ws.open, 1); assert.equal(h.ws.total, 1); assert.equal(h.ws.subscriptions, 0, "the notification ended the subscription");
    assert.equal(h.ws.methods.signatureSubscribe, 1);
    c.close();
    await c.closed;
    await sleep(50);
    h = await t.health();
    assert.equal(h.ws.open, 0);
    assert.equal(t.lines.join("\n").includes(SECRET), false);
  } finally { await t.close(); }
});

test("a method outside the WebSocket allow-list is answered -32601 here; batches and non-JSON are refused; the upstream sees none of it", async () => {
  const t = await startAll();
  try {
    const c = await connect("ws://127.0.0.1:" + t.proxy.port + "/");
    c.ws.send(JSON.stringify(call(1, "accountSubscribe", ["x"])));
    let m = await c.next(); assert.equal(m.id, 1); assert.equal(m.error.code, -32601);
    c.ws.send(JSON.stringify(call(2, "getSlot")));
    m = await c.next(); assert.equal(m.error.code, -32601);
    c.ws.send(JSON.stringify([call(3, "signatureSubscribe", ["x"])]));
    m = await c.next(); assert.equal(m.error.code, -32600);
    c.ws.send("{nope");
    m = await c.next(); assert.equal(m.error.code, -32700);
    await sleep(50);
    assert.deepEqual(t.fake.wsMessages, []);
    assert.equal((await t.health()).ws.refusedMethod, 2);
    c.close(); await c.closed;
  } finally { await t.close(); }
});

test("at most N live subscriptions per connection; an unsubscribe frees one", async () => {
  const t = await startAll({ WS_SUBSCRIPTIONS_PER_CONNECTION: "2" }, { notify: false });
  try {
    const c = await connect("ws://127.0.0.1:" + t.proxy.port + "/");
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", ["a"])));
    const a = await c.next(); assert.equal(typeof a.result, "number");
    c.ws.send(JSON.stringify(call(2, "signatureSubscribe", ["b"])));
    const b = await c.next(); assert.equal(typeof b.result, "number");
    c.ws.send(JSON.stringify(call(3, "signatureSubscribe", ["c"])));
    const refused = await c.next();
    assert.equal(refused.id, 3); assert.equal(refused.error.code, -32029); assert.match(refused.error.message, /too many subscriptions/);
    assert.equal((await t.health()).ws.subscriptions, 2);
    c.ws.send(JSON.stringify(call(4, "signatureUnsubscribe", [a.result])));
    assert.equal((await c.next()).result, true);
    c.ws.send(JSON.stringify(call(5, "signatureSubscribe", ["d"])));
    assert.equal(typeof (await c.next()).result, "number", "room again after the unsubscribe");
    assert.equal((await t.health()).ws.refusedSubscriptions, 1);
    assert.equal(t.fake.wsMessages.length, 4, "the refused one never went up");
    c.close(); await c.closed;
  } finally { await t.close(); }
});

test("at most N connections per address; a closed one makes room; another address is not touched", async () => {
  const t = await startAll({ WS_CONNECTIONS_PER_IP: "2" });
  try {
    const A = { "x-forwarded-for": "198.51.100.7" };
    const c1 = await connect("ws://127.0.0.1:" + t.proxy.port + "/", A);
    const c2 = await connect("ws://127.0.0.1:" + t.proxy.port + "/", A);
    await assert.rejects(connect("ws://127.0.0.1:" + t.proxy.port + "/", A), /upgrade refused 429/);
    const other = await connect("ws://127.0.0.1:" + t.proxy.port + "/", { "x-forwarded-for": "198.51.100.8" });
    c1.close(); await c1.closed; await sleep(30);
    const c3 = await connect("ws://127.0.0.1:" + t.proxy.port + "/", A);
    const h = await t.health();
    assert.equal(h.ws.refusedConnections, 1);
    assert.equal(h.ws.open, 3);
    for (const c of [c2, c3, other]) { c.close(); await c.closed; }
  } finally { await t.close(); }
});

test("when the upstream closes, the client is closed too; when the upstream refuses the upgrade the client is closed with 1011", async () => {
  const t = await startAll();
  try {
    const c = await connect("ws://127.0.0.1:" + t.proxy.port + "/");
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", ["a"])));
    await c.next();
    t.fake.closeWsClients();
    const end = await c.closed;
    assert.equal(end.code, 1012);
    assert.equal((await t.health()).ws.open, 0);
    t.fake.set({ wsRefuse: true });
    const c2 = await connect("ws://127.0.0.1:" + t.proxy.port + "/");
    // the upstream socket is opened by the first subscribe
    c2.ws.send(JSON.stringify(call(2, "signatureSubscribe", ["b"])));
    const end2 = await c2.closed;
    assert.equal(end2.code, 1011);
    assert.match(end2.reason, /upstream did not answer/);
    assert.equal((await t.health()).upstream.wsErrors, 1);
    assert.equal(t.lines.join("\n").includes(SECRET), false);
  } finally { await t.close(); }
});

test("web3.js's ping notification stays here: it never goes up and spends nothing; a ping with an id is answered here; the upgrade and every request spend the budget", async () => {
  // a burst of 3: the upgrade takes one, the two subscribes the rest
  const t = await startAll({ RATE_PER_MINUTE: "3", RATE_BURST: "3" }, { notify: false });
  try {
    const c = await connect("ws://127.0.0.1:" + t.proxy.port + "/");
    for (let i = 0; i < 10; i++) c.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
    c.ws.send(JSON.stringify(call("p", "ping")));
    const pong = await c.next();
    assert.equal(pong.id, "p"); assert.equal(pong.error.code, -32601, "answered as the validator answers it");
    await sleep(50);
    assert.equal(t.fake.wsConnections, 0, "pings open no upstream socket");
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", ["a"])));
    assert.equal(typeof (await c.next()).result, "number");
    c.ws.send(JSON.stringify(call(2, "signatureSubscribe", ["b"])));
    assert.equal(typeof (await c.next()).result, "number");
    c.ws.send(JSON.stringify(call(3, "signatureSubscribe", ["c"])));
    const r = await c.next();
    assert.equal(r.error.code, -32029);
    await sleep(30);
    assert.equal(t.fake.wsMessages.filter((m) => JSON.parse(m).method === "ping").length, 0, "no ping went up");
    assert.equal(t.fake.wsMessages.length, 2);
    const h = await t.health();
    assert.equal(h.ws.refusedRate, 1);
    assert.equal(h.ws.methods.ping, 11);
    c.close(); await c.closed;
  } finally { await t.close(); }
});

test("the upgrade is taken at / and /rpc, refused elsewhere; a frame over the body cap closes the socket", async () => {
  const t = await startAll({ BODY_LIMIT_BYTES: "2048" });
  try {
    const c = await connect("ws://127.0.0.1:" + t.proxy.port + "/rpc");
    await assert.rejects(connect("ws://127.0.0.1:" + t.proxy.port + "/elsewhere"), /upgrade refused 404/);
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", ["x".repeat(5000)])));
    const end = await c.closed;
    assert.equal(end.code, 1009);
    assert.equal((await t.health()).refused.path, 1);
  } finally { await t.close(); }
});

test("WS_PORT: a second port takes upgrades only, plain requests there get 426", async () => {
  const wsPort = await freePort();
  const t = await startAll({ WS_PORT: String(wsPort) });
  try {
    assert.equal((await fetch("http://127.0.0.1:" + wsPort + "/")).status, 426);
    const c = await connect("ws://127.0.0.1:" + wsPort + "/");
    c.ws.send(JSON.stringify(call(1, "signatureSubscribe", ["a"])));
    assert.equal(typeof (await c.next()).result, "number");
    c.close(); await c.closed;
  } finally { await t.close(); }
});

test("web3.js Connection: confirmTransaction through the proxy resolves on the notification (the WebSocket address it derives is the port plus one)", async () => {
  const t = await startAll({ PORT: "pair" });
  try {
    const port = t.proxy.port;
    assert.equal(t.proxy.wsPort, port + 1);
    const conn = new Connection("http://127.0.0.1:" + port + "/rpc", { commitment: "confirmed" });
    assert.equal(await conn.getSlot() > 0, true, "HTTP through the proxy");
    const sig = "5".repeat(87);
    const r = await conn.confirmTransaction({ signature: sig, blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1000 }, "confirmed");
    assert.equal(r.value.err, null);
    await sleep(50);
    const h = await t.health();
    assert.equal(h.ws.total, 1);
    assert.equal(h.ws.methods.signatureSubscribe, 1);
    assert.ok(t.fake.calls.includes("getBlockHeight") || t.fake.calls.includes("getSignatureStatuses"), "confirmTransaction's HTTP reads went through too");
    // web3.js keeps the socket for later subscriptions; it is closed with the connection's socket
    conn._rpcWebSocket.close();
    await sleep(50);
  } finally { await t.close(); }
});
