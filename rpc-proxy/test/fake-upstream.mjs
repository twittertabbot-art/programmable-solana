// A stand-in for the provider, for the tests: an HTTP JSON-RPC server that answers every method with
// something plausible and records what it was asked, and a WebSocket server on the same port that
// answers subscribe requests with a subscription id and then sends one signatureNotification.
import http from "node:http";
import WebSocket from "ws";

export const SECRET = "SECRETKEY1234567890abcdef";
const Server = WebSocket.Server || WebSocket.WebSocketServer;

function resultFor(method, params, n) {
  switch (method) {
    case "getHealth": return "ok";
    case "getSlot": return 12345 + n;
    case "getBlockHeight": return 100;
    case "getVersion": return { "solana-core": "fake" };
    case "getLatestBlockhash": return { context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1000 } };
    case "getAccountInfo": return { context: { slot: 1 }, value: null };
    case "getMultipleAccounts": return { context: { slot: 1 }, value: (Array.isArray(params) && Array.isArray(params[0]) ? params[0] : []).map(() => null) };
    case "getSignatureStatuses": return { context: { slot: 1 }, value: (Array.isArray(params) && Array.isArray(params[0]) ? params[0] : []).map(() => ({ slot: 1, confirmations: 3, err: null, confirmationStatus: "confirmed" })) };
    case "sendTransaction": return "signature" + n;
    case "getTransaction": return { slot: 1, meta: { err: null, logMessages: [] }, transaction: { signatures: [Array.isArray(params) ? params[0] : "x"] } };
    default: return { echo: method };
  }
}

/// Start it. Options: delayMs (answer this late), status (answer every POST with this HTTP status
/// and a plain body), notify (send a signatureNotification after a signatureSubscribe, default
/// true), wsRefuse (refuse every upgrade with 403). Returns { port, origin, calls, paths, wsMessages,
/// wsConnections, set(opts), closeWsClients(), close() }.
export async function startFakeUpstream(opts = {}) {
  const state = { delayMs: 0, status: 200, notify: true, wsRefuse: false, ...opts };
  const out = { calls: [], paths: [], bodies: [], wsMessages: [], wsConnections: 0, set: (o) => Object.assign(state, o) };
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      out.paths.push(req.url);
      const text = Buffer.concat(chunks).toString("utf8");
      out.bodies.push(text);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) {}
      const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      for (const it of items) out.calls.push(it && it.method);
      const answer = () => {
        if (state.status !== 200) { res.writeHead(state.status, { "content-type": "text/plain" }); return res.end("nope " + SECRET); }
        const one = (it) => ({ jsonrpc: "2.0", result: resultFor(it && it.method, it && it.params, ++n), id: it && it.id !== undefined ? it.id : null });
        const body = JSON.stringify(Array.isArray(parsed) ? items.map(one) : one(parsed));
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
      };
      if (state.delayMs > 0) setTimeout(answer, state.delayMs); else answer();
    });
  });
  const wss = new Server({ noServer: true });
  let subId = 0;
  server.on("upgrade", (req, socket, head) => {
    if (state.wsRefuse) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    out.paths.push("ws:" + req.url);
    wss.handleUpgrade(req, socket, head, (ws) => {
      out.wsConnections++;
      ws.on("message", (data) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        out.wsMessages.push(text);
        let m = null;
        try { m = JSON.parse(text); } catch (_) { return; }
        if (!m || m.id === undefined) return; // a notification (ping): no answer
        if (/Subscribe$/.test(m.method)) {
          const id = ++subId;
          ws.send(JSON.stringify({ jsonrpc: "2.0", result: id, id: m.id }));
          if (m.method === "signatureSubscribe" && state.notify) setTimeout(() => { try { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "signatureNotification", params: { result: { context: { slot: 1 }, value: { err: null } }, subscription: id } })); } catch (_) {} }, 50);
        } else if (/Unsubscribe$/.test(m.method)) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", result: true, id: m.id }));
        } else {
          ws.send(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id: m.id }));
        }
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  out.port = server.address().port;
  out.origin = "http://127.0.0.1:" + out.port;
  out.closeWsClients = () => { for (const c of wss.clients) c.close(1012, "upstream going away"); };
  out.close = () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); });
  return out;
}
