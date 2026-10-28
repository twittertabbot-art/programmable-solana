// The trades feed: the recent events of every pool, built from one list of the pool program's transactions.
//
// A coin page shows the last trades of its pool. Read from the chain by every visitor, that is one
// getSignaturesForAddress and up to 200 getTransaction calls per page and refresh. Here the watcher reads each
// transaction of the pool program ONCE, for every pool at the same time:
//
//   1. one getSignaturesForAddress on the pool program per pass, `until` the last signature seen, page after page
//      (1,000 a page) when more arrived;
//   2. the new transactions that did not fail, oldest first, batched (TX_PER_REQUEST a request), at most
//      `maxTxPerPass` a pass (the rest waits for the next pass, which then starts at once). Each answer is paired
//      with its signature by the transaction's own first signature, never by its place in the batch: an RPC may
//      answer a batch in any order. A transaction that can never be read here (a version 1 transaction) is
//      skipped, counted and logged;
//   3. their events, decoded with the SDK's own decoder (eventsFromTransaction); the Swapped, CurveOpened and
//      Graduated events kept per pool, newest first, at most TRADES_KEEP, in status/trades/<pool>.json.
//
// A pool that existed before the feed started is backfilled once: its own last BACKFILL_LIMIT transactions. A
// pool created while the feed runs needs no backfill: its creation transaction is in the feed. The cursor, the
// slot the feed started at and what is known of each pool live in state/feed.json, so a restart goes on where
// the last pass stopped.
//
// The top half is pure and tested offline. The bottom half reads the chain and writes the files.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { PROGRAMS, eventsFromTransaction } from "../../sdk/dist/index.js";
import { earnedFromLogs, receivedFromLogs, txAccountKeys } from "./events.mjs";

/// The most events a pool's file keeps (the three kinds together).
export const TRADES_KEEP = 300;
/// The most transactions the one backfill of a pool reads.
export const BACKFILL_LIMIT = 200;
/// The RPC's largest page of getSignaturesForAddress.
export const SIGNATURES_PER_PAGE = 1000;
/// The most pages one pass reads. More than this many new transactions in one pass is a gap (see `collect`).
export const MAX_PAGES = 20;
/// getTransaction items in one batched request, and the pause between two such requests: about 40 requests a
/// second, under the 50 a second of the paid plan the watcher runs on (its limits page counts every item of a
/// batch as a request).
export const TX_PER_REQUEST = 25;
export const PAUSE_BETWEEN_REQUESTS_MS = 600;
/// A batch the RPC refuses as too many requests (HTTP 429) is sent again after a pause that doubles each time,
/// this many times, before the pass fails. 1, 2, 4, 8, 16 s: 31 s in all.
export const RATE_LIMIT_RETRIES = 5;
export const RATE_LIMIT_PAUSE_MS = 1000;
export const RATE_LIMIT_PAUSE_MAX_MS = 16_000;
/// A transaction the RPC lists and does not serve stops the walk right before it, for this many passes in a row;
/// then it is skipped as unreadable, so that one transaction an RPC never serves cannot stall the feed for good.
export const MAX_UNSERVED_PASSES = 30;
/// How many walked signatures the feed remembers, so that an RPC listing one again never makes it read twice.
export const RECENT_KEEP = 5000;
/// The kinds a pool's file keeps.
export const FEED_KINDS = new Set(["Swapped", "CurveOpened", "Graduated"]);
export const FEED_VERSION = 1;
const OUR_PROGRAMS = Object.values(PROGRAMS).map((p) => p.toBase58());

const big = (v) => BigInt(v);
const errMsg = (e) => (e && e.message ? e.message : String(e));
/// A base58 address of 32 to 44 characters: the only names a file in the trades folder may have.
export const POOL_NAME = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---- pure part ---------------------------------------------------------------------------------------------

/// One decoded event as the file holds it: the SDK's object with every bigint as a decimal string and every
/// address as base58, plus the transaction's signature and block time (0 when the RPC has none, as the SDK's
/// client.allEvents does). Field order: kind, signature, blockTime, then the event's own fields.
export function eventJson(ev, signature, blockTime) {
  const out = { kind: ev.kind, signature, blockTime: blockTime ?? 0 };
  for (const [k, v] of Object.entries(ev)) {
    if (k === "kind") continue;
    out[k] = typeof v === "bigint" ? v.toString() : v && typeof v.toBase58 === "function" ? v.toBase58() : v;
  }
  return out;
}

/// The events of one transaction that the feed keeps, by pool, in the order the SDK decodes them, and the pools
/// whose creation this transaction is (their PoolCreated event), with the block time. `pools` is every pool any
/// event of the transaction names (a liquidity change, a hook fee and the like included): a pool account that
/// changed. A failed transaction has no events.
export function txEvents(tx, signature) {
  const byPool = new Map();
  const created = new Map();
  const pools = new Set();
  if (!tx || !tx.meta || tx.meta.err) return { byPool, created, pools };
  let events = [];
  try { events = eventsFromTransaction(tx, OUR_PROGRAMS); } catch { events = []; }
  const blockTime = tx.blockTime ?? 0;
  for (const ev of events) {
    if (!ev || !ev.pool || typeof ev.pool.toBase58 !== "function") continue;
    const pool = ev.pool.toBase58();
    pools.add(pool);
    if (ev.kind === "PoolCreated") created.set(pool, blockTime);
    if (!FEED_KINDS.has(ev.kind)) continue;
    if (!byPool.has(pool)) byPool.set(pool, []);
    byPool.get(pool).push(eventJson(ev, signature, blockTime));
  }
  return { byPool, created, pools };
}

/// Events of several transactions, by pool, newest transaction first and the events of one transaction in the
/// order they were decoded. `items` are { signature, tx } oldest first, as the feed walks them. `pools` is every
/// pool any event names.
export function groupNewestFirst(items) {
  const byPool = new Map();
  const created = new Map();
  const pools = new Set();
  for (let i = items.length - 1; i >= 0; i--) {
    const { signature, tx } = items[i];
    const got = txEvents(tx, signature);
    for (const [pool, list] of got.byPool) { if (!byPool.has(pool)) byPool.set(pool, []); byPool.get(pool).push(...list); }
    for (const [pool, t] of got.created) created.set(pool, t);
    for (const pool of got.pools) pools.add(pool);
  }
  return { byPool, created, pools };
}

/// What the transactions of a pass touched, beyond the events the files keep: `pools`, every pool account that
/// changed (the pools of every event, the pools created, and every pool of `known` among the transactions'
/// account keys: a pool that changes is writable in its transaction, so it is there even when no event names it),
/// and `earned`, the PiecesEarned events the collectible hook logged in them (pool, user, pieces, slot,
/// targetSlot, signature): the buys that earned pieces, for the mint crank and the ticket index. `received`: the
/// wallets whose ticket gained pieces otherwise in them (a PiecesTransferred that moved pieces, a PieceSent: pool,
/// user, slot), for the ticket index. `swaps`: the wallets that traded ({ pool, user } of every Swapped event that
/// is not the hook's own buy), for the settle crank's hot wallets. `items` are { signature, tx }; `known` is a set
/// or object of base58 pool addresses.
export function touchedByTransactions(items, known = {}) {
  const pools = new Set();
  const earned = [];
  const received = [];
  const swaps = [];
  const isKnown = (k) => (known instanceof Set ? known.has(k) : !!known[k]);
  for (const { signature, tx } of items) {
    if (!tx || !tx.meta || tx.meta.err) continue;
    const got = txEvents(tx, signature);
    for (const pool of got.pools) pools.add(pool);
    for (const [pool, list] of got.byPool) for (const e of list) if (e.kind === "Swapped" && !e.byHook && typeof e.user === "string") swaps.push({ pool, user: e.user, direction: e.direction });
    for (const k of txAccountKeys(tx)) if (isKnown(k)) pools.add(k);
    for (const ev of earnedFromLogs(tx.meta.logMessages)) earned.push({ ...ev, signature });
    for (const ev of receivedFromLogs(tx.meta.logMessages)) received.push({ ...ev, slot: Number.isFinite(tx.slot) ? BigInt(tx.slot) : null, signature });
  }
  return { pools, earned, received, swaps };
}

/// The identity of each event of a list: its transaction's signature, its kind and its index among the events of
/// that kind of that transaction, in the list's order (the SDK's decode order). One transaction may carry two
/// Swapped events of one pool (a trade and the hook's own buy), so the signature alone is not enough. An exact
/// copy of an event already in the list (every field the same) is no new event: it gets no key (null), and the
/// merge drops it.
export function eventKeys(list) {
  const count = new Map();
  const seen = new Set();
  return list.map((e) => {
    const body = JSON.stringify(e);
    if (seen.has(body)) return null;
    seen.add(body);
    const k = `${e.signature}|${e.kind}`;
    const n = count.get(k) ?? 0;
    count.set(k, n + 1);
    return `${k}|${n}`;
  });
}

/// A pool's list with new events merged in: newest first by slot, at most `keep`. An event already in the list is
/// not added again, by (signature, kind, index in the transaction): the backfill and the feed may both read a
/// transaction, and an RPC may list one twice. The incoming list is deduplicated within itself the same way, and
/// so is the list kept (a file written by an older watcher may hold an event twice). Within one slot the newer
/// batch goes first (`incomingNewer`: the feed's batches are newer than what is in the list, a backfill's are
/// older), and each batch keeps its own order. `added` counts new events, `dropped` the doubles removed from the
/// list kept.
export function mergeEvents(existing, incoming, { incomingNewer = true, keep = TRADES_KEEP } = {}) {
  const oldKeys = eventKeys(existing);
  const kept = existing.filter((_, i) => oldKeys[i] !== null);
  const have = new Set(oldKeys.filter((k) => k !== null));
  const newKeys = eventKeys(incoming);
  const fresh = [];
  for (let i = 0; i < incoming.length; i++) {
    const k = newKeys[i];
    if (k === null || have.has(k)) continue;
    have.add(k);
    fresh.push(incoming[i]);
  }
  const dropped = existing.length - kept.length;
  if (!fresh.length) return { events: kept.slice(0, keep), added: 0, dropped };
  const ordered = incomingNewer ? [...fresh, ...kept] : [...kept, ...fresh];
  const tagged = ordered.map((e, i) => ({ e, i, s: big(e.slot) }));
  tagged.sort((a, b) => (a.s > b.s ? -1 : a.s < b.s ? 1 : a.i - b.i));
  return { events: tagged.slice(0, keep).map((t) => t.e), added: fresh.length, dropped };
}

/// The pool's CurveOpened and Graduated events, kept apart from the capped list. The first one seen of each stays.
export function pinCurve(curve, events) {
  const out = { opened: curve && curve.opened ? curve.opened : null, graduated: curve && curve.graduated ? curve.graduated : null };
  for (const e of events) {
    if (e.kind === "CurveOpened" && !out.opened) out.opened = e;
    if (e.kind === "Graduated" && !out.graduated) out.graduated = e;
  }
  return out;
}

/// What one pass reads, out of the new signatures (newest first, as the RPC lists them): oldest first, at most
/// `maxTx` transactions that did not fail. A failed transaction changes nothing and is walked past unread. `more`:
/// signatures were left for the next pass.
export function planWalk(sigs, maxTx) {
  const oldestFirst = [...sigs].reverse();
  const walk = [];
  let fetch = 0;
  for (const s of oldestFirst) {
    if (!s.err) { if (fetch >= maxTx) break; fetch += 1; }
    walk.push(s);
  }
  return { walk, fetch: walk.filter((s) => !s.err), more: walk.length < oldestFirst.length };
}

/// Every signature newer than `until`, newest first, page after page. Without `until` (a program that had no
/// transaction when the feed started), every signature after `stopSlot`. `complete` is false when `maxPages`
/// full pages did not reach the end: more is missing than one pass may read. `list(opts)` is the RPC call.
///
/// `floorSlot` is the cursor's slot. Nothing new is older than the cursor, so a signature below it ends the list:
/// an RPC node that does not know the cursor yet (a node of a load-balanced endpoint that lags behind the one
/// that listed it) answers from its own newest signature down, all of it walked already, and without this rule
/// that would be read again (and, with enough history, look like a gap). `belowFloor` says the list ended there.
/// `seen` holds signatures already walked: they are skipped, and so is a signature listed twice. `skipped` counts
/// both.
export async function listNewSignatures(list, { until = null, stopSlot = null, floorSlot = null, seen = null, perPage = SIGNATURES_PER_PAGE, maxPages = MAX_PAGES } = {}) {
  const out = [];
  const mine = new Set();
  let skipped = 0;
  let before = null;
  for (let page = 0; page < maxPages; page++) {
    const opts = { limit: perPage };
    if (until) opts.until = until;
    if (before) opts.before = before;
    const got = await list(opts);
    let stop = false;
    let belowFloor = false;
    for (const s of got) {
      if (stopSlot !== null && stopSlot !== undefined && s.slot <= stopSlot) { stop = true; break; }
      if (floorSlot !== null && floorSlot !== undefined && s.slot < floorSlot) { stop = true; belowFloor = true; break; }
      if (mine.has(s.signature) || (seen && seen.has(s.signature))) { skipped += 1; continue; }
      mine.add(s.signature);
      out.push(s);
    }
    if (stop || got.length < perPage) return { sigs: out, complete: true, pages: page + 1, skipped, belowFloor };
    before = got[got.length - 1].signature;
  }
  return { sigs: out, complete: false, pages: maxPages, skipped, belowFloor: false };
}

/// The newest Swapped event's block time in a list (newest first), or null.
export function lastTradeTimeOf(events) {
  const e = events.find((x) => x.kind === "Swapped" && x.blockTime);
  return e ? e.blockTime : null;
}

/// A pool's file, in the exact shape of FEED-CONTRACT.md.
export function tradesFile({ pool, updatedAt, slot, backfill, curve, events }) {
  return {
    version: FEED_VERSION, pool, updatedAt, slot,
    backfill: backfill ? { transactions: backfill.transactions, reachedCreation: !!backfill.reachedCreation } : { transactions: 0, reachedCreation: false },
    curve: { opened: curve && curve.opened ? curve.opened : null, graduated: curve && curve.graduated ? curve.graduated : null },
    events,
  };
}

/// How many of the transactions the feed could not read it remembers by name (the count goes on).
export const UNREADABLE_KEEP = 20;

export function emptyFeedState() {
  return { version: FEED_VERSION, cursor: null, cursorSlot: null, startSlot: null, startedAt: null, transactions: 0, gaps: 0, unreadable: 0, unreadableLast: [], pools: {} };
}

/// The feed's memory, from its file. Anything unreadable starts the feed again (the files it wrote stay, and the
/// backfill merges into them without doubles).
export function loadFeedState(file) {
  try {
    if (!fs.existsSync(file)) return emptyFeedState();
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    const e = emptyFeedState();
    if (!p || typeof p !== "object" || p.version !== FEED_VERSION) return e;
    e.cursor = typeof p.cursor === "string" ? p.cursor : null;
    e.cursorSlot = Number.isFinite(p.cursorSlot) ? p.cursorSlot : null;
    e.startSlot = Number.isFinite(p.startSlot) ? p.startSlot : null;
    e.startedAt = typeof p.startedAt === "string" ? p.startedAt : null;
    e.transactions = Number.isFinite(p.transactions) ? p.transactions : 0;
    e.gaps = Number.isFinite(p.gaps) ? p.gaps : 0;
    e.unreadable = Number.isFinite(p.unreadable) ? p.unreadable : 0;
    e.unreadableLast = Array.isArray(p.unreadableLast)
      ? p.unreadableLast.filter((u) => u && typeof u.signature === "string").slice(-UNREADABLE_KEEP).map((u) => ({ signature: u.signature, slot: Number.isFinite(u.slot) ? u.slot : null, reason: typeof u.reason === "string" ? u.reason : "", at: typeof u.at === "string" ? u.at : null }))
      : [];
    if (p.pools && typeof p.pools === "object" && !Array.isArray(p.pools)) {
      for (const [k, v] of Object.entries(p.pools)) if (POOL_NAME.test(k) && v && typeof v === "object") e.pools[k] = {
        backfill: v.backfill && typeof v.backfill === "object" ? { transactions: Number(v.backfill.transactions) || 0, reachedCreation: !!v.backfill.reachedCreation } : null,
        createdSlot: typeof v.createdSlot === "string" ? v.createdSlot : null,
        createdTime: Number.isFinite(v.createdTime) ? v.createdTime : null,
        lastTradeTime: Number.isFinite(v.lastTradeTime) ? v.lastTradeTime : null,
      };
    }
    return e;
  } catch {
    return emptyFeedState();
  }
}

// ---- files -------------------------------------------------------------------------------------------------

/// Temp file, then rename: a reader never sees half a file. On Windows a rename onto a file that a reader holds
/// open for a moment can be refused: tried again a few times.
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof value === "string" ? value : JSON.stringify(value));
  for (let n = 0; ; n++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (n >= 5 || !(e && (e.code === "EPERM" || e.code === "EACCES" || e.code === "EBUSY"))) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
      const until = Date.now() + 20 * (n + 1); while (Date.now() < until) { /* a short wait */ }
    }
  }
}

/// Is a process with this id running? A process of another user answers EPERM: it runs.
function processRuns(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}

/// This machine's boot, where the system says it (Linux: /proc/sys/kernel/random/boot_id), else null.
export function bootId() {
  try { const s = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); return s || null; } catch { return null; }
}

/// When a process started, in clock ticks since the boot (Linux: field 22 of /proc/<pid>/stat), else null. With the
/// boot it names one process for good: a process id the system hands out again later has another start.
export function processStart(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
    const v = rest[19];
    return /^\d+$/.test(v ?? "") ? v : null;
  } catch { return null; }
}

/// Is the process that wrote this lock still the one running under its id? A lock written on another boot is not
/// held (a reboot ends every process); one whose id now belongs to a process that started at another time is not
/// held either. A lock without these two facts (another system, an older watcher) is judged by its id alone.
export function lockHolderRuns(held, { boot = bootId(), startOf = processStart } = {}) {
  if (!held || !processRuns(held.pid)) return false;
  if (held.boot && boot && held.boot !== boot) return false;
  if (held.start) { const now = startOf(held.pid); if (now !== null && now !== held.start) return false; }
  return true;
}

/// Where the feed's lock lives: `<stateFile>.lock` next to the feed's state, or, with a lock folder (LOCK_DIR, a
/// runtime folder that a reboot empties: /run/programmable-watcher under systemd), a file named after the state
/// file's full path in that folder, so that two watchers on two sets of files never share one.
export function feedLockFile(stateFile, dir = null) {
  if (!dir) return `${stateFile}.lock`;
  const id = crypto.createHash("sha256").update(path.resolve(stateFile)).digest("hex").slice(0, 12);
  return path.join(dir, `feed-${id}.lock`);
}

/// One feed per state file. Two watchers running the feed on the same files (a `--once` started next to the
/// service, say) would each read every new transaction and write over each other's files. The first takes the lock
/// (`feedLockFile`) with its process id, the machine's boot and the process's start; a second finds it held by
/// the running process that wrote it and must run without the feed. A lock left by a process that is gone, by an
/// earlier boot, or under an id the system has given to another process since, is taken over. Answers { ok, pid,
/// since, file }; `release()` removes it. A lock folder that cannot be made is not used: the lock goes next to the
/// state file instead (`fallback` says why).
export function acquireFeedLock(stateFile, { pid = process.pid, dir = null, boot = bootId(), startOf = processStart } = {}) {
  let file = feedLockFile(stateFile, dir);
  let fallback = null;
  if (dir) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); } catch (e) { fallback = `the lock folder ${dir} cannot be used (${e && e.code ? e.code : errMsg(e)})`; file = feedLockFile(stateFile, null); }
  }
  let held = null;
  try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch { held = null; }
  if (held && held.pid !== pid && lockHolderRuns(held, { boot, startOf })) return { ok: false, pid: held.pid, since: held.since ?? null, file, fallback, release: () => {} };
  const mine = { pid, since: new Date().toISOString(), boot: boot ?? null, start: startOf(pid), stateFile: path.resolve(stateFile) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, JSON.stringify(mine)); } catch {
      // a stale lock this user may not write over (left by a run as another user): removed, then written
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, JSON.stringify(mine));
    }
  } catch (e) {
    // the lock cannot be written at all: no feed, rather than two feeds on the same files
    return { ok: false, pid: held ? held.pid : null, since: held ? held.since ?? null : null, file, fallback, error: `the lock ${file} cannot be written (${e && e.code ? e.code : errMsg(e)})`, release: () => {} };
  }
  const release = () => {
    try { const now = JSON.parse(fs.readFileSync(file, "utf8")); if (now && now.pid === pid) fs.unlinkSync(file); } catch { /* gone */ }
  };
  return { ok: true, pid, since: mine.since, file, fallback, release };
}

// ---- network -----------------------------------------------------------------------------------------------

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const TX_OPTS = { maxSupportedTransactionVersion: 0, commitment: "confirmed" };
/// Single requests at a time when a batch has to be read one transaction at a time (below).
const SINGLE_CONCURRENCY = 8;

/// The first signature of a transaction as the RPC answered it: the transaction's own id, and what an answer is
/// paired by. null when the answer carries none.
export function firstSignature(tx) {
  const sigs = tx && tx.transaction && tx.transaction.signatures;
  const s = Array.isArray(sigs) && sigs.length ? sigs[0] : null;
  return typeof s === "string" ? s : null;
}

/// The RPC answered that it serves this transaction only to a reader that accepts a newer transaction version
/// (JSON-RPC error -32015). The feed reads versions 0 and legacy, as the SDK decodes them.
export function isUnsupportedVersion(e) {
  return !!e && (e.code === -32015 || /transaction version \(\d+\) is not supported/i.test(String(e.message ?? e)));
}

/// An error about one answer (a JSON-RPC error inside the answer, or an answer web3.js could not read), not about
/// the RPC as a whole (a network failure, an HTTP refusal, a rate limit).
export function isAnswerError(e) {
  return !!e && (e.name === "SolanaJSONRPCError" || e.name === "StructError" || typeof e.code === "number");
}

/// An error of the RPC as a whole: it could not be reached, it did not answer in time, or it answered with an HTTP
/// error (web3.js words those "<status> <text>: <body>"). The pass fails on it and the next one tries again.
export function isTransportError(e) {
  if (!e) return false;
  if (isAnswerError(e)) return false;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  const m = String(e.message ?? e);
  return /^\s*\d{3}\b/.test(m) || /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|aborted|timed? ?out|network/i.test(m);
}

/// The RPC refused the request as too many (HTTP 429, web3.js words it "429 Too Many Requests: ...").
export function isRateLimited(e) {
  if (!e || isAnswerError(e)) return false;
  const m = String(e.message ?? e);
  return /^\s*429\b/.test(m) || /too many requests|rate limit/i.test(m);
}

/// The pause before the next try of a batch the RPC rate limited: 1 s, then 2, 4, 8, 16 (the cap).
export function rateLimitPauseMs(attempt, base = RATE_LIMIT_PAUSE_MS, max = RATE_LIMIT_PAUSE_MAX_MS) {
  return Math.min(base * 2 ** attempt, max);
}

/// getTransaction for every signature, TX_PER_REQUEST to a batched request, with a pause between requests.
///
/// An RPC may answer the items of a batch in any order (each answer carries its request id, and web3.js pairs them
/// by position), so every answer is paired with its signature by the transaction's OWN first signature, never by
/// its place. Answers: `txs`, a Map from each signature to its transaction, or null where the RPC has none (yet);
/// `unreadable`, a Map from a signature to the reason it can never be read here.
///
/// web3.js throws a whole batch away when one of its answers is an error, and a version 1 transaction is such an
/// answer (-32015). Then that batch is read one transaction at a time: a version 1 transaction is unreadable, and so
/// is one whose answer web3.js cannot read; another JSON-RPC error about one transaction leaves it null (tried again
/// at the next pass). A batch the RPC rate limits (429) is sent again after a pause that doubles each time
/// (`rateLimitRetries` times, `onRateLimit(pauseMs, attempt)` says so), so that a busy minute does not fail the
/// pass at the same batch every ten seconds. Any other error of the RPC itself (it cannot be reached, it refuses)
/// is thrown, as before: the pass fails and the next one tries again. `rateLimited` counts the pauses taken.
export async function fetchTransactions(connection, signatures, { perRequest = TX_PER_REQUEST, pauseMs = PAUSE_BETWEEN_REQUESTS_MS, rateLimitRetries = RATE_LIMIT_RETRIES, rateLimitPause = rateLimitPauseMs, onRateLimit = null } = {}) {
  const txs = new Map(signatures.map((s) => [s, null]));
  const unreadable = new Map();
  let singles = 0;
  let rateLimited = 0;
  for (let i = 0; i < signatures.length; i += perRequest) {
    if (i > 0 && pauseMs > 0) await pause(pauseMs);
    const part = signatures.slice(i, i + perRequest);
    const wanted = new Set(part);
    let got = null;
    for (let attempt = 0; ; attempt++) {
      try {
        got = await connection.getTransactions(part, TX_OPTS);
        break;
      } catch (e) {
        if (isRateLimited(e) && attempt < rateLimitRetries) {
          const wait = rateLimitPause(attempt);
          rateLimited += 1;
          if (onRateLimit) onRateLimit(wait, attempt + 1);
          await pause(wait);
          continue;
        }
        if (isTransportError(e)) throw e;
        break;
      }
    }
    if (got) {
      for (const tx of got) {
        const s = firstSignature(tx);
        if (s !== null && wanted.has(s)) txs.set(s, tx);
      }
      continue;
    }
    singles += part.length;
    for (let j = 0; j < part.length; j += SINGLE_CONCURRENCY) {
      await Promise.all(part.slice(j, j + SINGLE_CONCURRENCY).map(async (s) => {
        try {
          const tx = await connection.getTransaction(s, TX_OPTS);
          const own = firstSignature(tx);
          // one request, one answer: paired by construction; an answer for another transaction is no answer
          if (tx && (own === null || own === s)) txs.set(s, tx);
        } catch (e) {
          if (isUnsupportedVersion(e)) unreadable.set(s, "a version 1 transaction: the RPC serves it only to a reader of version 1, and the feed reads versions 0 and legacy");
          else if (isTransportError(e)) throw e;
          else if (!isAnswerError(e) || e.name === "StructError") unreadable.set(s, "the RPC's answer for it could not be read");
          // another JSON-RPC error about this one transaction: not served this time, tried again at the next pass
        }
      }));
    }
  }
  return { txs, unreadable, singles, rateLimited };
}

/// The wallets that traded a pool recently, newest first, from the pool's trades file (the served file, else the
/// part file of a pool waiting for its backfill), without doubles: what the pool check reads its holders from when
/// the RPC does not list a coin's largest holders. The hook's own buys (`byHook`) are not a holder's. `found` is
/// false when there is no file for the pool (yet).
export function tradersOf(dir, pool, { max = 50 } = {}) {
  const name = typeof pool === "string" ? pool : pool.toBase58();
  if (!dir || !POOL_NAME.test(name)) return { found: false, traders: [] };
  for (const file of [path.join(dir, `${name}.json`), path.join(dir, "part", `${name}.json`)]) {
    let f = null;
    try { f = JSON.parse(fs.readFileSync(file, "utf8")); } catch { f = null; }
    if (!f || f.version !== FEED_VERSION || !Array.isArray(f.events)) continue;
    const out = [];
    const seen = new Set();
    for (const e of f.events) {
      if (!e || e.kind !== "Swapped" || e.byHook || typeof e.user !== "string" || seen.has(e.user)) continue;
      seen.add(e.user);
      try { out.push(new PublicKey(e.user)); } catch { /* not an address */ }
      if (out.length >= max) break;
    }
    return { found: true, traders: out };
  }
  return { found: false, traders: [] };
}

export class TradesFeed {
  /// `dir`: the folder of the pools' files. `stateFile`: the feed's memory. `connection`: web3.js (or anything with
  /// getSignaturesForAddress and getTransactions). `fetchOpts` reach fetchTransactions (the tests turn the pause off).
  constructor({ connection, dir, stateFile, log = null, now = () => Date.now(), keep = TRADES_KEEP, backfillLimit = BACKFILL_LIMIT, maxTxPerPass = 200, backfillTxPerPass = 400, program = PROGRAMS.hookpool, fetchOpts = {}, perPage = SIGNATURES_PER_PAGE, maxPages = MAX_PAGES, maxUnservedPasses = MAX_UNSERVED_PASSES }) {
    Object.assign(this, { connection, dir, stateFile, log, now, keep, backfillLimit, maxTxPerPass, backfillTxPerPass, program, fetchOpts, perPage, maxPages, maxUnservedPasses });
    this.state = loadFeedState(stateFile);
    this.files = new Map();      // pool -> its file as it stands, for the pools touched in this pass
    this.dirty = new Set();
    this.lastPass = null;        // { at, slot, completeSlot, sigs, transactions, pools, more, backfilled }
    this.recent = new Set();     // the signatures the feed walked lately: never walked again
    this.unserved = new Map();   // signature -> passes in a row the RPC listed it and did not serve it
  }

  /// Remember walked signatures (at most RECENT_KEEP, the oldest forgotten first).
  remember(signatures) {
    for (const s of signatures) { this.recent.delete(s); this.recent.add(s); }
    while (this.recent.size > RECENT_KEEP) this.recent.delete(this.recent.values().next().value);
  }

  /// A transaction the feed walks past without its events: counted, named in the state (the last UNREADABLE_KEEP),
  /// and one warning in the log. The same signature is counted once.
  skipUnreadable(signature, slot, reason) {
    const st = this.state;
    if (st.unreadableLast.some((u) => u.signature === signature)) return false;
    st.unreadable += 1;
    st.unreadableLast.push({ signature, slot: Number.isFinite(slot) ? slot : null, reason, at: new Date(this.now()).toISOString() });
    if (st.unreadableLast.length > UNREADABLE_KEEP) st.unreadableLast = st.unreadableLast.slice(-UNREADABLE_KEEP);
    if (this.log) this.log.warn(`feed: transaction ${signature}${Number.isFinite(slot) ? ` (slot ${slot})` : ""} cannot be read and is skipped: ${reason}. Any trade in it is missing from the trades files. ${st.unreadable} skipped so far.`);
    return true;
  }

  /// The file the server serves. A pool whose backfill has not run yet keeps what the feed found for it in a
  /// part file (`partOf`), which nobody serves: until its backfill the site reads the chain for it.
  fileOf(pool) { return path.join(this.dir, `${pool}.json`); }
  partOf(pool) { return path.join(this.dir, "part", `${pool}.json`); }

  /// A pool's file: from this pass's memory, else from disk (the served file, else the part file), else a new
  /// empty one.
  read(pool) {
    if (this.files.has(pool)) return this.files.get(pool);
    let f = null;
    for (const file of [this.fileOf(pool), this.partOf(pool)]) {
      try { f = JSON.parse(fs.readFileSync(file, "utf8")); } catch { f = null; }
      if (f && f.version === FEED_VERSION && Array.isArray(f.events)) break;
      f = null;
    }
    if (!f) f = { events: [], curve: { opened: null, graduated: null } };
    this.files.set(pool, f);
    return f;
  }

  entry(pool) {
    return this.state.pools[pool] ?? (this.state.pools[pool] = { backfill: null, createdSlot: null, createdTime: null, lastTradeTime: null });
  }

  /// What market.json takes from the feed for one pool.
  info(pool) {
    const e = this.state.pools[pool];
    return { createdTime: e ? e.createdTime : null, lastTradeTime: e ? e.lastTradeTime : null };
  }

  /// Merge events into a pool's file (in memory until `flush`).
  merge(pool, incoming, incomingNewer) {
    const f = this.read(pool);
    const m = mergeEvents(f.events ?? [], incoming, { incomingNewer, keep: this.keep });
    f.events = m.events;
    f.curve = pinCurve(f.curve, incoming);
    const e = this.entry(pool);
    const t = lastTradeTimeOf(f.events);
    if (t !== null && (e.lastTradeTime === null || t > e.lastTradeTime)) e.lastTradeTime = t;
    if (m.dropped > 0 && this.log) this.log.warn(`feed: pool ${pool}: ${m.dropped} doubled events removed from its file`);
    if (m.added > 0 || m.dropped > 0 || !fs.existsSync(this.fileOf(pool))) this.dirty.add(pool);
    return m.added;
  }

  list(address, opts) { return this.connection.getSignaturesForAddress(address, opts, "confirmed"); }

  /// One pass over the pool program's new transactions. `slot` is the newest slot known at the start of the pass.
  /// Answers what it read: `transactions` (that did not fail), `touched` (pools with new events), `touchedPools`
  /// (every pool account the transactions changed: the pools of every event, the pools created, every known pool
  /// among their account keys), `created` (the pools their PoolCreated events name), `newestSlot` (the newest slot
  /// walked, null when none), `earned` (the PiecesEarned events of the collectible hook in them, with their
  /// signatures), `received` (wallets whose ticket gained pieces by a move), `swaps` (the wallets that traded),
  /// `unreadable` (transactions walked past unread this pass: their pools are not known), `more` (left for the next
  /// pass), `completeSlot` (the feed holds every event up to this slot), `gap` (the feed started over), `cursorLost`
  /// (the RPC no longer knew the cursor: the list ran down to its slot instead), `rateLimited` (batches the RPC
  /// refused as too many, each sent again after a pause).
  async collect(slot) {
    const st = this.state;
    const nowIso = new Date(this.now()).toISOString();
    if (st.startSlot === null) {
      // The first pass ever: the newest signature becomes the cursor. Everything before it is history, which the
      // backfill of each pool reads; everything after it is the feed's.
      const newest = await this.list(this.program, { limit: 1 });
      st.startedAt = nowIso;
      if (newest.length) { st.cursor = newest[0].signature; st.cursorSlot = newest[0].slot; }
      st.startSlot = Math.max(slot, st.cursorSlot ?? 0);
      return { sigs: 0, transactions: 0, touched: [], touchedPools: [], earned: [], received: [], swaps: [], created: [], newestSlot: null, unreadable: 0, more: false, completeSlot: st.startSlot, gap: false, first: true, rateLimited: 0 };
    }
    // Without a cursor (lost, below) the list runs down to the slot the cursor was at.
    const listOpts = () => ({ until: st.cursor, stopSlot: st.cursor ? null : (st.cursorSlot ?? st.startSlot), floorSlot: st.cursor ? st.cursorSlot : null, seen: this.recent, perPage: this.perPage, maxPages: this.maxPages });
    let listed;
    let cursorLost = false;
    try {
      listed = await listNewSignatures((o) => this.list(this.program, o), listOpts());
    } catch (e) {
      // The RPC no longer knows the cursor's transaction: a node that keeps a short history (the cursor sat on a
      // quiet program longer than the node keeps transactions), or a node of a load-balanced endpoint that lags.
      // Without this, every pass would fail the same way for good. The cursor is dropped and the list runs down to
      // its slot instead; what may have been missed is unknown, so the pass reports `cursorLost` (the pools are then
      // owed a read of the whole program).
      if (!st.cursor || !/not found/i.test(errMsg(e))) throw e;
      if (this.log) this.log.warn(`feed: the RPC does not know the feed's cursor ${st.cursor} (slot ${st.cursorSlot ?? "unknown"}) any more (${String(errMsg(e)).slice(0, 160)}): the new transactions are listed down to that slot instead`);
      st.cursor = null;
      cursorLost = true;
      listed = await listNewSignatures((o) => this.list(this.program, o), listOpts());
    }
    if (listed.skipped && this.log) this.log.debug(`feed: ${listed.skipped} signatures listed again by the RPC were skipped (walked already)`);
    if (!listed.complete && listed.sigs.length) {
      // More new transactions than MAX_PAGES pages: the feed was off for a long time. It starts again from the
      // newest one, and every pool is backfilled again (the files keep what they have; no event is doubled).
      const newest = listed.sigs[0];
      st.cursor = newest.signature; st.cursorSlot = newest.slot;
      st.startSlot = Math.max(slot, newest.slot);
      st.gaps += 1;
      for (const e of Object.values(st.pools)) e.backfill = null;
      if (this.log) this.log.warn(`feed: more than ${this.maxPages * this.perPage} transactions of the pool program arrived since the last pass; the feed starts again at slot ${st.startSlot} and backfills every pool`);
      return { sigs: listed.sigs.length, transactions: 0, touched: [], touchedPools: [], earned: [], received: [], swaps: [], created: [], newestSlot: Number.isFinite(newest.slot) ? newest.slot : null, unreadable: 0, more: false, completeSlot: st.startSlot, gap: true, cursorLost, rateLimited: 0 };
    }
    if (!listed.sigs.length) {
      // Nothing new. When the list ran below the cursor right away, the node that answered had not seen the cursor
      // yet (it lags behind): the feed is complete up to the cursor, not up to the slot of this pass.
      if (listed.belowFloor && this.log) this.log.debug("feed: the RPC node that answered does not know the feed's cursor yet (it lags behind); the next pass reads again");
      return { sigs: 0, transactions: 0, touched: [], touchedPools: [], earned: [], received: [], swaps: [], created: [], newestSlot: null, unreadable: 0, more: false, completeSlot: listed.belowFloor ? (st.cursorSlot ?? slot) : slot, gap: false, cursorLost, rateLimited: 0 };
    }
    const plan = planWalk(listed.sigs, this.maxTxPerPass);
    const onRateLimit = (wait, attempt) => { if (this.log) this.log.warn(`feed: the RPC answered 429 (too many requests) to a batch of transactions; waiting ${wait / 1000} s before try ${attempt + 1}`); };
    const got = plan.fetch.length ? await fetchTransactions(this.connection, plan.fetch.map((s) => s.signature), { onRateLimit, ...this.fetchOpts }) : { txs: new Map(), unreadable: new Map(), rateLimited: 0 };
    // A transaction the RPC cannot serve yet stops the walk right before it: the next pass reads it. One that can
    // never be read here (a version 1 transaction), or that the RPC kept listing without serving it for
    // MAX_UNSERVED_PASSES passes, is walked past: counted and logged, its events missing from the files.
    let cut = plan.walk.length;
    const skip = new Set();
    for (let i = 0; i < plan.walk.length; i++) {
      const s = plan.walk[i];
      if (s.err) continue;
      if (got.unreadable.has(s.signature)) { this.unserved.delete(s.signature); this.skipUnreadable(s.signature, s.slot, got.unreadable.get(s.signature)); skip.add(s.signature); continue; }
      if (got.txs.get(s.signature)) { this.unserved.delete(s.signature); continue; }
      const n = (this.unserved.get(s.signature) ?? 0) + 1;
      if (n >= this.maxUnservedPasses) {
        this.unserved.delete(s.signature);
        this.skipUnreadable(s.signature, s.slot, `the RPC listed it and did not serve it in ${n} passes in a row`);
        skip.add(s.signature);
        continue;
      }
      this.unserved.set(s.signature, n);
      cut = i;
      break;
    }
    while (this.unserved.size > RECENT_KEEP) this.unserved.delete(this.unserved.keys().next().value);
    const walked = plan.walk.slice(0, cut);
    this.remember(walked.map((s) => s.signature));
    const items = walked.filter((s) => !s.err && !skip.has(s.signature)).map((s) => ({ signature: s.signature, tx: got.txs.get(s.signature) }));
    const { byPool, created } = groupNewestFirst(items);
    // every pool these transactions changed, and the buys that earned pieces: known pools first, so that a pool
    // created in this very pass counts as known for the transactions after its creation
    const known = new Set(Object.keys(st.pools));
    for (const pool of created.keys()) known.add(pool);
    const touched = touchedByTransactions(items, known);
    for (const [pool, t] of created) {
      // created while the feed runs: its whole life is in the feed, it needs no backfill
      const e = this.entry(pool);
      if (e.createdTime === null) e.createdTime = t;
      if (e.backfill === null) e.backfill = { transactions: 0, reachedCreation: true };
      this.read(pool);
      this.dirty.add(pool);
    }
    for (const [pool, list] of byPool) this.merge(pool, list, true);
    if (walked.length) { const last = walked[walked.length - 1]; st.cursor = last.signature; st.cursorSlot = last.slot; }
    st.transactions += items.length;
    const more = plan.more || cut < plan.walk.length;
    // the feed holds every event up to the newest slot it walked, at least (the slot given may be older)
    const top = walked.reduce((m, s) => (Number.isFinite(s.slot) && s.slot > m ? s.slot : m), slot);
    // the newest slot walked: the pools these transactions touched are read at that state or later
    const newestSlot = walked.reduce((m, s) => (Number.isFinite(s.slot) && (m === null || s.slot > m) ? s.slot : m), null);
    return {
      sigs: walked.length, transactions: items.length, touched: [...byPool.keys()], touchedPools: [...touched.pools], earned: touched.earned, received: touched.received, swaps: touched.swaps,
      created: [...created.keys()], newestSlot, unreadable: skip.size, more, completeSlot: more ? (st.cursorSlot ?? slot) : top, gap: false, cursorLost, rateLimited: got.rateLimited ?? 0,
    };
  }

  /// The pools of the chain as the market pass read them. A pool created after the feed started needs no
  /// backfill; one created before is backfilled once.
  register(pools) {
    const start = this.state.startSlot === null ? null : BigInt(this.state.startSlot);
    for (const p of pools) {
      const pool = p.address.toBase58();
      const e = this.entry(pool);
      e.createdSlot = p.createdSlot.toString();
      if (e.backfill === null && start !== null && p.createdSlot > start) {
        e.backfill = { transactions: 0, reachedCreation: true };
        this.read(pool);
        this.dirty.add(pool);
      }
    }
  }

  /// The pools still to backfill, the newest first.
  pending() {
    return Object.entries(this.state.pools).filter(([, e]) => e.backfill === null && e.createdSlot !== null)
      .sort((a, b) => { const x = BigInt(a[1].createdSlot); const y = BigInt(b[1].createdSlot); return x > y ? -1 : x < y ? 1 : a[0] < b[0] ? -1 : 1; })
      .map(([k]) => k);
  }

  /// Backfill pools until about `backfillTxPerPass` transactions were read in this pass. Each pool: one
  /// getSignaturesForAddress of at most `backfillLimit`, then its transactions. Answers the pools done.
  async backfill() {
    const done = [];
    let spent = 0;
    for (const pool of this.pending()) {
      if (spent >= this.backfillTxPerPass) break;
      const sigs = await this.list(new PublicKey(pool), { limit: this.backfillLimit });
      const ok = sigs.filter((s) => !s.err);
      const got = ok.length ? await fetchTransactions(this.connection, ok.map((s) => s.signature), this.fetchOpts) : { txs: new Map(), unreadable: new Map() };
      spent += ok.length + 1;
      for (const s of ok) if (got.unreadable.has(s.signature)) this.skipUnreadable(s.signature, s.slot, got.unreadable.get(s.signature));
      // paired by each transaction's own signature (fetchTransactions); one the RPC did not serve is left out
      const items = ok.map((s) => ({ signature: s.signature, tx: got.txs.get(s.signature) ?? null })).filter((x) => x.tx).reverse();
      const { byPool, created } = groupNewestFirst(items);
      this.merge(pool, byPool.get(pool) ?? [], false);
      const e = this.entry(pool);
      // Back to the creation: its PoolCreated event is among them, or the list ended before the limit at the slot
      // the pool was created in. An RPC that keeps no history that far back lists less, and says nothing older.
      const oldest = sigs.length ? sigs[sigs.length - 1] : null;
      const reachedCreation = created.has(pool) || (!!oldest && sigs.length < this.backfillLimit && e.createdSlot !== null && BigInt(oldest.slot) <= BigInt(e.createdSlot));
      e.backfill = { transactions: sigs.length, reachedCreation };
      if (created.has(pool)) e.createdTime = created.get(pool);
      else if (reachedCreation && sigs.length && e.createdTime === null) e.createdTime = sigs[sigs.length - 1].blockTime ?? null;
      this.dirty.add(pool);
      done.push({ pool, transactions: sigs.length, events: (byPool.get(pool) ?? []).length, reachedCreation });
    }
    return done;
  }

  /// Write every pool file this pass changed, then the feed's memory. `slot`: the slot the feed is complete to.
  flush(slot) {
    const updatedAt = new Date(this.now()).toISOString();
    let written = 0;
    for (const pool of this.dirty) {
      const f = this.read(pool);
      const e = this.entry(pool);
      const body = tradesFile({ pool, updatedAt, slot, backfill: e.backfill, curve: f.curve, events: f.events });
      // Not backfilled yet (and never served before): the part file. Served once the backfill ran. A pool that is
      // backfilled again after a gap keeps its served file meanwhile.
      if (e.backfill === null && !fs.existsSync(this.fileOf(pool))) { writeJsonAtomic(this.partOf(pool), body); continue; }
      writeJsonAtomic(this.fileOf(pool), body);
      try { fs.unlinkSync(this.partOf(pool)); } catch { /* there was none */ }
      written += 1;
    }
    this.dirty.clear();
    this.files.clear();
    writeJsonAtomic(this.stateFile, JSON.stringify(this.state, null, 1));
    return written;
  }

  /// One whole pass without the market: the transactions, the backfill, the files. For the tests and for a
  /// watcher that runs the feed alone.
  async pass(slot, pools = null) {
    const c = await this.collect(slot);
    if (pools) this.register(pools);
    const b = await this.backfill();
    const written = this.flush(c.completeSlot);
    this.lastPass = { at: new Date(this.now()).toISOString(), slot, completeSlot: c.completeSlot, sigs: c.sigs, transactions: c.transactions, pools: c.touched.length, more: c.more, backfilled: b.length, written };
    return { ...c, backfilled: b, written };
  }
}

export { errMsg as feedErrMsg };
