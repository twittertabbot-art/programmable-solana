//! loyalty_points against the real pool program, in process (LiteSVM).
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
const LP_FEE: u16 = 100;
const QUOTE_PER_POINT: u64 = 1_000_000; // 0.001 of the quote token sent = 1 point

fn hook_so() -> Vec<u8> {
    let path = std::env::var("HOOK_SO").expect("HOOK_SO is not set. Run the tests with: bash scripts/test.sh");
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// Load the hook, publish its manifest as its deployer, and freeze it.
fn load_hook(env: &mut Env) -> Pubkey {
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
        data: hook::instruction::InitManifest { name: "loyalty points".into(), uri: "https://example.com/loyalty-points".into() }.data(),
    };
    env.ok(&[ix], &[&deployer]);
    env.patch_upgrade_authority(&id, None);
    id
}

fn init_config_ix(id: &Pubkey, payer: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: *id,
        accounts: hook::accounts::InitPoolConfig { payer: *payer, cfg: HookRef::cfg(id, pool), system_program: system_program::ID }
            .to_account_metas(None),
        data: hook::instruction::InitPoolConfig { pool: *pool, quote_per_point: QUOTE_PER_POINT }.data(),
    }
}

/// A wallet's points account in a pool: PDA ["points", pool, wallet] of the hook.
fn points_address(id: &Pubkey, pool: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[hook::POINTS_SEED, pool.as_ref(), wallet.as_ref()], id).0
}

fn open_points_ix(id: &Pubkey, owner: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: *id,
        accounts: hook::accounts::OpenPoints { owner: *owner, pool: *pool, points: points_address(id, pool, owner), system_program: system_program::ID }
            .to_account_metas(None),
        data: hook::instruction::OpenPoints {}.data(),
    }
}

/// What a client passes for this hook when `trader` swaps: no treasury (the hook takes no
/// fee) and two extra accounts, both writable: the pool's config and the trader's points.
fn hook_ref(id: &Pubkey, pool: &Pubkey, trader: &Pubkey) -> HookRef {
    HookRef {
        program: *id,
        treasury: system_program::ID,
        extra: vec![AccountMeta::new(HookRef::cfg(id, pool), false), AccountMeta::new(points_address(id, pool, trader), false)],
    }
}

struct Setup {
    env: Env,
    id: Pubkey,
    m: Market,
    k: PoolKeys,
}

fn pool_with_the_hook() -> Setup {
    let mut env = Env::new();
    let id = load_hook(&mut env);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    env.ok(&[init_config_ix(&id, &m.creator.pubkey(), &k.pool)], &[&m.creator]);
    let hook = hook_ref(&id, &k.pool, &m.creator.pubkey());
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    Setup { env, id, m, k }
}

fn config(env: &Env, id: &Pubkey, pool: &Pubkey) -> hook::Config {
    env.account(&HookRef::cfg(id, pool))
}
fn points(env: &Env, id: &Pubkey, pool: &Pubkey, wallet: &Pubkey) -> hook::Points {
    env.account(&points_address(id, pool, wallet))
}

/// A buy that must pay out exactly what the pool alone would: the hook changes no price.
fn buy(env: &mut Env, who: &Keypair, k: &PoolKeys, hook: &HookRef, amount_in: u64) {
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_BUY, amount_in, 0, None);
    let coins = ata(&who.pubkey(), &k.base_mint);
    let before = env.balance(&coins);
    env.swap(who, k, hook, DIRECTION_BUY, amount_in, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    assert_eq!(env.balance(&coins), before + q.amount_out);
}

#[test]
fn a_buyer_with_an_account_earns_points_and_one_without_still_trades() {
    let Setup { mut env, id, m, k } = pool_with_the_hook();
    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_kind, HOOK_KIND_FROZEN);
    assert_eq!(pool.hook_flags, hook::FLAGS);
    assert!(config(&env, &id, &k.pool).live, "on_pool_create marked the config live");

    // the trader opens an account (own signature, own rent) and buys for 1 quote token
    let trader = m.trader.pubkey();
    env.ok(&[open_points_ix(&id, &trader, &k.pool)], &[&m.trader]);
    let hook = hook_ref(&id, &k.pool, &trader);
    buy(&mut env, &m.trader, &k, &hook, SOL);
    let p = points(&env, &id, &k.pool, &trader);
    assert_eq!((p.points, p.buys, p.owner, p.pool), (1_000, 1, trader, k.pool));
    let c = config(&env, &id, &k.pool);
    assert_eq!((c.total_points, c.buys_seen, c.buys_rewarded), (1_000, 1, 1));

    // another wallet buys without ever opening one: the buy goes through and earns nothing
    let other = m.creator.pubkey();
    let other_hook = hook_ref(&id, &k.pool, &other);
    buy(&mut env, &m.creator, &k, &other_hook, 2 * SOL);
    assert_eq!(env.lamports(&points_address(&id, &k.pool, &other)), 0, "still no account at that address");
    let c = config(&env, &id, &k.pool);
    assert_eq!((c.total_points, c.buys_seen, c.buys_rewarded), (1_000, 2, 1));

    // a sell: the pool never calls this hook on one, so it needs no hook account at all
    let pool = env.pool(&k.pool);
    let q = expect_swap(&pool, DIRECTION_SELL, 1_000_000_000, 0, None);
    let no_extras = HookRef { extra: vec![], ..hook.clone() };
    env.swap(&m.trader, &k, &no_extras, DIRECTION_SELL, 1_000_000_000, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    let c = config(&env, &id, &k.pool);
    assert_eq!((c.total_points, c.buys_seen, c.buys_rewarded), (1_000, 2, 1), "a sell changes nothing");

    // open the account and buy in ONE transaction
    let swap = env.swap_ix(&other, &k, &other_hook, DIRECTION_BUY, SOL / 2, 0);
    env.ok(&[open_points_ix(&id, &other, &k.pool), swap], &[&m.creator]);
    assert_eq!(points(&env, &id, &k.pool, &other).points, 500);
    let c = config(&env, &id, &k.pool);
    assert_eq!((c.total_points, c.buys_seen, c.buys_rewarded), (1_500, 3, 2));
    assert_eq!(env.pool(&k.pool).hook_fees_quote_total, 0, "the hook never took a fee");
}

#[test]
fn the_pool_passes_exactly_the_accounts_of_the_list() {
    let Setup { mut env, id, m, k } = pool_with_the_hook();
    let trader = m.trader.pubkey();
    env.ok(&[open_points_ix(&id, &trader, &k.pool)], &[&m.trader]);
    let cfg = AccountMeta::new(HookRef::cfg(&id, &k.pool), false);
    let mine = AccountMeta::new(points_address(&id, &k.pool, &trader), false);
    let with = |extra: Vec<AccountMeta>| HookRef { program: id, treasury: system_program::ID, extra };

    // The pool derives each address from the hook's list. A client that leaves one out,
    // or passes somebody else's account in its place, is refused by the pool itself.
    let ix = env.swap_ix(&trader, &k, &with(vec![cfg.clone()]), DIRECTION_BUY, SOL, 0);
    env.err(&[ix], &[&m.trader], "HookExtraAccounts");
    let creator = m.creator.pubkey();
    env.ok(&[open_points_ix(&id, &creator, &k.pool)], &[&m.creator]);
    let theirs = AccountMeta::new(points_address(&id, &k.pool, &creator), false);
    let ix = env.swap_ix(&trader, &k, &with(vec![cfg.clone(), theirs.clone()]), DIRECTION_BUY, SOL, 0);
    env.err(&[ix], &[&m.trader], "HookExtraAccounts");
    assert_eq!(points(&env, &id, &k.pool, &creator).points, 0, "nobody earns points with another wallet's buy");

    // An account the list marks writable has to be passed writable.
    let read_only = AccountMeta::new_readonly(mine.pubkey, false);
    let ix = env.swap_ix(&trader, &k, &with(vec![cfg.clone(), read_only]), DIRECTION_BUY, SOL, 0);
    env.err(&[ix], &[&m.trader], "PrivilegeEscalation");

    // The order the client passes them in does not matter, and neither does one too many:
    // the hook still receives exactly the listed accounts, in the order of the list.
    buy(&mut env, &m.trader, &k, &with(vec![mine.clone(), cfg.clone()]), SOL);
    buy(&mut env, &m.trader, &k, &with(vec![cfg, theirs, mine]), SOL);
    let p = points(&env, &id, &k.pool, &trader);
    assert_eq!((p.points, p.buys), (2_000, 2));
    assert_eq!(points(&env, &id, &k.pool, &creator).points, 0);
}

#[test]
fn a_callback_called_directly_is_refused() {
    let Setup { mut env, id, m, k } = pool_with_the_hook();
    let attacker = env.user(SOL);
    env.ok(&[open_points_ix(&id, &attacker.pubkey(), &k.pool)], &[&attacker]);
    // the attacker claims a huge buy, with its own wallet where the pool's caller PDA belongs
    let ix = Instruction {
        program_id: id,
        accounts: hook::accounts::Callback {
            pool: k.pool,
            hook_caller: attacker.pubkey(),
            user: attacker.pubkey(),
            quote_mint: k.quote_mint,
            base_mint: k.base_mint,
            cfg: HookRef::cfg(&id, &k.pool),
            points: points_address(&id, &k.pool, &attacker.pubkey()),
        }
        .to_account_metas(None),
        data: hook::instruction::AfterSwap { payload: SwapPayload { direction: DIRECTION_BUY, amount_in: 1_000_000 * SOL, ..Default::default() } }.data(),
    };
    env.err(&[ix], &[&attacker], "CallerMismatch");
    assert_eq!(points(&env, &id, &k.pool, &attacker.pubkey()).points, 0);
    assert_eq!(config(&env, &id, &k.pool).buys_seen, 0);
    let _ = m;
}

#[test]
fn points_cannot_be_credited_through_another_hook() {
    // A program that the pool calls receives the pool's signature and can pass it on.
    // So another hook could call this hook's `after_swap` itself, with a payload it made
    // up, if the pool signed every callback with the same address. It does not: it signs
    // with `["caller", hook program]`, and `verify_caller(.., &crate::ID)` accepts only
    // the address of this hook. `Env::relay_pool` builds the attack: a pool of the
    // attacker's own whose hook (the repository's test hook, in relay mode) forwards the
    // signature it gets to the callback named here.
    let Setup { mut env, id, m, k } = pool_with_the_hook();
    let cheat = env.user(SOL);
    env.ok(&[open_points_ix(&id, &cheat.pubkey(), &k.pool)], &[&cheat]);
    let points_key = points_address(&id, &k.pool, &cheat.pubkey());
    // the accounts of this hook's callback, without the caller: pool, user, the two mints,
    // then the two extra accounts
    let victim = [
        AccountMeta::new_readonly(k.pool, false),
        AccountMeta::new_readonly(cheat.pubkey(), false),
        AccountMeta::new_readonly(k.quote_mint, false),
        AccountMeta::new_readonly(k.base_mint, false),
        AccountMeta::new(HookRef::cfg(&id, &k.pool), false),
        AccountMeta::new(points_key, false),
    ];
    // "a buy of a million units of the quote token"
    let forged = SwapPayload { direction: DIRECTION_BUY, amount_in: 1_000_000 * SOL, ..Default::default() };
    let (attacker, x, x_hook) = env.relay_pool(&id, &victim, hook::instruction::AfterSwap { payload: forged }.data());
    let fire = |env: &mut Env| {
        let ix = env.swap_ix(&attacker.pubkey(), &x, &x_hook, DIRECTION_BUY, SOL / 10, 0);
        env.err(&[compute_budget_ix(400_000), ix], &[&attacker], "CallerMismatch")
    };
    let failed = fire(&mut env);
    // the signature did arrive: it is the address that is refused
    assert!(!failed.meta.logs.join("
").contains("AccountNotSigner"));
    assert_eq!(points(&env, &id, &k.pool, &cheat.pubkey()).points, 0);
    assert_eq!(config(&env, &id, &k.pool).buys_seen, 0);

    // the same through `on_pool_create`
    let forged = PoolCreatePayload { lp_fee_bps: LP_FEE, base_amount: BASE_LIQ, quote_amount: QUOTE_LIQ, creator: m.creator.pubkey() };
    env.evil_set_relay(&attacker, &x.pool, &id, hook::instruction::OnPoolCreate { payload: forged }.data());
    fire(&mut env);

    // and the address the pool signs this hook's callbacks with is its own
    assert_ne!(caller_address(&id).0, x_hook.caller());
}

#[test]
fn a_pool_cannot_start_on_a_strangers_config_and_points_open_only_for_this_hooks_pools() {
    let mut env = Env::new();
    let id = load_hook(&mut env);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    // a stranger creates the config first: on_pool_create refuses the pool
    let stranger = env.user(SOL);
    env.ok(&[init_config_ix(&id, &stranger.pubkey(), &k.pool)], &[&stranger]);
    let hook = hook_ref(&id, &k.pool, &m.creator.pubkey());
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "WrongCreator");

    // a pool that does not use this hook: nobody can open a points account for it
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, LP_FEE, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    env.err(&[open_points_ix(&id, &m.trader.pubkey(), &k.pool)], &[&m.trader], "NotOurPool");
}
