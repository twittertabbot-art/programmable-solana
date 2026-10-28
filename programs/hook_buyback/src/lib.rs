//! hook_buyback: platform template hook.
//!
//! Takes `buy_bps` / `sell_bps` of every swap in quote into a treasury owned by this
//! hook's per-pool authority PDA. Once the treasury holds at least `min_quote`,
//! anyone can call `execute_buyback`: the hook buys the coin from its own pool via
//! `hook_swap` (no callbacks, no hook fee) and burns everything it bought.
//!
//! Anyone can call it and choose its `min_amount_out`, so a caller could buy first and
//! sell into the price the buyback makes, or deepen the pool with liquidity for one
//! transaction so that a share of the reserve becomes a large amount. So a buyback never
//! buys at a price or on a depth its caller just made (`burn_step` of the interface
//! crate): it buys against an observation of the pool that is at least
//! BURN_INTERVAL_SLOTS old, only while the price is not above the observed one by more
//! than twice the cap, and spends at most `burn_cap_bps` of the smaller of the quote
//! reserve now and the observed one. `before_swap` lowers the observed price whenever a
//! trade starts below it, and never raises the observed depth, so the config is writable
//! in every swap.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};
use hookpool::program::Hookpool;
use hookpool::Platform;
use hookpool_interface::*;

declare_id!("3M824Hn8Z6S7r1t1zqpNQpioKFd31jrQwSN2oxV2ovo5");

pub const CFG_SEED: &[u8] = b"cfg";
pub const FLAGS: u32 = BEFORE_SWAP | ON_POOL_CREATE | TAKE_HOOK_FEE | CALL_ON_BUY | CALL_ON_SELL;
pub const HARD_MAX_BPS: u16 = 1_000;
/// The largest `min_quote` a config may ask for: 1 SOL when the quote is wrapped SOL. A
/// larger minimum could keep the buyback from ever running.
pub const MAX_MIN_QUOTE: u64 = 1_000_000_000;
/// The most a single buyback may spend, in basis points of the pool's quote reserve. The
/// cap of a pool is `burn_cap_bps` of the interface crate, which follows the fees of a buy
/// and a sell on it, and is never above this.
pub const MAX_BUYBACK_BPS: u64 = MAX_BURN_CAP_BPS;

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
pub struct BuybackConfig {
    pub bump: u8,
    pub authority_bump: u8,
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    /// ATA of the authority PDA for the quote mint. Must be the pool's hook treasury.
    pub treasury: Pubkey,
    pub buy_bps: u16,
    pub sell_bps: u16,
    pub min_quote: u64,
    pub total_quote_spent: u64,
    pub total_base_burned: u64,
    pub buybacks: u64,
    /// Who paid for this config. Must be the pool creator.
    pub creator: Pubkey,
    /// The observation `execute_buyback` buys against (`burn_step` of the interface
    /// crate): the slot it was taken in and the pool's reserves then. No observation yet
    /// while a reserve is zero. `before_swap` lowers the observed price, never raises
    /// the observed depth, and leaves the slot, when a trade starts below the observed
    /// price (`burn_lowered`).
    pub obs_slot: u64,
    pub obs_reserve_base: u64,
    pub obs_reserve_quote: u64,
}

impl BuybackConfig {
    /// The most one buyback may spend, in basis points of the pool's quote reserve. The
    /// whole hook fee goes to the treasury, so all of it is a cost nobody gets back.
    pub fn cap_bps(&self, protocol_fee_bps: u16, max_hook_fee_bps: u16, lp_fee_bps: u16) -> u64 {
        burn_cap_bps(
            protocol_fee_bps,
            lp_fee_bps,
            self.buy_bps.min(max_hook_fee_bps),
            self.sell_bps.min(max_hook_fee_bps),
        )
    }
}

/// Emitted through event CPI by every `execute_buyback` that returns Ok. `outcome` says
/// what it did: `BURN_OBSERVED` (1, the first observation, nothing bought), `BURN_WAITED`
/// (2, the price was above the observation by more than the tolerance, nothing bought)
/// or `BURN_BOUGHT` (3). The observation is the one the call left in the config.
#[event]
pub struct BuybackExecuted {
    pub pool: Pubkey,
    pub quote_spent: u64,
    pub base_burned: u64,
    pub slot: u64,
    pub outcome: u8,
    pub obs_reserve_base: u64,
    pub obs_reserve_quote: u64,
}

#[error_code]
pub enum BuybackError {
    #[msg("tax above the hard maximum")]
    TaxTooHigh,
    #[msg("config does not belong to this pool")]
    WrongPool,
    #[msg("pool treasury is not this hook's treasury")]
    WrongTreasury,
    #[msg("pool mints do not match the config")]
    WrongMints,
    #[msg("treasury below min_quote, nothing to buy back yet")]
    BelowThreshold,
    #[msg("nothing was bought")]
    NothingBought,
    #[msg("config was not created by the pool creator")]
    WrongCreator,
    #[msg("the buyback's observation of the pool is less than 25 slots old")]
    TooSoon,
    #[msg("min_quote above the maximum")]
    MinQuoteTooHigh,
}

#[program]
pub mod hook_buyback {
    use super::*;

    pub fn init_manifest(ctx: Context<InitManifest>, uri: String) -> Result<()> {
        require_upgrade_authority(
            &crate::ID,
            &ctx.accounts.program_data.to_account_info(),
            &ctx.accounts.authority.key(),
        )?;
        let m = HookManifestData::new(FLAGS, None, "Programmable buyback", &uri);
        let man = &mut ctx.accounts.manifest;
        man.version = m.version;
        man.flags = m.flags;
        man.admin = m.admin;
        man.name = m.name;
        man.uri = m.uri;
        // writable: `before_swap` lowers the buyback's observation
        let metas = [per_pool_config_meta(CFG_SEED, true)?];
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        init_extra_metas(&mut data, &metas)
    }

    /// Before `create_pool`. Also creates the two token accounts the authority PDA needs.
    /// The pool's `hook_quote_treasury` must be `cfg.treasury`.
    pub fn init_pool_config(
        ctx: Context<InitPoolConfig>,
        pool: Pubkey,
        buy_bps: u16,
        sell_bps: u16,
        min_quote: u64,
    ) -> Result<()> {
        require!(buy_bps <= HARD_MAX_BPS && sell_bps <= HARD_MAX_BPS, BuybackError::TaxTooHigh);
        require!(min_quote <= MAX_MIN_QUOTE, BuybackError::MinQuoteTooHigh);
        require_keys_eq!(
            pool,
            pool_address(&ctx.accounts.base_mint.key(), &ctx.accounts.quote_mint.key()).0,
            BuybackError::WrongPool
        );
        let cfg = &mut ctx.accounts.cfg;
        cfg.bump = ctx.bumps.cfg;
        cfg.authority_bump = ctx.bumps.hook_authority;
        cfg.pool = pool;
        cfg.base_mint = ctx.accounts.base_mint.key();
        cfg.quote_mint = ctx.accounts.quote_mint.key();
        cfg.treasury = ctx.accounts.treasury_quote.key();
        cfg.buy_bps = buy_bps;
        cfg.sell_bps = sell_bps;
        cfg.min_quote = min_quote;
        cfg.creator = ctx.accounts.payer.key();
        Ok(())
    }

    pub fn on_pool_create(ctx: Context<Callback>, payload: PoolCreatePayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        let cfg = &ctx.accounts.cfg;
        require_keys_eq!(cfg.pool, ctx.accounts.pool.key(), BuybackError::WrongPool);
        require_keys_eq!(cfg.creator, payload.creator, BuybackError::WrongCreator);
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        // and as the pool program wrote it, not only as the payload says
        require_keys_eq!(cfg.creator, pool.creator, BuybackError::WrongCreator);
        require!(
            pool.base_mint == cfg.base_mint && pool.quote_mint == cfg.quote_mint,
            BuybackError::WrongMints
        );
        require_keys_eq!(pool.hook_quote_treasury, cfg.treasury, BuybackError::WrongTreasury);
        Ok(())
    }

    pub fn before_swap(ctx: Context<Callback>, payload: SwapPayload) -> Result<()> {
        verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
        // The price a trade starts at is made of the EFFECTIVE quote: on a pool on the
        // curve the virtual quote counts in it (HOOKS.md section 2). The payload carries
        // the real reserve; the virtual part is read from the pool account.
        let virtual_quote = PoolData::read(&ctx.accounts.pool.to_account_info())?.virtual_quote;
        let effective_quote = payload.reserve_quote.checked_add(virtual_quote).ok_or(InterfaceError::QuoteOverflow)?;
        let cfg = &mut ctx.accounts.cfg;
        // the buyback's observation never stands above a price a trade starts at. Only
        // its price moves: the observed depth is never raised by a trade.
        if let Some((base, quote)) = burn_lowered(cfg.obs_reserve_base, cfg.obs_reserve_quote, payload.reserve_base, effective_quote) {
            cfg.obs_reserve_base = base;
            cfg.obs_reserve_quote = quote;
        }
        let bps = if payload.direction == DIRECTION_BUY { cfg.buy_bps } else { cfg.sell_bps };
        HookReturn::hook_fee(bps).set()
    }

    /// Permissionless: anyone may call it and choose `min_amount_out`. It buys against
    /// an observation of the pool at least BURN_INTERVAL_SLOTS old (`burn_step`):
    ///
    /// * the first call of a pool only records the observation;
    /// * a call that comes too soon fails with `TooSoon` and writes nothing;
    /// * when the price is above the observed one by more than twice the cap, it buys
    ///   nothing and records the reserves as the new observation;
    /// * otherwise it spends the treasury, at most `cap_bps` of the smaller of the quote
    ///   reserve now and the observed one, burns what it bought and records the reserves
    ///   after the buy;
    /// * between calls, every trade that starts below the observed price lowers the
    ///   observed price to the one it started at, without raising the observed depth
    ///   (`before_swap`, `burn_lowered`).
    ///
    /// Every call that returns Ok emits `BuybackExecuted` with its outcome and sets
    /// return data: the outcome byte, then quote spent and coins burned.
    pub fn execute_buyback(ctx: Context<ExecuteBuyback>, min_amount_out: u64) -> Result<()> {
        let cfg = &ctx.accounts.cfg;
        let balance = ctx.accounts.treasury_quote.amount;
        require!(balance > 0 && balance >= cfg.min_quote, BuybackError::BelowThreshold);
        let slot = Clock::get()?.slot;
        let pool = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        // Prices and depths are measured on the EFFECTIVE quote, real plus virtual: on a
        // pool on the curve the price impact of a buy follows the effective depth, and
        // after graduation (virtual 0, price kept) an observation taken before it still
        // compares right.
        let effective_quote = pool.effective_quote()?;
        let platform = &ctx.accounts.platform;
        let cap_bps = cfg.cap_bps(platform.protocol_fee_bps, platform.max_hook_fee_bps, pool.lp_fee_bps);
        let step = burn_step(
            cfg.obs_reserve_base,
            cfg.obs_reserve_quote,
            cfg.obs_slot,
            pool.reserve_base,
            effective_quote,
            slot,
            cap_bps,
        );
        let pool_key = cfg.pool;
        let authority_bump = cfg.authority_bump;

        let (outcome, quote_amount, bought, obs_base, obs_quote) = match step {
            BurnStep::TooSoon => return err!(BuybackError::TooSoon),
            BurnStep::Observe => (BURN_OBSERVED, 0, 0, pool.reserve_base, effective_quote),
            BurnStep::Wait => (BURN_WAITED, 0, 0, pool.reserve_base, effective_quote),
            BurnStep::Buy { max_spend } => {
                let quote_amount = balance.min(max_spend);
                let bought = buy_and_burn(ctx.accounts, &pool_key, authority_bump, quote_amount, min_amount_out)?;
                // the pool as this buy left it is what the next one is measured against
                let after = PoolData::read(&ctx.accounts.pool.to_account_info())?;
                (BURN_BOUGHT, quote_amount, bought, after.reserve_base, after.effective_quote()?)
            }
        };

        let cfg = &mut ctx.accounts.cfg;
        if outcome == BURN_BOUGHT {
            cfg.total_quote_spent = cfg.total_quote_spent.saturating_add(quote_amount);
            cfg.total_base_burned = cfg.total_base_burned.saturating_add(bought);
            cfg.buybacks = cfg.buybacks.saturating_add(1);
        }
        cfg.obs_slot = slot;
        cfg.obs_reserve_base = obs_base;
        cfg.obs_reserve_quote = obs_quote;
        emit_cpi!(BuybackExecuted {
            pool: pool_key,
            quote_spent: quote_amount,
            base_burned: bought,
            slot,
            outcome,
            obs_reserve_base: obs_base,
            obs_reserve_quote: obs_quote,
        });
        // last: the event CPI clears return data
        set_burn_result(outcome, quote_amount, bought);
        Ok(())
    }
}

/// The buy through the pool's `hook_swap` and the burn of everything it bought. In its
/// own stack frame.
#[inline(never)]
fn buy_and_burn(
    a: &mut ExecuteBuyback,
    pool_key: &Pubkey,
    authority_bump: u8,
    quote_amount: u64,
    min_amount_out: u64,
) -> Result<u64> {
    let bump = [authority_bump];
    let seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, pool_key.as_ref(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];
    let cpi_accounts = hookpool::cpi::accounts::HookSwap {
        hook_authority: a.hook_authority.to_account_info(),
        platform: a.platform.to_account_info(),
        pool: a.pool.to_account_info(),
        base_mint: a.base_mint.to_account_info(),
        quote_mint: a.quote_mint.to_account_info(),
        base_vault: a.base_vault.to_account_info(),
        quote_vault: a.quote_vault.to_account_info(),
        hook_base: a.authority_base.to_account_info(),
        hook_quote: a.treasury_quote.to_account_info(),
        base_token_program: a.base_token_program.to_account_info(),
        quote_token_program: a.quote_token_program.to_account_info(),
        event_authority: a.hookpool_event_authority.to_account_info(),
        program: a.hookpool_program.to_account_info(),
    };
    hookpool::cpi::hook_swap(
        CpiContext::new_with_signer(a.hookpool_program.key(), cpi_accounts, signer),
        DIRECTION_BUY,
        quote_amount,
        min_amount_out,
        authority_bump,
    )?;
    a.authority_base.reload()?;
    let bought = a.authority_base.amount;
    require!(bought > 0, BuybackError::NothingBought);
    token_interface::burn(
        CpiContext::new_with_signer(
            a.base_token_program.key(),
            Burn {
                mint: a.base_mint.to_account_info(),
                from: a.authority_base.to_account_info(),
                authority: a.hook_authority.to_account_info(),
            },
            signer,
        ),
        bought,
    )?;
    Ok(bought)
}

/// Where this hook's treasury for a pool lives.
pub fn treasury_address(pool: &Pubkey, quote_mint: &Pubkey, quote_token_program: &Pubkey) -> Pubkey {
    let (authority, _) = hook_authority_address(pool, &crate::ID);
    get_associated_token_address_with_program_id(&authority, quote_mint, quote_token_program)
}

#[derive(Accounts)]
pub struct InitManifest<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: this program's ProgramData, parsed in the handler.
    pub program_data: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + HookManifest::INIT_SPACE, seeds = [MANIFEST_SEED], bump)]
    pub manifest: Account<'info, HookManifest>,
    /// CHECK: raw TLV account, written by the handler.
    #[account(init, payer = authority, space = extra_metas_size(1).unwrap(), seeds = [EXTRA_METAS_SEED], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool: Pubkey)]
pub struct InitPoolConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + BuybackConfig::INIT_SPACE, seeds = [CFG_SEED, pool.as_ref()], bump)]
    pub cfg: Account<'info, BuybackConfig>,
    /// CHECK: PDA that owns the treasury and signs hook_swap. Holds no data.
    #[account(seeds = [HOOK_AUTHORITY_SEED, pool.as_ref()], bump)]
    pub hook_authority: UncheckedAccount<'info>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// `init_if_needed`: anyone can create an associated token account for any owner, and
    /// a plain `init` would let a stranger block this instruction by creating one of these
    /// two first. An account that is already there is the same account.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = quote_mint,
        associated_token::authority = hook_authority,
        associated_token::token_program = quote_token_program
    )]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = base_mint,
        associated_token::authority = hook_authority,
        associated_token::token_program = base_token_program
    )]
    pub authority_base: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Callback<'info> {
    /// CHECK: the Pool account.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: verified against the pool program's caller PDA in the handler.
    pub hook_caller: Signer<'info>,
    /// CHECK: the trader.
    pub user: UncheckedAccount<'info>,
    /// CHECK: quote mint.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: base mint.
    pub base_mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [CFG_SEED, pool.key().as_ref()], bump = cfg.bump)]
    pub cfg: Account<'info, BuybackConfig>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ExecuteBuyback<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CFG_SEED, cfg.pool.as_ref()], bump = cfg.bump, has_one = base_mint, has_one = quote_mint)]
    pub cfg: Box<Account<'info, BuybackConfig>>,
    /// CHECK: PDA signer, checked by seeds.
    #[account(seeds = [HOOK_AUTHORITY_SEED, cfg.pool.as_ref()], bump = cfg.authority_bump)]
    pub hook_authority: UncheckedAccount<'info>,
    /// The platform: its protocol fee and its hook fee cap decide how much a buyback may spend.
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, seeds::program = hookpool::ID)]
    pub platform: Box<Account<'info, Platform>>,
    /// CHECK: validated by the pool program.
    #[account(mut, address = cfg.pool)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: validated by the pool program.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    #[account(mut, address = cfg.treasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = base_mint, token::authority = hook_authority)]
    pub authority_base: Box<InterfaceAccount<'info, TokenAccount>>,
    pub hookpool_program: Program<'info, Hookpool>,
    /// CHECK: hookpool's event authority PDA, validated by hookpool itself.
    pub hookpool_event_authority: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}
