// The burn keeper: which pools have something to spend, what the keeper decides for each of the SDK's cases
// (observe, too soon, wait, buy), the plan of a pass, what a call did as the chain reports it, the three
// strikes rule, the totals, the settings. The chain is a connection made of raw account bytes; the answers come
// from the SDK's own `buybackInstructions` and `rulesBurnInstructions`. Nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  HookpoolClient, CLOCK_SYSVAR, DIRECTION, EVENT_IX_TAG, IX, PROGRAMS, BURN_INTERVAL_SLOTS, burnStep, buybackCapBps, decodePool, pda, quoteSwap, rulesBurnCapBps, rulesPda,
} from "../../sdk/dist/index.js";
import {
  burnKind, burnPot, burnView, burnDecision, planBurns, burnEffect, chainError, burnAll, burnLine, burnSkipLine, burnStrikes, burnStuckMessage, addBurnTotals, addBurnPoolStats,
  readBurnCandidates, NO_BURN_TOTALS, BURN_STRIKES, BURN_RETRY_ROUNDS, BURN_FEE_LAMPORTS,
} from "../lib/burn.mjs";
import { healthBody } from "../lib/server.mjs";
import { parseArgs, buildConfig, describeConfig } from "../lib/config.mjs";
import { loadState, saveState, emptyState } from "../lib/state.mjs";
import { buybackConfig, rulesConfig, poolBytes, platformBytes, clockBytes, tokenAccountBytes, burnEventBytes, WSOL, OWNER, SYSTEM } from "./bytes.mjs";

const key = () => Keypair.generate().publicKey;
const PAYER = key();
const RB = 1_000_000_000_000_000n;      // one billion coins of 6 decimals in the pool
const RQ = 100_000_000_000n;            // 100 SOL in the pool
const PLATFORM = { protocolFeeBps: 20, maxHookFeeBps: 1000 };

/// A connection that answers from memory and counts its reads.
function fakeConnection(accounts, slot) {
  const calls = [];
  const get = (k) => accounts.get(k.toBase58()) ?? null;
  return {
    calls,
    async getAccountInfo(k) { calls.push("one"); return get(k); },
    async getMultipleAccountsInfo(keys) { calls.push(`many:${keys.length}`); return keys.map(get); },
    async getMultipleAccountsInfoAndContext(keys) { calls.push(`fresh:${keys.length}`); return { context: { slot: Number(slot) }, value: keys.map(get) }; },
  };
}
/// One pool of a buy-and-burn template with everything a keeper reads: the pool, the hook's config, its
/// treasury, the platform account and the clock.
function world({ kind, cfg = {}, pool = {}, treasury = 0n, platform = {}, slot = 5000n, accounts = new Map() }) {
  const baseMint = key();
  const address = pda.pool(baseMint, WSOL);
  const program = kind === "buyback" ? PROGRAMS.hook_buyback : PROGRAMS.hook_rules;
  const authority = pda.hookAuthority(address, program)[0];
  const treasuryKey = kind === "buyback" ? pda.ata(authority, WSOL) : rulesPda.treasury(address, WSOL);
  const poolData = poolBytes({ baseMint, hookProgram: program, hookFlags: kind === "buyback" ? 12865 : 13125, hookKind: 2, hookQuoteTreasury: treasuryKey, reserveBase: RB, reserveQuote: RQ, ...pool });
  const cfgData = kind === "buyback" ? buybackConfig({ pool: address, treasury: treasuryKey, minQuote: 1_000_000n, ...cfg }) : rulesConfig({ pool: address, baseMint, quoteMint: WSOL, treasury: treasuryKey, ...cfg });
  const put = (k, owner, data) => accounts.set(k.toBase58(), { owner, data: Buffer.from(data), lamports: 1_000_000, executable: false });
  put(address, PROGRAMS.hookpool, poolData);
  put(pda.cfg(program, address), program, cfgData);
  if (treasury !== null) put(treasuryKey, key(), tokenAccountBytes({ mint: WSOL, owner: authority, amount: treasury }));
  put(pda.platform(), PROGRAMS.hookpool, platformBytes(platform));
  put(CLOCK_SYSVAR, SYSTEM, clockBytes({ slot }));
  const connection = fakeConnection(accounts, slot);
  return { kind, address, baseMint, program, treasuryKey, accounts, connection, client: new HookpoolClient(connection), pool: decodePool(address, poolData), cfgData };
}
const candidatesOf = (w, opts = {}) => readBurnCandidates(w.connection, w.client, PAYER, [w.pool], { minPot: 100_000n, slippageBps: 100, ...opts });
/// The floor the SDK must put into a buy: the pool's own quote for the spend, with no hook fee, less the slippage.
function floorOf(spend, slippageBps = 100, lpFeeBps = 100) {
  const out = quoteSwap({ direction: DIRECTION.BUY, amountIn: spend, reserveBase: RB, reserveQuote: RQ, lpFeeBps, protocolFeeBps: 20, hookFeeBps: 0 }).amountOut;
  return (out * BigInt(10_000 - slippageBps)) / 10_000n;
}
const minOutOf = (ix) => Buffer.from(ix.data).readBigUInt64LE(8);
const callOf = (run) => run.instructions.find((i) => i.programId.equals(PROGRAMS.hook_buyback) || i.programId.equals(PROGRAMS.hook_rules));
const startsWith = (data, disc) => disc.every((b, i) => data[i] === b);
// A rules coin with a burn rate of 1% on buys and 2% on sells: the cap of one buy is (20 + 100 + 200 + 220) / 4 = 135, cut to the ceiling of 50 bps.
const BURNING = { buy: { creatorBps: 0, holdersBps: 0, burnBps: 100 }, sell: { creatorBps: 0, holdersBps: 0, burnBps: 200 } };

test("burnKind: the two templates that buy their coin back, and no other pool", () => {
  const p = (hookProgram) => decodePool(key(), poolBytes({ hookProgram, hookKind: 2 }));
  assert.equal(burnKind(p(PROGRAMS.hook_buyback)), "buyback");
  assert.equal(burnKind(p(PROGRAMS.hook_rules)), "rules");
  for (const other of [PROGRAMS.hook_tax, PROGRAMS.hook_launch_guard, PROGRAMS.hook_collectible, key()]) assert.equal(burnKind(p(other)), null);
  assert.equal(burnKind(decodePool(key(), poolBytes())), null, "a pool without a hook");
  assert.equal(burnKind(null), null);
});

test("burnPot: a buyback treasury counts from the coin's own minimum; a rules pot counts the last trade's fee in", () => {
  const b = world({ kind: "buyback", treasury: 60_000_000n, cfg: { minQuote: 50_000_000n } });
  const bytes = (w, k) => new Uint8Array(w.accounts.get(k.toBase58()).data);
  assert.equal(burnPot({ kind: "buyback", pool: b.pool, cfgBytes: b.cfgData, treasuryBytes: bytes(b, b.treasuryKey) }).pot, 60_000_000n);
  const low = burnPot({ kind: "buyback", pool: b.pool, cfgBytes: buybackConfig({ minQuote: 70_000_000n }), treasuryBytes: bytes(b, b.treasuryKey) });
  assert.equal(low.pot, 0n, "under the minimum the program refuses a call"); assert.equal(low.held, 60_000_000n);
  assert.equal(burnPot({ kind: "buyback", pool: b.pool, cfgBytes: b.cfgData, treasuryBytes: null }).pot, 0n, "no treasury account");
  assert.equal(burnPot({ kind: "buyback", pool: b.pool, cfgBytes: null, treasuryBytes: null }), null);
  assert.equal(burnPot({ kind: "buyback", pool: b.pool, cfgBytes: rulesConfig(), treasuryBytes: null }), null, "bytes of another account");

  // 2,000,000 lamports stored; the pool has paid 400,000 more to the treasury than the config has seen, from a
  // sell charged 1% creator, 2% holders, 1% burn. Nothing is staked, so the holders' part goes to the pot too:
  // creator 100,000, pot 300,000.
  const r = world({ kind: "rules", cfg: { burnPot: 2_000_000n, feesSeen: 5_000_000n, lastSplit: { creatorBps: 100, holdersBps: 200, burnBps: 100 } }, pool: { hookFeesQuoteTotal: 5_400_000n } });
  assert.equal(burnPot({ kind: "rules", pool: r.pool, cfgBytes: r.cfgData }).pot, 2_300_000n);
  // with enough staked the holders' part is the stakers': only the burn share reaches the pot
  const staked = rulesConfig({ burnPot: 2_000_000n, feesSeen: 5_000_000n, lastSplit: { creatorBps: 100, holdersBps: 200, burnBps: 100 }, totalStaked: 2_000_000_000_000n });
  assert.equal(burnPot({ kind: "rules", pool: r.pool, cfgBytes: staked }).pot, 2_100_000n);
  // a fee found while no rate was recorded cannot happen, and loses nothing if it does: all of it is the pot's
  assert.equal(burnPot({ kind: "rules", pool: r.pool, cfgBytes: rulesConfig() }).pot, 5_400_000n);
  assert.equal(burnPot({ kind: "rules", pool: decodePool(key(), poolBytes()), cfgBytes: rulesConfig() }).pot, 0n, "no fee, no pot");
});

test("the keeper's decision, case by case, on the SDK's own answers for a rules pool", async () => {
  const cap = rulesBurnCapBps(BURNING, PLATFORM, 100);
  assert.equal(cap, 50);
  const pot = 2_000_000_000n;                              // 2 SOL in the pot
  const spend = (RQ * BigInt(cap)) / 10_000n;              // one buy: 0.5% of 100 SOL
  assert.equal(spend, 500_000_000n);

  // no observation yet: the call records the pool. Sent, with no floor.
  const first = world({ kind: "rules", cfg: { ...BURNING, burnPot: pot } });
  const a = (await candidatesOf(first)).candidates[0];
  assert.deepEqual(burnStep({ slot: 0n, reserveBase: 0n, reserveQuote: 0n }, RB, RQ, 5000n, cap, pot), { step: "observe" });
  assert.equal(a.run.step, "observe"); assert.equal(a.run.pot, pot); assert.equal(a.run.capBps, 50);
  assert.deepEqual(burnDecision(a.run, { minPot: 100_000n }), { send: true, why: "observe" });
  assert.ok(callOf(a.run).programId.equals(PROGRAMS.hook_rules) && startsWith(callOf(a.run).data, IX.hook_rules.run_burn));
  assert.equal(minOutOf(callOf(a.run)), 0n, "a call that only records carries no floor");

  // an observation 24 slots old: the chain would refuse. Skipped, nothing built.
  const obs = { obsReserveBase: RB, obsReserveQuote: RQ };
  const soon = world({ kind: "rules", cfg: { ...BURNING, burnPot: pot, obsSlot: 4976n, ...obs } });
  const b = (await candidatesOf(soon)).candidates[0];
  assert.deepEqual(burnStep({ slot: 4976n, reserveBase: RB, reserveQuote: RQ }, RB, RQ, 5000n, cap, pot), { step: "tooSoon", dueSlot: 5001n });
  assert.equal(b.run.step, "tooSoon"); assert.equal(b.run.instructions.length, 0);
  assert.deepEqual(burnDecision(b.run, { minPot: 100_000n }), { send: false, why: "tooSoon", dueSlot: 5001n, reason: null });

  // exactly 25 slots old and the price where it was: the call buys. Sent, with the SDK's floor.
  const due = world({ kind: "rules", cfg: { ...BURNING, burnPot: pot, obsSlot: 4975n, ...obs } });
  const c = (await candidatesOf(due)).candidates[0];
  assert.equal(4975n + BURN_INTERVAL_SLOTS, 5000n);
  assert.deepEqual(burnStep({ slot: 4975n, reserveBase: RB, reserveQuote: RQ }, RB, RQ, 5000n, cap, pot), { step: "buy", maxSpend: spend, spend });
  assert.equal(c.run.step, "buy"); assert.equal(c.run.spend, spend); assert.equal(c.run.potLeft, pot - spend);
  assert.deepEqual(burnDecision(c.run, { minPot: 100_000n }), { send: true, why: "buy" });
  assert.equal(c.run.minOut, floorOf(spend));
  assert.equal(minOutOf(callOf(c.run)), floorOf(spend), "the floor in the instruction is the SDK's quote less the keeper's slippage");
  assert.equal(minOutOf(callOf((await candidatesOf(due, { slippageBps: 300 })).candidates[0].run)), floorOf(spend, 300));

  // the price ran above the observation by more than twice the cap: the call records the pool again. Sent, no floor.
  const up = world({ kind: "rules", cfg: { ...BURNING, burnPot: pot, obsSlot: 4975n, obsReserveBase: RB, obsReserveQuote: (RQ * 10_000n) / 10_101n } });
  const d = (await candidatesOf(up)).candidates[0];
  assert.equal(d.run.step, "wait");
  assert.deepEqual(burnDecision(d.run, { minPot: 100_000n }), { send: true, why: "wait" });
  assert.equal(minOutOf(callOf(d.run)), 0n);
  // at the tolerance to the unit it still buys; one unit above it waits
  const edge = (RQ * 10_100n) / 10_000n;   // 1% above the observed 100 SOL, to the unit: 100 bps, twice the cap
  assert.equal(edge, 101_000_000_000n);
  assert.equal(burnStep({ slot: 4975n, reserveBase: RB, reserveQuote: RQ }, RB, edge, 5000n, cap, pot).step, "buy");
  assert.equal(burnStep({ slot: 4975n, reserveBase: RB, reserveQuote: RQ }, RB, edge + 1n, 5000n, cap, pot).step, "wait");
  // a pot smaller than the cap is spent whole
  const small = world({ kind: "rules", cfg: { ...BURNING, burnPot: 300_000n, obsSlot: 4975n, ...obs } });
  const e = (await candidatesOf(small)).candidates[0];
  assert.equal(e.run.spend, 300_000n); assert.equal(e.run.potLeft, 0n);
});

test("the keeper's decision on a buyback pool: the same four cases, on the treasury", async () => {
  const fees = { buyBps: 200, sellBps: 200 };
  const cap = buybackCapBps(fees, PLATFORM, 100);
  assert.equal(cap, 50);
  const treasury = 3_000_000_000n;
  const obs = { obsReserveBase: RB, obsReserveQuote: RQ };
  const run = async (cfg) => { const w = world({ kind: "buyback", treasury, cfg: { ...fees, ...cfg } }); const got = await candidatesOf(w); return got.candidates[0].run; };
  const first = await run({});
  assert.equal(first.step, "observe"); assert.equal(first.pot, treasury);
  assert.deepEqual(burnDecision(first), { send: true, why: "observe" });
  assert.ok(callOf(first).programId.equals(PROGRAMS.hook_buyback) && startsWith(callOf(first).data, IX.hook_buyback.execute_buyback) && minOutOf(callOf(first)) === 0n);
  const soon = await run({ obsSlot: 4990n, ...obs });
  assert.deepEqual(burnDecision(soon), { send: false, why: "tooSoon", dueSlot: 5015n, reason: null });
  const buy = await run({ obsSlot: 4975n, ...obs });
  assert.equal(buy.step, "buy"); assert.equal(buy.spend, 500_000_000n);
  assert.deepEqual(burnDecision(buy), { send: true, why: "buy" });
  assert.equal(minOutOf(callOf(buy)), floorOf(500_000_000n));
  const wait = await run({ obsSlot: 4975n, obsReserveBase: RB, obsReserveQuote: RQ / 2n });
  assert.deepEqual(burnDecision(wait), { send: true, why: "wait" });
  // a deeper pool observed than the pool now: the slice is measured on the smaller depth
  const shallow = await run({ obsSlot: 4975n, obsReserveBase: RB * 2n, obsReserveQuote: RQ * 2n });
  assert.equal(shallow.step, "buy"); assert.equal(shallow.spend, 500_000_000n);
  // the config goes in writable and the platform account is the pool program's
  const k = callOf(buy).keys;
  assert.ok(k[0].pubkey.equals(PAYER) && k[0].isSigner && k[1].isWritable && k[3].pubkey.equals(pda.platform()));
});

test("burnDecision: a buy the pool would refuse is not due, and the SDK's reason is kept for the log", () => {
  // the SDK: step "buy", due false, no instructions, a reason (a pot of a few lamports buys nothing)
  const tiny = { step: "buy", due: false, dueSlot: 5000n, slot: 5000n, pot: 150_000n, spend: 150_000n, expectedOut: 0n, minOut: 0n, instructions: [], reason: "the pot's 150000 lamports cannot buy anything: amount too small; the pool would refuse the buy, so the call is not due until more fees reach the pot" };
  assert.deepEqual(burnDecision(tiny, { minPot: 100_000n }), { send: false, why: "tooSoon", dueSlot: 5000n, reason: tiny.reason });
  const plan = planBurns([{ key: "T", pool: "T", kind: "rules", run: tiny }], {}, { minPot: 100_000n });
  assert.deepEqual(plan.send, []); assert.equal(plan.tooSoon.length, 1); assert.equal(plan.tooSoon[0].reason, tiny.reason);
  assert.equal(burnSkipLine(plan.tooSoon[0]), "burn: pool T (rules): not due: " + tiny.reason + "; nothing sent");
  const soon = { step: "tooSoon", due: false, dueSlot: 5001n, slot: 4990n, pot: 5_000_000n, instructions: [] };
  assert.equal(burnDecision(soon).reason, null);
  assert.equal(burnSkipLine({ pool: "T", kind: "buyback", dueSlot: 5001n, run: soon, reason: null }), "burn: pool T (buyback): too soon, the chain takes the next call from slot 5001 (now 4990); nothing sent");
});

test("burnDecision: nothing to spend, a pot under the keeper's minimum, and answers that are not a call", () => {
  assert.deepEqual(burnDecision(null), { send: false, why: "nothing" });
  assert.deepEqual(burnDecision({ step: "buy", due: true, pot: 0n, instructions: [1] }), { send: false, why: "nothing" });
  assert.deepEqual(burnDecision({ step: "buy", due: true, pot: 99_999n, instructions: [1] }, { minPot: 100_000n }), { send: false, why: "small" });
  assert.deepEqual(burnDecision({ step: "buy", due: true, pot: 100_000n, instructions: [1] }, { minPot: 100_000n }), { send: true, why: "buy" });
  assert.deepEqual(burnDecision({ step: "buy", due: true, pot: 5n, instructions: [] }), { send: false, why: "tooSoon", dueSlot: undefined, reason: null }, "nothing to send is never sent");
  assert.deepEqual(burnDecision({ step: "sideways", due: true, pot: 5n, instructions: [1] }), { send: false, why: "nothing" });
});

test("readBurnCandidates: one batched read finds the pots; only pools with enough to spend are asked of the SDK", async () => {
  const accounts = new Map();
  const empty = world({ kind: "rules", accounts, cfg: BURNING });
  const dust = world({ kind: "rules", accounts, cfg: { burnPot: 40n } });                       // the rounding dust of a coin with no burn rate
  const full = world({ kind: "rules", accounts, cfg: { ...BURNING, burnPot: 5_000_000n } });
  const below = world({ kind: "buyback", accounts, treasury: 900_000n });                      // under the coin's own minimum of 1,000,000
  const ready = world({ kind: "buyback", accounts, treasury: 80_000_000n });
  const gone = world({ kind: "buyback", accounts, treasury: null });                           // no treasury account at all
  const tax = decodePool(key(), poolBytes({ hookProgram: PROGRAMS.hook_tax, hookKind: 2 }));
  const connection = fakeConnection(accounts, 5000n);
  const client = new HookpoolClient(connection);
  const pools = [empty, dust, full, below, ready, gone].map((w) => w.pool);
  const got = await readBurnCandidates(connection, client, PAYER, [...pools, tax], { minPot: 100_000n, slippageBps: 100 });
  assert.deepEqual(got.candidates.map((c) => [c.key, c.kind, c.run.step, c.run.pot]), [[full.address.toBase58(), "rules", "observe", 5_000_000n], [ready.address.toBase58(), "buyback", "observe", 80_000_000n]]);
  assert.equal(got.waiting, 3, "three pots hold something: the two above, and the dust the keeper leaves alone");
  assert.deepEqual(got.unread, []);
  // one read for the twelve accounts of six pools, then the SDK's own: two for the rules pool, one for the buyback pool
  assert.deepEqual(connection.calls, ["fresh:12", "many:3", "one", "fresh:4"]);
  // a pool whose config is missing is reported and does not stop the others
  accounts.delete(pda.cfg(PROGRAMS.hook_rules, empty.address).toBase58());
  const again = await readBurnCandidates(connection, client, PAYER, pools, { minPot: 100_000n });
  assert.deepEqual(again.unread.map((u) => u.pool), [empty.address.toBase58()]);
  assert.equal(again.candidates.length, 2);
  assert.deepEqual(await readBurnCandidates(connection, client, PAYER, [tax]), { candidates: [], unread: [], waiting: 0 });
});

test("planBurns: one call per pool, the larger pot first, failures after the others, a bounded pass", () => {
  const cand = (name, pot, step = "buy") => ({ key: name, pool: name, kind: "rules", run: { step, due: step !== "tooSoon", dueSlot: 5001n, pot, instructions: step === "tooSoon" ? [] : [name] } });
  const all = [cand("A", 2_000_000n), cand("B", 9_000_000n, "observe"), cand("C", 500_000n, "wait"), cand("D", 7_000_000n, "tooSoon"), cand("E", 50_000n), cand("F", 3_000_000n), { key: "G", pool: "G", kind: "buyback", run: null }];
  const plan = planBurns(all, {}, { maxCalls: 3, minPot: 100_000n });
  assert.deepEqual(plan.send.map((x) => [x.key, x.step]), [["B", "observe"], ["F", "buy"], ["A", "buy"]]);
  assert.deepEqual(plan.later.map((x) => x.key), ["C"]);
  assert.deepEqual(plan.tooSoon.map((x) => [x.key, x.dueSlot]), [["D", 5001n]]);
  assert.deepEqual(plan.keys, ["A", "B", "C", "D", "F"], "every pool with enough to spend, sent or not; E is under the minimum, G has nothing");
  // a pool that failed before goes last; one that rests after its alert is not tried
  const fails = { B: { count: 2, alerted: false, skip: 0 }, F: { count: 3, alerted: true, skip: 12 } };
  const second = planBurns(all, fails, { maxCalls: 10, minPot: 100_000n });
  assert.deepEqual(second.send.map((x) => x.key), ["A", "C", "B"]);
  assert.deepEqual(second.resting.map((x) => x.key), ["F"]);
  assert.deepEqual(planBurns([], {}), { keys: [], send: [], later: [], tooSoon: [], resting: [] });
});

// ---- what a call did -------------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
/// A confirmed transaction as getTransaction returns it, with the program's event as an inner instruction.
function txWith({ program = PROGRAMS.hook_rules, event = null, returnData = null, fee = 5000, cu = 76_000, slot = 5000 }) {
  const keys = [PAYER, program];
  const inner = event ? [{ index: 1, instructions: [{ programIdIndex: 1, accounts: [], data: bs58(Uint8Array.from([...EVENT_IX_TAG, ...event])) }] }] : [];
  return { slot, meta: { fee, computeUnitsConsumed: cu, innerInstructions: inner, logMessages: [], returnData }, transaction: { message: { staticAccountKeys: keys } } };
}
const retData = (program, outcome, spent, burned) => { const b = Buffer.alloc(17); b[0] = outcome; b.writeBigUInt64LE(spent, 1); b.writeBigUInt64LE(burned, 9); return { programId: program.toBase58(), data: [b.toString("base64"), "base64"] }; };

test("burnEffect: the outcome the chain reported, from the event or else from the return data", () => {
  const bought = burnEffect(txWith({ event: burnEventBytes({ quoteSpent: 500_000_000n, baseBurned: 4_900_000_000_000n, slot: 5000n, outcome: 3 }) }));
  assert.deepEqual(bought, { outcome: "bought", quoteSpent: 500_000_000n, baseBurned: 4_900_000_000_000n, slot: 5000n, feeLamports: 5000, computeUnits: 76_000, from: "event" });
  assert.equal(burnEffect(txWith({ event: burnEventBytes({ slot: 4975n, outcome: 1 }), cu: 23_300 })).outcome, "observed");
  assert.equal(burnEffect(txWith({ event: burnEventBytes({ slot: 5000n, outcome: 2 }) })).outcome, "waited");
  const buyback = burnEffect(txWith({ program: PROGRAMS.hook_buyback, event: burnEventBytes({ name: "BuybackExecuted", quoteSpent: 7n, baseBurned: 9n, slot: 5000n, outcome: 3 }) }));
  assert.equal(buyback.outcome, "bought"); assert.equal(buyback.quoteSpent, 7n); assert.equal(buyback.baseBurned, 9n);
  // no inner instructions served: the 17 bytes of return data say the same
  const fromData = burnEffect(txWith({ returnData: retData(PROGRAMS.hook_rules, 3, 500_000_000n, 4_900_000_000_000n) }));
  assert.equal(fromData.outcome, "bought"); assert.equal(fromData.quoteSpent, 500_000_000n); assert.equal(fromData.baseBurned, 4_900_000_000_000n); assert.equal(fromData.from, "return data");
  assert.equal(burnEffect(txWith({ returnData: retData(PROGRAMS.hook_buyback, 2, 0n, 0n) })).outcome, "waited");
  // return data of another program, an outcome that does not exist, no transaction
  assert.equal(burnEffect(txWith({ returnData: retData(PROGRAMS.hookpool, 3, 1n, 1n) })), null);
  assert.equal(burnEffect(txWith({ returnData: retData(PROGRAMS.hook_rules, 9, 1n, 1n) })), null);
  assert.equal(burnEffect(txWith({})), null);
  assert.equal(burnEffect(null), null);
});

test("burnAll and burnLine: one line per call with what the chain did; a refused call names the program's error", async () => {
  const item = (name, kind, step, pot) => ({ key: name, pool: name, kind, step, pot, run: { instructions: [name] } });
  const plan = [item("POOL1", "rules", "observe", 2_000_000_000n), item("POOL2", "buyback", "buy", 3_000_000_000n), item("POOL3", "rules", "buy", 900_000n), item("POOL4", "rules", "wait", 5_000_000n), item("POOL5", "buyback", "buy", 6_000_000n)];
  const effects = {
    SIG1: { outcome: "observed", quoteSpent: 0n, baseBurned: 0n, slot: 4975n, feeLamports: 5000, computeUnits: 23_300 },
    SIG2: { outcome: "bought", quoteSpent: 500_000_000n, baseBurned: 4_900_000_000_000n, slot: 5000n, feeLamports: 5000, computeUnits: 73_500 },
    SIG4: { outcome: "waited", quoteSpent: 0n, baseBurned: 0n, slot: 5000n, feeLamports: 5000, computeUnits: 24_600 },
  };
  const refused = Object.assign(new Error("Simulation failed."), { logs: ["Program log: AnchorError thrown in programs/hook_rules/src/lib.rs:901. Error Code: BurnTooSoon. Error Number: 6032. Error Message: the burn's observation of the pool is less than 25 slots old."] });
  const sent = [];
  const results = await burnAll({
    plan,
    send: async (it) => { sent.push(it.key); if (it.key === "POOL3") throw refused; return `SIG${it.key.slice(-1)}`; },
    readEffect: async (sig) => { if (sig === "SIG5") throw new Error("rpc down"); return effects[sig] ?? null; },
  });
  assert.deepEqual(sent, ["POOL1", "POOL2", "POOL3", "POOL4", "POOL5"], "a refused call does not stop the pass");
  assert.deepEqual(results.map((r) => [r.ok, r.signature]), [[true, "SIG1"], [true, "SIG2"], [false, null], [true, "SIG4"], [true, "SIG5"]]);
  assert.deepEqual(results.map(burnLine), [
    "burn: pool POOL1 (rules): observed, the pool is recorded and nothing is bought yet, pot 2000000000 lamports, next call from slot 5000, tx SIG1",
    "burn: pool POOL2 (buyback): bought, spent 500000000 lamports, burned 4900000000000 raw coins, 2500000000 lamports left in the pot, next call from slot 5025, tx SIG2",
    "burn FAILED: pool POOL3 (rules): a call expected to buy was not confirmed: BurnTooSoon (6032): the burn's observation of the pool is less than 25 slots old",
    "burn: pool POOL4 (rules): waited, the price is above the observation, the pool is recorded again and nothing is bought, pot 5000000 lamports, next call from slot 5025, tx SIG4",
    "burn: pool POOL5 (buyback): sent a call expected to buy, the result could not be read, tx SIG5",
  ]);
  for (const line of results.map(burnLine)) assert.ok(/^[\x20-\x7e]*$/.test(line), line);
  assert.equal(chainError(new Error("Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1790")), "Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1790");
  assert.equal(chainError(new Error('Simulation failed. Logs: ["Program log: AnchorError thrown in programs/hook_buyback/src/lib.rs:250. Error Code: TooSoon. Error Number: 6007. Error Message: too soon after the last observation.","Program x failed"]')), "TooSoon (6007): too soon after the last observation");
});

test("three strikes: a call that fails three passes in a row on one pool is one alert, then the pool rests", () => {
  const fail = (key, error = "BurnTooSoon (6032): too soon") => ({ key, pool: key, kind: "rules", ok: false, error, pot: 5_000_000n });
  const good = (key) => ({ key, pool: key, kind: "rules", ok: true, error: null, pot: 5_000_000n });
  let s = burnStrikes({}, ["A", "B"], [fail("A"), good("B")]);
  assert.deepEqual(s.fails, { A: { count: 1, alerted: false, skip: 0, error: "BurnTooSoon (6032): too soon" } });
  assert.deepEqual(s.alerts, []);
  // a pass that skips the pool because it is too soon neither counts nor clears
  s = burnStrikes(s.fails, ["A", "B"], []);
  assert.equal(s.fails.A.count, 1);
  s = burnStrikes(s.fails, ["A"], [fail("A")]);
  assert.equal(s.fails.A.count, 2); assert.deepEqual(s.alerts, []);
  s = burnStrikes(s.fails, ["A"], [fail("A", "Slippage (6008): output below min_amount_out")]);
  assert.equal(BURN_STRIKES, 3);
  assert.deepEqual(s.alerts, [{ key: "A", pool: "A", kind: "rules", count: 3, error: "Slippage (6008): output below min_amount_out", pot: "5000000" }]);
  assert.deepEqual(s.fails.A, { count: 3, alerted: true, skip: BURN_RETRY_ROUNDS - 1, error: "Slippage (6008): output below min_amount_out" });
  assert.equal(burnStuckMessage(s.alerts[0], "RSTAKE"), "the burn call failed 3 passes in a row on RSTAKE: Slippage (6008): output below min_amount_out. 5000000 lamports wait in its burn pot and are not being spent. Look at it.");
  assert.equal(burnStuckMessage({ ...s.alerts[0], kind: "buyback" }, null), "the burn call failed 3 passes in a row on pool A: Slippage (6008): output below min_amount_out. 5000000 lamports wait in its buyback treasury and are not being spent. Look at it.");
  // it rests: planBurns leaves it out, each pass counts the rest down, and no second alert follows
  assert.deepEqual(planBurns([{ key: "A", pool: "A", kind: "rules", run: { step: "buy", due: true, pot: 5_000_000n, instructions: [1] } }], s.fails).send, []);
  s = burnStrikes(s.fails, ["A"], []);
  assert.equal(s.fails.A.skip, BURN_RETRY_ROUNDS - 2); assert.deepEqual(s.alerts, []);
  s = burnStrikes({ A: { count: 3, alerted: true, skip: 0, error: "x" } }, ["A"], [fail("A")]);
  assert.deepEqual(s.alerts, [], "alerted once"); assert.equal(s.fails.A.count, 4); assert.equal(s.fails.A.skip, BURN_RETRY_ROUNDS - 1);
  // a confirmed call clears the pool; so does a pot with nothing left; an unread pool keeps its count
  assert.deepEqual(burnStrikes({ A: { count: 2, alerted: false, skip: 0, error: "x" } }, ["A"], [good("A")]).fails, {});
  assert.deepEqual(burnStrikes({ A: { count: 2, alerted: false, skip: 0, error: "x" } }, [], []).fails, {});
  assert.deepEqual(burnStrikes({ A: { count: 2, alerted: false, skip: 0, error: "x" } }, [], [], { unread: ["A"] }).fails, { A: { count: 2, alerted: false, skip: 0, error: "x" } });
});

test("totals, per pool numbers, /health, the settings and the state", () => {
  const results = [
    { key: "P1", signature: "S1", effect: { outcome: "observed", quoteSpent: 0n, baseBurned: 0n, feeLamports: 5000 } },
    { key: "P1", signature: "S2", effect: { outcome: "bought", quoteSpent: 500_000_000n, baseBurned: 9n, feeLamports: 5000 } },
    { key: "P2", signature: "S3", effect: { outcome: "waited", quoteSpent: 0n, baseBurned: 0n, feeLamports: 5000 } },
    { key: "P2", signature: null, effect: null },
    { key: "P3", signature: "S4", effect: null },
  ];
  const totals = addBurnTotals(NO_BURN_TOTALS(), results);
  assert.deepEqual(totals, { calls: 4, failed: 1, observed: 1, waited: 1, bought: 1, spentLamports: 500_000_000, feeLamports: 15_000 });
  assert.deepEqual(addBurnTotals(totals, [results[1]]), { calls: 5, failed: 1, observed: 1, waited: 1, bought: 2, spentLamports: 1_000_000_000, feeLamports: 20_000 });
  assert.equal(BURN_FEE_LAMPORTS, 5000);
  const stats = addBurnPoolStats({}, results, "2026-10-14T12:00:00.000Z");
  assert.deepEqual(stats.P1, { calls: 2, bought: 1, spentLamports: 500_000_000, lastAt: "2026-10-14T12:00:00.000Z", lastOutcome: "bought" });
  assert.deepEqual(stats.P2, { calls: 1, bought: 0, spentLamports: 0, lastAt: "2026-10-14T12:00:00.000Z", lastOutcome: "failed" });
  assert.equal(stats.P3.lastOutcome, null);

  const now = Date.parse("2026-10-14T12:00:00Z");
  const status = { updatedAt: "2026-10-14T11:59:50.000Z", pools: {} };
  const h = healthBody({ status, burn: { enabled: true, lastBurnAt: "2026-10-14T11:59:40.000Z", lastBurnSent: 2, intervalSeconds: 30, totals }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.equal(h.ok, true); assert.equal(h.burnEnabled, true); assert.equal(h.burnStale, false); assert.equal(h.lastBurnSent, 2);
  assert.deepEqual([h.burnCalls, h.burnFailed, h.burnObserved, h.burnWaited, h.burnBought, h.burnSpentLamports, h.burnFeesLamports], [4, 1, 1, 1, 1, 500_000_000, 15_000]);
  const stale = healthBody({ status, burn: { enabled: true, lastBurnAt: "2026-10-14T11:58:00.000Z", lastBurnSent: 0, intervalSeconds: 30, totals }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.equal(stale.burnStale, true); assert.equal(stale.ok, false, "three intervals without a pass");
  const off = healthBody({ status, burn: { enabled: false, lastBurnAt: null, lastBurnSent: 0, intervalSeconds: 30, totals: null }, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" });
  assert.equal(off.burnStale, false); assert.equal(off.ok, true); assert.equal(off.burnCalls, 0);
  assert.equal(healthBody({ status, nowMs: now, staleAfterMs: 300_000, cluster: "localnet" }).burnEnabled, false);

  const c = buildConfig({}, parseArgs([]), "/w");
  assert.deepEqual([c.burn, c.burnIntervalSeconds, c.burnMaxCalls, c.burnMinPotLamports, c.burnSlippageBps], [true, 30, 10, 100_000n, 100]);
  assert.ok(describeConfig(c).burnKeeper.startsWith("every 30 s, at most 10 calls a pass"));
  assert.equal(buildConfig({}, parseArgs(["--no-burn"]), "/w").burn, false);
  assert.equal(buildConfig({}, parseArgs(["--no-crank"]), "/w").burn, false);
  assert.equal(buildConfig({ BURN_KEEPER: "off" }, parseArgs([]), "/w").burn, false);
  assert.equal(buildConfig({ BURN_KEEPER: "ON" }, parseArgs([]), "/w").burn, true);
  const kept = buildConfig({}, parseArgs(["--no-burn"]), "/w");
  assert.deepEqual([kept.crank, kept.settle, kept.upkeep], [true, true, true], "--no-burn keeps the other cranks");
  assert.equal(buildConfig({}, parseArgs(["--no-settle"]), "/w").burn, true);
  assert.ok(describeConfig(kept).burnKeeper.startsWith("off"));
  const tuned = buildConfig({ BURN_INTERVAL_SECONDS: "12", BURN_MAX_CALLS: "3", BURN_MIN_POT_LAMPORTS: "2500000", BURN_SLIPPAGE_BPS: "50" }, parseArgs([]), "/w");
  assert.deepEqual([tuned.burnIntervalSeconds, tuned.burnMaxCalls, tuned.burnMinPotLamports, tuned.burnSlippageBps], [12, 3, 2_500_000n, 50]);
  assert.throws(() => buildConfig({ BURN_KEEPER: "maybe" }, parseArgs([])), /BURN_KEEPER/);
  assert.throws(() => buildConfig({ BURN_INTERVAL_SECONDS: "2" }, parseArgs([])), /below the minimum/);
  assert.throws(() => buildConfig({ BURN_MAX_CALLS: "0" }, parseArgs([])), /below the minimum/);
  assert.throws(() => buildConfig({ BURN_SLIPPAGE_BPS: "6000" }, parseArgs([])), /above the maximum/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-burn-"));
  const file = path.join(dir, "state.json");
  const s = emptyState();
  assert.deepEqual(s.burn, { fails: {}, totals: NO_BURN_TOTALS(), pools: {} });
  s.burn = { fails: { A: { count: 2, alerted: false, skip: 0, error: "x" } }, totals, pools: stats };
  saveState(file, s);
  assert.deepEqual(loadState(file).burn, s.burn);
  fs.writeFileSync(file, JSON.stringify({ version: 1, burn: { fails: [], totals: { calls: "many", bought: 2 }, pools: null } }));
  assert.deepEqual(loadState(file).burn, { fails: {}, totals: { ...NO_BURN_TOTALS(), bought: 2 }, pools: {} }, "a state file from an older version, or a bent one");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("burnView and the size of the two transactions", async () => {
  const obs = { obsSlot: 4975n, obsReserveBase: RB, obsReserveQuote: RQ };
  const r = world({ kind: "rules", cfg: { ...BURNING, burnPot: 2_000_000_000n, ...obs } });
  const seen = burnPot({ kind: "rules", pool: r.pool, cfgBytes: r.cfgData });
  const platform = { protocolFeeBps: 20, maxHookFeeBps: 1000 };
  assert.deepEqual(burnView({ kind: "rules", pool: r.pool, platform, cfg: seen.cfg, pot: seen.pot, slot: 5000 }), { pot: 2_000_000_000n, capBps: 50, step: "buy", observedAtSlot: 4975n, nextCallAtSlot: 5000n });
  assert.equal(burnView({ kind: "rules", pool: r.pool, platform, cfg: seen.cfg, pot: seen.pot, slot: 4999 }).step, "tooSoon");
  assert.equal(burnView({ kind: "rules", pool: r.pool, platform, cfg: seen.cfg, pot: 0n, slot: 5000 }).step, "nothing");
  const fresh = world({ kind: "buyback", treasury: 80_000_000n, cfg: { buyBps: 0, sellBps: 0 } });
  const b = burnPot({ kind: "buyback", pool: fresh.pool, cfgBytes: fresh.cfgData, treasuryBytes: new Uint8Array(fresh.accounts.get(fresh.treasuryKey.toBase58()).data) });
  // no fee at all: (20 + min(20, 220)) / 4 = 10 bps
  assert.deepEqual(burnView({ kind: "buyback", pool: fresh.pool, platform, cfg: b.cfg, pot: b.pot, slot: 5000 }), { pot: 80_000_000n, capBps: 10, step: "observe", observedAtSlot: null, nextCallAtSlot: null });

  // both calls fit in one packet without the lookup table
  for (const w of [r, world({ kind: "buyback", treasury: 80_000_000n, cfg: obs })]) {
    const run = (await candidatesOf(w)).candidates[0].run;
    assert.equal(run.step, "buy");
    const msg = new TransactionMessage({ payerKey: PAYER, recentBlockhash: OWNER.toBase58(), instructions: run.instructions }).compileToV0Message();
    const size = new VersionedTransaction(msg).serialize().length;
    assert.ok(size <= 1232, `${w.kind}: ${size} bytes`);
    assert.equal(msg.header.numRequiredSignatures, 1, "the keeper is the only signer");
  }
});
