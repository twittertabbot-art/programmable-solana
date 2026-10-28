// The mint crank for the "Collectible per buy" template: a buy that earns NFTs needs ONE wallet approval.
//
// A buy decides its pieces by a block two slots after it (S + 2), so its NFTs cannot be minted inside the buy. A
// buy may pay their rent as a DEPOSIT instead: a plain SOL transfer from the buyer to its own ticket, in the buy
// transaction. Anyone may then send the permissionless `mint_for`, which mints the wallet's decided pieces into the
// WALLET and pays its sender back, out of that deposit, exactly what it spent plus KEEPER_FEE (10,000 lamports).
// This crank is that sender: the buyer signs once, and its NFTs land in its wallet a few seconds after the buy.
//
// How it finds the buys, with few RPC calls (the server's node is a paid plan):
//   - each pass, one getSignaturesForAddress on the collectible program for the signatures newer than the last one
//     it saw. Nothing new and nobody waiting: the pass ends there. That is the whole cost of a quiet chain.
//   - the new transactions in one batched read. A buy that earned pieces logs PiecesEarned { pool, user, pieces,
//     slot, target_slot }: that wallet joins the watch list.
//   - at the start and every MINT_SWEEP_SECONDS, one read of every ticket of the hook (fetchDepositTickets): the
//     tickets with pieces waiting AND a deposit join the watch list. That catches what the signature list missed:
//     the watcher was down, a deposit was sent on its own, more than 100 transactions came between two passes.
// While the list holds a wallet the passes come every MINT_FAST_MS: one getSlot, and one getMultipleAccountsInfo
// for the tickets whose deciding block is in, their configs and the coins that back their pieces.
//
// What it sends, for one wallet: one `mint_for` of every decided piece, up to four, and only when
//   - the deposit covers it to the lamport (the SDK's mintForCost, which matched the chain to the lamport),
//   - a simulation succeeds and shows the keeper's balance after the transaction, fee included, no lower than
//     before it.
// So the keeper is never out of pocket: a wallet that sold, withdrew or deposited too little costs it a
// simulation, no fee. A wallet whose pieces are not decided yet stays on the list and is tried again. A wallet
// that minted its pieces itself first is dropped with nothing sent (`mintedFirst`). The simulation and the
// preflight run against the newest state of the node ("processed"), so a wallet's own mint of a moment ago is
// seen. One race is left: a wallet that mints itself or withdraws its deposit in the very slots between the
// keeper's simulation and its landing makes the keeper's mint fail on chain. That costs the keeper one signature
// (5,000 lamports) and the wallet as much, and the site never does it (its buy carries the deposit and leaves the
// mint to the keeper).
//
// The top half is pure and tested offline. The MintCrank class reads the chain and sends; its connection, its
// transaction builder and its clock are injected, so the tests run it against a fake chain.
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { collectible, PROGRAMS } from "../../sdk/dist/index.js";
import { fetchTransactions } from "./feed.mjs";
import { confirmByPolling } from "./crank.mjs";
import { earnedFromLogs, depositUsedFromLogs, receivedFromLogs, touchesProgram } from "./events.mjs";

// The two event decoders live in lib/events.mjs (the feed reads them too); they stay reachable from here.
export { earnedFromLogs, depositUsedFromLogs };

const { BATCH, KEEPER_FEE, MAX_MINT_PER_CALL } = collectible;

/// Compute limit of one mint_for transaction. A mint of three pieces takes 84,000 to 100,000 units on the local
/// validator, and a mint_for of four pieces into a near-full ticket measures under 200,000 (review I2, round 9).
/// The limit matters because a priority fee is charged on the LIMIT, not on what the mint uses: at the SDK's
/// 400,000 the same fee per unit cost the keeper twice as much. 250,000 leaves a quarter over the largest mint.
export const MINT_COMPUTE_UNITS = 250_000;
/// The network fee of one signature.
export const SIGNATURE_LAMPORTS = 5000n;
/// The most a priority fee may add to a mint_for: the network fee plus it must stay under KEEPER_FEE, or the
/// keeper would pay to mint. 20,000 micro-lamports a unit at 250,000 units is 5,000 lamports.
export const MAX_MINT_PRICE_MICROLAMPORTS = Number(((KEEPER_FEE - SIGNATURE_LAMPORTS) * 1_000_000n) / BigInt(MINT_COMPUTE_UNITS));
/// The pause between two passes while a wallet waits: about one slot and a little.
export const MINT_FAST_MS = 500;
/// Signatures one pass asks for. More than this between two passes: the next pass sweeps every ticket.
export const MINT_SIGNATURES_PER_PASS = 100;
/// The most mint_for transactions one pass sends. More wallets than this wait for the next pass.
export const MINT_TX_PER_PASS = 10;
/// A wallet with a batch still undecided while another is decided waits this long for it, so that one mint_for
/// (one keeper fee out of its deposit) takes them all.
export const MINT_SETTLE_MS = 5000;
/// A wallet whose simulation fails this many times in a row for a reason the crank does not know rests. So does a
/// wallet whose mint failed on chain this many times.
export const MINT_STRIKES = 3;
/// After a refusal nothing explains, the next simulation of that wallet waits this long, times the strikes.
export const MINT_STRIKE_PAUSE_MS = 5000;
/// After a mint that failed on chain (it cost a fee), the next try of that wallet waits this long, then twice as long.
export const MINT_BACKOFF_MS = 30_000;
/// How long it rests. The sweep takes it again after that.
export const MINT_REST_MS = 600_000;
/// A wallet that has been on the list this long without anything to mint leaves it (the sweep takes it back
/// while it has pieces waiting and a deposit).
export const MINT_WATCH_MAX_MS = 900_000;
/// A transaction the RPC does not serve yet is asked for again at the next passes, this many times.
export const MINT_TX_TRIES = 5;
/// The most wallets on the list at once.
export const MINT_WATCH_MAX = 2000;

/// How many signatures handed in through POST /notify the crank remembers, so that one is fetched once.
export const MINT_NOTIFIED_KEEP = 2000;
/// A notified signature's transaction is read at most this many times (the RPC may serve a fresh one a moment late).
export const MINT_NOTIFY_READS = 2;
/// A notified signature whose status says only "processed" is asked again at most this many times.
export const MINT_NOTIFY_CHECKS = 3;
/// Notified signatures waiting at once, and so asked for in one getSignatureStatuses (its limit is 256). More are
/// refused until the queue drains: the feed and the poll find those buys by themselves.
export const MINT_NOTIFY_QUEUE_MAX = 256;
/// The most signatures of its own poll the crank waits on (listed, not served yet) at once; the oldest go first.
export const MINT_UNREAD_MAX = 1000;

const b58 = (k) => (typeof k === "string" ? k : k.toBase58());
const errMsg = (e) => (e && e.message ? e.message : String(e));
const oneLine = (s, max = 300) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max)}...` : t; };
const pcs = (n) => (n === 1 ? "1 piece" : `${n} pieces`);

/// One key per wallet and pool: the wallet's ticket.
export function mintKey(pool, user) { return `${b58(pool)}:${b58(user)}`; }

/// The newest target slot of the batches that still wait for their block at `slot`, or null when none does.
export function undecidedUntil(ticket, slot) {
  let last = null;
  for (const b of ticket.batches) {
    if (b.pieces === 0 || b.state !== BATCH.WAITING || BigInt(slot) > b.targetSlot) continue;
    if (last === null || b.targetSlot > last) last = b.targetSlot;
  }
  return last;
}

/// What the crank does for one wallet at `slot`. `info` is the ticket account as read (null: none), `cfg` the
/// decoded collection config, `backing` the coins that back the wallet's pieces (raw units, the SDK's backingOf),
/// `waitedMs` how long the wallet has been on the list. Answers { action, ... }:
///   gone       the wallet has no ticket
///   done       nothing waits on the ticket: minted (by the wallet or somebody else) or dropped
///   noDeposit  pieces wait but the ticket holds no deposit: the wallet mints them itself
///   wait       a deciding block is not in yet (untilSlot: the newest target slot that waits)
///   nothing    pieces wait but none is decided and none waits for a block: its coins no longer back them
///   short      the deposit does not cover the mint (need, deposit)
///   mint       send mint_for: n pieces, `accounts` asset addresses from index `first`, `cost` out of the deposit
export function mintDecision({ info, cfg, backing, slot, rent = collectible.STANDARD_RENT, waitedMs = 0 }) {
  if (!info || !info.data || info.data.length === 0) return { action: "gone" };
  let t;
  try { t = collectible.decodeTicket(new Uint8Array(info.data)); } catch { return { action: "gone" }; }
  const base = { ticket: t, minted: t.minted, deposit: collectible.depositOf(info.lamports, info.data.length, rent) };
  if (t.pending === 0) return { ...base, action: "done" };
  if (base.deposit === 0n) return { ...base, action: "noDeposit" };
  const { n } = collectible.mintForCount(t, BigInt(slot), BigInt(backing), cfg.unit);
  const until = undecidedUntil(t, slot);
  if (n === 0) return until !== null ? { ...base, action: "wait", untilSlot: until } : { ...base, action: "nothing" };
  // a batch is decided and another one still waits for its block: one mint takes them all a moment later
  if (until !== null && n < MAX_MINT_PER_CALL && waitedMs < MINT_SETTLE_MS) return { ...base, action: "wait", untilSlot: until };
  const cost = collectible.mintForCost(rent, cfg, info.data.length, t.owned.length, n);
  if (base.deposit < cost) return { ...base, action: "short", n, need: cost };
  return { ...base, action: "mint", n, first: t.minted, accounts: Math.min(MAX_MINT_PER_CALL, t.pending), cost };
}

/// The name of the program error in a failed simulation or transaction ("NothingToMint", "WrongAsset", ...), or
/// null. Anchor logs "Error Code: <Name>. Error Number: <n>."
export function mintErrorName(logs, err) {
  const text = [...(logs ?? []), err ? JSON.stringify(err) : ""].join("\n");
  const m = /Error Code: (\w+)\. Error Number: (\d+)/.exec(text);
  if (m) return m[1];
  if (/insufficient (funds|lamports)/i.test(text)) return "InsufficientFunds";
  return null;
}

/// What a refusal means for the wallet: `retry` at the next pass (the RPC's view lags, the wallet is minting
/// itself), `drop` (the deposit no longer covers it), `strike` (anything else: three in a row and it rests).
export function mintRefusal(name) {
  if (name === "NothingToMint" || name === "WrongAsset") return "retry";
  if (name === "DepositTooSmall" || name === "NoDeposit") return "drop";
  return "strike";
}

/// The network fee of one mint_for at a priority fee of `price` micro-lamports a compute unit.
export function mintFeeLamports(price = 0, units = MINT_COMPUTE_UNITS) {
  return SIGNATURE_LAMPORTS + (BigInt(units) * BigInt(price) + 999_999n) / 1_000_000n;
}

/// The compute limit, the priority fee when there is one, then mint_for.
export function mintInstructions(payer, item, price = 0) {
  const out = [ComputeBudgetProgram.setComputeUnitLimit({ units: MINT_COMPUTE_UNITS })];
  if (price > 0) out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  out.push(collectible.mintFor(payer, item.pool, item.user, item.first, item.accounts, item.coins));
  return out;
}

/// What a confirmed mint_for did, from its own transaction: the DepositUsed event (pieces, what the keeper was paid,
/// what the deposit holds after) and the keeper's balance before and after (the keeper pays the fee, so it is
/// account 0). null when there is no transaction to read.
export function mintEffect(meta) {
  if (!meta || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) return null;
  const used = depositUsedFromLogs(meta.logMessages)[0] ?? null;
  return {
    pieces: used ? used.pieces : 0, paidLamports: used ? Number(used.paid) : 0, leftLamports: used ? Number(used.left) : null,
    feeLamports: Number(meta.fee ?? 0), netLamports: Number(meta.postBalances[0]) - Number(meta.preBalances[0]), computeUnits: meta.computeUnitsConsumed ?? null,
  };
}

export const NO_MINT_TOTALS = () => ({ sent: 0, failed: 0, pieces: 0, paidLamports: 0, feeLamports: 0, netLamports: 0, mintedFirst: 0, short: 0, refused: 0, lastSlotsAfterBuy: null });

/// Add one pass to the running totals. `sent` counts confirmed mint_for transactions, `failed` the ones that were
/// sent and not confirmed, `pieces` the pieces minted into wallets, `paidLamports` what the deposits paid the
/// keeper back, `feeLamports` the network fees it paid, `netLamports` its balance change over all of them (never
/// below zero when everything works), `mintedFirst` the wallets that minted their pieces before the crank did,
/// `short` the wallets whose deposit did not cover the mint, `refused` simulations that failed.
export function addMintTotals(totals, pass) {
  const t = { ...NO_MINT_TOTALS(), ...(totals ?? {}) };
  for (const r of pass.results ?? []) {
    if (!r.signature) { t.failed += 1; continue; }
    t.sent += 1;
    if (r.effect) { t.pieces += r.effect.pieces; t.paidLamports += r.effect.paidLamports; t.feeLamports += r.effect.feeLamports; t.netLamports += r.effect.netLamports; }
    else t.pieces += r.n;
    if (r.slotsAfterBuy !== null && r.slotsAfterBuy !== undefined) t.lastSlotsAfterBuy = r.slotsAfterBuy;
  }
  t.mintedFirst += pass.mintedFirst ?? 0;
  t.short += pass.short ?? 0;
  t.refused += pass.refused ?? 0;
  return t;
}

/// The log line of one mint_for.
export function mintLine(r) {
  const head = `pool ${b58(r.pool)} wallet ${b58(r.user)}`;
  if (!r.signature) return `mint FAILED: ${head}: ${pcs(r.n)}: ${r.error}`;
  const after = r.slotsAfterBuy !== null && r.slotsAfterBuy !== undefined ? `, ${r.slotsAfterBuy} slots after the buy` : "";
  if (!r.effect) return `mint: ${head}: sent a mint of ${pcs(r.n)}${after}, the result could not be read, tx ${r.signature}`;
  const e = r.effect;
  return `mint: ${head}: minted ${pcs(e.pieces)} into the wallet${after}, paid back ${e.paidLamports} lamports from its deposit (${e.leftLamports ?? "?"} left), keeper ${e.netLamports >= 0 ? "+" : ""}${e.netLamports} lamports after the fee, tx ${r.signature}`;
}

// ---- network -------------------------------------------------------------------------------------

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/// AccountInfo | null for every key, in order, one getMultipleAccountsInfo per hundred.
async function readMany(connection, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")));
  return out;
}

/// The crank. One instance lives as long as the watcher; `pass()` is one round.
///   connection  the RPC
///   keeper      the keypair that signs and pays (the probe wallet)
///   buildTx     (payer, instructions) => { tx, lastValidBlockHeight }: the client's v0 builder with the lookup table
///   canSend     async () => boolean: the keeper can pay a fee now (the watcher's funding check)
///   isOwn       (signature) => boolean: a transaction this watcher sent itself, never read
///   pools       null for every pool, or the base58 addresses of the only pools to serve (--pool)
///   price       priority fee in micro-lamports a unit, at most MAX_MINT_PRICE_MICROLAMPORTS
///   sweepMs     time between two reads of every ticket
///   tickets     the ticket index (lib/tickets.mjs): the sweep then reads the indexed tickets by address instead of
///               the whole program, and every PiecesEarned or DepositUsed the crank sees names a ticket to it
export class MintCrank {
  constructor({ connection, keeper, buildTx, canSend = async () => true, isOwn = () => false, pools = null, price = 0, sweepMs = 300_000, log = null, now = () => Date.now(), rent = null, confirm = null, tickets = null }) {
    Object.assign(this, { connection, keeper, buildTx, canSend, isOwn, price, sweepMs, log, now, tickets });
    this.pools = pools ? new Set(pools.map(b58)) : null;
    this.rent = rent;
    this.confirm = confirm ?? ((signature, lastValidBlockHeight) => confirmByPolling(connection, signature, lastValidBlockHeight));
    this.cursor = null;        // the newest signature of the program seen
    this.headAt = null;        // when the program's newest signature was last read
    this.polled = false;
    this.sweptAt = null;
    this.sweepSoon = false;
    this.watch = new Map();    // mintKey -> { pool, user, since, buySlot, untilSlot, firstMinted, strikes, retries }
    this.rest = new Map();     // mintKey -> until (ms)
    this.unread = new Map();   // signature -> tries: listed by the poll, not served yet
    this.notified = new Set(); // signatures handed in through POST /notify (each taken once)
    this.queue = new Map();    // notified signature -> { checks, reads, at }: not looked at yet
    this.notifiedRead = new Set(); // notified signatures whose transaction was read: the poll does not read them again
    this.notifyInflight = null;
    this.notifyTotals = { passes: 0, statusCalls: 0, unknown: 0, failed: 0, reads: 0, found: 0 };
    this.mints = new Map();    // pool base58 -> { baseMint, tokenProgram }: never changes for a pool
    this.noted = new Map();    // mintKey -> deposit of the last "short" line, so it is said once
    this.sentSigs = new Set(); // the crank's own mint_for transactions: never read back by the poll
    this.handed = 0;           // wallets handed in by the feed or by /notify, in all
  }

  /// Buys the trades feed read (its PiecesEarned events: pool, user, pieces, slot, targetSlot): their wallets join
  /// the list at no cost in RPC calls, and their tickets join the index. Answers how many wallets were new.
  addEarned(events, nowMs = this.now()) {
    let added = 0;
    for (const ev of events ?? []) {
      if (!ev || !ev.pool || !ev.user || !(ev.pieces > 0)) continue;
      if (this.tickets) this.tickets.add(ev.pool, ev.user, new Date(nowMs).toISOString());
      if (this.add(ev.pool, ev.user, { buySlot: ev.slot ?? null, untilSlot: ev.targetSlot ?? null }, nowMs)) added += 1;
    }
    this.handed += added;
    return added;
  }

  /// A signature handed in through POST /notify (validated by the server) joins the queue that `readNotified`
  /// looks at: one getSignatureStatuses for the whole queue first, then the transaction, read at most
  /// MINT_NOTIFY_READS times, for a signature the chain knows. Its PiecesEarned are taken only if it is a transaction
  /// of the pool program. Nothing of the caller's is trusted but the signature itself, and nothing a caller sends
  /// ever makes the crank read every ticket. Answers { accepted, reason }.
  notify(signature, nowMs = this.now()) {
    if (typeof signature !== "string" || !signature) return { accepted: false, reason: "not a signature" };
    if (this.own(signature)) return { accepted: false, reason: "a transaction of this watcher" };
    if (this.notified.has(signature) || this.queue.has(signature) || this.unread.has(signature)) return { accepted: false, reason: "seen already" };
    if (this.queue.size >= MINT_NOTIFY_QUEUE_MAX) return { accepted: false, reason: "busy: too many notifications wait; the keeper finds the buy by itself" };
    this.notified.add(signature);
    while (this.notified.size > MINT_NOTIFIED_KEEP) this.notified.delete(this.notified.values().next().value);
    this.queue.set(signature, { checks: 0, reads: 0, at: nowMs });
    return { accepted: true, reason: null };
  }

  /// Are notified signatures waiting for a look?
  notifyPending() { return this.queue.size > 0; }

  /// One look at the notified signatures: one getSignatureStatuses for up to MINT_NOTIFY_QUEUE_MAX of them. A
  /// signature the node does not know, or whose transaction failed, is dropped at once, with no other call; one that
  /// is only "processed" is asked again (MINT_NOTIFY_CHECKS times at most); the confirmed ones are read in one batched
  /// call, each at most MINT_NOTIFY_READS times. When the status cannot be asked (the call failed), the
  /// transactions are read instead, within the same limit. A wallet found joins the list (`found`); a signature never
  /// asks for a sweep. Loops that ask at the same moment share one look. Never throws.
  async readNotified(nowMs = this.now(), out = null) {
    if (!this.notifyInflight) {
      this.notifyInflight = (async () => {
        try { return await this.lookAtNotified(nowMs); } finally { this.notifyInflight = null; }
      })();
    }
    const r = await this.notifyInflight;
    if (out) { out.found += r.found; out.transactions += r.transactions; out.notified = (out.notified ?? 0) + r.looked; }
    return r;
  }

  async lookAtNotified(nowMs) {
    const r = { looked: 0, statusCall: false, unknown: 0, failed: 0, read: 0, transactions: 0, found: 0, left: 0 };
    if (!this.queue.size) return r;
    const batch = [...this.queue.keys()].slice(0, MINT_NOTIFY_QUEUE_MAX);
    r.looked = batch.length;
    this.notifyTotals.passes += 1;
    let statuses = null;
    try {
      const got = await this.connection.getSignatureStatuses(batch);
      statuses = got && Array.isArray(got.value) ? got.value : null;
      r.statusCall = true; this.notifyTotals.statusCalls += 1;
    } catch (e) {
      statuses = null;
      if (this.log) this.log.debug(`mint: the status of ${batch.length} notified signatures could not be asked (${oneLine(errMsg(e))}): their transactions are read instead`);
    }
    const fetch = [];
    batch.forEach((s, i) => {
      const q = this.queue.get(s);
      if (!q) return;
      if (statuses) {
        q.checks += 1;
        const st = statuses[i];
        // unknown to the node: a signature of nothing (or of a transaction this node never saw): dropped, no read
        if (!st) { this.queue.delete(s); r.unknown += 1; return; }
        if (st.err) { this.queue.delete(s); r.failed += 1; return; }
        if (st.confirmationStatus !== "confirmed" && st.confirmationStatus !== "finalized") { if (q.checks >= MINT_NOTIFY_CHECKS) this.queue.delete(s); return; }
      }
      fetch.push(s);
    });
    if (fetch.length) {
      let got = null;
      try { got = await fetchTransactions(this.connection, fetch, { pauseMs: 0 }); } catch (e) { if (this.log) this.log.debug(`mint: ${fetch.length} notified transactions could not be read (${oneLine(errMsg(e))})`); }
      for (const s of fetch) {
        const q = this.queue.get(s);
        if (!q) continue;
        q.reads += 1; r.read += 1;
        const tx = got ? got.txs.get(s) : null;
        if (!tx) { if ((got && got.unreadable.has(s)) || q.reads >= MINT_NOTIFY_READS) this.queue.delete(s); continue; }
        this.queue.delete(s);
        this.notifiedRead.add(s);
        while (this.notifiedRead.size > MINT_NOTIFIED_KEEP) this.notifiedRead.delete(this.notifiedRead.values().next().value);
        r.transactions += 1;
        r.found += this.takeTransaction(s, tx, nowMs, { notified: true });
      }
    }
    r.left = this.queue.size;
    this.handed += r.found;
    this.notifyTotals.unknown += r.unknown; this.notifyTotals.failed += r.failed; this.notifyTotals.reads += r.read; this.notifyTotals.found += r.found;
    return r;
  }

  /// What one transaction of the collectible program (or a notified one) gives: the tickets its events name join
  /// the index, and the wallets whose buys earned pieces join the list. A notified transaction must be one of the
  /// pool program (a buy): anything else adds nothing. Answers how many wallets were new on the list.
  takeTransaction(signature, tx, nowMs, { notified = false } = {}) {
    if (!tx || (tx.meta && tx.meta.err)) return 0;
    if (notified && touchesProgram(tx, PROGRAMS.hookpool) === false) { if (this.log) this.log.debug(`mint: notified transaction ${signature} is not a transaction of the pool program, ignored`); return 0; }
    const logs = tx.meta ? tx.meta.logMessages : [];
    const earned = earnedFromLogs(logs);
    if (this.tickets) {
      const iso = new Date(nowMs).toISOString();
      const slot = Number.isFinite(tx.slot) ? BigInt(tx.slot) : null;
      this.tickets.addFromEvents(earned, iso);
      this.tickets.addFromEvents(depositUsedFromLogs(logs).map((e) => ({ ...e, slot })), iso);
      this.tickets.addFromEvents(receivedFromLogs(logs).map((e) => ({ ...e, slot })), iso);
    }
    let found = 0;
    for (const ev of earned) if (ev.pieces > 0 && this.add(ev.pool, ev.user, { buySlot: ev.slot, untilSlot: ev.targetSlot }, nowMs)) found += 1;
    return found;
  }

  own(signature) { return this.sentSigs.has(signature) || this.isOwn(signature); }
  remember(signature) {
    this.sentSigs.add(signature);
    if (this.sentSigs.size > 500) this.sentSigs.delete(this.sentSigs.values().next().value);
  }

  /// The program's newest signature and when it was read, for the upkeep crank's quiet check.
  head() { return { signature: this.cursor, at: this.headAt }; }

  serves(pool) { return !this.pools || this.pools.has(b58(pool)); }

  /// Put a wallet on the list. `buySlot`: the slot of the buy that earned the pieces, when known.
  add(pool, user, { buySlot = null, untilSlot = null } = {}, nowMs = this.now()) {
    const key = mintKey(pool, user);
    if (!this.serves(pool)) return false;
    const rest = this.rest.get(key);
    if (rest !== undefined && rest > nowMs) return false;
    const was = this.watch.get(key);
    if (was) {
      if (buySlot !== null) was.buySlot = buySlot;
      if (untilSlot !== null && (was.untilSlot === null || untilSlot > was.untilSlot)) was.untilSlot = untilSlot;
      return false;
    }
    if (this.watch.size >= MINT_WATCH_MAX) return false;
    this.watch.set(key, { key, pool: new PublicKey(b58(pool)), user: new PublicKey(b58(user)), since: nowMs, buySlot, untilSlot, firstMinted: null, strikes: 0, retries: 0 });
    return true;
  }

  /// The chain's rent, read once (two calls) and kept. Never the local validator's constant: on mainnet it would
  /// read every deposit 891,120 lamports short and price every mint 1,880 lamports a byte too high, so the keeper
  /// would leave valid mints undone. A read that fails ends the pass, which is tried again at the next interval.
  async rentFn() {
    if (this.rent) return this.rent;
    this.rent = await collectible.rentFrom(this.connection);
    return this.rent;
  }

  /// Every ticket with pieces waiting and a deposit joins the list. With the ticket index, the indexed tickets are
  /// read by address (one call per hundred); without it, every ticket of the program in one getProgramAccounts.
  async sweep(nowMs) {
    this.sweptAt = nowMs; this.sweepSoon = false;
    const rent = await this.rentFn();
    let list;
    if (this.tickets) {
      const r = await this.tickets.read(this.connection);
      list = [];
      for (const x of r.items) {
        const deposit = collectible.depositOf(x.info.lamports, x.info.data.length, rent);
        if (x.ticket.pending > 0 && deposit > 0n) list.push(x);
      }
    } else {
      const pools = this.pools && this.pools.size === 1 ? [...this.pools] : null;
      list = await collectible.fetchDepositTickets(this.connection, pools ? new PublicKey(pools[0]) : undefined, rent);
    }
    let added = 0;
    for (const x of list) if (this.add(x.ticket.pool, x.ticket.user, {}, nowMs)) added += 1;
    return { tickets: list.length, added };
  }

  /// The program's signatures since the last pass, and the buys among them that earned pieces.
  async poll(nowMs, out) {
    const first = !this.polled;
    let sigs;
    try {
      sigs = await this.connection.getSignaturesForAddress(PROGRAMS.hook_collectible, this.cursor ? { until: this.cursor, limit: MINT_SIGNATURES_PER_PASS } : { limit: 1 }, "confirmed");
    } catch (e) {
      // the RPC no longer knows the signature the cursor points at (a node with a short history, a node of a
      // load-balanced endpoint that lags): the cursor is dropped, the next poll sets it again, and a sweep of the
      // indexed tickets fills what the gap may hold; without this, every poll would fail the same way for good
      if (this.cursor && /not found/i.test(errMsg(e))) {
        if (this.log) this.log.warn(`mint: the RPC does not know the poll's cursor ${this.cursor} any more (${oneLine(errMsg(e))}): starting the poll again from the newest signature, the tickets are swept`);
        this.cursor = null; this.polled = false; this.sweepSoon = true;
        return;
      }
      throw e;
    }
    this.polled = true;
    this.headAt = nowMs;
    if (sigs.length) this.cursor = sigs[0].signature;
    // the first answer only sets the cursor: what came before it is the start sweep's
    if (first) return;
    out.signatures = sigs.length;
    if (sigs.length >= MINT_SIGNATURES_PER_PASS) this.sweepSoon = true;
    // a transaction read already through /notify is not read again
    const fresh = sigs.filter((s) => !s.err && !this.own(s.signature) && !this.notifiedRead.has(s.signature)).map((s) => s.signature).reverse();
    const wanted = [...new Set([...this.unread.keys(), ...fresh])];
    if (!wanted.length) return;
    const { txs, unreadable } = await fetchTransactions(this.connection, wanted, { pauseMs: 0 });
    for (const s of wanted) {
      const tx = txs.get(s);
      if (!tx) {
        if (unreadable.has(s)) { this.unread.delete(s); continue; }
        const tries = (this.unread.get(s) ?? 0) + 1;
        if (tries >= MINT_TX_TRIES) { this.unread.delete(s); this.sweepSoon = true; } else this.unread.set(s, tries);
        continue;
      }
      this.unread.delete(s);
      out.transactions += 1;
      out.found += this.takeTransaction(s, tx, nowMs);
    }
    // the list of signatures waiting to be served stays bounded: the oldest are let go (the sweep covers them)
    if (this.unread.size > MINT_UNREAD_MAX) {
      while (this.unread.size > MINT_UNREAD_MAX) this.unread.delete(this.unread.keys().next().value);
      this.sweepSoon = true;
    }
  }

  /// One round: sweep when due, read the new signatures, then mint for the wallets whose pieces are decided.
  async pass() {
    const t0 = this.now();
    const out = { at: null, swept: false, signatures: 0, transactions: 0, found: 0, watching: 0, read: 0, waiting: 0, sent: 0, failed: 0, pieces: 0, mintedFirst: 0, short: 0, refused: 0, noDeposit: 0, results: [] };
    if (this.sweptAt === null || this.sweepSoon || t0 - this.sweptAt >= this.sweepMs) {
      const s = await this.sweep(t0);
      out.swept = true; out.found += s.added;
    }
    // the signatures handed in through /notify that wait for a look (one status call for all of them)
    if (this.queue.size) await this.readNotified(t0, out);
    await this.poll(t0, out);
    for (const [k, until] of this.rest) if (until <= t0) this.rest.delete(k);
    if (!this.watch.size) { out.at = new Date(this.now()).toISOString(); return out; }
    const slot = BigInt(await this.connection.getSlot("confirmed"));
    out.slot = Number(slot);
    // only the wallets whose deciding block is in, or that never said which block decides them
    const due = [...this.watch.values()].filter((e) => (e.untilSlot === null || slot > e.untilSlot) && !(e.notBefore > t0));
    out.waiting = this.watch.size - due.length;
    if (due.length) await this.serve(due, slot, t0, out);
    out.watching = this.watch.size;
    out.at = new Date(this.now()).toISOString();
    return out;
  }

  /// Read the due wallets' tickets, coins and configs in one call (two for a pool seen for the first time),
  /// decide, and send.
  async serve(due, slot, t0, out) {
    const rent = await this.rentFn();
    const poolKeys = [...new Set(due.map((e) => b58(e.pool)))];
    // a pool seen for the first time: its config first, for the coin's mint and token program
    const unknown = poolKeys.filter((p) => !this.mints.has(p));
    if (unknown.length) {
      const infos = await readMany(this.connection, unknown.map((p) => collectible.collectiblePda.cfg(new PublicKey(p))));
      unknown.forEach((p, i) => {
        if (!infos[i]) return;
        try { const c = collectible.decodeCollectionConfig(new Uint8Array(infos[i].data)); this.mints.set(p, { baseMint: c.baseMint, tokenProgram: c.tokenProgram }); } catch { /* not a config */ }
      });
    }
    const known = due.filter((e) => this.mints.has(b58(e.pool)));
    for (const e of due) if (!this.mints.has(b58(e.pool))) this.watch.delete(e.key);
    if (!known.length) return;
    const pools = [...new Set(known.map((e) => b58(e.pool)))];
    const coinsOf = (e) => { const m = this.mints.get(b58(e.pool)); return collectible.coinsAddress(e.user, m.baseMint, m.tokenProgram); };
    const keys = [
      ...known.map((e) => collectible.collectiblePda.ticket(e.pool, e.user)),
      ...known.map(coinsOf),
      ...pools.map((p) => collectible.collectiblePda.cfg(new PublicKey(p))),
    ];
    const infos = await readMany(this.connection, keys);
    out.read += known.length;
    const cfgs = new Map();
    pools.forEach((p, i) => {
      const info = infos[2 * known.length + i];
      if (info) { try { cfgs.set(p, collectible.decodeCollectionConfig(new Uint8Array(info.data))); } catch { /* not a config */ } }
    });
    const plan = [];
    known.forEach((e, i) => {
      const cfg = cfgs.get(b58(e.pool));
      if (!cfg) { this.watch.delete(e.key); return; }
      const m = this.mints.get(b58(e.pool));
      const backing = collectible.backingOf(infos[known.length + i], e.user, m.baseMint, m.tokenProgram);
      const d = mintDecision({ info: infos[i], cfg, backing, slot, rent, waitedMs: t0 - e.since });
      if (e.firstMinted === null && d.minted !== undefined) e.firstMinted = d.minted;
      this.decided(e, d, t0, out, { cfg, coins: keys[known.length + i], plan });
    });
    if (!plan.length) return;
    if (!(await this.canSend())) {
      if (this.log) this.log.error(`mint: ${plan.length} wallets have pieces to mint but the keeper wallet ${this.keeper.publicKey.toBase58()} cannot pay the fee`);
      return;
    }
    for (const item of plan.slice(0, MINT_TX_PER_PASS)) await this.mintOne(item, out);
  }

  /// What a decision does to the list.
  decided(e, d, t0, out, { coins, plan }) {
    const drop = () => { this.watch.delete(e.key); this.noted.delete(e.key); };
    switch (d.action) {
      case "gone": drop(); return;
      case "done":
        // the ticket's counter moved and the crank did not send it: somebody minted first, most likely the wallet
        if (e.firstMinted !== null && d.minted > e.firstMinted && !e.mintedByUs) { out.mintedFirst += 1; if (this.log) this.log.info(`mint: pool ${b58(e.pool)} wallet ${b58(e.user)}: its pieces were minted before the keeper got to them, nothing sent`); }
        drop(); return;
      case "noDeposit": out.noDeposit += 1; drop(); return;
      case "nothing": drop(); return;
      case "wait":
        e.untilSlot = d.untilSlot;
        if (t0 - e.since > MINT_WATCH_MAX_MS) drop();
        return;
      case "short": {
        out.short += 1;
        if (this.log && this.noted.get(e.key) !== d.deposit) this.log.info(`mint: pool ${b58(e.pool)} wallet ${b58(e.user)}: ${pcs(d.n)} decided, the deposit holds ${d.deposit} lamports and the mint needs ${d.need}: nothing sent, the wallet mints them itself`);
        this.watch.delete(e.key); this.noted.set(e.key, d.deposit);
        return;
      }
      case "mint":
        e.untilSlot = null;
        plan.push({ entry: e, pool: e.pool, user: e.user, n: d.n, first: d.first, accounts: d.accounts, coins, cost: d.cost, deposit: d.deposit });
        return;
      default: drop();
    }
  }

  /// Simulate one mint_for, send it when the simulation succeeds and the keeper ends no poorer, read what it did.
  async mintOne(item, out) {
    const e = item.entry;
    const kp = this.keeper;
    let built;
    try {
      built = await this.buildTx(kp.publicKey, mintInstructions(kp.publicKey, item, this.price));
      built.tx.sign([kp]);
    } catch (err) { this.strike(e, `the transaction could not be built: ${oneLine(errMsg(err))}`, out); return; }
    let pre; let sim;
    try {
      // against the newest state the node has ("processed"): a wallet that minted itself a moment ago is seen,
      // and the mint is not sent into a sure failure
      pre = BigInt(await this.connection.getBalance(kp.publicKey, "processed"));
      // the keeper pays the NFTs first and is paid back at the end of the same transaction: it must hold that much
      const upfront = item.cost + mintFeeLamports(this.price);
      if (pre < upfront) {
        out.refused += 1;
        e.notBefore = this.now() + MINT_BACKOFF_MS;
        if (this.log) this.log.error(`mint: the keeper wallet ${kp.publicKey.toBase58()} holds ${pre} lamports; a mint of ${pcs(item.n)} needs ${upfront} up front, paid back in the same transaction. Fund it. Nothing sent for wallet ${b58(e.user)}`);
        return;
      }
      sim = await this.connection.simulateTransaction(built.tx, { sigVerify: false, commitment: "processed", accounts: { encoding: "base64", addresses: [kp.publicKey.toBase58()] } });
    } catch (err) { if (this.log) this.log.warn(`mint: pool ${b58(e.pool)} wallet ${b58(e.user)}: the simulation could not run (${oneLine(errMsg(err))}), tried again next pass`); return; }
    const v = sim && sim.value ? sim.value : {};
    if (v.err) {
      out.refused += 1;
      const name = mintErrorName(v.logs, v.err);
      const what = mintRefusal(name);
      const why = `the simulation refused it (${name ?? oneLine(JSON.stringify(v.err))})`;
      if (what === "retry") {
        e.retries += 1;
        if (e.retries > 20) { this.strike(e, why, out); return; }
        if (this.log) this.log.debug(`mint: pool ${b58(e.pool)} wallet ${b58(e.user)}: ${why}, tried again next pass`);
      } else if (what === "drop") {
        out.short += 1;
        if (this.log) this.log.info(`mint: pool ${b58(e.pool)} wallet ${b58(e.user)}: ${why}, nothing sent`);
        this.watch.delete(e.key);
      } else this.strike(e, why, out);
      return;
    }
    const post = v.accounts && v.accounts[0] && Number.isFinite(Number(v.accounts[0].lamports)) ? BigInt(v.accounts[0].lamports) : null;
    if (post === null || post < pre) {
      out.refused += 1;
      this.strike(e, post === null ? "the simulation did not show the keeper's balance after it" : `the simulation shows the keeper ${pre - post} lamports poorer after it`, out);
      return;
    }
    let signature = null;
    try {
      signature = await this.connection.sendTransaction(built.tx, { skipPreflight: false, preflightCommitment: "processed", maxRetries: 3 });
    } catch (err) {
      // the node's own simulation before sending refused it: nothing landed, no fee
      out.refused += 1;
      const name = mintErrorName(err && err.logs, err && err.message);
      if (mintRefusal(name) === "retry") { e.retries += 1; if (this.log) this.log.debug(`mint: pool ${b58(e.pool)} wallet ${b58(e.user)}: the node refused it before sending (${name}), tried again next pass`); }
      else this.strike(e, `the node refused it before sending (${name ?? oneLine(errMsg(err))})`, out);
      return;
    }
    try {
      this.remember(signature);
      await this.confirm(signature, built.lastValidBlockHeight);
    } catch (err) {
      const r = { pool: e.pool, user: e.user, n: item.n, signature: null, effect: null, error: oneLine(errMsg(err)) + (signature ? ` (tx ${signature})` : "") };
      out.results.push(r); out.failed += 1;
      if (this.log) this.log.warn(mintLine(r));
      // a mint that failed on chain cost a fee: the wallet waits before the next try (30 s, then 60 s), and
      // rests after the third
      e.strikes += 1;
      e.notBefore = this.now() + MINT_BACKOFF_MS * 2 ** (e.strikes - 1);
      if (e.strikes >= MINT_STRIKES) { this.watch.delete(e.key); this.rest.set(e.key, this.now() + MINT_REST_MS); }
      return;
    }
    e.mintedByUs = true;
    e.firstMinted = e.firstMinted === null ? null : e.firstMinted + item.n;
    let effect = null; let txSlot = null;
    for (let n = 0; n < 5 && !effect; n++) {
      try {
        const tx = await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        if (tx && tx.meta) { effect = mintEffect(tx.meta); txSlot = tx.slot ?? null; }
      } catch { /* tried again */ }
      if (!effect) await pause(300);
    }
    const r = {
      pool: e.pool, user: e.user, n: item.n, signature, effect, error: null,
      slotsAfterBuy: e.buySlot !== null && txSlot !== null ? Number(BigInt(txSlot) - BigInt(e.buySlot)) : null,
    };
    out.results.push(r); out.sent += 1; out.pieces += effect ? effect.pieces : item.n;
    if (this.log) this.log.info(mintLine(r));
    // the wallet stays on the list: more than four pieces, or another buy in the meantime, mint at the next pass
    e.strikes = 0; e.retries = 0; e.since = this.now();
  }

  strike(e, why, out) {
    e.strikes += 1;
    // a refusal nothing explains: the next simulation waits a little, longer each time
    e.notBefore = this.now() + MINT_STRIKE_PAUSE_MS * e.strikes;
    if (this.log) this.log.warn(`mint: pool ${b58(e.pool)} wallet ${b58(e.user)}: ${why}${e.strikes >= MINT_STRIKES ? `; ${MINT_STRIKES} times in a row, it rests for ${MINT_REST_MS / 60000} minutes` : `, tried again in ${(MINT_STRIKE_PAUSE_MS * e.strikes) / 1000} s`}`);
    if (e.strikes >= MINT_STRIKES) { this.watch.delete(e.key); this.rest.set(e.key, this.now() + MINT_REST_MS); out.rested = (out.rested ?? 0) + 1; }
  }
}
