// The one place that talks to the upstream RPC over HTTP: a keep-alive agent, one deadline per
// request, and nothing of the client's own headers (no origin, no cookies, no user agent).
import http from "node:http";
import https from "node:https";

export function createUpstream(cfg) {
  const u = new URL(cfg.upstreamRpc);
  const tls = u.protocol === "https:";
  const mod = tls ? https : http;
  const agent = new mod.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 128, maxFreeSockets: 16, timeout: cfg.upstreamTimeoutMs });
  const base = {
    protocol: u.protocol,
    hostname: u.hostname.replace(/^\[|\]$/g, ""),
    port: u.port || (tls ? 443 : 80),
    path: (u.pathname || "/") + (u.search || ""),
    method: "POST",
    agent,
  };

  /// POST `body` (a Buffer of JSON). Resolves with the upstream's response stream (headers read,
  /// body not). Rejects with { kind: "timeout" } after cfg.upstreamTimeoutMs without headers, or
  /// { kind: "error", error } when the connection fails. The caller reads or discards the body.
  function post(body) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const headers = { "content-type": "application/json", "content-length": body.length, accept: "application/json", "user-agent": "programmable-rpc-proxy" };
      if (cfg.upstreamOrigin) headers.origin = cfg.upstreamOrigin; // the provider's origin lock lets the site's origin through
      const req = mod.request({ ...base, headers }, (res) => {
        if (settled) { res.destroy(); return; }
        settled = true;
        clearTimeout(timer);
        // a body that has not ended within the deadline is cut; the client then sees a short answer
        const bodyTimer = setTimeout(() => res.destroy(new Error("upstream body timeout")), cfg.upstreamTimeoutMs);
        res.on("end", () => clearTimeout(bodyTimer));
        res.on("close", () => clearTimeout(bodyTimer));
        resolve(res);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy(new Error("upstream timeout"));
        reject({ kind: "timeout" });
      }, cfg.upstreamTimeoutMs);
      req.on("timeout", () => req.destroy(new Error("upstream socket timeout")));
      req.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject({ kind: "error", error: e });
      });
      req.end(body);
    });
  }

  return { post, close: () => agent.destroy() };
}

/// Read a response body whole, up to `max` bytes. Rejects when it is longer or the stream fails.
export function readAll(stream, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (c) => {
      size += c.length;
      if (size > max) { stream.destroy(new Error("upstream answer too large")); reject(new Error("upstream answer too large")); return; }
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (e) => reject(e));
  });
}
