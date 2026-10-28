// Sells as real holders. The buy probe runs from the watcher's own wallet and the sell probe as one large holder,
// and both wallets can be known to a hook in advance: a hostile hook could let them through and refuse everyone
// else. So for a pool whose hook runs on sells, when the pool's simulations are due and the sell probe went through,
// the pass also simulates a small sell (1% of the wallet's coins, at least 1 raw unit) as up to
// HOLDER_SIMS_PER_POOL wallets that bought on the pool lately and still hold the coin: the trades feed's file of the
// pool says who bought (status/trades, read from disk), one batched read says who still holds. Each simulation
// is the wallet's own sell, the wallet as fee payer, with signature checks off and the blockhash replaced by the
// RPC (no getLatestBlockhash). A sell that the HOOK refuses for one of them is an alert; a refusal any trade can
// meet (slippage, an account the wallet lacks, the wallet's SOL for the fee, a strict coin's lock) is not.
import fs from "node:fs";
import path from "node:path";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { CLOCK_SYSVAR, DIRECTION, IX, PROGRAMS, RULES_KIND, decodeHolderRecord, pda, rulesPda } from "../../sdk/dist/index.js";
import { hookRefFor, sellableHolders } from "./simulate.mjs";
import { FEED_VERSION, POOL_NAME } from "./feed.mjs";
import { plainText } from "./plain.mjs";

/// How many recent buyers one pool's batched read looks at, at most.
export const HOLDER_CANDIDATES = 20;
/// The blockhash a simulated transaction is compiled with; the RPC replaces it (replaceRecentBlockhash).
const ANY_BLOCKHASH = "11111111111111111111111111111111";
/// The pool program's refusals that a hook's answer causes: the hook asked for a power its flags do not grant,
/// answered bytes the pool cannot read, a curve it may not set, or a fee above what it may take.
const HOOK_CAUSED = new Set(["BadHookReturn", "HookPowerNotGranted", "HookCurveInvalid", "HookFeeTooHigh"]);
/// Anchor's account errors (3000 to 3999): the wallet lacks an account the program expects, never a choice.
const ACCOUNT_ERROR = (n) => n >= 3000 && n < 4000;
/// The rules of a strict coin that hold a sell by rule (the rules program): never the hook misbehaving.
const STRICT_RULES = new Set([6044, 6045, 6046, 6047]);

/// The wallets that bought on a pool lately, newest first, without doubles, from the pool's trades file (the
/// served file, else the part file of a pool that waits for its backfill). The hook's own buys are not a holder's.
/// `found` is false when there is no file for the pool (yet).
export function recentBuyersOf(dir, pool, { max = HOLDER_CANDIDATES, exclude = [] } = {}) {
  const name = typeof pool === "string" ? pool : pool.toBase58();
  if (!dir || !POOL_NAME.test(name)) return { found: false, buyers: [] };
  const skip = new Set(exclude.filter(Boolean).map((k) => (typeof k === "string" ? k : k.toBase58())));
  for (const file of [path.join(dir, `${name}.json`), path.join(dir, "part", `${name}.json`)]) {
    let f = null;
    try { f = JSON.parse(fs.readFileSync(file, "utf8")); } catch { f = null; }
    if (!f || f.version !== FEED_VERSION || !Array.isArray(f.events)) continue;
    const out = [];
    const seen = new Set(skip);
    for (const e of f.events) {
      if (!e || e.kind !== "Swapped" || e.byHook || Number(e.direction) !== DIRECTION.BUY || typeof e.user !== "string" || seen.has(e.user)) continue;
      seen.add(e.user);
      try { out.push(new PublicKey(e.user)); } catch { /* not an address */ }
      if (out.length >= max) break;
    }
    return { found: true, buyers: out };
  }
  return { found: false, buyers: [] };
}

/// Of `buyers`, the ones whose own token account of the coin holds coins, in the order given: one batched read of
/// their accounts (with, on a strict coin, the clock and their holder records, so that a wallet whose coins the
/// coin's early lock or creator lock hold is left out: its sell is refused by rule).
export async function holdingBuyers(connection, pool, buyers, { strictCfg = null } = {}) {
  if (!buyers.length) return [];
  const atas = buyers.map((o) => pda.ata(o, pool.baseMint, pool.baseTokenProgram));
  const strict = !!(strictCfg && strictCfg.kind === RULES_KIND.STRICT);
  const keys = strict ? [...atas, CLOCK_SYSVAR, ...buyers.map((o) => rulesPda.holder(pool.address, o))] : atas;
  const infos = await connection.getMultipleAccountsInfo(keys);
  const out = [];
  buyers.forEach((owner, i) => {
    const info = infos[i];
    if (!info || !info.data || info.data.length < 72) return;
    if (info.owner && typeof info.owner.equals === "function" && !info.owner.equals(pool.baseTokenProgram)) return;
    const d = Buffer.from(info.data);
    if (!new PublicKey(d.subarray(0, 32)).equals(pool.baseMint) || !new PublicKey(d.subarray(32, 64)).equals(owner)) return;
    const amount = d.readBigUInt64LE(64);
    if (amount > 0n) out.push({ owner, account: atas[i], amount });
  });
  if (!strict || !out.length) return out;
  const clock = infos[buyers.length] ? Buffer.from(infos[buyers.length].data) : null;
  if (!clock || clock.length < 40) return out;
  const records = new Map(buyers.map((o, i) => {
    const info = infos[buyers.length + 1 + i];
    let rec = null;
    if (info) { try { rec = decodeHolderRecord(new Uint8Array(info.data)); } catch { rec = null; } }
    return [o.toBase58(), rec];
  }));
  return sellableHolders(out, records, strictCfg, clock.readBigUInt64LE(0), clock.readBigInt64LE(32));
}

const isPoolIx = (i, disc) => i.programId.equals(PROGRAMS.hookpool) && i.data.length >= 8 && disc.every((b, k) => i.data[k] === b);

/// One wallet's sell of 1% of its coins (at least 1 raw unit), simulated as that wallet: the SDK's swap
/// instructions up to the swap, the wallet as fee payer, sigVerify false, replaceRecentBlockhash true.
export async function simulateHolderSell(connection, client, pool, hookRef, holder) {
  const amountIn = holder.amount / 100n > 0n ? holder.amount / 100n : 1n;
  const all = (await client.swapInstructions(holder.owner, pool, hookRef, DIRECTION.SELL, amountIn, 0n)).filter((i) => !isPoolIx(i, IX.hookpool.graduate));
  const swapIndex = all.findIndex((i) => isPoolIx(i, IX.hookpool.swap));
  const ixs = all.slice(0, swapIndex + 1);
  const message = new TransactionMessage({ payerKey: holder.owner, recentBlockhash: ANY_BLOCKHASH, instructions: ixs }).compileToV0Message();
  const sim = await connection.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const v = sim.value ?? {};
  return { ok: !v.err, err: v.err ?? null, logs: v.logs ?? [], swapIndex, amountIn, slot: sim.context ? sim.context.slot : null };
}

/// Whether a failed sell is the hook's doing, and why, in words: { hook, reason }. `hook` is true when the first
/// program that failed is the pool's hook program (a pegged coin's transfer hook is that program too), or when the
/// pool program refused what the hook answered. Not the hook's doing: a failure outside the swap instruction, the
/// wallet's SOL or coins, an account the wallet lacks, the pool's slippage, a strict coin's rules.
export function holderSellVerdict(result, hookProgram) {
  if (!result || result.ok) return { hook: false, reason: null };
  const logs = (result.logs ?? []).filter((l) => typeof l === "string");
  const err = result.err;
  const ie = err && typeof err === "object" && Array.isArray(err.InstructionError) ? err.InstructionError : null;
  if (!ie) return { hook: false, reason: `the transaction was refused before it ran (${plainText(typeof err === "string" ? err : "an error of the RPC", 120)})` };
  if (ie[0] !== result.swapIndex) return { hook: false, reason: `instruction ${ie[0]} before the swap failed: the wallet's own accounts, not the hook` };
  // the first program that failed is the innermost one: the one that refused
  const failed = logs.map((l) => /^Program (\S+) failed: (.*)$/.exec(l)).find(Boolean);
  let anchor = null;
  for (const l of logs) { const m = /Error Code: ([A-Za-z0-9_]+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/.exec(l); if (m) { anchor = { name: m[1], number: Number(m[2]), text: m[3] }; break; } }
  const hook = hookProgram.toBase58();
  const words = (s) => plainText(String(s), 200);
  if (failed && failed[1] === hook) {
    if (anchor && ACCOUNT_ERROR(anchor.number)) return { hook: false, reason: `the hook program needs an account the wallet does not have (${anchor.name})` };
    if (anchor && STRICT_RULES.has(anchor.number) && hookProgram.equals(PROGRAMS.hook_rules)) return { hook: false, reason: `the coin's rules hold this sell (${anchor.name})` };
    return { hook: true, reason: `the hook program ${hook} refused the sell: ${words(anchor ? `${anchor.name} (${anchor.number}): ${anchor.text}` : failed[2])}` };
  }
  if (failed && failed[1] === PROGRAMS.hookpool.toBase58() && anchor && HOOK_CAUSED.has(anchor.name)) {
    return { hook: true, reason: `the pool refused what the hook answered: ${words(`${anchor.name} (${anchor.number}): ${anchor.text}`)}` };
  }
  // another program refused (the token program, the system program, the pool's slippage): what any trade can meet
  if (logs.some((l) => /insufficient funds|insufficient lamports/i.test(l))) return { hook: false, reason: "the wallet holds too little SOL or too few coins" };
  return { hook: false, reason: failed ? `${words(failed[1])} failed: ${words(anchor ? anchor.name : failed[2])}` : "the swap failed for a reason that names no program" };
}

/// The check of one pool. `exclude`: wallets not to sell as (the probe wallet, the sell probe's holder). `budget`:
/// { left } shared by the pools of one pass, a simulation spends one. Answers { tried, failed: [{ wallet, error }]
/// (the hook refused), passed, other: [{ wallet, reason }] (failed for a reason any trade can meet), skipped (null,
/// or why nothing more was simulated), sims }. Never throws: a read that fails says so in `skipped`.
export async function checkHolderSells({ connection, client, pool, hook, dir, perPool = 3, budget = { left: Infinity }, exclude = [] }) {
  const out = { tried: 0, failed: [], passed: 0, other: [], skipped: null, sims: 0 };
  try {
    if (budget.left <= 0) { out.skipped = "the pass spent its holder simulations on other pools"; return out; }
    const strictCfg = hook && hook.rules && hook.rules.kind === RULES_KIND.STRICT ? hook.rules : null;
    const r = recentBuyersOf(dir, pool.address, { exclude });
    if (!r.found) { out.skipped = "the trades feed has no trades of this pool yet"; return out; }
    if (!r.buyers.length) { out.skipped = "nobody else bought on this pool in the trades the feed holds"; return out; }
    const holders = (await holdingBuyers(connection, pool, r.buyers, { strictCfg })).slice(0, perPool);
    if (!holders.length) { out.skipped = `none of the ${r.buyers.length} wallets that bought lately still holds the coin`; return out; }
    for (const h of holders) {
      if (budget.left <= 0) { out.skipped = "the pass spent its holder simulations before this pool's last ones"; break; }
      budget.left -= 1;
      out.sims += 1;
      const ref = await hookRefFor(connection, pool, h.owner, hook.extraMetasBytes, { strict: !!strictCfg });
      const res = await simulateHolderSell(connection, client, pool, ref, h);
      out.tried += 1;
      if (res.ok) { out.passed += 1; continue; }
      const v = holderSellVerdict(res, pool.hookProgram);
      if (v.hook) out.failed.push({ wallet: h.owner.toBase58(), error: v.reason });
      else out.other.push({ wallet: h.owner.toBase58(), reason: v.reason });
    }
  } catch (e) {
    out.skipped = `the holder sells could not be set up this time: ${plainText(String((e && e.message) || e), 200)}`;
  }
  return out;
}

/// The note on a pool whose hook runs on sells: what the last check of the sells as recent buyers found. `h` is
/// what the state keeps ({ at, tried, passed, failed, other, skipped }), or null before any check.
export function holderSellsNote(h, perPool) {
  const what = `up to ${perPool} wallets that bought lately and still hold the coin each sell 1% of it in a simulation, so that a hook cannot spare the watcher's own wallets alone`;
  if (!h || !h.at) return `Sells as recent buyers: not checked yet${h && h.skipped ? ` (${h.skipped})` : ""}. When the pool is simulated, ${what}.`;
  const counts = `${h.passed} went through, ${h.failed} ${h.failed === 1 ? "was" : "were"} refused by the hook${h.other ? `, ${h.other} failed for a reason any trade can meet` : ""}`;
  return `Sells as recent buyers, last checked at ${h.at}: ${h.tried} ${h.tried === 1 ? "wallet" : "wallets"} that bought lately sold 1% of their coins in a simulation. ${counts}.${h.skipped ? ` Not checked this time: ${h.skipped}.` : ""}`;
}

/// The alert of a pool where the hook refused some holders' sells while the sell probe went through.
export function holderSellsAlert(r) {
  const first = r.failed[0];
  return { level: "danger", message: `sells fail for some holders: ${r.failed.length} of ${r.tried} wallets that bought lately could not sell 1% of their coins in a simulation, while the sell probe went through. ${first.error}` };
}
