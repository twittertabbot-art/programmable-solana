// The curve launch (HOOKS.md section 2, "A pool on the curve"): a pool that prices trades
// with `reserveQuote + virtualQuote`, pays out `reserveQuote` only, refuses liquidity while
// it is open, and graduates once it holds `graduationTarget` of real quote. Everything here
// is pure: the exact arithmetic of the program (`programs/hookpool/src/math.rs`,
// `graduation`), the error table, and the numbers a page shows.
import { CURVE_GRADUATED, CURVE_NONE, CURVE_OPEN, DIRECTION, PROGRAMS } from "./constants.js";

/// The part of a pool the curve arithmetic reads. A `Pool` from `decodePool` is one.
export interface CurvePoolLike {
  reserveBase: bigint; reserveQuote: bigint; virtualQuote: bigint;
  graduationTarget: bigint; graduationFeeBps: number; curveState: number;
}

// ---- errors ------------------------------------------------------------------------------------

export interface CurveErrorInfo { number: number; name: string; message: string }
/// The pool program's curve errors (6043 to 6049), name and text as the program states them.
export const CURVE_ERRORS: Readonly<Record<number, CurveErrorInfo>> = {
  6043: { number: 6043, name: "CurveDisabled", message: "curve launches are switched off on this platform" },
  6044: { number: 6044, name: "CurveSupplyNotInPool", message: "a curve pool must hold the whole supply and the mint must be closed" },
  6045: { number: 6045, name: "CurveOpen", message: "liquidity opens at graduation" },
  6046: { number: 6046, name: "CurveHook", message: "a hook that owns the price curve cannot run a curve pool" },
  6047: { number: 6047, name: "NotOnCurve", message: "the pool is not on the curve" },
  6048: { number: 6048, name: "GraduationNotReached", message: "the pool has not reached its graduation target" },
  6049: { number: 6049, name: "CurveRealReserve", message: "a sell cannot take more than the real reserve" },
  6050: { number: 6050, name: "CurvePegged", message: "a pegged coin cannot open a pool on the curve" },
  6051: { number: 6051, name: "CurveSettingsOutOfBounds", message: "the virtual quote is above u64::MAX / 4, or the graduation target is below a thousandth of it" },
};
/// The launchpad's refusal of a pegged collectible coin on the curve (`hooklaunch` 6011),
/// which comes before the pool program's own refusal (6050) on a launch. It is a launchpad
/// number: the pool program's 6011 is `InsufficientLiquidity`.
export const CURVE_PEGGED_ERROR: CurveErrorInfo = { number: 6011, name: "CurvePegged", message: "a pegged coin cannot launch on the curve" };
/// The admin's bounds on the curve settings (`update_platform`, `CurveSettingsOutOfBounds`):
/// the virtual quote at most `u64::MAX / 4`, and, when both are on, the target at least a
/// thousandth of the virtual quote. `curveSettingsProblem` names what a pair breaks.
export const MAX_CURVE_VIRTUAL_QUOTE = (2n ** 64n - 1n) / 4n;
export function curveSettingsProblem(virtualQuote: bigint, graduationTarget: bigint): CurveErrorInfo | null {
  if (virtualQuote > MAX_CURVE_VIRTUAL_QUOTE) return CURVE_ERRORS[6051];
  if (virtualQuote > 0n && graduationTarget > 0n && graduationTarget < virtualQuote / 1000n) return CURVE_ERRORS[6051];
  return null;
}

/// A refusal the SDK sees coming on a pool on the curve, thrown before anything is sent: an
/// Error whose `code` is the program's error name and `number` its number (`CURVE_ERRORS`,
/// `CURVE_PEGGED_ERROR`). Thrown by `quoteSwap` (a sell past the real reserve), by the
/// liquidity builders on an open pool, by `graduation` below the target, and by
/// `launchInstructions` for a pegged coin or a platform with the curve off.
export class CurveRefusal extends Error {
  constructor(public readonly info: CurveErrorInfo) { super(info.message); this.name = "CurveRefusal"; }
  get code(): string { return this.info.name; }
  get number(): number { return this.info.number; }
}

/// The curve error a failed transaction names in its logs: Anchor's "Error Code: CurveOpen.
/// Error Number: 6045" line of the pool program, or its raw "custom program error: 0x179d",
/// or the launchpad's `CurvePegged`. null for anything else (a pool error that is not one of
/// the curve's, or another program's number).
export function curveErrorFromLogs(logs: readonly string[]): CurveErrorInfo | null {
  const text = logs.join("\n");
  const named = /Error Code: (\w+)\. Error Number: (\d+)/.exec(text);
  if (named) {
    const n = Number(named[2]);
    if (CURVE_ERRORS[n]?.name === named[1]) return CURVE_ERRORS[n];
    if (named[1] === CURVE_PEGGED_ERROR.name && n === CURVE_PEGGED_ERROR.number) return CURVE_PEGGED_ERROR;
    return null;
  }
  const pool = new RegExp("Program " + PROGRAMS.hookpool.toBase58() + " failed: custom program error: 0x([0-9a-f]+)").exec(text);
  if (pool) return CURVE_ERRORS[parseInt(pool[1], 16)] ?? null;
  const launch = new RegExp("Program " + PROGRAMS.hooklaunch.toBase58() + " failed: custom program error: 0x([0-9a-f]+)").exec(text);
  if (launch && parseInt(launch[1], 16) === CURVE_PEGGED_ERROR.number) return CURVE_PEGGED_ERROR;
  return null;
}

// ---- the pool's state ------------------------------------------------------------------------

/// The quote reserve the price is made of: `reserveQuote + virtualQuote`. On a seeded pool
/// and after graduation it is the real reserve. Port of `PoolData::effective_quote`.
export function effectiveQuote(pool: { reserveQuote: bigint; virtualQuote: bigint }): bigint {
  return pool.reserveQuote + pool.virtualQuote;
}
/// Is the pool on the curve now (`curveState === CURVE_OPEN`)? Port of `PoolData::on_curve`.
/// Such a pool refuses liquidity until it graduates.
export function isOnCurve(pool: { curveState: number }): boolean {
  return pool.curveState === CURVE_OPEN;
}
/// The three states in words, as the API and the site show them.
export type CurveStateName = "none" | "open" | "graduated";
export function curveStateName(state: number): CurveStateName {
  return state === CURVE_OPEN ? "open" : state === CURVE_GRADUATED ? "graduated" : "none";
}

/// The price of a pool as a number, in quote units per base unit at the given decimals:
/// `(reserveQuote + virtualQuote) / reserveBase`. 0 for an empty base reserve.
export function priceOf(reserveBase: bigint, reserveQuote: bigint, virtualQuote: bigint, baseDecimals: number, quoteDecimals: number): number {
  if (reserveBase === 0n) return 0;
  return (Number(reserveQuote + virtualQuote) / Number(reserveBase)) * 10 ** (baseDecimals - quoteDecimals);
}

// ---- graduation ------------------------------------------------------------------------------

/// What `graduate` does to a pool's reserves, as numbers (all raw units).
export interface Graduation {
  /// The platform's share: `graduationTarget * graduationFeeBps / 10_000`, floored, and at
  /// most `reserveQuote - 1`. It leaves the reserve for `protocolFeesQuote`.
  fee: bigint;
  /// The real quote reserve after the fee.
  reserveQuoteAfter: bigint;
  /// The base reserve that keeps the price without the virtual quote.
  reserveBaseAfter: bigint;
  /// Coins burned from the pool's vault: `reserveBase - reserveBaseAfter`.
  burned: bigint;
}

/// Exact port of `hookpool::math::graduation` (HOOKS.md section 2):
///
///   fee  = min(graduationTarget * graduationFeeBps / 10_000, reserveQuote - 1)   (floor)
///   R2   = reserveQuote - fee
///   B2   = floor(R2 * reserveBase / (reserveQuote + virtualQuote))
///   burn = reserveBase - B2
///
/// The price after, `R2 / B2`, is never below the price before, `(R + V) / B`, and above it
/// by less than one unit of the coin. Throws `CurveRefusal` (`GraduationNotReached`) below
/// the target and an Error (`InsufficientLiquidity`) when nothing would be left, which the
/// platform's settings make unreachable.
export function graduation(reserveBase: bigint, reserveQuote: bigint, virtualQuote: bigint, graduationTarget: bigint, graduationFeeBps: number): Graduation {
  if (reserveQuote < graduationTarget) throw new CurveRefusal(CURVE_ERRORS[6048]);
  if (reserveQuote <= 0n || reserveBase <= 0n) throw new Error("InsufficientLiquidity: a pool with an empty reserve cannot graduate");
  const g = graduationFormula(reserveBase, reserveQuote, virtualQuote, graduationTarget, graduationFeeBps);
  if (g.reserveBaseAfter <= 0n) throw new Error("InsufficientLiquidity: graduation would leave no coin in the pool");
  return g;
}
/// The arithmetic of `graduation` alone, without the program's two requirements: what a
/// graduation at these reserves would do, whether or not the chain allows it now. An empty
/// quote reserve burns everything (the price `V / B` with no real quote cannot be kept).
function graduationFormula(reserveBase: bigint, reserveQuote: bigint, virtualQuote: bigint, graduationTarget: bigint, graduationFeeBps: number): Graduation {
  if (reserveQuote <= 0n || reserveBase <= 0n) return { fee: 0n, reserveQuoteAfter: reserveQuote, reserveBaseAfter: 0n, burned: reserveBase };
  const wanted = (graduationTarget * BigInt(graduationFeeBps)) / 10_000n;
  const fee = wanted < reserveQuote - 1n ? wanted : reserveQuote - 1n;
  const reserveQuoteAfter = reserveQuote - fee;
  const reserveBaseAfter = (reserveQuoteAfter * reserveBase) / (reserveQuote + virtualQuote);
  return { fee, reserveQuoteAfter, reserveBaseAfter, burned: reserveBase - reserveBaseAfter };
}

/// Is the pool on the curve with its real reserve at or past the target, so that anyone may
/// graduate it now? Then every trade the SDK builds sends `graduate` FIRST and is quoted on
/// the pool as graduation leaves it (`poolAfterGraduation`): our own transaction runs on
/// the graduated pool whoever graduates first, so the quote is exact.
export function readyToGraduate(pool: CurvePoolLike): boolean {
  return pool.curveState === CURVE_OPEN && pool.reserveQuote >= pool.graduationTarget;
}

/// What `graduate` does to this pool NOW: exactly the program's graduation when the pool is
/// ready to graduate (`allowed: true`, see `readyToGraduate`). Otherwise the chain does
/// nothing (a pool below its target, a graduated pool) or refuses (a seeded pool):
/// `allowed: false`, nothing burned, the reserves as they are. With no fee the burn is
/// `reserveBase * virtualQuote / (reserveQuote + virtualQuote)` (to one unit of rounding),
/// so a coin that graduates later than its target burns less than one graduated at it.
export function graduationIfNow(pool: CurvePoolLike): Graduation & { allowed: boolean } {
  if (!readyToGraduate(pool)) return { fee: 0n, reserveQuoteAfter: pool.reserveQuote, reserveBaseAfter: pool.reserveBase, burned: 0n, allowed: false };
  return { ...graduation(pool.reserveBase, pool.reserveQuote, pool.virtualQuote, pool.graduationTarget, pool.graduationFeeBps), allowed: true };
}

/// The pool as `graduate` leaves it when it is ready to graduate (`readyToGraduate`): the
/// coins burned, the fee moved out of the reserve into `protocolFeesQuote` (when the object
/// carries that counter), `virtualQuote` and `graduationTarget` 0, `curveState`
/// `CURVE_GRADUATED`. Any other pool comes back as it is. Quote a trade on a pool that
/// stands past its target on this, not on the curve: `quoteLocal` does.
export function poolAfterGraduation<T extends CurvePoolLike>(pool: T): T {
  if (!readyToGraduate(pool)) return pool;
  const g = graduationIfNow(pool);
  const out: T = { ...pool, reserveBase: g.reserveBaseAfter, reserveQuote: g.reserveQuoteAfter, virtualQuote: 0n, graduationTarget: 0n, curveState: CURVE_GRADUATED };
  const fees = (pool as unknown as { protocolFeesQuote?: unknown }).protocolFeesQuote;
  if (typeof fees === "bigint") (out as unknown as { protocolFeesQuote: bigint }).protocolFeesQuote = fees + g.fee;
  return out;
}

/// DEPRECATED, kept only so that callers written for the earlier rule keep running: it
/// returns `minAmountOut` unchanged. Nothing in the SDK lowers a floor. A floor is the
/// caller's slippage on the quote's `amountOut` (see `quoteLocal`: on a pool ready to
/// graduate that quote is already the fill on the graduated pool). To be removed.
export function floorForGraduation(minAmountOut: bigint, _quote?: unknown): bigint {
  return minAmountOut;
}

/// What graduation does to this pool. At or past the target it is exactly what `graduate`
/// does now (`forecast: false`). Below the target it is a forecast (`forecast: true`): the
/// pool walked along the curve without fees to the moment its real reserve equals the
/// target (`B = floor((R + V) * B / (T + V))`), and graduated there. A seeded pool or a pool
/// that already graduated has nothing to burn: every field is 0n and `forecast` is false.
export function graduationBurn(pool: CurvePoolLike): Graduation & { forecast: boolean } {
  if (pool.curveState !== CURVE_OPEN) return { fee: 0n, reserveQuoteAfter: pool.reserveQuote, reserveBaseAfter: pool.reserveBase, burned: 0n, forecast: false };
  if (pool.reserveQuote >= pool.graduationTarget) return { ...graduation(pool.reserveBase, pool.reserveQuote, pool.virtualQuote, pool.graduationTarget, pool.graduationFeeBps), forecast: false };
  return { ...graduationAtTarget(pool), forecast: true };
}

/// A graduation at EXACTLY the target, along the fee-less curve from the pool as it stands
/// (`B = floor((R + V) * B / (T + V))`, then the program's formula at `T`): the "about 6.8%
/// of the supply" figure with the default settings. Works below and past the target.
function graduationAtTarget(pool: CurvePoolLike): Graduation {
  const target = pool.graduationTarget;
  const baseAtTarget = ((pool.reserveQuote + pool.virtualQuote) * pool.reserveBase) / (target + pool.virtualQuote);
  if (baseAtTarget <= 0n || target <= 0n) return { fee: 0n, reserveQuoteAfter: target, reserveBaseAfter: 0n, burned: baseAtTarget, };
  return graduationFormula(baseAtTarget, target, pool.virtualQuote, target, pool.graduationFeeBps);
}

/// Does a trade graduate the pool in its transaction? True on an open curve pool when the
/// pool is ready to graduate before the trade (`readyToGraduate`: a buy or a sell; the
/// transaction sends `graduate` FIRST), or when the trade is a buy whose REAL quote reserve
/// after it (`reserveInAfter` of its quote on the curve) reaches the target (the buy that
/// crosses the target; `graduate` goes AFTER the swap). A sell on a pool below its target
/// never does. `quoteLocal` sets `graduates` with it, and `graduateFirst` for the first case.
export function willGraduate(pool: CurvePoolLike, direction: number, quote: { reserveInAfter: bigint; reserveOutAfter: bigint }): boolean {
  if (pool.curveState !== CURVE_OPEN) return false;
  if (readyToGraduate(pool)) return true;
  return direction === DIRECTION.BUY && quote.reserveInAfter >= pool.graduationTarget;
}

// ---- a first buy that graduates the coin at launch ---------------------------------------------

const feeUp = (amount: bigint, bps: number): bigint => (bps <= 0 || amount <= 0n ? 0n : (amount * BigInt(bps) + 9_999n) / 10_000n);

/// The hook fee, in basis points, that a curve launch counts its first buy with when it decides
/// whether the coin graduates in the launch transaction (`launchInstructions`,
/// `curve.graduatesAtLaunch`). 0 without a hook ("none" or no template) and for the launch guard
/// (its fee is a pool fee, which stays in the pool). A tax or buyback coin: its own buy rate. Any
/// other hook (rules, collectible, custom): the platform's cap, since its fee is not known here,
/// so `graduate` is never added to a first buy that may fall short. Clamped to the cap, as the
/// pool clamps it.
export function firstBuyHookFeeBps(template: string | undefined, rates: { tax?: { buyBps: number }; buyback?: { buyBps: number } }, maxHookFeeBps: number): number {
  const cap = Math.max(0, Math.floor(Number(maxHookFeeBps) || 0));
  // a rate that is not a number yet (a form being typed) counts at the cap
  const own = (bps: number | undefined) => (typeof bps === "number" && Number.isFinite(bps) ? Math.min(Math.max(0, Math.floor(bps)), cap) : cap);
  if (!template || template === "none" || template === "launch_guard") return 0;
  if (template === "tax" && rates.tax) return own(rates.tax.buyBps);
  if (template === "buyback" && rates.buyback) return own(rates.buyback.buyBps);
  return cap;
}

/// What a curve launch's first buy of `devBuyQuote` leaves in the pool as real quote: the buy
/// less the protocol fee and the hook fee taken from what is left after it (the program's
/// order); the pool fee stays in the pool. The coin graduates at launch when this reaches the
/// graduation target (`firstBuyGraduates`).
export function firstBuyRaised(devBuyQuote: bigint, protocolFeeBps: number, hookFeeBps: number): bigint {
  if (devBuyQuote <= 0n) return 0n;
  const afterProtocol = devBuyQuote - feeUp(devBuyQuote, protocolFeeBps);
  return afterProtocol - feeUp(afterProtocol, hookFeeBps);
}

/// Does a curve launch's first buy reach the platform's graduation target on its own? Then the
/// launch transaction ends with `graduate`. `hookFeeBps` from `firstBuyHookFeeBps`.
export function firstBuyGraduates(devBuyQuote: bigint, platform: { protocolFeeBps: number; curveGraduationTarget: bigint }, hookFeeBps: number): boolean {
  return devBuyQuote > 0n && platform.curveGraduationTarget > 0n && firstBuyRaised(devBuyQuote, platform.protocolFeeBps, hookFeeBps) >= platform.curveGraduationTarget;
}

// ---- progress, for a page ----------------------------------------------------------------------

export interface CurveProgress {
  /// "none" (a seeded pool), "open", "graduated".
  state: CurveStateName;
  /// Real quote in the pool (what the buyers put in), and the target it graduates at (0n
  /// once graduated or on a seeded pool).
  raised: bigint; target: bigint;
  /// `raised / target` in basis points, at most 10_000 (a pool past its target reads 10_000
  /// until somebody sends `graduate`); 10_000 once graduated, 0 on a seeded pool.
  raisedBps: number;
  /// The share of the supply that left the pool, in basis points: `(supply - reserveBase) /
  /// supply`. While the curve is open the supply is the one the coin was launched with.
  soldBps: number;
  /// The market cap at the opening of the curve, in quote units: the virtual quote (the
  /// price then was `virtualQuote / supply`). null once graduated (the pool no longer
  /// carries it; the `CurveOpened` event does) and on a seeded pool.
  startMarketCapQuote: bigint | null;
  /// The market cap now: the price (effective quote over base reserve) times the supply.
  marketCapQuote: bigint;
  /// `virtualQuote` counted in the price now (0n unless open).
  virtualQuote: bigint;
  /// What graduation burns, as best known now (`graduationBurn`): at or past the target the
  /// exact burn of a `graduate` sent now (a coin graduated later than its target burns
  /// less); below the target the burn at the target, the earliest it can graduate (equal to
  /// `burnAtTarget`). 0n unless open.
  burnIfGraduatedNow: bigint;
  /// What a graduation at exactly the target burns, along the fee-less curve from the pool
  /// as it stands: the figure to quote in words ("about 6.8% of the supply" with the
  /// default settings and a full supply in the pool). 0n unless open.
  burnAtTarget: bigint;
  graduated: boolean; open: boolean;
}

/// The numbers a coin page shows for the curve. `supply` is the coin's supply (read it from
/// the mint: `client.curveProgress(pool)` does), which is the pool's starting base reserve
/// while the curve is open.
export function curveProgress(pool: CurvePoolLike, supply: bigint): CurveProgress {
  const state = curveStateName(pool.curveState);
  const open = state === "open", graduated = state === "graduated";
  const effective = pool.reserveQuote + pool.virtualQuote;
  const raised = state === "none" ? 0n : pool.reserveQuote;
  const target = open ? pool.graduationTarget : 0n;
  const raisedBps = graduated ? 10_000 : open && target > 0n ? Number(raised >= target ? 10_000n : (raised * 10_000n) / target) : 0;
  const sold = supply > pool.reserveBase ? supply - pool.reserveBase : 0n;
  const soldBps = supply > 0n ? Number((sold * 10_000n) / supply) : 0;
  const marketCapQuote = pool.reserveBase > 0n ? (effective * supply) / pool.reserveBase : 0n;
  return {
    state, raised, target, raisedBps, soldBps,
    startMarketCapQuote: open ? pool.virtualQuote : null, marketCapQuote, virtualQuote: open ? pool.virtualQuote : 0n,
    burnIfGraduatedNow: open ? graduationBurn(pool).burned : 0n,
    burnAtTarget: open ? graduationAtTarget(pool).burned : 0n,
    graduated, open,
  };
}

/// Tells a pool's kind from its state byte alone: `CURVE_NONE` is a seeded pool.
export function isSeeded(pool: { curveState: number }): boolean { return pool.curveState === CURVE_NONE; }
