import { test } from "node:test";
import assert from "node:assert/strict";
import { diffHookConfig, diffManifest, ceilingAlerts, decodeConfigFields, upgradeAuthorityAlerts, diffPlatform, platformSnapshot, bytesEqual } from "../lib/diff.mjs";
import { taxConfig, guardConfig, buybackConfig, manifest, OWNER, OTHER, SYSTEM } from "./bytes.mjs";

const ctx = { time: "2026-10-01T12:00:00.000Z", slot: 4242 };
const levels = (r) => r.alerts.map((a) => a.level);

test("first sight and identical bytes produce nothing", () => {
  const b = taxConfig();
  assert.deepEqual(diffHookConfig("tax", null, b, ctx), { changes: [], alerts: [] });
  assert.deepEqual(diffHookConfig("tax", b, taxConfig(), ctx), { changes: [], alerts: [] });
  assert.equal(bytesEqual(b, taxConfig()), true);
});

test("tax change is recorded with time, slot, field, from, to and alerts warning", () => {
  const r = diffHookConfig("tax", taxConfig({ sellBps: 500 }), taxConfig({ sellBps: 900 }), ctx);
  assert.deepEqual(r.changes, [{ time: ctx.time, slot: 4242, field: "sellBps", from: "500", to: "900" }]);
  assert.deepEqual(levels(r), ["warning"]);
  assert.ok(r.alerts[0].message.includes("from 500 to 900"));
});

test("tax owner renounced is info, ceiling change is danger", () => {
  const r = diffHookConfig("tax", taxConfig(), taxConfig({ owner: SYSTEM }), ctx);
  assert.deepEqual(r.changes.map((c) => c.field).sort(), ["owner", "renounced"]);
  assert.deepEqual(levels(r), ["info"]);
  assert.ok(r.alerts[0].message.includes("renounced"));
  const c = diffHookConfig("tax", taxConfig(), taxConfig({ maxBps: 1500 }), ctx);
  assert.deepEqual(levels(c), ["danger"]);
});

test("declared tax above its ceiling is danger even without a change", () => {
  const f = decodeConfigFields("tax", taxConfig({ buyBps: 1200, maxBps: 1000 }));
  assert.equal(f.buyBps, 1200);
  assert.deepEqual(levels({ alerts: ceilingAlerts("tax", f) }), ["danger"]);
  assert.deepEqual(ceilingAlerts("tax", decodeConfigFields("tax", taxConfig())), []);
  assert.deepEqual(ceilingAlerts("buyback", { buyBps: 2500, sellBps: 0 }).length, 1);
});

test("launch guard arming is info, any other guard change is danger", () => {
  const r = diffHookConfig("launch_guard", guardConfig({ startSlot: 0n }), guardConfig({ startSlot: 777n }), ctx);
  assert.deepEqual(r.changes, [{ time: ctx.time, slot: 4242, field: "startSlot", from: "0", to: "777" }]);
  assert.deepEqual(levels(r), ["info"]);
  assert.ok(r.alerts[0].message.includes("armed at slot 777"));
  const d = diffHookConfig("launch_guard", guardConfig({ startSlot: 777n }), guardConfig({ startSlot: 777n, startFeeBps: 4000 }), ctx);
  assert.deepEqual(levels(d), ["danger"]);
});

test("buyback: the config is 230 bytes; a buyback that ran moves running numbers only, a parameter change is danger", () => {
  assert.equal(buybackConfig().length, 230);
  // counters and the observation of the pool are not configuration: the keeper's own calls move them all day
  const ran = buybackConfig({ buybacks: 1n, totalBaseBurned: 5000n, totalQuoteSpent: 60_000_000n, obsSlot: 4242n, obsReserveBase: 999_000_000_000_000n, obsReserveQuote: 2_010_000_000n });
  assert.deepEqual(diffHookConfig("buyback", buybackConfig(), ran, ctx), { changes: [], alerts: [] });
  // a trade that starts below the observed price lowers the observation: still nothing
  assert.deepEqual(diffHookConfig("buyback", ran, buybackConfig({ buybacks: 1n, totalBaseBurned: 5000n, totalQuoteSpent: 60_000_000n, obsSlot: 4242n, obsReserveBase: 1_000_000_000_000_000n, obsReserveQuote: 2_000_000_000n }), ctx), { changes: [], alerts: [] });
  assert.deepEqual(Object.keys(decodeConfigFields("buyback", ran)), ["buyBps", "sellBps", "minQuote", "treasury", "creator"]);
  for (const over of [{ sellBps: 900 }, { buyBps: 1 }, { minQuote: 1n }, { treasury: OWNER }, { creator: OTHER }]) {
    const d = diffHookConfig("buyback", buybackConfig(), buybackConfig(over), ctx);
    assert.deepEqual(levels(d), ["danger"], JSON.stringify(Object.keys(over)));
    assert.ok(d.alerts[0].message.includes("should be impossible"));
    assert.equal(d.changes.length, 1);
  }
});

test("custom hook config change is a digest change with a warning; vanished config is danger", () => {
  const r = diffHookConfig("custom", Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4), ctx);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].field, "config");
  assert.ok(r.changes[0].from.startsWith("3 bytes sha256 "));
  assert.deepEqual(levels(r), ["warning"]);
  assert.deepEqual(levels(diffHookConfig("tax", taxConfig(), null, ctx)), ["danger"]);
});

test("manifest admin or flags change is warning, name or uri is info", () => {
  const r = diffManifest(manifest(), manifest({ admin: OTHER }), ctx);
  assert.deepEqual(r.changes.map((c) => c.field), ["manifest.admin"]);
  assert.deepEqual(levels(r), ["warning"]);
  assert.deepEqual(levels(diffManifest(manifest(), manifest({ uri: "https://elsewhere" }), ctx)), ["info"]);
  assert.deepEqual(diffManifest(null, manifest(), ctx).changes, []);
});

test("upgrade authority rules", () => {
  const own = OWNER.toBase58(); const other = OTHER.toBase58();
  assert.deepEqual(levels({ alerts: upgradeAuthorityAlerts({ hookKind: 1, prev: null, next: own, whitelist: [own] }) }), ["danger"]);
  assert.deepEqual(upgradeAuthorityAlerts({ hookKind: 1, prev: null, next: null, whitelist: [own] }), []);
  assert.deepEqual(upgradeAuthorityAlerts({ hookKind: 1, prev: "unseen", next: "unknown", whitelist: [own] }), []);
  assert.deepEqual(upgradeAuthorityAlerts({ hookKind: 2, prev: "unseen", next: own, whitelist: [own] }), []);
  assert.deepEqual(upgradeAuthorityAlerts({ hookKind: 2, prev: own, next: own, whitelist: [own] }), []);
  assert.deepEqual(levels({ alerts: upgradeAuthorityAlerts({ hookKind: 2, prev: own, next: other, whitelist: [own] }) }), ["danger", "warning"]);
  assert.deepEqual(levels({ alerts: upgradeAuthorityAlerts({ hookKind: 2, prev: own, next: null, whitelist: [own] }) }), ["info"]);
  assert.deepEqual(levels({ alerts: upgradeAuthorityAlerts({ hookKind: 2, prev: own, next: own, whitelist: [] }) }), ["warning"]);
});

test("platform diff names every changed field", () => {
  const p = { paused: false, whitelist: [OWNER], protocolFeeBps: 20, maxLpFeeBps: 1000, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000, launchFeeLamports: 10_000_000n, treasury: OWNER, admin: OWNER, pendingAdmin: SYSTEM };
  const a = platformSnapshot(p);
  const b = platformSnapshot({ ...p, paused: true, whitelist: [OTHER, OWNER], maxHookFeeBps: 500 });
  const d = diffPlatform(a, b);
  assert.deepEqual(d.map((x) => x.field).sort(), ["maxHookFeeBps", "paused", "whitelist"]);
  assert.equal(d.find((x) => x.field === "paused").to, "true");
  assert.deepEqual(diffPlatform(a, platformSnapshot(p)), []);
});
