//! The strict coin (RULES.md, "The strict coin"): a Token-2022 coin whose transfer hook is
//! `hook_rules`. The program then runs inside every transfer of the coin, which gives three
//! rules a plain coin cannot have: a max wallet, a lock on coins bought early, and the
//! holders' share paid to wallets that hold the coin, without staking.
//!
//! Every test runs against the real pool, launchpad, hook and Token-2022 binaries. The
//! numbers the program must hold are predicted by `Model`, a second implementation written
//! from the specification, and compared after every step.

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022 as t22;
use hook_rules::{HolderRecord, LockRecord, Rates, RulesArgs, RulesConfig, StrictArgs};
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
const DECIMALS: u8 = 6;
const SUPPLY: u64 = 1_000_000_000_000_000; // 1B at 6 decimals
const QUOTE_LIQ: u64 = 100 * SOL;
const LP_FEE: u16 = 30;
const ACC: u128 = 1_000_000_000_000;

fn rates(c: u16, h: u16) -> Rates {
    Rates { creator_bps: c, holders_bps: h, burn_bps: 0 }
}
fn rates3(c: u16, h: u16, b: u16) -> Rates {
    Rates { creator_bps: c, holders_bps: h, burn_bps: b }
}

// ---- addresses and instructions, built the way a client builds them ---------------------

fn pid() -> Pubkey {
    hook_rules::ID
}
fn cfg_of(k: &PoolKeys) -> Pubkey {
    hook_rules::cfg_address(&k.pool)
}
fn authority_of(k: &PoolKeys) -> Pubkey {
    hook_rules::authority_address(&k.pool)
}
fn treasury_of(k: &PoolKeys) -> Pubkey {
    ata(&authority_of(k), &k.quote_mint)
}
fn validation_of(k: &PoolKeys) -> Pubkey {
    hook_rules::validation_address(&k.base_mint)
}
fn holder_of(k: &PoolKeys, wallet: &Pubkey) -> Pubkey {
    hook_rules::holder_address(&k.pool, wallet)
}
/// The one account of a wallet that may receive the coin: its associated token account.
fn coins_of(k: &PoolKeys, wallet: &Pubkey) -> Pubkey {
    ata_with(wallet, &k.base_mint, &TOKEN_2022)
}

/// What the coin's transfer hook needs in any transfer from a token account of `from` to
/// one of `to`: the config, both wallets' holder records, the hook's account list.
fn hook_metas(k: &PoolKeys, from: &Pubkey, to: &Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(cfg_of(k), false),
        AccountMeta::new(holder_of(k, from), false),
        AccountMeta::new(holder_of(k, to), false),
        AccountMeta::new_readonly(validation_of(k), false),
    ]
}

/// The pool's hook as `user` sees it: the callback's config, then what the transfer hook
/// needs for a transfer between `user` and the vault (which the pool owns).
fn hook_for(k: &PoolKeys, user: &Pubkey) -> HookRef {
    HookRef {
        program: pid(),
        treasury: treasury_of(k),
        extra: vec![
            AccountMeta::new(cfg_of(k), false),
            AccountMeta::new(holder_of(k, user), false),
            AccountMeta::new(holder_of(k, &k.pool), false),
            AccountMeta::new_readonly(validation_of(k), false),
        ],
    }
}

/// A plain send between two wallets, each with its associated token account.
fn transfer_ix(k: &PoolKeys, from: &Pubkey, to: &Pubkey, amount: u64) -> Instruction {
    transfer_between(k, &coins_of(k, from), from, &coins_of(k, to), to, from, amount)
}

/// A send between any two token accounts, signed by `signer`.
fn transfer_between(k: &PoolKeys, source: &Pubkey, from: &Pubkey, destination: &Pubkey, to: &Pubkey, signer: &Pubkey, amount: u64) -> Instruction {
    let mut ix = t22::instruction::transfer_checked(&TOKEN_2022, source, &k.base_mint, destination, signer, &[], amount, DECIMALS).unwrap();
    ix.accounts.extend(hook_metas(k, from, to));
    ix.accounts.push(AccountMeta::new_readonly(pid(), false));
    ix
}

/// The coin the way a client creates it through the launchpad: the mint with this hook,
/// its name written by the token program and made final, the supply, no mint authority.
fn create_token_ixs(dev: &Pubkey, mint: &Pubkey, hook_program: &Pubkey) -> Vec<Instruction> {
    use anchor_spl::token_2022_extensions::spl_pod::optional_keys::OptionalNonZeroPubkey;
    use anchor_spl::token_2022_extensions::spl_token_metadata_interface::instruction as md;
    let (name, symbol, uri) = ("Strict", "STRICT", "https://example.invalid/meta.json");
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
            data: hooklaunch::instruction::CreatePeggedMint { decimals: DECIMALS, metadata_len }.data(),
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

fn strict_config_ix(payer: &Pubkey, k: &PoolKeys, args: RulesArgs, strict: StrictArgs) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::InitStrictConfig {
            payer: *payer,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            cfg: cfg_of(k),
            hook_authority: authority_of(k),
            treasury_quote: treasury_of(k),
            validation: validation_of(k),
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
        program_id: pid(),
        accounts: hook_rules::accounts::OpenHolder {
            owner: *owner,
            cfg: cfg_of(k),
            pool: k.pool,
            holder: holder_of(k, owner),
            owner_base: coins_of(k, owner),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::OpenHolder {}.data(),
    }
}

fn claim_holder_ix(k: &PoolKeys, owner: &Pubkey, to: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::ClaimHolder {
            owner: *owner,
            cfg: cfg_of(k),
            pool: k.pool,
            holder: holder_of(k, owner),
            hook_authority: authority_of(k),
            quote_mint: k.quote_mint,
            treasury_quote: treasury_of(k),
            owner_quote: *to,
            quote_token_program: TOKEN,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::ClaimHolder {}.data(),
    }
}

fn sync_holder_ix(k: &PoolKeys, owner: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::SyncHolder { cfg: cfg_of(k), pool: k.pool, holder: holder_of(k, owner), owner_base: coins_of(k, owner) }.to_account_metas(None),
        data: hook_rules::instruction::SyncHolder {}.data(),
    }
}

fn close_holder_ix(k: &PoolKeys, owner: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::CloseHolder { owner: *owner, cfg: cfg_of(k), holder: holder_of(k, owner) }.to_account_metas(None),
        data: hook_rules::instruction::CloseHolder {}.data(),
    }
}

fn lock_ix(k: &PoolKeys, creator: &Pubkey, amount: u64, unlock_at: i64) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::LockCreatorStrict {
            creator: *creator,
            cfg: cfg_of(k),
            lock: hook_rules::lock_address(&k.pool),
            holder: holder_of(k, creator),
            creator_base: coins_of(k, creator),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::LockCreatorStrict { amount, unlock_at }.data(),
    }
}

fn unlock_ix(k: &PoolKeys, creator: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::UnlockCreatorStrict { creator: *creator, cfg: cfg_of(k), lock: hook_rules::lock_address(&k.pool), holder: holder_of(k, creator) }
            .to_account_metas(None),
        data: hook_rules::instruction::UnlockCreatorStrict {}.data(),
    }
}

fn claim_creator_ix(k: &PoolKeys, creator: &Pubkey, to: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::ClaimCreator {
            creator: *creator,
            cfg: cfg_of(k),
            pool: k.pool,
            hook_authority: authority_of(k),
            quote_mint: k.quote_mint,
            treasury_quote: treasury_of(k),
            creator_quote: *to,
            quote_token_program: TOKEN,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::ClaimCreator {}.data(),
    }
}

/// `run_burn_strict`: the accounts of `run_burn` without a burn account.
fn run_burn_ix(env: &Env, k: &PoolKeys, payer: &Pubkey, min_out: u64) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::RunBurnStrict {
            payer: *payer,
            cfg: cfg_of(k),
            hook_authority: authority_of(k),
            platform: env.platform,
            pool: k.pool,
            base_mint: k.base_mint,
            quote_mint: k.quote_mint,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            treasury_quote: treasury_of(k),
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: TOKEN_2022,
            quote_token_program: TOKEN,
            event_authority: event_authority_address(&pid()),
            program: pid(),
        }
        .to_account_metas(None),
        data: hook_rules::instruction::RunBurnStrict { min_amount_out: min_out }.data(),
    }
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
        dev_base: coins_of(k, dev),
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
    Instruction { program_id: hooklaunch::ID, accounts, data: hooklaunch::instruction::Launch { args }.data() }
}

// ---- the model: the strict coin of RULES.md, written a second time -----------------------

#[derive(Clone, Debug, Default, PartialEq)]
struct Holder {
    balance: u64,
    snapshot: u128,
    owed: u64,
    early: u64,
    locked: u64,
    until: i64,
}

/// What a call of `run_burn_strict` that returned Ok did.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Ran {
    Observed,
    Waited,
    Bought { spent: u64, burned: u64, q: SwapQuote },
}

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
    strict: StrictArgs,
    /// None until the pool exists.
    start: Option<(u64, i64)>,
    min_eligible: u64,
    cap_amount: u64,
    fees_seen: u64,
    last_split: Rates,
    creator_owed: u64,
    burn_pot: u64,
    quote_burned: u64,
    base_burned: u64,
    burns: u64,
    /// The burn's observation: slot, base reserve, quote reserve.
    obs: (u64, u64, u64),
    acc: u128,
    rem: u64,
    held: u64,
    owed_total: u64,
    creator_paid: u64,
    rewards_paid: u64,
    holders: BTreeMap<Pubkey, Holder>,
    lock: (u64, i64),
    /// The lock record is created by the first lock.
    lock_exists: bool,
    // ledgers the program does not keep
    to_creator: u64,
    to_holders: u64,
    to_burn: u64,
    accrues: u64,
    /// Records closed so far: each may have left a fraction of a unit behind.
    closed: u64,
}

impl Model {
    fn new(args: RulesArgs, strict: StrictArgs) -> Self {
        Model {
            args,
            strict,
            start: None,
            min_eligible: 0,
            cap_amount: 0,
            fees_seen: 0,
            last_split: Rates::default(),
            creator_owed: 0,
            burn_pot: 0,
            quote_burned: 0,
            base_burned: 0,
            burns: 0,
            obs: (0, 0, 0),
            acc: 0,
            rem: 0,
            held: 0,
            owed_total: 0,
            creator_paid: 0,
            rewards_paid: 0,
            holders: BTreeMap::new(),
            lock: (0, 0),
            lock_exists: false,
            to_creator: 0,
            to_holders: 0,
            to_burn: 0,
            accrues: 0,
            closed: 0,
        }
    }

    fn elapsed(&self, slot: u64) -> Option<u64> {
        self.start.map(|(s, _)| slot - s)
    }
    fn max_wallet_runs(&self, slot: u64) -> bool {
        self.strict.max_wallet_slots > 0 && self.elapsed(slot).is_some_and(|e| e < self.strict.max_wallet_slots as u64)
    }
    fn early_window_runs(&self, slot: u64) -> bool {
        self.strict.early_slots > 0 && self.elapsed(slot).is_some_and(|e| e < self.strict.early_slots as u64)
    }
    fn early_locked(&self, slot: u64) -> bool {
        self.strict.early_slots > 0 && self.elapsed(slot).is_some_and(|e| e < self.strict.early_unlock_slots as u64)
    }
    fn eligible(&self) -> bool {
        self.held > 0 && self.held >= self.min_eligible
    }

    /// The pool was created: the windows start, and the two numbers that depend on the
    /// supply are fixed.
    fn started(&mut self, slot: u64, time: i64) {
        self.start = Some((slot, time));
        self.min_eligible = (SUPPLY / 1_000).max(1);
        if self.strict.max_wallet_bps > 0 {
            self.cap_amount = ((SUPPLY as u128 * self.strict.max_wallet_bps as u128 / 10_000) as u64).max(1);
        }
    }

    /// The split of the fees the treasury received since the last settlement.
    fn settle(&mut self, fees_total: u64) {
        let fresh = fees_total - self.fees_seen;
        if fresh == 0 {
            return;
        }
        self.fees_seen = fees_total;
        let (c, h, b) = (self.last_split.creator_bps as u128, self.last_split.holders_bps as u128, self.last_split.burn_bps as u128);
        // creator and holders rounded down, the burn pot takes the rest; with no rate at
        // all it takes everything
        let creator = (fresh as u128 * c).checked_div(c + h + b).unwrap_or(0) as u64;
        let holders = (fresh as u128 * h).checked_div(c + h + b).unwrap_or(0) as u64;
        let mut burn = fresh - creator - holders;
        if holders > 0 {
            if self.eligible() {
                let n = holders as u128 * ACC + self.rem as u128;
                self.acc += n / self.held as u128;
                self.rem = (n % self.held as u128) as u64;
                self.to_holders += holders;
            } else {
                // too little is registered: the holders' share is burned instead
                burn += holders;
            }
        }
        self.creator_owed += creator;
        self.to_creator += creator;
        self.burn_pot += burn;
        self.to_burn += burn;
    }

    /// The share of the quote reserve one run may spend, in bps. The platform's cap is
    /// never below a side's three rates in these tests, so the burn share of what the pool
    /// charges is the burn rate itself.
    fn burn_cap_bps(&self) -> u64 {
        let sure = PROTOCOL_FEE_BPS as u64 + self.args.buy.burn_bps as u64 + self.args.sell.burn_bps as u64;
        let soft = PROTOCOL_FEE_BPS as u64 + 2 * LP_FEE as u64;
        ((sure + soft.min(sure)) / 4).clamp(1, 50)
    }

    /// What a call would do in this slot on this pool: the observation rule.
    fn burn_plan(&self, reserves: (u64, u64), slot: u64) -> Plan {
        let (os, ob, oq) = self.obs;
        if ob == 0 || oq == 0 {
            return Plan::Observe;
        }
        if slot < os + BURN_INTERVAL_SLOTS {
            return Plan::TooSoon;
        }
        let cap = self.burn_cap_bps() as u128;
        if reserves.1 as u128 * ob as u128 * 10_000 > oq as u128 * reserves.0 as u128 * (10_000 + 2 * cap) {
            return Plan::Wait;
        }
        Plan::Buy(((reserves.1.min(oq) as u128 * cap / 10_000) as u64).max(1))
    }

    /// One call of `run_burn_strict`.
    fn run_burn(&mut self, reserves: (u64, u64), fees_total: u64, slot: u64) -> Result<Ran, &'static str> {
        self.settle(fees_total);
        if self.burn_pot == 0 {
            return Err("the burn pot is empty");
        }
        let ran = match self.burn_plan(reserves, slot) {
            Plan::TooSoon => return Err("observation of the pool is less than 25 slots old"),
            Plan::Observe => {
                self.obs = (slot, reserves.0, reserves.1);
                Ran::Observed
            }
            Plan::Wait => {
                self.obs = (slot, reserves.0, reserves.1);
                Ran::Waited
            }
            Plan::Buy(max_spend) => {
                let spent = self.burn_pot.min(max_spend);
                let q = hookpool::math::quote_swap(DIRECTION_BUY, spent, reserves.0, reserves.1, 0, LP_FEE, PROTOCOL_FEE_BPS, 0, None, None).map_err(|_| "")?;
                self.burn_pot -= spent;
                self.quote_burned += spent;
                self.base_burned += q.amount_out;
                self.burns += 1;
                self.obs = (slot, q.reserve_out_after, q.reserve_in_after);
                Ran::Bought { spent, burned: q.amount_out, q }
            }
        };
        Ok(ran)
    }

    /// Bring a record up to date and set its balance.
    fn touch(&mut self, who: &Pubkey, balance: u64) {
        let acc = self.acc;
        let h = self.holders.get_mut(who).unwrap();
        let pending = (h.balance as u128 * (acc - h.snapshot) / ACC) as u64;
        if acc > h.snapshot && h.balance > 0 {
            self.accrues += 1;
        }
        h.owed += pending;
        self.owed_total += pending;
        h.snapshot = acc;
        self.held = self.held - h.balance + balance;
        h.balance = balance;
    }

    /// `before_swap`: what the hook answers and what the pool then computes.
    fn swap(&mut self, reserves: (u64, u64), fees_total: u64, direction: u8, amount: u64, slot: u64) -> Result<SwapQuote, &'static str> {
        self.settle(fees_total);
        let is_buy = direction == DIRECTION_BUY;
        let (start, _) = self.start.expect("a trade needs a pool");
        if is_buy && self.args.max_buy_quote > 0 && slot - start < self.args.limit_slots && amount > self.args.max_buy_quote {
            return Err("buy above the limit of the launch window");
        }
        let side = if is_buy { self.args.buy } else { self.args.sell };
        self.last_split = side;
        // a trade that starts below the burn's observation lowers the observed price to the
        // price it starts at, without raising the observed depth; the slot stays
        let (_, ob, oq) = self.obs;
        if ob != 0 && oq != 0 && (reserves.1 as u128 * ob as u128) < (oq as u128 * reserves.0 as u128) {
            let quote = reserves.1.min(oq);
            self.obs.1 = (quote as u128 * reserves.0 as u128).div_ceil(reserves.1 as u128) as u64;
            self.obs.2 = quote;
        }
        let over = if is_buy { hook_rules::sniper_fee(slot, start, self.args.sniper_slots, self.args.sniper_start_fee_bps, LP_FEE) } else { None };
        hookpool::math::quote_swap(direction, amount, reserves.0, reserves.1, 0, LP_FEE, PROTOCOL_FEE_BPS, side.creator_bps + side.holders_bps + side.burn_bps, over, None).map_err(|_| "")
    }

    /// `execute`: one transfer of the coin. `from` / `to` are the wallets, None for the
    /// pool's vault. The balances are the ones after the transfer.
    #[allow(clippy::too_many_arguments)]
    fn moved(&mut self, from: Option<(Pubkey, u64)>, to: Option<(Pubkey, u64)>, amount: u64, is_buy: bool, to_is_associated: bool, slot: u64, now: i64) -> Result<(), &'static str> {
        if to.is_some() && !to_is_associated {
            return Err("not the associated token account of its wallet");
        }
        if let Some((f, after)) = from {
            if let Some(h) = self.holders.get(&f) {
                if self.early_locked(slot) && after < h.early {
                    return Err("coins bought early are locked until the unlock");
                }
                if h.locked > 0 && now < h.until && after < h.locked {
                    return Err("the creator's locked coins cannot move before the unlock time");
                }
                self.touch(&f, after);
            }
        }
        if let Some((t, after)) = to {
            if self.max_wallet_runs(slot) && (is_buy || from.is_some()) && after > self.cap_amount {
                return Err("above the max wallet");
            }
            let early_buy = is_buy && self.early_window_runs(slot);
            if self.holders.contains_key(&t) {
                if early_buy {
                    self.holders.get_mut(&t).unwrap().early += amount;
                }
                self.touch(&t, after);
            } else if early_buy {
                return Err("needs the wallet's holder record");
            }
        }
        Ok(())
    }

    fn open(&mut self, who: &Pubkey, balance: u64, fees_total: u64) {
        if self.holders.contains_key(who) {
            return;
        }
        if self.start.is_some() {
            self.settle(fees_total);
        }
        self.holders.insert(*who, Holder { balance, snapshot: self.acc, ..Default::default() });
        self.held += balance;
    }

    fn claim(&mut self, who: &Pubkey, fees_total: u64) -> Result<u64, &'static str> {
        if !self.holders.contains_key(who) {
            return Err("AccountNotInitialized");
        }
        self.settle(fees_total);
        let balance = self.holders[who].balance;
        self.touch(who, balance);
        let h = self.holders.get_mut(who).unwrap();
        if h.owed == 0 {
            return Err("nothing to claim");
        }
        let amount = h.owed;
        h.owed = 0;
        self.owed_total -= amount;
        self.rewards_paid += amount;
        Ok(amount)
    }

    fn claim_creator(&mut self, fees_total: u64) -> Result<u64, &'static str> {
        self.settle(fees_total);
        if self.creator_owed == 0 {
            return Err("nothing to claim");
        }
        let amount = self.creator_owed;
        self.creator_owed = 0;
        self.creator_paid += amount;
        Ok(amount)
    }

    fn sync(&mut self, who: &Pubkey, real: u64, fees_total: u64) {
        if self.start.is_some() {
            self.settle(fees_total);
        }
        if real < self.holders[who].balance {
            self.touch(who, real);
        }
    }

    fn close(&mut self, who: &Pubkey, slot: u64) -> Result<(), &'static str> {
        let Some(h) = self.holders.get(who) else { return Err("AccountNotInitialized") };
        if h.balance != 0 || h.owed != 0 || h.locked != 0 || (h.early != 0 && self.early_locked(slot)) {
            return Err("the holder record still holds something");
        }
        self.holders.remove(who);
        self.closed += 1;
        Ok(())
    }

    fn lock_creator(&mut self, creator: &Pubkey, amount: u64, unlock_at: i64, balance: u64, now: i64) -> Result<u64, &'static str> {
        let Some((_, start_time)) = self.start else { return Err("the pool of this config does not exist yet") };
        if !self.holders.contains_key(creator) {
            return Err("AccountNotInitialized");
        }
        let locked = if amount == u64::MAX { balance.max(self.lock.0) } else { self.lock.0 + amount };
        if locked == 0 {
            return Err("amount must be greater than zero");
        }
        if locked > balance {
            return Err("cannot lock more than the wallet holds");
        }
        if unlock_at < self.lock.1 {
            return Err("the unlock time can only move later");
        }
        if unlock_at < start_time + self.args.creator_lock_seconds as i64 {
            return Err("unlock time is before the lock declared at launch");
        }
        if unlock_at <= now {
            return Err("unlock time is not in the future");
        }
        if unlock_at > now + 365 * DAY {
            return Err("unlock time is too far ahead");
        }
        self.lock = (locked, unlock_at);
        self.lock_exists = true;
        let h = self.holders.get_mut(creator).unwrap();
        (h.locked, h.until) = (locked, unlock_at);
        Ok(locked)
    }

    fn unlock_creator(&mut self, creator: &Pubkey, now: i64) -> Result<u64, &'static str> {
        if !self.lock_exists || !self.holders.contains_key(creator) {
            return Err("AccountNotInitialized");
        }
        if self.lock.0 == 0 {
            return Err("nothing is locked");
        }
        if now < self.lock.1 {
            return Err("the creator lock is not over yet");
        }
        let amount = self.lock.0;
        self.lock = (0, 0);
        let h = self.holders.get_mut(creator).unwrap();
        (h.locked, h.until) = (0, 0);
        Ok(amount)
    }
}

// ---- a launched strict coin, and the checks made after every step ------------------------

struct World {
    env: Env,
    m: Market,
    dev: Keypair,
    k: PoolKeys,
    /// Every wallet that ever held the coin, the platform treasury included.
    known: Vec<Pubkey>,
    /// The bytes of the config that nothing may change once the pool exists.
    fixed: Vec<u8>,
    /// The last `run_burn_strict` that went through: compute units, legacy size in bytes.
    last_run: (u64, usize),
}

fn fixed_bytes(env: &Env, k: &PoolKeys) -> Vec<u8> {
    let d = env.svm.get_account(&cfg_of(k)).unwrap().data;
    // the rules of every rules coin (8 to 239), then the strict coin's: kind (374), the
    // vault bump and the five numbers (376 to 396)
    [&d[8..240], &d[374..375], &d[376..397]].concat()
}

fn cfg(w: &World) -> RulesConfig {
    w.env.account(&cfg_of(&w.k))
}
fn bal(w: &World, wallet: &Pubkey) -> u64 {
    w.env.balance(&coins_of(&w.k, wallet))
}
fn quote_bal(w: &World, wallet: &Pubkey) -> u64 {
    w.env.balance(&ata(wallet, &w.k.quote_mint))
}
fn fees_total(w: &World) -> u64 {
    w.env.pool(&w.k.pool).hook_fees_quote_total
}
fn go(w: &mut World, slot: u64) {
    let t = w.env.clock().unix_timestamp;
    w.env.set_clock(slot, t);
}
fn must<T>(r: Result<T, &'static str>) -> T {
    r.unwrap_or_else(|e| panic!("the model refuses this step: {e:?}"))
}

/// A wallet with quote, a token account for the quote and (when asked) for the coin.
fn wallet(w: &mut World, quote: u64) -> Keypair {
    let u = w.env.user(10 * SOL);
    let acc = w.env.create_ata(&u, &u.pubkey(), &w.k.quote_mint);
    w.env.mint_to(&w.m.authority, &w.k.quote_mint, &acc, quote);
    w.env.ok(&[Env::create_ata_with_ix(&u.pubkey(), &u.pubkey(), &w.k.base_mint, &TOKEN_2022)], &[&u]);
    w.known.push(u.pubkey());
    u
}

struct Launch {
    args: RulesArgs,
    strict: StrictArgs,
    /// Coins that go into the pool; the rest of the supply stays with the launcher.
    base_amount: u64,
    dev_buy: u64,
    /// Lock everything the launcher holds until this time, in the launch transaction.
    lock_until: Option<i64>,
    /// Open the launcher's holder record in transaction 1.
    dev_record: bool,
}

impl Default for Launch {
    fn default() -> Self {
        Launch { args: RulesArgs { buy: rates(50, 100), sell: rates(50, 100), ..Default::default() }, strict: StrictArgs::default(), base_amount: SUPPLY, dev_buy: 0, lock_until: None, dev_record: true }
    }
}

/// The two launch transactions of a strict coin, as a client sends them.
fn launch_ixs(env: &Env, dev: &Pubkey, k: &PoolKeys, l: &Launch) -> (Vec<Instruction>, Vec<Instruction>) {
    let mut one = vec![compute_budget_ix(400_000)];
    one.extend(create_token_ixs(dev, &k.base_mint, &pid()));
    one.push(strict_config_ix(dev, k, l.args, l.strict));
    if l.dev_record {
        one.push(open_holder_ix(k, dev));
    }
    let args = hooklaunch::LaunchArgs { lp_fee_bps: LP_FEE, base_amount: l.base_amount, quote_amount: QUOTE_LIQ, dev_buy_quote: l.dev_buy, min_dev_buy_out: 0 };
    let mut two = vec![compute_budget_ix(800_000), launch_ix(env, dev, k, &hook_for(k, dev), args)];
    if let Some(until) = l.lock_until {
        two.push(lock_ix(k, dev, u64::MAX, until));
    }
    (one, two)
}

fn launch(l: Launch) -> (World, Model) {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let dev = env.user(50 * SOL);
    let acc = env.create_ata(&dev, &dev.pubkey(), &m.quote_mint);
    env.mint_to(&m.authority, &m.quote_mint, &acc, 5_000 * SOL);
    let mint = Keypair::new();
    let k = Env::pool_keys_with(&mint.pubkey(), &m.quote_mint, &TOKEN_2022);
    let d = dev.pubkey();
    let (one, two) = launch_ixs(&env, &d, &k, &l);
    env.ok(&one, &[&dev, &mint]);
    env.ok(&two, &[&dev]);

    // the model goes through the same steps
    let mut md = Model::new(l.args, l.strict);
    if l.dev_record {
        md.open(&d, SUPPLY, 0);
    }
    // the supply moves into the vault before the pool exists: no rule runs yet
    must(md.moved(Some((d, SUPPLY - l.base_amount)), None, l.base_amount, false, true, START_SLOT, START_TIME));
    md.started(START_SLOT, START_TIME);
    if l.dev_buy > 0 {
        let q = must(md.swap((l.base_amount, QUOTE_LIQ), 0, DIRECTION_BUY, l.dev_buy, START_SLOT));
        must(md.moved(None, Some((d, SUPPLY - l.base_amount + q.amount_out)), q.amount_out, true, true, START_SLOT, START_TIME));
    }
    if let Some(until) = l.lock_until {
        let held = env.balance(&coins_of(&k, &d));
        must(md.lock_creator(&d, u64::MAX, until, held, START_TIME));
    }
    let fixed = fixed_bytes(&env, &k);
    let known = vec![d, env.treasury.pubkey()];
    let w = World { env, m, dev, k, known, fixed, last_run: (0, 0) };
    check(&w, &md);
    (w, md)
}

/// Exact accounting, solvency, and where every unit of the coin is. After every step.
fn check(w: &World, md: &Model) {
    let c = cfg(w);
    let pool = w.env.pool(&w.k.pool);
    assert_eq!(fixed_bytes(&w.env, &w.k), w.fixed, "a rule changed after the launch");
    assert_eq!((c.kind, c.buy_mark), (hook_rules::KIND_STRICT, 0), "the buy mark never outlives its instruction");
    assert_eq!(pool.hook_fees_owed_quote, 0);
    // the burn, as on a plain coin
    assert_eq!((c.burn_pot, c.burns, c.total_quote_burned, c.total_base_burned), (md.burn_pot, md.burns, md.quote_burned, md.base_burned), "the burn");
    assert_eq!((c.obs_slot, c.obs_reserve_base, c.obs_reserve_quote), md.obs, "the burn's observation");
    assert!(c.reserved.iter().all(|b| *b == 0));
    // a strict coin has no burn account: the coins it burns never leave the pool's vault
    assert!(w.env.svm.get_account(&coins_of(&w.k, &authority_of(&w.k))).is_none());

    assert_eq!(c.fees_seen, md.fees_seen, "fees_seen");
    assert_eq!(c.last_split, md.last_split, "last_split");
    assert_eq!(c.creator_owed, md.creator_owed, "creator_owed");
    assert_eq!(c.acc_per_share, md.acc, "acc_per_share");
    assert_eq!(c.reward_rem, md.rem, "reward_rem");
    assert_eq!(c.total_staked, md.held, "the total the holder records hold");
    assert_eq!(c.rewards_owed_total, md.owed_total, "rewards_owed_total");
    assert_eq!(c.total_creator_paid, md.creator_paid);
    assert_eq!(c.total_rewards_paid, md.rewards_paid);
    assert_eq!(c.max_wallet_amount, md.cap_amount);

    // every holder record
    let (mut held, mut owed, mut pending) = (0u64, 0u64, 0u64);
    for (who, h) in &md.holders {
        let r: HolderRecord = w.env.account(&holder_of(&w.k, who));
        assert_eq!((r.pool, r.owner), (w.k.pool, *who));
        assert_eq!((r.balance, r.acc_snapshot, r.owed, r.early_bought, r.locked, r.locked_until), (h.balance, h.snapshot, h.owed, h.early, h.locked, h.until), "the record of {who}");
        // a record is what the wallet holds, or above it after a burn nobody synced yet
        assert!(r.balance >= bal(w, who), "the record of {who} is below what it holds");
        held += r.balance;
        owed += r.owed;
        pending += (r.balance as u128 * (c.acc_per_share - r.acc_snapshot) / ACC) as u64;
    }
    assert_eq!(held, c.total_staked, "the records add up to the total");
    assert_eq!(owed, c.rewards_owed_total);

    // every unit of the coin is in the pool's vault or in a wallet's associated account
    let vault = w.env.balance(&w.k.base_vault);
    let in_wallets: u64 = w.known.iter().map(|k| bal(w, k)).sum();
    assert_eq!(vault + in_wallets, w.env.mint_supply(&w.k.base_mint), "a unit of the coin is somewhere else");
    assert_eq!(vault, pool.reserve_base + pool.protocol_fees_base, "the vault holds the reserve and the protocol's fees");

    // the treasury: everything the pool charged came in, only the three payouts went out
    let treasury = w.env.balance(&treasury_of(&w.k));
    assert_eq!(treasury, pool.hook_fees_quote_total - c.total_creator_paid - c.total_rewards_paid - c.total_quote_burned, "treasury ledger");
    let unsettled = pool.hook_fees_quote_total - c.fees_seen;
    let promised = c.creator_owed + c.burn_pot + c.rewards_owed_total + pending + unsettled;
    assert!(treasury >= promised, "INSOLVENT: treasury {treasury} < promised {promised}");
    // rounding keeps dust only
    let dust = treasury - promised;
    let bound = md.accrues + md.holders.len() as u64 + (c.reward_rem as u128 / ACC) as u64 + 1;
    assert!(dust <= bound + md.closed, "rounding kept {dust}, more than {bound}");
    assert_eq!(md.to_creator + md.to_holders + md.to_burn, c.fees_seen, "where every unit of fee went");
    assert_eq!(c.burn_pot + c.total_quote_burned, md.to_burn);
}

/// One swap. The model predicts it; the transaction is sent with the predicted output as
/// its minimum.
fn try_trade(w: &mut World, md: &mut Model, who: &Keypair, direction: u8, amount: u64) -> Result<SwapQuote, &'static str> {
    let u = who.pubkey();
    let pool = w.env.pool(&w.k.pool);
    let (slot, now) = (w.env.clock().slot, w.env.clock().unix_timestamp);
    let held = bal(w, &u);
    let mut next = md.clone();
    let plan = next.swap((pool.reserve_base, pool.reserve_quote), pool.hook_fees_quote_total, direction, amount, slot).and_then(|q| {
        if direction == DIRECTION_BUY {
            next.moved(None, Some((u, held + q.amount_out)), q.amount_out, true, true, slot, now)?;
        } else {
            next.moved(Some((u, held - amount)), None, amount, false, true, slot, now)?;
        }
        Ok(q)
    });
    let hook = hook_for(&w.k, &u);
    let quote = quote_bal(w, &u);
    match plan {
        Err(needle) => {
            let ix = w.env.swap_ix(&u, &w.k, &hook, direction, amount, 0);
            w.env.err(&[compute_budget_ix(400_000), ix], &[who], needle);
            Err(needle)
        }
        Ok(q) => {
            let ix = w.env.swap_ix(&u, &w.k, &hook, direction, amount, q.amount_out);
            w.env.ok(&[compute_budget_ix(400_000), ix], &[who]);
            if direction == DIRECTION_BUY {
                assert_eq!((quote - quote_bal(w, &u), bal(w, &u) - held), (amount, q.amount_out), "a buy");
            } else {
                assert_eq!((held - bal(w, &u), quote_bal(w, &u) - quote), (amount, q.amount_out), "a sell");
            }
            *md = next;
            check(w, md);
            Ok(q)
        }
    }
}

fn trade(w: &mut World, md: &mut Model, who: &Keypair, direction: u8, amount: u64) -> SwapQuote {
    must(try_trade(w, md, who, direction, amount))
}

/// A plain send from one wallet to another.
fn try_send(w: &mut World, md: &mut Model, from: &Keypair, to: &Pubkey, amount: u64) -> Result<(), &'static str> {
    let f = from.pubkey();
    if w.env.svm.get_account(&coins_of(&w.k, to)).is_none() {
        w.env.ok(&[Env::create_ata_with_ix(&f, to, &w.k.base_mint, &TOKEN_2022)], &[from]);
    }
    if !w.known.contains(to) {
        w.known.push(*to);
    }
    let (slot, now) = (w.env.clock().slot, w.env.clock().unix_timestamp);
    let (fb, tb) = (bal(w, &f), bal(w, to));
    let mut next = md.clone();
    let plan = next.moved(Some((f, fb - amount)), Some((*to, tb + amount)), amount, false, true, slot, now);
    let ix = transfer_ix(&w.k, &f, to, amount);
    match plan {
        Err(needle) => {
            w.env.err(&[ix], &[from], needle);
            Err(needle)
        }
        Ok(()) => {
            w.env.ok(&[ix], &[from]);
            assert_eq!((bal(w, &f), bal(w, to)), (fb - amount, tb + amount));
            *md = next;
            check(w, md);
            Ok(())
        }
    }
}

fn open(w: &mut World, md: &mut Model, who: &Keypair) {
    let u = who.pubkey();
    md.open(&u, bal(w, &u), fees_total(w));
    w.env.ok(&[open_holder_ix(&w.k, &u)], &[who]);
    check(w, md);
}

fn try_claim(w: &mut World, md: &mut Model, who: &Keypair) -> Result<u64, &'static str> {
    let u = who.pubkey();
    let mut next = md.clone();
    let plan = next.claim(&u, fees_total(w));
    let to = ata(&u, &w.k.quote_mint);
    let before = w.env.balance(&to);
    let ix = claim_holder_ix(&w.k, &u, &to);
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
    let dev = w.dev.insecure_clone();
    let mut next = md.clone();
    let plan = next.claim_creator(fees_total(w));
    let to = ata(&dev.pubkey(), &w.k.quote_mint);
    let before = w.env.balance(&to);
    let ix = claim_creator_ix(&w.k, &dev.pubkey(), &to);
    match plan {
        Err(needle) => {
            w.env.err(&[ix], &[&dev], needle);
            Err(needle)
        }
        Ok(amount) => {
            w.env.ok(&[ix], &[&dev]);
            assert_eq!(w.env.balance(&to) - before, amount);
            *md = next;
            check(w, md);
            Ok(amount)
        }
    }
}

/// Anyone lowers a record to what its wallet holds.
fn sync(w: &mut World, md: &mut Model, sender: &Keypair, owner: &Pubkey) {
    md.sync(owner, bal(w, owner), fees_total(w));
    w.env.ok(&[sync_holder_ix(&w.k, owner)], &[sender]);
    check(w, md);
}

fn try_close(w: &mut World, md: &mut Model, who: &Keypair) -> Result<(), &'static str> {
    let u = who.pubkey();
    let mut next = md.clone();
    let plan = next.close(&u, w.env.clock().slot);
    let ix = close_holder_ix(&w.k, &u);
    match plan {
        Err(needle) => {
            w.env.err(&[ix], &[who], needle);
            Err(needle)
        }
        Ok(()) => {
            w.env.ok(&[ix], &[who]);
            assert!(w.env.svm.get_account(&holder_of(&w.k, &u)).is_none_or(|a| a.lamports == 0), "the record is gone");
            *md = next;
            check(w, md);
            Ok(())
        }
    }
}

fn try_lock(w: &mut World, md: &mut Model, amount: u64, unlock_at: i64) -> Result<u64, &'static str> {
    let dev = w.dev.insecure_clone();
    let d = dev.pubkey();
    let mut next = md.clone();
    let plan = next.lock_creator(&d, amount, unlock_at, bal(w, &d), w.env.clock().unix_timestamp);
    let ix = lock_ix(&w.k, &d, amount, unlock_at);
    match plan {
        Err(needle) => {
            w.env.err(&[ix], &[&dev], needle);
            Err(needle)
        }
        Ok(locked) => {
            w.env.ok(&[ix], &[&dev]);
            let lock: LockRecord = w.env.account(&hook_rules::lock_address(&w.k.pool));
            assert_eq!((lock.pool, lock.amount, lock.unlock_at), (w.k.pool, locked, unlock_at), "the lock record says the same as the holder record");
            *md = next;
            check(w, md);
            Ok(locked)
        }
    }
}

fn try_unlock(w: &mut World, md: &mut Model) -> Result<u64, &'static str> {
    let dev = w.dev.insecure_clone();
    let mut next = md.clone();
    let plan = next.unlock_creator(&dev.pubkey(), w.env.clock().unix_timestamp);
    let ix = unlock_ix(&w.k, &dev.pubkey());
    match plan {
        Err(needle) => {
            w.env.err(&[ix], &[&dev], needle);
            Err(needle)
        }
        Ok(amount) => {
            w.env.ok(&[ix], &[&dev]);
            let lock: LockRecord = w.env.account(&hook_rules::lock_address(&w.k.pool));
            assert_eq!((lock.amount, lock.unlock_at), (0, 0));
            *md = next;
            check(w, md);
            Ok(amount)
        }
    }
}

/// `lp` LP tokens of liquidity in, by a wallet that holds coins and quote.
fn try_add_liquidity(w: &mut World, md: &mut Model, who: &Keypair, lp: u64) -> Result<(), &'static str> {
    let u = who.pubkey();
    if w.env.svm.get_account(&ata(&u, &w.k.lp_mint)).is_none() {
        w.env.create_ata(who, &u, &w.k.lp_mint);
    }
    let pool = w.env.pool(&w.k.pool);
    let supply = w.env.mint_supply(&w.k.lp_mint);
    let (slot, now) = (w.env.clock().slot, w.env.clock().unix_timestamp);
    let coins = (lp as u128 * pool.reserve_base as u128).div_ceil(supply as u128) as u64;
    let held = bal(w, &u);
    let mut next = md.clone();
    let elapsed = slot - START_SLOT;
    let plan = if md.args.sniper_slots > 0 && elapsed < md.args.sniper_slots {
        Err("liquidity cannot be added while the sniper fee runs")
    } else if md.max_wallet_runs(slot) {
        Err("liquidity cannot be added while the max wallet runs")
    } else {
        // the deposit is a transfer out of the wallet like any other
        next.moved(Some((u, held - coins)), None, coins, false, true, slot, now)
    };
    let ix = w.env.add_liquidity_ix(&u, &w.k, &hook_for(&w.k, &u), lp, u64::MAX, u64::MAX);
    match plan {
        Err(needle) => {
            w.env.err(&[compute_budget_ix(400_000), ix], &[who], needle);
            Err(needle)
        }
        Ok(()) => {
            w.env.ok(&[compute_budget_ix(400_000), ix], &[who]);
            assert_eq!(held - bal(w, &u), coins);
            *md = next;
            check(w, md);
            Ok(())
        }
    }
}

/// Liquidity out. Never refused: no rule of the coin holds what the pool pays out here.
fn remove_liquidity(w: &mut World, md: &mut Model, who: &Keypair, lp: u64) -> u64 {
    let u = who.pubkey();
    let pool = w.env.pool(&w.k.pool);
    let supply = w.env.mint_supply(&w.k.lp_mint);
    let (slot, now) = (w.env.clock().slot, w.env.clock().unix_timestamp);
    let coins = (lp as u128 * pool.reserve_base as u128 / supply as u128) as u64;
    let held = bal(w, &u);
    must(md.moved(None, Some((u, held + coins)), coins, false, true, slot, now));
    let ix = w.env.remove_liquidity_ix(&u, &w.k, &hook_for(&w.k, &u), lp, 0, 0);
    w.env.ok(&[compute_budget_ix(400_000), ix], &[who]);
    assert_eq!(bal(w, &u) - held, coins);
    check(w, md);
    coins
}

/// A token Burn by the wallet itself. The token program calls no transfer hook for it, so
/// the wallet's record stays where it was.
fn burn(w: &mut World, md: &Model, who: &Keypair, amount: u64) {
    let u = who.pubkey();
    let ix = t22::instruction::burn(&TOKEN_2022, &coins_of(&w.k, &u), &w.k.base_mint, &u, &[], amount).unwrap();
    w.env.ok(&[ix], &[who]);
    check(w, md);
}

/// One call of `run_burn_strict`, predicted by the model first. Checks what the call says
/// about itself (return data, event) and what it did: the coins are burned in the pool's
/// vault and nowhere else.
fn try_run_burn(w: &mut World, md: &mut Model, who: &Keypair) -> Result<Ran, &'static str> {
    let pool = w.env.pool(&w.k.pool);
    let slot = w.env.clock().slot;
    let mut next = md.clone();
    let plan = next.run_burn((pool.reserve_base, pool.reserve_quote), pool.hook_fees_quote_total, slot);
    let (supply, treasury, vault) = (w.env.mint_supply(&w.k.base_mint), w.env.balance(&treasury_of(&w.k)), w.env.balance(&w.k.base_vault));
    match plan {
        Err(needle) => {
            let ix = run_burn_ix(&w.env, &w.k, &who.pubkey(), 0);
            w.env.err(&[ix], &[who], needle);
            Err(needle)
        }
        Ok(ran) => {
            // a call that does not buy ignores the minimum
            let min_out = if let Ran::Bought { q, .. } = ran { q.amount_out } else { u64::MAX };
            let ix = run_burn_ix(&w.env, &w.k, &who.pubkey(), min_out);
            let size = w.env.tx_size(std::slice::from_ref(&ix), &who.pubkey(), 1);
            let meta = w.env.ok(&[ix], &[who]);
            w.last_run = (meta.compute_units_consumed, size);
            let (outcome, spent, burned) = match ran {
                Ran::Observed => (BURN_OBSERVED, 0, 0),
                Ran::Waited => (BURN_WAITED, 0, 0),
                Ran::Bought { spent, burned, .. } => (BURN_BOUGHT, spent, burned),
            };
            let mut said = vec![outcome];
            said.extend_from_slice(&spent.to_le_bytes());
            said.extend_from_slice(&burned.to_le_bytes());
            assert_eq!(meta.return_data.data, said, "return data of run_burn_strict");
            assert_eq!(meta.return_data.program_id.to_bytes(), pid().to_bytes());
            let e = &cpi_events::<hook_rules::BurnExecuted>(&meta)[0];
            assert_eq!((e.pool, e.outcome, e.quote_spent, e.base_burned, e.slot), (w.k.pool, outcome, spent, burned, slot));
            assert_eq!((e.slot, e.obs_reserve_base, e.obs_reserve_quote), next.obs);
            assert_eq!(supply - w.env.mint_supply(&w.k.base_mint), burned, "the supply fell by what was bought");
            assert_eq!(vault - w.env.balance(&w.k.base_vault), burned, "it was burned in the pool's vault");
            assert_eq!(treasury - w.env.balance(&treasury_of(&w.k)), spent, "the treasury paid the run");
            let after = w.env.pool(&w.k.pool);
            assert_eq!(after.hook_fees_quote_total, pool.hook_fees_quote_total, "a burn pays no hook fee");
            match ran {
                Ran::Bought { q, .. } => {
                    assert_eq!((after.reserve_quote, after.reserve_base, after.swap_count), (q.reserve_in_after, q.reserve_out_after, pool.swap_count + 1));
                    // the pool's own event of that buy, marked as made by the hook
                    let s = &cpi_events::<hookpool::events::Swapped>(&meta)[0];
                    assert!(s.by_hook && s.hook_fee == 0 && s.amount_in == spent && s.amount_out == burned && s.user == authority_of(&w.k));
                }
                _ => assert_eq!((after.reserve_quote, after.reserve_base, after.swap_count), (pool.reserve_quote, pool.reserve_base, pool.swap_count), "nothing was bought"),
            }
            *md = next;
            check(w, md);
            Ok(ran)
        }
    }
}

/// Call the burn until it buys, one interval apart. Returns (quote spent, coins burned).
fn burn_next(w: &mut World, md: &mut Model, who: &Keypair) -> (u64, u64) {
    for _ in 0..6 {
        let pool = w.env.pool(&w.k.pool);
        if md.burn_plan((pool.reserve_base, pool.reserve_quote), w.env.clock().slot) == Plan::TooSoon {
            let slot = md.obs.0 + BURN_INTERVAL_SLOTS;
            go(w, slot);
        }
        if let Ran::Bought { spent, burned, .. } = must(try_run_burn(w, md, who)) {
            return (spent, burned);
        }
    }
    panic!("the burn did not get to buy");
}

fn hook_units(meta: &TransactionMetadata) -> Vec<u64> {
    let head = format!("Program {} consumed ", pid());
    meta.logs.iter().filter_map(|l| l.strip_prefix(&head)).map(|rest| rest.split(' ').next().unwrap().parse().unwrap()).collect()
}

// ---- 1. the config: bounds, kinds, and who may bind a coin --------------------------------

/// A coin created through the launchpad's pegged path with `hook_program`, and nothing else.
fn bare_coin(hook_program: &Pubkey) -> (Env, Market, Keypair, Keypair, PoolKeys) {
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let dev = env.user(50 * SOL);
    let acc = env.create_ata(&dev, &dev.pubkey(), &m.quote_mint);
    env.mint_to(&m.authority, &m.quote_mint, &acc, 5_000 * SOL);
    let mint = Keypair::new();
    let k = Env::pool_keys_with(&mint.pubkey(), &m.quote_mint, &TOKEN_2022);
    let mut ixs = vec![compute_budget_ix(400_000)];
    ixs.extend(create_token_ixs(&dev.pubkey(), &mint.pubkey(), hook_program));
    env.ok(&ixs, &[&dev, &mint]);
    (env, m, dev, mint, k)
}

#[test]
fn every_bound_of_a_strict_config_and_only_the_coin_itself_binds_it() {
    let (mut env, m, dev, mint, k) = bare_coin(&pid());
    let d = dev.pubkey();
    // a strict coin has every rate of a plain coin, the burn included
    let ok_args = RulesArgs { buy: rates3(100, 100, 100), sell: rates3(100, 100, 500), ..Default::default() };
    let s = |max_wallet_bps: u16, max_wallet_slots: u32, early_slots: u16, early_unlock_slots: u32| StrictArgs { max_wallet_bps, max_wallet_slots, early_slots, early_unlock_slots };
    let refused = |env: &mut Env, args: RulesArgs, strict: StrictArgs, needle: &str| {
        env.err(&[compute_budget_ix(400_000), strict_config_ix(&d, &k, args, strict)], &[&dev, &mint], needle);
    };
    // max wallet: 10 to 5,000 bps, 1 to 6,480,000 slots, both or neither
    refused(&mut env, ok_args, s(9, 100, 0, 0), "max wallet outside its bounds");
    refused(&mut env, ok_args, s(5_001, 100, 0, 0), "max wallet outside its bounds");
    refused(&mut env, ok_args, s(100, 6_480_001, 0, 0), "max wallet outside its bounds");
    refused(&mut env, ok_args, s(100, 0, 0, 0), "max wallet needs both a share and a window");
    refused(&mut env, ok_args, s(0, 100, 0, 0), "max wallet needs both a share and a window");
    // early lock: window 1 to 9,000 slots, unlock from the end of the window to 1,512,000
    refused(&mut env, ok_args, s(0, 0, 9_001, 9_001), "early lock outside its bounds");
    refused(&mut env, ok_args, s(0, 0, 100, 99), "early lock outside its bounds");
    refused(&mut env, ok_args, s(0, 0, 100, 1_512_001), "early lock outside its bounds");
    refused(&mut env, ok_args, s(0, 0, 100, 0), "early lock needs both a window and an unlock");
    refused(&mut env, ok_args, s(0, 0, 0, 100), "early lock needs both a window and an unlock");
    // the bounds every rules coin has still hold, the burn rate's included
    refused(&mut env, RulesArgs { buy: rates(501, 0), ..Default::default() }, s(0, 0, 0, 0), "CreatorFeeTooHigh");
    refused(&mut env, RulesArgs { sell: rates3(0, 0, 501), ..Default::default() }, s(0, 0, 0, 0), "BurnFeeTooHigh");
    refused(&mut env, RulesArgs { buy: rates3(400, 400, 201), ..Default::default() }, s(0, 0, 0, 0), "SideTooHigh");
    // the pool must be the pool of the two mints
    let other = Env::pool_keys_with(&k.quote_mint, &k.base_mint, &TOKEN_2022);
    let mut ix = strict_config_ix(&d, &k, ok_args, s(0, 0, 0, 0));
    ix.data = hook_rules::instruction::InitStrictConfig { pool: other.pool, args: ok_args, strict: s(0, 0, 0, 0) }.data();
    assert!(env.send(&[compute_budget_ix(400_000), ix], &[&dev, &mint]).is_err());

    // The coin signs. Without its signature nobody binds it: not a stranger, not the
    // launcher.
    let stranger = env.user(10 * SOL);
    let mut ix = strict_config_ix(&stranger.pubkey(), &k, ok_args, s(0, 0, 0, 0));
    ix.accounts[1].is_signer = false;
    assert!(env.send(&[compute_budget_ix(400_000), ix], &[&stranger]).is_err(), "a config without the coin's signature");
    // the plain config is not for a coin whose transfer hook is this program
    let plain = Env::rules_config_ix(&d, &k, ok_args);
    env.err(&[compute_budget_ix(400_000), plain], &[&dev], "transfer hook and the kind of its config do not agree");

    // every ceiling at once is accepted, and written where the layout says
    let top = s(5_000, 6_480_000, 9_000, 1_512_000);
    env.ok(&[compute_budget_ix(400_000), strict_config_ix(&d, &k, ok_args, top)], &[&dev, &mint]);
    let raw = env.svm.get_account(&cfg_of(&k)).unwrap().data;
    assert_eq!(raw.len(), 414, "the config of a strict coin has the size of every rules config");
    assert_eq!((raw[374], raw[375], raw[376]), (1, 0, 0), "kind, buy mark, vault bump");
    assert_eq!(u16::from_le_bytes(raw[377..379].try_into().unwrap()), 5_000);
    assert_eq!(u16::from_le_bytes(raw[379..381].try_into().unwrap()), 9_000);
    assert_eq!(u32::from_le_bytes(raw[381..385].try_into().unwrap()), 6_480_000);
    assert_eq!(u32::from_le_bytes(raw[385..389].try_into().unwrap()), 1_512_000);
    assert_eq!(raw[389..414], [0u8; 25], "max_wallet_amount and the reserve are zero before the pool");
    assert_eq!((u16::from_le_bytes(raw[184..186].try_into().unwrap()), u16::from_le_bytes(raw[190..192].try_into().unwrap())), (100, 500), "the two burn rates");
    // once: the coin cannot be bound to a second config, for this pool or another
    env.svm.expire_blockhash();
    assert!(env.send(&[compute_budget_ix(400_000), strict_config_ix(&d, &k, ok_args, top)], &[&dev, &mint]).is_err());
    let k2 = Env::pool_keys_with(&k.base_mint, &m.base_mint, &TOKEN_2022);
    let mut again = strict_config_ix(&d, &k2, ok_args, top);
    again.accounts[2].pubkey = m.base_mint;
    assert!(env.send(&[compute_budget_ix(400_000), again], &[&dev, &mint]).is_err(), "one coin, one config");

    // a strict config is only for a coin whose transfer hook is this program
    let (mut env, _m, dev, mint, k) = bare_coin(&hook_collectible::ID);
    env.err(&[compute_budget_ix(400_000), strict_config_ix(&dev.pubkey(), &k, ok_args, s(0, 0, 0, 0))], &[&dev, &mint], "transfer hook and the kind of its config do not agree");
}

#[test]
fn the_instructions_of_a_plain_coin_refuse_a_strict_coin_and_the_other_way_round() {
    let (mut w, _md) = launch(Launch { dev_buy: SOL, ..Default::default() });
    let dev = w.dev.insecure_clone();
    let d = dev.pubkey();
    let r = RulesKeys::of(&w.k);
    // stake: nothing is staked on a strict coin. (The stake vault does not exist either.)
    let stake = Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::Stake {
            staker: d,
            cfg: r.cfg,
            pool: w.k.pool,
            stake: RulesKeys::stake(&w.k, &d),
            base_mint: w.k.base_mint,
            stake_vault: r.stake_vault,
            staker_base: coins_of(&w.k, &d),
            base_token_program: TOKEN_2022,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::Stake { amount: 1 }.data(),
    };
    assert!(w.env.send(&[stake], &[&dev]).is_err());
    // the vault lock of a plain coin
    let lock = Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::LockCreator {
            creator: d,
            cfg: r.cfg,
            lock: r.lock,
            base_mint: w.k.base_mint,
            lock_vault: r.lock_vault,
            creator_base: coins_of(&w.k, &d),
            base_token_program: TOKEN_2022,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: hook_rules::instruction::LockCreator { amount: 1, unlock_at: START_TIME + DAY }.data(),
    };
    w.env.err(&[compute_budget_ix(400_000), lock], &[&dev], "not for a strict coin");
    assert!(w.env.svm.get_account(&r.lock_vault).is_none(), "no vault was made");
    // the burn of a plain coin. Its burn account does not exist on a strict coin; anyone
    // may make it, and the instruction still says no.
    w.env.ok(&[Env::create_ata_with_ix(&d, &r.authority, &w.k.base_mint, &TOKEN_2022)], &[&dev]);
    let run = Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::RunBurn {
            payer: d,
            cfg: r.cfg,
            hook_authority: r.authority,
            platform: w.env.platform,
            pool: w.k.pool,
            base_mint: w.k.base_mint,
            quote_mint: w.k.quote_mint,
            base_vault: w.k.base_vault,
            quote_vault: w.k.quote_vault,
            treasury_quote: r.treasury,
            authority_base: coins_of(&w.k, &r.authority),
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: TOKEN_2022,
            quote_token_program: TOKEN,
            event_authority: event_authority_address(&pid()),
            program: pid(),
        }
        .to_account_metas(None),
        data: hook_rules::instruction::RunBurn { min_amount_out: 0 }.data(),
    };
    w.env.err(&[run], &[&dev], "not for a strict coin");

    // and on a plain coin the strict instructions say no
    let mut env = Env::new();
    env.set_clock(START_SLOT, START_TIME);
    let m = env.market();
    let k = Env::pool_keys(&m.base_mint, &m.quote_mint);
    let hook = env.rules_hook(&m.creator, &k, RulesArgs { buy: Rates { creator_bps: 100, holders_bps: 100, burn_bps: 100 }, ..Default::default() });
    let ix = env.create_pool_ix(&m.creator.pubkey(), &k, LP_FEE, 1_000_000_000_000, QUOTE_LIQ, &hook);
    env.ok(&[compute_budget_ix(400_000), ix], &[&m.creator]);
    let t = m.trader.insecure_clone();
    let mut open = open_holder_ix(&k, &t.pubkey());
    open.accounts[4].pubkey = ata_with(&t.pubkey(), &k.base_mint, &TOKEN_2022);
    env.err(&[open], &[&t], "only for a strict coin");
    env.swap(&t, &k, &hook, DIRECTION_BUY, SOL, 0).unwrap();
    env.swap(&t, &k, &hook, DIRECTION_SELL, 1_000_000, 0).unwrap();
    // the strict coin's burn says no to a plain coin, which has its own
    let mut run = run_burn_ix(&env, &k, &t.pubkey(), 0);
    run.accounts[12].pubkey = TOKEN;
    env.err(&[run], &[&t], "only for a strict coin");
    // a plain coin's config keeps its last 40 bytes at zero, whatever happens to it
    let raw = env.svm.get_account(&hook_rules::cfg_address(&k.pool)).unwrap().data;
    assert_eq!(raw.len(), 414);
    assert_eq!(raw[374..414], [0u8; 40]);
}

// ---- 2. a launch through the launchpad -----------------------------------------------------

/// The addresses the platform's lookup table holds (scripts/init-platform.mjs), for the
/// size of a transaction compiled with it. On a real chain the quote is wrapped SOL, which
/// is in the table; here it is a test mint, counted as if it were.
fn lookup_table(env: &Env, k: &PoolKeys) -> Vec<Pubkey> {
    let templates = [hook_tax::ID, hook_launch_guard::ID, hook_buyback::ID, hook_collectible::ID, hook_rules::ID];
    let mut t = vec![
        hookpool::ID,
        hooklaunch::ID,
        TOKEN,
        TOKEN_2022,
        ATA_PROGRAM,
        system_program::ID,
        MPL,
        MPL_CORE,
        k.quote_mint,
        Pubkey::from_str_const("ComputeBudget111111111111111111111111111111"),
        Pubkey::from_str_const("SysvarRent111111111111111111111111111111111"),
        env.platform,
        env.treasury.pubkey(),
        caller_address(&system_program::ID).0,
        event_authority_address(&hookpool::ID),
        event_authority_address(&hooklaunch::ID),
        event_authority_address(&hook_buyback::ID),
        event_authority_address(&hook_rules::ID),
    ];
    for p in templates {
        let h = HookRef { program: p, treasury: system_program::ID, extra: vec![] };
        t.extend([p, caller_address(&p).0, h.manifest(), h.extra_metas(), h.program_data()]);
    }
    t
}

/// The size of a v0 transaction with these instructions, compiled with one lookup table.
/// Signers and invoked programs stay in the message; every other address the table holds
/// costs one byte.
fn tx_size_v0(ixs: &[Instruction], payer: &Pubkey, n_signers: usize, table: &[Pubkey]) -> usize {
    let mut keys: Vec<(Pubkey, bool, bool)> = vec![(*payer, true, false)];
    let mut touch = |k: Pubkey, signer: bool, invoked: bool| match keys.iter_mut().find(|e| e.0 == k) {
        Some(e) => {
            e.1 |= signer;
            e.2 |= invoked;
        }
        None => keys.push((k, signer, invoked)),
    };
    for ix in ixs {
        touch(ix.program_id, false, true);
        for a in &ix.accounts {
            touch(a.pubkey, a.is_signer, false);
        }
    }
    let looked = keys.iter().filter(|k| !k.1 && !k.2 && table.contains(&k.0)).count();
    let statics = keys.len() - looked;
    let compact = |n: usize| if n < 128 { 1 } else { 2 };
    let body: usize = ixs.iter().map(|ix| 1 + compact(ix.accounts.len()) + ix.accounts.len() + compact(ix.data.len()) + ix.data.len()).sum();
    // signatures, version, header, static keys, blockhash, instructions, one table lookup
    compact(n_signers) + 64 * n_signers + 1 + 3 + compact(statics) + 32 * statics + 32 + compact(ixs.len()) + body + 1 + 32 + 1 + 1 + looked
}

#[test]
fn a_strict_coin_launches_through_the_launchpad_with_a_first_buy_and_a_creator_lock() {
    let args = RulesArgs { sniper_slots: 200, sniper_start_fee_bps: 4_000, buy: rates(50, 100), sell: rates(50, 100), max_buy_quote: 3 * SOL, limit_slots: 100, creator_lock_seconds: 90 * 86_400 };
    let strict = StrictArgs { max_wallet_bps: 200, max_wallet_slots: 216_000, early_slots: 750, early_unlock_slots: 216_000 };
    let l = Launch { args, strict, dev_buy: 2 * SOL, lock_until: Some(START_TIME + 90 * DAY), ..Default::default() };

    // sizes and compute of the two transactions, legacy and with the lookup table
    {
        let mut env = Env::new();
        env.set_clock(START_SLOT, START_TIME);
        let m = env.market();
        let dev = env.user(50 * SOL);
        let acc = env.create_ata(&dev, &dev.pubkey(), &m.quote_mint);
        env.mint_to(&m.authority, &m.quote_mint, &acc, 5_000 * SOL);
        let mint = Keypair::new();
        let k = Env::pool_keys_with(&mint.pubkey(), &m.quote_mint, &TOKEN_2022);
        let (one, two) = launch_ixs(&env, &dev.pubkey(), &k, &l);
        let table = lookup_table(&env, &k);
        let (s1, s2) = (env.tx_size(&one, &dev.pubkey(), 2), env.tx_size(&two, &dev.pubkey(), 1));
        let (v1, v2) = (tx_size_v0(&one, &dev.pubkey(), 2, &table), tx_size_v0(&two, &dev.pubkey(), 1, &table));
        let m1 = env.ok(&one, &[&dev, &mint]);
        let m2 = env.ok(&two, &[&dev]);
        println!("strict launch, transaction 1 (coin, rules, holder record): {s1} bytes legacy, {v1} bytes with the lookup table, {} CU", m1.compute_units_consumed);
        println!("strict launch, transaction 2 (launch, first buy, creator lock): {s2} bytes legacy, {v2} bytes with the lookup table, {} CU, the hook {:?}", m2.compute_units_consumed, hook_units(&m2));
        assert!(v1 <= 1232 && v2 <= 1232, "both launch transactions fit with the lookup table: {v1} {v2}");
    }

    let (mut w, mut md) = launch(l);
    let dev = w.dev.insecure_clone();
    let d = dev.pubkey();
    let pool = w.env.pool(&w.k.pool);
    assert_eq!(pool.hook_program, pid());
    assert_eq!(pool.hook_kind, HOOK_KIND_PLATFORM);
    assert_eq!(pool.hook_flags, hook_rules::FLAGS);
    assert_eq!(pool.hook_quote_treasury, treasury_of(&w.k));
    assert_eq!(pool.swap_count, 1);
    // the launch liquidity is locked forever, as for every launch
    assert_eq!(w.env.balance(&ata(&d, &w.k.lp_mint)), 0);
    let c = cfg(&w);
    assert_eq!((c.kind, c.start_slot, c.start_time, c.min_eligible), (1, START_SLOT, START_TIME, SUPPLY / 1_000));
    assert_eq!(c.max_wallet_amount, SUPPLY / 50, "2% of the supply");
    assert_eq!(c.vault_bump, vault_address(&w.k.pool, &w.k.base_mint).1);
    assert_eq!((c.max_wallet_bps, c.max_wallet_slots, c.early_slots, c.early_unlock_slots), (200, 216_000, 750, 216_000));

    // the first buy is a buy like any other: the full sniper fee, both hook rates, and
    // it is early
    let first = hookpool::math::quote_swap(DIRECTION_BUY, 2 * SOL, SUPPLY, QUOTE_LIQ, 0, LP_FEE, PROTOCOL_FEE_BPS, 150, Some(4_000), None).unwrap();
    assert_eq!(bal(&w, &d), first.amount_out);
    let rec: HolderRecord = w.env.account(&holder_of(&w.k, &d));
    assert_eq!((rec.balance, rec.early_bought, rec.locked, rec.locked_until), (first.amount_out, first.amount_out, first.amount_out, START_TIME + 90 * DAY));
    // the holder record, byte for byte where the layout says
    let raw = w.env.svm.get_account(&holder_of(&w.k, &d)).unwrap().data;
    assert_eq!(raw.len(), 129);
    let at = |o: usize| u64::from_le_bytes(raw[o..o + 8].try_into().unwrap());
    assert_eq!(raw[9..41], w.k.pool.to_bytes());
    assert_eq!(raw[41..73], d.to_bytes());
    assert_eq!((at(73), at(97), at(105), at(113), at(121) as i64), (first.amount_out, 0, first.amount_out, first.amount_out, START_TIME + 90 * DAY));
    let lock: LockRecord = w.env.account(&hook_rules::lock_address(&w.k.pool));
    assert_eq!((lock.amount, lock.unlock_at), (first.amount_out, START_TIME + 90 * DAY));
    // the list Token-2022 reads: three entries, at the address every wallet derives
    let list = w.env.svm.get_account(&validation_of(&w.k)).unwrap();
    assert_eq!((list.owner.to_bytes(), list.data.len()), (pid().to_bytes(), ExtraAccountMetaList::size_of(3).unwrap()));

    // the launcher cannot sell or send what it bought: early, and locked
    assert_eq!(try_trade(&mut w, &mut md, &dev, DIRECTION_SELL, 1_000_000), Err("coins bought early are locked until the unlock"));
    let friend = w.env.user(SOL).pubkey();
    assert_eq!(try_send(&mut w, &mut md, &dev, &friend, 1), Err("coins bought early are locked until the unlock"));
    // after the early unlock the creator lock still holds, to the day
    go(&mut w, START_SLOT + 216_000);
    assert_eq!(try_trade(&mut w, &mut md, &dev, DIRECTION_SELL, 1_000_000), Err("the creator's locked coins cannot move before the unlock time"));
    w.env.set_clock(START_SLOT + 300_000, START_TIME + 90 * DAY - 1);
    assert_eq!(try_send(&mut w, &mut md, &dev, &friend, 1), Err("the creator's locked coins cannot move before the unlock time"));
    assert_eq!(try_unlock(&mut w, &mut md), Err("the creator lock is not over yet"));
    w.env.set_clock(START_SLOT + 300_001, START_TIME + 90 * DAY);
    // from the unlock time on the coins move, with or without `unlock_creator_strict`
    must(try_send(&mut w, &mut md, &dev, &friend, 1));
    assert_eq!(must(try_unlock(&mut w, &mut md)), first.amount_out);
    trade(&mut w, &mut md, &dev, DIRECTION_SELL, first.amount_out - 1);
}

#[test]
fn a_first_buy_above_the_max_wallet_or_without_a_record_in_the_early_window_fails_the_launch() {
    // the launcher's own first buy is a buy like any other
    for (strict, dev_record, needle) in [
        (StrictArgs { max_wallet_bps: 10, max_wallet_slots: 1_000, ..Default::default() }, true, "above the max wallet"),
        (StrictArgs { early_slots: 100, early_unlock_slots: 1_000, ..Default::default() }, false, "needs the wallet's holder record"),
    ] {
        let mut env = Env::new();
        env.set_clock(START_SLOT, START_TIME);
        let m = env.market();
        let dev = env.user(50 * SOL);
        let acc = env.create_ata(&dev, &dev.pubkey(), &m.quote_mint);
        env.mint_to(&m.authority, &m.quote_mint, &acc, 5_000 * SOL);
        let mint = Keypair::new();
        let k = Env::pool_keys_with(&mint.pubkey(), &m.quote_mint, &TOKEN_2022);
        // 0.1% of the supply costs about 0.1 SOL here: 2 SOL buys far more
        let l = Launch { strict, dev_buy: 2 * SOL, dev_record, ..Default::default() };
        let (one, two) = launch_ixs(&env, &dev.pubkey(), &k, &l);
        env.ok(&one, &[&dev, &mint]);
        env.err(&two, &[&dev], needle);
        assert!(env.svm.get_account(&k.pool).is_none_or(|a| a.data.is_empty()), "no pool was created");
    }
}

// ---- 3. the max wallet ---------------------------------------------------------------------

#[test]
fn the_max_wallet_holds_buys_and_sends_inside_its_window_and_never_a_sell() {
    // 1% of the supply for 1,000 slots
    let strict = StrictArgs { max_wallet_bps: 100, max_wallet_slots: 1_000, ..Default::default() };
    let (mut w, mut md) = launch(Launch { strict, ..Default::default() });
    let cap = SUPPLY / 100;
    assert_eq!(cfg(&w).max_wallet_amount, cap);
    let a = wallet(&mut w, 1_000 * SOL);
    let b = wallet(&mut w, 1_000 * SOL);
    let (pa, pb) = (a.pubkey(), b.pubkey());

    // a buy that would leave the wallet above the cap is refused; the largest that fits
    // goes through
    assert_eq!(try_trade(&mut w, &mut md, &a, DIRECTION_BUY, 2 * SOL), Err("above the max wallet"));
    let q = trade(&mut w, &mut md, &a, DIRECTION_BUY, SOL);
    assert!(q.amount_out < cap);
    // a send that would lift the receiver above the cap is refused; one that reaches it
    // exactly is fine
    trade(&mut w, &mut md, &b, DIRECTION_BUY, SOL);
    let room = cap - bal(&w, &pa);
    assert_eq!(try_send(&mut w, &mut md, &b, &pa, room + 1), Err("above the max wallet"));
    must(try_send(&mut w, &mut md, &b, &pa, room));
    assert_eq!(bal(&w, &pa), cap);
    // a wallet at the cap cannot buy one unit more ...
    assert_eq!(try_trade(&mut w, &mut md, &a, DIRECTION_BUY, SOL / 1_000), Err("above the max wallet"));
    // ... and can always sell and send
    trade(&mut w, &mut md, &a, DIRECTION_SELL, cap / 2);
    must(try_send(&mut w, &mut md, &a, &pb, 1_000));
    // nobody adds liquidity while the max wallet runs: coins that come back out of the
    // pool are never held to it, so a deposit would be a way around it
    assert_eq!(try_add_liquidity(&mut w, &mut md, &a, 1_000_000), Err("liquidity cannot be added while the max wallet runs"));
    let failed = w.env.err(&[w.env.add_liquidity_ix(&pa, &w.k, &hook_for(&w.k, &pa), 1_000_000, u64::MAX, u64::MAX)], &[&a], "max wallet runs");
    assert!(failed.meta.logs.iter().any(|l| l.contains("Error Number: 6048")));

    // the protocol's fees in the coin leave the vault for the platform's wallet: a
    // transfer out of the pool that is not a buy, never held to the cap
    let fees = w.env.pool(&w.k.pool).protocol_fees_base;
    assert!(fees > 0);
    let treasury = w.env.treasury.pubkey();
    let mut ix = w.env.collect_ix(&pa, &w.k);
    ix.accounts.extend(hook_metas(&w.k, &w.k.pool, &treasury));
    ix.accounts.push(AccountMeta::new_readonly(pid(), false));
    must(md.moved(None, Some((treasury, fees)), fees, false, true, w.env.clock().slot, START_TIME));
    w.env.ok(&[compute_budget_ix(400_000), ix], &[&a]);
    assert_eq!(bal(&w, &treasury), fees);
    check(&w, &md);

    // the last slot of the window, and the first one after it
    go(&mut w, START_SLOT + 999);
    assert_eq!(try_trade(&mut w, &mut md, &b, DIRECTION_BUY, 5 * SOL), Err("above the max wallet"));
    go(&mut w, START_SLOT + 1_000);
    let q = trade(&mut w, &mut md, &b, DIRECTION_BUY, 5 * SOL);
    assert!(bal(&w, &pb) > cap && q.amount_out > cap);
    must(try_send(&mut w, &mut md, &b, &pa, cap));
    // and liquidity is welcome again; taking it out pays the wallet whatever it holds
    let lp = w.env.mint_supply(&w.k.lp_mint) / 50;
    must(try_add_liquidity(&mut w, &mut md, &b, lp));
    let lp = w.env.balance(&ata(&pb, &w.k.lp_mint));
    remove_liquidity(&mut w, &mut md, &b, lp);
}

#[test]
fn liquidity_that_leaves_the_pool_is_never_held_to_the_max_wallet_or_the_early_lock() {
    // A pool made directly with create_pool leaves the LP tokens with its creator, so
    // liquidity can leave while the windows run. "A liquidity provider can always leave"
    // comes before both rules: what the pool pays out for a removal is not a buy.
    let args = RulesArgs { buy: rates(50, 100), sell: rates(50, 100), ..Default::default() };
    let strict = StrictArgs { max_wallet_bps: 100, max_wallet_slots: 10_000, early_slots: 500, early_unlock_slots: 10_000 };
    let (mut env, m, dev, mint, k) = bare_coin(&pid());
    let d = dev.pubkey();
    env.ok(&[compute_budget_ix(400_000), strict_config_ix(&d, &k, args, strict), open_holder_ix(&k, &d)], &[&dev, &mint]);
    // the launcher keeps a fifth of the supply out of the pool
    let in_pool = SUPPLY / 5 * 4;
    let ix = env.create_pool_ix(&d, &k, LP_FEE, in_pool, QUOTE_LIQ, &hook_for(&k, &d));
    env.ok(&[compute_budget_ix(400_000), ix], &[&dev]);
    let mut md = Model::new(args, strict);
    md.open(&d, SUPPLY, 0);
    must(md.moved(Some((d, SUPPLY - in_pool)), None, in_pool, false, true, START_SLOT, START_TIME));
    md.started(START_SLOT, START_TIME);
    let fixed = fixed_bytes(&env, &k);
    let known = vec![d, env.treasury.pubkey()];
    let mut w = World { env, m, dev, k, known, fixed, last_run: (0, 0) };
    check(&w, &md);
    let dev = w.dev.insecure_clone();
    let cap = SUPPLY / 100;
    assert!(bal(&w, &d) > 10 * cap, "what the launcher kept is far above the cap: nothing ever capped it");

    // a buy by the creator, far above the cap already: refused like anyone's
    assert_eq!(try_trade(&mut w, &mut md, &dev, DIRECTION_BUY, SOL), Err("above the max wallet"));
    // a tenth of its liquidity out, inside both windows: paid, not early, not capped
    let lp = w.env.balance(&ata(&d, &w.k.lp_mint)) / 10;
    let before = bal(&w, &d);
    let coins = remove_liquidity(&mut w, &mut md, &dev, lp);
    assert!(coins > cap && bal(&w, &d) == before + coins);
    let rec: HolderRecord = w.env.account(&holder_of(&w.k, &d));
    assert_eq!((rec.early_bought, rec.balance), (0, before + coins), "coins from a removal are not early coins");
    // so the creator can send them on, in the early window
    let friend = w.env.user(SOL).pubkey();
    must(try_send(&mut w, &mut md, &dev, &friend, cap));

    // The mark that tells a buy from a removal, under attack. One transaction: a buy by
    // another wallet, then the creator's removal, then another buy. Each transfer out of
    // the vault is what it is.
    let a = wallet(&mut w, 1_000 * SOL);
    let pa = a.pubkey();
    open(&mut w, &mut md, &a);
    let pool = w.env.pool(&w.k.pool);
    let (slot, now) = (w.env.clock().slot, START_TIME);
    let q1 = must(md.swap((pool.reserve_base, pool.reserve_quote), pool.hook_fees_quote_total, DIRECTION_BUY, SOL / 2, slot));
    must(md.moved(None, Some((pa, q1.amount_out)), q1.amount_out, true, true, slot, now));
    let supply = w.env.mint_supply(&w.k.lp_mint);
    let out = (lp as u128 * q1.reserve_out_after as u128 / supply as u128) as u64;
    let held = bal(&w, &d);
    must(md.moved(None, Some((d, held + out)), out, false, true, slot, now));
    let rb = q1.reserve_out_after - out;
    let rq = q1.reserve_in_after - (lp as u128 * q1.reserve_in_after as u128 / supply as u128) as u64;
    let q2 = must(md.swap((rb, rq), pool.hook_fees_quote_total + q1.hook_fee, DIRECTION_BUY, SOL / 4, slot));
    must(md.moved(None, Some((pa, q1.amount_out + q2.amount_out)), q2.amount_out, true, true, slot, now));
    let ixs = [
        compute_budget_ix(1_000_000),
        w.env.swap_ix(&pa, &w.k, &hook_for(&w.k, &pa), DIRECTION_BUY, SOL / 2, q1.amount_out),
        w.env.remove_liquidity_ix(&d, &w.k, &hook_for(&w.k, &d), lp, out, 0),
        w.env.swap_ix(&pa, &w.k, &hook_for(&w.k, &pa), DIRECTION_BUY, SOL / 4, q2.amount_out),
    ];
    w.env.ok(&ixs, &[&a, &dev]);
    check(&w, &md);
    let (ra, rd): (HolderRecord, HolderRecord) = (w.env.account(&holder_of(&w.k, &pa)), w.env.account(&holder_of(&w.k, &d)));
    assert_eq!(ra.early_bought, q1.amount_out + q2.amount_out, "both buys are early, to the unit");
    assert_eq!(rd.early_bought, 0, "the removal between them is not");
    // a buy that fails leaves no mark behind for the removal after it. (A failed
    // instruction fails its transaction; the next one starts clean.)
    assert_eq!(try_trade(&mut w, &mut md, &a, DIRECTION_BUY, 50 * SOL), Err("above the max wallet"));
    remove_liquidity(&mut w, &mut md, &dev, lp);
    assert_eq!(cfg(&w).buy_mark, 0);
    // a sell and then a removal: the sell leaves no mark either
    trade(&mut w, &mut md, &dev, DIRECTION_SELL, 1_000_000);
    remove_liquidity(&mut w, &mut md, &dev, lp);
    let rd: HolderRecord = w.env.account(&holder_of(&w.k, &d));
    assert_eq!(rd.early_bought, 0);
    // the creator's own liquidity cannot go back in while the max wallet runs
    assert_eq!(try_add_liquidity(&mut w, &mut md, &dev, lp), Err("liquidity cannot be added while the max wallet runs"));
}

// ---- 4. the early lock ---------------------------------------------------------------------

#[test]
fn coins_bought_in_the_early_window_stay_in_the_wallet_until_the_unlock() {
    // buys in the first 100 slots are early; they unlock 1,000 slots after the launch
    let strict = StrictArgs { early_slots: 100, early_unlock_slots: 1_000, ..Default::default() };
    let (mut w, mut md) = launch(Launch { strict, ..Default::default() });
    let a = wallet(&mut w, 1_000 * SOL);
    let b = wallet(&mut w, 1_000 * SOL);
    let late = wallet(&mut w, 1_000 * SOL);
    let (pa, pb) = (a.pubkey(), b.pubkey());

    // a buy in the window needs the wallet's holder record, with a clear error
    assert_eq!(try_trade(&mut w, &mut md, &a, DIRECTION_BUY, SOL), Err("needs the wallet's holder record"));
    let failed = w.env.err(&[w.env.swap_ix(&pa, &w.k, &hook_for(&w.k, &pa), DIRECTION_BUY, SOL, 0)], &[&a], "open it first");
    assert!(failed.meta.logs.iter().any(|l| l.contains("Error Number: 6047")));
    open(&mut w, &mut md, &a);
    open(&mut w, &mut md, &b);
    let qa = trade(&mut w, &mut md, &a, DIRECTION_BUY, SOL);
    go(&mut w, START_SLOT + 99);
    let qb = trade(&mut w, &mut md, &b, DIRECTION_BUY, 2 * SOL);
    let (ra, rb): (HolderRecord, HolderRecord) = (w.env.account(&holder_of(&w.k, &pa)), w.env.account(&holder_of(&w.k, &pb)));
    assert_eq!((ra.early_bought, rb.early_bought), (qa.amount_out, qb.amount_out));

    // not one unit of them can be sold, sent, or put into the pool as liquidity
    assert_eq!(try_trade(&mut w, &mut md, &a, DIRECTION_SELL, 1_000_000), Err("coins bought early are locked until the unlock"));
    assert_eq!(try_send(&mut w, &mut md, &a, &pb, 1), Err("coins bought early are locked until the unlock"));
    assert_eq!(try_add_liquidity(&mut w, &mut md, &a, 1_000), Err("coins bought early are locked until the unlock"));
    // a delegate cannot move them either: the rule follows the wallet that owns the
    // account, whoever signs
    let thief = w.env.user(SOL);
    w.known.push(thief.pubkey());
    w.env.ok(&[Env::create_ata_with_ix(&thief.pubkey(), &thief.pubkey(), &w.k.base_mint, &TOKEN_2022)], &[&thief]);
    let approve = t22::instruction::approve(&TOKEN_2022, &coins_of(&w.k, &pa), &thief.pubkey(), &pa, &[], 1_000).unwrap();
    w.env.ok(&[approve], &[&a]);
    let pull = transfer_between(&w.k, &coins_of(&w.k, &pa), &pa, &coins_of(&w.k, &thief.pubkey()), &thief.pubkey(), &thief.pubkey(), 1_000);
    w.env.err(&[pull], &[&thief], "coins bought early are locked until the unlock");
    // the owner of the account cannot be changed: Token-2022 made it immutable
    let hand_over = t22::instruction::set_authority(&TOKEN_2022, &coins_of(&w.k, &pa), Some(&thief.pubkey()), t22::instruction::AuthorityType::AccountOwner, &pa, &[]).unwrap();
    assert!(w.env.send(&[hand_over], &[&a]).is_err(), "an associated token account never changes its owner");
    // and a wallet receives only in that account: a second token account of the same
    // wallet, or one whose owner could be handed over, is refused as a receiver
    let spare = Keypair::new();
    let space = t22::extension::ExtensionType::try_calculate_account_len::<t22::state::Account>(&[t22::extension::ExtensionType::TransferHookAccount]).unwrap();
    let make = [
        anchor_lang::solana_program::system_instruction::create_account(&pb, &spare.pubkey(), w.env.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
        t22::instruction::initialize_account3(&TOKEN_2022, &spare.pubkey(), &w.k.base_mint, &pb).unwrap(),
    ];
    w.env.ok(&make, &[&b, &spare]);

    // a buy after the window is free at once, while the early coins of others wait
    go(&mut w, START_SLOT + 100);
    let ql = trade(&mut w, &mut md, &late, DIRECTION_BUY, SOL);
    assert!(w.env.svm.get_account(&holder_of(&w.k, &late.pubkey())).is_none(), "no record is needed outside the window");
    trade(&mut w, &mut md, &late, DIRECTION_SELL, ql.amount_out / 2);
    // a second token account of b as receiver: refused, with a clear error
    let ix = transfer_between(&w.k, &coins_of(&w.k, &late.pubkey()), &late.pubkey(), &spare.pubkey(), &pb, &late.pubkey(), 1);
    let failed = w.env.err(&[ix], &[&late], "not the associated token account of its wallet");
    assert!(failed.meta.logs.iter().any(|l| l.contains("Error Number: 6043")));
    assert_eq!(w.env.balance(&spare.pubkey()), 0);
    // coins a wallet received in other ways are free: a buys more now, and can send or
    // sell exactly that much
    let more = trade(&mut w, &mut md, &a, DIRECTION_BUY, SOL);
    assert_eq!(cfg(&w).kind, 1);
    let ra: HolderRecord = w.env.account(&holder_of(&w.k, &pa));
    assert_eq!(ra.early_bought, qa.amount_out, "a buy after the window adds nothing to the early coins");
    assert_eq!(try_trade(&mut w, &mut md, &a, DIRECTION_SELL, more.amount_out + 1), Err("coins bought early are locked until the unlock"));
    trade(&mut w, &mut md, &a, DIRECTION_SELL, more.amount_out / 2);
    must(try_send(&mut w, &mut md, &a, &late.pubkey(), more.amount_out - more.amount_out / 2));
    assert_eq!(bal(&w, &pa), qa.amount_out);
    // received from another wallet: free too
    must(try_send(&mut w, &mut md, &late, &pb, 1_000));
    must(try_send(&mut w, &mut md, &b, &pa, 1_000));
    assert_eq!(try_send(&mut w, &mut md, &b, &pa, 1), Err("coins bought early are locked until the unlock"));
    // a record with early coins cannot be closed to escape the lock
    assert_eq!(try_close(&mut w, &mut md, &a), Err("the holder record still holds something"));

    // the last slot before the unlock, and the unlock
    go(&mut w, START_SLOT + 999);
    assert_eq!(try_trade(&mut w, &mut md, &b, DIRECTION_SELL, 1_000_000), Err("coins bought early are locked until the unlock"));
    go(&mut w, START_SLOT + 1_000);
    trade(&mut w, &mut md, &b, DIRECTION_SELL, qb.amount_out);
    must(try_send(&mut w, &mut md, &a, &pb, qa.amount_out + 1_000));
    // an empty record can be closed now, and its rent comes back
    let _ = try_claim(&mut w, &mut md, &a);
    let lamports = w.env.lamports(&pa);
    must(try_close(&mut w, &mut md, &a));
    assert!(w.env.lamports(&pa) > lamports);
}

// ---- 5. the holders' share, without staking -------------------------------------------------

#[test]
fn holders_with_a_record_are_paid_in_proportion_to_what_they_hold_to_the_lamport() {
    // 2% to holders on both sides, 0.5% to the creator
    let args = RulesArgs { buy: rates(50, 200), sell: rates(50, 200), ..Default::default() };
    let (mut w, mut md) = launch(Launch { args, dev_record: false, ..Default::default() });
    let a = wallet(&mut w, 1_000 * SOL);
    let b = wallet(&mut w, 1_000 * SOL);
    let c = wallet(&mut w, 1_000 * SOL);
    let t = wallet(&mut w, 1_000 * SOL);
    let (pa, pb, pc) = (a.pubkey(), b.pubkey(), c.pubkey());

    // nobody has a record: the holders' share goes to the burn pot, as on a plain coin with
    // nobody staked, and the trader pays the same 2.5%
    let q1 = trade(&mut w, &mut md, &a, DIRECTION_BUY, 10 * SOL);
    assert_eq!(q1.hook_fee, (10 * SOL - 10 * SOL / 500).div_ceil(40));
    let q2 = trade(&mut w, &mut md, &b, DIRECTION_BUY, 10 * SOL);
    assert_eq!(cfg(&w).burn_pot, q1.hook_fee - q1.hook_fee * 50 / 250, "the first buy's share is in the burn pot");
    // a opens its record: 0.1% of the supply is registered from here on. Opening settles
    // the second buy first, which was made while nobody was registered.
    open(&mut w, &mut md, &a);
    assert!(bal(&w, &pa) >= SUPPLY / 1_000);
    let pot = cfg(&w).burn_pot;
    assert_eq!(pot, q1.hook_fee - q1.hook_fee * 50 / 250 + q2.hook_fee - q2.hook_fee * 50 / 250);
    // from the next trade on the share is a's
    let q3 = trade(&mut w, &mut md, &t, DIRECTION_BUY, 5 * SOL);
    let q4 = trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000);
    assert!(cfg(&w).burn_pot - pot <= 1, "only what rounding leaves goes to the pot now");
    let waiting = 0u64;
    // the claim settles the small sell as well
    let paid = must(try_claim(&mut w, &mut md, &a));
    let expected = waiting + q3.hook_fee * 200 / 250 + q4.hook_fee * 200 / 250;
    // the accumulator carries what its division left, at most held / 10^12, to the next settlement
    let carried = (bal(&w, &pa) as u128 / ACC) as u64 + 2;
    assert!(paid <= expected && expected - paid <= carried, "{paid} of {expected}: one holder takes it all");

    // b registers late: it earns from here on, nothing of what came before
    open(&mut w, &mut md, &b);
    assert_eq!(try_claim(&mut w, &mut md, &b), Err("nothing to claim"));
    // c holds the coin and has no record: it earns nothing, and its part goes to a and b
    let half = bal(&w, &t.pubkey()) / 2;
    must(try_send(&mut w, &mut md, &t, &pc, half));
    let big = trade(&mut w, &mut md, &t, DIRECTION_BUY, 20 * SOL);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000);
    let (ha, hb) = (bal(&w, &pa) as u128, bal(&w, &pb) as u128);
    let share = (big.hook_fee * 200 / 250) as u128;
    let (ga, gb) = (must(try_claim(&mut w, &mut md, &a)) as u128, must(try_claim(&mut w, &mut md, &b)) as u128);
    println!("a holds {ha}, b holds {hb}: of a holders' share of {share} lamports a got {ga}, b got {gb}");
    // each got its part of that trade's share (and of the small trades around it)
    let carried = (ha + hb) / ACC + 2;
    assert!(ga + carried >= share * ha / (ha + hb) && gb + carried >= share * hb / (ha + hb));
    assert!((ga * hb).abs_diff(gb * ha) <= (ha + hb) * (carried + 2), "in proportion to what each holds");
    assert_eq!(try_claim(&mut w, &mut md, &c), Err("AccountNotInitialized"));

    // a balance counts as it is after every transfer: a sends half to b
    let half = bal(&w, &pa) / 2;
    must(try_send(&mut w, &mut md, &a, &pb, half));
    let (ra, rb): (HolderRecord, HolderRecord) = (w.env.account(&holder_of(&w.k, &pa)), w.env.account(&holder_of(&w.k, &pb)));
    assert_eq!((ra.balance, rb.balance), (bal(&w, &pa), bal(&w, &pb)));
    assert_eq!(cfg(&w).total_staked, ra.balance + rb.balance);

    // nobody opens a record for somebody else: the wallet itself signs and pays
    let stranger = w.env.user(SOL);
    let mut ix = open_holder_ix(&w.k, &pc);
    ix.accounts[0].is_signer = false;
    assert!(w.env.send(&[ix], &[&stranger]).is_err(), "a record without its wallet's signature");
    // opening twice changes nothing
    let before = w.env.svm.get_account(&holder_of(&w.k, &pa)).unwrap().data;
    w.env.svm.expire_blockhash();
    w.env.ok(&[open_holder_ix(&w.k, &pa)], &[&a]);
    assert_eq!(w.env.svm.get_account(&holder_of(&w.k, &pa)).unwrap().data, before);
    check(&w, &md);
    // the creator's part is the creator's, to the lamport
    let total = fees_total(&w);
    let creator = must(try_claim_creator(&mut w, &mut md));
    assert!(creator <= total * 50 / 250 && total * 50 / 250 - creator <= 20);
}

#[test]
fn a_burn_leaves_a_record_above_the_balance_until_anyone_syncs_it() {
    let args = RulesArgs { buy: rates(0, 300), sell: rates(0, 300), ..Default::default() };
    let (mut w, mut md) = launch(Launch { args, dev_record: false, ..Default::default() });
    let a = wallet(&mut w, 1_000 * SOL);
    let b = wallet(&mut w, 1_000 * SOL);
    let t = wallet(&mut w, 1_000 * SOL);
    let (pa, pb) = (a.pubkey(), b.pubkey());
    open(&mut w, &mut md, &a);
    open(&mut w, &mut md, &b);
    trade(&mut w, &mut md, &a, DIRECTION_BUY, 5 * SOL);
    let qb = trade(&mut w, &mut md, &b, DIRECTION_BUY, 5 * SOL);
    // a burns nearly everything it holds. The token program calls no hook for a burn:
    // a's record still says what it held.
    let held = bal(&w, &pa);
    burn(&mut w, &md, &a, held - 1_000);
    let ra: HolderRecord = w.env.account(&holder_of(&w.k, &pa));
    assert_eq!((ra.balance, bal(&w, &pa)), (held, 1_000));
    // until somebody syncs it, a is paid on coins that are gone, out of b's part
    let big = trade(&mut w, &mut md, &t, DIRECTION_BUY, 10 * SOL);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000);
    let share = big.hook_fee;
    let ga = must(try_claim(&mut w, &mut md, &a));
    let gb = must(try_claim(&mut w, &mut md, &b));
    println!("a burned its coins and was not synced: of a share of {share} it still took {ga}, b took {gb}");
    assert!(ga > share / 3, "the stale record was paid");
    // anyone sends the sync; it only ever lowers
    let anyone = w.env.user(SOL);
    sync(&mut w, &mut md, &anyone, &pa);
    let ra: HolderRecord = w.env.account(&holder_of(&w.k, &pa));
    assert_eq!(ra.balance, 1_000);
    w.env.svm.expire_blockhash();
    sync(&mut w, &mut md, &anyone, &pb);
    let rb: HolderRecord = w.env.account(&holder_of(&w.k, &pb));
    assert_eq!(rb.balance, qb.amount_out, "a record that is right is left alone");
    // a sync with another wallet's token account is refused
    let mut ix = sync_holder_ix(&w.k, &pa);
    ix.accounts[3].pubkey = coins_of(&w.k, &pb);
    w.env.err(&[ix], &[&anyone], "not the associated token account of this wallet");
    // from here b takes nearly all of it
    let big = trade(&mut w, &mut md, &t, DIRECTION_BUY, 10 * SOL);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000);
    let gb = must(try_claim(&mut w, &mut md, &b));
    assert!(gb > big.hook_fee * 99 / 100);
    // a record is also put right by the wallet's own next transfer
    let held = bal(&w, &pb);
    burn(&mut w, &md, &b, held / 2);
    must(try_send(&mut w, &mut md, &b, &pa, 10));
    let rb: HolderRecord = w.env.account(&holder_of(&w.k, &pb));
    assert_eq!(rb.balance, bal(&w, &pb));
}

// ---- 6. the hook runs only inside a transfer -------------------------------------------------

#[test]
fn only_the_token_program_in_the_middle_of_a_transfer_reaches_the_hook() {
    let strict = StrictArgs { early_slots: 100, early_unlock_slots: 1_000, ..Default::default() };
    let (mut w, mut md) = launch(Launch { strict, ..Default::default() });
    let a = wallet(&mut w, 1_000 * SOL);
    let b = wallet(&mut w, 1_000 * SOL);
    let (pa, pb) = (a.pubkey(), b.pubkey());
    open(&mut w, &mut md, &a);
    open(&mut w, &mut md, &b);
    trade(&mut w, &mut md, &a, DIRECTION_BUY, SOL);
    // somebody calls execute directly with the real accounts of a transfer that is not
    // happening, hoping to zero a's record or to mark b's coins as early
    let stranger = w.env.user(SOL);
    let call = |source: Pubkey, destination: Pubkey, from: Pubkey, to: Pubkey| {
        let accounts = vec![
            AccountMeta::new_readonly(source, false),
            AccountMeta::new_readonly(w.k.base_mint, false),
            AccountMeta::new_readonly(destination, false),
            AccountMeta::new_readonly(stranger.pubkey(), true),
            AccountMeta::new_readonly(validation_of(&w.k), false),
            AccountMeta::new(cfg_of(&w.k), false),
            AccountMeta::new(holder_of(&w.k, &from), false),
            AccountMeta::new(holder_of(&w.k, &to), false),
        ];
        let mut data = TRANSFER_HOOK_EXECUTE_DISC.to_vec();
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        Instruction { program_id: pid(), accounts, data }
    };
    let direct = [
        call(coins_of(&w.k, &pa), coins_of(&w.k, &pb), pa, pb),
        call(w.k.base_vault, coins_of(&w.k, &pb), w.k.pool, pb),
        call(coins_of(&w.k, &pa), w.k.base_vault, pa, w.k.pool),
    ];
    for ix in direct {
        let failed = w.env.err(&[ix], &[&stranger], "only inside a transfer of this coin");
        assert!(failed.meta.logs.iter().any(|l| l.contains("Error Number: 6042")));
    }
    check(&w, &md);

    // the same call relayed through another hook, with the pool's signature for THAT
    // hook attached: the flag is still not set
    // (the relay hands the pool's caller address over as the second account, where
    // `execute` expects the coin)
    let victim = [
        AccountMeta::new_readonly(coins_of(&w.k, &pa), false),
        AccountMeta::new_readonly(coins_of(&w.k, &pb), false),
        AccountMeta::new_readonly(pa, false),
        AccountMeta::new_readonly(validation_of(&w.k), false),
        AccountMeta::new(cfg_of(&w.k), false),
        AccountMeta::new(holder_of(&w.k, &pa), false),
        AccountMeta::new(holder_of(&w.k, &pb), false),
    ];
    let mut data = TRANSFER_HOOK_EXECUTE_DISC.to_vec();
    data.extend_from_slice(&1_000u64.to_le_bytes());
    let (attacker, x, x_hook) = w.env.relay_pool(&pid(), &victim, data);
    let ix = w.env.swap_ix(&attacker.pubkey(), &x, &x_hook, DIRECTION_BUY, SOL / 10, 0);
    w.env.err(&[compute_budget_ix(400_000), ix], &[&attacker], "only inside a transfer of this coin");
    // the pool's callbacks are refused when anybody but the pool calls them, as on every
    // rules coin, also the one that leaves the buy mark
    let fake = w.env.user(SOL);
    let before_swap = Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::Callback { pool: w.k.pool, hook_caller: fake.pubkey(), user: pa, quote_mint: w.k.quote_mint, base_mint: w.k.base_mint, cfg: cfg_of(&w.k) }
            .to_account_metas(None),
        data: hook_rules::instruction::BeforeSwap { payload: SwapPayload { direction: DIRECTION_BUY, amount_in: 1, slot: START_SLOT, lp_fee_bps: LP_FEE, ..Default::default() } }.data(),
    };
    w.env.err(&[before_swap], &[&fake], "not the pool program's caller PDA");
    check(&w, &md);
}

#[test]
fn the_runtime_refuses_a_program_that_is_entered_again_while_it_runs() {
    // Why a strict coin has no burn rate and no lock vault. `run_burn` would be
    // hook_rules -> pool -> token program -> hook_rules (the coin's transfer hook), and a
    // vault would be hook_rules -> token program -> hook_rules. The runtime allows a
    // program to call itself directly and nothing else of the kind. The rule is shown
    // here on the pool program, with the test hook that passes a call on: pool -> hook ->
    // pool is refused before the inner call reads a single account.
    let mut env = Env::new();
    // (the test hook passes at least four accounts on; which ones does not matter here)
    let passed_on: Vec<AccountMeta> = [TOKEN, TOKEN_2022, ATA_PROGRAM, env.platform].iter().map(|k| AccountMeta::new_readonly(*k, false)).collect();
    let (attacker, x, x_hook) = env.relay_pool(&hookpool::ID, &passed_on, vec![0u8; 8]);
    let ix = env.swap_ix(&attacker.pubkey(), &x, &x_hook, DIRECTION_BUY, SOL / 10, 0);
    env.err(&[compute_budget_ix(400_000), ix], &[&attacker], "ReentrancyNotAllowed");
    // and on a strict coin the two instructions that would do it say no first
    let (mut w, _md) = launch(Launch { dev_buy: SOL, ..Default::default() });
    let dev = w.dev.insecure_clone();
    let r = RulesKeys::of(&w.k);
    let run_burn = Instruction {
        program_id: pid(),
        accounts: hook_rules::accounts::RunBurn {
            payer: dev.pubkey(),
            cfg: r.cfg,
            hook_authority: r.authority,
            platform: w.env.platform,
            pool: w.k.pool,
            base_mint: w.k.base_mint,
            quote_mint: w.k.quote_mint,
            base_vault: w.k.base_vault,
            quote_vault: w.k.quote_vault,
            treasury_quote: r.treasury,
            authority_base: coins_of(&w.k, &dev.pubkey()),
            hookpool_program: hookpool::ID,
            hookpool_event_authority: event_authority_address(&hookpool::ID),
            base_token_program: TOKEN_2022,
            quote_token_program: TOKEN,
            event_authority: event_authority_address(&pid()),
            program: pid(),
        }
        .to_account_metas(None),
        data: hook_rules::instruction::RunBurn { min_amount_out: 0 }.data(),
    };
    // (the burn account of a strict coin does not exist, so the call cannot even be
    // built with real accounts: it fails on its accounts or on the kind of the coin)
    assert!(w.env.send(&[compute_budget_ix(400_000), run_burn], &[&dev]).is_err());
    assert_eq!(cfg(&w).burn_pot, 0);
}

// ---- 7. the just-in-time holder, measured ----------------------------------------------------

/// A wallet opens a record and buys `size`. Somebody else then buys `volume` and sells
/// those coins again, so the price ends where it was. The wallet sells and claims.
/// Returns (what the wallet's quote changed by, of which rewards claimed).
fn just_in_time(registered: u64, size: u64, volume: u64) -> (i128, u64) {
    let args = RulesArgs { buy: rates(50, 100), sell: rates(50, 100), ..Default::default() };
    let (mut w, mut md) = launch(Launch { args, dev_record: false, ..Default::default() });
    // the holders that were there before: they bought for `registered` and have a record
    let old = wallet(&mut w, 10_000 * SOL);
    open(&mut w, &mut md, &old);
    if registered > 0 {
        trade(&mut w, &mut md, &old, DIRECTION_BUY, registered);
    }
    let whale = wallet(&mut w, 10_000 * SOL);
    let jit = wallet(&mut w, 10_000 * SOL);
    let start = quote_bal(&w, &jit.pubkey());
    open(&mut w, &mut md, &jit);
    let q = trade(&mut w, &mut md, &jit, DIRECTION_BUY, size);
    let bought = trade(&mut w, &mut md, &whale, DIRECTION_BUY, volume).amount_out;
    trade(&mut w, &mut md, &whale, DIRECTION_SELL, bought);
    trade(&mut w, &mut md, &jit, DIRECTION_SELL, q.amount_out);
    let claimed = try_claim(&mut w, &mut md, &jit).unwrap_or(0);
    (quote_bal(&w, &jit.pubkey()) as i128 - start as i128, claimed)
}

#[test]
fn a_wallet_that_buys_just_before_a_large_trade_is_measured() {
    // What the holders' share gives a wallet that buys right before somebody's large
    // trades and sells right after. There is no unstake delay on a strict coin. The
    // somebody buys and sells back, so that the price ends where it started and what is
    // left is the share against the wallet's own two trades. Pool of 100 SOL, pool fee
    // 0.3%, creator 0.5% and holders 1% on each side.
    println!("coins registered before (bought for) | the wallet buys for | somebody trades | the wallet ends | of which rewards");
    let mut results = vec![];
    for (registered, size, volume) in [(20 * SOL, 2 * SOL, 20 * SOL), (5 * SOL, 2 * SOL, 20 * SOL), (SOL, 2 * SOL, 20 * SOL), (SOL, SOL / 2, 5 * SOL), (0, SOL, 20 * SOL), (20 * SOL, 20 * SOL, 50 * SOL)] {
        let (change, claimed) = just_in_time(registered, size, volume);
        println!("{registered:>12} | {size:>11} | {volume:>12} there and back | {change:+} lamports | {claimed}");
        results.push((registered, change));
    }
    // with a fifth of the pool's worth of coins registered the wallet loses its round
    // trip; with a hundredth it comes out ahead
    assert!(results[0].1 < 0, "{results:?}");
    assert!(results[2].1 > 0 && results[4].1 > 0, "{results:?}: say so in RULES.md when this stops paying");
}

// ---- 8. the random walk ------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
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
}

#[derive(Default, Debug)]
struct Tally {
    buys: u32,
    buys_capped: u32,
    buys_without_record: u32,
    early_buys: u32,
    sells: u32,
    sells_locked: u32,
    sends: u32,
    sends_capped: u32,
    sends_locked: u32,
    opens: u32,
    claims: u32,
    creator_claims: u32,
    burns: u32,
    syncs: u32,
    closes: u32,
    closes_refused: u32,
    locks: u32,
    locks_refused: u32,
    unlocks: u32,
    liquidity_added: u32,
    liquidity_refused: u32,
    liquidity_removed: u32,
    fees_collected: u32,
    runs_bought: u32,
    runs_observed: u32,
    runs_waited: u32,
    runs_too_soon: u32,
    runs_empty: u32,
    idle: u32,
}

fn random_walk(seed: u64, steps: u32) -> Tally {
    // every rule on: sniper fee, buy limit, creator fee, holders' share, max wallet,
    // early lock, a creator lock
    let args = RulesArgs { sniper_slots: 300, sniper_start_fee_bps: 2_000, buy: rates3(100, 150, 50), sell: rates3(50, 200, 100), max_buy_quote: 4 * SOL, limit_slots: 200, creator_lock_seconds: 0 };
    let strict = StrictArgs { max_wallet_bps: 300, max_wallet_slots: 4_000, early_slots: 600, early_unlock_slots: 6_000 };
    println!("strict random walk: seed {seed}, {steps} steps, {args:?}, {strict:?}");
    let (mut w, mut md) = launch(Launch { args, strict, dev_buy: SOL, ..Default::default() });
    let mut rng = Rng(seed);
    let dev = w.dev.insecure_clone();
    let mut wallets: Vec<Keypair> = (0..5).map(|_| wallet(&mut w, 5_000 * SOL)).collect();
    wallets.push(dev.insecure_clone());
    let anyone = w.env.user(10 * SOL);
    let mut tally = Tally::default();
    let (mut slot, mut time) = (START_SLOT, START_TIME);
    // records opened up front for three of them, so that early buys happen
    for u in wallets.iter().take(3).map(|k| k.insecure_clone()).collect::<Vec<_>>() {
        open(&mut w, &mut md, &u);
    }

    for step in 0..steps {
        let dt = if step < 150 { rng.below(8) } else { rng.below(120) };
        slot += dt;
        time += dt as i64 / 2;
        w.env.set_clock(slot, time);
        let who = wallets[rng.below(wallets.len() as u64) as usize].insecure_clone();
        let u = who.pubkey();
        let coins = bal(&w, &u);
        let roll = rng.below(100);
        match roll {
            0..=27 => {
                let amount = rng.range(1_000, 5 * SOL);
                let early = md.early_window_runs(slot);
                match try_trade(&mut w, &mut md, &who, DIRECTION_BUY, amount) {
                    Ok(_) => {
                        tally.buys += 1;
                        tally.early_buys += early as u32;
                    }
                    Err("above the max wallet") => tally.buys_capped += 1,
                    Err("needs the wallet's holder record") => tally.buys_without_record += 1,
                    Err(_) => tally.idle += 1,
                }
            }
            28..=47 if coins > 0 => {
                let amount = if rng.below(3) == 0 { coins } else { rng.range(1, coins) };
                match try_trade(&mut w, &mut md, &who, DIRECTION_SELL, amount) {
                    Ok(_) => tally.sells += 1,
                    Err("coins bought early are locked until the unlock") | Err("the creator's locked coins cannot move before the unlock time") => tally.sells_locked += 1,
                    Err(_) => tally.idle += 1,
                }
            }
            48..=62 if coins > 0 => {
                let to = wallets[rng.below(wallets.len() as u64) as usize].pubkey();
                if to == u {
                    tally.idle += 1;
                } else {
                    let amount = if rng.below(4) == 0 { coins } else { rng.range(1, coins) };
                    match try_send(&mut w, &mut md, &who, &to, amount) {
                        Ok(()) => tally.sends += 1,
                        Err("above the max wallet") => tally.sends_capped += 1,
                        Err(_) => tally.sends_locked += 1,
                    }
                }
            }
            63..=68 => {
                if !md.holders.contains_key(&u) {
                    tally.opens += 1;
                }
                w.env.svm.expire_blockhash();
                open(&mut w, &mut md, &who);
            }
            69..=76 => {
                if try_claim(&mut w, &mut md, &who).is_ok() {
                    tally.claims += 1;
                }
            }
            77..=79 => {
                if try_claim_creator(&mut w, &mut md).is_ok() {
                    tally.creator_claims += 1;
                }
            }
            80..=82 if coins > 1 && u != dev.pubkey() => {
                // a burn, and sometimes the sync right after it
                burn(&mut w, &md, &who, rng.range(1, coins / 2));
                tally.burns += 1;
                if md.holders.contains_key(&u) && rng.below(2) == 0 {
                    w.env.svm.expire_blockhash();
                    sync(&mut w, &mut md, &anyone, &u);
                    tally.syncs += 1;
                }
            }
            83..=85 => match try_close(&mut w, &mut md, &who) {
                Ok(()) => tally.closes += 1,
                Err(_) => tally.closes_refused += 1,
            },
            86..=88 => {
                // the creator locks some more, or moves the date
                let held = bal(&w, &dev.pubkey());
                let amount = if rng.below(3) == 0 { u64::MAX } else { rng.below(held / 4 + 2) };
                let until = time + rng.range(1, 3_000) as i64;
                w.env.svm.expire_blockhash();
                match try_lock(&mut w, &mut md, amount, until) {
                    Ok(_) => tally.locks += 1,
                    Err(_) => tally.locks_refused += 1,
                }
            }
            89..=90 => {
                w.env.svm.expire_blockhash();
                if try_unlock(&mut w, &mut md).is_ok() {
                    tally.unlocks += 1;
                }
            }
            91..=95 => {
                let lp_held = w.env.balance(&ata(&u, &w.k.lp_mint));
                if lp_held >= 100_000 && rng.below(2) == 0 {
                    let lp = if rng.below(2) == 0 { lp_held } else { rng.range(100_000, lp_held) };
                    remove_liquidity(&mut w, &mut md, &who, lp);
                    tally.liquidity_removed += 1;
                } else {
                    let pool = w.env.pool(&w.k.pool);
                    let supply = w.env.mint_supply(&w.k.lp_mint);
                    let most = (coins as u128 * supply as u128 / pool.reserve_base as u128).min(supply as u128 / 20) as u64;
                    if most >= 100_000 {
                        match try_add_liquidity(&mut w, &mut md, &who, rng.range(100_000, most)) {
                            Ok(()) => tally.liquidity_added += 1,
                            Err(_) => tally.liquidity_refused += 1,
                        }
                    } else {
                        tally.idle += 1;
                    }
                }
            }
            96 => {
                // the protocol's fees in the coin go to the platform's wallet
                let fees = w.env.pool(&w.k.pool).protocol_fees_base;
                if fees > 0 {
                    let treasury = w.env.treasury.pubkey();
                    let mut ix = w.env.collect_ix(&anyone.pubkey(), &w.k);
                    ix.accounts.extend(hook_metas(&w.k, &w.k.pool, &treasury));
                    ix.accounts.push(AccountMeta::new_readonly(pid(), false));
                    let before = bal(&w, &treasury);
                    must(md.moved(None, Some((treasury, before + fees)), fees, false, true, slot, time));
                    w.env.svm.expire_blockhash();
                    w.env.ok(&[compute_budget_ix(400_000), ix], &[&anyone]);
                    tally.fees_collected += 1;
                } else {
                    tally.idle += 1;
                }
            }
            97..=99 => {
                w.env.svm.expire_blockhash();
                match try_run_burn(&mut w, &mut md, &anyone) {
                    Ok(Ran::Bought { .. }) => tally.runs_bought += 1,
                    Ok(ran) => {
                        if ran == Ran::Observed {
                            tally.runs_observed += 1
                        } else {
                            tally.runs_waited += 1
                        }
                        // whoever runs the burn comes back 25 slots later; nobody traded
                        // in between, so that call buys
                        slot += BURN_INTERVAL_SLOTS;
                        w.env.set_clock(slot, time);
                        match try_run_burn(&mut w, &mut md, &anyone) {
                            Ok(Ran::Bought { .. }) => tally.runs_bought += 1,
                            Ok(other) => panic!("the price stood still for 25 slots and the burn did not buy: {other:?}"),
                            Err(_) => tally.idle += 1,
                        }
                    }
                    Err("the burn pot is empty") => tally.runs_empty += 1,
                    Err("observation of the pool is less than 25 slots old") => tally.runs_too_soon += 1,
                    Err(_) => tally.idle += 1,
                }
            }
            _ => tally.idle += 1,
        }
        // after EVERY step, also the ones that were refused or only moved the clock
        check(&w, &md);
    }

    // wind down: after every window everybody can sell everything, and everything owed is paid
    w.env.set_clock(slot + 10_000, time + 10_000);
    let _ = try_unlock(&mut w, &mut md);
    for who in &wallets {
        let u = who.pubkey();
        let lp = w.env.balance(&ata(&u, &w.k.lp_mint));
        if lp > 0 {
            remove_liquidity(&mut w, &mut md, who, lp);
        }
        let coins = bal(&w, &u);
        if coins > 0 {
            must(try_trade(&mut w, &mut md, who, DIRECTION_SELL, coins));
        }
    }
    for who in &wallets {
        if md.holders.contains_key(&who.pubkey()) {
            // a record that a burn left too high is put right first
            w.env.svm.expire_blockhash();
            sync(&mut w, &mut md, &anyone, &who.pubkey());
            let _ = try_claim(&mut w, &mut md, who);
        }
    }
    let _ = try_claim_creator(&mut w, &mut md);
    // and the pot is burned, a slice at a time
    let mut guard = 0;
    while md.burn_pot > 0 {
        let pool = w.env.pool(&w.k.pool);
        if md.burn_plan((pool.reserve_base, pool.reserve_quote), w.env.clock().slot) == Plan::TooSoon {
            let slot = md.obs.0 + BURN_INTERVAL_SLOTS;
            go(&mut w, slot);
        }
        w.env.svm.expire_blockhash();
        if try_run_burn(&mut w, &mut md, &anyone).is_err() {
            break;
        }
        guard += 1;
        assert!(guard < 10_000);
    }
    let c = cfg(&w);
    println!("{tally:?}");
    println!(
        "hook fees {} = creator {} + holders {} + burn {}; paid: creator {}, rewards {}, burned {} for {} coins in {} runs",
        fees_total(&w),
        md.to_creator,
        md.to_holders,
        md.to_burn,
        c.total_creator_paid,
        c.total_rewards_paid,
        c.total_quote_burned,
        c.total_base_burned,
        c.burns
    );
    assert!(tally.runs_bought > 0 && c.total_base_burned > 0, "{tally:?}");
    assert!(c.total_rewards_paid <= md.to_holders);
    assert!(tally.buys > 0 && tally.sells > 0 && tally.sends > 0 && tally.claims > 0 && tally.early_buys > 0, "{tally:?}");
    tally
}

fn walk_seed(default: u64) -> u64 {
    std::env::var("STRICT_WALK_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}
fn walk_steps(default: u32) -> u32 {
    std::env::var("STRICT_WALK_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

/// Replay with `STRICT_WALK_SEED=<seed> bash build.sh test -p hookpool-tests --test strict
/// random_walk`. `STRICT_WALK_STEPS` makes it longer.
#[test]
fn a_random_walk_over_a_strict_coin_keeps_every_number_and_every_unit_accounted_for() {
    // seed 7 reaches every branch the checks below ask for, a send above the max wallet
    // included; most seeds miss that one, which is rare by nature
    let tally = random_walk(walk_seed(7), walk_steps(1_200));
    if std::env::var("STRICT_WALK_SEED").is_err() {
        assert!(tally.buys_capped > 0 && tally.sends_capped > 0 && tally.sells_locked > 0 && tally.sends_locked > 0, "{tally:?}");
        assert!(tally.liquidity_added > 0 && tally.liquidity_refused > 0 && tally.liquidity_removed > 0, "{tally:?}");
        assert!(tally.burns > 0 && tally.syncs > 0 && tally.locks > 0 && tally.opens > 0, "{tally:?}");
    }
}

// ---- 9. costs -------------------------------------------------------------------------------------

#[test]
fn compute_units_and_sizes_of_a_strict_coin() {
    let strict = StrictArgs { max_wallet_bps: 500, max_wallet_slots: 1_000, early_slots: 100, early_unlock_slots: 1_000 };
    let (mut w, mut md) = launch(Launch { strict, ..Default::default() });
    let a = wallet(&mut w, 1_000 * SOL);
    let b = wallet(&mut w, 1_000 * SOL);
    let (pa, pb) = (a.pubkey(), b.pubkey());
    open(&mut w, &mut md, &a);
    let table = lookup_table(&w.env, &w.k);
    let mut worst = 0u64;
    let mut measure = |w: &mut World, md: &mut Model, label: &str, who: &Keypair, direction: u8, amount: u64| {
        let u = who.pubkey();
        let pool = w.env.pool(&w.k.pool);
        let (slot, now) = (w.env.clock().slot, w.env.clock().unix_timestamp);
        let held = bal(w, &u);
        let q = must(md.swap((pool.reserve_base, pool.reserve_quote), pool.hook_fees_quote_total, direction, amount, slot));
        if direction == DIRECTION_BUY {
            must(md.moved(None, Some((u, held + q.amount_out)), q.amount_out, true, true, slot, now));
        } else {
            must(md.moved(Some((u, held - amount)), None, amount, false, true, slot, now));
        }
        let ix = w.env.swap_ix(&u, &w.k, &hook_for(&w.k, &u), direction, amount, q.amount_out);
        let (legacy, v0) = (w.env.tx_size(std::slice::from_ref(&ix), &u, 1), tx_size_v0(std::slice::from_ref(&ix), &u, 1, &table));
        let meta = w.env.ok(&[ix], &[who]);
        println!("{label}: {} CU (the hook's two calls {:?}); {legacy} bytes legacy, {v0} with the lookup table", meta.compute_units_consumed, hook_units(&meta));
        worst = worst.max(meta.compute_units_consumed);
        check(w, md);
    };
    measure(&mut w, &mut md, "buy, early window, max wallet, with a holder record", &a, DIRECTION_BUY, SOL);
    go(&mut w, START_SLOT + 100);
    measure(&mut w, &mut md, "buy, after the early window, max wallet, no holder record", &b, DIRECTION_BUY, SOL);
    measure(&mut w, &mut md, "sell, no holder record", &b, DIRECTION_SELL, 1_000_000);
    go(&mut w, START_SLOT + 1_000);
    measure(&mut w, &mut md, "buy, after every window, with a holder record", &a, DIRECTION_BUY, SOL);
    measure(&mut w, &mut md, "sell, after every window, with a holder record", &a, DIRECTION_SELL, 1_000_000);
    println!("worst swap on a strict coin: {worst} CU");
    assert!(worst < 200_000, "a swap on a strict coin fits the default budget: {worst}");

    // a plain send between two wallets
    for (label, from, to) in [("send, both wallets without a record", &b, Keypair::new().pubkey()), ("send, from a wallet with a record to one without", &a, pb), ("send, to a wallet with a record", &b, pa)] {
        let f = from.pubkey();
        if w.env.svm.get_account(&coins_of(&w.k, &to)).is_none() {
            w.env.ok(&[Env::create_ata_with_ix(&f, &to, &w.k.base_mint, &TOKEN_2022)], &[from]);
            w.known.push(to);
        }
        let (fb, tb) = (bal(&w, &f), bal(&w, &to));
        must(md.moved(Some((f, fb - 1_000)), Some((to, tb + 1_000)), 1_000, false, true, START_SLOT + 1_000, START_TIME));
        let ix = transfer_ix(&w.k, &f, &to, 1_000);
        let size = w.env.tx_size(std::slice::from_ref(&ix), &f, 1);
        let meta = w.env.ok(&[ix], &[from]);
        println!("{label}: {} CU, of which the hook {:?}; {size} bytes legacy", meta.compute_units_consumed, hook_units(&meta));
        assert!(meta.compute_units_consumed < 60_000);
        check(&w, &md);
    }
    // the other instructions
    let meta = w.env.ok(&[open_holder_ix(&w.k, &pb)], &[&b]);
    md.open(&pb, bal(&w, &pb), fees_total(&w));
    println!("open_holder: {} CU", meta.compute_units_consumed);
    trade(&mut w, &mut md, &a, DIRECTION_BUY, SOL);
    trade(&mut w, &mut md, &a, DIRECTION_SELL, 1_000_000);
    let amount = must(md.claim(&pb, fees_total(&w)));
    let meta = w.env.ok(&[claim_holder_ix(&w.k, &pb, &ata(&pb, &w.k.quote_mint))], &[&b]);
    println!("claim_holder ({amount} lamports): {} CU", meta.compute_units_consumed);
    md.sync(&pb, bal(&w, &pb), fees_total(&w));
    let meta = w.env.ok(&[sync_holder_ix(&w.k, &pb)], &[&a]);
    println!("sync_holder: {} CU", meta.compute_units_consumed);
    check(&w, &md);
    let dev = w.dev.insecure_clone();
    trade(&mut w, &mut md, &dev, DIRECTION_BUY, SOL);
    let held = bal(&w, &dev.pubkey());
    must(md.lock_creator(&dev.pubkey(), u64::MAX, START_TIME + DAY, held, w.env.clock().unix_timestamp));
    let meta = w.env.ok(&[lock_ix(&w.k, &dev.pubkey(), u64::MAX, START_TIME + DAY)], &[&dev]);
    println!("lock_creator_strict (opens the lock record): {} CU", meta.compute_units_consumed);
    check(&w, &md);
    // liquidity on a strict coin
    must(try_add_liquidity(&mut w, &mut md, &a, 1_000_000));
    let ix = w.env.add_liquidity_ix(&pa, &w.k, &hook_for(&w.k, &pa), 1_000_000, u64::MAX, u64::MAX);
    let pool = w.env.pool(&w.k.pool);
    let coins = (1_000_000u128 * pool.reserve_base as u128).div_ceil(w.env.mint_supply(&w.k.lp_mint) as u128) as u64;
    must(md.moved(Some((pa, bal(&w, &pa) - coins)), None, coins, false, true, START_SLOT + 1_000, START_TIME));
    let size = w.env.tx_size(std::slice::from_ref(&ix), &pa, 1);
    w.env.svm.expire_blockhash();
    let meta = w.env.ok(&[ix], &[&a]);
    println!("add_liquidity on a strict coin: {} CU, {size} bytes legacy", meta.compute_units_consumed);
    check(&w, &md);
}

// ---- 9. the burn of a strict coin ---------------------------------------------------------

/// All the coins a wallet holds into the pool as liquidity, with the quote that goes with
/// them. Returns the liquidity tokens.
fn add_all(w: &mut World, md: &mut Model, who: &Keypair) -> u64 {
    let pool = w.env.pool(&w.k.pool);
    let supply = w.env.mint_supply(&w.k.lp_mint);
    let lp = (bal(w, &who.pubkey()) as u128 * supply as u128 / pool.reserve_base as u128) as u64;
    must(try_add_liquidity(w, md, who, lp));
    lp
}

fn remove_all(w: &mut World, md: &mut Model, who: &Keypair) {
    let lp = w.env.balance(&ata(&who.pubkey(), &w.k.lp_mint));
    remove_liquidity(w, md, who, lp);
}

#[test]
fn the_burn_of_a_strict_coin_goes_through_every_step_of_the_observation_rule() {
    let args = RulesArgs { buy: rates3(100, 100, 100), sell: rates3(100, 100, 200), ..Default::default() };
    let (mut w, mut md) = launch(Launch { args, ..Default::default() });
    let t = wallet(&mut w, 1_000 * SOL);
    open(&mut w, &mut md, &t);
    let anyone = w.env.user(SOL);
    let too_soon = "observation of the pool is less than 25 slots old";
    let pot_now = |w: &World, md: &Model| {
        let mut m = md.clone();
        m.settle(fees_total(w));
        m.burn_pot
    };
    // nothing to burn yet
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err("the burn pot is empty"));
    trade(&mut w, &mut md, &t, DIRECTION_BUY, 10 * SOL);
    let half = bal(&w, &t.pubkey()) / 2;
    trade(&mut w, &mut md, &t, DIRECTION_SELL, half);
    assert!(pot_now(&w, &md) > SOL / 10);
    let cap = md.burn_cap_bps();
    assert_eq!(cap, 50, "0.5% of the pool per run, the platform's ceiling");
    let mut units = vec![];

    // 1. the first call only looks at the pool
    let slot0 = w.env.clock().slot;
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Ok(Ran::Observed));
    assert_eq!(md.obs.0, slot0);
    units.push(("observed (the first call)", w.last_run));
    // 2. until that look is 25 slots old, every call is refused
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err(too_soon));
    go(&mut w, slot0 + BURN_INTERVAL_SLOTS - 1);
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err(too_soon));
    // 3. 25 slots later, at the price it saw: it buys a slice of the pool, at most the pot,
    // and the coins are burned in the pool's vault
    go(&mut w, slot0 + BURN_INTERVAL_SLOTS);
    let pool = w.env.pool(&w.k.pool);
    let pot = pot_now(&w, &md);
    let Ok(Ran::Bought { spent, burned, .. }) = try_run_burn(&mut w, &mut md, &anyone) else { panic!("the price stood still: the run buys") };
    assert_eq!(spent, pot.min(pool.reserve_quote * cap / 10_000));
    assert!(burned > 0);
    units.push(("bought", w.last_run));
    // 4. a buy that takes the price more than the tolerance above the last look: the next
    // run buys nothing and looks again
    go(&mut w, md.obs.0 + BURN_INTERVAL_SLOTS);
    trade(&mut w, &mut md, &t, DIRECTION_BUY, 5 * SOL);
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Ok(Ran::Waited));
    units.push(("waited", w.last_run));
    // 5. 25 slots later, nobody traded: it buys at the new price
    go(&mut w, md.obs.0 + BURN_INTERVAL_SLOTS);
    assert!(matches!(try_run_burn(&mut w, &mut md, &anyone), Ok(Ran::Bought { .. })));
    // 6. a sell that starts below the observed price lowers it, keeps its depth and its age
    let obs = md.obs;
    go(&mut w, obs.0 + 10);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000_000);
    assert_eq!(md.obs, obs, "the first sell starts at the observed price: nothing to lower");
    let p = w.env.pool(&w.k.pool);
    trade(&mut w, &mut md, &t, DIRECTION_SELL, 1_000_000_000);
    assert_eq!(md.obs, (obs.0, p.reserve_base, p.reserve_quote), "the second starts below it: the pool as that sell found it, with the old slot");
    assert!(md.obs.2 < obs.2, "never a deeper pool than the one observed");
    go(&mut w, obs.0 + BURN_INTERVAL_SLOTS);
    // 7. the caller's own minimum holds: a run that would burn less fails and changes nothing
    let pool = w.env.pool(&w.k.pool);
    let Ok(Ran::Bought { burned, .. }) = md.clone().run_burn((pool.reserve_base, pool.reserve_quote), pool.hook_fees_quote_total, obs.0 + BURN_INTERVAL_SLOTS) else { panic!() };
    w.env.err(&[run_burn_ix(&w.env, &w.k, &anyone.pubkey(), burned + 1)], &[&anyone], "Slippage");
    check(&w, &md);
    assert!(matches!(try_run_burn(&mut w, &mut md, &anyone), Ok(Ran::Bought { .. })));
    // 8. run after run, 25 slots apart, the pot is burned to the last lamport
    while pot_now(&w, &md) > 0 {
        burn_next(&mut w, &mut md, &anyone);
    }
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Err("the burn pot is empty"));
    assert_eq!(w.env.mint_supply(&w.k.base_mint), SUPPLY - md.base_burned, "the supply fell by what the runs bought");
    for (label, (cu, size)) in units {
        println!("run_burn_strict, {label}: {cu} CU, {size} bytes legacy");
        assert!(cu < 200_000 && size <= 1_232);
    }
}

#[test]
fn the_attacks_on_the_burn_of_a_plain_coin_fail_on_a_strict_coin() {
    // Each attack runs as consecutive transactions in one slot. The observation rule
    // looks at slots, never at transactions, so one transaction would end the same way.
    let args = RulesArgs { buy: rates3(100, 100, 100), sell: rates3(100, 100, 200), ..Default::default() };
    let strict = StrictArgs { max_wallet_bps: 300, max_wallet_slots: 2_000, early_slots: 300, early_unlock_slots: 3_000 };
    // the creator keeps half the supply: the wallet with the most coins
    let (mut w, mut md) = launch(Launch { args, strict, base_amount: SUPPLY / 2, ..Default::default() });
    let attacker = wallet(&mut w, 5_000 * SOL);
    open(&mut w, &mut md, &attacker);
    let anyone = w.env.user(SOL);

    // 1. the early window: coins bought in it cannot leave the wallet, so a buy before a
    // run cannot be sold after it
    trade(&mut w, &mut md, &attacker, DIRECTION_BUY, SOL);
    assert_eq!(try_trade(&mut w, &mut md, &attacker, DIRECTION_SELL, 1_000_000).map(|_| ()), Err("coins bought early are locked until the unlock"));
    // 2. the max wallet window: no buy above the max wallet, and no liquidity comes in
    go(&mut w, START_SLOT + 300);
    assert_eq!(try_trade(&mut w, &mut md, &attacker, DIRECTION_BUY, 400 * SOL).map(|_| ()), Err("above the max wallet"));
    assert_eq!(try_add_liquidity(&mut w, &mut md, &attacker, 1_000_000), Err("liquidity cannot be added while the max wallet runs"));

    // 3. after the windows. Honest round trips fill the pot, and a run looks at the pool.
    go(&mut w, START_SLOT + 3_100);
    let honest = wallet(&mut w, 5_000 * SOL);
    for _ in 0..6 {
        let q = trade(&mut w, &mut md, &honest, DIRECTION_BUY, 50 * SOL);
        trade(&mut w, &mut md, &honest, DIRECTION_SELL, q.amount_out);
    }
    assert_eq!(try_run_burn(&mut w, &mut md, &anyone), Ok(Ran::Observed));
    let cap = md.burn_cap_bps();
    // a wallet that holds nothing yet, so that its quote is the whole measure
    let attacker = wallet(&mut w, 5_000 * SOL);
    let a = attacker.pubkey();
    // the five steps of the plain coin's attack: BUY, every coin bought in as liquidity,
    // the run, the liquidity out, SELL what was bought
    let attack = |w: &mut World, md: &mut Model, size: u64| -> (i128, Ran) {
        let (quote0, coins0) = (quote_bal(w, &a), bal(w, &a));
        trade(w, md, &attacker, DIRECTION_BUY, size);
        add_all(w, md, &attacker);
        let ran = must(try_run_burn(w, md, &anyone));
        remove_all(w, md, &attacker);
        let extra = bal(w, &a).saturating_sub(coins0);
        trade(w, md, &attacker, DIRECTION_SELL, extra);
        (quote_bal(w, &a) as i128 - quote0 as i128, ran)
    };
    go(&mut w, md.obs.0 + BURN_INTERVAL_SLOTS);
    let (first, ran) = attack(&mut w, &mut md, 400 * SOL);
    println!("BUY 400 SOL, add_liquidity, run_burn_strict, remove_liquidity, SELL: the run {ran:?}, the wallet changed by {first} lamports");
    assert_eq!(ran, Ran::Waited, "the run buys nothing at a price that is not the observed one");
    assert!(first < -9 * SOL as i128, "{first}");
    // that run recorded the pumped pool; the next pump starts below it and lowers it
    go(&mut w, md.obs.0 + BURN_INTERVAL_SLOTS);
    let (second, ran) = attack(&mut w, &mut md, 400 * SOL);
    println!("the same 25 slots later: the run {ran:?}, the wallet changed by {second} lamports");
    assert_eq!(ran, Ran::Waited);
    assert!(second < -9 * SOL as i128, "{second}");
    assert_eq!(md.burns, 0, "nothing was ever bought at a pumped price");

    // 4. inside the tolerance the run buys a slice of the pool as it was before the buy,
    // and the sequence loses
    go(&mut w, md.obs.0 + BURN_INTERVAL_SLOTS);
    let before = w.env.pool(&w.k.pool);
    let slice = before.reserve_quote.min(md.obs.2) * cap / 10_000;
    let (third, ran) = attack(&mut w, &mut md, SOL / 10);
    let Ran::Bought { spent, .. } = ran else { panic!("a buy of 0.1 SOL is inside the tolerance") };
    println!("BUY 0.1 SOL, add_liquidity, run_burn_strict (bought for {spent}), remove_liquidity, SELL: the wallet changed by {third} lamports");
    assert_eq!(spent, slice, "a slice of the pool it observed, not of the deepened one");
    assert!(third < 0, "{third}");

    // 5. liquidity and a nudge of the price. The creator holds half the supply: it nearly
    // doubles the pool, sells a little twice (the second sell lowers the observation), runs
    // the burn and leaves. The run spends one slice of the pool it observed.
    go(&mut w, md.obs.0 + BURN_INTERVAL_SLOTS);
    burn_next(&mut w, &mut md, &anyone);
    let observed = w.env.pool(&w.k.pool);
    assert_eq!((md.obs.1, md.obs.2), (observed.reserve_base, observed.reserve_quote), "the run looked at the pool as it is");
    go(&mut w, md.obs.0 + BURN_INTERVAL_SLOTS);
    let dev = w.dev.insecure_clone();
    let supply = w.env.mint_supply(&w.k.lp_mint);
    let lp = (bal(&w, &dev.pubkey()) as u128 * supply as u128 / observed.reserve_base as u128).min(supply as u128) as u64;
    must(try_add_liquidity(&mut w, &mut md, &dev, lp));
    assert!(w.env.pool(&w.k.pool).reserve_quote > observed.reserve_quote * 18 / 10);
    trade(&mut w, &mut md, &dev, DIRECTION_SELL, 1_000_000);
    trade(&mut w, &mut md, &dev, DIRECTION_SELL, 1_000_000);
    assert_eq!(md.obs.2, observed.reserve_quote, "the lowering did not raise the observed depth");
    let Ran::Bought { spent, .. } = must(try_run_burn(&mut w, &mut md, &anyone)) else { panic!("the price is a hair below the observed one: the run buys") };
    remove_all(&mut w, &mut md, &dev);
    println!("add_liquidity (pool {:.2} times deeper), SELL, SELL, run_burn_strict, remove_liquidity: the run spent {spent}", 1.0 + lp as f64 / supply as f64);
    assert_eq!(spent, observed.reserve_quote * cap / 10_000, "one slice of the observed pool");
}

#[test]
fn after_the_windows_coins_that_are_not_locked_can_always_be_sold_and_sent() {
    // The answer to "can a wallet be stuck?", as RULES.md writes it. After the windows,
    // coins outside the creator's lock are held back by nothing the coin's rules do: what
    // can still make a sell fail is the platform's pause, the seller's own minimum, an
    // amount too small to buy one unit of quote, and a send fails only when the receiving
    // account is not the receiver's associated token account.
    let args = RulesArgs { buy: rates3(100, 100, 100), sell: rates3(100, 100, 100), ..Default::default() };
    let strict = StrictArgs { max_wallet_bps: 300, max_wallet_slots: 1_000, early_slots: 100, early_unlock_slots: 2_000 };
    let (mut w, mut md) = launch(Launch { args, strict, dev_buy: SOL, lock_until: Some(START_TIME + DAY), ..Default::default() });
    let dev = w.dev.insecure_clone();
    assert_eq!(w.env.mint_authority(&w.k.base_mint), None, "nobody can mint more");
    let mint = w.env.svm.get_account(&w.k.base_mint).unwrap();
    let state = t22::extension::StateWithExtensions::<t22::state::Mint>::unpack(&mint.data).unwrap();
    assert!(state.base.freeze_authority.is_none(), "nobody can freeze an account of the coin");

    // every kind of wallet: one that bought in the early window, one whose record is above
    // what it holds after a burn, one whose record was closed, one that never had one
    let early = wallet(&mut w, 100 * SOL);
    open(&mut w, &mut md, &early);
    trade(&mut w, &mut md, &early, DIRECTION_BUY, SOL);
    go(&mut w, START_SLOT + 100);
    let burner = wallet(&mut w, 100 * SOL);
    open(&mut w, &mut md, &burner);
    trade(&mut w, &mut md, &burner, DIRECTION_BUY, SOL);
    let third = bal(&w, &burner.pubkey()) / 3;
    burn(&mut w, &md, &burner, third);
    let closer = wallet(&mut w, 100 * SOL);
    open(&mut w, &mut md, &closer);
    must(try_close(&mut w, &mut md, &closer));
    let bare = wallet(&mut w, 100 * SOL);
    trade(&mut w, &mut md, &bare, DIRECTION_BUY, SOL);
    // inside the windows, the rules hold coins back
    assert_eq!(try_trade(&mut w, &mut md, &early, DIRECTION_SELL, 1_000_000).map(|_| ()), Err("coins bought early are locked until the unlock"));
    assert_eq!(try_send(&mut w, &mut md, &early, &bare.pubkey(), 1_000_000), Err("coins bought early are locked until the unlock"));
    // the creator's first buy was made in the early window too: the early lock is checked first
    assert_eq!(try_trade(&mut w, &mut md, &dev, DIRECTION_SELL, 1_000_000).map(|_| ()), Err("coins bought early are locked until the unlock"));
    // after the windows, the creator's lock alone holds its coins until its date
    w.env.set_clock(START_SLOT + 2_000, START_TIME + DAY - 1);
    assert_eq!(try_trade(&mut w, &mut md, &dev, DIRECTION_SELL, 1_000_000).map(|_| ()), Err("the creator's locked coins cannot move before the unlock time"));
    assert_eq!(try_send(&mut w, &mut md, &dev, &bare.pubkey(), 1_000_000), Err("the creator's locked coins cannot move before the unlock time"));

    // after the windows and the creator's date, every wallet sends to every kind of
    // receiver, and sells everything it holds
    w.env.set_clock(START_SLOT + 2_000, START_TIME + DAY + 1);
    let fresh = Keypair::new().pubkey();
    let receivers = [closer.pubkey(), early.pubkey(), burner.pubkey(), fresh];
    for who in [&early, &burner, &bare, &dev] {
        for to in receivers {
            if to != who.pubkey() {
                must(try_send(&mut w, &mut md, who, &to, 1_000_000));
            }
        }
    }
    // the platform's pause stops a sell, never a send
    w.env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(true), ..Default::default() });
    let u = bare.pubkey();
    let ix = w.env.swap_ix(&u, &w.k, &hook_for(&w.k, &u), DIRECTION_SELL, 1_000_000, 0);
    w.env.err(&[compute_budget_ix(400_000), ix], &[&bare], "Paused");
    must(try_send(&mut w, &mut md, &bare, &fresh, 1_000_000));
    w.env.update_platform(hookpool::UpdatePlatformArgs { paused: Some(false), ..Default::default() });
    // a send to an account that is not the receiver's associated account is refused
    let spare = Keypair::new();
    let space = t22::extension::ExtensionType::try_calculate_account_len::<t22::state::Account>(&[t22::extension::ExtensionType::TransferHookAccount]).unwrap();
    let make = [
        anchor_lang::solana_program::system_instruction::create_account(&u, &spare.pubkey(), w.env.svm.minimum_balance_for_rent_exemption(space), space as u64, &TOKEN_2022),
        t22::instruction::initialize_account3(&TOKEN_2022, &spare.pubkey(), &w.k.base_mint, &fresh).unwrap(),
    ];
    w.env.ok(&make, &[&bare, &spare]);
    let ix = transfer_between(&w.k, &coins_of(&w.k, &u), &u, &spare.pubkey(), &fresh, &u, 1);
    w.env.err(&[ix], &[&bare], "not the associated token account of its wallet");
    // and every one of them sells all it holds
    for who in [&early, &burner, &bare, &dev, &closer] {
        let held = bal(&w, &who.pubkey());
        trade(&mut w, &mut md, who, DIRECTION_SELL, held);
        assert_eq!(bal(&w, &who.pubkey()), 0);
    }
}

// ---- 10. two checks asked for by the review ------------------------------------------------

#[test]
fn the_creator_floor_holds_against_a_delegate_until_the_date() {
    let (mut w, mut md) = launch(Launch { dev_buy: SOL, ..Default::default() });
    let dev = w.dev.insecure_clone();
    let d = dev.pubkey();
    let held = bal(&w, &d);
    let locked = must(try_lock(&mut w, &mut md, held / 2, START_TIME + DAY));
    assert_eq!(locked, held / 2);
    // the creator lets a delegate spend everything in its account
    let delegate = w.env.user(SOL);
    let approve = t22::instruction::approve(&TOKEN_2022, &coins_of(&w.k, &d), &delegate.pubkey(), &d, &[], u64::MAX).unwrap();
    w.env.ok(&[approve], &[&dev]);
    let to = wallet(&mut w, SOL).pubkey();
    let send = |w: &World, amount: u64| transfer_between(&w.k, &coins_of(&w.k, &d), &d, &coins_of(&w.k, &to), &to, &delegate.pubkey(), amount);
    // below the floor: refused, nothing moves
    let free = held - locked;
    for amount in [free + 1, held] {
        w.env.err(&[send(&w, amount)], &[&delegate], "the creator's locked coins cannot move before the unlock time");
        assert_eq!((bal(&w, &d), bal(&w, &to)), (held, 0));
        check(&w, &md);
    }
    // down to the floor exactly: the coins above it are free
    let (slot, now) = (w.env.clock().slot, w.env.clock().unix_timestamp);
    must(md.moved(Some((d, held - free)), Some((to, free)), free, false, true, slot, now));
    w.env.ok(&[send(&w, free)], &[&delegate]);
    assert_eq!((bal(&w, &d), bal(&w, &to)), (locked, free));
    check(&w, &md);
    // one unit more, one second before the date: refused
    w.env.set_clock(slot, START_TIME + DAY - 1);
    w.env.err(&[send(&w, 1)], &[&delegate], "the creator's locked coins cannot move before the unlock time");
    assert_eq!(bal(&w, &d), locked);
    // from the date on, the delegate moves them
    w.env.set_clock(slot, START_TIME + DAY);
    must(md.moved(Some((d, 0)), Some((to, free + locked)), locked, false, true, slot, START_TIME + DAY));
    w.env.ok(&[send(&w, locked)], &[&delegate]);
    assert_eq!((bal(&w, &d), bal(&w, &to)), (0, held));
    check(&w, &md);
}

#[test]
fn a_record_closed_and_opened_again_earns_nothing_of_the_time_between() {
    let (mut w, mut md) = launch(Launch::default());
    let h = wallet(&mut w, 1_000 * SOL);
    let other = wallet(&mut w, 1_000 * SOL);
    let t = wallet(&mut w, 1_000 * SOL);
    let hp = h.pubkey();
    open(&mut w, &mut md, &h);
    open(&mut w, &mut md, &other);
    trade(&mut w, &mut md, &h, DIRECTION_BUY, 5 * SOL);
    trade(&mut w, &mut md, &other, DIRECTION_BUY, 5 * SOL);
    let round_trip = |w: &mut World, md: &mut Model| {
        let q = trade(w, md, &t, DIRECTION_BUY, 10 * SOL);
        trade(w, md, &t, DIRECTION_SELL, q.amount_out);
    };
    round_trip(&mut w, &mut md);
    // h sells everything, takes what it earned, closes its record
    let all = bal(&w, &hp);
    trade(&mut w, &mut md, &h, DIRECTION_SELL, all);
    assert!(must(try_claim(&mut w, &mut md, &h)) > 0);
    must(try_close(&mut w, &mut md, &h));
    // trades while h has no record; a claim by the other holder settles them
    for _ in 0..3 {
        round_trip(&mut w, &mut md);
    }
    let theirs = must(try_claim(&mut w, &mut md, &other));
    assert!(theirs > 0);
    round_trip(&mut w, &mut md);
    // h buys again and opens its record again: it starts from the accumulator as it is now
    trade(&mut w, &mut md, &h, DIRECTION_BUY, 5 * SOL);
    open(&mut w, &mut md, &h);
    let r: HolderRecord = w.env.account(&holder_of(&w.k, &hp));
    assert_eq!((r.balance, r.owed, r.acc_snapshot), (bal(&w, &hp), 0, cfg(&w).acc_per_share), "nothing of the past is owed");
    assert_eq!(try_claim(&mut w, &mut md, &h), Err("nothing to claim"));
    // from here on it earns its share of what comes, to the lamport against the model
    round_trip(&mut w, &mut md);
    let snapshot = r.acc_snapshot;
    let mine = must(try_claim(&mut w, &mut md, &h));
    let c = cfg(&w);
    assert_eq!(mine as u128, r.balance as u128 * (c.acc_per_share - snapshot) / ACC, "exactly the share since the reopen");
    assert!(mine > 0);
    check(&w, &md);
}
