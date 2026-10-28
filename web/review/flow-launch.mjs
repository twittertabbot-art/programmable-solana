// Review tool: the shell and the launch paths of the site, end to end, in headless Edge with
// real mouse and keyboard input, signed by throwaway wallets made here (localnet only,
// airdropped, never written to disk).
//   node web/review/flow-launch.mjs <site origin> <out prefix> [parts]
//   node web/review/flow-launch.mjs http://localhost:8787 web/review/h-launch
// X. the shell: the header (mark, two links, menu), the menu (the other pages and the wallet),
//    connecting a wallet from a page's own button, the footer, and the same on a phone.
// O. links made for the earlier single form land on the page that took its place.
// N. Module Mode with every module off: a plain coin with no hook.
// M. Module Mode with a preset: a coin with modules, a first buy and a creator lock. Then a
//    second wallet buys on the coin page.
// C. Collectible, plain coin.   P. Collectible, pegged coin.
// T. Custom hook, platform hook Tax to treasury.   G. Launch guard.   B. Buyback and burn.
// H. Custom hook, a hook somebody else built, picked from the list on the page. The hook this
//    part knows how to set up is the program of hook-template/: it has no descriptor and wants
//    a config of its own for each pool, which the form tells the launcher to create before
//    step 2. The run creates it the way a launcher would, with one instruction of the hook.
// E. Explore: a card for each coin launched above with the kind it runs, search, a filter.
// L. the other pages load in the shell, without a script error or a sideways scroll: coin,
//    pool, hook checker, docs, the workshop pages.
// S. screenshots at 1440 and 390 of the header and footer, Explore, the chooser, Module Mode
//    empty and with a preset, the review, the Collectible page and the Custom hook page.
// R. the rebuilt pages at 375, 768, 1024 and 1440: no sideways scroll, and on a touch screen
//    every control at least 44 px high.
// K. Module Mode with every strict module on and a creator lock: the cost panel, the review
//    against the SDK, the config on chain; then on the coin page a buy that registers, a buy above
//    the cap and an early sell refused (page and chain), the send form, Claim to the lamport, and
//    the burn button through its steps. It waits for the coin's early window (2 min).
// W. the wallet says no: a refused signature on the trade card, the liquidity page and the launch
//    page gives one sentence where the eye is, and the page goes back to its idle state.
// "parts": all (the default), or some of X,O,N,M,C,P,T,G,B,H,K,W,E,L,R,S.
// One line per check, "  ok    ..." or "  FAIL  ...". The test validator at 127.0.0.1:8899 and
// the site are only read and traded on: nothing is stopped, restarted or deployed. The browser
// is started and closed by edge.mjs. The form's own metadata upload is not used (it writes
// files under web/uploads/): the Metadata file field gets a JSON address the site already serves.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, FLAGS, PROGRAMS, RULES_POLICY, RULES_KIND, decodeRulesConfig, rulesPda, pda, rulesErrorFromLogs, strictMaxWalletAmount } from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";
// the site's name as the pages read it (web/config.js): the footer and the titles carry it
import CONFIG from "../config.js";
const SITE_NAME = String((CONFIG.site && CONFIG.site.name) || "").trim().slice(0, 40);

const [origin, prefix, partsArg = "all"] = process.argv.slice(2);
if (!origin || !prefix) { console.error("usage: node web/review/flow-launch.mjs <site origin> <out prefix> [parts]"); process.exit(1); }
const PARTS = ["X", "O", "N", "M", "C", "P", "T", "G", "B", "H", "K", "W", "E", "L", "R", "S"];
const wanted = partsArg === "all" ? PARTS : partsArg.split(",").map((s) => s.trim().toUpperCase());
for (const w of wanted) if (!PARTS.includes(w)) { console.error("unknown part " + w + ". Parts: " + PARTS.join(", ")); process.exit(1); }
const want = (part) => wanted.includes(part);
const RPC = "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const W = 1440, HGT = 1300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);
const say = (label, value) => console.log("        " + (label + ":").padEnd(30) + " " + (typeof value === "string" ? value : JSON.stringify(value, (k, v) => (typeof v === "bigint" ? String(v) : v))));
let total = 0, failed = 0;
const failures = [];
const check = (ok, text) => { total++; if (!ok) { failed++; failures.push(text); } console.log((ok ? "  ok    " : "  FAIL  ") + text); return !!ok; };
const fund = async (kp, sol) => conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
const plat = await client.platform();
if (!plat) { console.error("no platform account on " + RPC); process.exit(1); }
const solText = (lamports) => (Number(lamports) / 1e9).toFixed(6);
const rawSol = (text) => { const m = /\d[\d,]*(?:\.\d+)?/.exec(String(text || "")); return m ? BigInt(Math.round(Number(m[0].replace(/,/g, "")) * 1e9)) : null; };

// ---- the browser ------------------------------------------------------------------------------------
const run = String(Math.floor(Math.random() * 900) + 100);
const edge = await startEdge({ name: "launch", width: W, height: HGT });
let id = 0; const pending = new Map(); const events = []; const pageErrors = [];
let ws = null, where = "about:blank", walletScriptId = null;
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
const shots = [];
const shot = async (name, full) => {
  await call("Page.bringToFront").catch(() => {});
  let params = { format: "png" };
  if (full) {
    const m = await call("Page.getLayoutMetrics");
    params = { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 9000), scale: 1 } };
  }
  const s = await call("Page.captureScreenshot", params);
  writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64")); shots.push(prefix + name + ".png");
  console.log("        wrote " + prefix + name + ".png");
};
const until = async (expression, ms = 30000, step = 150) => { for (let t = 0; t < ms; t += step) { try { if (await ev(expression)) return true; } catch (_) {} await sleep(step); } return false; };
const mouse = (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const clearToasts = async () => { await ev("(() => { for (const t of document.querySelectorAll('#toasts .toast')) t.click(); return true; })()"); await sleep(300); };
/// A real click in the middle of an element, after bringing it into view.
async function click(selector) {
  const at = () => ev("(() => { const e = document.querySelector(" + q(selector) + "); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width, b.height]; })()");
  if (!(await at())) throw new Error("nothing matches " + selector);
  for (let attempt = 0; ; attempt++) {
    await ev("document.querySelector(" + q(selector) + ").scrollIntoView({ block: 'center' }); true");
    await sleep(120);
    const [x, y] = await at();
    const top = await ev("(() => { const e = document.elementFromPoint(" + x + ", " + y + "); const want = document.querySelector(" + q(selector) + "); return !!e && (e === want || want.contains(e)); })()");
    if (top) { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); return; }
    if (attempt > 0) throw new Error("something covers " + selector);
    await clearToasts();
  }
}
/// Click a field, clear it, type into it the way a keyboard would.
async function type(selector, text) {
  await click(selector);
  await ev("(() => { const e = document.querySelector(" + q(selector) + "); e.select(); return true; })()");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  if (text) await call("Input.insertText", { text });
  await sleep(250);
}
const standin = (kp) => JSON.stringify({ secret: Array.from(kp.secretKey), address: kp.publicKey.toBase58() });
/// The stand-in wallet. A later wallet is handed over through localStorage. `remember`: the
/// site finds the wallet connected, as after an earlier visit. Without it the page must connect.
const walletScript = (kp) => `
  (() => {
    let who = ${standin(kp)};
    try { const s = localStorage.getItem("__standin"); if (s) who = JSON.parse(s); } catch (_) {}
    if (localStorage.getItem("__forget") === "1") localStorage.removeItem("Programmable.wallet"); else localStorage.setItem("Programmable.wallet", "phantom");
    const SECRET = who.secret, ADDRESS = who.address;
    window.__who = ADDRESS; window.__signPrompts = 0;
    const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(SECRET)); };
    // what Phantom checks before it shows a request: a transaction that someone already signed, or
    // one that fails when simulated against the chain as it is, is blocked as "could be malicious".
    // Every such transaction is noted (across pages, in localStorage) for the run's final check.
    const flag = (why) => { try { const a = JSON.parse(localStorage.getItem("__phantomFlags") || "[]"); a.push(why); localStorage.setItem("__phantomFlags", JSON.stringify(a)); } catch (_) {} };
    const phantomCheck = async (tx) => {
      if (tx.signatures.some((s) => s.some((b) => b !== 0))) flag(location.pathname + ": handed to the wallet already signed by another key");
      try {
        const H = await import("/js/hookpool.js");
        const r = await new H.Connection("http://127.0.0.1:8899", "confirmed").simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
        if (r.value.err) flag(location.pathname + ": fails simulation before signing: " + JSON.stringify(r.value.err) + " | " + (r.value.logs || []).slice(-2).join(" | "));
      } catch (e) { flag(location.pathname + ": could not be simulated: " + e.message); }
    };
    const publicKey = { toBase58: () => ADDRESS };
    const w = { isPhantom: true, publicKey, on() {}, disconnect: async () => {},
      connect: async () => ({ publicKey }),
      signTransaction: async (tx) => { window.__signPrompts++; if (window.__rejectNext) { window.__rejectNext = false; throw Object.assign(new Error("User rejected the request."), { code: 4001 }); } await phantomCheck(tx); tx.sign([await key()]); return tx; },
      signAllTransactions: async (txs) => { window.__signPrompts++; const k = await key(); for (const t of txs) { await phantomCheck(t); t.sign([k]); } return txs; } };
    window.phantom = { solana: w };
  })();`;
const waitLoad = async () => { for (let i = 0; i < 200 && !events.includes("Page.loadEventFired"); i++) await sleep(100); };
/// Open a page of the site as one of the throwaway wallets and wait until `ready` holds.
async function open(kp, path, ready, forget = false) {
  if (!walletScriptId) walletScriptId = (await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript(kp) })).identifier;
  // the first page of the run: a file of the site, so its storage can be written before the real page loads
  if (where === "about:blank") { events.length = 0; await call("Page.navigate", { url: origin + "/package.json" }); await waitLoad(); where = "/package.json"; }
  await ev("localStorage.setItem(\"__standin\", " + JSON.stringify(standin(kp)) + "); localStorage.setItem(\"__forget\", " + q(forget ? "1" : "0") + "); true");
  for (let attempt = 0; attempt < 2; attempt++) {
    events.length = 0; where = path;
    await call("Page.navigate", { url: origin + path });
    await waitLoad();
    if (await until(ready, 14000)) { await sleep(500); return; }
    // the page sometimes boots before the stand-in wallet is injected: connect it the way the page would
    if (!forget && !(await ev("!!document.querySelector('#walletBtn.on')"))) {
      await ev("(async () => { try { const W = await import('/wallet.js'); const H = await import('/js/hookpool.js'); if (W.available().length) await W.connect(W.available()[0], H.PublicKey); } catch (_) {} return true; })()");
      if (await until(ready, 8000)) { await sleep(500); return; }
    }
    console.log("        note: the page was not ready, loading it once more: " + path);
  }
  throw new Error("the page did not get ready: " + path);
}
async function view(width, height) {
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setTouchEmulationEnabled", { enabled: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(400);
}
const overflow = () => ev("document.documentElement.scrollWidth <= window.innerWidth");
/// The page's timing marks of the last trade, from the click: "pool read +12, quoted +40, ...".
async function tradeTiming(what) {
  const marks = JSON.parse(await ev("JSON.stringify(window.__trace || [])"));
  if (!marks.length) { say(what, "no marks"); return null; }
  const t0 = marks[0][1];
  say(what, marks.map(([k, t]) => k + " +" + (t - t0)).join(", "));
  const at = (k) => { const m = marks.find((x) => x[0] === k); return m ? m[1] - t0 : null; };
  return { toSign: at("sign requested"), toSent: at("sent"), blockhash: at("blockhash requested") };
}
const text = (selector) => ev("(() => { const e = document.querySelector(" + q(selector) + "); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()");
const visible = (selector) => ev("(() => { const e = document.querySelector(" + q(selector) + "); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })()");
{
  ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    const page = String(where || "").split("?")[0];
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === "Runtime.exceptionThrown") pageErrors.push(page + "  EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") pageErrors.push(page + "  console.error " + d.params.args.map((a) => a.value || a.description).join(" "));
    else if (d.method) events.push(d.method);
  };
  await call("Page.enable"); await call("Runtime.enable");
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await view(W, HGT);
}

// ---- wallets and what was launched ------------------------------------------------------------------
const dev = Keypair.generate(), trader = Keypair.generate(), visitor = Keypair.generate();
await Promise.all([fund(dev, 30), fund(trader, 3), fund(visitor, 1)]);
/// What each launch part made: { part, pool, symbol, kind }.
const made = [];
const launchReady = "!!document.querySelector('#walletBtn.on') && !!document.querySelector('#launchBtn') && !!document.querySelector('#costs dd') && document.querySelector('#launchBtn').textContent === 'Launch'";
const reviewOf = () => ev("(() => { const kv = (id) => { const o = {}; const d = document.querySelector(id); if (!d) return o; const dt = [...d.querySelectorAll('dt')], dd = [...d.querySelectorAll('dd')]; dt.forEach((t, i) => { o[(t.firstChild ? t.firstChild.textContent : t.textContent).trim()] = dd[i] ? dd[i].textContent.trim() : ''; }); return o; }; return { buy: kv('#revBuy'), sell: kv('#revSell'), costs: kv('#costs'), total: document.querySelector('#total').textContent, notes: [...document.querySelectorAll('#revNote p')].map((p) => p.textContent), problems: document.querySelector('#revProblems').textContent, kind: document.querySelector('#pvKind').textContent, pair: document.querySelector('#pvPair').textContent, name: document.querySelector('#pvName').textContent }; })()");

/// The launch form opens on the curve. The launches of this flow are seeded: pick "Seed it
/// yourself" the way a launcher would (a pegged coin has it picked already). flow-curve.mjs
/// launches on the curve.
async function seedMode() {
  if (await ev("!!document.querySelector('input[name=start][value=seed]') && !document.querySelector('input[name=start][value=seed]').checked")) await click("label.choice:has(input[name=start][value=seed]) .title");
}
/// Fill the coin's own fields on a launch page. The Metadata file field sits under Links. `opts.curve`
/// leaves the form on the curve (its default) instead of seeding the pool.
async function fillCoin(name, symbol, firstBuy, opts = {}) {
  if (await visible("#studioTabs")) await click("#studioTabs [data-view=details]");
  await type("#name", name);
  await type("#symbol", symbol);
  if (!opts.curve) { await seedMode(); await type("#seed", "1"); }
  await type("#devBuy", firstBuy);
  if (!(await ev("document.querySelector('details.more').open"))) await click("details.more > summary");
  await type("#metaUrl", origin + "/package.json?coin=" + symbol.toLowerCase());
}
/// Press Launch and wait for the end. Returns what the page and the chain say about it.
async function launchAndCheck(part, what, symbol, expect) {
  const r = { ok: false };
  const before = BigInt(await conn.getBalance(dev.publicKey));
  const rev = await reviewOf();
  r.review = rev;
  say(what + ": a buy pays", rev.buy); say(what + ": a sell pays", rev.sell); say(what + ": costs", { ...rev.costs, Total: rev.total });
  check(rev.problems === "", what + ": the review names no problem before the launch" + (rev.problems ? " (" + rev.problems + ")" : ""));
  check(rev.kind === expect.kind, what + ": the preview's kind label is \"" + expect.kind + "\" (" + JSON.stringify(rev.kind) + ")");
  check(rev.pair === symbol + " / SOL", what + ": the preview shows the pair " + symbol + " / SOL");
  check(Object.keys(rev.buy).includes("Protocol fee") && Object.keys(rev.buy).includes("Pool fee") && Object.keys(rev.buy).includes("In total"), what + ": the review lists the protocol fee, the pool fee and a total");
  await clearToasts();
  const prompts0 = await ev("window.__signPrompts");
  await click("#launchBtn");
  const done = await until("!!document.querySelector('#result a.btn') || !!document.querySelector('#result .bad')", 120000, 250);
  const bad = await text("#result .bad");
  if (!check(done && !bad, what + ": the launch went through" + (bad ? " (the page says: " + bad + ")" : done ? "" : " (no result after two minutes; step 1: " + (await text("#step1")) + "; step 2: " + (await text("#step2")) + ")"))) return r;
  const prompts = (await ev("window.__signPrompts")) - prompts0;
  check(prompts === 2, what + ": two wallet prompts (" + prompts + ")");
  check((await text("#launchBtn")) === "Launched", "the button reads Launched and stays shut");
  const href = await ev("document.querySelector('#result a.btn').getAttribute('href')");
  const poolKey = new PublicKey(/pool=([1-9A-HJ-NP-Za-km-z]+)/.exec(href)[1]);
  const pool = await client.pool(poolKey);
  r.pool = poolKey; r.poolAccount = pool;
  if (!check(!!pool, what + ": the pool " + poolKey.toBase58() + " is on chain")) return r;
  if (expect.hook === null) check(!pool.hasHook, what + ": the pool has no hook");
  else if (expect.hook) check(pool.hasHook && pool.hookProgram.equals(expect.hook), what + ": the pool runs " + expect.hookName + " (" + (pool.hasHook ? pool.hookProgram.toBase58() : "no hook") + ")");
  if (expect.curve) check(pool.reserveQuote === 0n && pool.virtualQuote > 0n, what + ": the pool opened on the curve, with no SOL from the launcher (" + solText(pool.reserveQuote) + " SOL raised, " + solText(pool.virtualQuote) + " virtual)");
  else check(pool.reserveQuote >= 1_000_000_000n, what + ": the pool holds the seed of 1 SOL and what the first buy added (" + solText(pool.reserveQuote) + " SOL)");
  const spent = before - BigInt(await conn.getBalance(dev.publicKey));
  const shown = rawSol(rev.total);
  say(what + ": spent against Total", solText(spent) + " SOL spent, Total " + rev.total);
  if (expect.ownAccounts) say(what + ": note", "a custom hook can create accounts of its own, so the Total is a floor here");
  else check(shown !== null && spent <= shown && shown - spent < 6_000_000n, what + ": the wallet spent no more than the Total, and within 0.006 SOL of it (" + solText(spent) + " of " + solText(shown || 0n) + ")");
  made.push({ part, pool: poolKey, symbol, kind: expect.kind });
  r.ok = true;
  return r;
}
/// Follow "Open <symbol>" to the coin page and see that it works in the new shell.
async function openCoin(what, symbol) {
  events.length = 0;
  await clearToasts();
  await click("#result a.btn");
  await waitLoad();
  const ok = await until("!!document.querySelector('#tradeCard .btn-buy') && !document.querySelector('#layout').hidden && !!document.querySelector('#siteHeader .menu-btn')", 30000);
  where = "/coin.html";
  check(ok, what + ": Open " + symbol + " leads to the coin page, with its trade box, inside the new header");
  check(await overflow(), what + ": the coin page does not scroll sideways at 1440");
  return ok;
}

try {
  // ---- X. the shell ---------------------------------------------------------------------------------
  if (want("X")) {
    console.log("\nX. the shell: header, menu, wallet, footer");
    await open(visitor, "/launch-modules.html", "!!document.querySelector('#launchBtn') && !!document.querySelector('#costs dd') && !!document.querySelector('#menuBtn')", true);
    const head = await ev("(() => { const h = document.querySelector('#siteHeader'); const b = h.getBoundingClientRect(); const links = [...h.querySelectorAll('.site-nav a')].filter((a) => a.getBoundingClientRect().width > 0).map((a) => a.textContent); const mark = h.querySelector('.site-mark').getBoundingClientRect(); const menu = h.querySelector('#menuBtn').getBoundingClientRect(); const nav = h.querySelector('.site-nav').getBoundingClientRect(); return { height: b.height, position: getComputedStyle(h).position, links, markLeft: mark.left, menuRight: innerWidth - menu.right, navCentre: Math.round(nav.left + nav.width / 2), current: (h.querySelector('.site-nav a[aria-current=page]') || {}).textContent || '' }; })()");
    say("header at 1440", head);
    check(head.height === 88 && head.position === "sticky", "the header is 88 px high and sticks to the top");
    check(head.links.join("|") === "Explore|Launch a token", "the centre holds Explore and Launch a token");
    check(Math.abs(head.navCentre - 720) <= 2, "the two links sit in the middle of the header (centre at " + head.navCentre + " of 1440)");
    check(head.markLeft < 80 && head.menuRight < 80, "the mark is at the left and the menu button at the right");
    check(head.current === "Launch a token", "the link of the page that is open is marked as current");
    check(!(await visible("#menuSheet")), "the menu is shut at first");
    check((await text("#launchBtn")) === "Connect wallet", "with no wallet the page's main button reads Connect wallet");
    // the page's own button opens the menu on the wallet
    await click("#launchBtn");
    check(await until("(() => { const s = document.querySelector('#menuSheet'); const p = document.querySelector('#walletPop'); return !!s && !s.hidden && !!p && !p.hidden && !!p.querySelector('.item'); })()", 4000), "a press on it opens the menu with the wallets to choose from");
    await sleep(350);
    check(await visible("#menuSheet"), "the menu stays open after that press");
    const items = await ev("[...document.querySelectorAll('#menuSheet .menu-item')].filter((a) => a.getBoundingClientRect().width > 0).map((a) => a.textContent.trim())");
    say("menu at 1440", items);
    check(items.join("|") === "Custom hooks|Hook checker|Docs|Connect wallet", "the menu holds Custom hooks, Hook checker, Docs and the wallet");
    await shot("-menu-1440");
    await click("#walletPop .item");
    check(await until("!!document.querySelector('#walletBtn.on')", 8000), "choosing the wallet connects it");
    check(await until("document.querySelector('#launchBtn').textContent === 'Launch'", 4000), "the main button now reads Launch");
    check(await ev("!document.querySelector('#menuBtn .on-dot').hidden"), "the menu button carries a mark while a wallet is connected");
    // Escape shuts the menu
    if (!(await visible("#menuSheet"))) await click("#menuBtn");
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    check(await until("document.querySelector('#menuSheet').hidden", 2000), "Escape shuts the menu");
    await click("#menuBtn"); await sleep(250);
    await click("#siteFooter .foot-risk p");
    check(await until("document.querySelector('#menuSheet').hidden", 2000), "a click outside shuts the menu");
    const foot = await ev("(() => { const f = document.querySelector('#siteFooter'); return { labels: [...f.querySelectorAll('.foot-label')].map((l) => l.textContent), product: [...f.querySelectorAll('.foot-col')[0].querySelectorAll('a')].map((a) => a.textContent), resources: [...f.querySelectorAll('.foot-col')[1].querySelectorAll('a')].map((a) => a.textContent), risk: f.querySelector('.foot-risk p').textContent, name: (f.querySelector('.foot-name') || {}).textContent || '', mark: !!f.querySelector('.foot-brand svg, .foot-brand img') }; })()");
    say("footer", foot);
    check(foot.labels.join("|") === "Product|Resources|Risk notice", "the footer has three columns: Product, Resources, Risk notice");
    check(foot.mark && foot.name === SITE_NAME, SITE_NAME ? "the footer shows the mark and the name set in config.js (\"" + SITE_NAME + "\")" : "with no name set the footer shows the plain mark and no name");
    check((foot.risk.match(/\./g) || []).length === 2, "the risk notice is two sentences");
    // every link of the menu and the footer leads to a page the server has
    const hrefs = await ev("[...new Set([...document.querySelectorAll('#siteHeader a[href], #siteFooter a[href]')].map((a) => a.getAttribute('href').split('?')[0]).filter((h) => !/^https?:/.test(h)))]");
    const dead = [];
    for (const h of hrefs) { const res = await fetch(origin + "/" + h); if (!res.ok) dead.push(h); }
    check(dead.length === 0, "every link of the header, the menu and the footer answers (" + hrefs.length + " pages" + (dead.length ? ", dead: " + dead.join(", ") : "") + ")");
    // a phone
    await view(390, 844);
    await open(visitor, "/index.html", "!!document.querySelector('#menuBtn') && (!!document.querySelector('#grid .coin-card:not(.ghost)') || !document.querySelector('#empty').hidden)");
    const phone = await ev("(() => { const h = document.querySelector('#siteHeader'); return { height: h.getBoundingClientRect().height, links: [...h.querySelectorAll('.site-nav a')].filter((a) => a.getBoundingClientRect().width > 0).map((a) => a.textContent), menu: h.querySelector('#menuBtn').getBoundingClientRect().width }; })()");
    say("header at 390", phone);
    check(phone.links.join("|") === "Launch a token", "on a phone the centre keeps Launch a token only");
    check(phone.menu >= 44, "the menu button is at least 44 px wide on a phone");
    await click("#menuBtn"); await sleep(300);
    const pItems = await ev("[...document.querySelectorAll('#menuSheet .menu-item')].filter((a) => a.getBoundingClientRect().width > 0).map((a) => ({ t: a.textContent.trim(), h: Math.round(a.getBoundingClientRect().height) }))");
    check(pItems[0] && pItems[0].t === "Explore", "on a phone the menu starts with Explore");
    check(pItems.every((i) => i.h >= 44), "every row of the menu is at least 44 px high (" + pItems.map((i) => i.h).join(", ") + ")");
    check(await overflow(), "the page does not scroll sideways at 390 with the menu open");
    await shot("-menu-390");
    await click("#menuBtn");
    await view(W, HGT);
  }

  // ---- O. older links ---------------------------------------------------------------------------------
  if (want("O")) {
    console.log("\nO. links made for the earlier single form");
    const lands = async (from, page, ready, what) => {
      events.length = 0; where = from;
      await ev("localStorage.setItem(\"__forget\", \"0\"); true").catch(() => {});
      await call("Page.navigate", { url: origin + from });
      await waitLoad();
      const ok = await until("location.pathname === " + q(page) + " && (" + ready + ")", 15000);
      check(ok, from + " lands on " + page + ": " + what + (ok ? "" : " (now at " + (await ev("location.pathname + location.search")) + ")"));
    };
    if (!walletScriptId) walletScriptId = (await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript(visitor) })).identifier;
    await lands("/launch.html?template=rules", "/launch-modules.html", "!!document.querySelector('#ruleList .module')", "the modules");
    await lands("/launch.html?template=none", "/launch-modules.html", "!!document.querySelector('#ruleList .module')", "the modules, all off");
    await lands("/launch.html?template=collectible&kind=pegged", "/launch-collectible.html", "document.querySelector('#colKind [data-kind=pegged]').getAttribute('aria-pressed') === 'true'", "the pegged coin picked");
    await lands("/launch.html?template=tax", "/launch-hook.html", "document.querySelector('[data-hook=tax]').getAttribute('aria-pressed') === 'true' && !document.querySelector('.hook-body[data-for=tax]').hidden", "Tax to treasury picked, its fields open");
    await lands("/launch.html?template=launch_guard", "/launch-hook.html", "document.querySelector('[data-hook=launch_guard]').getAttribute('aria-pressed') === 'true'", "Launch guard picked");
    await lands("/launch.html?template=buyback", "/launch-hook.html", "document.querySelector('[data-hook=buyback]').getAttribute('aria-pressed') === 'true'", "Buyback and burn picked");
    const some = PROGRAMS.hook_tax.toBase58();
    await lands("/launch.html?template=custom&hook=" + some, "/launch-hook.html", "document.querySelector('[data-hook=tax]').getAttribute('aria-pressed') === 'true'", "a platform hook's own program id opens that platform hook");
    const stray = Keypair.generate().publicKey.toBase58();
    await lands("/launch.html?template=custom&hook=" + stray, "/launch-hook.html", "document.querySelector('#customId').value === " + q(stray) + " && /No account at this address/.test(document.querySelector('#customVerdict').textContent)", "a program id is filled in and checked");
    events.length = 0; where = "/launch.html";
    await call("Page.navigate", { url: origin + "/launch.html" }); await waitLoad();
    check(await until("document.querySelectorAll('#choose .choose-card').length === 3 && !!document.querySelector('#menuBtn')", 10000), "launch.html alone is the chooser with three cards");
    const cards = await ev("[...document.querySelectorAll('#choose .choose-card')].map((c) => ({ title: c.querySelector('h2').textContent, words: c.querySelector('p').textContent, to: c.querySelector('a.btn').getAttribute('href'), buttons: c.querySelectorAll('a.btn, button').length }))");
    say("chooser", cards);
    check(cards.map((c) => c.title).join("|") === "Module Mode|Collectible|Custom hook", "the cards are Module Mode, Collectible and Custom hook");
    check(cards.every((c) => c.buttons === 1), "each card has one button");
    check(cards.map((c) => c.to).join("|") === "launch-modules.html|launch-collectible.html|launch-hook.html", "each button leads to its own page");
  }

  // ---- N. a plain coin ------------------------------------------------------------------------------
  if (want("N")) {
    console.log("\nN. Module Mode, every module off: a plain coin");
    const sym = "PLN" + run;
    await open(dev, "/launch-modules.html", launchReady);
    const rows = await ev("[...document.querySelectorAll('#ruleList .module')].map((m) => ({ name: m.querySelector('.module-name').firstChild.textContent, on: m.querySelector('[role=switch]').getAttribute('aria-checked'), h: Math.round(m.querySelector('.module-head').getBoundingClientRect().height) }))");
    say("modules", rows);
    check(rows.map((r) => r.name).join("|") === "Sniper fee|Creator fee|Rewards|Burn|Buy limit|Creator lock", "the modules are Sniper fee, Creator fee, Rewards, Burn, Buy limit and Creator lock");
    check(rows.every((r) => r.on === "false"), "every module starts off");
    check(rows.every((r) => r.h >= 44), "every module row is at least 44 px high");
    check(await ev("!document.querySelector('#strictList').hidden && [...document.querySelectorAll('#strictList [role=switch]')].every((b) => b.getAttribute('aria-checked') === 'false') && document.querySelector('#strictPanel').hidden"), "the strict modules have a group of their own, all off, and the strict coin panel shows only when one is on");
    check(!/coming soon|not live|soon\b/i.test(await ev("document.body.innerText")), "nothing on the page says that something comes later");
    await fillCoin("Plain Path " + run, sym, "0.05");
    const r = await launchAndCheck("N", "plain coin", sym, { kind: "", hook: null });
    if (r.ok) {
      check(/plain coin/.test(r.review.notes.join(" ")), "the review says that this is a plain coin");
      check(r.review.buy["In total"] === "1.2%" && r.review.sell["In total"] === "1.2%", "a buy and a sell pay the protocol fee and the pool fee, 1.2% in total");
      await openCoin("plain coin", sym);
    }
  }

  // ---- M. a coin with modules -------------------------------------------------------------------------
  if (want("M")) {
    console.log("\nM. Module Mode with the preset Built to hold");
    const sym = "MOD" + run;
    await open(dev, "/launch-modules.html", launchReady);
    await fillCoin("Module Path " + run, sym, "0.04");
    await click("#rulePresets [data-preset=hold]");
    await sleep(400);
    const on = await ev("[...document.querySelectorAll('#ruleList .module')].filter((m) => m.querySelector('[role=switch]').getAttribute('aria-checked') === 'true').map((m) => m.dataset.rule + ' ' + m.querySelector('[data-sum]').textContent)");
    say("modules on", on);
    check(on.length === 5 && on.some((t) => t.startsWith("lock")), "the preset switches five modules on, the creator lock among them");
    check(await ev("document.querySelector('#rulePresets [data-preset=hold]').getAttribute('aria-pressed') === 'true'"), "the preset's chip is marked");
    check(!(await ev("document.querySelector('#revFirst').hidden")) && !(await ev("document.querySelector('#revLock').hidden")), "the review shows the first buy and the lock");
    // a number over a bound is said under its own field and stops the launch
    await type("#rCreatorBuy", "9");
    const err = await text("[data-err=creator]");
    check(/The most is 2%/.test(err || ""), "a creator fee of 9% gets a sentence under its own fields (" + err + ")");
    check(/Modules/.test((await text("#revProblems")) || ""), "the line above the button says that something under Modules must change");
    const p0 = await ev("window.__signPrompts");
    await click("#launchBtn"); await sleep(700);
    check((await ev("window.__signPrompts")) === p0 && /Check the modules/.test((await text("#result")) || ""), "Launch asks for no signature while the problem stands");
    await type("#rCreatorBuy", "0.5");
    const r = await launchAndCheck("M", "coin with modules", sym, { kind: "Modules", hook: PROGRAMS.hook_rules, hookName: "the rules program" });
    if (r.ok) {
      const info = await conn.getAccountInfo(rulesPda.cfg(r.pool));
      const cfg = info ? decodeRulesConfig(new Uint8Array(info.data)) : null;
      say("config on chain", cfg ? { buy: cfg.buy, sell: cfg.sell, sniperStartFeeBps: cfg.sniperStartFeeBps, sniperSlots: cfg.sniperSlots, maxBuyQuote: cfg.maxBuyQuote, limitSlots: cfg.limitSlots, creatorLockSeconds: cfg.creatorLockSeconds } : null);
      check(!!cfg && cfg.buy.creatorBps === 50 && cfg.sell.creatorBps === 50 && cfg.buy.holdersBps === 100 && cfg.sell.holdersBps === 100 && cfg.buy.burnBps === 0, "the coin's rules on chain are the preset's: creator fee 0.5%, rewards 1%, no burn");
      check(!!cfg && cfg.sniperStartFeeBps === 3000 && Number(cfg.sniperSlots) === 300 && cfg.maxBuyQuote === 50_000_000n && Number(cfg.limitSlots) === 1500, "sniper fee 30% for 300 slots, buy limit 0.05 SOL for 1,500 slots");
      check(!!cfg && Number(cfg.creatorLockSeconds) === Math.min(90 * 86400, RULES_POLICY.creatorLockSeconds), "creator lock of 90 days");
      const lock = await client.rulesLock(r.pool);
      check(!!lock && lock.vaultBalance > 0n, "the first buy sits in the lock account (" + (lock ? String(lock.vaultBalance) : "none") + " raw units)");
      check(/locked until/.test((await text("#lockedLine")) || ""), "the page says until when the first buy is locked");
      check(r.review.buy["Creator fee"] === "0.5%" && r.review.buy["Rewards"] === "1%" && r.review.buy["In total"] === "2.7%", "the review listed creator fee 0.5%, rewards 1% and 2.7% in total for a buy");
      if (await openCoin("coin with modules", sym)) {
        // a second wallet buys on the coin page, in the new shell
        await open(trader, "/coin.html?pool=" + r.pool.toBase58(), "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on') && !document.querySelector('#layout').hidden");
        const p = await client.pool(r.pool);
        const had = await client.tokenBalance(trader.publicKey, p.baseMint, p.baseTokenProgram);
        await click("#tradeCard .seg [data-dir=buy]");
        await type("#amount", "0.02");
        await until("(document.querySelector('#tradeCard .out .v') || {}).textContent !== '0' && !!(document.querySelector('#exactOut') || {}).textContent", 15000);
        await sleep(500); await clearToasts();
        await ev("window.__traceTrades = true; window.__trace = []; true");
        await click("#tradeCard .btn-buy");
        await until("(() => { const t = document.querySelector('#tradeCard .tx-result'); return !!t && (/Bought|Sold/.test(t.textContent) || !!t.querySelector('.bad')); })()", 60000, 200);
        const said = await text("#tradeCard .tx-result");
        const tm = await tradeTiming("M, first buy of a new wallet on a fresh pool, from the click");
        check(!!tm && tm.toSign !== null && tm.toSign < 3000, "the wallet is asked within 3 s of the click on a fresh pool (" + (tm ? tm.toSign : "?") + " ms)");
        const got = (await client.tokenBalance(trader.publicKey, p.baseMint, p.baseTokenProgram)) - had;
        check(/Bought/.test(said || "") && got > 0n, "a second wallet buys 0.02 SOL of it on the coin page (" + (said || "").slice(0, 90) + ")");
        await shot("-coin-after-buy-1440");
        // sell it back so the wallet ends as it began
        try {
          const ixs = await client.swapInstructions(trader.publicKey, await client.pool(r.pool), await client.hookRef(await client.pool(r.pool), trader.publicKey), DIRECTION.SELL, got, 0n);
          const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(trader.publicKey, ixs); tx.sign([trader]);
          await conn.confirmTransaction({ signature: await conn.sendTransaction(tx), blockhash, lastValidBlockHeight }, "confirmed");
        } catch (e) { console.log("        note: could not sell back: " + e.message); }
      }
    }
  }

  // ---- C and P. collectibles ---------------------------------------------------------------------------
  for (const [part, pegged] of [["C", false], ["P", true]]) {
    if (!want(part)) continue;
    console.log("\n" + part + ". Collectible, " + (pegged ? "pegged coin" : "plain coin"));
    const sym = (pegged ? "PEG" : "COL") + run;
    await open(dev, "/launch-collectible.html", launchReady);
    if (pegged) {
      await click("#colKind [data-kind=pegged]");
      check(await ev("!document.querySelector('[data-kind-body=pegged]').hidden && document.querySelector('[data-kind-body=plain]').hidden && /What a pegged coin costs/.test(document.querySelector('[data-kind-body=pegged]').textContent)"), "picking the pegged coin shows what it costs, in a panel of its own");
    }
    await type("#colName", "Path " + run);
    await fillCoin("Collectible Path " + run, sym, "0.05");
    const r = await launchAndCheck(part, pegged ? "pegged collectible" : "collectible", sym, { kind: "Collectible", hook: PROGRAMS.hook_collectible, hookName: "the collectible program" });
    if (r.ok) {
      check(client.isPegged(r.poolAccount) === pegged, "the coin on chain is " + (pegged ? "a pegged coin" : "a plain coin"));
      check(/earned pieces/.test((await text("#result")) || ""), "the page says that the first buy earned pieces");
      await openCoin(pegged ? "pegged collectible" : "collectible", sym);
    }
    // Review R5 (round 9): the form's default is no first buy, and a collectible launch with none failed on the
    // live site before the wallet opened ("amount must be greater than zero": the deposit of the first buy was
    // quoted before the check that there is one). The same launch with first buy 0: a plain coin on the curve
    // (the form's default start), a pegged coin seeded (it cannot launch on the curve).
    const sym0 = (pegged ? "PEGZ" : "COLZ") + run;
    const what0 = (pegged ? "pegged collectible" : "collectible on the curve") + " with no first buy";
    await open(dev, "/launch-collectible.html", launchReady);
    if (pegged) await click("#colKind [data-kind=pegged]");
    await type("#colName", "Zero " + run);
    await fillCoin("Collectible Zero " + run, sym0, "0", { curve: !pegged });
    const rev0 = await reviewOf();
    check(rev0.costs["Your first buy"] === "0 SOL" && !rev0.costs["Deposit for its NFTs"] && /^about [\d.]+ SOL$/.test(rev0.costs["Rent and network fees"] || ""), what0 + ": the cost panel shows a first buy of 0, no deposit row, and the rent priced at the chain's rent (" + rev0.costs["Rent and network fees"] + ")");
    const r0 = await launchAndCheck(part + "0", what0, sym0, { kind: "Collectible", hook: PROGRAMS.hook_collectible, hookName: "the collectible program", curve: !pegged });
    if (r0.ok) {
      check(client.isPegged(r0.poolAccount) === pegged, what0 + ": the coin on chain is " + (pegged ? "a pegged coin" : "a plain coin"));
      check(!/earned pieces/.test((await text("#result")) || ""), what0 + ": the page does not say that a first buy earned pieces");
    }
  }

  // ---- T, G, B. platform hooks ----------------------------------------------------------------------------
  for (const [part, hook, name, program, extra] of [["T", "tax", "Tax to treasury", PROGRAMS.hook_tax, "Tax"], ["G", "launch_guard", "Launch guard", PROGRAMS.hook_launch_guard, ""], ["B", "buyback", "Buyback and burn", PROGRAMS.hook_buyback, "Buyback"]]) {
    if (!want(part)) continue;
    console.log("\n" + part + ". Custom hook, platform hook " + name);
    const sym = part + "PH" + run;
    await open(dev, "/launch-hook.html", launchReady);
    if (part === "T") {
      const groups = await ev("[...document.querySelectorAll('.launch-set .module-group > h3')].map((h) => h.textContent)");
      check(groups.join("|") === "Platform hooks|Community hooks", "Platform hooks are listed before Community hooks");
      const opts = await ev("[...document.querySelectorAll('#platformHooks .hook-option b')].map((b) => b.textContent)");
      check(opts.join("|") === "Tax to treasury|Launch guard|Buyback and burn", "the platform hooks are Tax to treasury, Launch guard and Buyback and burn");
      // with no hook picked the launch is refused in words
      await fillCoin("Hook Path " + run, sym, "0.05");
      const p0 = await ev("window.__signPrompts");
      await click("#launchBtn"); await sleep(600);
      check((await ev("window.__signPrompts")) === p0 && /Pick a hook first/.test((await text("#result")) || ""), "with no hook picked, Launch says to pick one and asks for no signature");
    } else await fillCoin("Hook Path " + run, sym, "0.05");
    await click("#platformHooks [data-hook=" + hook + "]");
    check(await ev("!document.querySelector('.hook-body[data-for=" + hook + "]').hidden && [...document.querySelectorAll('.hook-body')].filter((b) => !b.hidden).length === 1"), "picking " + name + " opens its fields and no other hook's");
    const r = await launchAndCheck(part, name, sym, { kind: "Platform hook", hook: program, hookName: name });
    if (r.ok) {
      if (extra) check(extra in r.review.buy && extra in r.review.sell, "the review names the " + extra.toLowerCase() + " on a buy and on a sell (" + r.review.buy[extra] + ", " + r.review.sell[extra] + ")");
      else check(/higher pool fee/.test(r.review.notes.join(" ")), "the review says that buys pay a higher pool fee at first");
      await openCoin(name, sym);
    }
  }

  // ---- H. a community hook -----------------------------------------------------------------------------
  if (want("H")) {
    console.log("\nH. Custom hook, a hook somebody else built");
    const sym = "CMH" + run;
    await open(dev, "/launch-hook.html", launchReady);
    const listed = await until("!!document.querySelector('#communityHooks .hook-option')", 20000);
    if (!check(listed, "the page lists the hooks other people built")) say("community list", await text("#communityHooks"));
    else {
      const list = await ev("[...document.querySelectorAll('#communityHooks .hook-option')].map((b) => ({ name: b.querySelector('b').textContent, id: b.dataset.hookId }))");
      say("community hooks", list);
      const TEMPLATE_FLAGS = FLAGS.BEFORE_SWAP | FLAGS.ON_POOL_CREATE | FLAGS.TAKE_HOOK_FEE | FLAGS.CALL_ON_BUY | FLAGS.CALL_ON_SELL;
      const all = await client.allPools();
      const flagsOf = (hook) => (all.find((p) => p.hasHook && p.hookProgram.toBase58() === hook) || {}).hookFlags;
      const pickIt = list.find((h) => flagsOf(h.id) === TEMPLATE_FLAGS) || list[0];
      const hookId = pickIt.id, isTemplate = flagsOf(hookId) === TEMPLATE_FLAGS;
      list[0] = pickIt;
      await fillCoin("Community Path " + run, sym, "0.05");
      await click("#communityHooks .hook-option[data-hook-id=\"" + hookId + "\"]");
      check(await until("document.querySelector('#customId').value === " + q(hookId) + " && !!document.querySelector('#customVerdict .verdict')", 20000), "picking " + list[0].name + " fills in its program id and checks it on chain");
      await until("!document.querySelector('#customSetup').hidden || document.querySelector('#customVerdict .verdict.bad')", 15000);
      await sleep(800);
      check(await ev("document.querySelector('#communityHooks .hook-option[aria-pressed=true]').dataset.hookId === " + q(hookId) + " && [...document.querySelectorAll('#platformHooks .hook-option')].every((b) => b.getAttribute('aria-pressed') === 'false')"), "the picked hook is marked in the list and no platform hook is");
      const verdict = await text("#customVerdict .verdict");
      check(/would accept/.test(verdict || ""), "the check says that the pool would accept it (" + verdict + ")");
      check(await visible("#customPool"), "the page says where the pool will be");
      const setupSays = (await text("#customSetup")) || "";
      say("the hook's own settings", setupSays.slice(0, 260));
      await shot("-hook-community-1440", true);
      // a hook without a descriptor that keeps settings for each pool: the launcher creates them, as the form says
      if (isTemplate && /published no descriptor/.test(setupSays)) {
        const poolKey = new PublicKey(await text("#customPool .mono"));
        const disc = createHash("sha256").update("global:init_pool_config").digest().subarray(0, 8);
        const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
        const hook = new PublicKey(hookId);
        const ixn = new TransactionInstruction({ programId: hook, data: Buffer.concat([disc, poolKey.toBuffer(), u16(250), u16(500)]), keys: [
          { pubkey: dev.publicKey, isSigner: true, isWritable: true }, { pubkey: dev.publicKey, isSigner: true, isWritable: false },
          { pubkey: pda.cfg(hook, poolKey), isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }] });
        const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(dev.publicKey, [ixn]); tx.sign([dev]);
        const res = await conn.confirmTransaction({ signature: await conn.sendTransaction(tx), blockhash, lastValidBlockHeight }, "confirmed");
        check(!res.value.err, "the launcher creates the hook's settings for the pool address the form names (2.5% on buys, 5% on sells)");
      }
      const r = await launchAndCheck("H", "community hook " + list[0].name, sym, { kind: "Custom hook", hook: new PublicKey(hookId), hookName: list[0].name, ownAccounts: true });
      if (r.ok) await openCoin("community hook", sym);
    }
  }

  // ---- K. a strict coin ---------------------------------------------------------------------------------
  if (want("K")) {
    console.log("\nK. Module Mode with every strict module on and a creator lock, then the coin page");
    const sym = "STR" + run, name = "Strict Path " + run;
    const buyer = Keypair.generate(), friend = Keypair.generate();
    await Promise.all([fund(buyer, 3), fund(friend, 1)]);
    const fmtUnits = (v, decimals, maxFrac = 4) => { v = BigInt(v); const base = 10n ** BigInt(decimals); const frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, ""); return (v / base).toLocaleString("en-US") + (frac ? "." + frac : ""); };
    const SUPPLY = 1_000_000_000n * 1_000_000n;
    /// Send by hand, without the page. Returns the name of the rule that refused it, or "" when it went through.
    const refusedBy = async (ixs, signers) => {
      try {
        const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs); tx.sign(signers);
        const sig = await conn.sendTransaction(tx);
        const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        return r.value.err ? JSON.stringify(r.value.err) : "";
      } catch (e) { const info = rulesErrorFromLogs(e.logs || []) || rulesErrorFromLogs(String(e.message).split("\n")); return info ? info.name : String(e.message).slice(0, 120); }
    };
    await open(dev, "/launch-modules.html", launchReady);
    check(await ev("!document.querySelector('#strictList').hidden && document.querySelectorAll('#strictList .module').length === 3"), "Module Mode shows the strict modules in a group of their own: " + (await ev("[...document.querySelectorAll('#strictList .module-name')].map((n) => n.firstChild.textContent).join(', ')")));
    await fillCoin(name, sym, "0.01");
    for (const k of ["creator", "burn", "lock"]) await click("[data-switch=" + k + "]");
    await type("#rCreatorBuy", "1"); await type("#rCreatorSell", "1");
    await type("#rBurnBuy", "0.5"); await type("#rBurnSell", "0.5");
    await type("#rLockDays", "1");
    for (const k of ["maxWallet", "earlyLock", "holderRewards"]) await click("[data-switch=" + k + "]");
    await type("#sMaxWalletPct", "3"); await type("#sMaxWalletHours", "0.25");
    await type("#sEarlyMin", "2"); await type("#sEarlyUnlockHours", "0.2");
    await type("#sHoldBuy", "1"); await type("#sHoldSell", "1");
    await sleep(600);
    const panel = await text("#strictPanel");
    const facts = ["Token-2022", "runs inside every transfer", "Jupiter will probably not route it", "trade API", "Fewer wallets and exchanges", "standard token account", "One person with several wallets can pass it", "nobody can add liquidity", "cannot be sold or sent until the unlock", "Buyers see this before they buy", "registered once", "inside the wallet's first buy", "small rent, once", "keeps your first buy in your own wallet", "final at launch"];
    const missing = facts.filter((f) => !(panel || "").includes(f));
    check(!!panel && missing.length === 0, "the strict coin's panel says every fact a launcher must be told" + (missing.length ? " (missing: " + missing.join("; ") + ")" : ""));
    say("strict panel", (panel || "").slice(0, 400));
    const rev = await reviewOf();
    const cap = strictMaxWalletAmount(SUPPLY, 300);
    const capText = (Number(cap / 1_000_000n)).toLocaleString("en-US");
    check(rev.notes.some((n) => n === "For the first 15 min no wallet can hold more than 3% of the supply, " + capText + " " + sym + "."), "the review gives the cap in coins, " + capText + " " + sym + ", the SDK's strictMaxWalletAmount");
    check(rev.notes.some((n) => /^Coins bought in the first 2 min cannot be sold or sent until about .*, your local time\. Your first buy is one of them\.$/.test(n)), "the review gives the early window and the unlock, and says that the first buy is early");
    check(rev.buy.Rewards === "1%" && rev.notes.some((n) => /registered/.test(n)), "the review sends rewards to registered holders");
    check(/stay in your own wallet/.test((await text("#revLockText")) || ""), "the review says the first buy stays in the creator's own wallet under the lock");
    await shot("-strict-form-1440", true);
    await view(390, 844);
    await shot("-strict-form-390", true);
    await click("#studioTabs [data-view=coin]"); await sleep(200); await shot("-strict-review-390", true);
    await click("#studioTabs [data-view=details]"); await sleep(200);
    await view(W, HGT);
    const r = await launchAndCheck("K", "strict coin", sym, { kind: "Strict", hook: PROGRAMS.hook_rules, hookName: "the rules program" });
    if (r.ok) {
      const info = await conn.getAccountInfo(rulesPda.cfg(r.pool));
      const cfg = info ? decodeRulesConfig(new Uint8Array(info.data)) : null;
      say("strict config on chain", cfg ? { kind: cfg.kind, maxWalletBps: cfg.maxWalletBps, maxWalletSlots: cfg.maxWalletSlots, earlySlots: cfg.earlySlots, earlyUnlockSlots: cfg.earlyUnlockSlots, maxWalletAmount: cfg.maxWalletAmount, buy: cfg.buy } : null);
      check(!!cfg && cfg.kind === RULES_KIND.STRICT && cfg.maxWalletBps === 300 && Number(cfg.maxWalletSlots) === 2250 && Number(cfg.earlySlots) === 300 && Number(cfg.earlyUnlockSlots) === 1800 && cfg.maxWalletAmount === cap
        && cfg.buy.holdersBps === 100 && cfg.buy.creatorBps === 100 && cfg.buy.burnBps === 50, "chain: the coin is strict with the form's numbers: 3% for 2,250 slots, early 300 slots, unlock after 1,800, rewards 1%, creator 1%, burn 0.5%");
      const lock = await client.rulesLock(r.pool);
      check(!!lock && lock.locked, "chain: the creator lock holds the first buy in the creator's wallet");
      // the coin page, as a buyer
      const coinReady = "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on') && !document.querySelector('#strictCard').hidden && !document.querySelector('#layout').hidden";
      // the launcher on its own coin: a quick-amount chip gives a quote or a sentence, never a bare 0
      await open(dev, "/coin.html?pool=" + r.pool.toBase58(), coinReady);
      await click("#tradeCard .quick button");
      await until("(document.querySelector('#tradeCard .out .v') || {}).textContent !== '0' || !!document.querySelector('#tradeCard .trade-note .bad')", 15000);
      await sleep(800);
      const own = await ev("(() => { const c = document.querySelector('#tradeCard'); return { amount: document.querySelector('#amount').value, out: c.querySelector('.out .v').textContent, bad: (c.querySelector('.trade-note .bad') || {}).textContent || '', notes: c.querySelector('.trade-note').textContent }; })()");
      say("the launcher's own 0.1 SOL chip", own);
      check(own.amount === "0.1" && own.out !== "0" && (own.out !== "No quote" || own.bad.length > 10), "the launcher's own buy of 0.1 SOL gets a quote, or the words No quote and a sentence that says why not, never a 0 (" + (own.out !== "0" ? own.out : own.bad) + ")");
      await shot("-strict-coin-creator-chip-1440");
      await open(buyer, "/coin.html?pool=" + r.pool.toBase58(), coinReady);
      check(/a wallet, until about/.test((await text("#stMaxWallet")) || "") && /runs until about/.test((await text("#stEarly")) || ""), "the coin page says the max wallet and the early window run, and until when: " + (await text("#stMaxWallet")) + " | " + (await text("#stEarly")));
      check(/max wallet/.test((await text("#liqWindow")) || ""), "the liquidity panel says deposits wait for the max wallet: " + (await text("#liqWindow")));
      await click("#tradeCard .seg [data-dir=buy]");
      await type("#amount", "0.02");
      await until("/Room left under the max wallet/.test((document.querySelector('#tradeCard .trade-note') || {}).textContent || '')", 15000);
      const notes = (await text("#tradeCard .trade-note")) || "";
      say("before the buy", notes);
      check(/The coins of this buy are early\. They cannot be sold or sent until about/.test(notes) && /Room left under the max wallet: /.test(notes) && /This buy also registers your wallet for rewards/.test(notes), "before a buy the trade box says the coins will be locked until a date, the room under the cap, and that the buy registers the wallet");
      await shot("-strict-coin-buy-1440");
      const p0 = await ev("window.__signPrompts");
      await ev("window.__traceTrades = true; window.__trace = []; true");
      await click("#tradeCard .btn-buy");
      await until("(() => { const t = document.querySelector('#tradeCard .tx-result'); return !!t && (/Bought/.test(t.textContent) || !!t.querySelector('.bad')); })()", 60000, 200);
      const bought = (await text("#tradeCard .tx-result")) || "";
      const tk = await tradeTiming("K, first buy on a fresh strict pool, from the click");
      check(!!tk && tk.toSign !== null && tk.toSign < 3000, "the wallet is asked within 3 s of the click on a fresh strict pool (" + (tk ? tk.toSign : "?") + " ms)");
      let h = await client.rulesHolderOf(r.pool, buyer.publicKey);
      check(/Bought/.test(bought) && (await ev("window.__signPrompts")) - p0 === 1 && !!h && !!h.record && h.earlyBought > 0n && h.earlyLocked, "a buy of 0.02 SOL goes through with one prompt, registers the wallet and its coins are early (" + (h ? h.earlyBought : 0n) + " raw units)");
      // a buy above the cap: refused in words by the page, and by the chain
      await type("#amount", "0.05");
      await until("!!document.querySelector('#tradeCard .trade-note .bad')", 15000);
      const capNote = (await text("#tradeCard .trade-note .bad")) || "";
      check(/max wallet|cap/i.test(capNote) && (await ev("document.querySelector('#tradeCard .btn-buy').disabled")), "a buy of 0.05 SOL would pass the cap: the page says why and the button is off: \"" + capNote + "\"");
      let pool = await client.pool(r.pool);
      const whyCap = await refusedBy(await client.swapInstructions(buyer.publicKey, pool, await client.hookRef(pool, buyer.publicKey), DIRECTION.BUY, 50_000_000n, 1n), [buyer]);
      check(whyCap === "MaxWallet", "chain: the same buy sent by hand is refused: " + (whyCap || "IT WENT THROUGH"));
      // an early sell: refused in words, and by the chain
      await click("#tradeCard .seg [data-dir=sell]");
      await type("#amount", fmtUnits(h.earlyBought, 6, 6).replace(/,/g, ""));
      await until("!!document.querySelector('#tradeCard .trade-note .bad')", 15000);
      const earlyNote = (await text("#tradeCard .trade-note .bad")) || "";
      check(/early/i.test(earlyNote), "a sell of the early coins: the page says why before the wallet opens: \"" + earlyNote + "\"");
      await shot("-strict-coin-sell-refused-1440");
      pool = await client.pool(r.pool);
      const whyEarly = await refusedBy(await client.swapInstructions(buyer.publicKey, pool, await client.hookRef(pool, buyer.publicKey), DIRECTION.SELL, h.earlyBought, 0n), [buyer]);
      check(whyEarly === "EarlyLocked", "chain: the same sell sent by hand is refused: " + (whyEarly || "IT WENT THROUGH"));
      // after the early window: a buy whose coins are free, then the send form
      const st0 = await client.rulesState(r.pool);
      while ((BigInt(await conn.getSlot("confirmed"))) < st0.strict.earlyUntil) await sleep(1000);
      await click("#tradeCard .seg [data-dir=buy]");
      await type("#amount", "0.005");
      await sleep(1200);
      await click("#tradeCard .btn-buy");
      await until("(() => { const t = document.querySelector('#tradeCard .tx-result'); return !!t && /Bought/.test(t.textContent); })()", 60000, 200);
      h = await client.rulesHolderOf(r.pool, buyer.publicKey);
      check(!!h && h.free > 0n && h.earlyLocked, "after the early window a buy adds coins that are free to move while the early ones stay locked (free " + (h ? h.free : 0n) + ")");
      await until("!!document.querySelector('#stTo')", 15000);
      const sendAmount = h.free / 2n;
      const before = await client.tokenBalance(friend.publicKey, pool.baseMint, pool.baseTokenProgram).catch(() => 0n);
      await type("#stTo", friend.publicKey.toBase58());
      await type("#stAmount", fmtUnits(sendAmount, 6, 6).replace(/,/g, ""));
      await click("#stSend");
      await until("!!(document.querySelector('#stResult') || {}).textContent", 60000, 200);
      const sent = (await text("#stResult")) || "";
      const after = await client.tokenBalance(friend.publicKey, pool.baseMint, pool.baseTokenProgram).catch(() => 0n);
      check(/^Sent/.test(sent) && after - before === sendAmount, "the send form sends free coins to a wallet that never held the coin and creates its account: \"" + sent + "\", the receiver holds " + (after - before) + " raw units");
      // the record after the send, as this script's connection sees it (the page confirmed the send before this read
      // can be sure to see it): the balance less what was sent. Typing the pre-send balance below would be a send
      // of more than the wallet holds, which the page now refuses first.
      const balanceAfterSend = h.balance - sendAmount;
      for (let i = 0; i < 30 && h.balance !== balanceAfterSend; i++) { await sleep(300); h = await client.rulesHolderOf(r.pool, buyer.publicKey); }
      check(h.balance === balanceAfterSend, "the record counts the send: " + h.balance + " raw units left");
      // review R5 (round 9): a send of more than the wallet holds is said on the page, with no wallet prompt and no
      // transfer that fails in the wallet
      const promptsBefore = await ev("window.__signPrompts");
      await type("#stAmount", fmtUnits(h.balance * 3n, 6, 6).replace(/,/g, ""));
      await click("#stSend");
      await until("!!document.querySelector('#stResult .bad')", 30000, 200);
      const tooMuch = (await text("#stResult")) || "";
      check(tooMuch === "Your wallet holds " + fmtUnits(h.balance, 6, 4) + " " + sym + ". That is not enough for this send." && (await ev("window.__signPrompts")) === promptsBefore, "a send above the balance stops on the page before the wallet: \"" + tooMuch + "\"");
      // the result line is emptied, so the next check waits for its own answer and not for this one
      await ev("document.querySelector('#stResult').replaceChildren(); true");
      await type("#stAmount", fmtUnits(h.balance, 6, 6).replace(/,/g, ""));
      await click("#stSend");
      await until("!!document.querySelector('#stResult .bad')", 30000, 200);
      check(/early/i.test((await text("#stResult")) || ""), "a send of every coin is refused in words before the wallet opens: \"" + (await text("#stResult")) + "\"");
      await shot("-strict-coin-panel-1440");
      // claim, to the lamport
      await until("(() => { const b = document.querySelector('#ruClaimHolder'); return !!b && !b.disabled; })()", 30000, 500);
      h = await client.rulesHolderOf(r.pool, buyer.publicKey);
      const wantClaim = h.claimable;
      const solBefore = BigInt(await conn.getBalance(buyer.publicKey));
      await click("#ruClaimHolder");
      await until("/Claimed|nothing/.test((document.querySelector('#ruHolderResult') || {}).textContent || '')", 60000, 300);
      const claimed = (await text("#ruHolderResult")) || "";
      const solAfter = BigInt(await conn.getBalance(buyer.publicKey));
      check(claimed === "Claimed " + fmtUnits(wantClaim, 9, 9) + " SOL." && solAfter - solBefore === wantClaim - 5000n, "Claim pays what the record held, to the lamport: \"" + claimed + "\" (SDK " + wantClaim + ", wallet +" + (solAfter - solBefore) + " after the network fee)");
      // the burn button through its steps
      await until("(() => { const b = document.querySelector('#ruBurn'); return !!b && !b.disabled; })()", 30000, 500);
      const t1 = await ev("document.querySelector('#ruBurn').textContent.trim()");
      await click("#ruBurn");
      await until("(() => { const b = document.querySelector('#ruBurn'); return !!b && b.disabled; })()", 30000, 300);
      let c1 = (await client.rulesState(r.pool)).config;
      for (let i = 0; i < 60 && c1.obsSlot === 0n; i++) { await sleep(500); c1 = (await client.rulesState(r.pool)).config; }
      check(t1 === "Record the pool" && c1.obsSlot > 0n, "the burn button reads \"" + t1 + "\" and records the pool (run_burn_strict, slot " + c1.obsSlot + ")");
      await until("(() => { const b = document.querySelector('#ruBurn'); return !!b && !b.disabled && b.textContent.trim() === 'Buy and burn'; })()", 60000, 500);
      await click("#ruBurn");
      await until("(() => { const n = document.querySelector('#ruBurns'); return !!n && n.textContent.trim() !== '0'; })()", 60000, 500);
      const c2 = (await client.rulesState(r.pool)).config;
      check(c2.burns > 0n && (await text("#ruBurns")) === String(c2.burns), "25 slots later the button reads Buy and burn, and a press buys and burns: " + c2.burns + " run on chain");
      await shot("-strict-coin-1440", true);
      await view(390, 844);
      await sleep(600);
      await shot("-strict-coin-390", true);
      check(await overflow(), "the strict coin page does not scroll sideways at 390");
      await view(W, HGT);
    }
  }

  // ---- W. the wallet says no ---------------------------------------------------------------------------
  if (want("W")) {
    console.log("\nW. the wallet says no");
    const NO = "The wallet did not sign. Nothing was sent.";
    const pools = await client.allPools();
    const plain = made.find((m) => m.part === "N") || null;
    const poolKey = plain ? plain.pool : pools.find((p) => !p.hasHook).address;
    // the trade card
    await open(trader, "/coin.html?pool=" + poolKey.toBase58(), "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on') && !document.querySelector('#layout').hidden");
    await click("#tradeCard .seg [data-dir=buy]");
    await type("#amount", "0.01");
    await until("(document.querySelector('#tradeCard .out .v') || {}).textContent !== '0'", 15000);
    await clearToasts();
    await ev("window.__rejectNext = true; true");
    await click("#tradeCard .btn-buy");
    await until("!!document.querySelector('#tradeCard .trade-note .bad')", 20000, 200);
    await sleep(400);
    const t = await ev("(() => { const c = document.querySelector('#tradeCard'); return { note: (c.querySelector('.trade-note .bad') || {}).textContent || '', result: (c.querySelector('.tx-result .bad') || {}).textContent || '', button: c.querySelector('.btn-buy').textContent, disabled: c.querySelector('.btn-buy').disabled, toasts: [...document.querySelectorAll('#toasts .toast')].map((x) => x.textContent) }; })()");
    say("after the refusal", t);
    check(t.note === NO && t.result === NO && t.toasts.includes(NO), "a refused buy says \"" + NO + "\" in the note area, under the button, and as a toast");
    check(/^Buy /.test(t.button) && !t.disabled, "the button is back to its verb and on");
    await shot("-wallet-no-trade-1440");
    await view(390, 844);
    await ev("document.querySelector('#tradeCard').scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); true"); await sleep(300);
    await shot("-wallet-no-trade-390");
    await view(W, HGT);
    // the same amount typed again keeps the sentence; a new amount clears it
    await type("#amount", "0.02");
    await until("(document.querySelector('#tradeCard .out .v') || {}).textContent !== '0'", 15000);
    check(!(await ev("!!document.querySelector('#tradeCard .trade-note .bad')")), "a new amount clears the sentence");
    // the same buy signed: the page works as before the refusal
    await click("#tradeCard .btn-buy");
    await until("(() => { const t = document.querySelector('#tradeCard .tx-result'); return !!t && (/Bought/.test(t.textContent) || !!t.querySelector('.bad')); })()", 60000, 200);
    check(/Bought/.test((await text("#tradeCard .tx-result")) || ""), "the next press, signed, buys as usual (" + ((await text("#tradeCard .tx-result")) || "").slice(0, 80) + ")");
    // the liquidity page: a deposit the wallet holds enough for, refused at the signature
    await open(trader, "/pool.html?pool=" + poolKey.toBase58(), "!!document.querySelector('#walletBtn.on') && !document.querySelector('#layout').hidden && /LP balance/.test(document.querySelector('#position').textContent)");
    await type("#addAmount", "0.001");
    await sleep(600);
    await ev("window.__rejectNext = true; true");
    await click("#addBtn");
    await until("!!document.querySelector('#addResult .bad')", 20000, 200);
    const l = await text("#addResult .bad");
    check(l === NO, "a refused deposit says the same sentence under its button: \"" + l + "\"");
    await shot("-wallet-no-liquidity-1440");
    // the launch page: the first signature refused
    await open(dev, "/launch-modules.html", launchReady);
    await fillCoin("Wallet No " + run, "WNO" + run, "0");
    await ev("window.__rejectNext = true; true");
    await click("#launchBtn");
    await until("!!document.querySelector('#result .bad')", 30000, 200);
    const g = await ev("(() => ({ result: document.querySelector('#result .bad').textContent, step1: document.querySelector('#step1').className, step1d: document.querySelector('#step1d').textContent.trim(), button: document.querySelector('#launchBtn').textContent }))()");
    say("launch after the refusal", g);
    check(g.result === NO && g.step1 === "failed" && g.step1d === NO && g.button === "Launch", "a refused first signature says the sentence under the button and at step 1, and the button reads Launch again");
    await ev("document.querySelector('#mGo').scrollIntoView({ block: 'center' }); true"); await sleep(300);
    await shot("-wallet-no-launch-1440");
  }

  // ---- E. Explore ------------------------------------------------------------------------------------
  if (want("E")) {
    console.log("\nE. Explore");
    await open(visitor, "/index.html", "!!document.querySelector('#grid .coin-card:not(.ghost)')");
    await sleep(1500);
    const grid = await ev("(() => { const g = document.querySelector('#grid'); const cards = [...g.querySelectorAll('.coin-card')]; const tops = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)))]; const first = cards.filter((c) => Math.round(c.getBoundingClientRect().top) === tops[0]); return { cards: cards.length, across: first.length, width: Math.round(g.getBoundingClientRect().width), title: document.querySelector('h1').textContent, titleCentre: Math.round(document.querySelector('h1').getBoundingClientRect().left + document.querySelector('h1').getBoundingClientRect().width / 2) }; })()");
    say("grid at 1440", grid);
    check(grid.title === "Explore" && Math.abs(grid.titleCentre - 720) <= 2, "the title Explore is centred");
    check(grid.across === 5, "five cards across at 1440 (" + grid.across + ")");
    for (const m of made) {
      const c = await ev("(() => { const c = document.querySelector(" + q('.coin-card[data-pool="' + m.pool.toBase58() + '"]') + "); if (!c) return null; return { kind: c.dataset.kind, shown: c.querySelector('.coin-kind').textContent, name: c.querySelector('.coin-link').textContent, pair: c.querySelector('.coin-pair').textContent, cap: c.querySelector('.coin-figs .v').textContent, age: c.querySelector('.coin-age').textContent, href: c.querySelector('.coin-link').getAttribute('href') }; })()");
      check(!!c && c.kind === m.kind && c.pair === m.symbol + " / SOL" && /SOL$/.test(c.cap) && /ago$/.test(c.age), m.symbol + " has a card with the kind \"" + m.kind + "\", its pair, a market cap and an age" + (c ? " (" + JSON.stringify(c.shown) + ", " + c.cap + ", " + c.age + ")" : " (no card on the first page)"));
    }
    const kinds = await ev("[...new Set([...document.querySelectorAll('#grid .coin-card')].map((c) => c.dataset.kind))]");
    say("kinds on the page", kinds);
    check(kinds.every((k) => ["", "Modules", "Strict", "Collectible", "Custom hook", "Platform hook"].includes(k)), "every card's kind is one of the known labels");
    if (made.length) {
      const m = made[0];
      await type("#search", m.symbol);
      check(await until("document.querySelectorAll('#grid .coin-card').length === 1 && document.querySelector('#grid .coin-card').dataset.pool === " + q(m.pool.toBase58()), 4000), "searching for " + m.symbol + " leaves that one card");
      await type("#search", "");
    }
    await click("#filtersBtn");
    check(await visible("#filters"), "Filters opens the sort and kind choices");
    await click("#kind [data-kind=Collectible]");
    check(await until("(() => { const c = [...document.querySelectorAll('#grid .coin-card')]; return c.length > 0 && c.every((x) => x.dataset.kind === 'Collectible'); })()", 4000), "the kind Collectible leaves collectible coins only");
    await click("#kind [data-kind=all]");
    await click("#sort [data-sort=mcap]");
    const caps = await ev("[...document.querySelectorAll('#grid .coin-card .coin-figs .v')].map((v) => Number(v.textContent.replace(/[^0-9.]/g, '')))");
    check(caps.length > 1 && caps.every((c, i) => i === 0 || caps[i - 1] >= c), "sorting by market cap puts the largest first (" + caps.slice(0, 4).join(", ") + ")");
    await click("#sort [data-sort=newest]");
    await click("#filtersBtn");
    const say2 = await text("#pageSay");
    check(/coins?\. Page 1 of \d+\./.test(say2 || ""), "a screen reader is told how many coins and pages there are (" + say2 + ")");
    events.length = 0;
    await click("#grid .coin-card .coin-link");
    await waitLoad();
    check(await until("location.pathname === '/coin.html' && !!document.querySelector('#tradeCard .btn-buy')", 20000), "a card opens its coin");
    await view(390, 844);
    await open(visitor, "/index.html", "!!document.querySelector('#grid .coin-card:not(.ghost)')");
    const phone = await ev("(() => { const cards = [...document.querySelectorAll('#grid .coin-card')]; const top = Math.round(cards[0].getBoundingClientRect().top); return cards.filter((c) => Math.round(c.getBoundingClientRect().top) === top).length; })()");
    check(phone === 2, "two cards across on a phone (" + phone + ")");
    check(await overflow(), "Explore does not scroll sideways at 390");
    await view(W, HGT);
  }

  // ---- L. the other pages ------------------------------------------------------------------------------------
  if (want("L")) {
    console.log("\nL. the other pages, in the shell");
    const pools = await client.allPools();
    const some = made.length ? made[made.length - 1].pool : pools[0].address;
    const third = pools.find((p) => p.hasHook && ![PROGRAMS.hook_tax, PROGRAMS.hook_launch_guard, PROGRAMS.hook_buyback, PROGRAMS.hook_collectible, PROGRAMS.hook_rules].some((k) => k.equals(p.hookProgram)));
    const pages = [
      ["/coin.html?pool=" + some.toBase58(), "!!document.querySelector('#tradeCard .btn-buy') && !document.querySelector('#layout').hidden"],
      ["/pool.html?pool=" + some.toBase58(), "!document.querySelector('#layout').hidden && /LP balance/.test(document.querySelector('#position').textContent)"],
      ["/hooks.html", "!!document.querySelector('.pick-list button')"],
      ["/docs.html", "!!document.querySelector('.doc h2')"],
      // a new chain may have no community hook yet: the page's empty state is ready too
      ["/workshop.html", "!!document.querySelector('#hooks .ws-card, #hooks .ws-state, #hooks .ws-empty')"],
      ["/workshop-guide.html", "!!document.querySelector('main h1')"],
    ];
    if (third) pages.push(["/workshop-hook.html?id=" + third.hookProgram.toBase58(), "!!document.querySelector('main h1')"]);
    for (const width of [W, 390]) {
      await view(width, width === W ? HGT : 844);
      for (const [path, ready] of pages) {
        const before = pageErrors.length;
        let ok = true;
        try { await open(visitor, path, ready + " && !!document.querySelector('#siteHeader .menu-btn') && !!document.querySelector('#siteFooter .foot-risk')"); } catch (_) { ok = false; }
        await sleep(600);
        const exceptions = pageErrors.slice(before).filter((e) => /EXCEPTION/.test(e));
        const flat = ok ? await overflow() : false;
        check(ok && exceptions.length === 0 && flat, path.split("?")[0] + " at " + width + ": loads in the new header and footer, no script error, no sideways scroll" + (ok ? (exceptions.length ? " (" + exceptions[0].slice(0, 160) + ")" : flat ? "" : " (scrolls sideways: " + (await ev("document.documentElement.scrollWidth + ' of ' + innerWidth")) + ")") : " (did not get ready)"));
        if (ok) await shot("-old" + path.split("?")[0].replace(/[/.]/g, "-").replace(/-html$/, "") + "-" + width, true);
      }
    }
    await view(W, HGT);
  }

  // ---- R. the rebuilt pages at four widths ----------------------------------------------------------------
  if (want("R")) {
    console.log("\nR. the rebuilt pages at 375, 768, 1024 and 1440");
    const small = () => ev("[...document.querySelectorAll('button, a.btn, input:not([type=file]):not([type=radio]), select, textarea, summary, a.menu-item, .coin-links a, label.choice, .foot-links a, .site-nav a, .site-mark, .coin-link')].filter((e) => { const b = e.getBoundingClientRect(); const box = e.classList.contains('coin-link') ? e.closest('.coin-card').getBoundingClientRect() : b; return b.width > 0 && b.height > 0 && box.height < 44 && getComputedStyle(e).visibility !== 'hidden'; }).map((e) => (e.id || e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().height))");
    const gridReady = "!!document.querySelector('#grid .coin-card:not(.ghost)')";
    const pages = [["/index.html", gridReady], ["/launch.html", "document.querySelectorAll('#choose .choose-card').length === 3 && !!document.querySelector('#menuBtn')"], ["/launch-modules.html", launchReady], ["/launch-collectible.html", launchReady], ["/launch-hook.html?hook=tax", launchReady]];
    for (const width of [375, 768, 1024, 1440]) {
      const touch = width <= 768;
      await call("Emulation.setDeviceMetricsOverride", { width, height: touch ? 900 : 1000, deviceScaleFactor: 1, mobile: touch });
      await call("Emulation.setTouchEmulationEnabled", { enabled: touch });
      await sleep(300);
      for (const [path, ready] of pages) {
        await open(dev, path, ready);
        await sleep(600);
        const views = path === "/launch-modules.html" && (await visible("#studioTabs")) ? ["modules", "coin", "details"] : [""];
        for (const v of views) {
          if (v) { await click("#studioTabs [data-view=" + v + "]"); await sleep(200); if (v === "modules") { await click("#rulePresets [data-preset=hold]"); await sleep(300); } }
          const flat = await overflow();
          const low = touch ? await small() : [];
          check(flat && low.length === 0, path.split("?")[0] + (v ? " (" + v + ")" : "") + " at " + width + ": no sideways scroll" + (touch ? ", every control at least 44 px high" : "") + (flat ? "" : " (page is " + (await ev("document.documentElement.scrollWidth")) + " wide)") + (low.length ? " (under 44: " + [...new Set(low)].slice(0, 6).join("; ") + ")" : ""));
        }
        if (width === 768 || width === 1024) await shot("-w" + width + path.split("?")[0].replace(/[/.]/g, "-").replace(/-html$/, ""), true);
      }
    }
    await view(W, HGT);
  }

  // ---- S. screenshots ---------------------------------------------------------------------------------
  if (want("S")) {
    console.log("\nS. screenshots");
    for (const width of [W, 390]) {
      await view(width, width === W ? 1000 : 844);
      await open(visitor, "/index.html", "!!document.querySelector('#grid .coin-card:not(.ghost)')");
      await sleep(2500);
      await shot("-explore-" + width, true);
      await shot("-header-" + width);
      await ev("document.querySelector('#siteFooter').scrollIntoView({ block: 'end' }); true"); await sleep(300);
      await shot("-footer-" + width);
      await open(visitor, "/launch.html", "document.querySelectorAll('#choose .choose-card').length === 3 && !!document.querySelector('#menuBtn')");
      await shot("-chooser-" + width, true);
      await open(dev, "/launch-modules.html", launchReady);
      await shot("-modules-empty-" + width, true);
      if (width < 1180) { await click("#studioTabs [data-view=coin]"); await sleep(200); await shot("-modules-empty-coin-" + width, true); await click("#studioTabs [data-view=details]"); await sleep(200); await shot("-modules-empty-details-" + width, true); }
      await fillCoin("Garden Coin", "GRDN", "0.04");
      if (width < 1180) await click("#studioTabs [data-view=modules]");
      await click("#rulePresets [data-preset=hold]"); await sleep(500);
      await ev("window.scrollTo(0, 0); true");
      await shot("-modules-preset-" + width, true);
      if (width < 1180) { await click("#studioTabs [data-view=coin]"); await sleep(200); }
      if (width < 1180) await ev("window.scrollTo(0, 0); true"); else await ev("document.querySelector('#reviewCard').scrollIntoView({ block: 'start' }); window.scrollBy(0, -100); true");
      await sleep(300);
      await shot("-review-" + width, width < 1180);
      if (width < 1180) { await click("#studioTabs [data-view=details]"); await sleep(200); await shot("-modules-preset-details-" + width, true); }
      await open(dev, "/launch-collectible.html", launchReady);
      await shot("-collectible-" + width, true);
      await open(dev, "/launch-hook.html?hook=tax", launchReady + " && !!document.querySelector('#communityHooks .hook-option, #communityHooks .inline-msg')");
      await sleep(1200);
      await shot("-hook-" + width, true);
    }
    await view(W, HGT);
  }
  // what Phantom would have blocked: a transaction handed to the wallet already signed by
  // another key, or one that failed its simulation before the wallet signed it
  const flags = JSON.parse((await ev("localStorage.getItem('__phantomFlags') || '[]'")) || "[]");
  check(flags.length === 0, "the wallet was never handed a transaction Phantom blocks (already signed by another key, or failing before it is signed)" + (flags.length ? ": " + flags.length + "\n    " + flags.join("\n    ") : ""));
} catch (e) {
  check(false, "the run stopped: " + e.message);
} finally {
  console.log("\n" + (await edge.close()));
}

const mine = pageErrors.filter((e) => /EXCEPTION/.test(e) || !/example\.com|example\.invalid|programmable\.market|ERR_FAILED|CORS|Failed to load resource/.test(e));
console.log("\npage errors that are the site's own: " + (mine.length ? "\n  " + [...new Set(mine)].join("\n  ") : "none"));
console.log("\n" + (total - failed) + " of " + total + " checks passed" + (failed ? "\nFAILED:\n  " + failures.join("\n  ") : ""));
console.log("launched: " + (made.map((m) => m.part + " " + m.symbol + " " + m.pool.toBase58()).join(", ") || "nothing"));
process.exit(failed ? 1 : 0);
