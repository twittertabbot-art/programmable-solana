#!/usr/bin/env node
// Live proof of the upkeep crank (pegged coins), on the local validator only (it airdrops).
//
//   node watcher/prove-upkeep.mjs                      the pegged pool this script was written against; when the
//                                                      validator no longer has it, the deepest pegged pool
//   node watcher/prove-upkeep.mjs --pool <address>     that pegged pool
//   node watcher/prove-upkeep.mjs --keep-coins         skip the clean up at the end (step 9)
//
// A pegged coin is a Token-2022 coin whose transfer hook is the collectible program. The wallet lists change
// inside every transfer of the coin. The Metaplex Core assets follow: `deliver` hands a moved piece's asset to
// the wallet whose list holds it, `reap` burns the asset of a piece that a transfer burned. The watcher sends
// both for transfers made outside the site. This script shows it, with fresh wallets that exist only in this run:
//   1. HOLDER, the control, buys coins for one piece, waits for the deciding block, mints, and keeps its coins.
//   2. MOVER does the same.
//   3. FRIEND opens a token account and a ticket. MOVER moves ALL its coins to FRIEND with a plain transfer,
//      built by the standard token library the way a wallet's Send button builds it. The piece leaves MOVER's
//      list and joins FRIEND's list inside the transfer. Metaplex still shows MOVER as the owner of the asset.
//   4. It runs the real watcher once (node index.mjs --once --pool <pool>), with its state and status files in
//      a temporary folder. The keeper must deliver the asset: Metaplex shows FRIEND.
//   5. STRANGER opens a token account and NO ticket. FRIEND moves ALL its coins to STRANGER with a plain
//      transfer. The piece leaves FRIEND's list and no list holds it: it waits in the pool's burn queue.
//   6. It runs the watcher again. The keeper must burn the asset: 1 byte of zero is left, the queue no longer
//      holds it, and the keeper's balance rose by the rent of the asset and of its queue entry, minus the fee.
//   7. It runs the watcher once more: nothing waits, the keeper sends no deliver and no reap.
//      After every round: HOLDER is untouched. Same list, same asset, same Metaplex owner, same coins.
//   8. Everybody else on the pool: the keeper touched no wallet that had nothing waiting.
//   9. STRANGER sells the coins back. HOLDER sells its coins the way the site does (swap and reap in one
//      transaction): its piece burns with the sell. The pool ends close to where it started.
// Step 9 also runs when a check fails, so a failed proof does not leave the coins stranded.
//
// The only key file it opens is the watcher's own probe keypair, to learn the keeper's public address. It never
// prints a secret. Other people may trade on the pool while it runs: the checks only look at its own wallets
// and at the keeper's own transactions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, TOKEN_2022_PROGRAM, ix, collectible as col, decodeTransferHook } from "../sdk/dist/index.js";
import { loadConfig, WATCHER_DIR, REPO_DIR } from "./lib/config.mjs";

const DEFAULT_POOL = "EWd2Xea6AFhk9LS1XumHL1DBWRtmYa83E2xCBLFXb1DJ";
const args = process.argv.slice(2);
const argOf = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const KEEP_COINS = args.includes("--keep-coins");
const poolArg = argOf("--pool", null);

const { cfg } = loadConfig([], process.env);
if (cfg.cluster !== "localnet" || !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(cfg.rpcUrl)) {
  console.error(`this proof airdrops, so it runs on the local validator only (cluster ${cfg.cluster}, rpc ${cfg.rpcUrl})`);
  process.exit(2);
}
// The standard token library builds the plain transfers, exactly as a wallet does. It is a tool of this proof
// only: the watcher itself does not need it.
let splToken;
try { splToken = await import("@solana/spl-token"); } catch { console.error("this proof needs @solana/spl-token: run `npm install @solana/spl-token` in the repo root"); process.exit(2); }
const conn = new Connection(cfg.rpcUrl, "confirmed");
const altFile = path.join(REPO_DIR, "web", "deployments", "localnet-alt.json");
const lookupTable = fs.existsSync(altFile) ? new PublicKey(JSON.parse(fs.readFileSync(altFile, "utf8")).lookupTable) : undefined;
const client = new HookpoolClient(conn, lookupTable ? { lookupTable } : {});
if (!fs.existsSync(cfg.probeKeypair)) { console.error(`no keeper keypair at ${cfg.probeKeypair}: run the watcher once first (node index.mjs --once)`); process.exit(2); }
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(cfg.probeKeypair, "utf8")))).publicKey;

/// Without --pool: the default pool while the validator has it. A pool address only lives as long as its
/// validator, so on a fresh one the script takes the pegged pool with the most coins in reserve, where the
/// proof moves the price the least. On a validator shared with other work, pass --pool: the deepest pool may
/// be somebody else's test.
async function findPeggedPool() {
  const dflt = new PublicKey(DEFAULT_POOL);
  let c = null;
  try { c = await col.fetchCollectionConfig(conn, dflt); } catch { c = null; }
  if (c && c.pegged) return dflt;
  let best = null;
  for (const p of (await client.allPools()).filter((x) => client.isPegged(x))) {
    try { c = await col.fetchCollectionConfig(conn, p.address); } catch { c = null; }
    if (c && c.pegged && (!best || p.reserveBase > best.reserveBase)) best = p;
  }
  return best ? best.address : null;
}
const poolKey = poolArg ? new PublicKey(poolArg) : await findPeggedPool();
if (!poolKey) { console.error("no pegged pool on this validator: run `node scripts/e2e-pegged.mjs localnet` first, or pass --pool <address>"); process.exit(2); }

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
/// What buying `units` units of coins costs right now, in lamports, with a margin for fees.
function costOf(pool, units) {
  const want = peg.unit * BigInt(units) + peg.unit / 20n;
  if (want * 10n >= pool.reserveBase * 8n) { console.error("the pool does not hold enough coins for that many pieces"); process.exit(2); }
  return { want, amountIn: (pool.reserveQuote * want) / (pool.reserveBase - want) * 103n / 100n };
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
/// What a wallet's Send button does: Token-2022 TransferChecked with the accounts the standard library resolves
/// from the coin's own account list. Nothing of Programmable is involved in building it.
function walletTransfer(from, to, amount) {
  return splToken.createTransferCheckedWithTransferHookInstruction(
    conn, col.coinsAddress(from, peg.baseMint, peg.tokenProgram), peg.baseMint, col.coinsAddress(to, peg.baseMint, peg.tokenProgram), from, amount, decimals, [], "confirmed", splToken.TOKEN_2022_PROGRAM_ID,
  );
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
/// Where an asset account stands: alive (a Core asset, with its Metaplex owner), burned (exactly one byte, zero),
/// or missing.
async function assetStates(keys) {
  const infos = keys.length ? await conn.getMultipleAccountsInfo(keys) : [];
  return infos.map((info, i) => {
    const alive = !!info && info.data.length > 33 && info.data[0] === 1;
    return {
      address: keys[i].toBase58(), exists: !!info, bytes: info ? info.data.length : 0, first: info && info.data.length ? info.data[0] : null, lamports: info ? info.lamports : 0,
      burned: !!info && info.data.length === 1 && info.data[0] === 0, alive, owner: alive ? new PublicKey(info.data.subarray(1, 33)).toBase58() : null,
    };
  });
}
const coinBalance = (wallet) => client.tokenBalance(wallet, peg.baseMint, peg.tokenProgram);
const listOf = async (wallet) => { const t = await col.fetchTicket(conn, poolKey, wallet); return t ? b58s(t.owned) : null; };
const queueNow = async () => b58s(await col.fetchQueue(conn, poolKey));
const undeliveredNow = async () => (await col.fetchUndelivered(conn, poolKey)).map((u) => ({ holder: u.holder.toBase58(), assets: b58s(u.assets) }));
const queueKey = col.collectiblePda.queue(poolKey);
const lamportsOf = async (key) => { const info = await conn.getAccountInfo(key); return info ? info.lamports : 0; };
/// Every wallet of the pool that holds pieces: its list, its coins, and the Metaplex owner of each piece.
async function snapshot() {
  const tickets = (await col.fetchTickets(conn, poolKey)).filter((t) => t.owned.length + t.pending > 0);
  const out = new Map();
  for (const t of tickets) out.set(t.user.toBase58(), { owned: b58s(t.owned), pending: t.pending, coins: await coinBalance(t.user), owners: (await assetStates(t.owned)).map((a) => a.owner) });
  return out;
}
/// Run the real watcher once, on this pool, and return what it printed.
function runWatcher(round, tmp) {
  const env = { ...process.env, STATE_FILE: path.join(tmp, "state.json"), STATUS_FILE: path.join(tmp, "pools.json") };
  const r = spawnSync(process.execPath, ["index.mjs", "--once", "--pool", poolKey.toBase58()], { cwd: WATCHER_DIR, env, encoding: "utf8", timeout: 180000 });
  const lines = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n");
  // Its start-up lines (the settings, indented) are left out.
  const shown = lines.filter((l) => /^\d{4}-\d\d-\d\dT/.test(l) && !/^\S+ info {3}/.test(l) && /upkeep|ALERT| warn | error |keeper wallet/.test(l));
  say(`  watcher round ${round}: exit code ${r.status}. Its lines about the upkeep crank:`);
  for (const l of shown) say(`    ${l}`);
  let entry = null;
  const start = (r.stdout ?? "").indexOf("\n{\n");
  if (start >= 0) { try { entry = JSON.parse(r.stdout.slice(start)); } catch { entry = null; } }
  return { status: r.status, lines, entry };
}
/// One round of the real watcher, and what the keeper did in it.
async function watcherRound(label) {
  const last = (await conn.getSignaturesForAddress(keeper, { limit: 1 }, "confirmed"))[0];
  const keeperBefore = await conn.getBalance(keeper);
  const run = runWatcher(label, tmp);
  check(run.status === 0, "the watcher finished with exit code 0");
  const keeperAfter = await conn.getBalance(keeper);
  const txs = await keeperTxsSince(last ? last.signature : null);
  keeperUpkeep.push(...txs.filter((t) => (t.isDeliver || t.isReap) && t.paidByKeeper));
  const moved = txs.reduce((n, t) => n + t.delta, 0);
  say(`  keeper balance over the round: ${keeperBefore} -> ${keeperAfter} lamports (${signed(keeperAfter - keeperBefore)}); the keeper appears in ${txs.length} transaction(s) this round`);
  check(keeperAfter - keeperBefore === moved, `the keeper's SOL balance moved by the sum of its ${txs.length} transaction(s): ${signed(moved)} lamports`);
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
    const logs = tx.meta.logMessages ?? [];
    out.push({
      signature: s.signature, paidByKeeper: at === 0, fee: at === 0 ? tx.meta.fee : 0, delta: at >= 0 ? tx.meta.postBalances[at] - tx.meta.preBalances[at] : 0,
      cu: tx.meta.computeUnitsConsumed, size, isDeliver: logs.some((l) => l.includes("Instruction: Deliver")), isReap: logs.some((l) => l.includes("Instruction: Reap")),
      touches: (key) => staticKeys.some((k) => k.equals(key)), err: tx.meta.err,
    });
  }
  return out;
}
/// HOLDER still holds its coins and its piece: never touched, in any round.
async function holderUntouched() {
  const list = await listOf(holder.publicKey);
  const a = (await assetStates(holderPieces))[0];
  check(sameList(list, b58s(holderPieces)) && a.alive && a.owner === holderKey && a.bytes === holderAssetBefore.bytes && a.lamports === holderAssetBefore.lamports && (await coinBalance(holder.publicKey)) === holderCoins,
    `HOLDER is untouched: same piece (${a.bytes} bytes, alive, Metaplex owner HOLDER), same ${holderCoins} raw coins`);
}

// ---- the scene -------------------------------------------------------------------------------------

step(`upkeep proof on ${cfg.rpcUrl}, pool ${poolKey.toBase58()}`);
const peg = await col.fetchCollectionConfig(conn, poolKey);
if (!peg) { console.error("this pool has no collection config: not a collectible pool"); process.exit(2); }
if (!peg.pegged) { console.error("this pool's coin is a plain coin: the upkeep crank only serves pegged coins (use prove-settle.mjs for this pool)"); process.exit(2); }
const mintAccount = await conn.getAccountInfo(peg.baseMint);
const coinHook = mintAccount ? decodeTransferHook(new Uint8Array(mintAccount.data)) : null;
const mintInfo = await client.mint(peg.baseMint);
if (!mintAccount || !mintInfo || !coinHook) { console.error("the coin's mint could not be read, or it has no transfer hook"); process.exit(2); }
const decimals = mintInfo.decimals;
say(`  collection "${peg.name}": unit ${peg.unit} raw coins per piece (${decimals} decimals), at most ${peg.maxPerBuy} pieces per buy, ${peg.live} pieces exist`);
say(`  coin ${peg.baseMint.toBase58()}: token program ${mintAccount.owner.toBase58()}, transfer hook program ${coinHook.program.toBase58()}, transfer hook authority ${coinHook.authority ? coinHook.authority.toBase58() : "none"}`);
say(`  keeper (the watcher's probe wallet): ${keeper.toBase58()}`);
if ((await conn.getBalance(keeper)) < LAMPORTS_PER_SOL / 2) { await fund(keeper, LAMPORTS_PER_SOL); say("  keeper was low: airdropped 1 SOL"); }
const poolAtStart = await client.pool(poolKey);
const others = await snapshot();
const queueAtStart = await queueNow();
const undeliveredAtStart = await undeliveredNow();
say(`  before the proof: ${others.size} wallet(s) hold pieces, ${queueAtStart.length} asset(s) wait in the burn queue, ${undeliveredAtStart.reduce((n, u) => n + u.assets.length, 0)} asset(s) wait for a delivery`);

const mover = Keypair.generate(); const friend = Keypair.generate(); const stranger = Keypair.generate(); const holder = Keypair.generate();
const moverKey = mover.publicKey.toBase58(); const friendKey = friend.publicKey.toBase58(); const strangerKey = stranger.publicKey.toBase58(); const holderKey = holder.publicKey.toBase58();
say(`  MOVER    ${moverKey}   buys, mints, then moves all its coins to FRIEND`);
say(`  FRIEND   ${friendKey}   has a ticket: the piece arrives with the coins. Then it moves the coins on to STRANGER`);
say(`  STRANGER ${strangerKey}   has no ticket: the piece burns in the transfer`);
say(`  HOLDER   ${holderKey}   buys, mints and keeps its coins (the control)`);
// MOVER buys after HOLDER, at a higher price, and others may be buying too: fund both with room to spare.
await fund(holder.publicKey, Math.max(Number(costOf(poolAtStart, 1).amountIn) * 4, 2 * LAMPORTS_PER_SOL));
await fund(mover.publicKey, Math.max(Number(costOf(poolAtStart, 2).amountIn) * 4, 2 * LAMPORTS_PER_SOL));
await fund(friend.publicKey, LAMPORTS_PER_SOL / 5);
await fund(stranger.publicKey, LAMPORTS_PER_SOL / 5);

let holderPieces = [];
let pieceKey = null;               // MOVER's piece: the one that moves, then burns
let holderAssetBefore = null;
let holderCoins = 0n;
let tmp = null;                    // the watcher's state and status files for this proof
const keeperUpkeep = [];           // every deliver and reap the keeper sent while the proof ran
const result = { deliver: null, reap: null, assetRent: 0, queueRent: 0 };
let failure = null;
try {
step("1. HOLDER buys one piece and keeps its coins");
await buyAndMint(holder, 1, "HOLDER");
step("2. MOVER buys one piece");
await buyAndMint(mover, 1, "MOVER");

const moverTicket = await col.fetchTicket(conn, poolKey, mover.publicKey);
const holderTicket = await col.fetchTicket(conn, poolKey, holder.publicKey);
holderPieces = holderTicket.owned;
check(moverTicket.owned.length === 1 && moverTicket.pending === 0, `MOVER holds 1 minted piece: ${moverTicket.owned[0].toBase58()}`);
check(holderPieces.length === 1 && holderTicket.pending === 0, `HOLDER holds 1 minted piece: ${holderPieces[0].toBase58()}`);
const piece = moverTicket.owned[0];
pieceKey = piece.toBase58();
const moverCoins = await coinBalance(mover.publicKey);
holderCoins = await coinBalance(holder.publicKey);
check(moverCoins >= peg.unit && holderCoins >= peg.unit, `both are backed: MOVER ${moverCoins} raw coins, HOLDER ${holderCoins} raw coins`);
let [pieceState] = await assetStates([piece]);
holderAssetBefore = (await assetStates(holderPieces))[0];
check(pieceState.alive && pieceState.owner === moverKey, `Metaplex shows MOVER as the owner of its piece (${pieceState.bytes} bytes, ${pieceState.lamports} lamports)`);
check(holderAssetBefore.alive && holderAssetBefore.owner === holderKey, "Metaplex shows HOLDER as the owner of its piece");

step("3. FRIEND opens a token account and a ticket. MOVER moves ALL its coins to FRIEND with a plain wallet transfer");
await send([ix.createAtaIdempotent(friend.publicKey, friend.publicKey, peg.baseMint, peg.tokenProgram), col.openTicket(friend.publicKey, poolKey)], [friend], "FRIEND opens its token account and its ticket");
check(sameList(await listOf(friend.publicKey), []), "FRIEND has a ticket and its list is empty");
const liveBeforeMove = (await col.fetchCollectionConfig(conn, poolKey)).live;
await send([await walletTransfer(mover.publicKey, friend.publicKey, moverCoins)], [mover], `plain transfer of ${moverCoins} raw coins, built by the standard token library`);
check((await coinBalance(mover.publicKey)) === 0n && (await coinBalance(friend.publicKey)) === moverCoins, "MOVER holds 0 coins, FRIEND holds them all");
check(sameList(await listOf(mover.publicKey), []), "the piece left MOVER's list inside the transfer");
check(sameList(await listOf(friend.publicKey), [pieceKey]), "FRIEND's list holds it: the piece travelled with the coins");
check((await col.fetchCollectionConfig(conn, poolKey)).live === liveBeforeMove && !(await queueNow()).includes(pieceKey), `nothing was burned: ${liveBeforeMove} pieces exist as before, the piece is not in the burn queue`);
[pieceState] = await assetStates([piece]);
check(pieceState.alive && pieceState.owner === moverKey, "Metaplex still shows MOVER as the owner of the asset: the list moved, the asset is stale");
check((await undeliveredNow()).some((u) => u.holder === friendKey && sameList(u.assets, [pieceKey])), "the SDK lists it as waiting for a delivery to FRIEND");

// ---- the watcher ------------------------------------------------------------------------------------

tmp = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-upkeep-proof-"));
const friendTicketKey = col.collectiblePda.ticket(poolKey, friend.publicKey);

step("4. watcher round 1: the keeper must deliver the asset to FRIEND");
let round = await watcherRound(1);
if (round.run.entry) {
  say(`  what the pool report says about the coin (score ${round.run.entry.score}, sell simulation ${round.run.entry.sellSim.ok ? "ok" : `FAILED: ${round.run.entry.sellSim.error}`}):`);
  say(`    coin: ${JSON.stringify(round.run.entry.coin)}`);
  for (const n of round.run.entry.notes) say(`    note: ${n}`);
  check(round.run.entry.coin && round.run.entry.coin.kind === "pegged" && round.run.entry.sellSim.ok === true && round.run.entry.buySim.ok === true, "the report says pegged, and the simulated buy and sell both went through");
}
let mine = round.txs.filter((t) => t.isDeliver && t.paidByKeeper && t.touches(friendTicketKey));
check(mine.length === 1 && !mine[0].err, `the keeper sent one deliver for FRIEND: ${mine[0] ? mine[0].signature : "none"}`);
const d = mine[0];
result.deliver = d;
check(d.size <= 1232, `that transaction is ${d.size} bytes, under the 1,232 byte limit; it used ${d.cu} compute units and paid a fee of ${d.fee} lamports`);
check(round.run.lines.some((l) => l.includes("delivered 1 asset to wallet") && l.includes(friendKey) && l.includes(d.signature)), "the watcher logged that delivery, with the same signature");
const pieceBeforeDelivery = pieceState;
[pieceState] = await assetStates([piece]);
check(pieceState.alive && pieceState.owner === friendKey, "Metaplex now shows FRIEND as the owner of the asset");
check(pieceState.bytes === pieceBeforeDelivery.bytes && pieceState.lamports === pieceBeforeDelivery.lamports, `the asset itself is unchanged: ${pieceState.bytes} bytes, ${pieceState.lamports} lamports`);
check(sameList(await listOf(friend.publicKey), [pieceKey]), "FRIEND's list still holds the piece");
check(!(await undeliveredNow()).some((u) => u.assets.includes(pieceKey)), "nothing of it waits for a delivery any more");
check(d.delta === -d.fee, `a delivery earns nothing: it moved the keeper's balance by the fee only, ${signed(d.delta)} lamports`);
await holderUntouched();

step("5. STRANGER opens a token account and NO ticket. FRIEND moves ALL its coins to STRANGER with a plain wallet transfer");
await send([ix.createAtaIdempotent(stranger.publicKey, stranger.publicKey, peg.baseMint, peg.tokenProgram)], [stranger], "STRANGER opens its token account, no ticket");
const friendCoins = await coinBalance(friend.publicKey);
const liveBeforeBurn = (await col.fetchCollectionConfig(conn, poolKey)).live;
const queueBeforeBurn = await queueNow();
await send([await walletTransfer(friend.publicKey, stranger.publicKey, friendCoins)], [friend], `plain transfer of ${friendCoins} raw coins, built by the standard token library`);
check((await coinBalance(friend.publicKey)) === 0n && (await coinBalance(stranger.publicKey)) === friendCoins, "FRIEND holds 0 coins, STRANGER holds them all");
check(sameList(await listOf(friend.publicKey), []), "the piece left FRIEND's list inside the transfer");
check((await listOf(stranger.publicKey)) === null, "STRANGER has no ticket: it got the coins and no piece");
check((await col.fetchCollectionConfig(conn, poolKey)).live === liveBeforeBurn - 1, `the piece stopped existing in that same transfer: ${liveBeforeBurn - 1} pieces exist now`);
const queued = await queueNow();
check(queued.includes(pieceKey) && queued.length === queueBeforeBurn.length + 1, `it waits in the pool's burn queue (${queued.length} entry in the queue)`);
[pieceState] = await assetStates([piece]);
check(pieceState.alive && pieceState.bytes > 1, `its Metaplex asset still exists: ${pieceState.bytes} bytes, ${pieceState.lamports} lamports, until someone burns it`);
const queueLamportsBefore = await lamportsOf(queueKey);

step("6. watcher round 2: the keeper must burn the asset");
round = await watcherRound(2);
mine = round.txs.filter((t) => t.isReap && t.paidByKeeper && t.touches(piece));
check(mine.length === 1 && !mine[0].err, `the keeper sent one reap that names the asset: ${mine[0] ? mine[0].signature : "none"}`);
const r = mine[0];
result.reap = r;
check(r.size <= 1232, `that transaction is ${r.size} bytes, under the 1,232 byte limit; it used ${r.cu} compute units and paid a fee of ${r.fee} lamports`);
check(round.run.lines.some((l) => l.includes("from the burn queue, rent received") && l.includes(r.signature)), "the watcher logged that burn, with the same signature");
const pieceBeforeBurn = pieceState;
[pieceState] = await assetStates([piece]);
check(pieceState.burned && pieceState.bytes === 1 && pieceState.first === 0, `the asset account ${pieceKey} is left with exactly 1 byte, value 0`);
const queueAfter = await queueNow();
check(!queueAfter.includes(pieceKey), queueAfter.length === 0 ? "the burn queue is empty" : `the burn queue no longer holds it (${queueAfter.length} entries of other wallets are left)`);
result.assetRent = pieceBeforeBurn.lamports - pieceState.lamports;
result.queueRent = queueLamportsBefore - (await lamportsOf(queueKey));
say(`  rent that left the burned asset account: ${result.assetRent} lamports (${sol(result.assetRent)} SOL); the account keeps ${pieceState.lamports} lamports for its 1 byte`);
say(`  rent that left the burn queue for its entry: ${result.queueRent} lamports`);
if (queued.length === 1 && queueAfter.length === 0) {
  check(r.delta === result.assetRent + result.queueRent - r.fee, `the reap moved the keeper's balance by the two rents minus the fee: ${result.assetRent} + ${result.queueRent} - ${r.fee} = ${signed(r.delta)} lamports`);
} else {
  check(r.delta + r.fee >= result.assetRent, `the queue held other entries too; the reap paid the keeper at least the asset's rent: ${signed(r.delta)} lamports after the fee`);
}
check(round.keeperAfter > round.keeperBefore, `the keeper's balance rose over the round: ${round.keeperBefore} -> ${round.keeperAfter} lamports`);
check(sameList(await listOf(friend.publicKey), []) && (await listOf(stranger.publicKey)) === null, "FRIEND's list is still empty and STRANGER still has no ticket");
await holderUntouched();

step("7. watcher round 3: nothing waits");
round = await watcherRound(3);
const line = round.run.lines.find((l) => l.includes("upkeep done:"));
say(`  the watcher's own summary: ${line ? line.slice(line.indexOf("upkeep done:")) : "(no line)"}`);
check(!round.txs.some((t) => (t.isDeliver || t.isReap) && (t.touches(friendTicketKey) || t.touches(piece))), "the keeper sent no deliver and no reap for the proof's wallets: nothing of theirs waits");
const totalsLine = round.run.lines.find((l) => l.includes("upkeep totals:"));
say(`  the watcher's running totals: ${totalsLine ? totalsLine.slice(totalsLine.indexOf("upkeep totals:")) : "(no line)"}`);
const sentDeliveries = keeperUpkeep.filter((t) => t.isDeliver).length; const sentReaps = keeperUpkeep.filter((t) => t.isReap).length;
check(!!totalsLine && totalsLine.includes(`${sentDeliveries} deliveries sent, ${sentReaps} burns sent, 0 failed`), `those totals match the chain: ${sentDeliveries} deliver and ${sentReaps} reap transaction(s) by the keeper over the three rounds`);
await holderUntouched();

step("8. everybody else on the pool");
const holderTicketKey = col.collectiblePda.ticket(poolKey, holder.publicKey);
check(!keeperUpkeep.some((t) => t.touches(holderTicketKey) || t.touches(holderPieces[0])), "no keeper deliver or reap names HOLDER's ticket or HOLDER's asset");
const now = await snapshot();
for (const [user, was] of others) {
  const ticketKey = col.collectiblePda.ticket(poolKey, new PublicKey(user));
  const is = now.get(user);
  const same = !!is && sameList(is.owned, was.owned) && is.pending === was.pending && is.coins === was.coins;
  const touchedBy = keeperUpkeep.filter((t) => t.touches(ticketKey));
  const stale = was.owners.some((o) => o !== null && o !== user);
  if (!touchedBy.length) check(true, `wallet ${user} (${was.owned.length} piece(s), ${was.coins} raw coins at the start) was not touched by the keeper${same ? "; its list and coins are unchanged" : "; it traded by itself meanwhile"}`);
  else if (stale) check(true, `wallet ${user} is somebody else's and had an asset waiting for a delivery: the keeper delivered it too, ${touchedBy.map((t) => t.signature).join(", ")}`);
  else say(`  note   wallet ${user} received a piece while the watcher ran and the keeper delivered its asset: ${touchedBy.map((t) => t.signature).join(", ")}`);
}
} catch (e) {
  failure = e;
  console.error(String(e && e.message ? e.message : e));
}

if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder left behind is harmless */ } }

if (!KEEP_COINS) {
  step("9. the coins go back: STRANGER sells, and HOLDER sells the way the site does (swap and reap in one transaction)");
  // Whoever of the four still holds coins sells them, HOLDER last. After a clean run that is STRANGER and HOLDER.
  for (const [who, wallet] of [["MOVER", mover], ["FRIEND", friend], ["STRANGER", stranger], ["HOLDER", holder]]) {
    try {
      const amount = await coinBalance(wallet.publicKey);
      if (amount === 0n) continue;
      const p = await client.pool(poolKey);
      const out = await client.quoteOnChain(wallet.publicKey, p, DIRECTION.SELL, amount);
      await send(await client.swapInstructions(wallet.publicKey, p, await client.hookRef(p, wallet.publicKey), DIRECTION.SELL, amount, (out * 98n) / 100n), [wallet], `${who} sells ${amount} raw coins for about ${sol(out)} SOL`);
    } catch (e) {
      say(`  the sell of ${who} did not go through (${short(e)}); its coins stay where they are`);
    }
  }
  try {
    if (holderPieces.length) {
      const hAsset = (await assetStates(holderPieces))[0];
      check(hAsset.burned && sameList(await listOf(holder.publicKey), []), "HOLDER's sell burned its piece in the same transaction: the asset is 1 byte, its list is empty");
    }
    const left = await queueNow();
    check(!left.includes(pieceKey) && !holderPieces.some((k) => left.includes(k.toBase58())), `the burn queue holds nothing of the proof's wallets: ${left.length} entries at the end, ${queueAtStart.length} at the start`);
    for (const [who, wallet] of [["MOVER", mover], ["FRIEND", friend], ["STRANGER", stranger], ["HOLDER", holder]]) {
      const list = await listOf(wallet.publicKey);
      check((await coinBalance(wallet.publicKey)) === 0n && (list === null || list.length === 0), `${who} is left with 0 coins and no piece`);
    }
  } catch (e) {
    if (String(e && e.message).startsWith("CHECK FAILED")) { failure = failure ?? e; console.error(e.message); } else say(`  the final read did not go through (${short(e)})`);
  }
  const end = await client.pool(poolKey);
  say(`  pool reserves at the start: ${poolAtStart.reserveBase} raw coins, ${poolAtStart.reserveQuote} lamports`);
  say(`  pool reserves at the end:   ${end.reserveBase} raw coins, ${end.reserveQuote} lamports`);
}

step("result");
if (failure) { say(`  FAILED after ${checks} checks.`); process.exit(1); }
say(`  ${checks} checks passed.`);
say(`  deliver ${result.deliver.signature}  (${result.deliver.size} bytes, ${result.deliver.cu} compute units, fee ${result.deliver.fee} lamports)`);
say(`  reap    ${result.reap.signature}  (${result.reap.size} bytes, ${result.reap.cu} compute units, fee ${result.reap.fee} lamports)`);
say(`  The reap paid the keeper ${result.assetRent} lamports of asset rent and ${result.queueRent} lamports of queue rent. Net of the two fees the keeper earned ${signed(result.assetRent + result.queueRent - result.deliver.fee - result.reap.fee)} lamports (${sol(result.assetRent + result.queueRent - result.deliver.fee - result.reap.fee)} SOL).`);
