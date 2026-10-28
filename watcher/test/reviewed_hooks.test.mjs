// Reviewed hooks only (round 13): the three checks the pool pass adds. (a) The platform's approved list: its
// changes as alerts, and `hookApproval` per pool. (b) The manifest and the extra-accounts list of every hook
// program, hashed each pass from the bytes the pass reads anyway. (c) Sells as recent buyers: a hook that spares
// the watcher's wallets and refuses everyone else. A connection and a client made of plain objects; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { PROGRAMS, IX, DIRECTION, FLAGS, HOOK_KIND, decodePool, decodeRulesConfig, pda, rulesPda, CLOCK_SYSVAR } from "../../sdk/dist/index.js";
import { HOOK_APPROVALS, approvalSnapshot, hookApprovalOf, diffApprovals, nextSnapshot, approvalAlerts, poolsByHook } from "../lib/approvals.mjs";
import { digestOf, hookAccountsOf, trackHookAccounts, hookAccountAlert, HOOK_ACCOUNT_CHANGES_KEPT } from "../lib/hookaccounts.mjs";
import { recentBuyersOf, holdingBuyers, simulateHolderSell, holderSellVerdict, checkHolderSells, holderSellsAlert, holderSellsNote } from "../lib/holdersells.mjs";
import { tradesFile } from "../lib/feed.mjs";
import { poolEntry, buildStatus } from "../lib/status.mjs";
import { loadState, saveState, emptyState } from "../lib/state.mjs";
import { buildConfig, parseArgs, describeConfig } from "../lib/config.mjs";
import { poolBytes, tokenAccountBytes, extraMetasBytes, strictConfig, holderRecordBytes, clockBytes, POOL, BASE_MINT, TOKEN_PROGRAM, OTHER } from "./bytes.mjs";

const key = () => Keypair.generate().publicKey;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-hooks-"));
const SELL_FLAGS = FLAGS.BEFORE_SWAP | FLAGS.CALL_ON_BUY | FLAGS.CALL_ON_SELL | FLAGS.TAKE_HOOK_FEE;
const HOOK = new PublicKey("Hook111111111111111111111111111111111111111");
const customPool = (o = {}) => decodePool(o.address ?? POOL, poolBytes({ hookProgram: o.hookProgram ?? HOOK, hookFlags: o.flags ?? SELL_FLAGS, hookKind: o.kind ?? HOOK_KIND.FROZEN }));
const plainPool = () => decodePool(POOL, poolBytes({}));
const platform = (o = {}) => ({ hookApprovalRequired: !!o.required, approvedHooks: o.programs ?? [], approvedListCorrupt: !!o.corrupt });

// ---- (a) the approved list -------------------------------------------------------------------------------------

test("approved list: where a pool stands: own, approved, not approved", () => {
  const listed = key(); const unlisted = key();
  const on = approvalSnapshot(platform({ required: true, programs: [listed] }));
  const off = approvalSnapshot(platform({ required: false, programs: [listed] }));
  assert.deepEqual(HOOK_APPROVALS, ["own", "approved", "not approved"]);
  assert.equal(hookApprovalOf(plainPool(), on), "own", "no hook");
  assert.equal(hookApprovalOf(customPool({ kind: HOOK_KIND.PLATFORM, hookProgram: unlisted }), on), "own", "a hook the platform whitelists");
  assert.equal(hookApprovalOf(customPool({ hookProgram: PROGRAMS.hook_tax }), on), "own", "a template");
  assert.equal(hookApprovalOf(customPool({ hookProgram: listed }), on), "approved");
  assert.equal(hookApprovalOf(customPool({ hookProgram: unlisted }), on), "not approved", "a pool made before the rule, or a hook taken off the list");
  assert.equal(hookApprovalOf(customPool({ hookProgram: listed }), off), "approved", "the list counts with the rule off too");
  assert.equal(hookApprovalOf(customPool({ hookProgram: unlisted }), off), "not approved", "an outside hook nobody reviewed, with the rule off");
  const corrupt = approvalSnapshot(platform({ required: true, programs: [], corrupt: true }));
  assert.equal(hookApprovalOf(customPool({ hookProgram: listed }), { ...corrupt, programs: [listed.toBase58()] }), "not approved", "a list the program cannot read approves nothing");
});

test("approved list: the first pass records, then the rule, an approval, a revoke and a corrupt list are changes", () => {
  const a = key().toBase58(); const b = key().toBase58();
  const s0 = approvalSnapshot(platform({ required: false }));
  assert.deepEqual(diffApprovals(null, s0), [], "the first pass only records");
  const s1 = approvalSnapshot(platform({ required: true }));
  assert.deepEqual(diffApprovals(s0, s1), [{ kind: "rule", required: true }]);
  const s2 = approvalSnapshot(platform({ required: true, programs: [new PublicKey(b), new PublicKey(a)] }));
  assert.deepEqual(s2.programs, [a, b].sort(), "sorted");
  assert.deepEqual(diffApprovals(s1, s2).map((c) => c.kind).sort(), ["approved", "approved"]);
  const s3 = approvalSnapshot(platform({ required: true, programs: [new PublicKey(a)] }));
  assert.deepEqual(diffApprovals(s2, s3), [{ kind: "revoked", program: b }]);
  assert.deepEqual(diffApprovals(s3, s3), []);
  // a list that cannot be read is not a list of nothing: no revoke, and the last good list is kept
  const bad = approvalSnapshot(platform({ required: true, corrupt: true }));
  assert.deepEqual(diffApprovals(s3, bad), [{ kind: "corrupt", corrupt: true }]);
  const kept = nextSnapshot(s3, bad);
  assert.deepEqual(kept, { required: true, programs: [a], corrupt: true });
  assert.deepEqual(diffApprovals(kept, s3), [{ kind: "corrupt", corrupt: false }], "readable again with the same list: one change");
});

test("approved list: the alerts in words, with the pools of the hook, and the lines of platform.changes", () => {
  const prog = key(); const other = key();
  const pools = [customPool({ address: key(), hookProgram: prog }), customPool({ address: key(), hookProgram: prog }), customPool({ address: key(), hookProgram: other }), plainPool()];
  const by = poolsByHook(pools);
  assert.deepEqual(by.get(prog.toBase58()), [pools[0].address.toBase58(), pools[1].address.toBase58()].sort());
  const alerts = approvalAlerts([{ kind: "rule", required: true }, { kind: "rule", required: false }, { kind: "approved", program: other.toBase58() }, { kind: "revoked", program: prog.toBase58() }, { kind: "revoked", program: key().toBase58() }, { kind: "corrupt", corrupt: true }], by);
  assert.ok(alerts[0].message.startsWith("the approved-list rule is now on") && alerts[0].level === "info");
  assert.ok(alerts[1].message.startsWith("the approved-list rule is now off") && alerts[1].level === "warning");
  assert.ok(alerts[2].message.startsWith(`hook ${other.toBase58()} was approved`) && alerts[2].message.endsWith(pools[2].address.toBase58()));
  assert.ok(alerts[3].message.startsWith(`hook ${prog.toBase58()} was taken off the approved list`) && alerts[3].level === "warning");
  for (const p of by.get(prog.toBase58())) assert.ok(alerts[3].message.includes(p), "names every pool that uses it");
  assert.ok(alerts[4].message.endsWith(": none"), "a hook no pool uses");
  assert.equal(alerts[5].level, "danger");
  assert.deepEqual(alerts.map((a) => a.change), [
    { field: "hookApprovalRequired", from: "false", to: "true" }, { field: "hookApprovalRequired", from: "true", to: "false" },
    { field: "approvedHooks", from: "none", to: other.toBase58() }, { field: "approvedHooks", from: prog.toBase58(), to: "none" },
    { field: "approvedHooks", from: alerts[4].change.from, to: "none" }, { field: "approvedListCorrupt", from: "false", to: "true" },
  ]);
  for (const a of alerts) assert.ok(/^[\x20-\x7e]*$/.test(a.message), "plain ASCII");
});

test("approved list: pools.json carries hookApproval and approvedList, the base schema stays without them", () => {
  const base = { lastCheck: "t", score: "clean", hookKind: "frozen", template: "custom", buySim: { ok: true }, sellSim: { ok: true } };
  assert.equal(poolEntry({ ...base, hookApproval: "not approved" }).hookApproval, "not approved");
  assert.equal("hookApproval" in poolEntry({ ...base, hookApproval: "maybe" }), false, "an unknown value is dropped");
  assert.equal("hookApproval" in poolEntry(base), false);
  const st = buildStatus({ updatedAt: "t", cluster: "localnet", platform: { whitelist: [] }, platformChanges: [], pools: {}, approvedList: { required: true, programs: ["P"], corrupt: false } });
  assert.deepEqual(st.approvedList, { required: true, programs: ["P"], corrupt: false });
  assert.equal("approvedList" in buildStatus({ updatedAt: "t", cluster: "localnet", platform: { whitelist: [] }, platformChanges: [], pools: {} }), false);
});

// ---- (b) the hook accounts ---------------------------------------------------------------------------------------

test("hook accounts: one entry per hook program, recorded first, a change names the hook, the account and the pools", () => {
  const prog = key();
  const p1 = customPool({ address: key(), hookProgram: prog }); const p2 = customPool({ address: key(), hookProgram: prog });
  const p3 = customPool({ address: key(), hookProgram: PROGRAMS.hook_tax, kind: HOOK_KIND.PLATFORM });
  const pools = [p1, p2, p3, plainPool()];
  const bytes = (m, e) => ({ manifestBytes: m === null ? null : Uint8Array.from(m), extraMetasBytes: e === null ? null : Uint8Array.from(e) });
  const hooksOf = (m, e) => new Map([[p1.address.toBase58(), bytes(m, e)], [p2.address.toBase58(), bytes(m, e)], [p3.address.toBase58(), bytes([9], [9])]]);
  const cur = hookAccountsOf(pools, hooksOf([1, 2], [3, 4]));
  assert.deepEqual([...cur.keys()].sort(), [prog.toBase58(), PROGRAMS.hook_tax.toBase58()].sort(), "one entry per program, the pool without a hook left out");
  assert.deepEqual(cur.get(prog.toBase58()), { manifest: digestOf([1, 2]), extraMetas: digestOf([3, 4]), pools: [p1.address.toBase58(), p2.address.toBase58()].sort() });
  const kept = {};
  assert.deepEqual(trackHookAccounts(kept, cur, { slot: 100, nowIso: "t0" }), [], "the first pass only records");
  assert.equal(kept[prog.toBase58()].changedAtSlot, null);
  assert.deepEqual(trackHookAccounts(kept, hookAccountsOf(pools, hooksOf([1, 2], [3, 4])), { slot: 110, nowIso: "t1" }), [], "nothing changed");
  const ch = trackHookAccounts(kept, hookAccountsOf(pools, hooksOf([1, 2], [3, 5])), { slot: 120, nowIso: "t2" });
  assert.equal(ch.length, 1);
  assert.deepEqual([ch[0].program, ch[0].account, ch[0].address, ch[0].slot, ch[0].pools.length], [prog.toBase58(), "extraMetas", pda.extraMetas(prog).toBase58(), 120, 2]);
  assert.deepEqual([kept[prog.toBase58()].changedAtSlot, kept[prog.toBase58()].extraMetas], [120, digestOf([3, 5])]);
  const a = hookAccountAlert(ch[0]);
  assert.equal(a.level, "danger");
  for (const part of [prog.toBase58(), "rewrote its extra-accounts list", pda.extraMetas(prog).toBase58(), "slot 120", p1.address.toBase58(), p2.address.toBase58()]) assert.ok(a.message.includes(part), part);
  // the manifest closed: a warning that says so
  const closed = trackHookAccounts(kept, hookAccountsOf(pools, hooksOf(null, [3, 5])), { slot: 130, nowIso: "t3" });
  assert.deepEqual([closed[0].account, closed[0].to, hookAccountAlert(closed[0]).level], ["manifest", null, "warning"]);
  assert.ok(hookAccountAlert(closed[0]).message.includes("closed its manifest (account " + pda.manifest(prog).toBase58() + ")"));
  // a new program later on: recorded, no alert
  const late = customPool({ address: key(), hookProgram: key() });
  assert.deepEqual(trackHookAccounts(kept, hookAccountsOf([late], new Map([[late.address.toBase58(), bytes([1], [1])]])), { slot: 140, nowIso: "t4" }), []);
  // the history of one program stays short
  for (let i = 0; i < 30; i++) trackHookAccounts(kept, hookAccountsOf(pools, hooksOf([1], [i])), { slot: 200 + i, nowIso: "t" });
  assert.equal(kept[prog.toBase58()].changes.length, HOOK_ACCOUNT_CHANGES_KEPT);
  assert.ok(kept[prog.toBase58()].changes.every((c) => c.from.length <= 16 && c.to.length <= 16), "short digests in the history");
});

test("hook accounts: pools.json carries hookAccountsChangedAtSlot on pools with a hook; the state keeps the digests", () => {
  const base = { lastCheck: "t", score: "clean", hookKind: "frozen", template: "custom" };
  assert.equal(poolEntry({ ...base, hookAccountsChangedAtSlot: 120 }).hookAccountsChangedAtSlot, 120);
  assert.equal(poolEntry({ ...base, hookAccountsChangedAtSlot: null }).hookAccountsChangedAtSlot, null);
  assert.equal("hookAccountsChangedAtSlot" in poolEntry(base), false);
  const dir = tmpDir();
  const file = path.join(dir, "state.json");
  const s = emptyState();
  s.approvals = { required: true, programs: ["P"], corrupt: false };
  s.hookAccounts = { P: { manifest: "a", extraMetas: "b", firstSeenAt: "t", changedAtSlot: 7, changedAt: "t", changes: [] } };
  saveState(file, s);
  assert.deepEqual(loadState(file), s, "both survive a restart");
  fs.writeFileSync(file, JSON.stringify({ approvals: { programs: "nope" }, hookAccounts: [1] }));
  const l = loadState(file);
  assert.deepEqual([l.approvals, l.hookAccounts], [null, {}], "a malformed part reads as never recorded");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- (c) sells as recent buyers ----------------------------------------------------------------------------------

const tokenAccount = (owner, amount, mint = BASE_MINT) => ({ owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false, data: Buffer.from(tokenAccountBytes({ mint, owner, amount })) });
const ataOf = (owner) => pda.ata(owner, BASE_MINT, TOKEN_PROGRAM);
function tradesDirWith(pool, events) {
  const dir = tmpDir();
  const list = events.map((e, i) => ({ kind: "Swapped", signature: `s${i}`, blockTime: 1, pool: pool.toBase58(), user: e.user.toBase58(), direction: e.direction ?? DIRECTION.BUY, amountIn: "1", amountOut: "1", protocolFee: "0", hookFee: "0", lpFee: "0", feeBpsApplied: 100, reserveBase: "1", reserveQuote: "1", slot: String(1000 - i), byHook: !!e.byHook }));
  fs.writeFileSync(path.join(dir, `${pool.toBase58()}.json`), JSON.stringify(tradesFile({ pool: pool.toBase58(), updatedAt: "t", slot: 1000, backfill: { transactions: list.length, reachedCreation: true }, curve: null, events: list })));
  return dir;
}
const swapIx = (user, pool, direction, amountIn) => new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: [{ pubkey: user, isSigner: true, isWritable: true }, { pubkey: pool.address, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from(IX.hookpool.swap), Buffer.from([direction]), Buffer.from(new BigUint64Array([amountIn]).buffer)]) });
const fakeClient = { async swapInstructions(user, pool, hookRef, direction, amountIn) { return [swapIx(user, pool, direction, amountIn)]; } };
/// What a hook that refuses a wallet's sell leaves in the logs, and the error of the transaction.
const hookRefusal = (hook = HOOK) => ({
  err: { InstructionError: [0, { Custom: 6000 }] },
  logs: [`Program ${PROGRAMS.hookpool.toBase58()} invoke [1]`, `Program ${hook.toBase58()} invoke [2]`, "Program log: AnchorError occurred. Error Code: SellsClosed. Error Number: 6000. Error Message: sells are closed for this wallet.",
    `Program ${hook.toBase58()} consumed 900 of 190000 compute units`, `Program ${hook.toBase58()} failed: custom program error: 0x1770`, `Program ${PROGRAMS.hookpool.toBase58()} failed: custom program error: 0x1770`],
});
/// A chain in memory: token accounts and records by address; a simulation that answers per fee payer.
function fakeChain({ accounts = new Map(), refuse = new Map() } = {}) {
  const calls = { multiple: [], simulations: [] };
  return {
    calls,
    async getMultipleAccountsInfo(keys) { calls.multiple.push(keys.length); return keys.map((k) => accounts.get(k.toBase58()) ?? null); },
    async simulateTransaction(tx, config) {
      assert.ok(tx instanceof VersionedTransaction, "a versioned transaction");
      const payer = tx.message.staticAccountKeys[0].toBase58();
      const swap = tx.message.compiledInstructions.find((i) => tx.message.staticAccountKeys[i.programIdIndex].equals(PROGRAMS.hookpool));
      calls.simulations.push({ payer, config, direction: swap.data[8], amountIn: Buffer.from(swap.data).readBigUInt64LE(9) });
      const r = refuse.get(payer);
      if (r) return { context: { slot: 900 }, value: { err: r.err, logs: r.logs } };
      return { context: { slot: 900 }, value: { err: null, logs: [] } };
    },
  };
}
const customHook = () => ({ template: "custom", flags: SELL_FLAGS, extraMetasBytes: extraMetasBytes([]) });

test("sells as recent buyers: the buyers of a pool from its trades file, newest first, without the watcher's wallets", () => {
  const [a, b, c, d, probe] = [key(), key(), key(), key(), key()];
  const dir = tradesDirWith(POOL, [{ user: a }, { user: b, direction: DIRECTION.SELL }, { user: c, byHook: true }, { user: a }, { user: probe }, { user: d }]);
  assert.deepEqual(recentBuyersOf(dir, POOL, { exclude: [probe, null] }).buyers.map((k) => k.toBase58()), [a.toBase58(), d.toBase58()], "buys only, no doubles, not the hook's own buys, not the probe");
  assert.deepEqual(recentBuyersOf(dir, POOL, { max: 1 }).buyers.length, 1);
  assert.deepEqual(recentBuyersOf(dir, POOL, { exclude: [a.toBase58()] }).buyers.map((k) => k.toBase58()), [probe.toBase58(), d.toBase58()]);
  assert.deepEqual(recentBuyersOf(tmpDir(), POOL), { found: false, buyers: [] });
  assert.deepEqual(recentBuyersOf(dir, "not-a-pool"), { found: false, buyers: [] });
});

test("sells as recent buyers: who still holds, in one read; a strict coin's locked holders left out", async () => {
  const pool = customPool();
  const [full, empty, missing, wrongMint] = [key(), key(), key(), key()];
  const accounts = new Map([[ataOf(full).toBase58(), tokenAccount(full, 5000n)], [ataOf(empty).toBase58(), tokenAccount(empty, 0n)], [ataOf(wrongMint).toBase58(), tokenAccount(wrongMint, 99n, OTHER)]]);
  const chain = fakeChain({ accounts });
  const got = await holdingBuyers(chain, pool, [empty, missing, wrongMint, full]);
  assert.deepEqual(got.map((h) => [h.owner.toBase58(), h.amount]), [[full.toBase58(), 5000n]]);
  assert.deepEqual(chain.calls.multiple, [4], "one read of their token accounts");
  // a strict coin: the clock and the records ride in the same read; a wallet whose coins the early lock holds is out
  const cfg = decodeRulesConfig(strictConfig());
  const [locked, free] = [key(), key()];
  accounts.set(ataOf(locked).toBase58(), tokenAccount(locked, 1_000_000n));
  accounts.set(ataOf(free).toBase58(), tokenAccount(free, 1_000_000n));
  accounts.set(CLOCK_SYSVAR.toBase58(), { owner: key(), data: Buffer.from(clockBytes({ slot: 1100n })) });
  accounts.set(rulesPda.holder(pool.address, locked).toBase58(), { owner: PROGRAMS.hook_rules, data: Buffer.from(holderRecordBytes({ owner: locked, balance: 1_000_000n, earlyBought: 1_000_000n })) });
  const strictChain = fakeChain({ accounts });
  const s = await holdingBuyers(strictChain, pool, [locked, free], { strictCfg: cfg });
  assert.deepEqual(s.map((h) => h.owner.toBase58()), [free.toBase58()]);
  assert.deepEqual(strictChain.calls.multiple, [5], "two accounts, the clock and two records, in one read");
});

test("sells as recent buyers: each wallet's own sell of 1%, the wallet as fee payer, sigVerify off, the blockhash replaced", async () => {
  const pool = customPool();
  const w = key();
  const chain = fakeChain();
  const r = await simulateHolderSell(chain, fakeClient, pool, { program: HOOK, treasury: key(), extra: [] }, { owner: w, amount: 12_345n });
  assert.equal(r.ok, true);
  assert.deepEqual(chain.calls.simulations, [{ payer: w.toBase58(), config: { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }, direction: DIRECTION.SELL, amountIn: 123n }]);
  await simulateHolderSell(chain, fakeClient, pool, { program: HOOK, treasury: key(), extra: [] }, { owner: w, amount: 50n });
  assert.equal(chain.calls.simulations[1].amountIn, 1n, "at least 1 raw unit");
});

test("sells as recent buyers: the hook's refusal, and the refusals any trade can meet", () => {
  const ok = { ok: true };
  assert.equal(holderSellVerdict(ok, HOOK).hook, false);
  const hookSaysNo = { ok: false, swapIndex: 0, ...hookRefusal() };
  const v = holderSellVerdict(hookSaysNo, HOOK);
  assert.equal(v.hook, true);
  assert.ok(v.reason.includes(`the hook program ${HOOK.toBase58()} refused the sell: SellsClosed (6000): sells are closed for this wallet`), v.reason);
  const pool = PROGRAMS.hookpool.toBase58();
  const anchorLine = (name, n) => `Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${n}. Error Message: x.`;
  const cases = [
    ["the pool refused what the hook answered", { err: { InstructionError: [0, { Custom: 6030 }] }, logs: [anchorLine("BadHookReturn", 6030), `Program ${pool} failed: custom program error: 0x178e`] }, true],
    ["the pool's slippage", { err: { InstructionError: [0, { Custom: 6008 }] }, logs: [anchorLine("Slippage", 6008), `Program ${pool} failed: custom program error: 0x1778`] }, false],
    ["an account the wallet does not have, inside the hook", { err: { InstructionError: [0, { Custom: 3012 }] }, logs: [anchorLine("AccountNotInitialized", 3012), `Program ${HOOK.toBase58()} failed: custom program error: 0xbc4`] }, false],
    ["the wallet's coins, refused by the token program", { err: { InstructionError: [0, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds", `Program ${TOKEN_PROGRAM.toBase58()} failed: custom program error: 0x1`, `Program ${HOOK.toBase58()} failed: custom program error: 0x1`] }, false],
    ["a hook that says insufficient funds itself is still the hook", { err: { InstructionError: [0, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds", `Program ${HOOK.toBase58()} failed: custom program error: 0x1`] }, true],
    ["the instruction before the swap", { err: { InstructionError: [0, "InvalidAccountData"] }, logs: [], swapIndex: 1 }, false],
    ["refused before it ran", { err: "AccountNotFound", logs: [] }, false],
    ["a token program error", { err: { InstructionError: [0, { Custom: 1 }] }, logs: [`Program ${TOKEN_PROGRAM.toBase58()} failed: custom program error: 0x1`] }, false],
  ];
  for (const [what, r, hook] of cases) assert.equal(holderSellVerdict({ ok: false, swapIndex: 0, ...r }, HOOK).hook, hook, what);
  // a strict coin's rule, from the rules program, is no misbehaving hook
  const strict = { ok: false, swapIndex: 0, err: { InstructionError: [0, { Custom: 6045 }] }, logs: [anchorLine("EarlyLocked", 6045), `Program ${PROGRAMS.hook_rules.toBase58()} failed: custom program error: 0x178d`] };
  assert.equal(holderSellVerdict(strict, PROGRAMS.hook_rules).hook, false);
  assert.equal(holderSellVerdict(strict, HOOK).hook, false, "another program than the hook");
});

test("sells as recent buyers: a hook that spares the large holder and refuses the others is caught, within the budget", async () => {
  const pool = customPool();
  const [probeHolder, b1, b2, b3, b4] = [key(), key(), key(), key(), key()];
  const dir = tradesDirWith(POOL, [b1, probeHolder, b2, b3, b4].map((user) => ({ user })));
  const accounts = new Map([probeHolder, b1, b2, b3, b4].map((o) => [ataOf(o).toBase58(), tokenAccount(o, 1_000_000n)]));
  const refuse = new Map([[b1.toBase58(), hookRefusal()], [b3.toBase58(), hookRefusal()]]);
  const chain = fakeChain({ accounts, refuse });
  const budget = { left: 30 };
  const r = await checkHolderSells({ connection: chain, client: fakeClient, pool, hook: customHook(), dir, perPool: 3, budget, exclude: [probeHolder.toBase58()] });
  assert.deepEqual([r.tried, r.passed, r.failed.map((f) => f.wallet), r.skipped], [3, 1, [b1.toBase58(), b3.toBase58()], null]);
  assert.deepEqual(chain.calls.simulations.map((s) => s.payer), [b1, b2, b3].map((k) => k.toBase58()), "the newest buyers, never the sell probe's holder");
  assert.deepEqual([chain.calls.multiple, budget.left], [[4], 27], "one read of four token accounts, three simulations");
  const alert = holderSellsAlert(r);
  assert.equal(alert.level, "danger");
  assert.ok(alert.message.startsWith("sells fail for some holders: 2 of 3 wallets that bought lately could not sell") && alert.message.includes("SellsClosed"), alert.message);
  // the pass's budget: the second pool gets what is left, then nothing
  const tight = { left: 2 };
  const r2 = await checkHolderSells({ connection: fakeChain({ accounts }), client: fakeClient, pool, hook: customHook(), dir, perPool: 3, budget: tight, exclude: [probeHolder] });
  assert.deepEqual([r2.tried, tight.left, r2.skipped], [2, 0, "the pass spent its holder simulations before this pool's last ones"]);
  const r3 = await checkHolderSells({ connection: fakeChain({ accounts }), client: fakeClient, pool, hook: customHook(), dir, perPool: 3, budget: tight });
  assert.deepEqual([r3.tried, r3.skipped], [0, "the pass spent its holder simulations on other pools"]);
  // nothing to sell as, in words
  const none = await checkHolderSells({ connection: fakeChain(), client: fakeClient, pool, hook: customHook(), dir: tmpDir(), budget: { left: 5 } });
  assert.equal(none.skipped, "the trades feed has no trades of this pool yet");
  const nobody = await checkHolderSells({ connection: fakeChain(), client: fakeClient, pool, hook: customHook(), dir, budget: { left: 5 } });
  assert.equal(nobody.skipped, "none of the 5 wallets that bought lately still holds the coin");
  // a read that fails is said in words, never thrown
  const broken = { getMultipleAccountsInfo: async () => { throw new Error("fetch failed"); } };
  const down = await checkHolderSells({ connection: broken, client: fakeClient, pool, hook: customHook(), dir, budget: { left: 5 } });
  assert.match(down.skipped, /^the holder sells could not be set up this time: fetch failed/);
});

test("sells as recent buyers: the note, the status field and the settings", () => {
  assert.match(holderSellsNote(null, 3), /^Sells as recent buyers: not checked yet\. When the pool is simulated, up to 3 wallets/);
  assert.equal(holderSellsNote({ at: "2026-10-24T10:00:00.000Z", tried: 3, passed: 1, failed: 2, other: 0, skipped: null }, 3), "Sells as recent buyers, last checked at 2026-10-24T10:00:00.000Z: 3 wallets that bought lately sold 1% of their coins in a simulation. 1 went through, 2 were refused by the hook.");
  assert.match(holderSellsNote({ at: "t", tried: 1, passed: 1, failed: 0, other: 0, skipped: "x" }, 3), /1 wallet that bought lately.*Not checked this time: x\.$/);
  const base = { lastCheck: "t", score: "danger", hookKind: "frozen", template: "custom" };
  const e = poolEntry({ ...base, holderSellFails: { at: "t", tried: 3, failed: 1, wallets: [{ wallet: "W", error: "the hook program refused: {\"json\":1}" }], extra: 1 } });
  assert.deepEqual(Object.keys(e.holderSellFails), ["at", "tried", "failed", "wallets"]);
  assert.equal(e.holderSellFails.wallets[0].wallet, "W");
  assert.ok(!e.holderSellFails.wallets[0].error.includes("{"), "words only");
  assert.equal(poolEntry({ ...base, holderSellFails: null }).holderSellFails, null);
  assert.equal("holderSellFails" in poolEntry(base), false);
  const c = buildConfig({}, parseArgs([]), "/w");
  assert.deepEqual([c.approvalWatch, c.hookAccountsWatch, c.holderSims, c.holderSimsPerPool], [true, true, 30, 3]);
  const off = buildConfig({ APPROVAL_WATCH: "off", HOOK_ACCOUNTS_WATCH: "0", HOLDER_SIMS: "0", HOLDER_SIMS_PER_POOL: "5" }, parseArgs([]), "/w");
  assert.deepEqual([off.approvalWatch, off.hookAccountsWatch, off.holderSims, off.holderSimsPerPool], [false, false, 0, 5]);
  assert.equal(buildConfig({ HOLDER_SIMS: "off" }, parseArgs([]), "/w").holderSims, 0);
  assert.throws(() => buildConfig({ APPROVAL_WATCH: "maybe" }, parseArgs([])), /APPROVAL_WATCH=maybe must be on or off/);
  assert.throws(() => buildConfig({ HOLDER_SIMS_PER_POOL: "11" }, parseArgs([])), /above the maximum/);
  assert.throws(() => buildConfig({ HOLDER_SIMS: "-1" }, parseArgs([])), /below the minimum/);
  const d = describeConfig(c);
  assert.match(d.holderSells, /up to 3 recent buyers who still hold, at most 30 a pass/);
  assert.equal(describeConfig(off).holderSells, "off (HOLDER_SIMS=0)");
  assert.equal(describeConfig(off).approvedList, "off (APPROVAL_WATCH=off)");
});
