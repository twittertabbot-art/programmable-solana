//! Graduation of a pool on the curve (HOOKS.md section 2, "A pool on the curve").
//!
//! While the curve is open the pool prices trades with `reserve_quote + virtual_quote` and
//! pays out `reserve_quote`. Once the real reserve has reached the graduation target,
//! anyone may call this: the virtual quote is dropped, the platform's share of the target
//! leaves the reserve into `protocol_fees_quote`, and the coins the virtual quote stood
//! for are burned from the vault, so that the price is the same before and after (it may
//! move up by one unit of the coin from flooring, never down). From then on the pool is an
//! ordinary pool: liquidity opens, the hook keeps running, the address does not change.
//!
//! No hook callback and no treasury account: nothing is paid to anyone here. The fee is
//! collected later by `collect_protocol_fees`, as every protocol fee is. On a pool that
//! already graduated, and on an open pool whose real reserve is under its target, the
//! instruction succeeds and does nothing, so that a `graduate` a client appends to a trade
//! never fails the trade. It fails only on a seeded pool (`NotOnCurve`) and while the
//! platform is paused on a pool that has not graduated (`Paused`).

use crate::errors::HookpoolError;
use crate::events::Graduated;
use crate::math;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};
use hookpool_interface::*;

#[event_cpi]
#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(
        mut,
        seeds = [POOL_SEED, pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        bump = pool.bump,
        has_one = base_mint,
        has_one = base_vault,
        has_one = base_token_program @ HookpoolError::TokenProgramMismatch,
    )]
    pub pool: Box<Account<'info, Pool>>,
    /// Writable: the burn lowers the coin's supply.
    #[account(mut)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_graduate(ctx: Context<Graduate>) -> Result<()> {
    let snapshot: PoolData = ctx.accounts.pool.data;
    // Already graduated: nothing to do and no error. A client appends `graduate` to a trade
    // on a pool past its target; the first to land graduates, and every later one must not
    // fail the trade it travels with. Nothing is written and no event is emitted.
    if snapshot.curve_state == CURVE_GRADUATED {
        return Ok(());
    }
    // The pause is the platform's emergency stop; graduation can wait, as every trade does.
    // It comes before the no-op below: while paused every trade fails first anyway, so a
    // trade can never be lost to this refusal, and a crank is told why nothing happens.
    require!(!ctx.accounts.platform.paused, HookpoolError::Paused);
    // a seeded pool was never on the curve
    require!(snapshot.on_curve(), HookpoolError::NotOnCurve);
    // Open but under the target: nothing to do and no error. A client appends `graduate` to
    // the buy that crosses the target; a sell that lands in between can take the pool back
    // under it, and the graduate must then not fail the buy it travels with. Nothing is
    // written and no event is emitted. (So `GraduationNotReached` is returned by nothing.)
    if snapshot.reserve_quote < snapshot.graduation_target {
        return Ok(());
    }
    let g = math::graduation(
        snapshot.reserve_base,
        snapshot.reserve_quote,
        snapshot.virtual_quote,
        snapshot.graduation_target,
        snapshot.graduation_fee_bps,
    )?;

    // The coins leave the pool by being burned in its own vault, signed by the pool: the
    // path `hook_buy_burn` uses, for both token programs. A burn runs no transfer hook.
    if g.burned_base > 0 {
        let a = &ctx.accounts;
        let pool_bump = [snapshot.bump];
        let pool_seeds: &[&[u8]] = &[POOL_SEED, snapshot.base_mint.as_ref(), snapshot.quote_mint.as_ref(), &pool_bump];
        token_interface::burn(
            CpiContext::new_with_signer(
                a.base_token_program.key(),
                Burn { mint: a.base_mint.to_account_info(), from: a.base_vault.to_account_info(), authority: a.pool.to_account_info() },
                &[pool_seeds],
            ),
            g.burned_base,
        )?;
    }

    let slot = Clock::get()?.slot;
    let pool_key = ctx.accounts.pool.key();
    let pool = &mut ctx.accounts.pool;
    pool.reserve_base = g.reserve_base_after;
    pool.reserve_quote = g.reserve_quote_after;
    // the fee stays in the quote vault, outside the reserves, until it is collected
    pool.protocol_fees_quote = pool.protocol_fees_quote.checked_add(g.fee_quote).ok_or(HookpoolError::MathOverflow)?;
    pool.virtual_quote = 0;
    pool.graduation_target = 0;
    pool.curve_state = CURVE_GRADUATED;
    emit_cpi!(Graduated {
        pool: pool_key,
        reserve_quote_before: snapshot.reserve_quote,
        reserve_quote_after: g.reserve_quote_after,
        reserve_base_before: snapshot.reserve_base,
        reserve_base_after: g.reserve_base_after,
        burned_base: g.burned_base,
        fee_quote: g.fee_quote,
        slot,
    });
    Ok(())
}
