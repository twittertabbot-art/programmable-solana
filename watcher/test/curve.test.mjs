// Pools on the curve: what the status file says about them, the graduate crank (its plan, what a call did as the
// chain reports it, its lines, the three strikes rule, the totals, the settings, the state, the health), and the
// simulation and the burn view with the virtual SOL counted, so that a pool on the curve gets a clean verdict.
// Nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { EVENT_IX_TAG, FLAGS, PROGRAMS, DIRECTION, decodePool, decodePlatform, decodeRulesConfig, burnStep, rulesBurnCapBps } from "../../sdk/dist/index.js";
import {
  curveEntry, curveNotes, readyToGraduate, supplyOf, solOf, planGraduates, graduateEffect, graduateAll, graduateLine, graduatedMessage, graduateStrikes, graduateStuckMessage,
  addGraduateTotals, addGraduatePoolStats, NO_GRADUATE_TOTALS, GRADUATE_STRIKES, GRADUATE_RETRY_ROUNDS, GRADUATE_RESEND_MS,
} from "../lib/curve.mjs";
import { impliedTaxBps, declaredMismatchBps, plainOut, buyProbeLamports } from "../lib/simulate.mjs";
import { burnView } from "../lib/burn.mjs";
import { platformSnapshot, diffPlatform } from "../lib/diff.mjs";
import { poolEntry } from "../lib/status.mjs";
import { healthBody } from "../lib/server.mjs";
import { parseArgs, buildConfig, describeConfig } from "../lib/config.mjs";
import { loadState, saveState, emptyState } from "../lib/state.mjs";
import { poolBytes, platformBytes, rulesConfig, strictConfig, graduatedEventBytes, splMintBytes, POOL } from "./bytes.mjs";

const key = () => Keypair.generate().publicKey;
const V = 30_000_000_000n; const TARGET = 85_000_000_000n; const SUPPLY = 1_000_000_000_000_000n;
/// A pool on the curve that walked along it without fees from its opening to `raised` lamports of real SOL.
const curvePool = (raised, o = {}) => {
  const address = o.address ?? key();
  const bytes = poolBytes({ reserveQuote: raised, reserveBase: (V * SUPPLY) / (V + raised), virtualQuote: V, graduationTarget: TARGET, curveState: 1, ...o });
  return decodePool(address, bytes);
};
const seededPool = (o = {}) => decodePool(o.address ?? key(), poolBytes(o));
// the launch rules template's flags: a fee on both sides before the swap, the sniper fee override on buys
const RULES_FLAGS = FLAGS.BEFORE_SWAP | FLAGS.BEFORE_ADD_LIQ | FLAGS.ON_POOL_CREATE | FLAGS.OVERRIDE_FEE | FLAGS.TAKE_HOOK_FEE | FLAGS.CALL_ON_BUY | FLAGS.CALL_ON_SELL;
const ascii = (s) => /^[\x20-\x7e]*$/.test(s);

// ---- the status file -------------------------------------------------------------------------------------------

test("curveEntry: the trade API's curve fields for a pool on the curve, nothing for a seeded pool", () => {
  assert.equal(curveEntry(seededPool(), SUPPLY), null, "a seeded pool's entry has no curve");
  const open = curvePool(2_000_000_000n);
  assert.deepEqual(curveEntry(open, SUPPLY), { state: "open", virtualQuote: "30000000000", raised: "2000000000", target: "85000000000", raisedBps: 235, soldBps: 625, graduationFeeBps: 0, graduates: false });
  assert.equal(curveEntry(open, null).soldBps, null, "an unread supply says so");
  const due = curvePool(TARGET, { graduationFeeBps: 500 });
  assert.deepEqual([curveEntry(due, SUPPLY).raisedBps, curveEntry(due, SUPPLY).graduates, curveEntry(due, SUPPLY).graduationFeeBps], [10000, true, 500]);
  const graduated = decodePool(key(), poolBytes({ reserveQuote: TARGET, reserveBase: 192_816_635_160_680n, curveState: 2, graduationFeeBps: 500 }));
  assert.deepEqual(curveEntry(graduated, SUPPLY - 68_052_930_056_711n), { state: "graduated", virtualQuote: "0", raised: "85000000000", target: "0", raisedBps: 10000, soldBps: 7931, graduationFeeBps: 500, graduates: false });
  // the supply of a mint, under either token program: bytes 36 to 43
  assert.equal(supplyOf({ data: splMintBytes({ supply: 12345n }) }), 12345n);
  assert.equal(supplyOf(null), null); assert.equal(supplyOf({ data: new Uint8Array(10) }), null);
});

test("poolEntry carries the curve in its own schema, and a seeded entry keeps the base schema", () => {
  const e = poolEntry({ template: "none", curve: { ...curveEntry(curvePool(TARGET), SUPPLY), extra: 1 } });
  assert.deepEqual(e.curve, { state: "open", virtualQuote: "30000000000", raised: "85000000000", target: "85000000000", raisedBps: 10000, soldBps: 7391, graduationFeeBps: 0, graduates: true });
  assert.equal("curve" in poolEntry({ template: "tax" }), false);
  assert.equal("curve" in poolEntry({ template: "none", curve: { state: "none" } }), false, "only the two states of a pool on the curve");
  assert.deepEqual(poolEntry({ curve: { state: "graduated", raised: 5n, raisedBps: "x", soldBps: null, graduates: "yes" } }).curve, { state: "graduated", virtualQuote: "0", raised: "5", target: "0", raisedBps: 0, soldBps: null, graduationFeeBps: 0, graduates: false });
});

test("curveNotes: where the pool stands, in words, and who sends graduate", () => {
  assert.deepEqual(curveNotes(seededPool()), []);
  const open = curveNotes(curvePool(2_100_000_000n));
  assert.deepEqual(open, [
    "This coin is on the curve. Its pool prices trades with 30 SOL of virtual SOL that it does not hold, and pays out only its real SOL.",
    "It holds 2.1 SOL of real SOL and graduates at 85 SOL. Liquidity opens at graduation.",
  ]);
  assert.equal(curveNotes(curvePool(TARGET + 1n), { crank: true, intervalSeconds: 15 })[2], "The pool stands past its graduation target. Anyone may send graduate. This watcher does it every 15 s.");
  assert.equal(curveNotes(curvePool(TARGET + 1n), { crank: false })[2], "The pool stands past its graduation target. Anyone may send graduate. This watcher runs without the graduate crank, so somebody else must.");
  assert.deepEqual(curveNotes(decodePool(key(), poolBytes({ curveState: 2 }))), ["This coin graduated from the curve. Its pool holds real SOL only now, and every share of its liquidity stays locked."]);
  for (const n of [...open, ...curveNotes(curvePool(TARGET), { crank: false })]) assert.ok(ascii(n), n);
  assert.deepEqual([solOf(0n), solOf(1n), solOf(85_000_000_000n), solOf(2_105_531_268n)], ["0", "0.000000001", "85", "2.105531268"]);
});

// ---- the crank ---------------------------------------------------------------------------------------------------

test("readyToGraduate: an open pool at or past its target, nothing else", () => {
  assert.equal(readyToGraduate(curvePool(TARGET)), true, "exactly at the target");
  assert.equal(readyToGraduate(curvePool(TARGET - 1n)), false, "one lamport short");
  assert.equal(readyToGraduate(curvePool(TARGET * 2n)), true);
  assert.equal(readyToGraduate(decodePool(key(), poolBytes({ reserveQuote: TARGET * 2n, curveState: 2 }))), false, "graduated");
  assert.equal(readyToGraduate(seededPool({ reserveQuote: TARGET * 2n })), false, "seeded");
  assert.equal(readyToGraduate(null), false);
});

test("planGraduates: every due pool once, fewer strikes and more SOL first, the resting and the recent left out", () => {
  const a = curvePool(TARGET + 1_000n); const b = curvePool(TARGET + 9_000n); const c = curvePool(TARGET); const d = curvePool(TARGET - 1n); const s = seededPool({ reserveQuote: TARGET * 3n });
  const k = (p) => p.address.toBase58();
  const plain = planGraduates([a, b, c, d, s], {}, {});
  assert.deepEqual(plain.keys, [k(a), k(b), k(c)], "the three that reached their target");
  assert.deepEqual(plain.send.map((x) => x.key), [k(b), k(a), k(c)], "the one with more real SOL first");
  const failed = planGraduates([a, b, c], { [k(b)]: { count: 1, alerted: false, skip: 0 }, [k(c)]: { count: 3, alerted: true, skip: 5 } }, {});
  assert.deepEqual(failed.send.map((x) => x.key), [k(a), k(b)], "a pool that failed goes after the others");
  assert.deepEqual(failed.resting.map((x) => x.key), [k(c)], "after its alert a pool rests");
  const split = planGraduates([a, b, c], {}, {}, { maxCalls: 2 });
  assert.deepEqual([split.send.length, split.later.length], [2, 1]);
  // a pool this watcher graduated a minute ago and that an RPC still shows open is not sent another call
  const now = Date.parse("2026-10-16T12:00:00.000Z");
  const recent = planGraduates([a], {}, { [k(a)]: { lastAt: "2026-10-16T11:59:00.000Z", lastOutcome: "graduated", signature: "S" } }, { nowMs: now });
  assert.deepEqual([recent.send.length, recent.recent.length, recent.recent[0].signature], [0, 1, "S"]);
  const old = planGraduates([a], {}, { [k(a)]: { lastAt: new Date(now - GRADUATE_RESEND_MS - 1).toISOString(), lastOutcome: "graduated" } }, { nowMs: now });
  assert.equal(old.send.length, 1, "after a while it is sent again: it lands and changes nothing if the pool did graduate");
  const failedBefore = planGraduates([a], {}, { [k(a)]: { lastAt: "2026-10-16T11:59:00.000Z", lastOutcome: "failed" } }, { nowMs: now });
  assert.equal(failedBefore.send.length, 1, "a call that failed is no reason to wait");
});

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes) {
  let n = 0n;
  for (const x of bytes) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of bytes) { if (x === 0) s = "1" + s; else break; }
  return s;
}
const PAYER = key();
function txWith({ event = null, fee = 5000, cu = 20_538, slot = 5000 } = {}) {
  const inner = event ? [{ index: 1, instructions: [{ programIdIndex: 1, accounts: [], data: bs58(Uint8Array.from([...EVENT_IX_TAG, ...event])) }] }] : [];
  return { slot, meta: { fee, computeUnitsConsumed: cu, innerInstructions: inner, logMessages: [], returnData: null }, transaction: { message: { staticAccountKeys: [PAYER, PROGRAMS.hookpool] } } };
}
const EV = { reserveQuoteBefore: 86_000_000_000n, reserveQuoteAfter: 86_000_000_000n, reserveBaseBefore: 258_620_689_655_172n, reserveBaseAfter: 192_816_635_160_680n, burnedBase: 65_804_054_494_492n, feeQuote: 0n, slot: 4999n };

test("graduateEffect: the Graduated event says the coin graduated; none says it had graduated already", () => {
  const e = graduateEffect(txWith({ event: graduatedEventBytes({ pool: POOL, ...EV }) }), POOL);
  assert.deepEqual(e, { outcome: "graduated", ...EV, feeLamports: 5000, computeUnits: 20_538 });
  assert.deepEqual(graduateEffect(txWith({}), POOL), { outcome: "already", feeLamports: 5000, computeUnits: 20_538 }, "the call landed and changed nothing");
  assert.equal(graduateEffect(txWith({ event: graduatedEventBytes({ pool: key(), ...EV }) }), POOL).outcome, "already", "another pool's event is not this pool's graduation");
  assert.equal(graduateEffect(null), null);
});

test("graduateAll and the lines: one call per pool, a failure never stops the pass", async () => {
  const a = curvePool(TARGET + 1n); const b = curvePool(TARGET + 2n);
  const plan = planGraduates([a, b], {}, {}).send;
  const results = await graduateAll({
    plan,
    send: async (item) => { if (item.pool === a) throw Object.assign(new Error("Simulation failed"), { logs: ["Program log: AnchorError thrown in programs/hookpool/src/instructions/graduate.rs:40. Error Code: Paused. Error Number: 6000. Error Message: the platform is paused."] }); return "SIG" + item.key.slice(0, 4); },
    readEffect: async (signature, item) => graduateEffect(txWith({ event: graduatedEventBytes({ pool: item.pool.address, ...EV }) }), item.pool.address),
  });
  const [rb, ra] = results;
  assert.equal(ra.ok, false); assert.equal(ra.error, "Paused (6000): the platform is paused");
  assert.equal(rb.ok, true); assert.equal(rb.effect.outcome, "graduated");
  assert.equal(graduateLine(ra), `graduate FAILED: pool ${a.address.toBase58()}: Paused (6000): the platform is paused`);
  assert.equal(graduateLine(rb), `graduate: pool ${b.address.toBase58()}: graduated with 86000000000 lamports of real SOL raised, burned 65804054494492 raw coins to keep the price, 0 lamports for the platform; the pool holds 86000000000 lamports and 192816635160680 raw coins now, tx ${rb.signature}`);
  assert.equal(graduateLine({ ...rb, effect: { outcome: "already" } }), `graduate: pool ${b.address.toBase58()}: the pool had graduated already, the call changed nothing, tx ${rb.signature}`);
  assert.equal(graduateLine({ ...rb, effect: null }), `graduate: pool ${b.address.toBase58()}: sent, the result could not be read, tx ${rb.signature}`);
  assert.equal(graduatedMessage(rb, "CRV"), `CRV graduated from the curve: 86 SOL raised, 65804054494492 raw coins burned so that the price stays, 0 SOL for the platform. Its liquidity is open now. Sent by this watcher, tx ${rb.signature}`);
  for (const r of results) assert.ok(ascii(graduateLine(r)));
});

test("the three strikes rule: one alert after three failed passes, then rest; a success or a pool no longer due clears", () => {
  const p = curvePool(TARGET + 5n); const k = p.address.toBase58();
  const fail = [{ key: k, pool: p, ok: false, error: "x (6000): y" }];
  let fails = {};
  for (let pass = 1; pass <= GRADUATE_STRIKES; pass++) {
    const r = graduateStrikes(fails, [k], fail);
    fails = r.fails;
    assert.equal(r.alerts.length, pass === GRADUATE_STRIKES ? 1 : 0, "pass " + pass);
  }
  assert.deepEqual(fails[k], { count: 3, alerted: true, skip: GRADUATE_RETRY_ROUNDS - 1, error: "x (6000): y" });
  const once = graduateStrikes(fails, [k], fail);
  assert.equal(once.alerts.length, 0, "one alert, once");
  const resting = graduateStrikes(fails, [k], []);
  assert.equal(resting.fails[k].skip, GRADUATE_RETRY_ROUNDS - 2, "a pass that does not call it counts its rest down");
  assert.deepEqual(graduateStrikes(fails, [k], [{ key: k, pool: p, ok: true }]).fails, {}, "a confirmed call clears it");
  assert.deepEqual(graduateStrikes(fails, [], []).fails, {}, "a pool that is no longer due is forgotten");
  assert.deepEqual(graduateStrikes(fails, [], [], { unread: [k] }).fails, fails, "an unread pool keeps what it had");
  const ev = graduateStrikes({}, [k], fail, { limit: 1 }).alerts[0];
  const msg = graduateStuckMessage(ev, "CRV");
  assert.equal(msg, "the graduate call failed 1 passes in a row on CRV: x (6000): y. The pool holds 85.000000005 SOL of real SOL, past its target of 85 SOL, and keeps trading on the curve until somebody graduates it. Look at it.");
  assert.ok(ascii(msg));
});

test("totals and the record per pool", () => {
  const r = [
    { key: "A", signature: "S1", effect: { outcome: "graduated", feeLamports: 5000 } },
    { key: "B", signature: "S2", effect: { outcome: "already", feeLamports: 5000 } },
    { key: "C", signature: null, effect: null },
    { key: "D", signature: "S4", effect: null },
  ];
  assert.deepEqual(addGraduateTotals(NO_GRADUATE_TOTALS(), r), { sent: 3, failed: 1, graduated: 1, already: 1, feeLamports: 10000 });
  assert.deepEqual(addGraduateTotals({ sent: 2, failed: 0, graduated: 2, already: 0, feeLamports: 10000 }, r.slice(0, 1)), { sent: 3, failed: 0, graduated: 3, already: 0, feeLamports: 15000 });
  const t = addGraduatePoolStats({}, r, "t");
  assert.deepEqual(t, { A: { lastAt: "t", lastOutcome: "graduated", signature: "S1" }, B: { lastAt: "t", lastOutcome: "already", signature: "S2" }, C: { lastAt: "t", lastOutcome: "failed", signature: null }, D: { lastAt: "t", lastOutcome: "already", signature: "S4" } });
});

test("settings, state and health carry the graduate crank", () => {
  const c = buildConfig({}, parseArgs([]), "/w");
  assert.equal(c.graduate, true, "on by default"); assert.equal(c.graduateIntervalSeconds, 15);
  assert.ok(describeConfig(c).graduateCrank.startsWith("every 15 s"));
  assert.equal(buildConfig({ GRADUATE_KEEPER: "off" }, parseArgs([]), "/w").graduate, false);
  assert.equal(buildConfig({ GRADUATE_KEEPER: "ON" }, parseArgs([]), "/w").graduate, true);
  assert.equal(buildConfig({}, parseArgs(["--no-graduate"]), "/w").graduate, false);
  assert.equal(buildConfig({}, parseArgs(["--no-crank"]), "/w").graduate, false);
  assert.equal(buildConfig({}, parseArgs(["--no-burn"]), "/w").graduate, true, "the other switches leave it alone");
  assert.equal(buildConfig({}, parseArgs(["--no-graduate"]), "/w").burn, true);
  assert.ok(describeConfig(buildConfig({ GRADUATE_KEEPER: "off" }, parseArgs([]), "/w")).graduateCrank.startsWith("off (--no-graduate or GRADUATE_KEEPER=off)"));
  assert.equal(buildConfig({ GRADUATE_INTERVAL_SECONDS: "60" }, parseArgs([]), "/w").graduateIntervalSeconds, 60);
  assert.throws(() => buildConfig({ GRADUATE_KEEPER: "maybe" }, parseArgs([])), /GRADUATE_KEEPER/);
  assert.throws(() => buildConfig({ GRADUATE_INTERVAL_SECONDS: "2" }, parseArgs([])), /below the minimum/);
  // the state: a file written before the crank existed loads with empty tables
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-watcher-curve-"));
  const file = path.join(dir, "state.json");
  const s = emptyState();
  assert.deepEqual(s.graduate, { fails: {}, totals: NO_GRADUATE_TOTALS(), pools: {} });
  s.graduate.totals.graduated = 2; s.graduate.pools.P = { lastAt: "t", lastOutcome: "graduated", signature: "S" };
  saveState(file, s);
  assert.deepEqual(loadState(file).graduate, s.graduate);
  const older = emptyState(); delete older.graduate;
  fs.writeFileSync(file, JSON.stringify(older));
  assert.deepEqual(loadState(file).graduate, { fails: {}, totals: NO_GRADUATE_TOTALS(), pools: {} });
  fs.rmSync(dir, { recursive: true, force: true });
  // health
  const now = Date.parse("2026-10-16T12:00:00.000Z");
  const status = { updatedAt: "2026-10-16T11:59:30.000Z", pools: { P: {} } };
  const totals = { sent: 3, failed: 1, graduated: 2, already: 1, feeLamports: 15000 };
  const h = healthBody({ status, graduate: { enabled: true, lastGraduateAt: "2026-10-16T11:59:50.000Z", lastGraduateSent: 1, intervalSeconds: 15, totals }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.equal(h.ok, true);
  assert.deepEqual([h.graduateEnabled, h.graduateStale, h.lastGraduateSent, h.graduatesSent, h.graduatesFailed, h.coinsGraduated, h.graduatesAlready, h.graduateFeesLamports], [true, false, 1, 3, 1, 2, 1, 15000]);
  const stale = healthBody({ status, graduate: { enabled: true, lastGraduateAt: "2026-10-16T11:58:00.000Z", lastGraduateSent: 0, intervalSeconds: 15, totals }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.deepEqual([stale.ok, stale.graduateStale], [false, true], "a crank that has not run for three of its intervals");
  const off = healthBody({ status, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.deepEqual([off.ok, off.graduateEnabled, off.graduatesSent], [true, false, 0]);
});

// ---- the simulation and the burn view on a pool on the curve -------------------------------------------------------

test("simulation: a pool on the curve is quoted with its virtual SOL, so a plain trade reads as no tax at all", () => {
  const pool = curvePool(2_000_000_000n);
  const q = { reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: pool.virtualQuote, lpFeeBps: 100, protocolFeeBps: 20 };
  // what the pool program pays for a buy of 0.05 SOL and a sell of 1e12 raw units, written out by hand
  const ceil = (a, bps) => (a * BigInt(bps) + 9999n) / 10000n;
  const net = (a) => { const p = ceil(a, 20); return a - p - ceil(a - p, 100); };
  const buyOut = (pool.reserveBase * net(50_000_000n)) / (pool.reserveQuote + V + net(50_000_000n));
  const sellOut = ((pool.reserveQuote + V) * net(1_000_000_000_000n)) / (pool.reserveBase + net(1_000_000_000_000n));
  assert.equal(plainOut(q, DIRECTION.BUY, 50_000_000n), buyOut);
  assert.equal(impliedTaxBps(q, DIRECTION.BUY, 50_000_000n, buyOut), 0);
  assert.equal(impliedTaxBps(q, DIRECTION.SELL, 1_000_000_000_000n, sellOut), 0);
  // the false alarm this prevents: the same output read against the real SOL alone looks like a hook taking nearly all
  const realOnly = { ...q, virtualQuote: 0n };
  assert.ok(impliedTaxBps(realOnly, DIRECTION.BUY, 50_000_000n, buyOut) > 9000, "read without the virtual SOL, a plain buy looks taxed at more than 90%");
  // a rules coin on the curve: the declared output is the simulated one
  const hook = { template: "rules", flags: RULES_FLAGS, rules: decodeRulesConfig(rulesConfig({ buy: { creatorBps: 100, burnBps: 200 }, sell: { burnBps: 200 } })) };
  const withRates = (a) => { const p = ceil(a, 20); const h = ceil(a - p, 300); const n = a - p - h - ceil(a - p - h, 100); return (pool.reserveBase * n) / (pool.reserveQuote + V + n); };
  assert.equal(declaredMismatchBps({ ...q, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000 }, DIRECTION.BUY, 50_000_000n, hook, 5000, withRates(50_000_000n)), 0, "the declared 3% on the curve is what the pool pays");
  assert.ok(declaredMismatchBps({ ...q, virtualQuote: 0n, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000 }, DIRECTION.BUY, 50_000_000n, hook, 5000, withRates(50_000_000n)) > 1000, "read without the virtual SOL it would be a mismatch warning");
});

test("simulation: the buy probe of a strict coin on the curve fits the max wallet at the curve's price", () => {
  const pool = curvePool(1_000_000_000n);
  const hook = { template: "rules", flags: RULES_FLAGS, rules: decodeRulesConfig(strictConfig({ startSlot: 1000n, buy: { creatorBps: 50, holdersBps: 100, burnBps: 50 } })) };
  const q = { reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: pool.virtualQuote, lpFeeBps: 100, protocolFeeBps: 20, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000 };
  const probe = buyProbeLamports(2_000_000_000n, hook, 1050n, q);
  const ceil = (a, bps) => (a * BigInt(bps) + 9999n) / 10000n;
  const out = (a) => { const p = ceil(a, 20); const h = ceil(a - p, 200); const n = a - p - h - ceil(a - p - h, 100); return (pool.reserveBase * n) / (pool.reserveQuote + V + n); };
  const cap = 30_000_000_000_000n;
  assert.ok(probe.amount < 2_000_000_000n && out(probe.amount) <= cap && out(probe.amount + 1n) > cap, "the probe is cut to the largest buy whose coins fit: " + probe.amount);
});

test("burn view: a pool on the curve compares effective prices, as hook_rules and hook_buyback do", () => {
  const at1 = curvePool(1_000_000_000n); const at2 = curvePool(2_000_000_000n); const at11 = curvePool(1_100_000_000n);
  const platform = { protocolFeeBps: 20, maxHookFeeBps: 1000 };
  // the observation a run stored on the pool at 1 SOL raised: its base reserve and its EFFECTIVE quote reserve
  const cfg = decodeRulesConfig(rulesConfig({ buy: { creatorBps: 50, burnBps: 100 }, sell: { creatorBps: 50, burnBps: 200 }, obsSlot: 100n, obsReserveBase: at1.reserveBase, obsReserveQuote: at1.reserveQuote + V }));
  const capBps = rulesBurnCapBps(cfg, platform, 100);
  const obs = { slot: 100n, reserveBase: at1.reserveBase, reserveQuote: at1.reserveQuote + V };
  // a doubling of the real reserve is a 7% move of the price: the program waits, and so does the view
  const twice = burnView({ kind: "rules", pool: at2, platform, cfg, pot: 10_000_000n, slot: 200n });
  assert.equal(twice.step, "wait");
  assert.equal(twice.step, burnStep(obs, at2.reserveBase, at2.reserveQuote + V, 200n, capBps, 10_000_000n).step);
  assert.equal(burnStep(obs, at2.reserveBase, at2.reserveQuote, 200n, capBps, 10_000_000n).step, "buy", "read on the real SOL alone the price would look fallen, and the view would say buy");
  // a tenth more of real SOL is a small move: a buy
  assert.equal(burnView({ kind: "rules", pool: at11, platform, cfg, pot: 10_000_000n, slot: 200n }).step, "buy");
  // a seeded pool is read as before
  const seeded = seededPool({ reserveBase: 1_000_000_000_000_000n, reserveQuote: 100_000_000_000n });
  const scfg = decodeRulesConfig(rulesConfig({ buy: { creatorBps: 50, burnBps: 100 }, sell: { burnBps: 200 }, obsSlot: 100n, obsReserveBase: seeded.reserveBase, obsReserveQuote: seeded.reserveQuote }));
  assert.equal(burnView({ kind: "rules", pool: seeded, platform, cfg: scfg, pot: 10_000_000n, slot: 200n }).step, "buy");
});

test("platform: a change of the curve settings is reported; a snapshot of an older watcher without them is not", () => {
  const p = decodePlatform(new Uint8Array(platformBytes({ curve: { virtualQuote: V, graduationTarget: TARGET, graduationFeeBps: 0 } })));
  const a = platformSnapshot(p);
  assert.deepEqual([a.curveVirtualQuote, a.curveGraduationTarget, a.curveGraduationFeeBps], ["30000000000", "85000000000", 0]);
  const b = platformSnapshot({ ...p, curveGraduationFeeBps: 500 });
  assert.deepEqual(diffPlatform(a, b), [{ field: "curveGraduationFeeBps", from: "0", to: "500" }]);
  const old = { ...a }; delete old.curveVirtualQuote; delete old.curveGraduationTarget; delete old.curveGraduationFeeBps;
  assert.deepEqual(diffPlatform(old, a), [], "the first pass of this version records the curve settings without an alert");
  // a platform account written before the curve: curve launches off
  const before = platformSnapshot(decodePlatform(new Uint8Array(platformBytes())));
  assert.deepEqual([before.curveVirtualQuote, before.curveGraduationTarget], ["0", "0"]);
});
