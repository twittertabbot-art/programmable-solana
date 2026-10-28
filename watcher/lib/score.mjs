// The score of a pool: clean, warning or danger. Pure, so it is tested offline.
//
// The one guarantee that holds on Solana (HOOKS.md section 3): a hook without CALL_ON_SELL is never called on a
// sell, so it can neither block nor tax sells. Such a hook is never marked danger for anything sell related.
//
// One exception, stated as a fact and not as danger: a PEGGED coin. Its transfer hook is the pool's hook program,
// so that program runs inside every transfer of the coin, sells included, whatever the pool's flags say. For such
// a pool a sell that fails inside the swap counts against the hook, as it does for a hook with CALL_ON_SELL.
// Pools with a plain coin are scored exactly as before.
import { FLAGS, HOOK_KIND } from "../../sdk/dist/index.js";

export const TOLERANCE_BPS = 5;
export const RECENT_MS = 24 * 3600 * 1000;
const LEVELS = ["clean", "warning", "danger"];

export function callsOnSell(flags) { return !!(flags & (FLAGS.BEFORE_SWAP | FLAGS.AFTER_SWAP)) && !!(flags & FLAGS.CALL_ON_SELL); }
export function callsOnBuy(flags) { return !!(flags & (FLAGS.BEFORE_SWAP | FLAGS.AFTER_SWAP)) && !!(flags & FLAGS.CALL_ON_BUY); }

/// The cap rule measures hooks that may take a fee. The collectible template takes none (no fee flags, only an
/// after_swap on buys), so a non-zero effective tax there is reported by the declared-mismatch warning instead.
export function capRuleApplies(template) { return template !== "collectible"; }

/// Levels of the alerts raised inside the window, without repeats.
export function recentLevels(alerts, nowMs, windowMs = RECENT_MS) {
  const out = [];
  for (const a of alerts ?? []) {
    const t = Date.parse(a.time);
    if (!Number.isFinite(t) || nowMs - t > windowMs || t > nowMs + 60000) continue;
    if (a.keeper) continue;   // the keeper being late says nothing about the pool or its hook
    if (!out.includes(a.level)) out.push(a.level);
  }
  return out;
}

/// Inputs:
///   hasHook, flags, hookKind (HOOK_KIND), template ("tax" | "launch_guard" | "buyback" | "collectible" | "rules" | "custom" | "none")
///   buySim, sellSim: { ok, stage ("setup" | "swap" | null), error } or null when not simulated
///   effectiveBuyTaxBps, effectiveSellTaxBps: number | null
///   capBps: what the platform caps allow for this hook's flags (simulate.platformCapBps), or null
///   declaredMismatchBps: number | null      taxChangedRecently: bool      rendererMovedRecently: bool      manifestAdminSet: bool
///   upgradeAuthority: base58 | null | "unknown"      recentAlertLevels: ["warning", ...]
///   coinRunsHook: bool      the coin runs this pool's hook program inside every transfer (lib/coin.mjs)
///   coinProblem: string | null      a transfer hook on the coin that the pool should have refused: danger
export function scorePool(i) {
  const notes = [];
  const reasons = [];
  let level = 0;
  const raise = (lvl, why) => { if (lvl > level) level = lvl; if (!reasons.includes(why)) reasons.push(why); };
  const simError = (s) => (s && s.error ? String(s.error) : "unknown error");

  if (!i.hasHook) {
    // A hookless pool whose coin runs a program is not a plain pool: something else is called on every trade.
    if (i.coinProblem) { notes.push("No pool hook."); raise(2, i.coinProblem); }
    else notes.push("No hook. Plain x*y=k pool: nothing can block or tax trades.");
    if (i.buySim && i.buySim.ok === false && i.buySim.stage === "swap") raise(1, `buy simulation failed inside the swap: ${simError(i.buySim)}`);
    if (i.sellSim && i.sellSim.ok === false && i.sellSim.stage === "swap") raise(1, `sell simulation failed inside the swap: ${simError(i.sellSim)}`);
    return { score: LEVELS[level], notes, reasons };
  }

  const poolCallsOnSell = callsOnSell(i.flags ?? 0);
  const sells = poolCallsOnSell || !!i.coinRunsHook;
  if (!sells) notes.push("This hook is never called on a sell (no CALL_ON_SELL flag), so it can never block or tax sells.");
  else if (poolCallsOnSell) notes.push("This hook runs on sells, so every simulation of the pool includes a sell as the largest holder.");
  else notes.push("The pool does not call this hook on a sell (no CALL_ON_SELL flag). The coin still runs the hook's program inside the sell, so every simulation of the pool includes a sell as the largest holder.");
  if (!callsOnBuy(i.flags ?? 0) && !i.coinRunsHook) notes.push("This hook is never called on a buy, so it cannot block or tax buys.");
  // Not a danger to traders: the hook's own income is waiting. Worth a line, so its owner sees it.
  if (i.hookFeesOwed && BigInt(i.hookFeesOwed) > 0n) notes.push(`The hook's fee treasury account is closed. ${BigInt(i.hookFeesOwed)} lamports of fees wait in the pool. Anyone can reopen the account and pay them (collect_hook_fees).`);
  if (i.coinProblem) raise(2, i.coinProblem);

  if (i.sellSim && i.sellSim.ok === false) {
    if (i.sellSim.stage === "swap") {
      if (sells) raise(2, `sell simulation failed inside the swap: ${simError(i.sellSim)}`);
      else raise(1, `sell simulation failed inside the swap, but this hook is never called on sells, so the hook is not the cause: ${simError(i.sellSim)}`);
    } else {
      notes.push(`Sell probe could not be set up (not the hook's doing): ${simError(i.sellSim)}`);
    }
  }
  if (i.buySim && i.buySim.ok === false) {
    if (i.buySim.stage === "swap") raise(1, `buy simulation failed inside the swap: ${simError(i.buySim)}`);
    else notes.push(`Buy probe could not be set up (not the hook's doing): ${simError(i.buySim)}`);
  }

  if (capRuleApplies(i.template) && i.capBps !== null && i.capBps !== undefined) {
    if (i.effectiveBuyTaxBps !== null && i.effectiveBuyTaxBps !== undefined && i.effectiveBuyTaxBps > i.capBps + TOLERANCE_BPS) {
      raise(2, `effective buy tax ${i.effectiveBuyTaxBps} bps is above what the platform caps allow (${i.capBps} bps)`);
    }
    if (sells && i.effectiveSellTaxBps !== null && i.effectiveSellTaxBps !== undefined && i.effectiveSellTaxBps > i.capBps + TOLERANCE_BPS) {
      raise(2, `effective sell tax ${i.effectiveSellTaxBps} bps is above what the platform caps allow (${i.capBps} bps)`);
    }
  }
  if (i.declaredMismatchBps !== null && i.declaredMismatchBps !== undefined && i.declaredMismatchBps > TOLERANCE_BPS) {
    raise(1, `simulated output differs from the declared parameters by ${i.declaredMismatchBps} bps`);
  }
  if (i.taxChangedRecently) raise(1, "the hook's tax changed in the last 24 hours");
  if (i.rendererMovedRecently) raise(1, "the collection renderer moved to another host in the last 24 hours");
  if (i.hookKind === HOOK_KIND.FROZEN && i.template === "custom" && i.manifestAdminSet) raise(1, "frozen custom hook whose manifest names an admin key");
  if (i.hookKind === HOOK_KIND.FROZEN && i.upgradeAuthority && i.upgradeAuthority !== "unknown") raise(2, "a hook recorded as frozen now has an upgrade authority");
  for (const lvl of i.recentAlertLevels ?? []) {
    if (lvl === "danger") raise(2, "a danger alert fired in the last 24 hours");
    else if (lvl === "warning") raise(1, "a warning alert fired in the last 24 hours");
  }
  return { score: LEVELS[level], notes, reasons };
}
