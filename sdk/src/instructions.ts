// Instruction builders. Account order mirrors the Rust Accounts structs exactly.
import { AccountMeta, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Writer, concat } from "./borsh.js";
import { IX } from "./generated.js";
import { ATA_PROGRAM, METAPLEX_METADATA, PROGRAMS, RENT_SYSVAR, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./constants.js";
import { pda } from "./pda.js";
import { RulesArgs, RulesRates, StrictArgs, rulesPda } from "./rules.js";

const ro =(pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const sig = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });
const sigw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });
const data = (disc: number[], w?: Writer) => concat(Uint8Array.from(disc), w ? w.toBytes() : new Uint8Array(0));
/// The two accounts Anchor's event CPI appends to an instruction.
const eventCpi = (program: PublicKey): AccountMeta[] => [ro(pda.eventAuthority(program)), ro(program)];

/// Everything a client needs to know about a pool's hook to build instructions.
export interface HookRef {
  program: PublicKey;
  /// Token account receiving hook fees; system program when none.
  treasury: PublicKey;
  /// Resolved extra accounts, appended as remaining accounts.
  extra: AccountMeta[];
}
export const NO_HOOK: HookRef = { program: SYSTEM_PROGRAM, treasury: SYSTEM_PROGRAM, extra: [] };

/// `fallbackWritable`: swaps need the treasury slot writable even when the hook takes no
/// fee, so a pool without a treasury gets the user's own quote account there.
function hookMetas(h: HookRef, fallbackWritable?: PublicKey) {
  const none = h.program.equals(SYSTEM_PROGRAM);
  const noTreasury = h.treasury.equals(SYSTEM_PROGRAM);
  return {
    program: h.program,
    programData: none ? SYSTEM_PROGRAM : pda.programData(h.program),
    manifest: none ? SYSTEM_PROGRAM : pda.manifest(h.program),
    extraMetas: none ? SYSTEM_PROGRAM : pda.extraMetas(h.program),
    treasury: h.treasury,
    treasuryMeta: noTreasury ? (fallbackWritable ? rw(fallbackWritable) : ro(h.treasury)) : rw(h.treasury),
  };
}

export interface PoolKeys {
  pool: PublicKey; baseMint: PublicKey; quoteMint: PublicKey; baseVault: PublicKey; quoteVault: PublicKey;
  lpMint: PublicKey; lpLock: PublicKey; baseTokenProgram: PublicKey; quoteTokenProgram: PublicKey;
}

export function poolKeys(baseMint: PublicKey, quoteMint: PublicKey, baseTokenProgram = TOKEN_PROGRAM, quoteTokenProgram = TOKEN_PROGRAM): PoolKeys {
  const pool = pda.pool(baseMint, quoteMint);
  return {
    pool, baseMint, quoteMint,
    baseVault: pda.vault(pool, baseMint), quoteVault: pda.vault(pool, quoteMint),
    lpMint: pda.lpMint(pool), lpLock: pda.lpLock(pool), baseTokenProgram, quoteTokenProgram,
  };
}

// ---- hookpool: platform ---------------------------------------------------------------

export interface InitPlatformArgs { treasury: PublicKey; protocolFeeBps: number; maxLpFeeBps: number; maxHookFeeBps: number; maxFeeOverrideBps: number; launchFeeLamports: bigint }
export function initPlatform(admin: PublicKey, a: InitPlatformArgs): TransactionInstruction {
  const w = new Writer().pubkey(a.treasury).u16(a.protocolFeeBps).u16(a.maxLpFeeBps).u16(a.maxHookFeeBps).u16(a.maxFeeOverrideBps).u64(a.launchFeeLamports);
  return new TransactionInstruction({
    programId: PROGRAMS.hookpool,
    keys: [sigw(admin), rw(pda.platform()), ro(pda.programData(PROGRAMS.hookpool)), ro(SYSTEM_PROGRAM)],
    data: data(IX.hookpool.init_platform, w),
  });
}

export interface UpdatePlatformArgs {
  treasury?: PublicKey; protocolFeeBps?: number; maxLpFeeBps?: number; maxHookFeeBps?: number; maxFeeOverrideBps?: number;
  launchFeeLamports?: bigint; paused?: boolean;
  /// The curve settings (appended; a field left out is left as it is). A virtual quote or a
  /// target of 0 switches curve launches off; the fee is at most
  /// `HARD_MAX_GRADUATION_FEE_BPS` (`FeeTooHigh` above). Running curves keep the settings
  /// they were created with.
  curveVirtualQuote?: bigint; curveGraduationTarget?: bigint; curveGraduationFeeBps?: number;
  /// The approved-list rule (appended after the curve's; HOOKS.md section 6.1). Left out, it
  /// stays as it is.
  hookApprovalRequired?: boolean;
}
/// Eleven borsh `Option`s in the order of `UpdatePlatformArgs`; a field left out is `None` (one
/// zero byte). The program also reads the older seven- and ten-field encodings.
export function updatePlatform(admin: PublicKey, a: UpdatePlatformArgs): TransactionInstruction {
  const w = new Writer()
    .option(a.treasury, (w, v) => w.pubkey(v))
    .option(a.protocolFeeBps, (w, v) => w.u16(v))
    .option(a.maxLpFeeBps, (w, v) => w.u16(v))
    .option(a.maxHookFeeBps, (w, v) => w.u16(v))
    .option(a.maxFeeOverrideBps, (w, v) => w.u16(v))
    .option(a.launchFeeLamports, (w, v) => w.u64(v))
    .option(a.paused, (w, v) => w.bool(v))
    .option(a.curveVirtualQuote, (w, v) => w.u64(v))
    .option(a.curveGraduationTarget, (w, v) => w.u64(v))
    .option(a.curveGraduationFeeBps, (w, v) => w.u16(v))
    .option(a.hookApprovalRequired, (w, v) => w.bool(v));
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: [sig(admin), rw(pda.platform())], data: data(IX.hookpool.update_platform, w) });
}
/// Admin: puts a FROZEN hook program on the approved list (HOOKS.md section 6.1). The admin
/// pays the rent of the platform account's growth by 32 bytes. `programData`: the program's
/// ProgramData (loader v3, the default here); for a program of another loader pass the
/// program itself.
export function approveHook(admin: PublicKey, program: PublicKey, programData: PublicKey = pda.programData(program)): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAMS.hookpool,
    keys: [sigw(admin), rw(pda.platform()), ro(program), ro(programData), ro(SYSTEM_PROGRAM)],
    data: data(IX.hookpool.approve_hook),
  });
}
/// Admin: takes a program off the approved list; the rent the shorter account no longer
/// needs goes back to the admin. Pools already open on it are not touched.
export function revokeHook(admin: PublicKey, program: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: [sigw(admin), rw(pda.platform())], data: data(IX.hookpool.revoke_hook, new Writer().pubkey(program)) });
}
export function setWhitelist(admin: PublicKey, keys: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: [sig(admin), rw(pda.platform())], data: data(IX.hookpool.set_whitelist, new Writer().vecPubkeys(keys)) });
}
export function transferAdmin(admin: PublicKey, newAdmin: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: [sig(admin), rw(pda.platform())], data: data(IX.hookpool.transfer_admin, new Writer().pubkey(newAdmin)) });
}
export function acceptAdmin(newAdmin: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: [sig(newAdmin), rw(pda.platform())], data: data(IX.hookpool.accept_admin) });
}

// ---- hookpool: pools --------------------------------------------------------------------

export interface CreatePoolArgs { lpFeeBps: number; baseAmount: bigint; quoteAmount: bigint }
/// The 26 accounts of `create_pool`, which `create_curve_pool` shares.
function createPoolKeys(payer: PublicKey, authority: PublicKey, k: PoolKeys, hook: HookRef): AccountMeta[] {
  const h = hookMetas(hook);
  return [
    sigw(payer), sig(authority), rw(pda.platform()), ro(k.baseMint), ro(k.quoteMint), rw(k.pool), rw(k.baseVault), rw(k.quoteVault),
    rw(k.lpMint), rw(k.lpLock),
    rw(pda.ata(authority, k.baseMint, k.baseTokenProgram)), rw(pda.ata(authority, k.quoteMint, k.quoteTokenProgram)), rw(pda.ata(authority, k.lpMint)),
    ro(h.program), ro(h.programData), ro(h.manifest), ro(h.extraMetas), ro(h.treasury), ro(pda.caller(h.program)[0]),
    ro(k.baseTokenProgram), ro(k.quoteTokenProgram), ro(TOKEN_PROGRAM), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM),
    ...eventCpi(PROGRAMS.hookpool),
    ...hook.extra,
  ];
}
export function createPool(payer: PublicKey, authority: PublicKey, k: PoolKeys, hook: HookRef, a: CreatePoolArgs): TransactionInstruction {
  const w = new Writer().u16(a.lpFeeBps).u64(a.baseAmount).u64(a.quoteAmount);
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: createPoolKeys(payer, authority, k, hook), data: data(IX.hookpool.create_pool, w) });
}

/// A pool on the curve, made directly (`create_curve_pool`): the same 26 accounts as
/// `create_pool`, no quote amount. `baseAmount` must be the mint's whole supply and the mint
/// must have no mint authority (`CurveSupplyNotInPool`); the platform's curve settings must
/// be on (`CurveDisabled`); the hook must not own the price curve (`CurveHook`). The real
/// quote reserve starts at 0 and the whole LP, `curveInitialLp(baseAmount, virtualQuote)`,
/// is minted into the pool's lock account: the creator receives none. The authority's quote
/// account must exist although nothing is taken from it (a wrapped SOL account for SOL).
export interface CreateCurvePoolArgs { lpFeeBps: number; baseAmount: bigint }
export function createCurvePool(payer: PublicKey, authority: PublicKey, k: PoolKeys, hook: HookRef, a: CreateCurvePoolArgs): TransactionInstruction {
  const w = new Writer().u16(a.lpFeeBps).u64(a.baseAmount);
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: createPoolKeys(payer, authority, k, hook), data: data(IX.hookpool.create_curve_pool, w) });
}

/// Graduate a pool on the curve: permissionless, no signer but the fee payer of the
/// transaction, no hook callback, no treasury. Allowed once the real quote reserve has
/// reached the pool's target (`GraduationNotReached` before; `NotOnCurve` on a seeded pool
/// or a second time; `Paused` while the platform is paused). It drops the virtual quote,
/// moves the platform's share of the target out of the reserve into `protocolFeesQuote`,
/// and burns from the pool's own vault the coins that keep the price (`graduation`).
/// About 20,000 compute units: the default budget is enough.
export function graduate(k: PoolKeys): TransactionInstruction {
  const keys: AccountMeta[] = [ro(pda.platform()), rw(k.pool), rw(k.baseMint), rw(k.baseVault), ro(k.baseTokenProgram), ...eventCpi(PROGRAMS.hookpool)];
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys, data: data(IX.hookpool.graduate) });
}

/// `accounts`: the token accounts of the trade, when they are not the user's own associated
/// ones. `user` must be able to spend the account the coins leave (its owner, or a
/// delegate). The account that receives may belong to anyone.
export function swap(
  user: PublicKey, k: PoolKeys, hook: HookRef, direction: number, amountIn: bigint, minAmountOut: bigint,
  accounts: { base?: PublicKey; quote?: PublicKey } = {},
): TransactionInstruction {
  const userQuote = pda.ata(user, k.quoteMint, k.quoteTokenProgram);
  const h = hookMetas(hook, userQuote);
  const keys: AccountMeta[] = [
    sigw(user), ro(pda.platform()), rw(k.pool), ro(k.baseMint), ro(k.quoteMint), rw(k.baseVault), rw(k.quoteVault),
    rw(accounts.base ?? pda.ata(user, k.baseMint, k.baseTokenProgram)), rw(accounts.quote ?? userQuote),
    h.treasuryMeta, ro(h.program), ro(h.extraMetas), ro(pda.caller(h.program)[0]), ro(k.baseTokenProgram), ro(k.quoteTokenProgram),
    ...eventCpi(PROGRAMS.hookpool),
    ...hook.extra,
  ];
  const w = new Writer().u8(direction).u64(amountIn).u64(minAmountOut);
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys, data: data(IX.hookpool.swap, w) });
}

function liquidityKeys(user: PublicKey, k: PoolKeys, hook: HookRef): AccountMeta[] {
  const h = hookMetas(hook);
  return [
    sigw(user), ro(pda.platform()), rw(k.pool), ro(k.baseMint), ro(k.quoteMint), rw(k.baseVault), rw(k.quoteVault), rw(k.lpMint),
    rw(pda.ata(user, k.baseMint, k.baseTokenProgram)), rw(pda.ata(user, k.quoteMint, k.quoteTokenProgram)), rw(pda.ata(user, k.lpMint)),
    ro(h.program), ro(h.extraMetas), ro(pda.caller(h.program)[0]), ro(k.baseTokenProgram), ro(k.quoteTokenProgram), ro(TOKEN_PROGRAM),
    ...eventCpi(PROGRAMS.hookpool),
    ...hook.extra,
  ];
}
export function addLiquidity(user: PublicKey, k: PoolKeys, hook: HookRef, lpAmount: bigint, maxBase: bigint, maxQuote: bigint): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: liquidityKeys(user, k, hook), data: data(IX.hookpool.add_liquidity, new Writer().u64(lpAmount).u64(maxBase).u64(maxQuote)) });
}
export function removeLiquidity(user: PublicKey, k: PoolKeys, hook: HookRef, lpAmount: bigint, minBase: bigint, minQuote: bigint): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: liquidityKeys(user, k, hook), data: data(IX.hookpool.remove_liquidity, new Writer().u64(lpAmount).u64(minBase).u64(minQuote)) });
}
/// `hookAccounts`: for a coin with a transfer hook, the hook's accounts for a transfer from
/// the pool to the treasury, and the hook program (see `collectible.peggedExtras`).
export function collectProtocolFees(payer: PublicKey, k: PoolKeys, treasury: PublicKey, hookAccounts: AccountMeta[] = []): TransactionInstruction {
  const keys: AccountMeta[] = [
    sigw(payer), ro(pda.platform()), rw(k.pool), ro(k.baseMint), ro(k.quoteMint), rw(k.baseVault), rw(k.quoteVault), ro(treasury),
    rw(pda.ata(treasury, k.baseMint, k.baseTokenProgram)), rw(pda.ata(treasury, k.quoteMint, k.quoteTokenProgram)),
    ro(k.baseTokenProgram), ro(k.quoteTokenProgram), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM),
    ...hookAccounts,
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys, data: data(IX.hookpool.collect_protocol_fees) });
}

/// Pay the hook fees that waited for a closed treasury. Anyone may send it; the money only
/// goes to the pool's own treasury, which must exist (create it first, see the client's
/// `hookFeesInstructions`).
export function collectHookFees(k: PoolKeys, treasury: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [rw(k.pool), ro(k.quoteMint), rw(k.quoteVault), rw(treasury), ro(k.quoteTokenProgram)];
  return new TransactionInstruction({ programId: PROGRAMS.hookpool, keys, data: data(IX.hookpool.collect_hook_fees) });
}

// ---- hooklaunch ---------------------------------------------------------------------------

export interface CreateTokenArgs { name: string; symbol: string; uri: string; decimals: number; totalSupply: bigint }
export function createToken(dev: PublicKey, mint: PublicKey, a: CreateTokenArgs): TransactionInstruction {
  const keys: AccountMeta[] = [
    sigw(dev), sigw(mint), rw(pda.ata(dev, mint)), rw(pda.metadata(mint)), ro(METAPLEX_METADATA), ro(TOKEN_PROGRAM), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM), ro(RENT_SYSVAR),
  ];
  const w = new Writer().string(a.name).string(a.symbol).string(a.uri).u8(a.decimals).u64(a.totalSupply);
  return new TransactionInstruction({ programId: PROGRAMS.hooklaunch, keys, data: data(IX.hooklaunch.create_token, w) });
}

/// A pegged coin: a Token-2022 mint whose transfer hook is `hookProgram` forever, with its
/// name, symbol and uri in the mint itself. Four instructions, in this order, in the
/// transaction that the mint keypair signs: the mint, the name written by the token
/// program (it only does that at the top level), the name made final, then the supply to
/// the dev and the end of the mint authority.
export function createPeggedToken(dev: PublicKey, mint: PublicKey, hookProgram: PublicKey, a: CreateTokenArgs): TransactionInstruction[] {
  const enc = new TextEncoder();
  const metadataLen = 4 + 32 + 32 + (4 + enc.encode(a.name).length) + (4 + enc.encode(a.symbol).length) + (4 + enc.encode(a.uri).length) + 4;
  const devAta = pda.ata(dev, mint, TOKEN_2022_PROGRAM);
  return [
    new TransactionInstruction({
      programId: PROGRAMS.hooklaunch,
      keys: [sigw(dev), sigw(mint), rw(devAta), ro(hookProgram), ro(TOKEN_2022_PROGRAM), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM)],
      data: data(IX.hooklaunch.create_pegged_mint, new Writer().u8(a.decimals).u16(metadataLen)),
    }),
    // spl-token-metadata-interface Initialize: metadata (the mint), update authority, mint, mint authority
    new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM,
      keys: [rw(mint), ro(dev), ro(mint), sig(dev)],
      data: data([210, 225, 30, 162, 88, 184, 77, 141], new Writer().string(a.name).string(a.symbol).string(a.uri)),
    }),
    // spl-token-metadata-interface UpdateAuthority to none: nobody can change the name again
    new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM,
      keys: [rw(mint), sig(dev)],
      data: data([215, 228, 166, 228, 84, 100, 86, 123], new Writer().pubkey(SYSTEM_PROGRAM)),
    }),
    new TransactionInstruction({
      programId: PROGRAMS.hooklaunch,
      keys: [sig(dev), rw(mint), rw(devAta), ro(TOKEN_2022_PROGRAM)],
      data: data(IX.hooklaunch.finish_pegged_token, new Writer().u64(a.totalSupply)),
    }),
  ];
}

export interface LaunchArgs { lpFeeBps: number; baseAmount: bigint; quoteAmount: bigint; devBuyQuote: bigint; minDevBuyOut: bigint }
/// The 29 accounts of `launch`, which `launch_curve` shares.
function launchKeys(dev: PublicKey, treasury: PublicKey, k: PoolKeys, hook: HookRef): AccountMeta[] {
  const h = hookMetas(hook, pda.ata(dev, k.quoteMint, k.quoteTokenProgram));
  return [
    sigw(dev), rw(pda.platform()), rw(treasury), rw(pda.launch(k.baseMint)), ro(k.baseMint), ro(k.quoteMint), rw(k.pool), rw(k.baseVault), rw(k.quoteVault),
    rw(k.lpMint), rw(k.lpLock), rw(pda.ata(dev, k.baseMint, k.baseTokenProgram)), rw(pda.ata(dev, k.quoteMint, k.quoteTokenProgram)), rw(pda.ata(dev, k.lpMint)),
    ro(h.program), ro(h.programData), ro(h.manifest), ro(h.extraMetas), h.treasuryMeta, ro(pda.caller(h.program)[0]), ro(PROGRAMS.hookpool), ro(pda.eventAuthority(PROGRAMS.hookpool)),
    ro(k.baseTokenProgram), ro(k.quoteTokenProgram), ro(TOKEN_PROGRAM), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM),
    ...eventCpi(PROGRAMS.hooklaunch),
    ...hook.extra,
  ];
}
export function launch(dev: PublicKey, treasury: PublicKey, k: PoolKeys, hook: HookRef, a: LaunchArgs): TransactionInstruction {
  const w = new Writer().u16(a.lpFeeBps).u64(a.baseAmount).u64(a.quoteAmount).u64(a.devBuyQuote).u64(a.minDevBuyOut);
  return new TransactionInstruction({ programId: PROGRAMS.hooklaunch, keys: launchKeys(dev, treasury, k, hook), data: data(IX.hooklaunch.launch, w) });
}

/// A launch on the curve (`launch_curve`): the same 29 accounts as `launch`; no base amount
/// (the mint's whole supply, which the dev's coin account must hold) and no quote amount
/// (the creator puts no SOL in). `devBuyQuote` 0 means no first buy; with one, the dev's
/// quote account pays it at the curve price. The launchpad refuses a mint with a mint or
/// freeze authority, a Token-2022 name that is not final, and a pegged collectible coin
/// (`CurvePegged`); the pool program's checks of `create_curve_pool` follow. No LP lock
/// step: every share is minted into the lock account by the pool.
export interface LaunchCurveArgs { lpFeeBps: number; devBuyQuote: bigint; minDevBuyOut: bigint }
export function launchCurve(dev: PublicKey, treasury: PublicKey, k: PoolKeys, hook: HookRef, a: LaunchCurveArgs): TransactionInstruction {
  const w = new Writer().u16(a.lpFeeBps).u64(a.devBuyQuote).u64(a.minDevBuyOut);
  return new TransactionInstruction({ programId: PROGRAMS.hooklaunch, keys: launchKeys(dev, treasury, k, hook), data: data(IX.hooklaunch.launch_curve, w) });
}

// ---- template hooks ----------------------------------------------------------------------

export function taxInitPoolConfig(payer: PublicKey, owner: PublicKey, pool: PublicKey, buyBps: number, sellBps: number, maxBps: number): TransactionInstruction {
  const keys = [sigw(payer), sig(owner), rw(pda.cfg(PROGRAMS.hook_tax, pool)), ro(SYSTEM_PROGRAM)];
  return new TransactionInstruction({ programId: PROGRAMS.hook_tax, keys, data: data(IX.hook_tax.init_pool_config, new Writer().pubkey(pool).u16(buyBps).u16(sellBps).u16(maxBps)) });
}
export function taxSetTax(owner: PublicKey, pool: PublicKey, buyBps: number, sellBps: number): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAMS.hook_tax, keys: [sig(owner), rw(pda.cfg(PROGRAMS.hook_tax, pool))], data: data(IX.hook_tax.set_tax, new Writer().u16(buyBps).u16(sellBps)) });
}
export function taxSetOwner(owner: PublicKey, pool: PublicKey, newOwner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAMS.hook_tax, keys: [sig(owner), rw(pda.cfg(PROGRAMS.hook_tax, pool))], data: data(IX.hook_tax.set_owner, new Writer().pubkey(newOwner)) });
}

export function guardInitPoolConfig(payer: PublicKey, pool: PublicKey, guardSlots: bigint, startFeeBps: number): TransactionInstruction {
  const keys = [sigw(payer), rw(pda.cfg(PROGRAMS.hook_launch_guard, pool)), ro(SYSTEM_PROGRAM)];
  return new TransactionInstruction({ programId: PROGRAMS.hook_launch_guard, keys, data: data(IX.hook_launch_guard.init_pool_config, new Writer().pubkey(pool).u64(guardSlots).u16(startFeeBps)) });
}

export function buybackInitPoolConfig(payer: PublicKey, pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, buyBps: number, sellBps: number, minQuote: bigint, baseTokenProgram = TOKEN_PROGRAM, quoteTokenProgram = TOKEN_PROGRAM): TransactionInstruction {
  const authority = pda.hookAuthority(pool, PROGRAMS.hook_buyback)[0];
  const keys: AccountMeta[] = [
    sigw(payer), rw(pda.cfg(PROGRAMS.hook_buyback, pool)), ro(authority), ro(baseMint), ro(quoteMint),
    rw(pda.ata(authority, quoteMint, quoteTokenProgram)), rw(pda.ata(authority, baseMint, baseTokenProgram)),
    ro(baseTokenProgram), ro(quoteTokenProgram), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_buyback, keys, data: data(IX.hook_buyback.init_pool_config, new Writer().pubkey(pool).u16(buyBps).u16(sellBps).u64(minQuote)) });
}
export function executeBuyback(payer: PublicKey, k: PoolKeys, minAmountOut: bigint): TransactionInstruction {
  const authority = pda.hookAuthority(k.pool, PROGRAMS.hook_buyback)[0];
  const keys: AccountMeta[] = [
    sig(payer), rw(pda.cfg(PROGRAMS.hook_buyback, k.pool)), ro(authority), ro(pda.platform()), rw(k.pool), rw(k.baseMint), ro(k.quoteMint),
    rw(k.baseVault), rw(k.quoteVault), rw(pda.ata(authority, k.quoteMint, k.quoteTokenProgram)), rw(pda.ata(authority, k.baseMint, k.baseTokenProgram)),
    ro(PROGRAMS.hookpool), ro(pda.eventAuthority(PROGRAMS.hookpool)), ro(k.baseTokenProgram), ro(k.quoteTokenProgram),
    ...eventCpi(PROGRAMS.hook_buyback),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_buyback, keys, data: data(IX.hook_buyback.execute_buyback, new Writer().u64(minAmountOut)) });
}

// ---- hook_rules ("launch rules" template). RULES.md lists every account in this order. ------

/// By the launcher, before the pool exists: writes the rules, once, and creates the
/// treasury, the burn account and the stake vault. `a` comes from `rulesArgs`; check it
/// with `rulesProblems` first, because the program refuses anything above its ceilings.
/// Whoever pays becomes the config's creator and must be the wallet that creates the pool.
export function rulesInitPoolConfig(payer: PublicKey, k: PoolKeys, a: RulesArgs): TransactionInstruction {
  const keys: AccountMeta[] = [
    sigw(payer), rw(rulesPda.cfg(k.pool)), ro(rulesPda.authority(k.pool)), ro(k.baseMint), ro(k.quoteMint),
    rw(rulesPda.treasury(k.pool, k.quoteMint, k.quoteTokenProgram)), rw(rulesPda.burnAccount(k.pool, k.baseMint, k.baseTokenProgram)), rw(rulesPda.stakeVault(k.pool)),
    ro(k.baseTokenProgram), ro(k.quoteTokenProgram), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM),
  ];
  const rates = (w: Writer, r: RulesRates) => w.u16(r.creatorBps).u16(r.holdersBps).u16(r.burnBps);
  const w = new Writer().pubkey(k.pool).u64(a.sniperSlots).u16(a.sniperStartFeeBps);
  rates(w, a.buy); rates(w, a.sell);
  w.u64(a.maxBuyQuote).u64(a.limitSlots).u64(a.creatorLockSeconds);
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.init_pool_config, w) });
}
/// Move coins from the wallet to the stake vault. Opens the wallet's stake record the first
/// time (the wallet pays its rent) and restarts the unstake delay of the whole record.
/// `from`: the token account the coins leave, when it is not the wallet's associated one.
export function rulesStake(staker: PublicKey, k: PoolKeys, amount: bigint, from?: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [
    sigw(staker), rw(rulesPda.cfg(k.pool)), ro(k.pool), rw(rulesPda.stake(k.pool, staker)), ro(k.baseMint), rw(rulesPda.stakeVault(k.pool)),
    rw(from ?? pda.ata(staker, k.baseMint, k.baseTokenProgram)), ro(k.baseTokenProgram), ro(SYSTEM_PROGRAM),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.stake, new Writer().u64(amount)) });
}
/// Move staked coins back. Refused until `UNSTAKE_DELAY_SLOTS` after the record's last
/// stake. `to`: the token account that receives, which must exist.
export function rulesUnstake(staker: PublicKey, k: PoolKeys, amount: bigint, to?: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [
    sig(staker), rw(rulesPda.cfg(k.pool)), ro(k.pool), rw(rulesPda.stake(k.pool, staker)), ro(k.baseMint), rw(rulesPda.stakeVault(k.pool)),
    rw(to ?? pda.ata(staker, k.baseMint, k.baseTokenProgram)), ro(k.baseTokenProgram),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.unstake, new Writer().u64(amount)) });
}
/// Pay the staker's rewards, in the quote token, to `to` (default: the staker's associated
/// token account for the quote mint, which must exist).
export function rulesClaimRewards(staker: PublicKey, k: PoolKeys, to?: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [
    sig(staker), rw(rulesPda.cfg(k.pool)), ro(k.pool), rw(rulesPda.stake(k.pool, staker)), ro(rulesPda.authority(k.pool)), ro(k.quoteMint),
    rw(rulesPda.treasury(k.pool, k.quoteMint, k.quoteTokenProgram)), rw(to ?? pda.ata(staker, k.quoteMint, k.quoteTokenProgram)), ro(k.quoteTokenProgram),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.claim_rewards) });
}
/// Pay the creator fee collected so far to `to` (default: the creator's associated token
/// account for the quote mint, which must exist). The signer must be the config's creator.
export function rulesClaimCreator(creator: PublicKey, k: PoolKeys, to?: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [
    sig(creator), rw(rulesPda.cfg(k.pool)), ro(k.pool), ro(rulesPda.authority(k.pool)), ro(k.quoteMint),
    rw(rulesPda.treasury(k.pool, k.quoteMint, k.quoteTokenProgram)), rw(to ?? pda.ata(creator, k.quoteMint, k.quoteTokenProgram)), ro(k.quoteTokenProgram),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.claim_creator) });
}
/// Buy the coin with the burn pot and burn what was bought. Anyone may send it. One run
/// every `BURN_INTERVAL_SLOTS`, and one run spends at most the pool's cap
/// (`rulesBurnCapBps`). The client's `rulesBurnInstructions` works out `minAmountOut`.
export function rulesRunBurn(payer: PublicKey, k: PoolKeys, minAmountOut: bigint): TransactionInstruction {
  const keys: AccountMeta[] = [
    sig(payer), rw(rulesPda.cfg(k.pool)), ro(rulesPda.authority(k.pool)), ro(pda.platform()), rw(k.pool), rw(k.baseMint), ro(k.quoteMint),
    rw(k.baseVault), rw(k.quoteVault), rw(rulesPda.treasury(k.pool, k.quoteMint, k.quoteTokenProgram)), rw(rulesPda.burnAccount(k.pool, k.baseMint, k.baseTokenProgram)),
    ro(PROGRAMS.hookpool), ro(pda.eventAuthority(PROGRAMS.hookpool)), ro(k.baseTokenProgram), ro(k.quoteTokenProgram),
    ...eventCpi(PROGRAMS.hook_rules),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.run_burn, new Writer().u64(minAmountOut)) });
}
/// Move coins from the creator's wallet to the lock vault, or move the date later. The
/// first call creates the lock record and the lock vault. `amount` = `LOCK_WHOLE_BALANCE`
/// locks everything the creator's coin account holds when the instruction runs; zero is
/// allowed once something is locked. `unlockAt` is a Unix time, in seconds.
/// `from`: the token account the coins leave, when it is not the creator's associated one.
export function rulesLockCreator(creator: PublicKey, k: PoolKeys, amount: bigint, unlockAt: bigint, from?: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [
    sigw(creator), ro(rulesPda.cfg(k.pool)), rw(rulesPda.lock(k.pool)), ro(k.baseMint), rw(rulesPda.lockVault(k.pool)),
    rw(from ?? pda.ata(creator, k.baseMint, k.baseTokenProgram)), ro(k.baseTokenProgram), ro(SYSTEM_PROGRAM),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.lock_creator, new Writer().u64(amount).i64(unlockAt)) });
}
/// From the unlock time on: move everything in the lock vault to `to` (default: the
/// creator's associated token account for the coin, which must exist).
export function rulesUnlockCreator(creator: PublicKey, k: PoolKeys, to?: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [
    sig(creator), ro(rulesPda.cfg(k.pool)), rw(rulesPda.lock(k.pool)), ro(k.baseMint), rw(rulesPda.lockVault(k.pool)),
    rw(to ?? pda.ata(creator, k.baseMint, k.baseTokenProgram)), ro(k.baseTokenProgram),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.unlock_creator) });
}

// ---- hook_rules, strict coin (RULES.md, "Instructions of a strict coin") ----------------------
// The coin is a Token-2022 mint whose transfer hook is hook_rules: `k.baseTokenProgram` is
// TOKEN_2022_PROGRAM and a wallet's coin account is its associated token account under it.

/// A wallet's coin account on a strict coin: its associated token account under Token-2022.
const strictAta = (wallet: PublicKey, mint: PublicKey) => pda.ata(wallet, mint, TOKEN_2022_PROGRAM);

/// Bind a strict coin to its rules, in place of `rulesInitPoolConfig`, before the pool
/// exists. The coin's mint signs (in the transaction that created it). Creates the config,
/// the treasury and the coin's account list.
export function rulesInitStrictConfig(payer: PublicKey, k: PoolKeys, a: RulesArgs, s: StrictArgs): TransactionInstruction {
  const keys: AccountMeta[] = [
    sigw(payer), sig(k.baseMint), ro(k.quoteMint), rw(rulesPda.cfg(k.pool)), ro(rulesPda.authority(k.pool)),
    rw(rulesPda.treasury(k.pool, k.quoteMint, k.quoteTokenProgram)), rw(rulesPda.validation(k.baseMint)),
    ro(k.quoteTokenProgram), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM),
  ];
  const rates = (w: Writer, r: RulesRates) => w.u16(r.creatorBps).u16(r.holdersBps).u16(r.burnBps);
  const w = new Writer().pubkey(k.pool).u64(a.sniperSlots).u16(a.sniperStartFeeBps);
  rates(w, a.buy); rates(w, a.sell);
  w.u64(a.maxBuyQuote).u64(a.limitSlots).u64(a.creatorLockSeconds);
  w.u16(s.maxWalletBps).u32(s.maxWalletSlots).u16(s.earlySlots).u32(s.earlyUnlockSlots);
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.init_strict_config, w) });
}
/// Open the wallet's holder record with what its coin account holds now: from here on its
/// balance earns the holders' share. Signed and paid by the wallet (rent about 0.0013 SOL on mainnet,
/// back when the record is closed). Opening twice does nothing. Works before the pool exists.
export function rulesOpenHolder(wallet: PublicKey, k: PoolKeys): TransactionInstruction {
  const keys: AccountMeta[] = [
    sigw(wallet), rw(rulesPda.cfg(k.pool)), ro(k.pool), rw(rulesPda.holder(k.pool, wallet)), ro(strictAta(wallet, k.baseMint)), ro(SYSTEM_PROGRAM),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.open_holder) });
}
/// Pay what a holder record is owed, in the quote token, to `to` (default: the wallet's
/// associated token account for the quote mint, which must exist).
export function rulesClaimHolder(wallet: PublicKey, k: PoolKeys, to?: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [
    sig(wallet), rw(rulesPda.cfg(k.pool)), ro(k.pool), rw(rulesPda.holder(k.pool, wallet)), ro(rulesPda.authority(k.pool)), ro(k.quoteMint),
    rw(rulesPda.treasury(k.pool, k.quoteMint, k.quoteTokenProgram)), rw(to ?? pda.ata(wallet, k.quoteMint, k.quoteTokenProgram)), ro(k.quoteTokenProgram),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.claim_holder) });
}
/// Anyone: lower `wallet`'s holder record to what its coin account really holds (after a
/// token Burn, which calls no transfer hook). It never raises a record. No signer.
export function rulesSyncHolder(k: PoolKeys, wallet: PublicKey): TransactionInstruction {
  const keys: AccountMeta[] = [rw(rulesPda.cfg(k.pool)), ro(k.pool), rw(rulesPda.holder(k.pool, wallet)), ro(strictAta(wallet, k.baseMint))];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.sync_holder) });
}
/// Close a holder record that holds nothing (no balance, nothing owed, nothing locked, no
/// early coins under their lock) and get its rent back.
export function rulesCloseHolder(wallet: PublicKey, k: PoolKeys): TransactionInstruction {
  const keys: AccountMeta[] = [sigw(wallet), ro(rulesPda.cfg(k.pool)), rw(rulesPda.holder(k.pool, wallet))];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.close_holder) });
}
/// The creator lock of a strict coin: `amount` more coins of the creator's own wallet are
/// held there until `unlockAt` (Unix time). `LOCK_WHOLE_BALANCE` = everything the wallet
/// holds. The creator needs a holder record. The date rules are those of `rulesLockCreator`.
export function rulesLockCreatorStrict(creator: PublicKey, k: PoolKeys, amount: bigint, unlockAt: bigint): TransactionInstruction {
  const keys: AccountMeta[] = [
    sigw(creator), ro(rulesPda.cfg(k.pool)), rw(rulesPda.lock(k.pool)), rw(rulesPda.holder(k.pool, creator)), ro(strictAta(creator, k.baseMint)), ro(SYSTEM_PROGRAM),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.lock_creator_strict, new Writer().u64(amount).i64(unlockAt)) });
}
/// From the unlock date on: zero the creator lock of a strict coin (the coins were free
/// from that moment already).
export function rulesUnlockCreatorStrict(creator: PublicKey, k: PoolKeys): TransactionInstruction {
  const keys: AccountMeta[] = [sig(creator), ro(rulesPda.cfg(k.pool)), rw(rulesPda.lock(k.pool)), rw(rulesPda.holder(k.pool, creator))];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.unlock_creator_strict) });
}
/// The burn of a strict coin: `rulesRunBurn` in every respect, with the buy made by the
/// pool's `hook_buy_burn`, which burns the coins in the pool's vault. No burn account, no
/// transfer hook accounts.
export function rulesRunBurnStrict(payer: PublicKey, k: PoolKeys, minAmountOut: bigint): TransactionInstruction {
  const keys: AccountMeta[] = [
    sig(payer), rw(rulesPda.cfg(k.pool)), ro(rulesPda.authority(k.pool)), ro(pda.platform()), rw(k.pool), rw(k.baseMint), ro(k.quoteMint),
    rw(k.baseVault), rw(k.quoteVault), rw(rulesPda.treasury(k.pool, k.quoteMint, k.quoteTokenProgram)),
    ro(PROGRAMS.hookpool), ro(pda.eventAuthority(PROGRAMS.hookpool)), ro(k.baseTokenProgram), ro(k.quoteTokenProgram),
    ...eventCpi(PROGRAMS.hook_rules),
  ];
  return new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data: data(IX.hook_rules.run_burn_strict, new Writer().u64(minAmountOut)) });
}

/// The accounts a strict coin's transfer hook takes, for an instruction of the POOL that
/// moves the coin between `wallet`'s coin account and the pool's vault (`swap`,
/// `add_liquidity`, `remove_liquidity`, `create_pool`, the launchpad's `launch`): the
/// wallet's holder record, the pool's own holder address (it never exists) and the coin's
/// account list. The config, the fourth account, is the pool hook's own extra account.
export function strictPoolExtras(pool: PublicKey, mint: PublicKey, wallet: PublicKey): AccountMeta[] {
  return [rw(rulesPda.holder(pool, wallet)), rw(rulesPda.holder(pool, pool)), ro(rulesPda.validation(mint))];
}
/// The accounts of a wallet-to-wallet transfer of a strict coin, after `TransferChecked`'s
/// four: the config, both holder records, the account list and hook_rules.
export function strictTransferExtras(pool: PublicKey, mint: PublicKey, from: PublicKey, to: PublicKey): AccountMeta[] {
  return [rw(rulesPda.cfg(pool)), rw(rulesPda.holder(pool, from)), rw(rulesPda.holder(pool, to)), ro(rulesPda.validation(mint)), ro(PROGRAMS.hook_rules)];
}
/// The `hookAccounts` of `collectProtocolFees` on a strict coin: the coin moves from the
/// pool's vault to the platform treasury wallet's coin account.
export function strictCollectExtras(pool: PublicKey, mint: PublicKey, treasuryWallet: PublicKey): AccountMeta[] {
  return [rw(rulesPda.cfg(pool)), rw(rulesPda.holder(pool, pool)), rw(rulesPda.holder(pool, treasuryWallet)), ro(rulesPda.validation(mint)), ro(PROGRAMS.hook_rules)];
}
/// A wallet-to-wallet send of a strict coin: Token-2022 `TransferChecked` from the
/// owner's associated token account to `to`'s, with the hook's accounts. The receiving
/// account must exist (create it with `createAtaIdempotent(payer, to, mint,
/// TOKEN_2022_PROGRAM)` in front, as `client.strictSendInstructions` does).
export function strictTransfer(owner: PublicKey, to: PublicKey, pool: PublicKey, mint: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  const body = new Writer().u8(12).u64(amount).u8(decimals).toBytes();
  const keys: AccountMeta[] = [rw(strictAta(owner, mint)), ro(mint), rw(strictAta(to, mint)), sig(owner), ...strictTransferExtras(pool, mint, owner, to)];
  return new TransactionInstruction({ programId: TOKEN_2022_PROGRAM, keys, data: Buffer.from(body) });
}
/// A token Burn of the owner's own strict coins (Token-2022 `BurnChecked`). It calls no
/// transfer hook: the holder record stays above the balance until `rulesSyncHolder`.
export function strictBurn(owner: PublicKey, mint: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  const body = new Writer().u8(15).u64(amount).u8(decimals).toBytes();
  return new TransactionInstruction({ programId: TOKEN_2022_PROGRAM, keys: [rw(strictAta(owner, mint)), rw(mint), sig(owner)], data: Buffer.from(body) });
}

/// Template hooks: publish manifest + extra metas. Upgrade authority only.
export function initManifest(program: "hook_tax" | "hook_launch_guard" | "hook_buyback" | "hook_collectible" | "hook_rules", authority: PublicKey, uri: string): TransactionInstruction {
  const pid = PROGRAMS[program];
  const keys = [sigw(authority), ro(pda.programData(pid)), rw(pda.manifest(pid)), rw(pda.extraMetas(pid)), ro(SYSTEM_PROGRAM)];
  return new TransactionInstruction({ programId: pid, keys, data: data(IX[program].init_manifest, new Writer().string(uri)) });
}

// ---- token helpers ------------------------------------------------------------------------

export function createAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [sigw(payer), rw(pda.ata(owner, mint, tokenProgram)), ro(owner), ro(mint), ro(SYSTEM_PROGRAM), ro(tokenProgram)],
    data: Buffer.from([1]),
  });
}
/// SPL Token SyncNative: after sending lamports to a wrapped-SOL account.
export function syncNative(account: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [rw(account)], data: Buffer.from([17]) });
}
/// SPL Token CloseAccount: unwrap SOL back to the owner.
export function closeAccount(account: PublicKey, destination: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [rw(account), rw(destination), sig(owner)], data: Buffer.from([9]) });
}
export function transferLamports(from: PublicKey, to: PublicKey, lamports: bigint): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
}
