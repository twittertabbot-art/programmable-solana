// Review tool: a page fed by the watcher shows what a page fed by the chain shows. Headless Edge,
// localnet only, nothing signed in the browser.
//   node web/review/flow-feed.mjs <site origin> <out prefix> [watcher url] [--rpc <counting proxy>]
//   node web/review/flow-feed.mjs http://localhost:8787 web/review/f-feed http://127.0.0.1:8790 --rpc http://127.0.0.1:8898
// The site is opened twice for each coin: as it is (no watcher on localnet, every figure and every
// trade read from the chain) and with ?watcher=<url> (the trades and the chart from the watcher's
// trades/<pool>.json). The two must show the same price, market cap, liquidity, volume, trade
// count, curve line (raised, share sold, bar, the Graduated mark with its slot, time and burn),
// pool figures, the same trades in the same order (the chain page reads the last 50 transactions,
// the watcher keeps up to 300: the rows of the chain page must be the first rows of the other) and
// the same candles where both have the trades of the bucket. Explore is compared card by card.
// A. coins: a curve coin is launched and bought to graduation here, with trades after it, so the
//    Graduated mark is checked on a coin the watcher saw from its first transaction; and a busy
//    coin with 72 trades, more than the chain page reads.
// C. coin pages: the two coins of A, then a rules coin, a coin with another hook and a seeded
//    coin from the watcher's market.json (on a validator that keeps little history their trades
//    may be gone; the figures are compared all the same).
// E. Explore, card by card.
// S. screenshots of the coin page and Explore fed by the watcher, at 375 and 1440.
// With --rpc each page is pointed at the counting proxy, and the page fed by the watcher must make
// no getSignaturesForAddress and no getTransaction call. One line per check, "  ok" or "  FAIL".
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, NATIVE_MINT, CURVE_GRADUATED } from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";

const argv = process.argv.slice(2);
const flagAt = argv.indexOf("--rpc");
const proxy = flagAt >= 0 ? argv.splice(flagAt, 2)[1].replace(/\/+$/, "") : "";
const [origin, prefix, watcherArg = "http://127.0.0.1:8790"] = argv;
if (!origin || !prefix) { console.error("usage: node web/review/flow-feed.mjs <site origin> <out prefix> [watcher url] [--rpc <counting proxy>]"); process.exit(1); }
const watcher = watcherArg.replace(/\/+$/, "");
const RPC = "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, failed = 0;
const failures = [];
const check = (ok, text) => { total++; if (!ok) { failed++; failures.push(text); } console.log((ok ? "  ok    " : "  FAIL  ") + text); return !!ok; };
const say = (label, value) => console.log("        " + (label + ":").padEnd(28) + " " + (typeof value === "string" ? value : JSON.stringify(value)));
const fund = async (kp, sol) => { for (let left = sol; left > 0; left -= 50) await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, Math.min(50, left) * LAMPORTS_PER_SOL), "confirmed"); };
async function send(payer, ixs, extra = []) {
  const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(payer.publicKey, ixs);
  tx.sign([payer, ...extra]);
  const r = await conn.confirmTransaction({ signature: await conn.sendTransaction(tx), blockhash, lastValidBlockHeight }, "confirmed");
  if (r.value.err) throw new Error("transaction failed: " + JSON.stringify(r.value.err));
}
const getJson = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.ok ? await r.json() : null; } catch (_) { return null; } };
/// A file of the watcher once one of its passes covers the slot of now: the file then holds
/// everything up to now. `slotOf(json)` reads the pass's slot from the file. 60 seconds at most.
async function feedPast(url, slotOf) {
  const s0 = await conn.getSlot();
  let j = null;
  for (let i = 0; i < 60; i++) { j = await getJson(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now()); if (j && slotOf(j) >= s0) return j; await sleep(1000); }
  return j;
}

// ---- the browser -------------------------------------------------------------------------------------
const edge = await startEdge({ name: "feed", width: 1440, height: 1200 });
let id = 0; const pending = new Map(); const events = []; const pageErrors = [];
let ws;
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); return r.result.value; };
const until = async (expression, ms = 30000) => { for (let t = 0; t < ms; t += 200) { try { if (await ev(expression)) return true; } catch (_) {} await sleep(200); } return false; };
async function view(width, height) {
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
}
async function shot(name) {
  const m = await call("Page.getLayoutMetrics");
  const s = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 9000), scale: 1 } });
  writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64"));
  console.log("        wrote " + prefix + name + ".png");
}
let bucketN = 0;
/// Open a page; `fed`: with the watcher. Returns the bucket the page was counted in ("" without a proxy).
async function open(path, fed, ready) {
  const bucket = proxy ? "feed" + (++bucketN) + "-" + Math.random().toString(36).slice(2, 6) : "";
  const params = [fed ? "watcher=" + encodeURIComponent(watcher) : "", bucket ? "rpc=" + encodeURIComponent(proxy + "/" + bucket) : ""].filter(Boolean).join("&");
  events.length = 0;
  await call("Page.navigate", { url: origin + path + (params ? (path.includes("?") ? "&" : "?") + params : "") });
  for (let i = 0; i < 200 && !events.includes("Page.loadEventFired"); i++) await sleep(100);
  if (!(await until(ready, 30000))) throw new Error("the page did not get ready: " + path + (fed ? " (with the watcher)" : ""));
  await sleep(2500);
  return bucket;
}
const counts = async (bucket) => (bucket ? (await (await fetch(proxy + "/_counts?bucket=" + bucket)).json()) : null);
const coinReady = "!document.querySelector('#layout').hidden && (!document.querySelector('#trades').hidden || !document.querySelector('#tradesEmpty').hidden)";
const coinSnapshot = () => ev(`(() => {
  const t = (s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; };
  const rows = [...document.querySelectorAll('#trades tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()).concat([((tr.querySelector('td:last-child a') || {}).href || '').split('?')[0]]).join(' | '));
  const bar = document.querySelector('#curveLine .curve-bar');
  return {
    price: t('#headPrice'), mcap: t('#headMcap'), liq: t('#headLiq'), vol: t('#headVol'), swaps: t('#headSwaps'),
    curve: (document.querySelector('#curveLine').dataset.state || 'none') + ': ' + (document.querySelector('#curveLine').hidden ? '' : t('#curveLine')), bar: bar ? bar.getAttribute('aria-valuenow') : null,
    // the age moves on between the two loads (seconds to a minute apart): the creation slot is what is compared
    stats: [...document.querySelectorAll('#stats .stat')].map((s) => s.querySelector('.l').textContent + ': ' + s.querySelector('.v').textContent.replace(/, \\d+[smhd] ago$/, '')),
    rows, note: t('#tradesNote'), empty: document.querySelector('#tradesEmpty').hidden ? '' : t('#tradesEmpty'),
    candles: (window.__chartData || []).map((c) => [c.time, c.open, c.high, c.low, c.close]),
    fed: performance.getEntriesByType('resource').some((r) => /\\/trades\\/[1-9A-HJ-NP-Za-km-z]+\\.json/.test(r.name)),
  };
})()`);

try {
  ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === "Runtime.exceptionThrown") pageErrors.push("EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") pageErrors.push("console.error " + d.params.args.map((a) => a.value || a.description).join(" "));
    else if (d.method) events.push(d.method);
  };
  await call("Page.enable"); await call("Runtime.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__reviewChart = true;" });
  await view(1440, 1200);

  // ---- A. a coin that graduates under the watcher's eyes --------------------------------------------
  console.log("\nA. a curve coin bought to graduation, then traded");
  const plat = await client.platform();
  const dev = Keypair.generate(), buyer = Keypair.generate();
  await Promise.all([fund(dev, 3), fund(buyer, 120)]);
  const mint = Keypair.generate(), sym = "FG" + String(Math.floor(Math.random() * 9000) + 1000);
  const plan = await client.launchInstructions({ dev: dev.publicKey, mint, name: "Feed Grad " + sym, symbol: sym, uri: origin + "/package.json?coin=" + sym.toLowerCase(), decimals: 6, totalSupply: 1_000_000_000_000_000n, quoteMint: NATIVE_MINT, lpFeeBps: 100, devBuyQuote: 100_000_000n, minDevBuyOut: 0n, curve: true, template: "none" });
  await send(dev, plan.createTx, plan.signers); await send(dev, plan.launchTx);
  const G = plan.pool;
  for (const sol of [20, 30]) { const p = await client.pool(G); await send(buyer, await client.swapInstructions(buyer.publicKey, p, await client.hookRef(p, buyer.publicKey), DIRECTION.BUY, BigInt(sol) * 1_000_000_000n, 0n)); }
  { const p = await client.pool(G); const amount = ((p.graduationTarget - p.reserveQuote) * 105n) / 100n + 500_000_000n; await send(buyer, await client.swapInstructions(buyer.publicKey, p, await client.hookRef(p, buyer.publicKey), DIRECTION.BUY, amount, 0n)); }
  for (let i = 0; i < 3; i++) { const p = await client.pool(G); const held = await client.tokenBalance(buyer.publicKey, p.baseMint); await send(buyer, await client.swapInstructions(buyer.publicKey, p, await client.hookRef(p, buyer.publicKey), i === 1 ? DIRECTION.BUY : DIRECTION.SELL, i === 1 ? 200_000_000n : held / 50n, 0n)); }
  const gp = await client.pool(G);
  check(gp.curveState === CURVE_GRADUATED, "the coin " + sym + " graduated on chain (" + G.toBase58() + ")");
  // a busy coin: more trades than the chain page reads (50 transactions), fewer than the watcher keeps
  const mintB = Keypair.generate(), symB = "FB" + sym.slice(2);
  const planB = await client.launchInstructions({ dev: dev.publicKey, mint: mintB, name: "Feed Busy " + symB, symbol: symB, uri: origin + "/package.json?coin=" + symB.toLowerCase(), decimals: 6, totalSupply: 1_000_000_000_000_000n, quoteMint: NATIVE_MINT, lpFeeBps: 100, devBuyQuote: 50_000_000n, minDevBuyOut: 0n, curve: true, template: "none" });
  await send(dev, planB.createTx, planB.signers); await send(dev, planB.launchTx);
  const B = planB.pool;
  for (let i = 0; i < 72; i++) {
    const p = await client.pool(B);
    const held = i % 3 === 2 ? await client.tokenBalance(buyer.publicKey, p.baseMint) : 0n;
    await send(buyer, await client.swapInstructions(buyer.publicKey, p, await client.hookRef(p, buyer.publicKey), held > 0n ? DIRECTION.SELL : DIRECTION.BUY, held > 0n ? held / 2n : 20_000_000n, 0n));
  }
  check((await client.pool(B)).swapCount >= 72n, "the busy coin " + symB + " has 72 trades and more (" + B.toBase58() + ")");
  // the watcher's next passes: the coin in the market, its trades file with the graduation
  let feedOk = false;
  for (let i = 0; i < 45 && !feedOk; i++) {
    const t = await getJson(watcher + "/trades/" + G.toBase58() + ".json"), tb = await getJson(watcher + "/trades/" + B.toBase58() + ".json");
    feedOk = !!(t && t.curve && t.curve.graduated && t.events && t.events.length >= 6 && tb && tb.events && tb.events.length >= 72);
    if (!feedOk) await sleep(2000);
  }
  check(feedOk, "the watcher's trades files have both coins: " + sym + " with its Graduated event, " + symB + " with every trade (within 90 s)");
  // the market's next pass has both
  for (let i = 0; i < 20; i++) { const m = await getJson(watcher + "/market.json"); if (m && m.pools && [G, B].every((k) => m.pools.some((p) => p.address === k.toBase58()))) break; await sleep(2000); }

  // ---- C. coin pages ------------------------------------------------------------------------------------
  console.log("\nC. coin pages: chain against watcher");
  const market = await getJson(watcher + "/market.json");
  if (!check(!!market && Array.isArray(market.pools) && market.pools.length > 0, "the watcher serves market.json (" + (market ? market.pools.length : 0) + " pools)")) throw new Error("no market");
  const list = market.pools;
  const pick = (f) => list.filter(f).sort((a, b) => Number(BigInt(b.swapCount) - BigInt(a.swapCount)))[0];
  const chosen = [
    ["the busy coin of A, open", list.find((p) => p.address === B.toBase58())],
    ["the coin of A, graduated", list.find((p) => p.address === G.toBase58())],
    ["a rules coin", pick((p) => p.template === "rules" && BigInt(p.swapCount) > 0n)],
    ["a coin with another hook", pick((p) => p.hasHook && p.template !== "rules" && p.template !== "collectible" && BigInt(p.swapCount) > 0n)],
    ["a seeded coin", pick((p) => p.curveState === "none" && !p.hasHook && BigInt(p.swapCount) > 0n)],
  ].filter(([, p]) => !!p);
  for (const [label, entry] of chosen) {
    const path = "/coin.html?pool=" + entry.address;
    // the two pages read the pool within seconds of each other; a trade in between would differ, so a difference is read again once
    let a, b, bucketB = "", feed = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await open(path, false, coinReady); a = await coinSnapshot();
      // the watcher's file holds every event up to the slot of its pass: the watcher page is opened
      // once a pass has covered the moment the chain page was read (by design it follows within a pass)
      feed = await feedPast(watcher + "/trades/" + entry.address + ".json", (j) => j.slot);
      bucketB = await open(path, true, coinReady); b = await coinSnapshot();
      if (a.price === b.price && a.swaps === b.swaps && a.rows[0] === b.rows[0]) break;
    }
    console.log("\n  " + label + " " + entry.coin.symbol + " (" + entry.address + ")");
    say("chain page", { price: a.price, mcap: a.mcap, swaps: a.swaps, rows: a.rows.length, note: a.note, candles: a.candles.length });
    say("watcher page", { price: b.price, mcap: b.mcap, swaps: b.swaps, rows: b.rows.length, note: b.note, candles: b.candles.length });
    check(b.fed && !a.fed, label + ": the watcher page read trades/<pool>.json, the chain page did not");
    check(a.price === b.price && a.mcap === b.mcap && a.liq === b.liq && a.vol === b.vol && a.swaps === b.swaps, label + ": price, market cap, liquidity, volume and trade count are the same (" + b.price + ", " + b.mcap + ")");
    check(a.curve === b.curve && a.bar === b.bar, label + ": the curve line is the same (" + b.curve.slice(0, 140) + ")");
    if (!check(JSON.stringify(a.stats) === JSON.stringify(b.stats), label + ": the pool's figures are the same")) { say("chain figures", a.stats); say("watcher figures", b.stats); }
    const n = Math.min(a.rows.length, b.rows.length);
    const firstDiff = a.rows.findIndex((r, i) => i < n && r !== b.rows[i]);
    // the chain page reads the last 50 transactions; fewer rows than the watcher's are right only when
    // the validator no longer holds the older ones (a local validator keeps a short ledger)
    const swapsFed = feed ? feed.events.filter((e) => e.kind === "Swapped") : [];
    const firstBlock = await conn.getFirstAvailableBlock().catch(() => 0);
    const want = Math.min(50, b.rows.length);
    const pruned = a.rows.length < want && !!swapsFed[a.rows.length] && Number(swapsFed[a.rows.length].slot) < firstBlock;
    check(n === a.rows.length && firstDiff < 0 && (a.rows.length >= want || pruned), label + ": the trades are the same, in the same order (" + a.rows.length + " rows on the chain page are the first " + n + " of " + b.rows.length + ")" + (pruned ? "; the validator keeps no transaction before slot " + firstBlock + ", so the chain page can show only these" : "") + (firstDiff >= 0 ? " first difference at row " + (firstDiff + 1) + ": " + a.rows[firstDiff] + " / " + b.rows[firstDiff] : ""));
    // candles: every bucket of the chain page after its first one is in the watcher page, the same
    const bm = new Map(b.candles.map((c) => [c[0], c]));
    const later = a.candles.slice(1);
    const diff = later.filter((c) => JSON.stringify(bm.get(c[0])) !== JSON.stringify(c));
    const lastA = a.candles[a.candles.length - 1], lastB = b.candles[b.candles.length - 1];
    // the first bucket of the chain page may lack the bucket's earlier trades: of it only the time and the close count
    const sameLast = !lastA && !lastB || (!!lastA && !!lastB && lastA[0] === lastB[0] && lastA[4] === lastB[4]);
    check((a.candles.length === 0 && pruned) || (diff.length === 0 && sameLast), label + ": the chart's candles are the same where both pages have the bucket's trades (" + later.length + " compared in full, the last close " + (lastB ? lastB[4] : "none") + (sameLast ? " on both" : " / " + (lastA ? lastA[4] : "none")) + ")");
    if (bucketB) {
      const c = await counts(bucketB);
      check((c.methods.getTransaction || 0) === 0 && (c.methods.getSignaturesForAddress || 0) === 0, label + ": the watcher page read no transaction and no signature list (" + c.calls + " RPC calls: " + JSON.stringify(c.methods) + ")");
    }
  }

  // ---- E. Explore ------------------------------------------------------------------------------------
  console.log("\nE. Explore: chain against watcher");
  const cardsOf = () => ev(`[...document.querySelectorAll('#grid .coin-card')].map((c) => ({ pool: c.dataset.pool, kind: c.dataset.kind, tags: c.dataset.tags,
    title: c.querySelector('.coin-title').textContent.trim(), kindLine: c.querySelector('.coin-kind').textContent.trim(), curve: c.querySelector('.coin-curve') ? c.querySelector('.coin-curve').dataset.curve + ' ' + c.querySelector('.coin-curve').textContent.trim() : '',
    bar: (c.querySelector('.coin-curve .curve-bar span') || {}).getAttribute ? c.querySelector('.coin-curve .curve-bar span').getAttribute('style') : '', mcap: c.querySelector('.coin-figs .v').textContent, age: c.querySelector('.coin-age').textContent }))`);
  const exploreReady = "!!document.querySelector('#grid .coin-card:not(.ghost)')";
  const allCards = async () => { const out = []; for (let p = 0; p < 20; p++) { out.push(...(await cardsOf())); if (await ev("document.querySelector('#nextPage').disabled")) break; await ev("document.querySelector('#nextPage').click(); true"); await sleep(300); } return out; };
  // other runs may trade on their coins meanwhile: a difference is read again, twice at most
  let ea, eb, pageA, pageB, bucketE = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    await open("/index.html", false, exploreReady); ea = await allCards(); pageA = await ev("document.querySelector('#pageSay').textContent");
    await feedPast(watcher + "/market.json", (j) => Math.max(Number(j.slot || 0), Number(j.checkedSlot || 0)));
    bucketE = await open("/index.html", true, exploreReady); eb = await allCards(); pageB = await ev("document.querySelector('#pageSay').textContent");
    const m = new Map(eb.map((c) => [c.pool, c]));
    if (ea.length === eb.length && ea.every((c) => m.has(c.pool) && JSON.stringify({ ...c, age: "" }) === JSON.stringify({ ...m.get(c.pool), age: "" }))) break;
    if (attempt < 2) console.log("        note: a card differs, perhaps a trade between the two loads; reading both again");
  }
  say("chain", pageA); say("watcher", pageB);
  const mb = new Map(eb.map((c) => [c.pool, c]));
  const missing = ea.filter((c) => !mb.has(c.pool)).map((c) => c.title);
  check(ea.length === eb.length && missing.length === 0, "Explore lists the same coins in the same number (" + ea.length + " and " + eb.length + ")" + (missing.length ? ", missing with the watcher: " + missing.slice(0, 5).join("; ") : ""));
  const order = ea.every((c, i) => eb[i] && eb[i].pool === c.pool);
  check(order, "in the same order (newest first)");
  const differ = ea.filter((c) => { const d = mb.get(c.pool); return d && JSON.stringify({ ...c, age: "" }) !== JSON.stringify({ ...d, age: "" }); });
  check(differ.length === 0, "every card says the same: name, pair, kind, tags, curve line and bar, market cap" + (differ.length ? " (" + differ.length + " differ, first: " + JSON.stringify(differ[0]) + " / " + JSON.stringify(mb.get(differ[0].pool)) + ")" : ""));
  // the two pages load some seconds apart, and each says the age at its own load
  const UNIT = { s: 1, m: 60, h: 3600, d: 86400 };
  const secs = (t) => { const m = /^(\d+)([smhd]) ago$/.exec(t); return m ? [Number(m[1]) * UNIT[m[2]], UNIT[m[2]]] : [NaN, 0]; };
  const ageOff = ea.filter((c) => { const d = mb.get(c.pool); if (!d || d.age === c.age) return false; const [x, ux] = secs(c.age), [y, uy] = secs(d.age); return !(Math.abs(x - y) <= Math.max(ux, uy) + 15); });
  check(ageOff.length === 0, "the age of every card agrees (to one unit of the coarser of the two, plus 15 seconds: the two pages load apart)" + (ageOff.length ? " (" + ageOff.slice(0, 3).map((c) => c.age + " / " + mb.get(c.pool).age).join(", ") + ")" : ""));
  if (bucketE) {
    const c = await counts(bucketE);
    check(c.calls <= 3 && !(c.methods.getProgramAccounts > 0), "Explore fed by the watcher: at most 3 RPC calls and no getProgramAccounts (" + c.calls + ": " + JSON.stringify(c.methods) + ")");
  }

  // ---- S. screenshots --------------------------------------------------------------------------------
  console.log("\nS. screenshots, fed by the watcher");
  const busy = chosen[0] ? chosen[0][1].address : G.toBase58();
  for (const w of [375, 1440]) {
    await view(w, w < 600 ? 900 : 1200);
    await open("/coin.html?pool=" + busy, true, coinReady); await shot("-coin-" + w);
    check(await ev("document.documentElement.scrollWidth <= window.innerWidth"), "coin page at " + w + ": no sideways scroll");
    await open("/coin.html?pool=" + G.toBase58(), true, coinReady); await shot("-coin-graduated-" + w);
    await open("/index.html", true, exploreReady); await shot("-explore-" + w);
    check(await ev("document.documentElement.scrollWidth <= window.innerWidth"), "Explore at " + w + ": no sideways scroll");
  }
} catch (e) {
  check(false, "the run stopped: " + e.message);
} finally {
  console.log("\n" + (await edge.close()));
}
const mine = pageErrors.filter((e) => /EXCEPTION/.test(e) || !/example\.com|programmable\.market|ERR_FAILED|CORS|Failed to load resource/.test(e));
console.log("\npage errors that are the site's own: " + (mine.length ? "\n  " + [...new Set(mine)].join("\n  ") : "none"));
check(mine.length === 0, "no script error on any page of the run");
console.log("\n" + (total - failed) + " of " + total + " checks passed" + (failed ? "\nFAILED:\n  " + failures.join("\n  ") : ""));
process.exit(failed ? 1 : 0);
