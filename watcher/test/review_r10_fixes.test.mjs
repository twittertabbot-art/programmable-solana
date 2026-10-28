// Round 10: the fixes after the round 9 review. The one list of pools that owes a read and is patched by address,
// the ticket index, the events attributed to the program that logged them, the feed's touched pools and 429
// pauses, the cranks fed by the index, the mint crank fed by the feed and by /notify, the holder sync's pause after
// a failed read, the read streaks in /health, the HTTP server that never throws, POST /notify, and the private-host
// guard that judges addresses, not names. None of them touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAMS, EVENT_DISC, collectible } from "../../sdk/dist/index.js";
import { PoolCache, bs58, FULL_READ_RETRY_MS } from "../lib/pools.mjs";
import { TicketIndex, loadTicketIndex, reconcileBackoffMs, EMPTY_PASSES_TO_DROP, RECONCILE_RETRY_MS } from "../lib/tickets.mjs";
import { attributedLogs, logsOfProgram, earnedFromLogs, depositUsedFromLogs, txAccountKeys, touchesProgram } from "../lib/events.mjs";
import { touchedByTransactions, fetchTransactions, isRateLimited, rateLimitPauseMs, TX_PER_REQUEST, PAUSE_BETWEEN_REQUESTS_MS, TradesFeed } from "../lib/feed.mjs";
import { readUnbacked, readUpkeep, readTickets } from "../lib/crank.mjs";
import { MintCrank } from "../lib/mint.mjs";
import { readHolderExcess, holderScanDue, holderScanBackoffMs } from "../lib/burn.mjs";
import { startServer, healthBody, readStale, parseSignature, notifyBodySignature, NotifyLimiter, clientIp, READ_STALE_MS } from "../lib/server.mjs";
import { privateHost, privateAddress, pinnedLookup, pinnedFetch, fetchMetadataJson, metadataUrl } from "../lib/market.mjs";
import { buildConfig, parseArgs, describeConfig } from "../lib/config.mjs";
import { LARGEST_REFUSED_MS } from "../lib/simulate.mjs";
import { ticketBytes, collectionConfig, tokenAccountBytes, swappedEventBytes, liquidityChangedEventBytes, poolBytes, POOL, OWNER, OTHER, BASE_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, BATCH_REVEALED, strictConfig, holderRecordBytes, mint2022Bytes } from "./bytes.mjs";
import { pda, decodePool } from "../../sdk/dist/index.js";

const { STANDARD_RENT, KEEPER_FEE } = collectible;
const HOOK = PROGRAMS.hook_collectible;
const key = () => Keypair.generate().publicKey;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "r10-"));
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const data = (bytes) => `Program data: ${Buffer.from(bytes).toString("base64")}`;
const earnedBytes = ({ pool = POOL, user = OWNER, pieces = 2, slot = 999n, targetSlot = 1001n } = {}) => {
  const b = Buffer.alloc(92); Buffer.from(EVENT_DISC.PiecesEarned).copy(b, 0); pool.toBuffer().copy(b, 8); user.toBuffer().copy(b, 40);
  b.writeUInt32LE(pieces, 72); b.writeBigUInt64LE(slot, 76); b.writeBigUInt64LE(targetSlot, 84); return b;
};
const usedBytes = ({ pool = POOL, user = OWNER, by = OTHER, pieces = 2, paid = 5n, left = 1n } = {}) => {
  const b = Buffer.alloc(124); Buffer.from(EVENT_DISC.DepositUsed).copy(b, 0); pool.toBuffer().copy(b, 8); user.toBuffer().copy(b, 40); by.toBuffer().copy(b, 72);
  b.writeUInt32LE(pieces, 104); b.writeBigUInt64LE(paid, 108); b.writeBigUInt64LE(left, 116); return b;
};
const invoke = (program, lines) => [`Program ${program.toBase58()} invoke [1]`, ...lines, `Program ${program.toBase58()} success`];
const tx = (signature, { logs = [], keys = [], err = null, slot = 1000, loaded = null } = {}) => ({
  slot, blockTime: 1_760_000_000, meta: { err, logMessages: logs, innerInstructions: [], loadedAddresses: loaded },
  transaction: { signatures: [signature], message: { staticAccountKeys: keys } },
});
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
const request = (port, method, pathname, body = null, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
  req.on("error", reject);
  if (body !== null) req.write(body);
  req.end();
});

// ---- the one list of pools --------------------------------------------------------------------------------

const poolAt = (address, reserveQuote) => decodePool(address, new Uint8Array(poolBytes({ reserveQuote })));

test("pools: a read that fails leaves the list owed; confirm is refused until a read works, with the feed off get() reads again", async () => {
  let fail = true;
  const A = key();
  let now = 1_000_000;
  const cache = new PoolCache({ read: async () => { if (fail) throw new Error("scan aborted"); return { pools: [poolAt(A, 2n)], bytes: new Map([[A.toBase58(), new Uint8Array(poolBytes({ reserveQuote: 2n }))]]), slot: 2 }; }, now: () => now });
  cache.set({ pools: [poolAt(A, 1n)], bytes: new Map(), slot: 1 }, 900_000);
  await assert.rejects(() => cache.refresh(), /scan aborted/);
  assert.equal(cache.fullOwed, true, "a read of the whole program is owed");
  assert.equal(cache.owed, false, "the known pools are still the chain's: nothing of the pool program was walked unread");
  assert.equal(cache.fullFailures, 1);
  assert.equal(cache.nextFullAt, 1_000_000 + FULL_READ_RETRY_MS, "the next read of the whole program waits 30 s");
  cache.confirm(1_000_000);
  assert.equal(cache.validAt, 1_000_000, "the feed's own word (no transaction landed) still confirms the known pools");
  now = 1_000_000 + FULL_READ_RETRY_MS;
  await assert.rejects(() => cache.refresh());
  assert.equal(cache.nextFullAt, now + 2 * FULL_READ_RETRY_MS, "the pause doubles");
  // a transaction walked past unread: which pools changed is not known, so the list is owed and not confirmed
  cache.oweFull();
  assert.equal(cache.owed, true);
  cache.confirm(now + 1000);
  assert.equal(cache.validAt, 1_000_000, "an owed list is never confirmed");
  assert.equal(cache.nextFullAt, now + 2 * FULL_READ_RETRY_MS, "a failing node keeps its pause all the same");
  fail = false;
  const got = await cache.get(300_000);
  assert.equal(got[0].reserveQuote, 2n, "with the feed off, get() reads again while a read is owed");
  assert.equal(cache.owed, false); assert.equal(cache.fullOwed, false); assert.equal(cache.fullFailures, 0); assert.equal(cache.fullFailedSince, null);
  cache.confirm(now + 5000);
  assert.equal(cache.validAt, now + 5000, "a clean list is confirmed");
});

test("pools: the pools a pass touched are read by address and patched into the list; a failed patch is owed and read again by the next one", async () => {
  const A = key(); const B = key(); const C = key();
  const chain = new Map([[A.toBase58(), 10n], [B.toBase58(), 20n]]);
  const reads = [];
  let fail = false;
  const readSome = async (addresses) => {
    reads.push(addresses.map((a) => a.toBase58()).sort());
    if (fail) throw new Error("timed out");
    const pools = new Map(); const bytes = new Map();
    for (const a of addresses) { const k = a.toBase58(); if (!chain.has(k)) { pools.set(k, null); continue; } const raw = new Uint8Array(poolBytes({ reserveQuote: chain.get(k) })); pools.set(k, decodePool(a, raw)); bytes.set(k, raw); }
    return { pools, bytes, slot: 50 };
  };
  let now = 1_000_000;
  const cache = new PoolCache({ read: async () => ({ pools: [poolAt(A, 1n), poolAt(B, 2n)], bytes: new Map(), slot: 1 }), readSome, now: () => now, feedOwned: true });
  await cache.refresh();
  assert.equal((await cache.get(0)).length, 2, "with the feed on, get() serves the list whatever its age and never reads");
  assert.equal(cache.reads, 1);
  // a trade on A, a new pool C named by its PoolCreated event, and B unchanged: A and C are read, B is left alone
  chain.set(C.toBase58(), 30n);
  now = 1_100_000;
  const r = await cache.refreshSome([A, C.toBase58()]);
  assert.deepEqual(reads[0], [A.toBase58(), C.toBase58()].sort());
  assert.deepEqual({ read: r.read, changed: r.changed, added: r.added, dropped: r.dropped }, { read: 2, changed: 1, added: 1, dropped: 0 });
  assert.deepEqual(cache.pools.map((p) => p.reserveQuote), cache.pools.map((p) => p.address.equals(A) ? 10n : p.address.equals(B) ? 2n : 30n));
  assert.equal(cache.slot, 50); assert.equal(cache.validAt, 1_100_000); assert.equal(cache.readAt, 1_100_000); assert.equal(cache.reads, 1, "no read of the whole program");
  assert.equal(cache.patches, 1);
  assert.equal(cache.fullDue(1_100_000), false);
  // the patch fails: A is owed, confirm is refused, and the next patch reads A along with what it was asked
  fail = true;
  await assert.rejects(() => cache.refreshSome([A]), /timed out/);
  assert.equal(cache.owed, true); assert.deepEqual([...cache.owedPools], [A.toBase58()]);
  cache.confirm(1_200_000); assert.equal(cache.validAt, 1_100_000);
  fail = false;
  chain.set(A.toBase58(), 11n);
  await cache.refreshSome([B]);
  assert.deepEqual(reads[reads.length - 1], [A.toBase58(), B.toBase58()].sort(), "the owed pool is read with the next batch");
  assert.equal(cache.owed, false); assert.equal(cache.owedPools.size, 0);
  assert.equal(cache.pools.find((p) => p.address.equals(A)).reserveQuote, 11n);
  // an address that holds no pool any more leaves the list
  chain.delete(C.toBase58());
  const d = await cache.refreshSome([C]);
  assert.equal(d.dropped, 1); assert.equal(cache.pools.length, 2);
  // a transaction walked past unread: the whole program is owed now, and the list is not confirmed until it is read
  assert.equal(cache.fullDue(1_300_000), false);
  cache.oweFull();
  assert.equal(cache.fullDue(1_300_000), true);
  assert.equal(cache.owed, true);
  await cache.refresh();
  assert.equal(cache.owed, false);
  const before = [cache.readAt, cache.validAt];
  cache.invalidate();
  assert.deepEqual([cache.readAt, cache.validAt], before, "with the feed on, invalidate() changes nothing: the feed sees the watcher's own transaction");
});

// ---- the ticket index --------------------------------------------------------------------------------------

const ticketAccount = (o = {}, deposit = 0n) => { const d = Buffer.from(ticketBytes(o)); return { owner: HOOK, data: d, lamports: Number(STANDARD_RENT(d.length) + deposit) }; };
function ticketChain() {
  const c = { accounts: new Map(), calls: {}, listed: [], failList: false, slot: 777 };
  const count = (m) => { c.calls[m] = (c.calls[m] ?? 0) + 1; };
  c.connection = {
    async getMultipleAccountsInfoAndContext(keys) { count("getMultipleAccountsInfo"); return { context: { slot: c.slot }, value: keys.map((k) => c.accounts.get(k.toBase58()) ?? null) }; },
    async getMultipleAccountsInfo(keys) { count("getMultipleAccountsInfo"); return keys.map((k) => c.accounts.get(k.toBase58()) ?? null); },
    async getProgramAccounts(pid, opts) {
      count("getProgramAccounts");
      assert.ok(pid.equals(HOOK)); assert.deepEqual(opts.dataSlice, { offset: 0, length: 0 }, "addresses only");
      if (c.failList) throw new Error("failed to get accounts owned by program: scan aborted");
      return c.listed.map((k) => ({ pubkey: new PublicKey(k), account: { data: Buffer.alloc(0), owner: HOOK, lamports: 1 } }));
    },
    async getSlot() { count("getSlot"); return c.slot; },
  };
  return c;
}

test("tickets: the index names a ticket by (pool, wallet), reads the indexed tickets by address with the slot, drops what is gone or empty for three reads, and survives a restart", async () => {
  const c = ticketChain();
  const dir = tmpDir();
  const file = path.join(dir, "tickets.json");
  let now = 1_000_000;
  const idx = new TicketIndex({ file, log: quiet, now: () => now, reconcileEveryMs: 3_600_000 });
  const u1 = key(); const u2 = key(); const u3 = key();
  assert.equal(idx.add(POOL, u1), true); assert.equal(idx.add(POOL, u1), false, "once");
  idx.add(POOL, u2); idx.add(POOL, u3);
  const t1 = collectible.collectiblePda.ticket(POOL, u1).toBase58();
  c.accounts.set(t1, ticketAccount({ pool: POOL, user: u1, minted: 1, owned: [key()] }));
  c.accounts.set(collectible.collectiblePda.ticket(POOL, u2).toBase58(), ticketAccount({ pool: POOL, user: u2 }));  // nothing waiting, nothing owned
  // u3 has no account at all
  let r = await idx.read(c.connection);
  assert.deepEqual(c.calls, { getMultipleAccountsInfo: 1 }, "one call for up to a hundred tickets, with the slot");
  assert.equal(r.slot, 777);
  assert.equal(r.tickets.length, 2); assert.equal(r.dropped, 1, "the address with no account left at once");
  assert.equal(idx.size(), 2);
  assert.ok(r.items[0].info.lamports > 0, "the items carry the account (lamports and length: the deposit)");
  // the shared read: a second loop within the share window gets the same answer, no call
  r = await idx.read(c.connection, { maxAgeMs: 3000 });
  assert.deepEqual(c.calls, { getMultipleAccountsInfo: 1 });
  // empty for three reads (the first read above was one): gone
  for (let i = 2; i < EMPTY_PASSES_TO_DROP; i++) { now += 10_000; r = await idx.read(c.connection); assert.equal(r.tickets.length, 2, `still there after ${i} empty reads`); }
  now += 10_000; r = await idx.read(c.connection);
  assert.equal(r.tickets.length, 1); assert.equal(idx.size(), 1); assert.equal(idx.has(t1), true);
  // a buy puts it back (the feed pass saves the index after it hands the buys on)
  idx.add(POOL, u2);
  assert.equal(idx.size(), 2);
  idx.save();
  // the file: a new instance knows the same tickets
  const again = new TicketIndex({ file, log: quiet, now: () => now });
  assert.equal(again.size(), 2);
  assert.equal(again.state.tickets[t1].pool, POOL.toBase58()); assert.equal(again.state.tickets[t1].user, u1.toBase58());
  // a broken file starts empty
  fs.writeFileSync(file, "{broken");
  assert.equal(loadTicketIndex(file).version, 1); assert.equal(Object.keys(loadTicketIndex(file).tickets).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tickets: the reconciliation lists the program with dataSlice 0, fills pool and wallet on the first read, backs off on failure (1, 2, 4 ... minutes) and says when to alert", async () => {
  const c = ticketChain();
  let now = 2_000_000;
  const idx = new TicketIndex({ file: null, log: quiet, now: () => now, reconcileEveryMs: 3_600_000 });
  assert.equal(idx.reconcileDue(now), true, "an index never listed is due");
  const u = key();
  const t = collectible.collectiblePda.ticket(POOL, u).toBase58();
  c.listed = [t, key().toBase58()];
  c.accounts.set(t, ticketAccount({ pool: POOL, user: u, batches: [{ state: BATCH_REVEALED, pieces: 1, firstRoll: 0, targetSlot: 5n, seed: new Uint8Array(32) }] }));
  let r = await idx.reconcile(c.connection);
  assert.deepEqual({ listed: r.listed, added: r.added, total: r.total }, { listed: 2, added: 2, total: 2 });
  assert.equal(idx.reconcileDue(now), false); assert.equal(idx.reconcileDue(now + 3_600_000), true);
  assert.equal(idx.state.tickets[t].pool, null, "pool and wallet unknown until the first read");
  const read = await idx.read(c.connection);
  assert.equal(idx.state.tickets[t].pool, POOL.toBase58()); assert.equal(idx.state.tickets[t].user, u.toBase58());
  assert.equal(read.tickets.length, 1); assert.equal(idx.size(), 1, "the listed address with no account left");
  // failures: the next try waits 1 minute, then 2, then 4; three in a row is the alert threshold
  c.failList = true;
  now += 3_600_000;
  for (let n = 1; n <= 3; n++) {
    await assert.rejects(() => idx.reconcile(c.connection, now), /scan aborted/);
    assert.equal(idx.state.reconcileFailures, n);
    assert.equal(idx.nextReconcileAt, now + reconcileBackoffMs(n));
    assert.equal(reconcileBackoffMs(n), RECONCILE_RETRY_MS * 2 ** (n - 1));
    now = idx.nextReconcileAt;
  }
  assert.equal(reconcileBackoffMs(20), 3_600_000, "an hour at most");
  assert.equal(idx.status().reconcileFailures, 3); assert.ok(idx.status().reconcileFailedSince);
  c.failList = false;
  r = await idx.reconcile(c.connection, now);
  assert.equal(r.recovered, 3); assert.equal(idx.state.reconcileFailures, 0); assert.equal(idx.state.reconcileFailedSince, null);
});

// ---- events attributed to their program ------------------------------------------------------------------

test("events: a Program data line is attributed to the program running when it was logged; a forged PiecesEarned under another program is not the hook's", () => {
  const forged = key();
  const logs = [
    `Program ${PROGRAMS.hookpool.toBase58()} invoke [1]`,
    `Program ${HOOK.toBase58()} invoke [2]`, data(earnedBytes({ pieces: 3 })), `Program ${HOOK.toBase58()} success`,
    `Program ${forged.toBase58()} invoke [2]`, data(earnedBytes({ pieces: 9, user: OTHER })), `Program ${forged.toBase58()} success`,
    data(usedBytes()),
    `Program ${PROGRAMS.hookpool.toBase58()} success`,
  ];
  const at = attributedLogs(logs);
  assert.deepEqual(at.map((x) => x.program), [HOOK.toBase58(), forged.toBase58(), PROGRAMS.hookpool.toBase58()]);
  assert.equal(logsOfProgram(logs, HOOK).length, 1);
  const earned = earnedFromLogs(logs);
  assert.equal(earned.length, 1); assert.equal(earned[0].pieces, 3); assert.ok(earned[0].user.equals(OWNER));
  assert.equal(depositUsedFromLogs(logs).length, 0, "the DepositUsed line was the pool program's, not the hook's");
  // logs with no invoke line (a synthetic transaction): taken as they are
  assert.equal(earnedFromLogs([data(earnedBytes())]).length, 1);
  assert.equal(depositUsedFromLogs([data(usedBytes())]).length, 1);
  // account keys: static and loaded through lookup tables; the pool program among them
  const t = tx("s", { keys: [OWNER, PROGRAMS.hookpool], loaded: { writable: [POOL], readonly: [] } });
  assert.deepEqual(txAccountKeys(t), [OWNER.toBase58(), PROGRAMS.hookpool.toBase58(), POOL.toBase58()]);
  assert.equal(touchesProgram(t), true);
  assert.equal(touchesProgram(tx("s", { keys: [OWNER] })), false);
  assert.equal(touchesProgram({ transaction: { signatures: ["s"] }, meta: {} }), null, "no keys at all: unknown");
});

// ---- the feed: touched pools, earned pieces, 429 ---------------------------------------------------------

test("feed: the pools a pass touched are the pools of every event, the pools created and every known pool among the account keys; the buys that earned pieces come with their signatures", () => {
  const A = key(); const B = key(); const C = key(); const D = key();
  const items = [
    { signature: "t1", tx: tx("t1", { logs: [data(swappedEventBytes({ pool: A }))], keys: [A] }) },
    { signature: "t2", tx: tx("t2", { logs: [data(liquidityChangedEventBytes({ pool: B }))], keys: [B] }) },
    { signature: "t3", tx: tx("t3", { logs: [], keys: [OWNER, C, PROGRAMS.hookpool] }) },   // no event (a hook's own instruction, say): C is known, so it counts
    { signature: "t4", tx: tx("t4", { logs: [], keys: [D] }) },                             // D is not known and no event names it: not counted (the reconciliation finds it)
    { signature: "t5", tx: tx("t5", { logs: invoke(HOOK, [data(earnedBytes({ pool: A, user: OTHER, pieces: 2, slot: 700n, targetSlot: 702n }))]), keys: [A, PROGRAMS.hookpool] }) },
    { signature: "t6", tx: tx("t6", { logs: [data(swappedEventBytes({ pool: D }))], keys: [D], err: { InstructionError: [0, "Custom"] } }) },  // failed: nothing
  ];
  const got = touchedByTransactions(items, new Set([C.toBase58()]));
  assert.deepEqual([...got.pools].sort(), [A.toBase58(), B.toBase58(), C.toBase58()].sort());
  assert.equal(got.earned.length, 1);
  assert.deepEqual([got.earned[0].signature, got.earned[0].pieces, got.earned[0].slot, got.earned[0].targetSlot, got.earned[0].user.toBase58()], ["t5", 2, 700n, 702n, OTHER.toBase58()]);
});

test("feed: a batch the RPC answers 429 to is sent again after a growing pause instead of failing the pass; the batch size and pause fit 50 requests a second", async () => {
  assert.equal(TX_PER_REQUEST, 25); assert.equal(PAUSE_BETWEEN_REQUESTS_MS, 600);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => rateLimitPauseMs(n)), [1000, 2000, 4000, 8000, 16_000, 16_000]);
  const e429 = new Error("429 Too Many Requests:  {\"jsonrpc\":\"2.0\",\"error\":{\"code\": 429, \"message\":\"Too many requests\"}}");
  assert.equal(isRateLimited(e429), true);
  assert.equal(isRateLimited(new Error("fetch failed")), false);
  const answer = (s) => ({ slot: 1, meta: { err: null, logMessages: [] }, transaction: { signatures: [s] } });
  let refusals = 2; const pauses = [];
  const conn = { async getTransactions(list) { if (refusals > 0) { refusals -= 1; throw e429; } return list.map(answer); }, async getTransaction(s) { return answer(s); } };
  const r = await fetchTransactions(conn, ["a", "b"], { pauseMs: 0, rateLimitPause: (n) => { pauses.push(n); return 0; } });
  assert.equal(r.txs.get("a").transaction.signatures[0], "a"); assert.equal(r.rateLimited, 2); assert.deepEqual(pauses, [0, 1]);
  // more refusals than tries: the pass fails, as before
  refusals = 99;
  await assert.rejects(() => fetchTransactions(conn, ["a"], { pauseMs: 0, rateLimitPause: () => 0, rateLimitRetries: 2 }), /429/);
  // a feed pass hands the buys on: collect() answers the earned events and the pools touched
  const dir = tmpDir();
  const A = key();
  const sigs = [{ signature: "buy1", slot: 1001, err: null }];
  const txs = new Map([["buy1", tx("buy1", { slot: 1001, logs: [data(swappedEventBytes({ pool: A, slot: 1001n })), ...invoke(HOOK, [data(earnedBytes({ pool: A, user: OWNER, pieces: 1, slot: 1001n, targetSlot: 1003n }))])], keys: [A, PROGRAMS.hookpool] })]]);
  let listed = 0;
  const chain = {
    async getSignaturesForAddress(address, opts = {}) { listed += 1; if (listed === 1) return [{ signature: "old", slot: 900, err: null }]; return opts.until === "old" ? sigs : []; },
    async getTransactions(list) { return list.map((s) => txs.get(s) ?? null); },
    async getTransaction(s) { return txs.get(s) ?? null; },
  };
  const feed = new TradesFeed({ connection: chain, dir, stateFile: path.join(dir, "feed.json"), fetchOpts: { pauseMs: 0 } });
  const first = await feed.collect(950);
  assert.equal(first.first, true); assert.deepEqual([first.touchedPools, first.earned, first.unreadable], [[], [], 0]);
  const c = await feed.collect(990);
  assert.deepEqual(c.touchedPools, [A.toBase58()]);
  assert.equal(c.earned.length, 1); assert.equal(c.earned[0].signature, "buy1"); assert.equal(c.earned[0].targetSlot, 1003n);
  assert.equal(c.completeSlot, 1001, "complete up to the newest slot walked, not the older slot the pass was given");
  assert.equal(c.unreadable, 0); assert.equal(c.rateLimited, 0);
  feed.flush(c.completeSlot);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the cranks fed by the index -------------------------------------------------------------------------

test("cranks: with the indexed tickets given, the settle, upkeep and reveal reads make no getProgramAccounts and no getSlot", async () => {
  const cfg = collectionConfig({ pool: POOL, unit: 10n });
  const decoded = collectible.decodeCollectionConfig(cfg);
  const user = key();
  const accounts = new Map();
  accounts.set(collectible.collectiblePda.cfg(POOL).toBase58(), { owner: HOOK, data: Buffer.from(cfg), lamports: 1 });
  const owned = [collectible.collectiblePda.asset(POOL, user, 0)];
  const ticket = collectible.decodeTicket(new Uint8Array(ticketBytes({ pool: POOL, user, minted: 1, owned })));
  // the wallet holds no coins: its one piece is above the peg
  accounts.set(collectible.coinsAddress(user, decoded.baseMint, decoded.tokenProgram).toBase58(), { owner: decoded.tokenProgram, data: Buffer.from(tokenAccountBytes({ mint: decoded.baseMint, owner: user, amount: 0n })), lamports: 1 });
  const calls = {};
  const conn = {
    async getMultipleAccountsInfo(keys) { calls.many = (calls.many ?? 0) + 1; return keys.map((k) => accounts.get(k.toBase58()) ?? null); },
    async getProgramAccounts() { throw new Error("must not be called"); },
    async getSlot() { throw new Error("must not be called"); },
  };
  const s = await readUnbacked(conn, [POOL], { tickets: [ticket] });
  assert.deepEqual(s.unread, []); assert.equal(s.unbacked.length, 1); assert.equal(s.unbacked[0].peg.burn.length, 1);
  assert.deepEqual(calls, { many: 2 });
  const u = await readUpkeep(conn, [POOL], { tickets: [ticket] });
  assert.deepEqual(u.unread, []); assert.deepEqual(u.work, [], "the pool is not pegged: nothing to keep up");
  const r = await readTickets(conn, { tickets: [ticket, collectible.decodeTicket(new Uint8Array(ticketBytes({ pool: POOL, user: key(), batches: [{ state: 1, pieces: 2, firstRoll: 0, targetSlot: 50n, seed: new Uint8Array(32) }] })))], slot: 60 });
  assert.equal(r.tickets.length, 1, "the open tickets only"); assert.equal(r.slot, 60n);
});

// ---- the mint crank fed by the feed and by /notify -------------------------------------------------------

function mintChain() {
  const c = { accounts: new Map(), sigs: [], txs: new Map(), slot: 1000n, calls: {}, sent: [] };
  const count = (m) => { c.calls[m] = (c.calls[m] ?? 0) + 1; };
  c.connection = {
    async getSignaturesForAddress(addr, opts = {}) {
      count("getSignaturesForAddress");
      let list = c.sigs;
      if (opts.until) { const i = list.findIndex((s) => s.signature === opts.until); list = i < 0 ? list : list.slice(0, i); }
      return list.slice(0, opts.limit ?? 1000).map((s) => ({ signature: s.signature, slot: s.slot, err: null }));
    },
    async getTransactions(list) { count("getTransactions"); return list.map((s) => c.txs.get(s) ?? null); },
    async getTransaction(s) { count("getTransaction"); return c.txs.get(s) ?? null; },
    async getProgramAccounts() { count("getProgramAccounts"); throw new Error("must not be called with the index"); },
    async getMultipleAccountsInfo(keys) { count("getMultipleAccountsInfo"); return keys.map((k) => c.accounts.get(k.toBase58()) ?? null); },
    async getMultipleAccountsInfoAndContext(keys) { count("getMultipleAccountsInfo"); return { context: { slot: Number(c.slot) }, value: keys.map((k) => c.accounts.get(k.toBase58()) ?? null) }; },
    async getSlot() { count("getSlot"); return Number(c.slot); },
    async getBalance() { count("getBalance"); return 1_000_000_000; },
    async simulateTransaction() { count("simulateTransaction"); return { value: { err: null, logs: [], accounts: [{ lamports: 1_000_000_000 + Number(KEEPER_FEE) - 5000 }] } }; },
    async sendTransaction() { count("sendTransaction"); const signature = `mint${c.sent.length + 1}`; c.sent.push(signature); return signature; },
  };
  return c;
}
const revealed = (pieces) => ({ state: BATCH_REVEALED, pieces, firstRoll: 0, targetSlot: 50n, seed: new Uint8Array(32).fill(7) });
async function mintCrankOn(c, idx) {
  const keeper = Keypair.generate();
  const buildTx = async (payer, ixs) => {
    const { TransactionMessage, VersionedTransaction } = await import("@solana/web3.js");
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: key().toBase58(), instructions: ixs }).compileToV0Message();
    return { tx: new VersionedTransaction(msg), lastValidBlockHeight: 10 };
  };
  return new MintCrank({ connection: c.connection, keeper, buildTx, rent: STANDARD_RENT, sweepMs: 300_000, now: () => 1_000_000, confirm: async () => ({}), tickets: idx, log: quiet });
}

test("mint: with the ticket index the sweep reads the indexed tickets by address (no getProgramAccounts); the feed hands buys in at no call; a notified signature is read once and must be a transaction of the pool program", async () => {
  const c = mintChain();
  const cfgBytes = collectionConfig({ pool: POOL, unit: 10n });
  const cfg = collectible.decodeCollectionConfig(cfgBytes);
  c.accounts.set(collectible.collectiblePda.cfg(POOL).toBase58(), { owner: HOOK, data: Buffer.from(cfgBytes), lamports: 1 });
  const user = key();
  const cost = collectible.mintForCost(STANDARD_RENT, cfg, 346, 0, 2);
  c.accounts.set(collectible.collectiblePda.ticket(POOL, user).toBase58(), ticketAccount({ pool: POOL, user, batches: [revealed(2)] }, cost + 1000n));
  c.accounts.set(collectible.coinsAddress(user, cfg.baseMint, cfg.tokenProgram).toBase58(), { owner: cfg.tokenProgram, data: Buffer.from(tokenAccountBytes({ mint: cfg.baseMint, owner: user, amount: 100n })), lamports: 1 });
  const idx = new TicketIndex({ file: null, log: quiet, now: () => 1_000_000 });
  idx.add(POOL, user);
  const crank = await mintCrankOn(c, idx);
  c.sigs = [{ signature: "old", slot: 900 }];
  const r = await crank.pass();
  assert.equal(r.swept, true); assert.equal(r.sent, 1, `the sweep found the deposit through the index and the mint went out: ${JSON.stringify(r)}`);
  assert.equal(c.calls.getProgramAccounts, undefined, "no read of the whole program");
  assert.ok(c.calls.getMultipleAccountsInfo >= 2);
  // the feed hands a buy in: the wallet is on the list before any poll, and its ticket is in the index
  c.calls = {};
  const u2 = key();
  assert.equal(crank.addEarned([{ pool: POOL, user: u2, pieces: 1, slot: 999n, targetSlot: 1001n }]), 1);
  const w2 = crank.watch.get(`${POOL.toBase58()}:${u2.toBase58()}`);
  assert.ok(w2, "the wallet is on the list"); assert.equal(w2.untilSlot, 1001n); assert.equal(w2.buySlot, 999n);
  assert.equal(idx.has(collectible.collectiblePda.ticket(POOL, u2).toBase58()), true);
  assert.deepEqual(c.calls, {}, "handing a buy in costs no call");
  assert.equal(crank.handed, 1);
  // /notify: the signature is read once; a transaction that is not the pool program's adds nothing; one that is adds the wallet
  const u3 = key(); const u4 = key();
  c.txs.set("stranger", tx("stranger", { slot: 999, logs: invoke(HOOK, [data(earnedBytes({ pool: POOL, user: u3, pieces: 1, slot: 999n, targetSlot: 1001n }))]), keys: [u3, HOOK] }));
  c.txs.set("buy", tx("buy", { slot: 999, logs: invoke(PROGRAMS.hookpool, [`Program ${HOOK.toBase58()} invoke [2]`, data(earnedBytes({ pool: POOL, user: u4, pieces: 1, slot: 999n, targetSlot: 1001n })), `Program ${HOOK.toBase58()} success`]), keys: [u4, PROGRAMS.hookpool, HOOK] }));
  assert.deepEqual(crank.notify("stranger"), { accepted: true, reason: null });
  assert.deepEqual(crank.notify("stranger"), { accepted: false, reason: "seen already" });
  assert.deepEqual(crank.notify("buy"), { accepted: true, reason: null });
  assert.equal(crank.notify("mint1").accepted, false, "its own transaction");
  c.slot = 1000n;   // the deciding blocks are not in yet: nothing is minted this pass
  const p = await crank.pass();
  assert.equal(p.found, 1, "one wallet found: the pool program's transaction");
  assert.equal(crank.watch.has(`${POOL.toBase58()}:${u4.toBase58()}`), true);
  assert.equal(crank.watch.has(`${POOL.toBase58()}:${u3.toBase58()}`), false, "a stranger's transaction with a forged event adds nothing");
  assert.equal(c.calls.getTransactions, 1, "the two notified transactions in one batched read");
  assert.equal(crank.unread.size, 0);
  const again = await crank.pass();
  assert.equal(again.transactions, 0, "a notified signature is read once");
  // the RPC forgets the cursor's transaction (a short history): the poll starts again instead of failing for good
  const real = c.connection.getSignaturesForAddress;
  c.connection.getSignaturesForAddress = async (addr, opts = {}) => { if (opts.until) throw new Error(`failed to get signatures for address: Transaction ${opts.until} not found`); return real(addr, opts); };
  const lost = await crank.pass();
  assert.equal(lost.swept, false); assert.equal(crank.cursor, null, "the cursor is dropped");
  c.connection.getSignaturesForAddress = real;
  const fresh = await crank.pass();
  assert.equal(fresh.swept, true, "the next pass sweeps the indexed tickets and sets the cursor again");
  assert.equal(crank.cursor, c.sigs[0].signature);
});

// ---- the holder sync backs off after a failed read -------------------------------------------------------

test("holder sync: a strict pool whose records could not be read waits 30 s, then 60, ... before the next try; a good read writes the three fields as before", async () => {
  const address = key(); const mint = key();
  const pool = { address, hasHook: true, hookProgram: PROGRAMS.hook_rules, baseMint: mint, baseTokenProgram: TOKEN_2022_PROGRAM };
  const accounts = new Map();
  accounts.set(pda.cfg(PROGRAMS.hook_rules, address).toBase58(), { owner: PROGRAMS.hook_rules, data: Buffer.from(strictConfig({ pool: address, totalStaked: 60_000n })) });
  accounts.set(mint.toBase58(), { owner: TOKEN_2022_PROGRAM, data: Buffer.from(mint2022Bytes({ supply: 1_000_000n })) });
  let fail = true; const calls = [];
  const connection = {
    async getMultipleAccountsInfoAndContext(keys) { calls.push(`many:${keys.length}`); return { context: { slot: 1 }, value: keys.map((k) => accounts.get(k.toBase58()) ?? null) }; },
    async getProgramAccounts() { calls.push("records"); if (fail) throw new Error("scan aborted"); return [{ pubkey: key(), account: { data: Buffer.from(holderRecordBytes({ pool: address, owner: OWNER, balance: 10_000n })) } }]; },
  };
  const scans = {};
  const t0 = 1_000_000;
  let r = await readHolderExcess(connection, [pool], { minBps: 10, scans, nowMs: t0 });
  assert.equal(r.unread.length, 1); assert.match(r.unread[0].error, /scan aborted/);
  assert.deepEqual(scans[address.toBase58()], { failures: 1, notBefore: t0 + holderScanBackoffMs(1) });
  assert.equal(holderScanBackoffMs(1), 30_000); assert.equal(holderScanBackoffMs(2), 60_000); assert.equal(holderScanBackoffMs(9), 600_000);
  assert.equal(holderScanDue(scans[address.toBase58()], "1000000", t0 + 10_000), false);
  calls.length = 0;
  r = await readHolderExcess(connection, [pool], { minBps: 10, scans, nowMs: t0 + 10_000 });
  assert.deepEqual(calls, ["many:2"], "within the pause: the records are not asked for");
  assert.deepEqual(r, { work: [], unread: [] });
  r = await readHolderExcess(connection, [pool], { minBps: 10, scans, nowMs: t0 + 30_000 });
  assert.equal(r.unread.length, 1); assert.equal(scans[address.toBase58()].failures, 2); assert.equal(scans[address.toBase58()].notBefore, t0 + 30_000 + 60_000);
  fail = false;
  r = await readHolderExcess(connection, [pool], { minBps: 10, scans, nowMs: t0 + 90_000 });
  assert.equal(r.work.length, 1);
  assert.deepEqual(scans[address.toBase58()], { supply: "1000000", at: t0 + 90_000, pending: 1 }, "a good read writes exactly the three fields it wrote before (the record stands above its wallet's coins: one to sync)");
});

// ---- /health: the read streaks, the index, the pools ------------------------------------------------------

test("health: a crank whose reads have failed for ten minutes makes the answer stale; the streaks, the index and the pools are in it", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const status = { updatedAt: new Date(now - 1000).toISOString(), pools: {} };
  const settle = { enabled: true, lastSettleAt: new Date(now - 1000).toISOString(), lastSettleSent: 0, intervalSeconds: 10, totals: null };
  const ok = healthBody({ status, settle, reads: { settle: { streak: 3, since: new Date(now - 60_000).toISOString(), lastReadAt: new Date(now - 90_000).toISOString() } }, tickets: { size: 14, reconciledAt: "2026-10-23T11:00:00Z", reconcileFailures: 0, reconcileFailedSince: null }, pools: { readAt: "x", fullAt: "y", owed: false, fullFailures: 0, fullFailedSince: null, patches: 5, reads: 1 }, notify: { enabled: true, accepted: 2, refused: 1 }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.equal(ok.ok, true); assert.equal(ok.readStale, false);
  assert.deepEqual([ok.settleUnreadStreak, ok.lastSettleReadAt, ok.settleReadStale], [3, new Date(now - 90_000).toISOString(), false]);
  assert.deepEqual([ok.ticketIndexSize, ok.ticketIndexReconciledAt, ok.poolsPatched, ok.poolsFullReads, ok.poolsReadOwed, ok.notifyEnabled, ok.notifyAccepted, ok.notifyRefused], [14, "2026-10-23T11:00:00Z", 5, 1, false, true, 2, 1]);
  const stale = healthBody({ status, settle, reads: { settle: { streak: 61, since: new Date(now - READ_STALE_MS - 1000).toISOString(), lastReadAt: null } }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.equal(stale.ok, false); assert.equal(stale.readStale, true); assert.equal(stale.settleReadStale, true); assert.equal(stale.stale, true);
  // a crank that is off is never read-stale; a streak that just began is not either
  assert.equal(readStale({ streak: 61, since: new Date(now - READ_STALE_MS - 1000).toISOString() }, now, false), false);
  assert.equal(readStale({ streak: 1, since: new Date(now - 1000).toISOString() }, now, true), false);
  assert.equal(readStale(null, now, true), false);
  const off = healthBody({ status, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.deepEqual([off.readStale, off.settleUnreadStreak, off.ticketIndexSize, off.poolsReadOwed, off.notifyEnabled], [false, 0, 0, false, false]);
});

// ---- the HTTP server: never throws, POST /notify --------------------------------------------------------

test("server: POST /notify takes a base58 signature of 64 bytes (JSON or bare), hands it on, rate limits per address, and refuses the rest; nothing a request carries throws", async () => {
  const good = bs58(Buffer.alloc(64, 7));
  assert.equal(parseSignature(good), good);
  assert.equal(parseSignature(bs58(Buffer.alloc(63, 7))), null, "63 bytes");
  assert.equal(parseSignature("not base58 0OIl"), null);
  assert.equal(parseSignature(good + "1"), null);
  assert.equal(notifyBodySignature(JSON.stringify({ signature: good })), good);
  assert.equal(notifyBodySignature(good), good);
  assert.equal(notifyBodySignature(`"${good}"`), good);
  assert.equal(notifyBodySignature(JSON.stringify({ signature: 5 })), null);
  assert.equal(notifyBodySignature("{broken"), null);
  assert.equal(notifyBodySignature(""), null);
  const lim = new NotifyLimiter({ perMinute: 2, globalPerMinute: 3, now: () => 1_000_000 });
  assert.deepEqual([lim.allow("a"), lim.allow("a"), lim.allow("a"), lim.allow("b"), lim.allow("c")], [true, true, false, true, false], "two per address, three for everybody");
  assert.equal(clientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } }), "203.0.113.5", "behind the proxy on this machine: the first forwarded address");
  assert.equal(clientIp({ socket: { remoteAddress: "198.51.100.9" }, headers: { "x-forwarded-for": "203.0.113.5" } }), "198.51.100.9", "a stranger's forwarded header is not believed");

  const dir = tmpDir();
  const statusFile = path.join(dir, "pools.json");
  fs.writeFileSync(statusFile, JSON.stringify({ updatedAt: new Date().toISOString(), cluster: "localnet", platform: {}, pools: {} }));
  const port = await freePort();
  const handed = [];
  const server = startServer({ port, host: "127.0.0.1", statusFile, cluster: "localnet", getStatus: () => null, getReads: () => ({}), notify: { handle: async (s) => { handed.push(s); return s === good ? { accepted: true, reason: null } : { accepted: false, reason: "seen already" }; }, perMinute: 3, globalPerMinute: 100 }, staleAfterMs: 1000, log: quiet });
  try {
    await new Promise((r) => setTimeout(r, 100));
    let r = await request(port, "POST", "/notify", JSON.stringify({ signature: good }));
    assert.equal(r.status, 202); assert.deepEqual(JSON.parse(r.body), { accepted: true, reason: null }); assert.deepEqual(handed, [good]);
    r = await request(port, "POST", "/notify", good);
    assert.equal(r.status, 202, "the bare signature works too (no preflight for the page)");
    r = await request(port, "POST", "/notify", "nonsense");
    assert.equal(r.status, 400); assert.equal(handed.length, 2);
    r = await request(port, "POST", "/notify", "x".repeat(5000));
    assert.equal(r.status, 413);
    r = await request(port, "POST", "/notify", JSON.stringify({ signature: good }));
    assert.equal(r.status, 202);
    r = await request(port, "POST", "/notify", JSON.stringify({ signature: good }));
    assert.equal(r.status, 429, "the fourth in a minute from one address");
    r = await request(port, "POST", "/other", good);
    assert.equal(r.status, 404);
    r = await request(port, "GET", "/notify");
    assert.equal(r.status, 404);
    r = await request(port, "OPTIONS", "/notify");
    assert.equal(r.status, 204);
    r = await request(port, "GET", "/health");
    assert.equal(r.status, 503); assert.equal(JSON.parse(r.body).notifyEnabled, false, "the getter is not wired in this test");
    r = await request(port, "GET", "/pools.json");
    assert.equal(r.status, 200);
  } finally { server.close(); }
  const off = startServer({ port: await freePort(), host: "127.0.0.1", statusFile, cluster: "localnet", getStatus: () => null, notify: null, staleAfterMs: 1000, log: quiet });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const r = await request(off.address().port, "POST", "/notify", good);
    assert.equal(r.status, 404, "without the mint crank the route is not there");
  } finally { off.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the private-host guard judges addresses ------------------------------------------------------------

test("market: names that carry or answer a private address are refused, an address is judged in every form, and the connection goes to the checked address", async () => {
  for (const h of ["127.0.0.1.nip.io", "10-0-0-1.sslip.io", "169.254.169.254.nip.io", "app.127.0.0.1.xip.io", "localtest.me", "a.lvh.me", "x.localtest.me.", "192.0.2.1", "198.18.0.1", "100.64.0.1", "[::ffff:10.0.0.1]", "::ffff:7f00:1"]) assert.equal(privateHost(h), true, h);
  for (const h of ["example.com", "8.8.8.8.nip.io", "arweave.net", "1.2.3.4", "2606:4700::1111", "nip.io", "gateway.pinata.cloud"]) assert.equal(privateHost(h), false, h);
  for (const a of ["127.0.0.1", "10.1.2.3", "172.31.0.1", "192.168.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "fc12::3", "fec0::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "2002:0a00:0001::1", "2001::1", "2001:db8::1", "nonsense", ""]) assert.equal(privateAddress(a), true, a);
  for (const a of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "2a00:1450:4001::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:0808:0808::1"]) assert.equal(privateAddress(a), false, a);
  assert.equal(metadataUrl("http://127.0.0.1.nip.io/x.json"), null);
  // the lookup for the socket: a name whose answers hold one private address is refused with EPRIVATE
  const look = pinnedLookup({ resolve: async (host) => {
    if (host === "evil.example") return [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }];
    if (host === "gone.example") { const e = new Error("getaddrinfo ENOTFOUND gone.example"); e.code = "ENOTFOUND"; throw e; }
    return [{ address: "93.184.216.34", family: 4 }];
  } });
  const call = (host, opts) => new Promise((resolve) => look(host, opts, (...a) => resolve(a)));
  let a = await call("evil.example", {});
  assert.equal(a[0].code, "EPRIVATE", "one private answer among the addresses refuses the name");
  a = await call("good.example", {});
  assert.deepEqual(a, [null, "93.184.216.34", 4]);
  a = await call("good.example", { all: true });
  assert.deepEqual(a, [null, [{ address: "93.184.216.34", family: 4 }]]);
  a = await call("gone.example", {});
  assert.equal(a[0].code, "ENOTFOUND", "a name with no address fails the connection the usual way");
  // the fetch: over a local server, with a lookup that lets the loopback through; the default lookup refuses it
  const srv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json", "x-host": req.headers.host }); res.end(JSON.stringify({ image: "https://a.example/i.png", path: req.url })); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const res = await pinnedFetch(`http://127.0.0.1:${port}/m.json`, { headers: { accept: "application/json" } }, { allowPrivate: true });
    assert.equal(res.status, 200); assert.equal(res.ok, true); assert.equal(res.headers.get("x-host"), `127.0.0.1:${port}`);
    assert.equal(JSON.parse(await res.text()).path, "/m.json");
    await assert.rejects(() => pinnedFetch(`http://127.0.0.1:${port}/m.json`, {}), (e) => e.code === "EPRIVATE");
    const got = await fetchMetadataJson(`http://127.0.0.1:${port}/m.json`, { allowPrivate: true });
    assert.equal(got.status, "ok"); assert.equal(got.image, "https://a.example/i.png");
    // on a server (allowPrivate false) the same address is "none" by its name; a name refused by its addresses is "invalid"
    assert.equal((await fetchMetadataJson(`http://127.0.0.1:${port}/m.json`)).status, "none");
    assert.equal((await fetchMetadataJson("https://a.example/m.json", { fetchImpl: async () => { const e = new Error("private"); e.code = "EPRIVATE"; throw e; } })).status, "invalid");
    assert.equal((await fetchMetadataJson("https://a.example/m.json", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })).status, "unreachable");
  } finally { srv.close(); }
});

// ---- settings, and the memo of a refused getTokenLargestAccounts ----------------------------------------

test("settings: the ticket index, POST /notify, the mint poll once a minute, the settle crank every 10 s, every pool every 30 minutes; the refusal of getTokenLargestAccounts is kept for a day", () => {
  const c = buildConfig({}, parseArgs([]), "/w");
  // round 13: the notify limits came down to 3 a minute per address and 30 in all (review R12, finding 1)
  assert.deepEqual([c.notify, c.notifyPerMinute, c.notifyGlobalPerMinute, c.ticketReconcileSeconds, c.mintIntervalSeconds, c.settleIntervalSeconds, c.marketRefreshSeconds], [true, 3, 30, 3600, 60, 10, 1800]);
  assert.equal(c.ticketIndexFile.replace(/\\/g, "/"), "/w/state/tickets.json");
  assert.equal(buildConfig({ NOTIFY: "off" }, parseArgs([]), "/w").notify, false);
  assert.equal(buildConfig({}, parseArgs(["--no-mint"]), "/w").notify, false, "no mint crank, no notifications");
  assert.equal(buildConfig({ MINT_CRANK: "off" }, parseArgs([]), "/w").notify, false);
  assert.equal(buildConfig({ MINT_INTERVAL_SECONDS: "3600" }, parseArgs([]), "/w").mintIntervalSeconds, 3600);
  assert.throws(() => buildConfig({ TICKET_RECONCILE_SECONDS: "60" }, parseArgs([]), "/w"), /TICKET_RECONCILE_SECONDS=60 is below the minimum 600/);
  assert.throws(() => buildConfig({ NOTIFY: "maybe" }, parseArgs([]), "/w"), /NOTIFY=maybe must be on or off/);
  assert.throws(() => buildConfig({ NOTIFY_PER_MINUTE: "0" }, parseArgs([]), "/w"), /NOTIFY_PER_MINUTE/);
  const shown = describeConfig(c);
  assert.ok(/tickets\.json/.test(shown.ticketIndex) && /3600 s/.test(shown.ticketIndex), shown.ticketIndex);
  assert.ok(/from the feed and from POST \/notify \(3 a minute per address, 30 a minute in all\)/.test(shown.mintCrank), shown.mintCrank);
  assert.ok(/read again by address/.test(shown.feed), shown.feed);
  assert.ok(Object.values(shown).every((v) => /^[\x20-\x7e]*$/.test(String(v))), "plain ASCII");
  assert.equal(LARGEST_REFUSED_MS, 86_400_000);
});
