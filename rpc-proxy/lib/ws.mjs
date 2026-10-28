// The WebSocket side. web3.js derives wss://<host>/<same path> from the HTTP address and opens one
// socket per page for confirmTransaction (signatureSubscribe, signatureUnsubscribe, and a "ping"
// notification every 5 seconds). What the bridge does:
//
// * The upgrade is refused for another website's Origin (403), past WS_CONNECTIONS_MAX connections in
//   all (503), past WS_CONNECTIONS_PER_IP for the address (429), and when the address has no token
//   left: every upgrade costs one, like a request.
// * The upstream socket is opened on the first request that needs it (a subscribe), not on the upgrade,
//   and closed again after WS_IDLE_SECONDS with no live subscription and nothing waiting. The client's
//   socket stays open meanwhile; the next subscribe opens a new upstream socket.
// * Every message from the client is parsed and checked: the allow-list, a token per request, at most
//   N subscriptions live or waiting. What goes up is the proxy's own serialisation of what was checked,
//   with an id of the proxy's own; the answer comes back with the client's id. So the proxy knows what
//   each answer answers, and duplicate or missing client ids change nothing.
// * A subscription counts as live when the upstream confirms it (a numeric result). Its slot is freed
//   only when the upstream confirms the unsubscribe (result true) or sends the signature's final
//   notification (the node ends a signature subscription itself then).
// * The "ping" notification never goes up: the proxy pings the upstream itself. A ping with an id is
//   answered here, as the validator answers it (method not found).
// * Frames that arrive while the upstream socket opens wait, 20 at most; frames a minute per
//   connection have a budget. Past either the client is closed with 1008.
// * When the upstream closes on its own, so does the client. When the client closes, so does the upstream.
//
// Uses the `ws` package that @solana/web3.js already installs at the repository root (7.x or 8.x).
import { ERR, rpcError, isObject, idOf } from "./jsonrpc.mjs";
import { clientAddress, Bucket } from "./limits.mjs";
import { originAllowed } from "./http.mjs";

let WS = null;
try { WS = (await import("ws")).default; } catch (_) { WS = null; }
export const wsAvailable = !!(WS && (WS.Server || WS.WebSocketServer));

const HEARTBEAT_MS = 30_000;
/// Frames that may wait while the upstream socket opens.
export const QUEUE_MAX = 20;
/// How long a request over budget may wait for its token before it is refused.
export const HOLD_MAX_MS = 10_000;
/// The largest frame from the client. web3.js sends a few hundred bytes.
const FRAME_MAX = 16 * 1024;
/// The largest frame from the upstream. A signature notification is a few hundred bytes.
const UP_FRAME_MAX = 1024 * 1024;
const isValidClose = (c) => Number.isInteger(c) && ((c >= 1000 && c <= 1014 && c !== 1004 && c !== 1005 && c !== 1006) || (c >= 3000 && c <= 4999));
const textOf = (data) => (typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8"));

function refuse(socket, status, reason, body, extra = "") {
  const text = JSON.stringify(body);
  try {
    socket.write("HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " + Buffer.byteLength(text) + "\r\n" + extra + "Connection: close\r\n\r\n" + text);
  } catch (_) {}
  socket.destroy();
}

/// Take the upgrades of every server in `servers`. Returns { count(), closeAll() }.
export function attachWebSocket({ servers, cfg, log, counters, limits }) {
  if (!wsAvailable) throw new Error("the ws package is missing: run npm ci at the repository root");
  const Server = WS.Server || WS.WebSocketServer;
  const table = limits.table;
  const wss = new Server({ noServer: true, maxPayload: Math.min(cfg.bodyLimitBytes, FRAME_MAX), perMessageDeflate: false, clientTracking: true });
  const isRpcPath = (p) => p === "/" || p === "/rpc" || p === "/rpc/";
  const bridges = new Set();
  counters.wsLive = () => {
    let upstreams = 0, subscriptions = 0, pending = 0, waiting = 0;
    for (const b of bridges) { if (b.upstreamOpen()) upstreams++; subscriptions += b.subs.size; pending += b.pending.size; waiting += b.held.length; }
    return { open: bridges.size, upstreams, subscriptions, pending, waiting };
  };

  function onUpgrade(req, socket, head) {
    try {
      socket.on("error", () => {});
      let pathname;
      try { pathname = new URL(req.url, "http://x").pathname; } catch (_) { pathname = ""; }
      if (!isRpcPath(pathname)) { counters.refused.path++; return refuse(socket, 404, "Not Found", rpcError(null, ERR.INVALID, "not found")); }
      if (!originAllowed(cfg, req.headers.origin)) { counters.refused.origin++; return refuse(socket, 403, "Forbidden", rpcError(null, ERR.INVALID, "this proxy serves the pages of its own site only")); }
      if (bridges.size >= cfg.wsConnectionsMax) {
        counters.ws.refusedFull++;
        return refuse(socket, 503, "Service Unavailable", rpcError(null, ERR.RATE, "the proxy holds as many WebSocket connections as it takes, try again in a minute"), "Retry-After: 60\r\n");
      }
      const entry = table.get(clientAddress(req));
      if (entry.ws >= cfg.wsConnectionsPerIp) {
        counters.ws.refusedConnections++;
        return refuse(socket, 429, "Too Many Requests", rpcError(null, ERR.RATE, "too many WebSocket connections from this address"));
      }
      // a connection costs a token, like a request: opening and closing sockets in a loop is not free
      const r = limits.charge(entry, 1, 0, Date.now());
      if (r) {
        counters.ws.refusedRate++;
        return refuse(socket, 429, "Too Many Requests", rpcError(null, ERR.RATE, r.text), "Retry-After: " + r.wait + "\r\n");
      }
      // the slot is taken once the upgrade went through (ws calls back at once): a refused handshake keeps none
      wss.handleUpgrade(req, socket, head, (client) => { entry.ws++; bridge(client, entry); });
    } catch (e) {
      log.error("upgrade", e);
      try { socket.destroy(); } catch (_) {}
    }
  }

  function bridge(client, entry) {
    counters.ws.total++;
    let closed = false;
    let up = null;            // the upstream socket, or null while none is open
    let upOpen = false;
    const queue = [];         // frames for an upstream socket that is still opening
    const pending = new Map(); // proxy id -> { clientId, kind: "subscribe" | "unsubscribe" | "other", sub }
    const subs = new Set();    // subscription ids the upstream confirmed and has not ended
    let nextId = 1;
    let idleTimer = null;
    let beat = null;
    let clientAlive = true;
    const held = [];           // checked requests waiting for a token: { msg, id, kind, sub, until }
    let heldTimer = null;
    const frames = new Bucket(cfg.wsFramesPerMinute, cfg.wsFramesPerMinute);
    const b = { subs, pending, held, upstreamOpen: () => !!up && upOpen };
    bridges.add(b);
    const subscribesWaiting = () => {
      let n = 0;
      for (const p of pending.values()) if (p.kind === "subscribe") n++;
      for (const h of held) if (h.kind === "subscribe") n++;
      return n;
    };

    const finish = (code, reason) => {
      if (closed) return;
      closed = true;
      bridges.delete(b);
      entry.ws = Math.max(0, entry.ws - 1);
      pending.clear(); subs.clear(); queue.length = 0; held.length = 0;
      clearInterval(beat);
      clearTimeout(idleTimer);
      clearTimeout(heldTimer);
      try { client.close(isValidClose(code) ? code : 1011, String(reason || "").slice(0, 120)); } catch (_) { try { client.terminate(); } catch (_2) {} }
      dropUpstream();
    };
    const answer = (obj) => { try { client.send(JSON.stringify(obj)); } catch (_) {} };

    // ---- the upstream socket: opened when needed, closed when idle ----------------------------------
    function dropUpstream() {
      const u = up;
      up = null; upOpen = false;
      if (!u) return;
      // a socket still connecting cannot be closed in order (ws reports that as one more error): cut it
      try { if (u.readyState === WS.OPEN) u.close(1000); else u.terminate(); } catch (_) { try { u.terminate(); } catch (_2) {} }
    }
    function idleCheck() {
      clearTimeout(idleTimer);
      idleTimer = null;
      if (closed || !up || subs.size || pending.size || queue.length || held.length) return;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (closed || !up || subs.size || pending.size || queue.length || held.length) return;
        dropUpstream();
      }, cfg.wsIdleSeconds * 1000);
      if (idleTimer.unref) idleTimer.unref();
    }
    function openUpstream() {
      counters.ws.upstreamsOpened++;
      const u = new WS(cfg.upstreamWs, { handshakeTimeout: cfg.upstreamTimeoutMs, perMessageDeflate: false, maxPayload: UP_FRAME_MAX, ...(cfg.upstreamOrigin ? { origin: cfg.upstreamOrigin } : {}) });
      up = u; upOpen = false;
      const mine = () => up === u && !closed;
      u.on("open", () => {
        if (!mine()) { try { u.close(1000); } catch (_) {} return; }
        upOpen = true;
        for (const t of queue) { try { u.send(t); } catch (_) {} }
        queue.length = 0;
      });
      u.on("message", (data) => { if (mine()) fromUpstream(textOf(data)); });
      u.on("close", (code) => { if (mine()) finish(isValidClose(code) ? code : 1011, "upstream closed"); });
      u.on("error", (e) => { if (!mine()) return; counters.upstream.wsErrors++; log.warn("upstream websocket: " + (e && (e.code || e.message) || "error")); finish(1011, "upstream did not answer"); });
      u.on("unexpected-response", (_req, res) => { if (!mine()) return; counters.upstream.wsErrors++; log.warn("upstream websocket refused the upgrade: " + (res && res.statusCode)); try { res.resume(); } catch (_) {} finish(1011, "upstream did not answer"); });
    }
    /// Send one checked message up, with an id of the proxy's own.
    function sendUp(msg, clientId, kind, sub) {
      const id = nextId++;
      pending.set(id, { clientId, kind, sub });
      const text = JSON.stringify({ ...msg, id });
      clearTimeout(idleTimer); idleTimer = null;
      if (!up) openUpstream();
      if (upOpen) { try { up.send(text); } catch (_) { finish(1011, "upstream send failed"); } return; }
      if (queue.length >= QUEUE_MAX) return finish(1008, "too many messages before the upstream answered");
      queue.push(text);
    }

    // ---- what the upstream says ---------------------------------------------------------------------
    function fromUpstream(text) {
      let m;
      try { m = JSON.parse(text); } catch (_) { return; }
      if (!isObject(m)) return;
      if (m.id !== undefined && m.id !== null) {
        const p = pending.get(m.id);
        if (!p) return; // not an answer to anything this proxy sent
        pending.delete(m.id);
        if (p.kind === "subscribe" && Number.isInteger(m.result)) subs.add(m.result);
        else if (p.kind === "unsubscribe" && m.result === true) subs.delete(p.sub);
        if (p.clientId !== undefined) { try { client.send(JSON.stringify({ ...m, id: p.clientId })); } catch (_) { return finish(1011, "client send failed"); } }
        return idleCheck();
      }
      // a notification: the signature's final one ends its subscription on the node (a "received" one does not)
      if (m.method === "signatureNotification" && isObject(m.params)) {
        const r = m.params.result;
        const received = isObject(r) && r.value === "receivedSignature";
        if (!received) subs.delete(m.params.subscription);
      }
      try { client.send(text); } catch (_) { return finish(1011, "client send failed"); }
      idleCheck();
    }

    // ---- what the client says -----------------------------------------------------------------------
    client.on("message", (data, isBinary) => {
      if (closed) return;
      const binary = typeof isBinary === "boolean" ? isBinary : typeof data !== "string";
      if (binary) return finish(1003, "text frames only");
      if (!frames.take(1)) { counters.ws.refusedFrames++; return finish(1008, "too many messages"); }
      counters.ws.messages++;
      let msg;
      try { msg = JSON.parse(textOf(data)); } catch (_) { return answer(rpcError(null, ERR.PARSE, "the message is not JSON")); }
      if (Array.isArray(msg)) return answer(rpcError(null, ERR.INVALID, "no batches on the WebSocket"));
      if (!isObject(msg) || typeof msg.method !== "string") return answer(rpcError(idOf(msg), ERR.INVALID, "invalid request"));
      const id = "id" in msg ? idOf(msg) : undefined;
      const method = msg.method;
      if (!cfg.wsMethods.has(method)) { counters.ws.refusedMethod++; return answer(rpcError(id === undefined ? null : id, ERR.METHOD, "method not allowed by this proxy: " + method.replace(/[^\x21-\x7e]/g, "?").slice(0, 64))); }
      counters.ws.methods[method] = (counters.ws.methods[method] || 0) + 1;
      // the heartbeat stays here: the proxy keeps both sockets alive itself
      if (method === "ping") {
        if (id !== undefined) answer(rpcError(id, ERR.METHOD, "Method not found"));
        return;
      }
      const isSub = /Subscribe$/.test(method), isUnsub = /Unsubscribe$/.test(method);
      if (isSub) {
        // a subscription is followed by its id; one without an id could not be counted, so it is refused
        if (id === undefined || id === null) return answer(rpcError(null, ERR.INVALID, "a subscription needs an id"));
        if (subs.size + subscribesWaiting() >= cfg.wsSubscriptionsPerConnection) { counters.ws.refusedSubscriptions++; return answer(rpcError(id, ERR.RATE, "too many subscriptions on this connection")); }
      }
      if (pending.size + held.length >= 2 * cfg.wsSubscriptionsPerConnection) { counters.ws.refusedSubscriptions++; return answer(rpcError(id === undefined ? null : id, ERR.RATE, "too many requests waiting on this connection")); }
      // no upstream socket: nothing can be live, so the unsubscribe is answered as the node answers it
      if (isUnsub && !up) return id === undefined ? undefined : answer(rpcError(id, ERR.PARAMS, "Invalid subscription id."));
      const kind = isSub ? "subscribe" : isUnsub ? "unsubscribe" : "other";
      const sub = isUnsub && Array.isArray(msg.params) ? msg.params[0] : undefined;
      // in order: behind a request that waits for its token, this one waits too
      if (held.length) { held.push({ msg, id, kind, sub, until: Date.now() + HOLD_MAX_MS }); return; }
      const r = limits.charge(entry, 1, 0, Date.now());
      if (r) return hold(msg, id, kind, sub, r);
      sendUp(msg, id, kind, sub);
    });

    // A request over budget waits for its token instead of being refused at once, up to HOLD_MAX_MS: web3.js
    // answers a refused subscribe by sending it again at once, in a loop, and the page's confirmation would
    // then hang on a socket closed for too many messages. The budget holds all the same: the request goes up
    // only once its token is taken. One that would wait longer is refused.
    function hold(msg, id, kind, sub, r) {
      if (r.wait * 1000 > HOLD_MAX_MS) { counters.ws.refusedRate++; return answer(rpcError(id === undefined ? null : id, ERR.RATE, r.text)); }
      counters.ws.waited++;
      held.push({ msg, id, kind, sub, until: Date.now() + HOLD_MAX_MS });
      if (!heldTimer) heldTimer = setTimeout(release, r.wait * 1000);
    }
    function release() {
      heldTimer = null;
      while (!closed && held.length) {
        const h = held[0];
        const now = Date.now();
        const r = limits.charge(entry, 1, 0, now);
        if (!r) { held.shift(); sendUp(h.msg, h.id, h.kind, h.sub); continue; }
        if (now + r.wait * 1000 > h.until) { held.shift(); counters.ws.refusedRate++; answer(rpcError(h.id === undefined ? null : h.id, ERR.RATE, r.text)); continue; }
        heldTimer = setTimeout(release, r.wait * 1000);
        return;
      }
      idleCheck();
    }

    client.on("close", () => finish(1000, "client closed"));
    client.on("error", () => finish(1011, "client error"));
    client.on("pong", () => { clientAlive = true; });
    // a client that stops answering pings is dropped; the upstream is pinged too, so a socket with a live subscription stays open
    beat = setInterval(() => {
      if (closed) return;
      if (!clientAlive) return finish(1001, "no answer to ping");
      clientAlive = false;
      try { client.ping(); } catch (_) {}
      try { if (up && upOpen) up.ping(); } catch (_) {}
    }, HEARTBEAT_MS);
    if (beat.unref) beat.unref();
  }

  for (const s of servers) s.on("upgrade", onUpgrade);
  return {
    count: () => bridges.size,
    closeAll: () => { for (const c of wss.clients) { try { c.close(1001, "server stopping"); } catch (_) {} } },
  };
}
