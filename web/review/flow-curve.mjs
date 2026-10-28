// Review tool: the curve launch on the site, end to end, in headless Edge with real mouse and
// keyboard input, signed by throwaway wallets made here (localnet only, airdropped, never written
// to disk).
//   node web/review/flow-curve.mjs <site origin> <out prefix> [parts]
//   node web/review/flow-curve.mjs http://localhost:8787 web/review/c-curve
// A. the choice "How the pool starts" on Module Mode: the curve by default, the seed field gone,
//    the supply a fixed fact, the cost without SOL into the pool, the curve in four sentences with
//    the platform's numbers worked out by the SDK; the seed back when it is picked; the strict
//    panel's sentence about the max wallet on the curve.
// B. the pegged collectible coin cannot use the curve: the choice is off and the form says why.
// F. the custom hook page, on the curve: the sentence for hooks that price from the payload.
// L. a curve launch of a plain coin and of a coin with modules, through Module Mode, against the
//    chain: the pool on the curve, the virtual SOL, the target, the LP all in the lock account,
//    the first buy at the curve price, the Total against the wallet.
// T. a curve launch whose second signature is refused, then Retry step 2 with the same coin.
// C. the coin page of an open curve coin: the raised line, the bar, the share sold, price and
//    market cap from the effective quote, the liquidity panel, and a sell that the pool cannot pay
//    ("No quote" with the reason). The pool page before graduation: both forms off, and why.
// E. Explore: the Curve mark with the raised amount, and the Pool filter.
// G. buys to graduation through the coin page: the buy that crosses the target says it graduates
//    the coin, its floor is the slippage on its quote and it fills exactly that quote; after it
//    the Graduated mark with the slot and the coins burned (from the event), the pool page with
//    its forms open (a deposit goes through), and a sell.
// M. the coin with modules is left past its target by a buy sent from here without graduate; the
//    page says so, and a buy on the page graduates the coin first and fills exactly its quote.
// S. a seeded launch still works from the same form.
// D. the docs page: "How a launch starts" with the numbers worked out by the SDK.
// R. the changed pages at 375, 768, 1024 and 1440: no sideways scroll, every control at least
//    44 px high on a touch screen, a screenshot of each.
// "parts": all (the default), or some of A,B,F,L,T,C,E,G,M,S,D,R (C, E, G, M and R need L).
// API_ORIGIN=<origin of a site server with the curve trade API>: part G also asks that API for the
// graduating buy and checks that it agrees with the trade card.
// One line per check, "  ok    ..." or "  FAIL  ...". The test validator at 127.0.0.1:8899 and the
// site are only read and traded on: nothing is stopped, restarted or deployed. The browser is
// started and closed by edge.mjs. The form's own metadata upload is not used: the Metadata file
// field gets a JSON address the site already serves.
import { writeFileSync, readFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  HookpoolClient, DIRECTION, PROGRAMS, NATIVE_MINT, CURVE_NONE, CURVE_OPEN, CURVE_GRADUATED, quoteSwap, curveProgress, curveInitialLp, graduationBurn,
  spotPrice, rulesArgs, rulesFirstBuyQuote, rulesPda, decodeRulesConfig, decodeMint, decodeTokenAmount, pda,
} from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";

const [origin, prefix, partsArg = "all"] = process.argv.slice(2);
if (!origin || !prefix) { console.error("usage: node web/review/flow-curve.mjs <site origin> <out prefix> [parts]"); process.exit(1); }
const PARTS = ["A", "B", "F", "L", "T", "C", "E", "G", "M", "S", "D", "R"];
const wanted = partsArg === "all" ? PARTS : partsArg.split(",").map((s) => s.trim().toUpperCase());
for (const w of wanted) if (!PARTS.includes(w)) { console.error("unknown part " + w + ". Parts: " + PARTS.join(", ")); process.exit(1); }
const want = (part) => wanted.includes(part);
const RPC = "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const W = 1440, HGT = 1300;
const SUPPLY = 1_000_000_000n * 1_000_000n; // the site's curve supply, 6 decimals
// optional: a site server whose trade API has the curve (its own port); part G then compares its quote with the card's
const API = (process.env.API_ORIGIN || "").replace(/\/+$/, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);
const say = (label, value) => console.log("        " + (label + ":").padEnd(30) + " " + (typeof value === "string" ? value : JSON.stringify(value, (k, v) => (typeof v === "bigint" ? String(v) : v))));
let total = 0, failed = 0;
const failures = [], notRun = [];
const check = (ok, text) => { total++; if (!ok) { failed++; failures.push(text); } console.log((ok ? "  ok    " : "  FAIL  ") + text); return !!ok; };
const fund = async (kp, sol) => { for (let left = sol; left > 0; left -= 50) await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, Math.min(50, left) * LAMPORTS_PER_SOL), "confirmed"); };
const plat = await client.platform();
if (!plat) { console.error("no platform account on " + RPC); process.exit(1); }
if (!plat.curveEnabled) { console.error("the platform's curve launches are off on " + RPC + ": nothing to review"); process.exit(1); }
const V = plat.curveVirtualQuote, T = plat.curveGraduationTarget;
const solText = (lamports) => (Number(lamports) / 1e9).toFixed(6);
const rawSol = (text) => { const m = /\d[\d,]*(?:\.\d+)?/.exec(String(text || "")); return m ? BigInt(Math.round(Number(m[0].replace(/,/g, "")) * 1e9)) : null; };
const applyBps = (v, bps) => (BigInt(v) * BigInt(10000 - bps)) / 10000n;

// ---- the browser ------------------------------------------------------------------------------------
const run = String(Math.floor(Math.random() * 900) + 100);
const edge = await startEdge({ name: "curve", width: W, height: HGT });
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
/// The stand-in wallet. A later wallet is handed over through localStorage.
const walletScript = (kp) => `
  (() => {
    let who = ${standin(kp)};
    try { const s = localStorage.getItem("__standin"); if (s) who = JSON.parse(s); } catch (_) {}
    if (localStorage.getItem("__forget") === "1") localStorage.removeItem("Programmable.wallet"); else localStorage.setItem("Programmable.wallet", "phantom");
    const SECRET = who.secret, ADDRESS = who.address;
    window.__who = ADDRESS; window.__signPrompts = 0;
    const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(SECRET)); };
    const publicKey = { toBase58: () => ADDRESS };
    const w = { isPhantom: true, publicKey, on() {}, disconnect: async () => {},
      connect: async () => ({ publicKey }),
      signTransaction: async (tx) => { window.__signPrompts++; if (window.__rejectAt === window.__signPrompts) throw Object.assign(new Error("User rejected the request."), { code: 4001 }); tx.sign([await key()]); return tx; },
      signAllTransactions: async (txs) => { window.__signPrompts++; const k = await key(); for (const t of txs) t.sign([k]); return txs; } };
    window.phantom = { solana: w };
  })();`;
const waitLoad = async () => { for (let i = 0; i < 200 && !events.includes("Page.loadEventFired"); i++) await sleep(100); };
/// Open a page of the site as one of the throwaway wallets and wait until `ready` holds.
async function open(kp, path, ready) {
  if (!walletScriptId) walletScriptId = (await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript(kp) })).identifier;
  if (where === "about:blank") { events.length = 0; await call("Page.navigate", { url: origin + "/package.json" }); await waitLoad(); where = "/package.json"; }
  await ev("localStorage.setItem(\"__standin\", " + JSON.stringify(standin(kp)) + "); localStorage.setItem(\"__forget\", \"0\"); true");
  for (let attempt = 0; attempt < 2; attempt++) {
    events.length = 0; where = path;
    await call("Page.navigate", { url: origin + path });
    await waitLoad();
    if (await until(ready, 15000)) { await sleep(500); return; }
    if (!(await ev("!!document.querySelector('#walletBtn.on')"))) {
      await ev("(async () => { try { const W = await import('/wallet.js'); const H = await import('/js/hookpool.js'); if (W.available().length) await W.connect(W.available()[0], H.PublicKey); } catch (_) {} return true; })()");
      if (await until(ready, 8000)) { await sleep(500); return; }
    }
    console.log("        note: the page was not ready, loading it once more: " + path);
  }
  throw new Error("the page did not get ready: " + path);
}
async function view(width, height) {
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setTouchEmulationEnabled", { enabled: width <= 768 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(400);
}
const overflow = () => ev("document.documentElement.scrollWidth <= window.innerWidth");
const text = (selector) => ev("(() => { const e = document.querySelector(" + q(selector) + "); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()");
const visible = (selector) => ev("(() => { const e = document.querySelector(" + q(selector) + "); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })()");
/// The site's own formatting, from the page: the same function the page used for what it shows.
const fmt = (fn, ...args) => ev("(async () => { const c = await import('/common.js'); return c." + fn + "(" + args.map((a) => (typeof a === "bigint" ? a + "n" : JSON.stringify(a))).join(", ") + "); })()");
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

// ---- wallets, and what the launch form shows ----------------------------------------------------------
// outsider: a client that trades without the site and sends no graduate (part M)
const dev = Keypair.generate(), trader = Keypair.generate(), outsider = Keypair.generate();
await Promise.all([fund(dev, 6), fund(trader, 150), fund(outsider, 100)]);
const launchReady = "!!document.querySelector('#walletBtn.on') && !!document.querySelector('#launchBtn') && !!document.querySelector('#costs dd') && document.querySelector('#launchBtn').textContent === 'Launch'";
const kvOf = (sel) => ev("(() => { const o = {}; const d = document.querySelector(" + q(sel) + "); if (!d) return o; const dt = [...d.querySelectorAll('dt')], dd = [...d.querySelectorAll('dd')]; dt.forEach((t, i) => { o[(t.firstChild ? t.firstChild.textContent : t.textContent).trim()] = dd[i] ? dd[i].textContent.trim() : ''; }); return o; })()");
const startNote = () => ev("[...document.querySelectorAll('#startNote p')].map((p) => p.textContent)");
const radios = () => ev("(() => { const c = document.querySelector('input[name=start][value=curve]'), s = document.querySelector('input[name=start][value=seed]'); return { curve: c.checked, seed: s.checked, curveOff: c.disabled, seedField: !document.querySelector('#seedField').hidden, supplyField: !document.querySelector('#supplyField').hidden, supplyFact: !document.querySelector('#supplyFact').hidden, off: document.querySelector('#startOff').hidden ? '' : document.querySelector('#startOff').textContent }; })()");
const pick = async (start) => { await click("label.choice:has(input[name=start][value=" + start + "]) .title"); await sleep(300); };
/// The four sentences of the curve under the cost, as the SDK works the numbers out.
async function curveLines() {
  const fresh = { reserveBase: SUPPLY, reserveQuote: 0n, virtualQuote: V, graduationTarget: T, graduationFeeBps: plat.curveGraduationFeeBps, curveState: CURVE_OPEN };
  const g = graduationBurn(fresh);
  const burnBps = Number((g.burned * 10_000n) / SUPPLY);
  return {
    burnBps, g,
    lines: [
      "You put no SOL into the pool. The coin opens at a market cap of " + (await fmt("fmtSol", V, 2)) + " SOL.",
      "It graduates when buyers have put " + (await fmt("fmtSol", T, 2)) + " SOL into the pool." + (g.fee > 0n ? " The platform then keeps " + (await fmt("fmtSol", g.fee, 4)) + " SOL of it." : ""),
      "At graduation about " + (await fmt("fmtPct", burnBps, 1)) + " of the supply is burned, so the price does not move. A later graduation burns less.",
      "Liquidity opens at graduation.",
    ],
  };
}
/// Fill the coin's own fields. The Metadata file field sits under Links.
async function fillCoin(name, symbol, firstBuy) {
  if (await visible("#studioTabs")) await click("#studioTabs [data-view=details]");
  await type("#name", name);
  await type("#symbol", symbol);
  await type("#devBuy", firstBuy);
  if (!(await ev("document.querySelector('details.more').open"))) await click("details.more > summary");
  await type("#metaUrl", origin + "/package.json?coin=" + symbol.toLowerCase());
}
/// Press Launch and wait for the end. Returns the pool and what the page said.
async function launchNow(what) {
  const out = { ok: false };
  out.before = BigInt(await conn.getBalance(dev.publicKey));
  out.costs = await kvOf("#costs"); out.total = await text("#total");
  out.first = await kvOf("#revFirstKv");
  await clearToasts();
  const p0 = await ev("window.__signPrompts");
  await click("#launchBtn");
  const done = await until("!!document.querySelector('#result a.btn') || !!document.querySelector('#result .bad')", 120000, 250);
  const bad = await text("#result .bad");
  if (!check(done && !bad, what + ": the launch went through" + (bad ? " (the page says: " + bad + ")" : done ? "" : " (no result after two minutes)"))) return out;
  check((await ev("window.__signPrompts")) - p0 === 2, what + ": two wallet prompts");
  out.step2 = await text("#step2d");
  const href = await ev("document.querySelector('#result a.btn').getAttribute('href')");
  out.pool = new PublicKey(/pool=([1-9A-HJ-NP-Za-km-z]+)/.exec(href)[1]);
  out.spent = out.before - BigInt(await conn.getBalance(dev.publicKey));
  const shown = rawSol(out.total);
  say(what + ": spent against Total", solText(out.spent) + " SOL spent, Total " + out.total);
  check(shown !== null && out.spent <= shown && shown - out.spent < 6_000_000n, what + ": the wallet spent no more than the Total, and within 0.006 SOL of it (" + solText(out.spent) + " of " + solText(shown || 0n) + ")");
  out.ok = true;
  return out;
}
/// The pool on chain against a curve launch with a first buy quoted as `fq`.
async function chainCurve(what, poolKey, fq, symbol) {
  const p = await client.pool(poolKey);
  if (!check(!!p, what + ": the pool " + poolKey.toBase58() + " is on chain")) return null;
  check(p.curveState === CURVE_OPEN && p.virtualQuote === V && p.graduationTarget === T && p.graduationFeeBps === plat.curveGraduationFeeBps, what + ": the pool is on the curve with the platform's settings: " + solText(p.virtualQuote) + " virtual SOL, target " + solText(p.graduationTarget) + " SOL, fee " + p.graduationFeeBps + " bps");
  const mint = await client.mint(p.baseMint);
  check(!!mint && mint.supply === SUPPLY, what + ": the coin's supply is the fixed 1,000,000,000");
  if (fq) check(p.reserveQuote === fq.reserveInAfter && p.reserveBase === fq.reserveOutAfter, what + ": the pool holds what the first buy put in and nothing else: " + solText(p.reserveQuote) + " real SOL (no seed), " + p.reserveBase + " raw coins");
  const [lm, ll] = await conn.getMultipleAccountsInfo([p.lpMint, p.lpLock]);
  const lpSupply = lm ? decodeMint(new Uint8Array(lm.data), lm.owner).supply : -1n, locked = ll ? decodeTokenAmount(new Uint8Array(ll.data)) : -2n;
  check(lpSupply === curveInitialLp(SUPPLY, V) && locked === lpSupply, what + ": all LP sits in the pool's lock account: " + locked + " of " + lpSupply + " raw units = isqrt(supply x virtual SOL)");
  const launch = await client.launchForMint(p.baseMint).catch(() => null);
  check(!!launch && launch.curve === true, what + ": the launch record marks a curve launch");
  if (fq) {
    const got = await client.tokenBalance(dev.publicKey, p.baseMint, p.baseTokenProgram);
    check(got === fq.amountOut, what + ": the first buy got the curve price: " + got + " raw " + symbol + ", the SDK's quote on the curve says " + fq.amountOut);
  }
  return p;
}

const L = {}; // the coins launched here: plain, modules, seeded
try {
  // ---- A. the choice ----------------------------------------------------------------------------------
  if (want("A")) {
    console.log("\nA. How the pool starts, on Module Mode");
    await open(dev, "/launch-modules.html", launchReady);
    let r = await radios();
    say("the choice when the form opens", r);
    check(r.curve && !r.seed && !r.curveOff && !r.off, "the form opens on the curve, and the curve can be picked");
    check(!r.seedField && !r.supplyField && r.supplyFact && (await text("#supplyFactV")) === "1,000,000,000", "on the curve the seed field is gone and the supply is a fact: 1,000,000,000, fixed");
    check((await text("#startCurveLine")) === "No SOL from you. It graduates at " + (await fmt("fmtSol", T, 2)) + " SOL.", "the curve's choice says the target from the platform account (" + (await text("#startCurveLine")) + ")");
    const costs = await kvOf("#costs");
    say("this launch costs", costs);
    check(Object.keys(costs).join("|") === "Your first buy|Platform launch fee|Rent and network fees" && costs["Platform launch fee"] === (await fmt("fmtSol", plat.launchFeeLamports, 4)) + " SOL", "the cost on the curve: no seed row, the first buy, the platform's launch fee on chain and the rent");
    const want4 = await curveLines();
    const lines = await startNote();
    say("under the cost", lines);
    check(JSON.stringify(lines) === JSON.stringify(want4.lines), "four short sentences explain the curve with the platform's numbers, worked out by the SDK");
    check(want4.burnBps >= 670 && want4.burnBps <= 690 && lines[0].includes("30 SOL") && lines[1].includes("85 SOL"), "with the platform's settings that is a 30 SOL start, a target of 85 SOL and about 6.8% burned (" + want4.burnBps + " bps)");
    const totalOnCurve = rawSol(await text("#total")), rent = rawSol(costs["Rent and network fees"]);
    check(totalOnCurve === plat.launchFeeLamports + rent, "the Total is the launch fee plus the rent, with no SOL into the pool");
    await pick("seed");
    r = await radios();
    const seedCosts = await kvOf("#costs");
    check(r.seed && !r.curve && r.seedField && r.supplyField && !r.supplyFact && seedCosts["Seed, locked in the pool"] === "2 SOL", "Seed it yourself brings back the seed field, the supply field and the seed row of the cost");
    check(JSON.stringify(await startNote()) === JSON.stringify(["The seed becomes liquidity, and the launch locks it in the pool. You get no LP for it. Nobody can withdraw it."]), "under the cost of a seeded launch: the seed is locked in the pool");
    await shot("-a-seed-1440", true);
    await pick("curve");
    r = await radios();
    check(r.curve && !r.seedField && r.supplyFact, "the curve can be picked again");
    // the strict panel on the curve
    await click("#strictList [data-switch=maxWallet]"); await sleep(300);
    const strictText = await text("#strictPanel");
    check(/The max wallet is a number of coins fixed at launch\. The burn at graduation does not change it\./.test(strictText || ""), "with a strict module on, the strict panel says the max wallet is fixed at launch and graduation does not change it");
    await click("#strictList [data-switch=maxWallet]"); await sleep(300);
    await shot("-a-curve-1440", true);
  }

  // ---- B. the pegged coin -------------------------------------------------------------------------------
  if (want("B")) {
    console.log("\nB. the pegged collectible coin cannot use the curve");
    await open(dev, "/launch-collectible.html", launchReady);
    let r = await radios();
    check(r.curve && !r.curveOff, "a plain collectible coin opens on the curve");
    await click("#colKind [data-kind=pegged]"); await sleep(400);
    r = await radios();
    say("pegged", r);
    check(r.seed && !r.curve && r.curveOff && r.seedField && r.off === "A pegged coin cannot launch on the curve. Its pool starts with a seed you put in.", "Pegged coin: the curve is switched off, the seed is picked, and the form says why");
    check(await ev("document.querySelector('label.choice[data-start=curve]').classList.contains('off')"), "the curve's card looks switched off");
    await click("label.choice[data-start=curve] .title"); await sleep(300);
    check((await radios()).seed, "a click on the switched-off curve changes nothing");
    check("Seed, locked in the pool" in (await kvOf("#costs")), "the cost of a pegged coin has its seed");
    await shot("-b-pegged-1440", true);
    await click("#colKind [data-kind=plain]"); await sleep(400);
    r = await radios();
    check(r.curve && !r.curveOff && !r.off, "back to a plain coin, the curve is on again, as the launcher had it");
  }

  // ---- F. a custom hook on the curve --------------------------------------------------------------------
  if (want("F")) {
    console.log("\nF. the custom hook page on the curve");
    const someProgram = PROGRAMS.hookpool.toBase58();
    await open(dev, "/launch-hook.html?hook=" + someProgram, launchReady + " && !!document.querySelector('#customVerdict .verdict-box, #customVerdict .error-text')");
    await sleep(600);
    const F5 = "On the curve, a hook that works out a price from what the pool sends it must add the pool's virtual SOL. This form cannot check what a hook reads.";
    const notes = await ev("[...document.querySelectorAll('#revNote p')].map((p) => p.textContent)");
    say("review notes", notes);
    check(notes.includes(F5), "a custom hook on the curve: the review says a hook that prices from the payload must add the virtual SOL");
    await pick("seed");
    check(!(await ev("[...document.querySelectorAll('#revNote p')].map((p) => p.textContent)")).includes(F5), "on a seeded launch that sentence is gone");
  }

  // ---- L. two curve launches ------------------------------------------------------------------------------
  if (want("L")) {
    console.log("\nL. curve launches through Module Mode");
    // a plain coin with a first buy of 0.5 SOL
    const symP = "CPL" + run, first = 500_000_000n;
    await open(dev, "/launch-modules.html", launchReady);
    await fillCoin("Curve Plain " + run, symP, "0.5");
    const fq = quoteSwap({ direction: DIRECTION.BUY, amountIn: first, reserveBase: SUPPLY, reserveQuote: 0n, virtualQuote: V, lpFeeBps: 100, protocolFeeBps: plat.protocolFeeBps, hookFeeBps: 0, feeOverrideBps: null });
    const rev = await kvOf("#revFirstKv");
    say("plain: your first buy", rev);
    check(rev["You receive"] === (await fmt("fmtUnits", fq.amountOut, 6, 6)) + " " + symP, "the review quotes the first buy on the curve: " + rev["You receive"]);
    check((await text("#pvKind")) === "", "no module on: a plain coin with no hook");
    const a = await launchNow("plain curve coin");
    if (a.ok) {
      say("step 2", a.step2);
      check(/^Pool \S+ opened on the curve, liquidity locked\.$/.test(a.step2 || ""), "step 2 says the pool opened on the curve with its liquidity locked (" + a.step2 + ")");
      const p = await chainCurve("plain curve coin", a.pool, fq, symP);
      if (p) { check(!p.hasHook, "plain curve coin: the pool has no hook"); L.plain = { pool: a.pool, sym: symP }; }
    }
    // a coin with modules: the "Built to hold" preset's buy limit on the curve, then "Rewards and burn"
    const symM = "CMD" + run, firstM = 300_000_000n;
    await open(dev, "/launch-modules.html", launchReady);
    await fillCoin("Curve Modules " + run, symM, "0.3");
    await click("#rulePresets [data-preset=hold]"); await sleep(400);
    check((await ev("document.querySelector('#rLimitSol').value")) === (await fmt("fmtSol", V / 20n, 4)).replace(/,/g, ""), "on the curve the preset's buy limit is a twentieth of the virtual SOL (" + (await ev("document.querySelector('#rLimitSol').value")) + " SOL), as it is a twentieth of the seed on a seeded launch");
    await click("#rulePresets [data-preset=burn]"); await sleep(400);
    const args = rulesArgs({ buy: { creatorBps: 50, holdersBps: 50, burnBps: 50 }, sell: { creatorBps: 50, holdersBps: 50, burnBps: 50 } });
    const fm = rulesFirstBuyQuote(args, { totalSupply: SUPPLY, quoteAmount: 0n, lpFeeBps: 100, devBuyQuote: firstM, virtualQuote: V }, plat);
    const revM = await kvOf("#revFirstKv");
    say("modules: your first buy", revM);
    check(revM["You receive"] === (await fmt("fmtUnits", fm.amountOut, 6, 6)) + " " + symM, "the review quotes the first buy of a coin with modules on the curve, with the SDK's rulesFirstBuyQuote: " + revM["You receive"]);
    check((await text("#pvKind")) === "Modules", "the preview says Modules");
    const b = await launchNow("curve coin with modules");
    if (b.ok) {
      const p = await chainCurve("curve coin with modules", b.pool, fm, symM);
      if (p) {
        check(p.hasHook && p.hookProgram.equals(PROGRAMS.hook_rules), "curve coin with modules: the pool runs the rules program");
        const info = await conn.getAccountInfo(rulesPda.cfg(b.pool));
        const cfg = info ? decodeRulesConfig(new Uint8Array(info.data)) : null;
        check(!!cfg && cfg.buy.creatorBps === 50 && cfg.buy.holdersBps === 50 && cfg.buy.burnBps === 50 && cfg.sell.burnBps === 50, "its rules on chain are the preset's: 0.5% creator fee, rewards and burn on each side");
        L.modules = { pool: b.pool, sym: symM };
      }
    }
  }

  // ---- T. the retry of step 2 on the curve ----------------------------------------------------------------
  if (want("T")) {
    console.log("\nT. a curve launch whose second signature is refused, then Retry step 2");
    const sym = "CRT" + run;
    await open(dev, "/launch-modules.html", launchReady);
    await fillCoin("Curve Retry " + run, sym, "0");
    await clearToasts();
    await ev("window.__rejectAt = window.__signPrompts + 2; true");
    await click("#launchBtn");
    const waited = await until("document.querySelector('#launchBtn').textContent === 'Retry step 2'", 60000, 250);
    say("after the refusal", { step2: await text("#step2d"), result: await text("#result") });
    check(waited && (await text("#step2d")) === "The wallet did not sign. Nothing was sent." && /^The coin exists but the pool was not created\. You can retry step 2 with the same settings/.test((await text("#result")) || ""), "a refused second signature: step 2 says so, and the button reads Retry step 2");
    await click("#launchBtn");
    const done = await until("!!document.querySelector('#result a.btn') || /failed/.test(document.querySelector('#step2').className)", 60000, 250);
    const step2 = await text("#step2d");
    check(done && /^Pool opened on the curve, liquidity locked\.$/.test(step2 || ""), "Retry step 2 opens the pool on the curve with the same coin (" + step2 + ")");
    const href = await ev("(document.querySelector('#result a.btn') || {}).getAttribute ? document.querySelector('#result a.btn').getAttribute('href') : ''");
    const m = /pool=([1-9A-HJ-NP-Za-km-z]+)/.exec(href || "");
    if (m) await chainCurve("the retried curve launch", new PublicKey(m[1]), null, sym);
    else check(false, "the retried curve launch: the page links to the coin");
  }

  // ---- C. the coin page and the pool page of an open curve coin -----------------------------------------
  if (want("C") && L.plain) {
    console.log("\nC. the coin page of an open curve coin");
    const P = L.plain.pool, sym = L.plain.sym;
    await open(trader, "/coin.html?pool=" + P.toBase58(), "!!document.querySelector('#tradeCard .btn-buy') && !document.querySelector('#layout').hidden && document.querySelector('#curveLine').dataset.state === 'open'");
    const p = await client.pool(P), m = await client.mint(p.baseMint), cp = curveProgress(p, m.supply);
    const raised = await text("#curveRaised"), sold = await text("#curveSold"), note = await text("#curveNote");
    say("the curve line", raised + " | " + sold + " | " + note);
    check(raised === "Raised " + (await fmt("fmtUnits", p.reserveQuote, 9, 2)) + " of " + (await fmt("fmtUnits", T, 9, 2)) + " SOL", "the raised line: what the pool holds of real SOL against its target (" + raised + ")");
    check(sold === (await fmt("fmtPct", cp.soldBps, 1)) + " of the supply sold", "the share of the supply sold, from the SDK's curveProgress (" + sold + ")");
    check(Number(await ev("document.querySelector('#curveLine .curve-bar').getAttribute('aria-valuenow')")) === cp.raisedBps / 100, "the bar stands at " + cp.raisedBps / 100 + "%");
    check(note === "Liquidity opens at graduation, when the pool has raised " + (await fmt("fmtUnits", T, 9, 2)) + " SOL.", "a short note that liquidity opens at graduation");
    const price = spotPrice(p, 6, 9);
    check((await text("#headPrice")) === (await fmt("fmtPrice", price)) + " SOL" && (await text("#headMcap")) === (await fmt("fmtCompact", price * Number(m.supply) / 1e6)) + " SOL", "price and market cap come from the effective quote, real and virtual SOL (" + (await text("#headPrice")) + ", " + (await text("#headMcap")) + ")");
    check(price > 0 && Math.abs(price - (Number(p.reserveQuote + V) / Number(p.reserveBase)) * 1e-3) / price < 1e-9, "the SDK's price is (real + virtual SOL) / coins");
    check(/^This pool is on the curve\. Liquidity opens at graduation/.test((await text("#liqText")) || ""), "the liquidity panel says liquidity opens at graduation (" + (await text("#liqText")) + ")");
    const stats = await ev("[...document.querySelectorAll('#stats .stat')].map((s) => s.querySelector('.l').textContent + ': ' + s.querySelector('.v').textContent)");
    check(stats.includes("Virtual SOL: " + (await fmt("fmtUnits", V, 9, 2))), "the pool's figures name the virtual SOL in the price");
    await shot("-c-coin-open-1440");
    // a sell the pool cannot pay: more coins than ever left it
    await click("#tradeCard .seg [data-dir=sell]");
    await type("#amount", "900000000");
    await until("(document.querySelector('#tradeCard .out .v') || {}).textContent === 'No quote'", 8000);
    const outV = await text("#tradeCard .out .v"), why = await text("#tradeCard .trade-note .bad");
    say("a sell of 900,000,000", outV + " | " + why);
    check(outV === "No quote" && why === "The pool cannot pay this sell. A sell on the curve is paid only from the SOL buyers put in. Sell less.", "a sell the pool cannot pay shows No quote and the reason, never a figure");
    check(await ev("document.querySelector('#tradeCard .btn-sell').disabled"), "and the Sell button is off");
    await shot("-c-sell-refused-1440");
    // the pool page before graduation
    await open(trader, "/pool.html?pool=" + P.toBase58(), "!document.querySelector('#layout').hidden && !!document.querySelector('#curveRaised')");
    const shut = await ev("({ add: document.querySelector('#addCurve').hidden ? '' : document.querySelector('#addCurve').textContent, remove: document.querySelector('#removeCurve').hidden ? '' : document.querySelector('#removeCurve').textContent, amount: document.querySelector('#addAmount').disabled, pct: document.querySelector('#removePct').disabled, addBtn: document.querySelector('#addBtn').disabled, addText: document.querySelector('#addBtn').textContent, removeBtn: document.querySelector('#removeBtn').disabled, removeText: document.querySelector('#removeBtn').textContent })");
    say("pool page on the curve", shut);
    check(/^Liquidity opens at graduation\./.test(shut.add) && /^Liquidity opens at graduation\./.test(shut.remove), "the pool page says Liquidity opens at graduation on both forms");
    check(shut.amount && shut.pct && shut.addBtn && shut.removeBtn && shut.addText === "Add liquidity" && shut.removeText === "Remove liquidity", "both forms are off, and their buttons keep their verbs");
    check((await text("#curveRaised")) === raised, "the pool page shows the same raised line (" + (await text("#curveRaised")) + ")");
    check(/A pool on the curve put all its liquidity into its lock account/.test((await text("#lockedNote")) || ""), "the locked card says a curve pool put all its liquidity in the lock account");
    await shot("-c-pool-open-1440");
  }

  // ---- E. Explore ---------------------------------------------------------------------------------------
  const exploreCard = (pool) => ev("(() => { const c = document.querySelector('.coin-card[data-pool=\"" + pool.toBase58() + "\"]'); if (!c) return null; const k = c.querySelector('.coin-curve'); return { state: k ? k.dataset.curve : '', mark: k ? (k.querySelector('.curve-mark') || {}).textContent : '', raised: k ? (k.querySelector('.coin-raised') || {}).textContent || '' : '', title: k ? k.getAttribute('title') || '' : '' }; })()");
  if (want("E") && L.plain) {
    console.log("\nE. Explore");
    await open(trader, "/index.html", "!!document.querySelector('#grid .coin-card:not(.ghost)')");
    const card = await exploreCard(L.plain.pool);
    const p = await client.pool(L.plain.pool);
    say("the card of the plain curve coin", card);
    check(!!card && card.state === "open" && card.mark === "Curve" && card.raised === (await fmt("fmtUnits", p.reserveQuote, 9, 2)) + " of " + (await fmt("fmtUnits", T, 9, 2)) + " SOL" && card.title === "On the curve. Raised " + card.raised + ".", "the card says Curve and what the pool has raised of its target");
    await click("#filtersBtn"); await sleep(200);
    await click("#start [data-start=open]"); await sleep(300);
    const open1 = await ev("[...document.querySelectorAll('#grid .coin-card')].map((c) => (c.querySelector('.coin-curve') || {}).dataset ? c.querySelector('.coin-curve').dataset.curve : '')");
    check(open1.length > 0 && open1.every((s) => s === "open") && !!(await exploreCard(L.plain.pool)), "the filter On the curve shows only open curve coins (" + open1.length + ")");
    await click("#start [data-start=none]"); await sleep(300);
    const seeded = await ev("[...document.querySelectorAll('#grid .coin-card')].filter((c) => !!c.querySelector('.coin-curve')).length");
    check(seeded === 0 && (await ev("document.querySelectorAll('#grid .coin-card').length")) > 0, "the filter Seeded shows no curve coin");
    await click("#start [data-start=all]"); await sleep(300);
    await shot("-e-explore-1440");
  }

  // ---- R. the changed pages at four widths (before graduation) --------------------------------------------
  const small = () => ev("[...document.querySelectorAll('button, a.btn, input:not([type=file]):not([type=radio]), select, textarea, summary, a.menu-item, .coin-links a, label.choice, .foot-links a, .site-nav a, .site-mark, .coin-link, .chips button')].filter((e) => { const b = e.getBoundingClientRect(); const box = e.classList.contains('coin-link') ? e.closest('.coin-card').getBoundingClientRect() : b; return b.width > 0 && b.height > 0 && box.height < 44 && getComputedStyle(e).visibility !== 'hidden'; }).map((e) => (e.id || e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().height))");
  async function widths(label, path, ready, kp, before) {
    for (const width of [375, 768, 1024, 1440]) {
      await view(width, width <= 768 ? 900 : 1000);
      await open(kp, path, ready);
      if (before) await before(width);
      await sleep(500);
      const flat = await overflow(), low = width <= 768 ? await small() : [];
      check(flat && low.length === 0, label + " at " + width + ": no sideways scroll" + (width <= 768 ? ", every control at least 44 px high" : "") + (flat ? "" : " (page is " + (await ev("document.documentElement.scrollWidth")) + " wide)") + (low.length ? " (under 44: " + [...new Set(low)].slice(0, 6).join("; ") + ")" : ""));
      await shot("-r-" + label.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + "-" + width, true);
    }
    await view(W, HGT);
  }
  const toDetails = async () => { if (await visible("#studioTabs")) { await click("#studioTabs [data-view=details]"); await sleep(250); } };
  const toReview = async () => { if (await visible("#studioTabs")) { await click("#studioTabs [data-view=coin]"); await sleep(250); } };
  if (want("R")) {
    console.log("\nR. the changed pages at 375, 768, 1024 and 1440");
    await widths("launch form curve", "/launch-modules.html", launchReady, dev, toDetails);
    await widths("launch review curve", "/launch-modules.html", launchReady, dev, toReview);
    await widths("pegged form", "/launch-collectible.html?kind=pegged", launchReady, dev, async () => { await ev("document.querySelector('#startChoices').scrollIntoView({ block: 'center' }); true"); });
    await widths("docs", "/docs.html#start", "!!document.querySelector('#start') && document.querySelector('[data-curve=after]').textContent !== ''", trader);
    if (L.plain) {
      await widths("coin open", "/coin.html?pool=" + L.plain.pool.toBase58(), "!document.querySelector('#layout').hidden && document.querySelector('#curveLine').dataset.state === 'open'", trader);
      await widths("pool open", "/pool.html?pool=" + L.plain.pool.toBase58(), "!document.querySelector('#layout').hidden && !!document.querySelector('#curveRaised')", trader);
      await widths("explore", "/index.html", "!!document.querySelector('#grid .coin-card:not(.ghost)')", trader);
    } else notRun.push("R: the open coin, pool and Explore pages (part L did not run)");
  }

  // ---- G. buys to graduation through the coin page ----------------------------------------------------
  /// One buy through the coin page. Returns what the card showed before the click and what it said after.
  async function pageBuy(pool, sym, amountSol, graduates) {
    await click("#tradeCard .seg [data-dir=buy]");
    await type("#amount", amountSol);
    await until("(() => { const v = (document.querySelector('#tradeCard .out .v') || {}).textContent; return !!v && v !== '0' && v !== 'No quote'; })()", 15000);
    await sleep(700);
    const card = await ev("(() => { const kv = {}; const dl = document.querySelector('#tradeCard dl.kv'); const dt = [...dl.querySelectorAll('dt')], dd = [...dl.querySelectorAll('dd')]; dt.forEach((t, i) => { kv[t.textContent] = dd[i] ? dd[i].textContent : ''; }); return { out: document.querySelector('#tradeCard .out .v').textContent, kv, grad: (document.querySelector('#tradeCard .trade-note .curve-grad') || {}).textContent || '' }; })()");
    await clearToasts();
    await click("#tradeCard .btn-buy");
    await until("(() => { const t = document.querySelector('#tradeCard .tx-result'); return !!t && (/Bought/.test(t.textContent) || !!t.querySelector('.bad')); })()", 90000, 250);
    // the page reads the pool, the balances and the trades again before it says what the trade did
    if (graduates) await until("!!document.querySelector('#gradSaid') || !!document.querySelector('#tradeCard .tx-result .bad')", 30000, 250);
    await sleep(1500);
    card.said = await text("#tradeCard .tx-result");
    return card;
  }
  /// Leave a pool open past its target, the way a client that does not send `graduate` would: a
  /// buy that crosses the target, sent from here without it ({ graduate: false }).
  async function leavePastTarget(label, P) {
    const before = await client.pool(P);
    const amount = ((T - before.reserveQuote) * 105n) / 100n + 500_000_000n;
    const ixs = await client.swapInstructions(outsider.publicKey, before, await client.hookRef(before, outsider.publicKey), DIRECTION.BUY, amount, 1n, { graduate: false });
    const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(outsider.publicKey, ixs);
    tx.sign([outsider]);
    const res = await conn.confirmTransaction({ signature: await conn.sendTransaction(tx), blockhash, lastValidBlockHeight }, "confirmed");
    const mid = await client.pool(P);
    check(!res.value.err && mid.curveState === CURVE_OPEN && mid.reserveQuote >= T, label + ": a buy of " + solText(amount) + " SOL sent without graduate leaves the pool open past its target (" + solText(mid.reserveQuote) + " SOL raised)");
  }
  /// `steps`: a number is a buy of that many SOL; "cross" is the buy that crosses the target, sized
  /// to what is missing; "past" leaves the pool past its target with a buy sent from here, and the
  /// page then buys 0.5 SOL, which graduates the coin first.
  async function graduateThroughPage(label, P, sym, steps) {
    const ready = "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on') && document.querySelector('#curveLine').dataset.state === 'open'";
    await open(trader, "/coin.html?pool=" + P.toBase58(), ready);
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] === "past") {
        await leavePastTarget(label, P);
        await open(trader, "/coin.html?pool=" + P.toBase58(), ready);
        check((await text("#curveNote")) === "The pool has reached its target. The next trade graduates the coin." && Number(await ev("document.querySelector('#curveLine .curve-bar').getAttribute('aria-valuenow')")) === 100, label + ": the coin page says the pool reached its target and the next trade graduates the coin (" + (await text("#curveNote")) + ")");
      }
      const before = await client.pool(P);
      const info = await client.hookInfo(before);
      // the crossing buy is sized to what is missing plus a margin for the fees
      const raw = steps[i] === "cross" ? ((T - before.reserveQuote) * 105n) / 100n + 500_000_000n : steps[i] === "past" ? 500_000_000n : BigInt(Math.round(steps[i] * 1e9));
      // the amount as it is typed, and that same amount back in lamports, as the page parses it
      const amountText = (Number(raw) / 1e9).toFixed(4);
      const amount = BigInt(Math.round(Number(amountText) * 1e4)) * 100_000n;
      const qt = await client.quoteLocal(before, plat, DIRECTION.BUY, amount, info);
      const floor = applyBps(qt.amountOut, 100);
      // with API_ORIGIN set: the trade API quotes the same buy the same way (its own server, the API's new code)
      if (API && qt.graduates) {
        try {
          const j = await (await fetch(API + "/api/v1/quote?mint=" + before.baseMint.toBase58() + "&side=buy&amount=" + amount + "&slippageBps=100")).json();
          say(label + ": the trade API on the same buy", { outAmount: j.outAmount, minOutAmount: j.minOutAmount, curve: j.curve });
          check(j.curve && j.curve.state === "open" && j.curve.graduates === true && j.outAmount === String(qt.amountOut) && j.minOutAmount === String(floor),
            label + ": the trade API agrees with the trade card: the buy graduates, the same fill, and the same floor, the slippage on that fill (" + j.minOutAmount + ")");
        } catch (e) { check(false, label + ": the trade API at " + API + " answered the quote (" + e.message + ")"); }
      }
      const pool0 = before, held0 = await client.tokenBalance(trader.publicKey, pool0.baseMint, pool0.baseTokenProgram);
      const card = await pageBuy(P, sym, amountText, !!qt.graduates);
      say(label + ": buy " + amountText + " SOL", { out: card.out, min: card.kv["Min received"], note: card.grad, said: card.said });
      if (!qt.graduates) {
        check(card.grad === "" && /Bought/.test(card.said || ""), label + ": a buy of " + amountText + " SOL that does not reach the target says nothing about graduation, and goes through");
        const after = await client.pool(P);
        await until("(document.querySelector('#curveRaised') || {}).textContent === " + q("Raised " + (await fmt("fmtUnits", after.reserveQuote, 9, 2)) + " of " + (await fmt("fmtUnits", T, 9, 2)) + " SOL"), 15000);
        check((await text("#curveRaised")) === "Raised " + (await fmt("fmtUnits", after.reserveQuote, 9, 2)) + " of " + (await fmt("fmtUnits", T, 9, 2)) + " SOL", label + ": the raised line follows the trade (" + (await text("#curveRaised")) + ")");
        continue;
      }
      const first = steps[i] === "past";
      check(qt.graduateFirst === first, label + ": the SDK quotes this buy " + (first ? "on the pool as graduation leaves it, graduate first" : "on the curve, graduate after it") + " (graduateFirst " + qt.graduateFirst + ")");
      const wantNote = first ? "This pool has reached its target. This trade graduates the coin first and is priced on the graduated pool." : "This trade graduates the coin.";
      check(card.grad === wantNote, label + ": the trade card says once what the buy does to the coin (" + card.grad + ")");
      check(card.kv["Min received"] === (await fmt("fmtUnits", floor, 6, 2)) + " " + sym, label + ": its minimum is the slippage of 1% on the quote, nothing lower: " + floor + " raw units = amountOut x 0.99 (" + card.kv["Min received"] + ")");
      check(/Bought/.test(card.said || "") && /This trade graduated the coin\. Liquidity is open now\./.test(card.said || ""), label + ": the graduating buy goes through and the card says it graduated the coin");
      const got = (await client.tokenBalance(trader.publicKey, pool0.baseMint, pool0.baseTokenProgram)) - held0;
      check(got === qt.amountOut && got >= floor, label + ": the buy filled exactly its quote: " + got + " raw " + sym + (first ? ", on the graduated pool" : ""));
      const after = await client.pool(P);
      check(after.curveState === CURVE_GRADUATED && after.virtualQuote === 0n && after.graduationTarget === 0n, label + ": on chain the pool has graduated, with no virtual SOL left");
      const ce = await client.curveEvents(P, 100);
      const g = ce.graduated;
      if (check(!!g, label + ": the Graduated event is on chain")) {
        check(g.reserveBaseAfter === (g.reserveQuoteAfter * g.reserveBaseBefore) / (g.reserveQuoteBefore + V) && g.burnedBase === g.reserveBaseBefore - g.reserveBaseAfter, label + ": the burn kept the price: " + g.burnedBase + " raw coins burned, " + g.reserveBaseAfter + " left against " + solText(g.reserveQuoteAfter) + " SOL");
        await until("(document.querySelector('#curveDone') || {}).textContent.startsWith('In slot')", 20000);
        const wantDone = "In slot " + (await fmt("fmtInt", Number(g.slot))) + (g.blockTime ? " (" + (await fmt("fmtDate", g.blockTime)) + ")" : "") + ". Graduation burned " + (await fmt("fmtUnits", g.burnedBase, 6, 0)) + " " + sym + " so the price did not move.";
        check((await text("#curveMark")) === "Graduated" && (await text("#curveDone")) === wantDone, label + ": the coin page shows a quiet Graduated mark with the slot, the time and the coins burned (" + (await text("#curveDone")) + ")");
        const stats = await ev("[...document.querySelectorAll('#stats .stat')].map((s) => s.querySelector('.l').textContent + ': ' + s.querySelector('.v').textContent)");
        check(stats.includes("Curve: graduated in slot " + (await fmt("fmtInt", Number(g.slot)))) && !stats.some((s) => /^Virtual/.test(s)), label + ": the pool's figures say graduated in that slot, and no virtual SOL any more");
      }
      check(!(await ev("!!document.querySelector('#curveLine .curve-bar')")), label + ": the progress bar is gone");
      check(!/Liquidity opens at graduation/.test((await text("#liqText")) || ""), label + ": the liquidity panel no longer says liquidity opens at graduation");
      await shot("-g-" + label.replace(/[^a-z0-9]+/gi, "-") + "-graduated-1440");
      return true;
    }
    return false;
  }
  if (want("G") && L.plain) {
    console.log("\nG. buys to graduation through the coin page (plain coin)");
    // two buys bring the pool close to its target, so the graduating buy is a small one
    const done = await graduateThroughPage("plain coin", L.plain.pool, L.plain.sym, [40, 44, "cross"]);
    if (done) {
      L.plain.graduated = true;
      // a sell after graduation
      await click("#tradeCard .seg [data-dir=sell]");
      await click("#tradeCard .quick button:nth-child(1)");
      await until("(() => { const v = (document.querySelector('#tradeCard .out .v') || {}).textContent; return !!v && v !== '0' && v !== 'No quote'; })()", 15000);
      await sleep(600); await clearToasts();
      await click("#tradeCard .btn-sell");
      await until("(() => { const t = document.querySelector('#tradeCard .tx-result'); return !!t && (/Sold/.test(t.textContent) || !!t.querySelector('.bad')); })()", 60000, 250);
      check(/Sold/.test((await text("#tradeCard .tx-result")) || ""), "after graduation a sell of a quarter of the wallet goes through on the page (" + (await text("#tradeCard .tx-result")) + ")");
      // the pool page after graduation: the forms are open, and a deposit goes through
      await open(trader, "/pool.html?pool=" + L.plain.pool.toBase58(), "!document.querySelector('#layout').hidden && !!document.querySelector('#curveMark')");
      const st = await ev("({ add: document.querySelector('#addCurve').hidden, remove: document.querySelector('#removeCurve').hidden, amount: document.querySelector('#addAmount').disabled, addBtn: document.querySelector('#addBtn').disabled })");
      check(st.add && st.remove && !st.amount && !st.addBtn && (await text("#curveMark")) === "Graduated", "the pool page after graduation: Graduated, and both forms are open");
      const lpBefore = await client.tokenBalance(trader.publicKey, (await client.pool(L.plain.pool)).lpMint);
      await type("#addAmount", "0.05");
      await until("!!document.querySelector('#addKv dd')", 8000);
      await click("#addBtn");
      await until("(() => { const t = document.querySelector('#addResult'); return !!t && (/Added/.test(t.textContent) || !!t.querySelector('.bad')); })()", 60000, 250);
      const lpAfter = await client.tokenBalance(trader.publicKey, (await client.pool(L.plain.pool)).lpMint);
      check(/Added/.test((await text("#addResult")) || "") && lpAfter > lpBefore, "a deposit of 0.05 SOL goes through after graduation (" + (await text("#addResult")) + ", LP " + lpAfter + ")");
      await shot("-g-pool-after-1440");
    }
  }

  // ---- M. the coin with modules: left past its target, then graduated first by a buy on the page ---------
  if (want("M") && L.modules) {
    console.log("\nM. the coin with modules: a buy without graduate leaves it past its target, then a buy on the page graduates it first");
    await graduateThroughPage("coin with modules", L.modules.pool, L.modules.sym, ["past"]);
  }

  // ---- E, after: graduated cards ------------------------------------------------------------------------
  if (want("E") && L.plain && L.plain.graduated) {
    await open(trader, "/index.html", "!!document.querySelector('#grid .coin-card:not(.ghost)')");
    const card = await exploreCard(L.plain.pool);
    check(!!card && card.state === "graduated" && card.mark === "Graduated", "Explore: after graduation the card says Graduated");
    await click("#filtersBtn"); await sleep(200);
    await click("#start [data-start=graduated]"); await sleep(300);
    const g = await ev("[...document.querySelectorAll('#grid .coin-card')].map((c) => c.querySelector('.coin-curve') ? c.querySelector('.coin-curve').dataset.curve : '')");
    check(g.length > 0 && g.every((s) => s === "graduated") && !!(await exploreCard(L.plain.pool)), "the filter Graduated shows only graduated coins (" + g.length + ")");
    await shot("-e-explore-graduated-1440");
  }
  if (want("R") && L.plain && L.plain.graduated) {
    await widths("coin graduated", "/coin.html?pool=" + L.plain.pool.toBase58(), "!document.querySelector('#layout').hidden && document.querySelector('#curveLine').dataset.state === 'graduated'", trader);
    await widths("pool graduated", "/pool.html?pool=" + L.plain.pool.toBase58(), "!document.querySelector('#layout').hidden && !!document.querySelector('#curveMark')", trader);
  }

  // ---- S. a seeded launch still works --------------------------------------------------------------------
  if (want("S")) {
    console.log("\nS. a seeded launch from the same form");
    const sym = "SDD" + run;
    await open(dev, "/launch-modules.html", launchReady);
    await fillCoin("Seeded Again " + run, sym, "0.02");
    await pick("seed");
    await type("#seed", "1");
    const costs = await kvOf("#costs");
    check(costs["Seed, locked in the pool"] === "1 SOL", "the cost names the seed of 1 SOL");
    const a = await launchNow("seeded coin");
    if (a.ok) {
      check(/^Pool \S+ created, liquidity locked\.$/.test(a.step2 || ""), "step 2 says the pool was created with its liquidity locked (" + a.step2 + ")");
      const p = await client.pool(a.pool);
      check(!!p && p.curveState === CURVE_NONE && p.virtualQuote === 0n && p.reserveQuote >= 1_000_000_000n, "on chain the pool is seeded: no curve, no virtual SOL, the seed of 1 SOL and the first buy in it (" + (p ? solText(p.reserveQuote) : "") + " SOL)");
      const launch = p ? await client.launchForMint(p.baseMint).catch(() => null) : null;
      check(!!launch && launch.curve === false, "the launch record marks a seeded launch");
      await open(trader, "/coin.html?pool=" + a.pool.toBase58(), "!!document.querySelector('#tradeCard .btn-buy') && !document.querySelector('#layout').hidden");
      check(await ev("document.querySelector('#curveLine').hidden"), "a seeded coin's page has no curve line");
    }
  }

  // ---- D. the docs page ------------------------------------------------------------------------------------
  if (want("D")) {
    console.log("\nD. the docs page");
    await open(trader, "/docs.html", "!!document.querySelector('#start') && !!document.querySelector('[data-plat]') && document.querySelector('[data-plat]').textContent !== ''");
    await sleep(800);
    const fresh = { reserveBase: SUPPLY, reserveQuote: 0n, virtualQuote: V, graduationTarget: T, graduationFeeBps: plat.curveGraduationFeeBps, curveState: CURVE_OPEN };
    const g = graduationBurn(fresh), atTarget = g.reserveBaseAfter + g.burned;
    const wantFacts = {
      supply: "1,000,000,000", virtual: (await fmt("fmtSol", V, 2)) + " SOL", target: (await fmt("fmtSol", T, 2)) + " SOL",
      burn: await fmt("fmtPct", Number((g.burned * 10_000n) / SUPPLY), 1), sold: await fmt("fmtPct", Number(((SUPPLY - atTarget) * 10_000n) / SUPPLY), 1),
      after: (Number(g.reserveBaseAfter / 1_000_000n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "M",
    };
    const facts = await ev("(() => { const o = {}; for (const n of document.querySelectorAll('[data-curve]')) (o[n.dataset.curve] = o[n.dataset.curve] || []).push(n.textContent); return o; })()");
    say("the numbers on the page", facts);
    check(Object.entries(wantFacts).every(([k, v]) => (facts[k] || []).length > 0 && facts[k].every((x) => x === v)), "How a launch starts: every number is the SDK's from the platform account (" + Object.entries(wantFacts).map(([k, v]) => k + " " + v).join(", ") + ")");
    check(wantFacts.sold === "73.9%" && wantFacts.after === "192.8M" && wantFacts.burn === "6.8%", "with the platform's settings: 73.9% sold at the target, 6.8% burned, 192.8M coins after");
    const article = await text("article.doc");
    check((await ev("!!document.querySelector('.toc a[href=\"#start\"]')")) && /How a launch starts/.test(article) && article.includes("Liquidity opens at graduation.") && article.includes("A coin that graduates past the target burns less.") && article.includes("A pegged collectible coin cannot launch on the curve."), "the section is in the table of contents and says the two ways, graduation, the burn and the pegged coin");
    check(await ev("document.querySelector('#curveFee').hidden") === (g.fee === 0n), "the graduation fee sentence shows only when the platform takes one");
  }
} catch (e) {
  check(false, "the run stopped: " + e.message);
} finally {
  console.log("\n" + (await edge.close()));
}

const mine = pageErrors.filter((e) => /EXCEPTION/.test(e) || !/example\.com|example\.invalid|programmable\.market|ERR_FAILED|CORS|Failed to load resource/.test(e));
console.log("\npage errors that are the site's own: " + (mine.length ? "\n  " + [...new Set(mine)].join("\n  ") : "none"));
check(mine.length === 0, "no script error on any page of the run");
if (notRun.length) console.log("not run:\n  " + notRun.join("\n  "));
console.log("\n" + (total - failed) + " of " + total + " checks passed" + (failed ? "\nFAILED:\n  " + failures.join("\n  ") : ""));
console.log("launched: " + Object.entries(L).map(([k, v]) => k + " " + v.sym + " " + v.pool.toBase58()).join(", "));
process.exit(failed ? 1 : 0);
