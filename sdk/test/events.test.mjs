// Log attribution: a "Program data:" line is an event only when one of our programs logged it. The runtime's
// "Program <id> invoke [n]" and "Program <id> success" lines say which program runs at each point; a stranger's
// program in the same transaction cannot plant a Swapped (or any other) event, whatever bytes it logs.
// Runs on the built bundle:
//   npm run build -w sdk && npm test -w sdk
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { EVENT_DISC, EVENT_LOG_PROGRAMS, PROGRAMS, DIRECTION, attributedDataLogs, eventsFromLogs, eventsFromTransaction } from "../dist/index.js";

// ---- event bytes, in the layouts the decoder reads ------------------------------------------------------
class W {
  constructor(n) { this.b = new Uint8Array(n); this.o = 0; this.v = new DataView(this.b.buffer); }
  bytes(a) { this.b.set(a, this.o); this.o += a.length; return this; }
  key(k) { return this.bytes(k.toBytes()); }
  u8(x) { this.b[this.o++] = x; return this; }
  u16(x) { this.v.setUint16(this.o, x, true); this.o += 2; return this; }
  u64(x) { this.v.setBigUint64(this.o, BigInt(x), true); this.o += 8; return this; }
}
const key = () => Keypair.generate().publicKey;
const data = (u8) => "Program data: " + Buffer.from(u8).toString("base64");
/// Swapped: pool, user, direction, amountIn, amountOut, protocolFee, hookFee, lpFee, feeBpsApplied, reserveBase, reserveQuote, slot, byHook.
function swappedBytes({ pool, user = key(), amountIn = 1000n, slot = 77n } = {}) {
  const w = new W(8 + 32 + 32 + 1 + 8 * 5 + 2 + 8 * 3 + 1).bytes(EVENT_DISC.Swapped).key(pool).key(user).u8(DIRECTION.BUY);
  for (const x of [amountIn, 900n, 1n, 0n, 1n]) w.u64(x);
  w.u16(100).u64(10n).u64(20n).u64(slot).u8(0);
  return w.b;
}
/// Staked (a hook_rules log event): pool, staker, amount, staked, totalStaked, slot.
function stakedBytes({ pool, staker = key(), amount = 5n, slot = 78n } = {}) {
  const w = new W(8 + 32 + 32 + 8 * 4).bytes(EVENT_DISC.Staked).key(pool).key(staker);
  for (const x of [amount, amount, amount, slot]) w.u64(x);
  return w.b;
}

const POOL = PROGRAMS.hookpool.toBase58();
const RULES = PROGRAMS.hook_rules.toBase58();
const invoke = (id, depth) => `Program ${id} invoke [${depth}]`;
const success = (id) => `Program ${id} success`;
const failed = (id) => `Program ${id} failed: custom program error: 0x1`;
const consumed = (id) => `Program ${id} consumed 12345 of 200000 compute units`;
const txOf = (logs) => ({ blockTime: 1_700_000_000, meta: { err: null, logMessages: logs, innerInstructions: [] }, transaction: { message: { staticAccountKeys: [] } } });

test("the default accepted set is every program of the SDK", () => {
  assert.deepEqual([...EVENT_LOG_PROGRAMS].sort(), Object.values(PROGRAMS).map((p) => p.toBase58()).sort());
  assert.ok(EVENT_LOG_PROGRAMS.includes(POOL) && EVENT_LOG_PROGRAMS.includes(RULES));
});

test("a forged Swapped under a stranger's invoke is dropped, the pool program's own is kept, at the top level and nested", () => {
  const pool = key(); const victim = key();
  const stranger = key().toBase58();
  const real = swappedBytes({ pool, amountIn: 1000n });
  const forged = swappedBytes({ pool: victim, amountIn: 999_999_999_999n });
  const logs = [
    invoke(stranger, 1), "Program log: Instruction: Fake", data(forged), consumed(stranger), success(stranger),
    invoke(POOL, 1), "Program log: Instruction: Swap", data(real), consumed(POOL), success(POOL),
    invoke(POOL, 1), invoke(stranger, 2), data(forged), consumed(stranger), success(stranger), consumed(POOL), success(POOL),
  ];
  assert.deepEqual(attributedDataLogs(logs).map((x) => x.program), [stranger, POOL, stranger]);
  const evs = eventsFromLogs(logs);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "Swapped"); assert.ok(evs[0].pool.equals(pool)); assert.equal(evs[0].amountIn, 1000n);
  // a stranger that failed closes its frame too; the pool program's line that follows is the pool's
  const failedFirst = [invoke(POOL, 1), invoke(stranger, 2), data(forged), failed(stranger), data(real), success(POOL)];
  assert.deepEqual(attributedDataLogs(failedFirst).map((x) => x.program), [stranger, POOL]);
  assert.equal(eventsFromLogs(failedFirst).length, 1);
  // the stranger's whole transaction: nothing
  assert.equal(eventsFromLogs([invoke(stranger, 1), data(forged), data(real), success(stranger)]).length, 0);
  // the accepted set is a parameter (base58 strings or PublicKeys); the caller's own set decides
  assert.equal(eventsFromLogs(logs, [stranger]).length, 2, "a set that names the stranger takes its lines");
  assert.equal(eventsFromLogs(logs, [PROGRAMS.hookpool]).length, 1);
  assert.equal(eventsFromLogs(logs, []).length, 0);
});

test("nested CPI: a hook's event under the pool's invoke is the hook's, the pool's line after the hook returned is the pool's", () => {
  const pool = key();
  const stranger = key().toBase58();
  const staked = stakedBytes({ pool });
  const swapped = swappedBytes({ pool });
  const logs = [
    invoke(POOL, 1), "Program log: Instruction: Swap",
    invoke(RULES, 2), "Program log: Instruction: AfterSwap", data(staked), consumed(RULES), success(RULES),
    data(swapped), consumed(POOL), success(POOL),
  ];
  assert.deepEqual(attributedDataLogs(logs).map((x) => x.program), [RULES, POOL]);
  const both = eventsFromLogs(logs);
  assert.deepEqual(both.map((e) => e.kind), ["Staked", "Swapped"], "both ours, in log order");
  assert.deepEqual(eventsFromLogs(logs, [PROGRAMS.hookpool]).map((e) => e.kind), ["Swapped"]);
  assert.deepEqual(eventsFromLogs(logs, [RULES]).map((e) => e.kind), ["Staked"]);
  // a stranger three deep (under the hook under the pool) owns its own line only; the innermost program wins
  const deep = [
    invoke(POOL, 1), invoke(RULES, 2), invoke(stranger, 3), data(stakedBytes({ pool, amount: 999n })), success(stranger),
    data(staked), success(RULES), data(swapped), success(POOL),
  ];
  assert.deepEqual(attributedDataLogs(deep).map((x) => x.program), [stranger, RULES, POOL]);
  const got = eventsFromLogs(deep);
  assert.deepEqual(got.map((e) => e.kind), ["Staked", "Swapped"]);
  assert.equal(got[0].amount, 5n, "the hook's own Staked, not the stranger's");
});

test("bare lines (no invoke line), a truncated log and lines that do not decode: taken in stride, nothing throws", () => {
  const pool = key();
  const real = swappedBytes({ pool });
  // logs with no invoke line at all: every data line is taken (a synthetic transaction in a test)
  assert.equal(eventsFromLogs([data(real)]).length, 1);
  assert.equal(eventsFromLogs(["Program log: x", data(real), "Program data: AAAA", "Program data: !!notbase64", "Program data: "]).length, 1);
  // a cut log: "Log truncated" ends it, the success lines never came, a data line cut in the middle decodes to nothing
  const cut = data(real).slice(0, 40);
  assert.equal(eventsFromLogs([invoke(POOL, 1), data(real), cut, "Log truncated"]).length, 1);
  assert.equal(eventsFromLogs([invoke(POOL, 1), invoke(RULES, 2), data(stakedBytes({ pool })), "Log truncated"]).length, 1);
  assert.equal(eventsFromLogs([invoke(POOL, 1), cut, "Log truncated"]).length, 0);
  // no logs, odd entries
  assert.deepEqual(eventsFromLogs(null), []); assert.deepEqual(eventsFromLogs(undefined), []); assert.deepEqual(eventsFromLogs([]), []);
  assert.equal(eventsFromLogs([123, null, undefined, data(real)]).length, 1);
  // logs that have invoke lines: a data line outside every invoke belongs to no program (the runtime never writes one there)
  const outside = [invoke(POOL, 1), success(POOL), data(real)];
  assert.deepEqual(attributedDataLogs(outside).map((x) => x.program), [""]);
  assert.equal(eventsFromLogs(outside).length, 0);
  // a "Program log:" line that imitates an invoke line does not open a frame
  const imitation = [invoke(key().toBase58(), 1), `Program log: ${invoke(POOL, 2)}`, data(real), `Program log: ${success(POOL)}`, success(POOL)];
  assert.equal(eventsFromLogs(imitation).length, 0);
});

test("eventsFromTransaction hands its program set to the log decoder", () => {
  const pool = key();
  const stranger = key().toBase58();
  const logs = [invoke(stranger, 1), data(swappedBytes({ pool: key(), amountIn: 5n })), success(stranger), invoke(POOL, 1), data(swappedBytes({ pool })), success(POOL)];
  const ours = eventsFromTransaction(txOf(logs), [POOL]);
  assert.equal(ours.length, 1); assert.ok(ours[0].pool.equals(pool));
  assert.equal(eventsFromTransaction(txOf(logs), [stranger]).length, 1);
  assert.equal(eventsFromTransaction(txOf(logs), [POOL, stranger]).length, 2);
  assert.deepEqual(eventsFromTransaction({ meta: { logMessages: null, innerInstructions: null }, transaction: { message: { staticAccountKeys: [] } } }, [POOL]), []);
});
