// One list of the pools for every loop of the watcher.
//
// Every loop needs the pools: the pool pass, and the settle, upkeep, burn and graduate cranks. Each used to read
// them itself with a getProgramAccounts of its own, every pass: five reads of the whole program a minute or more,
// whatever happened on the chain. Here they share one list.
//
// A pool account changes only in a transaction of the pool program. The trades feed lists those transactions
// every pass (lib/feed.mjs). When it finds none since the list was last read, the list is still the chain's, and
// the feed says so (`confirm`). When it finds some, the feed names the pools they touched (the pools of their
// events, and every known pool among their account keys) and reads those by address, one getMultipleAccountsInfo
// per hundred (`refreshSome`): the list is patched, pool by pool. The whole program is read again
// (getProgramAccounts, `refresh`) only as a reconciliation, every `fullEveryMs`, at the start, and after a gap
// of the feed: that is the one call a shared RPC node aborts under load, so it is rare, and a failure of it is
// tried again with a growing pause while the patches go on.
//
// A read that fails leaves the list OWED a read (`owed`): a patch that failed keeps its addresses (`owedPools`),
// read again by the next pass, and a transaction walked past unread or a gap of the feed (`changesUnknown`: which
// pools changed is not known) wants the whole program; while either stands, `confirm` is refused and no patch moves
// the time the list was last known to be the chain's (`validAt`), so that market.json never says "checked" about a
// list that may be behind the chain. A failed read of the whole program alone (`fullOwed`) is tried again with a
// growing pause and makes `get` read again with the feed off, but does not refuse `confirm`: the feed's list of
// transactions says what changed, and a known pool is still the chain's.
//
// The feed reads the pools by address with `minContextSlot` set to the newest slot it walked: a node that lags
// behind that slot answers JSON-RPC error -32016 instead of an older state, and the pools stay owed for the next
// pass. A pool a PoolCreated event of the walk named that the answer does not hold is owed too (a few passes), not
// dropped.
//
// With the feed on (`feedOwned`), the loops never read: `get` serves the list as it stands, with its age
// (`age()`), and the feed is the only reader; before the feed's first good read (the list is still empty) a loop
// that asks inside the pause after a failed read gets that failure again, without a call. With the feed off, a
// loop that finds the list older than it accepts reads it again, once for every loop waiting at that moment.
import { PublicKey } from "@solana/web3.js";
import { PROGRAMS, ACCOUNT_DISC, decodePool } from "../../sdk/dist/index.js";
import { getMany } from "./chain.mjs";

/// The answer of a node behind the slot the read asked for, as an error the caller treats like -32016.
function behind(slot, minContextSlot) {
  return Object.assign(new Error(`the RPC node answered at slot ${slot}, before slot ${minContextSlot} (minimum context slot not reached)`), { code: -32016 });
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function bs58(bytes) {
  let n = 0n;
  for (const x of bytes) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of bytes) { if (x === 0) s = "1" + s; else break; }
  return s;
}

/// Every pool account of the pool program, decoded, with its raw bytes and the slot it was read at. One call.
/// `minContextSlot`: the oldest state the answer may be (a node behind it answers -32016; one that ignores it and
/// answers older is refused here the same way).
export async function readAllPools(connection, { minContextSlot = null } = {}) {
  const res = await connection.getProgramAccounts(PROGRAMS.hookpool, {
    filters: [{ memcmp: { offset: 0, bytes: bs58(ACCOUNT_DISC.Pool) } }],
    withContext: true,
    ...(minContextSlot !== null && minContextSlot !== undefined ? { minContextSlot: Number(minContextSlot) } : {}),
  });
  // web3.js answers { context, value } with withContext; an older one answers the list alone
  const list = Array.isArray(res) ? res : res.value;
  const slot = Array.isArray(res) ? null : res.context.slot;
  if (minContextSlot !== null && minContextSlot !== undefined && slot !== null && slot < Number(minContextSlot)) throw behind(slot, minContextSlot);
  const pools = [];
  const bytes = new Map();
  for (const a of list) {
    const data = new Uint8Array(a.account.data);
    try { pools.push(decodePool(a.pubkey, data)); bytes.set(a.pubkey.toBase58(), data); } catch { /* not a pool of this layout: skipped */ }
  }
  pools.sort((x, y) => (x.address.toBase58() < y.address.toBase58() ? -1 : 1));
  return { pools, bytes, slot };
}

/// The given pool accounts by address, decoded, with their bytes and the slot of the read: one
/// getMultipleAccountsInfo per hundred. An address that holds no pool (or nothing) answers null. With
/// `minContextSlot` every call carries it: a node behind that slot answers -32016 (thrown), and an answer older
/// than it from a node that ignored it is refused the same way.
export async function readPoolsAt(connection, addresses, { minContextSlot = null } = {}) {
  if (!addresses.length) return { pools: new Map(), bytes: new Map(), slot: null };
  const want = minContextSlot !== null && minContextSlot !== undefined ? Number(minContextSlot) : null;
  const { infos, slot, slots } = await getMany(connection, addresses, 100, want !== null ? { minContextSlot: want } : undefined);
  if (want !== null) for (const s of slots ?? [slot]) if (s !== null && s !== undefined && s < want) throw behind(s, want);
  const pools = new Map();
  const bytes = new Map();
  addresses.forEach((a, i) => {
    const k = a.toBase58();
    const info = infos[i];
    if (!info || !info.data || !info.data.length) { pools.set(k, null); return; }
    const data = new Uint8Array(info.data);
    try { pools.set(k, decodePool(a, data)); bytes.set(k, data); } catch { pools.set(k, null); }
  });
  return { pools, bytes, slot };
}

/// How long the whole program is left unread while the patches keep the list current: the reconciliation period.
export const FULL_READ_EVERY_MS = 1_800_000;
/// After a failed read of the whole program, the next try waits this long, doubled with every failure, up to the cap.
export const FULL_READ_RETRY_MS = 30_000;
export const FULL_READ_RETRY_MAX_MS = 900_000;
/// After this long of failing reads of the whole program, one alert (the owner of the cache decides; see `fullFailingFor`).
export const FULL_READ_ALERT_MS = 3_600_000;

/// A pool a PoolCreated event named that an answer by address did not hold stays owed for this many reads.
export const CREATED_OWED_READS = 3;

export class PoolCache {
  /// `read(opts)` returns { pools, bytes, slot } (readAllPools by default), `readSome(addresses, opts)` what
  /// readPoolsAt returns (`opts`: { minContextSlot }); `now` gives milliseconds. `feedOwned`: the feed reads, the
  /// loops only take (see above).
  constructor({ connection, read = null, readSome = null, now = () => Date.now(), feedOwned = false, fullEveryMs = FULL_READ_EVERY_MS } = {}) {
    this.read = read ?? ((opts) => readAllPools(connection, opts));
    this.readSome = readSome ?? ((addresses, opts) => readPoolsAt(connection, addresses, opts));
    this.now = now;
    this.feedOwned = feedOwned;
    this.fullEveryMs = fullEveryMs;
    this.pools = null;
    this.bytes = new Map();
    this.slot = null;
    this.readAt = 0;     // when the list (or a part of it) was last read
    this.validAt = 0;    // up to when the list is known to be the chain's (the read, or a later feed pass)
    this.reads = 0;      // how many times the whole program was read
    this.patches = 0;    // how many times pools were read by address
    this.fullAt = 0;     // when the whole program was last read
    this.nextFullAt = 0; // when the whole program may be read again (after a failure: later, with a growing pause)
    this.fullFailures = 0;
    this.fullFailedSince = null;
    this.lastError = null;
    this.fullOwed = false;        // a read of the whole program failed, none succeeded since
    this.changesUnknown = false;  // a transaction was walked past unread, or the feed had a gap: which pools changed is not known
    this.owedPools = new Set();   // addresses whose read by address failed: read again next pass
    this.owedSlot = null;         // the newest slot an owed read asked for: the next read asks for it too
    this.createdOwed = new Map(); // address -> reads: named by a PoolCreated, not in the answer yet
    this.behindReads = 0;         // reads a node answered from behind the slot asked for (-32016), since the start
    this.inflight = null;
  }

  /// Is the list possibly behind the chain? Then `confirm` is refused and market.json's checkedAt stands still.
  get owed() { return this.pools === null || this.changesUnknown || this.owedPools.size > 0; }

  /// A list read elsewhere (or by `refresh`) becomes the list: the whole program, as of `atMs`.
  set({ pools, bytes, slot }, atMs = this.now()) {
    this.pools = pools; this.bytes = bytes ?? new Map(); this.slot = slot ?? null;
    this.readAt = atMs; this.validAt = atMs; this.fullAt = atMs;
    this.fullOwed = false; this.changesUnknown = false; this.owedPools.clear(); this.owedSlot = null; this.createdOwed.clear();
    this.fullFailures = 0; this.fullFailedSince = null; this.nextFullAt = atMs + this.fullEveryMs; this.lastError = null;
  }

  /// The feed found no transaction of the pool program since the list was last read: it is still the chain's.
  /// Refused while a read is owed: a list that may be behind the chain is never marked as checked.
  confirm(atMs = this.now()) { if (this.pools && !this.owed && atMs > this.validAt) this.validAt = atMs; }

  /// This watcher sent a transaction that changed pools (a graduate, a buyback, a burn). With the feed off the
  /// next `get` reads again; with the feed on, the feed sees that transaction in its next pass and patches.
  invalidate() { if (!this.feedOwned) { this.validAt = 0; this.readAt = 0; } }

  /// The whole program is owed a read now (the feed walked past a transaction it could not read, or had a gap, so
  /// it does not know which pools changed): the next feed pass reads it, unless a failure's pause still runs; until
  /// it does, the list is not confirmed and no patch moves `validAt`.
  oweFull() { this.changesUnknown = true; if (this.fullFailures === 0) this.nextFullAt = Math.min(this.nextFullAt, this.now()); }

  /// Is the reconciliation read of the whole program due? Never inside the pause after a failed one.
  fullDue(nowMs = this.now()) { return nowMs >= this.nextFullAt; }

  /// Does the pause after a failed read of the whole program still run?
  inPause(nowMs = this.now()) { return this.fullFailures > 0 && nowMs < this.nextFullAt; }

  /// How long the reads of the whole program have been failing, in milliseconds (0 when the last one worked).
  fullFailingFor(nowMs = this.now()) { return this.fullFailedSince === null ? 0 : nowMs - this.fullFailedSince; }

  /// How old the list is, in milliseconds, counted from the last time it was known to be the chain's.
  age(nowMs = this.now()) { return this.pools ? nowMs - this.validAt : Infinity; }

  /// The list. With the feed on: as it stands, whatever its age (the feed keeps it; `age()` says how old it is);
  /// before its first good read, inside the pause after a failed one, the last error again and no call. With the
  /// feed off: read again when it is older than `maxAgeMs` or when a read is owed (a read failed since the list was
  /// last the chain's). Loops that ask at the same moment share one read.
  async get(maxAgeMs) {
    if (this.feedOwned) {
      if (this.pools) return this.pools;
      // the same words every time (an alert of the loops is not repeated within its cooldown)
      if (this.inPause()) throw new Error(`the pools could not be read yet: ${this.lastError ?? "the read failed"}`);
      return this.refresh();
    }
    if (this.pools && !this.owed && !this.fullOwed && this.age() <= maxAgeMs) return this.pools;
    return this.refresh();
  }

  /// The whole program, one getProgramAccounts. A failure leaves the list owed a read and puts the next try off
  /// (30 s, then 60, ..., 15 minutes at most); the error is thrown to the caller. `minSlot`: the answer must be at
  /// least as new (the feed passes the newest slot it walked).
  async refresh({ minSlot = null } = {}) {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const at = this.now();
        const want = maxSlot(minSlot, this.owedSlot);
        let got;
        try { got = await this.read(want !== null ? { minContextSlot: want } : {}); } catch (e) { if (isBehind(e)) this.behindReads += 1; this.failedFull(e, at); throw e; }
        this.reads += 1;
        this.set(got, at);
        return this.pools;
      } finally { this.inflight = null; }
    })();
    return this.inflight;
  }

  failedFull(e, atMs) {
    this.fullOwed = true;
    this.fullFailures += 1;
    if (this.fullFailedSince === null) this.fullFailedSince = atMs;
    this.lastError = e && e.message ? e.message : String(e);
    this.nextFullAt = atMs + Math.min(FULL_READ_RETRY_MS * 2 ** (this.fullFailures - 1), FULL_READ_RETRY_MAX_MS);
  }

  /// The given pools again, by address (PublicKey or base58), in one getMultipleAccountsInfo per hundred; the
  /// list is patched with them: a pool that changed is replaced, a new one is added, an address that holds no
  /// pool is dropped, except one a PoolCreated event named (`created`), which is owed for CREATED_OWED_READS reads.
  /// `minSlot`: the newest slot the feed walked; the read asks the node for at least that state (minContextSlot),
  /// and a node behind it (-32016) leaves every one of them owed, like any failure. After a good read the list is
  /// the chain's as of this read, provided every transaction of the pool program since the last read was walked
  /// (the feed's rule): `validAt` moves only when nothing is owed then. With no list yet, nothing is patched: the
  /// addresses are owed until the whole program is read.
  async refreshSome(addresses, { minSlot = null, created = [] } = {}) {
    const want = new Map();
    for (const a of addresses) { const k = typeof a === "string" ? a : a.toBase58(); if (!want.has(k)) want.set(k, typeof a === "string" ? null : a); }
    for (const k of this.owedPools) if (!want.has(k)) want.set(k, null);
    const born = new Set([...(created ?? [])].map((a) => (typeof a === "string" ? a : a.toBase58())));
    for (const k of born) if (!this.createdOwed.has(k)) this.createdOwed.set(k, 0);
    if (!want.size) return { read: 0, changed: 0, added: 0, dropped: 0, owed: 0 };
    const slotWanted = maxSlot(minSlot, this.owedSlot);
    if (this.pools === null) {
      for (const k of want.keys()) this.owedPools.add(k);
      this.owedSlot = slotWanted;
      return { read: 0, changed: 0, added: 0, dropped: 0, owed: want.size };
    }
    const keys = [...want.entries()].map(([k, pk]) => pk ?? new PublicKey(k));
    const at = this.now();
    let got;
    try { got = await this.readSome(keys, slotWanted !== null ? { minContextSlot: slotWanted } : {}); } catch (e) {
      if (isBehind(e)) this.behindReads += 1;
      this.lastError = e && e.message ? e.message : String(e);
      for (const k of want.keys()) this.owedPools.add(k);
      this.owedSlot = slotWanted;
      throw e;
    }
    this.patches += 1;
    const list = new Map((this.pools ?? []).map((p) => [p.address.toBase58(), p]));
    const stillOwed = [];
    let changed = 0; let added = 0; let dropped = 0;
    for (const [k, pool] of got.pools) {
      if (pool === null) {
        // a pool the walk saw created, missing from the answer: owed (a node that does not have it yet), a few reads
        if (this.createdOwed.has(k)) {
          const n = this.createdOwed.get(k) + 1;
          if (n < CREATED_OWED_READS) { this.createdOwed.set(k, n); stillOwed.push(k); continue; }
          this.createdOwed.delete(k);
        }
        if (list.delete(k)) dropped += 1; this.bytes.delete(k); continue;
      }
      this.createdOwed.delete(k);
      if (list.has(k)) changed += 1; else added += 1;
      list.set(k, pool);
      this.bytes.set(k, got.bytes.get(k));
    }
    this.pools = [...list.values()].sort((x, y) => (x.address.toBase58() < y.address.toBase58() ? -1 : 1));
    if (got.slot !== null && got.slot !== undefined && (this.slot === null || got.slot > this.slot)) this.slot = got.slot;
    this.owedPools.clear();
    for (const k of stillOwed) this.owedPools.add(k);
    this.owedSlot = stillOwed.length ? slotWanted : null;
    this.readAt = at;
    if (!this.owed) this.validAt = at;
    return { read: want.size, changed, added, dropped, owed: stillOwed.length };
  }
}

/// The newer of two slots (either may be null).
function maxSlot(a, b) {
  const x = a === null || a === undefined ? null : Number(a);
  const y = b === null || b === undefined ? null : Number(b);
  if (x === null) return y;
  if (y === null) return x;
  return Math.max(x, y);
}

/// A node behind the slot asked for (JSON-RPC -32016, or the same answer refused here).
function isBehind(e) { return !!e && (e.code === -32016 || /minimum context slot/i.test(String(e.message ?? e))); }
