// Proof for the early_bird hook, with numbers read from chain.
//
//   node examples/hooks/early-bird/prove.mjs [PROGRAM_ID] [WINDOW_SLOTS]
//
// The hook must be deployed frozen first (bash scripts/deploy-freeze.sh). Without a
// program id the script takes the one the source declares, which the build keeps equal
// to the deployed program. WINDOW_SLOTS defaults to 150, about one minute on a local
// validator: the script waits for the window to end.
//
// It launches a coin on the hook through the launchpad, then a second wallet buys and
// sells inside the early window and again after it. For every trade it reads the fee
// the pool charged twice (from the pool's own Swapped event, and recomputed from the
// pool's reserves) and whether the hook program was invoked at all.
// Wallets are created when the script runs; see WALLET_DIR in ../proof-lib.mjs.
import { sdk, conn, client, programIdOf, wallet, launchOnHook, send, txInfo, wasInvoked, unitsOf, callbackUnits, feeFromReserves, check, done, show, sol, sleep, PublicKey } from "../proof-lib.mjs";
import { initPoolConfigIx, decodeConfig } from "./client.mjs";

const { decodeHookManifest, decodeUpgradeAuthority, describeFlags, hookKindLabel, HOOK_KIND, FLAGS, DIRECTION, PROGRAMS, pda } = sdk;

const args = process.argv.slice(2);
const windowArg = args.find((a) => /^[0-9]+$/.test(a));
const EARLY_BIRD = programIdOf(import.meta.url, "early_bird", args.find((a) => !/^[0-9]+$/.test(a)));
const WINDOW = Number(windowArg ?? 150);         // slots
const DISCOUNT = 5000;                           // early buyers pay half the pool fee
const LP_FEE = 100;                              // the pool's own fee: 1%
console.log(`early_bird ${EARLY_BIRD.toBase58()} on ${conn.rpcEndpoint}, window ${WINDOW} slots`);

// ---- 1. the hook as a site sees it before anyone launches on it ------------------------
const pd = await conn.getAccountInfo(pda.programData(EARLY_BIRD), { dataSlice: { offset: 0, length: 45 } });
if (!pd) { console.error("This program is not on the chain. Deploy it first: bash examples/hooks/early-bird/scripts/deploy-freeze.sh"); process.exit(1); }
check(decodeUpgradeAuthority(new Uint8Array(pd.data)) === null, "the hook program is frozen");
const manifest = decodeHookManifest(new Uint8Array((await conn.getAccountInfo(pda.manifest(EARLY_BIRD))).data));
console.log(`  manifest: name "${manifest.name}", flags ${manifest.flags}, declared admin ${manifest.admin ? manifest.admin.toBase58() : "none"}`);
console.log("  a site would say:", describeFlags(manifest.flags).sentences.join(" "));
check(manifest.flags === (FLAGS.BEFORE_SWAP | FLAGS.ON_POOL_CREATE | FLAGS.OVERRIDE_FEE | FLAGS.CALL_ON_BUY), "the manifest's flags are BEFORE_SWAP | ON_POOL_CREATE | OVERRIDE_FEE | CALL_ON_BUY");

// ---- 2. launch -------------------------------------------------------------------------
const dev = await wallet("dev", 4);
const trader = await wallet("trader", 3);
const L = await launchOnHook({
  dev, hookProgram: EARLY_BIRD, name: "Early Bird Coin", symbol: "EARLY", lpFeeBps: LP_FEE, quoteSol: 2,
  makeSetup: (pool) => [initPoolConfigIx(EARLY_BIRD, dev.publicKey, pool, WINDOW, DISCOUNT)],
});
const launchInfo = await txInfo(L.launchSig);
let p = await client.pool(L.pool);
const cfgAddress = pda.cfg(EARLY_BIRD, L.pool);
const cfg = decodeConfig((await conn.getAccountInfo(cfgAddress)).data);
console.log(`  pool ${L.pool.toBase58()}  coin ${L.mint.toBase58()}`);
console.log(`  launch in slot ${launchInfo.slot}, ${launchInfo.cu} compute units; config.created_slot ${cfg.createdSlot}; pool.createdSlot ${p.createdSlot}`);
check(p.hookProgram.equals(EARLY_BIRD) && p.hookKind === HOOK_KIND.FROZEN, `the pool uses the hook, kind "${hookKindLabel(p.hookKind)}"`);
check(p.hookFlags === manifest.flags, "the pool copied the manifest's flags");
check(p.lpFeeBps === LP_FEE, `the pool's own fee is ${LP_FEE} bps`);
check(Number(cfg.createdSlot) === launchInfo.slot && p.createdSlot === cfg.createdSlot, "on_pool_create wrote the creation slot into the hook's config");
check(p.hookQuoteTreasury.equals(PublicKey.default), "a hook that takes no fee has no treasury: the pool stores the all-zero key");
const windowEnd = Number(cfg.createdSlot) + WINDOW;

// ---- 3. what a trader or a site sees ---------------------------------------------------
const info = await client.hookInfo(p);
check(info.template === "custom" && info.upgradeAuthority === null, "the SDK describes it as a custom hook with no upgrade authority");
const hookRef = await client.hookRef(p, trader.publicKey);
check(hookRef.extra.length === 1 && hookRef.extra[0].pubkey.equals(cfgAddress), "the SDK resolved the extra account (the config) from the list on chain");
check(hookRef.extra[0].isWritable === true && hookRef.extra[0].isSigner === false, "resolved as writable, and not a signer");

// ---- 4. trades -------------------------------------------------------------------------
const rows = [];
async function trade(label, direction, amountIn) {
  p = await client.pool(L.pool);
  const before = p;
  const quote = await client.quoteOnChain(trader.publicKey, p, direction, amountIn);
  const ref = await client.hookRef(p, trader.publicKey);
  const sig = await send(await client.swapInstructions(trader.publicKey, p, ref, direction, amountIn, quote), [trader], label);
  const t = await txInfo(sig);
  const after = await client.pool(L.pool);
  // the fee recomputed from the pool's reserves alone, without trusting the event
  const f = feeFromReserves(before, after, direction);
  const row = {
    label, slot: t.slot, inWindow: t.slot < windowEnd, amountIn, quote, event: t.swapped, lpFee: f.lpFee, bps: f.bps,
    hookInvoked: wasInvoked(t, EARLY_BIRD), poolUnits: unitsOf(t, PROGRAMS.hookpool), hookUnits: callbackUnits(t, EARLY_BIRD).units,
  };
  rows.push(row);
  console.log(`    slot ${t.slot} (${row.inWindow ? "inside" : "after"} the window, which ends at ${windowEnd}): pool fee ${f.lpFee} = ${f.bps} bps of ${f.addedIn}; hook invoked: ${row.hookInvoked}`);
  console.log(`    event: ${show(t.swapped)}`);
  return row;
}
const coins = () => client.tokenBalance(trader.publicKey, L.mint);
const b1 = await trade("buy for 0.5 SOL inside the window", DIRECTION.BUY, sol(0.5));
const s1 = await trade("sell a quarter of the coins inside the window", DIRECTION.SELL, (await coins()) / 4n);
console.log(`  waiting for slot ${windowEnd} ...`);
while ((await conn.getSlot("confirmed")) < windowEnd + 2) await sleep(1000);
const b2 = await trade("buy for 0.5 SOL after the window", DIRECTION.BUY, sol(0.5));
const s2 = await trade("sell a quarter of the coins after the window", DIRECTION.SELL, (await coins()) / 4n);

// ---- 5. the proof ----------------------------------------------------------------------
const early = (LP_FEE * DISCOUNT) / 10000;
check(b1.inWindow && s1.inWindow && !b2.inWindow && !s2.inWindow, "two trades landed inside the window and two after it");
check(b1.bps === early, `the early buy paid ${b1.bps} bps to the pool (half of its ${LP_FEE})`);
check(b2.bps === LP_FEE, `the late buy paid ${b2.bps} bps (the pool's own fee)`);
check(s1.bps === LP_FEE && s2.bps === LP_FEE, `both sells paid ${s1.bps} and ${s2.bps} bps: a sell gets no discount`);
const eventBps = (r) => r.event?.feeBpsApplied;
check(eventBps(b1) === early && eventBps(s1) === LP_FEE && eventBps(b2) === LP_FEE && eventBps(s2) === LP_FEE,
  `the pool's own Swapped events agree: feeBpsApplied ${eventBps(b1)} / ${eventBps(s1)} / ${eventBps(b2)} / ${eventBps(s2)}`);
check(rows.every((r) => r.event && r.event.lpFee === r.lpFee), "the event's lpFee equals the fee recomputed from the reserves, on all four trades");
check(rows.every((r) => r.event && r.event.hookFee === 0n), "the event's hookFee is 0 on all four trades");
check(rows.every((r) => r.event && r.event.amountOut === r.quote), "every trade paid out exactly the simulated quote");
check(b1.hookInvoked && b2.hookInvoked, "the hook was invoked on both buys");
check(!s1.hookInvoked && !s2.hookInvoked, "the hook was NOT invoked on either sell");
check((await client.pool(L.pool)).hookFeesQuoteTotal === 0n, "the hook took no fee for itself: pool.hookFeesQuoteTotal is 0");

console.log(`\nearly_bird   ${EARLY_BIRD.toBase58()}`);
console.log(`pool         ${L.pool.toBase58()}`);
console.log(`coin         ${L.mint.toBase58()}`);
console.log(`launch: ${launchInfo.cu} compute units`);
for (const r of rows) console.log(`  ${r.label.padEnd(46)} slot ${r.slot}  pool fee ${String(r.bps).padStart(3)} bps  hook invoked ${String(r.hookInvoked).padEnd(5)}  swap instruction ${r.poolUnits} compute units${r.hookInvoked ? ", of which the hook " + r.hookUnits : ""}`);
done("prove early_bird");
