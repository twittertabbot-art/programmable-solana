// "Collectible per buy" end to end through the SDK on a live cluster.
// Two things are rehearsed:
//  1. What a buy earns is decided by a block that does not exist when the buy is made.
//     Right after a buy the ticket holds pieces with NO seed; two slots later anyone can
//     reveal it; the mint then creates exactly the pieces the revealed seed dictates.
//  2. The pieces are pegged to the coin, the Unipeg rule: a wallet holds at most one piece
//     per unit of coins. A sell burns from the end of the wallet's list, the wallet orders
//     its own list, a piece moves only with its coins, and coins that leave another way
//     take the piece down with them.
//   node scripts/e2e-collectible.mjs <localnet|devnet>
import { createHash } from "node:crypto";
import { Keypair, LAMPORTS_PER_SOL, TransactionInstruction } from "@solana/web3.js";
import { HookpoolClient, NATIVE_MINT, DIRECTION, SYSTEM_PROGRAM, TOKEN_PROGRAM, collectible as col, renderPieceSvg, pieceTraits, hookKindLabel } from "../sdk/dist/index.js";
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
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
/// What the program derives for a piece: sha256(batch seed, roll)[0..16].
const pieceSeedHex = (batchSeed, roll) => createHash("sha256").update(Buffer.from(batchSeed)).update(u32le(roll)).digest().subarray(0, 16).toString("hex");
const isZero = (bytes) => bytes.every((b) => b === 0);
const same = (a, b) => a.length === b.length && a.every((x, i) => x.equals(b[i]));
/// A burned piece keeps its address with one zero byte, so it can never be minted again.
async function burned(address) { const a = await conn.getAccountInfo(address); return !!a && a.data.length === 1 && a.data[0] === 0; }
async function fund(wallet, sol) { await conn.confirmTransaction(await conn.requestAirdrop(wallet.publicKey, sol * LAMPORTS_PER_SOL), "confirmed"); }
/// A plain SPL Token transfer: how a wallet's Send button moves coins, with no piece attached.
function plainTransfer(from, to, owner, amount) {
  const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data });
}
async function buyAndMint(wallet, amount, label) {
  const pool = await client.pool(plan.pool);
  const q = await client.quoteOnChain(wallet.publicKey, pool, DIRECTION.BUY, amount);
  await sendIxs(await client.swapInstructions(wallet.publicKey, pool, await client.hookRef(pool, wallet.publicKey), DIRECTION.BUY, amount, q), [wallet], label);
  const t = await col.fetchTicket(conn, plan.pool, wallet.publicKey);
  const waiting = t.batches.filter((b) => b.pieces > 0);
  if (waiting.length) { await waitPastSlot(waiting.reduce((m, b) => (b.targetSlot > m ? b.targetSlot : m), 0n)); await sendIxs(await client.collectibleMintInstructions(wallet.publicKey, plan.pool), [wallet], label + ": mint"); }
  return q;
}

const ART_A = Uint8Array.from([1, 20, 235, 30, 24, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const ART_B = Uint8Array.from([1, 140, 100, 200, 30, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const mint = Keypair.generate();
const supply = 1_000_000_000n * 1_000_000n;
// 2 SOL against 1B coins: 1 SOL buys roughly 330M coins. One piece per 50M coins.
const unit = 50_000_000n * 1_000_000n;

const plan = await client.launchInstructions({
  dev: dev.publicKey, mint, name: "Shot Coin", symbol: "SHOT", uri: "https://example.com/meta/shot.json", decimals: 6, totalSupply: supply,
  quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: BigInt(2 * LAMPORTS_PER_SOL), devBuyQuote: BigInt(0.3 * LAMPORTS_PER_SOL), minDevBuyOut: 1n,
  template: "collectible",
  collectible: { name: "Shots", uriBase: "http://localhost:8787/art", unit, maxSupply: 1000, maxPerBuy: 3, art: ART_A },
});
await sendIxs(plan.createTx, [dev, mint], "create_token + collection config + dev ticket");
await sendIxs(plan.launchTx, [dev], "launch + dev buy");
const pool = await client.pool(plan.pool);
const info = await client.hookInfo(pool);
check(info.template === "collectible", `pool uses the collectible template (${hookKindLabel(pool.hookKind)})`);
console.log("  hook:", info.summary.sentences.join(" "));
let cfg = await col.fetchCollectionConfig(conn, plan.pool);
check(cfg.name === "Shots" && cfg.maxSupply === 1000 && !cfg.locked, "collection config stored, owner is the dev");
check(cfg.baseMint.equals(mint.publicKey) && cfg.tokenProgram.equals(TOKEN_PROGRAM), "the pool told the hook which coin backs the pieces");

// ---- 1. nobody can know what a buy earns ---------------------------------------------------
let devTicket = await col.fetchTicket(conn, plan.pool, dev.publicKey);
check(devTicket.pending >= 1 && devTicket.minted === 0 && isZero(devTicket.batches[0].seed), `the dev's first buy earned ${devTicket.pending} piece(s), undecided at launch`);
await waitPastSlot(devTicket.batches[0].targetSlot);
await sendIxs(await client.collectibleMintInstructions(dev.publicKey, plan.pool), [dev], "dev reveals and mints");
const devPieces = await col.fetchOwnedPieces(conn, plan.pool, dev.publicKey);
check(devPieces.length === devTicket.pending && devPieces.every((p) => p.owner.equals(dev.publicKey)), `dev holds ${devPieces.length} piece(s) after the reveal`);

const trader = Keypair.generate();
await fund(trader, 3);
const hookRef = await client.hookRef(pool, trader.publicKey);
check(hookRef.extra.length === 3, "SDK resolved config, the trader's ticket and the SlotHashes sysvar from the hook's account list");
const buyIn = BigInt(0.5 * LAMPORTS_PER_SOL);
const quoted = await client.quoteOnChain(trader.publicKey, pool, DIRECTION.BUY, buyIn);
await sendIxs(await client.swapInstructions(trader.publicKey, pool, hookRef, DIRECTION.BUY, buyIn, quoted), [trader], "buy 0.5 SOL (open ticket + swap)");
check((await client.tokenBalance(trader.publicKey, mint.publicKey)) === quoted, "trader received exactly the quoted coins");
const expected = Math.min(3, Number(quoted / unit));
let ticket = await col.fetchTicket(conn, plan.pool, trader.publicKey);
const batch = ticket.batches[0];
check(ticket.pending === expected && expected === 3 && batch.state === col.BATCH.WAITING, `ticket holds ${ticket.pending} undecided pieces, to be decided by the block at slot ${batch.targetSlot}`);
check(isZero(batch.seed), "no seed exists after the buy: nothing a simulation could have shown");
check((await col.fetchOwnedPieces(conn, plan.pool, trader.publicKey)).length === 0, "nothing minted yet");

await waitPastSlot(batch.targetSlot);
const stranger = Keypair.generate();
await fund(stranger, 1);
await sendIxs([col.reveal(stranger.publicKey, plan.pool, trader.publicKey)], [stranger], "a stranger reveals the trader's ticket");
ticket = await col.fetchTicket(conn, plan.pool, trader.publicKey);
const revealed = ticket.batches[0];
check(revealed.state === col.BATCH.REVEALED && !isZero(revealed.seed), "the block hash fixed the seed on chain");
const foretold = Array.from({ length: expected }, (_, i) => pieceSeedHex(revealed.seed, revealed.firstRoll + i));
await sendIxs(await client.collectibleMintInstructions(trader.publicKey, plan.pool), [trader], "trader mints");
let pieces = await col.fetchOwnedPieces(conn, plan.pool, trader.publicKey);
check(pieces.length === expected, `trader holds ${pieces.length} pieces: ${pieces.map((p) => p.name).join(", ")}`);
check(pieces.every((p, i) => p.seed === foretold[i]), "each piece is exactly what the revealed seed dictates, the mint could not change it");
check(pieces.every((p) => p.owner.equals(trader.publicKey) && p.collection.equals(cfg.collection) && p.art === col.hexOf(ART_A)), "pieces are Metaplex Core assets in the pool's collection, owned by the trader");
const svg = renderPieceSvg(pieces[0].art, pieces[0].seed);
check(svg.startsWith("<svg") && svg.length > 500, `renderer draws ${pieces[0].name} from its seed (${pieceTraits(pieces[0].art, pieces[0].seed).rarity})`);
const [first, second, third] = pieces.map((p) => p.address);

// ---- 2. the peg ---------------------------------------------------------------------------------
// The trader holds a little over three units. While the coins are there, nobody can burn.
check((await client.collectibleSettleInstructions(stranger.publicKey, plan.pool, trader.publicKey)).length === 0, "a backed wallet has nothing to settle");
await sendIxs([col.settle(stranger.publicKey, plan.pool, trader.publicKey, col.coinsAddress(trader.publicKey, mint.publicKey), [third])], [stranger], "a stranger tries to burn a backed piece");
check(!(await burned(third)), "the piece is still there: coins in the wallet, no burn");

// The wallet decides what a sell costs it: it moves its first piece to the end of its list.
await sendIxs(await client.collectibleReorderInstructions(trader.publicKey, plan.pool, 0, 2), [trader], "trader moves its first piece to the end");
ticket = await col.fetchTicket(conn, plan.pool, trader.publicKey);
check(same(ticket.owned, [second, third, first]), "the list is now second, third, first");

// Selling down to two units burns exactly one piece, the last of the list, in the same transaction.
const balance = await client.tokenBalance(trader.publicKey, mint.publicKey);
const sellIn = balance - 2n * unit - 1_000_000n;
const peg = await client.collectiblePegAfterSell(trader.publicKey, plan.pool, sellIn);
check(peg.allowed === 2 && peg.burn.length === 1 && peg.burn[0].equals(first), "the SDK tells the seller beforehand: this sell burns one piece, the one it put last");
let p2 = await client.pool(plan.pool);
const sq = await client.quoteOnChain(trader.publicKey, p2, DIRECTION.SELL, sellIn);
await sendIxs(await client.swapInstructions(trader.publicKey, p2, await client.hookRef(p2, trader.publicKey), DIRECTION.SELL, sellIn, sq), [trader], "sell down to two units (swap + settle)");
check(await burned(first), "the sell burned that piece");
ticket = await col.fetchTicket(conn, plan.pool, trader.publicKey);
check(same(ticket.owned, [second, third]) && !(await burned(second)) && !(await burned(third)), "the two pieces the wallet kept in front are untouched");
// The receipt's owner field is what the program trusts, not the number in the account:
// a token account handed to another owner backs nothing. And a wallet above the peg
// cannot reorder its way out of a settle.
cfg = await col.fetchCollectionConfig(conn, plan.pool);
check(cfg.live === devPieces.length + 2 && cfg.minted === devPieces.length + 3, `${cfg.live} pieces exist now, ${cfg.minted} were ever minted`);

// A piece moves only together with its coins.
const friend = Keypair.generate();
await fund(friend, 1);
const tb = await client.tokenBalance(trader.publicKey, mint.publicKey);
await sendIxs(await client.collectibleSendInstructions(trader.publicKey, plan.pool, friend.publicKey, [second]), [trader], "trader sends one piece to a friend");
const friendTicket = await col.fetchTicket(conn, plan.pool, friend.publicKey);
check(friendTicket && same(friendTicket.owned, [second]), "the friend's list holds the piece, its ticket was opened for it");
check((await col.fetchOwnedPieces(conn, plan.pool, friend.publicKey))[0].owner.equals(friend.publicKey), "Metaplex Core shows the friend as the owner");
check((await client.tokenBalance(friend.publicKey, mint.publicKey)) === unit && (await client.tokenBalance(trader.publicKey, mint.publicKey)) === tb - unit, "one unit of coins travelled with it");

// Coins that leave any other way do not keep the piece alive, and they do not carry it.
await sendIxs([plainTransfer(col.coinsAddress(friend.publicKey, mint.publicKey), col.coinsAddress(trader.publicKey, mint.publicKey), friend.publicKey, unit)], [friend], "the friend moves the coins out with a plain transfer");
const before = await conn.getBalance(stranger.publicKey);
const settleIxs = await client.collectibleSettleInstructions(stranger.publicKey, plan.pool, friend.publicKey);
check(settleIxs.length === 2, "the friend's wallet is now above the peg: anyone may settle it");
await sendIxs(settleIxs, [stranger], "a stranger settles the friend's wallet");
check(await burned(second), "the piece left behind was burned");
check((await conn.getBalance(stranger.publicKey)) > before, "the rent of the burned piece paid the stranger for settling");
check((await col.fetchTicket(conn, plan.pool, trader.publicKey)).owned.length === 1, "the coins arrived at the trader without any piece");

// ---- 3. the launcher changes the art: old pieces stay, new ones differ ------------------------
await sendIxs([col.updateCollection(dev.publicKey, plan.pool, { name: "Shots II", art: ART_B })], [dev], "launcher updates name and art");
await buyAndMint(trader, buyIn, "second buy after the update");
pieces = await col.fetchOwnedPieces(conn, plan.pool, trader.publicKey);
const oldOnes = pieces.filter((p) => p.address.equals(third)), newOnes = pieces.filter((p) => !p.address.equals(third));
check(newOnes.length > 0 && newOnes.every((p) => p.art === col.hexOf(ART_B) && p.name.startsWith("Shots II #")), `new pieces use the new art and name (${newOnes.map((p) => p.name).join(", ")})`);
check(oldOnes.length === 1 && oldOnes[0].art === col.hexOf(ART_A) && oldOnes[0].name.startsWith("Shots #"), "the piece minted before the update is unchanged");
check(pieces[0].address.equals(third), "new pieces join the end of the list: they are the first to burn");

// lock forever
await sendIxs([col.setCollectionOwner(dev.publicKey, plan.pool, SYSTEM_PROGRAM)], [dev], "launcher locks the collection");
cfg = await col.fetchCollectionConfig(conn, plan.pool);
check(cfg.locked, "collection is locked");
let refused = false;
try { await sendIxs([col.updateCollection(dev.publicKey, plan.pool, { art: ART_A })], [dev], "update after lock (must fail)"); } catch { refused = true; }
check(refused, "an update after the lock is refused");
const all = await col.fetchCollectionPieces(conn, plan.pool);
check(all.length === cfg.live, `collection lists ${all.length} living pieces, matching the on-chain counter`);
console.log(`collectible e2e passed. pool ${plan.pool.toBase58()}`);
