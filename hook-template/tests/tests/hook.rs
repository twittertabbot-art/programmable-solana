//! The template hook against the real pool program, in process (LiteSVM).
//!
//! `hookpool_tests::Env` is the Programmable repository's own harness: it loads the pool, the
//! launchpad and the platform's hooks from the repository's build, and initialises the
//! platform. These tests add this hook's binary and treat it the way a deploy would.
//!
//! Run with `bash scripts/test.sh`: it builds the hook and tells the tests where the
//! binary is (HOOK_SO).

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use hookpool_interface::*;
use hookpool_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const BASE_LIQ: u64 = 1_000_000_000_000; // one million coins of 6 decimals
const QUOTE_LIQ: u64 = 100 * SOL;
const LP_FEE: u16 = 100; // the pool's own fee: 1%
const FEE: u16 = 250; // the hook's fee: 2.5%
const CEILING: u16 = 500; // which its owner can never raise above 5%

fn hook_so() -> Vec<u8> {
    let path = std::env::var("HOOK_SO").expect("HOOK_SO is not set. Run the tests with: bash scripts/test.sh");
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// Load the hook, publish its manifest as its deployer and, when asked, freeze it.
fn load_hook(env: &mut Env, freeze: bool) -> Pubkey {
    let id = hook::ID;
    env.svm.add_program(id, &hook_so()).unwrap();
    // LiteSVM loads every program with no upgrade authority. `init_manifest` needs one,
    // so the test writes the deployer into the ProgramData account, as a deploy would.
    let deployer = env.user(SOL);
    env.patch_upgrade_authority(&id, Some(deployer.pubkey()));
    let ix = Instruction {
        program_id: id,
        accounts: hook::accounts::InitManifest {
            authority: deployer.pubkey(),
            program_data: program_data_address(&id),
            manifest: manifest_address(&id).0,
            extra_metas: extra_metas_address(&id).0,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook::instruction::InitManifest { name: "my hook".into(), uri: "https://example.com/my-hook".into() }.data(),
    };
    env.ok(&[ix], &[&deployer]);
    if freeze {
        // What `solana program set-upgrade-authority --final` does.
        env.patch_upgrade_authority(&id, None);
    }
    id
}

fn init_config_ix(id: &Pubkey, payer: &Pubkey, pool: &Pubkey, fee_bps: u16, max_bps: u16) -> Instruction {
    Instruction {
        program_id: *id,
        accounts: hook::accounts::InitPoolConfig {
            payer: *payer,
            owner: *payer,
            cfg: HookRef::cfg(id, pool),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook::instruction::InitPoolConfig { pool: *pool, fee_bps, max_bps }.data(),
    }
}

fn set_fee_ix(id: &Pubkey, owner: &Pubkey, pool: &Pubkey, fee_bps: u16) -> Instruction {
    Instruction {
        program_id: *id,
        accounts: hook::accounts::OwnerOnly { owner: *owner, cfg: HookRef::cfg(id, pool) }.to_account_metas(None),
        data: hook::instruction::SetFee { fee_bps }.data(),
    }
}

/// What a client passes for this hook: the treasury that receives its fee, and its one
/// extra account, the per-pool config, read-only.
fn hook_ref(id: &Pubkey, pool: &Pubkey, treasury: Pubkey) -> HookRef {
    HookRef { program: *id, treasury, extra: vec![AccountMeta::new_readonly(HookRef::cfg(id, pool), false)] }
}

struct Setup {
    env: Env,
    id: Pubkey,
    m: Market,
    k: PoolKeys,
    hook: HookRef,
    treasury: Pubkey,
    treasury_owner: Keypair,
}

/// A frozen hook, a config made by the pool's creator, and a pool that uses both.
fn pool_with_the_hook() -> Setup {
    let mut env = Env::new();
    let id = load_hook(&mut env, true);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    env.ok(&[init_config_ix(&id, &m.creator.pubkey(), &k.pool, FEE, CEILING)], &[&m.creator]);
    // The treasury is the pool creator's choice, not the hook author's. Here it is the
    // associated token account of a third wallet.
    let treasury_owner = env.user(SOL);
    let treasury = env.create_ata(&m.creator, &treasury_owner.pubkey(), &m.quote_mint);
    let hook = hook_ref(&id, &k.pool, treasury);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    Setup { env, id, m, k, hook, treasury, treasury_owner }
}

fn swap_ok(env: &mut Env, trader: &Keypair, k: &PoolKeys, hook: &HookRef, direction: u8, amount_in: u64, min_out: u64) {
    env.swap(trader, k, hook, direction, amount_in, min_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
}

#[test]
fn the_fee_reaches_the_treasury_on_buys_and_on_sells() {
    let Setup { mut env, id, m, k, hook, treasury, treasury_owner } = pool_with_the_hook();
    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_program, id);
    assert_eq!(pool.hook_kind, HOOK_KIND_FROZEN);
    assert_eq!(pool.hook_flags, hook::FLAGS, "the pool copied the manifest's flags");
    assert_eq!(pool.hook_quote_treasury, treasury);
    assert_eq!(pool.hook_treasury_owner, treasury_owner.pubkey());

    // A buy of 1 unit of the quote token. The pool takes its protocol fee first, then
    // the hook's 2.5% of what is left, rounded up, and pays it to the treasury.
    let buy = expect_swap(&pool, DIRECTION_BUY, SOL, FEE, None);
    let left = SOL - (SOL * PROTOCOL_FEE_BPS as u64).div_ceil(10_000);
    assert_eq!(buy.hook_fee, (left * FEE as u64).div_ceil(10_000));
    let coins = ata(&m.trader.pubkey(), &k.base_mint);
    let (coins_before, treasury_before) = (env.balance(&coins), env.balance(&treasury));
    // min_amount_out is the exact expected output: a higher fee would fail on slippage
    swap_ok(&mut env, &m.trader, &k, &hook, DIRECTION_BUY, SOL, buy.amount_out);
    assert_eq!(env.balance(&coins), coins_before + buy.amount_out);
    assert_eq!(env.balance(&treasury), treasury_before + buy.hook_fee);

    // A sell of 1,000 coins. The fee is 2.5% of what the curve pays out, rounded up, in
    // the quote token again.
    let pool = env.pool(&k.pool);
    let sell = expect_swap(&pool, DIRECTION_SELL, 1_000_000_000, FEE, None);
    assert_eq!(sell.hook_fee, (sell.amount_out_gross * FEE as u64).div_ceil(10_000));
    let quote = ata(&m.trader.pubkey(), &k.quote_mint);
    let (quote_before, treasury_before) = (env.balance(&quote), env.balance(&treasury));
    swap_ok(&mut env, &m.trader, &k, &hook, DIRECTION_SELL, 1_000_000_000, sell.amount_out);
    assert_eq!(env.balance(&quote), quote_before + sell.amount_out);
    assert_eq!(env.balance(&treasury), treasury_before + sell.hook_fee);

    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_fees_quote_total, buy.hook_fee + sell.hook_fee);
    assert_eq!(pool.hook_fees_owed_quote, 0, "nothing is left waiting: the treasury exists");
}

#[test]
fn a_callback_called_directly_is_refused() {
    let Setup { mut env, id, k, treasury, .. } = pool_with_the_hook();
    let attacker = env.user(SOL);
    let payload = SwapPayload { direction: DIRECTION_BUY, amount_in: SOL, lp_fee_bps: LP_FEE, slot: 1, ..Default::default() };
    let callback = |hook_caller: Pubkey| Instruction {
        program_id: id,
        accounts: hook::accounts::Callback {
            pool: k.pool,
            hook_caller,
            user: attacker.pubkey(),
            quote_mint: k.quote_mint,
            base_mint: k.base_mint,
            cfg: HookRef::cfg(&id, &k.pool),
        }
        .to_account_metas(None),
        data: hook::instruction::BeforeSwap { payload }.data(),
    };

    // 1. the attacker signs with its own wallet where the pool's caller PDA belongs
    env.err(&[callback(attacker.pubkey())], &[&attacker], "CallerMismatch");

    // 2. the real caller PDA, but nobody can sign for it outside the pool program
    let mut unsigned = callback(caller_address(&id).0);
    unsigned.accounts[1].is_signer = false;
    env.err(&[unsigned], &[&attacker], "AccountNotSigner");

    // and the treasury received nothing from either attempt
    assert_eq!(env.balance(&treasury), 0);
}

#[test]
fn the_pool_refuses_the_hook_while_it_is_upgradeable() {
    let mut env = Env::new();
    let id = load_hook(&mut env, false);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    env.ok(&[init_config_ix(&id, &m.creator.pubkey(), &k.pool, FEE, CEILING)], &[&m.creator]);
    let hook = hook_ref(&id, &k.pool, ata(&m.creator.pubkey(), &m.quote_mint));
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "HookNotFrozen");
}

#[test]
fn a_pool_cannot_start_without_its_config_or_on_a_strangers() {
    let mut env = Env::new();
    let id = load_hook(&mut env, true);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = hook_ref(&id, &k.pool, ata(&m.creator.pubkey(), &m.quote_mint));
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    // no config yet: Anchor refuses the callback's account, the pool is not created
    env.err(&[compute_budget_ix(400_000), ix.clone()], &[&m.creator], "AccountNotInitialized");
    // a stranger creates the config first: on_pool_create refuses the pool
    let stranger = env.user(SOL);
    env.ok(&[init_config_ix(&id, &stranger.pubkey(), &k.pool, CEILING, CEILING)], &[&stranger]);
    let e = env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "WrongCreator");
    // the hook's own errors are numbered from 7000 (see MyHookError), not from 6000
    assert!(e.meta.logs.iter().any(|l| l.contains("Error Number: 7005")), "{}", e.meta.pretty_logs());
}

#[test]
fn the_config_owner_moves_the_fee_but_never_above_the_ceiling() {
    let Setup { mut env, id, m, k, hook, treasury, .. } = pool_with_the_hook();
    let owner = m.creator.pubkey();

    // The program is frozen and this still works: freezing fixes the code, not the
    // accounts the program owns.
    env.ok(&[set_fee_ix(&id, &owner, &k.pool, CEILING)], &[&m.creator]);
    let pool = env.pool(&k.pool);
    let buy = expect_swap(&pool, DIRECTION_BUY, SOL, CEILING, None);
    let before = env.balance(&treasury);
    swap_ok(&mut env, &m.trader, &k, &hook, DIRECTION_BUY, SOL, buy.amount_out);
    assert_eq!(env.balance(&treasury), before + buy.hook_fee);

    env.err(&[set_fee_ix(&id, &owner, &k.pool, CEILING + 1)], &[&m.creator], "AboveCeiling");
    let stranger = env.user(SOL);
    env.err(&[set_fee_ix(&id, &stranger.pubkey(), &k.pool, 0)], &[&stranger], "NotOwner");

    // the owner renounces: from now on the fee can never change
    let renounce = Instruction {
        program_id: id,
        accounts: hook::accounts::OwnerOnly { owner, cfg: HookRef::cfg(&id, &k.pool) }.to_account_metas(None),
        data: hook::instruction::SetOwner { new_owner: Pubkey::default() }.data(),
    };
    env.ok(&[renounce], &[&m.creator]);
    env.err(&[set_fee_ix(&id, &owner, &k.pool, 0)], &[&m.creator], "NotOwner");
    let cfg: hook::Config = env.account(&HookRef::cfg(&id, &k.pool));
    assert_eq!((cfg.fee_bps, cfg.max_bps, cfg.owner), (CEILING, CEILING, Pubkey::default()));
}
