//! Parity suite: `ProgrammableAmm::quote` against the real programs, with Jupiter's test kit.
//! For every registered swap the kit loads the pool's snapshot, takes the quote, executes
//! the pool's native swap instruction in LiteSVM and requires the token amount that
//! reached the wallet to equal the quote exactly.
//!
//!   bash test.sh                                  run offline against the committed fixtures
//!   RPC=<url> REFRESH=1 bash test.sh              snapshot the pools again from a cluster
//!
//! The fixtures here were snapshotted from the local test validator, where every kind of
//! pool exists. The pool addresses below belong to that chain: `scripts/make-fixtures.mjs`
//! launches the coins again and rewrites them. Before a submission they are regenerated
//! from mainnet pools: change the addresses below and run with `RPC` and `REFRESH`.

use std::sync::atomic::Ordering;

use programmable_jupiter_adapter::state::{self, PlatformState};
use programmable_jupiter_adapter::{HOOK_BUYBACK, HOOK_COLLECTIBLE, HOOK_RULES, HookKind, ProgrammableAmm, caller_address, hook_config_address, math, platform_address, swap_instruction_data};
use jupiter_amm_interface::{
    AccountProvider, Amm, AmmContext, AmmError, AmmLabel, ClockRef, KeyedAccount, Quote, QuoteParams, Swap, SwapAndAccountMetas, SwapMode, SwapParams,
};
use jupiter_amm_test_kit::{PoolSnapshot, PoolTest, assert_pool_parity};
use rust_decimal::Decimal;
use solana_account::ReadableAccount;
use solana_pubkey::{Pubkey, pubkey};

const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

// (pool, coin). All pools are the coin against wrapped SOL.
const NO_HOOK: (Pubkey, Pubkey) = (pubkey!("6GChM8U9DFyZwo13aGYhH6hKNyfD9eCK9gb9ZqNJ8sGT"), pubkey!("2vC5Axm6VuR26XrsiyFcRvYYzfr5QfEDHVh4PgYT4YZY"));
const TAX: (Pubkey, Pubkey) = (pubkey!("HGnrCP2FVQaMFLCwhV2osnmpakRNUUmf4MYtrwbyqFaK"), pubkey!("DLHTze5WionqD9wt8et8kmHSajX7ansg45VAWqGoBxHc"));
const BUYBACK: (Pubkey, Pubkey) = (pubkey!("2DvN6Yvu7XUqZqFsTN6HRdkaC4cT2bzsp6SWiJ6TXofS"), pubkey!("FF2F7g6jf1xMPBxt7LJBU6T6tyY8XgoNEE8DXmWXVhkN"));
/// A taxed pool whose treasury account was closed, snapshotted with a fee already waiting.
const TAX_CLOSED: (Pubkey, Pubkey) = (pubkey!("2ZzXMW1tbQr9fS38JSJUTcctTd8U44ZeR2eYGPsLfZsR"), pubkey!("AkuAQJwPwaBkkiTE22jjMURwAmHxaiEn9QrSWLsjCsvk"));
/// A launch guard whose window is over: the hook is still called and answers nothing.
const GUARD_OVER: (Pubkey, Pubkey) = (pubkey!("7CvB4mXe6LigF3pURvFSvxczmJuhM3LMbDjNWm1TTbnd"), pubkey!("3jn5VKbneVQezESgzMvnCCGi6LoHnobR3Up8UvKGiaSS"));
/// A launch guard snapshotted inside its window: the buy fee depends on the slot.
const GUARD_RUNNING: (Pubkey, Pubkey) = (pubkey!("YJUkwRZAqQUC8ZKWnFS8mvnrv47xQbFeYjk8RJ7MdMX"), pubkey!("6Rc1K6qcBrb9zpNVgCqMtV5ug2C9Aj68Ew7YBAynmwHg"));
/// The collectible hook on a plain SPL coin: called after buys, takes no fee.
const COLLECTIBLE: (Pubkey, Pubkey) = (pubkey!("CVjNXmbwjKwLHFUE4A4Pg5LPSgqK6561GJEMGQsnWRNQ"), pubkey!("2MVbr3Tqy51CE1JaDNPRVA8q13bsbaZntiWEaVq2v6Zs"));
/// The rules template with a creator fee and nothing else: 1 percent on buys and on sells.
const RULES_PLAIN: (Pubkey, Pubkey) = (pubkey!("44kYfCCNqM2hbaxhHaDFQKcRtqH8BbyrQa5cjZK3DB72"), pubkey!("6LwetGgWkYCBhnjY2GXnLYsKSX8bEmeKo17E5QYaqDKH"));
/// The rules template with all three rates, different on each side: buys pay 0.5 + 1 + 0.5
/// percent, sells 1 + 2 + 1.
const RULES_RATES: (Pubkey, Pubkey) = (pubkey!("2zLtH1SKH4P2Pc7RUBH63U3bmKKwSd9pzno2EGGw3Mi9"), pubkey!("Cwayy8B46DfNuezUKyfWfeqUhmTVboGnL2FVais7Xrfm"));
/// A rules coin snapshotted inside its sniper window and its limit window: the buy fee
/// depends on the slot, and no buy may send more than `SNIPER_BUY_LIMIT`.
const RULES_SNIPER: (Pubkey, Pubkey) = (pubkey!("FBjkm3hFDhiFzy716GDgTbzjTNArXX2zkGx9QoSLCFiR"), pubkey!("53bhQmvAhLwhs2HY1nRcWpAFLsxue9nSr7qRT5Mq4vYL"));
/// The buy limit `scripts/make-fixtures.mjs` gives the RULES_SNIPER coin: half a SOL.
const SNIPER_BUY_LIMIT: u64 = 500_000_000;
/// A pegged coin: Token-2022 with the collectible program as its transfer hook. Not routed.
const PEGGED: (Pubkey, Pubkey) = (pubkey!("4X5RZSaTDGFcJctyDN1tJcqB3TBo1rtRXgvYCaQEgFk5"), pubkey!("t8CQX7HdkTeRmCH6NKwpdpb9A5tZToQYVtu5hpfVQWX"));
/// A strict coin: Token-2022 with the rules hook as its transfer hook, a creator fee of 1
/// percent each side and no window. Not routed.
const STRICT: (Pubkey, Pubkey) = (pubkey!("69dQfQncqULE92EF3G2R1R2m5NJM9TKu1rPpmDZ2FvWf"), pubkey!("74qoLtLu6q56fC1T9zcVYpW933pdBkop4f4uqHxbkFFv"));
/// A coin launched on the curve with no first buy: the whole supply in the pool, no real SOL,
/// the platform's 30 virtual SOL in the price.
const CURVE_FRESH: (Pubkey, Pubkey) = (pubkey!("ECrAT5U2F7TwMoMx9pScyLgriRqqw9EJTGN1pQrv83qo"), pubkey!("E3pjY5paNvXdfmHTjQo3LrngQ94RapDNw7VQTeJqss7z"));
/// On the curve after a first buy of 5 SOL by its creator.
const CURVE_OPEN: (Pubkey, Pubkey) = (pubkey!("3vKxjKcDcHeHnNNj8maCuKzKZzFSLuNX4FSHwdjjeYVk"), pubkey!("A4iULX7WAgaMt2XGBwHMG9hFotWcWx6P3b7oNA1eZ2nS"));
/// The rules template on the curve: 1 percent to the creator and 1 percent to the burn on
/// buys, 1 percent to the burn on sells. A first buy of 3 SOL.
const CURVE_RULES: (Pubkey, Pubkey) = (pubkey!("96B2vFKyAiTz7P13xswsyiq5MGKJV4M1yL1sSCu62ydm"), pubkey!("4WKKKBcDDNENnoL9Mg9zYu5Kqekry13bq3rpkoBS5kkv"));
/// Bought past its graduation target, and nobody has sent `graduate`: still on the curve.
const CURVE_PAST: (Pubkey, Pubkey) = (pubkey!("Ht7JXytLv3LfE4PxSSKwnS2NGQxVq5bzp89KPp6XXEVi"), pubkey!("BgDWxxekAvqmmUXQHzky7UMwerbeDg7bLC29wjyVauXU"));
/// Bought past its target with `graduate` in the same transaction: graduated.
const CURVE_GRADUATED: (Pubkey, Pubkey) = (pubkey!("AQg1PD9MDrHYWZtDxszVXSEb5tfdw4KZGehELzddrBMU"), pubkey!("zMRERQfCbenn2n8sEvAcxWrUzbuNm1w7TqjJJGYYUUK"));
/// The platform's curve settings when the fixtures were made: 30 virtual SOL, graduation at
/// 85 real SOL.
const VIRTUAL: u64 = 30_000_000_000;
const TARGET: u64 = 85_000_000_000;

/// The one piece the kit cannot derive from the trait: the pool's native instruction data.
/// The adapter passes the direction in `Swap::Placeholder`; the minimum out is left at
/// zero, since asserting the exact output is the kit's job.
fn encode_swap(swap: &Swap, in_amount: u64) -> Vec<u8> {
    match swap {
        Swap::Placeholder { data: Some(d) } if d.len() == 1 => swap_instruction_data(d[0], in_amount, 0),
        other => panic!("unexpected swap variant: {other:?}"),
    }
}

/// Buys from a thousandth of a SOL to more than the pool holds in SOL, and sells from a
/// thousand coins to a third of the pool. Each runs in a fresh SVM seeded from the snapshot.
fn both_directions((pool, coin): (Pubkey, Pubkey)) -> PoolTest {
    let mut test = PoolTest::new(pool);
    for lamports in [1_000_000u64, 77_777_777, 100_000_000, 1_000_000_000, 3_000_000_000] {
        test = test.add_swap(WSOL, coin, lamports);
    }
    for raw in [1_000_000_000u64, 123_456_789_012, 50_000_000_000_000, 300_000_000_000_000] {
        test = test.add_swap(coin, WSOL, raw);
    }
    test
}

/// The same for a coin with a buy limit: no buy above it, and one buy of exactly the limit.
fn both_directions_under_the_limit((pool, coin): (Pubkey, Pubkey)) -> PoolTest {
    let mut test = PoolTest::new(pool);
    for lamports in [1_000_000u64, 77_777_777, 100_000_000, SNIPER_BUY_LIMIT] {
        test = test.add_swap(WSOL, coin, lamports);
    }
    for raw in [1_000_000_000u64, 123_456_789_012, 50_000_000_000_000, 300_000_000_000_000] {
        test = test.add_swap(coin, WSOL, raw);
    }
    test
}

/// For a pool on the curve that holds a few real SOL: the same buys, and the sells that SOL
/// can pay, from a thousand coins to five percent of the supply, then `largest`, the
/// largest sell the adapter quotes (see `largest_sell`).
fn on_the_curve((pool, coin): (Pubkey, Pubkey), largest: u64) -> PoolTest {
    let mut test = PoolTest::new(pool);
    for lamports in [1_000_000u64, 77_777_777, 100_000_000, 1_000_000_000, 3_000_000_000] {
        test = test.add_swap(WSOL, coin, lamports);
    }
    for raw in [1_000_000_000u64, 123_456_789_012, 50_000_000_000_000, largest] {
        test = test.add_swap(coin, WSOL, raw);
    }
    test
}

/// The largest sell of `coin` the adapter quotes: the sell whose gross output is the whole
/// real SOL of the pool. One unit more would take some of the virtual SOL, which the pool
/// does not hold: the adapter does not quote it.
fn largest_sell(amm: &ProgrammableAmm, coin: Pubkey) -> u64 {
    let (mut lo, mut hi) = (1_000_000_000u64, amm.pool().reserve_base.saturating_mul(4));
    assert!(quote(amm, coin, WSOL, lo).is_ok() && quote(amm, coin, WSOL, hi).is_err(), "a small sell is quoted, a sell of four times the pool is not");
    while lo + 1 < hi {
        let mid = lo + (hi - lo) / 2;
        if quote(amm, coin, WSOL, mid).is_ok() { lo = mid } else { hi = mid }
    }
    lo
}

/// The platform account of a test's snapshot.
fn platform_of(test: &PoolTest) -> PlatformState {
    let snapshot = PoolSnapshot::load_dir(&test.fixtures_dir).expect("fixtures");
    PlatformState::decode(snapshot.get(&platform_address()).expect("platform in snapshot").data()).expect("platform decodes")
}

/// The supply of a mint, from a test's snapshot.
fn supply_of(test: &PoolTest, mint: &Pubkey) -> u64 {
    let snapshot = PoolSnapshot::load_dir(&test.fixtures_dir).expect("fixtures");
    let data = snapshot.get(mint).expect("mint in snapshot").data();
    u64::from_le_bytes(data[36..44].try_into().unwrap())
}

struct Snapshot<'a>(&'a PoolSnapshot);
impl<'a> AccountProvider for Snapshot<'a> {
    fn get(&self, pubkey: &Pubkey) -> Option<impl ReadableAccount + use<'_, 'a>> {
        self.0.get(pubkey).cloned()
    }
}

/// The adapter built and updated from a test's fixtures, the way the kit does it, for the
/// assertions the kit does not make. Snapshots the fixtures first when they are missing.
fn load(test: &PoolTest) -> ProgrammableAmm {
    if std::env::var_os("REFRESH").is_some() || !test.fixtures_dir.exists() {
        let url = std::env::var("RPC").unwrap_or_else(|_| panic!("fixtures {:?} missing: rerun with RPC=<url>", test.fixtures_dir));
        test.regenerate_fixtures::<ProgrammableAmm>(&url).unwrap_or_else(|e| panic!("snapshot fixtures: {e}"));
    }
    let snapshot = PoolSnapshot::load_dir(&test.fixtures_dir).expect("fixtures");
    let context = AmmContext { clock_ref: ClockRef::from(snapshot.clock().unwrap_or_default()) };
    let keyed = KeyedAccount { key: test.pool, account: snapshot.get(&test.pool).expect("pool in snapshot").clone(), params: None };
    let mut amm = ProgrammableAmm::from_keyed_account(&keyed, &context).expect("from_keyed_account");
    // every account the adapter asks for is in the snapshot, or it could not be kept fresh
    for key in amm.get_accounts_to_update() {
        assert!(snapshot.get(&key).is_some(), "account to update {key} is not in the snapshot");
    }
    amm.update(Snapshot(&snapshot)).expect("update");
    amm
}

fn quote(amm: &ProgrammableAmm, input_mint: Pubkey, output_mint: Pubkey, amount: u64) -> Result<Quote, AmmError> {
    amm.quote(&QuoteParams { amount, input_mint, output_mint, swap_mode: SwapMode::ExactIn, fee_mode: Default::default() })
}

/// A routed pool: quotes equal the chain in both directions, and the adapter describes it
/// the way Jupiter needs.
fn assert_routed(pair: (Pubkey, Pubkey), kind: HookKind, extra_accounts: usize) -> ProgrammableAmm {
    let test = both_directions(pair);
    let amm = load(&test);
    assert_eq!(amm.hook_kind(), kind);
    assert!(amm.is_active() && amm.routable(true) && amm.routable(false));
    assert!(!amm.unidirectional());
    assert_eq!(amm.get_reserve_mints(), vec![pair.1, WSOL]);
    assert_eq!(amm.get_accounts_len(), 17 + extra_accounts);
    assert_pool_parity::<ProgrammableAmm>(&test, encode_swap);
    amm
}

/// The swap accounts of a buy, for the assertions on single accounts.
fn buy_metas(amm: &ProgrammableAmm, coin: Pubkey) -> Vec<solana_instruction::AccountMeta> {
    let (user, jupiter) = (Pubkey::new_from_array([50; 32]), Pubkey::new_from_array([53; 32]));
    amm.get_swap_and_account_metas(&SwapParams {
        swap_mode: SwapMode::ExactIn,
        in_amount: 1,
        out_amount: 1,
        source_mint: WSOL,
        destination_mint: coin,
        source_token_account: Pubkey::new_from_array([51; 32]),
        destination_token_account: Pubkey::new_from_array([52; 32]),
        token_transfer_authority: user,
        user,
        payer: user,
        quote_mint_to_referrer: None,
        jupiter_program_id: &jupiter,
        missing_dynamic_accounts_as_default: false,
    })
    .expect("swap accounts")
    .account_metas
}

/// The adapter with a clock that stands far in the future, whatever clock it is given: to
/// it every launch window is over. It is what a quote that ignored the slot would be. The
/// two tests that use it must FAIL inside a window; that they do is the proof that the
/// clock matters and that the chain, not only the adapter, enforces the window.
#[derive(Clone)]
struct ClockIgnored(ProgrammableAmm);
impl Amm for ClockIgnored {
    fn from_keyed_account(keyed_account: &KeyedAccount, _: &AmmContext) -> Result<Self, AmmError> {
        let clock = ClockRef::default();
        clock.slot.store(u64::MAX, Ordering::Relaxed);
        ProgrammableAmm::from_keyed_account(keyed_account, &AmmContext { clock_ref: clock }).map(Self)
    }
    fn label(&self) -> AmmLabel {
        self.0.label()
    }
    fn program_id(&self) -> Pubkey {
        self.0.program_id()
    }
    fn key(&self) -> Pubkey {
        self.0.key()
    }
    fn get_reserve_mints(&self) -> Vec<Pubkey> {
        self.0.get_reserve_mints()
    }
    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        self.0.get_accounts_to_update()
    }
    fn update(&mut self, account_provider: impl AccountProvider) -> Result<(), AmmError> {
        self.0.update(account_provider)
    }
    fn quote(&self, quote_params: &QuoteParams) -> Result<Quote, AmmError> {
        self.0.quote(quote_params)
    }
    fn get_swap_and_account_metas(&self, swap_params: &SwapParams) -> Result<SwapAndAccountMetas, AmmError> {
        self.0.get_swap_and_account_metas(swap_params)
    }
    fn program_dependencies(&self) -> Vec<(Pubkey, String)> {
        self.0.program_dependencies()
    }
    fn get_accounts_len(&self) -> usize {
        self.0.get_accounts_len()
    }
}

/// The adapter, except that where it refuses to quote it answers zero coins out. The kit
/// then sends the swap with a minimum of zero, and only the chain decides. The tests that use
/// it must FAIL inside, with the chain's own error: what the adapter does not quote, the pool
/// refuses.
#[derive(Clone)]
struct QuotesAnyway(ProgrammableAmm);
impl Amm for QuotesAnyway {
    fn from_keyed_account(keyed_account: &KeyedAccount, amm_context: &AmmContext) -> Result<Self, AmmError> {
        ProgrammableAmm::from_keyed_account(keyed_account, amm_context).map(Self)
    }
    fn label(&self) -> AmmLabel {
        self.0.label()
    }
    fn program_id(&self) -> Pubkey {
        self.0.program_id()
    }
    fn key(&self) -> Pubkey {
        self.0.key()
    }
    fn get_reserve_mints(&self) -> Vec<Pubkey> {
        self.0.get_reserve_mints()
    }
    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        self.0.get_accounts_to_update()
    }
    fn update(&mut self, account_provider: impl AccountProvider) -> Result<(), AmmError> {
        self.0.update(account_provider)
    }
    fn quote(&self, quote_params: &QuoteParams) -> Result<Quote, AmmError> {
        Ok(self.0.quote(quote_params).unwrap_or(Quote { in_amount: quote_params.amount, fee_mint: quote_params.input_mint, ..Quote::default() }))
    }
    fn get_swap_and_account_metas(&self, swap_params: &SwapParams) -> Result<SwapAndAccountMetas, AmmError> {
        self.0.get_swap_and_account_metas(swap_params)
    }
    fn program_dependencies(&self) -> Vec<(Pubkey, String)> {
        self.0.program_dependencies()
    }
    fn get_accounts_len(&self) -> usize {
        self.0.get_accounts_len()
    }
}

#[test]
fn a_pool_without_a_hook() {
    let amm = assert_routed(NO_HOOK, HookKind::None, 0);
    // protocol fee 0.2 percent and pool fee 1 percent, nothing else
    assert_eq!(quote(&amm, WSOL, NO_HOOK.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120, 4));
    assert!(amm.program_dependencies().is_empty());
}

#[test]
fn a_taxed_pool() {
    let amm = assert_routed(TAX, HookKind::Tax, 1);
    // the tax of this pool: 3 percent on buys, 5 percent on sells, in SOL
    assert_eq!(quote(&amm, WSOL, TAX.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 300, 4));
    assert_eq!(quote(&amm, TAX.1, WSOL, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 500, 4));
    // this fixture has its treasury, so the swaps above paid the fee out
    let snapshot = PoolSnapshot::load_dir(&both_directions(TAX).fixtures_dir).expect("fixtures");
    assert!(snapshot.get(&amm.pool().hook_quote_treasury).is_some(), "the treasury account is in the snapshot");
}

/// The hook fee of a pool whose treasury account does not exist is not paid out: it waits in
/// the quote vault, outside the reserves, and the pool counts it at offset 464. The trader
/// pays and receives exactly the same, so the quote does not change, and it must be taken
/// from the reserve fields of the pool account, never from the vault balance.
#[test]
fn a_taxed_pool_whose_treasury_is_closed() {
    let amm = assert_routed(TAX_CLOSED, HookKind::Tax, 1);
    assert_eq!(quote(&amm, WSOL, TAX_CLOSED.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 300, 4));
    let snapshot = PoolSnapshot::load_dir(&both_directions(TAX_CLOSED).fixtures_dir).expect("fixtures");
    let pool = amm.pool();
    assert!(snapshot.get(&pool.hook_quote_treasury).is_none(), "the fixture is a pool whose treasury account does not exist");
    let data = snapshot.get(&TAX_CLOSED.0).expect("pool in snapshot").data();
    let owed = u64::from_le_bytes(data[464..472].try_into().unwrap());
    assert!(owed > 0, "a hook fee was already waiting when the snapshot was taken");
    // the vault holds the reserve, the protocol fees owed and the hook fees that wait
    let protocol_fees = u64::from_le_bytes(data[392..400].try_into().unwrap());
    let vault = snapshot.get(&pool.quote_vault).expect("quote vault in snapshot").data();
    let vault_amount = u64::from_le_bytes(vault[64..72].try_into().unwrap());
    assert_eq!(vault_amount, pool.reserve_quote + protocol_fees + owed);
}

#[test]
fn a_buyback_pool() {
    let amm = assert_routed(BUYBACK, HookKind::Buyback, 1);
    assert_eq!(quote(&amm, WSOL, BUYBACK.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 200, 4));
    // The hook keeps the observation of its buyback in the config and lowers it in swaps,
    // so the config goes in writable. The swaps above ran with it; read-only, each would
    // have been stopped by the runtime.
    let metas = buy_metas(&amm, BUYBACK.1);
    assert_eq!((metas[17].pubkey, metas[17].is_writable), (hook_config_address(&HOOK_BUYBACK, &BUYBACK.0), true));
    assert_eq!(metas[12].pubkey, caller_address(&HOOK_BUYBACK), "the caller of the buyback hook, not of any other");
}

#[test]
fn a_rules_pool_with_a_creator_fee() {
    let amm = assert_routed(RULES_PLAIN, HookKind::Rules, 1);
    assert_eq!(amm.program_dependencies(), vec![(HOOK_RULES, "hook_rules".to_string())]);
    // 1 percent to the creator on both sides, on top of the protocol fee and the pool fee
    assert_eq!(quote(&amm, WSOL, RULES_PLAIN.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 100, 4));
    assert_eq!(quote(&amm, RULES_PLAIN.1, WSOL, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 100, 4));
    let metas = buy_metas(&amm, RULES_PLAIN.1);
    assert_eq!((metas[17].pubkey, metas[17].is_writable), (hook_config_address(&HOOK_RULES, &RULES_PLAIN.0), true));
    assert_eq!(metas[12].pubkey, caller_address(&HOOK_RULES));
}

#[test]
fn a_rules_pool_with_all_three_rates() {
    let amm = assert_routed(RULES_RATES, HookKind::Rules, 1);
    // creator, holders and burn are charged as one hook fee, whoever is staked:
    // 0.5 + 1 + 0.5 percent on buys, 1 + 2 + 1 on sells
    assert_eq!(quote(&amm, WSOL, RULES_RATES.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 200, 4));
    assert_eq!(quote(&amm, RULES_RATES.1, WSOL, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 400, 4));
}

/// Inside the sniper window the pool fee of a buy is the sniper's, which falls every slot,
/// and inside the limit window no buy may send more than the limit. The kit runs every
/// swap in the slot of the snapshot, so the quotes must be exact there.
#[test]
fn a_rules_pool_inside_its_sniper_window() {
    let test = both_directions_under_the_limit(RULES_SNIPER);
    let amm = load(&test);
    assert_eq!(amm.hook_kind(), HookKind::Rules);
    assert!(amm.is_active() && amm.routable(true) && amm.routable(false) && !amm.unidirectional());
    assert_pool_parity::<ProgrammableAmm>(&test, encode_swap);
    // the sniper fee replaces the pool fee on buys; sells pay the pool fee. Both pay the creator's 1 percent
    let buy = quote(&amm, WSOL, RULES_SNIPER.1, 100_000_000).unwrap().fee_pct;
    assert!(buy > Decimal::new(120 + 100, 4) && buy <= Decimal::new(20 + 5_000 + 100, 4), "buy fee {buy} is the sniper's");
    assert_eq!(quote(&amm, RULES_SNIPER.1, WSOL, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 100, 4));
    // a buy of exactly the limit was one of the swaps above; a lamport more is an error, not a quote
    assert!(quote(&amm, WSOL, RULES_SNIPER.1, SNIPER_BUY_LIMIT).is_ok());
    assert!(quote(&amm, WSOL, RULES_SNIPER.1, SNIPER_BUY_LIMIT + 1).is_err());
    assert!(quote(&amm, WSOL, RULES_SNIPER.1, 3_000_000_000).is_err());
    assert!(quote(&amm, RULES_SNIPER.1, WSOL, 300_000_000_000_000).is_ok(), "sells are never limited");
    assert!(amm.is_active(), "the pool stays offered: buys up to the limit are quoted");
}

/// The adapter refuses a buy above the limit. So does the chain: with a clock that says the
/// window is over the adapter quotes the buy, the kit sends it in the slot of the snapshot,
/// and the rules hook fails it.
#[test]
#[should_panic(expected = "BuyTooLarge")]
fn the_chain_refuses_the_buy_above_the_limit_that_the_adapter_refuses() {
    let test = PoolTest::new(RULES_SNIPER.0).add_swap(WSOL, RULES_SNIPER.1, SNIPER_BUY_LIMIT + 1);
    assert_pool_parity::<ClockIgnored>(&test, encode_swap);
}

/// And a quote that ignored the slot would be wrong inside the sniper window: the chain
/// pays less than a quote at the pool's own fee.
#[test]
#[should_panic(expected = "does not match the on-chain output delta")]
fn a_quote_that_ignores_the_clock_is_wrong_inside_the_sniper_window() {
    let test = PoolTest::new(RULES_SNIPER.0).add_swap(WSOL, RULES_SNIPER.1, 100_000_000);
    assert_pool_parity::<ClockIgnored>(&test, encode_swap);
}

#[test]
fn a_launch_guard_after_its_window() {
    let amm = assert_routed(GUARD_OVER, HookKind::LaunchGuard, 1);
    assert_eq!(quote(&amm, WSOL, GUARD_OVER.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120, 4));
}

#[test]
fn a_launch_guard_inside_its_window() {
    let amm = assert_routed(GUARD_RUNNING, HookKind::LaunchGuard, 1);
    // the guard replaces the pool fee on buys with a fee that falls every slot; sells pay the pool fee
    let buy = quote(&amm, WSOL, GUARD_RUNNING.1, 1_000_000_000).unwrap().fee_pct;
    assert!(buy > Decimal::new(120, 4) && buy <= Decimal::new(20 + 5_000, 4), "buy fee {buy} is the guard's");
    assert_eq!(quote(&amm, GUARD_RUNNING.1, WSOL, 1_000_000_000).unwrap().fee_pct, Decimal::new(120, 4));
}

#[test]
fn a_collectible_pool_on_a_plain_coin() {
    // the hook is called after every buy; a wallet without a ticket earns nothing and the buy goes through
    let amm = assert_routed(COLLECTIBLE, HookKind::Collectible, 3);
    assert_eq!(amm.program_dependencies(), vec![(HOOK_COLLECTIBLE, "hook_collectible".to_string())]);
    assert_eq!(quote(&amm, WSOL, COLLECTIBLE.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120, 4));
}

#[test]
fn a_pegged_coin_is_not_offered() {
    // its own program runs inside every transfer of the coin; the adapter leaves it out
    let test = PoolTest::new(PEGGED.0).add_swap(WSOL, PEGGED.1, 100_000_000).add_swap(PEGGED.1, WSOL, 1_000_000_000);
    let amm = load(&test);
    assert_eq!(amm.hook_kind(), HookKind::Collectible);
    assert!(!amm.is_active() && !amm.routable(true) && !amm.routable(false));
    assert!(quote(&amm, WSOL, PEGGED.1, 100_000_000).is_err());
    assert!(quote(&amm, PEGGED.1, WSOL, 1_000_000_000).is_err());
}

#[test]
fn a_strict_coin_is_not_offered() {
    // the rules hook runs inside every transfer of the coin, with a holder record per
    // wallet and rules that can refuse a transfer; the adapter leaves it out like a pegged coin
    let test = PoolTest::new(STRICT.0).add_swap(WSOL, STRICT.1, 100_000_000).add_swap(STRICT.1, WSOL, 1_000_000_000);
    let amm = load(&test);
    assert_eq!(amm.hook_kind(), HookKind::Rules);
    assert!(!amm.is_active() && !amm.routable(true) && !amm.routable(false));
    assert!(quote(&amm, WSOL, STRICT.1, 100_000_000).is_err());
    assert!(quote(&amm, STRICT.1, WSOL, 1_000_000_000).is_err());
}

#[test]
fn mints_of_another_pool_and_exact_out_are_refused() {
    let amm = load(&both_directions(NO_HOOK));
    assert!(quote(&amm, WSOL, TAX.1, 1_000_000).is_err());
    assert!(quote(&amm, NO_HOOK.1, NO_HOOK.1, 1_000_000).is_err());
    let exact_out = QuoteParams { amount: 1_000_000, input_mint: WSOL, output_mint: NO_HOOK.1, swap_mode: SwapMode::ExactOut, fee_mode: Default::default() };
    assert!(amm.quote(&exact_out).is_err());
    assert!(quote(&amm, WSOL, NO_HOOK.1, 0).is_err(), "the pool refuses a zero amount");
}

// ---- pools launched on the curve ------------------------------------------------------------

/// The price of a pool on the curve is made of the real SOL and the virtual SOL: a buy pays
/// what it pays on a seeded pool that holds both for real.
fn priced_with_the_virtual_quote(amm: &ProgrammableAmm, coin: Pubkey, protocol_fee_bps: u16) {
    let p = amm.pool();
    let seeded = math::quote_swap(true, 1_000_000, p.reserve_base, p.reserve_quote + p.virtual_quote, 0, p.lp_fee_bps, protocol_fee_bps, 0, None).unwrap();
    let real_only = math::quote_swap(true, 1_000_000, p.reserve_base, p.reserve_quote, 0, p.lp_fee_bps, protocol_fee_bps, 0, None).map(|q| q.amount_out);
    let got = quote(amm, WSOL, coin, 1_000_000).unwrap().out_amount;
    assert_eq!(got, seeded.amount_out, "a buy is priced with real plus virtual SOL");
    assert_ne!(Some(got), real_only, "and not with the real SOL alone");
}

/// Just launched on the curve: the whole supply in the pool and no real SOL. It is offered for
/// buys from its first slot; no sell can be paid yet, so none is quoted.
#[test]
fn a_pool_on_the_curve_with_no_real_sol_yet() {
    let mut test = PoolTest::new(CURVE_FRESH.0);
    for lamports in [1_000_000u64, 77_777_777, 100_000_000, 1_000_000_000, 3_000_000_000] {
        test = test.add_swap(WSOL, CURVE_FRESH.1, lamports);
    }
    let amm = load(&test);
    let p = *amm.pool();
    assert_eq!(amm.hook_kind(), HookKind::None);
    assert!(p.on_curve() && p.reserve_quote == 0 && (p.virtual_quote, p.graduation_target) == (VIRTUAL, TARGET), "a fresh pool on the curve: {p:?}");
    assert_eq!(supply_of(&test, &CURVE_FRESH.1), p.reserve_base, "the pool holds the whole supply");
    assert!(amm.is_active() && amm.routable(true) && !amm.routable(false) && !amm.unidirectional());
    assert_eq!(amm.get_accounts_to_update().len(), 2, "the pool and the platform: the curve needs no account more");
    assert_pool_parity::<ProgrammableAmm>(&test, encode_swap);
    priced_with_the_virtual_quote(&amm, CURVE_FRESH.1, platform_of(&test).protocol_fee_bps);
    assert!(quote(&amm, CURVE_FRESH.1, WSOL, 1_000_000_000).is_err(), "no sell can be paid from no real SOL");
}

/// And the chain refuses such a sell, with its own error: the kit hands the wallet coins that
/// never came out of the pool, which is impossible on chain, and the pool will not pay them
/// from SOL it does not hold.
#[test]
#[should_panic(expected = "CurveRealReserve")]
fn the_chain_refuses_any_sell_on_a_pool_with_no_real_sol() {
    let test = PoolTest::new(CURVE_FRESH.0).add_swap(CURVE_FRESH.1, WSOL, 1_000_000_000);
    assert_pool_parity::<QuotesAnyway>(&test, encode_swap);
}

/// On the curve with a few real SOL: buys and sells are quoted on the curve, a sell is paid
/// from the real SOL, up to all of it.
#[test]
fn a_pool_on_the_curve_after_its_first_buy() {
    let amm = load(&PoolTest::new(CURVE_OPEN.0).add_swap(WSOL, CURVE_OPEN.1, 1_000_000));
    let p = *amm.pool();
    assert!(p.on_curve() && p.reserve_quote > 0 && p.reserve_quote < p.graduation_target && p.virtual_quote == VIRTUAL, "{p:?}");
    assert!(amm.is_active() && amm.routable(true) && amm.routable(false) && !amm.unidirectional());
    let largest = largest_sell(&amm, CURVE_OPEN.1);
    let test = on_the_curve(CURVE_OPEN, largest);
    assert_pool_parity::<ProgrammableAmm>(&test, encode_swap);
    let platform = platform_of(&test);
    priced_with_the_virtual_quote(&amm, CURVE_OPEN.1, platform.protocol_fee_bps);
    assert_eq!(quote(&amm, WSOL, CURVE_OPEN.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120, 4), "the curve adds no fee");
    // the largest sell takes the whole real SOL, gross; the swap above paid it out
    let q = math::quote_swap(false, largest, p.reserve_base, p.reserve_quote, p.virtual_quote, p.lp_fee_bps, platform.protocol_fee_bps, 0, None).unwrap();
    assert_eq!((q.amount_out_gross, q.reserve_out_after), (p.reserve_quote, 0));
    assert!(quote(&amm, CURVE_OPEN.1, WSOL, largest + 1).is_err());
}

/// One unit more than the largest sell: the adapter does not quote it, and the chain refuses
/// it with `CurveRealReserve`.
#[test]
#[should_panic(expected = "CurveRealReserve")]
fn the_chain_refuses_the_sell_past_the_real_sol_that_the_adapter_does_not_quote() {
    let amm = load(&PoolTest::new(CURVE_OPEN.0).add_swap(WSOL, CURVE_OPEN.1, 1_000_000));
    let one_more = largest_sell(&amm, CURVE_OPEN.1) + 1;
    let test = PoolTest::new(CURVE_OPEN.0).add_swap(CURVE_OPEN.1, WSOL, one_more);
    assert_pool_parity::<QuotesAnyway>(&test, encode_swap);
}

/// The rules template on the curve: its fees on top of the curve's price, its config
/// writable, and the hook itself running in every swap against a pool with a virtual quote.
#[test]
fn a_rules_pool_on_the_curve() {
    let amm = load(&PoolTest::new(CURVE_RULES.0).add_swap(WSOL, CURVE_RULES.1, 1_000_000));
    assert_eq!(amm.hook_kind(), HookKind::Rules);
    assert!(amm.pool().on_curve() && amm.pool().reserve_quote > 0);
    assert!(amm.is_active() && amm.routable(true) && amm.routable(false));
    let largest = largest_sell(&amm, CURVE_RULES.1);
    let test = on_the_curve(CURVE_RULES, largest);
    assert_pool_parity::<ProgrammableAmm>(&test, encode_swap);
    // 1 + 1 percent on buys, 1 percent on sells, on top of the protocol fee and the pool fee
    assert_eq!(quote(&amm, WSOL, CURVE_RULES.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 200, 4));
    assert_eq!(quote(&amm, CURVE_RULES.1, WSOL, 1_000_000_000).unwrap().fee_pct, Decimal::new(120 + 100, 4));
    let metas = buy_metas(&amm, CURVE_RULES.1);
    assert_eq!((metas[17].pubkey, metas[17].is_writable), (hook_config_address(&HOOK_RULES, &CURVE_RULES.0), true));
    assert_eq!(metas[12].pubkey, caller_address(&HOOK_RULES));
}

/// Past its graduation target and not graduated: the pool still prices with the virtual SOL
/// and the quote is exact, until somebody's `graduate` lands. The adapter sends none.
#[test]
fn a_pool_past_its_target_that_nobody_graduated() {
    let amm = assert_routed(CURVE_PAST, HookKind::None, 0);
    let p = *amm.pool();
    assert!(p.on_curve() && p.reserve_quote >= p.graduation_target && p.virtual_quote == VIRTUAL, "{p:?}");
    priced_with_the_virtual_quote(&amm, CURVE_PAST.1, platform_of(&both_directions(CURVE_PAST)).protocol_fee_bps);
}

/// Graduated: the virtual SOL is gone, coins were burned to keep the price, and the same pool
/// account trades as an ordinary pool.
#[test]
fn a_graduated_pool() {
    let amm = assert_routed(CURVE_GRADUATED, HookKind::None, 0);
    let p = *amm.pool();
    assert_eq!((p.curve_state, p.virtual_quote, p.graduation_target), (state::CURVE_GRADUATED, 0, 0));
    assert!(!p.on_curve() && p.reserve_quote >= TARGET);
    let test = both_directions(CURVE_GRADUATED);
    assert!(supply_of(&test, &CURVE_GRADUATED.1) < 1_000_000_000_000_000, "graduation burned coins: the supply is below the billion coins launched");
    assert_eq!(quote(&amm, WSOL, CURVE_GRADUATED.1, 1_000_000_000).unwrap().fee_pct, Decimal::new(120, 4));
}
