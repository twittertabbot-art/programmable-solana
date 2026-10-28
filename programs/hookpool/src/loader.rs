//! Upgradeability rule (HOOKS.md section 6). Decides whether a hook program is
//! frozen, run by a whitelisted authority, or rejected.

use crate::errors::HookpoolError;
use anchor_lang::prelude::*;
pub use hookpool_interface::{program_data_address, v3_upgrade_authority};
use hookpool_interface::{HOOK_KIND_FROZEN, HOOK_KIND_PLATFORM};
use solana_sdk_ids::{bpf_loader, bpf_loader_deprecated, bpf_loader_upgradeable, loader_v4};

/// bincode layout of `UpgradeableLoaderState::Program { programdata_address }`
const V3_PROGRAM_VARIANT: u32 = 2;
const V3_PROGRAM_LEN: usize = 4 + 32;
/// `LoaderV4State { slot: u64, authority_address_or_next_version: Pubkey, status: u64 }`
const V4_HEADER_LEN: usize = 8 + 32 + 8;
const V4_STATUS_DEPLOYED: u64 = 1;
const V4_STATUS_FINALIZED: u64 = 2;

pub fn classify_hook(
    program: &AccountInfo,
    program_data: &AccountInfo,
    whitelist: &[Pubkey],
) -> Result<u8> {
    require!(program.executable, HookpoolError::HookNotExecutable);
    let owner = *program.owner;

    if owner == bpf_loader_upgradeable::ID {
        {
            let data = program.try_borrow_data()?;
            require!(data.len() >= V3_PROGRAM_LEN, HookpoolError::InvalidHookProgramAccount);
            let variant = u32::from_le_bytes(data[0..4].try_into().unwrap());
            require!(variant == V3_PROGRAM_VARIANT, HookpoolError::InvalidHookProgramAccount);
            let pd_addr = Pubkey::new_from_array(data[4..36].try_into().unwrap());
            require_keys_eq!(pd_addr, program_data.key(), HookpoolError::HookProgramDataMismatch);
        }
        return match v3_upgrade_authority(program_data)? {
            None => Ok(HOOK_KIND_FROZEN),
            Some(auth) if whitelist.contains(&auth) => Ok(HOOK_KIND_PLATFORM),
            Some(_) => Err(HookpoolError::HookNotFrozen.into()),
        };
    }

    if owner == loader_v4::ID {
        let data = program.try_borrow_data()?;
        require!(data.len() >= V4_HEADER_LEN, HookpoolError::InvalidHookProgramAccount);
        let authority = Pubkey::new_from_array(data[8..40].try_into().unwrap());
        let status = u64::from_le_bytes(data[40..48].try_into().unwrap());
        return if status == V4_STATUS_FINALIZED {
            Ok(HOOK_KIND_FROZEN)
        } else if status == V4_STATUS_DEPLOYED && whitelist.contains(&authority) {
            Ok(HOOK_KIND_PLATFORM)
        } else {
            Err(HookpoolError::HookNotFrozen.into())
        };
    }

    if owner == bpf_loader::ID || owner == bpf_loader_deprecated::ID {
        // Legacy loaders have no upgrade path at all.
        return Ok(HOOK_KIND_FROZEN);
    }

    Err(HookpoolError::UnknownLoader.into())
}
