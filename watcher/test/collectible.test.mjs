import { test } from "node:test";
import assert from "node:assert/strict";
import { DIRECTION, PROGRAMS, quoteSwap, collectible } from "../../sdk/dist/index.js";
import { diffHookConfig, decodeConfigFields, uriHost } from "../lib/diff.mjs";
import { scorePool, capRuleApplies, callsOnSell } from "../lib/score.mjs";
import { expectedOut, declaredMismatchBps, plainOut, impliedTaxBps, platformCapBps } from "../lib/simulate.mjs";
import { templateOf } from "../lib/chain.mjs";
import { poolEntry } from "../lib/status.mjs";
import { collectionConfig, ART_B, OTHER, SYSTEM, BASE_MINT, TOKEN_PROGRAM } from "./bytes.mjs";

const ctx = { time: "2026-10-04T12:00:00.000Z", slot: 900 };
const levels = (r) => r.alerts.map((a) => a.level);
const fields = (r) => r.changes.map((c) => c.field).sort();
const FLAGS = 4162;   // AFTER_SWAP | ON_POOL_CREATE | CALL_ON_BUY
const q = { reserveBase: 830_577_996_731_236n, reserveQuote: 2_416_828_952n, lpFeeBps: 100, protocolFeeBps: 20 };
const hook = { template: "collectible", flags: FLAGS };
const ok = { ok: true, stage: null, error: null };
const pool = (over = {}) => ({ hasHook: true, flags: FLAGS, hookKind: 2, template: "collectible", buySim: ok, sellSim: ok, effectiveBuyTaxBps: 0, effectiveSellTaxBps: 0, capBps: 0, declaredMismatchBps: 0, taxChangedRecently: false, rendererMovedRecently: false, manifestAdminSet: false, upgradeAuthority: "ALjPBZ7pzjTRmLddcExo8e7Edk3yvVGsrjHsu1u5dhkZ", recentAlertLevels: [], ...over });

test("collectible: program is recognised and the status keeps the template name", () => {
  assert.equal(templateOf(PROGRAMS.hook_collectible), "collectible");
  assert.equal(poolEntry({ template: "collectible" }).template, "collectible");
  assert.equal(callsOnSell(FLAGS), false);
  assert.equal(platformCapBps({ flags: FLAGS, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000, lpFeeBps: 100 }), 0);
});

test("collectible: decoded config leaves the counters out; minted, live and reservedPending moving is not a change", () => {
  const f = decodeConfigFields("collectible", collectionConfig({ minted: 7, live: 5, reservedPending: 2 }));
  assert.deepEqual(Object.keys(f).sort(), ["art", "artVersion", "baseMint", "collection", "maxPerBuy", "maxSupply", "name", "owner", "pegged", "tokenProgram", "unit", "uriBase"]);
  assert.equal(f.pegged, false);
  assert.equal(f.art, "0114eb1e180c00000000000000000000");
  assert.equal(f.unit, "50000000000000");
  assert.deepEqual([f.baseMint, f.tokenProgram], [BASE_MINT.toBase58(), TOKEN_PROGRAM.toBase58()]);
  assert.deepEqual(diffHookConfig("collectible", collectionConfig(), collectionConfig({ minted: 5, reservedPending: 3 }), ctx), { changes: [], alerts: [] });
  // a burn moves `live` and nothing else: still not a change
  assert.deepEqual(diffHookConfig("collectible", collectionConfig({ minted: 7, live: 7 }), collectionConfig({ minted: 7, live: 5 }), ctx), { changes: [], alerts: [] });
  assert.deepEqual(diffHookConfig("collectible", null, collectionConfig(), ctx), { changes: [], alerts: [] });
});

test("collectible: the layout with the peg decodes, and the coin behind the pieces can never change", () => {
  const c = collectible.decodeCollectionConfig(collectionConfig({ minted: 7, live: 5, reservedPending: 2, name: "Shots II" }));
  assert.deepEqual([c.baseMint.toBase58(), c.tokenProgram.toBase58()], [BASE_MINT.toBase58(), TOKEN_PROGRAM.toBase58()]);
  assert.deepEqual([c.unit, c.maxSupply, c.minted, c.live, c.reservedPending, c.maxPerBuy, c.name], [50_000_000_000_000n, 1000, 7, 5, 2, 3, "Shots II"]);
  for (const over of [{ baseMint: OTHER }, { tokenProgram: OTHER }]) {
    const r = diffHookConfig("collectible", collectionConfig(), collectionConfig(over), ctx);
    assert.deepEqual(fields(r), Object.keys(over));
    assert.deepEqual(levels(r), ["danger"]);
    assert.ok(r.alerts[0].message.includes("should be impossible"));
  }
});

test("collectible: art and name changes are recorded and alert info", () => {
  const r = diffHookConfig("collectible", collectionConfig(), collectionConfig({ art: ART_B, artVersion: 1, minted: 4 }), ctx);
  assert.deepEqual(fields(r), ["art", "artVersion"]);
  assert.deepEqual(r.changes.find((c) => c.field === "art"), { time: ctx.time, slot: 900, field: "art", from: "0114eb1e180c00000000000000000000", to: "018c64c81e2800000000000000000000" });
  assert.deepEqual(levels(r), ["info"]);
  assert.equal(r.alerts[0].message, "collection art changed, existing pieces are unaffected");
  const n = diffHookConfig("collectible", collectionConfig(), collectionConfig({ name: "Shots II" }), ctx);
  assert.deepEqual(fields(n), ["name"]);
  assert.deepEqual(levels(n), ["info"]);
  assert.ok(n.alerts[0].message.includes("from Shots to Shots II") && n.alerts[0].message.includes("existing pieces are unaffected"));
});

test("collectible: renderer moving to another host is a warning, a new path on the same host is info", () => {
  assert.equal(uriHost("https://example.com/art"), "example.com");
  assert.equal(uriHost("http://localhost:8787/art"), "localhost:8787");
  assert.equal(uriHost("not a url"), "not a url");
  const moved = diffHookConfig("collectible", collectionConfig(), collectionConfig({ uriBase: "https://evil.example/art", artVersion: 1 }), ctx);
  assert.deepEqual(fields(moved), ["artVersion", "uriBase"]);
  assert.deepEqual(levels(moved), ["warning"]);
  assert.ok(moved.alerts[0].message.includes("from host example.com to host evil.example"));
  const same = diffHookConfig("collectible", collectionConfig(), collectionConfig({ uriBase: "https://example.com/art/v2", artVersion: 1 }), ctx);
  assert.deepEqual(levels(same), ["info"]);
});

test("collectible: lock is info, and unit, maxSupply or maxPerBuy changing is danger", () => {
  const lock = diffHookConfig("collectible", collectionConfig(), collectionConfig({ owner: SYSTEM }), ctx);
  assert.deepEqual(fields(lock), ["owner"]);
  assert.deepEqual(levels(lock), ["info"]);
  assert.ok(lock.alerts[0].message.startsWith("collection locked forever"));
  const handover = diffHookConfig("collectible", collectionConfig(), collectionConfig({ owner: OTHER }), ctx);
  assert.deepEqual(levels(handover), ["info"]);
  assert.ok(handover.alerts[0].message.startsWith("collection owner changed"));
  for (const over of [{ unit: 1n }, { maxSupply: 5000 }, { maxPerBuy: 5 }]) {
    const r = diffHookConfig("collectible", collectionConfig(), collectionConfig(over), ctx);
    assert.deepEqual(levels(r), ["danger"], JSON.stringify(Object.keys(over)));
    assert.ok(r.alerts[0].message.includes("should be impossible"));
  }
});

test("collectible: clean by default, warning for 24 h after a renderer move, never danger for sells", () => {
  const clean = scorePool(pool());
  assert.equal(clean.score, "clean");
  assert.ok(clean.notes.some((n) => n.includes("can never block or tax sells")));
  assert.equal(scorePool(pool({ rendererMovedRecently: true })).score, "warning");
  assert.equal(scorePool(pool({ sellSim: { ok: false, stage: "swap", error: "swap: custom error 6000" } })).score, "warning");
  assert.equal(scorePool(pool({ recentAlertLevels: ["info"] })).score, "clean");
});

test("collectible: the declared output is the plain pool's; a non-zero tax is a mismatch warning, not the cap rule", () => {
  const buyIn = 50_000_000n; const sellIn = 8_305_779_967_312n;
  assert.equal(expectedOut(q, DIRECTION.BUY, buyIn, hook, 1), plainOut(q, DIRECTION.BUY, buyIn));
  assert.equal(expectedOut(q, DIRECTION.SELL, sellIn, hook, 1), plainOut(q, DIRECTION.SELL, sellIn));
  assert.equal(impliedTaxBps(q, DIRECTION.BUY, buyIn, plainOut(q, DIRECTION.BUY, buyIn)), 0);
  assert.equal(declaredMismatchBps(q, DIRECTION.SELL, sellIn, hook, 1, plainOut(q, DIRECTION.SELL, sellIn)), 0);
  const taxed = quoteSwap({ direction: DIRECTION.BUY, amountIn: buyIn, ...q, hookFeeBps: 40 }).amountOut;
  const mm = declaredMismatchBps(q, DIRECTION.BUY, buyIn, hook, 1, taxed);
  assert.ok(mm > 5, `got ${mm}`);
  assert.equal(capRuleApplies("collectible"), false);
  assert.equal(capRuleApplies("tax"), true);
  assert.equal(scorePool(pool({ effectiveBuyTaxBps: 40, declaredMismatchBps: mm })).score, "warning");
  assert.equal(scorePool(pool({ effectiveBuyTaxBps: 40, declaredMismatchBps: null })).score, "clean");
  assert.equal(scorePool(pool({ template: "custom", effectiveBuyTaxBps: 40, declaredMismatchBps: null })).score, "danger");
});
