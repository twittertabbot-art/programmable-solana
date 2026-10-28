// Review tool: the LIVE site, every function a visitor can reach, without ever sending a transaction.
//   node web/review/flow-live-dry.mjs <site origin> [out folder] [parts]
//   node web/review/flow-live-dry.mjs https://programmableonsol.com
// Against a local server and the local validator (never the live site with these):
//   DRY_CLUSTER=localnet DRY_MARKET=http://127.0.0.1:8791/market.json DRY_UPLOADS=0 node web/review/flow-live-dry.mjs http://localhost:8797 <out>
// DRY_CLUSTER names the deployment file and the cluster the pages must name (default mainnet). DRY_MARKET is the
// market.json the tool picks its coins from (default the site's /watcher/market.json; web/review/feed-standin.mjs
// serves one for a site without a watcher). Checks of the live platform's own numbers (0.3%, 8.5 SOL) then fail on a
// chain whose platform differs.
//
// What keeps it dry:
// - The stand-in wallet is a public address only (STANDIN below, or DRY_WALLET=<address>). It has no
//   key. signTransaction, signAllTransactions, signAndSendTransaction, signMessage and request ALWAYS
//   throw { code: 4001, "User rejected the request." }. No keypair file is read anywhere.
// - Every request of the page to the site's RPC passes through the DevTools Fetch domain. A body that
//   names sendTransaction (or requestAirdrop), or a body that cannot be read, is failed before it
//   leaves the browser, and counted. The tool itself never calls sendTransaction.
// - POST /api/metadata (the launch form's upload, rate limited and stored on the server) is let
//   through at most DRY_UPLOADS times (default 1). Further uploads are failed in the browser.
//   The other launches fill the form's own "Metadata file" field with an address the site serves.
// - At most DRY_LAUNCHES (default 4) launches are taken to the wallet prompt.
// - The trade API is asked GET /api/v1/quote and POST /api/v1/swap with simulate: true only.
//
// Parts (default all): P page sweep (every page at 1440 and 375, with and without the wallet,
// screenshots, sideways scroll, console and network), H header/menu/footer, E Explore, C coin pages,
// R reload with a remembered wallet, L liquidity, N launch chooser, M Module Mode, K Collectible,
// X Custom hook, Q Hook checker, W Custom hooks pages, D Docs, A trade API and watcher files.
// One line per check: "  PASS  ..." or "  FAIL  ...". out folder/summary.json holds everything.
// The browser is started and closed by edge.mjs (its own profile, closed through its own port).
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { startEdge } from "./edge.mjs";

const [originArg, outArg, partsArg = "all"] = process.argv.slice(2);
if (!originArg) { console.error("usage: node web/review/flow-live-dry.mjs <site origin> [out folder] [parts]"); process.exit(2); }
const origin = originArg.replace(/\/+$/, "");
const OUT = path.resolve(outArg || path.join(process.env.TEMP || os.tmpdir(), "programmable-livedry"));
mkdirSync(OUT, { recursive: true });
const PARTS = ["P", "H", "E", "C", "R", "L", "N", "M", "K", "X", "Q", "W", "D", "A"];
const wanted = partsArg === "all" ? PARTS : partsArg.split(",").map((s) => s.trim().toUpperCase());
for (const w of wanted) if (!PARTS.includes(w)) { console.error("unknown part " + w + ". Parts: " + PARTS.join(", ")); process.exit(2); }
const want = (p) => wanted.includes(p);
const STANDIN = process.env.DRY_WALLET || "4MF4aDGyfnYuRdPMiVw9EFqgBTKz7EgVnVuHpUChqj7w";
let uploadsLeft = Number(process.env.DRY_UPLOADS ?? 1);
let launchesLeft = Number(process.env.DRY_LAUNCHES ?? 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);

// ---- results ------------------------------------------------------------------------------------------
let part = "-";
const results = [];
function check(ok, name, detail) {
  results.push({ part, ok: !!ok, name, detail: detail === undefined ? "" : typeof detail === "string" ? detail : JSON.stringify(detail) });
  console.log((ok ? "  PASS  " : "  FAIL  ") + "[" + part + "] " + name + (detail !== undefined && detail !== "" ? "  -- " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""));
  return !!ok;
}
const notes = [];
function note(text) { notes.push({ part, text }); console.log("        note: " + text); }

// ---- the site's facts, read before the browser starts ------------------------------------------------
const getJson = async (url, opts) => { const r = await fetch(url, opts); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j, text: t, headers: r.headers }; };
const CLUSTER = process.env.DRY_CLUSTER || "mainnet";
const MARKET_URL = process.env.DRY_MARKET || origin + "/watcher/market.json";
const deployment = (await getJson(origin + "/deployments/" + CLUSTER + ".json")).json || {};
const RPC = deployment.rpc || "";
const RPC_HOST = RPC ? new URL(RPC).host : "";
const market0 = (await getJson(MARKET_URL)).json || { pools: [] };
const byName = (n) => market0.pools.find((p) => p.coin && p.coin.name === n);
const A = byName("Programmable Test A") || market0.pools.find((p) => p.curveState === "open") || null;
const B = byName("Programmable Test B") || market0.pools.find((p) => p.curveState === "graduated") || null;
const C3 = byName("Programmable Test C") || null;
const COINS = [["A", A], ["B", B], ["C", C3]].filter(([, p]) => p);
// a metadata file the site already serves: the launches that must not upload point the form's Metadata file field at it
const META_URL = (A && A.coin && A.coin.uri) || (B && B.coin && B.coin.uri) || "";
console.log("site " + origin + ", RPC host " + RPC_HOST + ", stand-in wallet " + STANDIN + ", out " + OUT);
console.log("coins: " + COINS.map(([k, p]) => k + " " + p.coin.name + " " + p.address + " (" + p.curveState + ")").join("; "));

// a small PNG made here, for the image field
function makePng(w, h) {
  const table = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 255 / w) | 0; raw[o + 1] = (y * 255 / h) | 0; raw[o + 2] = 140; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG_PATH = path.join(OUT, "dry-pick.png");
writeFileSync(PNG_PATH, makePng(48, 48));

// ---- the browser --------------------------------------------------------------------------------------
const edge = await startEdge({ name: "livedry", width: 1440, height: 1000 });
let ws = null, id = 0, where = "about:blank", leaving = 0, curView = 1440;
const pending = new Map(), events = [], issues = [], warnings = [], reqs = new Map();
const rpcLog = []; // { where, methods }
const uploads = []; // { where, status }
let sendBlocked = 0, unreadableBlocked = 0, uploadsRefused = 0;
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); return r.result.value; };
const evSafe = async (expression, fallback = null) => { try { return await ev(expression); } catch (_) { return fallback; } };
const until = async (expression, ms = 20000, step = 150) => { for (let t = 0; t < ms; t += step) { if (await evSafe(expression, false)) return true; await sleep(step); } return false; };
const T = (sel) => evSafe("window.__dry.t(" + q(sel) + ")");
const TS = (sel) => evSafe("window.__dry.ts(" + q(sel) + ")", []);
const VIS = (sel) => evSafe("window.__dry.vis(" + q(sel) + ")", false);
const KV = (sel) => evSafe("window.__dry.kv(" + q(sel) + ")", {});
const prompts = () => evSafe("window.__signPrompts || 0", 0);
const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return ""; } };
/// A Solscan link of this cluster: the plain address on mainnet, with its cluster parameter elsewhere.
const solscanIs = (u, kind, value) => (CLUSTER === "mainnet" ? u === "https://solscan.io/" + kind + "/" + value : String(u).startsWith("https://solscan.io/" + kind + "/" + value + "?cluster="));

function onPaused(p) {
  const r = p.request || {};
  let body = r.postData || "";
  if (!body && Array.isArray(r.postDataEntries)) body = r.postDataEntries.map((e) => Buffer.from(e.bytes || "", "base64").toString("utf8")).join("");
  const done = (m, params) => call(m, { requestId: p.requestId, ...params }).catch(() => {});
  if (/\/api\/metadata(\?|$)/.test(r.url) && r.method === "POST") {
    if (uploadsLeft <= 0) { uploadsRefused++; uploads.push({ where, status: "refused here" }); return done("Fetch.failRequest", { errorReason: "BlockedByClient" }); }
    uploadsLeft--; uploads.push({ where, status: "sent" });
    return done("Fetch.continueRequest");
  }
  if (r.method === "POST" && hostOf(r.url) === RPC_HOST) {
    if (r.hasPostData && !body) { unreadableBlocked++; issues.push({ where, kind: "blocked", text: "an RPC request whose body could not be read was blocked", url: r.url }); return done("Fetch.failRequest", { errorReason: "BlockedByClient" }); }
    if (/sendTransaction|sendRawTransaction|requestAirdrop/.test(body)) { sendBlocked++; issues.push({ where, kind: "blocked", text: "the page tried to SEND a transaction; blocked in the browser", url: r.url }); return done("Fetch.failRequest", { errorReason: "BlockedByClient" }); }
    try { const j = JSON.parse(body); const list = Array.isArray(j) ? j : [j]; rpcLog.push({ where, methods: list.map((x) => x.method) }); } catch (_) {}
  }
  return done("Fetch.continueRequest");
}

const WALLET_SCRIPT = `(() => {
  window.__dry = {
    t: (s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\\s+/g, " ").trim() : null; },
    ts: (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.replace(/\\s+/g, " ").trim()),
    vis: (s) => { const e = document.querySelector(s); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden" && !e.closest("[hidden]"); },
    kv: (s) => { const o = {}; const d = document.querySelector(s); if (!d) return o; const dt = [...d.querySelectorAll("dt")], dd = [...d.querySelectorAll("dd")]; dt.forEach((t, i) => { o[(t.firstChild ? t.firstChild.textContent : t.textContent).trim()] = dd[i] ? dd[i].textContent.trim() : ""; }); return o; },
    toasts: () => [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent.trim()),
  };
  window.__signPrompts = 0; window.__prompts = [];
  let mode = "off", remember = "1", delay = 0;
  try { mode = localStorage.getItem("__dry_wallet") || "off"; remember = localStorage.getItem("__dry_remember") || "1"; delay = Number(localStorage.getItem("__dry_delay") || 0); } catch (_) {}
  if (mode !== "on") { try { localStorage.removeItem("Programmable.wallet"); } catch (_) {} return; }
  try { if (remember === "1") localStorage.setItem("Programmable.wallet", "phantom"); else localStorage.removeItem("Programmable.wallet"); } catch (_) {}
  const ADDRESS = ${JSON.stringify(STANDIN)};
  const publicKey = { toBase58: () => ADDRESS, toString: () => ADDRESS };
  // no key: every request to sign is refused, the way a wallet answers when its user closes the prompt
  const refuse = (what) => async () => { window.__signPrompts++; window.__prompts.push([what, Date.now()]); throw Object.assign(new Error("User rejected the request."), { code: 4001 }); };
  const w = { isPhantom: true, publicKey: null, isConnected: false, on() {}, off() {}, removeListener() {},
    connect: async (opts) => { if (opts && opts.onlyIfTrusted && delay > 0) await new Promise((r) => setTimeout(r, delay)); w.publicKey = publicKey; w.isConnected = true; window.__connectedAt = Date.now(); return { publicKey }; },
    disconnect: async () => { w.publicKey = null; w.isConnected = false; },
    signTransaction: refuse("signTransaction"), signAllTransactions: refuse("signAllTransactions"), signAndSendTransaction: refuse("signAndSendTransaction"), signMessage: refuse("signMessage"), request: refuse("request") };
  window.phantom = { solana: w };
})();`;

{
  ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); return; }
    const P = d.params || {};
    if (d.method === "Fetch.requestPaused") return onPaused(P);
    if (d.method === "Runtime.exceptionThrown") issues.push({ where, kind: "exception", text: (P.exceptionDetails.exception && P.exceptionDetails.exception.description) || P.exceptionDetails.text, url: P.exceptionDetails.url || "" });
    else if (d.method === "Runtime.consoleAPICalled" && (P.type === "error" || P.type === "assert")) issues.push({ where, kind: "console.error", text: P.args.map((a) => a.value !== undefined ? String(a.value) : a.description || "").join(" "), url: (P.stackTrace && P.stackTrace.callFrames[0] && P.stackTrace.callFrames[0].url) || "" });
    else if (d.method === "Runtime.consoleAPICalled" && P.type === "warning") warnings.push({ where, text: P.args.map((a) => a.value !== undefined ? String(a.value) : a.description || "").join(" ") });
    else if (d.method === "Log.entryAdded" && P.entry && P.entry.level === "error") issues.push({ where, kind: "log", text: P.entry.text, url: P.entry.url || "" });
    else if (d.method === "Network.requestWillBeSent") reqs.set(P.requestId, { url: P.request.url, method: P.request.method, type: P.type, where });
    else if (d.method === "Network.responseReceived") {
      const r = reqs.get(P.requestId) || {};
      if (P.response.status >= 400) issues.push({ where, kind: "http " + P.response.status, text: (r.method || "") + " " + P.response.url, url: P.response.url });
      if (/\/api\/metadata/.test(P.response.url)) { const u = uploads[uploads.length - 1]; if (u) u.answer = P.response.status; }
    } else if (d.method === "Network.loadingFailed") {
      const r = reqs.get(P.requestId) || {};
      // a request cut by the tool's own navigation is not the page's fault
      if (P.canceled && Date.now() - leaving < 4000) return;
      if (P.errorText === "net::ERR_BLOCKED_BY_CLIENT") return; // the dry guard above
      issues.push({ where: r.where || where, kind: P.canceled ? "canceled" : "network", text: P.errorText + " " + (r.method || "") + " " + (r.url || ""), url: r.url || "" });
    } else if (d.method) events.push(d.method);
  };
  await call("Page.enable"); await call("Runtime.enable"); await call("Network.enable"); await call("Log.enable"); await call("DOM.enable");
  await call("Fetch.enable", { patterns: [...(RPC_HOST ? [{ urlPattern: "*://" + RPC_HOST + "/*", requestStage: "Request" }] : []), { urlPattern: "*/api/metadata*", requestStage: "Request" }] });
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
  await call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: OUT }).catch(() => {});
  await call("Page.addScriptToEvaluateOnNewDocument", { source: WALLET_SCRIPT });
}
const waitLoad = async () => { for (let i = 0; i < 250 && !events.includes("Page.loadEventFired"); i++) await sleep(100); };
let onOrigin = false;
/// Open a page of the site. wallet "on" injects the stand-in (remembered by the site unless remember is false),
/// "off" leaves the browser without any wallet. Returns true when `ready` held within `ms`.
async function go(pagePath, ready, { wallet = "off", remember = true, delay = 0, ms = 25000 } = {}) {
  if (!onOrigin) { where = "(tool) deployment file"; events.length = 0; leaving = Date.now(); await call("Page.navigate", { url: origin + "/deployments/" + CLUSTER + ".json" }); await waitLoad(); onOrigin = true; }
  await evSafe("localStorage.setItem('__dry_wallet', " + q(wallet) + "); localStorage.setItem('__dry_remember', " + q(remember ? "1" : "0") + "); localStorage.setItem('__dry_delay', " + q(String(delay)) + "); true");
  where = pagePath + " @" + curView + (wallet === "on" ? " +wallet" : "");
  events.length = 0; leaving = Date.now();
  await call("Page.navigate", { url: origin + "/" + pagePath });
  await waitLoad();
  const ok = await until(ready, ms);
  return ok;
}
async function view(width) {
  curView = width;
  const height = width < 600 ? 812 : 1000;
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setTouchEmulationEnabled", { enabled: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(300);
}
const shots = [];
async function shot(name, full = true) {
  let params = { format: "png" };
  if (full) {
    const m = await call("Page.getLayoutMetrics");
    params = { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.min(m.cssContentSize.width, 2000), height: Math.min(m.cssContentSize.height, 7000), scale: 1 } };
  }
  try {
    const s = await call("Page.captureScreenshot", params);
    const file = path.join(OUT, name.replace(/[^a-z0-9._-]+/gi, "-") + ".png");
    writeFileSync(file, Buffer.from(s.data, "base64")); shots.push(file);
  } catch (e) { note("screenshot " + name + " failed: " + e.message); }
}
const mouse = (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const clearToasts = async () => { await evSafe("(() => { for (const t of document.querySelectorAll('#toasts .toast')) t.remove(); return true; })()"); await sleep(100); };
/// A real click in the middle of an element, after bringing it into view.
async function click(selector) {
  const at = () => evSafe("(() => { const e = document.querySelector(" + q(selector) + "); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width, b.height]; })()");
  if (!(await at())) throw new Error("nothing matches " + selector);
  for (let attempt = 0; ; attempt++) {
    await ev("document.querySelector(" + q(selector) + ").scrollIntoView({ block: 'center' }); true");
    await sleep(120);
    const [x, y, w, h] = await at();
    if (!(w > 0 && h > 0)) throw new Error(selector + " is not drawn");
    const top = await ev("(() => { const e = document.elementFromPoint(" + x + ", " + y + "); const want = document.querySelector(" + q(selector) + "); return !!e && (e === want || want.contains(e) || (want.tagName === 'LABEL' && e.closest('label') === want)); })()");
    if (top) { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); await sleep(80); return; }
    if (attempt > 0) throw new Error("something covers " + selector);
    await clearToasts();
  }
}
const tryClick = async (selector) => { try { await click(selector); return true; } catch (e) { note("click " + selector + ": " + e.message); return false; } };
/// Click a field, clear it, type into it the way a keyboard would.
async function type(selector, text) {
  await click(selector);
  await ev("(() => { const e = document.querySelector(" + q(selector) + "); e.focus(); if (e.select) e.select(); return true; })()");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  if (text) await call("Input.insertText", { text });
  await sleep(250);
}
const key = async (k, code, vk) => { await call("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk }); await call("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk }); await sleep(200); };
const fmt = (fn, ...args) => evSafe("(async () => { const c = await import('/common.js'); return c." + fn + "(" + args.map((a) => (typeof a === "bigint" ? a + "n" : JSON.stringify(a))).join(", ") + "); })()");
const overflow = () => evSafe("document.documentElement.scrollWidth <= window.innerWidth + 1", true);
const smallTargets = () => evSafe("[...document.querySelectorAll('button, a.btn, input:not([type=file]):not([type=radio]):not([type=checkbox]):not([type=range]), select, textarea, summary, a.menu-item, .site-nav a, .site-mark')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.height < 44 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden]'); }).map((e) => (e.id || e.className || e.tagName).toString().slice(0, 40) + ' ' + Math.round(e.getBoundingClientRect().height))", []);
const issuesSince = (n) => issues.slice(n);
/// The wallet's refusal sentence the site uses everywhere (common.js WALLET_NO).
const WALLET_NO = "The wallet did not sign. Nothing was sent.";
const bigText = (s) => { const m = /-?\d[\d,]*(?:\.\d+)?/.exec(String(s || "")); return m ? Number(m[0].replace(/,/g, "")) : NaN; };

const READY = {
  index: "(!!document.querySelector('#grid .coin-card:not(.ghost)') || !document.querySelector('#empty').hidden)",
  coin: "!document.querySelector('#layout').hidden && !!document.querySelector('#tradeCard .btn-main') && !!document.querySelector('#figs')",
  coinFail: "!!document.querySelector('#loadMsg .card')",
  picker: "(!!document.querySelector('#head .pool-pick a') || /No pools|did not answer/.test(document.querySelector('#head').textContent))",
  pool: "!document.querySelector('#layout').hidden && !!document.querySelector('#locked dd')",
  chooser: "!!document.querySelector('#siteFooter a') && document.querySelectorAll('.choose-card').length === 3",
  launch: "!!document.querySelector('#launchBtn') && !!document.querySelector('#costs dd') && /^(Launch|Connect wallet)$/.test(document.querySelector('#launchBtn').textContent)",
  hooks: "!!document.querySelector('#try button') && !/^Loading/.test(document.querySelector('#pickPanel').textContent)",
  workshop: "!/^Reading/.test(document.querySelector('#count').textContent)",
  wsHook: "(!/^Reading/.test(document.querySelector('#state').textContent) || !document.querySelector('#page').hidden)",
  guide: "!!document.querySelector('#step1Head') && !!document.querySelector('#siteFooter a') && !!document.querySelector('#flagCalls input') && document.querySelector('#flagRust').textContent !== ''",
  docs: "(document.querySelector('[data-plat=protocolFeeBps]') || {}).textContent !== ''",
};
const WALLET_ON = " && !!document.querySelector('#walletBtn.on')";

const PAGES = [
  ["index.html", READY.index],
  ...COINS.map(([k, p]) => ["coin.html?pool=" + p.address, READY.coin, "coin-" + k]),
  ["pool.html", READY.picker],
  ...COINS.slice(0, 2).map(([k, p]) => ["pool.html?pool=" + p.address, READY.pool, "pool-" + k]),
  ["launch.html", READY.chooser],
  ["launch-modules.html", READY.launch],
  ["launch-collectible.html", READY.launch],
  ["launch-collectible.html?kind=pegged", READY.launch, "launch-collectible-pegged"],
  ["launch-hook.html", READY.launch],
  ["hooks.html", READY.hooks],
  ["workshop.html", READY.workshop],
  ["workshop-hook.html", READY.wsHook],
  ["workshop-guide.html", READY.guide],
  ["docs.html", READY.docs],
];

async function runPart(p, title, fn) {
  if (!want(p)) return;
  part = p;
  console.log("\n" + p + ". " + title);
  try { await fn(); } catch (e) { check(false, "part " + p + " ran to its end", e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e)); }
  await view(1440);
}

try {
  // ---- P. every page at both widths, with and without the wallet ---------------------------------------
  await runPart("P", "page sweep: 1440 and 375, without and with the stand-in wallet", async () => {
    for (const width of [1440, 375]) {
      await view(width);
      for (const wallet of ["off", "on"]) {
        for (const [pg, ready, label] of PAGES) {
          const n0 = issues.length;
          const ok = await go(pg, ready + (wallet === "on" ? WALLET_ON : ""), { wallet });
          await sleep(2500);
          const flat = await overflow();
          const name = (label || pg.replace(/\.html.*$/, "")) + "-" + width + "-" + (wallet === "on" ? "wallet" : "nowallet");
          check(ok, "loads and gets ready: " + pg + " at " + width + (wallet === "on" ? " with the wallet" : " without a wallet"), ok ? "" : "not ready after 25 s: " + ((await T("main")) || "").slice(0, 160));
          check(flat, "no sideways scroll: " + pg + " at " + width + (wallet === "on" ? " +wallet" : ""), flat ? "" : "page is " + (await evSafe("document.documentElement.scrollWidth")) + " px wide");
          if (width === 375 && wallet === "off") { const low = await smallTargets(); if (low.length) note(pg + " at 375: controls under 44 px high: " + [...new Set(low)].slice(0, 8).join("; ")); }
          await shot(name);
          const mine = issuesSince(n0).filter((i) => i.kind !== "canceled");
          if (mine.length) note(pg + " @" + width + " " + wallet + ": " + mine.length + " console/network issue(s), first: " + mine[0].kind + " " + String(mine[0].text).slice(0, 200));
        }
      }
    }
  });

  // ---- H. header, menu, footer -----------------------------------------------------------------------
  await runPart("H", "header, menu (desktop and phone), footer links", async () => {
    await view(1440);
    await go("index.html", READY.index);
    const head = await evSafe("[...document.querySelectorAll('#siteHeader a[href]')].map((a) => a.getAttribute('href') + '|' + a.textContent.trim())", []);
    const foot = await evSafe("[...document.querySelectorAll('#siteFooter a[href]')].map((a) => a.getAttribute('href') + '|' + a.textContent.trim())", []);
    check(head.some((h) => h.startsWith("index.html|Explore")) && head.some((h) => h.startsWith("launch.html|Launch a token")), "the header has Explore and Launch a token", head);
    check(foot.length === 10, "the footer has its 10 links (Product 6, Resources 4)", foot.map((f) => f.split("|")[1]).join(", "));
    await click("#menuBtn");
    await until("!document.querySelector('#menuSheet').hidden", 3000);
    const menu = await evSafe("[...document.querySelectorAll('#menuSheet a.menu-item')].filter((a) => a.getBoundingClientRect().height > 0).map((a) => a.getAttribute('href') + '|' + a.textContent.trim())", []);
    check(await evSafe("document.querySelector('#menuBtn').getAttribute('aria-expanded') === 'true'"), "the menu opens on its button (aria-expanded true)");
    check(menu.length === 3 && menu.every((m) => /workshop|hooks|docs/.test(m)), "at 1440 the menu lists Custom hooks, Hook checker, Docs (Explore is phone only)", menu);
    check((await T("#menuSheet .menu-foot")) === "Network " + CLUSTER, "the menu says the network", await T("#menuSheet .menu-foot"));
    const footTitle = await evSafe("(document.querySelector('#menuSheet .menu-foot span') || {}).title || ''");
    check(footTitle === "RPC " + hostOf(RPC || "http://x"), "the menu names the RPC by its host only, never its path", footTitle);
    await click("#walletBtn");
    await until("!document.querySelector('#walletPop').hidden", 3000);
    const popTxt = await T("#walletPop");
    check(/No Solana wallet found in this browser\./.test(popTxt || "") && (await evSafe("document.querySelectorAll('#walletPop a.item').length")) === 3, "without a wallet the wallet pop says none is found and links Phantom, Solflare and Backpack", popTxt);
    await key("Escape", "Escape", 27);
    await sleep(300);
    check(await evSafe("document.querySelector('#menuSheet').hidden"), "Escape closes the menu");
    // every link of the shell answers 200
    const hrefs = [...new Set([...head, ...foot, ...menu].map((h) => h.split("|")[0]))];
    const bad = [];
    for (const h of hrefs) { const r = await fetch(origin + "/" + h); if (r.status !== 200) bad.push(h + " " + r.status); }
    check(bad.length === 0, "every header, menu and footer link answers 200 (" + hrefs.length + " links)", bad.join(", "));
    // real clicks: a footer link, a header link and a menu link land on their pages
    await click("#siteFooter a[href='docs.html']"); await waitLoad();
    check(await until("location.pathname.endsWith('/docs.html')", 8000), "a click on Docs in the footer opens docs.html");
    await until("!!document.querySelector('#siteHeader a[href=\"launch.html\"]')", 8000);
    await click("#siteHeader a[href='launch.html']"); await sleep(1500);
    check(await until("location.pathname.endsWith('/launch.html')", 8000), "a click on Launch a token in the header opens launch.html");
    await until("!!document.querySelector('#menuBtn') && document.querySelectorAll('.choose-card').length === 3", 8000);
    await click("#menuBtn"); await sleep(300); await click("#menuSheet a[href='hooks.html']"); await sleep(1500);
    check(await until("location.pathname.endsWith('/hooks.html')", 8000), "a click on Hook checker in the menu opens hooks.html");
    // the phone
    await view(375);
    await go("index.html", READY.index);
    check(!(await VIS("#siteHeader .site-nav a[data-nav=explore]")) && (await VIS("#siteHeader .site-nav a[data-nav=launch]")), "at 375 the header shows Launch a token and hides Explore");
    await click("#menuBtn"); await sleep(400);
    const pmenu = await evSafe("[...document.querySelectorAll('#menuSheet a.menu-item')].filter((a) => a.getBoundingClientRect().height > 0).map((a) => a.textContent.trim())", []);
    check(pmenu.length === 4 && pmenu[0] === "Explore", "at 375 the menu lists Explore, Custom hooks, Hook checker, Docs", pmenu);
    await shot("H-phone-menu-375", false);
    await click("#menuSheet a[href='workshop.html']"); await sleep(1500);
    check(await until("location.pathname.endsWith('/workshop.html')", 8000), "at 375 a click on Custom hooks in the menu opens workshop.html");
    await view(1440);
    // the stand-in wallet, connected through the menu (not remembered)
    await go("index.html", READY.index, { wallet: "on", remember: false });
    check(!(await evSafe("!!document.querySelector('#walletBtn.on')")), "a wallet the site does not remember is not connected on its own");
    await click("#menuBtn"); await sleep(300); await click("#walletBtn"); await sleep(400);
    const list = await TS("#walletPop .item");
    check(list.some((t) => /^Phantom/.test(t)), "the wallet pop lists the injected Phantom", list);
    await click("#walletPop .item"); await sleep(800);
    const short = STANDIN.slice(0, 4) + "..." + STANDIN.slice(-4);
    check(await until("!!document.querySelector('#walletBtn.on') && document.querySelector('#walletBtn .addr').textContent === " + q(short), 4000), "Phantom connects and the menu shows " + short);
    check((await evSafe("window.__dry.toasts()", [])).some((t) => t === "Connected to Phantom"), "a toast says Connected to Phantom", await evSafe("window.__dry.toasts()", []));
    if (!(await evSafe("!document.querySelector('#menuSheet').hidden"))) await click("#menuBtn");
    await sleep(300);
    if (await evSafe("document.querySelector('#walletPop').hidden")) await click("#walletBtn");
    await sleep(300);
    const items = await TS("#walletPop .item");
    const solscan = await evSafe("(document.querySelector('#walletPop a.item') || {}).href || ''");
    check(items.length === 3 && /^Copy address/.test(items[0]) && /^View on Solscan/.test(items[1]) && /^Disconnect/.test(items[2]) && solscanIs(solscan, "account", STANDIN), "connected, the pop has Copy address, View on Solscan (" + CLUSTER + " link) and Disconnect", { items, solscan });
    await clearToasts(); await click("#walletPop .item"); await sleep(500);
    const copied = await evSafe("window.__dry.toasts()", []);
    check(copied.includes("Copied"), "Copy address copies (toast Copied)", copied);
    note("clipboard after Copy address: " + (await evSafe("navigator.clipboard.readText().catch((e) => 'unreadable: ' + e.message)")));
    if (await evSafe("document.querySelector('#menuSheet').hidden")) await click("#menuBtn");
    await sleep(200);
    if (await evSafe("document.querySelector('#walletPop').hidden")) await click("#walletBtn");
    await sleep(200);
    await click("#walletPop .item:last-child"); await sleep(600);
    check(!(await evSafe("!!document.querySelector('#walletBtn.on')")) && (await evSafe("localStorage.getItem('Programmable.wallet')")) === null, "Disconnect disconnects and forgets the wallet");
  });

  // ---- E. Explore --------------------------------------------------------------------------------------
  await runPart("E", "Explore: cards, search, filters, sort, paging (from the watcher's market.json)", async () => {
    const n0 = rpcLog.length;
    await go("index.html", READY.index);
    await sleep(3500);
    const market = (await getJson(MARKET_URL)).json;
    const cards = await evSafe("[...document.querySelectorAll('#grid .coin-card:not(.ghost)')].map((c) => ({ pool: c.dataset.pool, name: c.querySelector('.coin-link').textContent, pair: c.querySelector('.coin-pair').textContent, kind: c.dataset.kind, curve: (c.querySelector('.coin-curve') || { dataset: {} }).dataset.curve || '', mark: (c.querySelector('.curve-mark') || {}).textContent || '', raised: (c.querySelector('.coin-raised') || {}).textContent || '', mcap: c.querySelector('.coin-figs .v').textContent, age: c.querySelector('.coin-age').textContent, img: c.querySelector('.coin-art img').src.slice(0, 80), imgOk: c.querySelector('.coin-art img').complete && c.querySelector('.coin-art img').naturalWidth > 0, href: c.querySelector('.coin-link').getAttribute('href') }))", []);
    console.log("        cards: " + JSON.stringify(cards));
    check(cards.length === market.pools.length, "one card per pool of market.json (" + market.pools.length + ")", cards.length);
    const pageRpc = rpcLog.slice(n0).flatMap((r) => r.methods);
    check(!pageRpc.includes("getProgramAccounts"), "Explore reads no getProgramAccounts: its data come from market.json", "RPC methods: " + JSON.stringify(pageRpc));
    for (const p of market.pools) {
      const c = cards.find((x) => x.pool === p.address);
      if (!check(!!c, "card of " + p.coin.name)) continue;
      const wantMark = p.curveState === "open" ? "Curve" : p.curveState === "graduated" ? "Graduated" : "";
      check(c.curve === (p.curveState === "none" ? "" : p.curveState) && c.mark === wantMark, p.coin.name + ": the curve mark says " + (wantMark || "nothing"), c.mark + " " + c.raised);
      if (p.curveState === "open") {
        // the watcher's market carries curve { raised, target }; a stand-in market has the pool's own reserveQuote and graduationTarget
        const raised = p.curve ? p.curve.raised : p.reserveQuote, target = p.curve ? p.curve.target : p.graduationTarget;
        const want = (await fmt("fmtAmount", raised, 9, 2)) + " of " + (await fmt("fmtUnits", target, 9, 2)) + " SOL";
        check(c.raised === want, p.coin.name + ": the card says what the pool raised of its target", c.raised + " vs " + want);
        check(!(BigInt(raised) > 0n && /^0 of/.test(c.raised)), p.coin.name + ": a pool that holds a little real SOL never reads 0 raised", c.raised + " (" + raised + " lamports)");
      }
      const mc = Number(p.marketCap) / 1e9, shown = bigText(c.mcap);
      check(Math.abs(shown - mc) <= Math.max(0.011, mc * 0.011) || /K|M|B/.test(c.mcap), p.coin.name + ": the market cap matches market.json", c.mcap + " vs " + mc.toFixed(6) + " SOL");
      if (p.coin.image) check(c.img.startsWith(p.coin.image.slice(0, 60)) && c.imgOk, p.coin.name + ": its picture is the one of its metadata and it loaded", c.img);
      check(c.pair === p.coin.symbol + " / SOL" && c.href === "coin.html?pool=" + p.address, p.coin.name + ": pair and link", c.pair + " " + c.href);
    }
    // search
    const count = () => evSafe("document.querySelectorAll('#grid .coin-card:not(.ghost)').length", -1);
    const visiblePools = () => evSafe("document.querySelector('#grid').hidden ? [] : [...document.querySelectorAll('#grid .coin-card')].map((c) => c.dataset.pool)", []);
    if (B) { await type("#search", "Test B"); check(JSON.stringify(await visiblePools()) === JSON.stringify([B.address]), "search by name finds Test B only"); }
    if (A) { await type("#search", A.coin.symbol.toLowerCase()); check(JSON.stringify(await visiblePools()) === JSON.stringify([A.address]), "search by ticker in lower case finds " + A.coin.symbol); }
    if (C3) { await type("#search", C3.baseMint); check(JSON.stringify(await visiblePools()) === JSON.stringify([C3.address]), "search by mint finds Test C"); }
    if (A) { await type("#search", A.address.slice(0, 12)); check((await visiblePools()).includes(A.address), "search by pool address finds Test A"); }
    await type("#search", "zzqqxx nothing");
    check((await T("#empty")) === "No coin matches." && (await evSafe("document.querySelector('#grid').hidden")), "a search that matches nothing says No coin matches.", await T("#empty"));
    await type("#search", "");
    check((await count()) === market.pools.length, "clearing the search shows every coin again");
    // filters
    await click("#filtersBtn"); await sleep(250);
    check(!(await evSafe("document.querySelector('#filters').hidden")) && (await evSafe("document.querySelector('#filtersBtn').getAttribute('aria-expanded')")) === "true", "Filters opens the filter panel");
    for (const [start, label] of [["open", "On the curve"], ["graduated", "Graduated"], ["none", "Seeded"], ["all", "All"]]) {
      await click("#start [data-start=" + start + "]"); await sleep(300);
      const wantPools = market.pools.filter((p) => start === "all" || p.curveState === start).map((p) => p.address).sort();
      const got = (await visiblePools()).sort();
      const pressed = await evSafe("document.querySelector('#start [data-start=" + start + "]').getAttribute('aria-pressed')");
      check(JSON.stringify(got) === JSON.stringify(wantPools) && pressed === "true" && (wantPools.length || (await T("#empty")) === "No coin matches."), "Pool: " + label + " shows " + wantPools.length + " coin(s)", { got: got.length, empty: wantPools.length ? "" : await T("#empty") });
    }
    for (const [kind, label] of [["", "No hook"], ["Modules", "Modules"], ["Collectible", "Collectible"], ["Custom hook", "Custom hook"], ["Platform hook", "Platform hook"], ["all", "All"]]) {
      await click("#kind [data-kind=" + q(kind) + "]"); await sleep(300);
      const wantPools = market.pools.filter((p) => kind === "all" || (kind === "" ? !p.hasHook : false)).map((p) => p.address).sort();
      const got = (await visiblePools()).sort();
      check(JSON.stringify(got) === JSON.stringify(wantPools), "Kind: " + label + " shows " + wantPools.length + " coin(s)", got.length);
    }
    const order = async () => evSafe("[...document.querySelectorAll('#grid .coin-card')].map((c) => c.dataset.pool)", []);
    const sorted = (f) => market.pools.slice().sort(f).map((p) => p.address);
    const cmpBig = (k) => (a, b) => (BigInt(b[k]) > BigInt(a[k]) ? 1 : BigInt(b[k]) < BigInt(a[k]) ? -1 : 0);
    for (const [s, f] of [["mcap", (a, b) => Number(b.marketCap) - Number(a.marketCap)], ["volume", cmpBig("volumeQuoteTotal")], ["liquidity", cmpBig("reserveQuote")], ["newest", cmpBig("createdSlot")]]) {
      await click("#sort [data-sort=" + s + "]"); await sleep(300);
      check(JSON.stringify(await order()) === JSON.stringify(sorted(f)), "Sort by " + s + " orders the cards as market.json says");
    }
    check(await evSafe("document.querySelector('#prevPage').disabled && document.querySelector('#nextPage').disabled"), "with " + market.pools.length + " coins both page buttons are off");
    check((await T("#pageSay")) === market.pools.length + " coins. Page 1 of 1.", "the page line for screen readers", await T("#pageSay"));
    await click("#refresh"); await sleep(200);
    const during = await T("#refresh");
    check(await until("document.querySelector('#refresh').textContent === 'Refresh' && !document.querySelector('#refresh').disabled", 10000), "Refresh reads the market again", "during: " + during);
    check(/^Updated \d+s ago$/.test((await T("#updated")) || ""), "the panel says when it was updated", await T("#updated"));
    await shot("E-explore-filters-1440", false);
    if (A) { await click(".coin-card[data-pool=" + q(A.address) + "] .coin-link"); check(await until("location.pathname.endsWith('/coin.html') && location.search.includes(" + q(A.address) + ")", 8000), "a card opens its coin page"); }
  });

  // ---- C. coin pages -----------------------------------------------------------------------------------
  async function apiQuote(mint, side, amount, slip = 100) { return (await getJson(origin + "/api/v1/quote?mint=" + mint + "&side=" + side + "&amount=" + amount + "&slippageBps=" + slip)).json; }
  const outText = () => T("#tradeCard .out .v");
  const waitOut = async (not = "0") => until("(() => { const v = (document.querySelector('#tradeCard .out .v') || {}).textContent; return !!v && v !== " + q(not) + "; })()", 10000);
  const tradeKv = () => KV("#tradeCard dl.kv");
  await runPart("C", "coin pages: figures, curve line, trades, chart, copy, links, trade card", async () => {
    for (const [k, P] of COINS) {
      const sym = P.coin.symbol;
      const ok = await go("coin.html?pool=" + P.address, READY.coin + WALLET_ON, { wallet: "on" });
      if (!check(ok, k + ": the coin page loads with the wallet connected")) continue;
      await until("!!document.querySelector('#tradeCard .balance span')", 8000);
      await sleep(3500);
      const mk = (await getJson(MARKET_URL)).json.pools.find((x) => x.address === P.address) || P;
      const info = await evSafe("({ h1: window.__dry.t('#head h1'), price: window.__dry.t('#headPrice'), mcap: window.__dry.t('#headMcap'), liq: window.__dry.t('#headLiq'), vol: window.__dry.t('#headVol'), swaps: window.__dry.t('#headSwaps'), state: (document.querySelector('#curveLine') || { dataset: {} }).dataset.state || '', raised: window.__dry.t('#curveRaised'), sold: window.__dry.t('#curveSold'), note: window.__dry.t('#curveNote'), bar: (document.querySelector('#curveLine .curve-bar') || { getAttribute: () => null }).getAttribute('aria-valuenow'), mark: window.__dry.t('#curveMark'), done: window.__dry.t('#curveDone'), hook: window.__dry.t('#hookCard'), liqText: window.__dry.t('#liqText'), watch: document.querySelector('#watchCard').hidden ? null : window.__dry.t('#watchCard'), stats: [...document.querySelectorAll('#stats .stat')].map((s) => s.querySelector('.l').textContent + ': ' + s.querySelector('.v').textContent), canvas: !!document.querySelector('#chart canvas'), chartEmpty: document.querySelector('#chartEmpty').hidden ? '' : document.querySelector('#chartEmpty').textContent, tradesNote: window.__dry.t('#tradesNote'), balance: window.__dry.t('#tradeCard .balance span'), desc: window.__dry.t('#head .coin-desc'), avatar: document.querySelector('#head img.avatar').src.slice(0, 90), avatarOk: document.querySelector('#head img.avatar').naturalWidth > 0 })", {});
      console.log("        " + k + " page: " + JSON.stringify(info));
      check(info.h1 === P.coin.name + sym + " / SOL", k + ": the name and the pair", info.h1);
      const mcapSol = Number(mk.marketCap) / 1e9;
      check(Math.abs(bigText(info.mcap) - mcapSol) <= Math.max(0.011, mcapSol * 0.011), k + ": the market cap agrees with the watcher's market", info.mcap + " vs " + mcapSol.toFixed(6));
      check(info.price === (await fmt("fmtPrice", Number(mk.price))) + " SOL", k + ": the price agrees with the watcher's market", info.price + " vs " + mk.price);
      check(info.liq === (await fmt("fmtAmount", mk.reserveQuote, 9, 2)) + " SOL" && info.vol === (await fmt("fmtUnits", mk.volumeQuoteTotal, 9, 2)) + " SOL" && info.swaps === (await fmt("fmtInt", Number(mk.swapCount))), k + ": In the pool, Volume and Trades agree with the pool account", [info.liq, info.vol, info.swaps]);
      check(!(BigInt(mk.reserveQuote) > 0n && info.liq === "0 SOL"), k + ": a pool that holds a little SOL never reads In the pool 0 SOL", info.liq + " (" + mk.reserveQuote + " lamports)");
      check(!info.stats.some((x) => /\b1000(\.0+)?[KMB]\b/.test(x)), k + ": no figure reads 1000 of a unit (1000.00M is 1B)", info.stats);
      check((info.hook || "").split("No hook").length <= 2 && (await TS("#head .head-tags .tag")).every((t) => t !== "no hook"), k + ": the head says No hook once at most", await TS("#head .head-tags .tag"));
      if (mk.coin && mk.coin.image) check(info.avatarOk && info.avatar.startsWith(mk.coin.image.slice(0, 60)), k + ": the coin's picture loads", info.avatar);
      if (mk.curveState === "open") {
        check(info.state === "open" && /^Raised [\d.,]+ of 85 SOL$/.test(info.raised || "") && /of the supply sold$/.test(info.sold || "") && info.bar !== null, k + ": the curve line: raised of 85 SOL, the share sold, a progress bar", [info.raised, info.sold, info.bar]);
        check(info.note === "Liquidity opens at graduation, when the pool has raised 85 SOL.", k + ": the curve note says liquidity opens at graduation", info.note);
        check(info.stats.includes("Virtual SOL: 30"), k + ": the pool figures name the 30 virtual SOL", info.stats);
        check(/^This pool is on the curve\. Liquidity opens at graduation, when it has raised 85 SOL\./.test(info.liqText || ""), k + ": the liquidity panel says liquidity opens at graduation", info.liqText);
      } else if (mk.curveState === "graduated") {
        check(info.state === "graduated" && info.mark === "Graduated", k + ": the Graduated mark", info.mark);
        check(/^In slot [\d,]+ \(.+\)\. Graduation burned [\d,]+ \S+ so the price did not move\.$/.test(info.done || ""), k + ": the Graduated line names the slot, the time and the coins burned", info.done);
        check(info.stats.some((s) => /^Curve: graduated in slot [\d,]+$/.test(s)), k + ": the pool figures say graduated in which slot", info.stats.filter((s) => /^Curve/.test(s)));
      }
      check(!!info.hook, k + ": the hook card is drawn", (info.hook || "").slice(0, 200));
      if (info.watch) {
        check(!/403|Forbidden|jsonrpc|dedicated node/i.test(info.watch), k + ": the watcher card shows no raw RPC error to visitors", info.watch.slice(0, 260));
      }
      // the trades
      const rows = await evSafe("[...document.querySelectorAll('#trades tbody tr')].map((tr) => [...tr.children].slice(0, 6).map((td) => td.textContent).join('|') + '|' + ((tr.querySelector('td:last-child a') || {}).href || ''))", []);
      const feed = (await getJson(origin + "/watcher/trades/" + P.address + ".json")).json || { events: [] };
      const feedSwaps = feed.events.filter((e) => e.kind === "Swapped");
      const sigs = rows.map((r) => r.split("|").pop());
      const dupSigs = sigs.filter((s, i) => sigs.indexOf(s) !== i);
      console.log("        " + k + " trades rows: " + rows.length + "; feed Swapped events " + feedSwaps.length + ", unique signatures " + new Set(feedSwaps.map((e) => e.signature)).size);
      check(rows.length > 0 || Number(mk.swapCount) === 0, k + ": the trades list has rows", rows.length);
      check(rows.length <= Number(mk.swapCount), k + ": the trades list shows no more trades than the pool counts (" + mk.swapCount + " swaps)", rows.length + " rows");
      check(dupSigs.length === 0, k + ": no trade is listed twice", dupSigs.length ? "the same transaction is listed " + (dupSigs.length + new Set(dupSigs).size) + " times: " + [...new Set(dupSigs)].map((s) => s.split("/").pop().slice(0, 10)).join(", ") : "");
      check(rows.every((r) => (CLUSTER === "mainnet" ? /^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]{60,90}$/ : /^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]{60,90}\?cluster=/).test(r.split("|").pop())), k + ": every trade links its transaction on Solscan (" + CLUSTER + ")");
      // the chart
      check(info.canvas && (info.chartEmpty === "" || rows.length === 0), k + ": the chart is drawn", info.chartEmpty || "canvas");
      await click("#bucketSeg [data-bucket='300']"); await sleep(400);
      check((await evSafe("document.querySelector('#bucketSeg [data-bucket=\"300\"]').getAttribute('aria-pressed')")) === "true" && (await evSafe("!!document.querySelector('#chart canvas')")), k + ": 5m candles switch on");
      await click("#bucketSeg [data-bucket='60']"); await sleep(300);
      // explorer links and copy buttons
      const links = await evSafe("[...document.querySelectorAll('#head a[target=_blank], #stats a[target=_blank]')].map((a) => a.href)", []);
      const acctRe = CLUSTER === "mainnet" ? /^https:\/\/solscan\.io\/account\/[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^https:\/\/solscan\.io\/account\/[1-9A-HJ-NP-Za-km-z]{32,44}\?cluster=/;
      const fmRe = CLUSTER === "mainnet" ? /^https:\/\/solana\.fm\/address\/[1-9A-HJ-NP-Za-km-z]{32,44}\?cluster=mainnet-alpha$/ : /^https:\/\/solana\.fm\/address\/[1-9A-HJ-NP-Za-km-z]{32,44}\?cluster=/;
      const badLinks = links.filter((u) => !acctRe.test(u) && !fmRe.test(u) && !/^https?:\/\//.test(u));
      check(links.length >= 4 && badLinks.length === 0 && links.some((u) => (CLUSTER === "mainnet" ? u.endsWith(P.baseMint) : u.includes(P.baseMint + "?"))) && links.some((u) => u.includes(P.address)), k + ": the explorer links name the mint and the pool on " + CLUSTER + " (Solscan, Solana FM)", { links: links.length, bad: badLinks });
      await clearToasts();
      await click("#head .copy-addr"); await sleep(400);
      const t1 = await evSafe("window.__dry.toasts()", []);
      const clip = await evSafe("navigator.clipboard.readText().catch(() => '')", "");
      check(t1.includes("Copied") && (clip === "" || clip === P.baseMint), k + ": Copy address copies the mint", { toasts: t1, clipboard: clip });
      const chips = await evSafe("document.querySelectorAll('#head .addr .icon-btn').length", 0);
      const chipCopies = [];
      for (let i = 0; i < chips; i++) {
        await clearToasts();
        await ev("document.querySelectorAll('#head .addr .icon-btn')[" + i + "].click(); true");
        await sleep(350);
        chipCopies.push(((await evSafe("window.__dry.toasts()", [])).join("/")) + " " + (await evSafe("navigator.clipboard.readText().catch(() => '')", "")).slice(0, 8));
      }
      check(chips >= 2 && chipCopies.every((c) => c.startsWith("Copied")), k + ": the Mint and Pool chips copy their addresses", chipCopies);

      // ---- the trade card, buy ----
      const buyBtn = "#tradeCard .btn-main";
      check((await T(buyBtn)) === "Buy " + sym && (await evSafe("document.querySelector('#tradeCard .seg [data-dir=buy]').getAttribute('aria-pressed')")) === "true" && (await T("#tradeCard .suffix")) === "SOL", k + ": the trade card opens on Buy, in SOL", await T(buyBtn));
      const quick = await TS("#tradeCard .quick button");
      check(JSON.stringify(quick) === JSON.stringify(["0.1 SOL", "0.5 SOL", "1 SOL"]), k + ": the quick amounts 0.1, 0.5, 1 SOL", quick);
      await click("#tradeCard .quick button:nth-child(1)");
      await waitOut(); await sleep(400);
      const api01 = await apiQuote(P.baseMint, "buy", "100000000");
      const shown01 = await outText();
      check((await evSafe("document.querySelector('#amount').value")) === "0.1" && shown01 === (await fmt("fmtUnits", api01.outAmount, 6, 2)), k + ": 0.1 SOL quick amount: You receive agrees with the trade API", shown01 + " vs API " + api01.outAmount);
      let kv = await tradeKv();
      check(kv["Min received"] === (await fmt("fmtUnits", api01.minOutAmount, 6, 2)) + " " + sym, k + ": Min received at 1% agrees with the trade API's minOutAmount", kv["Min received"] + " vs " + api01.minOutAmount);
      check(kv["Protocol fee 0.3%"] === (await fmt("fmtUnits", api01.fees.protocol.amount, 9, 6)) + " SOL" && kv["Pool fee 1%"] === (await fmt("fmtUnits", api01.fees.pool.amount, 9, 6)) + " SOL", k + ": the protocol fee 0.3% and the pool fee 1% agree with the trade API", kv);
      check(await until("!!document.querySelector('#exactOut')", 8000), k + ": with a wallet the trade is simulated on chain (Exact quote row)");
      await sleep(500);
      const exact = await T("#exactOut"), exactTitle = await evSafe("(document.querySelector('#exactOut') || {}).title || ''");
      check(/same as above$/.test(exact || ""), k + ": the simulated buy gives the same as the quote", exact + (exactTitle ? " (" + exactTitle + ")" : ""));
      for (const [i, want] of [[2, "0.5"], [3, "1"]]) { await click("#tradeCard .quick button:nth-child(" + i + ")"); await sleep(400); check((await evSafe("document.querySelector('#amount').value")) === want && (await waitOut()), k + ": quick amount " + want + " SOL fills the field and quotes"); }
      await type("#amount", "0.25"); await waitOut(); await sleep(300);
      const a025 = await apiQuote(P.baseMint, "buy", "250000000");
      check((await outText()) === (await fmt("fmtUnits", a025.outAmount, 6, 2)), k + ": a typed 0.25 SOL quotes what the trade API quotes", (await outText()) + " vs " + a025.outAmount);
      // slippage
      const slipBtns = await TS("#tradeCard .slip button");
      check(JSON.stringify(slipBtns) === JSON.stringify(["0.5%", "1%", "2%"]), k + ": slippage choices 0.5%, 1%, 2% and a custom field", slipBtns);
      for (const [i, bps] of [[1, 50], [3, 200]]) {
        await click("#tradeCard .slip button:nth-child(" + i + ")"); await sleep(300);
        kv = await tradeKv();
        const want = (await fmt("fmtUnits", ((BigInt(a025.outAmount) * BigInt(10000 - bps)) / 10000n).toString(), 6, 2)) + " " + sym;
        check(kv["Min received"] === want && (await evSafe("document.querySelector('#tradeCard .slip button:nth-child(" + i + ")').getAttribute('aria-pressed')")) === "true", k + ": slippage " + bps / 100 + "% sets Min received", kv["Min received"] + " vs " + want);
      }
      await type("#tradeCard .slip input", "3"); await sleep(400);
      kv = await tradeKv();
      const want3 = (await fmt("fmtUnits", ((BigInt(a025.outAmount) * 9700n) / 10000n).toString(), 6, 2)) + " " + sym;
      check(kv["Min received"] === want3 && (await evSafe("[...document.querySelectorAll('#tradeCard .slip button')].every((b) => b.getAttribute('aria-pressed') === 'false')")), k + ": a custom slippage of 3% sets Min received and unpresses the choices", kv["Min received"] + " vs " + want3);
      await type("#tradeCard .slip input", "60"); await sleep(300);
      const slip60 = await T("#tradeCard .slip-note");
      check(slip60 === "A slippage of 50% or more is above the limit. It stays at 3%." && (await tradeKv())["Min received"] === want3, k + ": a custom slippage of 60% is said to be above the limit, and Min received stays at 3%", [slip60, (await tradeKv())["Min received"]]);
      await click("#tradeCard .slip button:nth-child(2)"); await sleep(300);
      check((await evSafe("document.querySelector('#tradeCard .slip input').value")) === "", k + ": choosing 1% again clears the custom field");
      // Max with the wallet's balance
      const balText = await T("#tradeCard .balance span");
      check(/^Balance [\d,.]+ SOL$/.test(balText || "") && bigText(balText) > 0, k + ": the wallet's SOL balance shows", balText);
      await click("#tradeCard .balance button"); await sleep(500);
      const maxVal = await evSafe("document.querySelector('#amount').value");
      const solNow = await evSafe("(async () => { const c = await import('/common.js'); return String(await c.ctx.connection.getBalance(new c.H.PublicKey(" + q(STANDIN) + "))); })()");
      const wantMax = solNow ? (await fmt("fmtUnits", (BigInt(solNow) - 20_000_000n).toString(), 9, 9)).replace(/,/g, "") : "";
      check(maxVal === wantMax && (await waitOut()), k + ": Max fills the balance less 0.02 SOL for fees and rent", maxVal + " vs " + wantMax);
      // the note of a buy that graduates the coin, on a coin on the curve
      if (mk.curveState === "open") {
        await type("#amount", "50"); await waitOut(); await sleep(400);
        check((await T("#tradeCard .trade-note .curve-grad")) === null, k + ": a buy of 50 SOL says nothing about graduation");
        await type("#amount", "90"); await waitOut(); await sleep(400);
        const grad = await T("#tradeCard .trade-note .curve-grad");
        const apiG = await apiQuote(P.baseMint, "buy", "90000000000");
        check(grad === "This trade graduates the coin." && apiG.curve && apiG.curve.graduates === true, k + ": a buy of 90 SOL says This trade graduates the coin, as the trade API does", { page: grad, api: apiG.curve });
        const sim90 = await until("!!document.querySelector('#exactOut')", 8000) ? await T("#exactOut") : null;
        note(k + ": a 90 SOL buy (more than the wallet holds): Exact quote reads '" + sim90 + "', title '" + (await evSafe("(document.querySelector('#exactOut') || {}).title || ''")) + "'");
        if (bigText(balText) < 90) {
          const bad90 = await TS("#tradeCard .trade-note .bad");
          check(bad90.some((t) => /^Your wallet holds [\d,.]+ SOL\. That is not enough for this buy\.$/.test(t)) && (await evSafe("document.querySelector('" + buyBtn + "').disabled")), k + ": a buy of more SOL than the wallet holds is held back in words, the button off", bad90);
        }
      }
      // pressing Buy: the wallet is asked and refuses
      await type("#amount", "0.01"); await waitOut(); await sleep(500);
      await clearToasts();
      const p0 = await prompts();
      await click(buyBtn);
      const doneBuy = await until("(() => { const t = document.querySelector('#tradeCard .tx-result'); return !!t && t.textContent.trim() !== ''; })()", 30000);
      const saidBuy = await T("#tradeCard .tx-result");
      check(doneBuy && (await prompts()) === p0 + 1, k + ": pressing Buy asks the wallet once", "prompts " + ((await prompts()) - p0));
      check(saidBuy === WALLET_NO && (await evSafe("window.__dry.toasts()", [])).includes(WALLET_NO), k + ": after the refusal the card and a toast say: " + WALLET_NO, saidBuy);
      check((await T(buyBtn)) === "Buy " + sym && !(await evSafe("document.querySelector('" + buyBtn + "').disabled")), k + ": the Buy button comes back");
      await shot("C-" + k + "-buy-refused-1440", false);
      await type("#amount", "0.02"); await sleep(300);
      check((await T("#tradeCard .tx-result")) === "", k + ": a new amount clears the refusal line under the button", await T("#tradeCard .tx-result"));
      // ---- sell ----
      await click("#tradeCard .seg [data-dir=sell]"); await sleep(400);
      check((await T(buyBtn)) === "Sell " + sym && (await T("#tradeCard .suffix")) === sym && JSON.stringify(await TS("#tradeCard .quick button")) === JSON.stringify(["25%", "50%", "100%"]), k + ": the Sell tab: in " + sym + ", quick 25%, 50%, 100%");
      const sbal = await T("#tradeCard .balance span");
      check(/^Balance [\d,.]+ /.test(sbal || ""), k + ": the coin balance shows", sbal);
      await click("#tradeCard .quick button:nth-child(3)"); await sleep(400);
      note(k + ": Sell 100% with a balance of '" + sbal + "' fills '" + (await evSafe("document.querySelector('#amount').value")) + "' and You receive '" + (await outText()) + "'");
      await type("#amount", "1000"); await waitOut(); await sleep(400);
      const aSell = await apiQuote(P.baseMint, "sell", "1000000000");
      check((await outText()) === (await fmt("fmtUnits", aSell.outAmount, 9, 6)), k + ": a sell of 1,000 " + sym + " quotes what the trade API quotes", (await outText()) + " vs " + aSell.outAmount);
      if (await until("!!document.querySelector('#exactOut')", 6000)) note(k + ": the simulated sell of 1,000 " + sym + " by a wallet that holds none reads '" + (await T("#exactOut")) + "', title '" + (await evSafe("document.querySelector('#exactOut').title")) + "'");
      await clearToasts();
      const p1 = await prompts();
      if (bigText(sbal) < 1000) {
        // more coins than the wallet holds: said on the card, the button is off, and the wallet is never asked
        await sleep(600);
        const badSell = await TS("#tradeCard .trade-note .bad");
        const offSell = await evSafe("document.querySelector('" + buyBtn + "').disabled");
        await tryClick(buyBtn); await sleep(800);
        check(offSell && badSell.some((t) => /^Your wallet holds [\d,.]+ \S+\. That is not enough for this sell\.$/.test(t)) && (await prompts()) === p1, k + ": a sell of more coins than the wallet holds is held back in words, and the wallet is not asked", { off: offSell, said: badSell, prompts: (await prompts()) - p1 });
      } else {
        await click(buyBtn);
        await until("(() => { const t = document.querySelector('#tradeCard .tx-result'); return !!t && t.textContent.trim() !== ''; })()", 30000);
        const saidSell = await T("#tradeCard .tx-result");
        check((await prompts()) === p1 + 1 && saidSell === WALLET_NO, k + ": pressing Sell asks the wallet once and then says: " + WALLET_NO, { prompts: (await prompts()) - p1, said: saidSell });
      }
      // a sell larger than the pool can pay, on a coin on the curve
      if (mk.curveState === "open") {
        await type("#amount", "900000000"); await sleep(1200);
        const out = await outText(), why = await T("#tradeCard .trade-note .bad");
        const apiBig = (await getJson(origin + "/api/v1/quote?mint=" + P.baseMint + "&side=sell&amount=900000000000000")).json;
        check(out === "No quote" && why === "The pool cannot pay this sell. A sell on the curve is paid only from the SOL buyers put in. Sell less." && (await evSafe("document.querySelector('" + buyBtn + "').disabled")), k + ": a sell of 900,000,000 shows No quote with its reason, and the Sell button is off", { out, why });
        check(apiBig && apiBig.error && apiBig.error.code === "CURVE_REAL_RESERVE", k + ": the trade API refuses the same sell with CURVE_REAL_RESERVE", apiBig && apiBig.error && apiBig.error.code);
        await shot("C-" + k + "-sell-too-large-1440", false);
      }
      await click("#tradeCard .seg [data-dir=buy]"); await sleep(300);
      await shot("C-" + k + "-1440-full", true);
    }
    // without a wallet: the trade card has no balance, and Buy opens the wallet menu
    if (A) {
      await go("coin.html?pool=" + A.address, READY.coin, { wallet: "off" });
      await sleep(1500);
      check((await T("#tradeCard .balance")) === "", "no wallet: the trade card shows no balance");
      await type("#amount", "0.1"); await waitOut(); await sleep(600);
      check(!(await evSafe("!!document.querySelector('#exactOut')")), "no wallet: no simulation row");
      await click("#tradeCard .btn-main"); await sleep(600);
      check(!(await evSafe("document.querySelector('#menuSheet').hidden")) && /No Solana wallet found/.test((await T("#walletPop")) || ""), "no wallet: Buy opens the wallet menu, which says no wallet is found", await T("#walletPop"));
    }
    // a coin page without a pool, and with an address that is no pool
    await go("coin.html", READY.coinFail);
    check((await T("#loadMsg .card p")) === "Open a coin from the Explore page. This page needs a pool address in the URL.", "coin.html without a pool says how to open one", await T("#loadMsg .card p"));
    await go("coin.html?pool=" + STANDIN, READY.coinFail);
    check((await T("#loadMsg .card p")) === "No pool at " + STANDIN + " on " + CLUSTER + ".", "coin.html with an address that is no pool says so", await T("#loadMsg .card p"));
  });

  // ---- R. reload with the wallet remembered ---------------------------------------------------------------
  await runPart("R", "reload with the wallet remembered: balances within a few seconds", async () => {
    const targets = [];
    if (A) targets.push(["coin.html?pool=" + A.address, "coin page A", "/Balance\\s+[1-9]/.test(window.__dry.t('#tradeCard .balance span') || '')"]);
    if (B) targets.push(["coin.html?pool=" + B.address, "coin page B", "/Balance\\s+[1-9]/.test(window.__dry.t('#tradeCard .balance span') || '')"]);
    if (B) targets.push(["pool.html?pool=" + B.address, "liquidity page B", "/Wallet SOL\\s*[1-9]/.test(document.querySelector('#position') ? document.querySelector('#position').innerText : '')"]);
    for (const [pg, label, shown] of targets) {
      for (const delay of [0, 300, 4000]) {
        await go(pg, "true", { wallet: "on", remember: true, delay, ms: 1000 });
        let at = 0;
        for (let i = 0; i < 200 && !at; i++) { await sleep(100); at = await evSafe("window.__connectedAt || 0", 0); }
        const t0 = Date.now();
        const ok = await until(shown, 5000, 100);
        const took = Date.now() - t0;
        check(at > 0 && ok, label + ": the remembered wallet reconnects " + (delay ? delay + " ms late" : "at once") + " and the balance shows within 5 s", ok ? "after " + took + " ms" : "not shown: " + String((await T(pg.startsWith("pool") ? "#position" : "#tradeCard .balance")) || "").slice(0, 100));
      }
    }
  });

  // ---- L. liquidity -----------------------------------------------------------------------------------
  await runPart("L", "liquidity page: the picker, a pool on the curve (A), a graduated pool (B)", async () => {
    await go("pool.html", READY.picker, { wallet: "on" });
    const picks = await evSafe("[...document.querySelectorAll('#head .pool-pick a')].map((a) => a.getAttribute('href') + '|' + a.textContent.replace(/\\s+/g, ' ').trim())", []);
    check(picks.length === market0.pools.length, "the picker lists every pool", picks);
    if (A) check(picks.some((p) => p.includes(A.address) && /SOL raised$/.test(p)), "the picker says what Test A has raised", picks.find((p) => p.includes(A.address)));
    if (A) {
      await go("pool.html?pool=" + A.address, READY.pool + WALLET_ON, { wallet: "on" });
      await sleep(1500);
      const s = await evSafe("({ add: document.querySelector('#addCurve').hidden ? '' : document.querySelector('#addCurve').textContent, rem: document.querySelector('#removeCurve').hidden ? '' : document.querySelector('#removeCurve').textContent, amount: document.querySelector('#addAmount').disabled, pct: document.querySelector('#removePct').disabled, addBtn: document.querySelector('#addBtn').disabled, remBtn: document.querySelector('#removeBtn').disabled, modes: [...document.querySelectorAll('#addMode button')].every((b) => b.disabled), raised: window.__dry.t('#curveRaised'), locked: window.__dry.t('#lockedNote') })", {});
      check(s.add === "Liquidity opens at graduation. Until then nobody can add to this pool." && s.rem === "Liquidity opens at graduation. Until then nobody can take any out.", "A: both forms say liquidity opens at graduation", [s.add, s.rem]);
      check(s.amount && s.pct && s.addBtn && s.remBtn && s.modes, "A: both forms are off", s);
      check(/^Raised [\d.,]+ of 85 SOL$/.test(s.raised || "") && /^A pool on the curve put all its liquidity into its lock account/.test(s.locked || ""), "A: the raised line and the locked note", [s.raised, (s.locked || "").slice(0, 80)]);
      check(/Wallet SOL\s*[1-9]/.test((await evSafe("document.querySelector('#position').innerText")) || ""), "A: the wallet's position shows its SOL");
      await shot("L-A-1440", true);
    }
    if (B) {
      await go("pool.html?pool=" + B.address, READY.pool + WALLET_ON, { wallet: "on" });
      await sleep(1500);
      const sym = B.coin.symbol;
      check((await evSafe("document.querySelector('#addCurve').hidden && document.querySelector('#removeCurve').hidden && !document.querySelector('#addAmount').disabled && !document.querySelector('#addBtn').disabled")), "B: graduated, both forms are open");
      check((await T("#curveMark")) === "Graduated", "B: the Graduated mark", await T("#curveLine"));
      const locked = await KV("#locked");
      check(locked["In the lock account"] && locked["LP supply"] && locked["Locked share"], "B: the Locked forever card", locked);
      await type("#addAmount", "0.01"); await sleep(500);
      const addKv = await KV("#addKv");
      check(addKv["LP you receive"] && addKv[sym + " needed"] && addKv["SOL needed"] && addKv["Your share after"] && Object.keys(addKv).some((x) => /^Max spent with 1% room/.test(x)), "B: adding 0.01 SOL quotes LP, the coins and the SOL it needs", addKv);
      const addMsg = await T("#addMsg");
      note("B: under the add form with a wallet that holds no " + sym + ": '" + addMsg + "'");
      await click("#addMode [data-mode=lp]"); await sleep(300);
      check((await T("#addLabel")) === "LP to receive" && (await T("#addSuffix")) === "LP", "B: By LP amount switches the field to LP");
      await type("#addAmount", "1"); await sleep(400);
      check(!!(await KV("#addKv"))["LP you receive"], "B: an LP amount quotes too", await KV("#addKv"));
      await click("#addMode [data-mode=sol]"); await sleep(300);
      await type("#addAmount", "0.01"); await sleep(300);
      const p0 = await prompts();
      await click("#addBtn"); await sleep(2500);
      const addSaid = await T("#addResult");
      const askedAdd = (await prompts()) > p0;
      check(askedAdd ? addSaid === WALLET_NO : addSaid === "Your wallet holds less " + sym + " than this deposit needs.", "B: pressing Add liquidity " + (askedAdd ? "asks the wallet and reports the refusal" : "stops before the wallet: the stand-in holds no " + sym), addSaid);
      if (!askedAdd) note("B: Add liquidity could not be taken to the wallet prompt: the stand-in wallet holds no " + sym + ", and the form refuses first (correct behaviour)");
      await click("#removeQuick button:nth-child(1)"); await sleep(200);
      check((await T("#removeOut")) === "25%", "B: the 25% quick button sets the remove slider", await T("#removeOut"));
      await click("#removeQuick button:nth-child(2)"); await sleep(300);
      check((await T("#removeOut")) === "50%", "B: the 50% quick button sets the remove slider", await T("#removeOut"));
      const p1 = await prompts();
      await click("#removeBtn"); await sleep(1500);
      const remSaid = await T("#removeResult");
      const askedRem = (await prompts()) > p1;
      check(askedRem ? remSaid === WALLET_NO : remSaid === "Your wallet holds no LP of this pool.", "B: pressing Remove liquidity " + (askedRem ? "asks the wallet and reports the refusal" : "stops before the wallet: the stand-in holds no LP"), remSaid);
      if (!askedRem) note("B: Remove liquidity could not be taken to the wallet prompt: the stand-in wallet holds no LP of this pool");
      await shot("L-B-1440", true);
      await go("pool.html?pool=" + B.address, READY.pool, { wallet: "off" });
      await type("#addAmount", "0.01"); await sleep(300);
      await click("#addBtn"); await sleep(500);
      check(!(await evSafe("document.querySelector('#menuSheet').hidden")), "B without a wallet: Add liquidity opens the wallet menu");
      check((await T("#position")) === "Connect a wallet to see your LP.", "B without a wallet: Your position asks for a wallet", await T("#position"));
    }
    await go("pool.html?pool=" + STANDIN, "!/^Loading/.test(document.querySelector('#head').textContent)");
    check((await T("#head")) === "No pool at " + STANDIN + " on " + CLUSTER + ".", "pool.html with an address that is no pool says so", await T("#head"));
  });

  // ---- N. the launch chooser -----------------------------------------------------------------------------
  await runPart("N", "launch chooser and the old launch links", async () => {
    await go("launch.html", READY.chooser);
    const cards = await evSafe("[...document.querySelectorAll('.choose-card')].map((c) => c.querySelector('h2').textContent + '|' + c.querySelector('a').getAttribute('href'))", []);
    check(JSON.stringify(cards) === JSON.stringify(["Module Mode|launch-modules.html", "Collectible|launch-collectible.html", "Custom hook|launch-hook.html"]), "three cards: Module Mode, Collectible, Custom hook", cards);
    await click(".choose-card[data-path=collectible] a"); await sleep(1500);
    check(await until("location.pathname.endsWith('/launch-collectible.html')", 8000), "Open Collectible opens its page");
    for (const [from, to] of [["launch.html?template=tax", "/launch-hook.html?hook=tax"], ["launch.html?template=collectible&kind=pegged", "/launch-collectible.html?kind=pegged"], ["launch.html?template=rules", "/launch-modules.html"], ["launch.html?template=custom&hook=" + STANDIN, "/launch-hook.html?hook=" + STANDIN]]) {
      events.length = 0; leaving = Date.now();
      await call("Page.navigate", { url: origin + "/" + from }); await sleep(2000);
      const at = await evSafe("location.pathname + location.search");
      check(at === to, "the old link " + from + " goes on to " + to, at);
    }
  });

  // ---- M. Module Mode --------------------------------------------------------------------------------------
  const startNoteNow = () => TS("#startNote p");
  async function launchToWallet(label, { expectUpload }) {
    if (launchesLeft <= 0) { note(label + ": not taken to the wallet prompt, the budget of launches is spent"); return; }
    launchesLeft--;
    const p0 = await prompts(), u0 = uploads.length;
    await clearToasts();
    await click("#launchBtn");
    const done = await until("(() => { const r = document.querySelector('#result'); return !!r && r.textContent.trim() !== ''; })()", 90000, 250);
    const said = await T("#result"), step1 = await evSafe("({ cls: document.querySelector('#step1').className, d: window.__dry.t('#step1d') })", {});
    console.log("        " + label + ": result '" + said + "', step 1 " + JSON.stringify(step1) + ", prompts " + ((await prompts()) - p0) + ", uploads " + (uploads.length - u0));
    check(done && (await prompts()) === p0 + 1, label + ": the launch reaches the wallet once", "prompts " + ((await prompts()) - p0));
    check(said === WALLET_NO && step1.cls === "failed" && step1.d === WALLET_NO, label + ": the page says " + WALLET_NO + " (result and step 1)", { said, step1 });
    check((uploads.length - u0) === (expectUpload ? 1 : 0), label + ": " + (expectUpload ? "one metadata upload" : "no metadata upload (its Metadata file field names a file the site serves)"), uploads.slice(u0));
    check((await T("#launchBtn")) === "Launch" && !(await evSafe("document.querySelector('#launchBtn').disabled")), label + ": the Launch button comes back", await T("#launchBtn"));
    await shot("launch-" + label.replace(/[^a-z0-9]+/gi, "-") + "-refused", true);
  }
  await runPart("M", "Module Mode: modules, presets, strict modules, review numbers, curve and seed, first buy, image, limits", async () => {
    const ok = await go("launch-modules.html", READY.launch + WALLET_ON, { wallet: "on" });
    if (!check(ok, "Module Mode loads with the wallet")) return;
    await sleep(1500);
    const radios = () => evSafe("(() => { const c = document.querySelector('input[name=start][value=curve]'), s = document.querySelector('input[name=start][value=seed]'); return { curve: c.checked, seed: s.checked, curveOff: c.disabled, seedField: !document.querySelector('#seedField').hidden, supplyField: !document.querySelector('#supplyField').hidden, supplyFact: !document.querySelector('#supplyFact').hidden, off: document.querySelector('#startOff').hidden ? '' : document.querySelector('#startOff').textContent }; })()", {});
    let r = await radios();
    check(r.curve && !r.seedField && !r.supplyField && r.supplyFact && (await T("#supplyFactV")) === "1,000,000,000", "the form opens on the curve: no seed field, the supply fixed at 1,000,000,000", r);
    check((await T("#startCurveLine")) === "No SOL from you. It graduates at 85 SOL.", "the curve choice says it graduates at 85 SOL", await T("#startCurveLine"));
    let costs = await KV("#costs");
    check(JSON.stringify(costs) === JSON.stringify({ "Your first buy": "0 SOL", "Platform launch fee": "0.01 SOL", "Rent and network fees": "about 0.0356 SOL" }), "the cost: first buy 0, launch fee 0.01 SOL, rent about 0.0356 SOL", costs);
    check((await T("#total")) === "0.0456 SOL" && (await T("#goTotal")) === "0.0456 SOL", "the Total 0.0456 SOL, said again above the button", [await T("#total"), await T("#goTotal")]);
    const sn = await startNoteNow();
    console.log("        under the cost: " + JSON.stringify(sn));
    check(sn.length === 4 && sn[0] === "You put no SOL into the pool. The coin opens at a market cap of 30 SOL." && sn[1] === "It graduates when buyers have put 85 SOL into the pool. The platform then keeps 8.5 SOL of it." && /^At graduation about [\d.]+% of the supply is burned, so the price does not move\. A later graduation burns less\.$/.test(sn[2]) && sn[3] === "Liquidity opens at graduation.", "the curve in four sentences: 30 SOL start, 85 SOL target, 8.5 SOL (10%) graduation fee, the burn", sn);
    const buy = await KV("#revBuy"), sell = await KV("#revSell");
    check(buy["Protocol fee"] === "0.3%" && buy["Pool fee"] === "1%" && buy["In total"] === "1.3%" && sell["In total"] === "1.3%", "the review: protocol fee 0.3%, pool fee 1%, in total 1.3% a side", { buy, sell });
    check((await TS("#revNote p"))[0] === "No module is on, so this is a plain coin. Nothing runs on a trade. The two fees above are the only ones, and they never change.", "no module: the review says it is a plain coin", await TS("#revNote p"));
    for (const [v, pf, tot] of [["30", "0.3%", "0.6%"], ["300", "3%", "3.3%"], ["100", "1%", "1.3%"]]) {
      await click("label.choice:has(input[name=fee][value='" + v + "']) .title"); await sleep(300);
      const b2 = await KV("#revBuy");
      check(b2["Pool fee"] === pf && b2["In total"] === tot, "pool fee " + pf + ": the review follows", b2);
    }
    // each module
    const mods = ["sniper", "creator", "holders", "burn", "limit", "lock"];
    for (const m of mods) {
      await click("#ruleList [data-switch=" + m + "]"); await sleep(300);
      const st = await evSafe("(() => { const r = document.querySelector('#ruleList [data-rule=" + m + "]'); return { on: r.dataset.on, fields: !r.querySelector('[data-fields]').hidden, sum: r.querySelector('[data-sum]').textContent, err: r.querySelector('[data-err]').textContent, kind: window.__dry.t('#pvKind'), rent: window.__dry.kv('#costs')['Rent and network fees'], buy: window.__dry.kv('#revBuy'), problems: window.__dry.t('#revProblems') }; })()", {});
      console.log("        module " + m + ": " + JSON.stringify(st));
      check(st.on === "true" && st.fields && st.sum !== "" && st.kind === "Modules", "module " + m + " switches on: its fields open, its sum shows, the preview says Modules", st.sum);
      check(st.rent === (m === "lock" ? "about 0.0488 SOL" : "about 0.0455 SOL"), "module " + m + ": the rent of a coin with modules", st.rent);
      if (m === "lock") check(/^A lock holds your first buy, and your first buy is 0\./.test(st.err) && st.problems === "Change what is marked under Modules before you launch.", "the creator lock without a first buy says why it cannot launch", st.err);
      if (m === "creator") check(st.buy["Creator fee"] === "1%" && st.buy["In total"] === "2.3%", "the creator fee shows in the review: 1%, in total 2.3%", st.buy);
      await click("#ruleList [data-switch=" + m + "]"); await sleep(250);
      check((await evSafe("document.querySelector('#ruleList [data-rule=" + m + "]').dataset.on")) === "false", "module " + m + " switches off");
    }
    // presets
    const PRE = { creator: ["creator"], hold: ["sniper", "creator", "holders", "limit", "lock"], burn: ["creator", "holders", "burn"], sells: ["creator", "holders", "lock"] };
    for (const [p, on] of Object.entries(PRE)) {
      await click("#rulePresets [data-preset=" + p + "]"); await sleep(400);
      const st = await evSafe("({ pressed: document.querySelector('#rulePresets [data-preset=" + p + "]').getAttribute('aria-pressed'), on: [...document.querySelectorAll('#ruleList [data-rule]')].filter((r) => r.dataset.on === 'true').map((r) => r.dataset.rule), limit: document.querySelector('#rLimitSol').value })", {});
      check(st.pressed === "true" && JSON.stringify(st.on) === JSON.stringify(on), "preset " + p + " switches on " + on.join(", "), st);
      if (p === "hold") check(st.limit === "1.5", "Built to hold: the buy limit is a twentieth of the 30 virtual SOL (1.5 SOL)", st.limit);
    }
    for (const m of mods) if ((await evSafe("document.querySelector('#ruleList [data-rule=" + m + "]').dataset.on")) === "true") await click("#ruleList [data-switch=" + m + "]");
    await sleep(300);
    // the strict modules
    check(await VIS("#strictList"), "the strict modules are on the form");
    for (const s of ["maxWallet", "earlyLock", "holderRewards"]) {
      await click("#strictList [data-switch=" + s + "]"); await sleep(400);
      const st = await evSafe("({ on: document.querySelector('#strictList [data-rule=" + s + "]').dataset.on, panel: !document.querySelector('#strictPanel').hidden, lines: [...document.querySelectorAll('#strictPanel li')].map((l) => l.textContent), kind: window.__dry.t('#pvKind'), rent: window.__dry.kv('#costs')['Rent and network fees'], notes: [...document.querySelectorAll('#revNote p')].map((p) => p.textContent) })", {});
      console.log("        strict " + s + ": " + JSON.stringify(st));
      check(st.on === "true" && st.panel && st.kind === "Strict" && st.lines[0] === "This coin is a Token-2022 coin. A small program runs inside every transfer of it.", "strict " + s + ": the coin becomes strict, the cost panel shows", st.lines.length + " lines, rent " + st.rent);
      check(/^about 0\.0\d{3} SOL$/.test(st.rent || "") && st.rent !== "about 0.0356 SOL", "strict " + s + ": the rent of a strict coin", st.rent);
      if (s === "maxWallet") {
        check(st.lines.includes("The max wallet is a number of coins fixed at launch. The burn at graduation does not change it."), "strict max wallet on the curve: the panel says the burn at graduation does not change it");
        check(st.notes.some((n) => /^For the first 24 h no wallet can hold more than 1% of the supply, 10,000,000 /.test(n)), "strict max wallet: the review says 1% of the supply for 24 h", st.notes);
      }
      await click("#strictList [data-switch=" + s + "]"); await sleep(300);
    }
    check(!(await VIS("#strictPanel")) && (await T("#pvKind")) === "", "every strict module off: the panel is gone, a plain coin again");
    // curve and seed
    await click("label.choice[data-start=seed] .title"); await sleep(400);
    r = await radios(); costs = await KV("#costs");
    check(r.seed && r.seedField && r.supplyField && !r.supplyFact && costs["Seed, locked in the pool"] === "2 SOL" && (await T("#total")) === "2.0456 SOL", "Seed it yourself: the seed field, the supply field, the seed in the cost, Total 2.0456 SOL", { r, costs, total: await T("#total") });
    check(JSON.stringify(await startNoteNow()) === JSON.stringify(["The seed becomes liquidity, and the launch locks it in the pool. You get no LP for it. Nobody can withdraw it."]), "a seeded launch: the seed is locked in the pool", await startNoteNow());
    await shot("M-seed-1440", true);
    await click("label.choice[data-start=curve] .title"); await sleep(400);
    check((await radios()).curve, "the curve can be chosen again");
    // the first buy
    await type("#devBuy", "0.5"); await sleep(400);
    const first = await KV("#revFirstKv");
    check(!(await evSafe("document.querySelector('#revFirst').hidden")) && first["You pay"] === "0.5 SOL" && first["Protocol fee 0.3%"] === "0.0015 SOL" && /^[\d,.]+ \S+$/.test(first["You receive"] || ""), "a first buy of 0.5 SOL: the review shows what it pays and receives", first);
    check((await KV("#costs"))["Your first buy"] === "0.5 SOL" && (await T("#total")) === "0.5456 SOL", "the first buy is in the cost and the Total", await T("#total"));
    const fq = await evSafe("(async () => { const H = await import('/js/hookpool.js'); const q = H.quoteSwap({ direction: H.DIRECTION.BUY, amountIn: 500000000n, reserveBase: 1000000000000000n, reserveQuote: 0n, virtualQuote: 30000000000n, lpFeeBps: 100, protocolFeeBps: 30, hookFeeBps: 0, feeOverrideBps: null }); const c = await import('/common.js'); return c.fmtUnits(q.amountOut, 6, 6); })()");
    check((first["You receive"] || "").startsWith(fq + " "), "the first buy is quoted on the curve (30 virtual SOL, 1B coins)", first["You receive"] + " vs " + fq);
    // the SDK sends graduate in the launch when the buy reaches the target after the protocol fee and the
    // coin's real hook fee: none on a plain coin, so 100 SOL and 90 SOL both do (firstBuyGraduates)
    await type("#devBuy", "100"); await sleep(400);
    check(/Your first buy reaches the target of 85 SOL on its own, so the coin graduates in the launch transaction\./.test((await T("#revFirstNote")) || ""), "a first buy of 100 SOL says the coin graduates in the launch transaction", await T("#revFirstNote"));
    await type("#devBuy", "90"); await sleep(400);
    check(/Your first buy reaches the target of 85 SOL on its own, so the coin graduates in the launch transaction\./.test((await T("#revFirstNote")) || ""), "a first buy of 90 SOL on a plain coin (past the target after the protocol fee) says the coin graduates in the launch transaction", await T("#revFirstNote"));
    await type("#devBuy", "0"); await sleep(300);
    check(await evSafe("document.querySelector('#revFirst').hidden"), "a first buy of 0: no first buy in the review");
    // name and ticker limits
    await type("#name", "A".repeat(40));
    check((await evSafe("document.querySelector('#name').value.length")) === 32 && (await T("#nameCount")) === "32/32", "the name stops at 32 characters", await T("#nameCount"));
    await type("#symbol", "ab cd");
    check((await evSafe("document.querySelector('#symbol').value")) === "ABCD" && (await T("#symCount")) === "4/10", "the ticker is upper case without spaces", await evSafe("document.querySelector('#symbol').value"));
    await type("#symbol", "ABCDEFGHIJKL");
    check((await evSafe("document.querySelector('#symbol').value")) === "ABCDEFGHIJ", "the ticker stops at 10 characters", await evSafe("document.querySelector('#symbol').value"));
    check((await T("#pvTicker")) === "ABCDEFGHIJ" && (await T("#pvPair")) === "ABCDEFGHIJ / SOL", "the preview follows the ticker");
    // links
    await click("details.more > summary"); await sleep(300);
    check(await evSafe("['website', 'twitter', 'telegram', 'imageUrl', 'metaUrl'].every((i) => window.__dry.vis('#' + i))"), "Links opens the website, X, Telegram, image address and metadata file fields");
    // the image: by address, then a file
    if (B && B.coin.image) { await type("#imageUrl", B.coin.image); await sleep(1200); check((await evSafe("document.querySelector('#thumb').src")) === B.coin.image && (await evSafe("document.querySelector('#thumb').naturalWidth > 0")), "an image address shows in the thumbnail and the preview"); await type("#imageUrl", ""); }
    const obj = (await call("Runtime.evaluate", { expression: "document.querySelector('#imageFile')" })).result.objectId;
    await call("DOM.setFileInputFiles", { files: [PNG_PATH], objectId: obj });
    check(await until("document.querySelector('#thumb').src.startsWith('data:image/png') && document.querySelector('#pvImg').src.startsWith('data:image/png')", 6000), "a picked PNG shows in the thumbnail and the preview");
    // validation before anything leaves the page
    await type("#name", ""); await type("#symbol", "");
    const pv = await prompts(), uv = uploads.length;
    await click("#launchBtn"); await sleep(800);
    check((await T("#result")) === "Give the coin a name of 1 to 32 characters." && (await prompts()) === pv && uploads.length === uv, "Launch with no name says so, with no upload and no wallet prompt", await T("#result"));
    await shot("M-curve-form-1440", true);
    // launch 1: a plain coin on the curve, with its picture uploaded
    await type("#name", "Dry Run Curve"); await type("#symbol", "DRYC");
    await type("#description", "A dry run of the live site. It is never launched.");
    await launchToWallet("Module Mode curve plain coin", { expectUpload: uploadsLeft > 0 });
    // launch 2: a strict coin with a first buy, no upload
    await go("launch-modules.html", READY.launch + WALLET_ON, { wallet: "on" });
    await type("#name", "Dry Run Strict"); await type("#symbol", "DRYS"); await type("#devBuy", "0.1");
    await click("#strictList [data-switch=maxWallet]"); await sleep(300);
    await click("details.more > summary"); await sleep(200);
    await type("#metaUrl", META_URL);
    check((await T("#revProblems")) === "", "a strict coin with max wallet 1% and a first buy of 0.1 SOL has no problem marked", await T("#revProblems"));
    await launchToWallet("Module Mode strict coin", { expectUpload: false });
    // the phone: the three views
    await view(375);
    await go("launch-modules.html", READY.launch);
    for (const v of ["modules", "coin", "details"]) {
      await click("#studioTabs [data-view=" + v + "]"); await sleep(300);
      check((await evSafe("document.querySelector('#studio').dataset.view")) === v && (await evSafe("window.__dry.vis('.studio-col[data-col=" + v + "]')")), "at 375 the tab " + v + " shows its column");
      await shot("M-phone-" + v + "-375", true);
    }
  });

  // ---- K. Collectible ---------------------------------------------------------------------------------------
  await runPart("K", "Collectible: plain and pegged", async () => {
    const ok = await go("launch-collectible.html", READY.launch + WALLET_ON, { wallet: "on" });
    if (!check(ok, "Collectible loads with the wallet")) return;
    await sleep(1000);
    const st = await evSafe("({ kind: [...document.querySelectorAll('#colKind button')].map((b) => b.dataset.kind + '=' + b.getAttribute('aria-pressed')), base: document.querySelector('#colBase').value, unit: document.querySelector('#colUnit').value, share: window.__dry.t('#colUnitShare'), notes: [...document.querySelectorAll('#revNote p')].map((p) => p.textContent), rent: window.__dry.kv('#costs')['Rent and network fees'], curve: document.querySelector('input[name=start][value=curve]').checked, alt: document.querySelector('#colAltNote').hidden, kindPv: window.__dry.t('#pvKind') })", {});
    console.log("        collectible form: " + JSON.stringify(st));
    check(st.kind && st.kind.includes("plain=true") && st.curve, "it opens on a plain coin, on the curve", st.kind);
    check(st.base === origin + "/art", "the renderer base is this site's /art", st.base);
    check(st.unit === "10,000,000" && st.share === "1% of supply", "coins per piece: a hundredth of the fixed supply", [st.unit, st.share]);
    check(st.notes[0] === "The collectible hook takes no fee. The two fees above are the only ones." && /^A buy earns one piece for each 10,000,000 /.test(st.notes[1] || ""), "the review says the hook takes no fee and how pieces are earned", st.notes);
    check(st.rent === "about 0.0411 SOL" && st.kindPv === "Collectible" && st.alt, "the rent of a collectible (about 0.0411 SOL), the preview says Collectible", st.rent);
    const srcs = () => evSafe("[...document.querySelectorAll('#colArt img')].map((i) => i.src).join(',')", "");
    const s0 = await srcs();
    await ev("(() => { const r = document.querySelector('#colArt input[type=range]'); r.value = '200'; r.dispatchEvent(new Event('input', { bubbles: true })); return true; })()"); await sleep(300);
    const s1 = await srcs();
    check(s1 !== s0, "moving an art slider draws the samples again");
    await click("#colArt .art-preview button"); await sleep(300);
    check((await srcs()) !== s1, "Shuffle samples draws new samples");
    await type("#colName", "A collection name that is far too long");
    check((await T("#colNameCount")) === "24/24", "the collection name stops at 24 bytes", await T("#colNameCount"));
    await type("#colUnit", "0"); await sleep(300);
    check(/Coins per piece must be above zero\./.test((await T("#colErrA")) || ""), "coins per piece of 0 is marked", await T("#colErrA"));
    await type("#colUnit", "10,000,000");
    await type("#colBase", "ftp://nope"); await sleep(300);
    check((await T("#colErrC")) === "The renderer base must start with http.", "a renderer base that is not http is marked", await T("#colErrC"));
    await type("#colBase", origin + "/art");
    // pegged
    await click("#colKind [data-kind=pegged]"); await sleep(400);
    const pg = await evSafe("({ curve: document.querySelector('input[name=start][value=curve]').checked, curveOff: document.querySelector('input[name=start][value=curve]').disabled, cardOff: document.querySelector('label.choice[data-start=curve]').classList.contains('off'), off: window.__dry.t('#startOff'), seed: !document.querySelector('#seedField').hidden, costs: window.__dry.kv('#costs'), notes: [...document.querySelectorAll('#revNote p')].map((p) => p.textContent), rentNote: window.__dry.t('#rentNote') })", {});
    console.log("        pegged: " + JSON.stringify(pg));
    check(!pg.curve && pg.curveOff && pg.cardOff && pg.seed && pg.off === "A pegged coin cannot launch on the curve. Its pool starts with a seed you put in.", "Pegged switches the curve off and says why; the seed field is back", pg.off);
    check(pg.costs["Seed, locked in the pool"] === "2 SOL" && pg.notes.includes("This is a pegged coin. The collectible program runs inside every transfer of it, sells included.") && /^A pegged coin stores its name/.test(pg.rentNote || ""), "a pegged coin: the seed in the cost, the pegged sentence and its rent note", pg.costs);
    await click("label.choice[data-start=curve] .title"); await sleep(300);
    check(await evSafe("document.querySelector('input[name=start][value=seed]').checked"), "a click on the switched-off curve changes nothing");
    await shot("K-pegged-1440", true);
    // launch 3: a pegged coin, seeded, no upload
    await type("#name", "Dry Run Pegged"); await type("#symbol", "DRYP"); await type("#colName", "Dry pieces");
    await click("details.more > summary"); await sleep(200);
    await type("#metaUrl", META_URL);
    await launchToWallet("Collectible pegged coin", { expectUpload: false });
    await go("launch-collectible.html", READY.launch, { wallet: "on" });
    await click("#colKind [data-kind=pegged]"); await sleep(300);
    await click("#colKind [data-kind=plain]"); await sleep(300);
    check(await evSafe("document.querySelector('input[name=start][value=curve]').checked && !document.querySelector('input[name=start][value=curve]').disabled && document.querySelector('#startOff').hidden"), "back to a plain coin the curve is on again");
    note("the plain collectible coin was filled in but not taken to the wallet prompt (the budget of four launches)");
  });

  // ---- X. Custom hook ------------------------------------------------------------------------------------
  await runPart("X", "Custom hook: the platform's hooks, the custom field", async () => {
    const PROGRAMS = deployment.programs || {};
    const ok = await go("launch-hook.html", READY.launch + WALLET_ON, { wallet: "on" });
    if (!check(ok, "Custom hook loads with the wallet")) return;
    await sleep(1500);
    const opts = await evSafe("[...document.querySelectorAll('#platformHooks .hook-option')].map((b) => b.dataset.hook)", []);
    check(JSON.stringify(opts) === JSON.stringify(["tax", "launch_guard", "buyback"]), "three platform hooks: tax, launch guard, buyback", opts);
    check((await T("#taxCap")) === "10%" && (await T("#guardCap")) === "50%" && /^max [\d.]+ SOL$/.test((await T("#bbMinMax")) || ""), "the caps come from the platform account: tax 10%, guard 50%, the buyback minimum", [await T("#taxCap"), await T("#guardCap"), await T("#bbMinMax")]);
    note("communityHooks box: " + (await T("#communityHooks")));
    for (const h of opts) {
      await click("#platformHooks .hook-option[data-hook=" + h + "]"); await sleep(500);
      const st = await evSafe("({ pressed: document.querySelector('#platformHooks .hook-option[data-hook=" + h + "]').getAttribute('aria-pressed'), body: window.__dry.vis('.hook-body[data-for=" + h + "]'), buy: window.__dry.kv('#revBuy'), sell: window.__dry.kv('#revSell'), rent: window.__dry.kv('#costs')['Rent and network fees'], problems: window.__dry.t('#revProblems'), kind: window.__dry.t('#pvKind') })", {});
      console.log("        hook " + h + ": " + JSON.stringify(st));
      check(st.pressed === "true" && st.body, "the " + h + " hook opens its settings", st);
      check(Object.keys(st.buy).length >= 3 && st.buy["Protocol fee"] === "0.3%" && st.buy["Pool fee"] === "1%", "the " + h + " hook adds its row to the review", st.buy);
      if (h === "tax") check(st.buy["In total"] === "4.3%" && st.sell["In total"] === "6.3%", "the tax of 3% on buys and 5% on sells shows in total 4.3% and 6.3%", [st.buy["In total"], st.sell["In total"]]);
    }
    // the custom field
    const verdict = () => T("#customVerdict");
    const enterCustom = async (v) => { await type("#customId", v); await key("Enter", "Enter", 13); await sleep(2500); };
    await enterCustom("not-an-address");
    check((await verdict()) === "That is not a valid address.", "an invalid program id is refused", await verdict());
    await enterCustom(PROGRAMS.hook_tax);
    check((await evSafe("document.querySelector('#platformHooks .hook-option[data-hook=tax]').getAttribute('aria-pressed')")) === "true" && (await evSafe("document.querySelector('#customId').value")) === "", "the tax template's address picks the tax hook");
    await enterCustom(PROGRAMS.hook_buyback);
    check((await evSafe("document.querySelector('#platformHooks .hook-option[data-hook=buyback]').getAttribute('aria-pressed')")) === "true", "the buyback template's address picks the buyback hook");
    await enterCustom(PROGRAMS.hook_rules);
    check((await verdict()) === "This is the platform's rules program. Launch on it from Module Mode.", "the rules program's address sends to Module Mode", await verdict());
    await enterCustom(PROGRAMS.hook_collectible);
    check((await verdict()) === "This is the platform's collectible program. Launch on it from the Collectible page.", "the collectible program's address sends to the Collectible page", await verdict());
    await enterCustom(STANDIN);
    await until("!/^Reading/.test(document.querySelector('#customVerdict').textContent)", 10000);
    const v1 = await verdict();
    check(new RegExp("No account at this address on " + CLUSTER + "\\.|This account is not a program\\.").test(v1 || ""), "a wallet address is not a hook, and the form says so", v1);
    await enterCustom(PROGRAMS.hookpool);
    await until("!/^Reading/.test(document.querySelector('#customVerdict').textContent)", 10000);
    const v2 = await verdict();
    check(/refuse|No manifest/i.test(v2 || ""), "the pool program itself is refused as a hook", (v2 || "").slice(0, 300));
    await shot("X-custom-1440", true);
    await type("#customId", ""); await sleep(300);
    // launch 4: the tax hook on the curve, no upload
    await go("launch-hook.html?hook=tax", READY.launch + WALLET_ON, { wallet: "on" });
    await sleep(800);
    check((await evSafe("document.querySelector('#platformHooks .hook-option[data-hook=tax]').getAttribute('aria-pressed')")) === "true", "?hook=tax opens on the tax hook");
    await type("#name", "Dry Run Tax"); await type("#symbol", "DRYT");
    await click("details.more > summary"); await sleep(200);
    await type("#metaUrl", META_URL);
    await launchToWallet("Custom hook tax coin", { expectUpload: false });
    // a custom hook by URL
    await go("launch-hook.html?hook=" + STANDIN, READY.launch, { wallet: "on" });
    await sleep(3000);
    check((await evSafe("document.querySelector('#customId').value")) === STANDIN, "?hook=<address> fills the custom field", await verdict());
  });

  // ---- Q. Hook checker -----------------------------------------------------------------------------------
  await runPart("Q", "Hook checker: each template, the pool program, a random address", async () => {
    const PROGRAMS = deployment.programs || {};
    const ok = await go("hooks.html", READY.hooks);
    if (!check(ok, "the Hook checker loads")) return;
    const tries = await TS("#try button");
    check(JSON.stringify(tries) === JSON.stringify(["launch rules", "tax", "launch guard", "buyback", "collectible"]), "the Try buttons name the five templates", tries);
    const TPL = { "launch rules": ["hook_rules", "rules"], tax: ["hook_tax", "tax"], "launch guard": ["hook_launch_guard", "launch_guard"], buyback: ["hook_buyback", "buyback"], collectible: ["hook_collectible", "collectible"] };
    for (let i = 0; i < tries.length; i++) {
      await clearToasts();
      await click("#try button:nth-of-type(" + (i + 1) + ")");
      await until("!!document.querySelector('#checkOut .verdict') || !!document.querySelector('#checkOut .bad')", 15000);
      await sleep(300);
      const out = await evSafe("({ id: document.querySelector('#hookId').value, verdict: window.__dry.t('#checkOut .verdict'), lines: [...document.querySelectorAll('#checkOut .check-list li')].map((l) => l.className + ':' + l.textContent), launch: (document.querySelector('#checkOut a.btn') || {}).getAttribute ? document.querySelector('#checkOut a.btn').getAttribute('href') : '', solscan: (document.querySelector('#checkOut a.link') || {}).href || '' })", {});
      const [pkey, tname] = TPL[tries[i]];
      console.log("        " + tries[i] + ": " + JSON.stringify(out));
      check(out.id === PROGRAMS[pkey], tries[i] + ": the field holds " + pkey + " " + PROGRAMS[pkey], out.id);
      check(out.verdict === "A pool would accept this hook.", tries[i] + ": a pool would accept it", out.verdict);
      check(out.launch === "launch.html?template=" + tname && solscanIs(out.solscan, "account", PROGRAMS[pkey]), tries[i] + ": Launch with this hook and the Solscan link", [out.launch, out.solscan]);
    }
    for (const [label, idv, re] of [["the pool program", PROGRAMS.hookpool, /^A pool would refuse this hook\.$/], ["a random address", STANDIN, /^$/], ["an invalid address", "xyz-not-base58", /^$/]]) {
      await type("#hookId", idv); await click("#checkBtn");
      await until("!/^Reading/.test(document.querySelector('#checkOut').textContent)", 15000); await sleep(300);
      const out = await evSafe("({ verdict: window.__dry.t('#checkOut .verdict') || '', text: window.__dry.t('#checkOut') })", {});
      console.log("        " + label + ": " + JSON.stringify(out));
      if (label === "a random address") check(new RegExp("No account at this address on " + CLUSTER + "\\.|This account is not a program\\.").test(out.text), "the checker on " + label + " says it is no program", out.text);
      else if (label === "an invalid address") check(out.text === "That is not a valid address.", "the checker on " + label + " says so", out.text);
      else check(re.test(out.verdict), "the checker on " + label + ": a pool would refuse it", out.text.slice(0, 300));
    }
    await go("hooks.html?id=" + PROGRAMS.hook_tax, READY.hooks + " && !!document.querySelector('#checkOut .verdict')");
    check((await T("#checkOut .verdict")) === "A pool would accept this hook.", "hooks.html?id=<tax> checks the tax template at once");
    const pick = await evSafe("[...document.querySelectorAll('#pickList button')].length", 0);
    const texts = [];
    for (let i = 1; i <= pick; i++) { await click("#pickList button:nth-of-type(" + i + ")"); await sleep(250); texts.push(((await T("#pickPanel")) || "").slice(0, 40)); }
    check(pick >= 3 && new Set(texts).size === pick, "each template button shows its own panel (" + pick + ")", texts);
    const anchors = await evSafe("[...document.querySelectorAll('a[href^=\"#\"]')].map((a) => a.getAttribute('href')).filter((h) => h.length > 1 && !document.querySelector(h))", []);
    check(anchors.length === 0, "every anchor link of the page has its target", anchors);
  });

  // ---- W. Custom hooks pages -----------------------------------------------------------------------------
  await runPart("W", "Custom hooks: list, hook page, guide", async () => {
    await go("workshop.html", READY.workshop);
    await sleep(1000);
    const st = await evSafe("({ count: window.__dry.t('#count'), hooks: window.__dry.t('#hooks'), rpc: window.__dry.t('#rpcName') })", {});
    console.log("        workshop: " + JSON.stringify(st));
    check(/^\d+/.test(st.count || "") && !!st.hooks, "the list loads and says how many hooks", st);
    if (/did not answer/.test(st.hooks || "")) check(false, "the Custom hooks list reads the chain", st.hooks);
    await type("#search", "zzz"); await sleep(400);
    note("workshop search 'zzz': " + (await T("#hooks")));
    await type("#search", "");
    await click("#refresh"); await sleep(2000);
    check(await until(READY.workshop, 15000), "Refresh reads the list again");
    check((await evSafe("document.querySelector('#listYours').getAttribute('href')")) === "workshop-guide.html", "List your hook links the guide");
    for (const [pg, label] of [["workshop-hook.html", "no id"], ["workshop-hook.html?id=" + STANDIN, "a wallet address"], ["workshop-hook.html?id=" + (deployment.programs || {}).hook_tax, "the tax template"]]) {
      await go(pg, READY.wsHook);
      await sleep(1500);
      const s = await evSafe("({ state: document.querySelector('#state').hidden ? '' : window.__dry.t('#state'), page: !document.querySelector('#page').hidden, name: window.__dry.t('#name') })", {});
      console.log("        workshop-hook " + label + ": " + JSON.stringify(s));
      check(!!s.state || s.page, "workshop-hook with " + label + " shows a state or a page", s);
    }
    // the guide
    await go("workshop-guide.html", READY.guide);
    for (const n of [1, 2, 3, 4]) {
      // a step that is open already (the first one is, when the page opens) is not clicked: a click closes it
      if ((await evSafe("document.querySelector('#step" + n + "Head').getAttribute('aria-expanded')")) !== "true") { await click("#step" + n + "Head"); await sleep(300); }
      check((await evSafe("document.querySelector('#step" + n + "Head').getAttribute('aria-expanded')")) === "true" && (await VIS("#step" + n + "Body")), "guide step " + n + " opens");
      if (n === 1) {
        const r0 = await T("#flagRust");
        const boxes = await evSafe("document.querySelectorAll('#flagCalls input, #flagPowers input').length", 0);
        if (boxes) { await click("#flagCalls li:first-child label"); await sleep(300); }
        const r1 = await T("#flagRust");
        check(boxes > 0 && r1 !== r0, "step 1: ticking a flag changes the Rust line", { boxes, before: r0, after: r1 });
        note("step 1 words: " + JSON.stringify(await TS("#flagWords li")));
      }
      if (n === 2) check(/cp -r hook-template my-hook/.test((await T("#cmdCopy")) || ""), "step 2: the commands are shown");
      if (n === 3) {
        await type("#gProgram", STANDIN); await type("#gName", "Dry hook"); await type("#gSummary", "A hook named for a dry run."); await type("#gRules", "It refuses nothing.");
        await sleep(500);
        const g = await evSafe("({ verdict: window.__dry.t('#gVerdict'), errors: [...document.querySelectorAll('#gErrors li')].map((l) => l.textContent), json: document.querySelector('#gJson').textContent, upload: !document.querySelector('#gUpload').hidden })", {});
        let parsed = null; try { parsed = JSON.parse(g.json); } catch (_) {}
        console.log("        guide descriptor: " + JSON.stringify({ verdict: g.verdict, errors: g.errors, upload: g.upload }));
        check(!!parsed && parsed.programmable_hook === 1 && !!g.verdict, "step 3: the form writes a hook.json and judges it", g.verdict);
        await clearToasts(); await click("#gCopy"); await sleep(400);
        check((await evSafe("window.__dry.toasts()", [])).includes("Copied"), "step 3: Copy copies the hook.json", await evSafe("window.__dry.toasts()", []));
        await click("#gDownload"); await sleep(800);
        note("step 3: Download pressed (the browser saves into the out folder); the Upload button is " + (g.upload ? "shown, and was not pressed" : "hidden"));
      }
      if (n === 4) {
        await type("#gUrl", META_URL || origin + "/deployments/" + CLUSTER + ".json"); await click("#gRead"); await sleep(3000);
        note("step 4 Read the address with a coin's metadata file: " + JSON.stringify({ note: await T("#gDeployNote"), deploy: await T("#gDeploy"), pin: await T("#gPinNote") }));
        const deployLine = await T("#gDeploy");
        if (deployLine) check(deployLine.endsWith("bash scripts/deploy-freeze.sh " + CLUSTER), "step 4: the deploy command names this site's cluster (" + CLUSTER + ")", deployLine);
        check(!!(await T("#gDeployNote")), "step 4: Read the address answers in words");
      }
    }
    await shot("W-guide-1440", true);
  });

  // ---- D. Docs -----------------------------------------------------------------------------------------
  await runPart("D", "Docs: every number from the chain, anchors, the curve section", async () => {
    // the curve numbers are filled after a second import (launch-core.js); the fee span is empty in the HTML, so it says when they are in
    const ok = await go("docs.html", READY.docs + " && document.querySelector('[data-curve=fee]').textContent !== ''");
    if (!check(ok, "the docs page fills its numbers")) return;
    const facts = await evSafe("({ empty: [...document.querySelectorAll('[data-plat], [data-curve], [data-burn], [data-rules], [data-setup]')].filter((n) => n.textContent.trim() === '').map((n) => n.outerHTML.slice(0, 60)), plat: [...document.querySelectorAll('[data-plat]')].map((n) => n.dataset.plat + '=' + n.textContent), curve: [...document.querySelectorAll('[data-curve]')].map((n) => n.dataset.curve + '=' + n.textContent), cluster: window.__dry.t('#clusterName'), programs: [...document.querySelectorAll('#programRows tr')].map((r) => r.children[0].textContent + '=' + r.querySelector('a').title), bounds: document.querySelectorAll('#rulesBounds tr').length, strict: document.querySelectorAll('#strictBounds tr').length, feeHidden: document.getElementById('curveFee') ? document.getElementById('curveFee').hidden : null })", {});
    console.log("        docs: " + JSON.stringify(facts));
    check(facts.empty.length === 0, "every number placeholder is filled", facts.empty);
    const plat = Object.fromEntries(facts.plat.map((s) => s.split("=")));
    check(plat.protocolFeeBps === "0.3%" && plat.launchFeeLamports === "0.01 SOL" && plat.maxHookFeeBps === "10%" && /50%/.test(plat.maxFeeOverrideBps || ""), "the platform's numbers: protocol fee 0.3%, launch fee 0.01 SOL, hook cap 10%, fee override cap 50%", plat);
    const cv = Object.fromEntries(facts.curve.map((s) => s.split("=")));
    check(cv.virtual === "30 SOL" && cv.target === "85 SOL" && cv.fee === "8.5 SOL" && cv.supply === "1,000,000,000" && /^[\d.]+%$/.test(cv.burn || "") && facts.feeHidden === false, "the curve section: 30 virtual SOL, target 85 SOL, the 8.5 SOL fee, 1,000,000,000 coins, the burn", cv);
    const solOf = (t) => Number(String(t || "").replace(/[^\d.]/g, ""));
    check(cv.afterSol && Math.abs(solOf(cv.afterSol) - (solOf(cv.target) - solOf(cv.fee))) < 0.005, "the curve section: after graduation the pool holds the target less the fee", [cv.afterSol, cv.target, cv.fee]);
    check(facts.cluster === CLUSTER, "the docs name the cluster", facts.cluster);
    const progs = Object.fromEntries(facts.programs.map((s) => s.split("=")));
    check(Object.keys(deployment.programs || {}).every((k) => progs[k] === deployment.programs[k]), "the program table names every program of deployments/" + CLUSTER + ".json", progs);
    check(facts.bounds === 8 && facts.strict === 4, "the bounds tables are filled (8 rules, 4 strict)", [facts.bounds, facts.strict]);
    const broken = await evSafe("[...document.querySelectorAll('a[href^=\"#\"]')].map((a) => a.getAttribute('href')).filter((h) => h.length > 1 && !document.querySelector(h))", []);
    check(broken.length === 0, "every anchor of the docs has its target", broken);
    await click("a[href='#start']"); await sleep(600);
    check((await evSafe("location.hash")) === "#start" && (await evSafe("Math.abs(document.querySelector('#start').getBoundingClientRect().top) < 200")), "a click on the curve section's link scrolls to it");
    // the section is the heading #start and what follows it up to the next h2
    const startTxt = (await evSafe("(() => { let n = document.querySelector('#start'), out = ''; for (let e = n.nextElementSibling; e && e.tagName !== 'H2'; e = e.nextElementSibling) out += ' ' + e.textContent; return out.replace(/\\s+/g, ' ').trim(); })()")) || "";
    check(/85 SOL/.test(startTxt) && /30 SOL/.test(startTxt) && !/bonding curve/i.test(startTxt), "the curve section speaks of 30 and 85 SOL, never of a bonding curve", startTxt.slice(0, 300));
    await shot("D-docs-1440", true);
  });

  // ---- A. the trade API and the watcher's files ------------------------------------------------------------
  await runPart("A", "trade API (quote, swap with simulate) and the watcher's public files", async () => {
    const api = origin + "/api/v1";
    for (const [k, P] of COINS.slice(0, 2)) {
      for (const [side, amount] of [["buy", "100000000"], ["sell", "1000000000"]]) {
        const r = await getJson(api + "/quote?mint=" + P.baseMint + "&side=" + side + "&amount=" + amount);
        check(r.status === 200 && r.json && r.json.pool === P.address && BigInt(r.json.outAmount) > 0n && r.json.fees.protocol.bps === 30 && r.json.fees.pool.bps === 100, k + ": GET /quote " + side + " " + amount + " answers 200 with fees 0.3% and 1%", r.json ? { out: r.json.outAmount, min: r.json.minOutAmount, curve: r.json.curve && r.json.curve.state, rpc: r.headers.get("x-rpc-calls") } : r.text.slice(0, 200));
      }
      const s = await getJson(api + "/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint: P.baseMint, side: "buy", amount: "10000000", userPublicKey: STANDIN, simulate: true }) });
      check(s.status === 200 && s.json && s.json.simulation && s.json.simulation.outAmount === s.json.quote.outAmount && typeof s.json.transaction === "string", k + ": POST /swap buy 0.01 SOL with simulate: true builds and simulates (never signed, never sent)", s.json ? { sim: s.json.simulation, instructions: s.json.instructions } : s.text.slice(0, 200));
      const s2 = await getJson(api + "/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint: P.baseMint, side: "sell", amount: "1000000000", userPublicKey: STANDIN, simulate: true }) });
      check(s2.status === 422 && s2.json && s2.json.error && s2.json.error.code === "INSUFFICIENT_FUNDS", k + ": POST /swap sell for a wallet without coins answers INSUFFICIENT_FUNDS", s2.json && s2.json.error);
    }
    if (A) {
      const r = await getJson(api + "/quote?mint=" + A.baseMint + "&side=sell&amount=100000000000");
      check(r.status === 422 && r.json.error.code === "CURVE_REAL_RESERVE" && r.json.error.maxAmount, "A: a sell above the real SOL answers CURVE_REAL_RESERVE with maxAmount", r.json && r.json.error);
    }
    const errs = [
      ["mint=11111111111111111111111111111111&side=buy&amount=1000", 404, "POOL_NOT_FOUND"], ["mint=notamint&side=buy&amount=1000", 400, "INVALID_PARAMETER"],
      ["mint=" + (A || B).baseMint + "&side=buy&amount=0", 400, "INVALID_PARAMETER"], ["mint=" + (A || B).baseMint + "&side=buy&amount=1.5", 400, "INVALID_PARAMETER"],
      ["mint=" + (A || B).baseMint + "&side=buy&amount=99999999999999999999", 400, "INVALID_PARAMETER"], ["mint=" + (A || B).baseMint + "&side=hold&amount=1000", 400, "INVALID_PARAMETER"],
      ["mint=" + (A || B).baseMint + "&side=buy", 400, "INVALID_PARAMETER"], ["mint=" + (A || B).baseMint + "&side=buy&amount=1000&slippageBps=6000", 400, "INVALID_PARAMETER"],
      ["mint=" + (A || B).baseMint + "&side=buy&amount=1", 422, "CANNOT_QUOTE"],
    ];
    for (const [qs, status, code] of errs) {
      const r = await getJson(api + "/quote?" + qs);
      check(r.status === status && r.json && r.json.error && r.json.error.code === code && typeof r.json.error.message === "string", "GET /quote?" + qs.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/, "<mint>") + " answers " + status + " " + code, r.json && r.json.error);
    }
    const bad = await getJson(api + "/swap", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
    check(bad.status === 400 && bad.json.error.code === "INVALID_JSON", "POST /swap with a body that is not JSON answers INVALID_JSON");
    const m1 = await getJson(api + "/quote", { method: "POST", body: "{}" });
    check(m1.status === 405 && m1.json.error.code === "METHOD_NOT_ALLOWED", "POST /quote answers 405");
    // the watcher
    const h = await getJson(origin + "/watcher/health");
    check(h.status === 200 && h.json && h.json.ok === true && h.json.cluster === CLUSTER && !h.json.stale && !h.json.feedStale, "/watcher/health: ok, mainnet, not stale", h.json && { pools: h.json.pools, ageSeconds: h.json.ageSeconds, feedLagSlots: h.json.feedLagSlots });
    const pj = await getJson(origin + "/watcher/pools.json");
    check(pj.status === 200 && pj.json && pj.json.pools && Object.keys(pj.json.pools).length === market0.pools.length, "/watcher/pools.json has every pool", pj.json && Object.keys(pj.json.pools || {}).length);
    if (pj.json && pj.json.pools) {
      const failing = Object.entries(pj.json.pools).filter(([, v]) => v.buySim && !v.buySim.ok);
      check(failing.length === 0, "/watcher/pools.json: the watcher's buy and sell checks run on every pool", failing.map(([k, v]) => k.slice(0, 8) + ": " + String(v.buySim.error).slice(0, 160)));
    }
    const mj = await getJson(origin + "/watcher/market.json");
    check(mj.status === 200 && mj.json && Array.isArray(mj.json.pools) && mj.json.cluster === CLUSTER, "/watcher/market.json answers with every pool", mj.json && mj.json.pools.length);
    for (const [k, P] of COINS) {
      const t = await getJson(origin + "/watcher/trades/" + P.address + ".json");
      const evs = (t.json && t.json.events) || [];
      const keys = evs.map((e) => e.kind + ":" + e.signature);
      const dups = keys.length - new Set(keys).size;
      check(t.status === 200 && t.json && t.json.pool === P.address, k + ": /watcher/trades/<pool>.json answers", evs.length + " events");
      check(dups === 0, k + ": the trades file lists each event once", dups + " events are listed twice");
      if (P.curveState === "graduated") check(!!(t.json && t.json.curve && t.json.curve.graduated), k + ": a graduated pool's trades file has its Graduated event", t.json && t.json.curve);
    }
    const t404 = await getJson(origin + "/watcher/trades/" + STANDIN + ".json");
    check(t404.status === 404, "/watcher/trades/<not a pool>.json answers 404", t404.status);
  });
} finally {
  // ---- the end: what was seen everywhere, and the browser closed through its own port ----
  part = "END";

  console.log("\nsummary");
  // the site's own requests: its origin, its RPC and the chart library's CDN. Anything else is another host (a coin's picture).
  const site = (u) => { const h = hostOf(u); return !h || h === new URL(origin).host || h === RPC_HOST || /(^|\.)unpkg\.com$/.test(h); };
  const real = issues.filter((i) => i.kind !== "canceled" && !String(i.where).startsWith("(tool)"));
  const grouped = new Map();
  for (const i of real) { const k = i.kind + " | " + String(i.text).replace(/\d{6,}/g, "N").slice(0, 220); const g = grouped.get(k) || { count: 0, pages: new Set(), site: site(i.url), sample: i }; g.count++; g.pages.add(i.where.split(" ")[0]); grouped.set(k, g); }
  for (const [k, g] of grouped) console.log("  issue x" + g.count + (g.site ? " [site]" : " [other host]") + "  " + k + "  pages: " + [...g.pages].slice(0, 8).join(", "));
  const canceled = issues.filter((i) => i.kind === "canceled");
  if (canceled.length) console.log("  requests the pages canceled themselves (not by navigation): " + canceled.length + ", first: " + canceled.slice(0, 3).map((c) => c.where + " " + c.text).join(" || "));
  const methods = {};
  for (const r of rpcLog) for (const m of r.methods) methods[m] = (methods[m] || 0) + 1;
  console.log("  RPC methods the pages called: " + JSON.stringify(methods));
  console.log("  sendTransaction attempts blocked in the browser: " + sendBlocked + ", unreadable RPC bodies blocked: " + unreadableBlocked);
  console.log("  metadata uploads: " + uploads.filter((u) => u.status === "sent").length + " sent (" + JSON.stringify(uploads) + "), " + uploadsRefused + " refused here");
  const fails = results.filter((r) => !r.ok);
  console.log("  checks: " + results.length + ", passed " + (results.length - fails.length) + ", failed " + fails.length);
  for (const f of fails) console.log("    FAIL [" + f.part + "] " + f.name + (f.detail ? "  -- " + f.detail.slice(0, 300) : ""));
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ origin, standin: STANDIN, results, notes, issues, warnings: warnings.slice(0, 200), rpcMethods: methods, sendBlocked, unreadableBlocked, uploads, uploadsRefused, shots }, null, 1));
  try { ws.close(); } catch (_) {}
  console.log(await edge.close());

}
process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
