// The status file the website reads. The schema is fixed here; anything the checks produce is squeezed into it.
//
// The site prints a pool's simulation errors, its alerts and its notes as they stand here. So every one of them
// passes plainText (lib/plain.mjs) on the way in: no raw RPC answer, no JSON, no RPC address with its key.
import fs from "node:fs";
import path from "node:path";
import { plainText } from "./plain.mjs";
import { HOOK_APPROVALS } from "./approvals.mjs";

export const SCORES = ["clean", "warning", "danger"];
export const TEMPLATES = ["tax", "launch_guard", "buyback", "collectible", "rules", "custom", "none"];
export const BURN_STEPS = ["nothing", "observe", "tooSoon", "wait", "buy"];
export const BURN_OUTCOMES = ["observed", "waited", "bought", "failed"];
export const KINDS = ["none", "frozen", "platform"];
export const COIN_KINDS = ["plain", "pegged", "mismatch", "unknown"];
export const COIN_PROGRAMS = ["spl-token", "token-2022", "unknown"];
export const CURVE_STATES = ["open", "graduated"];

export const jsonReplacer = (_, v) => (typeof v === "bigint" ? v.toString() : v);
const s = (v) => (v === null || v === undefined ? null : typeof v === "bigint" ? v.toString() : String(v));
const n = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/// Words for the site: a text without JSON and without an RPC address (null stays null). A note or an alert is
/// never cut; a simulation's error is one line of at most 600 characters.
const words = (v, max = Infinity) => (v === null || v === undefined ? null : plainText(String(v), max));

function sim(x, withHolder) {
  const out = { ok: !!(x && x.ok), error: x ? (x.error === undefined ? null : words(x.error, 600)) : "not simulated", amountOut: x ? s(x.amountOut) : null };
  if (withHolder) out.holder = x ? s(x.holder) : null;
  return out;
}

/// One pool entry in the exact shape the site consumes. Unknown fields are dropped, missing ones become null.
export function poolEntry(e) {
  const out = {
    lastCheck: s(e.lastCheck),
    score: SCORES.includes(e.score) ? e.score : "warning",
    hookKind: KINDS.includes(e.hookKind) ? e.hookKind : "none",
    template: TEMPLATES.includes(e.template) ? e.template : "none",
    buySim: sim(e.buySim, false),
    sellSim: sim(e.sellSim, true),
    effectiveBuyTaxBps: n(e.effectiveBuyTaxBps),
    effectiveSellTaxBps: n(e.effectiveSellTaxBps),
    declared: e.declared && typeof e.declared === "object" ? JSON.parse(JSON.stringify(e.declared, jsonReplacer)) : null,
    configChanges: (e.configChanges ?? []).map((c) => ({ time: s(c.time), slot: n(c.slot) ?? 0, field: String(c.field), from: s(c.from) ?? "none", to: s(c.to) ?? "none" })),
    alerts: (e.alerts ?? []).map((a) => ({ time: s(a.time), level: ["info", "warning", "danger"].includes(a.level) ? a.level : "info", message: words(a.message) ?? "" })),
    notes: (e.notes ?? []).map((t) => words(t) ?? ""),
  };
  // Only collectible pools carry tickets; every other entry keeps the exact base schema.
  if (e.tickets && typeof e.tickets === "object") {
    out.tickets = { open: n(e.tickets.open) ?? 0, undecided: n(e.tickets.undecided) ?? 0, awaitingReveal: n(e.tickets.awaitingReveal) ?? 0, expired: n(e.tickets.expired) ?? 0 };
  }
  // Only collectible pools carry the coin: what kind of coin backs the pieces, as read from its mint.
  if (e.coin && typeof e.coin === "object") {
    out.coin = {
      kind: COIN_KINDS.includes(e.coin.kind) ? e.coin.kind : "unknown",
      tokenProgram: COIN_PROGRAMS.includes(e.coin.tokenProgram) ? e.coin.tokenProgram : "unknown",
      transferHookProgram: s(e.coin.transferHookProgram), transferHookAuthority: s(e.coin.transferHookAuthority),
    };
  }
  // Only pools that launched on the curve carry the curve: where the pool stands, as the trade API's quote says
  // it (lamports as strings, shares in basis points). A seeded pool's entry has no `curve`.
  if (e.curve && typeof e.curve === "object" && CURVE_STATES.includes(e.curve.state)) {
    const c = e.curve;
    out.curve = {
      state: c.state, virtualQuote: s(c.virtualQuote) ?? "0", raised: s(c.raised) ?? "0", target: s(c.target) ?? "0",
      raisedBps: n(c.raisedBps) ?? 0, soldBps: n(c.soldBps), graduationFeeBps: n(c.graduationFeeBps) ?? 0, graduates: c.graduates === true,
    };
  }
  // Where the pool's hook stands with the platform's approved list (lib/approvals.mjs), on every pool while the
  // check runs: "own", "approved" or "not approved". The site warns on "not approved".
  if (HOOK_APPROVALS.includes(e.hookApproval)) out.hookApproval = e.hookApproval;
  // Pools with a hook, while the hook accounts are followed (lib/hookaccounts.mjs): the slot of the last pass that
  // saw the hook's manifest or extra-accounts list change, null while none did.
  if (Object.prototype.hasOwnProperty.call(e, "hookAccountsChangedAtSlot")) out.hookAccountsChangedAtSlot = n(e.hookAccountsChangedAtSlot);
  // Pools whose hook runs on sells, while the sells as recent buyers run (lib/holdersells.mjs): null, or the last
  // check in which the hook refused some of those wallets' sells while the sell probe went through.
  if (Object.prototype.hasOwnProperty.call(e, "holderSellFails")) {
    const f = e.holderSellFails;
    out.holderSellFails = f && typeof f === "object" ? {
      at: s(f.at), tried: n(f.tried) ?? 0, failed: n(f.failed) ?? 0,
      wallets: (Array.isArray(f.wallets) ? f.wallets : []).map((w) => ({ wallet: s(w.wallet), error: words(w.error, 600) ?? "" })),
    } : null;
  }
  // Only buyback and rules pools carry the burn: what waits to be spent on the coin, what a call would do now,
  // and what this watcher's burn keeper did on the pool.
  if (e.burn && typeof e.burn === "object") {
    const k = e.burn.keeper && typeof e.burn.keeper === "object" ? e.burn.keeper : {};
    out.burn = {
      pot: s(e.burn.pot) ?? "0", capBps: n(e.burn.capBps) ?? 0,
      step: BURN_STEPS.includes(e.burn.step) ? e.burn.step : "nothing",
      observedAtSlot: n(e.burn.observedAtSlot), nextCallAtSlot: n(e.burn.nextCallAtSlot),
      keeper: {
        calls: n(k.calls) ?? 0, bought: n(k.bought) ?? 0, spentLamports: n(k.spentLamports) ?? 0,
        lastAt: s(k.lastAt), lastOutcome: BURN_OUTCOMES.includes(k.lastOutcome) ? k.lastOutcome : null,
      },
    };
  }
  return out;
}

/// The mint crank's part of the status file (collectible coins, one approval): whether this watcher mints the
/// pieces of buys that paid a deposit, how often it looks, and what it has done (counts and lamports, the same
/// numbers as /health). null when the watcher has no mint crank to report.
export function mintCrankPart(m) {
  if (!m || typeof m !== "object") return null;
  const t = m.totals && typeof m.totals === "object" ? m.totals : {};
  return {
    enabled: !!m.enabled, intervalSeconds: n(m.intervalSeconds) ?? 0, lastAt: s(m.lastAt), watching: n(m.watching) ?? 0,
    sent: n(t.sent) ?? 0, failed: n(t.failed) ?? 0, pieces: n(t.pieces) ?? 0, paidLamports: n(t.paidLamports) ?? 0, feeLamports: n(t.feeLamports) ?? 0,
    netLamports: n(t.netLamports) ?? 0, mintedFirst: n(t.mintedFirst) ?? 0, short: n(t.short) ?? 0, refused: n(t.refused) ?? 0, lastSlotsAfterBuy: n(t.lastSlotsAfterBuy),
  };
}

/// The platform's approved list for the status file: the rule, the programs on the list and whether the list can
/// be read. null when the watcher does not follow it (APPROVAL_WATCH=off).
export function approvedListPart(a) {
  if (!a || typeof a !== "object") return null;
  return { required: !!a.required, programs: (Array.isArray(a.programs) ? a.programs : []).map((p) => s(p)), corrupt: !!a.corrupt };
}

export function buildStatus({ updatedAt, cluster, platform, platformChanges, pools, mintCrank = null, approvedList = null }) {
  const mint = mintCrankPart(mintCrank);
  const approved = approvedListPart(approvedList);
  return {
    updatedAt,
    cluster,
    platform: {
      paused: !!platform.paused,
      whitelist: (platform.whitelist ?? []).map((k) => s(k)),
      protocolFeeBps: n(platform.protocolFeeBps) ?? 0,
      maxHookFeeBps: n(platform.maxHookFeeBps) ?? 0,
      maxFeeOverrideBps: n(platform.maxFeeOverrideBps) ?? 0,
      treasury: s(platform.treasury),
      admin: s(platform.admin),
      changes: (platformChanges ?? []).map((c) => ({ time: s(c.time), field: String(c.field), from: s(c.from) ?? "none", to: s(c.to) ?? "none" })),
    },
    pools: Object.fromEntries(Object.entries(pools ?? {}).map(([k, v]) => [k, poolEntry(v)])),
    ...(mint ? { mintCrank: mint } : {}),
    ...(approved ? { approvedList: approved } : {}),
  };
}

/// Temp file in the same folder, then rename: a reader never sees half a file.
export function writeStatusAtomic(file, status) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, jsonReplacer, 1));
  fs.renameSync(tmp, file);
}

export function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

const pad = (v, w) => { const t = String(v ?? ""); return t.length >= w ? t.slice(0, w) : t + " ".repeat(w - t.length); };
const fmtOut = (x) => (!x ? "-" : x.ok ? `ok ${x.amountOut}` : `FAIL ${x.error ?? ""}`);

/// Plain ASCII table for --once. symbols: { pool: symbol }.
export function summaryTable(status, symbols = {}) {
  const cols = [["POOL", 44], ["SYM", 7], ["HOOK", 13], ["KIND", 9], ["SCORE", 8], ["BUY", 22], ["SELL", 22], ["BUYTAX", 7], ["SELLTAX", 8]];
  const head = cols.map(([t, w]) => pad(t, w)).join(" ");
  const rows = [head, "-".repeat(head.length)];
  const counts = { clean: 0, warning: 0, danger: 0 };
  for (const [addr, p] of Object.entries(status.pools)) {
    counts[p.score] = (counts[p.score] ?? 0) + 1;
    const buy = p.buySim.ok ? `ok ${p.buySim.amountOut}` : `FAIL ${(p.buySim.error ?? "").slice(0, 16)}`;
    const sell = p.sellSim.ok ? `ok ${p.sellSim.amountOut}` : `FAIL ${(p.sellSim.error ?? "").slice(0, 16)}`;
    rows.push([
      pad(addr, 44), pad(symbols[addr] ?? "", 7), pad(p.template, 13), pad(p.hookKind, 9), pad(p.score, 8),
      pad(buy, 22), pad(sell, 22), pad(p.effectiveBuyTaxBps ?? "-", 7), pad(p.effectiveSellTaxBps ?? "-", 8),
    ].join(" "));
  }
  rows.push("-".repeat(head.length));
  rows.push(`${Object.keys(status.pools).length} pools: ${counts.clean} clean, ${counts.warning} warning, ${counts.danger} danger. updated ${status.updatedAt} cluster ${status.cluster} paused ${status.platform.paused}`);
  return rows.join("\n");
}

export { fmtOut };
