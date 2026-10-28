// High level client: reads state, resolves hooks, builds whole transactions, quotes.
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction, TransactionMessage,
} from "@solana/web3.js";
import * as ix from "./instructions.js";
import { HookRef, NO_HOOK, PoolKeys, poolKeys } from "./instructions.js";
import {
  BuybackConfig, GuardConfig, HookManifest, Launch, MintInfo, Platform, Pool, TaxConfig, TokenMetadata,
  decodeBuybackConfig, decodeGuardConfig, decodeHookManifest, decodeLaunch, decodeMetaplexMetadata, decodeMint, decodePlatform, decodePool,
  decodeTaxConfig, decodeToken2022Metadata, decodeTokenAmount, decodeTransferHook, decodeUpgradeAuthority, describeFlags,
} from "./accounts.js";
import { ACCOUNT_DISC, IX } from "./generated.js";
import { BPF_LOADER_UPGRADEABLE, LOADER_V4, CLOCK_SYSVAR, CURVE_NONE, CURVE_OPEN, DIRECTION, FLAGS, HARD_MAX_GRADUATION_FEE_BPS, HOOK_KIND, NATIVE_MINT, PROGRAMS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./constants.js";
import { pda } from "./pda.js";
import { resolveExtraAccounts } from "./extraMetas.js";
import { BURN_INTERVAL_SLOTS, BurnObservation, MAX_BUYBACK_MIN_QUOTE, SwapQuote, burnStep, buybackCapBps, buybackSpend, curveInitialLp, guardFee, quoteSwap } from "./math.js";
import { APPROVAL_ERRORS, HookApproval, HookApprovalRefusal, hookApprovalOf, isTemplateProgram } from "./approvals.js";
import { CURVE_ERRORS, CURVE_PEGGED_ERROR, CurveProgress, CurveRefusal, curveProgress as curveProgressOf, curveSettingsProblem, firstBuyGraduates, firstBuyHookFeeBps, poolAfterGraduation, readyToGraduate, willGraduate } from "./curve.js";
import * as col from "./collectible.js";
import { CurveOpenedEvent, GraduatedEvent, HookpoolEvent, SwappedEvent, eventsFromTransaction } from "./events.js";
import { getTransactionsBySignature } from "./transactions.js";
import {
  HolderRecord, LOCK_WHOLE_BALANCE, LockRecord, RULES_CEILINGS, RULES_ERRORS, RULES_LOCK_MARGIN_SECONDS, RulesConfig, RulesErrorInfo, RulesInput, StakeRecord, StrictInput, UNSTAKE_DELAY_SLOTS,
  decodeHolderRecord, decodeLockRecord, decodeRulesConfig, decodeStakeRecord, describeRules, rulesArgs, rulesBurnCapBps, rulesBuyLimit, rulesFirstBuyQuote, rulesLiquidityOpenSlot, rulesPda,
  rulesPendingRewards, rulesProblems, rulesRatesTotal, rulesSettle, rulesSideRates, rulesSniperFee, rulesStakersEligible, rulesUnsettledFee,
  strictArgs, strictEarlyLocked, strictEarlyWindowRuns, strictHolderClaimable, strictMaxWalletAmount, strictMaxWalletRuns, strictProblems, strictTransferRefusal, strictWindows,
} from "./rules.js";

const OUR_PROGRAMS = Object.values(PROGRAMS).map((p) => p.toBase58());

export type TemplateName = "tax" | "launch_guard" | "buyback" | "collectible" | "rules" | "none" | "custom";

export interface HookInfo {
  program: PublicKey;
  kind: number;              // HOOK_KIND
  flags: number;
  manifest: HookManifest | null;
  template: TemplateName | "custom";
  upgradeAuthority: PublicKey | null | "unknown";
  tax?: TaxConfig;
  guard?: GuardConfig;
  buyback?: BuybackConfig;
  collectible?: col.CollectionConfig;
  /// The "launch rules" template: the config as stored (its running numbers are one trade
  /// behind, see `rulesState`), and its rules in plain sentences with rates and windows.
  rules?: RulesConfig;
  rulesSentences?: string[];
  summary: ReturnType<typeof describeFlags>;
}

/// One call of a buy-and-burn instruction (`buybackInstructions`, `rulesBurnInstructions`).
/// The instruction buys against an observation of the pool that it recorded itself at
/// least `BURN_INTERVAL_SLOTS` (25) earlier, so a pool's first call only records one.
export interface BurnRun {
  /// What a call sent now does (`burnStep`):
  ///   "observe"  no observation yet: it records the pool's reserves and buys nothing
  ///   "wait"     the price is above the observed one by more than the tolerance (twice
  ///              the cap): it records the reserves again and buys nothing
  ///   "buy"      it buys and burns
  ///   "tooSoon"  the observation is less than 25 slots old: the chain refuses the call
  step: "observe" | "wait" | "buy" | "tooSoon";
  /// Does the chain accept a call now? False for "tooSoon", and for a "buy" whose spend is
  /// so small that the pool would refuse it (`reason` says so).
  due: boolean;
  /// Why a call is not due although its step is a "buy": the pot holds a few lamports
  /// that cannot buy anything after the fees. Absent otherwise.
  reason?: string;
  /// The first slot in which the chain accepts a call (0n when there is no observation yet).
  dueSlot: bigint;
  /// The slot all of this was worked out for.
  slot: bigint;
  /// The observation in the config, null when there is none yet.
  observation: BurnObservation | null;
  /// What waits to be spent: the buyback treasury, or the burn pot with the fee of the
  /// last trade counted in.
  pot: bigint;
  /// The cap of one buy on this pool, in basis points of its quote reserve (the smaller
  /// of the reserve now and the observed one).
  capBps: number;
  /// The next BUY: what it spends and what stays in the pot. When `step` is "buy" this is
  /// the call itself, and `expectedOut` and `minOut` are what it buys and burns and the
  /// floor sent with it. Otherwise `spend` and `potLeft` estimate the buy that follows,
  /// should the pool stand as it is now, and `expectedOut` and `minOut` are 0n: only a buy
  /// is quoted.
  spend: bigint; expectedOut: bigint; minOut: bigint; potLeft: bigint;
  /// The transaction. EMPTY when `step` is "tooSoon". For "observe" and "wait" it is worth
  /// sending: it records the observation the next buy needs.
  instructions: TransactionInstruction[];
}

/// A rules pool as of now (`rulesState`).
export interface RulesState {
  /// The pool, read in the same call as the config.
  pool: Pool;
  /// The config as stored on chain. Its running numbers are one trade behind.
  config: RulesConfig;
  /// The config after the settlement the program would run now: what is true this moment.
  settled: RulesConfig;
  /// The hook fee the treasury holds and the config has not split yet.
  unsettledFee: bigint;
  /// What `claim_creator` would pay now, and what the burn pot holds now.
  creatorClaimable: bigint; burnPot: bigint;
  /// Where the holders' share of the next trade goes: to the stakers (true, at least 0.1%
  /// of the supply is staked) or to the burn pot (false). A trade pays it either way.
  stakersEligible: boolean;
  /// The first slot in which liquidity can be added (0n: any time). The hook refuses
  /// `add_liquidity` while the sniper window runs, and on a strict coin while the max wallet runs.
  liquidityOpenSlot: bigint;
  /// The chain's clock at the read.
  slot: bigint; unixTime: bigint;
  /// A strict coin: its windows as of this read (null on a plain coin).
  strict: RulesStrictState | null;
}
/// The windows of a strict coin as of a read (`rulesState(pool).strict`).
export interface RulesStrictState {
  /// The max wallet in raw units of the coin, and whether it holds now and until which slot.
  maxWalletAmount: bigint; maxWalletRuns: boolean; maxWalletUntil: bigint;
  /// Is a buy now an early buy (it then needs the buyer's holder record), and until which slot.
  earlyWindowRuns: boolean; earlyUntil: bigint;
  /// Are early coins locked now, and the slot of the early unlock.
  earlyLocked: boolean; earlyUnlock: bigint;
  /// What the holder records count in all (`totalStaked`), and the least that must be
  /// registered for the holders' share to go to the holders (`minEligible`).
  registered: bigint; minRegistered: bigint;
}
/// A wallet's state on a strict coin (`rulesHolderOf`).
export interface RulesHolderInfo {
  address: PublicKey;
  /// null when the wallet has no holder record: it earns nothing, and a buy in the early
  /// window needs one first.
  record: HolderRecord | null;
  /// What the wallet's coin account holds, and what its record counts (they differ only
  /// after a token Burn, until `rulesSyncHolder`).
  balance: bigint; counted: bigint;
  /// What `claim_holder` would pay now, computed the way the program settles.
  claimable: bigint;
  /// Coins bought in the early window, whether they are locked now, and the slot of the unlock.
  earlyBought: bigint; earlyLocked: boolean; earlyUnlock: bigint;
  /// The creator lock: coins held in this wallet, whether the lock holds now, and until when (Unix time).
  locked: bigint; creatorLocked: boolean; lockedUntil: bigint;
  /// What the wallet may move now: its balance less what a lock holds.
  free: bigint;
  /// The wallet's share of everything registered, in basis points.
  shareBps: number;
  slot: bigint; unixTime: bigint;
}
/// A refusal the SDK sees coming on a strict coin: an Error whose `code` is the program's
/// error name and `number` its number (`RULES_ERRORS`). Thrown by `quoteLocal` with a
/// wallet, and by the send builder.
export class StrictRefusal extends Error {
  constructor(public readonly info: RulesErrorInfo) { super(info.message); this.name = "StrictRefusal"; }
  get code(): string { return this.info.name; }
  get number(): number { return this.info.number; }
}
/// A wallet's stake on a rules pool (`rulesStakeOf`).
export interface RulesStakeInfo {
  address: PublicKey;
  /// null when the wallet never staked on this pool.
  record: StakeRecord | null;
  staked: bigint;
  /// What `claim_rewards` would pay now, computed the way the program does.
  claimable: bigint;
  /// The first slot in which the wallet may unstake, and whether that is now. A wallet
  /// with nothing staked has nothing to unstake.
  unstakeOpenSlot: bigint; canUnstake: boolean;
  /// The wallet's share of everything staked, in basis points (0 when nothing is staked).
  shareBps: number;
  slot: bigint;
}
/// The creator lock of a rules pool (`rulesLock`). What is locked is `record` and
/// `vaultBalance`; `declaredSeconds` is only what the launcher declared at launch. On a
/// strict coin there is no lock vault: `vault` is the creator's own coin account, where the
/// locked coins stay, and `vaultBalance` what it holds (the lock is `record.amount`).
export interface RulesLockInfo {
  address: PublicKey; vault: PublicKey;
  /// null when the creator never locked anything.
  record: LockRecord | null;
  /// Coins in the lock vault: what an unlock would move. Normally the record's amount.
  vaultBalance: bigint;
  /// Unix time from which the creator may take the coins back (0n when nothing is locked).
  unlockAt: bigint;
  /// True when coins are locked and the unlock time has not come.
  locked: boolean;
  /// The lock declared at launch, and the earliest time a lock may end because of it.
  declaredSeconds: bigint; declaredUntil: bigint;
  creator: PublicKey;
  unixTime: bigint;
}

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

export interface ClientOptions {
  /// The platform's address lookup table (web/deployments/<cluster>-alt.json). With it,
  /// every fixed address costs one byte instead of 32, which is what lets a buy carry
  /// ticket, swap and mint in one transaction.
  lookupTable?: PublicKey;
}

export class HookpoolClient {
  private altCache: AddressLookupTableAccount[] | null = null;
  private rentCached: (() => Promise<col.RentFn>) | null = null;
  constructor(public readonly connection: Connection, public readonly options: ClientOptions = {}) {}

  /// The rent of the chain this client talks to, read once (two reads) and kept for an hour
  /// (`collectible.RENT_TTL_MS`). Every deposit this client sizes or reads uses it. Mainnet
  /// charges 5,080 lamports a byte and a local validator 6,960, so no constant would do: a
  /// deposit sized at the local rent is 787,720 lamports too much a piece on mainnet, and a
  /// deposit read at it is 891,120 lamports short on an empty ticket.
  async rent(): Promise<col.RentFn> {
    if (!this.rentCached) this.rentCached = col.rentReader(this.connection);
    return this.rentCached();
  }

  /// The lookup tables to compile transactions with (empty when none is configured).
  async lookupTables(): Promise<AddressLookupTableAccount[]> {
    if (this.altCache) return this.altCache;
    if (!this.options.lookupTable) return (this.altCache = []);
    const res = await this.connection.getAddressLookupTable(this.options.lookupTable);
    this.altCache = res.value ? [res.value] : [];
    return this.altCache;
  }

  /// A v0 transaction ready to sign, plus what is needed to confirm it.
  async buildTx(payer: PublicKey, ixs: TransactionInstruction[]): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(await this.lookupTables());
    return { tx: new VersionedTransaction(msg), blockhash, lastValidBlockHeight };
  }

  // ---- reads -------------------------------------------------------------------------------

  async platform(): Promise<Platform | null> {
    const info = await this.connection.getAccountInfo(pda.platform());
    return info ? decodePlatform(new Uint8Array(info.data)) : null;
  }

  async pool(address: PublicKey): Promise<Pool | null> {
    const info = await this.connection.getAccountInfo(address);
    return info ? decodePool(address, new Uint8Array(info.data)) : null;
  }

  async poolByMints(baseMint: PublicKey, quoteMint: PublicKey): Promise<Pool | null> {
    return this.pool(pda.pool(baseMint, quoteMint));
  }

  async allPools(): Promise<Pool[]> {
    const accs = await this.connection.getProgramAccounts(PROGRAMS.hookpool, {
      filters: [{ memcmp: { offset: 0, bytes: bs58(ACCOUNT_DISC.Pool) } }],
    });
    return accs.map((a) => decodePool(a.pubkey, new Uint8Array(a.account.data)));
  }

  async allLaunches(): Promise<Launch[]> {
    const accs = await this.connection.getProgramAccounts(PROGRAMS.hooklaunch, {
      filters: [{ memcmp: { offset: 0, bytes: bs58(ACCOUNT_DISC.Launch) } }],
    });
    return accs.map((a) => decodeLaunch(a.pubkey, new Uint8Array(a.account.data)));
  }

  async launchForMint(baseMint: PublicKey): Promise<Launch | null> {
    const key = pda.launch(baseMint);
    const info = await this.connection.getAccountInfo(key);
    return info ? decodeLaunch(key, new Uint8Array(info.data)) : null;
  }

  async mint(mint: PublicKey): Promise<MintInfo | null> {
    const info = await this.connection.getAccountInfo(mint);
    return info ? decodeMint(new Uint8Array(info.data), info.owner) : null;
  }

  /// Name, symbol and uri of a coin: its Metaplex metadata account, or, for a Token-2022
  /// mint that carries them itself (a pegged coin), the mint's own metadata.
  async metadata(mint: PublicKey): Promise<TokenMetadata | null> {
    const [info, mintInfo] = await this.connection.getMultipleAccountsInfo([pda.metadata(mint), mint]);
    if (info) { try { return decodeMetaplexMetadata(new Uint8Array(info.data)); } catch { /* fall through */ } }
    if (mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM)) { try { return decodeToken2022Metadata(mint, new Uint8Array(mintInfo.data)); } catch { return null; } }
    return null;
  }

  /// Could this pool's coin be a pegged coin? True for a collectible pool whose coin lives
  /// in Token-2022. A cheap first answer from the pool alone, good for a label in a list.
  /// The truth is the collection config's `pegged` field: `isPeggedExact`.
  isPegged(pool: Pool): boolean {
    return pool.hasHook && pool.hookProgram.equals(PROGRAMS.hook_collectible) && pool.baseTokenProgram.equals(TOKEN_2022_PROGRAM);
  }
  /// Is this pool's coin a pegged coin (Token-2022 with the collectible program as its
  /// transfer hook, bound to this pool's collection)? Read from the collection config.
  async isPeggedExact(pool: Pool): Promise<boolean> {
    if (!this.isPegged(pool)) return false;
    const cfg = await col.fetchCollectionConfig(this.connection, pool.address);
    return !!cfg && cfg.pegged;
  }

  async tokenBalance(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM): Promise<bigint> {
    const info = await this.connection.getAccountInfo(pda.ata(owner, mint, tokenProgram));
    return info ? decodeTokenAmount(new Uint8Array(info.data)) : 0n;
  }

  async hookInfo(pool: Pool): Promise<HookInfo | null> {
    if (!pool.hasHook) return null;
    const p = pool.hookProgram;
    const [manifestInfo, pdInfo, cfgInfo] = await Promise.all([
      this.connection.getAccountInfo(pda.manifest(p)),
      // only the header: the upgrade authority sits in the first 45 bytes of a program that is hundreds of KB
      this.connection.getAccountInfo(pda.programData(p), { dataSlice: { offset: 0, length: 45 } }),
      this.connection.getAccountInfo(pda.cfg(p, pool.address)),
    ]);
    return hookInfoFromAccounts(pool, manifestInfo, pdInfo, cfgInfo);
  }

  // ---- one read for a page ------------------------------------------------------------------------

  /// Accounts in as few calls as the RPC allows (`getMultipleAccounts`, 100 a call), with the
  /// slot of the first call's context. One call for up to 100 keys.
  async readAccounts(keys: PublicKey[]): Promise<{ slot: bigint; infos: AccountData[] }> {
    const infos: AccountData[] = [];
    let slot = 0n;
    for (let i = 0; i < keys.length; i += 100) {
      const { context, value } = await this.connection.getMultipleAccountsInfoAndContext(keys.slice(i, i + 100));
      if (i === 0) slot = BigInt(context.slot);
      infos.push(...value);
    }
    return { slot, infos };
  }

  /// What a wallet holds of a pool's tokens, in one read (`WalletBalances`).
  async walletBalances(owner: PublicKey, pool: Pool): Promise<WalletBalances> {
    return walletFromAccounts(owner, pool, await this.connection.getMultipleAccountsInfo(walletKeys(owner, pool)));
  }

  /// Everything a page about one pool shows, in ONE read (`getMultipleAccounts` with its
  /// context): the pool, its coin's mint, the quote mint (not for SOL), the LP mint and the
  /// lock account, the hook's config and manifest (`hook`, as `hookInfo` gives it) and its
  /// quote treasury, and as asked the platform, the coin's metadata, the launch record, a
  /// wallet's balances, a rules coin's `rulesView` and a buyback coin's next run. `slot` is the
  /// slot of the read: a page needs no getSlot beside it.
  ///
  /// Given a `Pool` read before (its addresses never change) it is one call. Given only the
  /// pool's address it is two: the pool first (with the platform when asked), then the rest,
  /// the pool included again so that every figure is of the same slot. On a strict coin with no
  /// `rulesConfig` from an earlier read, one more (see `rulesView`). `upgradeAuthority: true`
  /// adds one call (the header of the hook's program data). null when there is no pool.
  async poolView(pool: PublicKey | Pool, opts: PoolViewOptions = {}): Promise<PoolView | null> {
    let platform: Platform | null = opts.platform && typeof opts.platform === "object" ? opts.platform : null;
    const wantPlatform = opts.platform === true;
    let p: Pool;
    if ((pool as Pool).baseMint !== undefined) p = pool as Pool;
    else {
      // the pool names every other account: it is read first, with the platform when asked
      const address = pool as PublicKey;
      const [poolInfo, platInfo] = await this.connection.getMultipleAccountsInfo(wantPlatform ? [address, pda.platform()] : [address]);
      if (!poolInfo) return null;
      p = decodePool(address, new Uint8Array(poolInfo.data));
      if (platInfo) platform = decodePlatform(new Uint8Array(platInfo.data));
    }
    const list: PublicKey[] = [];
    const idx = new Map<string, number>();
    const at = (k: PublicKey) => { const s = k.toBase58(); let i = idx.get(s); if (i === undefined) { i = list.length; list.push(k); idx.set(s, i); } return i; };
    const iPool = at(p.address), iMint = at(p.baseMint);
    const iQuote = p.quoteMint.equals(NATIVE_MINT) ? -1 : at(p.quoteMint);
    const iLpMint = at(p.lpMint), iLpLock = at(p.lpLock);
    const iPlat = wantPlatform && !platform ? at(pda.platform()) : -1;
    const iMeta = opts.metadata ? at(pda.metadata(p.baseMint)) : -1;
    const iLaunch = opts.launch ? at(pda.launch(p.baseMint)) : -1;
    let iCfg = -1, iManifest = -1, iTreasury = -1;
    if (p.hasHook) {
      iCfg = at(pda.cfg(p.hookProgram, p.address));
      if (opts.manifest !== false) iManifest = at(pda.manifest(p.hookProgram));
      if (!p.hookQuoteTreasury.equals(SYSTEM_PROGRAM)) iTreasury = at(p.hookQuoteTreasury);
    }
    const w = opts.wallet ?? null;
    const iWallet = w ? walletKeys(w, p).map(at) : [];
    const rk = opts.rules !== false && p.hasHook && p.hookProgram.equals(PROGRAMS.hook_rules) ? rulesViewKeys(p.address, p.baseMint, w, opts.rulesConfig ?? null) : null;
    if (rk) rk.list.forEach(at);
    const iExtra = (opts.extra ?? []).map(at);

    const { slot, infos } = await this.readAccounts(list);
    const get = (i: number): AccountData => (i >= 0 ? infos[i] ?? null : null);
    const poolInfo = get(iPool);
    if (!poolInfo) return null;
    p = decodePool(p.address, new Uint8Array(poolInfo.data));
    const platInfo = get(iPlat);
    if (platInfo) platform = decodePlatform(new Uint8Array(platInfo.data));
    const mintInfo = get(iMint), quoteInfo = get(iQuote), lpMintInfo = get(iLpMint), lpLockInfo = get(iLpLock);
    const pd = opts.upgradeAuthority && p.hasHook ? await this.connection.getAccountInfo(pda.programData(p.hookProgram), { dataSlice: { offset: 0, length: 45 } }) : undefined;
    const hook = hookInfoFromAccounts(p, iManifest >= 0 ? get(iManifest) : undefined, pd, get(iCfg));
    const amountOf = (a: AccountData) => (a && a.data.length >= 72 ? decodeTokenAmount(new Uint8Array(a.data)) : null);
    let metadata: TokenMetadata | null = null;
    if (opts.metadata) {
      const m = get(iMeta);
      if (m) metadata = safe(() => decodeMetaplexMetadata(new Uint8Array(m.data)));
      if (!metadata && mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM)) metadata = safe(() => decodeToken2022Metadata(p.baseMint, new Uint8Array(mintInfo.data)));
    }
    const launchInfo = get(iLaunch);
    const treasury = amountOf(get(iTreasury));
    const payer = opts.payer ?? w ?? PublicKey.default;
    let buyback: (BurnRun & { treasuryLeft: bigint }) | null = null;
    if (hook && hook.buyback && platform && treasury !== null) buyback = this.buybackRun(payer, p, hook.buyback, treasury, platform, slot);
    const rules = rk ? await this.rulesViewFrom(p.address, rk, rk.list.map((k) => get(idx.get(k.toBase58())!)), slot, { wallet: w, payer, platform }) : null;
    return {
      slot, pool: p,
      mint: mintInfo ? decodeMint(new Uint8Array(mintInfo.data), mintInfo.owner) : null,
      quoteMint: quoteInfo ? decodeMint(new Uint8Array(quoteInfo.data), quoteInfo.owner) : null,
      lp: lpMintInfo && lpLockInfo ? { supply: decodeMint(new Uint8Array(lpMintInfo.data), lpMintInfo.owner).supply, locked: decodeTokenAmount(new Uint8Array(lpLockInfo.data)) } : null,
      hook, treasury, platform, metadata,
      launch: launchInfo ? safe(() => decodeLaunch(pda.launch(p.baseMint), new Uint8Array(launchInfo.data))) : null,
      wallet: w ? walletFromAccounts(w, p, iWallet.map(get)) : null,
      rules, buyback, extra: iExtra.map(get),
    };
  }

  /// Everything needed to pass the hook into an instruction, resolved from chain state.
  async hookRef(pool: Pool, user: PublicKey): Promise<HookRef> {
    if (!pool.hasHook) return NO_HOOK;
    const em = await this.connection.getAccountInfo(pool.hookExtraMetas);
    if (!em) throw new Error("hook extra-metas account missing");
    const fixed = [pool.address, pda.caller(pool.hookProgram)[0], user, pool.quoteMint, pool.baseMint];
    const extra = await resolveExtraAccounts(this.connection, pool.hookProgram, new Uint8Array(em.data), fixed);
    // a pegged coin: the transfer between the user and the vault runs the coin's own hook
    if (await this.isPeggedExact(pool)) {
      const w = (pubkey: PublicKey, isWritable: boolean) => ({ pubkey, isSigner: false, isWritable });
      extra.push(w(col.collectiblePda.ticket(pool.address, pool.address), true), w(col.collectiblePda.queue(pool.address), true), w(col.collectiblePda.validation(pool.baseMint), false));
    }
    // a strict coin: the coin's own transfer hook (hook_rules again) takes the user's holder
    // record, the pool's holder address and the coin's account list
    if (await this.isStrictPool(pool)) extra.push(...ix.strictPoolExtras(pool.address, pool.baseMint, user));
    return { program: pool.hookProgram, treasury: pool.hookQuoteTreasury, extra };
  }

  private strictKinds = new Map<string, boolean>();
  /// Is this pool's coin a strict coin of the rules template (a Token-2022 coin whose
  /// transfer hook is hook_rules)? Read from the config's `kind` once, then remembered: it
  /// never changes.
  async isStrictPool(pool: Pool): Promise<boolean> {
    if (!pool.hookProgram.equals(PROGRAMS.hook_rules) || !pool.baseTokenProgram.equals(TOKEN_2022_PROGRAM)) return false;
    const key = pool.address.toBase58();
    const known = this.strictKinds.get(key);
    if (known !== undefined) return known;
    const info = await this.connection.getAccountInfo(rulesPda.cfg(pool.address), { dataSlice: { offset: 374, length: 1 } });
    // One byte is asked for, but an RPC or a proxy that ignores `dataSlice` answers the
    // whole account: then `kind` is byte 374 of it. An answer that is neither (a config
    // too short to carry the byte) is not remembered, so a bad read never silently drops
    // the coin's extra accounts from every later swap.
    const d = info ? info.data : null;
    const kind = d && d.length === 1 ? d[0] : d && d.length > 374 ? d[374] : null;
    const strict = kind === 1;
    if (kind !== null) this.strictKinds.set(key, strict);
    return strict;
  }

  keys(pool: Pool): PoolKeys {
    return { pool: pool.address, baseMint: pool.baseMint, quoteMint: pool.quoteMint, baseVault: pool.baseVault, quoteVault: pool.quoteVault, lpMint: pool.lpMint, lpLock: pool.lpLock, baseTokenProgram: pool.baseTokenProgram, quoteTokenProgram: pool.quoteTokenProgram };
  }

  // ---- quoting ---------------------------------------------------------------------------------

  /// Instant local quote. Exact for pools without a hook and for the platform's templates;
  /// for custom hooks it assumes "no opinion" and `quoteOnChain` should be used.
  ///
  /// `slot`: the slot to quote for (default: the chain's current slot, read only when a
  /// launch guard or a rules coin with a window needs it). Inside a sniper or guard window
  /// the fee falls every slot, so a trade that lands later gives the quoted amount or more.
  ///
  /// A rules coin: a trade pays all three rates of its side whoever is staked, so the quote
  /// depends on the rules alone, which never change. A buy above the coin's buy limit,
  /// inside its window, throws: the chain would refuse it (`rulesBuyLimit` tells before
  /// asking).
  ///
  /// A strict coin, with `wallet` given (the wallet that buys or sells): the quote also
  /// throws a `StrictRefusal` for what the coin's transfer hook would refuse: a buy that
  /// would leave the wallet above the max wallet (`MaxWallet`), a sell of early coins
  /// before the early unlock (`EarlyLocked`), a sell of the creator's locked coins
  /// (`CreatorLocked`). A buy in the early window by a wallet without a holder record is
  /// not refused here: `swapInstructions` opens the record in front of the buy.
  ///
  /// The max wallet is checked with `amountOutCeiling`, not with `amountOut`: inside a
  /// window where the fee falls every slot the chain pays more than the quote of the read
  /// slot, and the program holds the receiver's balance AFTER the transfer to the cap. So
  /// the check leaves room for the falling fee, and a buy sized to the cap by the slot's
  /// quote is refused here rather than by the chain a few slots later. A price fall
  /// between the quote and the landing raises the output as well, so a buy within a hair
  /// of the cap can still be refused by the chain; a client that must land keeps a margin.
  ///
  /// A pool on the curve: the price is made of `reserveQuote + virtualQuote`. The quote
  /// carries `graduates` (the transaction graduates the pool, `swapInstructions` puts
  /// `graduate` in it) and `graduateFirst`:
  ///   - the pool stands at or past its target (`readyToGraduate`): `graduate` goes FIRST and
  ///     the trade, a buy or a sell, is quoted on the pool as graduation leaves it
  ///     (`poolAfterGraduation`). The quote is exact whoever graduates first;
  ///   - a buy that crosses the target from below: quoted on the curve, `graduate` goes AFTER
  ///     the swap. A wallet that moves the pool first is a price move like any other: the
  ///     caller's slippage on `amountOut` protects the trade, which reverts when it is passed.
  /// The floor of a swap is always the caller's slippage on `amountOut`; nothing lowers it.
  /// A sell that would take more than the real reserve throws a `CurveRefusal`
  /// (`CurveRealReserve`), as the chain would.
  async quoteLocal(pool: Pool, platform: Platform, direction: number, amountIn: bigint, hook?: HookInfo | null, slot?: bigint, wallet?: PublicKey): Promise<SwapQuote> {
    const fees = await this.quoteFees(pool, platform, direction, amountIn, hook, slot);
    const first = readyToGraduate(pool);
    // the pool the trade runs on: graduated first when it stands at or past its target
    const at = first ? poolAfterGraduation(pool) : pool;
    const params = {
      direction, amountIn, reserveBase: at.reserveBase, reserveQuote: at.reserveQuote, virtualQuote: at.virtualQuote,
      lpFeeBps: pool.lpFeeBps, protocolFeeBps: platform.protocolFeeBps, hookFeeBps: fees.hookFeeBps,
    };
    const q = quoteSwap({ ...params, feeOverrideBps: fees.feeOverrideBps });
    // the most the trade can pay out: with the fee override gone, which is where the
    // falling fee ends (the override is never below the pool's own fee)
    q.amountOutCeiling = fees.feeOverrideBps === null ? q.amountOut : (safe(() => quoteSwap({ ...params, feeOverrideBps: null }).amountOut) ?? q.amountOut);
    q.graduates = willGraduate(pool, direction, q);
    if (q.graduates) q.graduateFirst = first;
    q.amountOutFloor = q.amountOut;
    if (wallet && hook?.rules?.strict) {
      const isBuy = direction === DIRECTION.BUY;
      const check = await this.strictTradeCheck(pool, wallet, direction, isBuy ? q.amountOutCeiling : amountIn);
      if (check.refusal) {
        const window = isBuy && check.refusal.number === 6044 && q.amountOutCeiling !== q.amountOut;
        throw new StrictRefusal(window
          ? { ...check.refusal, message: `${check.refusal.message} The check leaves room for the falling fee: this buy was quoted ${q.amountOut} raw units at slot ${fees.slot}, but a buy inside the window gets more the later it lands, up to ${q.amountOutCeiling} at the pool's normal fee, and the chain holds the wallet's balance after the buy to the cap.` }
          : check.refusal);
      }
    }
    return q;
  }

  /// What the transfer hook of a strict coin would do with a trade of `wallet`: `refusal`
  /// is the error the chain would answer (null: none), `needsHolder` says that the buy is
  /// in the early window and the wallet has no holder record yet (`swapInstructions` then
  /// puts `open_holder` in front). `amount` is the coins received on a buy (pass the
  /// quote's `amountOutCeiling`: inside a falling-fee window the chain pays more than the
  /// slot's `amountOut`, and the cap holds the balance after the buy), the coins sold on
  /// a sell.
  async strictTradeCheck(pool: Pool, wallet: PublicKey, direction: number, amount: bigint): Promise<{ refusal: RulesErrorInfo | null; needsHolder: boolean; holder: RulesHolderInfo | null }> {
    const [holder, state] = await Promise.all([this.rulesHolderOf(pool.address, wallet), this.rulesState(pool.address)]);
    if (!holder || !state || !state.config.strict) return { refusal: null, needsHolder: false, holder };
    const side = { balance: holder.balance, record: holder.record };
    const isBuy = direction === DIRECTION.BUY;
    const refusal = strictTransferRefusal(state.config, isBuy ? { kind: "buy", amount, to: side } : { kind: "sell", amount, from: side }, state.slot, state.unixTime);
    if (refusal && refusal.number === 6047) return { refusal: null, needsHolder: true, holder };
    return { refusal, needsHolder: false, holder };
  }

  /// The hook fee and the fee override a trade pays at `slot` (the chain's current slot
  /// when not given, read only when a window needs it), clamped to the platform caps the
  /// way the pool clamps them.
  private async quoteFees(pool: Pool, platform: Platform, direction: number, amountIn: bigint, hook?: HookInfo | null, slot?: bigint): Promise<{ hookFeeBps: number; feeOverrideBps: number | null; slot: bigint | null }> {
    let hookFeeBps = 0;
    let feeOverrideBps: number | null = null;
    let s: bigint | null = slot ?? null;
    const slotNow = async () => (s ??= BigInt(await this.connection.getSlot()));
    if (hook) {
      const isBuy = direction === DIRECTION.BUY;
      const runs = isBuy ? hook.summary.runsOnBuys : hook.summary.runsOnSells;
      if (runs && hook.tax) hookFeeBps = isBuy ? hook.tax.buyBps : hook.tax.sellBps;
      if (runs && hook.buyback) hookFeeBps = isBuy ? hook.buyback.buyBps : hook.buyback.sellBps;
      if (runs && hook.guard) {
        feeOverrideBps = guardFee(await slotNow(), hook.guard.startSlot, hook.guard.guardSlots, hook.guard.startFeeBps, pool.lpFeeBps);
      }
      if (runs && hook.rules) {
        const c = hook.rules;
        hookFeeBps = rulesRatesTotal(rulesSideRates(c, direction));
        // the two windows touch buys only
        if (isBuy && (c.sniperSlots > 0n || c.maxBuyQuote > 0n)) {
          const at = await slotNow();
          const limit = rulesBuyLimit(c, at);
          if (limit && amountIn > limit.maxBuyQuote) throw new Error(`this buy is above the coin's buy limit: at most ${limit.maxBuyQuote} raw units of the quote token per buy until slot ${limit.untilSlot}`);
          feeOverrideBps = rulesSniperFee(at, c.startSlot, c.sniperSlots, c.sniperStartFeeBps, pool.lpFeeBps);
        }
      }
    }
    // The pool clamps to the platform caps; mirror it so local quotes match on-chain quotes.
    hookFeeBps = Math.min(hookFeeBps, platform.maxHookFeeBps);
    if (feeOverrideBps !== null) feeOverrideBps = Math.min(feeOverrideBps, platform.maxFeeOverrideBps);
    return { hookFeeBps, feeOverrideBps, slot: s };
  }

  /// Exact quote for any hook: simulate the swap and read the return data.
  async quoteOnChain(user: PublicKey, pool: Pool, direction: number, amountIn: bigint): Promise<bigint> {
    const hook = await this.hookRef(pool, user);
    const all = await this.swapInstructions(user, pool, hook, direction, amountIn, 0n);
    // Return data belongs to the last instruction that ran, so stop right after the swap
    // (found by its discriminator: on a pool ready to graduate `graduate` comes before it).
    const swapDisc = Buffer.from(IX.hookpool.swap);
    const swapIdx = all.findIndex((i) => i.programId.equals(PROGRAMS.hookpool) && Buffer.from(i.data).subarray(0, 8).equals(swapDisc));
    const ixs = all.slice(0, swapIdx + 1);
    const tx = new Transaction().add(...ixs);
    tx.feePayer = user;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    const sim = await this.connection.simulateTransaction(tx, undefined, false);
    if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
    const rd = sim.value.returnData;
    if (!rd || !rd.programId || rd.programId !== PROGRAMS.hookpool.toBase58()) throw new Error("no return data from the pool");
    const bytes = Buffer.from(rd.data[0], "base64");
    return bytes.readBigUInt64LE(0);
  }

  // ---- transactions -------------------------------------------------------------------------------

  /// A swap with the token accounts created if needed and SOL wrapped/unwrapped around it.
  /// `opts.recipient`: another wallet that receives what the swap pays out. `user` still
  /// signs and pays. A buy puts the coins in the recipient's token account; a sell for SOL
  /// unwraps to the recipient. Pieces of a collectible coin are earned by the wallet that
  /// signs, and kept only for coins that wallet itself holds, so a buy for someone else
  /// opens no ticket.
  ///
  /// The user's wrapped SOL account is left as it was found. A wallet that had none gets
  /// one for the length of the transaction and plain SOL at the end. A wallet that already
  /// had one keeps it open, with the SOL of a sell inside it: that account may be the
  /// treasury of a coin, and closing it would stop its fees. `unwrapInstructions` empties
  /// it without closing it.
  ///
  /// A strict coin: on a buy by a wallet without a holder record, `open_holder` goes in
  /// front of the swap, the way a collectible coin's ticket is opened, so that the wallet
  /// earns its share from this buy on (rent about 0.0013 SOL on mainnet, the chain's rent of
  /// `HOLDER_RECORD_SIZE` bytes, back when the record is closed). `opts.openHolder: false` leaves it out, except in the early window, where the
  /// chain refuses a buy without the record. A buy for a `recipient` without a record in
  /// the early window throws: only the recipient can open its own record.
  ///
  /// A pool on the curve, two cases (the quote of `quoteLocal` follows the same rule):
  ///   - the pool stands at or past its target (`readyToGraduate`), a buy or a sell:
  ///     `graduate` goes right BEFORE the swap, so the swap always runs on the graduated pool
  ///     and its quote on that pool is exact, whoever graduates first;
  ///   - a buy that crosses the target from below: `graduate` goes right AFTER the swap.
  /// On a pool that somebody else graduated first `graduate` lands and changes nothing, and
  /// on revision 3 of the pool program so does a `graduate` that finds an open pool below its
  /// target (a sell that landed first); nothing here depends on the chain refusing it.
  /// `minAmountOut` is sent as given: the SDK never lowers a floor. Derive it from the
  /// quote's `amountOut` with the user's slippage. `opts.graduate` decides when given:
  /// `false` never adds `graduate` (a keeper that cranks graduation itself, or a proof that
  /// leaves a pool standing past its target), `true` always does (before the swap on a pool
  /// ready to graduate, after it otherwise). Left out, the SDK decides: on a pool ready to
  /// graduate from the pool alone; for a buy on an open pool below its target from its own
  /// quote (two more reads).
  ///
  /// A collectible coin, ONE approval (`opts.mintDeposit`, off unless asked): a buy by the
  /// signer adds a plain SOL transfer to the signer's own ticket right after the swap, the
  /// deposit the wallet's pieces are minted from (`collectible.depositTransfer`). Anyone may
  /// then mint them into the wallet once their block exists (`mint_for`; the operator's
  /// keeper does), so the wallet signs nothing more. The amount is `mintDepositTopUp`: what
  /// every piece the wallet will have waiting needs, less what the ticket already holds.
  /// `true` counts the pieces of this buy from the SDK's own quote (it reads the platform
  /// and the hook); `{ amountOut }` from the coins the caller's quote pays out; `{ pieces }`
  /// as given. Nothing is added when the buy earns nothing or the deposit already covers it,
  /// nor on a buy paid out to another wallet (it opens no ticket). A buy never carries a
  /// `mint`, with or without `mintDeposit`: pieces left from earlier buys are minted by a
  /// keeper or by the wallet (collectibleMintInstructions), because a mint inside a buy that
  /// meets somebody's `mint_for` would fail the whole buy. A sell names, besides the pieces
  /// it burns, the asset addresses of the waiting pieces it drops (`nextAssets`): when a
  /// keeper mints them before the sell lands, the sell burns them and their rent comes back
  /// to the seller.
  async swapInstructions(user: PublicKey, pool: Pool, hook: HookRef, direction: number, amountIn: bigint, minAmountOut: bigint, opts: { recipient?: PublicKey; openHolder?: boolean; graduate?: boolean; mintDeposit?: boolean | { pieces?: number; amountOut?: bigint } } = {}): Promise<TransactionInstruction[]> {
    const k = this.keys(pool);
    const ready = readyToGraduate(pool);
    const isBuy = direction === DIRECTION.BUY;
    let graduation: "before" | "after" | null = null;
    if (opts.graduate === true) graduation = ready ? "before" : "after";
    else if (opts.graduate === undefined) {
      if (ready) graduation = "before";
      else if (isBuy && pool.curveState === CURVE_OPEN && (await this.buyCrossesTarget(pool, amountIn))) graduation = "after";
    }
    const recipient = opts.recipient && !opts.recipient.equals(user) ? opts.recipient : null;
    const isCollectible = pool.hookProgram.equals(PROGRAMS.hook_collectible);
    const isCollectibleBuy = isCollectible && direction === DIRECTION.BUY;
    const out: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: isCollectibleBuy ? 600_000 : isCollectible ? 450_000 : 250_000 })];
    const quoteIsSol = pool.quoteMint.equals(NATIVE_MINT);
    // One read tells us which accounts already exist, which keeps the transaction small.
    const userBase = pda.ata(user, pool.baseMint, pool.baseTokenProgram);
    const userQuote = pda.ata(user, pool.quoteMint, pool.quoteTokenProgram);
    const ticketKey = col.collectiblePda.ticket(pool.address, user);
    const [baseInfo, quoteInfo, ticketInfo] = await this.connection.getMultipleAccountsInfo([userBase, userQuote, ticketKey]);
    const userWsol = pda.ata(user, NATIVE_MINT);
    // The wrapped account is closed at the end only when this transaction opened it, and
    // never when it is this pool's hook treasury.
    const keepWsol = quoteIsSol && (!!quoteInfo || pool.hookQuoteTreasury.equals(userWsol));
    // Where the output lands when it is not the user's own account. A sell for SOL pays into
    // the user's wrapped account and unwraps to the recipient, who then holds plain SOL;
    // unless that account has to stay open: then the recipient is paid in wrapped SOL.
    const unwrapToRecipient = !!recipient && !isBuy && quoteIsSol && !keepWsol;
    const outBase = recipient && isBuy ? pda.ata(recipient, pool.baseMint, pool.baseTokenProgram) : undefined;
    const outQuote = recipient && !isBuy && !unwrapToRecipient ? pda.ata(recipient, pool.quoteMint, pool.quoteTokenProgram) : undefined;
    if (outBase) out.push(ix.createAtaIdempotent(user, recipient!, pool.baseMint, pool.baseTokenProgram));
    else if (!baseInfo) out.push(ix.createAtaIdempotent(user, user, pool.baseMint, pool.baseTokenProgram));
    if (outQuote) out.push(ix.createAtaIdempotent(user, recipient!, pool.quoteMint, pool.quoteTokenProgram));
    else if (!quoteInfo) out.push(ix.createAtaIdempotent(user, user, pool.quoteMint, pool.quoteTokenProgram));
    if (quoteIsSol && direction === DIRECTION.BUY) {
      out.push(ix.transferLamports(user, pda.ata(user, NATIVE_MINT), amountIn));
      out.push(ix.syncNative(pda.ata(user, NATIVE_MINT)));
    }
    let earlier: col.Ticket | null = null;
    if (isCollectibleBuy) {
      if (!ticketInfo || ticketInfo.data.length === 0) { if (!outBase) out.push(col.openTicket(user, pool.address)); }
      else earlier = col.decodeTicket(new Uint8Array(ticketInfo.data));
    }
    // a pegged coin's own hook looks up the receiver's ticket in every transfer, also when
    // the coins leave the pool: its address has to be in the account list
    let hookForSwap: HookRef = outBase && this.isPegged(pool)
      ? { ...hook, extra: [...hook.extra, { pubkey: col.collectiblePda.ticket(pool.address, recipient!), isSigner: false, isWritable: true }] }
      : hook;
    // a strict coin: the receiver's holder record is read in the transfer that pays the buy
    // out, and a buy is the moment to open the buyer's own record
    if (isBuy && (await this.isStrictPool(pool))) {
      const receiver = recipient ?? user;
      if (recipient) hookForSwap = { ...hookForSwap, extra: [...hookForSwap.extra, { pubkey: rulesPda.holder(pool.address, recipient), isSigner: false, isWritable: true }] };
      const [recInfo, cfgInfo, clockInfo] = await this.connection.getMultipleAccountsInfo([rulesPda.holder(pool.address, receiver), rulesPda.cfg(pool.address), CLOCK_SYSVAR]);
      if (!recInfo && cfgInfo && clockInfo) {
        const early = strictEarlyWindowRuns(decodeRulesConfig(new Uint8Array(cfgInfo.data)), clockOf(new Uint8Array(clockInfo.data)).slot);
        if (!recipient) { if (early || opts.openHolder !== false) out.push(ix.rulesOpenHolder(user, k)); }
        else if (early) throw new StrictRefusal({ ...RULES_ERRORS[6047], message: "A buy in the early window needs the receiving wallet's holder record, and only that wallet can open it." });
      }
    }
    if (graduation === "before") out.push(ix.graduate(k));
    out.push(ix.swap(user, k, hookForSwap, direction, amountIn, minAmountOut, { base: outBase, quote: outQuote }));
    if (graduation === "after") out.push(ix.graduate(k));
    // One approval: the deposit goes right after the swap. It covers every piece the wallet
    // has waiting, earlier ones included, and the keeper mints them all.
    if (isCollectibleBuy && !outBase && !!opts.mintDeposit) {
      const lamports = await this.buyDepositLamports(pool, amountIn, ticketInfo, earlier, opts.mintDeposit as true | { pieces?: number; amountOut?: bigint });
      if (lamports > 0n) out.push(col.depositTransfer(user, pool.address, lamports));
    }
    // A buy never mints. The pieces of THIS buy are decided by a block two slots ahead, so
    // they cannot be minted here, and pieces left from earlier buys are not minted here
    // either: anybody may mint a wallet's decided pieces into it once its ticket holds a
    // deposit (`mint_for`), and a mint inside the buy that meets one would name the wrong
    // asset address and fail the whole buy. They are minted by a keeper, or by the wallet
    // itself (collectibleMintInstructions).
    // A sell on a collectible pool settles the wallet in the same transaction: the pieces
    // the coins left behind no longer back are dropped or burned, the end of the list first.
    if (isCollectible && direction === DIRECTION.SELL && ticketInfo && ticketInfo.data.length > 0) {
      const cfg = await col.fetchCollectionConfig(this.connection, pool.address);
      const before = col.backingOf(baseInfo, user, pool.baseMint, pool.baseTokenProgram);
      const t = col.decodeTicket(new Uint8Array(ticketInfo.data));
      const peg = cfg ? col.pegStatus(t, before > amountIn ? before - amountIn : 0n, cfg.unit) : null;
      // Waiting pieces this sell drops may be minted by a keeper before the sell lands; then
      // the sell burns their assets instead. Their addresses are known now (the wallet's next
      // ones): named here, the seller burns them itself and gets their rent back, not
      // whoever settles the wallet next. Addresses that hold nothing are skipped.
      // (The order of the names does not matter to either instruction.)
      const next = peg ? col.nextAssets(pool.address, user, t, peg.dropWaiting) : [];
      const names = peg ? [...peg.burn.slice(0, col.MAX_BURNS_PER_SETTLE), ...next] : [];
      if (cfg && cfg.pegged) {
        // the coin's own transfer hook takes the pieces off the list inside the swap; this
        // burns their Metaplex assets in the same transaction. Six names at most: a pegged
        // sell is the largest transaction a trade builds (about 1,180 bytes with nine)
        if (names.length > 0) out.push(col.reap(user, pool.address, names.slice(0, col.MAX_BURNS_PER_SETTLE)));
      } else if (peg && (peg.dropWaiting > 0 || peg.burn.length > 0)) {
        out.push(col.settle(user, pool.address, user, userBase, names));
      }
    }
    // Unwrap afterwards, unless the wrapped account was there before (see above).
    if (quoteIsSol && !keepWsol) out.push(ix.closeAccount(userWsol, unwrapToRecipient ? recipient! : user, user));
    return out;
  }

  /// The deposit a collectible buy adds (see `swapInstructions`, `mintDeposit`).
  private async buyDepositLamports(
    pool: Pool, amountIn: bigint, ticketInfo: { lamports: number; data: Uint8Array | Buffer } | null, ticket: col.Ticket | null,
    how: true | { pieces?: number; amountOut?: bigint },
  ): Promise<bigint> {
    const given = typeof how === "object" ? how : {};
    let cfg: col.CollectionConfig | null | undefined;
    let pieces = given.pieces;
    if (pieces === undefined) {
      let amountOut = given.amountOut;
      if (amountOut === undefined) {
        const [platform, hookInfo] = await Promise.all([this.platform(), this.hookInfo(pool)]);
        if (!platform) return 0n;
        cfg = hookInfo?.collectible;
        // the most this buy can pay out: above it a falling fee would pay more
        const q = await this.quoteLocal(pool, platform, DIRECTION.BUY, amountIn, hookInfo);
        amountOut = q.amountOutCeiling ?? q.amountOut;
      }
      cfg = cfg ?? (await col.fetchCollectionConfig(this.connection, pool.address));
      if (!cfg) return 0n;
      pieces = col.piecesEarned(cfg, ticket, amountOut);
    }
    if (!pieces || pieces <= 0) return 0n;
    // the chain's rent (kept an hour), read only for a buy that earns something
    const [rent, known] = await Promise.all([this.rent(), cfg ? Promise.resolve(cfg) : col.fetchCollectionConfig(this.connection, pool.address)]);
    cfg = known;
    if (!cfg) return 0n;
    const deposit = ticketInfo && ticketInfo.data.length > 0 ? col.depositOf(ticketInfo.lamports, ticketInfo.data.length, rent) : 0n;
    return col.mintDepositTopUp(rent, cfg, ticket, deposit, pieces);
  }

  /// Does a buy of `amountIn` take this open curve pool, below its target, to the target?
  /// Worked out from the SDK's own quote on the curve (two reads: the platform and the
  /// hook's config). For a hook the platform did not write the hook fee of the buy is taken
  /// at the platform's cap, so a buy that may fall short is not given a `graduate`. A quote
  /// that cannot be made (a buy above a rules coin's limit) answers false: the chain refuses
  /// the trade itself. Leaving `graduate` out is always safe: the next trade, or the
  /// watcher, graduates the pool.
  private async buyCrossesTarget(pool: Pool, amountIn: bigint): Promise<boolean> {
    if (pool.curveState !== CURVE_OPEN || readyToGraduate(pool)) return false;
    try {
      const [platform, hook] = await Promise.all([this.platform(), this.hookInfo(pool)]);
      if (!platform) return false;
      const q = hook && hook.template === "custom"
        ? quoteSwap({
            direction: DIRECTION.BUY, amountIn, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: pool.virtualQuote,
            lpFeeBps: pool.lpFeeBps, protocolFeeBps: platform.protocolFeeBps, hookFeeBps: platform.maxHookFeeBps,
          })
        : await this.quoteLocal(pool, platform, DIRECTION.BUY, amountIn, hook);
      return q.reserveInAfter >= pool.graduationTarget;
    } catch { return false; }
  }

  /// Two transactions: create the coin, then launch it with the chosen hook.
  ///
  /// `curve: true` launches ON THE CURVE (`launch_curve`): the creator puts no SOL into the
  /// pool (`quoteAmount` is 0n or left out), the whole supply goes in, the pool prices
  /// trades with the platform's virtual quote, pays out real SOL only, refuses liquidity
  /// until it holds the platform's graduation target of real SOL, and then anyone's
  /// `graduate` (the SDK appends it to the trade that gets there) drops the virtual part
  /// and burns the coins that keep the price. Every template works on the curve except a
  /// pegged collectible coin, which is refused here with the launchpad's own sentence
  /// (`CurvePegged`) before anything is built; a platform with the curve off is refused
  /// with `CurveDisabled`. The dev buy, the creator lock and the strict rules work as on a
  /// seeded launch; the first buy is priced on the curve. The result carries `curve` with
  /// the settings the pool gets and the LP that goes into the lock account.
  async launchInstructions(opts: {
    dev: PublicKey;
    mint: Keypair;
    name: string; symbol: string; uri: string; decimals: number; totalSupply: bigint;
    quoteMint: PublicKey;
    /// `quoteAmount`: the SOL the creator seeds the pool with (a seeded launch); 0n or left
    /// out on a curve launch.
    lpFeeBps: number; quoteAmount?: bigint; devBuyQuote: bigint; minDevBuyOut: bigint;
    /// A launch on the curve (see above). Default: a seeded launch.
    curve?: boolean;
    template: TemplateName;
    tax?: { buyBps: number; sellBps: number; maxBps: number; treasury?: PublicKey };
    /// `pegged`: launch the coin as a Token-2022 mint whose transfer hook is the collectible
    /// program, so its pieces move or burn inside every transfer.
    collectible?: { name: string; uriBase: string; unit: bigint; maxSupply: number; maxPerBuy: number; art: Uint8Array; pegged?: boolean };
    guard?: { guardSlots: bigint; startFeeBps: number };
    buyback?: { buyBps: number; sellBps: number; minQuote: bigint };
    /// The "launch rules" template. Every rule left out is off. Rates are in basis points
    /// per side, windows in slots, `maxBuyQuote` in raw units of the quote token (lamports).
    /// The numbers are checked against the program's ceilings (`RULES_CEILINGS`) before
    /// anything is built; a launch form should keep them inside `RULES_POLICY`.
    ///
    /// `creatorLockSeconds` above zero asks for a creator lock: the launch transaction then
    /// ends with `lock_creator` for everything the dev's coin account holds after the first
    /// buy, so it needs a first buy (`devBuyQuote`). The lock ends at the chain's time now
    /// plus `creatorLockSeconds` plus `lockMarginSeconds` (default 600): the margin is the
    /// time the launch has to land in. The result's `lock` says both times.
    ///
    /// `strict` makes it a STRICT coin (RULES.md, "The strict coin"): a Token-2022 coin whose
    /// transfer hook is hook_rules, with a max wallet, an early lock and holder rewards
    /// without staking. `strict: {}` is a strict coin with neither window. Transaction 1 then
    /// creates the coin through the launchpad's pegged path, binds it with
    /// `init_strict_config` and, when there is a first buy, opens the launcher's holder
    /// record; transaction 2 ends with `lock_creator_strict` when a lock is asked. Checked
    /// before anything is built: the strict bounds (`RULES_STRICT_CEILINGS`), and a first
    /// buy above the max wallet. Transaction 2 with a lock does not fit a legacy
    /// transaction: the client needs the platform's lookup table (`lookupTable` option),
    /// or this throws, and the caller sends both transactions through `buildTx`.
    rules?: RulesInput & { lockMarginSeconds?: number; strict?: StrictInput };
    /// A hook written by the dev (frozen, manifest published). `setup` = the dev's own
    /// per-pool config instructions, run in transaction 1 before the pool exists.
    custom?: { program: PublicKey; treasuryOwner?: PublicKey; setup?: TransactionInstruction[] };
  }): Promise<{
    createTx: TransactionInstruction[]; launchTx: TransactionInstruction[]; pool: PublicKey; signers: Keypair[];
    /// Only with a creator lock: when the lock ends (`unlockAt`, Unix time), and the chain
    /// time before which the launch transaction must land (`landBefore`). Sent later, the
    /// program refuses the lock and with it the whole launch: build again with the same mint.
    lock?: { unlockAt: bigint; landBefore: bigint };
    /// The size of each transaction as a legacy transaction, in bytes (null: it does not
    /// compile into one), and whether one of them is above the limit of 1,232: then send
    /// both through `buildTx` with the platform's lookup table.
    sizes: { createTx: number | null; launchTx: number | null }; needsLookupTable: boolean;
    /// A strict coin: the max wallet in raw units the pool will have (0n: none).
    strict?: { maxWalletAmount: bigint };
    /// A curve launch: the settings the pool is created with (the platform's now), the LP
    /// minted into the lock account (`curveInitialLp`), and whether the dev buy itself
    /// reaches the target, in which case `launchTx` ends with `graduate`.
    curve?: { virtualQuote: bigint; graduationTarget: bigint; graduationFeeBps: number; lpLocked: bigint; graduatesAtLaunch: boolean };
  }> {
    // What the program would refuse is refused here, before a read and before anything is
    // built: the first transaction creates the coin, and nothing undoes it when the second fails.
    const rules = opts.template === "rules" ? rulesArgs(opts.rules ?? {}) : null;
    const strict = rules && opts.rules?.strict ? strictArgs(opts.rules.strict) : null;
    const lockMargin = BigInt(opts.rules?.lockMarginSeconds ?? RULES_LOCK_MARGIN_SECONDS);
    const curve = !!opts.curve;
    const quoteAmount = opts.quoteAmount ?? 0n;
    if (curve && opts.template === "collectible" && opts.collectible?.pegged) throw new CurveRefusal(CURVE_PEGGED_ERROR);
    if (curve && quoteAmount > 0n) throw new Error("a curve launch takes no SOL from the creator: leave quoteAmount out or set it to 0");
    if (!curve && quoteAmount <= 0n) throw new Error("a seeded launch needs quoteAmount above zero; a launch that needs no SOL from the creator is curve: true");
    if (strict) {
      const problems = strictProblems(strict);
      if (problems.length) throw new Error(`these strict rules would be refused (${problems[0].code}): ${problems.map((p) => p.message).join("; ")}`);
    }
    if (rules) {
      const problems = rulesProblems(rules);
      if (problems.length) throw new Error(`these rules would be refused (${problems[0].code}): ${problems.map((p) => p.message).join("; ")}`);
      if (rules.maxBuyQuote > 0n && opts.devBuyQuote > rules.maxBuyQuote) throw new Error("the first buy is above this coin's own buy limit: the launch would be refused (BuyTooLarge)");
      if (rules.creatorLockSeconds > 0n) {
        if (opts.devBuyQuote <= 0n) throw new Error("a creator lock locks the launcher's first buy: set devBuyQuote, or leave the lock out");
        if (lockMargin < 0n || rules.creatorLockSeconds + lockMargin > BigInt(RULES_CEILINGS.creatorLockSeconds)) {
          throw new Error(`a lock in the launch transaction ends ${lockMargin} seconds after the declared ${rules.creatorLockSeconds}, which is more than the program's ${RULES_CEILINGS.creatorLockSeconds} seconds: declare a shorter lock`);
        }
      }
    }
    const platform = await this.platform();
    if (!platform) throw new Error("platform not initialised");
    if (curve && !platform.curveEnabled) throw new CurveRefusal(CURVE_ERRORS[6043]);
    if (opts.template === "custom" && opts.custom) await this.requireHookAllowed(opts.custom.program, platform);
    const virtualQuote = curve ? platform.curveVirtualQuote : 0n;
    const pegged = opts.template === "collectible" && !!opts.collectible?.pegged;
    const k = poolKeys(opts.mint.publicKey, opts.quoteMint, pegged || strict ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);
    // a strict coin: the first buy is a buy like any other, held to the max wallet
    const maxWalletAmount = strict ? strictMaxWalletAmount(opts.totalSupply, strict.maxWalletBps) : 0n;
    if (strict && rules && strict.maxWalletBps > 0 && opts.devBuyQuote > 0n) {
      const first = rulesFirstBuyQuote(rules, { totalSupply: opts.totalSupply, quoteAmount, lpFeeBps: opts.lpFeeBps, devBuyQuote: opts.devBuyQuote, virtualQuote }, platform);
      if (first.amountOut > maxWalletAmount) throw new Error(`the first buy gets ${first.amountOut} raw units, above this coin's own max wallet of ${maxWalletAmount}: the launch would be refused (MaxWallet)`);
    }
    const quoteIsSol = opts.quoteMint.equals(NATIVE_MINT);

    // Transaction 1: the coin itself plus the hook's per-pool config (the pool address is
    // known in advance). Keeps transaction 2 well under the 1232-byte limit.
    const tokenArgs = { name: opts.name, symbol: opts.symbol, uri: opts.uri, decimals: opts.decimals, totalSupply: opts.totalSupply };
    const createTx: TransactionInstruction[] = pegged
      ? ix.createPeggedToken(opts.dev, opts.mint.publicKey, PROGRAMS.hook_collectible, tokenArgs)
      : strict ? ix.createPeggedToken(opts.dev, opts.mint.publicKey, PROGRAMS.hook_rules, tokenArgs)
      : [ix.createToken(opts.dev, opts.mint.publicKey, tokenArgs)];
    let hook: HookRef = NO_HOOK;
    if (opts.template === "tax") {
      const t = opts.tax!;
      const treasuryOwner = t.treasury ?? opts.dev;
      createTx.push(ix.createAtaIdempotent(opts.dev, treasuryOwner, opts.quoteMint));
      createTx.push(ix.taxInitPoolConfig(opts.dev, opts.dev, k.pool, t.buyBps, t.sellBps, t.maxBps));
      hook = { program: PROGRAMS.hook_tax, treasury: pda.ata(treasuryOwner, opts.quoteMint), extra: [{ pubkey: pda.cfg(PROGRAMS.hook_tax, k.pool), isSigner: false, isWritable: false }] };
    } else if (opts.template === "launch_guard") {
      const g = opts.guard!;
      createTx.push(ix.guardInitPoolConfig(opts.dev, k.pool, g.guardSlots, g.startFeeBps));
      hook = { program: PROGRAMS.hook_launch_guard, treasury: SYSTEM_PROGRAM, extra: [{ pubkey: pda.cfg(PROGRAMS.hook_launch_guard, k.pool), isSigner: false, isWritable: true }] };
    } else if (opts.template === "buyback") {
      const b = opts.buyback!;
      if (b.minQuote > MAX_BUYBACK_MIN_QUOTE) throw new Error(`the buyback minimum is ${b.minQuote} raw units, the most the program takes is ${MAX_BUYBACK_MIN_QUOTE} (MinQuoteTooHigh)`);
      createTx.push(ix.buybackInitPoolConfig(opts.dev, k.pool, opts.mint.publicKey, opts.quoteMint, b.buyBps, b.sellBps, b.minQuote));
      const authority = pda.hookAuthority(k.pool, PROGRAMS.hook_buyback)[0];
      // writable: every trade may lower the observation the buyback buys against
      hook = { program: PROGRAMS.hook_buyback, treasury: pda.ata(authority, opts.quoteMint), extra: [{ pubkey: pda.cfg(PROGRAMS.hook_buyback, k.pool), isSigner: false, isWritable: true }] };
    } else if (opts.template === "collectible") {
      const c = opts.collectible!;
      createTx.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: pegged ? 600_000 : 400_000 }));
      createTx.push(col.initPoolConfig(opts.dev, opts.dev, k.pool, c));
      // the coin is bound to its config here, while its mint key still signs
      if (pegged) createTx.push(col.initPeg(opts.dev, opts.mint.publicKey, opts.quoteMint, k.pool));
      if (opts.devBuyQuote > 0n) createTx.push(col.openTicket(opts.dev, k.pool));
      hook = { program: PROGRAMS.hook_collectible, treasury: SYSTEM_PROGRAM, extra: col.callbackExtras(k.pool, opts.dev, pegged ? opts.mint.publicKey : undefined) };
    } else if (rules && strict) {
      // the coin (Token-2022, its transfer hook hook_rules), bound to its rules while the
      // mint still signs, and the launcher's holder record, opened before the pool exists:
      // the first buy may be early, and a creator lock needs the record
      createTx.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      createTx.push(ix.rulesInitStrictConfig(opts.dev, k, rules, strict));
      if (opts.devBuyQuote > 0n) createTx.push(ix.rulesOpenHolder(opts.dev, k));
      hook = {
        program: PROGRAMS.hook_rules, treasury: rulesPda.treasury(k.pool, opts.quoteMint),
        extra: [{ pubkey: rulesPda.cfg(k.pool), isSigner: false, isWritable: true }, ...ix.strictPoolExtras(k.pool, opts.mint.publicKey, opts.dev)],
      };
    } else if (rules) {
      // coin and rules together need more than the default 200,000 compute units
      createTx.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      createTx.push(ix.rulesInitPoolConfig(opts.dev, k, rules));
      hook = { program: PROGRAMS.hook_rules, treasury: rulesPda.treasury(k.pool, opts.quoteMint), extra: [{ pubkey: rulesPda.cfg(k.pool), isSigner: false, isWritable: true }] };
    } else if (opts.template === "custom") {
      const c = opts.custom!;
      if (c.setup) createTx.push(...c.setup);
      const [manifestInfo, em] = await Promise.all([
        this.connection.getAccountInfo(pda.manifest(c.program)),
        this.connection.getAccountInfo(pda.extraMetas(c.program)),
      ]);
      if (!manifestInfo) throw new Error("this hook has not published its manifest yet");
      if (!em) throw new Error("this hook has not published its extra-accounts list yet");
      const manifest = decodeHookManifest(new Uint8Array(manifestInfo.data));
      // The first transaction creates the coin, and nothing undoes it when the second is
      // refused. So what the pool and the launchpad would refuse is refused here, first.
      if (manifest.flags & FLAGS.OVERRIDE_CURVE) throw new Error("the launchpad does not take hooks that own the price curve");
      const pd = await this.connection.getAccountInfo(pda.programData(c.program), { dataSlice: { offset: 0, length: 45 } });
      if (pd) {
        let authority: PublicKey | null = null;
        try { authority = decodeUpgradeAuthority(new Uint8Array(pd.data)); } catch { /* not a loader-v3 program: the pool decides */ }
        if (authority && !platform.whitelist.some((w) => w.equals(authority!))) {
          throw new Error("this hook can still be upgraded by " + authority.toBase58() + ". The pool takes a hook only once its upgrade authority is removed.");
        }
      }
      const fixed = [k.pool, pda.caller(c.program)[0], opts.dev, opts.quoteMint, opts.mint.publicKey];
      const extra = await resolveExtraAccounts(this.connection, c.program, new Uint8Array(em.data), fixed);
      let treasury = SYSTEM_PROGRAM;
      if (manifest.flags & FLAGS.TAKE_HOOK_FEE) {
        const owner = c.treasuryOwner ?? opts.dev;
        createTx.push(ix.createAtaIdempotent(opts.dev, owner, opts.quoteMint));
        treasury = pda.ata(owner, opts.quoteMint);
      }
      hook = { program: c.program, treasury, extra };
    }

    // Transaction 2: wrap SOL, create the pool with its LP locked, optional dev buy. On the
    // curve only the dev buy is wrapped; the dev's quote account must exist all the same.
    const launchTx: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: pegged ? 700_000 : strict ? 600_000 : opts.template === "collectible" ? 500_000 : 400_000 })];
    launchTx.push(ix.createAtaIdempotent(opts.dev, opts.dev, opts.quoteMint));
    if (quoteIsSol && quoteAmount + opts.devBuyQuote > 0n) {
      launchTx.push(ix.transferLamports(opts.dev, pda.ata(opts.dev, NATIVE_MINT), quoteAmount + opts.devBuyQuote));
      launchTx.push(ix.syncNative(pda.ata(opts.dev, NATIVE_MINT)));
    }
    let curveInfo: { virtualQuote: bigint; graduationTarget: bigint; graduationFeeBps: number; lpLocked: bigint; graduatesAtLaunch: boolean } | undefined;
    if (curve) {
      launchTx.push(ix.launchCurve(opts.dev, platform.treasury, k, hook, { lpFeeBps: opts.lpFeeBps, devBuyQuote: opts.devBuyQuote, minDevBuyOut: opts.minDevBuyOut }));
      // a dev buy large enough to reach the target on its own graduates the coin in the
      // launch transaction. The hook fee is the real one where it is known (none without a
      // hook, the coin's buy rate for tax and buyback) and the platform's cap otherwise, so
      // this is never appended to a buy that may fall short (`firstBuyHookFeeBps`)
      const hookBpsAtLaunch = hook === NO_HOOK ? 0 : firstBuyHookFeeBps(opts.template, { tax: opts.tax, buyback: opts.buyback }, platform.maxHookFeeBps);
      const graduatesAtLaunch = firstBuyGraduates(opts.devBuyQuote, platform, hookBpsAtLaunch);
      if (graduatesAtLaunch) launchTx.push(ix.graduate(k));
      curveInfo = { virtualQuote, graduationTarget: platform.curveGraduationTarget, graduationFeeBps: platform.curveGraduationFeeBps, lpLocked: curveInitialLp(opts.totalSupply, virtualQuote), graduatesAtLaunch };
    } else {
      launchTx.push(ix.launch(opts.dev, platform.treasury, k, hook, { lpFeeBps: opts.lpFeeBps, baseAmount: opts.totalSupply, quoteAmount, devBuyQuote: opts.devBuyQuote, minDevBuyOut: opts.minDevBuyOut }));
    }

    // The creator lock, in the same transaction as the first buy, so the coins are never
    // loose. The whole-balance form locks what the buy bought without knowing the amount.
    let lock: { unlockAt: bigint; landBefore: bigint } | undefined;
    if (rules && rules.creatorLockSeconds > 0n) {
      const landBefore = (await this.chainTime()).unixTime + lockMargin;
      lock = { unlockAt: landBefore + rules.creatorLockSeconds, landBefore };
      launchTx.push(strict ? ix.rulesLockCreatorStrict(opts.dev, k, LOCK_WHOLE_BALANCE, lock.unlockAt) : ix.rulesLockCreator(opts.dev, k, LOCK_WHOLE_BALANCE, lock.unlockAt));
    }

    // Same rule as swaps: the dev's wrapped SOL account is closed only when this launch
    // opened it, and never when it is the hook treasury of this coin or of an earlier one.
    const devWsol = pda.ata(opts.dev, NATIVE_MINT);
    if (quoteIsSol && !hook.treasury.equals(devWsol) && !(await this.exists(devWsol))) {
      launchTx.push(ix.closeAccount(devWsol, opts.dev, opts.dev));
    }
    const sizes = { createTx: legacySize(createTx, opts.dev), launchTx: legacySize(launchTx, opts.dev) };
    const needsLookupTable = [sizes.createTx, sizes.launchTx].some((s) => s === null || s > 1232);
    if (strict && needsLookupTable && !this.options.lookupTable) {
      throw new Error("this launch does not fit a legacy transaction: create the client with the platform's lookup table ({ lookupTable }) and send both transactions through buildTx");
    }
    return { createTx, launchTx, pool: k.pool, signers: [opts.mint], ...(lock ? { lock } : {}), sizes, needsLookupTable, ...(strict ? { strict: { maxWalletAmount } } : {}), ...(curveInfo ? { curve: curveInfo } : {}) };
  }

  // ---- the curve ----------------------------------------------------------------------------------

  /// `graduate` for a pool on the curve, alone: for a keeper (the watcher cranks it) or a
  /// page. Anyone may send it; it graduates a pool that stands at or past its target. On a
  /// pool that already graduated it lands and changes nothing, so it is built. With `check`
  /// (the default) it throws a `CurveRefusal` from the pool as passed, as a message for the
  /// caller: `NotOnCurve` for a seeded pool (the chain refuses it too) and
  /// `GraduationNotReached` for an open pool below its target (revision 3 of the pool
  /// program lands that call and changes nothing; the SDK relies on neither answer).
  /// `check: false` builds it regardless. The default compute budget is enough (about 20,000
  /// units).
  graduateInstructions(pool: Pool, opts: { check?: boolean } = {}): TransactionInstruction[] {
    if (opts.check !== false) {
      if (pool.curveState === CURVE_NONE) throw new CurveRefusal(CURVE_ERRORS[6047]);
      if (pool.curveState === CURVE_OPEN && pool.reserveQuote < pool.graduationTarget) throw new CurveRefusal(CURVE_ERRORS[6048]);
    }
    return [ix.graduate(this.keys(pool))];
  }

  /// A pool on the curve made directly, without the launchpad (`create_curve_pool`): the
  /// creator's whole supply of a closed mint goes in, no SOL. The creator's quote account is
  /// created if missing (the program wants it although nothing is taken from it). Asks for
  /// 400,000 compute units like `createPoolInstructions`. Checked here with two reads, as
  /// the program refuses them: the platform's curve settings off (`CurveDisabled`) and a
  /// pegged collectible coin, a Token-2022 mint whose transfer hook is the collectible
  /// program (the pool's own `CurvePegged`, 6050).
  async createCurvePoolInstructions(creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, lpFeeBps: number, baseAmount: bigint, hook: HookRef = NO_HOOK, baseTokenProgram: PublicKey = TOKEN_PROGRAM): Promise<TransactionInstruction[]> {
    const [platformInfo, mintInfo] = await this.connection.getMultipleAccountsInfo([pda.platform(), baseMint]);
    if (!platformInfo) throw new Error("platform not initialised");
    const platform = decodePlatform(new Uint8Array(platformInfo.data));
    if (!platform.curveEnabled) throw new CurveRefusal(CURVE_ERRORS[6043]);
    await this.requireHookAllowed(hook.program, platform);
    if (mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM)) {
      const th = decodeTransferHook(new Uint8Array(mintInfo.data));
      if (th && th.program && th.program.equals(PROGRAMS.hook_collectible)) throw new CurveRefusal(CURVE_ERRORS[6050]);
    }
    const k = poolKeys(baseMint, quoteMint, baseTokenProgram);
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix.createAtaIdempotent(creator, creator, quoteMint),
      ix.createCurvePool(creator, creator, k, hook, { lpFeeBps, baseAmount }),
    ];
  }

  /// Where a hook program stands with the approved list (HOOKS.md section 6.1): whether the
  /// rule is on, whether the program is listed, whether it is the platform's own (no hook, a
  /// template, or a program whose upgrade authority the platform whitelists, which needs one
  /// more read) and whether a pool can open on it now. `platform` saves the read when the
  /// caller has it.
  async hookApproval(program: PublicKey, platform?: Platform | null): Promise<HookApproval> {
    const p = platform ?? (await this.platform());
    if (!p) throw new Error("platform not initialised");
    const first = hookApprovalOf(p, program, false);
    if (first.own || first.approved || !first.required) return first;
    return hookApprovalOf(p, program, await this.isWhitelistedHook(program, p));
  }

  /// True when the program's upgrade authority is one the platform whitelists: the pool then
  /// runs it as one of the platform's own hooks (HOOK_KIND_PLATFORM), with no approval.
  private async isWhitelistedHook(program: PublicKey, p: Platform): Promise<boolean> {
    if (!p.whitelist.length) return false;
    // one read: the program (its loader) and, for loader v3, its ProgramData
    const [prog, pdata] = await this.connection.getMultipleAccountsInfo([program, pda.programData(program)]);
    if (!prog) return false;
    let authority: PublicKey | null = null;
    if (prog.owner.equals(BPF_LOADER_UPGRADEABLE)) {
      // ProgramData: 4 bytes of tag, 8 of slot, then Option<Pubkey> (1 + 32)
      if (pdata && pdata.data.length >= 45 && pdata.data[12] === 1) authority = new PublicKey(pdata.data.subarray(13, 45));
    } else if (prog.owner.equals(LOADER_V4)) {
      // LoaderV4State: slot (8), authority (32), status (8); 1 = deployed (upgradeable), 2 = finalized
      if (prog.data.length >= 48 && new DataView(prog.data.buffer, prog.data.byteOffset + 40, 8).getBigUint64(0, true) === 1n) authority = new PublicKey(prog.data.subarray(8, 40));
    }
    return !!authority && p.whitelist.some((w) => w.equals(authority!));
  }

  /// Throws `HookApprovalRefusal` (the program's `HookNotApproved`, 6052) when a pool could
  /// not open on this hook now. Refused the same way as the program refuses it, before
  /// anything is built: a launch's first transaction creates the coin, and nothing undoes it.
  async requireHookAllowed(program: PublicKey, platform?: Platform | null): Promise<void> {
    const a = await this.hookApproval(program, platform);
    if (a.allowed) return;
    throw new HookApprovalRefusal(a.listCorrupt ? APPROVAL_ERRORS[6056] : APPROVAL_ERRORS[6052], program);
  }

  /// The approved list and the rule, as the platform holds them now.
  async approvedHooks(): Promise<{ required: boolean; programs: PublicKey[]; corrupt: boolean }> {
    const p = await this.platform();
    if (!p) throw new Error("platform not initialised");
    return { required: p.hookApprovalRequired, programs: p.approvedHooks, corrupt: p.approvedListCorrupt };
  }

  /// The curve numbers of a pool for a page (`curveProgress` in curve.ts), with the coin's
  /// supply read from the mint. On a seeded pool `state` is "none".
  async curveProgress(pool: Pool): Promise<CurveProgress> {
    const m = await this.mint(pool.baseMint);
    if (!m) throw new Error("the coin's mint could not be read");
    return curveProgressOf(pool, m.supply);
  }

  /// The two events of a pool's life on the curve, read from its last `limit` transactions:
  /// `opened` (the settings it was created with) and `graduated` (the burn, the fee and the
  /// slot). Either is null when it did not happen or lies further back than `limit`.
  async curveEvents(pool: PublicKey | Pool, limit = 1000): Promise<{ opened: (CurveOpenedEvent & { signature: string; blockTime: number }) | null; graduated: (GraduatedEvent & { signature: string; blockTime: number }) | null }> {
    const address = addressOf(pool);
    const events = await this.allEvents(address, limit);
    const opened = events.find((e) => e.kind === "CurveOpened" && e.pool.equals(address)) as (CurveOpenedEvent & { signature: string; blockTime: number }) | undefined;
    const graduated = events.find((e) => e.kind === "Graduated" && e.pool.equals(address)) as (GraduatedEvent & { signature: string; blockTime: number }) | undefined;
    return { opened: opened ?? null, graduated: graduated ?? null };
  }

  /// `update_platform` for the fields of `wanted` that differ from the platform account
  /// now: `changes` names them in words and `instructions` is empty when nothing differs.
  /// For an admin script that is run again and again. Refused here as the program refuses
  /// them: a graduation fee above `HARD_MAX_GRADUATION_FEE_BPS` (`FeeTooHigh` on chain), and
  /// curve settings out of bounds (`CurveSettingsOutOfBounds`: a virtual quote above
  /// `u64::MAX / 4`, or a target below a thousandth of the virtual quote when both are on),
  /// judged on the settings the platform would hold after the update.
  async platformUpdate(admin: PublicKey, wanted: ix.UpdatePlatformArgs): Promise<{ changes: string[]; args: ix.UpdatePlatformArgs; instructions: TransactionInstruction[] }> {
    const p = await this.platform();
    if (!p) throw new Error("platform not initialised");
    if (wanted.curveGraduationFeeBps !== undefined && wanted.curveGraduationFeeBps > HARD_MAX_GRADUATION_FEE_BPS) {
      throw new Error(`the graduation fee is at most ${HARD_MAX_GRADUATION_FEE_BPS} basis points (FeeTooHigh)`);
    }
    const bounds = curveSettingsProblem(wanted.curveVirtualQuote ?? p.curveVirtualQuote, wanted.curveGraduationTarget ?? p.curveGraduationTarget);
    if (bounds) throw new CurveRefusal(bounds);
    const args: ix.UpdatePlatformArgs = {};
    const changes: string[] = [];
    const want = <K extends keyof ix.UpdatePlatformArgs>(key: K, now: ix.UpdatePlatformArgs[K], same: boolean, label: string) => {
      const v = wanted[key];
      if (v === undefined || same) return;
      args[key] = v;
      changes.push(`${label}: ${String(now)} to ${String(v)}`);
    };
    want("treasury", p.treasury, !!wanted.treasury && wanted.treasury.equals(p.treasury), "treasury");
    want("protocolFeeBps", p.protocolFeeBps, wanted.protocolFeeBps === p.protocolFeeBps, "protocol fee (bps)");
    want("maxLpFeeBps", p.maxLpFeeBps, wanted.maxLpFeeBps === p.maxLpFeeBps, "max pool fee (bps)");
    want("maxHookFeeBps", p.maxHookFeeBps, wanted.maxHookFeeBps === p.maxHookFeeBps, "max hook fee (bps)");
    want("maxFeeOverrideBps", p.maxFeeOverrideBps, wanted.maxFeeOverrideBps === p.maxFeeOverrideBps, "max fee override (bps)");
    want("launchFeeLamports", p.launchFeeLamports, wanted.launchFeeLamports === p.launchFeeLamports, "launch fee (lamports)");
    want("paused", p.paused, wanted.paused === p.paused, "paused");
    want("curveVirtualQuote", p.curveVirtualQuote, wanted.curveVirtualQuote === p.curveVirtualQuote, "curve virtual quote (lamports)");
    want("curveGraduationTarget", p.curveGraduationTarget, wanted.curveGraduationTarget === p.curveGraduationTarget, "curve graduation target (lamports)");
    want("curveGraduationFeeBps", p.curveGraduationFeeBps, wanted.curveGraduationFeeBps === p.curveGraduationFeeBps, "curve graduation fee (bps)");
    return { changes, args, instructions: changes.length ? [ix.updatePlatform(admin, args)] : [] };
  }

  /// The follow-up to a buy on a collectible pool: reveal and mint whatever is decided.
  /// Returns an empty list when the wallet has nothing waiting. Send it at least two slots
  /// after the buy; before that the pieces are undecided and the call mints nothing.
  async collectibleMintInstructions(user: PublicKey, pool: PublicKey): Promise<TransactionInstruction[]> {
    const [t, cfg] = await Promise.all([col.fetchTicket(this.connection, pool, user), col.fetchCollectionConfig(this.connection, pool)]);
    if (!t || !cfg || t.pending === 0) return [];
    const n = Math.min(col.MAX_MINT_PER_CALL, t.pending);
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }), col.mintPieces(user, pool, n, t.minted, n, col.coinsAddress(user, cfg.baseMint, cfg.tokenProgram))];
  }

  /// What a buy on a collectible pool that pays out `amountOut` coins earns `user`, and the
  /// deposit that lets anyone mint it: `need` covers every piece the wallet will have
  /// waiting, `deposit` is what its ticket holds now above the rent of its current length
  /// (what a mint can use), `topUp` what the buy must add (the amount `swapInstructions` puts
  /// in with `mintDeposit`). Null without a collection.
  async collectibleBuyDeposit(user: PublicKey, pool: PublicKey, amountOut: bigint): Promise<{ pieces: number; need: bigint; deposit: bigint; topUp: bigint } | null> {
    const [cfg, info, rent] = await Promise.all([col.fetchCollectionConfig(this.connection, pool), this.connection.getAccountInfo(col.collectiblePda.ticket(pool, user)), this.rent()]);
    if (!cfg) return null;
    const open = !!info && info.data.length > 0;
    const ticket = open ? col.decodeTicket(new Uint8Array(info!.data)) : null;
    const deposit = open ? col.depositOf(info!.lamports, info!.data.length, rent) : 0n;
    const pieces = col.piecesEarned(cfg, ticket, amountOut);
    const need = col.mintDepositFor(rent, cfg, (ticket ? ticket.pending : 0) + pieces);
    return { pieces, need, deposit, topUp: need > deposit ? need - deposit : 0n };
  }

  /// For a keeper: mint `user`'s decided pieces into `user`, paid by its deposit; `payer`
  /// signs, pays the Metaplex rent and is paid back what it spent plus `KEEPER_FEE`. Empty
  /// when nothing is decided yet or the deposit does not cover it (`mintForCount`,
  /// `mintForCost`). Simulate before sending: the wallet may sell or withdraw meanwhile.
  async collectibleMintForInstructions(payer: PublicKey, pool: PublicKey, user: PublicKey): Promise<TransactionInstruction[]> {
    const [info, cfg] = await Promise.all([this.connection.getAccountInfo(col.collectiblePda.ticket(pool, user)), col.fetchCollectionConfig(this.connection, pool)]);
    if (!info || info.data.length === 0 || !cfg) return [];
    const t = col.decodeTicket(new Uint8Array(info.data));
    if (t.pending === 0) return [];
    const [slot, balances, rent] = await Promise.all([this.connection.getSlot(), col.fetchBacking(this.connection, cfg, [user]), this.rent()]);
    const { n } = col.mintForCount(t, BigInt(slot), balances[0], cfg.unit);
    if (n === 0) return [];
    if (col.depositOf(info.lamports, info.data.length, rent) < col.mintForCost(rent, cfg, info.data.length, t.owned.length, n)) return [];
    const coins = col.coinsAddress(user, cfg.baseMint, cfg.tokenProgram);
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), col.mintFor(payer, pool, user, t.minted, Math.min(col.MAX_MINT_PER_CALL, t.pending), coins)];
  }

  /// The wallet takes its whole deposit on `pool` back. Empty when there is none. The deposit
  /// is what `withdraw_deposit` pays: the program first shrinks the ticket to its list, so a
  /// ticket longer than its list gives the rent of its spare bytes back too
  /// (`collectible.withdrawableDeposit`). Read at the chain's rent: a ticket on mainnet holds
  /// 891,120 lamports more above its rent than the local rent would say.
  async collectibleWithdrawInstructions(user: PublicKey, pool: PublicKey): Promise<TransactionInstruction[]> {
    return (await col.ticketDeposit(this.connection, pool, user, await this.rent())) > 0n ? [col.withdrawDeposit(user, pool)] : [];
  }

  /// What a sell of `amountIn` coins would cost `user` in pieces on a collectible pool:
  /// the peg after the sell. Null when the pool has no collection or the wallet no ticket.
  async collectiblePegAfterSell(user: PublicKey, pool: PublicKey, amountIn: bigint): Promise<col.PegStatus | null> {
    const [t, cfg] = await Promise.all([col.fetchTicket(this.connection, pool, user), col.fetchCollectionConfig(this.connection, pool)]);
    if (!t || !cfg) return null;
    const [balance] = await col.fetchBacking(this.connection, cfg, [user]);
    return col.pegStatus(t, balance > amountIn ? balance - amountIn : 0n, cfg.unit);
  }

  /// Move one of `user`'s pieces from position `from` to position `to` of its list. The
  /// program refuses while the wallet is above the peg.
  async collectibleReorderInstructions(user: PublicKey, pool: PublicKey, from: number, to: number): Promise<TransactionInstruction[]> {
    const cfg = await col.fetchCollectionConfig(this.connection, pool);
    if (!cfg) throw new Error("this pool has no collection");
    return [col.reorder(user, pool, from, to, col.coinsAddress(user, cfg.baseMint, cfg.tokenProgram))];
  }

  /// Settle a wallet on a collectible pool: drop and burn what its coins no longer back.
  /// Anyone may send it for any wallet; `payer` receives the rent of the burned pieces.
  /// Returns an empty list when the wallet is fully backed.
  async collectibleSettleInstructions(payer: PublicKey, pool: PublicKey, user: PublicKey): Promise<TransactionInstruction[]> {
    const [t, cfg] = await Promise.all([col.fetchTicket(this.connection, pool, user), col.fetchCollectionConfig(this.connection, pool)]);
    if (!t || !cfg) return [];
    const coins = col.coinsAddress(user, cfg.baseMint, cfg.tokenProgram);
    const [balance] = await col.fetchBacking(this.connection, cfg, [user]);
    const peg = col.pegStatus(t, balance, cfg.unit);
    if (peg.dropWaiting === 0 && peg.burn.length === 0) return [];
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), col.settle(payer, pool, user, coins, peg.burn.slice(0, col.MAX_BURNS_PER_SETTLE))];
  }

  /// Send up to four pieces to another wallet, each with the `unit` coins behind it. The
  /// receiver's token account is created if it does not exist. On a pegged coin this is a
  /// plain transfer of the coins: the pieces are put last, staged, and the coin's own hook
  /// moves them; the receiver's ticket is opened first, and the Metaplex assets are
  /// delivered in the same transaction.
  async collectibleSendInstructions(user: PublicKey, pool: PublicKey, to: PublicKey, pieces: PublicKey[]): Promise<TransactionInstruction[]> {
    const cfg = await col.fetchCollectionConfig(this.connection, pool);
    if (!cfg) throw new Error("this pool has no collection");
    if (cfg.pegged) {
      if (pieces.length < 1 || pieces.length > col.MAX_SEND) throw new Error("send between 1 and 4 pieces at a time");
      const [mine, theirs, mintInfo, balances] = await Promise.all([
        col.fetchTicket(this.connection, pool, user), col.fetchTicket(this.connection, pool, to), this.mint(cfg.baseMint), col.fetchBacking(this.connection, cfg, [user, to]),
      ]);
      if (!mine || !mintInfo) throw new Error("this wallet holds no pieces of this coin");
      // what the program would refuse, or do differently from what was asked, said before signing
      const amount = cfg.unit * BigInt(pieces.length);
      if (BigInt(mine.owned.length + mine.pending) > balances[0] / cfg.unit) throw new Error("this wallet holds more pieces than its coins back: settle it first");
      if (balances[0] < amount) throw new Error("this wallet does not hold the coins that travel with the pieces");
      const fresh: col.Ticket = { bump: 0, pool, user: to, minted: 0, rolls: 0, staged: 0, stagedSlot: 0n, batches: [], owned: [], pending: 0 };
      const would = col.predictTransfer(mine, balances[0], theirs ?? fresh, balances[1], amount, cfg.unit, { staged: pieces.length });
      if (would.moved.length < pieces.length) throw new Error("the receiving wallet has no room for these pieces");
      const coins = col.coinsAddress(user, cfg.baseMint, cfg.tokenProgram);
      const out: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix.createAtaIdempotent(user, to, cfg.baseMint, cfg.tokenProgram)];
      if (!theirs) out.push(col.openTicketFor(user, pool, to));
      // put the chosen pieces last, in the order given
      const list = mine.owned.map((k) => k.toBase58());
      for (const p of pieces) {
        const at = list.indexOf(p.toBase58());
        if (at < 0) throw new Error("this wallet does not hold that piece");
        if (at !== list.length - 1) { out.push(col.reorder(user, pool, at, list.length - 1, coins)); list.push(list.splice(at, 1)[0]); }
      }
      // the stage names the pieces: if the list changed before this lands, nothing is sent
      out.push(col.stage(user, pool, pieces, coins));
      out.push(col.peggedTransfer(user, to, pool, cfg.baseMint, amount, mintInfo.decimals));
      out.push(col.deliver(user, pool, to, pieces));
      return out;
    }
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix.createAtaIdempotent(user, to, cfg.baseMint, cfg.tokenProgram),
      col.sendPieces(user, pool, to, cfg.baseMint, cfg.tokenProgram, pieces),
    ];
  }

  /// A plain transfer of `amount` coins of a pegged coin to another wallet, the way a
  /// wallet's Send button does it, plus what a wallet does not do: the receiver's token
  /// account and ticket are opened first, so the pieces that leave the sender arrive
  /// instead of burning, and their Metaplex assets are delivered (or burned) in the same
  /// transaction. `outcome` says which pieces move and which burn.
  async collectibleTransferInstructions(user: PublicKey, pool: PublicKey, to: PublicKey, amount: bigint): Promise<{ instructions: TransactionInstruction[]; outcome: col.TransferOutcome }> {
    const cfg = await col.fetchCollectionConfig(this.connection, pool);
    if (!cfg || !cfg.pegged) throw new Error("this coin is not a pegged coin");
    const [mine, theirs, mintInfo, balances] = await Promise.all([
      col.fetchTicket(this.connection, pool, user), col.fetchTicket(this.connection, pool, to), this.mint(cfg.baseMint), col.fetchBacking(this.connection, cfg, [user, to]),
    ]);
    if (!mintInfo) throw new Error("the coin could not be read");
    const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix.createAtaIdempotent(user, to, cfg.baseMint, cfg.tokenProgram)];
    // the receiver's ticket, with the room its new coins give it
    const fresh: col.Ticket = { bump: 0, pool, user: to, minted: 0, rolls: 0, staged: 0, stagedSlot: 0n, batches: [], owned: [], pending: 0 };
    const outcome = col.predictTransfer(mine, balances[0], theirs ?? fresh, balances[1], amount, cfg.unit);
    if (!theirs && outcome.moved.length > 0) instructions.push(col.openTicketFor(user, pool, to));
    instructions.push(col.peggedTransfer(user, to, pool, cfg.baseMint, amount, mintInfo.decimals));
    if (outcome.moved.length > 0) instructions.push(col.deliver(user, pool, to, outcome.moved.slice(0, col.MAX_BURNS_PER_SETTLE)));
    if (outcome.burned.length > 0) instructions.push(col.reap(user, pool, outcome.burned.slice(0, col.MAX_BURNS_PER_SETTLE)));
    return { instructions, outcome };
  }

  /// The delivery and burn work a pegged pool has waiting: Metaplex assets to hand to the
  /// wallets whose lists hold them, and queued pieces to burn. For keepers; `payer`
  /// receives the rent of what it burns. Each inner list is one transaction.
  async collectibleUpkeepInstructions(payer: PublicKey, pool: PublicKey): Promise<TransactionInstruction[][]> {
    const [undelivered, queue] = await Promise.all([col.fetchUndelivered(this.connection, pool), col.fetchQueue(this.connection, pool)]);
    const out: TransactionInstruction[][] = [];
    const budget = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    for (const u of undelivered) for (let i = 0; i < u.assets.length; i += col.MAX_BURNS_PER_SETTLE) out.push([budget(), col.deliver(payer, pool, u.holder, u.assets.slice(i, i + col.MAX_BURNS_PER_SETTLE))]);
    for (let i = 0; i < queue.length; i += col.MAX_BURNS_PER_SETTLE) out.push([budget(), col.reap(payer, pool, queue.slice(i, i + col.MAX_BURNS_PER_SETTLE))]);
    return out;
  }

  /// True when an account exists at this address.
  async exists(address: PublicKey): Promise<boolean> {
    return (await this.connection.getAccountInfo(address, { dataSlice: { offset: 0, length: 0 } })) !== null;
  }

  /// Turn the wrapped SOL of `owner` into plain SOL and leave the wrapped account open and
  /// empty. This is how the owner of a tax treasury takes the tax: the account is closed
  /// and opened again inside one transaction, so the coin's fees never find it missing.
  /// `owner` signs.
  unwrapInstructions(owner: PublicKey): TransactionInstruction[] {
    const wsol = pda.ata(owner, NATIVE_MINT);
    return [ix.closeAccount(wsol, owner, owner), ix.createAtaIdempotent(owner, owner, NATIVE_MINT)];
  }

  /// The slot and the Unix time the programs see right now (the Clock sysvar).
  async chainTime(): Promise<{ slot: bigint; unixTime: bigint }> {
    const info = await this.connection.getAccountInfo(CLOCK_SYSVAR);
    if (!info || info.data.length < 40) throw new Error("the clock sysvar could not be read");
    return clockOf(new Uint8Array(info.data));
  }

  /// One call of a buyback pool's buy instruction: what it does now, what the next buy
  /// spends and buys, and the transaction. Anyone may send it. See `BurnRun`.
  ///
  /// The rule (HOOKS.md section 7): a buy is made against an observation of the pool that
  /// the instruction itself recorded at least `BURN_INTERVAL_SLOTS` (25 slots) earlier. So
  /// a pool's first call only records one, and a keeper calls twice: once to record, once
  /// 25 slots later to buy. A buy spends at most the pool's cap (`buybackCapBps`: it follows
  /// the pool's fees, between 0.01% and 0.5%) of the smaller of the quote reserve now and
  /// the observed one, so a large treasury takes several buys.
  ///
  /// Returns null when the pool has no buyback hook or its treasury is below the pool's
  /// minimum. `treasuryLeft` is `potLeft` under its older name.
  async buybackInstructions(payer: PublicKey, pool: Pool, slippageBps = 300): Promise<(BurnRun & { treasuryLeft: bigint }) | null> {
    if (!pool.hookProgram.equals(PROGRAMS.hook_buyback)) return null;
    const { context, value: [cfgInfo, treasuryInfo, platformInfo, poolInfo] } = await this.connection.getMultipleAccountsInfoAndContext(
      [pda.cfg(PROGRAMS.hook_buyback, pool.address), pool.hookQuoteTreasury, pda.platform(), pool.address]);
    if (!cfgInfo || !treasuryInfo || !platformInfo || !poolInfo) return null;
    const cfg = decodeBuybackConfig(new Uint8Array(cfgInfo.data));
    const platform = decodePlatform(new Uint8Array(platformInfo.data));
    // the reserves decide the cap and the price: use the pool as it is in this same read
    const now = decodePool(pool.address, new Uint8Array(poolInfo.data));
    return this.buybackRun(payer, now, cfg, decodeTokenAmount(new Uint8Array(treasuryInfo.data)), platform, BigInt(context.slot), slippageBps);
  }

  /// `buybackInstructions` from a read made before (`poolView` makes it): the pool, its buyback
  /// config, what its treasury holds, the platform and the slot of that read. No read.
  buybackRun(payer: PublicKey, pool: Pool, config: BuybackConfig, treasury: bigint, platform: Platform, slot: bigint, slippageBps = 300): (BurnRun & { treasuryLeft: bigint }) | null {
    if (treasury === 0n || treasury < config.minQuote) return null;
    const run = this.burnRun(pool, platform, treasury, buybackCapBps(config, platform, pool.lpFeeBps),
      { slot: config.obsSlot, reserveBase: config.obsReserveBase, reserveQuote: config.obsReserveQuote }, slot, slippageBps,
      (minOut) => [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix.executeBuyback(payer, this.keys(pool), minOut)]);
    return { ...run, treasuryLeft: run.potLeft };
  }

  /// What the two buy-and-burn templates share: `burnStep` decides what a call does, and
  /// the pool's own math prices the buy. All of the rule is in `burnStep` (math.ts).
  private burnRun(
    pool: Pool, platform: Platform, pot: bigint, capBps: number, obs: BurnObservation, slot: bigint, slippageBps: number,
    build: (minOut: bigint) => TransactionInstruction[],
  ): BurnRun {
    // the programs measure prices and depths on the effective quote (the real reserve plus
    // the virtual quote of a pool on the curve; the same thing on a seeded pool)
    const effective = pool.reserveQuote + pool.virtualQuote;
    const now = burnStep(obs, pool.reserveBase, effective, slot, capBps, pot);
    // the buy this call makes, or else the one that follows if the pool stands as it is
    const next = now.step === "tooSoon" ? burnStep(obs, pool.reserveBase, effective, now.dueSlot, capBps, pot) : now;
    const spend = next.step === "buy" ? next.spend : buybackSpend(pot, effective, capBps);
    const none = obs.reserveBase === 0n || obs.reserveQuote === 0n;
    const base = {
      step: now.step, due: now.step !== "tooSoon", dueSlot: now.step === "tooSoon" ? now.dueSlot : none ? 0n : obs.slot + BURN_INTERVAL_SLOTS, slot,
      observation: none ? null : obs, pot, capBps, spend, potLeft: pot - spend,
    };
    // A call that only records an observation buys nothing: nothing is quoted and it
    // carries no floor. The chain accepts it as long as the pot is not empty, however
    // small, so a pot of a few lamports (rounding) still gets its observation.
    if (now.step !== "buy") return { ...base, expectedOut: 0n, minOut: 0n, instructions: now.step === "tooSoon" ? [] : build(0n) };
    // a buy by the hook itself: pool fee and protocol fee, no hook fee, no sniper fee
    let q: SwapQuote;
    try {
      q = quoteSwap({ direction: DIRECTION.BUY, amountIn: spend, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: pool.virtualQuote, lpFeeBps: pool.lpFeeBps, protocolFeeBps: platform.protocolFeeBps, hookFeeBps: 0 });
    } catch (e) {
      // the pool would refuse the buy (nothing is left after the fees): not due, and no
      // exception, so that a keeper that walks every pool is not stopped by a tiny pot
      return {
        ...base, due: false, expectedOut: 0n, minOut: 0n, instructions: [],
        reason: `the pot's ${spend} lamport${spend === 1n ? "" : "s"} cannot buy anything: ${(e as Error).message}; the pool would refuse the buy, so the call is not due until more fees reach the pot`,
      };
    }
    const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    return { ...base, expectedOut: q.amountOut, minOut, instructions: build(minOut) };
  }

  // ---- the "launch rules" template -----------------------------------------------------------

  /// A rules pool as of now: the config as stored, and the same after the settlement the
  /// program would run this moment (the numbers in the account are one trade behind).
  /// Pool, config and clock come from one read, so they agree. null when the pool does
  /// not run the rules template.
  async rulesState(pool: PublicKey | Pool): Promise<RulesState | null> {
    const address = addressOf(pool);
    const [poolInfo, cfgInfo, clockInfo] = await this.connection.getMultipleAccountsInfo([address, rulesPda.cfg(address), CLOCK_SYSVAR]);
    return rulesStateFromAccounts(address, poolInfo, cfgInfo, clockInfo);
  }

  /// Everything a page shows about a rules coin, in ONE read: the state (`rulesState`), the
  /// creator lock (`rulesLock`), the next burn (`rulesBurnInstructions`, sent by `payer`) and,
  /// with a `wallet`, its stake (`rulesStakeOf`) or, on a strict coin, its holder record
  /// (`rulesHolderOf`). Each part is what its own method returns; they all come from the same
  /// slot. `platform` is needed for the burn (`run` is null without it). `config` is a config
  /// read before (any earlier read): on a strict coin it names the creator, whose coin account
  /// holds the lock, so that the read stays one. Without it a strict coin costs one more read.
  /// null when the pool does not run the rules template.
  async rulesView(pool: PublicKey | Pool, opts: { wallet?: PublicKey | null; payer?: PublicKey; platform?: Platform | null; config?: RulesConfig | null; slippageBps?: number } = {}): Promise<RulesView | null> {
    const address = addressOf(pool);
    const keys = rulesViewKeys(address, (pool as Pool).baseMint ?? null, opts.wallet ?? null, opts.config ?? null);
    const { context, value } = await this.connection.getMultipleAccountsInfoAndContext(keys.list);
    return this.rulesViewFrom(address, keys, value, BigInt(context.slot), opts);
  }

  /// The second half of `rulesView` (and of `poolView`): the parts from the accounts read.
  private async rulesViewFrom(address: PublicKey, keys: RulesViewKeys, infos: AccountData[], _slot: bigint, opts: { wallet?: PublicKey | null; payer?: PublicKey; platform?: Platform | null; slippageBps?: number }): Promise<RulesView | null> {
    const get = (k: PublicKey | null) => (k ? infos[keys.list.findIndex((x) => x.equals(k))] ?? null : null);
    const poolInfo = get(address), cfgInfo = get(keys.cfg), clockInfo = get(CLOCK_SYSVAR);
    const state = rulesStateFromAccounts(address, poolInfo, cfgInfo, clockInfo);
    if (!state) return null;
    const w = opts.wallet ?? null;
    // a strict coin whose creator (or coin) was not known before this read: the creator's coin
    // account and the wallet's, read now in one more call
    let creatorAta: AccountData | undefined = keys.creatorAta ? get(keys.creatorAta) : undefined;
    let walletAta: AccountData | undefined = keys.walletAta ? get(keys.walletAta) : undefined;
    if (state.config.strict && (creatorAta === undefined || (w && walletAta === undefined))) {
      const c = state.config;
      const [a, b] = await this.connection.getMultipleAccountsInfo([pda.ata(c.creator, c.baseMint, TOKEN_2022_PROGRAM), pda.ata(w ?? c.creator, c.baseMint, TOKEN_2022_PROGRAM)]);
      if (creatorAta === undefined) creatorAta = a;
      if (walletAta === undefined) walletAta = b;
    }
    const lock = rulesLockFromAccounts(address, cfgInfo, clockInfo, get(keys.lock), get(keys.vault), creatorAta ?? null);
    const stake = w && !state.config.strict ? rulesStakeFromAccounts(address, w, poolInfo, cfgInfo, clockInfo, get(keys.stake)) : null;
    const holder = w && state.config.strict ? rulesHolderFromAccounts(address, w, poolInfo, cfgInfo, clockInfo, get(keys.holder), walletAta ?? null) : null;
    const run = opts.platform ? this.rulesBurnRun(opts.payer ?? w ?? PublicKey.default, state, opts.platform, opts.slippageBps ?? 300) : null;
    return { state, lock, stake, holder, run, slot: state.slot };
  }

  /// A wallet on a strict coin: what its coin account holds, what its holder record
  /// counts, what a claim would pay now (settled the way the program settles), its early
  /// coins and the creator lock, and what it may move now. null when the pool is not a
  /// strict coin of the rules template.
  async rulesHolderOf(pool: PublicKey | Pool, wallet: PublicKey): Promise<RulesHolderInfo | null> {
    const address = addressOf(pool);
    const [poolInfo, cfgInfo, clockInfo] = await this.connection.getMultipleAccountsInfo([address, rulesPda.cfg(address), CLOCK_SYSVAR]);
    if (!poolInfo || !cfgInfo || !clockInfo || !cfgInfo.owner.equals(PROGRAMS.hook_rules)) return null;
    const cfg = decodeRulesConfig(new Uint8Array(cfgInfo.data));
    if (!cfg.strict) return null;
    const [recInfo, ataInfo] = await this.connection.getMultipleAccountsInfo([rulesPda.holder(address, wallet), pda.ata(wallet, cfg.baseMint, TOKEN_2022_PROGRAM)]);
    return rulesHolderFromAccounts(address, wallet, poolInfo, cfgInfo, clockInfo, recInfo, ataInfo);
  }

  /// A wallet's stake on a rules pool: what it staked, what a claim would pay it now
  /// (settled the way the program settles), and from which slot it may unstake. null when
  /// the pool does not run the rules template.
  async rulesStakeOf(pool: PublicKey | Pool, wallet: PublicKey): Promise<RulesStakeInfo | null> {
    const address = addressOf(pool);
    const stake = rulesPda.stake(address, wallet);
    const [poolInfo, cfgInfo, clockInfo, recInfo] = await this.connection.getMultipleAccountsInfo([address, rulesPda.cfg(address), CLOCK_SYSVAR, stake]);
    return rulesStakeFromAccounts(address, wallet, poolInfo, cfgInfo, clockInfo, recInfo);
  }

  /// The creator lock of a rules pool: the lock record, the balance of the lock vault, and
  /// what the launcher declared. A page shows the record and the vault, not the
  /// declaration: the program cannot make a launcher lock anything. null when the pool
  /// does not run the rules template.
  async rulesLock(pool: PublicKey | Pool): Promise<RulesLockInfo | null> {
    const address = addressOf(pool);
    const lockKey = rulesPda.lock(address), vault = rulesPda.lockVault(address);
    const [cfgInfo, clockInfo, lockInfo, vaultInfo] = await this.connection.getMultipleAccountsInfo([rulesPda.cfg(address), CLOCK_SYSVAR, lockKey, vault]);
    if (!cfgInfo || !clockInfo || !cfgInfo.owner.equals(PROGRAMS.hook_rules)) return null;
    const cfg = decodeRulesConfig(new Uint8Array(cfgInfo.data));
    // a strict coin has no lock vault: the locked coins stay in the creator's own coin account
    const ata = cfg.strict ? await this.connection.getAccountInfo(pda.ata(cfg.creator, cfg.baseMint, TOKEN_2022_PROGRAM)) : null;
    return rulesLockFromAccounts(address, cfgInfo, clockInfo, lockInfo, vaultInfo, ata);
  }

  /// Stake `amount` coins of the wallet on a rules pool. The first stake opens the wallet's
  /// stake record (the wallet pays its rent, which never comes back). Every stake restarts
  /// the unstake delay of everything the wallet has staked.
  async rulesStakeInstructions(user: PublicKey, pool: Pool, amount: bigint): Promise<TransactionInstruction[]> {
    if (amount <= 0n) throw new Error("amount must be greater than zero");
    if (await this.isStrictPool(pool)) throw new StrictRefusal(RULES_ERRORS[6034]);
    return [ix.rulesStake(user, this.keys(pool), amount)];
  }

  /// Take `amount` staked coins back into the wallet's token account, which is created if
  /// the wallet closed it. The program refuses until `UNSTAKE_DELAY_SLOTS` after the
  /// wallet's last stake: `rulesStakeOf(...).canUnstake` tells beforehand.
  async rulesUnstakeInstructions(user: PublicKey, pool: Pool, amount: bigint): Promise<TransactionInstruction[]> {
    if (amount <= 0n) throw new Error("amount must be greater than zero");
    const out: TransactionInstruction[] = [];
    if (!(await this.exists(pda.ata(user, pool.baseMint, pool.baseTokenProgram)))) out.push(ix.createAtaIdempotent(user, user, pool.baseMint, pool.baseTokenProgram));
    out.push(ix.rulesUnstake(user, this.keys(pool), amount));
    return out;
  }

  /// Claim a staker's rewards. `amount` is what the claim pays if it lands now, computed
  /// the way the program does (a trade that lands first adds to it); `instructions` is
  /// empty when there is nothing to claim.
  ///
  /// Wrapped SOL, the SDK's rule: a wallet that had no wrapped SOL account receives plain
  /// SOL (the account lives for the length of the transaction); a wallet that had one
  /// keeps it open, with the rewards inside it, wrapped.
  async rulesClaimRewardsInstructions(user: PublicKey, pool: Pool): Promise<{ amount: bigint; instructions: TransactionInstruction[] }> {
    if (await this.isStrictPool(pool)) return this.rulesClaimHolderInstructions(user, pool);
    const info = await this.rulesStakeOf(pool.address, user);
    if (!info || info.claimable === 0n) return { amount: 0n, instructions: [] };
    return { amount: info.claimable, instructions: await this.payoutInstructions(user, pool, (to) => ix.rulesClaimRewards(user, this.keys(pool), to)) };
  }

  /// Strict coin: claim what the wallet's holder record is owed (`claim_holder`). Same
  /// shape and wrapped SOL rule as `rulesClaimRewardsInstructions`, which calls this on a
  /// strict coin. Empty when there is nothing to claim or no record.
  async rulesClaimHolderInstructions(user: PublicKey, pool: Pool): Promise<{ amount: bigint; instructions: TransactionInstruction[] }> {
    const info = await this.rulesHolderOf(pool.address, user);
    if (!info || !info.record || info.claimable === 0n) return { amount: 0n, instructions: [] };
    return { amount: info.claimable, instructions: await this.payoutInstructions(user, pool, (to) => ix.rulesClaimHolder(user, this.keys(pool), to)) };
  }

  /// Strict coin: open the wallet's holder record (empty when it has one). From then on the
  /// wallet's balance earns the holders' share. Rent about 0.0013 SOL on mainnet, back on close.
  async rulesOpenHolderInstructions(user: PublicKey, pool: Pool): Promise<TransactionInstruction[]> {
    if (await this.exists(rulesPda.holder(pool.address, user))) return [];
    return [ix.rulesOpenHolder(user, this.keys(pool))];
  }
  /// Strict coin: lower `wallet`'s record to what it really holds, after a token Burn.
  /// Anyone may send it. Empty when the record does not stand above the balance.
  async rulesSyncHolderInstructions(pool: Pool, wallet: PublicKey): Promise<TransactionInstruction[]> {
    const info = await this.rulesHolderOf(pool.address, wallet);
    if (!info || !info.record || info.counted <= info.balance) return [];
    return [ix.rulesSyncHolder(this.keys(pool), wallet)];
  }
  /// Strict coin: close the wallet's holder record and get its rent back. Throws what the
  /// program would refuse: a record that still holds coins, rewards, a lock or early coins
  /// under their lock (`HolderNotEmpty`). Claim first.
  async rulesCloseHolderInstructions(user: PublicKey, pool: Pool): Promise<TransactionInstruction[]> {
    const info = await this.rulesHolderOf(pool.address, user);
    if (!info || !info.record) throw new Error("this wallet has no holder record on this coin");
    if (info.counted > 0n || info.record.owed > 0n || info.claimable > 0n || info.record.locked > 0n || info.earlyLocked) throw new StrictRefusal(RULES_ERRORS[6049]);
    return [ix.rulesCloseHolder(user, this.keys(pool))];
  }

  /// Strict coin: send `amount` coins from `user` to the wallet `to` (Token-2022
  /// `TransferChecked` with the hook's accounts). The receiver's associated token account
  /// is created when it is missing. Throws a `StrictRefusal` for what the coin's transfer
  /// hook would refuse (early coins, the creator lock, the receiver's max wallet), unless
  /// `opts.check` is false.
  async strictSendInstructions(user: PublicKey, pool: Pool, to: PublicKey, amount: bigint, opts: { check?: boolean } = {}): Promise<TransactionInstruction[]> {
    if (amount <= 0n) throw new Error("amount must be greater than zero");
    const [mintInfo, toAta] = await Promise.all([this.mint(pool.baseMint), this.connection.getAccountInfo(pda.ata(to, pool.baseMint, TOKEN_2022_PROGRAM))]);
    if (!mintInfo) throw new Error("the coin could not be read");
    if (opts.check !== false) {
      const [state, from, dest] = await Promise.all([this.rulesState(pool.address), this.rulesHolderOf(pool.address, user), this.rulesHolderOf(pool.address, to)]);
      if (!state || !state.config.strict || !from || !dest) throw new Error("this pool's coin is not a strict coin");
      const refusal = strictTransferRefusal(state.config, { kind: "send", amount, from: { balance: from.balance, record: from.record }, to: { balance: dest.balance, record: dest.record } }, state.slot, state.unixTime);
      if (refusal) throw new StrictRefusal(refusal);
    }
    const out: TransactionInstruction[] = [];
    if (!toAta) out.push(ix.createAtaIdempotent(user, to, pool.baseMint, TOKEN_2022_PROGRAM));
    out.push(ix.strictTransfer(user, to, pool.address, pool.baseMint, amount, mintInfo.decimals));
    return out;
  }

  /// Claim the creator fee collected so far. `creator` must be the config's creator.
  /// `amount` is what the claim pays if it lands now; `instructions` is empty when there
  /// is nothing to claim. Wrapped SOL: the same rule as `rulesClaimRewardsInstructions`.
  async rulesClaimCreatorInstructions(creator: PublicKey, pool: Pool): Promise<{ amount: bigint; instructions: TransactionInstruction[] }> {
    const state = await this.rulesState(pool.address);
    if (!state || state.creatorClaimable === 0n) return { amount: 0n, instructions: [] };
    if (!state.config.creator.equals(creator)) throw new Error("only the wallet that launched the coin can claim its creator fee");
    return { amount: state.creatorClaimable, instructions: await this.payoutInstructions(creator, pool, (to) => ix.rulesClaimCreator(creator, this.keys(pool), to)) };
  }

  /// A payout in the quote token to the wallet's own associated account, leaving a wrapped
  /// SOL account as it was found.
  private async payoutInstructions(wallet: PublicKey, pool: Pool, pay: (to: PublicKey) => TransactionInstruction): Promise<TransactionInstruction[]> {
    const to = pda.ata(wallet, pool.quoteMint, pool.quoteTokenProgram);
    const had = await this.exists(to);
    const out: TransactionInstruction[] = [];
    if (!had) out.push(ix.createAtaIdempotent(wallet, wallet, pool.quoteMint, pool.quoteTokenProgram));
    out.push(pay(to));
    if (!had && pool.quoteMint.equals(NATIVE_MINT)) out.push(ix.closeAccount(to, wallet, wallet));
    return out;
  }

  /// One call of a rules coin's burn: what it does now, what the next buy spends from the
  /// burn pot and buys, and the transaction. Anyone may send it; what it buys is burned.
  /// See `BurnRun`.
  ///
  /// The same rule as a buyback (`buybackInstructions`): a buy is made against an
  /// observation at least 25 slots old, so the first call only records one. The cap of a
  /// buy is `rulesBurnCapBps`. `pot` counts in the fee of the last trade, which the call
  /// settles first.
  ///
  /// Returns null when the pool does not run the rules template or its pot is empty.
  async rulesBurnInstructions(payer: PublicKey, pool: PublicKey | Pool, slippageBps = 300): Promise<BurnRun | null> {
    const address = addressOf(pool);
    const [state, platform] = await Promise.all([this.rulesState(address), this.platform()]);
    if (!state || !platform) return null;
    return this.rulesBurnRun(payer, state, platform, slippageBps);
  }

  /// `rulesBurnInstructions` from a state read before (`rulesState`, `rulesView`). No read.
  rulesBurnRun(payer: PublicKey, state: RulesState, platform: Platform, slippageBps = 300): BurnRun | null {
    if (state.burnPot === 0n) return null;
    const c = state.settled;
    return this.burnRun(state.pool, platform, c.burnPot, rulesBurnCapBps(c, platform, state.pool.lpFeeBps),
      { slot: c.obsSlot, reserveBase: c.obsReserveBase, reserveQuote: c.obsReserveQuote }, state.slot, slippageBps,
      (minOut) => [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), state.config.strict ? ix.rulesRunBurnStrict(payer, this.keys(state.pool), minOut) : ix.rulesRunBurn(payer, this.keys(state.pool), minOut)]);
  }

  /// Lock coins of the creator, or move the end of the lock later. `amount` may be
  /// `LOCK_WHOLE_BALANCE` (everything in the creator's token account), or zero once
  /// something is locked. `unlockAt` is a Unix time in seconds: never earlier than the
  /// lock already set, never before the launch plus the declared lock, at most 365 days
  /// ahead. The first lock creates the lock record and the lock vault (rent paid by the
  /// creator). A launch with a declared lock already carries this instruction.
  ///
  /// A strict coin: `lock_creator_strict`. The coins stay in the creator's wallet; the
  /// creator needs a holder record (opened in front when it has none).
  async rulesLockInstructions(creator: PublicKey, pool: Pool, amount: bigint, unlockAt: bigint): Promise<TransactionInstruction[]> {
    if (await this.isStrictPool(pool)) {
      const out = await this.rulesOpenHolderInstructions(creator, pool);
      out.push(ix.rulesLockCreatorStrict(creator, this.keys(pool), amount, BigInt(unlockAt)));
      return out;
    }
    return [ix.rulesLockCreator(creator, this.keys(pool), amount, BigInt(unlockAt))];
  }

  /// Take everything in the lock vault back into the creator's token account, which is
  /// created if the creator closed it. The program refuses before the unlock time:
  /// `rulesLock(...).locked` tells beforehand.
  async rulesUnlockInstructions(creator: PublicKey, pool: Pool): Promise<TransactionInstruction[]> {
    if (await this.isStrictPool(pool)) return [ix.rulesUnlockCreatorStrict(creator, this.keys(pool))];
    const out: TransactionInstruction[] = [];
    if (!(await this.exists(pda.ata(creator, pool.baseMint, pool.baseTokenProgram)))) out.push(ix.createAtaIdempotent(creator, creator, pool.baseMint, pool.baseTokenProgram));
    out.push(ix.rulesUnlockCreator(creator, this.keys(pool)));
    return out;
  }

  /// Hook fees wait in the pool while the treasury account does not exist: the wrapped SOL
  /// account of a tax coin's dev is closed every time the dev unwraps it. This recreates
  /// the account for its owner and pays what waited. Anyone may send it; `payer` pays the
  /// account's rent when it has to be created. Empty when nothing waits.
  async hookFeesInstructions(payer: PublicKey, pool: Pool): Promise<TransactionInstruction[]> {
    if (!pool.hasHook || pool.hookFeesOwedQuote === 0n) return [];
    return [
      ix.createAtaIdempotent(payer, pool.hookTreasuryOwner, pool.quoteMint, pool.quoteTokenProgram),
      ix.collectHookFees(this.keys(pool), pool.hookQuoteTreasury),
    ];
  }

  /// Pay a pool's protocol fees to the platform treasury (`collect_protocol_fees`). Anyone
  /// may send it; the money only goes to the treasury wallet's own token accounts. On a
  /// strict coin the coin's part runs the coin's transfer hook: its accounts are added
  /// (`strictCollectExtras`). Empty when the pool holds no protocol fee.
  async collectProtocolFeesInstructions(payer: PublicKey, pool: Pool): Promise<TransactionInstruction[]> {
    if (pool.protocolFeesBase === 0n && pool.protocolFeesQuote === 0n) return [];
    const platform = await this.platform();
    if (!platform) throw new Error("the platform could not be read");
    const extra = (await this.isStrictPool(pool)) ? ix.strictCollectExtras(pool.address, pool.baseMint, platform.treasury) : [];
    return [ix.collectProtocolFees(payer, this.keys(pool), platform.treasury, extra)];
  }

  /// Wrapped SOL: same rule as swaps. The account is closed at the end only when this
  /// transaction opened it; a wallet that already had one keeps it, with the change inside.
  /// A pool on the curve refuses liquidity until it graduates: this throws a `CurveRefusal`
  /// (`CurveOpen`, "liquidity opens at graduation") before anything is built, as
  /// `removeLiquidityInstructions` does.
  async addLiquidityInstructions(user: PublicKey, pool: Pool, lpAmount: bigint, maxBase: bigint, maxQuote: bigint): Promise<TransactionInstruction[]> {
    if (pool.curveState === CURVE_OPEN) throw new CurveRefusal(CURVE_ERRORS[6045]);
    const hook = await this.hookRef(pool, user);
    const wsolWasOpen = pool.quoteMint.equals(NATIVE_MINT) && (await this.exists(pda.ata(user, NATIVE_MINT)));
    const k = this.keys(pool);
    const out: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ix.createAtaIdempotent(user, user, pool.lpMint)];
    if (pool.quoteMint.equals(NATIVE_MINT)) {
      out.push(ix.createAtaIdempotent(user, user, NATIVE_MINT));
      out.push(ix.transferLamports(user, pda.ata(user, NATIVE_MINT), maxQuote));
      out.push(ix.syncNative(pda.ata(user, NATIVE_MINT)));
    }
    out.push(ix.addLiquidity(user, k, hook, lpAmount, maxBase, maxQuote));
    if (pool.quoteMint.equals(NATIVE_MINT) && !wsolWasOpen) out.push(ix.closeAccount(pda.ata(user, NATIVE_MINT), user, user));
    return out;
  }

  async removeLiquidityInstructions(user: PublicKey, pool: Pool, lpAmount: bigint, minBase: bigint, minQuote: bigint): Promise<TransactionInstruction[]> {
    if (pool.curveState === CURVE_OPEN) throw new CurveRefusal(CURVE_ERRORS[6045]);
    const hook = await this.hookRef(pool, user);
    const wsolWasOpen = pool.quoteMint.equals(NATIVE_MINT) && (await this.exists(pda.ata(user, NATIVE_MINT)));
    const k = this.keys(pool);
    const out: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })];
    out.push(ix.createAtaIdempotent(user, user, pool.baseMint, pool.baseTokenProgram));
    out.push(ix.createAtaIdempotent(user, user, pool.quoteMint, pool.quoteTokenProgram));
    out.push(ix.removeLiquidity(user, k, hook, lpAmount, minBase, minQuote));
    if (pool.quoteMint.equals(NATIVE_MINT) && !wsolWasOpen) out.push(ix.closeAccount(pda.ata(user, NATIVE_MINT), user, user));
    return out;
  }

  /// A pool created directly, without the launchpad. `create_pool` can pass 200,000 compute
  /// units even without a hook, depending on the addresses, so this asks for 400,000.
  ///
  /// `baseTokenProgram`: TOKEN_2022_PROGRAM for a Token-2022 coin (a strict coin's hook ref
  /// then carries `strictPoolExtras(pool, mint, creator)` after the config).
  async createPoolInstructions(creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, lpFeeBps: number, baseAmount: bigint, quoteAmount: bigint, hook: HookRef = NO_HOOK, baseTokenProgram: PublicKey = TOKEN_PROGRAM): Promise<TransactionInstruction[]> {
    if (!hook.program.equals(SYSTEM_PROGRAM) && !isTemplateProgram(hook.program)) {
      const platform = await this.platform();
      if (!platform) throw new Error("platform not initialised");
      await this.requireHookAllowed(hook.program, platform);
    }
    const k = poolKeys(baseMint, quoteMint, baseTokenProgram);
    const out: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
    if (quoteMint.equals(NATIVE_MINT)) {
      out.push(ix.createAtaIdempotent(creator, creator, NATIVE_MINT));
      out.push(ix.transferLamports(creator, pda.ata(creator, NATIVE_MINT), quoteAmount));
      out.push(ix.syncNative(pda.ata(creator, NATIVE_MINT)));
    }
    out.push(ix.createPool(creator, creator, k, hook, { lpFeeBps, baseAmount, quoteAmount }));
    return out;
  }

  async toVersionedTx(payer: PublicKey, ixs: TransactionInstruction[]): Promise<VersionedTransaction> {
    return (await this.buildTx(payer, ixs)).tx;
  }

  // ---- history ----------------------------------------------------------------------------------

  // Every reader below fetches with `getTransactionsBySignature` (transactions.ts): each answer
  // is paired with its signature by the transaction's own signature, never by its position in
  // the batched answer (some RPC providers answer a batch in any order). A transaction the node
  // cannot give in version 0 (error -32015, a version 1 transaction) is skipped and counted
  // (`unreadable` where the result is an object); it does not throw the others away.

  /// Recent swaps of a pool, newest first, from transaction logs.
  async recentSwaps(pool: PublicKey, limit = 100): Promise<(SwappedEvent & { signature: string; blockTime: number })[]> {
    const sigs = await this.connection.getSignaturesForAddress(pool, { limit });
    const { transactions: txs } = await getTransactionsBySignature(this.connection, sigs.map((s) => s.signature));
    const out: (SwappedEvent & { signature: string; blockTime: number })[] = [];
    txs.forEach((tx, i) => {
      if (!tx || tx.meta?.err) return;
      for (const ev of eventsFromTransaction(tx as any, OUR_PROGRAMS)) {
        if (ev.kind === "Swapped" && ev.pool.equals(pool)) out.push({ ...ev, signature: sigs[i].signature, blockTime: tx.blockTime ?? 0 });
      }
    });
    return out;
  }

  /// The events of the transactions of `address` that are NEWER than `until` (a signature seen
  /// before; null or left out: the newest `limit` transactions), newest first, in the order and
  /// shape of `allEvents`. One getSignaturesForAddress, then one getTransaction for each new
  /// transaction that did not fail (a failed one has no events and is not fetched). So a page
  /// that keeps the newest signature and asks again reads only what is new, and nothing at all
  /// but the one getSignaturesForAddress when nothing happened.
  ///
  /// `newest` is the newest signature now (pass it as `until` next time; it is `until` again when
  /// nothing is new) and `newestSlot` its slot (null when nothing is new). `more` is true when
  /// `limit` signatures came back: there may be new ones older than those, which this call left out.
  /// `unreadable` counts the transactions the node could not give in version 0 (skipped; `newest`
  /// still moves past them).
  async recentEventsSince(address: PublicKey, until: string | null = null, limit = 50): Promise<{ events: (HookpoolEvent & { signature: string; blockTime: number })[]; newest: string | null; newestSlot: bigint | null; transactions: number; more: boolean; unreadable: number }> {
    const sigs = await this.connection.getSignaturesForAddress(address, until ? { limit, until } : { limit });
    if (sigs.length === 0) return { events: [], newest: until, newestSlot: null, transactions: 0, more: false, unreadable: 0 };
    const ok = sigs.filter((s) => !s.err);
    const got = ok.length ? await getTransactionsBySignature(this.connection, ok.map((s) => s.signature)) : { transactions: [], unreadable: [] };
    const events: (HookpoolEvent & { signature: string; blockTime: number })[] = [];
    got.transactions.forEach((tx, i) => {
      if (!tx || tx.meta?.err) return;
      for (const ev of eventsFromTransaction(tx as any, OUR_PROGRAMS)) events.push({ ...ev, signature: ok[i].signature, blockTime: tx.blockTime ?? 0 });
    });
    return { events, newest: sigs[0].signature, newestSlot: BigInt(sigs[0].slot), transactions: ok.length, more: sigs.length >= limit, unreadable: got.unreadable.length };
  }

  /// The two curve events of a pool (`CurveOpened`, `Graduated`), searched from the pool's FIRST
  /// transaction forward: the signatures are listed back to the creation (1,000 per call, at
  /// most `maxSignatures`), then the transactions are read oldest first, 50 a call, until both
  /// are found or `maxTransactions` were read. A graduation comes after the trades of the curve,
  /// so this finds it however many trades followed; `curveEvents` reads from the newest and
  /// does not. `reachedCreation` is false when the signatures were cut by `maxSignatures`.
  /// `unreadable` counts the transactions the node could not give in version 0 (skipped).
  async curveEventsFromStart(pool: PublicKey | Pool, opts: { maxTransactions?: number; maxSignatures?: number } = {}): Promise<{ opened: (CurveOpenedEvent & { signature: string; blockTime: number }) | null; graduated: (GraduatedEvent & { signature: string; blockTime: number }) | null; transactions: number; reachedCreation: boolean; unreadable: number }> {
    const address = addressOf(pool);
    const maxTx = opts.maxTransactions ?? 1000, maxSigs = opts.maxSignatures ?? 20_000;
    const sigs: { signature: string; err: unknown }[] = [];
    let before: string | undefined;
    let reachedCreation = false;
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(address, before ? { limit: 1000, before } : { limit: 1000 });
      sigs.push(...page);
      if (page.length < 1000) { reachedCreation = true; break; }
      if (sigs.length >= maxSigs) break;
      before = page[page.length - 1].signature;
    }
    const oldestFirst = sigs.filter((s) => !s.err).reverse();
    let opened: (CurveOpenedEvent & { signature: string; blockTime: number }) | null = null;
    let graduated: (GraduatedEvent & { signature: string; blockTime: number }) | null = null;
    let read = 0, unreadable = 0;
    for (let i = 0; i < oldestFirst.length && read < maxTx && !(opened && graduated); i += 50) {
      const chunk = oldestFirst.slice(i, i + Math.min(50, maxTx - read));
      const got = await getTransactionsBySignature(this.connection, chunk.map((s) => s.signature), { perRequest: 50 });
      read += chunk.length;
      unreadable += got.unreadable.length;
      got.transactions.forEach((tx, j) => {
        if (!tx || tx.meta?.err) return;
        for (const ev of eventsFromTransaction(tx as any, OUR_PROGRAMS)) {
          if (ev.kind === "CurveOpened" && ev.pool.equals(address) && !opened) opened = { ...ev, signature: chunk[j].signature, blockTime: tx.blockTime ?? 0 };
          if (ev.kind === "Graduated" && ev.pool.equals(address) && !graduated) graduated = { ...ev, signature: chunk[j].signature, blockTime: tx.blockTime ?? 0 };
        }
      });
    }
    return { opened, graduated, transactions: read, reachedCreation, unreadable };
  }

  async allEvents(address: PublicKey, limit = 100): Promise<(HookpoolEvent & { signature: string; blockTime: number })[]> {
    const sigs = await this.connection.getSignaturesForAddress(address, { limit });
    const { transactions: txs } = await getTransactionsBySignature(this.connection, sigs.map((s) => s.signature));
    const out: (HookpoolEvent & { signature: string; blockTime: number })[] = [];
    txs.forEach((tx, i) => {
      if (!tx || tx.meta?.err) return;
      for (const ev of eventsFromTransaction(tx as any, OUR_PROGRAMS)) out.push({ ...ev, signature: sigs[i].signature, blockTime: tx.blockTime ?? 0 });
    });
    return out;
  }
}

/// An account as `getAccountInfo` and `getMultipleAccountsInfo` give it, or null when it does not exist.
export type AccountData = { data: Uint8Array; owner: PublicKey; lamports: number; executable?: boolean } | null;

/// What a wallet holds of a pool's tokens (`client.walletBalances`, `poolView`). A token account
/// that does not exist counts as 0.
export interface WalletBalances {
  owner: PublicKey;
  /// The wallet's own SOL, in lamports (what getBalance says).
  sol: bigint;
  /// The coin, in raw units.
  base: bigint;
  /// The quote token when it is not SOL, in raw units; 0n on a SOL pool (see `sol` and `wsol`).
  quote: bigint;
  /// A SOL pool: what the wallet's wrapped SOL account holds, null when it has none. Always
  /// null on a pool of another quote token.
  wsol: bigint | null;
  /// The pool's LP.
  lp: bigint;
}
/// The four accounts of `WalletBalances`: the wallet, its coin account, its quote (or wrapped SOL) account, its LP account.
export function walletKeys(owner: PublicKey, pool: Pool): PublicKey[] {
  const sol = pool.quoteMint.equals(NATIVE_MINT);
  return [owner, pda.ata(owner, pool.baseMint, pool.baseTokenProgram), sol ? pda.ata(owner, NATIVE_MINT) : pda.ata(owner, pool.quoteMint, pool.quoteTokenProgram), pda.ata(owner, pool.lpMint)];
}
/// `WalletBalances` from the four accounts of `walletKeys`, in that order.
export function walletFromAccounts(owner: PublicKey, pool: Pool, infos: AccountData[]): WalletBalances {
  const sol = pool.quoteMint.equals(NATIVE_MINT);
  const amount = (a: AccountData | undefined) => (a ? decodeTokenAmount(new Uint8Array(a.data)) : null);
  return {
    owner, sol: BigInt(infos[0] ? infos[0].lamports : 0), base: amount(infos[1]) ?? 0n,
    quote: sol ? 0n : amount(infos[2]) ?? 0n, wsol: sol ? amount(infos[2]) : null, lp: amount(infos[3]) ?? 0n,
  };
}
export interface PoolViewOptions {
  /// true: read the platform account in the same call. A `Platform` read before: use it (the
  /// buyback and burn runs need one).
  platform?: boolean | Platform | null;
  /// The coin's metadata (Metaplex, or a Token-2022 coin's own) and its launch record.
  metadata?: boolean; launch?: boolean;
  /// The hook's manifest (default true). `upgradeAuthority: true` also reads the header of the
  /// hook's program data (one more call), for `hook.upgradeAuthority`; otherwise it is "unknown".
  manifest?: boolean; upgradeAuthority?: boolean;
  /// A wallet: its balances (`wallet`) and, on a rules coin, its stake or holder record.
  wallet?: PublicKey | null;
  /// The key the instructions of `buyback` and `rules.run` are built for (default: the wallet, else the default key).
  payer?: PublicKey;
  /// A rules coin: its `rulesView` in the same read (default true; false leaves its accounts out).
  rules?: boolean;
  /// A rules config from an earlier read: on a strict coin the read then stays one call.
  rulesConfig?: RulesConfig | null;
  /// Any other accounts to read in the same call, returned in `extra` in this order.
  extra?: PublicKey[];
}
export interface PoolView {
  /// The slot of the read (its context): every account below is as of this slot.
  slot: bigint;
  pool: Pool;
  /// The coin's mint; the quote token's mint (null for SOL, whose mint is fixed: 9 decimals).
  mint: MintInfo | null; quoteMint: MintInfo | null;
  /// The LP supply and what the pool's lock account holds of it.
  lp: { supply: bigint; locked: bigint } | null;
  /// The hook as `hookInfo` gives it (with `upgradeAuthority` "unknown" unless asked), null without a hook.
  hook: HookInfo | null;
  /// What the hook's quote treasury holds; null when the account does not exist or there is no treasury.
  treasury: bigint | null;
  /// The platform account: the one passed in, or read when asked; null otherwise.
  platform: Platform | null;
  /// Only when asked (otherwise null).
  metadata: TokenMetadata | null; launch: Launch | null;
  wallet: WalletBalances | null;
  /// A rules coin: `rulesView` of the same read (its `run` needs the platform).
  rules: RulesView | null;
  /// A buyback coin with a platform: `buybackInstructions` of the same read; null below the minimum.
  buyback: (BurnRun & { treasuryLeft: bigint }) | null;
  extra: AccountData[];
}

/// `client.hookInfo` from accounts read elsewhere (in one batch with others, for example):
/// the hook's manifest, the header of its program data account (at least 45 bytes; `undefined`
/// when it was not read, then `upgradeAuthority` is "unknown") and its config for this pool.
export function hookInfoFromAccounts(pool: Pool, manifestInfo: AccountData | undefined, pdInfo: AccountData | undefined, cfgInfo: AccountData | undefined): HookInfo | null {
  if (!pool.hasHook) return null;
  const p = pool.hookProgram;
  const manifest = manifestInfo ? safe(() => decodeHookManifest(new Uint8Array(manifestInfo.data))) : null;
  // null = frozen: the program data account exists and holds no upgrade authority
  let upgradeAuthority: PublicKey | null | "unknown" = "unknown";
  if (pdInfo) { try { upgradeAuthority = decodeUpgradeAuthority(new Uint8Array(pdInfo.data)); } catch { /* stays unknown */ } }
  const template: HookInfo["template"] = p.equals(PROGRAMS.hook_tax) ? "tax" : p.equals(PROGRAMS.hook_launch_guard) ? "launch_guard" : p.equals(PROGRAMS.hook_buyback) ? "buyback"
    : p.equals(PROGRAMS.hook_collectible) ? "collectible" : p.equals(PROGRAMS.hook_rules) ? "rules" : "custom";
  const info: HookInfo = { program: p, kind: pool.hookKind, flags: pool.hookFlags, manifest, template, upgradeAuthority, summary: describeFlags(pool.hookFlags) };
  if (cfgInfo) {
    const d = new Uint8Array(cfgInfo.data);
    if (template === "tax") info.tax = safe(() => decodeTaxConfig(d)) ?? undefined;
    if (template === "launch_guard") info.guard = safe(() => decodeGuardConfig(d)) ?? undefined;
    if (template === "buyback") info.buyback = safe(() => decodeBuybackConfig(d)) ?? undefined;
    if (template === "collectible") info.collectible = safe(() => col.decodeCollectionConfig(d)) ?? undefined;
    if (template === "rules") {
      info.rules = safe(() => decodeRulesConfig(d)) ?? undefined;
      // amounts are worded in SOL; for another quote token, in its raw units (call
      // describeRules yourself with its symbol and decimals for better wording)
      if (info.rules) info.rulesSentences = describeRules(info.rules, pool.quoteMint.equals(NATIVE_MINT) ? {} : { quoteSymbol: "raw units of the quote token", quoteDecimals: 0 });
    }
  }
  return info;
}

/// Everything a page shows about a rules coin, from one read (`client.rulesView`, `poolView`).
export interface RulesView {
  state: RulesState;
  /// The creator lock (`rulesLock`). null only when the config could not be read.
  lock: RulesLockInfo | null;
  /// The wallet's stake (`rulesStakeOf`) on a coin that is not strict; null without a wallet.
  stake: RulesStakeInfo | null;
  /// The wallet's holder record (`rulesHolderOf`) on a strict coin; null without a wallet.
  holder: RulesHolderInfo | null;
  /// The next burn (`rulesBurnInstructions`); null when the pot is empty or no platform was given.
  run: BurnRun | null;
  slot: bigint;
}
interface RulesViewKeys { list: PublicKey[]; cfg: PublicKey; lock: PublicKey; vault: PublicKey; stake: PublicKey | null; holder: PublicKey | null; walletAta: PublicKey | null; creatorAta: PublicKey | null }
/// The accounts of one `rulesView` read. `baseMint` and `config` may be null when not known yet.
function rulesViewKeys(address: PublicKey, baseMint: PublicKey | null, wallet: PublicKey | null, config: RulesConfig | null): RulesViewKeys {
  const cfg = rulesPda.cfg(address), lock = rulesPda.lock(address), vault = rulesPda.lockVault(address);
  const mint = baseMint ?? config?.baseMint ?? null;
  const stake = wallet ? rulesPda.stake(address, wallet) : null, holder = wallet ? rulesPda.holder(address, wallet) : null;
  const walletAta = wallet && mint ? pda.ata(wallet, mint, TOKEN_2022_PROGRAM) : null;
  // a strict coin keeps its creator lock in the creator's own coin account: known from a config read before
  const creatorAta = config && config.strict ? pda.ata(config.creator, config.baseMint, TOKEN_2022_PROGRAM) : null;
  const list = [address, cfg, CLOCK_SYSVAR, lock, vault, ...[stake, holder, walletAta, creatorAta].filter((k): k is PublicKey => !!k)];
  return { list, cfg, lock, vault, stake, holder, walletAta, creatorAta };
}
/// `client.rulesState` from its three accounts: the pool, the rules config and the Clock sysvar.
export function rulesStateFromAccounts(address: PublicKey, poolInfo: AccountData, cfgInfo: AccountData, clockInfo: AccountData): RulesState | null {
  if (!poolInfo || !cfgInfo || !clockInfo || !cfgInfo.owner.equals(PROGRAMS.hook_rules)) return null;
  const p = decodePool(address, new Uint8Array(poolInfo.data));
  const config = decodeRulesConfig(new Uint8Array(cfgInfo.data));
  const settled = rulesSettle(config, p);
  const clock = clockOf(new Uint8Array(clockInfo.data));
  let strict: RulesStrictState | null = null;
  let liquidityOpen = rulesLiquidityOpenSlot(config);
  if (config.strict) {
    const w = strictWindows(config);
    strict = {
      maxWalletAmount: config.maxWalletAmount, maxWalletRuns: strictMaxWalletRuns(config, clock.slot), maxWalletUntil: w.maxWalletUntil,
      earlyWindowRuns: strictEarlyWindowRuns(config, clock.slot), earlyUntil: w.earlyUntil, earlyLocked: strictEarlyLocked(config, clock.slot), earlyUnlock: w.earlyUnlock,
      registered: config.totalStaked, minRegistered: config.minEligible,
    };
    if (w.maxWalletUntil > liquidityOpen) liquidityOpen = w.maxWalletUntil;
  }
  return {
    pool: p, config, settled, unsettledFee: rulesUnsettledFee(config, p), creatorClaimable: settled.creatorOwed, burnPot: settled.burnPot,
    stakersEligible: rulesStakersEligible(config), liquidityOpenSlot: liquidityOpen, ...clock, strict,
  };
}
/// `client.rulesStakeOf` from its accounts: the pool, the config, the Clock and the stake record.
export function rulesStakeFromAccounts(address: PublicKey, wallet: PublicKey, poolInfo: AccountData, cfgInfo: AccountData, clockInfo: AccountData, recInfo: AccountData): RulesStakeInfo | null {
  if (!poolInfo || !cfgInfo || !clockInfo || !cfgInfo.owner.equals(PROGRAMS.hook_rules)) return null;
  const stake = rulesPda.stake(address, wallet);
  const { slot } = clockOf(new Uint8Array(clockInfo.data));
  if (!recInfo) return { address: stake, record: null, staked: 0n, claimable: 0n, unstakeOpenSlot: 0n, canUnstake: false, shareBps: 0, slot };
  const record = decodeStakeRecord(new Uint8Array(recInfo.data));
  const settled = rulesSettle(decodeRulesConfig(new Uint8Array(cfgInfo.data)), decodePool(address, new Uint8Array(poolInfo.data)));
  const unstakeOpenSlot = record.sinceSlot + UNSTAKE_DELAY_SLOTS;
  return {
    address: stake, record, staked: record.amount, claimable: record.owed + rulesPendingRewards(settled, record), unstakeOpenSlot,
    canUnstake: record.amount > 0n && slot >= unstakeOpenSlot,
    shareBps: settled.totalStaked > 0n ? Number((record.amount * 10_000n) / settled.totalStaked) : 0, slot,
  };
}
/// `client.rulesLock` from its accounts: the config, the Clock, the lock record and the lock
/// vault; on a strict coin, the creator's own coin account in place of the vault.
export function rulesLockFromAccounts(address: PublicKey, cfgInfo: AccountData, clockInfo: AccountData, lockInfo: AccountData, vaultInfo: AccountData, creatorAtaInfo: AccountData): RulesLockInfo | null {
  if (!cfgInfo || !clockInfo || !cfgInfo.owner.equals(PROGRAMS.hook_rules)) return null;
  const cfg = decodeRulesConfig(new Uint8Array(cfgInfo.data));
  const lockKey = rulesPda.lock(address), vault = rulesPda.lockVault(address);
  const { unixTime } = clockOf(new Uint8Array(clockInfo.data));
  const record = lockInfo ? decodeLockRecord(new Uint8Array(lockInfo.data)) : null;
  const unlockAt = record ? record.unlockAt : 0n;
  if (cfg.strict) {
    // a strict coin has no lock vault: the locked coins stay in the creator's own coin
    // account, and the transfer hook keeps the wallet at or above the locked amount
    const creatorAta = pda.ata(cfg.creator, cfg.baseMint, TOKEN_2022_PROGRAM);
    const vaultBalance = creatorAtaInfo && creatorAtaInfo.data.length >= 72 ? decodeTokenAmount(new Uint8Array(creatorAtaInfo.data)) : 0n;
    return {
      address: lockKey, vault: creatorAta, record, vaultBalance, unlockAt, locked: !!record && record.amount > 0n && unixTime < unlockAt,
      declaredSeconds: cfg.creatorLockSeconds, declaredUntil: cfg.started ? cfg.startTime + cfg.creatorLockSeconds : 0n, creator: cfg.creator, unixTime,
    };
  }
  const vaultBalance = vaultInfo ? decodeTokenAmount(new Uint8Array(vaultInfo.data)) : 0n;
  return {
    address: lockKey, vault, record, vaultBalance, unlockAt, locked: vaultBalance > 0n && unixTime < unlockAt,
    declaredSeconds: cfg.creatorLockSeconds, declaredUntil: cfg.started ? cfg.startTime + cfg.creatorLockSeconds : 0n, creator: cfg.creator, unixTime,
  };
}
/// `client.rulesHolderOf` from its accounts: the pool, the config, the Clock, the wallet's
/// holder record and its Token-2022 coin account. null when the coin is not strict.
export function rulesHolderFromAccounts(address: PublicKey, wallet: PublicKey, poolInfo: AccountData, cfgInfo: AccountData, clockInfo: AccountData, recInfo: AccountData, ataInfo: AccountData): RulesHolderInfo | null {
  if (!poolInfo || !cfgInfo || !clockInfo || !cfgInfo.owner.equals(PROGRAMS.hook_rules)) return null;
  const cfg = decodeRulesConfig(new Uint8Array(cfgInfo.data));
  if (!cfg.strict) return null;
  const key = rulesPda.holder(address, wallet);
  const { slot, unixTime } = clockOf(new Uint8Array(clockInfo.data));
  const record = recInfo ? decodeHolderRecord(new Uint8Array(recInfo.data)) : null;
  const balance = ataInfo && ataInfo.data.length >= 72 ? decodeTokenAmount(new Uint8Array(ataInfo.data)) : 0n;
  const settled = rulesSettle(cfg, decodePool(address, new Uint8Array(poolInfo.data)));
  const earlyLocked = !!record && record.earlyBought > 0n && strictEarlyLocked(cfg, slot);
  const creatorLocked = !!record && record.locked > 0n && unixTime < record.lockedUntil;
  const held = [earlyLocked ? record!.earlyBought : 0n, creatorLocked ? record!.locked : 0n].reduce((a, b) => (a > b ? a : b), 0n);
  return {
    address: key, record, balance, counted: record ? record.balance : 0n, claimable: record ? strictHolderClaimable(settled, record) : 0n,
    earlyBought: record ? record.earlyBought : 0n, earlyLocked, earlyUnlock: strictWindows(cfg).earlyUnlock,
    locked: record ? record.locked : 0n, creatorLocked, lockedUntil: record ? record.lockedUntil : 0n,
    free: balance > held ? balance - held : 0n,
    shareBps: record && settled.totalStaked > 0n ? Number((record.balance * 10_000n) / settled.totalStaked) : 0, slot, unixTime,
  };
}

/// Candles from swap events (price = quote per base, in UI units).
///
/// The `Swapped` event carries the REAL reserves. On a pool on the curve the price is made
/// of the real quote plus the virtual quote, which the event does not carry: pass `curve`
/// with the pool's virtual quote (`pool.virtualQuote` while it is open, or the
/// `CurveOpened` event's once it graduated) and, once graduated, the slot of the `Graduated`
/// event (`client.curveEvents`): swaps up to and including that slot are priced with the
/// virtual part (the buy that graduates is in the same transaction), later ones without.
export function candlesFromSwaps(swaps: (SwappedEvent & { blockTime: number })[], baseDecimals: number, quoteDecimals: number, bucketSeconds = 60, curve?: { virtualQuote: bigint; graduatedSlot?: bigint | null }): Candle[] {
  const scale = 10 ** (baseDecimals - quoteDecimals);
  const byBucket = new Map<number, Candle>();
  const sorted = [...swaps].sort((a, b) => a.blockTime - b.blockTime);
  const virtualAt = (slot: bigint) => (curve && (curve.graduatedSlot === undefined || curve.graduatedSlot === null || slot <= curve.graduatedSlot) ? curve.virtualQuote : 0n);
  for (const s of sorted) {
    if (s.reserveBase === 0n) continue;
    const price = (Number(s.reserveQuote + virtualAt(s.slot)) / Number(s.reserveBase)) * scale;
    const t = Math.floor(s.blockTime / bucketSeconds) * bucketSeconds;
    const vol = Number(s.direction === DIRECTION.BUY ? s.amountIn : s.amountOut) / 10 ** quoteDecimals;
    const c = byBucket.get(t);
    if (!c) byBucket.set(t, { time: t, open: price, high: price, low: price, close: price, volume: vol });
    else { c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; c.volume += vol; }
  }
  return [...byBucket.values()];
}

/// The pool's price in quote units per base unit: `(reserveQuote + virtualQuote) /
/// reserveBase`. On a seeded pool and after graduation the virtual quote is 0.
export function spotPrice(pool: Pool, baseDecimals: number, quoteDecimals: number): number {
  if (pool.reserveBase === 0n) return 0;
  return (Number(pool.reserveQuote + pool.virtualQuote) / Number(pool.reserveBase)) * 10 ** (baseDecimals - quoteDecimals);
}

/// The first slot in which liquidity can be added to a pool with this hook (0n: any
/// time). The rules template and the launch guard refuse `add_liquidity` while their
/// sniper or guard window runs; removing liquidity is never refused by a template. For a
/// hook the platform did not write, `hook.summary.canBlockAdding` says whether it could.
export function liquidityOpenSlot(hook: HookInfo | null | undefined): bigint {
  if (hook?.rules) {
    const open = rulesLiquidityOpenSlot(hook.rules);
    const maxWalletUntil = hook.rules.strict ? strictWindows(hook.rules).maxWalletUntil : 0n;
    return maxWalletUntil > open ? maxWalletUntil : open;
  }
  if (hook?.guard) return hook.guard.startSlot + hook.guard.guardSlots;
  return 0n;
}

export function hookKindLabel(kind: number): string {
  return kind === HOOK_KIND.NONE ? "no hook" : kind === HOOK_KIND.FROZEN ? "frozen custom hook" : "platform template";
}

function safe<T>(f: () => T): T | null { try { return f(); } catch { return null; } }
/// The size in bytes of these instructions as one legacy transaction (null when they do
/// not even compile into one). The blockhash and the signatures have fixed sizes.
function legacySize(ixs: TransactionInstruction[], payer: PublicKey): number | null {
  try {
    const m = new TransactionMessage({ payerKey: payer, recentBlockhash: SYSTEM_PROGRAM.toBase58(), instructions: ixs }).compileToLegacyMessage();
    return m.serialize().length + 1 + 64 * m.header.numRequiredSignatures;
  } catch { return null; }
}
/// The Clock sysvar: slot at offset 0, Unix time at offset 32.
function clockOf(d: Uint8Array): { slot: bigint; unixTime: bigint } {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { slot: v.getBigUint64(0, true), unixTime: v.getBigInt64(32, true) };
}
function addressOf(pool: PublicKey | Pool): PublicKey { return (pool as Pool).address ?? (pool as PublicKey); }

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes: number[]): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}

export { FLAGS };
