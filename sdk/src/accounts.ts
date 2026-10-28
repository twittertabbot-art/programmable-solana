// Decoders for every account the site and the watcher read. Layouts mirror the Rust structs.
import { PublicKey } from "@solana/web3.js";
import { Reader, discriminatorMatches } from "./borsh.js";
import { ACCOUNT_DISC } from "./generated.js";
import { FLAGS, LAUNCH_KIND_CURVE, SYSTEM_PROGRAM } from "./constants.js";
import { decodeApprovedList } from "./approvals.js";

export interface Platform {
  bump: number; admin: PublicKey; pendingAdmin: PublicKey; treasury: PublicKey;
  protocolFeeBps: number; maxLpFeeBps: number; maxHookFeeBps: number; maxFeeOverrideBps: number;
  launchFeeLamports: bigint; paused: boolean; whitelist: PublicKey[]; poolCount: bigint;
  /// The curve settings a new curve pool copies at creation (bytes 387, 395, 403). Virtual
  /// SOL counted in the price, the real SOL at which `graduate` is allowed, and the share of
  /// the target the platform takes at graduation. A zero virtual or target switches curve
  /// launches off (`CurveDisabled`).
  curveVirtualQuote: bigint; curveGraduationTarget: bigint; curveGraduationFeeBps: number;
  /// `curveVirtualQuote > 0 && curveGraduationTarget > 0`: a curve launch is possible.
  curveEnabled: boolean;
  /// The approved-list rule (byte 405, HOOKS.md section 6.1): while true, a hook that is not
  /// the platform's own opens a pool only when its program is in `approvedHooks`.
  hookApprovalRequired: boolean;
  /// The approved list kept after the account's fixed part (empty when there is none).
  approvedHooks: PublicKey[];
  /// A list the account cannot hold: the program then refuses every pool that needs it.
  approvedListCorrupt: boolean;
}

export interface Pool {
  address: PublicKey;
  bump: number; baseMint: PublicKey; quoteMint: PublicKey; baseVault: PublicKey; quoteVault: PublicKey;
  lpMint: PublicKey; lpLock: PublicKey; baseTokenProgram: PublicKey; quoteTokenProgram: PublicKey;
  lpFeeBps: number; hookProgram: PublicKey; hookFlags: number; hookExtraMetas: PublicKey;
  hookQuoteTreasury: PublicKey; hookKind: number; reserveBase: bigint; reserveQuote: bigint;
  protocolFeesBase: bigint; protocolFeesQuote: bigint; hookFeesQuoteTotal: bigint; volumeQuoteTotal: bigint;
  swapCount: bigint; createdSlot: bigint; creator: PublicKey;
  /// Hook fees charged while the treasury account did not exist. They wait in the quote
  /// vault and are paid by the next swap that finds the treasury, or by `collectHookFees`.
  hookFeesOwedQuote: bigint;
  /// The wallet whose associated token account the hook treasury is.
  hookTreasuryOwner: PublicKey;
  hasHook: boolean;
  /// The curve (bytes 504 to 522). `virtualQuote` is counted in the price while the pool is
  /// on the curve and is 0 on a seeded pool and after graduation; `graduationTarget` is the
  /// real quote reserve at which `graduate` is allowed (0 when not on the curve);
  /// `graduationFeeBps` stays after graduation as a record; `curveState` is `CURVE_NONE`,
  /// `CURVE_OPEN` or `CURVE_GRADUATED`. A pool created before the curve existed reads as a
  /// seeded pool. The price of any pool is `(reserveQuote + virtualQuote) / reserveBase`.
  virtualQuote: bigint; graduationTarget: bigint; graduationFeeBps: number; curveState: number;
}

export interface TaxConfig { bump: number; pool: PublicKey; owner: PublicKey; buyBps: number; sellBps: number; maxBps: number; creator: PublicKey; renounced: boolean }
export interface GuardConfig { bump: number; pool: PublicKey; startSlot: bigint; guardSlots: bigint; startFeeBps: number; creator: PublicKey }
export interface BuybackConfig {
  bump: number; authorityBump: number; pool: PublicKey; baseMint: PublicKey; quoteMint: PublicKey; treasury: PublicKey;
  buyBps: number; sellBps: number; minQuote: bigint; totalQuoteSpent: bigint; totalBaseBurned: bigint; buybacks: bigint; creator: PublicKey;
  /// The observation `execute_buyback` buys against (`burnStep`): the slot it was taken in
  /// and the pool's reserves then. No observation yet while a reserve is zero.
  obsSlot: bigint; obsReserveBase: bigint; obsReserveQuote: bigint;
}
export interface Launch {
  address: PublicKey; bump: number; dev: PublicKey; pool: PublicKey; baseMint: PublicKey; quoteMint: PublicKey;
  /// `lpLocked`: the LP the launch minted and moved to the pool's lock account, forever.
  hookProgram: PublicKey; lpLocked: bigint; launchFeePaid: bigint; devBuyQuote: bigint; createdSlot: bigint;
  /// True for a launch made on the curve (`launch_curve`; byte 201 of the record is
  /// `LAUNCH_KIND_CURVE`). A seeded launch, and every launch made before the curve existed,
  /// reads false.
  curve: boolean;
}
export interface HookManifest { version: number; flags: number; admin: PublicKey | null; name: string; uri: string }
export interface TokenMetadata { mint: PublicKey; updateAuthority: PublicKey; name: string; symbol: string; uri: string; isMutable: boolean }
export interface MintInfo { supply: bigint; decimals: number; mintAuthority: PublicKey | null; freezeAuthority: PublicKey | null; tokenProgram: PublicKey }

function expect(data: Uint8Array, name: keyof typeof ACCOUNT_DISC) {
  if (!discriminatorMatches(data, ACCOUNT_DISC[name])) throw new Error(`not a ${name} account`);
  const r = new Reader(data);
  r.skip(8);
  return r;
}

export function decodePlatform(data: Uint8Array): Platform {
  const r = expect(data, "Platform");
  const bump = r.u8();
  const admin = r.pubkey(); const pendingAdmin = r.pubkey(); const treasury = r.pubkey();
  const protocolFeeBps = r.u16(); const maxLpFeeBps = r.u16(); const maxHookFeeBps = r.u16(); const maxFeeOverrideBps = r.u16();
  const launchFeeLamports = r.u64(); const paused = r.bool(); const len = r.u8();
  const all: PublicKey[] = [];
  for (let i = 0; i < 8; i++) all.push(r.pubkey());
  const poolCount = r.u64();
  // offsets 387, 395 and 403 of the 451-byte account; a shorter account (an older layout)
  // reads as curve launches off
  const tail = r.remaining() >= 18;
  const curveVirtualQuote = tail ? r.u64() : 0n; const curveGraduationTarget = tail ? r.u64() : 0n; const curveGraduationFeeBps = tail ? r.u16() : 0;
  // byte 405, the first of the old reserved bytes: 0 on every platform written before it existed
  const hookApprovalRequired = tail && r.remaining() >= 1 ? r.bool() : false;
  const list = decodeApprovedList(data);
  return {
    bump, admin, pendingAdmin, treasury, protocolFeeBps, maxLpFeeBps, maxHookFeeBps, maxFeeOverrideBps, launchFeeLamports, paused, whitelist: all.slice(0, len), poolCount,
    curveVirtualQuote, curveGraduationTarget, curveGraduationFeeBps, curveEnabled: curveVirtualQuote > 0n && curveGraduationTarget > 0n,
    hookApprovalRequired, approvedHooks: list.programs, approvedListCorrupt: list.corrupt,
  };
}

export function decodePool(address: PublicKey, data: Uint8Array): Pool {
  const r = expect(data, "Pool");
  const bump = r.u8();
  const baseMint = r.pubkey(); const quoteMint = r.pubkey(); const baseVault = r.pubkey(); const quoteVault = r.pubkey();
  const lpMint = r.pubkey(); const lpLock = r.pubkey(); const baseTokenProgram = r.pubkey(); const quoteTokenProgram = r.pubkey();
  const lpFeeBps = r.u16(); const hookProgram = r.pubkey(); const hookFlags = r.u32(); const hookExtraMetas = r.pubkey();
  const hookQuoteTreasury = r.pubkey(); const hookKind = r.u8();
  const reserveBase = r.u64(); const reserveQuote = r.u64(); const protocolFeesBase = r.u64(); const protocolFeesQuote = r.u64();
  const hookFeesQuoteTotal = r.u64(); const volumeQuoteTotal = r.u64(); const swapCount = r.u64(); const createdSlot = r.u64();
  const creator = r.pubkey();
  const hookFeesOwedQuote = r.u64(); const hookTreasuryOwner = r.pubkey();
  // offsets 504, 512, 520 and 522 of the 528-byte account; a shorter account reads as a
  // seeded pool, which is what every pool made before the curve is
  const tail = r.remaining() >= 19;
  const virtualQuote = tail ? r.u64() : 0n; const graduationTarget = tail ? r.u64() : 0n; const graduationFeeBps = tail ? r.u16() : 0; const curveState = tail ? r.u8() : 0;
  return {
    address, bump, baseMint, quoteMint, baseVault, quoteVault, lpMint, lpLock, baseTokenProgram, quoteTokenProgram, lpFeeBps,
    hookProgram, hookFlags, hookExtraMetas, hookQuoteTreasury, hookKind, reserveBase, reserveQuote, protocolFeesBase, protocolFeesQuote,
    hookFeesQuoteTotal, volumeQuoteTotal, swapCount, createdSlot, creator, hookFeesOwedQuote, hookTreasuryOwner,
    hasHook: !hookProgram.equals(SYSTEM_PROGRAM),
    virtualQuote, graduationTarget, graduationFeeBps, curveState,
  };
}

export function decodeTaxConfig(data: Uint8Array): TaxConfig {
  const r = expect(data, "TaxConfig");
  const bump = r.u8(); const pool = r.pubkey(); const owner = r.pubkey();
  const buyBps = r.u16(); const sellBps = r.u16(); const maxBps = r.u16(); const creator = r.pubkey();
  return { bump, pool, owner, buyBps, sellBps, maxBps, creator, renounced: owner.equals(SYSTEM_PROGRAM) };
}

export function decodeGuardConfig(data: Uint8Array): GuardConfig {
  const r = expect(data, "GuardConfig");
  const bump = r.u8(); const pool = r.pubkey(); const startSlot = r.u64(); const guardSlots = r.u64(); const startFeeBps = r.u16(); const creator = r.pubkey();
  return { bump, pool, startSlot, guardSlots, startFeeBps, creator };
}

export function decodeBuybackConfig(data: Uint8Array): BuybackConfig {
  const r = expect(data, "BuybackConfig");
  const bump = r.u8(); const authorityBump = r.u8(); const pool = r.pubkey(); const baseMint = r.pubkey(); const quoteMint = r.pubkey();
  const treasury = r.pubkey(); const buyBps = r.u16(); const sellBps = r.u16(); const minQuote = r.u64();
  const totalQuoteSpent = r.u64(); const totalBaseBurned = r.u64(); const buybacks = r.u64(); const creator = r.pubkey();
  // offsets 206, 214 and 222 of the 230-byte account. A shorter account of an older layout
  // reads as "no observation yet"; the program of today cannot use such an account anyway.
  const tail = r.remaining() >= 24;
  const obsSlot = tail ? r.u64() : 0n; const obsReserveBase = tail ? r.u64() : 0n; const obsReserveQuote = tail ? r.u64() : 0n;
  return { bump, authorityBump, pool, baseMint, quoteMint, treasury, buyBps, sellBps, minQuote, totalQuoteSpent, totalBaseBurned, buybacks, creator, obsSlot, obsReserveBase, obsReserveQuote };
}

export function decodeLaunch(address: PublicKey, data: Uint8Array): Launch {
  const r = expect(data, "Launch");
  const bump = r.u8(); const dev = r.pubkey(); const pool = r.pubkey(); const baseMint = r.pubkey(); const quoteMint = r.pubkey();
  const hookProgram = r.pubkey(); const lpLocked = r.u64(); const launchFeePaid = r.u64(); const devBuyQuote = r.u64(); const createdSlot = r.u64();
  // byte 201 of the 265-byte record: the kind of launch (0 seeded, 1 curve)
  const curve = r.remaining() >= 1 && r.u8() === LAUNCH_KIND_CURVE;
  return { address, bump, dev, pool, baseMint, quoteMint, hookProgram, lpLocked, launchFeePaid, devBuyQuote, createdSlot, curve };
}

export function decodeHookManifest(data: Uint8Array): HookManifest {
  const r = expect(data, "HookManifest");
  const version = r.u8(); const flags = r.u32(); const admin = r.option((rr) => rr.pubkey());
  const name = r.fixedString(32); const uri = r.fixedString(128);
  return { version, flags, admin, name, uri };
}

/// Classic SPL mint (82 bytes) or Token-2022 mint (same base layout).
export function decodeMint(data: Uint8Array, owner: PublicKey): MintInfo {
  const r = new Reader(data);
  const hasMintAuth = r.u32() === 1; const mintAuth = r.pubkey();
  const supply = r.u64(); const decimals = r.u8(); r.u8();
  const hasFreeze = r.u32() === 1; const freeze = r.pubkey();
  return { supply, decimals, mintAuthority: hasMintAuth ? mintAuth : null, freezeAuthority: hasFreeze ? freeze : null, tokenProgram: owner };
}

export function decodeTokenAmount(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true);
}

/// Metaplex Token Metadata v1 account: key, update authority, mint, then borsh strings.
export function decodeMetaplexMetadata(data: Uint8Array): TokenMetadata {
  const r = new Reader(data);
  r.u8();
  const updateAuthority = r.pubkey(); const mint = r.pubkey();
  const name = r.string().replace(/\0+$/, ""); const symbol = r.string().replace(/\0+$/, ""); const uri = r.string().replace(/\0+$/, "");
  r.u16();
  const hasCreators = r.u8() === 1;
  if (hasCreators) { const n = r.u32(); r.skip(n * 34); }
  r.u8();
  const isMutable = r.bool();
  return { mint, updateAuthority, name, symbol, uri, isMutable };
}

/// A Token-2022 extension's value inside a mint or token account, by its type number.
/// The base state is padded to 165 bytes, byte 165 is the account type, then TLV entries.
export function token2022Extension(data: Uint8Array, type: number): Uint8Array | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let i = 166;
  while (i + 4 <= data.length) {
    const t = v.getUint16(i, true), len = v.getUint16(i + 2, true);
    if (t === 0 || i + 4 + len > data.length) return null;
    if (t === type) return data.subarray(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return null;
}
/// Name, symbol and uri a Token-2022 mint carries in itself (extension 19). A pegged coin
/// keeps its metadata there: Metaplex refuses mints with a transfer hook.
export function decodeToken2022Metadata(mint: PublicKey, data: Uint8Array): TokenMetadata | null {
  const ext = token2022Extension(data, 19);
  if (!ext) return null;
  const r = new Reader(ext);
  const updateAuthority = r.pubkey(); r.pubkey();
  const name = r.string(); const symbol = r.string(); const uri = r.string();
  return { mint, updateAuthority, name, symbol, uri, isMutable: !updateAuthority.equals(PublicKey.default) };
}
/// The transfer hook of a Token-2022 mint (extension 14): its program, and the key that
/// could still change it. null when the mint has neither. A mint with no program but an
/// authority is reported as `{ program: null, authority }`: that key could give the coin a
/// program later.
export function decodeTransferHook(data: Uint8Array): { program: PublicKey | null; authority: PublicKey | null } | null {
  const ext = token2022Extension(data, 14);
  if (!ext || ext.length < 64) return null;
  const authority = new PublicKey(ext.subarray(0, 32)); const program = new PublicKey(ext.subarray(32, 64));
  const noProgram = program.equals(PublicKey.default); const noAuthority = authority.equals(PublicKey.default);
  if (noProgram && noAuthority) return null;
  return { program: noProgram ? null : program, authority: noAuthority ? null : authority };
}

/// Upgrade authority of a loader-v3 ProgramData account. null = frozen.
export function decodeUpgradeAuthority(programData: Uint8Array): PublicKey | null {
  if (programData.length < 45) throw new Error("not a ProgramData account");
  const variant = new DataView(programData.buffer, programData.byteOffset, 4).getUint32(0, true);
  if (variant !== 3) throw new Error("not a ProgramData account");
  return programData[12] === 1 ? new PublicKey(programData.subarray(13, 45)) : null;
}

// ---- flags in plain words ----------------------------------------------------------

export interface FlagSummary {
  runsOnBuys: boolean; runsOnSells: boolean; canTakeFee: boolean; canOverrideFee: boolean; canOverrideCurve: boolean;
  canBlockSells: boolean; canBlockBuys: boolean; touchesLiquidity: boolean; canBlockRemoval: boolean;
  /// The hook runs when liquidity is added and could refuse it (the rules template and the
  /// launch guard do, while their sniper or guard window runs).
  canBlockAdding: boolean;
  sentences: string[];
}

export function describeFlags(flags: number): FlagSummary {
  const has = (f: number) => (flags & f) !== 0;
  const swapCb = has(FLAGS.BEFORE_SWAP) || has(FLAGS.AFTER_SWAP);
  const runsOnBuys = swapCb && has(FLAGS.CALL_ON_BUY);
  const runsOnSells = swapCb && has(FLAGS.CALL_ON_SELL);
  const canTakeFee = has(FLAGS.TAKE_HOOK_FEE);
  const canOverrideFee = has(FLAGS.OVERRIDE_FEE);
  const canOverrideCurve = has(FLAGS.OVERRIDE_CURVE);
  const touchesLiquidity = has(FLAGS.BEFORE_ADD_LIQ) || has(FLAGS.AFTER_ADD_LIQ) || has(FLAGS.BEFORE_REMOVE_LIQ) || has(FLAGS.AFTER_REMOVE_LIQ);
  const canBlockRemoval = has(FLAGS.BEFORE_REMOVE_LIQ) || has(FLAGS.AFTER_REMOVE_LIQ);
  const canBlockAdding = has(FLAGS.BEFORE_ADD_LIQ) || has(FLAGS.AFTER_ADD_LIQ);
  const s: string[] = [];
  if (!swapCb) s.push("Never runs on trades.");
  else if (runsOnBuys && runsOnSells) s.push("Runs on buys and sells.");
  else if (runsOnBuys) s.push("Runs on buys only. It is never called on a sell, so it cannot block or tax sells.");
  else if (runsOnSells) s.push("Runs on sells only.");
  else s.push("Has trade callbacks but no direction enabled, so it never runs.");
  if (canTakeFee) s.push("Can take a fee in the quote token to its treasury, up to the platform cap.");
  if (canOverrideFee) s.push("Can change the pool fee per trade, up to the platform cap.");
  if (canOverrideCurve) s.push("Sets the price itself. It can hand the pool's reserves to anyone it chooses. Locked liquidity does not protect against this.");
  if (!canTakeFee && !canOverrideFee && !canOverrideCurve && swapCb) s.push("Cannot take fees or change prices. It can only allow or refuse.");
  if (canBlockRemoval) s.push("Runs when liquidity is removed and could refuse it.");
  if (canBlockAdding) s.push(canBlockRemoval ? "Runs when liquidity is added and could refuse it." : "Runs when liquidity is added and could refuse it. It never runs when liquidity is removed.");
  return { runsOnBuys, runsOnSells, canTakeFee, canOverrideFee, canOverrideCurve, canBlockSells: runsOnSells, canBlockBuys: runsOnBuys, touchesLiquidity, canBlockRemoval, canBlockAdding, sentences: s };
}
