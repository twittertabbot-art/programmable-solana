// The trades feed (lib/feed.mjs) against a chain made of plain objects: transactions with the pool program's
// events in their logs, listed the way getSignaturesForAddress lists them (newest first, `until`, `before`,
// `limit`). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAMS, decodePool } from "../../sdk/dist/index.js";
import {
  TradesFeed, eventJson, txEvents, mergeEvents, pinCurve, planWalk, listNewSignatures, tradesFile, loadFeedState, lastTradeTimeOf, TRADES_KEEP, BACKFILL_LIMIT, POOL_NAME,
  fetchTransactions, eventKeys, tradersOf, firstSignature, isUnsupportedVersion, MAX_UNSERVED_PASSES, acquireFeedLock,
} from "../lib/feed.mjs";
import { swappedEventBytes, curveOpenedEventBytes, poolCreatedEventBytes, graduatedEventBytes, liquidityChangedEventBytes, poolBytes, BASE_MINT } from "./bytes.mjs";

const key = () => Keypair.generate().publicKey;
const PROGRAM = PROGRAMS.hookpool.toBase58();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "feed-test-"));
const data = (bytes) => `Program data: ${Buffer.from(bytes).toString("base64")}`;

/// A chain in memory. `add` lands one transaction in its own slot (or in `slot`), touching the pool program and
/// the given pools. `hidden` makes getTransaction answer null for a signature, as a lagging RPC does. `order`
/// decides the order of a batch's answers ("reverse", "shuffle", or in order), as an RPC that answers a batch in
/// any order does. `version1` holds signatures the RPC answers with error -32015 (a version 1 transaction):
/// web3.js then throws the whole batch away, and a single getTransaction of it throws that error.
class FakeChain {
  constructor() { this.slot = 1000; this.txs = []; this.bySig = new Map(); this.hidden = new Set(); this.version1 = new Set(); this.order = "in order"; this.calls = { sigs: [], txs: 0, batches: 0, singles: 0 }; this.n = 0; this.seed = 7; }
  add({ pools = [], events = [], err = null, slot = null, blockTime = null }) {
    const s = slot ?? ++this.slot;
    if (slot === null) this.slot = s;
    const signature = `sig${String(++this.n).padStart(6, "0")}`;
    const t = { signature, slot: s, err, blockTime: blockTime ?? 1_760_000_000 + s, logs: events.map(data), keys: new Set([PROGRAM, ...pools.map((p) => p.toBase58())]) };
    this.txs.push(t); this.bySig.set(signature, t);
    return signature;
  }
  answer(s) {
    const t = this.bySig.get(s);
    if (!t || this.hidden.has(s)) return null;
    return { slot: t.slot, blockTime: t.blockTime, meta: { err: t.err, logMessages: t.logs, innerInstructions: [] }, transaction: { signatures: [t.signature], message: { staticAccountKeys: [...t.keys].map((k) => new PublicKey(k)) } } };
  }
  rpcError(s) {
    const e = new Error(`failed to get transaction: Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1 (${s})`);
    e.name = "SolanaJSONRPCError"; e.code = -32015;
    return e;
  }
  random() { this.seed = (this.seed * 1103515245 + 12345) % 2147483648; return this.seed / 2147483648; }
  async getSignaturesForAddress(address, opts = {}) {
    const a = address.toBase58();
    this.calls.sigs.push({ address: a, ...opts });
    // `lagSlot`: a node of a load-balanced RPC that is behind: it lists nothing newer, and so does not know a cursor
    // read from a node ahead of it. `twice`: signatures it lists two times.
    let list = this.txs.filter((t) => t.keys.has(a) && (this.lagSlot === undefined || this.lagSlot === null || t.slot <= this.lagSlot)).slice().reverse();
    if (this.twice) list = list.flatMap((t) => (this.twice.has(t.signature) ? [t, t] : [t]));
    if (opts.before) { const i = list.findIndex((t) => t.signature === opts.before); list = i < 0 ? [] : list.slice(i + 1); }
    if (opts.until) { const i = list.findIndex((t) => t.signature === opts.until); if (i >= 0) list = list.slice(0, i); }
    return list.slice(0, opts.limit ?? 1000).map((t) => ({ signature: t.signature, slot: t.slot, err: t.err, blockTime: t.blockTime, memo: null, confirmationStatus: "confirmed" }));
  }
  async getTransactions(sigs) {
    this.calls.txs += sigs.length; this.calls.batches += 1;
    const v1 = sigs.find((s) => this.version1.has(s));
    if (v1) { const e = this.rpcError(v1); e.message = e.message.replace("failed to get transaction:", "failed to get transactions:"); throw e; }
    const out = sigs.map((s) => this.answer(s));
    if (this.order === "reverse") out.reverse();
    if (this.order === "shuffle") for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }
  async getTransaction(s) {
    this.calls.singles += 1;
    if (this.version1.has(s)) throw this.rpcError(s);
    return this.answer(s);
  }
  backfills() { return this.calls.sigs.filter((c) => c.address !== PROGRAM); }
}

const swap = (pool, slot, o = {}) => swappedEventBytes({ pool, slot: BigInt(slot), ...o });
function feedOf(chain, dir, o = {}) {
  return new TradesFeed({ connection: chain, dir: path.join(dir, "trades"), stateFile: path.join(dir, "feed.json"), fetchOpts: { pauseMs: 0 }, ...o });
}
const fileOf = (dir, pool) => JSON.parse(fs.readFileSync(path.join(dir, "trades", `${pool.toBase58()}.json`), "utf8"));
const decodedPool = (address, createdSlot) => decodePool(address, poolBytes({ createdSlot: BigInt(createdSlot) }));

test("an event as the file holds it: every bigint a string, every address base58, signature and block time added", () => {
  const pool = key(); const user = key();
  const tx = { blockTime: 1_760_000_123, meta: { err: null, logMessages: [data(swappedEventBytes({ pool, user, direction: 1, amountIn: 5n, amountOut: 4n, reserveBase: 77n, reserveQuote: 88n, slot: 1234n, byHook: true }))] }, transaction: { message: { staticAccountKeys: [] } } };
  const { byPool } = txEvents(tx, "sigA");
  const [e] = byPool.get(pool.toBase58());
  assert.deepEqual(Object.keys(e), ["kind", "signature", "blockTime", "pool", "user", "direction", "amountIn", "amountOut", "protocolFee", "hookFee", "lpFee", "feeBpsApplied", "reserveBase", "reserveQuote", "slot", "byHook"]);
  assert.deepEqual([e.kind, e.signature, e.blockTime, e.pool, e.user, e.direction, e.amountIn, e.amountOut, e.reserveBase, e.reserveQuote, e.slot, e.byHook, e.feeBpsApplied], ["Swapped", "sigA", 1_760_000_123, pool.toBase58(), user.toBase58(), 1, "5", "4", "77", "88", "1234", true, 100]);
  // CurveOpened and Graduated keep their own fields
  const c = eventJson({ kind: "CurveOpened", pool, virtualQuote: 30n, graduationTarget: 85n, graduationFeeBps: 50, slot: 9n }, "s", null);
  assert.deepEqual(c, { kind: "CurveOpened", signature: "s", blockTime: 0, pool: pool.toBase58(), virtualQuote: "30", graduationTarget: "85", graduationFeeBps: 50, slot: "9" });
});

test("which events a transaction gives: the three kinds by pool, the creation apart, nothing from a failed one", () => {
  const a = key(); const b = key();
  const tx = (logs, err = null) => ({ blockTime: 5, meta: { err, logMessages: logs }, transaction: { message: { staticAccountKeys: [] } } });
  const all = tx([poolCreatedEventBytes({ pool: a }), curveOpenedEventBytes({ pool: a }), swap(a, 1), liquidityChangedEventBytes({ pool: a }), graduatedEventBytes({ pool: a, slot: 1n }), swap(b, 1)].map(data));
  const got = txEvents(all, "x");
  assert.deepEqual(got.byPool.get(a.toBase58()).map((e) => e.kind), ["CurveOpened", "Swapped", "Graduated"]);
  assert.deepEqual(got.byPool.get(b.toBase58()).map((e) => e.kind), ["Swapped"]);
  assert.deepEqual([...got.created], [[a.toBase58(), 5]]);
  assert.equal(txEvents(tx([data(swap(a, 1))], { InstructionError: [0, "Custom"] }), "y").byPool.size, 0);
  assert.equal(txEvents(null, "z").byPool.size, 0);
});

test("merging keeps the newest first, never doubles a transaction, and keeps 300 at most", () => {
  const ev = (sig, slot) => ({ kind: "Swapped", signature: sig, slot: String(slot) });
  const old = [ev("c", 30), ev("b", 20), ev("a", 10)];
  // the feed's batch is newer: in front, even in the same slot
  assert.deepEqual(mergeEvents(old, [ev("e", 30), ev("d", 30)]).events.map((e) => e.signature), ["e", "d", "c", "b", "a"]);
  // a backfill's batch is older: behind within a slot, by slot otherwise, and what is there already is skipped
  assert.deepEqual(mergeEvents(old, [ev("c", 30), ev("z", 20), ev("y", 5)], { incomingNewer: false }).events.map((e) => e.signature), ["c", "b", "z", "a", "y"]);
  assert.equal(mergeEvents(old, [ev("a", 10)]).added, 0);
  const many = Array.from({ length: 350 }, (_, i) => ev(`s${i}`, 1000 - i));
  const capped = mergeEvents([], many);
  assert.equal(capped.events.length, TRADES_KEEP);
  assert.equal(capped.events[0].signature, "s0");
  assert.equal(capped.events[299].signature, "s299");
  // the curve's two events stay findable after they fall out of the list
  const pinned = pinCurve({ opened: null, graduated: null }, [{ kind: "CurveOpened", signature: "o" }, { kind: "Graduated", signature: "g" }]);
  assert.deepEqual([pinned.opened.signature, pinned.graduated.signature], ["o", "g"]);
  assert.equal(pinCurve(pinned, [{ kind: "CurveOpened", signature: "later" }]).opened.signature, "o");
  assert.equal(lastTradeTimeOf([{ kind: "Graduated", blockTime: 9 }, { kind: "Swapped", blockTime: 8 }]), 8);
});

test("paging: every signature until the cursor, page after page; more than the pages allow is a gap", async () => {
  const chain = new FakeChain();
  const pool = key();
  const cursor = chain.add({ pools: [pool] });
  for (let i = 0; i < 10; i++) chain.add({ pools: [pool] });
  const list = (o) => chain.getSignaturesForAddress(PROGRAMS.hookpool, o);
  const got = await listNewSignatures(list, { until: cursor, perPage: 3 });
  assert.equal(got.complete, true);
  assert.equal(got.sigs.length, 10);
  assert.equal(got.pages, 4, "3 + 3 + 3 + 1");
  assert.deepEqual(chain.calls.sigs.map((c) => [c.until, c.before ?? null, c.limit]), [[cursor, null, 3], [cursor, "sig000009", 3], [cursor, "sig000006", 3], [cursor, "sig000003", 3]]);
  assert.equal((await listNewSignatures(list, { until: cursor, perPage: 3, maxPages: 2 })).complete, false);
  // without a cursor: everything after a slot
  const since = await listNewSignatures(list, { stopSlot: chain.txs[5].slot, perPage: 3 });
  assert.deepEqual(since.sigs.map((s) => s.signature), chain.txs.slice(6).reverse().map((t) => t.signature));
  // the walk of a pass: oldest first, failed ones walked past unread, at most so many read
  const sigs = [{ signature: "d" }, { signature: "c", err: { x: 1 } }, { signature: "b" }, { signature: "a" }];
  const w = planWalk(sigs, 2);
  assert.deepEqual([w.walk.map((s) => s.signature), w.fetch.map((s) => s.signature), w.more], [["a", "b", "c"], ["a", "b"], true]);
});

test("the feed: one list of the program per pass, the new transactions batched, the events per pool, a restart goes on", async () => {
  const dir = tmpDir();
  const chain = new FakeChain();
  const [a, b] = [key(), key()];
  chain.add({ pools: [key()], events: [swap(key(), 1)] });   // history from before the feed
  let feed = feedOf(chain, dir, { perPage: 4 });
  const first = await feed.pass(chain.slot);
  assert.equal(first.first, true);
  assert.equal(feed.state.cursor, "sig000001");
  // two pools created while the feed runs, then seven trades on them, one of them failed: listed in three
  // pages, the eight good transactions read in one batch
  chain.add({ pools: [a], events: [poolCreatedEventBytes({ pool: a })] });
  chain.add({ pools: [b], events: [poolCreatedEventBytes({ pool: b })] });
  for (let i = 0; i < 4; i++) chain.add({ pools: [a], events: [swap(a, chain.slot + 1, { amountIn: BigInt(100 + i) })] });
  chain.add({ pools: [b], events: [swap(b, chain.slot + 1)], err: { InstructionError: [1, { Custom: 6008 }] } });
  chain.add({ pools: [b], events: [swap(b, chain.slot + 1)] });
  chain.add({ pools: [a, b], events: [swap(a, chain.slot + 1, { amountIn: 999n }), swap(b, chain.slot + 1)] });
  chain.calls.sigs.length = 0; chain.calls.txs = 0; chain.calls.batches = 0;
  const r = await feed.pass(chain.slot);
  assert.deepEqual([chain.calls.sigs.filter((c) => c.address === PROGRAM).length, chain.calls.batches, chain.calls.txs], [3, 1, 8]);
  assert.deepEqual([r.sigs, r.transactions, r.more, r.completeSlot], [9, 8, false, chain.slot]);
  assert.equal(chain.backfills().length, 0, "pools created while the feed runs are never backfilled");
  assert.equal(feed.state.cursor, chain.txs[chain.txs.length - 1].signature);
  const fa = fileOf(dir, a);
  assert.deepEqual(fa.events.map((e) => e.amountIn), ["999", "103", "102", "101", "100"], "newest first");
  assert.equal(fileOf(dir, b).events.length, 2, "the failed trade is not there");
  assert.equal(feed.info(a.toBase58()).lastTradeTime, chain.txs[chain.txs.length - 1].blockTime);
  // a pass with nothing new: one list, nothing read, nothing written
  chain.calls.sigs.length = 0; chain.calls.txs = 0;
  const idle = await feed.pass(chain.slot + 5);
  assert.deepEqual([chain.calls.sigs.length, chain.calls.txs, idle.transactions, idle.written, idle.completeSlot], [1, 0, 0, 0, chain.slot + 5]);
  // a restart: a new feed on the same files goes on after the cursor
  chain.add({ pools: [a], events: [swap(a, chain.slot + 1, { amountIn: 7n })] });
  feed = feedOf(chain, dir);
  await feed.pass(chain.slot);
  assert.deepEqual(fileOf(dir, a).events.map((e) => e.amountIn), ["7", "999", "103", "102", "101", "100"]);
  assert.equal(loadFeedState(path.join(dir, "feed.json")).transactions, 9);
  // the file is the contract's shape
  assert.deepEqual(Object.keys(fileOf(dir, a)), ["version", "pool", "updatedAt", "slot", "backfill", "curve", "events"]);
});

test("a pool that existed before the feed is backfilled once, a pool born under the feed never, and nothing is doubled", async () => {
  const dir = tmpDir();
  const chain = new FakeChain();
  const old = key(); const young = key();
  chain.add({ pools: [old], events: [poolCreatedEventBytes({ pool: old }), curveOpenedEventBytes({ pool: old, slot: 1001n })] });
  const created = chain.slot;
  for (let i = 0; i < 3; i++) chain.add({ pools: [old], events: [swap(old, chain.slot + 1, { amountIn: BigInt(i + 1) })] });
  const feed = feedOf(chain, dir);
  await feed.pass(chain.slot);
  // a trade lands between the feed's first pass and the backfill: both read it, the file holds it once
  chain.add({ pools: [old], events: [swap(old, chain.slot + 1, { amountIn: 50n })] });
  chain.add({ pools: [young], events: [poolCreatedEventBytes({ pool: young }), swap(young, chain.slot + 1)] });
  const pools = [decodedPool(old, created), decodedPool(young, chain.slot)];
  // before its backfill a pool has no file to serve
  assert.equal(fs.existsSync(path.join(dir, "trades", `${old.toBase58()}.json`)), false);
  const r = await feed.pass(chain.slot, pools);
  assert.deepEqual(r.backfilled.map((x) => [x.pool, x.transactions, x.reachedCreation]), [[old.toBase58(), 5, true]]);
  assert.deepEqual(chain.backfills().map((c) => [c.address, c.limit]), [[old.toBase58(), BACKFILL_LIMIT]]);
  const f = fileOf(dir, old);
  assert.deepEqual(f.events.map((e) => e.kind === "Swapped" ? e.amountIn : e.kind), ["50", "3", "2", "1", "CurveOpened"]);
  assert.deepEqual([f.backfill, f.curve.opened.kind], [{ transactions: 5, reachedCreation: true }, "CurveOpened"]);
  assert.equal(feed.info(old.toBase58()).createdTime, chain.bySig.get("sig000001").blockTime);
  assert.deepEqual(fileOf(dir, young).backfill, { transactions: 0, reachedCreation: true }, "born under the feed: its creation is in the feed");
  // later passes never backfill again, after a restart neither
  chain.calls.sigs.length = 0;
  await feed.pass(chain.slot, pools);
  await feedOf(chain, dir).pass(chain.slot, pools);
  assert.equal(chain.backfills().length, 0);
});

test("a backfill reads at most 200 transactions and says when it did not reach the creation", async () => {
  const dir = tmpDir();
  const chain = new FakeChain();
  const pool = key();
  chain.add({ pools: [pool], events: [poolCreatedEventBytes({ pool })] });
  const created = chain.slot;
  for (let i = 0; i < 230; i++) chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: BigInt(i) })] });
  const feed = feedOf(chain, dir);
  await feed.pass(chain.slot);
  const r = await feed.pass(chain.slot, [decodedPool(pool, created)]);
  assert.deepEqual(r.backfilled.map((x) => [x.transactions, x.reachedCreation]), [[200, false]]);
  const f = fileOf(dir, pool);
  assert.equal(f.events.length, 200);
  assert.equal(f.events[0].amountIn, "229");
  assert.equal(feed.info(pool.toBase58()).createdTime, null);
});

test("300 events at most per pool, the curve's events kept apart, a busy pass split, a lagging RPC waited for", async () => {
  const dir = tmpDir();
  const chain = new FakeChain();
  const pool = key();
  const feed = feedOf(chain, dir, { maxTxPerPass: 100 });
  await feed.pass(chain.slot);
  chain.add({ pools: [pool], events: [poolCreatedEventBytes({ pool }), curveOpenedEventBytes({ pool, slot: BigInt(chain.slot + 1) })] });
  for (let i = 0; i < 349; i++) chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: BigInt(i) })] });
  // 350 new transactions, 100 a pass: four passes, each says there is more until the last
  const mores = [];
  for (let n = 0; n < 4; n++) mores.push((await feed.pass(chain.slot)).more);
  assert.deepEqual(mores, [true, true, true, false]);
  const f = fileOf(dir, pool);
  assert.equal(f.events.length, 300);
  assert.equal(f.events[0].amountIn, "348");
  assert.equal(f.events[299].amountIn, "49");
  assert.equal(f.curve.opened.kind, "CurveOpened", "the opening is older than the 300 kept, and still there");
  // the RPC lists a transaction it cannot serve yet: the walk stops before it, the next pass reads it
  const s1 = chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: 1000n })] });
  const s2 = chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: 1001n })] });
  chain.hidden.add(s2);
  const r = await feed.pass(chain.slot);
  assert.deepEqual([r.transactions, r.more, feed.state.cursor], [1, true, s1]);
  chain.hidden.clear();
  await feed.pass(chain.slot);
  assert.deepEqual(fileOf(dir, pool).events.slice(0, 2).map((e) => e.amountIn), ["1001", "1000"]);
  assert.equal(fileOf(dir, pool).events.length, 300);
});

test("a gap (more new transactions than the pages of one pass): the feed starts again and backfills every pool", async () => {
  const dir = tmpDir();
  const chain = new FakeChain();
  const pool = key();
  chain.add({ pools: [pool], events: [poolCreatedEventBytes({ pool })] });
  const created = chain.slot;
  const feed = feedOf(chain, dir, { perPage: 5, maxPages: 2 });
  await feed.pass(chain.slot);
  await feed.pass(chain.slot, [decodedPool(pool, created)]);
  for (let i = 0; i < 12; i++) chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: BigInt(i) })] });
  const r = await feed.pass(chain.slot, [decodedPool(pool, created)]);
  assert.equal(r.gap, true);
  assert.equal(feed.state.gaps, 1);
  assert.equal(feed.state.cursor, chain.txs[chain.txs.length - 1].signature);
  // the backfill of the next pass fills the file again; the served file stayed meanwhile
  assert.ok(fs.existsSync(path.join(dir, "trades", `${pool.toBase58()}.json`)));
  await feed.pass(chain.slot, [decodedPool(pool, created)]);
  assert.equal(fileOf(dir, pool).events.length, 12);
});

test("file names: only addresses", () => {
  assert.ok(POOL_NAME.test(BASE_MINT.toBase58()));
  for (const bad of ["..", "../state", "a/b", "x".repeat(50), "0OIl" + "1".repeat(40)]) assert.equal(POOL_NAME.test(bad), false, bad);
  const shape = tradesFile({ pool: "p", updatedAt: "t", slot: 1, backfill: null, curve: null, events: [] });
  assert.deepEqual(shape, { version: 1, pool: "p", updatedAt: "t", slot: 1, backfill: { transactions: 0, reachedCreation: false }, curve: { opened: null, graduated: null }, events: [] });
});

// ---- round 6: answers paired by signature, version 1 transactions, doubles -------------------------------------

/// What each signature of the chain really carries for a pool: signature -> the amountIn of its Swapped event.
const truthOf = (chain, pool) => new Map(chain.txs.filter((t) => t.keys.has(pool.toBase58()) && !t.err).map((t) => [t.signature, t]));

test("a batch answered in any order: every answer is paired with its own signature, never by its place", async () => {
  // fetchTransactions alone: reverse, shuffled, a missing answer, an answer nobody asked for
  const chain = new FakeChain();
  const pool = key();
  const sigs = [];
  for (let i = 0; i < 12; i++) sigs.push(chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: BigInt(i) })] }));
  for (const order of ["in order", "reverse", "shuffle"]) {
    chain.order = order;
    chain.hidden = new Set([sigs[4]]);
    const got = await fetchTransactions(chain, sigs, { perRequest: 5, pauseMs: 0 });
    assert.equal(got.txs.size, 12, order);
    for (const s of sigs) {
      const tx = got.txs.get(s);
      if (s === sigs[4]) { assert.equal(tx, null, `${order}: a missing answer is null`); continue; }
      assert.equal(firstSignature(tx), s, `${order}: ${s}`);
    }
    assert.equal(got.unreadable.size, 0);
  }
  chain.hidden = new Set();
  // an answer for a signature that was not asked is dropped; a batch with fewer answers than asked leaves nulls
  const odd = { async getTransactions(list) { return [chain.answer(sigs[11]), chain.answer(list[0])]; } };
  const few = await fetchTransactions(odd, sigs.slice(0, 3), { pauseMs: 0 });
  assert.deepEqual(sigs.slice(0, 3).map((s) => firstSignature(few.txs.get(s))), [sigs[0], null, null]);

  // the whole feed on a shuffling RPC: each event carries the signature of the transaction it came from
  const dir = tmpDir();
  const c2 = new FakeChain();
  c2.order = "shuffle";
  const [a, b] = [key(), key()];
  const feed = feedOf(c2, dir);
  await feed.pass(c2.slot);
  c2.add({ pools: [a], events: [poolCreatedEventBytes({ pool: a })] });
  c2.add({ pools: [b], events: [poolCreatedEventBytes({ pool: b })] });
  for (let i = 0; i < 30; i++) {
    const p = i % 3 === 0 ? b : a;
    c2.add({ pools: [p], events: [swap(p, c2.slot + 1, { amountIn: BigInt(1000 + i) })] });
  }
  await feed.pass(c2.slot);
  for (const p of [a, b]) {
    const truth = truthOf(c2, p);
    const f = fileOf(dir, p);
    assert.equal(f.events.length, p === a ? 20 : 10);
    for (const e of f.events) {
      const t = truth.get(e.signature);
      assert.ok(t, `${e.signature} is a transaction of this pool`);
      assert.equal(e.slot, String(t.slot), "the event's slot is its transaction's");
      assert.equal(e.blockTime, t.blockTime, "and so is its block time");
    }
    assert.equal(new Set(f.events.map((e) => e.signature)).size, f.events.length, "no signature twice");
  }
  // the backfill too: a pool from before the feed, read on the shuffling RPC
  const d3 = tmpDir();
  const c3 = new FakeChain();
  const old = key();
  c3.add({ pools: [old], events: [poolCreatedEventBytes({ pool: old })] });
  const created = c3.slot;
  for (let i = 0; i < 25; i++) c3.add({ pools: [old], events: [swap(old, c3.slot + 1, { amountIn: BigInt(i) })] });
  c3.order = "reverse";
  const f3 = feedOf(c3, d3, { fetchOpts: { pauseMs: 0, perRequest: 7 } });
  await f3.pass(c3.slot);
  await f3.pass(c3.slot, [decodedPool(old, created)]);
  const truth3 = truthOf(c3, old);
  const file3 = fileOf(d3, old);
  assert.equal(file3.events.length, 25);
  for (const e of file3.events) assert.equal(e.slot, String(truth3.get(e.signature).slot));
  assert.deepEqual(file3.events.map((e) => e.amountIn), Array.from({ length: 25 }, (_, i) => String(24 - i)), "newest first, each with its own amount");
});

test("a version 1 transaction: the batch is read one at a time, that one is skipped and counted, the cursor moves past it", async () => {
  const dir = tmpDir();
  const chain = new FakeChain();
  const pool = key();
  const feed = feedOf(chain, dir);
  await feed.pass(chain.slot);
  chain.add({ pools: [pool], events: [poolCreatedEventBytes({ pool })] });
  const sigs = [];
  for (let i = 0; i < 6; i++) sigs.push(chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: BigInt(10 + i) })] }));
  chain.version1.add(sigs[2]);
  assert.equal(isUnsupportedVersion(chain.rpcError(sigs[2])), true);
  chain.calls.batches = 0; chain.calls.singles = 0;
  const r = await feed.pass(chain.slot);
  assert.deepEqual([r.transactions, r.more, feed.state.cursor], [6, false, sigs[5]], "the creation and five trades read, nothing left behind");
  assert.deepEqual([chain.calls.batches, chain.calls.singles], [1, 7], "one batch thrown away by web3.js, then one request per transaction");
  assert.deepEqual(fileOf(dir, pool).events.map((e) => e.amountIn), ["15", "14", "13", "11", "10"]);
  assert.equal(feed.state.unreadable, 1);
  assert.equal(feed.state.unreadableLast[0].signature, sigs[2]);
  assert.match(feed.state.unreadableLast[0].reason, /version 1/);
  // it survives a restart, and the next pass does not read it again
  const again = feedOf(chain, dir);
  assert.equal(again.state.unreadable, 1);
  chain.calls.singles = 0; chain.calls.batches = 0;
  await again.pass(chain.slot);
  assert.deepEqual([chain.calls.batches, chain.calls.singles], [0, 0]);
  // a backfill that meets one: skipped the same way, counted once
  const d2 = tmpDir();
  const c2 = new FakeChain();
  const old = key();
  c2.add({ pools: [old], events: [poolCreatedEventBytes({ pool: old })] });
  const created = c2.slot;
  const s1 = c2.add({ pools: [old], events: [swap(old, c2.slot + 1, { amountIn: 1n })] });
  c2.add({ pools: [old], events: [swap(old, c2.slot + 1, { amountIn: 2n })] });
  c2.version1.add(s1);
  const f2 = feedOf(c2, d2);
  await f2.pass(c2.slot);
  await f2.pass(c2.slot, [decodedPool(old, created)]);
  assert.deepEqual(fileOf(d2, old).events.map((e) => e.amountIn), ["2"]);
  assert.deepEqual([f2.state.unreadable, f2.state.unreadableLast.map((u) => u.signature)], [1, [s1]]);
  // an error of the RPC itself is no answer error: the pass fails, as before, and nothing moves
  const down = new FakeChain();
  const f4 = feedOf(down, tmpDir());
  await f4.pass(down.slot);
  down.add({ pools: [pool], events: [swap(pool, down.slot + 1)] });
  down.getTransactions = async () => { throw new Error("429 Too Many Requests: rate limited"); };
  const cursor = f4.state.cursor;
  await assert.rejects(f4.pass(down.slot), /429/);
  assert.equal(f4.state.cursor, cursor);
});

test("what a failed batch means: a node that refuses batches, an answer web3.js cannot read, the RPC itself down", async () => {
  const chain = new FakeChain();
  const pool = key();
  const sigs = [];
  for (let i = 0; i < 4; i++) sigs.push(chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: BigInt(i) })] }));
  // a node that refuses batches answers one error object, and web3.js fails on it: read one at a time, all there
  const noBatch = { getTransactions: async () => { const r = { error: "batch requests are not allowed" }; return r.map((x) => x); }, getTransaction: async (s) => chain.answer(s) };
  const a = await fetchTransactions(noBatch, sigs, { pauseMs: 0 });
  assert.deepEqual(sigs.map((s) => firstSignature(a.txs.get(s))), sigs);
  // one answer web3.js cannot read (a parse error, not the network): unreadable; another JSON-RPC error: null
  const odd = {
    getTransactions: async () => { const e = new Error("failed to get transactions: one entry"); e.name = "SolanaJSONRPCError"; e.code = -32603; throw e; },
    getTransaction: async (s) => {
      if (s === sigs[1]) { const e = new Error("Expected the value to satisfy a union of `type | null`"); e.name = "StructError"; throw e; }
      if (s === sigs[2]) throw new TypeError("Cannot read properties of undefined (reading 'header')");
      if (s === sigs[3]) { const e = new Error("failed to get transaction: Node is behind by 12 slots"); e.name = "SolanaJSONRPCError"; e.code = -32005; throw e; }
      return chain.answer(s);
    },
  };
  const b = await fetchTransactions(odd, sigs, { pauseMs: 0 });
  assert.equal(firstSignature(b.txs.get(sigs[0])), sigs[0]);
  assert.deepEqual([...b.unreadable.keys()].sort(), [sigs[1], sigs[2]].sort());
  assert.equal(b.txs.get(sigs[3]), null, "a node behind: not served this time");
  // the RPC itself: thrown, from the batch and from a single alike
  for (const down of [
    { getTransactions: async () => { throw new TypeError("fetch failed"); } },
    { getTransactions: async () => { throw new Error('503 Service Unavailable: {"error":"maintenance"}'); } },
    { getTransactions: async () => { const e = new Error("x"); e.name = "SolanaJSONRPCError"; e.code = -32015; throw e; }, getTransaction: async () => { throw new Error("The operation was aborted due to timeout"); } },
  ]) await assert.rejects(fetchTransactions(down, sigs, { pauseMs: 0 }));
});

test("a transaction the RPC lists and never serves stops the walk for some passes, then it is skipped", async () => {
  const dir = tmpDir();
  const chain = new FakeChain();
  const pool = key();
  const feed = feedOf(chain, dir, { maxUnservedPasses: 3 });
  await feed.pass(chain.slot);
  const c = chain.add({ pools: [pool], events: [poolCreatedEventBytes({ pool })] });
  const s1 = chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: 1n })] });
  const s2 = chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: 2n })] });
  chain.hidden.add(s1);
  const cursors = [];
  for (let n = 0; n < 3; n++) { await feed.pass(chain.slot); cursors.push(feed.state.cursor); }
  assert.deepEqual(cursors, [c, c, s2], "two passes wait for it, the third walks past it");
  assert.deepEqual(fileOf(dir, pool).events.map((e) => e.amountIn), ["2"]);
  assert.equal(feed.state.unreadable, 1);
  assert.match(feed.state.unreadableLast[0].reason, /did not serve it in 3 passes/);
  assert.equal(MAX_UNSERVED_PASSES, 30);
});

test("doubles: an event is kept once by (signature, kind, index in the transaction), in the list kept and the one merged", () => {
  const ev = (sig, slot, o = {}) => ({ kind: "Swapped", signature: sig, blockTime: 1, slot: String(slot), amountIn: "1", ...o });
  // one transaction with two Swapped events of the pool (a trade and the hook's own buy) keeps both
  const two = [ev("t", 9, { amountIn: "5" }), ev("t", 9, { amountIn: "3", byHook: true })];
  assert.deepEqual(eventKeys(two), ["t|Swapped|0", "t|Swapped|1"]);
  assert.equal(mergeEvents([], two).events.length, 2);
  // the same transaction merged again adds nothing, the feed and a backfill alike
  assert.equal(mergeEvents(two, two).added, 0);
  assert.equal(mergeEvents(two, two, { incomingNewer: false }).added, 0);
  // the incoming list holds the same transaction twice (an RPC that lists it twice): once
  const m = mergeEvents([], [ev("a", 2), ev("a", 2), ev("b", 1)]);
  assert.deepEqual([m.events.map((e) => e.signature), m.added], [["a", "b"], 2]);
  // a list written by an older watcher with an exact double: the double goes at the next merge
  const legacy = [ev("c", 3), ev("c", 3), ev("b", 1)];
  const cleaned = mergeEvents(legacy, [ev("d", 4)]);
  assert.deepEqual([cleaned.events.map((e) => e.signature), cleaned.dropped], [["d", "c", "b"], 1]);
  assert.deepEqual(mergeEvents(legacy, []).events.map((e) => e.signature), ["c", "b"]);
  // a transaction partly in the list (its second event fell off the cap) gets only the missing one back
  const part = mergeEvents([two[0]], two, { incomingNewer: false });
  assert.deepEqual([part.added, part.events.map((e) => e.amountIn)], [1, ["5", "3"]]);
});

test("an RPC node that does not know the cursor lists old signatures again: nothing is read twice, no false gap", async () => {
  const dir = tmpDir();
  const chain = new FakeChain();
  const pool = key();
  chain.add({ pools: [pool], events: [poolCreatedEventBytes({ pool })] });
  const created = chain.slot;
  // three pages of three a pass: the program's history below (eleven transactions) is more than one pass may list
  const feed = feedOf(chain, dir, { perPage: 3, maxPages: 3 });
  await feed.pass(chain.slot);
  await feed.pass(chain.slot, [decodedPool(pool, created)]);
  for (let i = 0; i < 10; i++) {
    chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: BigInt(i) })] });
    if (i % 3 === 2) await feed.pass(chain.slot);
  }
  await feed.pass(chain.slot);
  const before = { transactions: feed.state.transactions, cursor: feed.state.cursor, file: JSON.stringify(fileOf(dir, pool).events) };
  assert.equal(before.transactions, 10);
  // the next pass meets a node two transactions behind: it does not know the cursor and lists from its own newest
  // down, nine and more old signatures. Read as new, that was a false gap (every pool backfilled again) or, with
  // fewer, transactions read and counted twice.
  for (let i = 0; i < 6; i++) chain.add({ pools: [pool], events: [swap(pool, chain.slot + 1, { amountIn: BigInt(100 + i) })] });
  chain.lagSlot = chain.txs[chain.txs.length - 9].slot;
  chain.calls.txs = 0;
  const r = await feed.pass(chain.slot);
  assert.deepEqual([r.transactions, r.gap, chain.calls.txs, feed.state.gaps], [0, false, 0, 0], "nothing new from that node, nothing read, no gap");
  assert.equal(feed.state.cursor, before.cursor);
  assert.equal(r.completeSlot, feed.state.cursorSlot, "complete up to the cursor only, not up to the slot of the pass");
  assert.ok(r.completeSlot < chain.slot);
  assert.equal(JSON.stringify(fileOf(dir, pool).events), before.file);
  // the next node is current: the six new ones, read once; one it lists twice is read once
  chain.lagSlot = null;
  chain.twice = new Set([chain.txs[chain.txs.length - 2].signature]);
  const r2 = await feed.pass(chain.slot);
  assert.deepEqual([r2.transactions, r2.gap], [6, false]);
  assert.equal(feed.state.transactions, 16, "as many transactions counted as the program has had since the feed started");
  const f = fileOf(dir, pool);
  assert.equal(f.events.length, 16);
  assert.equal(new Set(f.events.map((e) => e.signature)).size, 16);
});

test("the traders of a pool, from its trades file: newest first, once each, never the hook's own buys", () => {
  const dir = tmpDir();
  const pool = key();
  const [u1, u2, hookUser] = [key(), key(), key()];
  assert.deepEqual(tradersOf(dir, pool), { found: false, traders: [] });
  const ev = (user, o = {}) => ({ kind: "Swapped", signature: "s", blockTime: 1, pool: pool.toBase58(), user: user.toBase58(), direction: 0, slot: "1", byHook: false, ...o });
  const events = [ev(u2), ev(hookUser, { byHook: true }), { kind: "Graduated", signature: "g", slot: "1" }, ev(u1, { direction: 1 }), ev(u2)];
  fs.mkdirSync(path.join(dir, "part"), { recursive: true });
  fs.writeFileSync(path.join(dir, "part", `${pool.toBase58()}.json`), JSON.stringify(tradesFile({ pool: pool.toBase58(), updatedAt: "t", slot: 1, backfill: null, curve: null, events })));
  const got = tradersOf(dir, pool);
  assert.equal(got.found, true);
  assert.deepEqual(got.traders.map((k) => k.toBase58()), [u2.toBase58(), u1.toBase58()]);
  assert.equal(tradersOf(dir, pool, { max: 1 }).traders.length, 1);
  assert.deepEqual(tradersOf(dir, "../state"), { found: false, traders: [] });
});

test("one feed per state file: a second watcher on the same files runs without it; a lock of a process gone is taken over", () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, "state", "feed.json");
  const mine = acquireFeedLock(stateFile);
  assert.equal(mine.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(`${stateFile}.lock`, "utf8")).pid, process.pid);
  assert.equal(acquireFeedLock(stateFile).ok, true, "the same process may take it again");
  // another process that runs (this test's parent) holds it: refused
  fs.writeFileSync(`${stateFile}.lock`, JSON.stringify({ pid: process.ppid, since: "2026-10-21T00:00:00.000Z" }));
  const second = acquireFeedLock(stateFile);
  assert.deepEqual([second.ok, second.pid, second.since], [false, process.ppid, "2026-10-21T00:00:00.000Z"]);
  second.release();
  assert.ok(fs.existsSync(`${stateFile}.lock`), "a refused one removes nothing");
  // a process that is gone: taken over, and released at the end
  fs.writeFileSync(`${stateFile}.lock`, JSON.stringify({ pid: 2_000_000_000 }));
  const third = acquireFeedLock(stateFile);
  assert.equal(third.ok, true);
  third.release();
  assert.equal(fs.existsSync(`${stateFile}.lock`), false);
});
