// The HTTP side: POST JSON-RPC at / (or /rpc), GET /health, CORS for the site's own origins. A
// request with another Origin is refused before anything else; one without an Origin (a script, a
// bot, the site's own server) is served like a page. The body is read up to the body cap, parsed,
// checked against the allow-list, charged to the client's buckets and the proxy's, and only then sent
// to the upstream. The answer streams back as it comes, up to the answer cap, each byte charged to the
// client's byte budget and the proxy's.
import { ERR, rpcError, checkBody } from "./jsonrpc.mjs";
import { clientAddress } from "./limits.mjs";

/// Kept for the record: the proxy no longer merges upstream answers with refusals (a batch with a
/// refused item is answered here, whole), so it never holds an answer in memory.
export const MERGE_MAX_BYTES = 2 * 1024 * 1024;
const UPSTREAM_TEXT = "upstream did not answer";

/// Is this Origin header one the proxy serves? No header at all is a script, not a page: served.
export function originAllowed(cfg, origin) {
  if (origin === undefined) return true;
  if (cfg.allowedOrigins.has("*")) return true;
  return cfg.allowedOrigins.has(String(origin).trim().replace(/\/+$/, "").toLowerCase());
}

export function createRequestHandler({ cfg, log, counters, limits, upstream }) {
  const table = limits.table;
  const any = cfg.allowedOrigins.has("*");
  const cors = (req) => {
    const origin = req.headers.origin;
    if (origin === undefined) return {};
    const h = { Vary: "Origin" };
    if (!originAllowed(cfg, origin)) return h;
    h["Access-Control-Allow-Origin"] = any ? "*" : String(origin).replace(/[^\x21-\x7e]/g, "");
    h["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS";
    h["Access-Control-Allow-Headers"] = String(req.headers["access-control-request-headers"] || "Content-Type, Solana-Client").replace(/[^\x20-\x7e]/g, "").slice(0, 512);
    h["Access-Control-Max-Age"] = "86400";
    return h;
  };
  const json = (req, res, status, body, extra = {}) => {
    if (res.headersSent || res.writableEnded) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { ...cors(req), ...extra, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
    res.end(text);
  };
  const isRpcPath = (p) => p === "/" || p === "/rpc" || p === "/rpc/";
  const isHealthPath = (p) => p === "/health" || p === "/rpc/health";

  function handle(req, res) {
    try {
      let pathname;
      try { pathname = new URL(req.url, "http://x").pathname; } catch (_) { counters.refused.path++; return json(req, res, 400, rpcError(null, ERR.INVALID, "bad request")); }
      // another website's page: refused before its body is read or anything is charged
      if (!originAllowed(cfg, req.headers.origin)) {
        counters.refused.origin++;
        req.resume();
        return json(req, res, 403, rpcError(null, ERR.INVALID, "this proxy serves the pages of its own site only"), { Connection: "close" });
      }
      if (req.method === "OPTIONS") { res.writeHead(204, cors(req)); return res.end(); }
      if (req.method === "GET" || req.method === "HEAD") {
        if (isHealthPath(pathname)) return json(req, res, 200, counters.snapshot(table.size));
        if (isRpcPath(pathname)) return json(req, res, 200, { ok: true, service: "programmable-rpc", hint: "POST JSON-RPC here. GET /health shows the counters." });
        counters.refused.path++;
        return json(req, res, 404, rpcError(null, ERR.INVALID, "not found"));
      }
      if (req.method !== "POST" || !isRpcPath(pathname)) {
        counters.refused.path++;
        req.resume();
        return json(req, res, req.method !== "POST" ? 405 : 404, rpcError(null, ERR.INVALID, req.method !== "POST" ? "POST JSON-RPC here" : "not found"));
      }
      counters.requests.http++;
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > cfg.bodyLimitBytes) {
        counters.refused.body++;
        json(req, res, 413, rpcError(null, ERR.INVALID, "request body over " + cfg.bodyLimitBytes + " bytes"), { Connection: "close" });
        req.resume();
        return;
      }
      const chunks = [];
      let size = 0, over = false;
      req.on("data", (c) => {
        if (over) return;
        size += c.length;
        if (size > cfg.bodyLimitBytes) {
          over = true;
          counters.refused.body++;
          json(req, res, 413, rpcError(null, ERR.INVALID, "request body over " + cfg.bodyLimitBytes + " bytes"), { Connection: "close" });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => { if (!over) onBody(req, res, Buffer.concat(chunks)).catch((e) => { log.error("request", e); json(req, res, 500, rpcError(null, ERR.UPSTREAM, "internal error")); }); });
      req.on("error", () => { if (!res.headersSent) json(req, res, 400, rpcError(null, ERR.INVALID, "request aborted")); });
    } catch (e) {
      log.error("request handler", e);
      json(req, res, 500, rpcError(null, ERR.UPSTREAM, "internal error"));
    }
  }

  async function onBody(req, res, body) {
    let parsed;
    try { parsed = JSON.parse(body.toString("utf8")); } catch (_) { counters.refused.json++; return json(req, res, 400, rpcError(null, ERR.PARSE, "the body is not JSON")); }
    const v = checkBody(parsed, cfg);
    if (!v.ok) { counters.refused[v.counter]++; return json(req, res, v.status, v.body); }
    counters.requests.items += v.entries.length;
    if (v.batch) counters.requests.batches++;
    const local = [];
    const forward = [];
    for (const e of v.entries) {
      if (e.error) { counters.refused[e.refusal]++; local.push(e.error); } else forward.push(e);
    }
    // A batch with a refused item is refused whole. Forwarding the rest would mean holding the
    // upstream's whole answer in memory to merge the refusals in, and one request could then ask for
    // an answer big enough to exhaust the process. The site never sends batches with refused items.
    if (v.batch && local.length && forward.length) {
      const errs = forward.map((e) => rpcError(e.id, ERR.INVALID, "this batch holds a refused item, so none of it was sent; send the allowed items on their own"));
      return json(req, res, 200, [...errs, ...local]);
    }
    if (!forward.length) return json(req, res, 200, v.batch ? local : local[0]);

    const entry = table.get(clientAddress(req));
    const n = forward.length;
    const sends = forward.reduce((a, e) => a + (e.method === "sendTransaction" ? 1 : 0), 0);
    const refusal = limits.charge(entry, n, sends, Date.now());
    if (refusal) {
      counters.refused[refusal.counter]++;
      const errs = forward.map((e) => rpcError(e.id, ERR.RATE, refusal.text));
      return json(req, res, 429, v.batch ? errs : errs[0], { "Retry-After": String(refusal.wait) });
    }
    for (const e of forward) counters.methods[e.method] = (counters.methods[e.method] || 0) + 1;

    counters.requests.forwarded++;
    const out = Buffer.from(JSON.stringify(v.batch ? forward.map((e) => e.item) : forward[0].item));
    const fail = (status, text, extra = {}, code = ERR.UPSTREAM) => {
      const errs = forward.map((e) => rpcError(e.id, code, text));
      return json(req, res, status, v.batch ? errs : errs[0], extra);
    };
    let up;
    try {
      up = await upstream.post(out);
    } catch (f) {
      if (f && f.kind === "timeout") counters.upstream.timeouts++; else counters.upstream.errors++;
      log.warn("upstream " + (f && f.kind === "timeout" ? "timeout" : "error") + (f && f.error ? ": " + (f.error.code || f.error.message || "") : ""));
      return fail(502, UPSTREAM_TEXT);
    }
    if (up.statusCode !== 200) {
      counters.upstream.badStatus++;
      up.resume();
      log.warn("upstream answered " + up.statusCode);
      return fail(up.statusCode === 429 ? 429 : 502, UPSTREAM_TEXT + (up.statusCode === 429 ? " (busy)" : ""), up.statusCode === 429 ? { "Retry-After": "2" } : {});
    }
    return stream(req, res, up, entry, fail);
  }

  /// Pass the upstream's answer on as it comes. With a Content-Length (the validator sends one) an
  /// answer over the cap, or over what the byte budgets still hold, is refused cleanly before a byte
  /// goes out, and its upstream socket is cut. Without one, the bytes are counted and charged as they
  /// come, and an answer that passes the cap or the budget is cut where it is: the client sees the
  /// connection end early.
  function stream(req, res, up, entry, fail) {
    // the client went away while the upstream was asked: nothing to pass on
    if (res.destroyed || res.writableEnded) { up.destroy(); return; }
    const raw = up.headers["content-length"];
    const length = raw !== undefined && /^\d+$/.test(String(raw)) ? Number(raw) : -1;
    if (length > cfg.maxAnswerBytes) {
      counters.refused.answerSize++;
      up.destroy();
      log.warn("upstream answer of " + length + " bytes refused (the cap is " + cfg.maxAnswerBytes + ")");
      return fail(502, "the answer is over " + cfg.maxAnswerBytes + " bytes, so this proxy does not pass it on; ask for less (fewer keys, a dataSlice, filters)");
    }
    if (length >= 0) {
      const r = limits.chargeBytes(entry, length, Date.now());
      if (r) {
        counters.refused[r.counter]++;
        up.destroy();
        return fail(429, r.text, { "Retry-After": String(r.wait) }, ERR.RATE);
      }
    }
    res.writeHead(200, { ...cors(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(length >= 0 ? { "Content-Length": String(length) } : {}) });
    counters.requests.answered++;
    let sent = 0, cut = false;
    const stop = (counter, why) => {
      if (cut) return;
      cut = true;
      if (counter) counters.refused[counter]++;
      counters.answers.cut++;
      log.warn("upstream answer cut after " + sent + " bytes: " + why);
      up.destroy();
      res.destroy();
    };
    up.on("data", (chunk) => {
      if (cut) return;
      sent += chunk.length;
      if (length < 0) {
        if (sent > cfg.maxAnswerBytes) return stop("answerSize", "over the cap of " + cfg.maxAnswerBytes + " bytes");
        const r = limits.spendBytes(entry, chunk.length, Date.now());
        if (r) return stop(r.counter, "over the byte budget");
      } else if (sent > length) {
        return stop(null, "longer than its Content-Length");
      }
      if (!res.write(chunk)) { up.pause(); res.once("drain", () => up.resume()); }
    });
    up.on("end", () => {
      if (cut) return;
      counters.answers.bytes += sent;
      if (sent > counters.answers.largest) counters.answers.largest = sent;
      res.end();
    });
    up.on("error", () => { if (cut) return; cut = true; counters.upstream.errors++; res.destroy(); });
    res.on("close", () => { if (!up.complete) up.destroy(); });
  }

  return handle;
}
