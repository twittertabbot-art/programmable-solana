// The approved list on a real validator (HOOKS.md section 6.1), end to end.
//
//   node scripts/e2e-approvals.mjs localnet <HOOK_PROGRAM_ID>
//
// The hook is the UNCHANGED program of hook-template/, deployed frozen with
// hook-template/scripts/deploy-freeze.sh (it prints the program id), as for e2e-custom.mjs.
// The platform admin of the local chain switches the rule, through scripts/hook-approval.mjs
// (so that script is rehearsed too). What it shows, in order:
//   1. rule on: the SDK refuses a launch on the hook before building anything, and the chain
//      refuses a pool on it (HookNotApproved, 6052);
//   2. approved: scripts/e2e-custom.mjs launches a coin on it and trades both ways;
//   3. revoked: a new pool is refused again, and the coin launched in step 2 still trades;
//   4. the rule off and the list empty again, as the chain was found.
// Local chain only: it changes the platform's settings.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { HookpoolClient, HookApprovalRefusal, NATIVE_MINT, DIRECTION, ix, pda, poolKeys, approvalErrorFromLogs } from "../sdk/dist/index.js";
import { connection } from "./cluster.mjs";

const cluster = process.argv[2];
if (cluster !== "localnet") { console.error("usage: node scripts/e2e-approvals.mjs localnet <HOOK_PROGRAM_ID>\nIt changes the platform's settings: a local chain only."); process.exit(1); }
let hook;
try { hook = new PublicKey(process.argv[3] ?? ""); } catch { console.error("usage: node scripts/e2e-approvals.mjs localnet <HOOK_PROGRAM_ID>"); process.exit(1); }

const conn = connection(cluster);
const client = new HookpoolClient(conn);
const here = fileURLToPath(new URL(".", import.meta.url));
const stop = (m) => { console.error("CHECK FAILED: " + m); process.exit(1); };
const check = (c, m) => { if (!c) stop(m); console.log("  check  " + m); };
const admin = (...args) => execFileSync(process.execPath, [here + "hook-approval.mjs", cluster, ...args, "--yes"], { encoding: "utf8" });
const custom = () => execFileSync(process.execPath, [here + "e2e-custom.mjs", cluster, hook.toBase58()], { encoding: "utf8", maxBuffer: 1 << 24 });

const start = await client.platform();
check(!!start, "the platform is initialised");
if (start.approvedHooks.length || start.hookApprovalRequired) console.log("  note   the chain already had the rule on or a list; the rehearsal puts the rule off and takes its hook off at the end");

// a raw create_pool on the hook, built with the low-level builder (no SDK check), for the chain
// to judge: a real coin and real wrapped SOL, so that every account passes and the program's
// own hook check is what answers
async function rawPool() {
  const maker = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(maker.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
  const mint = await createMint(conn, maker, maker.publicKey, null, 6);
  const coins = await getOrCreateAssociatedTokenAccount(conn, maker, mint, maker.publicKey);
  await mintTo(conn, maker, mint, coins.address, maker, 1_000_000_000_000n);
  const k = poolKeys(mint, NATIVE_MINT);
  const wsol = pda.ata(maker.publicKey, NATIVE_MINT);
  const tx = new Transaction().add(
    ix.createAtaIdempotent(maker.publicKey, maker.publicKey, NATIVE_MINT),
    ix.transferLamports(maker.publicKey, wsol, BigInt(LAMPORTS_PER_SOL)),
    ix.syncNative(wsol),
    ix.createPool(maker.publicKey, maker.publicKey, k, { program: hook, treasury: wsol, extra: [] }, { lpFeeBps: 30, baseAmount: 1_000_000_000_000n, quoteAmount: BigInt(LAMPORTS_PER_SOL) }),
  );
  try { await sendAndConfirmTransaction(conn, tx, [maker], { commitment: "confirmed", skipPreflight: false }); return { ok: true }; }
  catch (e) {
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null) ?? [String(e.message)];
    return { ok: false, logs };
  }
}

console.log("1. the rule on, the hook not listed");
admin("rule", "on");
check((await client.platform()).hookApprovalRequired, "the platform holds the rule on");
const a1 = await client.hookApproval(hook);
check(!a1.allowed && !a1.approved && !a1.own && a1.required, "the SDK reads the hook as not allowed");
let refused = null;
try {
  await client.launchInstructions({ dev: Keypair.generate().publicKey, mint: Keypair.generate(), name: "Nope", symbol: "NOPE", uri: "https://example.invalid/n.json", decimals: 6, totalSupply: 1_000_000_000_000_000n,
    quoteMint: NATIVE_MINT, lpFeeBps: 30, devBuyQuote: 0n, minDevBuyOut: 0n, curve: true, template: "custom", custom: { program: hook } });
} catch (e) { refused = e; }
check(refused instanceof HookApprovalRefusal && refused.number === 6052, "the SDK refuses the launch before building it (HookApprovalRefusal 6052)");
const r1 = await rawPool();
check(!r1.ok && approvalErrorFromLogs(r1.logs)?.name === "HookNotApproved", "the chain refuses a pool on it: HookNotApproved");

console.log("2. approved: a coin launches on it and trades");
const out = admin("approve", hook.toBase58());
check(/ok  APPROVE/.test(out), "scripts/hook-approval.mjs approved it");
const p2 = await client.platform();
check(p2.approvedHooks.some((k) => k.equals(hook)), "the hook is on the list");
check((await client.hookApproval(hook)).allowed, "the SDK reads it as allowed");
const run = custom();
check(/check/.test(run) && !/CHECK FAILED/.test(run), "scripts/e2e-custom.mjs launched a coin on it and traded");
const pools = (await client.allPools()).filter((p) => p.hookProgram.equals(hook));
check(pools.length >= 1, `the chain has ${pools.length} pool(s) on the hook`);
const pool = pools.sort((a, b) => Number(b.createdSlot - a.createdSlot))[0];

console.log("3. revoked: new pools refused, the coin from step 2 still trades");
check(/ok  REVOKE/.test(admin("revoke", hook.toBase58())), "scripts/hook-approval.mjs revoked it");
check(!(await client.platform()).approvedHooks.some((k) => k.equals(hook)), "the hook is off the list");
const r3 = await rawPool();
check(!r3.ok && approvalErrorFromLogs(r3.logs)?.name === "HookNotApproved", "a new pool on it is refused again");
const trader = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(trader.publicKey, 3 * LAMPORTS_PER_SOL), "confirmed");
const fresh = await client.pool(pool.address);
const amountIn = LAMPORTS_PER_SOL / 10;
const q = await client.quoteOnChain(trader.publicKey, fresh, DIRECTION.BUY, BigInt(amountIn));
const buy = await client.swapInstructions(trader.publicKey, fresh, await client.hookRef(fresh, trader.publicKey), DIRECTION.BUY, BigInt(amountIn), q);
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...buy), [trader], { commitment: "confirmed" });
check(!!sig, "a buy on the coin launched in step 2 went through after the revoke");

console.log("4. as the chain was found");
admin("rule", "off");
const end = await client.platform();
check(!end.hookApprovalRequired, "the rule is off again");
check(!end.approvedHooks.some((k) => k.equals(hook)), "the hook is not on the list");
console.log("ALL APPROVAL CHECKS PASSED");
