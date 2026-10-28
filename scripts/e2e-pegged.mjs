// The pegged coin end to end through the SDK on a live cluster: a Token-2022 coin whose
// transfer hook is the collectible program. What is rehearsed:
//  1. the launchpad creates and launches it, the pool trades it, a buy earns pieces;
//  2. a plain wallet transfer, built by the STANDARD token library the way any wallet
//     builds it, carries the piece to the receiver inside the transfer;
//  3. the same transfer to a wallet that has no ticket burns the piece inside the transfer;
//  4. a sell burns the piece inside the swap;
//  5. one chosen piece travels with exactly its coins.
//   node scripts/e2e-pegged.mjs <localnet|devnet>
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createTransferCheckedWithTransferHookInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { HookpoolClient, NATIVE_MINT, DIRECTION, TOKEN_2022_PROGRAM, collectible as col, ix, hookKindLabel } from "../sdk/dist/index.js";
import { clusterArg, connection, deployer, loadAlt, sendV0 } from "./cluster.mjs";

const cluster = clusterArg();
const conn = connection(cluster);
const dev = deployer(cluster);
const client = new HookpoolClient(conn, { lookupTable: loadAlt(cluster) });
if (!client.options.lookupTable) { console.error("run init-platform first: no lookup table file"); process.exit(1); }
const check = (cond, msg) => { if (!cond) { console.error("CHECK FAILED: " + msg); process.exit(1); } console.log("  check  " + msg); };
const sendIxs = (ixs, signers, label) => sendV0(conn, client, ixs, signers, label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitPastSlot(slot) {
  for (;;) { const s = BigInt(await conn.getSlot("confirmed")); if (s > slot + 1n) return s; await sleep(400); }
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x.equals(b[i]));
async function burned(address) { const a = await conn.getAccountInfo(address); return !!a && a.data.length === 1 && a.data[0] === 0; }
async function fund(wallet, sol) { await conn.confirmTransaction(await conn.requestAirdrop(wallet.publicKey, sol * LAMPORTS_PER_SOL), "confirmed"); }
const DECIMALS = 6;
const coins = (w) => client.tokenBalance(w, mint.publicKey, TOKEN_2022_PROGRAM);
const owned = async (w) => { const t = await col.fetchTicket(conn, plan.pool, w); return t ? t.owned : []; };
const coreOwner = async (asset) => { const a = await conn.getAccountInfo(asset); return a && a.data[0] === 1 ? col.decodePiece(asset, new Uint8Array(a.data)).owner : null; };
async function buyAndMint(wallet, amount, label) {
  const pool = await client.pool(plan.pool);
  const q = await client.quoteOnChain(wallet.publicKey, pool, DIRECTION.BUY, amount);
  await sendIxs(await client.swapInstructions(wallet.publicKey, pool, await client.hookRef(pool, wallet.publicKey), DIRECTION.BUY, amount, q), [wallet], label);
  const t = await col.fetchTicket(conn, plan.pool, wallet.publicKey);
  const waiting = t.batches.filter((b) => b.pieces > 0);
  if (waiting.length) { await waitPastSlot(waiting.reduce((m, b) => (b.targetSlot > m ? b.targetSlot : m), 0n)); await sendIxs(await client.collectibleMintInstructions(wallet.publicKey, plan.pool), [wallet], label + ": mint"); }
  return q;
}
/// What a wallet's Send button does: TransferChecked with the accounts the standard
/// library resolves from the hook's own list. Nothing of ours is involved in building it.
async function walletTransfer(from, to, amount) {
  return createTransferCheckedWithTransferHookInstruction(
    conn, col.coinsAddress(from, mint.publicKey, TOKEN_2022_PROGRAM), mint.publicKey, col.coinsAddress(to, mint.publicKey, TOKEN_2022_PROGRAM), from, amount, DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
  );
}

const ART = Uint8Array.from([1, 28, 30, 150, 24, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const mint = Keypair.generate();
const supply = 1_000_000_000n * 1_000_000n;
// 2 SOL against 1B coins: 1 SOL buys roughly 330M coins. One piece per 50M coins.
const unit = 50_000_000n * 1_000_000n;

// ---- 1. launch ------------------------------------------------------------------------------
const plan = await client.launchInstructions({
  dev: dev.publicKey, mint, name: "Programmable", symbol: "SHOT", uri: "https://example.com/meta/shot.json", decimals: DECIMALS, totalSupply: supply,
  quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: BigInt(2 * LAMPORTS_PER_SOL), devBuyQuote: BigInt(0.3 * LAMPORTS_PER_SOL), minDevBuyOut: 1n,
  template: "collectible",
  collectible: { name: "Shots", uriBase: "http://localhost:8787/art", unit, maxSupply: 1000, maxPerBuy: 3, art: ART, pegged: true },
});
await sendIxs(plan.createTx, [dev, mint], "create the pegged coin + collection config + bind + dev ticket");
await sendIxs(plan.launchTx, [dev], "launch + dev buy");
const pool = await client.pool(plan.pool);
check(pool.baseTokenProgram.equals(TOKEN_2022_PROGRAM) && client.isPegged(pool), `the pool trades a Token-2022 coin with its own hook on it (${hookKindLabel(pool.hookKind)})`);
let cfg = await col.fetchCollectionConfig(conn, plan.pool);
check(cfg.pegged && cfg.baseMint.equals(mint.publicKey), "the coin is bound to its collection");
const md = await client.metadata(mint.publicKey);
check(md && md.name === "Programmable" && md.symbol === "SHOT" && !md.isMutable, "name and symbol are read from the mint itself, and nobody can change them");
const mintInfo = await client.mint(mint.publicKey);
check(mintInfo.mintAuthority === null && mintInfo.freezeAuthority === null && mintInfo.supply === supply, "fixed supply, no mint authority, no freeze authority");

const devTicket = await col.fetchTicket(conn, plan.pool, dev.publicKey);
check(devTicket.pending >= 1, `the dev's first buy earned ${devTicket.pending} piece(s) through the launchpad`);
await waitPastSlot(devTicket.batches[0].targetSlot);
await sendIxs(await client.collectibleMintInstructions(dev.publicKey, plan.pool), [dev], "dev reveals and mints");

const trader = Keypair.generate();
await fund(trader, 5);
await buyAndMint(trader, BigInt(0.5 * LAMPORTS_PER_SOL), "trader buys 0.5 SOL");
let mine = await owned(trader.publicKey);
check(mine.length === 3, `trader holds 3 pieces on ${Number(await coins(trader.publicKey)) / 1e6} coins`);
const [first, second, third] = mine;

// ---- 2. a plain wallet transfer carries the piece -----------------------------------------------
const friend = Keypair.generate();
await fund(friend, 1);
await sendIxs([ix.createAtaIdempotent(friend.publicKey, friend.publicKey, mint.publicKey, TOKEN_2022_PROGRAM), col.openTicket(friend.publicKey, plan.pool)], [friend], "a friend opens a token account and a ticket");
// the trader keeps exactly two units: one piece is no longer backed
const bal = await coins(trader.publicKey);
const send1 = bal - 2n * unit;
await sendIxs([await walletTransfer(trader.publicKey, friend.publicKey, send1)], [trader], "plain transfer built by the standard token library");
check(same(await owned(trader.publicKey), [first, second]), "the sender's list lost its last piece inside the transfer");
check(same(await owned(friend.publicKey), [third]), "the receiver's list holds it: the piece travelled with the coins");
cfg = await col.fetchCollectionConfig(conn, plan.pool);
const liveAfterMove = cfg.live;
check((await col.fetchQueue(conn, plan.pool)).length === 0, "nothing was burned");
check((await coreOwner(third)).equals(trader.publicKey), "the Metaplex asset still shows the sender, until someone delivers it");
const keeper = Keypair.generate();
await fund(keeper, 1);
let upkeep = await client.collectibleUpkeepInstructions(keeper.publicKey, plan.pool);
check(upkeep.length === 1, "the keeper finds one delivery to make");
for (const tx of upkeep) await sendIxs(tx, [keeper], "keeper delivers");
check((await coreOwner(third)).equals(friend.publicKey), "Metaplex shows the friend as the owner");

// through the SDK the receiver's ticket is opened first and the delivery rides along
const fresh = Keypair.generate();
const t2 = await client.collectibleTransferInstructions(trader.publicKey, plan.pool, fresh.publicKey, unit);
check(t2.outcome.moved.length === 1 && t2.outcome.moved[0].equals(second) && t2.outcome.burned.length === 0, "the SDK says beforehand: this transfer moves the second piece");
await sendIxs(t2.instructions, [trader], "SDK transfer to a wallet that never held the coin");
check(same(await owned(fresh.publicKey), [second]) && (await coreOwner(second)).equals(fresh.publicKey), "the piece and its Metaplex asset arrived in one transaction");

// ---- 3. a wallet without a ticket: the piece burns in the transfer --------------------------------
const stranger = Keypair.generate();
await fund(stranger, 1);
await sendIxs([ix.createAtaIdempotent(stranger.publicKey, stranger.publicKey, mint.publicKey, TOKEN_2022_PROGRAM)], [stranger], "a stranger opens a token account, no ticket");
await sendIxs([await walletTransfer(friend.publicKey, stranger.publicKey, await coins(friend.publicKey))], [friend], "the friend sends everything to the stranger, plain transfer");
check((await owned(friend.publicKey)).length === 0, "the friend's piece left its list");
check(await col.fetchTicket(conn, plan.pool, stranger.publicKey) === null, "the stranger got coins and no piece");
cfg = await col.fetchCollectionConfig(conn, plan.pool);
check(cfg.live === liveAfterMove - 1, "the piece stopped existing in that same transfer");
check(same(await col.fetchQueue(conn, plan.pool), [third]), "it waits in the burn queue");
const before = await conn.getBalance(keeper.publicKey);
upkeep = await client.collectibleUpkeepInstructions(keeper.publicKey, plan.pool);
for (const tx of upkeep) await sendIxs(tx, [keeper], "keeper burns the queued asset");
check(await burned(third), "the Metaplex asset is burned");
check((await conn.getBalance(keeper.publicKey)) > before, "its rent paid the keeper");

// ---- 4. a chosen piece with exactly its coins ---------------------------------------------------
await buyAndMint(trader, BigInt(0.6 * LAMPORTS_PER_SOL), "trader buys again");
mine = await owned(trader.publicKey);
check(mine.length >= 3 && mine[0].equals(first), `trader holds ${mine.length} pieces, the first one still in front`);
const spare = (await coins(trader.publicKey)) / unit - BigInt(mine.length);
const tb = await coins(trader.publicKey), fb = await coins(fresh.publicKey);
await sendIxs(await client.collectibleSendInstructions(trader.publicKey, plan.pool, fresh.publicKey, [first]), [trader], "trader sends its FIRST piece with one unit");
check(same(await owned(fresh.publicKey), [second, first]) && (await coreOwner(first)).equals(fresh.publicKey), "exactly that piece arrived, Metaplex asset included");
check((await coins(trader.publicKey)) === tb - unit && (await coins(fresh.publicKey)) === fb + unit, `exactly one unit travelled (the sender had ${spare} unit(s) to spare)`);
check((await owned(trader.publicKey)).length === mine.length - 1, "the sender kept the others");

// ---- 5. a sell burns inside the swap -------------------------------------------------------------
mine = await owned(trader.publicKey);
const sellIn = (await coins(trader.publicKey)) - unit - 1_000_000n;
const peg = await client.collectiblePegAfterSell(trader.publicKey, plan.pool, sellIn);
check(peg.burn.length === mine.length - 1, `the SDK says beforehand: this sell burns ${peg.burn.length} piece(s)`);
const p2 = await client.pool(plan.pool);
const sq = await client.quoteOnChain(trader.publicKey, p2, DIRECTION.SELL, sellIn);
await sendIxs(await client.swapInstructions(trader.publicKey, p2, await client.hookRef(p2, trader.publicKey), DIRECTION.SELL, sellIn, sq), [trader], "sell down to one unit (swap + reap)");
check(same(await owned(trader.publicKey), [mine[0]]), "only the first piece of the list is left");
for (const a of peg.burn) check(await burned(a), "a burned piece's Metaplex asset is gone in the same transaction");
check((await col.fetchQueue(conn, plan.pool)).length === 0, "the burn queue is empty");
cfg = await col.fetchCollectionConfig(conn, plan.pool);
const all = await col.fetchCollectionPieces(conn, plan.pool);
check(all.length === cfg.live, `collection lists ${all.length} living pieces, matching the on-chain counter`);
check((await client.collectibleSettleInstructions(keeper.publicKey, plan.pool, trader.publicKey)).length === 0, "nothing is left for a settle: the peg held in every transfer");
console.log(`pegged e2e passed. pool ${plan.pool.toBase58()}`);
