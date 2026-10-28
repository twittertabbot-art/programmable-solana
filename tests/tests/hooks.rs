//! Hook dispatch, the tax template, the upgradeability rule, and the pool policing
//! a hostile hook.

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::{InstructionData, ToAccountMetas};
use hookpool_interface::*;
use hookpool_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const BASE_LIQ: u64 = 1_000_000_000_000;
const QUOTE_LIQ: u64 = 100 * SOL;

fn tax_pool(env: &mut Env, m: &Market, buy: u16, sell: u16, max: u16) -> (PoolKeys, HookRef, Keypair) {
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let dev = env.user(SOL);
    env.create_ata(&dev, &dev.pubkey(), &m.quote_mint);
    let hook = env.tax_hook(&m.creator, &dev, &k.pool, &m.quote_mint, &dev.pubkey(), buy, sell, max);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    (k, hook, dev)
}

#[test]
fn tax_hook_sends_quote_to_the_treasury_on_buys_and_sells() {
    let mut env = Env::new();
    let m = env.market();
    let (k, hook, _dev) = tax_pool(&mut env, &m, 300, 500, 1_000);

    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_program, hook_tax::ID);
    assert_eq!(pool.hook_kind, HOOK_KIND_PLATFORM, "whitelisted authority");
    assert_eq!(pool.hook_flags, hook_tax::FLAGS);
    assert_eq!(pool.hook_quote_treasury, hook.treasury);

    // buy: 3% of the post-protocol input goes to the treasury
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, 300, None);
    assert!(q.hook_fee > 0);
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    assert_eq!(env.balance(&hook.treasury), q.hook_fee);
    assert_eq!(env.balance(&ata(&m.trader.pubkey(), &k.base_mint)), 1_000_000_000_000 + q.amount_out);
    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_fees_quote_total, q.hook_fee);
    assert_eq!(env.balance(&k.quote_vault), pool.reserve_quote + pool.protocol_fees_quote);

    // sell: 5% of the quote output goes to the treasury
    let q2 = expect_swap(&pool, DIRECTION_SELL, q.amount_out, 500, None);
    let before = env.balance(&ata(&m.trader.pubkey(), &k.quote_mint));
    env.swap(&m.trader, &k, &hook, DIRECTION_SELL, q.amount_out, q2.amount_out).unwrap();
    assert_eq!(env.balance(&ata(&m.trader.pubkey(), &k.quote_mint)), before + q2.amount_out);
    assert_eq!(env.balance(&hook.treasury), q.hook_fee + q2.hook_fee);
    let pool = env.pool(&k.pool);
    assert_eq!(env.balance(&k.quote_vault), pool.reserve_quote + pool.protocol_fees_quote);
}

#[test]
fn tax_ceiling_is_fixed_and_renounce_is_final() {
    let mut env = Env::new();
    let m = env.market();
    let (k, _hook, dev) = tax_pool(&mut env, &m, 300, 500, 1_000);
    let cfg = HookRef::cfg(&hook_tax::ID, &k.pool);
    let owner_ix = |data: Vec<u8>, owner: &Pubkey| Instruction {
        program_id: hook_tax::ID,
        accounts: hook_tax::accounts::OwnerOnly { owner: *owner, cfg }.to_account_metas(None),
        data,
    };
    let dev_pk = dev.pubkey();
    env.err(&[owner_ix(hook_tax::instruction::SetTax { buy_bps: 1_001, sell_bps: 0 }.data(), &dev_pk)], &[&dev], "above the ceiling");
    env.ok(&[owner_ix(hook_tax::instruction::SetTax { buy_bps: 1_000, sell_bps: 0 }.data(), &dev_pk)], &[&dev]);
    let stranger = env.user(SOL);
    env.err(&[owner_ix(hook_tax::instruction::SetTax { buy_bps: 1, sell_bps: 1 }.data(), &stranger.pubkey())], &[&stranger], "only the config owner");
    env.ok(&[owner_ix(hook_tax::instruction::SetOwner { new_owner: Pubkey::default() }.data(), &dev_pk)], &[&dev]);
    // once renounced nobody is the owner any more, so every attempt fails the owner check
    env.err(&[owner_ix(hook_tax::instruction::SetTax { buy_bps: 1, sell_bps: 1 }.data(), &dev_pk)], &[&dev], "only the config owner");
    let c: hook_tax::TaxConfig = env.account(&cfg);
    assert_eq!(c.buy_bps, 1_000);
    assert_eq!(c.owner, Pubkey::default());
}

#[test]
fn hook_cannot_be_called_by_anyone_but_the_pool() {
    let mut env = Env::new();
    let m = env.market();
    let (k, _hook, _dev) = tax_pool(&mut env, &m, 300, 500, 1_000);
    let cfg = HookRef::cfg(&hook_tax::ID, &k.pool);
    let payload = SwapPayload { direction: DIRECTION_BUY, amount_in: 1, ..Default::default() };
    let mut accounts = hook_tax::accounts::Callback {
        pool: k.pool,
        hook_caller: caller_address(&hook_tax::ID).0,
        user: m.trader.pubkey(),
        quote_mint: k.quote_mint,
        base_mint: k.base_mint,
        cfg,
    }
    .to_account_metas(None);
    // the caller PDA cannot sign for an outsider
    for a in accounts.iter_mut() {
        a.is_signer = false;
    }
    let ix = Instruction { program_id: hook_tax::ID, accounts, data: hook_tax::instruction::BeforeSwap { payload }.data() };
    assert!(env.send(&[ix], &[&m.trader]).is_err());
    // and a fake caller that does sign is rejected by address
    let fake = env.user(SOL);
    let mut accounts = hook_tax::accounts::Callback {
        pool: k.pool,
        hook_caller: fake.pubkey(),
        user: m.trader.pubkey(),
        quote_mint: k.quote_mint,
        base_mint: k.base_mint,
        cfg,
    }
    .to_account_metas(None);
    accounts[1].is_signer = true;
    let ix = Instruction { program_id: hook_tax::ID, accounts, data: hook_tax::instruction::BeforeSwap { payload }.data() };
    env.err(&[ix], &[&fake], "not the pool program's caller PDA");
}

#[test]
fn upgradeable_hooks_are_refused_unless_whitelisted() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL | TAKE_HOOK_FEE);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let dev = env.user(SOL);
    env.create_ata(&dev, &dev.pubkey(), &m.quote_mint);
    let hook = env.evil_hook(&m.creator, &k.pool, &m.quote_mint, &dev.pubkey(), hook_evil::MODE_SILENT, 0);

    // 1. upgradeable by a random key: refused
    let rando = Keypair::new().pubkey();
    env.patch_upgrade_authority(&hook_evil::ID, Some(rando));
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "upgradeable and its authority is not whitelisted");

    // 2. whitelist that key: accepted as a platform hook
    env.set_whitelist(vec![env.admin.pubkey(), rando]);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    assert_eq!(env.pool(&k.pool).hook_kind, HOOK_KIND_PLATFORM);

    // 3. frozen: accepted as a frozen custom hook (a second pool, reversed pair)
    env.set_whitelist(vec![env.admin.pubkey()]);
    env.patch_upgrade_authority(&hook_evil::ID, None);
    let k2 = Env::pool_keys(&m.quote_mint, &m.base_mint);
    let dev2 = env.user(SOL);
    env.create_ata(&dev2, &dev2.pubkey(), &m.base_mint);
    let hook2 = env.evil_hook(&m.creator, &k2.pool, &m.base_mint, &dev2.pubkey(), hook_evil::MODE_SILENT, 0);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k2, 30, QUOTE_LIQ, BASE_LIQ, &hook2);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    assert_eq!(env.pool(&k2.pool).hook_kind, HOOK_KIND_FROZEN);
}

#[test]
fn pool_polices_whatever_a_hostile_hook_returns() {
    let mut env = Env::new();
    // granted: fee only. NOT granted: fee override, curve.
    env.init_evil_manifest(BEFORE_SWAP | AFTER_SWAP | CALL_ON_BUY | CALL_ON_SELL | TAKE_HOOK_FEE);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let dev = env.user(SOL);
    env.create_ata(&dev, &dev.pubkey(), &m.quote_mint);
    let hook = env.evil_hook(&m.creator, &k.pool, &m.quote_mint, &dev.pubkey(), hook_evil::MODE_SILENT, 0);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    let t = &m.trader;
    let swap = |env: &mut Env, min_out: u64| env.swap_ix(&t.pubkey(), &k, &hook, DIRECTION_BUY, SOL, min_out);

    // silent hook: plain swap
    let ix = swap(&mut env, 0);
    env.ok(&[ix], &[t]);

    // fee override without the flag
    env.evil_set_mode(&m.creator, &k.pool, hook_evil::MODE_FEE_OVERRIDE, 100);
    let ix = swap(&mut env, 0);
    env.err(&[ix], &[t], "power its flags do not grant");

    // curve override without the flag
    env.evil_set_mode(&m.creator, &k.pool, hook_evil::MODE_CURVE, 1_000);
    let ix = swap(&mut env, 0);
    env.err(&[ix], &[t], "power its flags do not grant");

    // hook fee above the platform cap: clamped to the cap, the swap still goes through,
    // so a hook can never use the cap as a kill switch for one direction
    env.evil_set_mode(&m.creator, &k.pool, hook_evil::MODE_HOOK_FEE, 6_000);
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, MAX_HOOK_FEE_BPS, None);
    let before = env.balance(&hook.treasury);
    let ix = swap(&mut env, q.amount_out);
    env.ok(&[ix], &[t]);
    assert_eq!(env.balance(&hook.treasury), before + q.hook_fee, "fee charged at the cap, not at 60%");

    // hook fee at the cap: allowed, and the math is the pool's, not the hook's
    env.evil_set_mode(&m.creator, &k.pool, hook_evil::MODE_HOOK_FEE, MAX_HOOK_FEE_BPS as u64);
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, MAX_HOOK_FEE_BPS, None);
    let before = env.balance(&hook.treasury);
    let ix = swap(&mut env, q.amount_out);
    env.ok(&[ix], &[t]);
    assert_eq!(env.balance(&hook.treasury), before + q.hook_fee);

    // garbage and wrong-version answers fail the swap, they never pass silently
    env.evil_set_mode(&m.creator, &k.pool, hook_evil::MODE_GARBAGE, 0);
    let ix = swap(&mut env, 0);
    env.err(&[ix], &[t], "could not be decoded");
    env.evil_set_mode(&m.creator, &k.pool, hook_evil::MODE_WRONG_VERSION, 0);
    let ix = swap(&mut env, 0);
    env.err(&[ix], &[t], "could not be decoded");

    // a reverting hook reverts the swap (it has CALL_ON_SELL, so sells too)
    env.evil_set_mode(&m.creator, &k.pool, hook_evil::MODE_REVERT, 0);
    let ix = swap(&mut env, 0);
    env.err(&[ix], &[t], "told to revert");
    let ix = env.swap_ix(&t.pubkey(), &k, &hook, DIRECTION_SELL, 1_000_000, 0);
    env.err(&[ix], &[t], "told to revert");

    // but LPs can still leave: no BEFORE_REMOVE_LIQ flag, so the hook is never asked
    let creator = m.creator.pubkey();
    let lp = env.balance(&ata(&creator, &k.lp_mint));
    let ix = env.remove_liquidity_ix(&creator, &k, &hook, lp / 2, 0, 0);
    env.ok(&[ix], &[&m.creator]);
}

#[test]
fn a_hook_without_call_on_sell_can_never_block_sells() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.evil_hook(&m.creator, &k.pool, &m.quote_mint, &m.creator.pubkey(), hook_evil::MODE_SILENT, 0);
    let hook = HookRef { treasury: anchor_lang::solana_program::system_program::ID, ..hook };
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    let cfg_key = HookRef::cfg(&hook_evil::ID, &k.pool);

    let t = &m.trader;
    // a buy consults the hook (counter goes to 1)
    let ix = env.swap_ix(&t.pubkey(), &k, &hook, DIRECTION_BUY, SOL, 0);
    env.ok(&[ix], &[t]);
    let cfg: hook_evil::EvilConfig = env.account(&cfg_key);
    assert_eq!(cfg.calls, 1);
    // a sell does not (counter stays at 1)
    let ix = env.swap_ix(&t.pubkey(), &k, &hook, DIRECTION_SELL, 1_000_000_000, 0);
    env.ok(&[ix], &[t]);
    let cfg: hook_evil::EvilConfig = env.account(&cfg_key);
    assert_eq!(cfg.calls, 1, "hook is never asked about sells");

    // now the hook turns hostile: buys die, sells still go through
    env.evil_set_mode(&m.creator, &k.pool, hook_evil::MODE_REVERT, 0);
    let ix = env.swap_ix(&t.pubkey(), &k, &hook, DIRECTION_BUY, SOL, 0);
    env.err(&[ix], &[t], "told to revert");
    let ix = env.swap_ix(&t.pubkey(), &k, &hook, DIRECTION_SELL, 1_000_000_000, 0);
    env.ok(&[ix], &[t]);
    let cfg: hook_evil::EvilConfig = env.account(&cfg_key);
    assert_eq!(cfg.calls, 1, "the failed buy rolled back, the sell never asked");
}

#[test]
fn swap_fails_when_hook_accounts_are_wrong_or_missing() {
    let mut env = Env::new();
    let m = env.market();
    let (k, hook, _dev) = tax_pool(&mut env, &m, 300, 500, 1_000);
    // missing extra account
    let bare = HookRef { extra: vec![], ..hook.clone() };
    let ix = env.swap_ix(&m.trader.pubkey(), &k, &bare, DIRECTION_BUY, SOL, 0);
    env.err(&[ix], &[&m.trader], "extra accounts could not be resolved");
    // wrong treasury
    let wrong = HookRef { treasury: ata(&m.trader.pubkey(), &k.quote_mint), ..hook.clone() };
    let ix = env.swap_ix(&m.trader.pubkey(), &k, &wrong, DIRECTION_BUY, SOL, 0);
    env.err(&[ix], &[&m.trader], "treasury does not match");
    // wrong hook program
    let wrong = HookRef { program: hook_launch_guard::ID, ..hook.clone() };
    let ix = env.swap_ix(&m.trader.pubkey(), &k, &wrong, DIRECTION_BUY, SOL, 0);
    env.err(&[ix], &[&m.trader], "hook program does not match");
    // extra account swapped for another pool's cfg (wrong PDA): resolver refuses
    let other_cfg = HookRef::cfg(&hook_tax::ID, &Pubkey::new_unique());
    let wrong = HookRef { extra: vec![AccountMeta::new_readonly(other_cfg, false)], ..hook.clone() };
    let ix = env.swap_ix(&m.trader.pubkey(), &k, &wrong, DIRECTION_BUY, SOL, 0);
    env.err(&[ix], &[&m.trader], "extra accounts could not be resolved");
}

#[test]
fn a_closed_treasury_never_blocks_trades_and_never_loses_the_fee() {
    let mut env = Env::new();
    let m = env.market();
    let (k, hook, dev) = tax_pool(&mut env, &m, 300, 500, 1_000);
    // one taxed buy so the treasury holds something, then the dev empties and closes it
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, 0).unwrap();
    let held = env.balance(&hook.treasury);
    assert!(held > 0);
    let sink = env.create_ata(&dev, &m.trader.pubkey(), &k.quote_mint);
    let _ = sink;
    let ix = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &hook.treasury, &ata(&m.trader.pubkey(), &k.quote_mint), &dev.pubkey(), &[], held).unwrap();
    env.ok(&[ix], &[&dev]);
    env.close_token_account(&dev, &hook.treasury);
    assert!(env.svm.get_account(&hook.treasury).map(|a| a.lamports).unwrap_or(0) == 0, "treasury closed");

    // Final review: the fee of a swap that found no treasury used to be added to the
    // reserves. A dev who unwrapped the SOL in the treasury (which closes the account)
    // lost every later fee without a sign. Now it waits, outside the reserves.
    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_treasury_owner, dev.pubkey(), "the pool remembers whose account the treasury is");
    let q = expect_swap(&pool, DIRECTION_SELL, 1_000_000_000, 500, None);
    env.swap(&m.trader, &k, &hook, DIRECTION_SELL, 1_000_000_000, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    let after = env.pool(&k.pool);
    assert_eq!(after.reserve_quote, q.reserve_out_after, "the reserves follow the plain math");
    assert_eq!(after.hook_fees_owed_quote, q.hook_fee, "the fee waits");
    assert_eq!(after.hook_fees_quote_total, pool.hook_fees_quote_total + q.hook_fee, "and counts as charged");
    assert_eq!(env.balance(&k.quote_vault), after.reserve_quote + after.protocol_fees_quote + after.hook_fees_owed_quote);
    // buys too, and what waits adds up
    let q2 = expect_swap(&after, DIRECTION_BUY, SOL, 300, None);
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, q2.amount_out).unwrap();
    let waiting = q.hook_fee + q2.hook_fee;
    let p = env.pool(&k.pool);
    assert_eq!(p.hook_fees_owed_quote, waiting);
    assert_eq!(env.balance(&k.quote_vault), p.reserve_quote + p.protocol_fees_quote + waiting);
    // liquidity is not affected by what waits: an LP takes its share of the reserves only
    let lp = env.balance(&ata(&m.creator.pubkey(), &k.lp_mint)) / 10;
    env.ok(&[env.remove_liquidity_ix(&m.creator.pubkey(), &k, &hook, lp, 0, 0)], &[&m.creator]);
    let p = env.pool(&k.pool);
    assert_eq!(env.balance(&k.quote_vault), p.reserve_quote + p.protocol_fees_quote + waiting);

    // nothing can be collected while the treasury does not exist, and never to another account
    let collect = |treasury: Pubkey| Instruction {
        program_id: hookpool::ID,
        accounts: hookpool::accounts::CollectHookFees { pool: k.pool, quote_mint: k.quote_mint, quote_vault: k.quote_vault, hook_quote_treasury: treasury, quote_token_program: TOKEN }
            .to_account_metas(None),
        data: hookpool::instruction::CollectHookFees {}.data(),
    };
    assert!(env.send(&[collect(hook.treasury)], &[&m.trader]).is_err(), "the treasury does not exist");
    assert!(env.send(&[collect(ata(&m.trader.pubkey(), &k.quote_mint))], &[&m.trader]).is_err(), "not the pool's treasury");
    assert_eq!(env.pool(&k.pool).hook_fees_owed_quote, waiting);

    // anyone recreates the account and collects, in one transaction
    let reopen = Env::create_ata_ix(&m.trader.pubkey(), &dev.pubkey(), &k.quote_mint);
    env.ok(&[reopen, collect(hook.treasury)], &[&m.trader]);
    assert_eq!(env.balance(&hook.treasury), waiting, "every fee that waited reached the treasury");
    let p = env.pool(&k.pool);
    assert_eq!(p.hook_fees_owed_quote, 0);
    assert_eq!(env.balance(&k.quote_vault), p.reserve_quote + p.protocol_fees_quote);
    env.err(&[collect(hook.treasury)], &[&m.trader], "no fees to collect");

    // closed again: the next swap that finds it open pays what waited together with its own fee
    let held = env.balance(&hook.treasury);
    let ix = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &hook.treasury, &ata(&m.trader.pubkey(), &k.quote_mint), &dev.pubkey(), &[], held).unwrap();
    env.ok(&[ix], &[&dev]);
    env.close_token_account(&dev, &hook.treasury);
    let p = env.pool(&k.pool);
    let q3 = expect_swap(&p, DIRECTION_BUY, SOL, 300, None);
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, 0).unwrap();
    assert_eq!(env.pool(&k.pool).hook_fees_owed_quote, q3.hook_fee);
    env.create_ata(&m.trader, &dev.pubkey(), &k.quote_mint);
    let p = env.pool(&k.pool);
    let q4 = expect_swap(&p, DIRECTION_BUY, SOL, 300, None);
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, 0).unwrap();
    assert_eq!(env.balance(&hook.treasury), q3.hook_fee + q4.hook_fee);
    let p = env.pool(&k.pool);
    assert_eq!(p.hook_fees_owed_quote, 0);
    assert_eq!(env.balance(&k.quote_vault), p.reserve_quote + p.protocol_fees_quote);
}

#[test]
fn treasury_must_be_an_associated_token_account() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let dev = env.user(SOL);
    let plain = env.create_token_account(&dev, &dev.pubkey(), &m.quote_mint);
    let mut hook = env.tax_hook(&m.creator, &dev, &k.pool, &m.quote_mint, &dev.pubkey(), 300, 500, 1_000);
    hook.treasury = plain;
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "associated token account of its owner");
    // the pool's own vault is refused too
    hook.treasury = k.quote_vault;
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    assert!(env.send(&[compute_budget_ix(400_000), ix], &[&m.creator]).is_err());
}

#[test]
fn a_stranger_cannot_squat_a_future_pools_config() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let stranger = env.user(SOL);
    env.create_ata(&stranger, &stranger.pubkey(), &m.quote_mint);
    // the stranger pre-creates the tax config for the pool the creator is about to make
    let hook = env.tax_hook(&stranger, &stranger, &k.pool, &m.quote_mint, &stranger.pubkey(), 1_000, 1_000, 1_000);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "not created by the pool creator");
}

#[test]
fn template_ceilings_cannot_exceed_the_platform_cap() {
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let cfg = HookRef::cfg(&hook_tax::ID, &k.pool);
    let ix = Instruction {
        program_id: hook_tax::ID,
        accounts: hook_tax::accounts::InitPoolConfig { payer: m.creator.pubkey(), owner: m.creator.pubkey(), cfg, system_program: anchor_lang::solana_program::system_program::ID }
            .to_account_metas(None),
        data: hook_tax::instruction::InitPoolConfig { pool: k.pool, buy_bps: 100, sell_bps: 100, max_bps: hook_tax::HARD_MAX_BPS + 1 }.data(),
    };
    env.err(&[ix], &[&m.creator], "ceiling above the hard maximum");
    assert_eq!(hook_tax::HARD_MAX_BPS, MAX_HOOK_FEE_BPS);
    assert_eq!(hook_buyback::HARD_MAX_BPS, MAX_HOOK_FEE_BPS);
}
