// Review tool: the Launch rules choice of the site, end to end, in headless Edge with real
// mouse and keyboard input, signed by throwaway wallets made here (localnet only, airdropped,
// never written to disk).
//   node web/review/flow-rules.mjs <site origin> <out prefix> [parts]
//   node web/review/flow-rules.mjs http://localhost:8787 web/review/h-rules
// V. the launch form: the bounds it shows are the SDK's policy, a number over one gets a sentence
//    under its own field, and Launch asks for no signature while a problem stands.
// M. a hand-made mix with every rule, launched through the form: the review against what the
//    chain then charges, the config on chain against the form, the coin page. Then a second
//    wallet trades: a buy above the limit is stopped by the page, a buy inside the sniper
//    window gives the quote or more, the fee falls on the page without a reload, adding
//    liquidity is refused during the window and works after it. Two wallets stake, payments
//    start at 0.1% of the supply, rewards arrive and are claimed as SOL, unstaking is refused
//    with the time it opens. The burn button goes through record, wait, record again and buy.
//    The creator claims. At the end of the run the short lock opens and the creator unlocks.
// P1 to P4. the four presets, each launched through the form: the same checks on the launch,
//    then a buy and a sell by the second wallet with the quotes against the chain.
// E. the explore page tags each of the five coins with the rules it has, and the Hooks page
//    and the docs page name the template and its bounds.
// S. a slow wallet on a launch with a lock, in two more tabs that wait in the background for
//    about nine minutes: one where the second signature is refused and step 2 is retried
//    later, one where the wallet prompt stays open. Both times the page says so and builds
//    the launch again with a new date instead of sending one that must fail.
// "parts": all (the default), or some of V,M,P1,P2,P3,P4,E,S.
// One line per check, "  ok    ..." or "  FAIL  ...", with the numbers seen. Screenshots go to
// <out prefix>-<name>.png. The test validator at 127.0.0.1:8899 and the site are only read and
// traded on: nothing is stopped, restarted or deployed. The browser is started and closed by
// edge.mjs. Every throwaway wallet sells back what it holds when the run ends, also after a
// failure. Coins that are staked or locked stay where they are.
// The launch form's own metadata upload is not used (it writes files under web/uploads/): the
// form's "Host the metadata yourself" field gets a JSON URL the site already serves.
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  HookpoolClient, DIRECTION, HOOK_KIND, NATIVE_MINT, PROGRAMS, pda, ix, initialLp, isqrt, feeCeil, mulDivCeil, mulDivFloor, spotPrice,
  decodeTokenAmount, decodeHookManifest, eventsFromTransaction, RULES_POLICY, RULES_CEILINGS, RULES_SLOT_MS, RULES_ELIGIBLE_DIVISOR, RULES_LOCK_MARGIN_SECONDS,
  UNSTAKE_DELAY_SLOTS, BURN_INTERVAL_SLOTS, BURN_OUTCOME, rulesPda, rulesFirstBuyQuote, rulesSniperFee, rulesBuyLimit, rulesSplit, rulesSideRates, rulesRatesTotal,
  rulesBurnCapBps, burnToleranceBps, liquidityOpenSlot,
} from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";

const [origin, prefix, partsArg = "all"] = process.argv.slice(2);
if (!origin || !prefix) { console.error("usage: node web/review/flow-rules.mjs <site origin> <out prefix> [parts]"); process.exit(1); }
const PARTS = ["V", "M", "P1", "P2", "P3", "P4", "E", "S"];
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);
const say = (label, value) => console.log("        " + (label + ":").padEnd(34) + " " + (typeof value === "string" ? value : JSON.stringify(value, (k, v) => (typeof v === "bigint" ? String(v) : v))));
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
/// Send something the chain must refuse. Returns the reason, or "" when it went through.
async function refusedBy(ixs, signers) {
  try { await sendNode(ixs, signers); return ""; }
  catch (e) { const logs = (e.logs || []).join(" | "); const m = /Error Code: (\w+)/.exec(logs + " " + e.message) || /custom program error: (0x[0-9a-f]+)/.exec(logs + " " + e.message); return m ? m[1] : String(e.message).slice(0, 120); }
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
const fmtShare = (part, whole) => (BigInt(whole) <= 0n ? "0%" : (Number(BigInt(part) * 1_000_000n / BigInt(whole)) / 10000).toLocaleString("en-US", { maximumFractionDigits: 4 }) + "%");
const fmtInt = (n) => Number(n).toLocaleString("en-US");
function fmtPrice(p) {
  if (!isFinite(p) || p <= 0) return "0";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return Number(p.toPrecision(3)).toLocaleString("en-US", { maximumFractionDigits: 20, useGrouping: false });
}
function fmtSpan(seconds) {
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return s + " s";
  if (s < 3600) { const r = s % 60; return Math.floor(s / 60) + " min" + (r ? " " + r + " s" : ""); }
  if (s < 172800) { const m = Math.floor((s % 3600) / 60); return Math.floor(s / 3600) + " h" + (m ? " " + m + " min" : ""); }
  const d = Math.round(s / 8640) / 10;
  return d.toLocaleString("en-US") + (d === 1 ? " day" : " days");
}
const slotsToSeconds = (slots) => Number(slots) * RULES_SLOT_MS / 1000;
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
const ELIGIBLE = fmtPct(10_000 / Number(RULES_ELIGIBLE_DIVISOR));
const WAIT_TEXT = BURN_INTERVAL_SLOTS + " slots later, about " + fmtSpan(slotsToSeconds(BURN_INTERVAL_SLOTS));

// ---- chain reads --------------------------------------------------------------------------------
const tokenAmount = async (address) => { const a = await conn.getAccountInfo(address); return a && a.data.length >= 72 ? decodeTokenAmount(new Uint8Array(a.data)) : null; };
const coinsOf = (wallet, mint) => client.tokenBalance(wallet, mint);
const wsolOf = (wallet) => pda.ata(wallet, NATIVE_MINT);
const slotNow = async () => BigInt(await conn.getSlot("confirmed"));
const chainNow = async () => (await client.chainTime()).unixTime;
async function txOf(sig) {
  for (let i = 0; i < 40; i++) { const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); if (t) return t; await sleep(250); }
  throw new Error("the transaction " + sig + " could not be read back");
}
function balanceChange(tx, key) {
  const all = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).keySegments().flat();
  const i = all.findIndex((k) => k.equals(key));
  return i < 0 ? null : BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
}
const sigIn = (href) => { const m = /\/tx\/([1-9A-HJ-NP-Za-km-z]{60,90})/.exec(String(href || "")); return m ? m[1] : ""; };
const waitSlot = async (slot) => { for (let i = 0; i < 1200 && (await slotNow()) < slot; i++) await sleep(400); };
const plat = await client.platform();
if (!plat) { console.error("no platform account on " + RPC); process.exit(1); }
const ATA_RENT = BigInt(await conn.getMinimumBalanceForRentExemption(165));
const STAKE_RENT = BigInt(await conn.getMinimumBalanceForRentExemption(113));

// ---- wallets --------------------------------------------------------------------------------------
const dev = { mix: Keypair.generate(), creator: Keypair.generate(), hold: Keypair.generate(), burn: Keypair.generate(), sells: Keypair.generate(), retry: Keypair.generate(), held: Keypair.generate() };
const trader = Keypair.generate(), stakerA = Keypair.generate(), stakerB = Keypair.generate(), lp = Keypair.generate(), visitor = Keypair.generate();
await Promise.all(Object.values(dev).map((k) => fund(k, 3)));
await Promise.all([fund(trader, 5), fund(stakerA, 2), fund(stakerB, 2), fund(lp, 2), fund(visitor, 1)]);
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
// the tabs of part S wait in the background for minutes: their timers and their renderer must not be put to sleep
const edge = await startEdge({ name: "rules", width: W, height: HGT + 200, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
let cleaned = false;
process.on("SIGINT", async () => { console.log("\ninterrupted: closing the browser and selling back"); try { await cleanup(); } finally { process.exit(130); } });
let id = 0; const pending = new Map(); const events = []; const pageErrors = [];
/// The tab the calls below go to: { ws, walletScriptId, where }.
let tab = null;
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); tab.ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
/// Run a function inside the page. It must not use anything from this file but its arguments.
const pg = (fn, ...args) => ev("(" + fn.toString() + ")(" + args.map((a) => JSON.stringify(a)).join(", ") + ")");
const shots = [];
/// Make the tab the calls go to the one the browser shows. A tab that sits behind another stops
/// drawing after a few minutes, and a screenshot of it then never comes back.
const front = () => call("Page.bringToFront").catch(() => {});
const shot = async (name) => { await front(); const s = await call("Page.captureScreenshot", { format: "png" }); writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64")); shots.push(prefix + name + ".png"); console.log("        wrote " + prefix + name + ".png"); };
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
  await sleep(300);
}
const standin = (kp) => JSON.stringify({ secret: Array.from(kp.secretKey), address: kp.publicKey.toBase58() });
/// The stand-in wallet. `fixed`: the tab keeps this one wallet (the tabs of part S). Otherwise
/// a later wallet is handed over through localStorage. window.__rejectPrompt = n makes the n-th
/// prompt of the page answer like a closed wallet. window.__holdPrompt = n keeps the n-th
/// prompt open until window.__release() is called.
const walletScript = (kp, fixed) => `
  localStorage.setItem("Programmable.wallet", "phantom");
  (() => {
    let who = ${standin(kp)};
    if (!${fixed ? "true" : "false"}) { try { const s = localStorage.getItem("__standin"); if (s) who = JSON.parse(s); } catch (_) {} }
    const SECRET = who.secret;
    const ADDRESS = who.address;
    window.__who = ADDRESS;
    window.__signPrompts = 0;
    const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(SECRET)); };
    const publicKey = { toBase58: () => ADDRESS };
    const prompt = async () => {
      const n = ++window.__signPrompts;
      if (window.__rejectPrompt === n) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      if (window.__holdPrompt === n) await new Promise((r) => { window.__release = r; });
    };
    const w = { isPhantom: true, publicKey, on() {}, disconnect: async () => {},
      connect: async () => ({ publicKey }),
      signTransaction: async (tx) => { await prompt(); tx.sign([await key()]); return tx; },
      signAllTransactions: async (txs) => { await prompt(); const k = await key(); for (const t of txs) t.sign([k]); return txs; } };
    window.phantom = { solana: w };
  })();`;
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
  if (!tab.walletScriptId) tab.walletScriptId = (await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript(kp, tab.fixed) })).identifier;
  else if (!tab.fixed) await ev("localStorage.setItem(\"__standin\", " + JSON.stringify(standin(kp)) + "); true");
  for (let attempt = 0; attempt < 2; attempt++) {
    events.length = 0; tab.where = path;
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
  events.length = 0; tab.where = "/" + href;
  await clearToasts();
  await click(selector);
  await waitLoad();
  if (!(await settle(ready, href))) throw new Error("the page did not get ready after the link " + href);
  return href;
}
function onMessage(t) {
  return (m) => {
    const d = JSON.parse(m.data);
    const where = String(t.where || "").split("?")[0];
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === "Runtime.exceptionThrown") pageErrors.push(where + "  EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") pageErrors.push(where + "  console.error " + d.params.args.map((a) => a.value || a.description).join(" "));
    else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") pageErrors.push(where + "  " + d.params.entry.source + " error " + d.params.entry.text + (d.params.entry.url ? " " + d.params.entry.url.slice(0, 120) : ""));
    else if (d.method && t === tab) events.push(d.method);
  };
}
/// Attach to a page target of this run's browser and get it ready for the calls above.
async function attach(target, fixed) {
  const t = { ws: new WebSocket(target.webSocketDebuggerUrl), walletScriptId: null, where: "about:blank", fixed: !!fixed };
  await new Promise((r, j) => { t.ws.onopen = r; t.ws.onerror = j; });
  t.ws.onmessage = onMessage(t);
  const before = tab; tab = t;
  await call("Page.enable"); await call("Runtime.enable"); await call("Log.enable");
  // headless Edge now and then reports the page as hidden, and a hidden page pauses its polls
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await view(W, HGT, "dark");
  tab = before || t;
  return t;
}
/// One more tab in the same browser, for a page that has to wait while the run goes on.
const newTab = async () => attach(await (await fetch("http://127.0.0.1:" + edge.port + "/json/new?about:blank", { method: "PUT" })).json(), true);
const coinReady = "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on') && !!document.querySelector('#hookCard #ruRates') && !document.querySelector('#rulesCard').hidden && !document.querySelector('#layout').hidden && /lock account/.test((document.querySelector('#liqCard p') || {}).textContent || '')";
const coinPath = (pool) => "/coin.html?pool=" + pool.toBase58();
const poolReady = "!!document.querySelector('#walletBtn.on') && !document.querySelector('#layout').hidden && /LP balance/.test(document.querySelector('#position').textContent) && /LP supply/.test(document.querySelector('#locked').textContent)";
const launchReady = "!!document.querySelector('#walletBtn.on') && !!document.querySelector('#launchBtn') && !!document.querySelector('#costs dd')";
const overflow = () => ev("document.documentElement.scrollWidth + ' of ' + window.innerWidth");
const fits = async () => { const [a, b] = (await overflow()).split(" of ").map(Number); return a <= b; };
async function view(width, height, scheme) {
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setTouchEmulationEnabled", { enabled: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await sleep(500);
}
const scrollTo = (selector) => ev("(() => { document.querySelector(" + q(selector) + ").scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); return true; })()");

// ---- what the page shows ------------------------------------------------------------------------------
const txt = (selector) => pg((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; }, selector);
/// A <dl>, or anything that holds one: { term: value }.
const kvOf = (selector) => pg((s) => { const root = document.querySelector(s); if (!root) return null; const o = {}; for (const dt of root.querySelectorAll("dt")) { const dd = dt.nextElementSibling; o[dt.textContent.replace(/\s+/g, " ").trim()] = dd ? dd.textContent.replace(/\s+/g, " ").trim() : ""; } return o; }, selector);
/// The modules of Module Mode: each module's switch, fields, what it adds up to and its problems.
const readRulesForm = () => pg(() => {
  const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const o = { rules: {}, presets: {}, sides: t(document.querySelector("#ruleSides")), max: {}, help: {} };
  for (const r of document.querySelectorAll("#ruleList .module")) {
    const k = r.dataset.rule;
    o.rules[k] = { on: r.querySelector("[role=switch]").getAttribute("aria-checked") === "true", shown: !r.querySelector("[data-fields]").hidden, values: [...r.querySelectorAll("input")].map((i) => i.value),
      sum: t(r.querySelector("[data-sum]")), errors: [...r.querySelectorAll(".error-text span")].map(t) };
    o.help[k] = t(r.querySelector(".help"));
    o.max[k] = [...r.querySelectorAll("[data-max]")].map(t);
  }
  for (const b of document.querySelectorAll("#rulePresets button")) o.presets[b.dataset.preset] = { name: t(b), on: b.getAttribute("aria-pressed") === "true" };
  o.limitShare = t(document.querySelector("#rLimitShare"));
  return o;
});
/// The review beside the modules.
const readReview = () => pg(() => {
  const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const side = (sel) => [...document.querySelectorAll(sel + " dt")].map((dt) => { const to = dt.querySelector(".to"); return { name: t(dt.firstChild), to: t(to), value: t(dt.nextElementSibling), sum: dt.classList.contains("sum") }; });
  const kv = {}; for (const dt of document.querySelectorAll("#revFirstKv dt")) kv[t(dt)] = t(dt.nextElementSibling);
  const shown = (id) => { const e = document.getElementById(id); return !!e && !e.hidden; };
  return { shown: shown("reviewCard"), buy: side("#revBuy"), sell: side("#revSell"), notes: [...document.querySelectorAll("#revNote p")].map(t), first: shown("revFirst") ? kv : null, firstNote: t(document.querySelector("#revFirstNote")),
    lock: shown("revLock") ? t(document.querySelector("#revLockText")) : "", total: t(document.querySelector("#total")), problems: t(document.querySelector("#revProblems")) };
});
/// The hook card of a rules coin: the shares table, the two windows and every sentence.
const readHook = () => pg(() => {
  const c = document.querySelector("#hookCard"); if (!c) return null;
  const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const rates = {}; for (const tr of c.querySelectorAll("#ruRates tbody tr")) { const td = [...tr.children].map(t); rates[td[0]] = [td[1], td[2]]; }
  const windows = {}; for (const dt of c.querySelectorAll("#ruWindows dt")) windows[t(dt)] = t(dt.nextElementSibling);
  return { badge: t(c.querySelector(".kind .badge")), kind: t(c.querySelector(":scope > .small.muted")), sentences: [...c.querySelectorAll(".sentences li")].map(t), status: t(c.querySelector(".status")),
    head: [...c.querySelectorAll("#ruRates thead th")].map(t), rates, never: t(c.querySelector("#ruNever")), windows, help: [...c.querySelectorAll(".params > .help")].map(t), all: t(c) };
});
/// The rules card of the coin page: one entry per block, by its id.
const readRules = () => pg(() => {
  const c = document.querySelector("#rulesCard"); if (!c || c.hidden) return null;
  const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const o = { title: t(c.querySelector("h3")), blocks: {} };
  for (const b of c.querySelectorAll(".rule-block")) {
    const kv = {}; for (const dt of b.querySelectorAll("dt")) kv[t(dt)] = t(dt.nextElementSibling);
    const buttons = {}; for (const x of b.querySelectorAll("button[id]")) buttons[x.id] = { text: t(x), disabled: x.disabled };
    o.blocks[b.id] = { title: t(b.querySelector("h4")), kv, help: [...b.querySelectorAll("p.help")].map(t), buttons, balance: t(b.querySelector(".balance")), result: t(b.querySelector(".tx-result")), all: t(b) };
  }
  return o;
});
const readHead = () => pg(() => {
  const h = document.querySelector("#head"); const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  return { title: t(h.querySelector("h1")), badge: t(h.querySelector(".head-tags .badge")), tags: [...h.querySelectorAll(".head-tags .tag")].map(t), price: t(h.querySelector("#headPrice")), cap: t(h.querySelector("#headMcap")) };
});
const readTrade = () => pg(() => {
  const c = document.querySelector("#tradeCard"); const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const kv = {}; for (const dt of c.querySelectorAll("dl.kv dt")) kv[t(dt)] = t(dt.nextElementSibling);
  const ex = document.querySelector("#exactOut"); const btn = c.querySelector("button.btn-block");
  return { amount: document.querySelector("#amount").value, out: t(c.querySelector(".out .v")), unit: t(c.querySelector(".out .v").nextElementSibling), kv, exact: t(ex), balance: t(c.querySelector(".balance span")), note: t(c.querySelector(".trade-note")),
    noteBad: !!c.querySelector(".trade-note .bad"), result: t(c.querySelector(".tx-result")), bad: !!c.querySelector(".tx-result .bad"), button: t(btn), disabled: btn.disabled };
});
const readToasts = () => pg(() => [...document.querySelectorAll("#toasts .toast")].map((t) => { const a = t.querySelector("a"); return { kind: t.className.replace("toast", "").trim(), text: t.textContent.replace(/\s+/g, " ").trim(), href: a ? a.href : "" }; }));
/// Press a button that answers with a toast, and wait for the toast. Returns the toasts and the prompts it took.
async function pressForToast(selector, ms = 60000) {
  await clearToasts();
  const p0 = await prompts();
  await click(selector);
  await until("document.querySelectorAll('#toasts .toast').length > 0", ms, 200);
  await sleep(400);
  const toasts = await readToasts();
  return { toasts, text: toasts.map((t) => t.text).join(" / "), ok: toasts.some((t) => t.kind === "ok"), sig: sigIn((toasts.find((t) => t.href) || {}).href), prompts: (await prompts()) - p0 };
}
/// Wait until an element of the page reads `text`.
const reads = (selector, text, ms = 20000) => until("((document.querySelector(" + q(selector) + ") || {}).textContent || '').replace(/\\s+/g, ' ').trim() === " + q(text), ms, 250);
/// The page's own date format, in the time zone of this machine, which the browser shares.
const fmtDate = (unix) => new Date(Number(unix) * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/// One trade through the trade form of the coin page that is open, as the wallet that is connected.
/// `amountText`: what to type, or "max" to press the Max control. Returns what the page showed
/// before the click and what the chain says afterwards, with the coin's rules state on both sides.
async function tradeOnPage(kp, C, dir, amountText) {
  const buy = dir === DIRECTION.BUY;
  const r = { buy, error: "" };
  await clearToasts();
  await click("#tradeCard .seg [data-dir=" + (buy ? "buy" : "sell") + "]");
  await sleep(200);
  r.held = await coinsOf(kp.publicKey, C.mint);
  if (amountText === "max") {
    const wantText = "Balance " + fmtUnits(r.held, 6, 4) + " " + C.symbol;
    r.balanceShown = await until("(document.querySelector('#tradeCard .balance span') || {}).textContent === " + q(wantText), 25000);
    await click("#tradeCard .balance button");
    await sleep(350);
  } else await type("#amount", amountText);
  await until("(document.querySelector('#tradeCard .out .v') || {}).textContent !== '0' && !!(document.querySelector('#exactOut') || {}).textContent", 15000);
  await sleep(700);
  r.shown = await readTrade();
  r.amount = parseUnits(r.shown.amount, buy ? 9 : 6) || 0n;
  r.pool0 = await client.pool(C.pool);
  r.state0 = await client.rulesState(C.pool);
  r.slot0 = await slotNow();
  try { r.expected = await client.quoteLocal(r.pool0, plat, dir, r.amount, C.info, r.slot0); } catch (_) { r.expected = null; }
  r.sol0 = BigInt(await conn.getBalance(kp.publicKey)); r.coins0 = r.held;
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
  r.pool1 = await client.pool(C.pool);
  r.state1 = await client.rulesState(C.pool);
  r.clean = r.pool1.swapCount - r.pool0.swapCount === 1n;
  r.priceWant = fmtPrice(spotPrice(r.pool1, 6, 9)) + " SOL";
  r.priceOk = await until("(document.querySelector('#headPrice') || {}).textContent === " + q(r.priceWant), 15000);
  r.price1 = await txt("#headPrice");
  r.rowOk = await until("(() => { const a = document.querySelector('#trades tbody tr td:last-child a'); return !!a && a.href.includes(" + q(r.sig) + "); })()", 25000);
  r.row = await pg(() => { const tr = document.querySelector("#trades tbody tr"); return tr ? [...tr.children].map((td) => td.textContent.trim()) : null; });
  return r;
}
/// The checks every trade gets. `mode`: "exact" the wallet gets the quote to the last unit,
/// "window" the quote or more (a sniper fee that falls every slot).
function checkTrade(r, kp, C, label, mode) {
  if (!check(!r.error, label + ": the trade confirms" + (r.error ? ". The page said: " + r.error : ""))) return false;
  check(r.prompts === 1, label + ": one wallet prompt (" + r.prompts + ")");
  const side = rulesSideRates(C.cfg, r.buy ? DIRECTION.BUY : DIRECTION.SELL), bps = rulesRatesTotal(side);
  const rulesRow = pick(r.shown.kv, "Launch rules"), poolRow = pick(r.shown.kv, "Pool fee");
  if (r.buy) {
    const got = r.coins1 - r.coins0;
    check(!!r.ev && got === r.ev.amountOut, label + ": the wallet received what the pool paid out, " + coins(got) + " coins");
    if (mode === "exact") check(!!r.expected && got === r.expected.amountOut && fmtUnits(got, 6, 2) === r.shown.out && r.shown.unit === C.symbol, label + ": quote " + r.shown.out + " " + r.shown.unit + " = received " + coins(got) + " (the SDK quote for the same pool state is " + (r.expected ? coins(r.expected.amountOut) : "none") + ", equal to the last unit)");
    else check(got >= (rawOf(r.shown.out, 6) || 0n) && r.shown.unit === C.symbol + " or more" && /falls every slot\. A buy that lands a moment later pays less and gives this amount or more\./.test(r.shown.note), label + ": inside the sniper window the form says \"" + r.shown.out + " " + r.shown.unit + "\" and the wallet received " + coins(got) + ". The note: \"" + r.shown.note + "\"");
    const paid = r.sol0 - r.sol1, wantPaid = r.amount + r.fee + (r.hadCoinsAccount ? 0n : ATA_RENT);
    check(paid === wantPaid, label + ": the wallet paid " + sol(paid) + " SOL = " + sol(r.amount) + " typed + " + sol(r.fee) + " network fee" + (r.hadCoinsAccount ? "" : " + " + sol(ATA_RENT) + " rent of its new token account"));
  } else {
    const got = r.ev ? r.ev.amountOut : 0n;
    check(!!r.ev && r.sol1 - r.sol0 === got - r.fee, label + ": the wallet's SOL rose by " + sol(r.sol1 - r.sol0) + " = " + sol(got) + " paid out - " + sol(r.fee) + " network fee");
    check(!!r.expected && got === r.expected.amountOut && fmtUnits(got, 9, 6) === r.shown.out, label + ": quote " + r.shown.out + " SOL = received " + sol(got) + " SOL (the SDK quote for the same pool state is " + (r.expected ? sol(r.expected.amountOut) : "none") + ", equal to the last lamport)");
    check(r.coins0 - r.coins1 === r.amount, label + ": " + coins(r.amount) + " coins left the wallet");
  }
  // the fee rows of the form against the trade's own event
  const base = r.buy ? r.amount - r.ev.protocolFee : r.ev.amountOut + r.ev.hookFee;
  check(rulesRow.label === "Launch rules " + fmtPct(bps) && rulesRow.value === (r.ev.hookFee > 0n ? fmtUnits(r.ev.hookFee, 9, 6) + " SOL" : "0") && r.ev.hookFee === feeCeil(base, bps),
    label + ": the row \"" + rulesRow.label + "\" showed " + rulesRow.value + ", the chain took " + sol(r.ev.hookFee) + " SOL = " + fmtPct(bps) + " of " + sol(base) + " SOL, rounded up");
  if (mode === "exact") check(poolRow.label === "Pool fee " + fmtPct(C.fee) && r.ev.feeBpsApplied === C.fee, label + ": the form showed \"" + poolRow.label + "\", the chain charged " + fmtPct(r.ev.feeBpsApplied));
  else {
    const shownBps = Math.round(parseFloat(poolRow.label.replace("Pool fee ", "")) * 100);
    check(/\(sniper fee\)$/.test(poolRow.label) && r.ev.feeBpsApplied <= shownBps && r.ev.feeBpsApplied > C.fee, label + ": the form showed \"" + poolRow.label + "\", the chain charged " + fmtPct(r.ev.feeBpsApplied) + " a few slots later: the same or less");
  }
  checkSplit(r, C, label);
  const quoteAmt = r.buy ? r.amount : (r.ev ? r.ev.amountOut : 0n);
  check(r.rowOk && !!r.row && r.row[1] === (r.buy ? "buy" : "sell") && r.row[2] === fmtUnits(quoteAmt, 9, 4) && r.row[5] === short(kp.publicKey.toBase58()), label + ": the recent-trades table shows it first: " + (r.row ? r.row.slice(0, 6).join(" | ") : "no row"));
  check(r.priceOk && r.price1 !== r.price0, label + ": the price in the head moved from " + r.price0 + " to " + r.price1 + " (chain: " + r.priceWant + ")");
  return true;
}
/// Where the hook fee of one trade went, to the lamport: the creator, the stakers or the burn
/// pot. The state before and the state after are both settled to their moment by the SDK.
function checkSplit(r, C, label) {
  if (!r.ev || !r.state0 || !r.state1) return;
  if (!r.clean) { console.log("        note: another transaction touched this pool between the two reads, so the split of this fee is not checked"); return; }
  const parts = rulesSplit(r.ev.hookFee, rulesSideRates(C.cfg, r.buy ? DIRECTION.BUY : DIRECTION.SELL));
  const a = r.state0.settled, b = r.state1.settled, paid = r.state1.stakersEligible;
  const toPot = parts.burn + (paid ? 0n : parts.holders);
  const acc = paid && b.totalStaked > 0n ? (parts.holders * 10n ** 12n + a.rewardRem) / b.totalStaked : 0n;
  check(b.creatorOwed - a.creatorOwed === parts.creator && b.burnPot - a.burnPot === toPot && b.accPerShare - a.accPerShare === acc,
    label + ": the " + sol(r.ev.hookFee) + " SOL went where the rules say: " + sol(parts.creator) + " to the creator, " + (paid ? sol(parts.holders) + " to the stakers (" + (b.accPerShare - a.accPerShare) + " per staked unit, scaled by 10^12)" : sol(parts.holders) + " of rewards to the burn pot, too little is staked") + ", " + sol(parts.burn) + " to the burn pot. Chain: creator +" + sol(b.creatorOwed - a.creatorOwed) + ", pot +" + sol(b.burnPot - a.burnPot));
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

// ---- the five coins ---------------------------------------------------------------------------------
// `rules`: what is typed into each rule's fields, in their order. `want`: the config the chain
// must hold afterwards. A preset is one click, and the form must then hold `rules` by itself.
const SPEC = {
  mix: { n: "M", key: "mix", preset: null, label: "a hand-made mix", name: "Rules Mix " + run, sym: "RMX" + run, fee: 30,
    rules: { sniper: ["40", "2"], creator: ["0.25", "0.75"], holders: ["1", "1.5"], burn: ["0.5", "0.75"], limit: ["0.2", "2.5"], lock: ["0.001"] },
    want: { sniperSlots: 300n, sniperStartFeeBps: 4000, buy: { creatorBps: 25, holdersBps: 100, burnBps: 50 }, sell: { creatorBps: 75, holdersBps: 150, burnBps: 75 }, maxBuyQuote: 200_000_000n, limitSlots: 375n, creatorLockSeconds: 86n } },
  creator: { n: "P1", key: "creator", preset: "Creator fee only", label: "the preset \"Creator fee only\"", name: "Rules Fee " + run, sym: "RFE" + run, fee: 100,
    rules: { creator: ["1", "1"] },
    want: { sniperSlots: 0n, sniperStartFeeBps: 0, buy: { creatorBps: 100, holdersBps: 0, burnBps: 0 }, sell: { creatorBps: 100, holdersBps: 0, burnBps: 0 }, maxBuyQuote: 0n, limitSlots: 0n, creatorLockSeconds: 0n } },
  hold: { n: "P2", key: "hold", preset: "Built to hold", label: "the preset \"Built to hold\"", name: "Rules Hold " + run, sym: "RHD" + run, fee: 100,
    rules: { sniper: ["30", "2"], creator: ["0.5", "0.5"], holders: ["1", "1"], limit: ["0.1", "10"], lock: ["90"] },
    want: { sniperSlots: 300n, sniperStartFeeBps: 3000, buy: { creatorBps: 50, holdersBps: 100, burnBps: 0 }, sell: { creatorBps: 50, holdersBps: 100, burnBps: 0 }, maxBuyQuote: SEED / 20n, limitSlots: 1500n, creatorLockSeconds: 7_776_000n } },
  burn: { n: "P3", key: "burn", preset: "Rewards and burn", label: "the preset \"Rewards and burn\"", name: "Rules Burn " + run, sym: "RBN" + run, fee: 100,
    rules: { creator: ["0.5", "0.5"], holders: ["0.5", "0.5"], burn: ["0.5", "0.5"] },
    want: { sniperSlots: 0n, sniperStartFeeBps: 0, buy: { creatorBps: 50, holdersBps: 50, burnBps: 50 }, sell: { creatorBps: 50, holdersBps: 50, burnBps: 50 }, maxBuyQuote: 0n, limitSlots: 0n, creatorLockSeconds: 0n } },
  sells: { n: "P4", key: "sells", preset: "Sells pay stakers", label: "the preset \"Sells pay stakers\"", name: "Rules Sells " + run, sym: "RSL" + run, fee: 300,
    rules: { creator: ["0.5", "0.5"], holders: ["0", "2"], lock: ["30"] },
    want: { sniperSlots: 0n, sniperStartFeeBps: 0, buy: { creatorBps: 50, holdersBps: 0, burnBps: 0 }, sell: { creatorBps: 50, holdersBps: 200, burnBps: 0 }, maxBuyQuote: 0n, limitSlots: 0n, creatorLockSeconds: 2_592_000n } },
};
const RULE_KEYS = ["sniper", "creator", "holders", "burn", "limit", "lock"];
const R = {}; // what each coin produced, for the later parts and the summary

/// The rows the review must show for one side of a coin with these rules.
function wantSide(rates, fee) {
  const rows = [["Protocol fee", "to the platform", fmtPct(plat.protocolFeeBps)], ["Pool fee", "stays in the pool", fmtPct(fee)]];
  if (rates.creatorBps) rows.push(["Creator fee", "to your wallet", fmtPct(rates.creatorBps)]);
  if (rates.holdersBps) rows.push(["Rewards", "to wallets that stake the coin", fmtPct(rates.holdersBps)]);
  if (rates.burnBps) rows.push(["Burn", "buys the coin and burns it", fmtPct(rates.burnBps)]);
  rows.push(["In total", "", fmtPct(plat.protocolFeeBps + fee + rulesRatesTotal(rates))]);
  return rows.map((x) => x.join(" | ")).join("; ");
}
const sideText = (rows) => rows.map((x) => [x.name, x.to, x.value].join(" | ")).join("; ");
const rateSum = (b, s) => (b === s ? fmtPct(b) + " of every trade" : fmtPct(b) + " buys, " + fmtPct(s) + " sells");
/// What each rule's head line must add up to, from the config the coin should get.
function wantSums(w) {
  return {
    sniper: w.sniperSlots > 0n ? fmtPct(w.sniperStartFeeBps) + " for " + fmtSpan(slotsToSeconds(w.sniperSlots)) : "",
    creator: w.buy.creatorBps + w.sell.creatorBps ? rateSum(w.buy.creatorBps, w.sell.creatorBps) : "",
    holders: w.buy.holdersBps + w.sell.holdersBps ? rateSum(w.buy.holdersBps, w.sell.holdersBps) : "",
    burn: w.buy.burnBps + w.sell.burnBps ? rateSum(w.buy.burnBps, w.sell.burnBps) : "",
    limit: w.maxBuyQuote > 0n ? fmtUnits(w.maxBuyQuote, 9, 4) + " SOL for " + fmtSpan(slotsToSeconds(w.limitSlots)) : "",
    lock: w.creatorLockSeconds > 0n ? fmtSpan(Number(w.creatorLockSeconds)) : "",
  };
}
/// Open Module Mode as `kp` and fill everything but the modules.
async function openForm(kp, s) {
  await open(kp, "/launch-modules.html", launchReady);
  await type("#name", s.name);
  await type("#symbol", s.sym);
  await type("#seed", SEED_TEXT);
  await type("#devBuy", FIRST_TEXT);
  await click("label.choice:has(input[name=fee][value='" + s.fee + "']) .title");
  if (!(await ev("document.querySelector('details.more').open"))) await click("details.more > summary");
  await type("#metaUrl", origin + "/package.json?coin=" + s.sym.toLowerCase());
  await sleep(300);
}
const INPUTS = { sniper: ["rSniperFee", "rSniperMin"], creator: ["rCreatorBuy", "rCreatorSell"], holders: ["rHoldersBuy", "rHoldersSell"], burn: ["rBurnBuy", "rBurnSell"], limit: ["rLimitSol", "rLimitMin"], lock: ["rLockDays"] };
/// Switch a rule on or off with a real click on its switch, and type its numbers.
async function setRule(key, values) {
  const on = await ev("document.querySelector('[data-switch=" + key + "]').getAttribute('aria-checked') === 'true'");
  if (on !== !!values) { await click("[data-switch=" + key + "]"); await sleep(200); }
  if (values) for (let i = 0; i < values.length; i++) await type("#" + INPUTS[key][i], values[i]);
}

/// Launch one coin through the form and compare the form, the review and the chain.
async function launchOnPage(key) {
  const s = SPEC[key], kp = dev[key], w = s.want, out = R[key] = { key, sum: {} };
  out.uri = origin + "/package.json?coin=" + s.sym.toLowerCase();
  await openForm(kp, s);
  check((await ev("document.querySelectorAll('#ruleList .module').length")) === 6 && (await ev("!document.querySelector('#reviewCard').hidden")),
    "Module Mode shows its six modules, and the review stands beside them");
  if (s.preset) {
    const name = await txt("#rulePresets [data-preset=" + key + "]");
    check(name === s.preset, "the preset button reads \"" + name + "\"");
    await click("#rulePresets [data-preset=" + key + "]");
    await sleep(400);
  } else for (const k of RULE_KEYS) await setRule(k, s.rules[k] || null);
  await sleep(500);
  const form = await readRulesForm();
  const sums = wantSums(w);
  const holds = RULE_KEYS.every((k) => form.rules[k].on === !!s.rules[k] && form.rules[k].shown === !!s.rules[k] && (!s.rules[k] || s.rules[k].every((v, i) => Number(form.rules[k].values[i]) === Number(v))));
  say("the form holds", RULE_KEYS.map((k) => k + " " + (form.rules[k].on ? form.rules[k].values.join("/") : "off")).join(", "));
  check(holds, s.preset ? "one click on the preset switched on exactly its rules and filled their numbers: " + Object.entries(s.rules).map(([k, v]) => k + " " + v.join("/")).join(", ")
    : "every rule is switched on with a real click and holds the numbers typed");
  check(RULE_KEYS.every((k) => form.rules[k].sum === sums[k]) && RULE_KEYS.every((k) => form.rules[k].errors.length === 0) && !form.sides, "each rule says what it adds up to and none has a problem: " + RULE_KEYS.map((k) => form.rules[k].sum).join(" | "));
  check(Object.entries(form.presets).every(([k, p]) => p.on === (k === key)), s.preset ? "the preset's button is marked while the form holds its numbers" : "no preset is marked for numbers typed by hand");
  if (s.rules.limit) check(form.limitShare === (Number((w.maxBuyQuote * 1000n) / (SEED + w.maxBuyQuote)) / 10) + "% of supply", "next to the buy limit the form says what one buy at the limit takes at the launch price: " + form.limitShare);

  // ---- the review, before the signature
  const rev = await readReview(), args = { ...w };
  const q1 = rulesFirstBuyQuote(args, { totalSupply: SUPPLY, quoteAmount: SEED, lpFeeBps: s.fee, devBuyQuote: FIRST }, plat);
  const hookBuy = rulesRatesTotal(w.buy);
  say("review, a buy pays", sideText(rev.buy));
  say("review, a sell pays", sideText(rev.sell));
  say("review, notes", rev.notes.join(" "));
  say("review, your first buy", rev.first || "nothing");
  if (rev.lock) say("review, creator lock", rev.lock);
  check(sideText(rev.buy) === wantSide(w.buy, s.fee) && sideText(rev.sell) === wantSide(w.sell, s.fee), "review: what a buy and a sell pay, row by row with where each part goes, and the totals " + rev.buy[rev.buy.length - 1].value + " and " + rev.sell[rev.sell.length - 1].value);
  const wantNotes = ["Each fee is taken from what the one before it left, so a trade pays a little less than the sum."];
  if (w.sniperSlots > 0n) wantNotes.push("For the first " + fmtSpan(slotsToSeconds(w.sniperSlots)) + " a buy pays a higher pool fee. It starts at " + fmtPct(w.sniperStartFeeBps) + " and falls to " + fmtPct(s.fee) + ". A buy in the first slot pays " + fmtPct(plat.protocolFeeBps + w.sniperStartFeeBps + hookBuy) + " in total.");
  if (w.buy.holdersBps + w.sell.holdersBps > 0) wantNotes.push("While less than " + ELIGIBLE + " of the supply is staked, the rewards buy and burn the coin instead.");
  check(rev.notes.join(" ") === wantNotes.join(" "), "review: the notes under the two columns are the ones this coin needs (" + wantNotes.length + ")");
  const f = rev.first || {};
  const poolLabel = "Pool fee " + fmtPct(q1.feeBpsApplied) + (q1.feeBpsApplied !== s.fee ? ", the sniper fee" : "");
  check(!!rev.first && f["You pay"] === "0.05 SOL" && f["Protocol fee " + fmtPct(plat.protocolFeeBps)] === fmtUnits(q1.protocolFee, 9, 9) + " SOL" && f["Creator fee, rewards and burn " + fmtPct(hookBuy)] === fmtUnits(q1.hookFee, 9, 9) + " SOL"
    && f[poolLabel] === fmtUnits(q1.lpFee, 9, 9) + " SOL" && f["You receive"] === fmtUnits(q1.amountOut, 6, 6) + " " + s.sym,
    "review: your first buy is the SDK's own quote of it, to the unit: protocol fee " + sol(q1.protocolFee) + ", the three shares " + sol(q1.hookFee) + ", " + poolLabel + " " + sol(q1.lpFee) + " SOL, you receive " + coins(q1.amountOut));
  check(rev.firstNote === (w.sniperSlots > 0n ? "Your first buy is the first trade of the pool. It pays the sniper fee of the first slot in full." : ""), "review: " + (w.sniperSlots > 0n ? "it says the first buy pays the sniper fee of the first slot in full" : "no note about a sniper fee, the coin has none"));
  const readAt = Math.floor(Date.now() / 1000);
  if (w.creatorLockSeconds > 0n) {
    const dates = [0, -60, 60].map((d) => fmtDate(readAt + d + RULES_LOCK_MARGIN_SECONDS + Number(w.creatorLockSeconds)));
    check(dates.some((d) => rev.lock === "The " + fmtUnits(q1.amountOut, 6, 2) + " " + s.sym + " of your first buy go into a lock account in the launch transaction. They stay there until about " + d + ", your local time. The launch sets the exact minute."), "review: the lock names the coins of the first buy and the date, " + fmtSpan(Number(w.creatorLockSeconds)) + " and the launch's ten minutes from now");
  } else check(rev.lock === "", "review: no lock block, the coin has no creator lock");
  const costs = await kvOf("#costs"), totalText = await txt("#total"), rentNote = await txt("#rentNote");
  const rentShown = rawOf(costs["Rent and network fees"], 9) || 0n, totalShown = rawOf(totalText, 9) || 0n;
  say("form says you spend", Object.entries(costs).map(([k, v]) => k + " " + v).join("; ") + "; Total " + totalText + ". " + rentNote);
  check(rev.total === totalText && totalShown === SEED + FIRST + plat.launchFeeLamports + rentShown && !rev.problems, "review: \"This launch costs " + rev.total + "\" is the Total of the summary, the sum of seed, first buy, the platform's launch fee on chain and the rent");
  check(rentNote === "The rent pays for this coin's treasury, its burn account and its vault for staked coins" + (w.creatorLockSeconds > 0n ? ", and for the lock account of your first buy." : "."), "under the summary: \"" + rentNote + "\"");
  // screenshots: the form with the rules open, and the review
  await scrollTo("#ruleList"); await sleep(250); await shot("-launch-" + key + "-1440");
  await scrollTo("#reviewCard"); await sleep(250); await shot("-review-" + key + "-1440");
  await view(375, 900, "dark");
  await scrollTo("#ruleList"); await sleep(250); await shot("-launch-" + key + "-375");
  if (key === "mix" || key === "hold") { await scrollTo("[data-rule=holders]"); await sleep(250); await shot("-launch-" + key + "-375-rules"); }
  await click("#studioTabs [data-view=coin]"); await sleep(200);
  await scrollTo("#reviewCard"); await sleep(250); await shot("-review-" + key + "-375");
  await click("#studioTabs [data-view=modules]"); await sleep(200);
  check(await fits(), "launch form with the rules open (" + key + "): no horizontal scroll at 375 (" + (await overflow()) + ")");
  await view(W, HGT, "dark");

  // ---- launch
  const before = BigInt(await conn.getBalance(kp.publicKey));
  const p0 = await prompts();
  await click("#launchBtn");
  await until("!!document.querySelector('#result a.btn') || !!document.querySelector('#result .bad')", 90000, 300);
  const ok = await ev("!!document.querySelector('#result a.btn')");
  if (!check(ok, "both launch transactions confirm" + (ok ? "" : ". The page said: " + (await txt("#result")) + " | " + (await txt("#steps"))))) throw new Error("the launch did not go through");
  if (w.creatorLockSeconds > 0n) await until("!!document.querySelector('#lockedLine')", 15000, 200);
  await sleep(700);
  check((await prompts()) - p0 === 2, "wallet prompts for the launch: " + ((await prompts()) - p0) + " (the page promises two signatures)");
  const links = await pg(() => [...document.querySelectorAll("#result a")].map((a) => ({ text: a.textContent.trim(), href: a.href })));
  const open1 = links.find((l) => /^Open /.test(l.text));
  out.pool = new PublicKey(new URL(open1.href).searchParams.get("pool"));
  out.sig2 = sigIn((links.find((l) => l.text === "tx 2") || {}).href);
  const spent = before - BigInt(await conn.getBalance(kp.publicKey));
  say("wallet really spent", sol(spent) + " SOL: rent and network fees " + sol(spent - SEED - FIRST - plat.launchFeeLamports) + " SOL, the page said about " + sol(rentShown));
  check(spent <= totalShown && totalShown - spent < 100_000n, "the Total is true: the page showed " + totalText + ", the wallet's SOL fell by " + sol(spent) + " (the Total is that, rounded up to 0.0001 SOL: " + sol(totalShown - spent) + " above)");
  out.sum.costShown = totalText; out.sum.spent = sol(spent) + " SOL";
  held.push([kp, out.pool]);

  // ---- the chain
  const p = await client.pool(out.pool);
  if (!check(!!p, "chain: the pool account exists at " + out.pool.toBase58())) throw new Error("no pool on chain");
  const [mint, md, lpMint, lockLp, launch, info, st, lock] = await Promise.all([client.mint(p.baseMint), client.metadata(p.baseMint), client.mint(p.lpMint), tokenAmount(p.lpLock), client.launchForMint(p.baseMint), client.hookInfo(p), client.rulesState(out.pool), client.rulesLock(out.pool)]);
  const c = st.config;
  out.coin = { pool: out.pool, mint: p.baseMint, symbol: s.sym, info, cfg: c, fee: s.fee };
  const man = await conn.getAccountInfo(pda.manifest(PROGRAMS.hook_rules)), flags = man ? decodeHookManifest(new Uint8Array(man.data)).flags : -1;
  check(p.hasHook && p.hookProgram.equals(PROGRAMS.hook_rules) && p.hookKind === HOOK_KIND.PLATFORM && p.hookFlags === flags && p.creator.equals(kp.publicKey) && p.lpFeeBps === s.fee && p.hookQuoteTreasury.equals(rulesPda.treasury(out.pool, NATIVE_MINT)),
    "chain: the pool is wired to hook_rules " + short(p.hookProgram.toBase58()) + ", kind platform template, flags " + p.hookFlags + " as in its manifest, pool fee " + fmtPct(p.lpFeeBps) + ", its hook treasury is the rules' own");
  check(c.sniperSlots === w.sniperSlots && c.sniperStartFeeBps === w.sniperStartFeeBps && ["creatorBps", "holdersBps", "burnBps"].every((k) => c.buy[k] === w.buy[k] && c.sell[k] === w.sell[k]) && c.maxBuyQuote === w.maxBuyQuote && c.limitSlots === w.limitSlots && c.creatorLockSeconds === w.creatorLockSeconds,
    "chain: the config holds exactly the form's numbers: sniper " + c.sniperStartFeeBps + " bps for " + c.sniperSlots + " slots, buy " + [c.buy.creatorBps, c.buy.holdersBps, c.buy.burnBps].join("/") + ", sell " + [c.sell.creatorBps, c.sell.holdersBps, c.sell.burnBps].join("/") + " bps, limit " + c.maxBuyQuote + " lamports for " + c.limitSlots + " slots, lock " + c.creatorLockSeconds + " s");
  check(c.creator.equals(kp.publicKey) && c.startSlot === p.createdSlot && c.minEligible === SUPPLY / RULES_ELIGIBLE_DIVISOR && c.started, "chain: the config names the dev as creator, started at the pool's slot " + c.startSlot + ", and stakers are paid from " + coins(c.minEligible) + " coins staked (" + ELIGIBLE + " of the supply)");
  check(!!md && md.name === s.name && md.symbol === s.sym && md.uri === out.uri && !!mint && mint.supply === SUPPLY && mint.mintAuthority === null && mint.freezeAuthority === null, "chain: name, symbol and metadata URL are the ones typed, fixed supply " + coins(mint.supply) + ", no mint authority, no freeze authority");
  const all = isqrt(SUPPLY * SEED);
  check(!!lpMint && lpMint.supply === all && lockLp === all && !!launch && launch.lpLocked === initialLp(SUPPLY, SEED) && launch.devBuyQuote === FIRST && launch.launchFeePaid === plat.launchFeeLamports, "chain: all the launch liquidity is locked in the pool's lock account, and the launch record names the first buy and the fee paid");
  const tx2 = await txOf(out.sig2);
  const first = eventsFromTransaction(tx2, OUR).find((e) => e.kind === "Swapped" && e.pool.equals(out.pool));
  check(!!first && first.amountIn === FIRST && first.protocolFee === q1.protocolFee && first.hookFee === q1.hookFee && first.lpFee === q1.lpFee && first.feeBpsApplied === q1.feeBpsApplied && first.amountOut === q1.amountOut,
    "chain: the first buy charged exactly what the review showed: protocol fee " + sol(first.protocolFee) + ", the three shares " + sol(first.hookFee) + ", pool fee " + fmtPct(first.feeBpsApplied) + " = " + sol(first.lpFee) + " SOL, and paid out " + coins(first.amountOut) + " coins");
  check(rawOf(f["You receive"], 6) === first.amountOut && rawOf(f[poolLabel], 9) === first.lpFee && rawOf(f["Creator fee, rewards and burn " + fmtPct(hookBuy)], 9) === first.hookFee, "so the review's own figures, read back from the page, equal the chain's to the unit");
  // where the first buy's three shares went: nothing is staked at launch, so rewards go to the pot
  const parts = rulesSplit(first.hookFee, w.buy);
  check(st.creatorClaimable === parts.creator && st.burnPot === parts.burn + parts.holders && !st.stakersEligible, "chain: of the first buy's shares, " + sol(parts.creator) + " SOL wait for the creator and " + sol(parts.burn + parts.holders) + " SOL sit in the burn pot (nothing is staked yet, so the rewards of " + sol(parts.holders) + " went there)");
  const devCoins = await coinsOf(kp.publicKey, p.baseMint);
  if (w.creatorLockSeconds > 0n) {
    check(!!lock.record && lock.vaultBalance === first.amountOut && lock.record.amount === first.amountOut && devCoins === 0n && lock.locked, "chain: the whole first buy, " + coins(lock.vaultBalance) + " coins, sits in the lock account and the dev's wallet holds none");
    check(lock.unlockAt >= c.startTime + c.creatorLockSeconds && lock.unlockAt - BigInt(readAt) - BigInt(RULES_LOCK_MARGIN_SECONDS) - c.creatorLockSeconds < 180n && lock.unlockAt - BigInt(readAt) - BigInt(RULES_LOCK_MARGIN_SECONDS) - c.creatorLockSeconds > -30n,
      "chain: the lock ends at " + fmtDate(lock.unlockAt) + " (Unix " + lock.unlockAt + "), " + (lock.unlockAt - c.startTime - c.creatorLockSeconds) + " s more than the declared " + c.creatorLockSeconds + " s after the pool's start, and within three minutes of the date the review gave");
    const line = await txt("#lockedLine");
    check(line === fmtUnits(lock.vaultBalance, 6, 6) + " " + s.sym + " of your first buy are locked until " + fmtDate(lock.unlockAt) + ", your local time.", "after the launch the page states the lock from the chain: \"" + line + "\"");
    out.unlockAt = lock.unlockAt; out.locked = lock.vaultBalance;
  } else check(!lock.record && lock.vaultBalance === 0n && devCoins === first.amountOut, "chain: no lock account exists, and the dev's wallet holds the " + coins(devCoins) + " coins of its first buy");
  out.first = first; out.startSlot = c.startSlot;
}
/// The tags the head and the explore page must give a coin right now.
async function wantTags(out) {
  const [st, lock] = await Promise.all([client.rulesState(out.pool), client.rulesLock(out.pool)]);
  const c = st.config, t = [];
  if (c.buy.creatorBps || c.sell.creatorBps) t.push("creator fee");
  if (c.buy.holdersBps || c.sell.holdersBps) t.push("rewards");
  if (c.buy.burnBps || c.sell.burnBps) t.push("burn");
  if (rulesSniperFee(st.slot, c.startSlot, c.sniperSlots, c.sniperStartFeeBps, out.coin.fee) !== null) t.push("sniper fee");
  if (rulesBuyLimit(c, st.slot)) t.push("buy limit");
  if (lock.vaultBalance > 0n && st.unixTime < lock.unlockAt) t.push("locked");
  return t;
}
/// The coin page of a new coin, as its dev sees it right after the launch: head, hook card, rules card.
async function pageChecks(key) {
  const s = SPEC[key], kp = dev[key], out = R[key], w = s.want;
  await follow("#result a.btn", coinReady);
  check((await ev("location.pathname + location.search")) === coinPath(out.pool), "the link opens the coin page of the new pool");
  const head = await readHead(), hook = await readHook(), rules = await readRules();
  const tags = await wantTags(out);
  say("head", head.title + " | " + head.badge + " | tags " + head.tags.join(", ") + " | " + head.price);
  say("hook card", hook.all);
  check(head.title === s.name + s.sym + " / SOL" && head.badge === "Launch rules" && head.tags.join() === tags.join(), "coin page head: badge \"" + head.badge + "\" and one tag per rule the coin has right now: [" + head.tags.join(", ") + "]");
  check(hook.badge === "Launch rules" && hook.status === "Platform template, upgradeable by the platform's team." && hook.sentences.length === 4 && hook.sentences[3] === "Runs when liquidity is added and could refuse it. It never runs when liquidity is removed.",
    "hook card: \"" + hook.badge + "\", " + hook.kind + ", and the four things its flags allow, the last one: \"" + hook.sentences[3] + "\"");
  const rate = (name, b, sl) => (hook.rates[name] || []).join() === [fmtPct(b), fmtPct(sl)].join();
  const absent = (name, b, sl) => (b + sl > 0 ? rate(name, b, sl) : !(name in hook.rates));
  check(hook.head.join() === "A trade pays,Buy,Sell" && absent("Creator fee", w.buy.creatorBps, w.sell.creatorBps) && absent("Rewards for stakers", w.buy.holdersBps, w.sell.holdersBps) && absent("Burn", w.buy.burnBps, w.sell.burnBps)
    && rate("Pool fee", s.fee, s.fee) && rate("Protocol fee", plat.protocolFeeBps, plat.protocolFeeBps) && rate("In total", plat.protocolFeeBps + s.fee + rulesRatesTotal(w.buy), plat.protocolFeeBps + s.fee + rulesRatesTotal(w.sell)),
    "hook card: the shares of a buy and of a sell, from the config on chain: " + Object.entries(hook.rates).map(([k, v]) => k + " " + v.join(" / ")).join(", "));
  check(hook.never === "These rules can never change. The program has no instruction that changes one.", "hook card: \"" + hook.never + "\"");
  // the blocks of the rules card: one per thing the coin has
  const b = rules ? rules.blocks : {};
  const wantBlocks = [];
  if (w.buy.holdersBps + w.sell.holdersBps > 0) wantBlocks.push("ruStaking");
  if (w.buy.burnBps + w.sell.burnBps + w.buy.holdersBps + w.sell.holdersBps > 0) wantBlocks.push("ruBurnBlock");
  wantBlocks.push("ruCreator");
  if (w.creatorLockSeconds > 0n) wantBlocks.push("ruLock");
  const panels = await ev("[...document.querySelectorAll('#rulesCard > .panel > h2')].map((h) => h.textContent.trim()).join()");
  const wantPanels = [wantBlocks.includes("ruStaking") ? "Rewards" : "", wantBlocks.includes("ruBurnBlock") ? "Burn" : "", "Creator"].filter(Boolean).join();
  check(!!rules && Object.keys(b).join() === wantBlocks.join() && panels === wantPanels, "the coin page has a panel per thing the coin has (" + panels + ") with the blocks it needs and no other: " + Object.values(b).map((x) => x.title).join(", "));
  const st = await client.rulesState(out.pool);
  const cr = b.ruCreator || { kv: {}, buttons: {}, help: [] };
  check(cr.kv["Creator"] === short(kp.publicKey.toBase58(), 5) + ", your wallet" && cr.kv["Waits for the creator"] === fmtUnits(st.creatorClaimable, 9, 9) + " SOL" && cr.kv["Claimed so far"] === "0 SOL" && !!cr.buttons.ruClaimCreator && !cr.buttons.ruClaimCreator.disabled,
    "rules card, creator fee: the dev is named as the creator, " + cr.kv["Waits for the creator"] + " wait (chain " + sol(st.creatorClaimable) + "), and the dev has a Claim button");
  if (w.creatorLockSeconds > 0n) {
    const lk = b.ruLock || { kv: {}, buttons: {}, help: [] };
    check(lk.kv["In the lock account"] === fmtUnits(out.locked, 6, 2) + " " + s.sym + ", " + fmtShare(out.locked, SUPPLY) + " of the supply" && lk.kv["Locked until"] === fmtDate(out.unlockAt) && /^in /.test(lk.kv["Opens"] || "") && !!lk.buttons.ruUnlock && lk.buttons.ruUnlock.disabled && lk.buttons.ruUnlock.text === "Unlock"
      && lk.help[0] === "The creator cannot take these coins out before that date. The lock holds the coins in this account only. It says nothing about coins the creator holds elsewhere.",
      "rules card, creator lock, read from the lock account: " + lk.kv["In the lock account"] + ", locked until " + lk.kv["Locked until"] + ", opens " + lk.kv["Opens"] + ". The creator's Unlock button is there and off. \"" + lk.help[0] + "\"");
  }
  return { head, hook, rules };
}


/// Screenshots of the coin page that is open: the whole window at 1440, the hook card, the trade form and the rules card at 375.
async function coinShots(tag, small = true) {
  await clearToasts();
  await ev("window.scrollTo(0, 0); true"); await sleep(300);
  await shot("-coin-" + tag + "-1440");
  if (!small) return;
  await view(375, 900, "dark");
  await scrollTo("#hookCard"); await sleep(300); await shot("-coin-" + tag + "-375-hook");
  await scrollTo("#rulesCard"); await sleep(300); await shot("-coin-" + tag + "-375-rules");
  check(await fits(), "coin page (" + tag + "): no horizontal scroll at 375 (" + (await overflow()) + ")");
  await view(W, HGT, "dark");
}
/// One block of the rules card, read again until `test` holds or the time is up.
async function blockWhen(id, test, ms = 25000) {
  let b = null;
  for (let t = 0; t < ms; t += 400) { const r = await readRules(); b = r && r.blocks[id]; if (b && test(b)) return b; await sleep(400); }
  return b || { kv: {}, help: [], buttons: {}, all: "" };
}

// ---- V. the form's bounds and its sentences ---------------------------------------------------------
async function formPart() {
  await open(visitor, "/launch-modules.html", launchReady);
  await type("#seed", SEED_TEXT);
  await sleep(300);
  let form = await readRulesForm();
  const P = RULES_POLICY, mins = (slots) => Number(slots) * RULES_SLOT_MS / 60000;
  const wantMax = { sniper: ["max " + P.sniperStartFeeBps / 100 + "%", "max " + mins(P.sniperSlots) + " min"], creator: ["max " + P.creatorBps / 100 + "%", "max " + P.creatorBps / 100 + "%"], holders: ["max " + P.holdersBps / 100 + "%", "max " + P.holdersBps / 100 + "%"],
    burn: ["max " + P.burnBps / 100 + "%", "max " + P.burnBps / 100 + "%"], limit: ["max " + mins(P.limitSlots) + " min"], lock: ["max " + P.creatorLockSeconds / 86400 + " days"] };
  check(RULE_KEYS.every((k) => form.max[k].join() === wantMax[k].join()), "the bounds next to the fields are the SDK's RULES_POLICY: " + RULE_KEYS.map((k) => k + " " + form.max[k].join(", ")).join("; "));
  check(RULE_KEYS.every((k) => !form.rules[k].on && !form.rules[k].shown && form.rules[k].sum === ""), "every module starts switched off, with its fields closed and nothing next to its name");
  check(Object.values(form.presets).map((p) => p.name).join(" | ") === "Creator fee only | Built to hold | Rewards and burn | Sells pay stakers" && Object.values(form.presets).every((p) => !p.on), "four presets with plain names: " + Object.values(form.presets).map((p) => p.name).join(", "));
  const h = form.help;
  check(/Nobody can add liquidity while it runs\. Your own first buy pays the start fee\. Sells are never touched\.$/.test(h.sniper) && /^A share of every trade is set aside for your wallet, in SOL\./.test(h.creator)
    && h.holders === "A share of every trade is paid in SOL to wallets that stake the coin on its page. A wallet that only holds the coin earns nothing. While less than " + ELIGIBLE + " of the supply is staked, this share buys and burns the coin instead."
    && /Anyone can run a buy of the coin with the pot, a slice at a time\. What it buys is burned\. A run waits while the price climbs\.$/.test(h.burn)
    && /The limit is per trade, so a wallet can split a large buy into several\. It binds your own first buy too\. Sells are never limited\.$/.test(h.limit)
    && /cannot leave before the date\. On a normal coin it waits in a lock account\. On a strict coin it stays in your own wallet\. The lock holds those coins only, and it needs a first buy\.$/.test(h.lock),
    "one sentence block per rule says what it does and what it does not: stakers not holders, " + ELIGIBLE + " before payments, a limit per trade, a lock on the first buy only, the sniper fee on the launcher's own buy, no liquidity while it runs");
  check(/Nobody can change a module after the launch\.$/.test(await txt(".page-top p")), "the page says that nobody can change a module after the launch");
  // each problem, in words, under its own fields. Typed with the keyboard, read back from the page.
  const problem = async (key, what, wantText, where = key) => {
    form = await readRulesForm();
    const got = where === "sides" ? form.sides : form.rules[key].errors.join(" ");
    check(got.includes(wantText), what + ": \"" + got + "\"");
  };
  await type("#devBuy", FIRST_TEXT);
  await setRule("creator", ["2.5", "1"]);
  await problem("creator", "a creator fee above the policy", "The creator fee on buys is 2.5%. The most is " + fmtPct(P.creatorBps) + ".");
  const rev = await readReview();
  check(rev.problems === "Change what is marked under Modules before you launch.", "the review says so too: \"" + rev.problems + "\"");
  await type("#name", "Not Launched"); await type("#symbol", "NOPE");
  const p0 = await prompts();
  await click("#launchBtn"); await sleep(900);
  const refused = await txt("#result");
  check((await prompts()) === p0 && refused === "Check the modules. The creator fee on buys is 2.5%. The most is " + fmtPct(P.creatorBps) + ".", "Launch asks for no signature while a problem stands, and repeats it: \"" + refused + "\"");
  await setRule("creator", ["2", "0"]);
  await setRule("holders", ["2", "2.5"]);
  await problem("holders", "rewards above the policy", "The rewards on sells are 2.5%. The most is " + fmtPct(P.holdersBps) + ".");
  await problem("holders", "the three shares of one side together", "Creator fee, rewards and burn together take 4% on buys. The most is " + fmtPct(P.sideBps) + " a side.", "sides");
  await setRule("holders", null);
  await setRule("burn", ["1.5", "0"]);
  await problem("burn", "a burn above the policy", "The burn on buys is 1.5%. The most is " + fmtPct(P.burnBps) + ".");
  await setRule("burn", ["0", "0"]);
  await problem("burn", "a rule switched on with nothing in it", "Type a share for buys, for sells, or for both.");
  await setRule("burn", null);
  await setRule("sniper", ["60", "6"]);
  await problem("sniper", "a sniper fee above the policy", "The sniper fee starts at 60%. The most is " + fmtPct(P.sniperStartFeeBps) + ".");
  await problem("sniper", "a sniper fee that runs too long", "The sniper fee would run for 6 min. The most is " + mins(P.sniperSlots) + " min.");
  await setRule("sniper", ["1", "2"]);
  await problem("sniper", "a start fee that is not above the pool fee", "The start fee must be above the pool fee of 1%.");
  await setRule("sniper", ["30", ""]);
  await problem("sniper", "a sniper fee with no length", "A sniper fee needs a start fee and a length.");
  await setRule("sniper", null);
  await setRule("limit", ["0.01", "40"]);
  await problem("limit", "a first buy above the coin's own buy limit", "Your first buy of 0.05 SOL is above this limit, so the launch would fail.");
  await problem("limit", "a buy limit that runs too long", "The buy limit would run for 40 min. The most is " + mins(P.limitSlots) + " min.");
  await setRule("limit", null);
  await setRule("lock", ["120"]);
  await problem("lock", "a lock above the policy", "The lock would last 120 days. The most is " + P.creatorLockSeconds / 86400 + " days.");
  await setRule("lock", ["30"]);
  await type("#devBuy", "0");
  await problem("lock", "a lock without a first buy", "A lock holds your first buy, and your first buy is 0. Type one under Launch settings, or switch the lock off.");
  await scrollTo("[data-rule=lock]"); await sleep(200); await shot("-launch-problems-1440");
  await setRule("lock", null);
  form = await readRulesForm();
  check(RULE_KEYS.every((k) => form.rules[k].errors.length === 0) && !form.sides && (await readReview()).problems === "", "with the numbers put right no problem is left, and the review's warning is gone");
}

// ---- M. the hand-made mix -------------------------------------------------------------------------------
async function mixPart() {
  const s = SPEC.mix, w = s.want, kp = dev.mix;
  await launchOnPage("mix");
  const out = R.mix, C = out.coin, sum = out.sum;
  const { hook } = await pageChecks("mix");
  const end = { sniper: out.startSlot + w.sniperSlots, limit: out.startSlot + w.limitSlots };
  // the two windows, live on the hook card
  let slot = await slotNow();
  const feeNow = rulesSniperFee(slot, out.startSlot, w.sniperSlots, w.sniperStartFeeBps, s.fee);
  const shownBps = Math.round(parseFloat(hook.windows["Pool fee of a buy right now"]) * 100);
  check(feeNow !== null && Math.abs(shownBps - feeNow) <= 400 && /^in about /.test(hook.windows["Sniper fee ends"] || "") && hook.windows["Most one buy can spend"] === "0.2 SOL" && /^in about /.test(hook.windows["Buy limit ends"] || ""),
    "hook card: the sniper fee right now " + hook.windows["Pool fee of a buy right now"] + " (chain at slot " + slot + ": " + (feeNow === null ? "over" : fmtPct(feeNow)) + "), it ends " + hook.windows["Sniper fee ends"] + ", one buy can spend " + hook.windows["Most one buy can spend"] + " at most, that limit ends " + hook.windows["Buy limit ends"]);
  check(hook.help.includes("The sniper fee started at 40% and falls every slot to the pool fee of 0.3%. It stays in the pool. Nobody can add liquidity until it ends. Sells pay the pool fee.") && hook.help.includes("The limit is per trade, so a wallet can split a large buy into several. Sells are never limited."), "hook card: one sentence for each window says what it does and what it does not");
  const liq = await txt("#liqWindow");
  check(!!liq && liq.startsWith("This pool takes no new liquidity while its sniper fee runs. Adding opens at slot " + fmtInt(end.sniper) + ", in about ") && liq.endsWith("Taking liquidity out always works."), "liquidity card of the coin page: \"" + liq + "\"");
  await coinShots("mix-windows");

  // ---- the second wallet: a buy above the limit is stopped by the page
  await open(trader, coinPath(out.pool), coinReady);
  await click("#tradeCard .seg [data-dir=buy]");
  await type("#amount", "0.3");
  await until("!!document.querySelector('#tradeCard .trade-note .bad')", 10000);
  let form = await readTrade();
  const p0 = await prompts();
  check(form.noteBad && /^This coin limits one buy to 0\.2 SOL for about .+ more\. Buy that much or less, or wait\.$/.test(form.note) && form.disabled && form.out === "No quote", "a buy of 0.3 SOL, above the limit of 0.2 SOL: the form says why and the Buy button is off: \"" + form.note + "\"");
  await scrollTo("#tradeCard"); await sleep(200); await shot("-coin-mix-overlimit-1440");
  await ev("document.querySelector('#tradeCard .btn-buy').scrollIntoView({ block: 'center' }); true");
  const at = await ev("(() => { const b = document.querySelector('#tradeCard .btn-buy').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()");
  await mouse("mouseMoved", at[0], at[1]); await mouse("mousePressed", at[0], at[1]); await mouse("mouseReleased", at[0], at[1]); await sleep(900);
  check((await prompts()) === p0 && !(await readTrade()).result, "a real click on it opens no wallet prompt and sends nothing");
  const poolNow = await client.pool(out.pool);
  const why = await refusedBy(await client.swapInstructions(trader.publicKey, poolNow, await client.hookRef(poolNow, trader.publicKey), DIRECTION.BUY, 300_000_000n, 1n), [trader]);
  check(why === "BuyTooLarge", "chain: the same buy sent without the page is refused by the program: " + (why || "IT WENT THROUGH"));
  // ---- a buy inside the sniper window: the quote or more
  const b1 = await tradeOnPage(trader, C, DIRECTION.BUY, "0.1");
  held.push([trader, out.pool]);
  say("buy form inside the window", "pay " + b1.shown.amount + " SOL, You receive " + b1.shown.out + " " + b1.shown.unit + ", " + Object.entries(b1.shown.kv).map(([k, v]) => k + " " + v).join("; "));
  if (checkTrade(b1, trader, C, "buy 0.1 SOL inside the sniper window", "window")) {
    check(b1.ev.slot < end.sniper, "the buy landed inside the sniper window: slot " + b1.ev.slot + ", the window ends at " + end.sniper);
    check(b1.pool1.reserveQuote - b1.pool0.reserveQuote === b1.amount - b1.ev.protocolFee - b1.ev.hookFee, "the whole sniper fee stayed in the pool: its SOL reserve rose by " + sol(b1.pool1.reserveQuote - b1.pool0.reserveQuote) + " = the " + sol(b1.amount) + " paid - the protocol fee - the three shares");
    sum.windowBuy = "quote " + b1.shown.out + " " + b1.shown.unit + ", received " + coins(b1.coins1 - b1.coins0) + ", fee shown " + pick(b1.shown.kv, "Pool fee").label + ", charged " + fmtPct(b1.ev.feeBpsApplied);
  }
  // the limit is per trade, as the page says: the same wallet buys again, and both buys together are above it
  if ((await slotNow()) < end.limit - 10n) {
    const pb = await client.pool(out.pool);
    let second = "";
    try { await sendNode(await client.swapInstructions(trader.publicKey, pb, await client.hookRef(pb, trader.publicKey), DIRECTION.BUY, 150_000_000n, 1n), [trader]); second = "went through"; } catch (e) { second = "was refused: " + String(e.message).slice(0, 80); }
    check(second === "went through", "chain: the limit is per trade. A second buy of 0.15 SOL by the same wallet, 0.25 SOL with the first and above the limit of 0.2 SOL, " + second);
  }
  // ---- the fee on the card falls without a reload
  const fees = [];
  const feeText = () => ev("(document.querySelector('#ruSniperFee') || {}).textContent || ''");
  fees.push(await feeText());
  for (let i = 0; i < 2; i++) { const last = fees[fees.length - 1]; await until("((document.querySelector('#ruSniperFee') || {}).textContent || '') !== " + q(last), 8000, 200); fees.push(await feeText()); }
  slot = await slotNow();
  const chainFee = rulesSniperFee(slot, out.startSlot, w.sniperSlots, w.sniperStartFeeBps, s.fee);
  const bps = fees.map((f) => Math.round(parseFloat(f) * 100));
  check(bps[2] < bps[1] && bps[1] < bps[0] && chainFee !== null && Math.abs(bps[2] - chainFee) <= 400, "the sniper fee falls on the page without a reload: " + fees.join(" > ") + " (chain at slot " + slot + ": " + (chainFee === null ? "over" : fmtPct(chainFee)) + ")");

  // ---- liquidity: refused while the window runs, by the page and by the chain
  await sendNode(await client.swapInstructions(lp.publicKey, await client.pool(out.pool), await client.hookRef(await client.pool(out.pool), lp.publicKey), DIRECTION.BUY, 150_000_000n, 1n), [lp]);
  held.push([lp, out.pool]);
  await open(lp, "/pool.html?pool=" + out.pool.toBase58(), poolReady);
  await type("#addAmount", "0.02");
  const win = await txt("#addWindow");
  const inWindow = (await slotNow()) < end.sniper;
  check(inWindow && !!win && win.startsWith("This pool takes no new liquidity while its sniper fee runs. Adding opens at slot " + fmtInt(end.sniper) + ", in about ") && win.endsWith("Removing liquidity is always possible.") && (await ev("document.querySelector('#addBtn').disabled")),
    "pool page, inside the window: \"" + win + "\" and Add liquidity is off (the SDK's liquidityOpenSlot gives " + liquidityOpenSlot(C.info) + ")");
  await scrollTo("#addCard"); await sleep(200); await shot("-pool-mix-window-1440");
  await view(375, 900, "dark"); await scrollTo("#addCard"); await sleep(300); await shot("-pool-mix-window-375");
  check(await fits(), "pool page inside the window: no horizontal scroll at 375 (" + (await overflow()) + ")");
  await view(W, HGT, "dark");
  let pl = await client.pool(out.pool);
  const sup = (await client.mint(pl.lpMint)).supply, lpN = mulDivFloor(20_000_000n, sup, pl.reserveQuote);
  if ((await slotNow()) < end.sniper - 6n) {
    const whyLiq = await refusedBy(await client.addLiquidityInstructions(lp.publicKey, pl, lpN, mulDivCeil(lpN, pl.reserveBase, sup) * 2n, mulDivCeil(lpN, pl.reserveQuote, sup) * 2n), [lp]);
    check(whyLiq === "LiquidityInSniperWindow", "chain: a deposit sent without the page inside the window is refused by the hook: " + (whyLiq || "IT WENT THROUGH"));
  } else skip("M: the chain's refusal of a deposit inside the window. The window had less than six slots left when the run got there.");
  // the window ends: the page opens the form by itself
  await waitSlot(end.sniper + 1n);
  const opened = await until("document.querySelector('#addWindow').hidden && !document.querySelector('#addBtn').disabled", 30000, 300);
  check(opened, "when the window ends the note leaves the page and Add liquidity comes on, without a reload");
  pl = await client.pool(out.pool);
  const lp1 = mulDivFloor(20_000_000n, sup, pl.reserveQuote);
  await type("#addAmount", "0.02");
  await clearToasts();
  await click("#addBtn");
  await until("/Added/.test(document.querySelector('#addResult').textContent) || !!document.querySelector('#addResult .bad')", 45000, 200);
  const addText = await txt("#addResult"), lpBal = await client.tokenBalance(lp.publicKey, pl.lpMint);
  check(/Added/.test(addText) && lpBal > 0n, "after the window the same deposit goes through the page: " + addText + " The wallet holds " + fmtUnits(lpBal, 6, 6) + " LP (the form's arithmetic gave " + fmtUnits(lp1, 6, 6) + ")");
  await until("(() => { for (const dt of document.querySelectorAll('#position dt')) if (dt.textContent.trim() === 'Pool share') return dt.nextElementSibling.textContent.trim() !== '0%'; return false; })()", 12000, 300);
  await clearToasts();
  await click("#removeQuick button:nth-child(3)"); await sleep(300);
  await click("#removeBtn");
  await until("/Removed/.test(document.querySelector('#removeResult').textContent) || !!document.querySelector('#removeResult .bad')", 45000, 200);
  check(/Removed/.test(await txt("#removeResult")) && (await client.tokenBalance(lp.publicKey, pl.lpMint)) === 0n, "and it comes out again: " + (await txt("#removeResult")));

  // ---- the buy limit ends on the coin page without a reload, then a larger buy is exact
  await open(trader, coinPath(out.pool), coinReady);
  let hk = await readHook();
  check(hk.windows["Sniper fee"] === "ended" && hk.help.includes("A sniper fee ran for the first 2 min, from 40% down to the pool fee. Buys pay the pool fee of 0.3% now."), "coin page after the sniper window: \"Sniper fee " + hk.windows["Sniper fee"] + "\". " + hk.help.find((x) => /sniper fee ran/.test(x)));
  const limitRunning = (await slotNow()) < end.limit;
  if (limitRunning) check(hk.windows["Most one buy can spend"] === "0.2 SOL" && /^in about /.test(hk.windows["Buy limit ends"] || ""), "the buy limit still runs: it ends " + hk.windows["Buy limit ends"]);
  await waitSlot(end.limit + 1n);
  const limitOver = await reads("#ruLimitLeft", "ended", 30000);
  hk = await readHook();
  check(limitOver && hk.windows["Buy limit"] === "ended" && hk.help.includes("For the first 2 min 30 s one buy could spend 0.2 SOL at most. That limit is over."), "when the buy limit ends the card says so" + (limitRunning ? " without a reload" : "") + ": \"" + hk.help.find((x) => /limit is over/.test(x)) + "\"");
  check((await readHead()).tags.join() === (await wantTags(out)).join(), "the tags in the head follow: [" + (await readHead()).tags.join(", ") + "]");

  // ---- staking. Two wallets get their coins with a plain buy through the SDK.
  for (const k of [stakerA, stakerB]) { const p = await client.pool(out.pool); await sendNode(await client.swapInstructions(k.publicKey, p, await client.hookRef(p, k.publicKey), DIRECTION.BUY, 20_000_000n, 1n), [k]); held.push([k, out.pool]); }
  const minEligible = SUPPLY / RULES_ELIGIBLE_DIVISOR;
  const A = 400_000n * 1_000_000n, B = 2_000_000n * 1_000_000n;
  await open(stakerA, coinPath(out.pool), coinReady);
  let st = await blockWhen("ruStaking", (b) => /Your first stake opens an account/.test(b.all));
  say("staking block, nothing staked", st.all);
  check(st.kv["Staked by all wallets"] === "0 " + s.sym && st.kv["Rewards right now"] === "burned for now" && st.kv["Payments start at " + ELIGIBLE] === fmtUnits(minEligible, 6, 0) + " " + s.sym + " staked" && st.kv["Your stake"] === "0 " + s.sym && st.kv["You can claim"] === "0 SOL",
    "staking, nothing staked yet: rewards right now are \"" + st.kv["Rewards right now"] + "\", payments start at " + ELIGIBLE + " = " + st.kv["Payments start at " + ELIGIBLE] + " (chain: min_eligible " + coins(minEligible) + ")");
  check(st.help[0] === "Less than " + ELIGIBLE + " of the supply is staked, so the stakers' share buys and burns the coin for now. Payments to stakers start once " + fmtUnits(minEligible, 6, 0) + " " + s.sym + " are staked. That takes " + fmtUnits(minEligible, 6, 2) + " " + s.sym + " more.", "it says where the stakers' share goes for now and how much more stake starts the payments: \"" + st.help[0] + "\"");
  check(st.buttons.ruStake && !st.buttons.ruStake.disabled && st.buttons.ruUnstake.disabled && st.buttons.ruClaim.disabled && st.help[1] === "Staked coins can be taken out about 1 h after your last stake. Each new stake restarts that time. Your first stake opens an account that costs " + fmtUnits(STAKE_RENT, 9, 6) + " SOL of rent, which does not come back.",
    "Stake is on, Unstake and Claim are off, and the form says what a first stake costs: \"" + st.help[1] + "\" (chain: rent of a stake record " + sol(STAKE_RENT) + " SOL)");
  await coinShots("mix-staking-off");
  const stake = async (kpS, amountText, raw, label) => {
    const sol0 = BigInt(await conn.getBalance(kpS.publicKey)), had = !!(await conn.getAccountInfo(rulesPda.stake(out.pool, kpS.publicKey)));
    await type("#ruAmount", amountText);
    const press = await pressForToast("#ruStake");
    const rec = await client.rulesStakeOf(out.pool, kpS.publicKey), tx = press.sig ? await txOf(press.sig) : null;
    check(press.ok && press.prompts === 1 && press.text.startsWith("Staked " + fmtUnits(raw, 6, 2) + " " + s.sym + ". It earns from the next trade on.") && rec.staked === raw, label + ": \"" + press.text + "\" One prompt. Chain: the wallet's stake record holds " + coins(rec.staked));
    if (tx) check(sol0 - BigInt(await conn.getBalance(kpS.publicKey)) === BigInt(tx.meta.fee) + (had ? 0n : STAKE_RENT), label + ": the wallet paid the network fee" + (had ? "" : " and the " + sol(STAKE_RENT) + " SOL rent of its stake record") + ", nothing else");
    return rec;
  };
  const recA = await stake(stakerA, "400000", A, "wallet one stakes 400,000");
  st = await blockWhen("ruStaking", (b) => b.kv["Staked by all wallets"] === fmtUnits(A, 6, 2) + " " + s.sym);
  check(st.kv["Staked by all wallets"] === "400,000 " + s.sym && st.kv["Your stake"] === "400,000 " + s.sym + ", 100% of all" && st.kv["Rewards right now"] === "burned for now" && st.help[0].endsWith("That takes 600,000 " + s.sym + " more."),
    "the page follows without a reload: staked by all " + st.kv["Staked by all wallets"] + ", your stake " + st.kv["Your stake"] + ", rewards still \"" + st.kv["Rewards right now"] + "\". " + st.help[0].split(". ").pop());
  // a trade while too little is staked: its rewards go to the pot, the staker earns nothing
  let before = await client.rulesState(out.pool);
  let pn = await client.pool(out.pool);
  const sigT = await sendNode(await client.swapInstructions(trader.publicKey, pn, await client.hookRef(pn, trader.publicKey), DIRECTION.SELL, 2_000_000n * 1_000_000n, 1n), [trader]);
  const evT = eventsFromTransaction(await txOf(sigT), OUR).find((e) => e.kind === "Swapped" && e.pool.equals(out.pool));
  let after = await client.rulesState(out.pool);
  const partsT = rulesSplit(evT.hookFee, w.sell);
  check(after.burnPot - before.burnPot === partsT.burn + partsT.holders && (await client.rulesStakeOf(out.pool, stakerA.publicKey)).claimable === 0n, "a sell while 400,000 are staked: its rewards, " + sol(partsT.holders) + " SOL, went to the burn pot with the burn share (pot +" + sol(after.burnPot - before.burnPot) + "), and the staker can claim 0");
  // the second wallet takes the stake over 0.1% of the supply
  await open(stakerB, coinPath(out.pool), coinReady);
  await blockWhen("ruStaking", (b) => b.kv["Staked by all wallets"] === "400,000 " + s.sym);
  await stake(stakerB, "2000000", B, "wallet two stakes 2,000,000");
  st = await blockWhen("ruStaking", (b) => b.kv["Rewards right now"] === "paid to stakers");
  say("staking block, over the threshold", st.all);
  check(st.kv["Staked by all wallets"] === "2,400,000 " + s.sym && st.kv["Rewards right now"] === "paid to stakers" && st.kv["Your stake"] === "2,000,000 " + s.sym + ", " + fmtPct(Number((B * 10000n) / (A + B))) + " of all"
    && st.help[0] === "Wallets that stake share 1% of every buy and 1.5% of every sell, in SOL. A wallet that only holds the coin earns nothing.",
    "with 2,400,000 staked, over " + ELIGIBLE + " of the supply, the page says rewards are \"" + st.kv["Rewards right now"] + "\": \"" + st.help[0] + "\"");
  check((await client.rulesState(out.pool)).stakersEligible, "chain: the stakers are eligible now (" + coins(A + B) + " staked, " + coins(minEligible) + " needed)");
  await coinShots("mix-staking-on", false);

  // ---- a trade pays the stakers: a buy above the old limit, exact again
  await open(trader, coinPath(out.pool), coinReady);
  const b2 = await tradeOnPage(trader, C, DIRECTION.BUY, "0.3");
  say("buy form after the windows", "pay " + b2.shown.amount + " SOL, You receive " + b2.shown.out + " " + b2.shown.unit + ", " + Object.entries(b2.shown.kv).map(([k, v]) => k + " " + v).join("; "));
  if (checkTrade(b2, trader, C, "buy 0.3 SOL after both windows", "exact")) sum.buy = "quote " + b2.shown.out + ", received " + coins(b2.coins1 - b2.coins0);
  const sv = await tradeOnPage(trader, C, DIRECTION.SELL, "max");
  say("sell form", "pay " + sv.shown.amount + " " + s.sym + ", You receive " + sv.shown.out + " SOL, " + Object.entries(sv.shown.kv).map(([k, v]) => k + " " + v).join("; "));
  if (checkTrade(sv, trader, C, "sell all", "exact")) sum.sell = "quote " + sv.shown.out + " SOL, received " + sol(sv.ev.amountOut) + " SOL";
  // what the two stakers earned from those two trades: the rewards shares, split by stake
  const holders = rulesSplit(b2.ev.hookFee, w.buy).holders + rulesSplit(sv.ev.hookFee, w.sell).holders;
  const [sa, sb] = await Promise.all([client.rulesStakeOf(out.pool, stakerA.publicKey), client.rulesStakeOf(out.pool, stakerB.publicKey)]);
  check(sa.claimable + sb.claimable <= holders && holders - sa.claimable - sb.claimable <= 4n && sb.claimable / 5n - sa.claimable <= 2n && sa.claimable - sb.claimable / 5n <= 2n && sa.claimable > 0n,
    "chain: the rewards of the two trades, " + sol(holders) + " SOL, are owed to the stakers by their stake: " + sol(sa.claimable) + " to the wallet with 400,000 and " + sol(sb.claimable) + " to the one with 2,000,000 (rounding keeps " + (holders - sa.claimable - sb.claimable) + " lamports)");

  // ---- the staker claims, as SOL
  await open(stakerA, coinPath(out.pool), coinReady);
  st = await blockWhen("ruStaking", (b) => b.kv["You can claim"] === fmtUnits(sa.claimable, 9, 9) + " SOL");
  check(st.kv["You can claim"] === fmtUnits(sa.claimable, 9, 9) + " SOL" && !st.buttons.ruClaim.disabled && st.kv["Your stake"] === "400,000 " + s.sym + ", " + fmtPct(Number((A * 10000n) / (A + B))) + " of all", "staking, for the first wallet: \"You can claim " + st.kv["You can claim"] + "\" (chain " + sol(sa.claimable) + "), Claim is on, its stake is " + st.kv["Your stake"]);
  // unstake: refused, with the time it opens
  const openSlot = recA.unstakeOpenSlot;
  slot = await slotNow();
  check(st.buttons.ruUnstake.disabled && st.buttons.ruUnstake.text === "Unstake" && /^Unstake opens about 1 h after your last stake, in about (1 h|5\d min( \d+ s)?)\. Each new stake restarts that time\.$/.test(st.help[1]) && openSlot === recA.record.sinceSlot + UNSTAKE_DELAY_SLOTS,
    "Unstake is off and the form says when it opens: \"" + st.help[1] + "\" (chain: last stake at slot " + recA.record.sinceSlot + ", open from slot " + openSlot + ", " + fmtSpan(slotsToSeconds(openSlot - slot)) + " from now)");
  const whyU = await refusedBy(await client.rulesUnstakeInstructions(stakerA.publicKey, await client.pool(out.pool), A), [stakerA]);
  check(whyU === "UnstakeTooEarly", "chain: an unstake sent without the page is refused by the program: " + (whyU || "IT WENT THROUGH"));
  await scrollTo("#rulesCard"); await sleep(200); await shot("-coin-mix-claimable-1440");
  const solA = BigInt(await conn.getBalance(stakerA.publicKey));
  const claim = await pressForToast("#ruClaim");
  const claimTx = claim.sig ? await txOf(claim.sig) : null;
  const paid = claimTx ? eventsFromTransaction(claimTx, OUR).find((e) => e.kind === "RewardsClaimed") : null;
  check(claim.ok && claim.prompts === 1 && !!paid && paid.amount === sa.claimable && claim.text.startsWith("Claimed " + fmtUnits(sa.claimable, 9, 9) + " SOL of rewards.") && BigInt(await conn.getBalance(stakerA.publicKey)) - solA === sa.claimable - BigInt(claimTx.meta.fee) && (await conn.getAccountInfo(wsolOf(stakerA.publicKey))) === null,
    "Claim: \"" + claim.text + "\" One prompt. The wallet's plain SOL rose by " + sol(BigInt(await conn.getBalance(stakerA.publicKey)) - solA) + " = the " + sol(sa.claimable) + " SOL of rewards - the network fee, and it has no wrapped SOL account afterwards");
  st = await blockWhen("ruStaking", (b) => b.kv["You can claim"] === "0 SOL");
  check(st.kv["You can claim"] === "0 SOL" && st.buttons.ruClaim.disabled && st.kv["Claimed by stakers so far"] === fmtUnits(sa.claimable, 9, 6) + " SOL", "the page follows: you can claim " + st.kv["You can claim"] + ", Claim is off, claimed by stakers so far " + st.kv["Claimed by stakers so far"]);
  sum.staking = "400,000 + 2,000,000 staked, " + sol(holders) + " SOL of rewards from two trades, " + sol(sa.claimable) + " claimed by the first wallet";

  // ---- the burn: record, wait, record again, buy
  const cap = rulesBurnCapBps(C.cfg, plat, s.fee);
  const burnBtn = () => pg(() => { const b = document.querySelector("#ruBurn"); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; });
  const burnNote = () => txt("#ruBurnNote");
  let state = await client.rulesState(out.pool);
  let bb = await blockWhen("ruBurnBlock", (b) => b.kv["Waits in the pot"] === fmtUnits(state.burnPot, 9, 9) + " SOL");
  say("burn block", bb.all);
  check(bb.kv["Waits in the pot"] === fmtUnits(state.burnPot, 9, 9) + " SOL" && bb.kv["One run spends at most"] === fmtPct(cap) + " of the pool's SOL" && bb.kv["Burned so far"] === "0 " + s.sym && bb.kv["Runs that bought"] === "0",
    "burn: " + bb.kv["Waits in the pot"] + " wait in the pot (chain " + sol(state.burnPot) + "), one run spends at most " + bb.kv["One run spends at most"] + " (the SDK's cap for this coin: " + cap + " bps), nothing burned yet");
  check(bb.buttons.ruBurn.text === "Record the pool" && !bb.buttons.ruBurn.disabled && bb.help[0] === "Nothing is recorded yet. This call records the pool's price and buys nothing. A buy can follow " + WAIT_TEXT + ". Anyone can send it.", "the button reads \"" + bb.buttons.ruBurn.text + "\": \"" + bb.help[0] + "\"");
  await scrollTo("#ruBurnBlock"); await sleep(200); await shot("-coin-mix-burn-1-record-1440");
  const supply0 = (await client.mint(C.mint)).supply;
  const r1 = await pressForToast("#ruBurn");
  let cfg = (await client.rulesState(out.pool)).config;
  const obs1 = cfg.obsSlot;
  check(r1.ok && r1.prompts === 1 && r1.text.startsWith("The pool is recorded. A buy can follow " + WAIT_TEXT + ".") && obs1 > 0n && cfg.obsReserveQuote > 0n && cfg.burns === 0n && (await client.mint(C.mint)).supply === supply0, "press 1, a wallet that is not the creator: \"" + r1.text + "\" Chain: the pool is recorded at slot " + obs1 + ", nothing was bought");
  // the chain refuses a call for 25 slots: the button is off and the card counts down
  await until("(() => { const b = document.querySelector('#ruBurn'); return !!b && b.disabled && !!document.querySelector('#runDue'); })()", 15000, 200);
  let btn = await burnBtn(), note = await burnNote();
  slot = await slotNow();
  if (slot < obs1 + BURN_INTERVAL_SLOTS) {
    check(btn.disabled && btn.text === "Buy and burn" && note.startsWith("The pool was recorded at slot " + fmtInt(obs1) + ". The next call opens at slot " + fmtInt(obs1 + BURN_INTERVAL_SLOTS) + ", in about ") && note.endsWith("s."), "for 25 slots the button is off and keeps its verb, \"" + btn.text + "\": \"" + note + "\" (chain slot " + slot + ")");
    await scrollTo("#ruBurnBlock"); await sleep(200); await shot("-coin-mix-burn-2-wait-1440");
    const whyB = await refusedBy([ix.rulesRunBurn(stakerA.publicKey, client.keys(await client.pool(out.pool)), 0n)], [stakerA]);
    check(whyB === "BurnTooSoon", "chain: a call sent without the page in those 25 slots is refused by the program: " + (whyB || "IT WENT THROUGH"));
  } else skip("M: the burn button while the chain refuses a call. The 25 slots were over when the run read the page.");
  // the price runs up: the next call only records the pool again
  pn = await client.pool(out.pool);
  await sendNode(await client.swapInstructions(trader.publicKey, pn, await client.hookRef(pn, trader.publicKey), DIRECTION.BUY, 300_000_000n, 1n), [trader]);
  await waitSlot(obs1 + BURN_INTERVAL_SLOTS + 1n);
  await until("(() => { const b = document.querySelector('#ruBurn'); return !!b && !b.disabled && b.textContent.trim() === 'Record the pool again'; })()", 30000, 300);
  btn = await burnBtn(); note = await burnNote();
  check(!btn.disabled && btn.text === "Record the pool again" && note === "The price is more than " + fmtPct(burnToleranceBps(cap)) + " above the recorded one, so a call now buys nothing. It records the pool again, and a buy can follow " + WAIT_TEXT + ".",
    "after a buy of 0.3 SOL lifted the price, the button comes on by itself and reads \"" + btn.text + "\": \"" + note + "\"");
  await scrollTo("#ruBurnBlock"); await sleep(200); await shot("-coin-mix-burn-3-again-1440");
  const r2 = await pressForToast("#ruBurn");
  cfg = (await client.rulesState(out.pool)).config;
  const obs2 = cfg.obsSlot;
  check(r2.ok && r2.prompts === 1 && r2.text.startsWith("The price was above the recorded one, so nothing was bought. The pool is recorded again. A buy can follow " + WAIT_TEXT + ".") && obs2 >= obs1 + BURN_INTERVAL_SLOTS && cfg.burns === 0n && (await client.mint(C.mint)).supply === supply0,
    "press 2: \"" + r2.text + "\" Chain: recorded again at slot " + obs2 + ", " + (obs2 - obs1) + " slots after the first, nothing was bought");
  // 25 slots later, with no trade in between, the call buys
  await waitSlot(obs2 + BURN_INTERVAL_SLOTS + 1n);
  await until("(() => { const b = document.querySelector('#ruBurn'); return !!b && !b.disabled && b.textContent.trim() === 'Buy and burn'; })()", 30000, 300);
  const plan = await client.rulesBurnInstructions(stakerA.publicKey, out.pool);
  btn = await burnBtn(); note = await burnNote();
  const wantNote = "A call now spends " + fmtUnits(plan.spend, 9, 6) + " SOL and burns about " + fmtUnits(plan.expectedOut, 6, 2) + " " + s.sym + "." + (plan.potLeft > 0n ? " " + fmtUnits(plan.potLeft, 9, 6) + " SOL stays in the pot for later runs." : "") + " Anyone can send it.";
  check(plan.step === "buy" && !btn.disabled && btn.text === "Buy and burn" && note === wantNote, "25 slots later the button reads \"" + btn.text + "\": \"" + note + "\" (the SDK: step " + plan.step + ", spend " + sol(plan.spend) + " of a pot of " + sol(plan.pot) + ")");
  await scrollTo("#ruBurnBlock"); await sleep(200); await shot("-coin-mix-burn-4-buy-1440");
  await view(375, 900, "dark"); await scrollTo("#ruBurnBlock"); await sleep(300); await shot("-coin-mix-burn-4-buy-375"); await view(W, HGT, "dark");
  state = await client.rulesState(out.pool);
  const r3 = await pressForToast("#ruBurn");
  const burnTx = r3.sig ? await txOf(r3.sig) : null;
  const be = burnTx ? eventsFromTransaction(burnTx, OUR).find((e) => e.kind === "BurnExecuted") : null;
  const supply1 = (await client.mint(C.mint)).supply, after3 = await client.rulesState(out.pool);
  check(r3.ok && r3.prompts === 1 && !!be && be.outcome === BURN_OUTCOME.BOUGHT && be.quoteSpent === plan.spend && r3.text.startsWith("Burn done. It spent " + fmtUnits(be.quoteSpent, 9, 6) + " SOL and burned " + fmtUnits(be.baseBurned, 6, 2) + " " + s.sym + "."),
    "press 3: \"" + r3.text + "\" Chain: outcome bought, it spent " + sol(be ? be.quoteSpent : 0n) + " SOL, the amount the card gave");
  check(!!be && supply0 - supply1 === be.baseBurned && be.baseBurned > 0n && after3.config.burns === 1n && after3.config.totalBaseBurned === be.baseBurned && after3.config.obsSlot >= obs2 + BURN_INTERVAL_SLOTS && state.burnPot - after3.burnPot === be.quoteSpent,
    "chain: the supply fell by " + coins(supply0 - supply1) + " coins, from " + coins(supply0) + " to " + coins(supply1) + ", the pot fell by what was spent, and the three calls were " + (obs2 - obs1) + " and " + (after3.config.obsSlot - obs2) + " slots apart");
  bb = await blockWhen("ruBurnBlock", (b) => b.kv["Runs that bought"] === "1");
  const rowOk = await until("(() => { const td = document.querySelector('#trades tbody tr td:nth-child(2)'); return !!td && td.textContent.trim() === 'burn'; })()", 25000, 300);
  check(bb.kv["Runs that bought"] === "1" && bb.kv["Burned so far"] === fmtUnits(be.baseBurned, 6, 2) + " " + s.sym && bb.kv["Spent on it so far"] === fmtUnits(be.quoteSpent, 9, 6) + " SOL" && bb.kv["Waits in the pot"] === fmtUnits(after3.burnPot, 9, 9) + " SOL" && rowOk,
    "the card follows without a reload: burned so far " + bb.kv["Burned so far"] + ", spent " + bb.kv["Spent on it so far"] + ", " + bb.kv["Waits in the pot"] + " left in the pot, and the trades table lists the run as \"burn\"");
  sum.burn = "record at slot " + obs1 + ", record again at " + obs2 + ", buy at " + after3.config.obsSlot + ": spent " + sol(be.quoteSpent) + " SOL, burned " + coins(be.baseBurned) + " " + s.sym;

  // ---- the creator claims its fee
  await open(kp, coinPath(out.pool), coinReady);
  state = await client.rulesState(out.pool);
  let cr = await blockWhen("ruCreator", (b) => b.kv["Waits for the creator"] === fmtUnits(state.creatorClaimable, 9, 9) + " SOL");
  check(cr.kv["Waits for the creator"] === fmtUnits(state.creatorClaimable, 9, 9) + " SOL" && state.creatorClaimable > 0n && !cr.buttons.ruClaimCreator.disabled, "creator fee, for the creator's wallet: " + cr.kv["Waits for the creator"] + " wait (chain " + sol(state.creatorClaimable) + "), Claim is on");
  await coinShots("mix-creator");
  const solC = BigInt(await conn.getBalance(kp.publicKey));
  const cc = await pressForToast("#ruClaimCreator");
  const ccTx = cc.sig ? await txOf(cc.sig) : null;
  const ce = ccTx ? eventsFromTransaction(ccTx, OUR).find((e) => e.kind === "CreatorClaimed") : null;
  check(cc.ok && cc.prompts === 1 && !!ce && ce.amount === state.creatorClaimable && cc.text.startsWith("Claimed " + fmtUnits(ce.amount, 9, 9) + " SOL of creator fee.") && BigInt(await conn.getBalance(kp.publicKey)) - solC === ce.amount - BigInt(ccTx.meta.fee),
    "Claim: \"" + cc.text + "\" One prompt. The creator's plain SOL rose by " + sol(BigInt(await conn.getBalance(kp.publicKey)) - solC) + " = the fee - the network fee");
  cr = await blockWhen("ruCreator", (b) => b.kv["Waits for the creator"] === "0 SOL");
  check(cr.kv["Waits for the creator"] === "0 SOL" && cr.kv["Claimed so far"] === fmtUnits(ce.amount, 9, 6) + " SOL" && cr.buttons.ruClaimCreator.disabled, "the page follows: " + cr.kv["Waits for the creator"] + " wait, claimed so far " + cr.kv["Claimed so far"] + ", Claim is off");
  // any other wallet sees the block without a button
  await open(visitor, coinPath(out.pool), coinReady);
  cr = await blockWhen("ruCreator", (b) => !!b.kv["Creator"]);
  const lkV = (await readRules()).blocks.ruLock;
  check(cr.kv["Creator"] === short(kp.publicKey.toBase58(), 5) && !cr.buttons.ruClaimCreator && cr.help[0] === "Only the wallet that launched the coin can claim it. Nobody can change who that is." && !!lkV && !lkV.buttons.ruUnlock, "for a wallet that is not the creator: no Claim button and no Unlock button. \"" + cr.help[0] + "\"");
  sum.creator = sol(ce.amount) + " SOL of creator fee claimed";
  // after all of that the rules in the config are still the ones launched
  const c2 = (await client.rulesState(out.pool)).config;
  check(c2.sniperSlots === w.sniperSlots && c2.sniperStartFeeBps === w.sniperStartFeeBps && ["creatorBps", "holdersBps", "burnBps"].every((k) => c2.buy[k] === w.buy[k] && c2.sell[k] === w.sell[k]) && c2.maxBuyQuote === w.maxBuyQuote && c2.limitSlots === w.limitSlots && c2.creatorLockSeconds === w.creatorLockSeconds && c2.creator.equals(kp.publicKey),
    "chain: after the trades, stakes, burns and claims the config still holds the rules and the creator of the launch, unchanged");
}

/// The end of the run: the mix's short lock is over, the creator takes the coins out.
async function unlockPart() {
  const s = SPEC.mix, kp = dev.mix, out = R.mix;
  if (!out || !out.unlockAt) { skip("M: the lock opening. The mix was not launched in this run."); return; }
  await open(kp, coinPath(out.pool), coinReady);
  let now = await chainNow();
  const early = now < out.unlockAt - 3n;
  if (early) {
    const lk = await blockWhen("ruLock", (b) => !!b.buttons.ruUnlock);
    check(lk.buttons.ruUnlock.disabled && /^in /.test(lk.kv["Opens"] || ""), "the lock, " + (out.unlockAt - now) + " s before its date: Unlock is off, it opens " + lk.kv["Opens"]);
    const why = await refusedBy(await client.rulesUnlockInstructions(kp.publicKey, await client.pool(out.pool)), [kp]);
    check(why === "StillLocked", "chain: an unlock sent without the page before the date is refused by the program: " + (why || "IT WENT THROUGH"));
    console.log("        waiting " + (out.unlockAt - now) + " s for the lock's date");
    while ((await chainNow()) < out.unlockAt + 1n) await sleep(1000);
  }
  const opened = await until("(() => { const b = document.querySelector('#ruUnlock'); return !!b && !b.disabled; })()", 40000, 400);
  const lk = await blockWhen("ruLock", (b) => b.kv["Opens"] === "now");
  check(opened && lk.kv["Opens"] === "now" && lk.kv["Lock ended"] === fmtDate(out.unlockAt) && lk.help[0].startsWith("The date has passed. The creator can take these coins out now."), "when the date comes the block says \"Lock ended " + lk.kv["Lock ended"] + "\", opens " + lk.kv["Opens"] + ", and Unlock comes on" + (early ? " without a reload" : ""));
  await scrollTo("#ruLock"); await sleep(200); await shot("-coin-mix-lock-open-1440");
  const un = await pressForToast("#ruUnlock");
  const lock = await client.rulesLock(out.pool), back = await coinsOf(kp.publicKey, out.coin.mint);
  check(un.ok && un.prompts === 1 && un.text.startsWith("Unlocked. " + fmtUnits(out.locked, 6, 2) + " " + s.sym + " are back in your wallet.") && lock.vaultBalance === 0n && back === out.locked, "Unlock: \"" + un.text + "\" Chain: the lock account is empty and the creator's wallet holds the " + coins(back) + " coins again");
  const done = await blockWhen("ruLock", (b) => b.kv["In the lock account"] === "nothing is locked");
  check(done.kv["In the lock account"] === "nothing is locked" && done.help[0] === "At launch the creator declared a lock of 1 min 26 s. The lock ended and the creator took the coins out." && !(await readHead()).tags.includes("locked"), "the page follows: \"" + done.kv["In the lock account"] + "\". " + done.help[0] + " The tag \"locked\" is gone from the head");
  out.sum.lock = coins(out.locked) + " coins locked until " + fmtDate(out.unlockAt) + ", unlocked from the page";
}

// ---- P. a preset ------------------------------------------------------------------------------------------
async function presetPart(key) {
  const s = SPEC[key], w = s.want;
  await launchOnPage(key);
  const out = R[key], C = out.coin;
  const { hook } = await pageChecks(key);
  if (w.sniperSlots > 0n) check(/%$/.test(hook.windows["Pool fee of a buy right now"] || "") && hook.windows["Most one buy can spend"] === fmtUnits(w.maxBuyQuote, 9, 6) + " SOL", "hook card: the sniper fee right now " + hook.windows["Pool fee of a buy right now"] + ", it ends " + hook.windows["Sniper fee ends"] + "; one buy can spend " + hook.windows["Most one buy can spend"] + " at most, that ends " + hook.windows["Buy limit ends"]);
  else check(Object.keys(hook.windows).length === 0, "hook card: no window rows, the coin has neither a sniper fee nor a buy limit");
  await open(trader, coinPath(out.pool), coinReady);
  const inWindow = w.sniperSlots > 0n && (await slotNow()) < out.startSlot + w.sniperSlots - 20n;
  const b = await tradeOnPage(trader, C, DIRECTION.BUY, "0.05");
  held.push([trader, out.pool]);
  say("buy form", "pay " + b.shown.amount + " SOL, You receive " + b.shown.out + " " + b.shown.unit + ", " + Object.entries(b.shown.kv).map(([k, v]) => k + " " + v).join("; "));
  if (checkTrade(b, trader, C, "buy 0.05 SOL" + (inWindow ? " inside the sniper window" : ""), w.sniperSlots > 0n && b.ev && b.ev.feeBpsApplied !== s.fee ? "window" : "exact")) out.sum.buy = "quote " + b.shown.out + " " + b.shown.unit + ", received " + coins(b.coins1 - b.coins0);
  const sv = await tradeOnPage(trader, C, DIRECTION.SELL, "max");
  say("sell form", "pay " + sv.shown.amount + " " + s.sym + ", You receive " + sv.shown.out + " SOL, " + Object.entries(sv.shown.kv).map(([k, v]) => k + " " + v).join("; "));
  if (checkTrade(sv, trader, C, "sell all", "exact")) {
    out.sum.sell = "quote " + sv.shown.out + " SOL, received " + sol(sv.ev.amountOut) + " SOL";
    check(sv.balanceShown && sv.coins1 === 0n, "sell all: Max filled the whole balance and the wallet holds no coins afterwards");
  }
  await coinShots(key, key === "hold" || key === "burn");
}

// ---- E. explore, the Hooks page, the docs, and a lock that was declared and not made ---------------------
async function explorePart() {
  const keys = Object.keys(SPEC).filter((k) => R[k] && R[k].coin);
  if (!keys.length) { skip("E: the explore page. No coin was launched in this run."); return; }
  await open(trader, "/index.html", "!!document.querySelector('#grid .coin-card:not(.ghost)')");
  await type("#search", run);
  await sleep(1500);
  const rowOf = (addr) => pg((a) => { const c = document.querySelector('.coin-card[data-pool="' + a + '"]'); if (!c) return null; const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : ""); return { name: t(c.querySelector(".coin-link")), pair: t(c.querySelector(".coin-pair")), kind: c.dataset.kind, tags: c.dataset.tags ? c.dataset.tags.split(",") : [] }; }, addr);
  for (const key of keys) {
    const s = SPEC[key], out = R[key];
    const row = await rowOf(out.pool.toBase58()), tags = (await wantTags(out)).filter((t) => t !== "rules" && t !== "no rule on");
    if (!check(!!row, "explore: \"" + s.name + "\" has a card")) continue;
    check(row.name === s.name && row.pair === s.sym + " / SOL" && row.kind === "Modules" && row.tags.join() === tags.join(), "explore: " + s.sym + " | kind " + row.kind + " | modules [" + row.tags.join(", ") + "], one per module the coin has right now");
  }
  await scrollTo("#grid"); await sleep(300); await shot("-explore-1440");
  await view(375, 900, "dark"); await scrollTo("#grid"); await sleep(300); await shot("-explore-375");
  check(await fits(), "explore page: no horizontal scroll at 375 (" + (await overflow()) + ")");
  await view(W, HGT, "dark");
  await type("#search", "");
  // the Hooks page
  await open(trader, "/hooks.html", "!!document.querySelector('#checkBtn') && !!document.querySelector('#try button')");
  await until("((document.querySelector('#pickList [data-count=rules]') || {}).textContent || '') !== ''", 15000);
  const list = await pg(() => [...document.querySelectorAll("#pickList button")].map((b) => b.querySelector("span").textContent.trim() + (b.getAttribute("aria-pressed") === "true" ? " (open)" : "")));
  const panel = await txt("#pickPanel");
  const counted = Number(String(await txt("#pickList [data-count=rules]")).replace(/[^0-9]/g, ""));
  check(list[0] === "Launch rules (open)" && list.length === 6 && /^Hook checker/.test(await txt(".page-top")) && counted >= keys.length, "Hook checker: the list of the platform's hooks starts with Launch rules, open, and counts " + counted + " pools on it: " + list.join(", "));
  check(/They are fixed at launch\. Nobody can change one afterwards, because the program has no instruction that does\./.test(panel) && panel.includes("While less than " + ELIGIBLE + " of the supply is staked, that share buys and burns the coin instead.") && /It is per trade\. A wallet can split a large buy into several\./.test(panel) && /Runs when liquidity is added and could refuse it\. It never runs when liquidity is removed\./.test(panel),
    "Hooks page: the panel says what the rules do and what they do not, and gives the flags of the program on chain in words");
  const doc = await txt("article.doc");
  check(doc.includes("Its seeds are [\"caller\", your program id], and the pool signs every callback with it.") && doc.includes("The pool signs each callback with [\"caller\", your program id], an address under the pool program."), "Hooks page, for hook authors: the caller is one address per hook program, [\"caller\", your program id]");
  await scrollTo("#pick"); await sleep(250); await shot("-hooks-rules-1440");
  await view(375, 900, "dark"); await scrollTo("#pick"); await sleep(300); await shot("-hooks-rules-375");
  check(await fits(), "hooks page: no horizontal scroll at 375 (" + (await overflow()) + ")");
  await view(W, HGT, "dark");
  // the docs
  await open(trader, "/docs.html", "!!document.querySelector('#rulesBounds tr') && !!document.querySelector('#programRows tr')");
  const bounds = await pg(() => [...document.querySelectorAll("#rulesBounds tr")].map((tr) => [...tr.children].map((td) => td.textContent.trim()).join(" | ")));
  const P = RULES_POLICY, CL = RULES_CEILINGS;
  const wantBounds = [["Creator fee, per side", fmtPct(P.creatorBps), fmtPct(CL.creatorBps)], ["Rewards for stakers, per side", fmtPct(P.holdersBps), fmtPct(CL.holdersBps)], ["Burn, per side", fmtPct(P.burnBps), fmtPct(CL.burnBps)], ["The three together, per side", fmtPct(P.sideBps), fmtPct(CL.sideBps)],
    ["Sniper fee at the start", fmtPct(P.sniperStartFeeBps), fmtPct(CL.sniperStartFeeBps)], ["Length of the sniper fee", fmtSpan(slotsToSeconds(P.sniperSlots)), fmtSpan(slotsToSeconds(CL.sniperSlots))], ["Length of the buy limit", fmtSpan(slotsToSeconds(P.limitSlots)), fmtSpan(slotsToSeconds(CL.limitSlots))],
    ["Creator lock", fmtSpan(P.creatorLockSeconds), fmtSpan(CL.creatorLockSeconds)]].map(([a, b, c]) => a + " | up to " + b + " | " + c);
  check(bounds.join("; ") === wantBounds.join("; "), "docs: the bounds table is the SDK's policy and ceilings: " + bounds.join("; "));
  const docText = await txt("article.doc");
  check(/<h2 id="rules">/.test(await ev("document.querySelector('article.doc').innerHTML")) && docText.includes("A call buys only against a record that is at least " + BURN_INTERVAL_SLOTS + " slots old.") && docText.includes("[\"caller\", hook program id]") && docText.includes("A coin with a sniper fee, a launch guard or a strict coin's max wallet takes no new liquidity while that window runs.") && !/up to 0\.5% of the pool/.test(docText),
    "docs: a section on launch rules, the buy-and-burn rule as it is now (a record at least " + BURN_INTERVAL_SLOTS + " slots old), the caller per hook, and the window on new liquidity");
  await scrollTo("#rules"); await sleep(250); await shot("-docs-rules-1440");
  await view(375, 900, "dark"); await scrollTo("#rules"); await sleep(300); await shot("-docs-rules-375");
  check(await fits(), "docs page: no horizontal scroll at 375 (" + (await overflow()) + ")");
  await view(W, HGT, "dark");

  // "no rule can ever be changed": the program's own interface has no instruction that could
  const idl = JSON.parse(readFileSync(new URL("../../idl/hook_rules.json", import.meta.url), "utf8"));
  // the strict coin (2026-10-15) added holder records, the transfer hook and strict twins of the launch steps; none of them changes a rule after the launch
  const known = ["before_add_liquidity", "before_swap", "claim_creator", "claim_holder", "claim_rewards", "close_holder", "execute", "init_manifest", "init_pool_config", "init_strict_config", "lock_creator", "lock_creator_strict", "on_pool_create", "open_holder", "run_burn", "run_burn_strict", "stake", "sync_holder", "unlock_creator", "unlock_creator_strict", "unstake"];
  const names = idl.instructions.map((i) => i.name).sort();
  check(idl.address === PROGRAMS.hook_rules.toBase58() && names.join() === known.join(), "the rules program's interface (idl/hook_rules.json) has " + names.length + " instructions and none of them changes a rate, a window or the creator: " + names.join(", "));

  // a coin whose launcher declared a lock and did not make it: launched through the SDK, with the lock instruction left out
  const bare = Keypair.generate(), mint = Keypair.generate();
  await fund(bare, 1);
  const plan = await client.launchInstructions({ dev: bare.publicKey, mint, name: "Rules Bare " + run, symbol: "RBR" + run, uri: origin + "/package.json?coin=rbr" + run, decimals: 6, totalSupply: SUPPLY, quoteMint: NATIVE_MINT, lpFeeBps: 100,
    quoteAmount: 50_000_000n, devBuyQuote: 10_000_000n, minDevBuyOut: 1n, template: "rules", rules: { buy: { creatorBps: 50 }, sell: { creatorBps: 50 }, creatorLockSeconds: 2_592_000 } });
  await sendNode(plan.createTx, [bare, mint]);
  await sendNode(plan.launchTx.filter((i) => !(i.programId.equals(PROGRAMS.hook_rules))), [bare]);
  held.push([bare, plan.pool]);
  const lock = await client.rulesLock(plan.pool);
  await open(visitor, coinPath(plan.pool), coinReady);
  const lk = await blockWhen("ruLock", (b) => !!b.kv["In the lock account"]);
  check(lock.record === null && lock.declaredSeconds === 2_592_000n && lk.kv["In the lock account"] === "nothing is locked" && lk.help[0] === "At launch the creator declared a lock of 30 days. No coins were put into the lock account. A declared lock is only a statement. What is locked is what this account holds." && !(await readHead()).tags.includes("locked"),
    "a coin with a lock that was declared and never made (chain: no lock record, 30 days declared): the page says \"" + lk.kv["In the lock account"] + "\". " + lk.help[0]);
  await scrollTo("#rulesCard"); await sleep(200); await shot("-coin-declared-not-locked-1440");
}

// ---- S. a slow wallet on a launch with a lock ---------------------------------------------------------
const SLOW = { a: null, b: null };
const LATE = { retry: { name: "Rules Late A " + run, sym: "RLA" + run, fee: 100 }, held: { name: "Rules Late B " + run, sym: "RLB" + run, fee: 100 } };
const LOCK_30 = 2_592_000n;
/// What a launch with rules and a lock costs beyond the seed, the first buy and the platform's fee, measured on this chain.
const COST_WITH_LOCK = 48_768_280n;
async function slowStart() {
  const main = tab;
  for (const [which, kp] of [["a", dev.retry], ["b", dev.held]]) {
    const t = SLOW[which] = await newTab();
    tab = t;
    const s = LATE[which === "a" ? "retry" : "held"];
    await openForm(kp, s);
    await click("#rulePresets [data-preset=sells]");
    await sleep(400);
    t.total = await txt("#total");
    t.before = BigInt(await conn.getBalance(kp.publicKey));
    await ev(which === "a" ? "window.__rejectPrompt = 2; true" : "window.__holdPrompt = 2; true");
    await ev("window.__steps = []; new MutationObserver(() => { const x = document.querySelector('#step2d').textContent.trim(); if (window.__steps[window.__steps.length - 1] !== x) window.__steps.push(x); }).observe(document.querySelector('#step2'), { subtree: true, childList: true, characterData: true }); true");
    await click("#launchBtn");
    // the plan is built before the first prompt: the date in it is no later than now plus the margin
    await until("window.__signPrompts >= 1", 60000, 200);
    t.builtBy = await chainNow();
    if (which === "a") {
      await until("document.querySelector('#launchBtn').textContent === 'Retry step 2'", 60000, 300);
      const step2 = await txt("#step2d"), res = await txt("#result");
      check(step2 === "The wallet did not sign. Nothing was sent." && /^The coin exists but the pool was not created\. You can retry step 2 with the same settings/.test(res), "tab A, a launch with a 30 day lock whose second signature is refused: step 2 says \"" + step2 + "\" and the button reads Retry step 2");
    } else {
      await until("window.__signPrompts >= 2", 60000, 300);
      check((await txt("#step2d")) === "Confirm the second transaction in your wallet." && (await ev("document.querySelector('#launchBtn').textContent")) === "Signing 2 of 2", "tab B, the same launch with the second wallet prompt left open: the page waits for the wallet");
    }
    tab = main;
  }
  // the run goes on in the first tab: it has to be the one in front
  await front();
  console.log("        both tabs wait in the background while the run goes on. The lock date in them is too old about " + (RULES_LOCK_MARGIN_SECONDS - 90) + " s after it was set");
}
async function slowEnd() {
  const main = tab;
  for (const [which, kp] of [["a", dev.retry], ["b", dev.held]]) {
    const t = SLOW[which];
    if (!t) continue;
    tab = t;
    await front();
    const s = LATE[which === "a" ? "retry" : "held"];
    const due = t.builtBy + BigInt(RULES_LOCK_MARGIN_SECONDS) - 90n + 6n;
    let now = await chainNow();
    if (now < due) { console.log("        waiting " + (due - now) + " s more for tab " + which.toUpperCase()); while ((await chainNow()) < due) await sleep(1000); }
    const waited = (await chainNow()) - t.builtBy;
    const mid = BigInt(await conn.getBalance(kp.publicKey));
    check(t.before - mid < 100_000_000n && (await client.allLaunches()).every((l) => !l.dev.equals(kp.publicKey)), "tab " + which.toUpperCase() + ", " + waited + " s after the launch was built: the coin exists, no pool does, and the wallet has paid " + sol(t.before - mid) + " SOL so far");
    const p0 = await prompts();
    const pressedAt = await chainNow();
    if (which === "a") await click("#launchBtn");
    else await ev("window.__release(); true");
    const ok = await until("!!document.querySelector('#result a.btn')", 150000, 400);
    const steps = await ev("window.__steps");
    say("tab " + which.toUpperCase() + ", step 2 said", steps.join(" / "));
    if (!check(ok, "tab " + which.toUpperCase() + ": the launch goes through" + (ok ? "" : ". The page said: " + (await txt("#result")) + " | " + (await txt("#steps"))))) { tab = main; continue; }
    await until("!!document.querySelector('#lockedLine')", 15000, 200);
    const total = await prompts();
    const rebuilt = steps.includes("The lock date in this transaction is too old to land now. Building it again with a new date.") && steps.includes("The lock date was set again. Confirm the second transaction in your wallet.");
    if (which === "a") check(rebuilt && total === 3, "tab A, Retry step 2 pressed " + waited + " s later: the page said the lock date was too old, built the transaction again and asked for one signature (prompts in all: " + total + ", the refused one among them)");
    else check(steps.includes("Your wallet stayed open longer than the lock date in this transaction allows, so it was not sent. Confirm once more.") && rebuilt && total === 3, "tab B, the wallet answered " + waited + " s later: the page did not send what it signed, said so, built the transaction again and asked once more (prompts in all: " + total + ")");
    const pool = new PublicKey(new URL(await ev("document.querySelector('#result a.btn').href")).searchParams.get("pool"));
    held.push([kp, pool]);
    const [lock, st] = await Promise.all([client.rulesLock(pool), client.rulesState(pool)]);
    const gap = lock.unlockAt - LOCK_30 - BigInt(RULES_LOCK_MARGIN_SECONDS) - pressedAt;
    check(!!lock.record && lock.vaultBalance > 0n && lock.unlockAt >= st.config.startTime + LOCK_30 && gap >= -3n && gap < 120n, "chain: the pool exists and the first buy is locked until " + fmtDate(lock.unlockAt) + ": a date set " + gap + " s after the press, not the one of " + waited + " s earlier, which the program would have refused");
    const spent = t.before - BigInt(await conn.getBalance(kp.publicKey));
    check(spent === SEED + FIRST + plat.launchFeeLamports + COST_WITH_LOCK, "chain: the wallet paid " + sol(spent) + " SOL in all, exactly a launch with a lock: no fee went to a transaction that failed (the page showed a Total of " + t.total + ")");
    check((await txt("#lockedLine")) === fmtUnits(lock.vaultBalance, 6, 6) + " " + s.sym + " of your first buy are locked until " + fmtDate(lock.unlockAt) + ", your local time.", "the page states the lock it made: \"" + (await txt("#lockedLine")) + "\"");
    await scrollTo("#steps"); await sleep(200); await shot("-launch-late-" + which + "-1440");
    tab = main;
  }
  tab = main;
  await front();
}

try {
  tab = await attach(await edge.page(), false);
  console.log("run " + run + ", parts " + wanted.join(",") + ", site " + origin + ", chain " + RPC + ", protocol fee " + fmtPct(plat.protocolFeeBps) + ", hook fee cap " + fmtPct(plat.maxHookFeeBps) + ", override cap " + fmtPct(plat.maxFeeOverrideBps) + ", launch fee " + sol(plat.launchFeeLamports) + " SOL");
  console.log("wallets: second wallet " + trader.publicKey.toBase58() + ", stakers " + stakerA.publicKey.toBase58() + " and " + stakerB.publicKey.toBase58() + ", liquidity wallet " + lp.publicKey.toBase58());

  if (want("S")) await section("S. a slow wallet, first half: two launches with a lock are started in tabs of their own", slowStart);
  if (want("V")) await section("V. the launch form: bounds from the SDK's policy, each problem in words under its field", formPart);
  if (want("M")) await section("M. a hand-made mix with every rule (dev wallet " + dev.mix.publicKey.toBase58() + ")", mixPart);
  for (const key of ["creator", "hold", "burn", "sells"]) if (want(SPEC[key].n)) await section(SPEC[key].n + ". " + SPEC[key].label + " (dev wallet " + dev[key].publicKey.toBase58() + ")", () => presetPart(key));
  if (want("E")) await section("E. explore, the Hooks page, the docs, and a lock that was declared and not made", explorePart);
  if (want("S")) await section("S. a slow wallet, second half: back to the two tabs", slowEnd);
  if (want("M")) await section("M. the end of the mix's short lock", unlockPart);

  console.log("\nSUMMARY");
  for (const key of Object.keys(SPEC)) {
    const out = R[key];
    if (!out) continue;
    console.log("  " + SPEC[key].label + (out.pool ? "  pool " + out.pool.toBase58() + (out.coin ? "  mint " + out.coin.mint.toBase58() : "") : "  (not launched)"));
    for (const [k, v] of Object.entries(out.sum || {})) console.log("        " + (k + ":").padEnd(14) + " " + v);
  }
  const seen = new Map();
  for (const e of pageErrors) seen.set(e, (seen.get(e) || 0) + 1);
  console.log("\npage errors (" + pageErrors.length + "): " + (pageErrors.length ? "\n" + [...seen].map(([e, n]) => "  " + (n > 1 ? n + "x " : "") + e).join("\n") : "none"));
  console.log("\nscreenshots (" + shots.length + "): " + shots.join(", "));
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
  console.log("  coins still in the wallets (staked and locked coins are not in them): " + coins(left));
}
