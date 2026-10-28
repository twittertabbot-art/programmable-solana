// Launches one coin of every kind the parity suite covers, and writes their addresses into
// tests/parity.rs. Run it on a chain where the platform is initialised, then snapshot:
//
//   node jupiter-adapter/scripts/make-fixtures.mjs localnet
//   RPC=http://127.0.0.1:8899 REFRESH=1 FRESH_PROGRAMS=1 bash jupiter-adapter/test.sh
//
// Run the second command within an hour of the first: two fixtures must still be inside a
// window when they are snapshotted, a launch guard (10,800 slots, about 72 minutes) and a
// rules coin inside its sniper window (10,800 slots) and its buy limit window (9,000 slots,
// about one hour). Run it soon for a third reason too: one fixture is a pool on the curve
// that stands past its graduation target, and anyone may graduate it (the platform's
// watcher does). Snapshotted after that, its test fails and says the pool is not on the
// curve any more: run this script again.
//
// The snapshots in tests/fixtures belong to one chain and one set of program ids. Make them
// again after a restart of the local validator, after a change of program ids, after a
// change to an account layout or to a program, and from mainnet pools before the adapter is
// submitted anywhere.
//
// The coins are launched by the deployer wallet of the cluster (scripts/cluster.mjs says
// where its key is read from). Twelve seeded launches at 3 SOL each, five launches on the
// curve with first buys of 5 and 3 SOL, and two of those curve coins bought past their
// graduation target: about 230 SOL in all. On the local validator the script tops the
// deployer up by airdrop when it holds less.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CURVE_GRADUATED, CURVE_OPEN, DIRECTION, HookpoolClient, NATIVE_MINT, ix, pda } from "../../sdk/dist/index.js";
import { clusterArg, connection, deployer, loadAlt, sendV0 } from "../../scripts/cluster.mjs";

const cluster = clusterArg();
const conn = connection(cluster);
const dev = deployer(cluster);
const client = new HookpoolClient(conn, { lookupTable: loadAlt(cluster) });
if (!client.options.lookupTable) { console.error("run scripts/init-platform.mjs first: no lookup table file"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOL = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));

const platform = await client.platform();
if (!platform.curveEnabled) { console.error("curve launches are switched off on this platform: set them with scripts/init-platform.mjs (CURVE_VIRTUAL_SOL, CURVE_TARGET_SOL)"); process.exit(1); }
// tests/parity.rs asserts the platform's settings of the default launch: 30 virtual SOL, 85 SOL to graduate
if (platform.curveVirtualQuote !== SOL(30) || platform.curveGraduationTarget !== SOL(85)) {
  console.error(`the platform's curve settings are ${platform.curveVirtualQuote} and ${platform.curveGraduationTarget} lamports; tests/parity.rs expects 30 and 85 SOL (VIRTUAL and TARGET there)`);
  process.exit(1);
}
// what the target takes, with room for the fees and the 3 SOL buys that cross it
const need = SOL(12 * 3 + 5 + 3) + 2n * (platform.curveGraduationTarget + SOL(6)) + SOL(5);
const balance = BigInt(await conn.getBalance(dev.publicKey));
if (balance < need) {
  if (cluster !== "localnet") { console.error(`the deployer ${dev.publicKey.toBase58()} holds ${balance} lamports; this script needs about ${need}`); process.exit(1); }
  await conn.confirmTransaction(await conn.requestAirdrop(dev.publicKey, Number(need - balance)), "confirmed");
  console.log(`  the deployer was topped up by airdrop to ${need} lamports`);
}

const ART = Uint8Array.from([1, 20, 235, 30, 24, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const collectible = (pegged) => ({ name: "Parity", uriBase: "https://example.invalid/art", unit: 50_000_000n * 1_000_000n, maxSupply: 1000, maxPerBuy: 3, art: ART, pegged });
// A wallet made here and forgotten when the script ends. It owns the fee treasury of the
// TAX_CLOSED coin and closes it, which is the one thing it is ever used for.
const treasuryOwner = Keypair.generate();
// name of the constant in tests/parity.rs, then what to launch. The numbers are the ones the
// tests assert: tax 3% and 5%, buyback 2%, a guard that is over and one that still runs,
// rules with a creator fee of 1%, rules with three rates that differ by side (2% on buys,
// 4% on sells), and rules inside a sniper window with a buy limit of half a SOL
// (SNIPER_BUY_LIMIT in tests/parity.rs). The pegged and the strict coin are there to prove
// they are not offered. The five CURVE_ coins are launched on the curve: no SOL from the
// creator, the platform's virtual SOL in the price. `buyToTarget` buys one of them past its
// graduation target, with `graduate` in the same transaction or without it.
const KINDS = [
  ["NO_HOOK", { template: "none" }],
  ["TAX", { template: "tax", tax: { buyBps: 300, sellBps: 500, maxBps: 1000 } }],
  ["TAX_CLOSED", { template: "tax", tax: { buyBps: 300, sellBps: 500, maxBps: 1000, treasury: treasuryOwner.publicKey } }],
  ["BUYBACK", { template: "buyback", buyback: { buyBps: 200, sellBps: 200, minQuote: BigInt(0.05 * LAMPORTS_PER_SOL) } }],
  ["GUARD_OVER", { template: "launch_guard", guard: { guardSlots: 2n, startFeeBps: 3000 } }],
  ["GUARD_RUNNING", { template: "launch_guard", guard: { guardSlots: 10_800n, startFeeBps: 5000 } }],
  ["COLLECTIBLE", { template: "collectible", collectible: collectible(false) }],
  ["PEGGED", { template: "collectible", collectible: collectible(true) }],
  ["RULES_PLAIN", { template: "rules", rules: { buy: { creatorBps: 100 }, sell: { creatorBps: 100 } } }],
  ["RULES_RATES", { template: "rules", rules: { buy: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, sell: { creatorBps: 100, holdersBps: 200, burnBps: 100 } } }],
  ["STRICT", { template: "rules", rules: { buy: { creatorBps: 100 }, sell: { creatorBps: 100 }, strict: {} } }],
  ["RULES_SNIPER", { template: "rules", rules: { sniperSlots: 10_800n, sniperStartFeeBps: 5000, maxBuyQuote: BigInt(0.5 * LAMPORTS_PER_SOL), limitSlots: 9_000n, buy: { creatorBps: 100 }, sell: { creatorBps: 100 } } }],
  ["CURVE_FRESH", { template: "none", curve: true }],
  ["CURVE_OPEN", { template: "none", curve: true, devBuyQuote: SOL(5), minDevBuyOut: 1n }],
  ["CURVE_RULES", { template: "rules", curve: true, rules: { buy: { creatorBps: 100, burnBps: 100 }, sell: { burnBps: 100 } }, devBuyQuote: SOL(3), minDevBuyOut: 1n }],
  ["CURVE_PAST", { template: "none", curve: true, buyToTarget: { graduate: false } }],
  ["CURVE_GRADUATED", { template: "none", curve: true, buyToTarget: { graduate: true } }],
];

/// Buys a curve coin from the dev wallet until its real SOL stands past the graduation target.
/// With `graduate: true` the buy that crosses carries `graduate` (the SDK appends it), so the
/// pool graduates in that transaction; with `graduate: false` it carries none and the pool
/// stays on the curve, past its target.
async function buyToTarget(name, poolKey, graduate) {
  for (let i = 0; i < 4; i++) {
    const pool = await client.pool(poolKey);
    if (pool.curveState !== CURVE_OPEN || pool.reserveQuote >= pool.graduationTarget) break;
    const amount = pool.graduationTarget - pool.reserveQuote + SOL(3);
    const hook = await client.hookRef(pool, dev.publicKey);
    const ixs = await client.swapInstructions(dev.publicKey, pool, hook, DIRECTION.BUY, amount, 0n, { graduate });
    await sendV0(conn, client, ixs, [dev], `${name}: a buy of ${Number(amount) / LAMPORTS_PER_SOL} SOL${graduate ? ", graduate appended" : ", no graduate"}`);
  }
  const after = await client.pool(poolKey);
  const ok = graduate ? after.curveState === CURVE_GRADUATED : after.curveState === CURVE_OPEN && after.reserveQuote >= after.graduationTarget;
  if (!ok) { console.error(`${name}: the pool is not where it should be (curve state ${after.curveState}, ${after.reserveQuote} real lamports, target ${after.graduationTarget})`); process.exit(1); }
  console.log(`  ${name}: ${graduate ? "graduated" : "on the curve, past its target"}, ${Number(after.reserveQuote) / LAMPORTS_PER_SOL} real SOL`);
}

const made = {};
for (const [name, kind] of KINDS) {
  const { buyToTarget: toTarget, ...extra } = kind;
  const mint = Keypair.generate();
  const seed = extra.curve ? {} : { quoteAmount: BigInt(3 * LAMPORTS_PER_SOL) };
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name: "Parity " + name, symbol: "PAR", uri: "https://example.invalid/parity.json", decimals: 6,
    totalSupply: 1_000_000_000n * 1_000_000n, quoteMint: NATIVE_MINT, lpFeeBps: 100, ...seed,
    devBuyQuote: 0n, minDevBuyOut: 0n, ...extra,
  });
  await sendV0(conn, client, plan.createTx, [dev, mint, ...plan.signers.filter((k) => !k.publicKey.equals(mint.publicKey))], `create ${name}`);
  await sendV0(conn, client, plan.launchTx, [dev], `launch ${name}`);
  made[name] = [plan.pool.toBase58(), mint.publicKey.toBase58()];
  if (toTarget) await buyToTarget(name, plan.pool, toTarget.graduate);
  if (name === "TAX_CLOSED") {
    // The treasury account goes away, then one trade lands: its fee cannot be paid and waits
    // in the pool's vault, outside the reserves. The snapshot is taken in that state.
    const treasury = pda.ata(treasuryOwner.publicKey, NATIVE_MINT);
    await sendV0(conn, client, [ix.closeAccount(treasury, dev.publicKey, treasuryOwner.publicKey)], [dev, treasuryOwner], "close the treasury of TAX_CLOSED");
    const pool = await client.pool(plan.pool);
    const hook = await client.hookRef(pool, dev.publicKey);
    await sendV0(conn, client, await client.swapInstructions(dev.publicKey, pool, hook, DIRECTION.BUY, BigInt(0.05 * LAMPORTS_PER_SOL), 0n), [dev], "a buy on TAX_CLOSED, its fee waits");
    const after = await client.pool(plan.pool);
    if (after.hookFeesOwedQuote === 0n || (await client.exists(treasury))) { console.error("TAX_CLOSED: the fee did not wait as expected"); process.exit(1); }
    console.log(`  TAX_CLOSED: treasury closed, ${after.hookFeesOwedQuote} lamports of hook fee wait in the pool`);
  }
}
// The test kit reads accounts at the "finalized" commitment: wait until the launches are
// final, or it reports the pools as not found. By then the short guard window is over too.
const launched = await conn.getSlot("confirmed");
process.stdout.write("waiting for the launches to be final");
while ((await conn.getSlot("finalized")) < launched + 2) { process.stdout.write("."); await sleep(1000); }
console.log("");

const file = fileURLToPath(new URL("../tests/parity.rs", import.meta.url));
let src = readFileSync(file, "utf8");
for (const [name, [pool, mint]] of Object.entries(made)) {
  const line = new RegExp(`const ${name}: \\(Pubkey, Pubkey\\) = \\(pubkey!\\("[^"]+"\\), pubkey!\\("[^"]+"\\)\\);`);
  if (!line.test(src)) { console.error(`tests/parity.rs has no constant ${name}`); process.exit(1); }
  src = src.replace(line, `const ${name}: (Pubkey, Pubkey) = (pubkey!("${pool}"), pubkey!("${mint}"));`);
  console.log(`  ${name.padEnd(15)} pool ${pool}  coin ${mint}`);
}
writeFileSync(file, src);
// the old snapshots belong to pools that are not in the file any more
rmSync(fileURLToPath(new URL("../tests/fixtures/accounts", import.meta.url)), { recursive: true, force: true });
console.log("tests/parity.rs updated, old snapshots removed. Now snapshot and run, within the hour:");
console.log("  RPC=<the rpc url of this cluster> REFRESH=1 FRESH_PROGRAMS=1 bash jupiter-adapter/test.sh");
