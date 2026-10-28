// The upkeep crank of pegged coins: which assets wait, what one pass sends, what a transaction did, the rule for
// an asset that stays stuck, the totals, the settings. None of it touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { HookpoolClient, PROGRAMS, collectible } from "../../sdk/dist/index.js";
import {
  waitingAssets, planUpkeep, upkeepInstructions, upkeepEffect, upkeepAll, upkeepLine, triedKeys, upkeepRound, upkeepTried, upkeepStuckMessage, upkeepKey,
  addUpkeepTotals, NO_UPKEEP_TOTALS, readUpkeep, keeperBalanceAlert,
  ASSETS_PER_UPKEEP_TX, UPKEEP_TXS_PER_PASS, UPKEEP_STRIKES, UPKEEP_RETRY_ROUNDS, UPKEEP_COMPUTE_UNITS,
} from "../lib/crank.mjs";
import { healthBody } from "../lib/server.mjs";
import { parseArgs, buildConfig, describeConfig } from "../lib/config.mjs";
import { loadState, saveState, emptyState } from "../lib/state.mjs";
import { ticketBytes, collectionConfig, coreAssetBytes, burnQueueBytes, BURNED_ASSET, POOL, OWNER, OTHER, TOKEN_2022_PROGRAM, MPL_CORE } from "./bytes.mjs";

const key = () => Keypair.generate().publicKey;
const keys = (n) => Array.from({ length: n }, key);
const b58s = (list) => list.map((k) => k.toBase58());
const ascii = (s) => /^[\x20-\x7e]*$/.test(s);
const D = (holder, assets, pool = POOL) => ({ pool, undelivered: [{ holder, assets }], queue: [] });
const Q = (assets, pool = POOL) => ({ pool, undelivered: [], queue: assets });

/// A connection that answers from memory, with accounts shaped like the real ones: the config and the burn
/// queue by address, the tickets as the hook's program accounts, the Core assets by address.
function fakeConnection({ pool = POOL, pegged = true, tickets = [], assets = new Map(), queue = [] }) {
  const hook = PROGRAMS.hook_collectible;
  const cfgKey = collectible.collectiblePda.cfg(pool).toBase58();
  const queueKey = collectible.collectiblePda.queue(pool).toBase58();
  const calls = { programAccounts: 0, multiple: 0, single: 0 };
  const one = (k) => {
    if (k.toBase58() === cfgKey) return { owner: hook, data: Buffer.from(collectionConfig({ pool, pegged, tokenProgram: pegged ? TOKEN_2022_PROGRAM : undefined })) };
    if (k.toBase58() === queueKey) return pegged ? { owner: hook, data: Buffer.from(burnQueueBytes({ pool, assets: queue })) } : null;
    const d = assets.get(k.toBase58());
    return d ? { owner: MPL_CORE, data: Buffer.from(d) } : null;
  };
  return {
    calls,
    async getAccountInfo(k) { calls.single += 1; return one(k); },
    async getProgramAccounts() { calls.programAccounts += 1; return tickets.map((data) => ({ pubkey: key(), account: { owner: hook, data: Buffer.from(data) } })); },
    async getMultipleAccountsInfo(list) { calls.multiple += 1; return list.map(one); },
  };
}

// The logs of a real deliver and a real reap on the local validator, one asset each.
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const HOOK = "3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m";
const coreCall = (name) => [
  `Program ${CORE} invoke [2]`, `Program log: Instruction: ${name}`,
  "Program log: programs/mpl-core/src/plugins/lifecycle.rs:733:ForceApprove",
  `Program ${CORE} consumed 7956 of 388652 compute units`, `Program ${CORE} success`,
];
const BURNED_EVENT = "Program data: sjAcPu+gkuPIvoI1sAc6DEKmm/2kUAWQ/CBYXiip2fbVAb7WuDz/eQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASwoDn2bB0q/N10uRuZUXjIjjr6Ia9/IRxuzGORk16+ecp+VOH5o61CEqjBtiBK7yjINjOH5phyGcCaVwy3nY/w==";
const wrap = (name, inner) => [
  "Program ComputeBudget111111111111111111111111111111 invoke [1]", "Program ComputeBudget111111111111111111111111111111 success",
  `Program ${HOOK} invoke [1]`, `Program log: Instruction: ${name}`, ...inner,
  `Program ${HOOK} consumed 19700 of 399850 compute units`, `Program ${HOOK} success`,
];
const deliverMeta = (n = 1) => ({ fee: 5000, computeUnitsConsumed: 19850, preBalances: [2_000_000_000, 1], postBalances: [1_999_995_000, 1], logMessages: wrap("Deliver", Array.from({ length: n }, () => coreCall("Transfer")).flat()) });
const reapMeta = (n = 1) => ({ fee: 5000, computeUnitsConsumed: 22612, preBalances: [1_999_995_000, 1], postBalances: [1_999_995_000 + 1_440_720 * n - 5000, 1], logMessages: wrap("Reap", Array.from({ length: n }, () => [...coreCall("Burn"), BURNED_EVENT]).flat()) });

test("which assets wait: every undelivered asset with its holder, every queued asset", () => {
  const [a, b, c] = keys(3); const holder = key();
  const w = waitingAssets([{ pool: POOL, undelivered: [{ holder, assets: [a, b] }], queue: [c] }, { pool: OTHER, undelivered: [], queue: [] }]);
  assert.deepEqual(w.map((x) => [x.key, x.kind, x.holder ? x.holder.toBase58() : null, x.asset.toBase58()]), [
    [upkeepKey(POOL, "deliver", a), "deliver", holder.toBase58(), a.toBase58()],
    [upkeepKey(POOL, "deliver", b), "deliver", holder.toBase58(), b.toBase58()],
    [upkeepKey(POOL, "reap", c), "reap", null, c.toBase58()],
  ]);
  assert.equal(upkeepKey(POOL, "reap", c), `${POOL.toBase58()}:reap:${c.toBase58()}`);
  assert.deepEqual(waitingAssets([]), []);
});

test("planning a pass: six assets per transaction, one holder per deliver, deliveries first, ten transactions at most", () => {
  assert.deepEqual([ASSETS_PER_UPKEEP_TX, UPKEEP_TXS_PER_PASS, UPKEEP_COMPUTE_UNITS], [6, 10, 400_000]);
  const [h1, h2] = keys(2);
  const a1 = keys(8); const a2 = keys(1); const q = keys(7);
  const plan = planUpkeep([{ pool: POOL, undelivered: [{ holder: h1, assets: a1 }, { holder: h2, assets: a2 }], queue: q }]);
  assert.deepEqual(plan.send.map((g) => [g.kind, g.holder ? g.holder.toBase58() : null, g.assets.length]), [
    ["deliver", h1.toBase58(), 6], ["deliver", h1.toBase58(), 2], ["deliver", h2.toBase58(), 1], ["reap", null, 6], ["reap", null, 1],
  ]);
  assert.deepEqual(b58s(plan.send[0].assets), b58s(a1.slice(0, 6)));
  assert.deepEqual(plan.send[0].keys, a1.slice(0, 6).map((a) => upkeepKey(POOL, "deliver", a)));
  assert.deepEqual([plan.later, plan.resting, plan.keys.length], [[], [], 16]);
  // two pools: the deliveries of both go before the burns of either
  const two = planUpkeep([{ pool: POOL, undelivered: [{ holder: h1, assets: keys(1) }], queue: keys(1) }, { pool: OTHER, undelivered: [{ holder: h2, assets: keys(1) }], queue: keys(1) }]);
  assert.deepEqual(two.send.map((g) => [g.kind, g.pool.toBase58()]), [["deliver", POOL.toBase58()], ["deliver", OTHER.toBase58()], ["reap", POOL.toBase58()], ["reap", OTHER.toBase58()]]);
  // bounded work: 70 queued assets are 12 transactions, 10 go out, 2 wait for the next pass
  const big = planUpkeep([Q(keys(70))]);
  assert.deepEqual([big.send.length, big.later.length, big.later.map((g) => g.assets.length), big.keys.length], [10, 2, [6, 4], 70]);
  assert.deepEqual(planUpkeep([]), { keys: [], send: [], later: [], resting: [] });
});

test("planning a pass: an asset that rests is left out, assets sent before go after the fresh ones", () => {
  const holder = key();
  const a = keys(8);
  const k = (i) => upkeepKey(POOL, "deliver", a[i]);
  const table = { [k(0)]: { count: 2, alerted: false, skip: 0 }, [k(1)]: { count: 7, alerted: true, skip: 12 } };
  const plan = planUpkeep([D(holder, a)], table);
  // a[1] rests. a[0] was sent twice already: it goes last, in the second transaction, behind the fresh ones.
  assert.deepEqual(plan.resting.map((r) => r.key), [k(1)]);
  assert.deepEqual(plan.send.map((g) => b58s(g.assets)), [b58s([a[2], a[3], a[4], a[5], a[6], a[7]]), b58s([a[0]])]);
  assert.deepEqual(plan.send.map((g) => g.strikes), [0, 2]);
  assert.equal(plan.keys.length, 8);   // the resting asset still counts as waiting
  // a group with strikes never goes before a fresh group, whatever the pool order
  const fresh = key();
  const mixed = planUpkeep([Q([a[0]]), Q([fresh], OTHER)], { [upkeepKey(POOL, "reap", a[0])]: { count: 3, alerted: false, skip: 0 } });
  assert.deepEqual(mixed.send.map((g) => g.pool.toBase58()), [OTHER.toBase58(), POOL.toBase58()]);
});

test("the plan is what the SDK itself would send for the same chain", async () => {
  const [hA, hB, hC, minter] = keys(4);
  const aA = keys(8); const aB = keys(2); const aC = keys(1); const queued = keys(7); const burnedInList = key();
  const assets = new Map();
  for (const a of aA) assets.set(a.toBase58(), coreAssetBytes({ owner: minter }));            // all eight still show the sender
  assets.set(aB[0].toBase58(), coreAssetBytes({ owner: hB }));                                // already with its holder
  assets.set(aB[1].toBase58(), coreAssetBytes({ owner: minter }));                            // stale
  assets.set(aC[0].toBase58(), coreAssetBytes({ owner: hC }));
  assets.set(burnedInList.toBase58(), BURNED_ASSET);                                          // not a live asset: nothing to deliver
  const tickets = [ticketBytes({ user: hA, owned: aA }), ticketBytes({ user: hB, owned: [...aB, burnedInList] }), ticketBytes({ user: hC, owned: aC }), ticketBytes({ user: minter })];
  const connection = fakeConnection({ tickets, assets, queue: queued });
  const { work, unread } = await readUpkeep(connection, [POOL]);
  assert.deepEqual(unread, []);
  // one batched read of the configs and the queues, one read of every ticket, one of the assets
  assert.deepEqual([connection.calls.single, connection.calls.programAccounts, connection.calls.multiple], [0, 1, 2]);
  assert.equal(work.length, 1);
  assert.deepEqual(work[0].undelivered.map((u) => [u.holder.toBase58(), b58s(u.assets)]), [[hA.toBase58(), b58s(aA)], [hB.toBase58(), b58s([aB[1]])]]);
  assert.deepEqual(b58s(work[0].queue), b58s(queued));

  const payer = key();
  const mine = planUpkeep(work).send.map((item) => upkeepInstructions(payer, item));
  const theirs = await new HookpoolClient(connection).collectibleUpkeepInstructions(payer, POOL);
  const flat = (txs) => txs.map((ixs) => ixs.map((ix) => [ix.programId.toBase58(), ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]), Buffer.from(ix.data).toString("hex")]));
  assert.deepEqual(flat(mine), flat(theirs));
  assert.deepEqual(mine.map((ixs) => ixs.length), [2, 2, 2, 2, 2]);   // 6 + 2 for A, 1 for B, 6 + 1 from the queue
  // a deliver: payer, config, the holder's ticket, the holder, collection, authority, Core, system, then the assets
  const deliver = mine[0][1];
  assert.deepEqual(b58s(deliver.keys.slice(8).map((m) => m.pubkey)), b58s(aA.slice(0, 6)));
  assert.deepEqual([deliver.keys[0].pubkey.toBase58(), deliver.keys[2].pubkey.toBase58(), deliver.keys[3].pubkey.toBase58()], [payer.toBase58(), collectible.collectiblePda.ticket(POOL, hA).toBase58(), hA.toBase58()]);
  // a reap: payer, config, the burn queue, collection, authority, Core, system, then the assets
  const reap = mine[3][1];
  assert.deepEqual(b58s(reap.keys.slice(7).map((m) => m.pubkey)), b58s(queued.slice(0, 6)));
  assert.equal(reap.keys[2].pubkey.toBase58(), collectible.collectiblePda.queue(POOL).toBase58());
});

test("only pegged pools are kept up, a pool that cannot be read never stops the others, a failed read waits", async () => {
  const holder = key(); const asset = key();
  const stale = { tickets: [ticketBytes({ user: holder, owned: [asset] })], assets: new Map([[asset.toBase58(), coreAssetBytes({ owner: OTHER })]]) };
  // a plain collectible pool: its config does not say pegged, so nothing is kept up and nothing is sent
  assert.deepEqual(await readUpkeep(fakeConnection({ ...stale, pegged: false }), [POOL]), { work: [], unread: [] });
  // a pool without a config at all
  const none = { async getMultipleAccountsInfo(list) { return list.map(() => null); }, async getProgramAccounts() { return []; } };
  assert.deepEqual(await readUpkeep(none, [POOL]), { work: [], unread: [] });
  // a pool whose config does not decode is unread, the others are kept up
  const good = fakeConnection(stale);
  const bad = key();
  const badCfg = collectible.collectiblePda.cfg(bad).toBase58();
  const connection = { ...good, async getMultipleAccountsInfo(list) { const got = await good.getMultipleAccountsInfo(list); return list.map((k, i) => (k.toBase58() === badCfg ? { owner: PROGRAMS.hook_collectible, data: Buffer.from([9, 9, 9]) } : got[i])); } };
  const { work, unread } = await readUpkeep(connection, [bad, POOL]);
  assert.deepEqual(unread.map((u) => u.pool), [bad.toBase58()]);
  assert.deepEqual(work.map((w) => [w.pool.toBase58(), w.undelivered.length, w.queue.length]), [[POOL.toBase58(), 1, 0]]);
  // the RPC fails: every pool is unread for this pass, with the error on one line
  const down = { ...good, async getMultipleAccountsInfo() { throw new Error("429 Too Many Requests\n  retry later"); } };
  const r = await readUpkeep(down, [bad, POOL]);
  assert.deepEqual(r.unread, [{ pool: bad.toBase58(), error: "429 Too Many Requests retry later" }, { pool: POOL.toBase58(), error: "429 Too Many Requests retry later" }]);
  assert.deepEqual(r.work, []);
  // no pegged pool, no read
  const idle = fakeConnection(stale);
  assert.deepEqual(await readUpkeep(idle, []), { work: [], unread: [] });
  assert.deepEqual([idle.calls.single, idle.calls.programAccounts, idle.calls.multiple], [0, 0, 0]);
});

test("one deliver or one reap of six assets stays far below the 1,232 byte limit, even without the lookup table", () => {
  const payer = Keypair.generate();
  const sizeOf = (item) => {
    const ixs = upkeepInstructions(payer.publicKey, item);
    assert.equal(ixs.length, 2);
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message([]);
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    return tx.serialize().length;
  };
  // 1 signature, 16 account keys for a deliver and 15 for a reap, the blockhash, two short instructions
  const deliver = sizeOf({ kind: "deliver", pool: POOL, holder: OTHER, assets: keys(6) });
  const reap = sizeOf({ kind: "reap", pool: POOL, holder: null, assets: keys(6) });
  assert.deepEqual([deliver, reap], [649, 616]);
  assert.ok(deliver <= 1232 && reap <= 1232);
});

test("what an upkeep transaction did is read from the transaction itself", () => {
  // a real deliver of one asset: one Core call, no rent, the fee
  assert.deepEqual(upkeepEffect(deliverMeta(1), "deliver"), { delivered: 1, burned: 0, rentLamports: 0, feeLamports: 5000, computeUnits: 19850 });
  assert.equal(upkeepEffect(deliverMeta(4), "deliver").delivered, 4);
  // a deliver whose assets were all skipped (somebody else was faster): no Core call at all
  assert.equal(upkeepEffect({ ...deliverMeta(1), logMessages: wrap("Deliver", []) }, "deliver").delivered, 0);
  // a real reap of one asset: one PieceBurned event, rent received = balance after - balance before + fee
  assert.deepEqual(upkeepEffect(reapMeta(1), "reap"), { delivered: 0, burned: 1, rentLamports: 1_440_720, feeLamports: 5000, computeUnits: 22612 });
  assert.deepEqual([upkeepEffect(reapMeta(6), "reap").burned, upkeepEffect(reapMeta(6), "reap").rentLamports], [6, 8_644_320]);
  const noop = upkeepEffect({ fee: 5000, preBalances: [10_000], postBalances: [5_000], logMessages: wrap("Reap", []) }, "reap");
  assert.deepEqual([noop.burned, noop.rentLamports], [0, 0]);
  assert.equal(upkeepEffect(null, "reap"), null);
  assert.equal(upkeepEffect({ fee: 5000 }, "deliver"), null);
});

test("a transaction that fails never stops the pass, and is sent again one asset at a time", async () => {
  const [h1, h2] = keys(2);
  const a = keys(3); const b = keys(1); const q = keys(2);
  const plan = planUpkeep([{ pool: POOL, undelivered: [{ holder: h1, assets: a }, { holder: h2, assets: b }], queue: q }]).send;
  const sent = [];
  const send = async (item) => {
    sent.push(`${item.kind}:${item.assets.length}`);
    // the delivery to h1 fails as a group; alone, only its second asset fails. The single delivery to h2 fails too.
    if (item.kind === "deliver" && item.holder.equals(h1) && (item.assets.length > 1 || item.assets[0].equals(a[1]))) throw new Error("Simulation failed.\nMessage: custom program error: 0x1773.");
    if (item.kind === "deliver" && item.holder.equals(h2)) throw new Error("transaction expired before it was confirmed");
    return `sig-${sent.length}`;
  };
  const readEffect = async (signature, kind) => {
    if (signature === "sig-4") throw new Error("rpc hiccup");
    return kind === "deliver" ? upkeepEffect(deliverMeta(1), kind) : upkeepEffect(reapMeta(2), kind);
  };
  const results = await upkeepAll({ plan, send, readEffect });
  // group of 3 fails, then its 3 assets alone; the single delivery to h2 is not retried; the reap still goes out
  assert.deepEqual(sent, ["deliver:3", "deliver:1", "deliver:1", "deliver:1", "deliver:1", "reap:2"]);
  assert.deepEqual(results.map((r) => [r.kind, r.assets.length, r.signature, r.error]), [
    ["deliver", 3, null, "Simulation failed. Message: custom program error: 0x1773."],
    ["deliver", 1, "sig-2", null],
    ["deliver", 1, null, "Simulation failed. Message: custom program error: 0x1773."],
    ["deliver", 1, "sig-4", null],
    ["deliver", 1, null, "transaction expired before it was confirmed"],
    ["reap", 2, "sig-6", null],
  ]);
  assert.deepEqual(results[1].keys, [upkeepKey(POOL, "deliver", a[0])]);
  // every asset that was in a transaction counts as tried this round, once
  assert.deepEqual(triedKeys(results).sort(), [...a.map((x) => upkeepKey(POOL, "deliver", x)), upkeepKey(POOL, "deliver", b[0]), ...q.map((x) => upkeepKey(POOL, "reap", x))].sort());
  // one line per transaction
  const lines = results.map(upkeepLine);
  assert.equal(lines[0], `upkeep FAILED: pool ${POOL.toBase58()}: delivery of 3 assets to wallet ${h1.toBase58()}: Simulation failed. Message: custom program error: 0x1773.`);
  assert.equal(lines[1], `upkeep: pool ${POOL.toBase58()}: delivered 1 asset to wallet ${h1.toBase58()}, tx sig-2`);
  assert.equal(lines[3], `upkeep: pool ${POOL.toBase58()}: sent a delivery of 1 asset to wallet ${h1.toBase58()}, the result could not be read, tx sig-4`);
  assert.equal(lines[5], `upkeep: pool ${POOL.toBase58()}: burned 2 assets from the burn queue, rent received 2881440 lamports, tx sig-6`);
  for (const l of lines) assert.ok(ascii(l), l);
  // a transaction that named more than it handled says so
  assert.ok(upkeepLine({ ...results[5], effect: upkeepEffect(reapMeta(1), "reap") }).endsWith("tx sig-6. It named 2: somebody else burned the others first."));
  assert.ok(upkeepLine({ ...results[1], assets: a, effect: upkeepEffect(deliverMeta(2), "deliver") }).endsWith("tx sig-2. It named 3: the others were delivered by somebody else first, or left that wallet."));
  assert.equal(upkeepLine({ kind: "reap", pool: POOL, holder: null, assets: q, signature: null, error: "boom" }), `upkeep FAILED: pool ${POOL.toBase58()}: burn of 2 assets from the burn queue: boom`);
  // totals: confirmed transactions by kind, failed ones, assets, rent received and fees paid
  const totals = addUpkeepTotals(NO_UPKEEP_TOTALS(), results);
  assert.deepEqual(totals, { deliveries: 2, reaps: 1, failed: 3, delivered: 1, burned: 2, rentLamports: 2_881_440, feeLamports: 10_000 });
  assert.deepEqual(addUpkeepTotals(totals, [results[5]]), { deliveries: 2, reaps: 2, failed: 3, delivered: 1, burned: 4, rentLamports: 5_762_880, feeLamports: 15_000 });
  assert.deepEqual(addUpkeepTotals(undefined, []), NO_UPKEEP_TOTALS());
});

test("stuck rule: an asset that still waits after five rounds in a row raises one alert, then rests", () => {
  assert.deepEqual([UPKEEP_STRIKES, UPKEEP_RETRY_ROUNDS], [5, 30]);
  const holder = key(); const asset = key();
  const k = upkeepKey(POOL, "deliver", asset);
  const work = [D(holder, [asset])];
  let table = {};
  const alerts = [];
  const tried = [];
  // every round: read, see what is stuck, plan, send what is planned, count it
  const round = () => {
    const r = upkeepRound(table, waitingAssets(work));
    alerts.push(...r.stuck);
    const plan = planUpkeep(work, r.table);
    const sent = plan.send.flatMap((g) => g.keys);
    tried.push(sent.length);
    table = upkeepTried(r.table, plan.keys, sent);
  };
  for (let i = 0; i < 5; i++) round();
  // five rounds, five sends, no alert yet: the fifth send may still have worked
  assert.deepEqual([tried, alerts, table[k]], [[1, 1, 1, 1, 1], [], { count: 5, alerted: false, skip: 0 }]);
  round();
  // the sixth read still shows it: one alert, and it is not sent this round
  assert.deepEqual(alerts, [{ key: k, pool: POOL.toBase58(), kind: "deliver", asset: asset.toBase58(), holder: holder.toBase58(), count: 5 }]);
  assert.deepEqual([tried[5], table[k]], [0, { count: 5, alerted: true, skip: 28 }]);
  // it rests: no send and no second alert for the next 28 rounds
  for (let i = 0; i < 28; i++) round();
  assert.deepEqual([tried.slice(6).every((n) => n === 0), alerts.length, table[k].skip], [true, 1, 0]);
  // then one try, thirty rounds after the last one, and it rests again. Never a second alert.
  round();
  assert.deepEqual([tried[34], tried.length, table[k]], [1, 35, { count: 6, alerted: true, skip: 29 }]);
  for (let i = 0; i < 40; i++) round();
  assert.equal(alerts.length, 1);
  assert.equal(tried.slice(35).filter((n) => n === 1).length, 1);
  // once somebody delivers it, it is forgotten
  assert.deepEqual(upkeepRound(table, []), { table: {}, stuck: [] });
});

test("stuck rule: only rounds in which the asset was sent count, and an unread pool keeps its numbers", () => {
  const asset = key();
  const k = upkeepKey(POOL, "reap", asset);
  const waiting = waitingAssets([Q([asset])]);
  // waiting but never sent (the keeper could not pay, or the pass was full): nothing is counted, nothing is raised
  let table = {};
  for (let i = 0; i < 20; i++) { const r = upkeepRound(table, waiting); assert.deepEqual(r.stuck, []); table = upkeepTried(r.table, [k], []); }
  assert.deepEqual(table, {});
  // sent four times, then gone, then back: the count starts again
  for (let i = 0; i < 4; i++) table = upkeepTried(upkeepRound(table, waiting).table, [k], [k]);
  assert.equal(table[k].count, 4);
  table = upkeepRound(table, []).table;
  assert.deepEqual(table, {});
  table = upkeepTried(upkeepRound(table, waiting).table, [k], [k]);
  assert.equal(table[k].count, 1);
  // a pool that could not be read this round: its assets keep what they had, the others are forgotten
  const other = upkeepKey(OTHER, "reap", asset);
  const kept = upkeepRound({ [k]: { count: 4, alerted: false, skip: 0 }, [other]: { count: 2, alerted: false, skip: 0 } }, [], { unread: [POOL.toBase58()] });
  assert.deepEqual(kept, { table: { [k]: { count: 4, alerted: false, skip: 0 } }, stuck: [] });
  // the limit can be set, and a reap that is stuck has no holder
  const quick = upkeepRound({ [k]: { count: 2, alerted: false, skip: 0 } }, waiting, { limit: 2, retryRounds: 10 });
  assert.deepEqual(quick.stuck, [{ key: k, pool: POOL.toBase58(), kind: "reap", asset: asset.toBase58(), holder: null, count: 2 }]);
  assert.deepEqual(quick.table[k], { count: 2, alerted: true, skip: 9 });
});

test("the stuck alert: one message per pool and kind, plain ASCII", () => {
  const ev = (kind, n) => ({ key: "k", pool: POOL.toBase58(), kind, asset: `Asset${n}`, holder: kind === "deliver" ? "WalletA" : null, count: 5 });
  const one = upkeepStuckMessage([ev("deliver", 1)], "SHOT");
  assert.equal(one, "asset Asset1 on SHOT is still not delivered to wallet WalletA after 5 rounds in a row. The wallet's list holds the piece, Metaplex shows another owner. This should be impossible. Look at it.");
  assert.equal(upkeepStuckMessage([ev("deliver", 1), ev("deliver", 2), ev("deliver", 3)], "SHOT"), "3 assets on SHOT are still not delivered after 5 rounds in a row. The first is Asset1, for wallet WalletA. This should be impossible. Look at them.");
  assert.equal(upkeepStuckMessage([ev("reap", 7)], null), `asset Asset7 on pool ${POOL.toBase58()} is still in the burn queue after 5 rounds in a row. Its piece was burned by a transfer, the asset still exists. This should be impossible. Look at it.`);
  assert.equal(upkeepStuckMessage([ev("reap", 7), ev("reap", 8)], "SHOT"), "2 assets on SHOT are still in the burn queue after 5 rounds in a row. The first is Asset7. This should be impossible. Look at them.");
  for (const m of [one, upkeepStuckMessage([ev("reap", 7)], null)]) assert.ok(ascii(m), m);
});

test("settings, health and state carry the upkeep crank", () => {
  const c = buildConfig({}, parseArgs([]), "/w");
  assert.deepEqual([c.upkeepIntervalSeconds, c.upkeep, c.settle, c.crank], [10, true, true, true]);
  assert.equal(buildConfig({ UPKEEP_INTERVAL_SECONDS: "45" }, parseArgs([]), "/w").upkeepIntervalSeconds, 45);
  assert.throws(() => buildConfig({ UPKEEP_INTERVAL_SECONDS: "2" }, parseArgs([])), /below the minimum/);
  assert.throws(() => buildConfig({ UPKEEP_INTERVAL_SECONDS: "7200" }, parseArgs([])), /above the maximum/);
  const noUpkeep = buildConfig({}, parseArgs(["--no-upkeep"]), "/w");
  assert.deepEqual([noUpkeep.upkeep, noUpkeep.settle, noUpkeep.crank], [false, true, true]);
  const noSettle = buildConfig({}, parseArgs(["--no-settle"]), "/w");
  assert.deepEqual([noSettle.upkeep, noSettle.settle, noSettle.crank], [true, false, true]);
  const noCrank = buildConfig({}, parseArgs(["--no-crank"]), "/w");
  assert.deepEqual([noCrank.upkeep, noCrank.settle, noCrank.crank], [false, false, false]);
  assert.equal(describeConfig(c).upkeepCrank, "every 10 s");
  assert.equal(describeConfig(noUpkeep).upkeepCrank, "off (--no-upkeep)");
  assert.equal(describeConfig(noCrank).upkeepCrank, "off (--no-crank)");

  const now = Date.parse("2026-10-04T12:00:00Z");
  const at = (sec) => new Date(now - sec * 1000).toISOString();
  const status = { updatedAt: at(30), pools: { P1: {} } };
  const crank = { enabled: true, lastCrankAt: at(5), lastCrankRevealed: 0, intervalSeconds: 20 };
  const settle = { enabled: true, lastSettleAt: at(8), lastSettleSent: 0, intervalSeconds: 20, totals: null };
  const totals = { deliveries: 4, reaps: 3, failed: 1, delivered: 9, burned: 5, rentLamports: 7_203_600, feeLamports: 35_000 };
  const fresh = healthBody({ status, crank, settle, upkeep: { enabled: true, lastUpkeepAt: at(4), lastUpkeepSent: 2, intervalSeconds: 10, totals }, nowMs: now, staleAfterMs: 300000, cluster: "localnet" });
  assert.deepEqual(
    [fresh.ok, fresh.upkeepEnabled, fresh.upkeepStale, fresh.lastUpkeepAt, fresh.lastUpkeepSent, fresh.deliveriesSent, fresh.reapsSent, fresh.upkeepFailed, fresh.assetsDelivered, fresh.assetsBurned, fresh.upkeepRentReceivedLamports, fresh.upkeepFeesLamports],
    [true, true, false, at(4), 2, 4, 3, 1, 9, 5, 7_203_600, 35_000]);
  // three intervals without a run: stale, and the service answers 503
  const stuck = healthBody({ status, crank, settle, upkeep: { enabled: true, lastUpkeepAt: at(31), lastUpkeepSent: 0, intervalSeconds: 10, totals }, nowMs: now, staleAfterMs: 300000, cluster: "localnet" });
  assert.deepEqual([stuck.ok, stuck.stale, stuck.upkeepStale, stuck.settleStale, stuck.crankStale], [false, true, true, false, false]);
  const off = healthBody({ status, crank, settle, nowMs: now, staleAfterMs: 300000, cluster: "localnet" });
  assert.deepEqual([off.ok, off.upkeepEnabled, off.upkeepStale, off.deliveriesSent, off.assetsBurned, off.upkeepRentReceivedLamports], [true, false, false, 0, 0, 0]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-upkeep-"));
  const file = path.join(dir, "state.json");
  const s = emptyState();
  assert.deepEqual(s.upkeep, { waiting: {}, totals: NO_UPKEEP_TOTALS() });
  s.upkeep.waiting.K = { count: 2, alerted: false, skip: 0 };
  s.upkeep.totals = totals;
  saveState(file, s);
  assert.deepEqual(loadState(file).upkeep, s.upkeep);
  // a state file written before the upkeep crank existed loads with empty upkeep numbers, and keeps the rest
  fs.writeFileSync(file, JSON.stringify({ version: 1, pools: {}, tickets: { seen: {} }, settle: { fails: {}, totals: { sent: 3, failed: 0, dropped: 0, burned: 2, rentLamports: 9, feeLamports: 1 } } }));
  const old = loadState(file);
  assert.deepEqual(old.upkeep, { waiting: {}, totals: NO_UPKEEP_TOTALS() });
  assert.equal(old.settle.totals.sent, 3);
  fs.rmSync(dir, { recursive: true, force: true });

  // the one keeper balance alert speaks for all three cranks
  const alert = keeperBalanceAlert({ cluster: "mainnet", lamports: 1000n, minLamports: 10_000_000n, address: OWNER.toBase58() });
  assert.ok(alert.level === "danger" && alert.message.includes("reveals and settles stop") && alert.message.includes("Deliveries and burns for pegged coins stop too"));
  assert.ok(ascii(alert.message));
});
