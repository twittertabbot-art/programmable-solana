//! The approved list (HOOKS.md section 6.1): while the platform's rule is on, a hook that is
//! not the platform's own opens a pool only once the admin has put its program on the list
//! kept after the Platform account's fixed part. The launchpad binary these tests load is
//! the one live on mainnet, rebuilt from unchanged source: it must obey the rule without an
//! upgrade of its own.

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use hookpool::approvals::{platform_len, APPROVED_LIST_OFFSET};
use hookpool_interface::*;
use hookpool_tests::*;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;

const BASE_LIQ: u64 = 1_000_000_000_000;
const QUOTE_LIQ: u64 = 100 * SOL;
const SUPPLY: u64 = 1_000_000_000_000_000;
const FEE: u64 = 5_000;

fn approve_ix(env: &Env, admin: &Pubkey, program: &Pubkey) -> Instruction {
    Instruction {
        program_id: hookpool::ID,
        accounts: hookpool::accounts::ApproveHook {
            admin: *admin,
            platform: env.platform,
            hook_program: *program,
            hook_program_data: program_data_address(program),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hookpool::instruction::ApproveHook {}.data(),
    }
}

fn revoke_ix(env: &Env, admin: &Pubkey, program: &Pubkey) -> Instruction {
    Instruction {
        program_id: hookpool::ID,
        accounts: hookpool::accounts::RevokeHook { admin: *admin, platform: env.platform }.to_account_metas(None),
        data: hookpool::instruction::RevokeHook { program: *program }.data(),
    }
}

fn approve(env: &mut Env, program: &Pubkey) {
    let admin = env.admin.insecure_clone();
    let ix = approve_ix(env, &admin.pubkey(), program);
    env.ok(&[ix], &[&admin]);
}

fn revoke(env: &mut Env, program: &Pubkey) {
    let admin = env.admin.insecure_clone();
    let ix = revoke_ix(env, &admin.pubkey(), program);
    env.ok(&[ix], &[&admin]);
}

fn set_rule(env: &mut Env, on: bool) {
    env.update_platform(hookpool::UpdatePlatformArgs { hook_approval_required: Some(on), ..Default::default() });
}

fn platform(env: &Env) -> hookpool::Platform {
    env.account(&env.platform)
}

fn platform_data(env: &Env) -> Vec<u8> {
    env.svm.get_account(&env.platform).unwrap().data
}

/// The programs on the list, read from the raw account as any client would.
fn listed(env: &Env) -> Vec<Pubkey> {
    let d = platform_data(env);
    if d.len() <= APPROVED_LIST_OFFSET {
        return vec![];
    }
    let n = u32::from_le_bytes(d[APPROVED_LIST_OFFSET..APPROVED_LIST_OFFSET + 4].try_into().unwrap()) as usize;
    (0..n)
        .map(|i| {
            let o = APPROVED_LIST_OFFSET + 4 + 32 * i;
            Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
        })
        .collect()
}

/// The platform account holds exactly the rent of its length.
fn assert_rent_exact(env: &Env) {
    let len = platform_data(env).len();
    assert_eq!(env.lamports(&env.platform), env.svm.minimum_balance_for_rent_exemption(len), "platform rent at {len} bytes");
}

/// An evil (third-party, frozen) hook with no fee on a fresh pair, ready for `create_pool`.
fn evil_market(env: &mut Env) -> (Market, PoolKeys, HookRef) {
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.evil_hook(&m.creator, &k.pool, &m.quote_mint, &m.creator.pubkey(), hook_evil::MODE_SILENT, 0);
    let hook = HookRef { treasury: system_program::ID, ..hook };
    (m, k, hook)
}

fn create_ix(env: &Env, m: &Market, k: &PoolKeys, hook: &HookRef) -> Vec<Instruction> {
    vec![compute_budget_ix(400_000), env.create_pool_ix(&m.creator.pubkey(), k, 30, BASE_LIQ, QUOTE_LIQ, hook)]
}

/// A swap that must go through.
fn trade(env: &mut Env, trader: &Keypair, k: &PoolKeys, hook: &HookRef, direction: u8, amount: u64) {
    let ix = env.swap_ix(&trader.pubkey(), k, hook, direction, amount, 1);
    env.ok(&[ix], &[trader]);
}

fn create_token_ix(dev: &Pubkey, mint: &Pubkey) -> Instruction {
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
                name: "Listed".into(),
                symbol: "LST".into(),
                uri: "https://example.invalid/meta.json".into(),
                decimals: 6,
                total_supply: SUPPLY,
            },
        }
        .data(),
    }
}

fn launch_ix(env: &Env, dev: &Pubkey, k: &PoolKeys, hook: &HookRef) -> Instruction {
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
    let args = hooklaunch::LaunchArgs { lp_fee_bps: 30, base_amount: SUPPLY, quote_amount: 5 * SOL, dev_buy_quote: SOL, min_dev_buy_out: 1 };
    Instruction { program_id: hooklaunch::ID, accounts, data: hooklaunch::instruction::Launch { args }.data() }
}

/// A coin made by the launchpad and the evil hook's config for its pool.
fn launch_setup(env: &mut Env, m: &Market) -> (Keypair, PoolKeys, HookRef) {
    let dev = env.user(20 * SOL);
    env.fund(&dev, &m.authority, &m.base_mint, &m.quote_mint, 0, 50 * SOL);
    let mint = Keypair::new();
    env.ok(&[create_token_ix(&dev.pubkey(), &mint.pubkey())], &[&dev, &mint]);
    let k = Env::pool_keys(&mint.pubkey(), &m.quote_mint);
    let hook = env.evil_hook(&dev, &k.pool, &m.quote_mint, &dev.pubkey(), hook_evil::MODE_SILENT, 0);
    let hook = HookRef { treasury: system_program::ID, ..hook };
    (dev, k, hook)
}

#[test]
fn the_rule_is_off_until_the_admin_turns_it_on() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    // a platform as every earlier version wrote it: the fixed part only, the rule off
    assert_eq!(platform_data(&env).len(), APPROVED_LIST_OFFSET);
    assert!(!platform(&env).hook_approval_required);
    assert!(listed(&env).is_empty());
    // so a frozen third-party hook opens a pool, as before
    let (m, k, hook) = evil_market(&mut env);
    let ixs = create_ix(&env, &m, &k, &hook);
    env.ok(&ixs, &[&m.creator]);
    assert_eq!(env.pool(&k.pool).hook_kind, HOOK_KIND_FROZEN);
    // switched on and off through update_platform; other settings untouched
    let before = platform(&env);
    set_rule(&mut env, true);
    let after = platform(&env);
    assert!(after.hook_approval_required);
    assert_eq!((after.protocol_fee_bps, after.paused, after.pool_count, after.curve_virtual_quote), (before.protocol_fee_bps, before.paused, before.pool_count, before.curve_virtual_quote));
    assert_eq!(after.reserved, [0u8; 45]);
    set_rule(&mut env, false);
    assert!(!platform(&env).hook_approval_required);
    // an update that does not name the rule leaves it as it is
    set_rule(&mut env, true);
    env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(false), ..Default::default() });
    assert!(platform(&env).hook_approval_required);
}

#[test]
fn with_the_rule_on_an_unapproved_hook_is_refused_on_every_path() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    set_rule(&mut env, true);

    // create_pool
    let (m, k, hook) = evil_market(&mut env);
    let ixs = create_ix(&env, &m, &k, &hook);
    env.err(&ixs, &[&m.creator], "not on the platform's approved list");

    // create_curve_pool
    let maker = env.user(20 * SOL);
    let quote = env.create_mint(&maker, 9);
    env.create_ata(&maker, &maker.pubkey(), &quote);
    let base = env.closed_coin(&maker, &TOKEN, SUPPLY);
    let kc = Env::pool_keys(&base, &quote);
    let hc = env.evil_hook(&maker, &kc.pool, &quote, &maker.pubkey(), hook_evil::MODE_SILENT, 0);
    let hc = HookRef { treasury: system_program::ID, ..hc };
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &kc, 30, SUPPLY, &hc);
    env.err(&[compute_budget_ix(400_000), ix], &[&maker], "not on the platform's approved list");

    // through the launchpad as it runs today
    let (dev, kl, hl) = launch_setup(&mut env, &m);
    let ix = launch_ix(&env, &dev.pubkey(), &kl, &hl);
    env.err(&[compute_budget_ix(400_000), ix], &[&dev], "not on the platform's approved list");

    // the platform's own hooks and pools without a hook need no approval
    let t = env.market();
    let kt = Env::pool_keys(&t.base_mint, &t.quote_mint);
    let owner = env.user(SOL);
    env.create_ata(&owner, &owner.pubkey(), &t.quote_mint);
    let tax = env.tax_hook(&t.creator, &owner, &kt.pool, &t.quote_mint, &owner.pubkey(), 100, 100, 500);
    env.create_pool(&t.creator, &t.base_mint, &t.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &tax);
    assert_eq!(env.pool(&kt.pool).hook_kind, HOOK_KIND_PLATFORM);
    let n = env.market();
    let kn = env.create_pool(&n.creator, &n.base_mint, &n.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    assert_eq!(env.pool(&kn.pool).hook_kind, HOOK_KIND_NONE);
}

#[test]
fn an_approved_hook_opens_pools_and_a_revoked_one_keeps_the_pools_it_has() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    // a pool opened before the rule existed keeps trading once it is on
    let (m0, k0, h0) = evil_market(&mut env);
    let ixs = create_ix(&env, &m0, &k0, &h0);
    env.ok(&ixs, &[&m0.creator]);
    set_rule(&mut env, true);
    trade(&mut env, &m0.trader, &k0, &h0, DIRECTION_BUY, SOL);

    // approved: a pool opens, directly and through the launchpad
    approve(&mut env, &hook_evil::ID);
    assert_eq!(listed(&env), vec![hook_evil::ID]);
    let (m, k, hook) = evil_market(&mut env);
    let ixs = create_ix(&env, &m, &k, &hook);
    env.ok(&ixs, &[&m.creator]);
    trade(&mut env, &m.trader, &k, &hook, DIRECTION_BUY, SOL);
    let (dev, kl, hl) = launch_setup(&mut env, &m);
    let ix = launch_ix(&env, &dev.pubkey(), &kl, &hl);
    env.ok(&[compute_budget_ix(400_000), ix], &[&dev]);
    assert_eq!(env.pool(&kl.pool).hook_program, hook_evil::ID);

    // revoked: the pools it has keep trading both ways, a new one is refused
    revoke(&mut env, &hook_evil::ID);
    assert!(listed(&env).is_empty());
    trade(&mut env, &m.trader, &k, &hook, DIRECTION_BUY, SOL);
    trade(&mut env, &m.trader, &k, &hook, DIRECTION_SELL, 1_000_000);
    let (m2, k2, h2) = evil_market(&mut env);
    let ixs = create_ix(&env, &m2, &k2, &h2);
    env.err(&ixs, &[&m2.creator], "not on the platform's approved list");
    // and the rule switched off lets it through again
    set_rule(&mut env, false);
    env.ok(&ixs, &[&m2.creator]);
}

#[test]
fn only_the_admin_approves_revokes_or_switches_the_rule() {
    let mut env = Env::new();
    let rando = env.user(10 * SOL);
    let ix = approve_ix(&env, &rando.pubkey(), &hook_evil::ID);
    env.err(&[ix], &[&rando], "NotAdmin");
    approve(&mut env, &hook_evil::ID);
    let ix = revoke_ix(&env, &rando.pubkey(), &hook_evil::ID);
    env.err(&[ix], &[&rando], "NotAdmin");
    let ix = Instruction {
        program_id: hookpool::ID,
        accounts: hookpool::accounts::AdminOnly { admin: rando.pubkey(), platform: env.platform }.to_account_metas(None),
        data: hookpool::instruction::UpdatePlatform { args: hookpool::UpdatePlatformArgs { hook_approval_required: Some(true), ..Default::default() } }.data(),
    };
    env.err(&[ix], &[&rando], "NotAdmin");
    assert!(!platform(&env).hook_approval_required);
    assert_eq!(listed(&env), vec![hook_evil::ID]);
    // the admin's signature is required, not only its address
    let mut ix = approve_ix(&env, &env.admin.pubkey(), &MPL_CORE);
    ix.accounts[0].is_signer = false;
    let res = env.send(&[ix], &[&rando]);
    assert!(res.is_err());
}

#[test]
fn only_a_frozen_program_can_be_approved_and_only_once() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    // the platform's own template: no approval needed
    let ix = approve_ix(&env, &admin.pubkey(), &hook_tax::ID);
    env.err(&[ix], &[&admin], "only a frozen hook can be approved");
    // a program its author can still upgrade
    let rando = Keypair::new().pubkey();
    env.patch_upgrade_authority(&hook_evil::ID, Some(rando));
    let ix = approve_ix(&env, &admin.pubkey(), &hook_evil::ID);
    env.err(&[ix], &[&admin], "upgradeable and its authority is not whitelisted");
    env.patch_upgrade_authority(&hook_evil::ID, None);
    // a wallet is no program
    let wallet = env.user(SOL).pubkey();
    let ix = approve_ix(&env, &admin.pubkey(), &wallet);
    env.err(&[ix], &[&admin], "HookNotExecutable");
    // a ProgramData that is not the program's own
    let mut ix = approve_ix(&env, &admin.pubkey(), &hook_evil::ID);
    ix.accounts[3].pubkey = program_data_address(&MPL_CORE);
    env.err(&[ix], &[&admin], "HookProgramDataMismatch");
    // frozen: approved once, not twice
    approve(&mut env, &hook_evil::ID);
    let ix = approve_ix(&env, &admin.pubkey(), &hook_evil::ID);
    env.err(&[ix], &[&admin], "already on the approved list");
    // revoking what is not there
    let ix = revoke_ix(&env, &admin.pubkey(), &MPL_CORE);
    env.err(&[ix], &[&admin], "not on the platform's approved list");
    assert_eq!(listed(&env), vec![hook_evil::ID]);
}

#[test]
fn the_list_grows_and_shrinks_with_its_rent_and_survives_every_other_platform_write() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    let programs = [hook_evil::ID, MPL_CORE, MPL, TOKEN, TOKEN_2022, ATA_PROGRAM];
    for (i, p) in programs.iter().enumerate() {
        let admin_before = env.lamports(&env.admin.pubkey());
        let plat_before = env.lamports(&env.platform);
        approve(&mut env, p);
        let paid = admin_before - env.lamports(&env.admin.pubkey()) - FEE;
        assert_eq!(paid, env.lamports(&env.platform) - plat_before, "the admin pays exactly the growth");
        assert_eq!(platform_data(&env).len(), platform_len(i + 1));
        assert_rent_exact(&env);
    }
    assert_eq!(listed(&env), programs.to_vec());

    // every other instruction that writes the platform keeps the list
    set_rule(&mut env, true);
    env.update_platform(hookpool::UpdatePlatformArgs { protocol_fee_bps: Some(25), ..Default::default() });
    env.set_whitelist(vec![env.admin.pubkey(), Pubkey::new_unique()]);
    let (m, k, hook) = evil_market(&mut env);
    let ixs = create_ix(&env, &m, &k, &hook);
    env.ok(&ixs, &[&m.creator]);
    let p = platform(&env);
    assert_eq!((p.protocol_fee_bps, p.whitelist_len, p.hook_approval_required), (25, 2, true));
    assert_eq!(listed(&env), programs.to_vec());
    assert_rent_exact(&env);

    // revoke from the middle: the last entry takes its place, the admin gets the rent back
    let admin_before = env.lamports(&env.admin.pubkey());
    let plat_before = env.lamports(&env.platform);
    revoke(&mut env, &MPL);
    assert_eq!(listed(&env), vec![hook_evil::ID, MPL_CORE, ATA_PROGRAM, TOKEN, TOKEN_2022]);
    let back = env.lamports(&env.admin.pubkey()) + FEE - admin_before;
    assert_eq!(back, plat_before - env.lamports(&env.platform));
    assert_eq!(platform_data(&env).len(), platform_len(5));
    assert_rent_exact(&env);
    // and the last one, then the rest
    revoke(&mut env, &TOKEN_2022);
    assert_eq!(listed(&env), vec![hook_evil::ID, MPL_CORE, ATA_PROGRAM, TOKEN]);
    for p in [hook_evil::ID, MPL_CORE, ATA_PROGRAM, TOKEN] {
        revoke(&mut env, &p);
    }
    assert!(listed(&env).is_empty());
    assert_eq!(platform_data(&env).len(), platform_len(0));
    assert_rent_exact(&env);
    // empty again, and approvable again
    approve(&mut env, &hook_evil::ID);
    assert_eq!(listed(&env), vec![hook_evil::ID]);
}

/// Writes a list of `keys` after the platform's fixed part, as if approved one by one.
fn write_list(env: &mut Env, keys: &[Pubkey]) {
    let acc = env.svm.get_account(&env.platform).unwrap();
    let mut data = acc.data[..APPROVED_LIST_OFFSET].to_vec();
    data.extend_from_slice(&(keys.len() as u32).to_le_bytes());
    for k in keys {
        data.extend_from_slice(k.as_ref());
    }
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm.set_account(env.platform, Account { lamports, data, owner: acc.owner, executable: false, rent_epoch: acc.rent_epoch }).unwrap();
}

#[test]
fn a_full_list_costs_little_compute_and_a_corrupt_one_fails_closed() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    set_rule(&mut env, true);

    // the hook first on a list of one
    write_list(&mut env, &[hook_evil::ID]);
    let (m, k, hook) = evil_market(&mut env);
    let ixs = create_ix(&env, &m, &k, &hook);
    let short = env.ok(&ixs, &[&m.creator]).compute_units_consumed;

    // the hook LAST on a full list
    let mut keys: Vec<Pubkey> = (0..hookpool::MAX_APPROVED_HOOKS - 1).map(|_| Pubkey::new_unique()).collect();
    keys.push(hook_evil::ID);
    write_list(&mut env, &keys);
    let (m, k, hook) = evil_market(&mut env);
    let ixs = create_ix(&env, &m, &k, &hook);
    let long = env.ok(&ixs, &[&m.creator]).compute_units_consumed;
    println!("create_pool with the hook first of 1: {short} units, last of 256: {long} units");
    assert!(long < short + 40_000, "a full list must stay cheap: {short} -> {long}");
    // a full list takes no more
    let admin = env.admin.insecure_clone();
    let ix = approve_ix(&env, &admin.pubkey(), &MPL_CORE);
    env.err(&[ix], &[&admin], "the approved list is full");

    // a count the account cannot hold: refused while the rule is on, ignored while off
    let acc = env.svm.get_account(&env.platform).unwrap();
    let mut data = acc.data.clone();
    data[APPROVED_LIST_OFFSET..APPROVED_LIST_OFFSET + 4].copy_from_slice(&(300u32).to_le_bytes());
    env.svm.set_account(env.platform, Account { data, ..acc }).unwrap();
    let (m, k, hook) = evil_market(&mut env);
    let ixs = create_ix(&env, &m, &k, &hook);
    env.err(&ixs, &[&m.creator], "approved list after the platform account cannot be read");
    set_rule(&mut env, false);
    env.ok(&ixs, &[&m.creator]);
}

#[test]
fn the_approval_follows_the_program_not_a_lookalike() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    set_rule(&mut env, true);
    // another frozen program is approved, not the hook
    approve(&mut env, &MPL_CORE);
    let (m, k, hook) = evil_market(&mut env);
    let ixs = create_ix(&env, &m, &k, &hook);
    env.err(&ixs, &[&m.creator], "not on the platform's approved list");
    // a pool that names the approved program's id but passes the hook's accounts is refused
    // before the list matters: the manifest must sit under the program named
    let mut ixs2 = ixs.clone();
    let metas: &mut Vec<AccountMeta> = &mut ixs2[1].accounts;
    let at = metas.iter().position(|a| a.pubkey == hook_evil::ID).unwrap();
    metas[at].pubkey = MPL_CORE;
    metas[at + 1].pubkey = program_data_address(&MPL_CORE);
    assert!(env.send(&ixs2, &[&m.creator]).is_err());
}
