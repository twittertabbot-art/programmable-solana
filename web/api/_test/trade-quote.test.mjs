// Unit tests for the quote of the trade API (web/api/_trade.js) against a connection made
// of plain objects: the accounts are written here byte by byte, so no validator is needed.
// They cover what a live chain cannot show on demand: a custom hook, a paused platform, a
// cluster without Programmable, a pool that does not trade against SOL, a dead RPC.
//   node --test "web/api/_test/*.test.mjs"        (from the project folder)
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import * as H from "../_sdk.js";
import { ApiError, errorResponse, parseQuoteParams, parseSwapParams, ratioDecimal } from "../_trade-core.js";
import { GRADUATE_COMPUTE_UNITS, handleRequest, instructionKind, largestBuyUnder, quote, readJson, resetCaches, swap } from "../_trade.js";

const { PublicKey } = H;
const key = () => H.Keypair.generate().publicKey;
const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u128 = (n) => Buffer.concat([u64(BigInt(n) & 0xffffffffffffffffn), u64(BigInt(n) >> 64n)]);
const pk =(k) => k.toBuffer();
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
const disc = (name) => Buffer.from(H.ACCOUNT_DISC[name]);
const account = (owner, data) => ({ owner, data, lamports: 1_000_000, executable: false });

const F = H.FLAGS;
const GUARD_FLAGS = F.BEFORE_SWAP | F.ON_POOL_CREATE | F.OVERRIDE_FEE | F.CALL_ON_BUY;
const TAX_FLAGS = F.BEFORE_SWAP | F.ON_POOL_CREATE | F.TAKE_HOOK_FEE | F.CALL_ON_BUY | F.CALL_ON_SELL;
const COLLECTIBLE_FLAGS = F.AFTER_SWAP | F.ON_POOL_CREATE | F.CALL_ON_BUY;
const BUYBACK_FLAGS = TAX_FLAGS;
// The launch rules template: a hook fee on both sides, a fee override on buys (the sniper
// fee), and a callback when liquidity is added (it refuses deposits while the sniper fee runs).
const RULES_FLAGS = F.BEFORE_SWAP | F.BEFORE_ADD_LIQ | F.ON_POOL_CREATE | F.OVERRIDE_FEE | F.TAKE_HOOK_FEE | F.CALL_ON_BUY | F.CALL_ON_SELL;

function platformAccount(o = {}) {
  return account(H.PROGRAMS.hookpool, Buffer.concat([
    disc("Platform"), u8(255), pk(key()), pk(key()), pk(key()), u16(o.protocolFeeBps ?? 20), u16(1000), u16(o.maxHookFeeBps ?? 1000), u16(o.maxFeeOverrideBps ?? 5000),
    u64(10_000_000), u8(o.paused ? 1 : 0), u8(0), Buffer.alloc(8 * 32), u64(1),
  ]));
}
function poolAccount(o) {
  return account(o.owner ?? H.PROGRAMS.hookpool, Buffer.concat([
    disc("Pool"), u8(254), pk(o.baseMint), pk(o.quoteMint ?? H.NATIVE_MINT), pk(key()), pk(key()), pk(key()), pk(key()),
    pk(o.baseTokenProgram ?? H.TOKEN_PROGRAM), pk(H.TOKEN_PROGRAM), u16(o.lpFeeBps ?? 100), pk(o.hookProgram ?? H.SYSTEM_PROGRAM), u32(o.hookFlags ?? 0),
    pk(o.hookProgram ? H.pda.extraMetas(o.hookProgram) : H.SYSTEM_PROGRAM), pk(o.hookTreasury ?? H.SYSTEM_PROGRAM), u8(o.hookKind ?? 0),
    u64(o.reserveBase ?? 1_000_000_000_000_000n), u64(o.reserveQuote ?? 2_000_000_000n), u64(0), u64(0), u64(0), u64(0), u64(3), u64(100), pk(key()),
    u64(o.hookFeesOwed ?? 0), pk(o.hookTreasuryOwner ?? key()),
    // the curve (offsets 504 to 527): virtual quote, graduation target, graduation fee, state, a reserve of zeros.
    // All zero on a seeded pool, which is every pool the tests above make.
    u64(o.virtualQuote ?? 0), u64(o.graduationTarget ?? 0), u16(o.graduationFeeBps ?? 0), u8(o.curveState ?? 0), Buffer.alloc(5),
  ]));
}
function mintAccount(decimals = 6, owner = H.TOKEN_PROGRAM, supply = 1_000_000_000_000_000n) {
  return account(owner, Buffer.concat([u32(0), Buffer.alloc(32), u64(supply), u8(decimals), u8(1), u32(0), Buffer.alloc(32)]));
}
function metadataAccount(mint, name, symbol) {
  return account(H.METAPLEX_METADATA, Buffer.concat([u8(4), pk(key()), pk(mint), str(name.padEnd(32, "\0")), str(symbol.padEnd(10, "\0")), str("https://x/y.json"), u16(0), u8(0), u8(0), u8(0)]));
}
const taxConfig = (pool, buyBps, sellBps, maxBps, renounced = false) => account(H.PROGRAMS.hook_tax, Buffer.concat([disc("TaxConfig"), u8(255), pk(pool), pk(renounced ? H.SYSTEM_PROGRAM : key()), u16(buyBps), u16(sellBps), u16(maxBps), pk(key())]));
const guardConfig = (pool, startSlot, guardSlots, startFeeBps) => account(H.PROGRAMS.hook_launch_guard, Buffer.concat([disc("GuardConfig"), u8(255), pk(pool), u64(startSlot), u64(guardSlots), u16(startFeeBps), pk(key())]));
const collectionConfig = (pool, baseMint, o) => account(H.PROGRAMS.hook_collectible, Buffer.concat([
  disc("CollectionConfig"), u8(255), u8(254), u8(253), pk(pool), pk(key()), pk(key()), pk(key()), pk(baseMint), pk(o.pegged ? H.TOKEN_2022_PROGRAM : H.TOKEN_PROGRAM), u8(o.pegged ? 1 : 0),
  u64(o.unit), u32(o.maxSupply ?? 1000), u32(o.minted ?? 0), u32(o.live ?? 0), u32(o.reserved ?? 0), u8(o.maxPerBuy ?? 3), u16(0), Buffer.alloc(16), str("Shots"), str("http://localhost:8787/art"),
]));

// BuybackConfig, 230 bytes: the fee, the counters, the creator, then the observation of the
// pool that a buyback buys against (slot at 206, the two reserves at 214 and 222).
const buybackConfig = (pool, baseMint, o = {}) => account(H.PROGRAMS.hook_buyback, Buffer.concat([
  disc("BuybackConfig"), u8(255), u8(254), pk(pool), pk(baseMint), pk(H.NATIVE_MINT), pk(key()), u16(o.buyBps ?? 200), u16(o.sellBps ?? 200), u64(o.minQuote ?? 50_000_000n),
  u64(o.totalQuoteSpent ?? 0), u64(o.totalBaseBurned ?? 0), u64(o.buybacks ?? 0), pk(key()), u64(o.obsSlot ?? 0), u64(o.obsReserveBase ?? 0), u64(o.obsReserveQuote ?? 0),
]));
// RulesConfig, 414 bytes, field by field as RULES.md lays it out ("Config layout"). Bytes 8
// to 239 are the rules and the launch data; the running numbers follow.
const rates = (r = {}) => Buffer.concat([u16(r.creatorBps ?? 0), u16(r.holdersBps ?? 0), u16(r.burnBps ?? 0)]);
const rulesConfig = (pool, baseMint, o = {}) => account(o.owner ?? H.PROGRAMS.hook_rules, Buffer.concat([
  disc("RulesConfig"), u8(255), u8(254), pk(o.pool ?? pool), pk(baseMint), pk(H.NATIVE_MINT), pk(key()), pk(key()),
  u64(o.sniperSlots ?? 0), u16(o.sniperStartFeeBps ?? 0), rates(o.buy), rates(o.sell), u64(o.maxBuyQuote ?? 0), u64(o.limitSlots ?? 0), u64(o.creatorLockSeconds ?? 0),
  u64(o.startSlot ?? 1000), i64(o.startTime ?? 1_760_000_000), u64(o.minEligible ?? 1_000_000_000_000n),
  u64(o.feesSeen ?? 0), rates(o.lastSplit), u64(o.creatorOwed ?? 0), u64(o.burnPot ?? 0), u128(o.accPerShare ?? 0), u64(o.rewardRem ?? 0), u64(o.totalStaked ?? 0), u64(o.rewardsOwedTotal ?? 0),
  u64(0), u64(0), u64(o.totalQuoteBurned ?? 0), u64(o.totalBaseBurned ?? 0), u64(o.burns ?? 0), u64(o.obsSlot ?? 0), u64(o.obsReserveBase ?? 0), u64(o.obsReserveQuote ?? 0),
  // the strict part (offsets 374 to 413): the kind, the buy mark, the vault bump, the four numbers, the cap in raw units, a reserve
  u8(o.kind ?? 0), u8(0), u8(o.kind ? 251 : 0), u16(o.maxWalletBps ?? 0), u16(o.earlySlots ?? 0), u32(o.maxWalletSlots ?? 0), u32(o.earlyUnlockSlots ?? 0), u64(o.maxWalletAmount ?? 0), Buffer.alloc(17),
]));
// HolderRecord, 129 bytes, under the rules program: the wallet's coins as last counted, the reward snapshot,
// what is owed, its early coins, the creator lock.
const holderRecord = (pool, owner, o = {}) => account(H.PROGRAMS.hook_rules, Buffer.concat([
  disc("HolderRecord"), u8(254), pk(pool), pk(owner), u64(o.balance ?? 0), u128(o.accSnapshot ?? 0), u64(o.owed ?? 0), u64(o.earlyBought ?? 0), u64(o.locked ?? 0), i64(o.lockedUntil ?? 0),
]));
// The Clock sysvar: the slot at 0, the Unix time at 32.
const clockAccount = (slot, unixTime) => account(new PublicKey("Sysvar1111111111111111111111111111111111111"), Buffer.concat([u64(slot), Buffer.alloc(24), i64(unixTime)]));
// A hook's extra-accounts list with one entry, the template's ["cfg", pool] under the hook
// program (a literal seed, then the key of callback account 0, the pool), writable or not.
const cfgList = (hookProgram, writable) => {
  const seeds = Buffer.alloc(32); Buffer.from([1, 3, 0x63, 0x66, 0x67, 3, 0]).copy(seeds);
  const value = Buffer.concat([u32(1), u8(1), seeds, u8(0), u8(writable ? 1 : 0)]);
  return account(hookProgram, Buffer.concat([Buffer.from([60, 167, 17, 250, 28, 149, 188, 66]), u32(value.length), value]));
};
const tokenAccount = (mint, owner, amount, program = H.TOKEN_PROGRAM) => account(program, Buffer.concat([pk(mint), pk(owner), u64(amount), Buffer.alloc(93)]));

/// A connection that answers from a map and counts its calls.
function fakeConnection(accounts, slot = 5000) {
  const calls = [];
  const info = (k) => accounts.get(k.toBase58()) ?? null;
  return {
    calls,
    async getMultipleAccountsInfo(keys) { calls.push("many:" + keys.length); return keys.map(info); },
    async getMultipleAccountsInfoAndContext(keys) { calls.push("fresh:" + keys.length); return { context: { slot }, value: keys.map(info) }; },
    async getLatestBlockhash() { calls.push("blockhash"); return { blockhash: key().toBase58(), lastValidBlockHeight: slot + 150 }; },
    // the chain's rent, the local validator's numbers the accounts above are sized at. The API reads it once per
    // process and keeps it an hour, outside a request's count of calls: not listed in `calls`.
    async getMinimumBalanceForRentExemption(n) { return (n + 128) * 6_960; },
  };
}
/// One coin with its pool, ready to quote. `hook` picks the accounts of the hook.
function world(o = {}) {
  resetCaches();
  const baseMint = key();
  const quoteMint = o.quoteMint ?? H.NATIVE_MINT;
  const pool = H.pda.pool(baseMint, quoteMint);
  const accounts = new Map();
  const put = (k, a) => accounts.set(k.toBase58(), a);
  if (!o.noPlatform) put(H.pda.platform(), platformAccount(o.platform));
  put(pool, poolAccount({ baseMint, quoteMint, ...o.pool }));
  put(baseMint, mintAccount(o.decimals ?? 6, o.pool && o.pool.baseTokenProgram ? o.pool.baseTokenProgram : H.TOKEN_PROGRAM, o.supply));
  if (!o.noMetadata) put(H.pda.metadata(baseMint), metadataAccount(baseMint, o.name ?? "Unit Test Coin", o.symbol ?? "UTC"));
  if (o.cfg) put(H.pda.cfg(o.pool.hookProgram, pool), o.cfg(pool, baseMint));
  const connection = fakeConnection(accounts, o.slot ?? 5000);
  return { baseMint, pool, accounts, connection, deps: { connection, lookupTable: null } };
}
const ask = (w, side, amount, extra = {}) => quote(parseQuoteParams({ mint: w.baseMint.toBase58(), side, amount: String(amount), ...extra }), w.deps);
async function refused(promise) {
  try { await promise; } catch (e) { assert.ok(e instanceof ApiError, "an ApiError, got " + (e && e.stack)); return e; }
  assert.fail("did not throw");
}

// The order of a swap, written out again here so the API is checked against the
// specification (HOOKS.md section 2) and not against the SDK it calls.
const ceilFee = (amount, bps) => (bps === 0 ? 0n : (amount * BigInt(bps) + 9999n) / 10000n);
function expected({ isBuy, amount, reserveBase, reserveQuote, protocolBps, hookBps, poolBps }) {
  const [rIn, rOut] = isBuy ? [reserveQuote, reserveBase] : [reserveBase, reserveQuote];
  const protocol = ceilFee(amount, protocolBps);
  const hookIn = isBuy ? ceilFee(amount - protocol, hookBps) : 0n;
  const pool = ceilFee(amount - protocol - hookIn, poolBps);
  const net = amount - protocol - hookIn - pool;
  const gross = (rOut * net) / (rIn + net);
  const hookOut = isBuy ? 0n : ceilFee(gross, hookBps);
  return { protocol, hook: hookIn + hookOut, pool, out: gross - hookOut };
}
const R = { reserveBase: 1_000_000_000_000_000n, reserveQuote: 2_000_000_000n };
const SOL = H.NATIVE_MINT.toBase58();

test("no hook: the numbers follow the specified order, both ways", async () => {
  const w = world();
  const { body: buy } = await ask(w, "buy", 100_000_000n);
  const e = expected({ isBuy: true, amount: 100_000_000n, ...R, protocolBps: 20, hookBps: 0, poolBps: 100 });
  assert.equal(e.protocol, 200_000n); assert.equal(e.pool, 998_000n);
  assert.equal(buy.outAmount, e.out.toString());
  assert.equal(buy.outAmount, "47075426838739", "1e15 * 98802000 / 2098802000, rounded down");
  assert.equal(buy.minOutAmount, ((e.out * 9900n) / 10000n).toString());
  assert.deepEqual(buy.fees, { protocol: { amount: "200000", mint: SOL, bps: 20 }, pool: { amount: "998000", mint: SOL, bps: 100 }, hook: { amount: "0", mint: SOL, bps: 0 } });
  assert.equal(buy.pool, w.pool.toBase58()); assert.equal(buy.inputMint, SOL); assert.equal(buy.outputMint, w.baseMint.toBase58());
  assert.equal(buy.hook, null); assert.equal(buy.exact, true); assert.equal(buy.slot, 5000); assert.deepEqual(buy.notes, []);
  assert.equal(buy.priceBefore, "0.000000002", "2 SOL for 1,000,000,000 coins");
  assert.ok(Number(buy.priceAfter) > Number(buy.priceBefore));
  assert.deepEqual(buy.coin, { mint: w.baseMint.toBase58(), symbol: "UTC", name: "Unit Test Coin", decimals: 6, tokenProgram: H.TOKEN_PROGRAM.toBase58(), collectible: null });

  const { body: sell } = await ask(w, "sell", 50_000_000_000_000n, { slippageBps: "250" });
  const s = expected({ isBuy: false, amount: 50_000_000_000_000n, ...R, protocolBps: 20, hookBps: 0, poolBps: 100 });
  assert.equal(sell.outAmount, s.out.toString());
  assert.equal(sell.minOutAmount, ((s.out * 9750n) / 10000n).toString());
  assert.equal(sell.fees.protocol.mint, w.baseMint.toBase58(), "on a sell the protocol fee is paid in the coin");
  assert.equal(sell.fees.pool.mint, w.baseMint.toBase58());
  assert.equal(sell.fees.hook.mint, SOL);
  assert.equal(sell.inputMint, w.baseMint.toBase58()); assert.equal(sell.outputMint, SOL);
  assert.ok(Number(sell.priceAfter) < Number(sell.priceBefore));
});

test("the caches: two RPC calls for a new pool, one after that", async () => {
  const w = world();
  const first = await ask(w, "buy", 100_000_000n);
  assert.equal(first.rpcCalls, 2);
  assert.deepEqual(w.connection.calls, ["many:1", "fresh:4"], "the pool, then platform, pool, its mint and its metadata at one slot");
  assert.deepEqual([first.body.coin.symbol, first.body.coin.name, first.body.coin.decimals], ["UTC", "Unit Test Coin", 6], "the coin read in that same call");
  const second = await ask(w, "sell", 1_000_000_000n);
  assert.equal(second.rpcCalls, 1);
  assert.equal(w.connection.calls.length, 3);
  assert.equal(w.connection.calls[2], "fresh:2", "a pool the server knows: platform and pool, nothing else");
  // the reserves are never cached: a pool that moved is quoted as it is now
  w.accounts.set(w.pool.toBase58(), poolAccount({ baseMint: w.baseMint, reserveQuote: 4_000_000_000n }));
  const third = await ask(w, "buy", 100_000_000n);
  assert.equal(third.body.priceBefore, "0.000000004");
  assert.notEqual(third.body.outAmount, first.body.outAmount);
});

test("tax: the hook fee comes off the input of a buy and the output of a sell, in SOL", async () => {
  const w = world({ pool: { hookProgram: H.PROGRAMS.hook_tax, hookFlags: TAX_FLAGS, hookKind: 2 }, cfg: (pool) => taxConfig(pool, 300, 500, 1000) });
  const { body: buy, rpcCalls } = await ask(w, "buy", 100_000_000n);
  const e = expected({ isBuy: true, amount: 100_000_000n, ...R, protocolBps: 20, hookBps: 300, poolBps: 100 });
  assert.equal(buy.outAmount, e.out.toString());
  assert.deepEqual(buy.fees.hook, { amount: e.hook.toString(), mint: SOL, bps: 300 });
  assert.equal(e.hook, 2_994_000n, "3% of what is left after the protocol fee");
  assert.deepEqual(buy.hook, { program: H.PROGRAMS.hook_tax.toBase58(), template: "tax", kind: "platform", runsOnBuys: true, runsOnSells: true });
  assert.equal(buy.exact, true);
  assert.deepEqual(buy.notes, ["This coin has a tax of 3% on buys and 5% on sells, taken in SOL for the coin's treasury. The quote includes it.", "The owner of the tax can change it, up to 10%."]);
  assert.equal(rpcCalls, 2, "the hook's settings ride in the same call as the pool");
  const { body: sell } = await ask(w, "sell", 50_000_000_000_000n);
  const s = expected({ isBuy: false, amount: 50_000_000_000_000n, ...R, protocolBps: 20, hookBps: 500, poolBps: 100 });
  assert.equal(sell.outAmount, s.out.toString());
  assert.deepEqual(sell.fees.hook, { amount: s.hook.toString(), mint: SOL, bps: 500 });
});

test("tax: fees that wait for a missing treasury are said in a note, and change no number", async () => {
  const plain = world({ pool: { hookProgram: H.PROGRAMS.hook_tax, hookFlags: TAX_FLAGS, hookKind: 2 }, cfg: (pool) => taxConfig(pool, 300, 500, 1000) });
  const owing = world({ pool: { hookProgram: H.PROGRAMS.hook_tax, hookFlags: TAX_FLAGS, hookKind: 2, hookFeesOwed: 2_994_000n }, cfg: (pool) => taxConfig(pool, 300, 500, 1000) });
  const a = (await ask(plain, "buy", 100_000_000n)).body;
  const b = (await ask(owing, "buy", 100_000_000n)).body;
  assert.equal(b.outAmount, a.outAmount);
  assert.deepEqual(b.fees, a.fees);
  assert.equal(b.exact, true);
  assert.deepEqual(b.notes.slice(0, 2), a.notes);
  assert.deepEqual(b.notes.slice(2), ["The account that receives this coin's fee did not exist at an earlier trade. 2994000 lamports of fees wait in the pool and are paid when it is back. What a trader pays and receives is the same."]);
});

test("tax: renounced, and a tax above the platform cap is quoted at the cap", async () => {
  const w = world({ platform: { maxHookFeeBps: 200 }, pool: { hookProgram: H.PROGRAMS.hook_tax, hookFlags: TAX_FLAGS, hookKind: 2 }, cfg: (pool) => taxConfig(pool, 300, 500, 1000, true) });
  const { body } = await ask(w, "buy", 100_000_000n);
  assert.equal(body.fees.hook.bps, 200);
  assert.equal(body.outAmount, expected({ isBuy: true, amount: 100_000_000n, ...R, protocolBps: 20, hookBps: 200, poolBps: 100 }).out.toString());
  assert.equal(body.notes[1], "The tax can never change.");
});

test("launch guard: the fee of the slot, not exact while it runs, exact after and on sells", async () => {
  const hook = { hookProgram: H.PROGRAMS.hook_launch_guard, hookFlags: GUARD_FLAGS, hookKind: 2 };
  // 300 slots from 30% down to the pool's 1%: at slot 1100 a third is gone
  const running = world({ slot: 1100, pool: hook, cfg: (pool) => guardConfig(pool, 1000, 300, 3000) });
  const { body: buy } = await ask(running, "buy", 100_000_000n);
  const fee = 3000 - Math.floor(((3000 - 100) * 100) / 300);
  assert.equal(fee, 2034);
  assert.equal(buy.fees.pool.bps, fee);
  assert.equal(buy.outAmount, expected({ isBuy: true, amount: 100_000_000n, ...R, protocolBps: 20, hookBps: 0, poolBps: fee }).out.toString());
  assert.equal(buy.exact, false);
  assert.deepEqual(buy.notes, [
    "A launch guard is running on this pool. Buys pay a pool fee of 20.34% at slot 1100.",
    "The fee falls every slot. It is back to 1% at slot 1300, in about 80 seconds.",
    "This quote uses the fee of slot 1100. A trade that lands later gives the same amount or more.",
  ]);
  assert.deepEqual(buy.hook, { program: H.PROGRAMS.hook_launch_guard.toBase58(), template: "launch_guard", kind: "platform", runsOnBuys: true, runsOnSells: false });
  const { body: sell } = await ask(running, "sell", 50_000_000_000_000n);
  assert.equal(sell.exact, true); assert.equal(sell.fees.pool.bps, 100); assert.deepEqual(sell.notes, []);

  const over = world({ slot: 1300, pool: hook, cfg: (pool) => guardConfig(pool, 1000, 300, 3000) });
  const { body: late } = await ask(over, "buy", 100_000_000n);
  assert.equal(late.exact, true); assert.equal(late.fees.pool.bps, 100); assert.deepEqual(late.notes, []);

  const capped = world({ slot: 1000, platform: { maxFeeOverrideBps: 2500 }, pool: hook, cfg: (pool) => guardConfig(pool, 1000, 300, 3000) });
  assert.equal((await ask(capped, "buy", 100_000_000n)).body.fees.pool.bps, 2500, "the pool cuts an override down to the platform cap");
});

test("collectible: plain and pegged coins, and the pieces a buy earns", async () => {
  const unit = 10_000_000_000_000n; // 10,000,000 coins
  const hook = { hookProgram: H.PROGRAMS.hook_collectible, hookFlags: COLLECTIBLE_FLAGS, hookKind: 2 };
  const plain = world({ pool: hook, cfg: (pool, mint) => collectionConfig(pool, mint, { unit, maxPerBuy: 3 }) });
  const { body: buy } = await ask(plain, "buy", 100_000_000n);
  assert.equal(buy.outAmount, "47075426838739", "the hook takes nothing: same output as a pool without a hook");
  assert.deepEqual(buy.coin.collectible, { kind: "plain", unit: unit.toString(), maxPerBuy: 3 });
  assert.equal(buy.hook.runsOnSells, false); assert.equal(buy.exact, true);
  // one approval: the deposit a swap adds for the NFTs, the SDK's mintDepositFor for a collection that is not
  // locked (its owner may still lengthen the name to 24 bytes and the address to 80)
  const deposit = H.collectible.mintDepositFor(H.collectible.STANDARD_RENT, { name: "Shots", uriBase: "http://localhost:8787/art", locked: false }, 3);
  assert.equal(deposit, 3n * ((75n + 24n + 12n + 80n + 68n + 128n) * 6_960n + 1_500_000n + 32n * 6_960n + 10_000n));
  assert.deepEqual(buy.mintDeposit, { pieces: 3, lamports: deposit.toString(), included: true });
  assert.deepEqual(buy.notes, [
    "This is a collectible coin. A buy earns one piece for every 10000000 coins received, at most 3 per buy.",
    "This buy earns up to 3 pieces.",
    "A swap adds a deposit of " + deposit + " lamports for their NFTs to the buy. A keeper mints them into the wallet a few seconds after the buy and is paid back from that deposit. With mintDeposit false the wallet mints them itself.",
  ]);
  assert.deepEqual((await ask(plain, "buy", 10_000_000n)).body.mintDeposit, { pieces: 0, lamports: "0", included: false });
  assert.equal((await ask(plain, "sell", 1_000_000_000n)).body.mintDeposit, null, "a sell adds no deposit");
  assert.equal((await ask(plain, "buy", 30_000_000n)).body.notes[1], "This buy earns up to 1 piece.");
  assert.deepEqual((await ask(plain, "buy", 10_000_000n)).body.notes.slice(1), ["This buy earns no piece."]);
  assert.deepEqual((await ask(plain, "sell", 1_000_000_000n)).body.notes, ["This is a collectible coin. A sell burns the pieces the wallet's coins no longer back, the last piece first."]);

  const full = world({ pool: hook, cfg: (pool, mint) => collectionConfig(pool, mint, { unit, maxPerBuy: 3, maxSupply: 10, live: 8, reserved: 1 }) });
  assert.equal((await ask(full, "buy", 100_000_000n)).body.notes[1], "This buy earns up to 1 piece.", "only one place is left in the collection");

  const pegged = world({ pool: { ...hook, baseTokenProgram: H.TOKEN_2022_PROGRAM }, noMetadata: true, cfg: (pool, mint) => collectionConfig(pool, mint, { unit, pegged: true }) });
  const { body: peg } = await ask(pegged, "sell", 1_000_000_000n);
  assert.equal(peg.coin.collectible.kind, "pegged");
  assert.equal(peg.coin.tokenProgram, H.TOKEN_2022_PROGRAM.toBase58());
  assert.equal(peg.hook.runsOnSells, true, "the coin's own transfer hook runs inside a sell");
  assert.equal(peg.notes[1], "This is a pegged coin. Its pieces move or burn inside every transfer of the coin.");
});

test("buyback: the fee of each side, in a config of 230 bytes; the observation changes no number", async () => {
  const hook = { hookProgram: H.PROGRAMS.hook_buyback, hookFlags: BUYBACK_FLAGS, hookKind: 2 };
  const w = world({ pool: hook, cfg: (pool, mint) => buybackConfig(pool, mint, { buyBps: 200, sellBps: 300 }) });
  assert.equal(w.accounts.get(H.pda.cfg(H.PROGRAMS.hook_buyback, w.pool).toBase58()).data.length, 230);
  const { body: buy } = await ask(w, "buy", 100_000_000n);
  const e = expected({ isBuy: true, amount: 100_000_000n, ...R, protocolBps: 20, hookBps: 200, poolBps: 100 });
  assert.equal(buy.outAmount, e.out.toString());
  assert.deepEqual(buy.fees.hook, { amount: e.hook.toString(), mint: SOL, bps: 200 });
  assert.deepEqual(buy.hook, { program: H.PROGRAMS.hook_buyback.toBase58(), template: "buyback", kind: "platform", runsOnBuys: true, runsOnSells: true });
  assert.equal(buy.exact, true);
  assert.deepEqual(buy.notes, ["A fee of 2% on buys and 3% on sells funds buybacks of this coin. The quote includes it."]);
  const { body: sell } = await ask(w, "sell", 50_000_000_000_000n);
  const s = expected({ isBuy: false, amount: 50_000_000_000_000n, ...R, protocolBps: 20, hookBps: 300, poolBps: 100 });
  assert.equal(sell.outAmount, s.out.toString());
  assert.deepEqual(sell.fees.hook, { amount: s.hook.toString(), mint: SOL, bps: 300 });
  // a buyback that has run left an observation and counters behind: a trade is quoted the same
  const ran = world({ pool: hook, cfg: (pool, mint) => buybackConfig(pool, mint, { buyBps: 200, sellBps: 300, buybacks: 4, totalQuoteSpent: 40_000_000n, totalBaseBurned: 9_000_000_000n, obsSlot: 4900, obsReserveBase: 999_000_000_000_000n, obsReserveQuote: 2_010_000_000n }) });
  const again = (await ask(ran, "buy", 100_000_000n)).body;
  assert.equal(again.outAmount, buy.outAmount); assert.deepEqual(again.fees, buy.fees); assert.deepEqual(again.notes, buy.notes); assert.equal(again.exact, true);
});

const RULES = { hookProgram: H.PROGRAMS.hook_rules, hookFlags: RULES_FLAGS, hookKind: 2 };
const rulesWorld = (cfg, o = {}) => world({ ...o, pool: { ...RULES, ...(o.pool ?? {}) }, cfg: (pool, mint) => rulesConfig(pool, mint, cfg) });
const NEVER = "These rates were fixed at launch and can never change.";

test("rules: a platform template named rules; a creator fee alone, quoted to the unit", async () => {
  const w = rulesWorld({ buy: { creatorBps: 100 }, sell: { creatorBps: 100 } });
  assert.equal(w.accounts.get(H.pda.cfg(H.PROGRAMS.hook_rules, w.pool).toBase58()).data.length, 414);
  assert.equal(RULES_FLAGS, 13125);
  const { body: buy, rpcCalls } = await ask(w, "buy", 100_000_000n);
  const e = expected({ isBuy: true, amount: 100_000_000n, ...R, protocolBps: 20, hookBps: 100, poolBps: 100 });
  assert.equal(buy.outAmount, e.out.toString());
  assert.deepEqual(buy.fees, { protocol: { amount: "200000", mint: SOL, bps: 20 }, pool: { amount: e.pool.toString(), mint: SOL, bps: 100 }, hook: { amount: e.hook.toString(), mint: SOL, bps: 100 } });
  assert.equal(e.hook, 998_000n, "1% of what is left after the protocol fee");
  assert.deepEqual(buy.hook, {
    program: H.PROGRAMS.hook_rules.toBase58(), template: "rules", kind: "platform", runsOnBuys: true, runsOnSells: true,
    rules: { creatorBps: 100, holdersBps: 0, burnBps: 0, sniperEndsAtSlot: null, buyLimit: null, strict: null },
  });
  assert.equal(buy.exact, true);
  assert.deepEqual(buy.notes, ["This coin takes 1% of every buy, in SOL. The quote includes it.", "All of it goes to the coin's creator.", NEVER]);
  assert.equal(rpcCalls, 2, "the rules ride in the same call as the pool");
  const { body: sell } = await ask(w, "sell", 50_000_000_000_000n);
  const s = expected({ isBuy: false, amount: 50_000_000_000_000n, ...R, protocolBps: 20, hookBps: 100, poolBps: 100 });
  assert.equal(sell.outAmount, s.out.toString());
  assert.deepEqual(sell.fees.hook, { amount: s.hook.toString(), mint: SOL, bps: 100 });
  assert.deepEqual(sell.notes, ["This coin takes 1% of every sell, in SOL. The quote includes it.", "All of it goes to the coin's creator.", NEVER]);
});

test("rules: three shares with their own rates per side, and nothing in the quote follows what is staked", async () => {
  const cfg = { buy: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, sell: { creatorBps: 100, holdersBps: 200, burnBps: 100 } };
  const w = rulesWorld(cfg);
  const { body: buy } = await ask(w, "buy", 100_000_000n);
  assert.equal(buy.outAmount, expected({ isBuy: true, amount: 100_000_000n, ...R, protocolBps: 20, hookBps: 200, poolBps: 100 }).out.toString());
  assert.equal(buy.fees.hook.bps, 200);
  assert.deepEqual(buy.hook.rules, { creatorBps: 50, holdersBps: 100, burnBps: 50, sniperEndsAtSlot: null, buyLimit: null, strict: null });
  assert.deepEqual(buy.notes, [
    "This coin takes 2% of every buy, in SOL. The quote includes it.",
    "It is split in three: 0.5% for the coin's creator, 1% for holders who stake the coin and 0.5% to buy the coin back and burn it.",
    "While less than 0.1% of the coin's supply is staked, the holders' share goes to the burn instead.",
    NEVER,
  ]);
  const { body: sell } = await ask(w, "sell", 50_000_000_000_000n);
  const s = expected({ isBuy: false, amount: 50_000_000_000_000n, ...R, protocolBps: 20, hookBps: 400, poolBps: 100 });
  assert.equal(sell.outAmount, s.out.toString());
  assert.deepEqual(sell.fees.hook, { amount: s.hook.toString(), mint: SOL, bps: 400 });
  assert.deepEqual(sell.hook.rules, { creatorBps: 100, holdersBps: 200, burnBps: 100, sniperEndsAtSlot: null, buyLimit: null, strict: null });
  assert.equal(sell.notes[0], "This coin takes 4% of every sell, in SOL. The quote includes it.");
  assert.equal(sell.notes[1], "It is split in three: 1% for the coin's creator, 2% for holders who stake the coin and 1% to buy the coin back and burn it.");

  // the same coin with stakers, rewards owed, a full burn pot and an observation: same quote, same words
  const busy = rulesWorld({ ...cfg, totalStaked: 500_000_000_000_000n, accPerShare: 123_456_789_012_345_678_901n, rewardRem: 77, rewardsOwedTotal: 5_000_000n, creatorOwed: 9_000_000n, burnPot: 80_000_000n, feesSeen: 400_000_000n, lastSplit: cfg.sell, burns: 3, totalBaseBurned: 1_000_000n, obsSlot: 4990, obsReserveBase: 990_000_000_000_000n, obsReserveQuote: 2_020_000_000n });
  for (const [side, amount, before] of [["buy", 100_000_000n, buy], ["sell", 50_000_000_000_000n, sell]]) {
    const { body } = await ask(busy, side, amount);
    // the two worlds have their own coin: compare the numbers of the fees, not the mint they are paid in
    const numbers = (f) => Object.values(f).map((x) => [x.amount, x.bps]);
    assert.equal(body.outAmount, before.outAmount); assert.deepEqual(numbers(body.fees), numbers(before.fees)); assert.deepEqual(body.notes, before.notes); assert.deepEqual(body.hook.rules, before.hook.rules); assert.equal(body.exact, true);
  }
  assert.ok(!JSON.stringify(buy).includes("totalStaked") && !/staked now|is staked right now/.test(buy.notes.join(" ")), "the quote says the rule about staking, never the state");
});

test("rules: two shares, a side with no rate, and rates above the platform cap", async () => {
  const two = rulesWorld({ buy: { creatorBps: 50, burnBps: 50 }, sell: { holdersBps: 200 } });
  assert.deepEqual((await ask(two, "buy", 100_000_000n)).body.notes, [
    "This coin takes 1% of every buy, in SOL. The quote includes it.",
    "It is split in two: 0.5% for the coin's creator and 0.5% to buy the coin back and burn it.",
    NEVER,
  ]);
  assert.deepEqual((await ask(two, "sell", 50_000_000_000_000n)).body.notes, [
    "This coin takes 2% of every sell, in SOL. The quote includes it.",
    "All of it goes to holders who stake the coin.",
    "While less than 0.1% of the coin's supply is staked, the holders' share goes to the burn instead.",
    NEVER,
  ]);
  const burnOnly = rulesWorld({ sell: { burnBps: 100 } });
  const free = (await ask(burnOnly, "buy", 100_000_000n)).body;
  assert.equal(free.outAmount, "47075426838739", "no rate on buys: the output of a pool without a hook");
  assert.deepEqual(free.fees.hook, { amount: "0", mint: SOL, bps: 0 });
  assert.deepEqual(free.notes, ["The rules of this coin take nothing from a buy.", "The rules of this coin were fixed at launch and can never change."]);
  assert.deepEqual((await ask(burnOnly, "sell", 50_000_000_000_000n)).body.notes, ["This coin takes 1% of every sell, in SOL. The quote includes it.", "All of it buys the coin back and burns it.", NEVER]);

  // the pool clamps the hook fee to the platform's cap, whatever the rules say
  const capped = rulesWorld({ sell: { creatorBps: 100, holdersBps: 200, burnBps: 100 } }, { platform: { maxHookFeeBps: 300 } });
  const { body } = await ask(capped, "sell", 50_000_000_000_000n);
  const s = expected({ isBuy: false, amount: 50_000_000_000_000n, ...R, protocolBps: 20, hookBps: 300, poolBps: 100 });
  assert.equal(body.outAmount, s.out.toString());
  assert.deepEqual(body.fees.hook, { amount: s.hook.toString(), mint: SOL, bps: 300 });
  assert.deepEqual(body.hook.rules, { creatorBps: 100, holdersBps: 200, burnBps: 100, sniperEndsAtSlot: null, buyLimit: null, strict: null }, "the rates as the rules set them");
  assert.equal(body.notes[0], "This coin takes 4% of every sell, in SOL. The platform caps this fee at 3%, so this trade pays 3% and the shares below shrink in the same proportion. The quote includes it.");
});

test("rules: the sniper fee of the slot, not exact while it runs, exact after and on sells", async () => {
  // 300 slots from 30% down to the pool's 1%, the launch guard's line: at slot 1100 a third is gone
  const cfg = { sniperSlots: 300, sniperStartFeeBps: 3000, startSlot: 1000, buy: { creatorBps: 100 }, sell: { creatorBps: 100 } };
  const running = rulesWorld(cfg, { slot: 1100 });
  const { body: buy } = await ask(running, "buy", 100_000_000n);
  assert.equal(buy.fees.pool.bps, 2034);
  assert.equal(buy.fees.hook.bps, 100);
  assert.equal(buy.outAmount, expected({ isBuy: true, amount: 100_000_000n, ...R, protocolBps: 20, hookBps: 100, poolBps: 2034 }).out.toString());
  assert.equal(buy.exact, false);
  assert.deepEqual(buy.hook.rules, { creatorBps: 100, holdersBps: 0, burnBps: 0, sniperEndsAtSlot: 1300, buyLimit: null, strict: null });
  assert.deepEqual(buy.notes, [
    "A sniper fee is running on this coin. Buys pay a pool fee of 20.34% at slot 1100. Sells do not pay it.",
    "The fee falls every slot. It is back to 1% at slot 1300, in about 80 seconds.",
    "This quote uses the fee of slot 1100. A trade that lands later gives the same amount or more.",
    "This coin takes 1% of every buy, in SOL. The quote includes it.",
    "All of it goes to the coin's creator.",
    NEVER,
  ]);
  const { body: sell } = await ask(running, "sell", 50_000_000_000_000n);
  assert.equal(sell.exact, true); assert.equal(sell.fees.pool.bps, 100); assert.equal(sell.hook.rules.sniperEndsAtSlot, null);
  assert.equal(sell.notes.length, 3, "a sell carries no note about the sniper fee");
  assert.equal(sell.outAmount, expected({ isBuy: false, amount: 50_000_000_000_000n, ...R, protocolBps: 20, hookBps: 100, poolBps: 100 }).out.toString());

  // the last slot of the window still pays more than the pool's fee; the slot after it does not
  const last = (await ask(rulesWorld(cfg, { slot: 1299 }), "buy", 100_000_000n)).body;
  assert.equal(last.fees.pool.bps, 3000 - Math.floor((2900 * 299) / 300)); assert.equal(last.exact, false);
  assert.equal(last.notes[1], "The fee falls every slot. It is back to 1% at slot 1300, in about 1 seconds.");
  const over = (await ask(rulesWorld(cfg, { slot: 1300 }), "buy", 100_000_000n)).body;
  assert.equal(over.exact, true); assert.equal(over.fees.pool.bps, 100); assert.equal(over.notes.length, 3); assert.equal(over.hook.rules.sniperEndsAtSlot, null);

  const capped = rulesWorld(cfg, { slot: 1000, platform: { maxFeeOverrideBps: 2500 } });
  assert.equal((await ask(capped, "buy", 100_000_000n)).body.fees.pool.bps, 2500, "the pool cuts the sniper fee down to the platform cap");
  // a start fee that is not above the pool's own fee changes nothing
  const low = rulesWorld({ ...cfg, sniperStartFeeBps: 100 }, { slot: 1100 });
  const plain = (await ask(low, "buy", 100_000_000n)).body;
  assert.equal(plain.exact, true); assert.equal(plain.fees.pool.bps, 100);
});

test("rules: the buy limit is said while it runs, and a buy above it is refused before anything is built", async () => {
  const cfg = { maxBuyQuote: 200_000_000n, limitSlots: 250, startSlot: 1000, buy: { burnBps: 100 }, sell: { burnBps: 100 } };
  const w = rulesWorld(cfg, { slot: 1100 });
  const LIMIT = "A buy limit is running on this coin. One buy can spend at most 200000000 lamports (0.2 SOL). The limit ends at slot 1250, in about 60 seconds. Sells are never limited.";
  const { body: under } = await ask(w, "buy", 100_000_000n);
  assert.equal(under.exact, true, "a limit changes no amount");
  assert.equal(under.notes[0], LIMIT);
  assert.deepEqual(under.hook.rules.buyLimit, { maxAmount: "200000000", endsAtSlot: 1250 });
  assert.equal((await ask(w, "buy", 200_000_000n)).body.inAmount, "200000000", "a buy of exactly the limit goes through");

  const e = await refused(ask(w, "buy", 200_000_001n));
  assert.equal(e.status, 422); assert.equal(e.code, "BUY_LIMIT_EXCEEDED");
  assert.equal(e.message, "This coin has a buy limit. One buy can spend at most 200000000 lamports (0.2 SOL) until slot 1250, in about 60 seconds. This buy sends 200000001 lamports. Send a smaller amount, or wait until the limit ends.");
  assert.deepEqual(errorResponse(e), { status: 422, body: { error: { code: "BUY_LIMIT_EXCEEDED", message: e.message, maxAmount: "200000000", endsAtSlot: 1250 } } });

  // sells are never limited, and carry no note about the limit
  const sell = (await ask(w, "sell", 400_000_000_000_000n)).body;
  assert.equal(sell.hook.rules.buyLimit, null); assert.ok(!sell.notes.some((n) => /buy limit/.test(n)));
  // the first slot after the window: any buy, no note
  const after = rulesWorld(cfg, { slot: 1250 });
  const big = (await ask(after, "buy", 900_000_000n)).body;
  assert.equal(big.hook.rules.buyLimit, null); assert.ok(!big.notes.some((n) => /buy limit/.test(n)));
  assert.equal((await refused(ask(rulesWorld(cfg, { slot: 1249 }), "buy", 900_000_000n))).code, "BUY_LIMIT_EXCEEDED", "the last slot of the window still refuses");

  // /swap answers the same error, and has not asked for a blockhash: nothing was built
  const user = key();
  w.accounts.set(user.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: 5_000_000_000, executable: false });
  w.connection.calls.length = 0;
  const s = await refused(swap(parseSwapParams({ mint: w.baseMint.toBase58(), side: "buy", amount: "200000001", userPublicKey: user.toBase58() }), w.deps));
  assert.equal(s.code, "BUY_LIMIT_EXCEEDED"); assert.deepEqual(s.extra, { maxAmount: "200000000", endsAtSlot: 1250 });
  assert.ok(!w.connection.calls.includes("blockhash"), "calls: " + w.connection.calls.join(", "));

  // both windows at once: the sniper fee first, then the limit, then the shares
  const both = rulesWorld({ ...cfg, sniperSlots: 300, sniperStartFeeBps: 3000 }, { slot: 1100 });
  const notes = (await ask(both, "buy", 100_000_000n)).body.notes;
  assert.equal(notes.length, 7); assert.match(notes[0], /^A sniper fee is running/); assert.equal(notes[3], LIMIT); assert.equal(notes[4], "This coin takes 1% of every buy, in SOL. The quote includes it.");
});

test("rules: a config that cannot be read, or is not this pool's, is not quoted as if it took nothing", async () => {
  const none = world({ pool: RULES });
  assert.equal((await refused(ask(none, "buy", 100_000_000n))).code, "CANNOT_QUOTE");
  const forged = rulesWorld({ owner: key(), buy: { creatorBps: 100 } });
  assert.equal((await refused(ask(forged, "buy", 100_000_000n))).code, "CANNOT_QUOTE", "the right bytes under another program");
  const other = rulesWorld({ pool: key(), buy: { creatorBps: 100 } });
  assert.equal((await refused(ask(other, "buy", 100_000_000n))).code, "CANNOT_QUOTE", "the rules of another pool");
  const unborn = rulesWorld({ minEligible: 0, startSlot: 0, buy: { creatorBps: 100 } });
  assert.equal((await refused(ask(unborn, "buy", 100_000_000n))).code, "CANNOT_QUOTE", "a config whose pool never started");
  const wrong = world({ pool: RULES, cfg: (pool) => taxConfig(pool, 300, 500, 1000) });
  assert.equal((await refused(ask(wrong, "buy", 100_000_000n))).code, "CANNOT_QUOTE");
});

// ---- the transaction: only what the SDK builds for a trade ------------------------------------------------

/// A wallet that can pay, then one call to swap(), then the transaction it answered, decoded.
async function buildSwap(w, side, amount) {
  const user = key();
  w.accounts.set(user.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: 5_000_000_000, executable: false });
  if (side === "sell") w.accounts.set(H.pda.ata(user, w.baseMint).toBase58(), tokenAccount(w.baseMint, user, amount));
  const { body } = await swap(parseSwapParams({ mint: w.baseMint.toBase58(), side, amount: String(amount), userPublicKey: user.toBase58() }), w.deps);
  const tx = H.VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
  const ixs = H.TransactionMessage.decompile(tx.message).instructions;
  return { user, body, tx, ixs, swapIx: ixs.find((i) => i.programId.equals(H.PROGRAMS.hookpool)) };
}
const KINDS = [
  { name: "no hook", pool: {}, program: null },
  { name: "tax", pool: { hookProgram: H.PROGRAMS.hook_tax, hookFlags: TAX_FLAGS, hookKind: 2, hookTreasury: key() }, program: H.PROGRAMS.hook_tax, writable: false, cfg: (pool) => taxConfig(pool, 300, 500, 1000) },
  { name: "launch guard", pool: { hookProgram: H.PROGRAMS.hook_launch_guard, hookFlags: GUARD_FLAGS | F.BEFORE_ADD_LIQ, hookKind: 2 }, program: H.PROGRAMS.hook_launch_guard, writable: true, cfg: (pool) => guardConfig(pool, 4990, 300, 3000) },
  { name: "buyback", pool: { hookProgram: H.PROGRAMS.hook_buyback, hookFlags: BUYBACK_FLAGS, hookKind: 2, hookTreasury: key() }, program: H.PROGRAMS.hook_buyback, writable: true, cfg: (pool, mint) => buybackConfig(pool, mint) },
  { name: "rules", pool: { ...RULES, hookTreasury: key() }, program: H.PROGRAMS.hook_rules, writable: true, cfg: (pool, mint) => rulesConfig(pool, mint, { buy: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, sell: { creatorBps: 100, holdersBps: 200, burnBps: 100 }, sniperSlots: 100, sniperStartFeeBps: 3000, maxBuyQuote: 500_000_000n, limitSlots: 100, startSlot: 4990 }) },
];
function kindWorld(k) {
  const w = world({ pool: k.pool, cfg: k.cfg });
  if (k.program) w.accounts.set(H.pda.extraMetas(k.program).toBase58(), cfgList(k.program, k.writable));
  return w;
}

test("swap: a collectible buy adds the deposit for its NFTs right after the swap, unless mintDeposit is false", async () => {
  const unit = 10_000_000_000_000n;
  const hook = { hookProgram: H.PROGRAMS.hook_collectible, hookFlags: COLLECTIBLE_FLAGS, hookKind: 2 };
  const w = world({ pool: hook, cfg: (pool, mint) => collectionConfig(pool, mint, { unit, maxPerBuy: 3 }) });
  w.accounts.set(H.pda.extraMetas(H.PROGRAMS.hook_collectible).toBase58(), cfgList(H.PROGRAMS.hook_collectible, true));
  const user = key();
  w.accounts.set(user.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: 5_000_000_000, executable: false });
  const ask2 = async (extra = {}) => (await swap(parseSwapParams({ mint: w.baseMint.toBase58(), side: "buy", amount: "100000000", userPublicKey: user.toBase58(), ...extra }), w.deps)).body;
  const body = await ask2();
  const need = H.collectible.mintDepositFor(H.collectible.STANDARD_RENT, { name: "Shots", uriBase: "http://localhost:8787/art" }, 3);
  assert.deepEqual(body.instructions, ["compute_unit_limit", "create_token_account", "create_token_account", "wrap_sol", "sync_wrapped_sol", "open_ticket", "swap", "mint_deposit", "unwrap_sol"]);
  assert.deepEqual(body.quote.mintDeposit, { pieces: 3, lamports: need.toString(), included: true });
  const tx = H.VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
  const ixs = H.TransactionMessage.decompile(tx.message).instructions;
  const dep = ixs[body.instructions.indexOf("mint_deposit")];
  assert.ok(dep.programId.equals(H.SYSTEM_PROGRAM) && dep.keys[0].pubkey.equals(user) && dep.keys[1].pubkey.equals(H.collectible.collectiblePda.ticket(w.pool, user)));
  assert.equal(Buffer.from(dep.data).readBigUInt64LE(4), need);
  assert.ok(ixs.every((i) => !i.programId.equals(H.PROGRAMS.hook_collectible) || Buffer.from(i.data).subarray(0, 8).equals(Buffer.from(H.IX.hook_collectible.open_ticket))), "no mint in a buy");
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.ok(body.notes.some((n) => n.startsWith("The transaction adds a deposit of " + need + " lamports to the wallet's ticket")), body.notes.join(" | "));
  assert.ok(!body.notes.some((n) => n.startsWith("A swap adds a deposit of")), "the quote's general sentence gives way to the exact one");
  // the opt-out
  const off = await ask2({ mintDeposit: false });
  assert.ok(!off.instructions.includes("mint_deposit"));
  assert.deepEqual(off.quote.mintDeposit, { pieces: 3, lamports: "0", included: false });
  assert.ok(off.notes.some((n) => n.startsWith("mintDeposit is false, so the transaction adds no deposit.")));
  // a buy for another wallet earns nothing and adds nothing
  const other = await ask2({ recipient: key().toBase58() });
  assert.ok(!other.instructions.includes("mint_deposit") && !other.instructions.includes("open_ticket"));
  assert.deepEqual(other.quote.mintDeposit, { pieces: 0, lamports: "0", included: false });
  // a wallet that holds the buy but not the deposit is told so before anything is built
  w.accounts.set(user.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: 100_000_000 + 5_000 + 2_100_000 + 2_100_000, executable: false });
  const e = await refused(ask2());
  assert.equal(e.code, "INSUFFICIENT_FUNDS");
  assert.match(e.message, new RegExp(need + " for the deposit for the NFTs of its pieces"));
});

test("instruction kinds: the deposit is a transfer of the server's own amount from the signer to its own ticket on this pool", () => {
  const user = key(), poolAddr = key();
  const t = { user, recipient: null, pool: { address: poolAddr, baseMint: key(), quoteMint: H.NATIVE_MINT }, userWsol: H.pda.ata(user, H.NATIVE_MINT), amount: 100n, minOut: 1n, direction: H.DIRECTION.BUY, isBuy: true, collectible: true, deposit: 777n };
  const dep = (u, p, l) => H.collectible.depositTransfer(u, p, l);
  assert.equal(instructionKind(dep(user, poolAddr, 777n), t), "mint_deposit");
  assert.equal(instructionKind(dep(user, poolAddr, 778n), t), null, "another amount");
  assert.equal(instructionKind(dep(user, key(), 777n), t), null, "the ticket of another pool");
  assert.equal(instructionKind(dep(key(), poolAddr, 777n), t), null, "another wallet");
  assert.equal(instructionKind(dep(user, poolAddr, 777n), { ...t, deposit: 0n }), null, "no deposit asked for");
  assert.equal(instructionKind(dep(user, poolAddr, 777n), { ...t, isBuy: false }), null, "never on a sell");
  assert.equal(instructionKind(dep(user, poolAddr, 777n), { ...t, collectible: false }), null, "never on another kind of pool");
  assert.equal(instructionKind(dep(user, poolAddr, 777n), { ...t, recipient: key() }), null, "never on a buy for another wallet");
  // the wrap stays what it was
  assert.equal(instructionKind(H.SystemProgram.transfer({ fromPubkey: user, toPubkey: t.userWsol, lamports: 100n }), t), "wrap_sol");
});

test("swap: for every kind of pool the transaction holds the SDK's instructions, the hook's own caller and its config", async () => {
  for (const k of KINDS) {
    const w = kindWorld(k);
    const hookProgram = k.program ?? H.SYSTEM_PROGRAM;
    const buy = await buildSwap(w, "buy", 100_000_000n);
    assert.deepEqual(buy.body.instructions, ["compute_unit_limit", "create_token_account", "create_token_account", "wrap_sol", "sync_wrapped_sol", "swap", "unwrap_sol"], k.name);
    const sell = await buildSwap(w, "sell", 50_000_000_000_000n);
    assert.deepEqual(sell.body.instructions, ["compute_unit_limit", "create_token_account", "swap", "unwrap_sol"], k.name);
    for (const t of [buy, sell]) {
      assert.equal(t.ixs.length, t.body.instructions.length, k.name);
      assert.ok(t.ixs.every((i) => !Object.entries(H.PROGRAMS).some(([name, id]) => name !== "hookpool" && i.programId.equals(id))), k.name + ": no instruction of a hook program");
      assert.equal(t.tx.message.header.numRequiredSignatures, 1);
      const keys = t.swapIx.keys;
      assert.ok(keys[0].pubkey.equals(t.user) && keys[0].isSigner, k.name);
      assert.ok(keys[2].pubkey.equals(w.pool), k.name + ": the pool");
      assert.ok(keys[10].pubkey.equals(hookProgram), k.name + ": the hook program");
      assert.ok(keys[12].pubkey.equals(H.pda.caller(hookProgram)[0]), k.name + ": the caller of this hook program, not a shared one");
      assert.equal(keys.length, 17 + (k.program ? 1 : 0), k.name + ": 15 fixed accounts, 2 for the event, then the hook's own");
      if (k.program) {
        const cfg = keys[17];
        assert.ok(cfg.pubkey.equals(H.pda.cfg(k.program, w.pool)), k.name + ": the hook's config");
        assert.equal(cfg.isWritable, k.writable, k.name + ": the config is " + (k.writable ? "writable" : "read-only") + ", as the hook's list says");
        assert.equal(cfg.isSigner, false);
        assert.ok(keys[9].pubkey.equals(k.pool.hookTreasury ?? H.pda.ata(t.user, H.NATIVE_MINT)) && keys[9].isWritable, k.name + ": the treasury");
      }
      assert.equal(t.body.quote.hook ? t.body.quote.hook.template : null, k.program ? k.name.replace("launch guard", "launch_guard") : null);
    }
    // the callers differ from one hook program to the next
    if (k.program) assert.ok(!H.pda.caller(k.program)[0].equals(H.pda.caller(H.SYSTEM_PROGRAM)[0]));
  }
});

test("swap: the allow-list takes the swap of this pool and nothing a template could add", async () => {
  for (const k of KINDS) {
    const w = kindWorld(k);
    const user = key();
    const pool = H.decodePool(w.pool, new Uint8Array(w.accounts.get(w.pool.toBase58()).data));
    const client = new H.HookpoolClient(w.connection);
    const keys = client.keys(pool);
    const target = { user, recipient: null, pool, userWsol: H.pda.ata(user, H.NATIVE_MINT), amount: 100_000_000n, minOut: 5n, direction: H.DIRECTION.BUY, isBuy: true, collectible: false };
    const ref = k.program ? { program: k.program, treasury: pool.hookQuoteTreasury, extra: [{ pubkey: H.pda.cfg(k.program, w.pool), isSigner: false, isWritable: !!k.writable }] } : H.NO_HOOK;
    const good = H.ix.swap(user, keys, ref, H.DIRECTION.BUY, 100_000_000n, 5n);
    assert.equal(instructionKind(good, target), "swap", k.name);
    // the same swap with one thing changed is not this trade
    const bend = (i, pubkey) => { const c = H.ix.swap(user, keys, ref, H.DIRECTION.BUY, 100_000_000n, 5n); c.keys[i] = { ...c.keys[i], pubkey }; return c; };
    assert.equal(instructionKind(bend(12, H.PublicKey.findProgramAddressSync([Buffer.from("caller")], H.PROGRAMS.hookpool)[0]), target), null, k.name + ": the single caller of an older build");
    assert.equal(instructionKind(bend(12, H.pda.caller(key())[0]), target), null, k.name + ": the caller of another hook");
    assert.equal(instructionKind(bend(10, H.PROGRAMS.hook_collectible), target), null, k.name + ": another hook program");
    assert.equal(instructionKind(bend(2, key()), target), null, k.name + ": another pool");
    assert.equal(instructionKind(H.ix.swap(user, keys, ref, H.DIRECTION.BUY, 100_000_001n, 5n), target), null, k.name + ": another amount");
    assert.equal(instructionKind(H.ix.swap(user, keys, ref, H.DIRECTION.BUY, 100_000_000n, 4n), target), null, k.name + ": another floor");
    assert.equal(instructionKind(H.ix.swap(user, keys, ref, H.DIRECTION.SELL, 100_000_000n, 5n), target), null, k.name + ": the other direction");
    assert.equal(instructionKind(H.ix.addLiquidity(user, keys, ref, 1n, 1n, 1n), target), null, k.name + ": liquidity");
    // what the templates can do besides a trade never rides in one
    const foreign = [
      H.ix.executeBuyback(user, keys, 0n), H.ix.rulesRunBurn(user, keys, 0n), H.ix.rulesStake(user, keys, 1n), H.ix.rulesUnstake(user, keys, 1n),
      H.ix.rulesClaimRewards(user, keys), H.ix.rulesClaimCreator(user, keys), H.ix.rulesLockCreator(user, keys, 1n, 2_000_000_000n), H.ix.rulesUnlockCreator(user, keys),
    ];
    for (const ins of foreign) assert.equal(instructionKind(ins, { ...target, collectible: true }), null, k.name + ": " + ins.programId.toBase58());
  }
});

// ---- the strict coin ---------------------------------------------------------------------------------------
// A coin of the rules template whose own transfer hook is the rules program (a Token-2022 coin): a max
// wallet, an early lock, holder rewards without staking. Launched at slot 1000: max wallet 3% of the supply
// (30e12 raw units) for 330 slots, early window 80 slots, early unlock at 200. Read at slot 1050 unless said.

const STRICT_POOL = { ...RULES, baseTokenProgram: H.TOKEN_2022_PROGRAM, hookTreasury: key() };
const CAP = 30_000_000_000_000n;
const SLOT = 1050n; const UNIX = 1_760_000_500n;
/// `wallets`: { address, lamports, balance, record } for the wallets the rules are checked against.
function strictWorld(cfg = {}, o = {}, wallets = []) {
  const w = world({ ...o, slot: Number(o.slot ?? SLOT), pool: { ...STRICT_POOL, ...(o.pool ?? {}) }, cfg: (pool, mint) => rulesConfig(pool, mint, {
    kind: 1, maxWalletBps: 300, maxWalletAmount: CAP, earlySlots: 80, earlyUnlockSlots: 200, maxWalletSlots: 330, startSlot: 1000,
    buy: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, sell: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, ...cfg,
  }) });
  w.accounts.set(H.CLOCK_SYSVAR.toBase58(), clockAccount(o.slot ?? SLOT, o.unixTime ?? UNIX));
  w.accounts.set(H.pda.extraMetas(H.PROGRAMS.hook_rules).toBase58(), cfgList(H.PROGRAMS.hook_rules, true));
  for (const x of wallets) {
    if (x.lamports !== undefined) w.accounts.set(x.address.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: Number(x.lamports), executable: false });
    if (x.balance !== undefined) w.accounts.set(H.pda.ata(x.address, w.baseMint, H.TOKEN_2022_PROGRAM).toBase58(), tokenAccount(w.baseMint, x.address, x.balance, H.TOKEN_2022_PROGRAM));
    if (x.record) w.accounts.set(H.rulesPda.holder(w.pool, x.address).toBase58(), holderRecord(w.pool, x.address, x.record));
  }
  return w;
}
const askAs = (w, side, amount, wallet) => quote(parseQuoteParams({ mint: w.baseMint.toBase58(), side, amount: String(amount), userPublicKey: wallet.toBase58() }), w.deps);
const swapAs = (w, body) => swap(parseSwapParams({ mint: w.baseMint.toBase58(), side: "buy", amount: "50000000", ...body }), w.deps);
/// The most a buy gives on this pool: its output at the pool's own fee, with the two rates of the buy side.
const atBase = (amount) => expected({ isBuy: true, amount, ...R, protocolBps: 20, hookBps: 200, poolBps: 100 }).out;
const STRICT_FIRST = "This is a strict coin. Its rules run inside every transfer of the coin, not only in this pool.";
const RENT_NOTE = "The record's rent, 1788720 lamports, is paid by the wallet that signs and comes back when the record is closed.";

test("strict: a quote names the windows; with a wallet it says what the coins will be; /swap opens the record", async () => {
  const w = strictWorld();
  const { body: q0 } = await ask(w, "buy", 50_000_000n);
  const out = BigInt(q0.outAmount);
  assert.equal(q0.exact, true); assert.equal(out, atBase(50_000_000n)); assert.equal(q0.coin.tokenProgram, H.TOKEN_2022_PROGRAM.toBase58());
  assert.deepEqual(q0.hook.rules.strict, { maxWallet: CAP.toString(), maxWalletEndsAtSlot: 1330, earlyEndsAtSlot: 1080, earlyUnlockSlot: 1200, wallet: null });
  assert.equal(q0.notes[1], "It is split in three: 0.5% for the coin's creator, 1% for holders with a holder record and 0.5% to buy the coin back and burn it.");
  assert.equal(q0.notes[2], "While less than 0.1% of the coin's supply is in holder records, the holders' share goes to the burn instead.");
  assert.deepEqual(q0.notes.slice(4), [
    STRICT_FIRST,
    "A max wallet is running on this coin. Until slot 1330, in about 112 seconds, one wallet can hold at most 30000000000000 raw units of the coin. A sell is never held by it.",
    "Coins bought until slot 1080, in about 12 seconds, are early coins. They cannot leave the wallet before slot 1200, in about 60 seconds.",
    "Only wallets with a holder record earn the holders' share. /api/v1/swap opens the buyer's record in front of its first buy. The record's rent, 1788720 lamports, comes back when the record is closed.",
  ]);
  // a wallet that never traded the coin
  const A = key();
  const wa = strictWorld({}, {}, [{ address: A, lamports: 5_000_000_000n }]);
  const { body: qa } = await askAs(wa, "buy", 50_000_000n, A);
  assert.deepEqual(qa.hook.rules.strict.wallet, { address: A.toBase58(), balance: "0", after: out.toString(), holderRecord: false, opensHolderRecord: true, locked: out.toString(), creatorLockedUntil: null });
  assert.deepEqual(qa.notes.slice(7), [
    "After this buy the receiving wallet holds " + out + " raw units, " + (CAP - out) + " under the cap.",
    "The " + out + " raw units of this buy are early coins. They stay locked in the wallet until slot 1200.",
    "The receiving wallet has no holder record. /api/v1/swap opens it in front of the buy, so its coins earn a part of the holders' share. " + RENT_NOTE,
  ]);
  // a wallet with a record and coins
  const B = key();
  const wb = strictWorld({}, {}, [{ address: B, lamports: 5_000_000_000n, balance: 1_000_000_000_000n, record: { balance: 1_000_000_000_000n } }]);
  const { body: qb } = await askAs(wb, "buy", 50_000_000n, B);
  assert.equal(qb.hook.rules.strict.wallet.holderRecord, true); assert.equal(qb.hook.rules.strict.wallet.opensHolderRecord, false);
  assert.equal(qb.hook.rules.strict.wallet.after, (1_000_000_000_000n + out).toString());
  assert.ok(qb.notes.includes("The receiving wallet has a holder record, so its coins earn a part of the holders' share."));
  const { body: qs } = await askAs(wb, "sell", 10_000_000_000n, B);
  assert.deepEqual(qs.notes.slice(4), [STRICT_FIRST, "Coins bought in the coin's first slots cannot be sold before slot 1200, in about 60 seconds. Other coins can."]);
  assert.equal(qs.hook.rules.strict.wallet.locked, "0"); assert.equal(qs.exact, true);
  // /swap: open_holder right before the swap, for the signer's own record on this pool, and the coin's four accounts in the swap
  const { body: sw } = await swapAs(wa, { userPublicKey: A.toBase58() });
  assert.deepEqual(sw.instructions, ["compute_unit_limit", "create_token_account", "create_token_account", "wrap_sol", "sync_wrapped_sol", "open_holder", "swap", "unwrap_sol"]);
  const ixs = H.TransactionMessage.decompile(H.VersionedTransaction.deserialize(Buffer.from(sw.transaction, "base64")).message).instructions;
  assert.ok(ixs[5].programId.equals(H.PROGRAMS.hook_rules) && ixs[5].keys[0].isSigner);
  assert.deepEqual(ixs[5].keys.map((k) => k.pubkey.toBase58()), [A, H.rulesPda.cfg(wa.pool), wa.pool, H.rulesPda.holder(wa.pool, A), H.pda.ata(A, wa.baseMint, H.TOKEN_2022_PROGRAM), H.SYSTEM_PROGRAM].map((k) => k.toBase58()));
  assert.deepEqual(ixs[6].keys.slice(17).map((k) => [k.pubkey.toBase58(), k.isWritable]), [[H.rulesPda.cfg(wa.pool).toBase58(), true], [H.rulesPda.holder(wa.pool, A).toBase58(), true], [H.rulesPda.holder(wa.pool, wa.pool).toBase58(), true], [H.rulesPda.validation(wa.baseMint).toBase58(), false]]);
  assert.ok(sw.notes.includes("The receiving wallet has no holder record. /api/v1/swap opens it in front of the buy, so its coins earn a part of the holders' share. " + RENT_NOTE));
  const { body: swb } = await swapAs(wb, { userPublicKey: B.toBase58() });
  assert.ok(!swb.instructions.includes("open_holder"), "a wallet with a record gets no open_holder");
  // the allow-list takes only the signer's own record on this pool
  const pool = H.decodePool(wa.pool, new Uint8Array(wa.accounts.get(wa.pool.toBase58()).data));
  const keys = new H.HookpoolClient(wa.connection).keys(pool);
  const t = { user: A, recipient: null, pool, userWsol: H.pda.ata(A, H.NATIVE_MINT), amount: 50_000_000n, minOut: 1n, direction: H.DIRECTION.BUY, isBuy: true, collectible: false, strict: true };
  assert.equal(instructionKind(H.ix.rulesOpenHolder(A, keys), t), "open_holder");
  assert.equal(instructionKind(H.ix.rulesOpenHolder(B, keys), t), null, "another wallet's record");
  assert.equal(instructionKind(H.ix.rulesOpenHolder(A, { ...keys, pool: key() }), t), null, "another pool");
  assert.equal(instructionKind(H.ix.rulesOpenHolder(A, keys), { ...t, isBuy: false, direction: H.DIRECTION.SELL }), null, "never in a sell");
  assert.equal(instructionKind(H.ix.rulesOpenHolder(A, keys), { ...t, strict: false }), null, "never on a coin that is not strict");
});

test("strict: each refusal, with the numbers to change the trade, before anything is built", async () => {
  const B = key(); const C = key();
  // MAX_WALLET_EXCEEDED: a buy of 1 SOL by an empty wallet gives far more than the cap
  const wb = strictWorld({}, {}, [{ address: B, lamports: 5_000_000_000n }]);
  const e1 = await refused(askAs(wb, "buy", 1_000_000_000n, B));
  assert.equal(e1.status, 422); assert.equal(e1.code, "MAX_WALLET_EXCEEDED");
  const M = BigInt(e1.extra.maxAmount);
  assert.deepEqual(e1.extra, { maxWallet: CAP.toString(), walletBalance: "0", room: CAP.toString(), maxAmount: M.toString(), endsAtSlot: 1330 });
  assert.ok(M > 0n && atBase(M) <= CAP && atBase(M + 1n) > CAP, "the largest buy whose coins fit, to the lamport");
  assert.equal(e1.message, "This coin has a max wallet. Until slot 1330, in about 112 seconds, one wallet can hold at most " + CAP + " raw units of the coin. The receiving wallet holds 0, so it can receive " + CAP + " more, and this buy would give it " + atBase(1_000_000_000n) + ". The largest buy it can make now is " + M + " lamports.");
  assert.equal((await askAs(wb, "buy", M, B)).body.hook.rules.strict.wallet.after, atBase(M).toString(), "a buy of maxAmount is quoted");
  assert.equal((await refused(askAs(wb, "buy", M + 1n, B))).code, "MAX_WALLET_EXCEEDED", "one lamport more is refused");
  wb.connection.calls.length = 0;
  const s1 = await refused(swapAs(wb, { amount: "1000000000", userPublicKey: B.toBase58() }));
  assert.equal(s1.code, "MAX_WALLET_EXCEEDED"); assert.ok(!wb.connection.calls.includes("blockhash"), "/swap refuses before it builds");
  // a wallet so near the cap that no quotable buy fits
  const full = strictWorld({}, {}, [{ address: B, lamports: 5_000_000_000n, balance: CAP - 100n, record: { balance: CAP - 100n } }]);
  const e2 = await refused(askAs(full, "buy", 10_000_000n, B));
  assert.equal(e2.extra.room, "100"); assert.equal(e2.extra.maxAmount, "0"); assert.ok(e2.message.endsWith("It can buy nothing more until then."));
  // EARLY_LOCKED: a sell that would take early coins
  const A = key();
  const wa = strictWorld({}, {}, [{ address: A, lamports: 5_000_000_000n, balance: 9_000_000_000_000n, record: { balance: 9_000_000_000_000n, earlyBought: 5_000_000_000_000n } }]);
  const e3 = await refused(askAs(wa, "sell", 4_500_000_000_000n, A));
  assert.equal(e3.code, "EARLY_LOCKED");
  assert.deepEqual(e3.extra, { walletBalance: "9000000000000", locked: "5000000000000", free: "4000000000000", unlockSlot: 1200 });
  assert.equal(e3.message, "Coins this wallet bought in the coin's first slots cannot leave it before slot 1200, in about 60 seconds. The wallet holds 9000000000000 raw units, 5000000000000 of them bought early, so it can sell at most 4000000000000 now.");
  assert.equal((await refused(swapAs(wa, { side: "sell", amount: "4500000000000", userPublicKey: A.toBase58() }))).code, "EARLY_LOCKED");
  const { body: qa } = await askAs(wa, "sell", 4_000_000_000_000n, A);
  assert.ok(qa.notes.includes("This wallet holds 9000000000000 raw units of the coin. 5000000000000 of them are locked until slot 1200, so it can sell at most 4000000000000 now."));
  assert.equal(qa.hook.rules.strict.wallet.locked, "5000000000000");
  const later = strictWorld({}, { slot: 1200n }, [{ address: A, lamports: 5_000_000_000n, balance: 9_000_000_000_000n, record: { balance: 9_000_000_000_000n, earlyBought: 5_000_000_000_000n } }]);
  assert.equal((await askAs(later, "sell", 4_500_000_000_000n, A)).body.hook.rules.strict.wallet.locked, "0", "from the unlock slot on the early coins move");
  // CREATOR_LOCKED: the creator's floor
  const D = key();
  const until = UNIX + 1000n;
  const wd = strictWorld({}, {}, [{ address: D, lamports: 5_000_000_000n, balance: 9_000_000_000_000n, record: { balance: 9_000_000_000_000n, locked: 9_000_000_000_000n, lockedUntil: until } }]);
  const e4 = await refused(askAs(wd, "sell", 1_000_000_000_000n, D));
  assert.equal(e4.code, "CREATOR_LOCKED");
  assert.deepEqual(e4.extra, { walletBalance: "9000000000000", locked: "9000000000000", free: "0", unlockAt: Number(until) });
  const iso = new Date(Number(until) * 1000).toISOString().replace(/\.000Z$/, "Z");
  assert.equal(e4.message, "This wallet is the coin's creator, and 9000000000000 raw units of its coins are locked until " + iso + " (Unix time " + until + "). The wallet holds 9000000000000, so it can sell at most 0 now.");
  const open = strictWorld({}, { unixTime: until }, [{ address: D, lamports: 5_000_000_000n, balance: 9_000_000_000_000n, record: { balance: 9_000_000_000_000n, locked: 9_000_000_000_000n, lockedUntil: until } }]);
  assert.equal((await askAs(open, "sell", 1_000_000_000_000n, D)).body.hook.rules.strict.wallet.creatorLockedUntil, null, "from the date on the coins move");
  // HOLDER_RECORD_REQUIRED: a buy for a recipient without a record, in the early window
  const s4 = await refused(swapAs(wb, { amount: "10000000", userPublicKey: B.toBase58(), recipient: C.toBase58() }));
  assert.equal(s4.code, "HOLDER_RECORD_REQUIRED"); assert.deepEqual(s4.extra, { recipient: C.toBase58(), endsAtSlot: 1080 });
  assert.equal(s4.message, "A buy in this coin's first slots needs a holder record of the wallet that receives the coins, and only that wallet can open it. The recipient has none. Until slot 1080, in about 12 seconds, buy for a wallet that has one, or let the recipient buy for itself: the API opens a wallet's own record in front of its buy.");
  // after the early window the same buy builds, with no open_holder, and says the recipient earns nothing yet
  const past = strictWorld({}, { slot: 1100n }, [{ address: B, lamports: 5_000_000_000n }]);
  const { body: forC } = await swapAs(past, { amount: "10000000", userPublicKey: B.toBase58(), recipient: C.toBase58() });
  assert.ok(!forC.instructions.includes("open_holder"));
  assert.ok(forC.notes.includes("The receiving wallet has no holder record, so its coins earn no part of the holders' share until it opens one. Only that wallet can open it."));
});

test("strict: while the sniper fee falls, the max wallet is judged against the most a buy can give", async () => {
  // a sniper fee from 30% over 300 slots; read at slot 1050 the fee is 25.17%, and it falls every slot
  const B = key();
  const w = strictWorld({ sniperSlots: 300, sniperStartFeeBps: 3000 }, {}, [{ address: B, lamports: 5_000_000_000n }]);
  const feeAt = (slot) => 3000 - Math.floor((2900 * (slot - 1000)) / 300);
  const atSlot = (amount, slot) => expected({ isBuy: true, amount, ...R, protocolBps: 20, hookBps: 200, poolBps: feeAt(slot) }).out;
  assert.equal(feeAt(1050), 2517);
  const e = await refused(askAs(w, "buy", 1_000_000_000n, B));
  assert.equal(e.code, "MAX_WALLET_EXCEEDED");
  const M = BigInt(e.extra.maxAmount);
  assert.ok(atBase(M) <= CAP && atBase(M + 1n) > CAP, "sized at the pool's own fee: the most the window can pay out");
  assert.ok(atSlot(M, 1050) < atBase(M), "at this slot's fee the same buy gives less: that is the room left for the falling fee");
  for (const slot of [1051, 1060, 1150, 1299]) assert.ok(atSlot(M, slot) <= CAP, "a buy of maxAmount fits whenever it lands, slot " + slot);
  assert.equal(e.message, "This coin has a max wallet. Until slot 1330, in about 112 seconds, one wallet can hold at most " + CAP + " raw units of the coin. The receiving wallet holds 0, so it can receive " + CAP + " more, and this buy would give it up to " + atBase(1_000_000_000n) + ". The largest buy it can make now is " + M + " lamports. The sniper fee falls every slot, so the check counts the most a buy can give, at the pool's normal fee.");
  // sized at the slot's own fee, as before, the buy would pass the cap one slot later
  const loose = largestBuyUnder((a) => atSlot(a, 1050), CAP, 1_000_000_000n);
  assert.ok(loose > M && atSlot(loose, 1050) <= CAP && atSlot(loose, 1051) > CAP);
  assert.equal((await refused(askAs(w, "buy", loose, B))).code, "MAX_WALLET_EXCEEDED", "the API refuses it");
  // the quote of maxAmount: not exact, and the notes leave room for the fee
  const { body: q } = await askAs(w, "buy", M, B);
  assert.equal(q.exact, false); assert.equal(q.fees.pool.bps, 2517);
  // the SDK's own ceiling of that quote is the number the API counts with
  const client = new H.HookpoolClient(w.connection);
  const pool = H.decodePool(w.pool, new Uint8Array(w.accounts.get(w.pool.toBase58()).data));
  const platform = H.decodePlatform(new Uint8Array(w.accounts.get(H.pda.platform().toBase58()).data));
  const hook = { template: "rules", summary: H.describeFlags(RULES_FLAGS), rules: H.decodeRulesConfig(new Uint8Array(w.accounts.get(H.pda.cfg(H.PROGRAMS.hook_rules, w.pool).toBase58()).data)) };
  const sdk = await client.quoteLocal(pool, platform, H.DIRECTION.BUY, M, hook, 1050n);
  assert.equal(sdk.amountOut, atSlot(M, 1050)); assert.equal(sdk.amountOutCeiling, atBase(M), "the SDK's amountOutCeiling is the output at the pool's own fee");
  assert.equal(q.hook.rules.strict.wallet.after, atBase(M).toString()); assert.equal(q.hook.rules.strict.wallet.locked, atBase(M).toString());
  assert.ok(q.notes.includes("The sniper fee falls every slot, so a buy that lands later gives more coins than this quote. The max wallet check leaves room for that: it counts the most this buy can give, at the pool's normal fee. A price fall between the quote and the landing can still push a buy within a hair of the cap over it, so keep a margin."));
  assert.ok(q.notes.includes("After this buy the receiving wallet holds up to " + atBase(M) + " raw units, at least " + (CAP - atBase(M)) + " under the cap."));
  assert.ok(q.notes.includes("The coins of this buy, up to " + atBase(M) + " raw units, are early coins. They stay locked in the wallet until slot 1200."));
  // largestBuyUnder: an amount that cannot be quoted never fits, and nothing fitting gives 0
  const tiny = (a) => (a < 100n ? 0n : a * 10n);
  assert.equal(largestBuyUnder(tiny, 50n, 1000n), 0n);
  assert.equal(largestBuyUnder(tiny, 1005n, 1000n), 100n);
  assert.equal(largestBuyUnder((a) => a * 10n, 1005n, 1000n), 100n);
  assert.equal(largestBuyUnder((a) => a * 10n, 20_000n, 1000n), 1000n, "never above the buy that was asked");
});

test("swap: a buy needs the amount, the fee and every rent the transaction pays, said in words", async () => {
  const A = key();
  // a strict coin, a fresh wallet: the coin's Token-2022 account, a wrapped SOL account for the length of the transaction, the holder record
  const need = 50_000_000n + 5000n + 2_108_880n + 2_039_280n + 1_788_720n;
  const short = strictWorld({}, {}, [{ address: A, lamports: need - 1n }]);
  const e = await refused(swapAs(short, { userPublicKey: A.toBase58() }));
  assert.equal(e.code, "INSUFFICIENT_FUNDS");
  assert.equal(e.message, "The wallet holds " + (need - 1n) + " lamports. This buy needs " + need + ": 50000000 for the buy, 5000 for the network fee, 2108880 for the rent of its token account for this coin, 2039280 for the rent of a wrapped SOL account, which comes back at the end of the transaction, 1788720 for the rent of its holder record, which comes back when the record is closed.");
  const enough = strictWorld({}, {}, [{ address: A, lamports: need }]);
  assert.equal((await swapAs(enough, { userPublicKey: A.toBase58() })).body.instructions.length, 8);
  // a wallet with a record and the coin's account open: the amount, the fee and the wrapped SOL account
  const B = key();
  const less = 50_000_000n + 5000n + 2_039_280n;
  const wb = strictWorld({}, {}, [{ address: B, lamports: less - 1n, balance: 0n, record: { balance: 0n } }]);
  const e2 = await refused(swapAs(wb, { userPublicKey: B.toBase58() }));
  assert.equal(e2.message, "The wallet holds " + (less - 1n) + " lamports. This buy needs " + less + ": 50000000 for the buy, 5000 for the network fee, 2039280 for the rent of a wrapped SOL account, which comes back at the end of the transaction.");
  // a plain pool, the recipient's token account missing: the signer pays its rent
  const w = world();
  const C = key(); const D = key();
  w.accounts.set(C.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: Number(50_000_000n + 5000n + 2_039_280n + 2_039_280n - 1n), executable: false });
  const e3 = await refused(swap(parseSwapParams({ mint: w.baseMint.toBase58(), side: "buy", amount: "50000000", userPublicKey: C.toBase58(), recipient: D.toBase58() }), w.deps));
  assert.equal(e3.message, "The wallet holds 54083559 lamports. This buy needs 54083560: 50000000 for the buy, 5000 for the network fee, 2039280 for the rent of the recipient's token account for this coin, 2039280 for the rent of a wrapped SOL account, which comes back at the end of the transaction.");
  assert.ok(50_000_000n + 5000n <= 54_083_559n, "the old rule, amount plus fee, would have built a transaction the chain refuses");
});

test("custom hook: frozen, not exact where it can change the amounts, its powers named", async () => {
  const program = key();
  const w = world({ pool: { hookProgram: program, hookFlags: F.BEFORE_SWAP | F.TAKE_HOOK_FEE | F.OVERRIDE_FEE | F.CALL_ON_BUY | F.CALL_ON_SELL, hookKind: 1 } });
  const { body } = await ask(w, "buy", 100_000_000n);
  assert.deepEqual(body.hook, { program: program.toBase58(), template: "custom", kind: "frozen", runsOnBuys: true, runsOnSells: true });
  assert.equal(body.exact, false);
  assert.equal(body.outAmount, "47075426838739", "the estimate assumes the hook takes nothing");
  assert.deepEqual(body.notes, [
    "This pool runs a custom hook. This quote assumes the hook takes nothing.",
    "The hook can take a fee of up to 10%.",
    "The hook can change the pool fee, up to 50%.",
    "/api/v1/swap asks the chain and answers the real output.",
  ]);
  assert.equal(body.fees.hook.bps, 0);
  const curve = world({ pool: { hookProgram: key(), hookFlags: F.BEFORE_SWAP | F.OVERRIDE_CURVE | F.CALL_ON_BUY, hookKind: 1 } });
  assert.ok((await ask(curve, "buy", 100_000_000n)).body.notes.includes("The hook sets the price itself."));
  // that hook is called on buys only: a sell is plain curve math, and exact
  const sell = (await ask(curve, "sell", 50_000_000_000_000n)).body;
  assert.equal(sell.exact, true);
  assert.deepEqual(sell.notes, ["This pool runs a custom hook. The pool does not call it on this trade."]);
  // a hook with no power over the amounts (it only watches, after the swap) is exact too, and can still refuse
  const watcher = world({ pool: { hookProgram: key(), hookFlags: F.AFTER_SWAP | F.CALL_ON_BUY, hookKind: 1 } });
  const watched = (await ask(watcher, "buy", 100_000_000n)).body;
  assert.equal(watched.exact, true);
  assert.deepEqual(watched.notes, ["This pool runs a custom hook. It cannot change the amounts of this trade. It can refuse it."]);
  // before_swap without any power cannot change the amounts either
  const mute = world({ pool: { hookProgram: key(), hookFlags: F.BEFORE_SWAP | F.CALL_ON_BUY | F.CALL_ON_SELL, hookKind: 1 } });
  assert.equal((await ask(mute, "buy", 100_000_000n)).body.exact, true);
});

test("a template hook whose settings cannot be read is not quoted as if it took nothing", async () => {
  const w = world({ pool: { hookProgram: H.PROGRAMS.hook_tax, hookFlags: TAX_FLAGS, hookKind: 2 } });
  const e = await refused(ask(w, "buy", 100_000_000n));
  assert.equal(e.status, 422); assert.equal(e.code, "CANNOT_QUOTE");
  const wrong = world({ pool: { hookProgram: H.PROGRAMS.hook_tax, hookFlags: TAX_FLAGS, hookKind: 2 }, cfg: (pool) => guardConfig(pool, 1, 1, 1) });
  assert.equal((await refused(ask(wrong, "buy", 100_000_000n))).code, "CANNOT_QUOTE");
});

test("TRADING_PAUSED, NOT_DEPLOYED, UNSUPPORTED_POOL, POOL_NOT_FOUND", async () => {
  const paused = await refused(ask(world({ platform: { paused: true } }), "buy", 100_000_000n));
  assert.equal(paused.status, 503); assert.equal(paused.code, "TRADING_PAUSED"); assert.equal(paused.message, "Trading is paused on Programmable.");

  const none = await refused(ask(world({ noPlatform: true }), "buy", 100_000_000n));
  assert.equal(none.status, 503); assert.equal(none.code, "NOT_DEPLOYED");

  const other = world({ quoteMint: key() });
  const byPool = await refused(quote(parseQuoteParams({ pool: other.pool.toBase58(), side: "buy", amount: "1000" }), other.deps));
  assert.equal(byPool.status, 422); assert.equal(byPool.code, "UNSUPPORTED_POOL");
  assert.equal(byPool.message, "This pool does not trade against SOL. The API trades coins against SOL only.");

  const empty = world();
  const missing = await refused(quote(parseQuoteParams({ mint: key().toBase58(), side: "buy", amount: "1000" }), empty.deps));
  assert.equal(missing.status, 404); assert.equal(missing.code, "POOL_NOT_FOUND"); assert.match(missing.message, /No Programmable pool trades this mint against SOL/);
  const notPool = await refused(quote(parseQuoteParams({ pool: H.pda.platform().toBase58(), side: "buy", amount: "1000" }), empty.deps));
  assert.equal(notPool.code, "POOL_NOT_FOUND"); assert.match(notPool.message, /No Programmable pool at this address/);

  // the right bytes under the wrong program are not a pool
  const forged = world({ pool: { owner: key() } });
  assert.equal((await refused(ask(forged, "buy", 100_000_000n))).code, "POOL_NOT_FOUND");
});

test("CANNOT_QUOTE: an amount too small, and one the pool cannot hold", async () => {
  const w = world();
  const small = await refused(ask(w, "buy", 1n));
  assert.equal(small.status, 422); assert.equal(small.code, "CANNOT_QUOTE"); assert.match(small.message, /too small/);
  const tiny = await refused(ask(w, "sell", 2n));
  assert.equal(tiny.code, "CANNOT_QUOTE");
  // a reserve that would pass 64 bits: the chain would stop with a math overflow
  const deep = world({ pool: { reserveBase: 1_000_000_000_000_000_000n } });
  const huge = await refused(ask(deep, "sell", 18_000_000_000_000_000_000n));
  assert.equal(huge.code, "CANNOT_QUOTE"); assert.match(huge.message, /too large/);
});

test("RPC_UNAVAILABLE: a dead RPC is one fixed sentence, whatever its error says", async () => {
  resetCaches();
  const secret = "https://rpc.example/?api-key=TOPSECRET";
  const connection = {
    async getMultipleAccountsInfo() { throw new Error("failed to get info: fetch failed " + secret); },
    async getMultipleAccountsInfoAndContext() { throw new TypeError("fetch failed"); },
  };
  const seen = [];
  const original = console.error;
  console.error = (...a) => seen.push(a.join(" "));
  let e;
  try { e = await refused(quote(parseQuoteParams({ mint: key().toBase58(), side: "buy", amount: "1000" }), { connection, lookupTable: null })); } finally { console.error = original; }
  assert.equal(e.status, 502); assert.equal(e.code, "RPC_UNAVAILABLE"); assert.equal(e.message, "The Solana RPC did not answer. Try again.");
  assert.equal(seen.length, 1);
  assert.ok(!/TOPSECRET|api-key|rpc\.example/.test(seen[0]), "the server's own log line has no URL in it: " + seen[0]);
});

test("the coin's name comes from the chain: control characters are dropped, length is bounded", async () => {
  const w = world({ name: "Evil\u0007\nName" + "x".repeat(20), symbol: "S\u0000\u001fY" });
  const { body } = await ask(w, "buy", 100_000_000n);
  assert.equal(body.coin.symbol, "SY");
  assert.ok(!/[\x00-\x1f]/.test(body.coin.name) && body.coin.name.length <= 40);
  const bare = world({ noMetadata: true });
  assert.equal((await ask(bare, "buy", 100_000_000n)).body.coin.symbol, "", "a coin without metadata has an empty symbol");
});

// ---- the curve ---------------------------------------------------------------------------------------------
// A coin launched on the curve: its whole supply (1e15 raw units) in the pool, no real SOL at the opening, 30
// SOL of virtual SOL in the price, graduation at 85 SOL of real SOL. The arithmetic is written out again here
// from the specification (HOOKS.md section 2), not taken from the SDK.

const V = 30_000_000_000n; const TARGET = 85_000_000_000n; const SUPPLY = 1_000_000_000_000_000n;
/// A pool on the curve that walked along it without fees from its opening to `raised` lamports of real SOL.
const onCurve = (raised, o = {}) => ({ reserveQuote: raised, reserveBase: (V * SUPPLY) / (V + raised), virtualQuote: V, graduationTarget: TARGET, curveState: 1, ...o });
/// SOL for one whole coin of 6 decimals, as the API writes a price.
const price = (quote, base) => ratioDecimal(quote * 10n ** 6n, base * 10n ** 9n);
/// What `graduate` leaves of a pool: the fee taken out of the real reserve, the base reserve that keeps the price.
function graduatedAt(reserveBase, reserveQuote, feeBps = 0) {
  let fee = (TARGET * BigInt(feeBps)) / 10_000n;
  if (fee > reserveQuote - 1n) fee = reserveQuote - 1n;
  const quoteAfter = reserveQuote - fee;
  return { reserveQuote: quoteAfter, reserveBase: (quoteAfter * reserveBase) / (reserveQuote + V) };
}
const NO_CURVE = { state: "none", virtualQuote: "0", raised: "0", target: "0", raisedBps: 0, soldBps: 0, graduates: false, graduateFirst: false };
const OPEN_NOTE = "This coin trades on the curve. Its price counts 30 SOL of virtual SOL that the pool does not hold.";

test("curve: an open pool is quoted with its virtual SOL, priced with it, and says where it stands", async () => {
  const pool = onCurve(2_000_000_000n);
  const w = world({ pool });
  const first = await ask(w, "buy", 1_000_000_000n);
  const buy = first.body;
  const e = expected({ isBuy: true, amount: 1_000_000_000n, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote + V, protocolBps: 20, hookBps: 0, poolBps: 100 });
  assert.equal(buy.outAmount, e.out.toString(), "the constant product on 2 + 30 SOL");
  assert.equal(buy.minOutAmount, ((e.out * 9900n) / 10000n).toString());
  assert.equal(buy.priceBefore, price(pool.reserveQuote + V, pool.reserveBase), "the price counts the virtual SOL");
  assert.equal(buy.priceAfter, price(pool.reserveQuote + 1_000_000_000n - e.protocol + V, pool.reserveBase - e.out), "the real reserve after the trade, plus the virtual SOL");
  assert.deepEqual(buy.curve, { state: "open", virtualQuote: "30000000000", raised: "2000000000", target: "85000000000", raisedBps: 235, soldBps: 625, graduates: false, graduateFirst: false });
  assert.equal(buy.exact, true);
  assert.deepEqual(buy.notes, [OPEN_NOTE, "The pool holds 2 SOL of real SOL. It graduates at 85 SOL."]);
  assert.equal(first.rpcCalls, 2);
  assert.deepEqual(w.connection.calls, ["many:1", "fresh:4"], "the coin's mint and metadata ride in the same call as the platform and the pool");
  assert.equal((await ask(w, "buy", 1_000_000_000n)).rpcCalls, 1, "and in the one call of a pool the server knows");
  assert.equal(w.connection.calls[2], "fresh:3", "the mint of a pool on the curve is read in every answer, for its supply");
  // a sell is paid from the real SOL
  const { body: sell } = await ask(w, "sell", 10_000_000_000_000n);
  const s = expected({ isBuy: false, amount: 10_000_000_000_000n, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote + V, protocolBps: 20, hookBps: 0, poolBps: 100 });
  assert.equal(sell.outAmount, s.out.toString());
  assert.deepEqual(sell.notes, [OPEN_NOTE, "The pool holds 2 SOL of real SOL. It graduates at 85 SOL. A sell is paid from the real SOL only."]);
  // the share sold counts the supply as read with the pool: coins burned out of the pool's vault leave the supply
  const burned = world({ pool, supply: SUPPLY - 10_000_000_000_000n });
  assert.equal((await ask(burned, "buy", 1_000_000_000n)).body.curve.soldBps, Number(((SUPPLY - 10_000_000_000_000n - pool.reserveBase) * 10_000n) / (SUPPLY - 10_000_000_000_000n)));
  // a seeded pool carries the part too, with nothing in it
  assert.deepEqual((await ask(world(), "buy", 100_000_000n)).body.curve, NO_CURVE);
});

test("curve: the buy that crosses the target graduates the coin, quoted on the curve, with the usual floor", async () => {
  for (const feeBps of [0, 500]) {
    const pool = onCurve(80_000_000_000n, { graduationFeeBps: feeBps });
    const w = world({ pool });
    const amount = 10_000_000_000n;
    const { body } = await ask(w, "buy", amount);
    const e = expected({ isBuy: true, amount, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote + V, protocolBps: 20, hookBps: 0, poolBps: 100 });
    assert.equal(body.outAmount, e.out.toString());
    assert.equal(body.curve.graduates, true); assert.equal(body.curve.graduateFirst, false, "graduate comes after the swap");
    assert.equal("amountOutIfGraduated" in body.curve, false, "there is no second fill");
    assert.equal(body.minOutAmount, ((e.out * 9900n) / 10000n).toString(), "the caller's slippage on the quote, never lowered");
    assert.equal(body.exact, true);
    assert.equal(body.priceAfter, price(pool.reserveQuote + amount - e.protocol + V, pool.reserveBase - e.out), "the price after the trade, which graduation keeps");
    assert.equal(body.curve.raisedBps, 9411, "80 of 85 SOL raised before the trade");
    assert.deepEqual(body.notes.slice(2), [
      "This trade takes the pool to its graduation target, so the transaction ends with graduate.",
      "Graduation drops the virtual SOL and burns coins from the pool, so the price stays where it is. Liquidity opens after it.",
    ]);
  }
  // a large buy on a fresh pool: the usual floor too
  const big = (await ask(world({ pool: onCurve(500_000_000n) }), "buy", 90_000_000_000n)).body;
  assert.equal(big.curve.graduates, true);
  assert.equal(big.minOutAmount, ((BigInt(big.outAmount) * 9900n) / 10000n).toString());
  // a buy that stops short of the target: nothing about graduation
  const short = (await ask(world({ pool: onCurve(80_000_000_000n) }), "buy", 1_000_000_000n)).body;
  assert.equal(short.curve.graduates, false);
  assert.equal(short.minOutAmount, ((BigInt(short.outAmount) * 9900n) / 10000n).toString());
  assert.deepEqual(short.notes, [OPEN_NOTE, "The pool holds 80 SOL of real SOL. It graduates at 85 SOL."]);
});

const PAST_NOTES = [
  "The pool stands past its graduation target, so this transaction graduates it before the trade. The trade runs on the graduated pool, whoever graduates it first, and this quote is that pool's.",
  "Graduation drops the virtual SOL and burns coins from the pool, so the price stays where it is. Liquidity opens after it.",
];
test("curve: a trade on a pool past its target graduates it first and is quoted, exactly, on the graduated pool", async () => {
  for (const feeBps of [0, 500]) {
    const pool = onCurve(90_000_000_000n, { graduationFeeBps: feeBps });
    const w = world({ pool });
    const amount = 1_000_000_000n;
    const buy = (await ask(w, "buy", amount)).body;
    // the pool as graduate leaves it: no virtual SOL, fewer coins, the same price
    const g = graduatedAt(pool.reserveBase, pool.reserveQuote, feeBps);
    const e = expected({ isBuy: true, amount, ...g, protocolBps: 20, hookBps: 0, poolBps: 100 });
    const onTheCurve = expected({ isBuy: true, amount, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote + V, protocolBps: 20, hookBps: 0, poolBps: 100 });
    assert.ok(e.out < onTheCurve.out, feeBps + " bps: the graduated pool is shallower at the same price");
    assert.equal(buy.outAmount, e.out.toString(), "the quote is the graduated pool's");
    assert.equal(buy.exact, true, "whoever graduates the pool first, the trade runs on the graduated pool");
    assert.equal(buy.minOutAmount, ((e.out * 9900n) / 10000n).toString(), "the caller's slippage on that quote");
    assert.equal(buy.priceBefore, price(g.reserveQuote, g.reserveBase));
    assert.equal(buy.priceAfter, price(g.reserveQuote + amount - e.protocol, g.reserveBase - e.out));
    assert.deepEqual(buy.curve, { state: "open", virtualQuote: "30000000000", raised: pool.reserveQuote.toString(), target: "85000000000", raisedBps: 10000, soldBps: Number(((SUPPLY - pool.reserveBase) * 10_000n) / SUPPLY), graduates: true, graduateFirst: true });
    assert.deepEqual(buy.notes, [OPEN_NOTE, "The pool holds 90 SOL of real SOL. It graduates at 85 SOL.", ...PAST_NOTES]);
  }
  // a sell, even one large enough to take the pool back under its target: the pool graduates first, the
  // graduated pool pays it
  const pool = onCurve(90_000_000_000n);
  const w = world({ pool });
  const g = graduatedAt(pool.reserveBase, pool.reserveQuote);
  for (const amount of [1_000_000_000_000n, 30_000_000_000_000n]) {
    const sell = (await ask(w, "sell", amount)).body;
    const s = expected({ isBuy: false, amount, ...g, protocolBps: 20, hookBps: 0, poolBps: 100 });
    assert.equal(sell.curve.graduates, true); assert.equal(sell.curve.graduateFirst, true);
    assert.equal(sell.outAmount, s.out.toString());
    assert.equal(sell.minOutAmount, ((s.out * 9900n) / 10000n).toString());
    assert.equal(sell.exact, true);
    assert.deepEqual(sell.notes.slice(2), PAST_NOTES);
  }
  // exactly at the target counts as past it
  assert.equal((await ask(world({ pool: onCurve(TARGET) }), "buy", 1_000_000_000n)).body.notes[2], PAST_NOTES[0]);
});

test("curve: a graduated pool trades like a seeded one, and says it graduated", async () => {
  const open = onCurve(86_000_000_000n);
  const g = graduatedAt(open.reserveBase, open.reserveQuote);
  const supply = SUPPLY - (open.reserveBase - g.reserveBase);
  const w = world({ supply, pool: { ...g, virtualQuote: 0n, graduationTarget: 0n, graduationFeeBps: 0, curveState: 2 } });
  const { body } = await ask(w, "buy", 1_000_000_000n);
  assert.equal(body.outAmount, expected({ isBuy: true, amount: 1_000_000_000n, ...g, protocolBps: 20, hookBps: 0, poolBps: 100 }).out.toString());
  assert.equal(body.priceBefore, price(g.reserveQuote, g.reserveBase));
  assert.deepEqual(body.curve, { state: "graduated", virtualQuote: "0", raised: g.reserveQuote.toString(), target: "0", raisedBps: 10000, soldBps: Number(((supply - g.reserveBase) * 10_000n) / supply), graduates: false, graduateFirst: false });
  assert.equal(body.exact, true); assert.deepEqual(body.notes, []);
  // the price at graduation is the price before it, to the 9 digits the API shows
  assert.equal(price(g.reserveQuote, g.reserveBase), price(open.reserveQuote + V, open.reserveBase));
});

test("curve: a sell that would take more than the real SOL is refused with CURVE_REAL_RESERVE and the largest sell it pays", async () => {
  const pool = onCurve(500_000_000n);
  const w = world({ pool });
  const e = await refused(ask(w, "sell", 100_000_000_000_000n));
  assert.equal(e.status, 422); assert.equal(e.code, "CURVE_REAL_RESERVE");
  assert.equal(e.extra.realReserve, "500000000");
  const max = BigInt(e.extra.maxAmount);
  // by hand: the gross output of that sell fits in the real reserve, one unit more does not
  const gross = (amount) => { const p = ceilFee(amount, 20); const n = amount - p - ceilFee(amount - p, 100); return ((pool.reserveQuote + V) * n) / (pool.reserveBase + n); };
  assert.ok(max > 0n && gross(max) <= pool.reserveQuote && gross(max + 1n) > pool.reserveQuote, "the largest sell it pays: " + max);
  assert.equal((await ask(w, "sell", max)).body.outAmount, gross(max).toString());
  assert.equal(e.message, "This coin is on the curve. Its pool counts 30 SOL of virtual SOL in the price, but pays a sell from the real SOL it holds, 500000000 lamports. This sell would take more than that. The largest sell it pays now is " + max + " raw units of the coin.");
  assert.deepEqual(errorResponse(e).body.error, { code: "CURVE_REAL_RESERVE", message: e.message, realReserve: "500000000", maxAmount: max.toString() });
  // /swap refuses it before anything is built or any balance is looked at
  const s = await refused(swap(parseSwapParams({ mint: w.baseMint.toBase58(), side: "sell", amount: "100000000000000", userPublicKey: key().toBase58() }), w.deps));
  assert.equal(s.code, "CURVE_REAL_RESERVE");
  // a pool that opened and never traded pays no sell at all
  const fresh = await refused(ask(world({ pool: onCurve(0n) }), "sell", 1_000_000_000_000n));
  assert.equal(fresh.code, "CURVE_REAL_RESERVE"); assert.equal(fresh.extra.maxAmount, "0"); assert.match(fresh.message, /, 0 lamports\. This sell would take more than that\. It pays no sell now\.$/);
});

test("curve: on a custom hook that may take a buy fee, a buy graduates only when it reaches the target with the whole fee taken", async () => {
  // 84.5 SOL raised; a buy of 0.55 SOL brings 0.5489 SOL into the pool without a hook fee, 0.4940 SOL with 10%
  const pool = onCurve(84_500_000_000n);
  assert.equal((await ask(world({ pool }), "buy", 550_000_000n)).body.curve.graduates, true, "without a hook the buy reaches 85 SOL");
  const custom = world({ pool: { ...pool, hookProgram: key(), hookFlags: F.BEFORE_SWAP | F.TAKE_HOOK_FEE | F.CALL_ON_BUY, hookKind: 1 } });
  const b = (await ask(custom, "buy", 550_000_000n)).body;
  assert.equal(b.exact, false); assert.equal(b.curve.graduates, false);
  assert.equal(b.minOutAmount, ((BigInt(b.outAmount) * 9900n) / 10000n).toString());
  assert.equal((await ask(custom, "buy", 2_000_000_000n)).body.curve.graduates, true, "a buy that reaches it whatever the hook takes graduates");
  // a hook that only changes the pool fee: that fee stays in the real reserve, so the buy graduates
  const override = world({ pool: { ...pool, hookProgram: key(), hookFlags: F.BEFORE_SWAP | F.OVERRIDE_FEE | F.CALL_ON_BUY, hookKind: 1 } });
  assert.equal((await ask(override, "buy", 550_000_000n)).body.curve.graduates, true);
});

test("strict on the curve: the max wallet counts the coins the curve gives", async () => {
  const A = key();
  const pool = onCurve(1_000_000_000n);
  const w = strictWorld({}, { pool }, [{ address: A, lamports: 5_000_000_000n, balance: 0n, record: { balance: 0n } }]);
  const e = await refused(askAs(w, "buy", 2_000_000_000n, A));
  assert.equal(e.code, "MAX_WALLET_EXCEEDED");
  const most = (amount) => expected({ isBuy: true, amount, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote + V, protocolBps: 20, hookBps: 200, poolBps: 100 }).out;
  const max = BigInt(e.extra.maxAmount);
  assert.ok(most(max) <= CAP && most(max + 1n) > CAP, "the largest buy is sized on the curve's price: " + max);
  const ok = (await askAs(w, "buy", max, A)).body;
  assert.equal(ok.outAmount, most(max).toString()); assert.equal(ok.curve.state, "open");
});

test("swap: the buy that crosses the target ends with graduate, carries the quote's floor and asks for more compute", async () => {
  const w = world({ pool: onCurve(80_000_000_000n) });
  const user = key();
  w.accounts.set(user.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: 20_000_000_000, executable: false });
  const { body } = await swap(parseSwapParams({ mint: w.baseMint.toBase58(), side: "buy", amount: "10000000000", userPublicKey: user.toBase58() }), w.deps);
  assert.deepEqual(body.instructions, ["compute_unit_limit", "create_token_account", "create_token_account", "wrap_sol", "sync_wrapped_sol", "swap", "graduate", "unwrap_sol"]);
  assert.equal(body.computeUnitLimit, 250_000 + GRADUATE_COMPUTE_UNITS);
  assert.equal(body.quote.curve.graduates, true);
  assert.ok(body.notes.includes("The transaction sends graduate right after the swap. Its compute limit is 25000 units higher for it."));
  const tx = H.VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
  const ixs = H.TransactionMessage.decompile(tx.message).instructions;
  assert.equal(Buffer.from(ixs[0].data).readUInt32LE(1), 275_000);
  assert.equal(Buffer.from(ixs[5].data).readBigUInt64LE(17), BigInt(body.quote.minOutAmount), "the swap carries the quote's floor, as it is");
  assert.equal(BigInt(body.quote.minOutAmount), (BigInt(body.quote.outAmount) * 9900n) / 10000n, "under the target: the usual floor, not lowered by the SDK");
  // past the target: graduate goes FIRST, right in front of the swap, and the floor is the slippage on the quote
  const past = world({ pool: onCurve(90_000_000_000n) });
  past.accounts.set(user.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: 20_000_000_000, executable: false });
  const pb = (await swap(parseSwapParams({ mint: past.baseMint.toBase58(), side: "buy", amount: "1000000000", userPublicKey: user.toBase58() }), past.deps)).body;
  const pixs = H.TransactionMessage.decompile(H.VersionedTransaction.deserialize(Buffer.from(pb.transaction, "base64")).message).instructions;
  assert.deepEqual(pb.instructions, ["compute_unit_limit", "create_token_account", "create_token_account", "wrap_sol", "sync_wrapped_sol", "graduate", "swap", "unwrap_sol"]);
  assert.equal(pb.computeUnitLimit, 250_000 + GRADUATE_COMPUTE_UNITS);
  assert.ok(pb.notes.includes("The transaction sends graduate right before the swap. Its compute limit is 25000 units higher for it."));
  assert.equal(BigInt(pb.quote.minOutAmount), (BigInt(pb.quote.outAmount) * 9900n) / 10000n);
  assert.equal(Buffer.from(pixs[pb.instructions.indexOf("swap")].data).readBigUInt64LE(17), BigInt(pb.quote.minOutAmount), "the floor as the quote states it, lowered by nobody");
  assert.deepEqual([...pixs[pb.instructions.indexOf("graduate")].data], [...H.IX.hookpool.graduate]);
  // the graduate of the crossing buy, right after its swap: this pool's, no signer
  const decoded = H.decodePool(w.pool, new Uint8Array(w.accounts.get(w.pool.toBase58()).data));
  const grad = ixs[6];
  assert.deepEqual([...grad.data], [...H.IX.hookpool.graduate]);
  assert.deepEqual(grad.keys.map((m) => m.pubkey.toBase58()), [H.pda.platform(), w.pool, w.baseMint, decoded.baseVault, H.TOKEN_PROGRAM, H.pda.eventAuthority(H.PROGRAMS.hookpool), H.PROGRAMS.hookpool].map((k) => k.toBase58()));
  assert.ok(grad.keys.every((m) => !m.isSigner) && tx.message.header.numRequiredSignatures === 1);
  // a caller's own floor goes in as it was sent
  const own = BigInt(body.quote.minOutAmount) + 7n;
  const mine = (await swap(parseSwapParams({ mint: w.baseMint.toBase58(), side: "buy", amount: "10000000000", userPublicKey: user.toBase58(), minOutAmount: own.toString() }), w.deps)).body;
  assert.equal(Buffer.from(H.TransactionMessage.decompile(H.VersionedTransaction.deserialize(Buffer.from(mine.transaction, "base64")).message).instructions[5].data).readBigUInt64LE(17), own);
  // a buy that stays under the target: no graduate, the usual limit
  const under = (await swap(parseSwapParams({ mint: w.baseMint.toBase58(), side: "buy", amount: "1000000000", userPublicKey: user.toBase58() }), w.deps)).body;
  assert.ok(!under.instructions.includes("graduate")); assert.equal(under.computeUnitLimit, 250_000);
  // the allow-list takes graduate of this pool only where the API decided it
  const client = new H.HookpoolClient(w.connection);
  const t = { user, recipient: null, pool: decoded, userWsol: H.pda.ata(user, H.NATIVE_MINT), amount: 1n, minOut: 1n, direction: H.DIRECTION.BUY, isBuy: true, collectible: false, graduate: true };
  assert.equal(instructionKind(H.ix.graduate(client.keys(decoded)), t), "graduate");
  assert.equal(instructionKind(H.ix.graduate(client.keys(decoded)), { ...t, graduate: false }), null, "not on a trade that does not graduate");
  const other = world({ pool: onCurve(90_000_000_000n) });
  const otherPool = H.decodePool(other.pool, new Uint8Array(other.accounts.get(other.pool.toBase58()).data));
  assert.equal(instructionKind(H.ix.graduate(client.keys(otherPool)), t), null, "not another pool's");
  const signed = H.ix.graduate(client.keys(decoded)); signed.keys[1] = { ...signed.keys[1], isSigner: true };
  assert.equal(instructionKind(signed, t), null, "never with a signer");
});

test("swap: a priority fee is counted in what the wallet must hold, the compute of a graduate included", async () => {
  const w = world();
  const C = key();
  const base = 50_000_000n + 5000n + 2_039_280n + 2_039_280n;
  w.accounts.set(C.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: Number(base + 250_000n - 1n), executable: false });
  const body = { mint: w.baseMint.toBase58(), side: "buy", amount: "50000000", userPublicKey: C.toBase58(), computeUnitPriceMicroLamports: 1_000_000 };
  const e = await refused(swap(parseSwapParams(body), w.deps));
  assert.equal(e.code, "INSUFFICIENT_FUNDS");
  assert.equal(e.message, "The wallet holds " + (base + 249_999n) + " lamports. This buy needs " + (base + 250_000n) + ": 50000000 for the buy, 5000 for the network fee, 2039280 for the rent of its token account for this coin, 2039280 for the rent of a wrapped SOL account, which comes back at the end of the transaction, 250000 for the priority fee of 250000 compute units at 1000000 micro-lamports.");
  w.accounts.set(C.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: Number(base + 250_000n), executable: false });
  assert.equal((await swap(parseSwapParams(body), w.deps)).body.computeUnitPriceMicroLamports, 1_000_000);
  // on the curve, the buy that graduates pays for 275000 units
  const c = world({ pool: onCurve(80_000_000_000n) });
  c.accounts.set(C.toBase58(), { owner: H.SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: Number(10_000_000_000n + 5000n + 2_039_280n + 2_039_280n + 250_000n), executable: false });
  const g = await refused(swap(parseSwapParams({ ...body, mint: c.baseMint.toBase58(), amount: "10000000000" }), c.deps));
  assert.match(g.message, /, 275000 for the priority fee of 275000 compute units at 1000000 micro-lamports\.$/);
});

// ---- HTTP: what needs no chain ---------------------------------------------------------------------------

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: "", headersSent: false };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = String(v); };
  res.end = (b) => { res.body = b || ""; res.headersSent = true; };
  return res;
}
const fakeReq = (method, url, extra = {}) => ({ method, url, headers: {}, socket: { remoteAddress: "198.51.100.7" }, ...extra });

test("http: preflight, unknown route, wrong method", async () => {
  const opt = fakeRes();
  await handleRequest(fakeReq("OPTIONS", "/api/v1/swap"), opt, "swap");
  assert.equal(opt.statusCode, 204); assert.equal(opt.body, "");
  assert.equal(opt.headers["access-control-allow-origin"], "*");
  assert.equal(opt.headers["access-control-allow-methods"], "POST, OPTIONS");
  assert.equal(opt.headers["access-control-allow-headers"], "Content-Type");

  const nf = fakeRes();
  await handleRequest(fakeReq("GET", "/api/v1/orders"), nf, "orders");
  assert.equal(nf.statusCode, 404);
  assert.deepEqual(JSON.parse(nf.body), { error: { code: "NOT_FOUND", message: "No such endpoint. Use GET /api/v1/quote or POST /api/v1/swap." } });
  assert.equal(nf.headers["access-control-allow-origin"], "*"); assert.equal(nf.headers["cache-control"], "no-store");

  const wrong = fakeRes();
  await handleRequest(fakeReq("DELETE", "/api/v1/quote"), wrong, "quote");
  assert.equal(wrong.statusCode, 405); assert.equal(JSON.parse(wrong.body).error.code, "METHOD_NOT_ALLOWED"); assert.equal(wrong.headers.allow, "GET, OPTIONS");

  const bad = fakeRes();
  await handleRequest(fakeReq("GET", "/api/v1/quote?side=buy"), bad, "quote");
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(JSON.parse(bad.body), { error: { code: "INVALID_PARAMETER", message: "Send mint or pool. One of them, not both.", parameter: "mint" } });
  assert.ok(Number(bad.headers["x-ratelimit-remaining"]) >= 0);
});

test("http: the body, read from the stream or left by the platform, never above the limit", async () => {
  const stream = (text, headers = {}) => Object.assign(Readable.from([Buffer.from(text)]), { headers });
  assert.deepEqual(await readJson(stream('{"a":1}')), { a: 1 });
  assert.equal((await refused(readJson(stream("nope")))).code, "INVALID_JSON");
  assert.equal((await refused(readJson(stream("")))).code, "INVALID_JSON");
  const big = await refused(readJson(stream("x".repeat(5000))));
  assert.equal(big.status, 413); assert.equal(big.code, "BODY_TOO_LARGE");
  assert.equal((await refused(readJson(stream("{}", { "content-length": "999999" })))).code, "BODY_TOO_LARGE", "refused on the header alone");

  // a platform that parsed the body itself
  const done = (body) => ({ headers: {}, readableEnded: true, body });
  assert.deepEqual(await readJson(done({ a: 1 })), { a: 1 });
  assert.deepEqual(await readJson(done('{"a":2}')), { a: 2 });
  assert.deepEqual(await readJson(done(Buffer.from('{"a":3}'))), { a: 3 });
  for (const b of [undefined, null, 5, [1], "nope"]) assert.equal((await refused(readJson(done(b)))).code, "INVALID_JSON");
  assert.equal((await refused(readJson(done("x".repeat(5000))))).code, "BODY_TOO_LARGE");
  const throwing = { headers: {}, readableEnded: true, get body() { throw new Error("Invalid JSON"); } };
  assert.equal((await refused(readJson(throwing))).code, "INVALID_JSON");
});
