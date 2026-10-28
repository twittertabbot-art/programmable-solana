// The strict coin of the rules template in the watcher: the strict part of the config (fixed bytes, the buy mark,
// the reserve), the buy probe under a max wallet, the sell probe around the two locks, the accounts of a swap,
// and the holder sync of the burn keeper. Nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DIRECTION, EVENT_DISC, PROGRAMS, decodePool, decodeRulesConfig, decodeHolderRecord, pda, quoteSwap, rulesPda } from "../../sdk/dist/index.js";
import { diffHookConfig, decodeConfigFields, ceilingAlerts, rulesFixedPartChanged } from "../lib/diff.mjs";
import { buyProbeLamports, expectedOut, strictHeld, sellableHolders, hookRefFor, strictProbeOutcome } from "../lib/simulate.mjs";
import { scorePool } from "../lib/score.mjs";
import { recordsToSync, syncEffect, syncLine, syncAll, readHolderExcess, holderScanDue, HOLDER_SCAN_MAX_AGE_MS, NO_SYNC_TOTALS, SYNCS_PER_PASS, SYNCS_PER_TX } from "../lib/burn.mjs";
import { healthBody } from "../lib/server.mjs";
import { parseArgs, buildConfig, describeConfig } from "../lib/config.mjs";
import { loadState, saveState, emptyState } from "../lib/state.mjs";
import { rulesConfig, strictConfig, holderRecordBytes, poolBytes, tokenAccountBytes, extraMetasBytes, mint2022Bytes, POOL, OWNER, OTHER, TOKEN_2022_PROGRAM } from "./bytes.mjs";

const ctx = { time: "2026-10-15T12:00:00.000Z", slot: 5000 };
const levels = (r) => r.alerts.map((a) => a.level);
const key = () => Keypair.generate().publicKey;
const RULES_FLAGS = 13125;
const strictHook = (o = {}) => ({ template: "rules", flags: RULES_FLAGS, rules: decodeRulesConfig(strictConfig(o)) });
const q = { reserveBase: 1_000_000_000_000_000n, reserveQuote: 2_000_000_000n, lpFeeBps: 100, protocolFeeBps: 20, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000 };

test("strict: the kind and the four numbers are fixed at launch; every byte of 374 and 376 to 396 bent is danger", () => {
  const before = strictConfig();
  assert.equal(before.length, 414);
  const c = decodeRulesConfig(before);
  assert.equal(c.kind, 1); assert.equal(c.maxWalletBps, 300); assert.equal(c.earlySlots, 80); assert.equal(c.maxWalletSlots, 330); assert.equal(c.earlyUnlockSlots, 200); assert.equal(c.maxWalletAmount, 30_000_000_000_000n);
  for (const i of [374, ...Array.from({ length: 21 }, (_, j) => 376 + j)]) {
    const bent = Uint8Array.from(before); bent[i] ^= 0x02;
    const r = diffHookConfig("rules", before, bent, ctx);
    assert.ok(r.alerts.length >= 1 && r.alerts.every((a) => a.level === "danger"), `byte ${i}: ${JSON.stringify(r.alerts)}`);
  }
  const named = diffHookConfig("rules", before, strictConfig({ maxWalletBps: 5000 }), ctx);
  assert.deepEqual(named.changes.map((x) => x.field), ["maxWalletBps"]);
  assert.deepEqual(named.alerts, [{ level: "danger", message: "rules maxWalletBps changed from 300 to 5000 (should be impossible: the rules of a coin are fixed at launch)" }]);
  for (const [over, field] of [[{ earlySlots: 9 }, "earlySlots"], [{ maxWalletSlots: 1 }, "maxWalletSlots"], [{ earlyUnlockSlots: 9 }, "earlyUnlockSlots"], [{ maxWalletAmount: 1n }, "maxWalletAmount"], [{ vaultBump: 1 }, "vaultBump"], [{ kind: 0 }, "kind"]]) {
    assert.deepEqual(diffHookConfig("rules", before, strictConfig(over), ctx).changes.map((x) => x.field), [field]);
  }
  // the running numbers of a strict coin move as on a plain coin: nothing
  const traded = strictConfig({ totalStaked: 9_000_000n, burnPot: 777n, feesSeen: 123n, obsSlot: 4999n, obsReserveBase: 5n, obsReserveQuote: 6n });
  assert.equal(rulesFixedPartChanged(before, traded), false);
  assert.deepEqual(diffHookConfig("rules", before, traded, ctx), { changes: [], alerts: [] });
});

test("strict: the buy mark is 0 between instructions and the reserve is zero; anything else is danger on every read", () => {
  assert.deepEqual(ceilingAlerts("rules", decodeConfigFields("rules", strictConfig())), []);
  assert.deepEqual(ceilingAlerts("rules", decodeConfigFields("rules", rulesConfig())), [], "a plain coin with its zero tail");
  const marked = strictConfig({ buyMark: 1 });
  const m = ceilingAlerts("rules", decodeConfigFields("rules", marked));
  assert.deepEqual(m, [{ level: "danger", message: "the buy mark of this coin's rules (byte 375) is set between two instructions (should be impossible: it is 0 whenever anybody can read the account)" }]);
  assert.deepEqual(levels(diffHookConfig("rules", strictConfig(), marked, ctx)), ["danger"], "and the change itself");
  const dirty = Uint8Array.from(strictConfig()); dirty[405] = 7;
  assert.deepEqual(ceilingAlerts("rules", decodeConfigFields("rules", dirty)).map((a) => a.message), ["bytes 397 to 413 of this coin's rules are not zero (should be impossible)"]);
  assert.deepEqual(levels(diffHookConfig("rules", strictConfig(), dirty, ctx)), ["danger"]);
  const plainWithNumbers = rulesConfig({ maxWalletBps: 300 });
  assert.deepEqual(ceilingAlerts("rules", decodeConfigFields("rules", plainWithNumbers)).map((a) => a.message), ["the config of a plain rules coin carries strict numbers in bytes 376 to 396 (should be impossible)"]);
  assert.ok(ceilingAlerts("rules", decodeConfigFields("rules", strictConfig({ maxWalletBps: 6000 }))).some((a) => a.message.includes("MaxWalletOutOfBounds")));
  assert.ok(ceilingAlerts("rules", decodeConfigFields("rules", strictConfig({ earlySlots: 0 }))).some((a) => a.message.includes("EarlyIncomplete")));
  assert.ok(ceilingAlerts("rules", decodeConfigFields("rules", rulesConfig({ kind: 2 }))).some((a) => a.message.includes("neither plain (0) nor strict (1)")));
});

test("strict: the buy probe stays under a running max wallet; outside the window it is the configured probe", () => {
  // a cap of 0.5% of the supply on a pool of 2 SOL: 0.05 SOL buys about 2.4%
  const hook = strictHook({ maxWalletAmount: 5_000_000_000_000n, maxWalletBps: 50, startSlot: 1000n });
  const r = buyProbeLamports(50_000_000n, hook, 1100, q);
  assert.ok(r.amount < 50_000_000n && r.amount > 0n, String(r.amount));
  assert.deepEqual(r.maxWallet, { amount: 5_000_000_000_000n, untilSlot: 1330n });
  assert.ok(expectedOut(q, DIRECTION.BUY, r.amount, hook, 1100) <= 5_000_000_000_000n);
  assert.ok(expectedOut(q, DIRECTION.BUY, r.amount + 1n, hook, 1100) > 5_000_000_000_000n, "the largest buy that fits, to the lamport");
  assert.deepEqual(buyProbeLamports(50_000_000n, hook, 1330, q), { amount: 50_000_000n, limit: null, maxWallet: null }, "the first slot after the window");
  const wide = buyProbeLamports(50_000_000n, strictHook({ startSlot: 1000n }), 1100, q);
  assert.equal(wide.amount, 50_000_000n, "a cap of 3% takes the whole probe"); assert.equal(wide.maxWallet.amount, 30_000_000_000_000n);
  assert.equal(buyProbeLamports(50_000_000n, hook, 1100).maxWallet, null, "without the pool the probe is not cut");
});

test("strict: while the sniper fee falls, the probe is fitted with the most a buy can give, at the pool's own fee", () => {
  // a sniper fee from 30% over 300 slots, a cap of 0.5% of the supply; read at slot 1100 the fee is 20.34%
  const hook = strictHook({ maxWalletAmount: 5_000_000_000_000n, maxWalletBps: 50, startSlot: 1000n, sniperSlots: 300n, sniperStartFeeBps: 3000 });
  const cap = 5_000_000_000_000n;
  const inWindow = buyProbeLamports(50_000_000n, hook, 1100, q);
  const after = buyProbeLamports(50_000_000n, hook, 1300, q);
  assert.equal(inWindow.amount, after.amount, "the same probe inside the window as right after it: both fitted at the pool's own fee");
  assert.ok(inWindow.amount > 0n && inWindow.amount < 50_000_000n);
  const atRead = expectedOut(q, DIRECTION.BUY, inWindow.amount, hook, 1100);
  const atBase = expectedOut(q, DIRECTION.BUY, inWindow.amount, hook, 1300);
  assert.ok(atRead < atBase && atBase <= cap, `at the read slot ${atRead} coins, at the pool's own fee ${atBase}, cap ${cap}`);
  assert.ok(expectedOut(q, DIRECTION.BUY, inWindow.amount + 1n, hook, 1300) > cap, "one lamport more would pass the cap once the fee is gone");
  // a slot or two later the fee is lower and the output higher, and still under the cap
  for (const later of [1101, 1102, 1150, 1299]) assert.ok(expectedOut(q, DIRECTION.BUY, inWindow.amount, hook, later) <= cap, `slot ${later}`);
  // the old way, fitted at the read slot's fee, would pass the cap one slot later
  const loose = (() => { let lo = 0n; let hi = 50_000_000n; const fits = (x) => { const o = expectedOut(q, DIRECTION.BUY, x, hook, 1100); return o !== null && o <= cap; }; while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (fits(mid)) lo = mid; else hi = mid - 1n; } return lo; })();
  assert.ok(loose > inWindow.amount && expectedOut(q, DIRECTION.BUY, loose, hook, 1101) > cap, "the probe fitted at the read slot alone passes the cap at the next slot");
});

test("strict: a MaxWallet refusal of the buy probe is a setup condition of the coin, not the hook misbehaving", () => {
  const refused = { ok: false, amountOut: null, error: "swap: custom error 6044 (This would leave the receiving wallet above the coin's max wallet.)", stage: "swap", slot: 1101, amountIn: 5n,
    logs: ["Program log: Instruction: Swap", "Program log: AnchorError thrown in programs/hook_rules/src/lib.rs:812. Error Code: MaxWallet. Error Number: 6044. Error Message: This would leave the receiving wallet above the coin's max wallet."] };
  const r = strictProbeOutcome(refused, true);
  assert.equal(r.stage, "setup");
  assert.equal(r.error, "setup: the coin's max wallet refused the buy probe (MaxWallet, 6044): the probe was fitted to the cap at the slot the pool was read at and the pool moved before the simulation. Not the hook's doing.");
  assert.equal(r.ok, false); assert.equal(r.slot, 1101);
  // the score: a setup failure is noted and never counted against the hook
  const ok = { ok: true, stage: null, error: null };
  const base = { hasHook: true, flags: RULES_FLAGS, hookKind: 2, template: "rules", buySim: r, sellSim: ok, effectiveBuyTaxBps: null, effectiveSellTaxBps: 400, capBps: 5455, declaredMismatchBps: 0, taxChangedRecently: false, manifestAdminSet: false, upgradeAuthority: OWNER.toBase58(), recentAlertLevels: [] };
  const scored = scorePool(base);
  assert.equal(scored.score, "clean");
  assert.ok(scored.notes.some((n) => n.startsWith("Buy probe could not be set up (not the hook's doing): setup: the coin's max wallet refused")));
  assert.equal(scorePool({ ...base, buySim: refused }).score, "warning", "left as the chain said it, it would count");
  // everything else comes back as it is
  assert.deepEqual(strictProbeOutcome(refused, false), refused, "a plain rules coin");
  assert.deepEqual(strictProbeOutcome({ ...refused, logs: [refused.logs[1].replace("MaxWallet. Error Number: 6044", "EarlyLocked. Error Number: 6045")] }, true).stage, "swap", "another rule");
  assert.deepEqual(strictProbeOutcome({ ...refused, logs: [refused.logs[1].replace("programs/hook_rules/", "programs/other_hook/")] }, true).stage, "swap", "another program's MaxWallet");
  assert.deepEqual(strictProbeOutcome({ ...refused, stage: "setup", error: "setup: x" }, true).error, "setup: x");
  assert.deepEqual(strictProbeOutcome(ok, true), ok);
  assert.equal(strictProbeOutcome(null, true), null);
});

test("strict: the sell probe skips holders whose coins a lock holds", () => {
  const cfg = decodeRulesConfig(strictConfig({ startSlot: 1000n }));
  const rec = (o) => decodeHolderRecord(holderRecordBytes(o));
  // early lock until slot 1200, a creator lock until Unix time 2,000,000,000
  assert.equal(strictHeld(cfg, rec({ earlyBought: 500n }), 1100, 1_900_000_000), 500n);
  assert.equal(strictHeld(cfg, rec({ earlyBought: 500n }), 1200, 1_900_000_000), 0n, "the early unlock");
  assert.equal(strictHeld(cfg, rec({ locked: 900n, lockedUntil: 2_000_000_000n }), 1300, 1_999_999_999), 900n);
  assert.equal(strictHeld(cfg, rec({ locked: 900n, lockedUntil: 2_000_000_000n }), 1300, 2_000_000_000), 0n, "the creator's date");
  assert.equal(strictHeld(cfg, rec({ earlyBought: 500n, locked: 900n, lockedUntil: 2_000_000_000n }), 1100, 1), 900n, "the larger of the two");
  assert.equal(strictHeld(cfg, null, 1100, 1), 0n, "a wallet without a record");
  assert.equal(strictHeld(decodeRulesConfig(rulesConfig()), rec({ earlyBought: 500n }), 1100, 1), 0n, "a plain coin");
  const a = { owner: key(), amount: 1000n }; const b = { owner: key(), amount: 800n }; const c = { owner: key(), amount: 600n };
  const records = new Map([[a.owner.toBase58(), rec({ earlyBought: 1000n })], [b.owner.toBase58(), rec({ earlyBought: 700n })], [c.owner.toBase58(), null]]);
  assert.deepEqual(sellableHolders([a, b, c], records, cfg, 1100, 1).map((h) => h.amount), [800n, 600n], "the largest holder's coins are all early; 1% of the second is free");
  assert.deepEqual(sellableHolders([a, b, c], records, cfg, 1200, 1).map((h) => h.amount), [1000n, 800n, 600n], "after the unlock all of them");
});

test("strict: a simulated swap carries the coin's own accounts after the pool callback's", async () => {
  const pool = decodePool(POOL, poolBytes({ hookProgram: PROGRAMS.hook_rules, hookFlags: RULES_FLAGS, hookKind: 2, baseMint: OTHER }));
  const cfgKey = pda.cfg(PROGRAMS.hook_rules, POOL);
  const list = extraMetasBytes([{ pubkey: cfgKey, isWritable: true }]);
  const plain = await hookRefFor(null, pool, OWNER, list);
  assert.deepEqual(plain.extra.map((m) => m.pubkey.toBase58()), [cfgKey.toBase58()]);
  const strict = await hookRefFor(null, pool, OWNER, list, { strict: true });
  assert.deepEqual(strict.extra.map((m) => [m.pubkey.toBase58(), m.isWritable]), [
    [cfgKey.toBase58(), true], [rulesPda.holder(POOL, OWNER).toBase58(), true], [rulesPda.holder(POOL, POOL).toBase58(), true], [rulesPda.validation(OTHER).toBase58(), false],
  ]);
});

test("holder sync: which records stand above their wallets' coins by enough", () => {
  const [a, b, c, d] = [key(), key(), key(), key()];
  const records = [{ owner: a, balance: 1000n }, { owner: b, balance: 50_000n }, { owner: c, balance: 7_000n }, { owner: d, balance: 300n }];
  const balances = new Map([[a.toBase58(), 1000n], [b.toBase58(), 10_000n], [c.toBase58(), 6_999n], [d.toBase58(), 400n]]);
  // 100,000 registered: b stands 40,000 above (4,000 bps), c 1 above (0 bps), a and d not above
  const r = recordsToSync(records, balances, 100_000n, 10);
  assert.deepEqual(r.send.map((x) => [x.owner.toBase58(), x.recordBalance, x.balance, x.excess, x.bps]), [[b.toBase58(), 50_000n, 10_000n, 40_000n, 4000]]);
  assert.deepEqual(recordsToSync(records, balances, 100_000n, 0).send.map((x) => x.owner.toBase58()), [b.toBase58(), c.toBase58()], "with no minimum, every record above, largest first");
  const gone = recordsToSync([{ owner: a, balance: 5n }], new Map(), 5n, 10);
  assert.equal(gone.send[0].balance, 0n, "a wallet whose coin account is gone holds nothing");
  const many = Array.from({ length: 13 }, (_, i) => ({ owner: key(), balance: 1000n + BigInt(i) }));
  const cut = recordsToSync(many, new Map(), 20_000n, 10);
  assert.equal(SYNCS_PER_PASS, 10); assert.equal(cut.send.length, 10); assert.equal(cut.later.length, 3);
});

test("holder sync: what a transaction did, the batches, the log lines", async () => {
  const owner = key();
  const ev = Buffer.concat([Buffer.from(EVENT_DISC.HolderSynced), POOL.toBuffer(), owner.toBuffer(), Buffer.from(new BigUint64Array([10_000n]).buffer)]);
  const tx = { slot: 5000, meta: { fee: 5000, innerInstructions: [], logMessages: ["Program log: Instruction: SyncHolder", "Program data: " + ev.toString("base64")] }, transaction: { message: { staticAccountKeys: [] } } };
  assert.deepEqual(syncEffect(tx), { synced: [{ owner: owner.toBase58(), balance: 10_000n }], feeLamports: 5000 });
  assert.equal(syncEffect(null), null);
  const item = { owner, recordBalance: 50_000n, balance: 10_000n, excess: 40_000n, bps: 4000 };
  assert.equal(syncLine(POOL, item, "SIG1"), `sync: pool ${POOL.toBase58()} wallet ${owner.toBase58()}: holder record lowered from 50000 to 10000 raw units, it stood 40000 above the wallet's coins (4000 bps of the coins in holder records), tx SIG1`);
  assert.equal(syncLine(POOL, item, null, "WrongHolder (6050): x"), `sync FAILED: pool ${POOL.toBase58()} wallet ${owner.toBase58()}: WrongHolder (6050): x`);
  // seven records: two transactions of five and two; the first fails and is sent again one by one
  const items = Array.from({ length: 7 }, (_, i) => ({ owner: key(), recordBalance: 10n, balance: 0n, excess: 10n, bps: 100 + i }));
  const sent = [];
  const r = await syncAll({
    pool: POOL, items,
    send: async (owners) => { sent.push(owners.length); if (owners.length === 5) throw new Error("one of them is gone"); if (owners[0].equals(items[2].owner)) throw new Error("Error Code: AccountNotInitialized. Error Number: 3012. Error Message: not there."); return "SIG" + sent.length; },
    readEffect: async () => ({ synced: [], feeLamports: 5000 }),
  });
  assert.equal(SYNCS_PER_TX, 5);
  assert.deepEqual(sent, [5, 1, 1, 1, 1, 1, 2]);
  assert.equal(r.results.length, 7);
  assert.equal(r.results.filter((x) => !x.signature).length, 1); assert.equal(r.results.find((x) => !x.signature).error, "AccountNotInitialized (3012): not there");
  assert.equal(r.feeLamports, 25_000, "five confirmed transactions");
});

test("holder sync: one read of a strict pool's records and one of their wallets' coins", async () => {
  const mint = key(); const a = key(); const b = key();
  const address = pda.pool(mint, new PublicKey("So11111111111111111111111111111111111111112"));
  const pool = decodePool(address, poolBytes({ baseMint: mint, hookProgram: PROGRAMS.hook_rules, hookFlags: RULES_FLAGS, hookKind: 2, baseTokenProgram: TOKEN_2022_PROGRAM }));
  const accounts = new Map();
  accounts.set(pda.cfg(PROGRAMS.hook_rules, address).toBase58(), { owner: PROGRAMS.hook_rules, data: Buffer.from(strictConfig({ pool: address, totalStaked: 60_000n })) });
  accounts.set(pda.ata(a, mint, TOKEN_2022_PROGRAM).toBase58(), { owner: TOKEN_2022_PROGRAM, data: Buffer.from(tokenAccountBytes({ mint, owner: a, amount: 10_000n })) });
  accounts.set(pda.ata(b, mint, TOKEN_2022_PROGRAM).toBase58(), { owner: TOKEN_2022_PROGRAM, data: Buffer.from(tokenAccountBytes({ mint, owner: b, amount: 10_000n })) });
  const calls = [];
  const connection = {
    async getMultipleAccountsInfoAndContext(keys) { calls.push("many:" + keys.length); return { context: { slot: 1 }, value: keys.map((k) => accounts.get(k.toBase58()) ?? null) }; },
    async getProgramAccounts(program, opts) {
      calls.push("records"); assert.ok(program.equals(PROGRAMS.hook_rules)); assert.equal(opts.filters[2].memcmp.bytes, address.toBase58());
      return [{ pubkey: key(), account: { data: Buffer.from(holderRecordBytes({ pool: address, owner: a, balance: 50_000n })) } }, { pubkey: key(), account: { data: Buffer.from(holderRecordBytes({ pool: address, owner: b, balance: 10_000n })) } }];
    },
  };
  const got = await readHolderExcess(connection, [pool], { minBps: 10 });
  // one batched read of the configs and the coins' mints, one of the pool's records, one of their wallets' coins
  assert.deepEqual(calls, ["many:2", "records", "many:2"]);
  assert.equal(got.work.length, 1); assert.equal(got.work[0].records, 2);
  assert.deepEqual(got.work[0].send.map((x) => [x.owner.toBase58(), x.excess]), [[a.toBase58(), 40_000n]]);

  // with the table of the last reads: the records are read again only when the coin's supply moved (a token
  // Burn lowers it), while the last read found records to sync, or once the last read is ten minutes old
  accounts.set(mint.toBase58(), { owner: TOKEN_2022_PROGRAM, data: Buffer.from(mint2022Bytes({ supply: 1_000_000n })) });
  const scans = {};
  const t0 = Date.parse("2026-10-20T12:00:00Z");
  calls.length = 0;
  await readHolderExcess(connection, [pool], { minBps: 10, scans, nowMs: t0 });
  assert.deepEqual(calls, ["many:2", "records", "many:2"], "the first pass reads the records");
  assert.deepEqual(scans[address.toBase58()], { supply: "1000000", at: t0, pending: 1 });
  calls.length = 0;
  await readHolderExcess(connection, [pool], { minBps: 10, scans, nowMs: t0 + 30_000 });
  assert.deepEqual(calls, ["many:2", "records", "many:2"], "a record still waits for its sync: read again");
  // synced: the record counts the wallet's coins now
  const synced = async () => [{ pubkey: key(), account: { data: Buffer.from(holderRecordBytes({ pool: address, owner: a, balance: 10_000n })) } }, { pubkey: key(), account: { data: Buffer.from(holderRecordBytes({ pool: address, owner: b, balance: 10_000n })) } }];
  const quiet = { ...connection, async getProgramAccounts(program, opts) { calls.push("records"); return synced(program, opts); } };
  calls.length = 0;
  await readHolderExcess(quiet, [pool], { minBps: 10, scans, nowMs: t0 + 60_000 });
  assert.equal(scans[address.toBase58()].pending, 0);
  calls.length = 0;
  const idle = await readHolderExcess(quiet, [pool], { minBps: 10, scans, nowMs: t0 + 90_000 });
  assert.deepEqual(calls, ["many:2"], "nothing to sync and the supply did not move: the records are not read");
  assert.deepEqual(idle.work, []);
  accounts.set(mint.toBase58(), { owner: TOKEN_2022_PROGRAM, data: Buffer.from(mint2022Bytes({ supply: 999_000n })) });
  calls.length = 0;
  await readHolderExcess(quiet, [pool], { minBps: 10, scans, nowMs: t0 + 120_000 });
  assert.deepEqual(calls, ["many:2", "records", "many:2"], "the supply fell: somebody burned coins, the records are read");
  calls.length = 0;
  await readHolderExcess(quiet, [pool], { minBps: 10, scans, nowMs: t0 + 120_000 + 600_000 });
  assert.deepEqual(calls, ["many:2", "records", "many:2"], "ten minutes after the last read: read again as a safety net");
  assert.deepEqual([holderScanDue(undefined, "1", 0), holderScanDue({ supply: "1", at: 0, pending: 0 }, "1", HOLDER_SCAN_MAX_AGE_MS - 1), holderScanDue({ supply: "1", at: 0, pending: 0 }, "2", 1)], [true, false, true]);

  // a plain rules coin and a pool of another template are not read
  accounts.set(pda.cfg(PROGRAMS.hook_rules, address).toBase58(), { owner: PROGRAMS.hook_rules, data: Buffer.from(rulesConfig({ pool: address })) });
  calls.length = 0;
  assert.deepEqual((await readHolderExcess(connection, [pool])).work, []);
  assert.deepEqual(calls, ["many:2"]);
  const tax = decodePool(key(), poolBytes({ hookProgram: PROGRAMS.hook_tax, hookKind: 2 }));
  calls.length = 0;
  assert.deepEqual(await readHolderExcess(connection, [tax]), { work: [], unread: [] });
  assert.deepEqual(calls, []);
});

test("holder sync: its settings, its numbers in /health and in the state", () => {
  const c = buildConfig({}, parseArgs([]), "/w");
  assert.deepEqual([c.holderSync, c.holderSyncMinBps], [true, 10]);
  assert.ok(describeConfig(c).holderSync.startsWith("in the burn keeper's pass"));
  assert.equal(buildConfig({ HOLDER_SYNC: "off" }, parseArgs([]), "/w").holderSync, false);
  assert.equal(buildConfig({ HOLDER_SYNC: "off" }, parseArgs([]), "/w").burn, true, "the burn keeper keeps running");
  assert.equal(buildConfig({}, parseArgs(["--no-burn"]), "/w").holderSync, false, "never without the burn keeper");
  assert.equal(buildConfig({ BURN_KEEPER: "off" }, parseArgs([]), "/w").holderSync, false);
  assert.equal(buildConfig({ HOLDER_SYNC_MIN_BPS: "0" }, parseArgs([]), "/w").holderSyncMinBps, 0);
  assert.throws(() => buildConfig({ HOLDER_SYNC: "sometimes" }, parseArgs([])), /HOLDER_SYNC/);
  assert.throws(() => buildConfig({ HOLDER_SYNC_MIN_BPS: "10001" }, parseArgs([])), /above the maximum/);
  const status = { updatedAt: "2026-10-15T11:59:50.000Z", pools: {} };
  const h = healthBody({ status, burn: { enabled: true, lastBurnAt: "2026-10-15T11:59:40.000Z", lastBurnSent: 0, intervalSeconds: 30, totals: null, syncEnabled: true, syncTotals: { sent: 2, failed: 1, records: 6, feeLamports: 10_000 } }, nowMs: Date.parse("2026-10-15T12:00:00Z"), staleAfterMs: 300_000, cluster: "localnet" });
  assert.deepEqual([h.holderSyncEnabled, h.holderSyncsSent, h.holderRecordsSynced, h.holderSyncFailed, h.holderSyncFeesLamports], [true, 2, 6, 1, 10_000]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-sync-"));
  const file = path.join(dir, "state.json");
  const s = emptyState(); s.burn.syncTotals = { sent: 2, failed: 1, records: 6, feeLamports: 10_000 };
  saveState(file, s);
  assert.deepEqual(loadState(file).burn.syncTotals, { sent: 2, failed: 1, records: 6, feeLamports: 10_000 });
  assert.deepEqual(NO_SYNC_TOTALS(), { sent: 0, failed: 0, records: 0, feeLamports: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});
