use anchor_lang::prelude::*;

#[error_code]
pub enum HookpoolError {
    #[msg("platform is paused")]
    Paused,
    #[msg("only the platform admin can do this")]
    NotAdmin,
    #[msg("only the pending admin can accept")]
    NotPendingAdmin,
    #[msg("the signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("fee exceeds the allowed maximum")]
    FeeTooHigh,
    #[msg("whitelist holds at most 8 keys")]
    WhitelistTooLong,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("direction must be 0 (buy) or 1 (sell)")]
    BadDirection,
    #[msg("output below min_amount_out")]
    Slippage,
    #[msg("input above the maximum you allowed")]
    InputAboveMax,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("not enough liquidity in the pool")]
    InsufficientLiquidity,
    #[msg("initial liquidity too small")]
    InitialLiquidityTooSmall,
    #[msg("base and quote mint must differ")]
    SameMint,
    #[msg("mint has a Token-2022 extension the pool does not accept: only metadata, and a transfer hook that is the pool's own platform hook")]
    MintExtensionNotAllowed,
    #[msg("token program does not match the pool")]
    TokenProgramMismatch,
    #[msg("token account mint does not match")]
    TokenAccountMintMismatch,
    #[msg("token account owner does not match")]
    TokenAccountOwnerMismatch,
    #[msg("hook program is not executable")]
    HookNotExecutable,
    #[msg("hook program account could not be parsed")]
    InvalidHookProgramAccount,
    #[msg("hook program data account does not belong to the hook program")]
    HookProgramDataMismatch,
    #[msg("hook is upgradeable and its authority is not whitelisted")]
    HookNotFrozen,
    #[msg("hook program uses a loader the pool does not know")]
    UnknownLoader,
    #[msg("hook program does not match the pool")]
    HookProgramMismatch,
    #[msg("hook manifest address is wrong")]
    HookManifestAddress,
    #[msg("hook extra-metas address is wrong")]
    HookExtraMetasAddress,
    #[msg("hook extra-metas account must be owned by the hook program")]
    HookExtraMetasOwner,
    #[msg("hook extra accounts could not be resolved; pass them as remaining accounts")]
    HookExtraAccounts,
    #[msg("hook quote treasury must be a token account for the quote mint")]
    HookTreasuryInvalid,
    #[msg("hook quote treasury does not match the pool, or is not writable")]
    HookTreasuryMismatch,
    #[msg("hook quote treasury must be the associated token account of its owner")]
    HookTreasuryNotAta,
    #[msg("launch mint must have no mint authority and no freeze authority")]
    LaunchMintAuthority,
    #[msg("hook return data could not be decoded")]
    BadHookReturn,
    #[msg("hook used a power its flags do not grant")]
    HookPowerNotGranted,
    #[msg("hook fee or fee override above the platform cap")]
    HookFeeTooHigh,
    #[msg("hook curve output is zero or exceeds reserves")]
    HookCurveInvalid,
    #[msg("hook manifest flags require no treasury but one was given, or vice versa")]
    HookTreasuryFlagMismatch,
    #[msg("hook authority PDA does not match")]
    HookAuthorityMismatch,
    #[msg("pool has no hook")]
    NoHook,
    #[msg("program data account is wrong")]
    ProgramDataMismatch,
    #[msg("no fees to collect")]
    NothingToCollect,
    #[msg("a swap cannot spend from or pay out to the pool's own vault")]
    PayoutIsVault,
    #[msg("the coin of a pool must have no freeze authority: it could freeze the pool's vault")]
    BaseMintFreezable,
    // ---- the curve launch; appended so that no number above moves -----------------
    #[msg("curve launches are switched off on this platform")]
    CurveDisabled,
    #[msg("a curve pool must hold the whole supply and the mint must be closed")]
    CurveSupplyNotInPool,
    #[msg("liquidity opens at graduation")]
    CurveOpen,
    #[msg("a hook that owns the price curve cannot run a curve pool")]
    CurveHook,
    #[msg("the pool is not on the curve")]
    NotOnCurve,
    /// No longer returned by any instruction: `graduate` under the target succeeds and does
    /// nothing. Kept so that no number after it moves; `math::graduation` still holds it.
    #[msg("the pool has not reached its graduation target")]
    GraduationNotReached,
    #[msg("a sell cannot take more than the real reserve")]
    CurveRealReserve,
    #[msg("a pegged coin cannot open a pool on the curve")]
    CurvePegged,
    #[msg("the virtual quote is above u64::MAX / 4, or the graduation target is below a thousandth of it")]
    CurveSettingsOutOfBounds,
    // ---- the approved list (HOOKS.md section 6.1); appended so that no number above moves ----
    #[msg("this hook program is not on the platform's approved list")]
    HookNotApproved,
    #[msg("this hook program is already on the approved list")]
    HookAlreadyApproved,
    #[msg("the platform's own hooks need no approval: only a frozen hook can be approved")]
    HookApprovalNotNeeded,
    #[msg("the approved list is full")]
    TooManyApprovedHooks,
    #[msg("the approved list after the platform account cannot be read")]
    ApprovedListCorrupt,
}
