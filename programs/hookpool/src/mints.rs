//! Which mints a pool accepts. Plain SPL Token always. Token-2022 only with the
//! extensions on a short allow-list: the ones that cannot let someone else move or freeze
//! the vault's balance, or make the amount that arrives differ from the amount that was
//! sent. An extension this code does not name is refused, also one that Token-2022 adds
//! later.
//!
//! One conditional entry: a transfer hook. A hook on the coin runs inside every transfer, so it
//! could refuse a sell. It is accepted only when it is the pool's OWN hook program, that
//! program is run by the platform, and nobody is left who could point the coin at another
//! program.

use crate::errors::HookpoolError;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{transfer_hook::TransferHook, BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint as Mint2022,
};

/// `own_hook`: the pool's hook program when the platform runs it, otherwise None. Only the
/// base mint of such a pool may carry a transfer hook, and only to that program.
pub fn check_mint_allowed(mint: &AccountInfo, own_hook: Option<&Pubkey>) -> Result<()> {
    if *mint.owner == anchor_spl::token::ID {
        return Ok(());
    }
    require_keys_eq!(
        *mint.owner,
        anchor_spl::token_2022::ID,
        HookpoolError::TokenProgramMismatch
    );
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Mint2022>::unpack(&data)?;
    for ext in state.get_extension_types()? {
        if ext == ExtensionType::TransferHook {
            let hook = state.get_extension::<TransferHook>()?;
            let program: Option<Pubkey> = hook.program_id.into();
            let authority: Option<Pubkey> = hook.authority.into();
            let ours = match program {
                None => true,
                Some(p) => own_hook == Some(&p),
            };
            require!(authority.is_none() && ours, HookpoolError::MintExtensionNotAllowed);
            continue;
        }
        // The name of a coin, and where it lives. Nothing else: no transfer fee, permanent
        // delegate, pause, default-frozen, non-transferable, confidential, interest-bearing
        // or scaled amounts, close authority or groups.
        let allowed = matches!(ext, ExtensionType::MetadataPointer | ExtensionType::TokenMetadata);
        require!(allowed, HookpoolError::MintExtensionNotAllowed);
    }
    Ok(())
}

/// The collectible template, `hook_collectible`. A Token-2022 coin whose transfer hook is
/// this program is a pegged coin (HOOKS.md section 13): its pieces follow the coin in every
/// transfer. Such a coin does not open a pool on the curve (`CurvePegged`); the launchpad
/// holds the same rule with the same constant.
pub const COLLECTIBLE_HOOK_ID: Pubkey = Pubkey::from_str_const("3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m");

/// The transfer hook program of a mint: `None` for an SPL Token mint, a Token-2022 mint
/// without the extension, or one whose program is unset.
pub fn transfer_hook_program(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(None);
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Mint2022>::unpack(&data)?;
    Ok(state.get_extension::<TransferHook>().ok().and_then(|h| h.program_id.into()))
}

/// Is `account` a token account (either token program) for `mint`? Returns its owner.
pub fn token_account_for_mint(account: &AccountInfo, mint: &Pubkey) -> Result<Pubkey> {
    let data = account.try_borrow_data()?;
    let acc = StateWithExtensions::<anchor_spl::token_2022::spl_token_2022::state::Account>::unpack(&data)
        .map_err(|_| HookpoolError::HookTreasuryInvalid)?;
    require!(
        *account.owner == anchor_spl::token::ID || *account.owner == anchor_spl::token_2022::ID,
        HookpoolError::HookTreasuryInvalid
    );
    require_keys_eq!(acc.base.mint, *mint, HookpoolError::HookTreasuryInvalid);
    Ok(acc.base.owner)
}
