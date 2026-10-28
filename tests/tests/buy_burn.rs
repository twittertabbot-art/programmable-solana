//! The pool's `hook_buy_burn` on its own (HOOKS.md section 7).
//!
//! Two pools start equal. On the first, the hook calls `hook_buy_burn`. On the second, the
//! hook makes the same buy through `hook_swap` and then burns what it bought. Every number
//! of the two pools must stay equal to the unit, for a plain SPL coin and for a Token-2022
//! coin. The hook is the test-only `hook_evil`, silent: it takes no fee and changes no trade.

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::{system_instruction, system_program};
use anchor_lang::{AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022 as t22;
use hookpool::events::Swapped;
use hookpool_interface::*;
use hookpool_tests::*;
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;

const BASE_LIQ: u64 = 1_000_000_000_000_000;
const QUOTE_LIQ: u64 = 100 * SOL;
const LP_FEE: u16 = 30;

/// One pool with a silent hook_evil, and what its hook owns.
struct Side {
    k: PoolKeys,
    hook: HookRef,
    /// The mint authority of both mints.
    maker: Keypair,
    /// The hook's authority PDA ["hook-authority", pool] under hook_evil.
    authority: Pubkey,
    bump: u8,
    hook_quote: Pubkey,
    hook_base: Pubkey,
    trader: Keypair,
}

fn new_coin(env: &mut Env, payer: &Keypair, program: &Pubkey) -> Pubkey {
    if *program == TOKEN {
        return env.create_mint(payer, 6);
    }
    // a Token-2022 coin with the one extension kind the pool accepts: where its name lives
    use t22::extension::ExtensionType;
    let mint = Keypair::new();
    let space = ExtensionType::try_calculate_account_len::<t22::state::Mint>(&[ExtensionType::MetadataPointer]).unwrap();
    let ixs = [
        system_instruction::create_account(&payer.pubkey(), &mint.pubkey(), env.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
        t22::extension::metadata_pointer::instruction::initialize(&TOKEN_2022, &mint.pubkey(), None, Some(mint.pubkey())).unwrap(),
        t22::instruction::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &payer.pubkey(), None, 6).unwrap(),
    ];
    env.ok(&ixs, &[payer, &mint]);
    mint.pubkey()
}

/// Creates `owner`'s associated account of a mint of either token program and mints
/// `amount` into it.
fn give(env: &mut Env, maker: &Keypair, mint: &Pubkey, program: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
    let acc = ata_with(owner, mint, program);
    let mut ixs = vec![Env::create_ata_with_ix(&maker.pubkey(), owner, mint, program)];
    if amount > 0 {
        ixs.push(t22::instruction::mint_to(program, mint, &acc, &maker.pubkey(), &[], amount).unwrap());
    }
    env.ok(&ixs, &[maker]);
    acc
}

fn side(env: &mut Env, program: &Pubkey) -> Side {
    let maker = env.user(100 * SOL);
    let base = new_coin(env, &maker, program);
    let quote = env.create_mint(&maker, 9);
    let k = Env::pool_keys_with(&base, &quote, program);
    give(env, &maker, &base, program, &maker.pubkey(), 2 * BASE_LIQ);
    give(env, &maker, &quote, &TOKEN, &maker.pubkey(), 10_000 * SOL);
    let cfg = HookRef::cfg(&hook_evil::ID, &k.pool);
    let init = Instruction {
        program_id: hook_evil::ID,
        accounts: hook_evil::accounts::InitPoolConfig { payer: maker.pubkey(), cfg, system_program: system_program::ID }.to_account_metas(None),
        data: hook_evil::instruction::InitPoolConfig { pool: k.pool, mode: hook_evil::MODE_SILENT, value: 0 }.data(),
    };
    env.ok(&[init], &[&maker]);
    // no hook fee: the treasury slot is unused
    let hook = HookRef { program: hook_evil::ID, treasury: system_program::ID, extra: vec![AccountMeta::new(cfg, false)] };
    let ix = env.create_pool_ix(&maker.pubkey(), &k, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&maker]);
    let (authority, bump) = Pubkey::find_program_address(&[HOOK_AUTHORITY_SEED, k.pool.as_ref()], &hook_evil::ID);
    let hook_quote = give(env, &maker, &quote, &TOKEN, &authority, 1_000 * SOL);
    let hook_base = give(env, &maker, &base, program, &authority, 0);
    let trader = env.user(10 * SOL);
    give(env, &maker, &base, program, &trader.pubkey(), BASE_LIQ / 10);
    give(env, &maker, &quote, &TOKEN, &trader.pubkey(), 1_000 * SOL);
    Side { k, hook, maker, authority, bump, hook_quote, hook_base, trader }
}

/// hook_evil's `buy_burn`: the pool's `hook_buy_burn`, signed by the hook authority of
/// `signer_pool`.
#[allow(clippy::too_many_arguments)]
fn evil_buy_burn_ix(env: &Env, s: &Side, signer_pool: &Pubkey, authority: &Pubkey, hook_quote: &Pubkey, bump: u8, amount_in: u64, min_out: u64) -> Instruction {
    Instruction {
        program_id: hook_evil::ID,
        accounts: hook_evil::accounts::BuyBurn {
            hook_authority: *authority,
            signer_pool: *signer_pool,
            platform: env.platform,
            pool: s.k.pool,
            base_mint: s.k.base_mint,
            quote_mint: s.k.quote_mint,
            base_vault: s.k.base_vault,
            quote_vault: s.k.quote_vault,
            hook_quote: *hook_quote,
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: s.k.base_program,
            quote_token_program: TOKEN,
        }
        .to_account_metas(None),
        data: hook_evil::instruction::BuyBurn { amount_in, min_amount_out: min_out, authority_bump: bump }.data(),
    }
}

fn buy_burn_ix(env: &Env, s: &Side, amount_in: u64, min_out: u64) -> Instruction {
    evil_buy_burn_ix(env, s, &s.k.pool, &s.authority, &s.hook_quote, s.bump, amount_in, min_out)
}

/// hook_evil's `swap_then_burn`: `hook_swap` into the hook's own coin account, then a burn.
fn swap_then_burn_ix(env: &Env, s: &Side, amount_in: u64, min_out: u64) -> Instruction {
    Instruction {
        program_id: hook_evil::ID,
        accounts: hook_evil::accounts::SwapThenBurn {
            hook_authority: s.authority,
            platform: env.platform,
            pool: s.k.pool,
            base_mint: s.k.base_mint,
            quote_mint: s.k.quote_mint,
            base_vault: s.k.base_vault,
            quote_vault: s.k.quote_vault,
            hook_base: s.hook_base,
            hook_quote: s.hook_quote,
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: s.k.base_program,
            quote_token_program: TOKEN,
        }
        .to_account_metas(None),
        data: hook_evil::instruction::SwapThenBurn { amount_in, min_amount_out: min_out, authority_bump: s.bump }.data(),
    }
}

/// `hook_buy_burn` sent straight to the pool, with `signer` in the hook authority's place.
fn direct_ix(env: &Env, k: &PoolKeys, signer: &Pubkey, hook_quote: &Pubkey, bump: u8, amount_in: u64) -> Instruction {
    Instruction {
        program_id: hookpool::ID,
        accounts: hookpool::accounts::HookBuyBurn {
            hook_authority: *signer,
            platform: env.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            hook_quote: *hook_quote,
            base_token_program: k.base_program,
            quote_token_program: TOKEN,
            event_authority: event_authority_address(&hookpool::ID),
            program: hookpool::ID,
        }
        .to_account_metas(None),
        data: hookpool::instruction::HookBuyBurn { amount_in, min_amount_out: 0, authority_bump: bump }.data(),
    }
}

/// Events written with `emit_cpi!`: an inner instruction of the program to itself with
/// data = e445a52e51cb9a1d + discriminator + borsh.
fn cpi_events<T: AnchorDeserialize + Discriminator>(meta: &TransactionMetadata) -> Vec<T> {
    const TAG: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
    meta.inner_instructions
        .iter()
        .flatten()
        .map(|i| &i.instruction.data)
        .filter(|d| d.len() >= 16 && d[..8] == TAG && d[8..16] == *T::DISCRIMINATOR)
        .map(|d| T::deserialize(&mut &d[16..]).unwrap())
        .collect()
}

/// Inner instruction data that starts with `tag` and carries `amount` right after it: a
/// token Burn is tag 8, a TransferChecked tag 12.
fn has_token_call(meta: &TransactionMetadata, tag: u8, amount: u64) -> bool {
    meta.inner_instructions.iter().flatten().any(|i| {
        let d = &i.instruction.data;
        d.len() >= 9 && d[0] == tag && d[1..9] == amount.to_le_bytes()
    })
}

/// Every number a pool keeps that is not an address.
fn numbers(p: &hookpool::Pool) -> [u64; 11] {
    [
        p.reserve_base,
        p.reserve_quote,
        p.protocol_fees_base,
        p.protocol_fees_quote,
        p.hook_fees_quote_total,
        p.volume_quote_total,
        p.swap_count,
        p.hook_fees_owed_quote,
        p.lp_fee_bps as u64,
        p.hook_flags as u64,
        p.hook_kind as u64,
    ]
}

/// What the two sides must have equal, and the pool's own accounting on each.
fn state(env: &Env, s: &Side) -> ([u64; 11], [u64; 5]) {
    let p = env.pool(&s.k.pool);
    assert_eq!(env.balance(&s.k.base_vault), p.reserve_base + p.protocol_fees_base, "the coin vault holds the reserve and the protocol's coin fees");
    assert_eq!(env.balance(&s.k.quote_vault), p.reserve_quote + p.protocol_fees_quote + p.hook_fees_owed_quote, "the quote vault");
    assert_eq!(env.balance(&s.hook_base), 0, "the hook keeps no coin");
    let tb = ata_with(&s.trader.pubkey(), &s.k.base_mint, &s.k.base_program);
    let tq = ata(&s.trader.pubkey(), &s.k.quote_mint);
    (numbers(&p), [env.mint_supply(&s.k.base_mint), env.balance(&s.hook_quote), env.balance(&tb), env.balance(&tq), env.balance(&s.k.base_vault)])
}

fn twins(program: &Pubkey) -> (Env, Side, Side) {
    let mut env = Env::new();
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    let a = side(&mut env, program);
    let b = side(&mut env, program);
    assert_eq!(state(&env, &a), state(&env, &b));
    (env, a, b)
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }
}

/// A mixed run on the twin pools: trades by a trader, buys of the hook. After every step
/// the two pools agree to the unit, each pool's vaults match its numbers, the product of
/// the reserves never falls, and the coin's supply fell by exactly what was burned.
fn twin_run(program: &Pubkey, seed: u64) {
    let (mut env, a, b) = twins(program);
    let supply0 = env.mint_supply(&a.k.base_mint);
    let mut burned = 0u64;
    let mut rng = Rng(seed);
    let mut units = (0u64, 0u64);
    for step in 0..60 {
        let before = env.pool(&a.k.pool);
        let roll = rng.next() % 3;
        if roll == 0 || step == 0 {
            // the hook buys, and the coins it buys are burned
            let amount = rng.range(1_000, 2 * SOL);
            let q = expect_swap(&before, DIRECTION_BUY, amount, 0, None);
            let ma = env.ok(&[buy_burn_ix(&env, &a, amount, q.amount_out)], &[&a.maker]);
            let mb = env.ok(&[swap_then_burn_ix(&env, &b, amount, q.amount_out)], &[&b.maker]);
            burned += q.amount_out;
            units = (ma.compute_units_consumed, mb.compute_units_consumed);
            // what the pool says: its own event, field for field as the `hook_swap` buy's
            let (ea, eb) = (&cpi_events::<Swapped>(&ma)[0], &cpi_events::<Swapped>(&mb)[0]);
            assert_eq!((ea.pool, ea.user), (a.k.pool, a.authority));
            assert_eq!((eb.pool, eb.user), (b.k.pool, b.authority));
            let fields = |e: &Swapped| (e.direction, e.amount_in, e.amount_out, e.protocol_fee, e.hook_fee, e.lp_fee, e.fee_bps_applied, e.reserve_base, e.reserve_quote, e.slot, e.by_hook);
            assert_eq!(fields(ea), fields(eb), "the same event");
            assert_eq!((ea.amount_out, ea.hook_fee, ea.by_hook), (q.amount_out, 0, true));
            // and its return data: the coins bought and burned
            assert_eq!(ma.return_data.program_id.to_bytes(), hookpool::ID.to_bytes());
            assert_eq!(ma.return_data.data, q.amount_out.to_le_bytes().to_vec());
            // how a client tells the two apart: a burn in the pool's vault and no payout
            assert!(has_token_call(&ma, 8, q.amount_out) && !has_token_call(&ma, 12, q.amount_out));
            assert!(has_token_call(&mb, 12, q.amount_out) && has_token_call(&mb, 8, q.amount_out));
        } else if roll == 1 {
            let amount = rng.range(1_000_000, 5 * SOL);
            env.swap(&a.trader, &a.k, &a.hook, DIRECTION_BUY, amount, 0).unwrap();
            env.swap(&b.trader, &b.k, &b.hook, DIRECTION_BUY, amount, 0).unwrap();
        } else {
            let held = env.balance(&ata_with(&a.trader.pubkey(), &a.k.base_mint, program));
            let amount = rng.range(1_000_000, held / 4);
            env.swap(&a.trader, &a.k, &a.hook, DIRECTION_SELL, amount, 0).unwrap();
            env.swap(&b.trader, &b.k, &b.hook, DIRECTION_SELL, amount, 0).unwrap();
        }
        let (sa, sb) = (state(&env, &a), state(&env, &b));
        assert_eq!(sa, sb, "step {step}: the two pools agree");
        assert_eq!(sa.1[0], supply0 - burned, "step {step}: the supply fell by what was burned");
        let after = env.pool(&a.k.pool);
        assert!(after.reserve_base as u128 * after.reserve_quote as u128 >= before.reserve_base as u128 * before.reserve_quote as u128, "step {step}: the product of the reserves fell");
    }
    assert!(burned > 0);
    println!("{program}: burned {burned}; units: hook_buy_burn through hook_evil {}, hook_swap + burn {}", units.0, units.1);
}

#[test]
fn a_buy_burn_is_a_hook_swap_buy_followed_by_a_burn_on_an_spl_coin() {
    twin_run(&TOKEN, 1);
}

#[test]
fn a_buy_burn_is_a_hook_swap_buy_followed_by_a_burn_on_a_token_2022_coin() {
    twin_run(&TOKEN_2022, 2);
}

#[test]
fn only_the_authority_of_the_pools_own_hook_may_call_it() {
    let (mut env, a, c) = twins(&TOKEN);
    let start = state(&env, &a);
    // a stranger who signs for itself, with its own quote
    let stranger = env.user(10 * SOL);
    let own = give(&mut env, &a.maker, &a.k.quote_mint, &TOKEN, &stranger.pubkey(), 10 * SOL);
    for bump in [255u8, a.bump] {
        let ix = direct_ix(&env, &a.k, &stranger.pubkey(), &own, bump, SOL);
        env.err(&[ix], &[&stranger], "HookAuthorityMismatch");
    }
    // the hook authority of ANOTHER pool of the same hook program, signing through it
    let other = give(&mut env, &a.maker, &a.k.quote_mint, &TOKEN, &c.authority, 10 * SOL);
    let ix = evil_buy_burn_ix(&env, &a, &c.k.pool, &c.authority, &other, c.bump, SOL, 0);
    env.err(&[ix], &[&a.maker], "HookAuthorityMismatch");
    // the hook's quote account must be the hook authority's own
    let ix = evil_buy_burn_ix(&env, &a, &a.k.pool, &a.authority, &own, a.bump, SOL, 0);
    env.err(&[ix], &[&a.maker], "ConstraintTokenOwner");
    assert_eq!(state(&env, &a), start, "nothing moved");
    // a pool without a hook has nobody who may call it
    let m = env.market();
    let k = env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, LP_FEE, 1_000_000_000_000, 100 * SOL, &HookRef::none());
    let theirs = ata(&m.creator.pubkey(), &m.quote_mint);
    let ix = direct_ix(&env, &k, &m.creator.pubkey(), &theirs, 255, SOL);
    env.err(&[ix], &[&m.creator], "NoHook");
    // and the right one goes through
    let q = expect_swap(&env.pool(&a.k.pool), DIRECTION_BUY, SOL, 0, None);
    env.ok(&[buy_burn_ix(&env, &a, SOL, q.amount_out)], &[&a.maker]);
}

#[test]
fn a_buy_burn_that_buys_nothing_or_less_than_its_minimum_fails_and_the_pause_stops_it() {
    let (mut env, a, _) = twins(&TOKEN_2022);
    let start = state(&env, &a);
    // nothing in
    env.err(&[buy_burn_ix(&env, &a, 0, 0)], &[&a.maker], "ZeroAmount");
    // so little in that nothing comes out: 1 lamport against 100 SOL pays only fees
    env.err(&[buy_burn_ix(&env, &a, 1, 0)], &[&a.maker], "ZeroAmount");
    // one coin unit more than the buy gives
    let q = expect_swap(&env.pool(&a.k.pool), DIRECTION_BUY, SOL, 0, None);
    env.err(&[buy_burn_ix(&env, &a, SOL, q.amount_out + 1)], &[&a.maker], "Slippage");
    // the pause stops it as it stops every trade
    env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(true), ..Default::default() });
    env.err(&[buy_burn_ix(&env, &a, SOL, 0)], &[&a.maker], "Paused");
    assert_eq!(state(&env, &a), start, "nothing moved");
    env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(false), ..Default::default() });
    env.ok(&[buy_burn_ix(&env, &a, SOL, q.amount_out)], &[&a.maker]);
    assert_eq!(env.mint_supply(&a.k.base_mint), start.1[0] - q.amount_out);
}
