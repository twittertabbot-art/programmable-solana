import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { collectible, PROGRAMS } from "../../sdk/dist/index.js";
import {
  planSettles, settleInstructions, settleEffect, settleRemoved, settleAll, settleLine, settleStrikes, settleStuckMessage, settleKey,
  addSettleTotals, NO_SETTLE_TOTALS, readUnbacked, keeperBalanceAlert,
  MAX_BURNS_PER_SETTLE, SETTLES_PER_PASS, SETTLE_STRIKES, SETTLE_RETRY_ROUNDS, SETTLE_COMPUTE_UNITS,
} from "../lib/crank.mjs";
import { healthBody } from "../lib/server.mjs";
import { parseArgs, buildConfig, describeConfig } from "../lib/config.mjs";
import { loadState, saveState, emptyState } from "../lib/state.mjs";
import { ticketBytes, collectionConfig, tokenAccountBytes, pieceBurnedLog, piecesCancelledLog, POOL, OWNER, OTHER, BASE_MINT, TOKEN_PROGRAM, BATCH_WAITING, BATCH_REVEALED } from "./bytes.mjs";

const UNIT = 50_000_000_000_000n;
const key = () => Keypair.generate().publicKey;
const keys = (n) => Array.from({ length: n }, key);
const b58s = (list) => list.map((k) => k.toBase58());
const T = (o) => collectible.decodeTicket(ticketBytes(o));
const W = (pieces, firstRoll = 0) => ({ state: BATCH_WAITING, pieces, firstRoll, targetSlot: 100n + BigInt(firstRoll) });
const coinsOf = (user) => collectible.coinsAddress(user, BASE_MINT, TOKEN_PROGRAM);
/// One entry of the SDK's fetchUnbacked, built by the SDK's own peg rule.
const U = (ticket, balance) => ({ ticket, coins: coinsOf(ticket.user), balance, peg: collectible.pegStatus(ticket, balance, UNIT) });

/// A token account as the RPC returns it, at the wallet's own address for the coin: the program that owns the
/// account, then mint, owner and amount in its data. `over` bends one of them.
const acct = (user, amount, over = {}) => [coinsOf(user).toBase58(), {
  owner: over.program ?? TOKEN_PROGRAM,
  data: Buffer.from(tokenAccountBytes({ mint: over.mint ?? BASE_MINT, owner: over.owner ?? user, amount })),
}];

/// A connection that answers from memory, with accounts shaped like the real ones. Tickets are served as the
/// hook's program accounts, the collection config of each pool in `cfgs` (pool address -> bytes; by default the
/// one of POOL) and token accounts by address (null when the account does not exist).
function fakeConnection({ tickets, balances, cfg = collectionConfig({ unit: UNIT }), cfgs = null }) {
  const calls = { programAccounts: 0, multiple: 0 };
  const hook = PROGRAMS.hook_collectible;
  const configs = new Map(Object.entries(cfgs ?? { [POOL.toBase58()]: cfg }).filter(([, v]) => v).map(([p, v]) => [collectible.collectiblePda.cfg(new PublicKey(p)).toBase58(), { owner: hook, data: Buffer.from(v) }]));
  return {
    calls,
    async getAccountInfo() { return cfg ? { owner: hook, data: Buffer.from(cfg) } : null; },
    async getProgramAccounts() { calls.programAccounts += 1; return tickets.map((data) => ({ pubkey: key(), account: { owner: hook, data: Buffer.from(data) } })); },
    async getMultipleAccountsInfo(list) { calls.multiple += 1; return list.map((k) => configs.get(k.toBase58()) ?? balances.get(k.toBase58()) ?? null); },
  };
}

/// The program's settle in a few lines, to replay rounds offline. Waiting pieces are dropped newest first. Then
/// it burns the LAST piece of the wallet's list while that piece is among the accounts passed and the wallet is
/// above the peg, and stops otherwise. The order of the accounts does not matter. A piece that is not the last
/// one is never burned: the transaction succeeds and removes nothing.
function programSettle(t, balance, burn) {
  const allowed = Number(balance / UNIT);
  let excess = Math.max(0, t.owned.length + t.pending - allowed);
  let dropped = 0;
  const batches = t.batches.map((b) => ({ ...b }));
  while (excess > 0) {
    const waiting = batches.filter((b) => b.pieces > 0);
    if (!waiting.length) break;
    const newest = waiting.reduce((m, b) => (b.firstRoll > m.firstRoll ? b : m));
    const take = Math.min(newest.pieces, excess);
    newest.pieces -= take; dropped += take; excess -= take;
  }
  const owned = [...t.owned];
  const burned = [];
  while (excess > 0 && owned.length) {
    const last = owned[owned.length - 1];
    if (!burn.some((asset) => asset.equals(last))) break;
    burned.push(owned.pop()); excess -= 1;
  }
  return { ticket: { ...t, batches, owned, pending: batches.reduce((n, b) => n + b.pieces, 0) }, dropped, burned };
}

test("ticket and peg: the owned list decodes in the wallet's order, the end of the list burns first", () => {
  const [a, b, c] = keys(3);
  const t = T({ user: OTHER, minted: 5, rolls: 9, owned: [a, b, c], batches: [W(2, 7)] });
  assert.deepEqual(b58s(t.owned), b58s([a, b, c]));
  assert.deepEqual([t.minted, t.rolls, t.pending], [5, 9, 2]);
  // five pieces held, coins for two: both waiting pieces go first, then one minted piece, the last of the list
  const peg = collectible.pegStatus(t, UNIT * 2n, UNIT);
  assert.deepEqual([peg.allowed, peg.held, peg.dropWaiting, b58s(peg.burn)], [2, 5, 2, b58s([c])]);
  // coins gone: everything goes, last piece first
  assert.deepEqual(b58s(collectible.pegStatus(t, 0n, UNIT).burn), b58s([c, b, a]));
  // a ticket in the layout without pieces decodes to an empty list
  assert.deepEqual(T({ user: OTHER }).owned, []);
});

test("which wallets get settled: only the ones above the peg, a backed wallet is never touched", async () => {
  const [backed, twoOver, waitingOnly, closed, empty, exact, oneShort, handed] = keys(8);
  const o = { twoOver: keys(3), closed: keys(2), oneShort: keys(1), handed: keys(1) };
  const tickets = [
    ticketBytes({ user: backed, owned: keys(2) }),
    ticketBytes({ user: twoOver, owned: o.twoOver }),
    ticketBytes({ user: waitingOnly, owned: keys(1), batches: [W(2, 4)] }),
    ticketBytes({ user: closed, owned: o.closed, batches: [{ state: BATCH_REVEALED, pieces: 1, firstRoll: 3, targetSlot: 90n, seed: new Uint8Array(32).fill(7) }] }),
    ticketBytes({ user: empty }),
    ticketBytes({ user: exact, owned: keys(1) }),
    ticketBytes({ user: oneShort, owned: o.oneShort }),
    ticketBytes({ user: handed, owned: o.handed }),
  ];
  const balances = new Map([
    acct(backed, UNIT * 2n + UNIT / 2n),   // 2.5 units behind 2 pieces
    acct(twoOver, UNIT),                  // 1 unit behind 3 pieces
    acct(waitingOnly, UNIT),              // 1 unit behind 1 minted + 2 waiting
    // closed: its token account does not exist any more, the balance counts as zero
    acct(exact, UNIT),                    // exactly 1 unit behind 1 piece
    acct(oneShort, UNIT - 1n),            // one raw coin short of a unit
    // handed: the account still sits at the wallet's address with 2 units in it, but its owner field names
    // another wallet now. The coins are not this wallet's any more, so they back nothing.
    acct(handed, UNIT * 2n, { owner: OTHER }),
  ]);
  const connection = fakeConnection({ tickets, balances });
  const { unbacked, unread } = await readUnbacked(connection, [POOL]);
  assert.deepEqual(unread, []);
  // one read of every ticket of the hook, one batched read of the configs, one of the balances
  assert.deepEqual([connection.calls.programAccounts, connection.calls.multiple], [1, 2]);
  const plan = planSettles(unbacked);
  const by = new Map(plan.send.map((it) => [it.user.toBase58(), it]));
  assert.deepEqual([...by.keys()].sort(), b58s([twoOver, waitingOnly, closed, oneShort, handed]).sort());
  for (const untouched of [backed, empty, exact]) assert.equal(by.has(untouched.toBase58()), false);
  const row = (u) => { const it = by.get(u.toBase58()); return [it.allowed, it.held, it.dropWaiting, b58s(it.burn), it.burnLater]; };
  assert.deepEqual(row(twoOver), [1, 3, 0, b58s([o.twoOver[2], o.twoOver[1]]), 0]);
  assert.deepEqual(row(waitingOnly), [1, 3, 2, [], 0]);
  assert.deepEqual(row(closed), [0, 3, 1, b58s([o.closed[1], o.closed[0]]), 0]);
  assert.deepEqual(row(oneShort), [0, 1, 0, b58s(o.oneShort), 0]);
  // the handed account counts as zero coins and its piece is settled
  assert.deepEqual(row(handed), [0, 1, 0, b58s(o.handed), 0]);
  assert.equal(by.get(handed.toBase58()).balance, 0n);
  const it = by.get(twoOver.toBase58());
  assert.deepEqual([it.pool.toBase58(), it.coins.toBase58(), it.balance, it.key], [POOL.toBase58(), coinsOf(twoOver).toBase58(), UNIT, settleKey(POOL, twoOver)]);
  assert.deepEqual([plan.later, plan.resting, plan.keys.length], [[], [], 5]);
});

test("backing is read the way the program reads it: the coin's token program, this coin, this wallet", () => {
  const user = key();
  const [, good] = acct(user, UNIT * 3n);
  const of = (info) => collectible.backingOf(info, user, BASE_MINT, TOKEN_PROGRAM);
  assert.equal(of(good), UNIT * 3n);
  assert.equal(of(null), 0n);
  assert.equal(of(acct(user, UNIT * 3n, { owner: OTHER })[1]), 0n);      // handed to another owner
  assert.equal(of(acct(user, UNIT * 3n, { mint: OTHER })[1]), 0n);       // another coin
  assert.equal(of(acct(user, UNIT * 3n, { program: OTHER })[1]), 0n);    // not a token account of the coin's program
  assert.equal(of({ owner: TOKEN_PROGRAM, data: good.data.subarray(0, 70) }), 0n);
});

test("a pool whose config cannot be read never stops the others; a failed read leaves the pass for the next", async () => {
  const user = key();
  const bad = key();
  const garbage = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const good = fakeConnection({ tickets: [ticketBytes({ user, owned: keys(1) }), ticketBytes({ pool: bad, user: key(), owned: keys(1) })], balances: new Map(), cfgs: { [POOL.toBase58()]: collectionConfig({ unit: UNIT }), [bad.toBase58()]: garbage } });
  const { unbacked, unread } = await readUnbacked(good, [bad, POOL]);
  assert.deepEqual(unread.map((u) => u.pool), [bad.toBase58()]);
  assert.deepEqual(unbacked.map((u) => u.ticket.user.toBase58()), [user.toBase58()]);
  // three pools cost what one costs: one read of the tickets, one of the configs, one of the balances
  assert.deepEqual([good.calls.programAccounts, good.calls.multiple], [1, 2]);
  // the RPC fails: every pool is unread for this pass, with the error on one line, and nothing is settled
  const down = { ...good, async getMultipleAccountsInfo() { throw new Error("429 Too Many Requests\n  retry later"); } };
  const r = await readUnbacked(down, [bad, POOL]);
  assert.deepEqual(r.unread, [{ pool: bad.toBase58(), error: "429 Too Many Requests retry later" }, { pool: POOL.toBase58(), error: "429 Too Many Requests retry later" }]);
  assert.deepEqual(r.unbacked, []);
  // a pool whose config account is missing has nothing to settle
  assert.deepEqual(await readUnbacked(fakeConnection({ tickets: [], balances: new Map(), cfg: null }), [POOL]), { unbacked: [], unread: [] });
  // no pool, no read at all
  const idle = fakeConnection({ tickets: [], balances: new Map() });
  assert.deepEqual(await readUnbacked(idle, []), { unbacked: [], unread: [] });
  assert.deepEqual([idle.calls.programAccounts, idle.calls.multiple], [0, 0]);
});

test("burn order and batching across rounds: six burns per settle, the end of the list first, until backed", () => {
  assert.equal(MAX_BURNS_PER_SETTLE, 6);
  const p = keys(8);
  let ticket = T({ user: OTHER, minted: 8, owned: p, batches: [W(1, 20), W(1, 21)] });
  const balance = UNIT + 5n;   // coins for one piece: 2 waiting to drop, 7 minted to burn
  const rounds = [];
  for (let round = 0; round < 10; round++) {
    const peg = collectible.pegStatus(ticket, balance, UNIT);
    if (peg.dropWaiting === 0 && peg.burn.length === 0) break;
    const plan = planSettles([{ ticket, coins: coinsOf(OTHER), balance, peg }]);
    assert.equal(plan.send.length, 1);
    const item = plan.send[0];
    const done = programSettle(ticket, balance, item.burn);
    rounds.push({ sentBurn: b58s(item.burn), burnLater: item.burnLater, dropWaiting: item.dropWaiting, dropped: done.dropped, burned: b58s(done.burned) });
    ticket = done.ticket;
  }
  assert.equal(rounds.length, 2);
  // round 1: both waiting pieces dropped, the last six of the list burned, newest first; one burn left over
  assert.deepEqual(rounds[0], { sentBurn: b58s([p[7], p[6], p[5], p[4], p[3], p[2]]), burnLater: 1, dropWaiting: 2, dropped: 2, burned: b58s([p[7], p[6], p[5], p[4], p[3], p[2]]) });
  // round 2: a fresh read gives the one burn that was left
  assert.deepEqual(rounds[1], { sentBurn: b58s([p[1]]), burnLater: 0, dropWaiting: 0, dropped: 0, burned: b58s([p[1]]) });
  // the wallet keeps exactly what its coins back: the piece it put first
  assert.deepEqual([b58s(ticket.owned), ticket.pending], [b58s([p[0]]), 0]);

  // fourteen burns take three rounds: 6, 6, 2
  const q = keys(14);
  let big = T({ user: OWNER, minted: 14, owned: q });
  const sizes = [];
  for (;;) {
    const peg = collectible.pegStatus(big, 0n, UNIT);
    if (!peg.burn.length) break;
    const item = planSettles([{ ticket: big, coins: coinsOf(OWNER), balance: 0n, peg }]).send[0];
    sizes.push([item.burn.length, item.burnLater]);
    big = programSettle(big, 0n, item.burn).ticket;
  }
  assert.deepEqual(sizes, [[6, 8], [6, 2], [2, 0]]);
  assert.deepEqual(big.owned, []);

});

test("the settle rule: the tail of the list burns in any order, a piece that is not the last burns nothing", () => {
  const p = keys(8);
  const t = T({ user: OWNER, minted: 8, owned: p });
  const tail = planSettles([U(t, 0n)]).send[0].burn;
  assert.deepEqual(b58s(tail), b58s([p[7], p[6], p[5], p[4], p[3], p[2]]));
  // the same six accounts in another order: the program still burns the last of the list, six times
  const shuffled = [tail[3], tail[0], tail[5], tail[1], tail[4], tail[2]];
  const any = programSettle(t, 0n, shuffled);
  assert.deepEqual([b58s(any.burned), b58s(any.ticket.owned)], [b58s(tail), b58s([p[0], p[1]])]);
  // pieces that are not the last of the list: the settle goes through and removes nothing
  const miss = programSettle(t, 0n, [p[0], p[3]]);
  assert.deepEqual([miss.dropped, miss.burned, miss.ticket.owned.length], [0, [], 8]);
  // a gap in the tail stops the burning there: p7 and p6 burn, p5 was not passed, so p4 stays
  assert.deepEqual(b58s(programSettle(t, 0n, [p[7], p[6], p[4]]).burned), b58s([p[7], p[6]]));
  // a backed wallet loses nothing, whatever is passed
  assert.deepEqual(programSettle(t, UNIT * 8n, [...p]).burned, []);

  // The list grew between the watcher's read and its settle (a piece was sent to the wallet with its coins).
  // The new last piece is not among the accounts, so nothing burns. The watcher sees a confirmed settle that
  // removed nothing, counts the round as failed, and the next round, planned from a fresh read, burns it.
  const two = T({ user: OWNER, minted: 2, owned: [p[0], p[1]] });
  const stale = planSettles([U(two, 0n)]).send[0];
  const grown = { ...two, owned: [p[0], p[1], p[2]] };
  const first = programSettle(grown, UNIT, stale.burn);
  assert.deepEqual([first.dropped, first.burned], [0, []]);
  assert.equal(settleRemoved({ dropped: first.dropped, burned: first.burned.length, rentLamports: 0, feeLamports: 5000 }), false);
  const k = settleKey(POOL, OWNER);
  const strike = settleStrikes({}, [k], [{ key: k, pool: POOL, user: OWNER, ok: false, error: "the settle was confirmed but removed nothing" }]);
  assert.deepEqual([strike.fails[k].count, strike.alerts], [1, []]);
  const fresh = planSettles([U(grown, UNIT)], strike.fails).send[0];
  assert.deepEqual(b58s(fresh.burn), b58s([p[2], p[1]]));
  const second = programSettle(grown, UNIT, fresh.burn);
  assert.deepEqual([b58s(second.burned), b58s(second.ticket.owned)], [b58s([p[2], p[1]]), b58s([p[0]])]);
  assert.deepEqual(settleStrikes(strike.fails, [k], [{ key: k, pool: POOL, user: OWNER, ok: true, error: null }]), { fails: {}, alerts: [] });
});

test("one settle per transaction stays far below the 1,232 byte limit, even without the lookup table", () => {
  const payer = Keypair.generate();
  const item = { pool: POOL, user: OTHER, coins: coinsOf(OTHER), burn: keys(MAX_BURNS_PER_SETTLE) };
  const ixs = settleInstructions(payer.publicKey, item);
  assert.equal(ixs.length, 2);
  assert.equal(SETTLE_COMPUTE_UNITS, 400_000);
  // 8 fixed accounts of the settle, then the pieces to burn in the order given
  assert.deepEqual(b58s(ixs[1].keys.slice(8).map((k) => k.pubkey)), b58s(item.burn));
  assert.equal(ixs[1].keys[0].pubkey.toBase58(), payer.publicKey.toBase58());
  assert.ok(ixs[1].keys[0].isSigner && ixs[1].keys[0].isWritable);
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message([]);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const size = tx.serialize().length;
  // 1 signature (65 bytes), 16 account keys (512), the blockhash (32), two short instructions: 649 bytes with
  // the most burns one settle takes. The lookup table only makes it smaller.
  assert.equal(size, 649);
  assert.ok(size <= 1232);
});

test("what a settle did is read from its own transaction: events and the keeper's balance", () => {
  const meta = {
    fee: 5000, computeUnitsConsumed: 61234,
    preBalances: [2_000_000_000, 1, 2], postBalances: [2_003_109_400, 1, 2],
    logMessages: [
      "Program ComputeBudget111111111111111111111111111111 invoke [1]",
      "Program log: Instruction: Settle",
      piecesCancelledLog({ pieces: 3 }),
      pieceBurnedLog({ asset: OTHER }),
      "Program data: bm90IGFuIGV2ZW50",
      pieceBurnedLog({ asset: OWNER }),
      "Program 3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m success",
    ],
  };
  const e = settleEffect(meta);
  // rent received = balance after - balance before + fee
  assert.deepEqual(e, { dropped: 3, burned: 2, rentLamports: 3_114_400, feeLamports: 5000, computeUnits: 61234 });
  assert.equal(settleRemoved(e), true);
  const noop = settleEffect({ fee: 5000, preBalances: [10_000], postBalances: [5_000], logMessages: [] });
  assert.deepEqual([noop.dropped, noop.burned, noop.rentLamports, settleRemoved(noop)], [0, 0, 0, false]);
  assert.equal(settleEffect(null), null);
  assert.equal(settleRemoved(null), true);
});

test("a settle that fails is recorded once and the pass moves on to the next wallet", async () => {
  const users = keys(4);
  const tickets = users.map((u) => T({ user: u, owned: keys(1) }));
  const plan = planSettles(tickets.map((t) => U(t, 0n))).send;
  const order = [];
  const send = async (item) => {
    order.push(item.user.toBase58());
    if (item.user.equals(users[1])) throw new Error("Simulation failed.\nMessage: custom program error: 0x1773.\nLogs: [...]");
    return `sig-${order.length}`;
  };
  const readEffect = async (signature) => {
    if (signature === "sig-3") return { dropped: 0, burned: 0, rentLamports: 0, feeLamports: 5000, computeUnits: 9000 };
    if (signature === "sig-4") throw new Error("rpc hiccup");
    return { dropped: 0, burned: 1, rentLamports: 1_559_040, feeLamports: 5000, computeUnits: 40000 };
  };
  const results = await settleAll({ plan, send, readEffect });
  assert.deepEqual(order, b58s(users));
  assert.deepEqual(results.map((r) => [r.ok, r.signature, r.error]), [
    [true, "sig-1", null],
    [false, null, "Simulation failed. Message: custom program error: 0x1773. Logs: [...]"],
    [false, "sig-3", "the settle was confirmed but removed nothing"],
    [true, "sig-4", null],
  ]);
  // one line per settle: pool, wallet, pieces dropped, pieces burned, signature
  const lines = results.map(settleLine);
  assert.equal(lines[0], `settle: pool ${POOL.toBase58()} wallet ${users[0].toBase58()}: dropped 0, burned 1, rent received 1559040 lamports, tx sig-1`);
  assert.equal(lines[1], `settle FAILED: pool ${POOL.toBase58()} wallet ${users[1].toBase58()}: Simulation failed. Message: custom program error: 0x1773. Logs: [...]`);
  assert.ok(lines[2].endsWith("tx sig-3. Nothing was removed: somebody else settled it first, or the wallet changed in the meantime."));
  assert.equal(lines[3], `settle: pool ${POOL.toBase58()} wallet ${users[3].toBase58()}: sent to drop 0 and burn 1, the result could not be read, tx sig-4`);
  assert.equal(settleLine({ ...results[0], burnLater: 2 }), `${lines[0]}. 2 more to burn next round.`);
  for (const l of lines) assert.ok(/^[\x20-\x7e]*$/.test(l), l);
  // totals: confirmed transactions, pieces, rent received and fees paid
  const totals = addSettleTotals(NO_SETTLE_TOTALS(), results);
  assert.deepEqual(totals, { sent: 3, failed: 1, dropped: 0, burned: 1, rentLamports: 1_559_040, feeLamports: 10_000 });
  assert.deepEqual(addSettleTotals(totals, results.slice(0, 1)), { sent: 4, failed: 1, dropped: 0, burned: 2, rentLamports: 3_118_080, feeLamports: 15_000 });
});

test("three strikes: one alert after three failed rounds in a row, once, and then the wallet rests", () => {
  assert.deepEqual([SETTLE_STRIKES, SETTLE_RETRY_ROUNDS], [3, 30]);
  const user = key();
  const k = settleKey(POOL, user);
  const fail = { key: k, pool: POOL, user, ok: false, error: "custom program error: 0x1773" };
  const ok = { ...fail, ok: true, error: null };
  let s = settleStrikes({}, [k], [fail]);
  assert.deepEqual(s, { fails: { [k]: { count: 1, alerted: false, skip: 0, error: fail.error } }, alerts: [] });
  s = settleStrikes(s.fails, [k], [fail]);
  assert.deepEqual([s.fails[k].count, s.alerts.length], [2, 0]);
  s = settleStrikes(s.fails, [k], [fail]);
  assert.deepEqual(s.alerts, [{ key: k, pool: POOL.toBase58(), user: user.toBase58(), count: 3, error: fail.error }]);
  assert.deepEqual(s.fails[k], { count: 3, alerted: true, skip: 29, error: fail.error });
  const text = settleStuckMessage(s.alerts[0], "SHOT");
  assert.equal(text, `settle failed 3 rounds in a row for wallet ${user.toBase58()} on SHOT: custom program error: 0x1773. A piece that cannot be removed should be impossible. Look at it.`);
  assert.ok(settleStuckMessage(s.alerts[0], null).includes(`on pool ${POOL.toBase58()}:`));
  assert.ok(/^[\x20-\x7e]*$/.test(text));

  // after the alert the wallet rests: it is not sent for 29 rounds, and no round raises the alert again
  const ticket = T({ user, owned: keys(1) });
  let fails = s.fails;
  for (let round = 0; round < 29; round++) {
    const plan = planSettles([U(ticket, 0n)], fails);
    assert.deepEqual([plan.send.length, plan.resting.length, plan.keys], [0, 1, [k]]);
    const next = settleStrikes(fails, plan.keys, []);
    assert.deepEqual(next.alerts, []);
    fails = next.fails;
  }
  assert.equal(fails[k].skip, 0);
  // round 30 tries again; a fourth failure stays silent and rests again
  assert.equal(planSettles([U(ticket, 0n)], fails).send.length, 1);
  s = settleStrikes(fails, [k], [fail]);
  assert.deepEqual([s.alerts, s.fails[k]], [[], { count: 4, alerted: true, skip: 29, error: fail.error }]);
  // a settle that works clears the wallet
  assert.deepEqual(settleStrikes(s.fails, [k], [ok]), { fails: {}, alerts: [] });
});

test("three strikes: only rounds in a row count, and a wallet that left the list is forgotten", () => {
  const user = key();
  const k = settleKey(POOL, user);
  const fail = { key: k, pool: POOL, user, ok: false, error: "boom" };
  const ok = { ...fail, ok: true, error: null };
  // fail, fail, ok, fail, fail: never three in a row, never an alert
  let fails = {};
  const alerts = [];
  for (const r of [fail, fail, ok, fail, fail]) { const s = settleStrikes(fails, [k], [r]); fails = s.fails; alerts.push(...s.alerts); }
  assert.deepEqual([alerts, fails[k].count], [[], 2]);
  // somebody else settled the wallet: it is no longer above the peg, its strikes are gone
  assert.deepEqual(settleStrikes(fails, [], []), { fails: {}, alerts: [] });
  // a settle that was confirmed but removed nothing counts as a failed round
  const noop = { ...fail, error: "the settle was confirmed but removed nothing" };
  let s = settleStrikes({}, [k], [noop]); s = settleStrikes(s.fails, [k], [noop]); s = settleStrikes(s.fails, [k], [noop]);
  assert.equal(s.alerts.length, 1);
  // a wallet above the peg that this pass did not reach keeps its strikes
  assert.deepEqual(settleStrikes(fails, [k], []).fails[k].count, 2);
  // a pool that could not be read this round: its wallets keep their strikes, the others are forgotten
  const other = settleKey(OTHER, user);
  const kept = settleStrikes({ [k]: fails[k], [other]: { count: 1, alerted: false, skip: 0, error: "x" } }, [], [], { unread: [POOL.toBase58()] });
  assert.deepEqual(Object.keys(kept.fails), [k]);
});

test("planning a pass: wallets that failed before go last, and one pass sends at most ten settles", () => {
  assert.equal(SETTLES_PER_PASS, 10);
  const users = keys(12);
  const unbacked = users.map((u) => U(T({ user: u, owned: keys(1) }), 0n));
  const fails = { [settleKey(POOL, users[0])]: { count: 2, alerted: false, skip: 0, error: "x" }, [settleKey(POOL, users[1])]: { count: 5, alerted: true, skip: 7, error: "x" } };
  const plan = planSettles(unbacked, fails);
  assert.deepEqual(b58s(plan.send.map((it) => it.user)), b58s(users.slice(2, 12)));
  assert.deepEqual(b58s(plan.later.map((it) => it.user)), b58s([users[0]]));
  assert.deepEqual(b58s(plan.resting.map((it) => it.user)), b58s([users[1]]));
  assert.equal(plan.keys.length, 12);
  assert.deepEqual(planSettles([]), { keys: [], send: [], later: [], resting: [] });
});

test("settings, health and state carry the settle crank", () => {
  const c = buildConfig({}, parseArgs([]), "/w");
  assert.deepEqual([c.settleIntervalSeconds, c.settle, c.crank], [10, true, true]);
  assert.equal(buildConfig({ SETTLE_INTERVAL_SECONDS: "45" }, parseArgs([]), "/w").settleIntervalSeconds, 45);
  assert.throws(() => buildConfig({ SETTLE_INTERVAL_SECONDS: "2" }, parseArgs([])), /below the minimum/);
  const noSettle = buildConfig({}, parseArgs(["--no-settle"]), "/w");
  assert.deepEqual([noSettle.settle, noSettle.crank], [false, true]);
  const noCrank = buildConfig({}, parseArgs(["--no-crank"]), "/w");
  assert.deepEqual([noCrank.settle, noCrank.crank], [false, false]);
  assert.equal(describeConfig(c).settleCrank, "every 10 s");
  assert.equal(describeConfig(noSettle).settleCrank, "off (--no-settle)");
  assert.equal(describeConfig(noCrank).settleCrank, "off (--no-crank)");

  const now = Date.parse("2026-10-04T12:00:00Z");
  const at = (sec) => new Date(now - sec * 1000).toISOString();
  const status = { updatedAt: at(30), pools: { P1: {} } };
  const crank = { enabled: true, lastCrankAt: at(5), lastCrankRevealed: 0, intervalSeconds: 20 };
  const totals = { sent: 7, failed: 1, dropped: 2, burned: 9, rentLamports: 14_031_360, feeLamports: 35_000 };
  const fresh = healthBody({ status, crank, settle: { enabled: true, lastSettleAt: at(8), lastSettleSent: 2, intervalSeconds: 20, totals }, nowMs: now, staleAfterMs: 300000, cluster: "localnet" });
  assert.deepEqual(
    [fresh.ok, fresh.settleEnabled, fresh.settleStale, fresh.lastSettleAt, fresh.lastSettleSent, fresh.settlesSent, fresh.settlesFailed, fresh.piecesDropped, fresh.piecesBurned, fresh.rentReceivedLamports, fresh.settleFeesLamports],
    [true, true, false, at(8), 2, 7, 1, 2, 9, 14_031_360, 35_000]);
  const stuck = healthBody({ status, crank, settle: { enabled: true, lastSettleAt: at(61), lastSettleSent: 0, intervalSeconds: 20, totals }, nowMs: now, staleAfterMs: 300000, cluster: "localnet" });
  assert.deepEqual([stuck.ok, stuck.stale, stuck.settleStale, stuck.crankStale], [false, true, true, false]);
  const off = healthBody({ status, crank, nowMs: now, staleAfterMs: 300000, cluster: "localnet" });
  assert.deepEqual([off.ok, off.settleEnabled, off.settleStale, off.settlesSent, off.rentReceivedLamports], [true, false, false, 0, 0]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-settle-"));
  const file = path.join(dir, "state.json");
  const s = emptyState();
  assert.deepEqual(s.settle, { fails: {}, totals: NO_SETTLE_TOTALS() });
  s.settle.fails.K = { count: 2, alerted: false, skip: 0, error: "x" };
  s.settle.totals = totals;
  saveState(file, s);
  assert.deepEqual(loadState(file).settle, s.settle);
  // a state file written before the settle crank existed loads with empty settle numbers
  fs.writeFileSync(file, JSON.stringify({ version: 1, pools: {}, tickets: { seen: {} } }));
  assert.deepEqual(loadState(file).settle, { fails: {}, totals: NO_SETTLE_TOTALS() });
  fs.rmSync(dir, { recursive: true, force: true });

  // the one keeper balance alert speaks for both cranks
  const alert = keeperBalanceAlert({ cluster: "mainnet", lamports: 1000n, minLamports: 10_000_000n, address: OWNER.toBase58() });
  assert.ok(alert.level === "danger" && alert.message.includes("reveals and settles stop"));
});
