//! Independent review of the curve launch (round 4, track R). Written by the reviewer, not
//! by the author of the code; excluded from the package (`review_*.rs`).
//!
//! Every test says in its name and its comments what a PASS means: either "the attack lost"
//! (the pool behaved) or "the finding is real" (the test shows the gap and passes until the
//! gap is closed). Every test runs against the real binaries in LiteSVM, except the three
//! `review_math_*` tests, which drive the pool's own math over ranges a chain cannot reach.

#![allow(clippy::too_many_arguments)]

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022 as t22;
use hook_collectible::{QUEUE_SEED, SLOT_HASHES_ID, VALIDATION_SEED};
use hookpool::events::Graduated;
use hookpool::math::{graduation, quote_swap, SwapQuote};
use hookpool_interface::*;
use hookpool_tests::*;
use litesvm::types::TransactionMetadata;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_sha256_hasher::hashv;
use solana_signer::Signer;
use solana_slot_hashes::SlotHashes;

const SUPPLY: u64 = 1_000_000_000_000_000; // 1B coins at 6 decimals
const VIRTUAL: u64 = DEFAULT_CURVE_VIRTUAL_QUOTE; // 30 SOL
const TARGET: u64 = DEFAULT_CURVE_GRADUATION_TARGET; // 85 SOL
const LP_FEE: u16 = 30;
const START_SLOT: u64 = 1_000;
const START_TIME: i64 = 1_760_000_000;

// ---- helpers --------------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [lo, hi]; `lo` when the range is empty.
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        lo + self.next() % (hi - lo + 1)
    }
    /// Spread over every size between lo and hi (log-uniform-ish).
    fn log_range(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        let shift = self.next() % 64;
        (self.next() >> shift).clamp(lo, hi)
    }
}

/// A closed coin with `supply` under `program`, a fresh 9-decimal quote, both the maker's.
fn coin(env: &mut Env, maker: &Keypair, program: &Pubkey, supply: u64) -> PoolKeys {
    let base = env.closed_coin(maker, program, supply);
    let quote = env.create_mint(maker, 9);
    env.create_ata(maker, &maker.pubkey(), &quote);
    Env::pool_keys_with(&base, &quote, program)
}

/// A wallet with SOL for fees, `quote` units of the quote token and an empty coin account.
fn wallet(env: &mut Env, quote_authority: &Keypair, k: &PoolKeys, quote: u64) -> Keypair {
    let w = env.user(5 * SOL);
    let q = env.create_ata(&w, &w.pubkey(), &k.quote_mint);
    if quote > 0 {
        env.mint_to(quote_authority, &k.quote_mint, &q, quote);
    }
    env.ok(&[Env::create_ata_with_ix(&w.pubkey(), &w.pubkey(), &k.base_mint, &k.base_program)], &[&w]);
    w
}

/// A pool on the curve without a hook, its maker (also the quote's mint authority).
fn open(program: &Pubkey, lp_fee: u16) -> (Env, Keypair, PoolKeys, HookRef) {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let maker = env.user(100 * SOL);
    let k = coin(&mut env, &maker, program, SUPPLY);
    env.create_curve_pool(&maker, &k, lp_fee, SUPPLY, &HookRef::none());
    (env, maker, k, HookRef::none())
}

fn coins_of(k: &PoolKeys, w: &Pubkey) -> Pubkey {
    ata_with(w, &k.base_mint, &k.base_program)
}
fn quote_of(k: &PoolKeys, w: &Pubkey) -> Pubkey {
    ata(w, &k.quote_mint)
}

/// The effective price `(reserve_quote + virtual_quote) / reserve_base` as a fraction.
fn price(p: &hookpool::Pool) -> (u128, u128) {
    (p.reserve_quote as u128 + p.virtual_quote as u128, p.reserve_base as u128)
}

/// Graduation keeps the price: never down, up by less than one unit of the coin.
fn assert_price_kept(before: &hookpool::Pool, after: &hookpool::Pool) {
    let ((bn, bd), (an, ad)) = (price(before), price(after));
    assert!(an * bd >= bn * ad, "the price moved down at graduation");
    assert!(an * bd < bn * (ad + 1), "the price moved up by a whole coin unit or more");
}

/// The vaults hold exactly the reserves plus the fees waiting in them.
fn vaults(env: &Env, k: &PoolKeys) -> hookpool::Pool {
    let p = env.pool(&k.pool);
    assert_eq!(env.balance(&k.base_vault), p.reserve_base + p.protocol_fees_base, "the coin vault");
    assert_eq!(
        env.balance(&k.quote_vault),
        p.reserve_quote + p.protocol_fees_quote + p.hook_fees_owed_quote,
        "the quote vault"
    );
    p
}

/// Events written with `emit_cpi!`.
fn cpi_events<T: AnchorDeserialize + Discriminator>(meta: &TransactionMetadata) -> Vec<T> {
    const TAG: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
    meta.inner_instructions
        .iter()
        .flatten()
        .map(|i| &i.instruction.data)
        .filter(|d| d.len() >= 16 && d[..8] == TAG && d[8..16] == *T::DISCRIMINATOR)
        .map(|d| T::deserialize(&mut &d[16..]).unwrap())
        .collect()
}

fn warp(env: &mut Env, slot: u64) {
    let t = env.clock().unix_timestamp;
    env.set_clock(slot, t);
}

/// A trade by `t`, checked to the unit against the pool's own math and the vaults.
fn trade(env: &mut Env, t: &Keypair, k: &PoolKeys, hook: &HookRef, direction: u8, amount: u64, hook_fee_bps: u16, over: Option<u16>) -> SwapQuote {
    let before = env.pool(&k.pool);
    let q = expect_swap(&before, direction, amount, hook_fee_bps, over);
    let (b0, q0) = (env.balance(&coins_of(k, &t.pubkey())), env.balance(&quote_of(k, &t.pubkey())));
    let ix = env.swap_ix(&t.pubkey(), k, hook, direction, amount, q.amount_out);
    env.ok(&[compute_budget_ix(400_000), ix], &[t]);
    let after = vaults(env, k);
    if direction == DIRECTION_BUY {
        assert_eq!((after.reserve_quote, after.reserve_base), (q.reserve_in_after, q.reserve_out_after));
        assert_eq!(env.balance(&coins_of(k, &t.pubkey())), b0 + q.amount_out);
        assert_eq!(env.balance(&quote_of(k, &t.pubkey())), q0 - amount);
    } else {
        assert!(q.amount_out_gross <= before.reserve_quote, "a sell asked for more than the real reserve");
        assert_eq!((after.reserve_base, after.reserve_quote), (q.reserve_in_after, q.reserve_out_after));
        assert_eq!(env.balance(&coins_of(k, &t.pubkey())), b0 - amount);
        assert_eq!(env.balance(&quote_of(k, &t.pubkey())), q0 + q.amount_out);
    }
    q
}

fn buy(env: &mut Env, t: &Keypair, k: &PoolKeys, hook: &HookRef, amount: u64) -> SwapQuote {
    trade(env, t, k, hook, DIRECTION_BUY, amount, 0, None)
}
fn sell(env: &mut Env, t: &Keypair, k: &PoolKeys, hook: &HookRef, amount: u64) -> SwapQuote {
    trade(env, t, k, hook, DIRECTION_SELL, amount, 0, None)
}

/// Buys of 20 quote by `t` until the real reserve stands at the target or above.
fn reach_target(env: &mut Env, t: &Keypair, k: &PoolKeys, hook: &HookRef, hook_fee_bps: u16) {
    loop {
        let p = env.pool(&k.pool);
        if p.reserve_quote >= p.graduation_target {
            break;
        }
        trade(env, t, k, hook, DIRECTION_BUY, 20 * SOL, hook_fee_bps, None);
    }
}

fn graduate(env: &mut Env, k: &PoolKeys, who: &Keypair) -> TransactionMetadata {
    let ix = env.graduate_ix(k);
    env.ok(&[ix], &[who])
}

// ---- 1. the invariant on the math, far beyond what a chain can reach --------------------------

/// PASS = the attack lost. A model of the pool (coins outside, coins in the vault as
/// protocol fees, the supply) is walked with every kind of move the chain allows: buys,
/// sells of any part of what wallets hold, `hook_buy_burn` buys (coins leave the supply),
/// token burns by holders, the treasury collecting the protocol fee coins and selling them
/// back. Supplies from 2 units to u64::MAX, virtual quotes from 1 lamport to 1e18, every
/// fee at random up to its hard cap (LP 20%, protocol 1%, hook 20%, override 90%). The belt
/// (`CurveRealReserve`) must never be what stops a sell, the effective product never falls,
/// and nothing overflows.
#[test]
fn review_math_the_belt_is_never_what_stops_a_sell_under_extreme_fees_sizes_and_burns() {
    let mut rng = Rng(0xC0FF_EE11);
    let supplies = [2u64, 7, 1_000, 1_000_000, SUPPLY, u64::MAX / 4, u64::MAX];
    let virtuals = [1u64, 1_000, VIRTUAL, 1_000_000_000_000, 1_000_000_000_000_000_000];
    let (mut buys, mut sells, mut burns, mut dust) = (0u64, 0u64, 0u64, 0u64);
    for &s in &supplies {
        for &v in &virtuals {
            for _round in 0..6 {
                let lp = (rng.next() % 2001) as u16;
                let protocol = (rng.next() % 101) as u16;
                let hook = (rng.next() % 2001) as u16;
                let over = if rng.next().is_multiple_of(2) { None } else { Some((rng.next() % 9001) as u16) };
                let (mut rb, mut rq, mut supply) = (s, 0u64, s);
                let (mut outside, mut pfees) = (0u64, 0u64);
                let mut k = v as u128 * s as u128;
                let mut step = |rng: &mut Rng, rb: &mut u64, rq: &mut u64, supply: &mut u64, outside: &mut u64, pfees: &mut u64, final_sell: bool| {
                    let action = if final_sell { 4 } else { rng.next() % 10 };
                    match action {
                        0..=3 => {
                            let cap = (u64::MAX / 2).saturating_sub(*rq);
                            if cap == 0 {
                                return;
                            }
                            let amount = rng.log_range(1, v.saturating_mul(8).min(cap).max(1));
                            match quote_swap(DIRECTION_BUY, amount, *rb, *rq, v, lp, protocol, hook, over, None) {
                                Ok(q) => {
                                    *outside += q.amount_out;
                                    *rb = q.reserve_out_after;
                                    *rq = q.reserve_in_after;
                                    buys += 1;
                                }
                                Err(e) => {
                                    let m = e.to_string();
                                    assert!(!m.contains("MathOverflow") && !m.contains("CurveRealReserve"), "a buy failed with {m}");
                                    dust += 1;
                                }
                            }
                        }
                        4..=6 => {
                            if *outside == 0 {
                                return;
                            }
                            let amount = if final_sell || rng.next().is_multiple_of(4) { *outside } else { rng.range(1, *outside) };
                            match quote_swap(DIRECTION_SELL, amount, *rb, *rq, v, lp, protocol, hook, over, None) {
                                Ok(q) => {
                                    assert!(q.amount_out_gross <= *rq, "the belt is never what stops a sell");
                                    *outside -= amount;
                                    *pfees += q.protocol_fee;
                                    *rb = q.reserve_in_after;
                                    *rq = q.reserve_out_after;
                                    sells += 1;
                                }
                                Err(e) => {
                                    let m = e.to_string();
                                    assert!(!m.contains("CurveRealReserve"), "THE BELT FIRED: supply {s} virtual {v} rb {rb} rq {rq} outside {outside} amount {amount}: {m}");
                                    assert!(!m.contains("MathOverflow"), "a sell overflowed: {m}");
                                    dust += 1;
                                }
                            }
                        }
                        7 => {
                            // hook_buy_burn: a buy without a hook fee whose coins leave the supply
                            let cap = (u64::MAX / 2).saturating_sub(*rq);
                            if cap == 0 {
                                return;
                            }
                            let amount = rng.log_range(1, v.min(cap).max(1));
                            if let Ok(q) = quote_swap(DIRECTION_BUY, amount, *rb, *rq, v, lp, protocol, 0, None, None) {
                                *supply -= q.amount_out;
                                *rb = q.reserve_out_after;
                                *rq = q.reserve_in_after;
                                burns += 1;
                            }
                        }
                        8 => {
                            // a holder burns coins with the token program
                            if *outside > 0 {
                                let x = rng.range(1, *outside);
                                *outside -= x;
                                *supply -= x;
                            }
                        }
                        _ => {
                            // the treasury collects the protocol fee coins; they are outside now
                            *outside += *pfees;
                            *pfees = 0;
                        }
                    }
                };
                for _ in 0..400 {
                    step(&mut rng, &mut rb, &mut rq, &mut supply, &mut outside, &mut pfees, false);
                    let k2 = (rq as u128 + v as u128) * rb as u128;
                    assert!(k2 >= k, "the effective product fell: supply {s} virtual {v}");
                    assert!(k2 >= v as u128 * supply as u128, "k below V * S: supply {s} virtual {v}");
                    k = k2;
                    assert_eq!(outside as u128 + pfees as u128 + rb as u128, supply as u128, "a coin is lost or made");
                    assert!(rb >= 1);
                }
                // the treasury takes its coins, then everybody sells everything they can
                outside += pfees;
                pfees = 0;
                let mut guard = 0;
                while outside > 0 && guard < 64 {
                    let before = outside;
                    step(&mut rng, &mut rb, &mut rq, &mut supply, &mut outside, &mut pfees, true);
                    if outside == before {
                        // too small to pay a unit out (dust): nobody is owed anything for it
                        break;
                    }
                    guard += 1;
                }
                assert_eq!(outside as u128 + pfees as u128 + rb as u128, supply as u128);
            }
        }
    }
    println!("math walk: {buys} buys, {sells} sells, {burns} buy-burns, {dust} dust trades refused, belt never fired");
    assert!(buys > 10_000 && sells > 5_000, "{buys} {sells}");
}

/// PASS = the attack lost. `graduation` over random pools of every size up to u64::MAX on
/// every field, with and without a virtual quote, with fees up to the hard cap: the price
/// never falls, rises by less than one coin unit, the fee never empties the reserve, the
/// burn is exactly `B - B2`, nothing overflows, and the only refusal is the one the author
/// documents (a kept base reserve of zero), which is checked to be exactly that case.
#[test]
fn review_math_graduation_never_lowers_the_price_at_any_size_and_fails_only_when_no_coin_would_be_left() {
    let mut rng = Rng(42);
    let (mut ok, mut short) = (0u64, 0u64);
    for i in 0..300_000u32 {
        let pick = |rng: &mut Rng| match rng.next() % 4 {
            0 => rng.next(),
            1 => rng.next() >> 32,
            2 => rng.next() >> 48,
            _ => 1 + rng.next() % 1_000,
        };
        let b = pick(&mut rng).max(1);
        let r = pick(&mut rng).max(1);
        let v = if i % 5 == 0 { 0 } else { pick(&mut rng).min(u64::MAX - r) };
        let target = 1 + rng.next() % r;
        let fee = (rng.next() % 1_001) as u16;
        let fee_quote = ((target as u128 * fee as u128 / 10_000) as u64).min(r - 1);
        match graduation(b, r, v, target, fee) {
            Ok(g) => {
                ok += 1;
                assert_eq!(g.fee_quote, fee_quote);
                assert!(g.reserve_quote_after >= 1 && g.reserve_quote_after + g.fee_quote == r);
                assert!(g.reserve_base_after >= 1 && g.reserve_base_after <= b);
                assert_eq!(g.burned_base, b - g.reserve_base_after);
                let (bn, bd) = (r as u128 + v as u128, b as u128);
                let (an, ad) = (g.reserve_quote_after as u128, g.reserve_base_after as u128);
                assert!(an * bd >= bn * ad, "the price fell: b {b} r {r} v {v} fee {fee}");
                if let Some(up) = bn.checked_mul(ad + 1) {
                    assert!(an * bd < up, "the price rose by a whole unit: b {b} r {r} v {v} fee {fee}");
                }
            }
            Err(e) => {
                short += 1;
                let m = e.to_string();
                assert!(m.contains("InsufficientLiquidity"), "{m}");
                // refused only when the kept base reserve would be zero
                assert!(((r - fee_quote) as u128) * (b as u128) < (r as u128) + (v as u128), "refused with coins to keep: b {b} r {r} v {v} fee {fee}");
            }
        }
    }
    println!("graduation fuzz: {ok} graduations, {short} refused for a kept reserve of zero");
    assert!(ok > 200_000);

    // with the platform's defaults every pool a chain can reach graduates, at any fee
    for r in [TARGET, TARGET + 1, 2 * TARGET, 10 * TARGET, 1_000_000 * SOL, 1_000_000_000 * SOL] {
        let b = (VIRTUAL as u128 * SUPPLY as u128 / (r as u128 + VIRTUAL as u128)) as u64;
        for fee in [0, 700, 1_000] {
            let g = graduation(b, r, VIRTUAL, TARGET, fee).unwrap();
            assert!(g.reserve_base_after > 0);
        }
    }
    // the one state that cannot: a base reserve of one unit. To reach it the real reserve
    // would have to be k - V, about 3e16 SOL: not a state a chain can reach.
    assert!(graduation(1, TARGET, VIRTUAL, TARGET, 0).is_err());
    assert!(graduation(1, u64::MAX, VIRTUAL, TARGET, 0).is_err());
    // the smallest supply whose pool graduates at exactly the target with the defaults
    let mut smallest = 0;
    for s in 1..=64u64 {
        let b = (VIRTUAL as u128 * s as u128 / (TARGET as u128 + VIRTUAL as u128)) as u64;
        if b > 0 && graduation(b, TARGET, VIRTUAL, TARGET, 1_000).is_ok() {
            smallest = s;
            break;
        }
    }
    println!("smallest supply that graduates at the target with a 10% fee: {smallest} units");
    assert!(smallest > 0 && smallest <= 16);
}

/// PASS = the finding is closed (informational, pre-existing; fixed in the round-4 fix
/// round). A trade too small to pay out one unit, on a pool with or without a hook, on the
/// curve as on a seeded pool, now fails with `ZeroAmount`; `HookCurveInvalid` is kept for a
/// hook's own curve answer (zero, or not below the reserve). The smallest paying sell on a
/// fresh curve is 33,334 units. Buys of a few lamports work.
#[test]
fn review_math_a_dust_sell_fails_with_the_hooks_curve_error_on_a_pool_without_a_hook() {
    // on the bare math a fresh pool (R = 0) refuses every paying sell with the belt: on
    // chain nobody holds a coin of it yet, so this state is never a sell
    let err = quote_swap(DIRECTION_SELL, 33_334, SUPPLY, 0, VIRTUAL, 0, 0, 0, None, None).unwrap_err();
    assert!(err.to_string().contains("CurveRealReserve"), "{err}");
    // the pool after a first buy of 1 SOL: R = 1 SOL, about 31,218 units per lamport of price
    let first = quote_swap(DIRECTION_BUY, SOL, SUPPLY, 0, VIRTUAL, 0, 0, 0, None, None).unwrap();
    let (b, r) = (first.reserve_out_after, first.reserve_in_after);
    let unit = (b as u128 / (r as u128 + VIRTUAL as u128)) as u64; // units a lamport buys
    let err = quote_swap(DIRECTION_SELL, 1, b, r, VIRTUAL, 0, 0, 0, None, None).unwrap_err();
    assert!(err.to_string().contains("ZeroAmount"), "{err}");
    let err = quote_swap(DIRECTION_SELL, unit - 1, b, r, VIRTUAL, 0, 0, 0, None, None).unwrap_err();
    assert!(err.to_string().contains("ZeroAmount"), "{err}");
    let q = quote_swap(DIRECTION_SELL, unit + 2, b, r, VIRTUAL, 0, 0, 0, None, None).unwrap();
    assert_eq!(q.amount_out, 1);
    println!("dust: a sell under {unit} units pays nothing and fails as ZeroAmount, with or without a hook");
    // the same on a seeded pool of the same shape
    let err = quote_swap(DIRECTION_SELL, 1, b, r + VIRTUAL, 0, 0, 0, 0, None, None).unwrap_err();
    assert!(err.to_string().contains("ZeroAmount"), "{err}");
    // a hook's own answer of zero is still the hook's error
    let err = quote_swap(DIRECTION_SELL, 1, b, r, VIRTUAL, 0, 0, 0, None, Some(0)).unwrap_err();
    assert!(err.to_string().contains("HookCurveInvalid"), "{err}");
    // buys: one lamport without fees buys 33,333 units; with the platform's fees the first
    // two lamports are eaten by the rounded-up fees (ZeroAmount), three lamports buy
    let q = quote_swap(DIRECTION_BUY, 1, SUPPLY, 0, VIRTUAL, 0, 0, 0, None, None).unwrap();
    assert_eq!(q.amount_out, SUPPLY / (VIRTUAL + 1));
    for a in [1u64, 2] {
        let err = quote_swap(DIRECTION_BUY, a, SUPPLY, 0, VIRTUAL, LP_FEE, PROTOCOL_FEE_BPS, 0, None, None).unwrap_err();
        assert!(err.to_string().contains("ZeroAmount"), "{err}");
    }
    let q = quote_swap(DIRECTION_BUY, 3, SUPPLY, 0, VIRTUAL, LP_FEE, PROTOCOL_FEE_BPS, 0, None, None).unwrap();
    assert_eq!(q.net_in, 1);
    assert_eq!(q.amount_out, SUPPLY / (VIRTUAL + 1));
}

// ---- 2. graduation on chain -------------------------------------------------------------------

/// PASS = the finding is closed (medium, integration design; fixed in the round-4 fix
/// round). CURVE-SPEC section 3.5 and 6 make the SDK append `graduate` to the buy that
/// crosses the target and to every trade on a pool that stands past it, and have the
/// watcher crank it too. `graduate` used to fail with `NotOnCurve` on a pool that already
/// graduated, so every such transaction that landed after the first graduation failed as
/// a whole. Now `graduate` on a graduated pool returns Ok, changes nothing and emits
/// nothing (`NotOnCurve` is kept for a seeded pool), so the appended graduate lands and the
/// trade executes on the graduated pool. Still shown, for the SDK: a trade quoted on the
/// curve and executed after graduation gets a worse fill (the depth shrinks from R + V to
/// R), so a tight `min_amount_out` computed on the curve fails with `Slippage`; the SDK
/// should quote both states and use the smaller output as the floor.
#[test]
fn review_a_graduate_appended_to_a_trade_fails_the_whole_trade_once_anyone_graduated_first() {
    let (mut env, maker, k, hook) = open(&TOKEN, LP_FEE);
    let a = wallet(&mut env, &maker, &k, 300 * SOL);
    let b = wallet(&mut env, &maker, &k, 300 * SOL);
    let anyone = env.user(SOL);
    buy(&mut env, &b, &k, &hook, 10 * SOL);
    reach_target(&mut env, &a, &k, &hook, 0);
    let p = env.pool(&k.pool);
    assert!(p.on_curve() && p.reserve_quote >= TARGET);

    // what the SDK hands wallet A: a buy with the exact curve quote as its floor, then graduate
    let qa = expect_swap(&p, DIRECTION_BUY, 5 * SOL, 0, None);
    let buy_a = env.swap_ix(&a.pubkey(), &k, &hook, DIRECTION_BUY, 5 * SOL, qa.amount_out);
    let buy_a_loose = env.swap_ix(&a.pubkey(), &k, &hook, DIRECTION_BUY, 5 * SOL, 0);
    // what it hands wallet B: a sell of half its coins, then graduate
    let held_b = env.balance(&coins_of(&k, &b.pubkey()));
    let qb = expect_swap(&p, DIRECTION_SELL, held_b / 2, 0, None);
    let sell_b = env.swap_ix(&b.pubkey(), &k, &hook, DIRECTION_SELL, held_b / 2, qb.amount_out);
    let sell_b_loose = env.swap_ix(&b.pubkey(), &k, &hook, DIRECTION_SELL, held_b / 2, 0);
    // and a 20 quote buy quoted on the curve, no graduate attached
    let q20 = expect_swap(&p, DIRECTION_BUY, 20 * SOL, 0, None);
    let buy_20 = env.swap_ix(&a.pubkey(), &k, &hook, DIRECTION_BUY, 20 * SOL, q20.amount_out);
    let grad = env.graduate_ix(&k);

    // the watcher, or any other wallet, lands graduate first
    env.ok(std::slice::from_ref(&grad), &[&anyone]);
    let graduated = env.pool(&k.pool);
    assert!(!graduated.on_curve());

    // at the same price and a smaller depth, a 20 quote buy quoted on the curve gets
    // fewer coins after graduation: the floor the SDK computed from the curve fails as
    // Slippage (checked before any other trade moves the price)
    let now20 = expect_swap(&graduated, DIRECTION_BUY, 20 * SOL, 0, None);
    assert!(now20.amount_out < q20.amount_out, "{} vs {} quoted on the curve", now20.amount_out, q20.amount_out);
    assert!((q20.amount_out - now20.amount_out) as u128 * 1_000 / q20.amount_out as u128 >= 30, "about 4% fewer coins here");
    env.err(&[buy_20], &[&a], "Slippage");

    // A's transaction LANDS: the buy executes on the graduated pool at its depth, the
    // appended graduate does nothing and emits nothing
    let (ca, qa0) = (env.balance(&coins_of(&k, &a.pubkey())), env.balance(&quote_of(&k, &a.pubkey())));
    let now_a = expect_swap(&graduated, DIRECTION_BUY, 5 * SOL, 0, None);
    let meta = env.ok(&[buy_a_loose.clone(), grad.clone()], &[&a]);
    assert_eq!(cpi_events::<Graduated>(&meta).len(), 0, "the appended graduate emitted nothing");
    assert_eq!((env.balance(&coins_of(&k, &a.pubkey())) - ca, qa0 - env.balance(&quote_of(&k, &a.pubkey()))), (now_a.amount_out, 5 * SOL), "A's buy happened, at the graduated pool's depth");
    let p = vaults(&env, &k);
    assert_eq!((p.reserve_quote, p.reserve_base, p.curve_state, p.virtual_quote), (now_a.reserve_in_after, now_a.reserve_out_after, CURVE_GRADUATED, 0));
    assert!(now_a.amount_out < qa.amount_out, "fewer coins than the curve quoted");
    // A's buy with the exact curve quote as its floor fails on its own: fewer coins after graduation
    env.err(&[buy_a], &[&a], "Slippage");
    // B's sell with the appended graduate lands likewise
    let p = env.pool(&k.pool);
    let now_b = expect_swap(&p, DIRECTION_SELL, held_b / 2, 0, None);
    let qb0 = env.balance(&quote_of(&k, &b.pubkey()));
    let meta = env.ok(&[sell_b_loose, grad.clone()], &[&b]);
    assert_eq!(cpi_events::<Graduated>(&meta).len(), 0);
    assert_eq!(env.balance(&coins_of(&k, &b.pubkey())), held_b - held_b / 2);
    assert_eq!(env.balance(&quote_of(&k, &b.pubkey())) - qb0, now_b.amount_out);
    assert!(now_b.amount_out < qb.amount_out, "paid less than the curve quoted");
    // a sell with the exact curve quote as its floor is paid less after graduation: Slippage
    env.err(&[sell_b, grad.clone()], &[&b], "Slippage");
    // graduate alone on the graduated pool: Ok, and the pool account is byte for byte the same
    let raw = env.svm.get_account(&k.pool).unwrap().data;
    let supply = env.mint_supply(&k.base_mint);
    let meta = env.ok(std::slice::from_ref(&grad), &[&anyone]);
    assert_eq!(env.svm.get_account(&k.pool).unwrap().data, raw);
    assert_eq!(env.mint_supply(&k.base_mint), supply);
    assert_eq!(cpi_events::<Graduated>(&meta).len(), 0);

    // uncontested, the appended graduate works: a fresh pool, one wallet, buy and graduate in one go
    let (mut env2, maker2, k2, hook2) = open(&TOKEN, LP_FEE);
    let c = wallet(&mut env2, &maker2, &k2, 300 * SOL);
    for _ in 0..4 {
        buy(&mut env2, &c, &k2, &hook2, 20 * SOL);
    }
    let p2 = env2.pool(&k2.pool);
    assert!(p2.reserve_quote < TARGET);
    let q = expect_swap(&p2, DIRECTION_BUY, 20 * SOL, 0, None);
    assert!(q.reserve_in_after >= TARGET, "this buy crosses the target");
    let ix = env2.swap_ix(&c.pubkey(), &k2, &hook2, DIRECTION_BUY, 20 * SOL, q.amount_out);
    let g2 = env2.graduate_ix(&k2);
    let meta = env2.ok(&[ix, g2], &[&c]);
    assert_eq!(cpi_events::<Graduated>(&meta).len(), 1);
    assert!(!env2.pool(&k2.pool).on_curve());
}

/// PASS = the attack lost. Graduation keeps the price and only changes the depth (R + V
/// becomes R - fee). A wallet that trades around it, in either order, ends worse off than
/// the same round trip without a graduation in between, on two pools walked identically.
#[test]
fn review_sandwiching_graduation_loses_in_both_orders() {
    // order 1: buy, graduate, sell everything; against buy, sell on an identical pool
    let mut loss = [0u64; 2];
    for (i, with_graduation) in [false, true].into_iter().enumerate() {
        let (mut env, maker, k, hook) = open(&TOKEN, LP_FEE);
        let crowd = wallet(&mut env, &maker, &k, 500 * SOL);
        let attacker = wallet(&mut env, &maker, &k, 500 * SOL);
        reach_target(&mut env, &crowd, &k, &hook, 0);
        let q0 = env.balance(&quote_of(&k, &attacker.pubkey()));
        buy(&mut env, &attacker, &k, &hook, 50 * SOL);
        if with_graduation {
            let anyone = env.user(SOL);
            let before = vaults(&env, &k);
            graduate(&mut env, &k, &anyone);
            assert_price_kept(&before, &vaults(&env, &k));
        }
        let held = env.balance(&coins_of(&k, &attacker.pubkey()));
        sell(&mut env, &attacker, &k, &hook, held);
        loss[i] = q0 - env.balance(&quote_of(&k, &attacker.pubkey()));
    }
    println!("buy-sell round trip of 50 quote at the target: loss {} without, {} with graduation in between", loss[0], loss[1]);
    assert!(loss[0] > 0 && loss[1] >= loss[0], "graduation in the middle made the round trip cheaper");

    // order 2: hold coins, sell everything, graduate, buy back with the proceeds; against the
    // same without the graduation
    let mut coins = [0u64; 2];
    let mut start = 0u64;
    for (i, with_graduation) in [false, true].into_iter().enumerate() {
        let (mut env, maker, k, hook) = open(&TOKEN, LP_FEE);
        let crowd = wallet(&mut env, &maker, &k, 500 * SOL);
        let attacker = wallet(&mut env, &maker, &k, 500 * SOL);
        buy(&mut env, &crowd, &k, &hook, 40 * SOL);
        buy(&mut env, &attacker, &k, &hook, 10 * SOL);
        start = env.balance(&coins_of(&k, &attacker.pubkey()));
        reach_target(&mut env, &crowd, &k, &hook, 0);
        // the crowd carries the pool well past the target, so the attacker's sell leaves it there
        for _ in 0..4 {
            buy(&mut env, &crowd, &k, &hook, 20 * SOL);
        }
        let q0 = env.balance(&quote_of(&k, &attacker.pubkey()));
        sell(&mut env, &attacker, &k, &hook, start);
        assert!(env.pool(&k.pool).reserve_quote >= TARGET, "the pool stays past the target after the sell");
        let proceeds = env.balance(&quote_of(&k, &attacker.pubkey())) - q0;
        if with_graduation {
            let anyone = env.user(SOL);
            graduate(&mut env, &k, &anyone);
        }
        buy(&mut env, &attacker, &k, &hook, proceeds);
        coins[i] = env.balance(&coins_of(&k, &attacker.pubkey()));
    }
    println!("sell-buy round trip at the target: {start} coins before, {} after without, {} with graduation in between", coins[0], coins[1]);
    assert!(coins[0] < start && coins[1] <= coins[0], "graduation in the middle gave coins away");
}

/// PASS = the attack lost. A buy of a billion SOL leaves about 30 coins in the pool. The
/// pool still graduates (one unit burned, price kept), the whale sells everything back and
/// is paid from the real reserve only, and every coin but the burned ones is back in the
/// vault. Nothing overflows at this size.
#[test]
fn review_a_whale_buy_that_leaves_a_handful_of_coins_still_graduates_and_pays_every_sell() {
    let (mut env, maker, k, hook) = open(&TOKEN, LP_FEE);
    let whale_quote = 1_000_000_000 * SOL; // 1e18 lamports
    let whale = wallet(&mut env, &maker, &k, whale_quote);
    buy(&mut env, &whale, &k, &hook, whale_quote);
    let p = vaults(&env, &k);
    assert!(p.reserve_base > 10_000_000 && p.reserve_base < 100_000_000, "about 30 coins left: {}", p.reserve_base);
    assert!(p.reserve_quote > whale_quote / 100 * 99);
    // at about 33 SOL per unit a 10 SOL buy pays nothing and is refused as a dust trade
    // (ZeroAmount since the round-4 fix round); 100 SOL buy 2 or 3 units
    let small = wallet(&mut env, &maker, &k, 110 * SOL);
    let ix = env.swap_ix(&small.pubkey(), &k, &hook, DIRECTION_BUY, 10 * SOL, 0);
    env.err(&[ix], &[&small], "ZeroAmount");
    let q = buy(&mut env, &small, &k, &hook, 100 * SOL);
    assert!(q.amount_out >= 1 && q.amount_out <= 3, "{}", q.amount_out);
    // graduation: the virtual part is now a rounding error next to the real reserve
    let before = vaults(&env, &k);
    let anyone = env.user(SOL);
    let meta = graduate(&mut env, &k, &anyone);
    let after = vaults(&env, &k);
    assert_price_kept(&before, &after);
    let e = &cpi_events::<Graduated>(&meta)[0];
    assert!(e.burned_base <= 2, "burned {}", e.burned_base);
    assert_eq!(after.reserve_base, before.reserve_base - e.burned_base);
    // the small wallet sells its units while the price is still astronomic: paid tens of SOL per unit
    let small_held = env.balance(&coins_of(&k, &small.pubkey()));
    let q = sell(&mut env, &small, &k, &hook, small_held);
    assert!(q.amount_out > 10 * SOL, "{}", q.amount_out);
    // the whale sells everything into the graduated pool: paid, from the real reserve, less than it put in
    let held = env.balance(&coins_of(&k, &whale.pubkey()));
    sell(&mut env, &whale, &k, &hook, held);
    assert!(env.balance(&quote_of(&k, &whale.pubkey())) < whale_quote);
    let p = vaults(&env, &k);
    assert_eq!(env.balance(&k.base_vault), SUPPLY - e.burned_base, "every coin came back but the burned ones");
    assert!(p.reserve_quote > 0);
}

/// PASS = the attack lost. A Token-2022 coin WITHOUT a transfer hook (the author did not
/// run this one) trades on the curve, graduates with the same burn path, and trades after.
/// Also the smallest buys on chain: 1 and 2 lamports are eaten by the fees, 3 lamports buy.
#[test]
fn review_a_token_2022_coin_without_a_transfer_hook_trades_and_graduates_on_the_curve() {
    let (mut env, maker, k, hook) = open(&TOKEN_2022, LP_FEE);
    let t = wallet(&mut env, &maker, &k, 300 * SOL);
    for a in [1u64, 2] {
        let ix = env.swap_ix(&t.pubkey(), &k, &hook, DIRECTION_BUY, a, 0);
        env.err(&[ix], &[&t], "greater than zero");
    }
    let q = buy(&mut env, &t, &k, &hook, 3);
    assert_eq!(q.amount_out, SUPPLY / (VIRTUAL + 1));
    reach_target(&mut env, &t, &k, &hook, 0);
    let before = vaults(&env, &k);
    let supply = env.mint_supply(&k.base_mint);
    let anyone = env.user(SOL);
    let meta = graduate(&mut env, &k, &anyone);
    let after = vaults(&env, &k);
    assert_price_kept(&before, &after);
    let e = &cpi_events::<Graduated>(&meta).remove(0);
    assert_eq!(env.mint_supply(&k.base_mint), supply - e.burned_base);
    assert_eq!((after.curve_state, after.virtual_quote), (CURVE_GRADUATED, 0));
    let held = env.balance(&coins_of(&k, &t.pubkey()));
    sell(&mut env, &t, &k, &hook, held / 3);
    buy(&mut env, &t, &k, &hook, SOL);
}

// ---- 3. fees at the hard caps, the hook's own trades, a hook that lies -----------------------

fn hook_swap_ix(env: &Env, k: &PoolKeys, authority: Pubkey, bump: u8, hook_base: Pubkey, hook_quote: Pubkey, direction: u8, amount: u64, min_out: u64) -> Instruction {
    Instruction {
        program_id: hook_evil::ID,
        accounts: hook_evil::accounts::SwapThenBurn {
            hook_authority: authority,
            platform: env.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            hook_base,
            hook_quote,
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: k.base_program,
            quote_token_program: TOKEN,
        }
        .to_account_metas(None),
        data: hook_evil::instruction::SwapAsHook { direction, amount_in: amount, min_amount_out: min_out, authority_bump: bump }.data(),
    }
}

fn hook_buy_burn_ix(env: &Env, k: &PoolKeys, authority: Pubkey, bump: u8, hook_quote: Pubkey, amount: u64, min_out: u64) -> Instruction {
    Instruction {
        program_id: hook_evil::ID,
        accounts: hook_evil::accounts::BuyBurn {
            hook_authority: authority,
            signer_pool: k.pool,
            platform: env.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            hook_quote,
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: k.base_program,
            quote_token_program: TOKEN,
        }
        .to_account_metas(None),
        data: hook_evil::instruction::BuyBurn { amount_in: amount, min_amount_out: min_out, authority_bump: bump }.data(),
    }
}

/// PASS = the attack lost. A curve pool whose hook takes the hard caps: a 90% fee override
/// (first half), then a 20% hook fee on both sides (second half), with the protocol fee at
/// its 1% cap. Three wallets, the hook's own `hook_swap` buys and sells and `hook_buy_burn`
/// buys, 240 random steps; then the hook answers a curve (refused: no `OVERRIDE_CURVE` in
/// its flags), the treasury collects its protocol fees and sells the coins back, and
/// everybody sells everything. After every step the vaults equal the reserves plus the fees,
/// the effective product never falls, every coin is accounted for, and no sell ever asks
/// for more than the real reserve.
#[test]
fn review_fees_at_the_hard_caps_with_the_hooks_own_trades_never_reach_the_belt() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    env.update_platform(hookpool::UpdatePlatformArgs {
        protocol_fee_bps: Some(100),
        max_hook_fee_bps: Some(2_000),
        max_fee_override_bps: Some(9_000),
        ..Default::default()
    });
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL | OVERRIDE_FEE | TAKE_HOOK_FEE);
    let maker = env.user(100 * SOL);
    let k = coin(&mut env, &maker, &TOKEN, SUPPLY);
    let hook = env.evil_hook(&maker, &k.pool, &k.quote_mint, &maker.pubkey(), hook_evil::MODE_FEE_OVERRIDE, 9_000);
    env.create_curve_pool(&maker, &k, LP_FEE, SUPPLY, &hook);
    let (authority, bump) = Pubkey::find_program_address(&[HOOK_AUTHORITY_SEED, k.pool.as_ref()], &hook_evil::ID);
    let hook_quote = env.create_ata(&maker, &authority, &k.quote_mint);
    env.mint_to(&maker, &k.quote_mint, &hook_quote, 50 * SOL);
    env.ok(&[Env::create_ata_ix(&maker.pubkey(), &authority, &k.base_mint)], &[&maker]);
    let hook_base = ata(&authority, &k.base_mint);
    let traders: Vec<Keypair> = (0..3).map(|_| wallet(&mut env, &maker, &k, 400 * SOL)).collect();
    let protocol_fee_bps: u16 = 100;
    let math = |p: &hookpool::Pool, direction: u8, amount: u64, hook_fee: u16, over: Option<u16>| {
        quote_swap(direction, amount, p.reserve_base, p.reserve_quote, p.virtual_quote, p.lp_fee_bps, protocol_fee_bps, hook_fee, over, None)
    };
    let conserved = |env: &Env| {
        let p = vaults(env, &k);
        let held: u64 = traders.iter().map(|t| env.balance(&coins_of(&k, &t.pubkey()))).sum();
        let (hb, vault, supply) = (env.balance(&hook_base), env.balance(&k.base_vault), env.mint_supply(&k.base_mint));
        let maker_coins = env.balance(&coins_of(&k, &maker.pubkey()));
        assert_eq!(
            held + hb + vault,
            supply,
            "a coin is lost or made: traders {held}, hook {hb}, vault {vault} (reserve {} + protocol {}), maker {maker_coins}, supply {supply}",
            p.reserve_base,
            p.protocol_fees_base
        );
        p
    };
    let mut rng = Rng(99);
    let mut k_prod = VIRTUAL as u128 * SUPPLY as u128;
    let (mut hook_fee, mut over): (u16, Option<u16>) = (0, Some(9_000));
    let (mut n_buy, mut n_sell, mut n_hook, mut n_burn) = (0, 0, 0, 0);
    for step in 0..240 {
        if step == 120 {
            env.evil_set_mode(&maker, &k.pool, hook_evil::MODE_HOOK_FEE, 2_000);
            (hook_fee, over) = (2_000, None);
        }
        let i = (rng.next() % 3) as usize;
        let t = &traders[i];
        let p = env.pool(&k.pool);
        match rng.next() % 8 {
            0..=2 => {
                let amount = rng.range(10_000_000, 3 * SOL);
                let q = math(&p, DIRECTION_BUY, amount, hook_fee, over).unwrap();
                let ix = env.swap_ix(&t.pubkey(), &k, &hook, DIRECTION_BUY, amount, q.amount_out);
                env.ok(&[compute_budget_ix(400_000), ix], &[t]);
                let after = conserved(&env);
                assert_eq!((after.reserve_quote, after.reserve_base), (q.reserve_in_after, q.reserve_out_after));
                n_buy += 1;
            }
            3..=4 => {
                let held = env.balance(&coins_of(&k, &t.pubkey()));
                if held == 0 {
                    continue;
                }
                let amount = if rng.next().is_multiple_of(4) { held } else { rng.range(1, held) };
                let Ok(q) = math(&p, DIRECTION_SELL, amount, hook_fee, over) else { continue };
                assert!(q.amount_out_gross <= p.reserve_quote, "step {step}: a sell asked for more than the real reserve");
                let ix = env.swap_ix(&t.pubkey(), &k, &hook, DIRECTION_SELL, amount, q.amount_out);
                env.ok(&[compute_budget_ix(400_000), ix], &[t]);
                let after = conserved(&env);
                assert_eq!((after.reserve_base, after.reserve_quote), (q.reserve_in_after, q.reserve_out_after));
                n_sell += 1;
            }
            5 => {
                // the hook buys for itself: no hook fee, no override, the pool's own curve
                let amount = rng.range(1_000_000, SOL / 5);
                let q = math(&p, DIRECTION_BUY, amount, 0, None).unwrap();
                env.ok(&[hook_swap_ix(&env, &k, authority, bump, hook_base, hook_quote, DIRECTION_BUY, amount, q.amount_out)], &[&maker]);
                let after = conserved(&env);
                assert_eq!((after.reserve_quote, after.reserve_base), (q.reserve_in_after, q.reserve_out_after));
                n_hook += 1;
            }
            6 => {
                let held = env.balance(&hook_base);
                if held == 0 {
                    continue;
                }
                let Ok(q) = math(&p, DIRECTION_SELL, held, 0, None) else { continue };
                assert!(q.amount_out_gross <= p.reserve_quote);
                env.ok(&[hook_swap_ix(&env, &k, authority, bump, hook_base, hook_quote, DIRECTION_SELL, held, q.amount_out)], &[&maker]);
                let after = conserved(&env);
                assert_eq!((after.reserve_base, after.reserve_quote), (q.reserve_in_after, q.reserve_out_after));
                n_hook += 1;
            }
            _ => {
                let amount = rng.range(1_000_000, SOL / 20);
                let q = math(&p, DIRECTION_BUY, amount, 0, None).unwrap();
                let supply = env.mint_supply(&k.base_mint);
                env.ok(&[hook_buy_burn_ix(&env, &k, authority, bump, hook_quote, amount, q.amount_out)], &[&maker]);
                assert_eq!(env.mint_supply(&k.base_mint), supply - q.amount_out);
                let after = conserved(&env);
                assert_eq!((after.reserve_quote, after.reserve_base), (q.reserve_in_after, q.reserve_out_after));
                n_burn += 1;
            }
        }
        let after = env.pool(&k.pool);
        let k2 = (after.reserve_quote as u128 + VIRTUAL as u128) * after.reserve_base as u128;
        assert!(k2 >= k_prod, "step {step}: the effective product fell");
        k_prod = k2;
        assert!(after.on_curve());
    }
    println!("cap walk: {n_buy} buys, {n_sell} sells, {n_hook} hook trades, {n_burn} buy-burns");
    assert!(n_buy > 50 && n_sell > 30 && n_hook > 10 && n_burn > 10);

    // the hook answers a curve: its flags do not grant it, on this pool or any other
    env.evil_set_mode(&maker, &k.pool, hook_evil::MODE_CURVE, 1_000_000);
    let ix = env.swap_ix(&traders[0].pubkey(), &k, &hook, DIRECTION_BUY, SOL, 0);
    env.err(&[compute_budget_ix(400_000), ix], &[&traders[0]], "HookPowerNotGranted");
    env.evil_set_mode(&maker, &k.pool, hook_evil::MODE_SILENT, 0);

    // the treasury collects the protocol fees (coins and quote) and sells its coins into the curve
    let treasury = env.treasury.insecure_clone();
    let p = env.pool(&k.pool);
    assert!(p.protocol_fees_base > 0 && p.protocol_fees_quote > 0);
    let ix = env.collect_ix(&treasury.pubkey(), &k);
    env.ok(&[ix], &[&treasury]);
    let coins = env.balance(&coins_of(&k, &treasury.pubkey()));
    assert_eq!(coins, p.protocol_fees_base, "the protocol fee coins went to the treasury");
    {
        let p = vaults(&env, &k);
        assert_eq!(p.protocol_fees_base, 0);
        let held: u64 = traders.iter().map(|t| env.balance(&coins_of(&k, &t.pubkey()))).sum();
        assert_eq!(held + env.balance(&hook_base) + env.balance(&k.base_vault) + coins, env.mint_supply(&k.base_mint));
    }
    let p = env.pool(&k.pool);
    let q = math(&p, DIRECTION_SELL, coins, 0, None).unwrap();
    assert!(q.amount_out_gross <= p.reserve_quote);
    let ix = env.swap_ix(&treasury.pubkey(), &k, &hook, DIRECTION_SELL, coins, q.amount_out);
    env.ok(&[compute_budget_ix(400_000), ix], &[&treasury]);
    // everybody sells everything: the hook, then the three wallets
    let held = env.balance(&hook_base);
    if held > 0 {
        let p = env.pool(&k.pool);
        let q = math(&p, DIRECTION_SELL, held, 0, None).unwrap();
        env.ok(&[hook_swap_ix(&env, &k, authority, bump, hook_base, hook_quote, DIRECTION_SELL, held, q.amount_out)], &[&maker]);
    }
    for t in &traders {
        let held = env.balance(&coins_of(&k, &t.pubkey()));
        if held == 0 {
            continue;
        }
        let p = env.pool(&k.pool);
        let q = math(&p, DIRECTION_SELL, held, 0, None).unwrap();
        assert!(q.amount_out_gross <= p.reserve_quote, "the final sell asked for more than the real reserve");
        let ix = env.swap_ix(&t.pubkey(), &k, &hook, DIRECTION_SELL, held, q.amount_out);
        env.ok(&[compute_budget_ix(400_000), ix], &[t]);
    }
    let p = vaults(&env, &k);
    // every coin that is still in existence is in the vault (the treasury's dust aside)
    assert_eq!(env.balance(&k.base_vault) + env.balance(&coins_of(&k, &treasury.pubkey())), env.mint_supply(&k.base_mint));
    assert!(p.reserve_quote > 0, "the fees stayed in the real reserve");
    println!("cap walk end: {} lamports of real reserve left, hook fees paid {}", p.reserve_quote, p.hook_fees_quote_total);
}

// ---- 4. the launchpad -------------------------------------------------------------------------

fn create_token_ix(dev: &Pubkey, mint: &Pubkey, name: &str, symbol: &str) -> Instruction {
    let metadata = Pubkey::find_program_address(&[b"metadata", MPL.as_ref(), mint.as_ref()], &MPL).0;
    Instruction {
        program_id: hooklaunch::ID,
        accounts: hooklaunch::accounts::CreateToken {
            dev: *dev,
            mint: *mint,
            dev_ata: ata(dev, mint),
            metadata,
            token_metadata_program: MPL,
            token_program: TOKEN,
            associated_token_program: ATA_PROGRAM,
            system_program: system_program::ID,
            rent: anchor_lang::solana_program::rent::ID,
        }
        .to_account_metas(None),
        data: hooklaunch::instruction::CreateToken {
            args: hooklaunch::CreateTokenArgs { name: name.into(), symbol: symbol.into(), uri: "https://example.invalid/meta.json".into(), decimals: 6, total_supply: SUPPLY },
        }
        .data(),
    }
}

fn launch_key(k: &PoolKeys) -> Pubkey {
    Pubkey::find_program_address(&[hooklaunch::LAUNCH_SEED, k.base_mint.as_ref()], &hooklaunch::ID).0
}

fn launch_curve_ix(env: &Env, dev: &Pubkey, k: &PoolKeys, hook: &HookRef, args: hooklaunch::LaunchCurveArgs) -> Instruction {
    let mut accounts = hooklaunch::accounts::LaunchPool {
        dev: *dev,
        platform: env.platform,
        treasury: env.treasury.pubkey(),
        launch: launch_key(k),
        base_mint: k.base_mint,
        quote_mint: k.quote_mint,
        pool: k.pool,
        base_vault: k.base_vault,
        quote_vault: k.quote_vault,
        lp_mint: k.lp_mint,
        lp_lock: k.lp_lock,
        dev_base: coins_of(k, dev),
        dev_quote: ata(dev, &k.quote_mint),
        dev_lp: ata(dev, &k.lp_mint),
        hook_program: hook.program,
        hook_program_data: hook.program_data(),
        hook_manifest: hook.manifest(),
        hook_extra_metas: hook.extra_metas(),
        hook_quote_treasury: if hook.treasury == system_program::ID { ata(dev, &k.quote_mint) } else { hook.treasury },
        hook_caller: hook.caller(),
        hookpool_program: hookpool::ID,
        hookpool_event_authority: event_authority_address(&hookpool::ID),
        base_token_program: k.base_program,
        quote_token_program: TOKEN,
        token_program: TOKEN,
        associated_token_program: ATA_PROGRAM,
        system_program: system_program::ID,
        event_authority: event_authority_address(&hooklaunch::ID),
        program: hooklaunch::ID,
    }
    .to_account_metas(None);
    accounts.extend(hook.extra.iter().cloned());
    Instruction { program_id: hooklaunch::ID, accounts, data: hooklaunch::instruction::LaunchCurve { args }.data() }
}

/// PASS = the attack lost. A dev buy of 90 quote crosses the target inside `launch_curve`
/// itself, and `graduate` runs in the same transaction, sent by the dev. The pool is born
/// graduated: the price is kept across the burn, the dev holds exactly what the curve gives
/// for 90 quote less fees, every LP share is locked, and selling it all back returns less
/// than was paid. No extra value comes out of a self-graduation.
#[test]
fn review_a_dev_buy_that_crosses_the_target_in_the_launch_graduates_in_the_same_transaction() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let authority = env.user(10 * SOL);
    let dev = env.user(20 * SOL);
    let quote = env.create_mint(&authority, 9);
    let q = env.create_ata(&dev, &dev.pubkey(), &quote);
    env.mint_to(&authority, &quote, &q, 200 * SOL);
    let mint = Keypair::new();
    env.ok(&[create_token_ix(&dev.pubkey(), &mint.pubkey(), "Self Grad", "SELF")], &[&dev, &mint]);
    let k = Env::pool_keys(&mint.pubkey(), &quote);
    let none = HookRef::none();
    let launch = launch_curve_ix(&env, &dev.pubkey(), &k, &none, hooklaunch::LaunchCurveArgs { lp_fee_bps: LP_FEE, dev_buy_quote: 90 * SOL, min_dev_buy_out: 1 });
    let grad = env.graduate_ix(&k);
    let meta = env.ok(&[compute_budget_ix(400_000), launch, grad], &[&dev]);
    let p = vaults(&env, &k);
    assert_eq!(p.curve_state, CURVE_GRADUATED);
    assert_eq!(p.virtual_quote, 0);
    // the dev's coins: the curve's answer for 90 quote on the fresh pool
    let expected = quote_swap(DIRECTION_BUY, 90 * SOL, SUPPLY, 0, VIRTUAL, LP_FEE, PROTOCOL_FEE_BPS, 0, None, None).unwrap();
    assert_eq!(env.balance(&coins_of(&k, &dev.pubkey())), expected.amount_out);
    assert!(expected.reserve_in_after >= TARGET);
    // the event carries the pool as the dev buy left it, and the burn kept the price
    let e = &cpi_events::<Graduated>(&meta)[0];
    assert_eq!((e.reserve_quote_before, e.reserve_base_before), (expected.reserve_in_after, expected.reserve_out_after));
    let before = hookpool::Pool { data: PoolData { reserve_base: e.reserve_base_before, reserve_quote: e.reserve_quote_before, virtual_quote: VIRTUAL, ..p.data } };
    assert_price_kept(&before, &p);
    assert_eq!(env.mint_supply(&k.base_mint), SUPPLY - e.burned_base);
    // every share locked, the record marked as a curve launch
    assert_eq!(env.balance(&k.lp_lock), env.mint_supply(&k.lp_mint));
    assert_eq!(env.balance(&ata(&dev.pubkey(), &k.lp_mint)), 0);
    let rec: hooklaunch::Launch = env.account(&launch_key(&k));
    assert_eq!((rec.reserved[0], rec.dev_buy_quote), (hooklaunch::LAUNCH_KIND_CURVE, 90 * SOL));
    // selling it all back pays less than the 90 that went in
    let held = env.balance(&coins_of(&k, &dev.pubkey()));
    let q0 = env.balance(&quote_of(&k, &dev.pubkey()));
    sell(&mut env, &dev, &k, &none, held);
    let back = env.balance(&quote_of(&k, &dev.pubkey())) - q0;
    assert!(back < 90 * SOL, "got {back} back for 90 SOL");
    println!("self-graduation: 90 SOL in, {back} lamports back after selling everything");
}

// ---- 5. a pegged coin on the curve, by the pool program directly -----------------------------

fn col_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &hook_collectible::ID).0
}
fn cfg_of(pool: &Pubkey) -> Pubkey {
    col_pda(&[hook_collectible::CFG_SEED, pool.as_ref()])
}
fn collection_of(pool: &Pubkey) -> Pubkey {
    col_pda(&[hook_collectible::COLLECTION_SEED, pool.as_ref()])
}
fn col_authority_of(pool: &Pubkey) -> Pubkey {
    col_pda(&[hook_collectible::AUTHORITY_SEED, pool.as_ref()])
}
fn ticket_of(pool: &Pubkey, user: &Pubkey) -> Pubkey {
    col_pda(&[hook_collectible::TICKET_SEED, pool.as_ref(), user.as_ref()])
}
fn queue_of(pool: &Pubkey) -> Pubkey {
    col_pda(&[QUEUE_SEED, pool.as_ref()])
}
fn validation_of(mint: &Pubkey) -> Pubkey {
    col_pda(&[VALIDATION_SEED, mint.as_ref()])
}
/// The collectible hook as `user` sees it, with what the coin's transfer hook needs.
fn collectible_hook_for(k: &PoolKeys, user: &Pubkey) -> HookRef {
    HookRef {
        program: hook_collectible::ID,
        treasury: system_program::ID,
        extra: vec![
            AccountMeta::new(cfg_of(&k.pool), false),
            AccountMeta::new(ticket_of(&k.pool, user), false),
            AccountMeta::new_readonly(SLOT_HASHES_ID, false),
            AccountMeta::new(ticket_of(&k.pool, &k.pool), false),
            AccountMeta::new(queue_of(&k.pool), false),
            AccountMeta::new_readonly(validation_of(&k.base_mint), false),
        ],
    }
}
fn go(env: &mut Env, slot: u64) {
    env.svm.warp_to_slot(slot);
    let v: Vec<(u64, Hash)> = (slot.saturating_sub(20)..slot).map(|s| (s, Hash::new_from_array(hashv(&[b"block", &s.to_le_bytes()]).to_bytes()))).collect();
    env.svm.set_sysvar(&SlotHashes::new(&v));
}
fn init_collection_ix(payer: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: hook_collectible::ID,
        accounts: hook_collectible::accounts::InitPoolConfig {
            payer: *payer,
            owner: *payer,
            cfg: cfg_of(pool),
            collection: collection_of(pool),
            collection_authority: col_authority_of(pool),
            core_program: MPL_CORE,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_collectible::instruction::InitPoolConfig {
            pool: *pool,
            args: hook_collectible::InitCollectionArgs { name: "Pegs".into(), uri_base: "https://example.invalid/art".into(), unit: 2_000 * 1_000_000, max_supply: 10_000, max_per_buy: 3, art: [1; 16] },
        }
        .data(),
    }
}
fn init_peg_ix(payer: &Pubkey, k: &PoolKeys) -> Instruction {
    Instruction {
        program_id: hook_collectible::ID,
        accounts: hook_collectible::accounts::InitPeg {
            payer: *payer,
            mint: k.base_mint,
            quote_mint: k.quote_mint,
            cfg: cfg_of(&k.pool),
            validation: validation_of(&k.base_mint),
            queue: queue_of(&k.pool),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_collectible::instruction::InitPeg {}.data(),
    }
}
fn open_ticket_ix(user: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: hook_collectible::ID,
        accounts: hook_collectible::accounts::OpenTicket { user: *user, ticket: ticket_of(pool, user), system_program: system_program::ID }.to_account_metas(None),
        data: hook_collectible::instruction::OpenTicket { pool: *pool }.data(),
    }
}

/// PASS = the finding is real (low). CURVE-SPEC section 4 puts "a pegged coin cannot launch
/// on the curve" in the LAUNCHPAD only (`CurvePegged`). The pool program has no such rule:
/// `create_curve_pool` called directly takes a Token-2022 coin whose transfer hook is the
/// collectible template, with the collectible as the pool's hook. The pool then trades,
/// earns pieces on buys, and graduates by burning in its vault, which runs no transfer
/// hook, so nothing breaks the peg here; the check the spec wanted is simply missing on
/// one of the two doors (for the mint authority the spec put it on both).
///
/// Proposed fix: refuse in `create_curve_pool` a base mint whose TransferHook program is
/// not `hook_rules` (or, more narrowly, is the collectible template), so that the rule
/// holds whoever creates the pool.
#[test]
fn review_the_pool_program_takes_a_pegged_coin_on_the_curve_that_the_launchpad_refuses() {
    let mut env = Env::new();
    let authority = env.user(10 * SOL);
    let maker = env.user(100 * SOL);
    let quote = env.create_mint(&authority, 9);
    env.create_ata(&maker, &maker.pubkey(), &quote);
    go(&mut env, 50);
    // the coin as a pegged launch leaves it: Token-2022, the collectible program as its
    // transfer hook with no authority, the whole supply in the maker's account, no mint authority
    let mint = Keypair::new();
    let space = t22::extension::ExtensionType::try_calculate_account_len::<t22::state::Mint>(&[t22::extension::ExtensionType::TransferHook]).unwrap();
    let acc = ata_with(&maker.pubkey(), &mint.pubkey(), &TOKEN_2022);
    env.ok(
        &[
            system_instruction::create_account(&maker.pubkey(), &mint.pubkey(), env.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
            t22::extension::transfer_hook::instruction::initialize(&TOKEN_2022, &mint.pubkey(), None, Some(hook_collectible::ID)).unwrap(),
            t22::instruction::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &maker.pubkey(), None, 6).unwrap(),
            Env::create_ata_with_ix(&maker.pubkey(), &maker.pubkey(), &mint.pubkey(), &TOKEN_2022),
            t22::instruction::mint_to(&TOKEN_2022, &mint.pubkey(), &acc, &maker.pubkey(), &[], SUPPLY).unwrap(),
            t22::instruction::set_authority(&TOKEN_2022, &mint.pubkey(), None, t22::instruction::AuthorityType::MintTokens, &maker.pubkey(), &[]).unwrap(),
        ],
        &[&maker, &mint],
    );
    let k = Env::pool_keys_with(&mint.pubkey(), &quote, &TOKEN_2022);
    env.ok(&[compute_budget_ix(300_000), init_collection_ix(&maker.pubkey(), &k.pool), init_peg_ix(&maker.pubkey(), &k)], &[&maker, &mint]);
    let cfg: hook_collectible::CollectionConfig = env.account(&cfg_of(&k.pool));
    assert!(cfg.pegged && cfg.base_mint == mint.pubkey());

    // the pool program refuses it on the curve, with its own CurvePegged, after the mint's
    // extensions were accepted (the collectible is the pool's own platform hook here)
    let hook = collectible_hook_for(&k, &maker.pubkey());
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, &hook);
    env.err(&[compute_budget_ix(500_000), ix], &[&maker], "pegged coin cannot open a pool on the curve");
    assert!(env.svm.get_account(&k.pool).is_none(), "nothing was made");
    assert_eq!(u32::from(hookpool::errors::HookpoolError::CurvePegged), 6050);

    // the same coin opens a SEEDED pool with the same hook: the collectible template's own
    // way, as before this round; a wallet with a ticket trades it and earns pieces
    env.mint_to(&authority, &quote, &ata(&maker.pubkey(), &quote), 100 * SOL);
    let ix = env.create_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, 10 * SOL, &hook);
    env.ok(&[compute_budget_ix(500_000), ix], &[&maker]);
    let p = vaults(&env, &k);
    assert!(!p.on_curve());
    assert_eq!((p.hook_program, p.reserve_base, p.reserve_quote, p.virtual_quote, p.curve_state), (hook_collectible::ID, SUPPLY, 10 * SOL, 0, CURVE_NONE));
    let w = wallet(&mut env, &authority, &k, 300 * SOL);
    env.ok(&[open_ticket_ix(&w.pubkey(), &k.pool)], &[&w]);
    let hw = collectible_hook_for(&k, &w.pubkey());
    let q = expect_swap(&p, DIRECTION_BUY, 20 * SOL, 0, None);
    let ix = env.swap_ix(&w.pubkey(), &k, &hw, DIRECTION_BUY, 20 * SOL, q.amount_out);
    env.ok(&[compute_budget_ix(400_000), ix], &[&w]);
    let ticket: hook_collectible::Ticket = env.account(&ticket_of(&k.pool, &w.pubkey()));
    assert!(ticket.pending() > 0, "the buy earned pieces");
    // and the seeded pool is not on the curve: graduate says so
    let anyone = env.user(SOL);
    let ix = env.graduate_ix(&k);
    env.err(&[ix], &[&anyone], "not on the curve");
    println!("a pegged collectible coin is refused on the curve by the pool program itself (CurvePegged 6050) and still opens a seeded pool");
}

// ---- 6. the buyback module across a graduation with the maximum fee ---------------------------

fn execute_buyback_ix(env: &Env, payer: &Pubkey, k: &PoolKeys, min_out: u64) -> Instruction {
    let authority = hook_authority_address(&k.pool, &hook_buyback::ID).0;
    Instruction {
        program_id: hook_buyback::ID,
        accounts: hook_buyback::accounts::ExecuteBuyback {
            payer: *payer,
            cfg: HookRef::cfg(&hook_buyback::ID, &k.pool),
            hook_authority: authority,
            platform: env.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            treasury_quote: ata(&authority, &k.quote_mint),
            authority_base: ata(&authority, &k.base_mint),
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: TOKEN,
            quote_token_program: TOKEN,
            event_authority: event_authority_address(&hook_buyback::ID),
            program: hook_buyback::ID,
        }
        .to_account_metas(None),
        data: hook_buyback::instruction::ExecuteBuyback { min_amount_out: min_out }.data(),
    }
}

fn burn_result(meta: &TransactionMetadata) -> (u8, u64, u64) {
    let d = &meta.return_data.data;
    assert_eq!(d.len(), 17);
    (d[0], u64::from_le_bytes(d[1..9].try_into().unwrap()), u64::from_le_bytes(d[9..17].try_into().unwrap()))
}

/// PASS = the attack lost. The buyback's observation is taken on the curve (effective depth
/// 115 SOL); the platform takes the maximum graduation fee (10% of the target) so the real
/// depth after graduation is about 91 SOL and the price is kept. The run after graduation
/// buys (no "price ran away" wait), its cap is measured on the SMALLER depth (the real one
/// now), and the new observation is the real pool. Also: a buy before the run cannot make
/// it spend more than the cap, and the graduation fee sits with the protocol fees.
#[test]
fn review_the_buyback_across_a_graduation_with_the_maximum_fee_buys_on_the_smaller_depth() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    env.update_platform(hookpool::UpdatePlatformArgs { curve_graduation_fee_bps: Some(1_000), ..Default::default() });
    let maker = env.user(100 * SOL);
    let k = coin(&mut env, &maker, &TOKEN, SUPPLY);
    let hook = env.buyback_hook(&maker, &k.pool, &k.base_mint, &k.quote_mint, 200, 200, 0);
    env.create_curve_pool(&maker, &k, LP_FEE, SUPPLY, &hook);
    assert_eq!(env.pool(&k.pool).graduation_fee_bps, 1_000);
    let trader = wallet(&mut env, &maker, &k, 300 * SOL);
    let anyone = env.user(SOL);
    let cfg = |env: &Env| -> hook_buyback::BuybackConfig { env.account(&HookRef::cfg(&hook_buyback::ID, &k.pool)) };
    reach_target(&mut env, &trader, &k, &hook, 200);
    let at_target = env.pool(&k.pool);
    // first run: the observation, effective
    let meta = env.ok(&[execute_buyback_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone]);
    assert_eq!(burn_result(&meta).0, BURN_OBSERVED);
    let c = cfg(&env);
    assert_eq!((c.obs_reserve_base, c.obs_reserve_quote), (at_target.reserve_base, at_target.reserve_quote + VIRTUAL));
    // 25 slots later a run buys at the standing price, a slice of the effective depth
    warp(&mut env, START_SLOT + 25);
    let p = env.pool(&k.pool);
    let treasury = env.balance(&hook.treasury);
    let meta = env.ok(&[execute_buyback_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone]);
    let (outcome, spent, _) = burn_result(&meta);
    assert_eq!(outcome, BURN_BOUGHT);
    let cap = ((p.reserve_quote + VIRTUAL) as u128 * 50 / 10_000) as u64;
    assert_eq!(spent, treasury.min(cap));
    let c = cfg(&env);
    let p = env.pool(&k.pool);
    assert_eq!((c.obs_reserve_base, c.obs_reserve_quote), (p.reserve_base, p.reserve_quote + VIRTUAL));

    // graduation with the 10% fee: the reserve loses 8.5 SOL to the protocol, the price holds
    warp(&mut env, START_SLOT + 50);
    let before = vaults(&env, &k);
    let meta = graduate(&mut env, &k, &anyone);
    let after = vaults(&env, &k);
    assert_price_kept(&before, &after);
    let e = &cpi_events::<Graduated>(&meta)[0];
    assert_eq!(e.fee_quote, TARGET / 10);
    assert_eq!(after.protocol_fees_quote, before.protocol_fees_quote + TARGET / 10);
    assert_eq!(after.reserve_quote, before.reserve_quote - TARGET / 10);
    assert!(after.reserve_quote < c.obs_reserve_quote, "the real depth is now below the observed effective one");
    // the run after it buys: graduation is not a price that ran away, and the cap follows the smaller depth
    let treasury = env.balance(&hook.treasury);
    assert!(treasury > 0);
    let meta = env.ok(&[execute_buyback_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone]);
    let (outcome, spent, burned) = burn_result(&meta);
    assert_eq!(outcome, BURN_BOUGHT, "graduation with a fee is no runaway");
    let cap = (after.reserve_quote.min(c.obs_reserve_quote) as u128 * 50 / 10_000) as u64;
    assert_eq!(spent, treasury.min(cap));
    assert!(spent > 0 && burned > 0);
    let (c2, p2) = (cfg(&env), env.pool(&k.pool));
    assert_eq!((c2.obs_reserve_base, c2.obs_reserve_quote), (p2.reserve_base, p2.reserve_quote), "the observation is the real pool now");
    // a pump right before the next run does not raise what it may spend, nor make it buy at the pump
    warp(&mut env, START_SLOT + 75);
    trade(&mut env, &trader, &k, &hook, DIRECTION_BUY, 10 * SOL, 200, None);
    let meta = env.ok(&[execute_buyback_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone]);
    assert_eq!(burn_result(&meta).0, BURN_WAITED, "a 10 SOL pump on a 90 SOL pool is a price that ran away");
    // the graduation fee is collected like every protocol fee
    let owed = env.pool(&k.pool).protocol_fees_quote;
    assert!(owed >= after.protocol_fees_quote);
    let ix = env.collect_ix(&anyone.pubkey(), &k);
    env.ok(&[ix], &[&anyone]);
    assert_eq!(env.balance(&ata(&env.treasury.pubkey(), &k.quote_mint)), owed);
    vaults(&env, &k);
}
