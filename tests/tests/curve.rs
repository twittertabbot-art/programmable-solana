//! The curve launch (HOOKS.md section 2, "A pool on the curve"). A pool that holds the
//! whole supply of a closed coin and no quote at all. It prices every trade with a virtual
//! quote on top of its real reserve, pays out the real reserve only, refuses liquidity
//! until it graduates, and graduates, by anyone's hand, by burning the coins the virtual
//! quote stood for, so that the price does not move. One pool, one address, for the whole
//! life of the coin.
//!
//! Every test runs against the real pool, launchpad, hook and token binaries in LiteSVM.

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use anchor_lang::{AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022 as t22;
use hook_rules::{Rates, RulesArgs, StrictArgs};
use hookpool::events::{CurveOpened, Graduated, PoolCreated, Swapped};
use hookpool::math::SwapQuote;
use hookpool_interface::*;
use hookpool_tests::*;
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;

const SUPPLY: u64 = 1_000_000_000_000_000; // 1B coins at 6 decimals
const VIRTUAL: u64 = DEFAULT_CURVE_VIRTUAL_QUOTE; // 30 SOL
const TARGET: u64 = DEFAULT_CURVE_GRADUATION_TARGET; // 85 SOL
const LP_FEE: u16 = 30;
const START_SLOT: u64 = 1_000;

// ---- a pool on the curve, and the wallets around it ---------------------------------------

struct World {
    env: Env,
    k: PoolKeys,
    hook: HookRef,
    /// Mint authority of the quote; created the pool.
    maker: Keypair,
    traders: Vec<Keypair>,
    /// Coins and quote sent straight to the vaults, outside the reserves (the donations test).
    donated: (u64, u64),
}

/// A wallet with SOL, `quote` units of the quote token and an empty account for the coin.
fn wallet(env: &mut Env, maker: &Keypair, k: &PoolKeys, quote: u64) -> Keypair {
    let w = env.user(5 * SOL);
    let q = env.create_ata(&w, &w.pubkey(), &k.quote_mint);
    if quote > 0 {
        env.mint_to(maker, &k.quote_mint, &q, quote);
    }
    env.ok(&[Env::create_ata_with_ix(&w.pubkey(), &w.pubkey(), &k.base_mint, &k.base_program)], &[&w]);
    w
}

/// The keys of a fresh closed coin under `program` and a fresh quote, both the maker's.
fn coin(env: &mut Env, maker: &Keypair, program: &Pubkey) -> PoolKeys {
    let base = env.closed_coin(maker, program, SUPPLY);
    let quote = env.create_mint(maker, 9);
    // the account list of a pool creation names the creator's quote account; it holds nothing
    env.create_ata(maker, &maker.pubkey(), &quote);
    Env::pool_keys_with(&base, &quote, program)
}

/// A pool on the curve without a hook, and `n` traders with 300 quote each.
fn open(program: &Pubkey, lp_fee: u16, n: usize) -> (World, TransactionMetadata) {
    let mut env = Env::new();
    env.set_clock(START_SLOT, 1_760_000_000);
    let maker = env.user(100 * SOL);
    let k = coin(&mut env, &maker, program);
    let meta = env.create_curve_pool(&maker, &k, lp_fee, SUPPLY, &HookRef::none());
    let traders = (0..n).map(|_| wallet(&mut env, &maker, &k, 300 * SOL)).collect();
    (World { env, k, hook: HookRef::none(), maker, traders, donated: (0, 0) }, meta)
}

fn coins_of(k: &PoolKeys, wallet: &Pubkey) -> Pubkey {
    ata_with(wallet, &k.base_mint, &k.base_program)
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

/// The effective price `(reserve_quote + virtual_quote) / reserve_base` as a fraction.
fn price(p: &hookpool::Pool) -> (u128, u128) {
    (p.reserve_quote as u128 + p.virtual_quote as u128, p.reserve_base as u128)
}

/// Graduation keeps the price: never down, up by less than one unit of the coin.
fn assert_price_kept(before: &hookpool::Pool, after: &hookpool::Pool) {
    let ((bn, bd), (an, ad)) = (price(before), price(after));
    assert!(an * bd >= bn * ad, "the price moved down at graduation");
    assert!(an * bd < bn * (ad + 1), "the price moved up by a whole coin unit or more");
}

/// The vaults hold exactly the reserves plus the fees waiting in them.
fn assert_vaults(env: &Env, k: &PoolKeys) -> hookpool::Pool {
    assert_vaults_with(env, k, (0, 0))
}

/// The same, with `donated` (coins, quote) sent straight to the vaults on top.
fn assert_vaults_with(env: &Env, k: &PoolKeys, donated: (u64, u64)) -> hookpool::Pool {
    let p = env.pool(&k.pool);
    assert_eq!(env.balance(&k.base_vault), p.reserve_base + p.protocol_fees_base + donated.0, "the coin vault");
    assert_eq!(env.balance(&k.quote_vault), p.reserve_quote + p.protocol_fees_quote + p.hook_fees_owed_quote + donated.1, "the quote vault");
    p
}

impl World {
    fn pool(&self) -> hookpool::Pool {
        self.env.pool(&self.k.pool)
    }
    fn trader(&self, i: usize) -> Keypair {
        self.traders[i].insecure_clone()
    }
    /// A trade by trader `i`, checked against the pool's own math with the virtual quote.
    fn trade(&mut self, i: usize, direction: u8, amount: u64, hook_fee_bps: u16) -> SwapQuote {
        let before = self.pool();
        let q = expect_swap(&before, direction, amount, hook_fee_bps, None);
        let t = self.trader(i);
        let (b0, q0) = (self.env.balance(&coins_of(&self.k, &t.pubkey())), self.env.balance(&ata(&t.pubkey(), &self.k.quote_mint)));
        let meta = self.env.swap(&t, &self.k, &self.hook, direction, amount, q.amount_out).unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.pretty_logs()));
        assert_eq!(meta.return_data.data, q.amount_out.to_le_bytes().to_vec());
        let after = assert_vaults_with(&self.env, &self.k, self.donated);
        if direction == DIRECTION_BUY {
            assert_eq!((after.reserve_quote, after.reserve_base), (q.reserve_in_after, q.reserve_out_after));
            assert_eq!(self.env.balance(&coins_of(&self.k, &t.pubkey())), b0 + q.amount_out);
            assert_eq!(self.env.balance(&ata(&t.pubkey(), &self.k.quote_mint)), q0 - amount);
        } else {
            assert!(q.amount_out_gross <= before.reserve_quote, "a sell asked for more than the real reserve");
            assert_eq!((after.reserve_base, after.reserve_quote), (q.reserve_in_after, q.reserve_out_after));
            assert_eq!(self.env.balance(&coins_of(&self.k, &t.pubkey())), b0 - amount);
            assert_eq!(self.env.balance(&ata(&t.pubkey(), &self.k.quote_mint)), q0 + q.amount_out);
        }
        // the virtual part is never paid out and never owed: the quote vault is the real
        // reserve plus the fees in it, as on any pool
        assert_eq!(after.virtual_quote, before.virtual_quote);
        q
    }
    fn buy(&mut self, i: usize, amount: u64) -> SwapQuote {
        self.trade(i, DIRECTION_BUY, amount, 0)
    }
    fn sell(&mut self, i: usize, amount: u64) -> SwapQuote {
        self.trade(i, DIRECTION_SELL, amount, 0)
    }
    /// Buys of 20 quote by trader 0 until the real reserve stands at the target or above.
    fn reach_target(&mut self) {
        let target = self.pool().graduation_target;
        while self.pool().reserve_quote < target {
            self.buy(0, 20 * SOL);
        }
    }
    fn graduate(&mut self, who: &Keypair) -> TransactionMetadata {
        let ix = self.env.graduate_ix(&self.k);
        self.env.ok(&[ix], &[who])
    }
    /// `graduate` lands and changes nothing: the pool account byte for byte, the supply,
    /// both vaults, and no `Graduated` event.
    fn graduate_does_nothing(&mut self, who: &Keypair) {
        let raw = self.env.svm.get_account(&self.k.pool).unwrap().data;
        let before = (self.env.mint_supply(&self.k.base_mint), self.env.balance(&self.k.base_vault), self.env.balance(&self.k.quote_vault));
        let meta = self.graduate(who);
        assert_eq!(self.env.svm.get_account(&self.k.pool).unwrap().data, raw, "the pool account is the same");
        assert_eq!((self.env.mint_supply(&self.k.base_mint), self.env.balance(&self.k.base_vault), self.env.balance(&self.k.quote_vault)), before);
        assert_eq!(cpi_events::<Graduated>(&meta).len(), 0, "no event");
    }
    fn graduate_err(&mut self, who: &Keypair, needle: &str) {
        let ix = self.env.graduate_ix(&self.k);
        self.env.err(&[ix], &[who], needle);
    }
    fn held(&self, i: usize) -> u64 {
        self.env.balance(&coins_of(&self.k, &self.traders[i].pubkey()))
    }
}

fn warp(env: &mut Env, slot: u64) {
    let t = env.clock().unix_timestamp;
    env.set_clock(slot, t);
}

// ---- 1. opening -----------------------------------------------------------------------------

#[test]
fn a_curve_pool_opens_with_no_real_quote_every_share_locked_and_the_platforms_settings_copied() {
    for program in [TOKEN, TOKEN_2022] {
        let (w, meta) = open(&program, LP_FEE, 0);
        let p = assert_vaults(&w.env, &w.k);
        assert_eq!((p.reserve_base, p.reserve_quote), (SUPPLY, 0));
        assert_eq!((p.virtual_quote, p.graduation_target, p.graduation_fee_bps), (VIRTUAL, TARGET, 0));
        assert_eq!(p.curve_state, CURVE_OPEN);
        assert!(p.on_curve());
        assert_eq!(p.effective_quote().unwrap(), VIRTUAL);
        assert_eq!(p.creator, w.maker.pubkey());
        assert_eq!(p.hook_kind, HOOK_KIND_NONE);
        // LP: sqrt(supply * virtual), all of it in the lock account, none to the creator
        let lp = ((SUPPLY as u128) * (VIRTUAL as u128)).isqrt() as u64;
        assert_eq!(w.env.mint_supply(&w.k.lp_mint), lp);
        assert_eq!(w.env.balance(&w.k.lp_lock), lp);
        assert_eq!(w.env.balance(&ata(&w.maker.pubkey(), &w.k.lp_mint)), 0);
        // the whole supply is in the vault, the maker holds none, and nobody can mint more
        assert_eq!(w.env.balance(&w.k.base_vault), SUPPLY);
        assert_eq!(w.env.balance(&coins_of(&w.k, &w.maker.pubkey())), 0);
        assert_eq!(w.env.mint_supply(&w.k.base_mint), SUPPLY);
        // the events: the usual PoolCreated, then CurveOpened
        let created = &cpi_events::<PoolCreated>(&meta)[0];
        assert_eq!((created.pool, created.base_amount, created.quote_amount, created.lp_minted), (w.k.pool, SUPPLY, 0, 0));
        let opened = &cpi_events::<CurveOpened>(&meta)[0];
        assert_eq!((opened.pool, opened.virtual_quote, opened.graduation_target, opened.graduation_fee_bps, opened.slot), (w.k.pool, VIRTUAL, TARGET, 0, START_SLOT));
        println!("{program}: create_curve_pool {} CU", meta.compute_units_consumed);
    }

    // the platform's defaults, written by init_platform
    let (mut w, _) = open(&TOKEN, LP_FEE, 0);
    let platform: hookpool::Platform = w.env.account(&w.env.platform);
    assert_eq!((platform.curve_virtual_quote, platform.curve_graduation_target, platform.curve_graduation_fee_bps), (VIRTUAL, TARGET, 0));
    assert_eq!(platform.pool_count, 1);
    // a change of the settings: the running curve keeps its own, a new pool copies the new
    w.env.update_platform(hookpool::UpdatePlatformArgs { curve_virtual_quote: Some(3 * SOL), curve_graduation_target: Some(8_500_000_000), curve_graduation_fee_bps: Some(700), ..Default::default() });
    assert_eq!((w.pool().virtual_quote, w.pool().graduation_target, w.pool().graduation_fee_bps), (VIRTUAL, TARGET, 0));
    let maker = w.maker.insecure_clone();
    let k2 = coin(&mut w.env, &maker, &TOKEN);
    w.env.create_curve_pool(&maker, &k2, LP_FEE, SUPPLY, &HookRef::none());
    let p2 = w.env.pool(&k2.pool);
    assert_eq!((p2.virtual_quote, p2.graduation_target, p2.graduation_fee_bps), (3 * SOL, 8_500_000_000, 700));
    assert_eq!(w.env.mint_supply(&k2.lp_mint), ((SUPPLY as u128) * (3 * SOL) as u128).isqrt() as u64);
    // the graduation fee has a hard ceiling of 10%
    let ix = w.env.admin_ix(hookpool::instruction::UpdatePlatform { args: hookpool::UpdatePlatformArgs { curve_graduation_fee_bps: Some(1_001), ..Default::default() } }.data());
    let admin = w.env.admin.insecure_clone();
    w.env.err(&[ix], &[&admin], "fee exceeds");
    w.env.update_platform(hookpool::UpdatePlatformArgs { curve_graduation_fee_bps: Some(1_000), ..Default::default() });
    // the admin's bounds: a virtual quote above u64::MAX / 4, or a target below a thousandth of it
    let ix = w.env.admin_ix(hookpool::instruction::UpdatePlatform { args: hookpool::UpdatePlatformArgs { curve_virtual_quote: Some(u64::MAX / 4 + 1), ..Default::default() } }.data());
    w.env.err(&[ix], &[&admin], "u64::MAX / 4");
    let ix = w.env.admin_ix(hookpool::instruction::UpdatePlatform { args: hookpool::UpdatePlatformArgs { curve_virtual_quote: Some(VIRTUAL), curve_graduation_target: Some(VIRTUAL / 1_000 - 1), ..Default::default() } }.data());
    w.env.err(&[ix], &[&admin], "thousandth");
    w.env.update_platform(hookpool::UpdatePlatformArgs { curve_virtual_quote: Some(VIRTUAL), curve_graduation_target: Some(VIRTUAL / 1_000), ..Default::default() });
    w.env.update_platform(hookpool::UpdatePlatformArgs { curve_graduation_target: Some(0), ..Default::default() });
    let platform: hookpool::Platform = w.env.account(&w.env.platform);
    assert!(!platform.curve_enabled());
}

// ---- a pegged coin at the pool's own door ----------------------------------------------------

fn col_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &hook_collectible::ID).0
}
fn col_cfg_of(pool: &Pubkey) -> Pubkey {
    col_pda(&[hook_collectible::CFG_SEED, pool.as_ref()])
}
fn col_ticket_of(pool: &Pubkey, user: &Pubkey) -> Pubkey {
    col_pda(&[hook_collectible::TICKET_SEED, pool.as_ref(), user.as_ref()])
}
/// The collectible hook as `user` sees it, with what the coin's transfer hook needs.
fn collectible_hook_for(k: &PoolKeys, user: &Pubkey) -> HookRef {
    HookRef {
        program: hook_collectible::ID,
        treasury: system_program::ID,
        extra: vec![
            AccountMeta::new(col_cfg_of(&k.pool), false),
            AccountMeta::new(col_ticket_of(&k.pool, user), false),
            AccountMeta::new_readonly(hook_collectible::SLOT_HASHES_ID, false),
            AccountMeta::new(col_ticket_of(&k.pool, &k.pool), false),
            AccountMeta::new(col_pda(&[hook_collectible::QUEUE_SEED, k.pool.as_ref()]), false),
            AccountMeta::new_readonly(col_pda(&[hook_collectible::VALIDATION_SEED, k.base_mint.as_ref()]), false),
        ],
    }
}
fn init_collection_ix(payer: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: hook_collectible::ID,
        accounts: hook_collectible::accounts::InitPoolConfig {
            payer: *payer,
            owner: *payer,
            cfg: col_cfg_of(pool),
            collection: col_pda(&[hook_collectible::COLLECTION_SEED, pool.as_ref()]),
            collection_authority: col_pda(&[hook_collectible::AUTHORITY_SEED, pool.as_ref()]),
            core_program: MPL_CORE,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_collectible::instruction::InitPoolConfig {
            pool: *pool,
            args: hook_collectible::InitCollectionArgs { name: "Pegs".into(), uri_base: "https://example.invalid/art".into(), unit: 2_000 * 1_000_000, max_supply: 10_000, max_per_buy: 3, art: [1; 16] },
        }
        .data(),
    }
}
fn init_peg_ix(payer: &Pubkey, k: &PoolKeys) -> Instruction {
    Instruction {
        program_id: hook_collectible::ID,
        accounts: hook_collectible::accounts::InitPeg {
            payer: *payer,
            mint: k.base_mint,
            quote_mint: k.quote_mint,
            cfg: col_cfg_of(&k.pool),
            validation: col_pda(&[hook_collectible::VALIDATION_SEED, k.base_mint.as_ref()]),
            queue: col_pda(&[hook_collectible::QUEUE_SEED, k.pool.as_ref()]),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_collectible::instruction::InitPeg {}.data(),
    }
}

#[test]
fn create_curve_pool_refuses_a_pegged_collectible_coin_that_a_seeded_pool_takes() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, 1_760_000_000);
    let authority = env.user(10 * SOL);
    let maker = env.user(100 * SOL);
    let quote = env.create_mint(&authority, 9);
    let q = env.create_ata(&maker, &maker.pubkey(), &quote);
    env.mint_to(&authority, &quote, &q, 100 * SOL);
    // the coin as a pegged launch leaves it: Token-2022, the collectible program as its
    // transfer hook with no authority, the whole supply in the maker's account, no mint authority
    let mint = Keypair::new();
    let space = t22::extension::ExtensionType::try_calculate_account_len::<t22::state::Mint>(&[t22::extension::ExtensionType::TransferHook]).unwrap();
    let acc = ata_with(&maker.pubkey(), &mint.pubkey(), &TOKEN_2022);
    env.ok(
        &[
            anchor_lang::solana_program::system_instruction::create_account(&maker.pubkey(), &mint.pubkey(), env.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
            t22::extension::transfer_hook::instruction::initialize(&TOKEN_2022, &mint.pubkey(), None, Some(hook_collectible::ID)).unwrap(),
            t22::instruction::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &maker.pubkey(), None, 6).unwrap(),
            Env::create_ata_with_ix(&maker.pubkey(), &maker.pubkey(), &mint.pubkey(), &TOKEN_2022),
            t22::instruction::mint_to(&TOKEN_2022, &mint.pubkey(), &acc, &maker.pubkey(), &[], SUPPLY).unwrap(),
            t22::instruction::set_authority(&TOKEN_2022, &mint.pubkey(), None, t22::instruction::AuthorityType::MintTokens, &maker.pubkey(), &[]).unwrap(),
        ],
        &[&maker, &mint],
    );
    let k = Env::pool_keys_with(&mint.pubkey(), &quote, &TOKEN_2022);
    env.ok(&[compute_budget_ix(300_000), init_collection_ix(&maker.pubkey(), &k.pool), init_peg_ix(&maker.pubkey(), &k)], &[&maker, &mint]);
    let hook = collectible_hook_for(&k, &maker.pubkey());
    // the pool's own door refuses it on the curve, after the mint's extensions were accepted
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, &hook);
    env.err(&[compute_budget_ix(500_000), ix], &[&maker], "pegged coin cannot open a pool on the curve");
    assert!(env.svm.get_account(&k.pool).is_none());
    // the same coin opens a SEEDED pool, the collectible template's own way
    let ix = env.create_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, 10 * SOL, &hook);
    env.ok(&[compute_budget_ix(500_000), ix], &[&maker]);
    let p = assert_vaults(&env, &k);
    assert_eq!((p.curve_state, p.hook_program, p.reserve_quote), (CURVE_NONE, hook_collectible::ID, 10 * SOL));
    // and a pegged coin with no hook of the pool's at all is refused earlier, as before
    let mint2 = Keypair::new();
    let acc2 = ata_with(&maker.pubkey(), &mint2.pubkey(), &TOKEN_2022);
    env.ok(
        &[
            anchor_lang::solana_program::system_instruction::create_account(&maker.pubkey(), &mint2.pubkey(), env.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
            t22::extension::transfer_hook::instruction::initialize(&TOKEN_2022, &mint2.pubkey(), None, Some(hook_collectible::ID)).unwrap(),
            t22::instruction::initialize_mint2(&TOKEN_2022, &mint2.pubkey(), &maker.pubkey(), None, 6).unwrap(),
            Env::create_ata_with_ix(&maker.pubkey(), &maker.pubkey(), &mint2.pubkey(), &TOKEN_2022),
            t22::instruction::mint_to(&TOKEN_2022, &mint2.pubkey(), &acc2, &maker.pubkey(), &[], SUPPLY).unwrap(),
            t22::instruction::set_authority(&TOKEN_2022, &mint2.pubkey(), None, t22::instruction::AuthorityType::MintTokens, &maker.pubkey(), &[]).unwrap(),
        ],
        &[&maker, &mint2],
    );
    let k2 = Env::pool_keys_with(&mint2.pubkey(), &quote, &TOKEN_2022);
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k2, LP_FEE, SUPPLY, &HookRef::none());
    env.err(&[compute_budget_ix(400_000), ix], &[&maker], "does not accept");
}

// ---- 2. the first buy -----------------------------------------------------------------------

#[test]
fn the_first_buy_follows_the_constant_product_with_the_virtual_quote() {
    // no fee anywhere, so the numbers are the bare curve's
    let (mut w, _) = open(&TOKEN, 0, 2);
    w.env.update_platform(hookpool::UpdatePlatformArgs { protocol_fee_bps: Some(0), ..Default::default() });
    let t = w.trader(0);
    let q = hookpool::math::quote_swap(DIRECTION_BUY, SOL, SUPPLY, 0, VIRTUAL, 0, 0, 0, None, None).unwrap();
    // 1e15 * 1e9 / (30e9 + 1e9)
    assert_eq!(q.amount_out, 32_258_064_516_129);
    w.env.swap(&t, &w.k, &HookRef::none(), DIRECTION_BUY, SOL, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    assert_eq!(w.held(0), q.amount_out);
    let p = assert_vaults(&w.env, &w.k);
    assert_eq!(p.reserve_quote, SOL, "the real reserve is the one SOL that came in");
    assert_eq!(w.env.balance(&w.k.quote_vault), SOL);
    assert_eq!(p.reserve_base, SUPPLY - q.amount_out);
    // the price after it is (1 + 30) / B: k = 30 * supply is kept, up to the floored coin
    let (num, den) = price(&p);
    let k = VIRTUAL as u128 * SUPPLY as u128;
    assert!(num * den >= k && num * den < k + num);
    assert_eq!(num, 31 * SOL as u128);
    // a sell of half of it is paid from the real SOL and priced with the virtual
    let half = q.amount_out / 2;
    let s = hookpool::math::quote_swap(DIRECTION_SELL, half, p.reserve_base, p.reserve_quote, p.virtual_quote, 0, 0, 0, None, None).unwrap();
    w.env.swap(&t, &w.k, &HookRef::none(), DIRECTION_SELL, half, s.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    assert!(s.amount_out < SOL && s.amount_out > SOL * 4 / 10, "{}", s.amount_out);
    assert_eq!(w.pool().reserve_quote, SOL - s.amount_out_gross);
    assert_vaults(&w.env, &w.k);

    // with the usual fees on, buys and sells match the math to the unit
    w.env.update_platform(hookpool::UpdatePlatformArgs { protocol_fee_bps: Some(PROTOCOL_FEE_BPS), ..Default::default() });
    w.buy(1, 3 * SOL);
    let held = w.held(1);
    w.sell(1, held / 3);
    w.buy(0, 7 * SOL / 10);
    assert_vaults(&w.env, &w.k);
}

// ---- 3. the invariant, walked --------------------------------------------------------------

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

#[test]
fn a_random_walk_of_buys_and_sells_from_several_wallets_never_takes_more_than_the_real_reserve() {
    let (mut w, _) = open(&TOKEN, LP_FEE, 4);
    let mut rng = Rng(7);
    let (mut buys, mut sells) = (0, 0);
    let mut k = VIRTUAL as u128 * SUPPLY as u128;
    for step in 0..300 {
        let i = (rng.next() % 4) as usize;
        let held = w.held(i);
        let quote = w.env.balance(&ata(&w.traders[i].pubkey(), &w.k.quote_mint));
        let before = w.pool();
        if held > 0 && rng.next().is_multiple_of(2) {
            // a sell of a part or all of what the wallet holds
            let amount = if rng.next().is_multiple_of(5) { held } else { rng.range(1, held) };
            match expect_swap_checked(&before, DIRECTION_SELL, amount) {
                Some(q) => {
                    assert!(q.amount_out_gross <= before.reserve_quote, "step {step}: the real reserve is short");
                    w.sell(i, amount);
                    sells += 1;
                }
                None => continue, // too small to pay out anything
            }
        } else if quote > 10_000_000 {
            let amount = rng.range(10_000_000, quote.min(4 * SOL));
            w.buy(i, amount);
            buys += 1;
        }
        let after = w.pool();
        let k2 = (after.reserve_quote as u128 + VIRTUAL as u128) * after.reserve_base as u128;
        assert!(k2 >= k, "step {step}: the product of the effective reserves fell");
        k = k2;
        // every unit of the coin is in the vault or in a trader's wallet
        let outside: u64 = (0..4).map(|j| w.held(j)).sum();
        assert_eq!(outside + w.env.balance(&w.k.base_vault), SUPPLY, "step {step}");
        assert!(after.on_curve());
    }
    assert!(buys > 80 && sells > 80, "{buys} buys, {sells} sells");
    // everyone sells everything they hold: the pool pays every time, and what is left in
    // the real reserve is the pool fees it earned, never less than zero
    for i in 0..4 {
        let held = w.held(i);
        if held > 0 {
            w.sell(i, held);
        }
    }
    let p = assert_vaults(&w.env, &w.k);
    assert_eq!(w.env.balance(&w.k.base_vault), SUPPLY, "every coin came back");
    assert!(p.reserve_quote > 0, "the pool fees stayed");
    println!("walk: {buys} buys, {sells} sells, {} lamports of fees stayed in the reserve", p.reserve_quote);
}

/// The pool's math, or None when the trade is too small to pay anything out.
fn expect_swap_checked(pool: &hookpool::Pool, direction: u8, amount: u64) -> Option<SwapQuote> {
    hookpool::math::quote_swap(direction, amount, pool.reserve_base, pool.reserve_quote, pool.virtual_quote, pool.lp_fee_bps, PROTOCOL_FEE_BPS, 0, None, None).ok()
}

// ---- 4. what create_curve_pool refuses -----------------------------------------------------

#[test]
fn create_curve_pool_refuses_an_open_mint_a_partial_supply_a_curve_hook_and_a_platform_with_the_curve_off() {
    let mut env = Env::new();
    let maker = env.user(100 * SOL);
    let quote = env.create_mint(&maker, 9);
    env.create_ata(&maker, &maker.pubkey(), &quote);
    let none = HookRef::none();

    // a mint that kept its mint authority: more coins could appear later
    let open_mint = env.create_mint(&maker, 6);
    env.create_ata(&maker, &maker.pubkey(), &open_mint);
    env.mint_to(&maker, &open_mint, &ata(&maker.pubkey(), &open_mint), SUPPLY);
    let k = Env::pool_keys(&open_mint, &quote);
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, &none);
    env.err(&[compute_budget_ix(400_000), ix], &[&maker], "whole supply");

    // a closed coin, but not all of it: the pool would hold less than the supply
    let closed = env.closed_coin(&maker, &TOKEN, SUPPLY);
    let k = Env::pool_keys(&closed, &quote);
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY - 1, &none);
    env.err(&[compute_budget_ix(400_000), ix], &[&maker], "whole supply");
    // the whole supply stated, but a part of it is in another wallet: the transfer fails
    let other = env.user(SOL);
    env.create_ata(&other, &other.pubkey(), &closed);
    let send = t22::instruction::transfer_checked(&TOKEN, &ata(&maker.pubkey(), &closed), &closed, &ata(&other.pubkey(), &closed), &maker.pubkey(), &[], 1, 6).unwrap();
    env.ok(&[send], &[&maker]);
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, &none);
    assert!(env.send(&[compute_budget_ix(400_000), ix], &[&maker]).is_err());
    let back = t22::instruction::transfer_checked(&TOKEN, &ata(&other.pubkey(), &closed), &closed, &ata(&maker.pubkey(), &closed), &other.pubkey(), &[], 1, 6).unwrap();
    env.ok(&[back], &[&other]);
    // nothing at all
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, 0, &none);
    env.err(&[compute_budget_ix(400_000), ix], &[&maker], "greater than zero");
    // a fee above the platform's cap
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, MAX_LP_FEE_BPS + 1, SUPPLY, &none);
    env.err(&[compute_budget_ix(400_000), ix], &[&maker], "fee exceeds");

    // a hook that owns the price curve
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL | OVERRIDE_CURVE);
    let hook = env.evil_hook(&maker, &k.pool, &quote, &maker.pubkey(), hook_evil::MODE_SILENT, 0);
    let hook = HookRef { treasury: system_program::ID, ..hook };
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, &hook);
    env.err(&[compute_budget_ix(400_000), ix], &[&maker], "owns the price curve cannot run a curve pool");
    // (the same hook on a seeded pool is taken: the launchpad refuses it, the pool does not)
    env.create_ata(&maker, &maker.pubkey(), &quote);
    env.mint_to(&maker, &quote, &ata(&maker.pubkey(), &quote), 10 * SOL);
    let seeded = env.closed_coin(&maker, &TOKEN, SUPPLY);
    let ks = Env::pool_keys(&seeded, &quote);
    let hook_s = env.evil_hook(&maker, &ks.pool, &quote, &maker.pubkey(), hook_evil::MODE_SILENT, 0);
    let hook_s = HookRef { treasury: system_program::ID, ..hook_s };
    let ix = env.create_pool_ix(&maker.pubkey(), &ks, LP_FEE, SUPPLY, 10 * SOL, &hook_s);
    env.ok(&[compute_budget_ix(400_000), ix], &[&maker]);

    // the platform with the curve off: a virtual quote of 0, or a target of 0
    env.update_platform(hookpool::UpdatePlatformArgs { curve_virtual_quote: Some(0), ..Default::default() });
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, &none);
    env.err(&[compute_budget_ix(400_000), ix], &[&maker], "switched off");
    env.update_platform(hookpool::UpdatePlatformArgs { curve_virtual_quote: Some(VIRTUAL), curve_graduation_target: Some(0), ..Default::default() });
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, &none);
    env.err(&[compute_budget_ix(400_000), ix], &[&maker], "switched off");
    // a pause stops it as it stops every new pool
    env.update_platform(hookpool::UpdatePlatformArgs { curve_graduation_target: Some(TARGET), paused: Some(true), ..Default::default() });
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, &none);
    env.err(&[compute_budget_ix(400_000), ix], &[&maker], "paused");
    env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(false), ..Default::default() });
    // and with everything in order the same coin opens
    let ix = env.create_curve_pool_ix(&maker.pubkey(), &k, LP_FEE, SUPPLY, &none);
    env.ok(&[compute_budget_ix(400_000), ix], &[&maker]);
    assert!(env.pool(&k.pool).on_curve());
    // a seeded pool is not on the curve and cannot graduate
    let p = env.pool(&ks.pool);
    assert_eq!((p.curve_state, p.virtual_quote, p.graduation_target), (CURVE_NONE, 0, 0));
    assert!(!p.on_curve());
    let ix = env.graduate_ix(&ks);
    env.err(&[ix], &[&maker], "not on the curve");
}

// ---- 5. liquidity --------------------------------------------------------------------------

#[test]
fn liquidity_is_refused_while_the_curve_is_open_and_works_after_graduation() {
    let (mut w, _) = open(&TOKEN, LP_FEE, 2);
    let t = w.trader(1);
    w.env.ok(&[Env::create_ata_ix(&t.pubkey(), &t.pubkey(), &w.k.lp_mint)], &[&t]);
    w.buy(1, 5 * SOL);
    let none = HookRef::none();
    // a deposit, and a removal of one share nobody holds: both say why
    let ix = w.env.add_liquidity_ix(&t.pubkey(), &w.k, &none, 1_000_000, u64::MAX, u64::MAX);
    w.env.err(&[ix], &[&t], "liquidity opens at graduation");
    let ix = w.env.remove_liquidity_ix(&t.pubkey(), &w.k, &none, 1, 0, 0);
    w.env.err(&[ix], &[&t], "liquidity opens at graduation");
    // at the target and past it, still refused: liquidity opens at GRADUATION
    w.reach_target();
    let ix = w.env.add_liquidity_ix(&t.pubkey(), &w.k, &none, 1_000_000, u64::MAX, u64::MAX);
    w.env.err(&[ix], &[&t], "liquidity opens at graduation");

    let anyone = w.env.user(SOL);
    w.graduate(&anyone);
    let p = w.pool();
    assert_eq!((p.curve_state, p.virtual_quote), (CURVE_GRADUATED, 0));
    // a deposit in proportion to the real reserves, as on a seeded pool
    let supply = w.env.mint_supply(&w.k.lp_mint);
    let lp = supply / 100;
    let need_base = ((lp as u128 * p.reserve_base as u128).div_ceil(supply as u128)) as u64;
    let need_quote = ((lp as u128 * p.reserve_quote as u128).div_ceil(supply as u128)) as u64;
    assert!(w.held(1) >= need_base, "the trader bought enough to deposit");
    let (b0, q0) = (w.held(1), w.env.balance(&ata(&t.pubkey(), &w.k.quote_mint)));
    let ix = w.env.add_liquidity_ix(&t.pubkey(), &w.k, &none, lp, need_base, need_quote);
    w.env.ok(&[ix], &[&t]);
    assert_eq!(w.env.balance(&ata(&t.pubkey(), &w.k.lp_mint)), lp);
    assert_eq!((b0 - w.held(1), q0 - w.env.balance(&ata(&t.pubkey(), &w.k.quote_mint))), (need_base, need_quote));
    let p2 = assert_vaults(&w.env, &w.k);
    assert_eq!((p2.reserve_base, p2.reserve_quote), (p.reserve_base + need_base, p.reserve_quote + need_quote));
    // and out again: at most what went in; the launch's shares stay locked
    let ix = w.env.remove_liquidity_ix(&t.pubkey(), &w.k, &none, lp, 0, 0);
    w.env.ok(&[ix], &[&t]);
    assert_eq!(w.env.balance(&ata(&t.pubkey(), &w.k.lp_mint)), 0);
    assert!(w.held(1) <= b0 && w.held(1) + 1 >= b0);
    assert_eq!(w.env.balance(&w.k.lp_lock), supply);
    assert_vaults(&w.env, &w.k);
    // trades after graduation follow the plain pool, virtual 0
    w.buy(0, SOL);
    let held = w.held(0);
    w.sell(0, held / 2);
}

// ---- 6. graduation -------------------------------------------------------------------------

#[test]
fn graduate_does_nothing_before_the_target_anyone_graduates_the_pool_at_it_and_the_price_is_kept() {
    let (mut w, _) = open(&TOKEN, LP_FEE, 2);
    let anyone = w.env.user(SOL);
    // below the target it lands and does nothing: on the fresh pool, after a buy, and close to it
    w.graduate_does_nothing(&anyone);
    w.buy(0, 50 * SOL);
    w.graduate_does_nothing(&anyone);
    w.buy(1, 30 * SOL);
    assert!(w.pool().reserve_quote < TARGET && w.pool().reserve_quote > TARGET - 6 * SOL);
    w.graduate_does_nothing(&anyone);
    assert!(w.pool().on_curve());
    // while paused it says so, below the target too: every trade is stopped first anyway
    w.env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(true), ..Default::default() });
    w.graduate_err(&anyone, "paused");
    w.env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(false), ..Default::default() });
    w.reach_target();
    let before = assert_vaults(&w.env, &w.k);
    assert!(before.reserve_quote >= TARGET && before.reserve_quote < TARGET + 25 * SOL);
    let supply_before = w.env.mint_supply(&w.k.base_mint);
    // the pause holds it, as it holds every trade
    w.env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(true), ..Default::default() });
    w.graduate_err(&anyone, "paused");
    w.env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(false), ..Default::default() });

    // any signer: a wallet that never traded
    let meta = w.graduate(&anyone);
    println!("graduate: {} CU", meta.compute_units_consumed);
    let after = assert_vaults(&w.env, &w.k);
    assert_price_kept(&before, &after);
    assert_eq!((after.curve_state, after.virtual_quote, after.graduation_target), (CURVE_GRADUATED, 0, 0));
    assert!(!after.on_curve());
    assert_eq!(after.graduation_fee_bps, 0);
    // the numbers: no fee, the reserve stays, the coins the virtual quote stood for burned
    let g = hookpool::math::graduation(before.reserve_base, before.reserve_quote, before.virtual_quote, before.graduation_target, 0).unwrap();
    assert_eq!(after.reserve_quote, before.reserve_quote);
    assert_eq!(after.reserve_base, g.reserve_base_after);
    assert_eq!(after.protocol_fees_quote, before.protocol_fees_quote);
    assert_eq!(w.env.mint_supply(&w.k.base_mint), supply_before - g.burned_base, "the supply fell by what was burned");
    // 6.8% of the supply at exactly 85 SOL; less when the reserve stands past the target
    // (here close to 100 SOL): the burn is reserve_base * virtual / (reserve_quote + virtual)
    assert_eq!(g.burned_base as u128, before.reserve_base as u128 - (before.reserve_quote as u128 * before.reserve_base as u128) / (before.reserve_quote + VIRTUAL) as u128);
    assert!(g.burned_base > 40_000_000_000_000 && g.burned_base < 70_000_000_000_000, "{}", g.burned_base);
    let e = &cpi_events::<Graduated>(&meta)[0];
    assert_eq!((e.pool, e.reserve_quote_before, e.reserve_quote_after), (w.k.pool, before.reserve_quote, after.reserve_quote));
    assert_eq!((e.reserve_base_before, e.reserve_base_after, e.burned_base, e.fee_quote, e.slot), (before.reserve_base, after.reserve_base, g.burned_base, 0, START_SLOT));
    // nothing else of the pool moved
    assert_eq!((after.swap_count, after.volume_quote_total, after.lp_fee_bps), (before.swap_count, before.volume_quote_total, before.lp_fee_bps));
    assert_eq!(w.env.mint_supply(&w.k.lp_mint), w.env.balance(&w.k.lp_lock));
    // a second time, by anyone: it lands and changes nothing, byte for byte, and emits
    // nothing (a client appends graduate to its trades; a later one must not fail them)
    let raw = w.env.svm.get_account(&w.k.pool).unwrap().data;
    let (supply, vault_b, vault_q) = (w.env.mint_supply(&w.k.base_mint), w.env.balance(&w.k.base_vault), w.env.balance(&w.k.quote_vault));
    let maker = w.maker.insecure_clone();
    for who in [&anyone, &maker] {
        let meta = w.graduate(who);
        assert_eq!(w.env.svm.get_account(&w.k.pool).unwrap().data, raw, "the pool account is the same");
        assert_eq!((w.env.mint_supply(&w.k.base_mint), w.env.balance(&w.k.base_vault), w.env.balance(&w.k.quote_vault)), (supply, vault_b, vault_q));
        assert_eq!(cpi_events::<Graduated>(&meta).len(), 0, "no event");
    }
    // a sell after it pays from the same price
    let held = w.held(1);
    let s = w.sell(1, held / 10);
    let expect_before = (held as u128 / 10) * (before.reserve_quote as u128 + VIRTUAL as u128) / (before.reserve_base as u128 + held as u128 / 10);
    // within a few percent of what the same sell would have paid on the curve before: the
    // fees (0.5%) and the shallower real pool after graduation take the rest
    assert!((s.amount_out as u128) * 100 > expect_before * 96 && (s.amount_out as u128) < expect_before, "{} vs {expect_before}", s.amount_out);
    // and a trade with graduate appended lands on the graduated pool as a plain trade
    let t = w.trader(1);
    let held = w.held(1);
    let p = w.pool();
    let q = expect_swap(&p, DIRECTION_SELL, held / 20, 0, None);
    let sell = w.env.swap_ix(&t.pubkey(), &w.k, &HookRef::none(), DIRECTION_SELL, held / 20, q.amount_out);
    let grad = w.env.graduate_ix(&w.k);
    let meta = w.env.ok(&[sell, grad], &[&t]);
    assert_eq!(cpi_events::<Graduated>(&meta).len(), 0);
    let after = assert_vaults(&w.env, &w.k);
    assert_eq!((after.reserve_base, after.reserve_quote, after.curve_state), (q.reserve_in_after, q.reserve_out_after, CURVE_GRADUATED));
}

#[test]
fn a_graduation_fee_leaves_the_reserve_for_the_platform_and_the_price_is_still_kept() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, 1_760_000_000);
    env.update_platform(hookpool::UpdatePlatformArgs { curve_graduation_fee_bps: Some(700), ..Default::default() });
    let maker = env.user(100 * SOL);
    let k = coin(&mut env, &maker, &TOKEN);
    env.create_curve_pool(&maker, &k, LP_FEE, SUPPLY, &HookRef::none());
    let traders = vec![wallet(&mut env, &maker, &k, 300 * SOL)];
    let mut w = World { env, k, hook: HookRef::none(), maker, traders, donated: (0, 0) };
    assert_eq!(w.pool().graduation_fee_bps, 700);
    w.reach_target();
    let before = w.pool();
    let fees_before = before.protocol_fees_quote;
    let anyone = w.env.user(SOL);
    let meta = w.graduate(&anyone);
    let after = assert_vaults(&w.env, &w.k);
    let fee = TARGET * 700 / 10_000;
    assert_eq!(after.reserve_quote, before.reserve_quote - fee, "7% of the TARGET left the reserve");
    assert_eq!(after.protocol_fees_quote, fees_before + fee, "and waits with the protocol fees");
    assert_price_kept(&before, &after);
    let g = hookpool::math::graduation(before.reserve_base, before.reserve_quote, before.virtual_quote, before.graduation_target, 700).unwrap();
    assert_eq!((after.reserve_base, g.fee_quote), (g.reserve_base_after, fee));
    let e = &cpi_events::<Graduated>(&meta)[0];
    assert_eq!((e.fee_quote, e.burned_base), (fee, g.burned_base));
    // more coins burn than without the fee: the holders keep their price, the pool is shallower
    let no_fee = hookpool::math::graduation(before.reserve_base, before.reserve_quote, before.virtual_quote, before.graduation_target, 0).unwrap();
    assert!(g.burned_base > no_fee.burned_base);
    // the existing collection pays the treasury
    let ix = w.env.collect_ix(&anyone.pubkey(), &w.k);
    w.env.ok(&[ix], &[&anyone]);
    let t = w.env.treasury.pubkey();
    assert_eq!(w.env.balance(&ata(&t, &w.k.quote_mint)), fees_before + fee);
    assert_vaults(&w.env, &w.k);
}

#[test]
fn a_crossing_buy_a_sell_that_takes_the_pool_back_under_and_the_appended_graduate_land_in_one_transaction() {
    let (mut w, _) = open(&TOKEN, LP_FEE, 2);
    let (a, b) = (w.trader(0), w.trader(1));
    // B bought early and holds coins; A brings the pool to about 70 SOL
    w.buy(1, 40 * SOL);
    w.buy(0, 30 * SOL);
    let start = w.pool();
    assert!(start.reserve_quote < TARGET);
    // A's buy crosses the target...
    let qa = expect_swap(&start, DIRECTION_BUY, 20 * SOL, 0, None);
    assert!(qa.reserve_in_after >= TARGET, "the buy crosses the target");
    // ...and B's sell, landing after it in the same transaction, takes the pool back under
    let mid = hookpool::Pool { data: PoolData { reserve_quote: qa.reserve_in_after, reserve_base: qa.reserve_out_after, ..start.data } };
    let held_b = w.held(1);
    let qb = expect_swap(&mid, DIRECTION_SELL, held_b, 0, None);
    assert!(qb.reserve_out_after < TARGET, "the sell takes the pool back under the target");
    let buy_a = w.env.swap_ix(&a.pubkey(), &w.k, &HookRef::none(), DIRECTION_BUY, 20 * SOL, qa.amount_out);
    let sell_b = w.env.swap_ix(&b.pubkey(), &w.k, &HookRef::none(), DIRECTION_SELL, held_b, qb.amount_out);
    let grad = w.env.graduate_ix(&w.k);
    let (supply, ca, qb0) = (w.env.mint_supply(&w.k.base_mint), w.held(0), w.env.balance(&ata(&b.pubkey(), &w.k.quote_mint)));
    // the three instructions in ONE transaction: the graduate at the end lands and does nothing
    let meta = w.env.ok(&[buy_a, sell_b, grad], &[&a, &b]);
    assert_eq!(cpi_events::<Graduated>(&meta).len(), 0, "no graduation");
    assert_eq!(cpi_events::<Swapped>(&meta).len(), 2, "both trades happened");
    let p = assert_vaults(&w.env, &w.k);
    assert!(p.on_curve());
    assert_eq!((p.reserve_base, p.reserve_quote, p.virtual_quote), (qb.reserve_in_after, qb.reserve_out_after, VIRTUAL));
    assert_eq!(w.env.mint_supply(&w.k.base_mint), supply, "nothing was burned");
    assert_eq!(w.held(0), ca + qa.amount_out, "A's buy happened");
    assert_eq!((w.held(1), w.env.balance(&ata(&b.pubkey(), &w.k.quote_mint)) - qb0), (0, qb.amount_out), "B's sell happened");
    // the next crossing buy with graduate appended graduates the pool, at the kept price
    let before = w.pool();
    // the gap back to the target, plus 1% and one SOL for the protocol fee taken from the input
    let crossing = (TARGET - before.reserve_quote) / 100 * 101 + SOL;
    let q = expect_swap(&before, DIRECTION_BUY, crossing, 0, None);
    assert!(q.reserve_in_after >= TARGET, "the buy crosses the target");
    let buy = w.env.swap_ix(&a.pubkey(), &w.k, &HookRef::none(), DIRECTION_BUY, crossing, q.amount_out);
    let grad = w.env.graduate_ix(&w.k);
    let meta = w.env.ok(&[buy, grad], &[&a]);
    assert_eq!(cpi_events::<Graduated>(&meta).len(), 1);
    let crossed = hookpool::Pool { data: PoolData { reserve_quote: q.reserve_in_after, reserve_base: q.reserve_out_after, ..before.data } };
    let after = assert_vaults(&w.env, &w.k);
    assert_eq!(after.curve_state, CURVE_GRADUATED);
    assert_price_kept(&crossed, &after);
}

// ---- 7. between the target and graduation --------------------------------------------------

#[test]
fn trades_past_the_target_still_follow_the_curve_and_graduation_after_them_keeps_the_price() {
    let (mut w, _) = open(&TOKEN, LP_FEE, 3);
    w.reach_target();
    let at_target = w.pool();
    assert!(at_target.on_curve() && at_target.virtual_quote == VIRTUAL);
    // buys and sells keep going, priced with the virtual quote still in (checked in `trade`)
    w.buy(1, 12 * SOL);
    let held = w.held(1);
    w.sell(1, held / 3);
    w.buy(2, 3 * SOL);
    w.sell(0, w.held(0) / 20);
    let before = w.pool();
    assert!(before.reserve_quote > TARGET, "{}", before.reserve_quote);
    assert_eq!(before.virtual_quote, VIRTUAL, "no clipping at the target: the curve runs until graduate is called");
    let anyone = w.env.user(SOL);
    w.graduate(&anyone);
    let after = assert_vaults(&w.env, &w.k);
    assert_price_kept(&before, &after);
    assert_eq!(after.reserve_quote, before.reserve_quote);
    // and from here on the pool is a plain pool
    w.buy(0, SOL);
    let held = w.held(2);
    w.sell(2, held);
    assert_eq!(w.pool().virtual_quote, 0);
}

// ---- 8. the launchpad ----------------------------------------------------------------------

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
            args: hooklaunch::CreateTokenArgs { name: name.into(), symbol: symbol.into(), uri: "https://example.invalid/meta.json".into(), decimals: 6, total_supply: SUPPLY },
        }
        .data(),
    }
}

fn launch_key(k: &PoolKeys) -> Pubkey {
    Pubkey::find_program_address(&[hooklaunch::LAUNCH_SEED, k.base_mint.as_ref()], &hooklaunch::ID).0
}

/// `launch_curve`: the accounts of `launch`, the arguments of the curve.
fn launch_curve_ix(env: &Env, dev: &Pubkey, k: &PoolKeys, hook: &HookRef, args: hooklaunch::LaunchCurveArgs) -> Instruction {
    let mut accounts = hooklaunch::accounts::LaunchPool {
        dev: *dev,
        platform: env.platform,
        treasury: env.treasury.pubkey(),
        launch: launch_key(k),
        base_mint: k.base_mint,
        quote_mint: k.quote_mint,
        pool: k.pool,
        base_vault: k.base_vault,
        quote_vault: k.quote_vault,
        lp_mint: k.lp_mint,
        lp_lock: k.lp_lock,
        dev_base: coins_of(k, dev),
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
        base_token_program: k.base_program,
        quote_token_program: TOKEN,
        token_program: TOKEN,
        associated_token_program: ATA_PROGRAM,
        system_program: system_program::ID,
        event_authority: event_authority_address(&hooklaunch::ID),
        program: hooklaunch::ID,
    }
    .to_account_metas(None);
    accounts.extend(hook.extra.iter().cloned());
    Instruction { program_id: hooklaunch::ID, accounts, data: hooklaunch::instruction::LaunchCurve { args }.data() }
}

/// A dev with SOL and 50 quote, and a fresh quote mint.
fn dev_and_quote(env: &mut Env) -> (Keypair, Keypair, Pubkey) {
    let authority = env.user(10 * SOL);
    let dev = env.user(20 * SOL);
    let quote = env.create_mint(&authority, 9);
    let q = env.create_ata(&dev, &dev.pubkey(), &quote);
    env.mint_to(&authority, &quote, &q, 50 * SOL);
    (authority, dev, quote)
}

#[test]
fn launch_curve_launches_a_plain_coin_with_and_without_a_dev_buy() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, 1_760_000_000);
    let (authority, dev, quote) = dev_and_quote(&mut env);

    // without a dev buy, without a hook
    let mint = Keypair::new();
    env.ok(&[create_token_ix(&dev.pubkey(), &mint.pubkey(), "Curve Coin", "CURVE")], &[&dev, &mint]);
    let k = Env::pool_keys(&mint.pubkey(), &quote);
    let treasury_before = env.lamports(&env.treasury.pubkey());
    let quote_before = env.balance(&ata(&dev.pubkey(), &quote));
    let ix = launch_curve_ix(&env, &dev.pubkey(), &k, &HookRef::none(), hooklaunch::LaunchCurveArgs { lp_fee_bps: LP_FEE, dev_buy_quote: 0, min_dev_buy_out: 0 });
    let budget = compute_budget_ix(400_000);
    let size = env.tx_size(&[budget.clone(), ix.clone()], &dev.pubkey(), 1);
    println!("launch_curve tx size (legacy, no lookup table): {size} bytes");
    assert!(size <= 1232);
    let meta = env.ok(&[budget, ix], &[&dev]);
    println!("launch_curve without a dev buy: {} CU", meta.compute_units_consumed);
    // the fee, and not one unit of quote from the dev
    assert_eq!(env.lamports(&env.treasury.pubkey()), treasury_before + LAUNCH_FEE);
    assert_eq!(env.balance(&ata(&dev.pubkey(), &quote)), quote_before);
    // the pool: on the curve, the whole supply, nothing real
    let p = assert_vaults(&env, &k);
    assert_eq!((p.reserve_base, p.reserve_quote, p.virtual_quote, p.curve_state), (SUPPLY, 0, VIRTUAL, CURVE_OPEN));
    assert_eq!(p.creator, dev.pubkey());
    // every share in the lock account, the dev holds none, and the record says so
    let lp = env.mint_supply(&k.lp_mint);
    assert_eq!(env.balance(&k.lp_lock), lp);
    assert_eq!(env.balance(&ata(&dev.pubkey(), &k.lp_mint)), 0);
    let rec: hooklaunch::Launch = env.account(&launch_key(&k));
    assert_eq!((rec.dev, rec.pool, rec.base_mint, rec.quote_mint), (dev.pubkey(), k.pool, k.base_mint, quote));
    assert_eq!((rec.lp_locked, rec.launch_fee_paid, rec.dev_buy_quote, rec.created_slot), (lp, LAUNCH_FEE, 0, START_SLOT));
    assert_eq!(rec.reserved[0], hooklaunch::LAUNCH_KIND_CURVE, "the mark of a curve launch");
    assert!(rec.reserved[1..].iter().all(|b| *b == 0));
    let raw = env.svm.get_account(&launch_key(&k)).unwrap().data;
    assert_eq!((raw.len(), raw[201]), (265, 1), "Launch.reserved[0] is byte 201");
    let launched = &cpi_events::<hooklaunch::Launched>(&meta)[0];
    assert_eq!((launched.pool, launched.lp_locked, launched.dev_buy_quote), (k.pool, lp, 0));
    assert_eq!(cpi_events::<CurveOpened>(&meta).len(), 1);
    // a second launch of the same coin is impossible
    let ix = launch_curve_ix(&env, &dev.pubkey(), &k, &HookRef::none(), hooklaunch::LaunchCurveArgs { lp_fee_bps: LP_FEE, dev_buy_quote: 0, min_dev_buy_out: 0 });
    assert!(env.send(&[compute_budget_ix(400_000), ix], &[&dev]).is_err());
    // and the public trades it: a buy at the curve price
    let trader = wallet(&mut env, &authority, &k, 20 * SOL);
    let q = expect_swap(&p, DIRECTION_BUY, SOL, 0, None);
    env.swap(&trader, &k, &HookRef::none(), DIRECTION_BUY, SOL, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    assert_eq!(env.pool(&k.pool).reserve_quote, q.reserve_in_after);

    // with a dev buy of 2 quote, through a tax hook (its on_pool_create runs with a quote
    // amount of 0, and the first buy pays its fee)
    let mint = Keypair::new();
    env.ok(&[create_token_ix(&dev.pubkey(), &mint.pubkey(), "Taxed", "TAX")], &[&dev, &mint]);
    let k2 = Env::pool_keys(&mint.pubkey(), &quote);
    let hook = env.tax_hook(&dev, &dev, &k2.pool, &quote, &dev.pubkey(), 300, 300, 500);
    let quote_before = env.balance(&ata(&dev.pubkey(), &quote));
    let ix = launch_curve_ix(&env, &dev.pubkey(), &k2, &hook, hooklaunch::LaunchCurveArgs { lp_fee_bps: LP_FEE, dev_buy_quote: 2 * SOL, min_dev_buy_out: 1 });
    let meta = env.ok(&[compute_budget_ix(400_000), ix], &[&dev]);
    println!("launch_curve with a tax hook and a dev buy: {} CU", meta.compute_units_consumed);
    let p2 = assert_vaults(&env, &k2);
    assert_eq!((p2.swap_count, p2.hook_program, p2.virtual_quote), (1, hook_tax::ID, VIRTUAL));
    assert!(p2.on_curve());
    // the dev paid 2 quote and got the 3% tax of its own buy back into the same account
    let spent = quote_before - env.balance(&ata(&dev.pubkey(), &quote));
    assert!(spent < 2 * SOL && spent > 19 * SOL / 10, "spent {spent}");
    assert!(p2.hook_fees_quote_total > 0);
    // the first buy was priced with the virtual quote: what the dev holds is what the
    // curve gives for 2 quote less the fees, not the whole supply a 0-quote pool would give
    let dev_coins = env.balance(&ata(&dev.pubkey(), &k2.base_mint));
    let fresh = hookpool::Pool { data: PoolData { reserve_base: SUPPLY, reserve_quote: 0, virtual_quote: VIRTUAL, lp_fee_bps: LP_FEE, ..p2.data } };
    let expected = expect_swap(&fresh, DIRECTION_BUY, 2 * SOL, 300, None);
    assert_eq!(dev_coins, expected.amount_out);
    let rec: hooklaunch::Launch = env.account(&launch_key(&k2));
    assert_eq!((rec.dev_buy_quote, rec.hook_program, rec.reserved[0]), (2 * SOL, hook_tax::ID, 1));
    assert_eq!(rec.lp_locked, env.mint_supply(&k2.lp_mint));
    // the seeded launch still records a 0 there
    let mint = Keypair::new();
    env.ok(&[create_token_ix(&dev.pubkey(), &mint.pubkey(), "Seeded", "SEED")], &[&dev, &mint]);
    let k3 = Env::pool_keys(&mint.pubkey(), &quote);
    let mut ix = launch_curve_ix(&env, &dev.pubkey(), &k3, &HookRef::none(), hooklaunch::LaunchCurveArgs { lp_fee_bps: LP_FEE, dev_buy_quote: 0, min_dev_buy_out: 0 });
    ix.data = hooklaunch::instruction::Launch { args: hooklaunch::LaunchArgs { lp_fee_bps: LP_FEE, base_amount: SUPPLY, quote_amount: 5 * SOL, dev_buy_quote: 0, min_dev_buy_out: 0 } }.data();
    env.ok(&[compute_budget_ix(400_000), ix], &[&dev]);
    let rec: hooklaunch::Launch = env.account(&launch_key(&k3));
    assert_eq!(rec.reserved[0], 0);
    assert_eq!(env.pool(&k3.pool).curve_state, CURVE_NONE);
}

/// The coin the way a client creates it through the launchpad: a Token-2022 mint with
/// `hook_program` as its transfer hook, its name written and made final, the supply, no
/// mint authority.
fn create_hooked_token_ixs(dev: &Pubkey, mint: &Pubkey, hook_program: &Pubkey) -> Vec<Instruction> {
    use anchor_spl::token_2022_extensions::spl_pod::optional_keys::OptionalNonZeroPubkey;
    use anchor_spl::token_2022_extensions::spl_token_metadata_interface::instruction as md;
    let (name, symbol, uri) = ("Hooked", "HOOKED", "https://example.invalid/meta.json");
    let metadata_len = (4 + 32 + 32 + 4 + name.len() + 4 + symbol.len() + 4 + uri.len() + 4) as u16;
    let dev_ata = ata_with(dev, mint, &TOKEN_2022);
    vec![
        Instruction {
            program_id: hooklaunch::ID,
            accounts: hooklaunch::accounts::CreatePeggedMint {
                dev: *dev,
                mint: *mint,
                dev_ata,
                hook_program: *hook_program,
                token_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: hooklaunch::instruction::CreatePeggedMint { decimals: 6, metadata_len }.data(),
        },
        md::initialize(&TOKEN_2022, mint, dev, mint, dev, name.into(), symbol.into(), uri.into()),
        md::update_authority(&TOKEN_2022, mint, dev, OptionalNonZeroPubkey::default()),
        Instruction {
            program_id: hooklaunch::ID,
            accounts: hooklaunch::accounts::FinishPeggedToken { dev: *dev, mint: *mint, dev_ata, token_program: TOKEN_2022 }.to_account_metas(None),
            data: hooklaunch::instruction::FinishPeggedToken { total_supply: SUPPLY }.data(),
        },
    ]
}

/// The strict coin's accounts (RULES.md, "The strict coin"), as `tests/tests/strict.rs` builds them.
fn strict_config_ix(payer: &Pubkey, k: &PoolKeys, args: RulesArgs, strict: StrictArgs) -> Instruction {
    let r = RulesKeys::of(k);
    Instruction {
        program_id: hook_rules::ID,
        accounts: hook_rules::accounts::InitStrictConfig {
            payer: *payer,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            cfg: r.cfg,
            hook_authority: r.authority,
            treasury_quote: r.treasury,
            validation: hook_rules::validation_address(&k.base_mint),
            quote_token_program: TOKEN,
            associated_token_program: ATA_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::InitStrictConfig { pool: k.pool, args, strict }.data(),
    }
}

fn open_holder_ix(k: &PoolKeys, owner: &Pubkey) -> Instruction {
    Instruction {
        program_id: hook_rules::ID,
        accounts: hook_rules::accounts::OpenHolder {
            owner: *owner,
            cfg: hook_rules::cfg_address(&k.pool),
            pool: k.pool,
            holder: hook_rules::holder_address(&k.pool, owner),
            owner_base: coins_of(k, owner),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::OpenHolder {}.data(),
    }
}

/// What a swap on a strict coin passes for `user`: the config, both holder records, the
/// account list.
fn strict_hook_for(k: &PoolKeys, user: &Pubkey) -> HookRef {
    HookRef {
        program: hook_rules::ID,
        treasury: RulesKeys::of(k).treasury,
        extra: vec![
            AccountMeta::new(hook_rules::cfg_address(&k.pool), false),
            AccountMeta::new(hook_rules::holder_address(&k.pool, user), false),
            AccountMeta::new(hook_rules::holder_address(&k.pool, &k.pool), false),
            AccountMeta::new_readonly(hook_rules::validation_address(&k.base_mint), false),
        ],
    }
}

#[test]
fn a_strict_coin_launches_on_the_curve_trades_graduates_and_its_hook_still_runs() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, 1_760_000_000);
    let (authority, dev, quote) = dev_and_quote(&mut env);
    let mint = Keypair::new();
    let k = Env::pool_keys_with(&mint.pubkey(), &quote, &TOKEN_2022);
    let args = RulesArgs { buy: Rates { creator_bps: 100, holders_bps: 100, burn_bps: 300 }, sell: Rates { creator_bps: 100, holders_bps: 100, burn_bps: 300 }, ..Default::default() };
    let strict = StrictArgs { max_wallet_bps: 0, max_wallet_slots: 0, early_slots: 0, early_unlock_slots: 0 };
    // transaction 1: the coin with the rules template as its transfer hook, its config, the dev's record
    let mut one = vec![compute_budget_ix(400_000)];
    one.extend(create_hooked_token_ixs(&dev.pubkey(), &mint.pubkey(), &hook_rules::ID));
    one.push(strict_config_ix(&dev.pubkey(), &k, args, strict));
    one.push(open_holder_ix(&k, &dev.pubkey()));
    env.ok(&one, &[&dev, &mint]);
    // transaction 2: the launch on the curve, with a first buy of 1 quote
    let hook = strict_hook_for(&k, &dev.pubkey());
    let ix = launch_curve_ix(&env, &dev.pubkey(), &k, &hook, hooklaunch::LaunchCurveArgs { lp_fee_bps: LP_FEE, dev_buy_quote: SOL, min_dev_buy_out: 1 });
    let meta = env.ok(&[compute_budget_ix(800_000), ix], &[&dev]);
    println!("launch_curve of a strict coin with a dev buy: {} CU", meta.compute_units_consumed);
    let p = assert_vaults(&env, &k);
    assert!(p.on_curve());
    assert_eq!((p.hook_program, p.swap_count, p.base_token_program), (hook_rules::ID, 1, TOKEN_2022));
    assert_eq!(p.reserve_quote + p.protocol_fees_quote + p.hook_fees_quote_total, SOL, "the dev's quote went to the reserve, the protocol and the hook");
    let cfg: hook_rules::RulesConfig = env.account(&hook_rules::cfg_address(&k.pool));
    assert_eq!(cfg.kind, hook_rules::KIND_STRICT);
    let dev_coins = env.balance(&coins_of(&k, &dev.pubkey()));
    assert!(dev_coins > 0);
    let rec: hooklaunch::Launch = env.account(&launch_key(&k));
    assert_eq!(rec.reserved[0], hooklaunch::LAUNCH_KIND_CURVE);

    // a trader buys through the strict hook until the target, at the curve price
    let trader = wallet(&mut env, &authority, &k, 200 * SOL);
    let th = strict_hook_for(&k, &trader.pubkey());
    let fee_bps = 500; // creator + holders + burn
    while env.pool(&k.pool).reserve_quote < TARGET {
        let before = env.pool(&k.pool);
        let q = expect_swap(&before, DIRECTION_BUY, 20 * SOL, fee_bps, None);
        let ix = env.swap_ix(&trader.pubkey(), &k, &th, DIRECTION_BUY, 20 * SOL, q.amount_out);
        env.ok(&[compute_budget_ix(400_000), ix], &[&trader]);
        let after = env.pool(&k.pool);
        assert_eq!((after.reserve_quote, after.reserve_base), (q.reserve_in_after, q.reserve_out_after));
    }
    // graduation burns in the vault: no transfer, so the coin's transfer hook never runs
    let before = assert_vaults(&env, &k);
    let supply = env.mint_supply(&k.base_mint);
    let anyone = env.user(SOL);
    let ix = env.graduate_ix(&k);
    let meta = env.ok(&[ix], &[&anyone]);
    let after = assert_vaults(&env, &k);
    assert_price_kept(&before, &after);
    assert_eq!(env.mint_supply(&k.base_mint), supply - cpi_events::<Graduated>(&meta)[0].burned_base);
    // the wallets' records did not move: the dev still holds what it bought
    assert_eq!(env.balance(&coins_of(&k, &dev.pubkey())), dev_coins);
    // and a sell through the hook works on the graduated pool
    let held = env.balance(&coins_of(&k, &trader.pubkey()));
    let q = expect_swap(&after, DIRECTION_SELL, held / 4, fee_bps, None);
    let ix = env.swap_ix(&trader.pubkey(), &k, &th, DIRECTION_SELL, held / 4, q.amount_out);
    env.ok(&[compute_budget_ix(400_000), ix], &[&trader]);
    let p = assert_vaults(&env, &k);
    assert_eq!((p.reserve_base, p.reserve_quote, p.virtual_quote), (q.reserve_in_after, q.reserve_out_after, 0));
}

#[test]
fn a_pegged_collectible_coin_is_refused_on_the_curve() {
    let mut env = Env::new();
    let (_authority, dev, quote) = dev_and_quote(&mut env);
    // the coin as the collectible template's launch makes it: Token-2022, the collectible
    // program as its transfer hook, a final name, the supply, no mint authority
    let mint = Keypair::new();
    let k = Env::pool_keys_with(&mint.pubkey(), &quote, &TOKEN_2022);
    let mut one = vec![compute_budget_ix(400_000)];
    one.extend(create_hooked_token_ixs(&dev.pubkey(), &mint.pubkey(), &hook_collectible::ID));
    env.ok(&one, &[&dev, &mint]);
    assert_eq!(hooklaunch::COLLECTIBLE_HOOK_ID, hook_collectible::ID);
    let ix = launch_curve_ix(&env, &dev.pubkey(), &k, &HookRef::none(), hooklaunch::LaunchCurveArgs { lp_fee_bps: LP_FEE, dev_buy_quote: 0, min_dev_buy_out: 0 });
    env.err(&[compute_budget_ix(400_000), ix], &[&dev], "pegged coin cannot launch on the curve");
    // nothing was made
    assert!(env.svm.get_account(&k.pool).is_none());
    assert!(env.svm.get_account(&launch_key(&k)).is_none());
}

// ---- 9. the two modules that read prices ---------------------------------------------------

fn execute_buyback_ix(env: &Env, payer: &Pubkey, k: &PoolKeys, min_out: u64) -> Instruction {
    let authority = hook_authority_address(&k.pool, &hook_buyback::ID).0;
    Instruction {
        program_id: hook_buyback::ID,
        accounts: hook_buyback::accounts::ExecuteBuyback {
            payer: *payer,
            cfg: HookRef::cfg(&hook_buyback::ID, &k.pool),
            hook_authority: authority,
            platform: env.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            treasury_quote: ata(&authority, &k.quote_mint),
            authority_base: ata(&authority, &k.base_mint),
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: TOKEN,
            quote_token_program: TOKEN,
            event_authority: event_authority_address(&hook_buyback::ID),
            program: hook_buyback::ID,
        }
        .to_account_metas(None),
        data: hook_buyback::instruction::ExecuteBuyback { min_amount_out: min_out }.data(),
    }
}

fn run_burn_ix(env: &Env, k: &PoolKeys, payer: &Pubkey, min_out: u64) -> Instruction {
    let r = RulesKeys::of(k);
    Instruction {
        program_id: hook_rules::ID,
        accounts: hook_rules::accounts::RunBurn {
            payer: *payer,
            cfg: r.cfg,
            hook_authority: r.authority,
            platform: env.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            treasury_quote: r.treasury,
            authority_base: r.burn_account,
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: k.base_program,
            quote_token_program: TOKEN,
            event_authority: event_authority_address(&hook_rules::ID),
            program: hook_rules::ID,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::RunBurn { min_amount_out: min_out }.data(),
    }
}

/// The 17 bytes of return data of a run: (outcome, quote spent, coins burned).
fn burn_result(meta: &TransactionMetadata) -> (u8, u64, u64) {
    let d = &meta.return_data.data;
    assert_eq!(d.len(), 17);
    (d[0], u64::from_le_bytes(d[1..9].try_into().unwrap()), u64::from_le_bytes(d[9..17].try_into().unwrap()))
}

#[test]
fn the_buyback_observes_effective_reserves_on_a_curve_pool_and_graduation_is_no_runaway() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, 1_760_000_000);
    let maker = env.user(100 * SOL);
    let k = coin(&mut env, &maker, &TOKEN);
    let hook = env.buyback_hook(&maker, &k.pool, &k.base_mint, &k.quote_mint, 200, 200, 0);
    env.create_curve_pool(&maker, &k, LP_FEE, SUPPLY, &hook);
    let trader = wallet(&mut env, &maker, &k, 300 * SOL);
    let anyone = env.user(SOL);
    let cfg = |env: &Env| -> hook_buyback::BuybackConfig { env.account(&HookRef::cfg(&hook_buyback::ID, &k.pool)) };
    let buy = |env: &mut Env, amount: u64| {
        let p = env.pool(&k.pool);
        let q = expect_swap(&p, DIRECTION_BUY, amount, 200, None);
        env.swap(&trader, &k, &hook, DIRECTION_BUY, amount, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
        q
    };
    // cap: sure = 20 + 200 + 200, far above the ceiling of 50 bps; tolerance 1%
    assert_eq!(cfg(&env).cap_bps(PROTOCOL_FEE_BPS, MAX_HOOK_FEE_BPS, LP_FEE), 50);

    // 1 quote in: the real reserve is about 1, the effective about 31
    buy(&mut env, SOL);
    let p = env.pool(&k.pool);
    assert!(p.reserve_quote < SOL && p.reserve_quote > SOL * 9 / 10);
    // the first run observes: the EFFECTIVE pair, not the real one
    let meta = env.ok(&[execute_buyback_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone]);
    assert_eq!(burn_result(&meta).0, BURN_OBSERVED);
    let c = cfg(&env);
    assert_eq!((c.obs_slot, c.obs_reserve_base, c.obs_reserve_quote), (START_SLOT, p.reserve_base, p.reserve_quote + VIRTUAL));
    assert_ne!(c.obs_reserve_quote, p.reserve_quote);

    // a buy of 0.1 quote moves the REAL reserve by a tenth (ten percent: a run reading real
    // reserves would see the price run away) but the effective price by well under 1%
    buy(&mut env, SOL / 10);
    warp(&mut env, START_SLOT + 25);
    let before = env.pool(&k.pool);
    let treasury = env.balance(&hook.treasury);
    let meta = env.ok(&[execute_buyback_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone]);
    let (outcome, spent, burned) = burn_result(&meta);
    assert_eq!(outcome, BURN_BOUGHT, "a tenth more in the real reserve is not a price that ran away");
    // the cap is measured on the effective depth: the whole treasury (about 0.022 quote)
    // is far below 0.5% of about 31 quote, so all of it goes
    let depth = (before.reserve_quote + VIRTUAL).min(c.obs_reserve_quote);
    let cap = (depth as u128 * 50 / 10_000) as u64;
    assert!(treasury < cap, "treasury {treasury}, cap {cap}");
    assert_eq!(spent, treasury);
    assert!(burned > 0);
    let (after, c) = (env.pool(&k.pool), cfg(&env));
    assert_eq!((c.obs_reserve_base, c.obs_reserve_quote), (after.reserve_base, after.reserve_quote + VIRTUAL), "the observation is the effective pool as the buy left it");
    assert_eq!(after.reserve_quote, before.reserve_quote + spent - expect_swap(&before, DIRECTION_BUY, spent, 0, None).protocol_fee);

    // the real reserve doubles, from about 1.1 to about 2.2: with real reserves that would
    // read as a doubled price. With effective ones it is a move of about 7%: the run waits
    // once, records the effective pool, and buys 25 slots later when the price stood
    buy(&mut env, 11 * SOL / 10);
    warp(&mut env, START_SLOT + 50);
    let meta = env.ok(&[execute_buyback_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone]);
    assert_eq!(burn_result(&meta).0, BURN_WAITED);
    let (p, c) = (env.pool(&k.pool), cfg(&env));
    assert_eq!((c.obs_reserve_base, c.obs_reserve_quote), (p.reserve_base, p.reserve_quote + VIRTUAL));
    warp(&mut env, START_SLOT + 75);
    let meta = env.ok(&[execute_buyback_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone]);
    assert_eq!(burn_result(&meta).0, BURN_BOUGHT);

    // to the target. The observation before graduation is the effective pair; graduation
    // keeps the price, so the next run buys instead of waiting for a price that "ran away"
    while env.pool(&k.pool).reserve_quote < TARGET {
        buy(&mut env, 20 * SOL);
    }
    warp(&mut env, START_SLOT + 100);
    let meta = env.ok(&[execute_buyback_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone]);
    assert_eq!(burn_result(&meta).0, BURN_WAITED, "the price ran up with the buys: it waits and records");
    let before = env.pool(&k.pool);
    let c = cfg(&env);
    assert_eq!(c.obs_reserve_quote, before.reserve_quote + VIRTUAL);
    let ix = env.graduate_ix(&k);
    env.ok(&[ix], &[&anyone]);
    let after = env.pool(&k.pool);
    assert_price_kept(&before, &after);
    assert_eq!(after.virtual_quote, 0);
    warp(&mut env, START_SLOT + 125);
    let treasury = env.balance(&hook.treasury);
    let meta = env.ok(&[execute_buyback_ix(&env, &anyone.pubkey(), &k, 0)], &[&anyone]);
    let (outcome, spent, _) = burn_result(&meta);
    assert_eq!(outcome, BURN_BOUGHT, "graduation is not a price that ran away");
    // the depth is now the smaller of the real reserve (the virtual is gone) and the
    // observed effective one: the real reserve after graduation
    let cap = (after.reserve_quote.min(c.obs_reserve_quote) as u128 * 50 / 10_000) as u64;
    assert_eq!(spent, treasury.min(cap));
    assert!(spent > 0);
    let c2 = cfg(&env);
    let p2 = env.pool(&k.pool);
    assert_eq!((c2.obs_reserve_base, c2.obs_reserve_quote), (p2.reserve_base, p2.reserve_quote), "after graduation the effective quote is the real one");
}

#[test]
fn the_rules_burn_observes_effective_reserves_on_a_curve_pool() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, 1_760_000_000);
    let maker = env.user(100 * SOL);
    let k = coin(&mut env, &maker, &TOKEN);
    // a plain coin on the rules template: 5% of every buy and 4% of every sell to the burn pot
    let args = RulesArgs { buy: Rates { creator_bps: 0, holders_bps: 0, burn_bps: 500 }, sell: Rates { creator_bps: 100, holders_bps: 0, burn_bps: 400 }, ..Default::default() };
    let hook = env.rules_hook(&maker, &k, args);
    env.create_curve_pool(&maker, &k, LP_FEE, SUPPLY, &hook);
    let trader = wallet(&mut env, &maker, &k, 300 * SOL);
    let anyone = env.user(SOL);
    let cfg = |env: &Env| -> hook_rules::RulesConfig { env.account(&hook_rules::cfg_address(&k.pool)) };
    let buy = |env: &mut Env, amount: u64| {
        let p = env.pool(&k.pool);
        let q = expect_swap(&p, DIRECTION_BUY, amount, 500, None);
        env.swap(&trader, &k, &hook, DIRECTION_BUY, amount, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
        q
    };
    buy(&mut env, SOL);
    let p = env.pool(&k.pool);
    // the first run observes the effective pair
    let meta = env.ok(&[run_burn_ix(&env, &k, &anyone.pubkey(), 0)], &[&anyone]);
    assert_eq!(burn_result(&meta).0, BURN_OBSERVED);
    let c = cfg(&env);
    assert_eq!((c.obs_reserve_base, c.obs_reserve_quote), (p.reserve_base, p.reserve_quote + VIRTUAL));
    assert!(c.burn_pot > 0);
    // a tenth more in the real reserve: still within the tolerance on the effective price
    buy(&mut env, SOL / 10);
    warp(&mut env, START_SLOT + 25);
    // every fee of a buy goes to the burn pot here (creator and holders at 0), and the run
    // settles the last buy's fee before it decides: the pot is the whole treasury
    let pot = env.balance(&RulesKeys::of(&k).treasury);
    let before = env.pool(&k.pool);
    let meta = env.ok(&[run_burn_ix(&env, &k, &anyone.pubkey(), 0)], &[&anyone]);
    let (outcome, spent, burned) = burn_result(&meta);
    assert_eq!(outcome, BURN_BOUGHT);
    // the pot (about 0.055 quote) is below the cap on the effective depth
    let cap = ((before.reserve_quote + VIRTUAL) as u128 * c.burn_cap_bps(PROTOCOL_FEE_BPS, MAX_HOOK_FEE_BPS, LP_FEE) as u128 / 10_000) as u64;
    assert!(pot < cap);
    assert_eq!(spent, pot);
    assert!(burned > 0);
    let (after, c) = (env.pool(&k.pool), cfg(&env));
    assert_eq!((c.obs_reserve_base, c.obs_reserve_quote), (after.reserve_base, after.reserve_quote + VIRTUAL));
    // the lowering in before_swap compares effective prices: a sell that starts at the
    // observed price (nothing traded since the run) lowers nothing
    let held = env.balance(&coins_of(&k, &trader.pubkey()));
    let q = expect_swap(&after, DIRECTION_SELL, held / 10, 500, None);
    env.swap(&trader, &k, &hook, DIRECTION_SELL, held / 10, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    let c2 = cfg(&env);
    assert_eq!((c2.obs_reserve_base, c2.obs_reserve_quote), (c.obs_reserve_base, c.obs_reserve_quote));
    // the buy after that sell starts BELOW the observed price and lowers it to the
    // effective price it starts at, on the observed depth
    let p = env.pool(&k.pool);
    buy(&mut env, SOL / 100);
    let c3 = cfg(&env);
    let expected = burn_lowered(c2.obs_reserve_base, c2.obs_reserve_quote, p.reserve_base, p.reserve_quote + VIRTUAL).unwrap();
    assert_eq!((c3.obs_reserve_base, c3.obs_reserve_quote), expected);
    assert_eq!(c3.obs_slot, c2.obs_slot);
}

// ---- 10. donations -------------------------------------------------------------------------

#[test]
fn donations_to_the_vaults_change_nothing_and_cannot_be_taken_out() {
    let (mut w, _) = open(&TOKEN, LP_FEE, 2);
    w.buy(0, 2 * SOL);
    w.buy(1, 2 * SOL);
    let before = assert_vaults(&w.env, &w.k);
    // 5 quote straight into the quote vault, and a tenth of a trader's coins into the coin vault
    let maker = w.maker.insecure_clone();
    let gift = w.env.create_ata(&maker, &maker.pubkey(), &w.k.quote_mint);
    w.env.mint_to(&maker, &w.k.quote_mint, &gift, 5 * SOL);
    let send = t22::instruction::transfer_checked(&TOKEN, &gift, &w.k.quote_mint, &w.k.quote_vault, &maker.pubkey(), &[], 5 * SOL, 9).unwrap();
    w.env.ok(&[send], &[&maker]);
    let t = w.trader(1);
    let coins = w.held(1) / 10;
    let send = t22::instruction::transfer_checked(&TOKEN, &coins_of(&w.k, &t.pubkey()), &w.k.base_mint, &w.k.base_vault, &t.pubkey(), &[], coins, 6).unwrap();
    w.env.ok(&[send], &[&t]);
    w.donated = (coins, 5 * SOL);
    // the pool reads its reserves, not its balances: nothing changed in the price
    let p = assert_vaults_with(&w.env, &w.k, w.donated);
    assert_eq!((p.reserve_base, p.reserve_quote, p.virtual_quote), (before.reserve_base, before.reserve_quote, before.virtual_quote));
    // trades are priced and paid as the math says (checked in `trade`), the donation untouched
    let q = w.buy(0, SOL);
    assert_eq!(w.env.balance(&w.k.quote_vault), q.reserve_in_after + w.pool().protocol_fees_quote + 5 * SOL);
    let held = w.held(0);
    w.sell(0, held);
    w.sell(1, w.held(1));
    // every coin outside the pool came back: the real reserve paid every sell and the
    // donated quote is still there, the donated coins are nobody's
    let p = assert_vaults_with(&w.env, &w.k, w.donated);
    assert_eq!(w.env.balance(&w.k.base_vault), SUPPLY, "the whole supply is in the vault again, the donated part outside the reserve");
    assert!(p.reserve_base + p.protocol_fees_base < SUPPLY);
    // graduation burns from the reserve only; the fee collection takes the fees only
    w.reach_target();
    let before = w.pool();
    let anyone = w.env.user(SOL);
    w.graduate(&anyone);
    let after = assert_vaults_with(&w.env, &w.k, w.donated);
    assert_price_kept(&before, &after);
    let ix = w.env.collect_ix(&anyone.pubkey(), &w.k);
    w.env.ok(&[ix], &[&anyone]);
    let p = assert_vaults_with(&w.env, &w.k, w.donated);
    assert_eq!(w.env.balance(&w.k.quote_vault), p.reserve_quote + 5 * SOL);
    // a removal of liquidity after graduation is a share of the reserves, not of the vault
    let t = w.trader(0);
    w.env.ok(&[Env::create_ata_ix(&t.pubkey(), &t.pubkey(), &w.k.lp_mint)], &[&t]);
    w.buy(0, SOL);
    let supply = w.env.mint_supply(&w.k.lp_mint);
    let lp = supply / 1_000;
    let none = HookRef::none();
    let p = w.pool();
    let need_quote = ((lp as u128 * p.reserve_quote as u128).div_ceil(supply as u128)) as u64;
    let ix = w.env.add_liquidity_ix(&t.pubkey(), &w.k, &none, lp, u64::MAX, u64::MAX);
    w.env.ok(&[ix], &[&t]);
    let q0 = w.env.balance(&ata(&t.pubkey(), &w.k.quote_mint));
    let ix = w.env.remove_liquidity_ix(&t.pubkey(), &w.k, &none, lp, 0, 0);
    w.env.ok(&[ix], &[&t]);
    let p = w.pool();
    let got = w.env.balance(&ata(&t.pubkey(), &w.k.quote_mint)) - q0;
    assert!(got <= need_quote, "a share of the reserves, not of the vault: {got} of {need_quote}");
    assert_eq!(w.env.balance(&w.k.quote_vault), p.reserve_quote + p.protocol_fees_quote + 5 * SOL);
    assert_vaults_with(&w.env, &w.k, w.donated);
}

// ---- 11. the hook's own trades -------------------------------------------------------------

#[test]
fn hook_swap_and_hook_buy_burn_use_the_effective_quote_on_a_curve_pool() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, 1_760_000_000);
    env.init_evil_manifest(BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL);
    let maker = env.user(100 * SOL);
    let k = coin(&mut env, &maker, &TOKEN);
    let cfg = HookRef::cfg(&hook_evil::ID, &k.pool);
    let init = Instruction {
        program_id: hook_evil::ID,
        accounts: hook_evil::accounts::InitPoolConfig { payer: maker.pubkey(), cfg, system_program: system_program::ID }.to_account_metas(None),
        data: hook_evil::instruction::InitPoolConfig { pool: k.pool, mode: hook_evil::MODE_SILENT, value: 0 }.data(),
    };
    env.ok(&[init], &[&maker]);
    let hook = HookRef { program: hook_evil::ID, treasury: system_program::ID, extra: vec![AccountMeta::new(cfg, false)] };
    env.create_curve_pool(&maker, &k, LP_FEE, SUPPLY, &hook);
    let (authority, bump) = Pubkey::find_program_address(&[HOOK_AUTHORITY_SEED, k.pool.as_ref()], &hook_evil::ID);
    // the hook's own accounts: 10 quote, no coins
    let hook_quote = env.create_ata(&maker, &authority, &k.quote_mint);
    env.mint_to(&maker, &k.quote_mint, &hook_quote, 10 * SOL);
    env.ok(&[Env::create_ata_ix(&maker.pubkey(), &authority, &k.base_mint)], &[&maker]);
    let hook_base = ata(&authority, &k.base_mint);
    let trader = wallet(&mut env, &maker, &k, 100 * SOL);
    // a trader puts 2 quote in first, so that there is a real reserve to sell into
    let p = env.pool(&k.pool);
    let q = expect_swap(&p, DIRECTION_BUY, 2 * SOL, 0, None);
    env.swap(&trader, &k, &hook, DIRECTION_BUY, 2 * SOL, q.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));

    let swap_as_hook = |env: &Env, direction: u8, amount: u64, min_out: u64| Instruction {
        program_id: hook_evil::ID,
        accounts: hook_evil::accounts::SwapThenBurn {
            hook_authority: authority,
            platform: env.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            hook_base,
            hook_quote,
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: k.base_program,
            quote_token_program: TOKEN,
        }
        .to_account_metas(None),
        data: hook_evil::instruction::SwapAsHook { direction, amount_in: amount, min_amount_out: min_out, authority_bump: bump }.data(),
    };
    let buy_burn = |env: &Env, amount: u64, min_out: u64| Instruction {
        program_id: hook_evil::ID,
        accounts: hook_evil::accounts::BuyBurn {
            hook_authority: authority,
            signer_pool: k.pool,
            platform: env.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            hook_quote,
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: k.base_program,
            quote_token_program: TOKEN,
        }
        .to_account_metas(None),
        data: hook_evil::instruction::BuyBurn { amount_in: amount, min_amount_out: min_out, authority_bump: bump }.data(),
    };

    // hook_swap, a buy: priced with the virtual quote (one unit more than it gives fails)
    let p = assert_vaults(&env, &k);
    let q = expect_swap(&p, DIRECTION_BUY, SOL / 2, 0, None);
    env.err(&[swap_as_hook(&env, DIRECTION_BUY, SOL / 2, q.amount_out + 1)], &[&maker], "Slippage");
    let meta = env.ok(&[swap_as_hook(&env, DIRECTION_BUY, SOL / 2, q.amount_out)], &[&maker]);
    assert_eq!(env.balance(&hook_base), q.amount_out);
    let p = assert_vaults(&env, &k);
    assert_eq!((p.reserve_quote, p.reserve_base), (q.reserve_in_after, q.reserve_out_after));
    let e = &cpi_events::<Swapped>(&meta)[0];
    assert_eq!((e.by_hook, e.reserve_quote, e.amount_out), (true, p.reserve_quote, q.amount_out), "the event carries the real reserve");
    // hook_swap, a sell of all of it: paid from the real reserve, priced with the virtual
    let q = expect_swap(&p, DIRECTION_SELL, q.amount_out, 0, None);
    assert!(q.amount_out_gross <= p.reserve_quote);
    let hq = env.balance(&hook_quote);
    env.ok(&[swap_as_hook(&env, DIRECTION_SELL, env.balance(&hook_base), q.amount_out)], &[&maker]);
    assert_eq!(env.balance(&hook_quote), hq + q.amount_out);
    assert_eq!(env.balance(&hook_base), 0);
    let p = assert_vaults(&env, &k);
    assert_eq!((p.reserve_base, p.reserve_quote), (q.reserve_in_after, q.reserve_out_after));
    // hook_buy_burn: the buy of a hook_swap, the coins burned in the vault
    let supply = env.mint_supply(&k.base_mint);
    let q = expect_swap(&p, DIRECTION_BUY, SOL / 4, 0, None);
    env.err(&[buy_burn(&env, SOL / 4, q.amount_out + 1)], &[&maker], "Slippage");
    let meta = env.ok(&[buy_burn(&env, SOL / 4, q.amount_out)], &[&maker]);
    assert_eq!(meta.return_data.data, q.amount_out.to_le_bytes().to_vec());
    assert_eq!(env.mint_supply(&k.base_mint), supply - q.amount_out);
    let p = assert_vaults(&env, &k);
    assert_eq!((p.reserve_quote, p.reserve_base), (q.reserve_in_after, q.reserve_out_after));
    assert!(p.on_curve());
    // the product of the effective reserves never fell through any of it
    let k_now = (p.reserve_quote as u128 + VIRTUAL as u128) * p.reserve_base as u128;
    assert!(k_now >= VIRTUAL as u128 * SUPPLY as u128);
}

// ---- layouts, numbers, discriminators ------------------------------------------------------

#[test]
fn the_new_fields_sit_in_the_reserved_tails_at_the_documented_offsets() {
    let (mut w, _) = open(&TOKEN, LP_FEE, 1);
    w.env.update_platform(hookpool::UpdatePlatformArgs { curve_graduation_fee_bps: Some(700), ..Default::default() });
    // Pool: 528 bytes; the 24 reserved bytes at 504 are the tail
    let raw = w.env.svm.get_account(&w.k.pool).unwrap().data;
    assert_eq!(raw.len(), 528);
    assert_eq!(u64::from_le_bytes(raw[504..512].try_into().unwrap()), VIRTUAL, "virtual_quote at 504");
    assert_eq!(u64::from_le_bytes(raw[512..520].try_into().unwrap()), TARGET, "graduation_target at 512");
    assert_eq!(u16::from_le_bytes(raw[520..522].try_into().unwrap()), 0, "graduation_fee_bps at 520");
    assert_eq!(raw[522], CURVE_OPEN, "curve_state at 522");
    assert!(raw[523..528].iter().all(|b| *b == 0), "5 reserved bytes");
    // Platform: 451 bytes; the 64 reserved bytes at 387 are the tail
    let raw = w.env.svm.get_account(&w.env.platform).unwrap().data;
    assert_eq!(raw.len(), 451);
    assert_eq!(u64::from_le_bytes(raw[387..395].try_into().unwrap()), VIRTUAL, "curve_virtual_quote at 387");
    assert_eq!(u64::from_le_bytes(raw[395..403].try_into().unwrap()), TARGET, "curve_graduation_target at 395");
    assert_eq!(u16::from_le_bytes(raw[403..405].try_into().unwrap()), 700, "curve_graduation_fee_bps at 403");
    assert!(raw[405..451].iter().all(|b| *b == 0), "46 reserved bytes");
    // the interface reads the same account
    let p: hookpool::Pool = w.env.pool(&w.k.pool);
    assert_eq!(p.data, PoolData::try_from_slice(&raw_pool(&w.env, &w.k.pool)[8..]).unwrap());
    // after graduation the tail reads graduated, 0, 0
    w.reach_target();
    let anyone = w.env.user(SOL);
    w.graduate(&anyone);
    let raw = w.env.svm.get_account(&w.k.pool).unwrap().data;
    assert_eq!((u64::from_le_bytes(raw[504..512].try_into().unwrap()), u64::from_le_bytes(raw[512..520].try_into().unwrap()), raw[522]), (0, 0, CURVE_GRADUATED));

    // the numbers every client needs, printed for the fact sheet and pinned
    let disc = |d: &[u8]| d.to_vec();
    println!("create_curve_pool {:?}", disc(hookpool::instruction::CreateCurvePool::DISCRIMINATOR));
    println!("graduate {:?}", disc(hookpool::instruction::Graduate::DISCRIMINATOR));
    println!("launch_curve {:?}", disc(hooklaunch::instruction::LaunchCurve::DISCRIMINATOR));
    println!("CurveOpened {:?}", disc(CurveOpened::DISCRIMINATOR));
    println!("Graduated {:?}", disc(Graduated::DISCRIMINATOR));
    println!("update_platform {:?}", disc(hookpool::instruction::UpdatePlatform::DISCRIMINATOR));
    use hookpool::errors::HookpoolError as E;
    assert_eq!(u32::from(E::BaseMintFreezable), 6042, "the last error before this round");
    assert_eq!([u32::from(E::CurveDisabled), u32::from(E::CurveSupplyNotInPool), u32::from(E::CurveOpen), u32::from(E::CurveHook), u32::from(E::NotOnCurve), u32::from(E::GraduationNotReached), u32::from(E::CurveRealReserve)], [6043, 6044, 6045, 6046, 6047, 6048, 6049]);
    assert_eq!((u32::from(E::CurvePegged), u32::from(E::CurveSettingsOutOfBounds)), (6050, 6051));
    assert_eq!(hookpool::mints::COLLECTIBLE_HOOK_ID, hook_collectible::ID);
    assert_eq!(u32::from(hooklaunch::LaunchError::CurvePegged), 6011);
    assert_eq!(u32::from(InterfaceError::QuoteOverflow), 6015);
    assert_eq!((CURVE_NONE, CURVE_OPEN, CURVE_GRADUATED), (0, 1, 2));
    assert_eq!(hookpool::HARD_MAX_GRADUATION_FEE_BPS, 1_000);
}

fn raw_pool(env: &Env, pool: &Pubkey) -> Vec<u8> {
    env.svm.get_account(pool).unwrap().data
}
