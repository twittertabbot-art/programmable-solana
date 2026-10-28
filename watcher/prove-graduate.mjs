#!/usr/bin/env node
// Live proof of the graduate crank, on the local validator only (it airdrops).
//
//   node watcher/prove-graduate.mjs                  launches a coin on the curve, buys it past its graduation target
//                                                    without graduating it, then runs the watcher on it
//   node watcher/prove-graduate.mjs --pool <pool>    use an open pool on the curve that exists instead of launching
//                                                    one (it must stand under its target and nobody else may trade it)
//
// What it does, with fresh wallets that exist only in this run:
//   1. It launches a coin on the curve through the SDK: the whole supply in the pool, no SOL from the creator.
//   2. A trader buys 40 SOL of it. The pool stays on the curve, under its target of 85 SOL.
//   3. It runs the real watcher (node index.mjs --once --pool <pool>) one round at a time, with its state and
//      status files in a temporary folder, and reads the chain after every round:
//        round 1   under the target: the keeper sends nothing for the pool. The pool report carries the curve as the
//                  chain holds it, with a clean verdict.
//      Then the trader buys past the target with a swap the SDK builds WITHOUT graduate (`graduate: false`), the
//      way a trade built without the SDK would: the pool stands past its target and still trades on the curve.
//        round 2   with GRADUATE_KEEPER=off: the keeper sends nothing; the report says somebody else must graduate.
//        round 3   the crank on: the keeper sends one graduate. The pool graduated, the price held to within one unit
//                  of the coin, the burn is the program's formula, the supply fell by it. The watcher's line and its
//                  alert say so.
//        round 4   at once: nothing more is sent for the pool.
//   4. The trader sells on the graduated pool.
//
// The only key file it opens is the watcher's own probe keypair, to learn the keeper's public address. It never
// prints a secret. The coin is throwaway: nothing is cleaned up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, NATIVE_MINT, NO_HOOK, PROGRAMS, IX, CURVE_OPEN, CURVE_GRADUATED, eventsFromTransaction } from "../sdk/dist/index.js";
import { loadConfig, WATCHER_DIR, REPO_DIR } from "./lib/config.mjs";

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const given = argOf("--pool");

const { cfg } = loadConfig([], process.env);
if (cfg.cluster !== "localnet" || !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(cfg.rpcUrl)) {
  console.error(`this proof airdrops, so it runs on the local validator only (cluster ${cfg.cluster}, rpc ${cfg.rpcUrl})`);
  process.exit(2);
}
const conn = new Connection(cfg.rpcUrl, "confirmed");
const altFile = path.join(REPO_DIR, "web", "deployments", "localnet-alt.json");
const lookupTable = fs.existsSync(altFile) ? new PublicKey(JSON.parse(fs.readFileSync(altFile, "utf8")).lookupTable) : undefined;
const client = new HookpoolClient(conn, lookupTable ? { lookupTable } : {});
if (!fs.existsSync(cfg.probeKeypair)) { console.error(`no keeper keypair at ${cfg.probeKeypair}: run the watcher once first (node index.mjs --once)`); process.exit(2); }
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(cfg.probeKeypair, "utf8")))).publicKey;
const platform = await client.platform();
if (!platform) { console.error("Programmable is not set up on this validator: run `node scripts/init-platform.mjs localnet` first"); process.exit(2); }
if (!platform.curveEnabled) { console.error("curve launches are off on this platform: the admin sets them with scripts/init-platform.mjs"); process.exit(2); }
const OURS = Object.values(PROGRAMS).map((p) => p.toBase58());

const say = (s = "") => console.log(s);
const step = (s) => console.log(`\n== ${s}`);
let checks = 0;
const check = (cond, msg) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); checks += 1; console.log(`  check  ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9);
const lamportsOf = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const startsWith = (data, disc) => data.length >= disc.length && disc.every((b, i) => data[i] === b);

async function fund(pubkey, lamports) {
  const sig = await conn.requestAirdrop(pubkey, Number(lamports));
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}
async function send(ixs, signers, label) {
  const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
  tx.sign(signers);
  const signature = await conn.sendTransaction(tx, { skipPreflight: false });
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)}`);
  say(`  sent   ${label}: ${signature}`);
  return signature;
}
async function getTx(signature) {
  for (let i = 0; i < 30; i++) {
    const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx && tx.meta) return tx;
    await sleep(200);
  }
  throw new Error(`transaction ${signature} not found`);
}
/// The instructions of a landed transaction, by program and discriminator.
function namesOf(tx) {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  return tx.transaction.message.compiledInstructions.map((ins) => {
    const program = keys.get(ins.programIdIndex);
    const d = Buffer.from(ins.data);
    if (!program.equals(PROGRAMS.hookpool)) return program.toBase58().slice(0, 8);
    return startsWith(d, IX.hookpool.graduate) ? "graduate" : startsWith(d, IX.hookpool.swap) ? "swap" : "hookpool";
  });
}

// ---- the watcher -----------------------------------------------------------------------------------------

/// Run the real watcher once, on one pool, and return what it printed.
function runWatcher(pool, tmp, extraEnv = {}) {
  const env = { ...process.env, STATE_FILE: path.join(tmp, "state.json"), STATUS_FILE: path.join(tmp, "pools.json"), ...extraEnv };
  const r = spawnSync(process.execPath, ["index.mjs", "--once", "--pool", pool.toBase58()], { cwd: WATCHER_DIR, env, encoding: "utf8", timeout: 180000 });
  const lines = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n");
  const shown = lines.filter((l) => /^\d{4}-\d\d-\d\dT/.test(l) && (/ graduate: | graduate done: | graduate totals: | graduate FAILED: | graduate crank off| graduateCrank /.test(l) || (/ALERT| warn | error /.test(l) && l.includes(pool.toBase58()))));
  for (const l of shown) say(`    ${l}`);
  let entry = null;
  const start = (r.stdout ?? "").indexOf("\n{\n");
  if (start >= 0) { try { entry = JSON.parse(r.stdout.slice(start)); } catch { entry = null; } }
  return { status: r.status, lines, entry };
}
/// The keeper's transactions newer than `lastSeen`, oldest first, with what each did to the keeper's balance.
async function keeperTxsSince(lastSeen) {
  const sigs = await conn.getSignaturesForAddress(keeper, lastSeen ? { until: lastSeen } : { limit: 50 }, "confirmed");
  const out = [];
  for (const s of sigs.reverse()) {
    const tx = await getTx(s.signature);
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).keySegments().flat();
    const at = keys.findIndex((k) => k.equals(keeper));
    out.push({
      signature: s.signature, slot: BigInt(tx.slot), paidByKeeper: at === 0, fee: at === 0 ? tx.meta.fee : 0, delta: at >= 0 ? tx.meta.postBalances[at] - tx.meta.preBalances[at] : 0,
      cu: tx.meta.computeUnitsConsumed, size: tx.transaction.message.serialize().length + 1 + 64 * tx.transaction.signatures.length,
      events: eventsFromTransaction(tx, OURS), names: namesOf(tx), touches: (key) => keys.some((k) => k.equals(key)), err: tx.meta.err,
    });
  }
  return out;
}
/// One round of the real watcher on the pool, and what the keeper did in it.
async function watcherRound(pool, tmp, label, extraEnv = {}) {
  const last = (await conn.getSignaturesForAddress(keeper, { limit: 1 }, "confirmed"))[0];
  const keeperBefore = await conn.getBalance(keeper);
  say(`  the watcher, ${label}. Its lines about the graduate crank:`);
  const run = runWatcher(pool, tmp, extraEnv);
  check(run.status === 0, "the watcher finished with exit code 0");
  const txs = await keeperTxsSince(last ? last.signature : null);
  const keeperAfter = await conn.getBalance(keeper);
  const moved = txs.reduce((n, t) => n + t.delta, 0);
  check(keeperAfter - keeperBefore === moved, `the keeper's SOL balance moved by the sum of its ${txs.length} transaction(s) of this round: ${signed(moved)} lamports`);
  return { run, txs, mine: txs.filter((t) => t.paidByKeeper && t.touches(pool)) };
}

/// The price of a pool as two integers, effective quote over base: compared by cross-multiplying, never rounded.
const priceOf = (p) => ({ quote: p.reserveQuote + p.virtualQuote, base: p.reserveBase });

// ---- the scene -------------------------------------------------------------------------------------------

step(`graduate crank proof on ${cfg.rpcUrl}`);
say(`  keeper (the watcher's probe wallet): ${keeper.toBase58()}`);
say(`  platform: curve launches on, ${sol(platform.curveVirtualQuote)} SOL of virtual SOL, graduation at ${sol(platform.curveGraduationTarget)} SOL of real SOL, fee ${platform.curveGraduationFeeBps} bps`);
if ((await conn.getBalance(keeper)) < LAMPORTS_PER_SOL / 2) { await fund(keeper, LAMPORTS_PER_SOL); say("  keeper was low: airdropped 1 SOL"); }

let failure = null;
let tmp = null;
try {
  step("1. a coin on the curve");
  let address;
  if (given) address = new PublicKey(given);
  else {
    const dev = Keypair.generate(); const mint = Keypair.generate();
    await fund(dev.publicKey, LAMPORTS_PER_SOL);
    const plan = await client.launchInstructions({
      dev: dev.publicKey, mint, name: "Keeper Graduate Proof", symbol: "KGP", uri: "https://example.com/meta/kgp.json", decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
      quoteMint: NATIVE_MINT, lpFeeBps: 100, curve: true, devBuyQuote: 0n, minDevBuyOut: 0n, template: "none",
    });
    await send(plan.createTx, [dev, mint], "launch the coin KGP: the coin");
    await send(plan.launchTx, [dev], "launch the coin KGP: the pool on the curve, no SOL from the creator");
    address = plan.pool;
  }
  const p0 = await client.pool(address);
  check(!!p0 && p0.curveState === CURVE_OPEN && p0.reserveQuote < p0.graduationTarget, `pool ${address.toBase58()} is on the curve: ${sol(p0.reserveQuote)} SOL of real SOL, ${sol(p0.virtualQuote)} SOL virtual, graduation at ${sol(p0.graduationTarget)} SOL`);
  const target = p0.graduationTarget;

  step("2. a trader buys under the target");
  const trader = Keypair.generate();
  await fund(trader.publicKey, target + lamportsOf(20));
  const under = target / 2n - p0.reserveQuote > 0n ? target / 2n - p0.reserveQuote : lamportsOf(1);
  const q1 = await client.quoteLocal(p0, platform, DIRECTION.BUY, under);
  await send(await client.swapInstructions(trader.publicKey, p0, NO_HOOK, DIRECTION.BUY, under, (q1.amountOut * 99n) / 100n), [trader], `the trader buys for ${sol(under)} SOL`);
  const p1 = await client.pool(address);
  check(p1.curveState === CURVE_OPEN && p1.reserveQuote < target, `the pool holds ${sol(p1.reserveQuote)} SOL of real SOL, under its target`);

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-graduate-proof-"));

  // ---- round 1: under the target
  const r1 = await watcherRound(address, tmp, "round 1, under the target");
  check(r1.mine.length === 0, "round 1: the keeper sent nothing for this pool");
  const e1 = r1.run.entry;
  const supply1 = (await client.mint(p1.baseMint)).supply;
  check(!!e1 && !!e1.curve && e1.curve.state === "open" && e1.curve.raised === p1.reserveQuote.toString() && e1.curve.target === target.toString() && e1.curve.virtualQuote === p1.virtualQuote.toString()
    && e1.curve.raisedBps === Number((p1.reserveQuote * 10_000n) / target) && e1.curve.soldBps === Number(((supply1 - p1.reserveBase) * 10_000n) / supply1) && e1.curve.graduates === false,
    `the pool report carries the curve as the chain holds it: ${JSON.stringify(e1 && e1.curve)}`);
  check(e1.score === "clean" && e1.buySim.ok && e1.effectiveBuyTaxBps === 0, `a clean verdict, no false alarm: score ${e1.score}, buy probe ${e1.buySim.amountOut}, effective buy tax ${e1.effectiveBuyTaxBps} bps, sell ${e1.sellSim.ok ? `ok, tax ${e1.effectiveSellTaxBps} bps` : e1.sellSim.error}`);
  check(e1.notes.some((n) => n.startsWith("This coin is on the curve.")), "its notes say it in words: " + e1.notes.find((n) => n.startsWith("It holds")));

  // ---- past the target, without graduate
  step("the trader buys past the target with a swap built without graduate");
  const past = target - p1.reserveQuote + lamportsOf(2);
  const q2 = await client.quoteLocal(p1, platform, DIRECTION.BUY, past);
  check(q2.graduates === true, `a buy of ${sol(past)} SOL takes the pool past its target: the SDK would append graduate`);
  const ixs = await client.swapInstructions(trader.publicKey, p1, NO_HOOK, DIRECTION.BUY, past, (q2.amountOut * 99n) / 100n, { graduate: false });
  check(!ixs.some((i) => i.programId.equals(PROGRAMS.hookpool) && startsWith(Buffer.from(i.data), IX.hookpool.graduate)), "with graduate: false the SDK builds the swap alone");
  const sig2 = await send(ixs, [trader], `the trader buys for ${sol(past)} SOL, no graduate`);
  const t2 = await getTx(sig2);
  const p2 = await client.pool(address);
  check(!eventsFromTransaction(t2, OURS).some((e) => e.kind === "Graduated") && !namesOf(t2).includes("graduate") && p2.curveState === CURVE_OPEN && p2.reserveQuote >= target && p2.virtualQuote === p0.virtualQuote,
    `the pool stands past its target and is still on the curve: ${sol(p2.reserveQuote)} SOL of real SOL, ${sol(p2.virtualQuote)} SOL virtual`);

  // ---- round 2: the crank switched off
  const r2 = await watcherRound(address, tmp, "round 2, with GRADUATE_KEEPER=off", { GRADUATE_KEEPER: "off" });
  check(r2.mine.length === 0 && (await client.pool(address)).curveState === CURVE_OPEN, "round 2: the crank is off, the keeper sent nothing for this pool, the pool is still on the curve");
  check(r2.run.lines.some((l) => l.includes("graduateCrank  off (--no-graduate or GRADUATE_KEEPER=off)")) && r2.run.lines.some((l) => l.includes("graduate crank off: no graduate is sent")), "the watcher says at its start that the crank is off, and again in place of the pass");
  const e2 = r2.run.entry;
  check(!!e2 && e2.curve.graduates === true && e2.curve.raisedBps === 10000 && e2.notes.includes("The pool stands past its graduation target. Anyone may send graduate. This watcher runs without the graduate crank, so somebody else must."),
    "the pool report says the pool waits for graduate and that somebody else must send it");

  // ---- round 3: the crank on
  const before = await client.pool(address);
  const supplyBefore = (await client.mint(before.baseMint)).supply;
  const r3 = await watcherRound(address, tmp, "round 3, the crank on");
  check(r3.mine.length === 1 && !r3.mine[0].err, `round 3: the keeper sent one transaction for this pool: ${r3.mine[0] ? r3.mine[0].signature : "none"}`);
  const g = r3.mine[0];
  const ev = g.events.find((e) => e.kind === "Graduated");
  check(g.names.filter((n) => n === "graduate").length === 1 && !g.names.includes("swap") && !!ev && ev.pool.equals(address), `that transaction holds one graduate (${g.names.join(", ")}) and the chain's Graduated event`);
  const after = await client.pool(address);
  check(after.curveState === CURVE_GRADUATED && after.virtualQuote === 0n && after.graduationTarget === 0n, "the pool graduated: its virtual SOL is gone");
  // the program's formula, by hand
  const wanted = (target * BigInt(before.graduationFeeBps)) / 10_000n;
  const fee = wanted < before.reserveQuote - 1n ? wanted : before.reserveQuote - 1n;
  const quoteAfter = before.reserveQuote - fee;
  const baseAfter = (quoteAfter * before.reserveBase) / (before.reserveQuote + before.virtualQuote);
  check(ev.reserveQuoteBefore === before.reserveQuote && ev.reserveBaseBefore === before.reserveBase && ev.reserveQuoteAfter === quoteAfter && ev.reserveBaseAfter === baseAfter && ev.burnedBase === before.reserveBase - baseAfter && ev.feeQuote === fee
    && after.reserveQuote === quoteAfter && after.reserveBase === baseAfter,
    `the burn is the program's formula: ${ev.burnedBase} raw coins burned, fee ${fee} lamports; the pool holds ${sol(after.reserveQuote)} SOL and ${after.reserveBase} raw coins`);
  const pb = priceOf(before); const pa = priceOf(after);
  check(pa.quote * pb.base >= pb.quote * pa.base && pa.quote * pb.base < pb.quote * (pa.base + 1n),
    `the price held: ${pb.quote}/${pb.base} before, ${pa.quote}/${pa.base} after, never lower, and higher by less than one unit of the coin (${(Number(pb.quote) / Number(pb.base)).toPrecision(12)} and ${(Number(pa.quote) / Number(pa.base)).toPrecision(12)} lamports per raw unit)`);
  const supplyAfter = (await client.mint(before.baseMint)).supply;
  check(supplyBefore - supplyAfter === ev.burnedBase, `the coin's supply fell by the burn: ${supplyBefore} to ${supplyAfter}`);
  check(g.fee === 5000 && g.delta === -5000 && g.size <= 1232, `that transaction is ${g.size} bytes, used ${g.cu} compute units and cost the keeper its fee of ${g.fee} lamports, nothing else`);
  check(r3.run.lines.some((l) => l.includes(`graduate: pool ${address.toBase58()}: graduated with ${ev.reserveQuoteBefore} lamports of real SOL raised, burned ${ev.burnedBase} raw coins to keep the price`)), "the watcher's own line carries the numbers");
  check(r3.run.lines.some((l) => l.includes("ALERT") && l.includes(address.toBase58()) && l.includes("graduated from the curve")), "and its alert line says the coin graduated");
  const e3 = r3.run.entry;
  check(!!e3 && e3.curve.state === "graduated" && e3.curve.raised === after.reserveQuote.toString() && e3.curve.raisedBps === 10000 && e3.curve.graduates === false && e3.score === "clean", `the pool report after it: ${JSON.stringify(e3 && e3.curve)}, score ${e3 && e3.score}`);

  // ---- round 4: nothing more
  const r4 = await watcherRound(address, tmp, "round 4, at once");
  check(r4.mine.length === 0, "round 4: the keeper sent nothing more for this pool: one graduate, once");

  step("4. trades on the graduated pool");
  const coins = await client.tokenBalance(trader.publicKey, after.baseMint);
  const q4 = await client.quoteLocal(after, platform, DIRECTION.SELL, coins / 2n);
  await send(await client.swapInstructions(trader.publicKey, after, NO_HOOK, DIRECTION.SELL, coins / 2n, (q4.amountOut * 99n) / 100n), [trader], "the trader sells half its coins on the graduated pool");
  const p5 = await client.pool(address);
  check(p5.reserveQuote === after.reserveQuote - q4.amountOutGross && p5.curveState === CURVE_GRADUATED, `the sell was paid ${q4.amountOut} lamports, as the SDK quoted, from a pool that holds real SOL only`);
} catch (e) {
  failure = e;
  console.error(String(e && e.message ? e.message : e));
}

if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder left behind is harmless */ } }

step("result");
if (failure) { say(`  FAILED after ${checks} checks.`); process.exit(1); }
say(`  ${checks} checks passed.`);
