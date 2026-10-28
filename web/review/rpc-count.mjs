// Review tool: a JSON-RPC proxy that counts what a page, a script or the watcher asks of the RPC.
//   node web/review/rpc-count.mjs [--port 8898] [--upstream http://127.0.0.1:8899] [--ws-upstream ws://127.0.0.1:8900] [--verbose]
// Every POST is passed on to the upstream RPC unchanged and its answer is passed back. Before that
// it is counted: one call per request, and one call per item of a batch (web3.js sends
// getTransactions as one batch of getTransaction items). Methods that a paid plan bills as archive
// calls (getTransaction, getSignaturesForAddress, getBlock and the like) are counted apart and
// cost two request units, every other method one.
//
// Buckets: the first part of the path names a bucket, so several clients can share one proxy and
// be counted apart. A page pointed at http://127.0.0.1:8898/site is counted in "site", the watcher
// pointed at http://127.0.0.1:8898/watcher in "watcher". A request to "/" is counted in "default".
// The bucket is only a label: every request goes to the upstream's root.
//
// WebSocket: an upgrade on the same port and path is passed through to the upstream's WebSocket
// port (the RPC port plus one on a local validator). Subscriptions are counted apart, under "ws".
// web3.js derives a WebSocket address from the RPC address with the port plus one. For a proxy on
// 8898 that is 8899, the validator's own HTTP port, which takes no WebSocket. So a client of this
// proxy passes its WebSocket address itself (the site does so when it is pointed here, see below).
// With --side-ws the proxy also listens on its port plus one (never on the upstream's own port).
//
// Reading and resetting the counts (plain GET, any browser or curl):
//   GET /_counts                 every bucket
//   GET /_counts?bucket=site     one bucket
//   GET /_reset?bucket=site      zero one bucket (/_reset alone zeroes all)
//   GET /_log?bucket=site&last=100   the last calls of a bucket, with the time of each
//
// Pointing the site at it (localnet only): open any page with ?rpc=http://127.0.0.1:8898/site.
// common.js honours ?rpc= only when the cluster is localnet and the address is on this machine
// (127.0.0.1 or localhost). The same holds for ?watcher=<address of a local watcher>.
//
// Nothing here writes a file. Stop it with Ctrl+C, or by the process id it prints.
import http from "node:http";
import net from "node:net";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf("--" + name); if (i >= 0 && args[i + 1]) return args[i + 1]; const eq = args.find((a) => a.startsWith("--" + name + "=")); return eq ? eq.slice(name.length + 3) : dflt; };
const PORT = Number(opt("port", process.env.PORT || "8898"));
const UPSTREAM = new URL(opt("upstream", process.env.UPSTREAM || "http://127.0.0.1:8899"));
const WS_UPSTREAM = new URL(opt("ws-upstream", process.env.WS_UPSTREAM || "ws://" + UPSTREAM.hostname + ":" + (Number(UPSTREAM.port || 80) + 1)));
const VERBOSE = args.includes("--verbose") || args.includes("-v");

/// Methods a paid plan bills as archive calls: two request units each.
export const ARCHIVE = new Set([
  "getTransaction", "getSignaturesForAddress", "getBlock", "getBlocks", "getBlocksWithLimit", "getBlockTime", "getBlockCommitment",
  "getConfirmedTransaction", "getConfirmedSignaturesForAddress2", "getConfirmedBlock", "getConfirmedBlocks", "getConfirmedBlocksWithLimit", "getInflationReward",
]);

const buckets = new Map();
function bucket(name) {
  let b = buckets.get(name);
  if (!b) { b = fresh(); buckets.set(name, b); }
  return b;
}
function fresh() { return { since: new Date().toISOString(), calls: 0, archive: 0, units: 0, requests: 0, batches: 0, methods: {}, ws: {}, wsConnections: 0, log: [] }; }
function count(b, method, via) {
  const m = String(method || "?");
  if (via === "ws") { b.ws[m] = (b.ws[m] || 0) + 1; }
  else {
    b.calls++; b.methods[m] = (b.methods[m] || 0) + 1;
    if (ARCHIVE.has(m)) { b.archive++; b.units += 2; } else b.units += 1;
  }
  b.log.push([Date.now(), (via === "ws" ? "ws:" : "") + m]);
  if (b.log.length > 5000) b.log.splice(0, b.log.length - 5000);
}
const nameOf = (url) => { const p = String(url || "/").split("?")[0].split("/").filter(Boolean)[0]; return p && !p.startsWith("_") ? p.slice(0, 40) : "default"; };
function view(name, b) {
  const sorted = Object.fromEntries(Object.entries(b.methods).sort((x, y) => y[1] - x[1]));
  return { bucket: name, since: b.since, calls: b.calls, archive: b.archive, units: b.units, requests: b.requests, batches: b.batches, methods: sorted, ws: b.ws, wsConnections: b.wsConnections };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "600" };
function json(res, status, body) { res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body, null, 2) + "\n"); }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === "GET" && u.pathname === "/_counts") {
    const one = u.searchParams.get("bucket");
    if (one) return json(res, 200, view(one, bucket(one)));
    return json(res, 200, Object.fromEntries([...buckets].map(([k, b]) => [k, view(k, b)])));
  }
  if ((req.method === "GET" || req.method === "POST") && u.pathname === "/_reset") {
    const one = u.searchParams.get("bucket");
    if (one) buckets.set(one, fresh()); else buckets.clear();
    return json(res, 200, { reset: one || "all", at: new Date().toISOString() });
  }
  if (req.method === "GET" && u.pathname === "/_log") {
    const one = u.searchParams.get("bucket") || "default", last = Math.max(1, Math.min(5000, Number(u.searchParams.get("last") || 200)));
    const b = bucket(one);
    return json(res, 200, { bucket: one, log: b.log.slice(-last).map(([t, m]) => [new Date(t).toISOString(), m]) });
  }
  if (req.method !== "POST") return json(res, 404, { error: "POST JSON-RPC to /<bucket>, or GET /_counts, /_reset, /_log" });
  const name = nameOf(req.url);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const b = bucket(name);
    b.requests++;
    try {
      const j = JSON.parse(body.toString("utf8"));
      if (Array.isArray(j)) { b.batches++; for (const item of j) count(b, item && item.method, "http"); if (VERBOSE) console.log(name + "  batch of " + j.length + ": " + [...new Set(j.map((x) => x && x.method))].join(", ")); }
      else { count(b, j && j.method, "http"); if (VERBOSE) console.log(name + "  " + (j && j.method)); }
    } catch (_) { count(b, "unparsable", "http"); }
    const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": body.length } }, (r) => {
      res.writeHead(r.statusCode || 502, { ...CORS, "Content-Type": r.headers["content-type"] || "application/json" });
      r.pipe(res);
    });
    up.on("error", (e) => json(res, 502, { jsonrpc: "2.0", error: { code: -32000, message: "the upstream RPC did not answer: " + e.message }, id: null }));
    up.end(body);
  });
});

/// Count the text frames a WebSocket client sends (client frames are masked), without touching the bytes.
function frameCounter(onText) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)];
      if (op === 1) onText(payload.toString("utf8"));
      buf = buf.subarray(off + len);
    }
  };
}
function upgrade(req, socket, head) {
  const name = nameOf(req.url);
  const b = bucket(name);
  b.wsConnections++;
  const up = net.connect(Number(WS_UPSTREAM.port || 80), WS_UPSTREAM.hostname, () => {
    const lines = ["GET / HTTP/1.1"];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], v = req.rawHeaders[i + 1];
      lines.push(k.toLowerCase() === "host" ? "Host: " + WS_UPSTREAM.host : k + ": " + v);
    }
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    const counter = frameCounter((text) => {
      try { const j = JSON.parse(text); for (const item of Array.isArray(j) ? j : [j]) count(b, item && item.method, "ws"); } catch (_) {}
    });
    if (head && head.length) counter(head);
    socket.on("data", (d) => { counter(d); up.write(d); });
    up.pipe(socket);
  });
  const end = () => { socket.destroy(); up.destroy(); };
  up.on("error", end); socket.on("error", end); up.on("close", end); socket.on("close", end);
}
server.on("upgrade", upgrade);
server.listen(PORT, "127.0.0.1", () => {
  console.log("rpc-count: http://127.0.0.1:" + PORT + "/<bucket> -> " + UPSTREAM.origin + " (WebSocket -> " + WS_UPSTREAM.host + "), process " + process.pid);
  console.log("rpc-count: GET /_counts, /_reset?bucket=<name>, /_log?bucket=<name>");
});
// --side-ws: also take WebSockets on the port plus one, for clients that derive their WebSocket
// address from the RPC address. Off by default, and refused when that port is the upstream's own:
// on 8898 the port plus one is the validator's 8899, which must never be shadowed.
if (args.includes("--side-ws")) {
  if (PORT + 1 === Number(UPSTREAM.port || 80)) console.log("rpc-count: --side-ws ignored, " + (PORT + 1) + " is the upstream's own port");
  else {
    const side = http.createServer((req, res) => { res.writeHead(426, CORS); res.end(); });
    side.on("upgrade", upgrade);
    side.on("error", (e) => console.log("rpc-count: no WebSocket on " + (PORT + 1) + ": " + e.message));
    side.listen(PORT + 1, "127.0.0.1", () => console.log("rpc-count: WebSocket also on " + (PORT + 1)));
  }
}
