// The SDK's cheap reads, offline, against a stand-in connection that counts its calls:
// poolView (one read for a page), walletBalances, recentEventsSince (only what is new),
// curveEventsFromStart (from the first transaction forward), and the JSON shape of events.
// Runs on the built bundle:
//   npm run build -w sdk && npm test -w sdk
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  HookpoolClient, ACCOUNT_DISC, EVENT_DISC, NATIVE_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, CURVE_OPEN, DIRECTION, PROGRAMS, pda,
  decodePool, eventToJson, eventFromJson, walletKeys, walletFromAccounts, hookInfoFromAccounts, eventsFromLogs,
} from "../dist/index.js";

// ---- account bytes, in the layouts the decoders read ------------------------------------------------
class W {
  constructor(n) { this.b = new Uint8Array(n); this.o = 0; this.v = new DataView(this.b.buffer); }
  bytes(a) { this.b.set(a, this.o); this.o += a.length; return this; }
  key(k) { return this.bytes(k.toBytes()); }
  u8(x) { this.b[this.o++] = x; return this; }
  u16(x) { this.v.setUint16(this.o, x, true); this.o += 2; return this; }
  u32(x) { this.v.setUint32(this.o, x, true); this.o += 4; return this; }
  u64(x) { this.v.setBigUint64(this.o, BigInt(x), true); this.o += 8; return this; }
}
const key = () => Keypair.generate().publicKey;
function poolBytes(p) {
  const w = new W(528).bytes(ACCOUNT_DISC.Pool).u8(255);
  for (const k of [p.baseMint, p.quoteMint, p.baseVault, p.quoteVault, p.lpMint, p.lpLock, p.baseTokenProgram, p.quoteTokenProgram]) w.key(k);
  w.u16(p.lpFeeBps).key(p.hookProgram).u32(p.hookFlags).key(p.hookExtraMetas).key(p.hookQuoteTreasury).u8(p.hookKind);
  for (const x of [p.reserveBase, p.reserveQuote, 0n, 0n, 0n, p.volumeQuoteTotal, p.swapCount, p.createdSlot]) w.u64(x);
  w.key(p.creator).u64(0n).key(p.creator).u64(p.virtualQuote).u64(p.graduationTarget).u16(0).u8(p.curveState);
  return w.b;
}
const mintBytes = (supply, decimals) => new W(82).u32(0).bytes(new Uint8Array(32)).u64(supply).u8(decimals).u8(1).u32(0).bytes(new Uint8Array(32)).b;
const tokenBytes = (amount) => { const w = new W(165); w.o = 64; w.u64(amount); return w.b; };
const acct = (data, owner = TOKEN_PROGRAM, lamports = 2_039_280) => ({ data: Buffer.from(data), owner, lamports, executable: false });

function aPool(overrides = {}) {
  const p = {
    address: key(), baseMint: key(), quoteMint: NATIVE_MINT, baseVault: key(), quoteVault: key(), lpMint: key(), lpLock: key(),
    baseTokenProgram: TOKEN_PROGRAM, quoteTokenProgram: TOKEN_PROGRAM, lpFeeBps: 100, hookProgram: SYSTEM_PROGRAM, hookFlags: 0,
    hookExtraMetas: SYSTEM_PROGRAM, hookQuoteTreasury: SYSTEM_PROGRAM, hookKind: 0, reserveBase: 900_000_000_000_000n, reserveQuote: 3_000_000_000n,
    volumeQuoteTotal: 5_000_000_000n, swapCount: 7n, createdSlot: 1234n, creator: key(), virtualQuote: 30_000_000_000n, graduationTarget: 85_000_000_000n, curveState: CURVE_OPEN,
    ...overrides,
  };
  return decodePool(p.address, poolBytes(p));
}

/// A connection that answers from a map of accounts and counts every call by method.
function standIn(accounts, slot = 4242) {
  const calls = [];
  const look = (k) => accounts.get(k.toBase58()) ?? null;
  return {
    calls,
    count: (m) => calls.filter((c) => c === m).length,
    async getMultipleAccountsInfo(keys) { calls.push("getMultipleAccounts"); return keys.map(look); },
    async getMultipleAccountsInfoAndContext(keys) { calls.push("getMultipleAccounts"); return { context: { slot }, value: keys.map(look) }; },
    async getAccountInfo(k) { calls.push("getAccountInfo"); return look(k); },
    async getSlot() { calls.push("getSlot"); return slot; },
  };
}

test("poolView of a pool read before is ONE getMultipleAccounts: pool, mint, LP, the wallet's balances, and the slot of the read", async () => {
  const pool = aPool();
  const owner = key();
  const [, baseAta, wsolAta, lpAta] = walletKeys(owner, pool);
  const accounts = new Map([
    [pool.address.toBase58(), acct(poolBytes({ ...pool, reserveQuote: 3_500_000_000n, swapCount: 8n }), PROGRAMS.hookpool)],
    [pool.baseMint.toBase58(), acct(mintBytes(1_000_000_000_000_000n, 6))],
    [pool.lpMint.toBase58(), acct(mintBytes(5_000_000n, 6))],
    [pool.lpLock.toBase58(), acct(tokenBytes(5_000_000n))],
    [owner.toBase58(), acct(new Uint8Array(0), SYSTEM_PROGRAM, 7_000_000_000)],
    [baseAta.toBase58(), acct(tokenBytes(123_456n))],
    [lpAta.toBase58(), acct(tokenBytes(0n))],
  ]);
  const conn = standIn(accounts, 9001);
  const v = await new HookpoolClient(conn).poolView(pool, { wallet: owner });
  assert.deepEqual(conn.calls, ["getMultipleAccounts"]);
  assert.equal(v.slot, 9001n);
  assert.equal(v.pool.reserveQuote, 3_500_000_000n, "the pool is the one of this read, not the one passed in");
  assert.equal(v.pool.swapCount, 8n);
  assert.equal(v.mint.supply, 1_000_000_000_000_000n);
  assert.equal(v.mint.decimals, 6);
  assert.equal(v.quoteMint, null, "SOL's mint is not read");
  assert.deepEqual(v.lp, { supply: 5_000_000n, locked: 5_000_000n });
  assert.equal(v.hook, null); assert.equal(v.treasury, null); assert.equal(v.rules, null); assert.equal(v.buyback, null);
  assert.deepEqual(v.wallet, { owner, sol: 7_000_000_000n, base: 123_456n, quote: 0n, wsol: null, lp: 0n });
  assert.ok(!accounts.has(wsolAta.toBase58()));
});

test("poolView of an address is two reads: the pool (with the platform) first, then everything of the same slot", async () => {
  const pool = aPool();
  const accounts = new Map([
    [pool.address.toBase58(), acct(poolBytes(pool), PROGRAMS.hookpool)],
    [pool.baseMint.toBase58(), acct(mintBytes(1_000_000_000_000_000n, 6))],
  ]);
  const conn = standIn(accounts);
  const v = await new HookpoolClient(conn).poolView(pool.address, { metadata: true, launch: true });
  assert.deepEqual(conn.calls, ["getMultipleAccounts", "getMultipleAccounts"]);
  assert.equal(v.metadata, null); assert.equal(v.launch, null); assert.equal(v.lp, null);
  assert.equal(await new HookpoolClient(standIn(new Map())).poolView(key()), null, "no pool, no view");
});

test("walletBalances: wrapped SOL is null without an account and its amount with one; a pool of another quote token counts that token", async () => {
  const pool = aPool();
  const owner = key();
  const ks = walletKeys(owner, pool);
  assert.equal(ks.length, 4);
  assert.ok(ks[2].equals(pda.ata(owner, NATIVE_MINT)));
  assert.equal(walletFromAccounts(owner, pool, [null, null, acct(tokenBytes(42n)), null]).wsol, 42n);
  assert.equal(walletFromAccounts(owner, pool, [null, null, null, null]).wsol, null);
  const usdc = aPool({ quoteMint: key() });
  const b = walletFromAccounts(owner, usdc, [acct(new Uint8Array(0), SYSTEM_PROGRAM, 5), acct(tokenBytes(1n)), acct(tokenBytes(77n)), acct(tokenBytes(3n))]);
  assert.deepEqual([b.sol, b.base, b.quote, b.wsol, b.lp], [5n, 1n, 77n, null, 3n]);
  const conn = standIn(new Map());
  await new HookpoolClient(conn).walletBalances(owner, pool);
  assert.deepEqual(conn.calls, ["getMultipleAccounts"]);
});

test("hookInfoFromAccounts: no hook is null; without the program data the upgrade authority is unknown", () => {
  assert.equal(hookInfoFromAccounts(aPool(), null, undefined, null), null);
  const hooked = aPool({ hookProgram: PROGRAMS.hook_tax, hookKind: 2, hookFlags: 3 });
  const info = hookInfoFromAccounts(hooked, null, undefined, null);
  assert.equal(info.template, "tax"); assert.equal(info.upgradeAuthority, "unknown"); assert.equal(info.manifest, null);
});

// ---- history -------------------------------------------------------------------------------------------
const b64 = (u8) => Buffer.from(u8).toString("base64");
function swappedLog(pool, amountIn, slot) {
  const w = new W(8 + 32 + 32 + 1 + 8 * 5 + 2 + 8 * 3 + 1).bytes(EVENT_DISC.Swapped).key(pool).key(key()).u8(DIRECTION.BUY);
  for (const x of [amountIn, 1000n, 1n, 0n, 1n]) w.u64(x);
  w.u16(100).u64(10n).u64(20n).u64(slot).u8(0);
  return "Program data: " + b64(w.b);
}
const openedLog = (pool, slot) => "Program data: " + b64(new W(8 + 32 + 8 + 8 + 2 + 8).bytes(EVENT_DISC.CurveOpened).key(pool).u64(30_000_000_000n).u64(85_000_000_000n).u16(0).u64(slot).b);
const graduatedLog = (pool, slot) => { const w = new W(8 + 32 + 8 * 7).bytes(EVENT_DISC.Graduated).key(pool); for (const x of [85n, 85n, 9n, 7n, 2n, 0n, slot]) w.u64(x); return "Program data: " + b64(w.b); };
const txOf = (logs, err = null, signature = "none") => ({ blockTime: 1_700_000_000, meta: { err, logMessages: logs, innerInstructions: [] }, transaction: { signatures: [signature], message: { staticAccountKeys: [] } } });

/// A connection with a history: `sigs` newest first, each { signature, err, logs }.
function historyConn(sigs) {
  const calls = [], asked = [];
  return {
    calls, asked,
    async getSignaturesForAddress(_a, o) {
      calls.push("getSignaturesForAddress");
      let list = sigs;
      if (o.before) list = list.slice(list.findIndex((s) => s.signature === o.before) + 1);
      if (o.until) { const i = list.findIndex((s) => s.signature === o.until); list = i >= 0 ? list.slice(0, i) : list; }
      return list.slice(0, o.limit).map((s) => ({ signature: s.signature, err: s.err, slot: 1, blockTime: 1 }));
    },
    async getTransactions(list) { calls.push(...list.map(() => "getTransaction")); asked.push(...list); return list.map((s) => { const x = sigs.find((y) => y.signature === s); return txOf(x.logs, x.err, s); }); },
  };
}

test("recentEventsSince reads only the transactions newer than the last signature seen, and none that failed", async () => {
  const pool = key();
  const sigs = [
    { signature: "s5", err: null, logs: [swappedLog(pool, 500n, 15n)] },
    { signature: "s4", err: { InstructionError: [0, "x"] }, logs: [] },
    { signature: "s3", err: null, logs: [swappedLog(pool, 300n, 13n)] },
    { signature: "s2", err: null, logs: [swappedLog(pool, 200n, 12n)] },
    { signature: "s1", err: null, logs: [openedLog(pool, 11n)] },
  ];
  const conn = historyConn(sigs);
  const client = new HookpoolClient(conn);
  const first = await client.recentEventsSince(pool, null, 50);
  assert.equal(first.newest, "s5"); assert.equal(first.more, false); assert.equal(first.transactions, 4);
  assert.deepEqual(first.events.map((e) => e.kind + ":" + e.signature), ["Swapped:s5", "Swapped:s3", "Swapped:s2", "CurveOpened:s1"]);
  assert.ok(!conn.asked.includes("s4"), "a failed transaction is not fetched");
  conn.calls.length = 0; conn.asked.length = 0;
  const later = await client.recentEventsSince(pool, "s3", 50);
  assert.deepEqual(conn.asked, ["s5"], "only the new transaction that did not fail");
  assert.deepEqual(later.events.map((e) => e.amountIn), [500n]);
  conn.calls.length = 0;
  const none = await client.recentEventsSince(pool, "s5", 50);
  assert.deepEqual(conn.calls, ["getSignaturesForAddress"], "nothing new: one call and no transaction");
  assert.equal(none.newest, "s5"); assert.equal(none.events.length, 0);
  assert.equal((await client.recentEventsSince(pool, null, 2)).more, true, "a full page says more may be missing");
});

test("curveEventsFromStart lists the signatures back to the creation and reads from the first transaction forward until both events are found", async () => {
  const pool = key();
  // 1,300 transactions: CurveOpened in the first, Graduated in the 120th, then trades
  const sigs = [];
  for (let i = 1300; i >= 1; i--) sigs.push({ signature: "t" + i, err: null, logs: i === 1 ? [openedLog(pool, 1n)] : i === 120 ? [swappedLog(pool, 9n, 120n), graduatedLog(pool, 120n)] : [swappedLog(pool, 1n, BigInt(i))] });
  const conn = historyConn(sigs);
  const r = await new HookpoolClient(conn).curveEventsFromStart(pool);
  assert.equal(conn.calls.filter((c) => c === "getSignaturesForAddress").length, 2, "two pages of signatures");
  assert.equal(r.reachedCreation, true);
  assert.equal(r.opened.signature, "t1"); assert.equal(r.graduated.signature, "t120"); assert.equal(r.graduated.slot, 120n);
  assert.equal(r.transactions, 150, "three chunks of 50 from the oldest, then it stops");
  const capped = await new HookpoolClient(historyConn(sigs)).curveEventsFromStart(pool, { maxTransactions: 60 });
  assert.equal(capped.graduated, null); assert.equal(capped.transactions, 60);
});

test("eventToJson and eventFromJson: the watcher's feed shape gives the SDK's event back, field for field", () => {
  const pool = key();
  const [ev] = eventsFromLogs([swappedLog(pool, 123_456_789_012n, 77n)]);
  const withMeta = { ...ev, signature: "sig1", blockTime: 1_700_000_001 };
  const json = eventToJson(withMeta);
  assert.equal(json.pool, pool.toBase58()); assert.equal(json.amountIn, "123456789012"); assert.equal(json.slot, "77");
  assert.equal(json.direction, DIRECTION.BUY); assert.equal(json.byHook, false); assert.equal(json.blockTime, 1_700_000_001); assert.equal(json.signature, "sig1");
  const back = eventFromJson(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(Object.keys(back).sort(), Object.keys(withMeta).sort());
  for (const k of Object.keys(withMeta)) {
    const a = withMeta[k], b = back[k];
    if (a instanceof PublicKey) assert.ok(b instanceof PublicKey && a.equals(b), k); else assert.equal(b, a, k);
  }
  // the contract's own example of a Graduated event
  const g = eventFromJson({ kind: "Graduated", signature: "x", blockTime: 0, pool: pool.toBase58(), reserveQuoteBefore: "85000000000", reserveQuoteAfter: "85000000000", reserveBaseBefore: "260869565217391", reserveBaseAfter: "192816635160680", burnedBase: "68052930056711", feeQuote: "0", slot: "120" });
  assert.equal(g.burnedBase, 68_052_930_056_711n); assert.ok(g.pool.equals(pool));
  assert.throws(() => eventFromJson({ kind: "Swapped", amountIn: "12.5" }), /not a whole number/);
});

test("every read the API and the watcher call is still there", () => {
  const c = new HookpoolClient(standIn(new Map()));
  for (const m of ["pool", "allPools", "metadata", "mint", "hookInfo", "tokenBalance", "allEvents", "recentSwaps", "curveEvents", "rulesState", "rulesStakeOf", "rulesLock", "rulesHolderOf", "rulesBurnInstructions", "buybackInstructions", "quoteLocal", "swapInstructions", "poolView", "rulesView", "walletBalances", "readAccounts", "recentEventsSince", "curveEventsFromStart", "buybackRun", "rulesBurnRun"]) {
    assert.equal(typeof c[m], "function", m);
  }
});
