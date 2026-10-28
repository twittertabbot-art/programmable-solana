use crate::errors::HookpoolError;
use crate::events::LiquidityChanged;
use crate::hooks::{invoke_hook, HookAccounts};
use crate::math;
use crate::state::*;
use crate::transfers::{burn_lp, hook_accounts_for, mint_lp, transfer_pool, transfer_user};
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use hookpool_interface::*;

#[event_cpi]
#[derive(Accounts)]
pub struct ModifyLiquidity<'info> {
    pub user: Signer<'info>,
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
        has_one = lp_mint,
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
    #[account(mut)]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = base_mint, token::authority = user)]
    pub user_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = user)]
    pub user_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = lp_mint, token::authority = user)]
    pub user_lp: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: must equal pool.hook_program (system program when the pool has no hook).
    pub hook_program: UncheckedAccount<'info>,
    /// CHECK: must equal pool.hook_extra_metas.
    pub hook_extra_metas: UncheckedAccount<'info>,
    /// CHECK: PDA that signs the callbacks of this pool's hook: ["caller", hook_program].
    #[account(seeds = [CALLER_SEED, hook_program.key().as_ref()], bump)]
    pub hook_caller: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
}

fn hook_accounts<'a, 'info>(
    ctx: &'a Context<'info, ModifyLiquidity<'info>>,
) -> HookAccounts<'info, 'info> {
    HookAccounts {
        pool: ctx.accounts.pool.to_account_info(),
        caller: ctx.accounts.hook_caller.to_account_info(),
        caller_bump: ctx.bumps.hook_caller,
        user: ctx.accounts.user.to_account_info(),
        quote_mint: ctx.accounts.quote_mint.to_account_info(),
        base_mint: ctx.accounts.base_mint.to_account_info(),
        hook_program: ctx.accounts.hook_program.to_account_info(),
        extra_metas: ctx.accounts.hook_extra_metas.to_account_info(),
        remaining: ctx.remaining_accounts,
    }
}

pub fn handle_add_liquidity<'info>(
    ctx: Context<'info, ModifyLiquidity<'info>>,
    lp_amount: u64,
    max_base: u64,
    max_quote: u64,
) -> Result<()> {
    require!(!ctx.accounts.platform.paused, HookpoolError::Paused);
    require!(lp_amount > 0, HookpoolError::ZeroAmount);
    let snapshot: PoolData = ctx.accounts.pool.data;
    // On the curve nothing but trades moves the reserves: a deposit would have to match a
    // quote reserve that is partly virtual. Liquidity opens at graduation.
    require!(!snapshot.on_curve(), HookpoolError::CurveOpen);
    let supply = ctx.accounts.lp_mint.supply;
    require!(supply > 0, HookpoolError::InsufficientLiquidity);

    // Round against the depositor so the pool never loses value.
    let base_amount = math::mul_div_ceil(lp_amount, snapshot.reserve_base, supply)?;
    let quote_amount = math::mul_div_ceil(lp_amount, snapshot.reserve_quote, supply)?;
    require!(base_amount > 0 && quote_amount > 0, HookpoolError::ZeroAmount);
    require!(
        base_amount <= max_base && quote_amount <= max_quote,
        HookpoolError::InputAboveMax
    );
    let slot = Clock::get()?.slot;

    let hook_acc = hook_accounts(&ctx);
    if snapshot.has_hook() && snapshot.hook_flags & BEFORE_ADD_LIQ != 0 {
        let payload = LiquidityPayload {
            base_amount,
            quote_amount,
            lp_amount: 0,
            reserve_base: snapshot.reserve_base,
            reserve_quote: snapshot.reserve_quote,
            slot,
        };
        invoke_hook(&hook_acc, &snapshot, BEFORE_ADD_LIQUIDITY_DISC, &to_vec(&payload)?)?;
    }

    let a = &ctx.accounts;
    let base_hook = hook_accounts_for(&snapshot.base_token_program, ctx.remaining_accounts, Some(a.hook_program.to_account_info()));
    transfer_user(
        a.base_token_program.to_account_info(),
        a.user_base.to_account_info(),
        a.base_mint.to_account_info(),
        a.base_vault.to_account_info(),
        a.user.to_account_info(),
        base_amount,
        a.base_mint.decimals,
        &base_hook,
    )?;
    transfer_user(
        a.quote_token_program.to_account_info(),
        a.user_quote.to_account_info(),
        a.quote_mint.to_account_info(),
        a.quote_vault.to_account_info(),
        a.user.to_account_info(),
        quote_amount,
        a.quote_mint.decimals,
        &[],
    )?;
    let pool_bump = [snapshot.bump];
    let pool_seeds: &[&[u8]] = &[
        POOL_SEED,
        snapshot.base_mint.as_ref(),
        snapshot.quote_mint.as_ref(),
        &pool_bump,
    ];
    mint_lp(
        a.token_program.to_account_info(),
        a.lp_mint.to_account_info(),
        a.user_lp.to_account_info(),
        a.pool.to_account_info(),
        &[pool_seeds],
        lp_amount,
    )?;

    {
        let pool = &mut ctx.accounts.pool;
        pool.reserve_base = pool
            .reserve_base
            .checked_add(base_amount)
            .ok_or(HookpoolError::MathOverflow)?;
        pool.reserve_quote = pool
            .reserve_quote
            .checked_add(quote_amount)
            .ok_or(HookpoolError::MathOverflow)?;
    }
    let after: PoolData = ctx.accounts.pool.data;
    if snapshot.has_hook() && snapshot.hook_flags & AFTER_ADD_LIQ != 0 {
        ctx.accounts.pool.exit(&crate::ID)?;
        let payload = LiquidityPayload {
            base_amount,
            quote_amount,
            lp_amount,
            reserve_base: after.reserve_base,
            reserve_quote: after.reserve_quote,
            slot,
        };
        invoke_hook(&hook_acc, &after, AFTER_ADD_LIQUIDITY_DISC, &to_vec(&payload)?)?;
    }

    emit_cpi!(LiquidityChanged {
        pool: ctx.accounts.pool.key(),
        user: ctx.accounts.user.key(),
        added: true,
        base_amount,
        quote_amount,
        lp_amount,
        reserve_base: after.reserve_base,
        reserve_quote: after.reserve_quote,
        slot,
    });
    Ok(())
}

/// Never pausable: LPs can always leave.
pub fn handle_remove_liquidity<'info>(
    ctx: Context<'info, ModifyLiquidity<'info>>,
    lp_amount: u64,
    min_base: u64,
    min_quote: u64,
) -> Result<()> {
    require!(lp_amount > 0, HookpoolError::ZeroAmount);
    let snapshot: PoolData = ctx.accounts.pool.data;
    // The LP of a pool on the curve all sits in the lock account, so nobody holds any to
    // remove; the rule is stated all the same, so that the reason is the same as for a deposit.
    require!(!snapshot.on_curve(), HookpoolError::CurveOpen);
    let supply = ctx.accounts.lp_mint.supply;
    require!(supply > 0, HookpoolError::InsufficientLiquidity);

    // Round against the withdrawer.
    let base_amount = math::mul_div_floor(lp_amount, snapshot.reserve_base, supply)?;
    let quote_amount = math::mul_div_floor(lp_amount, snapshot.reserve_quote, supply)?;
    require!(base_amount > 0 && quote_amount > 0, HookpoolError::ZeroAmount);
    require!(
        base_amount >= min_base && quote_amount >= min_quote,
        HookpoolError::Slippage
    );
    require!(
        base_amount < snapshot.reserve_base && quote_amount < snapshot.reserve_quote,
        HookpoolError::InsufficientLiquidity
    );
    let slot = Clock::get()?.slot;

    let hook_acc = hook_accounts(&ctx);
    if snapshot.has_hook() && snapshot.hook_flags & BEFORE_REMOVE_LIQ != 0 {
        let payload = LiquidityPayload {
            base_amount,
            quote_amount,
            lp_amount,
            reserve_base: snapshot.reserve_base,
            reserve_quote: snapshot.reserve_quote,
            slot,
        };
        invoke_hook(&hook_acc, &snapshot, BEFORE_REMOVE_LIQUIDITY_DISC, &to_vec(&payload)?)?;
    }

    let a = &ctx.accounts;
    burn_lp(
        a.token_program.to_account_info(),
        a.lp_mint.to_account_info(),
        a.user_lp.to_account_info(),
        a.user.to_account_info(),
        lp_amount,
    )?;
    let pool_bump = [snapshot.bump];
    let pool_seeds: &[&[u8]] = &[
        POOL_SEED,
        snapshot.base_mint.as_ref(),
        snapshot.quote_mint.as_ref(),
        &pool_bump,
    ];
    let signer: &[&[&[u8]]] = &[pool_seeds];
    let base_hook = hook_accounts_for(&snapshot.base_token_program, ctx.remaining_accounts, Some(a.hook_program.to_account_info()));
    transfer_pool(
        a.base_token_program.to_account_info(),
        a.base_vault.to_account_info(),
        a.base_mint.to_account_info(),
        a.user_base.to_account_info(),
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
        a.user_quote.to_account_info(),
        a.pool.to_account_info(),
        signer,
        quote_amount,
        a.quote_mint.decimals,
        &[],
    )?;

    {
        let pool = &mut ctx.accounts.pool;
        pool.reserve_base -= base_amount;
        pool.reserve_quote -= quote_amount;
    }
    let after: PoolData = ctx.accounts.pool.data;
    if snapshot.has_hook() && snapshot.hook_flags & AFTER_REMOVE_LIQ != 0 {
        ctx.accounts.pool.exit(&crate::ID)?;
        let payload = LiquidityPayload {
            base_amount,
            quote_amount,
            lp_amount,
            reserve_base: after.reserve_base,
            reserve_quote: after.reserve_quote,
            slot,
        };
        invoke_hook(&hook_acc, &after, AFTER_REMOVE_LIQUIDITY_DISC, &to_vec(&payload)?)?;
    }

    emit_cpi!(LiquidityChanged {
        pool: ctx.accounts.pool.key(),
        user: ctx.accounts.user.key(),
        added: false,
        base_amount,
        quote_amount,
        lp_amount,
        reserve_base: after.reserve_base,
        reserve_quote: after.reserve_quote,
        slot,
    });
    Ok(())
}
