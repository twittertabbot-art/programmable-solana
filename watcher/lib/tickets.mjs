// The ticket index: which tickets of the collectible program exist, so that no crank reads the whole program.
//
// A ticket is the account `["ticket", pool, wallet]` of the collectible hook: it holds a wallet's pieces on one
// pool, waiting and minted. The reveal crank, the settle crank, the upkeep crank, the mint crank's sweep and the
// pool pass all need the tickets, and each used to read every account of the program with one
// getProgramAccounts a pass. A shared RPC node aborts that call under load ("scan aborted"), several times a day.
// Here the tickets are known by ADDRESS, in state/tickets.json, and read with getMultipleAccountsInfo, a hundred
// an answer:
//
//   (a) every buy that earns pieces is a transaction of the pool program, which the trades feed reads anyway: its
//       PiecesEarned event (pool, wallet) names the ticket; so does a PiecesTransferred that moved pieces to a
//       wallet (a pegged coin's transfer inside a trade);
//   (b) the mint crank's own look at the collectible program's transactions sees PiecesEarned, DepositUsed,
//       PiecesTransferred and PieceSent too;
//   (c) a reconciliation: one getProgramAccounts of the program filtered to tickets, with dataSlice length 0
//       (addresses only, a small answer), when the index is empty at the start and then every
//       TICKET_RECONCILE_SECONDS; a failure is tried again after a growing pause (1, 2, 4, ... minutes, an hour at
//       most) and three failures in a row raise one alert.
//
// A ticket read with nothing waiting and nothing owned for EMPTY_PASSES_TO_DROP reads in a row leaves the index
// and is remembered as empty (`emptied`, with its pool) for EMPTIED_KEEP_MS: the listing does not take it back in
// that time, so that an hourly listing does not add every ticket ever opened again for three reads each. An event
// that names it puts it back at once. An address that holds no account leaves at once, unless an event named it
// in the last NAMED_GRACE_MS: an RPC node a few slots behind the buy answers no account for a ticket the buy has
// just made. Such a ticket is read again for up to EMPTY_PASSES_TO_DROP reads (`awaiting`) and joins the index
// again when it shows up; one whose event slot the answer had not reached yet keeps its place with no strike.
//
// The wallets the feed saw trade or earn pieces in the last HOT_MS are "hot": the settle crank reads their tickets
// every pass and the rest in a sweep every few minutes (index.mjs).
//
// A read in flight is shared: a loop that asks while one runs gets that read's answer, so two reads never run over
// the same keys at once and an empty read counts once. A finished read is answered again to a loop that asks within
// its `maxAgeMs`. tickets.json is written at most once every SAVE_EVERY_MS, and at the stop (`save({ force })`).
//
// The top half is pure and tested offline. The class reads the chain and writes the file.
import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { PROGRAMS, ACCOUNT_DISC, collectible } from "../../sdk/dist/index.js";
import { getMany } from "./chain.mjs";
import { bs58 } from "./pools.mjs";
import { writeJsonAtomic } from "./feed.mjs";

export const TICKETS_VERSION = 1;
/// A ticket with nothing waiting and nothing owned this many reads in a row leaves the index.
export const EMPTY_PASSES_TO_DROP = 3;
/// After a failed reconciliation the next one waits this long, doubled with every failure, up to the cap.
export const RECONCILE_RETRY_MS = 60_000;
export const RECONCILE_RETRY_MAX_MS = 3_600_000;
/// Failed reconciliations in a row that raise one alert.
export const RECONCILE_ALERT_FAILURES = 3;
/// A ticket an event named this recently is not dropped on an answer that holds no account for it.
export const NAMED_GRACE_MS = 600_000;
/// A ticket that left the index empty is not taken back from the listing for this long, unless an event names it.
/// After it, the listing takes it back once (three reads) and it leaves again if it is still empty: the bound on a
/// ticket that gained pieces in a way no event the watcher read said.
export const EMPTIED_KEEP_MS = 21_600_000;
/// tickets.json is written at most this often (and at the stop).
export const SAVE_EVERY_MS = 60_000;
/// A wallet the feed saw trade or earn pieces stays hot this long: the settle crank reads its ticket every pass.
export const HOT_MS = 300_000;
export const POOL_NAME = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const b58 = (k) => (typeof k === "string" ? k : k.toBase58());
const errMsg = (e) => (e && e.message ? e.message : String(e));
const toBig = (v) => { try { return v === null || v === undefined ? null : BigInt(v); } catch { return null; } };

export function emptyTicketIndex() {
  return { version: TICKETS_VERSION, tickets: {}, emptied: {}, reconciledAt: null, reconcileFailures: 0, reconcileFailedSince: null };
}

/// The index from its file. Anything unreadable starts it empty (the reconciliation rebuilds it).
export function loadTicketIndex(file) {
  try {
    if (!file || !fs.existsSync(file)) return emptyTicketIndex();
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    const e = emptyTicketIndex();
    if (!p || typeof p !== "object" || p.version !== TICKETS_VERSION) return e;
    if (p.tickets && typeof p.tickets === "object" && !Array.isArray(p.tickets)) {
      for (const [k, v] of Object.entries(p.tickets)) {
        if (!POOL_NAME.test(k) || !v || typeof v !== "object") continue;
        e.tickets[k] = {
          pool: typeof v.pool === "string" && POOL_NAME.test(v.pool) ? v.pool : null,
          user: typeof v.user === "string" && POOL_NAME.test(v.user) ? v.user : null,
          lastSeen: typeof v.lastSeen === "string" ? v.lastSeen : null,
          empty: Number.isInteger(v.empty) && v.empty >= 0 ? v.empty : 0,
        };
      }
    }
    // the tickets that left empty: { ticket: [pool, unix ms] }
    if (p.emptied && typeof p.emptied === "object" && !Array.isArray(p.emptied)) {
      for (const [k, v] of Object.entries(p.emptied)) {
        if (!POOL_NAME.test(k) || !Array.isArray(v) || !Number.isFinite(v[1])) continue;
        e.emptied[k] = [typeof v[0] === "string" && POOL_NAME.test(v[0]) ? v[0] : null, v[1]];
      }
    }
    e.reconciledAt = typeof p.reconciledAt === "string" ? p.reconciledAt : null;
    e.reconcileFailures = Number.isInteger(p.reconcileFailures) ? p.reconcileFailures : 0;
    e.reconcileFailedSince = typeof p.reconcileFailedSince === "string" ? p.reconcileFailedSince : null;
    return e;
  } catch {
    return emptyTicketIndex();
  }
}

/// The pause before the next reconciliation after `failures` failed ones in a row.
export function reconcileBackoffMs(failures) {
  return Math.min(RECONCILE_RETRY_MS * 2 ** Math.max(0, failures - 1), RECONCILE_RETRY_MAX_MS);
}

export class TicketIndex {
  /// `file`: state/tickets.json (null: memory only). `reconcileEveryMs`: how often the whole program is listed.
  constructor({ file = null, log = null, now = () => Date.now(), reconcileEveryMs = 3_600_000, program = null, saveEveryMs = SAVE_EVERY_MS } = {}) {
    Object.assign(this, { file, log, now, reconcileEveryMs, saveEveryMs });
    this.program = program ?? PROGRAMS.hook_collectible;
    this.state = loadTicketIndex(file);
    this.nextReconcileAt = this.state.reconciledAt ? Date.parse(this.state.reconciledAt) + reconcileEveryMs : 0;
    if (this.state.reconcileFailures > 0) this.nextReconcileAt = Math.min(this.nextReconcileAt, now() + reconcileBackoffMs(this.state.reconcileFailures));
    this.dirty = false;
    this.lastRead = null;      // { at, result }: the last read of every ticket
    this.inflight = null;      // the read of every ticket that runs now: { promise, startedAt }
    this.lastSavedAt = 0;
    this.alerted = false;
    this.named = new Map();    // ticket -> { at, slot }: an event named it at `at` (ms), in the transaction of `slot`
    this.awaiting = new Map(); // ticket -> { pool, user, at, misses }: named lately, no account in the last answer
    this.hot = new Map();      // ticket -> until (ms): its wallet traded or earned pieces lately
  }

  size() { return Object.keys(this.state.tickets).length; }
  has(address) { return !!this.state.tickets[b58(address)]; }
  addresses() { return Object.keys(this.state.tickets).map((k) => new PublicKey(k)); }

  /// The ticket of a wallet on a pool joins the index (an event named it: a buy, a mint, a move). Answers true
  /// when it was not there. `slot`: the slot of the event's transaction, when known. The wallet is hot too.
  add(pool, user, nowIso = new Date(this.now()).toISOString(), { slot = null, hot = true } = {}) {
    const address = collectible.collectiblePda.ticket(new PublicKey(b58(pool)), new PublicKey(b58(user))).toBase58();
    const atMs = Number.isFinite(Date.parse(nowIso)) ? Date.parse(nowIso) : this.now();
    const was = this.named.get(address);
    const s = toBig(slot);
    this.named.set(address, { at: atMs, slot: was && was.slot !== null && (s === null || was.slot > s) ? was.slot : s });
    if (hot) this.hot.set(address, atMs + HOT_MS);
    if (this.state.emptied[address]) { delete this.state.emptied[address]; this.dirty = true; }
    this.awaiting.delete(address);
    const e = this.state.tickets[address];
    if (e) { e.pool = e.pool ?? b58(pool); e.user = e.user ?? b58(user); e.lastSeen = nowIso; if (e.empty !== 0) { e.empty = 0; this.dirty = true; } return false; }
    this.state.tickets[address] = { pool: b58(pool), user: b58(user), lastSeen: nowIso, empty: 0 };
    this.dirty = true;
    return true;
  }

  /// An address the reconciliation listed: its pool and wallet are filled in by the first read. A ticket that left
  /// the index empty less than EMPTIED_KEEP_MS ago is not taken back (answers false, `skipped`).
  addAddress(address, nowMs = this.now()) {
    const k = b58(address);
    if (this.state.tickets[k]) return false;
    const gone = this.state.emptied[k];
    if (gone && nowMs - gone[1] < EMPTIED_KEEP_MS) return false;
    if (gone) delete this.state.emptied[k];
    const w = this.awaiting.get(k);
    this.awaiting.delete(k);
    this.state.tickets[k] = { pool: w ? w.pool : null, user: w ? w.user : null, lastSeen: null, empty: 0 };
    this.dirty = true;
    return true;
  }

  /// The PiecesEarned and DepositUsed events of a transaction's logs (lib/events.mjs decoders) name tickets, and so
  /// do the receivers of moved pieces ({ pool, user }). `slot` on an event, when it has one, is its transaction's.
  addFromEvents(events, nowIso) {
    let added = 0;
    for (const ev of events ?? []) if (ev && ev.pool && ev.user && this.add(ev.pool, ev.user, nowIso, { slot: ev.slot ?? null })) added += 1;
    return added;
  }

  /// A wallet that traded on a pool: hot for HOT_MS (its ticket, if the index holds one, is settled within a pass).
  markHot(pool, user, nowMs = this.now()) {
    let address;
    try { address = collectible.collectiblePda.ticket(new PublicKey(b58(pool)), new PublicKey(b58(user))).toBase58(); } catch { return false; }
    this.hot.set(address, nowMs + HOT_MS);
    return true;
  }

  /// The hot tickets the index holds (or awaits), as base58. Expired ones are forgotten.
  hotAddresses(nowMs = this.now()) {
    const out = [];
    for (const [k, until] of this.hot) {
      if (until <= nowMs) { this.hot.delete(k); continue; }
      if (this.state.tickets[k] || this.awaiting.has(k)) out.push(k);
    }
    return out;
  }

  /// Is the reconciliation due?
  reconcileDue(nowMs = this.now()) { return nowMs >= this.nextReconcileAt; }

  /// One getProgramAccounts of the program, tickets only, addresses only (dataSlice length 0): every address
  /// joins the index, except the ones that left it empty lately (`skipped`). On failure the next try is put off
  /// with a growing pause and the error is thrown.
  async reconcile(connection, nowMs = this.now()) {
    let accs;
    try {
      accs = await connection.getProgramAccounts(this.program, { filters: [{ memcmp: { offset: 0, bytes: bs58(ACCOUNT_DISC.Ticket) } }], dataSlice: { offset: 0, length: 0 } });
    } catch (e) {
      this.state.reconcileFailures += 1;
      if (this.state.reconcileFailedSince === null) this.state.reconcileFailedSince = new Date(nowMs).toISOString();
      this.nextReconcileAt = nowMs + reconcileBackoffMs(this.state.reconcileFailures);
      this.dirty = true;
      this.save({ force: true });
      throw e;
    }
    const list = Array.isArray(accs) ? accs : accs.value ?? [];
    // a memory older than EMPTIED_KEEP_MS is let go: the listing takes that ticket back once
    for (const [k, v] of Object.entries(this.state.emptied)) if (nowMs - v[1] >= EMPTIED_KEEP_MS) { delete this.state.emptied[k]; this.dirty = true; }
    let added = 0; let skipped = 0;
    for (const a of list) {
      const k = b58(a.pubkey);
      if (this.addAddress(k, nowMs)) added += 1;
      else if (!this.state.tickets[k]) skipped += 1;
    }
    this.state.reconciledAt = new Date(nowMs).toISOString();
    const recovered = this.state.reconcileFailures;
    this.state.reconcileFailures = 0; this.state.reconcileFailedSince = null; this.alerted = false;
    this.nextReconcileAt = nowMs + this.reconcileEveryMs;
    this.dirty = true;
    this.save({ force: true });
    return { listed: list.length, added, skipped, total: this.size(), recovered };
  }

  /// Every indexed ticket, read by address: one getMultipleAccountsInfo per hundred, with the slot of the read.
  /// Answers { items: [{ address, ticket, info }], tickets, slot, dropped, at }. `dropped` counts the tickets that
  /// left the index in this read (no account, or empty for EMPTY_PASSES_TO_DROP reads). A read in flight is shared
  /// with every caller meanwhile; `maxAgeMs`: a finished read younger than this is answered again instead of a new
  /// call; `fresh`: the answer comes from a read that began after this call (one in flight is waited for first).
  /// `only`: these tickets alone (base58), read now and never shared (the settle crank's hot wallets).
  async read(connection, { maxAgeMs = 0, fresh = false, only = null } = {}) {
    if (only) return this.readKeys(connection, only);
    const nowMs = this.now();
    if (!fresh && maxAgeMs > 0 && this.lastRead && nowMs - this.lastRead.at <= maxAgeMs) return this.lastRead.result;
    if (this.inflight) {
      if (!fresh) return this.inflight.promise;
      try { await this.inflight.promise; } catch { /* its callers have the error; this one reads again */ }
      // a read that began while this call waited began after it: its answer is fresh enough
      if (this.inflight) return this.inflight.promise;
    }
    const promise = (async () => {
      try { return await this.readKeys(connection, null); } finally { if (this.inflight && this.inflight.promise === promise) this.inflight = null; }
    })();
    this.inflight = { promise, startedAt: nowMs };
    return promise;
  }

  /// One read of the given tickets (null: every indexed and awaited ticket). The keys are taken before the call
  /// and each one's entry is looked up again after it: one that left the index meanwhile is skipped.
  async readKeys(connection, subset) {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const want = subset ? new Set(subset.map(b58)) : null;
    const keys = [];
    for (const k of Object.keys(this.state.tickets)) if (!want || want.has(k)) keys.push(k);
    for (const k of this.awaiting.keys()) if (!this.state.tickets[k] && (!want || want.has(k))) keys.push(k);
    const items = [];
    let dropped = 0;
    let slot = null;
    if (keys.length) {
      const got = await getMany(connection, keys.map((k) => new PublicKey(k)));
      slot = got.slot;
      keys.forEach((k, i) => {
        const info = got.infos[i];
        const chunkSlot = got.slots && got.slots.length ? got.slots[Math.floor(i / 100)] : got.slot;
        const e = this.state.tickets[k];
        const w = e ? null : this.awaiting.get(k);
        if (!e && !w) return;   // it left the index while this read was out
        if (!info || !info.data || !info.data.length) {
          if (w) {
            w.misses += 1;
            if (w.misses >= EMPTY_PASSES_TO_DROP || nowMs - w.at > NAMED_GRACE_MS) this.awaiting.delete(k);
            return;
          }
          const n = this.named.get(k);
          const recent = !!n && nowMs - n.at <= NAMED_GRACE_MS;
          // the node that answered had not reached the slot of the event that named it: read again, no strike
          if (recent && n.slot !== null && chunkSlot !== null && chunkSlot !== undefined && BigInt(chunkSlot) < n.slot) return;
          delete this.state.tickets[k]; dropped += 1; this.dirty = true;
          if (recent) this.awaiting.set(k, { pool: e.pool, user: e.user, at: n.at, misses: 1 });
          return;
        }
        let ticket;
        try { ticket = collectible.decodeTicket(new Uint8Array(info.data)); } catch {
          if (e) { delete this.state.tickets[k]; dropped += 1; this.dirty = true; }
          this.awaiting.delete(k);
          return;
        }
        let entry = e;
        if (!entry) {
          // an awaited ticket shows up: back in the index
          this.awaiting.delete(k);
          entry = { pool: w.pool, user: w.user, lastSeen: nowIso, empty: 0 };
          this.state.tickets[k] = entry; this.dirty = true;
        }
        if (entry.pool === null || entry.user === null) { entry.pool = ticket.pool.toBase58(); entry.user = ticket.user.toBase58(); this.dirty = true; }
        if (ticket.pending === 0 && ticket.owned.length === 0) {
          entry.empty += 1; this.dirty = true;
          if (entry.empty >= EMPTY_PASSES_TO_DROP) {
            delete this.state.tickets[k]; dropped += 1;
            this.state.emptied[k] = [entry.pool, nowMs];
            return;
          }
        } else if (entry.empty !== 0) { entry.empty = 0; this.dirty = true; }
        entry.lastSeen = nowIso;
        items.push({ address: new PublicKey(k), ticket, info });
      });
    }
    // the memory of named tickets keeps NAMED_GRACE_MS only
    for (const [k, n] of this.named) if (nowMs - n.at > NAMED_GRACE_MS) this.named.delete(k);
    const result = { items, tickets: items.map((x) => x.ticket), slot, dropped, at: nowIso };
    if (!subset) this.lastRead = { at: nowMs, result };
    this.save();
    return result;
  }

  /// What /health says about the index.
  status() {
    return { size: this.size(), reconciledAt: this.state.reconciledAt, reconcileFailures: this.state.reconcileFailures, reconcileFailedSince: this.state.reconcileFailedSince, nextReconcileAt: this.nextReconcileAt ? new Date(this.nextReconcileAt).toISOString() : null, emptied: Object.keys(this.state.emptied).length, awaiting: this.awaiting.size, hot: this.hot.size };
  }

  /// Write the file when something in it changed, at most once every `saveEveryMs` (`force`: now, at the stop).
  save({ force = false } = {}) {
    if (!this.dirty || !this.file) { if (!this.file) this.dirty = false; return false; }
    const nowMs = this.now();
    if (!force && this.lastSavedAt && nowMs - this.lastSavedAt < this.saveEveryMs) return false;
    try { writeJsonAtomic(this.file, JSON.stringify(this.state)); this.lastSavedAt = nowMs; this.dirty = false; return true; } catch (e) {
      if (this.log) this.log.warn(`tickets: the index could not be saved: ${errMsg(e)}`);
      this.lastSavedAt = nowMs;
      return false;
    }
  }
}
