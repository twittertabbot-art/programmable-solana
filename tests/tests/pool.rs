//! Core pool behaviour with no hook attached.

use anchor_lang::solana_program::system_program;
use hookpool_interface::{DIRECTION_BUY, DIRECTION_SELL, HOOK_KIND_NONE};
use hookpool_tests::*;
use solana_signer::Signer;

const BASE_LIQ: u64 = 1_000_000_000_000; // 1M tokens at 6 decimals
const QUOTE_LIQ: u64 = 100 * SOL;

#[test]
fn platform_init_only_by_upgrade_authority() {
    let mut env = Env::bare();
    let stranger = env.user(SOL);
    let ix = env.init_platform_ix(&stranger.pubkey());
    env.err(&[ix], &[&stranger], "not the program's upgrade authority");
    // the real authority works
    env.init_platform();
    let p: hookpool::Platform = env.account(&env.platform);
    assert_eq!(p.admin, env.admin.pubkey());
    assert_eq!(p.protocol_fee_bps, PROTOCOL_FEE_BPS);
    // and only once
    let ix = env.init_platform_ix(&env.admin.pubkey());
    let admin = env.admin.insecure_clone();
    assert!(env.send(&[ix], &[&admin]).is_err());
}

#[test]
fn create_pool_then_buy_and_sell_match_the_math() {
    let mut env = Env::new();
    let m = env.market();
    let k = env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());

    let pool = env.pool(&k.pool);
    assert_eq!(pool.reserve_base, BASE_LIQ);
    assert_eq!(pool.reserve_quote, QUOTE_LIQ);
    assert_eq!(pool.hook_kind, HOOK_KIND_NONE);
    assert_eq!(pool.creator, m.creator.pubkey());
    // LP: sqrt(1e12 * 1e11) = 1e11.5, about 316_227_766_016, minus the locked 1000
    let expected_lp = ((BASE_LIQ as u128) * (QUOTE_LIQ as u128)).isqrt() as u64;
    assert_eq!(env.balance(&ata(&m.creator.pubkey(), &k.lp_mint)), expected_lp - 1_000);
    assert_eq!(env.balance(&k.lp_lock), 1_000);
    assert_eq!(env.balance(&k.base_vault), BASE_LIQ);
    assert_eq!(env.balance(&k.quote_vault), QUOTE_LIQ);

    // buy 1 SOL worth
    let amount_in = SOL;
    let q = expect_swap(&pool, DIRECTION_BUY, amount_in, 0, None);
    let trader_base = ata(&m.trader.pubkey(), &k.base_mint);
    let trader_quote = ata(&m.trader.pubkey(), &k.quote_mint);
    let base_before = env.balance(&trader_base);
    let quote_before = env.balance(&trader_quote);
    let meta = env
        .swap(&m.trader, &k, &HookRef::none(), DIRECTION_BUY, amount_in, q.amount_out)
        .unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.pretty_logs()));
    assert_eq!(env.balance(&trader_base), base_before + q.amount_out);
    assert_eq!(env.balance(&trader_quote), quote_before - amount_in);
    assert_eq!(meta.return_data.data, q.amount_out.to_le_bytes().to_vec(), "swap returns amount_out");
    let pool = env.pool(&k.pool);
    assert_eq!(pool.reserve_quote, q.reserve_in_after);
    assert_eq!(pool.reserve_base, q.reserve_out_after);
    assert_eq!(pool.protocol_fees_quote, q.protocol_fee);
    assert_eq!(pool.swap_count, 1);
    assert_eq!(pool.volume_quote_total, amount_in);
    // vault = reserves + protocol fees, always
    assert_eq!(env.balance(&k.quote_vault), pool.reserve_quote + pool.protocol_fees_quote);

    // sell everything back
    let sell_in = q.amount_out;
    let q2 = expect_swap(&pool, DIRECTION_SELL, sell_in, 0, None);
    env.swap(&m.trader, &k, &HookRef::none(), DIRECTION_SELL, sell_in, q2.amount_out).unwrap();
    assert_eq!(env.balance(&trader_base), base_before);
    assert_eq!(env.balance(&trader_quote), quote_before - amount_in + q2.amount_out);
    assert!(q2.amount_out < amount_in, "round trip pays fees");
    let pool = env.pool(&k.pool);
    assert_eq!(pool.protocol_fees_base, q2.protocol_fee);
    assert_eq!(env.balance(&k.base_vault), pool.reserve_base + pool.protocol_fees_base);
    assert_eq!(env.balance(&k.quote_vault), pool.reserve_quote + pool.protocol_fees_quote);
}

#[test]
fn simulation_quotes_through_return_data() {
    let mut env = Env::new();
    let m = env.market();
    let k = env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_BUY, 5 * SOL, 0, None);
    let ix = env.swap_ix(&m.trader.pubkey(), &k, &HookRef::none(), DIRECTION_BUY, 5 * SOL, 0);
    let ret = env.simulate_return(&[ix], &[&m.trader]);
    assert_eq!(ret, q.amount_out.to_le_bytes().to_vec());
    // nothing moved
    assert_eq!(env.pool(&k.pool).swap_count, 0);
}

#[test]
fn slippage_and_zero_amounts_are_rejected() {
    let mut env = Env::new();
    let m = env.market();
    let k = env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, 0, None);
    let ix = env.swap_ix(&m.trader.pubkey(), &k, &HookRef::none(), DIRECTION_BUY, SOL, q.amount_out + 1);
    env.err(&[ix], &[&m.trader], "below min_amount_out");
    let ix = env.swap_ix(&m.trader.pubkey(), &k, &HookRef::none(), DIRECTION_BUY, 0, 0);
    env.err(&[ix], &[&m.trader], "greater than zero");
    let ix = env.swap_ix(&m.trader.pubkey(), &k, &HookRef::none(), 2, SOL, 0);
    env.err(&[ix], &[&m.trader], "direction must be");
}

#[test]
fn pool_rejects_bad_fee_same_mint_and_tiny_liquidity() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, MAX_LP_FEE_BPS + 1, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "fee exceeds");
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, 10, 10, &HookRef::none());
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "initial liquidity too small");
    let same = Env::pool_keys(&m.base_mint, &m.base_mint);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &same, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    assert!(env.send(&[compute_budget_ix(400_000), ix], &[&m.creator]).is_err());
}

#[test]
fn add_and_remove_liquidity_proportionally() {
    let mut env = Env::new();
    let m = env.market();
    let k = env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    let trader = m.trader.pubkey();
    env.ok(&[Env::create_ata_ix(&trader, &trader, &k.lp_mint)], &[&m.trader]);

    let supply_before = env.mint_supply(&k.lp_mint);
    let lp = supply_before / 10; // 10% more
    let pool = env.pool(&k.pool);
    let need_base = ((lp as u128 * pool.reserve_base as u128).div_ceil(supply_before as u128)) as u64;
    let need_quote = ((lp as u128 * pool.reserve_quote as u128).div_ceil(supply_before as u128)) as u64;

    // too tight a max fails
    let ix = env.add_liquidity_ix(&trader, &k, &HookRef::none(), lp, need_base - 1, need_quote);
    env.err(&[ix], &[&m.trader], "above the maximum");
    let ix = env.add_liquidity_ix(&trader, &k, &HookRef::none(), lp, need_base, need_quote);
    env.ok(&[ix], &[&m.trader]);
    let pool = env.pool(&k.pool);
    assert_eq!(pool.reserve_base, BASE_LIQ + need_base);
    assert_eq!(pool.reserve_quote, QUOTE_LIQ + need_quote);
    assert_eq!(env.balance(&ata(&trader, &k.lp_mint)), lp);

    // remove it all again, gets back at most what went in
    let ix = env.remove_liquidity_ix(&trader, &k, &HookRef::none(), lp, 0, 0);
    env.ok(&[ix], &[&m.trader]);
    let pool = env.pool(&k.pool);
    assert!(pool.reserve_base >= BASE_LIQ && pool.reserve_base <= BASE_LIQ + 1);
    assert!(pool.reserve_quote >= QUOTE_LIQ && pool.reserve_quote <= QUOTE_LIQ + 1);
    assert_eq!(env.balance(&ata(&trader, &k.lp_mint)), 0);
    assert_eq!(env.balance(&k.base_vault), pool.reserve_base + pool.protocol_fees_base);
}

#[test]
fn paused_blocks_swaps_and_new_pools_but_never_removal() {
    let mut env = Env::new();
    let m = env.market();
    let k = env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(true), ..Default::default() });

    let ix = env.swap_ix(&m.trader.pubkey(), &k, &HookRef::none(), DIRECTION_BUY, SOL, 0);
    env.err(&[ix], &[&m.trader], "paused");
    let other = Env::pool_keys(&m.quote_mint, &m.base_mint);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &other, 30, QUOTE_LIQ, BASE_LIQ, &HookRef::none());
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "paused");

    let creator = m.creator.pubkey();
    let lp = env.balance(&ata(&creator, &k.lp_mint));
    let ix = env.remove_liquidity_ix(&creator, &k, &HookRef::none(), lp / 2, 0, 0);
    env.ok(&[ix], &[&m.creator]);

    env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(false), ..Default::default() });
    let ix = env.swap_ix(&m.trader.pubkey(), &k, &HookRef::none(), DIRECTION_BUY, SOL, 0);
    env.ok(&[ix], &[&m.trader]);
}

#[test]
fn protocol_fees_go_to_the_treasury() {
    let mut env = Env::new();
    let m = env.market();
    let k = env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    env.swap(&m.trader, &k, &HookRef::none(), DIRECTION_BUY, 10 * SOL, 0).unwrap();
    let pool = env.pool(&k.pool);
    let owed = pool.protocol_fees_quote;
    assert!(owed > 0);

    let anyone = env.user(SOL);
    let ix = env.collect_ix(&anyone.pubkey(), &k);
    env.ok(&[ix], &[&anyone]);
    let t = env.treasury.pubkey();
    assert_eq!(env.balance(&ata(&t, &k.quote_mint)), owed);
    let pool = env.pool(&k.pool);
    assert_eq!(pool.protocol_fees_quote, 0);
    assert_eq!(env.balance(&k.quote_vault), pool.reserve_quote);

    let ix = env.collect_ix(&anyone.pubkey(), &k);
    env.err(&[ix], &[&anyone], "no fees to collect");
}

#[test]
fn admin_caps_are_bounded_and_admin_handover_is_two_step() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let ix = env.admin_ix(
        hookpool::instruction::UpdatePlatform {
            args: hookpool::UpdatePlatformArgs { protocol_fee_bps: Some(101), ..Default::default() },
        }
        .data(),
    );
    env.err(&[ix], &[&admin], "fee exceeds");

    let stranger = env.user(SOL);
    let mut bad = env.admin_ix(hookpool::instruction::SetWhitelist { keys: vec![] }.data());
    bad.accounts[0].pubkey = stranger.pubkey();
    env.err(&[bad], &[&stranger], "only the platform admin");

    let new_admin = env.user(SOL);
    let ix = env.admin_ix(hookpool::instruction::TransferAdmin { new_admin: new_admin.pubkey() }.data());
    env.ok(&[ix], &[&admin]);
    // old admin still in charge until accepted
    let p: hookpool::Platform = env.account(&env.platform);
    assert_eq!(p.admin, admin.pubkey());
    let accept = anchor_lang::solana_program::instruction::Instruction {
        program_id: hookpool::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &hookpool::accounts::AcceptAdmin { new_admin: new_admin.pubkey(), platform: env.platform },
            None,
        ),
        data: anchor_lang::InstructionData::data(&hookpool::instruction::AcceptAdmin {}),
    };
    env.ok(&[accept], &[&new_admin]);
    let p: hookpool::Platform = env.account(&env.platform);
    assert_eq!(p.admin, new_admin.pubkey());
    assert_eq!(p.pending_admin, system_program::ID);
}

use anchor_lang::InstructionData;

/// The swap's two token accounts are accounts 7 (the coin) and 8 (the quote).
fn with_accounts(mut ix: anchor_lang::solana_program::instruction::Instruction, base: Pubkey, quote: Pubkey) -> anchor_lang::solana_program::instruction::Instruction {
    ix.accounts[7].pubkey = base;
    ix.accounts[8].pubkey = quote;
    ix
}

#[test]
fn a_swap_pays_out_to_any_wallet_and_spends_only_what_the_signer_controls() {
    // An aggregator or a bot signs with one wallet and pays out to another. The pool used to
    // require both token accounts to belong to the signer.
    let mut env = Env::new();
    let m = env.market();
    let k = env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    let friend = env.user(SOL);
    let friend_base = env.create_ata(&friend, &friend.pubkey(), &k.base_mint);
    let friend_quote = env.create_ata(&friend, &friend.pubkey(), &k.quote_mint);
    let trader = m.trader.pubkey();
    let trader_base = ata(&trader, &k.base_mint);
    let trader_quote = ata(&trader, &k.quote_mint);
    let none = HookRef::none();

    // a buy paid by the trader, the coins land in the friend's account
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, 0, None);
    let (quote_before, base_before) = (env.balance(&trader_quote), env.balance(&trader_base));
    let ix = with_accounts(env.swap_ix(&trader, &k, &none, DIRECTION_BUY, SOL, q.amount_out), friend_base, trader_quote);
    env.ok(&[ix], &[&m.trader]);
    assert_eq!(env.balance(&friend_base), q.amount_out);
    assert_eq!(env.balance(&trader_base), base_before);
    assert_eq!(env.balance(&trader_quote), quote_before - SOL);

    // a sell of the trader's own coins, the proceeds land in the friend's account
    env.swap(&m.trader, &k, &none, DIRECTION_BUY, SOL, 0).unwrap();
    let have = env.balance(&trader_base);
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_SELL, have, 0, None);
    let ix = with_accounts(env.swap_ix(&trader, &k, &none, DIRECTION_SELL, have, q.amount_out), trader_base, friend_quote);
    env.ok(&[ix], &[&m.trader]);
    assert_eq!(env.balance(&friend_quote), q.amount_out);
    assert_eq!(env.balance(&trader_base), 0);
    let pool = env.pool(&k.pool);
    assert_eq!(env.balance(&k.base_vault), pool.reserve_base + pool.protocol_fees_base, "vault = reserves + protocol fees, always");
    assert_eq!(env.balance(&k.quote_vault), pool.reserve_quote + pool.protocol_fees_quote);

    // nobody spends an account it does not control: the token program refuses
    let friend_coins = env.balance(&friend_base);
    let ix = with_accounts(env.swap_ix(&trader, &k, &none, DIRECTION_SELL, friend_coins, 0), friend_base, trader_quote);
    env.err(&[ix], &[&m.trader], "owner does not match");
    let ix = with_accounts(env.swap_ix(&trader, &k, &none, DIRECTION_BUY, 1_000, 0), trader_base, friend_quote);
    env.err(&[ix], &[&m.trader], "owner does not match");
    assert_eq!(env.balance(&friend_base), friend_coins);

    // a delegate spends what it was allowed, like anywhere else on Solana
    let allow = anchor_spl::token::spl_token::instruction::approve(&TOKEN, &friend_base, &trader, &friend.pubkey(), &[], friend_coins / 2).unwrap();
    env.ok(&[allow], &[&friend]);
    let ix = with_accounts(env.swap_ix(&trader, &k, &none, DIRECTION_SELL, friend_coins / 2, 0), friend_base, friend_quote);
    env.ok(&[ix], &[&m.trader]);
    assert_eq!(env.balance(&friend_base), friend_coins - friend_coins / 2);
    let ix = with_accounts(env.swap_ix(&trader, &k, &none, DIRECTION_SELL, 1_000, 0), friend_base, friend_quote);
    env.err(&[ix], &[&m.trader], "owner does not match");

    // never the pool's own vault: nothing would move while the reserves went down. The
    // framework refuses the same account twice (error 0x7f8) before the pool's own check runs.
    let vaults = (env.balance(&k.base_vault), env.balance(&k.quote_vault));
    let ix = with_accounts(env.swap_ix(&trader, &k, &none, DIRECTION_BUY, 1_000_000, 0), k.base_vault, trader_quote);
    env.err(&[ix], &[&m.trader], "0x7f8");
    let ix = with_accounts(env.swap_ix(&trader, &k, &none, DIRECTION_SELL, 1_000, 0), friend_base, k.quote_vault);
    env.err(&[ix], &[&m.trader], "0x7f8");
    assert_eq!((env.balance(&k.base_vault), env.balance(&k.quote_vault)), vaults);
    // and a token account of another coin is still refused
    let ix = with_accounts(env.swap_ix(&trader, &k, &none, DIRECTION_BUY, 1_000_000, 0), friend_quote, trader_quote);
    assert!(env.send(&[ix], &[&m.trader]).is_err());
}

// ---- final review, 2026-10-12 ---------------------------------------------------------------

/// A mint made by hand, with whatever freeze authority and Token-2022 extensions are asked for.
fn odd_mint(env: &mut Env, payer: &solana_keypair::Keypair, token_program: &Pubkey, freeze: Option<&Pubkey>, extensions: &[anchor_spl::token_2022::spl_token_2022::extension::ExtensionType]) -> Pubkey {
    use anchor_lang::solana_program::system_instruction;
    use anchor_spl::token_2022::spl_token_2022 as t22;
    use t22::extension::ExtensionType;
    let mint = solana_keypair::Keypair::new();
    let space = if *token_program == TOKEN { 82 } else { ExtensionType::try_calculate_account_len::<t22::state::Mint>(extensions).unwrap() };
    let mut ixs = vec![system_instruction::create_account(&payer.pubkey(), &mint.pubkey(), env.svm.minimum_balance_for_rent_exemption(space), space as u64, token_program)];
    for e in extensions {
        ixs.push(match e {
            ExtensionType::MintCloseAuthority => t22::instruction::initialize_mint_close_authority(token_program, &mint.pubkey(), Some(&payer.pubkey())).unwrap(),
            ExtensionType::InterestBearingConfig => t22::extension::interest_bearing_mint::instruction::initialize(token_program, &mint.pubkey(), Some(payer.pubkey()), 500).unwrap(),
            ExtensionType::PermanentDelegate => t22::instruction::initialize_permanent_delegate(token_program, &mint.pubkey(), &payer.pubkey()).unwrap(),
            ExtensionType::MetadataPointer => t22::extension::metadata_pointer::instruction::initialize(token_program, &mint.pubkey(), None, Some(mint.pubkey())).unwrap(),
            other => panic!("no initialiser for {other:?} in this test"),
        });
    }
    ixs.push(t22::instruction::initialize_mint2(token_program, &mint.pubkey(), &payer.pubkey(), freeze, 6).unwrap());
    env.ok(&ixs, &[payer, &mint]);
    // the whole supply to the payer, so it can seed a pool
    let ata = ata_with(&payer.pubkey(), &mint.pubkey(), token_program);
    let ixs = [
        Env::create_ata_with_ix(&payer.pubkey(), &payer.pubkey(), &mint.pubkey(), token_program),
        t22::instruction::mint_to(token_program, &mint.pubkey(), &ata, &payer.pubkey(), &[], 10 * BASE_LIQ).unwrap(),
    ];
    env.ok(&ixs, &[payer]);
    mint.pubkey()
}

#[test]
fn a_pool_refuses_a_coin_that_can_be_frozen() {
    // Final review: create_pool, called directly, took a coin that kept its freeze
    // authority. That authority could then freeze the pool's own vault: no buy, and no LP
    // could leave. Only the launchpad checked it.
    let mut env = Env::new();
    let m = env.market();
    let freezer = m.creator.pubkey();
    for program in [TOKEN, TOKEN_2022] {
        let frozen = odd_mint(&mut env, &m.creator, &program, Some(&freezer), &[]);
        let k = Env::pool_keys_with(&frozen, &m.quote_mint, &program);
        let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
        env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "no freeze authority");
        // the same coin without a freeze authority is taken
        let fine = odd_mint(&mut env, &m.creator, &program, None, &[]);
        let k = Env::pool_keys_with(&fine, &m.quote_mint, &program);
        let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
        env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    }
}

#[test]
fn only_named_token_2022_extensions_are_accepted() {
    // Final review: the pool banned a list of extensions and took every other one, also
    // one Token-2022 might add later. Now it names the few it takes.
    use anchor_spl::token_2022::spl_token_2022::extension::ExtensionType;
    let mut env = Env::new();
    let m = env.market();
    for refused in [ExtensionType::MintCloseAuthority, ExtensionType::InterestBearingConfig, ExtensionType::PermanentDelegate] {
        let mint = odd_mint(&mut env, &m.creator, &TOKEN_2022, None, &[refused]);
        let k = Env::pool_keys_with(&mint, &m.quote_mint, &TOKEN_2022);
        let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
        env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "does not accept");
    }
    // a coin that only says where its name lives trades like any other
    let mint = odd_mint(&mut env, &m.creator, &TOKEN_2022, None, &[ExtensionType::MetadataPointer]);
    let k = Env::pool_keys_with(&mint, &m.quote_mint, &TOKEN_2022);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    let pool = env.pool(&k.pool);
    assert_eq!(env.balance(&k.base_vault), pool.reserve_base);
}
