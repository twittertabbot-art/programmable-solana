use anchor_lang::prelude::*;
use hookpool_interface::PoolData;
use std::ops::{Deref, DerefMut};

pub const MAX_WHITELIST: usize = 8;

/// Hard ceilings the admin can never raise past. Protects LPs and traders from us.
pub const HARD_MAX_PROTOCOL_FEE_BPS: u16 = 100; // 1%
pub const HARD_MAX_LP_FEE_BPS: u16 = 2_000; // 20%
pub const HARD_MAX_HOOK_FEE_BPS: u16 = 2_000; // 20%
pub const HARD_MAX_FEE_OVERRIDE_BPS: u16 = 9_000; // 90%, launch guards need very high early fees
/// The most graduation may take for the platform: 10% of the graduation target.
pub const HARD_MAX_GRADUATION_FEE_BPS: u16 = 1_000;

/// LP tokens locked forever at pool creation (Uniswap v2 style) so the first LP
/// cannot inflate the share price.
pub const MINIMUM_LIQUIDITY: u64 = 1_000;
pub const LP_DECIMALS: u8 = 6;

#[account]
#[derive(InitSpace)]
pub struct Platform {
    pub bump: u8,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_bps: u16,
    pub max_lp_fee_bps: u16,
    pub max_hook_fee_bps: u16,
    pub max_fee_override_bps: u16,
    pub launch_fee_lamports: u64,
    pub paused: bool,
    pub whitelist_len: u8,
    pub whitelist: [Pubkey; MAX_WHITELIST],
    pub pool_count: u64,
    /// The curve launch (HOOKS.md section 2): the quote counted in the price of a new curve
    /// pool without being there, and the real quote reserve at which it graduates. Copied
    /// into each curve pool at creation; a later change does not touch running curves.
    /// Either one at 0 switches curve launches off (`CurveDisabled`).
    pub curve_virtual_quote: u64,
    pub curve_graduation_target: u64,
    /// Share of the target taken for the platform at graduation, at most
    /// `HARD_MAX_GRADUATION_FEE_BPS`.
    pub curve_graduation_fee_bps: u16,
    /// When true, a hook that is not the platform's own (HOOK_KIND_FROZEN) opens a pool
    /// only when its program is on the approved list kept after this account's fixed part
    /// (HOOKS.md section 6.1, `crate::approvals`). Taken from the first reserved byte, so a
    /// platform written before it existed reads false: nothing changes until the admin
    /// turns it on.
    pub hook_approval_required: bool,
    pub reserved: [u8; 45],
}

/// The most programs the approved list holds.
pub const MAX_APPROVED_HOOKS: usize = 256;

impl Platform {
    /// True when curve pools may be created.
    pub fn curve_enabled(&self) -> bool {
        self.curve_virtual_quote > 0 && self.curve_graduation_target > 0
    }
}

impl Platform {
    pub fn whitelist(&self) -> &[Pubkey] {
        &self.whitelist[..(self.whitelist_len as usize).min(MAX_WHITELIST)]
    }
    pub fn is_whitelisted(&self, key: &Pubkey) -> bool {
        self.whitelist().iter().any(|k| k == key)
    }
}

/// The pool account. All fields live in the shared `PoolData` so hooks can read
/// them with the interface crate alone. `Deref` keeps `pool.reserve_base` ergonomic.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub data: PoolData,
}

impl Deref for Pool {
    type Target = PoolData;
    fn deref(&self) -> &PoolData {
        &self.data
    }
}
impl DerefMut for Pool {
    fn deref_mut(&mut self) -> &mut PoolData {
        &mut self.data
    }
}
