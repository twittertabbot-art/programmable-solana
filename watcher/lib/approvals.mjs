// The platform's approved list (HOOKS.md section 6.1), as the pool pass follows it. While the rule is on, a pool
// can open on a hook that is not the platform's own only when its program is on the list. The pass reads the
// platform anyway: the rule and the list cost no call of their own. Pure, so it is tested offline.
import { HOOK_KIND, isTemplateProgram } from "../../sdk/dist/index.js";

/// What `hookApproval` of a pool in the status file can be.
///   own           no hook, or one of the platform's own hooks (a template, or a hook whose upgrade authority the
///                 platform whitelists): these never need approval
///   approved      an outside hook whose program is on the approved list
///   not approved  an outside hook whose program is not on the list (a pool made before the rule, or a hook taken
///                 off the list), or a list the program cannot read. The site warns on these.
export const HOOK_APPROVALS = ["own", "approved", "not approved"];

/// The rule and the list as the state keeps them: the programs sorted, in base58.
export function approvalSnapshot(platform) {
  return {
    required: !!platform.hookApprovalRequired,
    programs: (platform.approvedHooks ?? []).map((k) => (typeof k === "string" ? k : k.toBase58())).sort(),
    corrupt: !!platform.approvedListCorrupt,
  };
}

/// Where one pool stands with the list (`snapshot` from approvalSnapshot).
export function hookApprovalOf(pool, snapshot) {
  if (!pool.hasHook) return "own";
  if (pool.hookKind !== HOOK_KIND.FROZEN || isTemplateProgram(pool.hookProgram)) return "own";
  if (snapshot && !snapshot.corrupt && snapshot.programs.includes(pool.hookProgram.toBase58())) return "approved";
  return "not approved";
}

/// What changed from one snapshot to the next: { kind: "rule", required }, { kind: "corrupt", corrupt },
/// { kind: "approved", program }, { kind: "revoked", program }. No previous snapshot (the first pass, or a state
/// written before this check existed): nothing, the snapshot is only recorded. A list that cannot be read is not a
/// list of nothing: no program is reported as taken off while it is so (see `nextSnapshot`).
export function diffApprovals(prev, next) {
  if (!prev) return [];
  const out = [];
  if (!!prev.required !== !!next.required) out.push({ kind: "rule", required: !!next.required });
  if (!!prev.corrupt !== !!next.corrupt) out.push({ kind: "corrupt", corrupt: !!next.corrupt });
  if (!next.corrupt) {
    const before = new Set(prev.programs ?? []);
    const after = new Set(next.programs ?? []);
    for (const p of after) if (!before.has(p)) out.push({ kind: "approved", program: p });
    for (const p of before) if (!after.has(p)) out.push({ kind: "revoked", program: p });
  }
  return out;
}

/// The snapshot to keep: while the list cannot be read, the last list that could.
export function nextSnapshot(prev, next) {
  return next.corrupt && prev ? { ...next, programs: [...(prev.programs ?? [])] } : next;
}

/// The pools of each hook program, by its base58 id.
export function poolsByHook(pools) {
  const out = new Map();
  for (const p of pools) {
    if (!p.hasHook) continue;
    const k = p.hookProgram.toBase58();
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(p.address.toBase58());
  }
  for (const list of out.values()) list.sort();
  return out;
}

const listOf = (pools) => (pools && pools.length ? pools.join(", ") : "none");

/// The alert of each change, and the line of each in the platform's `changes` ({ field, from, to }).
export function approvalAlerts(changes, byHook = new Map()) {
  return changes.map((c) => {
    if (c.kind === "rule") {
      return c.required
        ? { level: "info", message: "the approved-list rule is now on: a pool can open on an outside hook only when its program is on the approved list", change: { field: "hookApprovalRequired", from: "false", to: "true" } }
        : { level: "warning", message: "the approved-list rule is now off: a pool can open on any frozen outside hook, reviewed or not", change: { field: "hookApprovalRequired", from: "true", to: "false" } };
    }
    if (c.kind === "corrupt") {
      return c.corrupt
        ? { level: "danger", message: "the approved list after the platform account cannot be read: while it is so the pool program refuses every outside hook that needs the list", change: { field: "approvedListCorrupt", from: "false", to: "true" } }
        : { level: "info", message: "the approved list after the platform account can be read again", change: { field: "approvedListCorrupt", from: "true", to: "false" } };
    }
    const pools = byHook.get(c.program) ?? [];
    if (c.kind === "approved") {
      return { level: "info", message: `hook ${c.program} was approved: it is on the approved list now. Pools on it: ${listOf(pools)}`, change: { field: "approvedHooks", from: "none", to: c.program } };
    }
    return { level: "warning", message: `hook ${c.program} was taken off the approved list: no new pool can open on it, and the pools that use it keep it: ${listOf(pools)}`, change: { field: "approvedHooks", from: c.program, to: "none" } };
  });
}
