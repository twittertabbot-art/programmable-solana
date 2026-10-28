//! hook_rules: platform template hook. The specification is RULES.md at the repo root.
//!
//! A launcher switches on the rules a coin should have and sets their numbers inside the
//! ceilings below. Nothing here changes a rule afterwards: the only instruction that
//! writes a rate, a window, the creator or the treasury is `init_pool_config`, and it
//! runs once per pool.
//!
//! * Sniper fee: a buy in the first slots pays a pool fee that falls in a straight line.
//!   While that window runs nobody can add liquidity, so the fee stays with the
//!   liquidity the pool was created with.
//! * Creator fee, holder rewards, burn: three shares of every trade, taken as one hook
//!   fee in the quote token and split by this program, each with its own rate for buys
//!   and for sells. A trade always pays all three; the holders' share goes to the burn
//!   pot while too little is staked.
//! * Buy limit: in the first slots no single buy may spend more than a set amount.
//! * Creator lock: the launcher's coins in a lock account until a date.
//!
//! The pool pays the hook fee of a trade AFTER it asked `before_swap`, so a trade's fee
//! is split the next time this program runs for the pool ("settled one trade late").
//!
//! A second kind of coin, the STRICT coin, is a Token-2022 mint whose transfer hook is this
//! program. For such a coin this program also runs inside every transfer (`execute`), which
//! gives three rules a plain coin cannot have: a max wallet, a lock on coins bought early,
//! and the holders' share paid to wallets that hold the coin, without staking. Nothing of
//! it runs for a plain coin: its config says `kind = 0` and its accounts and instructions
//! are what they were. The strict coin is the last part of this file.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked};
use hookpool::program::Hookpool;
use hookpool::Platform;
use hookpool_interface::*;

declare_id!("3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr");

pub const CFG_SEED: &[u8] = b"cfg";
pub const STAKE_SEED: &[u8] = b"stake";
pub const STAKE_VAULT_SEED: &[u8] = b"stake-vault";
pub const LOCK_SEED: &[u8] = b"lock";
pub const LOCK_VAULT_SEED: &[u8] = b"lock-vault";

pub const FLAGS: u32 = BEFORE_SWAP
    | BEFORE_ADD_LIQ
    | ON_POOL_CREATE
    | OVERRIDE_FEE
    | TAKE_HOOK_FEE
    | CALL_ON_BUY
    | CALL_ON_SELL;

// ---- ceilings (RULES.md, "Bounds") ----------------------------------------------------

pub const MAX_CREATOR_BPS: u16 = 500;
pub const MAX_HOLDERS_BPS: u16 = 500;
pub const MAX_BURN_BPS: u16 = 500;
/// The three rates of one side together. Equal to the platform's hook fee cap at launch;
/// the pool clamps anything above the live cap, so a rate can never block trades.
pub const MAX_SIDE_BPS: u16 = 1_000;
/// Matches the platform's launch-time max_fee_override_bps.
pub const MAX_START_FEE_BPS: u16 = 5_000;
pub const MAX_SNIPER_SLOTS: u64 = 10_800; // about 1h12m at 400ms
pub const MAX_LIMIT_SLOTS: u64 = 9_000; // about one hour
pub const MAX_LOCK_SECONDS: u64 = 365 * 86_400;

/// `lock_creator` with this amount locks the whole balance of the creator's coin account.
pub const LOCK_WHOLE_BALANCE: u64 = u64::MAX;
/// A stake record cannot be reduced until this many slots after its last stake.
pub const UNSTAKE_DELAY_SLOTS: u64 = 9_000;
/// Scale of `acc_per_share`.
pub const ACC_SCALE: u128 = 1_000_000_000_000;
/// Stakers get the holders' share of a trade while at least supply / this is staked (0.1%).
pub const ELIGIBLE_DIVISOR: u64 = 1_000;

// ---- the strict coin: constants (RULES.md, "The strict coin") --------------------------

/// `RulesConfig.kind`: an SPL or Token-2022 coin without a transfer hook.
pub const KIND_PLAIN: u8 = 0;
/// `RulesConfig.kind`: a Token-2022 coin whose transfer hook is this program.
pub const KIND_STRICT: u8 = 1;
pub const HOLDER_SEED: &[u8] = b"holder";
pub const MIN_MAX_WALLET_BPS: u16 = 10;
pub const MAX_MAX_WALLET_BPS: u16 = 5_000;
pub const MAX_MAX_WALLET_SLOTS: u32 = 6_480_000; // about 30 days
pub const MAX_EARLY_SLOTS: u16 = 9_000; // about one hour
pub const MAX_EARLY_UNLOCK_SLOTS: u32 = 1_512_000; // about 7 days

// ---- accounts -------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct HookManifest {
    pub version: u8,
    pub flags: u32,
    pub admin: Option<Pubkey>,
    pub name: [u8; 32],
    pub uri: [u8; 128],
}

/// The three shares of a trade, in basis points.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct Rates {
    pub creator_bps: u16,
    pub holders_bps: u16,
    pub burn_bps: u16,
}

impl Rates {
    pub fn total(&self) -> u16 {
        self.creator_bps.saturating_add(self.holders_bps).saturating_add(self.burn_bps)
    }
}

/// What the launcher chooses. The same fields, in the same order, as the rule part of
/// `RulesConfig`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RulesArgs {
    pub sniper_slots: u64,
    pub sniper_start_fee_bps: u16,
    pub buy: Rates,
    pub sell: Rates,
    pub max_buy_quote: u64,
    pub limit_slots: u64,
    pub creator_lock_seconds: u64,
}

/// The rules of one pool and the running numbers. PDA ["cfg", pool]. This account is also
/// the owner of the stake vault and of the lock vault, and signs when coins leave them.
/// The three numbers of a strict coin, fixed at launch like the rest.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StrictArgs {
    /// Max wallet, in basis points of the supply. 0 = off.
    pub max_wallet_bps: u16,
    /// For how many slots after launch the max wallet holds.
    pub max_wallet_slots: u32,
    /// Buys from the pool in the first `early_slots` slots are "early". 0 = off.
    pub early_slots: u16,
    /// Early coins unlock at `start_slot + early_unlock_slots`.
    pub early_unlock_slots: u32,
}

#[account]
#[derive(InitSpace)]
pub struct RulesConfig {
    pub bump: u8,
    pub authority_bump: u8,
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    /// ATA of the authority PDA for the quote mint. Must be the pool's hook treasury.
    pub treasury: Pubkey,
    /// Who paid for this config. Must be the pool creator. Receives the creator fee.
    pub creator: Pubkey,

    // the rules, written once
    pub sniper_slots: u64,
    pub sniper_start_fee_bps: u16,
    pub buy: Rates,
    pub sell: Rates,
    pub max_buy_quote: u64,
    pub limit_slots: u64,
    pub creator_lock_seconds: u64,

    // written by on_pool_create
    pub start_slot: u64,
    pub start_time: i64,
    /// Never zero once the pool exists, so it also tells whether the pool was created.
    pub min_eligible: u64,

    // the running numbers
    /// The pool's hook fees paid to the treasury, as of the last settlement.
    pub fees_seen: u64,
    /// The three rates of the last trade's side: what its fee is split by.
    pub last_split: Rates,
    pub creator_owed: u64,
    pub burn_pot: u64,
    pub acc_per_share: u128,
    pub reward_rem: u64,
    pub total_staked: u64,
    pub rewards_owed_total: u64,
    pub total_creator_paid: u64,
    pub total_rewards_paid: u64,
    pub total_quote_burned: u64,
    pub total_base_burned: u64,
    pub burns: u64,
    /// The observation `run_burn` buys against (`burn_step` of the interface crate): the
    /// slot it was taken in and the pool's reserves then. No observation yet while a
    /// reserve is zero. `before_swap` lowers the observed price, never raises the
    /// observed depth, and leaves the slot, when a trade starts below the observed price
    /// (`burn_lowered`).
    pub obs_slot: u64,
    pub obs_reserve_base: u64,
    pub obs_reserve_quote: u64,

    // The strict coin. All zero on a plain coin, forever.
    /// `KIND_PLAIN` or `KIND_STRICT`. Written by the instruction that creates the config.
    pub kind: u8,
    /// 1 between `before_swap` of a buy and the transfer that pays that buy out. That
    /// transfer, and any other transfer of the coin, sets it back to 0.
    pub buy_mark: u8,
    /// Bump of the pool's vault of the coin. Written by `on_pool_create`.
    pub vault_bump: u8,
    pub max_wallet_bps: u16,
    pub early_slots: u16,
    pub max_wallet_slots: u32,
    pub early_unlock_slots: u32,
    /// The max wallet in units of the coin, from the supply when the pool was created.
    pub max_wallet_amount: u64,
    pub reserved: [u8; 17],
}

/// One per staker and pool. PDA ["stake", pool, wallet].
#[account]
#[derive(InitSpace)]
pub struct StakeRecord {
    pub bump: u8,
    pub pool: Pubkey,
    pub staker: Pubkey,
    pub amount: u64,
    /// `acc_per_share` when this record was last brought up to date.
    pub acc_snapshot: u128,
    /// Rewards settled into this record and not paid yet.
    pub owed: u64,
    /// Slot of the last stake. `unstake` waits UNSTAKE_DELAY_SLOTS from here.
    pub since_slot: u64,
}

/// A wallet that holds a strict coin and asked for its share. PDA ["holder", pool, wallet].
/// The first six fields are the ones of a stake record, with the wallet's balance of the
/// coin where a stake record has the staked amount.
#[account]
#[derive(InitSpace)]
pub struct HolderRecord {
    pub bump: u8,
    pub pool: Pubkey,
    pub owner: Pubkey,
    /// What the wallet's associated token account held after its last transfer. The
    /// holders' share is paid on this.
    pub balance: u64,
    /// `acc_per_share` when this record was last brought up to date.
    pub acc_snapshot: u128,
    /// Rewards settled into this record and not paid yet.
    pub owed: u64,
    /// Coins this wallet bought from the pool inside the early window. Until the unlock
    /// its balance cannot go below this.
    pub early_bought: u64,
    /// The creator lock of a strict coin: the creator's balance cannot go below this ...
    pub locked: u64,
    /// ... before this unix time. Both zero for every other wallet.
    pub locked_until: i64,
}

/// The creator lock of one pool. PDA ["lock", pool].
#[account]
#[derive(InitSpace)]
pub struct LockRecord {
    pub bump: u8,
    pub pool: Pubkey,
    /// Coins the creator put in the lock vault and has not taken back.
    pub amount: u64,
    /// Unix time from which `unlock_creator` works. Zero when nothing is locked.
    pub unlock_at: i64,
}

// ---- events ---------------------------------------------------------------------------

/// Emitted through event CPI by every `run_burn` that returns Ok. `outcome` says what it
/// did: `BURN_OBSERVED` (1, the first observation, nothing bought), `BURN_WAITED` (2, the
/// price was above the observation by more than the tolerance, nothing bought) or
/// `BURN_BOUGHT` (3). The observation is the one the call left in the config.
#[event]
pub struct BurnExecuted {
    pub pool: Pubkey,
    pub quote_spent: u64,
    pub base_burned: u64,
    pub slot: u64,
    pub outcome: u8,
    pub obs_reserve_base: u64,
    pub obs_reserve_quote: u64,
}

#[event]
pub struct Staked {
    pub pool: Pubkey,
    pub staker: Pubkey,
    pub amount: u64,
    pub staked: u64,
    pub total_staked: u64,
    pub slot: u64,
}

#[event]
pub struct Unstaked {
    pub pool: Pubkey,
    pub staker: Pubkey,
    pub amount: u64,
    pub staked: u64,
    pub total_staked: u64,
    pub slot: u64,
}

#[event]
pub struct RewardsClaimed {
    pub pool: Pubkey,
    pub staker: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CreatorClaimed {
    pub pool: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CreatorLocked {
    pub pool: Pubkey,
    pub creator: Pubkey,
    /// Coins added by this call.
    pub amount: u64,
    /// Coins in the lock record after this call.
    pub locked: u64,
    pub unlock_at: i64,
}

#[event]
pub struct HolderOpened {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub balance: u64,
}

#[event]
pub struct HolderClaimed {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct HolderSynced {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub balance: u64,
}

#[event]
pub struct HolderClosed {
    pub pool: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct CreatorUnlocked {
    pub pool: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}

// ---- errors ---------------------------------------------------------------------------

#[error_code]
pub enum RulesError {
    #[msg("creator fee above the maximum")]
    CreatorFeeTooHigh,
    #[msg("holder rewards above the maximum")]
    HoldersFeeTooHigh,
    #[msg("burn rate above the maximum")]
    BurnFeeTooHigh,
    #[msg("the three rates of one side together are above the maximum")]
    SideTooHigh,
    #[msg("sniper start fee above the maximum")]
    StartFeeTooHigh,
    #[msg("sniper window too long")]
    SniperWindowTooLong,
    #[msg("a sniper fee needs both a window and a start fee")]
    SniperIncomplete,
    #[msg("buy limit window too long")]
    LimitWindowTooLong,
    #[msg("a buy limit needs both an amount and a window")]
    LimitIncomplete,
    #[msg("creator lock longer than the maximum")]
    LockTooLong,
    #[msg("config does not belong to this pool")]
    WrongPool,
    #[msg("this pool does not run this hook")]
    WrongHook,
    #[msg("config was not created by the pool creator")]
    WrongCreator,
    #[msg("pool mints do not match the config")]
    WrongMints,
    #[msg("pool treasury is not this hook's treasury")]
    WrongTreasury,
    #[msg("the pool of this config already exists")]
    AlreadyStarted,
    #[msg("the pool of this config does not exist yet")]
    NotStarted,
    #[msg("buy above the limit of the launch window")]
    BuyTooLarge,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("unstake is not open yet: the delay runs from the last stake")]
    UnstakeTooEarly,
    #[msg("more than this record has staked")]
    InsufficientStake,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("only the creator of the config can do this")]
    NotCreator,
    #[msg("the burn pot is empty")]
    NothingToBurn,
    #[msg("nothing was bought")]
    NothingBought,
    #[msg("the unlock time can only move later")]
    UnlockEarlier,
    #[msg("unlock time is before the lock declared at launch")]
    UnlockBeforeDeclared,
    #[msg("unlock time is too far ahead")]
    UnlockTooFar,
    #[msg("unlock time is not in the future")]
    UnlockInPast,
    #[msg("the creator lock is not over yet")]
    StillLocked,
    #[msg("nothing is locked")]
    NothingLocked,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("the burn's observation of the pool is less than 25 slots old")]
    BurnTooSoon,
    #[msg("liquidity cannot be added while the sniper fee runs")]
    LiquidityInSniperWindow,
    #[msg("this instruction is not for a strict coin")]
    StrictCoin,
    #[msg("this instruction is only for a strict coin")]
    NotStrict,
    #[msg("the coin's transfer hook and the kind of its config do not agree")]
    WrongKind,
    #[msg("not used any more: a strict coin can have a burn rate")]
    StrictNoBurn,
    #[msg("max wallet outside its bounds")]
    MaxWalletOutOfBounds,
    #[msg("max wallet needs both a share and a window")]
    MaxWalletIncomplete,
    #[msg("early lock outside its bounds")]
    EarlyOutOfBounds,
    #[msg("early lock needs both a window and an unlock")]
    EarlyIncomplete,
    #[msg("the transfer hook runs only inside a transfer of this coin")]
    NotATransfer,
    #[msg("the receiving account is not the associated token account of its wallet")]
    NotAssociatedAccount,
    #[msg("this transfer would leave the wallet above the max wallet")]
    MaxWallet,
    #[msg("coins bought early are locked until the unlock")]
    EarlyLocked,
    #[msg("the creator's locked coins cannot move before the unlock time")]
    CreatorLocked,
    #[msg("a buy in the early window needs the wallet's holder record: open it first")]
    HolderRecordRequired,
    #[msg("liquidity cannot be added while the max wallet runs")]
    LiquidityInMaxWalletWindow,
    #[msg("the holder record still holds something")]
    HolderNotEmpty,
    #[msg("not the associated token account of this wallet for this coin")]
    WrongHolder,
    #[msg("cannot lock more than the wallet holds")]
    LockAboveBalance,
}

// ---- pure rules -----------------------------------------------------------------------

/// Every bound of `init_pool_config`.
pub fn check_rules(a: &RulesArgs) -> Result<()> {
    for side in [&a.buy, &a.sell] {
        require!(side.creator_bps <= MAX_CREATOR_BPS, RulesError::CreatorFeeTooHigh);
        require!(side.holders_bps <= MAX_HOLDERS_BPS, RulesError::HoldersFeeTooHigh);
        require!(side.burn_bps <= MAX_BURN_BPS, RulesError::BurnFeeTooHigh);
        require!(side.total() <= MAX_SIDE_BPS, RulesError::SideTooHigh);
    }
    require!(a.sniper_start_fee_bps <= MAX_START_FEE_BPS, RulesError::StartFeeTooHigh);
    require!(a.sniper_slots <= MAX_SNIPER_SLOTS, RulesError::SniperWindowTooLong);
    // "0 = off" must mean off: a window without a fee, or a fee without a window, is a
    // rule that reads as on and does nothing.
    require!(
        (a.sniper_slots == 0) == (a.sniper_start_fee_bps == 0),
        RulesError::SniperIncomplete
    );
    require!(a.limit_slots <= MAX_LIMIT_SLOTS, RulesError::LimitWindowTooLong);
    require!((a.max_buy_quote == 0) == (a.limit_slots == 0), RulesError::LimitIncomplete);
    require!(a.creator_lock_seconds <= MAX_LOCK_SECONDS, RulesError::LockTooLong);
    Ok(())
}

/// The pool fee of a buy inside the sniper window: a straight line from `start_fee_bps`
/// at `start_slot` to `base_fee_bps` at `start_slot + sniper_slots`. `None` once the
/// window is over, or when the start fee is not above the pool's own fee. The formula of
/// the launch guard template.
pub fn sniper_fee(
    slot: u64,
    start_slot: u64,
    sniper_slots: u64,
    start_fee_bps: u16,
    base_fee_bps: u16,
) -> Option<u16> {
    if start_fee_bps <= base_fee_bps || sniper_slots == 0 {
        return None;
    }
    let elapsed = slot.saturating_sub(start_slot);
    if elapsed >= sniper_slots {
        return None;
    }
    let span = (start_fee_bps - base_fee_bps) as u128;
    let decayed = span * elapsed as u128 / sniper_slots as u128;
    Some(start_fee_bps - decayed as u16)
}

/// Split `fresh` units of hook fee by the rates it was charged at:
/// `(creator, holders, burn)`. Creator and holders are rounded down, the burn pot takes
/// the rest. With no rate at all, everything goes to the burn pot.
pub fn split(fresh: u64, charged: &Rates) -> Result<(u64, u64, u64)> {
    let c = charged.creator_bps as u128;
    let h = charged.holders_bps as u128;
    let t = c + h + charged.burn_bps as u128;
    if t == 0 {
        return Ok((0, 0, fresh));
    }
    let f = fresh as u128;
    let creator = (f * c / t) as u64;
    let holders = (f * h / t) as u64;
    let burn = fresh
        .checked_sub(creator)
        .and_then(|v| v.checked_sub(holders))
        .ok_or(RulesError::MathOverflow)?;
    Ok((creator, holders, burn))
}

/// The pool in account 0 must be one that runs this hook. The pool program calls a hook
/// only for its own pools, and signs with an address no other hook receives, so this
/// cannot fail today. It is here so that a callback never writes for a foreign pool even
/// if that ever stops being true.
pub fn runs_this_hook(pool: &PoolData) -> Result<()> {
    require_keys_eq!(pool.hook_program, crate::ID, RulesError::WrongHook);
    Ok(())
}

impl RulesConfig {
    /// True once the pool exists (`on_pool_create` ran).
    pub fn started(&self) -> bool {
        self.min_eligible != 0
    }

    /// The rates of one side. A trade always pays all three.
    pub fn side(&self, is_buy: bool) -> Rates {
        if is_buy {
            self.buy
        } else {
            self.sell
        }
    }

    /// The part of a trade's hook fee that nobody gets back, in bps: the burn share of
    /// what the pool really charges. The pool charges `min(c + h + b, platform cap)` and
    /// the burn pot's part of that is `b / (c + h + b)`. The creator's share comes back to
    /// the creator and the holders' share to whoever is staked, so neither is a cost for
    /// them, and the cap of the burn has to hold against them too.
    pub fn burn_charged(&self, is_buy: bool, max_hook_fee_bps: u16) -> u16 {
        let side = self.side(is_buy);
        let total = side.total() as u32;
        if total == 0 {
            return 0;
        }
        let charged = total.min(max_hook_fee_bps as u32);
        (charged * side.burn_bps as u32 / total) as u16
    }

    /// The most one `run_burn` may spend, in basis points of the pool's quote reserve.
    pub fn burn_cap_bps(&self, protocol_fee_bps: u16, max_hook_fee_bps: u16, lp_fee_bps: u16) -> u64 {
        burn_cap_bps(
            protocol_fee_bps,
            lp_fee_bps,
            self.burn_charged(true, max_hook_fee_bps),
            self.burn_charged(false, max_hook_fee_bps),
        )
    }

    /// Do stakers receive the holders' share right now? Only while at least 0.1% of the
    /// supply is staked; otherwise it goes to the burn pot.
    pub fn stakers_eligible(&self) -> bool {
        self.total_staked > 0 && self.total_staked >= self.min_eligible
    }

    /// Split the hook fees the treasury received since the last settlement.
    ///
    /// `fees_total` and `fees_owed` are the pool's `hook_fees_quote_total` and
    /// `hook_fees_owed_quote`. A fee the pool still owes is not in the treasury, so it is
    /// not counted until it is paid. The pool owes nothing as long as the treasury
    /// account exists, and no instruction of this program closes it.
    ///
    /// This runs inside `before_swap`, where a failure would block every trade, so it
    /// only fails on arithmetic that cannot happen: the parts add up to `fresh`, and the
    /// sum of all `fresh` is a u64 counter of the pool.
    pub fn settle(&mut self, fees_total: u64, fees_owed: u64) -> Result<()> {
        let paid = fees_total.saturating_sub(fees_owed);
        let fresh = paid.saturating_sub(self.fees_seen);
        if fresh == 0 {
            return Ok(());
        }
        self.fees_seen = paid;
        let (creator, holders, mut burn) = split(fresh, &self.last_split)?;
        if holders > 0 {
            if !self.stakers_eligible() {
                // Too little is staked: the holders' share is burned instead. `stake` and
                // `unstake` settle before they change the total, so the total here is the
                // one of the moment the trade was made.
                burn = burn.checked_add(holders).ok_or(RulesError::MathOverflow)?;
            } else {
                let staked = self.total_staked as u128;
                let num = (holders as u128)
                    .checked_mul(ACC_SCALE)
                    .and_then(|v| v.checked_add(self.reward_rem as u128))
                    .ok_or(RulesError::MathOverflow)?;
                self.acc_per_share = self
                    .acc_per_share
                    .checked_add(num / staked)
                    .ok_or(RulesError::MathOverflow)?;
                // below `staked`, which is a u64
                self.reward_rem = (num % staked) as u64;
            }
        }
        self.creator_owed = self.creator_owed.checked_add(creator).ok_or(RulesError::MathOverflow)?;
        self.burn_pot = self.burn_pot.checked_add(burn).ok_or(RulesError::MathOverflow)?;
        Ok(())
    }

    /// The same as `accrue` for a holder record: what its balance earned since its
    /// snapshot goes into `owed`. Must run before the balance changes.
    pub fn accrue_holder(&mut self, rec: &mut HolderRecord) -> Result<()> {
        let pending = pending_reward(rec.balance, rec.acc_snapshot, self.acc_per_share)?;
        rec.owed = rec.owed.checked_add(pending).ok_or(RulesError::MathOverflow)?;
        self.rewards_owed_total = self.rewards_owed_total.checked_add(pending).ok_or(RulesError::MathOverflow)?;
        rec.acc_snapshot = self.acc_per_share;
        Ok(())
    }

    /// Is the max wallet in force in this slot?
    pub fn max_wallet_runs(&self, slot: u64) -> bool {
        self.max_wallet_slots > 0 && self.started() && slot.saturating_sub(self.start_slot) < self.max_wallet_slots as u64
    }

    /// Is a buy in this slot an early buy?
    pub fn early_window_runs(&self, slot: u64) -> bool {
        self.early_slots > 0 && self.started() && slot.saturating_sub(self.start_slot) < self.early_slots as u64
    }

    /// Are early coins still locked in this slot?
    pub fn early_locked(&self, slot: u64) -> bool {
        self.early_slots > 0 && self.started() && slot.saturating_sub(self.start_slot) < self.early_unlock_slots as u64
    }

    /// Move what a stake record earned since its snapshot into `owed`. Rounded down.
    /// Must run before the record's amount changes.
    pub fn accrue(&mut self, rec: &mut StakeRecord) -> Result<()> {
        let delta = self
            .acc_per_share
            .checked_sub(rec.acc_snapshot)
            .ok_or(RulesError::MathOverflow)?;
        if delta > 0 && rec.amount > 0 {
            let pending = (rec.amount as u128)
                .checked_mul(delta)
                .ok_or(RulesError::MathOverflow)?
                / ACC_SCALE;
            let pending = u64::try_from(pending).map_err(|_| RulesError::MathOverflow)?;
            rec.owed = rec.owed.checked_add(pending).ok_or(RulesError::MathOverflow)?;
            self.rewards_owed_total = self
                .rewards_owed_total
                .checked_add(pending)
                .ok_or(RulesError::MathOverflow)?;
        }
        rec.acc_snapshot = self.acc_per_share;
        Ok(())
    }
}

/// What `amount` units earned between two values of the accumulator, rounded down.
pub fn pending_reward(amount: u64, snapshot: u128, acc_per_share: u128) -> Result<u64> {
    let delta = acc_per_share.checked_sub(snapshot).ok_or(RulesError::MathOverflow)?;
    if delta == 0 || amount == 0 {
        return Ok(0);
    }
    let pending = (amount as u128).checked_mul(delta).ok_or(RulesError::MathOverflow)? / ACC_SCALE;
    u64::try_from(pending).map_err(|_| RulesError::MathOverflow.into())
}

/// Every bound of the three numbers of a strict coin.
pub fn check_strict(a: &StrictArgs) -> Result<()> {
    require!((a.max_wallet_bps == 0) == (a.max_wallet_slots == 0), RulesError::MaxWalletIncomplete);
    if a.max_wallet_bps != 0 {
        require!(
            (MIN_MAX_WALLET_BPS..=MAX_MAX_WALLET_BPS).contains(&a.max_wallet_bps) && a.max_wallet_slots <= MAX_MAX_WALLET_SLOTS,
            RulesError::MaxWalletOutOfBounds
        );
    }
    require!((a.early_slots == 0) == (a.early_unlock_slots == 0), RulesError::EarlyIncomplete);
    if a.early_slots != 0 {
        require!(
            a.early_slots <= MAX_EARLY_SLOTS && a.early_unlock_slots >= a.early_slots as u32 && a.early_unlock_slots <= MAX_EARLY_UNLOCK_SLOTS,
            RulesError::EarlyOutOfBounds
        );
    }
    Ok(())
}

/// Supply of an SPL Token or Token-2022 mint (the same bytes in both).
fn mint_supply(mint: &AccountInfo) -> Result<u64> {
    let d = mint.try_borrow_data()?;
    require!(d.len() >= 82, RulesError::WrongMints);
    Ok(u64::from_le_bytes(d[36..44].try_into().unwrap()))
}

// ---- addresses ------------------------------------------------------------------------

pub fn cfg_address(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CFG_SEED, pool.as_ref()], &crate::ID).0
}
pub fn authority_address(pool: &Pubkey) -> Pubkey {
    hook_authority_address(pool, &crate::ID).0
}
/// Where this hook's treasury for a pool lives.
pub fn treasury_address(pool: &Pubkey, quote_mint: &Pubkey, quote_token_program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(&authority_address(pool), quote_mint, quote_token_program)
}
/// The account `run_burn` buys into and burns from.
pub fn burn_account_address(pool: &Pubkey, base_mint: &Pubkey, base_token_program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(&authority_address(pool), base_mint, base_token_program)
}
pub fn stake_vault_address(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[STAKE_VAULT_SEED, pool.as_ref()], &crate::ID).0
}
pub fn stake_address(pool: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[STAKE_SEED, pool.as_ref(), wallet.as_ref()], &crate::ID).0
}
pub fn lock_address(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[LOCK_SEED, pool.as_ref()], &crate::ID).0
}
pub fn lock_vault_address(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[LOCK_VAULT_SEED, pool.as_ref()], &crate::ID).0
}

/// The holder record of a wallet on a strict coin's pool.
pub fn holder_address(pool: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[HOLDER_SEED, pool.as_ref(), wallet.as_ref()], &crate::ID).0
}
/// The account list Token-2022 reads on every transfer of a strict coin.
pub fn validation_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[TRANSFER_HOOK_METAS_SEED, mint.as_ref()], &crate::ID).0
}
/// The one token account of a wallet that may receive a strict coin.
pub fn strict_account_address(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(wallet, mint, &anchor_spl::token_2022::ID)
}

// ---- program --------------------------------------------------------------------------

#[program]
pub mod hook_rules {
    use super::*;

    /// One-time: publish the manifest and the extra-accounts list. Upgrade authority only.
    pub fn init_manifest(ctx: Context<InitManifest>, uri: String) -> Result<()> {
        require_upgrade_authority(
            &crate::ID,
            &ctx.accounts.program_data.to_account_info(),
            &ctx.accounts.authority.key(),
        )?;
        let m = HookManifestData::new(FLAGS, None, "Programmable launch rules", &uri);
        let man = &mut ctx.accounts.manifest;
        man.version = m.version;
        man.flags = m.flags;
        man.admin = m.admin;
        man.name = m.name;
        man.uri = m.uri;
        // Writable: before_swap settles and records the rates it answered.
        let metas = [per_pool_config_meta(CFG_SEED, true)?];
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        init_extra_metas(&mut data, &metas)
    }

    /// By the launcher, before `create_pool`. Writes the rules, once, and creates the
    /// treasury, the burn account and the stake vault. The pool's `hook_quote_treasury`
    /// must be `cfg.treasury`.
    pub fn init_pool_config(ctx: Context<InitPoolConfig>, pool: Pubkey, args: RulesArgs) -> Result<()> {
        check_rules(&args)?;
        // a coin whose transfer hook is this program takes `init_strict_config`
        require!(!is_strict_mint(&ctx.accounts.base_mint.to_account_info()), RulesError::WrongKind);
        let base_mint = ctx.accounts.base_mint.key();
        let quote_mint = ctx.accounts.quote_mint.key();
        require_keys_eq!(pool, pool_address(&base_mint, &quote_mint).0, RulesError::WrongPool);
        let cfg = &mut ctx.accounts.cfg;
        cfg.bump = ctx.bumps.cfg;
        cfg.authority_bump = ctx.bumps.hook_authority;
        cfg.pool = pool;
        cfg.base_mint = base_mint;
        cfg.quote_mint = quote_mint;
        cfg.treasury = ctx.accounts.treasury_quote.key();
        cfg.creator = ctx.accounts.payer.key();
        cfg.sniper_slots = args.sniper_slots;
        cfg.sniper_start_fee_bps = args.sniper_start_fee_bps;
        cfg.buy = args.buy;
        cfg.sell = args.sell;
        cfg.max_buy_quote = args.max_buy_quote;
        cfg.limit_slots = args.limit_slots;
        cfg.creator_lock_seconds = args.creator_lock_seconds;
        Ok(())
    }

    // ---- callbacks from the pool program ---------------------------------------------

    pub fn on_pool_create(ctx: Context<Callback>, payload: PoolCreatePayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        let cfg = &mut ctx.accounts.cfg;
        // `verify_caller` proved that the pool program is calling this hook. Which pool,
        // and who created it, is taken from the Pool account, which only the pool program
        // writes, and not from the payload alone.
        runs_this_hook(&pool)?;
        require_keys_eq!(cfg.creator, payload.creator, RulesError::WrongCreator);
        require_keys_eq!(cfg.creator, pool.creator, RulesError::WrongCreator);
        require!(
            pool.base_mint == cfg.base_mint && pool.quote_mint == cfg.quote_mint,
            RulesError::WrongMints
        );
        require_keys_eq!(ctx.accounts.base_mint.key(), cfg.base_mint, RulesError::WrongMints);
        require_keys_eq!(pool.hook_quote_treasury, cfg.treasury, RulesError::WrongTreasury);
        require!(!cfg.started(), RulesError::AlreadyStarted);
        let clock = Clock::get()?;
        cfg.start_slot = clock.slot;
        cfg.start_time = clock.unix_timestamp;
        let supply = mint_supply(&ctx.accounts.base_mint.to_account_info())?;
        cfg.min_eligible = (supply / ELIGIBLE_DIVISOR).max(1);
        // A coin whose transfer hook is this program has a strict config, and no other
        // coin has one.
        let strict = is_strict_mint(&ctx.accounts.base_mint.to_account_info());
        require!(strict == (cfg.kind == KIND_STRICT), RulesError::WrongKind);
        if strict {
            cfg.vault_bump = vault_address(&cfg.pool, &cfg.base_mint).1;
            if cfg.max_wallet_bps > 0 {
                cfg.max_wallet_amount = ((supply as u128 * cfg.max_wallet_bps as u128 / 10_000) as u64).max(1);
            }
        }
        Ok(())
    }

    pub fn before_swap(ctx: Context<Callback>, payload: SwapPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        runs_this_hook(&pool)?;
        let cfg = &mut ctx.accounts.cfg;
        // 1. the fee of the trade before this one
        cfg.settle(pool.hook_fees_quote_total, pool.hook_fees_owed_quote)?;

        let is_buy = payload.direction == DIRECTION_BUY;
        // 2. buy limit
        if is_buy
            && cfg.max_buy_quote > 0
            && payload.slot.saturating_sub(cfg.start_slot) < cfg.limit_slots
        {
            require!(payload.amount_in <= cfg.max_buy_quote, RulesError::BuyTooLarge);
        }
        // 3. the answer: all three rates of the side, whoever is staked, so that what a
        //    trader pays never depends on anybody's stake. Remembered so that the next
        //    settlement can split this trade's fee.
        let charged = cfg.side(is_buy);
        cfg.last_split = charged;
        // A strict coin: the transfer that pays a buy out must be told from a removal of
        // liquidity, which leaves the same vault for a wallet too. The pool makes that
        // transfer right after this callback, and `execute` takes the mark away.
        if cfg.kind == KIND_STRICT {
            cfg.buy_mark = is_buy as u8;
        }
        // 4. the burn's observation never stands above a price a trade starts at. Only
        //    its price moves: the observed depth is never raised by a trade. The price is
        //    made of the EFFECTIVE quote: on a pool on the curve the virtual quote counts
        //    in it (HOOKS.md section 2); the payload carries the real reserve.
        let effective_quote = payload.reserve_quote.checked_add(pool.virtual_quote).ok_or(InterfaceError::QuoteOverflow)?;
        if let Some((base, quote)) = burn_lowered(cfg.obs_reserve_base, cfg.obs_reserve_quote, payload.reserve_base, effective_quote) {
            cfg.obs_reserve_base = base;
            cfg.obs_reserve_quote = quote;
        }
        let fee_override_bps = if is_buy {
            sniper_fee(
                payload.slot,
                cfg.start_slot,
                cfg.sniper_slots,
                cfg.sniper_start_fee_bps,
                payload.lp_fee_bps,
            )
        } else {
            None
        };
        HookReturn {
            version: HookReturn::VERSION,
            fee_override_bps,
            hook_fee_bps: charged.total(),
            curve: None,
        }
        .set()
    }

    /// No liquidity is added while the sniper fee runs. The sniper fee is a pool fee: it
    /// goes to every LP share. Without this, a wallet could add liquidity in the launch
    /// slot and take most of a sniper's fee out again with it. Removing is never refused:
    /// this hook has no callback for it.
    pub fn before_add_liquidity(ctx: Context<Callback>, payload: LiquidityPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let cfg = &ctx.accounts.cfg;
        require!(
            cfg.sniper_slots == 0 || payload.slot.saturating_sub(cfg.start_slot) >= cfg.sniper_slots,
            RulesError::LiquidityInSniperWindow
        );
        // A strict coin: while the max wallet runs too. Coins that come back out of the
        // pool with a removal of liquidity are never held to the max wallet, so that a
        // liquidity provider can always leave. If deposits were open, a wallet at the
        // cap could deposit its coins, buy up to the cap again and take the deposit back.
        require!(!cfg.max_wallet_runs(payload.slot), RulesError::LiquidityInMaxWalletWindow);
        Ok(())
    }

    // ---- for everyone -------------------------------------------------------------------

    /// Move coins from the wallet to the stake vault. Restarts the unstake delay of the
    /// whole record.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        // a strict coin pays the wallets that hold it; nothing is staked
        require!(ctx.accounts.cfg.kind == KIND_PLAIN, RulesError::StrictCoin);
        require!(amount > 0, RulesError::ZeroAmount);
        require!(ctx.accounts.cfg.started(), RulesError::NotStarted);
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        let slot = Clock::get()?.slot;
        let staker = ctx.accounts.staker.key();
        let cfg = &mut ctx.accounts.cfg;
        cfg.settle(pool.hook_fees_quote_total, pool.hook_fees_owed_quote)?;
        let rec = &mut ctx.accounts.stake;
        cfg.accrue(rec)?;
        rec.bump = ctx.bumps.stake;
        rec.pool = cfg.pool;
        rec.staker = staker;
        rec.amount = rec.amount.checked_add(amount).ok_or(RulesError::MathOverflow)?;
        rec.since_slot = slot;
        cfg.total_staked = cfg.total_staked.checked_add(amount).ok_or(RulesError::MathOverflow)?;
        let (pool_key, staked, total_staked) = (cfg.pool, rec.amount, cfg.total_staked);

        let a = &ctx.accounts;
        transfer_from_wallet(
            &a.base_token_program,
            &a.staker_base.to_account_info(),
            &a.base_mint.to_account_info(),
            &a.stake_vault.to_account_info(),
            &a.staker.to_account_info(),
            amount,
            a.base_mint.decimals,
        )?;
        emit!(Staked { pool: pool_key, staker, amount, staked, total_staked, slot });
        Ok(())
    }

    /// Move coins back to the wallet. Refused until UNSTAKE_DELAY_SLOTS after the
    /// record's last stake.
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, RulesError::ZeroAmount);
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        let slot = Clock::get()?.slot;
        let staker = ctx.accounts.staker.key();
        let cfg = &mut ctx.accounts.cfg;
        let rec = &mut ctx.accounts.stake;
        require!(
            slot >= rec.since_slot.saturating_add(UNSTAKE_DELAY_SLOTS),
            RulesError::UnstakeTooEarly
        );
        require!(amount <= rec.amount, RulesError::InsufficientStake);
        cfg.settle(pool.hook_fees_quote_total, pool.hook_fees_owed_quote)?;
        cfg.accrue(rec)?;
        rec.amount = rec.amount.checked_sub(amount).ok_or(RulesError::MathOverflow)?;
        cfg.total_staked = cfg.total_staked.checked_sub(amount).ok_or(RulesError::MathOverflow)?;
        let (pool_key, bump, staked, total_staked) = (cfg.pool, cfg.bump, rec.amount, cfg.total_staked);

        let a = &ctx.accounts;
        transfer_signed(
            &a.base_token_program,
            &a.stake_vault.to_account_info(),
            &a.base_mint.to_account_info(),
            &a.staker_base.to_account_info(),
            &a.cfg.to_account_info(),
            &[CFG_SEED, pool_key.as_ref(), &[bump]],
            amount,
            a.base_mint.decimals,
        )?;
        emit!(Unstaked { pool: pool_key, staker, amount, staked, total_staked, slot });
        Ok(())
    }

    /// Pay the staker's rewards, in the quote token, to the token account it names.
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        let staker = ctx.accounts.staker.key();
        let cfg = &mut ctx.accounts.cfg;
        cfg.settle(pool.hook_fees_quote_total, pool.hook_fees_owed_quote)?;
        let rec = &mut ctx.accounts.stake;
        cfg.accrue(rec)?;
        let amount = rec.owed;
        require!(amount > 0, RulesError::NothingToClaim);
        rec.owed = 0;
        cfg.rewards_owed_total =
            cfg.rewards_owed_total.checked_sub(amount).ok_or(RulesError::MathOverflow)?;
        cfg.total_rewards_paid =
            cfg.total_rewards_paid.checked_add(amount).ok_or(RulesError::MathOverflow)?;
        let (pool_key, bump) = (cfg.pool, cfg.authority_bump);

        let a = &ctx.accounts;
        transfer_signed(
            &a.quote_token_program,
            &a.treasury_quote.to_account_info(),
            &a.quote_mint.to_account_info(),
            &a.staker_quote.to_account_info(),
            &a.hook_authority.to_account_info(),
            &[HOOK_AUTHORITY_SEED, pool_key.as_ref(), &[bump]],
            amount,
            a.quote_mint.decimals,
        )?;
        emit!(RewardsClaimed { pool: pool_key, staker, amount });
        Ok(())
    }

    /// Buy the coin from the pool with the burn pot and burn what was bought. Anyone may
    /// call it, and whoever calls it chooses `min_amount_out`. So a run never buys at a
    /// price or on a depth its caller just made (`burn_step` of the interface crate):
    ///
    /// * it buys against an OBSERVATION of the pool that is at least BURN_INTERVAL_SLOTS
    ///   old. The first call of a pool only records one. A call that comes too soon fails
    ///   with `BurnTooSoon` and writes nothing.
    /// * when the price is above the observed one by more than twice the cap, it buys
    ///   nothing and records the reserves as the new observation.
    /// * otherwise it spends at most `burn_cap_bps` of the SMALLER of the quote reserve
    ///   now and the observed one, and records the reserves after the buy.
    /// * between calls, every trade that starts below the observed price lowers the
    ///   observed price to the one it started at, without raising the observed depth
    ///   (`before_swap`, `burn_lowered`). So a price is bought at only when no trade
    ///   started below it for the whole interval.
    ///
    /// Every call that returns Ok emits `BurnExecuted` with its outcome and sets return
    /// data: the outcome byte, then quote spent and coins burned (`set_burn_result`).
    pub fn run_burn(ctx: Context<RunBurn>, min_amount_out: u64) -> Result<()> {
        // A strict coin burns with `run_burn_strict`. Here the buy would move the coin, the
        // token program would call this program's own `execute` from inside this
        // instruction, and the runtime refuses a program that is entered again while it
        // runs.
        require!(ctx.accounts.cfg.kind == KIND_PLAIN, RulesError::StrictCoin);
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        // Prices and depths are measured on the EFFECTIVE quote, real plus virtual: on a
        // pool on the curve the price impact of a buy follows the effective depth, and
        // after graduation (virtual 0, price kept) an observation taken before it still
        // compares right.
        let effective_quote = pool.effective_quote()?;
        let slot = Clock::get()?.slot;
        let (protocol_fee_bps, max_hook_fee_bps) =
            (ctx.accounts.platform.protocol_fee_bps, ctx.accounts.platform.max_hook_fee_bps);
        let (pool_key, bump, pot, step) = {
            let cfg = &mut ctx.accounts.cfg;
            cfg.settle(pool.hook_fees_quote_total, pool.hook_fees_owed_quote)?;
            require!(cfg.burn_pot > 0, RulesError::NothingToBurn);
            let cap_bps = cfg.burn_cap_bps(protocol_fee_bps, max_hook_fee_bps, pool.lp_fee_bps);
            let step = burn_step(
                cfg.obs_reserve_base,
                cfg.obs_reserve_quote,
                cfg.obs_slot,
                pool.reserve_base,
                effective_quote,
                slot,
                cap_bps,
            );
            (cfg.pool, cfg.authority_bump, cfg.burn_pot, step)
        };

        let (outcome, quote_amount, bought, obs_base, obs_quote) = match step {
            BurnStep::TooSoon => return err!(RulesError::BurnTooSoon),
            BurnStep::Observe => (BURN_OBSERVED, 0, 0, pool.reserve_base, effective_quote),
            BurnStep::Wait => (BURN_WAITED, 0, 0, pool.reserve_base, effective_quote),
            BurnStep::Buy { max_spend } => {
                let quote_amount = pot.min(max_spend);
                cpi_hook_swap(ctx.accounts, &pool_key, bump, quote_amount, min_amount_out)?;
                ctx.accounts.authority_base.reload()?;
                let bought = ctx.accounts.authority_base.amount;
                require!(bought > 0, RulesError::NothingBought);
                cpi_burn(ctx.accounts, &pool_key, bump, bought)?;
                // the pool as this buy left it is what the next run is measured against
                let after = PoolData::read(&ctx.accounts.pool.to_account_info())?;
                (BURN_BOUGHT, quote_amount, bought, after.reserve_base, after.effective_quote()?)
            }
        };

        let cfg = &mut ctx.accounts.cfg;
        if outcome == BURN_BOUGHT {
            cfg.burn_pot = cfg.burn_pot.checked_sub(quote_amount).ok_or(RulesError::MathOverflow)?;
            cfg.total_quote_burned =
                cfg.total_quote_burned.checked_add(quote_amount).ok_or(RulesError::MathOverflow)?;
            cfg.total_base_burned = cfg.total_base_burned.saturating_add(bought);
            cfg.burns = cfg.burns.saturating_add(1);
        }
        cfg.obs_slot = slot;
        cfg.obs_reserve_base = obs_base;
        cfg.obs_reserve_quote = obs_quote;
        emit_cpi!(BurnExecuted {
            pool: pool_key,
            quote_spent: quote_amount,
            base_burned: bought,
            slot,
            outcome,
            obs_reserve_base: obs_base,
            obs_reserve_quote: obs_quote,
        });
        // last: the event CPI clears return data
        set_burn_result(outcome, quote_amount, bought);
        Ok(())
    }

    /// `run_burn` for a strict coin: the same instruction in every respect but one. The
    /// observation, the age it needs, the tolerance, the cap on the smaller depth, the
    /// lowering in `before_swap`, the event and the return data are those of `run_burn`.
    /// The one difference: the coins are bought through the pool's `hook_buy_burn`, which
    /// burns them in the pool's vault. They are never transferred, so the token program
    /// never calls `execute` of this program from inside this instruction, which the
    /// runtime would refuse. A strict coin therefore has no burn account, and nothing a
    /// stranger sends anywhere is burned with a run.
    pub fn run_burn_strict(ctx: Context<RunBurnStrict>, min_amount_out: u64) -> Result<()> {
        require!(ctx.accounts.cfg.kind == KIND_STRICT, RulesError::NotStrict);
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        // the effective quote, as in `run_burn`
        let effective_quote = pool.effective_quote()?;
        let slot = Clock::get()?.slot;
        let (protocol_fee_bps, max_hook_fee_bps) =
            (ctx.accounts.platform.protocol_fee_bps, ctx.accounts.platform.max_hook_fee_bps);
        let (pool_key, bump, pot, step) = {
            let cfg = &mut ctx.accounts.cfg;
            cfg.settle(pool.hook_fees_quote_total, pool.hook_fees_owed_quote)?;
            require!(cfg.burn_pot > 0, RulesError::NothingToBurn);
            let cap_bps = cfg.burn_cap_bps(protocol_fee_bps, max_hook_fee_bps, pool.lp_fee_bps);
            let step = burn_step(
                cfg.obs_reserve_base,
                cfg.obs_reserve_quote,
                cfg.obs_slot,
                pool.reserve_base,
                effective_quote,
                slot,
                cap_bps,
            );
            (cfg.pool, cfg.authority_bump, cfg.burn_pot, step)
        };

        let (outcome, quote_amount, bought, obs_base, obs_quote) = match step {
            BurnStep::TooSoon => return err!(RulesError::BurnTooSoon),
            BurnStep::Observe => (BURN_OBSERVED, 0, 0, pool.reserve_base, effective_quote),
            BurnStep::Wait => (BURN_WAITED, 0, 0, pool.reserve_base, effective_quote),
            BurnStep::Buy { max_spend } => {
                let quote_amount = pot.min(max_spend);
                cpi_hook_buy_burn(ctx.accounts, &pool_key, bump, quote_amount, min_amount_out)?;
                // what left the pool's reserve of the coin is what was burned in its vault
                let after = PoolData::read(&ctx.accounts.pool.to_account_info())?;
                let bought = pool.reserve_base.saturating_sub(after.reserve_base);
                require!(bought > 0, RulesError::NothingBought);
                (BURN_BOUGHT, quote_amount, bought, after.reserve_base, after.effective_quote()?)
            }
        };

        let cfg = &mut ctx.accounts.cfg;
        if outcome == BURN_BOUGHT {
            cfg.burn_pot = cfg.burn_pot.checked_sub(quote_amount).ok_or(RulesError::MathOverflow)?;
            cfg.total_quote_burned =
                cfg.total_quote_burned.checked_add(quote_amount).ok_or(RulesError::MathOverflow)?;
            cfg.total_base_burned = cfg.total_base_burned.saturating_add(bought);
            cfg.burns = cfg.burns.saturating_add(1);
        }
        cfg.obs_slot = slot;
        cfg.obs_reserve_base = obs_base;
        cfg.obs_reserve_quote = obs_quote;
        emit_cpi!(BurnExecuted {
            pool: pool_key,
            quote_spent: quote_amount,
            base_burned: bought,
            slot,
            outcome,
            obs_reserve_base: obs_base,
            obs_reserve_quote: obs_quote,
        });
        // last: the event CPI clears return data
        set_burn_result(outcome, quote_amount, bought);
        Ok(())
    }

    // ---- for the creator ----------------------------------------------------------------

    /// Pay `creator_owed` to the quote token account the creator names.
    pub fn claim_creator(ctx: Context<ClaimCreator>) -> Result<()> {
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        let cfg = &mut ctx.accounts.cfg;
        cfg.settle(pool.hook_fees_quote_total, pool.hook_fees_owed_quote)?;
        let amount = cfg.creator_owed;
        require!(amount > 0, RulesError::NothingToClaim);
        cfg.creator_owed = 0;
        cfg.total_creator_paid =
            cfg.total_creator_paid.checked_add(amount).ok_or(RulesError::MathOverflow)?;
        let (pool_key, bump, creator) = (cfg.pool, cfg.authority_bump, cfg.creator);

        let a = &ctx.accounts;
        transfer_signed(
            &a.quote_token_program,
            &a.treasury_quote.to_account_info(),
            &a.quote_mint.to_account_info(),
            &a.creator_quote.to_account_info(),
            &a.hook_authority.to_account_info(),
            &[HOOK_AUTHORITY_SEED, pool_key.as_ref(), &[bump]],
            amount,
            a.quote_mint.decimals,
        )?;
        emit!(CreatorClaimed { pool: pool_key, creator, amount });
        Ok(())
    }

    /// Move coins from the creator's wallet to the lock vault, or move the date later.
    /// The date never moves earlier, is never before the launch plus the lock declared
    /// in the config, is always in the future and at most MAX_LOCK_SECONDS ahead.
    ///
    /// `amount == u64::MAX` (`LOCK_WHOLE_BALANCE`) locks everything `creator_base` holds
    /// when the instruction runs. A launch uses it for "what the first buy bought": the
    /// client then does not have to know that amount to the unit before the transaction
    /// lands.
    pub fn lock_creator(ctx: Context<LockCreator>, amount: u64, unlock_at: i64) -> Result<()> {
        // a strict coin locks in the creator's own wallet: `lock_creator_strict`
        require!(ctx.accounts.cfg.kind == KIND_PLAIN, RulesError::StrictCoin);
        let amount = if amount == LOCK_WHOLE_BALANCE { ctx.accounts.creator_base.amount } else { amount };
        let cfg = &ctx.accounts.cfg;
        require!(cfg.started(), RulesError::NotStarted);
        let now = Clock::get()?.unix_timestamp;
        let declared = i64::try_from(cfg.creator_lock_seconds)
            .ok()
            .and_then(|s| cfg.start_time.checked_add(s))
            .ok_or(RulesError::MathOverflow)?;
        let latest = now.checked_add(MAX_LOCK_SECONDS as i64).ok_or(RulesError::MathOverflow)?;
        let (pool_key, creator) = (cfg.pool, cfg.creator);

        let lock = &mut ctx.accounts.lock;
        let locked = lock.amount.checked_add(amount).ok_or(RulesError::MathOverflow)?;
        require!(locked > 0, RulesError::ZeroAmount);
        require!(unlock_at >= lock.unlock_at, RulesError::UnlockEarlier);
        require!(unlock_at >= declared, RulesError::UnlockBeforeDeclared);
        require!(unlock_at > now, RulesError::UnlockInPast);
        require!(unlock_at <= latest, RulesError::UnlockTooFar);
        lock.bump = ctx.bumps.lock;
        lock.pool = pool_key;
        lock.amount = locked;
        lock.unlock_at = unlock_at;

        if amount > 0 {
            let a = &ctx.accounts;
            transfer_from_wallet(
                &a.base_token_program,
                &a.creator_base.to_account_info(),
                &a.base_mint.to_account_info(),
                &a.lock_vault.to_account_info(),
                &a.creator.to_account_info(),
                amount,
                a.base_mint.decimals,
            )?;
        }
        emit!(CreatorLocked { pool: pool_key, creator, amount, locked, unlock_at });
        Ok(())
    }

    /// From `unlock_at` on: move everything in the lock vault back to the creator and
    /// zero the record.
    pub fn unlock_creator(ctx: Context<UnlockCreator>) -> Result<()> {
        require!(ctx.accounts.cfg.kind == KIND_PLAIN, RulesError::StrictCoin);
        let now = Clock::get()?.unix_timestamp;
        let amount = ctx.accounts.lock_vault.amount;
        require!(amount > 0, RulesError::NothingLocked);
        require!(now >= ctx.accounts.lock.unlock_at, RulesError::StillLocked);
        let (pool_key, bump, creator) =
            (ctx.accounts.cfg.pool, ctx.accounts.cfg.bump, ctx.accounts.cfg.creator);
        let lock = &mut ctx.accounts.lock;
        lock.amount = 0;
        lock.unlock_at = 0;

        let a = &ctx.accounts;
        transfer_signed(
            &a.base_token_program,
            &a.lock_vault.to_account_info(),
            &a.base_mint.to_account_info(),
            &a.creator_base.to_account_info(),
            &a.cfg.to_account_info(),
            &[CFG_SEED, pool_key.as_ref(), &[bump]],
            amount,
            a.base_mint.decimals,
        )?;
        emit!(CreatorUnlocked { pool: pool_key, creator, amount });
        Ok(())
    }

    // ---- the strict coin ---------------------------------------------------------------

    /// By the launcher of a strict coin, before `create_pool`, in place of
    /// `init_pool_config`. The coin must be a Token-2022 mint whose transfer hook is this
    /// program and can never be changed. The mint signs: only whoever creates the coin can
    /// bind it to its rules, and only once. Writes the rules, creates the treasury, and
    /// creates the account list Token-2022 passes to `execute` on every transfer.
    ///
    /// A strict coin has every rate of a plain coin, the burn included. Its burn runs
    /// through `run_burn_strict`. It has no burn account, no stake vault and no lock vault.
    pub fn init_strict_config(ctx: Context<InitStrictConfig>, pool: Pubkey, args: RulesArgs, strict: StrictArgs) -> Result<()> {
        check_rules(&args)?;
        check_strict(&strict)?;
        let mint = ctx.accounts.base_mint.to_account_info();
        require!(is_strict_mint(&mint), RulesError::WrongKind);
        let quote_mint = ctx.accounts.quote_mint.key();
        require_keys_eq!(pool, pool_address(mint.key, &quote_mint).0, RulesError::WrongPool);
        let cfg = &mut ctx.accounts.cfg;
        cfg.bump = ctx.bumps.cfg;
        cfg.authority_bump = ctx.bumps.hook_authority;
        cfg.pool = pool;
        cfg.base_mint = mint.key();
        cfg.quote_mint = quote_mint;
        cfg.treasury = ctx.accounts.treasury_quote.key();
        cfg.creator = ctx.accounts.payer.key();
        cfg.sniper_slots = args.sniper_slots;
        cfg.sniper_start_fee_bps = args.sniper_start_fee_bps;
        cfg.buy = args.buy;
        cfg.sell = args.sell;
        cfg.max_buy_quote = args.max_buy_quote;
        cfg.limit_slots = args.limit_slots;
        cfg.creator_lock_seconds = args.creator_lock_seconds;
        cfg.kind = KIND_STRICT;
        cfg.max_wallet_bps = strict.max_wallet_bps;
        cfg.max_wallet_slots = strict.max_wallet_slots;
        cfg.early_slots = strict.early_slots;
        cfg.early_unlock_slots = strict.early_unlock_slots;

        // Execute's accounts: 0 source, 1 mint, 2 destination, 3 authority, 4 this list,
        // then 5 the config, 6 the sender's holder record, 7 the receiver's. A holder
        // record is [holder, pool, wallet]: the pool is read from the config (byte 10),
        // the wallet from the token account's owner field (byte 32).
        let holder_of = |token_account: u8| {
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: HOLDER_SEED.to_vec() },
                    Seed::AccountData { account_index: 5, data_index: 10, length: 32 },
                    Seed::AccountData { account_index: token_account, data_index: 32, length: 32 },
                ],
                false,
                true,
            )
            .map_err(|_| InterfaceError::ExtraMetas)
        };
        let metas = [
            ExtraAccountMeta::new_with_pubkey(&cfg.key(), false, true).map_err(|_| InterfaceError::ExtraMetas)?,
            holder_of(0)?,
            holder_of(2)?,
        ];
        let mut data = ctx.accounts.validation.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<TransferHookExecute>(&mut data, &metas).map_err(|_| InterfaceError::ExtraMetas)?;
        Ok(())
    }

    /// Token-2022 calls this on every transfer of a strict coin, after the balances
    /// moved. It refuses the transfer when a rule says so, and keeps the holder records
    /// of both wallets equal to what they hold.
    ///
    /// It takes effect only in the middle of a real transfer of this coin: both token
    /// accounts must carry Token-2022's "transferring" flag, which only the token program
    /// sets, for the length of its call into the hook. It makes no CPI.
    #[instruction(discriminator = [105, 37, 101, 197, 75, 251, 102, 26])]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.cfg;
        require!(cfg.kind == KIND_STRICT, RulesError::NotATransfer);
        require_keys_eq!(ctx.accounts.mint.key(), cfg.base_mint, RulesError::NotATransfer);
        let source = ctx.accounts.source.to_account_info();
        let destination = ctx.accounts.destination.to_account_info();
        let source_holder = ctx.accounts.source_holder.to_account_info();
        let dest_holder = ctx.accounts.dest_holder.to_account_info();
        let (from, from_balance) = transfer_side(&source, &cfg.base_mint)?;
        let (to, to_balance) = transfer_side(&destination, &cfg.base_mint)?;
        // Any transfer of the coin takes the mark away. Only the pool's own payout,
        // right after `before_swap` of a buy, finds it set.
        let marked = cfg.buy_mark == 1;
        cfg.buy_mark = 0;
        let clock = Clock::get()?;
        let slot = clock.slot;

        // Who is on each side. Only the pool program signs for an account the pool owns,
        // and it only ever pays out of its vault, so a source the pool owns is the vault.
        // A destination is checked by its address.
        let from_vault = from == cfg.pool;
        let to_vault = to == cfg.pool && is_pool_vault(cfg, destination.key);

        // 1. One account per wallet: a wallet receives in its associated token account,
        //    whose owner can never be changed.
        if !to_vault {
            require_keys_eq!(*destination.key, strict_account_address(&to, &cfg.base_mint), RulesError::NotAssociatedAccount);
        }

        // 2. The sender: early coins and the creator's locked coins stay where they are.
        if !from_vault {
            let rec = holder_bytes(&source_holder, &cfg.pool, &from)?;
            if let Some(mut d) = rec {
                if cfg.early_locked(slot) {
                    require!(from_balance >= rd_u64(&d, H_EARLY), RulesError::EarlyLocked);
                }
                let locked = rd_u64(&d, H_LOCKED);
                if locked > 0 && clock.unix_timestamp < rd_u64(&d, H_LOCKED_UNTIL) as i64 {
                    require!(from_balance >= locked, RulesError::CreatorLocked);
                }
                touch_holder(cfg, &mut d, from_balance);
            }
        }

        // 3. A buy, or coins the pool pays out for another reason (liquidity taken out,
        //    protocol fees collected).
        let is_buy = from_vault && marked;

        // 4. The receiver.
        if !to_vault {
            // the max wallet holds a buy and a transfer from another wallet, never what
            // the pool pays out for a removal of liquidity
            if cfg.max_wallet_runs(slot) && (is_buy || !from_vault) {
                require!(to_balance <= cfg.max_wallet_amount, RulesError::MaxWallet);
            }
            let early_buy = is_buy && cfg.early_window_runs(slot);
            let rec = holder_bytes(&dest_holder, &cfg.pool, &to)?;
            match rec {
                Some(mut d) => {
                    if early_buy {
                        let early = rd_u64(&d, H_EARLY).saturating_add(amount);
                        d[H_EARLY..H_EARLY + 8].copy_from_slice(&early.to_le_bytes());
                    }
                    touch_holder(cfg, &mut d, to_balance);
                }
                // without a record the early coins could not be told from the others
                None => require!(!early_buy, RulesError::HolderRecordRequired),
            }
        }
        Ok(())
    }

    /// A wallet asks for its share of the holders' rate on a strict coin. Signed and paid
    /// by the wallet itself. From here on its balance counts. Opening twice does nothing.
    /// It can be opened before the pool exists.
    pub fn open_holder(ctx: Context<OpenHolder>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        let cfg = &mut ctx.accounts.cfg;
        require!(cfg.kind == KIND_STRICT, RulesError::NotStrict);
        let rec = &mut ctx.accounts.holder;
        if rec.owner != Pubkey::default() {
            return Ok(());
        }
        let balance = wallet_balance(&ctx.accounts.owner_base.to_account_info(), &owner, &cfg.base_mint)?;
        if cfg.started() {
            // the trade before this moment is split among those who held then
            let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
            cfg.settle(pool.hook_fees_quote_total, pool.hook_fees_owed_quote)?;
        }
        rec.bump = ctx.bumps.holder;
        rec.pool = cfg.pool;
        rec.owner = owner;
        rec.balance = balance;
        rec.acc_snapshot = cfg.acc_per_share;
        cfg.total_staked = cfg.total_staked.checked_add(balance).ok_or(RulesError::MathOverflow)?;
        emit!(HolderOpened { pool: cfg.pool, owner, balance });
        Ok(())
    }

    /// Pay a holder what it is owed, in the quote token, to the token account it names.
    pub fn claim_holder(ctx: Context<ClaimHolder>) -> Result<()> {
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        let owner = ctx.accounts.owner.key();
        let cfg = &mut ctx.accounts.cfg;
        cfg.settle(pool.hook_fees_quote_total, pool.hook_fees_owed_quote)?;
        let rec = &mut ctx.accounts.holder;
        cfg.accrue_holder(rec)?;
        let amount = rec.owed;
        require!(amount > 0, RulesError::NothingToClaim);
        rec.owed = 0;
        cfg.rewards_owed_total = cfg.rewards_owed_total.checked_sub(amount).ok_or(RulesError::MathOverflow)?;
        cfg.total_rewards_paid = cfg.total_rewards_paid.checked_add(amount).ok_or(RulesError::MathOverflow)?;
        let (pool_key, bump) = (cfg.pool, cfg.authority_bump);

        let a = &ctx.accounts;
        transfer_signed(
            &a.quote_token_program,
            &a.treasury_quote.to_account_info(),
            &a.quote_mint.to_account_info(),
            &a.owner_quote.to_account_info(),
            &a.hook_authority.to_account_info(),
            &[HOOK_AUTHORITY_SEED, pool_key.as_ref(), &[bump]],
            amount,
            a.quote_mint.decimals,
        )?;
        emit!(HolderClaimed { pool: pool_key, owner, amount });
        Ok(())
    }

    /// Anyone: lower a holder record to what the wallet really holds. A token Burn does
    /// not call a transfer hook, so after a burn a record stands above the balance until
    /// the wallet's next transfer, or until somebody sends this. It never raises a record.
    pub fn sync_holder(ctx: Context<SyncHolder>) -> Result<()> {
        let cfg = &mut ctx.accounts.cfg;
        let rec = &mut ctx.accounts.holder;
        let real = wallet_balance(&ctx.accounts.owner_base.to_account_info(), &rec.owner, &cfg.base_mint)?;
        if cfg.started() {
            let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
            cfg.settle(pool.hook_fees_quote_total, pool.hook_fees_owed_quote)?;
        }
        if real < rec.balance {
            cfg.accrue_holder(rec)?;
            cfg.total_staked = cfg.total_staked.checked_sub(rec.balance - real).ok_or(RulesError::MathOverflow)?;
            rec.balance = real;
        }
        emit!(HolderSynced { pool: cfg.pool, owner: rec.owner, balance: rec.balance });
        Ok(())
    }

    /// Close a holder record that holds nothing and get its rent back: no coins, nothing
    /// owed, nothing locked, and no early coins still under their lock.
    pub fn close_holder(ctx: Context<CloseHolder>) -> Result<()> {
        let cfg = &ctx.accounts.cfg;
        let rec = &ctx.accounts.holder;
        let slot = Clock::get()?.slot;
        require!(
            rec.balance == 0 && rec.owed == 0 && rec.locked == 0 && (rec.early_bought == 0 || !cfg.early_locked(slot)),
            RulesError::HolderNotEmpty
        );
        emit!(HolderClosed { pool: cfg.pool, owner: rec.owner });
        Ok(())
    }

    /// The creator lock of a strict coin. The coins stay in the creator's own wallet and
    /// the transfer hook refuses every transfer that would leave it with less than the
    /// locked amount before `unlock_at`. (A vault, as on a plain coin, is impossible here:
    /// this program would have to move the coin, and the token program would call this
    /// program's own `execute` from inside that instruction.) The creator needs a holder
    /// record. The rules of `lock_creator` hold: more coins or a later date, never an
    /// earlier one; `amount == u64::MAX` locks everything the wallet holds.
    pub fn lock_creator_strict(ctx: Context<LockCreatorStrict>, amount: u64, unlock_at: i64) -> Result<()> {
        let cfg = &ctx.accounts.cfg;
        require!(cfg.kind == KIND_STRICT, RulesError::NotStrict);
        require!(cfg.started(), RulesError::NotStarted);
        let now = Clock::get()?.unix_timestamp;
        let declared = i64::try_from(cfg.creator_lock_seconds)
            .ok()
            .and_then(|s| cfg.start_time.checked_add(s))
            .ok_or(RulesError::MathOverflow)?;
        let latest = now.checked_add(MAX_LOCK_SECONDS as i64).ok_or(RulesError::MathOverflow)?;
        let (pool_key, creator) = (cfg.pool, cfg.creator);
        let balance = wallet_balance(&ctx.accounts.creator_base.to_account_info(), &creator, &cfg.base_mint)?;

        let lock = &mut ctx.accounts.lock;
        let locked = if amount == LOCK_WHOLE_BALANCE {
            balance.max(lock.amount)
        } else {
            lock.amount.checked_add(amount).ok_or(RulesError::MathOverflow)?
        };
        let added = locked - lock.amount;
        require!(locked > 0, RulesError::ZeroAmount);
        require!(locked <= balance, RulesError::LockAboveBalance);
        require!(unlock_at >= lock.unlock_at, RulesError::UnlockEarlier);
        require!(unlock_at >= declared, RulesError::UnlockBeforeDeclared);
        require!(unlock_at > now, RulesError::UnlockInPast);
        require!(unlock_at <= latest, RulesError::UnlockTooFar);
        lock.bump = ctx.bumps.lock;
        lock.pool = pool_key;
        lock.amount = locked;
        lock.unlock_at = unlock_at;
        let rec = &mut ctx.accounts.holder;
        rec.locked = locked;
        rec.locked_until = unlock_at;
        emit!(CreatorLocked { pool: pool_key, creator, amount: added, locked, unlock_at });
        Ok(())
    }

    /// From `unlock_at` on: zero the creator lock of a strict coin. The coins were free
    /// from that moment already; this clears the record.
    pub fn unlock_creator_strict(ctx: Context<UnlockCreatorStrict>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let amount = ctx.accounts.lock.amount;
        require!(amount > 0, RulesError::NothingLocked);
        require!(now >= ctx.accounts.lock.unlock_at, RulesError::StillLocked);
        let (pool_key, creator) = (ctx.accounts.cfg.pool, ctx.accounts.cfg.creator);
        let lock = &mut ctx.accounts.lock;
        lock.amount = 0;
        lock.unlock_at = 0;
        let rec = &mut ctx.accounts.holder;
        rec.locked = 0;
        rec.locked_until = 0;
        emit!(CreatorUnlocked { pool: pool_key, creator, amount });
        Ok(())
    }
}

// ---- CPI helpers, each in its own stack frame -----------------------------------------

/// A transfer the wallet signs itself.
#[inline(never)]
fn transfer_from_wallet<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    wallet: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: wallet.clone(),
            },
        ),
        amount,
        decimals,
    )
}

/// A transfer out of an account this program signs for. `seeds` are those of the PDA that
/// owns it: the hook authority for the treasury, the config for the two vaults.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn transfer_signed<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
    decimals: u8,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: owner.clone(),
            },
            &[seeds],
        ),
        amount,
        decimals,
    )
}

#[inline(never)]
fn cpi_hook_swap(
    a: &RunBurn,
    pool: &Pubkey,
    authority_bump: u8,
    quote_amount: u64,
    min_amount_out: u64,
) -> Result<()> {
    let bump = [authority_bump];
    let seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, pool.as_ref(), &bump];
    let accounts = hookpool::cpi::accounts::HookSwap {
        hook_authority: a.hook_authority.to_account_info(),
        platform: a.platform.to_account_info(),
        pool: a.pool.to_account_info(),
        base_mint: a.base_mint.to_account_info(),
        quote_mint: a.quote_mint.to_account_info(),
        base_vault: a.base_vault.to_account_info(),
        quote_vault: a.quote_vault.to_account_info(),
        hook_base: a.authority_base.to_account_info(),
        hook_quote: a.treasury_quote.to_account_info(),
        base_token_program: a.base_token_program.to_account_info(),
        quote_token_program: a.quote_token_program.to_account_info(),
        event_authority: a.hookpool_event_authority.to_account_info(),
        program: a.hookpool_program.to_account_info(),
    };
    hookpool::cpi::hook_swap(
        CpiContext::new_with_signer(a.hookpool_program.key(), accounts, &[seeds]),
        DIRECTION_BUY,
        quote_amount,
        min_amount_out,
        authority_bump,
    )?;
    Ok(())
}

#[inline(never)]
fn cpi_burn(a: &RunBurn, pool: &Pubkey, authority_bump: u8, amount: u64) -> Result<()> {
    let bump = [authority_bump];
    let seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, pool.as_ref(), &bump];
    token_interface::burn(
        CpiContext::new_with_signer(
            a.base_token_program.key(),
            Burn {
                mint: a.base_mint.to_account_info(),
                from: a.authority_base.to_account_info(),
                authority: a.hook_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

// ---- account lists --------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitManifest<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: this program's ProgramData, parsed in the handler.
    pub program_data: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + HookManifest::INIT_SPACE, seeds = [MANIFEST_SEED], bump)]
    pub manifest: Account<'info, HookManifest>,
    /// CHECK: raw TLV account, written by the handler.
    #[account(init, payer = authority, space = extra_metas_size(1).unwrap(), seeds = [EXTRA_METAS_SEED], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool: Pubkey)]
pub struct InitPoolConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + RulesConfig::INIT_SPACE, seeds = [CFG_SEED, pool.as_ref()], bump)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: PDA that owns the treasury and the burn account and signs hook_swap. Holds
    /// no data. The pool's `hook_swap` can spend only from accounts of this PDA, which is
    /// why the two vaults do NOT belong to it: they belong to the config.
    #[account(seeds = [HOOK_AUTHORITY_SEED, pool.as_ref()], bump)]
    pub hook_authority: UncheckedAccount<'info>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// `init_if_needed`: anyone can create an associated token account for any owner, and
    /// a plain `init` would let a stranger block this instruction by creating one of these
    /// two first. An account that is already there is the same account: its owner is the
    /// authority, and the mint and the owner are checked.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = quote_mint,
        associated_token::authority = hook_authority,
        associated_token::token_program = quote_token_program
    )]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = base_mint,
        associated_token::authority = hook_authority,
        associated_token::token_program = base_token_program
    )]
    pub authority_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        seeds = [STAKE_VAULT_SEED, pool.as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = cfg,
        token::token_program = base_token_program
    )]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// The fixed five accounts every callback receives, then the config.
///
/// The config is checked by its `pool` field, not by deriving its address again: an
/// account owned by this program with the config's discriminator was created by
/// `init_pool_config` at ["cfg", cfg.pool], so `cfg.pool == pool` proves the address. The
/// pool program has derived the same address from the extra-accounts list already.
#[derive(Accounts)]
pub struct Callback<'info> {
    /// CHECK: the Pool account; read with PoolData::read.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: verified against the pool program's caller PDA in the handler.
    pub hook_caller: Signer<'info>,
    /// CHECK: the trader.
    pub user: UncheckedAccount<'info>,
    /// CHECK: quote mint.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: base mint.
    pub base_mint: UncheckedAccount<'info>,
    #[account(mut, constraint = cfg.pool == pool.key() @ RulesError::WrongPool)]
    pub cfg: Box<Account<'info, RulesConfig>>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = base_mint @ RulesError::WrongMints)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: the Pool account; read with PoolData::read.
    #[account(address = cfg.pool @ RulesError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + StakeRecord::INIT_SPACE,
        seeds = [STAKE_SEED, cfg.pool.as_ref(), staker.key().as_ref()],
        bump
    )]
    pub stake: Box<Account<'info, StakeRecord>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [STAKE_VAULT_SEED, cfg.pool.as_ref()], bump)]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The coins to stake. The token program checks that `staker` may spend it.
    #[account(mut, token::mint = base_mint)]
    pub staker_base: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    pub staker: Signer<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = base_mint @ RulesError::WrongMints)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: the Pool account; read with PoolData::read.
    #[account(address = cfg.pool @ RulesError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, seeds = [STAKE_SEED, cfg.pool.as_ref(), staker.key().as_ref()], bump = stake.bump)]
    pub stake: Box<Account<'info, StakeRecord>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Owned by the config, which signs the transfer.
    #[account(mut, seeds = [STAKE_VAULT_SEED, cfg.pool.as_ref()], bump)]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Where the coins go. Any token account of the coin the staker names.
    #[account(mut, token::mint = base_mint)]
    pub staker_base: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    pub staker: Signer<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = quote_mint @ RulesError::WrongMints)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: the Pool account; read with PoolData::read.
    #[account(address = cfg.pool @ RulesError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, seeds = [STAKE_SEED, cfg.pool.as_ref(), staker.key().as_ref()], bump = stake.bump)]
    pub stake: Box<Account<'info, StakeRecord>>,
    /// CHECK: PDA signer, checked by seeds.
    #[account(seeds = [HOOK_AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub hook_authority: UncheckedAccount<'info>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = cfg.treasury @ RulesError::WrongTreasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Where the rewards go. Any token account of the quote mint the staker names.
    #[account(mut, token::mint = quote_mint)]
    pub staker_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimCreator<'info> {
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [CFG_SEED, cfg.pool.as_ref()],
        bump = cfg.bump,
        has_one = creator @ RulesError::NotCreator,
        has_one = quote_mint @ RulesError::WrongMints
    )]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: the Pool account; read with PoolData::read.
    #[account(address = cfg.pool @ RulesError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: PDA signer, checked by seeds.
    #[account(seeds = [HOOK_AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub hook_authority: UncheckedAccount<'info>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = cfg.treasury @ RulesError::WrongTreasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Where the fee goes. Any token account of the quote mint the creator names.
    #[account(mut, token::mint = quote_mint)]
    pub creator_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct RunBurn<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [CFG_SEED, cfg.pool.as_ref()],
        bump = cfg.bump,
        has_one = base_mint @ RulesError::WrongMints,
        has_one = quote_mint @ RulesError::WrongMints
    )]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: PDA signer, checked by seeds.
    #[account(seeds = [HOOK_AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub hook_authority: UncheckedAccount<'info>,
    /// The platform: its protocol fee and its hook fee cap decide how much a run may spend.
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, seeds::program = hookpool::ID)]
    pub platform: Box<Account<'info, Platform>>,
    /// CHECK: read with PoolData::read, validated by the pool program.
    #[account(mut, address = cfg.pool @ RulesError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: validated by the pool program.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    #[account(mut, address = cfg.treasury @ RulesError::WrongTreasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The burn account: the authority's ASSOCIATED token account of the coin and no
    /// other, because everything in this account is burned. (The stake vault and the lock
    /// vault belong to the config, not to this authority, so they could not pass here or
    /// in the pool's `hook_swap` in any case.)
    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = hook_authority,
        associated_token::token_program = base_token_program
    )]
    pub authority_base: Box<InterfaceAccount<'info, TokenAccount>>,
    pub hookpool_program: Program<'info, Hookpool>,
    /// CHECK: hookpool's event authority PDA, validated by hookpool itself.
    pub hookpool_event_authority: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct LockCreator<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        seeds = [CFG_SEED, cfg.pool.as_ref()],
        bump = cfg.bump,
        has_one = creator @ RulesError::NotCreator,
        has_one = base_mint @ RulesError::WrongMints
    )]
    pub cfg: Box<Account<'info, RulesConfig>>,
    #[account(
        init_if_needed,
        payer = creator,
        space = 8 + LockRecord::INIT_SPACE,
        seeds = [LOCK_SEED, cfg.pool.as_ref()],
        bump
    )]
    pub lock: Box<Account<'info, LockRecord>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Owned by the config. Created by the first lock.
    #[account(
        init_if_needed,
        payer = creator,
        seeds = [LOCK_VAULT_SEED, cfg.pool.as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = cfg,
        token::token_program = base_token_program
    )]
    pub lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The coins to lock. The token program checks that `creator` may spend it.
    #[account(mut, token::mint = base_mint)]
    pub creator_base: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnlockCreator<'info> {
    pub creator: Signer<'info>,
    #[account(
        seeds = [CFG_SEED, cfg.pool.as_ref()],
        bump = cfg.bump,
        has_one = creator @ RulesError::NotCreator,
        has_one = base_mint @ RulesError::WrongMints
    )]
    pub cfg: Box<Account<'info, RulesConfig>>,
    #[account(mut, seeds = [LOCK_SEED, cfg.pool.as_ref()], bump = lock.bump)]
    pub lock: Box<Account<'info, LockRecord>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Owned by the config, which signs the transfer.
    #[account(mut, seeds = [LOCK_VAULT_SEED, cfg.pool.as_ref()], bump)]
    pub lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Where the coins go. Any token account of the coin the creator names.
    #[account(mut, token::mint = base_mint)]
    pub creator_base: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
}

// ---- the strict coin: reading Token-2022 accounts by hand ------------------------------

/// Token-2022 extension types (u16) this program reads by hand.
const EXT_TRANSFER_HOOK: u16 = 14;
const EXT_TRANSFER_HOOK_ACCOUNT: u16 = 15;
/// Token-2022 puts the account type at byte 165 (1 mint, 2 token account), then TLV entries.
const T22_ACCOUNT_TYPE: usize = 165;
/// Token-2022 gives a multisig exactly this many bytes, and whoever creates a multisig
/// chooses its contents. Like the token program itself, never read an account of this
/// length as a mint or a token account.
const T22_MULTISIG_LEN: usize = 355;

// Byte offsets in a HolderRecord account, for `execute`, which reads the two records as
// raw bytes because either may not exist.
const H_POOL: usize = 9;
const H_OWNER: usize = 41;
const H_BALANCE: usize = 73;
const H_SNAPSHOT: usize = 81;
const H_OWED: usize = 97;
const H_EARLY: usize = 105;
const H_LOCKED: usize = 113;
const H_LOCKED_UNTIL: usize = 121;

fn rd_u64(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}

/// The value of a Token-2022 extension in a mint or token account, if it has it.
fn t22_extension(data: &[u8], kind: u16) -> Option<&[u8]> {
    let mut i = T22_ACCOUNT_TYPE + 1;
    while i + 4 <= data.len() {
        let t = u16::from_le_bytes([data[i], data[i + 1]]);
        let len = u16::from_le_bytes([data[i + 2], data[i + 3]]) as usize;
        if t == 0 || i + 4 + len > data.len() {
            return None;
        }
        if t == kind {
            return Some(&data[i + 4..i + 4 + len]);
        }
        i += 4 + len;
    }
    None
}

/// Do these bytes of an account Token-2022 owns say: a mint whose transfer hook is this
/// program, with no authority left that could point it elsewhere?
fn strict_mint_bytes(d: &[u8]) -> bool {
    if d.len() <= T22_ACCOUNT_TYPE || d.len() == T22_MULTISIG_LEN || d[T22_ACCOUNT_TYPE] != 1 {
        return false;
    }
    matches!(t22_extension(d, EXT_TRANSFER_HOOK), Some(e) if e.len() == 64 && e[..32] == [0u8; 32] && e[32..] == crate::ID.to_bytes())
}

/// Is this mint a strict coin: a Token-2022 mint whose transfer hook is this program, forever?
pub fn is_strict_mint(mint: &AccountInfo) -> bool {
    if *mint.owner != anchor_spl::token_2022::ID {
        return false;
    }
    let Ok(d) = mint.try_borrow_data() else { return false };
    strict_mint_bytes(&d)
}

/// (owning wallet, balance) when these bytes of an account Token-2022 owns are a token
/// account of `mint`. With `transferring`, only in the middle of a transfer.
fn token_account_bytes(d: &[u8], mint: &Pubkey, transferring: bool) -> Option<(Pubkey, u64)> {
    if d.len() <= T22_ACCOUNT_TYPE || d.len() == T22_MULTISIG_LEN || d[T22_ACCOUNT_TYPE] != 2 || d[0..32] != mint.to_bytes() {
        return None;
    }
    if transferring && !matches!(t22_extension(d, EXT_TRANSFER_HOOK_ACCOUNT), Some(f) if !f.is_empty() && f[0] == 1) {
        return None;
    }
    Some((Pubkey::new_from_array(d[32..64].try_into().unwrap()), rd_u64(d, 64)))
}

/// One side of a transfer in progress: the wallet that owns the token account and what it
/// holds now. Fails unless the account is a token account of this coin with Token-2022's
/// "transferring" flag set.
fn transfer_side(account: &AccountInfo, mint: &Pubkey) -> Result<(Pubkey, u64)> {
    require_keys_eq!(*account.owner, anchor_spl::token_2022::ID, RulesError::NotATransfer);
    let d = account.try_borrow_data()?;
    token_account_bytes(&d, mint, true).ok_or_else(|| error!(RulesError::NotATransfer))
}

/// What `wallet` holds of a strict coin: the balance of its associated token account,
/// zero when that account does not exist. Fails when `account` is another address.
fn wallet_balance(account: &AccountInfo, wallet: &Pubkey, mint: &Pubkey) -> Result<u64> {
    require_keys_eq!(*account.key, strict_account_address(wallet, mint), RulesError::WrongHolder);
    if *account.owner != anchor_spl::token_2022::ID {
        return Ok(0);
    }
    let d = account.try_borrow_data()?;
    match token_account_bytes(&d, mint, false) {
        Some((owner, amount)) if owner == *wallet => Ok(amount),
        _ => err!(RulesError::WrongHolder),
    }
}

/// Is `key` the pool's vault of the coin? Once the pool exists the bump is in the config
/// and one hash answers; before that (the transfer that fills the vault when the pool is
/// created) the address is searched for.
fn is_pool_vault(cfg: &RulesConfig, key: &Pubkey) -> bool {
    if cfg.started() {
        Pubkey::create_program_address(&[VAULT_SEED, cfg.pool.as_ref(), cfg.base_mint.as_ref(), &[cfg.vault_bump]], &hookpool_interface::ID)
            .map(|vault| vault == *key)
            .unwrap_or(false)
    } else {
        vault_address(&cfg.pool, &cfg.base_mint).0 == *key
    }
}

/// The bytes of the holder record of `owner` on `pool`, when `account` is one. Records are
/// only ever created by this program at their PDA, so the contents are proof enough.
fn holder_bytes<'a, 'info>(account: &'a AccountInfo<'info>, pool: &Pubkey, owner: &Pubkey) -> Result<Option<std::cell::RefMut<'a, &'info mut [u8]>>> {
    if *account.owner != crate::ID {
        return Ok(None);
    }
    let d = account.try_borrow_mut_data()?;
    let ours = d.len() == 8 + HolderRecord::INIT_SPACE
        && d[..8] == *HolderRecord::DISCRIMINATOR
        && d[H_POOL..H_POOL + 32] == pool.to_bytes()
        && d[H_OWNER..H_OWNER + 32] == owner.to_bytes();
    Ok(if ours { Some(d) } else { None })
}

/// Bring a holder record up to date inside a transfer: what its old balance earned goes
/// into `owed`, then the balance becomes what the wallet holds now.
///
/// This runs inside every transfer, every sell included, so it cannot fail: none of its
/// arithmetic can overflow with numbers a coin can reach, and where a checked operation
/// would return an error it stops at the limit instead. A rule may refuse a transfer;
/// bookkeeping never does.
fn touch_holder(cfg: &mut RulesConfig, d: &mut [u8], new_balance: u64) {
    let balance = rd_u64(d, H_BALANCE);
    let snapshot = u128::from_le_bytes(d[H_SNAPSHOT..H_SNAPSHOT + 16].try_into().unwrap());
    let delta = cfg.acc_per_share.saturating_sub(snapshot);
    let pending = u64::try_from((balance as u128).saturating_mul(delta) / ACC_SCALE).unwrap_or(u64::MAX);
    if pending > 0 {
        let owed = rd_u64(d, H_OWED).saturating_add(pending);
        d[H_OWED..H_OWED + 8].copy_from_slice(&owed.to_le_bytes());
        cfg.rewards_owed_total = cfg.rewards_owed_total.saturating_add(pending);
    }
    d[H_SNAPSHOT..H_SNAPSHOT + 16].copy_from_slice(&cfg.acc_per_share.to_le_bytes());
    d[H_BALANCE..H_BALANCE + 8].copy_from_slice(&new_balance.to_le_bytes());
    cfg.total_staked = cfg.total_staked.saturating_sub(balance).saturating_add(new_balance);
}

/// The buy of `run_burn_strict` through the pool's `hook_buy_burn`. In its own stack frame.
#[inline(never)]
fn cpi_hook_buy_burn(a: &RunBurnStrict, pool: &Pubkey, authority_bump: u8, quote_amount: u64, min_amount_out: u64) -> Result<()> {
    let bump = [authority_bump];
    let seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, pool.as_ref(), &bump];
    let accounts = hookpool::cpi::accounts::HookBuyBurn {
        hook_authority: a.hook_authority.to_account_info(),
        platform: a.platform.to_account_info(),
        pool: a.pool.to_account_info(),
        base_mint: a.base_mint.to_account_info(),
        quote_mint: a.quote_mint.to_account_info(),
        base_vault: a.base_vault.to_account_info(),
        quote_vault: a.quote_vault.to_account_info(),
        hook_quote: a.treasury_quote.to_account_info(),
        base_token_program: a.base_token_program.to_account_info(),
        quote_token_program: a.quote_token_program.to_account_info(),
        event_authority: a.hookpool_event_authority.to_account_info(),
        program: a.hookpool_program.to_account_info(),
    };
    hookpool::cpi::hook_buy_burn(CpiContext::new_with_signer(a.hookpool_program.key(), accounts, &[seeds]), quote_amount, min_amount_out, authority_bump)?;
    Ok(())
}

// ---- the strict coin: accounts ----------------------------------------------------------

#[derive(Accounts)]
#[instruction(pool: Pubkey)]
pub struct InitStrictConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The coin. It signs, so only whoever creates the mint can bind it to its rules.
    pub base_mint: Signer<'info>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = payer, space = 8 + RulesConfig::INIT_SPACE, seeds = [CFG_SEED, pool.as_ref()], bump)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: PDA that owns the treasury. Holds no data.
    #[account(seeds = [HOOK_AUTHORITY_SEED, pool.as_ref()], bump)]
    pub hook_authority: UncheckedAccount<'info>,
    /// `init_if_needed` for the reason given at `InitPoolConfig`.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = quote_mint,
        associated_token::authority = hook_authority,
        associated_token::token_program = quote_token_program
    )]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: raw TLV account, written by the handler. Token-2022 reads it at this address.
    #[account(init, payer = payer, space = ExtraAccountMetaList::size_of(3).unwrap(), seeds = [TRANSFER_HOOK_METAS_SEED, base_mint.key().as_ref()], bump)]
    pub validation: UncheckedAccount<'info>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// The transfer hook interface: source, mint, destination, authority, the account list,
/// then the accounts that list names. Token-2022 passes the first four read-only.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: the token account the coins left; checked in the handler.
    pub source: UncheckedAccount<'info>,
    /// CHECK: the coin; checked against the config.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the token account the coins reached; checked in the handler.
    pub destination: UncheckedAccount<'info>,
    /// CHECK: owner or delegate of the source. Not used: the rules follow the wallet that
    /// owns the token account, whoever signs.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: this hook's account list. Not used: the transferring flag proves the caller.
    pub validation: UncheckedAccount<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: the sender's holder record; may not exist. Checked by its contents.
    #[account(mut)]
    pub source_holder: UncheckedAccount<'info>,
    /// CHECK: the receiver's holder record; may not exist. Checked by its contents.
    #[account(mut)]
    pub dest_holder: UncheckedAccount<'info>,
}

/// `RunBurn` without the burn account: a strict coin has none.
#[event_cpi]
#[derive(Accounts)]
pub struct RunBurnStrict<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [CFG_SEED, cfg.pool.as_ref()],
        bump = cfg.bump,
        has_one = base_mint @ RulesError::WrongMints,
        has_one = quote_mint @ RulesError::WrongMints
    )]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: PDA signer, checked by seeds.
    #[account(seeds = [HOOK_AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub hook_authority: UncheckedAccount<'info>,
    /// The platform: its protocol fee and its hook fee cap decide how much a run may spend.
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, seeds::program = hookpool::ID)]
    pub platform: Box<Account<'info, Platform>>,
    /// CHECK: read with PoolData::read, validated by the pool program.
    #[account(mut, address = cfg.pool @ RulesError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    /// Writable: the burn lowers the supply.
    #[account(mut)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: validated by the pool program.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    #[account(mut, address = cfg.treasury @ RulesError::WrongTreasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub hookpool_program: Program<'info, Hookpool>,
    /// CHECK: hookpool's event authority PDA, validated by hookpool itself.
    pub hookpool_event_authority: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct OpenHolder<'info> {
    /// The wallet. It signs and pays: nobody registers somebody else.
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: the Pool account; read with PoolData::read once the pool exists.
    #[account(address = cfg.pool @ RulesError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + HolderRecord::INIT_SPACE,
        seeds = [HOLDER_SEED, cfg.pool.as_ref(), owner.key().as_ref()],
        bump
    )]
    pub holder: Box<Account<'info, HolderRecord>>,
    /// CHECK: the wallet's associated token account of the coin; it may not exist yet.
    /// Its address is checked in the handler.
    pub owner_base: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimHolder<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = quote_mint @ RulesError::WrongMints)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: the Pool account; read with PoolData::read.
    #[account(address = cfg.pool @ RulesError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, seeds = [HOLDER_SEED, cfg.pool.as_ref(), owner.key().as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, HolderRecord>>,
    /// CHECK: PDA signer, checked by seeds.
    #[account(seeds = [HOOK_AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub hook_authority: UncheckedAccount<'info>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = cfg.treasury @ RulesError::WrongTreasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Where the rewards go. Any token account of the quote mint the holder names.
    #[account(mut, token::mint = quote_mint)]
    pub owner_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SyncHolder<'info> {
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    /// CHECK: the Pool account; read with PoolData::read once the pool exists.
    #[account(address = cfg.pool @ RulesError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, seeds = [HOLDER_SEED, cfg.pool.as_ref(), holder.owner.as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, HolderRecord>>,
    /// CHECK: the associated token account of the record's wallet; its address is checked
    /// in the handler.
    pub owner_base: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseHolder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    #[account(mut, close = owner, seeds = [HOLDER_SEED, cfg.pool.as_ref(), owner.key().as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, HolderRecord>>,
}

#[derive(Accounts)]
pub struct LockCreatorStrict<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = creator @ RulesError::NotCreator)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    #[account(
        init_if_needed,
        payer = creator,
        space = 8 + LockRecord::INIT_SPACE,
        seeds = [LOCK_SEED, cfg.pool.as_ref()],
        bump
    )]
    pub lock: Box<Account<'info, LockRecord>>,
    #[account(mut, seeds = [HOLDER_SEED, cfg.pool.as_ref(), creator.key().as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, HolderRecord>>,
    /// CHECK: the creator's associated token account of the coin; its address is checked
    /// in the handler.
    pub creator_base: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnlockCreatorStrict<'info> {
    pub creator: Signer<'info>,
    #[account(seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = creator @ RulesError::NotCreator)]
    pub cfg: Box<Account<'info, RulesConfig>>,
    #[account(mut, seeds = [LOCK_SEED, cfg.pool.as_ref()], bump = lock.bump)]
    pub lock: Box<Account<'info, LockRecord>>,
    #[account(mut, seeds = [HOLDER_SEED, cfg.pool.as_ref(), creator.key().as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, HolderRecord>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> RulesConfig {
        RulesConfig {
            bump: 0,
            authority_bump: 0,
            pool: Pubkey::default(),
            base_mint: Pubkey::default(),
            quote_mint: Pubkey::default(),
            treasury: Pubkey::default(),
            creator: Pubkey::default(),
            sniper_slots: 0,
            sniper_start_fee_bps: 0,
            buy: Rates::default(),
            sell: Rates::default(),
            max_buy_quote: 0,
            limit_slots: 0,
            creator_lock_seconds: 0,
            start_slot: 0,
            start_time: 0,
            min_eligible: 0,
            fees_seen: 0,
            last_split: Rates::default(),
            creator_owed: 0,
            burn_pot: 0,
            acc_per_share: 0,
            reward_rem: 0,
            total_staked: 0,
            rewards_owed_total: 0,
            total_creator_paid: 0,
            total_rewards_paid: 0,
            total_quote_burned: 0,
            total_base_burned: 0,
            burns: 0,
            obs_slot: 0,
            obs_reserve_base: 0,
            obs_reserve_quote: 0,
            kind: 0,
            buy_mark: 0,
            vault_bump: 0,
            max_wallet_bps: 0,
            early_slots: 0,
            max_wallet_slots: 0,
            early_unlock_slots: 0,
            max_wallet_amount: 0,
            reserved: [0u8; 17],
        }
    }

    fn rec(amount: u64, snapshot: u128) -> StakeRecord {
        StakeRecord {
            bump: 0,
            pool: Pubkey::default(),
            staker: Pubkey::default(),
            amount,
            acc_snapshot: snapshot,
            owed: 0,
            since_slot: 0,
        }
    }

    fn rates(c: u16, h: u16, b: u16) -> Rates {
        Rates { creator_bps: c, holders_bps: h, burn_bps: b }
    }

    #[test]
    fn sniper_fee_is_the_launch_guard_line() {
        assert_eq!(sniper_fee(100, 100, 100, 3_000, 100), Some(3_000));
        assert_eq!(sniper_fee(150, 100, 100, 3_000, 100), Some(1_550));
        assert_eq!(sniper_fee(199, 100, 100, 3_000, 100), Some(129));
        assert_eq!(sniper_fee(200, 100, 100, 3_000, 100), None);
        assert_eq!(sniper_fee(100, 100, 0, 3_000, 100), None);
        assert_eq!(sniper_fee(100, 100, 100, 100, 100), None);
        assert_eq!(sniper_fee(100, 100, 100, 50, 100), None);
        // a slot before the start counts as the start
        assert_eq!(sniper_fee(50, 100, 100, 3_000, 100), Some(3_000));
    }

    #[test]
    fn split_rounds_down_and_the_burn_pot_takes_the_rest() {
        assert_eq!(split(1_000, &rates(100, 200, 100)).unwrap(), (250, 500, 250));
        assert_eq!(split(999, &rates(100, 200, 100)).unwrap(), (249, 499, 251));
        assert_eq!(split(1, &rates(100, 200, 100)).unwrap(), (0, 0, 1));
        assert_eq!(split(7, &rates(1, 1, 0)).unwrap(), (3, 3, 1), "the odd unit goes to the burn pot");
        assert_eq!(split(7, &rates(0, 0, 0)).unwrap(), (0, 0, 7), "no rate: all to the burn pot");
        assert_eq!(split(u64::MAX, &rates(500, 500, 0)).unwrap(), (u64::MAX / 2, u64::MAX / 2, 1));
        let (c, h, b) = split(u64::MAX, &rates(333, 333, 334)).unwrap();
        assert_eq!(c as u128 + h as u128 + b as u128, u64::MAX as u128);
    }

    #[test]
    fn settle_splits_once_and_carries_the_remainder() {
        let mut c = blank();
        c.last_split = rates(100, 200, 100);
        c.total_staked = 3;
        c.settle(1_000, 0).unwrap();
        assert_eq!((c.creator_owed, c.burn_pot, c.fees_seen), (250, 250, 1_000));
        // 500 * 1e12 / 3
        assert_eq!(c.acc_per_share, 166_666_666_666_666);
        assert_eq!(c.reward_rem, 2);
        // the same counter again changes nothing
        let before = (c.creator_owed, c.burn_pot, c.acc_per_share, c.reward_rem);
        c.settle(1_000, 0).unwrap();
        assert_eq!(before, (c.creator_owed, c.burn_pot, c.acc_per_share, c.reward_rem));
        // the remainder joins the next division: (500e12 + 2) / 3
        c.settle(2_000, 0).unwrap();
        assert_eq!(c.acc_per_share, 166_666_666_666_666 + 166_666_666_666_667);
        assert_eq!(c.reward_rem, 1);
    }

    #[test]
    fn settle_never_counts_what_the_pool_still_owes_and_never_goes_back() {
        let mut c = blank();
        c.last_split = rates(100, 0, 0);
        c.settle(1_000, 400).unwrap();
        assert_eq!((c.fees_seen, c.creator_owed), (600, 600));
        // the pool pays what it owed together with a new fee
        c.settle(1_500, 0).unwrap();
        assert_eq!((c.fees_seen, c.creator_owed), (1_500, 1_500));
        // a counter that went backwards is ignored, it does not fail
        c.settle(100, 0).unwrap();
        assert_eq!((c.fees_seen, c.creator_owed), (1_500, 1_500));
        c.settle(0, 500).unwrap();
        assert_eq!((c.fees_seen, c.creator_owed), (1_500, 1_500));
    }

    #[test]
    fn settle_sends_orphan_fees_to_the_burn_pot() {
        // no rate recorded
        let mut c = blank();
        c.settle(77, 0).unwrap();
        assert_eq!((c.creator_owed, c.burn_pot, c.acc_per_share), (0, 77, 0));
        // a holders' part with nothing staked
        let mut c = blank();
        c.last_split = rates(100, 100, 0);
        c.settle(100, 0).unwrap();
        assert_eq!((c.creator_owed, c.burn_pot, c.acc_per_share), (50, 50, 0));
    }

    #[test]
    fn settle_and_accrue_hold_at_the_extremes() {
        // the largest fee over the smallest stake
        let mut c = blank();
        c.last_split = rates(0, 500, 0);
        c.total_staked = 1;
        c.settle(u64::MAX, 0).unwrap();
        assert_eq!(c.acc_per_share, u64::MAX as u128 * ACC_SCALE);
        let mut r = rec(1, 0);
        c.accrue(&mut r).unwrap();
        assert_eq!(r.owed, u64::MAX);
        assert_eq!(c.rewards_owed_total, u64::MAX);
        // one unit of fee over the largest stake waits in the remainder
        let mut c = blank();
        c.last_split = rates(0, 500, 0);
        c.total_staked = u64::MAX;
        c.settle(1, 0).unwrap();
        assert_eq!((c.acc_per_share, c.reward_rem), (0, 1_000_000_000_000));
    }

    #[test]
    fn stakers_never_get_more_than_was_split() {
        let mut c = blank();
        c.last_split = rates(0, 500, 0);
        let mut a = rec(1, 0);
        let mut b = rec(2, 0);
        c.total_staked = 3;
        c.settle(100, 0).unwrap();
        c.accrue(&mut a).unwrap();
        c.accrue(&mut b).unwrap();
        assert_eq!((a.owed, b.owed), (33, 66));
        assert!(c.rewards_owed_total <= 100);
        assert_eq!(a.acc_snapshot, c.acc_per_share);
        // nothing new: a second accrue adds nothing
        c.accrue(&mut a).unwrap();
        assert_eq!(a.owed, 33);
    }

    #[test]
    fn a_trade_always_pays_all_three_rates_and_the_holders_share_is_burned_while_too_little_is_staked() {
        let mut c = blank();
        c.buy = rates(100, 200, 50);
        c.sell = rates(10, 20, 30);
        c.min_eligible = 1_000;
        c.total_staked = 999;
        // what a trade is charged does not look at the stake
        assert_eq!((c.side(true), c.side(false)), (rates(100, 200, 50), rates(10, 20, 30)));
        assert!(!c.stakers_eligible());
        // one unit short: the holders' 200 of 350 go to the burn pot with the burn's 50
        c.last_split = c.side(true);
        c.settle(3_500, 0).unwrap();
        assert_eq!((c.creator_owed, c.burn_pot, c.acc_per_share), (1_000, 2_500, 0));
        // enough staked: the same fee, the holders' part to the stakers
        c.total_staked = 1_000;
        assert!(c.stakers_eligible());
        c.settle(7_000, 0).unwrap();
        assert_eq!((c.creator_owed, c.burn_pot), (2_000, 3_000));
        assert_eq!(c.acc_per_share, 2_000 * ACC_SCALE / 1_000);
        // nothing staked and no threshold yet (a config whose pool does not exist): burned
        let mut c = blank();
        c.last_split = rates(0, 100, 0);
        assert!(!c.stakers_eligible());
        c.settle(10, 0).unwrap();
        assert_eq!((c.burn_pot, c.acc_per_share), (10, 0));
    }

    #[test]
    fn bounds() {
        let ok = RulesArgs {
            sniper_slots: MAX_SNIPER_SLOTS,
            sniper_start_fee_bps: MAX_START_FEE_BPS,
            buy: rates(MAX_CREATOR_BPS, MAX_HOLDERS_BPS, 0),
            sell: rates(0, MAX_HOLDERS_BPS, MAX_BURN_BPS),
            max_buy_quote: u64::MAX,
            limit_slots: MAX_LIMIT_SLOTS,
            creator_lock_seconds: MAX_LOCK_SECONDS,
        };
        assert!(check_rules(&ok).is_ok());
        assert!(check_rules(&RulesArgs::default()).is_ok(), "no rule at all is a valid config");
        let bad = |f: &dyn Fn(&mut RulesArgs)| {
            let mut a = ok;
            f(&mut a);
            check_rules(&a).is_err()
        };
        assert!(bad(&|a| a.buy = rates(MAX_CREATOR_BPS + 1, 0, 0)));
        assert!(bad(&|a| a.sell = rates(0, MAX_HOLDERS_BPS + 1, 0)));
        assert!(bad(&|a| a.buy = rates(0, 0, MAX_BURN_BPS + 1)));
        assert!(bad(&|a| a.buy = rates(500, 500, 1)));
        assert!(bad(&|a| a.sniper_start_fee_bps = MAX_START_FEE_BPS + 1));
        assert!(bad(&|a| a.sniper_slots = MAX_SNIPER_SLOTS + 1));
        assert!(bad(&|a| a.sniper_slots = 0));
        assert!(bad(&|a| a.sniper_start_fee_bps = 0));
        assert!(bad(&|a| a.limit_slots = MAX_LIMIT_SLOTS + 1));
        assert!(bad(&|a| a.limit_slots = 0));
        assert!(bad(&|a| a.max_buy_quote = 0));
        assert!(bad(&|a| a.creator_lock_seconds = MAX_LOCK_SECONDS + 1));
    }

    #[test]
    fn the_burn_cap_counts_only_the_part_of_the_fee_nobody_gets_back() {
        let mut c = blank();
        // the burn share of each side, never the creator's or the holders'
        c.buy = rates(100, 500, 50);
        c.sell = rates(0, 300, 5);
        assert_eq!((c.burn_charged(true, 1_000), c.burn_charged(false, 1_000)), (50, 5));
        // sure 20 + 50 + 5 = 75, soft 20 + 60 = 80: a quarter of 150 is 37
        assert_eq!(c.burn_cap_bps(20, 1_000, 30), 37);
        // no pool fee: sure 75, soft 20, a quarter of 95 is 23
        assert_eq!(c.burn_cap_bps(20, 1_000, 0), 23);
        // the platform cap lowers what the pool really charges, and the burn share with it:
        // 650 answered, 100 charged, the burn's 50 of 650 is 7; on the sell 305 answered,
        // 100 charged, 5 of 305 is 1
        assert_eq!((c.burn_charged(true, 100), c.burn_charged(false, 100)), (7, 1));
        assert_eq!(c.burn_cap_bps(20, 100, 0), 12);
        // a cap of zero: no hook fee at all
        assert_eq!((c.burn_charged(true, 0), c.burn_charged(false, 0)), (0, 0));
        // a coin with a creator fee and no burn rate: only the protocol fee is sure
        let mut c = blank();
        c.buy = rates(500, 0, 0);
        c.sell = rates(500, 0, 0);
        assert_eq!((c.burn_charged(true, 1_000), c.burn_charged(false, 1_000)), (0, 0));
        assert_eq!(c.burn_cap_bps(20, 1_000, 30), 10);
        // burn at the ceiling on both sides: sure 1020, soft 80, a quarter is the ceiling
        c.buy = rates(0, 0, 500);
        c.sell = rates(0, 0, 500);
        assert_eq!(c.burn_cap_bps(20, 1_000, 30), 50);
        // no fee anywhere: the floor
        assert_eq!(blank().burn_cap_bps(0, 1_000, 0), 1);
    }

    #[test]
    fn a_callback_is_only_for_a_pool_that_runs_this_hook() {
        use anchor_lang::AnchorDeserialize;
        let zero = vec![0u8; 8 + <PoolData as anchor_lang::Space>::INIT_SPACE];
        let mut pool = PoolData::deserialize(&mut &zero[8..]).unwrap();
        pool.hook_program = crate::ID;
        assert!(runs_this_hook(&pool).is_ok());
        pool.hook_program = Pubkey::new_unique();
        assert!(runs_this_hook(&pool).is_err());
        pool.hook_program = Pubkey::default();
        assert!(runs_this_hook(&pool).is_err());
    }

    /// The byte layout RULES.md publishes, so a client can read the accounts without the IDL.
    #[test]
    fn account_layouts() {
        assert_eq!(8 + RulesConfig::INIT_SPACE, 414);
        assert_eq!(8 + StakeRecord::INIT_SPACE, 113);
        assert_eq!(8 + LockRecord::INIT_SPACE, 57);

        let mut c = blank();
        c.bump = 0xA1;
        c.authority_bump = 0xA2;
        c.sniper_slots = 0x0101;
        c.sniper_start_fee_bps = 0x0202;
        c.buy = rates(0x0303, 0x0404, 0x0505);
        c.sell = rates(0x0606, 0x0707, 0x0808);
        c.max_buy_quote = 0x0909;
        c.limit_slots = 0x0A0A;
        c.creator_lock_seconds = 0x0B0B;
        c.start_slot = 0x0C0C;
        c.start_time = 0x0D0D;
        c.min_eligible = 0x0E0E;
        c.fees_seen = 0x0F0F;
        c.last_split = rates(0x1010, 0x1111, 0x1212);
        c.creator_owed = 0x1313;
        c.burn_pot = 0x1414;
        c.acc_per_share = 0x1515;
        c.reward_rem = 0x1616;
        c.total_staked = 0x1717;
        c.rewards_owed_total = 0x1818;
        c.total_creator_paid = 0x1919;
        c.total_rewards_paid = 0x1A1A;
        c.total_quote_burned = 0x1B1B;
        c.total_base_burned = 0x1C1C;
        c.burns = 0x1D1D;
        c.obs_slot = 0x1E1E;
        c.obs_reserve_base = 0x1F1F;
        c.obs_reserve_quote = 0x2020;
        let mut d = vec![0u8; 8];
        c.serialize(&mut d).unwrap();
        assert_eq!(d.len(), 414);
        let u16_at = |o: usize| u16::from_le_bytes(d[o..o + 2].try_into().unwrap());
        let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        assert_eq!((d[8], d[9]), (0xA1, 0xA2));
        // pool 10, base_mint 42, quote_mint 74, treasury 106, creator 138
        assert_eq!(u64_at(170), 0x0101);
        assert_eq!(u16_at(178), 0x0202);
        assert_eq!((u16_at(180), u16_at(182), u16_at(184)), (0x0303, 0x0404, 0x0505));
        assert_eq!((u16_at(186), u16_at(188), u16_at(190)), (0x0606, 0x0707, 0x0808));
        assert_eq!(u64_at(192), 0x0909);
        assert_eq!(u64_at(200), 0x0A0A);
        assert_eq!(u64_at(208), 0x0B0B);
        assert_eq!(u64_at(216), 0x0C0C);
        assert_eq!(u64_at(224), 0x0D0D);
        assert_eq!(u64_at(232), 0x0E0E);
        assert_eq!(u64_at(240), 0x0F0F);
        assert_eq!((u16_at(248), u16_at(250), u16_at(252)), (0x1010, 0x1111, 0x1212));
        assert_eq!(u64_at(254), 0x1313);
        assert_eq!(u64_at(262), 0x1414);
        assert_eq!(u128::from_le_bytes(d[270..286].try_into().unwrap()), 0x1515);
        assert_eq!(u64_at(286), 0x1616);
        assert_eq!(u64_at(294), 0x1717);
        assert_eq!(u64_at(302), 0x1818);
        assert_eq!(u64_at(310), 0x1919);
        assert_eq!(u64_at(318), 0x1A1A);
        assert_eq!(u64_at(326), 0x1B1B);
        assert_eq!(u64_at(334), 0x1C1C);
        assert_eq!(u64_at(342), 0x1D1D);
        assert_eq!(u64_at(350), 0x1E1E);
        assert_eq!(u64_at(358), 0x1F1F);
        assert_eq!(u64_at(366), 0x2020);
        assert!(d[374..414].iter().all(|b| *b == 0));

        let mut r = rec(0x2121, 0x2222);
        r.bump = 0xB1;
        r.owed = 0x2323;
        r.since_slot = 0x2424;
        let mut d = vec![0u8; 8];
        r.serialize(&mut d).unwrap();
        assert_eq!(d.len(), 113);
        let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        assert_eq!(d[8], 0xB1);
        // pool 9, staker 41
        assert_eq!(u64_at(73), 0x2121);
        assert_eq!(u128::from_le_bytes(d[81..97].try_into().unwrap()), 0x2222);
        assert_eq!(u64_at(97), 0x2323);
        assert_eq!(u64_at(105), 0x2424);

        let l = LockRecord { bump: 0xC1, pool: Pubkey::default(), amount: 0x3131, unlock_at: 0x3232 };
        let mut d = vec![0u8; 8];
        l.serialize(&mut d).unwrap();
        assert_eq!(d.len(), 57);
        assert_eq!(d[8], 0xC1);
        // pool 9
        assert_eq!(u64::from_le_bytes(d[41..49].try_into().unwrap()), 0x3131);
        assert_eq!(i64::from_le_bytes(d[49..57].try_into().unwrap()), 0x3232);
    }

    // ---- the strict coin ---------------------------------------------------------------

    #[test]
    fn the_numbers_of_a_strict_coin_sit_in_what_was_the_reserve_of_the_config() {
        let mut c = blank();
        c.obs_reserve_quote = 0x2020;
        c.kind = 0x21;
        c.buy_mark = 0x22;
        c.vault_bump = 0x23;
        c.max_wallet_bps = 0x2424;
        c.early_slots = 0x2525;
        c.max_wallet_slots = 0x2626_2626;
        c.early_unlock_slots = 0x2727_2727;
        c.max_wallet_amount = 0x2828;
        let mut d = vec![0u8; 8];
        c.serialize(&mut d).unwrap();
        assert_eq!(d.len(), 414, "the config has the size it always had");
        assert_eq!(8 + RulesConfig::INIT_SPACE, 414);
        let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        assert_eq!(u64_at(366), 0x2020, "the last field of a plain config is where it was");
        assert_eq!((d[374], d[375], d[376]), (0x21, 0x22, 0x23));
        assert_eq!(u16::from_le_bytes(d[377..379].try_into().unwrap()), 0x2424);
        assert_eq!(u16::from_le_bytes(d[379..381].try_into().unwrap()), 0x2525);
        assert_eq!(u32::from_le_bytes(d[381..385].try_into().unwrap()), 0x2626_2626);
        assert_eq!(u32::from_le_bytes(d[385..389].try_into().unwrap()), 0x2727_2727);
        assert_eq!(u64_at(389), 0x2828);
        assert_eq!(d[397..414], [0u8; 17], "seventeen bytes are still free");
        // a plain config: all forty bytes zero
        let mut d = vec![0u8; 8];
        blank().serialize(&mut d).unwrap();
        assert_eq!(d[374..414], [0u8; 40]);
    }

    #[test]
    fn a_holder_record_is_129_bytes_and_execute_reads_it_where_anchor_writes_it() {
        let r = HolderRecord {
            bump: 0xA1,
            pool: Pubkey::new_from_array([2; 32]),
            owner: Pubkey::new_from_array([3; 32]),
            balance: 0x0404,
            acc_snapshot: 0x0505,
            owed: 0x0606,
            early_bought: 0x0707,
            locked: 0x0808,
            locked_until: 0x0909,
        };
        let mut d = HolderRecord::DISCRIMINATOR.to_vec();
        r.serialize(&mut d).unwrap();
        assert_eq!(d.len(), 129);
        assert_eq!(8 + HolderRecord::INIT_SPACE, 129);
        assert_eq!(d[8], 0xA1);
        assert_eq!(d[H_POOL..H_POOL + 32], [2u8; 32]);
        assert_eq!(d[H_OWNER..H_OWNER + 32], [3u8; 32]);
        assert_eq!((H_POOL, H_OWNER, H_BALANCE, H_SNAPSHOT, H_OWED, H_EARLY, H_LOCKED, H_LOCKED_UNTIL), (9, 41, 73, 81, 97, 105, 113, 121));
        assert_eq!(rd_u64(&d, H_BALANCE), 0x0404);
        assert_eq!(u128::from_le_bytes(d[H_SNAPSHOT..H_SNAPSHOT + 16].try_into().unwrap()), 0x0505);
        assert_eq!((rd_u64(&d, H_OWED), rd_u64(&d, H_EARLY), rd_u64(&d, H_LOCKED), rd_u64(&d, H_LOCKED_UNTIL)), (0x0606, 0x0707, 0x0808, 0x0909));
        // the seed of the list entry reads the pool from the config at byte 10
        let mut c = blank();
        c.pool = Pubkey::new_from_array([7; 32]);
        let mut d = vec![0u8; 8];
        c.serialize(&mut d).unwrap();
        assert_eq!(d[10..42], [7u8; 32]);
    }

    #[test]
    fn every_bound_of_the_strict_numbers() {
        let s = |max_wallet_bps: u16, max_wallet_slots: u32, early_slots: u16, early_unlock_slots: u32| StrictArgs { max_wallet_bps, max_wallet_slots, early_slots, early_unlock_slots };
        // everything off, and every ceiling
        assert!(check_strict(&s(0, 0, 0, 0)).is_ok());
        assert!(check_strict(&s(MAX_MAX_WALLET_BPS, MAX_MAX_WALLET_SLOTS, MAX_EARLY_SLOTS, MAX_EARLY_UNLOCK_SLOTS)).is_ok());
        assert!(check_strict(&s(MIN_MAX_WALLET_BPS, 1, 1, 1)).is_ok());
        // one above, one below
        assert!(check_strict(&s(MAX_MAX_WALLET_BPS + 1, 1, 0, 0)).is_err());
        assert!(check_strict(&s(MIN_MAX_WALLET_BPS - 1, 1, 0, 0)).is_err());
        assert!(check_strict(&s(100, MAX_MAX_WALLET_SLOTS + 1, 0, 0)).is_err());
        assert!(check_strict(&s(0, 0, MAX_EARLY_SLOTS + 1, MAX_EARLY_SLOTS as u32 + 1)).is_err());
        assert!(check_strict(&s(0, 0, 100, MAX_EARLY_UNLOCK_SLOTS + 1)).is_err());
        // the unlock is never before the end of the window
        assert!(check_strict(&s(0, 0, 100, 99)).is_err());
        assert!(check_strict(&s(0, 0, 100, 100)).is_ok());
        // half a rule is refused
        for half in [s(100, 0, 0, 0), s(0, 100, 0, 0), s(0, 0, 100, 0), s(0, 0, 0, 100)] {
            assert!(check_strict(&half).is_err());
        }
    }

    #[test]
    fn the_windows_of_a_strict_coin_end_on_their_last_slot() {
        let mut c = blank();
        // before the pool exists nothing runs
        c.max_wallet_slots = 100;
        c.early_slots = 10;
        c.early_unlock_slots = 50;
        assert!(!c.max_wallet_runs(5) && !c.early_window_runs(5) && !c.early_locked(5));
        c.min_eligible = 1;
        c.start_slot = 1_000;
        assert!(c.max_wallet_runs(1_000) && c.max_wallet_runs(1_099) && !c.max_wallet_runs(1_100));
        assert!(c.early_window_runs(1_009) && !c.early_window_runs(1_010));
        assert!(c.early_locked(1_049) && !c.early_locked(1_050));
        // a rule that is off never runs
        c.max_wallet_slots = 0;
        c.early_slots = 0;
        assert!(!c.max_wallet_runs(1_000) && !c.early_window_runs(1_000) && !c.early_locked(1_000));
    }

    #[test]
    fn a_strict_coin_settles_as_a_plain_coin_does() {
        // the holders' share goes to the burn pot while too little is registered, and to
        // the holders afterwards; `total_staked` is what the holder records hold
        let run = |kind: u8| {
            let mut c = blank();
            c.kind = kind;
            c.min_eligible = 1_000;
            c.last_split = Rates { creator_bps: 100, holders_bps: 200, burn_bps: 100 };
            c.settle(400, 0).unwrap();
            let nobody = (c.creator_owed, c.burn_pot, c.acc_per_share);
            c.total_staked = 999;
            c.settle(800, 0).unwrap();
            let too_few = (c.creator_owed, c.burn_pot, c.acc_per_share);
            c.total_staked = 1_000;
            c.settle(1_200, 0).unwrap();
            (nobody, too_few, (c.creator_owed, c.burn_pot, c.acc_per_share, c.reward_rem))
        };
        let strict = run(KIND_STRICT);
        assert_eq!(strict.0, (100, 300, 0));
        assert_eq!(strict.1, (200, 600, 0));
        assert_eq!(strict.2, (300, 700, 200 * ACC_SCALE / 1_000, 0));
        assert_eq!(strict, run(KIND_PLAIN));
        let mut c = blank();
        c.acc_per_share = 200 * ACC_SCALE / 1_000;
        let mut rec = HolderRecord { bump: 0, pool: Pubkey::default(), owner: Pubkey::default(), balance: 1_000, acc_snapshot: 0, owed: 0, early_bought: 0, locked: 0, locked_until: 0 };
        c.accrue_holder(&mut rec).unwrap();
        assert_eq!((rec.owed, c.rewards_owed_total), (200, 200));
    }

    #[test]
    fn the_bookkeeping_of_a_transfer_never_fails() {
        // a record and a config at numbers no coin reaches: `touch_holder` stops at the
        // limit instead of returning an error, so it can never refuse a sell
        let rec = HolderRecord { bump: 0, pool: Pubkey::default(), owner: Pubkey::default(), balance: u64::MAX, acc_snapshot: 0, owed: u64::MAX - 5, early_bought: 0, locked: 0, locked_until: 0 };
        let mut d = HolderRecord::DISCRIMINATOR.to_vec();
        rec.serialize(&mut d).unwrap();
        let mut c = blank();
        c.acc_per_share = u128::MAX;
        c.rewards_owed_total = u64::MAX - 1;
        c.total_staked = 7; // less than the record says it holds
        touch_holder(&mut c, &mut d, 3);
        assert_eq!((rd_u64(&d, H_OWED), c.rewards_owed_total, c.total_staked, rd_u64(&d, H_BALANCE)), (u64::MAX, u64::MAX, 3, 3));
        // and with ordinary numbers it is exact
        let rec = HolderRecord { bump: 0, pool: Pubkey::default(), owner: Pubkey::default(), balance: 1_000, acc_snapshot: 0, owed: 4, early_bought: 0, locked: 0, locked_until: 0 };
        let mut d = HolderRecord::DISCRIMINATOR.to_vec();
        rec.serialize(&mut d).unwrap();
        let mut c = blank();
        c.acc_per_share = 3 * ACC_SCALE / 2;
        c.total_staked = 5_000;
        touch_holder(&mut c, &mut d, 400);
        assert_eq!((rd_u64(&d, H_OWED), c.rewards_owed_total, c.total_staked, rd_u64(&d, H_BALANCE)), (1_504, 1_500, 4_400, 400));
    }

    #[test]
    fn only_a_token_account_in_the_middle_of_a_transfer_is_one_side_of_a_transfer() {
        let mint = Pubkey::new_from_array([9; 32]);
        let owner = Pubkey::new_from_array([4; 32]);
        // a Token-2022 account: mint, owner, amount, then at byte 165 the type and the extensions
        let forge = |len: usize, kind: u8, ext: &[u8]| {
            let mut d = vec![0u8; len];
            d[0..32].copy_from_slice(&mint.to_bytes());
            d[32..64].copy_from_slice(&owner.to_bytes());
            d[64..72].copy_from_slice(&5u64.to_le_bytes());
            d[165] = kind;
            d[166..166 + ext.len()].copy_from_slice(ext);
            d
        };
        let transferring = [15u8, 0, 1, 0, 1];
        assert_eq!(token_account_bytes(&forge(356, 2, &transferring), &mint, true), Some((owner, 5)));
        assert_eq!(token_account_bytes(&forge(356, 2, &[15, 0, 1, 0, 0]), &mint, true), None, "not in a transfer");
        assert_eq!(token_account_bytes(&forge(356, 2, &[15, 0, 1, 0, 0]), &mint, false), Some((owner, 5)), "outside a transfer it is still a token account");
        assert_eq!(token_account_bytes(&forge(T22_MULTISIG_LEN, 2, &transferring), &mint, true), None, "a multisig is never read as a token account");
        assert_eq!(token_account_bytes(&forge(356, 1, &transferring), &mint, true), None, "a mint is not a token account");
        assert_eq!(token_account_bytes(&forge(356, 2, &transferring), &owner, true), None, "another coin");
        assert_eq!(token_account_bytes(&forge(356, 2, &[])[..165], &mint, true), None, "an SPL Token account has no flag");
        // a strict mint: transfer hook = this program, no authority
        let mut hook = vec![14u8, 0, 64, 0];
        hook.extend_from_slice(&[0u8; 32]);
        hook.extend_from_slice(&crate::ID.to_bytes());
        assert!(strict_mint_bytes(&forge(400, 1, &hook)));
        assert!(!strict_mint_bytes(&forge(T22_MULTISIG_LEN, 1, &hook[..60])));
        assert!(!strict_mint_bytes(&forge(400, 2, &hook)), "a token account is not a mint");
        let mut with_authority = hook.clone();
        with_authority[4] = 1;
        assert!(!strict_mint_bytes(&forge(400, 1, &with_authority)), "somebody could still point the coin at another program");
        let mut other = hook.clone();
        other[36] ^= 1;
        assert!(!strict_mint_bytes(&forge(400, 1, &other)), "another program's coin");
        assert!(!strict_mint_bytes(&forge(400, 1, &[])));
    }
}
