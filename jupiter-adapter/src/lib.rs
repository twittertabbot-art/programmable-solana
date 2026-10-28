//! Jupiter `Amm` adapter for Programmable pools.
//!
//! A Programmable pool is a constant-product market that may name a hook program. The pool
//! calls the hook before and after swaps; the hook answers with a fee, and the pool holds
//! every answer to hard caps. This adapter quotes a pool from cached accounts alone:
//!
//! * the pool account: reserves, fee, the hook and its flags, and on a pool launched on the
//!   curve its virtual quote and its state;
//! * the platform account: the protocol fee, the caps, the pause switch;
//! * for a template hook, its per-pool config: what it will answer;
//! * the hook's list of extra accounts, to build the swap's account list;
//! * the base mint, when it lives in Token-2022, to see whether it carries a transfer hook.
//!
//! What is offered for routing, and what is not:
//!
//! | Pool | Routed |
//! |---|---|
//! | no hook | both directions |
//! | `hook_tax`, `hook_buyback` | both directions; the fee is read from the config |
//! | `hook_launch_guard` | both directions; the buy fee follows the slot |
//! | `hook_rules` | both directions; the fee is the three rates of the side, read from the config. Inside the sniper window the buy fee follows the slot. A buy above the coin's buy limit, inside its window, is refused |
//! | `hook_collectible`, plain coin | both directions; the hook takes no fee |
//! | a coin with a Token-2022 transfer hook (a pegged coin, a strict coin) | not routed |
//! | any other hook | only the directions on which the pool never calls it |
//!
//! A hook this adapter does not know may answer any fee under the caps, or refuse the swap,
//! so a direction on which it is called cannot be quoted. A direction on which the pool
//! never calls it (its `CALL_ON_BUY` / `CALL_ON_SELL` flag is unset) is plain curve math
//! and is quoted exactly: holders of such a coin can always be routed out.
//!
//! Any of these pools may have been launched on the curve. While it is on the curve the pool
//! prices with `reserve_quote + virtual_quote` and pays sells from `reserve_quote` alone; it
//! opens with no real quote at all and is tradable from its first slot. A sell whose output
//! would pass the real reserve is not quoted. After graduation the virtual quote is 0 and
//! the pool is quoted like any other. The pool account is the same before and after.
//! `graduate` is not sent by this adapter.

pub mod extra;
pub mod math;
pub mod state;

use std::sync::atomic::Ordering;

use jupiter_amm_interface::{
    AccountProvider, Amm, AmmContext, AmmError, AmmLabel, ClockRef, KeyedAccount, Quote, QuoteParams, SingleProgramAmm, Swap,
    SwapAndAccountMetas, SwapMode, SwapParams, single_program_amm,
};
use rust_decimal::Decimal;
use solana_account::ReadableAccount;
use solana_instruction::AccountMeta;
use solana_pubkey::{Pubkey, pubkey};

use crate::extra::ExtraMeta;
use crate::state::{HookConfig, PlatformState, PoolState};

/// The pool program and the five template hooks: the ids of this build, the same on every
/// cluster it is deployed to. A deployer who gives the programs other ids rewrites these
/// lines with `scripts/rekey.mjs` of the repository and makes the test fixtures again.
pub const HOOKPOOL_PROGRAM: Pubkey = pubkey!("7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh");
pub const HOOK_TAX: Pubkey = pubkey!("jwdXDuSQ9pNV1pXj8BFvBb5fhqtTL3duQkwsTjXunhr");
pub const HOOK_LAUNCH_GUARD: Pubkey = pubkey!("G59xnMnbenifbGR1y6QjaTRa6wa1FFfqZB3KZBUyckPW");
pub const HOOK_BUYBACK: Pubkey = pubkey!("3M824Hn8Z6S7r1t1zqpNQpioKFd31jrQwSN2oxV2ovo5");
pub const HOOK_COLLECTIBLE: Pubkey = pubkey!("3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m");
pub const HOOK_RULES: Pubkey = pubkey!("3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Hook flags, as stored in the pool.
pub const BEFORE_SWAP: u32 = 1 << 0;
pub const AFTER_SWAP: u32 = 1 << 1;
pub const CALL_ON_BUY: u32 = 1 << 12;
pub const CALL_ON_SELL: u32 = 1 << 13;

/// `direction` argument of the pool's swap: quote to base, and base to quote.
pub const DIRECTION_BUY: u8 = 0;
pub const DIRECTION_SELL: u8 = 1;

/// sha256("global:swap")[..8]
pub const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

/// The pool's native swap instruction data: discriminator, direction, amount in, minimum out.
pub fn swap_instruction_data(direction: u8, amount_in: u64, min_amount_out: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + 1 + 8 + 8);
    data.extend_from_slice(&SWAP_DISCRIMINATOR);
    data.push(direction);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_amount_out.to_le_bytes());
    data
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}
pub fn platform_address() -> Pubkey {
    pda(&[b"platform"], &HOOKPOOL_PROGRAM)
}
/// The PDA that signs the pool's calls into one hook program: `["caller", hook program]`.
/// There is one per hook program, so that no hook can pass the pool's signature on to
/// another. A pool without a hook has the system program (32 zero bytes) in its hook
/// field, and its caller is derived from that; nothing is ever signed with it. Every
/// swap names the caller of the pool's own hook program, as account 12.
pub fn caller_address(hook_program: &Pubkey) -> Pubkey {
    pda(&[b"caller", hook_program.as_ref()], &HOOKPOOL_PROGRAM)
}
pub fn event_authority_address() -> Pubkey {
    pda(&[b"__event_authority"], &HOOKPOOL_PROGRAM)
}
/// A template hook's per-pool config.
pub fn hook_config_address(hook_program: &Pubkey, pool: &Pubkey) -> Pubkey {
    pda(&[b"cfg", pool.as_ref()], hook_program)
}

/// Which hook a pool runs, as far as quoting goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookKind {
    None,
    Tax,
    LaunchGuard,
    Buyback,
    Collectible,
    /// The launch rules template.
    Rules,
    /// A hook this adapter cannot predict.
    Other,
}

impl HookKind {
    fn of(pool: &PoolState) -> Self {
        if !pool.has_hook() {
            Self::None
        } else if pool.hook_program == HOOK_TAX {
            Self::Tax
        } else if pool.hook_program == HOOK_LAUNCH_GUARD {
            Self::LaunchGuard
        } else if pool.hook_program == HOOK_BUYBACK {
            Self::Buyback
        } else if pool.hook_program == HOOK_COLLECTIBLE {
            Self::Collectible
        } else if pool.hook_program == HOOK_RULES {
            Self::Rules
        } else {
            Self::Other
        }
    }
    /// The file name of the hook's program in a test fixture directory.
    fn fixture_name(&self, program: &Pubkey) -> String {
        match self {
            Self::Tax => "hook_tax".into(),
            Self::LaunchGuard => "hook_launch_guard".into(),
            Self::Buyback => "hook_buyback".into(),
            Self::Collectible => "hook_collectible".into(),
            Self::Rules => "hook_rules".into(),
            Self::None | Self::Other => program.to_string(),
        }
    }
    /// Does a quote depend on the hook's per-pool config?
    fn reads_config(&self) -> bool {
        matches!(self, Self::Tax | Self::LaunchGuard | Self::Buyback | Self::Rules)
    }
}

#[derive(Clone)]
pub struct ProgrammableAmm {
    key: Pubkey,
    pool: PoolState,
    kind: HookKind,
    clock: ClockRef,
    platform: Option<PlatformState>,
    config: Option<HookConfig>,
    extra: Option<Vec<ExtraMeta>>,
    /// `None` until the base mint has been read. Always `Some(false)` for a classic SPL coin.
    base_has_transfer_hook: Option<bool>,
}

single_program_amm!(ProgrammableAmm, HOOKPOOL_PROGRAM, "Programmable");

impl ProgrammableAmm {
    /// Does the pool call the hook on swaps in this direction, in any callback?
    fn hook_called(&self, is_buy: bool) -> bool {
        self.callback_enabled(BEFORE_SWAP | AFTER_SWAP, is_buy)
    }
    /// The pool's own rule: a swap callback runs only when its flag and the flag of the
    /// direction are both set.
    fn callback_enabled(&self, callback_flags: u32, is_buy: bool) -> bool {
        self.pool.has_hook()
            && self.pool.hook_flags & callback_flags != 0
            && self.pool.hook_flags & if is_buy { CALL_ON_BUY } else { CALL_ON_SELL } != 0
    }

    /// Can a swap in this direction be quoted exactly from what is cached?
    pub fn routable(&self, is_buy: bool) -> bool {
        let Some(platform) = self.platform else { return false };
        if platform.paused || self.pool.reserve_base == 0 || !self.pool.curve_state_known() {
            return false;
        }
        // The price is made of the EFFECTIVE quote reserve: the real one, plus the virtual
        // one while the pool is on the curve. A pool on the curve opens with no real quote and
        // is tradable all the same.
        if !matches!(self.pool.effective_quote(), Some(q) if q > 0) {
            return false;
        }
        // A sell is paid from the real quote alone: with none there, no sell can be filled.
        if !is_buy && self.pool.reserve_quote == 0 {
            return false;
        }
        // A coin with a transfer hook runs its own program inside every transfer.
        if self.base_has_transfer_hook != Some(false) {
            return false;
        }
        if !self.hook_called(is_buy) {
            return true;
        }
        match self.kind {
            HookKind::None => true,
            HookKind::Other => false,
            // the hook is called: its accounts must resolve, and its answer must be known
            kind => self.extra_accounts(&Pubkey::default()).is_some() && (!kind.reads_config() || self.config.is_some()),
        }
    }

    /// What the hook answers in `before_swap`, after the pool's caps: (hook fee, fee override).
    /// An error where the hook would refuse the swap: a buy above the buy limit of a rules
    /// coin, inside its window.
    fn hook_answer(&self, is_buy: bool, amount_in: u64, platform: &PlatformState) -> Result<(u16, Option<u16>), AmmError> {
        if !self.callback_enabled(BEFORE_SWAP, is_buy) {
            return Ok((0, None));
        }
        Ok(match self.config {
            Some(HookConfig::Fee { buy_bps, sell_bps }) => ((if is_buy { buy_bps } else { sell_bps }).min(platform.max_hook_fee_bps), None),
            Some(HookConfig::Guard { start_slot, guard_slots, start_fee_bps }) if is_buy && start_slot != 0 => {
                let slot = self.clock.slot.load(Ordering::Relaxed);
                let fee = math::guard_fee(slot, start_slot, guard_slots, start_fee_bps, self.pool.lp_fee_bps);
                (0, fee.map(|bps| bps.min(platform.max_fee_override_bps)))
            }
            Some(HookConfig::Rules { sniper_slots, sniper_start_fee_bps, buy_bps, sell_bps, max_buy_quote, limit_slots, start_slot }) => {
                // every trade pays the three rates of its side, whoever is staked
                let hook_fee = (if is_buy { buy_bps } else { sell_bps }).min(platform.max_hook_fee_bps);
                if !is_buy {
                    // the two windows touch buys only
                    return Ok((hook_fee, None));
                }
                let slot = self.clock.slot.load(Ordering::Relaxed);
                if math::buy_above_limit(slot, start_slot, limit_slots, max_buy_quote, amount_in) {
                    return Err(AmmError::from("this buy is above the coin's buy limit, which holds for its first slots"));
                }
                let fee = math::sniper_fee(slot, start_slot, sniper_slots, sniper_start_fee_bps, self.pool.lp_fee_bps);
                (hook_fee, fee.map(|bps| bps.min(platform.max_fee_override_bps)))
            }
            _ => (0, None),
        })
    }

    /// The hook's extra accounts for a swap signed by `user`. `None` when the pool has a
    /// hook whose list is not cached yet or cannot be resolved without the network.
    fn extra_accounts(&self, user: &Pubkey) -> Option<Vec<AccountMeta>> {
        if !self.pool.has_hook() {
            return Some(Vec::new());
        }
        let fixed = [self.key, caller_address(&self.pool.hook_program), *user, self.pool.quote_mint, self.pool.base_mint];
        extra::resolve(self.extra.as_ref()?, &self.pool.hook_program, &fixed)
    }

    pub fn pool(&self) -> &PoolState {
        &self.pool
    }
    pub fn hook_kind(&self) -> HookKind {
        self.kind
    }

    fn direction(&self, input_mint: &Pubkey, output_mint: &Pubkey) -> Result<bool, AmmError> {
        if *input_mint == self.pool.quote_mint && *output_mint == self.pool.base_mint {
            Ok(true)
        } else if *input_mint == self.pool.base_mint && *output_mint == self.pool.quote_mint {
            Ok(false)
        } else {
            Err(AmmError::from("these are not the two mints of this pool"))
        }
    }
}

impl Amm for ProgrammableAmm {
    fn from_keyed_account(keyed_account: &KeyedAccount, amm_context: &AmmContext) -> Result<Self, AmmError> {
        if keyed_account.account.owner() != &Self::PROGRAM_ID {
            return Err(AmmError::from("not an account of the Programmable pool program"));
        }
        let pool = PoolState::decode(keyed_account.account.data()).ok_or_else(|| AmmError::from("not a Programmable pool account"))?;
        Ok(Self {
            key: keyed_account.key,
            kind: HookKind::of(&pool),
            base_has_transfer_hook: (pool.base_token_program != TOKEN_2022_PROGRAM).then_some(false),
            pool,
            clock: amm_context.clock_ref.clone(),
            platform: None,
            config: None,
            extra: None,
        })
    }

    fn label(&self) -> AmmLabel {
        Self::LABEL
    }

    fn program_id(&self) -> Pubkey {
        Self::PROGRAM_ID
    }

    fn key(&self) -> Pubkey {
        self.key
    }

    /// [base, quote]. A pool that can only be bought (see `unidirectional`) lists the quote
    /// first, so that the one direction it trades in is first mint to second mint.
    fn get_reserve_mints(&self) -> Vec<Pubkey> {
        if self.kind == HookKind::Other && self.hook_called(false) && !self.hook_called(true) {
            vec![self.pool.quote_mint, self.pool.base_mint]
        } else {
            vec![self.pool.base_mint, self.pool.quote_mint]
        }
    }

    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        let mut keys = vec![self.key, platform_address()];
        if self.pool.base_token_program == TOKEN_2022_PROGRAM {
            keys.push(self.pool.base_mint);
        }
        if self.pool.has_hook() {
            keys.push(self.pool.hook_extra_metas);
            if self.kind.reads_config() {
                keys.push(hook_config_address(&self.pool.hook_program, &self.key));
            }
        }
        keys
    }

    fn update(&mut self, account_provider: impl AccountProvider) -> Result<(), AmmError> {
        let pool = account_provider.get(&self.key).ok_or_else(|| AmmError::from("the pool account is missing"))?;
        self.pool = PoolState::decode(pool.data()).ok_or_else(|| AmmError::from("the pool account no longer decodes"))?;
        drop(pool);
        self.kind = HookKind::of(&self.pool);

        // Everything else may be missing for a moment (a batch that raced a new pool): the
        // pool is then simply not offered until the next update.
        self.platform = account_provider
            .get(&platform_address())
            .filter(|a| a.owner() == &Self::PROGRAM_ID)
            .and_then(|a| PlatformState::decode(a.data()));
        if self.pool.base_token_program == TOKEN_2022_PROGRAM {
            self.base_has_transfer_hook = account_provider
                .get(&self.pool.base_mint)
                .filter(|a| a.owner() == &TOKEN_2022_PROGRAM)
                .map(|a| state::mint_has_transfer_hook(a.data()));
        } else {
            self.base_has_transfer_hook = Some(false);
        }
        self.extra = None;
        self.config = None;
        if self.pool.has_hook() {
            let hook = self.pool.hook_program;
            self.extra = account_provider.get(&self.pool.hook_extra_metas).filter(|a| a.owner() == &hook).and_then(|a| extra::parse(a.data()));
            if self.kind.reads_config() {
                self.config = account_provider.get(&hook_config_address(&hook, &self.key)).filter(|a| a.owner() == &hook).and_then(|a| match self.kind {
                    HookKind::Tax => HookConfig::decode_tax(a.data()),
                    HookKind::Buyback => HookConfig::decode_buyback(a.data()),
                    HookKind::LaunchGuard => HookConfig::decode_guard(a.data()),
                    HookKind::Rules => HookConfig::decode_rules(a.data()),
                    _ => None,
                });
            }
        }
        Ok(())
    }

    fn quote(&self, quote_params: &QuoteParams) -> Result<Quote, AmmError> {
        if !matches!(quote_params.swap_mode, SwapMode::ExactIn) {
            return Err(AmmError::from("Programmable pools quote exact-in swaps only"));
        }
        let is_buy = self.direction(&quote_params.input_mint, &quote_params.output_mint)?;
        if !self.routable(is_buy) {
            return Err(AmmError::from("this pool cannot be quoted in this direction"));
        }
        let platform = self.platform.ok_or_else(|| AmmError::from("the platform account is not loaded"))?;
        let (hook_fee_bps, fee_override_bps) = self.hook_answer(is_buy, quote_params.amount, &platform)?;
        // On a pool on the curve the quote runs on the effective reserve and a sell whose
        // output would pass the real reserve is refused like any amount the pool refuses. A
        // pool that stands past its graduation target and has not graduated yet is still on
        // the curve, and so is its quote, until a `graduate` lands.
        let q = math::quote_swap(
            is_buy,
            quote_params.amount,
            self.pool.reserve_base,
            self.pool.reserve_quote,
            self.pool.virtual_quote,
            self.pool.lp_fee_bps,
            platform.protocol_fee_bps,
            hook_fee_bps,
            fee_override_bps,
        )
        .ok_or_else(|| AmmError::from("the pool would refuse this amount"))?;

        // Fees in the input mint. On a sell the hook's fee is taken from the output instead
        // and is already out of `out_amount`; the percentage below counts it.
        let fee_amount = q.protocol_fee + q.lp_fee + if is_buy { q.hook_fee } else { 0 };
        let fee_bps = platform.protocol_fee_bps as u32 + q.fee_bps_applied as u32 + hook_fee_bps as u32;
        Ok(Quote {
            in_amount: quote_params.amount,
            out_amount: q.amount_out,
            fee_amount,
            fee_mint: quote_params.input_mint,
            fee_pct: Decimal::new(fee_bps as i64, 4),
        })
    }

    /// The pool's native swap accounts, in on-chain order: seventeen fixed ones, then the
    /// hook's own. `Swap::Placeholder` carries the direction byte.
    fn get_swap_and_account_metas(&self, swap_params: &SwapParams) -> Result<SwapAndAccountMetas, AmmError> {
        let is_buy = self.direction(&swap_params.source_mint, &swap_params.destination_mint)?;
        let (user_base, user_quote) = if is_buy {
            (swap_params.destination_token_account, swap_params.source_token_account)
        } else {
            (swap_params.source_token_account, swap_params.destination_token_account)
        };
        let user = swap_params.token_transfer_authority;
        // A pool without a hook fee takes any writable account in the treasury's place.
        let treasury = if self.pool.hook_quote_treasury == Pubkey::default() { user_quote } else { self.pool.hook_quote_treasury };
        let p = &self.pool;
        let mut account_metas = vec![
            AccountMeta::new_readonly(user, true),
            AccountMeta::new_readonly(platform_address(), false),
            AccountMeta::new(self.key, false),
            AccountMeta::new_readonly(p.base_mint, false),
            AccountMeta::new_readonly(p.quote_mint, false),
            AccountMeta::new(p.base_vault, false),
            AccountMeta::new(p.quote_vault, false),
            AccountMeta::new(user_base, false),
            AccountMeta::new(user_quote, false),
            AccountMeta::new(treasury, false),
            AccountMeta::new_readonly(p.hook_program, false),
            AccountMeta::new_readonly(p.hook_extra_metas, false),
            // the caller of THIS pool's hook program (of the system program when it has none)
            AccountMeta::new_readonly(caller_address(&p.hook_program), false),
            AccountMeta::new_readonly(p.base_token_program, false),
            AccountMeta::new_readonly(p.quote_token_program, false),
            AccountMeta::new_readonly(event_authority_address(), false),
            AccountMeta::new_readonly(HOOKPOOL_PROGRAM, false),
        ];
        // The hook's accounts are needed whenever the pool calls it. They are passed on the
        // other direction too when they resolve, as every other client does. Each keeps the
        // writable bit of the hook's list: the config of a buyback, launch guard or rules pool
        // is written by the hook, and passed read-only it would stop the swap.
        match self.extra_accounts(&user) {
            Some(extra) => account_metas.extend(extra),
            None if self.hook_called(is_buy) => return Err(AmmError::from("the hook's accounts are not resolved")),
            None => {}
        }
        Ok(SwapAndAccountMetas {
            swap: Swap::Placeholder { data: Some(vec![if is_buy { DIRECTION_BUY } else { DIRECTION_SELL }]) },
            account_metas,
        })
    }

    /// True for a pool on a hook this adapter cannot predict, when the pool calls that hook
    /// in one direction only: the other direction is plain curve math.
    fn unidirectional(&self) -> bool {
        self.kind == HookKind::Other && self.hook_called(true) != self.hook_called(false)
    }

    fn program_dependencies(&self) -> Vec<(Pubkey, String)> {
        if self.pool.has_hook() { vec![(self.pool.hook_program, self.kind.fixture_name(&self.pool.hook_program))] } else { vec![] }
    }

    fn get_accounts_len(&self) -> usize {
        17 + self.extra.as_ref().map_or(0, |e| e.len())
    }

    fn is_active(&self) -> bool {
        self.routable(true) || self.routable(false)
    }
}

#[cfg(test)]
mod tests {
    //! What is offered for routing and what is not, on accounts built by hand. The parity
    //! suite in `tests/parity.rs` proves the numbers against the real programs.

    use std::collections::HashMap;

    use solana_account::Account;

    use super::*;
    use crate::state::{BUYBACK_CONFIG_DISC, GUARD_CONFIG_DISC, PLATFORM_DISC, POOL_DISC, RULES_CONFIG_DISC, TAX_CONFIG_DISC};

    const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const POOL: Pubkey = Pubkey::new_from_array([42; 32]);
    const BASE: Pubkey = Pubkey::new_from_array([1; 32]);
    const QUOTE: Pubkey = Pubkey::new_from_array([2; 32]);
    const CUSTOM_HOOK: Pubkey = Pubkey::new_from_array([77; 32]);
    const CUSTOM_METAS: Pubkey = Pubkey::new_from_array([78; 32]);
    const LP_FEE: u16 = 100;
    const PROTOCOL_FEE: u16 = 20;
    const RESERVE_BASE: u64 = 1_000_000_000_000;
    const RESERVE_QUOTE: u64 = 100_000_000_000;

    struct Chain(HashMap<Pubkey, Account>);
    impl AccountProvider for Chain {
        fn get(&self, pubkey: &Pubkey) -> Option<impl ReadableAccount + use<'_>> {
            self.0.get(pubkey).cloned()
        }
    }
    fn account(owner: Pubkey, data: Vec<u8>) -> Account {
        Account { lamports: 1, data, owner, executable: false, rent_epoch: 0 }
    }

    fn pool_bytes(hook: Pubkey, flags: u32, base_program: Pubkey) -> Vec<u8> {
        let mut d = POOL_DISC.to_vec();
        d.push(255);
        for k in [BASE, QUOTE, Pubkey::new_from_array([3; 32]), Pubkey::new_from_array([4; 32]), Pubkey::new_from_array([5; 32]), Pubkey::new_from_array([6; 32]), base_program, TOKEN_PROGRAM] {
            d.extend_from_slice(k.as_ref());
        }
        d.extend_from_slice(&LP_FEE.to_le_bytes());
        d.extend_from_slice(hook.as_ref());
        d.extend_from_slice(&flags.to_le_bytes());
        let metas = if hook == Pubkey::default() { Pubkey::default() } else if hook == CUSTOM_HOOK { CUSTOM_METAS } else { pda(&[b"extra-metas"], &hook) };
        d.extend_from_slice(metas.as_ref());
        d.extend_from_slice(Pubkey::default().as_ref()); // no hook treasury
        d.push(if hook == Pubkey::default() { 0 } else { 1 });
        d.extend_from_slice(&RESERVE_BASE.to_le_bytes());
        d.extend_from_slice(&RESERVE_QUOTE.to_le_bytes());
        d.extend_from_slice(&[0u8; 160]);
        d
    }
    /// The same pool with its real quote reserve and its curve fields set (offsets 376, 504,
    /// 512, 522).
    fn on_curve(mut d: Vec<u8>, reserve_quote: u64, virtual_quote: u64, target: u64, state: u8) -> Vec<u8> {
        d[376..384].copy_from_slice(&reserve_quote.to_le_bytes());
        d[504..512].copy_from_slice(&virtual_quote.to_le_bytes());
        d[512..520].copy_from_slice(&target.to_le_bytes());
        d[522] = state;
        d
    }
    fn platform_bytes(paused: bool, max_hook_fee: u16) -> Vec<u8> {
        let mut d = PLATFORM_DISC.to_vec();
        d.push(255);
        d.extend_from_slice(&[9u8; 96]);
        for v in [PROTOCOL_FEE, 1_000, max_hook_fee, 5_000] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(&10_000_000u64.to_le_bytes());
        d.push(paused as u8);
        d.extend_from_slice(&[0u8; 400]);
        d
    }
    /// A list with one entry: the per-pool config `[b"cfg", pool]` of the hook program,
    /// read-only as the tax hook publishes it.
    fn config_list() -> Vec<u8> {
        config_list_of(false)
    }
    /// The same list with the config writable, as the launch guard, the buyback and the
    /// rules hook publish it.
    fn config_list_of(writable: bool) -> Vec<u8> {
        let mut value = 1u32.to_le_bytes().to_vec();
        let mut cfg = [0u8; 32];
        cfg[..7].copy_from_slice(&[1, 3, b'c', b'f', b'g', 3, 0]);
        value.push(1);
        value.extend_from_slice(&cfg);
        value.extend_from_slice(&[0, writable as u8]);
        let mut d = extra::CALLBACK_TLV_DISC.to_vec();
        d.extend_from_slice(&(value.len() as u32).to_le_bytes());
        d.extend_from_slice(&value);
        d
    }
    fn tax_config(buy_bps: u16, sell_bps: u16) -> Vec<u8> {
        let mut d = TAX_CONFIG_DISC.to_vec();
        d.push(255);
        d.extend_from_slice(&[0u8; 64]);
        d.extend_from_slice(&buy_bps.to_le_bytes());
        d.extend_from_slice(&sell_bps.to_le_bytes());
        d.extend_from_slice(&[0u8; 40]);
        d
    }
    /// A buyback config of 230 bytes: the two shares at 138 and 140, the observation at the end.
    fn buyback_config(buy_bps: u16, sell_bps: u16) -> Vec<u8> {
        let mut d = vec![0u8; 230];
        d[..8].copy_from_slice(&BUYBACK_CONFIG_DISC);
        d[138..140].copy_from_slice(&buy_bps.to_le_bytes());
        d[140..142].copy_from_slice(&sell_bps.to_le_bytes());
        d[206..230].fill(7);
        d
    }
    /// A rules config of 414 bytes. `buy` and `sell` are the three rates of a side:
    /// creator, holders, burn.
    fn rules_config(sniper: (u64, u16), buy: [u16; 3], sell: [u16; 3], limit: (u64, u64), start_slot: u64) -> Vec<u8> {
        let mut d = vec![0u8; 414];
        d[..8].copy_from_slice(&RULES_CONFIG_DISC);
        d[170..178].copy_from_slice(&sniper.0.to_le_bytes());
        d[178..180].copy_from_slice(&sniper.1.to_le_bytes());
        for (i, bps) in buy.iter().chain(sell.iter()).enumerate() {
            d[180 + 2 * i..182 + 2 * i].copy_from_slice(&bps.to_le_bytes());
        }
        d[192..200].copy_from_slice(&limit.0.to_le_bytes());
        d[200..208].copy_from_slice(&limit.1.to_le_bytes());
        d[216..224].copy_from_slice(&start_slot.to_le_bytes());
        // what is staked, what is owed, the burn's observation: a quote reads none of it
        d[232..374].fill(0x5A);
        d
    }
    fn guard_config(start_slot: u64, guard_slots: u64, start_fee_bps: u16) -> Vec<u8> {
        let mut d = GUARD_CONFIG_DISC.to_vec();
        d.push(255);
        d.extend_from_slice(&[0u8; 32]);
        d.extend_from_slice(&start_slot.to_le_bytes());
        d.extend_from_slice(&guard_slots.to_le_bytes());
        d.extend_from_slice(&start_fee_bps.to_le_bytes());
        d.extend_from_slice(&[0u8; 40]);
        d
    }

    /// A chain with the pool and an unpaused platform; `more` adds or replaces accounts.
    fn chain(pool: Vec<u8>, more: Vec<(Pubkey, Account)>) -> Chain {
        let mut m = HashMap::new();
        m.insert(POOL, account(HOOKPOOL_PROGRAM, pool));
        m.insert(platform_address(), account(HOOKPOOL_PROGRAM, platform_bytes(false, 1_000)));
        m.extend(more);
        Chain(m)
    }
    fn amm_at(chain: &Chain, slot: u64) -> ProgrammableAmm {
        let clock = ClockRef::default();
        clock.slot.store(slot, Ordering::Relaxed);
        let keyed = KeyedAccount { key: POOL, account: chain.0[&POOL].clone(), params: None };
        let mut amm = ProgrammableAmm::from_keyed_account(&keyed, &AmmContext { clock_ref: clock }).unwrap();
        amm.update(chain).unwrap();
        amm
    }
    fn amm(chain: &Chain) -> ProgrammableAmm {
        amm_at(chain, 0)
    }
    fn buy(amm: &ProgrammableAmm, amount: u64) -> Result<Quote, AmmError> {
        amm.quote(&QuoteParams { amount, input_mint: QUOTE, output_mint: BASE, swap_mode: SwapMode::ExactIn, fee_mode: Default::default() })
    }
    fn sell(amm: &ProgrammableAmm, amount: u64) -> Result<Quote, AmmError> {
        amm.quote(&QuoteParams { amount, input_mint: BASE, output_mint: QUOTE, swap_mode: SwapMode::ExactIn, fee_mode: Default::default() })
    }
    fn plain(is_buy: bool, amount: u64) -> u64 {
        math::quote_swap(is_buy, amount, RESERVE_BASE, RESERVE_QUOTE, 0, LP_FEE, PROTOCOL_FEE, 0, None).unwrap().amount_out
    }
    fn swap_params<'a>(source_mint: Pubkey, destination_mint: Pubkey, source: Pubkey, destination: Pubkey, user: Pubkey, jupiter: &'a Pubkey) -> SwapParams<'a, 'a> {
        SwapParams {
            swap_mode: SwapMode::ExactIn,
            in_amount: 1,
            out_amount: 1,
            source_mint,
            destination_mint,
            source_token_account: source,
            destination_token_account: destination,
            token_transfer_authority: user,
            user,
            payer: user,
            quote_mint_to_referrer: None,
            jupiter_program_id: jupiter,
            missing_dynamic_accounts_as_default: false,
        }
    }

    #[test]
    fn a_pool_without_a_hook_is_routed_both_ways() {
        let c = chain(pool_bytes(Pubkey::default(), 0, TOKEN_PROGRAM), vec![]);
        let a = amm(&c);
        assert!(a.is_active() && !a.unidirectional());
        assert_eq!(a.get_reserve_mints(), vec![BASE, QUOTE]);
        assert_eq!(a.get_accounts_to_update(), vec![POOL, platform_address()]);
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, plain(true, 1_000_000_000));
        assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, plain(false, 5_000_000));
    }

    const VIRTUAL: u64 = 30_000_000_000;
    const TARGET: u64 = 85_000_000_000;

    #[test]
    fn a_pool_on_the_curve_is_routed_from_its_first_slot_and_quoted_with_its_virtual_quote() {
        let curve = |is_buy, amount, real| math::quote_swap(is_buy, amount, RESERVE_BASE, real, VIRTUAL, LP_FEE, PROTOCOL_FEE, 0, None).unwrap().amount_out;
        let seeded = |is_buy, amount, real| math::quote_swap(is_buy, amount, RESERVE_BASE, real, 0, LP_FEE, PROTOCOL_FEE, 0, None).unwrap().amount_out;
        let pool = |real, virtual_quote, target, state| on_curve(pool_bytes(Pubkey::default(), 0, TOKEN_PROGRAM), real, virtual_quote, target, state);

        // just opened, no real quote at all: buys are routed, no sell can be paid
        let c = chain(pool(0, VIRTUAL, TARGET, state::CURVE_OPEN), vec![]);
        let a = amm(&c);
        assert!(a.is_active() && a.routable(true) && !a.routable(false) && !a.unidirectional());
        assert_eq!(a.get_accounts_to_update(), vec![POOL, platform_address()], "the curve needs no account more");
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, curve(true, 1_000_000_000, 0));
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, seeded(true, 1_000_000_000, VIRTUAL), "the price of a seeded pool that holds the 30 SOL for real");
        assert!(sell(&a, 5_000_000).is_err());
        // the swap is the same seventeen accounts: nothing is added for the curve
        let (user, coins, sol, jupiter) = (Pubkey::new_from_array([50; 32]), Pubkey::new_from_array([51; 32]), Pubkey::new_from_array([52; 32]), Pubkey::new_from_array([53; 32]));
        assert_eq!(a.get_swap_and_account_metas(&swap_params(QUOTE, BASE, sol, coins, user, &jupiter)).unwrap().account_metas.len(), 17);
        // the old rule still holds where there is no virtual quote: an empty seeded pool is not offered
        assert!(!amm(&chain(pool(0, 0, 0, state::CURVE_NONE), vec![])).is_active());

        // 2 SOL raised: a sell is paid from the 2 SOL, up to all of it and never more
        let raised = 2_000_000_000u64;
        let c = chain(pool(raised, VIRTUAL, TARGET, state::CURVE_OPEN), vec![]);
        let a = amm(&c);
        assert!(a.routable(true) && a.routable(false));
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, curve(true, 1_000_000_000, raised));
        assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, curve(false, 5_000_000, raised));
        let (mut lo, mut hi) = (5_000_000u64, RESERVE_BASE);
        assert!(sell(&a, lo).is_ok() && sell(&a, hi).is_err());
        while lo + 1 < hi {
            let mid = lo + (hi - lo) / 2;
            if sell(&a, mid).is_ok() { lo = mid } else { hi = mid }
        }
        let edge = math::quote_swap(false, lo, RESERVE_BASE, raised, VIRTUAL, LP_FEE, PROTOCOL_FEE, 0, None).unwrap();
        assert_eq!(edge.amount_out_gross, raised, "the largest sell quoted takes the whole real reserve, gross");
        assert_eq!(edge.reserve_out_after, 0);
        assert!(sell(&a, hi).is_err(), "one unit more is not quoted");

        // past the target and not graduated yet: still on the curve, so the quote is the curve's
        let c = chain(pool(TARGET + 1, VIRTUAL, TARGET, state::CURVE_OPEN), vec![]);
        assert_eq!(buy(&amm(&c), 1_000_000_000).unwrap().out_amount, curve(true, 1_000_000_000, TARGET + 1));
        // graduated: no virtual quote any more, quoted on the real reserves like any pool
        let c = chain(pool(TARGET, 0, 0, state::CURVE_GRADUATED), vec![]);
        let a = amm(&c);
        assert!(a.routable(true) && a.routable(false));
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, seeded(true, 1_000_000_000, TARGET));
        assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, seeded(false, 5_000_000, TARGET));

        // a curve state this build does not know, or a virtual quote that cannot be added up: not offered
        assert!(!amm(&chain(pool(raised, VIRTUAL, TARGET, 3), vec![])).is_active());
        assert!(!amm(&chain(pool(raised, u64::MAX, TARGET, state::CURVE_OPEN), vec![])).is_active());
    }

    #[test]
    fn a_template_on_the_curve_takes_its_fee_and_the_virtual_quote_together() {
        let flags = BEFORE_SWAP | (1 << 6) | (1 << 9) | CALL_ON_BUY | CALL_ON_SELL;
        let metas = (pda(&[b"extra-metas"], &HOOK_TAX), account(HOOK_TAX, config_list()));
        let cfg = (hook_config_address(&HOOK_TAX, &POOL), account(HOOK_TAX, tax_config(300, 500)));
        let raised = 3_000_000_000u64;
        let c = chain(on_curve(pool_bytes(HOOK_TAX, flags, TOKEN_PROGRAM), raised, VIRTUAL, TARGET, state::CURVE_OPEN), vec![metas, cfg]);
        let a = amm(&c);
        assert!(a.is_active() && a.routable(true) && a.routable(false));
        let expect = |is_buy, amount, bps| math::quote_swap(is_buy, amount, RESERVE_BASE, raised, VIRTUAL, LP_FEE, PROTOCOL_FEE, bps, None).unwrap().amount_out;
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, expect(true, 1_000_000_000, 300));
        assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, expect(false, 5_000_000, 500));
        assert_eq!(buy(&a, 1_000_000_000).unwrap().fee_pct, Decimal::new(20 + 100 + 300, 4), "the curve adds no fee");
    }

    #[test]
    fn nothing_is_offered_before_the_platform_is_read_or_while_it_is_paused() {
        let mut c = chain(pool_bytes(Pubkey::default(), 0, TOKEN_PROGRAM), vec![]);
        let keyed = KeyedAccount { key: POOL, account: c.0[&POOL].clone(), params: None };
        let fresh = ProgrammableAmm::from_keyed_account(&keyed, &AmmContext::default()).unwrap();
        assert!(!fresh.is_active(), "not updated yet");
        c.0.insert(platform_address(), account(HOOKPOOL_PROGRAM, platform_bytes(true, 1_000)));
        let a = amm(&c);
        assert!(!a.is_active());
        assert!(buy(&a, 1_000_000_000).is_err() && sell(&a, 5_000_000).is_err());
        // an account at the platform's address that the pool program does not own is not the platform
        c.0.insert(platform_address(), account(CUSTOM_HOOK, platform_bytes(false, 1_000)));
        assert!(!amm(&c).is_active());
    }

    #[test]
    fn an_unknown_hook_is_routed_only_where_the_pool_never_calls_it() {
        // called on buys and on sells: nothing can be quoted
        let c = chain(pool_bytes(CUSTOM_HOOK, BEFORE_SWAP | CALL_ON_BUY | CALL_ON_SELL, TOKEN_PROGRAM), vec![]);
        let a = amm(&c);
        assert_eq!(a.hook_kind(), HookKind::Other);
        assert!(!a.is_active() && !a.unidirectional());
        assert!(buy(&a, 1_000_000_000).is_err() && sell(&a, 5_000_000).is_err());

        // called on buys only: sells are plain curve math, and the market is one-way, coin to quote
        let c = chain(pool_bytes(CUSTOM_HOOK, BEFORE_SWAP | AFTER_SWAP | CALL_ON_BUY, TOKEN_PROGRAM), vec![]);
        let a = amm(&c);
        assert!(a.is_active() && a.unidirectional());
        assert_eq!(a.get_reserve_mints(), vec![BASE, QUOTE]);
        assert!(buy(&a, 1_000_000_000).is_err());
        assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, plain(false, 5_000_000));

        // called on sells only: buys are plain curve math, and the first mint is the quote
        let c = chain(pool_bytes(CUSTOM_HOOK, AFTER_SWAP | CALL_ON_SELL, TOKEN_PROGRAM), vec![]);
        let a = amm(&c);
        assert!(a.is_active() && a.unidirectional());
        assert_eq!(a.get_reserve_mints(), vec![QUOTE, BASE]);
        assert!(sell(&a, 5_000_000).is_err());
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, plain(true, 1_000_000_000));

        // a hook with no swap callback at all (it only watches liquidity): both ways
        let c = chain(pool_bytes(CUSTOM_HOOK, (1 << 2) | (1 << 6) | CALL_ON_BUY | CALL_ON_SELL, TOKEN_PROGRAM), vec![]);
        let a = amm(&c);
        assert!(a.is_active() && !a.unidirectional());
        assert!(buy(&a, 1_000_000_000).is_ok() && sell(&a, 5_000_000).is_ok());
    }

    #[test]
    fn a_template_is_quoted_from_its_config_and_not_without_it() {
        let flags = BEFORE_SWAP | (1 << 6) | (1 << 9) | CALL_ON_BUY | CALL_ON_SELL;
        let metas = (pda(&[b"extra-metas"], &HOOK_TAX), account(HOOK_TAX, config_list()));
        let cfg_key = hook_config_address(&HOOK_TAX, &POOL);

        // the list alone is not enough: the answer is in the config
        let c = chain(pool_bytes(HOOK_TAX, flags, TOKEN_PROGRAM), vec![metas.clone()]);
        let a = amm(&c);
        assert_eq!(a.get_accounts_to_update(), vec![POOL, platform_address(), metas.0, cfg_key]);
        assert!(!a.is_active());

        let c = chain(pool_bytes(HOOK_TAX, flags, TOKEN_PROGRAM), vec![metas.clone(), (cfg_key, account(HOOK_TAX, tax_config(300, 500)))]);
        let a = amm(&c);
        assert!(a.is_active());
        let expect = |is_buy, amount, bps| math::quote_swap(is_buy, amount, RESERVE_BASE, RESERVE_QUOTE, 0, LP_FEE, PROTOCOL_FEE, bps, None).unwrap().amount_out;
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, expect(true, 1_000_000_000, 300));
        assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, expect(false, 5_000_000, 500));

        // a tax above the platform's cap is clamped by the pool, so the quote clamps it too
        let c = chain(pool_bytes(HOOK_TAX, flags, TOKEN_PROGRAM), vec![metas.clone(), (cfg_key, account(HOOK_TAX, tax_config(2_500, 9_999)))]);
        let a = amm(&c);
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, expect(true, 1_000_000_000, 1_000));
        assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, expect(false, 5_000_000, 1_000));

        // a config some other program owns is not the hook's config
        let c = chain(pool_bytes(HOOK_TAX, flags, TOKEN_PROGRAM), vec![metas, (cfg_key, account(CUSTOM_HOOK, tax_config(0, 0)))]);
        assert!(!amm(&c).is_active());
    }

    #[test]
    fn the_launch_guard_follows_the_clock_on_buys_only() {
        let flags = BEFORE_SWAP | (1 << 6) | (1 << 8) | CALL_ON_BUY;
        let metas = (pda(&[b"extra-metas"], &HOOK_LAUNCH_GUARD), account(HOOK_LAUNCH_GUARD, config_list()));
        let cfg = (hook_config_address(&HOOK_LAUNCH_GUARD, &POOL), account(HOOK_LAUNCH_GUARD, guard_config(1_000, 300, 3_000)));
        let c = chain(pool_bytes(HOOK_LAUNCH_GUARD, flags, TOKEN_PROGRAM), vec![metas, cfg]);
        let expect = |fee: Option<u16>| math::quote_swap(true, 1_000_000_000, RESERVE_BASE, RESERVE_QUOTE, 0, LP_FEE, PROTOCOL_FEE, 0, fee).unwrap().amount_out;
        assert_eq!(buy(&amm_at(&c, 1_000), 1_000_000_000).unwrap().out_amount, expect(Some(3_000)));
        assert_eq!(buy(&amm_at(&c, 1_150), 1_000_000_000).unwrap().out_amount, expect(Some(1_550)));
        assert_eq!(buy(&amm_at(&c, 1_300), 1_000_000_000).unwrap().out_amount, expect(None));
        // the clock is shared: a later slot changes the next quote without an update
        let a = amm_at(&c, 1_000);
        a.clock.slot.store(1_299, Ordering::Relaxed);
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, expect(math::guard_fee(1_299, 1_000, 300, 3_000, LP_FEE)));
        // sells never see the guard
        assert_eq!(sell(&amm_at(&c, 1_000), 5_000_000).unwrap().out_amount, plain(false, 5_000_000));
    }

    #[test]
    fn a_coin_with_a_transfer_hook_is_left_out() {
        let mint = |ext: &[u8]| {
            let mut d = vec![0u8; 166];
            d[165] = 1;
            d.extend_from_slice(ext);
            account(TOKEN_2022_PROGRAM, d)
        };
        let mut hooked = vec![14u8, 0, 64, 0];
        hooked.extend_from_slice(&[0u8; 32]);
        hooked.extend_from_slice(HOOK_COLLECTIBLE.as_ref());

        // a Token-2022 coin is not offered until its mint has been read
        let c = chain(pool_bytes(Pubkey::default(), 0, TOKEN_2022_PROGRAM), vec![]);
        let a = amm(&c);
        assert_eq!(a.get_accounts_to_update(), vec![POOL, platform_address(), BASE]);
        assert!(!a.is_active());
        // without a transfer hook it is routed like any coin
        let c = chain(pool_bytes(Pubkey::default(), 0, TOKEN_2022_PROGRAM), vec![(BASE, mint(&[]))]);
        assert!(amm(&c).is_active());
        // with one it is not
        let c = chain(pool_bytes(Pubkey::default(), 0, TOKEN_2022_PROGRAM), vec![(BASE, mint(&hooked))]);
        let a = amm(&c);
        assert!(!a.is_active());
        assert!(buy(&a, 1_000_000_000).is_err() && sell(&a, 5_000_000).is_err());
    }

    #[test]
    fn the_hook_caller_is_one_address_per_hook_program() {
        let hooks = [Pubkey::default(), HOOK_TAX, HOOK_LAUNCH_GUARD, HOOK_BUYBACK, HOOK_COLLECTIBLE, HOOK_RULES, CUSTOM_HOOK];
        let callers: Vec<Pubkey> = hooks.iter().map(caller_address).collect();
        for (i, a) in callers.iter().enumerate() {
            assert_eq!(*a, Pubkey::find_program_address(&[b"caller", hooks[i].as_ref()], &HOOKPOOL_PROGRAM).0);
            assert!(callers[i + 1..].iter().all(|b| a != b), "two hook programs share a caller");
            // the address derived without a hook program fits no pool
            assert_ne!(*a, Pubkey::find_program_address(&[b"caller"], &HOOKPOOL_PROGRAM).0);
        }
        // a pool without a hook has the system program in its hook field: 32 zero bytes
        assert_eq!(callers[0], Pubkey::find_program_address(&[b"caller", &[0u8; 32]], &HOOKPOOL_PROGRAM).0);

        // each pool's swap names the caller of its own hook program, as account 12
        let (user, coins, sol, jupiter) = (Pubkey::new_from_array([50; 32]), Pubkey::new_from_array([51; 32]), Pubkey::new_from_array([52; 32]), Pubkey::new_from_array([53; 32]));
        let account_12 = |c: &Chain| amm(c).get_swap_and_account_metas(&swap_params(QUOTE, BASE, sol, coins, user, &jupiter)).unwrap().account_metas[12].pubkey;
        let c = chain(pool_bytes(Pubkey::default(), 0, TOKEN_PROGRAM), vec![]);
        assert_eq!(account_12(&c), callers[0]);
        let c = chain(pool_bytes(CUSTOM_HOOK, AFTER_SWAP | CALL_ON_SELL, TOKEN_PROGRAM), vec![]);
        assert_eq!(account_12(&c), caller_address(&CUSTOM_HOOK), "a third-party hook has a caller of its own");
        // and a hook's list that points at account 1 of a callback resolves to that same caller
        let mut value = 1u32.to_le_bytes().to_vec();
        let mut seeds = [0u8; 32];
        seeds[..4].copy_from_slice(&[1, 1, b'x', 3]);
        seeds[4] = 1; // the key of account 1, the hook caller
        value.push(1);
        value.extend_from_slice(&seeds);
        value.extend_from_slice(&[0, 0]);
        let mut list = extra::CALLBACK_TLV_DISC.to_vec();
        list.extend_from_slice(&(value.len() as u32).to_le_bytes());
        list.extend_from_slice(&value);
        let c = chain(pool_bytes(CUSTOM_HOOK, AFTER_SWAP | CALL_ON_SELL, TOKEN_PROGRAM), vec![(CUSTOM_METAS, account(CUSTOM_HOOK, list))]);
        let metas = amm(&c).get_swap_and_account_metas(&swap_params(QUOTE, BASE, sol, coins, user, &jupiter)).unwrap().account_metas;
        assert_eq!(metas[17].pubkey, Pubkey::find_program_address(&[b"x", caller_address(&CUSTOM_HOOK).as_ref()], &CUSTOM_HOOK).0);
    }

    #[test]
    fn a_buyback_pool_is_quoted_from_its_config_and_passes_it_writable() {
        let flags = BEFORE_SWAP | (1 << 6) | (1 << 9) | CALL_ON_BUY | CALL_ON_SELL;
        let metas = (pda(&[b"extra-metas"], &HOOK_BUYBACK), account(HOOK_BUYBACK, config_list_of(true)));
        let cfg_key = hook_config_address(&HOOK_BUYBACK, &POOL);
        let c = chain(pool_bytes(HOOK_BUYBACK, flags, TOKEN_PROGRAM), vec![metas.clone(), (cfg_key, account(HOOK_BUYBACK, buyback_config(200, 300)))]);
        let a = amm(&c);
        assert_eq!(a.hook_kind(), HookKind::Buyback);
        assert!(a.is_active());
        let expect = |is_buy, amount, bps| math::quote_swap(is_buy, amount, RESERVE_BASE, RESERVE_QUOTE, 0, LP_FEE, PROTOCOL_FEE, bps, None).unwrap().amount_out;
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, expect(true, 1_000_000_000, 200));
        assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, expect(false, 5_000_000, 300));
        // the hook lowers its observation of the pool in every swap: the config is writable, on buys and on sells
        let (user, coins, sol, jupiter) = (Pubkey::new_from_array([50; 32]), Pubkey::new_from_array([51; 32]), Pubkey::new_from_array([52; 32]), Pubkey::new_from_array([53; 32]));
        for (from, to, source, destination) in [(QUOTE, BASE, sol, coins), (BASE, QUOTE, coins, sol)] {
            let m = a.get_swap_and_account_metas(&swap_params(from, to, source, destination, user, &jupiter)).unwrap().account_metas;
            assert_eq!(m.len(), 18);
            assert_eq!((m[17].pubkey, m[17].is_writable, m[17].is_signer), (cfg_key, true, false));
            assert_eq!(m[12].pubkey, caller_address(&HOOK_BUYBACK));
        }
    }

    #[test]
    fn a_rules_pool_is_quoted_from_its_config_and_the_clock() {
        // the flags of the template: 13,125
        let flags = BEFORE_SWAP | (1 << 2) | (1 << 6) | (1 << 8) | (1 << 9) | CALL_ON_BUY | CALL_ON_SELL;
        assert_eq!(flags, 13_125);
        let metas = (pda(&[b"extra-metas"], &HOOK_RULES), account(HOOK_RULES, config_list_of(true)));
        let cfg_key = hook_config_address(&HOOK_RULES, &POOL);
        // a sniper fee of 30% for 100 slots, a buy limit of 2 SOL for 150 slots, both from slot 1,000;
        // buys pay 0.5% + 1% + 0.25%, sells 1% + 2% + 0.75%
        let rules = rules_config((100, 3_000), [50, 100, 25], [100, 200, 75], (2_000_000_000, 150), 1_000);
        let with = |cfg: Vec<u8>| chain(pool_bytes(HOOK_RULES, flags, TOKEN_PROGRAM), vec![metas.clone(), (cfg_key, account(HOOK_RULES, cfg))]);
        let c = with(rules.clone());
        let expect = |is_buy, amount, hook_bps, fee: Option<u16>| math::quote_swap(is_buy, amount, RESERVE_BASE, RESERVE_QUOTE, 0, LP_FEE, PROTOCOL_FEE, hook_bps, fee).unwrap().amount_out;

        let a = amm_at(&c, 5_000);
        assert_eq!(a.hook_kind(), HookKind::Rules);
        assert!(a.is_active() && a.routable(true) && a.routable(false) && !a.unidirectional());
        assert_eq!(a.get_accounts_to_update(), vec![POOL, platform_address(), metas.0, cfg_key]);
        assert_eq!(a.program_dependencies(), vec![(HOOK_RULES, "hook_rules".to_string())]);
        // after both windows: the three rates of the side, nothing else
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, expect(true, 1_000_000_000, 175, None));
        assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, expect(false, 5_000_000, 375, None));
        assert_eq!(buy(&a, 1_000_000_000).unwrap().fee_pct, Decimal::new(20 + 100 + 175, 4));
        assert_eq!(buy(&a, 50_000_000_000).unwrap().out_amount, expect(true, 50_000_000_000, 175, None), "the limit is over with its window");

        // inside the sniper window: the fee of the slot replaces the pool fee, on buys only
        for (slot, fee) in [(1_000u64, 3_000u16), (1_050, 1_550), (1_099, 129)] {
            let a = amm_at(&c, slot);
            assert_eq!(math::sniper_fee(slot, 1_000, 100, 3_000, LP_FEE), Some(fee));
            assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, expect(true, 1_000_000_000, 175, Some(fee)), "slot {slot}");
            assert_eq!(buy(&a, 1_000_000_000).unwrap().fee_pct, Decimal::new(20 + fee as i64 + 175, 4));
            assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, expect(false, 5_000_000, 375, None), "sells never pay the sniper fee");
        }
        assert_eq!(buy(&amm_at(&c, 1_100), 1_000_000_000).unwrap().out_amount, expect(true, 1_000_000_000, 175, None), "the first slot after the window");
        // the clock is shared: a later slot changes the next quote without an update
        let a = amm_at(&c, 1_000);
        a.clock.slot.store(1_050, Ordering::Relaxed);
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, expect(true, 1_000_000_000, 175, Some(1_550)));

        // the buy limit: a buy above it is an error, not a wrong quote, while its window runs
        for slot in [1_000u64, 1_120, 1_149] {
            let a = amm_at(&c, slot);
            assert!(buy(&a, 2_000_000_001).is_err(), "slot {slot}: one lamport above the limit");
            assert!(buy(&a, 2_000_000_000).is_ok(), "slot {slot}: exactly the limit");
            assert!(a.is_active() && a.routable(true), "the pool stays offered: smaller buys are quoted");
            assert!(sell(&a, 500_000_000_000).is_ok(), "sells are never limited");
        }
        assert!(buy(&amm_at(&c, 1_150), 2_000_000_001).is_ok(), "the first slot after the limit window");

        // rules without a sniper fee and without a limit: nothing depends on the clock
        let plain = with(rules_config((0, 0), [100, 0, 0], [100, 0, 0], (0, 0), 1_000));
        for slot in [1_000u64, 1_001, 9_999] {
            assert_eq!(buy(&amm_at(&plain, slot), 50_000_000_000).unwrap().out_amount, expect(true, 50_000_000_000, 100, None));
        }

        // three rates above the platform's cap are clamped by the pool, so the quote clamps them too
        let mut capped = with(rules.clone());
        capped.0.insert(platform_address(), account(HOOKPOOL_PROGRAM, platform_bytes(false, 150)));
        let a = amm_at(&capped, 5_000);
        assert_eq!(buy(&a, 1_000_000_000).unwrap().out_amount, expect(true, 1_000_000_000, 150, None));
        assert_eq!(sell(&a, 5_000_000).unwrap().out_amount, expect(false, 5_000_000, 150, None));

        // the config goes into the swap writable, and account 12 is the caller of the rules hook
        let (user, coins, sol, jupiter) = (Pubkey::new_from_array([50; 32]), Pubkey::new_from_array([51; 32]), Pubkey::new_from_array([52; 32]), Pubkey::new_from_array([53; 32]));
        let m = amm_at(&c, 5_000).get_swap_and_account_metas(&swap_params(QUOTE, BASE, sol, coins, user, &jupiter)).unwrap().account_metas;
        assert_eq!(m.len(), 18);
        assert_eq!((m[10].pubkey, m[12].pubkey), (HOOK_RULES, caller_address(&HOOK_RULES)));
        assert_eq!((m[17].pubkey, m[17].is_writable, m[17].is_signer), (cfg_key, true, false));

        // without its config, or with a config another program owns, the pool is not offered
        let c = chain(pool_bytes(HOOK_RULES, flags, TOKEN_PROGRAM), vec![metas.clone()]);
        assert!(!amm_at(&c, 5_000).is_active());
        let c = chain(pool_bytes(HOOK_RULES, flags, TOKEN_PROGRAM), vec![metas.clone(), (cfg_key, account(CUSTOM_HOOK, rules))]);
        let a = amm_at(&c, 5_000);
        assert!(!a.is_active() && buy(&a, 1_000_000_000).is_err() && sell(&a, 5_000_000).is_err());
    }

    #[test]
    fn the_swap_accounts_are_the_native_ones_in_order() {
        let (user, coins, sol, jupiter) = (Pubkey::new_from_array([50; 32]), Pubkey::new_from_array([51; 32]), Pubkey::new_from_array([52; 32]), Pubkey::new_from_array([53; 32]));
        let flags = BEFORE_SWAP | (1 << 6) | (1 << 9) | CALL_ON_BUY | CALL_ON_SELL;
        let metas = (pda(&[b"extra-metas"], &HOOK_TAX), account(HOOK_TAX, config_list()));
        let cfg_key = hook_config_address(&HOOK_TAX, &POOL);
        let c = chain(pool_bytes(HOOK_TAX, flags, TOKEN_PROGRAM), vec![metas.clone(), (cfg_key, account(HOOK_TAX, tax_config(300, 500)))]);
        let a = amm(&c);

        let buy = a.get_swap_and_account_metas(&swap_params(QUOTE, BASE, sol, coins, user, &jupiter)).unwrap();
        assert!(matches!(&buy.swap, Swap::Placeholder { data: Some(d) } if d[..] == [DIRECTION_BUY]));
        let keys: Vec<Pubkey> = buy.account_metas.iter().map(|m| m.pubkey).collect();
        assert_eq!(keys.len(), a.get_accounts_len());
        assert_eq!(keys[0], user);
        assert_eq!(keys[1..7], [platform_address(), POOL, BASE, QUOTE, Pubkey::new_from_array([3; 32]), Pubkey::new_from_array([4; 32])]);
        assert_eq!((keys[7], keys[8]), (coins, sol), "the coin account, then the quote account, whatever the direction");
        assert_eq!(keys[9], sol, "no hook treasury on this pool: the user's quote account stands in");
        assert_eq!(keys[10..17], [HOOK_TAX, metas.0, caller_address(&HOOK_TAX), TOKEN_PROGRAM, TOKEN_PROGRAM, event_authority_address(), HOOKPOOL_PROGRAM]);
        assert_eq!(keys[12], Pubkey::find_program_address(&[b"caller", HOOK_TAX.as_ref()], &HOOKPOOL_PROGRAM).0, "account 12 is the caller of the pool's own hook program");
        assert_eq!(keys[17], cfg_key);
        // one signer, the wallet that may spend the source account; the pool, the vaults and the token accounts are writable
        let flags: Vec<(bool, bool)> = buy.account_metas.iter().map(|m| (m.is_signer, m.is_writable)).collect();
        assert_eq!(flags[0], (true, false));
        assert!(flags[1..].iter().all(|f| !f.0));
        assert_eq!(flags.iter().map(|f| f.1).collect::<Vec<_>>(), [false, false, true, false, false, true, true, true, true, true, false, false, false, false, false, false, false, false]);

        let sell = a.get_swap_and_account_metas(&swap_params(BASE, QUOTE, coins, sol, user, &jupiter)).unwrap();
        assert!(matches!(&sell.swap, Swap::Placeholder { data: Some(d) } if d[..] == [DIRECTION_SELL]));
        assert_eq!((sell.account_metas[7].pubkey, sell.account_metas[8].pubkey), (coins, sol));
        assert!(a.get_swap_and_account_metas(&swap_params(BASE, BASE, coins, sol, user, &jupiter)).is_err());

        assert_eq!(swap_instruction_data(DIRECTION_SELL, 7, 9), [&SWAP_DISCRIMINATOR[..], &[1], &7u64.to_le_bytes(), &9u64.to_le_bytes()].concat());
    }
}
