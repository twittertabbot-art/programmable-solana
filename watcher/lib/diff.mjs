// Diffing: platform snapshot, hook per-pool config account, hook manifest, upgrade authority. Pure functions fed
// with raw bytes, so a change can be replayed offline in the tests.
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { HOOK_KIND, RULES_CEILINGS, RULES_STRICT_CEILINGS, decodeTaxConfig, decodeGuardConfig, decodeBuybackConfig, decodeRulesConfig, decodeHookManifest, rulesProblems, strictProblems, collectible } from "../../sdk/dist/index.js";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
/// A rules config never changes in bytes 8 to 239 once its pool exists (RULES.md, "Config layout"): the two
/// bumps, the five addresses, the rules, and the three numbers the pool's creation wrote. Bytes 240 to 373 are
/// running numbers. Bytes 374 to 413 are the strict part (RULES.md, "The strict coin"): the kind and the
/// strict numbers never change either (374, 376 to 396), the buy mark (375) is 0 whenever anybody can read the
/// account, and 397 to 413 are a reserve of zeros. So everything outside 240 to 373 is watched.
export const RULES_FIXED_START = 8;
export const RULES_FIXED_END = 240;
export const RULES_STRICT_START = 374;
export const RULES_BUY_MARK = 375;
export const RULES_RESERVED_START = 397;
export const RULES_SIZE = 414;

/// Host (with port) of a renderer base uri. A string that is not a url is its own "host", so any change of it
/// counts as a move.
export function uriHost(uri) {
  try { return new URL(String(uri)).host || String(uri); } catch { return String(uri); }
}

const str = (v) => {
  if (v === null || v === undefined) return "none";
  if (typeof v === "bigint") return v.toString();
  if (v instanceof PublicKey) return v.toBase58();
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(str).join(",") || "(empty)";
  return String(v);
};

export function digest(bytes) {
  if (!bytes) return "none";
  return `${bytes.length} bytes sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
}

export function bytesEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/// Flat, comparable fields of a template's per-pool config. null when not a known template or undecodable.
export function decodeConfigFields(template, bytes) {
  if (!bytes) return null;
  try {
    if (template === "tax") {
      const t = decodeTaxConfig(bytes);
      return { buyBps: t.buyBps, sellBps: t.sellBps, maxBps: t.maxBps, owner: t.owner.toBase58(), renounced: t.renounced };
    }
    if (template === "launch_guard") {
      const g = decodeGuardConfig(bytes);
      return { startSlot: g.startSlot.toString(), guardSlots: g.guardSlots.toString(), startFeeBps: g.startFeeBps };
    }
    if (template === "buyback") {
      // totalQuoteSpent, totalBaseBurned and buybacks are left out on purpose: they are counters and move with
      // every buyback. So is the observation of the pool (obsSlot and the two reserves): every call of the
      // buyback writes it, and a trade that starts below the observed price lowers it. None of them is
      // configuration. What is left is fixed at launch: the program has no instruction that changes it.
      const b = decodeBuybackConfig(bytes);
      return { buyBps: b.buyBps, sellBps: b.sellBps, minQuote: b.minQuote.toString(), treasury: b.treasury.toBase58(), creator: b.creator.toBase58() };
    }
    if (template === "rules") {
      // Every field of bytes 8 to 239, and nothing after them. The running numbers (what is owed, the burn pot,
      // what is staked, the counters, the burn's observation) move with every trade and are not configuration.
      const r = decodeRulesConfig(bytes);
      return {
        bump: r.bump, authorityBump: r.authorityBump, pool: r.pool.toBase58(), baseMint: r.baseMint.toBase58(), quoteMint: r.quoteMint.toBase58(),
        treasury: r.treasury.toBase58(), creator: r.creator.toBase58(),
        sniperSlots: r.sniperSlots.toString(), sniperStartFeeBps: r.sniperStartFeeBps,
        buyCreatorBps: r.buy.creatorBps, buyHoldersBps: r.buy.holdersBps, buyBurnBps: r.buy.burnBps,
        sellCreatorBps: r.sell.creatorBps, sellHoldersBps: r.sell.holdersBps, sellBurnBps: r.sell.burnBps,
        maxBuyQuote: r.maxBuyQuote.toString(), limitSlots: r.limitSlots.toString(), creatorLockSeconds: r.creatorLockSeconds.toString(),
        startSlot: r.startSlot.toString(), startTime: r.startTime.toString(), minEligible: r.minEligible.toString(),
        // the strict part: all zero on a plain coin
        kind: r.kind, buyMark: bytes[RULES_BUY_MARK] ?? 0, vaultBump: r.vaultBump, maxWalletBps: r.maxWalletBps, earlySlots: r.earlySlots,
        maxWalletSlots: r.maxWalletSlots, earlyUnlockSlots: r.earlyUnlockSlots, maxWalletAmount: r.maxWalletAmount.toString(),
        reserved: Array.from(bytes.subarray(RULES_RESERVED_START, RULES_SIZE), (b) => b.toString(16).padStart(2, "0")).join(""),
      };
    }
    if (template === "collectible") {
      // minted, live and reservedPending are left out on purpose: they move with every buy, mint and burn, they
      // are counters and not configuration. baseMint and tokenProgram say which coin backs the pieces (the peg);
      // the pool records them when it is created and they never change after that. `pegged` says the coin is a
      // Token-2022 coin whose transfer hook is the collectible program. It is set before the pool exists and
      // never changes either.
      const c = collectible.decodeCollectionConfig(bytes);
      return {
        name: c.name, uriBase: c.uriBase, art: collectible.hexOf(c.art), artVersion: c.artVersion, owner: c.owner.toBase58(),
        unit: c.unit.toString(), maxSupply: c.maxSupply, maxPerBuy: c.maxPerBuy, collection: c.collection.toBase58(),
        baseMint: c.baseMint.toBase58(), tokenProgram: c.tokenProgram.toBase58(), pegged: c.pegged,
      };
    }
  } catch { return null; }
  return null;
}

export function decodeManifestFields(bytes) {
  if (!bytes) return null;
  try {
    const m = decodeHookManifest(bytes);
    return { version: m.version, flags: m.flags, admin: m.admin ? m.admin.toBase58() : "none", name: m.name, uri: m.uri };
  } catch { return null; }
}

/// Field by field difference of two flat objects (union of keys).
export function diffFields(prev, next) {
  const out = [];
  for (const k of new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})])) {
    const a = str(prev ? prev[k] : undefined); const b = str(next ? next[k] : undefined);
    if (a !== b) out.push({ field: k, from: a, to: b });
  }
  return out;
}

/// Alerts that must fire whenever a declared tax sits above its ceiling (impossible on chain, checked anyway).
export function ceilingAlerts(template, fields) {
  const alerts = [];
  if (!fields) return alerts;
  if (template === "tax" && (fields.buyBps > fields.maxBps || fields.sellBps > fields.maxBps)) {
    alerts.push({ level: "danger", message: `declared tax above its ceiling: buy ${fields.buyBps} bps, sell ${fields.sellBps} bps, ceiling ${fields.maxBps} bps` });
  }
  if (template === "buyback" && (fields.buyBps > 2000 || fields.sellBps > 2000)) {
    alerts.push({ level: "danger", message: `declared buyback tax above the hard maximum: buy ${fields.buyBps} bps, sell ${fields.sellBps} bps` });
  }
  if (template === "rules") {
    // The program refuses a config above its ceilings, so this cannot happen. The SDK's own check says what.
    const args = {
      sniperSlots: BigInt(fields.sniperSlots), sniperStartFeeBps: fields.sniperStartFeeBps,
      buy: { creatorBps: fields.buyCreatorBps, holdersBps: fields.buyHoldersBps, burnBps: fields.buyBurnBps },
      sell: { creatorBps: fields.sellCreatorBps, holdersBps: fields.sellHoldersBps, burnBps: fields.sellBurnBps },
      maxBuyQuote: BigInt(fields.maxBuyQuote), limitSlots: BigInt(fields.limitSlots), creatorLockSeconds: BigInt(fields.creatorLockSeconds),
    };
    for (const p of rulesProblems(args, RULES_CEILINGS)) alerts.push({ level: "danger", message: `declared rules outside what the program allows: ${p.message} (${p.code})` });
    // the strict part, checked on every read: none of it can be wrong on chain
    const strictArgs = { maxWalletBps: fields.maxWalletBps, maxWalletSlots: fields.maxWalletSlots, earlySlots: fields.earlySlots, earlyUnlockSlots: fields.earlyUnlockSlots };
    if (fields.kind === 1) {
      for (const p of strictProblems(strictArgs, RULES_STRICT_CEILINGS)) alerts.push({ level: "danger", message: `declared strict rules outside what the program allows: ${p.message} (${p.code})` });
    } else if (fields.kind === 0) {
      if (fields.vaultBump !== 0 || fields.maxWalletBps !== 0 || fields.earlySlots !== 0 || fields.maxWalletSlots !== 0 || fields.earlyUnlockSlots !== 0 || fields.maxWalletAmount !== "0") {
        alerts.push({ level: "danger", message: "the config of a plain rules coin carries strict numbers in bytes 376 to 396 (should be impossible)" });
      }
    } else {
      alerts.push({ level: "danger", message: `the kind of this coin's rules is ${fields.kind}, neither plain (0) nor strict (1) (should be impossible)` });
    }
    if (fields.buyMark !== 0) alerts.push({ level: "danger", message: "the buy mark of this coin's rules (byte 375) is set between two instructions (should be impossible: it is 0 whenever anybody can read the account)" });
    if (/[^0]/.test(fields.reserved ?? "")) alerts.push({ level: "danger", message: "bytes 397 to 413 of this coin's rules are not zero (should be impossible)" });
  }
  return alerts;
}

/// True when a watched part of a rules config differs between two reads: bytes 0 to 239 and 374 to 413.
/// Bytes 240 to 373 are the running numbers and move with every trade.
export function rulesFixedPartChanged(prevBytes, nextBytes) {
  if (!prevBytes || !nextBytes) return false;
  if (prevBytes.length !== nextBytes.length || nextBytes.length < RULES_FIXED_END) return true;
  for (let i = 0; i < RULES_FIXED_END; i++) if (prevBytes[i] !== nextBytes[i]) return true;
  for (let i = RULES_STRICT_START; i < nextBytes.length; i++) if (prevBytes[i] !== nextBytes[i]) return true;
  return false;
}

/// Changes and alerts for a hook's per-pool config between two passes. prevBytes null = first sight, no diff.
/// ctx = { time: iso, slot: number }.
export function diffHookConfig(template, prevBytes, nextBytes, ctx) {
  const changes = [];
  const alerts = [];
  const stamp = (field, from, to) => ({ time: ctx.time, slot: ctx.slot, field, from, to });
  if (!prevBytes || bytesEqual(prevBytes, nextBytes)) return { changes, alerts };
  if (!nextBytes) {
    changes.push(stamp("config", digest(prevBytes), "none"));
    alerts.push({ level: "danger", message: "the per-pool config account of the hook disappeared" });
    return { changes, alerts };
  }
  // Launch rules: the account changes with every trade, in its running numbers. Only bytes 0 to 239 are looked
  // at: the account's type and the part that is fixed at launch. Any change there is danger.
  if (template === "rules" && !rulesFixedPartChanged(prevBytes, nextBytes)) return { changes, alerts };
  const prev = decodeConfigFields(template, prevBytes);
  const next = decodeConfigFields(template, nextBytes);
  if (template === "rules" && (!prev || !next)) {
    changes.push(stamp("config", digest(prevBytes), digest(nextBytes)));
    alerts.push({ level: "danger", message: "the rules of this coin changed and could not be decoded (should be impossible: the rules are fixed at launch)" });
    return { changes, alerts };
  }
  if (!prev || !next) {
    changes.push(stamp("config", digest(prevBytes), digest(nextBytes)));
    alerts.push({ level: "warning", message: template === "custom" ? "custom hook per-pool config changed" : "hook config changed and could not be decoded" });
    return { changes, alerts };
  }
  for (const d of diffFields(prev, next)) {
    changes.push(stamp(d.field, d.from, d.to));
    if (template === "tax") {
      if (d.field === "buyBps" || d.field === "sellBps") alerts.push({ level: "warning", message: `tax changed: ${d.field} from ${d.from} to ${d.to} bps` });
      else if (d.field === "owner") alerts.push({ level: "info", message: next.renounced ? "tax config ownership renounced: the taxes are frozen for good" : `tax config owner changed from ${d.from} to ${d.to}` });
      else if (d.field === "maxBps") alerts.push({ level: "danger", message: `tax ceiling changed from ${d.from} to ${d.to} bps (should be impossible)` });
    } else if (template === "launch_guard") {
      if (d.field === "startSlot" && d.from === "0") alerts.push({ level: "info", message: `launch guard armed at slot ${d.to}` });
      else alerts.push({ level: "danger", message: `launch guard ${d.field} changed from ${d.from} to ${d.to} (should be impossible)` });
    } else if (template === "buyback") {
      // Every field left in the diff is fixed at launch. A buyback that ran is not a change: the burn keeper
      // logs each one, and the counters are in the pool's `declared`.
      alerts.push({ level: "danger", message: `buyback ${d.field} changed from ${d.from} to ${d.to} (should be impossible)` });
    } else if (template === "rules") {
      alerts.push({ level: "danger", message: `rules ${d.field} changed from ${d.from} to ${d.to} (should be impossible: the rules of a coin are fixed at launch)` });
    } else if (template === "collectible") {
      // artVersion is recorded as a change but raises nothing of its own: it only moves with art or renderer.
      if (d.field === "art") alerts.push({ level: "info", message: "collection art changed, existing pieces are unaffected" });
      else if (d.field === "name") alerts.push({ level: "info", message: `collection name changed from ${d.from} to ${d.to}, existing pieces are unaffected` });
      else if (d.field === "uriBase") {
        const a = uriHost(d.from); const b = uriHost(d.to);
        if (a !== b) alerts.push({ level: "warning", message: `collection renderer moved from host ${a} to host ${b}: future pieces are drawn by the new host, existing pieces are unaffected` });
        else alerts.push({ level: "info", message: `collection renderer path changed on the same host ${b}, existing pieces are unaffected` });
      } else if (d.field === "owner") {
        alerts.push({ level: "info", message: d.to === SYSTEM_PROGRAM_ID ? "collection locked forever: its name, art and renderer can never change again" : `collection owner changed from ${d.from} to ${d.to}` });
      } else if (["unit", "maxSupply", "maxPerBuy", "collection", "baseMint", "tokenProgram", "pegged"].includes(d.field)) {
        alerts.push({ level: "danger", message: `collectible ${d.field} changed from ${d.from} to ${d.to} (should be impossible)` });
      }
    }
  }
  // The decoded fields of a rules config cover every byte of its fixed part. Should a byte there ever differ
  // without a field differing, it is still said.
  if (template === "rules" && changes.length === 0) {
    const watched = (b) => Uint8Array.from([...b.subarray(0, RULES_FIXED_END), ...b.subarray(RULES_STRICT_START)]);
    changes.push(stamp("config", digest(watched(prevBytes)), digest(watched(nextBytes))));
    alerts.push({ level: "danger", message: "a fixed part of this coin's rules changed, bytes 8 to 239 or 374 to 413 (should be impossible: the rules of a coin are fixed at launch)" });
  }
  return { changes, alerts };
}

/// The manifest is read by the pool only at creation, so a change cannot touch existing pools; it is still
/// recorded, because an operator changing flags or admin after the fact is worth a look.
export function diffManifest(prevBytes, nextBytes, ctx) {
  const changes = [];
  const alerts = [];
  const stamp = (field, from, to) => ({ time: ctx.time, slot: ctx.slot, field: `manifest.${field}`, from, to });
  if (!prevBytes || bytesEqual(prevBytes, nextBytes)) return { changes, alerts };
  if (!nextBytes) {
    changes.push(stamp("account", digest(prevBytes), "none"));
    alerts.push({ level: "warning", message: "hook manifest account disappeared" });
    return { changes, alerts };
  }
  const prev = decodeManifestFields(prevBytes);
  const next = decodeManifestFields(nextBytes);
  if (!prev || !next) {
    changes.push(stamp("account", digest(prevBytes), digest(nextBytes)));
    alerts.push({ level: "warning", message: "hook manifest changed and could not be decoded" });
    return { changes, alerts };
  }
  for (const d of diffFields(prev, next)) {
    changes.push(stamp(d.field, d.from, d.to));
    if (d.field === "flags" || d.field === "admin") alerts.push({ level: "warning", message: `hook manifest ${d.field} changed from ${d.from} to ${d.to} (existing pools keep the flags copied at creation)` });
    else alerts.push({ level: "info", message: `hook manifest ${d.field} changed from ${d.from} to ${d.to}` });
  }
  return { changes, alerts };
}

/// prev: base58 | null | "unknown" | "unseen" (first sight). next: base58 | null | "unknown".
export function upgradeAuthorityAlerts({ hookKind, prev, next, whitelist }) {
  const alerts = [];
  const set = !!next && next !== "unknown";
  if (hookKind === HOOK_KIND.FROZEN && set) {
    alerts.push({ level: "danger", message: `hook was frozen at pool creation but its program now has an upgrade authority ${next}` });
  }
  if (hookKind === HOOK_KIND.PLATFORM) {
    if (prev !== "unseen" && prev !== undefined && prev !== next) {
      if (next === null) alerts.push({ level: "info", message: `hook upgrade authority removed (was ${str(prev)}): the hook program is now frozen` });
      else alerts.push({ level: "danger", message: `upgrade authority of the whitelisted hook changed from ${str(prev)} to ${str(next)}` });
    }
    if (set && Array.isArray(whitelist) && !whitelist.includes(next)) {
      alerts.push({ level: "warning", message: `hook upgrade authority ${next} is not in the platform whitelist` });
    }
  }
  return alerts;
}

// ---- platform ------------------------------------------------------------------------------------

export function platformSnapshot(p) {
  return {
    paused: !!p.paused,
    whitelist: p.whitelist.map((k) => str(k)).sort(),
    protocolFeeBps: p.protocolFeeBps, maxLpFeeBps: p.maxLpFeeBps, maxHookFeeBps: p.maxHookFeeBps, maxFeeOverrideBps: p.maxFeeOverrideBps,
    launchFeeLamports: str(p.launchFeeLamports),
    treasury: str(p.treasury), admin: str(p.admin), pendingAdmin: str(p.pendingAdmin),
    // the curve settings a new curve pool copies at its creation (a running curve keeps the ones it was made with)
    curveVirtualQuote: str(p.curveVirtualQuote ?? 0n), curveGraduationTarget: str(p.curveGraduationTarget ?? 0n), curveGraduationFeeBps: p.curveGraduationFeeBps ?? 0,
  };
}

/// What changed on the platform between two snapshots. A field the previous snapshot does not hold was not
/// recorded by the watcher that wrote it (an older version): it is recorded from now on and not reported as a
/// change.
export function diffPlatform(prev, next) {
  return diffFields(prev, next).filter((d) => !prev || Object.prototype.hasOwnProperty.call(prev, d.field));
}
