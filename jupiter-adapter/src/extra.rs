//! A hook's extra accounts. Every hook publishes, in one account, the list of accounts its
//! callbacks need beyond the five fixed ones. The format is the one Token-2022 transfer
//! hooks use (`spl-tlv-account-resolution`), keyed by the pool's callback discriminator.
//! The pool resolves the list on chain; this resolves the same list from cached bytes.

use solana_instruction::AccountMeta;
use solana_pubkey::Pubkey;

/// sha256("hookpool-interface:callback")[..8]: the key of the list inside the TLV account.
pub const CALLBACK_TLV_DISC: [u8; 8] = [60, 167, 17, 250, 28, 149, 188, 66];

/// One entry of the list, as stored: 35 bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExtraMeta {
    /// 0: a fixed address. 1: a PDA of the hook program. 128 + n: a PDA of the program at
    /// account index n.
    pub discriminator: u8,
    pub address_config: [u8; 32],
    pub is_signer: bool,
    pub is_writable: bool,
}

/// Parse the TLV account. `None` when it holds no list for the pool's callbacks.
pub fn parse(data: &[u8]) -> Option<Vec<ExtraMeta>> {
    let mut off = 0;
    while off + 12 <= data.len() {
        let len = u32::from_le_bytes(data[off + 8..off + 12].try_into().ok()?) as usize;
        let start = off + 12;
        if data[off..off + 8] == CALLBACK_TLV_DISC {
            let count = u32::from_le_bytes(data.get(start..start + 4)?.try_into().ok()?) as usize;
            let mut out = Vec::with_capacity(count.min(32));
            for i in 0..count {
                let e = data.get(start + 4 + 35 * i..start + 4 + 35 * (i + 1))?;
                out.push(ExtraMeta {
                    discriminator: e[0],
                    address_config: e[1..33].try_into().ok()?,
                    is_signer: e[33] != 0,
                    is_writable: e[34] != 0,
                });
            }
            return Some(out);
        }
        if len == 0 && data[off..off + 8].iter().all(|b| *b == 0) {
            break;
        }
        off = start.checked_add(len)?;
    }
    None
}

/// Resolve the list for one callback. `fixed` are the five accounts every callback gets:
/// pool, caller, user, quote mint, base mint. An entry may refer to them and to the entries
/// before it, by index.
///
/// `None` when an entry derives a seed from account data or from the callback's instruction
/// data. No template does; a pool whose hook does is not offered for routing.
pub fn resolve(metas: &[ExtraMeta], hook_program: &Pubkey, fixed: &[Pubkey; 5]) -> Option<Vec<AccountMeta>> {
    let mut keys: Vec<Pubkey> = fixed.to_vec();
    let mut out = Vec::with_capacity(metas.len());
    for m in metas {
        // The pool refuses a hook that asks for a signer; so does this.
        if m.is_signer {
            return None;
        }
        let pubkey = if m.discriminator == 0 {
            Pubkey::new_from_array(m.address_config)
        } else {
            let program = if m.discriminator == 1 { *hook_program } else { *keys.get(m.discriminator.checked_sub(128)? as usize)? };
            let seeds = unpack_seeds(&m.address_config, &keys)?;
            let refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
            Pubkey::try_find_program_address(&refs, &program)?.0
        };
        keys.push(pubkey);
        out.push(AccountMeta { pubkey, is_signer: false, is_writable: m.is_writable });
    }
    Some(out)
}

/// Seeds are packed one after another: 1 literal (length, bytes), 2 instruction data,
/// 3 account key (index), 4 account data. 0 ends the list.
fn unpack_seeds(cfg: &[u8; 32], keys: &[Pubkey]) -> Option<Vec<Vec<u8>>> {
    let mut seeds = Vec::new();
    let mut i = 0;
    while i < cfg.len() {
        match cfg[i] {
            0 => break,
            1 => {
                let n = *cfg.get(i + 1)? as usize;
                seeds.push(cfg.get(i + 2..i + 2 + n)?.to_vec());
                i += 2 + n;
            }
            3 => {
                seeds.push(keys.get(*cfg.get(i + 1)? as usize)?.to_bytes().to_vec());
                i += 2;
            }
            _ => return None,
        }
    }
    Some(seeds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(entries: &[(u8, Vec<u8>, bool)]) -> Vec<u8> {
        let mut value = (entries.len() as u32).to_le_bytes().to_vec();
        for (disc, cfg, writable) in entries {
            let mut c = [0u8; 32];
            c[..cfg.len()].copy_from_slice(cfg);
            value.push(*disc);
            value.extend_from_slice(&c);
            value.push(0);
            value.push(*writable as u8);
        }
        let mut d = CALLBACK_TLV_DISC.to_vec();
        d.extend_from_slice(&(value.len() as u32).to_le_bytes());
        d.extend_from_slice(&value);
        d
    }

    #[test]
    fn a_per_pool_config_and_a_per_user_ticket_resolve_like_on_chain() {
        let hook = Pubkey::new_from_array([9; 32]);
        let fixed = [1u8, 2, 3, 4, 5].map(|n| Pubkey::new_from_array([n; 32]));
        let sysvar = Pubkey::new_from_array([7; 32]);
        // [b"cfg", pool], writable; [b"ticket", pool, user], writable; a fixed address
        let data = list(&[
            (1, [vec![1, 3], b"cfg".to_vec(), vec![3, 0]].concat(), true),
            (1, [vec![1, 6], b"ticket".to_vec(), vec![3, 0, 3, 2]].concat(), true),
            (0, sysvar.to_bytes().to_vec(), false),
        ]);
        let metas = parse(&data).unwrap();
        let out = resolve(&metas, &hook, &fixed).unwrap();
        assert_eq!(out[0].pubkey, Pubkey::find_program_address(&[b"cfg", fixed[0].as_ref()], &hook).0);
        assert_eq!(out[1].pubkey, Pubkey::find_program_address(&[b"ticket", fixed[0].as_ref(), fixed[2].as_ref()], &hook).0);
        assert_eq!((out[2].pubkey, out[2].is_writable), (sysvar, false));
        assert!(out[0].is_writable && out[1].is_writable && out.iter().all(|m| !m.is_signer));
    }

    #[test]
    fn what_cannot_be_resolved_offline_resolves_to_nothing() {
        let hook = Pubkey::new_from_array([9; 32]);
        let fixed = [1u8, 2, 3, 4, 5].map(|n| Pubkey::new_from_array([n; 32]));
        // a seed read from account data
        let data = list(&[(1, vec![4, 0, 32, 32], false)]);
        assert!(resolve(&parse(&data).unwrap(), &hook, &fixed).is_none());
        // an index past the accounts known so far
        let data = list(&[(1, vec![3, 9], false)]);
        assert!(resolve(&parse(&data).unwrap(), &hook, &fixed).is_none());
        // no list for our callbacks in the account
        assert!(parse(&[0u8; 64]).is_none());
        assert!(parse(&[]).is_none());
    }
}
