// The curve arithmetic of the SDK, offline, against the numbers of HOOKS.md section 2 and
// the independent review of the programs. Runs on the built bundle:
//   npm run build -w sdk && npm test -w sdk
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  HookpoolClient, DIRECTION, CURVE_NONE, CURVE_OPEN, CURVE_GRADUATED, CURVE_ERRORS, CURVE_PEGGED_ERROR, MAX_CURVE_VIRTUAL_QUOTE, CurveRefusal, curveErrorFromLogs, curveSettingsProblem,
  quoteSwap, graduation, graduationIfNow, graduationBurn, curveProgress, curveInitialLp, willGraduate, floorForGraduation, readyToGraduate, poolAfterGraduation,
  ACCOUNT_DISC, IX, PROGRAMS, NATIVE_MINT, NO_HOOK, SYSTEM_PROGRAM, TOKEN_PROGRAM, pda, poolKeys, firstBuyHookFeeBps, firstBuyRaised, firstBuyGraduates,
} from "../dist/index.js";

const S = 1_000_000_000_000_000n;      // one billion coins at 6 decimals
const V = 30_000_000_000n;             // 30 virtual SOL
const T = 85_000_000_000n;             // graduation at 85 real SOL
const SOL = 1_000_000_000n;
const noFee = { lpFeeBps: 0, protocolFeeBps: 0 };
/// A pool on the curve whose real reserve is `raised`, walked along the fee-less curve.
const poolAt = (raised, feeBps = 0) => ({ reserveBase: (V * S) / (raised + V), reserveQuote: raised, virtualQuote: V, graduationTarget: T, graduationFeeBps: feeBps, curveState: CURVE_OPEN });
const bps = (a, b) => Number(((a - b) * 10_000n) / a);

test("the first buy of 1 SOL on the bare curve gets 32,258,064,516,129 units and the reserves after are real", () => {
  const q = quoteSwap({ direction: DIRECTION.BUY, amountIn: SOL, reserveBase: S, reserveQuote: 0n, virtualQuote: V, ...noFee });
  assert.equal(q.amountOut, 32_258_064_516_129n);
  assert.equal(q.reserveInAfter, SOL);
  assert.equal(q.reserveOutAfter, S - q.amountOut);
  assert.equal(q.graduates, undefined);
});

test("at the target the pool holds 260,869,565,217,391 units and graduation burns 68,052,930,056,711", () => {
  const p = poolAt(T);
  assert.equal(p.reserveBase, 260_869_565_217_391n);
  const g = graduation(p.reserveBase, p.reserveQuote, V, T, 0);
  assert.deepEqual(g, { fee: 0n, reserveQuoteAfter: T, reserveBaseAfter: 192_816_635_160_680n, burned: 68_052_930_056_711n });
  // the price is kept, up to one unit of the coin, never down
  assert.ok(g.reserveQuoteAfter * p.reserveBase >= (T + V) * g.reserveBaseAfter);
  assert.ok(g.reserveQuoteAfter * p.reserveBase < (T + V) * (g.reserveBaseAfter + 1n));
  // about 6.8% of the supply, the figure at the target
  assert.equal(bps(S, S - g.burned), 680);
});

test("a graduation fee leaves the reserve and makes the burn larger; above the cap it is refused by the chain, not here", () => {
  const p = poolAt(T, 700);
  const g = graduation(p.reserveBase, p.reserveQuote, V, T, 700);
  assert.equal(g.fee, (T * 700n) / 10_000n);
  assert.equal(g.reserveQuoteAfter, T - g.fee);
  assert.equal(g.reserveBaseAfter, ((T - g.fee) * p.reserveBase) / (T + V));
  assert.ok(g.burned > graduation(p.reserveBase, p.reserveQuote, V, T, 0).burned);
});

test("graduation below the target throws GraduationNotReached", () => {
  assert.throws(() => graduation(S, SOL, V, T, 0), (e) => e instanceof CurveRefusal && e.number === 6048 && e.code === "GraduationNotReached");
});

test("a sell past the real reserve throws CurveRealReserve 6049 with the chain's sentence", () => {
  assert.throws(
    () => quoteSwap({ direction: DIRECTION.SELL, amountIn: S / 2n, reserveBase: S / 2n, reserveQuote: SOL, virtualQuote: V, ...noFee }),
    (e) => e instanceof CurveRefusal && e.number === 6049 && e.message === "a sell cannot take more than the real reserve",
  );
});

test("a seeded quote is what it was (math.rs's own test)", () => {
  const q = quoteSwap({ direction: DIRECTION.BUY, amountIn: SOL, reserveBase: 1_000_000_000_000n, reserveQuote: 100n * SOL, lpFeeBps: 30, protocolFeeBps: 0 });
  assert.equal(q.amountOut, 9_871_580_343n);
  assert.equal(q.reserveInAfter, 101n * SOL);
});

test("the LP of a curve pool is isqrt(supply x virtual)", () => {
  const lp = curveInitialLp(S, V);
  assert.ok(lp * lp <= S * V && (lp + 1n) * (lp + 1n) > S * V);
});

test("graduationIfNow is what graduate does NOW: the graduation on a pool at or past its target, nothing below it", () => {
  const atTarget = graduationIfNow(poolAt(T));
  const later = graduationIfNow(poolAt(100n * SOL));
  assert.ok(atTarget.allowed && later.allowed);
  // a coin graduated later burns less: B x V / (R + V) at that moment, to one unit of rounding
  const B = later.reserveBaseAfter + later.burned;
  const formula = (B * V) / (100n * SOL + V);
  assert.ok(later.burned - formula >= 0n && later.burned - formula <= 1n);
  assert.ok(later.burned < atTarget.burned);
  assert.equal(bps(S, S - atTarget.burned), 680);
  assert.ok(bps(S, S - later.burned) < 680);
  // below the target the chain does nothing (or refuses): nothing burned, the reserves as they are
  const early = poolAt(10n * SOL);
  assert.deepEqual(graduationIfNow(early), { fee: 0n, reserveQuoteAfter: early.reserveQuote, reserveBaseAfter: early.reserveBase, burned: 0n, allowed: false });
  assert.equal(readyToGraduate(early), false);
  assert.equal(readyToGraduate(poolAt(T)), true);
  assert.equal(readyToGraduate({ ...poolAt(T), curveState: CURVE_GRADUATED }), false);
});

test("poolAfterGraduation: the pool as graduate leaves it, fee included; any other pool as it is", () => {
  const p = { ...poolAt(100n * SOL, 700), protocolFeesQuote: 5n, lpFeeBps: 100 };
  const g = graduation(p.reserveBase, p.reserveQuote, V, T, 700);
  const after = poolAfterGraduation(p);
  assert.equal(after.reserveBase, g.reserveBaseAfter);
  assert.equal(after.reserveQuote, g.reserveQuoteAfter);
  assert.equal(after.virtualQuote, 0n);
  assert.equal(after.graduationTarget, 0n);
  assert.equal(after.curveState, CURVE_GRADUATED);
  assert.equal(after.protocolFeesQuote, 5n + g.fee);
  assert.equal(after.graduationFeeBps, 700);
  assert.equal(after.lpFeeBps, 100);
  const below = poolAt(10n * SOL);
  assert.equal(poolAfterGraduation(below), below);
});

test("curveProgress: below the target both burns are the burn at the target; past it, the burn now is smaller", () => {
  const p = poolAt(10n * SOL);
  const prog = curveProgress(p, S);
  assert.equal(prog.state, "open");
  assert.equal(graduationBurn(p).forecast, true);
  assert.equal(prog.burnAtTarget, 68_052_930_056_711n);
  assert.equal(prog.burnIfGraduatedNow, prog.burnAtTarget);
  const past = poolAt(100n * SOL);
  const progPast = curveProgress(past, S);
  assert.equal(progPast.burnIfGraduatedNow, graduationIfNow(past).burned);
  assert.ok(progPast.burnAtTarget - 68_052_930_056_711n <= 1n && 68_052_930_056_711n - progPast.burnAtTarget <= 1n);
  assert.ok(progPast.burnIfGraduatedNow < progPast.burnAtTarget);
  const grad = curveProgress({ ...poolAt(T), curveState: CURVE_GRADUATED, virtualQuote: 0n, graduationTarget: 0n }, S);
  assert.equal(grad.state, "graduated");
  assert.equal(grad.burnIfGraduatedNow, 0n);
  assert.equal(grad.burnAtTarget, 0n);
  const seeded = curveProgress({ reserveBase: S, reserveQuote: 2n * SOL, virtualQuote: 0n, graduationTarget: 0n, graduationFeeBps: 0, curveState: CURVE_NONE }, S);
  assert.equal(seeded.state, "none");
});

// ---- where graduate goes, and the floor --------------------------------------------------------

const PLATFORM = { protocolFeeBps: 20, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000 };
/// The platform account as the chain holds it (451 bytes), for the client's own read.
function platformBytes() {
  const b = Buffer.alloc(451);
  Buffer.from(ACCOUNT_DISC.Platform).copy(b, 0);
  b.writeUInt16LE(PLATFORM.protocolFeeBps, 105); b.writeUInt16LE(1000, 107); b.writeUInt16LE(PLATFORM.maxHookFeeBps, 109); b.writeUInt16LE(PLATFORM.maxFeeOverrideBps, 111);
  b.writeBigUInt64LE(10_000_000n, 113);
  b.writeBigUInt64LE(V, 387); b.writeBigUInt64LE(T, 395); b.writeUInt16LE(0, 403);
  return b;
}
/// A connection that answers the reads `swapInstructions` makes: the platform, and no token
/// account of the wallet yet. It counts the platform reads.
function stubConnection() {
  const platformKey = pda.platform().toBase58();
  const data = platformBytes();
  const conn = {
    platformReads: 0,
    async getAccountInfo(key) { if (key.toBase58() === platformKey) { conn.platformReads++; return { data, owner: PROGRAMS.hookpool }; } return null; },
    async getMultipleAccountsInfo(keys) { return keys.map(() => null); },
  };
  return conn;
}
/// A pool without a hook trading against wrapped SOL, with the curve fields of `curve`.
function poolFor(curve) {
  const mint = Keypair.generate().publicKey;
  const k = poolKeys(mint, NATIVE_MINT);
  return {
    address: k.pool, bump: 255, baseMint: mint, quoteMint: NATIVE_MINT, baseVault: k.baseVault, quoteVault: k.quoteVault, lpMint: k.lpMint, lpLock: k.lpLock,
    baseTokenProgram: TOKEN_PROGRAM, quoteTokenProgram: TOKEN_PROGRAM, lpFeeBps: 100, hookProgram: SYSTEM_PROGRAM, hookFlags: 0, hookExtraMetas: SYSTEM_PROGRAM,
    hookQuoteTreasury: SYSTEM_PROGRAM, hookKind: 0, protocolFeesBase: 0n, protocolFeesQuote: 0n, hookFeesQuoteTotal: 0n, volumeQuoteTotal: 0n, swapCount: 0n,
    createdSlot: 1n, creator: SYSTEM_PROGRAM, hookFeesOwedQuote: 0n, hookTreasuryOwner: SYSTEM_PROGRAM, hasHook: false, ...curve,
  };
}
const isIx = (i, name) => i.programId.equals(PROGRAMS.hookpool) && Buffer.from(i.data).subarray(0, 8).equals(Buffer.from(IX.hookpool[name]));
/// Where graduate sits relative to the swap, and the floor the swap carries.
function layout(ixs) {
  const s = ixs.findIndex((i) => isIx(i, "swap")), g = ixs.findIndex((i) => isIx(i, "graduate"));
  return { graduate: g < 0 ? null : g === s - 1 ? "before" : g === s + 1 ? "after" : "elsewhere", count: ixs.filter((i) => isIx(i, "graduate")).length, floor: Buffer.from(ixs[s].data).readBigUInt64LE(17) };
}
const slip = (v) => (v * 9_900n) / 10_000n;          // 1% slippage, as a page applies it
const curveQuote = (pool, direction, amountIn) => quoteSwap({ direction, amountIn, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: pool.virtualQuote, lpFeeBps: pool.lpFeeBps, protocolFeeBps: PLATFORM.protocolFeeBps });

test("rule 2, the site's case: an 89.44 SOL buy from 0.29 SOL raised is quoted on the curve, graduate goes after the swap, and the signed floor is the user's slippage on that quote", async () => {
  const pool = poolFor(poolAt(290_000_000n));
  const conn = stubConnection();
  const client = new HookpoolClient(conn);
  const amountIn = 89_440_000_000n;
  const q = await client.quoteLocal(pool, PLATFORM, DIRECTION.BUY, amountIn, null);
  assert.equal(q.graduates, true);
  assert.equal(q.graduateFirst, false);
  assert.equal(q.amountOut, curveQuote(pool, DIRECTION.BUY, amountIn).amountOut);
  assert.ok(q.reserveInAfter >= T);
  assert.equal(q.amountOutIfGraduated, undefined);
  assert.equal(q.amountOutFloor, q.amountOut);
  const ixs = await client.swapInstructions(Keypair.generate().publicKey, pool, NO_HOOK, DIRECTION.BUY, amountIn, slip(q.amountOut));
  const l = layout(ixs);
  assert.equal(l.graduate, "after");
  assert.equal(l.count, 1);
  assert.equal(l.floor, slip(q.amountOut));            // never lowered: before the fix it was 98.7% under the quote
  assert.equal(conn.platformReads, 1);
});

test("rule 2 at the target's edge: a buy that crosses from 84 SOL graduates after the swap; a buy that falls short carries no graduate", async () => {
  const pool = poolFor(poolAt(84n * SOL));
  const client = new HookpoolClient(stubConnection());
  const cross = await client.quoteLocal(pool, PLATFORM, DIRECTION.BUY, 2n * SOL, null);
  assert.equal(cross.graduates, true);
  assert.equal(cross.graduateFirst, false);
  const l = layout(await client.swapInstructions(Keypair.generate().publicKey, pool, NO_HOOK, DIRECTION.BUY, 2n * SOL, slip(cross.amountOut)));
  assert.deepEqual([l.graduate, l.floor], ["after", slip(cross.amountOut)]);
  const short = await client.quoteLocal(pool, PLATFORM, DIRECTION.BUY, SOL / 2n, null);
  assert.equal(short.graduates, false);
  assert.equal(short.graduateFirst, undefined);
  const s = layout(await client.swapInstructions(Keypair.generate().publicKey, pool, NO_HOOK, DIRECTION.BUY, SOL / 2n, slip(short.amountOut)));
  assert.deepEqual([s.graduate, s.floor], [null, slip(short.amountOut)]);
});

test("rule 1: on a pool standing past its target a buy and a sell send graduate FIRST and are quoted exactly on the pool as graduation leaves it", async () => {
  const pool = poolFor(poolAt(100n * SOL));
  const graduated = poolAfterGraduation(pool);
  const conn = stubConnection();
  const client = new HookpoolClient(conn);
  for (const [direction, amountIn] of [[DIRECTION.BUY, 5n * SOL], [DIRECTION.BUY, 20n * SOL], [DIRECTION.SELL, 10_000_000_000_000n]]) {
    const q = await client.quoteLocal(pool, PLATFORM, direction, amountIn, null);
    assert.equal(q.graduates, true);
    assert.equal(q.graduateFirst, true);
    assert.equal(q.amountOut, curveQuote(graduated, direction, amountIn).amountOut);
    const l = layout(await client.swapInstructions(Keypair.generate().publicKey, pool, NO_HOOK, direction, amountIn, slip(q.amountOut)));
    assert.deepEqual([l.graduate, l.count, l.floor], ["before", 1, slip(q.amountOut)]);
  }
  // the review's numbers: on the curve the same buys would have been quoted about 1% (5 SOL)
  // and 4% (20 SOL) higher; quoted on the graduated pool they fill exactly as quoted
  const fewer = (amountIn) => bps(curveQuote(pool, DIRECTION.BUY, amountIn).amountOut, curveQuote(graduated, DIRECTION.BUY, amountIn).amountOut);
  assert.ok(fewer(5n * SOL) >= 100 && fewer(5n * SOL) <= 120, `5 SOL: ${fewer(5n * SOL)} bps`);
  assert.ok(fewer(20n * SOL) >= 380 && fewer(20n * SOL) <= 400, `20 SOL: ${fewer(20n * SOL)} bps`);
  // the pool alone decides it: no platform read for these
  assert.equal(conn.platformReads, 0);
});

test("rule 4: a sell that would take a pool past its target back under it on the curve is a sell on the graduated pool", async () => {
  const pool = poolFor(poolAt(86n * SOL));
  const client = new HookpoolClient(stubConnection());
  const amountIn = 50_000_000_000_000n;
  assert.ok(curveQuote(pool, DIRECTION.SELL, amountIn).reserveOutAfter < T);
  const q = await client.quoteLocal(pool, PLATFORM, DIRECTION.SELL, amountIn, null);
  assert.deepEqual([q.graduates, q.graduateFirst], [true, true]);
  assert.equal(q.amountOut, curveQuote(poolAfterGraduation(pool), DIRECTION.SELL, amountIn).amountOut);
  const l = layout(await client.swapInstructions(Keypair.generate().publicKey, pool, NO_HOOK, DIRECTION.SELL, amountIn, q.amountOut));
  assert.deepEqual([l.graduate, l.floor], ["before", q.amountOut]);
});

test("rule 3: nothing lowers a floor; opts.graduate decides when given; a sell below the target and a graduated pool carry no graduate", async () => {
  const user = Keypair.generate().publicKey;
  const ready = poolFor(poolAt(90n * SOL));
  const below = poolFor(poolAt(40n * SOL));
  const conn = stubConnection();
  const client = new HookpoolClient(conn);
  for (const minOut of [1n, 123_456_789n, 10n ** 15n]) {
    assert.equal(layout(await client.swapInstructions(user, ready, NO_HOOK, DIRECTION.BUY, 5n * SOL, minOut)).floor, minOut);
    assert.equal(layout(await client.swapInstructions(user, below, NO_HOOK, DIRECTION.BUY, 60n * SOL, minOut)).floor, minOut);
  }
  assert.equal(floorForGraduation(777n, { graduates: true, amountOut: 1000n, amountOutIfGraduated: 1n }), 777n);   // deprecated, returns its input
  assert.equal(layout(await client.swapInstructions(user, ready, NO_HOOK, DIRECTION.BUY, 5n * SOL, 1n, { graduate: false })).graduate, null);
  assert.equal(layout(await client.swapInstructions(user, below, NO_HOOK, DIRECTION.BUY, SOL, 1n, { graduate: true })).graduate, "after");
  const reads = conn.platformReads;
  assert.equal(layout(await client.swapInstructions(user, below, NO_HOOK, DIRECTION.SELL, 10n ** 12n, 1n)).graduate, null);
  assert.equal(conn.platformReads, reads);              // a sell below the target needs no quote
  const done = poolFor({ ...poolAt(T), curveState: CURVE_GRADUATED, virtualQuote: 0n, graduationTarget: 0n });
  assert.equal(layout(await client.swapInstructions(user, done, NO_HOOK, DIRECTION.BUY, 5n * SOL, 1n)).graduate, null);
  const q = await client.quoteLocal(done, PLATFORM, DIRECTION.BUY, 5n * SOL, null);
  assert.deepEqual([q.graduates, q.graduateFirst, q.amountOutFloor], [false, undefined, q.amountOut]);
});


test("the error table carries the pool's nine curve errors and the launchpad's; the admin bounds are the program's", () => {
  assert.deepEqual(Object.keys(CURVE_ERRORS).map(Number), [6043, 6044, 6045, 6046, 6047, 6048, 6049, 6050, 6051]);
  assert.equal(CURVE_ERRORS[6050].name, "CurvePegged");
  assert.equal(CURVE_ERRORS[6051].name, "CurveSettingsOutOfBounds");
  assert.equal(CURVE_PEGGED_ERROR.number, 6011);
  assert.equal(MAX_CURVE_VIRTUAL_QUOTE, 4_611_686_018_427_387_903n);
  assert.equal(curveSettingsProblem(MAX_CURVE_VIRTUAL_QUOTE + 1n, T), CURVE_ERRORS[6051]);
  assert.equal(curveSettingsProblem(V, V / 1000n - 1n), CURVE_ERRORS[6051]);
  assert.equal(curveSettingsProblem(V, V / 1000n), null);
  assert.equal(curveSettingsProblem(V, 0n), null);          // 0 switches the curve off
  assert.equal(curveSettingsProblem(0n, T), null);
  assert.equal(curveErrorFromLogs(["Program log: AnchorError occurred. Error Code: CurvePegged. Error Number: 6050. Error Message: a pegged coin cannot open a pool on the curve."]), CURVE_ERRORS[6050]);
  assert.equal(curveErrorFromLogs(["Program log: AnchorError occurred. Error Code: CurvePegged. Error Number: 6011. Error Message: a pegged coin cannot launch on the curve."]), CURVE_PEGGED_ERROR);
  assert.equal(curveErrorFromLogs(["Program log: AnchorError occurred. Error Code: Slippage. Error Number: 6008. Error Message: x."]), null);
});

test("a dust trade is 'amount too small' (the program's ZeroAmount), a hook's zero is 'not enough liquidity' (HookCurveInvalid)", () => {
  assert.throws(() => quoteSwap({ direction: DIRECTION.SELL, amountIn: 1n, reserveBase: S, reserveQuote: 0n, virtualQuote: V, lpFeeBps: 0, protocolFeeBps: 0 }), /amount too small/);
  assert.throws(() => quoteSwap({ direction: DIRECTION.BUY, amountIn: SOL, reserveBase: S, reserveQuote: 0n, virtualQuote: V, lpFeeBps: 0, protocolFeeBps: 0, curveOverride: 0n }), /not enough liquidity/);
});

test("willGraduate: a buy that crosses; every trade on a pool past its target (graduate first); never a sell below it", () => {
  const near = poolAt(T - SOL);
  const q = (pool, direction, amountIn) => quoteSwap({ direction, amountIn, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: V, lpFeeBps: 100, protocolFeeBps: 20 });
  assert.equal(willGraduate(near, DIRECTION.BUY, q(near, DIRECTION.BUY, 2n * SOL)), true);
  assert.equal(willGraduate(near, DIRECTION.BUY, q(near, DIRECTION.BUY, SOL / 2n)), false);
  assert.equal(willGraduate(near, DIRECTION.SELL, q(near, DIRECTION.SELL, 1_000_000_000n)), false);
  const past = poolAt(T + SOL);
  assert.equal(willGraduate(past, DIRECTION.SELL, q(past, DIRECTION.SELL, 1_000_000_000n)), true);
  assert.equal(willGraduate(past, DIRECTION.SELL, q(past, DIRECTION.SELL, 100_000_000_000_000n)), true);
  assert.equal(willGraduate({ ...past, curveState: CURVE_GRADUATED }, DIRECTION.BUY, q(past, DIRECTION.BUY, SOL)), false);
});

test("a first buy at launch: a plain coin counts no hook fee, a tax or buyback coin its own buy rate, any other hook the cap", async () => {
  const plat = { protocolFeeBps: PLATFORM.protocolFeeBps, maxHookFeeBps: PLATFORM.maxHookFeeBps, curveGraduationTarget: T };
  assert.equal(firstBuyHookFeeBps("none", {}, 1000), 0);
  assert.equal(firstBuyHookFeeBps(undefined, {}, 1000), 0);
  assert.equal(firstBuyHookFeeBps("launch_guard", {}, 1000), 0);
  assert.equal(firstBuyHookFeeBps("tax", { tax: { buyBps: 50 } }, 1000), 50);
  assert.equal(firstBuyHookFeeBps("tax", { tax: { buyBps: 5000 } }, 1000), 1000, "clamped to the cap, as the pool clamps it");
  assert.equal(firstBuyHookFeeBps("tax", { tax: { buyBps: NaN } }, 1000), 1000, "a rate not typed yet counts at the cap");
  assert.equal(firstBuyHookFeeBps("buyback", { buyback: { buyBps: 300 } }, 1000), 300);
  for (const t of ["rules", "collectible", "custom"]) assert.equal(firstBuyHookFeeBps(t, {}, 1000), 1000, t);
  // the program's order: the protocol fee first, the hook fee on what is left
  const after = 86n * SOL - (86n * SOL * 20n + 9_999n) / 10_000n;
  assert.equal(firstBuyRaised(86n * SOL, 20, 0), after);
  assert.equal(firstBuyRaised(86n * SOL, 20, 500), after - (after * 500n + 9_999n) / 10_000n);
  assert.equal(firstBuyRaised(86n * SOL, 20, 500), quoteSwap({ direction: DIRECTION.BUY, amountIn: 86n * SOL, reserveBase: S, reserveQuote: 0n, virtualQuote: V, lpFeeBps: 100, protocolFeeBps: 20, hookFeeBps: 500 }).reserveInAfter, "what quoteSwap leaves in the pool");
  assert.equal(firstBuyGraduates(86n * SOL, plat, 0), true);
  assert.equal(firstBuyGraduates(86n * SOL, plat, 1000), false, "the old rule (the cap) said no for a plain coin");
  assert.equal(firstBuyGraduates(0n, plat, 0), false);
  assert.equal(firstBuyGraduates(86n * SOL, { ...plat, curveGraduationTarget: 0n }, 0), false);

  // launchInstructions appends graduate after a first buy of 86 SOL on a plain coin, and on a
  // tax coin of 0.5% on buys, but not on a tax coin of 5% or a rules coin
  const client = new HookpoolClient(stubConnection());
  const launch = (template, extra = {}) => client.launchInstructions({
    dev: Keypair.generate().publicKey, mint: Keypair.generate(), name: "Test", symbol: "TST", uri: "", decimals: 6, totalSupply: S, quoteMint: NATIVE_MINT,
    lpFeeBps: 100, devBuyQuote: 86n * SOL, minDevBuyOut: 1n, curve: true, template, ...extra,
  });
  const graduates = (plan) => [plan.curve.graduatesAtLaunch, plan.launchTx.filter((i) => isIx(i, "graduate")).length];
  assert.deepEqual(graduates(await launch("none")), [true, 1]);
  assert.deepEqual(graduates(await launch("tax", { tax: { buyBps: 50, sellBps: 50, maxBps: 100 } })), [true, 1]);
  assert.deepEqual(graduates(await launch("tax", { tax: { buyBps: 500, sellBps: 500, maxBps: 500 } })), [false, 0]);
  assert.deepEqual(graduates(await launch("rules", { rules: {} })), [false, 0]);
  const short = await client.launchInstructions({
    dev: Keypair.generate().publicKey, mint: Keypair.generate(), name: "Test", symbol: "TST", uri: "", decimals: 6, totalSupply: S, quoteMint: NATIVE_MINT,
    lpFeeBps: 100, devBuyQuote: 85n * SOL, minDevBuyOut: 1n, curve: true, template: "none",
  });
  assert.deepEqual(graduates(short), [false, 0], "85 SOL less the protocol fee falls short of 85");
});
