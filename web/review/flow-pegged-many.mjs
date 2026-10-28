// Review tool: more pieces than one transaction delivers or burns, on a pegged coin, in headless Edge.
// Launches a pegged coin of its own with a small unit (1,000,000 coins per piece, 4 per buy), gives
// one throwaway wallet eight pieces through the SDK, then on the coin page: sends all the coins to a
// second wallet (eight pieces travel, six NFTs are delivered with the transfer), delivers the other
// two from the upkeep line, sells everything (eight pieces burn in the swap, six NFTs with it) and
// burns the last two from the upkeep line. Localnet only. Nothing is left to sell back.
//   node web/review/flow-pegged-many.mjs <site origin> <out prefix>
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, NATIVE_MINT, collectible as col } from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";

const [origin, prefix] = process.argv.slice(2);
if (!origin || !prefix) { console.error("usage: node web/review/flow-pegged-many.mjs <origin> <out prefix>"); process.exit(1); }
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (label, value) => console.log(label.padEnd(34) + (typeof value === "string" ? value : JSON.stringify(value)));
let failed = 0;
const check = (ok, text) => { if (!ok) failed++; console.log((ok ? "  ok    " : "  FAIL  ") + text); };
const fund = async (kp, sol) => conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
async function send(ixs, signers) {
  const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx);
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error("transaction failed: " + JSON.stringify(res.value.err));
  return sig;
}
const whole = (raw, dec = 6) => { const s = raw.toString().padStart(dec + 1, "0"); return s.slice(0, -dec) + "." + s.slice(-dec); };
const burned = async (address) => { const a = await conn.getAccountInfo(address); return !!a && a.data.length === 1 && a.data[0] === 0; };
const coreOwner = async (asset) => { const a = await conn.getAccountInfo(asset); return a && a.data[0] === 1 ? col.decodePiece(asset, new Uint8Array(a.data)).owner.toBase58() : null; };
const UNIT = 1_000_000n * 1_000_000n;
const PIECES = 8;

// ---- a pegged coin and a wallet with eight pieces ----------------------------------------------------
const dev = Keypair.generate(), mint = Keypair.generate(), holder = Keypair.generate(), other = Keypair.generate();
await Promise.all([fund(dev, 4), fund(holder, 4), fund(other, 1)]);
const plan = await client.launchInstructions({
  dev: dev.publicKey, mint, name: "Many Pegs Coin", symbol: "MANY", uri: origin + "/package.json?coin=many-flow", decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
  quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: BigInt(2 * LAMPORTS_PER_SOL), devBuyQuote: 0n, minDevBuyOut: 1n,
  template: "collectible",
  collectible: { name: "Manys", uriBase: "http://localhost:8787/art", unit: UNIT, maxSupply: 1000, maxPerBuy: 4, art: Uint8Array.from([1, 150, 40, 200, 30, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), pegged: true },
});
await send(plan.createTx, [dev, mint]);
await send(plan.launchTx, [dev]);
const pool = plan.pool;
console.log("launched a pegged coin for this flow, pool " + pool.toBase58());
const cfg = await col.fetchCollectionConfig(conn, pool);
const coinsOf = (wallet) => client.tokenBalance(wallet, cfg.baseMint, cfg.tokenProgram);
const ownedOf = async (wallet) => { const t = await col.fetchTicket(conn, pool, wallet); return t ? t.owned : []; };
while ((await ownedOf(holder.publicKey)).length < PIECES) {
  const p = await client.pool(pool);
  const want = Number(UNIT) * 4.3; // a little over four units of coins at the price now
  const lamports = BigInt(Math.ceil((Number(p.reserveQuote) * want) / (Number(p.reserveBase) - want) / 0.985));
  await send(await client.swapInstructions(holder.publicKey, p, await client.hookRef(p, holder.publicKey), DIRECTION.BUY, lamports, 1n), [holder]);
  const t = await col.fetchTicket(conn, pool, holder.publicKey);
  const target = t.batches.reduce((m, b) => (b.pieces > 0 && b.targetSlot > m ? b.targetSlot : m), 0n);
  while (BigInt(await conn.getSlot("confirmed")) <= target + 1n) await sleep(300);
  for (;;) { const ixs = await client.collectibleMintInstructions(holder.publicKey, pool); if (!ixs.length) break; await send(ixs, [holder]); }
}
const pieces = await ownedOf(holder.publicKey);
say("holder", { pieces: pieces.length, coins: whole(await coinsOf(holder.publicKey)) });
check(pieces.length === PIECES, "the holder holds " + PIECES + " pieces");

// ---- the page --------------------------------------------------------------------------------------
// the browser of this run: no extensions, a profile of its own, closed through its DevTools port (edge.mjs)
const edge = await startEdge({ name: "many", width: 1440, height: 1400 });
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
  if (!top) throw new Error("cannot reach " + selector);
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
const standin = (kp) => JSON.stringify({ secret: Array.from(kp.secretKey), address: kp.publicKey.toBase58() });
const walletScript = `
  localStorage.setItem("Programmable.wallet", "phantom");
  (() => {
    let who = ${standin(holder)};
    try { const s = localStorage.getItem("__standin"); if (s) who = JSON.parse(s); } catch (_) {}
    const SECRET = who.secret, ADDRESS = who.address;
    window.__signPrompts = 0;
    const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(SECRET)); };
    const publicKey = { toBase58: () => ADDRESS };
    window.phantom = { solana: { isPhantom: true, publicKey, on() {}, disconnect: async () => {}, connect: async () => ({ publicKey }),
      signTransaction: async (tx) => { window.__signPrompts++; tx.sign([await key()]); return tx; },
      signAllTransactions: async (txs) => { window.__signPrompts++; const k = await key(); for (const t of txs) t.sign([k]); return txs; } } };
  })();`;
const ready = "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on') && !!document.querySelector('#colMine .card-head')";
async function open(kp) {
  await ev("localStorage.setItem(\"__standin\", " + JSON.stringify(standin(kp)) + "); true").catch(() => {});
  events.length = 0;
  await call("Page.navigate", { url: origin + "/coin.html?pool=" + pool.toBase58() });
  for (let i = 0; i < 100 && !events.includes("Page.loadEventFired"); i++) await sleep(100);
  if (!(await until(ready, 8000))) {
    // the page now and then boots before the stand-in wallet is injected: connect it the way the button does
    await ev("(async () => { const W = await import('/wallet.js'); const H = await import('/js/hookpool.js'); if (!W.current().publicKey) await W.connect(W.available()[0], H.PublicKey); return true; })()");
    if (!(await until(ready, 15000))) throw new Error("the coin page did not get ready");
  }
  await sleep(700);
}

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
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript });

  // ---- 1. send every coin: eight pieces travel ---------------------------------------------------
  console.log("\n1. send all the coins to a wallet with no ticket");
  await open(holder);
  check(await until("document.querySelectorAll('#colMine .piece.own').length === " + PIECES, 20000), "the page draws the " + PIECES + " pieces");
  await type("#colMine .coin-to", other.publicKey.toBase58());
  await click("#colMine .mine-send .balance button");
  check(await until("/carries/.test((document.querySelector('#colMine .mine-send .earn-line') || {}).innerText || '')", 6000), "the form reads the receiver");
  say("live line", await text("#colMine .mine-send .earn-line"));
  check(/^This transfer carries 8 pieces: (Manys #\d+, ){5}Manys #\d+ and 2 more\. \| This wallet has no ticket for MANY yet\. Send opens it, so the pieces arrive\.$/.test((await text("#colMine .mine-send .earn-line")) || ""), "it names six pieces and counts the other two");
  await ev("document.getElementById('colMine').scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); true"); await sleep(300); await shot("-1-send-all");
  await click("#colMine .send-coins .btn");
  check(await until("/Sent/.test((document.querySelector('#colMine .mine-send .tx-result') || {}).innerText || '') || !!(document.querySelector('#colMine .mine-send .error-text') || {}).innerText", 40000), "the transfer answers");
  await sleep(700);
  say("result", (await text("#colMine .mine-send .tx-result")) || (await text("#colMine .mine-send .error-text")) || (await text("#colMine")));
  let theirs = await ownedOf(other.publicKey);
  check(/^Sent\. \S+ \| This transfer carried 8 pieces: (Manys #\d+, ){5}Manys #\d+ and 2 more\.$/.test((await text("#colMine .mine-send .tx-result")) || ""), "the result stays in view after the last coins left, and names what travelled");
  check(await ev("document.querySelector('#colMine .send-coins').hidden"), "the form itself is gone: there is nothing left to send");
  check(theirs.length === PIECES && (await ownedOf(holder.publicKey)).length === 0, "all " + PIECES + " pieces are in the receiver's list, in one transaction");
  let owners = await Promise.all(theirs.map(coreOwner));
  const delivered = owners.filter((o) => o === other.publicKey.toBase58()).length;
  say("NFTs delivered with the transfer", delivered + " of " + PIECES);
  check(delivered === col.MAX_BURNS_PER_SETTLE, "six NFTs travelled with the transfer, two still show the sender");

  // ---- 2. the receiver delivers the rest ------------------------------------------------------------
  console.log("\n2. the receiver opens the page");
  await open(other);
  check(await until("!!document.querySelector('#colMine .mine-upkeep')", 10000), "the upkeep line shows");
  say("upkeep line", await text("#colMine .mine-upkeep"));
  check((await text("#colMine .mine-upkeep")) === "The NFTs of 2 of your pieces have not reached your wallet yet. | Anyone can send this. It costs a transaction fee. | Deliver", "two deliveries, no burn, the button says Deliver");
  await click("#colMine .mine-upkeep .btn");
  check(await until("!document.querySelector('#colMine .mine-upkeep')", 30000), "the line goes away");
  owners = await Promise.all(theirs.map(coreOwner));
  check(owners.every((o) => o === other.publicKey.toBase58()), "Metaplex shows the receiver as owner of all " + PIECES);

  // ---- 3. sell everything: eight burns in one swap -----------------------------------------------------
  console.log("\n3. sell everything");
  await click("#tradeCard .seg [data-dir=sell]");
  await click("#tradeCard .balance button");
  const cost = await text("#tradeCard .earn-line.cost");
  say("sell form", cost);
  check(/^This sell burns 8 pieces: (Manys #\d+, ){5}Manys #\d+ and 2 more\. \| All 8 leave your list in the sell\. The NFTs of 2 burn right after\.$/.test(cost || ""), "the sell form says all eight leave the list and two NFTs burn after");
  await ev("document.getElementById('tradeCard').scrollIntoView({ block: 'center' }); true"); await sleep(300); await shot("-3-sell-all");
  await click("#tradeCard .btn-sell");
  check(await until("/Sold/.test((document.querySelector('#tradeCard .tx-result') || {}).innerText || '') || !!document.querySelector('#tradeCard .tx-result .bad')", 40000), "the sell answers");
  await sleep(900);
  say("trade result", await text("#tradeCard .tx-result"));
  theirs = await ownedOf(other.publicKey);
  const queue = await col.fetchQueue(conn, pool);
  check(theirs.length === 0, "the list is empty: every piece left it inside the swap");
  check(queue.length === PIECES - col.MAX_BURNS_PER_SETTLE, "the burn queue holds " + queue.length + " pieces whose NFT still exists");
  check((await col.fetchCollectionConfig(conn, pool)).live === 0, "no piece exists any more by the on-chain counter");
  check(await until("!!document.querySelector('#colMine .mine-upkeep')", 10000), "the upkeep line shows");
  say("upkeep line", await text("#colMine .mine-upkeep"));
  check((await text("#colMine .mine-upkeep")) === "The NFTs of 2 burned pieces still exist. | Anyone can send this. It costs a transaction fee. Burning pays the sender the rent. | Burn", "two burns, the button says Burn");
  await ev("document.getElementById('colMine').scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); true"); await sleep(300); await shot("-3-burn-line");
  const before = await conn.getBalance(other.publicKey);
  await click("#colMine .mine-upkeep .btn");
  check(await until("!document.querySelector('#colMine .mine-upkeep')", 30000), "the line goes away");
  check((await col.fetchQueue(conn, pool)).length === 0 && (await Promise.all(queue.map(burned))).every(Boolean), "the queue is empty and both NFTs are burned");
  say("sender SOL change", ((await conn.getBalance(other.publicKey)) - before) / LAMPORTS_PER_SOL + " (rent of two NFTs minus the fee)");
  say("your pieces now", await text("#colMine"));

  console.log("\npage errors: " + (pageErrors.length ? "\n" + pageErrors.join("\n") : "none"));
  console.log(failed ? failed + " CHECK(S) FAILED" : "all checks passed");
  if (failed) process.exitCode = 1;
  ws.close();
} catch (e) {
  console.error("flow failed: " + e.message);
  if (pageErrors.length) console.error(pageErrors.join("\n"));
  try { await shot("-failure"); } catch (_) {}
  process.exitCode = 1;
} finally {
  console.log(await edge.close());
  // give the pool its coins back if a step failed half way
  for (const kp of [holder, other]) {
    try {
      const amount = await coinsOf(kp.publicKey);
      if (amount > 0n) { const p = await client.pool(pool); await send(await client.swapInstructions(kp.publicKey, p, await client.hookRef(p, kp.publicKey), DIRECTION.SELL, amount, 0n), [kp]); }
    } catch (e) { console.error("  could not sell back: " + e.message); }
  }
  try { for (const tx of await client.collectibleUpkeepInstructions(dev.publicKey, pool)) await send(tx, [dev]); } catch (_) {}
  const p = await client.pool(pool);
  console.log("pool " + pool.toBase58() + " now " + whole(p.reserveBase) + " coins and " + (Number(p.reserveQuote) / LAMPORTS_PER_SOL).toFixed(4) + " SOL, burn queue " + (await col.fetchQueue(conn, pool)).length + ".");
}
