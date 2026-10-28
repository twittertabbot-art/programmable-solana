//! hookpool interface: everything a hook needs to talk to the pool program,
//! and everything the pool program needs to talk to a hook.
//!
//! Hooks depend on this crate only. They never depend on the pool program itself.
//! The spec lives in HOOKS.md at the repo root; this file is its executable form.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
pub use spl_discriminator::{ArrayDiscriminator, SplDiscriminate};
pub use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};

// The pool program. Hooks verify the caller PDA against this.
declare_id!("7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh");

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

pub const PLATFORM_SEED: &[u8] = b"platform";
pub const POOL_SEED: &[u8] = b"pool";
pub const VAULT_SEED: &[u8] = b"vault";
pub const LP_MINT_SEED: &[u8] = b"lp";
pub const LP_LOCK_SEED: &[u8] = b"lp-lock";
/// First seed of the PDAs of the pool program that sign hook callbacks. There is one per
/// hook program: `["caller", hook_program]`. See `caller_address`.
pub const CALLER_SEED: &[u8] = b"caller";
/// PDA of the HOOK program that may call `hook_swap` on its pool.
pub const HOOK_AUTHORITY_SEED: &[u8] = b"hook-authority";
/// PDA of the HOOK program holding its HookManifest.
pub const MANIFEST_SEED: &[u8] = b"manifest";
/// PDA of the HOOK program holding its ExtraAccountMetaList.
pub const EXTRA_METAS_SEED: &[u8] = b"extra-metas";
/// Anchor event-CPI authority seed, the same for every program.
pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

// ---------------------------------------------------------------------------
// Flags (HOOKS.md section 5)
// ---------------------------------------------------------------------------

pub const BEFORE_SWAP: u32 = 1 << 0;
pub const AFTER_SWAP: u32 = 1 << 1;
pub const BEFORE_ADD_LIQ: u32 = 1 << 2;
pub const AFTER_ADD_LIQ: u32 = 1 << 3;
pub const BEFORE_REMOVE_LIQ: u32 = 1 << 4;
pub const AFTER_REMOVE_LIQ: u32 = 1 << 5;
pub const ON_POOL_CREATE: u32 = 1 << 6;
pub const OVERRIDE_FEE: u32 = 1 << 8;
pub const TAKE_HOOK_FEE: u32 = 1 << 9;
pub const OVERRIDE_CURVE: u32 = 1 << 10;
pub const CALL_ON_BUY: u32 = 1 << 12;
pub const CALL_ON_SELL: u32 = 1 << 13;

/// Every bit the pool understands. Manifests with unknown bits are rejected.
pub const ALL_FLAGS: u32 = BEFORE_SWAP
    | AFTER_SWAP
    | BEFORE_ADD_LIQ
    | AFTER_ADD_LIQ
    | BEFORE_REMOVE_LIQ
    | AFTER_REMOVE_LIQ
    | ON_POOL_CREATE
    | OVERRIDE_FEE
    | TAKE_HOOK_FEE
    | OVERRIDE_CURVE
    | CALL_ON_BUY
    | CALL_ON_SELL;

/// `hook_kind` values stored in the pool.
pub const HOOK_KIND_NONE: u8 = 0;
pub const HOOK_KIND_FROZEN: u8 = 1;
pub const HOOK_KIND_PLATFORM: u8 = 2;

pub const DIRECTION_BUY: u8 = 0;
pub const DIRECTION_SELL: u8 = 1;

// ---------------------------------------------------------------------------
// The curve launch (HOOKS.md section 2, "A pool on the curve")
// ---------------------------------------------------------------------------

/// `curve_state` of a seeded pool: it never had a virtual quote.
pub const CURVE_NONE: u8 = 0;
/// `curve_state` of a pool on the curve: it prices with `reserve_quote + virtual_quote`,
/// pays out `reserve_quote` only, and refuses liquidity until it graduates.
pub const CURVE_OPEN: u8 = 1;
/// `curve_state` of a pool that graduated: an ordinary pool from then on, `virtual_quote` 0.
pub const CURVE_GRADUATED: u8 = 2;

/// The platform's defaults, written by `init_platform`: 30 SOL counted in the price that are
/// not there, and graduation when the pool holds 85 real SOL. In lamports of the quote.
pub const DEFAULT_CURVE_VIRTUAL_QUOTE: u64 = 30_000_000_000;
pub const DEFAULT_CURVE_GRADUATION_TARGET: u64 = 85_000_000_000;

// ---------------------------------------------------------------------------
// Buying back through `hook_swap` (HOOKS.md section 7)
// ---------------------------------------------------------------------------

/// A hook that buys its own coin with collected fees (a buyback, a burn) buys against an
/// observation of the pool that is at least this many slots old, about ten seconds. Each
/// buy leaves a fresh observation, so buys are at least this far apart. See `burn_step`.
pub const BURN_INTERVAL_SLOTS: u64 = 25;
/// The most one such buy may spend, in basis points of the pool's quote reserve.
pub const MAX_BURN_CAP_BPS: u64 = 50;
/// The least the cap can be, so that a buy is always possible.
pub const MIN_BURN_CAP_BPS: u64 = 1;

/// The share of the pool's quote reserve, in basis points, that one buy made through
/// `hook_swap` may spend. Between `MIN_BURN_CAP_BPS` and `MAX_BURN_CAP_BPS`:
///
/// ```text
/// sure = protocol_fee_bps + buy_fee_bps + sell_fee_bps
/// soft = protocol_fee_bps + 2 * lp_fee_bps
/// cap  = (sure + min(sure, soft)) / 4
/// ```
///
/// `buy_fee_bps` and `sell_fee_bps` are the hook fees a buy and a sell ALWAYS pay (already
/// capped by the platform's `max_hook_fee_bps`).
///
/// Why. Anyone may trigger such a buy and choose its `min_amount_out`, so a wallet can
/// buy the coin first, trigger the buy, and sell into the price it pushed up. A buy of a
/// share `c` of the quote reserve is worth about `2c` of a small position and about `c`
/// of a position much larger than the pool. Against that stand the fees of the wallet's
/// own buy and sell, and they are not all alike:
///
/// * `sure`: the protocol fee of the buy and the hook fee of both trades are taken in the
///   quote token and leave the pool. A position of any size pays them in full.
/// * `soft`: the pool fee of both trades stays in the reserves, and a wallet that sells
///   back into those reserves takes part of it out again; the protocol fee of the sell
///   is taken in the coin, and a wallet that sells nearly all the coin there is hardly
///   notices it. A small position pays these in full, a position much larger than the
///   pool pays almost nothing of them.
///
/// So a small position pays `sure + soft` and gains `2c`; a huge one pays `sure` and
/// gains `c`; everything in between lies between the two. With the cap above the price
/// one buy moves is worth at most about half of what the two trades cost, for a position
/// of any size. That alone is not enough: the caller could still deepen the pool with
/// liquidity for one transaction, which costs no trading fee and makes a share of the
/// reserve a much larger amount. `burn_step` closes that: a buy is measured against an
/// observation of the pool taken at least `BURN_INTERVAL_SLOTS` earlier, and
/// `burn_lowered` keeps that observation from standing above a price trades start at.
///
/// "Fees a wallet always pays" means fees it cannot get back. A hook that pays part of
/// its fee out again (to a creator, to stakers) must leave that part out of
/// `buy_fee_bps` and `sell_fee_bps`: whoever receives it can sandwich at a discount.
///
/// The one exception: `sure + min(sure, soft)` under 4 bps, which needs a protocol fee of
/// zero or one basis point. There the floor of 1 bps applies and the margin is gone.
pub fn burn_cap_bps(protocol_fee_bps: u16, lp_fee_bps: u16, buy_fee_bps: u16, sell_fee_bps: u16) -> u64 {
    let sure = protocol_fee_bps as u64 + buy_fee_bps as u64 + sell_fee_bps as u64;
    let soft = protocol_fee_bps as u64 + 2 * lp_fee_bps as u64;
    ((sure + soft.min(sure)) / 4).clamp(MIN_BURN_CAP_BPS, MAX_BURN_CAP_BPS)
}

/// Outcomes of a buy instruction that returned Ok. They are the first byte of its return
/// data (`set_burn_result`) and a field of its event.
pub const BURN_OBSERVED: u8 = 1;
pub const BURN_WAITED: u8 = 2;
pub const BURN_BOUGHT: u8 = 3;

/// What a hook's buy instruction (a buyback, a burn) does when somebody calls it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BurnStep {
    /// There is no observation yet. Record the reserves, buy nothing, return Ok.
    Observe,
    /// The observation is younger than `BURN_INTERVAL_SLOTS`. Fail and write nothing: a
    /// call that comes too soon must never move the observation, or anybody could
    /// postpone the buy forever at no cost.
    TooSoon,
    /// The price is above the observed one by more than the tolerance. Record the
    /// reserves as the new observation, buy nothing, return Ok: the price has to stand
    /// for another interval, where anyone can sell into it, before a buy happens at it.
    Wait,
    /// Buy, spending at most this much of the quote token.
    Buy { max_spend: u64 },
}

/// By how much the price may be above the observed price for a buy to go ahead, in bps:
/// twice the cap, which is what one buy at the cap moves the price by itself.
pub fn burn_tolerance_bps(cap_bps: u64) -> u64 {
    2 * cap_bps
}

/// Decide what a buy instruction does. The rule that keeps its caller from making the
/// price or the depth it buys at:
///
/// * the config keeps an OBSERVATION of the pool, `(obs_reserve_base, obs_reserve_quote)`
///   taken in slot `obs_slot`. It is written by this instruction only: when there is
///   none, when the price ran away (`Wait`), and after every buy (the reserves after it).
/// * a buy needs an observation at least `BURN_INTERVAL_SLOTS` old. So whatever the
///   caller did to the pool in its own transaction (a buy that pumps the price, liquidity
///   that deepens the pool for a moment) is measured against a pool that was there at
///   least that long before.
/// * between two calls the hook's `before_swap` lowers the observed PRICE whenever a
///   trade starts below it (`burn_lowered`), and never raises the observed depth. So the
///   observed price is never above the price any trade started at since it was taken.
/// * a buy happens only when the price now, `reserve_quote / reserve_base`, is at most
///   the observed price plus `burn_tolerance_bps`. Compared by cross-multiplying in
///   u128, without dividing by a reserve. A price that fell is fine.
/// * the cap is measured on the SMALLER of the quote reserve now and the observed one.
///   Liquidity added a moment ago does not count.
///
/// `cap_bps` is `burn_cap_bps` of the pool. "No observation" is an observation with a
/// zero reserve; a pool never has one.
pub fn burn_step(
    obs_reserve_base: u64,
    obs_reserve_quote: u64,
    obs_slot: u64,
    reserve_base: u64,
    reserve_quote: u64,
    slot: u64,
    cap_bps: u64,
) -> BurnStep {
    if obs_reserve_base == 0 || obs_reserve_quote == 0 {
        return BurnStep::Observe;
    }
    if slot < obs_slot.saturating_add(BURN_INTERVAL_SLOTS) {
        return BurnStep::TooSoon;
    }
    // price_now > price_obs * (1 + tol)  <=>  rq * ob > oq * rb * (1 + tol)
    let now = reserve_quote as u128 * obs_reserve_base as u128;
    let then = obs_reserve_quote as u128 * reserve_base as u128;
    let tol = burn_tolerance_bps(cap_bps) as u128;
    // then * tol / 10_000, rounded down, without overflowing
    let slack = (then / 10_000) * tol + (then % 10_000) * tol / 10_000;
    if now > then.saturating_add(slack) {
        return BurnStep::Wait;
    }
    let depth = reserve_quote.min(obs_reserve_quote);
    let cap = (depth as u128 * cap_bps as u128 / 10_000) as u64;
    BurnStep::Buy { max_spend: cap.max(1) }
}

/// Did a trade start at a price BELOW the observed one? `reserve_base` and
/// `reserve_quote` are the reserves a swap is about to trade against (the payload of
/// `before_swap`). When this says yes the hook lowers the observation with
/// `burn_lowered` and leaves `obs_slot` as it is.
///
/// Why. `burn_step` alone lets a pumped price become the observation without anybody
/// holding it: a wallet pumps, calls the buy instruction (which waits and records the
/// pumped pool), sells back in the same transaction, and 25 slots later pumps to the same
/// price again and calls. The second pump is a buy, and that buy starts at the honest
/// price: with this rule it lowers the observation back, and the call waits again. A
/// pumped price is bought at only if every trade since the observation started at it,
/// which means it stood in the open for the whole interval.
///
/// The slot stays, so a wallet cannot postpone the buy by making the price tick down.
/// Compared by cross-multiplying in u128; no observation yet is never lowered.
pub fn burn_price_fell(obs_reserve_base: u64, obs_reserve_quote: u64, reserve_base: u64, reserve_quote: u64) -> bool {
    obs_reserve_base != 0
        && obs_reserve_quote != 0
        && (reserve_quote as u128 * obs_reserve_base as u128) < (obs_reserve_quote as u128 * reserve_base as u128)
}

/// Return data of a buy instruction that returned Ok, 17 bytes: the outcome
/// (`BURN_OBSERVED`, `BURN_WAITED` or `BURN_BOUGHT`), then what it spent of the quote
/// token and how many coins it burned, both u64 little-endian and zero unless it bought.
/// A client that simulates the instruction reads from it what a real call would do. Set
/// it last: an event CPI clears return data.
pub fn set_burn_result(outcome: u8, quote_spent: u64, base_burned: u64) {
    let mut out = [0u8; 17];
    out[0] = outcome;
    out[1..9].copy_from_slice(&quote_spent.to_le_bytes());
    out[9..17].copy_from_slice(&base_burned.to_le_bytes());
    set_return_data(&out);
}

// ---------------------------------------------------------------------------
// Callback discriminators: sha256("global:<name>")[..8], Anchor convention,
// so an Anchor hook implements the callbacks as ordinary instructions.
// ---------------------------------------------------------------------------

pub const ON_POOL_CREATE_DISC: [u8; 8] = [145, 87, 198, 141, 215, 104, 119, 28];
pub const BEFORE_SWAP_DISC: [u8; 8] = [227, 59, 240, 68, 164, 9, 29, 254];
pub const AFTER_SWAP_DISC: [u8; 8] = [235, 215, 232, 183, 152, 109, 5, 35];
pub const BEFORE_ADD_LIQUIDITY_DISC: [u8; 8] = [114, 27, 123, 181, 200, 252, 178, 240];
pub const AFTER_ADD_LIQUIDITY_DISC: [u8; 8] = [124, 24, 168, 110, 143, 56, 35, 14];
pub const BEFORE_REMOVE_LIQUIDITY_DISC: [u8; 8] = [66, 129, 139, 63, 196, 84, 231, 221];
pub const AFTER_REMOVE_LIQUIDITY_DISC: [u8; 8] = [238, 138, 28, 220, 35, 167, 8, 42];
/// sha256("account:HookManifest")[..8]: the Anchor discriminator every hook's manifest carries.
pub const MANIFEST_DISC: [u8; 8] = [41, 17, 255, 71, 98, 180, 87, 109];

/// TLV key under which a hook stores its ExtraAccountMetaList.
/// sha256("hookpool-interface:callback")[..8]
pub struct CallbackInstruction;
impl SplDiscriminate for CallbackInstruction {
    const SPL_DISCRIMINATOR: ArrayDiscriminator =
        ArrayDiscriminator::new([60, 167, 17, 250, 28, 149, 188, 66]);
}

/// spl-transfer-hook-interface `Execute`: sha256("spl-transfer-hook-interface:execute")[..8].
/// Token-2022 calls a coin's transfer hook program with this discriminator and a u64 amount.
pub const TRANSFER_HOOK_EXECUTE_DISC: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
/// TLV key under which a transfer hook stores the account list Token-2022 resolves for it.
pub struct TransferHookExecute;
impl SplDiscriminate for TransferHookExecute {
    const SPL_DISCRIMINATOR: ArrayDiscriminator = ArrayDiscriminator::new(TRANSFER_HOOK_EXECUTE_DISC);
}
/// Seed of that account list: `[this, mint]` under the transfer hook program.
pub const TRANSFER_HOOK_METAS_SEED: &[u8] = b"extra-account-metas";

/// Number of fixed accounts the pool passes before the hook's extra accounts.
/// 0 pool, 1 hook_caller (the caller address of the hook being called), 2 user,
/// 3 quote_mint, 4 base_mint.
pub const FIXED_CALLBACK_ACCOUNTS: u8 = 5;
pub const CB_IDX_POOL: u8 = 0;
pub const CB_IDX_CALLER: u8 = 1;
pub const CB_IDX_USER: u8 = 2;
pub const CB_IDX_QUOTE_MINT: u8 = 3;
pub const CB_IDX_BASE_MINT: u8 = 4;

/// borsh 1 has no `try_to_vec`; this is the one-liner everybody wants.
pub fn to_vec<T: AnchorSerialize>(value: &T) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(128);
    value.serialize(&mut buf)?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Payloads (HOOKS.md section 3.2)
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SwapPayload {
    pub direction: u8,
    pub amount_in: u64,
    pub net_in: u64,
    pub amount_out: u64,
    /// Reserves at the moment of the callback (before the swap in `before_swap`,
    /// after it in `after_swap`).
    pub reserve_base: u64,
    pub reserve_quote: u64,
    pub lp_fee_bps: u16,
    pub slot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LiquidityPayload {
    pub base_amount: u64,
    pub quote_amount: u64,
    pub lp_amount: u64,
    pub reserve_base: u64,
    pub reserve_quote: u64,
    pub slot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PoolCreatePayload {
    pub lp_fee_bps: u16,
    pub base_amount: u64,
    pub quote_amount: u64,
    pub creator: Pubkey,
}

// ---------------------------------------------------------------------------
// Return data (HOOKS.md section 3.3)
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CurveOut {
    pub amount_out_gross: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HookReturn {
    pub version: u8,
    pub fee_override_bps: Option<u16>,
    pub hook_fee_bps: u16,
    pub curve: Option<CurveOut>,
}

impl Default for HookReturn {
    fn default() -> Self {
        Self { version: 1, fee_override_bps: None, hook_fee_bps: 0, curve: None }
    }
}

impl HookReturn {
    pub const VERSION: u8 = 1;

    pub fn fee_override(bps: u16) -> Self {
        Self { fee_override_bps: Some(bps), ..Default::default() }
    }
    pub fn hook_fee(bps: u16) -> Self {
        Self { hook_fee_bps: bps, ..Default::default() }
    }
    pub fn curve(amount_out_gross: u64) -> Self {
        Self { curve: Some(CurveOut { amount_out_gross }), ..Default::default() }
    }
    /// Hand the answer back to the pool. Call this at the end of `before_swap`.
    pub fn set(&self) -> Result<()> {
        let bytes = to_vec(self)?;
        set_return_data(&bytes);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Manifest (HOOKS.md section 4)
// ---------------------------------------------------------------------------

/// Field layout of every hook's `HookManifest` account, after the 8-byte
/// Anchor discriminator. Hook programs declare `#[account] pub struct HookManifest`
/// with exactly these fields; the discriminator then matches `MANIFEST_DISC`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HookManifestData {
    pub version: u8,
    pub flags: u32,
    pub admin: Option<Pubkey>,
    pub name: [u8; 32],
    pub uri: [u8; 128],
}

impl HookManifestData {
    pub const VERSION: u8 = 1;
    /// 8 (discriminator) + 1 + 4 + 33 + 32 + 128
    pub const ACCOUNT_SIZE: usize = 8 + 1 + 4 + 33 + 32 + 128;

    pub fn new(flags: u32, admin: Option<Pubkey>, name: &str, uri: &str) -> Self {
        let mut n = [0u8; 32];
        let nb = name.as_bytes();
        let nl = nb.len().min(32);
        n[..nl].copy_from_slice(&nb[..nl]);
        let mut u = [0u8; 128];
        let ub = uri.as_bytes();
        let ul = ub.len().min(128);
        u[..ul].copy_from_slice(&ub[..ul]);
        Self { version: Self::VERSION, flags, admin, name: n, uri: u }
    }

    /// Parse a manifest account that must be owned by `hook_program`.
    pub fn read(info: &AccountInfo, hook_program: &Pubkey) -> Result<Self> {
        require_keys_eq!(*info.owner, *hook_program, InterfaceError::ManifestOwner);
        let data = info.try_borrow_data()?;
        require!(data.len() >= Self::ACCOUNT_SIZE, InterfaceError::ManifestSize);
        require!(data[..8] == MANIFEST_DISC, InterfaceError::ManifestDiscriminator);
        let mut slice: &[u8] = &data[8..];
        let m = Self::deserialize(&mut slice).map_err(|_| InterfaceError::ManifestDecode)?;
        require!(m.version == Self::VERSION, InterfaceError::ManifestVersion);
        require!(m.flags & !ALL_FLAGS == 0, InterfaceError::UnknownFlags);
        Ok(m)
    }
}

// ---------------------------------------------------------------------------
// Pool state, shared so hooks can read account 0 without the pool crate.
// The pool program wraps this in `#[account] pub struct Pool { pub data: PoolData }`.
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct PoolData {
    pub bump: u8,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub lp_mint: Pubkey,
    pub lp_lock: Pubkey,
    pub base_token_program: Pubkey,
    pub quote_token_program: Pubkey,
    pub lp_fee_bps: u16,
    pub hook_program: Pubkey,
    pub hook_flags: u32,
    pub hook_extra_metas: Pubkey,
    pub hook_quote_treasury: Pubkey,
    pub hook_kind: u8,
    pub reserve_base: u64,
    pub reserve_quote: u64,
    pub protocol_fees_base: u64,
    pub protocol_fees_quote: u64,
    /// Hook fees charged so far, paid or still owed.
    pub hook_fees_quote_total: u64,
    pub volume_quote_total: u64,
    pub swap_count: u64,
    pub created_slot: u64,
    pub creator: Pubkey,
    /// Hook fees charged while the treasury account did not exist. They wait in the quote
    /// vault, outside the reserves, and are paid by the next swap that finds the treasury
    /// or by `collect_hook_fees`.
    pub hook_fees_owed_quote: u64,
    /// The wallet whose associated token account the hook treasury is, so that anyone can
    /// recreate that account. All zeros when the hook takes no fee.
    pub hook_treasury_owner: Pubkey,
    /// Quote counted in the price while the pool is on the curve, and not in the vault:
    /// the price is `(reserve_quote + virtual_quote) / reserve_base`, a sell is paid from
    /// `reserve_quote` alone. 0 on a seeded pool and after graduation.
    pub virtual_quote: u64,
    /// The real quote reserve at which `graduate` is allowed. 0 on a seeded pool and
    /// after graduation.
    pub graduation_target: u64,
    /// Share of the target, in basis points, that graduation takes for the platform.
    pub graduation_fee_bps: u16,
    /// `CURVE_NONE`, `CURVE_OPEN` or `CURVE_GRADUATED`.
    pub curve_state: u8,
    pub reserved: [u8; 5],
}

impl PoolData {
    /// sha256("account:Pool")[..8], the discriminator the pool program writes.
    pub const DISC: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];

    pub fn has_hook(&self) -> bool {
        self.hook_program != Pubkey::default()
    }

    /// The quote reserve the price is made of: the real one plus the virtual one. A hook
    /// that wants the price divides this by `reserve_base`. On a seeded pool and after
    /// graduation it is `reserve_quote`. Checked: fails only when the sum passes u64.
    pub fn effective_quote(&self) -> Result<u64> {
        self.reserve_quote.checked_add(self.virtual_quote).ok_or_else(|| InterfaceError::QuoteOverflow.into())
    }

    /// True while the pool prices with a virtual quote and refuses liquidity.
    pub fn on_curve(&self) -> bool {
        self.curve_state == CURVE_OPEN
    }

    /// Read a Pool account owned by the pool program (account 0 of every callback).
    pub fn read(info: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*info.owner, ID, InterfaceError::PoolOwner);
        let data = info.try_borrow_data()?;
        require!(data.len() >= 8 + Self::INIT_SPACE, InterfaceError::PoolSize);
        require!(data[..8] == Self::DISC, InterfaceError::PoolDiscriminator);
        let mut slice: &[u8] = &data[8..];
        Self::deserialize(&mut slice).map_err(|_| InterfaceError::PoolDecode.into())
    }
}

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

pub fn platform_address() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[PLATFORM_SEED], &ID)
}
pub fn pool_address(base_mint: &Pubkey, quote_mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_SEED, base_mint.as_ref(), quote_mint.as_ref()], &ID)
}
/// The address the pool program signs with when it calls `hook_program`, and only then:
/// `["caller", hook_program]` under the pool program.
///
/// It is one address per hook on purpose. A program that is called with a signer can pass
/// that signer on in a call of its own. With a single caller address for every hook, any
/// hook the pool calls could have forwarded the pool's signature to another hook's
/// callback, with accounts and a payload of its choosing. With one address per hook, the
/// signature a hook receives is worth nothing anywhere else.
///
/// A pool without a hook has the system program (all zeros) as its hook program; the
/// address still derives, and nothing is ever signed with it.
pub fn caller_address(hook_program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CALLER_SEED, hook_program.as_ref()], &ID)
}
pub fn vault_address(pool: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, pool.as_ref(), mint.as_ref()], &ID)
}
pub fn lp_mint_address(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[LP_MINT_SEED, pool.as_ref()], &ID)
}
pub fn lp_lock_address(pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[LP_LOCK_SEED, pool.as_ref()], &ID)
}
/// Signer a hook uses for `hook_swap`. Lives under the HOOK program.
pub fn hook_authority_address(pool: &Pubkey, hook_program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[HOOK_AUTHORITY_SEED, pool.as_ref()], hook_program)
}
pub fn event_authority_address(program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[EVENT_AUTHORITY_SEED], program).0
}
pub fn manifest_address(hook_program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[MANIFEST_SEED], hook_program)
}
pub fn extra_metas_address(hook_program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[EXTRA_METAS_SEED], hook_program)
}

/// Address of the loader-v3 ProgramData account of `program_id`.
pub fn program_data_address(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[program_id.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )
    .0
}

/// Upgrade authority stored in a loader-v3 ProgramData account. `None` = frozen.
/// bincode layout: u32 variant (3) | u64 slot | u8 option tag | 32-byte pubkey.
pub fn v3_upgrade_authority(program_data: &AccountInfo) -> Result<Option<Pubkey>> {
    require_keys_eq!(
        *program_data.owner,
        anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        InterfaceError::ProgramData
    );
    let pd = program_data.try_borrow_data()?;
    require!(pd.len() >= 45, InterfaceError::ProgramData);
    let variant = u32::from_le_bytes(pd[0..4].try_into().unwrap());
    require!(variant == 3, InterfaceError::ProgramData);
    match pd[12] {
        0 => Ok(None),
        1 => Ok(Some(Pubkey::new_from_array(pd[13..45].try_into().unwrap()))),
        _ => Err(InterfaceError::ProgramData.into()),
    }
}

/// For one-time setup instructions: the signer must be the program's own upgrade
/// authority, so nobody can front-run a fresh deploy.
pub fn require_upgrade_authority(
    program_id: &Pubkey,
    program_data: &AccountInfo,
    signer: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        program_data.key(),
        program_data_address(program_id),
        InterfaceError::ProgramData
    );
    let auth = v3_upgrade_authority(program_data)?;
    require!(auth == Some(*signer), InterfaceError::NotUpgradeAuthority);
    Ok(())
}

/// Hooks call this first in every callback, with their own program id:
/// `verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?`.
///
/// It proves that the pool program is calling THIS hook: `hook_caller` must be the pool
/// program's caller address for `hook_program` and must have signed. A call that another
/// hook forwards carries that other hook's caller address and fails here.
///
/// What it does not prove: which pool the call is about. A hook program can forward the
/// signature it received to itself. A callback that writes state for the pool in account
/// 0 should take what it can from that Pool account (`PoolData::read`), which only the
/// pool program writes, rather than from the payload alone.
pub fn verify_caller(hook_caller: &AccountInfo, hook_program: &Pubkey) -> Result<()> {
    require!(hook_caller.is_signer, InterfaceError::CallerNotSigner);
    let (expected, _) = caller_address(hook_program);
    require_keys_eq!(*hook_caller.key, expected, InterfaceError::CallerMismatch);
    Ok(())
}

/// Size in bytes of an extra-metas account holding `n` entries.
pub fn extra_metas_size(n: usize) -> Result<usize> {
    ExtraAccountMetaList::size_of(n).map_err(|_| InterfaceError::ExtraMetas.into())
}

/// Write `metas` into a freshly allocated extra-metas account.
pub fn init_extra_metas(data: &mut [u8], metas: &[ExtraAccountMeta]) -> Result<()> {
    ExtraAccountMetaList::init::<CallbackInstruction>(data, metas)
        .map_err(|_| InterfaceError::ExtraMetas.into())
}

/// A per-pool config PDA `[seed, pool]` under the hook program, the most common extra account.
/// The packed seeds of one entry must fit in 32 bytes, so `seed` is at most 28 bytes here.
pub fn per_pool_config_meta(seed: &[u8], is_writable: bool) -> Result<ExtraAccountMeta> {
    ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal { bytes: seed.to_vec() },
            Seed::AccountKey { index: CB_IDX_POOL },
        ],
        false,
        is_writable,
    )
    .map_err(|_| InterfaceError::ExtraMetas.into())
}

/// A per-trader PDA `[seed, pool, user]` under the hook program: an account the hook keeps
/// for each wallet on each pool (points, a ticket, a counter). `user` is account 2 of the
/// callback, the wallet that signs the swap, so the pool and every client derive the right
/// address for whoever trades. `seed` is at most 26 bytes (the packed seeds of one entry
/// must fit in 32).
///
/// A hook never gets the trader's signature, so it cannot create this account in a
/// callback. The trader opens it with an ordinary instruction of the hook. Until then the
/// address holds nothing: declare it as an `UncheckedAccount` in the callback and check
/// its owner by hand, or every trade by a wallet without one fails.
pub fn per_user_meta(seed: &[u8], is_writable: bool) -> Result<ExtraAccountMeta> {
    ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal { bytes: seed.to_vec() },
            Seed::AccountKey { index: CB_IDX_POOL },
            Seed::AccountKey { index: CB_IDX_USER },
        ],
        false,
        is_writable,
    )
    .map_err(|_| InterfaceError::ExtraMetas.into())
}

#[error_code]
pub enum InterfaceError {
    #[msg("hook_caller is not a signer")]
    CallerNotSigner,
    #[msg("hook_caller is not the pool program's caller PDA for this hook")]
    CallerMismatch,
    #[msg("manifest is not owned by the hook program")]
    ManifestOwner,
    #[msg("manifest account too small")]
    ManifestSize,
    #[msg("manifest discriminator mismatch")]
    ManifestDiscriminator,
    #[msg("manifest could not be decoded")]
    ManifestDecode,
    #[msg("manifest version not supported")]
    ManifestVersion,
    #[msg("manifest uses flags the pool does not know")]
    UnknownFlags,
    #[msg("pool account not owned by the pool program")]
    PoolOwner,
    #[msg("pool account too small")]
    PoolSize,
    #[msg("pool discriminator mismatch")]
    PoolDiscriminator,
    #[msg("pool account could not be decoded")]
    PoolDecode,
    #[msg("extra account metas error")]
    ExtraMetas,
    #[msg("program data account is wrong or could not be parsed")]
    ProgramData,
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("reserve_quote + virtual_quote does not fit in 64 bits")]
    QuoteOverflow,
}

// `burn_lowered` is the last item of this file on purpose. Programs that do not use it are
// built from the same lines as before it existed: Anchor writes the line number of every
// error into a program, so code added above would change the bytes of all of them.
//
// A note on `burn_step`: its sum `then + slack` can pass u128 when both factors of `then`
// are near u64::MAX. Stopping at the largest number is exact there too: `now` is a product
// of two u64 values, so it is below 2^128 and below the true sum.

/// What the observation becomes when a trade starts below the observed price: `Some((
/// obs_reserve_base, obs_reserve_quote))` to write, with `obs_slot` left as it is, or
/// `None` when the trade does not start below it (or there is no observation yet). A hook
/// that buys against an observation calls this in `before_swap` with the payload's
/// reserves.
///
/// ```text
/// quote = min(reserve_quote, obs_reserve_quote)
/// base  = ceil(quote * reserve_base / reserve_quote)
/// ```
///
/// The lowering moves the PRICE and never raises the DEPTH. The price becomes the one
/// the trade starts at. The depth, which `burn_step` measures the cap on, is the observed
/// quote reserve, or the pool's when that is smaller. If the pool's reserves were simply
/// copied, a wallet could add liquidity, nudge the price below the observation with a
/// small sell, and have a second small sell write the deepened pool into the observation
/// with its old slot: the next buy would spend a slice of that deepened pool, all in one
/// transaction.
///
/// The base side is rounded UP, so that the stored price `quote / base` is never above
/// the price the trade started at: rounded down it would be, by a hair, and a second
/// trade at the same price would find the price "fell" again. Rounded up, a trade at the
/// same price changes nothing more. When the pool is not deeper than the observation the
/// division is exact and the result is the pool's own two reserves. Neither number can
/// be zero: `quote` is the smaller of two reserves that are not zero, and the ceiling of a
/// positive number is at least one. `base` is at most `reserve_base`, so it fits.
pub fn burn_lowered(obs_reserve_base: u64, obs_reserve_quote: u64, reserve_base: u64, reserve_quote: u64) -> Option<(u64, u64)> {
    if reserve_base == 0 || reserve_quote == 0 || !burn_price_fell(obs_reserve_base, obs_reserve_quote, reserve_base, reserve_quote) {
        return None;
    }
    let quote = reserve_quote.min(obs_reserve_quote);
    let base = (quote as u128 * reserve_base as u128).div_ceil(reserve_quote as u128) as u64;
    Some((base, quote))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The five fixed accounts of a callback, in the order the pool passes them.
    fn fixed() -> [Pubkey; 5] {
        [
            Pubkey::new_unique(), // 0 pool
            Pubkey::new_unique(), // 1 hook_caller (not used by the resolver)
            Pubkey::new_unique(), // 2 user
            Pubkey::new_unique(), // 3 quote_mint
            Pubkey::new_unique(), // 4 base_mint
        ]
    }

    /// Resolve one entry the way the pool and the clients do: against the fixed accounts.
    fn resolve(meta: &ExtraAccountMeta, hook: &Pubkey, keys: &[Pubkey; 5]) -> (Pubkey, bool, bool) {
        let m = meta.resolve(&[], hook, |i| keys.get(i).map(|k| (k, None))).unwrap();
        (m.pubkey, m.is_signer, m.is_writable)
    }

    #[test]
    fn the_burn_cap_follows_the_fees_of_a_buy_and_a_sell() {
        // protocol 0.2%, pool 0.3%, 1% on each side: sure 220, soft 80, a quarter of 300
        // is 75, the ceiling is 50
        assert_eq!(burn_cap_bps(20, 30, 100, 100), 50);
        // protocol 0.2%, no pool fee, 0.05% on sells: sure 25, soft 20, a quarter of 45
        assert_eq!(burn_cap_bps(20, 0, 0, 5), 11);
        assert_eq!(burn_cap_bps(20, 0, 0, 0), 10);
        // a hook fee is paid in full by everybody: sure 80, soft 20
        assert_eq!(burn_cap_bps(20, 0, 60, 0), 25);
        // the soft fees count only up to the sure ones: sure 20, soft 80, 20 count
        assert_eq!(burn_cap_bps(20, 30, 0, 0), 10);
        // so a pool fee of 10% gives no more than no pool fee at all
        assert_eq!(burn_cap_bps(20, 1_000, 0, 0), 10);
        assert_eq!(burn_cap_bps(20, 5, 0, 0), 10);
        // exactly at the ceiling, and one below
        assert_eq!(burn_cap_bps(20, 30, 50, 50), 50);
        assert_eq!(burn_cap_bps(20, 30, 50, 49), 49);
        // nearly free pools: the floor
        assert_eq!(burn_cap_bps(0, 0, 0, 0), 1);
        assert_eq!(burn_cap_bps(0, 1_000, 0, 0), 1);
        assert_eq!(burn_cap_bps(1, 1_000, 0, 0), 1);
        assert_eq!(burn_cap_bps(0, 0, 3, 4), 1);
        assert_eq!(burn_cap_bps(0, 0, 4, 4), 2);
        // no overflow at the largest inputs
        assert_eq!(burn_cap_bps(u16::MAX, u16::MAX, u16::MAX, u16::MAX), 50);
    }

    #[test]
    fn a_buy_needs_an_old_observation_a_price_that_did_not_run_and_measures_on_the_smaller_depth() {
        use BurnStep::*;
        let (b, q) = (1_000_000_000_000u64, 100_000_000_000u64);
        // no observation yet: record one
        assert_eq!(burn_step(0, 0, 0, b, q, 1_000, 50), Observe);
        assert_eq!(burn_step(b, 0, 990, b, q, 1_000, 50), Observe);
        // too recent, to the slot
        assert_eq!(burn_step(b, q, 1_000, b, q, 1_000, 50), TooSoon);
        assert_eq!(burn_step(b, q, 1_000, b, q, 1_024, 50), TooSoon);
        assert_eq!(burn_step(b, q, 1_000, b, q, 1_025, 50), Buy { max_spend: q / 200 });
        // an observation taken in slot zero is an observation
        assert_eq!(burn_step(b, q, 0, b, q, 24, 50), TooSoon);
        assert_eq!(burn_step(b, q, 0, b, q, 25, 50), Buy { max_spend: q / 200 });

        // the price: tolerance is twice the cap, 1% at a cap of 50 bps
        assert_eq!(burn_tolerance_bps(50), 100);
        // quote reserve 1% higher at the same base reserve: exactly at the tolerance
        assert_eq!(burn_step(b, q, 0, b, q + q / 100, 100, 50), Buy { max_spend: q / 200 });
        // one unit more: the price ran away
        assert_eq!(burn_step(b, q, 0, b, q + q / 100 + 1, 100, 50), Wait);
        // a real buy of 1% of the reserve moves the price by 2%: wait
        assert_eq!(burn_step(b, q, 0, b - b / 101, q + q / 100, 100, 50), Wait);
        // a price that fell is fine, and the smaller quote reserve is the measure
        assert_eq!(burn_step(b, q, 0, b * 2, q / 2, 100, 50), Buy { max_spend: q / 2 / 200 });

        // liquidity added since the observation: same price, deeper pool. The cap stays
        // on the observed depth.
        assert_eq!(burn_step(b, q, 0, b * 12, q * 12, 100, 50), Buy { max_spend: q / 200 });
        // liquidity removed since: the cap follows the smaller pool
        assert_eq!(burn_step(b * 12, q * 12, 0, b, q, 100, 50), Buy { max_spend: q / 200 });

        // a smaller cap is a tighter tolerance: 11 bps, 22 bps of price
        assert_eq!(burn_step(b, q, 0, b, q + q * 22 / 10_000, 100, 11), Buy { max_spend: q * 11 / 10_000 });
        assert_eq!(burn_step(b, q, 0, b, q + q * 23 / 10_000, 100, 11), Wait);
        // at least one unit
        assert_eq!(burn_step(1_000, 1_000, 0, 1_000, 1_000, 100, 1), Buy { max_spend: 1 });
        // the largest reserves do not overflow
        let m = u64::MAX;
        assert_eq!(burn_step(m, m, 0, m, m, 100, 50), Buy { max_spend: (m as u128 * 50 / 10_000) as u64 });
        assert_eq!(burn_step(m, 1, 0, 1, m, 100, 50), Wait);
        assert_eq!(burn_step(1, m, 0, m, 1, 100, 50), Buy { max_spend: 1 });
    }

    #[test]
    fn a_trade_that_starts_below_the_observed_price_lowers_the_observation() {
        let (b, q) = (1_000_000_000_000u64, 100_000_000_000u64);
        // the same pool, a deeper pool at the same price, a higher price: no
        assert!(!burn_price_fell(b, q, b, q));
        assert!(!burn_price_fell(b, q, 12 * b, 12 * q));
        assert!(!burn_price_fell(b, q, b, q + 1));
        assert!(!burn_price_fell(b, q, b - 1, q));
        // one unit of quote less, or one coin more: yes
        assert!(burn_price_fell(b, q, b, q - 1));
        assert!(burn_price_fell(b, q, b + 1, q));
        // a deeper pool at a lower price: yes, whatever its depth
        assert!(burn_price_fell(b, q, 12 * b + 12, 12 * q));
        // no observation yet: nothing to lower
        assert!(!burn_price_fell(0, 0, b, q));
        assert!(!burn_price_fell(b, 0, b, q));
        assert!(!burn_price_fell(0, q, b, q));
        // the largest reserves do not overflow
        let m = u64::MAX;
        assert!(!burn_price_fell(m, m, m, m));
        assert!(burn_price_fell(1, m, m, 1));
        assert!(!burn_price_fell(m, 1, 1, m));
    }

    #[test]
    fn the_lowering_moves_the_price_and_never_raises_the_depth() {
        let (b, q) = (1_000_000_000_000u64, 100_000_000_000u64);
        // nothing to lower: the same price, a higher price, no observation, an empty pool
        assert_eq!(burn_lowered(b, q, b, q), None);
        assert_eq!(burn_lowered(b, q, 12 * b, 12 * q), None);
        assert_eq!(burn_lowered(b, q, b, q + 1), None);
        assert_eq!(burn_lowered(0, 0, b, q), None);
        assert_eq!(burn_lowered(b, q, 0, q), None);
        assert_eq!(burn_lowered(b, q, b, 0), None);
        // a pool that is not deeper than the observation: its own two reserves, exactly
        assert_eq!(burn_lowered(b, q, b, q - 1), Some((b, q - 1)));
        assert_eq!(burn_lowered(b, q, b + 1, q), Some((b + 1, q)));
        assert_eq!(burn_lowered(b, q, b / 2 + 7, q / 4), Some((b / 2 + 7, q / 4)));
        // a pool twelve times deeper, one unit of price lower: the observed depth stays,
        // the base follows the pool's price, rounded up
        let (rb, rq) = (12 * b + 12, 12 * q);
        let (nb, nq) = burn_lowered(b, q, rb, rq).unwrap();
        assert_eq!(nq, q, "the depth is not raised");
        assert_eq!(nb, b + 1);
        // checked over a spread of pools: the properties the rule is there for
        let mut x = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let (mut lowered, mut bought) = (0, 0);
        for i in 0..200_000u32 {
            // reserves of every size, from a few units to the whole of u64
            let shift = |v: u64, s: u64| (v >> (s % 63)).max(1);
            let (ob, oq, rb, rq) = (shift(next(), next()), shift(next(), next()), shift(next(), next()), shift(next(), next()));
            // every fourth case: a deeper pool at nearly the observed price
            let (rb, rq) = if i % 4 == 0 { (ob.saturating_mul(7).saturating_add(next() % 5), oq.saturating_mul(7)) } else { (rb, rq) };
            let Some((nb, nq)) = burn_lowered(ob, oq, rb, rq) else {
                assert!(!burn_price_fell(ob, oq, rb, rq));
                continue;
            };
            lowered += 1;
            assert!(nb > 0 && nq > 0, "never a zero");
            assert!(nq <= oq && nq <= rq, "the depth is never raised");
            assert!(nb <= rb);
            // the stored price is not above the price the trade started at ...
            assert!(nq as u128 * rb as u128 <= nb as u128 * rq as u128);
            // ... so the same trade again changes nothing more
            assert_eq!(burn_lowered(nb, nq, rb, rq), None);
            // and it is below the price that was observed
            assert!((nq as u128 * ob as u128) < (oq as u128 * nb as u128));
            // one unit of base less would put it above the trade's price
            if nb > 1 {
                assert!(nq as u128 * rb as u128 > (nb - 1) as u128 * rq as u128);
            }
            // what a buy may spend against it is a slice of the smaller depth
            match burn_step(nb, nq, 0, rb, rq, 100, 50) {
                BurnStep::Buy { max_spend } => {
                    bought += 1;
                    assert!(max_spend <= (oq.min(rq) as u128 * 50 / 10_000).max(1) as u64);
                }
                // Rounding the base up can put the stored price below the pool's by one
                // part in `base`. Only when the base side is a hundred units or less is
                // that more than the tolerance of 1%: such a pool cannot price to 1%
                // itself. The buy then waits one interval, which is the safe side.
                step => assert!(step == BurnStep::Wait && nb <= 100, "{step:?} with a base of {nb}"),
            }
        }
        assert!(lowered > 50_000 && bought > 40_000, "{lowered} {bought}");
    }

    #[test]
    fn the_price_check_is_exact_for_the_largest_reserves() {
        // then + slack passes u128 when both factors are near u64::MAX. The answer "the
        // price did not run away" is the true one there: `now` cannot reach that sum.
        let m = u64::MAX;
        let then = m as u128 * m as u128;
        assert!(then.checked_add(then / 100).is_none(), "this is the case in which the sum does not fit");
        for (rq, ob) in [(m, m), (m, 1), (1, m), (m - 1, m)] {
            assert!(rq as u128 * ob as u128 <= then);
            assert!(matches!(burn_step(ob, m, 0, m, rq, 100, 50), BurnStep::Buy { .. }));
        }
        // just below that, where the sum fits, a price that ran away is still seen
        let h = m / 2;
        assert_eq!(burn_step(h, h, 0, h / 2, h, 100, 50), BurnStep::Wait);
        assert_eq!(burn_step(1, h, 0, 1, m, 100, 50), BurnStep::Wait);
    }

    #[test]
    fn every_hook_has_a_caller_address_of_its_own() {
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        let (ca, bump) = caller_address(&a);
        assert_eq!(ca, Pubkey::create_program_address(&[CALLER_SEED, a.as_ref(), &[bump]], &ID).unwrap());
        assert_ne!(ca, caller_address(&b).0);
        // not the single address every hook shared before
        assert_ne!(ca, Pubkey::find_program_address(&[CALLER_SEED], &ID).0);
        // a pool without a hook: the system program's id, all zeros, derives like any other
        let none = caller_address(&Pubkey::default()).0;
        assert_ne!(none, ca);
        assert_eq!(none, Pubkey::find_program_address(&[CALLER_SEED, &[0u8; 32]], &ID).0);
    }

    #[test]
    fn verify_caller_wants_this_hooks_address_and_its_signature() {
        let (hook, other) = (Pubkey::new_unique(), Pubkey::new_unique());
        let owner = Pubkey::default();
        let check = |key: Pubkey, is_signer: bool, hook: &Pubkey| {
            let (mut lamports, mut data) = (0u64, [0u8; 0]);
            let info = AccountInfo::new(&key, is_signer, false, &mut lamports, &mut data, &owner, false);
            verify_caller(&info, hook)
        };
        assert!(check(caller_address(&hook).0, true, &hook).is_ok());
        // the right address without its signature
        assert!(check(caller_address(&hook).0, false, &hook).is_err());
        // the signature the pool gives to ANOTHER hook, forwarded here
        assert!(check(caller_address(&other).0, true, &hook).is_err());
        // any other signer
        assert!(check(Pubkey::new_unique(), true, &hook).is_err());
    }

    #[test]
    fn per_pool_config_meta_is_the_pda_of_seed_and_pool() {
        let hook = Pubkey::new_unique();
        let keys = fixed();
        let (key, signer, writable) = resolve(&per_pool_config_meta(b"cfg", false).unwrap(), &hook, &keys);
        assert_eq!(key, Pubkey::find_program_address(&[b"cfg", keys[0].as_ref()], &hook).0);
        assert!(!signer && !writable);
        let (_, signer, writable) = resolve(&per_pool_config_meta(b"cfg", true).unwrap(), &hook, &keys);
        assert!(!signer && writable);
    }

    #[test]
    fn per_user_meta_is_the_pda_of_seed_pool_and_trader() {
        let hook = Pubkey::new_unique();
        let keys = fixed();
        let (key, signer, writable) = resolve(&per_user_meta(b"points", true).unwrap(), &hook, &keys);
        let expected = Pubkey::find_program_address(
            &[b"points", keys[CB_IDX_POOL as usize].as_ref(), keys[CB_IDX_USER as usize].as_ref()],
            &hook,
        )
        .0;
        assert_eq!(key, expected);
        assert!(!signer, "an extra account is never a signer");
        assert!(writable);
        let (_, _, writable) = resolve(&per_user_meta(b"points", false).unwrap(), &hook, &keys);
        assert!(!writable);

        // another trader on the same pool gets another address
        let mut other = keys;
        other[CB_IDX_USER as usize] = Pubkey::new_unique();
        let (key2, _, _) = resolve(&per_user_meta(b"points", true).unwrap(), &hook, &other);
        assert_ne!(key, key2);
    }

    #[test]
    fn seeds_of_one_entry_must_fit_in_32_bytes() {
        assert!(per_pool_config_meta(&[7u8; 28], false).is_ok());
        assert!(per_pool_config_meta(&[7u8; 29], false).is_err());
        assert!(per_user_meta(&[7u8; 26], false).is_ok());
        assert!(per_user_meta(&[7u8; 27], false).is_err());
    }

    #[test]
    fn the_list_account_holds_exactly_the_entries_it_was_sized_for() {
        let metas = [per_pool_config_meta(b"cfg", true).unwrap(), per_user_meta(b"points", true).unwrap()];
        let mut data = vec![0u8; extra_metas_size(2).unwrap()];
        init_extra_metas(&mut data, &metas).unwrap();
        // one entry too many for the space that was allocated
        let mut small = vec![0u8; extra_metas_size(1).unwrap()];
        assert!(init_extra_metas(&mut small, &metas).is_err());
    }
}
