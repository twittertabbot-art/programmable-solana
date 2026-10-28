//! Decoders for the accounts a quote reads. Each account is an Anchor account: an 8-byte
//! discriminator, then the fields in borsh order. Only the fields a quote needs are read:
//! the leading ones, and in the pool and the platform the curve fields at the end.

use solana_pubkey::Pubkey;

/// sha256("account:<Name>")[..8]
pub const POOL_DISC: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
/// `curve_state` of a pool: a seeded pool, a pool on the curve, a pool that graduated.
pub const CURVE_NONE: u8 = 0;
pub const CURVE_OPEN: u8 = 1;
pub const CURVE_GRADUATED: u8 = 2;
/// Where the curve fields of the pool start: `virtual_quote`, `graduation_target`,
/// `graduation_fee_bps`, `curve_state`, then 5 reserved bytes. The account is 528 bytes.
pub const POOL_CURVE_OFFSET: usize = 504;
/// Where the curve settings of the platform start: `curve_virtual_quote`,
/// `curve_graduation_target`, `curve_graduation_fee_bps`.
pub const PLATFORM_CURVE_OFFSET: usize = 387;
pub const PLATFORM_DISC: [u8; 8] = [77, 92, 204, 58, 187, 98, 91, 12];
pub const TAX_CONFIG_DISC: [u8; 8] = [38, 187, 35, 231, 115, 102, 30, 82];
pub const GUARD_CONFIG_DISC: [u8; 8] = [95, 175, 118, 50, 193, 113, 37, 250];
pub const BUYBACK_CONFIG_DISC: [u8; 8] = [226, 30, 39, 139, 66, 159, 153, 171];
pub const RULES_CONFIG_DISC: [u8; 8] = [187, 99, 136, 70, 234, 55, 67, 212];

struct Reader<'a> {
    d: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    /// Checks the discriminator and starts after it.
    fn new(d: &'a [u8], disc: &[u8; 8]) -> Option<Self> {
        (d.len() >= 8 && d[..8] == disc[..]).then_some(Self { d, at: 8 })
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.d.get(self.at..self.at + n)?;
        self.at += n;
        Some(s)
    }
    fn skip(&mut self, n: usize) -> Option<()> {
        self.take(n).map(|_| ())
    }
    /// Moves forward to an absolute offset of the account.
    fn skip_to(&mut self, at: usize) -> Option<()> {
        self.skip(at.checked_sub(self.at)?)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes(self.take(2)?.try_into().ok()?))
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn key(&mut self) -> Option<Pubkey> {
        Pubkey::try_from(self.take(32)?).ok()
    }
}

/// The pool account (`PoolData` in the interface crate of the programs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolState {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub base_token_program: Pubkey,
    pub quote_token_program: Pubkey,
    pub lp_fee_bps: u16,
    /// The system program (all zeros) when the pool has no hook.
    pub hook_program: Pubkey,
    pub hook_flags: u32,
    pub hook_extra_metas: Pubkey,
    /// All zeros when the hook takes no fee.
    pub hook_quote_treasury: Pubkey,
    pub hook_kind: u8,
    pub reserve_base: u64,
    /// The REAL quote reserve: what the pool holds and pays sells from.
    pub reserve_quote: u64,
    /// Quote counted in the price while the pool is on the curve, and not held: the price
    /// is `(reserve_quote + virtual_quote) / reserve_base`. 0 on a seeded pool and after
    /// graduation. Offset 504.
    pub virtual_quote: u64,
    /// The real quote reserve at which anyone may graduate the pool. 0 on a seeded pool and
    /// after graduation. Offset 512.
    pub graduation_target: u64,
    /// Share of the target graduation takes for the platform; kept as a record after it.
    /// Offset 520.
    pub graduation_fee_bps: u16,
    /// `CURVE_NONE`, `CURVE_OPEN` or `CURVE_GRADUATED`. Offset 522.
    pub curve_state: u8,
}

impl PoolState {
    pub fn decode(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data, &POOL_DISC)?;
        r.skip(1)?; // bump
        let base_mint = r.key()?;
        let quote_mint = r.key()?;
        let base_vault = r.key()?;
        let quote_vault = r.key()?;
        r.skip(64)?; // lp_mint, lp_lock
        let base_token_program = r.key()?;
        let quote_token_program = r.key()?;
        let lp_fee_bps = r.u16()?;
        let hook_program = r.key()?;
        let hook_flags = r.u32()?;
        let hook_extra_metas = r.key()?;
        let hook_quote_treasury = r.key()?;
        let hook_kind = r.u8()?;
        let reserve_base = r.u64()?;
        let reserve_quote = r.u64()?;
        // fees owed, counters, creator and treasury owner sit between: a quote reads none
        r.skip_to(POOL_CURVE_OFFSET)?;
        let virtual_quote = r.u64()?;
        let graduation_target = r.u64()?;
        let graduation_fee_bps = r.u16()?;
        let curve_state = r.u8()?;
        Some(Self {
            base_mint,
            quote_mint,
            base_vault,
            quote_vault,
            base_token_program,
            quote_token_program,
            lp_fee_bps,
            hook_program,
            hook_flags,
            hook_extra_metas,
            hook_quote_treasury,
            hook_kind,
            reserve_base,
            reserve_quote,
            virtual_quote,
            graduation_target,
            graduation_fee_bps,
            curve_state,
        })
    }

    pub fn has_hook(&self) -> bool {
        self.hook_program != Pubkey::default()
    }

    /// The quote reserve the price is made of: the real one plus the virtual one. `None`
    /// when the sum passes a u64, where the pool fails every swap with `MathOverflow`.
    pub fn effective_quote(&self) -> Option<u64> {
        self.reserve_quote.checked_add(self.virtual_quote)
    }

    /// True while the pool prices with a virtual quote (and refuses liquidity).
    pub fn on_curve(&self) -> bool {
        self.curve_state == CURVE_OPEN
    }

    /// One of the three states this build knows.
    pub fn curve_state_known(&self) -> bool {
        self.curve_state <= CURVE_GRADUATED
    }
}

/// The platform account: the fee every swap pays, the caps the pool holds hooks to, and
/// the settings of new curve pools.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlatformState {
    pub protocol_fee_bps: u16,
    pub max_hook_fee_bps: u16,
    pub max_fee_override_bps: u16,
    pub paused: bool,
    /// The settings a NEW curve pool copies when it is created (offsets 387, 395, 403). A
    /// running pool carries its own copy, so a quote never reads these; they are decoded for
    /// a router that wants to show what a new launch gets. Either of the first two at 0
    /// switches curve launches off.
    pub curve_virtual_quote: u64,
    pub curve_graduation_target: u64,
    pub curve_graduation_fee_bps: u16,
}

impl PlatformState {
    pub fn decode(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data, &PLATFORM_DISC)?;
        r.skip(1 + 32 * 3)?; // bump, admin, pending_admin, treasury
        let protocol_fee_bps = r.u16()?;
        r.skip(2)?; // max_lp_fee_bps
        let max_hook_fee_bps = r.u16()?;
        let max_fee_override_bps = r.u16()?;
        r.skip(8)?; // launch_fee_lamports
        let paused = r.u8()? != 0;
        // whitelist length, the whitelist, the pool count
        r.skip_to(PLATFORM_CURVE_OFFSET)?;
        let curve_virtual_quote = r.u64()?;
        let curve_graduation_target = r.u64()?;
        let curve_graduation_fee_bps = r.u16()?;
        Some(Self { protocol_fee_bps, max_hook_fee_bps, max_fee_override_bps, paused, curve_virtual_quote, curve_graduation_target, curve_graduation_fee_bps })
    }

    /// May a curve pool be created now?
    pub fn curve_enabled(&self) -> bool {
        self.curve_virtual_quote > 0 && self.curve_graduation_target > 0
    }
}

/// What a template hook answers in `before_swap`, read from its per-pool config.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookConfig {
    /// `hook_tax` and `hook_buyback`: a fee in the quote mint, per direction.
    Fee { buy_bps: u16, sell_bps: u16 },
    /// `hook_launch_guard`: a buy fee that replaces the pool fee and decays by slot.
    Guard { start_slot: u64, guard_slots: u64, start_fee_bps: u16 },
    /// `hook_rules`: a fee in the quote mint per direction (the three rates of the side
    /// added up), and for the first slots after launch a buy fee that decays by slot and
    /// a largest buy. Only the rules are read; the running numbers after them (what is
    /// staked, what the creator is owed, the burn's observation) never change a quote.
    Rules {
        /// Length of the sniper window. 0: no sniper fee.
        sniper_slots: u64,
        sniper_start_fee_bps: u16,
        /// creator + holders + burn rate of a buy, and of a sell.
        buy_bps: u16,
        sell_bps: u16,
        /// The most one buy may send inside the limit window. 0: no limit.
        max_buy_quote: u64,
        limit_slots: u64,
        /// The slot the pool was created in. Both windows start here.
        start_slot: u64,
    },
}

impl HookConfig {
    pub fn decode_tax(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data, &TAX_CONFIG_DISC)?;
        r.skip(1 + 32 + 32)?; // bump, pool, owner
        Some(Self::Fee { buy_bps: r.u16()?, sell_bps: r.u16()? })
    }
    pub fn decode_buyback(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data, &BUYBACK_CONFIG_DISC)?;
        r.skip(2 + 32 * 4)?; // bump, authority_bump, pool, base_mint, quote_mint, treasury
        Some(Self::Fee { buy_bps: r.u16()?, sell_bps: r.u16()? })
    }
    pub fn decode_guard(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data, &GUARD_CONFIG_DISC)?;
        r.skip(1 + 32)?; // bump, pool
        Some(Self::Guard { start_slot: r.u64()?, guard_slots: r.u64()?, start_fee_bps: r.u16()? })
    }
    /// The rules of a `hook_rules` pool: offsets 170 to 223 of its config.
    pub fn decode_rules(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data, &RULES_CONFIG_DISC)?;
        r.skip(2 + 32 * 5)?; // bump, authority_bump, pool, base_mint, quote_mint, treasury, creator
        let sniper_slots = r.u64()?;
        let sniper_start_fee_bps = r.u16()?;
        // three u16 a side: creator, holders, burn. A trade pays all three, whoever staked.
        let mut side = || Some(r.u16()?.saturating_add(r.u16()?).saturating_add(r.u16()?));
        let buy_bps = side()?;
        let sell_bps = side()?;
        let max_buy_quote = r.u64()?;
        let limit_slots = r.u64()?;
        r.skip(8)?; // creator_lock_seconds
        let start_slot = r.u64()?;
        Some(Self::Rules { sniper_slots, sniper_start_fee_bps, buy_bps, sell_bps, max_buy_quote, limit_slots, start_slot })
    }
}

/// Does this Token-2022 mint carry a transfer hook (extension 14 with a program set)?
/// The base mint is padded to 165 bytes, byte 165 is the account type, then TLV entries.
pub fn mint_has_transfer_hook(data: &[u8]) -> bool {
    let mut i = 166;
    while i + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[i], data[i + 1]]);
        let len = u16::from_le_bytes([data[i + 2], data[i + 3]]) as usize;
        if kind == 0 || i + 4 + len > data.len() {
            return false;
        }
        if kind == 14 {
            // TransferHook { authority, program_id }
            return len >= 64 && data[i + 4 + 32..i + 4 + 64].iter().any(|b| *b != 0);
        }
        i += 4 + len;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    #[test]
    fn the_pool_decodes_in_borsh_order() {
        let mut d = POOL_DISC.to_vec();
        d.push(254); // bump
        for n in 1..=8u8 {
            d.extend_from_slice(key(n).as_ref()); // base, quote, vaults, lp mint, lp lock, token programs
        }
        d.extend_from_slice(&100u16.to_le_bytes());
        d.extend_from_slice(key(9).as_ref());
        d.extend_from_slice(&0x3201u32.to_le_bytes());
        d.extend_from_slice(key(10).as_ref());
        d.extend_from_slice(key(11).as_ref());
        d.push(2);
        d.extend_from_slice(&111u64.to_le_bytes());
        d.extend_from_slice(&222u64.to_le_bytes());
        d.extend_from_slice(&[0u8; 200]);
        let p = PoolState::decode(&d).unwrap();
        assert_eq!((p.base_mint, p.quote_mint, p.base_vault, p.quote_vault), (key(1), key(2), key(3), key(4)));
        assert_eq!((p.base_token_program, p.quote_token_program), (key(7), key(8)));
        assert_eq!((p.lp_fee_bps, p.hook_program, p.hook_flags, p.hook_kind), (100, key(9), 0x3201, 2));
        assert_eq!((p.hook_extra_metas, p.hook_quote_treasury), (key(10), key(11)));
        assert_eq!((p.reserve_base, p.reserve_quote), (111, 222));
        assert!(p.has_hook());
        // zeros at the end: a seeded pool, as every pool made before the curve reads
        assert_eq!((p.virtual_quote, p.graduation_target, p.graduation_fee_bps, p.curve_state), (0, 0, 0, CURVE_NONE));
        assert_eq!(p.effective_quote(), Some(222));
        // another account type, or a short one, is not a pool
        d[0] ^= 1;
        assert!(PoolState::decode(&d).is_none());
        assert!(PoolState::decode(&POOL_DISC).is_none());
    }

    /// The curve fields sit at the end of the 528-byte account, at the offsets of
    /// INTEGRATORS.md: 504, 512, 520, 522. Nothing between the reserves and them is read.
    #[test]
    fn the_curve_fields_of_a_pool_are_read_at_504_512_520_522() {
        let mut d = vec![0u8; 528];
        d[..8].copy_from_slice(&POOL_DISC);
        d[368..376].copy_from_slice(&1_000u64.to_le_bytes()); // reserve_base
        d[376..384].copy_from_slice(&7u64.to_le_bytes()); // reserve_quote
        d[384..504].fill(0xEE); // fees owed, counters, creator, treasury owner: never read
        d[504..512].copy_from_slice(&30_000_000_000u64.to_le_bytes());
        d[512..520].copy_from_slice(&85_000_000_000u64.to_le_bytes());
        d[520..522].copy_from_slice(&700u16.to_le_bytes());
        d[522] = CURVE_OPEN;
        d[523..528].fill(0xEE); // reserved: never read
        let p = PoolState::decode(&d).unwrap();
        assert_eq!((p.reserve_base, p.reserve_quote), (1_000, 7));
        assert_eq!((p.virtual_quote, p.graduation_target, p.graduation_fee_bps, p.curve_state), (30_000_000_000, 85_000_000_000, 700, CURVE_OPEN));
        assert!(p.on_curve() && p.curve_state_known());
        assert_eq!(p.effective_quote(), Some(30_000_000_007));
        // graduated: no virtual quote and no target any more, the fee kept as a record
        d[504..520].fill(0);
        d[522] = CURVE_GRADUATED;
        let p = PoolState::decode(&d).unwrap();
        assert!(!p.on_curve() && p.curve_state_known());
        assert_eq!((p.effective_quote(), p.graduation_fee_bps), (Some(7), 700));
        // a state this build does not know, and a sum that does not fit a u64
        d[522] = 3;
        assert!(!PoolState::decode(&d).unwrap().curve_state_known());
        d[504..512].copy_from_slice(&u64::MAX.to_le_bytes());
        assert_eq!(PoolState::decode(&d).unwrap().effective_quote(), None);
        // an account cut before its curve state is not a pool
        assert!(PoolState::decode(&d[..522]).is_none());
        assert!(PoolState::decode(&d[..523]).is_some());
    }

    /// The platform's settings for new curve pools, at 387, 395 and 403 of its 451 bytes.
    #[test]
    fn the_curve_settings_of_the_platform_are_read_at_387_395_403() {
        let mut d = vec![0u8; 451];
        d[..8].copy_from_slice(&PLATFORM_DISC);
        d[105..107].copy_from_slice(&20u16.to_le_bytes());
        d[109..111].copy_from_slice(&1_000u16.to_le_bytes());
        d[111..113].copy_from_slice(&5_000u16.to_le_bytes());
        d[122..387].fill(0x11); // whitelist length, whitelist, pool count: never read
        d[387..395].copy_from_slice(&30_000_000_000u64.to_le_bytes());
        d[395..403].copy_from_slice(&85_000_000_000u64.to_le_bytes());
        d[403..405].copy_from_slice(&500u16.to_le_bytes());
        let p = PlatformState::decode(&d).unwrap();
        assert_eq!((p.protocol_fee_bps, p.max_hook_fee_bps, p.max_fee_override_bps, p.paused), (20, 1_000, 5_000, false));
        assert_eq!((p.curve_virtual_quote, p.curve_graduation_target, p.curve_graduation_fee_bps), (30_000_000_000, 85_000_000_000, 500));
        assert!(p.curve_enabled());
        d[395..403].fill(0);
        assert!(!PlatformState::decode(&d).unwrap().curve_enabled(), "a target of 0 switches curve launches off");
        assert!(PlatformState::decode(&d[..404]).is_none(), "an account cut inside the curve settings");
    }

    /// A rules config built field by field, at the offsets of INTEGRATORS.md.
    #[test]
    fn the_rules_config_is_read_at_its_documented_offsets() {
        let mut d = vec![0u8; 414];
        d[..8].copy_from_slice(&RULES_CONFIG_DISC);
        d[170..178].copy_from_slice(&750u64.to_le_bytes()); // sniper_slots
        d[178..180].copy_from_slice(&3_000u16.to_le_bytes()); // sniper_start_fee_bps
        for (i, bps) in [50u16, 100, 25, 100, 200, 75].iter().enumerate() {
            d[180 + 2 * i..182 + 2 * i].copy_from_slice(&bps.to_le_bytes()); // buy, then sell: creator, holders, burn
        }
        d[192..200].copy_from_slice(&200_000_000u64.to_le_bytes()); // max_buy_quote
        d[200..208].copy_from_slice(&4_500u64.to_le_bytes()); // limit_slots
        d[208..216].copy_from_slice(&u64::MAX.to_le_bytes()); // creator_lock_seconds: not read
        d[216..224].copy_from_slice(&123_456u64.to_le_bytes()); // start_slot
        d[224..414].fill(0xAB); // the running numbers: never read
        assert_eq!(
            HookConfig::decode_rules(&d),
            Some(HookConfig::Rules { sniper_slots: 750, sniper_start_fee_bps: 3_000, buy_bps: 175, sell_bps: 375, max_buy_quote: 200_000_000, limit_slots: 4_500, start_slot: 123_456 })
        );
        // another account type, or one cut before the start slot, is not a rules config
        assert!(HookConfig::decode_rules(&d[..223]).is_none());
        d[0] ^= 1;
        assert!(HookConfig::decode_rules(&d).is_none());
    }

    /// The buyback config grew by its observation of the pool; the two shares did not move.
    #[test]
    fn the_buyback_shares_are_read_from_a_config_of_230_bytes() {
        let mut d = vec![0u8; 230];
        d[..8].copy_from_slice(&BUYBACK_CONFIG_DISC);
        d[138..140].copy_from_slice(&200u16.to_le_bytes());
        d[140..142].copy_from_slice(&300u16.to_le_bytes());
        d[206..230].fill(0xCD); // obs_slot, obs_reserve_base, obs_reserve_quote
        assert_eq!(HookConfig::decode_buyback(&d), Some(HookConfig::Fee { buy_bps: 200, sell_bps: 300 }));
    }

    #[test]
    fn a_transfer_hook_is_found_only_when_a_program_is_set() {
        let mint = |ext: &[u8]| {
            let mut d = vec![0u8; 166];
            d[165] = 1;
            d.extend_from_slice(ext);
            d
        };
        let mut hook = vec![14u8, 0, 64, 0];
        hook.extend_from_slice(&[0u8; 32]);
        hook.extend_from_slice(&[7u8; 32]);
        assert!(mint_has_transfer_hook(&mint(&hook)));
        let mut unset = vec![14u8, 0, 64, 0];
        unset.extend_from_slice(&[0u8; 64]);
        assert!(!mint_has_transfer_hook(&mint(&unset)));
        // a metadata pointer first, then the hook
        let mut both = vec![18u8, 0, 64, 0];
        both.extend_from_slice(&[1u8; 64]);
        both.extend_from_slice(&hook);
        assert!(mint_has_transfer_hook(&mint(&both)));
        assert!(!mint_has_transfer_hook(&[0u8; 82]), "a mint without extensions");
    }
}
