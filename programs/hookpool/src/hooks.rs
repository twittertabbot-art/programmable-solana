//! Hook dispatch: build the callback instruction, resolve the hook's extra
//! accounts, sign as the hook's own caller PDA, invoke, and read the answer.

use crate::errors::HookpoolError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke_signed, set_return_data};
use hookpool_interface::{
    CallbackInstruction, ExtraAccountMetaList, HookReturn, PoolData, CALLER_SEED, CALL_ON_BUY,
    CALL_ON_SELL, DIRECTION_BUY,
};

pub struct HookAccounts<'a, 'info> {
    pub pool: AccountInfo<'info>,
    pub caller: AccountInfo<'info>,
    pub caller_bump: u8,
    pub user: AccountInfo<'info>,
    pub quote_mint: AccountInfo<'info>,
    pub base_mint: AccountInfo<'info>,
    pub hook_program: AccountInfo<'info>,
    pub extra_metas: AccountInfo<'info>,
    pub remaining: &'a [AccountInfo<'info>],
}

/// A swap callback runs only when its own flag AND the direction flag are set.
pub fn swap_callback_enabled(flags: u32, callback_flag: u32, direction: u8) -> bool {
    if flags & callback_flag == 0 {
        return false;
    }
    if direction == DIRECTION_BUY {
        flags & CALL_ON_BUY != 0
    } else {
        flags & CALL_ON_SELL != 0
    }
}

/// Invoke one callback. Returns the hook's return data when it set some.
pub fn invoke_hook(
    acc: &HookAccounts,
    pool: &PoolData,
    discriminator: [u8; 8],
    payload: &[u8],
) -> Result<Option<Vec<u8>>> {
    require_keys_eq!(
        acc.hook_program.key(),
        pool.hook_program,
        HookpoolError::HookProgramMismatch
    );
    require_keys_eq!(
        acc.extra_metas.key(),
        pool.hook_extra_metas,
        HookpoolError::HookExtraMetasAddress
    );
    require_keys_eq!(
        *acc.extra_metas.owner,
        pool.hook_program,
        HookpoolError::HookExtraMetasOwner
    );

    let mut data = Vec::with_capacity(8 + payload.len());
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(payload);

    let mut ix = Instruction {
        program_id: pool.hook_program,
        accounts: vec![
            AccountMeta::new_readonly(acc.pool.key(), false),
            AccountMeta::new_readonly(acc.caller.key(), true),
            AccountMeta::new_readonly(acc.user.key(), false),
            AccountMeta::new_readonly(acc.quote_mint.key(), false),
            AccountMeta::new_readonly(acc.base_mint.key(), false),
        ],
        data,
    };
    let mut infos: Vec<AccountInfo> = vec![
        acc.pool.clone(),
        acc.caller.clone(),
        acc.user.clone(),
        acc.quote_mint.clone(),
        acc.base_mint.clone(),
    ];
    {
        let em = acc.extra_metas.try_borrow_data()?;
        ExtraAccountMetaList::add_to_cpi_instruction::<CallbackInstruction>(
            &mut ix,
            &mut infos,
            &em,
            acc.remaining,
        )
        .map_err(|_| HookpoolError::HookExtraAccounts)?;
    }
    // The resolver de-escalates signers; keep that true even if the library changes.
    require!(
        ix.accounts.iter().skip(5).all(|m| !m.is_signer),
        HookpoolError::HookExtraAccounts
    );
    infos.push(acc.hook_program.clone());

    // Clear whatever return data is lying around so a silent hook reads as "no opinion".
    set_return_data(&[]);
    // Signed with the caller address of THIS hook program, ["caller", hook_program]. The
    // accounts struct derived `acc.caller` from the hook program account it was given, and
    // that account was checked against the pool's hook program above, so the seeds agree.
    let bump = [acc.caller_bump];
    let seeds: &[&[u8]] = &[CALLER_SEED, pool.hook_program.as_ref(), &bump];
    invoke_signed(&ix, &infos, &[seeds])?;

    match get_return_data() {
        Some((pid, bytes)) if pid == pool.hook_program && !bytes.is_empty() => Ok(Some(bytes)),
        _ => Ok(None),
    }
}

/// Decode and police a `before_swap` answer against the pool's flags and the platform caps.
/// Fees above a cap are CLAMPED to the cap, never rejected: a rejection would let a hook
/// (or an admin lowering a cap) turn the cap into a kill switch for one trade direction.
pub fn parse_before_swap(
    bytes: Option<Vec<u8>>,
    flags: u32,
    max_hook_fee_bps: u16,
    max_fee_override_bps: u16,
) -> Result<HookReturn> {
    let mut ret = match bytes {
        None => return Ok(HookReturn::default()),
        Some(b) => HookReturn::try_from_slice(&b).map_err(|_| HookpoolError::BadHookReturn)?,
    };
    require!(ret.version == HookReturn::VERSION, HookpoolError::BadHookReturn);
    if let Some(bps) = ret.fee_override_bps {
        require!(
            flags & hookpool_interface::OVERRIDE_FEE != 0,
            HookpoolError::HookPowerNotGranted
        );
        ret.fee_override_bps = Some(bps.min(max_fee_override_bps));
    }
    if ret.hook_fee_bps > 0 {
        require!(
            flags & hookpool_interface::TAKE_HOOK_FEE != 0,
            HookpoolError::HookPowerNotGranted
        );
        ret.hook_fee_bps = ret.hook_fee_bps.min(max_hook_fee_bps);
    }
    if ret.curve.is_some() {
        require!(
            flags & hookpool_interface::OVERRIDE_CURVE != 0,
            HookpoolError::HookPowerNotGranted
        );
    }
    Ok(ret)
}
