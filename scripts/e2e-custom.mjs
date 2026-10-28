// The third-party path, end to end: a hook that is NOT one of the platform's gets a coin
// launched on it through the launchpad with the SDK's custom-hook option, and trades.
//
//   node scripts/e2e-custom.mjs <localnet|devnet> <HOOK_PROGRAM_ID>
//
// The hook must be the UNCHANGED program of hook-template/, deployed frozen with
// hook-template/scripts/deploy-freeze.sh (that script prints the program id). For a hook
// of your own, copy this file and change step 2: it builds the template's own
// `init_pool_config` and `set_fee` instructions by hand, the way the client of any
// third-party hook has to. examples/hooks/ has two more scripts like this one.
//
// It needs no key from your machine. Two wallets are created when it runs: one launches
// the coin (funded by airdrop, which a local validator always grants), one trades.
//   DEV_KEYPAIR=<keypair file>     launch from this wallet instead (it needs about 4 SOL)
//   TREASURY_OWNER=<address>       send the hook's fee to this wallet's wrapped SOL
//                                  account instead of the launcher's
//   LOCALNET_RPC / DEVNET_RPC      another RPC address
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { RPC, connection } from "./cluster.mjs";

const usage = "usage: node scripts/e2e-custom.mjs <localnet|devnet> <HOOK_PROGRAM_ID>";
const cluster = process.argv[2];
if (cluster !== "localnet" && cluster !== "devnet") { console.error(usage + "\nThis rehearsal spends SOL on a throwaway coin: it runs on a test chain only."); process.exit(1); }
let hookProgram;
try { hookProgram = new PublicKey(process.argv[3] ?? ""); } catch { console.error(usage + "\nThe program id is printed by hook-template/scripts/deploy-freeze.sh."); process.exit(1); }

const sdkFile = new URL("../sdk/dist/index.js", import.meta.url);
if (!existsSync(fileURLToPath(sdkFile))) {
  console.error("The SDK is not built (sdk/dist/index.js is missing). At the repository root run:\n  npm install\n  npm run sdk");
  process.exit(1);
}
const { HookpoolClient, NATIVE_MINT, DIRECTION, FLAGS, HOOK_KIND, PROGRAMS, pda, decodeHookManifest, decodeUpgradeAuthority, describeFlags, hookKindLabel, eventsFromTransaction, feeCeil } = await import(sdkFile.href);

const conn = connection(cluster);
const client = new HookpoolClient(conn);
const sol = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));
const fmt = (v) => (Number(v) / LAMPORTS_PER_SOL).toLocaleString("en-US", { maximumFractionDigits: 9 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stop = (msg) => { console.error(msg); process.exit(1); };
const check = (cond, msg) => { if (!cond) stop("CHECK FAILED: " + msg); console.log("  check  " + msg); };

async function logsOf(e) { return e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null); }
async function sendIxs(ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    console.log(`  ok  ${label}`);
    return sig;
  } catch (e) {
    console.error(`  FAILED ${label}`);
    const logs = await logsOf(e);
    console.error(logs ? logs.join("\n") : e.message);
    process.exit(1);
  }
}
/// Send something the chain must refuse, and return the logs of the refusal.
async function sendRefused(ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  try { await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" }); }
  catch (e) { console.log(`  refused  ${label}`); return ((await logsOf(e)) ?? [e.message]).join("\n"); }
  stop(`CHECK FAILED: the chain accepted what it had to refuse: ${label}`);
}
/// A confirmed transaction: its compute units and the Programmable events inside it.
async function txInfo(sig) {
  let tx = null;
  for (let i = 0; i < 40 && !tx; i++) {
    tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx) await sleep(250);
  }
  if (!tx) stop("transaction not found: " + sig);
  // the second argument is required: the ids of the programs whose events count
  const events = eventsFromTransaction(tx, Object.values(PROGRAMS).map((k) => k.toBase58()));
  // What each program used and at which call level, from the "invoke [level]" and
  // "consumed N of M compute units" lines of the logs.
  const used = [];
  const stack = [];
  for (const line of tx.meta?.logMessages ?? []) {
    let m;
    if ((m = /^Program (\S+) invoke \[(\d+)\]/.exec(line))) stack.push(Number(m[2]));
    else if ((m = /^Program (\S+) consumed (\d+) of \d+ compute units/.exec(line))) used.push({ program: m[1], units: Number(m[2]), level: stack[stack.length - 1] ?? 0 });
    else if (/^Program \S+ (success|failed)/.test(line)) stack.pop();
  }
  const outermost = (program) => {
    const mine = used.filter((u) => u.program === program.toBase58());
    const level = Math.min(...mine.map((u) => u.level));
    return { level, units: mine.filter((u) => u.level === level).reduce((a, u) => a + u.units, 0) };
  };
  return { cu: tx.meta?.computeUnitsConsumed ?? null, events, swapped: events.filter((e) => e.kind === "Swapped"), pool: outermost(PROGRAMS.hookpool), hook: outermost(hookProgram) };
}

console.log(`cluster ${cluster} (${RPC[cluster]}), hook ${hookProgram.toBase58()}`);
const platform = await client.platform().catch(() => null);
if (!platform) stop(`Programmable is not initialised on ${cluster}. On a local chain, from the repository root:\n  bash scripts/localnet.sh up\n  node scripts/init-platform.mjs localnet`);

// ---- 1. the hook as a site sees it before anyone launches on it ------------------------
const programData = await conn.getAccountInfo(pda.programData(hookProgram), { dataSlice: { offset: 0, length: 45 } });
if (!programData) stop(`There is no program ${hookProgram.toBase58()} on ${cluster}. Deploy the template first:\n  bash hook-template/scripts/deploy-freeze.sh ${cluster}`);
check(decodeUpgradeAuthority(new Uint8Array(programData.data)) === null, "the hook program is frozen (it has no upgrade authority)");
check(!Object.values(PROGRAMS).some((k) => k.equals(hookProgram)), "the hook program is not one of the platform's");
const manifestAccount = await conn.getAccountInfo(pda.manifest(hookProgram));
if (!manifestAccount) stop("This program has not published a manifest. It was frozen before `init_manifest` ran and no pool can use it.");
const manifest = decodeHookManifest(new Uint8Array(manifestAccount.data));
console.log(`  manifest: name "${manifest.name}", flags ${manifest.flags}, declared admin ${manifest.admin ? manifest.admin.toBase58() : "none"}`);
console.log(`  a site would say: ${describeFlags(manifest.flags).sentences.join(" ")}`);
const TEMPLATE_FLAGS = FLAGS.BEFORE_SWAP | FLAGS.ON_POOL_CREATE | FLAGS.TAKE_HOOK_FEE | FLAGS.CALL_ON_BUY | FLAGS.CALL_ON_SELL;
if (manifest.flags !== TEMPLATE_FLAGS) stop(`This hook's flags are ${manifest.flags}; the unchanged template has ${TEMPLATE_FLAGS}.\nThis script rehearses the template as it ships. For another hook, copy the script and change step 2.`);

// ---- wallets --------------------------------------------------------------------------
let dev;
if (process.env.DEV_KEYPAIR) {
  dev = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEV_KEYPAIR, "utf8"))));
} else {
  dev = Keypair.generate();
  try { await conn.confirmTransaction(await conn.requestAirdrop(dev.publicKey, 6 * LAMPORTS_PER_SOL), "confirmed"); }
  catch (e) { stop(`The airdrop to a fresh wallet failed on ${cluster} (${e.message}).\nSet DEV_KEYPAIR=<keypair file of a wallet with about 4 SOL>.`); }
}
const trader = Keypair.generate();
await sendIxs([SystemProgram.transfer({ fromPubkey: dev.publicKey, toPubkey: trader.publicKey, lamports: 1.5 * LAMPORTS_PER_SOL })], [dev], "fund a second wallet, the trader");
const treasuryOwner = process.env.TREASURY_OWNER ? new PublicKey(process.env.TREASURY_OWNER) : dev.publicKey;
console.log(`  launcher ${dev.publicKey.toBase58()}, trader ${trader.publicKey.toBase58()}, fee receiver ${treasuryOwner.toBase58()}`);

// ---- 2. the hook's own instructions, built by hand -------------------------------------
// The SDK knows nothing about a third-party hook's instructions. Anchor's layout:
// sha256("global:<name>")[..8], then the arguments in borsh.
const disc = (name) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const FEE_BPS = 250, CEILING_BPS = 500;
const mint = Keypair.generate();
const pool = pda.pool(mint.publicKey, NATIVE_MINT);       // known before the pool exists
const cfg = pda.cfg(hookProgram, pool);                    // PDA ["cfg", pool] of the hook
/// init_pool_config(pool, fee_bps, max_bps): accounts payer, owner, cfg, system program.
const initPoolConfig = new TransactionInstruction({
  programId: hookProgram,
  data: Buffer.concat([disc("init_pool_config"), pool.toBuffer(), u16(FEE_BPS), u16(CEILING_BPS)]),
  keys: [
    { pubkey: dev.publicKey, isSigner: true, isWritable: true },
    { pubkey: dev.publicKey, isSigner: true, isWritable: false },
    { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
/// set_fee(fee_bps): accounts owner, cfg.
const setFee = (bps) => new TransactionInstruction({
  programId: hookProgram,
  data: Buffer.concat([disc("set_fee"), u16(bps)]),
  keys: [{ pubkey: dev.publicKey, isSigner: true, isWritable: false }, { pubkey: cfg, isSigner: false, isWritable: true }],
});
/// What the pool takes for the hook on a buy: `bps` of what is left after the protocol fee.
const hookFeeOnBuy = (amountIn, bps) => feeCeil(amountIn - feeCeil(amountIn, platform.protocolFeeBps), bps);

// ---- 3. launch through the launchpad with the custom hook ------------------------------
const treasury = pda.ata(treasuryOwner, NATIVE_MINT);
const treasuryBalance = async () => { const a = await conn.getTokenAccountBalance(treasury, "confirmed").catch(() => null); return a ? BigInt(a.value.amount) : 0n; };
const treasuryAtStart = await treasuryBalance();
const DEV_BUY = sol(0.1);
const plan = await client.launchInstructions({
  dev: dev.publicKey, mint, name: "Outside Hook Coin", symbol: "OUT", uri: "https://example.com/meta/out.json", decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
  quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: sol(2), devBuyQuote: DEV_BUY, minDevBuyOut: 1n,
  template: "custom", custom: { program: hookProgram, treasuryOwner, setup: [initPoolConfig] },
});
// Two transactions. The first is NOT undone when the second is refused.
await sendIxs(plan.createTx, [dev, ...plan.signers], "transaction 1: the coin, the fee receiver's token account, the hook's per-pool config");
const launchSig = await sendIxs(plan.launchTx, [dev], "transaction 2: the pool with the custom hook, liquidity locked, dev buy of 0.1 SOL");
const launchInfo = await txInfo(launchSig);
let p = await client.pool(plan.pool);
check(plan.pool.equals(pool) && p.hookProgram.equals(hookProgram), `the pool uses the outside hook (${hookKindLabel(p.hookKind)})`);
check(p.hookKind === HOOK_KIND.FROZEN, "recorded as a frozen custom hook, not a platform template");
check(p.hookFlags === manifest.flags, "the pool copied the manifest's flags");
check(p.hookQuoteTreasury.equals(treasury) && p.hookTreasuryOwner.equals(treasuryOwner), "the fee receiver is the wallet the launcher named, through its wrapped SOL account");
const devBuyFee = hookFeeOnBuy(DEV_BUY, FEE_BPS);
check((await treasuryBalance()) - treasuryAtStart === devBuyFee, `the dev buy inside the launch already paid the hook ${fmt(devBuyFee)} SOL (2.5% of what was left after the protocol fee)`);
if (treasuryOwner.equals(dev.publicKey)) check(await client.exists(treasury), "the launch left the launcher's wrapped SOL account open: it is the fee receiver");
const info = await client.hookInfo(p);
check(info.template === "custom" && info.upgradeAuthority === null, "the SDK describes it as a custom hook with no upgrade authority");
console.log(`  a site would show: ${info.summary.sentences.join(" ")}`);

// ---- 4. a stranger trades --------------------------------------------------------------
const hookRef = await client.hookRef(p, trader.publicKey);
check(hookRef.extra.length === 1 && hookRef.extra[0].pubkey.equals(cfg), "the SDK resolved the hook's extra account (its config) from the list on chain");
check(hookRef.extra[0].isSigner === false && hookRef.extra[0].isWritable === false, "resolved as read-only and not a signer");
async function trade(label, direction, amountIn) {
  p = await client.pool(pool);
  const quote = await client.quoteOnChain(trader.publicKey, p, direction, amountIn);
  const before = await treasuryBalance();
  const sig = await sendIxs(await client.swapInstructions(trader.publicKey, p, await client.hookRef(p, trader.publicKey), direction, amountIn, quote), [trader], label);
  const t = await txInfo(sig);
  return { quote, paid: (await treasuryBalance()) - before, event: t.swapped[0], cu: t.cu, pool: t.pool, hook: t.hook };
}
const buy = await trade("the trader buys for 0.5 SOL", DIRECTION.BUY, sol(0.5));
check(buy.paid === hookFeeOnBuy(sol(0.5), FEE_BPS), `the hook's fee reached the fee receiver: ${fmt(buy.paid)} SOL`);
check(buy.event && buy.event.hookFee === buy.paid && buy.event.feeBpsApplied === 100, "the pool's Swapped event says the same hook fee, and the pool's own 1% fee");
check((await client.tokenBalance(trader.publicKey, mint.publicKey)) === buy.quote, "the trader received exactly the simulated quote");

const coins = await client.tokenBalance(trader.publicKey, mint.publicKey);
const sell = await trade("the trader sells half of the coins", DIRECTION.SELL, coins / 2n);
check(sell.paid > 0n && sell.event.hookFee === sell.paid, `a sell pays the hook too, in SOL: ${fmt(sell.paid)} SOL`);
check(feeCeil(sell.event.amountOut + sell.event.hookFee, FEE_BPS) === sell.paid, "on a sell the fee is 2.5% of what the curve pays out, rounded up");
check(sell.event.amountOut === sell.quote, "the trader received exactly the simulated quote");

// ---- 5. frozen code, moving settings ---------------------------------------------------
// The program can never change, but the accounts it owns can, as far as its code allows.
await sendIxs([setFee(100)], [dev], "the config's owner lowers the hook fee to 1% (the program is frozen, its config is not)");
const buy2 = await trade("the trader buys for 0.2 SOL", DIRECTION.BUY, sol(0.2));
check(buy2.paid === hookFeeOnBuy(sol(0.2), 100), `this buy paid 1%: ${fmt(buy2.paid)} SOL`);
const refusal = await sendRefused([setFee(CEILING_BPS + 1)], [dev], "a fee above the ceiling fixed at creation");
check(refusal.includes("AboveCeiling"), "refused by the hook's own rule, by name: AboveCeiling");

p = await client.pool(pool);
check(p.hookFeesQuoteTotal === devBuyFee + buy.paid + sell.paid + buy2.paid && p.hookFeesOwedQuote === 0n, `the pool's own count of hook fees agrees: ${fmt(p.hookFeesQuoteTotal)} SOL charged, nothing left waiting`);

console.log(`\nhook program ${hookProgram.toBase58()}`);
console.log(`pool         ${pool.toBase58()}`);
console.log(`coin         ${mint.publicKey.toBase58()}`);
console.log(`compute units, whole transaction: launch ${launchInfo.cu}, buy ${buy.cu}, sell ${sell.cu}`);
console.log(`compute units, the swap instruction alone: buy ${buy.pool.units}, sell ${sell.pool.units}; of which the hook's callback: ${buy.hook.units} and ${sell.hook.units}`);
console.log(`call level of the hook: ${buy.hook.level} in a swap (pool, hook), ${launchInfo.hook.level} in the launch (launchpad, pool, hook)`);
console.log("custom hook e2e passed");
