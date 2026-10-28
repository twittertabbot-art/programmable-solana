//! my_hook: a complete Programmable hook you can copy.
//!
//! What it does: takes `fee_bps` of every buy and sell, in the quote token, to the
//! treasury the POOL'S CREATOR chose (not you, the hook's author: see on_pool_create).
//! The fee can never be raised above `max_bps`, which is fixed when the per-pool config
//! is created.
//!
//! Change `before_swap` to do something else. Keep `verify_caller`. Deploy frozen.
//!
//! What can still change after the program is frozen: the accounts it owns, as far as
//! this code allows. Here that is one thing: the owner of a pool's Config may move
//! `fee_bps` between 0 and `max_bps`, or hand over or renounce that right. The manifest
//! and the extra-accounts list have no setter, so they never change.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use hookpool_interface::*;

// Replaced by `anchor keys sync` (scripts/build.sh runs it before every build).
declare_id!("3gVPyNxBYkxi344M7LbMYH9Znttdjf86BYJL4fPXLwmg");

pub const CFG_SEED: &[u8] = b"cfg";

/// What this hook is allowed to do. `create_pool` copies the manifest's flags into the
/// Pool account, and a pool keeps the flags it was created with forever.
///
/// ON_POOL_CREATE is not optional for a hook with a per-pool config: without it the pool
/// is created without asking this program, so nothing checks who made the config.
pub const FLAGS: u32 = BEFORE_SWAP | ON_POOL_CREATE | TAKE_HOOK_FEE | CALL_ON_BUY | CALL_ON_SELL;

/// Hard ceiling of the per-pool ceiling. The platform cap still applies on top.
pub const HARD_MAX_BPS: u16 = 1_000;

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
    /// Pubkey::default() = renounced, the fee can never change again.
    pub owner: Pubkey,
    pub fee_bps: u16,
    pub max_bps: u16,
    /// Who paid for this config. Must be the pool creator (checked in on_pool_create), so
    /// a pool never starts on parameters somebody else wrote.
    pub creator: Pubkey,
}

/// The numbers start at 7000 on purpose. Anchor numbers every program's errors from
/// 6000, and so do the pool, the launchpad and the interface crate: 6001 would be this
/// hook's `CeilingTooHigh`, the interface crate's `CallerMismatch` and the pool's
/// `NotAdmin` at once. With the offset a number seen in a failed swap can only be yours.
/// Clients should still read the error NAME in the logs.
#[error_code(offset = 7000)]
pub enum MyHookError {
    #[msg("fee above the ceiling fixed at creation")]
    AboveCeiling,
    #[msg("ceiling above the hard maximum")]
    CeilingTooHigh,
    #[msg("only the config owner can do this")]
    NotOwner,
    #[msg("config does not belong to this pool")]
    WrongPool,
    #[msg("pool has no hook treasury")]
    NoTreasury,
    #[msg("config was not created by the pool creator")]
    WrongCreator,
}

#[program]
pub mod my_hook {
    use super::*;

    /// One-time. Run it BEFORE freezing the program: only the upgrade authority may call it.
    pub fn init_manifest(ctx: Context<InitManifest>, name: String, uri: String) -> Result<()> {
        require_upgrade_authority(
            &crate::ID,
            &ctx.accounts.program_data.to_account_info(),
            &ctx.accounts.authority.key(),
        )?;
        // admin = None: this hook declares no operator. The field is a declaration that
        // sites show; nothing on chain checks it. What can really change is what the
        // code of this program allows.
        let m = HookManifestData::new(FLAGS, None, &name, &uri);
        let man = &mut ctx.accounts.manifest;
        man.version = m.version;
        man.flags = m.flags;
        man.admin = m.admin;
        man.name = m.name;
        man.uri = m.uri;

        // Extra account 5 of every callback: this pool's Config, read-only.
        // One list serves every callback. Never mark an entry as a signer: the pool never
        // passes one as a signer. `extra_metas_size(n)` in InitManifest below must be
        // given the number of entries written here.
        let metas = [per_pool_config_meta(CFG_SEED, false)?];
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        init_extra_metas(&mut data, &metas)
    }

    /// The launcher calls this before `create_pool` with the future pool address
    /// (PDA ["pool", base_mint, quote_mint] of the pool program, known in advance).
    pub fn init_pool_config(ctx: Context<InitPoolConfig>, pool: Pubkey, fee_bps: u16, max_bps: u16) -> Result<()> {
        require!(max_bps <= HARD_MAX_BPS, MyHookError::CeilingTooHigh);
        require!(fee_bps <= max_bps, MyHookError::AboveCeiling);
        let cfg = &mut ctx.accounts.cfg;
        cfg.bump = ctx.bumps.cfg;
        cfg.pool = pool;
        cfg.owner = ctx.accounts.owner.key();
        cfg.fee_bps = fee_bps;
        cfg.max_bps = max_bps;
        cfg.creator = ctx.accounts.payer.key();
        Ok(())
    }

    pub fn set_fee(ctx: Context<OwnerOnly>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= ctx.accounts.cfg.max_bps, MyHookError::AboveCeiling);
        ctx.accounts.cfg.fee_bps = fee_bps;
        Ok(())
    }

    /// Pass Pubkey::default() to renounce.
    pub fn set_owner(ctx: Context<OwnerOnly>, new_owner: Pubkey) -> Result<()> {
        ctx.accounts.cfg.owner = new_owner;
        Ok(())
    }

    // ---- callbacks from the pool program -----------------------------------------

    /// Runs once inside `create_pool`. Refuse the pool if it is not set up the way you need.
    ///
    /// Account 2 (`user`) and `payload.creator` are both the wallet that creates the pool;
    /// through the launchpad that is the wallet that launches the coin. The Pool account
    /// (account 0) is already written, reserves included. The payload carries no slot:
    /// take it from `Clock::get()` or from `PoolData::created_slot`.
    pub fn on_pool_create(ctx: Context<Callback>, payload: PoolCreatePayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        // The treasury is whatever token account the pool's creator passed: this hook
        // takes a fee, so the pool made sure it is a real quote token account.
        // IF YOU REMOVE `TAKE_HOOK_FEE` FROM `FLAGS`, REMOVE THIS CHECK TOO: a hook that
        // takes no fee gets the default key (all zeros) here, and the check would refuse
        // every pool. If you, the hook's author, want a share of the fee, this is the
        // place to require `pool.hook_treasury_owner` to be a wallet of yours.
        require!(pool.hook_quote_treasury != Pubkey::default(), MyHookError::NoTreasury);
        require_keys_eq!(ctx.accounts.cfg.pool, ctx.accounts.pool.key(), MyHookError::WrongPool);
        // Pool addresses are predictable, so anyone can create the config of a pool that
        // does not exist yet. This check makes such a pool fail to start instead of
        // starting on a stranger's parameters. It does not stop the stranger from taking
        // the address: launch the coin and its config in one transaction (the SDK does).
        require_keys_eq!(ctx.accounts.cfg.creator, payload.creator, MyHookError::WrongCreator);
        // The same key as the pool program wrote it into the Pool account. The payload is
        // what the caller says; the Pool account is what the pool program did.
        require_keys_eq!(ctx.accounts.cfg.creator, pool.creator, MyHookError::WrongCreator);
        Ok(())
    }

    /// The answer the pool reads: how many bps of this swap go to the treasury.
    ///
    /// The pool clamps the number to the platform cap, takes it in the quote token (from
    /// what the buyer sends after the protocol fee, or from what the seller would
    /// receive) and pays the treasury. Returning nothing at all means "no opinion".
    pub fn before_swap(ctx: Context<Callback>, payload: SwapPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        // `payload` tells you the direction, amount_in, the reserves before the swap, the
        // slot and the pool's own fee. This hook charges the same on every swap.
        let _ = payload;
        HookReturn::hook_fee(ctx.accounts.cfg.fee_bps).set()
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
    pub owner: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CFG_SEED, pool.as_ref()], bump)]
    pub cfg: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = owner @ MyHookError::NotOwner)]
    pub cfg: Account<'info, Config>,
}

/// The five fixed accounts every callback receives, then this hook's extras, in the
/// order of the list written in `init_manifest`.
#[derive(Accounts)]
pub struct Callback<'info> {
    /// CHECK: the Pool account, read with PoolData::read.
    pub pool: UncheckedAccount<'info>,
    /// The pool program's caller PDA for THIS hook: ["caller", this program's id] under
    /// the pool program. `Signer` makes Anchor refuse an unsigned call; `verify_caller`
    /// then checks the address. The pool signs with another address for every other hook,
    /// so no other hook can pass the pool's signature on to this one.
    pub hook_caller: Signer<'info>,
    /// CHECK: the trader. Read-only and never a signer: a hook cannot spend from it.
    pub user: UncheckedAccount<'info>,
    /// CHECK: quote mint.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: base mint.
    pub base_mint: UncheckedAccount<'info>,
    /// Extra account 5. The pool derives its address from the list and refuses the swap
    /// when the client did not pass it.
    #[account(seeds = [CFG_SEED, pool.key().as_ref()], bump = cfg.bump)]
    pub cfg: Account<'info, Config>,
}
