// The mint crank (collectible coins, one approval): what it reads from the logs, what it decides for a wallet, what
// it sends, and the whole crank against a fake chain: a buy found from its signature, a wallet that waits for its
// block, one that minted first, a deposit too small, a refused simulation, a keeper that would pay. Then its
// settings, its numbers in /health, in the state and in the status file. None of it touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { PROGRAMS, collectible, EVENT_DISC } from "../../sdk/dist/index.js";
import {
  earnedFromLogs, depositUsedFromLogs, mintDecision, mintErrorName, mintRefusal, mintFeeLamports, mintInstructions, mintEffect, addMintTotals, mintLine, mintKey,
  undecidedUntil, MintCrank, NO_MINT_TOTALS, MAX_MINT_PRICE_MICROLAMPORTS, MINT_COMPUTE_UNITS, MINT_SETTLE_MS, MINT_SIGNATURES_PER_PASS, MINT_STRIKES,
} from "../lib/mint.mjs";
import { healthBody } from "../lib/server.mjs";
import { parseArgs, buildConfig, describeConfig } from "../lib/config.mjs";
import { loadState, saveState, emptyState } from "../lib/state.mjs";
import { buildStatus } from "../lib/status.mjs";
import { ticketBytes, collectionConfig, tokenAccountBytes, POOL, OWNER, BASE_MINT, TOKEN_PROGRAM, BATCH_WAITING, BATCH_REVEALED } from "./bytes.mjs";

const { KEEPER_FEE, STANDARD_RENT, CORE_CREATE_FEE } = collectible;
const key = () => Keypair.generate().publicKey;
const ascii = (s) => /^[\x20-\x7e]*$/.test(s);
const HOOK = PROGRAMS.hook_collectible;

/// Little-endian bytes of the event fields, after the discriminator, then the "Program data:" log line.
function eventLog(name, parts) {
  const chunks = [Uint8Array.from(EVENT_DISC[name])];
  for (const [kind, v] of parts) {
    if (kind === "key") chunks.push(v.toBytes());
    else if (kind === "u32") { const b = Buffer.alloc(4); b.writeUInt32LE(v); chunks.push(b); }
    else { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); chunks.push(b); }
  }
  return "Program data: " + Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("base64");
}
const earnedLog = ({ pool = POOL, user = OWNER, pieces = 2, slot = 100n, targetSlot = 102n } = {}) => eventLog("PiecesEarned", [["key", pool], ["key", user], ["u32", pieces], ["u64", slot], ["u64", targetSlot]]);
const usedLog = ({ pool = POOL, user = OWNER, by = OWNER, pieces = 2, paid = 4_000_000n, left = 40_000n } = {}) => eventLog("DepositUsed", [["key", pool], ["key", user], ["key", by], ["u32", pieces], ["u64", paid], ["u64", left]]);

const cfgOf = (o = {}) => collectible.decodeCollectionConfig(collectionConfig(o));
/// A ticket account as the chain holds it: the bytes and the lamports, its rent plus `deposit`.
function ticketAccount(o = {}, deposit = 0n) {
  const data = Buffer.from(ticketBytes(o));
  return { owner: HOOK, data, lamports: Number(STANDARD_RENT(data.length) + deposit) };
}
const waiting = (pieces, targetSlot, firstRoll = 0) => ({ state: BATCH_WAITING, pieces, firstRoll, targetSlot });
const revealed = (pieces, firstRoll = 0) => ({ state: BATCH_REVEALED, pieces, firstRoll, targetSlot: 50n, seed: new Uint8Array(32).fill(7) });
/// What N pieces cost a deposit on a fresh ticket of this collection, exactly.
const costOf = (cfg, n, dataLength = 346, owned = 0) => collectible.mintForCost(STANDARD_RENT, cfg, dataLength, owned, n);

test("the events: PiecesEarned and DepositUsed read from the logs, anything else skipped", () => {
  const user = key(); const pool = key();
  const logs = ["Program log: Instruction: Swap", earnedLog({ pool, user, pieces: 3, slot: 77n, targetSlot: 79n }), "Program data: AAAA", usedLog({ pool, user, pieces: 3, paid: 12_000_000n, left: 40_880n }), "Program data: !!notbase64"];
  const e = earnedFromLogs(logs);
  assert.equal(e.length, 1);
  assert.ok(e[0].pool.equals(pool) && e[0].user.equals(user));
  assert.deepEqual([e[0].pieces, e[0].slot, e[0].targetSlot], [3, 77n, 79n]);
  const u = depositUsedFromLogs(logs);
  assert.equal(u.length, 1);
  assert.deepEqual([u[0].pieces, u[0].paid, u[0].left], [3, 12_000_000n, 40_880n]);
  assert.deepEqual(earnedFromLogs(null), []);
  assert.deepEqual(depositUsedFromLogs([earnedLog()]), []);
});

test("a decision for one wallet: no ticket, nothing waiting, no deposit, a block not in yet, coins gone, a deposit too small, a mint", () => {
  const cfg = cfgOf({ unit: 10n, name: "Shots", uriBase: "https://example.com/art", minted: 5 });
  const backed = 1000n;
  assert.equal(mintDecision({ info: null, cfg, backing: backed, slot: 200n }).action, "gone");
  assert.equal(mintDecision({ info: ticketAccount({ minted: 2 }, 50_000n), cfg, backing: backed, slot: 200n }).action, "done");
  assert.equal(mintDecision({ info: ticketAccount({ batches: [revealed(2)] }), cfg, backing: backed, slot: 200n }).action, "noDeposit");
  const w = mintDecision({ info: ticketAccount({ batches: [waiting(2, 300n)] }, 50_000_000n), cfg, backing: backed, slot: 300n });
  assert.equal(w.action, "wait"); assert.equal(w.untilSlot, 300n, "slot 300 itself is not past the target");
  // the wallet's coins back nothing: mintForCount drops its pieces, nothing to mint, nothing waits
  assert.equal(mintDecision({ info: ticketAccount({ batches: [revealed(2)] }, 50_000_000n), cfg, backing: 0n, slot: 400n }).action, "nothing");
  // exactly the cost: a mint; one lamport less: short
  const need = costOf(cfg, 2);
  const m = mintDecision({ info: ticketAccount({ minted: 3, batches: [revealed(2)] }, need), cfg, backing: backed, slot: 400n });
  assert.equal(m.action, "mint"); assert.equal(m.n, 2); assert.equal(m.first, 3); assert.equal(m.accounts, 2); assert.equal(m.cost, need);
  const s = mintDecision({ info: ticketAccount({ minted: 3, batches: [revealed(2)] }, need - 1n), cfg, backing: backed, slot: 400n });
  assert.equal(s.action, "short"); assert.equal(s.need, need); assert.equal(s.deposit, need - 1n);
  // a block that passed is as good as a reveal: the mint reveals it
  assert.equal(mintDecision({ info: ticketAccount({ batches: [waiting(1, 300n)] }, need), cfg, backing: backed, slot: 301n }).action, "mint");
});

test("a decided batch waits a moment for the next one, so that one mint (one keeper fee) takes both", () => {
  const cfg = cfgOf({ unit: 10n });
  const info = ticketAccount({ batches: [revealed(1), waiting(2, 500n, 1)] }, 50_000_000n);
  const early = mintDecision({ info, cfg, backing: 1000n, slot: 450n, waitedMs: 1000 });
  assert.equal(early.action, "wait"); assert.equal(early.untilSlot, 500n);
  const late = mintDecision({ info, cfg, backing: 1000n, slot: 450n, waitedMs: MINT_SETTLE_MS + 1 });
  assert.equal(late.action, "mint"); assert.equal(late.n, 1, "only the decided batch");
  assert.equal(late.accounts, 3, "asset addresses for every waiting piece are harmless");
  const both = mintDecision({ info, cfg, backing: 1000n, slot: 501n });
  assert.equal(both.action, "mint"); assert.equal(both.n, 3);
  assert.equal(undecidedUntil(collectible.decodeTicket(new Uint8Array(info.data)), 450n), 500n);
  assert.equal(undecidedUntil(collectible.decodeTicket(new Uint8Array(info.data)), 501n), null);
  // more than four decided: four now, the rest at the next pass
  const big = mintDecision({ info: ticketAccount({ batches: [revealed(3), revealed(3, 3)] }, 90_000_000n), cfg, backing: 1000n, slot: 600n });
  assert.equal(big.n, 4); assert.equal(big.accounts, 4);
});

test("refusals by name: retry, drop or strike", () => {
  const logs = ["Program log: AnchorError occurred. Error Code: WrongAsset. Error Number: 6010. Error Message: asset account is not the expected address."];
  assert.equal(mintErrorName(logs, { InstructionError: [1, { Custom: 6010 }] }), "WrongAsset");
  assert.equal(mintErrorName(["x Error Code: DepositTooSmall. Error Number: 6028. y"], null), "DepositTooSmall");
  assert.equal(mintErrorName([], "insufficient funds for fee"), "InsufficientFunds");
  assert.equal(mintErrorName([], null), null);
  assert.equal(mintRefusal("WrongAsset"), "retry");
  assert.equal(mintRefusal("NothingToMint"), "retry");
  assert.equal(mintRefusal("DepositTooSmall"), "drop");
  assert.equal(mintRefusal("NoDeposit"), "drop");
  assert.equal(mintRefusal("TooFewAssets"), "strike");
  assert.equal(mintRefusal(null), "strike");
});

test("the keeper's fee never reaches what a mint pays it: one signature, a priority fee capped under KEEPER_FEE", () => {
  assert.equal(mintFeeLamports(0), 5000n);
  // review I2, round 9: the limit is 250,000 units (a four-piece mint_for into a near-full ticket measures under
  // 200,000), and the priority fee is charged on the limit, so the cap moved from 12,500 to 20,000 a unit
  assert.equal(MINT_COMPUTE_UNITS, 250_000);
  assert.equal(MAX_MINT_PRICE_MICROLAMPORTS, 20_000);
  assert.equal(mintFeeLamports(MAX_MINT_PRICE_MICROLAMPORTS), KEEPER_FEE, "the cap is exactly where the fee reaches the keeper fee");
  assert.ok(mintFeeLamports(MAX_MINT_PRICE_MICROLAMPORTS + 1) > KEEPER_FEE);
});

test("the instructions are the SDK's mint_for, with the compute limit and, when set, the priority fee", () => {
  const payer = key(); const user = key(); const coins = key();
  const item = { pool: POOL, user, first: 7, accounts: 3, coins };
  const ixs = mintInstructions(payer, item);
  assert.equal(ixs.length, 2);
  const sdk = collectible.mintFor(payer, POOL, user, 7, 3, coins);
  assert.deepEqual(Buffer.from(ixs[1].data), Buffer.from(sdk.data));
  assert.deepEqual(ixs[1].keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), sdk.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
  assert.ok(ixs[1].keys[1].pubkey.equals(user) && !ixs[1].keys[1].isSigner, "the wallet does not sign");
  assert.ok(ixs[1].keys[0].pubkey.equals(payer) && ixs[1].keys[0].isSigner);
  assert.equal(ixs[1].keys.length, 10 + 3);
  assert.equal(Buffer.from(ixs[0].data).readUInt32LE(1), MINT_COMPUTE_UNITS);
  assert.equal(mintInstructions(payer, item, 1000).length, 3);
  // four pieces fit one packet without the lookup table
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: key().toBase58(), instructions: mintInstructions(payer, { ...item, accounts: 4 }, 1000) }).compileToV0Message();
  assert.ok(new VersionedTransaction(msg).serialize().length < 1232);
});

test("what a mint did, the totals, the log line", () => {
  const user = key();
  const meta = { fee: 5000, preBalances: [2_000_000_000, 1], postBalances: [2_000_005_000, 1], computeUnitsConsumed: 85_917, logMessages: [usedLog({ user, pieces: 3, paid: 4_510_000n, left: 40_880n })] };
  const e = mintEffect(meta);
  assert.deepEqual(e, { pieces: 3, paidLamports: 4_510_000, leftLamports: 40_880, feeLamports: 5000, netLamports: 5000, computeUnits: 85_917 });
  assert.equal(mintEffect(null), null);
  const r = { pool: POOL, user, n: 3, signature: "5ig", effect: e, slotsAfterBuy: 4 };
  const t = addMintTotals(NO_MINT_TOTALS(), { results: [r, { pool: POOL, user, n: 1, signature: null, error: "x" }], mintedFirst: 1, short: 2, refused: 1 });
  assert.deepEqual(t, { sent: 1, failed: 1, pieces: 3, paidLamports: 4_510_000, feeLamports: 5000, netLamports: 5000, mintedFirst: 1, short: 2, refused: 1, lastSlotsAfterBuy: 4 });
  const line = mintLine(r);
  assert.ok(ascii(line) && /minted 3 pieces into the wallet, 4 slots after the buy/.test(line) && /\+5000 lamports after the fee/.test(line), line);
  assert.ok(/mint FAILED/.test(mintLine({ pool: POOL, user, n: 1, signature: null, error: "boom" })));
  assert.equal(mintKey(POOL, user), POOL.toBase58() + ":" + user.toBase58());
});

// ---- the crank against a fake chain ------------------------------------------------------------------

/// A chain in memory: accounts by address, the collectible program's signatures (newest first), transactions by
/// signature, the slot, the keeper's balance, and a simulation that answers what `sim` says. It counts its calls.
function fakeChain({ keeperLamports = 1_000_000_000n, sim = null } = {}) {
  const c = {
    accounts: new Map(), sigs: [], txs: new Map(), slot: 1000n, keeperLamports, sent: [], calls: {}, simulated: 0,
    sim: sim ?? ((pre) => ({ err: null, logs: [], post: pre + KEEPER_FEE - 5000n })),
  };
  const count = (name) => { c.calls[name] = (c.calls[name] ?? 0) + 1; };
  c.connection = {
    async getSignaturesForAddress(addr, opts) {
      count("signatures");
      assert.ok(addr.equals(HOOK));
      let list = c.sigs;
      if (opts.until) { const i = list.findIndex((s) => s.signature === opts.until); list = i < 0 ? list : list.slice(0, i); }
      return list.slice(0, opts.limit ?? 1000);
    },
    async getTransactions(list) { count("transactions"); return list.map((s) => c.txs.get(s) ?? null); },
    async getTransaction(s) { count("transaction"); return c.txs.get(s) ?? null; },
    async getProgramAccounts(pid) {
      count("programAccounts");
      assert.ok(pid.equals(HOOK));
      return [...c.accounts.entries()].filter(([, a]) => a.owner.equals(HOOK) && a.ticket).map(([k, a]) => ({ pubkey: new PublicKey(k), account: a }));
    },
    async getMultipleAccountsInfo(keys) { count("multiple"); return keys.map((k) => c.accounts.get(k.toBase58()) ?? null); },
    async getAccountInfo(k) { count("single"); return c.accounts.get(k.toBase58()) ?? null; },
    async getSlot() { count("slot"); return Number(c.slot); },
    async getBalance() { count("balance"); return Number(c.keeperLamports); },
    async getMinimumBalanceForRentExemption(n) { return Number(STANDARD_RENT(n)); },
    async simulateTransaction(tx) {
      count("simulate"); c.simulated += 1;
      const r = c.sim(c.keeperLamports, tx);
      return { value: { err: r.err, logs: r.logs, accounts: [{ lamports: Number(r.post) }] } };
    },
    async sendTransaction(tx) {
      count("send");
      const signature = "mint" + (c.sent.length + 1);
      c.sent.push({ signature, tx });
      if (c.onSend) c.onSend(tx);
      return signature;
    },
  };
  return c;
}

/// One collectible pool: its config and, for each wallet, its ticket and its coins.
function setPool(chain, { pool = POOL, cfg = {} } = {}) {
  const bytes = Buffer.from(collectionConfig({ pool, unit: 10n, minted: 4, ...cfg }));
  chain.accounts.set(collectible.collectiblePda.cfg(pool).toBase58(), { owner: HOOK, data: bytes, lamports: 1 });
  return collectible.decodeCollectionConfig(bytes);
}
function setWallet(chain, { pool = POOL, user, ticket = {}, deposit = 0n, coins = 1000n }) {
  const t = ticketAccount({ pool, user, ...ticket }, deposit);
  chain.accounts.set(collectible.collectiblePda.ticket(pool, user).toBase58(), { ...t, ticket: true });
  chain.accounts.set(collectible.coinsAddress(user, BASE_MINT, TOKEN_PROGRAM).toBase58(), { owner: TOKEN_PROGRAM, data: Buffer.from(tokenAccountBytes({ owner: user, amount: coins })), lamports: 2_039_280 });
}
/// A buy that earned pieces: its signature on top of the program's list and its transaction with the event.
function addBuy(chain, { pool = POOL, user, pieces = 2, slot, targetSlot, signature, err = null }) {
  chain.sigs.unshift({ signature, err });
  chain.txs.set(signature, { slot: Number(slot), transaction: { signatures: [signature] }, meta: { err, logMessages: [earnedLog({ pool, user, pieces, slot, targetSlot })] } });
}
/// A mint_for that lands: the ticket's pieces go to the list, the deposit pays, the keeper gains KEEPER_FEE less the fee.
function landMints(chain, cfg) {
  chain.onSend = (tx) => {
    const ix = tx.ixs[tx.ixs.length - 1];
    const user = ix.keys[1].pubkey; const pool = POOL;
    const tk = collectible.collectiblePda.ticket(pool, user).toBase58();
    const a = chain.accounts.get(tk);
    const t = collectible.decodeTicket(new Uint8Array(a.data));
    const n = Math.min(4, t.pending);
    const cost = collectible.mintForCost(STANDARD_RENT, cfg, a.data.length, t.owned.length, n);
    const owned = [...t.owned, ...Array.from({ length: n }, () => key())];
    const next = ticketAccount({ pool, user, minted: t.minted + n, owned }, collectible.depositOf(a.lamports, a.data.length, STANDARD_RENT) - cost);
    chain.accounts.set(tk, { ...next, ticket: true });
    const sig = "mint" + (chain.sent.length);
    chain.txs.set(sig, { slot: Number(chain.slot), transaction: { signatures: [sig] }, meta: { err: null, fee: 5000, preBalances: [Number(chain.keeperLamports)], postBalances: [Number(chain.keeperLamports + KEEPER_FEE - 5000n)], logMessages: [usedLog({ pool, user, pieces: n, paid: cost - (STANDARD_RENT(next.data.length) - STANDARD_RENT(a.data.length)), left: 1n })] } });
    chain.keeperLamports += KEEPER_FEE - 5000n;
  };
}
function crankOn(chain, o = {}) {
  const keeper = Keypair.generate();
  const lines = [];
  const log = { info: (s) => lines.push(s), warn: (s) => lines.push(s), error: (s) => lines.push(s), debug: () => {} };
  const crank = new MintCrank({
    connection: chain.connection, keeper, log, rent: STANDARD_RENT, confirm: async () => {},
    buildTx: async (payer, ixs) => ({ tx: { ixs, sign() {} }, lastValidBlockHeight: 10 }),
    ...o,
  });
  return { crank, keeper, lines };
}

test("crank: the start reads every ticket once; a wallet with pieces decided and a deposit is minted, simulated first", async () => {
  const chain = fakeChain();
  const cfg = setPool(chain);
  const user = key();
  setWallet(chain, { user, ticket: { minted: 0, batches: [revealed(2)] }, deposit: costOf(cfg, 2) + 40_000n });
  // another wallet with pieces and no deposit: it mints itself, the crank leaves it alone
  setWallet(chain, { user: key(), ticket: { batches: [revealed(1)] } });
  landMints(chain, cfg);
  chain.sigs = [{ signature: "old", err: null }];
  const { crank, lines } = crankOn(chain);
  const p = await crank.pass();
  assert.equal(p.swept, true);
  assert.equal(chain.calls.programAccounts, 1);
  assert.equal(chain.calls.transactions ?? 0, 0, "the first look at the signatures only sets the cursor");
  assert.equal(crank.cursor, "old");
  assert.equal(p.sent, 1); assert.equal(p.pieces, 2); assert.equal(p.failed, 0);
  assert.equal(chain.simulated, 1, "simulated before it was sent");
  const t = collectible.decodeTicket(new Uint8Array(chain.accounts.get(collectible.collectiblePda.ticket(POOL, user).toBase58()).data));
  assert.equal(t.pending, 0); assert.equal(t.owned.length, 2);
  assert.ok(p.results[0].effect.netLamports > 0, "the keeper ends richer than it started");
  assert.ok(lines.some((l) => /minted 2 pieces into the wallet/.test(l)), lines.join("\n"));
  // the next pass reads the ticket once more: nothing waits, the wallet leaves the list, no count of "minted first"
  const again = await crank.pass();
  assert.equal(again.watching, 0); assert.equal(again.mintedFirst, 0); assert.equal(chain.sent.length, 1);
  // then nothing waits and nothing is new: one call a pass
  const before = { ...chain.calls };
  const q = await crank.pass();
  assert.equal(q.sent, 0);
  const made = Object.fromEntries(Object.entries(chain.calls).map(([k, v]) => [k, v - (before[k] ?? 0)]).filter(([, v]) => v > 0));
  assert.deepEqual(made, { signatures: 1 }, "a quiet chain costs one getSignaturesForAddress a pass");
});

test("crank: a buy found from its signature waits for its block, then is minted in the next passes", async () => {
  const chain = fakeChain();
  const cfg = setPool(chain);
  chain.sigs = [{ signature: "start", err: null }];
  const { crank } = crankOn(chain);
  await crank.pass();
  const user = key();
  // the buy at slot 1000, decided by slot 1002; the ticket shows the batch waiting and the deposit
  setWallet(chain, { user, ticket: { batches: [waiting(3, 1002n)] }, deposit: collectible.mintDepositFor(STANDARD_RENT, cfg, 3) });
  addBuy(chain, { user, pieces: 3, slot: 1000n, targetSlot: 1002n, signature: "buy1" });
  landMints(chain, cfg);
  chain.slot = 1001n;
  const p1 = await crank.pass();
  assert.equal(p1.found, 1); assert.equal(p1.transactions, 1);
  assert.equal(p1.watching, 1); assert.equal(p1.waiting, 1, "its block is not in: nothing read for it");
  assert.equal(chain.calls.simulate ?? 0, 0);
  chain.slot = 1002n;
  const p2 = await crank.pass();
  assert.equal(p2.sent, 0, "slot 1002 itself does not decide it yet");
  chain.slot = 1003n;
  const p3 = await crank.pass();
  assert.equal(p3.sent, 1); assert.equal(p3.pieces, 3);
  assert.equal(p3.results[0].slotsAfterBuy, 3, "minted three slots after the buy");
  const p4 = await crank.pass();
  assert.equal(p4.watching, 0, "nothing waits any more: the wallet leaves the list");
  assert.equal(chain.sent.length, 1, "one mint, never two");
});

test("crank: a wallet that minted itself before the crank's first look is dropped with nothing sent", async () => {
  const chain = fakeChain();
  const cfg = setPool(chain);
  chain.sigs = [{ signature: "start", err: null }];
  const { crank, lines } = crankOn(chain);
  await crank.pass();
  const user = key();
  setWallet(chain, { user, ticket: { minted: 0, batches: [revealed(1), waiting(1, 1100n, 1)] }, deposit: collectible.mintDepositFor(STANDARD_RENT, cfg, 2) });
  addBuy(chain, { user, pieces: 1, slot: 1098n, targetSlot: 1100n, signature: "buy2" });
  chain.slot = 1099n;
  const w = await crank.pass();
  assert.equal(w.waiting, 1, "its block is not in: not read");
  // the wallet mints both pieces itself after slot 1100
  setWallet(chain, { user, ticket: { minted: 2, owned: [key(), key()] }, deposit: 40_000n });
  chain.slot = 1101n;
  const r = await crank.pass();
  assert.equal(chain.sent.length, 0, "nothing sent");
  assert.equal(chain.calls.simulate ?? 0, 0, "not even simulated");
  assert.equal(r.watching, 0);
  assert.ok(!lines.some((l) => /FAILED/.test(l)), lines.join("\n"));
});

test("crank: a wallet seen waiting, then found minted by itself, counts as minted first", async () => {
  const chain = fakeChain();
  const cfg = setPool(chain);
  chain.sigs = [{ signature: "start", err: null }];
  const { crank, lines } = crankOn(chain);
  await crank.pass();
  const user = key();
  // a ticket with a decided batch and an undecided one: the crank reads it, waits a moment for the second block
  setWallet(chain, { user, ticket: { minted: 1, owned: [key()], batches: [revealed(1), waiting(1, 2000n, 1)] }, deposit: collectible.mintDepositFor(STANDARD_RENT, cfg, 2) });
  chain.slot = 1990n;
  crank.add(POOL, user, {});
  const seen = await crank.pass();
  assert.equal(seen.sent, 0, "a block still to come: it waits");
  // the wallet mints its two pieces itself
  setWallet(chain, { user, ticket: { minted: 3, owned: [key(), key(), key()] }, deposit: 40_000n });
  chain.slot = 2001n;
  const after = await crank.pass();
  assert.equal(after.mintedFirst, 1);
  assert.equal(chain.sent.length, 0, "nothing sent, no fee spent");
  assert.ok(lines.some((l) => /minted before the keeper got to them, nothing sent/.test(l)), lines.join("\n"));
});

test("crank: a deposit too small is never sent, and is said once", async () => {
  const chain = fakeChain();
  const cfg = setPool(chain);
  const user = key();
  setWallet(chain, { user, ticket: { batches: [revealed(2)] }, deposit: costOf(cfg, 2) - 1n });
  const { crank, lines } = crankOn(chain);
  const p = await crank.pass();
  assert.equal(p.short, 1); assert.equal(p.sent, 0);
  assert.equal(chain.calls.simulate ?? 0, 0, "not even simulated");
  assert.equal(lines.filter((l) => /the deposit holds/.test(l)).length, 1);
  // the next sweep finds it again: no second line for the same deposit
  crank.sweptAt = -1e12;
  await crank.pass();
  assert.equal(lines.filter((l) => /the deposit holds/.test(l)).length, 1);
  assert.equal(chain.sent.length, 0);
});

test("crank: a refused simulation sends nothing; WrongAsset is tried again, DepositTooSmall drops, others rest after three", async () => {
  for (const [name, expect] of [["WrongAsset", "retry"], ["DepositTooSmall", "drop"], ["TooFewAssets", "strike"]]) {
    const chain = fakeChain({ sim: () => ({ err: { InstructionError: [1, { Custom: 6000 }] }, logs: [`Program log: AnchorError occurred. Error Code: ${name}. Error Number: 6000. Error Message: x.`], post: 0n }) });
    const cfg = setPool(chain);
    const user = key();
    setWallet(chain, { user, ticket: { batches: [revealed(1)] }, deposit: costOf(cfg, 1) });
    const clock = { t: 1_000_000 };
    const { crank } = crankOn(chain, { now: () => clock.t });
    const p = await crank.pass();
    assert.equal(p.refused, 1, name); assert.equal(chain.sent.length, 0, name);
    if (expect === "retry") assert.equal(crank.watch.size, 1, name + " stays on the list");
    if (expect === "drop") { assert.equal(crank.watch.size, 0, name + " leaves the list"); assert.equal(p.short, 1); }
    if (expect === "strike") {
      // the next simulation waits five seconds, then ten
      const sims = chain.simulated;
      await crank.pass();
      assert.equal(chain.simulated, sims, "not simulated again at once");
      for (let i = 1; i < MINT_STRIKES; i++) { clock.t += 11_000; await crank.pass(); }
      assert.equal(chain.simulated, sims + MINT_STRIKES - 1);
      assert.equal(crank.watch.size, 0, name + " rests after three");
      assert.equal(crank.rest.size, 1);
      crank.sweptAt = -1e12;
      await crank.pass();
      assert.equal(crank.watch.size, 0, "a resting wallet is not taken back by the sweep");
    }
  }
});

test("crank: a mint that fails on chain backs the wallet off, 30 s then 60 s, and it rests after the third", async () => {
  const chain = fakeChain();
  const cfg = setPool(chain);
  setWallet(chain, { user: key(), ticket: { batches: [revealed(1)] }, deposit: costOf(cfg, 1) });
  const clock = { t: 5_000_000 };
  const { crank, lines } = crankOn(chain, { now: () => clock.t, confirm: async () => { throw new Error("transaction failed: {\"InstructionError\":[1,{\"Custom\":6029}]}"); } });
  const p = await crank.pass();
  assert.equal(p.failed, 1); assert.equal(chain.sent.length, 1);
  assert.ok(lines.some((l) => /mint FAILED/.test(l) && /tx mint1/.test(l)), lines.join("\n"));
  await crank.pass();
  assert.equal(chain.sent.length, 1, "not tried again at once");
  clock.t += 29_000; await crank.pass();
  assert.equal(chain.sent.length, 1, "nor within 30 seconds");
  clock.t += 2_000; await crank.pass();
  assert.equal(chain.sent.length, 2, "after 30 seconds it is tried again");
  clock.t += 59_000; await crank.pass();
  assert.equal(chain.sent.length, 2, "then it waits 60 seconds");
  clock.t += 2_000; await crank.pass();
  assert.equal(chain.sent.length, 3);
  assert.equal(crank.watch.size, 0, "three failures: it rests");
  assert.equal(addMintTotals(NO_MINT_TOTALS(), p).failed, 1);
});

test("crank: a mint the node refuses before sending costs nothing and counts as refused, not failed", async () => {
  const chain = fakeChain();
  const cfg = setPool(chain);
  setWallet(chain, { user: key(), ticket: { batches: [revealed(1)] }, deposit: costOf(cfg, 1) });
  chain.connection.sendTransaction = async () => { const e = new Error("Transaction simulation failed"); e.logs = ["Program log: AnchorError occurred. Error Code: WrongAsset. Error Number: 6010. Error Message: x."]; throw e; };
  const { crank } = crankOn(chain);
  const p = await crank.pass();
  assert.equal(p.failed, 0); assert.equal(p.refused, 1); assert.equal(p.results.length, 0);
  assert.equal(crank.watch.size, 1, "WrongAsset: read again next pass");
});

test("crank: a simulation that shows the keeper poorer is never sent", async () => {
  const chain = fakeChain({ sim: (pre) => ({ err: null, logs: [], post: pre - 1n }) });
  const cfg = setPool(chain);
  setWallet(chain, { user: key(), ticket: { batches: [revealed(1)] }, deposit: costOf(cfg, 1) });
  const { crank, lines } = crankOn(chain);
  const p = await crank.pass();
  assert.equal(p.refused, 1); assert.equal(chain.sent.length, 0);
  assert.ok(lines.some((l) => /1 lamports poorer/.test(l)), lines.join("\n"));
});

test("crank: a keeper that cannot front the NFTs' rent is not simulated, says so, and tries again 30 s later", async () => {
  const chain = fakeChain({ keeperLamports: 1_000_000n });
  const cfg = setPool(chain);
  setWallet(chain, { user: key(), ticket: { batches: [revealed(2)] }, deposit: costOf(cfg, 2) });
  const clock = { t: 9_000_000 };
  const { crank, lines } = crankOn(chain, { now: () => clock.t });
  const p = await crank.pass();
  assert.equal(p.sent, 0); assert.equal(p.refused, 1); assert.equal(chain.calls.simulate ?? 0, 0);
  assert.ok(lines.some((l) => /holds 1000000 lamports; a mint of 2 pieces needs \d+ up front, paid back in the same transaction\. Fund it\./.test(l)), lines.join("\n"));
  await crank.pass();
  assert.equal(lines.filter((l) => /Fund it/.test(l)).length, 1, "not again at the next pass");
  chain.keeperLamports = 1_000_000_000n; clock.t += 31_000;
  assert.equal((await crank.pass()).sent, 1, "funded: it mints");
});

test("crank: a keeper that cannot pay the fee sends nothing", async () => {
  const chain = fakeChain();
  const cfg = setPool(chain);
  setWallet(chain, { user: key(), ticket: { batches: [revealed(1)] }, deposit: costOf(cfg, 1) });
  const { crank, lines } = crankOn(chain, { canSend: async () => false });
  const p = await crank.pass();
  assert.equal(p.sent, 0); assert.equal(chain.calls.simulate ?? 0, 0);
  assert.ok(lines.some((l) => /cannot pay the fee/.test(l)));
  assert.equal(crank.watch.size, 1, "it waits for a funded keeper");
});

test("crank: its own transactions and failed ones are never read; a full page of signatures brings a sweep", async () => {
  const chain = fakeChain();
  setPool(chain);
  chain.sigs = [{ signature: "s0", err: null }];
  const { crank } = crankOn(chain, { isOwn: (s) => s === "reveal-by-us" });
  await crank.pass();
  chain.sigs.unshift({ signature: "reveal-by-us", err: null }, { signature: "failed-buy", err: { InstructionError: [0, "x"] } });
  const p = await crank.pass();
  assert.equal(p.signatures, 2); assert.equal(chain.calls.transactions ?? 0, 0, "nothing to read");
  for (let i = 0; i < MINT_SIGNATURES_PER_PASS; i++) chain.sigs.unshift({ signature: "x" + i, err: { InstructionError: [0, "x"] } });
  const sweeps = chain.calls.programAccounts;
  await crank.pass();
  await crank.pass();
  assert.equal(chain.calls.programAccounts, sweeps + 1, "more than one page between two passes: every ticket is read again");
});

test("crank: a transaction the RPC does not serve yet is asked for again", async () => {
  const chain = fakeChain();
  const cfg = setPool(chain);
  chain.sigs = [{ signature: "s0", err: null }];
  const { crank } = crankOn(chain);
  await crank.pass();
  const user = key();
  setWallet(chain, { user, ticket: { batches: [waiting(1, 1002n)] }, deposit: collectible.mintDepositFor(STANDARD_RENT, cfg, 1) });
  chain.sigs.unshift({ signature: "late", err: null });
  const p1 = await crank.pass();
  assert.equal(p1.found, 0);
  addBuy(chain, { user, pieces: 1, slot: 1000n, targetSlot: 1002n, signature: "late" });
  chain.sigs.shift();
  const p2 = await crank.pass();
  assert.equal(p2.found, 1, "found at the next pass");
});

test("crank: --pool serves that pool only", async () => {
  const chain = fakeChain();
  setPool(chain);
  const { crank } = crankOn(chain, { pools: [key().toBase58()] });
  assert.equal(crank.add(POOL, key(), {}), false);
  assert.equal(crank.watch.size, 0);
});

test("settings: MINT_CRANK, its interval, its sweep and its priority fee; --no-mint and --no-crank turn it off", () => {
  const dir = path.join(os.tmpdir(), "mint-cfg");
  const d = buildConfig({}, parseArgs([]), dir);
  assert.equal(d.mint, true); assert.equal(d.mintIntervalSeconds, 60); assert.equal(d.mintSweepSeconds, 300); assert.equal(d.mintPriceMicroLamports, 0);
  assert.equal(buildConfig({ MINT_CRANK: "off" }, parseArgs([]), dir).mint, false);
  assert.equal(buildConfig({}, parseArgs(["--no-mint"]), dir).mint, false);
  assert.equal(buildConfig({}, parseArgs(["--no-mint"]), dir).settle, true, "--no-mint keeps the other cranks");
  assert.equal(buildConfig({}, parseArgs(["--no-crank"]), dir).mint, false);
  assert.equal(buildConfig({ MINT_INTERVAL_SECONDS: "5", MINT_SWEEP_SECONDS: "60", MINT_PRIORITY_MICROLAMPORTS: "20000" }, parseArgs([]), dir).mintPriceMicroLamports, 20_000);
  assert.throws(() => buildConfig({ MINT_PRIORITY_MICROLAMPORTS: "20001" }, parseArgs([]), dir), /MINT_PRIORITY_MICROLAMPORTS=20001 is above the maximum 20000/);
  assert.throws(() => buildConfig({ MINT_INTERVAL_SECONDS: "0" }, parseArgs([]), dir), /MINT_INTERVAL_SECONDS/);
  assert.throws(() => buildConfig({ MINT_CRANK: "maybe" }, parseArgs([]), dir), /MINT_CRANK=maybe must be on or off/);
  const shown = describeConfig(d);
  assert.ok(/poll every 60 s/.test(shown.mintCrank) && /from the feed/.test(shown.mintCrank) && ascii(shown.mintCrank), shown.mintCrank);
  assert.ok(/--no-mint or MINT_CRANK=off/.test(describeConfig(buildConfig({ MINT_CRANK: "off" }, parseArgs([]), dir)).mintCrank));
  assert.ok(/--no-crank/.test(describeConfig(buildConfig({}, parseArgs(["--no-crank"]), dir)).mintCrank));
  // the example file names every setting with its default
  const example = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  for (const line of ["MINT_CRANK=on", "MINT_INTERVAL_SECONDS=60", "MINT_SWEEP_SECONDS=300", "MINT_PRIORITY_MICROLAMPORTS=0", "NOTIFY=on", "NOTIFY_PER_MINUTE=3", "NOTIFY_GLOBAL_PER_MINUTE=30", "TICKET_RECONCILE_SECONDS=3600", "SETTLE_SWEEP_SECONDS=300"]) assert.ok(example.includes(line), line);
});

test("/health, the state and the status file carry the mint crank", () => {
  const status = { updatedAt: new Date(1_000_000).toISOString(), pools: {} };
  const totals = { ...NO_MINT_TOTALS(), sent: 4, pieces: 9, paidLamports: 36_000_000, feeLamports: 20_000, netLamports: 20_000, mintedFirst: 1, short: 2, refused: 3, failed: 0, lastSlotsAfterBuy: 4 };
  const mint = { enabled: true, lastMintAt: new Date(1_000_000).toISOString(), lastMintSent: 1, intervalSeconds: 2, watching: 1, totals };
  const h = healthBody({ status, mint, nowMs: 1_000_000 + 5000, staleAfterMs: 300_000, cluster: "localnet" });
  assert.equal(h.ok, true);
  assert.deepEqual([h.mintCrankEnabled, h.mintCrankStale, h.lastMintSent, h.mintWatching, h.mintsSent, h.piecesMintedForWallets, h.mintPaidBackLamports, h.mintFeesLamports, h.mintNetLamports, h.mintMintedFirst, h.mintDepositShort, h.mintRefused, h.mintsFailed, h.mintLastSlotsAfterBuy],
    [true, false, 1, 1, 4, 9, 36_000_000, 20_000, 20_000, 1, 2, 3, 0, 4]);
  // stale after 60 seconds without a pass (three intervals of two seconds would be too strict: a pass waits for its mint)
  assert.equal(healthBody({ status, mint, nowMs: 1_000_000 + 59_000, staleAfterMs: 300_000, cluster: "localnet" }).mintCrankStale, false);
  const late = healthBody({ status, mint, nowMs: 1_000_000 + 61_000, staleAfterMs: 300_000, cluster: "localnet" });
  assert.equal(late.mintCrankStale, true); assert.equal(late.ok, false);
  assert.equal(healthBody({ status, nowMs: 1_000_000, staleAfterMs: 300_000, cluster: "localnet" }).mintCrankEnabled, false);
  // the state keeps the totals
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mint-state-"));
  const file = path.join(dir, "state.json");
  const st = emptyState();
  assert.deepEqual(st.mint.totals, NO_MINT_TOTALS());
  st.mint.totals = totals;
  saveState(file, st);
  assert.deepEqual(loadState(file).mint.totals, totals);
  // the status file
  const out = buildStatus({ updatedAt: status.updatedAt, cluster: "localnet", platform: {}, pools: {}, mintCrank: { ...mint, lastAt: mint.lastMintAt } });
  assert.deepEqual(out.mintCrank, { enabled: true, intervalSeconds: 2, lastAt: mint.lastMintAt, watching: 1, sent: 4, failed: 0, pieces: 9, paidLamports: 36_000_000, feeLamports: 20_000, netLamports: 20_000, mintedFirst: 1, short: 2, refused: 3, lastSlotsAfterBuy: 4 });
  assert.equal(buildStatus({ updatedAt: status.updatedAt, cluster: "localnet", platform: {}, pools: {} }).mintCrank, undefined);
});

test("what a deposit pays for, in the SDK's own numbers: the crank's cost check is the chain's", () => {
  // three pieces of the site's renderer: what mintDepositFor asks is above what a mint of three costs
  const cfg = cfgOf({ name: "Path 683", uriBase: "http://localhost:8787/art", minted: 6 });
  const deposit = collectible.mintDepositFor(STANDARD_RENT, cfg, 3);
  const cost = collectible.mintForCost(STANDARD_RENT, cfg, 346, 0, 3);
  assert.ok(deposit >= cost, `${deposit} >= ${cost}`);
  assert.ok(cost > 3n * CORE_CREATE_FEE + KEEPER_FEE);
  const d = mintDecision({ info: ticketAccount({ batches: [revealed(3)] }, deposit), cfg, backing: 3n * cfg.unit, slot: 100n });
  assert.equal(d.action, "mint"); assert.equal(d.cost, cost);
});
