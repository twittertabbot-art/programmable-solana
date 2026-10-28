// The two accounts every hook program writes once, at setup: its manifest and its extra-accounts list (review
// rule 6). A rewritten list can stop every pool on the hook at once, so the pool pass hashes both, for every
// distinct hook program a pool uses, and alerts on any change. The bytes come from the pass's own batched read of
// the hooks (lib/chain.mjs readHooks: one getMultipleAccountsInfo per hundred accounts, each account asked for
// once): this check costs no call. The first pass, and the first pass that sees a program, only record.
import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { pda } from "../../sdk/dist/index.js";

export const HOOK_ACCOUNT_KINDS = ["manifest", "extraMetas"];
const WORDS = { manifest: "manifest", extraMetas: "extra-accounts list" };
/// The changes of one hook program the state keeps.
export const HOOK_ACCOUNT_CHANGES_KEPT = 20;

/// SHA-256 of an account's data in hex, or null for an account that does not exist.
export function digestOf(bytes) {
  return bytes ? crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex") : null;
}

/// Every distinct hook program of `pools`, with the digests of its two accounts as `hooks` (readHooks, by pool
/// address) holds them and the pools on it: Map program -> { manifest, extraMetas, pools }.
export function hookAccountsOf(pools, hooks) {
  const out = new Map();
  for (const p of pools) {
    if (!p.hasHook) continue;
    const h = hooks.get(p.address.toBase58());
    if (!h) continue;
    const k = p.hookProgram.toBase58();
    if (!out.has(k)) out.set(k, { manifest: digestOf(h.manifestBytes), extraMetas: digestOf(h.extraMetasBytes), pools: [] });
    out.get(k).pools.push(p.address.toBase58());
  }
  for (const v of out.values()) v.pools.sort();
  return out;
}

/// Compares `current` (hookAccountsOf) with what the state holds (`kept`: { [program]: { manifest, extraMetas,
/// firstSeenAt, changedAtSlot, changedAt, changes } }), writes the new digests into it, and answers the changes:
/// [{ program, account, address, from, to, pools, slot }]. A program the state does not hold yet is recorded.
export function trackHookAccounts(kept, current, { slot = null, nowIso }) {
  const changes = [];
  for (const [program, now] of current) {
    const prev = kept[program];
    if (!prev) {
      kept[program] = { manifest: now.manifest, extraMetas: now.extraMetas, firstSeenAt: nowIso, changedAtSlot: null, changedAt: null, changes: [] };
      continue;
    }
    for (const account of HOOK_ACCOUNT_KINDS) {
      if (prev[account] === now[account]) continue;
      const address = (account === "manifest" ? pda.manifest : pda.extraMetas)(new PublicKey(program)).toBase58();
      changes.push({ program, account, address, from: prev[account], to: now[account], pools: now.pools, slot });
      prev[account] = now[account];
      prev.changedAtSlot = slot;
      prev.changedAt = nowIso;
      prev.changes = [...(Array.isArray(prev.changes) ? prev.changes : []), { time: nowIso, slot, account, from: shortDigest(changes[changes.length - 1].from), to: shortDigest(now[account]) }].slice(-HOOK_ACCOUNT_CHANGES_KEPT);
    }
  }
  return changes;
}

const shortDigest = (d) => (d ? d.slice(0, 16) : "none");

/// The alert of one change: danger for the extra-accounts list (it can stop every pool on the hook), warning for
/// the manifest (it changes what new pools are told, never a pool's flags).
export function hookAccountAlert(c) {
  const what = WORDS[c.account];
  const how = c.to === null ? "closed" : c.from === null ? "created" : "rewrote";
  const pools = c.pools.length ? c.pools.join(", ") : "none";
  return {
    level: c.account === "extraMetas" ? "danger" : "warning",
    message: `hook ${c.program} ${how} its ${what} (account ${c.address})${c.slot !== null && c.slot !== undefined ? ` at slot ${c.slot}` : ""}: a hook writes it once, at setup. ${c.account === "extraMetas" ? "A rewritten list can stop every pool on the hook. " : ""}Pools on it: ${pools}`,
  };
}
