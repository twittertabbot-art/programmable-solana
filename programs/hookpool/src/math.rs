//! Pure math. No accounts here, so every branch is unit-testable off-chain.

use crate::errors::HookpoolError;
use anchor_lang::prelude::*;
use hookpool_interface::{DIRECTION_BUY, DIRECTION_SELL};

pub const BPS_DENOM: u128 = 10_000;

/// ceil(amount * bps / 10_000)
pub fn fee_ceil(amount: u64, bps: u16) -> Result<u64> {
    if bps == 0 || amount == 0 {
        return Ok(0);
    }
    let num = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(HookpoolError::MathOverflow)?;
    let fee = num.div_ceil(BPS_DENOM);
    u64::try_from(fee).map_err(|_| HookpoolError::MathOverflow.into())
}

pub fn mul_div_floor(a: u64, b: u64, d: u64) -> Result<u64> {
    require!(d > 0, HookpoolError::MathOverflow);
    let v = (a as u128)
        .checked_mul(b as u128)
        .ok_or(HookpoolError::MathOverflow)?
        / (d as u128);
    u64::try_from(v).map_err(|_| HookpoolError::MathOverflow.into())
}

pub fn mul_div_ceil(a: u64, b: u64, d: u64) -> Result<u64> {
    require!(d > 0, HookpoolError::MathOverflow);
    let v = (a as u128)
        .checked_mul(b as u128)
        .ok_or(HookpoolError::MathOverflow)?
        .div_ceil(d as u128);
    u64::try_from(v).map_err(|_| HookpoolError::MathOverflow.into())
}

/// Constant product output: r_out * net_in / (r_in + net_in), floored.
pub fn constant_product_out(net_in: u64, r_in: u64, r_out: u64) -> Result<u64> {
    require!(r_in > 0 && r_out > 0, HookpoolError::InsufficientLiquidity);
    let denom = (r_in as u128)
        .checked_add(net_in as u128)
        .ok_or(HookpoolError::MathOverflow)?;
    let num = (r_out as u128)
        .checked_mul(net_in as u128)
        .ok_or(HookpoolError::MathOverflow)?;
    u64::try_from(num / denom).map_err(|_| HookpoolError::MathOverflow.into())
}

pub fn isqrt_u128(v: u128) -> u128 {
    v.isqrt()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SwapQuote {
    pub protocol_fee: u64,
    pub hook_fee: u64,
    pub lp_fee: u64,
    pub fee_bps_applied: u16,
    pub net_in: u64,
    pub amount_out_gross: u64,
    pub amount_out: u64,
    /// The REAL reserves after the swap (the virtual quote is not in them).
    pub reserve_in_after: u64,
    pub reserve_out_after: u64,
    /// Quote-denominated volume of this swap, for stats.
    pub quote_volume: u64,
}

/// The whole swap order of operations from HOOKS.md section 2, in one place.
/// `curve_override` is the hook's `amount_out_gross` when it owns the curve.
///
/// `virtual_quote` is the quote a pool on the curve counts in its price without holding
/// it (0 on a seeded pool). The constant product runs on `reserve_quote + virtual_quote`;
/// what the pool PAYS comes from `reserve_quote` alone, so a sell's gross output must not
/// pass the real reserve (`CurveRealReserve`). With the whole supply in the pool at the
/// start and nothing but trades moving the reserves that bound is never reached: the
/// product `(R + V) * B` only grows with fees and rounding, and the coins outside the pool
/// are at most `supply - B`, so a sell of all of them stops short of `R`. The check stays
/// as a belt. `reserve_in_after` and `reserve_out_after` are real reserves.
#[allow(clippy::too_many_arguments)]
pub fn quote_swap(
    direction: u8,
    amount_in: u64,
    reserve_base: u64,
    reserve_quote: u64,
    virtual_quote: u64,
    lp_fee_bps: u16,
    protocol_fee_bps: u16,
    hook_fee_bps: u16,
    fee_override_bps: Option<u16>,
    curve_override: Option<u64>,
) -> Result<SwapQuote> {
    require!(amount_in > 0, HookpoolError::ZeroAmount);
    require!(
        direction == DIRECTION_BUY || direction == DIRECTION_SELL,
        HookpoolError::BadDirection
    );
    let is_buy = direction == DIRECTION_BUY;
    let effective_quote = reserve_quote
        .checked_add(virtual_quote)
        .ok_or(HookpoolError::MathOverflow)?;
    // the reserves the price is made of, and the reserves that are really there
    let (r_in, r_out, real_in, real_out) = if is_buy {
        (effective_quote, reserve_base, reserve_quote, reserve_base)
    } else {
        (reserve_base, effective_quote, reserve_base, reserve_quote)
    };

    let protocol_fee = fee_ceil(amount_in, protocol_fee_bps)?;
    let after_protocol = amount_in
        .checked_sub(protocol_fee)
        .ok_or(HookpoolError::MathOverflow)?;

    let hook_fee_in = if is_buy { fee_ceil(after_protocol, hook_fee_bps)? } else { 0 };
    let after_hook = after_protocol
        .checked_sub(hook_fee_in)
        .ok_or(HookpoolError::MathOverflow)?;

    let fee_bps_applied = fee_override_bps.unwrap_or(lp_fee_bps);
    let lp_fee = fee_ceil(after_hook, fee_bps_applied)?;
    let net_in = after_hook
        .checked_sub(lp_fee)
        .ok_or(HookpoolError::MathOverflow)?;
    require!(net_in > 0, HookpoolError::ZeroAmount);

    let amount_out_gross = match curve_override {
        Some(v) => {
            // a hook's answer of zero is the hook's fault
            require!(v > 0, HookpoolError::HookCurveInvalid);
            v
        }
        None => {
            // the pool's own curve: a trade too small to pay out one unit is a dust trade
            let v = constant_product_out(net_in, r_in, r_out)?;
            require!(v > 0, HookpoolError::ZeroAmount);
            v
        }
    };
    require!(amount_out_gross < r_out, HookpoolError::HookCurveInvalid);
    // The belt of the curve: only the real reserve is ever paid out. On a seeded pool
    // `real_out == r_out` and the line above already holds it.
    require!(amount_out_gross <= real_out, HookpoolError::CurveRealReserve);

    let hook_fee_out = if is_buy { 0 } else { fee_ceil(amount_out_gross, hook_fee_bps)? };
    let amount_out = amount_out_gross
        .checked_sub(hook_fee_out)
        .ok_or(HookpoolError::MathOverflow)?;
    require!(amount_out > 0, HookpoolError::ZeroAmount);

    let reserve_in_after = real_in
        .checked_add(net_in)
        .and_then(|v| v.checked_add(lp_fee))
        .ok_or(HookpoolError::MathOverflow)?;
    let reserve_out_after = real_out
        .checked_sub(amount_out_gross)
        .ok_or(HookpoolError::MathOverflow)?;

    Ok(SwapQuote {
        protocol_fee,
        hook_fee: hook_fee_in + hook_fee_out,
        lp_fee,
        fee_bps_applied,
        net_in,
        amount_out_gross,
        amount_out,
        reserve_in_after,
        reserve_out_after,
        quote_volume: if is_buy { amount_in } else { amount_out_gross },
    })
}

/// What `graduate` does to the reserves of a pool on the curve, as numbers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Graduation {
    /// The platform's share, moved out of the reserve into `protocol_fees_quote`.
    pub fee_quote: u64,
    /// The real quote reserve after the fee.
    pub reserve_quote_after: u64,
    /// The base reserve that keeps the price without the virtual quote.
    pub reserve_base_after: u64,
    /// Coins burned from the vault: `reserve_base - reserve_base_after`.
    pub burned_base: u64,
}

/// The graduation of a pool on the curve (HOOKS.md section 2):
///
/// ```text
/// fee = graduation_target * graduation_fee_bps / 10_000, floored, and at most
///       reserve_quote - 1 so that at least one unit of real quote stays
/// R2  = reserve_quote - fee
/// B2  = floor(R2 * reserve_base / (reserve_quote + virtual_quote))
/// burn = reserve_base - B2
/// ```
///
/// Before, the price is `(R + V) / B`; after, `R2 / B2`. Flooring `B2` moves the price up
/// by at most one unit of the coin and never down. Requires `reserve_quote >=
/// graduation_target` (`GraduationNotReached`) and leaves at least one coin in the pool
/// (`InsufficientLiquidity`, unreachable with a target that is not far below the virtual).
pub fn graduation(
    reserve_base: u64,
    reserve_quote: u64,
    virtual_quote: u64,
    graduation_target: u64,
    graduation_fee_bps: u16,
) -> Result<Graduation> {
    require!(reserve_quote >= graduation_target, HookpoolError::GraduationNotReached);
    require!(reserve_quote > 0 && reserve_base > 0, HookpoolError::InsufficientLiquidity);
    let fee = (graduation_target as u128) * (graduation_fee_bps as u128) / BPS_DENOM;
    let fee = u64::try_from(fee).map_err(|_| HookpoolError::MathOverflow)?;
    let fee_quote = fee.min(reserve_quote - 1);
    let reserve_quote_after = reserve_quote - fee_quote;
    let effective = (reserve_quote as u128)
        .checked_add(virtual_quote as u128)
        .ok_or(HookpoolError::MathOverflow)?;
    let b2 = (reserve_quote_after as u128)
        .checked_mul(reserve_base as u128)
        .ok_or(HookpoolError::MathOverflow)?
        / effective;
    let reserve_base_after = u64::try_from(b2).map_err(|_| HookpoolError::MathOverflow)?;
    require!(reserve_base_after > 0, HookpoolError::InsufficientLiquidity);
    let burned_base = reserve_base
        .checked_sub(reserve_base_after)
        .ok_or(HookpoolError::MathOverflow)?;
    Ok(Graduation { fee_quote, reserve_quote_after, reserve_base_after, burned_base })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_rounds_up() {
        assert_eq!(fee_ceil(10_000, 30).unwrap(), 30);
        assert_eq!(fee_ceil(1, 30).unwrap(), 1);
        assert_eq!(fee_ceil(0, 30).unwrap(), 0);
        assert_eq!(fee_ceil(10_000, 0).unwrap(), 0);
    }

    #[test]
    fn plain_buy_matches_v2_formula() {
        // 1 SOL into 100 SOL / 1_000_000 tokens, 0.3% fee, no protocol or hook fee
        let q = quote_swap(0, 1_000_000_000, 1_000_000_000_000, 100_000_000_000, 0, 30, 0, 0, None, None)
            .unwrap();
        assert_eq!(q.protocol_fee, 0);
        assert_eq!(q.lp_fee, 3_000_000);
        assert_eq!(q.net_in, 997_000_000);
        // 1e12 * 997e6 / (100e9 + 997e6)
        assert_eq!(q.amount_out, 9_871_580_343);
        assert_eq!(q.reserve_in_after, 101_000_000_000);
        assert_eq!(q.reserve_out_after, 1_000_000_000_000 - 9_871_580_343);
        assert_eq!(q.quote_volume, 1_000_000_000);
    }

    #[test]
    fn sell_takes_hook_fee_from_output() {
        let q = quote_swap(1, 1_000_000, 1_000_000_000_000, 100_000_000_000, 0, 30, 20, 500, None, None)
            .unwrap();
        assert_eq!(q.protocol_fee, 2_000); // 0.2% of input, in base
        assert!(q.hook_fee > 0);
        assert_eq!(q.amount_out + q.hook_fee, q.amount_out_gross);
        assert_eq!(q.quote_volume, q.amount_out_gross);
    }

    #[test]
    fn buy_takes_hook_fee_from_input() {
        let q = quote_swap(0, 1_000_000_000, 1_000_000_000_000, 100_000_000_000, 0, 30, 20, 500, None, None)
            .unwrap();
        assert_eq!(q.protocol_fee, 2_000_000);
        assert_eq!(q.hook_fee, 49_900_000); // 5% of 998_000_000
        assert_eq!(q.net_in + q.lp_fee + q.hook_fee + q.protocol_fee, 1_000_000_000);
    }

    #[test]
    fn fee_override_replaces_lp_fee() {
        let a = quote_swap(0, 1_000_000_000, 1_000_000_000_000, 100_000_000_000, 0, 30, 0, 0, Some(3_500), None).unwrap();
        assert_eq!(a.fee_bps_applied, 3_500);
        assert_eq!(a.lp_fee, 350_000_000);
    }

    #[test]
    fn curve_override_must_fit_reserves() {
        assert!(quote_swap(0, 1_000, 1_000_000, 1_000_000, 0, 30, 0, 0, None, Some(1_000_000)).is_err());
        assert!(quote_swap(0, 1_000, 1_000_000, 1_000_000, 0, 30, 0, 0, None, Some(0)).is_err());
        let ok = quote_swap(0, 1_000, 1_000_000, 1_000_000, 0, 30, 0, 0, None, Some(500)).unwrap();
        assert_eq!(ok.amount_out, 500);
    }

    #[test]
    fn a_dust_trade_is_a_zero_amount_and_a_hooks_zero_is_the_hooks_error() {
        // a sell of one unit into a deep pool pays nothing: ZeroAmount, seeded or on the curve
        let err = quote_swap(1, 1, 1_000_000_000_000, 100_000_000_000, 0, 0, 0, 0, None, None).unwrap_err();
        assert!(err.to_string().contains("ZeroAmount"), "{err}");
        let err = quote_swap(1, 1, 1_000_000_000_000, 1_000_000_000, 30_000_000_000, 0, 0, 0, None, None).unwrap_err();
        assert!(err.to_string().contains("ZeroAmount"), "{err}");
        // a buy of one lamport into a pool priced far above a lamport per unit: the same
        let err = quote_swap(0, 1, 30, 1_000_000_000_000_000_000, 0, 0, 0, 0, None, None).unwrap_err();
        assert!(err.to_string().contains("ZeroAmount"), "{err}");
        // a hook that answers zero, or the whole reserve: its own error, as before
        let err = quote_swap(1, 1_000, 1_000_000, 1_000_000, 0, 30, 0, 0, None, Some(0)).unwrap_err();
        assert!(err.to_string().contains("HookCurveInvalid"), "{err}");
        let err = quote_swap(0, 1_000, 1_000_000, 1_000_000, 0, 30, 0, 0, None, Some(1_000_000)).unwrap_err();
        assert!(err.to_string().contains("HookCurveInvalid"), "{err}");
    }

    #[test]
    fn isqrt() {
        assert_eq!(isqrt_u128(0), 0);
        assert_eq!(isqrt_u128(1), 1);
        assert_eq!(isqrt_u128(99), 9);
        assert_eq!(isqrt_u128(100), 10);
        assert_eq!(isqrt_u128(u128::from(u64::MAX) * u128::from(u64::MAX)), u128::from(u64::MAX));
    }

    // ---- the curve ------------------------------------------------------------------------

    const SUPPLY: u64 = 1_000_000_000_000_000; // 1B coins at 6 decimals
    const VIRTUAL: u64 = 30_000_000_000;
    const TARGET: u64 = 85_000_000_000;

    #[test]
    fn the_first_buy_on_the_curve_is_priced_with_the_virtual_quote_and_paid_from_nothing() {
        // 1 SOL into a pool with 0 real SOL, 30 virtual, the whole supply, no fee at all
        let q = quote_swap(0, 1_000_000_000, SUPPLY, 0, VIRTUAL, 0, 0, 0, None, None).unwrap();
        // 1e15 * 1e9 / (30e9 + 1e9) = 32_258_064_516_129.03..
        assert_eq!(q.amount_out, 32_258_064_516_129);
        // the real reserve after it is the 1 SOL that came in, not 31
        assert_eq!(q.reserve_in_after, 1_000_000_000);
        assert_eq!(q.reserve_out_after, SUPPLY - 32_258_064_516_129);
        // the price after it is (1 + 30) / B, to the rounding of one coin unit
        let b = q.reserve_out_after as u128;
        let price_num = 31_000_000_000u128;
        // (R + V) * B == k, up to the floored coin: k = 30e9 * 1e15
        let k = VIRTUAL as u128 * SUPPLY as u128;
        assert!(price_num * b >= k && price_num * b < k + price_num);
        // and a seeded pool with 31 SOL and the same coins quotes the same price
        let seeded = quote_swap(0, 1_000_000, q.reserve_out_after, 31_000_000_000, 0, 0, 0, 0, None, None).unwrap();
        let curve = quote_swap(0, 1_000_000, q.reserve_out_after, 1_000_000_000, VIRTUAL, 0, 0, 0, None, None).unwrap();
        assert_eq!(seeded.amount_out, curve.amount_out);
        assert_eq!(curve.reserve_in_after, 1_001_000_000, "real reserve");
        assert_eq!(seeded.reserve_in_after, 31_001_000_000);
    }

    #[test]
    fn a_sell_that_would_take_more_than_the_real_reserve_is_refused() {
        // 10 lamports of real quote, a million virtual: the curve would pay about half a
        // million for the whole base reserve sold back. The belt refuses it. Unreachable
        // on chain (nobody holds coins that did not come out of the pool), tested here.
        let err = quote_swap(1, 1_000, 1_000, 10, 1_000_000, 0, 0, 0, None, None).unwrap_err();
        assert!(err.to_string().contains("CurveRealReserve"), "{err}");
        // one unit below the real reserve goes through; the real reserve after it is 1
        let ok = quote_swap(1, 1, 1_000_000, 10, 1_000_000, 0, 0, 0, None, None).unwrap();
        assert!(ok.amount_out <= 10);
        assert_eq!(ok.reserve_out_after, 10 - ok.amount_out_gross);
        // exactly the real reserve is allowed (<=), one more is not: a hook's curve answer
        assert!(quote_swap(1, 1, 1_000_000, 10, 1_000_000, 0, 0, 0, None, Some(10)).is_ok());
        let err = quote_swap(1, 1, 1_000_000, 10, 1_000_000, 0, 0, 0, None, Some(11)).unwrap_err();
        assert!(err.to_string().contains("CurveRealReserve"), "{err}");
        // on a seeded pool the older check fires first, with its own error, as before
        let err = quote_swap(1, 1, 1_000_000, 10, 0, 0, 0, 0, None, Some(10)).unwrap_err();
        assert!(err.to_string().contains("HookCurveInvalid"), "{err}");
    }

    #[test]
    fn selling_everything_that_came_out_never_reaches_the_real_reserve() {
        // buys and sells with fees on, from a supply that is all in the pool: the real
        // reserve is never short, whatever the order, and k never falls
        let mut x = 0x2545_F491_4F6C_DD1Du64;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for _round in 0..40 {
            let (mut rb, mut rq) = (SUPPLY, 0u64);
            let mut outside = 0u64; // coins held by wallets
            let mut k = VIRTUAL as u128 * SUPPLY as u128;
            for _step in 0..300 {
                let sell = next() % 3 == 0 && outside > 0;
                if sell {
                    let amount = 1 + next() % outside;
                    let Ok(q) = quote_swap(1, amount, rb, rq, VIRTUAL, 30, 20, 50, None, None) else { continue };
                    assert!(q.amount_out_gross <= rq, "the belt is never what stops a sell");
                    outside -= amount;
                    (rb, rq) = (q.reserve_in_after, q.reserve_out_after);
                } else {
                    let amount = 1_000_000 + next() % 5_000_000_000;
                    let Ok(q) = quote_swap(0, amount, rb, rq, VIRTUAL, 30, 20, 50, None, None) else { continue };
                    outside += q.amount_out;
                    (rb, rq) = (q.reserve_out_after, q.reserve_in_after);
                }
                let k2 = (rq as u128 + VIRTUAL as u128) * rb as u128;
                assert!(k2 >= k, "the product of the effective reserves fell");
                k = k2;
                assert!(outside <= SUPPLY - rb);
            }
            // everyone sells everything: the pool pays, and keeps the fees it earned
            if outside > 0 {
                let q = quote_swap(1, outside, rb, rq, VIRTUAL, 30, 20, 50, None, None).unwrap();
                assert!(q.amount_out_gross <= rq);
            }
        }
    }

    #[test]
    fn graduation_keeps_the_price_and_burns_the_coins_the_virtual_quote_stood_for() {
        // the pool at the target: 85 SOL real, (85 + 30) * B = 30 * supply
        let b = (VIRTUAL as u128 * SUPPLY as u128 / (TARGET + VIRTUAL) as u128) as u64;
        let g = graduation(b, TARGET, VIRTUAL, TARGET, 0).unwrap();
        assert_eq!(g.fee_quote, 0);
        assert_eq!(g.reserve_quote_after, TARGET);
        // 85 * B / 115
        assert_eq!(g.reserve_base_after as u128, TARGET as u128 * b as u128 / (TARGET + VIRTUAL) as u128);
        assert_eq!(g.burned_base, b - g.reserve_base_after);
        // about 73.9% sold, 6.8% of the supply burned, 19.3% left
        assert!(b > 260_000_000_000_000 && b < 261_000_000_000_000, "{b}");
        assert!(g.burned_base > 67_000_000_000_000 && g.burned_base < 69_000_000_000_000, "{}", g.burned_base);
        // price kept: R2 / B2 >= (R + V) / B, and below it by less than one coin unit
        let (before_num, before_den) = ((TARGET + VIRTUAL) as u128, b as u128);
        let (after_num, after_den) = (g.reserve_quote_after as u128, g.reserve_base_after as u128);
        assert!(after_num * before_den >= before_num * after_den);
        assert!(after_num * before_den < before_num * (after_den + 1));

        // with a 7% fee: the fee leaves the reserve, the price is still kept
        let g = graduation(b, TARGET, VIRTUAL, TARGET, 700).unwrap();
        assert_eq!(g.fee_quote, TARGET * 700 / 10_000);
        assert_eq!(g.reserve_quote_after, TARGET - g.fee_quote);
        let (after_num, after_den) = (g.reserve_quote_after as u128, g.reserve_base_after as u128);
        assert!(after_num * before_den >= before_num * after_den);
        assert!(after_num * before_den < before_num * (after_den + 1));
        assert_eq!(g.burned_base, b - g.reserve_base_after);

        // past the target, with LP fees in the reserve: the same rule on the bigger pool
        let g = graduation(b - 1_000_000_000_000, TARGET + 3_000_000_000, VIRTUAL, TARGET, 0).unwrap();
        assert_eq!(g.reserve_quote_after, TARGET + 3_000_000_000);
        // below the target: refused
        let err = graduation(b, TARGET - 1, VIRTUAL, TARGET, 0).unwrap_err();
        assert!(err.to_string().contains("GraduationNotReached"), "{err}");
        // the fee never empties the reserve: a 10% fee on a reserve equal to the target
        // leaves 90%, a fee capped at 1 unit below the reserve when the reserve is tiny
        let g = graduation(1_000_000, 10, 1_000, 10, 1_000).unwrap();
        assert_eq!(g.fee_quote, 1);
        let g = graduation(1_000_000, 1, 1, 1, 1_000).unwrap();
        assert_eq!((g.fee_quote, g.reserve_quote_after), (0, 1));
    }
}
