// End to end on the local chain: the site's browser flows, with every read and every transaction of
// the pages going through the proxy.
//
//   node rpc-proxy/test/e2e-local.mjs [--site http://localhost:8787] [--port 8797] [--standin 8799] [--load] [-- <command>]
//   node rpc-proxy/test/e2e-local.mjs --load -- node web/review/flow-launch.mjs ORIGIN out/e2e-launch C,P
//   RATE_BURST=240 node rpc-proxy/test/e2e-local.mjs -- node web/review/flow-collectible.mjs ORIGIN <pool> out/e2e-col
//
// The proxy's settings can be given in the environment (RATE_BURST and the like); the rest are its
// defaults. flow-collectible buys, withdraws, sells and withdraws on one page within half a minute, with
// the site's watcher feed off on the local chain: about 140 requests, more than the default burst of 120
// and its refill in that time, so its last reads meet 429. A person is slower; the run takes RATE_BURST=240.
//
// It starts the proxy (UPSTREAM_RPC http://127.0.0.1:8899, so its WebSocket goes to the validator's
// 8900) on --port with WS_PORT the port plus one, and a stand-in of the site on --standin: every
// request is passed to the real site at --site, except two files. GET /deployments/localnet.json
// comes back with `rpc` set to http://127.0.0.1:<port>/rpc, and GET /config.js with `rpc: ""` (a
// value in config.js wins over the deployments file, as on the live site). Nothing in web/ is
// edited. The pages then read the chain through the proxy at a path, as the live site will
// (https://<host>/rpc), and web3.js derives the WebSocket address with the port plus one, which
// WS_PORT takes.
// Then it runs the command (the word ORIGIN replaced by the stand-in's address), checks on the
// proxy's counters that the pages' reads, transactions and WebSocket went through it, prints the
// counters and stops the proxy by its process id. With --load it first sends 500 requests from one
// address while another address keeps reading, and reports both. Without a command it waits for
// Ctrl+C. Exit code: the command's, or 1 when a check here failed.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dash = args.indexOf("--");
const own = dash >= 0 ? args.slice(0, dash) : args;
const command = dash >= 0 ? args.slice(dash + 1) : [];
const opt = (name, dflt) => { const i = own.indexOf("--" + name); return i >= 0 && own[i + 1] ? own[i + 1] : dflt; };
const SITE = String(opt("site", "http://localhost:8787")).replace(/\/+$/, "");
const PORT = Number(opt("port", "8797"));
const STANDIN = Number(opt("standin", "8799"));
const LOAD = own.includes("--load");
const PROXY_DIR = fileURLToPath(new URL("../", import.meta.url));
const RPC = "http://127.0.0.1:" + PORT + "/rpc";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the proxy ------------------------------------------------------------------------------------------
// the pages come from the stand-in, so their Origin is the stand-in's: the proxy serves that one only
const proxy = spawn(process.execPath, ["index.mjs"], {
  cwd: PROXY_DIR, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, UPSTREAM_RPC: "http://127.0.0.1:8899", UPSTREAM_WS: "", PORT: String(PORT), WS_PORT: String(PORT + 1), HOST: "127.0.0.1", SUMMARY_EVERY_SECONDS: "0", ALLOWED_ORIGINS: "http://127.0.0.1:" + STANDIN + ",http://localhost:" + STANDIN },
});
const proxyLines = [];
for (const s of [proxy.stdout, proxy.stderr]) s.on("data", (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) { proxyLines.push(l); console.log("  [proxy] " + l); } });
let up = false;
for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch("http://127.0.0.1:" + PORT + "/health")).ok; } catch (_) {} if (!up) await sleep(100); }
if (!up) { console.error("the proxy did not come up on " + PORT); proxy.kill(); process.exit(1); }
console.log("proxy on " + RPC + " (WebSocket on " + (PORT + 1) + "), process " + proxy.pid);

// ---- the stand-in site ----------------------------------------------------------------------------------
const site = new URL(SITE);
const standin = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/deployments/localnet.json") {
    fetch(SITE + "/deployments/localnet.json", { cache: "no-store" }).then(async (r) => {
      const d = await r.json();
      d.rpc = RPC;
      const body = JSON.stringify(d, null, 2);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
      res.end(body);
    }).catch((e) => { res.writeHead(502, { "content-type": "text/plain" }); res.end("site unreachable: " + e.message); });
    return;
  }
  if (req.method === "GET" && u.pathname === "/config.js") {
    fetch(SITE + "/config.js", { cache: "no-store" }).then(async (r) => {
      const text = (await r.text()).replace(/\brpc:\s*"[^"]*"/, 'rpc: ""');
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
      res.end(text);
    }).catch((e) => { res.writeHead(502, { "content-type": "text/plain" }); res.end("site unreachable: " + e.message); });
    return;
  }
  const headers = { ...req.headers, host: site.host };
  const fwd = http.request({ hostname: site.hostname, port: site.port || 80, path: req.url, method: req.method, headers }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  fwd.on("error", (e) => { if (!res.headersSent) { res.writeHead(502, { "content-type": "text/plain" }); res.end("site unreachable: " + e.message); } });
  req.pipe(fwd);
});
await new Promise((r) => standin.listen(STANDIN, "127.0.0.1", r));
const ORIGIN = "http://127.0.0.1:" + STANDIN;
const dep = await (await fetch(ORIGIN + "/deployments/localnet.json")).json();
const confRpc = (/\brpc:\s*"([^"]*)"/.exec(await (await fetch(ORIGIN + "/config.js")).text()) || [])[1];
console.log("site stand-in on " + ORIGIN + " -> " + SITE + ", deployments/localnet.json says rpc " + dep.rpc + ", config.js says rpc \"" + confRpc + "\"");
if (dep.rpc !== RPC || confRpc !== "") { console.error("the stand-in does not point the pages at the proxy"); proxy.kill(); process.exit(1); }
const health = async () => (await fetch("http://127.0.0.1:" + PORT + "/health")).json();

// ---- the load check -------------------------------------------------------------------------------------
async function load() {
  const post = (id, xff) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "getSlot" }) }).then((r) => r.status).catch(() => 0);
  let ok = 0, refused = 0, other = 0;
  const siteStatuses = [];
  const siteRun = (async () => { for (let i = 0; i < 40; i++) { siteStatuses.push(await post("s" + i, "203.0.113.51")); await sleep(100); } })();
  const t0 = Date.now();
  await Promise.all([...Array(10).keys()].map(async (k) => { for (let i = 0; i < 50; i++) { const s = await post(k * 50 + i, "203.0.113.50"); if (s === 200) ok++; else if (s === 429) refused++; else other++; } }));
  const took = Date.now() - t0;
  await siteRun;
  const siteOk = siteStatuses.filter((s) => s === 200).length;
  console.log("load: 500 requests from one address in " + took + " ms: " + ok + " answered, " + refused + " refused with 429, " + other + " other; the other address: " + siteOk + " of 40 answered");
  // the burst passes, then what refills while the flood lasts (the proxy's own limits, from /health)
  const lim = (await health()).limits;
  const most = Math.min(500, lim.burst + Math.ceil(lim.perMinute * took / 60000) + 2);
  const pass = ok >= Math.min(500, lim.burst) && ok <= most && ok + refused === 500 && other === 0 && siteOk === 40;
  console.log((pass ? "  ok    " : "  FAIL  ") + "the flood hit the limit and the other address kept answering");
  return pass;
}

// ---- run --------------------------------------------------------------------------------------------------
let code = 0;
let loadPass = true, pagesPass = true;
try {
  if (LOAD) loadPass = await load();
  if (command.length) {
    const before = await health();
    const argv = command.map((a) => a.split("ORIGIN").join(ORIGIN));
    console.log("running: " + argv.join(" "));
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", shell: process.platform === "win32" && !/node(\.exe)?$/i.test(argv[0]) });
    code = await new Promise((r) => child.on("exit", (c) => r(c === null ? 1 : c)));
    // what the pages did through the proxy while the command ran
    const after = await health();
    const d = (path) => path.split(".").reduce((o, k) => (o ? o[k] : undefined), after) - (path.split(".").reduce((o, k) => (o ? o[k] : undefined), before) || 0);
    const methods = Object.fromEntries(Object.keys(after.methods).map((m) => [m, after.methods[m] - (before.methods[m] || 0)]).filter(([, n]) => n > 0));
    const sends = methods.sendTransaction || 0, subs = d("ws.methods.signatureSubscribe") || 0;
    console.log("pages through the proxy: " + d("requests.forwarded") + " requests forwarded, " + sends + " transactions sent, " + d("ws.total") + " websocket connections, " + subs + " signature subscriptions, refused: rate " + d("refused.rate") + ", sendTransaction " + d("refused.rateSend") + ", method " + d("refused.method") + ", upstream failures " + (d("upstream.errors") + d("upstream.timeouts") + d("upstream.badStatus")));
    console.log("pages' methods: " + JSON.stringify(methods));
    pagesPass = d("requests.forwarded") > 0 && sends > 0 && d("ws.total") > 0 && subs > 0 && d("upstream.errors") + d("upstream.timeouts") + d("upstream.badStatus") === 0;
    console.log((pagesPass ? "  ok    " : "  FAIL  ") + "the pages read, sent and confirmed through the proxy, and the upstream never failed");
  } else {
    console.log("waiting (Ctrl+C stops the proxy and the stand-in)");
    await new Promise((r) => { process.on("SIGINT", r); process.on("SIGTERM", r); });
  }
} finally {
  try {
    const h = await health();
    console.log("proxy counters: requests " + JSON.stringify(h.requests) + ", refused " + JSON.stringify(h.refused) + ", upstream " + JSON.stringify(h.upstream));
    console.log("proxy answers: " + JSON.stringify(h.answers) + " (the largest single answer in bytes; the cap is " + h.limits.answerBytes + ")");
    console.log("proxy methods: " + JSON.stringify(h.methods));
    console.log("proxy websocket: " + JSON.stringify(h.ws));
  } catch (_) {}
  proxy.kill();
  standin.close();
  await sleep(200);
}
if (!loadPass || !pagesPass) code = code || 1;
process.exit(code);
