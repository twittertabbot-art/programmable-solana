use crate::approvals;
use crate::errors::HookpoolError;
use crate::events::{HookApprovalChanged, HookApprovalRequiredChanged, PlatformUpdated};
use crate::loader::classify_hook;
use crate::state::*;
use anchor_lang::prelude::*;
use hookpool_interface::{DEFAULT_CURVE_GRADUATION_TARGET, DEFAULT_CURVE_VIRTUAL_QUOTE, HOOK_KIND_FROZEN, PLATFORM_SEED};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitPlatformArgs {
    pub treasury: Pubkey,
    pub protocol_fee_bps: u16,
    pub max_lp_fee_bps: u16,
    pub max_hook_fee_bps: u16,
    pub max_fee_override_bps: u16,
    pub launch_fee_lamports: u64,
}

/// Every field is optional: `None` leaves the setting as it is. The curve launch's three
/// and then `hook_approval_required` were appended later; an encoding that ends before
/// them, as the earlier clients wrote it, is read as leaving them unchanged.
#[derive(AnchorSerialize, Clone, Debug, Default)]
pub struct UpdatePlatformArgs {
    pub treasury: Option<Pubkey>,
    pub protocol_fee_bps: Option<u16>,
    pub max_lp_fee_bps: Option<u16>,
    pub max_hook_fee_bps: Option<u16>,
    pub max_fee_override_bps: Option<u16>,
    pub launch_fee_lamports: Option<u64>,
    pub paused: Option<bool>,
    /// The curve launch. A virtual quote or a target of 0 switches curve launches off.
    pub curve_virtual_quote: Option<u64>,
    pub curve_graduation_target: Option<u64>,
    /// At most `HARD_MAX_GRADUATION_FEE_BPS`.
    pub curve_graduation_fee_bps: Option<u16>,
    /// The approved-list rule (HOOKS.md section 6.1).
    pub hook_approval_required: Option<bool>,
}

/// An optional field that may be missing altogether at the end of the encoding.
fn tail<T: AnchorDeserialize, R: std::io::Read>(reader: &mut R) -> std::io::Result<Option<T>> {
    let mut tag = [0u8; 1];
    if reader.read(&mut tag)? == 0 {
        return Ok(None);
    }
    match tag[0] {
        0 => Ok(None),
        1 => Ok(Some(T::deserialize_reader(reader)?)),
        _ => Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "option tag")),
    }
}

impl AnchorDeserialize for UpdatePlatformArgs {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        Ok(Self {
            treasury: Option::<Pubkey>::deserialize_reader(reader)?,
            protocol_fee_bps: Option::<u16>::deserialize_reader(reader)?,
            max_lp_fee_bps: Option::<u16>::deserialize_reader(reader)?,
            max_hook_fee_bps: Option::<u16>::deserialize_reader(reader)?,
            max_fee_override_bps: Option::<u16>::deserialize_reader(reader)?,
            launch_fee_lamports: Option::<u64>::deserialize_reader(reader)?,
            paused: Option::<bool>::deserialize_reader(reader)?,
            curve_virtual_quote: tail(reader)?,
            curve_graduation_target: tail(reader)?,
            curve_graduation_fee_bps: tail(reader)?,
            hook_approval_required: tail(reader)?,
        })
    }
}

/// One-time setup. Only the program's current upgrade authority can run it, so
/// nobody can front-run the deploy and make themselves admin.
#[derive(Accounts)]
pub struct InitPlatform<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Platform::INIT_SPACE,
        seeds = [PLATFORM_SEED],
        bump
    )]
    pub platform: Account<'info, Platform>,
    /// CHECK: must be this program's ProgramData account; parsed in the handler.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_platform(ctx: Context<InitPlatform>, args: InitPlatformArgs) -> Result<()> {
    hookpool_interface::require_upgrade_authority(
        &crate::ID,
        &ctx.accounts.program_data.to_account_info(),
        &ctx.accounts.admin.key(),
    )?;
    check_caps(
        args.protocol_fee_bps,
        args.max_lp_fee_bps,
        args.max_hook_fee_bps,
        args.max_fee_override_bps,
        0,
    )?;

    let p = &mut ctx.accounts.platform;
    p.bump = ctx.bumps.platform;
    p.admin = ctx.accounts.admin.key();
    p.pending_admin = Pubkey::default();
    p.treasury = args.treasury;
    p.protocol_fee_bps = args.protocol_fee_bps;
    p.max_lp_fee_bps = args.max_lp_fee_bps;
    p.max_hook_fee_bps = args.max_hook_fee_bps;
    p.max_fee_override_bps = args.max_fee_override_bps;
    p.launch_fee_lamports = args.launch_fee_lamports;
    p.paused = false;
    p.whitelist_len = 0;
    p.whitelist = [Pubkey::default(); MAX_WHITELIST];
    p.pool_count = 0;
    // the curve launch: pump.fun's numbers, no fee
    p.curve_virtual_quote = DEFAULT_CURVE_VIRTUAL_QUOTE;
    p.curve_graduation_target = DEFAULT_CURVE_GRADUATION_TARGET;
    p.curve_graduation_fee_bps = 0;
    check_curve_settings(p.curve_virtual_quote, p.curve_graduation_target)?;
    emit_platform(p);
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump, has_one = admin @ HookpoolError::NotAdmin)]
    pub platform: Account<'info, Platform>,
}

pub fn handle_update_platform(ctx: Context<AdminOnly>, args: UpdatePlatformArgs) -> Result<()> {
    let p = &mut ctx.accounts.platform;
    if let Some(t) = args.treasury {
        p.treasury = t;
    }
    if let Some(v) = args.protocol_fee_bps {
        p.protocol_fee_bps = v;
    }
    if let Some(v) = args.max_lp_fee_bps {
        p.max_lp_fee_bps = v;
    }
    if let Some(v) = args.max_hook_fee_bps {
        p.max_hook_fee_bps = v;
    }
    if let Some(v) = args.max_fee_override_bps {
        p.max_fee_override_bps = v;
    }
    if let Some(v) = args.launch_fee_lamports {
        p.launch_fee_lamports = v;
    }
    if let Some(v) = args.paused {
        p.paused = v;
    }
    if let Some(v) = args.curve_virtual_quote {
        p.curve_virtual_quote = v;
    }
    if let Some(v) = args.curve_graduation_target {
        p.curve_graduation_target = v;
    }
    if let Some(v) = args.curve_graduation_fee_bps {
        p.curve_graduation_fee_bps = v;
    }
    if let Some(v) = args.hook_approval_required {
        if v != p.hook_approval_required {
            p.hook_approval_required = v;
            emit!(HookApprovalRequiredChanged { required: v });
        }
    }
    check_caps(
        p.protocol_fee_bps,
        p.max_lp_fee_bps,
        p.max_hook_fee_bps,
        p.max_fee_override_bps,
        p.curve_graduation_fee_bps,
    )?;
    check_curve_settings(p.curve_virtual_quote, p.curve_graduation_target)?;
    emit_platform(p);
    Ok(())
}

/// The bounds of the curve settings. The virtual quote leaves room for the real reserve
/// next to it in 64 bits (at most u64::MAX / 4, so `effective_quote` can never overflow on
/// any pool created with it). When curve launches are on (both values non-zero) the target
/// is at least a thousandth of the virtual quote, so that a pool can always graduate with
/// coins left in it. Either value at 0 switches curve launches off and passes.
pub fn check_curve_settings(virtual_quote: u64, graduation_target: u64) -> Result<()> {
    require!(virtual_quote <= u64::MAX / 4, HookpoolError::CurveSettingsOutOfBounds);
    if virtual_quote > 0 && graduation_target > 0 {
        require!(graduation_target >= virtual_quote / 1_000, HookpoolError::CurveSettingsOutOfBounds);
    }
    Ok(())
}

pub fn handle_set_whitelist(ctx: Context<AdminOnly>, keys: Vec<Pubkey>) -> Result<()> {
    require!(keys.len() <= MAX_WHITELIST, HookpoolError::WhitelistTooLong);
    let p = &mut ctx.accounts.platform;
    p.whitelist = [Pubkey::default(); MAX_WHITELIST];
    for (i, k) in keys.iter().enumerate() {
        p.whitelist[i] = *k;
    }
    p.whitelist_len = keys.len() as u8;
    emit_platform(p);
    Ok(())
}

// ---- the approved list (HOOKS.md section 6.1) ------------------------------------------

#[derive(Accounts)]
pub struct ApproveHook<'info> {
    /// Pays the rent of the platform account's growth by one entry.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump, has_one = admin @ HookpoolError::NotAdmin)]
    pub platform: Account<'info, Platform>,
    /// CHECK: the hook program to approve; it must be frozen, checked by `classify_hook`.
    pub hook_program: UncheckedAccount<'info>,
    /// CHECK: its loader state (ProgramData for loader v3), checked by `classify_hook`.
    pub hook_program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Puts a frozen hook program on the approved list. Only a frozen program can be approved:
/// its code can never change after the review. The platform's own hooks (run by a
/// whitelisted authority) need no approval and are refused here.
pub fn handle_approve_hook(ctx: Context<ApproveHook>) -> Result<()> {
    let a = &ctx.accounts;
    let kind = classify_hook(
        &a.hook_program.to_account_info(),
        &a.hook_program_data.to_account_info(),
        a.platform.whitelist(),
    )?;
    require!(kind == HOOK_KIND_FROZEN, HookpoolError::HookApprovalNotNeeded);
    let program = a.hook_program.key();
    let n = approvals::add(
        &a.platform.to_account_info(),
        &a.admin.to_account_info(),
        &a.system_program.to_account_info(),
        &program,
    )?;
    emit!(HookApprovalChanged { program, approved: true, count: n as u32 });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeHook<'info> {
    /// Receives the rent the shorter platform account no longer needs.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump, has_one = admin @ HookpoolError::NotAdmin)]
    pub platform: Account<'info, Platform>,
}

/// Takes a program off the approved list. Pools already open on it keep their hook and keep
/// trading: a pool's hook is fixed at its creation. Only new pools are refused.
pub fn handle_revoke_hook(ctx: Context<RevokeHook>, program: Pubkey) -> Result<()> {
    let a = &ctx.accounts;
    let n = approvals::remove(&a.platform.to_account_info(), &a.admin.to_account_info(), &program)?;
    emit!(HookApprovalChanged { program, approved: false, count: n as u32 });
    Ok(())
}

pub fn handle_transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.platform.pending_admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let p = &mut ctx.accounts.platform;
    require_keys_eq!(
        p.pending_admin,
        ctx.accounts.new_admin.key(),
        HookpoolError::NotPendingAdmin
    );
    p.admin = p.pending_admin;
    p.pending_admin = Pubkey::default();
    emit_platform(p);
    Ok(())
}

fn check_caps(protocol: u16, lp: u16, hook: u16, over: u16, graduation: u16) -> Result<()> {
    require!(protocol <= HARD_MAX_PROTOCOL_FEE_BPS, HookpoolError::FeeTooHigh);
    require!(lp <= HARD_MAX_LP_FEE_BPS, HookpoolError::FeeTooHigh);
    require!(hook <= HARD_MAX_HOOK_FEE_BPS, HookpoolError::FeeTooHigh);
    require!(over <= HARD_MAX_FEE_OVERRIDE_BPS, HookpoolError::FeeTooHigh);
    require!(graduation <= HARD_MAX_GRADUATION_FEE_BPS, HookpoolError::FeeTooHigh);
    Ok(())
}

fn emit_platform(p: &Platform) {
    emit!(PlatformUpdated {
        admin: p.admin,
        treasury: p.treasury,
        protocol_fee_bps: p.protocol_fee_bps,
        max_lp_fee_bps: p.max_lp_fee_bps,
        max_hook_fee_bps: p.max_hook_fee_bps,
        max_fee_override_bps: p.max_fee_override_bps,
        launch_fee_lamports: p.launch_fee_lamports,
        paused: p.paused,
        whitelist: p.whitelist().to_vec(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_encoding_without_the_curve_fields_leaves_them_unchanged() {
        // the seven fields of the first version, as the first clients encode them
        let mut old = Vec::new();
        for byte in [0u8, 0, 0, 0, 0] {
            old.push(byte); // treasury .. max_fee_override_bps: None
        }
        old.push(1);
        old.extend_from_slice(&7_000_000u64.to_le_bytes()); // launch fee
        old.push(1);
        old.push(1); // paused: true
        let a = UpdatePlatformArgs::deserialize(&mut &old[..]).unwrap();
        assert_eq!((a.launch_fee_lamports, a.paused), (Some(7_000_000), Some(true)));
        assert_eq!((a.curve_virtual_quote, a.curve_graduation_target, a.curve_graduation_fee_bps), (None, None, None));

        // the full encoding, through the derived serializer, round-trips
        let full = UpdatePlatformArgs {
            curve_virtual_quote: Some(1),
            curve_graduation_target: Some(2),
            curve_graduation_fee_bps: Some(3),
            paused: Some(false),
            ..Default::default()
        };
        let mut bytes = Vec::new();
        full.serialize(&mut bytes).unwrap();
        let back = UpdatePlatformArgs::deserialize(&mut &bytes[..]).unwrap();
        assert_eq!((back.curve_virtual_quote, back.curve_graduation_target, back.curve_graduation_fee_bps, back.paused), (Some(1), Some(2), Some(3), Some(false)));
        // a bad option tag is still an error
        let mut bad = old.clone();
        bad.push(7);
        assert!(UpdatePlatformArgs::deserialize(&mut &bad[..]).is_err());
    }

    #[test]
    fn an_encoding_without_the_approval_rule_leaves_it_unchanged() {
        // what the clients before the approved list send: every field up to the curve's
        let before = UpdatePlatformArgs {
            paused: Some(true),
            curve_virtual_quote: Some(1),
            curve_graduation_target: Some(2),
            curve_graduation_fee_bps: Some(3),
            ..Default::default()
        };
        let mut bytes = Vec::new();
        before.serialize(&mut bytes).unwrap();
        bytes.pop(); // the derived serializer writes the new field's None tag: drop it
        let a = UpdatePlatformArgs::deserialize(&mut &bytes[..]).unwrap();
        assert_eq!((a.paused, a.curve_graduation_fee_bps, a.hook_approval_required), (Some(true), Some(3), None));

        // switched on, and off, through the full encoding
        for v in [true, false] {
            let args = UpdatePlatformArgs { hook_approval_required: Some(v), ..Default::default() };
            let mut bytes = Vec::new();
            args.serialize(&mut bytes).unwrap();
            let back = UpdatePlatformArgs::deserialize(&mut &bytes[..]).unwrap();
            assert_eq!((back.hook_approval_required, back.paused, back.treasury), (Some(v), None, None));
        }
    }

    #[test]
    fn the_curve_settings_have_bounds() {
        assert!(check_curve_settings(DEFAULT_CURVE_VIRTUAL_QUOTE, DEFAULT_CURVE_GRADUATION_TARGET).is_ok());
        // off, in every way
        assert!(check_curve_settings(0, 0).is_ok());
        assert!(check_curve_settings(0, 5).is_ok());
        assert!(check_curve_settings(5, 0).is_ok());
        // the virtual quote: at most a quarter of u64, on or off
        assert!(check_curve_settings(u64::MAX / 4, u64::MAX / 4).is_ok());
        assert!(check_curve_settings(u64::MAX / 4 + 1, u64::MAX / 4).is_err());
        assert!(check_curve_settings(u64::MAX / 4 + 1, 0).is_err());
        // the target: at least a thousandth of the virtual quote when both are on
        assert!(check_curve_settings(30_000_000_000, 30_000_000).is_ok());
        assert!(check_curve_settings(30_000_000_000, 29_999_999).is_err());
        assert!(check_curve_settings(999, 1).is_ok(), "a thousandth of 999 is 0");
    }
}
