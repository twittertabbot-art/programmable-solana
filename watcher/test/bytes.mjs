// Raw account bytes for the diff tests, built the way the programs lay them out (8-byte discriminator + borsh).
import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_DISC, EVENT_DISC } from "../../sdk/dist/index.js";

export const POOL = new PublicKey("4FokBjExHqcr1a7u7VCAjKEjrfLArWij2HJSg3eRXKm2");
export const OWNER = new PublicKey("ALjPBZ7pzjTRmLddcExo8e7Edk3yvVGsrjHsu1u5dhkZ");
export const OTHER = new PublicKey("9cDfF7wD6EirDZbb5DWCw3HZ3ZPQ1oeh87YyMGvbPRxi");
export const SYSTEM = new PublicKey("11111111111111111111111111111111");

class W {
  constructor() { this.parts = []; }
  u8(v) { this.parts.push(Uint8Array.of(v & 0xff)); return this; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.parts.push(b); return this; }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.parts.push(b); return this; }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.parts.push(b); return this; }
  pubkey(k) { this.parts.push(k.toBytes()); return this; }
  zeros(n) { this.parts.push(new Uint8Array(n)); return this; }
  fixed(s, n) { const b = new Uint8Array(n); b.set(new TextEncoder().encode(s).subarray(0, n)); this.parts.push(b); return this; }
  disc(name) { this.parts.push(Uint8Array.from(ACCOUNT_DISC[name])); return this; }
  evt(name) { this.parts.push(Uint8Array.from(EVENT_DISC[name])); return this; }
  out() { const len = this.parts.reduce((n, p) => n + p.length, 0); const o = new Uint8Array(len); let i = 0; for (const p of this.parts) { o.set(p, i); i += p.length; } return o; }
}

export function taxConfig({ buyBps = 300, sellBps = 500, maxBps = 1000, owner = OWNER, pool = POOL } = {}) {
  return new W().disc("TaxConfig").u8(255).pubkey(pool).pubkey(owner).u16(buyBps).u16(sellBps).u16(maxBps).zeros(32).out();
}
export function guardConfig({ startSlot = 0n, guardSlots = 300n, startFeeBps = 3000, pool = POOL } = {}) {
  return new W().disc("GuardConfig").u8(255).pubkey(pool).u64(startSlot).u64(guardSlots).u16(startFeeBps).zeros(32).out();
}
// BuybackConfig, 230 bytes. After the counters come the creator (offset 174) and the observation of the pool
// that a buyback buys against: the slot it was taken in (206) and the two reserves (214, 222). An observation
// with a zero reserve means "none yet".
export function buybackConfig({ buyBps = 200, sellBps = 200, minQuote = 50_000_000n, treasury = OTHER, totalQuoteSpent = 0n, totalBaseBurned = 0n, buybacks = 0n, pool = POOL, creator = OWNER, obsSlot = 0n, obsReserveBase = 0n, obsReserveQuote = 0n } = {}) {
  return new W().disc("BuybackConfig").u8(255).u8(254).pubkey(pool).pubkey(OTHER).pubkey(SYSTEM).pubkey(treasury)
    .u16(buyBps).u16(sellBps).u64(minQuote).u64(totalQuoteSpent).u64(totalBaseBurned).u64(buybacks).pubkey(creator)
    .u64(obsSlot).u64(obsReserveBase).u64(obsReserveQuote).out();
}
// RulesConfig, 414 bytes, as RULES.md lays it out. Bytes 8 to 239 are fixed once the pool exists: two bumps,
// five addresses, the rules, and the three numbers the pool's creation wrote (start slot, start time, the
// stake the holders' share needs). What follows are running numbers: fees seen, the rates of the last trade,
// what is owed, the burn pot, the reward accumulator, what is staked, the counters, the burn's observation.
W.prototype.i64 = function (v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); this.parts.push(b); return this; };
W.prototype.u128 = function (v) { const n = BigInt(v); return this.u64(n & 0xffffffffffffffffn).u64(n >> 64n); };
W.prototype.rates = function (r = {}) { return this.u16(r.creatorBps ?? 0).u16(r.holdersBps ?? 0).u16(r.burnBps ?? 0); };
export function rulesConfig({
  pool = POOL, baseMint = OTHER, quoteMint = SYSTEM, treasury = OTHER, creator = OWNER, bump = 255, authorityBump = 254,
  sniperSlots = 0n, sniperStartFeeBps = 0, buy = { creatorBps: 50, holdersBps: 100, burnBps: 50 }, sell = { creatorBps: 100, holdersBps: 200, burnBps: 100 },
  maxBuyQuote = 0n, limitSlots = 0n, creatorLockSeconds = 0n, startSlot = 1000n, startTime = 1_760_000_000n, minEligible = 1_000_000_000_000n,
  feesSeen = 0n, lastSplit = {}, creatorOwed = 0n, burnPot = 0n, accPerShare = 0n, rewardRem = 0n, totalStaked = 0n, rewardsOwedTotal = 0n,
  totalCreatorPaid = 0n, totalRewardsPaid = 0n, totalQuoteBurned = 0n, totalBaseBurned = 0n, burns = 0n, obsSlot = 0n, obsReserveBase = 0n, obsReserveQuote = 0n,
  // the strict part (offsets 374 to 413): zero on a plain coin
  kind = 0, buyMark = 0, vaultBump = 0, maxWalletBps = 0, earlySlots = 0, maxWalletSlots = 0, earlyUnlockSlots = 0, maxWalletAmount = 0n,
} = {}) {
  return new W().disc("RulesConfig").u8(bump).u8(authorityBump).pubkey(pool).pubkey(baseMint).pubkey(quoteMint).pubkey(treasury).pubkey(creator)
    .u64(sniperSlots).u16(sniperStartFeeBps).rates(buy).rates(sell).u64(maxBuyQuote).u64(limitSlots).u64(creatorLockSeconds)
    .u64(startSlot).i64(startTime).u64(minEligible)
    .u64(feesSeen).rates(lastSplit).u64(creatorOwed).u64(burnPot).u128(accPerShare).u64(rewardRem).u64(totalStaked).u64(rewardsOwedTotal)
    .u64(totalCreatorPaid).u64(totalRewardsPaid).u64(totalQuoteBurned).u64(totalBaseBurned).u64(burns).u64(obsSlot).u64(obsReserveBase).u64(obsReserveQuote)
    .u8(kind).u8(buyMark).u8(vaultBump).u16(maxWalletBps).u16(earlySlots).u32(maxWalletSlots).u32(earlyUnlockSlots).u64(maxWalletAmount).zeros(17).out();
}
// A strict coin's config: kind 1 and its strict numbers. The max wallet in raw units is written at pool creation.
export const strictConfig = (o = {}) => rulesConfig({ kind: 1, vaultBump: 251, maxWalletBps: 300, earlySlots: 80, maxWalletSlots: 330, earlyUnlockSlots: 200, maxWalletAmount: 30_000_000_000_000n, ...o });
// HolderRecord, 129 bytes: the wallet's balance as last counted, the reward snapshot, what is owed, its early coins
// and the creator lock.
export function holderRecordBytes({ pool = POOL, owner = OWNER, balance = 0n, accSnapshot = 0n, owed = 0n, earlyBought = 0n, locked = 0n, lockedUntil = 0n } = {}) {
  return new W().disc("HolderRecord").u8(254).pubkey(pool).pubkey(owner).u64(balance).u128(accSnapshot).u64(owed).u64(earlyBought).u64(locked).i64(lockedUntil).out();
}
// A pool account as the pool program lays it out, as far as the watcher reads it: the mints, the vaults, the
// fee, the hook (program, flags, extra-accounts list, treasury, kind), the reserves, the counters (the hook
// fees paid so far among them), the slot of its creation, its creator, and the hook fees that wait for a
// missing treasury. The tail (offsets 504 to 527) is the curve: the virtual quote, the graduation target, the
// graduation fee, the state (0 seeded, 1 open, 2 graduated) and a reserve of zeros. All zero on a seeded pool.
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export function poolBytes({ baseMint = BASE_MINT, quoteMint = WSOL, baseTokenProgram = TOKEN_PROGRAM, hookProgram = SYSTEM, hookFlags = 0, hookKind = 0, hookQuoteTreasury = SYSTEM, extraMetas = SYSTEM, lpFeeBps = 100, reserveBase = 1_000_000_000_000_000n, reserveQuote = 100_000_000_000n, hookFeesQuoteTotal = 0n, hookFeesOwedQuote = 0n, createdSlot = 100n, creator = OWNER, virtualQuote = 0n, graduationTarget = 0n, graduationFeeBps = 0, curveState = 0 } = {}) {
  return new W().disc("Pool").u8(254).pubkey(baseMint).pubkey(quoteMint).pubkey(OTHER).pubkey(OTHER).pubkey(OTHER).pubkey(OTHER).pubkey(baseTokenProgram).pubkey(TOKEN_PROGRAM)
    .u16(lpFeeBps).pubkey(hookProgram).u32(hookFlags).pubkey(extraMetas).pubkey(hookQuoteTreasury).u8(hookKind)
    .u64(reserveBase).u64(reserveQuote).u64(0).u64(0).u64(hookFeesQuoteTotal).u64(0).u64(3).u64(createdSlot).pubkey(creator).u64(hookFeesOwedQuote).pubkey(OWNER)
    .u64(virtualQuote).u64(graduationTarget).u16(graduationFeeBps).u8(curveState).zeros(5).out();
}
// The platform account: admin, pending admin, treasury, the four fee numbers, the launch fee, the paused
// flag, a whitelist of eight places (none used here), the pool count. With `curve`, the tail of the account too:
// the virtual quote, the graduation target and the graduation fee a new curve pool copies, then 46 zeros.
export function platformBytes({ protocolFeeBps = 20, maxLpFeeBps = 1000, maxHookFeeBps = 1000, maxFeeOverrideBps = 5000, paused = false, curve = null } = {}) {
  const w = new W().disc("Platform").u8(255).pubkey(OWNER).pubkey(SYSTEM).pubkey(OWNER).u16(protocolFeeBps).u16(maxLpFeeBps).u16(maxHookFeeBps).u16(maxFeeOverrideBps)
    .u64(10_000_000n).u8(paused ? 1 : 0).u8(0).zeros(8 * 32).u64(1);
  if (curve) w.u64(curve.virtualQuote).u64(curve.graduationTarget).u16(curve.graduationFeeBps ?? 0).zeros(46);
  return w.out();
}
// The event of a graduation, as the pool program emits it through event CPI: the pool, the real quote reserve and
// the base reserve before and after, the coins burned, the fee taken for the platform, the slot.
export function graduatedEventBytes({ pool = POOL, reserveQuoteBefore = 0n, reserveQuoteAfter = 0n, reserveBaseBefore = 0n, reserveBaseAfter = 0n, burnedBase = 0n, feeQuote = 0n, slot = 0n } = {}) {
  return new W().evt("Graduated").pubkey(pool).u64(reserveQuoteBefore).u64(reserveQuoteAfter).u64(reserveBaseBefore).u64(reserveBaseAfter).u64(burnedBase).u64(feeQuote).u64(slot).out();
}
// The event of a swap, as the pool program emits it: the pool, the trader, the direction (0 buy, 1 sell), what went
// in and out, the three fees, the fee applied in bps, the real reserves after it, the slot, and whether a hook sent it.
export function swappedEventBytes({ pool = POOL, user = OWNER, direction = 0, amountIn = 1000n, amountOut = 900n, protocolFee = 2n, hookFee = 0n, lpFee = 10n, feeBpsApplied = 100, reserveBase = 1_000_000n, reserveQuote = 5_000n, slot = 0n, byHook = false } = {}) {
  return new W().evt("Swapped").pubkey(pool).pubkey(user).u8(direction).u64(amountIn).u64(amountOut).u64(protocolFee).u64(hookFee).u64(lpFee).u16(feeBpsApplied)
    .u64(reserveBase).u64(reserveQuote).u64(slot).u8(byHook ? 1 : 0).out();
}
// The event of a pool opened on the curve: the pool, the virtual quote, the graduation target and fee, the slot.
export function curveOpenedEventBytes({ pool = POOL, virtualQuote = 30_000_000_000n, graduationTarget = 85_000_000_000n, graduationFeeBps = 0, slot = 0n } = {}) {
  return new W().evt("CurveOpened").pubkey(pool).u64(virtualQuote).u64(graduationTarget).u16(graduationFeeBps).u64(slot).out();
}
// The event of a pool's creation.
export function poolCreatedEventBytes({ pool = POOL, baseMint = BASE_MINT, quoteMint = WSOL, creator = OWNER, hookProgram = SYSTEM, hookFlags = 0, hookKind = 0, lpFeeBps = 100, baseAmount = 1n, quoteAmount = 0n, lpMinted = 0n, slot = 0n } = {}) {
  return new W().evt("PoolCreated").pubkey(pool).pubkey(baseMint).pubkey(quoteMint).pubkey(creator).pubkey(hookProgram).u32(hookFlags).u8(hookKind).u16(lpFeeBps)
    .u64(baseAmount).u64(quoteAmount).u64(lpMinted).u64(slot).out();
}
// A change of liquidity: an event of the pool that the trades feed does not keep.
export function liquidityChangedEventBytes({ pool = POOL, user = OWNER, added = true, slot = 0n } = {}) {
  return new W().evt("LiquidityChanged").pubkey(pool).pubkey(user).u8(added ? 1 : 0).u64(1n).u64(1n).u64(1n).u64(1n).u64(1n).u64(slot).out();
}

// The Clock sysvar, 40 bytes: the slot first, the Unix time at offset 32.
export function clockBytes({ slot = 0n, unixTime = 1_760_000_000n } = {}) {
  return new W().u64(slot).zeros(24).i64(unixTime).out();
}
// The event of a buyback or a burn, as the two programs emit it through event CPI: the pool, what was spent
// and burned, the slot, the outcome (1 observed, 2 waited, 3 bought) and the observation the call left.
export function burnEventBytes({ name = "BurnExecuted", pool = POOL, quoteSpent = 0n, baseBurned = 0n, slot = 0n, outcome = 1, obsReserveBase = 0n, obsReserveQuote = 0n } = {}) {
  return new W().evt(name).pubkey(pool).u64(quoteSpent).u64(baseBurned).u64(slot).u8(outcome).u64(obsReserveBase).u64(obsReserveQuote).out();
}
export function manifest({ flags = 12865, admin = null, name = "Programmable tax", uri = "https://programmable.market/hooks/hook_tax" } = {}) {
  const w = new W().disc("HookManifest").u8(1).u32(flags);
  if (admin) w.u8(1).pubkey(admin); else w.u8(0);
  return w.fixed(name, 32).fixed(uri, 128).out();
}

// The collectible template's per-pool config. Strings are borsh (u32 length + bytes); the account on chain is
// padded to its maximum size, which the trailing zeros stand for. The layout with the peg: the coin that backs
// the pieces (baseMint, tokenProgram) follows the collection, then `pegged` (one byte: the coin is a Token-2022
// coin whose transfer hook is the collectible program), and `live` (pieces that exist now) follows `minted`.
W.prototype.str = function (s) { const b = new TextEncoder().encode(s); this.u32(b.length); this.parts.push(b); return this; };
export const ART_A = Uint8Array.from([1, 20, 235, 30, 24, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
export const ART_B = Uint8Array.from([1, 140, 100, 200, 30, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
export const BASE_MINT = new PublicKey("6W1y22CY35YAFoFK9pYe8TwEDxxfmnakhJFq2aeGA977");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export function collectionConfig({ owner = OWNER, unit = 50_000_000_000_000n, maxSupply = 1000, minted = 0, live = minted, reservedPending = 0, maxPerBuy = 3, artVersion = 0, art = ART_A, name = "Shots", uriBase = "https://example.com/art", pool = POOL, collection = OTHER, baseMint = BASE_MINT, tokenProgram = TOKEN_PROGRAM, pegged = false } = {}) {
  const w = new W().disc("CollectionConfig").u8(255).u8(254).u8(253).pubkey(pool).pubkey(OWNER).pubkey(owner).pubkey(collection)
    .pubkey(baseMint).pubkey(tokenProgram).u8(pegged ? 1 : 0)
    .u64(unit).u32(maxSupply).u32(minted).u32(live).u32(reservedPending).u8(maxPerBuy).u16(artVersion);
  w.parts.push(Uint8Array.from(art));
  return w.str(name).str(uriBase).zeros(40).out();
}

// A collectible ticket: 8 disc, bump u8, pool 32, user 32, minted u32, rolls u32, staged u8, stagedSlot u64
// (pegged coins: pieces staged to travel with the wallet's next transfer, and the slot the stage holds for),
// then 4 batches of (state u8, pieces u8, mintedFrom u8, firstRoll u32, targetSlot u64, seed 32, art 16), then `owned`:
// the pieces the wallet holds, in its own order, as a borsh vector (u32 count + 32 bytes each).
export const BATCH_EMPTY = 0; export const BATCH_WAITING = 1; export const BATCH_REVEALED = 2; export const BATCH_EXPIRED = 3;
export function ticketBytes({ pool = POOL, user = OWNER, minted = 0, rolls = 0, staged = 0, stagedSlot = 0n, batches = [], owned = [] } = {}) {
  const w = new W().disc("Ticket").u8(255).pubkey(pool).pubkey(user).u32(minted).u32(rolls).u8(staged).u64(stagedSlot);
  for (let i = 0; i < 4; i++) {
    const b = batches[i] ?? {};
    w.u8(b.state ?? BATCH_EMPTY).u8(b.pieces ?? 0).u8(b.mintedFrom ?? 0).u32(b.firstRoll ?? 0).u64(b.targetSlot ?? 0n);
    w.parts.push(b.seed ? Uint8Array.from(b.seed) : new Uint8Array(32));
    w.parts.push(b.art ? Uint8Array.from(b.art) : new Uint8Array(16));
  }
  w.u32(owned.length);
  for (const k of owned) w.pubkey(k);
  return w.out();
}

// An SPL token account, as far as the peg reads it: mint 32, owner 32, amount u64, then the rest (165 bytes).
export function tokenAccountBytes({ mint = BASE_MINT, owner = OWNER, amount = 0n } = {}) {
  return new W().pubkey(mint).pubkey(owner).u64(amount).zeros(93).out();
}

// A Token-2022 token account of a pegged coin, 175 bytes as its associated token account is created: the same
// 165 bytes (state byte 108 = initialized), the account type (2 = token account) at byte 165, the immutable
// owner extension (7, empty), then the transfer hook's own extension (15: one byte, the "transferring" flag,
// off outside a transfer).
export function tokenAccount2022Bytes({ mint = BASE_MINT, owner = OWNER, amount = 0n } = {}) {
  const base = tokenAccountBytes({ mint, owner, amount });
  base[108] = 1;
  const w = new W();
  w.parts.push(base);
  return w.u8(2).u16(7).u16(0).u16(15).u16(1).u8(0).out();
}

// The two events a settle logs, as the program emits them: 8 byte discriminator, then the fields.
export function pieceBurnedLog({ pool = POOL, user = OWNER, asset = OTHER, by = OWNER } = {}) {
  return `Program data: ${Buffer.from(new W().evt("PieceBurned").pubkey(pool).pubkey(user).pubkey(asset).pubkey(by).out()).toString("base64")}`;
}
export function piecesCancelledLog({ pool = POOL, user = OWNER, pieces = 1 } = {}) {
  return `Program data: ${Buffer.from(new W().evt("PiecesCancelled").pubkey(pool).pubkey(user).u32(pieces).out()).toString("base64")}`;
}

// ---- the pegged coin ----------------------------------------------------------------------------------

export const HOOK_COLLECTIBLE = new PublicKey("3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m");
export const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const ZERO_KEY = new PublicKey(new Uint8Array(32));

// A classic SPL Token mint: 82 bytes. Mint authority (u32 tag + key), supply, decimals, initialized, freeze
// authority (u32 tag + key). Both authorities are none, as on a launched coin.
export function splMintBytes({ supply = 1_000_000_000_000_000n, decimals = 6 } = {}) {
  return new W().u32(0).zeros(32).u64(supply).u8(decimals).u8(1).u32(0).zeros(32).out();
}

// A Token-2022 mint with extensions: the same 82 bytes, zeros up to byte 165, the account type (1 = mint) at
// byte 165, then one entry per extension: type u16, length u16, value.
//   transferHook  { program, authority }: extension 14, authority 32 then program 32, all zeros standing for none
//   metadata      { name, symbol, uri, updateAuthority }: extension 19, the name the coin carries in itself.
//                 The metadata pointer (extension 18) goes in front of it, as on a launched pegged coin.
// With neither, the mint is a plain Token-2022 mint of 82 bytes.
export function mint2022Bytes({ supply = 1_000_000_000_000_000n, decimals = 6, transferHook = null, metadata = null, mint = BASE_MINT } = {}) {
  const base = splMintBytes({ supply, decimals });
  if (!transferHook && !metadata) return base;
  const w = new W();
  w.parts.push(base);
  w.zeros(165 - base.length).u8(1);
  const ext = (type, value) => { w.u16(type).u16(value.length); w.parts.push(value); };
  if (metadata) ext(18, new W().pubkey(ZERO_KEY).pubkey(mint).out());
  if (transferHook) ext(14, new W().pubkey(transferHook.authority ?? ZERO_KEY).pubkey(transferHook.program ?? ZERO_KEY).out());
  if (metadata) ext(19, new W().pubkey(metadata.updateAuthority ?? ZERO_KEY).pubkey(mint).str(metadata.name).str(metadata.symbol).str(metadata.uri).u32(0).out());
  return w.out();
}

// A Metaplex Token Metadata account, as far as the watcher reads it: key, update authority, mint, name, symbol,
// uri, seller fee, no creators, primary sale flag, mutable flag.
export function metaplexMetadataBytes({ mint = BASE_MINT, name = "Programmable", symbol = "SHOT", uri = "https://example.com/meta/shot.json", updateAuthority = OWNER } = {}) {
  return new W().u8(4).pubkey(updateAuthority).pubkey(mint).str(name).str(symbol).str(uri).u16(0).u8(0).u8(0).u8(0).out();
}

// A Metaplex Core asset (BaseAssetV1): key 1, owner, update authority (2 = the collection), name, uri.
export function coreAssetBytes({ owner = OWNER, collection = OTHER, name = "Shots #1", uri = "https://example.com/art/p/00/11" } = {}) {
  return new W().u8(1).pubkey(owner).u8(2).pubkey(collection).str(name).str(uri).u8(0).out();
}
// What Core leaves of a burned asset: one byte, zero.
export const BURNED_ASSET = Uint8Array.of(0);

// The burn queue of a pegged pool: 8 disc, pool 32, count u32, then the queued asset addresses, 32 bytes each.
export function burnQueueBytes({ pool = POOL, assets = [] } = {}) {
  const w = new W().disc("BurnQueue").pubkey(pool).u32(assets.length);
  for (const k of assets) w.pubkey(k);
  return w.out();
}

// A hook's extra-accounts list for its pool callbacks: the TLV discriminator, the length, a count, then one
// 35 byte entry per account. Only fixed addresses here (entry type 0).
export function extraMetasBytes(entries = []) {
  const body = new W().u32(entries.length);
  for (const e of entries) body.u8(0).pubkey(e.pubkey).u8(0).u8(e.isWritable ? 1 : 0);
  const value = body.out();
  const w = new W();
  w.parts.push(Uint8Array.from([60, 167, 17, 250, 28, 149, 188, 66]));
  w.u32(value.length);
  w.parts.push(value);
  return w.out();
}
