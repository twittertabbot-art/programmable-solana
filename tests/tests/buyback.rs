//! Buyback template: fees accrue to a PDA treasury, anyone triggers buy and burn
//! through the pool's hook_swap path.
//!
//! Anyone may call `execute_buyback` and choose its minimum, so a buyback never buys at a
//! price or on a depth its caller just made: it buys against an observation of the pool
//! that is at least 25 slots old, only while the price is within twice the cap of the
//! observed one, and spends a slice of the smaller of the two depths. A trade that
//! starts below the observed price lowers the observation.

use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use hook_buyback::BuybackConfig;
use hookpool::math::SwapQuote;
use hookpool_interface::*;
use hookpool_tests::*;
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;

const BASE_LIQ: u64 = 1_000_000_000_000;
const QUOTE_LIQ: u64 = 100 * SOL;
const TOO_SOON: &str = "observation of the pool is less than 25 slots old";

fn execute_ix(env: &Env, payer: &Pubkey, k: &PoolKeys, min_out: u64) -> Instruction {
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

fn init_ix(payer: &Pubkey, pool: &Pubkey, base_mint: &Pubkey, quote_mint: &Pubkey, buy: u16, sell: u16, min_quote: u64) -> Instruction {
    let authority = hook_authority_address(pool, &hook_buyback::ID).0;
    Instruction {
        program_id: hook_buyback::ID,
        accounts: hook_buyback::accounts::InitPoolConfig {
            payer: *payer,
            cfg: HookRef::cfg(&hook_buyback::ID, pool),
            hook_authority: authority,
            base_mint: *base_mint,
            quote_mint: *quote_mint,
            treasury_quote: ata(&authority, quote_mint),
            authority_base: ata(&authority, base_mint),
            base_token_program: TOKEN,
            quote_token_program: TOKEN,
            associated_token_program: ATA_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_buyback::instruction::InitPoolConfig { pool: *pool, buy_bps: buy, sell_bps: sell, min_quote }.data(),
    }
}

fn cfg_of(env: &Env, k: &PoolKeys) -> BuybackConfig {
    env.account(&HookRef::cfg(&hook_buyback::ID, &k.pool))
}

/// The events of `execute_buyback` in a transaction: an inner instruction of the program
/// to itself with data = e445a52e51cb9a1d + discriminator + borsh.
fn events(meta: &TransactionMetadata) -> Vec<hook_buyback::BuybackExecuted> {
    use anchor_lang::{AnchorDeserialize, Discriminator};
    const TAG: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
    meta.inner_instructions
        .iter()
        .flatten()
        .map(|i| &i.instruction.data)
        .filter(|d| d.len() >= 16 && d[..8] == TAG && d[8..16] == *hook_buyback::BuybackExecuted::DISCRIMINATOR)
        .map(|d| hook_buyback::BuybackExecuted::deserialize(&mut &d[16..]).unwrap())
        .collect()
}

/// One call of `execute_buyback` that must return Ok. Returns what it says it did, in its
/// return data: `(outcome, quote spent, coins burned)`. Checks that the event says the
/// same and carries the observation the call left, and that a call which did not buy
/// moved nothing.
fn run(env: &mut Env, who: &Keypair, k: &PoolKeys, min_out: u64) -> (u8, u64, u64) {
    let authority = hook_authority_address(&k.pool, &hook_buyback::ID).0;
    let treasury = ata(&authority, &k.quote_mint);
    let (before, supply, pool) = (env.balance(&treasury), env.mint_supply(&k.base_mint), env.pool(&k.pool));
    let meta = env.ok(&[execute_ix(env, &who.pubkey(), k, min_out)], &[who]);
    let d = &meta.return_data.data;
    assert_eq!(d.len(), 17, "return data of execute_buyback");
    assert_eq!(meta.return_data.program_id.to_bytes(), hook_buyback::ID.to_bytes());
    let said = (d[0], u64::from_le_bytes(d[1..9].try_into().unwrap()), u64::from_le_bytes(d[9..17].try_into().unwrap()));
    println!("execute_buyback, outcome {}: {} CU", said.0, meta.compute_units_consumed);
    let cfg = cfg_of(env, k);
    let e = &events(&meta)[0];
    assert_eq!((e.pool, e.outcome, e.quote_spent, e.base_burned, e.slot), (k.pool, said.0, said.1, said.2, env.clock().slot));
    assert_eq!((e.obs_reserve_base, e.obs_reserve_quote, e.slot), (cfg.obs_reserve_base, cfg.obs_reserve_quote, cfg.obs_slot));
    let after = env.pool(&k.pool);
    assert_eq!((cfg.obs_reserve_base, cfg.obs_reserve_quote), (after.reserve_base, after.reserve_quote), "the observation is the pool as the call left it");
    assert_eq!(before - env.balance(&treasury), said.1, "the treasury paid what the call says");
    assert_eq!(supply - env.mint_supply(&k.base_mint), said.2, "the supply fell by what the call says");
    if said.0 != BURN_BOUGHT {
        assert_eq!((said.1, said.2), (0, 0));
        assert_eq!((after.reserve_base, after.reserve_quote, after.swap_count), (pool.reserve_base, pool.reserve_quote, pool.swap_count));
    }
    said
}

fn warp(env: &mut Env, slot: u64) {
    let t = env.clock().unix_timestamp;
    env.set_clock(slot, t);
}

#[test]
fn fees_accrue_then_anyone_buys_back_and_burns() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let min_quote = SOL / 10;
    let hook = env.buyback_hook(&m.creator, &k.pool, &m.base_mint, &m.quote_mint, 200, 200, min_quote);
    warp(&mut env, 1_000);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_quote_treasury, hook.treasury);
    assert_eq!(hook.treasury, hook_buyback::treasury_address(&k.pool, &k.quote_mint, &TOKEN));
    assert_eq!(pool.hook_flags, hook_buyback::FLAGS);
    assert_eq!(hook_buyback::FLAGS, 12_865);

    // below threshold: refuse, and take no observation
    let anyone = env.user(SOL);
    env.err(&[execute_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone], "below min_quote");
    assert_eq!(cfg_of(&env, &k).obs_reserve_quote, 0);

    // trade until the treasury crosses the threshold
    let mut accrued = 0u64;
    while accrued < min_quote {
        let pool = env.pool(&k.pool);
        let q = expect_swap(&pool, DIRECTION_BUY, 2 * SOL, 200, None);
        let meta = env.swap(&m.trader, &k, &hook, DIRECTION_BUY, 2 * SOL, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
        println!("a buy on a buyback pool: {} CU", meta.compute_units_consumed);
        accrued += q.hook_fee;
    }
    assert_eq!(env.balance(&hook.treasury), accrued);

    // the first call of a pool takes the observation and buys nothing
    let pool_before = env.pool(&k.pool);
    assert_eq!(run(&mut env, &anyone, &k, u64::MAX), (BURN_OBSERVED, 0, 0));
    let cfg = cfg_of(&env, &k);
    assert_eq!((cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote), (1_000, pool_before.reserve_base, pool_before.reserve_quote));
    assert_eq!((cfg.buybacks, cfg.total_quote_spent), (0, 0));
    // a call that comes too soon fails and writes nothing
    env.err(&[execute_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone], TOO_SOON);
    warp(&mut env, 1_024);
    let failed = env.err(&[execute_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone], TOO_SOON);
    assert!(failed.meta.logs.iter().any(|l| l.contains("Error Number: 6007")));
    assert_eq!(cfg_of(&env, &k).obs_slot, 1_000);

    // 25 slots after the observation it buys: the whole treasury, which is below the cap
    warp(&mut env, 1_025);
    let supply_before = env.mint_supply(&k.base_mint);
    let expected = hookpool::math::quote_swap(DIRECTION_BUY, accrued, pool_before.reserve_base, pool_before.reserve_quote, pool_before.virtual_quote, pool_before.lp_fee_bps, PROTOCOL_FEE_BPS, 0, None, None).unwrap();
    // a caller cannot ask for more than the pool gives
    env.err(&[execute_ix(&env, &anyone.pubkey(), &k, expected.amount_out + 1)], &[&anyone], "output below min_amount_out");
    assert_eq!(run(&mut env, &anyone, &k, expected.amount_out), (BURN_BOUGHT, accrued, expected.amount_out));

    assert_eq!(env.balance(&hook.treasury), 0, "treasury spent");
    assert_eq!(env.mint_supply(&k.base_mint), supply_before - expected.amount_out, "bought tokens burned");
    let pool = env.pool(&k.pool);
    assert_eq!(pool.reserve_quote, expected.reserve_in_after);
    assert_eq!(pool.reserve_base, expected.reserve_out_after);
    assert_eq!(pool.hook_fees_quote_total, accrued, "hook_swap pays no hook fee");
    let cfg = cfg_of(&env, &k);
    assert_eq!(cfg.buybacks, 1);
    assert_eq!(cfg.total_quote_spent, accrued);
    assert_eq!(cfg.total_base_burned, expected.amount_out);
    assert_eq!((cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote), (1_025, expected.reserve_out_after, expected.reserve_in_after));
    // the config account: the observation is its last three fields, and nothing before
    // them moved
    let raw = env.svm.get_account(&HookRef::cfg(&hook_buyback::ID, &k.pool)).unwrap().data;
    assert_eq!(raw.len(), 230);
    let at = |o: usize| u64::from_le_bytes(raw[o..o + 8].try_into().unwrap());
    assert_eq!((at(206), at(214), at(222)), (cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote));
    assert_eq!((at(142), at(150), at(158), at(166)), (min_quote, cfg.total_quote_spent, cfg.total_base_burned, 1));
    assert_eq!(Pubkey::new_from_array(raw[174..206].try_into().unwrap()), m.creator.pubkey(), "creator stayed where it was");

    // a stranger cannot use hook_swap with their own signer
    let stranger = env.user(SOL);
    env.create_ata(&stranger, &stranger.pubkey(), &k.base_mint);
    env.create_ata(&stranger, &stranger.pubkey(), &k.quote_mint);
    let ix = Instruction {
        program_id: hookpool::ID,
        accounts: hookpool::accounts::HookSwap {
            hook_authority: stranger.pubkey(),
            platform: env.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            hook_base: ata(&stranger.pubkey(), &k.base_mint),
            hook_quote: ata(&stranger.pubkey(), &k.quote_mint),
            base_token_program: TOKEN,
            quote_token_program: TOKEN,
            event_authority: event_authority_address(&hookpool::ID),
            program: hookpool::ID,
        }
        .to_account_metas(None),
        data: hookpool::instruction::HookSwap { direction: DIRECTION_BUY, amount_in: 1, min_amount_out: 0, authority_bump: 255 }.data(),
    };
    env.err(&[ix], &[&stranger], "hook authority PDA does not match");
}

#[test]
fn pool_treasury_must_be_the_hook_pda_treasury() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.buyback_hook(&m.creator, &k.pool, &m.base_mint, &m.quote_mint, 200, 200, SOL);
    // point the pool at the creator's own quote account instead
    let wrong = HookRef { treasury: ata(&m.creator.pubkey(), &k.quote_mint), ..hook };
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &wrong);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "not this hook's treasury");
}

#[test]
fn a_config_is_for_the_pool_of_its_two_mints_and_cannot_be_blocked_or_made_unrunnable() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let c = m.creator.pubkey();
    // a minimum above 1 SOL could keep the buyback from ever running
    assert_eq!(hook_buyback::MAX_MIN_QUOTE, SOL);
    let ix = init_ix(&c, &k.pool, &k.base_mint, &k.quote_mint, 200, 200, SOL + 1);
    let failed = env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "min_quote above the maximum");
    assert!(failed.meta.logs.iter().any(|l| l.contains("Error Number: 6008")));
    // `pool` must be the pool of the two mints: not another address, not the pool of the
    // mints the other way round
    let other = Env::pool_keys(&m.quote_mint, &m.base_mint);
    for wrong in [Pubkey::new_unique(), other.pool] {
        let ix = init_ix(&c, &wrong, &k.base_mint, &k.quote_mint, 200, 200, SOL);
        env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "config does not belong to this pool");
    }
    // Anyone can create an associated token account for any owner. A stranger who creates
    // the treasury and the coin account first, and even puts something in them, does not
    // block the config.
    let authority = hook_authority_address(&k.pool, &hook_buyback::ID).0;
    let stranger = env.user(10 * SOL);
    env.ok(
        &[Env::create_ata_ix(&stranger.pubkey(), &authority, &k.quote_mint), Env::create_ata_ix(&stranger.pubkey(), &authority, &k.base_mint)],
        &[&stranger],
    );
    env.mint_to(&m.authority, &k.quote_mint, &ata(&authority, &k.quote_mint), 5_000);
    let ix = init_ix(&c, &k.pool, &k.base_mint, &k.quote_mint, 200, 200, SOL);
    env.ok(&[compute_budget_ix(400_000), ix.clone()], &[&m.creator]);
    let cfg = cfg_of(&env, &k);
    assert_eq!((cfg.pool, cfg.creator, cfg.min_quote, cfg.treasury), (k.pool, c, SOL, ata(&authority, &k.quote_mint)));
    assert_eq!((cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote), (0, 0, 0));
    // once
    env.svm.expire_blockhash();
    assert!(env.send(&[compute_budget_ix(400_000), ix], &[&m.creator]).is_err());
    // and the pool starts with it
    let hook = HookRef { program: hook_buyback::ID, treasury: ata(&authority, &k.quote_mint), extra: vec![anchor_lang::solana_program::instruction::AccountMeta::new(HookRef::cfg(&hook_buyback::ID, &k.pool), false)] };
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    assert_eq!(env.pool(&k.pool).hook_program, hook_buyback::ID);
}

#[test]
fn a_buyback_buys_against_an_old_observation_and_spends_one_slice_of_the_reserve_per_call() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.buyback_hook(&m.creator, &k.pool, &m.base_mint, &m.quote_mint, 200, 200, 1);
    warp(&mut env, 1_000);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    // stuff the treasury far beyond the cap: 4 SOL against a 100 SOL reserve
    env.mint_to(&m.authority, &m.quote_mint, &hook.treasury, 4 * SOL);
    // sure: 0.2% + 2% + 2%; a quarter is far above the ceiling
    assert_eq!(burn_cap_bps(PROTOCOL_FEE_BPS, 30, 200, 200), hook_buyback::MAX_BUYBACK_BPS);
    assert_eq!((BURN_INTERVAL_SLOTS, hook_buyback::MAX_BUYBACK_BPS), (25, 50));
    let cap = QUOTE_LIQ * 50 / 10_000;
    assert_eq!(cap, SOL / 2);
    let anyone = env.user(SOL);
    let me = anyone.pubkey();

    // the first call only observes
    assert_eq!(run(&mut env, &anyone, &k, 0), (BURN_OBSERVED, 0, 0));
    assert_eq!(env.balance(&hook.treasury), 4 * SOL);
    // not in the same slot, not one slot early, and never twice in one transaction
    env.err(&[execute_ix(&env, &me, &k, 0)], &[&anyone], TOO_SOON);
    warp(&mut env, 1_024);
    env.err(&[execute_ix(&env, &me, &k, 0)], &[&anyone], TOO_SOON);
    warp(&mut env, 1_025);
    let ix = execute_ix(&env, &me, &k, 0);
    env.err(&[compute_budget_ix(400_000), ix.clone(), ix], &[&anyone], TOO_SOON);
    // one slice
    let (outcome, spent, burned) = run(&mut env, &anyone, &k, 0);
    assert_eq!((outcome, spent), (BURN_BOUGHT, cap), "only the cap was spent");
    assert!(burned > 0);
    assert_eq!(env.balance(&hook.treasury), 4 * SOL - cap);
    let pool = env.pool(&k.pool);
    assert!(pool.reserve_quote > QUOTE_LIQ && pool.reserve_quote <= QUOTE_LIQ + cap);
    let cfg = cfg_of(&env, &k);
    assert_eq!((cfg.total_quote_spent, cfg.buybacks, cfg.obs_slot), (cap, 1, 1_025));

    // the next slice 25 slots later, of the pool the buy before it left
    warp(&mut env, 1_049);
    env.err(&[execute_ix(&env, &me, &k, 0)], &[&anyone], TOO_SOON);
    warp(&mut env, 1_050);
    let reserve = env.pool(&k.pool).reserve_quote;
    assert_eq!(run(&mut env, &anyone, &k, 0).1, reserve * 50 / 10_000);
    assert_eq!(cfg_of(&env, &k).buybacks, 2);

    // a buy takes the price 10% up: the next call buys nothing and observes again
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, 5 * SOL, 0).unwrap();
    warp(&mut env, 1_075);
    let before = env.balance(&hook.treasury);
    assert_eq!(run(&mut env, &anyone, &k, 0), (BURN_WAITED, 0, 0));
    assert_eq!(env.balance(&hook.treasury), before);
    let cfg = cfg_of(&env, &k);
    assert_eq!((cfg.buybacks, cfg.obs_slot), (2, 1_075));
    // calling again does not keep it waiting: too soon, nothing written
    env.err(&[execute_ix(&env, &me, &k, 0)], &[&anyone], TOO_SOON);
    // the price stood for 25 slots: it buys
    warp(&mut env, 1_100);
    let reserve = env.pool(&k.pool).reserve_quote;
    let (outcome, spent, _) = run(&mut env, &anyone, &k, 0);
    assert_eq!((outcome, spent), (BURN_BOUGHT, reserve * 50 / 10_000));
    let observed = cfg_of(&env, &k);

    // a sell that starts AT the observed price leaves the observation alone ...
    let coins = env.balance(&ata(&m.trader.pubkey(), &k.base_mint)) / 10;
    env.swap(&m.trader, &k, &hook, DIRECTION_SELL, coins, 0).unwrap();
    let cfg = cfg_of(&env, &k);
    assert_eq!((cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote), (observed.obs_slot, observed.obs_reserve_base, observed.obs_reserve_quote));
    // ... and the trade after it starts below: the observation is the pool it found, and
    // its slot stays, so the next buyback is not postponed
    let pool = env.pool(&k.pool);
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL / 100, 0).unwrap();
    let cfg = cfg_of(&env, &k);
    assert_eq!((cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote), (observed.obs_slot, pool.reserve_base, pool.reserve_quote));
    // a price that fell is no reason to wait, and the slice is of the smaller pool
    warp(&mut env, 1_125);
    let now = env.pool(&k.pool).reserve_quote;
    assert!(now < observed.obs_reserve_quote);
    let (outcome, spent, _) = run(&mut env, &anyone, &k, 0);
    assert_eq!((outcome, spent), (BURN_BOUGHT, now.min(pool.reserve_quote) * 50 / 10_000));
}

#[test]
fn the_buyback_cap_follows_what_a_buy_and_a_sell_cost_on_the_pool() {
    // (pool fee, buy bps, sell bps, platform hook fee cap) and the slice of the reserve
    // one buyback may spend, in bps. "sure" = protocol (20) + buy + sell, each side bounded
    // by the platform's cap: what a position of any size pays in full. "soft" = protocol +
    // twice the pool fee: what a position much larger than the pool mostly gets back. The
    // cap is a quarter of sure + min(sure, soft), between 1 and 50.
    for (lp, buy, sell, platform_cap, expected_bps) in [
        (30u16, 200u16, 200u16, 1_000u16, 50u64), // (420 + 80) / 4 = 125: the ceiling
        (0, 5, 5, 1_000, 12),                     // (30 + 20) / 4
        (0, 0, 0, 1_000, 10),                     // (20 + 20) / 4: the protocol fee alone
        (30, 0, 60, 1_000, 40),                   // (80 + 80) / 4
        (30, 1_000, 1_000, 20, 30),               // the platform charges 20 a side: (60 + 60) / 4
        (100, 300, 300, 0, 10),                   // sure is 20: the pool fee counts for 20
        (1_000, 0, 0, 1_000, 10),                 // the same with a pool fee of 10%
    ] {
        let mut env = Env::new();
        let m = env.market();
        let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
        let hook = env.buyback_hook(&m.creator, &k.pool, &m.base_mint, &m.quote_mint, buy, sell, 1);
        warp(&mut env, 1_000);
        env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, lp, BASE_LIQ, QUOTE_LIQ, &hook);
        env.update_platform(hookpool::UpdatePlatformArgs { max_hook_fee_bps: Some(platform_cap), ..Default::default() });
        env.mint_to(&m.authority, &m.quote_mint, &hook.treasury, 2 * SOL);
        assert_eq!(cfg_of(&env, &k).cap_bps(PROTOCOL_FEE_BPS, platform_cap, lp), expected_bps);
        let anyone = env.user(SOL);
        assert_eq!(run(&mut env, &anyone, &k, 0).0, BURN_OBSERVED);
        warp(&mut env, 1_025);
        let (outcome, spent, _) = run(&mut env, &anyone, &k, 0);
        assert_eq!((outcome, spent), (BURN_BOUGHT, QUOTE_LIQ * expected_bps / 10_000), "pool fee {lp}, {buy}/{sell}, platform cap {platform_cap}");
        // the tolerance on the price is twice the cap: a buy that moves it by less gets
        // the next buyback, a buy that moves it by more makes it wait
        warp(&mut env, 1_050);
        let pool = env.pool(&k.pool);
        let inside = pool.reserve_quote * expected_bps / 10_000 / 2;
        env.swap(&m.trader, &k, &hook, DIRECTION_BUY, inside, 0).unwrap();
        assert_eq!(run(&mut env, &anyone, &k, 0).0, BURN_BOUGHT, "pool fee {lp}, {buy}/{sell}: a buy of {inside}");
        warp(&mut env, 1_075);
        let pool = env.pool(&k.pool);
        let outside = pool.reserve_quote * expected_bps / 10_000 * 2;
        env.swap(&m.trader, &k, &hook, DIRECTION_BUY, outside, 0).unwrap();
        assert_eq!(run(&mut env, &anyone, &k, 0).0, BURN_WAITED, "pool fee {lp}, {buy}/{sell}: a buy of {outside}");
    }
}

/// A pool with a treasury somebody left to grow, observed 25 slots ago. Returns a wallet
/// with 10,000 SOL and no coin.
fn a_treasury_worth_attacking(lp: u16, buy: u16, sell: u16, min_quote: u64, treasury: u64) -> (Env, Market, PoolKeys, HookRef, Keypair) {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.buyback_hook(&m.creator, &k.pool, &m.base_mint, &m.quote_mint, buy, sell, min_quote);
    warp(&mut env, 1_000);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, lp, BASE_LIQ, QUOTE_LIQ, &hook);
    env.mint_to(&m.authority, &m.quote_mint, &hook.treasury, treasury);
    let attacker = env.user(10 * SOL);
    env.fund(&attacker, &m.authority, &m.base_mint, &m.quote_mint, 0, 10_000 * SOL);
    env.create_ata(&attacker, &attacker.pubkey(), &k.lp_mint);
    let keeper = env.user(SOL);
    assert_eq!(run(&mut env, &keeper, &k, 0).0, BURN_OBSERVED);
    warp(&mut env, 1_025);
    (env, m, k, hook, attacker)
}

/// Buy `size`, one buyback, sell what was bought, in ONE transaction. Returns what the
/// wallet's quote balance changed by, what the two trades alone would have cost, and
/// what the buyback in it did.
fn sandwich(env: &mut Env, who: &Keypair, k: &PoolKeys, hook: &HookRef, buy_bps: u16, sell_bps: u16, size: u64) -> (i128, i128, u8) {
    let pool = env.pool(&k.pool);
    let quote = |d: u8, amount: u64, rb: u64, rq: u64, hook_bps: u16| {
        hookpool::math::quote_swap(d, amount, rb, rq, 0, pool.lp_fee_bps, PROTOCOL_FEE_BPS, hook_bps, None, None).unwrap()
    };
    let front: SwapQuote = quote(DIRECTION_BUY, size, pool.reserve_base, pool.reserve_quote, buy_bps);
    let plain = quote(DIRECTION_SELL, front.amount_out, front.reserve_out_after, front.reserve_in_after, sell_bps);
    let user = who.pubkey();
    let ixs = [
        compute_budget_ix(600_000),
        env.swap_ix(&user, k, hook, DIRECTION_BUY, size, front.amount_out),
        execute_ix(env, &user, k, 0),
        env.swap_ix(&user, k, hook, DIRECTION_SELL, front.amount_out, 0),
    ];
    let account = ata(&user, &k.quote_mint);
    let before = env.balance(&account);
    let meta = env.ok(&ixs, &[who]);
    (env.balance(&account) as i128 - before as i128, size as i128 - plain.amount_out as i128, events(&meta)[0].outcome)
}

#[test]
fn buying_before_a_buyback_and_selling_after_it_loses_money() {
    // (pool fee, buy bps, sell bps): an ordinary buyback coin, two with hardly any fee, and
    // one whose only real fee is the pool's own
    for (lp, buy, sell) in [(30u16, 200u16, 200u16), (0, 5, 5), (0, 0, 0), (100, 0, 0)] {
        // a treasury left to grow to 5% of the reserve
        let (mut env, _m, k, hook, attacker) = a_treasury_worth_attacking(lp, buy, sell, 1, 5 * SOL);
        let a = attacker.pubkey();

        // stacking buybacks between the buy and the sell: the first one finds the price
        // pumped and waits, the second one is too soon and fails the transaction
        let run = execute_ix(&env, &a, &k, 0);
        let ixs = [
            compute_budget_ix(1_000_000),
            env.swap_ix(&a, &k, &hook, DIRECTION_BUY, 40 * SOL, 0),
            run.clone(),
            run,
            env.swap_ix(&a, &k, &hook, DIRECTION_SELL, 1_000_000, 0),
        ];
        env.err(&ixs, &[&attacker], TOO_SOON);

        // one buyback per transaction. A position small enough to leave the price inside
        // the tolerance gets its buyback and loses; a larger one finds it waiting and
        // loses what its trades cost. Also one thirty times the pool.
        let mut slot = 1_025;
        let (mut bought, mut waited) = (0, 0);
        for size in [SOL / 50, SOL / 20, SOL / 5, SOL / 2, 5 * SOL, 40 * SOL, 150 * SOL, 3_000 * SOL] {
            slot += BURN_INTERVAL_SLOTS;
            warp(&mut env, slot);
            let (change, cost, outcome) = sandwich(&mut env, &attacker, &k, &hook, buy, sell, size);
            println!("pool fee {lp}, {buy}/{sell} bps, {size} lamports around one buyback (outcome {outcome}): {change} lamports, its trades alone cost {cost}");
            assert!(change < 0, "pool fee {lp}, {buy}/{sell}: a sandwich of {size} paid {change}");
            // what the buyback gave back is at most about half of what the two trades cost
            assert!((cost + change) * 100 <= cost * 55, "gained {} of {cost}", cost + change);
            if outcome == BURN_BOUGHT {
                bought += 1;
            } else {
                assert_eq!(outcome, BURN_WAITED);
                assert_eq!(change, -cost, "a buyback that waits changes nothing for the wallet");
                waited += 1;
            }
        }
        assert!(bought >= 2 && waited >= 3, "pool fee {lp}, {buy}/{sell}: {bought} bought, {waited} waited");
    }
}

/// The five instructions in ONE transaction: BUY `size`, add every coin bought as
/// liquidity, the buyback, take the liquidity out, SELL. Only for a buyback that does not
/// buy (the amounts after it are computed for a pool it left alone). Returns what the
/// wallet's quote balance changed by and what the buyback did.
fn pump_deepen_run_leave(env: &mut Env, who: &Keypair, k: &PoolKeys, hook: &HookRef, buy_bps: u16, size: u64) -> (i128, u8) {
    let user = who.pubkey();
    let pool = env.pool(&k.pool);
    let supply = env.mint_supply(&k.lp_mint);
    let front = hookpool::math::quote_swap(DIRECTION_BUY, size, pool.reserve_base, pool.reserve_quote, pool.virtual_quote, pool.lp_fee_bps, PROTOCOL_FEE_BPS, buy_bps, None, None).unwrap();
    let (rb, rq) = (front.reserve_out_after, front.reserve_in_after);
    let ceil = |lp: u64, r: u64, s: u64| (lp as u128 * r as u128).div_ceil(s as u128) as u64;
    let mut lp = (front.amount_out as u128 * supply as u128 / rb as u128) as u64;
    while ceil(lp, rb, supply) > front.amount_out {
        lp -= 1;
    }
    let (b, q) = (ceil(lp, rb, supply), ceil(lp, rq, supply));
    // out again: rounded down, from the pool the deposit made
    let back = (lp as u128 * (rb + b) as u128 / (supply + lp) as u128) as u64;
    let ixs = [
        compute_budget_ix(800_000),
        env.swap_ix(&user, k, hook, DIRECTION_BUY, size, front.amount_out),
        env.add_liquidity_ix(&user, k, hook, lp, b, q),
        execute_ix(env, &user, k, 0),
        env.remove_liquidity_ix(&user, k, hook, lp, 0, 0),
        env.swap_ix(&user, k, hook, DIRECTION_SELL, front.amount_out - b + back, 0),
    ];
    let account = ata(&user, &k.quote_mint);
    let before = env.balance(&account);
    let meta = env.ok(&ixs, &[who]);
    assert_eq!(env.balance(&ata(&user, &k.base_mint)), 0, "the wallet sold every coin it had");
    assert_eq!(env.balance(&ata(&user, &k.lp_mint)), 0);
    (env.balance(&account) as i128 - before as i128, events(&meta)[0].outcome)
}

#[test]
fn pumping_the_price_and_deepening_the_pool_around_a_buyback_ends_in_a_loss() {
    // The reviewer's transaction on this hook: BUY, add_liquidity with every coin bought,
    // execute_buyback, remove_liquidity, SELL. Liquidity costs no trading fee and made a
    // slice of the reserve a much larger amount, spent at the pumped price and mostly
    // into the wallet's own liquidity: one transaction ended 0.99 SOL up.
    // 1% on each side, a minimum of 1 SOL (the most a config may ask for), and a
    // treasury left to grow to 8 SOL.
    let (mut env, m, k, hook, attacker) = a_treasury_worth_attacking(30, 100, 100, SOL, 8 * SOL);
    let honest = env.pool(&k.pool);
    let treasury = env.balance(&hook.treasury);

    let (first, outcome) = pump_deepen_run_leave(&mut env, &attacker, &k, &hook, 100, 400 * SOL);
    println!("BUY 400 SOL, add_liquidity, execute_buyback, remove_liquidity, SELL: outcome {outcome}, the wallet's balance changed by {first} lamports");
    assert_eq!(outcome, BURN_WAITED, "the buyback buys nothing at a price that is not the observed one");
    assert!(first < -9 * SOL as i128, "{first}");
    // the treasury only grew, by the fee of the wallet's own two trades
    assert!(env.balance(&hook.treasury) > treasury + 7 * SOL);
    let cfg = cfg_of(&env, &k);
    assert_eq!((cfg.buybacks, cfg.obs_slot), (0, 1_025));
    assert!(
        cfg.obs_reserve_quote as u128 * honest.reserve_base as u128 > 20 * honest.reserve_quote as u128 * cfg.obs_reserve_base as u128,
        "that call recorded the pumped price, more than twenty times the honest one"
    );

    // The same transaction 25 slots later would find the price "unchanged" against that
    // observation. But its pump is a buy that starts at the honest price, and a trade
    // that starts below the observed price lowers the observation.
    warp(&mut env, 1_050);
    let before = env.pool(&k.pool);
    let (second, outcome) = pump_deepen_run_leave(&mut env, &attacker, &k, &hook, 100, 400 * SOL);
    println!("the same transaction 25 slots later: outcome {outcome}, the wallet's balance changed by {second} lamports");
    assert_eq!(outcome, BURN_WAITED);
    assert!(second < -9 * SOL as i128, "{second}");
    assert_eq!(cfg_of(&env, &k).buybacks, 0, "nothing was ever bought at a pumped price");
    assert!(before.reserve_quote < 2 * honest.reserve_quote);

    // the buyback itself goes on: 25 slots later it buys a slice of the pool as it is
    warp(&mut env, 1_075);
    let keeper = env.user(SOL);
    let reserve = env.pool(&k.pool).reserve_quote;
    let (outcome, spent, _) = run(&mut env, &keeper, &k, 0);
    assert_eq!((outcome, spent), (BURN_BOUGHT, reserve * 50 / 10_000));

    // liquidity alone, from a wallet that holds the coin: the pool is twelve times
    // deeper for one transaction and the buyback still spends a slice of the observed pool
    let whale = env.user(10 * SOL);
    env.fund(&whale, &m.authority, &m.base_mint, &m.quote_mint, 20 * BASE_LIQ, 5_000 * SOL);
    env.create_ata(&whale, &whale.pubkey(), &k.lp_mint);
    warp(&mut env, 1_100);
    let pool = env.pool(&k.pool);
    let supply = env.mint_supply(&k.lp_mint);
    let w = whale.pubkey();
    let ixs = [
        compute_budget_ix(600_000),
        env.add_liquidity_ix(&w, &k, &hook, 11 * supply, u64::MAX, u64::MAX),
        execute_ix(&env, &w, &k, 0),
        env.remove_liquidity_ix(&w, &k, &hook, 11 * supply, 0, 0),
    ];
    let meta = env.ok(&ixs, &[&whale]);
    let e = &events(&meta)[0];
    assert_eq!((e.outcome, e.quote_spent), (BURN_BOUGHT, pool.reserve_quote * 50 / 10_000), "not a slice of the twelve times deeper pool");
}

#[test]
fn liquidity_and_a_nudge_of_the_price_do_not_raise_what_a_buyback_spends() {
    // One transaction by a wallet that holds a lot of the coin: add_liquidity (the pool
    // is twelve times deeper), a small SELL (it starts AT the observed price and leaves
    // the price just below it), a second small SELL (it starts below the observed price,
    // so the observation is lowered), execute_buyback, remove_liquidity. When the
    // lowering copied the pool's reserves, the second sell wrote the deepened pool into
    // the observation with its old slot, and the buyback spent a slice of that: the whole
    // treasury in one call. The lowering moves the observed price and never raises the
    // observed depth.
    let (mut env, m, k, hook, _attacker) = a_treasury_worth_attacking(30, 100, 100, SOL, 8 * SOL);
    let whale = env.user(10 * SOL);
    env.fund(&whale, &m.authority, &m.base_mint, &m.quote_mint, 20 * BASE_LIQ, 5_000 * SOL);
    env.create_ata(&whale, &whale.pubkey(), &k.lp_mint);
    let honest = env.pool(&k.pool);
    let before = cfg_of(&env, &k);
    assert_eq!((before.obs_reserve_base, before.obs_reserve_quote, before.obs_slot), (honest.reserve_base, honest.reserve_quote, 1_000));
    let slice = honest.reserve_quote * 50 / 10_000;
    let treasury = env.balance(&hook.treasury);
    assert!(treasury > 12 * slice, "the treasury could fill a slice of the deepened pool");
    let supply = env.mint_supply(&k.lp_mint);
    let w = whale.pubkey();

    // the first three instructions alone, to look at the observation they leave
    let nudge = [
        compute_budget_ix(800_000),
        env.add_liquidity_ix(&w, &k, &hook, 11 * supply, u64::MAX, u64::MAX),
        env.swap_ix(&w, &k, &hook, DIRECTION_SELL, 1_000_000, 0),
    ];
    env.ok(&nudge, &[&whale]);
    let cfg = cfg_of(&env, &k);
    assert_eq!((cfg.obs_reserve_base, cfg.obs_reserve_quote), (honest.reserve_base, honest.reserve_quote), "a sell that starts at the observed price changes nothing");
    let deep = env.pool(&k.pool);
    assert!(deep.reserve_quote > 11 * honest.reserve_quote);
    // the rest in one transaction: the second sell, the buyback, the liquidity out
    let ixs = [
        compute_budget_ix(800_000),
        env.swap_ix(&w, &k, &hook, DIRECTION_SELL, 1_000_000, 0),
        execute_ix(&env, &w, &k, 0),
        env.remove_liquidity_ix(&w, &k, &hook, 11 * supply, 0, 0),
    ];
    // what the second sell alone does to the observation: simulated by sending it first
    // on its own would move the pool, so read it from the helper the program uses
    let (lowered_base, lowered_quote) = burn_lowered(cfg.obs_reserve_base, cfg.obs_reserve_quote, deep.reserve_base, deep.reserve_quote).expect("the second sell starts below the observed price");
    assert_eq!(lowered_quote, honest.reserve_quote, "the observed depth does not move");
    assert!(lowered_base > honest.reserve_base);
    assert!(lowered_quote as u128 * deep.reserve_base as u128 <= lowered_base as u128 * deep.reserve_quote as u128, "not above the price the trade started at");
    let meta = env.ok(&ixs, &[&whale]);
    let e = &events(&meta)[0];
    println!("add_liquidity, SELL, SELL, execute_buyback, remove_liquidity: the buyback spent {} (an honest slice is {slice})", e.quote_spent);
    assert_eq!((e.outcome, e.quote_spent), (BURN_BOUGHT, slice), "one slice of the pool as it was observed, not of the twelve times deeper one");
    // the treasury still holds the rest (and the fees of the two small sells)
    let left = env.balance(&hook.treasury);
    assert!(left >= treasury - slice && left > 11 * slice);
    assert_eq!(cfg_of(&env, &k).buybacks, 1);

    // on chain, the lowering alone: a deep add and two small sells, and the observation
    // keeps its depth and its slot while its price follows the pool
    warp(&mut env, 1_050);
    let before = cfg_of(&env, &k);
    let ixs = [
        compute_budget_ix(800_000),
        env.add_liquidity_ix(&w, &k, &hook, 11 * env.mint_supply(&k.lp_mint), u64::MAX, u64::MAX),
        env.swap_ix(&w, &k, &hook, DIRECTION_SELL, 50_000_000_000, 0),
    ];
    env.ok(&ixs, &[&whale]);
    let start = env.pool(&k.pool);
    env.swap(&whale, &k, &hook, DIRECTION_SELL, 1_000_000, 0).unwrap();
    let cfg = cfg_of(&env, &k);
    assert_eq!(cfg.obs_slot, before.obs_slot);
    assert_eq!(cfg.obs_reserve_quote, before.obs_reserve_quote.min(start.reserve_quote), "the smaller of the two depths");
    assert_eq!(
        cfg.obs_reserve_base as u128,
        (cfg.obs_reserve_quote as u128 * start.reserve_base as u128).div_ceil(start.reserve_quote as u128),
        "the base that goes with it at the price the sell started at, rounded up"
    );
}
