//! early_bird against the real pool program, in process (LiteSVM).
//!
//! `hookpool_tests::Env` is the Programmable repository's own harness: it loads the pool, the
//! launchpad and the platform's hooks from the repository's build, and initialises the
//! platform. Run with `bash scripts/test.sh`: it builds the hook and tells the tests
//! where the binary is (HOOK_SO).

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use hookpool_interface::*;
use hookpool_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const BASE_LIQ: u64 = 1_000_000_000_000;
const QUOTE_LIQ: u64 = 100 * SOL;
const LP_FEE: u16 = 100; // the pool's own fee: 1%
const WINDOW: u64 = 100; // slots
const DISCOUNT: u16 = 5_000; // early buyers pay half of it

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
        data: hook::instruction::InitManifest { name: "early bird".into(), uri: "https://example.com/early-bird".into() }.data(),
    };
    env.ok(&[ix], &[&deployer]);
    if freeze {
        env.patch_upgrade_authority(&id, None);
    }
    id
}

fn init_config_ix(id: &Pubkey, payer: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: *id,
        accounts: hook::accounts::InitPoolConfig { payer: *payer, cfg: HookRef::cfg(id, pool), system_program: system_program::ID }
            .to_account_metas(None),
        data: hook::instruction::InitPoolConfig { pool: *pool, window_slots: WINDOW, discount_bps: DISCOUNT }.data(),
    }
}

/// What a client passes for this hook: no treasury (it takes no fee) and one extra
/// account, its per-pool config, writable.
fn hook_ref(id: &Pubkey, pool: &Pubkey) -> HookRef {
    HookRef { program: *id, treasury: system_program::ID, extra: vec![AccountMeta::new(HookRef::cfg(id, pool), false)] }
}

/// Buy for 1 unit of the quote token and require exactly the output of `fee_override`.
fn buy_exact(env: &mut Env, trader: &Keypair, k: &PoolKeys, hook: &HookRef, fee_override: Option<u16>) {
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, 0, fee_override);
    let coins = ata(&trader.pubkey(), &k.base_mint);
    let before = env.balance(&coins);
    // min_amount_out is the exact expected output: a higher fee would fail on slippage,
    env.swap(trader, k, hook, DIRECTION_BUY, SOL, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    // and a lower fee would give more coins and leave less in the pool.
    assert_eq!(env.balance(&coins), before + q.amount_out);
    assert_eq!(env.pool(&k.pool).reserve_quote, q.reserve_in_after);
}

#[test]
fn early_buys_pay_half_the_pool_fee_then_the_normal_fee() {
    let mut env = Env::new();
    let id = load_hook(&mut env, true);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    env.ok(&[init_config_ix(&id, &m.creator.pubkey(), &k.pool)], &[&m.creator]);
    let hook = hook_ref(&id, &k.pool);

    env.svm.warp_to_slot(1_000);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    let cfg: hook::Config = env.account(&HookRef::cfg(&id, &k.pool));
    assert_eq!(cfg.created_slot, 1_000, "on_pool_create wrote the creation slot");
    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_kind, HOOK_KIND_FROZEN);
    assert_eq!(pool.hook_flags, hook::FLAGS);
    assert_eq!(pool.hook_quote_treasury, Pubkey::default(), "a hook without TAKE_HOOK_FEE has no treasury");

    // inside the window: half of 100 bps
    buy_exact(&mut env, &m.trader, &k, &hook, Some(50));
    env.svm.warp_to_slot(1_000 + WINDOW - 1);
    buy_exact(&mut env, &m.trader, &k, &hook, Some(50));

    // a sell inside the window pays the pool's own fee, and needs no hook account at all
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_SELL, 1_000_000_000, 0, None);
    let quote = ata(&m.trader.pubkey(), &k.quote_mint);
    let before = env.balance(&quote);
    let no_extras = HookRef { extra: vec![], ..hook.clone() };
    env.swap(&m.trader, &k, &no_extras, DIRECTION_SELL, 1_000_000_000, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    assert_eq!(env.balance(&quote), before + q.amount_out);

    // the first slot after the window: the pool's own fee
    env.svm.warp_to_slot(1_000 + WINDOW);
    buy_exact(&mut env, &m.trader, &k, &hook, None);
    assert_eq!(env.pool(&k.pool).hook_fees_quote_total, 0, "the hook never took a fee");
}

#[test]
fn the_pool_refuses_the_hook_while_it_is_upgradeable() {
    let mut env = Env::new();
    let id = load_hook(&mut env, false);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    env.ok(&[init_config_ix(&id, &m.creator.pubkey(), &k.pool)], &[&m.creator]);
    let hook = hook_ref(&id, &k.pool);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "HookNotFrozen");
}

#[test]
fn a_pool_cannot_start_without_its_config_or_on_a_strangers() {
    let mut env = Env::new();
    let id = load_hook(&mut env, true);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = hook_ref(&id, &k.pool);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    env.err(&[compute_budget_ix(400_000), ix.clone()], &[&m.creator], "AccountNotInitialized");
    // a stranger pays for the config: on_pool_create refuses the pool
    let stranger = env.user(SOL);
    env.ok(&[init_config_ix(&id, &stranger.pubkey(), &k.pool)], &[&stranger]);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "WrongCreator");
}

#[test]
fn a_callback_called_directly_is_refused() {
    let mut env = Env::new();
    let id = load_hook(&mut env, true);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    env.ok(&[init_config_ix(&id, &m.creator.pubkey(), &k.pool)], &[&m.creator]);
    let hook = hook_ref(&id, &k.pool);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    // the attacker puts its own wallet, signing, where the pool's caller PDA belongs
    let attacker = env.user(SOL);
    let ix = Instruction {
        program_id: id,
        accounts: hook::accounts::Callback {
            pool: k.pool,
            hook_caller: attacker.pubkey(),
            user: attacker.pubkey(),
            quote_mint: k.quote_mint,
            base_mint: k.base_mint,
            cfg: HookRef::cfg(&id, &k.pool),
        }
        .to_account_metas(None),
        data: hook::instruction::BeforeSwap { payload: SwapPayload { direction: DIRECTION_BUY, amount_in: SOL, lp_fee_bps: LP_FEE, slot: 1, ..Default::default() } }.data(),
    };
    env.err(&[ix], &[&attacker], "CallerMismatch");
}
