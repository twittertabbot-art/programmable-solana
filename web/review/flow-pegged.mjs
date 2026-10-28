// Review tool: the pegged coin on the site, end to end, in headless Edge with real mouse input,
// signed by throwaway wallets made here (localnet only, airdropped, never written to disk).
// Launch through the launch page with the pegged choice, buy, read what a transfer of coins does
// to the pieces, send coins to a wallet with a ticket and to one without, sell, send one chosen
// piece, deliver and burn what a transfer made outside the site left behind, leave a wallet above
// the peg, add and remove liquidity. Every step prints what the page showed next to the chain.
//   node web/review/flow-pegged.mjs <site origin> <pool | new | plain> <out prefix> [width] [height]
// "new" launches a pegged coin of its own through the launch page and runs the whole flow on it.
// "plain" only launches a plain collectible coin through the launch page and prints its pool, for
// flow-peg.mjs. A pool address repeats the flow on a pegged coin an earlier run launched.
// The throwaway wallets sell back what they hold when the run ends, also after a failure.
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, collectible as col, ix } from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";

const [origin, poolArg, prefix, w = "1440", h = "1500"] = process.argv.slice(2);
if (!origin || !poolArg || !prefix) { console.error("usage: node web/review/flow-pegged.mjs <origin> <pool | new | plain> <out prefix> [width] [height]"); process.exit(1); }
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (label, value) => console.log(label.padEnd(36) + (typeof value === "string" ? value : JSON.stringify(value)));
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
const whole = (raw, dec = 6) => { const s = raw.toString().padStart(dec + 1, "0"); return s.slice(0, -dec) + "." + s.slice(-dec); };
/// A burned piece keeps its address with one zero byte.
const burned = async (address) => { const a = await conn.getAccountInfo(address); return !!a && a.data.length === 1 && a.data[0] === 0; };
/// The wallet Metaplex Core shows as the owner of a piece.
const coreOwner = async (asset) => { const a = await conn.getAccountInfo(asset); return a && a.data[0] === 1 ? col.decodePiece(asset, new Uint8Array(a.data)).owner.toBase58() : null; };

let pool = poolArg === "new" || poolArg === "plain" ? null : new PublicKey(poolArg);
let cfg = null, unit = 0n;
const coinsOf = (wallet) => client.tokenBalance(wallet, cfg.baseMint, cfg.tokenProgram);
const ownedOf = async (wallet) => { const t = await col.fetchTicket(conn, pool, wallet); return t ? t.owned.map((k) => k.toBase58()) : []; };
/// SOL (two decimals) that buys a little more than `units` units of coins at the pool's price now.
async function solFor(units) {
  const p = await client.pool(pool);
  const target = Number(unit) * (units + 0.25);
  const net = (Number(p.reserveQuote) * target) / (Number(p.reserveBase) - target);
  return (Math.ceil(net / 0.985 / 1e7) / 100).toFixed(2);
}
/// Buy and mint through the SDK, for the steps that are not about buying.
async function buyNode(kp, units) {
  const p = await client.pool(pool);
  const buyIn = BigInt(Math.round(Number(await solFor(units)) * LAMPORTS_PER_SOL));
  await sendNode(await client.swapInstructions(kp.publicKey, p, await client.hookRef(p, kp.publicKey), DIRECTION.BUY, buyIn, 1n), [kp]);
  const t = await col.fetchTicket(conn, pool, kp.publicKey);
  const target = t.batches.reduce((m, b) => (b.pieces > 0 && b.targetSlot > m ? b.targetSlot : m), 0n);
  if (t.pending === 0) return;
  while (BigInt(await conn.getSlot("confirmed")) <= target + 1n) await sleep(400);
  await sendNode(await client.collectibleMintInstructions(kp.publicKey, pool), [kp]);
}
/// Give the pool its coins back: sell everything a throwaway wallet still holds.
async function sellBack(kp) {
  try {
    if (!pool || !cfg) return 0n;
    const amount = await coinsOf(kp.publicKey);
    if (amount <= 0n) return 0n;
    if ((await conn.getBalance(kp.publicKey)) < 0.02 * LAMPORTS_PER_SOL) await fund(kp, 0.1);
    const p = await client.pool(pool);
    await sendNode(await client.swapInstructions(kp.publicKey, p, await client.hookRef(p, kp.publicKey), DIRECTION.SELL, amount, 0n), [kp]);
    return amount;
  } catch (e) { console.error("  could not sell back for " + kp.publicKey.toBase58() + ": " + e.message); return 0n; }
}
/// Token-2022 Burn: coins destroyed by their holder. No transfer happens, so the coin's hook does not run.
function burnCoins(owner, mint, amount) {
  const data = Buffer.alloc(9); data[0] = 8; data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: TOKEN_2022_PROGRAM, keys: [{ pubkey: col.coinsAddress(owner, mint, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data });
}

const dev = Keypair.generate(), holder = Keypair.generate(), friend = Keypair.generate(), fresh = Keypair.generate(), outsider = Keypair.generate(), stranger = Keypair.generate();
await Promise.all([fund(dev, 5), fund(holder, 14), fund(friend, 3), fund(stranger, 2), fund(outsider, 1)]);
say("dev wallet (launches)", dev.publicKey.toBase58());
say("holder wallet", holder.publicKey.toBase58());
say("friend wallet (will hold a ticket)", friend.publicKey.toBase58());
say("fresh wallet (never funded)", fresh.publicKey.toBase58());

// the browser of this run: no extensions, a profile of its own, closed through its DevTools port (edge.mjs)
const edge = await startEdge({ name: "pegged", width: Number(w), height: Number(h) });
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
/// Open a page of the site as one of the throwaway wallets and wait until `ready` holds.
async function open(kp, path, ready) {
  if (!walletScriptId) walletScriptId = (await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript(kp) })).identifier;
  else await ev("localStorage.setItem(\"__standin\", " + JSON.stringify(standin(kp)) + "); true");
  for (let attempt = 0; attempt < 2; attempt++) {
    events.length = 0;
    await call("Page.navigate", { url: origin + path });
    for (let i = 0; i < 100 && !events.includes("Page.loadEventFired"); i++) await sleep(100);
    if (await until(ready, 8000)) { await sleep(700); return; }
    // seen in about one run in ten: the page boots before the stand-in wallet is injected, so the
    // silent reconnect finds no wallet. Connect it the way the Connect wallet button does.
    if (!(await ev("!!document.querySelector('#walletBtn.on')"))) {
      const how = await ev("(async () => { try { const W = await import('/wallet.js'); const H = await import('/js/hookpool.js'); if (!W.available().length) return 'no wallet in the page'; await W.connect(W.available()[0], H.PublicKey); return 'connected by hand'; } catch (e) { return 'connect threw ' + e.message; } })()");
      console.error("  the stand-in wallet was not restored on " + path.split("?")[0] + ": " + how);
      if (await until(ready, 12000)) { await sleep(700); return; }
    }
    console.error("  page not ready, trying once more: " + (await ev("(async () => { const W = await import('/wallet.js'); return JSON.stringify({ url: location.pathname, phantom: !!window.phantom, standin: (window.__who || '').slice(0, 6), stored: localStorage.getItem('Programmable.wallet'), walletBtn: (document.querySelector('#walletBtn') || {}).className, connected: !!W.current().publicKey, hidden: document.hidden, ready: [!!document.querySelector('#tradeCard .btn-buy'), !!document.querySelector('#colMine .card-head')] }); })()")));
  }
  throw new Error("the page did not get ready: " + path);
}
const coinReady = "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on') && !!document.querySelector('#colMine .card-head')";
const openCoin = (kp) => open(kp, "/coin.html?pool=" + pool.toBase58(), coinReady);
// what the page shows
const list = () => ev("JSON.stringify([...document.querySelectorAll('#colMine .piece.own')].map((t) => ({ pos: t.querySelector('.pos').innerText, name: t.querySelector('.n').innerText, mark: t.querySelector('.ribbon').hidden ? '' : t.querySelector('.ribbon').innerText, burns: t.classList.contains('burns'), addr: t.dataset.addr })))").then(JSON.parse);
const names = (l) => l.map((t) => t.pos + " " + t.name + (t.mark ? " [" + t.mark + "]" : "")).join(", ");
const text = (selector) => ev("(() => { const e = document.querySelector(" + JSON.stringify(selector) + "); return e ? e.innerText.replace(/\\n+/g, ' | ') : null; })()");
const overflow = () => ev("document.documentElement.scrollWidth + ' of ' + window.innerWidth");
const fits = async () => { const [a, b] = (await overflow()).split(" of ").map(Number); return a <= b; };
const view = async (width, height, scheme) => {
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await sleep(500);
};
const scrollTo = (selector) => ev("(() => { document.querySelector(" + JSON.stringify(selector) + ").scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); return true; })()");
const clearToasts = async () => { await ev("(() => { for (const t of document.querySelectorAll('#toasts .toast')) t.click(); return true; })()"); await sleep(350); };
const VIEWS = [[375, 900, "dark", "375"], [768, 1100, "dark", "768"], [1024, 1300, "dark", "1024"], [1440, 1300, "dark", "1440"], [1440, 1300, "light", "1440-light"]];
const sendLines = async () => ({ carry: await text("#colMine .mine-send .earn-line:not(.cost)"), cost: await text("#colMine .mine-send .earn-line.cost"), err: await text("#colMine .mine-send .error-text"), res: await text("#colMine .mine-send .tx-result") });

/// Launch a collectible coin through the Collectible page, as the dev wallet. Returns the pool.
async function launchThroughPage(kind, symbol, firstBuy) {
  await open(dev, "/launch-collectible.html", "!!document.querySelector('#walletBtn.on') && !!document.querySelector('#launchBtn') && !!document.querySelector('#colArt .piece-strip')");
  await type("#name", kind === "pegged" ? "Pegged Flow Coin" : "Plain Flow Coin");
  await type("#symbol", symbol);
  await type("#devBuy", firstBuy);
  if (!(await ev("document.querySelector('details.more').open"))) await click("details.more > summary");
  // a JSON the site already serves: a metadata URL that answers nothing would log an error on every page that lists the coin
  await type("#metaUrl", origin + "/package.json?coin=" + symbol.toLowerCase() + "-flow");
  check(await until("!!document.querySelector('#colKind') && location.pathname === '/launch-collectible.html'", 3000), "the Collectible page shows the kind of coin and the collection's fields");
  say("kind selected at first", await ev("document.querySelector('#colKind [aria-pressed=true]').innerText"));
  say("plain coin text", await text("[data-kind-body=plain]"));
  if (kind === "pegged") {
    await click("#colKind [data-kind=pegged]");
    check(await ev("document.querySelector('#colKind [data-kind=pegged]').getAttribute('aria-pressed') === 'true' && !document.querySelector('[data-kind-body=pegged]').hidden && document.querySelector('[data-kind-body=plain]').hidden"), "Pegged coin is pressed and its text replaces the plain one");
    check(await ev("location.pathname === '/launch-collectible.html' && document.querySelector('#pvKind').textContent === 'Collectible'"), "the click on the control kept the page a collectible");
    say("pegged coin text", await text("[data-kind-body=pegged]"));
  }
  // the form opens on the curve, which a pegged coin cannot use: its choice is off and the seed is
  // picked. This flow measures a seeded launch of 2 SOL for the plain coin too, so it picks the seed.
  if (kind === "pegged") check(await ev("document.querySelector('input[name=start][value=seed]').checked && document.querySelector('input[name=start][value=curve]').disabled && /A pegged coin cannot launch on the curve/.test(document.querySelector('#startOff').textContent)"), "a pegged coin cannot use the curve: the choice is off, the seed is picked, and the form says why");
  else if (!(await ev("document.querySelector('input[name=start][value=seed]').checked"))) await click("label.choice:has(input[name=start][value=seed]) .title");
  await type("#colName", kind === "pegged" ? "Pegs" : "Plains");
  await type("#colUnit", "50,000,000");
  await type("#colBase", "http://localhost:8787/art");
  if (kind === "pegged") {
    console.log("\nscreenshots of the launch card");
    for (const k of ["pegged", "plain"]) {
      for (const [width, height, scheme, tag] of VIEWS) {
        if (k === "plain" && tag === "1440-light") continue;
        await view(width, height, scheme);
        if (await ev("document.querySelector('#colKind [aria-pressed=true]').dataset.kind") !== k) await click("#colKind [data-kind=" + k + "]");
        await scrollTo("#colKind"); await sleep(250); await shot("-launch-" + k + "-" + tag);
        check(await fits(), "launch card, " + k + ", no horizontal scroll at " + tag + " (" + (await overflow()) + ")");
        if (tag === "375") say("kind buttons at 375 (w x h)", await ev("JSON.stringify([...document.querySelectorAll('#colKind button')].map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.width) + ' x ' + Math.round(r.height); }))"));
      }
    }
    await view(Number(w), Number(h), "dark");
    await click("#colKind [data-kind=pegged]");
  }
  await sleep(600);
  say("what you spend", await text("#costs"));
  const totalText = await text("#total");
  const before = await conn.getBalance(dev.publicKey);
  await click("#launchBtn");
  check(await until("!!document.querySelector('#result a.btn')", 60000, 300), "both launch transactions confirm (" + kind + " coin)");
  say("steps", await text("#steps"));
  say("result", await text("#result"));
  say("wallet prompts", await ev("window.__signPrompts"));
  const href = await ev("(document.querySelector('#result a.btn') || {}).href || ''");
  const made = new PublicKey(new URL(href).searchParams.get("pool"));
  const spent = before - (await conn.getBalance(dev.publicKey));
  const plat = await client.platform();
  const rent = spent - 2 * LAMPORTS_PER_SOL - Math.round(Number(firstBuy) * LAMPORTS_PER_SOL) - Number(plat.launchFeeLamports);
  say("dev spent", (spent / LAMPORTS_PER_SOL).toFixed(6) + " SOL, of which rent and fees " + (rent / LAMPORTS_PER_SOL).toFixed(6) + " SOL");
  // the form shows its Total rounded up to 0.0001 SOL
  const totalShown = Math.round(parseFloat(String(totalText).replace(/,/g, "")) * LAMPORTS_PER_SOL);
  check(spent <= totalShown && totalShown - spent < 100_000, "the Total of the launch form is true for a " + kind + " coin: it showed " + totalText + ", the wallet's SOL fell by " + (spent / LAMPORTS_PER_SOL).toFixed(9));
  check(/liquidity locked\.$/.test((await text("#steps")) || "") && !/burn/i.test((await text("aside .card")) || ""), "the launch page says the liquidity is locked, and nothing about burned LP");
  return made;
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
  // headless Edge now and then reports the page as hidden, and a hidden page pauses its polls
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await view(Number(w), Number(h), "dark");

  // ---- 0. launch through the launch page ---------------------------------------------------------
  if (poolArg === "plain") {
    console.log("\n0. launch a PLAIN collectible coin through the launch page");
    pool = await launchThroughPage("plain", "PLF", "0");
    const p = await client.pool(pool);
    cfg = await col.fetchCollectionConfig(conn, pool);
    check(p.baseTokenProgram.equals(TOKEN_PROGRAM) && !client.isPegged(p) && !cfg.pegged, "the plain choice made a classic SPL coin, not pegged");
    const md = await client.metadata(p.baseMint);
    say("coin", { name: md.name, symbol: md.symbol, collection: cfg.name });
    console.log("plain pool " + pool.toBase58());
    console.log("\npage errors: " + (pageErrors.length ? "\n" + pageErrors.join("\n") : "none"));
    console.log(failed ? failed + " CHECK(S) FAILED" : "all checks passed");
    if (failed) process.exitCode = 1;
    ws.close();
  } else {
  if (!pool) {
    console.log("\n0. launch a PEGGED coin through the launch page, with a first buy of 0.3 SOL");
    pool = await launchThroughPage("pegged", "PGF", "0.3");
    console.log("pegged pool " + pool.toBase58());
  }
  let p = await client.pool(pool);
  cfg = await col.fetchCollectionConfig(conn, pool);
  unit = cfg.unit;
  const mint = cfg.baseMint;
  check(p.baseTokenProgram.equals(TOKEN_2022_PROGRAM) && client.isPegged(p) && cfg.pegged, "the pool trades a Token-2022 coin and the collection is pegged");
  const md = await client.metadata(mint);
  const mi = await client.mint(mint);
  check(!!md && md.symbol === "PGF" && md.name === "Pegged Flow Coin" && !md.isMutable, "name and symbol are read from the coin itself and nobody can change them: " + (md ? md.name + " (" + md.symbol + ")" : "no metadata"));
  check(mi.mintAuthority === null && mi.freezeAuthority === null && mi.tokenProgram.equals(TOKEN_2022_PROGRAM), "fixed supply " + whole(mi.supply) + ", no mint authority, no freeze authority");
  say("collection", { name: cfg.name, unitCoins: whole(unit), maxSupply: cfg.maxSupply, live: cfg.live, minted: cfg.minted, waiting: cfg.reservedPending });
  const art = await (await fetch(origin + "/art/c/" + pool.toBase58())).json();
  check(art.name === cfg.name, "/art/c/<pool> answers the collection name: " + art.name);

  // ---- 1. explore lists it ------------------------------------------------------------------------
  console.log("\n1. Explore");
  await open(holder, "/index.html", "!!document.querySelector('#walletBtn.on') && !!document.querySelector('#grid .coin-card:not(.ghost)')");
  const row = await ev("(() => { const c = document.querySelector('.coin-card[data-pool=\"" + pool.toBase58() + "\"]'); return c ? c.innerText.replace(/\\s+/g, ' ') : null; })()");
  say("card", row);
  const tags = await ev("(() => { const c = document.querySelector('.coin-card[data-pool=\"" + pool.toBase58() + "\"]'); return c ? c.dataset.kind + ': ' + c.dataset.tags.split(',').join(', ') : null; })()");
  check(tags === "Collectible: mint, pegged", "its card says what it runs: " + tags);
  check(/Pegged Flow Coin\s*PGF/.test(row || ""), "name and symbol show");

  // ---- 2. buy: balance, pieces, hook card -----------------------------------------------------------
  const buySol = await solFor(3);
  console.log("\n2. buy " + buySol + " SOL through the coin page (enough for three pieces)");
  await openCoin(holder);
  say("head tags", await text("#head .head-tags"));
  say("hook card", await ev("[...document.querySelectorAll('#hookCard .kind > *, #hookCard .sentences li')].map((x) => x.innerText).join(' | ')"));
  check(await ev("[...document.querySelectorAll('#hookCard .kind .tag')].map((x) => x.innerText).join() === 'pegged coin'"), "the hook card names the kind: pegged coin");
  check(!(await ev("/never called on a sell/.test(document.querySelector('#hookCard').innerText)")), "the card no longer claims the hook is never called on a sell");
  await type("#amount", buySol);
  say("earn line", await text("#tradeCard .earn-line"));
  check(await until("/same as above/.test((document.querySelector('#exactOut') || {}).innerText || '')", 8000), "the simulated buy on the Token-2022 coin matches the local quote: " + (await text("#exactOut")));
  await click("#tradeCard .btn-buy");
  check(await until("document.querySelectorAll('#colMine .piece.blank').length > 0", 20000, 60), "blank tiles show while the block decides");
  check(await until("document.querySelectorAll('#colMine .piece.own').length === 3 && document.querySelectorAll('#colMine .piece.blank').length === 0", 40000), "three pieces minted and drawn");
  await sleep(600);
  say("wallet prompts for buy and mint", await ev("window.__signPrompts"));
  let page = await list();
  let ticket = await col.fetchTicket(conn, pool, holder.publicKey);
  say("page list", names(page));
  check(page.length === 3 && page.every((t, i) => t.addr === ticket.owned[i].toBase58()), "the page shows the wallet's list in its on-chain order");
  let balance = await coinsOf(holder.publicKey);
  await click("#tradeCard .seg [data-dir=sell]");
  const balLine = await text("#tradeCard .balance");
  say("sell form balance", balLine);
  const shownBal = (balLine || "").replace(/,/g, "").match(/Balance ([\d.]+)/);
  check(!!shownBal && Math.abs(Number(shownBal[1]) - Number(balance) / 1e6) < 0.001, "the trade form reads the Token-2022 balance: chain " + whole(balance));
  await click("#tradeCard .balance button");
  check((await ev("document.querySelector('#amount').value")) === whole(balance).replace(/\.?0+$/, ""), "Max fills the whole balance: " + (await ev("document.querySelector('#amount').value")));
  say("sell everything", await text("#tradeCard .earn-line.cost"));
  await click("#tradeCard .seg [data-dir=buy]");
  say("status line", await text("#colMine .mine-peg"));
  check((await text("#colMine .mine-peg")) === "You hold 3 pieces. Your coins back 3.", "the status line counts the Token-2022 coins as backing");
  check((await coreOwner(ticket.owned[0])) === holder.publicKey.toBase58(), "Metaplex shows the holder as owner of its pieces");

  // ---- 3. the Send coins form names what a transfer carries -------------------------------------------
  console.log("\n3. Send coins: live");
  // the friend gets a ticket and a few coins: a buy smaller than one piece
  {
    const pp = await client.pool(pool);
    await sendNode(await client.swapInstructions(friend.publicKey, pp, await client.hookRef(pp, friend.publicKey), DIRECTION.BUY, BigInt(0.02 * LAMPORTS_PER_SOL), 1n), [friend]);
  }
  const friendTicket0 = await col.fetchTicket(conn, pool, friend.publicKey);
  const friendCoins0 = await coinsOf(friend.publicKey);
  say("friend before", { ticket: !!friendTicket0, pieces: friendTicket0 ? friendTicket0.owned.length : 0, coins: whole(friendCoins0) });
  check(!!friendTicket0 && friendTicket0.owned.length === 0 && friendTicket0.pending === 0, "the friend holds a ticket and no piece");
  check(await ev("!!document.querySelector('#colMine .mine-send')"), "the Send coins form shows on a pegged coin");
  say("form", await text("#colMine .mine-send"));
  const send1 = balance - 2n * unit; // the holder keeps exactly two units: one piece is no longer backed
  await type("#colMine .coin-amt", whole(100n * 1_000_000n));
  let lines = await sendLines();
  check(!lines.carry && !lines.cost, "a transfer of 100 coins moves no piece and the form says nothing");
  await type("#colMine .coin-amt", whole(send1));
  lines = await sendLines();
  say("amount only", lines.carry);
  check(lines.carry === "This transfer moves 1 piece off your list: " + page[2].name + ".", "before a receiver is typed it names the piece that leaves the list");
  await type("#colMine .coin-to", friend.publicKey.toBase58());
  check(await until("/carries/.test((document.querySelector('#colMine .mine-send .earn-line') || {}).innerText || '')", 6000), "once the receiver is read the line turns to carries");
  lines = await sendLines();
  say("to the friend", lines.carry);
  check(lines.carry === "This transfer carries 1 piece: " + page[2].name + "." && !lines.cost, "it names the piece the transfer carries, and no ticket note for a wallet that has one");
  // the same amount to a wallet with no ticket
  await type("#colMine .coin-to", fresh.publicKey.toBase58());
  check(await until("/no ticket/.test((document.querySelector('#colMine .mine-send .earn-line') || {}).innerText || '')", 6000), "a wallet without a ticket gets the note");
  lines = await sendLines();
  say("to a wallet with no ticket", lines.carry);
  check(lines.carry === "This transfer carries 1 piece: " + page[2].name + ". | This wallet has no ticket for PGF yet. Send opens it, so the piece arrives.", "the note says Send opens the ticket");
  // a transfer the receiver's coins would not back
  await type("#colMine .coin-amt", whole(balance - 3n * unit + 1_000_000n));
  await sleep(500);
  lines = await sendLines();
  say("a small transfer that breaks a unit", lines.cost);
  check(lines.cost === "This transfer burns 1 piece: " + page[2].name + ". | The receiver takes one piece for each whole 50,000,000 PGF this transfer sends." && !lines.carry, "a transfer too small to back the piece at the receiver is named as a burn");
  // bad inputs
  await type("#colMine .coin-to", holder.publicKey.toBase58());
  await sleep(900);
  say("own address", (await sendLines()).err);
  await type("#colMine .coin-to", pool.toBase58());
  await sleep(900);
  say("the pool address", (await sendLines()).err);
  await type("#colMine .coin-to", "not an address");
  await click("#colMine .send-coins .btn");
  say("not an address", (await sendLines()).err);

  // screenshots of this state at every width: three pieces, the form filled, the carry line showing
  console.log("\nscreenshots of the coin page");
  await type("#colMine .coin-to", friend.publicKey.toBase58());
  await type("#colMine .coin-amt", whole(send1));
  await until("/carries/.test((document.querySelector('#colMine .mine-send .earn-line') || {}).innerText || '')", 6000);
  await clearToasts();
  for (const [width, height, scheme, tag] of VIEWS) {
    await view(width, height, scheme);
    await scrollTo("#colMine"); await sleep(250); await shot("-coin-" + tag);
    check(await fits(), "coin page, no horizontal scroll at " + tag + " (" + (await overflow()) + ")");
    if (width < 1024) { await scrollTo("#hookCard"); await sleep(250); await shot("-coin-" + tag + "-hook"); }
    if (tag === "375") {
      // a phone has a coarse pointer: measure the tap targets the way a phone lays them out
      await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await sleep(300);
      const sizes = JSON.parse(await ev("JSON.stringify([...document.querySelectorAll('#colMine .send-coins input, #colMine .send-coins button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }))"));
      say("send form at 375, touch (w x h)", sizes.map((s) => s.join(" x ")).join(", "));
      check(sizes.length === 3 && sizes.every((s) => s[1] >= 44), "recipient, amount and Send are at least 44 px tall on touch");
      await call("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
  }
  await view(Number(w), Number(h), "dark");

  // ---- 4. send coins to a wallet that has a ticket ----------------------------------------------------
  console.log("\n4. send " + whole(send1) + " coins to the friend (has a ticket)");
  let prompts = await ev("window.__signPrompts");
  await click("#colMine .send-coins .btn");
  check(await until("/Sent/.test((document.querySelector('#colMine .mine-send .tx-result') || {}).innerText || '') && document.querySelectorAll('#colMine .piece.own').length === 2", 30000), "the transfer confirms and the sender's list drops to two");
  await sleep(700);
  say("signatures", (await ev("window.__signPrompts")) - prompts);
  lines = await sendLines();
  say("result", lines.res);
  check(/This transfer carried 1 piece: /.test(lines.res || "") && (lines.res || "").includes(page[2].name), "the result names the piece that travelled");
  check((await ownedOf(friend.publicKey)).join() === page[2].addr, "the friend's list holds " + page[2].name);
  check((await coreOwner(new PublicKey(page[2].addr))) === friend.publicKey.toBase58(), "Metaplex shows the friend as its owner, in the same transaction");
  check((await coinsOf(holder.publicKey)) === 2n * unit && (await coinsOf(friend.publicKey)) === friendCoins0 + send1, "coins: holder " + whole(await coinsOf(holder.publicKey)) + ", friend " + whole(await coinsOf(friend.publicKey)));
  check((await col.fetchQueue(conn, pool)).length === 0, "nothing in the burn queue");
  say("status line", await text("#colMine .mine-peg"));
  const moved1 = page[2];
  page = await list();
  say("page list", names(page));

  // ---- 5. send coins to a wallet with no ticket: the site opens it ---------------------------------------
  console.log("\n5. send one unit of coins to a wallet with no ticket and no token account");
  check((await col.fetchTicket(conn, pool, fresh.publicKey)) === null, "the fresh wallet has no ticket");
  await type("#colMine .coin-to", fresh.publicKey.toBase58());
  await type("#colMine .coin-amt", whole(unit));
  await until("/no ticket/.test((document.querySelector('#colMine .mine-send .earn-line') || {}).innerText || '')", 6000);
  say("live line", (await sendLines()).carry);
  await scrollTo("#colMine"); await shot("-5-send-no-ticket");
  await click("#colMine .send-coins .btn");
  check(await until("/Sent/.test((document.querySelector('#colMine .mine-send .tx-result') || {}).innerText || '') && document.querySelectorAll('#colMine .piece.own').length === 1", 30000), "the transfer confirms and the sender's list drops to one");
  await sleep(700);
  say("result", (await sendLines()).res);
  const freshTicket = await col.fetchTicket(conn, pool, fresh.publicKey);
  check(!!freshTicket && freshTicket.owned.length === 1 && freshTicket.owned[0].toBase58() === page[1].addr, "the site opened the ticket and " + page[1].name + " arrived in the fresh wallet's list");
  check((await coreOwner(new PublicKey(page[1].addr))) === fresh.publicKey.toBase58(), "Metaplex shows the fresh wallet as its owner");
  check((await coinsOf(fresh.publicKey)) === unit && (await coinsOf(holder.publicKey)) === unit, "coins: fresh " + whole(await coinsOf(fresh.publicKey)) + ", holder " + whole(await coinsOf(holder.publicKey)));
  cfg = await col.fetchCollectionConfig(conn, pool);
  say("pieces that exist", cfg.live + " (nothing burned so far)");

  // ---- 6. a sell burns inside the swap ---------------------------------------------------------------
  console.log("\n6. sell");
  await buyNode(holder, 2); // two more pieces through the SDK
  await openCoin(holder);
  page = await list();
  balance = await coinsOf(holder.publicKey);
  say("holder before the sell", { pieces: names(page), coins: whole(balance) });
  check(page.length === 3, "the holder holds three pieces again");
  await click("#tradeCard .seg [data-dir=sell]");
  const sellAmount = balance - 2n * unit - 1_000_000n; // leaves two units and one coin
  await type("#amount", whole(sellAmount));
  const costLine = await text("#tradeCard .earn-line.cost");
  say("sell " + whole(sellAmount), costLine);
  check(await until("/same as above/.test((document.querySelector('#exactOut') || {}).innerText || '')", 8000), "the simulated sell, with the coin's own hook in it, matches the local quote: " + (await text("#exactOut")));
  check(costLine === "This sell burns 1 piece: " + page[2].name + ".", "the sell form names the piece the sell burns");
  const liveBefore = (await col.fetchCollectionConfig(conn, pool)).live;
  prompts = await ev("window.__signPrompts");
  await click("#tradeCard .btn-sell");
  check(await until("/Sold/.test((document.querySelector('#tradeCard .tx-result') || {}).innerText || '') && document.querySelectorAll('#colMine .piece.own').length === 2", 30000), "the sell confirms and the list drops to two");
  await sleep(700);
  say("signatures", (await ev("window.__signPrompts")) - prompts);
  say("trade result", await text("#tradeCard .tx-result"));
  check(((await text("#tradeCard .tx-result")) || "").includes("This sell burned 1 piece: " + page[2].name + "."), "the result names the burned piece");
  check(await burned(new PublicKey(page[2].addr)), page[2].name + " is burned on chain, Metaplex asset included");
  check((await col.fetchQueue(conn, pool)).length === 0, "nothing is left in the burn queue");
  cfg = await col.fetchCollectionConfig(conn, pool);
  check(cfg.live === liveBefore - 1, "pieces that exist now went from " + liveBefore + " to " + cfg.live);
  check((await client.collectibleSettleInstructions(stranger.publicKey, pool, holder.publicKey)).length === 0, "nothing is left for a settle");
  check(!(await ev("!!document.querySelector('#colMine .mine-upkeep')")), "no upkeep line: the sell burned the NFT itself");
  await scrollTo("#colMine"); await shot("-6-after-sell");

  // ---- 7. one chosen piece with exactly its coins -------------------------------------------------------
  console.log("\n7. Send one chosen piece");
  page = await list();
  const chosen = page[0]; // the FIRST of the list, not the one a transfer would take
  const hb = await coinsOf(holder.publicKey), fb = await coinsOf(friend.publicKey);
  await click("#colMine .piece.own[data-addr='" + chosen.addr + "']");
  check(await until("!!document.querySelector('#colMine .piece-panel')", 3000), "picking a piece opens its panel");
  say("panel", await text("#colMine .piece-panel"));
  await type("#colMine .send-to", friend.publicKey.toBase58());
  await scrollTo("#colMine"); await sleep(300); await shot("-7-send-piece");
  prompts = await ev("window.__signPrompts");
  await click("#colMine .send-row .btn");
  check(await until("document.querySelectorAll('#colMine .piece.own').length === 1", 30000), "the piece leaves the sender's list");
  await sleep(700);
  say("signatures", (await ev("window.__signPrompts")) - prompts);
  say("toasts", await text("#toasts"));
  const friendList = await ownedOf(friend.publicKey);
  check(friendList.length === 2 && friendList[1] === chosen.addr, "exactly " + chosen.name + " arrived, at the end of the friend's list");
  check((await ownedOf(holder.publicKey)).join() === page[1].addr, "the sender kept " + page[1].name);
  check((await coreOwner(new PublicKey(chosen.addr))) === friend.publicKey.toBase58(), "Metaplex shows the friend as its owner");
  check((await coinsOf(holder.publicKey)) === hb - unit && (await coinsOf(friend.publicKey)) === fb + unit, "exactly one unit travelled: holder " + whole(hb) + " to " + whole(await coinsOf(holder.publicKey)) + ", friend " + whole(fb) + " to " + whole(await coinsOf(friend.publicKey)));

  // ---- 8. a transfer made outside the site: the NFTs follow through the page -----------------------------
  console.log("\n8. transfers made outside the site, then the upkeep line");
  // a) the friend sends one unit to the holder with a bare transfer: the piece moves, nobody delivers the NFT
  let fl = await ownedOf(friend.publicKey);
  await sendNode([col.peggedTransfer(friend.publicKey, holder.publicKey, pool, mint, (await coinsOf(friend.publicKey)) - unit, 6)], [friend]);
  const hl = await ownedOf(holder.publicKey);
  const came = hl[hl.length - 1];
  check(hl.length === 2 && fl.includes(came), "a bare transfer moved a piece into the holder's list");
  check((await coreOwner(new PublicKey(came))) === friend.publicKey.toBase58(), "its Metaplex NFT still shows the friend");
  // b) the friend sends its last unit to a wallet with a token account and no ticket: the piece burns into the queue
  await sendNode([ix.createAtaIdempotent(outsider.publicKey, outsider.publicKey, mint, TOKEN_2022_PROGRAM)], [outsider]);
  fl = await ownedOf(friend.publicKey);
  await sendNode([col.peggedTransfer(friend.publicKey, outsider.publicKey, pool, mint, await coinsOf(friend.publicKey), 6)], [friend]);
  const queue = await col.fetchQueue(conn, pool);
  check(queue.length === 1 && queue[0].toBase58() === fl[0] && (await ownedOf(friend.publicKey)).length === 0, "a bare transfer to a wallet without a ticket burned the piece: it waits in the burn queue");
  check(!(await burned(queue[0])), "its Metaplex NFT still exists");
  await openCoin(holder);
  check(await until("!!document.querySelector('#colMine .mine-upkeep')", 8000), "the page shows the upkeep line");
  say("upkeep line", await text("#colMine .mine-upkeep"));
  check(((await text("#colMine .mine-upkeep")) || "").startsWith("The NFT of 1 of your pieces has not reached your wallet yet. The NFT of 1 burned piece still exists."), "it counts one delivery and one burn");
  check((await ev("document.querySelector('#colMine .mine-upkeep .btn').innerText")) === "Deliver and burn", "the button says what it does");
  await scrollTo("#colMine"); await sleep(300); await shot("-8-upkeep");
  await view(375, 900, "dark"); await scrollTo("#colMine .mine-upkeep"); await sleep(300); await shot("-8-upkeep-375");
  await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(300);
  const upH = await ev("Math.round(document.querySelector('#colMine .mine-upkeep .btn').getBoundingClientRect().height)");
  check(upH >= 44, "the upkeep button is " + upH + " px tall on touch");
  await call("Emulation.setTouchEmulationEnabled", { enabled: false });
  check(await fits(), "no horizontal scroll at 375 with the upkeep line");
  await view(Number(w), Number(h), "dark");
  const solBefore = await conn.getBalance(holder.publicKey);
  prompts = await ev("window.__signPrompts");
  await click("#colMine .mine-upkeep .btn");
  check(await until("!document.querySelector('#colMine .mine-upkeep')", 30000), "the line goes away once the upkeep is sent");
  say("signatures (two transactions)", (await ev("window.__signPrompts")) - prompts);
  say("toasts", await text("#toasts"));
  check((await coreOwner(new PublicKey(came))) === holder.publicKey.toBase58(), "Metaplex now shows the holder as owner of the piece that came in");
  check((await burned(queue[0])) && (await col.fetchQueue(conn, pool)).length === 0, "the queued NFT is burned and the queue is empty");
  say("holder SOL change", ((await conn.getBalance(holder.publicKey)) - solBefore) / LAMPORTS_PER_SOL + " (rent of the burned NFT minus two fees)");

  // ---- 9. above the peg still works on a pegged coin ------------------------------------------------------
  console.log("\n9. above the peg: the holder burns coins directly");
  ticket = await col.fetchTicket(conn, pool, holder.publicKey);
  balance = await coinsOf(holder.publicKey);
  say("holder before", { pieces: ticket.owned.length, coins: whole(balance) });
  const keep = unit + 10_000_000n * 1_000_000n; // 60,000,000 coins stay: they back one piece of two
  await sendNode([burnCoins(holder.publicKey, mint, balance - keep)], [holder]);
  await openCoin(holder);
  const over = await text("#colMine .mine-peg");
  say("status line", over);
  check(/^You hold 2 pieces\. Your coins back 1\. Anyone can burn the extra one, from the end of your list\. Buy 40,000,000 PGF and you keep it\.$/.test(over || ""), "the page says one piece is above the peg and what keeps it");
  page = await list();
  check(page.length === 2 && !page[0].burns && page[1].burns, "the piece at the end of the list is marked");
  await click("#colMine .piece.own[data-addr='" + page[0].addr + "']");
  await until("!!document.querySelector('#colMine .piece-panel')", 3000);
  const locks = await ev("JSON.stringify([...document.querySelectorAll('#colMine .pp-row .btn, #colMine .send-row .btn')].map((b) => b.innerText + ': ' + b.disabled))");
  check(locks === JSON.stringify(["Move first: true", "Move last: true", "Send: true"]), "Move and Send keep their verbs and are disabled above the peg: " + locks);
  say("lock", await text("#colMine .piece-panel .lock"));
  await scrollTo("#colMine"); await sleep(400); await shot("-9-above-peg");
  const settleIxs = await client.collectibleSettleInstructions(stranger.publicKey, pool, holder.publicKey);
  check(settleIxs.length > 0, "a settle is there for anyone to send");
  if (settleIxs.length) await sendNode(settleIxs, [stranger]);
  await call("Page.bringToFront").catch(() => {});
  check(await until("document.querySelectorAll('#colMine .piece.own').length === 1", 45000, 500), "the page notices the burn on its own, without a reload");
  say("status line", await text("#colMine .mine-peg"));
  check(await burned(new PublicKey(page[1].addr)), page[1].name + " is burned on chain by the settle");

  // ---- 10. liquidity on a pegged coin ------------------------------------------------------------------
  console.log("\n10. add and remove liquidity");
  await buyNode(holder, 1); // one more piece, so a deposit has something to cost
  await open(holder, "/pool.html?pool=" + pool.toBase58(), "!!document.querySelector('#walletBtn.on') && !document.querySelector('#layout').hidden && /LP balance/.test(document.querySelector('#position').innerText)");
  say("pool head", await text("#head .pool-head"));
  say("position", await text("#position"));
  ticket = await col.fetchTicket(conn, pool, holder.publicKey);
  balance = await coinsOf(holder.publicKey);
  p = await client.pool(pool);
  // SOL that needs a little more coins than the holder has to spare above its last unit
  const spare = balance - BigInt(ticket.owned.length) * unit;
  const needCoins = spare + 2_000_000n * 1_000_000n;
  const solIn = (Number(needCoins) * Number(p.reserveQuote) / Number(p.reserveBase) / LAMPORTS_PER_SOL).toFixed(4);
  say("holder", { pieces: ticket.owned.length, coins: whole(balance), spare: whole(spare) });
  await type("#addAmount", solIn);
  say("add " + solIn + " SOL", await text("#addKv"));
  const depCost = await text("#addCost");
  say("deposit cost line", depCost);
  const lastName = (await col.fetchOwnedPieces(conn, pool, holder.publicKey)).pop().name;
  check((depCost || "").startsWith("This deposit burns 1 piece: " + lastName + "."), "the deposit form names the piece the deposit burns");
  await scrollTo("#addCard"); await sleep(250); await shot("-10-deposit");
  await click("#addBtn");
  check(await until("/Added/.test(document.querySelector('#addResult').innerText)", 30000), "the deposit confirms");
  await sleep(800);
  say("position after", await text("#position"));
  const lpBal = await client.tokenBalance(holder.publicKey, p.lpMint);
  check(lpBal > 0n, "the holder holds LP: " + whole(lpBal));
  check((await ownedOf(holder.publicKey)).length === ticket.owned.length - 1, "the deposit took the last piece off the holder's list");
  const q2 = await col.fetchQueue(conn, pool);
  say("burn queue after the deposit", q2.length + " (the deposit adds no reap; the page's upkeep line or the watcher burns the NFT)");
  await click("#removeQuick button:nth-child(3)");
  say("remove 100%", await text("#removeKv"));
  await click("#removeBtn");
  check(await until("/Removed/.test(document.querySelector('#removeResult').innerText)", 30000), "the withdrawal confirms");
  await sleep(800);
  check((await client.tokenBalance(holder.publicKey, p.lpMint)) === 0n, "the LP is gone and the coins are back: " + whole(await coinsOf(holder.publicKey)));
  check((await ownedOf(holder.publicKey)).length === ticket.owned.length - 1, "coins coming out of the pool bring no piece");
  for (const tx of await client.collectibleUpkeepInstructions(stranger.publicKey, pool)) await sendNode(tx, [stranger]);
  check((await col.fetchQueue(conn, pool)).length === 0, "a stranger sent the upkeep and the queue is empty");

  // ---- 11. the collection grid follows the lists --------------------------------------------------------
  console.log("\n11. collection grid");
  await openCoin(holder);
  await ev("document.querySelector('#colAll').scrollIntoView(); true");
  cfg = await col.fetchCollectionConfig(conn, pool);
  check(await until("document.querySelectorAll('#colAll .piece').length === " + cfg.live, 15000), "the grid shows the " + cfg.live + " pieces that exist");
  say("grid", await text("#colAll"));

  console.log("\npage errors: " + (pageErrors.length ? "\n" + pageErrors.join("\n") : "none"));
  console.log(failed ? failed + " CHECK(S) FAILED" : "all checks passed");
  if (failed) process.exitCode = 1;
  ws.close();
  }
} catch (e) {
  console.error("flow failed: " + e.message);
  if (pageErrors.length) console.error(pageErrors.join("\n"));
  try { await shot("-failure"); } catch (_) {}
  process.exitCode = 1;
} finally {
  console.log(await edge.close());
  if (pool && poolArg !== "plain") {
    try { cfg = await col.fetchCollectionConfig(conn, pool); } catch (_) {}
    let back = 0n;
    for (const kp of [holder, friend, fresh, outsider, dev]) back += await sellBack(kp);
    try { for (const tx of await client.collectibleUpkeepInstructions(stranger.publicKey, pool)) await sendNode(tx, [stranger]); } catch (_) {}
    const p = await client.pool(pool);
    console.log("sold back " + whole(back) + " coins. Pool " + pool.toBase58() + " now " + whole(p.reserveBase) + " coins and " + (Number(p.reserveQuote) / LAMPORTS_PER_SOL).toFixed(4) + " SOL, burn queue " + (await col.fetchQueue(conn, pool)).length + ".");
  }
}
