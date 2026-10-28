//! Launch guard: decaying buy fee, sells untouched, and no liquidity added while it runs.

use hookpool_interface::*;
use hookpool_tests::*;
use solana_signer::Signer;

const BASE_LIQ: u64 = 1_000_000_000_000;
const QUOTE_LIQ: u64 = 100 * SOL;

#[test]
fn buy_fee_decays_from_start_to_base_and_sells_are_normal() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.guard_hook(&m.creator, &k.pool, 100, 3_000);
    env.svm.warp_to_slot(1_000);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &hook);

    let cfg: hook_launch_guard::GuardConfig = env.account(&HookRef::cfg(&hook_launch_guard::ID, &k.pool));
    assert_eq!(cfg.start_slot, 1_000, "armed by on_pool_create");
    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_kind, HOOK_KIND_PLATFORM);

    // slot 1000: 30% fee
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, 0, Some(3_000));
    let before = env.balance(&ata(&m.trader.pubkey(), &k.base_mint));
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    assert_eq!(env.balance(&ata(&m.trader.pubkey(), &k.base_mint)), before + q.amount_out);
    // the fee stayed in the pool
    let pool = env.pool(&k.pool);
    assert_eq!(pool.reserve_quote, q.reserve_in_after);
    assert_eq!(pool.reserve_quote - QUOTE_LIQ, q.net_in + q.lp_fee);

    // slot 1050: half way, 1550 bps
    env.svm.warp_to_slot(1_050);
    let expected = hook_launch_guard::guard_fee(1_050, 1_000, 100, 3_000, 30).unwrap();
    assert_eq!(expected, 1_515);
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, 0, Some(expected));
    let before = env.balance(&ata(&m.trader.pubkey(), &k.base_mint));
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, q.amount_out).unwrap();
    assert_eq!(env.balance(&ata(&m.trader.pubkey(), &k.base_mint)), before + q.amount_out);

    // sells during the guard pay the normal fee
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_SELL, 1_000_000_000, 0, None);
    let before = env.balance(&ata(&m.trader.pubkey(), &k.quote_mint));
    env.swap(&m.trader, &k, &hook, DIRECTION_SELL, 1_000_000_000, q.amount_out).unwrap();
    assert_eq!(env.balance(&ata(&m.trader.pubkey(), &k.quote_mint)), before + q.amount_out);

    // slot 1100: guard over, normal fee
    env.svm.warp_to_slot(1_100);
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, 0, None);
    let before = env.balance(&ata(&m.trader.pubkey(), &k.base_mint));
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, q.amount_out).unwrap();
    assert_eq!(env.balance(&ata(&m.trader.pubkey(), &k.base_mint)), before + q.amount_out);
}

#[test]
fn guard_config_limits() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let cfg = HookRef::cfg(&hook_launch_guard::ID, &k.pool);
    let mk = |guard_slots: u64, start_fee_bps: u16| anchor_lang::solana_program::instruction::Instruction {
        program_id: hook_launch_guard::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &hook_launch_guard::accounts::InitPoolConfig {
                payer: m.creator.pubkey(),
                cfg,
                system_program: anchor_lang::solana_program::system_program::ID,
            },
            None,
        ),
        data: anchor_lang::InstructionData::data(&hook_launch_guard::instruction::InitPoolConfig {
            pool: k.pool,
            guard_slots,
            start_fee_bps,
        }),
    };
    env.err(&[mk(100, 5_001)], &[&m.creator], "start fee above");
    env.err(&[mk(0, 3_000)], &[&m.creator], "at least one slot");
    env.err(&[mk(1_000_000, 3_000)], &[&m.creator], "window too long");
    env.ok(&[mk(100, 5_000)], &[&m.creator]);
}

#[test]
fn nobody_adds_liquidity_while_the_guard_runs_and_leaving_is_never_refused() {
    const REFUSED: &str = "liquidity cannot be added while the guard window runs";
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.guard_hook(&m.creator, &k.pool, 100, 3_000);
    env.svm.warp_to_slot(1_000);
    // the pool's own liquidity comes through create_pool, in the first slot of the window
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    let pool = env.pool(&k.pool);
    assert_eq!((pool.reserve_base, pool.reserve_quote), (BASE_LIQ, QUOTE_LIQ));
    assert_eq!(pool.hook_flags, hook_launch_guard::FLAGS);
    assert_eq!(hook_launch_guard::FLAGS, BEFORE_SWAP | BEFORE_ADD_LIQ | ON_POOL_CREATE | OVERRIDE_FEE | CALL_ON_BUY);
    assert_eq!(hook_launch_guard::FLAGS, 4_421);
    env.create_ata(&m.trader, &m.trader.pubkey(), &k.lp_mint);
    let supply = env.mint_supply(&k.lp_mint);
    let lp = supply / 10;

    // in the launch slot and in the last slot of the window: refused, for the creator too
    for (slot, who) in [(1_000, &m.creator), (1_000, &m.trader), (1_099, &m.creator), (1_099, &m.trader)] {
        env.svm.warp_to_slot(slot);
        let ix = env.add_liquidity_ix(&who.pubkey(), &k, &hook, lp, u64::MAX, u64::MAX);
        let failed = env.err(&[ix], &[who], REFUSED);
        assert!(failed.meta.logs.iter().any(|l| l.contains("Error Number: 6007")), "{:?}", failed.meta.logs);
    }
    assert_eq!(env.mint_supply(&k.lp_mint), supply);
    // a sniper pays the fee of that slot, and all of it goes to the liquidity that was
    // there when the pool was created
    let fee = hook_launch_guard::guard_fee(1_099, 1_000, 100, 3_000, 30).unwrap();
    let q = expect_swap(&pool, DIRECTION_BUY, 10 * SOL, 0, Some(fee));
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, 10 * SOL, q.amount_out).unwrap();
    assert_eq!(env.pool(&k.pool).reserve_quote, QUOTE_LIQ + q.net_in + q.lp_fee);
    // leaving is never refused, inside the window as outside it: no callback at all
    let ix = env.remove_liquidity_ix(&m.creator.pubkey(), &k, &hook, lp, 0, 0);
    let meta = env.ok(&[ix], &[&m.creator]);
    let head = format!("Program {} invoke", hook_launch_guard::ID);
    assert!(!meta.logs.iter().any(|l| l.starts_with(&head)), "the hook is not asked about a withdrawal");
    assert_eq!(env.mint_supply(&k.lp_mint), supply - lp);

    // one slot later the window is over and liquidity is welcome
    env.svm.warp_to_slot(1_100);
    for who in [&m.creator, &m.trader] {
        let ix = env.add_liquidity_ix(&who.pubkey(), &k, &hook, lp, u64::MAX, u64::MAX);
        let size = env.tx_size(std::slice::from_ref(&ix), &who.pubkey(), 1);
        let meta = env.ok(&[ix], &[who]);
        assert_eq!(meta.logs.iter().filter(|l| l.starts_with(&head)).count(), 1, "one callback per deposit");
        println!("add_liquidity on a guard pool: {} CU, {size} bytes", meta.compute_units_consumed);
        assert!(meta.compute_units_consumed < 100_000);
    }
    assert_eq!(env.mint_supply(&k.lp_mint), supply + lp);

    // the callback cannot be called by anybody but the pool
    let direct = anchor_lang::solana_program::instruction::Instruction {
        program_id: hook_launch_guard::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &hook_launch_guard::accounts::Callback {
                pool: k.pool,
                hook_caller: m.trader.pubkey(),
                user: m.trader.pubkey(),
                quote_mint: k.quote_mint,
                base_mint: k.base_mint,
                cfg: HookRef::cfg(&hook_launch_guard::ID, &k.pool),
            },
            None,
        ),
        data: anchor_lang::InstructionData::data(&hook_launch_guard::instruction::BeforeAddLiquidity { payload: LiquidityPayload { slot: 5_000, ..Default::default() } }),
    };
    env.err(&[direct], &[&m.trader], "not the pool program's caller PDA");
}
