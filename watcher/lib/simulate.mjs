// Swap simulation and the effective-tax math.
//
// The math is pure and tested offline. The network part builds the SDK's swap instructions, keeps everything
// up to and including the swap (return data belongs to the LAST instruction, so the unwrap that follows is
// dropped) and simulates WITHOUT any signature: web3.js v1 sends sigVerify unset when no signers are given,
// so the fee payer can be any wallet, including the coin's largest holder for the sell probe.
import { Transaction, PublicKey } from "@solana/web3.js";
import {
  DIRECTION, FLAGS, PROGRAMS, IX, NO_HOOK, NATIVE_MINT, CLOCK_SYSVAR, TOKEN_2022_PROGRAM, RULES_KIND, pda, ix, quoteSwap, guardFee, resolveExtraAccounts, collectiblePda, rulesBuyLimit, rulesRatesTotal, rulesSideRates, rulesSniperFee,
  strictEarlyLocked, strictMaxWalletRuns, strictWindows, rulesPda, decodeHolderRecord,
} from "../../sdk/dist/index.js";
import { plainText, plainError, chainErrWords, innerWords, isRefusal } from "./plain.mjs";

export const BPS = 10000;
/// Below this the simulated output and the declared parameters are considered equal (rounding, slot drift).
export const TOLERANCE_BPS = 5;

function safeOut(p) { try { return quoteSwap(p).amountOut; } catch { return null; } }
/// The pool as a quote reads it. `q.virtualQuote` is the virtual SOL of a pool on the curve (0 or left out on a
/// seeded pool and after graduation): the price is made of `reserveQuote + virtualQuote`, so every output below,
/// plain or declared, is quoted with it, as the pool program quotes. Without it a pool on the curve, which opens
/// with no real SOL, would look like a pool whose hook takes nearly everything.
function base(q, direction, amountIn) {
  return { direction, amountIn, reserveBase: q.reserveBase, reserveQuote: q.reserveQuote, virtualQuote: q.virtualQuote ?? 0n, lpFeeBps: q.lpFeeBps, protocolFeeBps: q.protocolFeeBps, hookFeeBps: 0, feeOverrideBps: null };
}

/// Output of a plain pool (no hook fee, no fee override) for this trade. null when the pool cannot quote it.
export function plainOut(q, direction, amountIn) { return safeOut(base(q, direction, amountIn)); }

/// The hook fee, in bps, that a plain pool would have to charge to produce `amountOut`: "how much worse than
/// a plain pool", independent of price impact. 0 when the output is at least the plain output.
export function impliedTaxBps(q, direction, amountIn, amountOut) {
  if (amountOut === null || amountOut === undefined) return null;
  const plain = plainOut(q, direction, amountIn);
  if (plain === null) return null;
  if (amountOut >= plain) return 0;
  const out = (f) => safeOut({ ...base(q, direction, amountIn), hookFeeBps: f });
  // out(f) falls as f rises: find the largest f whose output is still at least amountOut
  let lo = 0; let hi = BPS - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const o = out(mid);
    if (o !== null && o >= amountOut) lo = mid; else hi = mid - 1;
  }
  const oLo = out(lo); const oHi = out(lo + 1);
  if (oLo !== null && oHi !== null && oLo - amountOut > amountOut - oHi) return lo + 1;
  return lo;
}

/// Is the hook's before_swap (the only callback whose answer changes the price) run for this direction?
export function hookRunsOn(flags, direction) {
  if (!(flags & FLAGS.BEFORE_SWAP)) return false;
  return direction === DIRECTION.BUY ? !!(flags & FLAGS.CALL_ON_BUY) : !!(flags & FLAGS.CALL_ON_SELL);
}

/// What the declared template parameters say this trade should return. null for custom hooks or when the
/// template config is unreadable. `slot` matters for the launch guard, whose fee decays every slot.
export function expectedOut(q, direction, amountIn, hook, slot) {
  const runs = hookRunsOn(hook.flags, direction);
  const isBuy = direction === DIRECTION.BUY;
  const b = base(q, direction, amountIn);
  if (hook.template === "tax" && hook.tax) return safeOut({ ...b, hookFeeBps: runs ? (isBuy ? hook.tax.buyBps : hook.tax.sellBps) : 0 });
  if (hook.template === "buyback" && hook.buyback) return safeOut({ ...b, hookFeeBps: runs ? (isBuy ? hook.buyback.buyBps : hook.buyback.sellBps) : 0 });
  // Collectible per buy: an after_swap on buys that mints pieces. It takes no fee and changes no price, so the
  // declared output is the plain pool's, both ways.
  if (hook.template === "collectible") return safeOut(b);
  if (hook.template === "launch_guard" && hook.guard) {
    const g = hook.guard;
    const fee = runs && isBuy && slot !== null && slot !== undefined
      ? guardFee(BigInt(slot), g.startSlot, g.guardSlots, g.startFeeBps, q.lpFeeBps) : null;
    return safeOut({ ...b, feeOverrideBps: fee });
  }
  // Launch rules: the hook answers the three rates of the side together, always all three, whoever is staked,
  // and the pool clamps the sum to the platform's hook fee cap. On a buy inside the sniper window the pool fee
  // is the window's fee of the slot (the launch guard's line), clamped to the platform's fee override cap.
  // `q.maxHookFeeBps` and `q.maxFeeOverrideBps` are the platform's two caps; without them nothing is clamped.
  if (hook.template === "rules" && hook.rules) {
    const c = hook.rules;
    const total = runs ? rulesRatesTotal(rulesSideRates(c, direction)) : 0;
    const hookFeeBps = q.maxHookFeeBps === undefined || q.maxHookFeeBps === null ? total : Math.min(total, q.maxHookFeeBps);
    let fee = runs && isBuy && slot !== null && slot !== undefined ? rulesSniperFee(BigInt(slot), c.startSlot, c.sniperSlots, c.sniperStartFeeBps, q.lpFeeBps) : null;
    if (fee !== null && q.maxFeeOverrideBps !== undefined && q.maxFeeOverrideBps !== null) fee = Math.min(fee, q.maxFeeOverrideBps);
    return safeOut({ ...b, hookFeeBps, feeOverrideBps: fee });
  }
  return null;
}

/// The size of the simulated buy on this pool. A rules coin may limit what one buy spends for its first slots,
/// and the pool refuses a larger one: while that limit runs the probe is the limit, when the limit is smaller.
/// Every other pool, and a rules coin outside its limit window, gets the configured probe.
///
/// A strict coin may cap what one wallet holds for a window after launch (the max wallet), and the coin's own
/// transfer hook refuses a buy that would end above it. The probe wallet holds none of the coin, so while the
/// max wallet runs the probe is cut to the largest buy whose declared output stays at or under the cap. That
/// needs `q`, the pool as the declared output reads it. While the sniper fee runs the fee falls every slot and
/// the simulation lands a slot or two after the read, so the cut counts the MOST a buy can give: its output at
/// the pool's own fee, with the sniper fee gone.
export function buyProbeLamports(probeLamports, hook, slot, q = null) {
  const none = { amount: probeLamports, limit: null, maxWallet: null };
  if (!hook || hook.template !== "rules" || !hook.rules || slot === null || slot === undefined) return none;
  const limit = rulesBuyLimit(hook.rules, BigInt(slot));
  let amount = limit && limit.maxBuyQuote < probeLamports ? limit.maxBuyQuote : probeLamports;
  let maxWallet = null;
  const c = hook.rules;
  if (c.kind === RULES_KIND.STRICT && q && strictMaxWalletRuns(c, BigInt(slot))) {
    maxWallet = { amount: c.maxWalletAmount, untilSlot: strictWindows(c).maxWalletUntil };
    // the slot the output is read at: the end of the sniper window while it runs (no fee override there)
    const sniperEnd = c.startSlot + c.sniperSlots;
    const fitSlot = rulesSniperFee(BigInt(slot), c.startSlot, c.sniperSlots, c.sniperStartFeeBps, q.lpFeeBps) !== null ? sniperEnd : BigInt(slot);
    const fits = (x) => { const out = expectedOut(q, DIRECTION.BUY, x, hook, fitSlot); return out !== null && out <= c.maxWalletAmount; };
    if (!fits(amount)) {
      let lo = 0n; let hi = amount;
      while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (fits(mid)) lo = mid; else hi = mid - 1n; }
      amount = lo;
    }
  }
  return { amount, limit, maxWallet };
}

/// The buy probe on a strict coin refused by the coin's max wallet (`MaxWallet`, 6044, from the rules program):
/// the probe was fitted to the cap at the slot the pool was read at, and the price or the slot moved before the
/// simulation ran. That is a condition of the coin, not the hook misbehaving, so it is a setup failure, as a
/// locked sell is for `sellableHolders`. Any other failure comes back as it is.
export function strictProbeOutcome(result, strict) {
  if (!strict || !result || result.ok || result.stage !== "swap") return result;
  const logs = result.logs ?? [];
  const maxWallet = logs.some((l) => typeof l === "string" && /programs\/hook_rules\//.test(l) && /Error Code: MaxWallet\. Error Number: 6044\./.test(l));
  if (!maxWallet) return result;
  return { ...result, stage: "setup", error: "setup: the coin's max wallet refused the buy probe (MaxWallet, 6044): the probe was fitted to the cap at the slot the pool was read at and the pool moved before the simulation. Not the hook's doing." };
}

/// What the rules of a strict coin hold back of a holder now: its early coins while the early lock runs, and the
/// creator's locked coins before their date, the larger of the two. `record` is the holder's decoded record, or
/// null (a wallet without a record has nothing held back).
export function strictHeld(cfg, record, slot, unixTime) {
  if (!record || !cfg || cfg.kind !== RULES_KIND.STRICT) return 0n;
  const early = record.earlyBought > 0n && strictEarlyLocked(cfg, BigInt(slot)) ? record.earlyBought : 0n;
  const creator = record.locked > 0n && BigInt(unixTime) < record.lockedUntil ? record.locked : 0n;
  return early > creator ? early : creator;
}

/// The holders whose sell probe (1% of their balance) the coin's rules let through: a strict coin's early lock
/// and creator lock hold coins in the wallet, and a sell of held coins is refused by rule, not by a misbehaving
/// hook. `records` maps an owner (base58) to its decoded holder record or null.
export function sellableHolders(holders, records, cfg, slot, unixTime) {
  return holders.filter((h) => {
    const amountIn = h.amount / 100n > 0n ? h.amount / 100n : 1n;
    return h.amount - amountIn >= strictHeld(cfg, records.get(h.owner.toBase58()) ?? null, slot, unixTime);
  });
}

/// |expected - actual| in bps of expected, or null when nothing is declared. The guard's fee and the sniper fee
/// of a rules coin are functions of the slot, and the simulation may land one slot away from the one we read,
/// so the closest of slot-1..slot+1 wins.
export function declaredMismatchBps(q, direction, amountIn, hook, slot, actualOut) {
  if (actualOut === null || actualOut === undefined) return null;
  const bySlot = hook.template === "launch_guard" || hook.template === "rules";
  const slots = bySlot && slot !== null && slot !== undefined ? [slot, slot - 1, slot + 1] : [slot];
  let best = null;
  for (const s of slots) {
    const e = expectedOut(q, direction, amountIn, hook, s);
    if (e === null || e === 0n) continue;
    const d = e > actualOut ? e - actualOut : actualOut - e;
    const bps = Number((d * BigInt(BPS)) / e);
    if (best === null || bps < best) best = bps;
  }
  return best;
}

/// The worst an honest hook can do under the platform caps, as an implied tax (bps) versus a plain pool:
/// the hook fee cap if it may take a fee, combined with the extra lp fee an override may add.
export function platformCapBps({ flags, maxHookFeeBps, maxFeeOverrideBps, lpFeeBps }) {
  const hookCap = flags & FLAGS.TAKE_HOOK_FEE ? maxHookFeeBps : 0;
  let overrideExtra = 0;
  if (flags & FLAGS.OVERRIDE_FEE && maxFeeOverrideBps > lpFeeBps && lpFeeBps < BPS) {
    overrideExtra = ((maxFeeOverrideBps - lpFeeBps) * BPS) / (BPS - lpFeeBps);
  }
  return Math.round(BPS - ((BPS - hookCap) * (BPS - overrideExtra)) / BPS);
}

function findLogMessage(logs) {
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    let m = /Error Message: (.*)$/.exec(l); if (m) return m[1];
    m = /Program log: Error: (.*)$/.exec(l); if (m) return m[1];
    m = /Program log: (.*(?:insufficient|Insufficient|not enough|error|Error|failed).*)$/.exec(l); if (m) return m[1];
  }
  return "";
}

/// Which instruction failed? "swap" = the pool (and so possibly the hook) refused; "setup" = the probe's own
/// token accounts, lamports or fee payer, which says nothing about the hook. The message is words, never JSON:
/// the site prints it as it stands.
export function classifySimError(err, logs, swapIndex) {
  let stage = "setup";
  let detail;
  if (err && typeof err === "object" && Array.isArray(err.InstructionError)) {
    const [idx, inner] = err.InstructionError;
    stage = idx === swapIndex ? "swap" : "setup";
    detail = innerWords(inner);
  } else {
    detail = chainErrWords(err);
  }
  const msg = findLogMessage(logs ?? []);
  return { stage, message: plainText(`${stage}: ${detail}${msg ? ` (${msg})` : ""}`) };
}

// ---- network -------------------------------------------------------------------------------------

/// The SDK's client.isPegged: a collectible pool whose coin lives in Token-2022. The swap of such a pool moves
/// the coin through its own transfer hook, which needs accounts of its own.
export function isPeggedPool(pool) {
  return !!pool.hasHook && pool.hookProgram.equals(PROGRAMS.hook_collectible) && pool.baseTokenProgram.equals(TOKEN_2022_PROGRAM);
}

/// What the transfer hook of a pegged coin needs in a swap, after the pool hook's own accounts: the ticket of
/// the pool's vault side (it never exists), the pool's burn queue, and the hook's account list. The same three,
/// in the same order, as the SDK's client.hookRef adds.
export function peggedSwapAccounts(pool) {
  const meta = (pubkey, isWritable) => ({ pubkey, isSigner: false, isWritable });
  return [meta(collectiblePda.ticket(pool.address, pool.address), true), meta(collectiblePda.queue(pool.address), true), meta(collectiblePda.validation(pool.baseMint), false)];
}

/// Hook reference for a given user from cached extra-metas bytes (one read per hook program per pass). For a
/// pegged coin it also carries the accounts the coin's transfer hook needs, as the site's swaps do. For a strict
/// coin (`opts.strict`) it carries the three of the SDK's `strictPoolExtras`: the user's holder record, the
/// pool's holder address and the coin's account list.
export async function hookRefFor(connection, pool, user, extraMetasBytes, opts = {}) {
  if (!pool.hasHook) return NO_HOOK;
  if (!extraMetasBytes) throw new Error("hook extra-metas account missing");
  const fixed = [pool.address, pda.caller(pool.hookProgram)[0], user, pool.quoteMint, pool.baseMint];
  const extra = await resolveExtraAccounts(connection, pool.hookProgram, extraMetasBytes, fixed);
  if (isPeggedPool(pool)) extra.push(...peggedSwapAccounts(pool));
  if (opts.strict) extra.push(...ix.strictPoolExtras(pool.address, pool.baseMint, user));
  return { program: pool.hookProgram, treasury: pool.hookQuoteTreasury, extra };
}

const isPoolIx = (i, disc) => i.programId.equals(PROGRAMS.hookpool) && i.data.length >= 8 && disc.every((b, k) => i.data[k] === b);

/// Simulate one swap as `user` without a signature and read the pool's return data (amount_out, u64 LE). The
/// pool is simulated as it stands: a `graduate` the SDK puts next to the swap of a pool on the curve (before it
/// or after it) is left out, so that the simulation is the trade on the pool the watcher's numbers are read
/// from. The swap is found by its own discriminator.
export async function simulateSwap(connection, client, pool, hookRef, user, direction, amountIn) {
  const all = (await client.swapInstructions(user, pool, hookRef, direction, amountIn, 0n)).filter((i) => !isPoolIx(i, IX.hookpool.graduate));
  const swapIndex = all.findIndex((i) => isPoolIx(i, IX.hookpool.swap));
  const ixs = all.slice(0, swapIndex + 1);
  const tx = new Transaction().add(...ixs);
  tx.feePayer = user;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(tx, undefined, false);
  const slot = sim.context ? sim.context.slot : null;
  const logs = sim.value.logs ?? [];
  if (sim.value.err) {
    const c = classifySimError(sim.value.err, logs, swapIndex);
    return { ok: false, amountOut: null, error: c.message, stage: c.stage, slot, logs, amountIn };
  }
  const rd = sim.value.returnData;
  if (!rd || rd.programId !== PROGRAMS.hookpool.toBase58() || !rd.data || !rd.data[0]) {
    return { ok: false, amountOut: null, error: "swap: no return data from the pool", stage: "swap", slot, logs, amountIn };
  }
  const bytes = Buffer.from(rd.data[0], "base64");
  if (bytes.length < 8) return { ok: false, amountOut: null, error: "swap: short return data from the pool", stage: "swap", slot, logs, amountIn };
  return { ok: true, amountOut: bytes.readBigUInt64LE(0), error: null, stage: null, slot, logs, amountIn };
}

/// How long the pool check leaves getTokenLargestAccounts alone after the RPC refused it for good (a shared node
/// that keeps the call for dedicated nodes): a day. Each refusal costs a request, and a pass checks every pool;
/// a plan that refuses the call does not change its mind within the hour.
export const LARGEST_REFUSED_MS = 86_400_000;
/// The memory of that refusal: one per process, as a process talks to one RPC.
export const largestAccountsMemo = { refusedUntil: 0, reason: null };

/// The holders among some token accounts that the sell probe may sell as: the owner's associated token account of
/// the coin (the swap instruction uses it), with coins in it, the pool vault excluded. One batched read; the
/// amount is the account's own. Largest first.
export async function holdersAmong(connection, pool, addresses) {
  if (!addresses.length) return [];
  const infos = await connection.getMultipleAccountsInfo(addresses);
  const out = [];
  addresses.forEach((address, i) => {
    const info = infos[i];
    if (!info || !info.data || info.data.length < 72) return;
    if (info.owner && typeof info.owner.equals === "function" && !info.owner.equals(pool.baseTokenProgram)) return;
    if (pool.baseVault && address.equals(pool.baseVault)) return;
    const data = Buffer.from(info.data);
    if (!new PublicKey(data.subarray(0, 32)).equals(pool.baseMint)) return;
    const owner = new PublicKey(data.subarray(32, 64));
    const amount = data.readBigUInt64LE(64);
    if (amount <= 0n) return;
    if (!pda.ata(owner, pool.baseMint, pool.baseTokenProgram).equals(address)) return;
    out.push({ owner, account: address, amount });
  });
  out.sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  return out;
}

/// The holders the sell probe may sell as, largest first, up to `max`, and where they came from.
///
/// First the RPC's list of the coin's largest token accounts (`source` "largest"). A shared node may refuse that
/// call for good (Chainstack's shared nodes answer 403, "only available on dedicated nodes"): then it is left alone
/// for LARGEST_REFUSED_MS, and the holders come from the wallets that traded the pool lately, as the trades feed
/// holds them (`traders()` answers { found, traders }, lib/feed.mjs tradersOf): their associated token accounts,
/// read in one call (`source` "feed"). Never throws. When no holder is found, `reason` says why in words (the sell
/// probe is then not set up, which says nothing about the hook), and `retry` is true when the answer may differ at
/// the next pass (the feed has no file for the pool yet, or a read failed this time). `largestError` is the RPC's
/// answer in words when the list was refused or failed, `refusedNow` true on the call that met the refusal.
export async function findHolders(connection, pool, { max = 5, traders = null, memo = largestAccountsMemo, now = Date.now } = {}) {
  let largestError = null;
  let refusedNow = false;
  if (now() >= memo.refusedUntil) {
    try {
      const largest = await connection.getTokenLargestAccounts(pool.baseMint);
      const cands = largest.value.filter((a) => !a.address.equals(pool.baseVault) && BigInt(a.amount) > 0n).slice(0, 10).map((a) => a.address);
      const got = await holdersAmong(connection, pool, cands);
      if (got.length) return { holders: got.slice(0, max), source: "largest", reason: null, retry: false, largestError: null, refusedNow: false };
    } catch (e) {
      largestError = plainError(e);
      if (isRefusal(e)) { memo.refusedUntil = now() + LARGEST_REFUSED_MS; memo.reason = largestError; refusedNow = true; }
    }
  } else {
    largestError = memo.reason ?? "refused by the RPC";
  }
  let t = { found: false, traders: [] };
  try { if (traders) t = traders() ?? t; } catch { t = { found: false, traders: [] }; }
  let readFailed = false;
  if (t.traders.length) {
    try {
      const got = await holdersAmong(connection, pool, t.traders.map((o) => pda.ata(o, pool.baseMint, pool.baseTokenProgram)));
      if (got.length) return { holders: got.slice(0, max), source: "feed", reason: null, retry: false, largestError, refusedNow };
    } catch { readFailed = true; }
  }
  const none = "setup: no holder found to sell as";
  if (largestError === null) {
    // the RPC listed the largest accounts: none of them is a wallet's own token account with coins in it
    return { holders: [], source: null, reason: t.traders.length ? `${none}: neither the coin's largest token accounts nor the wallets that traded the pool lately hold the coin in their own token account` : "setup: no holder with an associated token account found", retry: readFailed, largestError, refusedNow };
  }
  const why = memo.refusedUntil > now() ? "this RPC does not list a coin's largest holders" : "the RPC did not list the coin's largest holders this time";
  if (readFailed) return { holders: [], source: null, reason: `${none}: ${why}, and the token accounts of the pool's recent traders could not be read this time`, retry: true, largestError, refusedNow };
  if (!t.found) return { holders: [], source: null, reason: `${none}: ${why}, and the trades feed has no trades of this pool yet`, retry: true, largestError, refusedNow };
  if (!t.traders.length) return { holders: [], source: null, reason: `${none}: ${why}, and nobody traded this pool in the trades the feed holds`, retry: false, largestError, refusedNow };
  return { holders: [], source: null, reason: `${none}: ${why}, and none of the ${t.traders.length} wallets that traded the pool lately holds the coin`, retry: false, largestError, refusedNow };
}

/// Sell 1% of the largest holder's balance as that holder. When the failure is in the setup (the holder has
/// no SOL for its quote token account, ...) the next holder is tried, up to three.
export async function simulateSellAsHolder(connection, client, pool, extraMetasBytes, holders, opts = {}) {
  if (!holders.length) {
    return { ok: false, amountOut: null, error: opts.emptyReason ?? "setup: no holder with an associated token account found", stage: "setup", holder: null, slot: null, amountIn: null };
  }
  let last = null;
  for (const h of holders.slice(0, 3)) {
    const amountIn = h.amount / 100n > 0n ? h.amount / 100n : 1n;
    const ref = await hookRefFor(connection, pool, h.owner, extraMetasBytes, opts);
    const r = await simulateSwap(connection, client, pool, ref, h.owner, DIRECTION.SELL, amountIn);
    last = { ...r, holder: h.owner.toBase58() };
    if (r.ok || r.stage === "swap") return last;
  }
  return last;
}

/// The two probes of the pool check, for a pool with a hook (`hook`, lib/chain.mjs) or without one (`hook` null):
/// (b) a buy of `probeLamports` as the probe wallet; (c) a sell of 1% of a large holder's balance, as that holder.
/// `funding` is the probe wallet's { ok, message }. `slot` is the slot the hooks were read at: a rules coin whose
/// buy limit runs then gets a probe no larger than the limit, because the pool refuses a larger buy and that says
/// nothing about the hook.
///
/// A strict coin (the rules template, kind 1) runs its rules inside the transfers of the swap, so both
/// simulations carry its accounts. The probe wallet has no holder record: in the early window a buy needs one,
/// and the SDK puts `open_holder` in front of the buy, which the simulation runs too (the rent is only
/// simulated). While the max wallet runs the probe is no larger than the cap allows. The sell probe skips
/// holders whose coins the early lock or the creator lock hold: the rule would refuse their sell, and that says
/// nothing about the hook.
///
/// The sell side never fails the buy side: finding a holder never throws (findHolders), and a read that fails
/// while the sell probe is set up makes the sell a setup failure for this pass (`retry`), with the buy as it was.
/// `traders` reaches findHolders. `onHolders` is told what findHolders answered (for the log).
export async function simulateProbes({ connection, client, pool, hook = null, probe, probeLamports, funding, slot = null, platform = null, traders = null, memo = largestAccountsMemo, onHolders = null }) {
  const strict = !!(hook && hook.rules && hook.rules.kind === RULES_KIND.STRICT);
  const q = platform ? { reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: pool.virtualQuote, lpFeeBps: pool.lpFeeBps, protocolFeeBps: platform.protocolFeeBps, maxHookFeeBps: platform.maxHookFeeBps, maxFeeOverrideBps: platform.maxFeeOverrideBps } : null;
  let buy;
  if (!pool.quoteMint.equals(NATIVE_MINT)) buy = { ok: false, amountOut: null, error: "setup: quote mint is not wrapped SOL, the probe holds no quote tokens", stage: "setup", slot: null };
  else if (!funding || !funding.ok) buy = { ok: false, amountOut: null, error: `setup: ${funding && funding.message ? funding.message : "probe wallet not funded"}`, stage: "setup", slot: null };
  else {
    const ref = hook ? await hookRefFor(connection, pool, probe, hook.extraMetasBytes, { strict }) : NO_HOOK;
    const p = hook ? buyProbeLamports(probeLamports, hook, slot, q) : { amount: probeLamports, limit: null, maxWallet: null };
    buy = strictProbeOutcome(await simulateSwap(connection, client, pool, ref, probe, DIRECTION.BUY, p.amount), strict);
    if (p.limit) buy.probeLimit = p.limit;
    if (p.maxWallet) buy.probeMaxWallet = p.maxWallet;
  }
  let sell;
  try {
    const found = await findHolders(connection, pool, { traders, memo });
    if (onHolders) onHolders(found);
    let holders = found.holders;
    let emptyReason = found.reason ?? undefined;
    if (strict && holders.length) {
      const infos = await connection.getMultipleAccountsInfo([CLOCK_SYSVAR, ...holders.map((h) => rulesPda.holder(pool.address, h.owner))]);
      const clock = infos[0] ? Buffer.from(infos[0].data) : null;
      const records = new Map(holders.map((h, i) => {
        const info = infos[i + 1];
        let rec = null;
        if (info) { try { rec = decodeHolderRecord(new Uint8Array(info.data)); } catch { rec = null; } }
        return [h.owner.toBase58(), rec];
      }));
      const free = clock ? sellableHolders(holders, records, hook.rules, clock.readBigUInt64LE(0), clock.readBigInt64LE(32)) : holders;
      if (!free.length) emptyReason = "setup: the coins of every large holder are held by the coin's early lock or creator lock right now";
      holders = free;
    }
    sell = await simulateSellAsHolder(connection, client, pool, hook ? hook.extraMetasBytes : null, holders, { strict, emptyReason });
    if (!holders.length && found.retry) sell.retry = true;
    sell.holderSource = found.source;
  } catch (e) {
    sell = { ok: false, amountOut: null, error: `setup: the sell probe could not be set up this time: ${plainError(e)}`, stage: "setup", holder: null, slot: null, amountIn: null, retry: true };
  }
  return { buy, sell };
}
