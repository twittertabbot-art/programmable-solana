// Proof for the loyalty_points hook, with numbers read from chain.
//
//   node examples/hooks/loyalty-points/prove.mjs [PROGRAM_ID]
//
// The hook must be deployed frozen first (bash scripts/deploy-freeze.sh). Without a
// program id the script takes the one the source declares, which the build keeps equal
// to the deployed program.
//
// It launches a coin on the hook through the launchpad (with a dev buy), then two
// wallets trade: "trader" opens a points account first, "trader2" does not. After every
// trade the script reads the hook's per-pool Config and both Points accounts.
// Wallets are created when the script runs; see WALLET_DIR in ../proof-lib.mjs.
import { sdk, conn, client, programIdOf, wallet, launchOnHook, send, txInfo, wasInvoked, unitsAndDepth, callbackUnits, feeFromReserves, check, done, sol } from "../proof-lib.mjs";
import { initPoolConfigIx, openPointsIx, pointsAddress, readConfig, readPoints } from "./client.mjs";

const { decodeHookManifest, decodeUpgradeAuthority, describeFlags, hookKindLabel, parseExtraAccountMetas, HOOK_KIND, FLAGS, DIRECTION, PROGRAMS, pda } = sdk;

const LOYALTY = programIdOf(import.meta.url, "loyalty_points", process.argv[2]);
const QUOTE_PER_POINT = 1_000_000n;     // 0.001 SOL sent = 1 point
const LP_FEE = 100;
console.log(`loyalty_points ${LOYALTY.toBase58()} on ${conn.rpcEndpoint}`);

// ---- 1. the hook as a site sees it before anyone launches on it ------------------------
const pd = await conn.getAccountInfo(pda.programData(LOYALTY), { dataSlice: { offset: 0, length: 45 } });
if (!pd) { console.error("This program is not on the chain. Deploy it first: bash examples/hooks/loyalty-points/scripts/deploy-freeze.sh"); process.exit(1); }
check(decodeUpgradeAuthority(new Uint8Array(pd.data)) === null, "the hook program is frozen");
const manifest = decodeHookManifest(new Uint8Array((await conn.getAccountInfo(pda.manifest(LOYALTY))).data));
console.log(`  manifest: name "${manifest.name}", flags ${manifest.flags}, declared admin ${manifest.admin ? manifest.admin.toBase58() : "none"}`);
console.log("  a site would say:", describeFlags(manifest.flags).sentences.join(" "));
check(manifest.flags === (FLAGS.AFTER_SWAP | FLAGS.ON_POOL_CREATE | FLAGS.CALL_ON_BUY), "the manifest's flags are AFTER_SWAP | ON_POOL_CREATE | CALL_ON_BUY");
const list = await conn.getAccountInfo(pda.extraMetas(LOYALTY));
const entries = parseExtraAccountMetas(new Uint8Array(list.data));
check(entries.length === 2, `the extra-accounts list holds two entries in ${list.data.length} bytes`);

// ---- 2. launch, with a dev buy in the same transaction ---------------------------------
const dev = await wallet("dev", 4);
const trader = await wallet("trader", 3);       // opens a points account
const trader2 = await wallet("trader2", 3);     // does not, until the last step
const L = await launchOnHook({
  dev, hookProgram: LOYALTY, name: "Loyalty Coin", symbol: "LOYAL", lpFeeBps: LP_FEE, quoteSol: 2, devBuySol: 0.1,
  makeSetup: (pool) => [initPoolConfigIx(LOYALTY, dev.publicKey, pool, QUOTE_PER_POINT)],
});
const launchInfo = await txInfo(L.launchSig);
let p = await client.pool(L.pool);
console.log(`  pool ${L.pool.toBase58()}  coin ${L.mint.toBase58()}  launch ${launchInfo.cu} compute units`);
check(p.hookProgram.equals(LOYALTY) && p.hookKind === HOOK_KIND.FROZEN, `the pool uses the hook, kind "${hookKindLabel(p.hookKind)}"`);
check(p.hookFlags === manifest.flags, "the pool copied the manifest's flags");
const cfg0 = await readConfig(LOYALTY, L.pool);
check(cfg0.live === true, "on_pool_create marked the config live");
check(cfg0.buysSeen === 1n && cfg0.buysRewarded === 0n && cfg0.totalPoints === 0n, "after_swap saw the dev buy inside the launch; it earned nothing (the dev has no points account)");
const hookInLaunch = launchInfo.invoked.filter((i) => i.program === LOYALTY.toBase58()).map((i) => i.depth);
console.log(`  in the launch the hook ran at call level ${[...new Set(hookInLaunch)].join(" and ")} (launchpad, pool, hook)`);

// ---- 3. what a trader or a site sees ---------------------------------------------------
const info = await client.hookInfo(p);
check(info.template === "custom" && info.upgradeAuthority === null, "the SDK describes it as a custom hook with no upgrade authority");
const ref1 = await client.hookRef(p, trader.publicKey);
const ref2 = await client.hookRef(p, trader2.publicKey);
check(ref1.extra.length === 2, "the SDK resolved two extra accounts from the list on chain");
check(ref1.extra[0].pubkey.equals(pda.cfg(LOYALTY, L.pool)) && ref1.extra[0].isWritable, "extra account 5 is the pool's Config, writable");
check(ref1.extra[1].pubkey.equals(pointsAddress(LOYALTY, L.pool, trader.publicKey)) && ref1.extra[1].isWritable, "extra account 6 is the TRADER's own Points address, writable");
check(ref2.extra[1].pubkey.equals(pointsAddress(LOYALTY, L.pool, trader2.publicKey)), "for another wallet the SDK resolves that wallet's Points address");
check([...ref1.extra, ...ref2.extra].every((m) => m.isSigner === false), "no extra account is a signer");

// ---- 4. trades -------------------------------------------------------------------------
const rows = [];
async function state(label) {
  const c = await readConfig(LOYALTY, L.pool);
  const a = await readPoints(LOYALTY, L.pool, trader.publicKey);
  const b = await readPoints(LOYALTY, L.pool, trader2.publicKey);
  const row = { label, total: c.totalPoints, seen: c.buysSeen, rewarded: c.buysRewarded, trader: a ? a.points : null, traderBuys: a ? a.buys : null, trader2: b ? b.points : null, trader2Buys: b ? b.buys : null };
  rows.push(row);
  const one = (pts, buys) => (pts === null ? "no account" : `${pts} points in ${buys} buys`);
  console.log(`    pool total ${row.total} points, buys seen ${row.seen}, rewarded ${row.rewarded} | trader: ${one(row.trader, row.traderBuys)} | trader2: ${one(row.trader2, row.trader2Buys)}`);
  return row;
}
async function trade(who, label, direction, amountIn, before = []) {
  p = await client.pool(L.pool);
  const ref = await client.hookRef(p, who.publicKey);
  const quote = await client.quoteOnChain(who.publicKey, p, direction, amountIn);
  const sig = await send([...before, ...(await client.swapInstructions(who.publicKey, p, ref, direction, amountIn, quote))], [who], label);
  const t = await txInfo(sig);
  const after = await client.pool(L.pool);
  const f = feeFromReserves(p, after, direction);
  const invoked = wasInvoked(t, LOYALTY);
  const swap = unitsAndDepth(t, PROGRAMS.hookpool), hook = callbackUnits(t, LOYALTY);
  console.log(`    slot ${t.slot}: hook invoked ${invoked}; pool fee ${f.bps} bps (event ${t.swapped?.feeBpsApplied}), hook fee ${t.swapped?.hookFee}, out ${t.swapped?.amountOut} (quoted ${quote}); swap instruction ${swap.units} compute units${invoked ? ", of which the hook " + hook.units + " at call level " + hook.depth : ""}`);
  return { ev: t.swapped, f, s: await state(label), invoked, quote };
}
const coins = (who) => client.tokenBalance(who.publicKey, L.mint);

await state("after the launch");
await send([openPointsIx(LOYALTY, trader.publicKey, L.pool)], [trader], "trader opens a points account (own signature, own rent)");
const s0 = await state("trader opened an account");
check(s0.trader === 0n && s0.trader2 === null, "trader has an account with 0 points, trader2 has none");

const t1 = await trade(trader, "trader buys for 0.5 SOL", DIRECTION.BUY, sol(0.5));
check(t1.invoked && t1.s.trader === 500n && t1.s.total === 500n, "0.5 SOL at 0.001 SOL per point = 500 points, for trader and for the pool total");
const t2 = await trade(trader, "trader buys for 0.25 SOL", DIRECTION.BUY, sol(0.25));
check(t2.s.trader === 750n && t2.s.traderBuys === 2n && t2.s.total === 750n, "the second buy adds 250: trader has 750 points in 2 buys");
const t3 = await trade(trader2, "trader2 buys for 0.3 SOL without an account", DIRECTION.BUY, sol(0.3));
check(t3.invoked, "the hook was invoked on trader2's buy");
check(t3.s.trader2 === null && t3.s.total === 750n, "the buy went through and earned nothing: no account for trader2, pool total unchanged");
check(t3.s.seen === t2.s.seen + 1n && t3.s.rewarded === t2.s.rewarded, "the hook counted the buy as seen, not as rewarded");
check((await coins(trader2)) === t3.quote && t3.quote > 0n, "trader2 received exactly the simulated quote");
check((await conn.getAccountInfo(pointsAddress(LOYALTY, L.pool, trader2.publicKey))) === null, "trader2's Points address still holds nothing on chain");

const t4 = await trade(trader, "trader sells half of its coins", DIRECTION.SELL, (await coins(trader)) / 2n);
check(!t4.invoked, "the hook was NOT invoked on trader's sell");
check(t4.s.trader === 750n && t4.s.total === 750n && t4.s.seen === t3.s.seen, "the sell changed no points and no counter");
const t5 = await trade(trader2, "trader2 sells half of its coins", DIRECTION.SELL, (await coins(trader2)) / 2n);
check(!t5.invoked && t5.s.total === 750n && t5.s.trader2 === null, "trader2's sell: hook not invoked, nothing changed");

const t6 = await trade(trader2, "trader2 opens an account and buys for 0.2 SOL in ONE transaction", DIRECTION.BUY, sol(0.2), [openPointsIx(LOYALTY, trader2.publicKey, L.pool)]);
check(t6.s.trader2 === 200n && t6.s.trader2Buys === 1n && t6.s.total === 950n, "open + buy in one transaction earned 200 points; the pool total is 950 = 750 + 200");

check([t1, t2, t3, t6].every((x) => x.f.bps === LP_FEE && x.ev.feeBpsApplied === LP_FEE && x.ev.hookFee === 0n), "every buy paid the pool's own fee and no hook fee: the hook changed no price");
check([t1, t2, t3, t4, t5, t6].every((x) => x.ev.amountOut === x.quote), "every trade paid out exactly the simulated quote");
check((await client.pool(L.pool)).hookFeesQuoteTotal === 0n, "pool.hookFeesQuoteTotal is 0");

console.log(`\nloyalty_points ${LOYALTY.toBase58()}`);
console.log(`pool           ${L.pool.toBase58()}`);
console.log(`coin           ${L.mint.toBase58()}`);
for (const r of rows) console.log(`  ${r.label.padEnd(66)} total ${String(r.total).padStart(4)}  seen ${r.seen} rewarded ${r.rewarded}  trader ${r.trader === null ? "none" : r.trader}  trader2 ${r.trader2 === null ? "none" : r.trader2}`);
done("prove loyalty_points");
