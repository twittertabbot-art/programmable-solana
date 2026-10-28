// Round 12 review (V3, the watcher code since round 9): the ticket index under overlapping reads and behind a node
// that lags, the one list of pools patched by address, the pause of the read of the whole program, and what
// POST /notify costs and whom it counts. Tests named "BUG: ..." fail today and pass once the finding is fixed;
// tests named "R12: ..." record a fact the review report relies on and pass today. None touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAMS, collectible, decodePool } from "../../sdk/dist/index.js";
import { PoolCache, bs58, FULL_READ_RETRY_MS } from "../lib/pools.mjs";
import { TicketIndex, EMPTY_PASSES_TO_DROP } from "../lib/tickets.mjs";
import { MintCrank, MINT_TX_TRIES } from "../lib/mint.mjs";
import { TradesFeed } from "../lib/feed.mjs";
import { readUnbacked } from "../lib/crank.mjs";
import { planGraduates, GRADUATE_RESEND_MS } from "../lib/curve.mjs";
import { NotifyLimiter, clientIp } from "../lib/server.mjs";
import { clientAddress } from "../../rpc-proxy/lib/limits.mjs";
import { ticketBytes, poolBytes, collectionConfig, POOL, BATCH_WAITING } from "./bytes.mjs";

const HOOK = PROGRAMS.hook_collectible;
const { STANDARD_RENT } = collectible;
const key = () => Keypair.generate().publicKey;
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const ticketAccount = (o = {}, deposit = 0n) => { const d = Buffer.from(ticketBytes(o)); return { owner: HOOK, data: d, lamports: Number(STANDARD_RENT(d.length) + deposit) }; };
const fakeSignature = () => bs58(Keypair.generate().secretKey);   // 64 random bytes, as a signature is

/// A chain of accounts read by address, with a pause in every answer like a real RPC round trip. Each answer is
/// what the chain held when the call was made.
function accountsChain(delayMs = 5) {
  const c = { accounts: new Map(), calls: 0, slot: 500, configs: [] };
  c.connection = {
    async getMultipleAccountsInfoAndContext(keys, config) {
      c.calls += 1; c.configs.push(config);
      const value = keys.map((k) => c.accounts.get(k.toBase58()) ?? null);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { context: { slot: c.slot }, value };
    },
    async getMultipleAccountsInfo(keys) { c.calls += 1; return keys.map((k) => c.accounts.get(k.toBase58()) ?? null); },
  };
  return c;
}

// ---- the ticket index --------------------------------------------------------------------------------------

test("BUG: two reads of the ticket index that overlap must not throw when one of them drops a ticket", async () => {
  // The settle crank (every 10 s), the reveal crank (20 s), the pool pass (60 s) and the mint crank's sweep (every
  // 300 s, always a fresh read) start in the same tick and keep their phase, and TicketIndex.read shares only a
  // read that has FINISHED: two reads in flight at once are normal. Each takes its keys before its await and
  // looks its entry up after it.
  const c = accountsChain();
  const idx = new TicketIndex({ file: null, log: quiet, now: () => 1_000_000 });
  const u = key();
  idx.add(POOL, u);
  const t = collectible.collectiblePda.ticket(POOL, u).toBase58();
  c.accounts.set(t, ticketAccount({ pool: POOL, user: u }));   // nothing waiting, nothing owned: the wallet sold out
  for (let i = 1; i < EMPTY_PASSES_TO_DROP; i++) await idx.read(c.connection);
  assert.equal(idx.has(t), true, "still indexed after two empty reads");
  const both = await Promise.allSettled([idx.read(c.connection), idx.read(c.connection)]);
  const failed = both.filter((x) => x.status === "rejected").map((x) => String(x.reason && x.reason.message));
  assert.deepEqual(failed, [], `the second read threw (the settle pass then counts every pool unread; the mint pass fails and alerts "mint crank failed"): ${failed.join("; ")}`);
});

test("BUG: one answer without the ticket (an RPC node a few slots behind the buy) must not drop a ticket the feed has just added", async () => {
  const c = accountsChain(0);
  const idx = new TicketIndex({ file: null, log: quiet, now: () => 1_000_000 });
  const u = key();
  idx.add(POOL, u);   // the feed read the buy's PiecesEarned and named the ticket
  const t = collectible.collectiblePda.ticket(POOL, u).toBase58();
  // the node that answers the next read is behind the buy's slot: it has no account there yet
  const first = await idx.read(c.connection);
  assert.equal(first.dropped, 1);
  // a moment later every node has it: two pieces wait for their reveal
  c.accounts.set(t, ticketAccount({ pool: POOL, user: u, batches: [{ state: BATCH_WAITING, pieces: 2, firstRoll: 0, targetSlot: 600n, seed: new Uint8Array(32) }] }));
  const later = await idx.read(c.connection);
  assert.equal(later.tickets.length, 1, "the ticket with two waiting pieces is gone from the index: the reveal, settle and upkeep cranks and the sweep do not see it until the next listing (TICKET_RECONCILE_SECONDS, an hour live) or another buy of that wallet on that pool; an unrevealed batch expires after 512 slots and mints as the common tier");
});

// ---- the one list of pools ---------------------------------------------------------------------------------

test("R12: a pool read by address takes the answer of whatever slot the node is at (no minContextSlot): an answer older than the trade it patches is kept and then confirmed; a new pool the node does not have yet is left out and not owed", async () => {
  const A = key(); const B = key();
  const before = new Uint8Array(poolBytes({ reserveQuote: 100n }));
  const node = { slot: 95, accounts: new Map([[A.toBase58(), before]]), configs: [] };
  const connection = {
    async getMultipleAccountsInfoAndContext(keys, config) {
      node.configs.push(config);
      return { context: { slot: node.slot }, value: keys.map((k) => { const d = node.accounts.get(k.toBase58()); return d ? { data: Buffer.from(d), owner: PROGRAMS.hookpool, lamports: 1 } : null; }) };
    },
  };
  let now = 1_000_000;
  const cache = new PoolCache({ connection, read: async () => ({ pools: [decodePool(A, before)], bytes: new Map([[A.toBase58(), before]]), slot: 90 }), now: () => now, feedOwned: true });
  await cache.refresh();
  // the feed walked a buy on A at slot 100 (the reserve went from 100 to 200) and a PoolCreated of B at slot 101;
  // index.mjs then calls refreshSome with the pools they touched, and the node that answers is at slot 95
  now = 1_010_000;
  const r = await cache.refreshSome([A, B]);
  assert.equal(node.configs[0], undefined, "the read carries no minContextSlot (no config at all)");
  assert.deepEqual({ changed: r.changed, added: r.added, dropped: r.dropped }, { changed: 1, added: 0, dropped: 0 });
  assert.equal(cache.owed, false, "nothing is owed");
  assert.equal(cache.pools.length, 1, "B is not in the list");
  assert.equal(cache.pools[0].reserveQuote, 100n, "A holds the reserves of slot 95, before the buy");
  assert.equal(cache.validAt, 1_010_000);
  // the next feed pass finds no new transaction and confirms the list: market.json says checked now, with A's old
  // reserves and without B, until the next trade on them or the reconciliation (MARKET_REFRESH_SECONDS, 30 min live)
  now = 1_020_000; cache.confirm(now);
  assert.equal(cache.validAt, 1_020_000);
});

test("BUG: while a transaction was walked past unread, a patch by address must not move the list's checked time", async () => {
  const A = key();
  let now = 1_000_000;
  let failFull = false;
  const bytesA = new Uint8Array(poolBytes({ reserveQuote: 5n }));
  const cache = new PoolCache({
    read: async () => { if (failFull) throw new Error("scan aborted"); return { pools: [decodePool(A, bytesA)], bytes: new Map([[A.toBase58(), bytesA]]), slot: 1 }; },
    readSome: async (addrs) => ({ pools: new Map(addrs.map((a) => [a.toBase58(), decodePool(a, bytesA)])), bytes: new Map(addrs.map((a) => [a.toBase58(), bytesA])), slot: 2 }),
    now: () => now, feedOwned: true,
  });
  await cache.refresh();
  const checked = cache.validAt;
  // a feed pass walks past a transaction it cannot read (its pools are unknown: oweFull), the read of the whole
  // program fails, and the pool the readable transactions touched is patched (index.mjs feedPass, the catch branch)
  now = 1_010_000;
  cache.oweFull(); failFull = true;
  await assert.rejects(() => cache.refresh());
  await cache.refreshSome([A]);
  assert.equal(cache.owed, true, "the list is owed a read of the whole program");
  // feedPass: checkedAt = owed ? (validAt || readAt) : now
  assert.equal(cache.validAt, checked, `market.json's checkedAt moves to ${new Date(cache.validAt).toISOString()} (and with every later patch) while a pool of the unread transaction may be behind the chain; FEED-CONTRACT.md says it does not advance while a read is owed`);
});

test("BUG: with the feed on, the loops asking for the pools while the first read of the whole program is in its pause must not read it again", async () => {
  let reads = 0; let now = 1_000_000;
  const cache = new PoolCache({ read: async () => { reads += 1; throw new Error("scan aborted: scan abandoned after waiting 15371ms for a scan slot"); }, now: () => now, feedOwned: true });
  await assert.rejects(() => cache.refresh());   // the feed's first pass at a start, on a node that aborts the call
  assert.equal(reads, 1);
  // within the 30 s pause: the reveal, mint, settle, upkeep, burn and graduate loops and the pool pass ask for the list
  for (let i = 0; i < 7; i++) { now += 1000; await cache.get(15_000).catch(() => {}); }
  assert.equal(reads, 1, `${reads - 1} more getProgramAccounts of the pool program inside the ${FULL_READ_RETRY_MS / 1000} s pause (get() with pools === null calls refresh(), which ignores nextFullAt): every loop retries the call the node is aborting, at its own interval, for as long as it fails`);
});

test("R12: a feed pass that finds a gap (more new transactions than MAX_PAGES pages) reports no touched pool and nothing unreadable, so feedPass owes the list nothing when the read of the whole program then fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r12-gap-"));
  const sigs = [{ signature: "s3", slot: 30, err: null }, { signature: "s2", slot: 20, err: null }];
  const connection = { async getSignaturesForAddress(addr, opts = {}) { return opts.limit === 1 ? sigs.slice(0, 1) : sigs.slice(0, opts.limit); }, async getTransactions() { throw new Error("not read on a gap"); } };
  const feed = new TradesFeed({ connection, dir: path.join(dir, "trades"), stateFile: path.join(dir, "feed.json"), perPage: 2, maxPages: 1, log: quiet });
  feed.state.startSlot = 5; feed.state.cursor = "s1"; feed.state.cursorSlot = 10;   // a feed that ran before, cursor far behind
  const c = await feed.collect(40);
  assert.equal(c.gap, true);
  assert.deepEqual({ touchedPools: c.touchedPools, unreadable: c.unreadable }, { touchedPools: [], unreadable: 0 });
  // index.mjs feedPass: `if (c.unreadable > 0) poolCache.oweFull()` is the only marker; on a gap the full read is
  // tried, and when it fails with nothing touched, `owed` stays false: checkedAt = this pass (index.mjs:984), and
  // the next idle passes confirm (index.mjs:969-971) a list from before the gap
  const A = key(); const bytesA = new Uint8Array(poolBytes({ reserveQuote: 1n }));
  const cache = new PoolCache({ read: async () => { throw new Error("scan aborted"); }, now: () => 2_000_000, feedOwned: true });
  cache.set({ pools: [decodePool(A, bytesA)], bytes: new Map([[A.toBase58(), bytesA]]), slot: 10 }, 1_000_000);
  if (c.unreadable > 0) cache.oweFull();
  await assert.rejects(() => cache.refresh());
  assert.equal(cache.owed, false, "nothing owed after a gap whose full read failed");
  cache.confirm(2_000_000);
  assert.equal(cache.validAt, 2_000_000, "and the list of before the gap is confirmed as the chain's");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- POST /notify --------------------------------------------------------------------------------------------

/// The collectible program's signatures, transactions and accounts, every call counted in request units the way
/// the paid plan counts them (getSignaturesForAddress 2, everything else 1 per item of a batch).
function mintChain() {
  const c = { accounts: new Map(), sigs: [{ signature: "head", slot: 900 }], txs: new Map(), slot: 1000, calls: {}, units: 0, items: { getTransactions: 0 } };
  const count = (m, n = 1, ru = 1) => { c.calls[m] = (c.calls[m] ?? 0) + 1; c.units += n * ru; };
  c.connection = {
    async getSignaturesForAddress(addr, opts = {}) {
      count("getSignaturesForAddress", 1, 2);
      let list = c.sigs;
      if (opts.until) { const i = list.findIndex((s) => s.signature === opts.until); list = i < 0 ? list : list.slice(0, i); }
      return list.slice(0, opts.limit ?? 1000).map((s) => ({ signature: s.signature, slot: s.slot, err: null }));
    },
    async getTransactions(list) { count("getTransactions", list.length); c.items.getTransactions += list.length; return list.map((s) => c.txs.get(s) ?? null); },
    async getTransaction(s) { count("getTransaction"); return c.txs.get(s) ?? null; },
    async getProgramAccounts() { count("getProgramAccounts"); throw new Error("not with the index"); },
    async getMultipleAccountsInfoAndContext(keys) { count("getMultipleAccountsInfo"); return { context: { slot: c.slot }, value: keys.map((k) => c.accounts.get(k.toBase58()) ?? null) }; },
    async getMultipleAccountsInfo(keys) { count("getMultipleAccountsInfo"); return keys.map((k) => c.accounts.get(k.toBase58()) ?? null); },
    async getSlot() { count("getSlot"); return c.slot; },
    async getBalance() { count("getBalance"); return 1_000_000_000; },
  };
  return c;
}

test("BUG: a notified signature the chain does not know must cost at most two reads and no sweep of the tickets", async () => {
  const c = mintChain();
  // 250 indexed tickets that hold a minted piece each (they stay in the index): a sweep reads them, a hundred a call
  const idx = new TicketIndex({ file: null, log: quiet, now: () => 1_000_000 });
  for (let i = 0; i < 250; i++) { const u = key(); idx.add(POOL, u); c.accounts.set(collectible.collectiblePda.ticket(POOL, u).toBase58(), ticketAccount({ pool: POOL, user: u, minted: 1, owned: [key()] })); }
  const crank = new MintCrank({ connection: c.connection, keeper: Keypair.generate(), buildTx: async () => { throw new Error("nothing is built"); }, rent: STANDARD_RENT, sweepMs: 300_000, now: () => 1_000_000, tickets: idx, log: quiet });
  await crank.pass();   // the start: the sweep, and the poll that sets the cursor
  await crank.pass();
  c.calls = {}; c.units = 0; c.items.getTransactions = 0;
  // the flood: well-formed signatures of nothing, each accepted (the server checks the form and the rate only) and
  // each waking the crank at once (index.mjs Watcher.notify -> wakeMint), so one pass follows each
  const N = 40;
  for (let i = 0; i < N; i++) { assert.equal(crank.notify(fakeSignature()).accepted, true); await crank.pass(); }
  for (let i = 0; i < MINT_TX_TRIES + 1; i++) await crank.pass();   // the passes that drain what is left
  const passes = N + MINT_TX_TRIES + 1;
  const sweeps = Math.round(((c.calls.getMultipleAccountsInfo ?? 0)) / 3);
  const perNotify = c.units / N;
  const perDay = Math.round(perNotify * 120 * 1440);
  assert.ok(c.items.getTransactions <= 2 * N && sweeps === 0,
    `${N} notifications of unknown signatures cost ${c.units} request units in ${passes} passes: ${c.items.getTransactions} transaction reads (${c.items.getTransactions / N} each: MINT_TX_TRIES), ${c.calls.getSignaturesForAddress} getSignaturesForAddress (2 each), ${c.calls.getMultipleAccountsInfo ?? 0} getMultipleAccountsInfo = ${sweeps} sweeps of the 250 indexed tickets (a signature dropped after its tries sets sweepSoon). That is ${perNotify.toFixed(1)} units per notification, ${perDay.toLocaleString("en-US")} a day at the global limit of 120 a minute (the plan has 20,000,000 a month)`);
});

test("BUG: behind the proxy on this machine the notify limit must count the address the proxy added (the last X-Forwarded-For entry), as the RPC proxy and the site do", () => {
  // nginx's usual `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`, or Caddy with trusted_proxies,
  // keep what the caller sent and append the real address: the first entry is the caller's to choose
  const req = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.9" } };
  assert.equal(clientAddress(req), "198.51.100.9", "the RPC proxy's rule (rpc-proxy/lib/limits.mjs)");
  assert.equal(clientIp(req), "198.51.100.9", "watcher/lib/server.mjs clientIp takes the FIRST entry: a caller that writes its own X-Forwarded-For picks a new bucket for every request");
});

test("R12: twelve addresses at ten a minute fill the global 120 of POST /notify; every other caller then gets 429 for the rest of the minute", () => {
  let now = 0;
  const lim = new NotifyLimiter({ perMinute: 10, globalPerMinute: 120, now: () => now });
  for (let ip = 0; ip < 12; ip++) for (let n = 0; n < 10; n++) assert.equal(lim.allow(`198.51.100.${ip}`), true);
  assert.equal(lim.allow("203.0.113.50"), false, "a buyer's coin page is refused");
  now = 59_999; assert.equal(lim.allow("203.0.113.50"), false);
  now = 60_001; assert.equal(lim.allow("203.0.113.50"), true);
  // memory: the table keeps one list per address that was let in; the global cap bounds it at 120 new a minute
  assert.ok(lim.byIp.size <= 13);
});

// ---- the graduate crank on a list that is never read again ---------------------------------------------------

test("R12: the graduate crank sends again to a pool whose last call found it graduated already, as long as the list shows it open past its target (with the frozen list of the feed-lock finding: every pass, 5,000 lamports each)", () => {
  const A = key();
  const open = decodePool(A, new Uint8Array(poolBytes({ curveState: 1, virtualQuote: 30_000_000_000n, graduationTarget: 85_000_000_000n, reserveQuote: 86_000_000_000n })));
  const nowMs = Date.parse("2026-10-23T10:00:00Z");
  // the call before graduated it: two minutes of rest
  let plan = planGraduates([open], {}, { [A.toBase58()]: { lastOutcome: "graduated", lastAt: new Date(nowMs - 60_000).toISOString() } }, { nowMs });
  assert.equal(plan.send.length, 0); assert.equal(plan.recent.length, 1);
  plan = planGraduates([open], {}, { [A.toBase58()]: { lastOutcome: "graduated", lastAt: new Date(nowMs - GRADUATE_RESEND_MS - 1).toISOString() } }, { nowMs });
  assert.equal(plan.send.length, 1, "after two minutes the list still says open: sent again");
  // that call changes nothing on chain (outcome "already", no strike), and the next pass sends again
  plan = planGraduates([open], {}, { [A.toBase58()]: { lastOutcome: "already", lastAt: new Date(nowMs - 15_000).toISOString() } }, { nowMs });
  assert.equal(plan.send.length, 1, "an 'already' never rests the pool");
});

// ---- what a settle pass costs ------------------------------------------------------------------------------

test("R12: a settle pass costs 1 + 2 x ceil(H / 100) calls with H indexed tickets that hold pieces, whatever happened on the chain", async () => {
  const c = accountsChain(0);
  const cfgBytes = collectionConfig({ pool: POOL, unit: 10n });
  c.accounts.set(collectible.collectiblePda.cfg(POOL).toBase58(), { owner: HOOK, data: Buffer.from(cfgBytes), lamports: 1 });
  const idx = new TicketIndex({ file: null, log: quiet, now: () => 1_000_000 });
  const H = 1000;
  for (let i = 0; i < H; i++) { const u = key(); idx.add(POOL, u); c.accounts.set(collectible.collectiblePda.ticket(POOL, u).toBase58(), ticketAccount({ pool: POOL, user: u, minted: 1, owned: [key()] })); }
  c.calls = 0;
  const r = await idx.read(c.connection);
  await readUnbacked(c.connection, [POOL], { tickets: r.tickets });
  assert.equal(c.calls, 1 + 2 * Math.ceil(H / 100));
  const perMonth = c.calls * 6 * 60 * 24 * 30;
  assert.ok(perMonth > 5_000_000, `${c.calls} calls a pass, every SETTLE_INTERVAL_SECONDS (10 live): ${perMonth.toLocaleString("en-US")} request units a month for ${H} holders of pieces`);
});
