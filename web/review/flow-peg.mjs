// Review tool: the peg on the coin page, end to end, in headless Edge with real mouse input,
// signed by throwaway wallets made here (localnet only, airdropped, never written to disk).
// Buy, watch the pieces arrive in list order, read what a sell would burn, reorder, sell,
// send a piece with its coins, leave a wallet above the peg, and sell waiting pieces away.
// Every step prints what the page showed next to what the chain holds.
//   node web/review/flow-peg.mjs <site origin> <pool | new> <out prefix> [width] [height]
// "new" launches a coin of its own for the run (2 SOL seed, 50,000,000 coins per piece) and
// prints its pool, so the flow can be repeated on that pool without touching anyone else's.
// The buy takes about half of a small pool, and the throwaway wallets sell back what they hold
// when the run ends, also after a failure. Do not point it at a pool other people are testing on.
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, NATIVE_MINT, TOKEN_PROGRAM, collectible as col } from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";

const [origin, poolArg, prefix, w = "1440", h = "1500"] = process.argv.slice(2);
if (!origin || !poolArg || !prefix) { console.error("usage: node web/review/flow-peg.mjs <origin> <pool | new> <out prefix> [width] [height]"); process.exit(1); }
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = poolArg === "new" ? await launchCoin() : new PublicKey(poolArg);

/// A collectible coin for this flow alone: a throwaway dev, no first buy, the dev key is dropped.
async function launchCoin() {
  const dev = Keypair.generate(), mint = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(dev.publicKey, 4 * LAMPORTS_PER_SOL), "confirmed");
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name: "Peg Flow Coin", symbol: "PEGF", uri: origin + "/package.json?coin=peg-flow", decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: BigInt(2 * LAMPORTS_PER_SOL), devBuyQuote: 0n, minDevBuyOut: 1n,
    template: "collectible",
    collectible: { name: "Pegs", uriBase: origin + "/art", unit: 50_000_000n * 1_000_000n, maxSupply: 1000, maxPerBuy: 3, art: Uint8Array.from([1, 20, 235, 30, 24, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
  });
  for (const [ixs, signers] of [[plan.createTx, [dev, mint]], [plan.launchTx, [dev]]]) {
    const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(dev.publicKey, ixs);
    tx.sign(signers);
    const res = await conn.confirmTransaction({ signature: await conn.sendTransaction(tx), blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error("launch failed: " + JSON.stringify(res.value.err));
  }
  console.log("launched a coin for this flow, pool " + plan.pool.toBase58());
  return plan.pool;
}
const say = (label, value) => console.log(label.padEnd(34) + (typeof value === "string" ? value : JSON.stringify(value)));
let failed = 0;
const check = (ok, text) => { if (!ok) failed++; console.log((ok ? "  ok    " : "  FAIL  ") + text); };

const fund = async (kp, sol) => conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
async function sendNode(ixs, signers) {
  const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx);
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error("node transaction failed: " + JSON.stringify(res.value.err));
  return sig;
}
/// A burned piece keeps its address with one zero byte.
const burned = async (address) => { const a = await conn.getAccountInfo(address); return !!a && a.data.length === 1 && a.data[0] === 0; };
const coinsOf = (wallet, cfg) => client.tokenBalance(wallet, cfg.baseMint, cfg.tokenProgram);
const whole = (raw, dec = 6) => { const s = raw.toString().padStart(dec + 1, "0"); return s.slice(0, -dec) + "." + s.slice(-dec); };
function plainTransfer(from, to, owner, amount) {
  const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data });
}

/// SOL (two decimals) that buys a little more than `units` units of coins at the pool's price now.
async function solFor(units) {
  const p = await client.pool(pool);
  const target = Number(unit) * (units + 0.25);
  const net = (Number(p.reserveQuote) * target) / (Number(p.reserveBase) - target);
  return (Math.ceil(net / 0.985 / 1e7) / 100).toFixed(2);
}

/// Give the pool its coins back: sell everything a throwaway wallet still holds.
async function sellBack(kp) {
  try {
    const c = await col.fetchCollectionConfig(conn, pool);
    const amount = await coinsOf(kp.publicKey, c);
    if (amount <= 0n) return 0n;
    if ((await conn.getBalance(kp.publicKey)) < 0.02 * LAMPORTS_PER_SOL) await fund(kp, 0.1);
    const p = await client.pool(pool);
    await sendNode(await client.swapInstructions(kp.publicKey, p, await client.hookRef(p, kp.publicKey), DIRECTION.SELL, amount, 0n), [kp]);
    return amount;
  } catch (e) { console.error("  could not sell back for " + kp.publicKey.toBase58() + ": " + e.message); return 0n; }
}

const holder = Keypair.generate(), friend = Keypair.generate(), stranger = Keypair.generate(), waiter = Keypair.generate();
await Promise.all([fund(holder, 12), fund(stranger, 1), fund(waiter, 8)]);
say("holder wallet", holder.publicKey.toBase58());
say("friend wallet (never funded)", friend.publicKey.toBase58());
let cfg = await col.fetchCollectionConfig(conn, pool);
const unit = cfg.unit;
say("collection", { name: cfg.name, unitCoins: whole(unit), maxSupply: cfg.maxSupply, live: cfg.live, minted: cfg.minted });

// the browser of this run: no extensions, a profile of its own, closed through its DevTools port (edge.mjs)
const edge = await startEdge({ name: "peg", width: Number(w), height: Number(h) });
let id = 0; const pending = new Map(); const events = []; const pageErrors = [];
let ws;
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
const shot = async (name) => { const s = await call("Page.captureScreenshot", { format: "png" }); writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64")); console.log("  wrote " + prefix + name + ".png"); };
const until = async (expression, ms = 30000, step = 150) => { for (let t = 0; t < ms; t += step) { if (await ev(expression)) return true; await sleep(step); } return false; };
const mouse = (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
/// A real click in the middle of an element, after bringing it into view.
async function click(selector) {
  const at = () => ev("(() => { const e = document.querySelector(" + JSON.stringify(selector) + "); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width, b.height]; })()");
  if (!(await at())) throw new Error("nothing matches " + selector);
  await ev("document.querySelector(" + JSON.stringify(selector) + ").scrollIntoView({ block: 'center' }); true");
  await sleep(120);
  const [x, y] = await at();
  const top = await ev("(() => { const e = document.elementFromPoint(" + x + ", " + y + "); const want = document.querySelector(" + JSON.stringify(selector) + "); return !!e && (e === want || want.contains(e)); })()");
  if (!top) throw new Error("something covers " + selector);
  await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y);
}
/// Click a field, clear it, type into it the way a keyboard would.
async function type(selector, text) {
  await click(selector);
  await ev("(() => { const e = document.querySelector(" + JSON.stringify(selector) + "); e.select(); return true; })()");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  if (text) await call("Input.insertText", { text });
  await sleep(350);
}
const walletScript = (kp) => `
  localStorage.setItem("Programmable.wallet", "phantom");
  (() => {
    // one script for the whole run: a later wallet is handed over through localStorage, because
    // swapping the script between two navigations now and then left the page without a wallet
    let who = ${JSON.stringify({ secret: Array.from(kp.secretKey), address: kp.publicKey.toBase58() })};
    try { const s = localStorage.getItem("__standin"); if (s) who = JSON.parse(s); } catch (_) {}
    const SECRET = who.secret;
    const ADDRESS = who.address;
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
async function open(kp) {
  if (!walletScriptId) walletScriptId = (await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript(kp) })).identifier;
  else await ev("localStorage.setItem(\"__standin\", " + JSON.stringify(JSON.stringify({ secret: Array.from(kp.secretKey), address: kp.publicKey.toBase58() })) + "); true");
  events.length = 0;
  await call("Page.navigate", { url: origin + "/coin.html?pool=" + pool.toBase58() });
  for (let i = 0; i < 100 && !events.includes("Page.loadEventFired"); i++) await sleep(100);
  const ready = "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on') && !!document.querySelector('#colMine .card-head')";
  if (!(await until(ready, 12000))) {
    // seen once in many runs: the page came up without the stand-in wallet. Say what it had, try once more.
    console.error("  page state: " + (await ev("JSON.stringify({ url: location.href, phantom: !!window.phantom, stored: localStorage.getItem('Programmable.wallet'), walletBtn: (document.querySelector('#walletBtn') || {}).className })")));
    console.error("  wallet module: " + (await ev("(async () => { try { const W = await import('/wallet.js'); const H = await import('/js/hookpool.js'); const out = { connected: !!W.current().publicKey, available: W.available().map((w) => w.id), hidden: document.hidden, title: document.title, head: (document.getElementById('head') || {}).innerText }; try { await W.connect(W.available()[0], H.PublicKey); out.connectNow = 'ok ' + W.current().publicKey.toBase58().slice(0, 4); } catch (e) { out.connectNow = 'threw ' + e.message; } return JSON.stringify(out).slice(0, 600); } catch (e) { return 'diag failed ' + e.message; } })()")));
    events.length = 0;
    await call("Page.reload");
    for (let i = 0; i < 100 && !events.includes("Page.loadEventFired"); i++) await sleep(100);
    if (!(await until(ready, 20000))) throw new Error("the coin page did not get ready");
  }
  await sleep(700);
}
// what the page shows
const list = () => ev("JSON.stringify([...document.querySelectorAll('#colMine .piece.own')].map((t) => ({ pos: t.querySelector('.pos').innerText, name: t.querySelector('.n').innerText, mark: t.querySelector('.ribbon').hidden ? '' : t.querySelector('.ribbon').innerText, burns: t.classList.contains('burns'), picked: t.getAttribute('aria-pressed') === 'true', addr: t.dataset.addr })))").then(JSON.parse);
const names = (l) => l.map((t) => t.pos + " " + t.name + (t.mark ? " [" + t.mark + "]" : "")).join(", ");
const text = (selector) => ev("(() => { const e = document.querySelector(" + JSON.stringify(selector) + "); return e ? e.innerText.replace(/\\n+/g, ' | ') : null; })()");
const overflow = () => ev("document.documentElement.scrollWidth + ' of ' + window.innerWidth");
const view = async (width, height, scheme) => {
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await sleep(500);
};
const scrollTo = (selector) => ev("(() => { document.querySelector(" + JSON.stringify(selector) + ").scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); return true; })()");

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
  await view(Number(w), Number(h), "dark");

  // ---- 1. buy: the pieces arrive in list order ------------------------------------------------
  const buySol = await solFor(3);
  console.log("\n1. buy " + buySol + " SOL through the page (enough for three pieces)");
  await open(holder);
  say("before the buy", await text("#colMine"));
  await type("#amount", buySol);
  say("earn line", await text("#tradeCard .earn-line"));
  await click("#tradeCard .btn-buy");
  check(await until("document.querySelectorAll('#colMine .piece.blank').length > 0", 20000, 60), "blank tiles show while the block decides");
  say("while deciding", await text("#colMine .mine-status"));
  check(await until("document.querySelectorAll('#colMine .piece.own').length === 3 && document.querySelectorAll('#colMine .piece.blank').length === 0", 40000), "three pieces minted and drawn");
  await sleep(600);
  let page = await list();
  let ticket = await col.fetchTicket(conn, pool, holder.publicKey);
  let chain = await col.fetchOwnedPieces(conn, pool, holder.publicKey);
  say("page list", names(page));
  say("chain list", chain.map((p, i) => (i + 1) + " " + p.name).join(", "));
  check(page.length === 3 && page.every((t, i) => t.addr === ticket.owned[i].toBase58() && t.pos === String(i + 1)), "the page shows the wallet's list in its on-chain order, numbered");
  check(page[2].mark === "burns first" && !page[0].mark && !page[1].mark, "only the last piece is marked: burns first");
  say("status line", await text("#colMine .mine-peg"));
  say("hint", await text("#colMine > .help"));
  say("wallet prompts so far", await ev("window.__signPrompts"));
  await scrollTo("#colMine"); await shot("-1-after-buy");

  // ---- 2. the sell form names what a sell costs ------------------------------------------------
  console.log("\n2. sell form, live");
  let balance = await coinsOf(holder.publicKey, cfg);
  say("holder coins", whole(balance));
  await click("#tradeCard .seg [data-dir=sell]");
  const lines = {};
  for (const [label, amount] of [["leaves 3 units", balance - 3n * unit], ["leaves 2 units and 1 coin", balance - 2n * unit - 1_000_000n], ["leaves 1 unit", balance - unit], ["everything", balance]]) {
    await type("#amount", whole(amount));
    lines[label] = await text("#tradeCard .earn-line.cost");
    say("sell " + whole(amount) + " (" + label + ")", lines[label] || "(nothing shown)");
  }
  check(!lines["leaves 3 units"], "a sell that keeps three units shows nothing");
  check(lines["leaves 2 units and 1 coin"] === "This sell burns 1 piece: " + page[2].name + ".", "one piece named: the last of the list");
  check(lines["leaves 1 unit"] === "This sell burns 2 pieces: " + page[2].name + ", " + page[1].name + ".", "two pieces named, last first");
  check(lines["everything"] === "This sell burns 3 pieces: " + page[2].name + ", " + page[1].name + ", " + page[0].name + ".", "selling everything names all three");
  const sellAmount = balance - 2n * unit - 1_000_000n;
  await type("#amount", whole(sellAmount));
  page = await list();
  check(page[2].burns && page[2].mark === "burns" && !page[0].burns && !page[1].burns, "the tile of that piece is marked on the list while the amount is typed");

  // ---- 3. reorder: the wallet chooses what burns -----------------------------------------------
  console.log("\n3. reorder");
  const moved = page[0];
  await click("#colMine .piece.own[data-addr='" + moved.addr + "']");
  check(await until("!!document.querySelector('#colMine .piece-panel')", 3000), "picking a piece opens its panel");
  say("panel", await text("#colMine .piece-panel"));
  say("Move first / Move last disabled", await ev("JSON.stringify([...document.querySelectorAll('#colMine .pp-row .btn')].map((b) => b.innerText + ': ' + b.disabled))"));
  const promptsBefore = await ev("window.__signPrompts");
  await scrollTo("#colMine"); await shot("-2-panel-open");
  await click("#colMine .pp-row .btn:nth-child(2)");
  check(await until("(() => { const t = [...document.querySelectorAll('#colMine .piece.own')]; return t.length === 3 && t[2].dataset.addr === '" + moved.addr + "'; })()", 20000), "Move last puts the piece at the end of the list");
  await sleep(500);
  say("signatures for the move", (await ev("window.__signPrompts")) - promptsBefore);
  page = await list();
  ticket = await col.fetchTicket(conn, pool, holder.publicKey);
  say("page list", names(page));
  check(page.every((t, i) => t.addr === ticket.owned[i].toBase58()), "the chain list has the same new order");
  const costAfter = await text("#tradeCard .earn-line.cost");
  say("sell line after the move", costAfter);
  check(costAfter === "This sell burns 1 piece: " + moved.name + ".", "the sell form now names the piece that was moved last");

  // ---- screenshots of this state at every width -------------------------------------------------
  console.log("\nscreenshots");
  await ev("(() => { for (const t of document.querySelectorAll('#toasts .toast')) t.click(); return true; })()"); // a click dismisses a toast
  await sleep(400);
  for (const [width, height, scheme, tag] of [[375, 900, "dark", "375"], [768, 1100, "dark", "768"], [1024, 1300, "dark", "1024"], [1440, 1300, "dark", "1440"], [1440, 1300, "light", "1440-light"]]) {
    await view(width, height, scheme);
    await scrollTo("#colMine"); await sleep(250); await shot("-coin-" + tag);
    say("page width at " + tag, await overflow());
    if (width < 1024) { await scrollTo("#tradeCard"); await sleep(250); await shot("-coin-" + tag + "-trade"); }
  }
  await view(Number(w), Number(h), "dark");

  // ---- 4. the sell burns exactly that piece -----------------------------------------------------
  console.log("\n4. sell");
  const liveBefore = (await col.fetchCollectionConfig(conn, pool)).live;
  await click("#tradeCard .btn-sell");
  check(await until("/Sold/.test((document.querySelector('#tradeCard .tx-result') || {}).innerText || '') && document.querySelectorAll('#colMine .piece.own').length === 2", 30000), "the sell confirms and the list drops to two");
  await sleep(600);
  say("trade result", await text("#tradeCard .tx-result"));
  page = await list();
  say("page list", names(page));
  ticket = await col.fetchTicket(conn, pool, holder.publicKey);
  cfg = await col.fetchCollectionConfig(conn, pool);
  check(await burned(new PublicKey(moved.addr)), moved.name + " is burned on chain");
  check(ticket.owned.length === 2 && page.every((t, i) => t.addr === ticket.owned[i].toBase58()) && !(await burned(ticket.owned[0])) && !(await burned(ticket.owned[1])), "the two pieces kept in front are untouched");
  check(cfg.live === liveBefore - 1, "pieces that exist now went from " + liveBefore + " to " + cfg.live + " (ever minted " + cfg.minted + ")");
  say("status line", await text("#colMine .mine-peg"));
  say("hook card counts", await ev("[...document.querySelectorAll('#hookCard .params dt')].slice(0, 2).map((d) => d.innerText + ' ' + d.nextElementSibling.innerText).join(', ')"));
  balance = await coinsOf(holder.publicKey, cfg);
  say("holder coins", whole(balance));
  await scrollTo("#colMine"); await shot("-3-after-sell");

  // ---- 5. send a piece with its coins -------------------------------------------------------------
  console.log("\n5. send");
  const sent = page[0];
  await click("#colMine .piece.own[data-addr='" + sent.addr + "']");
  await until("!!document.querySelector('#colMine .send-to')", 3000);
  await type("#colMine .send-to", "not an address");
  await click("#colMine .send-row .btn");
  say("bad address", await text("#colMine .piece-panel .error-text"));
  await type("#colMine .send-to", holder.publicKey.toBase58());
  await click("#colMine .send-row .btn");
  say("own address", await text("#colMine .piece-panel .error-text"));
  await type("#colMine .send-to", friend.publicKey.toBase58());
  await scrollTo("#colMine"); await shot("-4-send-form");
  await click("#colMine .send-row .btn");
  check(await until("document.querySelectorAll('#colMine .piece.own').length === 1", 30000), "the piece leaves the sender's list");
  await sleep(600);
  say("toasts", await text("#toasts"));
  page = await list();
  say("page list", names(page));
  const friendTicket = await col.fetchTicket(conn, pool, friend.publicKey);
  const friendPieces = await col.fetchOwnedPieces(conn, pool, friend.publicKey);
  const after = await coinsOf(holder.publicKey, cfg);
  check(!!friendTicket && friendTicket.owned.length === 1 && friendTicket.owned[0].toBase58() === sent.addr, "the friend's list holds " + sent.name);
  check(friendPieces[0].owner.equals(friend.publicKey), "Metaplex Core shows the friend as its owner");
  check((await coinsOf(friend.publicKey, cfg)) === unit && after === balance - unit, "one unit of coins moved with it: friend " + whole(await coinsOf(friend.publicKey, cfg)) + ", holder " + whole(balance) + " to " + whole(after));
  say("status line", await text("#colMine .mine-peg"));

  // ---- 6. coins leave another way: the wallet is above the peg -------------------------------------
  console.log("\n6. above the peg");
  // two more pieces first (bought and minted through the SDK), so the wallet holds three again
  {
    const p = await client.pool(pool);
    const buyIn = BigInt(Math.round(Number(await solFor(2)) * LAMPORTS_PER_SOL));
    await sendNode(await client.swapInstructions(holder.publicKey, p, await client.hookRef(p, holder.publicKey), DIRECTION.BUY, buyIn, 1n), [holder]);
    const t = await col.fetchTicket(conn, pool, holder.publicKey);
    const target = t.batches.reduce((m, b) => (b.pieces > 0 && b.targetSlot > m ? b.targetSlot : m), 0n);
    while (BigInt(await conn.getSlot("confirmed")) <= target + 1n) await sleep(400);
    await sendNode(await client.collectibleMintInstructions(holder.publicKey, pool), [holder]);
  }
  ticket = await col.fetchTicket(conn, pool, holder.publicKey);
  const holds = await coinsOf(holder.publicKey, cfg);
  say("holder before the transfer", { pieces: ticket.owned.length, coins: whole(holds) });
  const leave = 60_000_000n * 1_000_000n; // 60,000,000 coins stay: they back one piece of three
  await sendNode([plainTransfer(col.coinsAddress(holder.publicKey, cfg.baseMint, cfg.tokenProgram), col.coinsAddress(friend.publicKey, cfg.baseMint, cfg.tokenProgram), holder.publicKey, holds - leave)], [holder]);
  await open(holder);
  const over = await text("#colMine .mine-peg");
  say("status line", over);
  check(/^You hold 3 pieces\. Your coins back 1\. Anyone can burn the extra 2, from the end of your list\. Buy 90,000,000 \w+ and you keep them\.$/.test(over || ""), "the page says two pieces are above the peg and what keeps them");
  page = await list();
  say("page list", names(page));
  check(page.length === 3 && !page[0].burns && page[1].burns && page[2].burns, "the two pieces at the end of the list are marked");
  await click("#colMine .piece.own[data-addr='" + page[0].addr + "']");
  await until("!!document.querySelector('#colMine .piece-panel')", 3000);
  say("panel", await text("#colMine .piece-panel"));
  const locks = await ev("JSON.stringify([...document.querySelectorAll('#colMine .pp-row .btn, #colMine .send-row .btn')].map((b) => b.innerText + ': ' + b.disabled))");
  say("Move first / Move last / Send disabled", locks);
  check(locks === JSON.stringify(["Move first: true", "Move last: true", "Send: true"]), "the reorder buttons and Send keep their verbs and are disabled above the peg");
  check((await text("#colMine .piece-panel .lock")) === "You hold more pieces than your coins back, so moving and sending are locked. Buy the coins back, or the extra pieces burn.", "the panel says why and what to do");
  await scrollTo("#colMine"); await sleep(400); await shot("-5-above-peg"); // let the panel finish fading in
  // the program itself refuses a reorder and a send in this state
  const refused = async (ixs) => {
    try { await sendNode(ixs, [holder]); return "it went through"; }
    catch (e) { const logs = e.logs || (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => []) : []); const all = (logs || []).join(" ") + " " + e.message; return (/Error Message: ([^.]+)/.exec(all) || [])[1] || all.slice(0, 160); }
  };
  const noMove = await refused(await client.collectibleReorderInstructions(holder.publicKey, pool, 0, 2));
  check(/holds more pieces than its coins back/.test(noMove), "the program refuses a reorder above the peg: " + noMove);
  const noSend = await refused(await client.collectibleSendInstructions(holder.publicKey, pool, friend.publicKey, [new PublicKey(page[0].addr)]));
  check(/holds more pieces than its coins back/.test(noSend), "the program refuses a send above the peg: " + noSend);
  const settleIxs = await client.collectibleSettleInstructions(stranger.publicKey, pool, holder.publicKey);
  if (settleIxs.length) { await sendNode(settleIxs, [stranger]); say("settle", "sent by a stranger"); } else say("settle", "already done by someone else");
  await call("Page.bringToFront").catch(() => {});
  check(await until("document.querySelectorAll('#colMine .piece.own').length === 1", 45000, 500), "the page notices the burn on its own, without a reload");
  page = await list();
  say("page list", names(page));
  say("status line", await text("#colMine .mine-peg"));
  check(await until("!document.querySelector('#colMine .piece-panel .lock')", 3000), "the lock is gone once the wallet is backed again");
  say("Send disabled now", await ev("(() => { const b = document.querySelector('#colMine .send-row .btn'); return b ? String(b.disabled) : 'panel closed'; })()"));

  // ---- 7. waiting pieces are dropped first ---------------------------------------------------------
  console.log("\n7. waiting pieces");
  const p = await client.pool(pool);
  const buyIn = BigInt(Math.round(Number(await solFor(2)) * LAMPORTS_PER_SOL));
  const q = await client.quoteOnChain(waiter.publicKey, p, DIRECTION.BUY, buyIn);
  await sendNode(await client.swapInstructions(waiter.publicKey, p, await client.hookRef(p, waiter.publicKey), DIRECTION.BUY, buyIn, q), [waiter]);
  let wt = await col.fetchTicket(conn, pool, waiter.publicKey);
  say("bought without minting", { coins: whole(q), waiting: wt.pending });
  await open(waiter);
  await until("document.querySelectorAll('#colMine .piece.blank').length > 0", 8000);
  say("your pieces", await text("#colMine"));
  await click("#tradeCard .seg [data-dir=sell]");
  await type("#amount", whole(q));
  const dropLine = await text("#tradeCard .earn-line.cost");
  say("sell everything", dropLine);
  check(dropLine === "This sell drops " + wt.pending + " waiting piece" + (wt.pending === 1 ? "" : "s") + ".", "the sell form says the waiting pieces go");
  await scrollTo("#colMine"); await shot("-6-waiting");
  await click("#tradeCard .btn-sell");
  check(await until("/Sold/.test((document.querySelector('#tradeCard .tx-result') || {}).innerText || '')", 30000), "the sell confirms");
  await sleep(800);
  wt = await col.fetchTicket(conn, pool, waiter.publicKey);
  check(wt.pending === 0 && wt.owned.length === 0, "the ticket holds no waiting piece after the sell");
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
  let back = 0n;
  for (const kp of [holder, friend, waiter]) back += await sellBack(kp);
  const p = await client.pool(pool);
  console.log("sold back " + whole(back) + " coins. Pool now " + whole(p.reserveBase) + " coins and " + (Number(p.reserveQuote) / LAMPORTS_PER_SOL).toFixed(4) + " SOL.");
}
