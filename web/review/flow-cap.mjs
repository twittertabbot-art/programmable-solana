// Review tool: a wallet at the 200 piece limit on the coin page, in headless Edge.
// Launches a coin of its own with a small unit (1,000,000 coins per piece, 4 per buy), fills one
// throwaway wallet to 200 pieces through the SDK, then reads what the page says: the list of
// 200, the note in the buy form, a sell that burns more pieces than one settle takes.
// The wallet is left backed at the end. Localnet only.
//   node web/review/flow-cap.mjs <site origin> <out prefix> [pool] [pieces]
// With a pool (one made by an earlier run) and a smaller number of pieces it skips the launch and
// the limit note and only does the list and the sell, which takes seconds instead of minutes.
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, NATIVE_MINT, collectible as col } from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";

const [origin, prefix, poolArg = "", countArg = ""] = process.argv.slice(2);
if (!origin || !prefix) { console.error("usage: node web/review/flow-cap.mjs <origin> <out prefix>"); process.exit(1); }
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (label, value) => console.log(label.padEnd(30) + (typeof value === "string" ? value : JSON.stringify(value)));
let failed = 0;
const check = (ok, text) => { if (!ok) failed++; console.log((ok ? "  ok    " : "  FAIL  ") + text); };
const fund = async (kp, sol) => conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
async function send(ixs, signers) {
  const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
  tx.sign(signers);
  const size = tx.serialize().length;
  const sig = await conn.sendTransaction(tx);
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error("transaction failed: " + JSON.stringify(res.value.err));
  return { sig, size };
}
const whole = (raw, dec = 6) => { const s = raw.toString().padStart(dec + 1, "0"); return s.slice(0, -dec) + "." + s.slice(-dec); };
const UNIT = 1_000_000n * 1_000_000n;

// ---- a coin and a full wallet --------------------------------------------------------------------
const holder = Keypair.generate();
await fund(holder, 6);
let pool;
if (poolArg) pool = new PublicKey(poolArg);
else {
const dev = Keypair.generate(), mint = Keypair.generate();
await fund(dev, 4);
const plan = await client.launchInstructions({
  dev: dev.publicKey, mint, name: "Cap Flow Coin", symbol: "CAPF", uri: origin + "/package.json?coin=cap-flow", decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
  quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: BigInt(2 * LAMPORTS_PER_SOL), devBuyQuote: 0n, minDevBuyOut: 1n,
  template: "collectible",
  collectible: { name: "Caps", uriBase: origin + "/art", unit: UNIT, maxSupply: 1000, maxPerBuy: 4, art: Uint8Array.from([1, 150, 40, 200, 30, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
});
await send(plan.createTx, [dev, mint]);
await send(plan.launchTx, [dev]);
pool = plan.pool;
console.log("launched a coin for this flow, pool " + pool.toBase58());
}
let cfg = await col.fetchCollectionConfig(conn, pool);
const limit = col.MAX_PIECES_PER_WALLET;
const max = countArg ? Math.min(limit, Number(countArg)) : limit;
const SHOWN = 12; // tiles the page draws before "Show all"
const pastTarget = async () => {
  const t = await col.fetchTicket(conn, pool, holder.publicKey);
  const target = t.batches.reduce((m, b) => (b.pieces > 0 && b.targetSlot > m ? b.targetSlot : m), 0n);
  while (BigInt(await conn.getSlot("confirmed")) <= target + 1n) await sleep(300);
};
let buys = 0;
for (;;) {
  const t = await col.fetchTicket(conn, pool, holder.publicKey);
  if (t && t.owned.length + t.pending >= max) break;
  const p = await client.pool(pool);
  // a little over four units of coins at the price now
  const want = Number(UNIT) * 4.3;
  const lamports = BigInt(Math.ceil((Number(p.reserveQuote) * want) / (Number(p.reserveBase) - want) / 0.985));
  await send(await client.swapInstructions(holder.publicKey, p, await client.hookRef(p, holder.publicKey), DIRECTION.BUY, lamports, 1n), [holder]);
  buys++;
  await pastTarget();
}
for (;;) { const ixs = await client.collectibleMintInstructions(holder.publicKey, pool); if (!ixs.length) break; await send(ixs, [holder]); }
let ticket = await col.fetchTicket(conn, pool, holder.publicKey);
let [backing] = await col.fetchBacking(conn, cfg, [holder.publicKey]);
say("wallet after " + buys + " buys", { minted: ticket.owned.length, waiting: ticket.pending, coins: whole(backing) });
check(ticket.owned.length === max && ticket.pending === 0, "the wallet holds " + max + " minted pieces");
// one more buy on chain: a full wallet earns nothing
if (max === limit) {
  const p = await client.pool(pool);
  await send(await client.swapInstructions(holder.publicKey, p, await client.hookRef(p, holder.publicKey), DIRECTION.BUY, BigInt(0.05 * LAMPORTS_PER_SOL), 1n), [holder]);
  ticket = await col.fetchTicket(conn, pool, holder.publicKey);
  check(ticket.owned.length + ticket.pending === max, "a further buy on chain earns the full wallet nothing");
  [backing] = await col.fetchBacking(conn, cfg, [holder.publicKey]);
}

// ---- the page --------------------------------------------------------------------------------------
// the browser of this run: no extensions, a profile of its own, closed through its DevTools port (edge.mjs)
const edge = await startEdge({ name: "cap", width: 1440, height: 1300 });
let id = 0; const pending = new Map(); const events = []; const pageErrors = [];
let ws;
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
const shot = async (name) => { const s = await call("Page.captureScreenshot", { format: "png" }); writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64")); console.log("  wrote " + prefix + name + ".png"); };
const until = async (expression, ms = 30000, step = 150) => { for (let t = 0; t < ms; t += step) { if (await ev(expression)) return true; await sleep(step); } return false; };
const mouse = (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
async function click(selector) {
  await ev("document.querySelector(" + JSON.stringify(selector) + ").scrollIntoView({ block: 'center' }); true");
  await sleep(120);
  const [x, y] = await ev("(() => { const b = document.querySelector(" + JSON.stringify(selector) + ").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()");
  const top = await ev("(() => { const e = document.elementFromPoint(" + x + ", " + y + "); const want = document.querySelector(" + JSON.stringify(selector) + "); return !!e && (e === want || want.contains(e)); })()");
  if (!top) throw new Error("cannot reach " + selector + " at " + Math.round(x) + ", " + Math.round(y));
  await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y);
}
async function type(selector, value) {
  await click(selector);
  await ev("document.querySelector(" + JSON.stringify(selector) + ").select(); true");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  if (value) await call("Input.insertText", { text: value });
  await sleep(350);
}
const text = (selector) => ev("(() => { const e = document.querySelector(" + JSON.stringify(selector) + "); return e ? e.innerText.replace(/\\n+/g, ' | ') : null; })()");
const walletScript = `
  localStorage.setItem("Programmable.wallet", "phantom");
  (() => {
    const SECRET = ${JSON.stringify(Array.from(holder.secretKey))};
    const ADDRESS = ${JSON.stringify(holder.publicKey.toBase58())};
    const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(SECRET)); };
    const publicKey = { toBase58: () => ADDRESS };
    window.phantom = { solana: { isPhantom: true, publicKey, on() {}, disconnect: async () => {}, connect: async () => ({ publicKey }),
      signTransaction: async (tx) => { tx.sign([await key()]); return tx; },
      signAllTransactions: async (txs) => { const k = await key(); for (const t of txs) t.sign([k]); return txs; } } };
  })();`;

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
  // headless Edge now and then reports the page as hidden, and a hidden page pauses its polls
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1300, deviceScaleFactor: 1, mobile: false });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript });
  await call("Page.navigate", { url: origin + "/coin.html?pool=" + pool.toBase58() });
  for (let i = 0; i < 100 && !events.includes("Page.loadEventFired"); i++) await sleep(100);
  const shown = Math.min(max, SHOWN);
  check(await until("document.querySelectorAll('#colMine .piece.own').length === " + shown, 30000), "the page draws the last " + shown + " pieces of " + max);
  await sleep(500);
  say("status line", await text("#colMine .mine-peg"));
  say("above the list", await text("#colMine .pieces-more"));
  const ends = "(() => { const t = [...document.querySelectorAll('#colMine .piece.own')]; const f = (x) => x.querySelector('.pos').innerText + ' ' + x.querySelector('.n').innerText + (x.querySelector('.ribbon').hidden ? '' : ' [' + x.querySelector('.ribbon').innerText + ']'); return f(t[0]) + ' ... ' + f(t[t.length - 1]); })()";
  say("first and last tile", await ev(ends));
  await ev("document.getElementById('colMine').scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); true"); await sleep(300); await shot("-1440");
  if (max > SHOWN) {
    await click("#colMine .pieces-more .btn");
    check(await until("document.querySelectorAll('#colMine .piece.own').length === " + max, 5000), "Show all draws all " + max);
    say("first and last tile, all shown", await ev(ends));
    say("one redraw of the full list, ms", await ev("(() => { const t = document.querySelector('#colMine .piece.own'); const a = performance.now(); t.click(); const b = performance.now(); t.click(); return Math.round(b - a); })()"));
    say("above the list", await text("#colMine .pieces-more"));
    await click("#colMine .pieces-more .btn");
    check(await until("document.querySelectorAll('#colMine .piece.own').length === " + shown, 5000), "and back to the last " + shown);
  }
  // the panel opens under the row of the picked tile, not at the end of the list
  await click("#colMine .piece.own");
  await sleep(300);
  say("panel, px under its tile", await ev("(() => { const t = document.querySelector('#colMine .piece.own[aria-pressed=true]'), p = document.querySelector('#colMine .piece-panel'); return p && t ? Math.round(p.getBoundingClientRect().top - t.getBoundingClientRect().bottom) : 'no panel'; })()"));
  await shot("-panel-in-list");
  await click("#colMine .piece.own[aria-pressed=true]");

  console.log("\nbuy form");
  await type("#amount", "0.05");
  const note = await text("#tradeCard .earn-line");
  say("earn line", note);
  if (max === limit) {
    check(note === "This wallet holds " + limit + " pieces, the most one wallet can hold. This buy earns none.", "the buy form says the wallet is full");
    await ev("document.querySelector('#tradeCard .earn-line').scrollIntoView({ block: 'center' }); true"); await sleep(300); await shot("-buy-note");
  } else check(/^This buy earns \d+ pieces?/.test(note || ""), "below the limit the buy form shows what the buy earns and no limit note");

  console.log("\na sell that burns ten pieces");
  await click("#tradeCard .seg [data-dir=sell]");
  const keep = max - 10;
  const amount = backing - BigInt(keep) * UNIT - 1_000_000n; // leaves coins for all but ten pieces, and 1 coin
  await type("#amount", whole(amount));
  say("sell " + whole(amount), await text("#tradeCard .earn-line.cost"));
  const before = (await col.fetchTicket(conn, pool, holder.publicKey)).owned.length;
  await click("#tradeCard .btn-sell");
  const sold = await until("((document.querySelector('#tradeCard .tx-result') || {}).innerText || '').length > 0", 90000);
  await sleep(1200);
  say("trade result", await text("#tradeCard .tx-result"));
  ticket = await col.fetchTicket(conn, pool, holder.publicKey);
  say("pieces on chain", before + " to " + ticket.owned.length);
  check(sold && ticket.owned.length === before - col.MAX_BURNS_PER_SETTLE, "the sell burned " + col.MAX_BURNS_PER_SETTLE + " pieces in its own transaction");
  say("status line", await text("#colMine .mine-peg"));
  // the rest is anyone's to settle: here the wallet does it itself, the way the watcher would
  for (;;) { const ixs = await client.collectibleSettleInstructions(holder.publicKey, pool, holder.publicKey); if (!ixs.length) break; await send(ixs, [holder]); }
  ticket = await col.fetchTicket(conn, pool, holder.publicKey);
  check(ticket.owned.length === keep, "after one more settle the wallet holds " + keep + " pieces, all backed");
  // the page reads the wallet again every 20 seconds; allow for one read that fails
  await call("Page.bringToFront").catch(() => {});
  const caught = await until("((document.querySelector('#colMine .mine-peg') || {}).innerText || '').startsWith('You hold " + keep + " piece')", 45000, 500);
  check(caught, "the page shows " + keep + " on its own, without a reload");
  if (!caught) for (let i = 0; i < 8; i++) { console.log("  still waiting: " + (await ev("JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus(), rpc: performance.getEntriesByType('resource').filter((e) => e.name.includes(':8899')).length, tiles: document.querySelectorAll('#colMine .piece.own').length, line: ((document.querySelector('#colMine .mine-peg') || {}).innerText || '').slice(0, 40) })"))); await sleep(5000); }
  say("status line", await text("#colMine .mine-peg"));

  await call("Emulation.setDeviceMetricsOverride", { width: 375, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  await ev("document.getElementById('colMine').scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); true"); await sleep(300); await shot("-375");
  say("page width at 375", await ev("document.documentElement.scrollWidth + ' of ' + window.innerWidth"));

  console.log("\npage errors: " + (pageErrors.length ? "\n" + pageErrors.join("\n") : "none"));
  console.log(failed ? failed + " CHECK(S) FAILED" : "all checks passed");
  if (failed) process.exitCode = 1;
  ws.close();
} catch (e) {
  console.error("flow failed: " + e.message);
  if (pageErrors.length) console.error(pageErrors.join("\n"));
  process.exitCode = 1;
} finally {
  console.log(await edge.close());
}
