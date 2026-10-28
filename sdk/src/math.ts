// Exact port of programs/hookpool/src/math.rs. Same rounding, same order, bigint only.
import { BPS, DIRECTION } from "./constants.js";
import { CURVE_ERRORS, CurveRefusal } from "./curve.js";

export interface SwapQuote {
  protocolFee: bigint;
  hookFee: bigint;
  lpFee: bigint;
  feeBpsApplied: number;
  netIn: bigint;
  amountOutGross: bigint;
  amountOut: bigint;
  /// The REAL reserves after the trade (the virtual quote of a pool on the curve is not in
  /// them): what the pool account will read.
  reserveInAfter: bigint;
  reserveOutAfter: bigint;
  quoteVolume: bigint;
  /// Set by `client.quoteLocal` only: the transaction of this trade graduates an open curve
  /// pool (`willGraduate`), and `swapInstructions` puts `graduate` in it.
  graduates?: boolean;
  /// Set by `client.quoteLocal` when `graduates` is true. `true`: the pool stands at or past
  /// its target before the trade, the transaction sends `graduate` BEFORE the swap, and this
  /// quote is made on the pool as graduation leaves it (`poolAfterGraduation`): exact
  /// whoever graduates first. `false`: a buy that crosses the target from below, quoted on
  /// the curve, with `graduate` AFTER the swap; somebody who moves the pool first is a price
  /// move like any other, and the caller's slippage on this quote is the protection.
  graduateFirst?: boolean;
  /// DEPRECATED, equal to `amountOut`: the floor of a swap is the caller's slippage on
  /// `amountOut`, never lower. Kept for callers of the earlier rule; to be removed.
  amountOutFloor?: bigint;
  /// Price impact in bps versus the pre-trade spot price, for display.
  impactBps: number;
  /// Set by `client.quoteLocal` only: the most this trade can pay out when it lands later
  /// than the slot it was quoted for. Inside a window where the pool fee falls every slot
  /// (a sniper fee, a launch guard) it is the quote at the pool's normal fee; otherwise it
  /// equals `amountOut`. A rule on the receiver's balance after the trade (the max wallet
  /// of a strict coin) is checked against this number, not against `amountOut`.
  amountOutCeiling?: bigint;
}

function divCeil(a: bigint, b: bigint) { return (a + b - 1n) / b; }
export function feeCeil(amount: bigint, bps: number): bigint {
  if (bps === 0 || amount === 0n) return 0n;
  return divCeil(amount * BigInt(bps), BPS);
}
export function constantProductOut(netIn: bigint, rIn: bigint, rOut: bigint): bigint {
  if (rIn <= 0n || rOut <= 0n) throw new Error("not enough liquidity");
  return (rOut * netIn) / (rIn + netIn);
}

export interface QuoteParams {
  direction: number;
  amountIn: bigint;
  reserveBase: bigint;
  /// The REAL quote reserve (`pool.reserveQuote`).
  reserveQuote: bigint;
  /// The virtual quote of a pool on the curve (`pool.virtualQuote`; 0n, the default, on a
  /// seeded pool and after graduation). It is counted in the price, never paid out.
  virtualQuote?: bigint;
  lpFeeBps: number;
  protocolFeeBps: number;
  hookFeeBps?: number;
  feeOverrideBps?: number | null;
  curveOverride?: bigint | null;
}

/// The whole swap arithmetic of the program, in its order. On a pool on the curve the
/// constant product runs on `reserveQuote + virtualQuote`; the reserves after are the real
/// ones; a sell whose gross output would pass the real reserve throws a `CurveRefusal`
/// (`CurveRealReserve`, 6049), which the chain refuses the same way. With the whole supply
/// in the pool at its opening that sell cannot be built from coins that exist (HOOKS.md
/// section 2), so the throw is a belt.
export function quoteSwap(p: QuoteParams): SwapQuote {
  if (p.amountIn <= 0n) throw new Error("amount must be greater than zero");
  const isBuy = p.direction === DIRECTION.BUY;
  const virtualQuote = p.virtualQuote ?? 0n;
  const effectiveQuote = p.reserveQuote + virtualQuote;
  // the reserves the price is made of, and the reserves that are really there
  const [rIn, rOut, realIn, realOut] = isBuy ? [effectiveQuote, p.reserveBase, p.reserveQuote, p.reserveBase] : [p.reserveBase, effectiveQuote, p.reserveBase, p.reserveQuote];
  const hookBps = p.hookFeeBps ?? 0;
  const protocolFee = feeCeil(p.amountIn, p.protocolFeeBps);
  const afterProtocol = p.amountIn - protocolFee;
  const hookFeeIn = isBuy ? feeCeil(afterProtocol, hookBps) : 0n;
  const afterHook = afterProtocol - hookFeeIn;
  const feeBpsApplied = p.feeOverrideBps ?? p.lpFeeBps;
  const lpFee = feeCeil(afterHook, feeBpsApplied);
  const netIn = afterHook - lpFee;
  if (netIn <= 0n) throw new Error("amount too small");
  const amountOutGross = p.curveOverride ?? constantProductOut(netIn, rIn, rOut);
  // a trade whose output rounds to zero is a dust trade (the program's ZeroAmount); a hook's
  // zero or an output at or past the reserve is the hook's curve answer (HookCurveInvalid)
  if (amountOutGross <= 0n && p.curveOverride === undefined) throw new Error("amount too small");
  if (amountOutGross <= 0n || amountOutGross >= rOut) throw new Error("not enough liquidity");
  // the belt of the curve: only the real reserve is ever paid out (implied on a seeded pool)
  if (amountOutGross > realOut) throw new CurveRefusal(CURVE_ERRORS[6049]);
  const hookFeeOut = isBuy ? 0n : feeCeil(amountOutGross, hookBps);
  const amountOut = amountOutGross - hookFeeOut;
  if (amountOut <= 0n) throw new Error("amount too small");
  // spot price before: rOut / rIn; effective: amountOutGross / netIn
  const impactBps = rIn > 0n && netIn > 0n
    ? Number(10_000n - (amountOutGross * rIn * 10_000n) / (netIn * rOut))
    : 0;
  return {
    protocolFee,
    hookFee: hookFeeIn + hookFeeOut,
    lpFee,
    feeBpsApplied,
    netIn,
    amountOutGross,
    amountOut,
    reserveInAfter: realIn + netIn + lpFee,
    reserveOutAfter: realOut - amountOutGross,
    quoteVolume: isBuy ? p.amountIn : amountOutGross,
    impactBps: Math.max(0, impactBps),
  };
}

/// Port of hook_launch_guard::guard_fee.
export function guardFee(slot: bigint, startSlot: bigint, guardSlots: bigint, startFeeBps: number, baseFeeBps: number): number | null {
  if (startFeeBps <= baseFeeBps || guardSlots === 0n || startSlot === 0n) return null;
  const elapsed = slot > startSlot ? slot - startSlot : 0n;
  if (elapsed >= guardSlots) return null;
  const span = BigInt(startFeeBps - baseFeeBps);
  const decayed = (span * elapsed) / guardSlots;
  return startFeeBps - Number(decayed);
}

// ---- buying back through the pool (HOOKS.md section 7) -------------------------------------
// The rules of `hook_buyback::execute_buyback` and of `hook_rules::run_burn`, which both
// follow `burn_step` of the interface crate. Everything about them is in this block.

/// A buy needs an observation of the pool at least this many slots old (about ten
/// seconds). Every call that the chain accepts leaves a fresh observation, so two buys
/// are at least this far apart.
export const BURN_INTERVAL_SLOTS = 25n;
/// The most and the least the cap of one run can be, in basis points of the pool's quote
/// reserve.
export const MAX_BURN_CAP_BPS = 50;
export const MIN_BURN_CAP_BPS = 1;
/// The ceiling of a buyback run, as a bigint. The cap of a given pool is `burnCapBps`,
/// which follows the pool's fees and is never above this.
export const MAX_BUYBACK_BPS = 50n;
/// The most a buyback coin's minimum (`minQuote`) may be, in raw units of the quote token:
/// 1 SOL. The program refuses a config above it (`MinQuoteTooHigh`).
export const MAX_BUYBACK_MIN_QUOTE = 1_000_000_000n;

/// Port of `hookpool_interface::burn_cap_bps`: the share of the pool's quote reserve, in
/// basis points, that one run may spend. `buyFeeBps` and `sellFeeBps` are the hook fees a
/// buy and a sell ALWAYS pay, each already capped by the platform's `maxHookFeeBps`.
export function burnCapBps(protocolFeeBps: number, lpFeeBps: number, buyFeeBps: number, sellFeeBps: number): number {
  const sure = protocolFeeBps + buyFeeBps + sellFeeBps;
  const soft = protocolFeeBps + 2 * lpFeeBps;
  const cap = Math.floor((sure + Math.min(sure, soft)) / 4);
  return Math.min(MAX_BURN_CAP_BPS, Math.max(MIN_BURN_CAP_BPS, cap));
}
/// The cap of one buyback run on a pool of the buyback template.
export function buybackCapBps(cfg: { buyBps: number; sellBps: number }, platform: { protocolFeeBps: number; maxHookFeeBps: number }, lpFeeBps: number): number {
  return burnCapBps(platform.protocolFeeBps, lpFeeBps, Math.min(cfg.buyBps, platform.maxHookFeeBps), Math.min(cfg.sellBps, platform.maxHookFeeBps));
}
/// What one buy spends: the pot (the buyback treasury, or the burn pot of a rules coin),
/// up to `capBps` of `depth`, and at least one unit. `depth` is the SMALLER of the pool's
/// quote reserve now and the observed one (`burnStep` works it out). `capBps` comes from
/// `burnCapBps` (or `buybackCapBps`, `rulesBurnCapBps`). It has no default: the cap
/// depends on the pool's fees. On a pool on the curve the depth is the EFFECTIVE quote,
/// `reserveQuote + virtualQuote`, as the programs measure it (the cap paces the price
/// impact, which depends on the effective depth); the observation stores effective values
/// too. Every caller in the client passes effective values.
export function buybackSpend(pot: bigint, depth: bigint, capBps: number | bigint): bigint {
  if (capBps === undefined || capBps === null) throw new Error("buybackSpend needs the cap of the pool in basis points (burnCapBps)");
  const cap = (depth * BigInt(capBps)) / 10_000n;
  const limit = cap > 1n ? cap : 1n;
  return pot < limit ? pot : limit;
}

/// The pool as a buyback or a burn last recorded it: the slot and the two reserves. It is
/// written only by the buy instruction itself. "No observation yet" is one with a zero
/// reserve. `reserveQuote` is the EFFECTIVE quote of the pool at the observation
/// (`reserveQuote + virtualQuote`): on a seeded pool the real one, on a pool on the curve
/// the real one plus the virtual quote. So an observation taken on the curve still compares
/// right after graduation, which keeps the price.
export interface BurnObservation { slot: bigint; reserveBase: bigint; reserveQuote: bigint }
/// Port of `hookpool_interface::burn_price_fell`: does a trade that is about to start
/// against these reserves start BELOW the observed price? When it does, the hook lowers
/// the observation (`burnLowered`) and leaves its slot as it is, so an observation never
/// stands above a price a trade started at. The config a client reads already carries
/// this for every trade so far.
export function burnPriceFell(obs: BurnObservation, reserveBase: bigint, reserveQuote: bigint): boolean {
  return obs.reserveBase !== 0n && obs.reserveQuote !== 0n && reserveQuote * obs.reserveBase < obs.reserveQuote * reserveBase;
}
/// Port of `hookpool_interface::burn_lowered`: what the observation becomes when a trade
/// starts against these reserves, or `null` when that trade leaves it alone (it does not
/// start below the observed price, or there is no observation yet).
///
///   quote = min(reserveQuote, observed quote)
///   base  = ceil(quote * reserveBase / reserveQuote)
///
/// The lowering moves the observed PRICE to the one the trade starts at and never raises
/// the observed DEPTH, which is what the cap of a buy is measured on. So liquidity added
/// after an observation does not make the next buy larger. The base side is rounded up:
/// the stored price is never above the price the trade started at, and a second trade at
/// the same price changes nothing more. When the pool is not deeper than the observation
/// the result is the pool's own two reserves. The slot is kept.
export function burnLowered(obs: BurnObservation, reserveBase: bigint, reserveQuote: bigint): BurnObservation | null {
  if (reserveBase === 0n || reserveQuote === 0n || !burnPriceFell(obs, reserveBase, reserveQuote)) return null;
  const quote = reserveQuote < obs.reserveQuote ? reserveQuote : obs.reserveQuote;
  const base = (quote * reserveBase + reserveQuote - 1n) / reserveQuote;
  return { slot: obs.slot, reserveBase: base, reserveQuote: quote };
}
/// What a buy instruction that returned Ok did: the first byte of its return data and the
/// `outcome` field of its event.
export const BURN_OUTCOME = { OBSERVED: 1, WAITED: 2, BOUGHT: 3 } as const;
/// By how much the price may be above the observed price for a buy to go ahead, in basis
/// points: twice the cap.
export function burnToleranceBps(capBps: number): number { return 2 * capBps; }
/// What a buy instruction does when somebody calls it in `slot`:
///   "observe"  there is no observation yet: it records the reserves and buys nothing
///   "tooSoon"  the observation is younger than `BURN_INTERVAL_SLOTS`: the chain refuses
///              the call and writes nothing; `dueSlot` is the first slot it accepts one
///   "wait"     the price is above the observed one by more than the tolerance: it
///              records the reserves again and buys nothing
///   "buy"      it buys: `maxSpend` is the cap of this buy, `spend` what it spends, which
///              is the pot when the pot is smaller
export type BurnStep = { step: "observe" } | { step: "tooSoon"; dueSlot: bigint } | { step: "wait" } | { step: "buy"; maxSpend: bigint; spend: bigint };
/// Port of `hookpool_interface::burn_step`, the whole rule of a buyback or a burn in one
/// function: what a call sent in `slot` does.
///
/// `obs` is the observation in the hook's config (`obsSlot`, `obsReserveBase`,
/// `obsReserveQuote`), the two reserves are the pool's now (`reserveQuote` EFFECTIVE:
/// `pool.reserveQuote + pool.virtualQuote`, which is the real reserve on a seeded pool),
/// `capBps` is the pool's cap (`buybackCapBps`, `rulesBurnCapBps`), and `pot` is what waits
/// to be spent: the buyback treasury, or the burn pot of a rules coin after settling
/// (`rulesState(pool).burnPot`). Without `pot` a buy reports its cap as `spend`.
export function burnStep(obs: BurnObservation, reserveBase: bigint, reserveQuote: bigint, slot: bigint, capBps: number, pot?: bigint): BurnStep {
  if (obs.reserveBase === 0n || obs.reserveQuote === 0n) return { step: "observe" };
  const dueSlot = obs.slot + BURN_INTERVAL_SLOTS;
  if (slot < dueSlot) return { step: "tooSoon", dueSlot };
  // price now > observed price * (1 + tolerance), compared by cross-multiplying
  const now = reserveQuote * obs.reserveBase;
  const then = obs.reserveQuote * reserveBase;
  const tol = BigInt(burnToleranceBps(capBps));
  const slack = (then / 10_000n) * tol + ((then % 10_000n) * tol) / 10_000n;
  if (now > then + slack) return { step: "wait" };
  const depth = reserveQuote < obs.reserveQuote ? reserveQuote : obs.reserveQuote;
  const cap = (depth * BigInt(capBps)) / 10_000n;
  const maxSpend = cap > 1n ? cap : 1n;
  return { step: "buy", maxSpend, spend: pot !== undefined && pot < maxSpend ? pot : maxSpend };
}

export function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = BigInt(Math.floor(Math.sqrt(Number(v))));
  while (x * x > v) x--;
  while ((x + 1n) * (x + 1n) <= v) x++;
  return x;
}

/// LP minted to the creator at the creation of a SEEDED pool (`MINIMUM_LIQUIDITY` stays
/// in the pool).
export function initialLp(baseAmount: bigint, quoteAmount: bigint): bigint {
  return isqrt(baseAmount * quoteAmount) - 1000n;
}
/// The LP of a pool on the curve: `isqrt(baseAmount * virtualQuote)`, all of it minted into
/// the pool's lock account at creation, none to anyone (`create_curve_pool`). The program
/// requires it above `MINIMUM_LIQUIDITY`.
export function curveInitialLp(baseAmount: bigint, virtualQuote: bigint): bigint {
  return isqrt(baseAmount * virtualQuote);
}

export function mulDivCeil(a: bigint, b: bigint, d: bigint) { return divCeil(a * b, d); }
export function mulDivFloor(a: bigint, b: bigint, d: bigint) { return (a * b) / d; }
