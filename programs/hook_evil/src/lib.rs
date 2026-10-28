//! TEST ONLY. Misbehaves on command so the test-suite can prove that the pool
//! enforces flags and caps no matter what a hook returns, and that a hook cannot use the
//! pool's signature against another hook (MODE_RELAY). Never deployed anywhere.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, set_return_data};
use hookpool_interface::*;

declare_id!("HqF3vyeRJmGwAsvNHNBY2xoW4Vhh578Xz2jdgPTKv92B");

pub const CFG_SEED: &[u8] = b"cfg";
/// The PDA `forward` signs for.
pub const EVIL_SIGNER_SEED: &[u8] = b"evil-signer";

pub const MODE_SILENT: u8 = 0;
pub const MODE_FEE_OVERRIDE: u8 = 1;
pub const MODE_HOOK_FEE: u8 = 2;
pub const MODE_CURVE: u8 = 3;
pub const MODE_REVERT: u8 = 4;
pub const MODE_GARBAGE: u8 = 5;
pub const MODE_WRONG_VERSION: u8 = 6;
/// `before_swap` passes the signature it received from the pool on to another hook's
/// callback, with accounts and instruction data of its choice. See `relay`.
pub const MODE_RELAY: u8 = 7;
/// The longest instruction data a relay can carry.
pub const MAX_RELAY_DATA: usize = 200;

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
pub struct EvilConfig {
    pub bump: u8,
    pub pool: Pubkey,
    pub mode: u8,
    pub value: u64,
    pub calls: u64,
    /// MODE_RELAY: the hook program to call, and the instruction data to send it.
    pub relay_target: Pubkey,
    #[max_len(MAX_RELAY_DATA)]
    pub relay_data: Vec<u8>,
}

/// One fixed address of a relay's extra-accounts list.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct RelayExtra {
    pub key: Pubkey,
    pub writable: bool,
}

#[error_code]
pub enum EvilError {
    #[msg("told to revert")]
    Revert,
    #[msg("relay data too long")]
    RelayTooLong,
    #[msg("relay accounts are not the ones of the manifest")]
    RelayAccounts,
}

#[program]
pub mod hook_evil {
    use super::*;

    /// Anyone, any flags: this is a test program.
    pub fn init_manifest(ctx: Context<InitManifest>, flags: u32) -> Result<()> {
        let m = HookManifestData::new(flags, None, "evil", "test");
        let man = &mut ctx.accounts.manifest;
        man.version = m.version;
        man.flags = m.flags;
        man.admin = m.admin;
        man.name = m.name;
        man.uri = m.uri;
        let metas = [per_pool_config_meta(CFG_SEED, true)?];
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        init_extra_metas(&mut data, &metas)
    }

    /// The manifest of a relaying hook. Its extra-accounts list names, after the config,
    /// fixed addresses: the hook to attack, then the accounts of the callback to forge
    /// there, in that callback's own order but without its `hook_caller`:
    /// `[target program, pool, user, quote mint, base mint, the target's extra accounts]`.
    /// The pool hands all of them to `before_swap`, where they are the remaining accounts.
    pub fn init_relay_manifest(ctx: Context<InitRelayManifest>, flags: u32, extras: Vec<RelayExtra>) -> Result<()> {
        let m = HookManifestData::new(flags, None, "evil relay", "test");
        let man = &mut ctx.accounts.manifest;
        man.version = m.version;
        man.flags = m.flags;
        man.admin = m.admin;
        man.name = m.name;
        man.uri = m.uri;
        let mut metas = vec![per_pool_config_meta(CFG_SEED, true)?];
        for e in &extras {
            metas.push(
                ExtraAccountMeta::new_with_pubkey(&e.key, false, e.writable).map_err(|_| InterfaceError::ExtraMetas)?,
            );
        }
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        init_extra_metas(&mut data, &metas)
    }

    pub fn init_pool_config(ctx: Context<InitPoolConfig>, pool: Pubkey, mode: u8, value: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.cfg;
        cfg.bump = ctx.bumps.cfg;
        cfg.pool = pool;
        cfg.mode = mode;
        cfg.value = value;
        cfg.calls = 0;
        cfg.relay_target = Pubkey::default();
        cfg.relay_data = vec![];
        Ok(())
    }

    pub fn set_mode(ctx: Context<SetMode>, mode: u8, value: u64) -> Result<()> {
        ctx.accounts.cfg.mode = mode;
        ctx.accounts.cfg.value = value;
        Ok(())
    }

    /// TEST ONLY: call `remaining[0]` with `data` and the other remaining accounts, each
    /// passed on with the signer and writable flags it arrived with (a program may hand on a
    /// signature it received). `pda_signer`: the position, in that list, of an account this
    /// program signs for as its own PDA `["evil-signer"]`. `fake_signer`: a position marked
    /// as a signer although nobody signed for it, which the runtime must refuse.
    pub fn forward<'info>(ctx: Context<'info, Forward<'info>>, data: Vec<u8>, pda_signer: Option<u8>, fake_signer: Option<u8>) -> Result<()> {
        let rem = ctx.remaining_accounts;
        require!(!rem.is_empty(), EvilError::RelayAccounts);
        let mut accounts = vec![];
        let mut infos = vec![];
        for (i, a) in rem[1..].iter().enumerate() {
            let at = Some(i as u8);
            accounts.push(AccountMeta { pubkey: a.key(), is_signer: a.is_signer || pda_signer == at || fake_signer == at, is_writable: a.is_writable });
            infos.push(a.clone());
        }
        infos.push(rem[0].clone());
        let bump = [Pubkey::find_program_address(&[EVIL_SIGNER_SEED], &crate::ID).1];
        anchor_lang::solana_program::program::invoke_signed(
            &Instruction { program_id: rem[0].key(), accounts, data },
            &infos,
            &[&[EVIL_SIGNER_SEED, &bump]],
        )?;
        Ok(())
    }

    /// What MODE_RELAY sends, and to which hook.
    pub fn set_relay(ctx: Context<SetMode>, target: Pubkey, data: Vec<u8>) -> Result<()> {
        require!(data.len() <= MAX_RELAY_DATA, EvilError::RelayTooLong);
        ctx.accounts.cfg.relay_target = target;
        ctx.accounts.cfg.relay_data = data;
        Ok(())
    }

    pub fn on_pool_create(ctx: Context<Callback>, _payload: PoolCreatePayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        ctx.accounts.cfg.calls += 1;
        Ok(())
    }

    pub fn before_swap<'info>(ctx: Context<'info, Callback<'info>>, _payload: SwapPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let cfg = &mut ctx.accounts.cfg;
        cfg.calls += 1;
        match cfg.mode {
            MODE_RELAY => {
                let (target, data) = (cfg.relay_target, cfg.relay_data.clone());
                relay(&ctx.accounts.hook_caller.to_account_info(), ctx.remaining_accounts, target, data)
            }
            MODE_SILENT => Ok(()),
            MODE_FEE_OVERRIDE => HookReturn::fee_override(cfg.value as u16).set(),
            MODE_HOOK_FEE => HookReturn::hook_fee(cfg.value as u16).set(),
            MODE_CURVE => HookReturn::curve(cfg.value).set(),
            MODE_REVERT => Err(EvilError::Revert.into()),
            MODE_GARBAGE => {
                set_return_data(&[7u8; 3]);
                Ok(())
            }
            MODE_WRONG_VERSION => {
                let mut r = HookReturn::hook_fee(10);
                r.version = 9;
                r.set()
            }
            _ => Ok(()),
        }
    }

    pub fn after_swap(ctx: Context<Callback>, _payload: SwapPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        ctx.accounts.cfg.calls += 1;
        if ctx.accounts.cfg.mode == MODE_REVERT {
            return Err(EvilError::Revert.into());
        }
        Ok(())
    }

    pub fn before_add_liquidity(ctx: Context<Callback>, _payload: LiquidityPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        ctx.accounts.cfg.calls += 1;
        Ok(())
    }

    pub fn before_remove_liquidity(ctx: Context<Callback>, _payload: LiquidityPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        ctx.accounts.cfg.calls += 1;
        if ctx.accounts.cfg.mode == MODE_REVERT {
            return Err(EvilError::Revert.into());
        }
        Ok(())
    }

    /// TEST ONLY: the pool's `hook_buy_burn`, signed as the hook authority of
    /// `signer_pool`. A test passes another pool there to show that a pool refuses an
    /// authority that is not its own hook's.
    pub fn buy_burn(ctx: Context<BuyBurn>, amount_in: u64, min_amount_out: u64, authority_bump: u8) -> Result<()> {
        let a = &ctx.accounts;
        let signer_pool = a.signer_pool.key();
        let bump = [authority_bump];
        let seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, signer_pool.as_ref(), &bump];
        let accounts = hookpool::cpi::accounts::HookBuyBurn {
            hook_authority: a.hook_authority.to_account_info(),
            platform: a.platform.to_account_info(),
            pool: a.pool.to_account_info(),
            base_mint: a.base_mint.to_account_info(),
            quote_mint: a.quote_mint.to_account_info(),
            base_vault: a.base_vault.to_account_info(),
            quote_vault: a.quote_vault.to_account_info(),
            hook_quote: a.hook_quote.to_account_info(),
            base_token_program: a.base_token_program.to_account_info(),
            quote_token_program: a.quote_token_program.to_account_info(),
            event_authority: a.hookpool_event_authority.to_account_info(),
            program: a.hookpool_program.to_account_info(),
        };
        hookpool::cpi::hook_buy_burn(CpiContext::new_with_signer(a.hookpool_program.key(), accounts, &[seeds]), amount_in, min_amount_out, authority_bump)?;
        Ok(())
    }

    /// TEST ONLY: the pool's `hook_swap` in either direction, into this hook's own two
    /// accounts, signed as the hook authority of the pool. The curve tests use it to show
    /// that a hook's own buy and sell are priced with the virtual quote and paid from the
    /// real reserve.
    pub fn swap_as_hook(ctx: Context<SwapThenBurn>, direction: u8, amount_in: u64, min_amount_out: u64, authority_bump: u8) -> Result<()> {
        let a = &ctx.accounts;
        let pool_key = a.pool.key();
        let bump = [authority_bump];
        let seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, pool_key.as_ref(), &bump];
        let accounts = hookpool::cpi::accounts::HookSwap {
            hook_authority: a.hook_authority.to_account_info(),
            platform: a.platform.to_account_info(),
            pool: a.pool.to_account_info(),
            base_mint: a.base_mint.to_account_info(),
            quote_mint: a.quote_mint.to_account_info(),
            base_vault: a.base_vault.to_account_info(),
            quote_vault: a.quote_vault.to_account_info(),
            hook_base: a.hook_base.to_account_info(),
            hook_quote: a.hook_quote.to_account_info(),
            base_token_program: a.base_token_program.to_account_info(),
            quote_token_program: a.quote_token_program.to_account_info(),
            event_authority: a.hookpool_event_authority.to_account_info(),
            program: a.hookpool_program.to_account_info(),
        };
        hookpool::cpi::hook_swap(CpiContext::new_with_signer(a.hookpool_program.key(), accounts, &[seeds]), direction, amount_in, min_amount_out, authority_bump)
    }

    /// TEST ONLY: what `hook_buy_burn` is measured against. The pool's `hook_swap` in the
    /// buy direction into this hook's own coin account, then a token Burn of what it bought.
    pub fn swap_then_burn(ctx: Context<SwapThenBurn>, amount_in: u64, min_amount_out: u64, authority_bump: u8) -> Result<()> {
        let a = &ctx.accounts;
        let pool_key = a.pool.key();
        let bump = [authority_bump];
        let seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, pool_key.as_ref(), &bump];
        let before = token_amount(&a.hook_base)?;
        let accounts = hookpool::cpi::accounts::HookSwap {
            hook_authority: a.hook_authority.to_account_info(),
            platform: a.platform.to_account_info(),
            pool: a.pool.to_account_info(),
            base_mint: a.base_mint.to_account_info(),
            quote_mint: a.quote_mint.to_account_info(),
            base_vault: a.base_vault.to_account_info(),
            quote_vault: a.quote_vault.to_account_info(),
            hook_base: a.hook_base.to_account_info(),
            hook_quote: a.hook_quote.to_account_info(),
            base_token_program: a.base_token_program.to_account_info(),
            quote_token_program: a.quote_token_program.to_account_info(),
            event_authority: a.hookpool_event_authority.to_account_info(),
            program: a.hookpool_program.to_account_info(),
        };
        hookpool::cpi::hook_swap(CpiContext::new_with_signer(a.hookpool_program.key(), accounts, &[seeds]), DIRECTION_BUY, amount_in, min_amount_out, authority_bump)?;
        let bought = token_amount(&a.hook_base)? - before;
        // Burn (instruction 8 of both token programs): account, mint, authority
        let mut data = vec![8u8];
        data.extend_from_slice(&bought.to_le_bytes());
        let burn = Instruction {
            program_id: a.base_token_program.key(),
            accounts: vec![AccountMeta::new(a.hook_base.key(), false), AccountMeta::new(a.base_mint.key(), false), AccountMeta::new_readonly(a.hook_authority.key(), true)],
            data,
        };
        anchor_lang::solana_program::program::invoke_signed(&burn, &[a.hook_base.to_account_info(), a.base_mint.to_account_info(), a.hook_authority.to_account_info()], &[seeds])?;
        Ok(())
    }
}

/// The amount of a token account of either token program.
fn token_amount(account: &UncheckedAccount) -> Result<u64> {
    let d = account.try_borrow_data()?;
    require!(d.len() >= 72, EvilError::RelayAccounts);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

#[derive(Accounts)]
pub struct BuyBurn<'info> {
    /// CHECK: this hook's authority PDA of `signer_pool`; the pool checks it.
    pub hook_authority: UncheckedAccount<'info>,
    /// CHECK: the pool whose authority signs. The pool to buy on, or another one.
    pub signer_pool: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    pub platform: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    #[account(mut)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    #[account(mut)]
    pub hook_quote: UncheckedAccount<'info>,
    /// CHECK: the pool program.
    pub hookpool_program: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    pub hookpool_event_authority: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    pub base_token_program: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    pub quote_token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SwapThenBurn<'info> {
    /// CHECK: this hook's authority PDA of the pool; the pool checks it.
    pub hook_authority: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    pub platform: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    #[account(mut)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: this hook's own coin account; checked by the pool program.
    #[account(mut)]
    pub hook_base: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    #[account(mut)]
    pub hook_quote: UncheckedAccount<'info>,
    /// CHECK: the pool program.
    pub hookpool_program: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    pub hookpool_event_authority: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    pub base_token_program: UncheckedAccount<'info>,
    /// CHECK: checked by the pool program.
    pub quote_token_program: UncheckedAccount<'info>,
}

/// The relay. This hook was called by the pool with `hook_caller` as a signer, and a
/// program may hand a signer it received to the program it calls. So it calls another
/// hook's callback and passes `hook_caller` along, signed, with whatever accounts and
/// payload it likes. `remaining`: the target program, then the target callback's accounts
/// without its `hook_caller` (pool, user, quote mint, base mint, extras).
///
/// The target accepts the call only if this signer is the one it expects. While the pool
/// program signed every callback with ONE address, any hook could do this to any other.
/// With a caller address per hook program, the signer forwarded here is this hook's own
/// and is refused everywhere else.
fn relay<'info>(
    hook_caller: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    target: Pubkey,
    data: Vec<u8>,
) -> Result<()> {
    require!(remaining.len() >= 5, EvilError::RelayAccounts);
    require_keys_eq!(remaining[0].key(), target, EvilError::RelayAccounts);
    let mut accounts = vec![
        AccountMeta::new_readonly(remaining[1].key(), false),
        AccountMeta::new_readonly(hook_caller.key(), true),
    ];
    let mut infos = vec![remaining[1].clone(), hook_caller.clone()];
    for a in &remaining[2..] {
        accounts.push(if a.is_writable {
            AccountMeta::new(a.key(), false)
        } else {
            AccountMeta::new_readonly(a.key(), false)
        });
        infos.push(a.clone());
    }
    infos.push(remaining[0].clone());
    invoke(&Instruction { program_id: target, accounts, data }, &infos)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(flags: u32, extras: Vec<RelayExtra>)]
pub struct InitRelayManifest<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + HookManifest::INIT_SPACE, seeds = [MANIFEST_SEED], bump)]
    pub manifest: Account<'info, HookManifest>,
    /// CHECK: raw TLV account.
    #[account(init, payer = authority, space = extra_metas_size(1 + extras.len()).unwrap(), seeds = [EXTRA_METAS_SEED], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitManifest<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + HookManifest::INIT_SPACE, seeds = [MANIFEST_SEED], bump)]
    pub manifest: Account<'info, HookManifest>,
    /// CHECK: raw TLV account.
    #[account(init, payer = authority, space = extra_metas_size(1).unwrap(), seeds = [EXTRA_METAS_SEED], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool: Pubkey)]
pub struct InitPoolConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + EvilConfig::INIT_SPACE, seeds = [CFG_SEED, pool.as_ref()], bump)]
    pub cfg: Account<'info, EvilConfig>,
    pub system_program: Program<'info, System>,
}

/// `forward`: everything goes in remaining accounts.
#[derive(Accounts)]
pub struct Forward<'info> {
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMode<'info> {
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump)]
    pub cfg: Account<'info, EvilConfig>,
}

#[derive(Accounts)]
pub struct Callback<'info> {
    /// CHECK: pool
    pub pool: UncheckedAccount<'info>,
    /// CHECK: verified in handler
    pub hook_caller: Signer<'info>,
    /// CHECK: user
    pub user: UncheckedAccount<'info>,
    /// CHECK: quote mint
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: base mint
    pub base_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [CFG_SEED, pool.key().as_ref()], bump = cfg.bump)]
    pub cfg: Account<'info, EvilConfig>,
}
