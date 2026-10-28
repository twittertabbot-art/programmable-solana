//! hook_launch_guard: platform template hook.
//!
//! Anti-snipe. For the first `guard_slots` after the pool is created, buys pay an
//! LP fee that starts at `start_fee_bps` and decays linearly to the pool's normal
//! fee. The extra fee stays in the pool, so it deepens the liquidity every holder
//! sits on. Sells are never touched (no CALL_ON_SELL). Nothing is configurable
//! after creation: there is no owner.
//!
//! A pool fee goes to every LP share, so while the window runs nobody can ADD liquidity
//! (BEFORE_ADD_LIQ): otherwise a wallet could add liquidity in the launch slot and take
//! most of a sniper's fee out again. The pool's own first liquidity comes in through
//! `create_pool`, which is not an add. Removing liquidity is never refused.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use hookpool_interface::*;

declare_id!("G59xnMnbenifbGR1y6QjaTRa6wa1FFfqZB3KZBUyckPW");

pub const CFG_SEED: &[u8] = b"cfg";
pub const FLAGS: u32 = BEFORE_SWAP | BEFORE_ADD_LIQ | ON_POOL_CREATE | OVERRIDE_FEE | CALL_ON_BUY;
/// Matches the platform's launch-time max_fee_override_bps so guarded buys never fail.
pub const MAX_START_FEE_BPS: u16 = 5_000;
pub const MAX_GUARD_SLOTS: u64 = 10_800; // about 1h12m at 400ms

#[account]
#[derive(InitSpace)]
pub struct HookManifest {
    pub version: u8,
    pub flags: u32,
    pub admin: Option<Pubkey>,
    pub name: [u8; 32],
    pub uri: [u8; 128],
}

#[account]
#[derive(InitSpace)]
pub struct GuardConfig {
    pub bump: u8,
    pub pool: Pubkey,
    /// Set by on_pool_create. 0 until then.
    pub start_slot: u64,
    pub guard_slots: u64,
    pub start_fee_bps: u16,
    /// Who paid for this config. Must be the pool creator.
    pub creator: Pubkey,
}

#[error_code]
pub enum GuardError {
    #[msg("start fee above the maximum")]
    StartFeeTooHigh,
    #[msg("guard window too long")]
    WindowTooLong,
    #[msg("guard window must be at least one slot")]
    WindowTooShort,
    #[msg("config does not belong to this pool")]
    WrongPool,
    #[msg("config already armed")]
    AlreadyArmed,
    #[msg("config was not created by the pool creator")]
    WrongCreator,
    #[msg("this pool does not run this hook")]
    WrongHook,
    #[msg("liquidity cannot be added while the guard window runs")]
    LiquidityInGuardWindow,
}

#[program]
pub mod hook_launch_guard {
    use super::*;

    pub fn init_manifest(ctx: Context<InitManifest>, uri: String) -> Result<()> {
        require_upgrade_authority(
            &crate::ID,
            &ctx.accounts.program_data.to_account_info(),
            &ctx.accounts.authority.key(),
        )?;
        let m = HookManifestData::new(FLAGS, None, "Programmable launch guard", &uri);
        let man = &mut ctx.accounts.manifest;
        man.version = m.version;
        man.flags = m.flags;
        man.admin = m.admin;
        man.name = m.name;
        man.uri = m.uri;
        // Writable: on_pool_create stamps the start slot.
        let metas = [per_pool_config_meta(CFG_SEED, true)?];
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        init_extra_metas(&mut data, &metas)
    }

    pub fn init_pool_config(
        ctx: Context<InitPoolConfig>,
        pool: Pubkey,
        guard_slots: u64,
        start_fee_bps: u16,
    ) -> Result<()> {
        require!(start_fee_bps <= MAX_START_FEE_BPS, GuardError::StartFeeTooHigh);
        require!(guard_slots >= 1, GuardError::WindowTooShort);
        require!(guard_slots <= MAX_GUARD_SLOTS, GuardError::WindowTooLong);
        let cfg = &mut ctx.accounts.cfg;
        cfg.bump = ctx.bumps.cfg;
        cfg.pool = pool;
        cfg.start_slot = 0;
        cfg.guard_slots = guard_slots;
        cfg.start_fee_bps = start_fee_bps;
        cfg.creator = ctx.accounts.payer.key();
        Ok(())
    }

    pub fn on_pool_create(ctx: Context<Callback>, payload: PoolCreatePayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        // The Pool account is written by the pool program alone. Arming on the payload's
        // word only would arm for a pool that does not exist yet.
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        let cfg = &mut ctx.accounts.cfg;
        require_keys_eq!(cfg.pool, ctx.accounts.pool.key(), GuardError::WrongPool);
        require_keys_eq!(pool.hook_program, crate::ID, GuardError::WrongHook);
        require_keys_eq!(cfg.creator, payload.creator, GuardError::WrongCreator);
        require_keys_eq!(cfg.creator, pool.creator, GuardError::WrongCreator);
        require!(cfg.start_slot == 0, GuardError::AlreadyArmed);
        cfg.start_slot = Clock::get()?.slot;
        Ok(())
    }

    /// No liquidity is added while the guard window runs. Removing is never refused: this
    /// hook has no callback for it.
    pub fn before_add_liquidity(ctx: Context<Callback>, payload: LiquidityPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let cfg = &ctx.accounts.cfg;
        require!(
            payload.slot.saturating_sub(cfg.start_slot) >= cfg.guard_slots,
            GuardError::LiquidityInGuardWindow
        );
        Ok(())
    }

    pub fn before_swap(ctx: Context<Callback>, payload: SwapPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let cfg = &ctx.accounts.cfg;
        if payload.direction != DIRECTION_BUY || cfg.start_slot == 0 {
            return Ok(());
        }
        let fee = guard_fee(
            payload.slot,
            cfg.start_slot,
            cfg.guard_slots,
            cfg.start_fee_bps,
            payload.lp_fee_bps,
        );
        match fee {
            Some(bps) => HookReturn::fee_override(bps).set(),
            None => Ok(()),
        }
    }
}

/// Linear decay from `start_fee` at `start_slot` to `base_fee` at `start_slot + guard_slots`.
/// `None` once the window is over (or if the start fee is not above the base fee).
pub fn guard_fee(
    slot: u64,
    start_slot: u64,
    guard_slots: u64,
    start_fee_bps: u16,
    base_fee_bps: u16,
) -> Option<u16> {
    if start_fee_bps <= base_fee_bps || guard_slots == 0 {
        return None;
    }
    let elapsed = slot.saturating_sub(start_slot);
    if elapsed >= guard_slots {
        return None;
    }
    let span = (start_fee_bps - base_fee_bps) as u128;
    let decayed = span * elapsed as u128 / guard_slots as u128;
    Some(start_fee_bps - decayed as u16)
}

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
    #[account(init, payer = payer, space = 8 + GuardConfig::INIT_SPACE, seeds = [CFG_SEED, pool.as_ref()], bump)]
    pub cfg: Account<'info, GuardConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Callback<'info> {
    /// CHECK: the Pool account.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: verified against the pool program's caller PDA in the handler.
    pub hook_caller: Signer<'info>,
    /// CHECK: the trader.
    pub user: UncheckedAccount<'info>,
    /// CHECK: quote mint.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: base mint.
    pub base_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [CFG_SEED, pool.key().as_ref()], bump = cfg.bump)]
    pub cfg: Account<'info, GuardConfig>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decays_linearly_then_stops() {
        assert_eq!(guard_fee(100, 100, 100, 3_000, 100), Some(3_000));
        assert_eq!(guard_fee(150, 100, 100, 3_000, 100), Some(1_550));
        assert_eq!(guard_fee(199, 100, 100, 3_000, 100), Some(129));
        assert_eq!(guard_fee(200, 100, 100, 3_000, 100), None);
        assert_eq!(guard_fee(5_000, 100, 100, 3_000, 100), None);
    }

    #[test]
    fn no_guard_when_start_not_above_base() {
        assert_eq!(guard_fee(100, 100, 100, 100, 100), None);
        assert_eq!(guard_fee(100, 100, 100, 50, 100), None);
    }
}
