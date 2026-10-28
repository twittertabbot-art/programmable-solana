// The curve launch (HOOKS.md section 2, "A pool on the curve") end to end through the SDK on
// a live chain. A curve launch needs no SOL from the creator: the pool prices the coin as if
// it held the platform's virtual SOL, pays out real SOL only, refuses liquidity until it
// holds the graduation target of real SOL, and then anyone's `graduate` drops the virtual
// part and burns the coins that keep the price. These coins are made:
//
//   A  a plain coin (no hook) on the curve: bought to the target by three wallets, a sell in
//      the middle, graduated by the buy that crosses the target, traded and given liquidity
//      afterwards
//   B  a modules coin (launch rules: creator fee and burn) on the curve, left OPEN: its burn
//      measures prices and depths on the effective quote
//   C  a strict coin on the curve with a graduation fee, graduated by a fourth wallet; the
//      platform collects the fee
//   D  a pool made directly with create_curve_pool, and E a seeded coin that cannot graduate
//   F  a pegged collectible coin, refused on the curve by the SDK and by the chain
//   G  the floor: a crossing buy carries the user's slippage on its curve quote; a wallet that
//      moves the pool first makes it revert, never fill low; the next buy on the pool left
//      standing past its target graduates it first and fills exactly as quoted
//   H  a sell on a pool standing past its target: graduate first, then a sell on the
//      graduated pool (on the curve it would have taken the pool back under the target)
//   I  a crossing buy and, in the same transaction, a sell that takes the pool back under
//      the target, then the appended graduate: it lands and the pool stays open
//
// Where `graduate` goes (sdk/README.md, "Where graduate goes, and the floor"): first on a
// pool that stands at or past its target, after the swap for a buy that crosses it. Nothing
// lowers a floor. For every trade the script compares the SDK's quote, the chain's
// simulation and what the chain paid, to the unit, and checks the pool's reserves against
// the quote.
//
// Some checks need revision 3 of the pool program (a graduate that finds an open pool below
// its target lands and does nothing). On an earlier hookpool they print NOT PASSED, the
// script goes on and ends with exit code 1.
//
//   node scripts/e2e-curve.mjs <localnet|devnet>
//
// It needs no key from your machine for the trades: every wallet is made here and funded by
// airdrop (about 900 SOL in all, so a local validator). The platform admin's key (the
// cluster's deployer) is used for one thing only when it is at hand: a graduation fee is set
// before coin C is launched and set back to its old value right after. It waits for the
// burn's 25-slot interval twice, so it runs for about three minutes.
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  HookpoolClient, NATIVE_MINT, DIRECTION, HOOK_KIND, PROGRAMS, TOKEN_2022_PROGRAM, IX, CURVE_NONE, CURVE_OPEN, CURVE_GRADUATED, CURVE_ERRORS, CURVE_PEGGED_ERROR, CurveRefusal,
  BURN_INTERVAL_SLOTS, BURN_OUTCOME, burnLowered, burnStep, candlesFromSwaps, curveErrorFromLogs, curveInitialLp, curveProgress, decodeTokenAmount, effectiveQuote, eventsFromTransaction,
  graduation, graduationBurn, graduationIfNow, isOnCurve, ix, mulDivCeil, pda, quoteSwap, rulesArgs, rulesBurnCapBps, rulesFirstBuyQuote, rulesPda, spotPrice, willGraduate,
  readyToGraduate, poolAfterGraduation, NO_HOOK,
} from "../sdk/dist/index.js";
import { RPC, connection, deployer, loadAlt, sendRefused, waitForSlot } from "./cluster.mjs";

const cluster = process.argv[2];
if (cluster !== "localnet" && cluster !== "devnet") {
  console.error("usage: node scripts/e2e-curve.mjs <localnet|devnet>\nThis rehearsal spends SOL on throwaway coins: it runs on a test chain only.");
  process.exit(1);
}
const conn = connection(cluster);
const table = loadAlt(cluster);
const client = new HookpoolClient(conn, { lookupTable: table });
let platform = await client.platform().catch(() => null);
if (!platform) { console.error(`Programmable is not initialised on ${cluster} (${RPC[cluster]}). From the repository root:\n  bash scripts/localnet.sh up\n  node scripts/init-platform.mjs localnet`); process.exit(1); }
if (!table) { console.error("the platform's lookup table is missing (web/deployments/<cluster>-alt.json): run node scripts/init-platform.mjs first"); process.exit(1); }
if (!platform.curveEnabled) { console.error("curve launches are switched off on this platform: set CURVE_VIRTUAL_SOL and CURVE_TARGET_SOL with scripts/init-platform.mjs"); process.exit(1); }
let admin = null;
try { admin = deployer(cluster); } catch { /* no deployer key here: the fee part is skipped */ }
const isAdmin = !!admin && platform.admin.equals(admin.publicKey);
const OURS = Object.values(PROGRAMS).map((p) => p.toBase58());

// ---- small tools ---------------------------------------------------------------------------
let checks = 0;
const check = (cond, msg) => { if (!cond) { console.error("CHECK FAILED: " + msg); process.exit(1); } checks++; console.log("  check  " + msg); };
/// A check that waits for a program change announced by the programs track: when it fails
/// the script says so, goes on, and ends with exit code 1 all the same.
const waiting = [];
const softCheck = (cond, msg, whenNot) => { if (cond) { checks++; console.log("  check  " + msg); } else { waiting.push(whenNot); console.log("  NOT PASSED  " + msg + ": " + whenNot); } };
const swapMinOut = (ixs) => { const s = ixs.find((i) => isIx(i, PROGRAMS.hookpool, "swap")); return Buffer.from(s.data).readBigUInt64LE(17); };
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));
const fmt = (v, dec = 9) => (Number(v) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dec });
const coins6 = (v) => fmt(v, 6);
const UNIT = 1_000_000n;                              // one coin, 6 decimals
const SUPPLY = 1_000_000_000n * UNIT;
const LP_FEE_BPS = 100;
const NETWORK_FEE = 5_000n;                           // one signature
const V = platform.curveVirtualQuote, TARGET = platform.curveGraduationTarget;
const measures = [];
const measure = (what, r) => measures.push({ what, cu: r.cu, size: r.size, table: r.table });
const isIx = (i, program, name) => i.programId.equals(program) && Buffer.from(i.data).subarray(0, 8).equals(Buffer.from(IX[program.equals(PROGRAMS.hookpool) ? "hookpool" : "hooklaunch"][name]));
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

console.log(`platform: virtual ${fmt(V)} SOL, graduation at ${fmt(TARGET)} real SOL, fee ${platform.curveGraduationFeeBps} bps; protocol fee ${platform.protocolFeeBps} bps; admin key ${isAdmin ? "at hand" : "not at hand (the fee part is skipped)"}`);

async function fund(wallets, amount) {
  await Promise.all(wallets.map(async (w) => conn.confirmTransaction(await conn.requestAirdrop(w.publicKey, Number(sol(amount))), "confirmed")));
}
async function fetchTx(sig) {
  for (let i = 0; i < 60; i++) {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx) return tx;
    await sleep(250);
  }
  console.error("transaction not found: " + sig); process.exit(1);
}
/// Send and read back: the slot, the compute units, the size on the wire and the events.
/// `table: true` sends a v0 transaction compiled with the platform's lookup table.
async function send(ixs, signers, label, { table = false } = {}) {
  let sig, size;
  try {
    if (table) {
      const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
      tx.sign(signers);
      size = tx.serialize().length;
      sig = await conn.sendTransaction(tx);
      const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error("transaction failed: " + JSON.stringify(res.value.err));
    } else {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = signers[0].publicKey;
      sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
      size = tx.serialize().length;
    }
  } catch (e) {
    console.error(`  FAILED ${label}`);
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null);
    console.error(logs ? logs.join("\n") : e.message);
    process.exit(1);
  }
  const tx = await fetchTx(sig);
  console.log(`  ok  ${label}`);
  return { sig, size, table, slot: BigInt(tx.slot), cu: tx.meta?.computeUnitsConsumed ?? null, events: eventsFromTransaction(tx, OURS), logs: tx.meta?.logMessages ?? [] };
}
/// Send something the chain must refuse and check the reason it gives by name. For a curve
/// error the SDK's `curveErrorFromLogs` must name it from the logs too. `table: true`
/// simulates a v0 transaction compiled with the lookup table instead.
async function refused(ixs, signers, label, reason, { table = false } = {}) {
  let text;
  if (table) {
    const { tx } = await client.buildTx(signers[0].publicKey, ixs);
    tx.sign(signers);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false });
    if (!sim.value.err) { console.error(`CHECK FAILED: the chain accepted what it had to refuse: ${label}`); process.exit(1); }
    console.log(`  refused  ${label}`);
    text = (sim.value.logs ?? []).join("\n");
  } else text = await sendRefused(conn, ixs, signers, label);
  if (!text.includes(reason)) console.error(text);
  const named = curveErrorFromLogs(text.split("\n"));
  const ours = [...Object.values(CURVE_ERRORS), CURVE_PEGGED_ERROR].some((e) => e.name === reason);
  check(text.includes(reason) && (!ours || (named && named.name === reason)), `refused, and the reason is ${reason}${named ? ` (${named.number}; the SDK reads it from the logs: "${named.message}")` : ""}`);
}
/// Call something the SDK must refuse with a CurveRefusal of this number.
async function sdkRefuses(f, info, label) {
  let err = null;
  try { await f(); } catch (e) { err = e; }
  if (!(err instanceof CurveRefusal) || err.number !== info.number) console.error(err);
  check(err instanceof CurveRefusal && err.number === info.number && err.code === info.name && err.message === info.message,
    `${label}: the SDK refuses before anything is sent, with ${info.name} (${info.number}): "${info.message}"`);
}
const tokenAmount = async (account) => { const a = await conn.getAccountInfo(account); return a ? decodeTokenAmount(new Uint8Array(a.data)) : 0n; };
const supplyOf = async (mint) => (await client.mint(mint)).supply;
const least = (a, b) => (a < b ? a : b);
/// The price of a pool as the chain holds it: a fraction (effective quote, base).
const price = (p) => [p.reserveQuote + p.virtualQuote, p.reserveBase];
/// Are two prices equal up to one unit of the coin, the second never below the first?
const priceKept = ([q1, b1], [q2, b2]) => q2 * b1 >= q1 * b2 && q2 * b1 < q1 * (b2 + 1n);

// ---- wallets ------------------------------------------------------------------------------
const W = { devA: Keypair.generate(), devB: Keypair.generate(), devC: Keypair.generate(), devD: Keypair.generate(), devE: Keypair.generate(), devF: Keypair.generate(),
  devG: Keypair.generate(), devH: Keypair.generate(), devI: Keypair.generate(),
  t1: Keypair.generate(), t2: Keypair.generate(), t3: Keypair.generate(), t4: Keypair.generate(), stranger: Keypair.generate(),
  g1: Keypair.generate(), g2: Keypair.generate(), g3: Keypair.generate(), g4: Keypair.generate(), h1: Keypair.generate(), i1: Keypair.generate() };
await fund([W.devA, W.devB, W.devC, W.devD, W.devE, W.devF, W.devG, W.devH, W.devI, W.stranger, W.g4], 3);
await fund([W.t1, W.t2, W.t3, W.t4, W.h1, W.i1], 110);
await fund([W.g1, W.g2, W.g3], 70);
console.log("wallets funded");

// ---- one trade with every comparison -----------------------------------------------------------
/// The SDK's instant quote, the chain's simulation, what the chain paid, the reserves the
/// event and the pool read afterwards, and whether the transaction carried `graduate`.
async function trade(coin, wallet, direction, amountIn, label, { table = false, graduates = null } = {}) {
  const isBuy = direction === DIRECTION.BUY;
  const unit = isBuy ? "coins" : "SOL", dec = isBuy ? 6 : 9;
  const pool = await client.pool(coin.pool);
  const info = await client.hookInfo(pool);
  const local = await client.quoteLocal(pool, platform, direction, amountIn, info);
  const simulated = await client.quoteOnChain(wallet.publicKey, pool, direction, amountIn);
  const coinsBefore = await client.tokenBalance(wallet.publicKey, coin.mint, pool.baseTokenProgram);
  const lamportsBefore = BigInt(await conn.getBalance(wallet.publicKey));
  const ixs = await client.swapInstructions(wallet.publicKey, pool, await client.hookRef(pool, wallet.publicKey), direction, amountIn, local.amountOut);
  const carried = ixs.filter((i) => isIx(i, PROGRAMS.hookpool, "graduate")).length;
  const swapAt = ixs.findIndex((i) => isIx(i, PROGRAMS.hookpool, "swap"));
  const gradAt = ixs.findIndex((i) => isIx(i, PROGRAMS.hookpool, "graduate"));
  // where graduate goes: FIRST on a pool that stands at or past its target, AFTER the swap
  // for a buy that crosses the target from below
  const first = readyToGraduate(pool);
  check(local.graduates === willGraduate(pool, direction, local) && carried === (local.graduates ? 1 : 0) && (local.graduates ? local.graduateFirst === first : local.graduateFirst === undefined)
    && (carried === 0 || gradAt === (first ? swapAt - 1 : swapAt + 1)) && (graduates === null || local.graduates === graduates),
    `${label}: the quote says graduates = ${local.graduates}${local.graduates ? (first ? " (the pool stands at or past its target: graduate goes first)" : " (this buy crosses the target: graduate goes after the swap)") : ""}; the transaction carries ${carried} graduate instruction${carried === 1 ? (first ? ", right before the swap" : ", right after the swap") : "s"}`);
  // the floor: sent as the caller gave it (here the exact quote); nothing lowers it. The quote
  // is made on the pool the swap really runs on: the graduated pool when graduate goes first.
  const sentMin = swapMinOut(ixs);
  const runsOn = first ? poolAfterGraduation(pool) : pool;
  const byHand = info ? null : quoteSwap({ direction, amountIn, reserveBase: runsOn.reserveBase, reserveQuote: runsOn.reserveQuote, virtualQuote: runsOn.virtualQuote, lpFeeBps: pool.lpFeeBps, protocolFeeBps: platform.protocolFeeBps }).amountOut;
  check(sentMin === local.amountOut && local.amountOutFloor === local.amountOut && local.amountOutIfGraduated === undefined && (byHand === null || byHand === local.amountOut),
    `${label}: the swap carries the caller's floor as given, nothing lowered${byHand === null ? "" : first ? "; by hand the quote is the trade on the pool as graduation leaves it" : pool.curveState === CURVE_OPEN ? "; by hand the quote is the trade on the curve" : ""}`);
  const r = await send(ixs, [wallet], label, { table });
  const ev = r.events.find((e) => e.kind === "Swapped");
  const grad = r.events.find((e) => e.kind === "Graduated") ?? null;
  const coinsAfter = await client.tokenBalance(wallet.publicKey, coin.mint, pool.baseTokenProgram);
  const received = isBuy ? coinsAfter - coinsBefore : BigInt(await conn.getBalance(wallet.publicKey)) - lamportsBefore + NETWORK_FEE;
  check(local.amountOut === simulated && simulated === ev.amountOut && received === ev.amountOut, `${label}: quoted ${fmt(local.amountOut, dec)} ${unit}, simulated the same, received the same`);
  const [realQuoteAfter, realBaseAfter] = isBuy ? [local.reserveInAfter, local.reserveOutAfter] : [local.reserveOutAfter, local.reserveInAfter];
  check(ev.reserveQuote === realQuoteAfter && ev.reserveBase === realBaseAfter, `${label}: the Swapped event carries the REAL reserves the quote predicted: ${fmt(ev.reserveQuote)} SOL and ${coins6(ev.reserveBase)} coins`);
  if (!isBuy) check(local.amountOutGross <= runsOn.reserveQuote && ev.reserveQuote === runsOn.reserveQuote - local.amountOutGross, `${label}: the sell was paid from the real SOL alone (${fmt(local.amountOutGross)} of the ${fmt(runsOn.reserveQuote)} SOL in the pool), the virtual part untouched`);
  const after = await client.pool(coin.pool);
  if (first) {
    const gi = r.events.findIndex((e) => e.kind === "Graduated"), si = r.events.findIndex((e) => e.kind === "Swapped");
    check(grad && gi < si && grad.reserveQuoteBefore === pool.reserveQuote && grad.reserveBaseBefore === pool.reserveBase && grad.reserveBaseAfter === runsOn.reserveBase && grad.reserveQuoteAfter === runsOn.reserveQuote
      && after.curveState === CURVE_GRADUATED && after.virtualQuote === 0n && after.reserveQuote === ev.reserveQuote && after.reserveBase === ev.reserveBase,
      `${label}: the pool graduated first (its Graduated event comes before the Swapped one, ${coins6(grad.burnedBase)} coins burned) and the trade ran on the graduated pool`);
  } else if (!grad) {
    check(after.reserveQuote === ev.reserveQuote && after.reserveBase === ev.reserveBase && after.curveState === pool.curveState && after.virtualQuote === pool.virtualQuote, `${label}: the pool reads the same reserves; its curve state did not change`);
  }
  check(!!grad === (carried === 1), `${label}: ${grad ? "a Graduated event came with the trade" : "no Graduated event"}`);
  return { ...r, ev, grad, local, before: pool, after, received, info, first };
}

/// Send `graduate` alone where the chain must land it and change nothing: the pool account's
/// bytes, the coin's supply, and no Graduated event. `rev3`: a call that only revision 3 of
/// the pool program lands (an open pool below its target); on an earlier hookpool the check
/// says so, the script goes on, and it ends with exit code 1.
async function graduateChangesNothing(pool, mint, label, { rev3 = false } = {}) {
  const ixs = client.graduateInstructions(pool, { check: false });
  const bytesBefore = Buffer.from((await conn.getAccountInfo(pool.address)).data).toString("hex");
  const supplyBefore = await supplyOf(mint);
  let landed = null, events = [];
  try {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = W.stranger.publicKey;
    const sig = await sendAndConfirmTransaction(conn, tx, [W.stranger], { commitment: "confirmed" });
    events = eventsFromTransaction(await fetchTx(sig), OURS);
    landed = true;
  } catch (e) {
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null);
    const named = curveErrorFromLogs(logs ?? [String(e.message)]);
    landed = named ? `refused with ${named.name} (${named.number})` : `refused: ${e.message}`;
  }
  const same = Buffer.from((await conn.getAccountInfo(pool.address)).data).toString("hex") === bytesBefore && (await supplyOf(mint)) === supplyBefore && !events.some((e) => e.kind === "Graduated");
  const msg = `${label}: the chain lands it and nothing changes: the pool account's bytes and the coin's supply are the same, no Graduated event`;
  if (rev3) softCheck(landed === true && same, msg, landed === true ? `${label}: it landed but something changed` : `${label}: the chain's hookpool ${landed}; revision 3 (graduate does nothing on an open pool below its target) is not on this chain yet`);
  else check(landed === true && same, msg + (landed === true ? "" : ` (${landed})`));
}

// ---- a launch on the curve ----------------------------------------------------------------------
const coins = [];
async function launchCurveCoin(letter, name, symbol, dev, { template = "none", rules, devBuy = 0n, table = false, feeBps = platform.curveGraduationFeeBps } = {}) {
  const mint = Keypair.generate();
  const opts = { dev: dev.publicKey, mint, name, symbol, uri: `https://example.com/meta/${symbol.toLowerCase()}.json`, decimals: 6, totalSupply: SUPPLY, quoteMint: NATIVE_MINT, lpFeeBps: LP_FEE_BPS, curve: true, devBuyQuote: devBuy, minDevBuyOut: devBuy > 0n ? 1n : 0n, template, rules };
  const plan = await client.launchInstructions(opts);
  const lp = curveInitialLp(SUPPLY, V);
  check(plan.curve && plan.curve.virtualQuote === V && plan.curve.graduationTarget === TARGET && plan.curve.graduationFeeBps === feeBps && plan.curve.lpLocked === lp && plan.curve.graduatesAtLaunch === false,
    `${letter}: the plan states the curve the pool gets (virtual ${fmt(V)} SOL, target ${fmt(TARGET)} SOL, fee ${feeBps} bps) and the ${lp} LP units that go into the lock account`);
  check(plan.launchTx.some((i) => isIx(i, PROGRAMS.hooklaunch, "launch_curve")) && !plan.launchTx.some((i) => isIx(i, PROGRAMS.hooklaunch, "launch")),
    `${letter}: the launch transaction carries launch_curve, not launch`);
  const wraps = plan.launchTx.filter((i) => i.programId.equals(SystemProgram.programId)).length;
  check(wraps === (devBuy > 0n ? 1 : 0), devBuy > 0n ? `${letter}: only the first buy of ${fmt(devBuy)} SOL is wrapped: no SOL goes into the pool from the creator` : `${letter}: no SOL is wrapped: the creator puts nothing into the pool`);
  const devSol = BigInt(await conn.getBalance(dev.publicKey));
  const t1 = await send(plan.createTx, [dev, ...plan.signers], `${letter}: transaction 1, the coin${table ? " (with the lookup table)" : ""}`, { table });
  const t2 = await send(plan.launchTx, [dev], `${letter}: transaction 2, the pool on the curve${table ? " (with the lookup table)" : ""}`, { table });
  measure(`${letter} launch_curve transaction${devBuy > 0n ? " with a first buy" : ""} (${template})`, t2);
  const spent = devSol - BigInt(await conn.getBalance(dev.publicKey));
  check(spent < platform.launchFeeLamports + devBuy + sol(0.1), `${letter}: the creator paid ${fmt(spent)} SOL in all: the launch fee, rents, network fees${devBuy > 0n ? " and the first buy" : ""}; nothing went into the pool`);

  const pool = await client.pool(plan.pool);
  check(pool.curveState === CURVE_OPEN && isOnCurve(pool) && pool.virtualQuote === V && pool.graduationTarget === TARGET && pool.graduationFeeBps === feeBps,
    `${letter}: the pool is on the curve with the platform's settings copied in`);
  const lpSupply = (await client.mint(pool.lpMint)).supply;
  check(lpSupply === lp && (await tokenAmount(pool.lpLock)) === lpSupply && (await client.tokenBalance(dev.publicKey, pool.lpMint)) === 0n,
    `${letter}: the LP supply is isqrt(supply x virtual) = ${lpSupply}, all of it in the pool's lock account, the creator holds none`);
  const launch = await client.launchForMint(mint.publicKey);
  check(launch.curve === true && launch.lpLocked === lpSupply && launch.devBuyQuote === devBuy && launch.dev.equals(dev.publicKey), `${letter}: the launch record is marked as a curve launch and holds the locked LP`);
  const created = t2.events.find((e) => e.kind === "PoolCreated"), opened = t2.events.find((e) => e.kind === "CurveOpened"), launched = t2.events.find((e) => e.kind === "Launched");
  check(created && created.quoteAmount === 0n && created.lpMinted === 0n && created.baseAmount === SUPPLY, `${letter}: PoolCreated says no quote and no LP to the creator`);
  check(opened && opened.pool.equals(plan.pool) && opened.virtualQuote === V && opened.graduationTarget === TARGET && opened.graduationFeeBps === feeBps && opened.slot === t2.slot,
    `${letter}: CurveOpened decodes with the pool's settings and the slot`);
  check(launched && launched.lpLocked === lpSupply && launched.pool.equals(plan.pool), `${letter}: Launched says the whole LP is locked`);
  const buy = t2.events.find((e) => e.kind === "Swapped");
  if (devBuy > 0n) {
    const hookInfo = await client.hookInfo(pool);
    const first = template === "rules"
      ? rulesFirstBuyQuote(rulesArgs(rules), { totalSupply: SUPPLY, quoteAmount: 0n, lpFeeBps: LP_FEE_BPS, devBuyQuote: devBuy, virtualQuote: V }, platform)
      : quoteSwap({ direction: DIRECTION.BUY, amountIn: devBuy, reserveBase: SUPPLY, reserveQuote: 0n, virtualQuote: V, lpFeeBps: LP_FEE_BPS, protocolFeeBps: platform.protocolFeeBps, hookFeeBps: hookInfo?.tax ? hookInfo.tax.buyBps : 0 });
    check(buy && buy.amountOut === first.amountOut && pool.reserveQuote === first.reserveInAfter && pool.reserveBase === first.reserveOutAfter && (await client.tokenBalance(dev.publicKey, mint.publicKey, pool.baseTokenProgram)) === first.amountOut,
      `${letter}: the first buy was priced on the curve: ${coins6(first.amountOut)} coins for ${fmt(devBuy)} SOL, as the SDK worked out before the pool existed; the real reserve is ${fmt(pool.reserveQuote)} SOL`);
  } else {
    check(!buy && pool.reserveQuote === 0n && pool.reserveBase === SUPPLY, `${letter}: no first buy: the pool holds the whole supply and no real SOL`);
  }
  check(effectiveQuote(pool) === pool.reserveQuote + V, `${letter}: the effective quote is the real SOL plus the virtual ${fmt(V)} SOL`);
  const prog = await client.curveProgress(pool);
  const expectCap = ((pool.reserveQuote + V) * SUPPLY) / pool.reserveBase;
  // the burn at the target, by hand: the pool walked along the fee-less curve to the target,
  // Bt = (R + V) B / (T + V), then fee = min(T x bps / 10000, T - 1) and Bt - (T - fee) Bt / (T + V)
  const Bt = ((pool.reserveQuote + V) * pool.reserveBase) / (TARGET + V), wantedFee = (TARGET * BigInt(feeBps)) / 10_000n;
  const burnAt = Bt - ((TARGET - (wantedFee < TARGET - 1n ? wantedFee : TARGET - 1n)) * Bt) / (TARGET + V);
  check(prog.state === "open" && prog.open && !prog.graduated && prog.raised === pool.reserveQuote && prog.target === TARGET && prog.raisedBps === Number((pool.reserveQuote * 10_000n) / TARGET)
    && prog.soldBps === Number(((SUPPLY - pool.reserveBase) * 10_000n) / SUPPLY) && prog.startMarketCapQuote === V && prog.marketCapQuote === expectCap && prog.virtualQuote === V
    && prog.burnAtTarget === burnAt && prog.burnIfGraduatedNow === burnAt,
    `${letter}: curveProgress: raised ${fmt(prog.raised)} of ${fmt(prog.target)} SOL (${prog.raisedBps} bps), ${prog.soldBps} bps of the supply sold, market cap ${fmt(prog.startMarketCapQuote)} SOL at the start and ${fmt(prog.marketCapQuote)} SOL now; ${coins6(prog.burnAtTarget)} coins burn at the target (by hand the same), and below the target that is also its burnIfGraduatedNow`);
  const sp = spotPrice(pool, 6, 9);
  check(Math.abs(sp - (Number(pool.reserveQuote + V) / Number(pool.reserveBase)) * 1e-3) < 1e-18 && sp > 0, `${letter}: spotPrice uses the effective quote: ${sp.toExponential(4)} SOL per coin`);
  const coin = { letter, name, symbol, mint: mint.publicKey, pool: plan.pool, dev, plan, launch: t2 };
  coins.push(coin);
  return coin;
}

// ---- A. a plain coin on the curve: open, trade, refuse, graduate, trade -------------------------------------
section("A. A plain coin on the curve (no hook, no first buy)");
const A = await launchCurveCoin("A", "Curve Plain", "CPLAIN", W.devA);

section("A. The first buy to the unit, a sell paid from real SOL only");
const a1 = await trade(A, W.t1, DIRECTION.BUY, sol(1), "A: the first buy, 1 SOL", { graduates: false });
{
  // the constant product by hand, with the virtual quote in: out = B * net / (V + R + net)
  const net = a1.local.netIn;
  check(a1.ev.amountOut === (SUPPLY * net) / (V + net), `A: by hand, ${coins6(a1.ev.amountOut)} coins = supply x net / (virtual + net): the price is made with the virtual SOL`);
  check(a1.after.reserveQuote === a1.local.netIn + a1.local.lpFee && a1.after.reserveQuote < sol(1), `A: the real reserve is the net input plus the pool fee, ${fmt(a1.after.reserveQuote)} SOL; the protocol fee stays outside the reserves`);
  check(priceKept([V, SUPPLY], price(a1.after)) === false && (a1.after.reserveQuote + V) * SUPPLY > V * a1.after.reserveBase, "A: the price rose: (real + virtual) / base is above the opening price");
  check((await tokenAmount(a1.after.quoteVault)) === a1.after.reserveQuote + a1.after.protocolFeesQuote, "A: the quote vault holds the real reserve plus the protocol fee, nothing else: the virtual SOL is nowhere");
}
const a2 = await trade(A, W.t1, DIRECTION.SELL, a1.received / 2n, "A: the buyer sells half back", { graduates: false });
check((await tokenAmount(a2.after.quoteVault)) === a2.after.reserveQuote + a2.after.protocolFeesQuote, "A: after the sell the quote vault still equals the real reserve plus the protocol fee");

section("A. A sell past the real reserve cannot be built; liquidity and graduation are refused while the curve is open");
{
  // the belt: a sell whose gross output would pass the real reserve (not reachable with
  // coins that exist, so the reserves are made up)
  await sdkRefuses(() => quoteSwap({ direction: DIRECTION.SELL, amountIn: SUPPLY / 2n, reserveBase: SUPPLY / 2n, reserveQuote: sol(1), virtualQuote: V, lpFeeBps: LP_FEE_BPS, protocolFeeBps: platform.protocolFeeBps }),
    CURVE_ERRORS[6049], "a sell of half the supply into a pool with 1 real SOL (made-up reserves)");
  const pool = await client.pool(A.pool);
  const all = await client.tokenBalance(W.t1.publicKey, A.mint);
  const q = await client.quoteLocal(pool, platform, DIRECTION.SELL, all, null);
  check(q.amountOutGross <= pool.reserveQuote && q.amountOutGross > 0n, `A: a sell of everything the wallet holds is quoted (${fmt(q.amountOutGross)} of ${fmt(pool.reserveQuote)} real SOL): coins that came out of the pool never reach the belt`);
  // liquidity: the SDK first, with the chain's sentence, then the chain by name
  await sdkRefuses(() => client.addLiquidityInstructions(W.t1.publicKey, pool, 1_000n, sol(1), sol(1)), CURVE_ERRORS[6045], "A: adding liquidity while the curve is open");
  await sdkRefuses(() => client.removeLiquidityInstructions(W.t1.publicKey, pool, 1_000n, 0n, 0n), CURVE_ERRORS[6045], "A: removing liquidity while the curve is open");
  const k = client.keys(pool);
  const hook = await client.hookRef(pool, W.t1.publicKey);
  await refused([ix.createAtaIdempotent(W.t1.publicKey, W.t1.publicKey, NATIVE_MINT), ix.createAtaIdempotent(W.t1.publicKey, W.t1.publicKey, pool.lpMint), ix.addLiquidity(W.t1.publicKey, k, hook, 1_000n, sol(1), sol(1))],
    [W.t1], "A: add_liquidity by hand", "CurveOpen");
  await refused([ix.createAtaIdempotent(W.t1.publicKey, W.t1.publicKey, NATIVE_MINT), ix.createAtaIdempotent(W.t1.publicKey, W.t1.publicKey, pool.lpMint), ix.removeLiquidity(W.t1.publicKey, k, hook, 1n, 0n, 0n)],
    [W.t1], "A: remove_liquidity by hand", "CurveOpen");
  // graduation before the target: the SDK says so in words; the chain (revision 3) lands the
  // call and does nothing
  await sdkRefuses(() => client.graduateInstructions(pool), CURVE_ERRORS[6048], "A: graduateInstructions below the target");
  await graduateChangesNothing(pool, A.mint, "A: graduate by hand, below the target", { rev3: true });
  const progA = await client.curveProgress(pool);
  const nowA = graduationIfNow(pool);
  check(graduationBurn(pool).forecast === true && progA.burnAtTarget === graduationBurn(pool).burned && progA.burnIfGraduatedNow === progA.burnAtTarget && !nowA.allowed && nowA.burned === 0n && !readyToGraduate(pool),
    `A: below the target graduationBurn is a forecast at the target (${coins6(progA.burnAtTarget)} coins, also burnIfGraduatedNow); graduationIfNow says a graduate now does nothing`);
}

section("A. Three wallets buy until the target; the buy that crosses it graduates the coin");
const buyers = [W.t1, W.t2, W.t3];
let crossing = null, step = 0;
for (;;) {
  const pool = await client.pool(A.pool);
  const q = await client.quoteLocal(pool, platform, DIRECTION.BUY, sol(20), null);
  const wallet = buyers[step % buyers.length];
  if (q.graduates) {
    check(pool.reserveQuote < TARGET && q.reserveInAfter >= TARGET && q.graduateFirst === false, `A: the pool holds ${fmt(pool.reserveQuote)} SOL; a buy of 20 SOL takes it to ${fmt(q.reserveInAfter)} SOL, past the target: the SDK says this buy graduates, after the swap`);
    // the floor of the crossing buy, built with the user's 1% slippage: exactly amountOut x 0.99, never lower
    const slipped = (q.amountOut * 9_900n) / 10_000n;
    const withSlip = await client.swapInstructions(wallet.publicKey, pool, await client.hookRef(pool, wallet.publicKey), DIRECTION.BUY, sol(20), slipped);
    check(swapMinOut(withSlip) === slipped && swapMinOut(withSlip) >= (q.amountOut * 9_900n) / 10_000n,
      `A: built with 1% slippage, the crossing buy carries the floor ${coins6(slipped)} coins = amountOut x (1 - 1%): never below it`);
    const supplyBefore = await supplyOf(A.mint);
    crossing = await trade(A, wallet, DIRECTION.BUY, sol(20), `A: the buy that crosses the target (wallet ${step % buyers.length + 1})`, { graduates: true });
    measure("A swap that crosses the target, with graduate appended (no hook)", crossing);
    const { ev, grad, before, after } = crossing;
    // the pool right after the swap and before graduate: the event's real reserves with the virtual still in
    const atSwap = { ...before, reserveBase: ev.reserveBase, reserveQuote: ev.reserveQuote };
    const g = graduation(ev.reserveBase, ev.reserveQuote, V, TARGET, before.graduationFeeBps);
    check(priceKept(price(atSwap), price(after)), `A: the price before graduation, (${fmt(ev.reserveQuote)} + ${fmt(V)}) / ${coins6(ev.reserveBase)}, equals the price after, ${fmt(after.reserveQuote)} / ${coins6(after.reserveBase)}, up to one unit of the coin`);
    check(grad.burnedBase === g.burned && grad.feeQuote === g.fee && grad.reserveQuoteBefore === ev.reserveQuote && grad.reserveBaseBefore === ev.reserveBase && grad.reserveQuoteAfter === g.reserveQuoteAfter && grad.reserveBaseAfter === g.reserveBaseAfter && grad.slot === crossing.slot,
      `A: the Graduated event says ${coins6(grad.burnedBase)} coins burned and a fee of ${fmt(grad.feeQuote)} SOL, exactly the SDK's graduation()`);
    const gb = graduationBurn(atSwap), gn = graduationIfNow(atSwap);
    const byFormula = (ev.reserveBase * V) / (ev.reserveQuote + V);           // B x V / (R + V), one unit of rounding apart from B - floor(R B / (R + V))
    check(!gb.forecast && gb.burned === grad.burnedBase && gb.fee === grad.feeQuote && gn.allowed && gn.burned === grad.burnedBase && grad.burnedBase - byFormula >= 0n && grad.burnedBase - byFormula <= 1n && Number((grad.burnedBase * 10_000n) / supplyBefore) < 680,
      `A: graduationBurn and graduationIfNow on the pool as it stood after the swap give the same numbers; the burn is B x V / (R + V) at that moment, ${Number((grad.burnedBase * 10_000n) / supplyBefore)} bps of the supply (less than the 680 bps a graduation at exactly the target burns)`);
    check(after.curveState === CURVE_GRADUATED && !isOnCurve(after) && after.virtualQuote === 0n && after.graduationTarget === 0n && after.graduationFeeBps === before.graduationFeeBps
      && after.reserveQuote === g.reserveQuoteAfter && after.reserveBase === g.reserveBaseAfter && after.protocolFeesQuote === before.protocolFeesQuote + ev.protocolFee + g.fee,
      `A: the pool graduated: virtual and target are 0, the fee bps stays as a record, the reserves are ${fmt(after.reserveQuote)} SOL and ${coins6(after.reserveBase)} coins, the protocol fee counter grew by the buy's fee and the graduation fee`);
    check(supplyBefore - (await supplyOf(A.mint)) === grad.burnedBase && (await tokenAmount(after.baseVault)) === after.reserveBase + after.protocolFeesBase, `A: the supply fell by the burn; the base vault holds the reserve plus the protocol fee in coins`);
    check((await client.mint(after.lpMint)).supply === curveInitialLp(SUPPLY, V) && (await tokenAmount(after.lpLock)) === curveInitialLp(SUPPLY, V), "A: the LP did not move: all of it is still locked");
    const prog = await client.curveProgress(after);
    check(prog.state === "graduated" && prog.graduated && !prog.open && prog.raisedBps === 10_000 && prog.target === 0n && prog.raised === after.reserveQuote && prog.startMarketCapQuote === null && prog.burnAtTarget === 0n && prog.burnIfGraduatedNow === 0n && prog.virtualQuote === 0n,
      `A: curveProgress reads graduated: raised ${fmt(prog.raised)} SOL, market cap ${fmt(prog.marketCapQuote)} SOL, ${prog.soldBps} bps of the supply outside the pool`);
    check(Math.abs(spotPrice(after, 6, 9) / spotPrice(atSwap, 6, 9) - 1) < 1e-9, "A: spotPrice before and after graduation agree");
    break;
  }
  const t = await trade(A, wallet, DIRECTION.BUY, sol(20), `A: wallet ${step % buyers.length + 1} buys for 20 SOL`, { graduates: false });
  check(t.after.curveState === CURVE_OPEN && t.after.reserveQuote < TARGET, `A: raised ${fmt(t.after.reserveQuote)} of ${fmt(TARGET)} SOL, still on the curve`);
  step++;
  if (step > 20) { console.error("CHECK FAILED: the target was not reached in 20 buys"); process.exit(1); }
}

section("A. After graduation: a second graduate lands and changes nothing, liquidity works, trades are quoted with the real reserve");
{
  const pool = await client.pool(A.pool);
  const again = client.graduateInstructions(pool);
  check(again.length === 1 && isIx(again[0], PROGRAMS.hookpool, "graduate"), "A: graduateInstructions builds on a graduated pool: a second graduate is allowed to land");
  // graduate is idempotent on a graduated pool (review finding F1, revision 2)
  await graduateChangesNothing(pool, A.mint, "A: a second graduate, by a stranger");
  const lpSupply = (await client.mint(pool.lpMint)).supply;
  const lp = lpSupply / 1_000n;
  const most = (reserve) => (mulDivCeil(lp, reserve, lpSupply) * 101n) / 100n;
  await send(await client.addLiquidityInstructions(W.t1.publicKey, pool, lp, most(pool.reserveBase), most(pool.reserveQuote)), [W.t1], "A: a wallet adds liquidity after graduation");
  check((await client.tokenBalance(W.t1.publicKey, pool.lpMint)) === lp, `A: liquidity opened at graduation: the wallet holds the ${lp} LP units it asked for`);
  const p2 = await client.pool(A.pool);
  check(p2.reserveQuote > pool.reserveQuote && p2.reserveBase > pool.reserveBase && p2.virtualQuote === 0n, "A: the reserves grew by the deposit; no virtual part");
  await send(await client.removeLiquidityInstructions(W.t1.publicKey, p2, lp, 0n, 0n), [W.t1], "A: the wallet takes it out again");
  check((await client.tokenBalance(W.t1.publicKey, pool.lpMint)) === 0n, "A: removing liquidity works too");
  const b = await trade(A, W.t2, DIRECTION.BUY, sol(1), "A: a buy after graduation", { graduates: false });
  check(b.local.graduates === false && b.after.virtualQuote === 0n && b.ev.amountOut === quoteSwap({ direction: DIRECTION.BUY, amountIn: sol(1), reserveBase: b.before.reserveBase, reserveQuote: b.before.reserveQuote, lpFeeBps: LP_FEE_BPS, protocolFeeBps: platform.protocolFeeBps }).amountOut,
    "A: the buy is quoted with the real reserve alone, as on a seeded pool");
  await trade(A, W.t3, DIRECTION.SELL, (await client.tokenBalance(W.t3.publicKey, A.mint)) / 3n, "A: a sell after graduation", { graduates: false });
  // the coin's history: both curve events, and a chart that prices the curve part right
  const events = await client.curveEvents(A.pool);
  check(events.opened && events.opened.virtualQuote === V && events.graduated && events.graduated.burnedBase === crossing.grad.burnedBase && events.graduated.slot === crossing.slot,
    `A: curveEvents finds CurveOpened and Graduated (slot ${events.graduated.slot}) in the pool's history`);
  const swaps = await client.recentSwaps(A.pool, 50);
  const curve = { virtualQuote: events.opened.virtualQuote, graduatedSlot: events.graduated.slot };
  const onCurve = swaps.filter((s) => s.slot <= events.graduated.slot);
  const withCurve = candlesFromSwaps(onCurve, 6, 9, 1, curve);
  const without = candlesFromSwaps(onCurve, 6, 9, 1);
  const cross = swaps.find((s) => s.slot === events.graduated.slot);
  const priceAtCross = (Number(cross.reserveQuote + curve.virtualQuote) / Number(cross.reserveBase)) * 1e-3;
  // every price of a candle made with the virtual quote is above the same price made from
  // the real reserve alone (two trades in one second share a candle, so the four prices
  // are compared each with its own counterpart)
  const above = withCurve.length === without.length && withCurve.every((c, i) => c.open > without[i].open && c.close > without[i].close && c.high > without[i].high && c.low > without[i].low);
  check(swaps.length >= 8 && onCurve.length >= 6 && above && Math.abs(priceAtCross / spotPrice(crossing.after, 6, 9) - 1) < 1e-9,
    `A: candles of the ${onCurve.length} trades on the curve, made with the virtual quote and the graduation slot, stand above the same candles made from the real reserve alone; the graduating trade priced that way (${priceAtCross.toExponential(4)} SOL per coin) is the pool's price after graduation`);
}

// ---- B. a modules coin on the curve, left open: the burn measures the effective quote ------------------------
section("B. A launch rules coin on the curve (creator 1% and burn 2% on buys, burn 2% on sells), a first buy of 1 SOL; it stays open");
const RULES_B = { buy: { creatorBps: 100, burnBps: 200 }, sell: { burnBps: 200 } };
const B = await launchCurveCoin("B", "Curve Rules", "CRULES", W.devB, { template: "rules", rules: RULES_B, devBuy: sol(1) });
{
  const pool = await client.pool(B.pool);
  const info = await client.hookInfo(pool);
  check(info.template === "rules" && pool.hookKind === HOOK_KIND.PLATFORM && (await client.hookRef(pool, W.t1.publicKey)).extra.length === 1, "B: the pool runs the rules template with its config as the one extra account");
  const st = await client.rulesState(B.pool);
  check(st.config.started && st.config.startSlot === B.launch.slot && st.liquidityOpenSlot === 0n, "B: the rules started with the pool; no sniper window, so the rules themselves do not hold liquidity (the curve does)");
  await sdkRefuses(() => client.addLiquidityInstructions(W.t1.publicKey, pool, 1_000n, sol(1), sol(1)), CURVE_ERRORS[6045], "B: adding liquidity on the open rules pool");
  await trade(B, W.t1, DIRECTION.BUY, sol(2), "B: a wallet buys for 2 SOL", { graduates: false });

  // The burn (RULES.md): it buys against an observation it recorded itself. On a pool on
  // the curve the observation and every comparison use the EFFECTIVE quote.
  const capBps = rulesBurnCapBps(st.config, platform, pool.lpFeeBps);
  const capOf = (depth) => { const c = (depth * BigInt(capBps)) / 10_000n; return c > 1n ? c : 1n; };
  const supply0 = await supplyOf(B.mint);
  const first = await client.rulesBurnInstructions(W.stranger.publicKey, B.pool);
  check(first && first.step === "observe" && first.due && first.observation === null && first.capBps === capBps && first.pot > 0n, `B: the pot holds ${fmt(first.pot)} SOL and the burn never looked at this pool: the first call only records it (cap ${capBps} bps)`);
  const r0 = await send(first.instructions, [W.stranger], "B: a stranger calls the burn for the first time");
  const st0 = await client.rulesState(B.pool);
  const e0 = r0.events.find((e) => e.kind === "BurnExecuted");
  check(st0.pool.virtualQuote === V && st0.config.obsSlot === r0.slot && st0.config.obsReserveBase === st0.pool.reserveBase && st0.config.obsReserveQuote === st0.pool.reserveQuote + st0.pool.virtualQuote && st0.config.obsReserveQuote !== st0.pool.reserveQuote,
    `B: the observation stores EFFECTIVE values: base ${coins6(st0.config.obsReserveBase)}, quote ${fmt(st0.config.obsReserveQuote)} SOL = ${fmt(st0.pool.reserveQuote)} real + ${fmt(V)} virtual`);
  check(e0 && e0.outcome === BURN_OUTCOME.OBSERVED && e0.obsReserveQuote === st0.config.obsReserveQuote && e0.obsReserveBase === st0.config.obsReserveBase && (await supplyOf(B.mint)) === supply0, "B: the BurnExecuted event carries the same effective observation and nothing was bought");

  // a buy that moves the real reserve by about 4% (the price by about 8% in real terms)
  // moves the effective price by under 1%: had the observation stored real values the burn
  // would wait; with effective values it buys, which is what the program does
  const pump = await trade(B, W.t2, DIRECTION.BUY, sol(0.12), "B: another wallet buys for 0.12 SOL", { graduates: false });
  const obs = { slot: st0.config.obsSlot, reserveBase: st0.config.obsReserveBase, reserveQuote: st0.config.obsReserveQuote };
  const obsReal = { slot: st0.config.obsSlot, reserveBase: st0.pool.reserveBase, reserveQuote: st0.pool.reserveQuote };
  const dueSlot = st0.config.obsSlot + BURN_INTERVAL_SLOTS;
  const onReal = burnStep(obsReal, pump.after.reserveBase, pump.after.reserveQuote, dueSlot, capBps, first.pot);
  const onEffective = burnStep(obs, pump.after.reserveBase, pump.after.reserveQuote + pump.after.virtualQuote, dueSlot, capBps, first.pot);
  check(pump.after.reserveQuote * 100n > st0.pool.reserveQuote * 103n && onReal.step === "wait" && onEffective.step === "buy",
    `B: the real reserve went from ${fmt(st0.pool.reserveQuote)} to ${fmt(pump.after.reserveQuote)} SOL; measured on real values burnStep would say "${onReal.step}", measured on the effective quote it says "${onEffective.step}" (tolerance ${2 * capBps} bps)`);
  await waitForSlot(conn, dueSlot);
  const run = await client.rulesBurnInstructions(W.stranger.publicKey, B.pool);
  const p1 = await client.pool(B.pool);
  const depth = least(p1.reserveQuote + p1.virtualQuote, obs.reserveQuote);
  check(run.step === "buy" && run.due && run.spend === least(run.pot, capOf(depth)) && run.expectedOut > 0n,
    `B: the SDK says the call buys for ${fmt(run.spend)} SOL: the pot, at most ${capBps} bps of the smaller effective depth (${fmt(depth)} SOL), as the program measures it`);
  const rb = await send(run.instructions, [W.stranger], "B: the stranger calls the burn again, 25 slots later: it buys");
  const burned = supply0 - (await supplyOf(B.mint));
  const be = rb.events.find((e) => e.kind === "BurnExecuted");
  const st1 = await client.rulesState(B.pool);
  check(be && be.outcome === BURN_OUTCOME.BOUGHT && be.quoteSpent === run.spend && be.baseBurned === burned && burned === run.expectedOut,
    `B: the chain bought and burned ${coins6(burned)} coins for ${fmt(be.quoteSpent)} SOL, exactly the SDK's prediction`);
  check(st1.config.burns === 1n && st1.config.obsSlot === rb.slot && st1.config.obsReserveBase === st1.pool.reserveBase && st1.config.obsReserveQuote === st1.pool.reserveQuote + st1.pool.virtualQuote,
    "B: the new observation is the pool as the buy left it, effective again");

  // the lowering: a trade that starts below the observed price moves the observed price
  // down to the one it starts at, measured on the effective quote
  const held = await client.tokenBalance(W.t1.publicKey, B.mint);
  const sell = await trade(B, W.t1, DIRECTION.SELL, held / 2n, "B: the first wallet sells half its coins", { graduates: false });
  const stSell = await client.rulesState(B.pool);
  check(stSell.config.obsReserveQuote === st1.config.obsReserveQuote && stSell.config.obsReserveBase === st1.config.obsReserveBase, "B: the sell started at the observed price, so it left the observation alone");
  await trade(B, W.t2, DIRECTION.BUY, sol(0.01), "B: a small buy, the first trade to start below the observed price", { graduates: false });
  const lowered = await client.rulesState(B.pool);
  const expectLow = burnLowered({ slot: st1.config.obsSlot, reserveBase: st1.config.obsReserveBase, reserveQuote: st1.config.obsReserveQuote }, sell.after.reserveBase, sell.after.reserveQuote + sell.after.virtualQuote);
  const wrongLow = burnLowered({ slot: st1.config.obsSlot, reserveBase: st1.config.obsReserveBase, reserveQuote: st1.config.obsReserveQuote }, sell.after.reserveBase, sell.after.reserveQuote);
  check(expectLow !== null && lowered.config.obsReserveBase === expectLow.reserveBase && lowered.config.obsReserveQuote === expectLow.reserveQuote && lowered.config.obsSlot === rb.slot
    && (wrongLow === null || wrongLow.reserveQuote !== lowered.config.obsReserveQuote),
    "B: the hook lowered the observation to the price that buy started at: the SDK's burnLowered with EFFECTIVE values gives the same two numbers (with real values it would not), and the slot was kept");
  const pB = await client.pool(B.pool);
  const progB = await client.curveProgress(pB);
  check(pB.curveState === CURVE_OPEN && progB.state === "open" && progB.raised < TARGET && graduationBurn(pB).forecast, `B: the coin stays on the curve: raised ${fmt(progB.raised)} of ${fmt(TARGET)} SOL`);
}

// ---- C. a strict coin on the curve, with a graduation fee ---------------------------------------------------
const FEE_C = isAdmin ? 500 : platform.curveGraduationFeeBps;
section(`C. A strict coin on the curve (max wallet 30%, creator 1% each side), a first buy of 0.5 SOL${isAdmin ? ", with a graduation fee of 5% set by the admin for this launch" : ""}`);
let C;
const feeBefore = platform.curveGraduationFeeBps;
try {
  if (isAdmin) {
    const up = await client.platformUpdate(admin.publicKey, { curveGraduationFeeBps: FEE_C });
    check(up.instructions.length === 1 && up.changes.length === 1, `C: platformUpdate builds one update_platform for the one field that differs (${up.changes[0]})`);
    await send(up.instructions, [admin], "C: the admin sets the graduation fee");
    platform = await client.platform();
    check(platform.curveGraduationFeeBps === FEE_C && platform.curveVirtualQuote === V && platform.curveGraduationTarget === TARGET && (await client.platformUpdate(admin.publicKey, { curveGraduationFeeBps: FEE_C })).instructions.length === 0,
      `C: the platform reads a fee of ${FEE_C} bps, the other two settings unchanged; the same wish builds nothing more`);
    const A2 = await client.pool(A.pool), B2 = await client.pool(B.pool);
    check(A2.graduationFeeBps === feeBefore && B2.graduationFeeBps === feeBefore, "C: the pools made before keep their own settings");
  }
  C = await launchCurveCoin("C", "Curve Strict", "CSTRICT", W.devC, { template: "rules", rules: { buy: { creatorBps: 100 }, sell: { creatorBps: 100 }, strict: { maxWalletBps: 3000, maxWalletSlots: 60 } }, devBuy: sol(0.5), table: true, feeBps: FEE_C });
} finally {
  if (isAdmin && platform.curveGraduationFeeBps !== feeBefore) {
    const back = await client.platformUpdate(admin.publicKey, { curveGraduationFeeBps: feeBefore });
    await send(back.instructions, [admin], "C: the admin sets the graduation fee back");
    platform = await client.platform();
    check(platform.curveGraduationFeeBps === feeBefore, `C: the platform's fee is back at ${feeBefore} bps; coin C keeps its ${FEE_C} bps`);
  }
}
{
  const pool = await client.pool(C.pool);
  check(await client.isStrictPool(pool) && pool.baseTokenProgram.equals(TOKEN_2022_PROGRAM) && C.plan.strict.maxWalletAmount === (SUPPLY * 3000n) / 10_000n && C.plan.needsLookupTable,
    "C: a strict coin (Token-2022 with hook_rules as its transfer hook) on the curve, max wallet 30% of the supply, launched with the lookup table");
  const st = await client.rulesState(C.pool);
  check(st.strict && st.strict.maxWalletAmount === C.plan.strict.maxWalletAmount && st.strict.maxWalletRuns, "C: rulesState shows the strict part: the max wallet runs");
  const amounts = [[W.t1, 10], [W.t2, 15], [W.t3, 25]];
  for (const [wallet, n] of amounts) {
    const t = await trade(C, wallet, DIRECTION.BUY, sol(n), `C: a wallet buys for ${n} SOL (with the lookup table)`, { table: true, graduates: false });
    const holder = await client.rulesHolderOf(C.pool, wallet.publicKey);
    check(holder.record && holder.counted === t.received && holder.balance === t.received && t.received <= C.plan.strict.maxWalletAmount, `C: the buyer's holder record counts its ${coins6(t.received)} coins, under the max wallet`);
  }
  // the crossing buy: enough to take the real reserve to the target, by the fourth wallet
  const p = await client.pool(C.pool);
  const need = TARGET - p.reserveQuote;
  const amount = (need * 10_000n) / BigInt(10_000 - platform.protocolFeeBps - 100) + sol(0.2);
  const info = await client.hookInfo(p);
  const q = await client.quoteLocal(p, platform, DIRECTION.BUY, amount, info, undefined, W.t4.publicKey);
  check(q.graduates === true && q.amountOut <= C.plan.strict.maxWalletAmount, `C: a buy of ${fmt(amount)} SOL by a fourth wallet crosses the target and stays under the max wallet (quoted with the wallet: no strict refusal)`);
  const supplyBefore = await supplyOf(C.mint);
  const treasuryBefore = p.protocolFeesQuote;
  const x = await trade(C, W.t4, DIRECTION.BUY, amount, "C: the buy that crosses the target (with the lookup table)", { table: true, graduates: true });
  measure("C swap that crosses the target, with open_holder in front and graduate appended (strict coin)", x);
  const atSwap = { ...x.before, reserveBase: x.ev.reserveBase, reserveQuote: x.ev.reserveQuote };
  const g = graduation(x.ev.reserveBase, x.ev.reserveQuote, V, TARGET, FEE_C);
  check(g.fee === (TARGET * BigInt(FEE_C)) / 10_000n && x.grad.feeQuote === g.fee && x.grad.burnedBase === g.burned && x.after.reserveQuote === g.reserveQuoteAfter && x.after.reserveBase === g.reserveBaseAfter,
    `C: graduation took a fee of ${fmt(x.grad.feeQuote)} SOL (${FEE_C} bps of the target) out of the reserve and burned ${coins6(x.grad.burnedBase)} coins, as the SDK's graduation() says`);
  check(priceKept(price(atSwap), price(x.after)), "C: the price is kept through a graduation with a fee: the pool is shallower by the fee, the holders' price is the same");
  check(x.after.curveState === CURVE_GRADUATED && x.after.protocolFeesQuote === treasuryBefore + x.ev.protocolFee + g.fee && supplyBefore - (await supplyOf(C.mint)) === g.burned,
    `C: the protocol fee counter holds the buy's fee plus the graduation fee, ${fmt(x.after.protocolFeesQuote)} SOL; the supply fell by the burn`);
  const holder4 = await client.rulesHolderOf(C.pool, W.t4.publicKey);
  check(holder4.record && holder4.counted === x.received, "C: the fourth wallet's holder record counts the coins of the graduating buy");
  // the platform collects: the graduation fee reaches the treasury with the other protocol fees
  const treasuryAta = pda.ata(platform.treasury, NATIVE_MINT);
  const had = await tokenAmount(treasuryAta);
  const collect = await client.collectProtocolFeesInstructions(W.stranger.publicKey, x.after);
  await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...collect], [W.stranger], "C: a stranger collects the protocol fees", { table: true });
  const p2 = await client.pool(C.pool);
  check((await tokenAmount(treasuryAta)) - had === x.after.protocolFeesQuote && p2.protocolFeesQuote === 0n, `C: the treasury received ${fmt(x.after.protocolFeesQuote)} SOL, graduation fee included; the counter is zero`);
  await trade(C, W.t1, DIRECTION.SELL, (await client.tokenBalance(W.t1.publicKey, C.mint, TOKEN_2022_PROGRAM)) / 2n, "C: the first buyer sells half after graduation (with the lookup table)", { table: true, graduates: false });
  const progC = await client.curveProgress(p2);
  check(progC.state === "graduated" && progC.raisedBps === 10_000, "C: curveProgress reads graduated");
}

// ---- D. a pool made directly, and E a seeded coin ---------------------------------------------------------------
section("D. A curve pool made directly with create_curve_pool, and a partial supply refused");
{
  const mint = Keypair.generate();
  await send([ix.createToken(W.devD.publicKey, mint.publicKey, { name: "Curve Direct", symbol: "CDIRECT", uri: "https://example.com/meta/cdirect.json", decimals: 6, totalSupply: SUPPLY })], [W.devD, mint], "D: a closed coin, the whole supply in the creator's wallet");
  const m = await client.mint(mint.publicKey);
  check(m.supply === SUPPLY && m.mintAuthority === null && m.freezeAuthority === null, "D: the mint is closed: no mint authority, no freeze authority");
  const ixs = await client.createCurvePoolInstructions(W.devD.publicKey, mint.publicKey, NATIVE_MINT, LP_FEE_BPS, SUPPLY);
  check(ixs.some((i) => isIx(i, PROGRAMS.hookpool, "create_curve_pool")) && !ixs.some((i) => i.programId.equals(SystemProgram.programId)), "D: createCurvePoolInstructions carries create_curve_pool and wraps no SOL");
  const r = await send(ixs, [W.devD], "D: create_curve_pool");
  measure("D create_curve_pool directly (no hook)", r);
  const pool = await client.poolByMints(mint.publicKey, NATIVE_MINT);
  const lp = curveInitialLp(SUPPLY, V);
  check(pool.curveState === CURVE_OPEN && pool.reserveQuote === 0n && pool.reserveBase === SUPPLY && pool.virtualQuote === V && pool.graduationTarget === TARGET && pool.creator.equals(W.devD.publicKey) && !pool.hasHook,
    "D: the pool is on the curve, holds the whole supply and no real SOL");
  check((await client.mint(pool.lpMint)).supply === lp && (await tokenAmount(pool.lpLock)) === lp && (await client.tokenBalance(W.devD.publicKey, pool.lpMint)) === 0n, "D: every LP unit is in the lock account, the creator holds none");
  check(r.events.some((e) => e.kind === "PoolCreated" && e.lpMinted === 0n) && r.events.some((e) => e.kind === "CurveOpened" && e.pool.equals(pool.address)), "D: PoolCreated and CurveOpened were emitted");
  check((await client.launchForMint(mint.publicKey)) === null, "D: no launch record: the pool was not made by the launchpad");
  await graduateChangesNothing(pool, mint.publicKey, "D: graduate by hand on the fresh pool", { rev3: true });
  // half the supply is refused
  const mint2 = Keypair.generate();
  await send([ix.createToken(W.devD.publicKey, mint2.publicKey, { name: "Curve Half", symbol: "CHALF", uri: "https://example.com/meta/chalf.json", decimals: 6, totalSupply: SUPPLY })], [W.devD, mint2], "D: a second closed coin");
  await refused(await client.createCurvePoolInstructions(W.devD.publicKey, mint2.publicKey, NATIVE_MINT, LP_FEE_BPS, SUPPLY / 2n), [W.devD], "D: create_curve_pool with half the supply", "CurveSupplyNotInPool");
  coins.push({ letter: "D", name: "Curve Direct", symbol: "CDIRECT", mint: mint.publicKey, pool: pool.address, dev: W.devD });
}
section("E. A seeded launch is what it was, and cannot graduate");
{
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({ dev: W.devE.publicKey, mint, name: "Seeded Coin", symbol: "SEEDED", uri: "https://example.com/meta/seeded.json", decimals: 6, totalSupply: SUPPLY, quoteMint: NATIVE_MINT, lpFeeBps: LP_FEE_BPS, quoteAmount: sol(0.5), devBuyQuote: 0n, minDevBuyOut: 0n, template: "none" });
  check(plan.curve === undefined && plan.launchTx.some((i) => isIx(i, PROGRAMS.hooklaunch, "launch")), "E: a launch without curve: true is a seeded launch with the launch instruction");
  await send(plan.createTx, [W.devE, ...plan.signers], "E: transaction 1");
  await send(plan.launchTx, [W.devE], "E: transaction 2, 0.5 SOL seeded");
  const pool = await client.pool(plan.pool);
  const launch = await client.launchForMint(mint.publicKey);
  check(pool.curveState === CURVE_NONE && !isOnCurve(pool) && pool.virtualQuote === 0n && pool.graduationTarget === 0n && pool.reserveQuote === sol(0.5) && launch.curve === false && effectiveQuote(pool) === pool.reserveQuote,
    "E: a seeded pool: curve state none, no virtual quote, the launch record is not marked, the effective quote is the real one");
  const prog = await client.curveProgress(pool);
  check(prog.state === "none" && prog.raised === 0n && prog.raisedBps === 0 && prog.startMarketCapQuote === null && graduationBurn(pool).burned === 0n, "E: curveProgress reads none and there is nothing to burn");
  await sdkRefuses(() => client.graduateInstructions(pool), CURVE_ERRORS[6047], "E: graduateInstructions on a seeded pool");
  await refused(client.graduateInstructions(pool, { check: false }), [W.stranger], "E: graduate by hand on a seeded pool", "NotOnCurve");
  let said = null;
  try { await client.launchInstructions({ dev: W.devE.publicKey, mint: Keypair.generate(), name: "x", symbol: "X", uri: "https://example.com/x.json", decimals: 6, totalSupply: SUPPLY, quoteMint: NATIVE_MINT, lpFeeBps: LP_FEE_BPS, devBuyQuote: 0n, minDevBuyOut: 0n, template: "none" }); } catch (e) { said = e.message; }
  check(said !== null && said.includes("curve: true"), "E: a seeded launch without quoteAmount is refused by the SDK, which points at curve: true");
  coins.push({ letter: "E", name: "Seeded Coin", symbol: "SEEDED", mint: mint.publicKey, pool: plan.pool, dev: W.devE });
}

// ---- F. a pegged collectible coin cannot launch on the curve ------------------------------------------------
section("F. A pegged collectible coin is refused on the curve by the SDK, and by the chain when sent raw");
{
  const ART = Uint8Array.from([1, 28, 30, 150, 24, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const collectible = { name: "Pegged Shots", uriBase: "https://example.com/art", unit: 50_000_000n * UNIT, maxSupply: 1000, maxPerBuy: 3, art: ART, pegged: true };
  const base = { dev: W.devF.publicKey, name: "Curve Pegged", symbol: "CPEG", uri: "https://example.com/meta/cpeg.json", decimals: 6, totalSupply: SUPPLY, quoteMint: NATIVE_MINT, lpFeeBps: LP_FEE_BPS, devBuyQuote: 0n, minDevBuyOut: 0n, template: "collectible", collectible };
  await sdkRefuses(() => client.launchInstructions({ ...base, mint: Keypair.generate(), curve: true }), CURVE_PEGGED_ERROR, "F: launchInstructions with curve: true for a pegged coin");
  // the plain collectible kind is allowed on the curve: the plan builds
  const plainPlan = await client.launchInstructions({ ...base, mint: Keypair.generate(), curve: true, collectible: { ...collectible, pegged: false } });
  check(plainPlan.curve && plainPlan.launchTx.some((i) => isIx(i, PROGRAMS.hooklaunch, "launch_curve")), "F: the plain collectible kind builds a curve launch (only the pegged kind is refused)");
  // the chain: the pegged coin is made with the seeded plan, then launch_curve is sent by hand
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({ ...base, mint, quoteAmount: sol(0.5) });
  await send(plan.createTx, [W.devF, ...plan.signers], "F: the pegged coin and its collection (seeded plan, transaction 1)", { table: true });
  const launchIx = plan.launchTx.find((i) => isIx(i, PROGRAMS.hooklaunch, "launch"));
  const raw = new TransactionInstruction({ programId: PROGRAMS.hooklaunch, keys: launchIx.keys, data: Buffer.concat([Buffer.from(IX.hooklaunch.launch_curve), u16(LP_FEE_BPS), u64(0), u64(0)]) });
  await refused([ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), ix.createAtaIdempotent(W.devF.publicKey, W.devF.publicKey, NATIVE_MINT), raw], [W.devF], "F: launch_curve by hand with the pegged coin's accounts", "CurvePegged", { table: true });
}

// ---- G. the floor of a crossing buy, a front-run, and a pool standing past its target -------------------------
section("G. The floor of a crossing buy is the user's slippage on its curve quote; a front-run makes it revert; the next buy graduates the pool first");
const G = await launchCurveCoin("G", "Curve Floor", "CFLOOR", W.devG);
await trade(G, W.g1, DIRECTION.BUY, sol(60), "G: a wallet buys for 60 SOL", { graduates: false });
{
  const pool = await client.pool(G.pool);
  const amount = sol(40);
  const q = await client.quoteLocal(pool, platform, DIRECTION.BUY, amount, null);
  const floor = (q.amountOut * 9_900n) / 10_000n;
  const prepared = await client.swapInstructions(W.g2.publicKey, pool, await client.hookRef(pool, W.g2.publicKey), DIRECTION.BUY, amount, floor);
  const sAt = prepared.findIndex((i) => isIx(i, PROGRAMS.hookpool, "swap")), gAt = prepared.findIndex((i) => isIx(i, PROGRAMS.hookpool, "graduate"));
  const curve = quoteSwap({ direction: DIRECTION.BUY, amountIn: amount, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: V, lpFeeBps: LP_FEE_BPS, protocolFeeBps: platform.protocolFeeBps });
  check(q.graduates === true && q.graduateFirst === false && q.amountOut === curve.amountOut && gAt === sAt + 1 && swapMinOut(prepared) === floor && swapMinOut(prepared) >= (q.amountOut * 9_900n) / 10_000n,
    `G: a buy of 40 SOL from ${fmt(pool.reserveQuote)} SOL raised crosses the target: quoted on the curve (${coins6(q.amountOut)} coins), graduate after the swap, and the floor it carries is the user's 1% slippage on that quote, ${coins6(floor)} coins: never below amountOut x (1 - slippage)`);
  // another wallet buys first and leaves the pool standing past its target
  await send(await client.swapInstructions(W.g3.publicKey, pool, await client.hookRef(pool, W.g3.publicKey), DIRECTION.BUY, sol(30), 0n, { graduate: false }), [W.g3], "G: another wallet buys for 30 SOL first, built with graduate: false");
  const moved = await client.pool(G.pool);
  const fillNow = quoteSwap({ direction: DIRECTION.BUY, amountIn: amount, reserveBase: moved.reserveBase, reserveQuote: moved.reserveQuote, virtualQuote: V, lpFeeBps: LP_FEE_BPS, protocolFeeBps: platform.protocolFeeBps }).amountOut;
  check(moved.curveState === CURVE_OPEN && readyToGraduate(moved) && fillNow < floor,
    `G: the pool stands past its target, still open, at ${fmt(moved.reserveQuote)} SOL; the prepared buy would now fill ${coins6(fillNow)} coins, under its floor`);
  await refused(prepared, [W.g2], "G: the buy prepared before that is sent", "Slippage");
  check((await client.tokenBalance(W.g2.publicKey, G.mint)) === 0n, "G: the user's floor held: the buy reverted instead of filling low, the wallet holds no coin");
  // the pool stands past its target: the next trade sends graduate first and fills exactly as quoted
  const g4 = await trade(G, W.g4, DIRECTION.BUY, sol(1), "G: a buy of 1 SOL on the pool standing past its target", { graduates: true });
  measure("G swap on a pool standing past its target, with graduate in front (no hook)", g4);
  const before = [g4.grad.reserveQuoteBefore + V, g4.grad.reserveBaseBefore], afterGrad = [g4.grad.reserveQuoteAfter, g4.grad.reserveBaseAfter];
  check(g4.first && g4.local.graduateFirst === true && priceKept(before, afterGrad) && g4.local.amountOut === quoteSwap({ direction: DIRECTION.BUY, amountIn: sol(1), reserveBase: afterGrad[1], reserveQuote: afterGrad[0], lpFeeBps: LP_FEE_BPS, protocolFeeBps: platform.protocolFeeBps }).amountOut,
    "G: graduation kept the price, and the buy was quoted, and filled, on the reserves graduation left: exact whoever graduates first");
}

// ---- H. a sell on a pool standing past its target ----------------------------------------------------------
section("H. A sell on a pool standing past its target sends graduate first and is a sell on the graduated pool");
const H = await launchCurveCoin("H", "Curve Sell", "CSELL", W.devH);
{
  let pool = await client.pool(H.pool);
  await send(await client.swapInstructions(W.h1.publicKey, pool, await client.hookRef(pool, W.h1.publicKey), DIRECTION.BUY, sol(90), 0n, { graduate: false }), [W.h1], "H: a wallet buys for 90 SOL, built with graduate: false");
  pool = await client.pool(H.pool);
  check(pool.curveState === CURVE_OPEN && readyToGraduate(pool), `H: the pool stands past its target, still open, at ${fmt(pool.reserveQuote)} SOL`);
  const amount = ((await client.tokenBalance(W.h1.publicKey, H.mint)) * 2n) / 5n;
  const onCurve = quoteSwap({ direction: DIRECTION.SELL, amountIn: amount, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: V, lpFeeBps: LP_FEE_BPS, protocolFeeBps: platform.protocolFeeBps });
  check(onCurve.reserveOutAfter < TARGET, `H: on the curve a sell of 40% of the wallet's coins would take the real reserve back under the target, to ${fmt(onCurve.reserveOutAfter)} SOL`);
  const s = await trade(H, W.h1, DIRECTION.SELL, amount, "H: the wallet sells 40% of its coins", { graduates: true });
  measure("H sell on a pool standing past its target, with graduate in front (no hook)", s);
  check(s.first && s.after.curveState === CURVE_GRADUATED && s.after.reserveQuote < TARGET && s.local.amountOut < onCurve.amountOut,
    `H: graduated first, then the sell ran on the graduated pool: ${fmt(s.received)} SOL paid (on the curve it would have been ${fmt(onCurve.amountOut)}), the pool holds ${fmt(s.after.reserveQuote)} SOL and stays graduated`);
}

// ---- I. a crossing buy, a sell back under the target, then graduate, in one transaction ---------------------
section("I. A crossing buy and a sell that takes the pool back under the target, then graduate, in one transaction: it lands and the pool stays open");
const I = await launchCurveCoin("I", "Curve Back", "CBACK", W.devI);
await trade(I, W.i1, DIRECTION.BUY, sol(80), "I: a wallet buys for 80 SOL", { graduates: false });
{
  const pool = await client.pool(I.pool);
  const k = client.keys(pool);
  const user = W.i1.publicKey;
  const buyIn = sol(10);
  const qb = quoteSwap({ direction: DIRECTION.BUY, amountIn: buyIn, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: V, lpFeeBps: LP_FEE_BPS, protocolFeeBps: platform.protocolFeeBps });
  const qs = quoteSwap({ direction: DIRECTION.SELL, amountIn: qb.amountOut, reserveBase: qb.reserveOutAfter, reserveQuote: qb.reserveInAfter, virtualQuote: V, lpFeeBps: LP_FEE_BPS, protocolFeeBps: platform.protocolFeeBps });
  check(pool.reserveQuote < TARGET && qb.reserveInAfter >= TARGET && qs.reserveOutAfter < TARGET,
    `I: from ${fmt(pool.reserveQuote)} SOL a buy of 10 SOL takes the real reserve to ${fmt(qb.reserveInAfter)} SOL, past the target; selling those coins back takes it to ${fmt(qs.reserveOutAfter)} SOL, under it`);
  const wsol = pda.ata(user, NATIVE_MINT);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix.createAtaIdempotent(user, user, NATIVE_MINT), ix.transferLamports(user, wsol, buyIn), ix.syncNative(wsol),
    ix.swap(user, k, NO_HOOK, DIRECTION.BUY, buyIn, qb.amountOut), ix.swap(user, k, NO_HOOK, DIRECTION.SELL, qb.amountOut, qs.amountOut), ix.closeAccount(wsol, user, user), ix.graduate(k),
  ];
  let landed = null, events = [];
  try {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = user;
    const sig = await sendAndConfirmTransaction(conn, tx, [W.i1], { commitment: "confirmed" });
    events = eventsFromTransaction(await fetchTx(sig), OURS);
    landed = true;
  } catch (e) {
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null);
    const named = curveErrorFromLogs(logs ?? [String(e.message)]);
    landed = named ? `refused with ${named.name} (${named.number})` : `refused: ${e.message}`;
  }
  const after = await client.pool(I.pool);
  softCheck(landed === true && events.filter((e) => e.kind === "Swapped").length === 2 && !events.some((e) => e.kind === "Graduated")
    && after.curveState === CURVE_OPEN && after.virtualQuote === V && after.reserveQuote === qs.reserveOutAfter && after.reserveBase === qs.reserveInAfter,
    `I: the transaction [buy, sell, graduate] lands: both trades ran on the curve, graduate found the pool under its target and did nothing, the pool stays open at ${fmt(after.reserveQuote)} SOL`,
    landed === true ? "I: it landed but the pool is not what the two quotes say" : `I: the chain's hookpool ${landed}; revision 3 (graduate does nothing on an open pool below its target) is not on this chain yet`);
}

console.log("\ncompute units and sizes (sent transactions):");
for (const m of measures) console.log(`  ${m.what}: ${m.cu} compute units; ${m.size} bytes ${m.table ? "with" : "without"} the lookup table`);
console.log("\ncoins left on the chain:");
for (const c of coins) {
  const p = await client.pool(c.pool);
  const state = p.curveState === CURVE_OPEN ? "on the curve" : p.curveState === CURVE_GRADUATED ? "graduated" : "seeded";
  console.log(`  ${c.letter}  ${c.name} (${c.symbol})  coin ${c.mint.toBase58()}  pool ${c.pool.toBase58()}  ${state}, ${fmt(p.reserveQuote)} real SOL`);
}
if (waiting.length) {
  console.log(`\n${waiting.length} check(s) wait for a program change and did NOT pass:`);
  for (const w of waiting) console.log("  " + w);
}
console.log(`\n${checks} checks passed`);
process.exit(waiting.length ? 1 : 0);
