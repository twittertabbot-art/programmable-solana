// The curve, and the graduate crank.
//
// A coin launched on the curve opens its pool with the whole supply and no real SOL. The pool prices trades with
// `reserveQuote + virtualQuote` (the virtual SOL is counted in the price and never paid out), pays a sell from
// `reserveQuote` only, and refuses liquidity until it graduates. Once its real reserve reaches its graduation
// target, `graduate` drops the virtual part and burns coins from the pool so that the price stays where it is
// (HOOKS.md section 2, "A pool on the curve"). One pool, one address, for the coin's whole life.
//
// `graduate` is an instruction anyone may send. It takes no signer: whoever pays the fee sends it. The SDK
// and the trade API put it into the trade that takes a pool to its target (after the swap) and into any trade
// on a pool that stands past it (before the swap), so most coins graduate inside a trade. This crank is the
// one that sends it when no trade did: a trade built without them. On a pool that somebody graduated first the
// instruction lands and changes nothing.
//
// The top half is pure and tested offline: what the status file says about a pool on the curve, and the plan,
// the effect, the log lines and the strikes of the crank. The bottom half sends the transactions.
import { CURVE_NONE, CURVE_OPEN, PROGRAMS, curveProgress, eventsFromTransaction } from "../../sdk/dist/index.js";
import { confirmByPolling } from "./crank.mjs";

/// A call that fails this many passes in a row on the same pool raises one alert.
export const GRADUATE_STRIKES = 3;
/// After that alert the pool is tried again only once in this many passes.
export const GRADUATE_RETRY_ROUNDS = 30;
/// The most calls one pass sends, one per pool. More pools than this wait for the next pass.
export const GRADUATES_PER_PASS = 10;
/// A pool this watcher graduated is not sent another graduate for this long, should an RPC that lags still
/// show it open. A second one would land and change nothing; it would only cost its fee.
export const GRADUATE_RESEND_MS = 120_000;
export const GRADUATE_OUTCOMES = ["graduated", "already", "failed"];
const OUR_PROGRAMS = Object.values(PROGRAMS).map((p) => p.toBase58());

const b58 = (k) => (typeof k === "string" ? k : k.toBase58());
const errMsg = (e) => (e && e.message ? e.message : String(e));
const oneLine = (s, max = 300) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max)}...` : t; };
/// Lamports as SOL, at most nine decimals, no trailing zeros.
export function solOf(lamports) {
  const s = BigInt(lamports).toString().padStart(10, "0");
  const frac = s.slice(-9).replace(/0+$/, "");
  return frac ? `${s.slice(0, -9)}.${frac}` : s.slice(0, -9);
}

// ---- pure part: the status file ---------------------------------------------------------------------------

/// True for a pool on the curve whose real reserve has reached its target: `graduate` is allowed now.
export function readyToGraduate(pool) {
  return !!pool && pool.curveState === CURVE_OPEN && pool.graduationTarget > 0n && pool.reserveQuote >= pool.graduationTarget;
}

/// The supply of a coin from its mint account (bytes 36 to 43, under either token program), or null.
export function supplyOf(mintInfo) {
  if (!mintInfo || !mintInfo.data || mintInfo.data.length < 44) return null;
  return Buffer.from(mintInfo.data).readBigUInt64LE(36);
}

/// The `curve` part of a pool's entry in the status file, the same fields as the trade API's quote. null for a
/// seeded pool: its entry has no `curve`. `supply` is the coin's supply (null when unknown).
///   state             "open" or "graduated"
///   virtualQuote      lamports of virtual SOL counted in the price (0 once graduated)
///   raised            lamports of real SOL in the pool
///   target            lamports of real SOL the pool graduates at (0 once graduated)
///   raisedBps         raised over target, at most 10000; 10000 once graduated
///   soldBps           the share of the supply out of the pool; null when the supply could not be read
///   graduationFeeBps  the share of the target the platform takes at graduation (kept as a record after it)
///   graduates         the pool stands at or past its target and waits for `graduate`
export function curveEntry(pool, supply) {
  if (!pool || pool.curveState === CURVE_NONE) return null;
  const known = typeof supply === "bigint";
  const c = curveProgress(pool, known ? supply : 0n);
  return {
    state: c.state, virtualQuote: pool.virtualQuote.toString(), raised: c.raised.toString(), target: c.target.toString(),
    raisedBps: c.raisedBps, soldBps: known ? c.soldBps : null, graduationFeeBps: pool.graduationFeeBps, graduates: readyToGraduate(pool),
  };
}

/// The notes of a pool on the curve, in words. `crank` says whether this watcher sends `graduate`, and how often.
export function curveNotes(pool, { crank = true, intervalSeconds = 15 } = {}) {
  if (!pool || pool.curveState === CURVE_NONE) return [];
  if (pool.curveState !== CURVE_OPEN) {
    return ["This coin graduated from the curve. Its pool holds real SOL only now, and every share of its liquidity stays locked."];
  }
  const notes = [
    `This coin is on the curve. Its pool prices trades with ${solOf(pool.virtualQuote)} SOL of virtual SOL that it does not hold, and pays out only its real SOL.`,
    `It holds ${solOf(pool.reserveQuote)} SOL of real SOL and graduates at ${solOf(pool.graduationTarget)} SOL. Liquidity opens at graduation.`,
  ];
  if (readyToGraduate(pool)) {
    notes.push(crank
      ? `The pool stands past its graduation target. Anyone may send graduate. This watcher does it every ${intervalSeconds} s.`
      : "The pool stands past its graduation target. Anyone may send graduate. This watcher runs without the graduate crank, so somebody else must.");
  }
  return notes;
}

// ---- pure part: the crank -----------------------------------------------------------------------------------

/// What a graduate pass sends. `pools` are decoded pools; the ones that stand at or past their target are due.
/// Pools that rest after their alert are left out (`resting`), and so is a pool this watcher graduated less than
/// GRADUATE_RESEND_MS ago (`recent`). Pools whose call failed before go after the others, and among equals the
/// one with more real SOL goes first. At most `maxCalls` go out (`send`); the others wait (`later`). `keys` names
/// every pool that is due, sent or not. `fails` maps a pool to { count, alerted, skip, error }; `stats` maps a pool
/// to what this watcher did on it ({ lastAt, lastOutcome, signature }).
export function planGraduates(pools, fails = {}, stats = {}, { maxCalls = GRADUATES_PER_PASS, nowMs = Date.now() } = {}) {
  const ready = []; const resting = []; const recent = []; const keys = [];
  for (const pool of pools) {
    if (!readyToGraduate(pool)) continue;
    const key = b58(pool.address);
    keys.push(key);
    const s = stats ? stats[key] : undefined;
    if (s && s.lastOutcome === "graduated" && s.lastAt && nowMs - Date.parse(s.lastAt) < GRADUATE_RESEND_MS) { recent.push({ key, pool, since: s.lastAt, signature: s.signature ?? null }); continue; }
    const f = fails ? fails[key] : undefined;
    if (f && f.skip > 0) resting.push({ key, pool }); else ready.push({ key, pool });
  }
  const strikes = (it) => (fails && fails[it.key] ? fails[it.key].count : 0);
  ready.sort((a, b) => strikes(a) - strikes(b) || (a.pool.reserveQuote > b.pool.reserveQuote ? -1 : a.pool.reserveQuote < b.pool.reserveQuote ? 1 : 0));
  return { keys, send: ready.slice(0, maxCalls), later: ready.slice(maxCalls), resting, recent };
}

/// What a confirmed graduate did, as the chain reported it: the pool's `Graduated` event (an inner instruction)
/// says it graduated, with the burn and the fee. No event means the pool had graduated already and the call changed
/// nothing. `tx` is what getTransaction returns; null when there is none.
export function graduateEffect(tx, pool = null) {
  if (!tx || !tx.meta) return null;
  const feeLamports = Number(tx.meta.fee ?? 0);
  const computeUnits = tx.meta.computeUnitsConsumed ?? null;
  let ev = null;
  try { ev = eventsFromTransaction(tx, OUR_PROGRAMS).find((e) => e.kind === "Graduated" && (!pool || e.pool.equals(pool))) ?? null; } catch { ev = null; }
  if (!ev) return { outcome: "already", feeLamports, computeUnits };
  return {
    outcome: "graduated", reserveQuoteBefore: ev.reserveQuoteBefore, reserveQuoteAfter: ev.reserveQuoteAfter, reserveBaseBefore: ev.reserveBaseBefore,
    reserveBaseAfter: ev.reserveBaseAfter, burnedBase: ev.burnedBase, feeQuote: ev.feeQuote, slot: ev.slot, feeLamports, computeUnits,
  };
}

/// The error of a call the chain refused, with the program's own name for it when the logs carry one.
export function graduateError(e) {
  const text = `${errMsg(e)} ${Array.isArray(e && e.logs) ? e.logs.join(" ") : ""}`.trim();
  const m = /Error Code: ([A-Za-z0-9_]+)\. Error Number: (\d+)\. Error Message: ([^"\]]*?)\.?(?:"|,|\]|$)/.exec(text);
  if (m) return oneLine(`${m[1]} (${m[2]}): ${m[3]}`);
  return oneLine(errMsg(e));
}

/// Send the planned calls one after the other, one transaction each. A call that fails is recorded and the pass
/// moves on. `send` and `readEffect` are injectable for the tests.
export async function graduateAll({ plan, send, readEffect }) {
  const results = [];
  for (const item of plan) {
    try {
      const signature = await send(item);
      let effect = null;
      try { effect = await readEffect(signature, item); } catch { effect = null; }
      results.push({ ...item, signature, effect, ok: true, error: null });
    } catch (e) {
      results.push({ ...item, signature: null, effect: null, ok: false, error: graduateError(e) });
    }
  }
  return results;
}

/// The log line of one call, with what the chain reported.
export function graduateLine(r) {
  const head = `pool ${b58(r.key ?? r.pool.address)}`;
  if (!r.signature) return `graduate FAILED: ${head}: ${r.error}`;
  const e = r.effect;
  if (!e) return `graduate: ${head}: sent, the result could not be read, tx ${r.signature}`;
  if (e.outcome === "already") return `graduate: ${head}: the pool had graduated already, the call changed nothing, tx ${r.signature}`;
  return `graduate: ${head}: graduated with ${e.reserveQuoteBefore} lamports of real SOL raised, burned ${e.burnedBase} raw coins to keep the price, `
    + `${e.feeQuote} lamports for the platform; the pool holds ${e.reserveQuoteAfter} lamports and ${e.reserveBaseAfter} raw coins now, tx ${r.signature}`;
}

/// The alert of a coin that graduated through this crank: an event of the coin's life, worth one line.
export function graduatedMessage(r, symbol) {
  const e = r.effect;
  return `${symbol || "this coin"} graduated from the curve: ${solOf(e.reserveQuoteBefore)} SOL raised, ${e.burnedBase} raw coins burned so that the price stays, `
    + `${solOf(e.feeQuote)} SOL for the platform. Its liquidity is open now. Sent by this watcher, tx ${r.signature}`;
}

/// The three strikes rule of the crank, as for the burn keeper. A pool that is no longer due is forgotten. A call
/// that was confirmed clears its pool, whatever its outcome. A pool whose call failed `limit` passes in a row raises
/// one alert, once, and is then tried again only once every `retryRounds` passes. `unread` keeps what it had.
export function graduateStrikes(fails, keys, results, { limit = GRADUATE_STRIKES, retryRounds = GRADUATE_RETRY_ROUNDS, unread = [] } = {}) {
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
    if (count >= limit && !alerted) { alerts.push({ key, pool: key, count, error: r.error, raised: r.pool.reserveQuote.toString(), target: r.pool.graduationTarget.toString() }); alerted = true; }
    next[key] = { count, alerted, skip: alerted ? retryRounds - 1 : 0, error: r.error };
  }
  return { fails: next, alerts };
}

export function graduateStuckMessage(ev, symbol) {
  return `the graduate call failed ${ev.count} passes in a row on ${symbol || `pool ${ev.pool}`}: ${ev.error}. The pool holds ${solOf(ev.raised)} SOL of real SOL, past its target of ${solOf(ev.target)} SOL, `
    + "and keeps trading on the curve until somebody graduates it. Look at it.";
}

export const NO_GRADUATE_TOTALS = () => ({ sent: 0, failed: 0, graduated: 0, already: 0, feeLamports: 0 });

/// Add one pass to the running totals. `sent` counts confirmed transactions, `failed` the ones that were not
/// confirmed. `graduated` and `already` split the confirmed ones by what the chain reported. `feeLamports` is what
/// the keeper paid.
export function addGraduateTotals(totals, results) {
  const t = { ...NO_GRADUATE_TOTALS(), ...(totals ?? {}) };
  for (const r of results) {
    if (!r.signature) { t.failed += 1; continue; }
    t.sent += 1;
    if (!r.effect) continue;
    t[r.effect.outcome] += 1;
    t.feeLamports += r.effect.feeLamports;
  }
  return t;
}

/// What this watcher did per pool: { lastAt, lastOutcome, signature }. `table` maps a pool (base58) to that.
export function addGraduatePoolStats(table, results, nowIso) {
  const next = { ...(table ?? {}) };
  for (const r of results) {
    next[r.key] = { lastAt: nowIso, lastOutcome: !r.signature ? "failed" : r.effect ? r.effect.outcome : "already", signature: r.signature ?? null };
  }
  return next;
}

// ---- network -------------------------------------------------------------------------------------------------

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/// One transaction with `graduate` for one pool, compiled with the platform lookup table when the client has one,
/// signed and paid by the keeper. Returns the signature once confirmed.
export async function sendGraduateTx({ connection, client, keeper, pool }) {
  const { tx, lastValidBlockHeight } = await client.buildTx(keeper.publicKey, client.graduateInstructions(pool));
  tx.sign([keeper]);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await confirmByPolling(connection, signature, lastValidBlockHeight);
  return signature;
}

/// What a confirmed call did, from its transaction. A few tries: an RPC may need a moment before it serves a
/// transaction it has just confirmed. null when it never shows up.
export async function readGraduateEffect(connection, signature, pool, { tries = 5, everyMs = 400 } = {}) {
  for (let n = 0; n < tries; n++) {
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx && tx.meta) return graduateEffect(tx, pool);
    await pause(everyMs);
  }
  return null;
}
