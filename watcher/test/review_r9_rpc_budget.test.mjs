// Round 9 review (R4): what each crank asks of the RPC per pass, counted on a fake connection, and the one list of
// pools after a read of it fails. These tests pin the numbers the RPC budget is built on; a test named BUG asserts
// the behaviour the watcher should have and fails until it is fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAMS, collectible } from "../../sdk/dist/index.js";
import { MintCrank } from "../lib/mint.mjs";
import { readUnbacked, readUpkeep, readTickets } from "../lib/crank.mjs";
import { readHolderExcess, readBurnCandidates } from "../lib/burn.mjs";
import { PoolCache } from "../lib/pools.mjs";
import { TradesFeed } from "../lib/feed.mjs";
import { ticketBytes, collectionConfig, tokenAccountBytes, POOL, OWNER, BASE_MINT, BATCH_REVEALED, BATCH_WAITING } from "./bytes.mjs";

const { STANDARD_RENT, KEEPER_FEE } = collectible;
const HOOK = PROGRAMS.hook_collectible;
const key = () => Keypair.generate().publicKey;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "r9-budget-"));

/// A chain in memory that counts every RPC method it is asked. Accounts by address; the collectible program's
/// signatures newest first; transactions by signature.
function fakeChain() {
  const c = { accounts: new Map(), sigs: [], txs: new Map(), slot: 1000n, calls: {}, sent: [] };
  const count = (m) => { c.calls[m] = (c.calls[m] ?? 0) + 1; };
  c.total = () => Object.values(c.calls).reduce((a, b) => a + b, 0);
  c.reset = () => { c.calls = {}; };
  c.connection = {
    async getSignaturesForAddress(addr, opts = {}) {
      count("getSignaturesForAddress");
      let list = c.sigs.filter((s) => s.address.equals(addr));
      if (opts.until) { const i = list.findIndex((s) => s.signature === opts.until); list = i < 0 ? list : list.slice(0, i); }
      return list.slice(0, opts.limit ?? 1000).map((s) => ({ signature: s.signature, slot: s.slot, err: null, blockTime: 1_760_000_000 }));
    },
    async getTransactions(list) { count("getTransaction(batch item)"); c.calls["getTransaction(batch item)"] += list.length - 1; return list.map((s) => c.txs.get(s) ?? null); },
    async getTransaction(s) { count("getTransaction"); return c.txs.get(s) ?? null; },
    async getProgramAccounts(pid, opts = {}) {
      count("getProgramAccounts");
      // the dataSize filter is honoured (the holder sync asks for 129-byte records); memcmp filters are not, so a
      // caller that decodes with try/catch (fetchTickets) sees every account of the program, as a loose RPC would
      const size = (opts.filters ?? []).find((f) => f && f.dataSize !== undefined);
      return [...c.accounts.entries()].filter(([, a]) => a && a.owner.equals(pid) && a.data.length > 8 && (!size || a.data.length === size.dataSize)).map(([k, a]) => ({ pubkey: new PublicKey(k), account: a }));
    },
    async getMultipleAccountsInfo(keys) { count("getMultipleAccountsInfo"); return keys.map((k) => c.accounts.get(k.toBase58()) ?? null); },
    async getMultipleAccountsInfoAndContext(keys) { count("getMultipleAccountsInfo"); return { context: { slot: Number(c.slot) }, value: keys.map((k) => c.accounts.get(k.toBase58()) ?? null) }; },
    async getAccountInfo(k) { count("getAccountInfo"); return c.accounts.get(k.toBase58()) ?? null; },
    async getSlot() { count("getSlot"); return Number(c.slot); },
    async getBalance() { count("getBalance"); return 1_000_000_000; },
    async getMinimumBalanceForRentExemption(n) { count("getMinimumBalanceForRentExemption"); return Number(STANDARD_RENT(n)); },
    async simulateTransaction() { count("simulateTransaction"); return { value: { err: null, logs: [], accounts: [{ lamports: 1_000_000_000 + Number(KEEPER_FEE) - 5000 }] } }; },
    async sendTransaction() { count("sendTransaction"); const signature = `mint${c.sent.length + 1}`; c.sent.push(signature); return signature; },
    async getSignatureStatuses() { count("getSignatureStatuses"); return { value: [{ err: null, confirmationStatus: "confirmed" }] }; },
  };
  return c;
}
const ticketAccount = (o = {}, deposit = 0n) => { const data = Buffer.from(ticketBytes(o)); return { owner: HOOK, data, lamports: Number(STANDARD_RENT(data.length) + deposit) }; };
const account = (owner, bytes) => ({ owner, data: Buffer.from(bytes), lamports: 1_000_000 });
const revealed = (pieces) => ({ state: BATCH_REVEALED, pieces, firstRoll: 0, targetSlot: 50n, seed: new Uint8Array(32).fill(7) });

/// A collectible pool with `holders` wallets that hold pieces and the coins that back them.
function collectiblePool(c, { pool = POOL, holders = 3, pegged = false } = {}) {
  const cfg = collectionConfig({ pool, unit: 10n, pegged });
  c.accounts.set(collectible.collectiblePda.cfg(pool).toBase58(), account(HOOK, cfg));
  const decoded = collectible.decodeCollectionConfig(cfg);
  const wallets = [];
  for (let i = 0; i < holders; i++) {
    const user = key();
    const owned = [collectible.collectiblePda.asset(pool, user, 0)];
    c.accounts.set(collectible.collectiblePda.ticket(pool, user).toBase58(), ticketAccount({ pool, user, minted: 1, owned }));
    c.accounts.set(collectible.coinsAddress(user, decoded.baseMint, decoded.tokenProgram).toBase58(), account(decoded.tokenProgram, tokenAccountBytes({ mint: decoded.baseMint, owner: user, amount: 100n })));
    wallets.push(user);
  }
  return { cfg: decoded, wallets };
}

test("budget: the mint crank's idle pass is one getSignaturesForAddress (2 RU on Chainstack): 43,200 a day at 2 s", async () => {
  const c = fakeChain();
  const crank = new MintCrank({ connection: c.connection, keeper: Keypair.generate(), buildTx: async () => { throw new Error("not built"); }, rent: STANDARD_RENT, sweepMs: 300_000, now: () => 1_000_000 });
  await crank.pass();   // the start: the sweep (every ticket) and the first look (sets the cursor)
  assert.deepEqual(c.calls, { getProgramAccounts: 1, getSignaturesForAddress: 1 }, "start: one read of every ticket, one look at the newest signature");
  c.reset();
  await crank.pass(); await crank.pass(); await crank.pass();
  assert.deepEqual(c.calls, { getSignaturesForAddress: 3 }, "idle: one getSignaturesForAddress a pass, nothing else");
  const perDay = Math.floor(86400 / 2);
  assert.equal(perDay, 43_200);
  assert.equal(perDay * 2, 86_400, "request units a day for the poll alone (getSignaturesForAddress is always billed as archive)");
});

test("budget: the mint crank's sweep is one getProgramAccounts of every ticket of the hook, with the full account data", async () => {
  const c = fakeChain();
  collectiblePool(c, { holders: 5 });
  const crank = new MintCrank({ connection: c.connection, keeper: Keypair.generate(), buildTx: async () => { throw new Error("not built"); }, rent: STANDARD_RENT, sweepMs: 300_000, now: () => 1_000_000 });
  const r = await crank.pass();
  assert.equal(r.swept, true);
  assert.equal(c.calls.getProgramAccounts, 1);
  // 5 tickets with pieces but no deposit: none joins the list, the sweep answered them all the same
  assert.equal(crank.watch.size, 0);
});

test("budget: one deposit buy costs the mint crank about ten calls: its transaction, slot and accounts while the block comes, balance, simulation, send, confirmation, the transaction", async () => {
  const c = fakeChain();
  const { cfg } = collectiblePool(c, { holders: 0 });
  const user = key();
  const cost = collectible.mintForCost(STANDARD_RENT, cfg, 346, 0, 2);
  c.accounts.set(collectible.collectiblePda.ticket(POOL, user).toBase58(), ticketAccount({ pool: POOL, user, batches: [revealed(2)] }, cost + 1000n));
  c.accounts.set(collectible.coinsAddress(user, cfg.baseMint, cfg.tokenProgram).toBase58(), account(cfg.tokenProgram, tokenAccountBytes({ mint: cfg.baseMint, owner: user, amount: 100n })));
  const keeper = Keypair.generate();
  const buildTx = async (payer, ixs) => {
    const { TransactionMessage, VersionedTransaction } = await import("@solana/web3.js");
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: key().toBase58(), instructions: ixs }).compileToV0Message();
    return { tx: new VersionedTransaction(msg), lastValidBlockHeight: 10 };
  };
  const crank = new MintCrank({ connection: c.connection, keeper, buildTx, rent: STANDARD_RENT, sweepMs: 300_000, now: () => 1_000_000, confirm: async () => ({}) });
  await crank.pass();          // start: sweep + cursor
  c.reset();
  // a buy lands: PiecesEarned in a transaction of the collectible program
  const { EVENT_DISC } = await import("../../sdk/dist/index.js");
  const ev = Buffer.concat([Buffer.from(EVENT_DISC.PiecesEarned), POOL.toBuffer(), user.toBuffer(), Buffer.from([2, 0, 0, 0]), Buffer.alloc(8), Buffer.alloc(8)]);
  c.sigs.unshift({ address: HOOK, signature: "buy1", slot: 999 });
  c.txs.set("buy1", { slot: 999, meta: { err: null, logMessages: [`Program data: ${ev.toString("base64")}`] }, transaction: { signatures: ["buy1"] } });
  const r = await crank.pass();
  assert.equal(r.sent, 1, `one mint sent: ${JSON.stringify(r)}`);
  const total = c.total();
  assert.ok(total >= 7 && total <= 12, `about ten calls for one buy, got ${total}: ${JSON.stringify(c.calls)}`);
  assert.equal(c.calls.getSignaturesForAddress, 1);
  assert.equal(c.calls["getTransaction(batch item)"], 1, "the buy's transaction, in one batched read");
  assert.equal(c.calls.simulateTransaction, 1);
  assert.equal(c.calls.sendTransaction, 1);
});

test("budget: a settle pass with tickets is three calls (configs, every ticket by getProgramAccounts, the holders' coins); without a ticket two", async () => {
  const c = fakeChain();
  collectiblePool(c, { holders: 3 });
  const r = await readUnbacked(c.connection, [POOL]);
  assert.deepEqual(r.unread, []);
  assert.deepEqual(c.calls, { getMultipleAccountsInfo: 2, getProgramAccounts: 1 });
  const empty = fakeChain();
  empty.accounts.set(collectible.collectiblePda.cfg(POOL).toBase58(), account(HOOK, collectionConfig({ pool: POOL })));
  await readUnbacked(empty.connection, [POOL]);
  assert.deepEqual(empty.calls, { getMultipleAccountsInfo: 1, getProgramAccounts: 1 }, "no ticket with pieces: no read of coin accounts");
  assert.equal(Math.floor(86400 / 10) * 3, 25_920, "calls a day at the live 10 s with holders");
});

test("budget: a getProgramAccounts that aborts makes every collectible pool unread for the pass: nothing is settled, nothing is alerted here", async () => {
  const c = fakeChain();
  collectiblePool(c, { holders: 2 });
  const other = key();
  collectiblePool(c, { pool: other, holders: 1 });
  c.connection.getProgramAccounts = async () => { throw new Error("failed to get accounts owned by program 3WCHK9zm...: scan aborted"); };
  const r = await readUnbacked(c.connection, [POOL, other]);
  assert.equal(r.unbacked.length, 0);
  assert.deepEqual(r.unread.map((u) => u.pool).sort(), [POOL.toBase58(), other.toBase58()].sort());
  assert.match(r.unread[0].error, /scan aborted/);
  const u = await readUpkeep(c.connection, [POOL, other]);
  assert.equal(u.work.length, 0);
  assert.equal(u.unread.length, 2);
  await assert.rejects(() => readTickets(c.connection), /scan aborted/, "the reveal crank's read throws: the pass fails and the loop alerts 'crank failed'");
});

test("budget: an upkeep pass with no pegged pool reads nothing; with one, configs and queues, every ticket, and the assets", async () => {
  const c = fakeChain();
  assert.deepEqual(await readUpkeep(c.connection, []), { work: [], unread: [] });
  assert.deepEqual(c.calls, {});
  collectiblePool(c, { holders: 4, pegged: true });
  await readUpkeep(c.connection, [POOL]);
  assert.deepEqual(c.calls, { getMultipleAccountsInfo: 2, getProgramAccounts: 1 });
});

test("budget: the holder sync reads the strict pools' configs and mints every pass, and the holder records only when due", async () => {
  const c = fakeChain();
  const { rulesConfig, mint2022Bytes, TOKEN_2022_PROGRAM } = await import("./bytes.mjs");
  const { pda } = await import("../../sdk/dist/index.js");
  const pool = { address: POOL, hasHook: true, hookProgram: PROGRAMS.hook_rules, baseMint: BASE_MINT, baseTokenProgram: TOKEN_2022_PROGRAM };
  c.accounts.set(pda.cfg(PROGRAMS.hook_rules, POOL).toBase58(), account(PROGRAMS.hook_rules, rulesConfig({ kind: 1, pool: POOL })));
  c.accounts.set(BASE_MINT.toBase58(), account(TOKEN_2022_PROGRAM, mint2022Bytes({ supply: 1000n })));
  const scans = {};
  await readHolderExcess(c.connection, [pool], { scans, nowMs: 1_000_000 });
  assert.deepEqual(c.calls, { getMultipleAccountsInfo: 1, getProgramAccounts: 1 }, "first pass: the records are read");
  c.reset();
  await readHolderExcess(c.connection, [pool], { scans, nowMs: 1_030_000 });
  assert.deepEqual(c.calls, { getMultipleAccountsInfo: 1 }, "a pass with the same supply and nothing pending: configs and mints only");
  assert.equal(Math.floor(86400 / 30), 2880, "calls a day at the live 30 s for one strict pool");
});

test("budget: a burn pass reads every config and treasury in one call and asks the SDK only for pools with a pot", async () => {
  const c = fakeChain();
  const pool = { address: POOL, hasHook: true, hookProgram: PROGRAMS.hook_buyback, hookQuoteTreasury: key(), lpFeeBps: 100 };
  const client = { buybackInstructions: async () => { c.calls.sdkBuyback = (c.calls.sdkBuyback ?? 0) + 1; return null; }, rulesBurnInstructions: async () => null };
  const r = await readBurnCandidates(c.connection, client, key(), [pool]);
  assert.deepEqual(c.calls, { getMultipleAccountsInfo: 1 }, "a pool whose config cannot be read costs the one batched read");
  assert.equal(r.unread.length, 1);
});

test("budget: the feed's idle pass is one getSignaturesForAddress on the pool program (plus the loop's getSlot)", async () => {
  const c = fakeChain();
  const dir = tmpDir();
  c.sigs.push({ address: PROGRAMS.hookpool, signature: "old1", slot: 900 });
  const feed = new TradesFeed({ connection: c.connection, dir, stateFile: path.join(dir, "feed.json"), fetchOpts: { pauseMs: 0 } });
  await feed.pass(1000);
  assert.deepEqual(c.calls, { getSignaturesForAddress: 1 }, "the first pass sets the cursor with one look");
  c.reset();
  await feed.pass(1001); await feed.pass(1002);
  assert.deepEqual(c.calls, { getSignaturesForAddress: 2 });
  assert.equal(Math.floor(86400 / 10) * (2 + 1), 25_920, "request units a day at the live 10 s: 2 for the signatures, 1 for the slot");
});

test("BUG: after a failed read of the pools, the one list must not be taken for the chain's once a transaction of the pool program was consumed", async () => {
  // The feed pass (index.mjs feedPass) reads the pools again when its pass consumed transactions. When that read
  // fails (Chainstack aborts getProgramAccounts intermittently), the pass fails AFTER the cursor moved: the next
  // pass sees no new transaction, and the code path then calls `confirm`, marking the stale list as the chain's,
  // and does not read again until MARKET_REFRESH_SECONDS. The cache itself offers no way to say "a read is owed".
  let fail = true;
  const fresh = { pools: [{ address: POOL, reserveQuote: 2n }], bytes: new Map(), slot: 2 };
  const cache = new PoolCache({ read: async () => { if (fail) throw new Error("scan aborted"); return fresh; }, now: () => 1_000_000 });
  cache.set({ pools: [{ address: POOL, reserveQuote: 1n }], bytes: new Map(), slot: 1 }, 900_000);
  await assert.rejects(() => cache.refresh(), /scan aborted/);
  // what feedPass does on the NEXT pass when no transaction landed in between: it confirms the list
  cache.confirm(1_000_000);
  // the list a crank or the market then gets within MARKET_REFRESH_SECONDS: the stale one, taken as current.
  // (Round 10: the RPC answers again from here, so that the read get() owes can be seen to happen; as first
  // written, `fail` was turned off only after the awaited get(), which no implementation could pass.)
  fail = false;
  const got = await cache.get(300_000);
  assert.equal(got[0].reserveQuote, 2n, "a read that failed must leave the list owed a read: get() should read again, not serve the stale list as confirmed");
});
