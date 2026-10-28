//! A buy started by the pool's own hook in which the coins bought are BURNED in the pool's
//! vault and never transferred. See HOOKS.md section 7.
//!
//! It is `hook_swap` in the buy direction (quote from the hook's own account, signed by
//! the hook's authority PDA, protocol fee and pool fee, no hook fee, no callbacks) with
//! one difference: the pool does not pay the coins out, it burns them where they are.
//!
//! Why it exists. A hook that is also the TRANSFER hook of its coin cannot use `hook_swap`
//! to buy that coin: the payout is a transfer, the token program would call the hook
//! program from inside the hook's own instruction, and the runtime refuses a program that
//! is entered again while it runs. A burn calls no transfer hook.
//!
//! The reserves, the protocol fee, the counters and the event come out exactly as for a
//! `hook_swap` buy of the same size followed by a burn of what it bought. The caller gets
//! nothing, so this gives a hook strictly less than `hook_swap` does.

use crate::errors::HookpoolError;
use crate::events::Swapped;
use crate::math;
use crate::state::*;
use crate::transfers::transfer_user;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};
use hookpool_interface::*;

#[event_cpi]
#[derive(Accounts)]
pub struct HookBuyBurn<'info> {
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
    /// Writable: the burn lowers the coin's supply.
    #[account(mut)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The hook's own quote account: what the buy is paid from.
    #[account(mut, token::mint = quote_mint, token::authority = hook_authority)]
    pub hook_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_hook_buy_burn(ctx: Context<HookBuyBurn>, amount_in: u64, min_amount_out: u64, authority_bump: u8) -> Result<()> {
    require!(!ctx.accounts.platform.paused, HookpoolError::Paused);
    let snapshot: PoolData = ctx.accounts.pool.data;
    require!(snapshot.has_hook(), HookpoolError::NoHook);

    // exactly who `hook_swap` lets in: the authority PDA of this pool's own hook program
    let pool_key = ctx.accounts.pool.key();
    let expected = Pubkey::create_program_address(
        &[HOOK_AUTHORITY_SEED, pool_key.as_ref(), &[authority_bump]],
        &snapshot.hook_program,
    )
    .map_err(|_| HookpoolError::HookAuthorityMismatch)?;
    require_keys_eq!(ctx.accounts.hook_authority.key(), expected, HookpoolError::HookAuthorityMismatch);

    let q = math::quote_swap(
        DIRECTION_BUY,
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
    // the quote comes in as in `hook_swap`
    transfer_user(
        a.quote_token_program.to_account_info(),
        a.hook_quote.to_account_info(),
        a.quote_mint.to_account_info(),
        a.quote_vault.to_account_info(),
        a.hook_authority.to_account_info(),
        amount_in,
        a.quote_mint.decimals,
        &[],
    )?;
    // the coins bought leave the vault by being burned: the vault's balance and the
    // reserve fall by the same amount, as with a payout
    let pool_bump = [snapshot.bump];
    let pool_seeds: &[&[u8]] = &[POOL_SEED, snapshot.base_mint.as_ref(), snapshot.quote_mint.as_ref(), &pool_bump];
    token_interface::burn(
        CpiContext::new_with_signer(
            a.base_token_program.key(),
            Burn { mint: a.base_mint.to_account_info(), from: a.base_vault.to_account_info(), authority: a.pool.to_account_info() },
            &[pool_seeds],
        ),
        q.amount_out,
    )?;

    let slot = Clock::get()?.slot;
    let pool = &mut ctx.accounts.pool;
    pool.reserve_quote = q.reserve_in_after;
    pool.reserve_base = q.reserve_out_after;
    pool.protocol_fees_quote = pool.protocol_fees_quote.checked_add(q.protocol_fee).ok_or(HookpoolError::MathOverflow)?;
    pool.volume_quote_total = pool.volume_quote_total.saturating_add(q.quote_volume);
    pool.swap_count = pool.swap_count.saturating_add(1);
    // the event of a `hook_swap` buy of the same size, field for field
    emit_cpi!(Swapped {
        pool: pool_key,
        user: ctx.accounts.hook_authority.key(),
        direction: DIRECTION_BUY,
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
    // Last, after the event CPI: the coins bought and burned, as return data.
    set_return_data(&q.amount_out.to_le_bytes());
    Ok(())
}
