//! hookpool: a constant-product AMM on Solana where every pool may name a hook
//! program that is called before and after swaps and liquidity changes.
//! The contract between pool and hooks is HOOKS.md at the repo root.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

pub mod approvals;
pub mod errors;
pub mod events;
pub mod hooks;
pub mod instructions;
pub mod loader;
pub mod math;
pub mod mints;
pub mod state;
pub mod transfers;

use anchor_lang::prelude::*;
pub use instructions::*;
pub use state::*;

declare_id!("7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh");

#[program]
pub mod hookpool {
    use super::*;

    // ---- platform -----------------------------------------------------------

    pub fn init_platform(ctx: Context<InitPlatform>, args: InitPlatformArgs) -> Result<()> {
        handle_init_platform(ctx, args)
    }

    pub fn update_platform(ctx: Context<AdminOnly>, args: UpdatePlatformArgs) -> Result<()> {
        handle_update_platform(ctx, args)
    }

    pub fn set_whitelist(ctx: Context<AdminOnly>, keys: Vec<Pubkey>) -> Result<()> {
        handle_set_whitelist(ctx, keys)
    }

    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        handle_transfer_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        handle_accept_admin(ctx)
    }

    // ---- pools ----------------------------------------------------------------

    pub fn create_pool<'info>(
        ctx: Context<'info, CreatePool<'info>>,
        args: CreatePoolArgs,
    ) -> Result<()> {
        handle_create_pool(ctx, args)
    }

    pub fn add_liquidity<'info>(
        ctx: Context<'info, ModifyLiquidity<'info>>,
        lp_amount: u64,
        max_base: u64,
        max_quote: u64,
    ) -> Result<()> {
        handle_add_liquidity(ctx, lp_amount, max_base, max_quote)
    }

    pub fn remove_liquidity<'info>(
        ctx: Context<'info, ModifyLiquidity<'info>>,
        lp_amount: u64,
        min_base: u64,
        min_quote: u64,
    ) -> Result<()> {
        handle_remove_liquidity(ctx, lp_amount, min_base, min_quote)
    }

    /// direction: 0 = buy (quote in, base out), 1 = sell (base in, quote out). Exact input.
    pub fn swap<'info>(
        ctx: Context<'info, Swap<'info>>,
        direction: u8,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        handle_swap(ctx, direction, amount_in, min_amount_out)
    }

    /// Same as `swap`, started by the pool's hook. No callbacks, no hook fee.
    pub fn hook_swap(
        ctx: Context<HookSwap>,
        direction: u8,
        amount_in: u64,
        min_amount_out: u64,
        authority_bump: u8,
    ) -> Result<()> {
        handle_hook_swap(ctx, direction, amount_in, min_amount_out, authority_bump)
    }

    pub fn collect_protocol_fees<'info>(ctx: Context<'info, CollectProtocolFees<'info>>) -> Result<()> {
        handle_collect_protocol_fees(ctx)
    }

    /// Pays the hook fees that waited for a closed treasury. Anyone may call it.
    pub fn collect_hook_fees(ctx: Context<CollectHookFees>) -> Result<()> {
        handle_collect_hook_fees(ctx)
    }

    /// A buy started by the pool's hook whose coins are burned in the pool's vault and
    /// never transferred. Who may call it, the price and the fees are those of
    /// `hook_swap` in the buy direction. (Added after every other instruction, so that
    /// nothing before it moves.)
    pub fn hook_buy_burn(ctx: Context<HookBuyBurn>, amount_in: u64, min_amount_out: u64, authority_bump: u8) -> Result<()> {
        handle_hook_buy_burn(ctx, amount_in, min_amount_out, authority_bump)
    }

    // ---- the curve launch (added after every other instruction; HOOKS.md section 2) ----

    /// A pool on the curve: the whole supply of the coin and no quote at all. It prices
    /// trades with the platform's virtual quote on top of its real reserve, pays out the
    /// real reserve only, refuses liquidity until it graduates, and locks all of its LP.
    /// The same accounts as `create_pool`.
    pub fn create_curve_pool<'info>(
        ctx: Context<'info, CreatePool<'info>>,
        args: CreateCurvePoolArgs,
    ) -> Result<()> {
        handle_create_curve_pool(ctx, args)
    }

    /// Permissionless: once a pool on the curve holds its graduation target in real quote,
    /// drop the virtual quote, take the platform's share, and burn the coins that the
    /// virtual quote stood for, so that the price does not move.
    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        handle_graduate(ctx)
    }

    // ---- the approved list (added after every other instruction; HOOKS.md section 6.1) ----

    /// Admin: puts a frozen hook program on the approved list. While
    /// `Platform::hook_approval_required` is on, only listed programs (and the platform's own
    /// hooks) can open a pool. The admin pays the rent of the platform account's growth.
    pub fn approve_hook(ctx: Context<ApproveHook>) -> Result<()> {
        handle_approve_hook(ctx)
    }

    /// Admin: takes a program off the approved list. Pools already on it are not touched.
    pub fn revoke_hook(ctx: Context<RevokeHook>, program: Pubkey) -> Result<()> {
        handle_revoke_hook(ctx, program)
    }
}
