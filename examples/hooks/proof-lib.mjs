// Shared by the proof scripts of the example hooks (early-bird/prove.mjs and
// loyalty-points/prove.mjs): wallets, sending, reading transactions back, and the launch
// of a coin on a third-party hook through the launchpad.
//
// Everything here uses only @solana/web3.js and the Programmable SDK of this repository
// (sdk/dist, built with `npm install` and `npm run sdk` at the repository root).
//
// Environment:
//   RPC          the chain to talk to. Default http://127.0.0.1:8899 (the local validator)
//   WALLET_DIR   a folder of your own for the wallets of the run. Without it every wallet
//                is created when the script starts and forgotten when it ends. With it a
//                wallet named X is read from <folder>/X.json, and created there on the
//                first run, so a second run trades with the same wallets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const sdkFile = new URL("../../sdk/dist/index.js", import.meta.url);
if (!existsSync(fileURLToPath(sdkFile))) {
  console.error("The SDK is not built (sdk/dist/index.js is missing). At the repository root run:\n  npm install\n  npm run sdk");
  process.exit(1);
}
/// The Programmable SDK of this repository.
export const sdk = await import(sdkFile.href);
const { HookpoolClient, NATIVE_MINT, DIRECTION, PROGRAMS, pda, eventsFromTransaction, feeCeil, constantProductOut } = sdk;

export const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
export const conn = new Connection(RPC, "confirmed");
export const client = new HookpoolClient(conn);

/// The program id of an example hook: `arg` when given, else the id its source declares.
/// The build script writes the id of the program keypair into `declare_id!` before every
/// build, so after a deploy the source names the deployed program.
export function programIdOf(exampleUrl, programName, arg) {
  if (arg) return new PublicKey(arg);
  const source = readFileSync(new URL(`./programs/${programName}/src/lib.rs`, exampleUrl), "utf8");
  const m = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(source);
  if (!m) throw new Error("no declare_id! in the source of " + programName);
  return new PublicKey(m[1]);
}

/// A wallet for this run holding at least `minSol`. See WALLET_DIR above. The secret key
/// is never printed.
export async function wallet(name, minSol) {
  let kp;
  const dir = process.env.WALLET_DIR;
  if (dir) {
    const file = path.join(dir, name + ".json");
    if (existsSync(file)) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
    else {
      kp = Keypair.generate();
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    }
  } else kp = Keypair.generate();
  const have = await conn.getBalance(kp.publicKey, "confirmed");
  const want = Math.round(minSol * LAMPORTS_PER_SOL);
  if (have < want) {
    try { await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, want - have), "confirmed"); }
    catch (e) { console.error(`The airdrop to the wallet "${name}" failed (${e.message}). A local validator always grants one; on another chain fund ${kp.publicKey.toBase58()} yourself and set WALLET_DIR.`); process.exit(1); }
  }
  return kp;
}

/// Anchor instruction discriminator: sha256("global:<name>")[..8].
export const disc = (name) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
export const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
export const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

export const sol = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/// JSON with big numbers and addresses made readable.
export const show = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v && v.toBase58 ? v.toBase58() : v));

let failures = 0;
let passes = 0;
export function check(cond, msg) {
  if (cond) { passes += 1; console.log("  check  " + msg); }
  else { failures += 1; console.log("  CHECK FAILED  " + msg); }
  return cond;
}
export function done(title) {
  console.log(failures === 0 ? `${title}: all ${passes} checks passed` : `${title}: ${failures} CHECK(S) FAILED, ${passes} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

/// Send instructions as one transaction and wait for it. A failure prints the logs and
/// ends the script.
export async function send(ixs, signers, label, opts = {}) {
  const tx = new Transaction();
  if (opts.cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu }));
  tx.add(...ixs);
  tx.feePayer = signers[0].publicKey;
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    console.log(`  ok  ${label}`);
    return sig;
  } catch (e) {
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null);
    console.error(`  FAILED ${label}`);
    console.error(logs ? logs.join("\n") : e.message);
    process.exit(1);
  }
}

/// A confirmed transaction: its slot, logs, compute units, the programs it invoked and
/// the Programmable events inside it.
export async function txInfo(sig) {
  let tx = null;
  for (let i = 0; i < 40 && !tx; i++) {
    tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx) await sleep(250);
  }
  if (!tx) throw new Error("transaction not found " + sig);
  const logs = tx.meta?.logMessages ?? [];
  // Which program was invoked at which call level, and what each invocation used, from
  // the "invoke [level]" and "consumed N of M compute units" lines of the logs.
  const invoked = [];
  const consumed = [];
  const stack = [];
  for (const l of logs) {
    let m;
    if ((m = /^Program (\S+) invoke \[(\d+)\]/.exec(l))) { const call = { program: m[1], depth: Number(m[2]) }; invoked.push(call); stack.push(call); }
    else if ((m = /^Program (\S+) consumed (\d+) of \d+ compute units/.exec(l))) consumed.push({ program: m[1], units: Number(m[2]), depth: stack.length ? stack[stack.length - 1].depth : 0 });
    else if (/^Program \S+ (success|failed)/.test(l)) stack.pop();
  }
  // The second argument of eventsFromTransaction is required: the base58 ids of the
  // programs whose events count.
  const events = eventsFromTransaction(tx, Object.values(PROGRAMS).map((k) => k.toBase58()));
  return { slot: tx.slot, logs, cu: tx.meta?.computeUnitsConsumed ?? null, invoked, consumed, events, swapped: events.find((e) => e.kind === "Swapped") ?? null };
}
export const wasInvoked = (info, program) => info.invoked.some((i) => i.program === program.toBase58());
/// Compute units one program used in a transaction, as its own log lines say, counted at
/// the outermost level it was called on (what it used includes what it called: for the
/// pool's swap that is the token transfers, the hook and the event). The call level is
/// returned too: 1 = an instruction of the transaction itself.
export function unitsAndDepth(info, program) {
  const mine = info.consumed.filter((c) => c.program === program.toBase58());
  if (mine.length === 0) return { units: 0, depth: null };
  const depth = Math.min(...mine.map((c) => c.depth));
  return { units: mine.filter((c) => c.depth === depth).reduce((a, c) => a + c.units, 0), depth };
}
export const unitsOf = (info, program) => unitsAndDepth(info, program).units;
/// What a hook's callbacks used inside the pool's swap: the hook's invocations one call
/// level below the pool's. An instruction of the hook that the same transaction carries
/// on its own (an `open_points` in front of the buy) is not counted.
export function callbackUnits(info, hookProgram) {
  const pool = unitsAndDepth(info, PROGRAMS.hookpool);
  if (pool.depth === null) return { units: 0, depth: null };
  const mine = info.consumed.filter((c) => c.program === hookProgram.toBase58() && c.depth === pool.depth + 1);
  return { units: mine.reduce((a, c) => a + c.units, 0), depth: mine.length ? pool.depth + 1 : null };
}

/// Launch a coin on a third-party hook through the launchpad, with the SDK.
/// `makeSetup(pool)` returns the hook's own instructions that must run before the pool
/// exists (its per-pool config). Returns { mint, pool, createSig, launchSig }.
export async function launchOnHook({ dev, hookProgram, makeSetup, name, symbol, lpFeeBps = 100, quoteSol = 2, devBuySol = 0 }) {
  const mint = Keypair.generate();
  // The pool address is known before the pool exists: PDA ["pool", coin, quote].
  const pool = pda.pool(mint.publicKey, NATIVE_MINT);
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name, symbol, uri: "https://example.com/meta/" + symbol.toLowerCase() + ".json",
    decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
    quoteMint: NATIVE_MINT, lpFeeBps, quoteAmount: sol(quoteSol), devBuyQuote: sol(devBuySol), minDevBuyOut: devBuySol > 0 ? 1n : 0n,
    template: "custom", custom: { program: hookProgram, setup: makeSetup ? makeSetup(pool) : [] },
  });
  // Two transactions. The first is not undone when the second is refused.
  const createSig = await send(plan.createTx, [dev, ...plan.signers], `transaction 1: the coin ${symbol} and the hook's per-pool config`);
  const launchSig = await send(plan.launchTx, [dev], `transaction 2: the pool of ${symbol} on hook ${hookProgram.toBase58()}`);
  return { mint: mint.publicKey, pool, createSig, launchSig };
}

/// The pool fee a swap paid, recomputed from the Pool account before and after it,
/// without trusting any event. The input reserve grows by what the trader sent minus
/// the protocol fee and minus a hook fee taken on the way in; the output reserve shrinks
/// by the gross amount out. Exactly one whole number of bps makes x*y=k give that gross
/// amount. Returns { addedIn, grossOut, lpFee, bps }, with bps null when no value fits.
export function feeFromReserves(before, after, direction) {
  const buy = direction === DIRECTION.BUY;
  const rIn = buy ? before.reserveQuote : before.reserveBase;
  const rOut = buy ? before.reserveBase : before.reserveQuote;
  const addedIn = (buy ? after.reserveQuote : after.reserveBase) - rIn;
  const grossOut = rOut - (buy ? after.reserveBase : after.reserveQuote);
  const fits = [];
  for (let bps = 0; bps <= 10000; bps++) {
    const fee = feeCeil(addedIn, bps);
    if (fee >= addedIn) break;
    if (constantProductOut(addedIn - fee, rIn, rOut) === grossOut) fits.push(bps);
  }
  const bps = fits.length === 1 ? fits[0] : null;
  return { addedIn, grossOut, bps, lpFee: bps === null ? null : feeCeil(addedIn, bps) };
}

export { Keypair, PublicKey, SystemProgram, TransactionInstruction, LAMPORTS_PER_SOL };
