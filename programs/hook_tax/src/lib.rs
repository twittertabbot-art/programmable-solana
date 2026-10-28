//! hook_tax: platform template hook.
//!
//! Takes `buy_bps` of every buy and `sell_bps` of every sell, always in the quote
//! token, to the pool's hook treasury. The ceiling `max_bps` is fixed when the
//! per-pool config is created and can never be raised. The config owner may lower
//! or raise taxes within the ceiling, or renounce ownership to freeze them.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use hookpool_interface::*;

declare_id!("jwdXDuSQ9pNV1pXj8BFvBb5fhqtTL3duQkwsTjXunhr");

pub const CFG_SEED: &[u8] = b"cfg";
pub const FLAGS: u32 = BEFORE_SWAP | ON_POOL_CREATE | TAKE_HOOK_FEE | CALL_ON_BUY | CALL_ON_SELL;
/// Hard ceiling of the ceiling. Equal to the platform's hook fee cap at launch; the pool
/// clamps anything above the live cap, so a ceiling can never block trades.
pub const HARD_MAX_BPS: u16 = 1_000;

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
pub struct TaxConfig {
    pub bump: u8,
    pub pool: Pubkey,
    /// Pubkey::default() means renounced: taxes can never change again.
    pub owner: Pubkey,
    pub buy_bps: u16,
    pub sell_bps: u16,
    /// Fixed at creation. Neither buy_bps nor sell_bps may ever exceed it.
    pub max_bps: u16,
    /// Who paid for this config. Must be the pool creator, so nobody can squat a future
    /// pool's config with hostile parameters.
    pub creator: Pubkey,
}

#[error_code]
pub enum TaxError {
    #[msg("tax above the ceiling fixed at launch")]
    AboveCeiling,
    #[msg("ceiling above the hard maximum")]
    CeilingTooHigh,
    #[msg("only the config owner can do this")]
    NotOwner,
    #[msg("config is renounced")]
    Renounced,
    #[msg("config does not belong to this pool")]
    WrongPool,
    #[msg("pool has no hook treasury")]
    NoTreasury,
    #[msg("config was not created by the pool creator")]
    WrongCreator,
}

#[program]
pub mod hook_tax {
    use super::*;

    /// One-time: publish the manifest and the extra-accounts list. Upgrade authority only.
    pub fn init_manifest(ctx: Context<InitManifest>, uri: String) -> Result<()> {
        require_upgrade_authority(
            &crate::ID,
            &ctx.accounts.program_data.to_account_info(),
            &ctx.accounts.authority.key(),
        )?;
        let m = HookManifestData::new(FLAGS, None, "Programmable tax", &uri);
        let man = &mut ctx.accounts.manifest;
        man.version = m.version;
        man.flags = m.flags;
        man.admin = m.admin;
        man.name = m.name;
        man.uri = m.uri;

        // Extra account 5: the per-pool config, read-only during callbacks.
        let metas = [per_pool_config_meta(CFG_SEED, false)?];
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        init_extra_metas(&mut data, &metas)
    }

    /// Called by the launcher BEFORE `create_pool`. The pool address is predictable.
    pub fn init_pool_config(
        ctx: Context<InitPoolConfig>,
        pool: Pubkey,
        buy_bps: u16,
        sell_bps: u16,
        max_bps: u16,
    ) -> Result<()> {
        require!(max_bps <= HARD_MAX_BPS, TaxError::CeilingTooHigh);
        require!(buy_bps <= max_bps && sell_bps <= max_bps, TaxError::AboveCeiling);
        let cfg = &mut ctx.accounts.cfg;
        cfg.bump = ctx.bumps.cfg;
        cfg.pool = pool;
        cfg.owner = ctx.accounts.owner.key();
        cfg.buy_bps = buy_bps;
        cfg.sell_bps = sell_bps;
        cfg.max_bps = max_bps;
        cfg.creator = ctx.accounts.payer.key();
        Ok(())
    }

    pub fn set_tax(ctx: Context<OwnerOnly>, buy_bps: u16, sell_bps: u16) -> Result<()> {
        let cfg = &mut ctx.accounts.cfg;
        require!(
            buy_bps <= cfg.max_bps && sell_bps <= cfg.max_bps,
            TaxError::AboveCeiling
        );
        cfg.buy_bps = buy_bps;
        cfg.sell_bps = sell_bps;
        Ok(())
    }

    /// Pass Pubkey::default() to renounce forever.
    pub fn set_owner(ctx: Context<OwnerOnly>, new_owner: Pubkey) -> Result<()> {
        ctx.accounts.cfg.owner = new_owner;
        Ok(())
    }

    // ---- callbacks from the pool program --------------------------------------

    pub fn on_pool_create(ctx: Context<Callback>, payload: PoolCreatePayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        require!(pool.hook_quote_treasury != Pubkey::default(), TaxError::NoTreasury);
        require_keys_eq!(ctx.accounts.cfg.pool, ctx.accounts.pool.key(), TaxError::WrongPool);
        require_keys_eq!(ctx.accounts.cfg.creator, payload.creator, TaxError::WrongCreator);
        // and as the pool program wrote it, not only as the payload says
        require_keys_eq!(ctx.accounts.cfg.creator, pool.creator, TaxError::WrongCreator);
        Ok(())
    }

    pub fn before_swap(ctx: Context<Callback>, payload: SwapPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let cfg = &ctx.accounts.cfg;
        let bps = if payload.direction == DIRECTION_BUY { cfg.buy_bps } else { cfg.sell_bps };
        HookReturn::hook_fee(bps).set()
    }
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
    pub owner: Signer<'info>,
    #[account(init, payer = payer, space = 8 + TaxConfig::INIT_SPACE, seeds = [CFG_SEED, pool.as_ref()], bump)]
    pub cfg: Account<'info, TaxConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CFG_SEED, cfg.pool.as_ref()],
        bump = cfg.bump,
        constraint = cfg.owner != Pubkey::default() @ TaxError::Renounced,
        has_one = owner @ TaxError::NotOwner,
    )]
    pub cfg: Account<'info, TaxConfig>,
}

/// The fixed five accounts every callback receives, then this hook's extras.
#[derive(Accounts)]
pub struct Callback<'info> {
    /// CHECK: the Pool account; read with PoolData::read.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: verified against the pool program's caller PDA in the handler.
    pub hook_caller: Signer<'info>,
    /// CHECK: the trader or LP.
    pub user: UncheckedAccount<'info>,
    /// CHECK: quote mint.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: base mint.
    pub base_mint: UncheckedAccount<'info>,
    #[account(seeds = [CFG_SEED, pool.key().as_ref()], bump = cfg.bump)]
    pub cfg: Account<'info, TaxConfig>,
}
