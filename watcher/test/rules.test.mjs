// The "launch rules" template (hook_rules) in the watcher: the template lists, the config diff fed with raw
// bytes, the declared output of a simulated trade, the size of the buy probe, the score and the status schema.
// Nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIRECTION, FLAGS, PROGRAMS, RULES_CEILINGS, decodePool, decodeRulesConfig, quoteSwap, rulesSniperFee } from "../../sdk/dist/index.js";
import { templateOf, decodeHook } from "../lib/chain.mjs";
import { diffHookConfig, decodeConfigFields, ceilingAlerts, rulesFixedPartChanged, RULES_FIXED_START, RULES_FIXED_END } from "../lib/diff.mjs";
import { expectedOut, declaredMismatchBps, impliedTaxBps, platformCapBps, buyProbeLamports, hookRunsOn } from "../lib/simulate.mjs";
import { scorePool, callsOnSell, capRuleApplies } from "../lib/score.mjs";
import { poolEntry, TEMPLATES } from "../lib/status.mjs";
import { rulesConfig, poolBytes, taxConfig, POOL, OWNER, OTHER } from "./bytes.mjs";

const RULES_FLAGS = 13125;   // BEFORE_SWAP | BEFORE_ADD_LIQ | ON_POOL_CREATE | OVERRIDE_FEE | TAKE_HOOK_FEE | CALL_ON_BUY | CALL_ON_SELL
const ctx = { time: "2026-10-14T12:00:00.000Z", slot: 4242 };
const levels = (r) => r.alerts.map((a) => a.level);
const q = { reserveBase: 830_577_996_731_236n, reserveQuote: 2_416_828_952n, lpFeeBps: 100, protocolFeeBps: 20, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000 };
const BUY_IN = 50_000_000n;
const SELL_IN = 8_305_779_967_312n;
const sim = (direction, amountIn, extra) => quoteSwap({ direction, amountIn, reserveBase: q.reserveBase, reserveQuote: q.reserveQuote, lpFeeBps: q.lpFeeBps, protocolFeeBps: q.protocolFeeBps, ...extra }).amountOut;
const hookOf = (over = {}) => ({ template: "rules", flags: RULES_FLAGS, rules: decodeRulesConfig(rulesConfig(over)) });

test("rules: a platform template of its own name, in every list", () => {
  assert.equal(templateOf(PROGRAMS.hook_rules), "rules");
  assert.equal(templateOf(OTHER), "custom");
  assert.ok(TEMPLATES.includes("rules"));
  assert.equal(RULES_FLAGS, FLAGS.BEFORE_SWAP | FLAGS.BEFORE_ADD_LIQ | FLAGS.ON_POOL_CREATE | FLAGS.OVERRIDE_FEE | FLAGS.TAKE_HOOK_FEE | FLAGS.CALL_ON_BUY | FLAGS.CALL_ON_SELL);
  const pool = decodePool(POOL, poolBytes({ hookProgram: PROGRAMS.hook_rules, hookFlags: RULES_FLAGS, hookKind: 2 }));
  const cfg = rulesConfig({ sniperSlots: 300n, sniperStartFeeBps: 3000 });
  assert.equal(cfg.length, 414);
  const hook = decodeHook(pool, null, null, { data: Buffer.from(cfg) }, null);
  assert.equal(hook.template, "rules");
  assert.equal(hook.rules.buy.holdersBps, 100); assert.equal(hook.rules.sell.burnBps, 100); assert.equal(hook.rules.sniperSlots, 300n); assert.equal(hook.rules.started, true);
  assert.equal(hook.tax, undefined); assert.equal(hook.buyback, undefined);
  // bytes that are not a rules config leave the template named and nothing decoded
  assert.equal(decodeHook(pool, null, null, { data: Buffer.from(taxConfig()) }, null).rules, undefined);
  assert.equal(poolEntry({ template: "rules", hookKind: "platform", score: "clean" }).template, "rules");
  assert.equal(callsOnSell(RULES_FLAGS), true);
  assert.equal(capRuleApplies("rules"), true);
});

test("rules: the running numbers are not config; a pass that only finds them moved records nothing", () => {
  const before = rulesConfig();
  const after = rulesConfig({
    feesSeen: 40_000_000n, lastSplit: { creatorBps: 100, holdersBps: 200, burnBps: 100 }, creatorOwed: 9_000_000n, burnPot: 12_000_000n, accPerShare: 123_456_789_012_345_678_901n,
    rewardRem: 77n, totalStaked: 150_000_000_000_000n, rewardsOwedTotal: 3_000_000n, totalCreatorPaid: 1n, totalRewardsPaid: 2n, totalQuoteBurned: 3n, totalBaseBurned: 4n, burns: 5n,
    obsSlot: 4200n, obsReserveBase: 999_000_000_000_000n, obsReserveQuote: 2_010_000_000n,
  });
  assert.equal(rulesFixedPartChanged(before, after), false);
  assert.deepEqual(diffHookConfig("rules", before, after, ctx), { changes: [], alerts: [] });
  assert.deepEqual(diffHookConfig("rules", null, after, ctx), { changes: [], alerts: [] }, "first sight");
  // every byte of the running numbers, one at a time: never a change, never an alert
  for (let i = RULES_FIXED_END; i < 374; i++) {
    const bent = Uint8Array.from(before); bent[i] ^= 0x5a;
    assert.deepEqual(diffHookConfig("rules", before, bent, ctx), { changes: [], alerts: [] }, `byte ${i}`);
  }
  // the decoded fields are the fixed part only: nothing that moves with a trade
  const fields = Object.keys(decodeConfigFields("rules", after));
  for (const name of ["burnPot", "creatorOwed", "totalStaked", "feesSeen", "burns", "obsSlot", "accPerShare"]) assert.ok(!fields.includes(name), name);
});

test("rules: ANY change of bytes 8 to 239 is a danger alert", () => {
  const before = rulesConfig({ sniperSlots: 300n, sniperStartFeeBps: 3000, maxBuyQuote: 200_000_000n, limitSlots: 150n, creatorLockSeconds: 2_592_000n });
  assert.equal(RULES_FIXED_START, 8); assert.equal(RULES_FIXED_END, 240);
  for (let i = RULES_FIXED_START; i < RULES_FIXED_END; i++) {
    const bent = Uint8Array.from(before); bent[i] ^= 0x01;
    const r = diffHookConfig("rules", before, bent, ctx);
    assert.ok(r.alerts.length >= 1 && r.alerts.every((a) => a.level === "danger"), `byte ${i}: ${JSON.stringify(r.alerts)}`);
    assert.ok(r.changes.length >= 1 && r.changes.every((c) => c.time === ctx.time && c.slot === 4242), `byte ${i}`);
  }
  // named, with the old and the new value
  const fee = diffHookConfig("rules", rulesConfig(), rulesConfig({ sell: { creatorBps: 500, holdersBps: 200, burnBps: 100 } }), ctx);
  assert.deepEqual(fee.changes, [{ time: ctx.time, slot: 4242, field: "sellCreatorBps", from: "100", to: "500" }]);
  assert.deepEqual(fee.alerts, [{ level: "danger", message: "rules sellCreatorBps changed from 100 to 500 (should be impossible: the rules of a coin are fixed at launch)" }]);
  const cases = [
    [{ buy: { creatorBps: 50, holdersBps: 100, burnBps: 0 } }, "buyBurnBps"], [{ sniperSlots: 1n, sniperStartFeeBps: 0 }, "sniperSlots"], [{ sniperStartFeeBps: 4000 }, "sniperStartFeeBps"],
    [{ maxBuyQuote: 5n }, "maxBuyQuote"], [{ limitSlots: 9n }, "limitSlots"], [{ creatorLockSeconds: 1n }, "creatorLockSeconds"], [{ creator: OTHER }, "creator"], [{ treasury: OWNER }, "treasury"],
    [{ startSlot: 1001n }, "startSlot"], [{ startTime: 1_760_000_001n }, "startTime"], [{ minEligible: 1n }, "minEligible"], [{ pool: OTHER }, "pool"], [{ baseMint: OWNER }, "baseMint"], [{ quoteMint: OTHER }, "quoteMint"],
    [{ bump: 1 }, "bump"], [{ authorityBump: 1 }, "authorityBump"],
  ];
  for (const [over, field] of cases) {
    const r = diffHookConfig("rules", rulesConfig(), rulesConfig(over), ctx);
    assert.deepEqual(r.changes.map((c) => c.field), [field]);
    assert.deepEqual(levels(r), ["danger"], field);
    assert.ok(r.alerts[0].message.startsWith(`rules ${field} changed from `), r.alerts[0].message);
  }
  // an account that is no longer a rules config, or that is gone
  const other = Uint8Array.from(before); other[0] ^= 0xff;
  const gone = diffHookConfig("rules", before, other, ctx);
  assert.deepEqual(levels(gone), ["danger"]); assert.ok(gone.alerts[0].message.includes("could not be decoded"));
  assert.deepEqual(levels(diffHookConfig("rules", before, before.subarray(0, 200), ctx)), ["danger"]);
  assert.deepEqual(levels(diffHookConfig("rules", before, null, ctx)), ["danger"]);
});

test("rules: rates above what the program allows are danger even without a change", () => {
  assert.deepEqual(ceilingAlerts("rules", decodeConfigFields("rules", rulesConfig())), []);
  assert.deepEqual(ceilingAlerts("rules", decodeConfigFields("rules", rulesConfig({ sniperSlots: BigInt(RULES_CEILINGS.sniperSlots), sniperStartFeeBps: RULES_CEILINGS.sniperStartFeeBps, maxBuyQuote: 1n, limitSlots: BigInt(RULES_CEILINGS.limitSlots) }))), []);
  const high = ceilingAlerts("rules", decodeConfigFields("rules", rulesConfig({ buy: { creatorBps: 600, holdersBps: 0, burnBps: 0 } })));
  assert.deepEqual(high.map((a) => a.level), ["danger"]);
  assert.ok(high[0].message.startsWith("declared rules outside what the program allows:") && high[0].message.includes("CreatorFeeTooHigh"), high[0].message);
  const side = ceilingAlerts("rules", decodeConfigFields("rules", rulesConfig({ sell: { creatorBps: 400, holdersBps: 400, burnBps: 400 } })));
  assert.ok(side.some((a) => a.message.includes("SideTooHigh")));
  assert.ok(ceilingAlerts("rules", decodeConfigFields("rules", rulesConfig({ sniperSlots: 100n, sniperStartFeeBps: 6000 }))).some((a) => a.message.includes("StartFeeTooHigh")));
  assert.ok(ceilingAlerts("rules", decodeConfigFields("rules", rulesConfig({ maxBuyQuote: 5n }))).some((a) => a.message.includes("LimitIncomplete")));
});

test("rules: the declared output is the three rates of the side, whoever is staked, under the platform's caps", () => {
  const hook = hookOf();
  assert.equal(hookRunsOn(RULES_FLAGS, DIRECTION.SELL), true);
  assert.equal(expectedOut(q, DIRECTION.BUY, BUY_IN, hook, 5000), sim(DIRECTION.BUY, BUY_IN, { hookFeeBps: 200 }));
  assert.equal(expectedOut(q, DIRECTION.SELL, SELL_IN, hook, 5000), sim(DIRECTION.SELL, SELL_IN, { hookFeeBps: 400 }));
  // the same coin with stakers, a full pot and an observation: the same output
  const busy = hookOf({ totalStaked: 500_000_000_000_000n, accPerShare: 99n, burnPot: 80_000_000n, obsSlot: 4990n, obsReserveBase: 5n, obsReserveQuote: 6n });
  assert.equal(expectedOut(q, DIRECTION.BUY, BUY_IN, busy, 5000), expectedOut(q, DIRECTION.BUY, BUY_IN, hook, 5000));
  assert.equal(expectedOut(q, DIRECTION.SELL, SELL_IN, busy, 5000), expectedOut(q, DIRECTION.SELL, SELL_IN, hook, 5000));
  // the pool clamps the hook fee to the platform's cap
  assert.equal(expectedOut({ ...q, maxHookFeeBps: 300 }, DIRECTION.SELL, SELL_IN, hook, 5000), sim(DIRECTION.SELL, SELL_IN, { hookFeeBps: 300 }));
  // the implied tax of an honest pool is its declared rate, and well under the cap of its flags
  assert.equal(impliedTaxBps(q, DIRECTION.BUY, BUY_IN, expectedOut(q, DIRECTION.BUY, BUY_IN, hook, 5000)), 200);
  assert.equal(impliedTaxBps(q, DIRECTION.SELL, SELL_IN, expectedOut(q, DIRECTION.SELL, SELL_IN, hook, 5000)), 400);
  assert.equal(platformCapBps({ flags: RULES_FLAGS, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000, lpFeeBps: 100 }), 5455);
  assert.equal(declaredMismatchBps(q, DIRECTION.BUY, BUY_IN, hook, 5000, sim(DIRECTION.BUY, BUY_IN, { hookFeeBps: 200 })), 0);
  const lie = declaredMismatchBps(q, DIRECTION.SELL, SELL_IN, hook, 5000, sim(DIRECTION.SELL, SELL_IN, { hookFeeBps: 500 }));
  assert.ok(lie >= 95 && lie <= 110, `a pool that takes 5% where 4% is declared: ${lie} bps apart`);
  // a config that could not be decoded declares nothing
  assert.equal(expectedOut(q, DIRECTION.BUY, BUY_IN, { template: "rules", flags: RULES_FLAGS }, 5000), null);
});

test("rules: the sniper fee of the slot on buys, one slot of drift tolerated, sells untouched", () => {
  const hook = hookOf({ sniperSlots: 300n, sniperStartFeeBps: 3000, startSlot: 1000n });
  const fee = rulesSniperFee(1100n, 1000n, 300n, 3000, 100);
  assert.equal(fee, 2034);
  const at1100 = sim(DIRECTION.BUY, BUY_IN, { hookFeeBps: 200, feeOverrideBps: fee });
  assert.equal(expectedOut(q, DIRECTION.BUY, BUY_IN, hook, 1100), at1100);
  assert.equal(expectedOut(q, DIRECTION.SELL, SELL_IN, hook, 1100), sim(DIRECTION.SELL, SELL_IN, { hookFeeBps: 400 }), "the window touches buys only");
  assert.equal(expectedOut(q, DIRECTION.BUY, BUY_IN, hook, 1300), sim(DIRECTION.BUY, BUY_IN, { hookFeeBps: 200 }), "the first slot after the window");
  assert.equal(expectedOut({ ...q, maxFeeOverrideBps: 2500 }, DIRECTION.BUY, BUY_IN, hook, 1000), sim(DIRECTION.BUY, BUY_IN, { hookFeeBps: 200, feeOverrideBps: 2500 }), "clamped to the platform's fee override cap");
  assert.equal(declaredMismatchBps(q, DIRECTION.BUY, BUY_IN, hook, 1101, at1100), 0, "the simulation landed one slot from the read");
  assert.equal(declaredMismatchBps(q, DIRECTION.BUY, BUY_IN, hook, 1099, at1100), 0);
  assert.ok(declaredMismatchBps(q, DIRECTION.BUY, BUY_IN, hook, 1150, at1100) > 5);
});

test("rules: the buy probe is no larger than a running buy limit", () => {
  const limited = hookOf({ maxBuyQuote: 20_000_000n, limitSlots: 150n, startSlot: 1000n });
  assert.deepEqual(buyProbeLamports(50_000_000n, limited, 1100), { amount: 20_000_000n, limit: { maxBuyQuote: 20_000_000n, untilSlot: 1150n }, maxWallet: null });
  assert.equal(buyProbeLamports(50_000_000n, limited, 1149).amount, 20_000_000n, "the last slot of the window");
  assert.deepEqual(buyProbeLamports(50_000_000n, limited, 1150), { amount: 50_000_000n, limit: null, maxWallet: null }, "the window is over");
  // a limit above the probe changes nothing, and is still said
  const wide = hookOf({ maxBuyQuote: 200_000_000n, limitSlots: 150n, startSlot: 1000n });
  const w = buyProbeLamports(50_000_000n, wide, 1100);
  assert.equal(w.amount, 50_000_000n); assert.equal(w.limit.maxBuyQuote, 200_000_000n);
  assert.deepEqual(buyProbeLamports(50_000_000n, hookOf(), 1100), { amount: 50_000_000n, limit: null, maxWallet: null }, "a coin without a limit");
  assert.deepEqual(buyProbeLamports(50_000_000n, { template: "tax", flags: 12865, tax: {} }, 1100), { amount: 50_000_000n, limit: null, maxWallet: null });
  assert.deepEqual(buyProbeLamports(50_000_000n, limited, null), { amount: 50_000_000n, limit: null, maxWallet: null });
});

test("rules: an honest pool is clean; a sell that fails inside the swap is danger, because the hook runs on sells", () => {
  const ok = { ok: true, stage: null, error: null };
  const base = { hasHook: true, flags: RULES_FLAGS, hookKind: 2, template: "rules", buySim: ok, sellSim: ok, effectiveBuyTaxBps: 200, effectiveSellTaxBps: 400, capBps: 5455, declaredMismatchBps: 0, taxChangedRecently: false, manifestAdminSet: false, upgradeAuthority: OWNER.toBase58(), recentAlertLevels: [] };
  const clean = scorePool(base);
  assert.equal(clean.score, "clean");
  assert.ok(clean.notes.some((n) => n.includes("runs on sells")));
  assert.equal(scorePool({ ...base, sellSim: { ok: false, stage: "swap", error: "swap: custom error 6017" } }).score, "danger");
  assert.equal(scorePool({ ...base, declaredMismatchBps: 9 }).score, "warning");
  // the danger alert of a changed rule keeps the pool at danger for a day
  assert.equal(scorePool({ ...base, recentAlertLevels: ["danger"] }).score, "danger");
});

test("status: the burn of a buyback or rules pool has a fixed shape; other pools carry none", () => {
  const e = poolEntry({ template: "rules", hookKind: "platform", score: "clean", burn: { pot: 1_497_000n, capBps: 50, step: "buy", observedAtSlot: 4200n, nextCallAtSlot: 4225n, extra: 1, keeper: { calls: 3, bought: 1, spentLamports: 500_000, lastAt: "t", lastOutcome: "bought", junk: true } } });
  assert.deepEqual(e.burn, { pot: "1497000", capBps: 50, step: "buy", observedAtSlot: 4200, nextCallAtSlot: 4225, keeper: { calls: 3, bought: 1, spentLamports: 500000, lastAt: "t", lastOutcome: "bought" } });
  const fresh = poolEntry({ template: "buyback", burn: { pot: 0n, capBps: 1, step: "weird", observedAtSlot: null, nextCallAtSlot: null, keeper: null } });
  assert.deepEqual(fresh.burn, { pot: "0", capBps: 1, step: "nothing", observedAtSlot: null, nextCallAtSlot: null, keeper: { calls: 0, bought: 0, spentLamports: 0, lastAt: null, lastOutcome: null } });
  assert.equal("burn" in poolEntry({ template: "tax" }), false);
});
