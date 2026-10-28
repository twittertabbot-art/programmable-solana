//! A swap started by the pool's own hook (buyback and the like). No callbacks, no
//! hook fee, otherwise identical to `swap`. See HOOKS.md section 7.

use crate::errors::HookpoolError;
use crate::events::Swapped;
use crate::math;
use crate::state::*;
use crate::transfers::{transfer_pool, transfer_user};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use hookpool_interface::*;

#[event_cpi]
#[derive(Accounts)]
pub struct HookSwap<'info> {
    /// PDA ["hook-authority", pool] of the pool's hook program.
    pub hook_authority: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(
        mut,
        seeds = [POOL_SEED, pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        bump = pool.bump,
        has_one = base_mint,
        has_one = quote_mint,
        has_one = base_vault,
        has_one = quote_vault,
        has_one = base_token_program @ HookpoolError::TokenProgramMismatch,
        has_one = quote_token_program @ HookpoolError::TokenProgramMismatch,
    )]
    pub pool: Box<Account<'info, Pool>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = base_mint, token::authority = hook_authority)]
    pub hook_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = hook_authority)]
    pub hook_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_hook_swap(
    ctx: Context<HookSwap>,
    direction: u8,
    amount_in: u64,
    min_amount_out: u64,
    authority_bump: u8,
) -> Result<()> {
    require!(!ctx.accounts.platform.paused, HookpoolError::Paused);
    let snapshot: PoolData = ctx.accounts.pool.data;
    require!(snapshot.has_hook(), HookpoolError::NoHook);

    let pool_key = ctx.accounts.pool.key();
    let expected = Pubkey::create_program_address(
        &[HOOK_AUTHORITY_SEED, pool_key.as_ref(), &[authority_bump]],
        &snapshot.hook_program,
    )
    .map_err(|_| HookpoolError::HookAuthorityMismatch)?;
    require_keys_eq!(
        ctx.accounts.hook_authority.key(),
        expected,
        HookpoolError::HookAuthorityMismatch
    );

    let q = math::quote_swap(
        direction,
        amount_in,
        snapshot.reserve_base,
        snapshot.reserve_quote,
        snapshot.virtual_quote,
        snapshot.lp_fee_bps,
        ctx.accounts.platform.protocol_fee_bps,
        0,
        None,
        None,
    )?;
    require!(q.amount_out >= min_amount_out, HookpoolError::Slippage);

    let a = &ctx.accounts;
    let pool_bump = [snapshot.bump];
    let pool_seeds: &[&[u8]] = &[
        POOL_SEED,
        snapshot.base_mint.as_ref(),
        snapshot.quote_mint.as_ref(),
        &pool_bump,
    ];
    let signer: &[&[&[u8]]] = &[pool_seeds];
    let is_buy = direction == DIRECTION_BUY;
    let (tp_in, from_in, mint_in, vault_in, dec_in) = if is_buy {
        (&a.quote_token_program, &a.hook_quote, &a.quote_mint, &a.quote_vault, a.quote_mint.decimals)
    } else {
        (&a.base_token_program, &a.hook_base, &a.base_mint, &a.base_vault, a.base_mint.decimals)
    };
    let (tp_out, to_out, mint_out, vault_out, dec_out) = if is_buy {
        (&a.base_token_program, &a.hook_base, &a.base_mint, &a.base_vault, a.base_mint.decimals)
    } else {
        (&a.quote_token_program, &a.hook_quote, &a.quote_mint, &a.quote_vault, a.quote_mint.decimals)
    };
    transfer_user(
        tp_in.to_account_info(),
        from_in.to_account_info(),
        mint_in.to_account_info(),
        vault_in.to_account_info(),
        a.hook_authority.to_account_info(),
        amount_in,
        dec_in,
        &[],
    )?;
    transfer_pool(
        tp_out.to_account_info(),
        vault_out.to_account_info(),
        mint_out.to_account_info(),
        to_out.to_account_info(),
        a.pool.to_account_info(),
        signer,
        q.amount_out,
        dec_out,
        &[],
    )?;

    let slot = Clock::get()?.slot;
    let pool = &mut ctx.accounts.pool;
    if is_buy {
        pool.reserve_quote = q.reserve_in_after;
        pool.reserve_base = q.reserve_out_after;
        pool.protocol_fees_quote = pool
            .protocol_fees_quote
            .checked_add(q.protocol_fee)
            .ok_or(HookpoolError::MathOverflow)?;
    } else {
        pool.reserve_base = q.reserve_in_after;
        pool.reserve_quote = q.reserve_out_after;
        pool.protocol_fees_base = pool
            .protocol_fees_base
            .checked_add(q.protocol_fee)
            .ok_or(HookpoolError::MathOverflow)?;
    }
    pool.volume_quote_total = pool.volume_quote_total.saturating_add(q.quote_volume);
    pool.swap_count = pool.swap_count.saturating_add(1);
    emit_cpi!(Swapped {
        pool: pool_key,
        user: ctx.accounts.hook_authority.key(),
        direction,
        amount_in,
        amount_out: q.amount_out,
        protocol_fee: q.protocol_fee,
        hook_fee: 0,
        lp_fee: q.lp_fee,
        fee_bps_applied: q.fee_bps_applied,
        reserve_base: pool.reserve_base,
        reserve_quote: pool.reserve_quote,
        slot,
        by_hook: true,
    });
    // Last, after the event CPI: a simulated swap returns the exact output as return data.
    set_return_data(&q.amount_out.to_le_bytes());
    Ok(())
}
