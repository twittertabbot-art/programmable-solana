//! Launch rules template (RULES.md): one hook, several rules, fixed at launch.
//!
//! Every test runs against the real pool, launchpad and hook binaries. The numbers the
//! program must hold are predicted by `Model`, a second implementation of the accounting
//! written from the specification, and compared after every step. The pool's own math
//! (`expect_swap`) predicts what a trader pays and receives.

use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use hook_rules::{LockRecord, Rates, RulesArgs, RulesConfig, StakeRecord};
use hookpool::math::SwapQuote;
use hookpool_interface::*;
use hookpool_tests::*;
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use std::collections::BTreeMap;

const START_SLOT: u64 = 1_000;
const START_TIME: i64 = 1_760_000_000;
const DAY: i64 = 86_400;
const BASE_LIQ: u64 = 1_000_000_000_000;
const QUOTE_LIQ: u64 = 100 * SOL;
const LP_FEE: u16 = 30;
/// `Env::market` mints 10e12 to the creator and 1e12 to the trader before the pool exists.
const MARKET_SUPPLY: u64 = 11_000_000_000_000;
const ACC: u128 = 1_000_000_000_000;

fn rates(c: u16, h: u16, b: u16) -> Rates {
    Rates { creator_bps: c, holders_bps: h, burn_bps: b }
}

// ---- instructions, built the way a client builds them ---------------------------------

fn stake_ix(k: &PoolKeys, staker: &Pubkey, amount: u64) -> Instruction {
    let r = RulesKeys::of(k);
    Instruction {
        program_id: hook_rules::ID,
        accounts: hook_rules::accounts::Stake {
            staker: *staker,
            cfg: r.cfg,
            pool: k.pool,
            stake: RulesKeys::stake(k, staker),
            base_mint: k.base_mint,
            stake_vault: r.stake_vault,
            staker_base: ata_with(staker, &k.base_mint, &k.base_program),
            base_token_program: k.base_program,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::Stake { amount }.data(),
    }
}

fn unstake_ix(k: &PoolKeys, staker: &Pubkey, amount: u64) -> Instruction {
    let r = RulesKeys::of(k);
    Instruction {
        program_id: hook_rules::ID,
        accounts: hook_rules::accounts::Unstake {
            staker: *staker,
            cfg: r.cfg,
            pool: k.pool,
            stake: RulesKeys::stake(k, staker),
            base_mint: k.base_mint,
            stake_vault: r.stake_vault,
            staker_base: ata_with(staker, &k.base_mint, &k.base_program),
            base_token_program: k.base_program,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::Unstake { amount }.data(),
    }
}

fn claim_rewards_ix(k: &PoolKeys, staker: &Pubkey, to: &Pubkey) -> Instruction {
    let r = RulesKeys::of(k);
    Instruction {
        program_id: hook_rules::ID,
        accounts: hook_rules::accounts::ClaimRewards {
            staker: *staker,
            cfg: r.cfg,
            pool: k.pool,
            stake: RulesKeys::stake(k, staker),
            hook_authority: r.authority,
            quote_mint: k.quote_mint,
            treasury_quote: r.treasury,
            staker_quote: *to,
            quote_token_program: TOKEN,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::ClaimRewards {}.data(),
    }
}

fn claim_creator_ix(k: &PoolKeys, creator: &Pubkey, to: &Pubkey) -> Instruction {
    let r = RulesKeys::of(k);
    Instruction {
        program_id: hook_rules::ID,
        accounts: hook_rules::accounts::ClaimCreator {
            creator: *creator,
            cfg: r.cfg,
            pool: k.pool,
            hook_authority: r.authority,
            quote_mint: k.quote_mint,
            treasury_quote: r.treasury,
            creator_quote: *to,
            quote_token_program: TOKEN,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::ClaimCreator {}.data(),
    }
}

/// `burn_account` is a parameter so a test can try the wrong one.
fn run_burn_with(env: &Env, k: &PoolKeys, payer: &Pubkey, burn_account: &Pubkey, min_out: u64) -> Instruction {
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
            authority_base: *burn_account,
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

fn run_burn_ix(env: &Env, k: &PoolKeys, payer: &Pubkey, min_out: u64) -> Instruction {
    run_burn_with(env, k, payer, &RulesKeys::of(k).burn_account, min_out)
}

fn lock_ix(k: &PoolKeys, creator: &Pubkey, amount: u64, unlock_at: i64) -> Instruction {
    let r = RulesKeys::of(k);
    Instruction {
        program_id: hook_rules::ID,
        accounts: hook_rules::accounts::LockCreator {
            creator: *creator,
            cfg: r.cfg,
            lock: r.lock,
            base_mint: k.base_mint,
            lock_vault: r.lock_vault,
            creator_base: ata_with(creator, &k.base_mint, &k.base_program),
            base_token_program: k.base_program,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::LockCreator { amount, unlock_at }.data(),
    }
}

fn unlock_ix(k: &PoolKeys, creator: &Pubkey) -> Instruction {
    let r = RulesKeys::of(k);
    Instruction {
        program_id: hook_rules::ID,
        accounts: hook_rules::accounts::UnlockCreator {
            creator: *creator,
            cfg: r.cfg,
            lock: r.lock,
            base_mint: k.base_mint,
            lock_vault: r.lock_vault,
            creator_base: ata_with(creator, &k.base_mint, &k.base_program),
            base_token_program: k.base_program,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::UnlockCreator {}.data(),
    }
}

// ---- the launchpad, as in tests/launch.rs ----------------------------------------------

const SUPPLY: u64 = 1_000_000_000_000_000; // 1B at 6 decimals

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
                name: "Rules Coin".into(),
                symbol: "RULE".into(),
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
        hook_quote_treasury: hook.treasury,
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

// ---- the model: the accounting of RULES.md, written a second time ----------------------

#[derive(Clone, Debug, Default, PartialEq)]
struct Staker {
    amount: u64,
    snapshot: u128,
    owed: u64,
    since_slot: u64,
}

/// What a call of `run_burn` that returned Ok did.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Ran {
    /// The first observation of the pool: nothing bought.
    Observed,
    /// The price was above the observation by more than the tolerance: nothing bought.
    Waited,
    Bought { spent: u64, burned: u64, q: SwapQuote },
}

/// What a call of `run_burn` would do, before it is made.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Plan {
    Observe,
    TooSoon,
    Wait,
    Buy(u64),
}

#[derive(Clone, Debug)]
struct Model {
    args: RulesArgs,
    start_slot: u64,
    min_eligible: u64,
    /// The platform's `max_hook_fee_bps` right now.
    cap: u16,
    fees_seen: u64,
    last_split: Rates,
    creator_owed: u64,
    burn_pot: u64,
    acc: u128,
    rem: u64,
    total_staked: u64,
    rewards_owed_total: u64,
    creator_paid: u64,
    rewards_paid: u64,
    quote_burned: u64,
    base_burned: u64,
    burns: u64,
    /// The observation the burn buys against: slot, base reserve, quote reserve. A run of
    /// the burn writes all three; a trade that starts below the observed price lowers the
    /// price the two reserves stand for, and never raises the quote reserve.
    obs_slot: u64,
    obs_base: u64,
    obs_quote: u64,
    stakers: BTreeMap<Pubkey, Staker>,
    // ledgers the program does not keep: where every unit of fee went
    creator_split: u64,
    /// The holders' parts that went to stakers.
    holders_split: u64,
    /// Everything that went to the burn pot, the holders' parts of the line below included.
    burn_split: u64,
    /// The holders' parts that went to the burn pot because too little was staked.
    holders_burned: u64,
    /// Quote sent straight to the treasury by somebody. Promised to nobody.
    donated: u64,
    /// Times a pending reward was rounded down into a record.
    accrues: u64,
}

fn sniper(slot: u64, start: u64, slots: u64, start_fee: u16, lp_fee: u16) -> Option<u16> {
    if slots == 0 || start_fee <= lp_fee {
        return None;
    }
    let elapsed = slot - start;
    if elapsed >= slots {
        return None;
    }
    Some(start_fee - ((start_fee - lp_fee) as u64 * elapsed / slots) as u16)
}

impl Model {
    fn new(args: RulesArgs, start_slot: u64, min_eligible: u64) -> Self {
        Model {
            args,
            start_slot,
            min_eligible,
            cap: MAX_HOOK_FEE_BPS,
            fees_seen: 0,
            last_split: Rates::default(),
            creator_owed: 0,
            burn_pot: 0,
            acc: 0,
            rem: 0,
            total_staked: 0,
            rewards_owed_total: 0,
            creator_paid: 0,
            rewards_paid: 0,
            quote_burned: 0,
            base_burned: 0,
            burns: 0,
            obs_slot: 0,
            obs_base: 0,
            obs_quote: 0,
            stakers: BTreeMap::new(),
            creator_split: 0,
            holders_split: 0,
            burn_split: 0,
            holders_burned: 0,
            donated: 0,
            accrues: 0,
        }
    }

    /// Step 3 of "How the money moves".
    fn settle(&mut self, fees_total: u64) {
        let fresh = fees_total - self.fees_seen;
        if fresh == 0 {
            return;
        }
        self.fees_seen = fees_total;
        let (c, h, b) = (self.last_split.creator_bps as u128, self.last_split.holders_bps as u128, self.last_split.burn_bps as u128);
        let t = c + h + b;
        assert!(t > 0, "a fee was charged while no rate was answered");
        let creator = (fresh as u128 * c / t) as u64;
        let mut holders = (fresh as u128 * h / t) as u64;
        let mut burn = fresh - creator - holders;
        if holders > 0 {
            if self.eligible() {
                let num = holders as u128 * ACC + self.rem as u128;
                self.acc += num / self.total_staked as u128;
                self.rem = (num % self.total_staked as u128) as u64;
            } else {
                // too little is staked: the holders' share is burned instead
                self.holders_burned += holders;
                burn += holders;
                holders = 0;
            }
        }
        self.creator_owed += creator;
        self.burn_pot += burn;
        self.creator_split += creator;
        self.holders_split += holders;
        self.burn_split += burn;
    }

    /// Do stakers get the holders' share of a trade made now?
    fn eligible(&self) -> bool {
        self.total_staked > 0 && self.total_staked >= self.min_eligible
    }

    fn pending(&self, s: &Staker) -> u64 {
        (s.amount as u128 * (self.acc - s.snapshot) / ACC) as u64
    }

    fn accrue(&mut self, who: &Pubkey) {
        let acc = self.acc;
        let s = self.stakers.get(who).cloned().unwrap_or_default();
        let pending = self.pending(&s);
        if acc > s.snapshot && s.amount > 0 {
            self.accrues += 1;
        }
        let s = self.stakers.entry(*who).or_default();
        s.owed += pending;
        s.snapshot = acc;
        self.rewards_owed_total += pending;
    }

    /// A trade always pays the three rates of its side, whoever is staked.
    fn side(&self, is_buy: bool) -> Rates {
        if is_buy {
            self.args.buy
        } else {
            self.args.sell
        }
    }

    /// What `before_swap` answers and what the pool then does. Err = the words the
    /// failure must contain.
    fn swap(&mut self, pool: &hookpool::Pool, direction: u8, amount: u64, slot: u64) -> Result<SwapQuote, &'static str> {
        self.settle(pool.hook_fees_quote_total);
        let is_buy = direction == DIRECTION_BUY;
        if is_buy && self.args.max_buy_quote > 0 && slot - self.start_slot < self.args.limit_slots && amount > self.args.max_buy_quote {
            return Err("buy above the limit of the launch window");
        }
        let charged = self.side(is_buy);
        self.last_split = charged;
        // a trade that starts below the burn's observation lowers the observed price to
        // the price it starts at. The observed depth is never raised, and the slot stays.
        if self.obs_base != 0 && self.obs_quote != 0 && (pool.reserve_quote as u128 * self.obs_base as u128) < (self.obs_quote as u128 * pool.reserve_base as u128) {
            let quote = pool.reserve_quote.min(self.obs_quote);
            // the base that goes with that quote at the pool's price, rounded up
            let (num, den) = (quote as u128 * pool.reserve_base as u128, pool.reserve_quote as u128);
            self.obs_base = (num / den + (num % den != 0) as u128) as u64;
            self.obs_quote = quote;
        }
        let hook_bps = (charged.creator_bps + charged.holders_bps + charged.burn_bps).min(self.cap);
        let over = if is_buy {
            sniper(slot, self.start_slot, self.args.sniper_slots, self.args.sniper_start_fee_bps, pool.lp_fee_bps)
        } else {
            None
        };
        hookpool::math::quote_swap(direction, amount, pool.reserve_base, pool.reserve_quote, pool.virtual_quote, pool.lp_fee_bps, PROTOCOL_FEE_BPS, hook_bps, over, None)
            .map_err(|_| "")
    }

    fn stake(&mut self, who: &Pubkey, amount: u64, slot: u64, fees_total: u64) -> Result<(), &'static str> {
        if amount == 0 {
            return Err("amount must be greater than zero");
        }
        self.settle(fees_total);
        self.accrue(who);
        let s = self.stakers.get_mut(who).unwrap();
        s.amount += amount;
        s.since_slot = slot;
        self.total_staked += amount;
        Ok(())
    }

    fn unstake(&mut self, who: &Pubkey, amount: u64, slot: u64, fees_total: u64) -> Result<(), &'static str> {
        // the record is looked up before the instruction runs
        let Some(s) = self.stakers.get(who) else { return Err("AccountNotInitialized") };
        if amount == 0 {
            return Err("amount must be greater than zero");
        }
        if slot < s.since_slot + hook_rules::UNSTAKE_DELAY_SLOTS {
            return Err("unstake is not open yet");
        }
        if amount > s.amount {
            return Err("more than this record has staked");
        }
        self.settle(fees_total);
        self.accrue(who);
        self.stakers.get_mut(who).unwrap().amount -= amount;
        self.total_staked -= amount;
        Ok(())
    }

    fn claim_rewards(&mut self, who: &Pubkey, fees_total: u64) -> Result<u64, &'static str> {
        if !self.stakers.contains_key(who) {
            return Err("AccountNotInitialized");
        }
        self.settle(fees_total);
        self.accrue(who);
        let s = self.stakers.get_mut(who).unwrap();
        let amount = s.owed;
        if amount == 0 {
            return Err("nothing to claim");
        }
        s.owed = 0;
        self.rewards_owed_total -= amount;
        self.rewards_paid += amount;
        Ok(amount)
    }

    fn claim_creator(&mut self, fees_total: u64) -> Result<u64, &'static str> {
        self.settle(fees_total);
        let amount = self.creator_owed;
        if amount == 0 {
            return Err("nothing to claim");
        }
        self.creator_owed = 0;
        self.creator_paid += amount;
        Ok(amount)
    }

    /// The part of a side's hook fee that nobody gets back, in bps: the burn share of what
    /// the pool really charges, which is the three rates together under the platform's cap.
    fn burn_charged(&self, r: &Rates) -> u64 {
        let total = (r.creator_bps + r.holders_bps + r.burn_bps) as u64;
        if total == 0 {
            return 0;
        }
        total.min(self.cap as u64) * r.burn_bps as u64 / total
    }

    /// The share of the quote reserve one run may spend, in bps, between 1 and 50. "sure":
    /// what a position of any size pays in full and never sees again, the protocol fee of
    /// its buy and the burn share of both trades. "soft": what a position much larger
    /// than the pool mostly gets back, the protocol fee of the sell and the pool fee twice.
    /// A quarter of sure + min(sure, soft).
    fn burn_cap_bps(&self, lp_fee_bps: u16) -> u64 {
        let sure = PROTOCOL_FEE_BPS as u64 + self.burn_charged(&self.args.buy) + self.burn_charged(&self.args.sell);
        let soft = PROTOCOL_FEE_BPS as u64 + 2 * lp_fee_bps as u64;
        ((sure + soft.min(sure)) / 4).clamp(1, 50)
    }

    /// What a call would do in this slot on this pool: the observation rule.
    fn burn_plan(&self, pool: &hookpool::Pool, slot: u64) -> Plan {
        if self.obs_base == 0 || self.obs_quote == 0 {
            return Plan::Observe;
        }
        if slot < self.obs_slot + BURN_INTERVAL_SLOTS {
            return Plan::TooSoon;
        }
        let cap_bps = self.burn_cap_bps(pool.lp_fee_bps) as u128;
        // the price now against the observed price plus twice the cap
        let now = (pool.reserve_quote as u128 * self.obs_base as u128).checked_mul(10_000).expect("test reserves fit");
        let then = (self.obs_quote as u128 * pool.reserve_base as u128).checked_mul(10_000 + 2 * cap_bps).expect("test reserves fit");
        if now > then {
            return Plan::Wait;
        }
        let depth = pool.reserve_quote.min(self.obs_quote) as u128;
        Plan::Buy(((depth * cap_bps / 10_000) as u64).max(1))
    }

    /// The most a run that buys would spend on this pool now, whatever the pot holds.
    fn burn_cap(&self, pool: &hookpool::Pool) -> u64 {
        let depth = if self.obs_quote == 0 { pool.reserve_quote } else { pool.reserve_quote.min(self.obs_quote) };
        ((depth as u128 * self.burn_cap_bps(pool.lp_fee_bps) as u128 / 10_000) as u64).max(1)
    }

    /// One call of `run_burn`. `loose` = coins already in the burn account.
    fn run_burn(&mut self, pool: &hookpool::Pool, loose: u64, slot: u64) -> Result<Ran, &'static str> {
        self.settle(pool.hook_fees_quote_total);
        if self.burn_pot == 0 {
            return Err("the burn pot is empty");
        }
        let ran = match self.burn_plan(pool, slot) {
            Plan::TooSoon => return Err("observation of the pool is less than 25 slots old"),
            Plan::Observe => {
                (self.obs_base, self.obs_quote) = (pool.reserve_base, pool.reserve_quote);
                Ran::Observed
            }
            Plan::Wait => {
                (self.obs_base, self.obs_quote) = (pool.reserve_base, pool.reserve_quote);
                Ran::Waited
            }
            Plan::Buy(max_spend) => {
                let spent = self.burn_pot.min(max_spend);
                let q = hookpool::math::quote_swap(DIRECTION_BUY, spent, pool.reserve_base, pool.reserve_quote, pool.virtual_quote, pool.lp_fee_bps, PROTOCOL_FEE_BPS, 0, None, None)
                    .map_err(|_| "")?;
                self.burn_pot -= spent;
                self.quote_burned += spent;
                self.base_burned += q.amount_out + loose;
                self.burns += 1;
                (self.obs_base, self.obs_quote) = (q.reserve_out_after, q.reserve_in_after);
                Ran::Bought { spent, burned: q.amount_out + loose, q }
            }
        };
        self.obs_slot = slot;
        Ok(ran)
    }
}

// ---- a pool with the hook, and the checks made after every step ------------------------

struct World {
    env: Env,
    m: Market,
    k: PoolKeys,
    hook: HookRef,
    r: RulesKeys,
    /// The bytes of the config that nothing may ever change again (everything up to and
    /// including `min_eligible`).
    rules: Vec<u8>,
}

fn rule_bytes(env: &Env, cfg: &Pubkey) -> Vec<u8> {
    env.svm.get_account(cfg).unwrap().data[..240].to_vec()
}

fn world_with(args: RulesArgs, lp_fee: u16) -> World {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.rules_hook(&m.creator, &k, args);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, lp_fee, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    let r = RulesKeys::of(&k);
    let rules = rule_bytes(&env, &r.cfg);
    World { env, m, k, hook, r, rules }
}

fn world(args: RulesArgs) -> (World, Model) {
    let w = world_with(args, LP_FEE);
    let cfg: RulesConfig = w.env.account(&w.r.cfg);
    assert_eq!(cfg.start_slot, START_SLOT);
    assert_eq!(cfg.start_time, START_TIME);
    assert_eq!(cfg.min_eligible, MARKET_SUPPLY / 1_000, "0.1% of the supply when the pool was created");
    let md = Model::new(args, START_SLOT, cfg.min_eligible);
    check(&w, &md);
    (w, md)
}

fn cfg_of(w: &World) -> RulesConfig {
    w.env.account(&w.r.cfg)
}

/// Exact accounting and solvency. Called after every step of every scenario.
fn check(w: &World, md: &Model) {
    let cfg = cfg_of(w);
    let pool = w.env.pool(&w.k.pool);
    assert_eq!(rule_bytes(&w.env, &w.r.cfg), w.rules, "a rule changed after init_pool_config");
    assert_eq!(pool.hook_fees_owed_quote, 0, "the treasury exists, so the pool owes nothing");

    assert_eq!(cfg.fees_seen, md.fees_seen, "fees_seen");
    assert_eq!(cfg.last_split, md.last_split, "last_split");
    assert_eq!(cfg.creator_owed, md.creator_owed, "creator_owed");
    assert_eq!(cfg.burn_pot, md.burn_pot, "burn_pot");
    assert_eq!(cfg.acc_per_share, md.acc, "acc_per_share");
    assert_eq!(cfg.reward_rem, md.rem, "reward_rem");
    assert_eq!(cfg.total_staked, md.total_staked, "total_staked");
    assert_eq!(cfg.rewards_owed_total, md.rewards_owed_total, "rewards_owed_total");
    assert_eq!(cfg.total_creator_paid, md.creator_paid, "total_creator_paid");
    assert_eq!(cfg.total_rewards_paid, md.rewards_paid, "total_rewards_paid");
    assert_eq!(cfg.total_quote_burned, md.quote_burned, "total_quote_burned");
    assert_eq!(cfg.total_base_burned, md.base_burned, "total_base_burned");
    assert_eq!(cfg.burns, md.burns, "burns");
    assert_eq!((cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote), (md.obs_slot, md.obs_base, md.obs_quote), "the burn's observation");
    assert!(cfg.reserved.iter().all(|b| *b == 0));

    // every staker's record, and what each could claim right now
    let (mut staked, mut owed, mut pending) = (0u64, 0u64, 0u64);
    for (who, s) in &md.stakers {
        let rec: StakeRecord = w.env.account(&RulesKeys::stake(&w.k, who));
        assert_eq!((rec.pool, rec.staker), (w.k.pool, *who));
        assert_eq!(rec.amount, s.amount, "stake amount of {who}");
        assert_eq!(rec.acc_snapshot, s.snapshot, "snapshot of {who}");
        assert_eq!(rec.owed, s.owed, "owed of {who}");
        assert_eq!(rec.since_slot, s.since_slot, "since_slot of {who}");
        assert!(rec.acc_snapshot <= cfg.acc_per_share);
        staked += rec.amount;
        owed += rec.owed;
        pending += (rec.amount as u128 * (cfg.acc_per_share - rec.acc_snapshot) / ACC) as u64;
    }
    assert_eq!(staked, cfg.total_staked, "the records add up to total_staked");
    assert_eq!(owed, cfg.rewards_owed_total, "the records add up to rewards_owed_total");
    assert_eq!(w.env.balance(&w.r.stake_vault), cfg.total_staked, "the stake vault holds exactly what is staked");

    // where every unit of fee went
    assert_eq!(md.creator_split + md.holders_split + md.burn_split, cfg.fees_seen);
    assert_eq!(cfg.creator_owed + cfg.total_creator_paid, md.creator_split);
    assert_eq!(cfg.burn_pot + cfg.total_quote_burned, md.burn_split);

    // the treasury: everything the pool charged came in, only the three payouts went out
    let treasury = w.env.balance(&w.r.treasury);
    assert_eq!(
        treasury,
        pool.hook_fees_quote_total + md.donated - cfg.total_creator_paid - cfg.total_rewards_paid - cfg.total_quote_burned,
        "treasury ledger"
    );
    // solvency: every promise is covered, with the fee of the last trade still unsplit
    let unsettled = pool.hook_fees_quote_total - cfg.fees_seen;
    let promised = cfg.creator_owed + cfg.burn_pot + cfg.rewards_owed_total + pending + unsettled;
    assert!(treasury >= promised + md.donated, "INSOLVENT: treasury {treasury} < promised {promised} + donated {}", md.donated);
    // and rounding keeps only dust: under one unit per rounding, plus the carried remainder
    let dust = treasury - promised - md.donated;
    assert_eq!(dust, md.holders_split - cfg.total_rewards_paid - cfg.rewards_owed_total - pending);
    let bound = md.accrues + md.stakers.len() as u64 + (cfg.reward_rem as u128 / ACC) as u64 + 1;
    assert!(dust <= bound, "rounding kept {dust}, more than {bound}");
}

fn must<T>(r: Result<T, &'static str>) -> T {
    r.unwrap_or_else(|e| panic!("the model refuses this step: {e:?}"))
}

/// One swap. The model predicts it first; the transaction is sent with the predicted
/// output as its minimum, so one unit less would fail.
fn try_trade(w: &mut World, md: &mut Model, who: &Keypair, direction: u8, amount: u64) -> Result<SwapQuote, &'static str> {
    let user = who.pubkey();
    let pool = w.env.pool(&w.k.pool);
    let slot = w.env.clock().slot;
    let mut next = md.clone();
    let plan = next.swap(&pool, direction, amount, slot);
    let base_acc = ata_with(&user, &w.k.base_mint, &w.k.base_program);
    let quote_acc = ata(&user, &w.k.quote_mint);
    let (b0, q0, t0) = (w.env.balance(&base_acc), w.env.balance(&quote_acc), w.env.balance(&w.r.treasury));
    match plan {
        Err(needle) => {
            let ix = w.env.swap_ix(&user, &w.k, &w.hook, direction, amount, 0);
            w.env.err(&[ix], &[who], needle);
            Err(needle)
        }
        Ok(q) => {
            let ix = w.env.swap_ix(&user, &w.k, &w.hook, direction, amount, q.amount_out);
            w.env.ok(&[ix], &[who]);
            let (b1, q1, t1) = (w.env.balance(&base_acc), w.env.balance(&quote_acc), w.env.balance(&w.r.treasury));
            if direction == DIRECTION_BUY {
                assert_eq!((q0 - q1, b1 - b0), (amount, q.amount_out), "a buy");
            } else {
                assert_eq!((b0 - b1, q1 - q0), (amount, q.amount_out), "a sell");
            }
            assert_eq!(t1 - t0, q.hook_fee, "the treasury received the hook fee of this trade");
            let after = w.env.pool(&w.k.pool);
            assert_eq!(after.hook_fees_quote_total, pool.hook_fees_quote_total + q.hook_fee);
            *md = next;
            check(w, md);
            Ok(q)
        }
    }
}

fn trade(w: &mut World, md: &mut Model, who: &Keypair, direction: u8, amount: u64) -> SwapQuote {
    must(try_trade(w, md, who, direction, amount))
}

fn fees_total(w: &World) -> u64 {
    w.env.pool(&w.k.pool).hook_fees_quote_total
}

fn try_stake(w: &mut World, md: &mut Model, who: &Keypair, amount: u64) -> Result<(), &'static str> {
    let user = who.pubkey();
    let mut next = md.clone();
    let plan = next.stake(&user, amount, w.env.clock().slot, fees_total(w));
    let acc = ata_with(&user, &w.k.base_mint, &w.k.base_program);
    let before = w.env.balance(&acc);
    let ix = stake_ix(&w.k, &user, amount);
    match plan {
        Err(needle) => {
            w.env.err(&[ix], &[who], needle);
            Err(needle)
        }
        Ok(()) => {
            w.env.ok(&[ix], &[who]);
            assert_eq!(before - w.env.balance(&acc), amount);
            *md = next;
            check(w, md);
            Ok(())
        }
    }
}

fn stake(w: &mut World, md: &mut Model, who: &Keypair, amount: u64) {
    must(try_stake(w, md, who, amount))
}

fn try_unstake(w: &mut World, md: &mut Model, who: &Keypair, amount: u64) -> Result<(), &'static str> {
    let user = who.pubkey();
    let mut next = md.clone();
    let plan = next.unstake(&user, amount, w.env.clock().slot, fees_total(w));
    let acc = ata_with(&user, &w.k.base_mint, &w.k.base_program);
    let before = w.env.balance(&acc);
    let ix = unstake_ix(&w.k, &user, amount);
    match plan {
        Err(needle) => {
            w.env.err(&[ix], &[who], needle);
            Err(needle)
        }
        Ok(()) => {
            w.env.ok(&[ix], &[who]);
            assert_eq!(w.env.balance(&acc) - before, amount);
            *md = next;
            check(w, md);
            Ok(())
        }
    }
}

fn try_claim_rewards(w: &mut World, md: &mut Model, who: &Keypair) -> Result<u64, &'static str> {
    let user = who.pubkey();
    let mut next = md.clone();
    let plan = next.claim_rewards(&user, fees_total(w));
    let to = ata(&user, &w.k.quote_mint);
    let before = w.env.balance(&to);
    let ix = claim_rewards_ix(&w.k, &user, &to);
    match plan {
        Err(needle) => {
            w.env.err(&[ix], &[who], needle);
            Err(needle)
        }
        Ok(amount) => {
            w.env.ok(&[ix], &[who]);
            assert_eq!(w.env.balance(&to) - before, amount, "rewards paid");
            *md = next;
            check(w, md);
            Ok(amount)
        }
    }
}

fn try_claim_creator(w: &mut World, md: &mut Model) -> Result<u64, &'static str> {
    let creator = w.m.creator.insecure_clone();
    let mut next = md.clone();
    let plan = next.claim_creator(fees_total(w));
    let to = ata(&creator.pubkey(), &w.k.quote_mint);
    let before = w.env.balance(&to);
    let ix = claim_creator_ix(&w.k, &creator.pubkey(), &to);
    match plan {
        Err(needle) => {
            w.env.err(&[ix], &[&creator], needle);
            Err(needle)
        }
        Ok(amount) => {
            w.env.ok(&[ix], &[&creator]);
            assert_eq!(w.env.balance(&to) - before, amount, "creator fee paid");
            *md = next;
            check(w, md);
            Ok(amount)
        }
    }
}

/// One call of `run_burn`, predicted by the model first. Checks what the call says about
/// itself (its return data) and what it did.
fn try_run_burn(w: &mut World, md: &mut Model, who: &Keypair) -> Result<Ran, &'static str> {
    let pool = w.env.pool(&w.k.pool);
    let loose = w.env.balance(&w.r.burn_account);
    let mut next = md.clone();
    let plan = next.run_burn(&pool, loose, w.env.clock().slot);
    let supply = w.env.mint_supply(&w.k.base_mint);
    let treasury = w.env.balance(&w.r.treasury);
    match plan {
        Err(needle) => {
            let ix = run_burn_ix(&w.env, &w.k, &who.pubkey(), 0);
            w.env.err(&[ix], &[who], needle);
            Err(needle)
        }
        Ok(ran) => {
            let min_out = match ran {
                Ran::Bought { q, .. } => q.amount_out,
                // a call that does not buy ignores the minimum
                _ => u64::MAX,
            };
            let ix = run_burn_ix(&w.env, &w.k, &who.pubkey(), min_out);
            let meta = w.env.ok(&[ix], &[who]);
            let (outcome, spent, burned) = match ran {
                Ran::Observed => (BURN_OBSERVED, 0, 0),
                Ran::Waited => (BURN_WAITED, 0, 0),
                Ran::Bought { spent, burned, .. } => (BURN_BOUGHT, spent, burned),
            };
            // the return data: outcome, quote spent, coins burned
            let mut said = vec![outcome];
            said.extend_from_slice(&spent.to_le_bytes());
            said.extend_from_slice(&burned.to_le_bytes());
            assert_eq!(meta.return_data.data, said, "return data of run_burn");
            assert_eq!(meta.return_data.program_id.to_bytes(), hook_rules::ID.to_bytes());
            // and the event says the same, with the observation the call left
            let e = &cpi_events::<hook_rules::BurnExecuted>(&meta)[0];
            assert_eq!((e.outcome, e.quote_spent, e.base_burned), (outcome, spent, burned));
            assert_eq!((e.obs_reserve_base, e.obs_reserve_quote, e.slot), (next.obs_base, next.obs_quote, next.obs_slot));
            assert_eq!(supply - w.env.mint_supply(&w.k.base_mint), burned, "the supply fell by what was bought");
            assert_eq!(treasury - w.env.balance(&w.r.treasury), spent, "the treasury paid the run");
            let after = w.env.pool(&w.k.pool);
            assert_eq!(after.hook_fees_quote_total, pool.hook_fees_quote_total, "a burn pays no hook fee");
            match ran {
                Ran::Bought { q, .. } => {
                    assert_eq!(w.env.balance(&w.r.burn_account), 0, "nothing stays in the burn account");
                    assert_eq!((after.reserve_quote, after.reserve_base), (q.reserve_in_after, q.reserve_out_after));
                }
                _ => assert_eq!((after.reserve_quote, after.reserve_base, after.swap_count), (pool.reserve_quote, pool.reserve_base, pool.swap_count), "nothing was bought"),
            }
            *md = next;
            check(w, md);
            Ok(ran)
        }
    }
}

/// Call the burn until it buys, one interval apart: the first call of a pool only takes
/// the observation, and a call that finds the price above its observation takes a new
/// one. Returns `(quote spent, coins burned)` of the buy.
fn burn_next(w: &mut World, md: &mut Model, who: &Keypair) -> (u64, u64) {
    for _ in 0..6 {
        let pool = w.env.pool(&w.k.pool);
        if md.burn_plan(&pool, w.env.clock().slot) == Plan::TooSoon {
            let slot = md.obs_slot + BURN_INTERVAL_SLOTS;
            go(w, slot);
        }
        if let Ran::Bought { spent, burned, .. } = must(try_run_burn(w, md, who)) {
            return (spent, burned);
        }
    }
    panic!("the burn did not get to buy");
}

/// Run the burn until the pot is empty, a slice of the reserve per run and one interval
/// between runs. Returns how many buys it took.
fn burn_all(w: &mut World, md: &mut Model, who: &Keypair) -> u32 {
    let mut runs = 0;
    while md.burn_pot > 0 {
        let pot = pot_now(w, md);
        let (spent, _) = burn_next(w, md, who);
        assert!(spent <= pot);
        runs += 1;
        assert!(runs < 10_000);
    }
    runs
}

fn go(w: &mut World, slot: u64) {
    let t = w.env.clock().unix_timestamp;
    w.env.set_clock(slot, t);
}

/// A wallet with both token accounts, some of the coin and some quote.
fn wallet(w: &mut World, base: u64, quote: u64) -> Keypair {
    let u = w.env.user(10 * SOL);
    w.env.fund(&u, &w.m.authority, &w.k.base_mint, &w.k.quote_mint, base, quote);
    u
}

fn hook_units(meta: &TransactionMetadata) -> Vec<u64> {
    let head = format!("Program {} consumed ", hook_rules::ID);
    meta.logs
        .iter()
        .filter_map(|l| l.strip_prefix(&head))
        .map(|rest| rest.split(' ').next().unwrap().parse().unwrap())
        .collect()
}

// ---- 1. bounds --------------------------------------------------------------------------

#[test]
fn every_bound_is_refused_one_above_and_accepted_at_the_limit() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let creator = m.creator.insecure_clone();
    // every attempt is for a coin of its own, so an accepted config never blocks the next
    let attempt = |env: &mut Env, args: RulesArgs| {
        let base = env.create_mint(&m.authority, 6);
        let k = Env::pool_keys(&base, &m.quote_mint);
        let ix = Env::rules_config_ix(&creator.pubkey(), &k, args);
        (k, env.send(&[compute_budget_ix(400_000), ix], &[&creator]))
    };
    let refused = |env: &mut Env, args: RulesArgs, needle: &str| {
        let (_, res) = attempt(env, args);
        match res {
            Ok(_) => panic!("{args:?} was accepted, expected {needle:?}"),
            Err(e) => {
                let hay = e.meta.logs.join("\n");
                assert!(hay.contains(needle), "expected {needle:?} in:\n{hay}");
            }
        }
    };
    let none = RulesArgs::default();
    let with = |f: &dyn Fn(&mut RulesArgs)| {
        let mut a = none;
        f(&mut a);
        a
    };

    // each rate, on each side
    refused(&mut env, with(&|a| a.buy = rates(501, 0, 0)), "creator fee above the maximum");
    refused(&mut env, with(&|a| a.sell = rates(501, 0, 0)), "creator fee above the maximum");
    refused(&mut env, with(&|a| a.buy = rates(0, 501, 0)), "holder rewards above the maximum");
    refused(&mut env, with(&|a| a.sell = rates(0, 501, 0)), "holder rewards above the maximum");
    refused(&mut env, with(&|a| a.buy = rates(0, 0, 501)), "burn rate above the maximum");
    refused(&mut env, with(&|a| a.sell = rates(0, 0, 501)), "burn rate above the maximum");
    // the three together
    refused(&mut env, with(&|a| a.buy = rates(500, 500, 1)), "together are above the maximum");
    refused(&mut env, with(&|a| a.sell = rates(334, 333, 334)), "together are above the maximum");
    // sniper fee
    refused(&mut env, with(&|a| (a.sniper_slots, a.sniper_start_fee_bps) = (100, 5_001)), "sniper start fee above the maximum");
    refused(&mut env, with(&|a| (a.sniper_slots, a.sniper_start_fee_bps) = (10_801, 3_000)), "sniper window too long");
    refused(&mut env, with(&|a| (a.sniper_slots, a.sniper_start_fee_bps) = (100, 0)), "needs both a window and a start fee");
    refused(&mut env, with(&|a| (a.sniper_slots, a.sniper_start_fee_bps) = (0, 3_000)), "needs both a window and a start fee");
    // buy limit
    refused(&mut env, with(&|a| (a.max_buy_quote, a.limit_slots) = (SOL, 9_001)), "buy limit window too long");
    refused(&mut env, with(&|a| (a.max_buy_quote, a.limit_slots) = (SOL, 0)), "needs both an amount and a window");
    refused(&mut env, with(&|a| (a.max_buy_quote, a.limit_slots) = (0, 100)), "needs both an amount and a window");
    // creator lock
    refused(&mut env, with(&|a| a.creator_lock_seconds = 365 * 86_400 + 1), "creator lock longer than the maximum");

    // at every limit at once
    let limit = RulesArgs {
        sniper_slots: 10_800,
        sniper_start_fee_bps: 5_000,
        buy: rates(500, 500, 0),
        sell: rates(0, 500, 500),
        max_buy_quote: u64::MAX,
        limit_slots: 9_000,
        creator_lock_seconds: 365 * 86_400,
    };
    let (k, res) = attempt(&mut env, limit);
    res.unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    let cfg: RulesConfig = env.account(&hook_rules::cfg_address(&k.pool));
    assert_eq!(
        (cfg.sniper_slots, cfg.sniper_start_fee_bps, cfg.buy, cfg.sell, cfg.max_buy_quote, cfg.limit_slots, cfg.creator_lock_seconds),
        (10_800, 5_000, rates(500, 500, 0), rates(0, 500, 500), u64::MAX, 9_000, 365 * 86_400)
    );
    assert_eq!((cfg.pool, cfg.base_mint, cfg.quote_mint, cfg.creator), (k.pool, k.base_mint, k.quote_mint, creator.pubkey()));
    let r = RulesKeys::of(&k);
    assert_eq!(cfg.treasury, r.treasury);
    assert_eq!(cfg.treasury, hook_rules::treasury_address(&k.pool, &k.quote_mint, &TOKEN));
    assert_eq!(r.burn_account, hook_rules::burn_account_address(&k.pool, &k.base_mint, &TOKEN));
    assert_eq!((cfg.start_slot, cfg.start_time, cfg.min_eligible), (0, 0, 0), "nothing starts before the pool exists");
    // the treasury and the burn account belong to the authority, the stake vault to the
    // config: the pool's hook_swap spends only from accounts of the authority
    for (acc, owner) in [(r.treasury, r.authority), (r.burn_account, r.authority), (r.stake_vault, r.cfg)] {
        let a = env.svm.get_account(&acc).expect("created by init_pool_config");
        assert_eq!(a.owner, TOKEN);
        assert_eq!(Pubkey::new_from_array(a.data[32..64].try_into().unwrap()), owner);
    }
    assert_ne!(r.authority, r.cfg);
    // each rate alone at its ceiling, and the other shapes of a side that adds up to the cap
    for args in [
        with(&|a| a.buy = rates(500, 0, 0)),
        with(&|a| a.sell = rates(0, 500, 0)),
        with(&|a| a.buy = rates(0, 0, 500)),
        with(&|a| a.sell = rates(500, 0, 500)),
        with(&|a| a.buy = rates(333, 333, 334)),
        with(&|a| (a.sniper_slots, a.sniper_start_fee_bps) = (1, 1)),
        with(&|a| (a.max_buy_quote, a.limit_slots) = (1, 1)),
        none,
    ] {
        let (_, res) = attempt(&mut env, args);
        res.unwrap_or_else(|e| panic!("{args:?}\n{}", e.meta.pretty_logs()));
    }

    // the pool address must be the one of the two mints: here the address of another
    // coin's pool, with the mints of this coin
    let base = env.create_mint(&m.authority, 6);
    let other = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let mut ix = Env::rules_config_ix(&creator.pubkey(), &other, none);
    let wrong = hook_rules::accounts::InitPoolConfig {
        payer: creator.pubkey(),
        cfg: hook_rules::cfg_address(&other.pool),
        hook_authority: hook_rules::authority_address(&other.pool),
        base_mint: base,
        quote_mint: m.quote_mint,
        treasury_quote: ata(&hook_rules::authority_address(&other.pool), &m.quote_mint),
        authority_base: ata(&hook_rules::authority_address(&other.pool), &base),
        stake_vault: hook_rules::stake_vault_address(&other.pool),
        base_token_program: TOKEN,
        quote_token_program: TOKEN,
        associated_token_program: ATA_PROGRAM,
        system_program: system_program::ID,
    };
    ix.accounts = wrong.to_account_metas(None);
    env.err(&[compute_budget_ix(400_000), ix], &[&creator], "config does not belong to this pool");
}

// ---- 2. a launch through the launchpad, and the split to the lamport --------------------

struct Launched {
    env: Env,
    m: Market,
    dev: Keypair,
    k: PoolKeys,
    hook: HookRef,
}

/// Transaction 1 of a launch: the coin and its rules.
fn launch_step_one(args: RulesArgs) -> Launched {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let dev = env.user(20 * SOL);
    env.fund(&dev, &m.authority, &m.base_mint, &m.quote_mint, 0, 500 * SOL);
    let mint = Keypair::new();
    let k = Env::pool_keys(&mint.pubkey(), &m.quote_mint);
    let ixs = [
        compute_budget_ix(400_000),
        create_token_ix(&dev.pubkey(), &mint.pubkey()),
        Env::rules_config_ix(&dev.pubkey(), &k, args),
    ];
    let size = env.tx_size(&ixs, &dev.pubkey(), 2);
    println!("launch transaction 1 (coin + rules), legacy, no lookup table: {size} bytes");
    assert!(size <= 1232);
    let meta = env.ok(&ixs, &[&dev, &mint]);
    println!("launch transaction 1 (coin + rules) used {} CU", meta.compute_units_consumed);
    let hook = Env::rules_ref(&k);
    Launched { env, m, dev, k, hook }
}

#[test]
fn a_launch_charges_the_first_buy_and_splits_every_fee_to_the_lamport() {
    let args = RulesArgs {
        sniper_slots: 200,
        sniper_start_fee_bps: 4_000,
        buy: rates(100, 200, 50),
        sell: rates(150, 100, 250),
        max_buy_quote: 3 * SOL,
        limit_slots: 100,
        creator_lock_seconds: 30 * 86_400,
    };
    let Launched { mut env, m, dev, k, hook } = launch_step_one(args);
    let r = RulesKeys::of(&k);
    let d = dev.pubkey();

    // transaction 2: the launch with a first buy, and the lock of what it bought
    let (quote_liq, dev_buy) = (10 * SOL, 2 * SOL);
    // the first buy pays all three rates of a buy, 3.5%, and the full sniper fee
    let first = hookpool::math::quote_swap(DIRECTION_BUY, dev_buy, SUPPLY, quote_liq, 0, LP_FEE, PROTOCOL_FEE_BPS, 350, Some(4_000), None).unwrap();
    let unlock_at = START_TIME + 30 * DAY;
    let ixs = [
        compute_budget_ix(400_000),
        launch_ix(&env, &d, &k, &hook, hooklaunch::LaunchArgs { lp_fee_bps: LP_FEE, base_amount: SUPPLY, quote_amount: quote_liq, dev_buy_quote: dev_buy, min_dev_buy_out: first.amount_out }),
        // u64::MAX: whatever the first buy bought. The client does not have to know the
        // amount to the unit; the test knows it and checks it below.
        lock_ix(&k, &d, hook_rules::LOCK_WHOLE_BALANCE, unlock_at),
    ];
    let size = env.tx_size(&ixs, &d, 1);
    println!("launch transaction 2 (launch + first buy + creator lock), legacy, no lookup table: {size} bytes");
    assert!(size <= 1232, "launch must fit one legacy transaction");
    let meta = env.ok(&ixs, &[&dev]);
    println!("launch transaction 2 (launch + first buy + creator lock) used {} CU, the hook {:?}", meta.compute_units_consumed, hook_units(&meta));

    let pool = env.pool(&k.pool);
    assert_eq!(pool.hook_program, hook_rules::ID);
    assert_eq!(pool.hook_kind, HOOK_KIND_PLATFORM);
    assert_eq!(pool.hook_flags, hook_rules::FLAGS);
    assert_eq!(pool.hook_flags, BEFORE_SWAP | BEFORE_ADD_LIQ | ON_POOL_CREATE | OVERRIDE_FEE | TAKE_HOOK_FEE | CALL_ON_BUY | CALL_ON_SELL);
    assert_eq!(pool.hook_flags, 13_125);
    assert_eq!(pool.hook_quote_treasury, r.treasury);
    assert_eq!(pool.hook_treasury_owner, r.authority);
    assert_eq!(pool.swap_count, 1);
    assert_eq!(pool.hook_fees_quote_total, first.hook_fee);
    assert_eq!((pool.reserve_quote, pool.reserve_base), (first.reserve_in_after, first.reserve_out_after));
    assert_eq!(first.fee_bps_applied, 4_000, "the launcher's first buy pays the sniper fee like any buy");
    // the launch's own liquidity came in through create_pool, in the first slot of the
    // sniper window, where nobody may ADD liquidity: all of it is in the lock account
    assert_eq!(env.balance(&k.lp_lock), env.mint_supply(&k.lp_mint));

    let cfg: RulesConfig = env.account(&r.cfg);
    assert_eq!((cfg.start_slot, cfg.start_time), (START_SLOT, START_TIME));
    assert_eq!(cfg.min_eligible, SUPPLY / 1_000);
    assert_eq!(cfg.creator, d);
    assert_eq!(cfg.last_split, rates(100, 200, 50), "the rates the first buy was charged");
    assert_eq!(cfg.fees_seen, 0, "its fee is split the next time the program runs");
    assert_eq!(env.balance(&r.treasury), first.hook_fee);

    // the lock: exactly what the first buy bought, never loose in the launcher's wallet
    let lock: LockRecord = env.account(&r.lock);
    assert_eq!((lock.pool, lock.amount, lock.unlock_at), (k.pool, first.amount_out, unlock_at));
    assert_eq!(env.balance(&r.lock_vault), first.amount_out);
    assert_eq!(env.balance(&ata(&d, &k.base_mint)), 0);
    env.err(&[unlock_ix(&k, &d)], &[&dev], "the creator lock is not over yet");

    // from here on the model follows every step
    let rules = rule_bytes(&env, &r.cfg);
    let mut w = World { env, m, k, hook, r, rules };
    let mut md = Model::new(args, START_SLOT, SUPPLY / 1_000);
    md.last_split = rates(100, 200, 50);
    check(&w, &md);
    let t = w.m.trader.insecure_clone();
    w.env.create_ata(&t, &t.pubkey(), &w.k.base_mint);
    let anyone = w.env.user(SOL);

    // a buy above the limit, still inside the window
    assert_eq!(try_trade(&mut w, &mut md, &t, DIRECTION_BUY, 3 * SOL + 1).err(), Some("buy above the limit of the launch window"));
    // slot 50 of 200: the sniper fee is at 4000 - (4000 - 30) * 50 / 200 = 3008
    go(&mut w, START_SLOT + 50);
    let q1 = trade(&mut w, &mut md, &t, DIRECTION_BUY, 3 * SOL);
    assert_eq!(q1.fee_bps_applied, 3_008);
    // that buy settled the launcher's first buy, 350 bps split 100 : 200 : 50. Nobody is
    // staked, so the holders' 200 went to the burn pot with the burn's 50.
    assert_eq!(md.creator_owed, first.hook_fee * 100 / 350);
    assert_eq!(md.burn_pot, first.hook_fee - first.hook_fee * 100 / 350);
    assert_eq!(md.acc, 0, "nobody staked, nobody was paid as a holder");
    // and was itself charged 350 bps of what the protocol fee left
    assert_eq!(q1.hook_fee, ((3 * SOL - q1.protocol_fee) as u128 * 350).div_ceil(10_000) as u64);

    // the trader stakes 0.1% of the supply: from now on the holders' share is paid to it
    stake(&mut w, &mut md, &t, SUPPLY / 1_000);
    go(&mut w, START_SLOT + 400);
    let q2 = trade(&mut w, &mut md, &t, DIRECTION_BUY, 5 * SOL);
    assert_eq!(q2.fee_bps_applied, LP_FEE, "the sniper window is over");
    assert_eq!(md.last_split, rates(100, 200, 50));
    assert_eq!(q2.hook_fee, ((5 * SOL - q2.protocol_fee) as u128 * 350).div_ceil(10_000) as u64, "the same 350 bps as before the stake");
    let sold = q2.amount_out / 2;
    let q3 = trade(&mut w, &mut md, &t, DIRECTION_SELL, sold);
    assert_eq!(md.last_split, rates(150, 100, 250));
    assert_eq!(q3.hook_fee, (q3.amount_out_gross as u128 * 500).div_ceil(10_000) as u64, "a sell pays 5% of what the curve pays out");
    let q4 = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL / 3);
    let q5 = trade(&mut w, &mut md, &t, DIRECTION_SELL, 777_777_777);

    // settle the last trade through a claim, then every number by hand
    let paid_creator = {
        let creator = dev.insecure_clone();
        let to = ata(&d, &w.k.quote_mint);
        let before = w.env.balance(&to);
        let amount = must(md.claim_creator(fees_total(&w)));
        w.env.ok(&[claim_creator_ix(&w.k, &d, &to)], &[&creator]);
        assert_eq!(w.env.balance(&to) - before, amount);
        check(&w, &md);
        amount
    };
    let part = |fee: u64, bps: u64, of: u64| fee * bps / of;
    let creator_total = part(first.hook_fee, 100, 350) + part(q1.hook_fee, 100, 350) + part(q2.hook_fee, 100, 350) + part(q3.hook_fee, 150, 500) + part(q4.hook_fee, 100, 350) + part(q5.hook_fee, 150, 500);
    assert_eq!(paid_creator, creator_total, "the creator fee, to the lamport");
    // the holders' part of the two trades before the stake was burned; the rest went to the staker
    let holders_burned = part(first.hook_fee, 200, 350) + part(q1.hook_fee, 200, 350);
    let holders_total = part(q2.hook_fee, 200, 350) + part(q3.hook_fee, 100, 500) + part(q4.hook_fee, 200, 350) + part(q5.hook_fee, 100, 500);
    assert_eq!((md.holders_split, md.holders_burned), (holders_total, holders_burned));
    let fees = first.hook_fee + q1.hook_fee + q2.hook_fee + q3.hook_fee + q4.hook_fee + q5.hook_fee;
    assert_eq!(md.burn_pot, fees - creator_total - holders_total, "the burn pot took the rest of every fee");

    // the one staker earned every holders' part, less than one unit of rounding per part
    let rewards = must(try_claim_rewards(&mut w, &mut md, &t));
    assert!(rewards <= holders_total && holders_total - rewards <= 4, "rewards {rewards} of {holders_total}");
    // and the burn pot buys and burns, a slice of the quote reserve per run. Only the
    // burn share counts as a cost nobody gets back: 0.2% + 0.5% + 2.5% sure, 0.2% +
    // 2 * 0.3% soft, a quarter of 4% is 1%, the ceiling is 0.5%
    assert_eq!(md.burn_cap_bps(LP_FEE), 50);
    assert_eq!(must(try_run_burn(&mut w, &mut md, &anyone)), Ran::Observed, "the first call only takes the observation");
    let pot = md.burn_pot;
    let reserve = w.env.pool(&w.k.pool).reserve_quote;
    let (spent, burned) = burn_next(&mut w, &mut md, &anyone);
    assert_eq!(spent, pot.min(reserve * 50 / 10_000));
    assert!(burned > 0);
    burn_all(&mut w, &mut md, &anyone);
    let cfg = cfg_of(&w);
    assert_eq!((cfg.burn_pot, cfg.creator_owed, cfg.rewards_owed_total), (0, 0, 0));

    // the lock is still there and the public config never moved
    assert_eq!(w.env.balance(&w.r.lock_vault), first.amount_out);
    assert_eq!(rule_bytes(&w.env, &w.r.cfg), w.rules);
}

// ---- 3. the holders' share: a trade always pays it, stakers get it while enough is staked --

#[test]
fn a_trade_always_pays_the_holders_rate_and_stakers_get_it_only_while_enough_is_staked() {
    let args = RulesArgs { buy: rates(100, 200, 50), sell: rates(50, 300, 0), ..Default::default() };
    let (mut w, mut md) = world(args);
    let t = w.m.trader.insecure_clone();
    let min = MARKET_SUPPLY / 1_000;

    // nothing staked: a buy pays the full 350 bps all the same
    let pool = w.env.pool(&w.k.pool);
    let q0 = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!(q0, expect_swap(&pool, DIRECTION_BUY, SOL, 350, None));
    assert_eq!(cfg_of(&w).last_split, rates(100, 200, 50));

    // one unit short of 0.1% of the supply: the same fee on either side, and the stake
    // settled the buy before it with nobody eligible: its holders' part went to the burn pot
    stake(&mut w, &mut md, &t, min - 1);
    assert_eq!(md.burn_pot, q0.hook_fee - q0.hook_fee * 100 / 350, "the burn's 50 and the holders' 200 of 350");
    assert_eq!(md.holders_burned, q0.hook_fee * 200 / 350);
    let pool = w.env.pool(&w.k.pool);
    let q1 = trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000_000);
    assert_eq!(q1, expect_swap(&pool, DIRECTION_SELL, 1_000_000_000, 350, None));
    assert_eq!(cfg_of(&w).last_split, rates(50, 300, 0));

    // exactly 0.1%. The stake settles the sell first, with one unit too little staked:
    // its holders' part is burned as well, and nothing has reached a staker yet
    stake(&mut w, &mut md, &t, 1);
    assert_eq!(cfg_of(&w).total_staked, min);
    assert_eq!(cfg_of(&w).acc_per_share, 0);
    assert_eq!(md.holders_burned, q0.hook_fee * 200 / 350 + q1.hook_fee * 300 / 350);
    assert_eq!(md.holders_split, 0);

    // from here the same trades pay the same fees, and the holders' part goes to the staker
    let pool = w.env.pool(&w.k.pool);
    let q2 = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!(q2, expect_swap(&pool, DIRECTION_BUY, SOL, 350, None));
    let pool = w.env.pool(&w.k.pool);
    let q3 = trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000_000);
    assert_eq!(q3, expect_swap(&pool, DIRECTION_SELL, 1_000_000_000, 350, None));
    // the buy's holders' part is in the accumulator now: fee * 200 / 350
    let holders = q2.hook_fee * 200 / 350;
    assert_eq!(cfg_of(&w).acc_per_share, holders as u128 * ACC / min as u128);

    // the stake drops below the line (after the delay). The unstake settles the sell
    // before it for the staker who was there; the next trade's part is burned again.
    go(&mut w, START_SLOT + hook_rules::UNSTAKE_DELAY_SLOTS);
    must(try_unstake(&mut w, &mut md, &t, 1));
    let holders2 = q3.hook_fee * 300 / 350;
    assert_eq!(md.holders_split, holders + holders2);
    let burned_before = md.holders_burned;
    let pool = w.env.pool(&w.k.pool);
    let q4 = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!(q4, expect_swap(&pool, DIRECTION_BUY, SOL, 350, None), "and still the same fee");
    let rewards = must(try_claim_rewards(&mut w, &mut md, &t));
    assert!(rewards <= holders + holders2 && holders + holders2 - rewards <= 2, "{rewards} of {}", holders + holders2);
    assert_eq!(md.holders_burned, burned_before + q4.hook_fee * 200 / 350, "the claim settled the last buy: burned");
    assert_eq!(md.holders_split, holders + holders2);
}

// ---- 4. two stakers ---------------------------------------------------------------------

#[test]
fn two_stakers_with_different_amounts_and_timings_earn_exactly_their_share() {
    // holders only, so the whole hook fee of a trade is the holders' part
    let args = RulesArgs { buy: rates(0, 400, 0), sell: rates(0, 100, 0), ..Default::default() };
    let (mut w, mut md) = world(args);
    let t = w.m.trader.insecure_clone();
    let a = wallet(&mut w, 120_000_000_000, 0);
    let b = wallet(&mut w, 120_000_000_000, 0);
    let unit = 30_000_000_000u64; // above min_eligible (11e9) on its own

    // A alone
    stake(&mut w, &mut md, &a, unit);
    let h1 = trade(&mut w, &mut md, &t, DIRECTION_BUY, 2 * SOL).hook_fee;
    // B joins with three times as much: the trade before belongs to A alone
    stake(&mut w, &mut md, &b, 3 * unit);
    let pending_a = md.pending(&md.stakers[&a.pubkey()]);
    assert!(pending_a <= h1 && h1 - pending_a <= 1, "the first trade belongs to A alone: {pending_a} of {h1}");
    assert_eq!(md.pending(&md.stakers[&b.pubkey()]), 0, "a new staker gets nothing of the trades before it");
    let h2 = trade(&mut w, &mut md, &t, DIRECTION_SELL, 5_000_000_000).hook_fee;
    // A doubles: 60 to 90
    stake(&mut w, &mut md, &a, unit);
    let h3 = trade(&mut w, &mut md, &t, DIRECTION_BUY, 3 * SOL).hook_fee;
    // B leaves completely (after the delay), A stays
    go(&mut w, START_SLOT + hook_rules::UNSTAKE_DELAY_SLOTS);
    must(try_unstake(&mut w, &mut md, &b, 3 * unit));
    let h4 = trade(&mut w, &mut md, &t, DIRECTION_SELL, 7_000_000_000).hook_fee;
    assert!(h1 > 0 && h2 > 0 && h3 > 0 && h4 > 0);

    let got_a = must(try_claim_rewards(&mut w, &mut md, &a));
    let got_b = must(try_claim_rewards(&mut w, &mut md, &b));
    // exact shares: A = h1 + h2/4 + h3*2/5 + h4, B = h2*3/4 + h3*3/5
    let fair_a = h1 as u128 * 20 + h2 as u128 * 5 + h3 as u128 * 8 + h4 as u128 * 20;
    let fair_b = h2 as u128 * 15 + h3 as u128 * 12;
    println!("staker A got {got_a} of {} / 20, staker B got {got_b} of {} / 20", fair_a, fair_b);
    assert!(got_a as u128 * 20 <= fair_a && fair_a - got_a as u128 * 20 <= 4 * 20, "A: {got_a} against {fair_a}/20");
    assert!(got_b as u128 * 20 <= fair_b && fair_b - got_b as u128 * 20 <= 2 * 20, "B: {got_b} against {fair_b}/20");
    assert!(got_a + got_b <= h1 + h2 + h3 + h4);
    // nothing left to claim, and B's coins came back whole
    assert_eq!(try_claim_rewards(&mut w, &mut md, &a), Err("nothing to claim"));
    assert_eq!(try_claim_rewards(&mut w, &mut md, &b), Err("nothing to claim"));
    assert_eq!(w.env.balance(&ata(&b.pubkey(), &w.k.base_mint)), 120_000_000_000);
    let cfg = cfg_of(&w);
    assert_eq!((cfg.total_staked, cfg.rewards_owed_total, cfg.total_rewards_paid), (2 * unit, 0, got_a + got_b));
}

// ---- 5. the unstake delay ---------------------------------------------------------------

#[test]
fn unstake_waits_for_the_delay_and_a_new_stake_restarts_it_for_the_whole_record() {
    let (mut w, mut md) = world(RulesArgs { buy: rates(0, 100, 0), ..Default::default() });
    let a = wallet(&mut w, 100_000_000_000, 0);
    let b = wallet(&mut w, 100_000_000_000, 0);
    let delay = hook_rules::UNSTAKE_DELAY_SLOTS;
    assert_eq!(delay, 9_000);

    go(&mut w, 2_000);
    stake(&mut w, &mut md, &a, 40_000_000_000);
    assert_eq!(try_unstake(&mut w, &mut md, &a, 1), Err("unstake is not open yet"), "same slot");
    go(&mut w, 2_000 + delay - 1);
    assert_eq!(try_unstake(&mut w, &mut md, &a, 1), Err("unstake is not open yet"), "one slot early");
    go(&mut w, 2_000 + delay);
    must(try_unstake(&mut w, &mut md, &a, 10_000_000_000));
    // an unstake does not restart the delay
    must(try_unstake(&mut w, &mut md, &a, 1));

    // a new stake does, for the coins that were there before as well
    go(&mut w, 20_000);
    stake(&mut w, &mut md, &a, 5);
    go(&mut w, 20_000 + delay - 1);
    assert_eq!(try_unstake(&mut w, &mut md, &a, 1), Err("unstake is not open yet"));
    go(&mut w, 20_000 + delay);
    assert_eq!(try_unstake(&mut w, &mut md, &a, 0), Err("amount must be greater than zero"));
    let all = md.stakers[&a.pubkey()].amount;
    assert_eq!(all, 30_000_000_000 - 1 + 5);
    assert_eq!(try_unstake(&mut w, &mut md, &a, all + 1), Err("more than this record has staked"));
    must(try_unstake(&mut w, &mut md, &a, all));
    assert_eq!(w.env.balance(&ata(&a.pubkey(), &w.k.base_mint)), 100_000_000_000);
    assert_eq!(try_stake(&mut w, &mut md, &a, 0), Err("amount must be greater than zero"));

    // a wallet that never staked has no record
    assert_eq!(try_unstake(&mut w, &mut md, &b, 1), Err("AccountNotInitialized"));
    // and nobody unstakes from another wallet's record
    stake(&mut w, &mut md, &a, 1_000);
    go(&mut w, 60_000);
    let mut ix = unstake_ix(&w.k, &b.pubkey(), 1_000);
    ix.accounts[3].pubkey = RulesKeys::stake(&w.k, &a.pubkey());
    w.env.err(&[ix], &[&b], "ConstraintSeeds");
    // nor stakes into it: the record is the signer's own
    let mut ix = stake_ix(&w.k, &b.pubkey(), 1_000);
    ix.accounts[3].pubkey = RulesKeys::stake(&w.k, &a.pubkey());
    w.env.err(&[ix], &[&b], "ConstraintSeeds");
    // the coins never go back into the vault they leave
    let mut ix = unstake_ix(&w.k, &a.pubkey(), 1_000);
    ix.accounts[6].pubkey = w.r.stake_vault;
    w.env.err(&[ix], &[&a], "ConstraintDuplicateMutableAccount");
    // and no other account passes for the stake vault
    let mut ix = unstake_ix(&w.k, &a.pubkey(), 1_000);
    ix.accounts[5].pubkey = w.r.burn_account;
    w.env.err(&[ix], &[&a], "ConstraintSeeds");
    check(&w, &md);
}

// ---- 6. claims --------------------------------------------------------------------------

#[test]
fn claims_pay_what_is_owed_once_and_only_to_who_it_is_owed() {
    let (mut w, mut md) = world(RulesArgs { buy: rates(200, 200, 0), sell: rates(100, 100, 100), ..Default::default() });
    let t = w.m.trader.insecure_clone();
    let creator = w.m.creator.insecure_clone();
    let stranger = wallet(&mut w, 0, 0);
    let a = wallet(&mut w, 50_000_000_000, 0);

    // nothing yet
    assert_eq!(try_claim_creator(&mut w, &mut md), Err("nothing to claim"));
    stake(&mut w, &mut md, &a, 50_000_000_000);
    assert_eq!(try_claim_rewards(&mut w, &mut md, &a), Err("nothing to claim"));
    let q1 = trade(&mut w, &mut md, &t, DIRECTION_BUY, 4 * SOL);
    let q2 = trade(&mut w, &mut md, &t, DIRECTION_SELL, 20_000_000_000);

    // a stranger cannot claim the creator fee, to any account
    let ix = claim_creator_ix(&w.k, &stranger.pubkey(), &ata(&stranger.pubkey(), &w.k.quote_mint));
    w.env.err(&[ix], &[&stranger], "only the creator of the config can do this");
    // not even into the creator's own account
    let ix = claim_creator_ix(&w.k, &stranger.pubkey(), &ata(&creator.pubkey(), &w.k.quote_mint));
    w.env.err(&[ix], &[&stranger], "only the creator of the config can do this");
    // and the creator's key must sign
    let mut ix = claim_creator_ix(&w.k, &creator.pubkey(), &ata(&stranger.pubkey(), &w.k.quote_mint));
    ix.accounts[0].is_signer = false;
    assert!(w.env.send(&[ix], &[&stranger]).is_err());
    // a stranger has no rewards: no record of its own, and another's record is not its own
    assert_eq!(try_claim_rewards(&mut w, &mut md, &stranger), Err("AccountNotInitialized"));
    let mut ix = claim_rewards_ix(&w.k, &stranger.pubkey(), &ata(&stranger.pubkey(), &w.k.quote_mint));
    ix.accounts[3].pubkey = RulesKeys::stake(&w.k, &a.pubkey());
    w.env.err(&[ix], &[&stranger], "ConstraintSeeds");
    // a payout never goes back into the treasury it leaves, nor from another account
    let ix = claim_creator_ix(&w.k, &creator.pubkey(), &w.r.treasury);
    w.env.err(&[ix], &[&creator], "ConstraintDuplicateMutableAccount");
    let ix = claim_rewards_ix(&w.k, &a.pubkey(), &w.r.treasury);
    w.env.err(&[ix], &[&a], "ConstraintDuplicateMutableAccount");
    let mut ix = claim_creator_ix(&w.k, &creator.pubkey(), &ata(&creator.pubkey(), &w.k.quote_mint));
    ix.accounts[5].pubkey = ata(&t.pubkey(), &w.k.quote_mint);
    w.env.err(&[ix], &[&creator], "pool treasury is not this hook's treasury");
    check(&w, &md);

    // the creator: both trades, the second one settled by this very claim
    let paid = must(try_claim_creator(&mut w, &mut md));
    assert_eq!(paid, q1.hook_fee * 200 / 400 + q2.hook_fee * 100 / 300);
    assert_eq!(try_claim_creator(&mut w, &mut md), Err("nothing to claim"), "once");

    // the staker names any account of the quote mint: here somebody else's
    let to = ata(&stranger.pubkey(), &w.k.quote_mint);
    let amount = must(md.claim_rewards(&a.pubkey(), fees_total(&w)));
    w.env.ok(&[claim_rewards_ix(&w.k, &a.pubkey(), &to)], &[&a]);
    assert_eq!(w.env.balance(&to), amount);
    check(&w, &md);
    let holders = q1.hook_fee * 200 / 400 + q2.hook_fee * 100 / 300;
    assert!(amount <= holders && holders - amount <= 2);
    assert_eq!(try_claim_rewards(&mut w, &mut md, &a), Err("nothing to claim"), "once");

    // quote sent straight to the treasury is promised to nobody and changes no number
    w.env.mint_to(&w.m.authority, &w.k.quote_mint, &w.r.treasury, 12_345);
    md.donated += 12_345;
    check(&w, &md);
    assert_eq!(try_claim_creator(&mut w, &mut md), Err("nothing to claim"));
    assert_eq!(try_claim_rewards(&mut w, &mut md, &a), Err("nothing to claim"));
}

// ---- 7. the burn ------------------------------------------------------------------------

#[test]
fn run_burn_buys_against_an_old_observation_up_to_the_cap_and_the_supply_falls_by_what_it_bought() {
    let (mut w, mut md) = world(RulesArgs { buy: rates(0, 0, 500), sell: rates(100, 0, 400), ..Default::default() });
    let t = w.m.trader.insecure_clone();
    let anyone = w.env.user(SOL);
    assert_eq!((MAX_BURN_CAP_BPS, BURN_INTERVAL_SLOTS), (50, 25));
    // sure: 0.2% + the burn's 5% + 4%; a quarter is far above the ceiling
    assert_eq!(md.burn_cap_bps(LP_FEE), 50);
    const TOO_SOON: &str = "observation of the pool is less than 25 slots old";

    // an empty pot: nothing to do, not even an observation
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err("the burn pot is empty"));
    assert_eq!(cfg_of(&w).obs_reserve_quote, 0);

    // one small buy puts its fee in the pot
    let q = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    // 1. the first call of a pool takes the observation and buys nothing
    assert_eq!(must(try_run_burn(&mut w, &mut md, &anyone)), Ran::Observed);
    let (cfg, pool) = (cfg_of(&w), w.env.pool(&w.k.pool));
    assert_eq!((cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote), (START_SLOT, pool.reserve_base, pool.reserve_quote));
    assert_eq!((cfg.burn_pot, cfg.burns), (q.hook_fee, 0), "it settled the buy and spent nothing");
    // 2. a call that comes too soon is refused and writes nothing
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err(TOO_SOON));
    go(&mut w, START_SLOT + 24);
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err(TOO_SOON));
    assert_eq!(cfg_of(&w).obs_slot, START_SLOT);
    // 3. 25 slots after the observation it buys. Below the cap the whole pot goes.
    go(&mut w, START_SLOT + 25);
    let reserve = w.env.pool(&w.k.pool).reserve_quote;
    assert!(q.hook_fee < reserve * 50 / 10_000);
    let Ran::Bought { spent, burned, q: bought } = must(try_run_burn(&mut w, &mut md, &anyone)) else { panic!("it did not buy") };
    assert_eq!(spent, q.hook_fee, "all of the buy's fee");
    assert!(burned > 0);
    let cfg = cfg_of(&w);
    assert_eq!((cfg.burn_pot, cfg.burns), (0, 1));
    // the pool as the buy left it is the new observation
    assert_eq!((cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote), (START_SLOT + 25, bought.reserve_out_after, bought.reserve_in_after));
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err("the burn pot is empty"));

    // five large buys put about 5 SOL in the pot and the price far above the observation
    for _ in 0..5 {
        trade(&mut w, &mut md, &t, DIRECTION_BUY, 20 * SOL);
    }
    let small = trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000); // settles the fifth buy
    assert_eq!(cfg_of(&w).obs_reserve_quote, bought.reserve_in_after, "no trade started below the observed price: it stands");
    let pot = md.burn_pot;
    go(&mut w, START_SLOT + 50);
    // 4. the price ran away since the observation: the run buys nothing and observes again
    assert_eq!(must(try_run_burn(&mut w, &mut md, &anyone)), Ran::Waited);
    let (cfg, pool) = (cfg_of(&w), w.env.pool(&w.k.pool));
    assert_eq!((cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote), (START_SLOT + 50, pool.reserve_base, pool.reserve_quote));
    // it settled the small sell on the way; nothing was spent
    let sell_part = small.hook_fee - small.hook_fee * 100 / 500;
    assert_eq!((cfg.burn_pot, cfg.burns), (pot + sell_part, 1));
    // and nobody can keep it waiting by calling again: too soon, nothing written
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err(TOO_SOON));
    go(&mut w, START_SLOT + 74);
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err(TOO_SOON));

    // 5. the price stood for 25 slots: the run buys, one slice of the reserve
    go(&mut w, START_SLOT + 75);
    let pot = md.burn_pot;
    let pool = w.env.pool(&w.k.pool);
    let cap = pool.reserve_quote * 50 / 10_000;
    assert!(pot > 4 * cap, "pot {pot}, cap {cap}");
    // a caller cannot ask for more than the pool gives
    let expected = hookpool::math::quote_swap(DIRECTION_BUY, cap, pool.reserve_base, pool.reserve_quote, pool.virtual_quote, LP_FEE, PROTOCOL_FEE_BPS, 0, None, None).unwrap();
    let ix = run_burn_ix(&w.env, &w.k, &anyone.pubkey(), expected.amount_out + 1);
    w.env.err(&[ix], &[&anyone], "output below min_amount_out");
    let Ran::Bought { spent, burned, .. } = must(try_run_burn(&mut w, &mut md, &anyone)) else { panic!("it did not buy") };
    assert_eq!(spent, cap, "one run spends 0.5% of the quote reserve and no more");
    assert_eq!(burned, expected.amount_out);
    assert_eq!(md.burn_pot, pot - cap);
    // two runs in one transaction: the second is too soon, and the transaction fails
    go(&mut w, START_SLOT + 100);
    let ix = run_burn_ix(&w.env, &w.k, &anyone.pubkey(), 0);
    w.env.err(&[compute_budget_ix(400_000), ix.clone(), ix], &[&anyone], TOO_SOON);
    check(&w, &md);
    // the next runs take the next slices, each 25 slots after the one before and each
    // measured against the pool the run before it left
    let runs = 1 + burn_all(&mut w, &mut md, &anyone);
    assert!(runs >= 5, "a large pot takes several runs: {runs}");
    let cfg = cfg_of(&w);
    assert_eq!(cfg.burns, runs as u64 + 1);
    assert_eq!(cfg.total_quote_burned, md.burn_split);
    // trades in between do not wait for anything
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000_000);

    // 6. a price that FELL since the observation is no reason to wait, and the slice is
    //    of the smaller pool, the one of now
    burn_all(&mut w, &mut md, &anyone);
    let observed = (md.obs_base, md.obs_quote);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 100_000_000_000);
    assert_eq!((md.obs_base, md.obs_quote), observed, "that sell started AT the observed price");
    let slot = md.obs_slot + BURN_INTERVAL_SLOTS;
    go(&mut w, slot);
    let pool = w.env.pool(&w.k.pool);
    assert!(pool.reserve_quote < md.obs_quote, "the sell took quote out of the pool");
    assert_eq!(md.burn_plan(&pool, slot), Plan::Buy(pool.reserve_quote * 50 / 10_000));
    assert!(matches!(must(try_run_burn(&mut w, &mut md, &anyone)), Ran::Bought { .. }));
    // 7. a trade that STARTS below the observed price lowers the observation, and keeps
    //    its slot: the next run is not postponed by it
    let before = cfg_of(&w);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 50_000_000_000);
    assert_eq!(cfg_of(&w).obs_reserve_quote, before.obs_reserve_quote, "this one started at it");
    let pool = w.env.pool(&w.k.pool);
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL / 100);
    let cfg = cfg_of(&w);
    assert_eq!((cfg.obs_slot, cfg.obs_reserve_base, cfg.obs_reserve_quote), (before.obs_slot, pool.reserve_base, pool.reserve_quote), "the pool as the buy found it");

    // only the burn account can be burned from: never the stake vault, never the lock vault
    let creator = w.m.creator.insecure_clone();
    stake(&mut w, &mut md, &t, 50_000_000_000);
    w.env.ok(&[lock_ix(&w.k, &creator.pubkey(), 1_000_000, START_TIME + DAY)], &[&creator]);
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    for vault in [w.r.stake_vault, w.r.lock_vault] {
        let ix = run_burn_with(&w.env, &w.k, &anyone.pubkey(), &vault, 0);
        w.env.err(&[ix], &[&anyone], "ConstraintTokenOwner");
    }
    // and the pool itself would not let the hook spend from them: they are not the authority's
    for vault in [w.r.stake_vault, w.r.lock_vault] {
        let v = w.env.svm.get_account(&vault).unwrap();
        assert_eq!(Pubkey::new_from_array(v.data[32..64].try_into().unwrap()), w.r.cfg);
    }
    assert_eq!(w.env.balance(&w.r.stake_vault), 50_000_000_000);
    assert_eq!(w.env.balance(&w.r.lock_vault), 1_000_000);
    // nor with another treasury
    let mut ix = run_burn_ix(&w.env, &w.k, &anyone.pubkey(), 0);
    ix.accounts[9].pubkey = ata(&t.pubkey(), &w.k.quote_mint);
    w.env.err(&[ix], &[&anyone], "pool treasury is not this hook's treasury");
    // coins somebody sends to the burn account are burned with the next run
    let sent = 2_000_000u64;
    let ix = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &ata(&t.pubkey(), &w.k.base_mint), &w.r.burn_account, &t.pubkey(), &[], sent).unwrap();
    w.env.ok(&[ix], &[&t]);
    let supply = w.env.mint_supply(&w.k.base_mint);
    let (_, burned) = burn_next(&mut w, &mut md, &anyone);
    assert!(burned > sent);
    assert_eq!(supply - w.env.mint_supply(&w.k.base_mint), burned);
}

// ---- 8. the buy limit -------------------------------------------------------------------

#[test]
fn the_buy_limit_holds_inside_its_window_only_and_sells_are_never_limited() {
    let args = RulesArgs { buy: rates(100, 0, 0), sell: rates(100, 0, 0), max_buy_quote: SOL, limit_slots: 100, ..Default::default() };
    let (mut w, mut md) = world(args);
    let t = w.m.trader.insecure_clone();

    // first slot
    assert_eq!(try_trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL + 1).err(), Some("buy above the limit of the launch window"));
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    // a sell of any size, in the same slot: 500,000 coins, half of what the pool holds
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 500_000_000_000);
    // the limit is per trade: a second buy at the limit passes
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    // last slot of the window
    go(&mut w, START_SLOT + 99);
    assert_eq!(try_trade(&mut w, &mut md, &t, DIRECTION_BUY, 50 * SOL).err(), Some("buy above the limit of the launch window"));
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    // the window is over
    go(&mut w, START_SLOT + 100);
    trade(&mut w, &mut md, &t, DIRECTION_BUY, 50 * SOL);
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL + 1);
}

// ---- 9. the sniper fee ------------------------------------------------------------------

#[test]
fn the_sniper_fee_follows_the_line_from_the_first_slot_to_the_end_of_the_window() {
    let args = RulesArgs { sniper_slots: 100, sniper_start_fee_bps: 3_000, buy: rates(100, 0, 100), sell: rates(100, 0, 100), ..Default::default() };
    let (mut w, mut md) = world(args);
    let t = w.m.trader.insecure_clone();
    let line = |slot: u64| hook_launch_guard::guard_fee(slot, START_SLOT, 100, 3_000, LP_FEE);

    // first slot: the start fee, to the pool, and the hook fee on top of it
    let before = w.env.pool(&w.k.pool);
    let q = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!(q.fee_bps_applied, 3_000);
    assert_eq!(line(START_SLOT), Some(3_000));
    assert_eq!(q, expect_swap(&before, DIRECTION_BUY, SOL, 200, Some(3_000)));
    let after = w.env.pool(&w.k.pool);
    assert_eq!(after.reserve_quote - before.reserve_quote, q.net_in + q.lp_fee, "the sniper fee stays in the pool");
    assert_eq!(q.lp_fee, ((SOL - q.protocol_fee - q.hook_fee) as u128 * 3_000).div_ceil(10_000) as u64);

    // a sell inside the window pays the pool's normal fee
    let q = trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000_000);
    assert_eq!(q.fee_bps_applied, LP_FEE);

    // half way: 3000 - (3000 - 30) * 50 / 100 = 1515
    go(&mut w, START_SLOT + 50);
    let q = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!(q.fee_bps_applied, 1_515);
    assert_eq!(line(START_SLOT + 50), Some(1_515));
    // last slot of the window: 3000 - 2970 * 99 / 100 = 60
    go(&mut w, START_SLOT + 99);
    let q = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!(q.fee_bps_applied, 60);
    assert_eq!(line(START_SLOT + 99), Some(60));
    // after it: the pool's own fee
    for slot in [START_SLOT + 100, START_SLOT + 101, START_SLOT + 1_000_000] {
        go(&mut w, slot);
        let q = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
        assert_eq!(q.fee_bps_applied, LP_FEE);
        assert_eq!(line(slot), None);
    }
    // every slot of the window, against the launch guard's own function
    for e in 0..=100u64 {
        assert_eq!(sniper(START_SLOT + e, START_SLOT, 100, 3_000, LP_FEE), line(START_SLOT + e));
        assert_eq!(hook_rules::sniper_fee(START_SLOT + e, START_SLOT, 100, 3_000, LP_FEE), line(START_SLOT + e));
    }
}

#[test]
fn a_sniper_start_fee_not_above_the_pool_fee_changes_nothing() {
    // pool fee 5%, start fee 3%: no override at all, the pool charges its own fee
    let args = RulesArgs { sniper_slots: 100, sniper_start_fee_bps: 300, ..Default::default() };
    let mut w = world_with(args, 500);
    let cfg = cfg_of(&w);
    let mut md = Model::new(args, START_SLOT, cfg.min_eligible);
    let t = w.m.trader.insecure_clone();
    let q = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!((q.fee_bps_applied, q.hook_fee), (500, 0));
    assert_eq!(w.env.balance(&w.r.treasury), 0);
}

// ---- 10. the platform cap ---------------------------------------------------------------

#[test]
fn a_lower_platform_cap_charges_the_cap_and_keeps_the_split_in_proportion() {
    let args = RulesArgs { buy: rates(300, 200, 500), sell: rates(100, 500, 400), ..Default::default() };
    let (mut w, mut md) = world(args);
    let t = w.m.trader.insecure_clone();
    let staked = 100_000_000_000u64;
    stake(&mut w, &mut md, &t, staked);
    // What one settlement added to the three parts, read from the chain: the creator's
    // number, the burn pot, and the holders' part out of the accumulator.
    let parts = |before: &RulesConfig, after: &RulesConfig| {
        let acc = (after.acc_per_share - before.acc_per_share) * staked as u128 + after.reward_rem as u128 - before.reward_rem as u128;
        assert_eq!(acc % ACC, 0, "the accumulator and its remainder hold whole units of fee");
        (after.creator_owed - before.creator_owed, (acc / ACC) as u64, after.burn_pot - before.burn_pot)
    };

    // at the launch-time cap the full 10% is charged
    let full = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!(full.hook_fee, ((SOL - full.protocol_fee) as u128 * 1_000).div_ceil(10_000) as u64);

    // the platform lowers the cap to 4%: trades go on and pay the cap
    w.env.update_platform(hookpool::UpdatePlatformArgs { max_hook_fee_bps: Some(400), ..Default::default() });
    md.cap = 400;
    let c0 = cfg_of(&w);
    let buy = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!(buy.hook_fee, ((SOL - buy.protocol_fee) as u128 * 400).div_ceil(10_000) as u64, "the cap, not the 10% of the rules");
    assert_eq!(cfg_of(&w).last_split, rates(300, 200, 500), "the hook still answers its own rates");
    // (that buy settled the uncapped one before it)
    let c1 = cfg_of(&w);
    let f = full.hook_fee;
    assert_eq!(parts(&c0, &c1), (f * 300 / 1_000, f * 200 / 1_000, f - f * 300 / 1_000 - f * 200 / 1_000));

    let sell = trade(&mut w, &mut md, &t, DIRECTION_SELL, 5_000_000_000);
    assert_eq!(sell.hook_fee, (sell.amount_out_gross as u128 * 400).div_ceil(10_000) as u64);
    // the capped buy is settled now: 300 : 200 : 500 of what was really charged
    let c2 = cfg_of(&w);
    let f = buy.hook_fee;
    assert_eq!(parts(&c1, &c2), (f * 300 / 1_000, f * 200 / 1_000, f - f * 300 / 1_000 - f * 200 / 1_000));
    assert!(f * 300 / 1_000 > 0 && f * 200 / 1_000 > 0);

    // the capped sell: 100 : 500 : 400
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL / 10);
    let c3 = cfg_of(&w);
    let f = sell.hook_fee;
    assert_eq!(parts(&c2, &c3), (f * 100 / 1_000, f * 500 / 1_000, f - f * 100 / 1_000 - f * 500 / 1_000));

    // a cap of zero: nothing is charged, nothing blocks
    w.env.update_platform(hookpool::UpdatePlatformArgs { max_hook_fee_bps: Some(0), ..Default::default() });
    md.cap = 0;
    assert_eq!(trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL).hook_fee, 0);
    assert_eq!(trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000_000).hook_fee, 0);
    let c4 = cfg_of(&w);
    assert_eq!(c4.fees_seen, w.env.pool(&w.k.pool).hook_fees_quote_total, "everything charged so far is settled");
    assert_eq!(trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL).hook_fee, 0);
    assert_eq!(parts(&c4, &cfg_of(&w)), (0, 0, 0));
    // and back
    w.env.update_platform(hookpool::UpdatePlatformArgs { max_hook_fee_bps: Some(1_000), ..Default::default() });
    md.cap = 1_000;
    let q = trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000_000);
    assert_eq!(q.hook_fee, (q.amount_out_gross as u128 * 1_000).div_ceil(10_000) as u64);

    // the sniper fee is clamped by the platform too, and the buy still goes through
    let mut w2 = world_with(RulesArgs { sniper_slots: 100, sniper_start_fee_bps: 5_000, ..Default::default() }, LP_FEE);
    w2.env.update_platform(hookpool::UpdatePlatformArgs { max_fee_override_bps: Some(100), ..Default::default() });
    let pool = w2.env.pool(&w2.k.pool);
    let q = expect_swap(&pool, DIRECTION_BUY, SOL, 0, Some(100));
    let t2 = w2.m.trader.insecure_clone();
    let ix = w2.env.swap_ix(&t2.pubkey(), &w2.k, &w2.hook, DIRECTION_BUY, SOL, q.amount_out);
    w2.env.ok(&[ix], &[&t2]);
    assert_eq!(w2.env.pool(&w2.k.pool).reserve_quote, q.reserve_in_after);
}

// ---- 11. the first buy and the buy limit -------------------------------------------------

#[test]
fn a_first_buy_above_the_buy_limit_fails_the_launch() {
    let args = RulesArgs { buy: rates(100, 0, 0), max_buy_quote: SOL, limit_slots: 300, ..Default::default() };
    let Launched { mut env, m: _m, dev, k, hook } = launch_step_one(args);
    let d = dev.pubkey();
    let launch = |env: &Env, dev_buy: u64| {
        launch_ix(env, &d, &k, &hook, hooklaunch::LaunchArgs { lp_fee_bps: LP_FEE, base_amount: SUPPLY, quote_amount: 10 * SOL, dev_buy_quote: dev_buy, min_dev_buy_out: 1 })
    };
    let ix = launch(&env, SOL + 1);
    env.err(&[compute_budget_ix(400_000), ix], &[&dev], "buy above the limit of the launch window");
    assert!(env.svm.get_account(&k.pool).map(|a| a.lamports).unwrap_or(0) == 0, "no pool was created");
    let cfg: RulesConfig = env.account(&hook_rules::cfg_address(&k.pool));
    assert_eq!((cfg.start_slot, cfg.min_eligible), (0, 0), "the failed launch left the config as it was");
    // at the limit the same launch goes through
    let ix = launch(&env, SOL);
    env.ok(&[compute_budget_ix(400_000), ix], &[&dev]);
    assert_eq!(env.pool(&k.pool).swap_count, 1);
}

// ---- 12. the creator lock -----------------------------------------------------------------

#[test]
fn the_creator_lock_only_moves_later_and_opens_at_its_date() {
    let declared = 30 * DAY;
    let args = RulesArgs { creator_lock_seconds: declared as u64, ..Default::default() };
    let max = hook_rules::MAX_LOCK_SECONDS as i64;
    assert_eq!(max, 365 * DAY);

    // before the pool exists the creator cannot lock: there is no launch time to count from
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.rules_hook(&m.creator, &k, args);
    let c = m.creator.pubkey();
    env.err(&[lock_ix(&k, &c, 1_000, START_TIME + declared)], &[&m.creator], "does not exist yet");
    let ix = env.create_pool_ix(&c, &k, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    let r = RulesKeys::of(&k);
    let creator = m.creator.insecure_clone();
    let stranger = env.user(SOL);
    env.fund(&stranger, &m.authority, &k.base_mint, &k.quote_mint, 5_000_000, 0);
    let creator_base = ata(&c, &k.base_mint);
    let held = env.balance(&creator_base);

    // two days after the launch
    env.set_clock(START_SLOT + 400_000, START_TIME + 2 * DAY);
    let now = START_TIME + 2 * DAY;
    // only the creator
    env.err(&[lock_ix(&k, &stranger.pubkey(), 1_000, START_TIME + declared)], &[&stranger], "only the creator of the config can do this");
    // not before the launch plus the declared lock
    env.err(&[lock_ix(&k, &c, 1_000, START_TIME + declared - 1)], &[&creator], "before the lock declared at launch");
    // not more than MAX_LOCK_SECONDS ahead
    env.err(&[lock_ix(&k, &c, 1_000, now + max + 1)], &[&creator], "unlock time is too far ahead");
    // not an empty lock
    env.err(&[lock_ix(&k, &c, 0, START_TIME + declared)], &[&creator], "amount must be greater than zero");
    assert!(env.svm.get_account(&r.lock).map(|a| a.lamports).unwrap_or(0) == 0, "no record yet");

    // exactly the declared date
    env.ok(&[lock_ix(&k, &c, 1_000, START_TIME + declared)], &[&creator]);
    let lock: LockRecord = env.account(&r.lock);
    assert_eq!((lock.pool, lock.amount, lock.unlock_at), (k.pool, 1_000, START_TIME + declared));
    assert_eq!(env.balance(&r.lock_vault), 1_000);
    assert_eq!(env.balance(&creator_base), held - 1_000);
    // the vault belongs to the config account, not to the creator
    let v = env.svm.get_account(&r.lock_vault).unwrap();
    assert_eq!(Pubkey::new_from_array(v.data[32..64].try_into().unwrap()), r.cfg);

    // more coins, same date
    env.ok(&[lock_ix(&k, &c, 500, START_TIME + declared)], &[&creator]);
    // the date moves later with no coins
    env.ok(&[lock_ix(&k, &c, 0, START_TIME + declared + DAY)], &[&creator]);
    // never earlier, with or without coins
    env.err(&[lock_ix(&k, &c, 0, START_TIME + declared + DAY - 1)], &[&creator], "the unlock time can only move later");
    env.err(&[lock_ix(&k, &c, 700, START_TIME + declared)], &[&creator], "the unlock time can only move later");
    // up to the last second allowed
    env.err(&[lock_ix(&k, &c, 0, now + max + 1)], &[&creator], "unlock time is too far ahead");
    env.ok(&[lock_ix(&k, &c, 0, now + max)], &[&creator]);
    let lock: LockRecord = env.account(&r.lock);
    assert_eq!((lock.amount, lock.unlock_at), (1_500, now + max));
    assert_eq!(env.balance(&r.lock_vault), 1_500);

    // closed until the date, for everybody
    let unlock_at = now + max;
    env.err(&[unlock_ix(&k, &c)], &[&creator], "the creator lock is not over yet");
    env.set_clock(START_SLOT + 500_000, unlock_at - 1);
    env.err(&[unlock_ix(&k, &c)], &[&creator], "the creator lock is not over yet");
    env.set_clock(START_SLOT + 500_001, unlock_at);
    env.err(&[unlock_ix(&k, &stranger.pubkey())], &[&stranger], "only the creator of the config can do this");
    // a stranger cannot even pass the creator's key without its signature
    let mut ix = unlock_ix(&k, &c);
    ix.accounts[0].is_signer = false;
    assert!(env.send(&[ix], &[&stranger]).is_err());
    // coins somebody sent to the vault come out with the rest
    let ix = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &ata(&stranger.pubkey(), &k.base_mint), &r.lock_vault, &stranger.pubkey(), &[], 77).unwrap();
    env.ok(&[ix], &[&stranger]);
    // never back into the vault itself
    let mut ix = unlock_ix(&k, &c);
    ix.accounts[5].pubkey = r.lock_vault;
    env.err(&[ix], &[&creator], "ConstraintDuplicateMutableAccount");

    env.ok(&[unlock_ix(&k, &c)], &[&creator]);
    assert_eq!(env.balance(&creator_base), held + 77, "everything came back");
    assert_eq!(env.balance(&r.lock_vault), 0);
    let lock: LockRecord = env.account(&r.lock);
    assert_eq!((lock.amount, lock.unlock_at), (0, 0), "the record is zeroed");
    env.err(&[unlock_ix(&k, &c)], &[&creator], "nothing is locked");

    // the whole balance in one word: u64::MAX locks everything the account holds
    assert_eq!(hook_rules::LOCK_WHOLE_BALANCE, u64::MAX);
    let whole = env.balance(&creator_base);
    assert!(whole > 0);
    let meta = env.ok(&[lock_ix(&k, &c, u64::MAX, unlock_at + 5)], &[&creator]);
    assert_eq!((env.balance(&creator_base), env.balance(&r.lock_vault)), (0, whole));
    let lock: LockRecord = env.account(&r.lock);
    assert_eq!((lock.amount, lock.unlock_at), (whole, unlock_at + 5));
    let e = &logged::<hook_rules::CreatorLocked>(&meta)[0];
    assert_eq!((e.amount, e.locked), (whole, whole), "the event carries what was really locked");
    // with nothing left in the account the same word adds nothing and may still move the date
    env.ok(&[lock_ix(&k, &c, u64::MAX, unlock_at + 6)], &[&creator]);
    let lock: LockRecord = env.account(&r.lock);
    assert_eq!((lock.amount, lock.unlock_at), (whole, unlock_at + 6));
    env.set_clock(START_SLOT + 500_002, unlock_at + 6);
    env.ok(&[unlock_ix(&k, &c)], &[&creator]);
    assert_eq!(env.balance(&creator_base), whole);
    // an empty account and nothing locked: there is nothing to lock
    let aside = ata(&stranger.pubkey(), &k.base_mint);
    let ix = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &creator_base, &aside, &c, &[], whole).unwrap();
    env.ok(&[ix], &[&creator]);
    env.err(&[lock_ix(&k, &c, u64::MAX, unlock_at + 100)], &[&creator], "amount must be greater than zero");
    let ix = anchor_spl::token::spl_token::instruction::transfer(&TOKEN, &aside, &creator_base, &stranger.pubkey(), &[], whole).unwrap();
    env.ok(&[ix], &[&stranger]);
    let unlock_at = unlock_at + 6;

    // a new lock starts from nothing. The declared date is long past, but a lock that is
    // already over when it is made is refused: the date must be in the future
    env.err(&[lock_ix(&k, &c, 42, unlock_at)], &[&creator], "unlock time is not in the future");
    env.err(&[lock_ix(&k, &c, 42, unlock_at - DAY)], &[&creator], "unlock time is not in the future");
    env.ok(&[lock_ix(&k, &c, 1, unlock_at + 1)], &[&creator]);
    env.set_clock(START_SLOT + 500_003, unlock_at + 1);
    env.ok(&[unlock_ix(&k, &c)], &[&creator]);
    let unlock_at = unlock_at + 1;
    let later = unlock_at + 10 * DAY;
    env.ok(&[lock_ix(&k, &c, 42, later)], &[&creator]);
    let lock: LockRecord = env.account(&r.lock);
    assert_eq!((lock.amount, lock.unlock_at), (42, later));
    env.err(&[unlock_ix(&k, &c)], &[&creator], "the creator lock is not over yet");

    // the lock changed nothing in the config
    let cfg: RulesConfig = env.account(&r.cfg);
    assert_eq!((cfg.creator_lock_seconds, cfg.start_time), (declared as u64, START_TIME));
}

// ---- 13. callbacks ------------------------------------------------------------------------

#[test]
fn callbacks_called_directly_are_refused() {
    let (mut w, md) = world(RulesArgs { buy: rates(100, 100, 100), max_buy_quote: SOL, limit_slots: 10, ..Default::default() });
    let t = w.m.trader.insecure_clone();
    let callback = |caller: Pubkey| {
        hook_rules::accounts::Callback {
            pool: w.k.pool,
            hook_caller: caller,
            user: t.pubkey(),
            quote_mint: w.k.quote_mint,
            base_mint: w.k.base_mint,
            cfg: w.r.cfg,
        }
        .to_account_metas(None)
    };
    let swap = SwapPayload { direction: DIRECTION_BUY, amount_in: 1, slot: START_SLOT, lp_fee_bps: LP_FEE, ..Default::default() };
    let create = PoolCreatePayload { lp_fee_bps: LP_FEE, base_amount: 1, quote_amount: 1, creator: t.pubkey() };
    let datas = [
        hook_rules::instruction::BeforeSwap { payload: swap }.data(),
        hook_rules::instruction::OnPoolCreate { payload: create }.data(),
        hook_rules::instruction::BeforeAddLiquidity { payload: LiquidityPayload { slot: START_SLOT + 1_000_000, ..Default::default() } }.data(),
    ];
    let fake = w.env.user(SOL);
    for data in datas {
        // the pool's caller address, which nobody outside the pool program can sign for
        let mut accounts = callback(caller_address(&hook_rules::ID).0);
        for a in accounts.iter_mut() {
            a.is_signer = false;
        }
        let ix = Instruction { program_id: hook_rules::ID, accounts, data: data.clone() };
        assert!(w.env.send(&[ix], &[&t]).is_err());
        // a caller that does sign is not the pool's
        let ix = Instruction { program_id: hook_rules::ID, accounts: callback(fake.pubkey()), data: data.clone() };
        w.env.err(&[ix], &[&fake], "not the pool program's caller PDA");
        // the trader signing in the caller's place
        let ix = Instruction { program_id: hook_rules::ID, accounts: callback(t.pubkey()), data };
        w.env.err(&[ix], &[&t], "not the pool program's caller PDA");
    }
    // nothing moved
    check(&w, &md);
    assert_eq!(cfg_of(&w).last_split, Rates::default());
}

// ---- 14. the config: once, by the launcher, forever --------------------------------------

#[test]
fn a_config_is_written_once_and_a_strangers_config_fails_the_pool() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let stranger = env.user(10 * SOL);
    let hostile = RulesArgs { buy: rates(500, 0, 0), sell: rates(500, 0, 0), ..Default::default() };

    // a stranger takes the config address of a pool that does not exist yet
    let hook = env.rules_hook(&stranger, &k, hostile);
    // the pool then fails to start, with a clear error: it never runs on the stranger's rules
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "config was not created by the pool creator");
    assert!(env.svm.get_account(&k.pool).map(|a| a.lamports).unwrap_or(0) == 0);
    // and the launcher cannot write a second config over it
    let ix = Env::rules_config_ix(&m.creator.pubkey(), &k, RulesArgs::default());
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "already in use");
    // nor can the stranger rewrite its own
    let ix = Env::rules_config_ix(&stranger.pubkey(), &k, RulesArgs::default());
    env.err(&[compute_budget_ix(400_000), ix], &[&stranger], "already in use");
    let cfg: RulesConfig = env.account(&hook_rules::cfg_address(&k.pool));
    assert_eq!((cfg.creator, cfg.buy), (stranger.pubkey(), rates(500, 0, 0)));

    // the reversed pair is another pool with another config: there the creator launches
    let k2 = Env::pool_keys(&m.quote_mint, &m.base_mint);
    let args = RulesArgs { buy: rates(100, 0, 0), ..Default::default() };
    let hook2 = env.rules_hook(&m.creator, &k2, args);
    // with another treasury than the hook's own, no pool
    let wrong = HookRef { treasury: ata(&m.creator.pubkey(), &k2.quote_mint), ..hook2.clone() };
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k2, LP_FEE, QUOTE_LIQ, BASE_LIQ, &wrong);
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "pool treasury is not this hook's treasury");
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k2, LP_FEE, QUOTE_LIQ, BASE_LIQ, &hook2);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    // a second config for a pool that runs: refused as well
    let ix = Env::rules_config_ix(&m.creator.pubkey(), &k2, RulesArgs::default());
    env.err(&[compute_budget_ix(400_000), ix], &[&m.creator], "already in use");
    let cfg: RulesConfig = env.account(&hook_rules::cfg_address(&k2.pool));
    assert_eq!((cfg.creator, cfg.buy, cfg.start_slot), (m.creator.pubkey(), rates(100, 0, 0), START_SLOT));
}

#[test]
fn a_stranger_cannot_block_a_config_by_creating_its_token_accounts_first() {
    // Anyone can create an associated token account for any owner. If the config insisted
    // on creating the treasury and the burn account itself, a stranger who knows the coin
    // could create them first, for the price of their rent, and the coin could never get
    // its rules.
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let r = RulesKeys::of(&k);
    let stranger = env.user(10 * SOL);
    env.ok(
        &[
            Env::create_ata_ix(&stranger.pubkey(), &r.authority, &k.quote_mint),
            Env::create_ata_ix(&stranger.pubkey(), &r.authority, &k.base_mint),
        ],
        &[&stranger],
    );
    // and even puts something in them
    env.mint_to(&m.authority, &k.quote_mint, &r.treasury, 5_000);
    env.mint_to(&m.authority, &k.base_mint, &r.burn_account, 7_000);

    let args = RulesArgs { buy: rates(0, 0, 300), sell: rates(0, 0, 300), ..Default::default() };
    let hook = env.rules_hook(&m.creator, &k, args);
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    let rules = rule_bytes(&env, &r.cfg);
    let mut w = World { env, m, k, hook, r, rules };
    // the supply counted for min_eligible includes the 7,000 units the stranger was given
    let mut md = Model::new(args, START_SLOT, (MARKET_SUPPLY + 7_000) / 1_000);
    // what was in the treasury before belongs to nobody; what was in the burn account burns
    md.donated = 5_000;
    check(&w, &md);
    let t = w.m.trader.insecure_clone();
    trade(&mut w, &mut md, &t, DIRECTION_BUY, 2 * SOL);
    let supply = w.env.mint_supply(&w.k.base_mint);
    let (_, burned) = burn_next(&mut w, &mut md, &t);
    assert!(burned > 7_000);
    assert_eq!(supply - w.env.mint_supply(&w.k.base_mint), burned);
    assert_eq!(w.env.balance(&w.r.treasury), 5_000);
}

#[test]
fn the_program_has_no_instruction_that_changes_a_rule() {
    // The complete instruction list, read from the IDL the build wrote. Every name is
    // accounted for below; a new instruction makes this test fail until somebody decides
    // what it may write.
    let path = deploy_dir().join("../idl/hook_rules.json");
    let idl: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))).unwrap();
    let mut names: Vec<String> = idl["instructions"].as_array().unwrap().iter().map(|i| i["name"].as_str().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "before_add_liquidity", // writes nothing: refuses liquidity while the sniper fee runs
            "before_swap",      // writes the running numbers, last_split, and lowers the burn's observation
            "claim_creator",    // running numbers
            "claim_holder",     // strict coin: running numbers, the holder record
            "claim_rewards",    // running numbers, the stake record
            "close_holder",     // strict coin: closes an empty holder record, not the config
            "execute",          // strict coin, called by the token program in a transfer: running numbers, holder records
            "init_manifest",    // once, the manifest and the extra-accounts list
            "init_pool_config", // once per pool: the rules
            "init_strict_config", // once per strict coin, in place of init_pool_config: the rules
            "lock_creator",     // the lock record, not the config
            "lock_creator_strict", // strict coin: the lock record and the creator's holder record, not the config
            "on_pool_create",   // once per pool: start_slot, start_time, min_eligible
            "open_holder",      // strict coin: running numbers, a new holder record
            "run_burn",         // running numbers
            "run_burn_strict",  // strict coin: running numbers
            "stake",            // running numbers, the stake record
            "sync_holder",      // strict coin: running numbers, the holder record
            "unlock_creator",   // the lock record, not the config
            "unlock_creator_strict", // strict coin: the lock record and the creator's holder record, not the config
            "unstake",          // running numbers, the stake record
        ]
    );
    // the lock instructions of both kinds of coin, and close_holder, do not even take the
    // config writable
    for ix in idl["instructions"].as_array().unwrap() {
        let name = ix["name"].as_str().unwrap();
        let cfg = ix["accounts"].as_array().unwrap().iter().find(|a| a["name"] == "cfg");
        let writable = cfg.map(|a| a["writable"].as_bool().unwrap_or(false)).unwrap_or(false);
        let read_only = matches!(name, "lock_creator" | "unlock_creator" | "lock_creator_strict" | "unlock_creator_strict" | "close_holder" | "init_manifest");
        assert_eq!(writable, !read_only, "{name}");
    }
    assert_eq!(idl["address"].as_str().unwrap(), hook_rules::ID.to_string());
}

// ---- 15. the random walk ------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    /// splitmix64
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }
    /// An amount spread over many magnitudes, from `lo` up to about `hi`.
    fn amount(&mut self, lo: u64, hi: u64) -> u64 {
        let mut top = lo.max(1);
        let steps = self.below(64);
        for _ in 0..steps {
            if top >= hi / 2 {
                break;
            }
            top *= 2;
        }
        self.range(lo.max(1), top.max(lo.max(1)).min(hi))
    }
}

#[derive(Default, Debug)]
struct Tally {
    buys: u32,
    buys_refused: u32,
    sells: u32,
    trades_refused_by_the_pool: u32,
    /// Trades made while enough was staked for the stakers to get the holders' share.
    stakers_eligible: u32,
    stakers_not_eligible: u32,
    /// Trades that started below the burn's observation and lowered it.
    observation_lowered: u32,
    in_sniper_window: u32,
    liquidity_added: u32,
    liquidity_refused: u32,
    liquidity_removed: u32,
    stakes: u32,
    unstakes: u32,
    unstakes_refused: u32,
    reward_claims: u32,
    reward_claims_empty: u32,
    creator_claims: u32,
    burns: u32,
    burns_capped: u32,
    burns_observed: u32,
    burns_waited: u32,
    burns_too_soon: u32,
    burns_empty: u32,
    burns_refused: u32,
    /// Where the holders' share went, in units of the quote token.
    holders_to_stakers: u64,
    holders_to_burn: u64,
    donations: u32,
    cap_changes: u32,
    idle: u32,
}

/// `burn_one_in`: a step that draws the burn runs it once in this many times, so that a
/// walk can let the pot grow past the cap of one run.
fn random_walk(seed: u64, steps: u32, args: RulesArgs, lp_fee: u16, burn_one_in: u64) -> Tally {
    println!("random walk: seed {seed}, {steps} steps, pool fee {lp_fee} bps, {args:?}");
    let mut w = world_with(args, lp_fee);
    let mut md = Model::new(args, START_SLOT, MARKET_SUPPLY / 1_000);
    let mut rng = Rng(seed);
    // four wallets that trade, stake and claim; two of them start with coins
    let wallets: Vec<Keypair> = (0..4).map(|i| wallet(&mut w, if i < 2 { 8_000_000_000 } else { 0 }, 5_000 * SOL)).collect();
    for u in &wallets {
        w.env.create_ata(u, &u.pubkey(), &w.k.lp_mint);
    }
    let anyone = w.env.user(10 * SOL);
    let mut tally = Tally::default();
    let caps = [1_000u16, 1_000, 700, 250, 1_000, 0, 1_000];
    let mut slot = START_SLOT;

    for step in 0..steps {
        // time moves: slowly at first, so that many steps fall inside the launch windows
        slot += if step < 60 { rng.below(12) } else { rng.below(900) };
        go(&mut w, slot);
        let who = &wallets[rng.below(4) as usize].insecure_clone();
        let user = who.pubkey();
        let roll = rng.below(100);
        let coins = w.env.balance(&ata(&user, &w.k.base_mint));
        let quote = w.env.balance(&ata(&user, &w.k.quote_mint));
        let in_window = slot - START_SLOT < args.sniper_slots;
        let (eligible, observed) = (md.eligible(), (md.obs_base, md.obs_quote));
        match roll {
            0..=26 => {
                let amount = rng.amount(1, 6 * SOL).min(quote);
                match try_trade(&mut w, &mut md, who, DIRECTION_BUY, amount) {
                    Ok(_) => {
                        tally.buys += 1;
                        tally.in_sniper_window += in_window as u32;
                        if eligible {
                            tally.stakers_eligible += 1
                        } else {
                            tally.stakers_not_eligible += 1
                        }
                        tally.observation_lowered += ((md.obs_base, md.obs_quote) != observed) as u32;
                    }
                    Err("buy above the limit of the launch window") => tally.buys_refused += 1,
                    Err(_) => tally.trades_refused_by_the_pool += 1,
                }
            }
            // liquidity comes and goes. None of it is the hook's business, except that
            // nobody adds any while the sniper fee runs; the accounting must not notice.
            27..=29 => {
                let lp_acc = ata(&user, &w.k.lp_mint);
                let held = w.env.balance(&lp_acc);
                let pool = w.env.pool(&w.k.pool);
                let supply = w.env.mint_supply(&w.k.lp_mint);
                if held >= 100_000 && rng.below(2) == 0 {
                    // leaving is never refused, whatever the window
                    let lp = if rng.below(2) == 0 { held } else { rng.range(100_000, held) };
                    let ix = w.env.remove_liquidity_ix(&user, &w.k, &w.hook, lp, 0, 0);
                    w.env.ok(&[ix], &[who]);
                    tally.liquidity_removed += 1;
                } else {
                    // up to a tenth of the pool, and no more than the wallet can pay for
                    let most = (coins as u128 * supply as u128 / pool.reserve_base as u128)
                        .min(quote as u128 * supply as u128 / pool.reserve_quote as u128)
                        .min(supply as u128 / 10) as u64;
                    if most >= 100_000 {
                        let lp = rng.range(100_000, most);
                        let ix = w.env.add_liquidity_ix(&user, &w.k, &w.hook, lp, u64::MAX, u64::MAX);
                        if in_window {
                            w.env.err(&[ix], &[who], "liquidity cannot be added while the sniper fee runs");
                            tally.liquidity_refused += 1;
                        } else {
                            w.env.ok(&[ix], &[who]);
                            tally.liquidity_added += 1;
                        }
                    } else {
                        tally.idle += 1;
                    }
                }
            }
            30..=54 if coins > 0 => {
                let amount = if rng.below(4) == 0 { coins } else { rng.amount(1, coins) };
                match try_trade(&mut w, &mut md, who, DIRECTION_SELL, amount) {
                    Ok(_) => {
                        tally.sells += 1;
                        if eligible {
                            tally.stakers_eligible += 1
                        } else {
                            tally.stakers_not_eligible += 1
                        }
                        tally.observation_lowered += ((md.obs_base, md.obs_quote) != observed) as u32;
                    }
                    Err(_) => tally.trades_refused_by_the_pool += 1,
                }
            }
            55..=69 if coins > 0 => {
                let amount = if rng.below(3) == 0 { coins } else { rng.amount(1, coins) };
                must(try_stake(&mut w, &mut md, who, amount));
                tally.stakes += 1;
            }
            70..=79 => {
                let staked = md.stakers.get(&user).map(|s| s.amount).unwrap_or(0);
                let amount = match rng.below(5) {
                    0 => staked + 1,
                    1 | 2 => staked,
                    _ => rng.amount(1, staked.max(1)),
                };
                match try_unstake(&mut w, &mut md, who, amount) {
                    Ok(()) => tally.unstakes += 1,
                    Err(_) => tally.unstakes_refused += 1,
                }
            }
            80..=87 => match try_claim_rewards(&mut w, &mut md, who) {
                Ok(_) => tally.reward_claims += 1,
                Err(_) => tally.reward_claims_empty += 1,
            },
            88..=91 => {
                if try_claim_creator(&mut w, &mut md).is_ok() {
                    tally.creator_claims += 1;
                }
            }
            92..=97 if rng.below(burn_one_in) == 0 => {
                let pool = w.env.pool(&w.k.pool);
                let cap = md.burn_cap(&pool);
                match try_run_burn(&mut w, &mut md, &anyone) {
                    Ok(Ran::Bought { spent, .. }) => {
                        tally.burns += 1;
                        tally.burns_capped += (spent == cap) as u32;
                    }
                    Ok(ran) => {
                        if ran == Ran::Observed {
                            tally.burns_observed += 1
                        } else {
                            tally.burns_waited += 1
                        }
                        // whoever runs the burn comes back 25 slots later; nobody traded
                        // in between, so that call buys
                        slot += BURN_INTERVAL_SLOTS;
                        go(&mut w, slot);
                        let pool = w.env.pool(&w.k.pool);
                        let cap = md.burn_cap(&pool);
                        match try_run_burn(&mut w, &mut md, &anyone) {
                            Ok(Ran::Bought { spent, .. }) => {
                                tally.burns += 1;
                                tally.burns_capped += (spent == cap) as u32;
                            }
                            Ok(other) => panic!("the price stood still for 25 slots and the burn did not buy: {other:?}"),
                            Err(_) => tally.burns_refused += 1,
                        }
                    }
                    Err("the burn pot is empty") => tally.burns_empty += 1,
                    Err("observation of the pool is less than 25 slots old") => tally.burns_too_soon += 1,
                    Err(_) => tally.burns_refused += 1,
                }
            }
            98 => {
                let amount = rng.amount(1, SOL);
                w.env.mint_to(&w.m.authority, &w.k.quote_mint, &w.r.treasury, amount);
                md.donated += amount;
                tally.donations += 1;
            }
            99 => {
                md.cap = caps[rng.below(caps.len() as u64) as usize];
                w.env.update_platform(hookpool::UpdatePlatformArgs { max_hook_fee_bps: Some(md.cap), ..Default::default() });
                tally.cap_changes += 1;
            }
            // nothing to sell or stake, or the burn was not drawn: only the clock moved
            _ => tally.idle += 1,
        }
        // after EVERY step, also the ones that failed or only moved the clock
        check(&w, &md);
    }

    // wind down. With the platform cap at zero a trade charges nothing, so one small buy
    // settles the last fee and leaves none behind it.
    w.env.update_platform(hookpool::UpdatePlatformArgs { max_hook_fee_bps: Some(0), ..Default::default() });
    md.cap = 0;
    go(&mut w, slot + hook_rules::UNSTAKE_DELAY_SLOTS);
    let last = wallets[0].insecure_clone();
    assert_eq!(trade(&mut w, &mut md, &last, DIRECTION_BUY, SOL / 100).hook_fee, 0);
    assert_eq!(cfg_of(&w).fees_seen, w.env.pool(&w.k.pool).hook_fees_quote_total);
    // everybody leaves, everything is paid, the pot is burned
    for who in &wallets {
        let staked = md.stakers.get(&who.pubkey()).map(|s| s.amount).unwrap_or(0);
        if staked > 0 {
            must(try_unstake(&mut w, &mut md, who, staked));
        }
        let _ = try_claim_rewards(&mut w, &mut md, who);
    }
    let _ = try_claim_creator(&mut w, &mut md);
    let mut guard = 0;
    while md.burn_pot > 0 {
        let pool = w.env.pool(&w.k.pool);
        if md.burn_plan(&pool, w.env.clock().slot) == Plan::TooSoon {
            let slot = md.obs_slot + BURN_INTERVAL_SLOTS;
            go(&mut w, slot);
        }
        // a pot too small to buy one unit of the coin stays where it is
        if try_run_burn(&mut w, &mut md, &anyone).is_err() {
            break;
        }
        guard += 1;
        assert!(guard < 10_000);
    }
    tally.holders_to_stakers = md.holders_split;
    tally.holders_to_burn = md.holders_burned;
    let cfg = cfg_of(&w);
    let pool = w.env.pool(&w.k.pool);
    let left = w.env.balance(&w.r.treasury);
    println!("{tally:?}");
    println!(
        "hook fees {} = creator {} + holders {} + burn {}; paid: creator {}, rewards {}, burned {}; left in the treasury {} (of which sent by strangers {}, a burn pot too small to buy {})",
        pool.hook_fees_quote_total, md.creator_split, md.holders_split, md.burn_split, cfg.total_creator_paid, cfg.total_rewards_paid, cfg.total_quote_burned, left, md.donated, cfg.burn_pot
    );
    assert_eq!((cfg.total_staked, cfg.rewards_owed_total, cfg.creator_owed), (0, 0, 0));
    assert_eq!(w.env.balance(&w.r.stake_vault), 0, "every staked coin went back");
    assert_eq!(cfg.total_creator_paid, md.creator_split, "the creator was paid every unit of its share");
    assert!(cfg.total_rewards_paid <= md.holders_split);
    assert_eq!(left, md.donated + cfg.burn_pot + (md.holders_split - cfg.total_rewards_paid));
    // rounding kept dust only
    assert!(md.holders_split - cfg.total_rewards_paid <= md.accrues + 5 + (cfg.reward_rem as u128 / ACC) as u64);
    // the walk went through every kind of step
    assert!(tally.buys > 0 && tally.sells > 0 && tally.stakes > 0 && tally.unstakes > 0 && tally.unstakes_refused > 0, "{tally:?}");
    assert!(tally.reward_claims > 0 && tally.creator_claims > 0 && tally.burns > 0, "{tally:?}");
    assert!(tally.stakers_eligible > 0 && tally.stakers_not_eligible > 0, "{tally:?}");
    assert!(tally.holders_to_stakers > 0 && tally.holders_to_burn > 0, "{tally:?}");
    tally
}

/// Replay a failure with the seed it printed: `RULES_WALK_SEED=<seed> bash build.sh test
/// -p hookpool-tests --test rules random_walk`. `RULES_WALK_STEPS` makes it longer.
fn walk_seed(default: u64) -> u64 {
    std::env::var("RULES_WALK_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}
fn walk_steps(default: u32) -> u32 {
    let steps = std::env::var("RULES_WALK_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(default);
    assert!(steps >= 1_000, "at least 1,000 steps");
    steps
}

#[test]
fn a_random_walk_keeps_every_number_exact_and_the_treasury_solvent() {
    // every rule on: sniper fee, buy limit, three rates that differ between buys and sells
    let args = RulesArgs {
        sniper_slots: 600,
        sniper_start_fee_bps: 3_000,
        buy: rates(100, 150, 50),
        sell: rates(50, 200, 100),
        max_buy_quote: 2 * SOL,
        limit_slots: 300,
        creator_lock_seconds: 0,
    };
    let tally = random_walk(walk_seed(20_261_013), walk_steps(1_500), args, 100, 1);
    // with the seed of the suite the walk is known to pass through both launch windows
    if std::env::var("RULES_WALK_SEED").is_err() {
        assert!(tally.buys_refused > 0 && tally.in_sniper_window > 0, "{tally:?}");
        assert!(tally.liquidity_added > 0 && tally.liquidity_refused > 0 && tally.liquidity_removed > 0, "{tally:?}");
        assert!(tally.burns_observed > 0 && tally.burns_waited > 0 && tally.observation_lowered > 0, "{tally:?}");
    }
}

#[test]
fn a_random_walk_with_the_rates_at_their_ceilings_and_a_burn_that_hits_its_cap() {
    // both sides at the 10% ceiling, holders paid on buys only, a pool without a fee of
    // its own, and a burn that runs rarely, so the pot grows past what one run may spend
    let args = RulesArgs { buy: rates(100, 400, 500), sell: rates(500, 0, 500), ..Default::default() };
    let tally = random_walk(walk_seed(12_648_430), walk_steps(1_200), args, 0, 12);
    if std::env::var("RULES_WALK_SEED").is_err() {
        assert!(tally.burns_capped > 0, "{tally:?}");
    }
}

// ---- 15b. what else could go wrong --------------------------------------------------------

#[test]
fn a_pause_of_the_platform_never_locks_money_in_the_hook() {
    let (mut w, mut md) = world(RulesArgs { buy: rates(200, 200, 200), sell: rates(200, 200, 200), ..Default::default() });
    let t = w.m.trader.insecure_clone();
    let creator = w.m.creator.insecure_clone();
    let anyone = w.env.user(SOL);
    stake(&mut w, &mut md, &t, 50_000_000_000);
    trade(&mut w, &mut md, &t, DIRECTION_BUY, 5 * SOL);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 9_000_000_000);
    w.env.ok(&[lock_ix(&w.k, &creator.pubkey(), 1_000_000, START_TIME + DAY)], &[&creator]);
    // the burn has its observation of the pool, and 25 slots pass
    assert_eq!(must(try_run_burn(&mut w, &mut md, &anyone)), Ran::Observed);
    go(&mut w, START_SLOT + BURN_INTERVAL_SLOTS);

    w.env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(true), ..Default::default() });
    // the pool refuses trades, and with them the burn's buy, which is a trade
    let ix = w.env.swap_ix(&t.pubkey(), &w.k, &w.hook, DIRECTION_SELL, 1_000_000, 0);
    w.env.err(&[ix], &[&t], "paused");
    let ix = run_burn_ix(&w.env, &w.k, &anyone.pubkey(), 0);
    w.env.err(&[ix], &[&anyone], "paused");
    check(&w, &md);
    // everything that pays somebody out still works
    must(try_claim_creator(&mut w, &mut md));
    must(try_claim_rewards(&mut w, &mut md, &t));
    stake(&mut w, &mut md, &t, 1_000);
    go(&mut w, START_SLOT + BURN_INTERVAL_SLOTS + hook_rules::UNSTAKE_DELAY_SLOTS);
    must(try_unstake(&mut w, &mut md, &t, 50_000_001_000));
    w.env.set_clock(START_SLOT + 300_000, START_TIME + DAY);
    w.env.ok(&[unlock_ix(&w.k, &creator.pubkey())], &[&creator]);
    assert_eq!(w.env.balance(&w.r.lock_vault), 0);
    // the burn pot waits and is spent once trading is back
    assert!(md.burn_pot > 0);
    w.env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(false), ..Default::default() });
    let (spent, _) = burn_next(&mut w, &mut md, &anyone);
    assert!(spent > 0);
}

#[test]
fn a_config_with_no_rule_at_all_is_a_plain_pool() {
    let (mut w, mut md) = world(RulesArgs::default());
    let t = w.m.trader.insecure_clone();
    let anyone = w.env.user(SOL);
    let pool = w.env.pool(&w.k.pool);
    let q = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!(q, expect_swap(&pool, DIRECTION_BUY, SOL, 0, None));
    stake(&mut w, &mut md, &t, 500_000_000_000);
    let pool = w.env.pool(&w.k.pool);
    let q = trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000_000);
    assert_eq!(q, expect_swap(&pool, DIRECTION_SELL, 1_000_000_000, 0, None));
    assert_eq!(w.env.balance(&w.r.treasury), 0);
    assert_eq!(try_claim_creator(&mut w, &mut md), Err("nothing to claim"));
    assert_eq!(try_claim_rewards(&mut w, &mut md, &t), Err("nothing to claim"));
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err("the burn pot is empty"));
}

#[test]
fn accounts_of_another_pool_or_another_wallet_are_refused() {
    let args = RulesArgs { buy: rates(100, 100, 100), sell: rates(100, 100, 100), ..Default::default() };
    let (mut w, mut md) = world(args);
    let t = w.m.trader.insecure_clone();
    let a = wallet(&mut w, 50_000_000_000, 0);
    let b = wallet(&mut w, 50_000_000_000, 0);
    // a second pool on the same hook: the reversed pair
    let k2 = Env::pool_keys(&w.k.quote_mint, &w.k.base_mint);
    let creator = w.m.creator.insecure_clone();
    let hook2 = w.env.rules_hook(&creator, &k2, args);
    let ix = w.env.create_pool_ix(&creator.pubkey(), &k2, LP_FEE, QUOTE_LIQ, BASE_LIQ, &hook2);
    w.env.ok(&[compute_budget_ix(400_000), ix], &[&creator]);
    let r2 = RulesKeys::of(&k2);
    stake(&mut w, &mut md, &a, 20_000_000_000);
    trade(&mut w, &mut md, &t, DIRECTION_BUY, 2 * SOL);

    // staking somebody else's coins: the token program wants the owner of the account
    let mut ix = stake_ix(&w.k, &b.pubkey(), 1_000);
    ix.accounts[6].pubkey = ata(&a.pubkey(), &w.k.base_mint);
    assert!(w.env.send(&[ix], &[&b]).is_err());
    // the pool account of another pool with this pool's config
    let mut ix = stake_ix(&w.k, &b.pubkey(), 1_000);
    ix.accounts[2].pubkey = k2.pool;
    w.env.err(&[ix], &[&b], "config does not belong to this pool");
    let mut ix = claim_creator_ix(&w.k, &creator.pubkey(), &ata(&creator.pubkey(), &w.k.quote_mint));
    ix.accounts[2].pubkey = k2.pool;
    w.env.err(&[ix], &[&creator], "config does not belong to this pool");
    // the stake vault of another pool
    let mut ix = stake_ix(&w.k, &b.pubkey(), 1_000);
    ix.accounts[5].pubkey = r2.stake_vault;
    w.env.err(&[ix], &[&b], "ConstraintSeeds");
    // the treasury of another pool as the source of a payout
    let mut ix = claim_rewards_ix(&w.k, &a.pubkey(), &ata(&a.pubkey(), &w.k.quote_mint));
    ix.accounts[6].pubkey = r2.treasury;
    w.env.err(&[ix], &[&a], "pool treasury is not this hook's treasury");
    // the authority of another pool
    let mut ix = claim_rewards_ix(&w.k, &a.pubkey(), &ata(&a.pubkey(), &w.k.quote_mint));
    ix.accounts[4].pubkey = r2.authority;
    w.env.err(&[ix], &[&a], "ConstraintSeeds");
    // a payout into an account of another mint
    let ix = claim_rewards_ix(&w.k, &a.pubkey(), &ata(&a.pubkey(), &w.k.base_mint));
    w.env.err(&[ix], &[&a], "ConstraintTokenMint");
    // the burn of this pool with the other pool's burn account
    let anyone = w.env.user(SOL);
    let ix = run_burn_with(&w.env, &w.k, &anyone.pubkey(), &r2.burn_account, 0);
    assert!(w.env.send(&[ix], &[&anyone]).is_err());
    // nobody but the pool's own hook authority runs hook_swap, so the treasury cannot be
    // traded away by a stranger either
    let stranger = wallet(&mut w, 1_000, 1_000);
    let ix = Instruction {
        program_id: hookpool::ID,
        accounts: hookpool::accounts::HookSwap {
            hook_authority: stranger.pubkey(),
            platform: w.env.platform,
            pool: w.k.pool,
            base_mint: w.k.base_mint,
            quote_mint: w.k.quote_mint,
            base_vault: w.k.base_vault,
            quote_vault: w.k.quote_vault,
            hook_base: ata(&stranger.pubkey(), &w.k.base_mint),
            hook_quote: ata(&stranger.pubkey(), &w.k.quote_mint),
            base_token_program: TOKEN,
            quote_token_program: TOKEN,
            event_authority: event_authority_address(&hookpool::ID),
            program: hookpool::ID,
        }
        .to_account_metas(None),
        data: hookpool::instruction::HookSwap { direction: DIRECTION_BUY, amount_in: 1, min_amount_out: 0, authority_bump: 255 }.data(),
    };
    w.env.err(&[ix], &[&stranger], "hook authority PDA does not match");
    check(&w, &md);
}

#[test]
fn nobody_stakes_before_the_pool_exists() {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    env.rules_hook(&m.creator, &k, RulesArgs { buy: rates(0, 100, 0), ..Default::default() });
    let ix = stake_ix(&k, &m.creator.pubkey(), 1_000_000);
    env.err(&[ix], &[&m.creator], "the pool of this config does not exist yet");
    assert_eq!(env.balance(&hook_rules::stake_vault_address(&k.pool)), 0);
}

#[test]
fn a_huge_supply_and_fees_of_a_few_units_stay_exact() {
    // 10^19 units of the coin (the most a u64 holds is 1.8 * 10^19), nearly half of it
    // staked, and trades whose fee is a handful of lamports: the reward of one trade is
    // smaller than one accumulator step and has to wait in the remainder.
    let args = RulesArgs { buy: rates(0, 500, 0), sell: rates(0, 500, 0), ..Default::default() };
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let creator = m.creator.insecure_clone();
    let big = 10_000_000_000_000_000_000u64 - MARKET_SUPPLY;
    env.mint_to(&m.authority, &m.base_mint, &ata(&creator.pubkey(), &m.base_mint), big);
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.rules_hook(&creator, &k, args);
    let ix = env.create_pool_ix(&creator.pubkey(), &k, LP_FEE, 5_000_000_000_000_000_000, 10 * SOL, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&creator]);
    let r = RulesKeys::of(&k);
    let rules = rule_bytes(&env, &r.cfg);
    let mut w = World { env, m, k, hook, r, rules };
    let min = 10_000_000_000_000_000u64;
    assert_eq!(cfg_of(&w).min_eligible, min);
    let mut md = Model::new(args, START_SLOT, min);
    let t = w.m.trader.insecure_clone();

    let staked = 4_000_000_000_000_000_000u64;
    stake(&mut w, &mut md, &creator, staked);
    // one accumulator step is staked / 10^12 = 4,000,000 lamports of rewards
    let mut waited = 0u32;
    for i in 0..40u64 {
        let q = trade(&mut w, &mut md, &t, DIRECTION_BUY, 2_000 + 37 * i);
        assert!(q.hook_fee > 0 && q.hook_fee < 1_000);
        waited += (cfg_of(&w).acc_per_share == 0) as u32;
    }
    assert_eq!(waited, 40, "every one of these rewards is still in the remainder");
    assert!(cfg_of(&w).reward_rem > 0);
    assert_eq!(try_claim_rewards(&mut w, &mut md, &creator), Err("nothing to claim"));
    // a larger trade carries the remainder over the step, and nothing was lost on the way
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    let cfg = cfg_of(&w);
    assert!(cfg.acc_per_share > 0);
    let got = must(try_claim_rewards(&mut w, &mut md, &creator));
    // everything split so far, less the remainder still waiting and one rounding
    let waiting = (cfg_of(&w).reward_rem as u128 / ACC) as u64;
    assert!(md.holders_split - got <= waiting + 2, "{got} of {} with {waiting} waiting", md.holders_split);
    // a second staker with one unit: its share rounds to nothing and nothing breaks
    let b = wallet(&mut w, 10, 0);
    stake(&mut w, &mut md, &b, 1);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000_000_000_000);
    trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL);
    assert_eq!(try_claim_rewards(&mut w, &mut md, &b), Err("nothing to claim"));
    must(try_claim_rewards(&mut w, &mut md, &creator));
    go(&mut w, START_SLOT + hook_rules::UNSTAKE_DELAY_SLOTS);
    must(try_unstake(&mut w, &mut md, &creator, staked));
    must(try_unstake(&mut w, &mut md, &b, 1));
}

#[test]
fn many_steps_in_one_transaction_settle_in_order() {
    // Trades, a stake, both claims and a burn, all in ONE transaction: every instruction
    // sees what the one before it wrote, and each fee is split by the rates of its own
    // trade and by who is staked when it is settled.
    let args = RulesArgs { buy: rates(100, 300, 100), sell: rates(200, 100, 200), ..Default::default() };
    let (mut w, mut md) = world(args);
    let t = w.m.trader.insecure_clone();
    let creator = w.m.creator.insecure_clone();
    let (u, c) = (t.pubkey(), creator.pubkey());
    // before: one buy, and the burn's first call, which only observes the pool
    let f0 = trade(&mut w, &mut md, &t, DIRECTION_BUY, SOL).hook_fee;
    assert_eq!(must(try_run_burn(&mut w, &mut md, &t)), Ran::Observed);
    let slot = START_SLOT + BURN_INTERVAL_SLOTS;
    go(&mut w, slot);

    // the pool as it will be after each step, kept by hand
    let mut p = w.env.pool(&w.k.pool);
    let mut ixs = vec![compute_budget_ix(1_000_000)];
    let mut fees = vec![f0];
    let mut swap = |md: &mut Model, p: &mut hookpool::Pool, ixs: &mut Vec<Instruction>, direction: u8, amount: u64| {
        let q = must(md.swap(p, direction, amount, slot));
        apply_swap(p, direction, &q);
        ixs.push(w.env.swap_ix(&u, &w.k, &w.hook, direction, amount, q.amount_out));
        fees.push(q.hook_fee);
    };
    // a buy with nobody staked: it pays the full 500 bps, as every buy does
    swap(&mut md, &mut p, &mut ixs, DIRECTION_BUY, SOL);
    // a stake between two trades. It settles the buy before it first: nobody was staked,
    // so the holders' part of that buy goes to the burn pot
    must(md.stake(&u, 80_000_000_000, slot, p.hook_fees_quote_total));
    ixs.push(stake_ix(&w.k, &u, 80_000_000_000));
    // the same 500 bps on the next buy, of which 300 will go to the one staker
    swap(&mut md, &mut p, &mut ixs, DIRECTION_BUY, SOL);
    // a sell that takes the price below the burn's observation
    swap(&mut md, &mut p, &mut ixs, DIRECTION_SELL, 30_000_000_000);
    let rewards = must(md.claim_rewards(&u, p.hook_fees_quote_total));
    ixs.push(claim_rewards_ix(&w.k, &u, &ata(&u, &w.k.quote_mint)));
    let creator_fee = must(md.claim_creator(p.hook_fees_quote_total));
    ixs.push(claim_creator_ix(&w.k, &c, &ata(&c, &w.k.quote_mint)));
    // the burn: the observation is 25 slots old and the price is below it, so it buys
    let pot = md.burn_pot;
    let Ran::Bought { spent, q: burn, .. } = must(md.run_burn(&p, 0, slot)) else { panic!("the burn did not buy") };
    apply_swap(&mut p, DIRECTION_BUY, &SwapQuote { hook_fee: 0, ..burn });
    ixs.push(run_burn_ix(&w.env, &w.k, &u, burn.amount_out));
    swap(&mut md, &mut p, &mut ixs, DIRECTION_SELL, 1_000_000_000);
    swap(&mut md, &mut p, &mut ixs, DIRECTION_BUY, SOL / 2);

    let creator_before = w.env.balance(&ata(&c, &w.k.quote_mint));
    let supply = w.env.mint_supply(&w.k.base_mint);
    w.env.ok(&ixs, &[&t, &creator]);
    check(&w, &md);
    let after = w.env.pool(&w.k.pool);
    assert_eq!((after.reserve_base, after.reserve_quote, after.hook_fees_quote_total), (p.reserve_base, p.reserve_quote, p.hook_fees_quote_total));
    assert_eq!(after.swap_count, 7, "six trades and the burn");
    // by hand: the four fees settled before the claims (three buys and a sell)
    assert_eq!(creator_fee, fees[0] * 100 / 500 + fees[1] * 100 / 500 + fees[2] * 100 / 500 + fees[3] * 200 / 500);
    assert_eq!(w.env.balance(&ata(&c, &w.k.quote_mint)) - creator_before, creator_fee);
    // the staker gets the holders' part of the two trades settled after the stake
    let holders = fees[2] * 300 / 500 + fees[3] * 100 / 500;
    assert!(rewards <= holders && holders - rewards <= 2, "{rewards} of {holders}");
    // the pot took the rest of all four: their burn parts, and the holders' parts of the
    // two trades settled while nobody was staked
    assert_eq!(pot, fees[0] + fees[1] + fees[2] + fees[3] - creator_fee - holders);
    assert_eq!(spent, pot, "a pot below the cap is spent whole");
    assert_eq!(supply - w.env.mint_supply(&w.k.base_mint), burn.amount_out);
    // the last two trades pay the same with the stake in place, and the last is unsettled
    assert_eq!(cfg_of(&w).last_split, rates(100, 300, 100));
    assert_eq!(after.hook_fees_quote_total - cfg_of(&w).fees_seen, fees[5]);
}

// ---- 15b2. attacks on the burn ----------------------------------------------------------------
//
// Anyone may run the burn and choose its min_amount_out. What a caller could do with that,
// and what stands against it:
//
// 1. Buy the coin, run the burn at the price that buy made, sell into the price the burn
//    pushed further. Against it: one run spends a share of the quote reserve that follows
//    the fees of a buy and a sell (`burn_cap_bps`, 1 to 50 bps), so the push is worth less
//    than the two trades cost; and runs are 25 slots apart.
// 2. Deepen the pool with liquidity for one transaction, so that the same share is a much
//    larger amount, spent at the pumped price and mostly into the caller's own liquidity.
//    One transaction of BUY, add_liquidity, run_burn, remove_liquidity, SELL ended
//    2 SOL up. Against it: a run buys against an OBSERVATION of the pool that is at least
//    25 slots old, only while the price is within twice the cap of the observed one, and
//    measures its cap on the smaller of the two depths.
// 3. Pump once so that a run records the pumped pool as its observation, sell back in the
//    same transaction, and pump again 25 slots later. Against it: a trade that starts
//    below the observed price lowers the observation, and the second pump is one.
//
// What is left is a pump that really stands for 25 slots, where anyone can sell into it.
// The last on-chain test of this section measures that.

fn apply_swap(p: &mut hookpool::Pool, direction: u8, q: &SwapQuote) {
    if direction == DIRECTION_BUY {
        (p.reserve_quote, p.reserve_base) = (q.reserve_in_after, q.reserve_out_after);
    } else {
        (p.reserve_base, p.reserve_quote) = (q.reserve_in_after, q.reserve_out_after);
    }
    p.hook_fees_quote_total += q.hook_fee;
}

/// The pool's liquidity math, by hand: what `lp` LP tokens cost to add (rounded up) ...
fn lp_cost(p: &hookpool::Pool, supply: u64, lp: u64) -> (u64, u64) {
    let ceil = |r: u64| (lp as u128 * r as u128).div_ceil(supply as u128) as u64;
    (ceil(p.reserve_base), ceil(p.reserve_quote))
}

/// ... and what they give back when removed (rounded down).
fn lp_value(p: &hookpool::Pool, supply: u64, lp: u64) -> (u64, u64) {
    let floor = |r: u64| (lp as u128 * r as u128 / supply as u128) as u64;
    (floor(p.reserve_base), floor(p.reserve_quote))
}

fn lp_account(w: &mut World, who: &Keypair) {
    w.env.create_ata(who, &who.pubkey(), &w.k.lp_mint);
}

/// The burn pot as a run would find it now: with the fee of the last trade settled.
fn pot_now(w: &World, md: &Model) -> u64 {
    let mut probe = md.clone();
    probe.settle(fees_total(w));
    probe.burn_pot
}

/// One transaction of one wallet, built step by step. The pool, the LP supply and the
/// model are kept in step by hand, so every amount in it is exact and `send` checks what
/// the wallet ended with to the unit.
struct Seq {
    who: Pubkey,
    slot: u64,
    md: Model,
    p: hookpool::Pool,
    lp_supply: u64,
    /// What the wallet's coin balance changes by, and the part of it carried in.
    coins: i128,
    carried: i128,
    /// LP tokens the wallet holds.
    lp: u64,
    /// What the wallet's quote balance changes by.
    quote: i128,
    ixs: Vec<Instruction>,
    /// What each run of the burn in it does.
    runs: Vec<Ran>,
}

impl Seq {
    fn new(w: &World, md: &Model, who: &Pubkey) -> Self {
        Seq {
            who: *who,
            slot: w.env.clock().slot,
            md: md.clone(),
            p: w.env.pool(&w.k.pool),
            lp_supply: w.env.mint_supply(&w.k.lp_mint),
            coins: 0,
            carried: 0,
            lp: 0,
            quote: 0,
            ixs: vec![compute_budget_ix(800_000)],
            runs: vec![],
        }
    }

    /// LP tokens and coins the wallet got in an earlier transaction and uses in this one.
    fn carry(&mut self, lp: u64, coins: i128) {
        (self.lp, self.coins, self.carried) = (lp, coins, coins);
    }

    fn buy(&mut self, w: &World, amount: u64) {
        let q = must(self.md.swap(&self.p, DIRECTION_BUY, amount, self.slot));
        apply_swap(&mut self.p, DIRECTION_BUY, &q);
        self.ixs.push(w.env.swap_ix(&self.who, &w.k, &w.hook, DIRECTION_BUY, amount, q.amount_out));
        self.coins += q.amount_out as i128;
        self.quote -= amount as i128;
    }

    /// Sell every coin this sequence got.
    fn sell(&mut self, w: &World) {
        let amount = u64::try_from(self.coins).expect("coins to sell");
        let q = must(self.md.swap(&self.p, DIRECTION_SELL, amount, self.slot));
        apply_swap(&mut self.p, DIRECTION_SELL, &q);
        self.ixs.push(w.env.swap_ix(&self.who, &w.k, &w.hook, DIRECTION_SELL, amount, q.amount_out));
        self.coins = 0;
        self.quote += q.amount_out as i128;
    }

    /// Sell `amount` coins, also coins the wallet held before this sequence.
    fn sell_exact(&mut self, w: &World, amount: u64) {
        let q = must(self.md.swap(&self.p, DIRECTION_SELL, amount, self.slot));
        apply_swap(&mut self.p, DIRECTION_SELL, &q);
        self.ixs.push(w.env.swap_ix(&self.who, &w.k, &w.hook, DIRECTION_SELL, amount, q.amount_out));
        self.coins -= amount as i128;
        self.quote += q.amount_out as i128;
    }

    /// Add `lp` LP tokens of liquidity, with exactly what they cost as the maximum.
    fn add(&mut self, w: &World, lp: u64) {
        let (b, q) = lp_cost(&self.p, self.lp_supply, lp);
        self.ixs.push(w.env.add_liquidity_ix(&self.who, &w.k, &w.hook, lp, b, q));
        (self.p.reserve_base, self.p.reserve_quote) = (self.p.reserve_base + b, self.p.reserve_quote + q);
        self.lp_supply += lp;
        self.lp += lp;
        self.coins -= b as i128;
        self.quote -= q as i128;
    }

    /// Add as liquidity every coin this sequence got, with the quote that goes with it.
    fn add_all(&mut self, w: &World) {
        let coins = u64::try_from(self.coins).expect("coins to add");
        let mut lp = (coins as u128 * self.lp_supply as u128 / self.p.reserve_base as u128) as u64;
        while lp_cost(&self.p, self.lp_supply, lp).0 > coins {
            lp -= 1;
        }
        self.add(w, lp);
    }

    /// Take all of the wallet's liquidity out, with exactly what it gives as the minimum.
    fn remove_all(&mut self, w: &World) {
        let (b, q) = lp_value(&self.p, self.lp_supply, self.lp);
        self.ixs.push(w.env.remove_liquidity_ix(&self.who, &w.k, &w.hook, self.lp, b, q));
        (self.p.reserve_base, self.p.reserve_quote) = (self.p.reserve_base - b, self.p.reserve_quote - q);
        self.lp_supply -= self.lp;
        self.lp = 0;
        self.coins += b as i128;
        self.quote += q as i128;
    }

    /// Run the burn with min_amount_out = 0, as the one who moved the price would.
    fn run(&mut self, w: &World) -> Ran {
        let ran = must(self.md.run_burn(&self.p, 0, self.slot));
        if let Ran::Bought { q, .. } = ran {
            apply_swap(&mut self.p, DIRECTION_BUY, &SwapQuote { hook_fee: 0, ..q });
        }
        self.ixs.push(run_burn_ix(&w.env, &w.k, &self.who, 0));
        self.runs.push(ran);
        ran
    }

    /// The creator takes its fees.
    fn claim_creator(&mut self, w: &World) -> u64 {
        let amount = must(self.md.claim_creator(self.p.hook_fees_quote_total));
        self.ixs.push(claim_creator_ix(&w.k, &self.who, &ata(&self.who, &w.k.quote_mint)));
        self.quote += amount as i128;
        amount
    }

    /// Send it as ONE transaction. Returns what the wallet's quote balance changed by.
    fn send(self, w: &mut World, md: &mut Model, signer: &Keypair) -> i128 {
        let base_acc = ata_with(&self.who, &w.k.base_mint, &w.k.base_program);
        let quote_acc = ata(&self.who, &w.k.quote_mint);
        let (b0, q0) = (w.env.balance(&base_acc) as i128, w.env.balance(&quote_acc) as i128);
        let meta = w.env.ok(&self.ixs, &[signer]);
        // every run in it said what the model said it would do
        let said: Vec<u8> = cpi_events::<hook_rules::BurnExecuted>(&meta).iter().map(|e| e.outcome).collect();
        let expected: Vec<u8> = self
            .runs
            .iter()
            .map(|r| match r {
                Ran::Observed => BURN_OBSERVED,
                Ran::Waited => BURN_WAITED,
                Ran::Bought { .. } => BURN_BOUGHT,
            })
            .collect();
        assert_eq!(said, expected, "outcomes of the runs");
        assert_eq!(w.env.balance(&base_acc) as i128 - b0, self.coins - self.carried, "coins of the wallet");
        let change = w.env.balance(&quote_acc) as i128 - q0;
        assert_eq!(change, self.quote, "quote of the wallet");
        let pool = w.env.pool(&w.k.pool);
        assert_eq!((pool.reserve_base, pool.reserve_quote), (self.p.reserve_base, self.p.reserve_quote));
        *md = self.md;
        check(w, md);
        change
    }
}

/// The same sandwich with the pool's own math and nothing else: what a wallet gains
/// (negative: loses) by buying `a`, having `cap_bps` of the quote reserve spent on a buy
/// that pays no hook fee, and selling. `pot` limits what that buy can spend.
#[allow(clippy::too_many_arguments)]
fn sandwich_math(reserve_base: u64, reserve_quote: u64, protocol: u16, lp: u16, buy_bps: u16, sell_bps: u16, a: u64, pot: u64, cap_bps: u64) -> Option<(i128, i128)> {
    let swap = |d: u8, amount: u64, rb: u64, rq: u64, hook: u16| hookpool::math::quote_swap(d, amount, rb, rq, 0, lp, protocol, hook, None, None).ok();
    // without the burn: what the two trades cost
    let front = swap(DIRECTION_BUY, a, reserve_base, reserve_quote, buy_bps)?;
    let plain = swap(DIRECTION_SELL, front.amount_out, front.reserve_out_after, front.reserve_in_after, sell_bps)?;
    let cost = a as i128 - plain.amount_out as i128;
    // with it
    let spend = pot.min(((front.reserve_in_after as u128 * cap_bps as u128 / 10_000) as u64).max(1));
    let run = swap(DIRECTION_BUY, spend, front.reserve_out_after, front.reserve_in_after, 0)?;
    let back = swap(DIRECTION_SELL, front.amount_out, run.reserve_out_after, run.reserve_in_after, sell_bps)?;
    Some((back.amount_out as i128 - a as i128, cost))
}

/// A coin whose only rule is a burn, traded `round_trips` times there and back while
/// nobody runs the burn.
fn pot_left_to_grow(args: RulesArgs, lp_fee: u16, round_trips: u32, size: u64) -> (World, Model) {
    let mut w = world_with(args, lp_fee);
    let mut md = Model::new(args, START_SLOT, MARKET_SUPPLY / 1_000);
    let t = w.m.trader.insecure_clone();
    for _ in 0..round_trips {
        let q = trade(&mut w, &mut md, &t, DIRECTION_BUY, size);
        trade(&mut w, &mut md, &t, DIRECTION_SELL, q.amount_out);
    }
    (w, md)
}

/// The setting of the attacks: a coin whose only rule is a 1% burn on each side, a pool
/// fee of 0.3%, and a pot nobody ran for a long time. Somebody ran the burn once, 25
/// slots ago, so it has its observation of the pool. Returns a keeper and a wallet with
/// 5,000 SOL and no coin.
fn a_pot_worth_attacking() -> (World, Model, Keypair, Keypair) {
    let args = RulesArgs { buy: rates(0, 0, 100), sell: rates(0, 0, 100), ..Default::default() };
    let (mut w, mut md) = pot_left_to_grow(args, LP_FEE, 42, 10 * SOL);
    // sure: 0.2% + 1% + 1%; soft: 0.2% + 2 * 0.3%; 3% together, a quarter is 0.75%, capped
    // at 0.5%
    assert_eq!(md.burn_cap_bps(LP_FEE), 50);
    let keeper = w.env.user(SOL);
    let attacker = wallet(&mut w, 0, 5_000 * SOL);
    lp_account(&mut w, &attacker);
    assert_eq!(must(try_run_burn(&mut w, &mut md, &keeper)), Ran::Observed);
    go(&mut w, START_SLOT + BURN_INTERVAL_SLOTS);
    assert!(pot_now(&w, &md) > 8 * SOL);
    (w, md, keeper, attacker)
}

#[test]
fn the_five_instruction_sequence_finds_the_burn_waiting_and_ends_in_a_loss() {
    let (mut w, mut md, keeper, attacker) = a_pot_worth_attacking();
    let a = attacker.pubkey();
    let pot = pot_now(&w, &md);
    let honest = w.env.pool(&w.k.pool);

    // The reviewer's transaction: BUY 400 SOL, add every coin bought as liquidity, run
    // the burn, take the liquidity out, sell. Before the observation the run spent 12
    // SOL, a slice of the deepened pool, at 25 times the price and mostly into the
    // wallet's own liquidity; the wallet ended 2 SOL up.
    let mut s = Seq::new(&w, &md, &a);
    s.buy(&w, 400 * SOL);
    s.add_all(&w);
    assert!(s.p.reserve_quote > 20 * honest.reserve_quote, "the pool looks more than twenty times deeper");
    assert!(
        s.p.reserve_quote as u128 * honest.reserve_base as u128 > 20 * honest.reserve_quote as u128 * s.p.reserve_base as u128,
        "and the price is more than twenty times the observed one"
    );
    assert_eq!(s.run(&w), Ran::Waited, "the run buys nothing at a price that is not the observed one");
    s.remove_all(&w);
    s.sell(&w);
    let first = s.send(&mut w, &mut md, &attacker);
    println!("BUY 400 SOL, add_liquidity, run_burn, remove_liquidity, SELL: the run waited, the wallet's balance changed by {first} lamports");
    assert!(first < -9 * SOL as i128, "{first}");
    assert_eq!(md.burns, 0);
    // the pot only grew, by the burn fee of the wallet's own two trades
    assert!(pot_now(&w, &md) > pot + 7 * SOL);

    // That run recorded the pumped pool as its observation. If nothing lowered it, the
    // same transaction 25 slots later would find the price "unchanged" and buy: 12 SOL
    // spent, the wallet 2 SOL up on that transaction, and nobody ever exposed to
    // anything. But the second pump is a buy that starts at the honest price, and a
    // trade that starts below the observed price lowers the observation.
    let pumped = (md.obs_base, md.obs_quote);
    go(&mut w, START_SLOT + 2 * BURN_INTERVAL_SLOTS);
    let before = w.env.pool(&w.k.pool);
    let mut s = Seq::new(&w, &md, &a);
    s.buy(&w, 400 * SOL);
    assert_ne!((s.md.obs_base, s.md.obs_quote), pumped);
    assert_eq!((s.md.obs_base, s.md.obs_quote), (before.reserve_base, before.reserve_quote), "the observation is the pool that buy started from");
    s.add_all(&w);
    assert_eq!(s.run(&w), Ran::Waited);
    s.remove_all(&w);
    s.sell(&w);
    let second = s.send(&mut w, &mut md, &attacker);
    println!("the same transaction 25 slots later: the run waited again, the wallet's balance changed by {second} lamports");
    assert!(second < -9 * SOL as i128, "{second}");
    assert_eq!(md.burns, 0, "nothing was ever bought at a pumped price");

    // the burn itself goes on: 25 slots later it buys, a slice of the pool as it is
    let pool = w.env.pool(&w.k.pool);
    let (spent, _) = burn_next(&mut w, &mut md, &keeper);
    assert_eq!(spent, pool.reserve_quote * 50 / 10_000);
    assert_eq!(md.burns, 1);
}

#[test]
fn inside_the_tolerance_a_run_spends_a_slice_of_the_observed_pool_and_the_sequence_loses() {
    let (mut w, mut md, _keeper, attacker) = a_pot_worth_attacking();
    let a = attacker.pubkey();
    // a buy small enough to leave the price within 1% of the observation gets its run
    for (n, size) in [SOL / 10, SOL * 45 / 100].into_iter().enumerate() {
        go(&mut w, START_SLOT + (n as u64 + 1) * BURN_INTERVAL_SLOTS);
        let mut s = Seq::new(&w, &md, &a);
        s.buy(&w, size);
        s.add_all(&w);
        // the pool is deeper now than the observed one: the slice is of the observed one
        assert!(s.md.obs_quote < s.p.reserve_quote);
        let slice = s.md.obs_quote * 50 / 10_000;
        let Ran::Bought { spent, .. } = s.run(&w) else { panic!("{size} is inside the tolerance") };
        assert_eq!(spent, slice);
        s.remove_all(&w);
        s.sell(&w);
        let change = s.send(&mut w, &mut md, &attacker);
        println!("BUY {size}, add_liquidity, run_burn (bought {spent}), remove_liquidity, SELL: the wallet's balance changed by {change} lamports");
        assert!(change < 0, "{size}: {change}");
    }
    // one size up the price is more than 1% above the observation: no run
    go(&mut w, START_SLOT + 3 * BURN_INTERVAL_SLOTS);
    let mut s = Seq::new(&w, &md, &a);
    s.buy(&w, 2 * SOL);
    assert_eq!(s.run(&w), Ran::Waited);
    s.sell(&w);
    assert!(s.send(&mut w, &mut md, &attacker) < 0);
}

#[test]
fn liquidity_added_for_one_transaction_does_not_raise_what_a_run_spends() {
    let (mut w, mut md, _keeper, _attacker) = a_pot_worth_attacking();
    // a wallet that holds a lot of the coin makes the pool twelve times deeper, runs the
    // burn and leaves, without touching the price
    let whale = wallet(&mut w, 20 * BASE_LIQ, 5_000 * SOL);
    lp_account(&mut w, &whale);
    let honest = w.env.pool(&w.k.pool);
    let supply = w.env.mint_supply(&w.k.lp_mint);
    let mut s = Seq::new(&w, &md, &whale.pubkey());
    s.add(&w, 11 * supply);
    assert_eq!(s.p.reserve_quote, 12 * honest.reserve_quote);
    let Ran::Bought { spent, burned, .. } = s.run(&w) else { panic!("the price did not move: the run buys") };
    assert_eq!(spent, honest.reserve_quote * 50 / 10_000, "a slice of the observed pool, not of the twelve times deeper one");
    s.remove_all(&w);
    let coins = s.coins;
    let change = s.send(&mut w, &mut md, &whale);
    // What the wallet has for it is what liquidity has from any buy: it was eleven
    // twelfths of the pool while the burn bought, so it sold the burn that share of the
    // coins, at the price the burn paid.
    println!("liquidity alone: the run spent {spent} and burned {burned}; the wallet ended with {change} lamports more and {} coins less", -coins);
    assert!(coins < 0 && change > 0);
    assert!(change as u64 <= spent * 11 / 12 + 1 && (-coins) as u64 <= burned * 11 / 12 + 1);

    // What is left, measured: liquidity that is there at TWO runs in a row. The run above
    // recorded the pool as it left it, with the wallet's liquidity in it, and no trade
    // started below that price since. The same transaction 25 slots later is measured
    // against that record: a slice of the deepened pool, at the honest price.
    go(&mut w, START_SLOT + 2 * BURN_INTERVAL_SLOTS);
    let supply = w.env.mint_supply(&w.k.lp_mint);
    let mut s = Seq::new(&w, &md, &whale.pubkey());
    s.add(&w, 11 * supply);
    let Ran::Bought { spent: again, .. } = s.run(&w) else { panic!("the price did not move: the run buys") };
    s.remove_all(&w);
    let change = s.send(&mut w, &mut md, &whale);
    println!("the same transaction at the next run: it spent {again}, {} slices of the pool without the wallet's liquidity; the wallet ended with {change} lamports more", again / spent);
    assert!(again > 10 * spent, "this residual is gone: say so in RULES.md and HOOKS.md");
    // a trade that starts below the recorded price takes the record back to the pool as
    // it really is: the depth of a lowered observation is never above the pool's
    let t = w.m.trader.insecure_clone();
    assert!(md.obs_quote > 11 * honest.reserve_quote, "the record still has the wallet's liquidity in it");
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000);
    let pool = w.env.pool(&w.k.pool);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000);
    assert_eq!((md.obs_base, md.obs_quote), (pool.reserve_base, pool.reserve_quote), "the pool as that sell found it");
    assert!(md.obs_quote * 10 < 12 * honest.reserve_quote);
}

#[test]
fn liquidity_and_a_nudge_of_the_price_do_not_raise_what_a_run_spends() {
    // One transaction by a wallet that holds a lot of the coin: add_liquidity (the pool
    // is twelve times deeper), a small SELL (it starts AT the observed price and leaves
    // the price just below it), a second small SELL (it starts below the observed price,
    // so the observation is lowered), run_burn, remove_liquidity. When the lowering
    // copied the pool's reserves, the second sell wrote the deepened pool into the
    // observation with its old slot, and the run spent a slice of that: twelve honest
    // slices in one call, 6.17 SOL instead of 0.51. The lowering moves the observed
    // price and never raises the observed depth.
    let (mut w, mut md, _keeper, _attacker) = a_pot_worth_attacking();
    let whale = wallet(&mut w, 20 * BASE_LIQ, 5_000 * SOL);
    lp_account(&mut w, &whale);
    let honest = w.env.pool(&w.k.pool);
    assert_eq!((md.obs_base, md.obs_quote), (honest.reserve_base, honest.reserve_quote), "the observation is the pool as it is");
    let slice = honest.reserve_quote * 50 / 10_000;
    let pot = pot_now(&w, &md);
    assert!(pot > 12 * slice, "the pot could fill a slice of the deepened pool");
    let supply = w.env.mint_supply(&w.k.lp_mint);

    let mut s = Seq::new(&w, &md, &whale.pubkey());
    s.add(&w, 11 * supply);
    assert_eq!(s.p.reserve_quote, 12 * honest.reserve_quote);
    s.sell_exact(&w, 1_000_000);
    assert_eq!((s.md.obs_base, s.md.obs_quote), (honest.reserve_base, honest.reserve_quote), "the first sell starts at the observed price");
    let (rb, rq) = (s.p.reserve_base, s.p.reserve_quote);
    s.sell_exact(&w, 1_000_000);
    // the second starts below it: the observed price is now the price that sell started
    // at, to the unit, and the observed depth is what it was
    assert_eq!(s.md.obs_quote, honest.reserve_quote, "the observed depth did not move");
    assert!(s.md.obs_base > honest.reserve_base);
    assert!(s.md.obs_quote as u128 * rb as u128 <= s.md.obs_base as u128 * rq as u128, "not above the price the trade started at");
    assert!(s.md.obs_quote as u128 * rb as u128 > (s.md.obs_base - 1) as u128 * rq as u128, "and one unit of base less would be");
    assert_eq!(s.md.obs_slot, START_SLOT, "and it is as old as it was");
    let Ran::Bought { spent, .. } = s.run(&w) else { panic!("the price is a hair below the observed one: the run buys") };
    assert_eq!(spent, slice, "one slice of the pool as it was observed, not of the twelve times deeper one");
    s.remove_all(&w);
    let change = s.send(&mut w, &mut md, &whale);
    println!("add_liquidity, SELL, SELL, run_burn, remove_liquidity: the run spent {spent} (an honest slice is {slice}); the wallet's quote changed by {change} lamports");
    // the pot is still there for the next runs, 25 slots apart
    assert!(md.burn_pot > 11 * slice);
    assert_eq!(md.burns, 1);
}

#[test]
fn a_pump_only_pays_when_it_stands_in_the_open_for_the_whole_interval() {
    // What the observation does not stop, measured: a wallet that pumps the price, lets
    // a run record the pumped pool, and LEAVES the pump and its liquidity standing for 25
    // slots. If no trade starts below that price in the meantime, the next run buys at
    // it. The wallet is exposed all that time: the pumped price is there for every holder.
    let pump = |w: &mut World, md: &mut Model, attacker: &Keypair| -> (i128, u64, i128, i128) {
        let mut s = Seq::new(w, md, &attacker.pubkey());
        s.buy(w, 400 * SOL);
        s.add_all(w);
        let capital = -s.quote;
        assert_eq!(s.run(w), Ran::Waited);
        let (lp, left) = (s.lp, s.coins);
        (s.send(w, md, attacker), lp, left, capital)
    };
    let unwind = |w: &mut World, md: &mut Model, attacker: &Keypair, lp: u64, left: i128| -> (i128, u64) {
        let mut s = Seq::new(w, md, &attacker.pubkey());
        s.carry(lp, left);
        let Ran::Bought { spent, .. } = s.run(w) else { panic!("the price is not above the observed one: the run buys") };
        s.remove_all(w);
        s.sell(w);
        (s.send(w, md, attacker), spent)
    };

    // 1. nobody sells into it
    let (mut w, mut md, _keeper, attacker) = a_pot_worth_attacking();
    let honest = w.env.pool(&w.k.pool);
    let (out, lp, left, capital) = pump(&mut w, &mut md, &attacker);
    go(&mut w, START_SLOT + 2 * BURN_INTERVAL_SLOTS);
    let (back, spent) = unwind(&mut w, &mut md, &attacker, lp, left);
    let total = out + back;
    println!(
        "a pump that stood for 25 slots with nobody selling: {capital} lamports committed, the run spent {spent} ({} honest slices), the wallet ended {total} lamports up",
        spent / (honest.reserve_quote * 50 / 10_000)
    );
    assert!(spent > 20 * (honest.reserve_quote * 50 / 10_000), "a slice of the pumped and deepened pool");
    assert!(total > 0, "this residual is gone: say so in RULES.md and HOOKS.md");
    assert!(total < 3 * SOL as i128 && capital > 2_000 * SOL as i128);

    // 2. one holder sells a thousandth of the pool's coins into the pumped price
    let (mut w, mut md, _keeper, attacker) = a_pot_worth_attacking();
    let honest = w.env.pool(&w.k.pool);
    let (out, lp, left, _) = pump(&mut w, &mut md, &attacker);
    go(&mut w, START_SLOT + BURN_INTERVAL_SLOTS + 10);
    let holder = w.m.trader.insecure_clone();
    let coins = 1_000_000_000u64;
    let worth = (coins as u128 * honest.reserve_quote as u128 / honest.reserve_base as u128) as u64;
    let got = trade(&mut w, &mut md, &holder, DIRECTION_SELL, coins).amount_out;
    go(&mut w, START_SLOT + 2 * BURN_INTERVAL_SLOTS);
    let (back, _) = unwind(&mut w, &mut md, &attacker, lp, left);
    let total = out + back;
    println!("the same with one holder selling {coins} coins, worth {worth} lamports at the honest price: the holder got {got}, the wallet ended at {total} lamports");
    assert!(got > 20 * worth);
    assert!(total < 0, "{total}");
}

#[test]
fn the_creator_cannot_sandwich_its_own_burn() {
    // A creator fee of 5% and a burn of 0.05% on each side. The creator gets its 5% back
    // through claim_creator, so to the creator a buy and a sell cost what they cost on a
    // coin with a hook fee of 0.05%.
    let args = RulesArgs { buy: rates(500, 0, 5), sell: rates(500, 0, 5), ..Default::default() };
    let (mut w, mut md) = pot_left_to_grow(args, LP_FEE, 80, 10 * SOL);
    // sure: 0.2% + 0.05% + 0.05%, the creator's rate left out; soft: 0.8%, counted up to
    // sure; a quarter of 0.6%
    assert_eq!(md.burn_cap_bps(LP_FEE), 15);
    // With the creator's rate counted as a cost the cap was at its ceiling, and a creator
    // five times the size of the pool came out ahead around one run.
    assert_eq!(burn_cap_bps(PROTOCOL_FEE_BPS, LP_FEE, 505, 505), 50);
    let (rb, rq) = (BASE_LIQ, QUOTE_LIQ);
    let (old, _) = sandwich_math(rb, rq, PROTOCOL_FEE_BPS, LP_FEE, 5, 5, 5 * rq, u64::MAX, 50).unwrap();
    let (new, _) = sandwich_math(rb, rq, PROTOCOL_FEE_BPS, LP_FEE, 5, 5, 5 * rq, u64::MAX, 15).unwrap();
    assert!(old > 0 && new < 0, "{old} {new}");

    let keeper = w.env.user(SOL);
    let creator = w.m.creator.insecure_clone();
    let c = creator.pubkey();
    // what the creator earned before is not part of the sandwich
    must(try_claim_creator(&mut w, &mut md));
    assert_eq!(must(try_run_burn(&mut w, &mut md, &keeper)), Ran::Observed);
    let slice = w.env.pool(&w.k.pool).reserve_quote * 15 / 10_000;
    assert!(pot_now(&w, &md) > 3 * slice, "the pot fills three runs");
    // inside the tolerance of 0.3%: BUY, run_burn, SELL, claim_creator
    for (n, size) in [SOL / 20, SOL / 10, SOL * 13 / 100].into_iter().enumerate() {
        go(&mut w, START_SLOT + (n as u64 + 1) * BURN_INTERVAL_SLOTS);
        let mut s = Seq::new(&w, &md, &c);
        s.buy(&w, size);
        let Ran::Bought { spent, .. } = s.run(&w) else { panic!("{size} is inside the tolerance") };
        s.sell(&w);
        let back = s.claim_creator(&w);
        let change = s.send(&mut w, &mut md, &creator);
        println!("the creator: BUY {size}, run_burn (bought {spent}), SELL, claim_creator ({back}): its balance changed by {change} lamports");
        assert!(spent >= slice && back > 0);
        assert!(change < 0, "{size}: {change}");
    }
    // a larger position does not get a run at all
    go(&mut w, START_SLOT + 4 * BURN_INTERVAL_SLOTS);
    let mut s = Seq::new(&w, &md, &c);
    s.buy(&w, 40 * SOL);
    assert_eq!(s.run(&w), Ran::Waited);
    s.sell(&w);
    s.claim_creator(&w);
    let change = s.send(&mut w, &mut md, &creator);
    println!("the creator with 40 SOL: the run waited, its balance changed by {change} lamports");
    assert!(change < 0);
}

// The cap alone, with the pool's own math: before any observation, a sandwich around one
// run already lost at every fee level and every size. The observation is not instead of
// this; it closes what liquidity opened.

#[test]
fn the_cap_makes_a_one_run_sandwich_lose_at_every_fee_level_and_every_size() {
    // The reasoning behind the cap, checked with the pool's own math over a grid: fees of
    // every size, positions from a ten-thousandth of the reserve to a thousand times the
    // reserve, a pot that always fills the run. "gain" is what the run adds to what the
    // wallet gets back; "cost" is what its two trades cost without any run.
    let (rb, rq) = (1_000_000_000_000u64, 100 * SOL);
    let levels = [0u16, 1, 2, 5, 25, 100, 500, 1_000];
    let sizes = [rq / 10_000, rq / 100, rq / 10, rq / 2, rq, 5 * rq, 50 * rq, 1_000 * rq];
    let (mut worst, mut worst_at) = (0f64, String::new());
    let mut checked = 0u32;
    let mut free = vec![];
    for protocol in [0u16, 1, 2, 5, 20, 100] {
        for lp in [0u16, 1, 30, 100, 1_000] {
            for buy in levels {
                for sell in levels {
                    let sure = protocol as u64 + buy as u64 + sell as u64;
                    let soft = protocol as u64 + 2 * lp as u64;
                    let cap = burn_cap_bps(protocol, lp, buy, sell);
                    assert_eq!(cap, ((sure + soft.min(sure)) / 4).clamp(1, 50));
                    for a in sizes {
                        let Some((profit, cost)) = sandwich_math(rb, rq, protocol, lp, buy, sell, a, u64::MAX, cap) else { continue };
                        if sure + soft.min(sure) < 4 {
                            // nearly free pools: the floor of 1 bps is all there is, and
                            // the margin is gone
                            if profit >= 0 {
                                free.push((sure, soft, a, profit));
                            }
                            continue;
                        }
                        checked += 1;
                        assert!(profit < 0, "protocol {protocol} lp {lp} buy {buy} sell {sell} size {a}: a sandwich ends {profit}");
                        let ratio = (profit + cost) as f64 / cost as f64;
                        if ratio > worst {
                            (worst, worst_at) = (ratio, format!("protocol {protocol} lp {lp} buy {buy} sell {sell} size {a}"));
                        }
                    }
                }
            }
        }
    }
    println!("{checked} sandwiches, none paid; the best one gained back {:.1}% of what its trades cost ({worst_at})", worst * 100.0);
    assert!(worst <= 0.56, "the run gave back more than about half of the cost: {worst} at {worst_at}");
    // the corner: possible only with a protocol fee of zero or one basis point
    println!("nearly free pools: {} of the grid's sandwiches did not lose, the best by {:?}", free.len(), free.iter().max_by_key(|f| f.3));
    assert!(!free.is_empty(), "the corner is real: say so when it is gone");
    assert!(free.iter().all(|(sure, _, _, _)| *sure <= 1));
}

#[test]
fn the_fees_a_large_position_gets_back_count_only_up_to_the_ones_it_cannot() {
    // A pool fee of 1%, the protocol's 0.2%, no hook fee. A buy and a sell cost a small
    // position 2.4% together, and a quarter of that, capped, would be 0.5% of the reserve.
    // But the pool fee stays in the reserves, and the protocol fee of a sell is taken in
    // the coin: a wallet thirty times the size of the pool that buys and sells back gets
    // nearly all of that back, and is left with the 0.2% protocol fee of its buy as its
    // cost. For that wallet a run of 0.5% pays.
    let (rb, rq) = (1_000_000_000_000u64, 100 * SOL);
    let a = 30 * rq;
    let (naive, cost) = sandwich_math(rb, rq, 20, 100, 0, 0, a, u64::MAX, 50).unwrap();
    println!("30x the pool, pool fee 1%: its two trades cost {cost} ({} bps of the position); around a run of 50 bps it ends {naive}", cost * 10_000 / a as i128);
    assert!(cost * 10_000 / (a as i128) < 30, "most of the 2.4% came back");
    assert!(naive > 0, "a quarter of the full round trip would let this sandwich pay");
    // the cap in force: sure is 20 bps, the soft 220 count for 20, a quarter of 40 is 10
    assert_eq!(burn_cap_bps(20, 100, 0, 0), 10);
    let (real, _) = sandwich_math(rb, rq, 20, 100, 0, 0, a, u64::MAX, 10).unwrap();
    assert!(real < 0 && (cost + real) * 100 <= cost * 55, "ends {real} on a cost of {cost}");
    // and a small position on the same pool loses far more
    let (small, small_cost) = sandwich_math(rb, rq, 20, 100, 0, 0, rq / 100, u64::MAX, 10).unwrap();
    assert!(small < 0 && (small_cost + small) * 5 < small_cost);
}

/// The pool and the burn with nothing else: the pool's own math, and `burn_step` and
/// `burn_lowered` of the interface crate. For grids too large to run on chain. The pot
/// always fills the run.
#[derive(Clone)]
struct Sim {
    rb: u64,
    rq: u64,
    supply: u64,
    protocol: u16,
    lp: u16,
    buy: u16,
    sell: u16,
    cap: u64,
    /// The observation: slot, base reserve, quote reserve.
    obs: (u64, u64, u64),
    /// What the burn spent.
    spent: u64,
}

impl Sim {
    /// A pool of 100 SOL that was observed as it is in slot 0.
    fn new(protocol: u16, lp: u16, buy: u16, sell: u16) -> Self {
        let (rb, rq) = (BASE_LIQ, QUOTE_LIQ);
        let supply = hookpool::math::isqrt_u128(rb as u128 * rq as u128) as u64;
        Sim { rb, rq, supply, protocol, lp, buy, sell, cap: burn_cap_bps(protocol, lp, buy, sell), obs: (0, rb, rq), spent: 0 }
    }

    fn swap(&mut self, direction: u8, amount: u64) -> Option<u64> {
        if let Some((base, quote)) = burn_lowered(self.obs.1, self.obs.2, self.rb, self.rq) {
            (self.obs.1, self.obs.2) = (base, quote);
        }
        let hook = if direction == DIRECTION_BUY { self.buy } else { self.sell };
        let q = hookpool::math::quote_swap(direction, amount, self.rb, self.rq, 0, self.lp, self.protocol, hook, None, None).ok()?;
        if direction == DIRECTION_BUY {
            (self.rq, self.rb) = (q.reserve_in_after, q.reserve_out_after);
        } else {
            (self.rb, self.rq) = (q.reserve_in_after, q.reserve_out_after);
        }
        Some(q.amount_out)
    }

    fn add(&mut self, lp: u64) -> (u64, u64) {
        let ceil = |r: u64| (lp as u128 * r as u128).div_ceil(self.supply as u128) as u64;
        let (b, q) = (ceil(self.rb), ceil(self.rq));
        (self.rb, self.rq, self.supply) = (self.rb + b, self.rq + q, self.supply + lp);
        (b, q)
    }

    fn remove(&mut self, lp: u64) -> (u64, u64) {
        let floor = |r: u64| (lp as u128 * r as u128 / self.supply as u128) as u64;
        let (b, q) = (floor(self.rb), floor(self.rq));
        (self.rb, self.rq, self.supply) = (self.rb - b, self.rq - q, self.supply - lp);
        (b, q)
    }

    fn run(&mut self, slot: u64) -> BurnStep {
        let step = burn_step(self.obs.1, self.obs.2, self.obs.0, self.rb, self.rq, slot, self.cap);
        match step {
            BurnStep::TooSoon => {}
            BurnStep::Observe | BurnStep::Wait => self.obs = (slot, self.rb, self.rq),
            BurnStep::Buy { max_spend } => {
                if let Ok(q) = hookpool::math::quote_swap(DIRECTION_BUY, max_spend, self.rb, self.rq, 0, self.lp, self.protocol, 0, None, None) {
                    (self.rq, self.rb) = (q.reserve_in_after, q.reserve_out_after);
                    self.spent += max_spend;
                    self.obs = (slot, self.rb, self.rq);
                }
            }
        }
        step
    }

    /// One transaction: BUY `a`, add `halves` halves of the coins bought as liquidity,
    /// run the burn (or not), take the liquidity out, SELL everything. Returns what the
    /// wallet's quote changed by; None when the pool cannot make one of the trades.
    fn sequence(&mut self, a: u64, halves: u64, slot: u64, with_run: bool) -> Option<i128> {
        let mut quote = -(a as i128);
        let mut coins = self.swap(DIRECTION_BUY, a)?;
        let lp = (coins as u128 * halves as u128 / 2 * self.supply as u128 / self.rb as u128) as u64;
        if lp > 0 {
            let (b, q) = self.add(lp);
            coins -= b;
            quote -= q as i128;
        }
        if with_run {
            self.run(slot);
        }
        if lp > 0 {
            let (b, q) = self.remove(lp);
            coins += b;
            quote += q as i128;
        }
        Some(quote + self.swap(DIRECTION_SELL, coins)? as i128)
    }

    /// The largest buy that leaves the price inside the tolerance of the observation:
    /// where a sandwich has the most pump and still gets its run.
    fn edge(&self) -> u64 {
        let gets_a_run = |a: u64| {
            let mut s = self.clone();
            s.swap(DIRECTION_BUY, a).is_some() && matches!(s.run(100), BurnStep::Buy { .. })
        };
        let (mut lo, mut hi) = (0u64, 2 * self.rq);
        while lo + 1 < hi {
            let mid = lo + (hi - lo) / 2;
            if gets_a_run(mid) {
                lo = mid
            } else {
                hi = mid
            }
        }
        lo
    }
}

#[test]
fn no_transaction_around_the_burn_pays_at_any_fee_level_size_or_share_of_liquidity() {
    // The grid of the cap, with the observation and with liquidity: fees of every size,
    // positions from a ten-thousandth of the reserve to a thousand times the reserve and
    // right at the edge of the tolerance, none, half or all of the coins bought added as
    // liquidity around the run, a pot that always fills the run. Each sequence is made
    // twice, 25 slots apart, so that the second one meets the observation the first left.
    let levels = [0u16, 1, 2, 5, 25, 100, 500, 1_000];
    let (mut checked, mut got_a_run, mut waited) = (0u32, 0u32, 0u32);
    let (mut worst, mut worst_at) = (0f64, String::new());
    let mut free = vec![];
    for protocol in [0u16, 1, 2, 5, 20, 100] {
        for lp in [0u16, 1, 30, 100, 1_000] {
            for buy in levels {
                for sell in levels {
                    let base = Sim::new(protocol, lp, buy, sell);
                    let rq = base.rq;
                    let sure = protocol as u64 + buy as u64 + sell as u64;
                    let soft = protocol as u64 + 2 * lp as u64;
                    let edge = base.edge();
                    for a in [rq / 10_000, rq / 1_000, rq / 100, rq / 10, rq, 50 * rq, 1_000 * rq, edge / 4, edge / 2, edge, edge + 1] {
                        if a == 0 {
                            continue;
                        }
                        for halves in 0..=2u64 {
                            // what the same trades cost without any run
                            let Some(plain) = base.clone().sequence(a, halves, 100, false) else { continue };
                            let cost = -plain;
                            let mut s = base.clone();
                            let Some(first) = s.sequence(a, halves, 100, true) else { continue };
                            let ran = s.spent > 0;
                            let Some(second) = s.sequence(a, halves, 125, true) else { continue };
                            if sure + soft.min(sure) < 4 {
                                // nearly free pools: the floor of 1 bps is all there is,
                                // and the margin is gone
                                if first >= 0 || second >= 0 {
                                    free.push((sure, soft, a, first.max(second)));
                                }
                                continue;
                            }
                            checked += 1;
                            if ran {
                                got_a_run += 1;
                            } else {
                                waited += 1;
                                assert_eq!(first, plain, "a run that waits changes nothing for the wallet");
                            }
                            let at = || format!("protocol {protocol} lp {lp} buy {buy} sell {sell} size {a} liquidity {halves}/2");
                            assert!(first < 0, "{}: the sequence ends {first}", at());
                            assert!(second < 0, "{}: made again 25 slots later it ends {second}", at());
                            let ratio = (first.max(second) + cost) as f64 / cost as f64;
                            if ratio > worst {
                                (worst, worst_at) = (ratio, at());
                            }
                        }
                    }
                }
            }
        }
    }
    println!("{checked} sequences made twice ({got_a_run} got a run, {waited} found it waiting), none paid; the best one gained back {:.1}% of what its trades cost ({worst_at})", worst * 100.0);
    assert!(got_a_run > 1_000 && waited > 1_000);
    assert!(worst <= 0.56, "the run gave back more than about half of the cost: {worst} at {worst_at}");
    // the corner: possible only with a protocol fee of zero or one basis point
    println!("nearly free pools: {} of the grid's sequences did not lose, the best by {:?}", free.len(), free.iter().max_by_key(|f| f.3));
    assert!(free.iter().all(|(sure, _, _, _)| *sure <= 1));
}

#[test]
fn a_deep_add_and_small_trades_never_make_a_run_spend_more_than_a_slice_of_the_observed_depth() {
    // One transaction: liquidity that makes the pool 2, 12 or 101 times deeper, then one
    // to three small trades that leave the price inside the tolerance (some start below
    // the observed price and lower it), then the run. At every fee level, whatever the
    // trades, the run spends at most its cap of the depth that was observed before.
    let levels = [0u16, 1, 2, 5, 25, 100, 500, 1_000];
    const SELL: u8 = DIRECTION_SELL;
    const BUY: u8 = DIRECTION_BUY;
    let patterns: [&[u8]; 7] = [&[], &[SELL], &[SELL, SELL], &[SELL, SELL, SELL], &[BUY], &[BUY, SELL, SELL], &[SELL, BUY, SELL]];
    let (mut made, mut lowered, mut bought) = (0u32, 0u32, 0u32);
    for protocol in [0u16, 1, 2, 5, 20, 100] {
        for lp in [0u16, 1, 30, 100, 1_000] {
            for buy in levels {
                for sell in levels {
                    let base = Sim::new(protocol, lp, buy, sell);
                    let slice = ((base.rq as u128 * base.cap as u128 / 10_000) as u64).max(1);
                    for k in [1u64, 11, 100] {
                        for pattern in patterns {
                            // sizes: a millionth of the deepened pool, and a third of the cap
                            for parts in [1_000_000u64, 30_000 / base.cap] {
                                let mut s = base.clone();
                                s.add(k * s.supply);
                                let deep = s.rq;
                                for direction in pattern {
                                    let amount = if *direction == BUY { s.rq / parts } else { s.rb / parts };
                                    if s.swap(*direction, amount.max(1)).is_none() {
                                        break;
                                    }
                                }
                                made += 1;
                                lowered += ((s.obs.1, s.obs.2) != (base.rb, base.rq)) as u32;
                                assert!(s.obs.2 <= base.rq, "the observed depth was raised from {} to {} (the pool is {deep})", base.rq, s.obs.2);
                                assert_eq!(s.obs.0, 0, "the slot of the observation moved");
                                let step = s.run(100);
                                bought += (s.spent > 0) as u32;
                                assert!(
                                    s.spent <= slice,
                                    "protocol {protocol} lp {lp} buy {buy} sell {sell}, {k}x deeper, trades {pattern:?} of 1/{parts}: {step:?} spent {} of a slice of {slice}",
                                    s.spent
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    println!("{made} sequences of a deep add, small trades and a run: {lowered} lowered the observation, {bought} runs bought, none spent more than a slice of the observed depth");
    assert!(lowered > 10_000 && bought > 10_000);
}

// ---- 15b3. liquidity while the sniper fee runs -------------------------------------------------

#[test]
fn nobody_adds_liquidity_while_the_sniper_fee_runs_and_leaving_is_never_refused() {
    const REFUSED: &str = "liquidity cannot be added while the sniper fee runs";
    let args = RulesArgs { sniper_slots: 100, sniper_start_fee_bps: 3_000, ..Default::default() };
    // the pool's own liquidity comes through create_pool, in the first slot of the window
    let (mut w, mut md) = world(args);
    let pool = w.env.pool(&w.k.pool);
    assert_eq!((pool.reserve_base, pool.reserve_quote), (BASE_LIQ, QUOTE_LIQ));
    assert_eq!(pool.hook_flags & (BEFORE_ADD_LIQ | AFTER_ADD_LIQ | BEFORE_REMOVE_LIQ | AFTER_REMOVE_LIQ), BEFORE_ADD_LIQ);
    let creator = w.m.creator.insecure_clone();
    let t = w.m.trader.insecure_clone();
    lp_account(&mut w, &t);
    let supply = w.env.mint_supply(&w.k.lp_mint);
    let lp = supply / 10;
    assert!(w.env.balance(&ata(&creator.pubkey(), &w.k.lp_mint)) > lp, "this creator holds the pool's LP tokens");

    // in the launch slot and in the last slot of the window: refused, for the creator too
    for (slot, who) in [(START_SLOT, &creator), (START_SLOT, &t), (START_SLOT + 99, &creator), (START_SLOT + 99, &t)] {
        go(&mut w, slot);
        let ix = w.env.add_liquidity_ix(&who.pubkey(), &w.k, &w.hook, lp, u64::MAX, u64::MAX);
        let failed = w.env.err(&[ix], &[who], REFUSED);
        assert!(failed.meta.logs.iter().any(|l| l.contains("Error Number: 6033")), "{:?}", failed.meta.logs);
    }
    assert_eq!(w.env.mint_supply(&w.k.lp_mint), supply);
    // a sniper pays the fee of that slot, and all of it goes to the liquidity that was
    // there when the pool was created
    let q = trade(&mut w, &mut md, &t, DIRECTION_BUY, 10 * SOL);
    assert_eq!(q.fee_bps_applied, 3_000 - (2_970u64 * 99 / 100) as u16);
    assert_eq!(w.env.pool(&w.k.pool).reserve_quote, QUOTE_LIQ + q.net_in + q.lp_fee);
    // leaving is never refused, inside the window as outside it
    let ix = w.env.remove_liquidity_ix(&creator.pubkey(), &w.k, &w.hook, lp, 0, 0);
    let meta = w.env.ok(&[ix], &[&creator]);
    assert!(hook_units(&meta).is_empty(), "the hook is not asked about a withdrawal");
    assert_eq!(w.env.mint_supply(&w.k.lp_mint), supply - lp);

    // one slot later the window is over and liquidity is welcome
    go(&mut w, START_SLOT + 100);
    for who in [&creator, &t] {
        let ix = w.env.add_liquidity_ix(&who.pubkey(), &w.k, &w.hook, lp, u64::MAX, u64::MAX);
        let meta = w.env.ok(&[ix], &[who]);
        assert_eq!(hook_units(&meta).len(), 1);
    }
    assert_eq!(w.env.mint_supply(&w.k.lp_mint), supply + lp);
    check(&w, &md);

    // a coin without a sniper window never refuses liquidity
    let (mut w, md) = world(RulesArgs { buy: rates(100, 0, 0), ..Default::default() });
    let t = w.m.trader.insecure_clone();
    lp_account(&mut w, &t);
    let ix = w.env.add_liquidity_ix(&t.pubkey(), &w.k, &w.hook, lp, u64::MAX, u64::MAX);
    w.env.ok(&[ix], &[&t]);
    check(&w, &md);

    // a launch through the launchpad, with a sniper window and a first buy: the pool gets
    // its liquidity in the launch transaction as before, and the launcher cannot add to it
    let Launched { mut env, m: _m, dev, k, hook } = launch_step_one(args);
    let d = dev.pubkey();
    let ixs = [
        compute_budget_ix(400_000),
        launch_ix(&env, &d, &k, &hook, hooklaunch::LaunchArgs { lp_fee_bps: LP_FEE, base_amount: SUPPLY, quote_amount: 10 * SOL, dev_buy_quote: SOL, min_dev_buy_out: 0 }),
    ];
    env.ok(&ixs, &[&dev]);
    let pool = env.pool(&k.pool);
    assert!(pool.reserve_quote > 10 * SOL && pool.swap_count == 1);
    env.create_ata(&dev, &d, &k.lp_mint);
    let ix = env.add_liquidity_ix(&d, &k, &hook, env.mint_supply(&k.lp_mint) / 1_000, u64::MAX, u64::MAX);
    env.err(std::slice::from_ref(&ix), &[&dev], REFUSED);
    env.set_clock(START_SLOT + 100, START_TIME);
    env.ok(&[ix], &[&dev]);
}

// ---- 15c. events ----------------------------------------------------------------------------

/// Events written with `emit!`: a log line "Program data: <base64 of discriminator + borsh>".
fn logged<T: anchor_lang::AnchorDeserialize + anchor_lang::Discriminator>(meta: &TransactionMetadata) -> Vec<T> {
    use base64::Engine;
    meta.logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .filter(|d| d.len() >= 8 && d[..8] == *T::DISCRIMINATOR)
        .map(|d| T::deserialize(&mut &d[8..]).unwrap())
        .collect()
}

/// Events written with `emit_cpi!`: an inner instruction of the program to itself with
/// data = e445a52e51cb9a1d + discriminator + borsh.
fn cpi_events<T: anchor_lang::AnchorDeserialize + anchor_lang::Discriminator>(meta: &TransactionMetadata) -> Vec<T> {
    const TAG: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
    meta.inner_instructions
        .iter()
        .flatten()
        .map(|i| &i.instruction.data)
        .filter(|d| d.len() >= 16 && d[..8] == TAG && d[8..16] == *T::DISCRIMINATOR)
        .map(|d| T::deserialize(&mut &d[16..]).unwrap())
        .collect()
}

#[test]
fn every_event_carries_the_numbers_of_its_instruction() {
    let args = RulesArgs { buy: rates(200, 200, 200), sell: rates(200, 200, 200), ..Default::default() };
    let (mut w, mut md) = world(args);
    let t = w.m.trader.insecure_clone();
    let creator = w.m.creator.insecure_clone();
    let (pool, user, c) = (w.k.pool, t.pubkey(), creator.pubkey());

    go(&mut w, 1_234);
    let meta = w.env.ok(&[stake_ix(&w.k, &user, 60_000_000_000)], &[&t]);
    must(md.stake(&user, 60_000_000_000, 1_234, fees_total(&w)));
    let e = &logged::<hook_rules::Staked>(&meta)[0];
    assert_eq!((e.pool, e.staker, e.amount, e.staked, e.total_staked, e.slot), (pool, user, 60_000_000_000, 60_000_000_000, 60_000_000_000, 1_234));

    trade(&mut w, &mut md, &t, DIRECTION_BUY, 5 * SOL);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 5_000_000_000);

    let amount = must(md.claim_rewards(&user, fees_total(&w)));
    let meta = w.env.ok(&[claim_rewards_ix(&w.k, &user, &ata(&user, &w.k.quote_mint))], &[&t]);
    let e = &logged::<hook_rules::RewardsClaimed>(&meta)[0];
    assert_eq!((e.pool, e.staker, e.amount), (pool, user, amount));

    let amount = must(md.claim_creator(fees_total(&w)));
    let meta = w.env.ok(&[claim_creator_ix(&w.k, &c, &ata(&c, &w.k.quote_mint))], &[&creator]);
    let e = &logged::<hook_rules::CreatorClaimed>(&meta)[0];
    assert_eq!((e.pool, e.creator, e.amount), (pool, c, amount));

    // the burn says what it did. Its first call only observes the pool.
    let p = w.env.pool(&w.k.pool);
    assert_eq!(must(md.run_burn(&p, 0, 1_234)), Ran::Observed);
    let meta = w.env.ok(&[run_burn_ix(&w.env, &w.k, &user, 0)], &[&t]);
    let e = &cpi_events::<hook_rules::BurnExecuted>(&meta)[0];
    assert_eq!((e.pool, e.outcome, e.quote_spent, e.base_burned, e.slot), (pool, BURN_OBSERVED, 0, 0, 1_234));
    assert_eq!((e.obs_reserve_base, e.obs_reserve_quote), (p.reserve_base, p.reserve_quote));
    assert!(cpi_events::<hookpool::events::Swapped>(&meta).is_empty(), "nothing was bought");
    // 25 slots later it buys
    go(&mut w, 1_259);
    let Ran::Bought { spent, q, .. } = must(md.run_burn(&p, 0, 1_259)) else { panic!("the burn did not buy") };
    let meta = w.env.ok(&[run_burn_ix(&w.env, &w.k, &user, q.amount_out)], &[&t]);
    let e = &cpi_events::<hook_rules::BurnExecuted>(&meta)[0];
    assert_eq!((e.pool, e.outcome, e.quote_spent, e.base_burned, e.slot), (pool, BURN_BOUGHT, spent, q.amount_out, 1_259));
    assert_eq!((e.obs_reserve_base, e.obs_reserve_quote), (q.reserve_out_after, q.reserve_in_after));
    assert!(logged::<hook_rules::BurnExecuted>(&meta).is_empty(), "the burn event is not a log line");
    // the pool's own event of that buy is there too, marked as made by the hook
    let s = &cpi_events::<hookpool::events::Swapped>(&meta)[0];
    assert!(s.by_hook && s.hook_fee == 0 && s.amount_in == spent && s.amount_out == q.amount_out);
    assert_eq!(s.user, w.r.authority);

    go(&mut w, 1_234 + hook_rules::UNSTAKE_DELAY_SLOTS);
    let meta = w.env.ok(&[unstake_ix(&w.k, &user, 10_000_000_000)], &[&t]);
    must(md.unstake(&user, 10_000_000_000, 1_234 + hook_rules::UNSTAKE_DELAY_SLOTS, fees_total(&w)));
    let e = &logged::<hook_rules::Unstaked>(&meta)[0];
    assert_eq!((e.pool, e.staker, e.amount, e.staked, e.total_staked, e.slot), (pool, user, 10_000_000_000, 50_000_000_000, 50_000_000_000, 1_234 + hook_rules::UNSTAKE_DELAY_SLOTS));

    let meta = w.env.ok(&[lock_ix(&w.k, &c, 700, START_TIME + DAY)], &[&creator]);
    let e = &logged::<hook_rules::CreatorLocked>(&meta)[0];
    assert_eq!((e.pool, e.creator, e.amount, e.locked, e.unlock_at), (pool, c, 700, 700, START_TIME + DAY));
    let meta = w.env.ok(&[lock_ix(&w.k, &c, 300, START_TIME + 2 * DAY)], &[&creator]);
    let e = &logged::<hook_rules::CreatorLocked>(&meta)[0];
    assert_eq!((e.amount, e.locked, e.unlock_at), (300, 1_000, START_TIME + 2 * DAY));
    w.env.set_clock(50_000, START_TIME + 2 * DAY);
    let meta = w.env.ok(&[unlock_ix(&w.k, &c)], &[&creator]);
    let e = &logged::<hook_rules::CreatorUnlocked>(&meta)[0];
    assert_eq!((e.pool, e.creator, e.amount), (pool, c, 1_000));
    check(&w, &md);
}

// ---- 16. measurements ---------------------------------------------------------------------

/// One swap, measured: `(units of before_swap, units of the whole transaction)`.
fn measure_swap(w: &mut World, md: &mut Model, who: &Keypair, label: &str, direction: u8, amount: u64) -> (u64, u64) {
    let u = who.pubkey();
    let pool = w.env.pool(&w.k.pool);
    let q = must(md.swap(&pool, direction, amount, w.env.clock().slot));
    let ix = w.env.swap_ix(&u, &w.k, &w.hook, direction, amount, q.amount_out);
    let size = w.env.tx_size(std::slice::from_ref(&ix), &u, 1);
    let meta = w.env.ok(&[ix], &[who]);
    let hook = hook_units(&meta);
    assert_eq!(hook.len(), 1, "one callback per swap");
    println!("{label}: swap transaction {} CU, of which before_swap {} CU; {size} bytes", meta.compute_units_consumed, hook[0]);
    check(w, md);
    (hook[0], meta.compute_units_consumed)
}

#[test]
fn compute_units_and_transaction_sizes() {
    let args = RulesArgs {
        sniper_slots: 600,
        sniper_start_fee_bps: 3_000,
        buy: rates(100, 150, 50),
        sell: rates(50, 200, 100),
        max_buy_quote: 5 * SOL,
        limit_slots: 300,
        creator_lock_seconds: 0,
    };
    let (mut w, mut md) = world(args);
    let t = w.m.trader.insecure_clone();
    let mut worst = (0u64, 0u64);
    let mut measure = |w: &mut World, md: &mut Model, label: &str, direction: u8, amount: u64| {
        let (hook, swap) = measure_swap(w, md, &t, label, direction, amount);
        worst = (worst.0.max(hook), worst.1.max(swap));
    };
    measure(&mut w, &mut md, "buy, first trade, sniper window, buy limit, nothing to settle", DIRECTION_BUY, SOL);
    measure(&mut w, &mut md, "buy, settles a trade, nobody staked", DIRECTION_BUY, SOL);
    measure(&mut w, &mut md, "sell, settles a trade, nobody staked", DIRECTION_SELL, 1_000_000_000);
    stake(&mut w, &mut md, &t, 500_000_000_000);
    measure(&mut w, &mut md, "buy, settles a trade without a holders' part", DIRECTION_BUY, SOL);
    measure(&mut w, &mut md, "buy, settles a trade with a holders' part", DIRECTION_BUY, SOL);
    measure(&mut w, &mut md, "sell, settles a trade with a holders' part", DIRECTION_SELL, 1_000_000_000);
    go(&mut w, START_SLOT + 10_000);
    measure(&mut w, &mut md, "buy, after both windows, settles with a holders' part", DIRECTION_BUY, SOL);
    measure(&mut w, &mut md, "sell, after both windows, settles with a holders' part", DIRECTION_SELL, 1_000_000_000);
    let (worst_hook, worst_swap) = worst;
    println!("worst before_swap: {worst_hook} CU; worst swap transaction with this hook: {worst_swap} CU");
    assert!(worst_hook < 20_000, "before_swap got expensive: {worst_hook}");
    assert!(worst_swap < 100_000, "a swap with this hook must stay far below the default 200,000: {worst_swap}");

    // the same swaps on a pool without a hook and on a tax pool, for comparison
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, LP_FEE, BASE_LIQ, QUOTE_LIQ, &HookRef::none());
    let meta = env.swap(&m.trader, &k, &HookRef::none(), DIRECTION_BUY, SOL, 0).unwrap();
    println!("for comparison, a buy on a pool without a hook: {} CU", meta.compute_units_consumed);
    let mut env = Env::new();
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    env.create_ata(&m.creator, &m.creator.pubkey(), &m.quote_mint);
    let hook = env.tax_hook(&m.creator, &m.creator, &k.pool, &m.quote_mint, &m.creator.pubkey(), 300, 300, 1_000);
    env.create_pool(&m.creator, &m.base_mint, &m.quote_mint, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    let meta = env.swap(&m.trader, &k, &hook, DIRECTION_BUY, SOL, 0).unwrap();
    println!("for comparison, a buy on a tax pool: {} CU", meta.compute_units_consumed);

    // the other instructions
    let a = wallet(&mut w, 50_000_000_000, 0);
    let meta = w.env.ok(&[stake_ix(&w.k, &a.pubkey(), 1_000_000_000)], &[&a]);
    must(md.stake(&a.pubkey(), 1_000_000_000, w.env.clock().slot, fees_total(&w)));
    println!("stake (opens the record): {} CU", meta.compute_units_consumed);
    let meta = w.env.ok(&[stake_ix(&w.k, &a.pubkey(), 1_000_000_000)], &[&a]);
    must(md.stake(&a.pubkey(), 1_000_000_000, w.env.clock().slot, fees_total(&w)));
    println!("stake (record exists): {} CU", meta.compute_units_consumed);
    measure_swap(&mut w, &mut md, &t, "buy, two stakers", DIRECTION_BUY, SOL);
    go(&mut w, START_SLOT + 30_000);
    let meta = w.env.ok(&[unstake_ix(&w.k, &a.pubkey(), 1_000_000_000)], &[&a]);
    must(md.unstake(&a.pubkey(), 1_000_000_000, w.env.clock().slot, fees_total(&w)));
    println!("unstake: {} CU", meta.compute_units_consumed);
    w.env.create_ata(&a, &a.pubkey(), &w.k.quote_mint);
    let meta = w.env.ok(&[claim_rewards_ix(&w.k, &a.pubkey(), &ata(&a.pubkey(), &w.k.quote_mint))], &[&a]);
    must(md.claim_rewards(&a.pubkey(), fees_total(&w)));
    println!("claim_rewards: {} CU", meta.compute_units_consumed);
    let creator = w.m.creator.insecure_clone();
    let meta = w.env.ok(&[claim_creator_ix(&w.k, &creator.pubkey(), &ata(&creator.pubkey(), &w.k.quote_mint))], &[&creator]);
    must(md.claim_creator(fees_total(&w)));
    println!("claim_creator: {} CU", meta.compute_units_consumed);
    // the burn: the call that takes the observation, the call that buys, the call that waits
    let pool = w.env.pool(&w.k.pool);
    assert_eq!(must(md.run_burn(&pool, 0, w.env.clock().slot)), Ran::Observed);
    let ix = run_burn_ix(&w.env, &w.k, &a.pubkey(), 0);
    let size = w.env.tx_size(std::slice::from_ref(&ix), &a.pubkey(), 1);
    let meta = w.env.ok(&[ix], &[&a]);
    println!("run_burn (first call, takes the observation): {} CU, {size} bytes", meta.compute_units_consumed);
    let slot = w.env.clock().slot + BURN_INTERVAL_SLOTS;
    go(&mut w, slot);
    assert!(matches!(must(md.run_burn(&pool, 0, slot)), Ran::Bought { .. }));
    let meta = w.env.ok(&[run_burn_ix(&w.env, &w.k, &a.pubkey(), 0)], &[&a]);
    println!("run_burn (buys and burns): {} CU", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < 200_000);
    measure_swap(&mut w, &mut md, &t, "buy that takes the price above the burn's observation", DIRECTION_BUY, 5 * SOL);
    measure_swap(&mut w, &mut md, &t, "sell that starts above the observation", DIRECTION_SELL, 1_000_000_000);
    measure_swap(&mut w, &mut md, &t, "buy that starts above the observation", DIRECTION_BUY, SOL);
    go(&mut w, slot + BURN_INTERVAL_SLOTS);
    let pool = w.env.pool(&w.k.pool);
    assert_eq!(must(md.run_burn(&pool, 0, slot + BURN_INTERVAL_SLOTS)), Ran::Waited);
    let meta = w.env.ok(&[run_burn_ix(&w.env, &w.k, &a.pubkey(), 0)], &[&a]);
    println!("run_burn (the price ran away: waits and observes again): {} CU", meta.compute_units_consumed);
    measure_swap(&mut w, &mut md, &t, "sell that starts at the observation", DIRECTION_SELL, 60_000_000_000);
    measure_swap(&mut w, &mut md, &t, "buy that starts below the observation and lowers it", DIRECTION_BUY, SOL);
    // liquidity on a pool with this hook: one callback before the deposit, none on the way out
    w.env.create_ata(&t, &t.pubkey(), &w.k.lp_mint);
    let lp = w.env.mint_supply(&w.k.lp_mint) / 100;
    let ix = w.env.add_liquidity_ix(&t.pubkey(), &w.k, &w.hook, lp, u64::MAX, u64::MAX);
    let size = w.env.tx_size(std::slice::from_ref(&ix), &t.pubkey(), 1);
    let meta = w.env.ok(&[ix], &[&t]);
    let hook = hook_units(&meta);
    assert_eq!(hook.len(), 1, "one callback per deposit");
    println!("add_liquidity on a pool with this hook: {} CU, of which before_add_liquidity {} CU; {size} bytes", meta.compute_units_consumed, hook[0]);
    assert!(meta.compute_units_consumed < 100_000);
    let meta = w.env.ok(&[w.env.remove_liquidity_ix(&t.pubkey(), &w.k, &w.hook, lp, 0, 0)], &[&t]);
    assert!(hook_units(&meta).is_empty(), "no callback on the way out");
    println!("remove_liquidity on a pool with this hook: {} CU", meta.compute_units_consumed);
    let meta = w.env.ok(&[lock_ix(&w.k, &creator.pubkey(), 1_000, START_TIME + DAY)], &[&creator]);
    println!("lock_creator (opens the record and the vault): {} CU", meta.compute_units_consumed);
    let meta = w.env.ok(&[lock_ix(&w.k, &creator.pubkey(), 1_000, START_TIME + DAY)], &[&creator]);
    println!("lock_creator (again): {} CU", meta.compute_units_consumed);
    w.env.set_clock(START_SLOT + 40_000, START_TIME + DAY);
    let meta = w.env.ok(&[unlock_ix(&w.k, &creator.pubkey())], &[&creator]);
    println!("unlock_creator: {} CU", meta.compute_units_consumed);
    check(&w, &md);

    // a launch: sizes and compute, with a first buy, with and without the creator lock
    for (label, with_lock) in [("launch + first buy", false), ("launch + first buy + creator lock", true)] {
        let Launched { mut env, m: _m, dev, k, hook } = launch_step_one(args);
        let d = dev.pubkey();
        // the first buy pays all three rates of a buy, 3%, and the full sniper fee
        let first = hookpool::math::quote_swap(DIRECTION_BUY, 2 * SOL, SUPPLY, 10 * SOL, 0, LP_FEE, PROTOCOL_FEE_BPS, 300, Some(3_000), None).unwrap();
        let mut ixs = vec![
            compute_budget_ix(400_000),
            launch_ix(&env, &d, &k, &hook, hooklaunch::LaunchArgs { lp_fee_bps: LP_FEE, base_amount: SUPPLY, quote_amount: 10 * SOL, dev_buy_quote: 2 * SOL, min_dev_buy_out: first.amount_out }),
        ];
        if with_lock {
            ixs.push(lock_ix(&k, &d, first.amount_out, START_TIME + DAY));
        }
        let size = env.tx_size(&ixs, &d, 1);
        let meta = env.ok(&ixs, &[&dev]);
        println!("{label}: {size} bytes (legacy, no lookup table), {} CU, the hook's two callbacks {:?}", meta.compute_units_consumed, hook_units(&meta));
        assert!(size <= 1232, "{label} must fit one legacy transaction: {size}");
        assert!(meta.compute_units_consumed < 400_000);
    }
}

// ---- 17. a Token-2022 coin ----------------------------------------------------------------

#[test]
fn a_token_2022_coin_works_the_same() {
    use anchor_lang::solana_program::system_instruction;
    use anchor_spl::token_2022::spl_token_2022 as t22;
    use t22::extension::ExtensionType;
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let creator = m.creator.insecure_clone();
    let c = creator.pubkey();
    // a Token-2022 coin with the one extension kind the pool accepts: where its name lives
    let mint = Keypair::new();
    let space = ExtensionType::try_calculate_account_len::<t22::state::Mint>(&[ExtensionType::MetadataPointer]).unwrap();
    let ixs = [
        system_instruction::create_account(&c, &mint.pubkey(), env.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
        t22::extension::metadata_pointer::instruction::initialize(&TOKEN_2022, &mint.pubkey(), None, Some(mint.pubkey())).unwrap(),
        t22::instruction::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &c, None, 6).unwrap(),
    ];
    env.ok(&ixs, &[&creator, &mint]);
    let k = Env::pool_keys_with(&mint.pubkey(), &m.quote_mint, &TOKEN_2022);
    let give = |env: &mut Env, to: &Keypair, amount: u64| {
        let acc = ata_with(&to.pubkey(), &mint.pubkey(), &TOKEN_2022);
        let ixs = [
            Env::create_ata_with_ix(&to.pubkey(), &to.pubkey(), &mint.pubkey(), &TOKEN_2022),
            t22::instruction::mint_to(&TOKEN_2022, &mint.pubkey(), &acc, &c, &[], amount).unwrap(),
        ];
        if to.pubkey() == c {
            env.ok(&ixs, &[&creator]);
        } else {
            env.ok(&ixs, &[to, &creator]);
        }
    };
    give(&mut env, &creator, 10 * BASE_LIQ);
    give(&mut env, &m.trader, BASE_LIQ);

    let args = RulesArgs { buy: rates(100, 200, 100), sell: rates(100, 200, 100), ..Default::default() };
    let hook = env.rules_hook(&creator, &k, args);
    let r = RulesKeys::of(&k);
    for acc in [r.burn_account, r.stake_vault] {
        assert_eq!(env.svm.get_account(&acc).unwrap().owner, TOKEN_2022, "the coin's accounts are Token-2022 accounts");
    }
    assert_eq!(env.svm.get_account(&r.treasury).unwrap().owner, TOKEN);
    let ix = env.create_pool_ix(&c, &k, LP_FEE, BASE_LIQ, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&creator]);
    let rules = rule_bytes(&env, &r.cfg);
    let mut w = World { env, m, k, hook, r, rules };
    let mut md = Model::new(args, START_SLOT, 11 * BASE_LIQ / 1_000);
    assert_eq!(cfg_of(&w).min_eligible, 11 * BASE_LIQ / 1_000);
    check(&w, &md);
    let t = w.m.trader.insecure_clone();
    let anyone = w.env.user(SOL);

    stake(&mut w, &mut md, &t, 200_000_000_000);
    trade(&mut w, &mut md, &t, DIRECTION_BUY, 3 * SOL);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 9_000_000_000);
    let (spent, burned) = burn_next(&mut w, &mut md, &anyone);
    assert!(spent > 0 && burned > 0);
    must(try_claim_rewards(&mut w, &mut md, &t));
    must(try_claim_creator(&mut w, &mut md));
    go(&mut w, START_SLOT + hook_rules::UNSTAKE_DELAY_SLOTS);
    must(try_unstake(&mut w, &mut md, &t, 200_000_000_000));
    // the creator lock, with its own Token-2022 vault
    let held = w.env.balance(&ata_with(&c, &w.k.base_mint, &TOKEN_2022));
    w.env.ok(&[lock_ix(&w.k, &c, 5_000_000, START_TIME + DAY)], &[&creator]);
    assert_eq!(w.env.svm.get_account(&w.r.lock_vault).unwrap().owner, TOKEN_2022);
    assert_eq!(w.env.balance(&w.r.lock_vault), 5_000_000);
    w.env.set_clock(START_SLOT + 20_000, START_TIME + DAY);
    w.env.ok(&[unlock_ix(&w.k, &c)], &[&creator]);
    assert_eq!(w.env.balance(&ata_with(&c, &w.k.base_mint, &TOKEN_2022)), held);
    check(&w, &md);
}

// ---- 18. a treasury that is not there -----------------------------------------------------

#[test]
fn a_fee_the_pool_still_owes_is_never_promised_to_anybody() {
    // No instruction of the program closes the treasury, so the pool never owes it a fee.
    // The test removes the account by force to show that the accounting would hold anyway:
    // the program counts a fee only once the treasury has it.
    let args = RulesArgs { buy: rates(200, 0, 200), sell: rates(100, 0, 0), ..Default::default() };
    let mut w = world_with(args, LP_FEE);
    let t = w.m.trader.insecure_clone();
    let creator = w.m.creator.insecure_clone();
    let saved = w.env.svm.get_account(&w.r.treasury).unwrap();
    w.env.svm.set_account(w.r.treasury, solana_account::Account::default()).unwrap();

    let pool = w.env.pool(&w.k.pool);
    let q1 = expect_swap(&pool, DIRECTION_BUY, SOL, 400, None);
    w.env.swap(&t, &w.k, &w.hook, DIRECTION_BUY, SOL, q1.amount_out).unwrap_or_else(|e| panic!("{}", e.meta.pretty_logs()));
    let pool = w.env.pool(&w.k.pool);
    assert_eq!((pool.hook_fees_quote_total, pool.hook_fees_owed_quote), (q1.hook_fee, q1.hook_fee), "the fee waits in the pool");
    let q2 = expect_swap(&pool, DIRECTION_SELL, 1_000_000_000, 100, None);
    w.env.swap(&t, &w.k, &w.hook, DIRECTION_SELL, 1_000_000_000, q2.amount_out).unwrap();
    let cfg = cfg_of(&w);
    assert_eq!((cfg.fees_seen, cfg.creator_owed, cfg.burn_pot), (0, 0, 0), "nothing was promised out of a fee that did not arrive");

    // the account comes back and the pool pays what it owed
    w.env.svm.set_account(w.r.treasury, saved).unwrap();
    let collect = Instruction {
        program_id: hookpool::ID,
        accounts: hookpool::accounts::CollectHookFees { pool: w.k.pool, quote_mint: w.k.quote_mint, quote_vault: w.k.quote_vault, hook_quote_treasury: w.r.treasury, quote_token_program: TOKEN }
            .to_account_metas(None),
        data: hookpool::instruction::CollectHookFees {}.data(),
    };
    w.env.ok(&[collect], &[&t]);
    assert_eq!(w.env.balance(&w.r.treasury), q1.hook_fee + q2.hook_fee);
    // the next settlement splits both fees by the rates of the last trade (a sell: all to
    // the creator). The split of the first one is not the one it was charged at; the
    // treasury covers every promise all the same.
    let to = ata(&creator.pubkey(), &w.k.quote_mint);
    let before = w.env.balance(&to);
    w.env.ok(&[claim_creator_ix(&w.k, &creator.pubkey(), &to)], &[&creator]);
    assert_eq!(w.env.balance(&to) - before, q1.hook_fee + q2.hook_fee);
    let cfg = cfg_of(&w);
    assert_eq!((cfg.fees_seen, cfg.creator_owed, cfg.burn_pot), (q1.hook_fee + q2.hook_fee, 0, 0));
    assert_eq!(w.env.balance(&w.r.treasury), 0);
}
