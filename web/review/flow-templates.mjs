// Review tool: the four standard launch choices of the site (No hook, Tax to treasury, Launch
// guard, Buyback and burn), end to end, in headless Edge with real mouse and keyboard input,
// signed by throwaway wallets made here (localnet only, airdropped, never written to disk).
//   node web/review/flow-templates.mjs <site origin> <out prefix> [parts] [third-party pool]
//   node web/review/flow-templates.mjs http://localhost:8787 web/review/h-templates
// A. each choice: launch through the launch page, read the coin from chain (its liquidity is
//    locked in the pool's lock account), read its coin page and the explore page, buy and sell
//    with a second wallet, compare every quote with the chain. The buyback button is taken
//    through every state a run has: record the pool, wait 25 slots, buy, and record again
//    after the price ran up. On the guard coin, adding liquidity is refused while the window
//    runs and works after it.
// B. add and remove liquidity through the pool page, by SOL and by LP amount, and what the
//    page says about the locked share. A coin with a supply of one shows the smallest deposit.
// C. the hook checker: a platform template, a frozen hook of someone else, an address with nothing.
// D. the coin that trades on a frozen hook of someone else: its hook card, a buy and a sell
//    whose amounts come from a simulation of the trade.
// E. a coin launched on such a hook through the Custom hook card of the launch page. It runs
//    for the unchanged program of hook-template/, whose per-pool config this script makes by hand.
// F. the owner of a tax coin: its treasury is its wrapped SOL account. It trades another coin,
//    sells its own coin (the SOL arrives wrapped), takes the tax, changes the tax, gets hook
//    fees paid out that waited in the pool, renounces, and adds and removes liquidity.
// "parts": all (the default), or some of A1,A2,A3,A4,A5,B,C,D,E,F. A coin that a later part
// needs and this run did not launch through the page is launched through the SDK.
// "third-party pool": the pool for C, D and E. Without it the script looks for a pool on a frozen
// hook that is not a platform program. When there is none, those parts say NOT RUN.
// One line per check, "  ok    ..." or "  FAIL  ...", with the numbers seen. Screenshots go to
// <out prefix>-<name>.png. The test validator at 127.0.0.1:8899 and the site are only read and
// traded on: nothing is stopped, restarted or deployed. The browser is started and closed by
// edge.mjs (no extensions, a profile of its own, closed through its DevTools port). Every
// throwaway wallet sells back what it holds when the run ends, also after a failure.
// The launch form's own metadata upload is not used (it writes files under web/uploads/): the
// form's "Host the metadata yourself" field gets a JSON URL the site already serves.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  HookpoolClient, DIRECTION, FLAGS, HOOK_KIND, NATIVE_MINT, PROGRAMS, SYSTEM_PROGRAM, pda, ix, initialLp, isqrt, feeCeil, guardFee, buybackCapBps, burnStep, burnToleranceBps,
  BURN_INTERVAL_SLOTS, BURN_OUTCOME, MAX_BURN_CAP_BPS, liquidityOpenSlot,
  mulDivCeil, mulDivFloor, spotPrice, decodeTokenAmount, decodeUpgradeAuthority, decodeHookManifest, describeFlags, eventsFromTransaction,
} from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";

const [origin, prefix, partsArg = "all", thirdArg = ""] = process.argv.slice(2);
if (!origin || !prefix) { console.error("usage: node web/review/flow-templates.mjs <site origin> <out prefix> [parts] [third-party pool]"); process.exit(1); }
const PARTS = ["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E", "F"];
const wanted = partsArg === "all" ? PARTS : partsArg.split(",").map((s) => s.trim().toUpperCase());
for (const w of wanted) if (!PARTS.includes(w)) { console.error("unknown part " + w + ". Parts: " + PARTS.join(", ")); process.exit(1); }
const want = (part) => wanted.includes(part);
const RPC = "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const OUR = Object.values(PROGRAMS).map((p) => p.toBase58());
const W = 1440, HGT = 1500;
const SUPPLY = 1_000_000_000n * 1_000_000n;
const SEED_TEXT = "2", SEED = 2_000_000_000n;
const FIRST_TEXT = "0.05", FIRST = 50_000_000n;
const BUY_TEXT = "0.3";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);
const say = (label, value) => console.log("        " + (label + ":").padEnd(34) + " " + (typeof value === "string" ? value : JSON.stringify(value)));
let total = 0, failed = 0;
const failures = [], notRun = [];
const check = (ok, text) => { total++; if (!ok) { failed++; failures.push(text); } console.log((ok ? "  ok    " : "  FAIL  ") + text); return !!ok; };
const skip = (text) => { notRun.push(text); console.log("  NOT RUN  " + text); };
const fund = async (kp, sol) => conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
async function sendNode(ixs, signers) {
  const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx);
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error("node transaction failed: " + JSON.stringify(res.value.err));
  return sig;
}

// ---- the page's own formatting, copied from web/common.js, to compare strings with the chain ------
function fmtUnits(v, decimals, maxFrac = 4) {
  v = BigInt(v);
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return (neg ? "-" : "") + (v / base).toLocaleString("en-US") + (frac ? "." + frac : "");
}
const fmtPct = (bps, frac = 2) => (Number(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: frac }) + "%";
const fmtLp = (v) => fmtUnits(v, 6, 6);
const fmtShare = (part, whole) => (BigInt(whole) <= 0n ? "0%" : (Number(BigInt(part) * 1_000_000n / BigInt(whole)) / 10000).toLocaleString("en-US", { maximumFractionDigits: 4 }) + "%");
function fmtPrice(p) {
  if (!isFinite(p) || p <= 0) return "0";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return Number(p.toPrecision(3)).toLocaleString("en-US", { maximumFractionDigits: 20, useGrouping: false });
}
const short = (addr, n = 4) => { const s = String(addr); return s.length <= n * 2 + 3 ? s : s.slice(0, n) + "..." + s.slice(-n); };
function parseUnits(str, decimals) {
  const s = String(str || "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [w, f = ""] = s.split(".");
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
const applyBps = (v, bps) => (BigInt(v) * BigInt(10000 - bps)) / 10000n;
/// The first number in a string the page shows, as raw units.
const rawOf = (text, decimals) => { const m = /\d[\d,]*(?:\.\d+)?/.exec(String(text || "")); return m ? parseUnits(m[0], decimals) : null; };
const sol = (lamports) => fmtUnits(lamports, 9, 9);
const coins = (raw) => fmtUnits(raw, 6, 6);
const pick = (kv, start) => { const k = Object.keys(kv || {}).find((x) => x.startsWith(start)); return k ? { label: k, value: kv[k] } : { label: "", value: "" }; };
const abs = (v) => (v < 0n ? -v : v);

// ---- chain reads --------------------------------------------------------------------------------
const tokenAmount = async (address) => { const a = await conn.getAccountInfo(address); return a && a.data.length >= 72 ? decodeTokenAmount(new Uint8Array(a.data)) : null; };
const coinsOf = (wallet, mint) => client.tokenBalance(wallet, mint);
const wsolOf = (wallet) => pda.ata(wallet, NATIVE_MINT);
async function txOf(sig) {
  for (let i = 0; i < 40; i++) { const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); if (t) return t; await sleep(250); }
  throw new Error("the transaction " + sig + " could not be read back");
}
/// Lamports an account gained (or lost) in one transaction, from the transaction's own record.
function balanceChange(tx, key) {
  const all = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).keySegments().flat();
  const i = all.findIndex((k) => k.equals(key));
  return i < 0 ? null : BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
}
const sigIn = (href) => { const m = /\/tx\/([1-9A-HJ-NP-Za-km-z]{60,90})/.exec(String(href || "")); return m ? m[1] : ""; };
const plat = await client.platform();
if (!plat) { console.error("no platform account on " + RPC); process.exit(1); }
const ATA_RENT = BigInt(await conn.getMinimumBalanceForRentExemption(165));
const slotsToSeconds = (slots) => Number(slots) * 400 / 1000;
function fmtSpan(seconds) {
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return s + " s";
  if (s < 3600) { const r = s % 60; return Math.floor(s / 60) + " min" + (r ? " " + r + " s" : ""); }
  const m = Math.floor((s % 3600) / 60); return Math.floor(s / 3600) + " h" + (m ? " " + m + " min" : "");
}
/// A buyback buys against a price the pool had this long ago: the page's own words for it.
const WAIT_TEXT = BURN_INTERVAL_SLOTS + " slots later, about " + fmtSpan(slotsToSeconds(BURN_INTERVAL_SLOTS));
const LIQ_SENTENCE = "Runs when liquidity is added and could refuse it. It never runs when liquidity is removed.";
const fmtInt = (n) => Number(n).toLocaleString("en-US");
const slotNow = async () => BigInt(await conn.getSlot("confirmed"));
const waitSlot = async (slot) => { for (let i = 0; i < 1200 && (await slotNow()) < slot; i++) await sleep(400); };
/// Send something the chain must refuse. Returns the name of the program's error, or "" when it went through.
async function refusedBy(ixs, signers) {
  try { await sendNode(ixs, signers); return ""; }
  catch (e) { const text = (e.logs || []).join(" | ") + " " + e.message; const m = /Error Code: (\w+)/.exec(text) || /custom program error: (0x[0-9a-f]+)/.exec(text); return m ? m[1] : String(e.message).slice(0, 120); }
}
const FEE_SENTENCE = "Can take a fee in the quote token to its treasury, up to the platform cap of " + fmtPct(plat.maxHookFeeBps) + ".";
const OVERRIDE_SENTENCE = "Can change the pool fee per trade, up to the platform cap of " + fmtPct(plat.maxFeeOverrideBps) + ".";

// ---- wallets --------------------------------------------------------------------------------------
const dev = { none: Keypair.generate(), tax: Keypair.generate(), launch_guard: Keypair.generate(), buyback: Keypair.generate() };
const trader = Keypair.generate(), lp = Keypair.generate(), visitor = Keypair.generate(), tinyDev = Keypair.generate(), customDev = Keypair.generate();
await Promise.all([fund(dev.none, 3), fund(dev.tax, 3), fund(dev.launch_guard, 3), fund(dev.buyback, 3)]);
await Promise.all([fund(trader, 3), fund(lp, 2), fund(visitor, 2), fund(tinyDev, 3), fund(customDev, 3)]);
/// [wallet, pool] pairs that may hold coins when the run ends.
const held = [];
async function sellBack(kp, poolKey) {
  try {
    const p = await client.pool(poolKey);
    if (!p) return 0n;
    const amount = await client.tokenBalance(kp.publicKey, p.baseMint, p.baseTokenProgram);
    if (amount <= 0n) return 0n;
    if ((await conn.getBalance(kp.publicKey)) < 0.02 * LAMPORTS_PER_SOL) await fund(kp, 0.1);
    await sendNode(await client.swapInstructions(kp.publicKey, p, await client.hookRef(p, kp.publicKey), DIRECTION.SELL, amount, 0n), [kp]);
    return amount;
  } catch (e) { console.error("  could not sell back for " + kp.publicKey.toBase58() + ": " + e.message); return 0n; }
}

// ---- the browser ------------------------------------------------------------------------------------
const run = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
const edge = await startEdge({ name: "templates", width: W, height: HGT + 200 });
let cleaned = false;
process.on("SIGINT", async () => { console.log("\ninterrupted: closing the browser and selling back"); try { await cleanup(); } finally { process.exit(130); } });
let id = 0; const pending = new Map(); const events = []; const pageErrors = [];
let ws, where = "about:blank";
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
/// Run a function inside the page. It must not use anything from this file but its arguments.
const pg = (fn, ...args) => ev("(" + fn.toString() + ")(" + args.map((a) => JSON.stringify(a)).join(", ") + ")");
const shots = [];
const shot = async (name) => { const s = await call("Page.captureScreenshot", { format: "png" }); writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64")); shots.push(prefix + name + ".png"); console.log("        wrote " + prefix + name + ".png"); };
const until = async (expression, ms = 30000, step = 150) => { for (let t = 0; t < ms; t += step) { try { if (await ev(expression)) return true; } catch (_) {} await sleep(step); } return false; };
const mouse = (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const clearToasts = async () => { await ev("(() => { for (const t of document.querySelectorAll('#toasts .toast')) t.click(); return true; })()"); await sleep(350); };
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
    await clearToasts(); // a toast in the corner can sit on a button
  }
}
/// The launch form opens on the curve. The launches of this flow are seeded: pick "Seed it
/// yourself" the way a launcher would, before the seed field is typed into.
async function seedMode() {
  if (await ev("!!document.querySelector('input[name=start][value=seed]') && !document.querySelector('input[name=start][value=seed]').checked")) await click("label.choice:has(input[name=start][value=seed]) .title");
}
/// Click a field, clear it, type into it the way a keyboard would.
async function type(selector, text) {
  if (selector === "#seed") await seedMode();
  await click(selector);
  await ev("(() => { const e = document.querySelector(" + q(selector) + "); e.select(); return true; })()");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  if (text) await call("Input.insertText", { text });
  await sleep(350);
}
const standin = (kp) => JSON.stringify({ secret: Array.from(kp.secretKey), address: kp.publicKey.toBase58() });
const walletScript = (kp) => `
  localStorage.setItem("Programmable.wallet", "phantom");
  (() => {
    // one script for the whole run: a later wallet is handed over through localStorage
    let who = ${standin(kp)};
    try { const s = localStorage.getItem("__standin"); if (s) who = JSON.parse(s); } catch (_) {}
    const SECRET = who.secret;
    const ADDRESS = who.address;
    window.__who = ADDRESS;
    window.__signPrompts = 0;
    const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(SECRET)); };
    const publicKey = { toBase58: () => ADDRESS };
    const w = { isPhantom: true, publicKey, on() {}, disconnect: async () => {},
      connect: async () => ({ publicKey }),
      signTransaction: async (tx) => { window.__signPrompts++; tx.sign([await key()]); return tx; },
      signAllTransactions: async (txs) => { window.__signPrompts++; const k = await key(); for (const t of txs) t.sign([k]); return txs; } };
    window.phantom = { solana: w };
  })();`;
let walletScriptId = null;
const prompts = () => ev("window.__signPrompts");
const waitLoad = async () => { for (let i = 0; i < 200 && !events.includes("Page.loadEventFired"); i++) await sleep(100); };
/// Wait until `ready` holds. The page sometimes boots before the stand-in wallet is injected, so the
/// silent reconnect finds no wallet: then connect it the way the Connect wallet button does.
async function settle(ready, path) {
  if (await until(ready, 9000)) { await sleep(600); return true; }
  if (!(await ev("!!document.querySelector('#walletBtn.on')"))) {
    const how = await ev("(async () => { try { const W = await import('/wallet.js'); const H = await import('/js/hookpool.js'); if (!W.available().length) return 'no wallet in the page'; await W.connect(W.available()[0], H.PublicKey); return 'connected by hand'; } catch (e) { return 'connect threw ' + e.message; } })()");
    console.log("        note: the stand-in wallet was not restored on " + path.split("?")[0] + ": " + how);
  }
  if (await until(ready, 14000)) { await sleep(600); return true; }
  return false;
}
/// Open a page of the site as one of the throwaway wallets and wait until `ready` holds.
async function open(kp, path, ready) {
  if (!walletScriptId) walletScriptId = (await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript(kp) })).identifier;
  else await ev("localStorage.setItem(\"__standin\", " + JSON.stringify(standin(kp)) + "); true");
  for (let attempt = 0; attempt < 2; attempt++) {
    events.length = 0; where = path;
    await call("Page.navigate", { url: origin + path });
    await waitLoad();
    if (await settle(ready, path)) return;
    console.log("        note: the page was not ready, loading it once more: " + path);
  }
  throw new Error("the page did not get ready: " + path);
}
/// Follow a link of the page with a real click and wait for the page it leads to.
async function follow(selector, ready) {
  const href = await ev("document.querySelector(" + q(selector) + ").getAttribute('href')");
  events.length = 0; where = "/" + href;
  await clearToasts();
  await click(selector);
  await waitLoad();
  if (!(await settle(ready, href))) throw new Error("the page did not get ready after the link " + href);
  return href;
}
const coinReady = "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on') && !!document.querySelector('#hookCard .kind') && !document.querySelector('#layout').hidden && /lock account/.test((document.querySelector('#liqCard p') || {}).textContent || '')";
const coinPath = (pool) => "/coin.html?pool=" + pool.toBase58();
const poolReady = "!!document.querySelector('#walletBtn.on') && !document.querySelector('#layout').hidden && /LP balance/.test(document.querySelector('#position').textContent) && /LP supply/.test(document.querySelector('#locked').textContent)";
const overflow = () => ev("document.documentElement.scrollWidth + ' of ' + window.innerWidth");
const fits = async () => { const [a, b] = (await overflow()).split(" of ").map(Number); return a <= b; };
const view = async (width, height, scheme) => {
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await sleep(500);
};
const scrollTo = (selector) => ev("(() => { document.querySelector(" + q(selector) + ").scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); return true; })()");

// ---- what the page shows ------------------------------------------------------------------------------
const txt = (selector) => pg((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; }, selector);
/// A <dl>, or anything that holds one: { term: value }.
const kvOf = (selector) => pg((s) => { const root = document.querySelector(s); if (!root) return null; const o = {}; for (const dt of root.querySelectorAll("dt")) { const dd = dt.nextElementSibling; o[dt.textContent.replace(/\s+/g, " ").trim()] = dd ? dd.textContent.replace(/\s+/g, " ").trim() : ""; } return o; }, selector);
/// The hook card. `acts`: the lines with an amount that waits and the button that moves it.
/// `admin`: the tax owner's own controls, null when the card does not show them.
const readCard = () => pg(() => {
  const c = document.querySelector("#hookCard"); if (!c) return null;
  const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const kv = {}; for (const dt of c.querySelectorAll(".params dl.kv dt")) kv[t(dt)] = t(dt.nextElementSibling);
  const b = c.querySelector(".hook-run button");
  const acts = [...c.querySelectorAll(".hook-act")].map((a) => { const btn = a.querySelector("button"); return { owed: a.classList.contains("owed"), label: t(a.querySelector(".hook-act-v span")), value: t(a.querySelector(".hook-act-v b")), text: t(a), button: btn ? t(btn) : "", disabled: btn ? btn.disabled : null }; });
  const a = c.querySelector(".hook-admin");
  const shown = (e) => !!e && !e.hidden && e.offsetParent !== null;
  const admin = a ? { title: t(a.querySelector("h4")), inputs: [...a.querySelectorAll("input")].map((i) => i.value), help: t(a.querySelector(".help")), buttons: [...a.querySelectorAll("button")].filter(shown).map(t), result: t(a.querySelector(".tx-result")), confirm: shown(a.querySelector(".confirm-line")) ? t(a.querySelector(".confirm-line > div")) : "" } : null;
  return { badge: t(c.querySelector(".kind .badge")), kind: t(c.querySelector(":scope > .small.muted")), sentences: [...c.querySelectorAll(".sentences li")].map(t), status: t(c.querySelector(".status")), kv,
    help: [...c.querySelectorAll(".params > .help")].map(t), manifest: t(c.querySelector(":scope > .small.dim")), acts, admin,
    button: b ? { text: t(b), disabled: b.disabled, note: t(b.parentElement.querySelector(".small.muted")) } : null, all: t(c) };
});
const readHead = () => pg(() => {
  const h = document.querySelector("#head"); const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  return { title: t(h.querySelector("h1")), badge: t(h.querySelector(".head-tags .badge")), tags: [...h.querySelectorAll(".head-tags .tag")].map(t), price: t(h.querySelector("#headPrice")), cap: t(h.querySelector("#headMcap")) };
});
const readTrade = () => pg(() => {
  const c = document.querySelector("#tradeCard"); const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const kv = {}; for (const dt of c.querySelectorAll("dl.kv dt")) kv[t(dt)] = t(dt.nextElementSibling);
  const ex = document.querySelector("#exactOut"); const btn = c.querySelector("button.btn-block"); const w = c.querySelector(".wrapped");
  return { amount: document.querySelector("#amount").value, out: t(c.querySelector(".out .v")), unit: t(c.querySelector(".out .v").nextElementSibling), kv, exact: t(ex), exactTitle: ex ? ex.title : "", balance: t(c.querySelector(".balance span")), note: t(c.querySelector(".trade-note")),
    result: t(c.querySelector(".tx-result")), bad: !!c.querySelector(".tx-result .bad"), button: t(btn), wrapped: w && !w.hidden ? { value: t(w.querySelector(".hook-act-v b")), button: t(w.querySelector("button")), text: t(w) } : null,
    slippage: [...c.querySelectorAll(".slip button")].filter((b) => b.getAttribute("aria-pressed") === "true").map(t).join() || "custom " + c.querySelector(".slip input").value };
});
const readStats = () => pg(() => { const o = {}; for (const s of document.querySelectorAll("#stats .stat")) o[s.querySelector(".l").textContent.trim()] = s.querySelector(".v").textContent.trim(); return o; });
const readToasts = () => pg(() => [...document.querySelectorAll("#toasts .toast")].map((t) => { const a = t.querySelector("a"); return { kind: t.className.replace("toast", "").trim(), text: t.textContent.replace(/\s+/g, " ").trim(), href: a ? a.href : "" }; }));
/// Press a button that answers with a toast, and wait for the toast. Returns the toasts and the prompts it took.
async function pressForToast(selector, ms = 60000) {
  await clearToasts();
  const p0 = await prompts();
  await click(selector);
  await until("document.querySelectorAll('#toasts .toast').length > 0", ms, 200);
  await sleep(400);
  const toasts = await readToasts();
  return { toasts, text: toasts.map((t) => t.text).join(" / "), sig: sigIn((toasts.find((t) => t.href) || {}).href), prompts: (await prompts()) - p0 };
}
/// Can this pool's hook change the amounts of a trade on this side? The rule of the coin page and of the trade API.
const setsAmounts = (p, dir) => p.hasHook && !OUR.includes(p.hookProgram.toBase58()) && (p.hookFlags & (dir === DIRECTION.BUY ? FLAGS.CALL_ON_BUY : FLAGS.CALL_ON_SELL)) !== 0
  && (p.hookFlags & FLAGS.BEFORE_SWAP) !== 0 && (p.hookFlags & (FLAGS.TAKE_HOOK_FEE | FLAGS.OVERRIDE_FEE | FLAGS.OVERRIDE_CURVE)) !== 0;

/// One trade through the trade form of the coin page that is open, as the wallet that is connected.
/// `amountText`: what to type, or "max" to press the Max control. Returns what the page showed
/// before the click and what the chain says afterwards.
async function tradeOnPage(kp, C, dir, amountText, opts = {}) {
  const buy = dir === DIRECTION.BUY;
  const r = { buy, error: "" };
  await clearToasts();
  await click("#tradeCard .seg [data-dir=" + (buy ? "buy" : "sell") + "]");
  await sleep(200);
  if (opts.slippage) await type("#tradeCard .slip input", opts.slippage);
  r.held = await coinsOf(kp.publicKey, C.mint);
  if (amountText === "max") {
    // the form reads the balance again after a trade: Max is pressed once it shows it
    const wantText = "Balance " + fmtUnits(r.held, 6, 4) + " " + C.symbol;
    r.balanceShown = await until("(document.querySelector('#tradeCard .balance span') || {}).textContent === " + q(wantText), 25000);
    await click("#tradeCard .balance button");
    await sleep(350);
  } else await type("#amount", amountText);
  r.pool0 = await client.pool(C.pool);
  r.sim = setsAmounts(r.pool0, dir);
  // the formula quote at once, then the simulated one: in the "Exact quote" row, or, on a hook
  // that answers each trade itself, as the amount shown
  if (r.sim) await until("(() => { const v = (document.querySelector('#tradeCard .out .v') || {}).textContent; return !!v && v !== '0' && /From a simulation/.test((document.querySelector('#tradeCard .trade-note') || {}).textContent || ''); })()", 20000);
  else await until("(document.querySelector('#tradeCard .out .v') || {}).textContent !== '0' && !!(document.querySelector('#exactOut') || {}).textContent", 15000);
  await sleep(900);
  r.shown = await readTrade();
  r.amount = parseUnits(r.shown.amount, buy ? 9 : 6) || 0n;
  r.pool0 = await client.pool(C.pool);
  r.slot0 = BigInt(await conn.getSlot("confirmed"));
  try { r.expected = await client.quoteLocal(r.pool0, plat, dir, r.amount, C.info, r.slot0); } catch (_) { r.expected = null; }
  if (opts.simulate || r.sim) { try { r.simulated = await client.quoteOnChain(kp.publicKey, r.pool0, dir, r.amount); } catch (e) { r.simulated = null; r.simError = e.message; } }
  r.treasuryKey = r.pool0.hasHook && !r.pool0.hookQuoteTreasury.equals(SYSTEM_PROGRAM) ? r.pool0.hookQuoteTreasury : null;
  r.treasury0 = r.treasuryKey ? await tokenAmount(r.treasuryKey) : null;
  r.sol0 = BigInt(await conn.getBalance(kp.publicKey)); r.coins0 = r.held;
  r.wsol0 = await tokenAmount(wsolOf(kp.publicKey));
  r.hadCoinsAccount = !!(await conn.getAccountInfo(pda.ata(kp.publicKey, C.mint)));
  r.price0 = await txt("#headPrice");
  const prompts0 = await prompts();
  await click("#tradeCard " + (buy ? ".btn-buy" : ".btn-sell"));
  await until("(() => { const t = document.querySelector('#tradeCard .tx-result'); return !!t && (/Bought|Sold/.test(t.textContent) || !!t.querySelector('.bad')); })()", 60000, 200);
  const after = await readTrade();
  r.prompts = (await prompts()) - prompts0;
  r.resultText = after.result;
  if (!/Bought|Sold/.test(after.result)) { r.error = after.result || "no answer from the page in 60 s"; return r; }
  r.sig = sigIn(await ev("(document.querySelector('#tradeCard .tx-result a.link') || {}).href || ''"));
  const tx = await txOf(r.sig);
  r.fee = BigInt(tx.meta.fee);
  r.ev = eventsFromTransaction(tx, OUR).find((e) => e.kind === "Swapped" && e.pool.equals(C.pool)) || null;
  r.sol1 = BigInt(await conn.getBalance(kp.publicKey)); r.coins1 = await coinsOf(kp.publicKey, C.mint);
  r.wsol1 = await tokenAmount(wsolOf(kp.publicKey));
  r.pool1 = await client.pool(C.pool);
  r.treasury1 = r.treasuryKey ? await tokenAmount(r.treasuryKey) : null;
  r.clean = r.pool1.swapCount - r.pool0.swapCount === 1n;
  // the page reads the pool and its trades again after the confirmation
  r.priceWant = fmtPrice(spotPrice(r.pool1, 6, 9)) + " SOL";
  r.priceOk = await until("(document.querySelector('#headPrice') || {}).textContent === " + q(r.priceWant), 15000);
  r.price1 = await txt("#headPrice");
  r.rowOk = await until("(() => { const a = document.querySelector('#trades tbody tr td:last-child a'); return !!a && a.href.includes(" + q(r.sig) + "); })()", 25000);
  r.row = await pg(() => { const tr = document.querySelector("#trades tbody tr"); return tr ? [...tr.children].map((td) => td.textContent.trim()) : null; });
  return r;
}
const WRAPPED_NOTE = "Arrives as wrapped SOL in your wrapped SOL account. Unwrap, under this form, turns it into plain SOL.";
const WRAPPED_RESULT = "The SOL arrived as wrapped SOL in your wrapped SOL account.";
/// The checks every trade gets. `mode`: "exact" the wallet gets the quote to the last unit,
/// "guard" the quote or more, "loose" only that the chain and the wallet agree.
function checkTrade(r, kp, label, mode) {
  if (!check(!r.error, label + ": the trade confirms" + (r.error ? ". The page said: " + r.error : ""))) return false;
  check(r.prompts === 1, label + ": one wallet prompt (" + r.prompts + ")");
  if (!r.clean) console.log("        note: " + (r.pool1.swapCount - r.pool0.swapCount) + " swaps landed in this pool between the quote and the trade, so another wallet traded it too");
  if (r.buy) {
    const got = r.coins1 - r.coins0;
    check(!!r.ev && got === r.ev.amountOut, label + ": the wallet received what the pool paid out, " + coins(got) + " coins");
    if (mode === "exact") check(!!r.expected && got === r.expected.amountOut && fmtUnits(got, 6, 2) === r.shown.out, label + ": quote " + r.shown.out + " = received " + coins(got) + " (the SDK quote for the same pool state is " + (r.expected ? coins(r.expected.amountOut) : "none") + ", equal to the last unit)");
    if (mode === "guard") check(got >= (rawOf(r.shown.out, 6) || 0n), label + ": inside the guard the wallet received the quote or more: quote " + r.shown.out + ", received " + coins(got));
    const paid = r.sol0 - r.sol1, wantPaid = r.amount + r.fee + (r.hadCoinsAccount ? 0n : ATA_RENT);
    check(paid === wantPaid, label + ": the wallet paid " + sol(paid) + " SOL = " + sol(r.amount) + " typed + " + sol(r.fee) + " network fee" + (r.hadCoinsAccount ? "" : " + " + sol(ATA_RENT) + " rent of its new token account"));
    check(r.wsol0 === r.wsol1, label + ": the wallet's wrapped SOL account is as it was (" + (r.wsol0 === null ? "none before, none after" : sol(r.wsol0) + " before, " + (r.wsol1 === null ? "CLOSED" : sol(r.wsol1)) + " after") + ")");
  } else {
    const got = r.ev ? r.ev.amountOut : 0n;
    // a wallet that keeps a wrapped SOL account is paid there; when that account is this pool's own treasury it takes the hook fee of the sell too
    const mine = wsolOf(kp.publicKey);
    const isTreasury = !!r.treasuryKey && r.treasuryKey.equals(mine);
    const wrapped = r.wsol0 !== null || isTreasury;
    if (!wrapped) {
      check(!!r.ev && r.sol1 - r.sol0 === got - r.fee, label + ": the wallet's SOL rose by " + sol(r.sol1 - r.sol0) + " = " + sol(got) + " paid out - " + sol(r.fee) + " network fee");
      check(!/wrapped/i.test(r.shown.note) && r.wsol1 === null, label + ": the form says nothing about wrapped SOL, and the wallet has no wrapped SOL account afterwards");
    } else {
      const into = (r.wsol1 === null ? 0n : r.wsol1) - (r.wsol0 === null ? 0n : r.wsol0), own = isTreasury && r.ev ? r.ev.hookFee : 0n;
      check(r.shown.note.includes(WRAPPED_NOTE), label + ": before the click the form says where the SOL lands: \"" + r.shown.note + "\"");
      check(!!r.ev && r.wsol1 !== null && into === got + own && r.sol1 - r.sol0 === -r.fee, label + ": the SOL arrived wrapped: the wallet's wrapped SOL account rose by " + sol(into) + " = " + sol(got) + " paid out" + (own ? " + " + sol(own) + " (the tax of this sell, the account is the coin's treasury)" : "") + ", its plain SOL fell by the network fee " + sol(r.fee) + " only");
      check(r.resultText.includes(WRAPPED_RESULT), label + ": afterwards the form says so: \"" + r.resultText + "\"");
    }
    if (mode === "exact" || mode === "guard") check(!!r.expected && got === r.expected.amountOut && fmtUnits(got, 9, 6) === r.shown.out, label + ": quote " + r.shown.out + " SOL = received " + sol(got) + " SOL (the SDK quote for the same pool state is " + (r.expected ? sol(r.expected.amountOut) : "none") + ", equal to the last lamport)");
    check(r.coins0 - r.coins1 === r.amount, label + ": " + coins(r.amount) + " coins left the wallet");
  }
  const quoteAmt = r.buy ? r.amount : (r.ev ? r.ev.amountOut : 0n);
  check(r.rowOk && !!r.row && r.row[1] === (r.buy ? "buy" : "sell") && r.row[2] === fmtUnits(quoteAmt, 9, 4) && r.row[5] === short(kp.publicKey.toBase58()), label + ": the recent-trades table shows it first: " + (r.row ? r.row.slice(0, 6).join(" | ") : "no row"));
  check(r.priceOk && r.price1 !== r.price0, label + ": the price in the head moved from " + r.price0 + " to " + r.price1 + " (chain: " + r.priceWant + ")");
  return true;
}
async function coinShots(tag) {
  await clearToasts();
  await ev("window.scrollTo(0, 0); true"); await sleep(300);
  await shot("-coin-" + tag + "-1440");
  await view(375, 900, "dark");
  await scrollTo("#tradeCard"); await sleep(300); await shot("-coin-" + tag + "-375");
  await scrollTo("#hookCard"); await sleep(300); await shot("-coin-" + tag + "-375-hook");
  check(await fits(), "coin page (" + tag + "): no horizontal scroll at 375 (" + (await overflow()) + ")");
  await view(W, HGT, "dark");
}
/// A part of the run: a thrown error is one failed check, and the next part still runs.
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); }
  catch (e) {
    check(false, "this part stopped early: " + e.message);
    try { await shot("-failure-" + title.split(/[ .]/)[0].toLowerCase()); } catch (_) {}
    try { await view(W, HGT, "dark"); } catch (_) {}
  }
}

// ---- the four choices -----------------------------------------------------------------------------
const SPEC = {
  none: { n: "A1", tag: "none", label: "No hook", program: null, name: "Tpl Plain " + run, sym: "TPN" + run, fee: 30, tags: [], fields: null, note: "", launch: {} },
  tax: { n: "A2", tag: "tax", label: "Tax to treasury", program: "hook_tax", name: "Tpl Tax " + run, sym: "TPT" + run, fee: 100, tags: ["tax"], fields: { taxBuy: "2.5", taxSell: "4", taxMax: "8" }, note: "Your first buy pays the buy tax like any other buy.", launch: { tax: { buyBps: 250, sellBps: 400, maxBps: 800 } } },
  launch_guard: { n: "A3", tag: "guard", label: "Launch guard", program: "hook_launch_guard", name: "Tpl Guard " + run, sym: "TPG" + run, fee: 100, tags: ["guard", "sells: never called"], fields: { guardFee: "40", guardMin: "2.5" }, note: "Your first buy is the first trade of the pool. It pays the start fee in full.", launch: { guard: { guardSlots: 375n, startFeeBps: 4000 } } },
  buyback: { n: "A4", tag: "buyback", label: "Buyback and burn", program: "hook_buyback", name: "Tpl Burn " + run, sym: "TPB" + run, fee: 300, tags: ["burn"], fields: { bbBuy: "2", bbSell: "6", bbMin: "0.004" }, note: "Your first buy pays the buy share like any other buy.", launch: { buyback: { buyBps: 200, sellBps: 600, minQuote: 4_000_000n } } },
};
const R = {}; // what each choice produced, for the later parts and the summary

/// A coin a later part needs, launched through the SDK with the settings its launch through the page would use.
async function need(key) {
  if (R[key] && R[key].coin) return R[key];
  const s = SPEC[key], kp = dev[key], mint = Keypair.generate();
  const plan = await client.launchInstructions({
    dev: kp.publicKey, mint, name: s.name, symbol: s.sym, uri: origin + "/package.json?coin=" + s.sym.toLowerCase(), decimals: 6, totalSupply: SUPPLY,
    quoteMint: NATIVE_MINT, lpFeeBps: s.fee, quoteAmount: SEED, devBuyQuote: FIRST, minDevBuyOut: 1n, template: key, ...s.launch,
  });
  await sendNode(plan.createTx, [kp, mint]);
  await sendNode(plan.launchTx, [kp]);
  const p = await client.pool(plan.pool);
  R[key] = { key, sum: {}, pool: plan.pool, bySdk: true, treasury: key === "tax" ? wsolOf(kp.publicKey) : key === "buyback" ? p.hookQuoteTreasury : null,
    coin: { pool: plan.pool, mint: p.baseMint, symbol: s.sym, info: await client.hookInfo(p), launch: await client.launchForMint(p.baseMint) } };
  held.push([kp, plan.pool]);
  console.log("        note: " + s.sym + " was launched through the SDK for this part (its launch through the page is not in this run): pool " + plan.pool.toBase58());
  return R[key];
}

async function launchOnPage(key) {
  const s = SPEC[key], kp = dev[key], out = R[key] = { key, sum: {} };
  const uri = origin + "/package.json?coin=" + s.sym.toLowerCase();
  const page = key === "none" ? "/launch-modules.html" : "/launch-hook.html";
  await open(kp, page, "!!document.querySelector('#walletBtn.on') && !!document.querySelector('#launchBtn') && !!document.querySelector('#costs dd') && document.querySelector('#launchBtn').textContent === 'Launch'");
  await type("#name", s.name);
  await type("#symbol", s.sym);
  await type("#seed", SEED_TEXT);
  await type("#devBuy", FIRST_TEXT);
  await click("label.choice:has(input[name=fee][value='" + s.fee + "']) .title");
  if (!(await ev("document.querySelector('details.more').open"))) await click("details.more > summary");
  await type("#metaUrl", uri);
  if (key !== "none") await click("#platformHooks [data-hook=" + key + "]");
  check(key === "none" ? (await ev("[...document.querySelectorAll('#ruleList [role=switch]')].every((b) => b.getAttribute('aria-checked') === 'false') && document.querySelector('#pvKind').textContent === ''")) : (await ev("document.querySelector('#platformHooks [data-hook=" + key + "]').getAttribute('aria-pressed') === 'true'")),
    key === "none" ? "Module Mode with every module off is the plain coin, and the preview names no kind" : "the platform hook \"" + s.label + "\" is picked");
  const openBodies = key === "none" ? (await ev("[...document.querySelectorAll('#ruleList [data-fields]')].some((b) => !b.hidden) ? 'some' : ''")) : await ev("[...document.querySelectorAll('.hook-body')].filter((b) => !b.hidden).map((b) => b.dataset.for).join()");
  check(openBodies === (s.fields ? key : ""), "only this card's own fields show: " + (openBodies || "none"));
  for (const [field, value] of Object.entries(s.fields || {})) await type("#" + field, value);
  await sleep(900); // the form reads from the chain whether the treasury's wrapped SOL account exists
  const costs = await kvOf("#costs");
  const totalText = await txt("#total");
  const note = await txt("#revFirstNote");
  say("form says you spend", Object.entries(costs).map(([k, v]) => k + " " + v).join("; ") + "; Total " + totalText);
  const rentShown = rawOf(costs["Rent and network fees"], 9) || 0n, totalShown = rawOf(totalText, 9) || 0n;
  check(costs["Seed, locked in the pool"] === "2 SOL" && costs["Your first buy"] === "0.05 SOL" && costs["Platform launch fee"] === fmtUnits(plat.launchFeeLamports, 9, 4) + " SOL" && totalShown === SEED + FIRST + plat.launchFeeLamports + rentShown,
    "the summary says the seed is locked in the pool, repeats what was typed and the platform's launch fee on chain (" + sol(plat.launchFeeLamports) + " SOL), and the total is their sum");
  check(note === s.note, "the note about the first buy: " + (note ? "\"" + note + "\"" : "none"));
  const words = (await txt(".page-top")) + " " + (await txt("#reviewCard"));
  check(!/LP[^.]*burn|burn[^.]*LP/i.test(words) && /the launch locks it in the pool/.test(words) && /Nobody can withdraw it/.test(words), "the page says the seed is locked in the pool and can never be withdrawn, and never that LP is burned");
  if (key === "launch_guard") check((await txt("#guardSlots")) === "375 slots at 400 ms", "2.5 minutes shows as " + (await txt("#guardSlots")));
  if (key === "launch_guard") check(/Nobody collects it, and nobody can add liquidity until the window is over\./.test(await txt(".hook-body[data-for=launch_guard] > p")), "the guard card says nobody can add liquidity until the window is over");
  if (key === "tax") say("ceiling field says", "max " + (await txt("#taxCap")) + " (platform cap on chain " + fmtPct(plat.maxHookFeeBps, 0) + ")");
  if (key === "tax") say("under the summary", (await txt("#rentNote")) || "nothing");
  if (key === "launch_guard") say("start fee field says", "max " + (await txt("#guardCap")) + " (platform cap on chain " + fmtPct(plat.maxFeeOverrideBps, 0) + ")");
  if (key === "buyback") {
    // the cap of one run follows the coin's fees: the form works it out with the SDK's own rule
    const cap = buybackCapBps({ buyBps: 200, sellBps: 600 }, plat, s.fee);
    check((await txt(".hook-body[data-for=buyback] > p")).includes("A run buys the coin with a slice of the treasury and burns what it buys. The first call records the pool's price, and a buy can follow " + BURN_INTERVAL_SLOTS + " slots later."), "the buyback card says how a run works now: a slice of the treasury, and a first call that only records the pool");
    const runText = await txt("#bbRun");
    check(runText === "With these shares and this pool fee, one run spends up to " + fmtPct(cap) + " of the pool's SOL. The slice follows the fees of a coin and is never above " + fmtPct(MAX_BURN_CAP_BPS) + ". A large treasury takes several runs." && (await txt("#bbMinMax")) === "max 1 SOL", "under its fields the card says what one run can spend with these numbers, from the SDK (" + cap + " bps): \"" + runText + "\"");
  }
  // screenshots: the form with this card selected
  await scrollTo(key === "none" ? "#ruleList" : ".hook-body[data-for=" + key + "]"); await sleep(250); await shot("-launch-" + s.tag + "-1440");
  await view(375, 900, "dark");
  await scrollTo(key === "none" ? "#ruleList" : ".hook-body[data-for=" + key + "]"); await sleep(250); await shot("-launch-" + s.tag + "-375");
  check(await fits(), "launch form (" + s.tag + "): no horizontal scroll at 375 (" + (await overflow()) + ")");
  await view(W, HGT, "dark");
  // launch
  const before = BigInt(await conn.getBalance(kp.publicKey));
  await click("#launchBtn");
  await until("!!document.querySelector('#result a.btn') || !!document.querySelector('#result .bad')", 90000, 300);
  const ok = await ev("!!document.querySelector('#result a.btn')");
  if (!check(ok, "both launch transactions confirm" + (ok ? "" : ". The page said: " + (await txt("#result")) + " | " + (await txt("#steps"))))) throw new Error("the launch did not go through");
  await sleep(500);
  out.prompts = await prompts();
  check(out.prompts === 2, "wallet prompts for the launch: " + out.prompts + " (the page promises two signatures)");
  const steps = await txt("#steps");
  say("steps", steps);
  check(/created, liquidity locked\.$/.test(steps), "the second step ends with \"liquidity locked\"");
  const links = await pg(() => [...document.querySelectorAll("#result a")].map((a) => ({ text: a.textContent.trim(), href: a.href })));
  const open1 = links.find((l) => /^Open /.test(l.text));
  out.pool = new PublicKey(new URL(open1.href).searchParams.get("pool"));
  out.sig1 = sigIn((links.find((l) => l.text === "tx 1") || {}).href); out.sig2 = sigIn((links.find((l) => l.text === "tx 2") || {}).href);
  check(open1.text === "Open " + s.sym, "the page offers \"" + open1.text + "\", pool " + out.pool.toBase58());
  const spent = before - BigInt(await conn.getBalance(kp.publicKey));
  const rentReal = spent - SEED - FIRST - plat.launchFeeLamports;
  out.sum.prompts = out.prompts; out.sum.costShown = totalText; out.sum.spent = sol(spent) + " SOL"; out.sum.rentShown = sol(rentShown); out.sum.rentReal = sol(rentReal);
  say("wallet really spent", sol(spent) + " SOL: rent and network fees " + sol(rentReal) + " SOL, the page said about " + sol(rentShown));
  if (key === "tax") say("of that", sol(BigInt(await conn.getBalance(wsolOf(kp.publicKey)))) + " SOL sits in the wallet's own wrapped SOL account, which is the tax treasury: its rent and the tax of the wallet's own first buy");
  // the page shows its total rounded up to 0.0001 SOL
  check(spent <= totalShown && totalShown - spent < 100_000n, "the Total is true: the page showed " + totalText + ", the wallet's SOL fell by " + sol(spent) + " (the Total is that, rounded up to 0.0001 SOL: " + sol(totalShown - spent) + " above)");
  out.uri = uri;
  held.push([kp, out.pool]);
}

async function chainChecks(key) {
  const s = SPEC[key], kp = dev[key], out = R[key];
  const p = await client.pool(out.pool);
  if (!check(!!p, "chain: the pool account exists")) throw new Error("no pool on chain");
  const [mint, md, lpMint, lock, devLp, launch, info] = await Promise.all([client.mint(p.baseMint), client.metadata(p.baseMint), client.mint(p.lpMint), tokenAmount(p.lpLock), client.tokenBalance(kp.publicKey, p.lpMint), client.launchForMint(p.baseMint), client.hookInfo(p)]);
  out.coin = { pool: out.pool, mint: p.baseMint, symbol: s.sym, info, launch };
  check(pda.pool(p.baseMint, NATIVE_MINT).equals(out.pool) && p.quoteMint.equals(NATIVE_MINT) && p.creator.equals(kp.publicKey), "chain: it is the SOL pool of mint " + p.baseMint.toBase58() + ", created by the dev wallet");
  if (!s.program) check(!p.hasHook && p.hookKind === HOOK_KIND.NONE && p.hookFlags === 0, "chain: the pool has no hook program, kind none, flags 0");
  else {
    const man = await conn.getAccountInfo(pda.manifest(PROGRAMS[s.program]));
    const flags = man ? decodeHookManifest(new Uint8Array(man.data)).flags : -1;
    check(p.hasHook && p.hookProgram.equals(PROGRAMS[s.program]) && p.hookKind === HOOK_KIND.PLATFORM && p.hookFlags === flags, "chain: the pool is wired to " + s.program + " " + p.hookProgram.toBase58() + ", kind platform template, flags " + p.hookFlags + " as in its manifest");
  }
  check(p.lpFeeBps === s.fee, "chain: pool fee " + fmtPct(p.lpFeeBps) + ", the one picked");
  check(!!md && md.name === s.name && md.symbol === s.sym && md.uri === out.uri && !md.isMutable, "chain: name, symbol and metadata URL are the ones typed and can never change: " + (md ? md.name + " (" + md.symbol + ")" : "no metadata"));
  check(!!mint && mint.supply === SUPPLY && mint.decimals === 6 && mint.mintAuthority === null && mint.freezeAuthority === null, "chain: fixed supply " + coins(mint.supply) + ", no mint authority, no freeze authority");
  const all = isqrt(SUPPLY * SEED);
  check(!!lpMint && lpMint.supply === all && lock === all && devLp === 0n, "chain: all the launch liquidity is locked: LP supply " + lpMint.supply + " raw units = sqrt(supply x seed), all " + lock + " in the pool's lock account, the dev holds " + devLp);
  check(!!launch && launch.dev.equals(kp.publicKey) && launch.pool.equals(out.pool) && launch.hookProgram.equals(p.hookProgram) && launch.devBuyQuote === FIRST && launch.launchFeePaid === plat.launchFeeLamports, "chain: the launch record exists: dev, pool, hook, first buy " + sol(launch ? launch.devBuyQuote : 0n) + " SOL, fee paid " + sol(launch ? launch.launchFeePaid : 0n) + " SOL");
  check(!!launch && launch.lpLocked === initialLp(SUPPLY, SEED), "chain: the launch record says it locked " + (launch ? launch.lpLocked : 0n) + " raw units of LP = sqrt(supply x seed) - 1,000 (the pool itself locks the other 1,000)");
  const tx2 = await txOf(out.sig2);
  const feeIn = balanceChange(tx2, plat.treasury);
  check(feeIn === plat.launchFeeLamports, "chain: the launch fee reached the platform treasury " + short(plat.treasury.toBase58()) + ": +" + sol(feeIn || 0n) + " SOL in the launch transaction");
  // the dev's own first buy, inside the launch transaction
  const first = eventsFromTransaction(tx2, OUR).find((e) => e.kind === "Swapped" && e.pool.equals(out.pool));
  const devCoins = await coinsOf(kp.publicKey, p.baseMint);
  check(!!first && devCoins === first.amountOut && first.amountIn === FIRST, "chain: the first buy of " + sol(FIRST) + " SOL gave the dev " + coins(devCoins) + " coins");
  out.first = first;
  if (key === "tax") {
    const x = info && info.tax, ata = wsolOf(kp.publicKey);
    check(!!x && x.buyBps === 250 && x.sellBps === 400 && x.maxBps === 800 && x.owner.equals(kp.publicKey) && !x.renounced, "chain: tax config is the one typed: buy " + fmtPct(x.buyBps) + ", sell " + fmtPct(x.sellBps) + ", ceiling " + fmtPct(x.maxBps) + ", owner the dev");
    const tAmount = await tokenAmount(ata), own = feeCeil(FIRST - feeCeil(FIRST, plat.protocolFeeBps), 250);
    check(p.hookQuoteTreasury.equals(ata) && p.hookTreasuryOwner.equals(kp.publicKey) && tAmount === own && !!first && first.hookFee === own, "chain: the treasury is the dev wallet's wrapped SOL account (the field was left empty), the pool names the dev as its owner, and it holds the tax of the dev's own first buy, " + sol(tAmount || 0n) + " SOL");
    out.treasury = ata;
  } else if (key === "launch_guard") {
    const g = info && info.guard;
    check(!!g && g.guardSlots === 375n && g.startFeeBps === 4000 && g.startSlot === p.createdSlot && p.hookQuoteTreasury.equals(SYSTEM_PROGRAM), "chain: guard config is the one typed: " + g.guardSlots + " slots (2.5 min), start fee " + fmtPct(g.startFeeBps) + ", armed at the pool's slot " + g.startSlot + ", no treasury");
    check(!!first && first.feeBpsApplied === 4000 && first.hookFee === 0n, "chain: the dev's first buy paid the start fee of " + fmtPct(first ? first.feeBpsApplied : 0) + " as the form said, and no hook fee");
  } else if (key === "buyback") {
    const b = info && info.buyback, t = pda.ata(pda.hookAuthority(out.pool, PROGRAMS.hook_buyback)[0], NATIVE_MINT);
    check(!!b && b.buyBps === 200 && b.sellBps === 600 && b.minQuote === 4_000_000n && b.buybacks === 0n, "chain: buyback config is the one typed: buy share " + fmtPct(b.buyBps) + ", sell share " + fmtPct(b.sellBps) + ", minimum " + sol(b.minQuote) + " SOL");
    const tAmount = await tokenAmount(t), own = feeCeil(FIRST - feeCeil(FIRST, plat.protocolFeeBps), 200);
    check(p.hookQuoteTreasury.equals(t) && b.treasury.equals(t) && tAmount === own, "chain: the treasury is owned by the hook's own address for this pool and holds the share of the dev's first buy, " + sol(tAmount || 0n) + " SOL");
    out.treasury = t;
  } else check(!info && p.hookQuoteTreasury.equals(SYSTEM_PROGRAM) && !!first && first.hookFee === 0n && first.feeBpsApplied === s.fee, "chain: nothing took a fee on the dev's first buy but the pool (" + fmtPct(first ? first.feeBpsApplied : 0) + ") and the protocol");
}

/// The sentence of the coin page's Liquidity card for a pool, from the chain.
async function liquidityText(p) {
  const [lpMint, lock] = await Promise.all([client.mint(p.lpMint), tokenAmount(p.lpLock)]);
  if (lock >= lpMint.supply) return "All of this pool's liquidity is locked. Its " + fmtLp(lock) + " LP sit in the pool's lock account, and the pool program has no instruction that moves them.";
  return fmtShare(lock, lpMint.supply) + " of this pool's liquidity is locked. " + fmtLp(lock) + " LP of " + fmtLp(lpMint.supply) + " sit in the pool's lock account, and the pool program has no instruction that moves them. Wallets that added liquidity hold the rest and can take it out.";
}

/// The hook card and the head of the coin page against the chain, as the dev sees them. Returns the card.
async function cardChecks(key) {
  const s = SPEC[key], kp = dev[key], out = R[key];
  const card = await readCard(), head = await readHead();
  const p = await client.pool(out.pool);
  say("head", head.title + " | " + head.badge + " | tags " + head.tags.join(", ") + " | " + head.price + " | " + head.cap);
  say("hook card", card.all);
  check(head.title === s.name + s.sym + " / SOL" && head.badge === s.label && head.tags.join() === s.tags.join(), "coin page head: name, symbol, badge \"" + head.badge + "\", tags [" + head.tags.join(", ") + "]");
  check(head.price === fmtPrice(spotPrice(p, 6, 9)) + " SOL", "coin page head: price " + head.price + " is the pool's price on chain");
  const liq = await txt("#liqCard p");
  check(liq === (await liquidityText(p)) && !/burn/i.test(liq), "liquidity card, from the lock account and the LP supply on chain: \"" + liq + "\"");
  const kv = card.kv;
  if (key === "none") {
    check(card.badge === "No hook" && card.sentences.length === 2 && /This pool has no hook/.test(card.sentences[0]) && /No program runs on a trade/.test(card.sentences[1]) && !card.status && Object.keys(kv).length === 0, "hook card: says there is no hook and that no program runs on a trade");
  } else {
    check(card.badge === s.label && card.status === "Platform template, upgradeable by the platform's team.", "hook card: \"" + card.badge + "\", " + card.kind + ". " + card.status);
    if (key === "launch_guard") {
      check(card.sentences.length === 3 && card.sentences[0] === "Runs on buys only. It is never called on a sell, so it cannot block or tax sells." && card.sentences[1] === OVERRIDE_SENTENCE && card.sentences[2] === LIQ_SENTENCE, "hook card: runs on buys only, takes no fee of its own, can change the pool fee up to the cap on chain, and can refuse new liquidity: " + card.sentences.join(" "));
      const g = out.coin.info.guard;
      check(kv["Start fee on buys"] === "40%" && kv["Window"] === "375 slots, 2.5 min", "hook card numbers: start fee " + kv["Start fee on buys"] + ", window " + kv["Window"]);
      check(card.help.join(" ").endsWith("Nobody collects it. Nobody can add liquidity until the window is over."), "hook card: inside the window it says nobody can add liquidity until the window is over");
      const slot = BigInt(await conn.getSlot("confirmed")), now = guardFee(slot, g.startSlot, g.guardSlots, g.startFeeBps, p.lpFeeBps);
      const shownBps = Math.round(parseFloat(kv["Buy fee right now"]) * 100);
      // the page works from a slot it read up to five seconds ago
      check(now !== null && shownBps >= now && shownBps <= now + 600, "hook card numbers: buy fee right now " + kv["Buy fee right now"] + ", slots left " + kv["Slots left"] + " (chain at slot " + slot + ": " + (now === null ? "window over" : fmtPct(now)) + ", " + (g.startSlot + g.guardSlots - slot) + " left)");
    } else {
      check(card.sentences.length === 2 && card.sentences[0] === "Runs on buys and sells." && card.sentences[1] === FEE_SENTENCE, "hook card: runs on buys and sells, can take a fee up to the cap on chain: " + card.sentences.join(" "));
      if (key === "tax") {
        check(kv["Buy tax"] === "2.5%" && kv["Sell tax"] === "4%" && kv["Ceiling, fixed forever"] === "8%", "hook card numbers: buy tax " + kv["Buy tax"] + ", sell tax " + kv["Sell tax"] + ", ceiling " + kv["Ceiling, fixed forever"]);
        check(kv["Owner"] === short(kp.publicKey.toBase58(), 5) && kv["Treasury"] === short(out.treasury.toBase58(), 5) && kv["Collected so far"] === fmtUnits(p.hookFeesQuoteTotal, 9, 4) + " SOL", "hook card numbers: owner " + kv["Owner"] + ", treasury " + kv["Treasury"] + ", collected so far " + kv["Collected so far"]);
        // the dev is the owner of the tax and of its treasury: the card gives it its controls
        const tAmount = await tokenAmount(out.treasury), take = card.acts.find((a) => !a.owed);
        check(!!take && take.label === "In your treasury" && take.value === fmtUnits(tAmount, 9, 6) + " SOL" && take.button === "Take it" && take.disabled === false, "hook card, for the owner of the treasury: \"" + (take ? take.text : "nothing") + "\" (chain: " + sol(tAmount || 0n) + " SOL in the account)");
        check(!!card.admin && card.admin.title === "You own this tax" && card.admin.inputs.join() === "2.5,4" && card.admin.buttons.join() === "Save the tax,Renounce", "hook card, for the owner of the tax: its controls are there, filled with " + (card.admin ? card.admin.inputs.join("% and ") + "%, buttons " + card.admin.buttons.join(", ") : "nothing"));
      } else {
        const tAmount = await tokenAmount(out.treasury), cap = buybackCapBps(out.coin.info.buyback, plat, p.lpFeeBps);
        check(kv["Buy share"] === "2%" && kv["Sell share"] === "6%" && kv["Minimum to trigger"] === "0.004 SOL", "hook card numbers: buy share " + kv["Buy share"] + ", sell share " + kv["Sell share"] + ", minimum " + kv["Minimum to trigger"]);
        check(kv["Treasury balance"] === fmtUnits(tAmount, 9, 4) + " SOL" && kv["Burned so far"] === "0 " + s.sym && kv["Buybacks run"] === "0", "hook card numbers: treasury " + kv["Treasury balance"] + " (chain " + sol(tAmount) + "), burned " + kv["Burned so far"] + ", buybacks " + kv["Buybacks run"]);
        check(kv["One run spends at most"] === fmtPct(cap) + " of the pool's SOL" && kv["The next buy would spend"] === "nothing yet", "hook card numbers: one run spends at most " + kv["One run spends at most"] + " (the SDK's cap for this coin's fees: " + cap + " bps), the next buy would spend " + kv["The next buy would spend"]);
        check(!!card.button && card.button.text === "Run buyback" && card.button.disabled && card.button.note === "Runs once the treasury reaches the minimum of 0.004 SOL. Anyone can send it.", "hook card: the Run buyback button is there and off below the minimum: \"" + (card.button ? card.button.note : "") + "\"");
        check(card.help.includes("A run buys the coin with a slice of the treasury and burns what it buys. It buys against a price the pool had at least " + BURN_INTERVAL_SLOTS + " slots earlier, so the first call only records the pool. A treasury larger than one slice takes several runs.") && !/up to 0\.5% of the pool/.test(card.all), "hook card: one sentence says how a run works now, and nothing says \"up to 0.5% of the pool\" any more");
      }
    }
  }
  return card;
}

async function runChoice(key) {
  const s = SPEC[key];
  await launchOnPage(key);
  await chainChecks(key);
  const out = R[key], C = out.coin, sum = out.sum;
  // the coin page, from the link the launch page gives
  await follow("#result a.btn", coinReady);
  check((await ev("location.pathname + location.search")) === coinPath(out.pool), "the link opens the coin page of the new pool");
  const card1 = await cardChecks(key);
  const fees = [];
  const feeNow = async (label) => { const c = await readCard(); const slot = BigInt(await conn.getSlot("confirmed")); fees.push({ label, fee: c.kv["Buy fee right now"], left: c.kv["Slots left"], slot: String(slot), help: c.help.join(" ") }); return c; };
  if (key === "launch_guard") fees.push({ label: "dev opens the page", fee: card1.kv["Buy fee right now"], left: card1.kv["Slots left"], slot: String(await conn.getSlot("confirmed")), help: card1.help.join(" ") });

  // the second wallet buys
  await open(trader, coinPath(out.pool), coinReady);
  if (key === "launch_guard") await feeNow("second wallet opens the page");
  if (key === "tax") { const c = await readCard(); check(c.acts.length === 0 && !c.admin, "hook card, for any other wallet: no owner controls and nothing to take"); }
  const b = await tradeOnPage(trader, C, DIRECTION.BUY, BUY_TEXT);
  held.push([trader, out.pool]);
  const g = C.info && C.info.guard;
  const inWindow = !!g && !!b.ev && b.ev.slot < g.startSlot + g.guardSlots;
  const feeRow = pick(b.shown.kv, "Hook fee"), poolRow = pick(b.shown.kv, "Pool fee");
  say("buy form", "pay " + b.shown.amount + " SOL, You receive " + b.shown.out + " " + s.sym + ", " + Object.entries(b.shown.kv).map(([k, v]) => k + " " + v).join("; "));
  if (checkTrade(b, trader, "buy " + BUY_TEXT + " SOL", key === "launch_guard" ? "guard" : "exact")) {
    sum.buyQuote = b.shown.out; sum.buyGot = coins(b.coins1 - b.coins0); sum.buyExactRow = b.shown.exact;
    if (key === "launch_guard") {
      check(inWindow, "the buy landed inside the guard window: slot " + b.ev.slot + ", the window ends at " + (g.startSlot + g.guardSlots));
      check(b.shown.unit === s.sym + " or more" && b.shown.note.includes("The guard fee falls every slot. A buy that lands a moment later pays less and gives this amount or more."), "inside the window the form says \"" + b.shown.out + " " + b.shown.unit + "\": \"" + b.shown.note + "\"");
      const shownBps = Math.round(parseFloat(poolRow.label.replace("Pool fee ", "")) * 100);
      check(/\(guard\)$/.test(poolRow.label) && b.ev.feeBpsApplied <= shownBps && b.ev.feeBpsApplied > s.fee && b.ev.hookFee === 0n && feeRow.value === "0", "the form showed \"" + poolRow.label + "\", the chain charged " + fmtPct(b.ev.feeBpsApplied) + " a few slots later: the same or less, and no hook fee");
      check(b.pool1.reserveQuote - b.pool0.reserveQuote === b.amount - b.ev.protocolFee, "the whole guard fee stayed in the pool: its SOL reserve rose by " + sol(b.pool1.reserveQuote - b.pool0.reserveQuote) + " = the " + sol(b.amount) + " paid - the protocol fee " + sol(b.ev.protocolFee));
      sum.buyFee = poolRow.label + " shown, " + fmtPct(b.ev.feeBpsApplied) + " charged";
    } else {
      check(/same as above/.test(b.shown.exact), "the simulated \"Exact quote\" agrees with the instant one: " + b.shown.exact);
      check(poolRow.label === "Pool fee " + fmtPct(s.fee) && b.ev.feeBpsApplied === s.fee, "the form showed \"" + poolRow.label + "\", the chain charged " + fmtPct(b.ev.feeBpsApplied));
      if (key === "none") check(feeRow.value === "0" && b.ev.hookFee === 0n, "no hook fee: the form shows " + feeRow.value + ", the chain took " + b.ev.hookFee);
      else {
        const reached = (b.treasury1 || 0n) - (b.treasury0 || 0n);
        check(feeRow.value === fmtUnits(b.ev.hookFee, 9, 6) + " SOL" && reached === b.ev.hookFee && b.ev.hookFee === b.expected.hookFee, "buy: fee shown " + feeRow.value + ", the hook's treasury received " + sol(reached) + " SOL (exactly the fee of the trade)");
        sum.buyFee = feeRow.value + " shown, treasury +" + sol(reached);
      }
    }
    // the "Exact quote" row has to survive a change of the slippage: the simulation runs again
    await type("#amount", "0.01");
    await until("!!(document.querySelector('#exactOut') || {}).textContent", 15000);
    await click("#tradeCard .slip button:nth-child(3)");
    const kept = await until("!!(document.querySelector('#exactOut') || {}).textContent", 15000);
    await sleep(1200);
    const again = await readTrade();
    // outside a guard window the minimum can be worked out here to the last unit
    const q2 = key === "launch_guard" ? null : await client.quoteLocal(await client.pool(out.pool), plat, DIRECTION.BUY, 10_000_000n, C.info);
    check(kept && !!again.exact && again.slippage === "2%" && (!q2 || pick(again.kv, "Min received").value === fmtUnits(applyBps(q2.amountOut, 200), 6, 2) + " " + s.sym), "after a change of the slippage to " + again.slippage + " the form still shows the simulated \"Exact quote\" (" + (again.exact || "nothing") + ") and the minimum follows: " + pick(again.kv, "Min received").value);
    await click("#tradeCard .slip button:nth-child(2)");
    await type("#amount", "");
  }
  if (key === "launch_guard") await feeNow("right after the buy");
  await coinShots(s.tag);

  if (key === "launch_guard") {
    // the page alone, no reload: the fee on the card has to keep falling
    const last = fees[fees.length - 1].fee;
    const moved = await until("(() => { for (const dt of document.querySelectorAll('#hookCard .params dt')) if (dt.textContent.trim() === 'Buy fee right now') return dt.nextElementSibling.textContent.trim() !== " + q(last) + "; return false; })()", 30000, 500);
    await feeNow("some seconds later, same page");
    for (const f of fees) say("fee on the card, " + f.label, f.fee + ", slots left " + f.left + " (chain slot " + f.slot + ")");
    const bps = fees.map((f) => Math.round(parseFloat(f.fee) * 100));
    check(moved && bps.every((v, i) => i === 0 || v <= bps[i - 1]) && bps[bps.length - 1] < bps[0], "the page shows the fee falling: " + fees.map((f) => f.fee).join(" > ") + ", the last one without a reload");
    // new liquidity is refused while the window runs, by the page and by the chain
    await guardLiquidity(key, true);
    await open(trader, coinPath(out.pool), coinReady);
  }
  // round 1: nothing is recorded yet, so the first press records the pool and the buy follows 25 slots later
  if (key === "buyback") await buybackRound(key, 1, ["observe", "tooSoon", "buy"]);

  // the second wallet sells everything with Max
  const sv = await tradeOnPage(trader, C, DIRECTION.SELL, "max");
  const sFee = pick(sv.shown.kv, "Hook fee"), sPool = pick(sv.shown.kv, "Pool fee");
  say("sell form", "pay " + sv.shown.amount + " " + s.sym + ", You receive " + sv.shown.out + " SOL, " + Object.entries(sv.shown.kv).map(([k, v]) => k + " " + v).join("; "));
  check(sv.balanceShown && sv.shown.amount === fmtUnits(sv.held, 6, 6).replace(/,/g, ""), "Max fills the whole balance: " + sv.shown.amount + " (chain " + coins(sv.held) + ")");
  if (checkTrade(sv, trader, "sell all", "exact")) {
    sum.sellQuote = sv.shown.out + " SOL"; sum.sellGot = sol(sv.ev.amountOut) + " SOL";
    check(sv.coins1 === 0n, "sell all: the wallet holds no coins afterwards");
    check(/same as above/.test(sv.shown.exact), "sell all: the simulated \"Exact quote\" agrees with the instant one: " + sv.shown.exact);
    check(sPool.label === "Pool fee " + fmtPct(s.fee) && sv.ev.feeBpsApplied === s.fee, "sell all: the form showed \"" + sPool.label + "\", the chain charged " + fmtPct(sv.ev.feeBpsApplied) + (key === "launch_guard" ? ": a sell pays the normal fee, guard or not" : ""));
    if (key === "none" || key === "launch_guard") check(sFee.value === "0" && sv.ev.hookFee === 0n, "sell all: no hook fee, the form shows " + sFee.value + ", the chain took " + sv.ev.hookFee);
    else {
      const reached = (sv.treasury1 || 0n) - (sv.treasury0 || 0n);
      check(sFee.value === fmtUnits(sv.ev.hookFee, 9, 6) + " SOL" && reached === sv.ev.hookFee && sv.ev.hookFee === sv.expected.hookFee, "sell all: fee shown " + sFee.value + ", the hook's treasury received " + sol(reached) + " SOL (exactly the fee of the trade)");
      sum.sellFee = sFee.value + " shown, treasury +" + sol(reached);
    }
    const st = await readStats();
    check(st["Swaps"] === Number(sv.pool1.swapCount).toLocaleString("en-US") && st["Total volume"] === fmtUnits(sv.pool1.volumeQuoteTotal, 9, 2) + " SOL" && st["Reserve SOL"] === fmtUnits(sv.pool1.reserveQuote, 9, 4) && st["Pool fee"] === fmtPct(s.fee) && st["Protocol fee"] === fmtPct(plat.protocolFeeBps) && st["Creator"] === short(dev[key].publicKey.toBase58(), 5),
      "the Pool card after the trades is the chain: swaps " + st["Swaps"] + ", total volume " + st["Total volume"] + ", reserve " + st["Reserve SOL"] + " SOL, pool fee " + st["Pool fee"] + ", protocol fee " + st["Protocol fee"]);
  }

  if (key === "tax") {
    // what the page says it collected, right after the two trades, without a reload
    const p = await client.pool(out.pool), wantText = fmtUnits(p.hookFeesQuoteTotal, 9, 4) + " SOL";
    const followed = await until("(() => { for (const dt of document.querySelectorAll('#hookCard .params dt')) if (dt.textContent.trim() === 'Collected so far') return dt.nextElementSibling.textContent.trim() === " + q(wantText) + "; return false; })()", 12000, 300);
    const stats = await readStats(), c = await readCard();
    check(stats["Hook fees total"] === wantText, "the Pool card's \"Hook fees total\" follows the trades: " + stats["Hook fees total"] + " (chain " + sol(p.hookFeesQuoteTotal) + ")");
    check(followed && c.kv["Collected so far"] === wantText, "the hook card's \"Collected so far\" follows the trades without a reload: it says " + c.kv["Collected so far"] + ", the chain says " + wantText);
  }
  if (key === "buyback") {
    // round 2: the sell left a treasury larger than one slice, and more than 25 slots have passed: the press buys.
    // round 3: right after it the chain refuses a call for 25 slots, then the press buys what is left.
    await buybackRound(key, 2, ["buy"]);
    await buybackRound(key, 3, ["tooSoon", "buy"]);
    // round 4: a buy lifts the price over the recorded one: the press records the pool again, and buys 25 slots later
    const pn = await client.pool(out.pool);
    await sendNode(await client.swapInstructions(trader.publicKey, pn, await client.hookRef(pn, trader.publicKey), DIRECTION.BUY, 300_000_000n, 1n), [trader]);
    await buybackRound(key, 4, ["wait", "tooSoon", "buy"]);
  }
  if (key === "launch_guard") {
    // the end of the window, then one more buy, which has to be exact again
    const end = g.startSlot + g.guardSlots;
    for (let i = 0; i < 400 && BigInt(await conn.getSlot("confirmed")) <= end + 2n; i++) await sleep(500);
    const over = await until("/The guard window is over/.test((document.querySelector('#hookCard .params') || {}).textContent || '')", 30000, 500);
    const c = await readCard();
    check(over && c.kv["Slots left"] === "0" && c.kv["Buy fee right now"] === fmtPct(s.fee), "after the window, without a reload, the card says: slots left " + c.kv["Slots left"] + ", buy fee right now " + c.kv["Buy fee right now"] + ". " + c.help.join(" "));
    const b2 = await tradeOnPage(trader, C, DIRECTION.BUY, "0.05");
    const row = pick(b2.shown.kv, "Pool fee");
    if (checkTrade(b2, trader, "buy 0.05 SOL after the window", "exact")) check(row.label === "Pool fee " + fmtPct(s.fee) && b2.ev.feeBpsApplied === s.fee, "after the window the form shows \"" + row.label + "\" and the chain charged " + fmtPct(b2.ev.feeBpsApplied));
    sum.after = "after the window: quote " + b2.shown.out + ", received " + (b2.error ? "nothing" : coins(b2.coins1 - b2.coins0));
    await guardLiquidity(key, false);
  }
}

/// The guard coin's pool page as the liquidity wallet. `inside`: the guard window still runs, so
/// the page says when adding opens and keeps the button off, and the chain refuses a deposit.
/// After the window the same deposit goes through the page and comes out again.
async function guardLiquidity(key, inside) {
  const out = R[key], C = out.coin, g = C.info.guard, end = g.startSlot + g.guardSlots;
  let p = await client.pool(out.pool);
  if (inside) {
    await sendNode(await client.swapInstructions(lp.publicKey, p, await client.hookRef(p, lp.publicKey), DIRECTION.BUY, 100_000_000n, 1n), [lp]);
    held.push([lp, out.pool]);
  }
  await open(lp, "/pool.html?pool=" + out.pool.toBase58(), poolReady);
  await type("#addAmount", "0.02");
  p = await client.pool(out.pool);
  const sup = (await client.mint(p.lpMint)).supply, lpN = mulDivFloor(20_000_000n, sup, p.reserveQuote);
  if (inside) {
    const win = await txt("#addWindow"), slot = await slotNow();
    check(slot < end && !!win && win.startsWith("This pool takes no new liquidity while its launch guard runs. Adding opens at slot " + fmtInt(end) + ", in about ") && win.endsWith("Removing liquidity is always possible.") && (await ev("document.querySelector('#addBtn').disabled")),
      "pool page, inside the guard window: \"" + win + "\" and Add liquidity is off (the SDK's liquidityOpenSlot gives " + liquidityOpenSlot(C.info) + ", chain slot " + slot + ")");
    await scrollTo("#addCard"); await sleep(200); await shot("-pool-guard-window-1440");
    if ((await slotNow()) < end - 6n) {
      const why = await refusedBy(await client.addLiquidityInstructions(lp.publicKey, p, lpN, mulDivCeil(lpN, p.reserveBase, sup) * 2n, mulDivCeil(lpN, p.reserveQuote, sup) * 2n), [lp]);
      check(why === "LiquidityInGuardWindow", "chain: a deposit sent without the page inside the window is refused by the hook: " + (why || "IT WENT THROUGH"));
    } else skip("A3: the chain's refusal of a deposit inside the guard window. The window had less than six slots left when the run got there.");
    return;
  }
  check((await ev("document.querySelector('#addWindow').hidden")) && !(await ev("document.querySelector('#addBtn').disabled")), "pool page, after the guard window: no note about a window, and Add liquidity is on");
  await clearToasts();
  await click("#addBtn");
  await until("/Added/.test(document.querySelector('#addResult').textContent) || !!document.querySelector('#addResult .bad')", 45000, 200);
  const addText = await txt("#addResult"), lpBal = await client.tokenBalance(lp.publicKey, p.lpMint);
  check(/Added/.test(addText) && lpBal === lpN, "after the window the deposit goes through the page: " + addText + " The wallet holds the " + fmtLp(lpBal) + " LP the form showed");
  await until("(() => { for (const dt of document.querySelectorAll('#position dt')) if (dt.textContent.trim() === 'Pool share') return dt.nextElementSibling.textContent.trim() !== '0%'; return false; })()", 12000, 300);
  await clearToasts();
  await click("#removeQuick button:nth-child(3)"); await sleep(300);
  await click("#removeBtn");
  await until("/Removed/.test(document.querySelector('#removeResult').textContent) || !!document.querySelector('#removeResult .bad')", 45000, 200);
  check(/Removed/.test(await txt("#removeResult")) && (await client.tokenBalance(lp.publicKey, p.lpMint)) === 0n, "and it comes out again: " + (await txt("#removeResult")));
}

/// One round on the page's buyback button, until a press has bought. Before every press the
/// SDK is asked what a call does now (client.buybackInstructions), and the button and its
/// sentence must say exactly that: record the pool, wait for the 25 slots, record again after
/// the price ran up, or buy. `wantSteps`: the states this round has to pass through, in order.
async function buybackRound(key, round, wantSteps) {
  const s = SPEC[key], out = R[key], sum = out.sum;
  const label = "buyback, round " + round;
  const seen = [], obsSlots = [];
  const cardBtn = () => pg(() => { const b = document.querySelector("#hookCard .hook-run button"); const n = document.querySelector("#runNote"); return b ? { text: b.textContent.trim(), disabled: b.disabled, note: n ? n.textContent.replace(/\s+/g, " ").trim() : "" } : null; });
  const btnIs = (text, disabled) => until("(() => { const b = document.querySelector('#hookCard .hook-run button'); return !!b && b.textContent.trim() === " + q(text) + " && b.disabled === " + disabled + "; })()", 30000, 300);
  for (let turn = 0; turn < 6; turn++) {
    const p0 = await client.pool(out.pool), cfg0 = (await client.hookInfo(p0)).buyback, t0 = await tokenAmount(out.treasury), mint0 = await client.mint(p0.baseMint);
    const cap = buybackCapBps(cfg0, plat, p0.lpFeeBps);
    const plan = await client.buybackInstructions(trader.publicKey, p0);
    if (!plan) { check(false, label + ": the treasury (" + sol(t0 || 0n) + " SOL) is below the minimum of " + sol(cfg0.minQuote) + " SOL, so there is nothing to run"); return; }
    seen.push(plan.step);
    if (plan.step === "tooSoon") {
      // the chain refuses a call: the button keeps the verb of what comes next and is off, and the card counts down
      const next = burnStep(plan.observation, p0.reserveBase, p0.reserveQuote, plan.dueSlot, plan.capBps, plan.pot);
      const nextLabel = next.step === "wait" ? "Record the pool again" : "Run buyback";
      await btnIs(nextLabel, true);
      const b = await cardBtn(), slot = await slotNow();
      if (slot < plan.dueSlot) {
        check(!!b && b.disabled && b.text === nextLabel && b.note.startsWith("The pool was recorded at slot " + fmtInt(plan.observation.slot) + ". The next call opens at slot " + fmtInt(plan.dueSlot) + ", in about ") && b.note.endsWith("s."), label + ": for " + BURN_INTERVAL_SLOTS + " slots after a call the button is off and keeps its verb, \"" + (b ? b.text : "") + "\": \"" + (b ? b.note : "") + "\" (chain slot " + slot + ")");
        if (slot < plan.dueSlot - 5n) {
          const why = await refusedBy([ix.executeBuyback(trader.publicKey, client.keys(p0), 0n)], [trader]);
          check(why === "TooSoon", label + ": a call sent without the page in those slots is refused by the program: " + (why || "IT WENT THROUGH"));
        }
        if (round === 3) { await scrollTo("#hookCard .params"); await sleep(200); await shot("-coin-buyback-wait-1440"); }
      } else console.log("        note: the 25 slots were over when the run read the page");
      await waitSlot(plan.dueSlot + 1n);
      continue;
    }
    const wantBtn = plan.step === "observe" ? "Record the pool" : plan.step === "wait" ? "Record the pool again" : "Run buyback";
    await btnIs(wantBtn, false);
    const wantSpend = fmtUnits(plan.spend, 9, 6) + " SOL";
    await until("(() => { for (const dt of document.querySelectorAll('#hookCard .params dt')) if (dt.textContent.trim() === 'The next buy would spend') return dt.nextElementSibling.textContent.trim() === " + q(wantSpend) + "; return false; })()", 12000, 300);
    const card = await readCard(), b = await cardBtn();
    const wantNote = plan.step === "observe" ? "Nothing is recorded yet. This call records the pool's price and buys nothing. A buy can follow " + WAIT_TEXT + ". Anyone can send it."
      : plan.step === "wait" ? "The price is more than " + fmtPct(burnToleranceBps(plan.capBps)) + " above the recorded one, so a call now buys nothing. It records the pool again, and a buy can follow " + WAIT_TEXT + "."
      : "A call now spends " + wantSpend + " and burns about " + fmtUnits(plan.expectedOut, 6, 2) + " " + s.sym + "." + (plan.potLeft > 0n ? " " + fmtUnits(plan.potLeft, 9, 6) + " SOL stays in the treasury for later runs." : "") + " Anyone can send it.";
    check(!!b && !b.disabled && b.text === wantBtn && b.note === wantNote, label + ": the SDK says a call now would \"" + plan.step + "\", and the button reads \"" + (b ? b.text : "") + "\": \"" + (b ? b.note : "") + "\"");
    check(card.kv["Treasury balance"] === fmtUnits(t0, 9, 4) + " SOL" && card.kv["One run spends at most"] === fmtPct(cap) + " of the pool's SOL" && card.kv["The next buy would spend"] === wantSpend,
      label + ": the card shows the treasury (" + card.kv["Treasury balance"] + "), what one run spends at most (" + card.kv["One run spends at most"] + ") and what the next buy would spend (" + card.kv["The next buy would spend"] + "); the SDK gives " + sol(plan.spend) + " of a pot of " + sol(plan.pot));
    if (round === 1 && plan.step === "observe") { await scrollTo("#hookCard .params"); await sleep(200); await shot("-coin-buyback-record-1440"); }
    if (plan.step === "wait") { await scrollTo("#hookCard .params"); await sleep(200); await shot("-coin-buyback-again-1440"); }
    const press = await pressForToast("#hookCard .hook-run button");
    const tx = press.sig ? await txOf(press.sig) : null;
    const be = tx ? eventsFromTransaction(tx, OUR).find((e) => e.kind === "BuybackExecuted") : null;
    const p1 = await client.pool(out.pool), cfg1 = (await client.hookInfo(p1)).buyback, t1 = await tokenAmount(out.treasury), mint1 = await client.mint(p1.baseMint);
    obsSlots.push(cfg1.obsSlot);
    if (!check(!!be && press.prompts === 1 && press.toasts.some((t) => t.kind === "ok"), label + ": the press goes through with one wallet prompt. The page said: " + (press.text || "nothing"))) { sum["buyback" + round] = "the page's button failed: " + (press.text || "no message"); return; }
    if (plan.step === "observe") {
      check(be.outcome === BURN_OUTCOME.OBSERVED && press.text.startsWith("The pool is recorded. A buy can follow " + WAIT_TEXT + ".") && cfg1.obsSlot > 0n && cfg1.obsReserveQuote === p1.reserveQuote && cfg1.buybacks === cfg0.buybacks && mint1.supply === mint0.supply && t1 === t0,
        label + ": \"" + press.text + "\" Chain: outcome recorded, the pool's reserves are in the config with slot " + cfg1.obsSlot + ", nothing was bought and the treasury is untouched");
      continue;
    }
    if (plan.step === "wait") {
      check(be.outcome === BURN_OUTCOME.WAITED && press.text.startsWith("The price was above the recorded one, so nothing was bought. The pool is recorded again. A buy can follow " + WAIT_TEXT + ".") && cfg1.obsSlot >= cfg0.obsSlot + BURN_INTERVAL_SLOTS && cfg1.buybacks === cfg0.buybacks && mint1.supply === mint0.supply && t1 === t0,
        label + ": \"" + press.text + "\" Chain: outcome waited, recorded again at slot " + cfg1.obsSlot + " (" + (cfg1.obsSlot - cfg0.obsSlot) + " slots after the last record), nothing was bought");
      continue;
    }
    // it bought
    const burned = cfg1.totalBaseBurned - cfg0.totalBaseBurned, spentQ = cfg1.totalQuoteSpent - cfg0.totalQuoteSpent;
    check(be.outcome === BURN_OUTCOME.BOUGHT && cfg1.buybacks === cfg0.buybacks + 1n && burned > 0n && burned === be.baseBurned && mint0.supply - mint1.supply === burned, label + ": coins were burned: " + coins(burned) + " " + s.sym + ", supply " + coins(mint0.supply) + " to " + coins(mint1.supply));
    check(spentQ === plan.spend && be.quoteSpent === plan.spend && t1 === t0 - plan.spend && cfg1.obsSlot >= cfg0.obsSlot + BURN_INTERVAL_SLOTS, label + ": the run spent what the card said: " + sol(spentQ) + " of " + sol(t0) + " SOL, " + sol(t1 || 0n) + " stays in the treasury. It came " + (cfg1.obsSlot - cfg0.obsSlot) + " slots after the record it bought against");
    check(press.text.startsWith("Buyback done. It spent " + fmtUnits(be.quoteSpent, 9, 6) + " SOL and burned " + fmtUnits(be.baseBurned, 6, 2) + " " + s.sym + "."), label + ": the message says what the chain did: \"" + press.text + "\"");
    const shown = await until("(() => { for (const dt of document.querySelectorAll('#hookCard .params dt')) if (dt.textContent.trim() === 'Buybacks run') return dt.nextElementSibling.textContent.trim() === " + q(String(cfg1.buybacks)) + "; return false; })()", 20000, 300);
    const c = await readCard();
    check(shown && c.kv["Burned so far"] === fmtUnits(cfg1.totalBaseBurned, 6, 2) + " " + s.sym && c.kv["Treasury balance"] === fmtUnits(t1, 9, 4) + " SOL", label + ": the card follows the buyback without a reload: burned so far " + c.kv["Burned so far"] + ", buybacks run " + c.kv["Buybacks run"] + ", treasury " + c.kv["Treasury balance"] + "; the chain says burned " + fmtUnits(cfg1.totalBaseBurned, 6, 2) + " " + s.sym + ", buybacks run " + cfg1.buybacks + ", treasury " + sol(t1));
    const rowOk = await until("(() => { const td = document.querySelector('#trades tbody tr td:nth-child(2)'); return !!td && td.textContent.trim() === 'buyback'; })()", 25000, 300);
    check(rowOk, label + ": the recent-trades table lists it as \"buyback\": " + ((await pg(() => { const tr = document.querySelector("#trades tbody tr"); return tr ? [...tr.children].map((td) => td.textContent.trim()).slice(0, 6).join(" | ") : ""; })) || "no row"));
    // the states the round went through, in the order asked for (a wait for the 25 slots may come on top)
    let i = 0; for (const st of seen) if (st === wantSteps[i]) i++;
    check(i === wantSteps.length, label + ": the button went through " + seen.map((x) => (x === "observe" ? "record" : x === "tooSoon" ? "wait " + BURN_INTERVAL_SLOTS + " slots" : x === "wait" ? "record again" : "buy")).join(", then ") + " (asked for: " + wantSteps.join(", ") + ")");
    sum["buyback" + round] = seen.join(" > ") + ": spent " + sol(spentQ) + " of " + sol(t0) + " SOL, burned " + coins(burned) + " " + s.sym + ", " + sol(t1) + " left";
    return;
  }
  check(false, label + ": no press bought after six turns: " + seen.join(", "));
}

/// A pool on a frozen hook that is not a platform program: the one named on the command line,
/// or the newest on chain whose hook can change the amounts of a trade.
async function findThird() {
  if (thirdArg) { const p = await client.pool(new PublicKey(thirdArg)); if (!p) throw new Error("no pool at " + thirdArg); return p; }
  const all = (await client.allPools()).filter((p) => p.hasHook && p.hookKind === HOOK_KIND.FROZEN && !OUR.includes(p.hookProgram.toBase58()));
  all.sort((a, b) => (b.createdSlot > a.createdSlot ? 1 : -1));
  return all.find((p) => setsAmounts(p, DIRECTION.BUY) && setsAmounts(p, DIRECTION.SELL)) || all.find((p) => setsAmounts(p, DIRECTION.BUY)) || all[0] || null;
}

try {
  ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === "Runtime.exceptionThrown") pageErrors.push(where.split("?")[0] + "  EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") pageErrors.push(where.split("?")[0] + "  console.error " + d.params.args.map((a) => a.value || a.description).join(" "));
    else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") pageErrors.push(where.split("?")[0] + "  " + d.params.entry.source + " error " + d.params.entry.text + (d.params.entry.url ? " " + d.params.entry.url.slice(0, 120) : ""));
    else if (d.method) events.push(d.method);
  };
  await call("Page.enable"); await call("Runtime.enable"); await call("Log.enable");
  // headless Edge now and then reports the page as hidden, and a hidden page pauses its polls
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await view(W, HGT, "dark");
  console.log("run " + run + ", parts " + wanted.join(",") + ", site " + origin + ", chain " + RPC + ", platform treasury " + plat.treasury.toBase58() + ", protocol fee " + fmtPct(plat.protocolFeeBps) + ", launch fee " + sol(plat.launchFeeLamports) + " SOL");
  console.log("wallets: second wallet " + trader.publicKey.toBase58() + ", liquidity wallet " + lp.publicKey.toBase58() + ", visitor " + visitor.publicKey.toBase58());

  // ---- A. the four choices ---------------------------------------------------------------------------
  for (const key of ["none", "tax", "launch_guard", "buyback"]) if (want(SPEC[key].n)) await section(SPEC[key].n + ". \"" + SPEC[key].label + "\": launch, chain, coin page, buy and sell (dev wallet " + dev[key].publicKey.toBase58() + ")", () => runChoice(key));

  // ---- A5. the explore page ------------------------------------------------------------------------
  if (want("A5")) await section("A5. the explore page lists the four coins", async () => {
    for (const key of Object.keys(SPEC)) await need(key);
    await open(trader, "/index.html", "!!document.querySelector('#grid .coin-card:not(.ghost)')");
    await type("#search", run + " tp");
    await sleep(1500);
    const cardOf = (addr) => pg((a) => { const c = document.querySelector('.coin-card[data-pool="' + a + '"]'); if (!c) return null; const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : ""); return { name: t(c.querySelector(".coin-link")), pair: t(c.querySelector(".coin-pair")), kind: c.dataset.kind, cap: t(c.querySelector(".coin-figs .v")), href: c.querySelector(".coin-link").getAttribute("href") }; }, addr);
    for (const key of Object.keys(SPEC)) {
      const s = SPEC[key], out = R[key];
      const card = await cardOf(out.pool.toBase58());
      if (!check(!!card, "explore: \"" + s.name + "\" has a card")) continue;
      check(card.name === s.name && card.pair === s.sym + " / SOL" && card.kind === (s.program ? "Platform hook" : "") && /SOL$/.test(card.cap) && card.href === "coin.html?pool=" + out.pool.toBase58(),
        "explore: " + s.sym + " | kind " + (card.kind || "none") + " | market cap " + card.cap + " | opens its coin");
    }
    await scrollTo("#grid"); await sleep(300); await shot("-explore-1440");
  });

  // ---- B. liquidity ------------------------------------------------------------------------------------
  if (want("B")) await section("B. add and remove liquidity through the pool page", async () => {
    const out = await need("tax");
    const C = out.coin, s = SPEC.tax;
    let p = await client.pool(C.pool);
    // the liquidity wallet gets its coins with a plain buy through the SDK
    await sendNode(await client.swapInstructions(lp.publicKey, p, await client.hookRef(p, lp.publicKey), DIRECTION.BUY, 300_000_000n, 1n), [lp]);
    held.push([lp, C.pool]);
    await open(lp, "/pool.html?pool=" + C.pool.toBase58(), poolReady);
    p = await client.pool(C.pool);
    const sup = (await client.mint(p.lpMint)).supply, lock = await tokenAmount(p.lpLock);
    say("pool", s.name + " (" + s.sym + "), reserves " + coins(p.reserveBase) + " coins and " + sol(p.reserveQuote) + " SOL, LP supply " + sup + " raw units = " + fmtLp(sup) + " LP, lock account " + lock + " raw units");
    say("one raw LP unit is", coins(mulDivCeil(1n, p.reserveBase, sup)) + " coins and " + sol(mulDivCeil(1n, p.reserveQuote, sup)) + " SOL");
    const locked0 = await kvOf("#locked"), note0 = await txt("#lockedNote");
    say("Your position", await kvOf("#position"));
    say("Locked forever", locked0);
    say("note under it", note0);
    check(lock === sup && locked0["In the lock account"] === fmtLp(lock) + " LP" && locked0["LP supply"] === fmtLp(sup) + " LP" && locked0["Held by wallets"] === "0 LP" && locked0["Locked share"] === "100%" && locked0["Locked reserves"] === fmtUnits(p.reserveBase, 6, 0) + " " + s.sym + ", " + fmtUnits(p.reserveQuote, 9, 4) + " SOL",
      "before any deposit the Locked forever card is the chain: " + locked0["In the lock account"] + " in the lock account of a supply of " + locked0["LP supply"] + ", " + locked0["Held by wallets"] + " held by wallets, locked share " + locked0["Locked share"]);
    check(note0 === "The launch put all the liquidity it made into the pool's lock account. The pool program has no instruction that moves what is there, so that share of the reserves can never be withdrawn. No wallet holds LP of this pool right now." && !/burn/i.test(note0), "the note under it is true and says locked, not burned");
    // the smallest amount that can be typed: one lamport
    await type("#addAmount", "0.000000001");
    const tiny = await kvOf("#addKv");
    const tinyLp = mulDivFloor(1n, sup, p.reserveQuote);
    check(tiny["LP you receive"] === fmtLp(tinyLp) && tiny["SOL needed"] === fmtUnits(mulDivCeil(tinyLp, p.reserveQuote, sup), 9, 9), "one lamport, the smallest amount that can be typed, gets a true answer: LP you receive " + tiny["LP you receive"] + " (" + tinyLp + " raw units), SOL needed " + tiny["SOL needed"]);
    // a deposit by SOL
    await type("#addAmount", "0.05");
    const add = await kvOf("#addKv");
    const lpN = mulDivFloor(50_000_000n, sup, p.reserveQuote), baseN = mulDivCeil(lpN, p.reserveBase, sup), quoteN = mulDivCeil(lpN, p.reserveQuote, sup);
    say("typed 0.05 SOL, the form says", add);
    say("chain math for it", lpN + " raw LP units = " + fmtLp(lpN) + " LP, " + coins(baseN) + " coins, " + sol(quoteN) + " SOL");
    check(add[s.sym + " needed"] === fmtUnits(baseN, 6, 4) && add["SOL needed"] === fmtUnits(quoteN, 9, 6), "add form: coins needed " + add[s.sym + " needed"] + " and SOL needed " + add["SOL needed"] + " are the amounts the pool will take");
    check(add["Your share after"] === fmtShare(lpN, sup + lpN), "add form: your share after " + add["Your share after"] + " = " + lpN + " of " + (sup + lpN) + " LP units");
    check(add["LP you receive"] === fmtLp(lpN) && rawOf(add["LP you receive"], 6) === lpN, "add form: \"LP you receive\" shows the LP this deposit mints to the last unit: " + add["LP you receive"] + " (" + lpN + " raw units)");
    check(!(await txt("#addMsg")), "add form: a wallet without a wrapped SOL account gets no note about wrapped SOL");
    await scrollTo("#addCard"); await sleep(250); await shot("-pool-1440");
    const sol0 = BigInt(await conn.getBalance(lp.publicKey)), coins0 = await coinsOf(lp.publicKey, C.mint), hadLp = !!(await conn.getAccountInfo(pda.ata(lp.publicKey, p.lpMint)));
    await clearToasts();
    await click("#addBtn");
    const added = await until("/Added/.test(document.querySelector('#addResult').textContent) || !!document.querySelector('#addResult .bad')", 45000, 200);
    if (!check(added && /Added/.test(await txt("#addResult")), "the deposit confirms: " + (await txt("#addResult")))) throw new Error("the deposit did not go through");
    await until("(() => { for (const dt of document.querySelectorAll('#position dt')) if (dt.textContent.trim() === 'Pool share') return dt.nextElementSibling.textContent.trim() !== '0%'; return false; })()", 12000, 300);
    await sleep(600);
    const addTx = await txOf(sigIn(await ev("(document.querySelector('#addResult a.link') || {}).href || ''")));
    const p1 = await client.pool(C.pool), lpBal = await client.tokenBalance(lp.publicKey, p.lpMint), coins1 = await coinsOf(lp.publicKey, C.mint), sol1 = BigInt(await conn.getBalance(lp.publicKey));
    const sup1 = (await client.mint(p.lpMint)).supply;
    check(lpBal === lpN && sup1 === sup + lpN, "chain: the wallet holds " + lpBal + " raw LP units, the LP supply is " + sup1);
    check(coins0 - coins1 === baseN && p1.reserveBase - p.reserveBase === baseN, "chain: " + coins(coins0 - coins1) + " coins left the wallet, the amount the form showed");
    check(p1.reserveQuote - p.reserveQuote === quoteN && sol0 - sol1 === quoteN + BigInt(addTx.meta.fee) + (hadLp ? 0n : ATA_RENT), "chain: the pool took " + sol(p1.reserveQuote - p.reserveQuote) + " SOL, the amount the form showed; the wallet paid " + sol(sol0 - sol1) + " with the network fee" + (hadLp ? "" : " and the rent of its new LP account"));
    const pos = await kvOf("#position"), locked1 = await kvOf("#locked"), note1 = await txt("#lockedNote");
    say("Your position after", pos);
    say("Locked forever after", locked1);
    say("note under it after", note1);
    check(pos["LP balance"] === fmtLp(lpBal), "position: \"LP balance\" shows the LP the wallet holds: " + pos["LP balance"] + " (" + lpBal + " raw units)");
    check(pos["Pool share"] === fmtShare(lpBal, sup1) && pos["Worth in " + s.sym] === fmtUnits(mulDivFloor(lpBal, p1.reserveBase, sup1), 6, 2) && pos["Worth in SOL"] === fmtUnits(mulDivFloor(lpBal, p1.reserveQuote, sup1), 9, 6), "position: pool share " + pos["Pool share"] + ", worth " + pos["Worth in " + s.sym] + " " + s.sym + " and " + pos["Worth in SOL"] + " SOL, as on chain");
    check(locked1["Held by wallets"] === fmtLp(sup1 - lock) + " LP" && locked1["In the lock account"] === fmtLp(lock) + " LP" && locked1["LP supply"] === fmtLp(sup1) + " LP", "\"Held by wallets\" counts the LP that wallets hold: " + locked1["Held by wallets"] + " of a supply of " + locked1["LP supply"] + " (" + (sup1 - lock) + " raw units are out)");
    check(locked1["Locked share"] === fmtShare(lock, sup1) && locked1["Locked reserves"] === fmtUnits(mulDivFloor(lock, p1.reserveBase, sup1), 6, 0) + " " + s.sym + ", " + fmtUnits(mulDivFloor(lock, p1.reserveQuote, sup1), 9, 4) + " SOL" && /The rest belongs to wallets that added liquidity\. They can take it out\.$/.test(note1),
      "the locked share is the lock account against the supply: " + locked1["Locked share"] + " of the reserves (" + locked1["Locked reserves"] + ") can never be withdrawn, and the note says the rest belongs to wallets that added liquidity");
    await ev("window.scrollTo(0, 0); true"); await sleep(250); await shot("-pool-after-add-1440");
    await view(375, 900, "dark"); await sleep(300); await shot("-pool-after-add-375");
    check(await fits(), "pool page: no horizontal scroll at 375 (" + (await overflow()) + ")");
    await view(W, HGT, "dark");
    // the coin page of the same pool says the same about the lock
    const liqWant = await liquidityText(p1);
    // remove all of it
    await clearToasts();
    await click("#removeQuick button:nth-child(3)");
    await sleep(300);
    const rem = await kvOf("#removeKv");
    const baseOut = mulDivFloor(lpBal, p1.reserveBase, sup1), quoteOut = mulDivFloor(lpBal, p1.reserveQuote, sup1);
    say("remove 100%, the form says", rem);
    check(rem[s.sym + " out"] === fmtUnits(baseOut, 6, 4) && rem["SOL out"] === fmtUnits(quoteOut, 9, 6), "remove form: " + rem[s.sym + " out"] + " coins and " + rem["SOL out"] + " SOL out, as the chain will pay");
    check(rem["LP you give back"] === fmtLp(lpBal) && !Object.keys(rem).some((k) => /burn/i.test(k)), "remove form: \"LP you give back\" shows the LP that leaves the wallet: " + rem["LP you give back"]);
    const sol2 = BigInt(await conn.getBalance(lp.publicKey));
    await click("#removeBtn");
    const removed = await until("/Removed/.test(document.querySelector('#removeResult').textContent) || !!document.querySelector('#removeResult .bad')", 45000, 200);
    if (!check(removed && /Removed/.test(await txt("#removeResult")), "the withdrawal confirms: " + (await txt("#removeResult")))) throw new Error("the withdrawal did not go through");
    await sleep(900);
    const remTx = await txOf(sigIn(await ev("(document.querySelector('#removeResult a.link') || {}).href || ''")));
    const p2 = await client.pool(C.pool), coins2 = await coinsOf(lp.publicKey, C.mint), sol3 = BigInt(await conn.getBalance(lp.publicKey));
    check((await client.tokenBalance(lp.publicKey, p.lpMint)) === 0n && (await client.mint(p.lpMint)).supply === sup && (await tokenAmount(p.lpLock)) === lock, "chain: the wallet holds no LP, the LP supply is back to " + sup + " raw units, and the lock account still holds all " + lock + " of them");
    check(coins2 - coins1 === baseOut && sol3 - sol2 === quoteOut - BigInt(remTx.meta.fee) && p1.reserveQuote - p2.reserveQuote === quoteOut, "chain: " + coins(coins2 - coins1) + " coins and " + sol(quoteOut) + " SOL came back as plain SOL, the amounts the form showed (the deposit was " + coins(baseN) + " and " + sol(quoteN) + ": the rounding in and out stays in the pool)");
    // the other way to enter a deposit: by LP amount, and this one is sent
    await click("#addMode [data-mode=lp]");
    await type("#addAmount", "1000");
    const byLp = await kvOf("#addKv");
    const lpL = 1_000_000_000n, baseL = mulDivCeil(lpL, p2.reserveBase, sup), quoteL = mulDivCeil(lpL, p2.reserveQuote, sup);
    say("By LP amount, typed 1000", byLp);
    check(byLp["LP you receive"] === "1,000" && byLp[s.sym + " needed"] === fmtUnits(baseL, 6, 4) && byLp["SOL needed"] === fmtUnits(quoteL, 9, 6) && byLp["Your share after"] === fmtShare(lpL, sup + lpL), "By LP amount: 1,000 LP needs " + byLp[s.sym + " needed"] + " coins and " + byLp["SOL needed"] + " SOL, a share of " + byLp["Your share after"] + ": the pool's own arithmetic for " + lpL + " raw units of a supply of " + sup);
    const sol4 = BigInt(await conn.getBalance(lp.publicKey));
    await clearToasts();
    await click("#addBtn");
    const added2 = await until("/Added/.test(document.querySelector('#addResult').textContent) || !!document.querySelector('#addResult .bad')", 45000, 200);
    if (check(added2 && /Added/.test(await txt("#addResult")), "By LP amount: the deposit confirms: " + (await txt("#addResult")))) {
      await sleep(900);
      const tx = await txOf(sigIn(await ev("(document.querySelector('#addResult a.link') || {}).href || ''")));
      const p3 = await client.pool(C.pool), got = await client.tokenBalance(lp.publicKey, p.lpMint);
      check(got === lpL && p3.reserveBase - p2.reserveBase === baseL && p3.reserveQuote - p2.reserveQuote === quoteL && sol4 - BigInt(await conn.getBalance(lp.publicKey)) === quoteL + BigInt(tx.meta.fee), "By LP amount, chain: the wallet received exactly " + fmtLp(got) + " LP and paid the " + coins(baseL) + " coins and " + sol(quoteL) + " SOL the form showed");
      await until("(() => { for (const dt of document.querySelectorAll('#position dt')) if (dt.textContent.trim() === 'LP balance') return dt.nextElementSibling.textContent.trim() === '1,000'; return false; })()", 12000, 300);
      await clearToasts();
      await click("#removeQuick button:nth-child(3)"); await sleep(300);
      await click("#removeBtn");
      await until("/Removed/.test(document.querySelector('#removeResult').textContent) || !!document.querySelector('#removeResult .bad')", 45000, 200);
      check(/Removed/.test(await txt("#removeResult")) && (await client.tokenBalance(lp.publicKey, p.lpMint)) === 0n, "By LP amount: and it comes out again: " + (await txt("#removeResult")));
    }
    // the coin page says the same about the lock while a wallet holds LP (read above, checked against a fresh deposit below)
    await sendNode(await client.addLiquidityInstructions(lp.publicKey, await client.pool(C.pool), lpN, baseN * 2n, quoteN * 2n), [lp]);
    const pNow = await client.pool(C.pool);
    await open(lp, coinPath(C.pool), coinReady);
    const liq = await txt("#liqCard p"), wantNow = await liquidityText(pNow);
    check(liq === wantNow && /of this pool's liquidity is locked\./.test(liq), "coin page, while a wallet holds LP: \"" + liq + "\"");
    say("the same sentence right after the first deposit would have been", liqWant);
    await sendNode(await client.removeLiquidityInstructions(lp.publicKey, pNow, lpN, 0n, 0n), [lp]);

    // a pool where one raw unit of LP is worth more than the smallest amount that can be typed: a coin with a supply of one
    const mint = Keypair.generate();
    const plan = await client.launchInstructions({ dev: tinyDev.publicKey, mint, name: "Tpl One " + run, symbol: "TP1" + run, uri: origin + "/package.json?coin=tp1" + run, decimals: 6, totalSupply: 1_000_000n, quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: SEED, devBuyQuote: 0n, minDevBuyOut: 0n, template: "none" });
    await sendNode(plan.createTx, [tinyDev, mint]);
    await sendNode(plan.launchTx, [tinyDev]);
    const tp = await client.pool(plan.pool), tsup = (await client.mint(tp.lpMint)).supply;
    const leastQ = mulDivCeil(1n, tp.reserveQuote, tsup), leastB = mulDivCeil(1n, tp.reserveBase, tsup);
    say("a coin with a supply of one", "pool " + plan.pool.toBase58() + ", LP supply " + tsup + " raw units for " + sol(tp.reserveQuote) + " SOL: one raw unit of LP is " + sol(leastQ) + " SOL");
    await open(lp, "/pool.html?pool=" + plan.pool.toBase58(), poolReady);
    await type("#addAmount", "0.00000001");
    const small = await kvOf("#addKv"), smallMsg = await txt("#addMsg");
    const wantMsg = "That is too little to mint any LP. The smallest deposit here is " + fmtUnits(leastQ, 9, 9) + " SOL with " + fmtUnits(leastB, 6, 6) + " TP1" + run + ".";
    check(Object.keys(small).length === 0 && smallMsg === wantMsg, "an amount below one raw unit of LP gets a clear message: \"" + smallMsg + "\"");
    const pr0 = await prompts();
    await click("#addBtn"); await sleep(1200);
    check((await prompts()) === pr0 && (await txt("#addResult")) === wantMsg, "pressing Add liquidity with it asks for no signature and repeats the message");
    R.liquidity = { coin: s.sym, typed: "0.05 SOL", lp: fmtLp(lpN), coinsIn: coins(baseN), solIn: sol(quoteN), coinsOut: coins(baseOut), solOut: sol(quoteOut), lockedShareWhileHeld: locked1["Locked share"], note: note1 };
  });

  // ---- C. the hook checker ---------------------------------------------------------------------------
  let third = null;
  if (want("C") || want("D") || want("E")) { try { third = await findThird(); } catch (e) { console.log("\n  note: " + e.message); } }
  if (want("C")) await section("C. the hook checker on hooks.html", async () => {
    await open(trader, "/hooks.html", "!!document.querySelector('#checkBtn') && !!document.querySelector('#try button')");
    // the pick list above the checker counts the pools on each hook
    await until("((document.querySelector('#pickList [data-count=tax]') || {}).textContent || '') !== ''", 15000);
    const shownCounts = await pg(() => { const o = {}; for (const n of document.querySelectorAll("#pickList [data-count]")) o[n.dataset.count] = n.textContent.trim(); return o; });
    const allNow = await client.allPools();
    const templates = { rules: PROGRAMS.hook_rules, tax: PROGRAMS.hook_tax, launch_guard: PROGRAMS.hook_launch_guard, buyback: PROGRAMS.hook_buyback, collectible: PROGRAMS.hook_collectible };
    const wantCounts = { custom: allNow.filter((p) => p.hasHook && !Object.values(templates).some((t) => t.equals(p.hookProgram))).length };
    for (const [k, prog] of Object.entries(templates)) wantCounts[k] = allNow.filter((p) => p.hasHook && p.hookProgram.equals(prog)).length;
    const word = (n) => (n ? n + (n === 1 ? " pool" : " pools") : "");
    const near = (k) => { const n = parseInt(shownCounts[k] || "0", 10) || 0; return Math.abs(n - wantCounts[k]) <= 2; };
    check(Object.keys(wantCounts).every(near), "the pick list counts the pools on each hook: " + JSON.stringify(shownCounts) + ", chain a moment later " + JSON.stringify(Object.fromEntries(Object.entries(wantCounts).map(([k, n]) => [k, word(n)]))) + " (the chain is shared: other tools launch coins while this runs, so a difference of one or two is theirs)");
    // the list opens on Launch rules, the first of the five templates
    await click("#pickList [data-pick=tax]"); await sleep(300);
    const chips = await pg(() => [...document.querySelectorAll("#pickPanel .chip")].map((c) => c.textContent.trim()));
    check(chips.includes("fee cap " + fmtPct(plat.maxHookFeeBps, 0)), "the tax panel names the platform's fee cap: " + chips.join(", "));
    const panel = await txt("#pickPanel");
    check(/It collects as wrapped SOL in that wallet's wrapped SOL account, and the owner takes it from the coin page\./.test(panel), "the tax panel says where the tax collects and how the owner takes it");
    await click("#pickList [data-pick=buyback]"); await sleep(300);
    const bbPanel = await txt("#pickPanel");
    check(bbPanel.includes("The slice follows the fees of the coin and is never above " + fmtPct(MAX_BURN_CAP_BPS) + " of the pool's SOL, so a large treasury takes several runs. A run buys against a price the pool had at least " + BURN_INTERVAL_SLOTS + " slots earlier, so the first call only records the pool.") && !/One run spends the treasury, up to/.test(bbPanel), "the buyback panel says how a run works now: a slice that follows the coin's fees, against a price at least " + BURN_INTERVAL_SLOTS + " slots old");
    await click("#pickList [data-pick=launch_guard]"); await sleep(300);
    const guardPanel = await txt("#pickPanel");
    const guardMan = await conn.getAccountInfo(pda.manifest(PROGRAMS.hook_launch_guard)), guardFlags = guardMan ? decodeHookManifest(new Uint8Array(guardMan.data)).flags : 0;
    check(guardPanel.includes("Nobody can add liquidity while the window runs.") && guardPanel.includes(LIQ_SENTENCE) && (guardFlags & FLAGS.BEFORE_ADD_LIQ) !== 0, "the guard panel says nobody can add liquidity while the window runs, and gives the flags of the program on chain (" + guardFlags + ") in words");
    const doc = await txt("article.doc");
    check(/Test on a local validator started from the package first/.test(doc) && /runs on mainnet/.test(doc) && !/test on devnet/i.test(doc) && !/not on mainnet/.test(doc), "the guide for hook authors says to test on a local validator first and that the pool program runs on mainnet");
    check(/Frozen means the code\./.test(doc) && /The pool never passes one of them as a signer/.test(doc) && /On a buy the pool takes the protocol fee/.test(doc) && /Every fee rounds up\./.test(doc), "the guide says what frozen means, that extra accounts never sign, and the order of the fees");
    const readCheck = () => pg(() => {
      const o = document.querySelector("#checkOut"); const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
      const v = o.querySelector(".verdict"); const lists = [...o.querySelectorAll("ul.check-list")];
      const li = (ul) => (ul ? [...ul.querySelectorAll("li")].map((x) => (x.className ? "[" + x.className + "] " : "") + t(x)) : []);
      return { verdict: t(v), lines: li(lists[0]), words: li(lists[1]), small: [...o.querySelectorAll("p")].map(t), links: [...o.querySelectorAll("a")].map((a) => t(a) + " -> " + a.getAttribute("href")), all: t(o) };
    });
    const runCheck = async (value) => {
      await type("#hookId", value);
      await click("#checkBtn");
      await sleep(400);
      await until("(() => { const o = document.querySelector('#checkOut'); return !!o && o.textContent.trim() !== '' && !/^Reading the program$/.test(o.textContent.trim()); })()", 20000);
      await sleep(300);
      return readCheck();
    };
    const authorityOf = async (program) => { const pd = await conn.getAccountInfo(pda.programData(program), { dataSlice: { offset: 0, length: 45 } }); return decodeUpgradeAuthority(new Uint8Array(pd.data)); };
    const listed = (key) => !!key && plat.whitelist.some((k) => k.equals(key));
    R.checker = {};
    // 1. a platform template
    const taxAuth = await authorityOf(PROGRAMS.hook_tax);
    let c = await runCheck(PROGRAMS.hook_tax.toBase58());
    R.checker.tax = c;
    say("tax template " + short(PROGRAMS.hook_tax.toBase58()), c.verdict + " | " + c.lines.join(" | ") + " | Flags in words: " + c.words.join(" ") + " | " + c.small.join(" | ") + " | " + c.links.join(", "));
    say("chain", "upgrade authority " + (taxAuth ? taxAuth.toBase58() : "none") + ", on the platform whitelist: " + listed(taxAuth));
    check(!!taxAuth && listed(taxAuth) && c.verdict === "A pool would accept this hook." && c.lines[0] === "Not frozen: upgrade authority " + short(taxAuth.toBase58(), 5) + "." && /^\[yes\] Whitelisted authority: a platform key, so the pool accepts it as a platform template\.$/.test(c.lines[1] || "") && !c.lines.some((l) => /Not a platform program/.test(l)), "the tax template: the checker says it is not frozen, names its upgrade authority, and says that key is a platform key. True on chain");
    check(/Manifest found: Programmable tax/.test(c.lines[2] || "") && /Extra accounts list found/.test(c.lines[3] || "") && c.words.join(" ") === "Runs on buys and sells. " + FEE_SENTENCE && c.links.some((l) => l === "Launch with this hook -> launch.html?template=tax"), "the tax template: manifest, extra accounts list, flags in words with the cap on chain, and a link to launch with the tax card");
    await scrollTo("#checker"); await sleep(250); await shot("-checker-tax-1440");
    // 2. a frozen hook of someone else
    if (!third) skip("C: the checker on a frozen hook of someone else. No pool on such a hook is on this chain.");
    else {
      const hookId = third.hookProgram;
      const thirdAuth = await authorityOf(hookId);
      c = await runCheck(hookId.toBase58());
      R.checker.third = c;
      say("third-party hook " + short(hookId.toBase58()), c.verdict + " | " + c.lines.join(" | ") + " | Flags in words: " + c.words.join(" ") + " | " + c.small.join(" | ") + " | " + c.links.join(", "));
      say("chain", "upgrade authority " + (thirdAuth ? thirdAuth.toBase58() : "none (frozen)") + ", a program of the platform: " + OUR.includes(hookId.toBase58()));
      check(thirdAuth === null && c.verdict === "A pool would accept this hook." && c.lines[0] === "[yes] Frozen. Nobody can change this program's code. The accounts it keeps can still change." && c.lines[1] === "Whitelist not needed for a frozen program.", "the third-party hook: the checker says its code is frozen, and that its own accounts can still change. True on chain");
      check(c.lines[2] === "Not a platform program. Someone else wrote it. The pool checks that its code is frozen and, while the approved list is on, that Programmable approved it. The pool does not check what the code does." && !c.lines.some((l) => /platform (template|key|hook)/.test(l)), "the third-party hook: the checker says in words that it is not a platform program: \"" + c.lines[2] + "\"");
      const man = await conn.getAccountInfo(pda.manifest(hookId)), flags = man ? decodeHookManifest(new Uint8Array(man.data)).flags : 0, sum = describeFlags(flags);
      check(/^\[yes\] Manifest found: /.test(c.lines[3] || "") && c.words.length >= sum.sentences.length && (!sum.canTakeFee || c.words.includes(FEE_SENTENCE)) && (!(sum.canTakeFee && sum.runsOnSells) || c.words.some((w) => /^It can refuse .*sell\. The pool cannot overrule that\.$/.test(w))), "the third-party hook: its manifest and its flags in words, with the cap in numbers and what it can refuse: " + c.words.join(" "));
      check((flags & FLAGS.OVERRIDE_CURVE) ? !c.links.some((l) => /^Launch with this hook/.test(l)) : c.links.some((l) => l === "Launch with this hook -> launch.html?template=custom&hook=" + hookId.toBase58()), "the third-party hook: " + ((flags & FLAGS.OVERRIDE_CURVE) ? "no launch link, the launchpad does not take a hook that sets the price" : "its launch link goes to the Custom hook card"));
      await scrollTo("#checker"); await sleep(250); await shot("-checker-thirdparty-1440");
    }
    // 2b. a frozen hook that no pool runs on yet. The verdict is what create_pool reads before it calls
    //     the hook; the hook's own code can still refuse that call, and the checker has to say so.
    //     The workshop's fixtures name the hook programs on this chain; one of them may be unused.
    let unused = null;
    try {
      const fx = JSON.parse(readFileSync(new URL("./workshop-fixtures/hooks.json", import.meta.url), "utf8"));
      for (const fid of Object.values(fx)) {
        const key = new PublicKey(fid);
        if (allNow.some((p) => p.hasHook && p.hookProgram.equals(key))) continue;
        const [acc, man] = await Promise.all([conn.getAccountInfo(key), conn.getAccountInfo(pda.manifest(key))]);
        if (acc && man) { unused = key; break; }
      }
    } catch (_) {}
    const NO_POOL = "No pool has been created on it yet, so nothing shows that the pool can call it. The pool reads what is listed here before its first call, and the hook's own code can still refuse that call.";
    if (!unused) skip("C: the checker on a frozen hook that no pool runs on. None of the workshop's fixture hooks is in that state on this chain.");
    else {
      c = await runCheck(unused.toBase58());
      R.checker.unused = c;
      const still = !(await client.allPools()).some((p) => p.hasHook && p.hookProgram.equals(unused));
      check(still && c.verdict === "A pool would accept this hook." && c.small.includes(NO_POOL), "a frozen hook that no pool runs on (" + short(unused.toBase58()) + "): under \"" + c.verdict + "\" the checker says: \"" + (c.small.find((x) => /No pool has been created/.test(x)) || "nothing") + "\"");
    }
    check(!R.checker.tax.small.includes(NO_POOL) && (!R.checker.third || !R.checker.third.small.includes(NO_POOL)), "the tax template and the hook that pools run on do not get that sentence");
    // 3. an address with nothing at it, a wallet, and something that is no address
    const nothing = Keypair.generate().publicKey;
    c = await runCheck(nothing.toBase58());
    R.checker.random = c;
    say("random address " + short(nothing.toBase58()), c.all);
    check((await conn.getAccountInfo(nothing)) === null && !c.verdict && c.lines.length === 1 && c.lines[0] === "[no] No account at this address on localnet.", "a random address: the checker says there is no account there, and gives no verdict. True on chain");
    await scrollTo("#checker"); await sleep(250); await shot("-checker-random-1440");
    c = await runCheck(trader.publicKey.toBase58());
    R.checker.wallet = c;
    check(!c.verdict && c.lines[0] === "[no] This account is not a program.", "a wallet address: \"" + c.all + "\"");
    c = await runCheck("not an address");
    R.checker.garbage = c;
    check(c.all === "That is not a valid address.", "text that is no address: \"" + c.all + "\"");
    await view(375, 900, "dark"); await scrollTo("#checker"); await sleep(300); await shot("-checker-375");
    check(await fits(), "hooks page: no horizontal scroll at 375 (" + (await overflow()) + ")");
    await view(W, HGT, "dark");
  });

  // ---- D. the coin on the third-party hook -------------------------------------------------------------
  if (want("D")) await section("D. the coin on a frozen hook of someone else", async () => {
    if (!third) { skip("D: a coin on a frozen hook of someone else (hook card, a buy and a sell from a simulation). No such pool is on this chain."); return; }
    const POOL = third.address;
    const p = await client.pool(POOL);
    const md = await client.metadata(p.baseMint);
    const C = { pool: POOL, mint: p.baseMint, symbol: md.symbol, info: await client.hookInfo(p) };
    const sum = describeFlags(p.hookFlags);
    const tre = p.hookQuoteTreasury.equals(SYSTEM_PROGRAM) ? null : await conn.getAccountInfo(p.hookQuoteTreasury);
    check(p.hookKind === HOOK_KIND.FROZEN && !OUR.includes(p.hookProgram.toBase58()), "chain: pool " + short(POOL.toBase58()) + " trades " + md.name + " (" + md.symbol + ") on the frozen hook " + p.hookProgram.toBase58() + ", which is not a platform program");
    say("chain", "pool fee " + fmtPct(p.lpFeeBps) + ", flags " + p.hookFlags + " (" + sum.sentences.join(" ") + "), hook treasury " + p.hookQuoteTreasury.toBase58() + (tre ? " exists" : " does not exist right now") + ", hook fees so far " + sol(p.hookFeesQuoteTotal) + " SOL, waiting in the pool " + sol(p.hookFeesOwedQuote) + " SOL");
    say("this hook sets the amounts of", (setsAmounts(p, DIRECTION.BUY) ? "buys" : "no buys") + " and " + (setsAmounts(p, DIRECTION.SELL) ? "sells" : "no sells") + ", so the page " + (setsAmounts(p, DIRECTION.BUY) ? "has to simulate" : "can use the formula"));
    await open(visitor, coinPath(POOL), coinReady);
    const card = await readCard(), head = await readHead();
    R.third = { pool: POOL.toBase58(), card: card.all, head: head.badge + " | tags " + head.tags.join(", ") };
    say("head", head.title + " | " + head.badge + " | tags " + head.tags.join(", "));
    say("hook card", card.all);
    check(card.badge === "Frozen custom hook" && card.status === "Frozen. Nobody can change this hook's code. The accounts it keeps can still change.", "hook card: \"" + card.badge + "\", " + card.kind + ". " + card.status);
    check(card.sentences[0] === sum.sentences[0] && (!sum.canTakeFee || card.sentences.includes(FEE_SENTENCE)) && (!sum.canOverrideFee || card.sentences.includes(OVERRIDE_SENTENCE)), "hook card: the flags in words, with the platform caps in numbers: " + card.sentences.join(" "));
    if (sum.runsOnSells && (sum.canTakeFee || sum.canOverrideFee || sum.canOverrideCurve)) check(card.sentences.some((w) => /^It can refuse .*sell\. The pool cannot overrule that\.$/.test(w)), "hook card: it says the hook can refuse a sell");
    if (sum.canTakeFee) check(card.kv["Most it can take per trade"] === fmtPct(plat.maxHookFeeBps) && card.kv["Treasury"] === short(p.hookQuoteTreasury.toBase58(), 5) && card.kv["Taken so far"] === fmtUnits(p.hookFeesQuoteTotal, 9, 4) + " SOL", "hook card numbers: the most it can take per trade is " + card.kv["Most it can take per trade"] + " (the platform cap on chain), treasury " + card.kv["Treasury"] + ", taken so far " + card.kv["Taken so far"]);
    if (sum.canOverrideFee) check(card.kv["Highest pool fee it can set"] === fmtPct(plat.maxFeeOverrideBps), "hook card numbers: the highest pool fee it can set is " + card.kv["Highest pool fee it can set"]);
    // this pool is shared: when another wallet trades it between the quote and the trade, the
    // wallet is put back where it was and the trade is done again, three times at most
    const cleanTrade = async (dir, amountText, opts) => {
      let r = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await tradeOnPage(visitor, C, dir, amountText, opts);
        if (r.error || r.clean) return r;
        console.log("        note: another wallet traded this shared pool between the quote and the trade; doing it again");
        if (dir === DIRECTION.BUY) await sellBack(visitor, POOL);
        else { const now = await client.pool(POOL); await sendNode(await client.swapInstructions(visitor.publicKey, now, await client.hookRef(now, visitor.publicKey), DIRECTION.BUY, 100_000_000n, 1n), [visitor]); }
      }
      return r;
    };
    const sidesChecks = (r, label, dec, frac, unit) => {
      // what the page showed before the click, against the trade simulated by this script on the same pool state
      const formula = r.expected ? fmtUnits(r.expected.amountOut, dec, frac) : "";
      if (r.sim) {
        check(!!r.simulated && r.shown.out === fmtUnits(r.simulated, dec, frac), label + ": \"You receive\" is the simulated amount: the page shows " + r.shown.out + ", this script's own simulation gives " + (r.simulated ? fmtUnits(r.simulated, dec, dec) : "nothing (" + r.simError + ")") + "; the formula without the hook would say " + formula);
        check(!!r.simulated && pick(r.shown.kv, "Min received").value === fmtUnits(applyBps(r.simulated, 100), dec, frac) + " " + unit, label + ": \"Min received\" is 1% under the simulated amount: " + pick(r.shown.kv, "Min received").value);
        check(pick(r.shown.kv, "Without the hook").value === formula + " " + unit && /^From a simulation of this trade on chain\./.test(r.shown.note), label + ": the formula's figure is shown apart, as \"Without the hook\" " + pick(r.shown.kv, "Without the hook").value + ", and the form says where the amount comes from: \"" + r.shown.note + "\"");
      } else check(r.shown.out === formula, label + ": the hook cannot change the amounts on this side, so \"You receive\" is the formula: " + r.shown.out);
    };
    // a buy at the form's own settings
    const b = await cleanTrade(DIRECTION.BUY, "0.1");
    held.push([visitor, POOL]);
    say("buy form, 0.1 SOL", "You receive " + b.shown.out + " " + md.symbol + ", " + Object.entries(b.shown.kv).map(([k, v]) => k + " " + v).join("; ") + ", slippage " + b.shown.slippage + ". " + b.shown.note);
    sidesChecks(b, "buy", 6, 2, md.symbol);
    R.third.buyDefault = b.error ? "refused: " + b.error : "went through";
    check(!b.error, "buy: a buy with the form as it opens (slippage " + b.shown.slippage + ") goes through" + (b.error ? ". The page said: " + b.error : ""));
    if (checkTrade(b, visitor, "buy 0.1 SOL on the third-party hook", "loose")) {
      const got = b.coins1 - b.coins0, feeRow = pick(b.shown.kv, "Hook fee");
      if (b.sim) check(b.clean && got === b.simulated, "buy: received " + coins(got) + " = the simulated amount, to the last unit" + (b.clean ? "" : " [another wallet traded this shared pool in between]"));
      check(fmtUnits(got, 6, 2) === b.shown.out, "buy: \"You receive\" " + b.shown.out + " = received " + coins(got));
      check(b.ev.hookFee > 0n ? feeRow.value === fmtUnits(b.ev.hookFee, 9, 6) + " SOL" : feeRow.value === "0", "buy: the \"Hook fee\" row shows what the hook takes: it said \"" + feeRow.label + "\" " + feeRow.value + ", the hook took " + sol(b.ev.hookFee) + " SOL");
      const paidTo = b.treasury1 === null ? "its treasury account does not exist: the fee waits in the pool (" + sol(b.pool1.hookFeesOwedQuote) + " SOL waiting now)" : "its treasury received " + sol(b.treasury1 - (b.treasury0 || 0n)) + " SOL";
      say("the hook took", sol(b.ev.hookFee) + " SOL; " + paidTo);
      R.third.buy = "You receive " + b.shown.out + ", received " + coins(got) + ", hook fee row " + feeRow.label + " " + feeRow.value + ", hook really took " + sol(b.ev.hookFee) + " SOL";
    }
    // the rows have to survive a change of the slippage, and follow it
    await click("#tradeCard .seg [data-dir=buy]");
    await type("#amount", "0.05");
    if (setsAmounts(p, DIRECTION.BUY)) {
      await until("/From a simulation/.test((document.querySelector('#tradeCard .trade-note') || {}).textContent || '')", 20000);
      await click("#tradeCard .slip button:nth-child(3)");
      await sleep(1500);
      const again = await readTrade();
      const simNow = await client.quoteOnChain(visitor.publicKey, await client.pool(POOL), DIRECTION.BUY, 50_000_000n).catch(() => null);
      check(!!simNow && again.out === fmtUnits(simNow, 6, 2) && pick(again.kv, "Min received").value === fmtUnits(applyBps(simNow, 200), 6, 2) + " " + md.symbol && pick(again.kv, "Hook fee").label !== "", "after a change of the slippage to " + again.slippage + " the form still shows the simulated amount (" + again.out + "), its hook fee row (" + pick(again.kv, "Hook fee").label + " " + pick(again.kv, "Hook fee").value + ") and a minimum 2% under it (" + pick(again.kv, "Min received").value + ")");
      await click("#tradeCard .slip button:nth-child(2)");
    }
    await type("#amount", "");
    // hook fees that wait in the pool: the card says so and anyone can pay them out
    const pw = await client.pool(POOL);
    if (pw.hookFeesOwedQuote > 0n) {
      await until("!!document.querySelector('#hookCard .hook-act.owed')", 15000, 300);
      const owedLine = ((await readCard()).acts.find((a) => a.owed) || {});
      check((owedLine.text || "").startsWith(fmtUnits(pw.hookFeesOwedQuote, 9, 6) + " SOL of hook fees wait in the pool. Their treasury account was missing.") && owedLine.button === "Pay them out", "hook card: it says in a plain line what waits in the pool, with the amount on chain (" + sol(pw.hookFeesOwedQuote) + " SOL): \"" + (owedLine.text || "nothing") + "\"");
      const press = await pressForToast("#hookCard .hook-act.owed button");
      const pa = await client.pool(POOL), tAfter = await tokenAmount(pw.hookQuoteTreasury);
      check(/paid to the hook's treasury/.test(press.text) && press.prompts === 1 && pa.hookFeesOwedQuote === 0n && tAfter !== null, "\"Pay them out\" pays them: " + press.text + " On chain nothing waits any more and the treasury account exists (it holds " + sol(tAfter || 0n) + " SOL)");
      R.third.owed = sol(pw.hookFeesOwedQuote) + " SOL waited and was paid out from the page";
    } else say("hook fees waiting in this pool", "none, so the payout from the card is tried in part F");
    await coinShots("thirdparty");
    const sv = await cleanTrade(DIRECTION.SELL, "max");
    say("sell form, all", "You receive " + sv.shown.out + " SOL, " + Object.entries(sv.shown.kv).map(([k, v]) => k + " " + v).join("; ") + ", slippage " + sv.shown.slippage + ". " + sv.shown.note);
    sidesChecks(sv, "sell", 9, 6, "SOL");
    if (checkTrade(sv, visitor, "sell all on the third-party hook", "loose")) {
      const got = sv.ev.amountOut, feeRow = pick(sv.shown.kv, "Hook fee");
      if (sv.sim) check(sv.clean && got === sv.simulated, "sell: received " + sol(got) + " SOL = the simulated amount, to the last lamport" + (sv.clean ? "" : " [another wallet traded this shared pool in between]"));
      check(fmtUnits(got, 9, 6) === sv.shown.out, "sell: \"You receive\" " + sv.shown.out + " SOL = received " + sol(got) + " SOL");
      check(sv.ev.hookFee > 0n ? feeRow.value === fmtUnits(sv.ev.hookFee, 9, 6) + " SOL" : feeRow.value === "0", "sell: the \"Hook fee\" row shows what the hook takes: it said \"" + feeRow.label + "\" " + feeRow.value + ", the hook took " + sol(sv.ev.hookFee) + " SOL");
      R.third.sell = "You receive " + sv.shown.out + " SOL, received " + sol(got) + " SOL, hook fee row " + feeRow.label + " " + feeRow.value + ", hook really took " + sol(sv.ev.hookFee) + " SOL";
    }
  });

  // ---- E. a launch on the third-party hook, through the launch page ------------------------------------
  if (want("E")) await section("E. a coin launched on a frozen hook of someone else, through the Custom hook card of the launch page", async () => {
    // The hook this part knows how to set up is the unchanged program of hook-template/: it wants a
    // config of its own for each pool, made by its init_pool_config before the pool exists.
    const TEMPLATE_FLAGS = FLAGS.BEFORE_SWAP | FLAGS.ON_POOL_CREATE | FLAGS.TAKE_HOOK_FEE | FLAGS.CALL_ON_BUY | FLAGS.CALL_ON_SELL;
    const onTemplate = (await client.allPools()).filter((p) => p.hasHook && p.hookKind === HOOK_KIND.FROZEN && !OUR.includes(p.hookProgram.toBase58()) && p.hookFlags === TEMPLATE_FLAGS);
    onTemplate.sort((a, b) => (b.createdSlot > a.createdSlot ? 1 : -1));
    const hookId = third && third.hookFlags === TEMPLATE_FLAGS ? third.hookProgram : onTemplate.length ? onTemplate[0].hookProgram : null;
    if (!hookId) { skip("E: a launch on a frozen hook of someone else through the launch page. No pool on the program of hook-template/ is on this chain, so its program id is not known."); return; }
    const kp = customDev, sym = "TPC" + run, name = "Tpl Custom " + run;
    const uri = origin + "/package.json?coin=" + sym.toLowerCase();
    await open(kp, "/launch.html?template=custom&hook=" + hookId.toBase58(), "!!document.querySelector('#walletBtn.on') && !!document.querySelector('#launchBtn') && !!document.querySelector('#customVerdict .verdict') && !document.querySelector('#customPool').hidden");
    check((await ev("location.pathname")) === "/launch-hook.html" && (await ev("document.querySelector('#customId').value")) === hookId.toBase58(), "the link from the hook checker opens the Custom hook card with the program id filled in");
    const verdict = await txt("#customVerdict .verdict");
    const lines = await pg(() => [...document.querySelectorAll("#customVerdict .check-lines li")].map((x) => x.textContent.replace(/\s+/g, " ").trim()));
    say("the form says about the hook", verdict + " | " + lines.join(" | "));
    check(verdict === "The pool would accept this hook." && lines.includes("Not a platform program. Someone else wrote it. The pool checks that its code is frozen and, while the approved list is on, that Programmable approved it. The pool does not check what the code does.") && lines.includes(FEE_SENTENCE) && lines.includes("It can refuse a buy or a sell. The pool cannot overrule that."), "the form reads the hook on chain: accepted, frozen, not a platform program, and what it can do in words with the cap in numbers");
    const poolKey = new PublicKey(await txt("#customPool .mono"));
    say("the form names the pool before it exists", poolKey.toBase58());
    await type("#name", name);
    await type("#symbol", sym);
    await type("#seed", SEED_TEXT);
    await type("#devBuy", FIRST_TEXT);
    if (!(await ev("document.querySelector('details.more').open"))) await click("details.more > summary");
    await type("#metaUrl", uri);
    await sleep(900);
    const costs = await kvOf("#costs"), totalText = await txt("#total");
    const rentShown = rawOf(costs["Rent and network fees"], 9) || 0n, totalShown = rawOf(totalText, 9) || 0n;
    say("form says you spend", Object.entries(costs).map(([k, v]) => k + " " + v).join("; ") + "; Total " + totalText);
    check((await txt("#devBuyNote")) === "With a custom hook your first buy accepts whatever the hook returns, within the platform caps." && (await txt("#rentNote")) === "A custom hook can create accounts of its own at launch. Their rent comes on top of this.", "the form says what it cannot know about a custom hook: what the first buy gives, and the rent of accounts the hook creates itself");
    await scrollTo(".hook-body[data-for=custom]"); await sleep(250); await shot("-launch-custom-1440");
    await view(375, 900, "dark");
    await scrollTo(".hook-body[data-for=custom]"); await sleep(250); await shot("-launch-custom-375");
    check(await fits(), "launch form (custom): no horizontal scroll at 375 (" + (await overflow()) + ")");
    await view(W, HGT, "dark");
    // the hook's own config for this pool, as the form tells the dev to make before step 2
    const disc = (n) => createHash("sha256").update("global:" + n).digest().subarray(0, 8);
    const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
    await sendNode([new TransactionInstruction({ programId: hookId, data: Buffer.concat([disc("init_pool_config"), poolKey.toBuffer(), u16(250), u16(500)]), keys: [
      { pubkey: kp.publicKey, isSigner: true, isWritable: true }, { pubkey: kp.publicKey, isSigner: true, isWritable: false },
      { pubkey: pda.cfg(hookId, poolKey), isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }] })], [kp]);
    const before = BigInt(await conn.getBalance(kp.publicKey));
    const p0 = await prompts();
    await click("#launchBtn");
    await until("!!document.querySelector('#result a.btn') || !!document.querySelector('#result .bad')", 90000, 300);
    const ok = await ev("!!document.querySelector('#result a.btn')");
    if (!check(ok && (await prompts()) - p0 === 2, "both launch transactions confirm, with two wallet prompts" + (ok ? "" : ". The page said: " + (await txt("#result")) + " | " + (await txt("#steps"))))) throw new Error("the launch did not go through");
    await sleep(500);
    held.push([kp, poolKey]);
    const spent = before - BigInt(await conn.getBalance(kp.publicKey));
    say("wallet really spent", sol(spent) + " SOL: rent and network fees " + sol(spent - SEED - FIRST - plat.launchFeeLamports) + " SOL, the page said about " + sol(rentShown));
    check(spent <= totalShown && totalShown - spent < 100_000n, "the Total is true for a custom hook that makes no account of its own at launch: the page showed " + totalText + ", the wallet's SOL fell by " + sol(spent));
    const p = await client.pool(poolKey);
    const [lpMint, lock, launch] = await Promise.all([client.mint(p.lpMint), tokenAmount(p.lpLock), client.launchForMint(p.baseMint)]);
    const allLp = isqrt(SUPPLY * SEED), own = feeCeil(FIRST - feeCeil(FIRST, plat.protocolFeeBps), 250);
    check(!!p && p.hookProgram.equals(hookId) && p.hookKind === HOOK_KIND.FROZEN && p.hookFlags === TEMPLATE_FLAGS && p.creator.equals(kp.publicKey), "chain: the pool is at the address the form named, on the hook " + short(hookId.toBase58()) + ", recorded as a frozen custom hook");
    check(lpMint.supply === allLp && lock === allLp && !!launch && launch.lpLocked === initialLp(SUPPLY, SEED), "chain: all the launch liquidity is locked: LP supply " + lpMint.supply + " raw units, all " + lock + " in the pool's lock account");
    const tre = await tokenAmount(wsolOf(kp.publicKey));
    check(p.hookQuoteTreasury.equals(wsolOf(kp.publicKey)) && p.hookTreasuryOwner.equals(kp.publicKey) && tre === own, "chain: the hook's treasury is the dev wallet's wrapped SOL account (the field was left empty) and holds the hook's fee of the dev's own first buy, " + sol(tre || 0n) + " SOL");
    await follow("#result a.btn", coinReady);
    const card = await readCard(), take = card.acts.find((a) => !a.owed);
    check(card.badge === "Frozen custom hook" && card.kv["Most it can take per trade"] === fmtPct(plat.maxHookFeeBps), "the new coin's page says its hook is a frozen custom hook, not a platform program, and gives the cap: " + card.kv["Most it can take per trade"]);
    check(!!take && take.label === "In your treasury" && take.value === fmtUnits(tre, 9, 6) + " SOL" && take.button === "Take it" && take.disabled === false, "for the wallet that receives the hook's fee the card shows what waits and the button that takes it: \"" + (take ? take.text : "nothing") + "\"");
    R.custom = { pool: poolKey.toBase58(), hook: hookId.toBase58(), costShown: totalText, spent: sol(spent) };
  });

  // ---- F. the owner of a tax coin ----------------------------------------------------------------------
  if (want("F")) await section("F. the owner of a tax coin: its treasury, the tax, hook fees that waited, renouncing, liquidity", async () => {
    const taxOut = await need("tax"), otherOut = await need("none");
    const owner = dev.tax, taxC = taxOut.coin, tKey = taxOut.treasury;
    const act = (card, owed) => card.acts.find((a) => a.owed === owed) || null;
    const treasuryLine = async (amount) => until("(() => { const b = document.querySelector('#hookCard .hook-act:not(.owed) .hook-act-v b'); return !!b && b.textContent.trim() === " + q(fmtUnits(amount, 9, 6) + " SOL") + "; })()", 20000, 300);
    const kvIs = (term, value) => until("(() => { for (const dt of document.querySelectorAll('#hookCard .params dt')) if (dt.textContent.trim() === " + q(term) + ") return dt.nextElementSibling.textContent.trim() === " + q(value) + "; return false; })()", 20000, 300);
    const before = await tokenAmount(tKey);
    check(before !== null, "before: the treasury, the owner's wrapped SOL account " + short(tKey.toBase58()) + ", exists and holds " + sol(before || 0n) + " SOL of tax");

    // 1. the owner buys another coin: its wrapped SOL account must come through untouched
    await open(owner, coinPath(otherOut.pool), coinReady);
    const b = await tradeOnPage(owner, otherOut.coin, DIRECTION.BUY, "0.02");
    held.push([owner, otherOut.pool]);
    if (!checkTrade(b, owner, "the treasury owner buys 0.02 SOL of " + SPEC.none.sym, "exact")) return;
    const afterBuy = await tokenAmount(tKey);
    check(afterBuy !== null && afterBuy === before, "afterwards the treasury account of the tax coin still exists and holds the same " + sol(afterBuy || 0n) + " SOL");
    check(!!b.shown.wrapped && b.shown.wrapped.value === fmtUnits(before, 9, 6) && b.shown.wrapped.button === "Unwrap", "on that other coin's page the trade form shows the wallet's wrapped SOL (" + (b.shown.wrapped ? b.shown.wrapped.value : "nothing") + ") with an Unwrap button");

    // 2. someone else buys the tax coin: the tax reaches the treasury
    await open(trader, coinPath(taxC.pool), coinReady);
    const t = await tradeOnPage(trader, taxC, DIRECTION.BUY, "0.1");
    held.push([trader, taxC.pool]);
    if (!checkTrade(t, trader, "a buy of 0.1 SOL on the tax coin", "exact")) return;
    const reached = (t.treasury1 || 0n) - (t.treasury0 || 0n);
    check(t.treasury1 !== null && reached === t.ev.hookFee && pick(t.shown.kv, "Hook fee").value === fmtUnits(t.ev.hookFee, 9, 6) + " SOL", "the tax the form showed (" + pick(t.shown.kv, "Hook fee").value + ") reached the treasury: +" + sol(reached) + " SOL");

    // 3. the owner sells some of its own coin: the SOL arrives wrapped, and the form says so first
    await open(owner, coinPath(taxC.pool), coinReady);
    const own = await tradeOnPage(owner, taxC, DIRECTION.SELL, "5000000");
    if (!checkTrade(own, owner, "the owner sells 5,000,000 of its own coin", "exact")) return;
    const inTreasury = await tokenAmount(tKey);
    await treasuryLine(inTreasury);
    let card = await readCard(), form = await readTrade();
    check(!!act(card, false) && act(card, false).label === "In your treasury" && act(card, false).value === fmtUnits(inTreasury, 9, 6) + " SOL" && act(card, false).disabled === false, "the hook card follows without a reload: \"In your treasury " + (act(card, false) ? act(card, false).value : "?") + "\" (chain " + sol(inTreasury) + " SOL), and Take it is on");
    check(!!form.wrapped && form.wrapped.value === fmtUnits(inTreasury, 9, 6), "the trade form shows the same amount as the wallet's wrapped SOL: " + (form.wrapped ? form.wrapped.text : "nothing"));
    await scrollTo("#hookCard"); await sleep(250); await shot("-coin-tax-owner-1440");
    await view(375, 900, "dark"); await scrollTo("#hookCard .params"); await sleep(300); await shot("-coin-tax-owner-375");
    check(await fits(), "coin page as the tax owner: no horizontal scroll at 375 (" + (await overflow()) + ")");
    await view(W, HGT, "dark");

    // 4. Take it: the wrapped SOL becomes plain SOL and the account stays open
    const s0 = BigInt(await conn.getBalance(owner.publicKey));
    const take = await pressForToast("#hookCard .hook-act:not(.owed) button");
    const takeTx = take.sig ? await txOf(take.sig) : null, s1 = BigInt(await conn.getBalance(owner.publicKey)), left = await tokenAmount(tKey);
    check(/plain SOL in your wallet/.test(take.text) && take.prompts === 1 && left === 0n && !!takeTx && s1 - s0 === inTreasury - BigInt(takeTx.meta.fee), "Take it: one wallet prompt, the wallet's plain SOL rose by " + sol(s1 - s0) + " = the " + sol(inTreasury) + " that waited - the network fee, and the treasury account is still open with " + (left === null ? "NOTHING: IT IS CLOSED" : sol(left)) + " SOL in it");
    await treasuryLine(0n);
    card = await readCard(); form = await readTrade();
    check(!!act(card, false) && act(card, false).value === "0 SOL" && act(card, false).disabled === true && !form.wrapped, "afterwards the card says \"In your treasury 0 SOL\" with Take it off, and the trade form shows no wrapped SOL");

    // 5. change the tax: over the ceiling is refused by the page, a tax under it is one signature
    const buyIn = "#hookCard .hook-admin .row label:nth-child(1) input", sellIn = "#hookCard .hook-admin .row label:nth-child(2) input";
    const p0 = await prompts();
    await type(buyIn, "9");
    await click("#hookCard .hook-admin-acts button:nth-child(1)"); await sleep(700);
    card = await readCard();
    check((await prompts()) === p0 && card.admin.result === "Both taxes must stay at or under the ceiling of 8%.", "a tax above the ceiling is refused before any signature: \"" + card.admin.result + "\"");
    await type(buyIn, "1"); await type(sellIn, "2");
    const save = await pressForToast("#hookCard .hook-admin-acts button:nth-child(1)");
    let cfg = (await client.hookInfo(await client.pool(taxC.pool))).tax;
    check(/^Tax changed to 1% on buys and 2% on sells\. It applies from the next trade\./.test(save.text) && save.prompts === 1 && cfg.buyBps === 100 && cfg.sellBps === 200 && cfg.maxBps === 800 && cfg.owner.equals(owner.publicKey), "the owner changes the tax to 1% and 2% from the coin page: \"" + save.text + "\" On chain: buy " + fmtPct(cfg.buyBps) + ", sell " + fmtPct(cfg.sellBps) + ", ceiling still " + fmtPct(cfg.maxBps));
    const kvOk = (await kvIs("Buy tax", "1%")) && (await kvIs("Sell tax", "2%"));
    card = await readCard();
    check(kvOk && card.admin.inputs.join() === "1,2", "the card follows without a reload: buy tax " + card.kv["Buy tax"] + ", sell tax " + card.kv["Sell tax"] + ", and the owner's fields hold " + card.admin.inputs.join("% and ") + "%");
    taxC.info = await client.hookInfo(await client.pool(taxC.pool));
    await open(trader, coinPath(taxC.pool), coinReady);
    const t2 = await tradeOnPage(trader, taxC, DIRECTION.BUY, "0.05");
    if (checkTrade(t2, trader, "a buy of 0.05 SOL after the change", "exact")) check(t2.ev.hookFee === feeCeil(t2.amount - t2.ev.protocolFee, 100) && pick(t2.shown.kv, "Hook fee").value === fmtUnits(t2.ev.hookFee, 9, 6) + " SOL", "the new tax applies: the form showed a hook fee of " + pick(t2.shown.kv, "Hook fee").value + ", the chain took " + sol(t2.ev.hookFee) + " SOL = 1% of the buy after the protocol fee");

    // 6. hook fees that wait in the pool. The owner's wrapped SOL account is closed outside the site
    //    (a wallet app that unwraps does exactly this), then a buy has no treasury to pay.
    await sendNode([ix.closeAccount(tKey, owner.publicKey, owner.publicKey)], [owner]);
    check((await conn.getAccountInfo(tKey)) === null, "the owner's wrapped SOL account is closed outside the site, as a wallet app that unwraps would do");
    const t3 = await tradeOnPage(trader, taxC, DIRECTION.BUY, "0.05");
    if (!check(!t3.error, "a buy while the treasury account is missing still goes through" + (t3.error ? ". The page said: " + t3.error : ""))) return;
    const pOwed = await client.pool(taxC.pool);
    check(pOwed.hookFeesOwedQuote === t3.ev.hookFee && t3.ev.hookFee > 0n && (await conn.getAccountInfo(tKey)) === null, "chain: the tax of that buy, " + sol(t3.ev.hookFee) + " SOL, waits in the pool (hook fees owed " + sol(pOwed.hookFeesOwedQuote) + " SOL)");
    const owedShown = await until("!!document.querySelector('#hookCard .hook-act.owed')", 20000, 300);
    card = await readCard();
    const owedText = fmtUnits(pOwed.hookFeesOwedQuote, 9, 6) + " SOL of hook fees wait in the pool. Their treasury account was missing.";
    check(owedShown && !!act(card, true) && act(card, true).text.startsWith(owedText) && act(card, true).button === "Pay them out", "the hook card says so in a plain line, with the amount, to any visitor and without a reload: \"" + (act(card, true) ? act(card, true).text : "nothing") + "\"");
    await scrollTo("#hookCard"); await sleep(250); await shot("-coin-tax-owed-1440");
    const pay = await pressForToast("#hookCard .hook-act.owed button");
    const pPaid = await client.pool(taxC.pool), tPaid = await tokenAmount(tKey);
    check(pay.text.startsWith(fmtUnits(pOwed.hookFeesOwedQuote, 9, 6) + " SOL paid to the hook's treasury.") && pay.prompts === 1 && pPaid.hookFeesOwedQuote === 0n && tPaid === pOwed.hookFeesOwedQuote, "\"Pay them out\", pressed by a wallet that is not the owner: \"" + pay.text + "\" On chain the treasury account is open again and holds the " + sol(tPaid || 0n) + " SOL that waited, and nothing waits in the pool");
    const gone = await until("!document.querySelector('#hookCard .hook-act.owed')", 20000, 300);
    check(gone, "the line leaves the card without a reload once the fees are paid");

    // 7. renounce: one step that says it is forever, then one signature
    await open(owner, coinPath(taxC.pool), coinReady);
    const p1 = await prompts();
    await click("#hookCard .hook-admin-acts button:nth-child(2)"); await sleep(400);
    card = await readCard();
    check((await prompts()) === p1 && card.admin.confirm === "Renouncing is forever. The taxes stay at 1% on buys and 2% on sells. Nobody can change them again." && card.admin.buttons.includes("Renounce forever") && card.admin.buttons.includes("Keep control"), "Renounce asks first, with no signature yet: \"" + card.admin.confirm + "\" [" + card.admin.buttons.join(", ") + "]");
    await scrollTo("#hookCard .hook-admin"); await sleep(250); await shot("-coin-tax-renounce-1440");
    await click("#hookCard .hook-admin .confirm-acts button:nth-child(2)"); await sleep(400);
    card = await readCard();
    check(card.admin.confirm === "" && card.admin.buttons.join() === "Save the tax,Renounce" && (await prompts()) === p1, "\"Keep control\" closes the question and nothing was signed");
    await click("#hookCard .hook-admin-acts button:nth-child(2)"); await sleep(400);
    const ren = await pressForToast("#hookCard .hook-admin .confirm-acts button:nth-child(1)");
    cfg = (await client.hookInfo(await client.pool(taxC.pool))).tax;
    check(/^Renounced\. The taxes can never change again\./.test(ren.text) && ren.prompts === 1 && cfg.renounced && cfg.buyBps === 100 && cfg.sellBps === 200, "\"Renounce forever\": \"" + ren.text + "\" On chain the tax has no owner any more and stays at " + fmtPct(cfg.buyBps) + " and " + fmtPct(cfg.sellBps));
    const renShown = await kvIs("Owner", "renounced");
    card = await readCard();
    check(renShown && !card.admin && card.help.includes("The owner renounced. These taxes can never change.") && !!act(card, false), "the card follows without a reload: owner \"" + card.kv["Owner"] + "\", the owner's controls are gone, and the treasury line stays (the wallet still owns the treasury)");
    let refused = "";
    try { await sendNode([ix.taxSetTax(owner.publicKey, taxC.pool, 300, 300)], [owner]); refused = "IT WENT THROUGH"; } catch (e) { refused = "refused"; }
    check(refused === "refused", "chain: a change of the tax sent by the old owner afterwards is " + refused);

    // 8. liquidity by a wallet that keeps a wrapped SOL account
    await open(owner, "/pool.html?pool=" + taxC.pool.toBase58(), poolReady);
    let pool = await client.pool(taxC.pool);
    const sup = (await client.mint(pool.lpMint)).supply;
    await type("#addAmount", "0.01");
    const addMsg = await txt("#addMsg");
    check(addMsg === "Your wallet keeps a wrapped SOL account. The form wraps the most this deposit can cost. What it does not use stays there as wrapped SOL.", "pool page, add form, for a wallet that keeps a wrapped SOL account: \"" + addMsg + "\"");
    const lpN = mulDivFloor(10_000_000n, sup, pool.reserveQuote), quoteN = mulDivCeil(lpN, pool.reserveQuote, sup), maxQ = quoteN * 10100n / 10000n + 1n;
    const w0 = await tokenAmount(tKey);
    await clearToasts();
    await click("#addBtn");
    await until("/Added/.test(document.querySelector('#addResult').textContent) || !!document.querySelector('#addResult .bad')", 45000, 200);
    if (!check(/Added/.test(await txt("#addResult")), "the owner adds liquidity to its own tax pool through the pool page: " + (await txt("#addResult")))) return;
    await sleep(900);
    const w1 = await tokenAmount(tKey);
    check(w1 !== null && w1 - w0 === maxQ - quoteN, "after the deposit the treasury account still exists, and the change of the deposit stayed there as wrapped SOL: +" + sol((w1 || 0n) - (w0 || 0n)) + " SOL = the " + sol(maxQ) + " wrapped - the " + sol(quoteN) + " the pool took");
    await until("(() => { for (const dt of document.querySelectorAll('#position dt')) if (dt.textContent.trim() === 'Pool share') return dt.nextElementSibling.textContent.trim() !== '0%'; return false; })()", 12000, 300);
    await clearToasts();
    await click("#removeQuick button:nth-child(3)");
    await sleep(300);
    const remMsg = await txt("#removeMsg");
    check(remMsg === "The SOL arrives as wrapped SOL in your wrapped SOL account. Unwrap, under Your position, turns it into plain SOL.", "pool page, remove form, before the click: \"" + remMsg + "\"");
    pool = await client.pool(taxC.pool);
    const sup1 = (await client.mint(pool.lpMint)).supply, quoteOut = mulDivFloor(lpN, pool.reserveQuote, sup1);
    const sr0 = BigInt(await conn.getBalance(owner.publicKey));
    await click("#removeBtn");
    await until("/Removed/.test(document.querySelector('#removeResult').textContent) || !!document.querySelector('#removeResult .bad')", 45000, 200);
    const remText = await txt("#removeResult");
    if (!check(/Removed/.test(remText) && remText.includes("The SOL arrived as wrapped SOL in your wrapped SOL account."), "the owner takes its liquidity out again: " + remText)) return;
    await sleep(900);
    const remTx = await txOf(sigIn(await ev("(document.querySelector('#removeResult a.link') || {}).href || ''")));
    const w2 = await tokenAmount(tKey), sr1 = BigInt(await conn.getBalance(owner.publicKey));
    check(w2 !== null && w2 - w1 === quoteOut && sr1 - sr0 === -BigInt(remTx.meta.fee) && (await client.tokenBalance(owner.publicKey, pool.lpMint)) === 0n, "chain: the " + sol(quoteOut) + " SOL of the withdrawal arrived in the wrapped SOL account, the wallet's plain SOL fell by the network fee only, and it holds no LP");
    const wrapShown = await until("(() => { const b = document.querySelector('#wrapped .hook-act-v b'); return !!b && b.textContent.trim() === " + q(fmtUnits(w2, 9, 6)) + "; })()", 15000, 300);
    check(wrapShown, "the pool page shows the wallet's wrapped SOL under Your position: " + (await txt("#wrapped")));
    await scrollTo("#removeCard"); await sleep(250); await shot("-pool-wrapped-1440");
    const su0 = BigInt(await conn.getBalance(owner.publicKey));
    const un = await pressForToast("#wrapped button");
    const unTx = un.sig ? await txOf(un.sig) : null, w3 = await tokenAmount(tKey), su1 = BigInt(await conn.getBalance(owner.publicKey));
    check(un.prompts === 1 && w3 === 0n && !!unTx && su1 - su0 === w2 - BigInt(unTx.meta.fee), "Unwrap on the pool page: \"" + un.text + "\" The wallet's plain SOL rose by " + sol(su1 - su0) + " = the " + sol(w2) + " wrapped - the network fee, and the account stays open, empty");
    R.treasury = { treasury: tKey.toBase58(), takenFromCoinPage: sol(inTreasury), owedAndPaidOut: sol(pOwed.hookFeesOwedQuote), taxNow: fmtPct(cfg.buyBps) + " / " + fmtPct(cfg.sellBps) + ", renounced " + cfg.renounced, unwrappedOnPoolPage: sol(w2) };
  });

  // ---- summary ------------------------------------------------------------------------------------------
  console.log("\nSUMMARY");
  for (const key of Object.keys(SPEC)) {
    const out = R[key];
    if (!out) continue;
    console.log("  " + SPEC[key].label + (out.pool ? "  pool " + out.pool.toBase58() + (out.coin ? "  mint " + out.coin.mint.toBase58() : "") + (out.bySdk ? "  (launched through the SDK)" : "") : "  (not launched)"));
    for (const [k, v] of Object.entries(out.sum || {})) console.log("        " + (k + ":").padEnd(14) + " " + v);
  }
  if (R.liquidity) console.log("  Liquidity  " + JSON.stringify(R.liquidity));
  if (R.third) console.log("  Third-party hook coin  " + JSON.stringify(R.third));
  if (R.custom) console.log("  Launch on the third-party hook  " + JSON.stringify(R.custom));
  if (R.treasury) console.log("  Tax owner  " + JSON.stringify(R.treasury));
  const seen = new Map();
  for (const e of pageErrors) seen.set(e, (seen.get(e) || 0) + 1);
  console.log("\npage errors (" + pageErrors.length + "): " + (pageErrors.length ? "\n" + [...seen].map(([e, n]) => "  " + (n > 1 ? n + "x " : "") + e).join("\n") : "none"));
  console.log("\nscreenshots (" + shots.length + "): " + shots.join(", "));
  ws.close();
} catch (e) {
  check(false, "the run stopped: " + e.message);
  if (pageErrors.length) console.error(pageErrors.join("\n"));
  try { await shot("-failure"); } catch (_) {}
} finally {
  await cleanup();
  console.log("\n" + total + " checks, " + (total - failed) + " ok, " + failed + " failed" + (notRun.length ? ", " + notRun.length + " part" + (notRun.length === 1 ? "" : "s") + " NOT RUN" : ""));
  if (failures.length) console.log("failed:\n" + failures.map((f) => "  - " + f).join("\n"));
  if (notRun.length) console.log("not run:\n" + notRun.map((f) => "  - " + f).join("\n"));
  if (failed) process.exitCode = 1;
}

/// Close the browser and give the pools their coins back. Runs once: at the end, or on Ctrl+C.
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  console.log("\n" + (await edge.close()));
  console.log("\nselling back what the throwaway wallets hold");
  const pools = new Map();
  for (const [kp, poolKey] of held) { const n = await sellBack(kp, poolKey); pools.set(poolKey.toBase58(), (pools.get(poolKey.toBase58()) || 0n) + n); }
  for (const [addr, n] of pools) { const p = await client.pool(new PublicKey(addr)); console.log("  pool " + addr + ": sold back " + coins(n) + " coins, now " + coins(p.reserveBase) + " coins and " + sol(p.reserveQuote) + " SOL"); }
  let left = 0n;
  for (const [kp, poolKey] of held) { const p = await client.pool(poolKey); if (p) left += await client.tokenBalance(kp.publicKey, p.baseMint, p.baseTokenProgram); }
  console.log("  coins still held by the throwaway wallets: " + coins(left));
}
