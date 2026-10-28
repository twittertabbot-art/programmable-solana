// The burn keeper: the crank that runs the buy-and-burn of buyback pools and of rules pools.
//
// Two templates collect a share of every trade to buy the coin back and burn it. A buyback pool keeps it in a
// treasury, a rules pool in its burn pot. The buy is an instruction anyone may send: `execute_buyback` or
// `run_burn`. The programs guard it (HOOKS.md section 7): a call buys only against an observation of the pool
// that an earlier call recorded at least 25 slots before, only while the price has not run above that
// observation, and only a slice of the pool's quote reserve at a time. So one call never empties a pot, and a
// pot that nobody runs keeps growing. What can be taken from a burn by a pump that stands in the pool for 25
// slots is never more than the pot. Small pots are what makes the rule safe, and small pots need somebody who
// calls regularly. This crank is that somebody.
//
// For every pool with something to spend it asks the SDK what a call would do now (`buybackInstructions`,
// `rulesBurnInstructions`):
//   observe   no observation yet: the call records the pool and buys nothing. Sent.
//   wait      the price is above the observation by more than the tolerance: the call records the pool again
//             and buys nothing, so that the next call can buy. Sent.
//   buy       the call buys and burns. Sent, with the SDK's floor for what the buy must give.
//   tooSoon   the observation is less than 25 slots old: the chain would refuse a call. Skipped.
// One transaction per pool per pass, signed and paid by the keeper wallet. Nothing comes back to the keeper:
// a call costs its fee and earns nothing.
//
// The top half is pure and tested offline. The bottom half reads the chain and sends the transactions.
import {
  PROGRAMS, BURN_INTERVAL_SLOTS, BURN_OUTCOME, burnStep, buybackCapBps, rulesBurnCapBps, rulesSettle, decodeBuybackConfig, decodeRulesConfig, decodeTokenAmount,
  eventsFromTransaction, pda, ix, ACCOUNT_DISC, RULES_KIND, TOKEN_2022_PROGRAM, decodeHolderRecord,
} from "../../sdk/dist/index.js";
import { getMany } from "./chain.mjs";
import { confirmByPolling } from "./crank.mjs";

/// A call that fails this many passes in a row on the same pool raises one alert.
export const BURN_STRIKES = 3;
/// After that alert the pool is tried again only once in this many passes.
export const BURN_RETRY_ROUNDS = 30;
/// One signature per call.
export const BURN_FEE_LAMPORTS = 5000;
export const BURN_KINDS = ["buyback", "rules"];
const OUR_PROGRAMS = Object.values(PROGRAMS).map((p) => p.toBase58());
const OUTCOME_NAME = { [BURN_OUTCOME.OBSERVED]: "observed", [BURN_OUTCOME.WAITED]: "waited", [BURN_OUTCOME.BOUGHT]: "bought" };

const b58 = (k) => (typeof k === "string" ? k : k.toBase58());
const errMsg = (e) => (e && e.message ? e.message : String(e));
const oneLine = (s, max = 300) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max)}...` : t; };
const big = (v) => (typeof v === "bigint" ? v : BigInt(v ?? 0));

// ---- pure part -------------------------------------------------------------------------------------

/// Which of the two buy-and-burn templates a pool runs, or null.
export function burnKind(pool) {
  if (!pool || !pool.hasHook) return null;
  if (pool.hookProgram.equals(PROGRAMS.hook_buyback)) return "buyback";
  if (PROGRAMS.hook_rules && pool.hookProgram.equals(PROGRAMS.hook_rules)) return "rules";
  return null;
}

/// What waits to be spent on a pool, from raw account bytes.
///   buyback  the balance of the hook's treasury. Nothing while it is zero or under the coin's own minimum
///            (`minQuote`): the program refuses a call then.
///   rules    the burn pot after the settlement the program runs first: the stored pot plus the burn share
///            of the last trade's fee (the numbers in the account are one trade behind).
/// Returns { pot, held, cfg }, or null when the config cannot be read. `pot` is what a call may spend from;
/// `held` is what is there, which differs only for a buyback treasury under its minimum.
export function burnPot({ kind, pool, cfgBytes, treasuryBytes }) {
  if (!cfgBytes) return null;
  try {
    if (kind === "buyback") {
      const cfg = decodeBuybackConfig(cfgBytes);
      const treasury = treasuryBytes && treasuryBytes.length >= 72 ? decodeTokenAmount(treasuryBytes) : 0n;
      return { pot: treasury === 0n || treasury < cfg.minQuote ? 0n : treasury, held: treasury, cfg };
    }
    if (kind === "rules") {
      const cfg = decodeRulesConfig(cfgBytes);
      const pot = rulesSettle(cfg, pool).burnPot;
      return { pot, held: pot, cfg };
    }
  } catch { return null; }
  return null;
}

/// The burn of one pool for the status file: what waits, the cap of one buy, what a call sent at `slot` would
/// do, when the pool was last observed and from which slot the chain takes the next call. On a pool on the curve
/// the programs compare prices and depths on the effective quote, `reserveQuote + virtualQuote`, and store the
/// observation that way (CURVE-CHANGES.md section 4): the step here is worked out the same way.
export function burnView({ kind, pool, platform, cfg, pot, slot }) {
  const capBps = kind === "buyback" ? buybackCapBps(cfg, platform, pool.lpFeeBps) : rulesBurnCapBps(cfg, platform, pool.lpFeeBps);
  const obs = { slot: cfg.obsSlot, reserveBase: cfg.obsReserveBase, reserveQuote: cfg.obsReserveQuote };
  const none = obs.reserveBase === 0n || obs.reserveQuote === 0n;
  const effectiveQuote = pool.reserveQuote + (pool.virtualQuote ?? 0n);
  const step = pot === 0n || slot === null || slot === undefined ? "nothing" : burnStep(obs, pool.reserveBase, effectiveQuote, BigInt(slot), capBps, pot).step;
  return { pot, capBps, step, observedAtSlot: none ? null : obs.slot, nextCallAtSlot: none ? null : obs.slot + BURN_INTERVAL_SLOTS };
}

/// The keeper's decision for one pool. `run` is what the SDK's `buybackInstructions` or
/// `rulesBurnInstructions` answered: null when there is nothing to spend, otherwise the step a call sent now
/// would take and the instructions for it.
///   send false, why "nothing"   nothing to spend
///   send false, why "small"     less in the pot than the keeper's minimum: a call would cost more than it is worth
///   send false, why "tooSoon"   the observation is younger than 25 slots: the chain would refuse the call
///   send true,  why "observe" | "wait" | "buy"
export function burnDecision(run, { minPot = 0n } = {}) {
  if (!run || big(run.pot) === 0n) return { send: false, why: "nothing" };
  if (big(run.pot) < big(minPot)) return { send: false, why: "small" };
  // not due: the observation is younger than 25 slots, or (the SDK's `reason`) the pot is so small that the
  // pool would refuse the buy; the call waits for more fees either way
  if (run.step === "tooSoon" || run.due === false || !Array.isArray(run.instructions) || run.instructions.length === 0) return { send: false, why: "tooSoon", dueSlot: run.dueSlot, reason: run.reason ?? null };
  if (run.step === "observe" || run.step === "wait" || run.step === "buy") return { send: true, why: run.step };
  return { send: false, why: "nothing" };
}

/// What a burn pass sends. `candidates` are pools with their SDK answer: { key, pool, kind, run }. One call
/// per pool. Pools that rest after their alert are left out (`resting`). Pools whose call failed before go
/// after the others, and among equals the larger pot goes first. At most `maxCalls` go out (`send`); the
/// others wait for the next pass (`later`). `keys` names every pool that has something to spend, sent or not.
export function planBurns(candidates, fails = {}, { maxCalls = 10, minPot = 0n } = {}) {
  const ready = []; const resting = []; const tooSoon = []; const keys = [];
  for (const c of candidates) {
    const d = burnDecision(c.run, { minPot });
    if (d.why === "nothing" || d.why === "small") continue;
    keys.push(c.key);
    if (!d.send) { tooSoon.push({ ...c, dueSlot: d.dueSlot, reason: d.reason ?? null }); continue; }
    const item = { ...c, step: d.why, pot: big(c.run.pot) };
    const f = fails ? fails[c.key] : undefined;
    if (f && f.skip > 0) resting.push(item); else ready.push(item);
  }
  const strikes = (it) => (fails && fails[it.key] ? fails[it.key].count : 0);
  ready.sort((a, b) => strikes(a) - strikes(b) || (a.pot > b.pot ? -1 : a.pot < b.pot ? 1 : 0));
  return { keys, send: ready.slice(0, maxCalls), later: ready.slice(maxCalls), tooSoon, resting };
}

/// What a confirmed call did, as the chain reported it: the event the program emitted (`BuybackExecuted` or
/// `BurnExecuted`, an inner instruction), or else the 17 bytes of return data (outcome, quote spent, coins
/// burned). `tx` is what getTransaction returns. null when there is no transaction or it says neither.
export function burnEffect(tx) {
  if (!tx || !tx.meta) return null;
  const feeLamports = Number(tx.meta.fee ?? 0);
  const computeUnits = tx.meta.computeUnitsConsumed ?? null;
  let ev = null;
  try { ev = eventsFromTransaction(tx, OUR_PROGRAMS).find((e) => e.kind === "BuybackExecuted" || e.kind === "BurnExecuted") ?? null; } catch { ev = null; }
  if (ev && OUTCOME_NAME[ev.outcome]) {
    return { outcome: OUTCOME_NAME[ev.outcome], quoteSpent: ev.quoteSpent, baseBurned: ev.baseBurned, slot: ev.slot, feeLamports, computeUnits, from: "event" };
  }
  const rd = tx.meta.returnData;
  if (rd && rd.data && rd.data[0] && (rd.programId === PROGRAMS.hook_buyback.toBase58() || rd.programId === PROGRAMS.hook_rules.toBase58())) {
    const bytes = Buffer.from(rd.data[0], "base64");
    if (bytes.length >= 17 && OUTCOME_NAME[bytes[0]]) {
      return { outcome: OUTCOME_NAME[bytes[0]], quoteSpent: bytes.readBigUInt64LE(1), baseBurned: bytes.readBigUInt64LE(9), slot: tx.slot === undefined ? null : BigInt(tx.slot), feeLamports, computeUnits, from: "return data" };
    }
  }
  return null;
}

/// The error of a call the chain refused, with the program's own name for it when the logs carry one.
export function chainError(e) {
  const text = `${errMsg(e)} ${Array.isArray(e && e.logs) ? e.logs.join(" ") : ""}`.trim();
  const m = /Error Code: ([A-Za-z0-9_]+)\. Error Number: (\d+)\. Error Message: ([^"\]]*?)\.?(?:"|,|\]|$)/.exec(text);
  if (m) return oneLine(`${m[1]} (${m[2]}): ${m[3]}`);
  return oneLine(errMsg(e));
}

/// Send the planned calls one after the other, one transaction each. A call that fails is recorded and the
/// pass moves on: one bad pool never holds back the others. `send` and `readEffect` are injectable for the
/// tests.
export async function burnAll({ plan, send, readEffect }) {
  const results = [];
  for (const item of plan) {
    try {
      const signature = await send(item);
      let effect = null;
      try { effect = await readEffect(signature); } catch { effect = null; }
      results.push({ ...item, signature, effect, ok: true, error: null });
    } catch (e) {
      results.push({ ...item, signature: null, effect: null, ok: false, error: chainError(e) });
    }
  }
  return results;
}

/// The line of a pool that was not called this pass: the observation is too young, or the SDK says why a call
/// is not due (a pot too small to buy anything).
export function burnSkipLine(t) {
  const head = `pool ${b58(t.pool.address ?? t.pool)} (${t.kind})`;
  if (t.reason) return `burn: ${head}: not due: ${t.reason}; nothing sent`;
  return `burn: ${head}: too soon, the chain takes the next call from slot ${t.dueSlot} (now ${t.run.slot}); nothing sent`;
}

/// The log line of one call, with the outcome the chain reported.
export function burnLine(r) {
  const head = `pool ${b58(r.pool.address ?? r.pool)} (${r.kind})`;
  if (!r.signature) return `burn FAILED: ${head}: a call expected to ${r.step} was not confirmed: ${r.error}`;
  if (!r.effect) return `burn: ${head}: sent a call expected to ${r.step}, the result could not be read, tx ${r.signature}`;
  const e = r.effect;
  const next = e.slot === null || e.slot === undefined ? "" : `, next call from slot ${big(e.slot) + BURN_INTERVAL_SLOTS}`;
  if (e.outcome === "bought") {
    const left = r.pot > e.quoteSpent ? r.pot - e.quoteSpent : 0n;
    return `burn: ${head}: bought, spent ${e.quoteSpent} lamports, burned ${e.baseBurned} raw coins, ${left} lamports left in the pot${next}, tx ${r.signature}`;
  }
  if (e.outcome === "observed") return `burn: ${head}: observed, the pool is recorded and nothing is bought yet, pot ${r.pot} lamports${next}, tx ${r.signature}`;
  return `burn: ${head}: waited, the price is above the observation, the pool is recorded again and nothing is bought, pot ${r.pot} lamports${next}, tx ${r.signature}`;
}

/// The three strikes rule of the burn keeper. `fails` maps a pool (base58) to { count, alerted, skip, error }.
///   keys     every pool that has something to spend this pass (planBurns gives them)
///   results  what happened to the pools this pass called (burnAll gives them)
///   unread   pools (base58) that could not be read this pass: they keep what they had
/// A pool with nothing left to spend is forgotten. A call that was confirmed clears its pool, whatever its
/// outcome: observed, waited and bought are all the chain's own answers. A pool whose call failed `limit`
/// passes in a row raises one alert, once. After the alert it is tried again only once every `retryRounds`
/// passes, so a stuck pool costs neither log lines nor fees. A pass that skips a pool because it is too soon
/// neither counts nor clears.
export function burnStrikes(fails, keys, results, { limit = BURN_STRIKES, retryRounds = BURN_RETRY_ROUNDS, unread = [] } = {}) {
  const tried = new Map(results.map((r) => [r.key, r]));
  const next = {};
  const alerts = [];
  for (const [key, prev] of Object.entries(fails ?? {})) if (unread.includes(key)) next[key] = prev;
  for (const key of keys) {
    const prev = fails ? fails[key] : undefined;
    const r = tried.get(key);
    if (!r) { if (prev) next[key] = { ...prev, skip: Math.max(0, (prev.skip ?? 0) - 1) }; continue; }
    if (r.ok) continue;
    const count = (prev ? prev.count : 0) + 1;
    let alerted = !!(prev && prev.alerted);
    if (count >= limit && !alerted) { alerts.push({ key, pool: key, kind: r.kind, count, error: r.error, pot: big(r.pot).toString() }); alerted = true; }
    next[key] = { count, alerted, skip: alerted ? retryRounds - 1 : 0, error: r.error };
  }
  return { fails: next, alerts };
}

export function burnStuckMessage(ev, symbol) {
  const what = ev.kind === "buyback" ? "buyback treasury" : "burn pot";
  return `the burn call failed ${ev.count} passes in a row on ${symbol || `pool ${ev.pool}`}: ${ev.error}. ${ev.pot} lamports wait in its ${what} and are not being spent. Look at it.`;
}

export const NO_BURN_TOTALS = () => ({ calls: 0, failed: 0, observed: 0, waited: 0, bought: 0, spentLamports: 0, feeLamports: 0 });

/// Add one pass to the running totals. `calls` counts confirmed transactions, `failed` the ones that were not
/// confirmed. `observed`, `waited` and `bought` split the confirmed ones by what the chain reported.
/// `spentLamports` is what the buys spent out of the pots, `feeLamports` what the keeper paid to send it all.
export function addBurnTotals(totals, results) {
  const t = { ...NO_BURN_TOTALS(), ...(totals ?? {}) };
  for (const r of results) {
    if (!r.signature) { t.failed += 1; continue; }
    t.calls += 1;
    if (!r.effect) continue;
    t[r.effect.outcome] += 1;
    t.spentLamports += Number(r.effect.quoteSpent);
    t.feeLamports += r.effect.feeLamports;
  }
  return t;
}

/// What the keeper did per pool, for the pool's entry in the status file: { calls, bought, spentLamports,
/// lastAt, lastOutcome }. `table` maps a pool (base58) to that.
export function addBurnPoolStats(table, results, nowIso) {
  const next = { ...(table ?? {}) };
  for (const r of results) {
    const prev = next[r.key] ?? { calls: 0, bought: 0, spentLamports: 0, lastAt: null, lastOutcome: null };
    const s = { ...prev, lastAt: nowIso };
    if (!r.signature) s.lastOutcome = "failed";
    else {
      s.calls += 1;
      if (r.effect) {
        s.lastOutcome = r.effect.outcome;
        if (r.effect.outcome === "bought") { s.bought += 1; s.spentLamports += Number(r.effect.quoteSpent); }
      }
    }
    next[r.key] = s;
  }
  return next;
}

/// For the pool pass: what each buyback pool's treasury holds, by pool (base58), from one batched read.
export async function readBuybackTreasuries(connection, pools) {
  const mine = pools.filter((p) => burnKind(p) === "buyback");
  const out = new Map();
  if (!mine.length) return out;
  const { infos } = await getMany(connection, mine.map((p) => p.hookQuoteTreasury));
  mine.forEach((p, i) => out.set(b58(p.address), infos[i] ? new Uint8Array(infos[i].data) : null));
  return out;
}

// ---- holder records of strict coins, pure part -------------------------------------------------------
// A strict coin pays the holders' share to wallets with a holder record, on the balance the record counted at
// the wallet's last transfer. A token Burn calls no transfer hook, so after a burn the record stands above
// what the wallet holds, and that wallet keeps being paid on coins that are gone, out of the other holders'
// part, until its next transfer or until anybody sends `sync_holder`. Finding such records is cheap (one read
// of a strict pool's records, one read of their wallets' coins per hundred), so this keeper syncs them.

/// The most syncs one pass sends, and how many go in one transaction.
export const SYNCS_PER_PASS = 10;
export const SYNCS_PER_TX = 5;

/// Which records stand above their wallets' coins by enough to be worth a transaction. `records` are
/// { owner, balance } (the record's count), `balances` maps an owner (base58) to what its coin account holds,
/// `registered` is the config's total of the records. A record is kept when its excess is at least `minBps`
/// basis points of what is registered: that is the share of the holders' part it takes that it should not.
/// Largest excess first, at most `max`.
export function recordsToSync(records, balances, registered, minBps, { max = SYNCS_PER_PASS } = {}) {
  const out = [];
  for (const r of records) {
    const held = balances.get(b58(r.owner)) ?? 0n;
    if (r.balance <= held) continue;
    const excess = r.balance - held;
    const bps = registered > 0n ? Number((excess * 10_000n) / registered) : 10_000;
    if (bps < minBps) continue;
    out.push({ owner: r.owner, recordBalance: r.balance, balance: held, excess, bps });
  }
  out.sort((a, b) => (a.excess > b.excess ? -1 : a.excess < b.excess ? 1 : 0));
  return { send: out.slice(0, max), later: out.slice(max) };
}

/// The records a confirmed sync transaction lowered, from its `HolderSynced` log events: owner (base58) and
/// the balance the record counts now.
export function syncEffect(tx) {
  if (!tx || !tx.meta) return null;
  let events = [];
  try { events = eventsFromTransaction(tx, OUR_PROGRAMS).filter((e) => e.kind === "HolderSynced"); } catch { events = []; }
  return { synced: events.map((e) => ({ owner: e.owner.toBase58(), balance: e.balance })), feeLamports: Number(tx.meta.fee ?? 0) };
}

/// The log line of one record a sync lowered, or could not.
export function syncLine(pool, item, signature, error) {
  const head = `pool ${b58(pool)} wallet ${b58(item.owner)}`;
  if (!signature) return `sync FAILED: ${head}: ${error}`;
  return `sync: ${head}: holder record lowered from ${item.recordBalance} to ${item.balance} raw units, it stood ${item.excess} above the wallet's coins (${item.bps} bps of the coins in holder records), tx ${signature}`;
}

export const NO_SYNC_TOTALS = () => ({ sent: 0, failed: 0, records: 0, feeLamports: 0 });

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes) {
  let n = 0n;
  for (const x of bytes) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of bytes) { if (x === 0) s = "1" + s; else break; }
  return s;
}

// ---- network -------------------------------------------------------------------------------------

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/// Must a strict pool's holder records be read in this pass? A record can stand above its wallet's coins only
/// after a token Burn of the coin (every transfer brings the record along), and a burn lowers the coin's supply.
/// So the records are read when the supply differs from the one of the last read, when that read found records
/// to sync (they are read again until they are synced), when there was no read yet, and at least every
/// `maxAgeMs` as a safety net. `prev` is { supply, at, pending } of the last read, or undefined.
export function holderScanDue(prev, supply, nowMs, maxAgeMs = HOLDER_SCAN_MAX_AGE_MS) {
  if (!prev) return true;
  // the last read of this pool's records failed: not before its pause ran out (30 s, then 60, ..., 10 minutes)
  if (prev.notBefore !== undefined && prev.notBefore !== null && nowMs < prev.notBefore) return false;
  if (prev.at === undefined || prev.at === null) return true;
  if (prev.supply !== supply) return true;
  if (prev.pending > 0) return true;
  return nowMs - prev.at >= maxAgeMs;
}

/// After a failed read of a strict pool's holder records, the next read waits this long: 30 s, doubled with every
/// failure in a row, 10 minutes at most (the records are a getProgramAccounts, the call a shared node aborts).
export const HOLDER_SCAN_RETRY_MS = 30_000;
export const HOLDER_SCAN_RETRY_MAX_MS = 600_000;
export function holderScanBackoffMs(failures) {
  return Math.min(HOLDER_SCAN_RETRY_MS * 2 ** Math.max(0, failures - 1), HOLDER_SCAN_RETRY_MAX_MS);
}
export const HOLDER_SCAN_MAX_AGE_MS = 600_000;

/// The records of the strict pools among `pools` that stand above their wallets' coins. Per pass: one batched
/// read of the configs and the coins' mints (all pools together), and for a strict coin whose records are due
/// (`holderScanDue`) one read of its holder records and one of their wallets' coin accounts per hundred. A pool
/// that cannot be read goes to `unread`. `scans` (optional) is the table of the last reads, kept by the caller;
/// without it every strict pool is read, as before.
export async function readHolderExcess(connection, pools, { minBps = 10, scans = null, nowMs = Date.now(), maxAgeMs = HOLDER_SCAN_MAX_AGE_MS } = {}) {
  const mine = pools.filter((p) => burnKind(p) === "rules" && p.baseTokenProgram.equals(TOKEN_2022_PROGRAM));
  const work = []; const unread = [];
  if (!mine.length) return { work, unread };
  const { infos } = await getMany(connection, mine.flatMap((p) => [pda.cfg(PROGRAMS.hook_rules, p.address), p.baseMint]));
  for (let i = 0; i < mine.length; i++) {
    const pool = mine[i];
    const cfgInfo = infos[i * 2];
    const mintInfo = infos[i * 2 + 1];
    const key = b58(pool.address);
    try {
      if (!cfgInfo) continue;
      const cfg = decodeRulesConfig(new Uint8Array(cfgInfo.data));
      if (cfg.kind !== RULES_KIND.STRICT) continue;
      const supply = mintInfo && mintInfo.data.length >= 44 ? Buffer.from(mintInfo.data).readBigUInt64LE(36).toString() : null;
      if (scans && !holderScanDue(scans[key], supply, nowMs, maxAgeMs)) continue;
      const accs = await connection.getProgramAccounts(PROGRAMS.hook_rules, { filters: [{ dataSize: 129 }, { memcmp: { offset: 0, bytes: bs58(ACCOUNT_DISC.HolderRecord) } }, { memcmp: { offset: 9, bytes: pool.address.toBase58() } }] });
      const records = accs.map((a) => decodeHolderRecord(new Uint8Array(a.account.data)));
      const { infos: atas } = records.length ? await getMany(connection, records.map((r) => pda.ata(r.owner, pool.baseMint, TOKEN_2022_PROGRAM))) : { infos: [] };
      const balances = new Map(records.map((r, j) => [r.owner.toBase58(), atas[j] && atas[j].data.length >= 72 ? decodeTokenAmount(new Uint8Array(atas[j].data)) : 0n]));
      const plan = recordsToSync(records, balances, cfg.totalStaked, minBps);
      if (scans && supply !== null) scans[key] = { supply, at: nowMs, pending: plan.send.length + plan.later.length };
      else if (scans) delete scans[key];
      work.push({ pool, records: records.length, ...plan });
    } catch (e) {
      // the read failed (a getProgramAccounts the node aborted, most likely): this pool waits before the next
      // try, longer each time, and keeps what its last good read said about its supply
      if (scans) {
        const prev = scans[key] ?? {};
        const failures = (prev.failures ?? 0) + 1;
        scans[key] = { ...prev, failures, notBefore: nowMs + holderScanBackoffMs(failures) };
      }
      unread.push({ pool: b58(pool.address), error: oneLine(errMsg(e)) });
    }
  }
  return { work, unread };
}

/// One v0 transaction with up to SYNCS_PER_TX `sync_holder`, signed and paid by the keeper. Returns the signature
/// once confirmed.
export async function sendSyncTx({ connection, client, keeper, pool, owners }) {
  const k = client.keys(pool);
  const { tx, lastValidBlockHeight } = await client.buildTx(keeper.publicKey, owners.map((o) => ix.rulesSyncHolder(k, o)));
  tx.sign([keeper]);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await confirmByPolling(connection, signature, lastValidBlockHeight);
  return signature;
}

/// Send the syncs of one pool, SYNCS_PER_TX per transaction. A transaction that fails is sent again one record
/// at a time. Returns one result per record: { item, signature, error }, and the fees paid.
export async function syncAll({ pool, items, send, readEffect }) {
  const results = []; let feeLamports = 0;
  const one = async (group) => {
    try {
      const signature = await send(group.map((it) => it.owner));
      let effect = null;
      try { effect = await readEffect(signature); } catch { effect = null; }
      if (effect) feeLamports += effect.feeLamports;
      for (const it of group) {
        const seen = effect ? effect.synced.find((s) => s.owner === b58(it.owner)) : null;
        results.push({ item: seen ? { ...it, balance: seen.balance } : it, signature, error: null });
      }
      return true;
    } catch (e) {
      if (group.length === 1) results.push({ item: group[0], signature: null, error: chainError(e) });
      return false;
    }
  };
  for (let i = 0; i < items.length; i += SYNCS_PER_TX) {
    const group = items.slice(i, i + SYNCS_PER_TX);
    if (!(await one(group)) && group.length > 1) for (const it of group) await one([it]);
  }
  return { pool, results, feeLamports };
}

/// What a confirmed sync transaction did. A few tries, like the other cranks.
export async function readSyncEffect(connection, signature, { tries = 5, everyMs = 400 } = {}) {
  for (let n = 0; n < tries; n++) {
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx && tx.meta) return syncEffect(tx);
    await pause(everyMs);
  }
  return null;
}

/// The pools with something to spend, each with the SDK's answer for a call sent now.
/// One batched read of every config (and every buyback treasury) says where something waits. Only those pools
/// are then asked of the SDK, which reads pool, config and platform at one moment: one more read for a buyback
/// pool, two for a rules pool. A pool that cannot be read goes to `unread` and never stops the others.
/// `pools` are decoded pools of the two templates.
export async function readBurnCandidates(connection, client, payer, pools, { minPot = 0n, slippageBps = 100 } = {}) {
  const candidates = [];
  const unread = [];
  const mine = pools.map((p) => ({ pool: p, kind: burnKind(p) })).filter((x) => x.kind);
  if (!mine.length) return { candidates, unread, waiting: 0 };
  const keys = mine.flatMap((x) => [pda.cfg(x.pool.hookProgram, x.pool.address), x.pool.hookQuoteTreasury]);
  const { infos } = await getMany(connection, keys);
  let waiting = 0;
  for (let i = 0; i < mine.length; i++) {
    const { pool, kind } = mine[i];
    const key = b58(pool.address);
    const cfgInfo = infos[i * 2]; const treasuryInfo = infos[i * 2 + 1];
    const seen = burnPot({ kind, pool, cfgBytes: cfgInfo ? new Uint8Array(cfgInfo.data) : null, treasuryBytes: treasuryInfo ? new Uint8Array(treasuryInfo.data) : null });
    if (!seen) { unread.push({ pool: key, error: "the hook's config could not be read" }); continue; }
    if (seen.pot === 0n) continue;
    waiting += 1;
    if (seen.pot < big(minPot)) continue;
    try {
      const run = kind === "buyback" ? await client.buybackInstructions(payer, pool, slippageBps) : await client.rulesBurnInstructions(payer, pool.address, slippageBps);
      if (run) candidates.push({ key, pool, kind, run });
    } catch (e) {
      unread.push({ pool: key, error: oneLine(errMsg(e)) });
    }
  }
  return { candidates, unread, waiting };
}

/// One v0 transaction with the SDK's instructions for one call, compiled with the platform lookup table when
/// the client has one, signed and paid by the keeper. Returns the signature once confirmed.
export async function sendBurnTx({ connection, client, keeper, item }) {
  const { tx, lastValidBlockHeight } = await client.buildTx(keeper.publicKey, item.run.instructions);
  tx.sign([keeper]);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await confirmByPolling(connection, signature, lastValidBlockHeight);
  return signature;
}

/// What a confirmed call did, from its transaction. An RPC may need a moment before it serves a transaction
/// it has just confirmed, so a few tries. null when it never shows up.
export async function readBurnEffect(connection, signature, { tries = 5, everyMs = 400 } = {}) {
  for (let n = 0; n < tries; n++) {
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx && tx.meta) return burnEffect(tx);
    await pause(everyMs);
  }
  return null;
}
