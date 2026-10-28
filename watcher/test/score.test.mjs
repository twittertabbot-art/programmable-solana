import { test } from "node:test";
import assert from "node:assert/strict";
import { scorePool, recentLevels, callsOnSell } from "../lib/score.mjs";

const TAX_FLAGS = 12865;      // BEFORE_SWAP | ON_POOL_CREATE | TAKE_HOOK_FEE | CALL_ON_BUY | CALL_ON_SELL
const GUARD_FLAGS = 4417;     // BEFORE_SWAP | ON_POOL_CREATE | OVERRIDE_FEE | CALL_ON_BUY
const ok = { ok: true, stage: null, error: null };
const failSwap = { ok: false, stage: "swap", error: "swap: custom error 6000 (told to revert)" };
const failSetup = { ok: false, stage: "setup", error: "setup: InsufficientFundsForFee" };
const baseHook = (over = {}) => ({ hasHook: true, flags: TAX_FLAGS, hookKind: 2, template: "tax", buySim: ok, sellSim: ok, effectiveBuyTaxBps: 300, effectiveSellTaxBps: 500, capBps: 1000, declaredMismatchBps: 0, taxChangedRecently: false, manifestAdminSet: false, upgradeAuthority: "ALjPBZ7pzjTRmLddcExo8e7Edk3yvVGsrjHsu1u5dhkZ", recentAlertLevels: [], ...over });

test("no hook is clean with a plain note", () => {
  const r = scorePool({ hasHook: false, buySim: ok, sellSim: ok });
  assert.equal(r.score, "clean");
  assert.ok(r.notes[0].startsWith("No hook"));
});

test("honest tax hook is clean", () => {
  const r = scorePool(baseHook());
  assert.equal(r.score, "clean");
  assert.ok(r.notes.some((n) => n.includes("runs on sells")));
});

test("sell failing inside the swap is danger when the hook runs on sells", () => {
  const r = scorePool(baseHook({ sellSim: failSwap }));
  assert.equal(r.score, "danger");
  assert.ok(r.reasons[0].includes("sell simulation failed"));
});

test("a hook without CALL_ON_SELL is never danger for a failing sell", () => {
  assert.equal(callsOnSell(GUARD_FLAGS), false);
  const r = scorePool(baseHook({ flags: GUARD_FLAGS, template: "launch_guard", sellSim: failSwap, effectiveSellTaxBps: 0 }));
  assert.equal(r.score, "warning");
  assert.ok(r.notes.some((n) => n.includes("can never block or tax sells")));
});

test("a setup failure of the sell probe is not held against the hook", () => {
  const r = scorePool(baseHook({ sellSim: failSetup }));
  assert.equal(r.score, "clean");
  assert.ok(r.notes.some((n) => n.includes("could not be set up")));
});

test("effective tax above the platform cap is danger, within tolerance is not", () => {
  assert.equal(scorePool(baseHook({ effectiveBuyTaxBps: 1006 })).score, "danger");
  assert.equal(scorePool(baseHook({ effectiveBuyTaxBps: 1005 })).score, "clean");
  assert.equal(scorePool(baseHook({ effectiveSellTaxBps: 1200 })).score, "danger");
  // sells cannot be taxed by a buy-only hook, so a sell number above the cap is ignored for it
  assert.equal(scorePool(baseHook({ flags: GUARD_FLAGS, effectiveSellTaxBps: 1200, capBps: 4949 })).score, "clean");
});

test("declared mismatch beyond 5 bps is warning", () => {
  assert.equal(scorePool(baseHook({ declaredMismatchBps: 5 })).score, "clean");
  assert.equal(scorePool(baseHook({ declaredMismatchBps: 6 })).score, "warning");
});

test("recent tax change, admin on a frozen custom hook and recent alerts raise the level", () => {
  assert.equal(scorePool(baseHook({ taxChangedRecently: true })).score, "warning");
  assert.equal(scorePool(baseHook({ hookKind: 1, template: "custom", manifestAdminSet: true, upgradeAuthority: null })).score, "warning");
  assert.equal(scorePool(baseHook({ hookKind: 1, template: "custom", manifestAdminSet: false, upgradeAuthority: null })).score, "clean");
  assert.equal(scorePool(baseHook({ recentAlertLevels: ["warning"] })).score, "warning");
  assert.equal(scorePool(baseHook({ recentAlertLevels: ["info", "danger"] })).score, "danger");
});

test("a frozen hook that grew an upgrade authority is danger", () => {
  assert.equal(scorePool(baseHook({ hookKind: 1, template: "custom", upgradeAuthority: "SomeKey" })).score, "danger");
  assert.equal(scorePool(baseHook({ hookKind: 1, template: "custom", upgradeAuthority: "unknown" })).score, "clean");
});

test("buy failing inside the swap is a warning, not danger", () => {
  assert.equal(scorePool(baseHook({ buySim: failSwap, effectiveBuyTaxBps: null })).score, "warning");
});

test("recentLevels keeps only the last 24 hours and dedupes", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const alerts = [
    { time: "2026-10-01T11:00:00Z", level: "warning" },
    { time: "2026-10-01T10:00:00Z", level: "warning" },
    { time: "2026-09-29T12:00:00Z", level: "danger" },
    { time: "not a date", level: "danger" },
  ];
  assert.deepEqual(recentLevels(alerts, now), ["warning"]);
});
