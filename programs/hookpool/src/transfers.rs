//! Thin wrappers over the token interface so handlers read as plain English.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as Mint2022,
};
use anchor_spl::token_interface::{self, Burn, MintTo, TransferChecked};
use hookpool_interface::{ExtraAccountMetaList, TransferHookExecute, TRANSFER_HOOK_EXECUTE_DISC, TRANSFER_HOOK_METAS_SEED};

/// Token-2022 `TransferChecked` (instruction 12) for a mint that may carry a transfer hook.
/// When it does, the hook's account list is resolved from `hook_accounts` and appended the
/// way the token program expects: the hook's accounts, its account list, the hook program.
/// The same steps as spl-transfer-hook-interface's on-chain helper.
#[allow(clippy::too_many_arguments)]
fn invoke_transfer_checked<'info>(
    token_program: &Pubkey,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    hook_accounts: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(10);
    data.push(12u8);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let mut ix = Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(from.key(), false),
            AccountMeta::new_readonly(mint.key(), false),
            AccountMeta::new(to.key(), false),
            AccountMeta::new_readonly(authority.key(), true),
        ],
        data,
    };
    let mut infos = vec![from.clone(), mint.clone(), to.clone(), authority.clone()];

    let hook: Option<Pubkey> = {
        let d = mint.try_borrow_data()?;
        let state = StateWithExtensions::<Mint2022>::unpack(&d)?;
        state.get_extension::<TransferHook>().ok().and_then(|h| h.program_id.into())
    };
    if let Some(hook) = hook {
        let (list, _) = Pubkey::find_program_address(&[TRANSFER_HOOK_METAS_SEED, mint.key().as_ref()], &hook);
        let program = hook_accounts
            .iter()
            .find(|a| a.key() == hook)
            .ok_or(crate::errors::HookpoolError::HookExtraAccounts)?;
        if let Some(list_info) = hook_accounts.iter().find(|a| a.key() == list) {
            // resolve against the hook's own Execute call, then keep what follows its five fixed accounts
            let mut execute_data = Vec::with_capacity(16);
            execute_data.extend_from_slice(&TRANSFER_HOOK_EXECUTE_DISC);
            execute_data.extend_from_slice(&amount.to_le_bytes());
            let mut execute = Instruction {
                program_id: hook,
                accounts: vec![
                    AccountMeta::new_readonly(from.key(), false),
                    AccountMeta::new_readonly(mint.key(), false),
                    AccountMeta::new_readonly(to.key(), false),
                    AccountMeta::new_readonly(authority.key(), false),
                    AccountMeta::new_readonly(list, false),
                ],
                data: execute_data,
            };
            let mut execute_infos = vec![from.clone(), mint.clone(), to.clone(), authority.clone(), list_info.clone()];
            {
                let d = list_info.try_borrow_data()?;
                ExtraAccountMetaList::add_to_cpi_instruction::<TransferHookExecute>(&mut execute, &mut execute_infos, &d, hook_accounts)
                    .map_err(|_| crate::errors::HookpoolError::HookExtraAccounts)?;
            }
            ix.accounts.extend_from_slice(&execute.accounts[5..]);
            infos.extend_from_slice(&execute_infos[5..]);
            ix.accounts.push(AccountMeta::new_readonly(list, false));
            infos.push(list_info.clone());
        }
        ix.accounts.push(AccountMeta::new_readonly(hook, false));
        infos.push(program.clone());
    }
    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}

/// The accounts a coin's transfer hook needs, when the coin has one: everything the client
/// passed as remaining accounts, plus the hook program. Empty for a plain SPL coin.
pub fn hook_accounts_for<'info>(
    token_program: &Pubkey,
    remaining: &[AccountInfo<'info>],
    hook_program: Option<AccountInfo<'info>>,
) -> Vec<AccountInfo<'info>> {
    if *token_program != anchor_spl::token_2022::ID {
        return Vec::new();
    }
    let mut v = remaining.to_vec();
    if let Some(p) = hook_program {
        v.push(p);
    }
    v
}

#[allow(clippy::too_many_arguments)]
pub fn transfer_user<'info>(
    token_program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    hook_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if *token_program.key == anchor_spl::token_2022::ID {
        // resolves and appends the transfer hook's accounts when the mint has a hook
        invoke_transfer_checked(token_program.key, from, mint, to, authority, hook_accounts, amount, decimals, &[])?;
        return Ok(());
    }
    let cpi = CpiContext::new(
        *token_program.key,
        TransferChecked { from, mint, to, authority },
    );
    token_interface::transfer_checked(cpi, amount, decimals)
}

#[allow(clippy::too_many_arguments)]
pub fn transfer_pool<'info>(
    token_program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    pool: AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
    decimals: u8,
    hook_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if *token_program.key == anchor_spl::token_2022::ID {
        invoke_transfer_checked(token_program.key, from, mint, to, pool, hook_accounts, amount, decimals, signer_seeds)?;
        return Ok(());
    }
    let cpi = CpiContext::new_with_signer(
        *token_program.key,
        TransferChecked { from, mint, to, authority: pool },
        signer_seeds,
    );
    token_interface::transfer_checked(cpi, amount, decimals)
}

pub fn mint_lp<'info>(
    token_program: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    pool: AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let cpi = CpiContext::new_with_signer(
        *token_program.key,
        MintTo { mint, to, authority: pool },
        signer_seeds,
    );
    token_interface::mint_to(cpi, amount)
}

pub fn burn_lp<'info>(
    token_program: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    from: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let cpi = CpiContext::new(*token_program.key, Burn { mint, from, authority });
    token_interface::burn(cpi, amount)
}
