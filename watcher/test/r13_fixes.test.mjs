// Round 13: the fixes after the round 12 review. POST /notify asks for the status first and never sweeps, the
// ticket index under lagging nodes and over time (shared reads, the grace of a ticket an event named, the memory of
// tickets read empty, the hot wallets, the file written at most once a minute), the pools read at the slot the feed
// walked, the feed's lock across reboots and reused process ids, the address behind the proxy, and the settings.
// None of them touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAMS, EVENT_DISC, collectible, decodePool } from "../../sdk/dist/index.js";
import { PoolCache, readPoolsAt, CREATED_OWED_READS } from "../lib/pools.mjs";
import { TicketIndex, loadTicketIndex, EMPTY_PASSES_TO_DROP, EMPTIED_KEEP_MS, NAMED_GRACE_MS, SAVE_EVERY_MS, HOT_MS } from "../lib/tickets.mjs";
import { transferredFromLogs, sentFromLogs, receivedFromLogs } from "../lib/events.mjs";
import { touchedByTransactions, acquireFeedLock, feedLockFile, lockHolderRuns, TradesFeed } from "../lib/feed.mjs";
import { MintCrank, MINT_NOTIFY_READS, MINT_NOTIFY_QUEUE_MAX, MINT_NOTIFY_CHECKS } from "../lib/mint.mjs";
import { healthBody, clientIp, proxyHop, NotifyLimiter, NOTIFY_PER_MINUTE, NOTIFY_GLOBAL_PER_MINUTE } from "../lib/server.mjs";
import { isMinSlotNotReached, getMany } from "../lib/chain.mjs";
import { buildConfig, parseArgs, describeConfig } from "../lib/config.mjs";
import { ticketBytes, poolBytes, swappedEventBytes, POOL, OWNER, OTHER } from "./bytes.mjs";

const HOOK = PROGRAMS.hook_collectible;
const { STANDARD_RENT } = collectible;
const key = () => Keypair.generate().publicKey;
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "r13-"));
const data = (bytes) => `Program data: ${Buffer.from(bytes).toString("base64")}`;
const invoke = (program, lines) => [`Program ${program.toBase58()} invoke [1]`, ...lines, `Program ${program.toBase58()} success`];
const tx = (signature, { logs = [], keys = [], err = null, slot = 1000 } = {}) => ({
  slot, blockTime: 1_760_000_000, meta: { err, logMessages: logs, innerInstructions: [], loadedAddresses: null },
  transaction: { signatures: [signature], message: { staticAccountKeys: keys } },
});
const earnedBytes = ({ pool = POOL, user = OWNER, pieces = 2, slot = 999n, targetSlot = 1001n } = {}) => {
  const b = Buffer.alloc(92); Buffer.from(EVENT_DISC.PiecesEarned).copy(b, 0); pool.toBuffer().copy(b, 8); user.toBuffer().copy(b, 40);
  b.writeUInt32LE(pieces, 72); b.writeBigUInt64LE(slot, 76); b.writeBigUInt64LE(targetSlot, 84); return b;
};
const transferredBytes = ({ pool = POOL, from = OWNER, to = OTHER, dropped = 0, moved = 1, burned = 0 } = {}) => {
  const b = Buffer.alloc(116); Buffer.from(EVENT_DISC.PiecesTransferred).copy(b, 0); pool.toBuffer().copy(b, 8); from.toBuffer().copy(b, 40); to.toBuffer().copy(b, 72);
  b.writeUInt32LE(dropped, 104); b.writeUInt32LE(moved, 108); b.writeUInt32LE(burned, 112); return b;
};
const sentBytes = ({ pool = POOL, from = OWNER, to = OTHER, asset = OWNER } = {}) => {
  const b = Buffer.alloc(136); Buffer.from(EVENT_DISC.PieceSent).copy(b, 0); pool.toBuffer().copy(b, 8); from.toBuffer().copy(b, 40); to.toBuffer().copy(b, 72); asset.toBuffer().copy(b, 104); return b;
};
const ticketAccount = (o = {}) => { const d = Buffer.from(ticketBytes(o)); return { owner: HOOK, data: d, lamports: Number(STANDARD_RENT(d.length)) }; };
const holding = (pool, user) => ticketAccount({ pool, user, minted: 1, owned: [key()] });
const emptyTicket = (pool, user) => ticketAccount({ pool, user });
const fakeSignature = () => { for (;;) { const s = new PublicKey(Keypair.generate().secretKey.slice(0, 32)).toBase58() + new PublicKey(Keypair.generate().secretKey.slice(0, 32)).toBase58(); if (s.length >= 86) return s; } };

/// Accounts read by address, every call counted, with a slot per answer.
function chainOf() {
  const c = { accounts: new Map(), calls: 0, keys: 0, slot: 500, configs: [], listed: [] };
  c.connection = {
    async getMultipleAccountsInfoAndContext(keys, config) { c.calls += 1; c.keys += keys.length; c.configs.push(config); return { context: { slot: c.slot }, value: keys.map((k) => c.accounts.get(k.toBase58()) ?? null) }; },
    async getProgramAccounts() { return c.listed.map((k) => ({ pubkey: new PublicKey(k), account: { data: Buffer.alloc(0), owner: HOOK, lamports: 1 } })); },
  };
  return c;
}

// ---- POST /notify: the status first, never a sweep ----------------------------------------------------------

function notifyChain() {
  const c = { accounts: new Map(), sigs: [{ signature: "head", slot: 900 }], txs: new Map(), statuses: new Map(), calls: {}, items: 0 };
  const count = (m) => { c.calls[m] = (c.calls[m] ?? 0) + 1; };
  c.connection = {
    async getSignaturesForAddress(addr, opts = {}) { count("getSignaturesForAddress"); let list = c.sigs; if (opts.until) { const i = list.findIndex((s) => s.signature === opts.until); list = i < 0 ? list : list.slice(0, i); } return list.slice(0, opts.limit ?? 1000).map((s) => ({ ...s, err: null })); },
    async getSignatureStatuses(list) { count("getSignatureStatuses"); assert.ok(list.length <= 256, "one status call takes 256 at most"); return { context: { slot: 1000 }, value: list.map((s) => c.statuses.get(s) ?? null) }; },
    async getTransactions(list) { count("getTransactions"); c.items += list.length; return list.map((s) => c.txs.get(s) ?? null); },
    async getTransaction(s) { count("getTransaction"); return c.txs.get(s) ?? null; },
    async getMultipleAccountsInfoAndContext(keys) { count("getMultipleAccountsInfo"); return { context: { slot: 1000 }, value: keys.map((k) => c.accounts.get(k.toBase58()) ?? null) }; },
    async getMultipleAccountsInfo(keys) { count("getMultipleAccountsInfo"); return keys.map((k) => c.accounts.get(k.toBase58()) ?? null); },
    async getProgramAccounts() { count("getProgramAccounts"); throw new Error("not with the index"); },
    async getSlot() { count("getSlot"); return 1000; },
    async getBalance() { count("getBalance"); return 1_000_000_000; },
  };
  return c;
}
const crankOn = (c, idx) => new MintCrank({ connection: c.connection, keeper: Keypair.generate(), buildTx: async () => { throw new Error("nothing is built"); }, rent: STANDARD_RENT, sweepMs: 300_000, now: () => 1_000_000, tickets: idx, log: quiet });

test("notify: signatures the chain does not know cost one status call a look for all of them, no transaction read and no sweep", async () => {
  const c = notifyChain();
  const idx = new TicketIndex({ file: null, log: quiet, now: () => 1_000_000 });
  for (let i = 0; i < 150; i++) { const u = key(); idx.add(POOL, u); c.accounts.set(collectible.collectiblePda.ticket(POOL, u).toBase58(), holding(POOL, u)); }
  const crank = crankOn(c, idx);
  await crank.pass(); await crank.pass();
  c.calls = {}; c.items = 0;
  for (let i = 0; i < 40; i++) assert.equal(crank.notify(fakeSignature()).accepted, true);
  const r = await crank.readNotified();
  assert.deepEqual([r.looked, r.unknown, r.read, r.found, r.left], [40, 40, 0, 0, 0]);
  assert.deepEqual(c.calls, { getSignatureStatuses: 1 }, "one call for the forty, nothing else");
  for (let i = 0; i < 3; i++) await crank.pass();
  assert.equal(c.calls.getMultipleAccountsInfo, undefined, "no sweep of the tickets");
  assert.equal(c.items, 0, "no transaction read");
  assert.equal(crank.notifyTotals.unknown, 40);
});

test("notify: a confirmed buy is read once and its wallet found; a processed one is asked again, then let go; a failed one is dropped; the poll does not read a notified transaction again", async () => {
  const c = notifyChain();
  const idx = new TicketIndex({ file: null, log: quiet, now: () => 1_000_000 });
  const crank = crankOn(c, idx);
  await crank.pass();
  const buyer = key();
  c.txs.set("B".repeat(88), tx("B".repeat(88), { slot: 990, logs: invoke(PROGRAMS.hookpool, [`Program ${HOOK.toBase58()} invoke [2]`, data(earnedBytes({ user: buyer, pieces: 1, slot: 990n, targetSlot: 1500n })), `Program ${HOOK.toBase58()} success`]), keys: [buyer, PROGRAMS.hookpool, HOOK] }));
  c.statuses.set("B".repeat(88), { slot: 990, confirmations: 1, err: null, confirmationStatus: "confirmed" });
  c.statuses.set("P".repeat(88), { slot: 999, confirmations: 0, err: null, confirmationStatus: "processed" });
  c.statuses.set("F".repeat(88), { slot: 991, confirmations: 1, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" });
  for (const s of ["B", "P", "F"]) assert.equal(crank.notify(s.repeat(88)).accepted, true);
  c.calls = {}; c.items = 0;
  let r = await crank.readNotified();
  assert.deepEqual([r.found, r.read, r.failed, r.left], [1, 1, 1, 1]);
  assert.ok(crank.watch.has(`${POOL.toBase58()}:${buyer.toBase58()}`), "the buyer waits for its mint");
  assert.equal(idx.has(collectible.collectiblePda.ticket(POOL, buyer)), true, "and its ticket is in the index");
  assert.deepEqual(c.calls, { getSignatureStatuses: 1, getTransactions: 1 });
  for (let i = 1; i < MINT_NOTIFY_CHECKS; i++) r = await crank.readNotified();
  assert.equal(r.left, 0, "the processed one is let go after its checks");
  assert.equal(crank.handed, 1);
  // the poll lists the buy (it is a transaction of the collectible program too): not read again
  c.sigs = [{ signature: "B".repeat(88), slot: 990 }, ...c.sigs];
  c.items = 0;
  await crank.pass();
  assert.equal(c.items, 0, "a transaction read through /notify is not read again by the poll");
});

test("notify: without a status (the call failed) a signature's transaction is read at most twice; the queue has a cap", async () => {
  const c = notifyChain();
  c.connection.getSignatureStatuses = async () => { throw new Error("fetch failed"); };
  const crank = crankOn(c, null);
  crank.notify("X".repeat(88));
  for (let i = 0; i < 5; i++) await crank.readNotified();
  assert.equal(c.items, MINT_NOTIFY_READS);
  for (let i = 0; i < MINT_NOTIFY_QUEUE_MAX; i++) crank.notify(fakeSignature());
  const over = crank.notify(fakeSignature());
  assert.deepEqual([over.accepted, /busy/.test(over.reason)], [false, true]);
});

// ---- the ticket index ---------------------------------------------------------------------------------------

test("tickets: a read in flight is shared; fresh waits for it and reads again", async () => {
  const c = chainOf();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { async getMultipleAccountsInfoAndContext(keys, config) { await gate; return c.connection.getMultipleAccountsInfoAndContext(keys, config); } };
  const idx = new TicketIndex({ file: null, log: quiet, now: () => 1_000_000 });
  const u = key(); idx.add(POOL, u); c.accounts.set(collectible.collectiblePda.ticket(POOL, u).toBase58(), holding(POOL, u));
  const a = idx.read(slow); const b = idx.read(slow); const f = idx.read(slow, { fresh: true });
  release();
  const [ra, rb, rf] = await Promise.all([a, b, f]);
  assert.equal(ra, rb, "the same answer");
  assert.notEqual(rf, ra, "the fresh one read again");
  assert.equal(c.calls, 2);
});

test("tickets: a ticket an event named is kept while the node is behind its slot, awaited for a few reads, and back when it shows up; a listed address with no account leaves", async () => {
  const c = chainOf();
  let now = 1_000_000;
  const idx = new TicketIndex({ file: null, log: quiet, now: () => now });
  const u = key(); const t = collectible.collectiblePda.ticket(POOL, u).toBase58();
  idx.add(POOL, u, new Date(now).toISOString(), { slot: 600n });
  c.slot = 590;   // the node answers from before the buy
  let r = await idx.read(c.connection);
  assert.deepEqual([r.dropped, idx.has(t)], [0, true], "behind the buy's slot: no strike");
  c.slot = 610;   // past it, and still nothing: awaited
  r = await idx.read(c.connection);
  assert.deepEqual([r.dropped, idx.has(t), idx.awaiting.has(t)], [1, false, true]);
  c.accounts.set(t, holding(POOL, u));
  r = await idx.read(c.connection);
  assert.deepEqual([r.tickets.length, idx.has(t), idx.awaiting.has(t)], [1, true, false], "it shows up: back in the index");
  // an event long ago, or never: no grace
  const v = key(); const tv = collectible.collectiblePda.ticket(POOL, v).toBase58();
  idx.add(POOL, v);
  now += NAMED_GRACE_MS + 1;
  r = await idx.read(c.connection);
  assert.deepEqual([idx.has(tv), idx.awaiting.has(tv)], [false, false]);
  // awaited for EMPTY_PASSES_TO_DROP reads at most
  const w = key(); const tw = collectible.collectiblePda.ticket(POOL, w).toBase58();
  idx.add(POOL, w);
  for (let i = 0; i < EMPTY_PASSES_TO_DROP; i++) await idx.read(c.connection);
  assert.deepEqual([idx.has(tw), idx.awaiting.has(tw)], [false, false]);
});

test("tickets: a ticket read empty leaves and the listing does not take it back for EMPTIED_KEEP_MS; an event puts it back at once; the memory survives a restart", async () => {
  const c = chainOf();
  const dir = tmpDir(); const file = path.join(dir, "tickets.json");
  let now = 5_000_000;
  const idx = new TicketIndex({ file, log: quiet, now: () => now });
  const u = key(); const t = collectible.collectiblePda.ticket(POOL, u).toBase58();
  c.accounts.set(t, emptyTicket(POOL, u));
  c.listed = [t];
  let rc = await idx.reconcile(c.connection, now);
  assert.equal(rc.added, 1);
  for (let i = 0; i < EMPTY_PASSES_TO_DROP; i++) { now += 10_000; await idx.read(c.connection); }
  assert.equal(idx.has(t), false);
  assert.equal(idx.status().emptied, 1);
  now += 3_600_000;
  rc = await idx.reconcile(c.connection, now);
  assert.deepEqual([rc.added, rc.skipped, idx.has(t)], [0, 1, false], "the hourly listing leaves it out");
  idx.save({ force: true });
  const again = new TicketIndex({ file, log: quiet, now: () => now });
  assert.equal(Object.keys(again.state.emptied).length, 1, "the memory is in the file");
  rc = await again.reconcile(c.connection, now);
  assert.equal(rc.skipped, 1);
  // after EMPTIED_KEEP_MS the listing takes it back once
  now += EMPTIED_KEEP_MS;
  rc = await again.reconcile(c.connection, now);
  assert.deepEqual([rc.added, again.has(t)], [1, true]);
  // a buy names it: back at once, the memory gone
  for (let i = 0; i < EMPTY_PASSES_TO_DROP; i++) { now += 10_000; await again.read(c.connection); }
  assert.equal(again.has(t), false);
  again.add(POOL, u);
  assert.deepEqual([again.has(t), Object.keys(again.state.emptied).length], [true, 0]);
  assert.deepEqual(Object.keys(loadTicketIndex(path.join(dir, "missing.json")).emptied), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tickets: the hot wallets are read alone (`only`), expire after HOT_MS, and an index of many costs one call for a few", async () => {
  const c = chainOf();
  let now = 1_000_000;
  const idx = new TicketIndex({ file: null, log: quiet, now: () => now });
  for (let i = 0; i < 350; i++) { const u = key(); idx.addAddress(collectible.collectiblePda.ticket(POOL, u)); c.accounts.set(collectible.collectiblePda.ticket(POOL, u).toBase58(), holding(POOL, u)); }
  const trader = key(); const tt = collectible.collectiblePda.ticket(POOL, trader).toBase58();
  idx.add(POOL, trader, new Date(now).toISOString(), { hot: false });
  c.accounts.set(tt, holding(POOL, trader));
  assert.deepEqual(idx.hotAddresses(now), [], "an added ticket is not hot when told so");
  idx.markHot(POOL, trader, now);
  idx.markHot(POOL, key(), now);   // a wallet without a ticket in the index: nothing to read
  const hot = idx.hotAddresses(now);
  assert.deepEqual(hot, [tt]);
  c.calls = 0; c.keys = 0;
  const r = await idx.read(c.connection, { only: hot });
  assert.deepEqual([c.calls, c.keys, r.tickets.length], [1, 1, 1]);
  assert.equal(idx.lastRead, null, "a read of a few is never served to a loop that wants all");
  now += HOT_MS + 1;
  assert.deepEqual(idx.hotAddresses(now), []);
});

test("tickets: the file is written at most once every SAVE_EVERY_MS, and at once when forced", async () => {
  const dir = tmpDir(); const file = path.join(dir, "tickets.json");
  let now = 1_000_000;
  const idx = new TicketIndex({ file, log: quiet, now: () => now });
  idx.add(POOL, key());
  assert.equal(idx.save(), true);
  idx.add(POOL, key());
  now += 1000;
  assert.equal(idx.save(), false, "a second write within the minute waits");
  assert.equal(Object.keys(loadTicketIndex(file).tickets).length, 1);
  now += SAVE_EVERY_MS;
  assert.equal(idx.save(), true);
  assert.equal(Object.keys(loadTicketIndex(file).tickets).length, 2);
  idx.add(POOL, key());
  assert.equal(idx.save({ force: true }), true);
  assert.equal(Object.keys(loadTicketIndex(file).tickets).length, 3);
  assert.equal(idx.save({ force: true }), false, "nothing changed: nothing written");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the pools, read at the slot the feed walked ------------------------------------------------------------

test("pools: a patch asks for the newest walked slot; a node behind it (-32016) leaves the pools owed with that slot; a pool born in the walk is owed, not dropped, for a few reads", async () => {
  const A = key(); const B = key();
  const bytesA = new Uint8Array(poolBytes({ reserveQuote: 7n }));
  const asked = [];
  let behind = true; let haveB = false;
  const readSome = async (addresses, opts) => {
    asked.push(opts.minContextSlot ?? null);
    if (behind) throw Object.assign(new Error("failed to get info for accounts: Minimum context slot has not been reached"), { code: -32016 });
    const pools = new Map(); const bytes = new Map();
    for (const a of addresses) { const k = a.toBase58(); if (k === A.toBase58() || (k === B.toBase58() && haveB)) { pools.set(k, decodePool(a, bytesA)); bytes.set(k, bytesA); } else pools.set(k, null); }
    return { pools, bytes, slot: 700 };
  };
  let now = 1_000_000;
  const cache = new PoolCache({ read: async () => ({ pools: [decodePool(A, bytesA)], bytes: new Map([[A.toBase58(), bytesA]]), slot: 1 }), readSome, now: () => now, feedOwned: true });
  await cache.refresh();
  const checked = cache.validAt;
  now += 10_000;
  await assert.rejects(() => cache.refreshSome([A], { minSlot: 650 }), (e) => isMinSlotNotReached(e));
  assert.deepEqual([cache.owed, cache.owedSlot, cache.behindReads, cache.validAt], [true, 650, 1, checked]);
  behind = false;
  now += 10_000;
  const r = await cache.refreshSome([B], { minSlot: 640, created: [B] });
  assert.deepEqual(asked, [650, 650], "the owed slot is asked for again, the newer of the two");
  assert.deepEqual([r.changed, r.added, r.dropped, r.owed], [1, 0, 0, 1], "B is not there yet: owed, not dropped");
  assert.equal(cache.owed, true); assert.equal(cache.validAt, checked, "not checked while B is owed");
  for (let i = 2; i < CREATED_OWED_READS; i++) await cache.refreshSome([]);
  haveB = true;
  const r2 = await cache.refreshSome([]);
  assert.deepEqual([r2.added, cache.owed, cache.pools.length], [1, false, 2], "B came: added, nothing owed");
  assert.equal(cache.validAt, now);
  // a pool born in a walk that never shows up stops being owed after its reads
  const C = key(); haveB = true;
  await cache.refreshSome([C], { created: [C] });
  for (let i = 1; i < CREATED_OWED_READS; i++) await cache.refreshSome([]);
  assert.deepEqual([cache.owed, cache.owedPools.size], [false, 0]);
});

test("pools: with no list yet a patch reads nothing and owes its pools; readPoolsAt sends minContextSlot and refuses an older answer", async () => {
  const A = key();
  const cache = new PoolCache({ read: async () => { throw new Error("scan aborted"); }, readSome: async () => { throw new Error("must not be called"); }, now: () => 1, feedOwned: true });
  const r = await cache.refreshSome([A], { minSlot: 9 });
  assert.deepEqual([r.read, r.owed, cache.pools, cache.owedPools.has(A.toBase58())], [0, 1, null, true]);
  const c = chainOf();
  c.slot = 100;
  await readPoolsAt(c.connection, [A], { minContextSlot: 90 });
  assert.deepEqual(c.configs[0], { minContextSlot: 90 });
  await assert.rejects(() => readPoolsAt(c.connection, [A], { minContextSlot: 120 }), (e) => e.code === -32016);
  const g = await getMany(c.connection, Array.from({ length: 150 }, key));
  assert.deepEqual(g.slots, [100, 100]);
  assert.equal(c.configs[c.configs.length - 1], undefined, "without a config the call carries the keys alone");
});

// ---- the feed: who traded, who received pieces --------------------------------------------------------------

test("events and feed: a move of pieces names the receiver's ticket; the traders of a pass are listed, the hook's own buy left out", () => {
  const to = key();
  const logs = invoke(HOOK, [data(transferredBytes({ to, moved: 2 })), data(transferredBytes({ to: key(), moved: 0, burned: 1 })), data(sentBytes({ to }))]);
  assert.equal(transferredFromLogs(logs).length, 2);
  assert.equal(sentFromLogs(logs).length, 1);
  const rec = receivedFromLogs(logs);
  assert.deepEqual(rec.map((x) => x.user.toBase58()), [to.toBase58(), to.toBase58()], "a move of nothing names nobody");
  const items = [
    { signature: "t1", tx: tx("t1", { logs: [data(swappedEventBytes({ pool: POOL, user: OWNER }))], keys: [POOL], slot: 1200 }) },
    { signature: "t2", tx: tx("t2", { logs: [data(swappedEventBytes({ pool: POOL, user: OTHER, byHook: true }))], keys: [POOL] }) },
    { signature: "t3", tx: tx("t3", { logs, keys: [POOL, HOOK], slot: 1300 }) },
  ];
  const got = touchedByTransactions(items, new Set());
  assert.deepEqual(got.swaps, [{ pool: POOL.toBase58(), user: OWNER.toBase58(), direction: 0 }]);
  assert.equal(got.received.length, 2); assert.equal(got.received[0].slot, 1300n); assert.equal(got.received[0].signature, "t3");
});

test("feed: a cursor the RPC no longer knows (a node that keeps a short history) is dropped, the list runs down to its slot, and the pass says so; nothing new is no failure either", async () => {
  const dir = tmpDir();
  const sigs = [{ signature: "n2", slot: 60, err: null }, { signature: "n1", slot: 55, err: null }];
  const calls = [];
  let history = [...sigs];
  const connection = {
    async getSignaturesForAddress(addr, opts = {}) {
      calls.push({ ...opts });
      if (opts.until && !history.some((s) => s.signature === opts.until)) throw new Error(`failed to get signatures for address: Transaction ${opts.until} not found`);
      return history.slice(0, opts.limit ?? 1000);
    },
    async getTransactions(list) { return list.map((s) => tx(s, { slot: s === "n2" ? 60 : 55, logs: [data(swappedEventBytes({ pool: POOL, user: OWNER }))], keys: [POOL] })); },
  };
  const feed = new TradesFeed({ connection, dir: path.join(dir, "trades"), stateFile: path.join(dir, "feed.json"), log: quiet, fetchOpts: { pauseMs: 0 } });
  feed.state.startSlot = 5; feed.state.cursor = "gone"; feed.state.cursorSlot = 50;   // pruned from the node's history
  const c = await feed.collect(70);
  assert.equal(c.cursorLost, true);
  assert.deepEqual([c.sigs, c.transactions, feed.state.cursor, feed.state.cursorSlot], [2, 2, "n2", 60]);
  assert.deepEqual(calls[1], { limit: 1000 }, "the second list has no `until`: it runs down to the cursor's slot");
  // later the program is quiet past the node's history again: the cursor goes, the pass reports nothing new
  history = [];
  const q = await feed.collect(90);
  assert.deepEqual([q.cursorLost, q.sigs, feed.state.cursor, feed.state.cursorSlot], [true, 0, null, 60]);
  const r = await feed.collect(95);
  assert.deepEqual([r.cursorLost, r.sigs], [false, 0], "without a cursor the next pass lists down to the slot, no error");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the feed's lock ----------------------------------------------------------------------------------------

test("feed lock: a lock folder names the lock after the state file; a lock of another boot or of a reused process id is taken over; the one that runs is refused", () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, "state", "feed.json");
  const lockDir = path.join(dir, "run");
  const file = feedLockFile(stateFile, lockDir);
  assert.match(path.basename(file), /^feed-[0-9a-f]{12}\.lock$/);
  assert.notEqual(feedLockFile(path.join(dir, "other.json"), lockDir), file, "two sets of files, two locks");
  const startOf = (pid) => (pid === process.ppid ? "4242" : "1");
  // the parent of this test runs: with the same boot and the same start, it holds the lock
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, since: "x", boot: "boot-a", start: "4242" }));
  assert.equal(acquireFeedLock(stateFile, { dir: lockDir, boot: "boot-a", startOf }).ok, false);
  // a reboot since: the id may belong to anybody now
  assert.equal(lockHolderRuns({ pid: process.ppid, boot: "boot-a", start: "4242" }, { boot: "boot-b", startOf }), false);
  // the same boot, but that id started at another time: another process
  assert.equal(lockHolderRuns({ pid: process.ppid, boot: "boot-a", start: "1111" }, { boot: "boot-a", startOf }), false);
  const mine = acquireFeedLock(stateFile, { dir: lockDir, boot: "boot-b", startOf });
  assert.equal(mine.ok, true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([written.pid, written.boot, written.stateFile], [process.pid, "boot-b", path.resolve(stateFile)]);
  mine.release();
  assert.equal(fs.existsSync(file), false);
  // a lock folder that cannot be made: the lock goes next to the state file, and says why
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "a file, not a folder");
  const fb = acquireFeedLock(stateFile, { dir: path.join(blocker, "run") });
  assert.equal(fb.ok, true); assert.ok(fb.fallback); assert.equal(fb.file, `${stateFile}.lock`);
  fb.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("health: a watcher that runs without the feed it was asked for (a held lock) answers ok false and says by whom", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const status = { updatedAt: new Date(now - 1000).toISOString(), pools: {} };
  const h = healthBody({ status, feed: { enabled: false, locked: { pid: 4321, since: "2026-10-01T00:00:00.000Z" } }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.deepEqual([h.ok, h.stale, h.feedEnabled, h.feedLocked, h.feedLockedBy, h.feedLockedSince], [false, false, false, true, 4321, "2026-10-01T00:00:00.000Z"]);
  const fine = healthBody({ status, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.deepEqual([fine.ok, fine.feedLocked, fine.feedLockedBy], [true, false, null]);
  const n = healthBody({ status, notify: { enabled: true, accepted: 5, refused: 1, statusCalls: 3, unknown: 4, reads: 1, found: 1 }, tickets: { size: 2, emptied: 7, hot: 1 }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.deepEqual([n.notifyStatusCalls, n.notifyUnknown, n.notifyTransactionsRead, n.notifyBuysFound, n.ticketIndexEmptied, n.ticketIndexHot], [3, 4, 1, 1, 7, 1]);
});

// ---- the address behind the proxy, the limits, the settings -------------------------------------------------

test("notify limits: the address the proxy added is the last X-Forwarded-For entry that is no hop of its own; 3 a minute per address and 30 in all", () => {
  const at = (xff, ra = "127.0.0.1") => clientIp({ socket: { remoteAddress: ra }, headers: { "x-forwarded-for": xff } });
  assert.equal(at("203.0.113.7, 198.51.100.9"), "198.51.100.9");
  assert.equal(at("203.0.113.5, 10.0.0.1"), "203.0.113.5", "a private hop of the proxy chain is skipped");
  assert.equal(at("1.2.3.4, 9.9.9.9, 172.16.0.3, 127.0.0.1"), "9.9.9.9");
  assert.equal(at("10.0.0.2, 192.168.1.1"), "192.168.1.1", "all hops: the last one");
  assert.equal(at(["5.5.5.5", "6.6.6.6"]), "6.6.6.6");
  assert.equal(at("5.5.5.5", "::ffff:127.0.0.1"), "5.5.5.5");
  assert.equal(at("5.5.5.5", "198.51.100.1"), "198.51.100.1", "a stranger's header is not believed");
  for (const h of ["127.0.0.1", "10.1.1.1", "172.31.255.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "[::1]"]) assert.equal(proxyHop(h), true, h);
  for (const h of ["8.8.8.8", "172.32.0.1", "198.51.100.9", "203.0.113.7", "2606:4700::1111", "100.128.0.1"]) assert.equal(proxyHop(h), false, h);
  assert.deepEqual([NOTIFY_PER_MINUTE, NOTIFY_GLOBAL_PER_MINUTE], [3, 30]);
  let now = 0;
  const lim = new NotifyLimiter({ now: () => now });
  assert.deepEqual([1, 2, 3, 4].map(() => lim.allow("a")), [true, true, true, false]);
  for (let i = 0; i < 40; i++) lim.allow(`b${i}`);
  assert.equal(lim.allow("z"), false, "thirty a minute in all");
  now = 60_001; assert.equal(lim.allow("z"), true);
});

test("settings: the settle sweep, the lock folder, the notify limits; all printed in plain ASCII", () => {
  const c = buildConfig({}, parseArgs([]), "/w");
  assert.deepEqual([c.settleSweepSeconds, c.lockDir, c.notifyPerMinute, c.notifyGlobalPerMinute], [300, null, 3, 30]);
  const s = buildConfig({ LOCK_DIR: "/run/programmable-watcher", SETTLE_SWEEP_SECONDS: "120", NOTIFY_GLOBAL_PER_MINUTE: "60" }, parseArgs([]), "/w");
  assert.deepEqual([s.lockDir.replace(/\\/g, "/").replace(/^[A-Za-z]:/, ""), s.settleSweepSeconds, s.notifyGlobalPerMinute], ["/run/programmable-watcher", 120, 60]);
  assert.throws(() => buildConfig({ SETTLE_SWEEP_SECONDS: "5" }, parseArgs([]), "/w"), /SETTLE_SWEEP_SECONDS=5 is below the minimum 10/);
  assert.throws(() => buildConfig({ NOTIFY_GLOBAL_PER_MINUTE: "0" }, parseArgs([]), "/w"), /NOTIFY_GLOBAL_PER_MINUTE/);
  const shown = describeConfig(c);
  assert.match(shown.settleSweep, /every 300 s every indexed ticket/);
  assert.equal(describeConfig(buildConfig({}, parseArgs(["--no-feed"]), "/w")).settleSweep, "every indexed ticket each pass (the feed is off)");
  assert.ok(Object.values(shown).every((v) => /^[\x20-\x7e]*$/.test(String(v))), "plain ASCII");
});
