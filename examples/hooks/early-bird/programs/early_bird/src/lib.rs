//! early_bird: a Programmable hook that changes the POOL FEE and takes nothing for itself.
//!
//! For the first `window_slots` slots after the pool is created, a buy pays only
//! `discount_bps` of the pool's own fee (5000 = half). After the window the hook
//! answers nothing and the pool charges its normal fee. Sells are never touched:
//! the manifest does not carry CALL_ON_SELL, so the pool never calls this program
//! on a sell.
//!
//! Powers used: OVERRIDE_FEE (the answer is a fee override), ON_POOL_CREATE (the
//! callback writes the creation slot into the per-pool config), BEFORE_SWAP and
//! CALL_ON_BUY. No TAKE_HOOK_FEE: this hook can never take a fee for anyone.
//!
//! What can change after the freeze: one Config per pool, written twice in its life
//! (when the launcher creates it, and once by `on_pool_create`). No owner, no setter.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use hookpool_interface::*;

// Replaced by `anchor keys sync` (the build script runs it before every build).
declare_id!("A5qiRWmrYQTLzjtRHNrmqseR6dTtNScUsT7JU6uGFUdJ");

pub const CFG_SEED: &[u8] = b"cfg";

/// What this hook is allowed to do. `create_pool` copies the manifest's flags into the
/// Pool account, and a pool keeps the flags it was created with forever.
pub const FLAGS: u32 = BEFORE_SWAP | ON_POOL_CREATE | OVERRIDE_FEE | CALL_ON_BUY;

/// Longest window a launcher may ask for: about one day at 400 ms per slot.
pub const MAX_WINDOW_SLOTS: u64 = 216_000;
pub const BPS: u64 = 10_000;

/// Every hook publishes this account at PDA ["manifest"]. Keep the name and the fields
/// exactly like this: the pool reads them through `HookManifestData`.
#[account]
#[derive(InitSpace)]
pub struct HookManifest {
    pub version: u8,
    pub flags: u32,
    pub admin: Option<Pubkey>,
    pub name: [u8; 32],
    pub uri: [u8; 128],
}

/// Per-pool parameters, PDA ["cfg", pool]. Created by the launcher before the pool.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub bump: u8,
    pub pool: Pubkey,
    /// Who paid for this config. Must be the pool creator (checked in on_pool_create), so
    /// a pool never starts on parameters somebody else wrote.
    pub creator: Pubkey,
    /// Length of the early window, in slots, counted from `created_slot`.
    pub window_slots: u64,
    /// Share of the pool's own fee an early buyer pays, in bps of that fee. 5000 = half.
    pub discount_bps: u16,
    /// Slot of `create_pool`, written by `on_pool_create`. 0 = the pool does not exist yet.
    pub created_slot: u64,
}

/// Numbered from 7000, not from Anchor's default 6000, so that a number in a failed swap
/// cannot be mistaken for an error of the pool, the launchpad or the interface crate.
#[error_code(offset = 7000)]
pub enum EarlyBirdError {
    #[msg("window longer than the maximum")]
    WindowTooLong,
    #[msg("discount must be at most 10000 bps of the pool fee")]
    DiscountTooHigh,
    #[msg("config does not belong to this pool")]
    WrongPool,
    #[msg("config was not created by the pool creator")]
    WrongCreator,
    #[msg("this config already started its window")]
    AlreadyStarted,
}

#[program]
pub mod early_bird {
    use super::*;

    /// One-time. Run it BEFORE freezing the program: only the upgrade authority may call it.
    pub fn init_manifest(ctx: Context<InitManifest>, name: String, uri: String) -> Result<()> {
        require_upgrade_authority(
            &crate::ID,
            &ctx.accounts.program_data.to_account_info(),
            &ctx.accounts.authority.key(),
        )?;
        // admin = None: this hook declares no operator, and its code has no setter.
        let m = HookManifestData::new(FLAGS, None, &name, &uri);
        let man = &mut ctx.accounts.manifest;
        man.version = m.version;
        man.flags = m.flags;
        man.admin = m.admin;
        man.name = m.name;
        man.uri = m.uri;

        // Extra account 5 of every callback: this pool's Config. WRITABLE, because
        // on_pool_create writes the creation slot into it. One list serves every
        // callback, so the config is passed writable to before_swap too.
        let metas = [per_pool_config_meta(CFG_SEED, true)?];
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        init_extra_metas(&mut data, &metas)
    }

    /// The launcher calls this before `create_pool` with the future pool address.
    pub fn init_pool_config(
        ctx: Context<InitPoolConfig>,
        pool: Pubkey,
        window_slots: u64,
        discount_bps: u16,
    ) -> Result<()> {
        require!(window_slots <= MAX_WINDOW_SLOTS, EarlyBirdError::WindowTooLong);
        require!(discount_bps as u64 <= BPS, EarlyBirdError::DiscountTooHigh);
        let cfg = &mut ctx.accounts.cfg;
        cfg.bump = ctx.bumps.cfg;
        cfg.pool = pool;
        cfg.creator = ctx.accounts.payer.key();
        cfg.window_slots = window_slots;
        cfg.discount_bps = discount_bps;
        cfg.created_slot = 0;
        Ok(())
    }

    // ---- callbacks from the pool program -----------------------------------------

    /// Runs once inside `create_pool`. Starts the window.
    pub fn on_pool_create(ctx: Context<Callback>, payload: PoolCreatePayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let pool_key = ctx.accounts.pool.key();
        let cfg = &mut ctx.accounts.cfg;
        require_keys_eq!(cfg.pool, pool_key, EarlyBirdError::WrongPool);
        require_keys_eq!(cfg.creator, payload.creator, EarlyBirdError::WrongCreator);
        // The same key as the pool program wrote it into the Pool account. The payload is
        // what the caller says; the Pool account is what the pool program did.
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        require_keys_eq!(cfg.creator, pool.creator, EarlyBirdError::WrongCreator);
        require!(cfg.created_slot == 0, EarlyBirdError::AlreadyStarted);
        // PoolCreatePayload carries no slot, so the clock is the source.
        cfg.created_slot = Clock::get()?.slot;
        Ok(())
    }

    /// The answer the pool reads: inside the window, a lower pool fee for this buy.
    pub fn before_swap(ctx: Context<Callback>, payload: SwapPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let cfg = &ctx.accounts.cfg;
        // The pool never calls this on a sell (no CALL_ON_SELL). Belt and braces.
        if payload.direction != DIRECTION_BUY || cfg.created_slot == 0 {
            return Ok(());
        }
        let end = cfg.created_slot.saturating_add(cfg.window_slots);
        if payload.slot >= end {
            // No return data = "no opinion": the pool charges its own fee.
            return Ok(());
        }
        // The override replaces the pool's own fee for this one swap. The pool clamps
        // it to the platform's cap; 0 is a valid answer.
        let early_fee = (payload.lp_fee_bps as u64) * (cfg.discount_bps as u64) / BPS;
        HookReturn::fee_override(early_fee as u16).set()
    }
}

#[derive(Accounts)]
pub struct InitManifest<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: this program's ProgramData, parsed by `require_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + HookManifest::INIT_SPACE, seeds = [MANIFEST_SEED], bump)]
    pub manifest: Account<'info, HookManifest>,
    /// CHECK: raw TLV account written by the handler. `1` = the number of extra accounts.
    #[account(init, payer = authority, space = extra_metas_size(1).unwrap(), seeds = [EXTRA_METAS_SEED], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool: Pubkey)]
pub struct InitPoolConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CFG_SEED, pool.as_ref()], bump)]
    pub cfg: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

/// The five fixed accounts every callback receives, then this hook's extras.
#[derive(Accounts)]
pub struct Callback<'info> {
    /// CHECK: the Pool account, read with PoolData::read.
    pub pool: UncheckedAccount<'info>,
    /// The pool program's caller PDA for THIS hook: ["caller", this program's id] under
    /// the pool program. `Signer` makes Anchor refuse an unsigned call; `verify_caller`
    /// then checks the address. The pool signs with another address for every other hook,
    /// so no other hook can pass the pool's signature on to this one.
    pub hook_caller: Signer<'info>,
    /// CHECK: the trader. Read-only and never a signer.
    pub user: UncheckedAccount<'info>,
    /// CHECK: quote mint.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: base mint.
    pub base_mint: UncheckedAccount<'info>,
    /// Extra account 5, writable (see init_manifest).
    #[account(mut, seeds = [CFG_SEED, pool.key().as_ref()], bump = cfg.bump)]
    pub cfg: Account<'info, Config>,
}
