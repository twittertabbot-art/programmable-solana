// getTransactionsBySignature and the readers that use it, offline, against stand-in connections
// that answer a batch out of order, leave answers out, or refuse a batch because one entry is a
// transaction of an unsupported version (error -32015).
// Runs on the built bundle:
//   npm run build -w sdk && npm test -w sdk
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { HookpoolClient, EVENT_DISC, DIRECTION, getTransactionsBySignature, isUnreadableTransactionError, UNREADABLE_TRANSACTION_CODE } from "../dist/index.js";

class W {
  constructor(n) { this.b = new Uint8Array(n); this.o = 0; this.v = new DataView(this.b.buffer); }
  bytes(a) { this.b.set(a, this.o); this.o += a.length; return this; }
  key(k) { return this.bytes(k.toBytes()); }
  u8(x) { this.b[this.o++] = x; return this; }
  u16(x) { this.v.setUint16(this.o, x, true); this.o += 2; return this; }
  u64(x) { this.v.setBigUint64(this.o, BigInt(x), true); this.o += 8; return this; }
}
const key = () => Keypair.generate().publicKey;
const b64 = (u8) => Buffer.from(u8).toString("base64");
function swappedLog(pool, amountIn, slot) {
  const w = new W(8 + 32 + 32 + 1 + 8 * 5 + 2 + 8 * 3 + 1).bytes(EVENT_DISC.Swapped).key(pool).key(key()).u8(DIRECTION.BUY);
  for (const x of [amountIn, 1000n, 1n, 0n, 1n]) w.u64(x);
  w.u16(100).u64(10n).u64(20n).u64(slot).u8(0);
  return "Program data: " + b64(w.b);
}
const openedLog = (pool, slot) => "Program data: " + b64(new W(8 + 32 + 8 + 8 + 2 + 8).bytes(EVENT_DISC.CurveOpened).key(pool).u64(30_000_000_000n).u64(85_000_000_000n).u16(0).u64(slot).b);
const graduatedLog = (pool, slot) => { const w = new W(8 + 32 + 8 * 7).bytes(EVENT_DISC.Graduated).key(pool); for (const x of [85n, 85n, 9n, 7n, 2n, 0n, slot]) w.u64(x); return "Program data: " + b64(w.b); };
const txOf = (signature, logs = [], blockTime = 1_700_000_000) => ({ blockTime, meta: { err: null, logMessages: logs, innerInstructions: [] }, transaction: { signatures: [signature], message: { staticAccountKeys: [] } } });

/// The error web3.js throws for a JSON-RPC error answer (SolanaJSONRPCError carries `code`).
function rpcError(code, message) { const e = new Error(message); e.code = code; e.name = "SolanaJSONRPCError"; return e; }
const V1 = (s) => rpcError(-32015, `failed to get transaction: Transaction version (1) is not supported by the requesting client (${s})`);

/// A seeded shuffle, so the "random order" test is the same on every run.
function shuffled(list, seed) {
  const a = [...list];
  let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) % 2147483648; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/// A connection over `txs` (signature -> transaction). `order(answers, asked)` rearranges each
/// batched answer as an RPC provider might; `v1` names the signatures that answer -32015;
/// `missing` the ones the node does not have (null, and with `drop` left out of the answer).
function conn(txs, { order = (a) => a, v1 = new Set(), missing = new Set(), drop = false, failSingles = null } = {}) {
  const batches = [], singles = [];
  const answer = (s) => (missing.has(s) ? null : txs.get(s) ?? null);
  return {
    batches, singles,
    async getTransactions(list, cfg) {
      batches.push({ list: [...list], cfg });
      const firstBad = list.find((s) => v1.has(s));
      if (firstBad) throw V1(firstBad); // web3.js throws the whole batch for one error entry
      let answers = list.map(answer);
      if (drop) answers = answers.filter((t) => t !== null);
      return order(answers, list);
    },
    async getTransaction(s, cfg) {
      singles.push({ s, cfg });
      if (failSingles) throw failSingles;
      if (v1.has(s)) throw V1(s);
      return answer(s);
    },
    async getSignaturesForAddress(_a, o) {
      // newest first, as the node lists them
      let list = [...txs.keys()].reverse();
      if (o.before) list = list.slice(list.indexOf(o.before) + 1);
      if (o.until) { const i = list.indexOf(o.until); list = i >= 0 ? list.slice(0, i) : list; }
      return list.slice(0, o.limit).map((signature) => ({ signature, err: null, slot: 1, blockTime: 1 }));
    },
  };
}
const sigOf = (tx) => (tx ? tx.transaction.signatures[0] : null);

test("an answer in reverse order is paired by the transaction's own signature, not by position", async () => {
  const sigs = ["a", "b", "c", "d", "e", "f", "g"];
  const txs = new Map(sigs.map((s) => [s, txOf(s)]));
  const c = conn(txs, { order: (a) => [...a].reverse() });
  const r = await getTransactionsBySignature(c, sigs);
  assert.deepEqual(r.transactions.map(sigOf), sigs);
  assert.deepEqual(r.unreadable, []);
  assert.equal(c.batches.length, 1, "one batched request");
  assert.equal(c.singles.length, 0);
  assert.deepEqual(c.batches[0].cfg, { maxSupportedTransactionVersion: 0 }, "version 0 asked; the connection's own commitment");
});

test("an answer in random order with missing entries: each signature gets its own transaction or null", async () => {
  const sigs = Array.from({ length: 40 }, (_, i) => "s" + i);
  const txs = new Map(sigs.map((s) => [s, txOf(s)]));
  const missing = new Set(["s3", "s17", "s39"]);
  for (const drop of [false, true]) {
    const r = await getTransactionsBySignature(conn(txs, { order: (a) => shuffled(a, 7), missing, drop }), sigs);
    assert.deepEqual(r.transactions.map(sigOf), sigs.map((s) => (missing.has(s) ? null : s)), `drop=${drop}`);
    assert.deepEqual(r.unreadable, []);
  }
});

test("a signature asked twice is fetched once and answered at both places; batches follow perRequest, with the commitment passed on", async () => {
  const sigs = Array.from({ length: 25 }, (_, i) => "t" + i);
  const txs = new Map(sigs.map((s) => [s, txOf(s)]));
  const c = conn(txs, { order: (a) => shuffled(a, 3) });
  const asked = [...sigs, "t4", "t0"];
  const r = await getTransactionsBySignature(c, asked, { perRequest: 10, commitment: "confirmed" });
  assert.deepEqual(r.transactions.map(sigOf), asked);
  assert.deepEqual(c.batches.map((b) => b.list.length), [10, 10, 5]);
  assert.equal(c.batches[0].cfg.commitment, "confirmed");
  assert.equal(new Set(c.batches.flatMap((b) => b.list)).size, 25, "no signature asked twice");
});

test("a version 1 transaction in a batch: the batch is asked again one by one, the v1 is unreadable and the others are kept", async () => {
  const sigs = ["a", "b", "c", "d", "e"];
  const txs = new Map(sigs.map((s) => [s, txOf(s)]));
  const c = conn(txs, { order: (a) => [...a].reverse(), v1: new Set(["c"]) });
  const r = await getTransactionsBySignature(c, sigs, { perRequest: 3 });
  assert.deepEqual(r.transactions.map(sigOf), ["a", "b", null, "d", "e"]);
  assert.equal(r.unreadable.length, 1);
  assert.equal(r.unreadable[0].signature, "c");
  assert.equal(r.unreadable[0].code, UNREADABLE_TRANSACTION_CODE);
  assert.match(r.unreadable[0].message, /version \(1\)/);
  assert.deepEqual(c.singles.map((x) => x.s).sort(), ["a", "b", "c"], "only the batch that failed is asked one by one");
  assert.deepEqual(c.batches.map((b) => b.list), [["a", "b", "c"], ["d", "e"]]);
});

test("several version 1 transactions in one batch of ten: all listed in the order asked, the other eight kept", async () => {
  const sigs = Array.from({ length: 10 }, (_, i) => "v" + i);
  const txs = new Map(sigs.map((s) => [s, txOf(s)]));
  const r = await getTransactionsBySignature(conn(txs, { order: (a) => shuffled(a, 5), v1: new Set(["v7", "v2"]) }), sigs);
  assert.deepEqual(r.unreadable.map((u) => u.signature), ["v2", "v7"]);
  assert.deepEqual(r.transactions.map(sigOf), sigs.map((s) => (s === "v2" || s === "v7" ? null : s)));
});

test("any other error is thrown, not hidden as unreadable", async () => {
  const txs = new Map([["a", txOf("a")], ["b", txOf("b")]]);
  const down = new Error("fetch failed");
  const c = conn(txs, { v1: new Set(["b"]), failSingles: down });
  await assert.rejects(getTransactionsBySignature(c, ["a", "b"]), /fetch failed/);
  assert.equal(isUnreadableTransactionError(rpcError(-32015, "x")), true);
  assert.equal(isUnreadableTransactionError(new Error("failed to get transaction: Transaction version (1) is not supported by the requesting client")), true);
  assert.equal(isUnreadableTransactionError(Object.assign(new Error("Expected the value to satisfy a union of `type | type`"), { name: "StructError" })), true, "an answer web3.js cannot take apart");
  assert.equal(isUnreadableTransactionError(rpcError(-32005, "Node is behind")), false);
  assert.equal(isUnreadableTransactionError(new Error("429 Too Many Requests")), false);
  assert.equal(isUnreadableTransactionError(null), false);
});

test("no signatures: no request", async () => {
  const c = conn(new Map());
  const r = await getTransactionsBySignature(c, []);
  assert.deepEqual(r, { transactions: [], unreadable: [] });
  assert.equal(c.batches.length + c.singles.length, 0);
});

test("the SDK's readers pair events with the right signature when the RPC answers out of order", async () => {
  const pool = key();
  // oldest first: CurveOpened, three swaps (amountIn = 100 * n), Graduated, a v1 transaction, two swaps
  const plan = [
    ["o1", [openedLog(pool, 1n)]],
    ["w2", [swappedLog(pool, 200n, 2n)]],
    ["w3", [swappedLog(pool, 300n, 3n)]],
    ["w4", [swappedLog(pool, 400n, 4n)]],
    ["g5", [swappedLog(pool, 500n, 5n), graduatedLog(pool, 5n)]],
    ["x6", []],
    ["w7", [swappedLog(pool, 700n, 7n)]],
    ["w8", [swappedLog(pool, 800n, 8n)]],
  ];
  const txs = new Map(plan.map(([s, logs]) => [s, txOf(s, logs)]));
  const make = () => conn(txs, { order: (a) => shuffled(a, 11) });
  const amountOf = { w2: 200n, w3: 300n, w4: 400n, g5: 500n, w7: 700n, w8: 800n };

  const swaps = await new HookpoolClient(make()).recentSwaps(pool, 100);
  assert.deepEqual(swaps.map((e) => e.signature), ["w8", "w7", "g5", "w4", "w3", "w2"]);
  for (const e of swaps) assert.equal(e.amountIn, amountOf[e.signature], e.signature);

  const all = await new HookpoolClient(make()).allEvents(pool, 100);
  assert.deepEqual(all.map((e) => e.kind + ":" + e.signature), ["Swapped:w8", "Swapped:w7", "Swapped:g5", "Graduated:g5", "Swapped:w4", "Swapped:w3", "Swapped:w2", "CurveOpened:o1"]);

  const since = await new HookpoolClient(make()).recentEventsSince(pool, "g5", 50);
  assert.deepEqual(since.events.map((e) => e.signature), ["w8", "w7"]);
  assert.equal(since.unreadable, 0);

  const curve = await new HookpoolClient(make()).curveEventsFromStart(pool);
  assert.equal(curve.opened.signature, "o1");
  assert.equal(curve.graduated.signature, "g5");
  assert.equal(curve.unreadable, 0);

  // the same history with x6 a version 1 transaction: skipped and counted, nothing else lost
  const v1 = () => conn(txs, { order: (a) => [...a].reverse(), v1: new Set(["x6"]) });
  const since1 = await new HookpoolClient(v1()).recentEventsSince(pool, "g5", 50);
  assert.deepEqual(since1.events.map((e) => e.signature), ["w8", "w7"]);
  assert.equal(since1.unreadable, 1);
  assert.equal(since1.newest, "w8", "the newest signature moves past the unreadable one");
  const swaps1 = await new HookpoolClient(v1()).recentSwaps(pool, 100);
  assert.deepEqual(swaps1.map((e) => e.signature), ["w8", "w7", "g5", "w4", "w3", "w2"]);
  const curve1 = await new HookpoolClient(v1()).curveEventsFromStart(pool);
  assert.equal(curve1.opened.signature, "o1");
  assert.equal(curve1.graduated.signature, "g5");
  assert.equal(curve1.unreadable, 1, "x6 sits in the same chunk of 50");
});
