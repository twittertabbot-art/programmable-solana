//! hooklaunch: the launchpad on top of hookpool.
//!
//! Two instructions, two transactions:
//! 1. `create_token`: plain SPL mint with Metaplex metadata, whole supply to the dev,
//!    mint authority revoked, no freeze authority. Or a pegged coin: the same coin as a
//!    Token-2022 mint whose transfer hook is the chosen hook program forever, so that
//!    the hook runs inside every transfer. That one takes `create_pegged_mint`, the token
//!    program's own metadata instructions, then `finish_pegged_token`.
//! 2. `launch`: pays the platform launch fee, creates the pool through hookpool with
//!    the chosen hook, locks ALL the LP in the pool's lock account so the liquidity can
//!    never be pulled, records the launch, and optionally performs the dev's first buy.
//!    Atomic. The shares are locked, not burned: burning would leave a supply of 1,000
//!    units and every later deposit would move in steps of 0.1% of the pool.

#![allow(clippy::result_large_err)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
    Metadata,
};
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::spl_token_2022::{
    extension::StateWithExtensions, state::Account as SplAccount,
};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Mint as MintInterface, TokenAccount as TokenAccountInterface, TokenInterface};
use hookpool::program::Hookpool;
use hookpool::{CreateCurvePoolArgs, CreatePoolArgs, Platform};
use hookpool_interface::*;

declare_id!("9cDfF7wD6EirDZbb5DWCw3HZ3ZPQ1oeh87YyMGvbPRxi");

pub const LAUNCH_SEED: &[u8] = b"launch";

/// The collectible template, `hook_collectible`. A Token-2022 coin whose transfer hook is
/// this program is a pegged coin (HOOKS.md section 13): its pieces follow the coin in every
/// transfer. Such a coin does not launch on the curve (`CurvePegged`).
pub const COLLECTIBLE_HOOK_ID: Pubkey = Pubkey::from_str_const("3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m");

/// `Launch.reserved[0]` (byte 201 of the account) is 1 for a launch on the curve.
pub const LAUNCH_KIND_CURVE: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub bump: u8,
    pub dev: Pubkey,
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub hook_program: Pubkey,
    /// LP the launch minted to the dev and moved to the pool's lock account, forever.
    pub lp_locked: u64,
    pub launch_fee_paid: u64,
    pub dev_buy_quote: u64,
    pub created_slot: u64,
    /// `reserved[0]`: 0 for a seeded launch, `LAUNCH_KIND_CURVE` (1) for a launch on the
    /// curve. The rest is zero.
    pub reserved: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateTokenArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub decimals: u8,
    pub total_supply: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LaunchArgs {
    pub lp_fee_bps: u16,
    pub base_amount: u64,
    pub quote_amount: u64,
    /// 0 = no dev buy.
    pub dev_buy_quote: u64,
    pub min_dev_buy_out: u64,
}

/// A launch on the curve: no quote from the dev, the whole supply into the pool
/// (`base_amount` is the mint's supply), an optional first buy at the curve price.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LaunchCurveArgs {
    pub lp_fee_bps: u16,
    /// 0 = no dev buy.
    pub dev_buy_quote: u64,
    pub min_dev_buy_out: u64,
}

#[event]
pub struct TokenCreated {
    pub mint: Pubkey,
    pub dev: Pubkey,
    pub decimals: u8,
    pub total_supply: u64,
}

#[event]
pub struct Launched {
    pub launch: Pubkey,
    pub pool: Pubkey,
    pub dev: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub hook_program: Pubkey,
    pub lp_locked: u64,
    pub launch_fee_paid: u64,
    pub dev_buy_quote: u64,
    pub slot: u64,
}

#[error_code]
pub enum LaunchError {
    #[msg("name longer than 32 bytes")]
    NameTooLong,
    #[msg("symbol longer than 10 bytes")]
    SymbolTooLong,
    #[msg("uri longer than 200 bytes")]
    UriTooLong,
    #[msg("total supply must be greater than zero")]
    ZeroSupply,
    #[msg("no LP was minted")]
    NoLp,
    #[msg("LP token account could not be read")]
    LpAccount,
    #[msg("launch mint must have no mint authority and no freeze authority")]
    MintAuthority,
    #[msg("launches do not accept hooks that own the price curve")]
    CurveHook,
    #[msg("the coin has no name yet: write its Token-2022 metadata first")]
    MetadataMissing,
    #[msg("the coin's metadata still has an update authority: remove it first")]
    MetadataNotFinal,
    #[msg("coins of this mint already exist: the supply would not be the one stated")]
    SupplyNotZero,
    #[msg("a pegged coin cannot launch on the curve")]
    CurvePegged,
}

#[program]
pub mod hooklaunch {
    use super::*;

    pub fn create_token(ctx: Context<CreateToken>, args: CreateTokenArgs) -> Result<()> {
        require!(args.name.len() <= 32, LaunchError::NameTooLong);
        require!(args.symbol.len() <= 10, LaunchError::SymbolTooLong);
        require!(args.uri.len() <= 200, LaunchError::UriTooLong);
        require!(args.total_supply > 0, LaunchError::ZeroSupply);

        create_metadata_accounts_v3(
            CpiContext::new(
                ctx.accounts.token_metadata_program.key(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    mint_authority: ctx.accounts.dev.to_account_info(),
                    payer: ctx.accounts.dev.to_account_info(),
                    update_authority: ctx.accounts.dev.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            DataV2 {
                name: args.name,
                symbol: args.symbol,
                uri: args.uri,
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            false, // is_mutable: the metadata is final
            true,  // update_authority_is_signer
            None,
        )?;

        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.dev_ata.to_account_info(),
                    authority: ctx.accounts.dev.to_account_info(),
                },
            ),
            args.total_supply,
        )?;

        // Fixed supply forever.
        token::set_authority(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                SetAuthority {
                    current_authority: ctx.accounts.dev.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            anchor_spl::token::spl_token::instruction::AuthorityType::MintTokens,
            None,
        )?;

        emit!(TokenCreated {
            mint: ctx.accounts.mint.key(),
            dev: ctx.accounts.dev.key(),
            decimals: args.decimals,
            total_supply: args.total_supply,
        });
        Ok(())
    }

    /// Step 1 of a pegged coin: a Token-2022 mint whose transfer hook is `hook_program`,
    /// with no authority left that could point it at another program, and a metadata
    /// pointer to the mint itself. No freeze authority. The dev is still the mint
    /// authority: the token program wants its signature to write the name, and it writes
    /// it only at the top level, so the client sends that between this and step 2.
    /// `metadata_len`: the bytes the name, symbol and uri will add to the mint; this pays
    /// their rent up front, because the token program grows the account without paying.
    pub fn create_pegged_mint(ctx: Context<CreatePeggedMint>, decimals: u8, metadata_len: u16) -> Result<()> {
        let _ = decimals; // used by the mint constraint
        require!(metadata_len as usize <= MAX_PEGGED_METADATA, LaunchError::UriTooLong);
        let mint = ctx.accounts.mint.to_account_info();
        let short = Rent::get()?
            .minimum_balance(mint.data_len() + metadata_len as usize)
            .saturating_sub(mint.lamports());
        if short > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer { from: ctx.accounts.dev.to_account_info(), to: mint },
                ),
                short,
            )?;
        }
        Ok(())
    }

    /// Step 2 of a pegged coin: the whole supply to the dev, mint authority revoked. The
    /// name must be written and final by now (Token-2022 metadata in the mint, no update
    /// authority), like the Metaplex metadata of a plain coin.
    pub fn finish_pegged_token(ctx: Context<FinishPeggedToken>, total_supply: u64) -> Result<()> {
        require!(total_supply > 0, LaunchError::ZeroSupply);
        // The dev was the mint authority since step 1. Nothing may have been minted in between,
        // or the supply would be more than the one this step states and hands over.
        require!(ctx.accounts.mint.supply == 0, LaunchError::SupplyNotZero);
        {
            let mint = ctx.accounts.mint.to_account_info();
            let d = mint.try_borrow_data()?;
            // Token-2022 TokenMetadata (extension 19) starts with its update authority
            let meta = t22_extension(&d, 19).ok_or(LaunchError::MetadataMissing)?;
            require!(meta.len() >= 32 && meta[..32] == [0u8; 32], LaunchError::MetadataNotFinal);
        }
        token_interface::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token_interface::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.dev_ata.to_account_info(),
                    authority: ctx.accounts.dev.to_account_info(),
                },
            ),
            total_supply,
        )?;
        // Fixed supply forever.
        token_interface::set_authority(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token_interface::SetAuthority {
                    current_authority: ctx.accounts.dev.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType::MintTokens,
            None,
        )?;
        emit!(TokenCreated {
            mint: ctx.accounts.mint.key(),
            dev: ctx.accounts.dev.key(),
            decimals: ctx.accounts.mint.decimals,
            total_supply,
        });
        Ok(())
    }

    pub fn launch<'info>(ctx: Context<'info, LaunchPool<'info>>, args: LaunchArgs) -> Result<()> {
        // The launch story is "fixed supply, nobody can freeze you, liquidity locked forever".
        // Enforce the parts that depend on the mint, whoever created it.
        require!(
            ctx.accounts.base_mint.mint_authority.is_none()
                && ctx.accounts.base_mint.freeze_authority.is_none(),
            LaunchError::MintAuthority
        );
        require_final_name(&ctx.accounts.base_mint.to_account_info())?;
        // Each CPI lives in its own function: the account structs are large and a
        // Solana stack frame is 4 KB.
        let fee = pay_launch_fee(ctx.accounts)?;
        cpi_create_pool(ctx.accounts, ctx.remaining_accounts, &args)?;
        // A hook that owns the curve can hand the reserves to anyone: not on the launchpad.
        let created = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        require!(created.hook_flags & OVERRIDE_CURVE == 0, LaunchError::CurveHook);
        let lp_amount = lock_all_lp(ctx.accounts)?;
        if args.dev_buy_quote > 0 {
            cpi_dev_buy(ctx.accounts, ctx.remaining_accounts, args.dev_buy_quote, args.min_dev_buy_out)?;
        }
        record(ctx, lp_amount, fee, args.dev_buy_quote, 0)
    }

    /// The curve launch (HOOKS.md section 2, "A pool on the curve"): the same coin checks
    /// as `launch`, the whole supply of the coin into a pool that holds no quote, priced
    /// with the platform's virtual quote. No LP goes to the dev and none has to be locked
    /// here: the pool program minted every share into its own lock account. A pegged coin
    /// (a Token-2022 coin whose transfer hook is the collectible template) is refused; a
    /// strict coin (the rules template as its transfer hook) is allowed.
    pub fn launch_curve<'info>(ctx: Context<'info, LaunchPool<'info>>, args: LaunchCurveArgs) -> Result<()> {
        require!(
            ctx.accounts.base_mint.mint_authority.is_none()
                && ctx.accounts.base_mint.freeze_authority.is_none(),
            LaunchError::MintAuthority
        );
        require_final_name(&ctx.accounts.base_mint.to_account_info())?;
        require_not_pegged(&ctx.accounts.base_mint.to_account_info())?;
        // the pool program checks that this is the whole supply and that nobody can mint more
        let base_amount = ctx.accounts.base_mint.supply;
        let fee = pay_launch_fee(ctx.accounts)?;
        cpi_create_curve_pool(ctx.accounts, ctx.remaining_accounts, args.lp_fee_bps, base_amount)?;
        let created = PoolData::read(&ctx.accounts.pool.to_account_info())?;
        require!(created.hook_flags & OVERRIDE_CURVE == 0, LaunchError::CurveHook);
        let lp_amount = locked_lp(ctx.accounts)?;
        if args.dev_buy_quote > 0 {
            cpi_dev_buy(ctx.accounts, ctx.remaining_accounts, args.dev_buy_quote, args.min_dev_buy_out)?;
        }
        record(ctx, lp_amount, fee, args.dev_buy_quote, LAUNCH_KIND_CURVE)
    }
}

/// The record of a launch and its event. `kind` goes to `reserved[0]`.
fn record(ctx: Context<LaunchPool>, lp_amount: u64, fee: u64, dev_buy_quote: u64, kind: u8) -> Result<()> {
    let slot = Clock::get()?.slot;
    let hook_program = ctx.accounts.hook_program.key();
    let launch = &mut ctx.accounts.launch;
    launch.bump = ctx.bumps.launch;
    launch.dev = ctx.accounts.dev.key();
    launch.pool = ctx.accounts.pool.key();
    launch.base_mint = ctx.accounts.base_mint.key();
    launch.quote_mint = ctx.accounts.quote_mint.key();
    launch.hook_program = hook_program;
    launch.lp_locked = lp_amount;
    launch.launch_fee_paid = fee;
    launch.dev_buy_quote = dev_buy_quote;
    launch.created_slot = slot;
    launch.reserved[0] = kind;

    emit_cpi!(Launched {
        launch: launch.key(),
        pool: launch.pool,
        dev: launch.dev,
        base_mint: launch.base_mint,
        quote_mint: launch.quote_mint,
        hook_program,
        lp_locked: lp_amount,
        launch_fee_paid: fee,
        dev_buy_quote,
        slot,
    });
    Ok(())
}

/// A Token-2022 coin whose transfer hook is the collectible template carries its pieces in
/// every transfer; its supply is not meant to be burned out of a pool. Not on the curve.
#[inline(never)]
fn require_not_pegged(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let d = mint.try_borrow_data()?;
    // TransferHook (14): authority, program id
    if let Some(h) = t22_extension(&d, 14) {
        require!(h.len() < 64 || h[32..64] != COLLECTIBLE_HOOK_ID.to_bytes(), LaunchError::CurvePegged);
    }
    Ok(())
}

/// What the pool program minted into its lock account: on the curve, every share.
#[inline(never)]
fn locked_lp(a: &LaunchPool) -> Result<u64> {
    let lp_amount = {
        let data = a.lp_lock.try_borrow_data()?;
        let acc = StateWithExtensions::<SplAccount>::unpack(&data).map_err(|_| LaunchError::LpAccount)?;
        acc.base.amount
    };
    require!(lp_amount > 0, LaunchError::NoLp);
    Ok(lp_amount)
}

/// 1 (curve). Create the pool on the curve, dev signs as payer and authority.
#[inline(never)]
fn cpi_create_curve_pool<'info>(
    a: &LaunchPool<'info>,
    remaining: &[AccountInfo<'info>],
    lp_fee_bps: u16,
    base_amount: u64,
) -> Result<()> {
    let accounts = hookpool::cpi::accounts::CreatePool {
        payer: a.dev.to_account_info(),
        authority: a.dev.to_account_info(),
        platform: a.platform.to_account_info(),
        base_mint: a.base_mint.to_account_info(),
        quote_mint: a.quote_mint.to_account_info(),
        pool: a.pool.to_account_info(),
        base_vault: a.base_vault.to_account_info(),
        quote_vault: a.quote_vault.to_account_info(),
        lp_mint: a.lp_mint.to_account_info(),
        lp_lock: a.lp_lock.to_account_info(),
        authority_base: a.dev_base.to_account_info(),
        authority_quote: a.dev_quote.to_account_info(),
        authority_lp: a.dev_lp.to_account_info(),
        hook_program: a.hook_program.to_account_info(),
        hook_program_data: a.hook_program_data.to_account_info(),
        hook_manifest: a.hook_manifest.to_account_info(),
        hook_extra_metas: a.hook_extra_metas.to_account_info(),
        hook_quote_treasury: a.hook_quote_treasury.to_account_info(),
        hook_caller: a.hook_caller.to_account_info(),
        base_token_program: a.base_token_program.to_account_info(),
        quote_token_program: a.quote_token_program.to_account_info(),
        token_program: a.token_program.to_account_info(),
        associated_token_program: a.associated_token_program.to_account_info(),
        system_program: a.system_program.to_account_info(),
        event_authority: a.hookpool_event_authority.to_account_info(),
        program: a.hookpool_program.to_account_info(),
    };
    hookpool::cpi::create_curve_pool(
        CpiContext::new(a.hookpool_program.key(), accounts).with_remaining_accounts(remaining.to_vec()),
        CreateCurvePoolArgs { lp_fee_bps, base_amount },
    )
}

/// The most a pegged coin's name, symbol and uri may add to its mint: the extension header
/// and its fixed fields, then the three strings at their limits.
pub const MAX_PEGGED_METADATA: usize = 4 + 32 + 32 + (4 + 32) + (4 + 10) + (4 + 200) + 4;

/// The value of a Token-2022 extension in a mint, by its type number. The base mint is
/// padded to 165 bytes, byte 165 is the account type, then come TLV entries.
fn t22_extension(data: &[u8], kind: u16) -> Option<&[u8]> {
    let mut i = 166;
    while i + 4 <= data.len() {
        let t = u16::from_le_bytes([data[i], data[i + 1]]);
        let len = u16::from_le_bytes([data[i + 2], data[i + 3]]) as usize;
        if t == 0 || i + 4 + len > data.len() {
            return None;
        }
        if t == kind {
            return Some(&data[i + 4..i + 4 + len]);
        }
        i += 4 + len;
    }
    None
}

/// A Token-2022 coin may carry its name in the mint. On the launchpad that name is final,
/// whoever created the coin: nobody left who could rewrite it or point the coin at another
/// metadata account. A coin with a transfer hook (a pegged coin) cannot have Metaplex
/// metadata, so its name has to be there.
#[inline(never)]
fn require_final_name(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let d = mint.try_borrow_data()?;
    // MetadataPointer (18): authority, metadata address
    if let Some(p) = t22_extension(&d, 18) {
        require!(
            p.len() >= 64 && p[..32] == [0u8; 32] && (p[32..64] == mint.key().to_bytes() || p[32..64] == [0u8; 32]),
            LaunchError::MetadataNotFinal
        );
    }
    // TokenMetadata (19) starts with its update authority
    let meta = t22_extension(&d, 19);
    if let Some(m) = meta {
        require!(m.len() >= 32 && m[..32] == [0u8; 32], LaunchError::MetadataNotFinal);
    }
    // TransferHook (14)
    if t22_extension(&d, 14).is_some() {
        require!(meta.is_some(), LaunchError::MetadataMissing);
    }
    Ok(())
}

#[inline(never)]
fn pay_launch_fee(a: &LaunchPool) -> Result<u64> {
    let fee = a.platform.launch_fee_lamports;
    if fee > 0 {
        system_program::transfer(
            CpiContext::new(
                a.system_program.key(),
                system_program::Transfer {
                    from: a.dev.to_account_info(),
                    to: a.treasury.to_account_info(),
                },
            ),
            fee,
        )?;
    }
    Ok(fee)
}

/// 1. create the pool, dev signs as payer and authority
#[inline(never)]
fn cpi_create_pool<'info>(
    a: &LaunchPool<'info>,
    remaining: &[AccountInfo<'info>],
    args: &LaunchArgs,
) -> Result<()> {
    let accounts = hookpool::cpi::accounts::CreatePool {
        payer: a.dev.to_account_info(),
        authority: a.dev.to_account_info(),
        platform: a.platform.to_account_info(),
        base_mint: a.base_mint.to_account_info(),
        quote_mint: a.quote_mint.to_account_info(),
        pool: a.pool.to_account_info(),
        base_vault: a.base_vault.to_account_info(),
        quote_vault: a.quote_vault.to_account_info(),
        lp_mint: a.lp_mint.to_account_info(),
        lp_lock: a.lp_lock.to_account_info(),
        authority_base: a.dev_base.to_account_info(),
        authority_quote: a.dev_quote.to_account_info(),
        authority_lp: a.dev_lp.to_account_info(),
        hook_program: a.hook_program.to_account_info(),
        hook_program_data: a.hook_program_data.to_account_info(),
        hook_manifest: a.hook_manifest.to_account_info(),
        hook_extra_metas: a.hook_extra_metas.to_account_info(),
        hook_quote_treasury: a.hook_quote_treasury.to_account_info(),
        hook_caller: a.hook_caller.to_account_info(),
        base_token_program: a.base_token_program.to_account_info(),
        quote_token_program: a.quote_token_program.to_account_info(),
        token_program: a.token_program.to_account_info(),
        associated_token_program: a.associated_token_program.to_account_info(),
        system_program: a.system_program.to_account_info(),
        event_authority: a.hookpool_event_authority.to_account_info(),
        program: a.hookpool_program.to_account_info(),
    };
    hookpool::cpi::create_pool(
        CpiContext::new(a.hookpool_program.key(), accounts).with_remaining_accounts(remaining.to_vec()),
        CreatePoolArgs {
            lp_fee_bps: args.lp_fee_bps,
            base_amount: args.base_amount,
            quote_amount: args.quote_amount,
        },
    )
}

/// 2. lock every LP token the dev just received: they go to the pool's lock account,
///    which the pool program owns and has no instruction to move
#[inline(never)]
fn lock_all_lp(a: &LaunchPool) -> Result<u64> {
    let lp_amount = {
        let data = a.dev_lp.try_borrow_data()?;
        let acc = StateWithExtensions::<SplAccount>::unpack(&data).map_err(|_| LaunchError::LpAccount)?;
        acc.base.amount
    };
    require!(lp_amount > 0, LaunchError::NoLp);
    token::transfer(
        CpiContext::new(
            a.token_program.key(),
            Transfer {
                from: a.dev_lp.to_account_info(),
                to: a.lp_lock.to_account_info(),
                authority: a.dev.to_account_info(),
            },
        ),
        lp_amount,
    )?;
    Ok(lp_amount)
}

/// 3. optional dev buy, through the normal swap path (hooks included)
#[inline(never)]
fn cpi_dev_buy<'info>(
    a: &LaunchPool<'info>,
    remaining: &[AccountInfo<'info>],
    dev_buy_quote: u64,
    min_dev_buy_out: u64,
) -> Result<()> {
    let accounts = hookpool::cpi::accounts::Swap {
        user: a.dev.to_account_info(),
        platform: a.platform.to_account_info(),
        pool: a.pool.to_account_info(),
        base_mint: a.base_mint.to_account_info(),
        quote_mint: a.quote_mint.to_account_info(),
        base_vault: a.base_vault.to_account_info(),
        quote_vault: a.quote_vault.to_account_info(),
        user_base: a.dev_base.to_account_info(),
        user_quote: a.dev_quote.to_account_info(),
        hook_quote_treasury: a.hook_quote_treasury.to_account_info(),
        hook_program: a.hook_program.to_account_info(),
        hook_extra_metas: a.hook_extra_metas.to_account_info(),
        hook_caller: a.hook_caller.to_account_info(),
        base_token_program: a.base_token_program.to_account_info(),
        quote_token_program: a.quote_token_program.to_account_info(),
        event_authority: a.hookpool_event_authority.to_account_info(),
        program: a.hookpool_program.to_account_info(),
    };
    hookpool::cpi::swap(
        CpiContext::new(a.hookpool_program.key(), accounts).with_remaining_accounts(remaining.to_vec()),
        DIRECTION_BUY,
        dev_buy_quote,
        min_dev_buy_out,
    )
}

#[derive(Accounts)]
#[instruction(args: CreateTokenArgs)]
pub struct CreateToken<'info> {
    #[account(mut)]
    pub dev: Signer<'info>,
    /// Fresh keypair generated client-side. No freeze authority, ever.
    #[account(
        init,
        payer = dev,
        mint::decimals = args.decimals,
        mint::authority = dev,
        mint::token_program = token_program
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = dev,
        associated_token::mint = mint,
        associated_token::authority = dev,
        associated_token::token_program = token_program
    )]
    pub dev_ata: Account<'info, TokenAccount>,
    /// CHECK: Metaplex metadata PDA, created by the Metaplex program.
    #[account(
        mut,
        seeds = [b"metadata", token_metadata_program.key().as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = token_metadata_program.key()
    )]
    pub metadata: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(decimals: u8)]
pub struct CreatePeggedMint<'info> {
    #[account(mut)]
    pub dev: Signer<'info>,
    /// Fresh keypair generated client-side. Token-2022, no freeze authority, a transfer
    /// hook with no authority (the hook program can never be changed) and a metadata
    /// pointer to the mint itself, also with no authority.
    #[account(
        init,
        payer = dev,
        mint::decimals = decimals,
        mint::authority = dev,
        mint::token_program = token_program,
        extensions::transfer_hook::program_id = hook_program,
        extensions::metadata_pointer::metadata_address = mint,
    )]
    pub mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(
        init_if_needed,
        payer = dev,
        associated_token::mint = mint,
        associated_token::authority = dev,
        associated_token::token_program = token_program
    )]
    pub dev_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    /// CHECK: the program that will run inside every transfer of this coin. The pool
    /// checks later that it is the pool's own hook and that the platform runs it.
    #[account(executable)]
    pub hook_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinishPeggedToken<'info> {
    /// Still the mint authority; this is the last thing it signs.
    pub dev: Signer<'info>,
    #[account(mut, mint::authority = dev, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, MintInterface>>,
    #[account(mut, token::mint = mint, token::authority = dev, token::token_program = token_program)]
    pub dev_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,
    pub token_program: Program<'info, Token2022>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct LaunchPool<'info> {
    #[account(mut)]
    pub dev: Signer<'info>,
    /// Writable: the pool program bumps pool_count.
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump, seeds::program = hookpool::ID)]
    pub platform: Box<Account<'info, Platform>>,
    /// CHECK: the platform treasury wallet, receives the launch fee.
    #[account(mut, address = platform.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        init,
        payer = dev,
        space = 8 + Launch::INIT_SPACE,
        seeds = [LAUNCH_SEED, base_mint.key().as_ref()],
        bump
    )]
    pub launch: Box<Account<'info, Launch>>,
    /// Checked here: no mint authority, no freeze authority.
    pub base_mint: Box<InterfaceAccount<'info, MintInterface>>,
    /// CHECK: validated by the pool program.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: created by the pool program.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: created by the pool program.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: created by the pool program.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: created by the pool program.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: created by the pool program.
    #[account(mut)]
    pub lp_lock: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program.
    #[account(mut)]
    pub dev_base: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program.
    #[account(mut)]
    pub dev_quote: UncheckedAccount<'info>,
    /// CHECK: created by the pool program (ATA), emptied here.
    #[account(mut)]
    pub dev_lp: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program.
    pub hook_program: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program.
    pub hook_program_data: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program.
    pub hook_manifest: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program.
    pub hook_extra_metas: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program. Writable so the dev buy can pay the hook fee.
    #[account(mut)]
    pub hook_quote_treasury: UncheckedAccount<'info>,
    /// CHECK: validated by the pool program.
    pub hook_caller: UncheckedAccount<'info>,
    pub hookpool_program: Program<'info, Hookpool>,
    /// CHECK: hookpool's event authority PDA, validated by hookpool itself.
    pub hookpool_event_authority: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
