//! The approved list (HOOKS.md section 6.1): the hook programs, not the platform's own, that
//! may open a pool while `Platform::hook_approval_required` is on.
//!
//! The list lives in the Platform account itself, after its fixed part, so that every
//! instruction that already passes the platform (pool creation directly, through the
//! launchpad, or by any other client) carries it with no new account:
//!
//! ```text
//! offset APPROVED_LIST_OFFSET   u32 little endian   count
//! then                          count x 32 bytes    program ids, in no particular order
//! ```
//!
//! A platform account of exactly the fixed size has no list (count 0). Anchor reads and
//! writes only the fixed part, so the list survives every other instruction that writes
//! the platform. Only `approve_hook` and `revoke_hook` touch it, and they resize the
//! account to the list's exact length, the admin paying or receiving the rent difference.

use crate::errors::HookpoolError;
use crate::state::{Platform, MAX_APPROVED_HOOKS};
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

/// Where the list starts: the discriminator and the fixed part of the Platform account.
pub const APPROVED_LIST_OFFSET: usize = 8 + Platform::INIT_SPACE;

/// The length of a Platform account holding `n` approved programs.
pub const fn platform_len(n: usize) -> usize {
    APPROVED_LIST_OFFSET + 4 + 32 * n
}

/// How many programs the list holds. A platform account without a list holds none; a list
/// whose length does not fit the account is an error, never a guess.
pub fn count(data: &[u8]) -> Result<usize> {
    if data.len() <= APPROVED_LIST_OFFSET {
        return Ok(0);
    }
    require!(data.len() >= APPROVED_LIST_OFFSET + 4, HookpoolError::ApprovedListCorrupt);
    let n = u32::from_le_bytes(data[APPROVED_LIST_OFFSET..APPROVED_LIST_OFFSET + 4].try_into().unwrap()) as usize;
    require!(n <= MAX_APPROVED_HOOKS && data.len() >= platform_len(n), HookpoolError::ApprovedListCorrupt);
    Ok(n)
}

/// The program at position `i` (`i < count`).
fn at(data: &[u8], i: usize) -> Pubkey {
    let o = APPROVED_LIST_OFFSET + 4 + 32 * i;
    Pubkey::new_from_array(data[o..o + 32].try_into().unwrap())
}

/// The position of `program` in the list, if it is there.
pub fn position(data: &[u8], program: &Pubkey) -> Result<Option<usize>> {
    let n = count(data)?;
    Ok((0..n).find(|&i| at(data, i) == *program))
}

/// True when `program` is on the list.
pub fn is_approved(platform: &AccountInfo, program: &Pubkey) -> Result<bool> {
    let data = platform.try_borrow_data()?;
    Ok(position(&data, program)?.is_some())
}

/// Adds `program` and returns the new count. `payer` tops the platform up to the rent of
/// its new length.
pub fn add<'info>(
    platform: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    program: &Pubkey,
) -> Result<usize> {
    let n = {
        let data = platform.try_borrow_data()?;
        require!(position(&data, program)?.is_none(), HookpoolError::HookAlreadyApproved);
        count(&data)?
    };
    require!(n < MAX_APPROVED_HOOKS, HookpoolError::TooManyApprovedHooks);
    let new_len = platform_len(n + 1);
    let need = Rent::get()?.minimum_balance(new_len);
    let have = platform.lamports();
    if need > have {
        transfer(
            CpiContext::new(system_program.key(), Transfer { from: payer.clone(), to: platform.clone() }),
            need - have,
        )?;
    }
    platform.resize(new_len)?;
    let mut data = platform.try_borrow_mut_data()?;
    data[APPROVED_LIST_OFFSET..APPROVED_LIST_OFFSET + 4].copy_from_slice(&((n + 1) as u32).to_le_bytes());
    let o = APPROVED_LIST_OFFSET + 4 + 32 * n;
    data[o..o + 32].copy_from_slice(program.as_ref());
    Ok(n + 1)
}

/// Removes `program` (the last entry takes its place) and returns the new count. The rent
/// the shorter account no longer needs goes to `refund_to`.
pub fn remove<'info>(platform: &AccountInfo<'info>, refund_to: &AccountInfo<'info>, program: &Pubkey) -> Result<usize> {
    let n = {
        let mut data = platform.try_borrow_mut_data()?;
        let n = count(&data)?;
        let i = position(&data, program)?.ok_or(HookpoolError::HookNotApproved)?;
        if i != n - 1 {
            let last = at(&data, n - 1);
            let o = APPROVED_LIST_OFFSET + 4 + 32 * i;
            data[o..o + 32].copy_from_slice(last.as_ref());
        }
        data[APPROVED_LIST_OFFSET..APPROVED_LIST_OFFSET + 4].copy_from_slice(&((n - 1) as u32).to_le_bytes());
        n
    };
    let new_len = platform_len(n - 1);
    platform.resize(new_len)?;
    let need = Rent::get()?.minimum_balance(new_len);
    let excess = platform.lamports().saturating_sub(need);
    if excess > 0 {
        **platform.try_borrow_mut_lamports()? -= excess;
        **refund_to.try_borrow_mut_lamports()? += excess;
    }
    Ok(n - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(keys: &[Pubkey]) -> Vec<u8> {
        let mut d = vec![0u8; platform_len(keys.len())];
        d[APPROVED_LIST_OFFSET..APPROVED_LIST_OFFSET + 4].copy_from_slice(&(keys.len() as u32).to_le_bytes());
        for (i, k) in keys.iter().enumerate() {
            let o = APPROVED_LIST_OFFSET + 4 + 32 * i;
            d[o..o + 32].copy_from_slice(k.as_ref());
        }
        d
    }

    #[test]
    fn the_list_starts_after_the_fixed_platform() {
        // 8 discriminator + the fixed fields: the live account is 451 bytes long
        assert_eq!(APPROVED_LIST_OFFSET, 451);
        assert_eq!(platform_len(0), 455);
        assert_eq!(platform_len(MAX_APPROVED_HOOKS), 451 + 4 + 32 * 256);
    }

    #[test]
    fn a_platform_without_a_list_holds_none() {
        let d = vec![0u8; APPROVED_LIST_OFFSET];
        assert_eq!(count(&d).unwrap(), 0);
        assert_eq!(position(&d, &Pubkey::new_unique()).unwrap(), None);
        // a zeroed count after the fixed part is an empty list too
        let d = vec![0u8; platform_len(0)];
        assert_eq!(count(&d).unwrap(), 0);
    }

    #[test]
    fn programs_are_found_where_they_are() {
        let ks = [Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()];
        let d = list(&ks);
        assert_eq!(count(&d).unwrap(), 3);
        for (i, k) in ks.iter().enumerate() {
            assert_eq!(position(&d, k).unwrap(), Some(i));
        }
        assert_eq!(position(&d, &Pubkey::new_unique()).unwrap(), None);
        assert_eq!(position(&d, &Pubkey::default()).unwrap(), None);
    }

    #[test]
    fn a_list_that_does_not_fit_is_an_error() {
        let ks = [Pubkey::new_unique(), Pubkey::new_unique()];
        let mut d = list(&ks);
        d.truncate(d.len() - 1);
        assert!(count(&d).is_err());
        // a cut inside the count itself
        let d = vec![0u8; APPROVED_LIST_OFFSET + 2];
        assert!(count(&d).is_err());
        // a count above the cap
        let mut d = vec![0u8; platform_len(0)];
        d[APPROVED_LIST_OFFSET..APPROVED_LIST_OFFSET + 4].copy_from_slice(&((MAX_APPROVED_HOOKS + 1) as u32).to_le_bytes());
        assert!(count(&d).is_err());
    }
}
