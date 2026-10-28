#!/usr/bin/env node
// Live proof of the settle crank, on the local validator only (it airdrops).
//
//   node watcher/prove-settle.mjs                      one piece left without its coins, one settle, on the plain
//                                                      collectible pool with the most coins in reserve
//   node watcher/prove-settle.mjs --pieces 7           seven pieces: more than one settle burns, so two rounds
//   node watcher/prove-settle.mjs --hand-over          also step 7: a token account handed to another owner
//   node watcher/prove-settle.mjs --pool <address>     another collectible pool
//   node watcher/prove-settle.mjs --keep-coins         skip the clean up at the end (steps 8 and 9)
//
// What it does, with fresh wallets that exist only in this run:
//   1. HOLDER, the control, buys coins for one piece, waits for the deciding block, mints, and keeps its coins.
//   2. LEAVER does the same for N pieces.
//   3. LEAVER creates RECEIVER's token account and moves ALL its coins there with a plain SPL transfer. No piece
//      travels with them, so LEAVER is above the peg.
//   4. It reads the chain: LEAVER is above the peg, HOLDER is not.
//   5. It runs the real watcher (node index.mjs --once --pool <pool>) one round at a time, with its state and
//      status files in a temporary folder, as many rounds as the burns need, then once more. After every round
//      it reads the chain and checks: burned pieces are 1 byte of zero, LEAVER's list shrank from the end, the
//      keeper's balance moved by the rent minus the fee, HOLDER was not touched.
//   6. Everybody else on the pool: the keeper settled no wallet that was backed.
//   7. Only with --hand-over. HOLDER hands its token account to RECEIVER (SPL SetAuthority). The coins do not
//      move, but they are not HOLDER's any more, so they back nothing. One more watcher round must burn
//      HOLDER's piece. RECEIVER then takes the coins out of that account.
//   8. RECEIVER sells the coins back, so the pool ends close to where it started.
//   9. Without --hand-over. HOLDER sells its coins the way the site does (swap and settle in one transaction):
//      its piece burns with the sell, and the keeper has nothing to do.
// Steps 8 and 9 also run when a check fails, so a failed proof does not leave the coins stranded.
//
// The only key file it opens is the watcher's own probe keypair, to learn the keeper's public address. It never
// prints a secret. Other people may trade on the pool while it runs: the checks only look at its own wallets
// and at the keeper's own transactions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Connection, Keypair, PublicKey, TransactionInstruction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, PROGRAMS, TOKEN_PROGRAM, ix, collectible as col } from "../sdk/dist/index.js";
import { loadConfig, WATCHER_DIR, REPO_DIR } from "./lib/config.mjs";
import { MAX_BURNS_PER_SETTLE } from "./lib/crank.mjs";

const args = process.argv.slice(2);
const argOf = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const PIECES = Number(argOf("--pieces", "1"));
const KEEP_COINS = args.includes("--keep-coins");
const HAND_OVER = args.includes("--hand-over");
const poolArg = argOf("--pool", null);
if (!Number.isInteger(PIECES) || PIECES < 1 || PIECES > 12) { console.error("--pieces must be a whole number from 1 to 12"); process.exit(2); }

const { cfg } = loadConfig([], process.env);
if (cfg.cluster !== "localnet" || !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(cfg.rpcUrl)) {
  console.error(`this proof airdrops, so it runs on the local validator only (cluster ${cfg.cluster}, rpc ${cfg.rpcUrl})`);
  process.exit(2);
}
const conn = new Connection(cfg.rpcUrl, "confirmed");
const altFile = path.join(REPO_DIR, "web", "deployments", "localnet-alt.json");
const lookupTable = fs.existsSync(altFile) ? new PublicKey(JSON.parse(fs.readFileSync(altFile, "utf8")).lookupTable) : undefined;
const client = new HookpoolClient(conn, lookupTable ? { lookupTable } : {});
if (!fs.existsSync(cfg.probeKeypair)) { console.error(`no keeper keypair at ${cfg.probeKeypair}: run the watcher once first (node index.mjs --once)`); process.exit(2); }
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(cfg.probeKeypair, "utf8")))).publicKey;

/// Without --pool: the collectible pool of a plain coin (not a pegged one) with the most coins in reserve,
/// where the proof moves the price the least, and whose collection still has room for the pieces of this run.
/// A pool address only lives as long as its validator, so none is written here. On a validator shared with
/// other work, pass --pool: the deepest pool may be somebody else's test.
async function findPlainCollectiblePool() {
  let best = null;
  for (const p of (await client.allPools()).filter((x) => x.hookProgram.equals(PROGRAMS.hook_collectible) && !client.isPegged(x))) {
    let c = null;
    try { c = await col.fetchCollectionConfig(conn, p.address); } catch { c = null; }
    if (!c || c.pegged) continue;
    if (c.maxSupply - c.live - c.reservedPending < PIECES + 1) continue;
    if (!best || p.reserveBase > best.reserveBase) best = p;
  }
  return best ? best.address : null;
}
const poolKey = poolArg ? new PublicKey(poolArg) : await findPlainCollectiblePool();
if (!poolKey) { console.error("no plain collectible pool with room on this validator: run `node scripts/e2e-collectible.mjs localnet` first, or pass --pool <address>"); process.exit(2); }

const say = (s = "") => console.log(s);
const step = (s) => console.log(`\n== ${s}`);
let checks = 0;
const check = (cond, msg) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); checks += 1; console.log(`  check  ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9);
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const b58s = (list) => list.map((k) => k.toBase58());
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const short = (e) => String(e && e.message ? e.message : e).replace(/\s+/g, " ").slice(0, 240);

/// Airdrop, two SOL at a time.
async function fund(pubkey, lamports) {
  for (let left = Math.ceil(lamports); left > 0; left -= 2 * LAMPORTS_PER_SOL) {
    const sig = await conn.requestAirdrop(pubkey, Math.min(left, 2 * LAMPORTS_PER_SOL));
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }
}
/// What buying `units` units of coins costs right now, in lamports, with a margin for fees. The price is made of
/// the effective quote, `reserveQuote + virtualQuote`: a collectible coin launched on the curve opens with no real
/// SOL and prices with its virtual SOL (0 on a seeded pool).
function costOf(pool, units) {
  const want = peg.unit * BigInt(units) + peg.unit / 20n;
  if (want * 10n >= pool.reserveBase * 8n) { console.error("the pool does not hold enough coins for that many pieces"); process.exit(2); }
  return { want, amountIn: ((pool.reserveQuote + pool.virtualQuote) * want) / (pool.reserveBase - want) * 103n / 100n };
}
async function send(ixs, signers, label) {
  const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
  tx.sign(signers);
  const signature = await conn.sendTransaction(tx, { skipPreflight: false });
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)}`);
  say(`  sent   ${label}: ${signature}`);
  return signature;
}
async function waitPastSlot(slot) {
  for (;;) { if (BigInt(await conn.getSlot("confirmed")) > slot + 1n) return; await sleep(400); }
}
/// A plain SPL Token transfer: how a wallet's Send button moves coins, with no piece attached.
function plainTransfer(from, to, owner, amount) {
  const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data });
}
/// SPL Token SetAuthority (account owner): the token account at this address gets a new owner. The coins in it
/// do not move.
function handOver(account, owner, newOwner) {
  const data = Buffer.concat([Buffer.from([6, 2, 1]), newOwner.toBuffer()]);
  return new TransactionInstruction({ programId: peg.tokenProgram, keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data });
}
/// Buy coins for `units` pieces (a little more than `units` units, so the pieces are clearly backed) and mint them.
/// Somebody else may trade between the quote and the buy; then the buy is quoted again.
async function buyAndMint(wallet, units, who) {
  for (let attempt = 1; ; attempt++) {
    const pool = await client.pool(poolKey);
    let { want, amountIn } = costOf(pool, units);
    let quoted;
    for (;;) { quoted = await client.quoteOnChain(wallet.publicKey, pool, DIRECTION.BUY, amountIn); if (quoted >= want) break; amountIn = (amountIn * 102n) / 100n; }
    try {
      await send(await client.swapInstructions(wallet.publicKey, pool, await client.hookRef(pool, wallet.publicKey), DIRECTION.BUY, amountIn, want), [wallet], `${who} buys ${quoted} raw coins for ${sol(amountIn)} SOL`);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      say(`  the buy did not go through (${short(e)}), quoting again`);
    }
  }
  for (let tries = 0; tries < 6; tries++) {
    const t = await col.fetchTicket(conn, poolKey, wallet.publicKey);
    const waiting = t.batches.filter((b) => b.pieces > 0);
    if (!waiting.length) return;
    await waitPastSlot(waiting.reduce((m, b) => (b.targetSlot > m ? b.targetSlot : m), 0n));
    await send(await client.collectibleMintInstructions(wallet.publicKey, poolKey), [wallet], `${who} mints`);
  }
  throw new Error(`${who} still has pieces waiting after six mints`);
}
/// Where an asset account stands: alive (a Core asset), burned (exactly one byte, zero), or missing.
async function assetStates(keys) {
  const infos = keys.length ? await conn.getMultipleAccountsInfo(keys) : [];
  return infos.map((info, i) => ({
    address: keys[i].toBase58(), exists: !!info, bytes: info ? info.data.length : 0, first: info && info.data.length ? info.data[0] : null, lamports: info ? info.lamports : 0,
    burned: !!info && info.data.length === 1 && info.data[0] === 0,
  }));
}
const coinBalance = (wallet) => client.tokenBalance(wallet, peg.baseMint, peg.tokenProgram);
const unbackedNow = async () => new Map((await col.fetchUnbacked(conn, peg)).map((u) => [u.ticket.user.toBase58(), u]));
/// Every wallet of the pool that holds pieces: its list and its coins.
async function snapshot() {
  const tickets = (await col.fetchTickets(conn, poolKey)).filter((t) => t.owned.length + t.pending > 0);
  const out = new Map();
  for (const t of tickets) out.set(t.user.toBase58(), { owned: b58s(t.owned), pending: t.pending, coins: await coinBalance(t.user) });
  return out;
}
/// Run the real watcher once, on this pool, and return what it printed.
function runWatcher(round, tmp) {
  const env = { ...process.env, STATE_FILE: path.join(tmp, "state.json"), STATUS_FILE: path.join(tmp, "pools.json") };
  const r = spawnSync(process.execPath, ["index.mjs", "--once", "--pool", poolKey.toBase58()], { cwd: WATCHER_DIR, env, encoding: "utf8", timeout: 180000 });
  const lines = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n");
  const shown = lines.filter((l) => /^\d{4}-\d\d-\d\dT/.test(l) && /settle|ALERT| warn | error |keeper wallet/.test(l));
  say(`  watcher round ${round}: exit code ${r.status}. Its lines about the settle crank:`);
  for (const l of shown) say(`    ${l}`);
  let entry = null;
  const start = (r.stdout ?? "").indexOf("\n{\n");
  if (start >= 0) { try { entry = JSON.parse(r.stdout.slice(start)); } catch { entry = null; } }
  return { status: r.status, lines, entry };
}
/// One round of the real watcher, and what the keeper did in it.
async function watcherRound(label) {
  for (const [user, u] of await unbackedNow()) aboveBefore.set(user, { held: u.peg.held, allowed: u.peg.allowed, coins: u.balance });
  const last = (await conn.getSignaturesForAddress(keeper, { limit: 1 }, "confirmed"))[0];
  const keeperBefore = await conn.getBalance(keeper);
  const run = runWatcher(label, tmp);
  check(run.status === 0, "the watcher finished with exit code 0");
  const keeperAfter = await conn.getBalance(keeper);
  const txs = await keeperTxsSince(last ? last.signature : null);
  keeperSettles.push(...txs.filter((t) => t.isSettle && t.paidByKeeper));
  return { run, txs, keeperBefore, keeperAfter };
}
/// The keeper's transactions newer than `lastSeen`, oldest first, with what each did to the keeper's balance.
async function keeperTxsSince(lastSeen) {
  const sigs = await conn.getSignaturesForAddress(keeper, lastSeen ? { until: lastSeen } : { limit: 50 }, "confirmed");
  const out = [];
  for (const s of sigs.reverse()) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx || !tx.meta) continue;
    const staticKeys = tx.transaction.message.staticAccountKeys;
    const at = staticKeys.findIndex((k) => k.equals(keeper));
    const size = tx.transaction.message.serialize().length + 1 + 64 * tx.transaction.signatures.length;
    const isSettle = (tx.meta.logMessages ?? []).some((l) => l.includes("Instruction: Settle"));
    out.push({
      signature: s.signature, paidByKeeper: at === 0, fee: at === 0 ? tx.meta.fee : 0, delta: at >= 0 ? tx.meta.postBalances[at] - tx.meta.preBalances[at] : 0,
      cu: tx.meta.computeUnitsConsumed, size, isSettle, touches: (key) => staticKeys.some((k) => k.equals(key)), err: tx.meta.err,
    });
  }
  return out;
}

// ---- the scene -------------------------------------------------------------------------------------

step(`settle proof on ${cfg.rpcUrl}, pool ${poolKey.toBase58()}, ${PIECES} piece(s) to leave behind`);
const peg = await col.fetchCollectionConfig(conn, poolKey);
if (!peg) { console.error("this pool has no collection config: not a collectible pool"); process.exit(2); }
say(`  collection "${peg.name}": unit ${peg.unit} raw coins per piece, at most ${peg.maxPerBuy} pieces per buy, ${peg.live} pieces exist, coin ${peg.baseMint.toBase58()}`);
say(`  keeper (the watcher's probe wallet): ${keeper.toBase58()}`);
if ((await conn.getBalance(keeper)) < LAMPORTS_PER_SOL / 2) { await fund(keeper, LAMPORTS_PER_SOL); say("  keeper was low: airdropped 1 SOL"); }
const poolAtStart = await client.pool(poolKey);
const others = await snapshot();

const leaver = Keypair.generate(); const receiver = Keypair.generate(); const holder = Keypair.generate();
const leaverKey = leaver.publicKey.toBase58(); const holderKey = holder.publicKey.toBase58();
say(`  LEAVER   ${leaverKey}   buys, mints, then moves all its coins away`);
say(`  RECEIVER ${receiver.publicKey.toBase58()}   gets the coins by a plain transfer, never a piece`);
say(`  HOLDER   ${holderKey}   buys, mints and keeps its coins (the control)`);
// LEAVER buys after HOLDER, at a higher price, and others may be buying too: fund both with room to spare.
await fund(holder.publicKey, Math.max(Number(costOf(poolAtStart, 1).amountIn) * 4, 6 * LAMPORTS_PER_SOL));
await fund(leaver.publicKey, Math.max(Number(costOf(poolAtStart, PIECES + 1).amountIn) * 4, 10 * LAMPORTS_PER_SOL));
await fund(receiver.publicKey, LAMPORTS_PER_SOL / 5);

let holderPieces = [];
let tmp = null;                    // the watcher's state and status files for this proof
let handedOver = false;            // HOLDER's token account belongs to RECEIVER
let movedOut = false;              // RECEIVER took the coins out of it
const holderCoinsKey = col.coinsAddress(holder.publicKey, peg.baseMint, peg.tokenProgram);
const receiverCoinsKey = col.coinsAddress(receiver.publicKey, peg.baseMint, peg.tokenProgram);
const keeperSettles = [];
const aboveBefore = new Map();     // wallets seen above the peg right before a watcher round
const totals = { burned: 0, rent: 0, fees: 0, settles: [] };
let failure = null;
try {
step("1. HOLDER buys one piece and keeps its coins");
await buyAndMint(holder, 1, "HOLDER");
step(`2. LEAVER buys ${PIECES} piece(s)`);
for (let left = PIECES; left > 0;) { const n = Math.min(left, peg.maxPerBuy); await buyAndMint(leaver, n, "LEAVER"); left -= n; }

let leaverTicket = await col.fetchTicket(conn, poolKey, leaver.publicKey);
const holderTicket = await col.fetchTicket(conn, poolKey, holder.publicKey);
const pieces = leaverTicket.owned;            // LEAVER's list, in its own order: the last one burns first
holderPieces = holderTicket.owned;
check(pieces.length === PIECES && leaverTicket.pending === 0, `LEAVER holds ${pieces.length} minted piece(s): ${b58s(pieces).join(", ")}`);
check(holderPieces.length === 1 && holderTicket.pending === 0, `HOLDER holds 1 minted piece: ${holderPieces[0].toBase58()}`);
const leaverCoins = await coinBalance(leaver.publicKey);
const holderCoins = await coinBalance(holder.publicKey);
check(leaverCoins >= peg.unit * BigInt(PIECES) && holderCoins >= peg.unit, `both are backed: LEAVER ${leaverCoins} raw coins, HOLDER ${holderCoins} raw coins`);
let unbacked = await unbackedNow();
check(!unbacked.has(leaverKey) && !unbacked.has(holderKey), "neither is above the peg");

step("3. LEAVER creates RECEIVER's token account, then moves ALL its coins there with a plain transfer");
await send([ix.createAtaIdempotent(leaver.publicKey, receiver.publicKey, peg.baseMint, peg.tokenProgram)], [leaver], "create RECEIVER's token account");
await send([plainTransfer(col.coinsAddress(leaver.publicKey, peg.baseMint, peg.tokenProgram), col.coinsAddress(receiver.publicKey, peg.baseMint, peg.tokenProgram), leaver.publicKey, leaverCoins)], [leaver], `plain transfer of ${leaverCoins} raw coins`);
check((await coinBalance(leaver.publicKey)) === 0n && (await coinBalance(receiver.publicKey)) === leaverCoins, "LEAVER holds 0 coins, RECEIVER holds them all");
check((await col.fetchTicket(conn, poolKey, receiver.publicKey)) === null, "RECEIVER has no ticket: no piece travelled with the coins");

step("4. before the watcher runs");
// Somebody else's test may have a wallet above the peg for a second or two, on its way to its own settle. Give it
// a moment, so the keeper does not take that settle away from it. A wallet that stays above the peg is fair game.
for (let waited = 0; waited < 20; waited += 2) {
  const foreign = [...(await unbackedNow()).keys()].filter((u) => u !== leaverKey);
  if (!foreign.length) break;
  if (waited === 0) say(`  another wallet is above the peg right now (${foreign.join(", ")}): waiting up to 20 s for its owner to settle it`);
  await sleep(2000);
}
unbacked = await unbackedNow();
const mine = unbacked.get(leaverKey);
check(!!mine, "LEAVER is above the peg");
check(mine.peg.allowed === 0 && mine.peg.held === PIECES && mine.peg.dropWaiting === 0, `its coins back 0 pieces, it holds ${PIECES}`);
check(sameList(b58s(mine.peg.burn), b58s([...pieces].reverse())), "a settle would burn the end of LEAVER's list, last piece first");
check(!unbacked.has(holderKey), "HOLDER is not above the peg");
const assetsBefore = await assetStates(pieces);
check(assetsBefore.every((a) => a.exists && !a.burned && a.bytes > 1), `LEAVER's piece accounts are alive: ${assetsBefore.map((a) => `${a.bytes} bytes, ${a.lamports} lamports`).join("; ")}`);
const holderAssetBefore = (await assetStates(holderPieces))[0];
const liveBefore = (await col.fetchCollectionConfig(conn, poolKey)).live;
say(`  pieces that exist on the pool: ${liveBefore}`);

// ---- the watcher ------------------------------------------------------------------------------------

tmp = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-settle-proof-"));
const leaverTicketKey = col.collectiblePda.ticket(poolKey, leaver.publicKey);
const expectedRounds = Math.ceil(PIECES / MAX_BURNS_PER_SETTLE);
let alive = [...pieces];
let notesShown = false;
for (let round = 1; round <= expectedRounds + 1; round++) {
  step(`5.${round} watcher round ${round}${round > expectedRounds ? " (nothing of LEAVER's should be left)" : ""}`);
  const before = await assetStates(alive);
  const { run, txs, keeperBefore, keeperAfter } = await watcherRound(round);
  if (run.entry && !notesShown) {
    notesShown = true;
    say("  what the pool report says about the peg:");
    for (const n of run.entry.notes.filter((x) => /peg|settle/i.test(x))) say(`    note: ${n}`);
  }
  const settles = txs.filter((t) => t.isSettle && t.paidByKeeper && t.touches(leaverTicketKey));
  const after = await assetStates(alive);
  leaverTicket = await col.fetchTicket(conn, poolKey, leaver.publicKey);

  if (round <= expectedRounds) {
    const expectBurn = Math.min(MAX_BURNS_PER_SETTLE, alive.length);
    const gone = alive.slice(alive.length - expectBurn);          // the end of the list
    const kept = alive.slice(0, alive.length - expectBurn);
    check(settles.length === 1 && !settles[0].err, `the keeper sent one settle for LEAVER: ${settles[0] ? settles[0].signature : "none"}`);
    const s = settles[0];
    check(s.size <= 1232, `that transaction is ${s.size} bytes, under the 1,232 byte limit; it used ${s.cu} compute units and paid a fee of ${s.fee} lamports`);
    const goneAfter = after.filter((a) => gone.some((g) => g.toBase58() === a.address));
    check(goneAfter.length === expectBurn && goneAfter.every((a) => a.burned && a.bytes === 1 && a.first === 0), `${expectBurn} piece account(s) are left with exactly 1 byte, value 0: ${goneAfter.map((a) => a.address).join(", ")}`);
    check(after.filter((a) => kept.some((k) => k.toBase58() === a.address)).every((a) => !a.burned && a.bytes > 1), `${kept.length} piece(s) at the front of the list are still alive`);
    check(sameList(b58s(leaverTicket.owned), b58s(kept)), kept.length ? `LEAVER's owned list now holds its first ${kept.length} piece(s) only` : "LEAVER's owned list is empty");
    const rent = before.reduce((n, a) => n + a.lamports, 0) - after.reduce((n, a) => n + a.lamports, 0);
    say(`  rent that left the burned piece accounts: ${rent} lamports (${sol(rent)} SOL); each account keeps ${goneAfter[0].lamports} lamports for its 1 byte`);
    check(s.delta === rent - s.fee, `the settle moved the keeper's balance by the rent minus the fee: ${rent} - ${s.fee} = ${signed(s.delta)} lamports`);
    const moved = txs.reduce((n, t) => n + t.delta, 0);
    say(`  keeper balance over the round: ${keeperBefore} -> ${keeperAfter} lamports (${signed(keeperAfter - keeperBefore)}); the keeper appears in ${txs.length} transaction(s) this round`);
    check(keeperAfter - keeperBefore === moved, txs.length === 1 ? `the keeper's SOL balance went up by exactly the rent minus the fee: ${signed(moved)} lamports` : `the keeper's SOL balance moved by the sum of its ${txs.length} transactions: ${signed(moved)} lamports`);
    totals.burned += expectBurn; totals.rent += rent; totals.fees += s.fee; totals.settles.push(s);
    alive = kept;
  } else {
    const line = run.lines.find((l) => l.includes("settle done:"));
    say(`  the watcher's own summary: ${line ? line.slice(line.indexOf("settle done:")) : "(no line)"}`);
    check(settles.length === 0, "the keeper sent no settle for LEAVER: it has nothing above the peg");
    check(leaverTicket.owned.length === 0 && leaverTicket.pending === 0, "LEAVER's owned list is still empty");
    check(!(await unbackedNow()).has(leaverKey), "LEAVER is no longer above the peg");
  }
  // HOLDER still holds its coins: never touched, in any round.
  const h = await col.fetchTicket(conn, poolKey, holder.publicKey);
  const hAsset = (await assetStates(holderPieces))[0];
  check(sameList(b58s(h.owned), b58s(holderPieces)) && !hAsset.burned && hAsset.bytes === holderAssetBefore.bytes && hAsset.lamports === holderAssetBefore.lamports && (await coinBalance(holder.publicKey)) === holderCoins,
    `HOLDER is untouched: same piece (${hAsset.bytes} bytes, alive), same ${holderCoins} raw coins`);
}

step("6. everybody else on the pool");
const holderTicketKey = col.collectiblePda.ticket(poolKey, holder.publicKey);
check(!keeperSettles.some((t) => t.touches(holderTicketKey)), "no keeper settle names HOLDER's ticket");
const now = await snapshot();
for (const [user, was] of others) {
  const ticketKey = col.collectiblePda.ticket(poolKey, new PublicKey(user));
  const is = now.get(user);
  const same = !!is && sameList(is.owned, was.owned) && is.pending === was.pending && is.coins === was.coins;
  const settledBy = keeperSettles.filter((t) => t.touches(ticketKey));
  const above = aboveBefore.get(user);
  if (!settledBy.length) check(true, `wallet ${user} (${was.owned.length} piece(s), ${was.coins} raw coins at the start) was not settled by the keeper${same ? "; its list and coins are unchanged" : "; it traded by itself meanwhile"}`);
  else if (above) check(above.held > above.allowed, `wallet ${user} is somebody else's and was above the peg (${above.held} piece(s) held, ${above.coins} raw coins back ${above.allowed}): the keeper settled it too, ${settledBy.map((t) => t.signature).join(", ")}`);
  else say(`  note   wallet ${user} went above the peg while the watcher ran and the keeper settled it: ${settledBy.map((t) => t.signature).join(", ")}`);
}
const piecesOfHolder = await col.fetchOwnedPieces(conn, poolKey, holder.publicKey);
check(piecesOfHolder.length === 1 && piecesOfHolder[0].owner.equals(holder.publicKey), "Metaplex Core still shows HOLDER as the owner of its piece");

if (HAND_OVER) {
  step("7. HOLDER hands its token account to RECEIVER: the coins stay in place, but they are not HOLDER's any more");
  await send([handOver(holderCoinsKey, holder.publicKey, receiver.publicKey)], [holder], "RECEIVER becomes the owner of HOLDER's token account");
  handedOver = true;
  const raw = await coinBalance(holder.publicKey);
  const [backing] = await col.fetchBacking(conn, peg, [holder.publicKey]);
  check(raw === holderCoins && backing === 0n, `the account still holds ${raw} raw coins and they back nothing: the SDK counts ${backing}, as the program does`);
  const u = (await unbackedNow()).get(holderKey);
  check(!!u && u.peg.allowed === 0 && u.peg.held === 1 && sameList(b58s(u.peg.burn), b58s(holderPieces)), "HOLDER is above the peg now: its piece has no coins behind it");
  const hBefore = (await assetStates(holderPieces))[0];
  const { txs, keeperBefore, keeperAfter } = await watcherRound("after the hand-over");
  const hs = txs.filter((t) => t.isSettle && t.paidByKeeper && t.touches(holderTicketKey));
  check(hs.length === 1 && !hs[0].err, `the keeper sent one settle for HOLDER: ${hs[0] ? hs[0].signature : "none"}`);
  const hAfter = (await assetStates(holderPieces))[0];
  const hTicket = await col.fetchTicket(conn, poolKey, holder.publicKey);
  check(hAfter.burned && hAfter.bytes === 1 && hAfter.first === 0 && hTicket.owned.length === 0, `HOLDER's piece account ${hAfter.address} is left with exactly 1 byte, value 0, and its owned list is empty`);
  const rent = hBefore.lamports - hAfter.lamports;
  check(hs[0].delta === rent - hs[0].fee, `the settle moved the keeper's balance by the rent minus the fee: ${rent} - ${hs[0].fee} = ${signed(hs[0].delta)} lamports`);
  const moved = txs.reduce((n, t) => n + t.delta, 0);
  check(keeperAfter - keeperBefore === moved, `keeper balance over the round: ${keeperBefore} -> ${keeperAfter} lamports (${signed(moved)}), in ${txs.length} transaction(s)`);
  check((await coinBalance(holder.publicKey)) === raw, `the coins did not move: ${raw} raw coins are still in the account`);
  check(!(await unbackedNow()).has(holderKey), "HOLDER is no longer above the peg");
  totals.burned += 1; totals.rent += rent; totals.fees += hs[0].fee; totals.settles.push(hs[0]);
  await send([plainTransfer(holderCoinsKey, receiverCoinsKey, receiver.publicKey, raw)], [receiver], `RECEIVER, the new owner, moves the ${raw} raw coins into its own token account`);
  movedOut = true;
}
} catch (e) {
  failure = e;
  console.error(String(e && e.message ? e.message : e));
}

if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder left behind is harmless */ } }

if (!KEEP_COINS) {
  step("8. RECEIVER sells the coins back, so the pool ends close to where it started");
  if (handedOver && !movedOut) {
    // The proof stopped between the hand-over and the move: RECEIVER takes the coins out now.
    try {
      const info = await conn.getAccountInfo(holderCoinsKey);
      const raw = info ? info.data.readBigUInt64LE(64) : 0n;
      if (raw > 0n) await send([plainTransfer(holderCoinsKey, receiverCoinsKey, receiver.publicKey, raw)], [receiver], `RECEIVER moves the ${raw} raw coins out of the account it was handed`);
    } catch (e) {
      say(`  the move did not go through (${short(e)}); the coins stay in the handed account`);
    }
  }
  try {
    const p = await client.pool(poolKey);
    const amount = await coinBalance(receiver.publicKey);
    if (amount === 0n) throw new Error("RECEIVER holds no coins");
    const out = await client.quoteOnChain(receiver.publicKey, p, DIRECTION.SELL, amount);
    await send(await client.swapInstructions(receiver.publicKey, p, await client.hookRef(p, receiver.publicKey), DIRECTION.SELL, amount, (out * 98n) / 100n), [receiver], `RECEIVER sells ${amount} raw coins for about ${sol(out)} SOL`);
  } catch (e) {
    say(`  the sell did not go through (${short(e)}); the coins stay with RECEIVER`);
  }
  if (!handedOver) step("9. HOLDER sells its coins the way the site does: swap and settle in one transaction");
  if (!handedOver) try {
    const p = await client.pool(poolKey);
    const amount = await coinBalance(holder.publicKey);
    if (amount === 0n) throw new Error("HOLDER holds no coins");
    const out = await client.quoteOnChain(holder.publicKey, p, DIRECTION.SELL, amount);
    const ixs = await client.swapInstructions(holder.publicKey, p, await client.hookRef(p, holder.publicKey), DIRECTION.SELL, amount, (out * 98n) / 100n);
    await send(ixs, [holder], `HOLDER sells ${amount} raw coins for about ${sol(out)} SOL`);
    const hAsset = (await assetStates(holderPieces))[0];
    const h = await col.fetchTicket(conn, poolKey, holder.publicKey);
    check(hAsset.burned && h.owned.length === 0, "the sell settled itself: HOLDER's piece burned in the same transaction, nothing is left for the keeper");
    check(!(await unbackedNow()).has(holderKey), "HOLDER is not above the peg");
  } catch (e) {
    if (String(e && e.message).startsWith("CHECK FAILED")) { failure = failure ?? e; console.error(e.message); }
    else say(`  the sell did not go through (${short(e)}); HOLDER keeps its coins and its piece`);
  }
  const end = await client.pool(poolKey);
  say(`  pool reserves at the start: ${poolAtStart.reserveBase} raw coins, ${poolAtStart.reserveQuote} lamports`);
  say(`  pool reserves at the end:   ${end.reserveBase} raw coins, ${end.reserveQuote} lamports`);
}

step("result");
if (failure) { say(`  FAILED after ${checks} checks.`); process.exit(1); }
say(`  ${checks} checks passed.`);
say(`  ${totals.burned} piece(s) burned by the keeper in ${totals.settles.length} settle(s). Rent received ${totals.rent} lamports, fees paid ${totals.fees} lamports, net ${signed(totals.rent - totals.fees)} lamports (${sol(totals.rent - totals.fees)} SOL).`);
for (const s of totals.settles) say(`  settle ${s.signature}  (${s.size} bytes, ${s.cu} compute units)`);
