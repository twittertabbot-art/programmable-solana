// One approval on a collectible coin: the deposit the buy pays into the buyer's own ticket,
// the builders of mint_for and withdraw_deposit, and what a buy must deposit. Offline.
// Runs on the built bundle:
//   npm run build -w sdk && npm test -w sdk
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, ACCOUNT_DISC, IX, PROGRAMS, NATIVE_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, poolKeys, collectible as col } from "../dist/index.js";

const key = () => Keypair.generate().publicKey;
const SHOTS = { name: "Shots", uriBase: "https://example.com/art", minted: 0 };
const ix = (i, name) => i.programId.equals(PROGRAMS.hook_collectible) && Buffer.from(i.data).subarray(0, 8).equals(Buffer.from(IX.hook_collectible[name]));
const isTransfer = (i) => i.programId.equals(SystemProgram.programId) && Buffer.from(i.data).readUInt32LE(0) === 2;
const transferLamports = (i) => Buffer.from(i.data).readBigUInt64LE(4);

test("the deposit is a plain SOL transfer from the wallet to its own ticket, and nothing else", () => {
  const user = key(), pool = key();
  const t = col.depositTransfer(user, pool, 1_234_567n);
  assert.ok(t.programId.equals(SystemProgram.programId));
  assert.equal(Buffer.from(t.data).readUInt32LE(0), 2, "SystemProgram Transfer");
  assert.equal(transferLamports(t), 1_234_567n);
  assert.equal(t.keys.length, 2);
  assert.ok(t.keys[0].pubkey.equals(user) && t.keys[0].isSigner && t.keys[0].isWritable);
  assert.ok(t.keys[1].pubkey.equals(col.collectiblePda.ticket(pool, user)) && !t.keys[1].isSigner && t.keys[1].isWritable, "the destination is the wallet's ticket on that pool");
  assert.throws(() => col.depositTransfer(user, pool, 0n), /at least one lamport/);
});

test("mint_for names the wallet as the owner, never as a signer, and the wallet's next asset addresses", () => {
  const payer = key(), pool = key(), user = key(), coins = key();
  const m = col.mintFor(payer, pool, user, 7, 3, coins);
  assert.ok(ix(m, "mint_for"));
  assert.equal(m.data.length, 8, "no arguments: it mints every decided piece, up to four");
  const want = [
    [payer, true, true], [user, false, false], [col.collectiblePda.cfg(pool), false, true], [col.collectiblePda.ticket(pool, user), false, true], [coins, false, false],
    [col.collectiblePda.collection(pool), false, true], [col.collectiblePda.authority(pool), false, false], [col.MPL_CORE, false, false], [SYSTEM_PROGRAM, false, false],
    [col.SLOT_HASHES, false, false],
    [col.collectiblePda.asset(pool, user, 7), false, true], [col.collectiblePda.asset(pool, user, 8), false, true], [col.collectiblePda.asset(pool, user, 9), false, true],
  ];
  assert.equal(m.keys.length, want.length);
  want.forEach(([k, s, w], i) => assert.deepEqual([m.keys[i].pubkey.toBase58(), m.keys[i].isSigner, m.keys[i].isWritable], [k.toBase58(), s, w], `account ${i}`));
  const wd = col.withdrawDeposit(user, pool);
  assert.ok(ix(wd, "withdraw_deposit"));
  assert.deepEqual(wd.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[user.toBase58(), true, true], [col.collectiblePda.ticket(pool, user).toBase58(), false, true]]);
});

test("what a piece costs: the asset at this collection's real size, Core's fee, 32 bytes of ticket, one keeper fee", () => {
  const rent = col.STANDARD_RENT;
  assert.equal(rent(0), 890_880n);
  assert.equal(col.ticketSpace(0), 346);
  assert.equal(col.pieceAssetSize(SHOTS, 1), 75 + "Shots #1".length + "https://example.com/art".length + 68);
  // the exact cost of three pieces through mint_for, as the chain charged it in tests/tests/deposit.rs
  assert.equal(col.mintForCost(rent, SHOTS, 346, 0, 3), 11_483_920n);
  // what a buy deposits for them, on a LOCKED collection: the real name and address, the number at ten
  // digits, a fee per piece
  const LOCKED = { ...SHOTS, locked: true };
  const need = col.mintDepositFor(rent, LOCKED, 3);
  assert.equal(col.depositAssetSize(LOCKED), 75 + "Shots #".length + 10 + 23 + 68);
  assert.equal(need, 3n * (rent(75 + "Shots #".length + 10 + 23 + 68) + 1_500_000n + 32n * 6_960n + 10_000n));
  assert.ok(need >= col.mintForCost(rent, SHOTS, 346, 0, 3) && need - col.mintForCost(rent, SHOTS, 346, 0, 3) < 250_000n, "covers it, with a small margin");
  // one piece at a time costs a fee each: still covered
  let fees = 0n; for (let i = 0; i < 3; i++) fees += col.mintForCost(rent, { ...SHOTS, minted: i }, col.ticketSpace(i), i, 1);
  assert.ok(need >= fees);
  assert.equal(col.mintDepositFor(rent, SHOTS, 0), 0n);
  // a longer address costs more, byte for byte, on a locked collection
  assert.equal(col.mintDepositFor(rent, { ...LOCKED, uriBase: SHOTS.uriBase + "/xyz" }, 1) - col.mintDepositFor(rent, LOCKED, 1), 4n * 6_960n);
  assert.equal(col.mintDepositFor(rent, SHOTS, 1, { coreFee: 0n }), col.mintDepositFor(rent, SHOTS, 1) - 1_500_000n);
});

test("review L2: the deposit holds however many pieces others mint first, up to the last number a u32 has", () => {
  const rent = col.STANDARD_RENT;
  const LOCKED = { ...SHOTS, locked: true };
  // the deposit is sized when the buy is made, at minted 0; the keeper may come after 100, 10,000 or 4 billion
  // other pieces were minted: the numbers grow to three, five or ten digits
  const need = col.mintDepositFor(rent, LOCKED, 3);
  for (const minted of [0, 7, 97, 100, 9_995, 999_999, 4_294_967_290]) {
    assert.ok(need >= col.mintForCost(rent, { ...LOCKED, minted }, 346, 0, 3), `minted ${minted}`);
    // one at a time too: a fee each
    let fees = 0n; for (let i = 0; i < 3; i++) fees += col.mintForCost(rent, { ...LOCKED, minted: minted + i }, col.ticketSpace(i), i, 1);
    assert.ok(need >= fees, `minted ${minted}, one at a time`);
  }
  // the reviewer's case: a hundred pieces minted before the keeper, three pieces
  assert.ok(need - col.mintForCost(rent, { ...LOCKED, minted: 100 }, 346, 0, 3) >= 0n);
  // what the ten digits cost over the old sizing: at most nine bytes of rent a piece
  assert.ok(col.mintDepositFor(rent, LOCKED, 1) - (rent(75 + "Shots #1".length + 23 + 68) + 1_500_000n + 32n * 6_960n + 10_000n) <= 9n * 6_960n);
});

test("review I2: while the collection is not locked, a deposit is sized for the longest name and address its owner may set", () => {
  const rent = col.STANDARD_RENT;
  const open = { ...SHOTS, locked: false };
  assert.equal(col.depositAssetSize(open), 75 + 24 + 2 + 10 + 80 + 68);
  assert.equal(col.depositAssetSize(SHOTS), col.depositAssetSize(open), "a config without `locked` counts as not locked");
  const need = col.mintDepositFor(rent, open, 3);
  // the owner lengthens both to the most the program takes, then the keeper mints: still covered
  const longest = { name: "N".repeat(24), uriBase: "https://" + "a".repeat(72), minted: 100 };
  assert.ok(need >= col.mintForCost(rent, longest, 346, 0, 3));
  // a locked collection keeps its sizes: its deposit is smaller
  assert.ok(col.mintDepositFor(rent, { ...SHOTS, locked: true }, 3) < need);
  // what it costs over a locked collection with the site's address: about 0.0006 SOL a piece, all of it withdrawable
  const extra = need - col.mintDepositFor(rent, { name: "Path 683", uriBase: "http://localhost:8787/art", locked: true }, 3);
  assert.ok(extra > 0n && extra / 3n < 700_000n, String(extra));
  // a decoded config carries `locked`
  assert.equal(col.decodeCollectionConfig(cfgBytes(key(), key())).locked, false);
});

test("review I1: nextAssets names the asset addresses the waiting pieces get from the next mint, newest first", () => {
  const pool = key(), user = key();
  const t = ticketOf([batch(1, 3, 0, 9n)], 5);
  const a = col.nextAssets(pool, user, t, 3);
  assert.deepEqual(a.map((k) => k.toBase58()), [7, 6, 5].map((i) => col.collectiblePda.asset(pool, user, i).toBase58()));
  assert.deepEqual(col.nextAssets(pool, user, t, 1).map((k) => k.toBase58()), [col.collectiblePda.asset(pool, user, 7).toBase58()], "the one a sell removes first");
  assert.deepEqual(col.nextAssets(pool, user, t, 0), []);
  // one mint makes four at most: a wallet with six waiting gets the first four minted
  const six = ticketOf([batch(1, 3, 0, 9n), batch(1, 3, 3, 9n)], 0);
  assert.deepEqual(col.nextAssets(pool, user, six, 6).map((k) => k.toBase58()), [3, 2, 1, 0].map((i) => col.collectiblePda.asset(pool, user, i).toBase58()));
});

test("mintDepositFor reads the chain's rent when given a connection", async () => {
  const conn = { async getMinimumBalanceForRentExemption(n) { return (n + 128) * 6_960; } };
  assert.equal(await col.mintDepositFor(conn, SHOTS, 2), col.mintDepositFor(col.STANDARD_RENT, SHOTS, 2));
  const doubled = { async getMinimumBalanceForRentExemption(n) { return (n + 128) * 13_920; } };
  assert.ok((await col.mintDepositFor(doubled, SHOTS, 2)) > col.mintDepositFor(col.STANDARD_RENT, SHOTS, 2));
});

test("the deposit of a ticket is what it holds above its rent, and 0 without a ticket", async () => {
  assert.equal(col.depositOf(col.STANDARD_RENT(346) + 5n, 346, col.STANDARD_RENT), 5n);
  assert.equal(col.depositOf(100, 346, col.STANDARD_RENT), 0n, "never negative");
  // review R1 round 9: no default rent. A caller that leaves it out is told so instead of getting the local chain's number.
  assert.throws(() => col.depositOf(100, 346), /needs the chain's rent/);
  const pool = key(), user = key();
  let rentReads = 0;
  const conn = {
    async getAccountInfo(k) { return k.equals(col.collectiblePda.ticket(pool, user)) ? { lamports: Number(col.STANDARD_RENT(378)) + 777, data: new Uint8Array(378) } : null; },
    async getMinimumBalanceForRentExemption(n) { rentReads++; return (n + 128) * 6_960; },
  };
  assert.equal(await col.ticketDeposit(conn, pool, user), 777n, "the chain's rent is read when none is given");
  assert.equal(rentReads, 2);
  assert.equal(await col.ticketDeposit(conn, pool, key(), col.STANDARD_RENT), 0n);
  assert.equal(rentReads, 2, "a rent given is not read again");
});

// Mainnet's Rent sysvar: 5,080 lamports per byte-year at an exemption threshold of 1.0, so 5,080 a byte over the 128
// bytes of overhead. A local validator and LiteSVM charge 6,960 a byte, which is why rehearsals matched the chain to
// the lamport and mainnet did not (review R1, round 9).
const MAINNET_RENT = (n) => 650_240n + 5_080n * BigInt(n);
test("review R1 round 9: at mainnet's rent a deposit is sized at 5,080 a byte, and a ticket's deposit is read at it", async () => {
  assert.equal(MAINNET_RENT(0), 650_240n);
  assert.equal(MAINNET_RENT(346), 2_407_920n, "an empty ticket");
  // one piece on a collection that is not locked: the asset at 259 bytes, Core's fee, 32 bytes of ticket, the keeper fee
  const open = { name: "Shots", uriBase: "https://example.com/art", locked: false };
  assert.equal(col.depositAssetSize(open), 259);
  assert.equal(col.mintDepositFor(MAINNET_RENT, open, 1), 3_638_520n, "what the live chain needs for one piece");
  assert.equal(col.mintDepositFor(col.STANDARD_RENT, open, 1), 4_426_240n, "what the local rent sized it at: 787,720 too much");
  assert.equal(col.mintDepositFor(MAINNET_RENT, open, 3), 10_915_560n);
  // the same ticket read at the two rents: the local rent understates the deposit by (346 + 128) * 1,880
  const lamports = MAINNET_RENT(346) + 891_120n;
  assert.equal(col.depositOf(lamports, 346, MAINNET_RENT), 891_120n);
  assert.equal(col.depositOf(lamports, 346, col.STANDARD_RENT), 0n, "the local rent says there is no deposit");
  assert.equal(col.depositOf(MAINNET_RENT(378) + 1n, 378, MAINNET_RENT), 1n);
  // mint_for of three pieces into an empty ticket, at mainnet's rent: covered by the deposit of three
  const cfg = { ...SHOTS, minted: 0 };
  const cost = col.mintForCost(MAINNET_RENT, cfg, 346, 0, 3);
  assert.ok(cost > 0n && cost <= col.mintDepositFor(MAINNET_RENT, { ...cfg, locked: true }, 3), String(cost));
  // ticketDeposit and a client on a chain with mainnet's rent
  const pool = key(), user = key();
  let reads = 0;
  const conn = {
    async getAccountInfo(k) { return k.equals(col.collectiblePda.ticket(pool, user)) ? { lamports: Number(lamports), data: new Uint8Array(346) } : null; },
    async getMinimumBalanceForRentExemption(n) { reads++; return Number(MAINNET_RENT(n)); },
  };
  assert.equal(await col.ticketDeposit(conn, pool, user), 891_120n);
  const client = new HookpoolClient(conn);
  const rent = await client.rent();
  assert.equal(rent(346), 2_407_920n);
  const w = await client.collectibleWithdrawInstructions(user, pool);
  assert.equal(w.length, 1, "there is a deposit to withdraw at mainnet's rent (the local rent would have said none)");
  assert.ok(ix(w[0], "withdraw_deposit"));
  assert.equal(reads, 4, "the client read the rent once (two reads) and kept it; ticketDeposit alone read it once more");
  const r2 = await client.rent();
  assert.equal(r2, rent, "the same function again, from the cache");
  assert.equal(reads, 4);
});

const batch = (state, pieces, firstRoll, targetSlot) => ({ state, pieces, mintedFrom: 0, firstRoll, targetSlot, seed: new Uint8Array(32), art: new Uint8Array(16) });
const ticketOf = (batches, owned = 0) => ({ bump: 0, pool: key(), user: key(), minted: owned, rolls: 0, staged: 0, stagedSlot: 0n, batches, owned: Array.from({ length: owned }, key), pending: batches.reduce((n, b) => n + b.pieces, 0) });
const CFG = { unit: 2_000n, maxPerBuy: 3, maxSupply: 1_000, live: 0, reservedPending: 0 };

test("piecesEarned: one per unit, at most max_per_buy, within the supply left and the wallet's 200", () => {
  assert.equal(col.piecesEarned(CFG, null, 9_870n), 3);
  assert.equal(col.piecesEarned(CFG, null, 3_999n), 1);
  assert.equal(col.piecesEarned(CFG, null, 1_999n), 0);
  assert.equal(col.piecesEarned({ ...CFG, live: 998, reservedPending: 1 }, null, 9_870n), 1, "one left in the collection");
  assert.equal(col.piecesEarned(CFG, ticketOf([batch(1, 1, 0, 9n)], 198), 9_870n), 1, "room for one in the wallet");
  assert.equal(col.piecesEarned({ ...CFG, unit: 0n }, null, 9_870n), 0);
});

test("mintDepositTopUp: what every waiting piece needs, less what the ticket holds", () => {
  const rent = col.STANDARD_RENT;
  const t = ticketOf([batch(2, 2, 0, 10n)]);
  const need = col.mintDepositFor(rent, SHOTS, 5);
  assert.equal(col.mintDepositTopUp(rent, SHOTS, t, 0n, 3), need);
  assert.equal(col.mintDepositTopUp(rent, SHOTS, t, need - 10n, 3), 10n);
  assert.equal(col.mintDepositTopUp(rent, SHOTS, t, need + 10n, 3), 0n);
  assert.equal(col.mintDepositTopUp(rent, SHOTS, null, 0n, 3), col.mintDepositFor(rent, SHOTS, 3));
});

test("mintForCount: what mint_for mints now, after dropping what the coins no longer back, newest first", () => {
  // two batches: 3 decided pieces (rolls 0..3, block 102), 2 undecided (rolls 3..5, block 200)
  const t = ticketOf([batch(1, 3, 0, 102n), batch(1, 2, 3, 200n)]);
  assert.deepEqual(col.mintForCount(t, 103n, 10_000n, 2_000n), { n: 3, dropped: 0 });
  assert.deepEqual(col.mintForCount(t, 102n, 10_000n, 2_000n), { n: 0, dropped: 0 }, "the block is not there yet");
  assert.deepEqual(col.mintForCount(t, 201n, 10_000n, 2_000n), { n: 4, dropped: 0 }, "four at most per call");
  assert.deepEqual(col.mintForCount(t, 103n, 4_000n, 2_000n), { n: 2, dropped: 3 }, "the undecided batch goes first, then the last roll of the other");
  assert.deepEqual(col.mintForCount(t, 300n, 0n, 2_000n), { n: 0, dropped: 5 });
});

// ---- swapInstructions with the deposit -----------------------------------------------------

function cfgBytes(pool, mint, minted = 0) {
  const name = Buffer.from(SHOTS.name), uri = Buffer.from(SHOTS.uriBase);
  const b = Buffer.alloc(8 + 3 + 32 * 6 + 1 + 8 + 4 * 4 + 1 + 2 + 16 + 4 + name.length + 4 + uri.length);
  let o = 0;
  Buffer.from(ACCOUNT_DISC.CollectionConfig).copy(b, o); o += 8;
  o += 3;
  for (const k of [pool, key(), key(), col.collectiblePda.collection(pool), mint, TOKEN_PROGRAM]) { k.toBuffer().copy(b, o); o += 32; }
  b[o++] = 0;
  b.writeBigUInt64LE(2_000_000_000n, o); o += 8;
  for (const x of [1_000, minted, 0, 0]) { b.writeUInt32LE(x, o); o += 4; }
  b[o++] = 3; b.writeUInt16LE(1, o); o += 2; o += 16;
  b.writeUInt32LE(name.length, o); o += 4; name.copy(b, o); o += name.length;
  b.writeUInt32LE(uri.length, o); o += 4; uri.copy(b, o);
  return b;
}
function ticketBytes(pool, user, pending, owned = 0) {
  const b = Buffer.alloc(col.ticketSpace(owned));
  Buffer.from(ACCOUNT_DISC.Ticket).copy(b, 0);
  pool.toBuffer().copy(b, 9); user.toBuffer().copy(b, 41);
  b.writeUInt32LE(owned, 73);
  if (pending > 0) { b[90] = 2; b[91] = pending; b.writeBigUInt64LE(50n, 97); }
  b.writeUInt32LE(owned, 342);
  return b;
}
/// A collectible pool against wrapped SOL, and a connection holding its config and, when
/// asked, the wallet's ticket with `deposit` above its rent.
function world({ ticket = null } = {}) {
  const mint = key();
  const k = poolKeys(mint, NATIVE_MINT);
  const pool = {
    address: k.pool, bump: 255, baseMint: mint, quoteMint: NATIVE_MINT, baseVault: k.baseVault, quoteVault: k.quoteVault, lpMint: k.lpMint, lpLock: k.lpLock,
    baseTokenProgram: TOKEN_PROGRAM, quoteTokenProgram: TOKEN_PROGRAM, lpFeeBps: 100, hookProgram: PROGRAMS.hook_collectible, hookFlags: 0, hookExtraMetas: SYSTEM_PROGRAM,
    hookQuoteTreasury: SYSTEM_PROGRAM, hookKind: 0, protocolFeesBase: 0n, protocolFeesQuote: 0n, hookFeesQuoteTotal: 0n, volumeQuoteTotal: 0n, swapCount: 0n,
    createdSlot: 1n, creator: SYSTEM_PROGRAM, hookFeesOwedQuote: 0n, hookTreasuryOwner: SYSTEM_PROGRAM, hasHook: true, reserveBase: 1_000_000_000_000n, reserveQuote: 100_000_000_000n,
    virtualQuote: 0n, graduationTarget: 0n, graduationFeeBps: 0, curveState: 0,
  };
  const user = key();
  const cfgKey = col.collectiblePda.cfg(pool.address).toBase58();
  const ticketKey = col.collectiblePda.ticket(pool.address, user).toBase58();
  const cfgData = cfgBytes(pool.address, mint);
  const tdata = ticket ? ticketBytes(pool.address, user, ticket.pending) : null;
  const look = (k) => {
    const s = k.toBase58();
    if (s === cfgKey) return { data: cfgData, owner: PROGRAMS.hook_collectible, lamports: 1 };
    if (s === ticketKey && tdata) return { data: tdata, owner: PROGRAMS.hook_collectible, lamports: Number(col.STANDARD_RENT(tdata.length) + ticket.deposit) };
    return null;
  };
  // the chain's rent, read by the client once: the local validator's numbers, which the tickets above are sized at
  const conn = { async getAccountInfo(k) { return look(k); }, async getMultipleAccountsInfo(keys) { return keys.map(look); }, async getMinimumBalanceForRentExemption(n) { return (n + 128) * 6_960; } };
  return { pool, user, conn };
}
const hookRef = (pool, user) => ({ program: PROGRAMS.hook_collectible, treasury: SYSTEM_PROGRAM, extra: col.callbackExtras(pool.address, user) });

test("a buy with the deposit: open the ticket, swap, then the deposit; one signature, and off unless asked", async () => {
  const { pool, user, conn } = world();
  const client = new HookpoolClient(conn);
  const ixs = await client.swapInstructions(user, pool, hookRef(pool, user), DIRECTION.BUY, 1_000_000_000n, 0n, { mintDeposit: { pieces: 3 } });
  const open = ixs.findIndex((i) => ix(i, "open_ticket"));
  const swap = ixs.findIndex((i) => i.programId.equals(PROGRAMS.hookpool));
  const dep = ixs.findIndex((i) => isTransfer(i) && i.keys[1].pubkey.equals(col.collectiblePda.ticket(pool.address, user)));
  assert.ok(open >= 0 && open < swap && swap < dep, "the ticket is opened before the swap, the deposit comes after it");
  assert.equal(transferLamports(ixs[dep]), col.mintDepositFor(col.STANDARD_RENT, SHOTS, 3));
  const signers = new Set(ixs.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
  assert.deepEqual([...signers], [user.toBase58()], "the wallet is the only signer");
  // the same buy without the option has no deposit
  const plain = await client.swapInstructions(user, pool, hookRef(pool, user), DIRECTION.BUY, 1_000_000_000n, 0n);
  assert.equal(plain.filter((i) => isTransfer(i) && i.keys[1].pubkey.equals(col.collectiblePda.ticket(pool.address, user))).length, 0);
  // the pieces counted from the caller's quote: 9,870 coins at 2,000 a piece, max 3
  const fromQuote = await client.swapInstructions(user, pool, hookRef(pool, user), DIRECTION.BUY, 1_000_000_000n, 0n, { mintDeposit: { amountOut: 3_999_000_000n } });
  assert.equal(transferLamports(fromQuote.find((i) => isTransfer(i) && i.keys[1].pubkey.equals(col.collectiblePda.ticket(pool.address, user)))), col.mintDepositFor(col.STANDARD_RENT, SHOTS, 1));
  // a buy that earns nothing deposits nothing
  const none = await client.swapInstructions(user, pool, hookRef(pool, user), DIRECTION.BUY, 1_000_000_000n, 0n, { mintDeposit: { amountOut: 1_000n } });
  assert.equal(none.filter((i) => isTransfer(i) && i.keys[1].pubkey.equals(col.collectiblePda.ticket(pool.address, user))).length, 0);
  // a buy paid out to another wallet opens no ticket and deposits nothing
  const forOther = await client.swapInstructions(user, pool, hookRef(pool, user), DIRECTION.BUY, 1_000_000_000n, 0n, { recipient: key(), mintDeposit: { pieces: 3 } });
  assert.equal(forOther.filter((i) => isTransfer(i) && i.keys[1].pubkey.equals(col.collectiblePda.ticket(pool.address, user))).length, 0);
});

test("a buy by a wallet with pieces waiting and a deposit tops up only the difference, and leaves the earlier pieces to the keeper", async () => {
  const rent = col.STANDARD_RENT;
  const need = col.mintDepositFor(rent, SHOTS, 2 + 3);
  const { pool, user, conn } = world({ ticket: { pending: 2, deposit: 1_000_000n } });
  const client = new HookpoolClient(conn);
  const ixs = await client.swapInstructions(user, pool, hookRef(pool, user), DIRECTION.BUY, 1_000_000_000n, 0n, { mintDeposit: { pieces: 3 } });
  const dep = ixs.findIndex((i) => isTransfer(i) && i.keys[1].pubkey.equals(col.collectiblePda.ticket(pool.address, user)));
  assert.ok(dep > ixs.findIndex((i) => i.programId.equals(PROGRAMS.hookpool)), "the deposit comes after the swap");
  assert.equal(ixs.filter((i) => ix(i, "mint")).length, 0, "no mint of the earlier pieces: the keeper mints them, and the two could meet");
  assert.equal(transferLamports(ixs[dep]), need - 1_000_000n, "the deposit covers the earlier pieces and this buy's");
  assert.equal(ixs.filter((i) => ix(i, "open_ticket")).length, 0, "the ticket is already open");
  // review L1: without the deposit the buy carries no mint either. A mint inside a buy that meets anybody's
  // mint_for (the wallet's ticket holds a deposit) names the wrong asset and fails the whole buy.
  const plain = await client.swapInstructions(user, pool, hookRef(pool, user), DIRECTION.BUY, 1_000_000_000n, 0n);
  assert.equal(plain.filter((i) => ix(i, "mint")).length, 0);
  const noDeposit = world({ ticket: { pending: 2, deposit: 0n } });
  const old = await new HookpoolClient(noDeposit.conn).swapInstructions(noDeposit.user, noDeposit.pool, hookRef(noDeposit.pool, noDeposit.user), DIRECTION.BUY, 1_000_000_000n, 0n);
  assert.equal(old.filter((i) => ix(i, "mint")).length, 0, "never, also on a ticket with no deposit");
  // a deposit that already covers everything adds nothing
  const rich = world({ ticket: { pending: 2, deposit: need } });
  const enough = await new HookpoolClient(rich.conn).swapInstructions(rich.user, rich.pool, hookRef(rich.pool, rich.user), DIRECTION.BUY, 1_000_000_000n, 0n, { mintDeposit: { pieces: 3 } });
  assert.equal(enough.filter((i) => isTransfer(i) && i.keys[1].pubkey.equals(col.collectiblePda.ticket(rich.pool.address, rich.user))).length, 0);
});

test("review I1: a sell that drops waiting pieces names their next asset addresses in its settle", async () => {
  const { pool, user, conn } = world({ ticket: { pending: 3, deposit: 5_000_000n } });
  const ixs = await new HookpoolClient(conn).swapInstructions(user, pool, hookRef(pool, user), DIRECTION.SELL, 1_000n, 0n);
  const s = ixs.find((i) => ix(i, "settle"));
  assert.ok(s, "the sell settles the wallet in the same transaction");
  // payer, config, ticket, coins, collection, authority, Core, system program, then the names
  assert.deepEqual(s.keys.slice(8).map((k) => [k.pubkey.toBase58(), k.isWritable]), [2, 1, 0].map((i) => [col.collectiblePda.asset(pool.address, user, i).toBase58(), true]),
    "the three waiting pieces' next addresses, newest first: if a keeper mints them before the sell lands, the sell burns them and the seller gets their rent");
});

test("collectibleBuyDeposit and collectibleWithdrawInstructions read the ticket as the chain does", async () => {
  const { pool, user, conn } = world({ ticket: { pending: 1, deposit: 5_000n } });
  const client = new HookpoolClient(conn);
  const d = await client.collectibleBuyDeposit(user, pool.address, 9_870_000_000n);
  assert.deepEqual({ pieces: d.pieces, deposit: d.deposit }, { pieces: 3, deposit: 5_000n });
  assert.equal(d.need, col.mintDepositFor(col.STANDARD_RENT, SHOTS, 4));
  assert.equal(d.topUp, d.need - 5_000n);
  const w = await client.collectibleWithdrawInstructions(user, pool.address);
  assert.equal(w.length, 1);
  assert.ok(ix(w[0], "withdraw_deposit"));
  const empty = world({ ticket: { pending: 0, deposit: 0n } });
  assert.deepEqual(await new HookpoolClient(empty.conn).collectibleWithdrawInstructions(empty.user, empty.pool.address), []);
});

// ---- what withdraw_deposit pays: the program first shrinks the ticket to its list ------------

/// A ticket of `length` bytes whose list holds `owned` pieces. A length above ticketSpace(owned) is a ticket an
/// earlier version of the program left long: it grew for pieces that left its list later, and never shrank.
function longTicket(pool, user, owned, length) {
  const b = Buffer.alloc(length);
  ticketBytes(pool, user, 0, owned).copy(b, 0);
  return b;
}

test("withdrawableDeposit: the deposit at the size the ticket shrinks to, exactly its list, at the local and at mainnet's rent", () => {
  for (const [rent, perByte, label] of [[col.STANDARD_RENT, 6_960n, "local rent"], [MAINNET_RENT, 5_080n, "mainnet rent"]]) {
    // a ticket that fits its list: the same number as depositOf
    const fit = col.ticketSpace(3);
    assert.equal(col.withdrawableDeposit(rent(fit) + 7n, fit, 3, rent), 7n, label);
    assert.equal(col.withdrawableDeposit(rent(fit) + 7n, fit, 3, rent), col.depositOf(rent(fit) + 7n, fit, rent), label);
    // a ticket an older binary left two entries long: nothing above the rent of its length, yet the withdraw pays both entries
    const long = col.ticketSpace(3);
    assert.equal(col.depositOf(rent(long), long, rent), 0n, label + ": nothing above the rent of its length");
    assert.equal(col.withdrawableDeposit(rent(long), long, 1, rent), 64n * perByte, label + ": the rent of the two unused entries");
    assert.equal(col.withdrawableDeposit(rent(long) + 1_000n, long, 1, rent), 64n * perByte + 1_000n, label + ": and the deposit on top");
    // a list a sell emptied under the old binary: every entry comes back
    assert.equal(col.withdrawableDeposit(rent(col.ticketSpace(5)), col.ticketSpace(5), 0, rent), 5n * 32n * perByte, label);
    // a ticket shorter than its list cannot exist; one would be read at its own length, never grown
    assert.equal(col.withdrawableDeposit(rent(346) + 9n, 346, 2, rent), 9n, label);
    assert.equal(col.withdrawableDeposit(100, long, 1, rent), 0n, label + ": never negative");
  }
  // 32 bytes of ticket: 162,560 lamports on mainnet, 222,720 on a local validator
  assert.equal(col.withdrawableDeposit(MAINNET_RENT(378), 378, 0, MAINNET_RENT), 162_560n);
  assert.equal(col.withdrawableDeposit(col.STANDARD_RENT(378), 378, 0, col.STANDARD_RENT), 222_720n);
  // a list of one in a ticket of three entries: 445,440 lamports locally, 325,120 on mainnet
  assert.equal(col.ticketSpace(3), 442);
  assert.equal(col.withdrawableDeposit(col.STANDARD_RENT(442), 442, 1, col.STANDARD_RENT), 445_440n);
  assert.equal(col.withdrawableDeposit(MAINNET_RENT(442), 442, 1, MAINNET_RENT), 325_120n);
  assert.throws(() => col.withdrawableDeposit(1, 346, -1, col.STANDARD_RENT), /number of pieces/);
  assert.throws(() => col.withdrawableDeposit(1, 346, 1.5, col.STANDARD_RENT), /number of pieces/);
  assert.throws(() => col.withdrawableDeposit(1, 346, 0), /needs the chain's rent/);
});

test("ticketDeposit and collectibleWithdrawInstructions count the rent of a long ticket's unused entries, at both rents", async () => {
  for (const [rentOf, perByte, label] of [[col.STANDARD_RENT, 6_960n, "local"], [MAINNET_RENT, 5_080n, "mainnet"]]) {
    const pool = key(), user = key();
    let data = longTicket(pool, user, 1, col.ticketSpace(3));
    let lamports = rentOf(data.length);
    const conn = {
      async getAccountInfo(k) { return k.equals(col.collectiblePda.ticket(pool, user)) ? { lamports: Number(lamports), data, owner: PROGRAMS.hook_collectible } : null; },
      async getMinimumBalanceForRentExemption(n) { return Number(rentOf(n)); },
    };
    const client = new HookpoolClient(conn);
    const rent = await client.rent();
    assert.equal(col.depositOf(lamports, data.length, rent), 0n, label + ": read at its length there is no deposit, and no withdraw was offered");
    assert.equal(await col.ticketDeposit(conn, pool, user), 64n * perByte, label + ": withdraw_deposit pays the two unused entries");
    const w = await client.collectibleWithdrawInstructions(user, pool);
    assert.equal(w.length, 1, label + ": the withdraw is offered");
    assert.ok(ix(w[0], "withdraw_deposit"));
    // after the withdraw the ticket fits its list and holds exactly its rent: nothing is offered
    data = longTicket(pool, user, 1, col.ticketSpace(1));
    lamports = rentOf(data.length);
    assert.equal(await col.ticketDeposit(conn, pool, user), 0n, label);
    assert.deepEqual(await client.collectibleWithdrawInstructions(user, pool), [], label);
    // a sell that burned the last piece under the shrinking program: the ticket is 346 bytes and the entry's rent is its deposit
    data = longTicket(pool, user, 0, col.ticketSpace(0));
    lamports = rentOf(col.ticketSpace(1));
    assert.equal(await col.ticketDeposit(conn, pool, user), 32n * perByte, label);
    assert.equal(col.depositOf(lamports, data.length, rent), 32n * perByte, label + ": the same at its length, the ticket already fits");
  }
});

test("what a mint can use stays the deposit at the ticket's current length: a keeper must not count the spare entries", () => {
  for (const [rent, label] of [[col.STANDARD_RENT, "local"], [MAINNET_RENT, "mainnet"]]) {
    const cfg = { ...SHOTS, minted: 10 };
    // a list of one in a ticket of three entries: two pieces fit in the spare bytes, so mint_for grows nothing
    const long = col.ticketSpace(3), fit = col.ticketSpace(1);
    const costLong = col.mintForCost(rent, cfg, long, 1, 2);
    const costFit = col.mintForCost(rent, cfg, fit, 1, 2);
    assert.equal(costFit - costLong, rent(long) - rent(fit), label + ": the spare entries hold the growth already");
    // mint_for checks the lamports above the rent of the CURRENT length (program: deposit_in before and after the mint)
    const exact = rent(long) + costLong;
    assert.equal(col.depositOf(exact, long, rent), costLong, label + ": covered to the lamport");
    const short = exact - 1n;
    assert.ok(col.depositOf(short, long, rent) < costLong, label + ": one lamport short, mint_for refuses it (DepositTooSmall)");
    assert.ok(col.withdrawableDeposit(short, long, 1, rent) >= costLong, label + ": the withdrawable reading would call it covered");
    // the two readings agree on the total: what a withdraw pays out is what the same mint costs once the ticket fits its list
    assert.equal(col.withdrawableDeposit(exact, long, 1, rent), costFit, label);
  }
});
