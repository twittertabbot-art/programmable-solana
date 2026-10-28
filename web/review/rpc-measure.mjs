// Review tool: how many RPC calls a page of the site makes, counted by web/review/rpc-count.mjs.
//   node web/review/rpc-measure.mjs <site origin> <proxy origin> <scenario> [arguments] [--watcher <url>] [--wallet] [--json <file>]
// Scenarios:
//   coin <pool> [seconds]      the coin page: the calls of the first load, then the total after
//                              `seconds` (default 120) with the tab open and nobody trading
//   hidden <pool> [seconds]    the coin page loaded, then the tab hidden: the calls while hidden
//   explore                    Explore: the calls of the first load
//   pool <pool> [seconds]      the liquidity page: first load, then the total after `seconds`
//   trade <pool> [sol]         the coin page with a wallet that signs: the calls of one quote (the
//                              amount typed, the local quote and the simulation), then of one buy
//                              of `sol` (default 0.05) until the page has read everything again
// --log: print every call of the last step, in order, with its time. --wallet: a funded throwaway wallet is connected (made here, airdropped, never written down);
//   `trade` always has one. --watcher <url>: the page is pointed at a local watcher as well.
// The page is opened with ?rpc=<proxy origin>/<bucket of its own>, so every call it makes is
// counted in that bucket and in nothing else. "First load" ends when the page is drawn and has
// made no call for two seconds. The browser is started and closed by edge.mjs.
import { writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { startEdge } from "./edge.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf("--" + name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, v && !v.startsWith("--") ? 2 : 1); return v && !v.startsWith("--") ? v : true; };
const watcher = flag("watcher"), withWallet = !!flag("wallet"), jsonOut = flag("json"), showLog = !!flag("log");
const [origin, proxy, scenario, a1, a2] = argv;
if (!origin || !proxy || !scenario) { console.error("usage: node web/review/rpc-measure.mjs <site origin> <proxy origin> <coin|hidden|explore|pool|trade> [arguments] [--watcher <url>] [--wallet]"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bucket = scenario + "-" + Math.random().toString(36).slice(2, 8);
const counts = async () => (await fetch(proxy + "/_counts?bucket=" + bucket)).json();
const reset = () => fetch(proxy + "/_reset?bucket=" + bucket);
const conn = new Connection("http://127.0.0.1:8899", "confirmed");

let kp = null;
if (withWallet || scenario === "trade") {
  kp = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
}
const walletScript = (k) => `(() => {
  const SECRET = ${JSON.stringify(Array.from(k.secretKey))}, ADDRESS = ${JSON.stringify(k.publicKey.toBase58())};
  localStorage.setItem("Programmable.wallet", "phantom");
  const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(SECRET)); };
  const publicKey = { toBase58: () => ADDRESS };
  window.phantom = { solana: { isPhantom: true, publicKey, on() {}, disconnect: async () => {}, connect: async () => ({ publicKey }),
    signTransaction: async (tx) => { tx.sign([await key()]); return tx; },
    signAllTransactions: async (txs) => { const x = await key(); for (const t of txs) t.sign([x]); return txs; } } };
})();`;

const edge = await startEdge({ name: "rpc-" + scenario, width: 1440, height: 1100 });
let id = 0; const pending = new Map(); const events = []; const errors = [];
let ws;
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? null : r.result.value; };
const until = async (expression, ms) => { for (let t = 0; t < ms; t += 200) { if (await ev(expression)) return true; await sleep(200); } return false; };
/// Wait until the bucket has seen no call for `quietMs`, at most `maxMs`. Returns the counts then.
async function quiet(quietMs = 2000, maxMs = 15000) {
  let last = -1, since = Date.now();
  const start = Date.now();
  for (;;) {
    const c = await counts();
    const n = c.calls + Object.values(c.ws).reduce((x, y) => x + y, 0);
    if (n !== last) { last = n; since = Date.now(); }
    if (Date.now() - since >= quietMs || Date.now() - start >= maxMs) return c;
    await sleep(200);
  }
}
const short = (c) => ({ calls: c.calls, archive: c.archive, units: c.units, methods: c.methods, ws: c.ws });
const out = { scenario, bucket, watcher: watcher || "", wallet: kp ? kp.publicKey.toBase58() : "", results: {} };
const report = (name, c, extra = {}) => { out.results[name] = { ...short(c), ...extra }; console.log(name.padEnd(14) + " calls " + String(c.calls).padStart(5) + "  archive " + String(c.archive).padStart(5) + "  units " + String(c.units).padStart(5) + "  " + JSON.stringify(c.methods) + (Object.keys(c.ws).length ? "  ws " + JSON.stringify(c.ws) : "") + (Object.keys(extra).length ? "  " + JSON.stringify(extra) : "")); };

try {
  ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === "Runtime.exceptionThrown") errors.push("EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method) events.push(d.method);
  };
  await call("Page.enable"); await call("Runtime.enable");
  if (kp) await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript(kp) });
  const params = "rpc=" + encodeURIComponent(proxy + "/" + bucket) + (watcher ? "&watcher=" + encodeURIComponent(watcher) : "");
  const path = scenario === "explore" ? "/index.html?" + params : scenario === "pool" ? "/pool.html?pool=" + a1 + "&" + params : "/coin.html?pool=" + a1 + "&" + params;
  const ready = scenario === "explore" ? "!!document.querySelector('#grid .coin-card:not(.ghost)') || !document.querySelector('#empty').hidden"
    : scenario === "pool" ? "!document.querySelector('#layout').hidden && !!document.querySelector('#locked dd')"
    : "!document.querySelector('#layout').hidden && (!document.querySelector('#trades').hidden || !document.querySelector('#tradesEmpty').hidden)" + (kp ? " && !!document.querySelector('#walletBtn.on')" : "");
  await reset();
  const t0 = Date.now();
  await call("Page.navigate", { url: origin + path });
  const ok = await until(ready, 30000);
  if (!ok) console.log("not ready: " + await ev("(document.querySelector('#loadMsg') || {}).textContent || ''"));
  const first = await quiet(2000, 15000);
  report("first load", first, { ready: ok, seconds: Math.round((Date.now() - t0) / 100) / 10 });
  if (scenario === "coin" || scenario === "pool") {
    const secs = Number(a2 || 120);
    while (Date.now() - t0 < secs * 1000) await sleep(500);
    report("after " + secs + " s", await counts());
  } else if (scenario === "hidden") {
    const secs = Number(a2 || 60);
    await ev("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); true");
    await sleep(1000);
    await reset();
    await sleep(secs * 1000);
    report("hidden " + secs + " s", await counts());
    await reset();
    await ev("Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); true");
    report("shown again", await quiet(2000, 10000));
  } else if (scenario === "trade") {
    const sol = String(a2 || "0.05");
    await reset();
    await ev("(() => { const i = document.querySelector('#amount'); i.value = " + JSON.stringify(sol) + "; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    const sim = await until("!!document.querySelector('#exactOut') || /simulat/i.test((document.querySelector('#tradeCard .trade-note') || {}).textContent || '')", 20000);
    report("quote", await quiet(1500, 10000), { simulated: sim, shown: await ev("document.querySelector('#tradeCard .out .v').textContent") });
    await reset();
    await ev("document.querySelector('#tradeCard .btn-buy').click(); true");
    const done = await until("(() => { const t = document.querySelector('#tradeCard .tx-result'); return !!t && (/Bought/.test(t.textContent) || !!t.querySelector('.bad')); })()", 60000);
    report("trade", await quiet(2500, 20000), { done, said: await ev("document.querySelector('#tradeCard .tx-result').textContent") });
  }
} catch (e) {
  console.error("measure failed: " + e.message); process.exitCode = 1;
} finally {
  if (showLog) { try { const l = await (await fetch(proxy + "/_log?bucket=" + bucket + "&last=400")).json(); for (const [t, m] of l.log) console.log("  " + t.slice(11, 23) + "  " + m); } catch (_) {} }
  if (errors.length) console.log("page errors:\n  " + [...new Set(errors)].join("\n  "));
  out.errors = errors;
  console.log(await edge.close());
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2) + "\n");
}
