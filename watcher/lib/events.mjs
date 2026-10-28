// The collectible program's events as they appear in a transaction's log lines, and which program logged them.
//
// Anchor logs an event as "Program data: <base64>" (8-byte discriminator, then borsh). Any program may log such a
// line, so a decoder that reads every "Program data:" line would take a forged PiecesEarned from a stranger's
// program for the hook's own. The lines of a transaction say which program runs at each point ("Program <id>
// invoke [n]", then "Program <id> success" or "failed"), so each data line is attributed to the innermost program
// running when it was logged, and the decoders here take the collectible program's lines only. Logs with no invoke
// line at all (a synthetic transaction in a test) are taken as they are.
//
// Pure: nothing here reads the chain.
import { PublicKey } from "@solana/web3.js";
import { EVENT_DISC, PROGRAMS } from "../../sdk/dist/index.js";

const EVENT_PREFIX = "Program data: ";
const b58 = (k) => (typeof k === "string" ? k : k.toBase58());
const startsWith = (bytes, disc) => bytes.length >= disc.length && disc.every((b, i) => bytes[i] === b);
const u32 = (b, at) => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0, true);
const u64 = (b, at) => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);
const key32 = (b, at) => new PublicKey(b.subarray(at, at + 32));

function eventBytes(line) {
  if (typeof line !== "string" || !line.startsWith(EVENT_PREFIX)) return null;
  try { return new Uint8Array(Buffer.from(line.slice(EVENT_PREFIX.length), "base64")); } catch { return null; }
}

/// The "Program data:" lines of a transaction, each with the program that logged it: the innermost program running
/// at that point, followed through the invoke and success/failed lines. null when the logs carry no invoke line.
export function attributedLogs(logs) {
  const out = [];
  const stack = [];
  let sawInvoke = false;
  for (const line of logs ?? []) {
    if (typeof line !== "string") continue;
    let m = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (m) { stack.push(m[1]); sawInvoke = true; continue; }
    m = /^Program (\S+) (success|failed)/.exec(line);
    if (m) { const i = stack.lastIndexOf(m[1]); if (i >= 0) stack.splice(i, stack.length - i); continue; }
    if (line.startsWith(EVENT_PREFIX)) out.push({ program: sawInvoke ? stack[stack.length - 1] ?? null : null, line });
  }
  return out;
}

/// The "Program data:" lines one program logged (every such line when the logs carry no invoke line).
export function logsOfProgram(logs, program = PROGRAMS.hook_collectible) {
  const want = b58(program);
  return attributedLogs(logs).filter((x) => x.program === null || x.program === want).map((x) => x.line);
}

/// The PiecesEarned events the collectible program logged in a transaction: discriminator 8, pool 32, user 32,
/// pieces u32, slot u64, target_slot u64. One per buy that earned pieces.
export function earnedFromLogs(logs, program = PROGRAMS.hook_collectible) {
  const out = [];
  for (const line of logsOfProgram(logs, program)) {
    const b = eventBytes(line);
    if (!b || b.length < 92 || !startsWith(b, EVENT_DISC.PiecesEarned)) continue;
    out.push({ pool: key32(b, 8), user: key32(b, 40), pieces: u32(b, 72), slot: u64(b, 76), targetSlot: u64(b, 84) });
  }
  return out;
}

/// The DepositUsed events the collectible program logged: discriminator 8, pool 32, user 32, by 32, pieces u32,
/// paid u64, left u64. One per mint that took from a deposit.
export function depositUsedFromLogs(logs, program = PROGRAMS.hook_collectible) {
  const out = [];
  for (const line of logsOfProgram(logs, program)) {
    const b = eventBytes(line);
    if (!b || b.length < 124 || !startsWith(b, EVENT_DISC.DepositUsed)) continue;
    out.push({ pool: key32(b, 8), user: key32(b, 40), by: key32(b, 72), pieces: u32(b, 104), paid: u64(b, 108), left: u64(b, 116) });
  }
  return out;
}

/// The PiecesTransferred events the collectible program logged (a transfer of a pegged coin moves pieces between
/// the two wallets' lists inside the transfer): discriminator 8, pool 32, from 32, to 32, dropped u32, moved u32,
/// burned u32. A wallet that received pieces this way has a ticket with pieces, named by `to`.
export function transferredFromLogs(logs, program = PROGRAMS.hook_collectible) {
  const out = [];
  for (const line of logsOfProgram(logs, program)) {
    const b = eventBytes(line);
    if (!b || b.length < 116 || !startsWith(b, EVENT_DISC.PiecesTransferred)) continue;
    out.push({ pool: key32(b, 8), from: key32(b, 40), to: key32(b, 72), dropped: u32(b, 104), moved: u32(b, 108), burned: u32(b, 112) });
  }
  return out;
}

/// The PieceSent events the collectible program logged (a piece sent along with its coins): discriminator 8, pool
/// 32, from 32, to 32, asset 32. The receiver's ticket holds the piece now.
export function sentFromLogs(logs, program = PROGRAMS.hook_collectible) {
  const out = [];
  for (const line of logsOfProgram(logs, program)) {
    const b = eventBytes(line);
    if (!b || b.length < 136 || !startsWith(b, EVENT_DISC.PieceSent)) continue;
    out.push({ pool: key32(b, 8), from: key32(b, 40), to: key32(b, 72), asset: key32(b, 104) });
  }
  return out;
}

/// The wallets whose ticket on a pool gained pieces in a transaction without a PiecesEarned: the receivers of a
/// PiecesTransferred that moved pieces and of a PieceSent. { pool, user } each.
export function receivedFromLogs(logs, program = PROGRAMS.hook_collectible) {
  const out = [];
  for (const ev of transferredFromLogs(logs, program)) if (ev.moved > 0) out.push({ pool: ev.pool, user: ev.to });
  for (const ev of sentFromLogs(logs, program)) out.push({ pool: ev.pool, user: ev.to });
  return out;
}

/// Every account key of a transaction web3.js parsed, as base58: the static keys and the ones loaded through
/// lookup tables (a pool that changes is writable, so it is among them). Unknown shapes answer [].
export function txAccountKeys(tx) {
  const msg = tx && tx.transaction ? tx.transaction.message : null;
  if (!msg) return [];
  const out = [];
  const push = (k) => { if (!k) return; out.push(typeof k === "string" ? k : k.pubkey ? b58(k.pubkey) : b58(k)); };
  try {
    if (typeof msg.getAccountKeys === "function") {
      const ak = msg.getAccountKeys({ accountKeysFromLookups: tx.meta ? tx.meta.loadedAddresses : undefined });
      for (const k of ak.staticAccountKeys ?? []) push(k);
      if (ak.accountKeysFromLookups) { for (const k of ak.accountKeysFromLookups.writable ?? []) push(k); for (const k of ak.accountKeysFromLookups.readonly ?? []) push(k); }
      if (out.length) return out;
    }
  } catch { /* below */ }
  for (const k of msg.staticAccountKeys ?? msg.accountKeys ?? []) push(k);
  if (tx.meta && tx.meta.loadedAddresses) { for (const k of tx.meta.loadedAddresses.writable ?? []) push(k); for (const k of tx.meta.loadedAddresses.readonly ?? []) push(k); }
  return out;
}

/// Is the pool program among a transaction's account keys? Unknown shapes (no keys at all) answer null.
export function touchesProgram(tx, program = PROGRAMS.hookpool) {
  const keys = txAccountKeys(tx);
  if (!keys.length) return null;
  return keys.includes(b58(program));
}
