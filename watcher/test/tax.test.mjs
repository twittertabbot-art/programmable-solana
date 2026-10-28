import { test } from "node:test";
import assert from "node:assert/strict";
import { DIRECTION, quoteSwap, guardFee } from "../../sdk/dist/index.js";
import { impliedTaxBps, plainOut, expectedOut, declaredMismatchBps, platformCapBps, classifySimError, hookRunsOn } from "../lib/simulate.mjs";

// a real localnet pool: 830.6M HTC (6 decimals) against 2.4168 SOL, 1% lp fee, 0.2% protocol fee
const q = { reserveBase: 830_577_996_731_236n, reserveQuote: 2_416_828_952n, lpFeeBps: 100, protocolFeeBps: 20 };
const BUY_IN = 50_000_000n;              // 0.05 SOL
const SELL_IN = 8_305_779_967_312n;      // 1% of the largest holder
const TAX_FLAGS = 12865; const GUARD_FLAGS = 4417;
const sim = (direction, amountIn, extra) => quoteSwap({ direction, amountIn, ...q, ...extra }).amountOut;

test("implied tax recovers the declared hook fee exactly, buy and sell", () => {
  assert.equal(impliedTaxBps(q, DIRECTION.BUY, BUY_IN, sim(DIRECTION.BUY, BUY_IN, { hookFeeBps: 300 })), 300);
  assert.equal(impliedTaxBps(q, DIRECTION.SELL, SELL_IN, sim(DIRECTION.SELL, SELL_IN, { hookFeeBps: 500 })), 500);
  assert.equal(impliedTaxBps(q, DIRECTION.BUY, BUY_IN, sim(DIRECTION.BUY, BUY_IN, { hookFeeBps: 1000 })), 1000);
  assert.equal(impliedTaxBps(q, DIRECTION.BUY, BUY_IN, plainOut(q, DIRECTION.BUY, BUY_IN)), 0);
  assert.equal(impliedTaxBps(q, DIRECTION.BUY, BUY_IN, plainOut(q, DIRECTION.BUY, BUY_IN) * 2n), 0);
  assert.equal(impliedTaxBps(q, DIRECTION.BUY, BUY_IN, null), null);
});

test("a fee override shows up as an implied tax too (the guard's high early fee)", () => {
  const out = sim(DIRECTION.BUY, BUY_IN, { feeOverrideBps: 3000 });
  const implied = impliedTaxBps(q, DIRECTION.BUY, BUY_IN, out);
  // (3000 - 100) / (1 - 0.01) = 2929 bps worse than the plain pool
  assert.ok(implied >= 2928 && implied <= 2930, `got ${implied}`);
});

test("expected output follows the declared template parameters and the direction flags", () => {
  const tax = { template: "tax", flags: TAX_FLAGS, tax: { buyBps: 300, sellBps: 500, maxBps: 1000 } };
  assert.equal(expectedOut(q, DIRECTION.BUY, BUY_IN, tax, 1), sim(DIRECTION.BUY, BUY_IN, { hookFeeBps: 300 }));
  assert.equal(expectedOut(q, DIRECTION.SELL, SELL_IN, tax, 1), sim(DIRECTION.SELL, SELL_IN, { hookFeeBps: 500 }));
  const guard = { template: "launch_guard", flags: GUARD_FLAGS, guard: { startSlot: 1000n, guardSlots: 300n, startFeeBps: 3000 } };
  assert.equal(hookRunsOn(GUARD_FLAGS, DIRECTION.SELL), false);
  assert.equal(expectedOut(q, DIRECTION.SELL, SELL_IN, guard, 1100), plainOut(q, DIRECTION.SELL, SELL_IN));
  const fee = guardFee(1100n, 1000n, 300n, 3000, 100);
  assert.equal(expectedOut(q, DIRECTION.BUY, BUY_IN, guard, 1100), sim(DIRECTION.BUY, BUY_IN, { feeOverrideBps: fee }));
  assert.equal(expectedOut(q, DIRECTION.BUY, BUY_IN, guard, 5000), plainOut(q, DIRECTION.BUY, BUY_IN));
  assert.equal(expectedOut(q, DIRECTION.BUY, BUY_IN, { template: "custom", flags: TAX_FLAGS }, 1), null);
});

test("declared mismatch: zero when honest, large when the hook lies, one slot of guard drift tolerated", () => {
  const tax = { template: "tax", flags: TAX_FLAGS, tax: { buyBps: 300, sellBps: 500, maxBps: 1000 } };
  assert.equal(declaredMismatchBps(q, DIRECTION.BUY, BUY_IN, tax, 1, sim(DIRECTION.BUY, BUY_IN, { hookFeeBps: 300 })), 0);
  const lie = declaredMismatchBps(q, DIRECTION.BUY, BUY_IN, tax, 1, sim(DIRECTION.BUY, BUY_IN, { hookFeeBps: 400 }));
  assert.ok(lie >= 95 && lie <= 105, `got ${lie}`);
  const guard = { template: "launch_guard", flags: GUARD_FLAGS, guard: { startSlot: 1000n, guardSlots: 300n, startFeeBps: 3000 } };
  const at1100 = sim(DIRECTION.BUY, BUY_IN, { feeOverrideBps: guardFee(1100n, 1000n, 300n, 3000, 100) });
  assert.equal(declaredMismatchBps(q, DIRECTION.BUY, BUY_IN, guard, 1101, at1100), 0);
  assert.ok(declaredMismatchBps(q, DIRECTION.BUY, BUY_IN, guard, 1150, at1100) > 5);
  assert.equal(declaredMismatchBps(q, DIRECTION.BUY, BUY_IN, { template: "custom", flags: TAX_FLAGS }, 1, 1n), null);
});

test("platform cap combines the hook fee cap and the fee override cap according to the flags", () => {
  assert.equal(platformCapBps({ flags: TAX_FLAGS, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000, lpFeeBps: 100 }), 1000);
  assert.equal(platformCapBps({ flags: GUARD_FLAGS, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000, lpFeeBps: 100 }), 4949);
  assert.equal(platformCapBps({ flags: TAX_FLAGS | 256, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000, lpFeeBps: 100 }), 5455);
  assert.equal(platformCapBps({ flags: 1 | 4096, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000, lpFeeBps: 100 }), 0);
});

test("simulation errors are split into setup and swap by instruction index", () => {
  const logs = ["Program log: Instruction: Swap", "Program log: AnchorError occurred. Error Code: Revert. Error Number: 6000. Error Message: told to revert."];
  const a = classifySimError({ InstructionError: [4, { Custom: 6000 }] }, logs, 4);
  assert.equal(a.stage, "swap");
  assert.ok(a.message.startsWith("swap: custom error 6000 (told to revert.)"), a.message);
  assert.equal(classifySimError({ InstructionError: [1, "InsufficientFunds"] }, [], 4).stage, "setup");
  assert.equal(classifySimError("AccountNotFound", [], 4).message, "setup: AccountNotFound");
});
