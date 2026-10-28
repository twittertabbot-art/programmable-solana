// Anchor events arrive as `Program data: <base64>` log lines: 8-byte discriminator + borsh.
//
// Any program may log such a line, so the decoders below take a line only when one of OUR programs logged it. The
// log lines of a transaction say which program runs at each point ("Program <id> invoke [n]", then "Program <id>
// success" or "Program <id> failed: ..."; only the runtime writes these, a program's own `msg!` lines all start with
// "Program log: "), so each data line is attributed to the innermost program running when it was logged. Without
// this, a transaction that calls the pool program and a stranger's program that logs bytes shaped like a Swapped
// event would plant a trade of any pool, any amounts and any wallet into every reader of the feed.
import { PublicKey } from "@solana/web3.js";
import { Reader, discriminatorMatches } from "./borsh.js";
import { EVENT_DISC } from "./generated.js";
import { EVENT_IX_TAG, PROGRAMS } from "./constants.js";

/// The programs whose log events are taken by default: every program of the SDK (the pool program, the launch
/// program and the hooks), as base58 strings. `eventsFromLogs` and `eventsFromTransaction` accept another set.
export const EVENT_LOG_PROGRAMS: readonly string[] = Object.values(PROGRAMS).map((p) => p.toBase58());

const EVENT_LOG_PREFIX = "Program data: ";
const INVOKE_LINE = /^Program (\S+) invoke \[\d+\]$/;
const RETURN_LINE = /^Program (\S+) (success|failed)/;

/// The "Program data:" lines of a transaction's logs, each with the program that logged it: the innermost program
/// running at that point, followed through the "invoke" and "success" / "failed" lines of the runtime. `program`
/// is null when the logs carry no invoke line at all (a synthetic transaction in a test), and "" (no program) when
/// a data line sits outside every invoke in logs that do have them: the runtime never writes one there, and no
/// accepted set matches "". A "Log truncated" line, a line that is not a string and an unbalanced stack (the log
/// was cut) are taken in stride: what was attributed stays attributed.
export function attributedDataLogs(logs: readonly unknown[] | null | undefined): { program: string | null; line: string }[] {
  const out: { program: string | null; line: string }[] = [];
  const stack: string[] = [];
  let sawInvoke = false;
  for (const line of logs ?? []) {
    if (typeof line !== "string") continue;
    let m = INVOKE_LINE.exec(line);
    if (m) { stack.push(m[1]); sawInvoke = true; continue; }
    m = RETURN_LINE.exec(line);
    if (m) { const i = stack.lastIndexOf(m[1]); if (i >= 0) stack.splice(i, stack.length - i); continue; }
    if (line.startsWith(EVENT_LOG_PREFIX)) out.push({ program: sawInvoke ? stack[stack.length - 1] ?? "" : null, line });
  }
  return out;
}

const base58Of = (k: string | PublicKey) => (typeof k === "string" ? k : k.toBase58());

export interface SwappedEvent {
  kind: "Swapped"; pool: PublicKey; user: PublicKey; direction: number; amountIn: bigint; amountOut: bigint;
  protocolFee: bigint; hookFee: bigint; lpFee: bigint; feeBpsApplied: number; reserveBase: bigint; reserveQuote: bigint;
  slot: bigint; byHook: boolean;
}
export interface PoolCreatedEvent {
  kind: "PoolCreated"; pool: PublicKey; baseMint: PublicKey; quoteMint: PublicKey; creator: PublicKey; hookProgram: PublicKey;
  hookFlags: number; hookKind: number; lpFeeBps: number; baseAmount: bigint; quoteAmount: bigint; lpMinted: bigint; slot: bigint;
}
export interface LiquidityChangedEvent {
  kind: "LiquidityChanged"; pool: PublicKey; user: PublicKey; added: boolean; baseAmount: bigint; quoteAmount: bigint;
  lpAmount: bigint; reserveBase: bigint; reserveQuote: bigint; slot: bigint;
}
export interface LaunchedEvent {
  kind: "Launched"; launch: PublicKey; pool: PublicKey; dev: PublicKey; baseMint: PublicKey; quoteMint: PublicKey;
  hookProgram: PublicKey; lpLocked: bigint; launchFeePaid: bigint; devBuyQuote: bigint; slot: bigint;
}
/// One call of a buyback that the chain accepted. `outcome` is one of `BURN_OUTCOME`: 1 = it
/// recorded the first observation, 2 = the price was above the observation and it recorded a
/// new one, 3 = it bought and burned. `quoteSpent` and `baseBurned` are zero unless it
/// bought. The observation is the one the call left in the config.
export interface BuybackExecutedEvent { kind: "BuybackExecuted"; pool: PublicKey; quoteSpent: bigint; baseBurned: bigint; slot: bigint; outcome: number; obsReserveBase: bigint; obsReserveQuote: bigint }
export interface PlatformUpdatedEvent {
  kind: "PlatformUpdated"; admin: PublicKey; treasury: PublicKey; protocolFeeBps: number; maxLpFeeBps: number; maxHookFeeBps: number;
  maxFeeOverrideBps: number; launchFeeLamports: bigint; paused: boolean; whitelist: PublicKey[];
}
/// Hook fees that had waited for a missing treasury account were paid to it.
/// The approved list (HOOKS.md section 6.1): a program put on it (`approved`) or taken off;
/// `count` is the list's length after the change.
export interface HookApprovalChangedEvent { kind: "HookApprovalChanged"; program: PublicKey; approved: boolean; count: number }
/// The approved-list rule switched on or off.
export interface HookApprovalRequiredChangedEvent { kind: "HookApprovalRequiredChanged"; required: boolean }
export type ApprovalEvent = HookApprovalChangedEvent | HookApprovalRequiredChangedEvent;
export interface HookFeesCollectedEvent { kind: "HookFeesCollected"; pool: PublicKey; treasury: PublicKey; amount: bigint }
export interface ProtocolFeesCollectedEvent { kind: "ProtocolFeesCollected"; pool: PublicKey; baseAmount: bigint; quoteAmount: bigint }
// ---- hook_rules. BurnExecuted is an inner-instruction event (event CPI), the others are log lines.
/// One `run_burn` that the chain accepted: the same fields as `BuybackExecutedEvent`.
export interface BurnExecutedEvent { kind: "BurnExecuted"; pool: PublicKey; quoteSpent: bigint; baseBurned: bigint; slot: bigint; outcome: number; obsReserveBase: bigint; obsReserveQuote: bigint }
/// `amount` is what this call moved, `staked` what the wallet's record holds afterwards.
export interface StakedEvent { kind: "Staked"; pool: PublicKey; staker: PublicKey; amount: bigint; staked: bigint; totalStaked: bigint; slot: bigint }
export interface UnstakedEvent { kind: "Unstaked"; pool: PublicKey; staker: PublicKey; amount: bigint; staked: bigint; totalStaked: bigint; slot: bigint }
export interface RewardsClaimedEvent { kind: "RewardsClaimed"; pool: PublicKey; staker: PublicKey; amount: bigint }
export interface CreatorClaimedEvent { kind: "CreatorClaimed"; pool: PublicKey; creator: PublicKey; amount: bigint }
/// `amount` is what this call added, `locked` what the lock record holds afterwards. `unlockAt` is a Unix time.
export interface CreatorLockedEvent { kind: "CreatorLocked"; pool: PublicKey; creator: PublicKey; amount: bigint; locked: bigint; unlockAt: bigint }
export interface CreatorUnlockedEvent { kind: "CreatorUnlocked"; pool: PublicKey; creator: PublicKey; amount: bigint }
// ---- strict coin of hook_rules: log events. `balance` is what the record counts afterwards.
export interface HolderOpenedEvent { kind: "HolderOpened"; pool: PublicKey; owner: PublicKey; balance: bigint }
export interface HolderClaimedEvent { kind: "HolderClaimed"; pool: PublicKey; owner: PublicKey; amount: bigint }
export interface HolderSyncedEvent { kind: "HolderSynced"; pool: PublicKey; owner: PublicKey; balance: bigint }
export interface HolderClosedEvent { kind: "HolderClosed"; pool: PublicKey; owner: PublicKey }
export type HolderEvent = HolderOpenedEvent | HolderClaimedEvent | HolderSyncedEvent | HolderClosedEvent;
export type RulesEvent = BurnExecutedEvent | StakedEvent | UnstakedEvent | RewardsClaimedEvent | CreatorClaimedEvent | CreatorLockedEvent | CreatorUnlockedEvent | HolderEvent;
// ---- the curve (hookpool, event CPI). `CurveOpened` follows the `PoolCreated` of a
// `create_curve_pool`; `Graduated` is the one event of `graduate`.
/// The settings the pool was opened with (copied from the platform at creation).
export interface CurveOpenedEvent { kind: "CurveOpened"; pool: PublicKey; virtualQuote: bigint; graduationTarget: bigint; graduationFeeBps: number; slot: bigint }
/// The reserves before and after graduation, the coins burned from the vault and the
/// platform's fee taken out of the reserve. `reserveQuoteBefore / (reserveBaseBefore)` with
/// the virtual quote added is the price before; `reserveQuoteAfter / reserveBaseAfter` the
/// price after: the same, up to one unit of the coin.
export interface GraduatedEvent {
  kind: "Graduated"; pool: PublicKey; reserveQuoteBefore: bigint; reserveQuoteAfter: bigint; reserveBaseBefore: bigint; reserveBaseAfter: bigint;
  burnedBase: bigint; feeQuote: bigint; slot: bigint;
}
export type CurveEvent = CurveOpenedEvent | GraduatedEvent;
export type HookpoolEvent = SwappedEvent | PoolCreatedEvent | LiquidityChangedEvent | LaunchedEvent | BuybackExecutedEvent | PlatformUpdatedEvent
  | HookFeesCollectedEvent | ProtocolFeesCollectedEvent | RulesEvent | CurveEvent | ApprovalEvent;

export function decodeEvent(bytes: Uint8Array): HookpoolEvent | null {
  const r = new Reader(bytes);
  r.skip(8);
  if (discriminatorMatches(bytes, EVENT_DISC.Swapped)) {
    return {
      kind: "Swapped", pool: r.pubkey(), user: r.pubkey(), direction: r.u8(), amountIn: r.u64(), amountOut: r.u64(),
      protocolFee: r.u64(), hookFee: r.u64(), lpFee: r.u64(), feeBpsApplied: r.u16(), reserveBase: r.u64(), reserveQuote: r.u64(),
      slot: r.u64(), byHook: r.bool(),
    };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.PoolCreated)) {
    return {
      kind: "PoolCreated", pool: r.pubkey(), baseMint: r.pubkey(), quoteMint: r.pubkey(), creator: r.pubkey(), hookProgram: r.pubkey(),
      hookFlags: r.u32(), hookKind: r.u8(), lpFeeBps: r.u16(), baseAmount: r.u64(), quoteAmount: r.u64(), lpMinted: r.u64(), slot: r.u64(),
    };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.LiquidityChanged)) {
    return {
      kind: "LiquidityChanged", pool: r.pubkey(), user: r.pubkey(), added: r.bool(), baseAmount: r.u64(), quoteAmount: r.u64(),
      lpAmount: r.u64(), reserveBase: r.u64(), reserveQuote: r.u64(), slot: r.u64(),
    };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.Launched)) {
    return {
      kind: "Launched", launch: r.pubkey(), pool: r.pubkey(), dev: r.pubkey(), baseMint: r.pubkey(), quoteMint: r.pubkey(),
      hookProgram: r.pubkey(), lpLocked: r.u64(), launchFeePaid: r.u64(), devBuyQuote: r.u64(), slot: r.u64(),
    };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.HookFeesCollected)) {
    return { kind: "HookFeesCollected", pool: r.pubkey(), treasury: r.pubkey(), amount: r.u64() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.ProtocolFeesCollected)) {
    return { kind: "ProtocolFeesCollected", pool: r.pubkey(), baseAmount: r.u64(), quoteAmount: r.u64() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.BuybackExecuted)) {
    return { kind: "BuybackExecuted", pool: r.pubkey(), quoteSpent: r.u64(), baseBurned: r.u64(), slot: r.u64(), outcome: r.u8(), obsReserveBase: r.u64(), obsReserveQuote: r.u64() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.PlatformUpdated)) {
    const admin = r.pubkey(); const treasury = r.pubkey(); const protocolFeeBps = r.u16(); const maxLpFeeBps = r.u16();
    const maxHookFeeBps = r.u16(); const maxFeeOverrideBps = r.u16(); const launchFeeLamports = r.u64(); const paused = r.bool();
    const n = r.u32(); const whitelist: PublicKey[] = [];
    for (let i = 0; i < n; i++) whitelist.push(r.pubkey());
    return { kind: "PlatformUpdated", admin, treasury, protocolFeeBps, maxLpFeeBps, maxHookFeeBps, maxFeeOverrideBps, launchFeeLamports, paused, whitelist };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.HookApprovalChanged)) {
    return { kind: "HookApprovalChanged", program: r.pubkey(), approved: r.bool(), count: r.u32() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.HookApprovalRequiredChanged)) {
    return { kind: "HookApprovalRequiredChanged", required: r.bool() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.BurnExecuted)) {
    return { kind: "BurnExecuted", pool: r.pubkey(), quoteSpent: r.u64(), baseBurned: r.u64(), slot: r.u64(), outcome: r.u8(), obsReserveBase: r.u64(), obsReserveQuote: r.u64() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.Staked)) {
    return { kind: "Staked", pool: r.pubkey(), staker: r.pubkey(), amount: r.u64(), staked: r.u64(), totalStaked: r.u64(), slot: r.u64() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.Unstaked)) {
    return { kind: "Unstaked", pool: r.pubkey(), staker: r.pubkey(), amount: r.u64(), staked: r.u64(), totalStaked: r.u64(), slot: r.u64() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.RewardsClaimed)) {
    return { kind: "RewardsClaimed", pool: r.pubkey(), staker: r.pubkey(), amount: r.u64() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.CreatorClaimed)) {
    return { kind: "CreatorClaimed", pool: r.pubkey(), creator: r.pubkey(), amount: r.u64() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.CreatorLocked)) {
    return { kind: "CreatorLocked", pool: r.pubkey(), creator: r.pubkey(), amount: r.u64(), locked: r.u64(), unlockAt: r.i64() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.CreatorUnlocked)) {
    return { kind: "CreatorUnlocked", pool: r.pubkey(), creator: r.pubkey(), amount: r.u64() };
  }
  if (discriminatorMatches(bytes, EVENT_DISC.HolderOpened)) return { kind: "HolderOpened", pool: r.pubkey(), owner: r.pubkey(), balance: r.u64() };
  if (discriminatorMatches(bytes, EVENT_DISC.HolderClaimed)) return { kind: "HolderClaimed", pool: r.pubkey(), owner: r.pubkey(), amount: r.u64() };
  if (discriminatorMatches(bytes, EVENT_DISC.HolderSynced)) return { kind: "HolderSynced", pool: r.pubkey(), owner: r.pubkey(), balance: r.u64() };
  if (discriminatorMatches(bytes, EVENT_DISC.HolderClosed)) return { kind: "HolderClosed", pool: r.pubkey(), owner: r.pubkey() };
  if (discriminatorMatches(bytes, EVENT_DISC.CurveOpened)) return { kind: "CurveOpened", pool: r.pubkey(), virtualQuote: r.u64(), graduationTarget: r.u64(), graduationFeeBps: r.u16(), slot: r.u64() };
  if (discriminatorMatches(bytes, EVENT_DISC.Graduated)) {
    return {
      kind: "Graduated", pool: r.pubkey(), reserveQuoteBefore: r.u64(), reserveQuoteAfter: r.u64(), reserveBaseBefore: r.u64(), reserveBaseAfter: r.u64(),
      burnedBase: r.u64(), feeQuote: r.u64(), slot: r.u64(),
    };
  }
  return null;
}

/// Events emitted through Anchor's event CPI live in inner instructions, never truncated.
/// `innerInstructions` is `tx.meta.innerInstructions` from getTransaction (json encoding);
/// `accountKeys` are the message's account keys (static plus loaded) as base58 strings.
export function eventsFromInnerInstructions(
  innerInstructions: { instructions: { programIdIndex: number; data: string }[] }[] | null | undefined,
  accountKeys: string[],
  ourPrograms: string[],
): HookpoolEvent[] {
  const out: HookpoolEvent[] = [];
  for (const group of innerInstructions ?? []) {
    for (const ins of group.instructions) {
      const pid = accountKeys[ins.programIdIndex];
      if (!pid || !ourPrograms.includes(pid)) continue;
      let bytes: Uint8Array;
      try { bytes = bs58decode(ins.data); } catch { continue; }
      if (bytes.length < 16) continue;
      if (!EVENT_IX_TAG.every((b: number, i: number) => bytes[i] === b)) continue;
      try {
        const ev = decodeEvent(bytes.subarray(8));
        if (ev) out.push(ev);
      } catch { /* not ours */ }
    }
  }
  return out;
}

/// Every event of a transaction: event-CPI ones first, then plain log ones.
export function eventsFromTransaction(tx: {
  meta?: { innerInstructions?: any; logMessages?: string[] | null } | null;
  transaction: { message: { staticAccountKeys?: PublicKey[]; accountKeys?: any[]; getAccountKeys?: (a?: any) => any } };
}, ourPrograms: string[]): HookpoolEvent[] {
  const msg: any = tx.transaction.message;
  let keys: string[] = [];
  try {
    const ak = typeof msg.getAccountKeys === "function" ? msg.getAccountKeys({ accountKeysFromLookups: (tx.meta as any)?.loadedAddresses }) : null;
    if (ak) keys = [...(ak.staticAccountKeys ?? []), ...(ak.accountKeysFromLookups?.writable ?? []), ...(ak.accountKeysFromLookups?.readonly ?? [])].map((k: PublicKey) => k.toBase58());
  } catch { /* fall through */ }
  if (keys.length === 0) keys = (msg.staticAccountKeys ?? msg.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k.pubkey ? k.pubkey.toBase58() : k.toBase58()));
  const cpi = eventsFromInnerInstructions(tx.meta?.innerInstructions, keys, ourPrograms);
  const logs = eventsFromLogs(tx.meta?.logMessages ?? [], ourPrograms);
  // log copies of CPI-emitted events do not exist (we emit each event one way), so just concat
  return [...cpi, ...logs];
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const v = B58.indexOf(c); if (v < 0) throw new Error("bad base58"); n = n * 58n + BigInt(v); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

/// The fields of the decoded events that hold an address (`PublicKey`). Every other field is a
/// `bigint`, a `number` or a `boolean`, except `kind` and `signature`, which are strings.
const ADDRESS_FIELDS = new Set(["pool", "user", "baseMint", "quoteMint", "creator", "hookProgram", "launch", "dev", "admin", "treasury", "staker", "owner", "whitelist"]);
const TEXT_FIELDS = new Set(["kind", "signature"]);

/// A decoded event (with or without `signature`, `blockTime`) as plain JSON: every address as a
/// base58 string, every `bigint` as a string of digits; numbers, booleans and strings stay as
/// they are. `eventFromJson` gives the event back, field for field. This is the shape the
/// watcher publishes in `trades/<pool>.json`.
export function eventToJson(ev: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (v instanceof PublicKey) out[k] = v.toBase58();
    else if (Array.isArray(v)) out[k] = v.map((x) => (x instanceof PublicKey ? x.toBase58() : typeof x === "bigint" ? x.toString() : x));
    else out[k] = v;
  }
  return out;
}

/// The event `eventToJson` (or the watcher's feed) wrote, as the SDK decodes it: the address
/// fields as `PublicKey`, every other string of digits as a `bigint`. `kind` and `signature` stay
/// strings, numbers stay numbers (`direction`, `feeBpsApplied`, `blockTime`). A field that cannot
/// be read throws: a feed that does not follow the shape is not trusted silently.
export function eventFromJson<T extends HookpoolEvent = HookpoolEvent>(json: Record<string, unknown>): T & { signature?: string; blockTime?: number } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) {
    if (TEXT_FIELDS.has(k)) out[k] = v;
    else if (ADDRESS_FIELDS.has(k)) out[k] = Array.isArray(v) ? v.map((x) => new PublicKey(String(x))) : new PublicKey(String(v));
    else if (typeof v === "string") {
      if (!/^-?\d+$/.test(v)) throw new Error(`event field ${k} is not a whole number: ${v}`);
      out[k] = BigInt(v);
    } else out[k] = v;
  }
  if (typeof out.kind !== "string") throw new Error("an event needs its kind");
  return out as T & { signature?: string; blockTime?: number };
}

/// The decodable events of a transaction's log messages that one of `programs` logged (base58 strings or
/// PublicKeys; by default every program of the SDK, `EVENT_LOG_PROGRAMS`). A "Program data:" line logged by any
/// other program is not an event, whatever its bytes look like: see `attributedDataLogs`. Logs with no invoke
/// line at all (bare "Program data:" lines, as a test feeds them) are taken as they are. A line that does not
/// decode (cut short, not base64, an unknown discriminator) is skipped; nothing here throws.
export function eventsFromLogs(logs: readonly string[] | null | undefined, programs: readonly (string | PublicKey)[] = EVENT_LOG_PROGRAMS): HookpoolEvent[] {
  const accepted = new Set(programs.map(base58Of));
  const out: HookpoolEvent[] = [];
  for (const { program, line } of attributedDataLogs(logs)) {
    if (program !== null && !accepted.has(program)) continue; // null: the logs carry no invoke line at all
    const payload = line.slice(EVENT_LOG_PREFIX.length);
    if (!payload) continue;
    try {
      const ev = decodeEvent(Uint8Array.from(Buffer.from(payload, "base64")));
      if (ev) out.push(ev);
    } catch { /* not ours, or cut short */ }
  }
  return out;
}
