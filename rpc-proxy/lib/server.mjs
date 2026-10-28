// Puts the pieces together: the HTTP server (JSON-RPC and /health), the WebSocket bridge on the
// same port (and on WS_PORT when set), the limits, the counters, the summary line.
import http from "node:http";
import { once } from "node:events";
import { createLogger } from "./log.mjs";
import { createCounters } from "./counters.mjs";
import { createLimits } from "./limits.mjs";
import { createUpstream } from "./upstream.mjs";
import { createRequestHandler } from "./http.mjs";
import { attachWebSocket } from "./ws.mjs";

/// Caddy keeps an idle connection to the proxy for up to 2 minutes. Node must keep it longer, or
/// Caddy may send a request on a socket Node is closing at that moment.
export const KEEP_ALIVE_MS = 125_000;

/// Start the proxy. Resolves once it listens. `close()` stops it and resolves when the ports are free.
export async function startProxy(cfg, { log = null } = {}) {
  const logger = log || createLogger(cfg.secrets);
  const counters = createCounters(cfg);
  const limits = createLimits(cfg);
  const table = limits.table;
  const upstream = createUpstream(cfg);
  const handler = createRequestHandler({ cfg, log: logger, counters, limits, upstream });

  const server = http.createServer(handler);
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  // above the keep-alive time, and the whole request within the request time
  server.headersTimeout = KEEP_ALIVE_MS + 1_000;
  server.requestTimeout = KEEP_ALIVE_MS + 5_000;
  server.on("clientError", (_e, socket) => { try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch (_) {} });
  const servers = [server];
  let side = null;
  if (cfg.wsPort) {
    // for a client that derives its WebSocket address as the RPC port plus one (web3.js does, when the
    // address names a port): plain requests there get a 426, upgrades are taken
    side = http.createServer((_req, res) => { res.writeHead(426, { "Content-Type": "text/plain", Upgrade: "websocket" }); res.end("WebSocket upgrades only. The JSON-RPC port is " + cfg.port + ".\n"); });
    side.on("clientError", (_e, socket) => { try { socket.destroy(); } catch (_) {} });
    servers.push(side);
  }
  const ws = attachWebSocket({ servers, cfg, log: logger, counters, limits });

  try {
    server.listen(cfg.port, cfg.host);
    await once(server, "listening");
    if (side) { side.listen(cfg.wsPort, cfg.host); await once(side, "listening"); }
  } catch (e) {
    // nothing may stay open after a failed start
    try { server.close(); } catch (_) {}
    try { if (side) side.close(); } catch (_) {}
    upstream.close();
    throw e;
  }

  const pruner = setInterval(() => table.prune(), 60_000);
  pruner.unref();
  const summary = cfg.summaryEverySeconds > 0 ? setInterval(() => logger.info("programmable-rpc: " + counters.summary() + ", addresses " + table.size), cfg.summaryEverySeconds * 1000) : null;
  if (summary) summary.unref();

  async function close() {
    clearInterval(pruner);
    if (summary) clearInterval(summary);
    ws.closeAll();
    const stop = (s) => new Promise((r) => { if (!s) return r(); s.close(() => r()); s.closeAllConnections && s.closeAllConnections(); });
    await Promise.all([stop(server), stop(side)]);
    upstream.close();
  }

  return { server, side, counters, table, limits, global: limits.global.requests, ws, log: logger, close, port: server.address().port, wsPort: side ? side.address().port : 0 };
}
