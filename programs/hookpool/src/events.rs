use anchor_lang::prelude::*;

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub creator: Pubkey,
    pub hook_program: Pubkey,
    pub hook_flags: u32,
    pub hook_kind: u8,
    pub lp_fee_bps: u16,
    pub base_amount: u64,
    pub quote_amount: u64,
    pub lp_minted: u64,
    pub slot: u64,
}

#[event]
pub struct Swapped {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub direction: u8,
    pub amount_in: u64,
    pub amount_out: u64,
    pub protocol_fee: u64,
    pub hook_fee: u64,
    pub lp_fee: u64,
    pub fee_bps_applied: u16,
    pub reserve_base: u64,
    pub reserve_quote: u64,
    pub slot: u64,
    pub by_hook: bool,
}

#[event]
pub struct LiquidityChanged {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub added: bool,
    pub base_amount: u64,
    pub quote_amount: u64,
    pub lp_amount: u64,
    pub reserve_base: u64,
    pub reserve_quote: u64,
    pub slot: u64,
}

#[event]
pub struct PlatformUpdated {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_bps: u16,
    pub max_lp_fee_bps: u16,
    pub max_hook_fee_bps: u16,
    pub max_fee_override_bps: u16,
    pub launch_fee_lamports: u64,
    pub paused: bool,
    pub whitelist: Vec<Pubkey>,
}

/// A hook program was put on the approved list (`approved`) or taken off it. `count` is the
/// length of the list after the change.
#[event]
pub struct HookApprovalChanged {
    pub program: Pubkey,
    pub approved: bool,
    pub count: u32,
}

/// The approved-list rule was switched on or off.
#[event]
pub struct HookApprovalRequiredChanged {
    pub required: bool,
}

/// Hook fees that had waited for a closed treasury were paid to it.
#[event]
pub struct HookFeesCollected {
    pub pool: Pubkey,
    pub treasury: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ProtocolFeesCollected {
    pub pool: Pubkey,
    pub base_amount: u64,
    pub quote_amount: u64,
}

/// A pool opened on the curve (right after its `PoolCreated`): the settings it was given.
#[event]
pub struct CurveOpened {
    pub pool: Pubkey,
    pub virtual_quote: u64,
    pub graduation_target: u64,
    pub graduation_fee_bps: u16,
    pub slot: u64,
}

/// A pool graduated: the virtual quote is gone, the fee left the reserve, and enough coins
/// were burned from the vault to keep the price.
#[event]
pub struct Graduated {
    pub pool: Pubkey,
    pub reserve_quote_before: u64,
    pub reserve_quote_after: u64,
    pub reserve_base_before: u64,
    pub reserve_base_after: u64,
    pub burned_base: u64,
    pub fee_quote: u64,
    pub slot: u64,
}
