//! loyalty_points: a Programmable hook that takes no fee and changes no price.
//!
//! AFTER every buy it adds points to the buyer's own account (a PDA of this program
//! for pool + buyer) and to a per-pool total. One point per `quote_per_point` units
//! of the quote token the buyer sent.
//!
//! A hook never gets the trader's signature, so it cannot create the buyer's account.
//! The buyer opens it once with `open_points`, an ordinary instruction the buyer
//! signs. A buy by a wallet that never opened one still goes through and earns
//! nothing: `after_swap` returns Ok whatever the points account looks like.
//!
//! Powers used: AFTER_SWAP, ON_POOL_CREATE, CALL_ON_BUY. No BEFORE_SWAP, so this
//! hook has no say in the fee or the price. No CALL_ON_SELL, so the pool never
//! calls it on a sell.
//!
//! What can change after the freeze: each pool's Config counters and each buyer's
//! Points move with every buy. Nothing else can change: no owner, no setter.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use hookpool_interface::*;

// Replaced by `anchor keys sync` (the build script runs it before every build).
declare_id!("3MF6PYZy24HWM35KpjF7sw7jED73nzkzW5MfxDgCGf8C");

pub const CFG_SEED: &[u8] = b"cfg";
pub const POINTS_SEED: &[u8] = b"points";

/// What this hook is allowed to do. `create_pool` copies the manifest's flags into the
/// Pool account, and a pool keeps the flags it was created with forever.
pub const FLAGS: u32 = AFTER_SWAP | ON_POOL_CREATE | CALL_ON_BUY;

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

/// Per-pool state, PDA ["cfg", pool]. Created by the launcher before the pool.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub bump: u8,
    pub pool: Pubkey,
    /// Who paid for this config. Must be the pool creator (checked in on_pool_create), so
    /// a pool never starts on parameters somebody else wrote.
    pub creator: Pubkey,
    /// Units of the quote token (lamports for wrapped SOL) a buyer sends per point.
    pub quote_per_point: u64,
    /// Set by on_pool_create.
    pub live: bool,
    /// Every point this pool ever gave.
    pub total_points: u64,
    /// Buys the hook was called for, with or without a points account.
    pub buys_seen: u64,
    /// Buys that earned points.
    pub buys_rewarded: u64,
}

/// One buyer's points in one pool, PDA ["points", pool, buyer]. Opened by the buyer.
#[account]
#[derive(InitSpace)]
pub struct Points {
    pub bump: u8,
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub points: u64,
    pub buys: u64,
}

/// Numbered from 7000, not from Anchor's default 6000, so that a number in a failed swap
/// cannot be mistaken for an error of the pool, the launchpad or the interface crate.
#[error_code(offset = 7000)]
pub enum LoyaltyError {
    #[msg("quote_per_point must be greater than zero")]
    ZeroUnit,
    #[msg("config does not belong to this pool")]
    WrongPool,
    #[msg("config was not created by the pool creator")]
    WrongCreator,
    #[msg("this pool does not use the loyalty_points hook")]
    NotOurPool,
}

#[program]
pub mod loyalty_points {
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

        // The extra accounts of every callback, in this order, after the five fixed ones:
        //   5  this pool's Config          ["cfg", pool]             writable
        //   6  the trader's Points account ["points", pool, trader]  writable
        // Seeds may name a fixed account by its index: 0 = the pool, 2 = the trader. The
        // pool and every client derive the addresses from this list, so a trader never
        // has to know them. `per_user_meta` builds the second kind. Extra accounts are
        // never signers. `extra_metas_size(2)` in InitManifest below is the number of
        // entries written here.
        let metas = [per_pool_config_meta(CFG_SEED, true)?, per_user_meta(POINTS_SEED, true)?];
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        init_extra_metas(&mut data, &metas)
    }

    /// The launcher calls this before `create_pool` with the future pool address.
    pub fn init_pool_config(ctx: Context<InitPoolConfig>, pool: Pubkey, quote_per_point: u64) -> Result<()> {
        require!(quote_per_point > 0, LoyaltyError::ZeroUnit);
        let cfg = &mut ctx.accounts.cfg;
        cfg.bump = ctx.bumps.cfg;
        cfg.pool = pool;
        cfg.creator = ctx.accounts.payer.key();
        cfg.quote_per_point = quote_per_point;
        cfg.live = false;
        cfg.total_points = 0;
        cfg.buys_seen = 0;
        cfg.buys_rewarded = 0;
        Ok(())
    }

    /// A buyer opens their own points account for one pool, once, and pays its rent.
    /// This is a normal instruction the buyer signs; it can ride in the same
    /// transaction as the buy, before the swap instruction.
    pub fn open_points(ctx: Context<OpenPoints>) -> Result<()> {
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        require_keys_eq!(pool.hook_program, crate::ID, LoyaltyError::NotOurPool);
        let p = &mut ctx.accounts.points;
        p.bump = ctx.bumps.points;
        p.pool = ctx.accounts.pool.key();
        p.owner = ctx.accounts.owner.key();
        p.points = 0;
        p.buys = 0;
        Ok(())
    }

    // ---- callbacks from the pool program -----------------------------------------

    /// Runs once inside `create_pool`. Refuses a config somebody else prepared.
    pub fn on_pool_create(ctx: Context<Callback>, payload: PoolCreatePayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let pool_key = ctx.accounts.pool.key();
        let cfg = &mut ctx.accounts.cfg;
        require_keys_eq!(cfg.pool, pool_key, LoyaltyError::WrongPool);
        require_keys_eq!(cfg.creator, payload.creator, LoyaltyError::WrongCreator);
        // The same key as the pool program wrote it into the Pool account. The payload is
        // what the caller says; the Pool account is what the pool program did.
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        require_keys_eq!(cfg.creator, pool.creator, LoyaltyError::WrongCreator);
        cfg.live = true;
        Ok(())
    }

    /// Runs after the transfers of every buy. Its return data is ignored by the pool.
    /// It must never fail for a reason the buyer cannot fix, or it would block buys.
    pub fn after_swap(ctx: Context<Callback>, payload: SwapPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        // The pool never calls this on a sell (no CALL_ON_SELL). Belt and braces.
        if payload.direction != DIRECTION_BUY {
            return Ok(());
        }
        let pool_key = ctx.accounts.pool.key();
        let user_key = ctx.accounts.user.key();
        let cfg = &mut ctx.accounts.cfg;
        cfg.buys_seen = cfg.buys_seen.saturating_add(1);
        let earned = payload.amount_in / cfg.quote_per_point;

        // The buyer's points account. It may not exist (never opened): then it is an
        // empty account owned by the system program and the buy earns nothing.
        let info = ctx.accounts.points.to_account_info();
        if info.owner != &crate::ID || !info.is_writable {
            return Ok(());
        }
        let mut data = info.try_borrow_mut_data()?;
        // Checks the 8-byte Points discriminator. Only this program writes accounts it
        // owns, so the stored pool and owner are trustworthy without re-deriving the PDA.
        let mut points = match Points::try_deserialize(&mut &data[..]) {
            Ok(p) => p,
            Err(_) => return Ok(()),
        };
        if points.pool != pool_key || points.owner != user_key {
            return Ok(());
        }
        points.points = points.points.saturating_add(earned);
        points.buys = points.buys.saturating_add(1);
        let mut out: &mut [u8] = &mut data[..];
        points.try_serialize(&mut out)?;

        cfg.total_points = cfg.total_points.saturating_add(earned);
        cfg.buys_rewarded = cfg.buys_rewarded.saturating_add(1);
        Ok(())
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
    /// CHECK: raw TLV account written by the handler. `2` = the number of extra accounts.
    #[account(init, payer = authority, space = extra_metas_size(2).unwrap(), seeds = [EXTRA_METAS_SEED], bump)]
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

#[derive(Accounts)]
pub struct OpenPoints<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: a Programmable pool that uses this hook, read with PoolData::read.
    pub pool: UncheckedAccount<'info>,
    #[account(init, payer = owner, space = 8 + Points::INIT_SPACE, seeds = [POINTS_SEED, pool.key().as_ref(), owner.key().as_ref()], bump)]
    pub points: Account<'info, Points>,
    pub system_program: Program<'info, System>,
}

/// The five fixed accounts every callback receives, then this hook's two extras.
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
    /// Extra account 5, writable.
    #[account(mut, seeds = [CFG_SEED, pool.key().as_ref()], bump = cfg.bump)]
    pub cfg: Account<'info, Config>,
    /// CHECK: extra account 6, writable: the trader's Points account, or an empty
    /// system account when the trader never opened one. An account that may not exist
    /// has to be an UncheckedAccount; `Account<Points>` here would fail every buy by a
    /// wallet without one. Checked by hand in after_swap.
    #[account(mut)]
    pub points: UncheckedAccount<'info>,
}
