// The approved list (HOOKS.md section 6.1), offline: the platform decoder, the two admin
// instructions, the eleventh option of update_platform, the events, and the checks the
// builders make before anything is built. Runs on the built bundle:
//   npm run build -w sdk && npm test -w sdk
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  HookpoolClient, ix, decodePlatform, decodeApprovedList, decodeEvent, hookApprovalOf, approvalErrorFromLogs, HookApprovalRefusal,
  APPROVED_LIST_OFFSET, APPROVAL_RULE_OFFSET, MAX_APPROVED_HOOKS, APPROVAL_ERRORS, ACCOUNT_DISC, EVENT_DISC, IX, PROGRAMS, NATIVE_MINT, NO_HOOK,
  SYSTEM_PROGRAM, TOKEN_PROGRAM, pda,
} from "../dist/index.js";

const key = () => Keypair.generate().publicKey;
const SOL = 1_000_000_000n;

/// A platform account as the chain holds it: 451 bytes, plus the list when `list` is given.
function platformBytes({ rule = false, list = null, whitelist = [] } = {}) {
  const b = Buffer.alloc(list ? APPROVED_LIST_OFFSET + 4 + 32 * list.length : APPROVED_LIST_OFFSET);
  Buffer.from(ACCOUNT_DISC.Platform).copy(b, 0);
  b.writeUInt16LE(20, 105); b.writeUInt16LE(1000, 107); b.writeUInt16LE(1000, 109); b.writeUInt16LE(5000, 111);
  b.writeUInt8(whitelist.length, 122);
  whitelist.forEach((w, i) => Buffer.from(w.toBytes()).copy(b, 123 + 32 * i));
  b.writeBigUInt64LE(30n * SOL, 387); b.writeBigUInt64LE(85n * SOL, 395);
  b.writeUInt8(rule ? 1 : 0, APPROVAL_RULE_OFFSET);
  if (list) {
    b.writeUInt32LE(list.length, APPROVED_LIST_OFFSET);
    list.forEach((p, i) => Buffer.from(p.toBytes()).copy(b, APPROVED_LIST_OFFSET + 4 + 32 * i));
  }
  return b;
}

/// A connection that answers from a map and counts the reads.
function standIn(accounts) {
  const calls = [];
  const look = (k) => accounts.get(k.toBase58()) ?? null;
  return {
    calls,
    async getAccountInfo(k) { calls.push("getAccountInfo:" + k.toBase58()); return look(k); },
    async getMultipleAccountsInfo(keys) { calls.push("getMultipleAccounts"); return keys.map(look); },
  };
}
const platformAcct = (opts) => ({ data: platformBytes(opts), owner: PROGRAMS.hookpool, lamports: 1, executable: false });
/// ProgramData of loader v3 with an upgrade authority (or none).
function programDataAcct(authority) {
  const b = Buffer.alloc(45);
  b.writeUInt32LE(3, 0);
  if (authority) { b.writeUInt8(1, 12); Buffer.from(authority.toBytes()).copy(b, 13); }
  return { data: b, owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), lamports: 1, executable: false };
}

test("the layout: the rule at byte 405, the list from byte 451, 256 at most", () => {
  assert.equal(APPROVAL_RULE_OFFSET, 405);
  assert.equal(APPROVED_LIST_OFFSET, 451);
  assert.equal(MAX_APPROVED_HOOKS, 256);
  // 405 is the byte right after the curve's graduation fee (403, two bytes)
  const p = decodePlatform(platformBytes({ rule: true }));
  assert.equal(p.hookApprovalRequired, true);
  assert.equal(p.curveGraduationFeeBps, 0);
  assert.equal(p.curveVirtualQuote, 30n * SOL);
});

test("a platform written before the rule existed reads it off with no list", () => {
  const p = decodePlatform(platformBytes());
  assert.equal(p.hookApprovalRequired, false);
  assert.deepEqual(p.approvedHooks, []);
  assert.equal(p.approvedListCorrupt, false);
});

test("the list is read as the program writes it, and a list that does not fit is marked, never read as empty", () => {
  const list = [key(), key(), key()];
  const p = decodePlatform(platformBytes({ rule: true, list }));
  assert.deepEqual(p.approvedHooks.map(String), list.map(String));
  assert.equal(p.approvedListCorrupt, false);
  // a count of 0 after the fixed part
  assert.deepEqual(decodeApprovedList(platformBytes({ list: [] })), { programs: [], corrupt: false });
  // cut by one byte
  const cut = platformBytes({ list }).subarray(0, APPROVED_LIST_OFFSET + 4 + 32 * 3 - 1);
  assert.equal(decodeApprovedList(cut).corrupt, true);
  // a count above the cap
  const big = platformBytes({ list: [] }); big.writeUInt32LE(MAX_APPROVED_HOOKS + 1, APPROVED_LIST_OFFSET);
  assert.equal(decodeApprovedList(big).corrupt, true);
  // two bytes of a count
  assert.equal(decodeApprovedList(Buffer.concat([platformBytes(), Buffer.alloc(2)])).corrupt, true);
});

test("approve_hook and revoke_hook: the program's accounts in its order, the admin paying and paid", () => {
  const admin = key(), program = key();
  const a = ix.approveHook(admin, program);
  assert.ok(a.programId.equals(PROGRAMS.hookpool));
  assert.deepEqual(Array.from(a.data), IX.hookpool.approve_hook);
  assert.deepEqual(a.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [admin.toBase58(), true, true], [pda.platform().toBase58(), false, true], [program.toBase58(), false, false],
    [pda.programData(program).toBase58(), false, false], [SYSTEM_PROGRAM.toBase58(), false, false],
  ]);
  const r = ix.revokeHook(admin, program);
  assert.deepEqual(Array.from(r.data.subarray(0, 8)), IX.hookpool.revoke_hook);
  assert.ok(new PublicKey(r.data.subarray(8, 40)).equals(program));
  assert.equal(r.data.length, 40);
  assert.deepEqual(r.keys.map((k) => [k.isSigner, k.isWritable]), [[true, true], [false, true]]);
});

test("update_platform carries the rule as an eleventh option, and leaves it out unless asked", () => {
  const admin = key();
  const off = ix.updatePlatform(admin, {});
  assert.equal(off.data.length, 8 + 11, "eleven None tags");
  const on = ix.updatePlatform(admin, { hookApprovalRequired: true });
  assert.deepEqual(Array.from(on.data.subarray(8)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  const offAgain = ix.updatePlatform(admin, { hookApprovalRequired: false });
  assert.deepEqual(Array.from(offAgain.data.subarray(18)), [1, 0]);
});

test("the two events decode", () => {
  const program = key();
  const a = Buffer.concat([Buffer.from(EVENT_DISC.HookApprovalChanged), Buffer.from(program.toBytes()), Buffer.from([1]), Buffer.from([3, 0, 0, 0])]);
  assert.deepEqual({ ...decodeEvent(a), program: undefined }, { kind: "HookApprovalChanged", program: undefined, approved: true, count: 3 });
  assert.ok(decodeEvent(a).program.equals(program));
  const b = Buffer.concat([Buffer.from(EVENT_DISC.HookApprovalRequiredChanged), Buffer.from([0])]);
  assert.deepEqual(decodeEvent(b), { kind: "HookApprovalRequiredChanged", required: false });
});

test("where a hook stands: own hooks always, listed hooks while the list reads, everything while the rule is off", () => {
  const outside = key(), listed = key();
  const on = { hookApprovalRequired: true, approvedHooks: [listed], approvedListCorrupt: false };
  assert.equal(hookApprovalOf(on, outside, false).allowed, false);
  assert.equal(hookApprovalOf(on, listed, false).allowed, true);
  assert.equal(hookApprovalOf(on, PROGRAMS.hook_tax, false).allowed, true, "a template");
  assert.equal(hookApprovalOf(on, SYSTEM_PROGRAM, false).allowed, true, "no hook");
  assert.equal(hookApprovalOf(on, outside, true).allowed, true, "whitelisted authority");
  assert.equal(hookApprovalOf({ ...on, hookApprovalRequired: false }, outside, false).allowed, true);
  assert.equal(hookApprovalOf({ ...on, approvedListCorrupt: true }, listed, false).allowed, false, "the program refuses on a corrupt list");
});

test("a launch with an unlisted custom hook is refused before anything is built; listed, it builds", async () => {
  const outside = key();
  const accounts = new Map([[pda.platform().toBase58(), platformAcct({ rule: true, list: [] })], [pda.programData(outside).toBase58(), programDataAcct(null)]]);
  const client = new HookpoolClient(standIn(accounts));
  const opts = {
    dev: key(), mint: Keypair.generate(), name: "X", symbol: "X", uri: "https://example.invalid/x.json", decimals: 6, totalSupply: 1_000_000_000_000_000n,
    quoteMint: NATIVE_MINT, lpFeeBps: 30, quoteAmount: 0n, devBuyQuote: 0n, minDevBuyOut: 0n, curve: true, template: "custom", custom: { program: outside },
  };
  await assert.rejects(client.launchInstructions(opts), (e) => e instanceof HookApprovalRefusal && e.code === "HookNotApproved" && e.number === 6052 && e.program.equals(outside));
  // the same hook, listed
  accounts.set(pda.platform().toBase58(), platformAcct({ rule: true, list: [outside] }));
  await assert.doesNotReject(client.hookApproval(outside).then((a) => assert.equal(a.allowed, true)));
});

test("a direct pool: no read at all for no hook or a template, one platform read for an outside hook", async () => {
  const outside = key();
  const accounts = new Map([[pda.platform().toBase58(), platformAcct({ rule: true, list: [] })], [pda.programData(outside).toBase58(), programDataAcct(null)]]);
  const conn = standIn(accounts);
  const client = new HookpoolClient(conn);
  const mint = key();
  await client.createPoolInstructions(key(), mint, NATIVE_MINT, 30, 1n, 1n, NO_HOOK);
  await client.createPoolInstructions(key(), mint, NATIVE_MINT, 30, 1n, 1n, { program: PROGRAMS.hook_tax, treasury: SYSTEM_PROGRAM, extra: [] });
  assert.deepEqual(conn.calls, [], "no read for no hook or a template");
  await assert.rejects(client.createPoolInstructions(key(), mint, NATIVE_MINT, 30, 1n, 1n, { program: outside, treasury: SYSTEM_PROGRAM, extra: [] }), HookApprovalRefusal);
  // whitelisted authority: one more read, then it is the platform's own
  const ours = key();
  const v3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const wl = new Map([[pda.platform().toBase58(), platformAcct({ rule: true, list: [], whitelist: [ours] })], [pda.programData(outside).toBase58(), programDataAcct(ours)],
    [outside.toBase58(), { data: Buffer.alloc(36), owner: v3, lamports: 1, executable: true }]]);
  const c2 = new HookpoolClient(standIn(wl));
  const a = await c2.hookApproval(outside);
  assert.deepEqual([a.own, a.allowed, a.approved], [true, true, false]);
  // loader v4: deployed (status 1) by a whitelisted authority is the platform own; finalized (2) is an outside hook
  const v4prog = key();
  const v4 = (status) => { const d = Buffer.alloc(60); Buffer.from(ours.toBytes()).copy(d, 8); d.writeBigUInt64LE(BigInt(status), 40); return { data: d, owner: new PublicKey("LoaderV411111111111111111111111111111111111"), lamports: 1, executable: true }; };
  const m4 = new Map([[pda.platform().toBase58(), platformAcct({ rule: true, list: [], whitelist: [ours] })], [v4prog.toBase58(), v4(1)]]);
  assert.equal((await new HookpoolClient(standIn(m4)).hookApproval(v4prog)).allowed, true, "a v4 program its whitelisted authority can still change");
  m4.set(v4prog.toBase58(), v4(2));
  assert.equal((await new HookpoolClient(standIn(m4)).hookApproval(v4prog)).allowed, false, "a finalized v4 program is an outside hook");
  // and the curve pool path refuses too
  const c3 = new HookpoolClient(standIn(new Map([[pda.platform().toBase58(), platformAcct({ rule: true, list: [] })], [mint.toBase58(), { data: Buffer.alloc(82), owner: TOKEN_PROGRAM, lamports: 1, executable: false }]])));
  await assert.rejects(c3.createCurvePoolInstructions(key(), mint, NATIVE_MINT, 30, 1n, { program: outside, treasury: SYSTEM_PROGRAM, extra: [] }), HookApprovalRefusal);
});

test("the program's sentence in a failed transaction's logs is recognised, by name or by number", () => {
  assert.equal(approvalErrorFromLogs(["Program log: AnchorError occurred. Error Code: HookNotApproved. Error Number: 6052. Error Message: x."]).name, "HookNotApproved");
  assert.equal(approvalErrorFromLogs(["Program x failed: custom program error: 0x17a4"]).number, 6052);
  assert.equal(approvalErrorFromLogs(["Error Code: CurveOpen. Error Number: 6045"]), null);
  assert.equal(APPROVAL_ERRORS[6056].name, "ApprovedListCorrupt");
});
