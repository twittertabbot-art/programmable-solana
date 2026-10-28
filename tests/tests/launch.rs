//! The launchpad: token with Metaplex metadata, then a one-transaction launch.

use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use hookpool_interface::*;
use hookpool_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const SUPPLY: u64 = 1_000_000_000_000_000; // 1B at 6 decimals

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
            args: hooklaunch::CreateTokenArgs {
                name: name.into(),
                symbol: symbol.into(),
                uri: "https://example.invalid/meta.json".into(),
                decimals: 6,
                total_supply: SUPPLY,
            },
        }
        .data(),
    }
}

fn launch_ix(env: &Env, dev: &Pubkey, k: &PoolKeys, hook: &HookRef, args: hooklaunch::LaunchArgs) -> Instruction {
    let launch = Pubkey::find_program_address(&[hooklaunch::LAUNCH_SEED, k.base_mint.as_ref()], &hooklaunch::ID).0;
    let mut accounts = hooklaunch::accounts::LaunchPool {
        dev: *dev,
        platform: env.platform,
        treasury: env.treasury.pubkey(),
        launch,
        base_mint: k.base_mint,
        quote_mint: k.quote_mint,
        pool: k.pool,
        base_vault: k.base_vault,
        quote_vault: k.quote_vault,
        lp_mint: k.lp_mint,
        lp_lock: k.lp_lock,
        dev_base: ata(dev, &k.base_mint),
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
        base_token_program: TOKEN,
        quote_token_program: TOKEN,
        token_program: TOKEN,
        associated_token_program: ATA_PROGRAM,
        system_program: system_program::ID,
        event_authority: event_authority_address(&hooklaunch::ID),
        program: hooklaunch::ID,
    }
    .to_account_metas(None);
    accounts.extend(hook.extra.iter().cloned());
    Instruction { program_id: hooklaunch::ID, accounts, data: hooklaunch::instruction::Launch { args }.data() }
}

#[test]
fn create_token_mints_supply_with_metadata_and_revokes_authority() {
    let mut env = Env::new();
    let dev = env.user(10 * SOL);
    let mint = Keypair::new();
    env.ok(&[create_token_ix(&dev.pubkey(), &mint.pubkey(), "Hook Coin", "HOOK")], &[&dev, &mint]);
    assert_eq!(env.mint_supply(&mint.pubkey()), SUPPLY);
    assert_eq!(env.balance(&ata(&dev.pubkey(), &mint.pubkey())), SUPPLY);
    assert_eq!(env.mint_authority(&mint.pubkey()), None, "fixed supply");
    let metadata = Pubkey::find_program_address(&[b"metadata", MPL.as_ref(), mint.pubkey().as_ref()], &MPL).0;
    let md = env.svm.get_account(&metadata).expect("metadata account");
    assert_eq!(md.owner, MPL);
    let text = String::from_utf8_lossy(&md.data);
    assert!(text.contains("Hook Coin") && text.contains("HOOK"));

    let long = "x".repeat(33);
    let mint2 = Keypair::new();
    env.err(&[create_token_ix(&dev.pubkey(), &mint2.pubkey(), &long, "HOOK")], &[&dev, &mint2], "name longer");
}

#[test]
fn launch_pays_fee_locks_lp_records_and_dev_buys() {
    let mut env = Env::new();
    let m = env.market();
    let dev = env.user(20 * SOL);
    // quote tokens for the dev (the test "SOL" is a plain mint)
    env.fund(&dev, &m.authority, &m.base_mint, &m.quote_mint, 0, 50 * SOL);
    let mint = Keypair::new();
    env.ok(&[create_token_ix(&dev.pubkey(), &mint.pubkey(), "Hook Coin", "HOOK")], &[&dev, &mint]);
    let base_mint = mint.pubkey();
    let k = Env::pool_keys(&base_mint, &m.quote_mint);

    // tax hook, treasury = dev's quote ATA
    let hook = env.tax_hook(&dev, &dev, &k.pool, &m.quote_mint, &dev.pubkey(), 300, 300, 500);

    let treasury_before = env.lamports(&env.treasury.pubkey());
    let dev_quote_before = env.balance(&ata(&dev.pubkey(), &m.quote_mint));
    let dev_buy = 2 * SOL;
    let ix = launch_ix(
        &env,
        &dev.pubkey(),
        &k,
        &hook,
        hooklaunch::LaunchArgs { lp_fee_bps: 30, base_amount: SUPPLY, quote_amount: 10 * SOL, dev_buy_quote: dev_buy, min_dev_buy_out: 1 },
    );
    let budget = compute_budget_ix(400_000);
    let size = env.tx_size(&[budget.clone(), ix.clone()], &dev.pubkey(), 1);
    println!("launch tx size (legacy, no lookup table): {size} bytes");
    assert!(size <= 1232, "launch must fit one legacy transaction");
    env.ok(&[budget, ix], &[&dev]);

    // fee
    assert_eq!(env.lamports(&env.treasury.pubkey()), treasury_before + LAUNCH_FEE);
    // LP locked: every share the launch minted sits in the pool's lock account, the dev
    // keeps none
    let lp_supply = env.mint_supply(&k.lp_mint);
    assert!(lp_supply > 1_000_000_000);
    assert_eq!(env.balance(&k.lp_lock), lp_supply);
    assert_eq!(env.balance(&ata(&dev.pubkey(), &k.lp_mint)), 0);
    // record
    let launch_key = Pubkey::find_program_address(&[hooklaunch::LAUNCH_SEED, base_mint.as_ref()], &hooklaunch::ID).0;
    let rec: hooklaunch::Launch = env.account(&launch_key);
    assert_eq!(rec.dev, dev.pubkey());
    assert_eq!(rec.pool, k.pool);
    assert_eq!(rec.hook_program, hook_tax::ID);
    assert_eq!(rec.launch_fee_paid, LAUNCH_FEE);
    assert_eq!(rec.dev_buy_quote, dev_buy);
    assert_eq!(rec.lp_locked, lp_supply - 1_000);
    // dev buy happened through the hook: tax went to the dev's own treasury ATA,
    // and the dev holds some coin again
    let pool = env.pool(&k.pool);
    assert_eq!(pool.swap_count, 1);
    assert!(env.balance(&ata(&dev.pubkey(), &base_mint)) > 0);
    let spent = dev_quote_before - env.balance(&ata(&dev.pubkey(), &m.quote_mint));
    // paid 10 SOL liquidity + 2 SOL buy, got the 3% tax of the buy back into the same ATA
    assert!(spent < 12 * SOL && spent > 11 * SOL, "spent {spent}");
    assert!(pool.hook_fees_quote_total > 0);

    // a second launch for the same mint is impossible
    let ix = launch_ix(
        &env,
        &dev.pubkey(),
        &k,
        &hook,
        hooklaunch::LaunchArgs { lp_fee_bps: 30, base_amount: 1, quote_amount: 1, dev_buy_quote: 0, min_dev_buy_out: 0 },
    );
    assert!(env.send(&[ix], &[&dev]).is_err());

    // and the public can trade it like any pool (the SDK creates the coin ATA with the swap)
    env.create_ata(&m.trader, &m.trader.pubkey(), &base_mint);
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, 300, None);
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, q.amount_out)
        .unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
}

#[test]
fn launch_without_hook_and_without_dev_buy() {
    let mut env = Env::new();
    let m = env.market();
    let dev = env.user(20 * SOL);
    env.fund(&dev, &m.authority, &m.base_mint, &m.quote_mint, 0, 50 * SOL);
    let mint = Keypair::new();
    env.ok(&[create_token_ix(&dev.pubkey(), &mint.pubkey(), "Plain", "PLN")], &[&dev, &mint]);
    let k = Env::pool_keys(&mint.pubkey(), &m.quote_mint);
    let ix = launch_ix(
        &env,
        &dev.pubkey(),
        &k,
        &HookRef::none(),
        hooklaunch::LaunchArgs { lp_fee_bps: 100, base_amount: SUPPLY, quote_amount: 5 * SOL, dev_buy_quote: 0, min_dev_buy_out: 0 },
    );
    env.ok(&[compute_budget_ix(400_000), ix], &[&dev]);
    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_kind, HOOK_KIND_NONE);
    assert_eq!(pool.swap_count, 0);
    assert_eq!(env.balance(&k.lp_lock), env.mint_supply(&k.lp_mint));
}

#[test]
fn launch_liquidity_never_comes_back_and_a_small_deposit_works() {
    let mut env = Env::new();
    let m = env.market();
    let dev = env.user(20 * SOL);
    env.fund(&dev, &m.authority, &m.base_mint, &m.quote_mint, 0, 50 * SOL);
    let mint = Keypair::new();
    env.ok(&[create_token_ix(&dev.pubkey(), &mint.pubkey(), "Lock Coin", "LOCK")], &[&dev, &mint]);
    let base_mint = mint.pubkey();
    let k = Env::pool_keys(&base_mint, &m.quote_mint);
    let none = HookRef::none();
    let ix = launch_ix(
        &env,
        &dev.pubkey(),
        &k,
        &none,
        hooklaunch::LaunchArgs { lp_fee_bps: 30, base_amount: SUPPLY, quote_amount: 10 * SOL, dev_buy_quote: SOL, min_dev_buy_out: 1 },
    );
    env.ok(&[compute_budget_ix(400_000), ix], &[&dev]);

    // the whole supply of shares is in the lock account; the dev holds none, so the dev
    // can take nothing out, not even one unit
    let supply = env.mint_supply(&k.lp_mint);
    assert_eq!(env.balance(&k.lp_lock), supply);
    assert_eq!(env.balance(&ata(&dev.pubkey(), &k.lp_mint)), 0);
    let ix = env.remove_liquidity_ix(&dev.pubkey(), &k, &none, 1, 0, 0);
    assert!(env.send(&[ix], &[&dev]).is_err());

    // somebody else buys some of the coin and adds one millionth of the pool
    let trader = m.trader.pubkey();
    env.create_ata(&m.trader, &trader, &base_mint);
    env.swap(&m.trader, &k, &none, DIRECTION_BUY, SOL, 1).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    env.ok(&[Env::create_ata_ix(&trader, &trader, &k.lp_mint)], &[&m.trader]);
    let pool = env.pool(&k.pool);
    let lp = supply / 1_000_000;
    assert!(lp > 1_000, "shares are fine-grained: {lp}");
    let need_base = ((lp as u128 * pool.reserve_base as u128).div_ceil(supply as u128)) as u64;
    let need_quote = ((lp as u128 * pool.reserve_quote as u128).div_ceil(supply as u128)) as u64;
    assert!(need_quote < pool.reserve_quote / 999_000, "a small deposit stays small: {need_quote}");
    let quote_before = env.balance(&ata(&trader, &m.quote_mint));
    let ix = env.add_liquidity_ix(&trader, &k, &none, lp, need_base, need_quote);
    env.ok(&[ix], &[&m.trader]);
    assert_eq!(env.balance(&ata(&trader, &k.lp_mint)), lp);
    assert_eq!(quote_before - env.balance(&ata(&trader, &m.quote_mint)), need_quote);

    // and takes it out again: at most what went in, and the lock account is untouched
    let ix = env.remove_liquidity_ix(&trader, &k, &none, lp, 0, 0);
    env.ok(&[ix], &[&m.trader]);
    let back = env.balance(&ata(&trader, &m.quote_mint)) + need_quote - quote_before;
    assert!(back <= need_quote && back + 2 >= need_quote, "back {back} of {need_quote}");
    assert_eq!(env.mint_supply(&k.lp_mint), supply + 0);
    assert_eq!(env.balance(&k.lp_lock), supply);
}

#[test]
fn launch_refuses_mints_with_authorities_and_curve_hooks() {
    let mut env = Env::new();
    let m = env.market();
    let dev = env.user(20 * SOL);
    env.fund(&dev, &m.authority, &m.base_mint, &m.quote_mint, 0, 50 * SOL);

    // a hand-made mint that kept its mint and freeze authority
    let bad_mint = env.create_mint(&m.authority, 6);
    env.create_ata(&dev, &dev.pubkey(), &bad_mint);
    env.mint_to(&m.authority, &bad_mint, &ata(&dev.pubkey(), &bad_mint), SUPPLY);
    let k = Env::pool_keys(&bad_mint, &m.quote_mint);
    let ix = launch_ix(&env, &dev.pubkey(), &k, &HookRef::none(), hooklaunch::LaunchArgs { lp_fee_bps: 30, base_amount: SUPPLY, quote_amount: 5 * SOL, dev_buy_quote: 0, min_dev_buy_out: 0 });
    env.err(&[compute_budget_ix(400_000), ix], &[&dev], "no mint authority and no freeze authority");

    // a proper coin, but a hook that owns the curve
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL | OVERRIDE_CURVE);
    let mint = Keypair::new();
    env.ok(&[create_token_ix(&dev.pubkey(), &mint.pubkey(), "Curvy", "CRV")], &[&dev, &mint]);
    let k = Env::pool_keys(&mint.pubkey(), &m.quote_mint);
    let hook = env.evil_hook(&dev, &k.pool, &m.quote_mint, &dev.pubkey(), hook_evil::MODE_SILENT, 0);
    let hook = HookRef { treasury: system_program::ID, ..hook };
    let ix = launch_ix(&env, &dev.pubkey(), &k, &hook, hooklaunch::LaunchArgs { lp_fee_bps: 30, base_amount: SUPPLY, quote_amount: 5 * SOL, dev_buy_quote: 0, min_dev_buy_out: 0 });
    env.err(&[compute_budget_ix(400_000), ix], &[&dev], "own the price curve");
}
