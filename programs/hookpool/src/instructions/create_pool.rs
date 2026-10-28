use crate::errors::HookpoolError;
use crate::events::{CurveOpened, PoolCreated};
use crate::hooks::{invoke_hook, HookAccounts};
use crate::loader::classify_hook;
use crate::math;
use crate::mints::{check_mint_allowed, token_account_for_mint, transfer_hook_program, COLLECTIBLE_HOOK_ID};
use crate::state::*;
use crate::transfers::{hook_accounts_for, mint_lp, transfer_user};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use hookpool_interface::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreatePoolArgs {
    pub lp_fee_bps: u16,
    pub base_amount: u64,
    pub quote_amount: u64,
}

/// A pool on the curve: no quote amount, the real quote reserve starts at 0.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateCurvePoolArgs {
    pub lp_fee_bps: u16,
    pub base_amount: u64,
}

/// The accounts of `create_pool` and of `create_curve_pool`: the same list, in the same
/// order, for both.
#[event_cpi]
#[derive(Accounts)]
pub struct CreatePool<'info> {
    /// Pays rent for the new accounts.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Owns the source token accounts, receives the LP tokens, recorded as creator.
    pub authority: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, pool.key().as_ref(), base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = pool,
        token::token_program = base_token_program
    )]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, pool.key().as_ref(), quote_mint.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = pool,
        token::token_program = quote_token_program
    )]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        seeds = [LP_MINT_SEED, pool.key().as_ref()],
        bump,
        mint::decimals = LP_DECIMALS,
        mint::authority = pool,
        mint::token_program = token_program
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        seeds = [LP_LOCK_SEED, pool.key().as_ref()],
        bump,
        token::mint = lp_mint,
        token::authority = pool,
        token::token_program = token_program
    )]
    pub lp_lock: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = base_mint,
        token::authority = authority,
        token::token_program = base_token_program
    )]
    pub authority_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = authority,
        token::token_program = quote_token_program
    )]
    pub authority_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = lp_mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program
    )]
    pub authority_lp: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the system program means "no hook"; anything else is validated in the handler.
    pub hook_program: UncheckedAccount<'info>,
    /// CHECK: loader state of the hook program (ProgramData for loader v3), validated in the handler.
    pub hook_program_data: UncheckedAccount<'info>,
    /// CHECK: the hook's manifest PDA, validated in the handler.
    pub hook_manifest: UncheckedAccount<'info>,
    /// CHECK: the hook's extra-metas PDA, validated in the handler.
    pub hook_extra_metas: UncheckedAccount<'info>,
    /// CHECK: quote token account that receives hook fees, validated in the handler.
    pub hook_quote_treasury: UncheckedAccount<'info>,
    /// CHECK: PDA that signs the callbacks of this pool's hook: ["caller", hook_program].
    /// Holds no data.
    #[account(seeds = [CALLER_SEED, hook_program.key().as_ref()], bump)]
    pub hook_caller: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// The settings a pool on the curve is created with, copied from the platform.
#[derive(Clone, Copy, Debug)]
struct CurveSettings {
    virtual_quote: u64,
    graduation_target: u64,
    graduation_fee_bps: u16,
}

pub fn handle_create_pool<'info>(
    ctx: Context<'info, CreatePool<'info>>,
    args: CreatePoolArgs,
) -> Result<()> {
    create(ctx, args.lp_fee_bps, args.base_amount, args.quote_amount, false)
}

pub fn handle_create_curve_pool<'info>(
    ctx: Context<'info, CreatePool<'info>>,
    args: CreateCurvePoolArgs,
) -> Result<()> {
    create(ctx, args.lp_fee_bps, args.base_amount, 0, true)
}

/// Both pools, one body. On the curve `quote_amount` is 0, the LP is
/// `isqrt(base_amount * virtual_quote)` and all of it goes to the lock account, the pool
/// must take the whole supply of a closed mint, and the hook may not own the price curve.
fn create<'info>(
    ctx: Context<'info, CreatePool<'info>>,
    lp_fee_bps: u16,
    base_amount: u64,
    quote_amount: u64,
    on_curve: bool,
) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.platform.paused, HookpoolError::Paused);
    require!(lp_fee_bps <= a.platform.max_lp_fee_bps, HookpoolError::FeeTooHigh);
    require!(base_amount > 0 && (on_curve || quote_amount > 0), HookpoolError::ZeroAmount);
    let curve = if on_curve {
        // The invariant of the curve (HOOKS.md section 2): the pool holds the WHOLE supply
        // and nobody can ever mint more. Then no wallet can sell coins into the pool that
        // did not come out of it, and a sell can never ask for more than the real reserve.
        require!(
            a.base_mint.supply == base_amount && a.base_mint.mint_authority.is_none(),
            HookpoolError::CurveSupplyNotInPool
        );
        require!(a.platform.curve_enabled(), HookpoolError::CurveDisabled);
        // copied, so that a later change of the platform does not touch a running curve
        Some(CurveSettings {
            virtual_quote: a.platform.curve_virtual_quote,
            graduation_target: a.platform.curve_graduation_target,
            graduation_fee_bps: a.platform.curve_graduation_fee_bps,
        })
    } else {
        None
    };
    require_keys_neq!(a.base_mint.key(), a.quote_mint.key(), HookpoolError::SameMint);
    require_keys_eq!(
        *a.base_mint.to_account_info().owner,
        a.base_token_program.key(),
        HookpoolError::TokenProgramMismatch
    );
    require_keys_eq!(
        *a.quote_mint.to_account_info().owner,
        a.quote_token_program.key(),
        HookpoolError::TokenProgramMismatch
    );

    // Initial LP supply = sqrt(base * quote), with the virtual quote standing in for the
    // quote on the curve. On a seeded pool MINIMUM_LIQUIDITY is locked forever and the rest
    // goes to the creator; on the curve every share is locked: the SOL is the buyers'.
    let quote_for_lp = match curve {
        Some(c) => c.virtual_quote,
        None => quote_amount,
    };
    let lp_total = math::isqrt_u128((base_amount as u128) * (quote_for_lp as u128));
    let lp_total = u64::try_from(lp_total).map_err(|_| HookpoolError::MathOverflow)?;
    require!(lp_total > MINIMUM_LIQUIDITY, HookpoolError::InitialLiquidityTooSmall);
    let (lp_to_lock, lp_to_authority) = if curve.is_some() {
        (lp_total, 0)
    } else {
        (MINIMUM_LIQUIDITY, lp_total - MINIMUM_LIQUIDITY)
    };

    // Hook classification. System program (all zeros) means no hook.
    let hook_key = a.hook_program.key();
    let (hook_program_id, hook_flags, hook_kind, extra_metas_key, treasury_key, treasury_owner) =
        if hook_key == Pubkey::default() {
            (Pubkey::default(), 0u32, HOOK_KIND_NONE, Pubkey::default(), Pubkey::default(), Pubkey::default())
        } else {
            let kind = classify_hook(
                &a.hook_program.to_account_info(),
                &a.hook_program_data.to_account_info(),
                a.platform.whitelist(),
            )?;
            // The approved list (HOOKS.md section 6.1): while the rule is on, a hook that is
            // not the platform's own opens a pool only once its program has been approved.
            if kind == HOOK_KIND_FROZEN && a.platform.hook_approval_required {
                require!(
                    crate::approvals::is_approved(&a.platform.to_account_info(), &hook_key)?,
                    HookpoolError::HookNotApproved
                );
            }
            let (manifest_addr, _) = manifest_address(&hook_key);
            require_keys_eq!(
                a.hook_manifest.key(),
                manifest_addr,
                HookpoolError::HookManifestAddress
            );
            let manifest = HookManifestData::read(&a.hook_manifest.to_account_info(), &hook_key)?;
            let (em_addr, _) = extra_metas_address(&hook_key);
            require_keys_eq!(
                a.hook_extra_metas.key(),
                em_addr,
                HookpoolError::HookExtraMetasAddress
            );
            require_keys_eq!(
                *a.hook_extra_metas.to_account_info().owner,
                hook_key,
                HookpoolError::HookExtraMetasOwner
            );
            let (treasury, treasury_owner) = if manifest.flags & TAKE_HOOK_FEE != 0 {
                let owner =
                    token_account_for_mint(&a.hook_quote_treasury.to_account_info(), &a.quote_mint.key())?;
                // Must be the owner's associated token account, so anyone can recreate it if it
                // is ever closed, and never the pool's own vault.
                let expected = get_associated_token_address_with_program_id(
                    &owner,
                    &a.quote_mint.key(),
                    &a.quote_token_program.key(),
                );
                require_keys_eq!(a.hook_quote_treasury.key(), expected, HookpoolError::HookTreasuryNotAta);
                require_keys_neq!(a.hook_quote_treasury.key(), a.quote_vault.key(), HookpoolError::HookTreasuryInvalid);
                (a.hook_quote_treasury.key(), owner)
            } else {
                (Pubkey::default(), Pubkey::default())
            };
            (hook_key, manifest.flags, kind, em_addr, treasury, treasury_owner)
        };
    // A hook that owns the price curve could pay out whatever it likes: never on the
    // curve, where only the real reserve is there to pay with.
    if curve.is_some() {
        require!(hook_flags & OVERRIDE_CURVE == 0, HookpoolError::CurveHook);
    }

    // Which mints the pool takes. The coin may carry a transfer hook only to this pool's
    // own hook program, and only when the platform runs that program: a hook on the coin
    // runs inside every sell.
    let own_hook = if hook_kind == HOOK_KIND_PLATFORM { Some(&hook_program_id) } else { None };
    check_mint_allowed(&a.base_mint.to_account_info(), own_hook)?;
    // A pegged coin (the collectible template as its transfer hook) does not open a pool
    // on the curve: the launchpad's rule, held here too for a pool made outside it.
    if on_curve {
        require!(
            transfer_hook_program(&a.base_mint.to_account_info())? != Some(COLLECTIBLE_HOOK_ID),
            HookpoolError::CurvePegged
        );
    }
    check_mint_allowed(&a.quote_mint.to_account_info(), None)?;
    // A freeze authority on the coin could freeze the pool's own vault: nobody could buy
    // and no LP could leave. So no pool has a freezable coin, whoever creates the pool.
    // (The quote token is the creator's choice; the launchpad and the site use wrapped SOL.)
    require!(a.base_mint.freeze_authority.is_none(), HookpoolError::BaseMintFreezable);

    // Pull the initial liquidity in. (A quote amount of 0 moves nothing.)
    let base_hook = hook_accounts_for(&a.base_token_program.key(), ctx.remaining_accounts, Some(a.hook_program.to_account_info()));
    transfer_user(
        a.base_token_program.to_account_info(),
        a.authority_base.to_account_info(),
        a.base_mint.to_account_info(),
        a.base_vault.to_account_info(),
        a.authority.to_account_info(),
        base_amount,
        a.base_mint.decimals,
        &base_hook,
    )?;
    transfer_user(
        a.quote_token_program.to_account_info(),
        a.authority_quote.to_account_info(),
        a.quote_mint.to_account_info(),
        a.quote_vault.to_account_info(),
        a.authority.to_account_info(),
        quote_amount,
        a.quote_mint.decimals,
        &[],
    )?;

    // Mint LP: the locked part to the lock account, the rest (none on the curve) to the creator.
    let base_key = a.base_mint.key();
    let quote_key = a.quote_mint.key();
    let pool_bump = [ctx.bumps.pool];
    let pool_seeds: &[&[u8]] = &[POOL_SEED, base_key.as_ref(), quote_key.as_ref(), &pool_bump];
    let signer: &[&[&[u8]]] = &[pool_seeds];
    mint_lp(
        a.token_program.to_account_info(),
        a.lp_mint.to_account_info(),
        a.lp_lock.to_account_info(),
        a.pool.to_account_info(),
        signer,
        lp_to_lock,
    )?;
    mint_lp(
        a.token_program.to_account_info(),
        a.lp_mint.to_account_info(),
        a.authority_lp.to_account_info(),
        a.pool.to_account_info(),
        signer,
        lp_to_authority,
    )?;

    let slot = Clock::get()?.slot;
    let creator = a.authority.key();
    let (virtual_quote, graduation_target, graduation_fee_bps, curve_state) = match curve {
        Some(c) => (c.virtual_quote, c.graduation_target, c.graduation_fee_bps, CURVE_OPEN),
        None => (0, 0, 0, CURVE_NONE),
    };
    let data = PoolData {
        bump: ctx.bumps.pool,
        base_mint: base_key,
        quote_mint: quote_key,
        base_vault: a.base_vault.key(),
        quote_vault: a.quote_vault.key(),
        lp_mint: a.lp_mint.key(),
        lp_lock: a.lp_lock.key(),
        base_token_program: a.base_token_program.key(),
        quote_token_program: a.quote_token_program.key(),
        lp_fee_bps,
        hook_program: hook_program_id,
        hook_flags,
        hook_extra_metas: extra_metas_key,
        hook_quote_treasury: treasury_key,
        hook_kind,
        reserve_base: base_amount,
        reserve_quote: quote_amount,
        protocol_fees_base: 0,
        protocol_fees_quote: 0,
        hook_fees_quote_total: 0,
        volume_quote_total: 0,
        swap_count: 0,
        created_slot: slot,
        creator,
        hook_fees_owed_quote: 0,
        hook_treasury_owner: treasury_owner,
        virtual_quote,
        graduation_target,
        graduation_fee_bps,
        curve_state,
        reserved: [0u8; 5],
    };
    let pool_key = ctx.accounts.pool.key();
    ctx.accounts.pool.data = data;
    ctx.accounts.platform.pool_count = ctx.accounts.platform.pool_count.saturating_add(1);

    if hook_kind != HOOK_KIND_NONE && hook_flags & ON_POOL_CREATE != 0 {
        // Write the pool state first so the hook can read account 0.
        ctx.accounts.pool.exit(&crate::ID)?;
        let payload = PoolCreatePayload {
            lp_fee_bps,
            base_amount,
            quote_amount,
            creator,
        };
        let acc = HookAccounts {
            pool: ctx.accounts.pool.to_account_info(),
            caller: ctx.accounts.hook_caller.to_account_info(),
            caller_bump: ctx.bumps.hook_caller,
            user: ctx.accounts.authority.to_account_info(),
            quote_mint: ctx.accounts.quote_mint.to_account_info(),
            base_mint: ctx.accounts.base_mint.to_account_info(),
            hook_program: ctx.accounts.hook_program.to_account_info(),
            extra_metas: ctx.accounts.hook_extra_metas.to_account_info(),
            remaining: ctx.remaining_accounts,
        };
        invoke_hook(&acc, &data, ON_POOL_CREATE_DISC, &to_vec(&payload)?)?;
    }

    emit_cpi!(PoolCreated {
        pool: pool_key,
        base_mint: base_key,
        quote_mint: quote_key,
        creator,
        hook_program: hook_program_id,
        hook_flags,
        hook_kind,
        lp_fee_bps,
        base_amount,
        quote_amount,
        lp_minted: lp_to_authority,
        slot,
    });
    if let Some(c) = curve {
        emit_cpi!(CurveOpened {
            pool: pool_key,
            virtual_quote: c.virtual_quote,
            graduation_target: c.graduation_target,
            graduation_fee_bps: c.graduation_fee_bps,
            slot,
        });
    }
    Ok(())
}
