// The pool check on an RPC that refuses getTokenLargestAccounts (Chainstack's shared nodes answer 403, "only
// available on dedicated nodes"): the buy is still simulated, the sell probe finds its holder among the wallets of
// the pool's trades file, and nothing a reader sees carries a raw RPC answer. Errors in words (lib/plain.mjs). A
// connection and a client made of plain objects; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PROGRAMS, IX, DIRECTION, FLAGS, decodePool, pda } from "../../sdk/dist/index.js";
import { simulateProbes, findHolders, classifySimError, LARGEST_REFUSED_MS } from "../lib/simulate.mjs";
import { tradesFile, tradersOf } from "../lib/feed.mjs";
import { poolEntry } from "../lib/status.mjs";
import { scorePool } from "../lib/score.mjs";
import { plainText, plainError, chainErrWords, isRefusal, hostOf } from "../lib/plain.mjs";
import { poolBytes, tokenAccountBytes, extraMetasBytes, POOL, BASE_MINT, TOKEN_PROGRAM, OTHER } from "./bytes.mjs";

const key = () => Keypair.generate().publicKey;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "holders-test-"));
/// What Chainstack's shared node answers to getTokenLargestAccounts, as web3.js throws it.
const CHAINSTACK_403 = '403 Forbidden: {"jsonrpc":"2.0","error":{"code":-32604,"message":"Method getTokenLargestAccounts is only available on dedicated nodes"},"id":"5c2f"}';
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

/// An RPC in memory: token accounts by address, a simulation that answers `amountOut` as the pool's return data,
/// getTokenLargestAccounts as `largest` says ("403": Chainstack's refusal, "down": a network failure, or a list).
function fakeConnection({ accounts = new Map(), largest = "403", amountOut = 777n } = {}) {
  const calls = { largest: 0, multiple: 0, simulations: [] };
  return {
    calls,
    async getTokenLargestAccounts() {
      calls.largest += 1;
      if (largest === "403") throw new Error(CHAINSTACK_403);
      if (largest === "down") throw new Error("fetch failed");
      return { context: { slot: 1 }, value: largest };
    },
    async getMultipleAccountsInfo(keys) { calls.multiple += 1; return keys.map((k) => accounts.get(k.toBase58()) ?? null); },
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 100 }; },
    async simulateTransaction(tx) {
      const swap = tx.instructions.find((i) => i.programId.equals(PROGRAMS.hookpool));
      calls.simulations.push({ payer: tx.feePayer.toBase58(), direction: swap.data[8] });
      const b = Buffer.alloc(8); b.writeBigUInt64LE(amountOut);
      return { context: { slot: 500 }, value: { err: null, logs: [], returnData: { programId: PROGRAMS.hookpool.toBase58(), data: [b.toString("base64"), "base64"] } } };
    },
  };
}
/// The SDK's client as far as a simulation uses it: the swap instruction, its direction in the data.
const fakeClient = {
  async swapInstructions(user, pool, hookRef, direction) {
    return [new TransactionInstruction({ programId: PROGRAMS.hookpool, keys: [{ pubkey: user, isSigner: true, isWritable: true }, { pubkey: pool.address, isSigner: false, isWritable: true }], data: Buffer.from([...IX.hookpool.swap, direction]) })];
  },
};
const tokenAccount = (owner, amount) => ({ owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false, data: Buffer.from(tokenAccountBytes({ mint: BASE_MINT, owner, amount })) });
const ataOf = (owner) => pda.ata(owner, BASE_MINT, TOKEN_PROGRAM);
function tradesDirWith(pool, users) {
  const dir = tmpDir();
  const events = users.map((u, i) => ({ kind: "Swapped", signature: `s${i}`, blockTime: 1, pool: pool.toBase58(), user: u.toBase58(), direction: 0, amountIn: "1", amountOut: "1", protocolFee: "0", hookFee: "0", lpFee: "0", feeBpsApplied: 100, reserveBase: "1", reserveQuote: "1", slot: String(100 - i), byHook: false }));
  fs.writeFileSync(path.join(dir, `${pool.toBase58()}.json`), JSON.stringify(tradesFile({ pool: pool.toBase58(), updatedAt: "t", slot: 100, backfill: { transactions: users.length, reachedCreation: true }, curve: null, events })));
  return dir;
}
const freshMemo = () => ({ refusedUntil: 0, reason: null });
const TAX_FLAGS = FLAGS.BEFORE_SWAP | FLAGS.CALL_ON_BUY | FLAGS.CALL_ON_SELL | FLAGS.TAKE_HOOK_FEE;
const taxPool = () => decodePool(POOL, poolBytes({ hookProgram: PROGRAMS.hook_tax, hookFlags: TAX_FLAGS, hookKind: 2 }));
const taxHook = () => ({ template: "tax", flags: TAX_FLAGS, extraMetasBytes: extraMetasBytes([]), tax: { buyBps: 300, sellBps: 500, maxBps: 1000 } });

test("Chainstack refuses getTokenLargestAccounts: the buy is simulated, the sell finds its holder among the pool's traders", async () => {
  const pool = taxPool();
  const probe = key();
  const [empty, holder, other] = [key(), key(), key()];
  const accounts = new Map([[ataOf(empty).toBase58(), tokenAccount(empty, 0n)], [ataOf(holder).toBase58(), tokenAccount(holder, 5_000_000_000n)], [ataOf(other).toBase58(), tokenAccount(other, 40_000n)]]);
  const connection = fakeConnection({ accounts });
  const dir = tradesDirWith(POOL, [empty, other, holder, empty]);
  const memo = freshMemo();
  let told = null;
  const run = () => simulateProbes({ connection, client: fakeClient, pool, hook: taxHook(), probe, probeLamports: 50_000_000n, funding: { ok: true }, slot: 400, platform: { protocolFeeBps: 20, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000 }, traders: () => tradersOf(dir, POOL), memo, onHolders: (f) => { told = f; } });
  const { buy, sell } = await run();
  assert.deepEqual([buy.ok, buy.amountOut, buy.error], [true, 777n, null], "the buy is simulated");
  assert.deepEqual([sell.ok, sell.holder, sell.amountIn, sell.holderSource], [true, holder.toBase58(), 50_000_000n, "feed"], "1% of the largest balance among the traders");
  assert.deepEqual(connection.calls.simulations.map((s) => [s.payer, s.direction]), [[probe.toBase58(), DIRECTION.BUY], [holder.toBase58(), DIRECTION.SELL]]);
  assert.equal(connection.calls.largest, 1);
  assert.equal(told.refusedNow, true);
  assert.match(told.largestError, /^the RPC refused the call \(403 Forbidden\): Method getTokenLargestAccounts is only available on dedicated nodes$/);
  assert.ok(memo.refusedUntil > Date.now() + LARGEST_REFUSED_MS - 60_000, "left alone for an hour");
  // the next check does not ask again within the hour
  const again = await run();
  assert.deepEqual([again.sell.ok, again.sell.holder, connection.calls.largest, told.refusedNow], [true, holder.toBase58(), 1, false]);
  // and the entry the site reads is clean, with no raw answer anywhere
  const scored = scorePool({ hasHook: true, flags: TAX_FLAGS, hookKind: 2, template: "tax", buySim: buy, sellSim: sell });
  assert.equal(scored.score, "clean");
});

test("no holder can be found: the buy stands, the sell is not set up, in words, and it is tried again while the feed has nothing", async () => {
  const pool = taxPool();
  const probe = key();
  const connection = fakeConnection();
  // no trades file for the pool yet (its backfill has not run)
  const none = await simulateProbes({ connection, client: fakeClient, pool, hook: taxHook(), probe, probeLamports: 50_000_000n, funding: { ok: true }, slot: 400, platform: null, traders: () => tradersOf(tmpDir(), POOL), memo: freshMemo() });
  assert.equal(none.buy.ok, true);
  assert.deepEqual([none.sell.ok, none.sell.stage, none.sell.holder, none.sell.retry], [false, "setup", null, true]);
  assert.equal(none.sell.error, "setup: no holder found to sell as: this RPC does not list a coin's largest holders, and the trades feed has no trades of this pool yet");
  // the traders hold nothing: not tried again before the next change
  const nobody = key();
  const dir = tradesDirWith(POOL, [nobody]);
  const held = await simulateProbes({ connection: fakeConnection({ accounts: new Map([[ataOf(nobody).toBase58(), tokenAccount(nobody, 0n)]]) }), client: fakeClient, pool, hook: taxHook(), probe, probeLamports: 1n, funding: { ok: true }, traders: () => tradersOf(dir, POOL), memo: freshMemo() });
  assert.deepEqual([held.buy.ok, held.sell.ok, held.sell.retry ?? false], [true, false, false]);
  assert.equal(held.sell.error, "setup: no holder found to sell as: this RPC does not list a coin's largest holders, and none of the 1 wallets that traded the pool lately holds the coin");
  // the score: a sell probe that could not be set up says nothing about the hook
  const scored = scorePool({ hasHook: true, flags: TAX_FLAGS, hookKind: 2, template: "tax", buySim: none.buy, sellSim: none.sell });
  assert.equal(scored.score, "clean");
  assert.ok(scored.notes.some((n) => n.startsWith("Sell probe could not be set up (not the hook's doing): setup: no holder found to sell as")));
  // a network failure is no refusal: asked again at the next check
  const memo = freshMemo();
  const down = fakeConnection({ largest: "down" });
  const r = await findHolders(down, pool, { traders: () => ({ found: false, traders: [] }), memo });
  assert.deepEqual([r.holders.length, r.retry, r.largestError, memo.refusedUntil], [0, true, "the RPC could not be reached", 0]);
  assert.match(r.reason, /the RPC did not list the coin's largest holders this time/);
  await findHolders(down, pool, { memo });
  assert.equal(down.calls.largest, 2);
  // a read that throws while the sell probe is set up: the sell is a setup failure of this pass, the buy stands
  const broken = { ...fakeConnection(), async getMultipleAccountsInfo() { throw new Error('500 Internal Server Error: {"jsonrpc":"2.0","error":{"code":-32603,"message":"internal"}}'); } };
  const rb = await simulateProbes({ connection: broken, client: fakeClient, pool, hook: taxHook(), probe, probeLamports: 1n, funding: { ok: true }, traders: () => tradersOf(dir, POOL), memo: freshMemo() });
  assert.deepEqual([rb.buy.ok, rb.sell.ok, rb.sell.stage, rb.sell.retry], [true, false, "setup", true]);
  assert.equal(rb.sell.error, "setup: no holder found to sell as: this RPC does not list a coin's largest holders, and the token accounts of the pool's recent traders could not be read this time");
  const hookThrows = { ...fakeConnection({ accounts: new Map([[ataOf(nobody).toBase58(), tokenAccount(nobody, 9n)]]) }) };
  const throwingHook = { ...taxHook(), extraMetasBytes: null };
  const rh = await simulateProbes({ connection: hookThrows, client: fakeClient, pool, hook: throwingHook, probe, probeLamports: 1n, funding: { ok: false, message: "probe wallet not funded (0 SOL)" }, traders: () => tradersOf(dir, POOL), memo: freshMemo() });
  assert.deepEqual([rh.buy.ok, rh.buy.error, rh.sell.ok, rh.sell.retry], [false, "setup: probe wallet not funded (0 SOL)", false, true]);
  assert.equal(rh.sell.error, "setup: the sell probe could not be set up this time: hook extra-metas account missing");
});

test("an RPC that lists the largest holders (the local validator, a dedicated node): used first, as before", async () => {
  const pool = decodePool(POOL, poolBytes({}));
  const [a, b] = [key(), key()];
  const accounts = new Map([[ataOf(a).toBase58(), tokenAccount(a, 900n)], [ataOf(b).toBase58(), tokenAccount(b, 7_000n)], [OTHER.toBase58(), tokenAccount(POOL, 1_000_000n)]]);
  const largest = [{ address: OTHER, amount: "1000000" }, { address: ataOf(b), amount: "7000" }, { address: ataOf(a), amount: "900" }];
  const connection = fakeConnection({ accounts, largest });
  const traders = () => { throw new Error("not read when the RPC lists the holders"); };
  const got = await findHolders(connection, pool, { traders, memo: freshMemo() });
  assert.deepEqual([got.source, got.holders.map((h) => [h.owner.toBase58(), h.amount])], ["largest", [[b.toBase58(), 7_000n], [a.toBase58(), 900n]]], "the pool vault left out");
  // a pool without a hook goes through the same probes
  const { buy, sell } = await simulateProbes({ connection, client: fakeClient, pool, hook: null, probe: key(), probeLamports: 5n, funding: { ok: true }, traders, memo: freshMemo() });
  assert.deepEqual([buy.ok, sell.ok, sell.holder, sell.amountIn], [true, true, b.toBase58(), 70n]);
  // the largest accounts hold nothing a wallet owns, and the feed has no trades: the old words
  const empty = await findHolders(fakeConnection({ largest: [] }), pool, { memo: freshMemo() });
  assert.deepEqual([empty.reason, empty.retry], ["setup: no holder with an associated token account found", false]);
});

test("errors in words: no JSON, no RPC address with its key, the chain's errors by name", () => {
  assert.equal(plainError(new Error(CHAINSTACK_403)), "the RPC refused the call (403 Forbidden): Method getTokenLargestAccounts is only available on dedicated nodes");
  assert.equal(plainError(new Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429,"message":"rate limit"}}')), "the RPC refused the call for now: too many requests (429): rate limit");
  assert.equal(plainError(new Error("fetch failed")), "the RPC could not be reached");
  assert.equal(plainError(new Error("The operation was aborted due to timeout")), "the RPC did not answer in time");
  assert.equal(plainError(new Error("failed to get token largest accounts: Method not found")), "failed to get token largest accounts: Method not found");
  const key = "abc123secretkey";
  const withUrl = plainText(`request to https://solana-mainnet.core.chainstack.com/${key}/?api=1 failed`);
  assert.equal(withUrl, "request to solana-mainnet.core.chainstack.com failed");
  assert.equal(hostOf(`https://nd-1.example.com:8899/${key}`), "nd-1.example.com:8899");
  const sim = plainError(new Error('Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1771. \nLogs: \n[\n  "Program X invoke [1]",\n  "Program log: AnchorError occurred."\n]. \nCatch the `SendTransactionError` and call `getLogs()` on it for full details.'));
  assert.ok(!/[[\]{}"]/.test(sim), sim);
  assert.match(sim, /custom program error: 0x1771/);
  assert.equal(chainErrWords({ InstructionError: [2, { Custom: 6008 }] }), "instruction 2: custom error 6008");
  assert.equal(chainErrWords({ InsufficientFundsForRent: { account_index: 0 } }), "InsufficientFundsForRent (account_index 0)");
  assert.equal(classifySimError({ InsufficientFundsForRent: { account_index: 2 } }, [], 1).message, "setup: InsufficientFundsForRent (account_index 2)");
  assert.equal(classifySimError({ InstructionError: [1, { BorshIoError: "Unknown" }] }, [], 1).message, "swap: BorshIoError Unknown");
  assert.equal(classifySimError("AccountNotFound", [], 4).message, "setup: AccountNotFound");
  // a sentence stays exactly as it is
  for (const s of ["The buy probe was [1, 2] lamports.", "swap: custom error 6012 (Sell cap reached)", "Simulated at 2026-10-21T00:00:00.000Z. Nothing changed."]) assert.equal(plainText(s), s);
  // a refusal for good, and what is not one
  assert.equal(isRefusal(new Error(CHAINSTACK_403)), true);
  assert.equal(isRefusal(Object.assign(new Error("failed to get token largest accounts: Method not found"), { code: -32601 })), true);
  assert.equal(isRefusal(new Error("429 Too Many Requests: {}")), false);
  assert.equal(isRefusal(new Error("fetch failed")), false);
});

test("pools.json carries words only: simulation errors, alerts and notes pass plainText", () => {
  const raw = `watcher: ${CHAINSTACK_403}`;
  const e = poolEntry({
    lastCheck: "t", score: "warning", hookKind: "platform", template: "tax",
    buySim: { ok: false, error: raw, amountOut: null }, sellSim: { ok: false, error: raw, amountOut: null, holder: null },
    alerts: [{ time: "t", level: "warning", message: "sells started failing: setup: request to https://rpc.example.com/KEY123/ failed" }],
    notes: [`The watcher could not check this pool: ${CHAINSTACK_403}`, "A plain sentence stays."],
  });
  const text = JSON.stringify([e.buySim.error, e.sellSim.error, e.alerts, e.notes]);
  assert.ok(!text.includes("jsonrpc") && !text.includes("KEY123") && !text.includes("\\\"code\\\""), text);
  assert.equal(e.buySim.error, "watcher: 403 Forbidden: Method getTokenLargestAccounts is only available on dedicated nodes");
  assert.equal(e.alerts[0].message, "sells started failing: setup: request to rpc.example.com failed");
  assert.equal(e.notes[1], "A plain sentence stays.");
});
