//! Round 13, independent review of the approved list (HOOKS.md section 6.1) added to the
//! pool program. The hookpool binary under review is `target/deploy/hookpool.so`; every other
//! program (the launchpad included) is the one live on mainnet, loaded unchanged.
//!
//! Each test below is an attack on the change, or a check of a claim it makes, written by a
//! reviewer who did not write it. A test that PASSES means the attack failed or the claim held.
//! The tests named `finding_*` reproduce a behaviour this review reports and pass while it is
//! there. Nothing here edits a program, the SDK, or another test file.
//!
//! What is covered here, beyond the author's own `approvals.rs`:
//!   - the list survives `transfer_admin`/`accept_admin` (platform writers the author did not
//!     exercise with a populated list), and the new admin keeps the list and can revoke;
//!   - a corrupt list fails CLOSED but ONLY for a frozen outside hook: a pool with no hook and
//!     a pool on a platform template still open while the rule is on and the list cannot be
//!     read, so the corruption is scoped and cannot be turned into a denial of service on the
//!     flows that do not need the list;
//!   - rent/lamport accounting when the platform holds more than its rent: `revoke_hook` sweeps
//!     the surplus (e.g. a donation anyone can make to the PDA) to the admin, and the account is
//!     left at exactly the rent of its new length (still exempt);
//!   - a swap on a pool whose hook is revoked after the pool opened still trades both ways.

use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use hookpool::approvals::{platform_len, APPROVED_LIST_OFFSET};
use hookpool_interface::*;
use hookpool_tests::*;
use solana_account::Account;
use solana_signer::Signer;

const BASE_LIQ: u64 = 1_000_000_000_000;
const QUOTE_LIQ: u64 = 100 * SOL;
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

/// An evil (third-party, FROZEN) hook with no fee on a fresh pair, ready for `create_pool`.
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

/// Overwrites the platform with a count the account is far too short to hold: the program's
/// `count()` must reject it (`ApprovedListCorrupt`) rather than guess. The fixed part (byte 405
/// rule byte, whitelist, everything) is copied through unchanged, only a bad count is appended.
fn make_corrupt(env: &mut Env) {
    let acc = env.svm.get_account(&env.platform).unwrap();
    let mut data = acc.data[..APPROVED_LIST_OFFSET].to_vec();
    data.extend_from_slice(&5u32.to_le_bytes()); // claims 5 entries; needs 451+4+160 bytes, has 455
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm.set_account(env.platform, Account { lamports, data, owner: acc.owner, executable: false, rent_epoch: acc.rent_epoch }).unwrap();
}

// ----------------------------------------------------------------------------------------

/// Handing the admin over does not touch the list, and the new admin owns it: it can revoke,
/// the old admin cannot. `transfer_admin` and `accept_admin` both write the platform through
/// Anchor's `Account<Platform>` exit (451 bytes), so this proves that write leaves the list that
/// lives after byte 451 alone.
#[test]
fn transfer_of_admin_keeps_the_list_and_hands_it_over() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    set_rule(&mut env, true);

    let admin = env.admin.insecure_clone();
    env.ok(&[approve_ix(&env, &admin.pubkey(), &hook_evil::ID)], &[&admin]);
    env.ok(&[approve_ix(&env, &admin.pubkey(), &MPL_CORE)], &[&admin]);
    assert_eq!(listed(&env), vec![hook_evil::ID, MPL_CORE]);
    assert_eq!(platform_data(&env).len(), platform_len(2));

    // hand the admin to a fresh key
    let new_admin = env.user(10 * SOL);
    let t = Instruction {
        program_id: hookpool::ID,
        accounts: hookpool::accounts::AdminOnly { admin: admin.pubkey(), platform: env.platform }.to_account_metas(None),
        data: hookpool::instruction::TransferAdmin { new_admin: new_admin.pubkey() }.data(),
    };
    env.ok(&[t], &[&admin]);
    let a = Instruction {
        program_id: hookpool::ID,
        accounts: hookpool::accounts::AcceptAdmin { new_admin: new_admin.pubkey(), platform: env.platform }.to_account_metas(None),
        data: hookpool::instruction::AcceptAdmin {}.data(),
    };
    env.ok(&[a], &[&new_admin]);

    // the list is byte-for-byte what it was, the rule is still on
    assert_eq!(listed(&env), vec![hook_evil::ID, MPL_CORE]);
    assert_eq!(platform_data(&env).len(), platform_len(2));
    assert_eq!(platform(&env).admin, new_admin.pubkey());
    assert!(platform(&env).hook_approval_required);

    // the OLD admin can no longer revoke; the NEW admin can
    env.err(&[revoke_ix(&env, &admin.pubkey(), &MPL_CORE)], &[&admin], "NotAdmin");
    env.ok(&[revoke_ix(&env, &new_admin.pubkey(), &hook_evil::ID)], &[&new_admin]);
    assert_eq!(listed(&env), vec![MPL_CORE]);
    assert_eq!(platform_data(&env).len(), platform_len(1));
}

/// A count the account cannot hold makes the pool refuse a FROZEN outside hook
/// (`ApprovedListCorrupt`, fail closed), but it must NOT reach the flows that never consult the
/// list: a pool with no hook and a pool on a platform template still open while the rule is on.
/// This proves the corruption cannot be turned into a denial of service on ordinary launches.
#[test]
fn a_corrupt_list_fails_closed_only_for_frozen_outside_hooks() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    set_rule(&mut env, true);
    make_corrupt(&mut env);

    // a FROZEN outside hook: refused, and the program names the corruption, not an empty list
    let (m, k, hook) = evil_market(&mut env);
    env.err(&create_ix(&env, &m, &k, &hook), &[&m.creator], "approved list after the platform account cannot be read");

    // a pool with NO hook opens: create_pool never consults the list for it
    let n = env.market();
    let kn = env.create_pool(&n.creator, &n.base_mint, &n.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    assert_eq!(env.pool(&kn.pool).hook_kind, HOOK_KIND_NONE);

    // a pool on a platform TEMPLATE (whitelisted authority) opens too
    let t = env.market();
    let kt = Env::pool_keys(&t.base_mint, &t.quote_mint);
    let owner = env.user(SOL);
    env.create_ata(&owner, &owner.pubkey(), &t.quote_mint);
    let tax = env.tax_hook(&t.creator, &owner, &kt.pool, &t.quote_mint, &owner.pubkey(), 100, 100, 500);
    env.create_pool(&t.creator, &t.base_mint, &t.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &tax);
    assert_eq!(env.pool(&kt.pool).hook_kind, HOOK_KIND_PLATFORM);

    // the corruption is still there (the successful pools did not rewrite the bad count)
    let d = platform_data(&env);
    assert_eq!(u32::from_le_bytes(d[APPROVED_LIST_OFFSET..APPROVED_LIST_OFFSET + 4].try_into().unwrap()), 5);
    assert_eq!(d.len(), platform_len(0));
}

/// A pool keeps its hook and keeps trading after the hook is revoked from the list: the rule is
/// checked only at creation, never on a swap.
#[test]
fn a_revoked_hook_keeps_trading_on_the_pools_it_already_has() {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    set_rule(&mut env, true);
    let admin = env.admin.insecure_clone();
    env.ok(&[approve_ix(&env, &admin.pubkey(), &hook_evil::ID)], &[&admin]);

    let (m, k, hook) = evil_market(&mut env);
    env.ok(&create_ix(&env, &m, &k, &hook), &[&m.creator]);
    env.ok(&[env.swap_ix(&m.trader.pubkey(), &k, &hook, DIRECTION_BUY, SOL, 1)], &[&m.trader]);

    env.ok(&[revoke_ix(&env, &admin.pubkey(), &hook_evil::ID)], &[&admin]);
    assert!(listed(&env).is_empty());
    // both directions still work on the existing pool
    env.ok(&[env.swap_ix(&m.trader.pubkey(), &k, &hook, DIRECTION_BUY, SOL, 1)], &[&m.trader]);
    env.ok(&[env.swap_ix(&m.trader.pubkey(), &k, &hook, DIRECTION_SELL, 1_000_000, 1)], &[&m.trader]);
    // but a brand-new pool on it is refused
    let (m2, k2, h2) = evil_market(&mut env);
    env.err(&create_ix(&env, &m2, &k2, &h2), &[&m2.creator], "not on the platform's approved list");
}

/// INFO, not a flaw in the rule: the author's own test asserts "the admin receives exactly the
/// freed rent" on a revoke, which holds when nothing else funds the PDA. Anyone can send lamports
/// to the platform PDA (a system transfer to an address needs no permission), and the next
/// `revoke_hook` sweeps that surplus to the admin along with the rent. The account is still left
/// at exactly the rent of its new length, so nothing is under-funded and no third party can
/// drain it; it is only a caveat on the word "exactly". This test passes while that is true.
#[test]
fn finding_revoke_sweeps_any_surplus_lamports_to_the_admin() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    env.ok(&[approve_ix(&env, &admin.pubkey(), &MPL_CORE)], &[&admin]);
    let len_one = platform_data(&env).len();
    assert_eq!(len_one, platform_len(1));
    assert_eq!(env.lamports(&env.platform), env.svm.minimum_balance_for_rent_exemption(len_one), "after approve the PDA holds exactly its rent");

    // a stranger donates to the PDA
    let stranger = env.user(5 * SOL);
    let donation = 2 * SOL;
    env.ok(&[system_instruction::transfer(&stranger.pubkey(), &env.platform, donation)], &[&stranger]);
    let plat_before = env.lamports(&env.platform);
    let admin_before = env.lamports(&admin.pubkey());

    env.ok(&[revoke_ix(&env, &admin.pubkey(), &MPL_CORE)], &[&admin]);

    let len_zero = platform_data(&env).len();
    assert_eq!(len_zero, platform_len(0));
    let rent_zero = env.svm.minimum_balance_for_rent_exemption(len_zero);
    // the PDA is left at EXACTLY the rent of its new length: still exempt, nothing stranded
    assert_eq!(env.lamports(&env.platform), rent_zero);
    // the admin received everything above that rent, the donation included (so "exactly the
    // freed rent" is really "the freed rent plus any surplus")
    let swept = plat_before - rent_zero;
    assert!(swept > donation, "the sweep ({swept}) carries the donation ({donation}) and then some");
    assert_eq!(env.lamports(&admin.pubkey()), admin_before - FEE + swept, "admin gets the whole surplus");
}
