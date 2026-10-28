use crate::errors::HookpoolError;
use crate::events::Swapped;
use crate::hooks::{invoke_hook, parse_before_swap, swap_callback_enabled, HookAccounts};
use crate::math;
use crate::state::*;
use crate::transfers::{hook_accounts_for, transfer_pool, transfer_user};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use hookpool_interface::*;

#[event_cpi]
#[derive(Accounts)]
pub struct Swap<'info> {
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
    /// The token accounts of the trade: one is spent, the other receives. The token
    /// program checks that `user` may spend the account the coins leave (its owner, or a
    /// delegate). The account that receives may belong to anyone, so an aggregator or a
    /// bot can sign with one wallet and pay out to another. Never the pool's own vault.
    #[account(mut, token::mint = base_mint)]
    pub user_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint)]
    pub user_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: must equal pool.hook_quote_treasury when a hook fee is due. Pools without a
    /// hook fee get any writable account here (clients pass the user's quote account).
    #[account(mut)]
    pub hook_quote_treasury: UncheckedAccount<'info>,
    /// CHECK: must equal pool.hook_program (system program when the pool has no hook).
    pub hook_program: UncheckedAccount<'info>,
    /// CHECK: must equal pool.hook_extra_metas.
    pub hook_extra_metas: UncheckedAccount<'info>,
    /// CHECK: PDA that signs the callbacks of this pool's hook: ["caller", hook_program].
    /// One address per hook program, so that no hook can pass the pool's signature on to
    /// another hook. For a pool without a hook it is the address of the system program
    /// (the `hook_program` clients pass then) and signs nothing.
    #[account(seeds = [CALLER_SEED, hook_program.key().as_ref()], bump)]
    pub hook_caller: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_swap<'info>(
    ctx: Context<'info, Swap<'info>>,
    direction: u8,
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.platform.paused, HookpoolError::Paused);
    require!(amount_in > 0, HookpoolError::ZeroAmount);
    require!(
        direction == DIRECTION_BUY || direction == DIRECTION_SELL,
        HookpoolError::BadDirection
    );

    let platform = &ctx.accounts.platform;
    let snapshot: PoolData = ctx.accounts.pool.data;
    let flags = snapshot.hook_flags;
    let has_hook = snapshot.has_hook();
    let slot = Clock::get()?.slot;

    let hook_acc = HookAccounts {
        pool: ctx.accounts.pool.to_account_info(),
        caller: ctx.accounts.hook_caller.to_account_info(),
        caller_bump: ctx.bumps.hook_caller,
        user: ctx.accounts.user.to_account_info(),
        quote_mint: ctx.accounts.quote_mint.to_account_info(),
        base_mint: ctx.accounts.base_mint.to_account_info(),
        hook_program: ctx.accounts.hook_program.to_account_info(),
        extra_metas: ctx.accounts.hook_extra_metas.to_account_info(),
        remaining: ctx.remaining_accounts,
    };

    // 1. before_swap
    let ret = if has_hook && swap_callback_enabled(flags, BEFORE_SWAP, direction) {
        let payload = SwapPayload {
            direction,
            amount_in,
            net_in: 0,
            amount_out: 0,
            reserve_base: snapshot.reserve_base,
            reserve_quote: snapshot.reserve_quote,
            lp_fee_bps: snapshot.lp_fee_bps,
            slot,
        };
        let bytes = invoke_hook(&hook_acc, &snapshot, BEFORE_SWAP_DISC, &to_vec(&payload)?)?;
        parse_before_swap(
            bytes,
            flags,
            platform.max_hook_fee_bps,
            platform.max_fee_override_bps,
        )?
    } else {
        HookReturn::default()
    };

    // 2. math
    let q = math::quote_swap(
        direction,
        amount_in,
        snapshot.reserve_base,
        snapshot.reserve_quote,
        snapshot.virtual_quote,
        snapshot.lp_fee_bps,
        platform.protocol_fee_bps,
        ret.hook_fee_bps,
        ret.fee_override_bps,
        ret.curve.map(|c| c.amount_out_gross),
    )?;
    require!(q.amount_out >= min_amount_out, HookpoolError::Slippage);

    // 3. transfers
    let a = &ctx.accounts;
    let base_key = snapshot.base_mint;
    let quote_key = snapshot.quote_mint;
    let pool_bump = [snapshot.bump];
    let pool_seeds: &[&[u8]] = &[POOL_SEED, base_key.as_ref(), quote_key.as_ref(), &pool_bump];
    let signer: &[&[&[u8]]] = &[pool_seeds];

    let is_buy = direction == DIRECTION_BUY;
    let (tp_in, user_in, mint_in, vault_in, dec_in) = if is_buy {
        (&a.quote_token_program, &a.user_quote, &a.quote_mint, &a.quote_vault, a.quote_mint.decimals)
    } else {
        (&a.base_token_program, &a.user_base, &a.base_mint, &a.base_vault, a.base_mint.decimals)
    };
    let (tp_out, user_out, mint_out, vault_out, dec_out) = if is_buy {
        (&a.base_token_program, &a.user_base, &a.base_mint, &a.base_vault, a.base_mint.decimals)
    } else {
        (&a.quote_token_program, &a.user_quote, &a.quote_mint, &a.quote_vault, a.quote_mint.decimals)
    };

    // Paying a vault out to itself would move nothing while the reserves went down.
    require_keys_neq!(user_out.key(), vault_out.key(), HookpoolError::PayoutIsVault);
    require_keys_neq!(user_in.key(), vault_in.key(), HookpoolError::PayoutIsVault);

    // a coin with a transfer hook needs the hook's accounts in its transfer; the quote never has one
    let base_hook = hook_accounts_for(&snapshot.base_token_program, ctx.remaining_accounts, Some(a.hook_program.to_account_info()));
    let (hook_in, hook_out): (&[AccountInfo], &[AccountInfo]) = if is_buy { (&[], &base_hook) } else { (&base_hook, &[]) };
    transfer_user(
        tp_in.to_account_info(),
        user_in.to_account_info(),
        mint_in.to_account_info(),
        vault_in.to_account_info(),
        a.user.to_account_info(),
        amount_in,
        dec_in,
        hook_in,
    )?;
    transfer_pool(
        tp_out.to_account_info(),
        vault_out.to_account_info(),
        mint_out.to_account_info(),
        user_out.to_account_info(),
        a.pool.to_account_info(),
        signer,
        q.amount_out,
        dec_out,
        hook_out,
    )?;
    // A closed treasury must never block trades, and never costs the hook its fee: what
    // cannot be paid now waits in the quote vault, outside the reserves. It is paid with the
    // first later swap that finds the treasury, or by `collect_hook_fees`.
    let mut hook_fees_owed = snapshot.hook_fees_owed_quote;
    if q.hook_fee > 0 {
        require_keys_eq!(
            a.hook_quote_treasury.key(),
            snapshot.hook_quote_treasury,
            HookpoolError::HookTreasuryMismatch
        );
        require!(a.hook_quote_treasury.is_writable, HookpoolError::HookTreasuryMismatch);
        let t = a.hook_quote_treasury.to_account_info();
        let alive = t.lamports() > 0
            && *t.owner == snapshot.quote_token_program
            && t.data_len() >= 165;
        let due = hook_fees_owed.checked_add(q.hook_fee).ok_or(HookpoolError::MathOverflow)?;
        if alive {
            transfer_pool(
                a.quote_token_program.to_account_info(),
                a.quote_vault.to_account_info(),
                a.quote_mint.to_account_info(),
                t,
                a.pool.to_account_info(),
                signer,
                due,
                a.quote_mint.decimals,
                &[],
            )?;
            hook_fees_owed = 0;
        } else {
            hook_fees_owed = due;
        }
    }

    // 4. state
    {
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
        pool.hook_fees_owed_quote = hook_fees_owed;
        pool.hook_fees_quote_total = pool.hook_fees_quote_total.saturating_add(q.hook_fee);
        pool.volume_quote_total = pool.volume_quote_total.saturating_add(q.quote_volume);
        pool.swap_count = pool.swap_count.saturating_add(1);
    }
    let after: PoolData = ctx.accounts.pool.data;

    // 5. after_swap, with the fresh state already written so the hook can read it.
    if has_hook && swap_callback_enabled(flags, AFTER_SWAP, direction) {
        ctx.accounts.pool.exit(&crate::ID)?;
        let payload = SwapPayload {
            direction,
            amount_in,
            net_in: q.net_in,
            amount_out: q.amount_out,
            reserve_base: after.reserve_base,
            reserve_quote: after.reserve_quote,
            lp_fee_bps: after.lp_fee_bps,
            slot,
        };
        invoke_hook(&hook_acc, &after, AFTER_SWAP_DISC, &to_vec(&payload)?)?;
    }

    emit_cpi!(Swapped {
        pool: ctx.accounts.pool.key(),
        user: ctx.accounts.user.key(),
        direction,
        amount_in,
        amount_out: q.amount_out,
        protocol_fee: q.protocol_fee,
        hook_fee: q.hook_fee,
        lp_fee: q.lp_fee,
        fee_bps_applied: q.fee_bps_applied,
        reserve_base: after.reserve_base,
        reserve_quote: after.reserve_quote,
        slot,
        by_hook: false,
    });
    // Last, after the event CPI: a simulated swap returns the exact output as return data.
    set_return_data(&q.amount_out.to_le_bytes());
    Ok(())
}
