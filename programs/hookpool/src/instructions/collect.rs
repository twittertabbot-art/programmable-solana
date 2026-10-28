use crate::errors::HookpoolError;
use crate::events::{HookFeesCollected, ProtocolFeesCollected};
use crate::state::*;
use crate::transfers::{hook_accounts_for, transfer_pool};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use hookpool_interface::*;

/// Anyone may trigger it; the money only ever goes to the platform treasury.
#[derive(Accounts)]
pub struct CollectProtocolFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
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
    /// CHECK: the platform treasury wallet.
    #[account(address = platform.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = base_mint,
        associated_token::authority = treasury,
        associated_token::token_program = base_token_program
    )]
    pub treasury_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = quote_mint,
        associated_token::authority = treasury,
        associated_token::token_program = quote_token_program
    )]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// For a coin with a transfer hook, the hook's accounts and the hook program go in the
/// remaining accounts.
pub fn handle_collect_protocol_fees<'info>(ctx: Context<'info, CollectProtocolFees<'info>>) -> Result<()> {
    let snapshot: PoolData = ctx.accounts.pool.data;
    let base_amount = snapshot.protocol_fees_base;
    let quote_amount = snapshot.protocol_fees_quote;
    require!(base_amount > 0 || quote_amount > 0, HookpoolError::NothingToCollect);

    let a = &ctx.accounts;
    let pool_bump = [snapshot.bump];
    let pool_seeds: &[&[u8]] = &[
        POOL_SEED,
        snapshot.base_mint.as_ref(),
        snapshot.quote_mint.as_ref(),
        &pool_bump,
    ];
    let signer: &[&[&[u8]]] = &[pool_seeds];
    let base_hook = hook_accounts_for(&snapshot.base_token_program, ctx.remaining_accounts, None);
    transfer_pool(
        a.base_token_program.to_account_info(),
        a.base_vault.to_account_info(),
        a.base_mint.to_account_info(),
        a.treasury_base.to_account_info(),
        a.pool.to_account_info(),
        signer,
        base_amount,
        a.base_mint.decimals,
        &base_hook,
    )?;
    transfer_pool(
        a.quote_token_program.to_account_info(),
        a.quote_vault.to_account_info(),
        a.quote_mint.to_account_info(),
        a.treasury_quote.to_account_info(),
        a.pool.to_account_info(),
        signer,
        quote_amount,
        a.quote_mint.decimals,
        &[],
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.protocol_fees_base = 0;
    pool.protocol_fees_quote = 0;
    emit!(ProtocolFeesCollected {
        pool: pool.key(),
        base_amount,
        quote_amount,
    });
    Ok(())
}

/// Pays the hook fees that waited for a closed treasury. Anyone may trigger it; the money
/// only ever goes to the treasury fixed when the pool was created. That account must exist:
/// it is the associated token account of `pool.hook_treasury_owner` for the quote mint, and
/// anyone can create it again.
#[derive(Accounts)]
pub struct CollectHookFees<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED, pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        bump = pool.bump,
        has_one = quote_mint,
        has_one = quote_vault,
        has_one = hook_quote_treasury @ HookpoolError::HookTreasuryMismatch,
        has_one = quote_token_program @ HookpoolError::TokenProgramMismatch,
    )]
    pub pool: Box<Account<'info, Pool>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint)]
    pub hook_quote_treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_collect_hook_fees(ctx: Context<CollectHookFees>) -> Result<()> {
    let snapshot: PoolData = ctx.accounts.pool.data;
    let amount = snapshot.hook_fees_owed_quote;
    require!(amount > 0, HookpoolError::NothingToCollect);

    let a = &ctx.accounts;
    let pool_bump = [snapshot.bump];
    let pool_seeds: &[&[u8]] = &[POOL_SEED, snapshot.base_mint.as_ref(), snapshot.quote_mint.as_ref(), &pool_bump];
    transfer_pool(
        a.quote_token_program.to_account_info(),
        a.quote_vault.to_account_info(),
        a.quote_mint.to_account_info(),
        a.hook_quote_treasury.to_account_info(),
        a.pool.to_account_info(),
        &[pool_seeds],
        amount,
        a.quote_mint.decimals,
        &[],
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.hook_fees_owed_quote = 0;
    emit!(HookFeesCollected { pool: pool.key(), treasury: snapshot.hook_quote_treasury, amount });
    Ok(())
}
