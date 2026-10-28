// The reveal crank for the "Collectible per buy" template, and the ticket reporting that goes with it.
//
// A buy records "N pieces, decided by the first block at or after slot S + 2" in the buyer's ticket. Anyone may
// call the permissionless `reveal` once that block exists. A batch nobody reveals while its block hash is still
// available (512 slots, about 3.5 minutes) expires and its pieces are forced to the common tier. So a buyer must
// never be able to look at a bad result and leave it unrevealed: the watcher reveals every matured ticket,
// promptly, and pays the fee itself.
//
// The settle crank lives here too. Pieces are pegged to the coin: a wallet holds at most one piece per `unit`
// coins in its token account. When coins leave, the pieces they no longer back must go, newest first: waiting
// pieces are dropped, minted pieces are burned from the end of the wallet's list. The site settles every sell
// in the sell's own transaction. The watcher settles everybody else: coins that left by a plain transfer, sells
// made with another client. `settle` is permissionless and pays the rent of each burned piece to its sender.
//
// The upkeep crank lives here too. It serves PEGGED coins only: Token-2022 coins whose transfer hook is the
// collectible program. There the wallet lists change inside every transfer of the coin, and the Metaplex Core
// assets follow by two permissionless instructions. `deliver` hands a moved piece's asset to the wallet whose
// list now holds it. `reap` burns the asset of a piece that a transfer burned; those wait in the pool's burn
// queue. The site adds both to the transactions it builds. The watcher sends them for every transfer made
// anywhere else (a wallet's own Send button, another app), so the NFT a wallet shows matches its list within
// seconds. A reap pays the asset's rent and the queue's rent for that entry to its sender.
//
// The top half is pure and tested offline. The bottom half reads the chain and sends the transactions.
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { collectible, EVENT_DISC } from "../../sdk/dist/index.js";

export const REVEALS_PER_TX = 8;
/// One signature per reveal transaction, whatever the number of reveals packed into it.
export const REVEAL_FEE_LAMPORTS = 5000n;
const { BATCH } = collectible;

const b58 = (k) => (typeof k === "string" ? k : k.toBase58());
const errMsg = (e) => (e && e.message ? e.message : String(e));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/// One key per batch: the wallet's ticket on a pool plus the slot that decides the batch.
export function batchKey(ticket, batch) { return `${b58(ticket.pool)}:${b58(ticket.user)}:${batch.targetSlot.toString()}`; }

/// A waiting batch can be revealed once its target block exists, that is strictly after the target slot.
export function batchMatured(batch, currentSlot) {
  return batch.state === BATCH.WAITING && batch.pieces > 0 && BigInt(currentSlot) > batch.targetSlot;
}

/// Does any ticket hold a batch that still waits for its reveal? Pieces that were revealed and wait only to be
/// minted need no keeper; a batch that waits must be revealed in time, and is watched until it is.
export function anyWaiting(tickets) {
  return tickets.some((t) => t.batches.some((b) => b.state === BATCH.WAITING && b.pieces > 0));
}

/// The tickets a crank pass must reveal at this slot. One entry per ticket (a reveal locks in every matured
/// batch of the ticket at once), oldest target first, so the batches nearest to expiry go out first.
export function ticketsToReveal(tickets, currentSlot) {
  const out = [];
  for (const t of tickets) {
    const matured = t.batches.filter((b) => batchMatured(b, currentSlot));
    if (!matured.length) continue;
    const targetSlots = matured.map((b) => b.targetSlot);
    const oldestTarget = targetSlots.reduce((m, s) => (s < m ? s : m), targetSlots[0]);
    out.push({ pool: t.pool, user: t.user, pieces: matured.reduce((n, b) => n + b.pieces, 0), targetSlots, oldestTarget });
  }
  out.sort((a, b) => (a.oldestTarget < b.oldestTarget ? -1 : a.oldestTarget > b.oldestTarget ? 1 : 0));
  return out;
}

export function chunk(list, size = REVEALS_PER_TX) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const NO_TICKETS = () => ({ open: 0, undecided: 0, awaitingReveal: 0, expired: 0 });

/// Per pool (base58): tickets still holding pieces, and where their pieces stand at this slot.
///   undecided       the deciding block does not exist yet
///   awaitingReveal  the block exists and nobody has revealed yet (0 right after a crank)
///   expired         pieces sitting in batches that were not revealed in time
export function summarizeTickets(tickets, currentSlot) {
  const out = new Map();
  for (const t of tickets) {
    if (!t.batches.some((b) => b.pieces > 0)) continue;
    const key = b58(t.pool);
    const s = out.get(key) ?? NO_TICKETS();
    s.open += 1;
    for (const b of t.batches) {
      if (b.pieces === 0) continue;
      if (b.state === BATCH.EXPIRED) s.expired += b.pieces;
      else if (b.state === BATCH.WAITING) { if (batchMatured(b, currentSlot)) s.awaitingReveal += b.pieces; else s.undecided += b.pieces; }
    }
    out.set(key, s);
  }
  return out;
}

/// The state diff behind the "expired unrevealed" alert. `seen` maps batchKey to "waiting" or "expired".
/// A batch that shows up EXPIRED after having been seen WAITING was not revealed in time: one event, once.
/// A batch that is EXPIRED the first time it is seen raises nothing (it expired before the watcher was looking).
/// Keys of batches that are gone (revealed, minted) are dropped, so the table never grows.
export function diffBatches(seen, tickets) {
  const next = {};
  const expired = [];
  for (const t of tickets) {
    for (const b of t.batches) {
      if (b.pieces === 0) continue;
      const key = batchKey(t, b);
      if (b.state === BATCH.WAITING) next[key] = "waiting";
      else if (b.state === BATCH.EXPIRED) {
        const before = seen ? seen[key] : undefined;
        if (before === "waiting") expired.push({ pool: b58(t.pool), user: b58(t.user), targetSlot: b.targetSlot.toString(), pieces: b.pieces });
        if (before === "waiting" || before === "expired") next[key] = "expired";
      }
    }
  }
  return { seen: next, expired };
}

export function expiredMessage(ev, symbol) {
  const what = ev.pieces === 1 ? "1 piece" : `${ev.pieces} pieces`;
  return `${what} expired unrevealed on ${symbol || `pool ${ev.pool}`}: the keeper was not revealing in time (wallet ${ev.user}, decided by slot ${ev.targetSlot})`;
}

/// Below the minimum the keeper is about to run dry, and then every crank stops: reveals, settles, the
/// deliveries and burns of pegged coins, and the buybacks and burns of buyback and rules pools. Not on
/// localnet: the watcher airdrops there.
export function keeperBalanceAlert({ cluster, lamports, minLamports, address }) {
  if (cluster === "localnet") return null;
  if (BigInt(lamports) >= BigInt(minLamports)) return null;
  const sol = (v) => (Number(v) / 1e9).toFixed(4);
  return { level: "danger", message: `keeper wallet ${address} holds ${sol(lamports)} SOL, below the minimum ${sol(minLamports)} SOL: fund it, or reveals and settles stop (pieces expire to the common tier, unbacked pieces stay). Deliveries and burns for pegged coins stop too (a moved piece keeps showing its old wallet). So do the buybacks and burns of buyback and rules pools (their pots grow until somebody runs them).` };
}

/// A reveal, a settle, a deliver and a reap transaction all cost the same: one signature.
export function canPayReveal(lamports) { return BigInt(lamports) >= REVEAL_FEE_LAMPORTS; }

/// For /health: the crank is stale when it is enabled and has not completed a run for three intervals.
export function crankStale({ enabled, lastCrankAt, nowMs, intervalSeconds }) {
  if (!enabled) return false;
  const t = lastCrankAt ? Date.parse(lastCrankAt) : NaN;
  if (!Number.isFinite(t)) return true;
  return nowMs - t > intervalSeconds * 1000 * 3;
}

/// What the batches a reveal was sent for look like afterwards, for the log.
export function describeOutcome(ticketAfter, targetSlots) {
  if (!ticketAfter) return "ticket holds no pieces any more (minted in the meantime)";
  const parts = [];
  for (const slot of targetSlots) {
    const b = ticketAfter.batches.find((x) => x.targetSlot === slot && (x.pieces > 0 || x.state !== BATCH.EMPTY));
    if (!b) parts.push(`slot ${slot}: gone (minted in the meantime)`);
    else if (b.state === BATCH.REVEALED) parts.push(`slot ${slot}: REVEALED, seed ${hex(b.seed).slice(0, 16)}...`);
    else if (b.state === BATCH.EXPIRED) parts.push(`slot ${slot}: EXPIRED, too late, pieces forced to the common tier`);
    else if (b.state === BATCH.WAITING) parts.push(`slot ${slot}: still WAITING (the reveal was a no-op)`);
    else parts.push(`slot ${slot}: state ${b.state}`);
  }
  return parts.join("; ");
}

/// Reveal every due ticket, REVEALS_PER_TX per transaction. A transaction that fails is retried one ticket at a
/// time, so one bad ticket never holds back the others. `send` is injectable for the tests.
export async function revealAll({ due, send, log }) {
  const done = [];
  const failed = [];
  for (const group of chunk(due)) {
    try {
      const signature = await send(group);
      for (const t of group) done.push({ ...t, signature });
    } catch (e) {
      if (group.length === 1) { failed.push({ ...group[0], error: errMsg(e) }); continue; }
      if (log) log.warn(`crank: a transaction of ${group.length} reveals failed (${errMsg(e)}), retrying one ticket at a time`);
      for (const t of group) {
        try { done.push({ ...t, signature: await send([t]) }); } catch (e2) { failed.push({ ...t, error: errMsg(e2) }); }
      }
    }
  }
  return { done, failed };
}

// ---- the settle crank, pure part -------------------------------------------------------------------

/// The most minted pieces one settle burns (6, the SDK's number). A wallet further above the peg needs another
/// round.
export const MAX_BURNS_PER_SETTLE = collectible.MAX_BURNS_PER_SETTLE;
/// The most settles one pass sends, one per transaction. More wallets than this wait for the next pass.
export const SETTLES_PER_PASS = 10;
/// A settle that fails this many rounds in a row for the same wallet raises one alert.
export const SETTLE_STRIKES = 3;
/// After that alert the wallet is tried again only once in this many rounds.
export const SETTLE_RETRY_ROUNDS = 30;
/// Compute limit of one settle transaction, the number the SDK uses for the same instruction.
export const SETTLE_COMPUTE_UNITS = 400_000;
const EVENT_PREFIX = "Program data: ";

const oneLine = (s, max = 300) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max)}...` : t; };
const startsWith = (bytes, disc) => bytes.length >= disc.length && disc.every((b, i) => bytes[i] === b);

export function settleKey(pool, user) { return `${b58(pool)}:${b58(user)}`; }

/// What a settle pass sends. `unbacked` is what the SDK's fetchUnbacked returns for one or several pools: the
/// wallets above the peg, each with `peg.burn`, the pieces to burn, the end of the wallet's list first.
/// One settle per wallet per round, with at most `maxBurns` burns: the head of that list, that is the very end
/// of the wallet's list. The program burns the last piece of the list while it finds it among the accounts
/// passed, so the accounts must be that tail; their order does not matter, and a piece further up the list
/// would burn nothing. What is left (`burnLater`) is burned by the next rounds, from a fresh read.
/// `fails` is the three strikes table: a wallet that rests after its alert is not tried (`resting`), and
/// wallets that failed before go after the others, so they never hold a healthy wallet back.
/// At most `maxSettles` go out (`send`); the others wait for the next pass (`later`).
export function planSettles(unbacked, fails = {}, { maxBurns = MAX_BURNS_PER_SETTLE, maxSettles = SETTLES_PER_PASS } = {}) {
  const ready = [];
  const resting = [];
  for (const u of unbacked) {
    const key = settleKey(u.ticket.pool, u.ticket.user);
    const burn = u.peg.burn.slice(0, maxBurns);
    const item = {
      key, pool: u.ticket.pool, user: u.ticket.user, coins: u.coins, balance: u.balance, allowed: u.peg.allowed, held: u.peg.held,
      dropWaiting: u.peg.dropWaiting, burn, burnLater: u.peg.burn.length - burn.length,
    };
    const f = fails ? fails[key] : undefined;
    if (f && f.skip > 0) resting.push(item); else ready.push(item);
  }
  const strikes = (it) => (fails && fails[it.key] ? fails[it.key].count : 0);
  ready.sort((a, b) => strikes(a) - strikes(b));
  return { keys: [...ready, ...resting].map((it) => it.key), send: ready.slice(0, maxSettles), later: ready.slice(maxSettles), resting };
}

/// The compute limit, then the settle. One wallet per transaction.
export function settleInstructions(payer, item) {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: SETTLE_COMPUTE_UNITS }), collectible.settle(payer, item.pool, item.user, item.coins, item.burn)];
}

/// What a confirmed settle did, read from its own transaction: the events the program logged, and the keeper's
/// balance before and after. rentLamports is what the burned pieces paid back to the keeper: the balance after,
/// minus the balance before, plus the fee. null when there is no transaction to read.
export function settleEffect(meta) {
  if (!meta || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) return null;
  let dropped = 0; let burned = 0;
  for (const line of meta.logMessages ?? []) {
    if (typeof line !== "string" || !line.startsWith(EVENT_PREFIX)) continue;
    const bytes = Buffer.from(line.slice(EVENT_PREFIX.length), "base64");
    if (startsWith(bytes, EVENT_DISC.PieceBurned)) burned += 1;
    // PiecesCancelled: discriminator 8, pool 32, user 32, pieces u32.
    else if (startsWith(bytes, EVENT_DISC.PiecesCancelled) && bytes.length >= 76) dropped += bytes.readUInt32LE(72);
  }
  const feeLamports = Number(meta.fee ?? 0);
  const rentLamports = Number(meta.postBalances[0]) - Number(meta.preBalances[0]) + feeLamports;
  return { dropped, burned, rentLamports, feeLamports, computeUnits: meta.computeUnitsConsumed ?? null };
}

/// False for a settle that was confirmed and removed nothing. The program never fails a settle for that: it
/// burns what it may and stops. The usual cause is somebody else settling the wallet first. The others: its
/// coins came back, or its list got a new last piece between the read and the send. A settle whose transaction
/// could not be read counts as done; the next round reads the chain again anyway.
export function settleRemoved(effect) { return !effect || effect.dropped + effect.burned > 0 || effect.rentLamports > 0; }

/// Send the planned settles one after the other, one transaction each. A settle that fails is recorded and the
/// pass moves on: one bad wallet never holds back the others. `send` and `readEffect` are injectable for the
/// tests.
export async function settleAll({ plan, send, readEffect }) {
  const results = [];
  for (const item of plan) {
    try {
      const signature = await send(item);
      let effect = null;
      try { effect = await readEffect(signature); } catch { effect = null; }
      const ok = settleRemoved(effect);
      results.push({ ...item, signature, effect, ok, error: ok ? null : "the settle was confirmed but removed nothing" });
    } catch (e) {
      results.push({ ...item, signature: null, effect: null, ok: false, error: oneLine(errMsg(e)) });
    }
  }
  return results;
}

/// The log line of one settle: pool, wallet, pieces dropped, pieces burned, signature.
export function settleLine(r) {
  const head = `pool ${b58(r.pool)} wallet ${b58(r.user)}`;
  if (!r.signature) return `settle FAILED: ${head}: ${r.error}`;
  if (!r.effect) return `settle: ${head}: sent to drop ${r.dropWaiting} and burn ${r.burn.length}, the result could not be read, tx ${r.signature}`;
  const e = r.effect;
  const line = `settle: ${head}: dropped ${e.dropped}, burned ${e.burned}, rent received ${e.rentLamports} lamports, tx ${r.signature}`;
  if (!r.ok) return `${line}. Nothing was removed: somebody else settled it first, or the wallet changed in the meantime.`;
  return r.burnLater > 0 ? `${line}. ${r.burnLater} more to burn next round.` : line;
}

/// The three strikes rule. `fails` maps settleKey to { count, alerted, skip, error }.
///   keys     every wallet above the peg this round (planSettles gives them)
///   results  what happened to the wallets this round tried (settleAll gives them)
///   unread   pools (base58) that could not be read this round: their wallets keep what they had
/// A wallet that is no longer above the peg is forgotten. A settle that removed something clears its wallet.
/// A wallet whose settle failed `limit` rounds in a row raises one alert, once. After the alert it is tried
/// again only once every `retryRounds` rounds, so a stuck wallet costs neither log lines nor fees.
export function settleStrikes(fails, keys, results, { limit = SETTLE_STRIKES, retryRounds = SETTLE_RETRY_ROUNDS, unread = [] } = {}) {
  const tried = new Map(results.map((r) => [r.key, r]));
  const next = {};
  const alerts = [];
  for (const [key, prev] of Object.entries(fails ?? {})) {
    if (unread.some((pool) => key.startsWith(`${pool}:`))) next[key] = prev;
  }
  for (const key of keys) {
    const prev = fails ? fails[key] : undefined;
    const r = tried.get(key);
    if (!r) { if (prev) next[key] = { ...prev, skip: Math.max(0, (prev.skip ?? 0) - 1) }; continue; }
    if (r.ok) continue;
    const count = (prev ? prev.count : 0) + 1;
    let alerted = !!(prev && prev.alerted);
    if (count >= limit && !alerted) { alerts.push({ key, pool: b58(r.pool), user: b58(r.user), count, error: r.error }); alerted = true; }
    next[key] = { count, alerted, skip: alerted ? retryRounds - 1 : 0, error: r.error };
  }
  return { fails: next, alerts };
}

export function settleStuckMessage(ev, symbol) {
  return `settle failed ${ev.count} rounds in a row for wallet ${ev.user} on ${symbol || `pool ${ev.pool}`}: ${ev.error}. A piece that cannot be removed should be impossible. Look at it.`;
}

export const NO_SETTLE_TOTALS = () => ({ sent: 0, failed: 0, dropped: 0, burned: 0, rentLamports: 0, feeLamports: 0 });

/// Add one pass to the running totals. `sent` counts confirmed settle transactions, `rentLamports` the rent the
/// burned pieces paid to the keeper, `feeLamports` what the keeper paid to send them.
export function addSettleTotals(totals, results) {
  const t = { ...NO_SETTLE_TOTALS(), ...(totals ?? {}) };
  for (const r of results) {
    if (!r.signature) { t.failed += 1; continue; }
    t.sent += 1;
    if (r.effect) { t.dropped += r.effect.dropped; t.burned += r.effect.burned; t.rentLamports += r.effect.rentLamports; t.feeLamports += r.effect.feeLamports; }
  }
  return t;
}

// ---- the upkeep crank (pegged coins), pure part -----------------------------------------------------

/// The most assets one deliver or one reap names (6, the number the SDK uses for the same instructions).
export const ASSETS_PER_UPKEEP_TX = collectible.MAX_BURNS_PER_SETTLE;
/// The most transactions one upkeep pass sends. More work than this waits for the next pass.
export const UPKEEP_TXS_PER_PASS = 10;
/// An asset that still waits after it was sent this many rounds in a row raises one alert.
export const UPKEEP_STRIKES = 5;
/// After that alert the asset is tried again only once in this many rounds.
export const UPKEEP_RETRY_ROUNDS = 30;
/// Compute limit of one upkeep transaction, the number the SDK uses for the same instructions.
export const UPKEEP_COMPUTE_UNITS = 400_000;
const CORE_CALL = `Program ${collectible.MPL_CORE.toBase58()} invoke [2]`;

/// One key per waiting asset: the pool, what it waits for ("deliver" or "reap"), the asset.
export function upkeepKey(pool, kind, asset) { return `${b58(pool)}:${kind}:${b58(asset)}`; }

/// Every asset that waits, one entry each. `work` is what readUpkeep returns: per pegged pool the SDK's
/// fetchUndelivered ({ holder, assets }: assets whose Metaplex owner is not the wallet whose list holds them)
/// and fetchQueue (assets of pieces a transfer burned).
export function waitingAssets(work) {
  const out = [];
  for (const w of work) {
    for (const u of w.undelivered) for (const asset of u.assets) out.push({ key: upkeepKey(w.pool, "deliver", asset), pool: w.pool, kind: "deliver", holder: u.holder, asset });
    for (const asset of w.queue) out.push({ key: upkeepKey(w.pool, "reap", asset), pool: w.pool, kind: "reap", holder: null, asset });
  }
  return out;
}

/// The start of a round. `table` maps upkeepKey to { count, alerted, skip }: `count` is how many rounds in a row
/// the asset was sent and still waited afterwards.
///   waiting  every asset that waits now (waitingAssets), from a fresh read of the chain
///   unread   pools (base58) that could not be read this round: their assets keep what they had
/// An asset that no longer waits is forgotten: it was delivered or burned, by the keeper or by anybody else.
/// An asset that still waits after `limit` rounds in a row goes to `stuck`, once, and rests: it is tried again
/// only once every `retryRounds` rounds, so a stuck asset costs neither log lines nor fees.
export function upkeepRound(table, waiting, { limit = UPKEEP_STRIKES, retryRounds = UPKEEP_RETRY_ROUNDS, unread = [] } = {}) {
  const next = {};
  const stuck = [];
  for (const [key, prev] of Object.entries(table ?? {})) {
    if (unread.some((pool) => key.startsWith(`${pool}:`))) next[key] = prev;
  }
  for (const w of waiting) {
    const prev = table ? table[w.key] : undefined;
    if (!prev) continue;
    if (prev.count >= limit && !prev.alerted) {
      stuck.push({ key: w.key, pool: b58(w.pool), kind: w.kind, asset: b58(w.asset), holder: w.holder ? b58(w.holder) : null, count: prev.count });
      next[w.key] = { count: prev.count, alerted: true, skip: retryRounds - 1 };
    } else {
      next[w.key] = prev;
    }
  }
  return { table: next, stuck };
}

/// What an upkeep pass sends. One transaction per group: up to `perTx` assets of one holder for a deliver, up
/// to `perTx` queued assets of one pool for a reap. Deliveries go first: a wallet that shows the wrong piece is
/// what a holder sees. Assets that rest after their alert are left out (`resting`). Assets that were sent
/// before and still wait go after the fresh ones, so they never hold healthy work back.
/// At most `maxTx` transactions go out (`send`); the others wait for the next pass (`later`).
export function planUpkeep(work, table = {}, { perTx = ASSETS_PER_UPKEEP_TX, maxTx = UPKEEP_TXS_PER_PASS } = {}) {
  const strikes = (key) => (table && table[key] ? table[key].count : 0);
  const rests = (key) => !!(table && table[key] && table[key].skip > 0);
  const keys = [];
  const resting = [];
  const groups = [];
  const pack = (pool, kind, holder, assets) => {
    const ready = [];
    for (const asset of assets) {
      const key = upkeepKey(pool, kind, asset);
      keys.push(key);
      if (rests(key)) resting.push({ key, pool, kind, holder, asset }); else ready.push({ key, asset });
    }
    ready.sort((a, b) => strikes(a.key) - strikes(b.key));
    for (const part of chunk(ready, perTx)) {
      groups.push({ kind, pool, holder, assets: part.map((x) => x.asset), keys: part.map((x) => x.key), strikes: Math.max(...part.map((x) => strikes(x.key))) });
    }
  };
  for (const w of work) for (const u of w.undelivered) pack(w.pool, "deliver", u.holder, u.assets);
  for (const w of work) pack(w.pool, "reap", null, w.queue);
  const order = groups.map((g, i) => [g, i]).sort((a, b) => a[0].strikes - b[0].strikes || a[1] - b[1]).map(([g]) => g);
  return { keys, send: order.slice(0, maxTx), later: order.slice(maxTx), resting };
}

/// The compute limit, then one deliver or one reap.
export function upkeepInstructions(payer, item) {
  const ix = item.kind === "deliver" ? collectible.deliver(payer, item.pool, item.holder, item.assets) : collectible.reap(payer, item.pool, item.assets);
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: UPKEEP_COMPUTE_UNITS }), ix];
}

/// What a confirmed upkeep transaction did, read from the transaction itself. `burned` counts the PieceBurned
/// events of a reap. `delivered` counts the Metaplex Core calls of a deliver: the program makes one per asset it
/// hands over and none for an asset it skips. rentLamports is what the keeper received: its balance after, minus
/// its balance before, plus the fee. null when there is no transaction to read.
export function upkeepEffect(meta, kind) {
  if (!meta || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) return null;
  let burned = 0; let coreCalls = 0;
  for (const line of meta.logMessages ?? []) {
    if (typeof line !== "string") continue;
    if (line === CORE_CALL) { coreCalls += 1; continue; }
    if (!line.startsWith(EVENT_PREFIX)) continue;
    if (startsWith(Buffer.from(line.slice(EVENT_PREFIX.length), "base64"), EVENT_DISC.PieceBurned)) burned += 1;
  }
  const feeLamports = Number(meta.fee ?? 0);
  const rentLamports = Number(meta.postBalances[0]) - Number(meta.preBalances[0]) + feeLamports;
  return { delivered: kind === "deliver" ? coreCalls : 0, burned: kind === "reap" ? burned : 0, rentLamports, feeLamports, computeUnits: meta.computeUnitsConsumed ?? null };
}

/// Send the planned transactions one after the other. One that fails is recorded and the pass moves on. When
/// it named several assets it is sent again one asset at a time, so one bad asset never holds back the others.
/// `send` and `readEffect` are injectable for the tests.
export async function upkeepAll({ plan, send, readEffect }) {
  const results = [];
  const one = async (item) => {
    try {
      const signature = await send(item);
      let effect = null;
      try { effect = await readEffect(signature, item.kind); } catch { effect = null; }
      results.push({ ...item, signature, effect, error: null });
      return true;
    } catch (e) {
      results.push({ ...item, signature: null, effect: null, error: oneLine(errMsg(e)) });
      return false;
    }
  };
  for (const item of plan) {
    if (await one(item) || item.assets.length === 1) continue;
    for (let i = 0; i < item.assets.length; i++) await one({ ...item, assets: [item.assets[i]], keys: [item.keys[i]] });
  }
  return results;
}

/// The keys of the assets this pass sent a transaction for, whatever came of it.
export function triedKeys(results) { return [...new Set(results.flatMap((r) => r.keys))]; }

/// The end of a round: every asset that was sent this round gets one more round on its count. If it still
/// waits at the next read, upkeepRound sees it. An asset that rests counts one round of rest down.
export function upkeepTried(table, waitingKeys, tried, { retryRounds = UPKEEP_RETRY_ROUNDS } = {}) {
  const sent = new Set(tried);
  const next = { ...(table ?? {}) };
  for (const key of waitingKeys) {
    const prev = next[key];
    if (sent.has(key)) next[key] = { count: (prev ? prev.count : 0) + 1, alerted: !!(prev && prev.alerted), skip: prev && prev.alerted ? retryRounds - 1 : 0 };
    else if (prev) next[key] = { ...prev, skip: Math.max(0, (prev.skip ?? 0) - 1) };
  }
  return next;
}

const assetsWord = (n) => (n === 1 ? "1 asset" : `${n} assets`);

/// The log line of one upkeep transaction.
export function upkeepLine(r) {
  const n = r.assets.length;
  const what = r.kind === "deliver" ? `delivery of ${assetsWord(n)} to wallet ${b58(r.holder)}` : `burn of ${assetsWord(n)} from the burn queue`;
  const head = `pool ${b58(r.pool)}`;
  if (!r.signature) return `upkeep FAILED: ${head}: ${what}: ${r.error}`;
  if (!r.effect) return `upkeep: ${head}: sent a ${what}, the result could not be read, tx ${r.signature}`;
  const e = r.effect;
  if (r.kind === "deliver") {
    const line = `upkeep: ${head}: delivered ${assetsWord(e.delivered)} to wallet ${b58(r.holder)}, tx ${r.signature}`;
    return e.delivered < n ? `${line}. It named ${n}: the others were delivered by somebody else first, or left that wallet.` : line;
  }
  const line = `upkeep: ${head}: burned ${assetsWord(e.burned)} from the burn queue, rent received ${e.rentLamports} lamports, tx ${r.signature}`;
  return e.burned < n ? `${line}. It named ${n}: somebody else burned the others first.` : line;
}

/// One alert for the assets of one pool that got stuck in the same round, all waiting for the same thing.
export function upkeepStuckMessage(events, symbol) {
  const first = events[0];
  const where = symbol || `pool ${first.pool}`;
  const rounds = `after ${first.count} rounds in a row`;
  if (first.kind === "deliver") {
    if (events.length === 1) return `asset ${first.asset} on ${where} is still not delivered to wallet ${first.holder} ${rounds}. The wallet's list holds the piece, Metaplex shows another owner. This should be impossible. Look at it.`;
    return `${events.length} assets on ${where} are still not delivered ${rounds}. The first is ${first.asset}, for wallet ${first.holder}. This should be impossible. Look at them.`;
  }
  if (events.length === 1) return `asset ${first.asset} on ${where} is still in the burn queue ${rounds}. Its piece was burned by a transfer, the asset still exists. This should be impossible. Look at it.`;
  return `${events.length} assets on ${where} are still in the burn queue ${rounds}. The first is ${first.asset}. This should be impossible. Look at them.`;
}

export const NO_UPKEEP_TOTALS = () => ({ deliveries: 0, reaps: 0, failed: 0, delivered: 0, burned: 0, rentLamports: 0, feeLamports: 0 });

/// Add one pass to the running totals. `deliveries` and `reaps` count confirmed transactions, `failed` the ones
/// that were not confirmed, `delivered` and `burned` count assets, `rentLamports` is the rent the burned assets
/// and their queue entries paid to the keeper, `feeLamports` what the keeper paid to send it all.
export function addUpkeepTotals(totals, results) {
  const t = { ...NO_UPKEEP_TOTALS(), ...(totals ?? {}) };
  for (const r of results) {
    if (!r.signature) { t.failed += 1; continue; }
    if (r.kind === "deliver") t.deliveries += 1; else t.reaps += 1;
    if (r.effect) { t.delivered += r.effect.delivered; t.burned += r.effect.burned; t.rentLamports += r.effect.rentLamports; t.feeLamports += r.effect.feeLamports; }
  }
  return t;
}

// ---- network -------------------------------------------------------------------------------------

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/// Every ticket of the hook that still holds pieces, and the slot they are judged at (read once). With `tickets`
/// (every ticket, read by address from the ticket index, lib/tickets.mjs) and `slot` (the slot of that read),
/// nothing is read here: the open ones are picked out of them. Without, one read of the whole program.
export async function readTickets(connection, { tickets = null, slot = null } = {}) {
  if (tickets) return { tickets: tickets.filter((t) => t.pending > 0), slot: BigInt(slot ?? (await connection.getSlot())) };
  const open = await collectible.fetchOpenTickets(connection);
  return { tickets: open, slot: BigInt(await connection.getSlot()) };
}

/// Confirmation by polling the signature status over plain HTTP: no websocket, and bounded in time.
/// `lastValidBlockHeight` may be null (an airdrop has none).
export async function confirmByPolling(connection, signature, lastValidBlockHeight, { timeoutMs = 60000, everyMs = 400 } = {}) {
  const t0 = Date.now();
  for (let n = 1; ; n++) {
    const st = (await connection.getSignatureStatuses([signature])).value[0];
    if (st) {
      if (st.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return st;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("transaction was not confirmed in time");
    if (lastValidBlockHeight !== null && lastValidBlockHeight !== undefined && n % 10 === 0 && (await connection.getBlockHeight()) > lastValidBlockHeight) {
      throw new Error("transaction expired before it was confirmed");
    }
    await pause(everyMs);
  }
}

/// One v0 transaction of up to REVEALS_PER_TX reveals, compiled with the platform lookup table when the client
/// has one, signed and paid by the keeper. Returns the signature once confirmed.
export async function sendRevealTx({ connection, client, keeper, group }) {
  const ixs = group.map((t) => collectible.reveal(keeper.publicKey, t.pool, t.user));
  const { tx, lastValidBlockHeight } = await client.buildTx(keeper.publicKey, ixs);
  tx.sign([keeper]);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await confirmByPolling(connection, signature, lastValidBlockHeight);
  return signature;
}

/// AccountInfo | null for every key, in order, one getMultipleAccountsInfo per hundred.
async function readMany(connection, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 100))));
  return out;
}

/// The wallets above the peg on the given collectible pools, exactly as the SDK's fetchUnbacked lists them for
/// each pool, read for all the pools at once: one read of every ticket of the hook, one batched read of the
/// configs, and one read of the balances per hundred wallets (all pools together). So the cost of a pass does not
/// grow with the number of pools, only with the wallets that hold pieces. When a read fails, every pool is
/// `unread` for this pass and the next pass reads again. With `tickets` (every ticket of the hook, read by address
/// from the ticket index, lib/tickets.mjs) the whole program is not read: the configs and the balances only.
export async function readUnbacked(connection, pools, { tickets = null } = {}) {
  const unbacked = [];
  const unread = [];
  if (!pools.length) return { unbacked, unread };
  try {
    const [cfgInfos, ticketList] = await Promise.all([readMany(connection, pools.map((p) => collectible.collectiblePda.cfg(p))), tickets ? Promise.resolve(tickets) : collectible.fetchTickets(connection)]);
    const all = ticketList;
    const cfgs = new Map();
    pools.forEach((p, i) => {
      const info = cfgInfos[i];
      if (!info) return;
      try { cfgs.set(b58(p), collectible.decodeCollectionConfig(new Uint8Array(info.data))); } catch (e) { unread.push({ pool: b58(p), error: oneLine(errMsg(e)) }); }
    });
    // the SDK's own filter: tickets of these pools that hold or wait for pieces
    const mine = all.filter((t) => cfgs.has(b58(t.pool)) && t.owned.length + t.pending > 0);
    const accounts = mine.map((t) => { const c = cfgs.get(b58(t.pool)); return collectible.coinsAddress(t.user, c.baseMint, c.tokenProgram); });
    const infos = await readMany(connection, accounts);
    mine.forEach((ticket, i) => {
      const c = cfgs.get(b58(ticket.pool));
      const balance = collectible.backingOf(infos[i], ticket.user, c.baseMint, c.tokenProgram);
      const peg = collectible.pegStatus(ticket, balance, c.unit);
      if (peg.dropWaiting > 0 || peg.burn.length > 0) unbacked.push({ ticket, coins: accounts[i], balance, peg });
    });
  } catch (e) {
    for (const p of pools) unread.push({ pool: b58(p), error: oneLine(errMsg(e)) });
  }
  return { unbacked, unread };
}

/// One v0 transaction with one settle, compiled with the platform lookup table when the client has one, signed
/// and paid by the keeper, which receives the rent of the pieces it burns. Returns the signature once confirmed.
export async function sendSettleTx({ connection, client, keeper, item }) {
  const { tx, lastValidBlockHeight } = await client.buildTx(keeper.publicKey, settleInstructions(keeper.publicKey, item));
  tx.sign([keeper]);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await confirmByPolling(connection, signature, lastValidBlockHeight);
  return signature;
}

/// What a confirmed settle did, from its transaction. An RPC may need a moment before it serves a transaction
/// it has just confirmed, so a few tries. null when it never shows up.
export async function readSettleEffect(connection, signature, { tries = 5, everyMs = 400 } = {}) {
  for (let n = 0; n < tries; n++) {
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx && tx.meta) return settleEffect(tx.meta);
    await pause(everyMs);
  }
  return null;
}

/// What waits on the given pools: per pegged pool the assets to deliver, by holder, and the assets in the burn
/// queue. `pools` are pool addresses. A pool whose config does not say `pegged` has nothing to keep up and is
/// left out. A pool whose config cannot be decoded goes to `unread` and never stops the others.
/// Read for all the pegged pools at once, the way the SDK's fetchUndelivered and fetchQueue read one pool: one
/// batched read of the configs and the burn queues, one read of every ticket of the hook, and one read per
/// hundred pieces the lists hold (all pools together). When a read fails, every pool is `unread` for this pass.
/// With `tickets` (every ticket of the hook, read by address from the ticket index) the whole program is not read.
export async function readUpkeep(connection, pools, { tickets: given = null } = {}) {
  const work = [];
  const unread = [];
  if (!pools.length) return { work, unread };
  try {
    const keys = pools.flatMap((p) => [collectible.collectiblePda.cfg(p), collectible.collectiblePda.queue(p)]);
    const [infos, tickets] = await Promise.all([readMany(connection, keys), given ? Promise.resolve(given) : collectible.fetchTickets(connection)]);
    const pegged = [];
    pools.forEach((pool, i) => {
      const cfgInfo = infos[i * 2];
      if (!cfgInfo) return;
      let cfg;
      try { cfg = collectible.decodeCollectionConfig(new Uint8Array(cfgInfo.data)); } catch (e) { unread.push({ pool: b58(pool), error: oneLine(errMsg(e)) }); return; }
      if (!cfg.pegged) return;
      pegged.push({ pool, queueInfo: infos[i * 2 + 1] });
    });
    const byPool = new Map(pegged.map((x) => [b58(x.pool), []]));
    for (const t of tickets) if (t.owned.length > 0 && byPool.has(b58(t.pool))) byPool.get(b58(t.pool)).push(t);
    const assets = [...byPool.values()].flat().flatMap((t) => t.owned);
    const assetInfos = await readMany(connection, assets);
    const owners = assetInfos.map((info) => (info && info.data.length >= 33 && info.data[0] === 1 ? b58(new PublicKey(info.data.subarray(1, 33))) : null));
    let at = 0;
    const ownersOf = new Map();
    for (const t of [...byPool.values()].flat()) { ownersOf.set(t, owners.slice(at, at + t.owned.length)); at += t.owned.length; }
    for (const { pool, queueInfo } of pegged) {
      const undelivered = [];
      for (const t of byPool.get(b58(pool))) {
        const own = ownersOf.get(t);
        const stale = t.owned.filter((_, j) => own[j] !== null && own[j] !== b58(t.user));
        if (stale.length) undelivered.push({ holder: t.user, assets: stale });
      }
      work.push({ pool, undelivered, queue: queueOf(queueInfo) });
    }
  } catch (e) {
    for (const p of pools) unread.push({ pool: b58(p), error: oneLine(errMsg(e)) });
  }
  return { work, unread };
}

/// The assets in a pegged pool's burn queue (the SDK's fetchQueue, from the account already read).
function queueOf(info) {
  if (!info || info.data.length < 44) return [];
  const d = new Uint8Array(info.data);
  const n = new DataView(d.buffer, d.byteOffset + 40, 4).getUint32(0, true);
  return Array.from({ length: Math.min(n, Math.floor((d.length - 44) / 32)) }, (_, i) => new PublicKey(d.subarray(44 + 32 * i, 76 + 32 * i)));
}

/// One v0 transaction with one deliver or one reap, compiled with the platform lookup table when the client has
/// one, signed and paid by the keeper, which receives the rent of what a reap burns. Returns the signature once
/// confirmed.
export async function sendUpkeepTx({ connection, client, keeper, item }) {
  const { tx, lastValidBlockHeight } = await client.buildTx(keeper.publicKey, upkeepInstructions(keeper.publicKey, item));
  tx.sign([keeper]);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await confirmByPolling(connection, signature, lastValidBlockHeight);
  return signature;
}

/// What a confirmed deliver or reap did, from its transaction. A few tries, like readSettleEffect.
export async function readUpkeepEffect(connection, signature, kind, { tries = 5, everyMs = 400 } = {}) {
  for (let n = 0; n < tries; n++) {
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx && tx.meta) return upkeepEffect(tx.meta, kind);
    await pause(everyMs);
  }
  return null;
}
