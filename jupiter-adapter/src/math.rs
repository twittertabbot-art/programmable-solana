//! The pool's swap math, copied from `programs/hookpool/src/math.rs` without the on-chain
//! error types. Every line that decides a number is the same as there, in the same order:
//! fees round up, the curve rounds down. The parity tests run the real program against it.

pub const BPS_DENOM: u128 = 10_000;

/// ceil(amount * bps / 10_000)
pub fn fee_ceil(amount: u64, bps: u16) -> Option<u64> {
    if bps == 0 || amount == 0 {
        return Some(0);
    }
    let num = (amount as u128).checked_mul(bps as u128)?;
    u64::try_from(num.div_ceil(BPS_DENOM)).ok()
}

/// Constant product output: r_out * net_in / (r_in + net_in), floored.
pub fn constant_product_out(net_in: u64, r_in: u64, r_out: u64) -> Option<u64> {
    if r_in == 0 || r_out == 0 {
        return None;
    }
    let denom = (r_in as u128).checked_add(net_in as u128)?;
    let num = (r_out as u128).checked_mul(net_in as u128)?;
    u64::try_from(num / denom).ok()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SwapQuote {
    /// In the input mint.
    pub protocol_fee: u64,
    /// Always in the quote mint: taken from the input on a buy, from the output on a sell.
    pub hook_fee: u64,
    /// In the input mint. Stays in the pool.
    pub lp_fee: u64,
    pub fee_bps_applied: u16,
    pub net_in: u64,
    pub amount_out_gross: u64,
    pub amount_out: u64,
    /// The REAL reserves after the swap, in the input and the output mint: the virtual
    /// quote of a pool on the curve is not in them.
    pub reserve_in_after: u64,
    pub reserve_out_after: u64,
}

/// The whole swap order of operations, for a pool whose hook does not own the curve:
///
/// ```text
/// effective quote = reserve_quote + virtual_quote   (virtual_quote is 0 off the curve)
/// amount_in
///   - protocol_fee        (protocol_fee_bps of amount_in)
///   - hook_fee if buy     (hook_fee_bps of what is left)
///   - lp_fee              (lp_fee_bps, or the hook's fee override, of what is left)
///   = net_in
/// amount_out_gross = r_out * net_in / (r_in + net_in)    (the quote side at its effective size)
///   at most the REAL reserve of the output side: a sell is paid from real quote only
///   - hook_fee if sell    (hook_fee_bps of amount_out_gross)
///   = amount_out
/// ```
///
/// `None` wherever the program would fail the swap.
#[allow(clippy::too_many_arguments)]
pub fn quote_swap(
    is_buy: bool,
    amount_in: u64,
    reserve_base: u64,
    reserve_quote: u64,
    virtual_quote: u64,
    lp_fee_bps: u16,
    protocol_fee_bps: u16,
    hook_fee_bps: u16,
    fee_override_bps: Option<u16>,
) -> Option<SwapQuote> {
    if amount_in == 0 {
        return None;
    }
    // the reserves the price is made of, and the reserves that are really there
    let effective_quote = reserve_quote.checked_add(virtual_quote)?;
    let (r_in, r_out, real_in, real_out) =
        if is_buy { (effective_quote, reserve_base, reserve_quote, reserve_base) } else { (reserve_base, effective_quote, reserve_base, reserve_quote) };

    let protocol_fee = fee_ceil(amount_in, protocol_fee_bps)?;
    let after_protocol = amount_in.checked_sub(protocol_fee)?;

    let hook_fee_in = if is_buy { fee_ceil(after_protocol, hook_fee_bps)? } else { 0 };
    let after_hook = after_protocol.checked_sub(hook_fee_in)?;

    let fee_bps_applied = fee_override_bps.unwrap_or(lp_fee_bps);
    let lp_fee = fee_ceil(after_hook, fee_bps_applied)?;
    let net_in = after_hook.checked_sub(lp_fee)?;
    if net_in == 0 {
        return None;
    }

    let amount_out_gross = constant_product_out(net_in, r_in, r_out)?;
    // a dust trade (ZeroAmount), or the whole reserve (HookCurveInvalid)
    if amount_out_gross == 0 || amount_out_gross >= r_out {
        return None;
    }
    // The belt of the curve (CurveRealReserve): only the real reserve is ever paid out. On
    // a seeded pool `real_out == r_out` and the line above already holds it.
    if amount_out_gross > real_out {
        return None;
    }

    let hook_fee_out = if is_buy { 0 } else { fee_ceil(amount_out_gross, hook_fee_bps)? };
    let amount_out = amount_out_gross.checked_sub(hook_fee_out)?;
    if amount_out == 0 {
        return None;
    }
    // the program also requires the new reserves to fit a u64
    let reserve_in_after = real_in.checked_add(net_in)?.checked_add(lp_fee)?;
    let reserve_out_after = real_out.checked_sub(amount_out_gross)?;

    Some(SwapQuote {
        protocol_fee,
        hook_fee: hook_fee_in + hook_fee_out,
        lp_fee,
        fee_bps_applied,
        net_in,
        amount_out_gross,
        amount_out,
        reserve_in_after,
        reserve_out_after,
    })
}

/// The launch guard's buy fee: linear decay from `start_fee` at `start_slot` to the pool's
/// own fee at `start_slot + guard_slots`. `None` once the window is over. Copied from
/// `programs/hook_launch_guard/src/lib.rs`.
pub fn guard_fee(slot: u64, start_slot: u64, guard_slots: u64, start_fee_bps: u16, base_fee_bps: u16) -> Option<u16> {
    if start_fee_bps <= base_fee_bps || guard_slots == 0 {
        return None;
    }
    let elapsed = slot.saturating_sub(start_slot);
    if elapsed >= guard_slots {
        return None;
    }
    let span = (start_fee_bps - base_fee_bps) as u128;
    let decayed = span * elapsed as u128 / guard_slots as u128;
    Some(start_fee_bps - decayed as u16)
}

/// The sniper fee of a rules coin: the pool fee of a buy in the first `sniper_slots` slots
/// after launch. It is the launch guard's line (`sniper_fee` in
/// `programs/hook_rules/src/lib.rs` says so, and has the same vectors as the test below).
pub fn sniper_fee(slot: u64, start_slot: u64, sniper_slots: u64, start_fee_bps: u16, base_fee_bps: u16) -> Option<u16> {
    guard_fee(slot, start_slot, sniper_slots, start_fee_bps, base_fee_bps)
}

/// Does a rules coin refuse this buy? Inside the limit window (`limit_slots` slots from
/// `start_slot`) one buy may send at most `max_buy_quote`; `amount_in` is the whole input,
/// before any fee. No limit when `max_buy_quote` is zero. The same test, in the same
/// order, as `before_swap` of `programs/hook_rules/src/lib.rs`.
pub fn buy_above_limit(slot: u64, start_slot: u64, limit_slots: u64, max_buy_quote: u64, amount_in: u64) -> bool {
    max_buy_quote > 0 && slot.saturating_sub(start_slot) < limit_slots && amount_in > max_buy_quote
}

#[cfg(test)]
mod tests {
    use super::*;

    // The same vectors as the unit tests of the program's own math.
    #[test]
    fn fee_rounds_up() {
        assert_eq!(fee_ceil(10_000, 30), Some(30));
        assert_eq!(fee_ceil(1, 30), Some(1));
        assert_eq!(fee_ceil(0, 30), Some(0));
        assert_eq!(fee_ceil(10_000, 0), Some(0));
    }

    #[test]
    fn plain_buy_matches_v2_formula() {
        let q = quote_swap(true, 1_000_000_000, 1_000_000_000_000, 100_000_000_000, 0, 30, 0, 0, None).unwrap();
        assert_eq!((q.protocol_fee, q.lp_fee, q.net_in), (0, 3_000_000, 997_000_000));
        assert_eq!(q.amount_out, 9_871_580_343);
        assert_eq!((q.reserve_in_after, q.reserve_out_after), (101_000_000_000, 1_000_000_000_000 - 9_871_580_343));
    }

    #[test]
    fn buy_takes_hook_fee_from_input_and_sell_from_output() {
        let q = quote_swap(true, 1_000_000_000, 1_000_000_000_000, 100_000_000_000, 0, 30, 20, 500, None).unwrap();
        assert_eq!((q.protocol_fee, q.hook_fee), (2_000_000, 49_900_000));
        assert_eq!(q.net_in + q.lp_fee + q.hook_fee + q.protocol_fee, 1_000_000_000);
        let q = quote_swap(false, 1_000_000, 1_000_000_000_000, 100_000_000_000, 0, 30, 20, 500, None).unwrap();
        assert_eq!(q.protocol_fee, 2_000);
        assert!(q.hook_fee > 0);
        assert_eq!(q.amount_out + q.hook_fee, q.amount_out_gross);
    }

    #[test]
    fn fee_override_replaces_lp_fee() {
        let q = quote_swap(true, 1_000_000_000, 1_000_000_000_000, 100_000_000_000, 0, 30, 0, 0, Some(3_500)).unwrap();
        assert_eq!((q.fee_bps_applied, q.lp_fee), (3_500, 350_000_000));
    }

    #[test]
    fn what_the_program_refuses_gives_no_quote() {
        assert!(quote_swap(true, 0, 1, 1, 0, 30, 20, 0, None).is_none());
        assert!(quote_swap(true, 1, 1_000_000, 1_000_000, 0, 30, 20, 0, None).is_none(), "the fees eat a single unit");
        assert!(quote_swap(true, 1_000, 0, 1_000_000, 0, 30, 20, 0, None).is_none(), "an empty pool");
        // the vectors of `a_dust_trade_is_a_zero_amount_and_a_hooks_zero_is_the_hooks_error`:
        // an output that rounds to zero, seeded or on the curve
        assert!(quote_swap(false, 1, 1_000_000_000_000, 100_000_000_000, 0, 0, 0, 0, None).is_none());
        assert!(quote_swap(false, 1, 1_000_000_000_000, 1_000_000_000, 30_000_000_000, 0, 0, 0, None).is_none());
        assert!(quote_swap(true, 1, 30, 1_000_000_000_000_000_000, 0, 0, 0, 0, None).is_none());
        // a quote reserve that does not fit a u64 with the virtual one: the pool overflows
        assert!(quote_swap(true, 1_000, 1_000_000, 1, u64::MAX, 0, 0, 0, None).is_none());
    }

    // ---- the curve: the vectors of the program's own unit tests -------------------------

    const SUPPLY: u64 = 1_000_000_000_000_000; // 1B coins at 6 decimals
    const VIRTUAL: u64 = 30_000_000_000;

    #[test]
    fn the_first_buy_on_the_curve_is_priced_with_the_virtual_quote() {
        // 1 SOL into a pool with 0 real SOL, 30 virtual, the whole supply, no fee at all
        let q = quote_swap(true, 1_000_000_000, SUPPLY, 0, VIRTUAL, 0, 0, 0, None).unwrap();
        // 1e15 * 1e9 / (30e9 + 1e9)
        assert_eq!(q.amount_out, 32_258_064_516_129);
        // the real reserve after it is the 1 SOL that came in, not 31
        assert_eq!((q.reserve_in_after, q.reserve_out_after), (1_000_000_000, SUPPLY - 32_258_064_516_129));
        // a seeded pool with 31 SOL and the same coins quotes the same as the curve with 1 + 30
        let seeded = quote_swap(true, 1_000_000, q.reserve_out_after, 31_000_000_000, 0, 0, 0, 0, None).unwrap();
        let curve = quote_swap(true, 1_000_000, q.reserve_out_after, 1_000_000_000, VIRTUAL, 0, 0, 0, None).unwrap();
        assert_eq!(seeded.amount_out, curve.amount_out);
        assert_eq!((curve.reserve_in_after, seeded.reserve_in_after), (1_001_000_000, 31_001_000_000), "the curve's reserve after is real");
        // and the same for a sell, paid from the 1 real SOL
        let seeded = quote_swap(false, 1_000_000_000_000, q.reserve_out_after, 31_000_000_000, 0, 30, 20, 0, None).unwrap();
        let curve = quote_swap(false, 1_000_000_000_000, q.reserve_out_after, 1_000_000_000, VIRTUAL, 30, 20, 0, None).unwrap();
        assert_eq!(seeded.amount_out, curve.amount_out);
        assert_eq!(curve.reserve_out_after, 1_000_000_000 - curve.amount_out_gross);
    }

    #[test]
    fn a_sell_that_would_take_more_than_the_real_reserve_gives_no_quote() {
        // 10 units of real quote, a million virtual: the curve would pay about half a million
        // for the whole base reserve sold back. The program refuses it (CurveRealReserve).
        assert!(quote_swap(false, 1_000, 1_000, 10, 1_000_000, 0, 0, 0, None).is_none());
        // one unit sold goes through and is paid from the 10 real units
        let ok = quote_swap(false, 1, 1_000_000, 10, 1_000_000, 0, 0, 0, None).unwrap();
        assert!(ok.amount_out <= 10);
        assert_eq!(ok.reserve_out_after, 10 - ok.amount_out_gross);
        // a fresh pool on the curve holds no real quote: no sell can be paid at all
        assert!(quote_swap(false, 1_000_000_000_000, SUPPLY, 0, VIRTUAL, 0, 0, 0, None).is_none());
        // the edge: the largest sell paid in full is quoted, one unit more is not
        let (rb, rq) = (SUPPLY - 32_258_064_516_129, 1_000_000_000);
        let (mut lo, mut hi) = (1_000_000_000u64, SUPPLY);
        assert!(quote_swap(false, lo, rb, rq, VIRTUAL, 100, 20, 0, None).is_some() && quote_swap(false, hi, rb, rq, VIRTUAL, 100, 20, 0, None).is_none());
        while lo + 1 < hi {
            let mid = lo + (hi - lo) / 2;
            if quote_swap(false, mid, rb, rq, VIRTUAL, 100, 20, 0, None).is_some() { lo = mid } else { hi = mid }
        }
        let edge = quote_swap(false, lo, rb, rq, VIRTUAL, 100, 20, 0, None).unwrap();
        assert!(edge.amount_out_gross <= rq && edge.amount_out_gross + edge.amount_out_gross / 1_000 >= rq, "the edge pays about the whole real reserve");
        assert!(quote_swap(false, hi, rb, rq, VIRTUAL, 100, 20, 0, None).is_none());
    }

    /// The pool at exactly the target, before and after graduation (the numbers of
    /// CURVE-CHANGES.md section 1): 85 real SOL, 30 virtual, 260,869,565,217,391 units; then
    /// 85 SOL and floor(85 * B / 115) = 192,816,635,160,680 units, no virtual quote.
    #[test]
    fn graduation_keeps_the_price_and_takes_away_the_depth() {
        let (b, r) = (260_869_565_217_391u64, 85_000_000_000u64);
        let b2 = (r as u128 * b as u128 / (r + VIRTUAL) as u128) as u64;
        assert_eq!(b2, 192_816_635_160_680);
        // the price is kept: R2 / B2 >= (R + V) / B, and above it by less than one unit of the coin
        assert!(r as u128 * b as u128 >= (r + VIRTUAL) as u128 * b2 as u128);
        assert!((r as u128) * (b as u128) < (r + VIRTUAL) as u128 * (b2 as u128 + 1));
        // a small buy pays the same on both sides of the graduation
        for lamports in [1u64, 100] {
            let on = quote_swap(true, lamports, b, r, VIRTUAL, 0, 0, 0, None).unwrap();
            let off = quote_swap(true, lamports, b2, r, 0, 0, 0, 0, None).unwrap();
            assert!(on.amount_out.abs_diff(off.amount_out) <= 1, "{lamports} lamports: {} on the curve, {} graduated", on.amount_out, off.amount_out);
        }
        // a big one gets less after it: the depth fell from R + V to R at the same price
        let on = quote_swap(true, 20_000_000_000, b, r, VIRTUAL, 0, 0, 0, None).unwrap();
        let off = quote_swap(true, 20_000_000_000, b2, r, 0, 0, 0, 0, None).unwrap();
        assert!(off.amount_out < on.amount_out);
    }

    #[test]
    fn the_guard_decays_linearly_then_stops() {
        assert_eq!(guard_fee(100, 100, 300, 3_000, 100), Some(3_000));
        assert_eq!(guard_fee(250, 100, 300, 3_000, 100), Some(1_550));
        assert_eq!(guard_fee(400, 100, 300, 3_000, 100), None);
        assert_eq!(guard_fee(100, 100, 300, 100, 100), None);
    }

    // The vectors of `sniper_fee_is_the_launch_guard_line` in the rules hook.
    #[test]
    fn the_sniper_fee_is_the_same_line() {
        assert_eq!(sniper_fee(100, 100, 100, 3_000, 100), Some(3_000));
        assert_eq!(sniper_fee(150, 100, 100, 3_000, 100), Some(1_550));
        assert_eq!(sniper_fee(199, 100, 100, 3_000, 100), Some(129));
        assert_eq!(sniper_fee(200, 100, 100, 3_000, 100), None);
        assert_eq!(sniper_fee(100, 100, 0, 3_000, 100), None);
        assert_eq!(sniper_fee(100, 100, 100, 100, 100), None);
        assert_eq!(sniper_fee(100, 100, 100, 50, 100), None);
        assert_eq!(sniper_fee(50, 100, 100, 3_000, 100), Some(3_000), "a slot before the start counts as the start");
    }

    #[test]
    fn the_buy_limit_holds_for_its_window_and_not_a_slot_longer() {
        // a limit of 200 for 150 slots from slot 1,000: elapsed 0 to 149
        assert!(buy_above_limit(1_000, 1_000, 150, 200, 201));
        assert!(!buy_above_limit(1_000, 1_000, 150, 200, 200), "a buy of exactly the limit passes");
        assert!(buy_above_limit(1_149, 1_000, 150, 200, 201));
        assert!(!buy_above_limit(1_150, 1_000, 150, 200, 201), "the window is over");
        assert!(buy_above_limit(900, 1_000, 150, 200, 201), "a slot before the start counts as the start");
        assert!(!buy_above_limit(1_000, 1_000, 150, 0, u64::MAX), "no limit");
        assert!(!buy_above_limit(1_000, 1_000, 0, 200, 201), "no window");
    }
}
