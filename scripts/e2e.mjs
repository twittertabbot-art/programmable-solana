// End-to-end rehearsal through the SDK against a live cluster (localnet or devnet):
// create a coin, launch it with the tax hook against wrapped SOL, buy, sell, check the
// treasury, read the swaps back from the logs. Prints what it checked.
//   node scripts/e2e.mjs <localnet|devnet> [tax|launch_guard|buyback|none]
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { HookpoolClient, NATIVE_MINT, DIRECTION, pda, PROGRAMS, BURN_INTERVAL_SLOTS, BURN_OUTCOME, candlesFromSwaps, eventsFromTransaction, hookKindLabel, decodeTokenAmount, ix, liquidityOpenSlot, mulDivCeil } from "../sdk/dist/index.js";
import { clusterArg, connection, deployer, fmt, sendRefused, waitForSlot } from "./cluster.mjs";

const cluster = clusterArg();
const template = process.argv[3] ?? "tax";
const conn = connection(cluster);
const dev = deployer(cluster);
const client = new HookpoolClient(conn);
const platform = await client.platform();
if (!platform) throw new Error("run init-platform first");

const check = (cond, msg) => { if (!cond) { console.error("CHECK FAILED: " + msg); process.exit(1); } console.log("  check  " + msg); };
async function sendIxs(ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    console.log(`  ok  ${label}  ${sig}`);
    return sig;
  } catch (e) { console.error(`  FAILED ${label}`); if (e.logs) console.error(e.logs.join("\n")); throw e; }
}

const mint = Keypair.generate();
const supply = 1_000_000_000n * 1_000_000n;
console.log(`dev ${dev.publicKey.toBase58()}  mint ${mint.publicKey.toBase58()}  template ${template}`);

const plan = await client.launchInstructions({
  dev: dev.publicKey, mint, name: "Hook Test Coin", symbol: "HTC", uri: "https://example.com/meta/htc.json", decimals: 6, totalSupply: supply,
  quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: BigInt(2 * LAMPORTS_PER_SOL), devBuyQuote: BigInt(0.2 * LAMPORTS_PER_SOL), minDevBuyOut: 1n,
  template,
  tax: { buyBps: 300, sellBps: 500, maxBps: 1000 },
  guard: { guardSlots: 150n, startFeeBps: 3000 },
  buyback: { buyBps: 200, sellBps: 200, minQuote: BigInt(0.03 * LAMPORTS_PER_SOL) },
});
await sendIxs(plan.createTx, [dev, mint], "create_token");
const md = await client.metadata(mint.publicKey);
check(md && md.name === "Hook Test Coin" && md.symbol === "HTC", "metaplex metadata written");
const mintInfo = await client.mint(mint.publicKey);
check(mintInfo.supply === supply && mintInfo.mintAuthority === null, "fixed supply, mint authority revoked");

const treasuryBefore = await conn.getBalance(platform.treasury);
await sendIxs(plan.launchTx, [dev], "launch");
const pool = await client.pool(plan.pool);
check(pool !== null, `pool exists ${plan.pool.toBase58()} (${hookKindLabel(pool.hookKind)})`);
check(template === "none" ? !pool.hasHook : pool.hookProgram.equals(PROGRAMS[template === "tax" ? "hook_tax" : template === "launch_guard" ? "hook_launch_guard" : "hook_buyback"]), "pool wired to the chosen hook");
{
  const lpSupply = (await client.mint(pool.lpMint)).supply;
  const locked = decodeTokenAmount(new Uint8Array((await conn.getAccountInfo(pool.lpLock)).data));
  check(lpSupply > 1_000_000n && locked === lpSupply && (await client.tokenBalance(dev.publicKey, pool.lpMint)) === 0n, `all the launch LP is locked: supply ${lpSupply}, all of it in the pool's lock account, the dev holds none`);
}
if (!platform.treasury.equals(dev.publicKey)) check(await conn.getBalance(platform.treasury) - treasuryBefore === Number(platform.launchFeeLamports), "launch fee paid");
check(pool.swapCount === 1n, "dev buy executed through the hook path");
const launch = await client.launchForMint(mint.publicKey);
check(launch && launch.dev.equals(dev.publicKey) && launch.lpLocked > 0n, "launch record stored");

const hook = await client.hookInfo(pool);
if (hook) console.log("  hook:", hook.template, hook.summary.sentences.join(" "));

// a second wallet trades
const trader = Keypair.generate();
const sig = await conn.requestAirdrop(trader.publicKey, 2 * LAMPORTS_PER_SOL);
await conn.confirmTransaction(sig, "confirmed");
const hookRef = await client.hookRef(pool, trader.publicKey);
const buyIn = BigInt(0.5 * LAMPORTS_PER_SOL);
const local = await client.quoteLocal(pool, platform, DIRECTION.BUY, buyIn, hook);
const onchain = await client.quoteOnChain(trader.publicKey, pool, DIRECTION.BUY, buyIn);
check(local.amountOut === onchain, `local quote equals on-chain quote (${fmt(onchain, 6)} HTC for 0.5 SOL, impact ${local.impactBps} bps)`);
await sendIxs(await client.swapInstructions(trader.publicKey, pool, hookRef, DIRECTION.BUY, buyIn, onchain), [trader], "buy 0.5 SOL");
const got = await client.tokenBalance(trader.publicKey, mint.publicKey);
if (template === "launch_guard") check(got >= onchain, "trader received at least the quote (guard fee decays every slot)");
else check(got === onchain, "trader received exactly the quoted amount");
const treasuryTok = pool.hookQuoteTreasury.equals(new PublicKey("11111111111111111111111111111111")) ? 0n : (await conn.getTokenAccountBalance(pool.hookQuoteTreasury)).value.amount;
if (template === "tax" || template === "buyback") check(BigInt(treasuryTok) > 0n, `hook treasury holds ${fmt(treasuryTok, 9)} wSOL of fees`);

const pool2 = await client.pool(plan.pool);
const sellIn = got / 2n;
const sellQuote = await client.quoteOnChain(trader.publicKey, pool2, DIRECTION.SELL, sellIn);
const solBefore = await conn.getBalance(trader.publicKey);
await sendIxs(await client.swapInstructions(trader.publicKey, pool2, hookRef, DIRECTION.SELL, sellIn, sellQuote), [trader], "sell half");
const solAfter = await conn.getBalance(trader.publicKey);
check(solAfter > solBefore, `sell unwrapped SOL back to the wallet (+${fmt(solAfter - solBefore, 9)} SOL)`);

const swaps = await client.recentSwaps(plan.pool, 20);
check(swaps.length === 3, `read ${swaps.length} swaps back from the logs`);
const candles = candlesFromSwaps(swaps, 6, 9, 60);
check(candles.length >= 1, `built ${candles.length} candle(s)`);

if (template === "buyback") {
  const b = hook.buyback;
  const treasuryNow = async () => BigInt((await conn.getTokenAccountBalance(pool.hookQuoteTreasury)).value.amount);
  const supplyNow = async () => (await client.mint(mint.publicKey)).supply;
  const config = async () => (await client.hookInfo(await client.pool(plan.pool))).buyback;
  /// A confirmed transaction: its slot and the BuybackExecuted event inside it.
  const landed = async (sig) => {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    return { slot: BigInt(tx.slot), event: eventsFromTransaction(tx, Object.values(PROGRAMS).map((p) => p.toBase58())).find((e) => e.kind === "BuybackExecuted") };
  };
  // Below the pool's minimum there is nothing to run.
  check((await client.buybackInstructions(trader.publicKey, await client.pool(plan.pool))) === null, "below the minimum the SDK offers no buyback");
  // Trade until the treasury holds the minimum twice over: enough for more than one buy.
  await conn.confirmTransaction(await conn.requestAirdrop(trader.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
  for (let i = 0; i < 5; i++) {
    const p = await client.pool(plan.pool);
    const q = await client.quoteLocal(p, platform, DIRECTION.BUY, buyIn, hook);
    await sendIxs(await client.swapInstructions(trader.publicKey, p, hookRef, DIRECTION.BUY, buyIn, q.amountOut), [trader], "buy 0.5 SOL");
  }

  // What one buy may spend follows the pool's fees (HOOKS.md section 7), worked out here
  // from the numbers on chain, without the SDK:
  //   sure = protocol fee + hook fee of a buy + hook fee of a sell
  //   soft = protocol fee + twice the pool fee
  //   cap  = (sure + min(sure, soft)) / 4, between 1 and 50 basis points
  //   spend = min(treasury, max(1, depth * cap / 10000)), depth = the smaller of the
  //           pool's SOL now and the pool's SOL as the buyback last recorded it
  const p6 = await client.pool(plan.pool);
  const sure = platform.protocolFeeBps + Math.min(b.buyBps, platform.maxHookFeeBps) + Math.min(b.sellBps, platform.maxHookFeeBps);
  const soft = platform.protocolFeeBps + 2 * p6.lpFeeBps;
  const capBps = Math.min(50, Math.max(1, Math.floor((sure + Math.min(sure, soft)) / 4)));
  const capOf = (depth) => { const c = (depth * BigInt(capBps)) / 10_000n; return c > 1n ? c : 1n; };
  const t6 = await treasuryNow();
  const supply0 = await supplyNow();

  // 1. A buyback buys against an observation of the pool that it recorded itself at least
  //    25 slots earlier. This pool has none: the first call only records one.
  const first = await client.buybackInstructions(trader.publicKey, p6);
  check(first !== null && first.capBps === capBps && first.pot === t6, `the SDK's cap for this pool is the program's rule worked out by hand: ${capBps} basis points of the pool's SOL`);
  check(first.step === "observe" && first.due && first.observation === null && first.instructions.length > 0, "the buyback never looked at this pool: the SDK says the first call only records it");
  const l0 = await landed(await sendIxs(first.instructions, [trader], "a stranger calls the buyback for the first time"));
  const cfg0 = await config();
  check(l0.event && l0.event.outcome === BURN_OUTCOME.OBSERVED && l0.event.quoteSpent === 0n && cfg0.buybacks === 0n && cfg0.obsSlot === l0.slot && cfg0.obsReserveQuote === p6.reserveQuote && cfg0.obsReserveBase === p6.reserveBase
    && (await supplyNow()) === supply0 && (await treasuryNow()) === t6, `it bought nothing and recorded the pool's reserves in slot ${l0.slot}`);

  // 2. A call in the next 25 slots is refused and writes nothing.
  const soon = await client.buybackInstructions(trader.publicKey, await client.pool(plan.pool));
  check(soon !== null && soon.step === "tooSoon" && !soon.due && soon.dueSlot === l0.slot + BURN_INTERVAL_SLOTS && soon.instructions.length === 0,
    `the SDK says a call is refused before slot ${soon.dueSlot}, and builds nothing to send`);
  const refusal = await sendRefused(conn, [ix.executeBuyback(trader.publicKey, client.keys(p6), 0n)], [trader], "a second call in the same 25 slots, built by hand");
  check(refusal.includes("TooSoon"), "the program refuses it by name: TooSoon");

  // 3. 25 slots later, the price having stood, it buys: the cap of the observed depth.
  await waitForSlot(conn, soon.dueSlot);
  const run = await client.buybackInstructions(trader.publicKey, await client.pool(plan.pool));
  const most = capOf(p6.reserveQuote);
  check(run !== null && run.step === "buy" && t6 > most && run.spend === most && run.treasuryLeft === t6 - most, `from slot ${soon.dueSlot} on the call buys: it spends ${fmt(run.spend, 9)} SOL, the cap, of the ${fmt(t6, 9)} SOL in the treasury; ${fmt(run.treasuryLeft, 9)} SOL waits for the next buy`);
  const l1 = await landed(await sendIxs(run.instructions, [trader], "a stranger calls the buyback again, 25 slots later"));
  const burned = supply0 - (await supplyNow());
  const left = await treasuryNow();
  check(burned === run.expectedOut && left === run.treasuryLeft, `it bought and burned ${fmt(burned, 6)} HTC, exactly the SDK's quote; the treasury holds the predicted ${fmt(left, 9)} SOL`);
  const cfg1 = await config();
  const p7 = await client.pool(plan.pool);
  check(l1.event.outcome === BURN_OUTCOME.BOUGHT && l1.event.quoteSpent === run.spend && l1.event.baseBurned === burned && cfg1.buybacks === 1n && cfg1.totalQuoteSpent === run.spend && cfg1.obsSlot === l1.slot && cfg1.obsReserveQuote === p7.reserveQuote,
    "the config counts one buyback and holds the pool as the buy left it as its new observation");

  // 4. The treasury still holds more than the minimum, and a second buy right away is
  //    refused all the same: two buys are at least 25 slots apart.
  check(left >= b.minQuote, `the treasury is still above the minimum of ${fmt(b.minQuote, 9)} SOL`);
  const again = await client.buybackInstructions(trader.publicKey, p7);
  check(again !== null && again.step === "tooSoon" && again.dueSlot === l1.slot + BURN_INTERVAL_SLOTS && again.instructions.length === 0 && again.spend === (left < capOf(p7.reserveQuote) ? left : capOf(p7.reserveQuote)),
    `the SDK says the next buy is not due before slot ${again.dueSlot}, and estimates it at ${fmt(again.spend, 9)} SOL`);
  const refusal2 = await sendRefused(conn, [ix.executeBuyback(trader.publicKey, client.keys(p7), 0n)], [trader], "a second buy in the same 25 slots, built by hand");
  check(refusal2.includes("TooSoon"), "the program refuses it by name: TooSoon");
}

if (template === "launch_guard") {
  // No liquidity is added while the guard window runs: the guard fee is a pool fee, and a
  // wallet that added liquidity for a moment would take part of it out again.
  const p = await client.pool(plan.pool);
  const lpSupply = (await client.mint(p.lpMint)).supply;
  const lp = lpSupply / 1_000n;
  const most = (reserve) => (mulDivCeil(lp, reserve, lpSupply) * 101n) / 100n;
  check(hook.summary.canBlockAdding && !hook.summary.canBlockRemoval, "the guard's flags say it runs when liquidity is added, never when it is removed");
  const refusal = await sendRefused(conn, await client.addLiquidityInstructions(trader.publicKey, p, lp, most(p.reserveBase), most(p.reserveQuote)), [trader], "the trader adds liquidity inside the guard window");
  check(refusal.includes("LiquidityInGuardWindow"), "the hook refuses it by name: LiquidityInGuardWindow");
  const open = liquidityOpenSlot(hook);
  check(open === hook.guard.startSlot + hook.guard.guardSlots, `the SDK says liquidity can be added from slot ${open} on, the end of the guard window`);
  console.log(`  waiting for the guard window to end (slot ${open})`);
  await waitForSlot(conn, open);
  const p2 = await client.pool(plan.pool);
  await sendIxs(await client.addLiquidityInstructions(trader.publicKey, p2, lp, most(p2.reserveBase), most(p2.reserveQuote)), [trader], "the trader adds liquidity after the guard window");
  check((await client.tokenBalance(trader.publicKey, p2.lpMint)) === lp, "it passes now: the trader holds the LP it asked for");
  await sendIxs(await client.removeLiquidityInstructions(trader.publicKey, await client.pool(plan.pool), lp, 0n, 0n), [trader], "the trader takes it out again");
  check((await client.tokenBalance(trader.publicKey, p2.lpMint)) === 0n, "removing liquidity is never refused");
}

if (template === "tax") {
  // The treasury is the dev's wrapped SOL account. The dev takes the tax: the account is
  // emptied and stays open, so the coin's fees never find it missing.
  const treasury = pool.hookQuoteTreasury;
  const taken = BigInt((await conn.getTokenAccountBalance(treasury)).value.amount);
  await sendIxs(client.unwrapInstructions(dev.publicKey), [dev], "the dev takes the tax");
  check(taken > 0n && (await client.tokenBalance(dev.publicKey, NATIVE_MINT)) === 0n && (await client.exists(treasury)), `the dev took ${fmt(taken, 9)} SOL of tax, the treasury account is still open`);

  // The dev trades another way and the account gets closed: the trade of the next buyer
  // still goes through and its tax waits in the pool.
  await sendIxs([ix.closeAccount(treasury, dev.publicKey, dev.publicKey)], [dev], "the treasury account is closed");
  const p3 = await client.pool(plan.pool);
  const q3 = await client.quoteLocal(p3, platform, DIRECTION.BUY, buyIn, hook);
  await sendIxs(await client.swapInstructions(trader.publicKey, p3, hookRef, DIRECTION.BUY, buyIn, q3.amountOut), [trader], "buy 0.5 SOL with the treasury closed");
  const p4 = await client.pool(plan.pool);
  check(q3.hookFee > 0n && p4.hookFeesOwedQuote === q3.hookFee, `the trade went through and its tax waits in the pool: ${fmt(p4.hookFeesOwedQuote, 9)} SOL`);

  // Anyone pays it out: the account is recreated for its owner and the pool pays it.
  await sendIxs(await client.hookFeesInstructions(trader.publicKey, p4), [trader], "a stranger reopens the treasury and pays the waiting tax into it");
  const p5 = await client.pool(plan.pool);
  const paid = BigInt((await conn.getTokenAccountBalance(treasury)).value.amount);
  check(p5.hookFeesOwedQuote === 0n && paid === q3.hookFee, `the treasury received the ${fmt(paid, 9)} SOL that waited, nothing is owed`);
  check(p4.hookTreasuryOwner.equals(dev.publicKey), "the pool remembers whose account the treasury is");
}
console.log("e2e passed");
