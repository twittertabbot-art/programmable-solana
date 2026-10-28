// Memory between passes: raw bytes of every hook config and manifest, the last alerts, first-seen times,
// the Telegram dedupe table, the settle crank's failure table and totals, the upkeep crank's table of waiting
// assets and totals, the burn keeper's failure table and totals, the graduate crank's failure table, totals and
// last call per pool, the mint crank's totals, the platform's approved list, the digests of the hooks' manifests and
// extra-accounts lists. No secret lives here. Written atomically
// (temp file, then rename).
import fs from "node:fs";
import path from "node:path";

export const STATE_VERSION = 1;
export const MAX_KEPT = 100;

export function emptyState() {
  return {
    version: STATE_VERSION, platform: { snapshot: null, changes: [] }, pools: {}, telegram: { lastSent: {} }, tickets: { seen: {} },
    // The settle crank: the three strikes table, and what it has done since the state was last cleared.
    settle: { fails: {}, totals: { sent: 0, failed: 0, dropped: 0, burned: 0, rentLamports: 0, feeLamports: 0 } },
    // The upkeep crank (pegged coins): the assets that were sent and still wait, and what it has done since the
    // state was last cleared.
    upkeep: { waiting: {}, totals: { deliveries: 0, reaps: 0, failed: 0, delivered: 0, burned: 0, rentLamports: 0, feeLamports: 0 } },
    // The burn keeper (buyback pools and rules pools): the three strikes table, what it has done since the
    // state was last cleared, and what it did per pool.
    burn: { fails: {}, totals: { calls: 0, failed: 0, observed: 0, waited: 0, bought: 0, spentLamports: 0, feeLamports: 0 }, pools: {} },
    // The graduate crank (pools on the curve): the three strikes table, what it has done since the state was last
    // cleared, and what it did per pool (the last call, so that a pool it graduated is not sent another one).
    graduate: { fails: {}, totals: { sent: 0, failed: 0, graduated: 0, already: 0, feeLamports: 0 }, pools: {} },
    // The mint crank (collectible coins, one approval): what it has done since the state was last cleared. Its
    // watch list lives in memory only: the sweep at the start reads every ticket again.
    mint: { totals: { sent: 0, failed: 0, pieces: 0, paidLamports: 0, feeLamports: 0, netLamports: 0, mintedFirst: 0, short: 0, refused: 0, lastSlotsAfterBuy: null } },
    // The platform's approved-list rule and list as the last pass read them (lib/approvals.mjs): null until a pass
    // recorded them.
    approvals: null,
    // The digests of the manifest and the extra-accounts list of every hook program a pool used, by program
    // (lib/hookaccounts.mjs).
    hookAccounts: {},
  };
}

export function emptyPoolState(nowIso) {
  return {
    firstSeen: nowIso, cfg: null, manifest: null, upgradeAuthority: null, sellOk: null, buyOk: null,
    lastSimAt: null, lastTaxChangeAt: null, lastRendererMoveAt: null, configChanges: [], alerts: [], lastEntry: null,
  };
}

export function loadState(file) {
  try {
    if (!fs.existsSync(file)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const e = emptyState();
    if (parsed && typeof parsed === "object") {
      if (parsed.platform && typeof parsed.platform === "object") {
        e.platform = { snapshot: parsed.platform.snapshot ?? null, changes: Array.isArray(parsed.platform.changes) ? parsed.platform.changes : [] };
      }
      if (parsed.pools && typeof parsed.pools === "object" && !Array.isArray(parsed.pools)) e.pools = parsed.pools;
      const t = parsed.telegram;
      if (t && typeof t === "object" && t.lastSent && typeof t.lastSent === "object") e.telegram.lastSent = t.lastSent;
      const k = parsed.tickets;
      if (k && typeof k === "object" && k.seen && typeof k.seen === "object" && !Array.isArray(k.seen)) e.tickets.seen = k.seen;
      const st = parsed.settle;
      if (st && typeof st === "object") {
        if (st.fails && typeof st.fails === "object" && !Array.isArray(st.fails)) e.settle.fails = st.fails;
        if (st.totals && typeof st.totals === "object") {
          for (const name of Object.keys(e.settle.totals)) if (Number.isFinite(st.totals[name])) e.settle.totals[name] = st.totals[name];
        }
      }
      const up = parsed.upkeep;
      if (up && typeof up === "object") {
        if (up.waiting && typeof up.waiting === "object" && !Array.isArray(up.waiting)) e.upkeep.waiting = up.waiting;
        if (up.totals && typeof up.totals === "object") {
          for (const name of Object.keys(e.upkeep.totals)) if (Number.isFinite(up.totals[name])) e.upkeep.totals[name] = up.totals[name];
        }
      }
      const bn = parsed.burn;
      if (bn && typeof bn === "object") {
        if (bn.fails && typeof bn.fails === "object" && !Array.isArray(bn.fails)) e.burn.fails = bn.fails;
        if (bn.pools && typeof bn.pools === "object" && !Array.isArray(bn.pools)) e.burn.pools = bn.pools;
        if (bn.totals && typeof bn.totals === "object") {
          for (const name of Object.keys(e.burn.totals)) if (Number.isFinite(bn.totals[name])) e.burn.totals[name] = bn.totals[name];
        }
        if (bn.syncTotals && typeof bn.syncTotals === "object") {
          e.burn.syncTotals = { sent: 0, failed: 0, records: 0, feeLamports: 0 };
          for (const name of Object.keys(e.burn.syncTotals)) if (Number.isFinite(bn.syncTotals[name])) e.burn.syncTotals[name] = bn.syncTotals[name];
        }
      }
      const gr = parsed.graduate;
      if (gr && typeof gr === "object") {
        if (gr.fails && typeof gr.fails === "object" && !Array.isArray(gr.fails)) e.graduate.fails = gr.fails;
        if (gr.pools && typeof gr.pools === "object" && !Array.isArray(gr.pools)) e.graduate.pools = gr.pools;
        if (gr.totals && typeof gr.totals === "object") {
          for (const name of Object.keys(e.graduate.totals)) if (Number.isFinite(gr.totals[name])) e.graduate.totals[name] = gr.totals[name];
        }
      }
      const mi = parsed.mint;
      if (mi && typeof mi === "object" && mi.totals && typeof mi.totals === "object") {
        for (const name of Object.keys(e.mint.totals)) if (Number.isFinite(mi.totals[name])) e.mint.totals[name] = mi.totals[name];
      }
      const ap = parsed.approvals;
      if (ap && typeof ap === "object" && Array.isArray(ap.programs)) e.approvals = { required: !!ap.required, programs: ap.programs.filter((p) => typeof p === "string"), corrupt: !!ap.corrupt };
      const ha = parsed.hookAccounts;
      if (ha && typeof ha === "object" && !Array.isArray(ha)) e.hookAccounts = ha;
    }
    return e;
  } catch {
    try { fs.renameSync(file, `${file}.broken.${Date.now()}`); } catch { /* nothing to set aside */ }
    return emptyState();
  }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

/// Keep the newest `max` entries of a list that is appended in time order.
export function trimList(list, max = MAX_KEPT) {
  return list.length > max ? list.slice(list.length - max) : list;
}
