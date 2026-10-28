import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { collectible } from "../../sdk/dist/index.js";
import { ticketsToReveal, anyWaiting, chunk, revealAll, summarizeTickets, diffBatches, expiredMessage, keeperBalanceAlert, canPayReveal, crankStale, batchKey, describeOutcome, REVEALS_PER_TX } from "../lib/crank.mjs";
import { healthBody } from "../lib/server.mjs";
import { poolEntry } from "../lib/status.mjs";
import { recentLevels } from "../lib/score.mjs";
import { parseArgs, buildConfig } from "../lib/config.mjs";
import { ticketBytes, POOL, OWNER, OTHER, BATCH_WAITING, BATCH_REVEALED, BATCH_EXPIRED } from "./bytes.mjs";

const T = (o) => collectible.decodeTicket(ticketBytes(o));
const W = (targetSlot, pieces = 1) => ({ state: BATCH_WAITING, pieces, targetSlot });
const seed = new Uint8Array(32).fill(7);
const users = Array.from({ length: 20 }, () => Keypair.generate().publicKey);

test("ticket bytes decode to the batch layout", () => {
  const t = T({ user: OTHER, minted: 3, rolls: 9, batches: [W(100n, 2), { state: BATCH_REVEALED, pieces: 1, mintedFrom: 1, firstRoll: 5, targetSlot: 90n, seed }] });
  assert.equal(t.pool.toBase58(), POOL.toBase58());
  assert.equal(t.user.toBase58(), OTHER.toBase58());
  assert.deepEqual([t.minted, t.rolls, t.pending, t.batches.length], [3, 9, 3, 4]);
  assert.deepEqual([t.batches[0].state, t.batches[0].pieces, t.batches[0].targetSlot], [1, 2, 100n]);
  assert.ok(t.batches[0].seed.every((b) => b === 0) && t.batches[1].seed.every((b) => b === 7));
  assert.equal(batchKey(t, t.batches[0]), `${POOL.toBase58()}:${OTHER.toBase58()}:100`);
});

test("which tickets need a reveal at a slot: waiting, target strictly passed, oldest first", () => {
  const a = T({ user: users[0], batches: [W(100n, 2)] });
  const b = T({ user: users[1], batches: [W(105n)] });
  const c = T({ user: users[2], batches: [{ state: BATCH_REVEALED, pieces: 2, targetSlot: 90n, seed }] });
  const e = T({ user: users[3], batches: [W(110n, 1), W(98n, 3)] });
  const x = T({ user: users[4], batches: [{ state: BATCH_EXPIRED, pieces: 1, targetSlot: 10n, seed }] });
  const all = [a, b, c, e, x];
  assert.deepEqual(ticketsToReveal(all, 98n), []);
  assert.deepEqual(ticketsToReveal(all, 100n).map((t) => t.user.toBase58()), [users[3].toBase58()]);
  assert.deepEqual(ticketsToReveal(all, 101n).map((t) => t.user.toBase58()), [users[3].toBase58(), users[0].toBase58()]);
  const late = ticketsToReveal(all, 111n);
  assert.deepEqual(late.map((t) => t.user.toBase58()), [users[3].toBase58(), users[0].toBase58(), users[1].toBase58()]);
  assert.deepEqual([late[0].pieces, late[0].targetSlots.length, late[0].oldestTarget], [4, 2, 98n]);
});

test("a batch waiting for its reveal keeps the crank reading; revealed pieces waiting to be minted do not", () => {
  const revealed = T({ user: users[5], batches: [{ state: BATCH_REVEALED, pieces: 2, targetSlot: 90n, seed }] });
  const expired = T({ user: users[6], batches: [{ state: BATCH_EXPIRED, pieces: 1, targetSlot: 10n, seed }] });
  const waiting = T({ user: users[7], batches: [W(200n, 1)] });
  assert.ok(revealed.pending > 0, "pieces still to mint");
  assert.equal(anyWaiting([revealed, expired]), false);
  assert.equal(anyWaiting([revealed, waiting]), true);
  assert.equal(anyWaiting([]), false);
});

test("reveals are packed 8 per transaction", () => {
  assert.equal(REVEALS_PER_TX, 8);
  assert.deepEqual(chunk(Array.from({ length: 17 }, (_, i) => i)).map((g) => g.length), [8, 8, 1]);
  assert.deepEqual(chunk([]), []);
  assert.deepEqual(chunk([1, 2, 3]).map((g) => g.length), [3]);
});

test("a failing transaction is retried one ticket at a time: one bad ticket never stops the others", async () => {
  const due = ticketsToReveal(users.slice(0, 10).map((u) => T({ user: u, batches: [W(50n)] })), 60n);
  const bad = due[3].user.toBase58();
  const calls = [];
  const send = async (group) => { calls.push(group.length); if (group.some((t) => t.user.toBase58() === bad)) throw new Error("boom"); return `sig${calls.length}`; };
  const r = await revealAll({ due, send, log: null });
  assert.deepEqual(calls, [8, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
  assert.equal(r.done.length, 9);
  assert.deepEqual(r.failed.map((t) => [t.user.toBase58(), t.error]), [[bad, "boom"]]);
  assert.ok(r.done.every((t) => typeof t.signature === "string"));
});

test("per pool ticket summary: open, undecided, awaitingReveal, expired", () => {
  const tickets = [
    T({ user: users[0], batches: [W(100n, 2), W(200n, 1)] }),
    T({ user: users[1], batches: [{ state: BATCH_REVEALED, pieces: 3, targetSlot: 90n, seed }] }),
    T({ user: users[2], batches: [{ state: BATCH_EXPIRED, pieces: 2, targetSlot: 10n, seed }] }),
    T({ user: users[3], pool: OTHER, batches: [W(100n, 5)] }),
    T({ user: users[4], batches: [{ state: BATCH_REVEALED, pieces: 0, mintedFrom: 2, targetSlot: 80n, seed }] }),
  ];
  const s = summarizeTickets(tickets, 150n);
  assert.deepEqual(s.get(POOL.toBase58()), { open: 3, undecided: 1, awaitingReveal: 2, expired: 2 });
  assert.deepEqual(s.get(OTHER.toBase58()), { open: 1, undecided: 0, awaitingReveal: 5, expired: 0 });
  assert.deepEqual(summarizeTickets(tickets, 100n).get(POOL.toBase58()), { open: 3, undecided: 3, awaitingReveal: 0, expired: 2 });
});

test("expired diff: one event per batch, only for a batch seen waiting before", () => {
  const waiting = T({ user: users[0], batches: [W(100n, 2)] });
  const key = batchKey(waiting, waiting.batches[0]);
  const first = diffBatches({}, [waiting]);
  assert.deepEqual(first, { seen: { [key]: "waiting" }, expired: [] });
  const gone = T({ user: users[0], batches: [{ state: BATCH_EXPIRED, pieces: 2, targetSlot: 100n, seed }] });
  const second = diffBatches(first.seen, [gone]);
  assert.deepEqual(second.expired, [{ pool: POOL.toBase58(), user: users[0].toBase58(), targetSlot: "100", pieces: 2 }]);
  assert.deepEqual(second.seen, { [key]: "expired" });
  assert.deepEqual(diffBatches(second.seen, [gone]), { seen: { [key]: "expired" }, expired: [] });
  // revealed in time: the key is dropped and nothing is raised
  const ok = T({ user: users[0], batches: [{ state: BATCH_REVEALED, pieces: 2, targetSlot: 100n, seed }] });
  assert.deepEqual(diffBatches(first.seen, [ok]), { seen: {}, expired: [] });
  // expired before the watcher ever saw it waiting: nothing raised, nothing kept
  assert.deepEqual(diffBatches({}, [gone]), { seen: {}, expired: [] });
  // the ticket was minted out and is no longer listed
  assert.deepEqual(diffBatches(second.seen, []), { seen: {}, expired: [] });
  assert.equal(expiredMessage(second.expired[0], "SHOT"), `2 pieces expired unrevealed on SHOT: the keeper was not revealing in time (wallet ${users[0].toBase58()}, decided by slot 100)`);
  assert.ok(expiredMessage({ ...second.expired[0], pieces: 1 }, null).startsWith(`1 piece expired unrevealed on pool ${POOL.toBase58()}:`));
});

test("balance rule: danger below KEEPER_MIN_LAMPORTS, never on localnet", () => {
  const a = { lamports: 9_999_999n, minLamports: 10_000_000n, address: OWNER.toBase58() };
  assert.equal(keeperBalanceAlert({ cluster: "localnet", ...a }), null);
  assert.equal(keeperBalanceAlert({ cluster: "mainnet", ...a }).level, "danger");
  assert.ok(keeperBalanceAlert({ cluster: "devnet", ...a }).message.includes("holds 0.0100 SOL, below the minimum 0.0100 SOL"));
  assert.equal(keeperBalanceAlert({ cluster: "mainnet", ...a, lamports: 10_000_000n }), null);
  assert.equal(canPayReveal(4999n), false);
  assert.equal(canPayReveal(5000n), true);
});

test("health: lastCrankAt and lastCrankRevealed, stale when the crank has not run for 3 intervals", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const at = (s) => new Date(now - s * 1000).toISOString();
  assert.equal(crankStale({ enabled: true, lastCrankAt: at(60), nowMs: now, intervalSeconds: 20 }), false);
  assert.equal(crankStale({ enabled: true, lastCrankAt: at(61), nowMs: now, intervalSeconds: 20 }), true);
  assert.equal(crankStale({ enabled: true, lastCrankAt: null, nowMs: now, intervalSeconds: 20 }), true);
  assert.equal(crankStale({ enabled: false, lastCrankAt: null, nowMs: now, intervalSeconds: 20 }), false);
  const status = { updatedAt: at(30), pools: { P1: {}, P2: {} } };
  const fresh = healthBody({ status, crank: { enabled: true, lastCrankAt: at(5), lastCrankRevealed: 3, intervalSeconds: 20 }, nowMs: now, staleAfterMs: 300000, cluster: "localnet" });
  assert.deepEqual([fresh.ok, fresh.stale, fresh.pools, fresh.lastCrankAt, fresh.lastCrankRevealed, fresh.crankStale], [true, false, 2, at(5), 3, false]);
  const stuck = healthBody({ status, crank: { enabled: true, lastCrankAt: at(90), lastCrankRevealed: 0, intervalSeconds: 20 }, nowMs: now, staleAfterMs: 300000, cluster: "localnet" });
  assert.deepEqual([stuck.ok, stuck.stale, stuck.crankStale], [false, true, true]);
  const off = healthBody({ status, crank: { enabled: false, lastCrankAt: null, lastCrankRevealed: 0, intervalSeconds: 20 }, nowMs: now, staleAfterMs: 300000, cluster: "localnet" });
  assert.deepEqual([off.ok, off.lastCrankAt, off.crankEnabled], [true, null, false]);
});

test("status, score and settings carry the crank", () => {
  assert.deepEqual(poolEntry({ template: "collectible", tickets: { open: 2, undecided: 1, awaitingReveal: 0, expired: 3, extra: 9 } }).tickets, { open: 2, undecided: 1, awaitingReveal: 0, expired: 3 });
  assert.equal("tickets" in poolEntry({ template: "tax" }), false);
  const now = Date.parse("2026-10-04T12:00:00Z");
  assert.deepEqual(recentLevels([{ time: "2026-10-04T11:00:00Z", level: "warning", keeper: true }, { time: "2026-10-04T11:00:00Z", level: "info" }], now), ["info"]);
  const c = buildConfig({}, parseArgs([]), "/w");
  assert.deepEqual([c.revealIntervalSeconds, c.keeperMinLamports, c.crank], [20, 10_000_000n, true]);
  assert.equal(buildConfig({}, parseArgs(["--once", "--no-crank"]), "/w").crank, false);
  assert.throws(() => buildConfig({ REVEAL_INTERVAL_SECONDS: "120" }, parseArgs([])), /above the maximum/);
  const after = T({ user: users[0], batches: [{ state: BATCH_REVEALED, pieces: 2, targetSlot: 100n, seed }] });
  assert.equal(describeOutcome(after, [100n]), "slot 100: REVEALED, seed 0707070707070707...");
});
