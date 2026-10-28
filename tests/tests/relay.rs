//! A hook cannot use the pool's signature against another hook.
//!
//! The pool program signs every callback. A program that is called with a signer can pass
//! that signer on in a call of its own, so a hook the pool calls can call a second hook's
//! callback with the pool's signature attached, and with accounts and a payload it made
//! up. `hook_evil` in MODE_RELAY does exactly that.
//!
//! What stops it: the pool signs with a different address for every hook program,
//! `["caller", hook_program]`, and every hook accepts only its own. The first test shows
//! that the forwarding itself works (a hook can relay to ITSELF); the others show that
//! each callback that writes state refuses a relay that comes through another hook.

#![allow(clippy::result_large_err)]

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use hookpool_interface::*;
use hookpool_tests::*;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use solana_keypair::Keypair;
use solana_signer::Signer;

const BASE_LIQ: u64 = 1_000_000_000_000;
const QUOTE_LIQ: u64 = 100 * SOL;
/// `InterfaceError::CallerMismatch`: the signature is there, the address is another hook's.
const REFUSED: &str = "hook_caller is not the pool program's caller PDA for this hook";

/// The attack itself: a buy on the attacker's own pool. The pool calls its hook, and the
/// hook forwards the pool's signature to the callback it was told to forge.
fn fire(env: &mut Env, attacker: &Keypair, k: &PoolKeys, hook: &HookRef) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let ix = env.swap_ix(&attacker.pubkey(), k, hook, DIRECTION_BUY, SOL / 10, 0);
    env.send(&[compute_budget_ix(400_000), ix], &[attacker])
}

fn refused(env: &mut Env, attacker: &Keypair, k: &PoolKeys, hook: &HookRef) {
    match fire(env, attacker, k, hook) {
        Ok(m) => panic!("the relayed call went through:\n{}", m.pretty_logs()),
        Err(e) => {
            let hay = e.meta.logs.join("\n");
            assert!(hay.contains(REFUSED), "expected the caller error, got:\n{hay}");
            // the signature did arrive: the refusal is about the address, not about a
            // missing signature
            assert!(!hay.contains("hook_caller is not a signer") && !hay.contains("AccountNotSigner"), "{hay}");
        }
    }
}

// ---- the forwarding works: a hook can relay to itself -----------------------------------

#[test]
fn a_hook_can_pass_the_pools_signature_on_and_its_own_address_is_accepted_only_by_itself() {
    let mut env = Env::new();
    // the victim: another pool of the SAME hook program, never traded on
    let m = env.market();
    let z = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let z_cfg = HookRef::cfg(&hook_evil::ID, &z.pool);
    let stranger = Pubkey::new_unique();
    let victim = [
        AccountMeta::new_readonly(z.pool, false),
        AccountMeta::new_readonly(stranger, false),
        AccountMeta::new_readonly(z.quote_mint, false),
        AccountMeta::new_readonly(z.base_mint, false),
        AccountMeta::new(z_cfg, false),
    ];
    let forged = SwapPayload { direction: DIRECTION_SELL, amount_in: 123_456, slot: 9, ..Default::default() };
    // every hook's before_swap has the same name, so the same instruction data
    let data = hook_tax::instruction::BeforeSwap { payload: forged }.data();
    let (attacker, x, x_hook) = env.relay_pool(&hook_evil::ID, &victim, data);

    // pool Z is created with the same hook; nobody ever trades on it
    let z_hook = env.evil_hook(&m.creator, &z.pool, &z.quote_mint, &m.creator.pubkey(), hook_evil::MODE_SILENT, 0);
    let z_hook = HookRef { treasury: system_program::ID, ..z_hook };
    let ix = env.create_pool_ix(&m.creator.pubkey(), &z, 30, BASE_LIQ, QUOTE_LIQ, &z_hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    let before: hook_evil::EvilConfig = env.account(&z_cfg);
    assert_eq!(before.calls, 0);

    // a buy on pool X: the pool calls the hook for X, and the hook calls ITSELF for Z
    // with the signature the pool gave it
    fire(&mut env, &attacker, &x, &x_hook).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    let after: hook_evil::EvilConfig = env.account(&z_cfg);
    assert_eq!(after.calls, 1, "the forged callback ran: the forwarded signature was accepted");
    assert_eq!(env.pool(&z.pool).swap_count, 0, "and no trade ever happened on that pool");
    let x_cfg: hook_evil::EvilConfig = env.account(&HookRef::cfg(&hook_evil::ID, &x.pool));
    assert_eq!(x_cfg.calls, 1);

    // the address the pool signs with is the hook's own, and differs from every other hook's
    assert_eq!(x_hook.caller(), caller_address(&hook_evil::ID).0);
    let all = [hook_evil::ID, hook_tax::ID, hook_launch_guard::ID, hook_buyback::ID, hook_collectible::ID, hook_rules::ID, system_program::ID];
    for (i, a) in all.iter().enumerate() {
        for b in &all[i + 1..] {
            assert_ne!(caller_address(a).0, caller_address(b).0);
        }
    }
}

// ---- launch guard: on_pool_create ---------------------------------------------------------

#[test]
fn the_launch_guard_cannot_be_armed_through_another_hook() {
    // Between the two transactions of a launch the guard's config exists and its pool
    // does not. A call to on_pool_create in that moment would arm the config; the real
    // create_pool would then find it armed and fail, and that coin could never launch
    // on the guard.
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    env.svm.warp_to_slot(500);
    let guard = env.guard_hook(&m.creator, &k.pool, 100, 3_000);
    let cfg_key = HookRef::cfg(&hook_launch_guard::ID, &k.pool);

    let victim = [
        AccountMeta::new_readonly(k.pool, false),
        AccountMeta::new_readonly(m.creator.pubkey(), false),
        AccountMeta::new_readonly(k.quote_mint, false),
        AccountMeta::new_readonly(k.base_mint, false),
        AccountMeta::new(cfg_key, false),
    ];
    // the payload names the real creator, as the pool itself would
    let forged = PoolCreatePayload { lp_fee_bps: 30, base_amount: BASE_LIQ, quote_amount: QUOTE_LIQ, creator: m.creator.pubkey() };
    let data = hook_launch_guard::instruction::OnPoolCreate { payload: forged }.data();
    let (attacker, x, x_hook) = env.relay_pool(&hook_launch_guard::ID, &victim, data);
    refused(&mut env, &attacker, &x, &x_hook);
    let cfg: hook_launch_guard::GuardConfig = env.account(&cfg_key);
    assert_eq!(cfg.start_slot, 0, "not armed");

    // the launch goes through and arms the guard itself, at its own slot
    env.svm.warp_to_slot(1_000);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &guard);
    let cfg: hook_launch_guard::GuardConfig = env.account(&cfg_key);
    assert_eq!(cfg.start_slot, 1_000);
    // and once the pool exists a relay is refused all the same
    refused(&mut env, &attacker, &x, &x_hook);
}

// ---- collectible: after_swap ---------------------------------------------------------------

fn collectible_pool(env: &mut Env) -> (Market, PoolKeys) {
    let pid = hook_collectible::ID;
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let dev = env.user(SOL);
    let pda = |seed: &[u8]| Pubkey::find_program_address(&[seed, k.pool.as_ref()], &pid).0;
    let ix = Instruction {
        program_id: pid,
        accounts: hook_collectible::accounts::InitPoolConfig {
            payer: m.creator.pubkey(),
            owner: dev.pubkey(),
            cfg: pda(hook_collectible::CFG_SEED),
            collection: pda(hook_collectible::COLLECTION_SEED),
            collection_authority: pda(hook_collectible::AUTHORITY_SEED),
            core_program: MPL_CORE,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_collectible::instruction::InitPoolConfig {
            pool: k.pool,
            args: hook_collectible::InitCollectionArgs {
                name: "Shots".into(),
                uri_base: "https://example.com/art".into(),
                unit: 2_000 * 1_000_000,
                max_supply: 1_000,
                max_per_buy: 3,
                art: [7u8; 16],
            },
        }
        .data(),
    };
    env.ok(&[compute_budget_ix(300_000), ix], &[&m.creator, &dev]);
    let hook = collectible_ref(&k.pool, &m.creator.pubkey());
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    (m, k)
}

fn ticket_of(pool: &Pubkey, user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[hook_collectible::TICKET_SEED, pool.as_ref(), user.as_ref()], &hook_collectible::ID).0
}

fn collectible_ref(pool: &Pubkey, user: &Pubkey) -> HookRef {
    HookRef {
        program: hook_collectible::ID,
        treasury: system_program::ID,
        extra: vec![
            AccountMeta::new(HookRef::cfg(&hook_collectible::ID, pool), false),
            AccountMeta::new(ticket_of(pool, user), false),
            AccountMeta::new_readonly(hook_collectible::SLOT_HASHES_ID, false),
        ],
    }
}

#[test]
fn collectible_pieces_cannot_be_credited_or_their_block_chosen_through_another_hook() {
    // after_swap writes into the buyer's ticket how many pieces the buy earned and the
    // slot whose block will decide what they look like. Both come from the payload. A
    // forged call could credit pieces for a buy that never happened, and name a slot in
    // the past, whose block hash is already known.
    let mut env = Env::new();
    env.svm.warp_to_slot(100);
    let (m, k) = collectible_pool(&mut env);
    let cheat = env.user(10 * SOL);
    let ticket_key = ticket_of(&k.pool, &cheat.pubkey());
    let open = Instruction {
        program_id: hook_collectible::ID,
        accounts: hook_collectible::accounts::OpenTicket { user: cheat.pubkey(), ticket: ticket_key, system_program: system_program::ID }
            .to_account_metas(None),
        data: hook_collectible::instruction::OpenTicket { pool: k.pool }.data(),
    };
    env.ok(&[open], &[&cheat]);
    let cfg_key = HookRef::cfg(&hook_collectible::ID, &k.pool);

    let victim = [
        AccountMeta::new_readonly(k.pool, false),
        AccountMeta::new_readonly(cheat.pubkey(), false),
        AccountMeta::new_readonly(k.quote_mint, false),
        AccountMeta::new_readonly(k.base_mint, false),
        AccountMeta::new(cfg_key, false),
        AccountMeta::new(ticket_key, false),
        AccountMeta::new_readonly(hook_collectible::SLOT_HASHES_ID, false),
    ];
    // "a buy of a million coins, forty slots ago"
    let forged = SwapPayload { direction: DIRECTION_BUY, amount_in: 100 * SOL, amount_out: 1_000_000_000_000, slot: 60, ..Default::default() };
    let data = hook_collectible::instruction::AfterSwap { payload: forged }.data();
    let (attacker, x, x_hook) = env.relay_pool(&hook_collectible::ID, &victim, data);
    refused(&mut env, &attacker, &x, &x_hook);

    let t: hook_collectible::Ticket = env.account(&ticket_key);
    assert_eq!(t.rolls, 0, "no piece was credited");
    assert!(t.batches.iter().all(|b| b.state == hook_collectible::BATCH_EMPTY), "no batch, so no target slot");
    let cfg: hook_collectible::CollectionConfig = env.account(&cfg_key);
    assert_eq!((cfg.reserved_pending, cfg.live), (0, 0));
    assert_eq!(env.pool(&k.pool).swap_count, 0);

    // on_pool_create through the relay: refused as well
    let forged = PoolCreatePayload { lp_fee_bps: 30, base_amount: 1, quote_amount: 1, creator: cfg.creator };
    env.evil_set_relay(&attacker, &x.pool, &hook_collectible::ID, hook_collectible::instruction::OnPoolCreate { payload: forged }.data());
    refused(&mut env, &attacker, &x, &x_hook);

    // a real buy by the same wallet still earns its pieces, through the pool
    env.fund(&cheat, &m.authority, &k.base_mint, &k.quote_mint, 0, 10 * SOL);
    let hook = collectible_ref(&k.pool, &cheat.pubkey());
    env.swap(&cheat, &k, &hook, DIRECTION_BUY, SOL, 0).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    let t: hook_collectible::Ticket = env.account(&ticket_key);
    assert_eq!(t.rolls, 3, "4 units bought, capped at 3 per buy");
    let b = t.batches.iter().find(|b| b.state == hook_collectible::BATCH_WAITING).expect("a waiting batch");
    assert!(b.target_slot > 100, "decided by a block after the buy: {}", b.target_slot);
}

// ---- launch rules: before_swap and on_pool_create ------------------------------------------

fn rules_args() -> hook_rules::RulesArgs {
    hook_rules::RulesArgs {
        buy: hook_rules::Rates { creator_bps: 100, holders_bps: 0, burn_bps: 300 },
        sell: hook_rules::Rates { creator_bps: 400, holders_bps: 0, burn_bps: 0 },
        max_buy_quote: SOL,
        limit_slots: 5_000,
        ..Default::default()
    }
}

#[test]
fn the_launch_rules_callbacks_refuse_a_relay_and_no_number_moves() {
    // before_swap settles the last trade's fee and records the rates of the one that is
    // starting. A forged call cannot move a lamport, but with a single caller address it
    // could have rewritten what the config says about the last trade.
    let mut env = Env::new();
    env.set_clock(1_000, 1_760_000_000);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.rules_hook(&m.creator, &k, rules_args());
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    // one real buy: its fee waits to be settled, split 100 : 0 : 300
    env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, 0).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    let cfg_key = hook_rules::cfg_address(&k.pool);
    let before = env.svm.get_account(&cfg_key).unwrap().data;
    let cfg: hook_rules::RulesConfig = env.account(&cfg_key);
    assert_eq!(cfg.last_split, hook_rules::Rates { creator_bps: 100, holders_bps: 0, burn_bps: 300 });
    assert_eq!(cfg.fees_seen, 0);

    let victim = [
        AccountMeta::new_readonly(k.pool, false),
        AccountMeta::new_readonly(m.trader.pubkey(), false),
        AccountMeta::new_readonly(k.quote_mint, false),
        AccountMeta::new_readonly(k.base_mint, false),
        AccountMeta::new(cfg_key, false),
    ];
    // "a sell": it would settle the buy and then record the sell's rates
    let forged = SwapPayload { direction: DIRECTION_SELL, amount_in: 1, lp_fee_bps: 30, slot: 1_000, ..Default::default() };
    let (attacker, x, x_hook) = env.relay_pool(&hook_rules::ID, &victim, hook_rules::instruction::BeforeSwap { payload: forged }.data());
    refused(&mut env, &attacker, &x, &x_hook);
    assert_eq!(env.svm.get_account(&cfg_key).unwrap().data, before, "the config did not change by one byte");

    // "a buy above the limit": it would fail anyway, but for the caller, not for the limit
    let forged = SwapPayload { direction: DIRECTION_BUY, amount_in: 50 * SOL, lp_fee_bps: 30, slot: 1_000, ..Default::default() };
    env.evil_set_relay(&attacker, &x.pool, &hook_rules::ID, hook_rules::instruction::BeforeSwap { payload: forged }.data());
    refused(&mut env, &attacker, &x, &x_hook);

    // on_pool_create for the pool that runs already
    let forged = PoolCreatePayload { lp_fee_bps: 30, base_amount: BASE_LIQ, quote_amount: QUOTE_LIQ, creator: m.creator.pubkey() };
    env.evil_set_relay(&attacker, &x.pool, &hook_rules::ID, hook_rules::instruction::OnPoolCreate { payload: forged }.data());
    refused(&mut env, &attacker, &x, &x_hook);
    assert_eq!(env.svm.get_account(&cfg_key).unwrap().data, before);

    // the real next trade settles the buy by its own rates
    let pool = env.pool(&k.pool);
    env.swap(&m.trader, &k, &hook, DIRECTION_SELL, 1_000_000_000, 0).unwrap();
    let cfg: hook_rules::RulesConfig = env.account(&cfg_key);
    let fee = pool.hook_fees_quote_total;
    assert_eq!((cfg.creator_owed, cfg.burn_pot), (fee * 100 / 400, fee - fee * 100 / 400));
}

#[test]
fn a_launch_rules_config_cannot_be_started_through_another_hook() {
    // the config of a coin that has not launched yet: transaction 1 of a launch is done
    let mut env = Env::new();
    env.set_clock(1_000, 1_760_000_000);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.rules_hook(&m.creator, &k, rules_args());
    let cfg_key = hook_rules::cfg_address(&k.pool);
    let victim = [
        AccountMeta::new_readonly(k.pool, false),
        AccountMeta::new_readonly(m.creator.pubkey(), false),
        AccountMeta::new_readonly(k.quote_mint, false),
        AccountMeta::new_readonly(k.base_mint, false),
        AccountMeta::new(cfg_key, false),
    ];
    let forged = PoolCreatePayload { lp_fee_bps: 30, base_amount: BASE_LIQ, quote_amount: QUOTE_LIQ, creator: m.creator.pubkey() };
    let (attacker, x, x_hook) = env.relay_pool(&hook_rules::ID, &victim, hook_rules::instruction::OnPoolCreate { payload: forged }.data());
    refused(&mut env, &attacker, &x, &x_hook);
    let cfg: hook_rules::RulesConfig = env.account(&cfg_key);
    assert_eq!((cfg.start_slot, cfg.start_time, cfg.min_eligible), (0, 0, 0), "not started");

    // the launch then starts it, at its own slot
    env.set_clock(2_000, 1_760_000_500);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, 30, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    let cfg: hook_rules::RulesConfig = env.account(&cfg_key);
    assert_eq!((cfg.start_slot, cfg.start_time), (2_000, 1_760_000_500));
}

// ---- the other templates: nothing to write, refused all the same --------------------------

#[test]
fn the_tax_and_the_buyback_refuse_a_relay_too() {
    for target in [hook_tax::ID, hook_buyback::ID] {
        let mut env = Env::new();
        let m = env.market();
        let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
        let cfg_key = HookRef::cfg(&target, &k.pool);
        let hook = if target == hook_tax::ID {
            env.tax_hook(&m.creator, &m.creator, &k.pool, &m.quote_mint, &m.creator.pubkey(), 300, 300, 1_000)
        } else {
            env.buyback_hook(&m.creator, &k.pool, &m.base_mint, &m.quote_mint, 200, 200, 1)
        };
        env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, 30, BASE_LIQ, QUOTE_LIQ, &hook);
        let victim = [
            AccountMeta::new_readonly(k.pool, false),
            AccountMeta::new_readonly(m.trader.pubkey(), false),
            AccountMeta::new_readonly(k.quote_mint, false),
            AccountMeta::new_readonly(k.base_mint, false),
            // the buyback's `before_swap` writes its config (it lowers the buyback's
            // observation), so the attacker has to hand it over writable
            if target == hook_tax::ID { AccountMeta::new_readonly(cfg_key, false) } else { AccountMeta::new(cfg_key, false) },
        ];
        // a forged payload that would lower the buyback's observation if it got through
        let forged = SwapPayload { direction: DIRECTION_BUY, amount_in: SOL, lp_fee_bps: 30, reserve_base: u64::MAX, reserve_quote: 1, ..Default::default() };
        // the two programs share the callback's name, so its instruction data is the same
        let data = hook_tax::instruction::BeforeSwap { payload: forged }.data();
        let (attacker, x, x_hook) = env.relay_pool(&target, &victim, data);
        refused(&mut env, &attacker, &x, &x_hook);
    }
}
