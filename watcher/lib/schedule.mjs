// When the pool pass simulates a pool with a hook again.
//
// A simulated buy and sell cost about ten RPC calls a pool. Run every minute on every pool, that cost grows with
// the number of coins, not with trading. The answer of a simulation depends on: the pool account (reserves,
// flags, fees), the hook's per-pool config and manifest, its account list, the hook program itself, the
// platform's caps and pause, and, on a few templates, the slot. So a pool is simulated again only when:
//
//   - it was never simulated, or its last simulations were not kept (`first`);
//   - any of those accounts changed since (`changed`): the key below is a digest of their bytes, so a trade, a
//     tax change, an upgrade of the hook program or a new platform cap all count;
//   - a window of its hook runs now, whose fee or limit moves with the slot (`window`): the launch guard's fee,
//     the sniper fee and the buy limit of a rules coin, the max wallet, early window and early lock of a strict
//     coin. These windows last minutes after a launch;
//   - the last buy probe could not be set up because the probe wallet had no SOL (`retry`);
//   - its last simulations are older than SIM_MAX_AGE_MINUTES (`age`, default 60).
//
// Otherwise the pass keeps the last simulations and runs every other check as before: the config and manifest
// diffs, the upgrade authority, the coin's mint, the score.
import crypto from "node:crypto";
import { guardFee, rulesSniperFee, rulesBuyLimit, RULES_KIND, strictMaxWalletRuns, strictEarlyWindowRuns, strictEarlyLocked } from "../../sdk/dist/index.js";

export const SIM_REASONS = ["first", "changed", "window", "retry", "age"];

/// A digest of everything a simulation's answer depends on, apart from the slot. Byte arrays, strings or null.
export function simKey({ poolBytes = null, cfgBytes = null, manifestBytes = null, extraMetasBytes = null, deploySlot = null, upgradeAuthority = null, platform = null } = {}) {
  const h = crypto.createHash("sha256");
  const part = (name, v) => {
    h.update(name); h.update("=");
    if (v === null || v === undefined) h.update("none");
    else if (typeof v === "string") h.update(v);
    else h.update(Buffer.from(v));
    h.update(";");
  };
  part("pool", poolBytes); part("cfg", cfgBytes); part("manifest", manifestBytes); part("metas", extraMetasBytes);
  part("deploy", deploySlot === null || deploySlot === undefined ? null : String(deploySlot));
  part("authority", upgradeAuthority === null || upgradeAuthority === undefined ? null : String(upgradeAuthority));
  part("platform", platform === null || platform === undefined ? null : JSON.stringify(platform));
  return h.digest("hex");
}

/// Does a window of this hook run at `slot`, during which its answer moves with the slot? `hook` is the decoded
/// hook of lib/chain.mjs (with `guard` or `rules`), `pool` the decoded pool.
export function windowRuns(hook, pool, slot) {
  if (!hook || slot === null || slot === undefined) return false;
  const at = BigInt(slot);
  if (hook.template === "launch_guard" && hook.guard) {
    const g = hook.guard;
    return g.startSlot !== 0n && guardFee(at, g.startSlot, g.guardSlots, g.startFeeBps, pool.lpFeeBps) !== null;
  }
  if (hook.template === "rules" && hook.rules) {
    const r = hook.rules;
    if (rulesSniperFee(at, r.startSlot, r.sniperSlots, r.sniperStartFeeBps, pool.lpFeeBps) !== null) return true;
    if (rulesBuyLimit(r, at)) return true;
    if (r.kind === RULES_KIND.STRICT && (strictMaxWalletRuns(r, at) || strictEarlyWindowRuns(r, at) || strictEarlyLocked(r, at))) return true;
  }
  return false;
}

/// Is the pool due for new simulations? `last` is what the pool's state kept of its last ones ({ at, key, retry })
/// or null. Answers { due, reason } with a reason of SIM_REASONS, or null when the last ones are kept.
export function simulationDue({ last, key, nowMs, maxAgeMs, windowRunning = false }) {
  if (!last || !last.at || !last.key || !last.buy || !last.sell) return { due: true, reason: "first" };
  if (last.key !== key) return { due: true, reason: "changed" };
  if (windowRunning) return { due: true, reason: "window" };
  if (last.retry) return { due: true, reason: "retry" };
  const age = nowMs - Date.parse(last.at);
  if (!Number.isFinite(age) || age >= maxAgeMs) return { due: true, reason: "age" };
  return { due: false, reason: null };
}

/// A simulation's result as the state file keeps it (bigints as strings), and back.
export function simToJson(x) {
  if (!x) return null;
  const s = (v) => (v === null || v === undefined ? null : v.toString());
  return {
    ok: !!x.ok, error: x.error ?? null, amountOut: s(x.amountOut), stage: x.stage ?? null, holder: x.holder ?? null, amountIn: s(x.amountIn), slot: x.slot ?? null,
    probeLimit: x.probeLimit ? { maxBuyQuote: s(x.probeLimit.maxBuyQuote), untilSlot: s(x.probeLimit.untilSlot) } : null,
    probeMaxWallet: x.probeMaxWallet ? { amount: s(x.probeMaxWallet.amount), untilSlot: s(x.probeMaxWallet.untilSlot) } : null,
  };
}
export function simFromJson(x) {
  if (!x) return null;
  const b = (v) => (v === null || v === undefined ? null : BigInt(v));
  const out = { ok: !!x.ok, error: x.error ?? null, amountOut: b(x.amountOut), stage: x.stage ?? null, holder: x.holder ?? null, amountIn: b(x.amountIn), slot: x.slot ?? null };
  if (x.probeLimit) out.probeLimit = { maxBuyQuote: b(x.probeLimit.maxBuyQuote), untilSlot: b(x.probeLimit.untilSlot) };
  if (x.probeMaxWallet) out.probeMaxWallet = { amount: b(x.probeMaxWallet.amount), untilSlot: b(x.probeMaxWallet.untilSlot) };
  return out;
}

/// A crank pass that found nothing to do may skip the next passes while what it depends on stays the same: the
/// reveal crank and the burn keeper on a digest of their pools' accounts (a buy is what makes pieces wait, a trade is
/// what fills a pot), the upkeep crank on the newest signature of the collectible program. `quiet` is
/// { key, since } or null; at most `maxMs` after `since` the pass reads everything again.
export function quietSkip(quiet, key, nowMs, maxMs) {
  return !!quiet && key !== null && key !== undefined && quiet.key === key && nowMs - quiet.since < maxMs;
}
/// What a pass leaves for the next ones: null when it found something to do (`idle` false), else the key it read
/// with the time the quiet began (kept while the key stays the same and `maxMs` has not run out).
export function quietAfter(quiet, key, idle, nowMs, maxMs) {
  if (!idle || key === null || key === undefined) return null;
  const since = quiet && quiet.key === key && nowMs - quiet.since < maxMs ? quiet.since : nowMs;
  return { key, since };
}

/// The note on a pool whose last simulations were kept.
export function keptNote(at, maxAgeMinutes) {
  return `Simulated at ${at}. Nothing the simulations depend on changed since: the pool, its hook's config and manifest, the hook program and the platform. They run again at the next change, while a launch window runs, and at least every ${maxAgeMinutes} minutes.`;
}
