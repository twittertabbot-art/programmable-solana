// The "launch rules" template (hook_rules): bounds, addresses, decoders, and the program's
// arithmetic ported line by line, same order and same rounding. RULES.md at the repository
// root is the reference; programs/hook_rules/src/lib.rs is the source.
import { PublicKey } from "@solana/web3.js";
import { Reader, discriminatorMatches } from "./borsh.js";
import { ACCOUNT_DISC } from "./generated.js";
import { DIRECTION, PROGRAMS, SEEDS, TOKEN_PROGRAM } from "./constants.js";
import { pda } from "./pda.js";
import { SwapQuote, burnCapBps, quoteSwap } from "./math.js";

// ---- bounds ------------------------------------------------------------------------------

/// What the program refuses above: `init_pool_config` fails for a value over one of these.
/// Rates are in basis points per side (buy or sell), windows in slots, the lock in seconds.
export const RULES_CEILINGS = {
  creatorBps: 500,
  holdersBps: 500,
  burnBps: 500,
  /// The three rates of one side together.
  sideBps: 1_000,
  sniperStartFeeBps: 5_000,
  sniperSlots: 10_800,
  limitSlots: 9_000,
  creatorLockSeconds: 31_536_000,
} as const;
/// What a launch form should offer (the "policy" column of the table in RULES.md). A site
/// may offer less. The windows are the table's minutes at 400 ms a slot: 5 minutes and 30
/// minutes. The lock is 90 days.
export const RULES_POLICY = {
  creatorBps: 200,
  holdersBps: 200,
  burnBps: 100,
  sideBps: 300,
  sniperStartFeeBps: 5_000,
  sniperSlots: 750,
  limitSlots: 4_500,
  creatorLockSeconds: 7_776_000,
} as const;
export type RulesBounds = { readonly [K in keyof typeof RULES_CEILINGS]: number };
/// The length of a slot the windows are worded with. A slot is not a fixed time: this is
/// the usual one.
export const RULES_SLOT_MS = 400;
/// `lock_creator` with this amount locks the whole balance of the creator's coin account.
export const LOCK_WHOLE_BALANCE = 18_446_744_073_709_551_615n;
/// Staked coins cannot be taken out until this many slots after the record's last stake
/// (about one hour).
export const UNSTAKE_DELAY_SLOTS = 9_000n;
/// Scale of `accPerShare`.
export const RULES_ACC_SCALE = 1_000_000_000_000n;
/// Holder rewards are charged while at least supply / this is staked (0.1%).
export const RULES_ELIGIBLE_DIVISOR = 1_000n;
/// Seconds a launch adds to the end of a creator lock, by default, for the time between
/// building the launch and its landing (see `launchInstructions`).
export const RULES_LOCK_MARGIN_SECONDS = 600;

// ---- addresses ---------------------------------------------------------------------------

const P = () => PROGRAMS.hook_rules;
export const rulesPda = {
  /// The rules of one pool and the running numbers. Owns the stake vault and the lock vault.
  cfg: (pool: PublicKey) => pda.cfg(P(), pool),
  /// Owns the treasury and the burn account, signs the pool's `hook_swap`. Holds no data.
  authority: (pool: PublicKey) => pda.hookAuthority(pool, P())[0],
  /// Receives the hook fee of every trade: the pool's `hookQuoteTreasury`.
  treasury: (pool: PublicKey, quoteMint: PublicKey, quoteTokenProgram: PublicKey = TOKEN_PROGRAM) =>
    pda.ata(pda.hookAuthority(pool, P())[0], quoteMint, quoteTokenProgram),
  /// Coins bought by `run_burn` land here and are burned in the same instruction.
  burnAccount: (pool: PublicKey, baseMint: PublicKey, baseTokenProgram: PublicKey = TOKEN_PROGRAM) =>
    pda.ata(pda.hookAuthority(pool, P())[0], baseMint, baseTokenProgram),
  stakeVault: (pool: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.stakeVault, pool.toBuffer()], P())[0],
  stake: (pool: PublicKey, wallet: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.stake, pool.toBuffer(), wallet.toBuffer()], P())[0],
  lock: (pool: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.lock, pool.toBuffer()], P())[0],
  lockVault: (pool: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.lockVault, pool.toBuffer()], P())[0],
  /// Strict coin: a wallet's holder record, ["holder", pool, wallet]. `holder(pool, pool)`
  /// is the address the pool's own side resolves to; it never exists.
  holder: (pool: PublicKey, wallet: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.holder, pool.toBuffer(), wallet.toBuffer()], P())[0],
  /// Strict coin: the account list Token-2022 reads on every transfer, ["extra-account-metas", mint].
  validation: (mint: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.transferHookMetas, mint.toBuffer()], P())[0],
};

// ---- accounts ----------------------------------------------------------------------------

/// The three shares of a trade, in basis points.
export interface RulesRates { creatorBps: number; holdersBps: number; burnBps: number }
/// What the launcher chooses: the argument of `init_pool_config`, 46 bytes.
export interface RulesArgs {
  sniperSlots: bigint; sniperStartFeeBps: number; buy: RulesRates; sell: RulesRates;
  maxBuyQuote: bigint; limitSlots: bigint; creatorLockSeconds: bigint;
}
/// The same, as a form gives it: everything optional, zero when left out.
export interface RulesInput {
  sniperSlots?: bigint | number; sniperStartFeeBps?: number;
  buy?: Partial<RulesRates>; sell?: Partial<RulesRates>;
  maxBuyQuote?: bigint | number; limitSlots?: bigint | number; creatorLockSeconds?: bigint | number;
}
/// `RulesConfig`, 414 bytes, PDA ["cfg", pool]. Bytes 8 to 239 (everything down to
/// `minEligible`) never change once the pool exists.
export interface RulesConfig extends RulesArgs {
  bump: number; authorityBump: number; pool: PublicKey; baseMint: PublicKey; quoteMint: PublicKey;
  treasury: PublicKey;
  /// Who paid for the config: the pool's creator. Receives the creator fee.
  creator: PublicKey;
  /// Slot and clock time of the pool's creation. Zero before.
  startSlot: bigint; startTime: bigint;
  /// 0.1% of the supply at launch, at least 1. The holders' share of a trade goes to the
  /// stakers while at least this much is staked, and to the burn pot otherwise. Zero before
  /// the pool exists and never afterwards.
  minEligible: bigint;
  /// The pool's hook fees paid to the treasury, as of the last settlement.
  feesSeen: bigint;
  /// The three rates the last trade was charged, for settling it.
  lastSplit: RulesRates;
  creatorOwed: bigint; burnPot: bigint; accPerShare: bigint; rewardRem: bigint; totalStaked: bigint; rewardsOwedTotal: bigint;
  totalCreatorPaid: bigint; totalRewardsPaid: bigint; totalQuoteBurned: bigint; totalBaseBurned: bigint; burns: bigint;
  /// The observation `run_burn` buys against (`burnStep`): the slot it was taken in and the
  /// pool's reserves then. No observation yet while a reserve is zero.
  obsSlot: bigint; obsReserveBase: bigint; obsReserveQuote: bigint;
  /// The kind of coin: 0 plain, 1 strict (`RULES_KIND`). A plain config has zeros in all of
  /// the strict fields below.
  kind: number;
  /// A strict coin: a Token-2022 coin whose transfer hook is hook_rules. On a strict coin
  /// `totalStaked` is the sum of the balances in the holder records.
  strict: boolean;
  /// Strict coin. `buyMark` is 0 whenever anybody can read the account. `vaultBump` and
  /// `maxWalletAmount` (in raw units of the coin) are written when the pool is created.
  buyMark: number; vaultBump: number;
  maxWalletBps: number; earlySlots: number; maxWalletSlots: number; earlyUnlockSlots: number; maxWalletAmount: bigint;
  /// True once the pool exists (`minEligible` is not zero).
  started: boolean;
}
/// `StakeRecord`, 113 bytes, PDA ["stake", pool, wallet].
export interface StakeRecord { bump: number; pool: PublicKey; staker: PublicKey; amount: bigint; accSnapshot: bigint; owed: bigint; sinceSlot: bigint }
/// `LockRecord`, 57 bytes, PDA ["lock", pool]. `unlockAt` is a Unix time, zero when nothing is locked.
export interface LockRecord { bump: number; pool: PublicKey; amount: bigint; unlockAt: bigint }

const readRates = (r: Reader): RulesRates => ({ creatorBps: r.u16(), holdersBps: r.u16(), burnBps: r.u16() });

export function decodeRulesConfig(data: Uint8Array): RulesConfig {
  if (!discriminatorMatches(data, ACCOUNT_DISC.RulesConfig)) throw new Error("not a RulesConfig account");
  if (data.length < 374) throw new Error("not a RulesConfig account: too short");
  const r = new Reader(data); r.skip(8);
  const bump = r.u8(); const authorityBump = r.u8();
  const pool = r.pubkey(); const baseMint = r.pubkey(); const quoteMint = r.pubkey(); const treasury = r.pubkey(); const creator = r.pubkey();
  const sniperSlots = r.u64(); const sniperStartFeeBps = r.u16(); const buy = readRates(r); const sell = readRates(r);
  const maxBuyQuote = r.u64(); const limitSlots = r.u64(); const creatorLockSeconds = r.u64();
  const startSlot = r.u64(); const startTime = r.i64(); const minEligible = r.u64();
  const feesSeen = r.u64(); const lastSplit = readRates(r); const creatorOwed = r.u64(); const burnPot = r.u64();
  const accPerShare = r.u128(); const rewardRem = r.u64(); const totalStaked = r.u64(); const rewardsOwedTotal = r.u64();
  const totalCreatorPaid = r.u64(); const totalRewardsPaid = r.u64(); const totalQuoteBurned = r.u64(); const totalBaseBurned = r.u64();
  const burns = r.u64(); const obsSlot = r.u64(); const obsReserveBase = r.u64(); const obsReserveQuote = r.u64();
  // offsets 374 to 396: the strict part (zero on a plain coin)
  const tail = data.length >= 397;
  const kind = tail ? r.u8() : 0; const buyMark = tail ? r.u8() : 0; const vaultBump = tail ? r.u8() : 0;
  const maxWalletBps = tail ? r.u16() : 0; const earlySlots = tail ? r.u16() : 0; const maxWalletSlots = tail ? r.u32() : 0;
  const earlyUnlockSlots = tail ? r.u32() : 0; const maxWalletAmount = tail ? r.u64() : 0n;
  return {
    bump, authorityBump, pool, baseMint, quoteMint, treasury, creator, sniperSlots, sniperStartFeeBps, buy, sell, maxBuyQuote, limitSlots,
    creatorLockSeconds, startSlot, startTime, minEligible, feesSeen, lastSplit, creatorOwed, burnPot, accPerShare, rewardRem, totalStaked,
    rewardsOwedTotal, totalCreatorPaid, totalRewardsPaid, totalQuoteBurned, totalBaseBurned, burns, obsSlot, obsReserveBase, obsReserveQuote, started: minEligible !== 0n,
    kind, strict: kind === 1, buyMark, vaultBump, maxWalletBps, earlySlots, maxWalletSlots, earlyUnlockSlots, maxWalletAmount,
  };
}
export function decodeStakeRecord(data: Uint8Array): StakeRecord {
  if (!discriminatorMatches(data, ACCOUNT_DISC.StakeRecord)) throw new Error("not a StakeRecord account");
  if (data.length < 113) throw new Error("not a StakeRecord account: too short");
  const r = new Reader(data); r.skip(8);
  return { bump: r.u8(), pool: r.pubkey(), staker: r.pubkey(), amount: r.u64(), accSnapshot: r.u128(), owed: r.u64(), sinceSlot: r.u64() };
}
export function decodeLockRecord(data: Uint8Array): LockRecord {
  if (!discriminatorMatches(data, ACCOUNT_DISC.LockRecord)) throw new Error("not a LockRecord account");
  if (data.length < 57) throw new Error("not a LockRecord account: too short");
  const r = new Reader(data); r.skip(8);
  return { bump: r.u8(), pool: r.pubkey(), amount: r.u64(), unlockAt: r.i64() };
}

// ---- what a launcher may ask ---------------------------------------------------------------

const U64_MAX = 18_446_744_073_709_551_615n;
function whole(v: bigint | number | undefined, name: string, max: bigint): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error(`${name} must be a whole number`);
  const b = BigInt(v);
  if (b < 0n || b > max) throw new Error(`${name} is out of range`);
  return b;
}
const bps = (v: number | undefined, name: string) => Number(whole(v, name, 65_535n));
const rates = (r: Partial<RulesRates> | undefined, side: string): RulesRates => ({
  creatorBps: bps(r?.creatorBps, `${side}.creatorBps`), holdersBps: bps(r?.holdersBps, `${side}.holdersBps`), burnBps: bps(r?.burnBps, `${side}.burnBps`),
});
/// The argument of `init_pool_config` from what a form holds. Anything left out is zero,
/// which means "off". Throws for a value that is not a whole number or does not fit its field.
export function rulesArgs(input: RulesInput = {}): RulesArgs {
  return {
    sniperSlots: whole(input.sniperSlots, "sniperSlots", U64_MAX), sniperStartFeeBps: bps(input.sniperStartFeeBps, "sniperStartFeeBps"),
    buy: rates(input.buy, "buy"), sell: rates(input.sell, "sell"),
    maxBuyQuote: whole(input.maxBuyQuote, "maxBuyQuote", U64_MAX), limitSlots: whole(input.limitSlots, "limitSlots", U64_MAX),
    creatorLockSeconds: whole(input.creatorLockSeconds, "creatorLockSeconds", U64_MAX),
  };
}
export const rulesRatesTotal = (r: RulesRates): number => r.creatorBps + r.holdersBps + r.burnBps;

/// `code` is the name of the error the program answers for the same mistake.
export interface RulesProblem { code: string; message: string }
const pct = (b: number | bigint) => { const n = Number(b) / 100; return (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))) + "%"; };
/// Everything `init_pool_config` would refuse in these numbers, in the order the program
/// checks them. Empty when the program takes them. Pass `RULES_POLICY` as `bounds` to
/// check a form against what it should offer instead of against the program's ceilings.
export function rulesProblems(a: RulesArgs, bounds: RulesBounds = RULES_CEILINGS): RulesProblem[] {
  const out: RulesProblem[] = [];
  for (const [name, side] of [["buys", a.buy], ["sells", a.sell]] as const) {
    if (side.creatorBps > bounds.creatorBps) out.push({ code: "CreatorFeeTooHigh", message: `the creator fee on ${name} is ${pct(side.creatorBps)}, the most is ${pct(bounds.creatorBps)}` });
    if (side.holdersBps > bounds.holdersBps) out.push({ code: "HoldersFeeTooHigh", message: `holder rewards on ${name} are ${pct(side.holdersBps)}, the most is ${pct(bounds.holdersBps)}` });
    if (side.burnBps > bounds.burnBps) out.push({ code: "BurnFeeTooHigh", message: `the burn rate on ${name} is ${pct(side.burnBps)}, the most is ${pct(bounds.burnBps)}` });
    if (rulesRatesTotal(side) > bounds.sideBps) out.push({ code: "SideTooHigh", message: `the three rates on ${name} add up to ${pct(rulesRatesTotal(side))}, the most is ${pct(bounds.sideBps)}` });
  }
  if (a.sniperStartFeeBps > bounds.sniperStartFeeBps) out.push({ code: "StartFeeTooHigh", message: `the sniper fee starts at ${pct(a.sniperStartFeeBps)}, the most is ${pct(bounds.sniperStartFeeBps)}` });
  if (a.sniperSlots > BigInt(bounds.sniperSlots)) out.push({ code: "SniperWindowTooLong", message: `the sniper window is ${a.sniperSlots} slots, the most is ${bounds.sniperSlots}` });
  if ((a.sniperSlots === 0n) !== (a.sniperStartFeeBps === 0)) out.push({ code: "SniperIncomplete", message: "a sniper fee needs both a window and a start fee" });
  if (a.limitSlots > BigInt(bounds.limitSlots)) out.push({ code: "LimitWindowTooLong", message: `the buy limit window is ${a.limitSlots} slots, the most is ${bounds.limitSlots}` });
  if ((a.maxBuyQuote === 0n) !== (a.limitSlots === 0n)) out.push({ code: "LimitIncomplete", message: "a buy limit needs both an amount and a window" });
  if (a.creatorLockSeconds > BigInt(bounds.creatorLockSeconds)) out.push({ code: "LockTooLong", message: `the creator lock is ${a.creatorLockSeconds} seconds, the most is ${bounds.creatorLockSeconds}` });
  return out;
}

// ---- the program's arithmetic ---------------------------------------------------------------

/// Port of `hook_rules::sniper_fee`: the pool fee of a buy inside the sniper window, a
/// straight line from `startFeeBps` at `startSlot` to the pool's own fee `sniperSlots`
/// later. null once the window is over, or when the start fee is not above the pool's fee.
export function rulesSniperFee(slot: bigint, startSlot: bigint, sniperSlots: bigint, startFeeBps: number, baseFeeBps: number): number | null {
  if (startFeeBps <= baseFeeBps || sniperSlots === 0n) return null;
  const elapsed = slot > startSlot ? slot - startSlot : 0n;
  if (elapsed >= sniperSlots) return null;
  const decayed = (BigInt(startFeeBps - baseFeeBps) * elapsed) / sniperSlots;
  return startFeeBps - Number(decayed);
}
/// The buy limit in force at `slot`: the most one buy may spend, and the first slot in which
/// it no longer applies. null when the coin has none or its window is over.
export function rulesBuyLimit(cfg: Pick<RulesConfig, "maxBuyQuote" | "limitSlots" | "startSlot">, slot: bigint): { maxBuyQuote: bigint; untilSlot: bigint } | null {
  if (cfg.maxBuyQuote === 0n) return null;
  const elapsed = slot > cfg.startSlot ? slot - cfg.startSlot : 0n;
  return elapsed < cfg.limitSlots ? { maxBuyQuote: cfg.maxBuyQuote, untilSlot: cfg.startSlot + cfg.limitSlots } : null;
}
/// The first slot in which liquidity can be added to the pool: the hook refuses
/// `add_liquidity` while the sniper window runs (the sniper fee is a pool fee, and a wallet
/// that added liquidity for a moment would take part of it). 0n when the coin has no sniper
/// fee. Removing liquidity is never refused.
export function rulesLiquidityOpenSlot(cfg: Pick<RulesConfig, "sniperSlots" | "startSlot">): bigint {
  return cfg.sniperSlots === 0n ? 0n : cfg.startSlot + cfg.sniperSlots;
}
/// The rates a trade of this side is charged: all three, whoever is staked, so what a
/// trader pays never depends on anybody's stake. Their sum is the hook fee the hook
/// answers; the pool clamps it to the platform's `maxHookFeeBps`.
export function rulesSideRates(cfg: Pick<RulesArgs, "buy" | "sell">, direction: number): RulesRates {
  return direction === DIRECTION.BUY ? cfg.buy : cfg.sell;
}
/// The hook fee of a trade of this side in basis points, as the pool charges it.
export function rulesHookFeeBps(cfg: Pick<RulesArgs, "buy" | "sell">, direction: number, maxHookFeeBps: number): number {
  return Math.min(rulesRatesTotal(rulesSideRates(cfg, direction)), maxHookFeeBps);
}
/// Do stakers receive the holders' share right now? Only while at least 0.1% of the supply
/// is staked (`minEligible`); otherwise that share goes to the burn pot at settlement.
export function rulesStakersEligible(cfg: Pick<RulesConfig, "totalStaked" | "minEligible">): boolean {
  return cfg.totalStaked > 0n && cfg.totalStaked >= cfg.minEligible;
}
/// Port of `hook_rules::split`: a hook fee split by the rates it was charged at. Creator
/// and holders are rounded down, the burn pot takes the rest.
export function rulesSplit(fresh: bigint, charged: RulesRates): { creator: bigint; holders: bigint; burn: bigint } {
  const c = BigInt(charged.creatorBps), h = BigInt(charged.holdersBps), t = c + h + BigInt(charged.burnBps);
  if (t === 0n) return { creator: 0n, holders: 0n, burn: fresh };
  const creator = (fresh * c) / t, holders = (fresh * h) / t;
  return { creator, holders, burn: fresh - creator - holders };
}
type PoolFees = { hookFeesQuoteTotal: bigint; hookFeesOwedQuote: bigint };
/// The hook fee the treasury received and the config has not split yet: the fee of the
/// last trade, as a rule.
export function rulesUnsettledFee(cfg: Pick<RulesConfig, "feesSeen">, pool: PoolFees): bigint {
  const paid = pool.hookFeesQuoteTotal > pool.hookFeesOwedQuote ? pool.hookFeesQuoteTotal - pool.hookFeesOwedQuote : 0n;
  return paid > cfg.feesSeen ? paid - cfg.feesSeen : 0n;
}
/// Port of `RulesConfig::settle`, on a copy: the config as it will be after the settlement
/// the program runs at the start of the next trade, stake, unstake, claim or burn. The
/// numbers in the account are one trade behind; this is how to show what is true now.
/// `pool` must be read at the same moment as `cfg` (the client's readers do).
export function rulesSettle(cfg: RulesConfig, pool: PoolFees): RulesConfig {
  const fresh = rulesUnsettledFee(cfg, pool);
  if (fresh === 0n) return { ...cfg };
  const out: RulesConfig = { ...cfg, feesSeen: cfg.feesSeen + fresh };
  const parts = rulesSplit(fresh, cfg.lastSplit);
  let burn = parts.burn;
  if (parts.holders > 0n) {
    // too little staked: the holders' share is burned instead
    if (!rulesStakersEligible(cfg)) burn += parts.holders;
    else {
      const n = parts.holders * RULES_ACC_SCALE + cfg.rewardRem;
      out.accPerShare = cfg.accPerShare + n / cfg.totalStaked;
      out.rewardRem = n % cfg.totalStaked;
    }
  }
  out.creatorOwed = cfg.creatorOwed + parts.creator;
  out.burnPot = cfg.burnPot + burn;
  return out;
}
/// What a stake record earned since its snapshot, rounded down as the program does. Pass
/// a config that went through `rulesSettle` for the amount as of now.
export function rulesPendingRewards(cfg: Pick<RulesConfig, "accPerShare">, rec: Pick<StakeRecord, "amount" | "accSnapshot">): bigint {
  const delta = cfg.accPerShare - rec.accSnapshot;
  if (delta <= 0n || rec.amount === 0n) return 0n;
  return (rec.amount * delta) / RULES_ACC_SCALE;
}
/// What `claim_rewards` would pay this record now.
export function rulesClaimable(cfg: RulesConfig, pool: PoolFees, rec: StakeRecord): bigint {
  return rec.owed + rulesPendingRewards(rulesSettle(cfg, pool), rec);
}
/// Port of `RulesConfig::burn_charged`: the part of a trade's hook fee that nobody gets
/// back, in basis points. The pool charges `min(creator + holders + burn, platform cap)`
/// and the burn pot's part of that is `burn / (creator + holders + burn)`, rounded down.
export function rulesBurnCharged(side: RulesRates, maxHookFeeBps: number): number {
  const total = rulesRatesTotal(side);
  if (total === 0) return 0;
  return Math.floor((Math.min(total, maxHookFeeBps) * side.burnBps) / total);
}
/// The cap of one `run_burn`, in basis points of the pool's quote reserve. Only the
/// protocol fee and the burn rates count: the creator's share comes back to the creator
/// and the holders' share to whoever is staked, so neither is a cost for them.
export function rulesBurnCapBps(cfg: Pick<RulesArgs, "buy" | "sell">, platform: { protocolFeeBps: number; maxHookFeeBps: number }, lpFeeBps: number): number {
  return burnCapBps(platform.protocolFeeBps, lpFeeBps, rulesBurnCharged(cfg.buy, platform.maxHookFeeBps), rulesBurnCharged(cfg.sell, platform.maxHookFeeBps));
}
/// The launcher's first buy, exactly as the launch will make it: the pool's reserves are
/// the launch liquidity, the sniper fee is the start fee, the hook fee is all three rates
/// of the buy side. `amountOut` is what the first buy receives, which is what a creator
/// lock in the launch transaction locks when the whole supply goes into the pool. On a
/// curve launch `quoteAmount` is 0n and `virtualQuote` the platform's virtual quote: the
/// first buy is priced on the curve.
export function rulesFirstBuyQuote(
  a: RulesArgs, launch: { totalSupply: bigint; quoteAmount: bigint; lpFeeBps: number; devBuyQuote: bigint; virtualQuote?: bigint },
  platform: { protocolFeeBps: number; maxHookFeeBps: number; maxFeeOverrideBps: number },
): SwapQuote {
  const sniper = rulesSniperFee(0n, 0n, a.sniperSlots, a.sniperStartFeeBps, launch.lpFeeBps);
  return quoteSwap({
    direction: DIRECTION.BUY, amountIn: launch.devBuyQuote, reserveBase: launch.totalSupply, reserveQuote: launch.quoteAmount, virtualQuote: launch.virtualQuote ?? 0n,
    lpFeeBps: launch.lpFeeBps, protocolFeeBps: platform.protocolFeeBps,
    hookFeeBps: rulesHookFeeBps(a, DIRECTION.BUY, platform.maxHookFeeBps),
    feeOverrideBps: sniper === null ? null : Math.min(sniper, platform.maxFeeOverrideBps),
  });
}

// ---- in words --------------------------------------------------------------------------------

function span(slots: bigint): string {
  const s = (Number(slots) * RULES_SLOT_MS) / 1000;
  const n = (v: number, unit: string) => { const r = Math.round(v * 10) / 10; return `about ${r} ${unit}${r === 1 ? "" : "s"}`; };
  return s < 90 ? n(s, "second") : s < 5_400 ? n(s / 60, "minute") : n(s / 3_600, "hour");
}
function lockSpan(seconds: bigint): string {
  const s = Number(seconds);
  const n = (v: number, unit: string) => { const r = Math.round(v * 10) / 10; return `${r} ${unit}${r === 1 ? "" : "s"}`; };
  return s % 86_400 === 0 ? n(s / 86_400, "day") : s >= 172_800 ? "about " + n(s / 86_400, "day") : s >= 7_200 ? "about " + n(s / 3_600, "hour") : s >= 120 ? "about " + n(s / 60, "minute") : n(s, "second");
}
function units(v: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (v / base).toString() + (frac ? "." + frac : "");
}
function sides(buy: number, sell: number): string {
  if (buy === sell) return `${pct(buy)} of every buy and every sell`;
  if (sell === 0) return `${pct(buy)} of every buy and nothing on sells`;
  if (buy === 0) return `${pct(sell)} of every sell and nothing on buys`;
  return `${pct(buy)} of every buy and ${pct(sell)} of every sell`;
}
/// The rules of a coin in plain sentences, one per rule that is switched on, with its
/// rates and windows. Works on what a form holds (`rulesArgs(...)`) and on a config read
/// from the chain. `quoteSymbol` and `quoteDecimals` word the amounts (default SOL, 9).
/// The rules of a coin in plain sentences, one per rule that is switched on, with its
/// rates and windows. Works on what a form holds (`rulesArgs(...)`) and on a config read
/// from the chain. `quoteSymbol` and `quoteDecimals` word the amounts (default SOL, 9).
/// A strict coin is worded as one: pass `opts.strict` (`strictArgs(...)`) for a form, or a
/// config with `kind` 1.
export function describeRules(r: RulesArgs & { kind?: number }, opts: { quoteSymbol?: string; quoteDecimals?: number; strict?: StrictArgs | null } = {}): string[] {
  const sym = opts.quoteSymbol ?? "SOL"; const dec = opts.quoteDecimals ?? 9;
  const strict: StrictArgs | null = opts.strict ?? (r.kind === RULES_KIND.STRICT ? strictArgsOf(r as RulesConfig) : null);
  const s: string[] = [];
  if (strict) {
    s.push("Strict coin: the coin is a Token-2022 coin whose transfer hook runs these rules in every transfer, in its pool and between wallets. Wallets and services that do not support transfer hooks cannot move it. It trades only in its own pool, and a wallet holds it only in its own associated token account.");
  }
  if (r.sniperSlots > 0n && r.sniperStartFeeBps > 0) {
    s.push(`Sniper fee: for the first ${r.sniperSlots} slots after launch (${span(r.sniperSlots)}), a buy pays a pool fee that starts at ${pct(r.sniperStartFeeBps)} and falls in a straight line to the pool's normal fee. The fee stays in the pool. Sells are not touched. No liquidity can be added to the pool while it runs.`);
  }
  if (r.buy.creatorBps > 0 || r.sell.creatorBps > 0) s.push(`Creator fee: the launcher receives ${sides(r.buy.creatorBps, r.sell.creatorBps)}, in ${sym}.`);
  if (r.buy.holdersBps > 0 || r.sell.holdersBps > 0) {
    if (strict) s.push(`Holder rewards: wallets that hold the coin and opened a holder record share ${sides(r.buy.holdersBps, r.sell.holdersBps)}, in ${sym}, in proportion to what they hold. Nothing is staked. A holder record costs about 0.0013 SOL of rent on mainnet, which comes back when it is closed. While less than 0.1% of the supply is registered, this share goes to the burn pot instead.`);
    else s.push(`Holder rewards: holders who stake the coin share ${sides(r.buy.holdersBps, r.sell.holdersBps)}, in ${sym}. While less than 0.1% of the supply is staked, this share goes to the burn pot instead.`);
  }
  if (r.buy.burnBps > 0 || r.sell.burnBps > 0) s.push(`Burn: ${sides(r.buy.burnBps, r.sell.burnBps)} collects in a pot. Anyone can run a buy of the coin with the pot, a slice at a time, and what it buys is burned.`);
  if (r.maxBuyQuote > 0n && r.limitSlots > 0n) {
    s.push(`Buy limit: for the first ${r.limitSlots} slots after launch (${span(r.limitSlots)}), one buy cannot spend more than ${units(r.maxBuyQuote, dec)} ${sym}. Sells are never limited.`);
  }
  if (strict && strict.maxWalletBps > 0) {
    s.push(`Max wallet: for the first ${strict.maxWalletSlots} slots after launch (${span(BigInt(strict.maxWalletSlots))}), no wallet can receive coins that would take it above ${pct(strict.maxWalletBps)} of the supply, by a buy or by a send. A sell is never held by it. No liquidity can be added to the pool while it runs; taking liquidity out is never refused.`);
  }
  if (strict && strict.earlySlots > 0) {
    s.push(`Early lock: coins bought from the pool in the first ${strict.earlySlots} slots after launch (${span(BigInt(strict.earlySlots))}) cannot leave the wallet until ${strict.earlyUnlockSlots} slots after launch (${span(BigInt(strict.earlyUnlockSlots))}). Coins the wallet got in other ways stay free. A buy in that first window needs the buyer's holder record.`);
  }
  if (r.creatorLockSeconds > 0n) {
    if (strict) s.push(`Creator lock: the launcher declared that its first buy stays in its wallet for ${lockSpan(r.creatorLockSeconds)} from the launch. Those coins cannot leave the wallet before the date. The lock record shows what is locked and until when.`);
    else s.push(`Creator lock: the launcher declared that its first buy stays locked for ${lockSpan(r.creatorLockSeconds)} from the launch. The lock account shows what is locked and until when.`);
  }
  if (s.length === 0) s.push("No rule is switched on: this coin trades like a pool without a hook.");
  s.push("Nobody can change a rule after the launch, the launcher included.");
  return s;
}

// ---- the strict coin (RULES.md, "The strict coin") ---------------------------------------------

/// `RulesConfig.kind`.
export const RULES_KIND = { PLAIN: 0, STRICT: 1 } as const;
/// The three numbers of a strict coin, the argument `strict` of `init_strict_config` (12
/// bytes). A rule is off when both of its numbers are zero.
export interface StrictArgs {
  /// Max wallet, in basis points of the supply. 0 = off.
  maxWalletBps: number;
  /// For how many slots after launch the max wallet holds.
  maxWalletSlots: number;
  /// Buys from the pool in the first `earlySlots` slots are early. 0 = off.
  earlySlots: number;
  /// Early coins unlock at `startSlot + earlyUnlockSlots`.
  earlyUnlockSlots: number;
}
export type StrictInput = Partial<StrictArgs>;
/// What the program refuses outside of (`init_strict_config`). `maxWalletBpsMin` and
/// `maxWalletBpsMax` bound a max wallet that is on; `earlyUnlockSlots` must also be at
/// least `earlySlots`.
export const RULES_STRICT_CEILINGS = {
  maxWalletBpsMin: 10,
  maxWalletBpsMax: 5_000,
  maxWalletSlots: 6_480_000,
  earlySlots: 9_000,
  earlyUnlockSlots: 1_512_000,
} as const;
/// What a launch form should offer (the policy column of RULES.md): a max wallet of 0.5% to
/// 5% for up to 24 hours, an early window of up to 10 minutes with an unlock up to 24
/// hours after launch. Slots at 400 ms.
export const RULES_STRICT_POLICY = {
  maxWalletBpsMin: 50,
  maxWalletBpsMax: 500,
  maxWalletSlots: 216_000,
  earlySlots: 1_500,
  earlyUnlockSlots: 216_000,
} as const;
export type StrictBounds = { readonly [K in keyof typeof RULES_STRICT_CEILINGS]: number };
/// Sizes of the rules program's per-wallet records, in bytes (RULES.md): the holder record of
/// a strict coin, a stake record, a lock record. Their rent is the chain's rent of that size
/// (`collectible.rentFrom`, or `HookpoolClient.rent()`): on mainnet, at 5,080 lamports a byte
/// over 128 bytes of overhead, 1,305,560, 1,224,280 and 939,800 lamports.
export const HOLDER_RECORD_SIZE = 129;
export const STAKE_RECORD_SIZE = 113;
export const LOCK_RECORD_SIZE = 57;
/// Rent of one holder record (129 bytes) on a LOCAL validator or LiteSVM (6,960 lamports a
/// byte), kept for tests and for the rehearsals on the local chain. On mainnet it is 1,305,560
/// lamports: read the chain's rent and take `rent(HOLDER_RECORD_SIZE)`. The rent comes back
/// when the record is closed.
export const HOLDER_RECORD_RENT = 1_788_720n;

/// The argument `strict` from what a form holds; anything left out is zero.
export function strictArgs(input: StrictInput = {}): StrictArgs {
  const n = (v: number | undefined, name: string, max: number) => {
    if (v === undefined || v === null) return 0;
    if (!Number.isSafeInteger(v) || v < 0 || v > max) throw new Error(`${name} must be a whole number from 0 to ${max}`);
    return v;
  };
  return {
    maxWalletBps: n(input.maxWalletBps, "maxWalletBps", 65_535), maxWalletSlots: n(input.maxWalletSlots, "maxWalletSlots", 4_294_967_295),
    earlySlots: n(input.earlySlots, "earlySlots", 65_535), earlyUnlockSlots: n(input.earlyUnlockSlots, "earlyUnlockSlots", 4_294_967_295),
  };
}
/// The strict numbers of a config read from the chain.
export function strictArgsOf(cfg: Pick<RulesConfig, "maxWalletBps" | "maxWalletSlots" | "earlySlots" | "earlyUnlockSlots">): StrictArgs {
  return { maxWalletBps: cfg.maxWalletBps, maxWalletSlots: cfg.maxWalletSlots, earlySlots: cfg.earlySlots, earlyUnlockSlots: cfg.earlyUnlockSlots };
}
/// Everything `init_strict_config` would refuse in the strict numbers, in the program's
/// order, by the program's error names. Pass `RULES_STRICT_POLICY` to check a form.
export function strictProblems(a: StrictArgs, bounds: StrictBounds = RULES_STRICT_CEILINGS): RulesProblem[] {
  const out: RulesProblem[] = [];
  if ((a.maxWalletBps === 0) !== (a.maxWalletSlots === 0)) out.push({ code: "MaxWalletIncomplete", message: "a max wallet needs both a share of the supply and a window" });
  else if (a.maxWalletBps !== 0 && (a.maxWalletBps < bounds.maxWalletBpsMin || a.maxWalletBps > bounds.maxWalletBpsMax || a.maxWalletSlots > bounds.maxWalletSlots)) {
    out.push({ code: "MaxWalletOutOfBounds", message: `the max wallet must be ${pct(bounds.maxWalletBpsMin)} to ${pct(bounds.maxWalletBpsMax)} of the supply for at most ${bounds.maxWalletSlots} slots` });
  }
  if ((a.earlySlots === 0) !== (a.earlyUnlockSlots === 0)) out.push({ code: "EarlyIncomplete", message: "an early lock needs both a window and an unlock" });
  else if (a.earlySlots !== 0 && (a.earlySlots > bounds.earlySlots || a.earlyUnlockSlots < a.earlySlots || a.earlyUnlockSlots > bounds.earlyUnlockSlots)) {
    out.push({ code: "EarlyOutOfBounds", message: `the early window may last at most ${bounds.earlySlots} slots, and the unlock comes after it and at most ${bounds.earlyUnlockSlots} slots after launch` });
  }
  return out;
}

/// `HolderRecord`, 129 bytes, PDA ["holder", pool, wallet] under hook_rules.
export interface HolderRecord {
  bump: number; pool: PublicKey; owner: PublicKey;
  /// What the wallet's token account held after its last transfer: rewards are paid on this.
  balance: bigint;
  accSnapshot: bigint; owed: bigint;
  /// Coins bought from the pool in the early window.
  earlyBought: bigint;
  /// The creator lock: only the creator's record has it. `lockedUntil` is a Unix time.
  locked: bigint; lockedUntil: bigint;
}
export function decodeHolderRecord(data: Uint8Array): HolderRecord {
  if (!discriminatorMatches(data, ACCOUNT_DISC.HolderRecord)) throw new Error("not a HolderRecord account");
  if (data.length < 129) throw new Error("not a HolderRecord account: too short");
  const r = new Reader(data); r.skip(8);
  return { bump: r.u8(), pool: r.pubkey(), owner: r.pubkey(), balance: r.u64(), accSnapshot: r.u128(), owed: r.u64(), earlyBought: r.u64(), locked: r.u64(), lockedUntil: r.i64() };
}

/// Ports of the three window checks of the program. Each window counts from `startSlot`.
export function strictMaxWalletRuns(cfg: Pick<RulesConfig, "maxWalletSlots" | "startSlot" | "minEligible">, slot: bigint): boolean {
  return cfg.maxWalletSlots > 0 && cfg.minEligible !== 0n && slot - cfg.startSlot < BigInt(cfg.maxWalletSlots);
}
export function strictEarlyWindowRuns(cfg: Pick<RulesConfig, "earlySlots" | "startSlot" | "minEligible">, slot: bigint): boolean {
  return cfg.earlySlots > 0 && cfg.minEligible !== 0n && slot - cfg.startSlot < BigInt(cfg.earlySlots);
}
export function strictEarlyLocked(cfg: Pick<RulesConfig, "earlySlots" | "earlyUnlockSlots" | "startSlot" | "minEligible">, slot: bigint): boolean {
  return cfg.earlySlots > 0 && cfg.minEligible !== 0n && slot - cfg.startSlot < BigInt(cfg.earlyUnlockSlots);
}
/// The ends of the three windows, as slots (0n when the rule is off or the pool does not
/// exist yet): the max wallet holds before `maxWalletUntil`, a buy is early before
/// `earlyUntil`, early coins are locked before `earlyUnlock`.
export function strictWindows(cfg: Pick<RulesConfig, "maxWalletSlots" | "earlySlots" | "earlyUnlockSlots" | "startSlot" | "started">): { maxWalletUntil: bigint; earlyUntil: bigint; earlyUnlock: bigint } {
  if (!cfg.started) return { maxWalletUntil: 0n, earlyUntil: 0n, earlyUnlock: 0n };
  return {
    maxWalletUntil: cfg.maxWalletSlots > 0 ? cfg.startSlot + BigInt(cfg.maxWalletSlots) : 0n,
    earlyUntil: cfg.earlySlots > 0 ? cfg.startSlot + BigInt(cfg.earlySlots) : 0n,
    earlyUnlock: cfg.earlySlots > 0 ? cfg.startSlot + BigInt(cfg.earlyUnlockSlots) : 0n,
  };
}
/// The max wallet in raw units of the coin before the pool exists, from the supply: what
/// `on_pool_create` will write.
export function strictMaxWalletAmount(supply: bigint, maxWalletBps: number): bigint {
  if (maxWalletBps === 0) return 0n;
  const v = (supply * BigInt(maxWalletBps)) / 10_000n;
  return v > 1n ? v : 1n;
}
/// What a holder record could claim now: settle the config on a copy first
/// (`rulesSettle`), then `owed + balance * (accPerShare - accSnapshot) / 10^12`.
export function strictHolderClaimable(settled: Pick<RulesConfig, "accPerShare">, rec: Pick<HolderRecord, "balance" | "accSnapshot" | "owed">): bigint {
  const delta = settled.accPerShare - rec.accSnapshot;
  return rec.owed + (delta > 0n && rec.balance > 0n ? (rec.balance * delta) / RULES_ACC_SCALE : 0n);
}

/// One side of a transfer of a strict coin, for `strictTransferRefusal`: the wallet's
/// balance BEFORE the transfer and its holder record (null when it has none).
export interface StrictSide { balance: bigint; record: HolderRecord | null }
/// What the coin's transfer hook would refuse in a transfer, worked out the way `execute`
/// works, in its order. null when it would let it through.
///
/// `kind`: "buy" (from the pool to `to`), "sell" (from `from` to the pool) or "send" (from
/// one wallet to another). `slot` and `unixTime` are the chain's (`client.chainTime`).
export function strictTransferRefusal(
  cfg: Pick<RulesConfig, "kind" | "startSlot" | "minEligible" | "maxWalletSlots" | "maxWalletAmount" | "earlySlots" | "earlyUnlockSlots">,
  t: { kind: "buy" | "sell" | "send"; amount: bigint; from?: StrictSide; to?: StrictSide },
  slot: bigint, unixTime: bigint,
): RulesErrorInfo | null {
  if (cfg.kind !== RULES_KIND.STRICT) return null;
  const fromWallet = t.kind !== "buy" ? t.from : undefined;
  if (fromWallet && fromWallet.record) {
    const after = fromWallet.balance > t.amount ? fromWallet.balance - t.amount : 0n;
    if (strictEarlyLocked(cfg, slot) && after < fromWallet.record.earlyBought) return RULES_ERRORS[6045];
    if (fromWallet.record.locked > 0n && unixTime < fromWallet.record.lockedUntil && after < fromWallet.record.locked) return RULES_ERRORS[6046];
  }
  const toWallet = t.kind !== "sell" ? t.to : undefined;
  if (toWallet) {
    if (strictMaxWalletRuns(cfg, slot) && toWallet.balance + t.amount > cfg.maxWalletAmount) return RULES_ERRORS[6044];
    if (t.kind === "buy" && !toWallet.record && strictEarlyWindowRuns(cfg, slot)) return RULES_ERRORS[6047];
  }
  return null;
}

// ---- the errors of hook_rules, by number ---------------------------------------------------------

export interface RulesErrorInfo { number: number; name: string; message: string }
const ERR: [string, string][] = [
  ["CreatorFeeTooHigh", "The creator fee is above the most the program allows."],
  ["HoldersFeeTooHigh", "The holders' rate is above the most the program allows."],
  ["BurnFeeTooHigh", "The burn rate is above the most the program allows."],
  ["SideTooHigh", "The three rates of one side add up to more than the program allows."],
  ["StartFeeTooHigh", "The sniper fee starts above the most the program allows."],
  ["SniperWindowTooLong", "The sniper window is longer than the program allows."],
  ["SniperIncomplete", "A sniper fee needs both a window and a start fee."],
  ["LimitWindowTooLong", "The buy limit window is longer than the program allows."],
  ["LimitIncomplete", "A buy limit needs both an amount and a window."],
  ["LockTooLong", "The declared creator lock is longer than 365 days."],
  ["WrongPool", "The config does not belong to this pool."],
  ["WrongHook", "This pool does not run this hook."],
  ["WrongCreator", "The pool's creator did not make the config."],
  ["WrongMints", "A mint is not the config's."],
  ["WrongTreasury", "The treasury is not the config's."],
  ["AlreadyStarted", "The pool of this config exists already."],
  ["NotStarted", "The pool of this config does not exist yet."],
  ["BuyTooLarge", "This buy is above the coin's buy limit, which still runs."],
  ["ZeroAmount", "The amount is zero."],
  ["UnstakeTooEarly", "Staked coins can be taken back about one hour after the last stake."],
  ["InsufficientStake", "That is more than the wallet has staked."],
  ["NothingToClaim", "There is nothing to claim."],
  ["NotCreator", "Only the wallet that launched the coin can do this."],
  ["NothingToBurn", "The burn pot is empty."],
  ["NothingBought", "The burn bought nothing."],
  ["UnlockEarlier", "The end of a lock can only move later."],
  ["UnlockBeforeDeclared", "The lock would end before the date the launcher declared."],
  ["UnlockTooFar", "The lock would end more than 365 days from now."],
  ["UnlockInPast", "The end of the lock is not in the future."],
  ["StillLocked", "The creator lock is not over yet."],
  ["NothingLocked", "Nothing is locked."],
  ["MathOverflow", "An amount is too large."],
  ["BurnTooSoon", "The burn looked at the pool less than 25 slots ago. Try again a little later."],
  ["LiquidityInSniperWindow", "No liquidity can be added while the sniper fee runs."],
  ["StrictCoin", "This instruction is not for a strict coin."],
  ["NotStrict", "This instruction is only for a strict coin."],
  ["WrongKind", "The coin's transfer hook and the kind of its config do not agree."],
  ["StrictNoBurn", "Not used any more: a strict coin can have a burn rate."],
  ["MaxWalletOutOfBounds", "The max wallet is outside the bounds the program allows."],
  ["MaxWalletIncomplete", "A max wallet needs both a share of the supply and a window."],
  ["EarlyOutOfBounds", "The early lock is outside the bounds the program allows."],
  ["EarlyIncomplete", "An early lock needs both a window and an unlock."],
  ["NotATransfer", "The coin's transfer hook runs only inside a transfer of the coin."],
  ["NotAssociatedAccount", "The coin can only go to the receiving wallet's own associated token account."],
  ["MaxWallet", "This would leave the receiving wallet above the coin's max wallet, which still runs."],
  ["EarlyLocked", "Coins bought in the early window cannot leave the wallet before the early unlock."],
  ["CreatorLocked", "The creator's locked coins cannot leave the creator's wallet before the unlock date."],
  ["HolderRecordRequired", "A buy in the early window needs the buyer's holder record: open it first."],
  ["LiquidityInMaxWalletWindow", "No liquidity can be added while the max wallet runs."],
  ["HolderNotEmpty", "The holder record still holds coins, rewards, a lock or early coins under their lock."],
  ["WrongHolder", "That is not this wallet's associated token account for this coin."],
  ["LockAboveBalance", "The creator cannot lock more than its wallet holds."],
];
/// Every error of hook_rules, by number (6000 to 6051), with a plain sentence a page can show.
export const RULES_ERRORS: Readonly<Record<number, RulesErrorInfo>> = Object.fromEntries(ERR.map(([name, message], i) => [6000 + i, { number: 6000 + i, name, message }]));
/// The error of hook_rules a failed transaction names in its logs ("Error Number: 6044" from
/// Anchor, or "custom program error: 0x179c"), or null. Only logs of hook_rules count when
/// the program's lines can be told apart; a pool error with the same number is not one.
export function rulesErrorFromLogs(logs: readonly string[]): RulesErrorInfo | null {
  const text = logs.join("\n");
  const named = /Error Code: (\w+)\. Error Number: (\d+)/.exec(text);
  if (named && RULES_ERRORS[Number(named[2])]?.name === named[1]) return RULES_ERRORS[Number(named[2])];
  const raw = /Program 3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr failed: custom program error: 0x([0-9a-f]+)/.exec(text);
  return raw ? RULES_ERRORS[parseInt(raw[1], 16)] ?? null : null;
}
