// Review tool: a real buy on a collectible pool through the coin page, in headless Edge, signed by a throwaway
// wallet made here (localnet only, airdropped, never written to disk). One approval: the buy carries the deposit
// for its NFTs, and the watcher's mint crank mints them into the wallet a few seconds later.
// Captures the page while the earned pieces are still blank, while their NFTs are being minted, and once they
// are rendered.
//   node web/review/flow-collectible.mjs <site origin> <pool> <out prefix> [width] [height] [single|all]
// "single" hides signAllTransactions, "all" offers it: either way the page must ask for ONE signature.
// It starts its own watcher (watcher/index.mjs) with only the reveal and the mint crank, its state, status and
// keeper key in a temporary folder and its HTTP on a free port, and stops it at the end by its process id.
// One line per check, "  ok    ..." or "  FAIL  ...". At the end the wallet takes back what is left of its
// deposit with the page's own "Withdraw deposit" button, then sells all its coins on the page: the ticket
// shrinks to its empty list, and what that frees and nothing else pays for (a plain coin: the rent of the
// burned pieces' entries) is offered back by the same button and paid to the lamport.
// The browser is started and closed by edge.mjs: no extensions, a profile of its own, closed through its
// DevTools port.
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, EVENT_DISC, collectible as col } from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";
import { startMintKeeper } from "./mint-keeper.mjs";

const [origin, pool, prefix, w = "1440", h = "1500", mode = "all"] = process.argv.slice(2);
if (!origin || !pool || !prefix) { console.error("usage: node web/review/flow-collectible.mjs <origin> <pool> <out prefix> [width] [height] [single|all]"); process.exit(1); }
const RPC = "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const poolKey = new PublicKey(pool);
const kp = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
console.log("throwaway wallet " + kp.publicKey.toBase58() + " funded on localnet");
let failed = 0;
const check = (ok, text) => { if (!ok) failed++; console.log((ok ? "  ok    " : "  FAIL  ") + text); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the watcher with the mint crank ---------------------------------------------------------------------
const mk = await startMintKeeper({ rpc: RPC });
check(mk.ok, "a watcher with the mint crank runs (process " + mk.pid + ", /health on port " + mk.port + ")");
const keeper = mk.keeper;

const edge = await startEdge({ name: "flow", width: Number(w), height: Number(h) });
let id = 0; const pending = new Map(); const events = [];
const call = (ws, method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (ws, expression) => (await call(ws, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
const shot = async (ws, name) => { const s = await call(ws, "Page.captureScreenshot", { format: "png" }); writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64")); console.log("wrote " + prefix + name + ".png"); };
/// One part of the page, wherever it is scrolled to.
const shotOf = async (ws, selector, name) => {
  const r = JSON.parse(await evaluate(ws, "JSON.stringify((() => { const b = document.querySelector(" + JSON.stringify(selector) + ").getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height }; })())"));
  const s = await call(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...r, scale: 1 } });
  writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64")); console.log("wrote " + prefix + name + ".png");
};

// the stand-in wallet: same surface as an injected wallet, signing with the throwaway key
const walletSource = `
  localStorage.setItem("Programmable.wallet", "phantom");
  (() => {
    const SECRET = ${JSON.stringify(Array.from(kp.secretKey))};
    const ADDRESS = ${JSON.stringify(kp.publicKey.toBase58())};
    window.__signPrompts = 0;
    const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(SECRET)); };
    // what Phantom blocks as "could be malicious": a transaction already signed by another key, or
    // one that fails when simulated against the chain as it is before the wallet signs it
    window.__phantomFlags = [];
    const phantomCheck = async (tx) => {
      if (tx.signatures.some((s) => s.some((b) => b !== 0))) window.__phantomFlags.push("already signed by another key");
      try {
        const H = await import("/js/hookpool.js");
        const r = await new H.Connection("${RPC}", "confirmed").simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
        if (r.value.err) window.__phantomFlags.push("fails simulation before signing: " + JSON.stringify(r.value.err));
      } catch (e) { window.__phantomFlags.push("could not be simulated: " + e.message); }
    };
    const publicKey = { toBase58: () => ADDRESS };
    const w = { isPhantom: true, publicKey, on() {}, disconnect: async () => {},
      connect: async () => ({ publicKey }),
      signTransaction: async (tx) => { window.__signPrompts++; await phantomCheck(tx); tx.sign([await key()]); return tx; } };
    ${mode === "single" ? "" : "w.signAllTransactions = async (txs) => { window.__signPrompts++; const k = await key(); for (const t of txs) { await phantomCheck(t); t.sign([k]); } return txs; };"}
    window.phantom = { solana: w };
  })();`;

/// The keeper's mint_for transactions that named this wallet: their DepositUsed events (pool 8, user 40, by 72).
async function keeperMints() {
  const out = [];
  for (const s of await conn.getSignaturesForAddress(keeper, { limit: 50 }, "confirmed")) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    for (const line of (tx && tx.meta && tx.meta.logMessages) || []) {
      if (!line.startsWith("Program data: ")) continue;
      const b = Buffer.from(line.slice(14), "base64");
      if (b.length < 124 || !EVENT_DISC.DepositUsed.every((x, i) => b[i] === x)) continue;
      if (new PublicKey(b.subarray(40, 72)).equals(kp.publicKey)) out.push({ signature: s.signature, err: s.err, by: new PublicKey(b.subarray(72, 104)), pieces: b.readUInt32LE(104) });
    }
  }
  return out;
}

const pageErrors = [];
try {
  const ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === "Runtime.exceptionThrown") pageErrors.push("EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") pageErrors.push("console.error " + d.params.args.map((a) => a.value || a.description).join(" "));
    else if (d.method) events.push(d.method);
  };
  await call(ws, "Page.enable"); await call(ws, "Runtime.enable");
  await call(ws, "Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 600 });
  await call(ws, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await call(ws, "Page.addScriptToEvaluateOnNewDocument", { source: walletSource });
  // the page posts the deposit buy to the keeper's /notify only when it knows the keeper's address
  await call(ws, "Page.navigate", { url: origin + "/coin.html?pool=" + pool + (mk && mk.url ? "&watcher=" + encodeURIComponent(mk.url) : "") });
  for (let i = 0; i < 100 && !events.includes("Page.loadEventFired"); i++) await sleep(100);
  // wait for the page to be ready and the wallet to be restored
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) { ready = await evaluate(ws, "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on')"); if (!ready) await sleep(250); }
  check(ready, "the coin page is ready and the stand-in wallet is connected");
  const cfg = await col.fetchCollectionConfig(conn, poolKey);
  if (!check(!!cfg, "the pool has a collection on chain")) throw new Error("not a collectible pool");
  await evaluate(ws, "(() => { const i = document.getElementById('amount'); i.value = '0.5'; i.dispatchEvent(new Event('input')); return true; })()");
  await sleep(1200);
  const earnLine = await evaluate(ws, "document.querySelector('.earn-line') ? document.querySelector('.earn-line').innerText.replace(/\\n/g, ' | ') : ''");
  const said = /^This buy earns (\d+) pieces?\. It adds a ([\d.]+) SOL deposit for the NFTs?, used to mint (it|them) into your wallet\./.exec(earnLine || "");
  check(!!said, "before the click the form says what the buy earns and what the deposit for its NFTs costs: \"" + earnLine + "\"");
  if (said) {
    // the chain's rent, as the page reads it: never the local constant (mainnet's rent differs from the validator's)
    const need = col.mintDepositFor(await col.rentFrom(conn), cfg, Number(said[1]));
    const shown = BigInt(Math.round(Number(said[2]) * 1e9));
    check(shown >= need && shown - need < 1_000_000n, "the deposit said, " + said[2] + " SOL, is the SDK's mintDepositFor of " + said[1] + " pieces (" + need + " lamports) rounded up");
  }
  await evaluate(ws, "document.getElementById('colMine').scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); true");
  const lamports0 = await conn.getBalance(kp.publicKey);
  await evaluate(ws, "document.querySelector('#tradeCard .btn-buy').click(); true");
  // 1. the earned pieces as blank tiles
  let sawBlank = 0;
  for (let i = 0; i < 150 && !sawBlank; i++) {
    sawBlank = await evaluate(ws, "document.querySelectorAll('#colMine .piece.blank').length");
    if (!sawBlank) await sleep(80);
  }
  if (check(sawBlank > 0, "the earned pieces show as blank tiles while their NFTs are on their way: " + sawBlank + " | status: " + (await evaluate(ws, "(document.querySelector('#colMine .mine-status') || {}).innerText || ''")))) await shot(ws, "-undecided");
  // 2. the trade card says the NFTs are being minted
  let mintSaid = "";
  for (let i = 0; i < 100 && !mintSaid; i++) { mintSaid = await evaluate(ws, "(document.querySelector('#mintSaid') || {}).innerText || ''"); if (!mintSaid) await sleep(60); }
  if (check(/^Your NFTs? (is|are) being minted\.$/.test(mintSaid), "after the buy the trade card says: \"" + mintSaid + "\"")) { await shot(ws, "-minting"); await shotOf(ws, "#tradeCard", "-minting-trade"); }
  // the block is in and the keeper is on its way: the list says so too (it lasts about a second, so the
  // picture is taken when it is caught)
  for (let i = 0; i < 60; i++) {
    if (/being minted/.test(await evaluate(ws, "(document.querySelector('#colMine .mine-status') || {}).innerText || ''"))) { await shotOf(ws, "#colMine", "-keeper"); break; }
    if (!(await evaluate(ws, "document.querySelectorAll('#colMine .piece.blank').length"))) break;
    await sleep(50);
  }
  // 3. the same pieces, rendered once the keeper minted them
  let drawn = 0;
  for (let i = 0; i < 150; i++) {
    const o = JSON.parse(await evaluate(ws, "JSON.stringify({ blank: document.querySelectorAll('#colMine .piece.blank').length, drawn: document.querySelectorAll('#colMine .piece img').length })"));
    if (o.blank === 0 && o.drawn > 0) { drawn = o.drawn; break; }
    await sleep(200);
  }
  await sleep(600);
  const names = await evaluate(ws, "[...document.querySelectorAll('#colMine .piece .n')].map((x) => x.innerText).join(', ')");
  const ticket = await col.fetchTicket(conn, poolKey, kp.publicKey);
  check(drawn > 0 && !!ticket && ticket.owned.length === drawn && ticket.pending === 0, "the pieces are minted and drawn: the page shows " + drawn + " (" + names + "), the wallet's list on chain holds " + (ticket ? ticket.owned.length : 0) + ", " + (ticket ? ticket.pending : 0) + " waiting");
  check(!!said && Number(said[1]) === drawn, "the buy earned what the form said: " + (said ? said[1] : "?") + " said, " + drawn + " minted");
  const owners = ticket ? await conn.getMultipleAccountsInfo(ticket.owned) : [];
  check(owners.length > 0 && owners.every((i) => i && i.data[0] === 1 && new PublicKey(i.data.subarray(1, 33)).equals(kp.publicKey)), "Metaplex shows the wallet as the owner of every NFT");
  const mints = await keeperMints();
  check(mints.length === 1 && !mints[0].err && mints[0].by.equals(keeper) && mints[0].pieces === drawn, "the watcher's keeper minted them: one mint_for paid from the deposit (" + mints.map((m) => m.signature.slice(0, 12) + ", " + m.pieces + " pieces").join("; ") + ")");
  if (drawn) { await shot(ws, "-rendered"); await shotOf(ws, "#tradeCard", "-rendered-trade"); }
  const prompts = await evaluate(ws, "window.__signPrompts");
  const result = await evaluate(ws, "(document.querySelector('#tradeCard .tx-result') || {}).innerText || ''");
  check(/^Bought/.test(result), "the trade form says the buy went through: \"" + result.replace(/\n/g, " | ") + "\"");
  check(/Your NFTs? (is|are) in your wallet\./.test(result), "and then that the NFTs are in the wallet");
  check(prompts === 1, "wallet prompts: one, for the buy with its deposit: " + prompts);
  const flags = await evaluate(ws, "window.__phantomFlags || []");
  check(flags.length === 0, "the wallet was never handed a transaction Phantom blocks" + (flags.length ? ": " + flags.join("; ") : ""));
  check((await evaluate(ws, "document.documentElement.scrollWidth <= window.innerWidth")), "no sideways scroll at " + w + " (" + (await evaluate(ws, "document.documentElement.scrollWidth + ' of ' + window.innerWidth")) + ")");
  // 4. what is left of the deposit: the page offers it back, and its button gives it back
  const left = await col.ticketDeposit(conn, poolKey, kp.publicKey);
  let btn = false;
  for (let i = 0; i < 40 && !btn; i++) { btn = await evaluate(ws, "!!document.querySelector('#withdrawDeposit')"); if (!btn) await sleep(250); }
  const line = await evaluate(ws, "(document.querySelector('#colMine .deposit-line') || {}).innerText || ''");
  check(left > 0n && btn && /^Your deposit holds [\d.]+ SOL\./.test(line), "the deposit left, " + left + " lamports, is offered back: \"" + line + "\"");
  if (btn) {
    await shot(ws, "-deposit-left");
    await evaluate(ws, "document.querySelector('#withdrawDeposit').click(); true");
    let gone = false;
    for (let i = 0; i < 60 && !gone; i++) { gone = (await col.ticketDeposit(conn, poolKey, kp.publicKey)) === 0n; if (!gone) await sleep(250); }
    check(gone && (await evaluate(ws, "window.__signPrompts")) === 2, "Withdraw deposit takes it back with one more signature");
    for (let i = 0; i < 20 && (await evaluate(ws, "!!document.querySelector('#withdrawDeposit')")); i++) await sleep(250);
    check(!(await evaluate(ws, "!!document.querySelector('#withdrawDeposit')")), "and the button is gone");
    const flags2 = await evaluate(ws, "window.__phantomFlags || []");
    check(flags2.length === 0, "the withdrawal was not a transaction Phantom blocks either");
  }
  // 5. sell everything through the page. The sell burns the pieces (a plain coin in its settle, a pegged coin
  // inside the transfer). The ticket shrinks to its list and keeps its lamports: what the freed bytes held, and
  // nothing else paid for, is the wallet's deposit. The page offers exactly what withdraw_deposit pays, and the
  // withdraw lands for exactly that.
  {
    const rent = await col.rentFrom(conn);
    const ticketKey = col.collectiblePda.ticket(poolKey, kp.publicKey);
    const before = await conn.getAccountInfo(ticketKey);
    const tb = before ? col.decodeTicket(new Uint8Array(before.data)) : null;
    const heldBefore = tb ? col.withdrawableDeposit(before.lamports, before.data.length, tb.owned.length, rent) : 0n;
    await evaluate(ws, "document.querySelector('#tradeCard [data-dir=sell]').click(); true");
    let sellReady = false;
    for (let i = 0; i < 40 && !sellReady; i++) { sellReady = await evaluate(ws, "!!document.querySelector('#tradeCard .btn-sell') && [...document.querySelectorAll('#tradeCard .quick button')].some((b) => b.textContent === '100%')"); if (!sellReady) await sleep(150); }
    await evaluate(ws, "[...document.querySelectorAll('#tradeCard .quick button')].find((b) => b.textContent === '100%').click(); true");
    await sleep(1500);
    await evaluate(ws, "document.querySelector('#tradeCard .btn-sell').click(); true");
    let sold = "";
    for (let i = 0; i < 160 && !/^Sold/.test(sold); i++) { sold = await evaluate(ws, "(document.querySelector('#tradeCard .tx-result') || {}).innerText || ''"); if (!/^Sold/.test(sold)) await sleep(250); }
    check(/^Sold/.test(sold), "a sell of everything through the page went through: \"" + sold.replace(/\n/g, " | ") + "\"");
    const after = await conn.getAccountInfo(ticketKey);
    const ta = after ? col.decodeTicket(new Uint8Array(after.data)) : null;
    check(!!ta && !!tb && ta.owned.length === 0 && ta.pending === 0 && after.data.length === col.ticketSpace(0),
      "its pieces burned and the ticket shrank to an empty list: " + (ta && tb ? tb.owned.length + " pieces in " + before.data.length + " bytes before, " + ta.owned.length + " in " + after.data.length + " after" : "no ticket"));
    const freed = before && after ? rent(before.data.length) - rent(after.data.length) : 0n;
    const want = ta ? col.withdrawableDeposit(after.lamports, after.data.length, ta.owned.length, rent) : 0n;
    if (cfg.pegged) check(want >= heldBefore && want - heldBefore <= freed, "pegged coin: the " + freed + " lamports the shrink freed first pay the pieces' place in the burn queue (the sell's reap gives that back to the seller); the deposit went from " + heldBefore + " to " + want);
    else check(want === heldBefore + freed, "plain coin: the rent the shrink freed, " + freed + " lamports, is the wallet's deposit now (" + heldBefore + " before the sell, " + want + " after)");
    check((await col.ticketDeposit(conn, poolKey, kp.publicKey)) === want, "the SDK's ticketDeposit says the same: " + want);
    let offered = false, freedLine = "";
    for (let i = 0; i < 60; i++) {
      offered = await evaluate(ws, "!!document.querySelector('#withdrawDeposit')");
      freedLine = await evaluate(ws, "(document.querySelector('#colMine .deposit-line') || {}).innerText || ''");
      if ((want > 0n) === offered && (!offered || freedLine)) break;
      await sleep(250);
    }
    if (want === 0n) check(!offered, "nothing to withdraw, and the page offers nothing");
    else {
      const m = /^Your deposit holds ([\d.]+) SOL\./.exec(freedLine);
      const said = m ? BigInt(Math.round(Number(m[1]) * 1e9)) : -1n;
      check(offered && said >= 0n && said <= want && want - said < 1000n, "the page offers it back with Withdraw deposit: \"" + freedLine + "\" (" + want + " lamports, shown to six decimals)");
      if (offered) {
        await shot(ws, "-deposit-freed");
        const prompts0 = await evaluate(ws, "window.__signPrompts");
        const seen = new Set((await conn.getSignaturesForAddress(ticketKey, { limit: 20 }, "confirmed")).map((s) => s.signature));
        await evaluate(ws, "document.querySelector('#withdrawDeposit').click(); true");
        let gone = false;
        for (let i = 0; i < 80 && !gone; i++) { gone = (await col.ticketDeposit(conn, poolKey, kp.publicKey)) === 0n; if (!gone) await sleep(250); }
        // the withdraw's own transaction: its DepositWithdrawn event (pool 8, user 40, lamports 72) and the wallet's balance in it
        let paid = null, event = null, sig = "";
        for (let i = 0; i < 20 && paid === null; i++) {
          const fresh = (await conn.getSignaturesForAddress(ticketKey, { limit: 20 }, "confirmed")).filter((s) => !seen.has(s.signature) && !s.err);
          if (fresh.length) {
            sig = fresh[0].signature;
            const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
            if (tx && tx.meta) {
              paid = BigInt(tx.meta.postBalances[0]) - BigInt(tx.meta.preBalances[0]) + BigInt(tx.meta.fee);
              for (const l of tx.meta.logMessages || []) {
                if (!l.startsWith("Program data: ")) continue;
                const b = Buffer.from(l.slice(14), "base64");
                if (b.length >= 80 && EVENT_DISC.DepositWithdrawn.every((x, j) => b[j] === x)) event = b.readBigUInt64LE(72);
              }
            }
          }
          if (paid === null) await sleep(250);
        }
        const tEnd = await conn.getAccountInfo(ticketKey);
        check(gone && paid === want && event === want && (await evaluate(ws, "window.__signPrompts")) === prompts0 + 1,
          "Withdraw deposit paid exactly " + want + " lamports with one more signature: the wallet got " + paid + " (its fee added back), DepositWithdrawn says " + event + " (" + (sig ? sig.slice(0, 12) : "no transaction") + ")");
        check(!!tEnd && tEnd.data.length === col.ticketSpace(0) && BigInt(tEnd.lamports) === rent(col.ticketSpace(0)), "the ticket is left with exactly the rent of an empty list: " + (tEnd ? tEnd.lamports + " lamports, " + tEnd.data.length + " bytes" : "gone"));
        for (let i = 0; i < 20 && (await evaluate(ws, "!!document.querySelector('#withdrawDeposit')")); i++) await sleep(250);
        check(!(await evaluate(ws, "!!document.querySelector('#withdrawDeposit')")), "and the button is gone again");
      }
    }
  }
  console.log("\nwallet spent " + (lamports0 - (await conn.getBalance(kp.publicKey))) + " lamports on the buy, its deposit and the withdrawal");
  console.log("page errors: " + (pageErrors.length ? "\n" + pageErrors.join("\n") : "none"));
  check(pageErrors.length === 0, "no script error on the page");
  console.log(failed ? failed + " CHECK(S) FAILED" : "all checks passed");
  if (failed) process.exitCode = 1;
  ws.close();
} catch (e) {
  console.error("flow failed: " + e.message); process.exitCode = 1;
} finally {
  console.log(await edge.close());
  // the watcher, by the process id this script started
  const lines = mk.lines.filter((l) => / mint: /.test(l));
  console.log("the watcher's mints: " + (lines.length ? "\n  " + lines.join("\n  ") : "none"));
  await mk.stop(); console.log("stopped the watcher (process " + mk.pid + ")");
  // give the pool its coins back, and the wallet what is left of its deposit
  try {
    const p = await client.pool(poolKey);
    const amount = p ? await client.tokenBalance(kp.publicKey, p.baseMint, p.baseTokenProgram) : 0n;
    if (amount > 0n) {
      const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(kp.publicKey, await client.swapInstructions(kp.publicKey, p, await client.hookRef(p, kp.publicKey), DIRECTION.SELL, amount, 0n));
      tx.sign([kp]);
      await conn.confirmTransaction({ signature: await conn.sendTransaction(tx), blockhash, lastValidBlockHeight }, "confirmed");
      console.log("sold back " + amount + " raw units of the coin");
    }
    const wd = await client.collectibleWithdrawInstructions(kp.publicKey, poolKey);
    if (wd.length) { const b = await client.buildTx(kp.publicKey, wd); b.tx.sign([kp]); await conn.confirmTransaction({ signature: await conn.sendTransaction(b.tx), blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight }, "confirmed"); console.log("took back the deposit left"); }
  } catch (e) { console.error("could not sell back: " + e.message); }
}
