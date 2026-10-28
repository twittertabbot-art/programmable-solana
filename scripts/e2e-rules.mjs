// The "launch rules" template (hook_rules, RULES.md) end to end through the SDK on a live
// chain. Four coins are launched that together switch on every rule:
//
//   A  plain: a creator fee and nothing else
//   B  holder rewards and burn, with different rates on buys and on sells
//   C  a sniper fee and a buy limit, and a lock that is declared but not made at launch
//   D  a creator lock made inside the launch transaction, short enough to watch it open
//
// For each coin the script checks that the config on chain is what was asked, that the
// SDK's quote is what the chain pays to the unit, and that every lamport of hook fee goes
// where RULES.md says. The script keeps its own book of each coin from the pool's events
// ("How the money moves" in RULES.md, written out again below, without the SDK), and
// compares three things all along: the chain, the SDK, the book.
//
//   node scripts/e2e-rules.mjs <localnet|devnet>
//
// It needs no key from your machine: every wallet is made here and funded by airdrop.
// It waits for real time to pass several times (25 slots between two calls of the burn, a
// 150-slot window, a few seconds of lock), so it runs for about four minutes.
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, TransactionMessage, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  HookpoolClient, NATIVE_MINT, DIRECTION, FLAGS, HOOK_KIND, PROGRAMS, SYSTEM_PROGRAM, BURN_INTERVAL_SLOTS, BURN_OUTCOME, burnLowered, LOCK_WHOLE_BALANCE, UNSTAKE_DELAY_SLOTS, RULES_CEILINGS,
  RULES_POLICY, anchorDiscriminator, decodeTokenAmount, eventsFromTransaction, ix, mulDivCeil, pda, poolKeys, rulesArgs, rulesBuyLimit, rulesFirstBuyQuote, rulesPda, rulesProblems,
  rulesSniperFee,
} from "../sdk/dist/index.js";
import { RPC, connection, loadAlt, sendRefused, waitForSlot } from "./cluster.mjs";

const cluster = process.argv[2];
if (cluster !== "localnet" && cluster !== "devnet") {
  console.error("usage: node scripts/e2e-rules.mjs <localnet|devnet>\nThis rehearsal spends SOL on throwaway coins: it runs on a test chain only.");
  process.exit(1);
}
const conn = connection(cluster);
const client = new HookpoolClient(conn, { lookupTable: loadAlt(cluster) });
const platform = await client.platform().catch(() => null);
if (!platform) { console.error(`Programmable is not initialised on ${cluster} (${RPC[cluster]}). From the repository root:\n  bash scripts/localnet.sh up\n  node scripts/init-platform.mjs localnet`); process.exit(1); }
const OURS = Object.values(PROGRAMS).map((p) => p.toBase58());

// ---- small tools ---------------------------------------------------------------------------
let checks = 0;
const check = (cond, msg) => { if (!cond) { console.error("CHECK FAILED: " + msg); process.exit(1); } checks++; console.log("  check  " + msg); };
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));
const fmt = (v, dec = 9) => (Number(v) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dec });
const UNIT = 1_000_000n;                              // one coin, 6 decimals
const SUPPLY = 1_000_000_000n * UNIT;
const LIQUIDITY = sol(2), LP_FEE_BPS = 100;
const NETWORK_FEE = 5_000n;                           // one signature
const measures = [];
const measure = (what, r, sizes) => measures.push({ what, cu: r.cu, size: r.size, table: r.table, sizes });

async function fund(wallets, amount) {
  await Promise.all(wallets.map(async (w) => conn.confirmTransaction(await conn.requestAirdrop(w.publicKey, Number(sol(amount))), "confirmed")));
}
async function fetchTx(sig) {
  for (let i = 0; i < 60; i++) {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx) return tx;
    await sleep(250);
  }
  console.error("transaction not found: " + sig); process.exit(1);
}
/// Send and read back: the slot, the compute units, the size on the wire and the events.
/// `table: true` sends a v0 transaction compiled with the platform's lookup table.
async function send(ixs, signers, label, { table = false } = {}) {
  let sig, size;
  try {
    if (table) {
      const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
      tx.sign(signers);
      size = tx.serialize().length;
      sig = await conn.sendTransaction(tx);
      const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error("transaction failed: " + JSON.stringify(res.value.err));
    } else {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = signers[0].publicKey;
      sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
      size = tx.serialize().length;
    }
  } catch (e) {
    console.error(`  FAILED ${label}`);
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null);
    console.error(logs ? logs.join("\n") : e.message);
    process.exit(1);
  }
  const tx = await fetchTx(sig);
  console.log(`  ok  ${label}`);
  return { sig, size, table, slot: BigInt(tx.slot), cu: tx.meta?.computeUnitsConsumed ?? null, events: eventsFromTransaction(tx, OURS), logs: tx.meta?.logMessages ?? [] };
}
/// What a transaction would measure on the wire, both ways, without sending it.
async function sizesOf(ixs, payer) {
  const { blockhash } = await conn.getLatestBlockhash();
  const message = () => new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs });
  const wire = (m) => m.serialize().length + 1 + 64 * m.header.numRequiredSignatures;
  let legacy = null, v0 = null;
  try { legacy = wire(message().compileToLegacyMessage()); } catch { /* does not fit */ }
  try { v0 = wire(message().compileToV0Message(await client.lookupTables())); } catch { /* does not fit */ }
  return { legacy, v0 };
}
const fits = (n) => (n === null ? "does not fit" : n > 1232 ? `${n} bytes, over the limit of 1,232` : `${n} bytes`);
/// Send something the chain must refuse and check the reason it gives.
async function refused(ixs, signers, label, reason) {
  const text = await sendRefused(conn, ixs, signers, label);
  if (!text.includes(reason)) console.error(text);
  check(text.includes(reason), `refused, and the reason is ${reason}`);
}
const tokenAmount = async (account) => { const a = await conn.getAccountInfo(account); return a ? decodeTokenAmount(new Uint8Array(a.data)) : 0n; };
const ruleBytes = async (pool) => Buffer.from((await conn.getAccountInfo(rulesPda.cfg(pool))).data.subarray(8, 240)).toString("hex");

// ---- the pool's fees, by hand ----------------------------------------------------------------
const ceilFee = (amount, bps) => (bps === 0 || amount === 0n ? 0n : (amount * BigInt(bps) + 9_999n) / 10_000n);
/// On a buy the hook fee is taken from what is left after the protocol fee.
const buyHookFee = (amountIn, bps) => ceilFee(amountIn - ceilFee(amountIn, platform.protocolFeeBps), bps);
/// On a sell it is taken from what the curve pays out.
const sellHookFee = (event, bps) => ceilFee(event.amountOut + event.hookFee, bps);

// ---- the script's own book of one coin: RULES.md, "How the money moves" ------------------------
// A trade pays all three rates of its side. Its hook fee is split the next time the program
// runs for the pool: creator and holders are rounded down, the burn pot takes the rest. The
// holders' part goes into an accumulator scaled by 10^12 while at least 0.1% of the supply
// is staked, and into the burn pot otherwise.
const SCALE = 10n ** 12n;
class Book {
  constructor(rules, minEligible) {
    this.rules = rules; this.minEligible = minEligible;
    this.fees = 0n;                 // every hook fee the pool charged
    this.last = null;               // the trade not settled yet: its fee and the rates it was charged
    this.creator = 0n; this.burn = 0n; this.acc = 0n; this.rem = 0n; this.staked = 0n;
    this.paidCreator = 0n; this.paidRewards = 0n; this.burnedQuote = 0n;
    this.holdersBurned = 0n; this.holdersShared = 0n;   // where the holders' share went
    this.stakers = new Map();       // wallet -> { amount, snap, owed }
  }
  clone() {
    const b = Object.assign(new Book(this.rules, this.minEligible), this);
    b.last = this.last && { ...this.last };
    b.stakers = new Map([...this.stakers].map(([k, v]) => [k, { ...v }]));
    return b;
  }
  /// The rates a trade is charged: the three of its side, always.
  rates(isBuy) {
    const side = isBuy ? this.rules.buy : this.rules.sell;
    return { c: BigInt(side.creatorBps), h: BigInt(side.holdersBps), b: BigInt(side.burnBps) };
  }
  /// Do the stakers get the holders' share? Only while at least 0.1% of the supply is staked.
  eligible() { return this.staked > 0n && this.staked >= this.minEligible; }
  settle() {
    if (!this.last) return;
    const { fee, c, h, b } = this.last; this.last = null;
    const t = c + h + b;
    const toCreator = t === 0n ? 0n : (fee * c) / t;
    const toHolders = t === 0n ? 0n : (fee * h) / t;
    let toBurn = fee - toCreator - toHolders;
    if (toHolders > 0n) {
      if (!this.eligible()) { toBurn += toHolders; this.holdersBurned += toHolders; }
      else { const n = toHolders * SCALE + this.rem; this.acc += n / this.staked; this.rem = n % this.staked; this.holdersShared += toHolders; }
    }
    this.creator += toCreator; this.burn += toBurn;
  }
  trade(fee, isBuy) { this.settle(); this.fees += fee; this.last = { fee, ...this.rates(isBuy) }; }
  record(wallet) {
    const key = wallet.toBase58();
    if (!this.stakers.has(key)) this.stakers.set(key, { amount: 0n, snap: 0n, owed: 0n });
    const s = this.stakers.get(key);
    s.owed += (s.amount * (this.acc - s.snap)) / SCALE; s.snap = this.acc;
    return s;
  }
  stake(wallet, amount) { this.settle(); this.record(wallet).amount += amount; this.staked += amount; }
  claim(wallet) { this.settle(); const s = this.record(wallet); const a = s.owed; s.owed = 0n; this.paidRewards += a; return a; }
  claimCreator() { this.settle(); const a = this.creator; this.creator = 0n; this.paidCreator += a; return a; }
  burnRun(spend) { this.settle(); this.burn -= spend; this.burnedQuote += spend; }
  /// What is promised to somebody, as of the last settlement.
  promised() { let owed = 0n; for (const s of this.stakers.values()) owed += s.owed + (s.amount * (this.acc - s.snap)) / SCALE; return this.creator + this.burn + owed; }
}

// ---- launching a coin with rules -----------------------------------------------------------------
const coins = [];
/// `table`: send the two launch transactions compiled with the lookup table.
/// `dropLock`: leave the lock instruction out of the launch (to show what the program does then).
async function launchCoin(letter, name, symbol, input, { dev, devBuy, table = false, dropLock = false }) {
  const mint = Keypair.generate();
  const args = rulesArgs(input);
  // the first buy, worked out before the pool exists; sent as the floor of the launch
  const first = rulesFirstBuyQuote(args, { totalSupply: SUPPLY, quoteAmount: LIQUIDITY, lpFeeBps: LP_FEE_BPS, devBuyQuote: devBuy }, platform);
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name, symbol, uri: `https://example.com/meta/${symbol.toLowerCase()}.json`, decimals: 6, totalSupply: SUPPLY,
    quoteMint: NATIVE_MINT, lpFeeBps: LP_FEE_BPS, quoteAmount: LIQUIDITY, devBuyQuote: devBuy, minDevBuyOut: first.amountOut,
    template: "rules", rules: input,
  });
  let launchTx = plan.launchTx;
  if (dropLock) launchTx = launchTx.filter((i) => !(i.programId.equals(PROGRAMS.hook_rules)));
  const s1 = await sizesOf(plan.createTx, dev.publicKey), s2 = await sizesOf(launchTx, dev.publicKey);
  console.log(`  transaction 1 (coin and rules): ${fits(s1.legacy)} without the lookup table, ${fits(s1.v0)} with it`);
  console.log(`  transaction 2 (launch${devBuy > 0n ? ", first buy" : ""}${plan.lock && !dropLock ? ", creator lock" : ""}): ${fits(s2.legacy)} without the lookup table, ${fits(s2.v0)} with it`);
  const t1 = await send(plan.createTx, [dev, ...plan.signers], `${letter}: transaction 1, the coin and its rules${table ? " (with the lookup table)" : ""}`, { table });
  const t2 = await send(launchTx, [dev], `${letter}: transaction 2, the pool${table ? " (with the lookup table)" : ""}`, { table });
  measure(`${letter} launch, transaction 1 (coin and rules)`, t1, s1);
  measure(`${letter} launch, transaction 2${devBuy > 0n ? " with a first buy" : ""}${plan.lock && !dropLock ? " and the creator lock" : ""}`, t2, s2);

  const pool = await client.pool(plan.pool);
  const state = await client.rulesState(plan.pool);
  const c = state.config;
  const same = (a, b) => a.creatorBps === b.creatorBps && a.holdersBps === b.holdersBps && a.burnBps === b.burnBps;
  check(c.sniperSlots === args.sniperSlots && c.sniperStartFeeBps === args.sniperStartFeeBps && same(c.buy, args.buy) && same(c.sell, args.sell)
    && c.maxBuyQuote === args.maxBuyQuote && c.limitSlots === args.limitSlots && c.creatorLockSeconds === args.creatorLockSeconds,
    `${letter}: the rules on chain are the rules that were asked, number for number`);
  check(c.creator.equals(dev.publicKey) && c.pool.equals(plan.pool) && c.baseMint.equals(mint.publicKey) && c.quoteMint.equals(NATIVE_MINT) && c.treasury.equals(pool.hookQuoteTreasury)
    && c.treasury.equals(rulesPda.treasury(plan.pool, NATIVE_MINT)), `${letter}: the config names the launcher, the pool, the two mints and the treasury the pool pays`);
  check(c.started && c.startSlot === t2.slot && c.minEligible === SUPPLY / 1_000n, `${letter}: the pool's creation started the config: slot ${c.startSlot}, holder rewards need ${fmt(c.minEligible, 6)} coins staked (0.1% of the supply)`);
  const info = await client.hookInfo(pool);
  check(info.template === "rules" && info.manifest.name === "Programmable launch rules" && pool.hookKind === HOOK_KIND.PLATFORM
    && pool.hookFlags === (FLAGS.BEFORE_SWAP | FLAGS.BEFORE_ADD_LIQ | FLAGS.ON_POOL_CREATE | FLAGS.OVERRIDE_FEE | FLAGS.TAKE_HOOK_FEE | FLAGS.CALL_ON_BUY | FLAGS.CALL_ON_SELL)
    && info.summary.canBlockAdding && !info.summary.canBlockRemoval,
    `${letter}: the SDK names the template ("rules") and the pool carries its seven flags; the hook runs when liquidity is added, never when it is removed`);
  check(info.rules && same(info.rules.buy, args.buy) && same(info.rules.sell, args.sell) && Array.isArray(info.rulesSentences) && info.rulesSentences.length >= 2, `${letter}: hookInfo carries the decoded config and its rules in words:`);
  for (const s of info.rulesSentences) console.log("           " + s);
  const ref = await client.hookRef(pool, dev.publicKey);
  check(ref.extra.length === 1 && ref.extra[0].pubkey.equals(rulesPda.cfg(plan.pool)) && ref.extra[0].isWritable && !ref.extra[0].isSigner && ref.treasury.equals(c.treasury) && ref.program.equals(PROGRAMS.hook_rules),
    `${letter}: hookRef resolved the hook's one extra account from the list on chain: the config, writable`);

  const book = new Book(args, c.minEligible);
  const buy = t2.events.find((e) => e.kind === "Swapped");
  if (devBuy > 0n) {
    check(buy && buy.amountOut === first.amountOut && buy.hookFee === first.hookFee && buy.feeBpsApplied === first.feeBpsApplied && buy.hookFee === buyHookFee(devBuy, args.buy.creatorBps + args.buy.holdersBps + args.buy.burnBps),
      `${letter}: the launcher's first buy got ${fmt(buy.amountOut, 6)} coins, exactly what the SDK worked out before the pool existed (pool fee ${buy.feeBpsApplied} bps, hook fee ${buy.hookFee} lamports: all three rates of the buy side)`);
    book.trade(buy.hookFee, true);
  }
  const coin = { letter, name, symbol, mint: mint.publicKey, pool: plan.pool, dev, args, plan, first, book, launch: t2, rulesAtLaunch: await ruleBytes(plan.pool), treasury: c.treasury };
  coins.push(coin);
  return coin;
}

/// One trade with every comparison: the SDK's instant quote, the chain's simulation, what
/// the chain paid, and the hook fee worked out by hand at `bps`.
/// `window: true`: inside the sniper window the fee falls every slot, so the chain gives
/// the quote or more, and exactly the quote of the slot the trade landed in.
async function trade(coin, wallet, direction, amountIn, label, bps, { window = false } = {}) {
  const isBuy = direction === DIRECTION.BUY;
  const pool = await client.pool(coin.pool);
  const info = await client.hookInfo(pool);
  const local = await client.quoteLocal(pool, platform, direction, amountIn, info);
  const simulated = await client.quoteOnChain(wallet.publicKey, pool, direction, amountIn);
  const coinsBefore = await client.tokenBalance(wallet.publicKey, coin.mint);
  const lamportsBefore = BigInt(await conn.getBalance(wallet.publicKey));
  const hadWrapped = await client.exists(pda.ata(wallet.publicKey, NATIVE_MINT));
  const r = await send(await client.swapInstructions(wallet.publicKey, pool, await client.hookRef(pool, wallet.publicKey), direction, amountIn, local.amountOut), [wallet], label);
  const ev = r.events.find((e) => e.kind === "Swapped");
  coin.book.trade(ev.hookFee, isBuy);
  const coinsAfter = await client.tokenBalance(wallet.publicKey, coin.mint);
  // what reached the wallet: coins on a buy; on a sell plain SOL, less the network fee
  const received = isBuy ? coinsAfter - coinsBefore : hadWrapped ? ev.amountOut : BigInt(await conn.getBalance(wallet.publicKey)) - lamportsBefore + NETWORK_FEE;
  const byHand = isBuy ? buyHookFee(amountIn, bps) : sellHookFee(ev, bps);
  const unit = isBuy ? "coins" : "SOL", dec = isBuy ? 6 : 9;
  if (window) {
    const exact = await client.quoteLocal(pool, platform, direction, amountIn, info, ev.slot);
    const fee = rulesSniperFee(ev.slot, info.rules.startSlot, info.rules.sniperSlots, info.rules.sniperStartFeeBps, pool.lpFeeBps);
    check(received >= simulated && simulated >= local.amountOut && received === ev.amountOut, `${label}: quoted ${fmt(local.amountOut, dec)} ${unit}, the wallet received ${fmt(received, dec)}: the quote or more, because the trade landed ${ev.slot - info.rules.startSlot} slots into the window`);
    check(exact.amountOut === received && ev.feeBpsApplied === fee && exact.feeBpsApplied === fee && fee > pool.lpFeeBps && fee < info.rules.sniperStartFeeBps, `${label}: for the slot it landed in the SDK's quote is exact, and the pool fee is the straight line's ${fee} bps`);
  } else {
    check(local.amountOut === simulated && simulated === ev.amountOut && received === ev.amountOut, `${label}: quoted ${fmt(local.amountOut, dec)} ${unit}, simulated the same, received the same`);
    check(ev.feeBpsApplied === pool.lpFeeBps, `${label}: the pool fee is the pool's own ${pool.lpFeeBps} bps`);
  }
  check(ev.hookFee === byHand && (window || local.hookFee === ev.hookFee), `${label}: the hook fee is ${ev.hookFee} lamports, ${bps} bps by hand`);
  return { ...r, ev, pool, info, local, received };
}

async function stake(coin, wallet, amount, label) {
  const before = await client.tokenBalance(wallet.publicKey, coin.mint);
  const r = await send(await client.rulesStakeInstructions(wallet.publicKey, await client.pool(coin.pool), amount), [wallet], label);
  coin.book.stake(wallet.publicKey, amount);
  const mine = coin.book.stakers.get(wallet.publicKey.toBase58());
  const ev = r.events.find((e) => e.kind === "Staked");
  const info = await client.rulesStakeOf(coin.pool, wallet.publicKey);
  check(ev && ev.staker.equals(wallet.publicKey) && ev.amount === amount && ev.staked === mine.amount && ev.totalStaked === coin.book.staked && ev.slot === r.slot,
    `${label}: the Staked event says ${fmt(amount, 6)} coins moved, the wallet has ${fmt(ev.staked, 6)} staked, ${fmt(ev.totalStaked, 6)} are staked in all`);
  check(info.staked === mine.amount && info.record.sinceSlot === r.slot && info.unstakeOpenSlot === r.slot + UNSTAKE_DELAY_SLOTS && !info.canUnstake
    && before - (await client.tokenBalance(wallet.publicKey, coin.mint)) === amount && (await tokenAmount(rulesPda.stakeVault(coin.pool))) === coin.book.staked,
    `${label}: the coins left the wallet for the stake vault; the SDK reads the record and says unstaking opens at slot ${info.unstakeOpenSlot}`);
  return r;
}

/// Right after an instruction that settled: the chain's numbers are the book's, and the
/// treasury holds exactly the fees that were not paid out.
async function agree(coin, label) {
  const st = await client.rulesState(coin.pool);
  const c = st.config, b = coin.book;
  check(st.unsettledFee === 0n && c.creatorOwed === b.creator && c.burnPot === b.burn && c.accPerShare === b.acc && c.rewardRem === b.rem && c.totalStaked === b.staked
    && c.totalCreatorPaid === b.paidCreator && c.totalRewardsPaid === b.paidRewards && c.totalQuoteBurned === b.burnedQuote,
    `${label}: chain and book agree: ${c.creatorOwed} lamports owed to the creator, ${c.burnPot} in the burn pot, ${c.totalRewardsPaid} paid to stakers so far`);
  const treasury = await tokenAmount(coin.treasury);
  check(treasury === b.fees - b.paidCreator - b.paidRewards - b.burnedQuote && st.pool.hookFeesQuoteTotal === b.fees && st.pool.hookFeesOwedQuote === 0n,
    `${label}: the treasury holds ${treasury} lamports: every hook fee the pool charged (${b.fees}) less what was paid out and burned`);
  const dust = treasury - b.promised();
  check(dust >= 0n && dust <= SCALE && dust < 1_000n, `${label}: what is promised to the creator, the stakers and the burn pot is covered, with ${dust} lamports of rounding left over`);
  return st;
}
/// Before an instruction that will settle: the SDK already shows what the chain will write.
async function foresee(coin, label) {
  const st = await client.rulesState(coin.pool);
  const b = coin.book.clone(); b.settle();
  check(st.unsettledFee === (coin.book.last ? coin.book.last.fee : 0n) && st.settled.creatorOwed === b.creator && st.settled.burnPot === b.burn && st.settled.accPerShare === b.acc
    && st.creatorClaimable === b.creator && st.burnPot === b.burn,
    `${label}: the last trade's fee (${st.unsettledFee} lamports) is not split on chain yet, and the SDK already shows the numbers after the split`);
  return st;
}

// ====================================================================================================
console.log(`cluster ${cluster} (${RPC[cluster]}), lookup table ${client.options.lookupTable ? client.options.lookupTable.toBase58() : "none"}`);
const W = Object.fromEntries(["devA", "devB", "devC", "devD", "t1", "s1", "s2", "t2", "x", "stranger"].map((n) => [n, Keypair.generate()]));
await fund([W.devA, W.devB, W.devC, W.devD], 4);
await fund([W.t1, W.s1, W.s2, W.t2, W.x], 6);
await fund([W.stranger], 3);

// ---- 0. what the SDK refuses before building, the program refuses too --------------------------------
section("0. The bounds: the SDK refuses a launch the program would refuse, before it builds anything");
{
  const base = { dev: W.devA.publicKey, name: "No", symbol: "NO", uri: "https://example.com/no.json", decimals: 6, totalSupply: SUPPLY, quoteMint: NATIVE_MINT, lpFeeBps: LP_FEE_BPS, quoteAmount: LIQUIDITY, devBuyQuote: sol(0.1), minDevBuyOut: 1n, template: "rules" };
  const bad = [
    ["CreatorFeeTooHigh", { buy: { creatorBps: RULES_CEILINGS.creatorBps + 1 } }],
    ["HoldersFeeTooHigh", { sell: { holdersBps: RULES_CEILINGS.holdersBps + 1 } }],
    ["BurnFeeTooHigh", { buy: { burnBps: RULES_CEILINGS.burnBps + 1 } }],
    ["SideTooHigh", { sell: { creatorBps: 400, holdersBps: 400, burnBps: 201 } }],
    ["StartFeeTooHigh", { sniperSlots: 10, sniperStartFeeBps: RULES_CEILINGS.sniperStartFeeBps + 1 }],
    ["SniperWindowTooLong", { sniperSlots: RULES_CEILINGS.sniperSlots + 1, sniperStartFeeBps: 1000 }],
    ["SniperIncomplete", { sniperSlots: 10 }],
    ["LimitWindowTooLong", { maxBuyQuote: sol(1), limitSlots: RULES_CEILINGS.limitSlots + 1 }],
    ["LimitIncomplete", { maxBuyQuote: sol(1) }],
    ["LockTooLong", { creatorLockSeconds: RULES_CEILINGS.creatorLockSeconds + 1 }],
  ];
  for (const [code, input] of bad) {
    const args = rulesArgs(input);
    let thrown = null;
    try { await client.launchInstructions({ ...base, mint: Keypair.generate(), rules: input }); } catch (e) { thrown = e.message; }
    if (!(rulesProblems(args)[0]?.code === code && thrown && thrown.includes(code))) check(false, `${code}: the SDK must refuse it by that name`);
    // the same numbers sent to the program by hand, next to a coin made for the purpose: nothing lands
    const mint = Keypair.generate();
    const text = await sendRefused(conn, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix.createToken(W.devA.publicKey, mint.publicKey, { name: "No", symbol: "NO", uri: "https://example.com/no.json", decimals: 6, totalSupply: SUPPLY }),
      ix.rulesInitPoolConfig(W.devA.publicKey, poolKeys(mint.publicKey, NATIVE_MINT), args),
    ], [W.devA, mint], `${code}, sent to the program by hand`);
    check(text.includes("Error Code: " + code), `${code}: the SDK throws before building, and the program refuses the same numbers by the same name`);
  }
  const throws = async (rules, devBuyQuote, word) => { try { await client.launchInstructions({ ...base, mint: Keypair.generate(), devBuyQuote, rules }); } catch (e) { return e.message.includes(word); } return false; };
  check(await throws({ maxBuyQuote: sol(0.05), limitSlots: 100 }, sol(0.1), "BuyTooLarge"), "a first buy above the coin's own buy limit is refused before building: it would fail the launch");
  check(await throws({ creatorLockSeconds: 3600 }, 0n, "first buy"), "a creator lock without a first buy is refused before building: there would be nothing to lock");
  check(await throws({ creatorLockSeconds: RULES_CEILINGS.creatorLockSeconds }, sol(0.1), "declare a shorter lock"), "a lock declared at the ceiling of 365 days is refused before building: with the time a launch needs to land it would end past the ceiling");
  check(rulesProblems(rulesArgs({ buy: { creatorBps: RULES_POLICY.creatorBps + 1 } }), RULES_POLICY)[0].code === "CreatorFeeTooHigh" && rulesProblems(rulesArgs({ buy: { creatorBps: RULES_POLICY.creatorBps + 1 } })).length === 0,
    `the policy bounds are tighter than the ceilings: a creator fee of ${RULES_POLICY.creatorBps + 1} bps is over what a form offers and under what the program takes`);
}

// ---- A. plain: a creator fee only ----------------------------------------------------------------------
section("A. Plain: a creator fee of 1% on buys and sells, nothing else");
const A = await launchCoin("A", "Rules Plain", "RPLAIN", { buy: { creatorBps: 100 }, sell: { creatorBps: 100 } }, { dev: W.devA, devBuy: sol(0.1) });
{
  const a = await trade(A, W.t1, DIRECTION.BUY, sol(0.5), "A: a trader buys for 0.5 SOL", 100);
  measure("swap on a rules pool (buy), without the lookup table", a);
  await trade(A, W.t1, DIRECTION.SELL, a.received / 2n, "A: the trader sells half", 100);
  await trade(A, W.t1, DIRECTION.BUY, sol(0.3), "A: the trader buys for 0.3 SOL", 100);
  const s = await trade(A, W.t1, DIRECTION.SELL, await client.tokenBalance(W.t1.publicKey, A.mint), "A: the trader sells everything", 100);
  measure("swap on a rules pool (sell), without the lookup table", s);

  // the whole fee belongs to the creator, and nothing collects in the burn pot
  const before = await foresee(A, "A");
  check(before.creatorClaimable === A.book.fees && before.burnPot === 0n && before.liquidityOpenSlot === 0n, `A: with only a creator rate every lamport of hook fee is the creator's: ${before.creatorClaimable} of ${A.book.fees}`);
  check((await client.rulesBurnInstructions(W.stranger.publicKey, A.pool)) === null, "A: no burn rate, an empty pot: the SDK offers no burn");
  await refused([ix.rulesRunBurn(W.stranger.publicKey, client.keys(before.pool), 0n)], [W.stranger], "A: a burn sent by hand all the same", "NothingToBurn");

  // only the launcher claims
  let said = null;
  try { await client.rulesClaimCreatorInstructions(W.stranger.publicKey, before.pool); } catch (e) { said = e.message; }
  check(said !== null, "A: the SDK refuses to build a creator claim for another wallet");
  await refused([ix.createAtaIdempotent(W.stranger.publicKey, W.stranger.publicKey, NATIVE_MINT), ix.rulesClaimCreator(W.stranger.publicKey, client.keys(before.pool))], [W.stranger], "A: a stranger claims the creator fee by hand", "NotCreator");

  // the launcher had no wrapped SOL account (the launch closed the one it opened): it is paid plain SOL
  const claim = await client.rulesClaimCreatorInstructions(W.devA.publicKey, before.pool);
  const lamports = BigInt(await conn.getBalance(W.devA.publicKey));
  check(claim.amount === before.creatorClaimable && claim.instructions.length === 3 && !(await client.exists(pda.ata(W.devA.publicKey, NATIVE_MINT))), `A: the SDK says the claim pays ${fmt(claim.amount)} SOL and builds three instructions: open a wrapped SOL account, claim, close it`);
  const r = await send(claim.instructions, [W.devA], "A: the launcher claims the creator fee");
  measure("claim_creator (with the wrapped SOL account opened and closed)", r);
  const paid = A.book.claimCreator();
  const ev = r.events.find((e) => e.kind === "CreatorClaimed");
  check(paid === claim.amount && ev && ev.amount === paid && ev.creator.equals(W.devA.publicKey) && BigInt(await conn.getBalance(W.devA.publicKey)) - lamports === paid - NETWORK_FEE && !(await client.exists(pda.ata(W.devA.publicKey, NATIVE_MINT))),
    `A: the launcher's wallet grew by exactly ${paid} lamports of plain SOL (less the network fee), and it holds no wrapped SOL account`);
  const after = await agree(A, "A");
  check(after.config.creatorOwed === 0n && (await tokenAmount(A.treasury)) === 0n, "A: the treasury is empty: nothing was lost to rounding on a coin with one rate");
  const none = await client.rulesClaimCreatorInstructions(W.devA.publicKey, after.pool);
  check(none.amount === 0n && none.instructions.length === 0, "A: with nothing to claim the SDK builds nothing");
  await refused([ix.createAtaIdempotent(W.devA.publicKey, W.devA.publicKey, NATIVE_MINT), ix.rulesClaimCreator(W.devA.publicKey, client.keys(after.pool))], [W.devA], "A: a second claim by hand", "NothingToClaim");
}

// ---- nothing can change a rule ---------------------------------------------------------------------------
section("A. Nobody can change a rule: what a client could try");
{
  const k = client.keys(await client.pool(A.pool));
  const other = rulesArgs({ buy: { creatorBps: 500 }, sell: { creatorBps: 500 } });
  await refused([ix.rulesInitPoolConfig(W.devA.publicKey, k, other)], [W.devA], "the launcher sends init_pool_config again with a creator fee of 5%", "already in use");
  await refused([ix.rulesInitPoolConfig(W.stranger.publicKey, k, other)], [W.stranger], "a stranger sends init_pool_config for the same pool", "already in use");
  // instructions that do not exist: the names a client might guess, sent by the launcher with the config writable
  const guesses = ["set_rules", "update_rules", "update_pool_config", "set_pool_config", "set_fee", "set_fees", "set_rates", "set_tax", "set_creator", "set_owner", "set_treasury", "set_limit", "close_config", "migrate"];
  let unknown = 0;
  for (const name of guesses) {
    const data = Buffer.concat([Buffer.from(anchorDiscriminator("global", name)), Buffer.alloc(64)]);
    const keys = [{ pubkey: W.devA.publicKey, isSigner: true, isWritable: true }, { pubkey: rulesPda.cfg(A.pool), isSigner: false, isWritable: true }, { pubkey: A.pool, isSigner: false, isWritable: false }, { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }];
    const sim = new Transaction().add(new TransactionInstruction({ programId: PROGRAMS.hook_rules, keys, data }));
    sim.feePayer = W.devA.publicKey;
    const res = await conn.simulateTransaction(sim, [W.devA]);
    if (res.value.err && (res.value.logs ?? []).join("\n").includes("InstructionFallbackNotFound")) unknown++;
  }
  check(unknown === guesses.length, `the program has no instruction named ${guesses.join(", ")}: all ${guesses.length} are answered with InstructionFallbackNotFound`);
  // the callbacks are the only code that writes the config after launch, and only the pool may call them
  const callback = (name, payload) => new TransactionInstruction({
    programId: PROGRAMS.hook_rules,
    data: Buffer.concat([Buffer.from(anchorDiscriminator("global", name)), payload]),
    keys: [
      { pubkey: A.pool, isSigner: false, isWritable: false }, { pubkey: W.stranger.publicKey, isSigner: true, isWritable: false }, { pubkey: W.stranger.publicKey, isSigner: false, isWritable: false },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false }, { pubkey: A.mint, isSigner: false, isWritable: false }, { pubkey: rulesPda.cfg(A.pool), isSigner: false, isWritable: true },
    ],
  });
  await refused([callback("before_swap", Buffer.alloc(51))], [W.stranger], "a wallet calls before_swap itself, signing where the pool signs", "CallerMismatch");
  await refused([callback("on_pool_create", Buffer.alloc(50))], [W.stranger], "a wallet calls on_pool_create itself, to start the config again", "CallerMismatch");
  check((await ruleBytes(A.pool)) === A.rulesAtLaunch, "after all of it, bytes 8 to 239 of the config (the rules and the launch data) are what they were at launch");
}

// ---- B. holder rewards and burn, different rates on buys and sells ------------------------------------------
section("B. Holder rewards and burn. Buys: creator 0.5%, holders 1%, burn 0.5%. Sells: creator 1%, holders 2%, burn 1%");
const B = await launchCoin("B", "Rules Rewards", "RSTAKE", { buy: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, sell: { creatorBps: 100, holdersBps: 200, burnBps: 100 } }, { dev: W.devB, devBuy: sol(0.2), table: true });
{
  // The cap of one buy of the burn, by hand (RULES.md): only what nobody gets back counts,
  // the protocol fee and the burn share of what each side is charged. The creator's share
  // comes back to the creator and the holders' share to the stakers.
  const burnShare = (side) => { const total = side.creatorBps + side.holdersBps + side.burnBps; return total === 0 ? 0 : Math.floor((Math.min(total, platform.maxHookFeeBps) * side.burnBps) / total); };
  const sure = platform.protocolFeeBps + burnShare(B.args.buy) + burnShare(B.args.sell);
  const soft = platform.protocolFeeBps + 2 * LP_FEE_BPS;
  const capBps = Math.min(50, Math.max(1, Math.floor((sure + Math.min(sure, soft)) / 4)));
  const capOf = (depth) => { const c = (depth * BigInt(capBps)) / 10_000n; return c > 1n ? c : 1n; };
  const least = (a, b) => (a < b ? a : b);

  // nothing staked: a trade pays all three rates all the same, 2% on a buy and 4% on a sell
  await trade(B, W.s1, DIRECTION.BUY, sol(0.5), "B: a wallet buys for 0.5 SOL while nothing is staked", 200);
  const b2 = await trade(B, W.s2, DIRECTION.BUY, sol(0.4), "B: a second wallet buys for 0.4 SOL", 200);
  // a stake under 0.1% of the supply changes nothing
  const st1 = await stake(B, W.s1, 400_000n * UNIT, "B: the first wallet stakes 400,000 coins, under the 0.1% of the supply the stakers need");
  measure("stake, first time (opens the stake record)", st1);
  {
    const st = await agree(B, "B, after the first stake");
    check(!st.stakersEligible && st.config.accPerShare === 0n && B.book.holdersShared === 0n && B.book.holdersBurned > 0n && st.config.burnPot === B.book.fees - st.config.creatorOwed,
      `B: with too little staked the holders' share of the first three buys, ${B.book.holdersBurned} lamports, went to the burn pot: the pot holds everything that is not the creator's`);
  }
  await trade(B, W.s2, DIRECTION.SELL, b2.received / 4n, "B: a sell while too little is staked pays the three rates of the sell side", 400);
  // enough staked: from the next trade on the holders' share is the stakers'
  let quoteBefore;
  { const pool = await client.pool(B.pool); quoteBefore = await client.quoteLocal(pool, platform, DIRECTION.BUY, sol(0.5), await client.hookInfo(pool)); }
  const st2 = await stake(B, W.s1, 99_600_000n * UNIT, "B: the first wallet stakes up to 100,000,000 coins");
  measure("stake, a later time", st2);
  {
    const st = await agree(B, "B, after the second stake");
    check(st.stakersEligible && st.config.accPerShare === 0n, "B: the SDK says the stakers are eligible now. The sell before this stake was settled by the stake itself, with the total as it was, so its holders' share was burned too");
    const pool = await client.pool(B.pool);
    const quoteAfter = await client.quoteLocal(pool, platform, DIRECTION.BUY, sol(0.5), await client.hookInfo(pool));
    check(quoteAfter.amountOut === quoteBefore.amountOut && quoteAfter.hookFee === buyHookFee(sol(0.5), 200), "B: the quote of a buy is the same before and after the stake: what a trader pays does not depend on anybody's stake");
  }
  const shared = await trade(B, W.t2, DIRECTION.BUY, sol(0.5), "B: a buy with enough staked pays the same 2%", 200);
  await stake(B, W.s2, 50_000_000n * UNIT, "B: the second wallet stakes 50,000,000 coins");
  {
    const st = await agree(B, "B, after the third stake");
    // that buy's holders' share by hand: 1% of the 2%, so half of its hook fee, all of it for the one staker
    const share = (shared.ev.hookFee * 100n) / 200n;
    check(B.book.holdersShared === share && st.config.accPerShare === (share * SCALE) / (100_000_000n * UNIT), `B: the holders' share of that buy, ${share} lamports, went to the stakers: the accumulator holds that amount per staked unit`);
  }
  const shares = [await client.rulesStakeOf(B.pool, W.s1.publicKey), await client.rulesStakeOf(B.pool, W.s2.publicKey)];
  check(shares[0].shareBps === 6_666 && shares[1].shareBps === 3_333, "B: the SDK reads the two stakes as two thirds and one third of everything staked");
  await trade(B, W.t2, DIRECTION.SELL, (await client.tokenBalance(W.t2.publicKey, B.mint)) / 2n, "B: a sell with enough staked pays the same 4%", 400);
  // trade until the burn pot holds clearly more than one buy may spend
  for (let round = 0; round < 6; round++) {
    const st = await client.rulesState(B.pool);
    if (st.burnPot > (capOf(st.pool.reserveQuote) * 5n) / 2n) break;
    const buy = await trade(B, W.t2, DIRECTION.BUY, sol(0.8), `B: round ${round + 1}, a buy for 0.8 SOL`, 200);
    await trade(B, W.t2, DIRECTION.SELL, buy.received, `B: round ${round + 1}, the same coins sold`, 400);
  }

  // what each staker can claim: the SDK's number is the book's, with the last trade counted in
  await foresee(B, "B");
  const ahead = B.book.clone();
  const want1 = ahead.claim(W.s1.publicKey), want2 = ahead.claim(W.s2.publicKey);
  const pool = await client.pool(B.pool);
  const c1 = await client.rulesClaimRewardsInstructions(W.s1.publicKey, pool);
  const info2 = await client.rulesStakeOf(B.pool, W.s2.publicKey);
  check(c1.amount === want1 && info2.claimable === want2 && want1 > want2 && want2 > 0n,
    `B: the SDK says the first staker can claim ${fmt(want1)} SOL and the second ${fmt(want2)} SOL, to the lamport what the book says (the first staked earlier and twice as much)`);
  // the first staker has no wrapped SOL account: plain SOL
  const lamports1 = BigInt(await conn.getBalance(W.s1.publicKey));
  check(c1.instructions.length === 3 && !(await client.exists(pda.ata(W.s1.publicKey, NATIVE_MINT))), "B: for a wallet without a wrapped SOL account the SDK builds: open one, claim, close it");
  const r1 = await send(c1.instructions, [W.s1], "B: the first staker claims its rewards");
  measure("claim_rewards (with the wrapped SOL account opened and closed)", r1);
  const paid1 = B.book.claim(W.s1.publicKey);
  const e1 = r1.events.find((e) => e.kind === "RewardsClaimed");
  check(paid1 === want1 && e1 && e1.amount === paid1 && e1.staker.equals(W.s1.publicKey) && BigInt(await conn.getBalance(W.s1.publicKey)) - lamports1 === paid1 - NETWORK_FEE && !(await client.exists(pda.ata(W.s1.publicKey, NATIVE_MINT))),
    `B: its wallet grew by exactly ${paid1} lamports of plain SOL (less the network fee); the RewardsClaimed event says the same`);
  await agree(B, "B, after the first claim");
  // the second staker already has a wrapped SOL account: it is paid into it and the account stays
  await send([ix.createAtaIdempotent(W.s2.publicKey, W.s2.publicKey, NATIVE_MINT)], [W.s2], "B: the second staker opens a wrapped SOL account of its own");
  const c2 = await client.rulesClaimRewardsInstructions(W.s2.publicKey, pool);
  check(c2.amount === want2 && c2.instructions.length === 1, "B: for a wallet that has a wrapped SOL account the SDK builds the claim alone");
  const r2 = await send(c2.instructions, [W.s2], "B: the second staker claims its rewards");
  measure("claim_rewards alone", r2);
  const paid2 = B.book.claim(W.s2.publicKey);
  check(paid2 === want2 && (await client.tokenBalance(W.s2.publicKey, NATIVE_MINT)) === paid2 && r2.events.find((e) => e.kind === "RewardsClaimed").amount === paid2,
    `B: its wrapped SOL account holds exactly the ${paid2} lamports of the claim and is still open`);
  await agree(B, "B, after the second claim");
  const again = await client.rulesClaimRewardsInstructions(W.s2.publicKey, pool);
  check(again.amount === 0n && again.instructions.length === 0, "B: with nothing more to claim the SDK builds nothing");
  await refused([ix.rulesClaimRewards(W.s2.publicKey, client.keys(pool))], [W.s2], "B: a second claim by hand", "NothingToClaim");
  // nobody claims for somebody else: the stake record is found from the signer
  const theft = ix.rulesClaimRewards(W.stranger.publicKey, client.keys(pool));
  theft.keys[3] = { pubkey: rulesPda.stake(B.pool, W.s1.publicKey), isSigner: false, isWritable: true };
  await refused([ix.createAtaIdempotent(W.stranger.publicKey, W.stranger.publicKey, NATIVE_MINT), theft], [W.stranger], "B: a stranger names the first staker's record in a claim of its own", "ConstraintSeeds");

  // staked coins stay for about an hour
  const s1 = await client.rulesStakeOf(B.pool, W.s1.publicKey);
  const slotNow = BigInt(await conn.getSlot("confirmed"));
  check(!s1.canUnstake && s1.unstakeOpenSlot > slotNow, `B: the SDK says unstaking is closed for another ${s1.unstakeOpenSlot - slotNow} slots (about ${Math.round(Number(s1.unstakeOpenSlot - slotNow) * 0.4 / 60)} minutes)`);
  await refused(await client.rulesUnstakeInstructions(W.s1.publicKey, pool, 1n * UNIT), [W.s1], "B: the first staker tries to take one coin back now", "UnstakeTooEarly");

  // The burn. It never buys at a price or on a depth its caller just made: a buy is measured
  // against an observation of the pool that the instruction itself recorded at least 25
  // slots earlier, and it spends at most the cap of the smaller of the two depths.
  const supplyNow = async () => (await client.mint(B.mint)).supply;
  const burnEvent = (r) => r.events.find((e) => e.kind === "BurnExecuted");
  const before = await foresee(B, "B, before the burn");
  const supply0 = await supplyNow();

  // 1. the first call only records the pool
  const first = await client.rulesBurnInstructions(W.stranger.publicKey, B.pool);
  check(first.step === "observe" && first.due && first.observation === null && first.dueSlot === 0n && first.instructions.length > 0 && first.capBps === capBps && first.pot === before.burnPot,
    `B: the pot holds ${fmt(first.pot)} SOL and the burn never looked at this pool: the SDK says the first call only records it. The cap of a buy is ${capBps} bps, as worked out by hand`);
  const r0 = await send(first.instructions, [W.stranger], "B: a stranger calls the burn for the first time");
  measure("run_burn that records an observation", r0);
  B.book.settle();
  const st0 = await agree(B, "B, after the first call of the burn");
  const e0 = burnEvent(r0);
  check(e0 && e0.outcome === BURN_OUTCOME.OBSERVED && e0.quoteSpent === 0n && e0.baseBurned === 0n && e0.obsReserveBase === st0.pool.reserveBase && e0.obsReserveQuote === st0.pool.reserveQuote
    && st0.config.obsSlot === r0.slot && st0.config.obsReserveBase === st0.pool.reserveBase && st0.config.obsReserveQuote === st0.pool.reserveQuote && st0.config.burns === 0n && (await supplyNow()) === supply0,
    `B: it bought nothing and recorded the pool's reserves in slot ${r0.slot}; the BurnExecuted event (an inner instruction) says so with outcome ${BURN_OUTCOME.OBSERVED}`);

  // 2. a call inside 25 slots is refused and writes nothing
  const soon = await client.rulesBurnInstructions(W.stranger.publicKey, B.pool);
  check(soon.step === "tooSoon" && !soon.due && soon.dueSlot === r0.slot + BURN_INTERVAL_SLOTS && soon.instructions.length === 0 && soon.observation.slot === r0.slot && soon.spend === least(soon.pot, capOf(st0.pool.reserveQuote)),
    `B: the SDK says a call is refused before slot ${soon.dueSlot}, builds nothing to send, and estimates the buy that follows at ${fmt(soon.spend)} SOL`);
  await refused([ix.rulesRunBurn(W.stranger.publicKey, client.keys(st0.pool), 0n)], [W.stranger], "B: a second call in the same 25 slots, by hand", "BurnTooSoon");

  // 3. 25 slots later, the price having stood, it buys
  await waitForSlot(conn, soon.dueSlot);
  const run = await client.rulesBurnInstructions(W.stranger.publicKey, B.pool);
  const cap = capOf(least(st0.pool.reserveQuote, run.observation.reserveQuote));
  check(run.step === "buy" && run.due && run.pot > cap && run.spend === cap && run.potLeft === run.pot - cap,
    `B: from slot ${soon.dueSlot} on the call buys. One buy may spend ${capBps} bps of the pool's SOL: ${fmt(cap)} SOL by hand, and that is what the SDK says this one spends of the ${fmt(run.pot)} SOL in the pot`);
  const rb = await send(run.instructions, [W.stranger], "B: a stranger calls the burn again, 25 slots later");
  measure("run_burn that buys and burns", rb);
  B.book.burnRun(run.spend);
  const burned = supply0 - (await supplyNow());
  const be = burnEvent(rb);
  check(burned === run.expectedOut && burned > 0n && (await tokenAmount(rulesPda.burnAccount(B.pool, B.mint))) === 0n, `B: it bought ${fmt(burned, 6)} coins, exactly the SDK's quote, and burned them all: the supply fell by that much and the burn account is empty`);
  const afterBurn = await agree(B, "B, after the burn");
  check(be && be.outcome === BURN_OUTCOME.BOUGHT && be.quoteSpent === run.spend && be.baseBurned === burned && be.slot === rb.slot && be.obsReserveQuote === afterBurn.pool.reserveQuote
    && rb.events.some((e) => e.kind === "Swapped" && e.byHook && e.hookFee === 0n),
    "B: the BurnExecuted event says what was spent and burned; the pool's own event marks the buy as made by the hook, with no hook fee");
  check(afterBurn.config.burns === 1n && afterBurn.config.obsSlot === rb.slot && afterBurn.config.obsReserveQuote === afterBurn.pool.reserveQuote && afterBurn.config.totalBaseBurned === burned && afterBurn.config.burnPot === run.potLeft,
    `B: the config counts one buy, holds the pool as the buy left it as its new observation, and the pot holds the predicted ${fmt(run.potLeft)} SOL`);

  // 4. again inside 25 slots: refused
  const soon2 = await client.rulesBurnInstructions(W.stranger.publicKey, B.pool);
  check(soon2.step === "tooSoon" && soon2.dueSlot === rb.slot + BURN_INTERVAL_SLOTS && soon2.instructions.length === 0, `B: a second buy is not due before slot ${soon2.dueSlot}`);
  await refused([ix.rulesRunBurn(W.stranger.publicKey, client.keys(afterBurn.pool), 0n)], [W.stranger], "B: a second buy in the same 25 slots, by hand", "BurnTooSoon");

  // 5. somebody buys first to push the price up: the call that follows buys nothing
  const pumped = await trade(B, W.t2, DIRECTION.BUY, sol(0.8), "B: a wallet buys for 0.8 SOL before the next call of the burn", 200);
  await waitForSlot(conn, soon2.dueSlot);
  const ran = await client.rulesBurnInstructions(W.stranger.publicKey, B.pool);
  check(ran.step === "wait" && ran.due && ran.instructions.length > 0, "B: the price is above the observed one by more than the tolerance (twice the cap, 1%): the SDK says the call will only record the pool again");
  const supply1 = await supplyNow();
  const rw = await send(ran.instructions, [W.stranger], "B: the call of the burn after that buy");
  B.book.settle();
  const stw = await agree(B, "B, after the call that waited");
  const ew = burnEvent(rw);
  check(ew && ew.outcome === BURN_OUTCOME.WAITED && ew.quoteSpent === 0n && ew.baseBurned === 0n && stw.config.burns === 1n && stw.config.obsSlot === rw.slot && stw.config.obsReserveQuote === stw.pool.reserveQuote && (await supplyNow()) === supply1,
    `B: it bought nothing (outcome ${BURN_OUTCOME.WAITED}) and recorded the pool at the new price: the price has to stand for 25 slots before the burn buys at it`);

  // 6. The pumped price does not stand: the wallet sells back, and the next trade starts
  //    below the price the burn recorded. The hook lowers the observation to the reserves
  //    that trade starts from, and keeps its slot, so the burn is not put off.
  await trade(B, W.t2, DIRECTION.SELL, pumped.received, "B: the wallet sells back what it bought", 400);
  const afterSell = await client.rulesState(B.pool);
  check(afterSell.config.obsReserveBase === stw.config.obsReserveBase && afterSell.config.obsReserveQuote === stw.config.obsReserveQuote,
    "B: the sell started at the observed price, so it left the observation alone");
  await trade(B, W.t2, DIRECTION.BUY, sol(0.001), "B: a small buy, the first trade to start below the observed price", 200);
  const lowered = await client.rulesState(B.pool);
  const expectLow = burnLowered({ slot: stw.config.obsSlot, reserveBase: stw.config.obsReserveBase, reserveQuote: stw.config.obsReserveQuote }, afterSell.pool.reserveBase, afterSell.pool.reserveQuote);
  check(expectLow !== null && lowered.config.obsReserveBase === expectLow.reserveBase && lowered.config.obsReserveQuote === expectLow.reserveQuote && lowered.config.obsSlot === rw.slot
    && lowered.config.obsReserveQuote < stw.config.obsReserveQuote && lowered.config.obsReserveQuote <= afterSell.pool.reserveQuote,
    "B: the hook lowered the observation to the price that buy started at (the SDK's burnLowered gives the same two numbers), kept its slot and did not raise its depth: the pumped price is no longer what the burn measures against");

  // 7. 25 slots after the call that waited the burn buys, at the price that stood
  await waitForSlot(conn, rw.slot + BURN_INTERVAL_SLOTS);
  const second = await client.rulesBurnInstructions(W.stranger.publicKey, B.pool);
  const depth = least(lowered.pool.reserveQuote, lowered.config.obsReserveQuote);
  check(second.step === "buy" && second.spend === least(second.pot, capOf(depth)), `B: 25 slots after the call that waited the burn buys again, for ${fmt(second.spend)} SOL: the cap of the smaller of the two depths`);
  await send(second.instructions, [W.stranger], "B: the second buy of the burn");
  B.book.burnRun(second.spend);
  check(supply1 - (await supplyNow()) === second.expectedOut, "B: it burned exactly the SDK's quote again");
  check((await agree(B, "B, after the second buy of the burn")).config.burns === 2n, "B: two buys counted");

  // the launcher takes its share
  const claim = await client.rulesClaimCreatorInstructions(W.devB.publicKey, afterBurn.pool);
  await send(claim.instructions, [W.devB], "B: the launcher claims the creator fee");
  check(B.book.claimCreator() === claim.amount && claim.amount > 0n, `B: the creator fee paid is the book's ${fmt(claim.amount)} SOL`);
  await agree(B, "B, at the end");
}

// ---- C. sniper fee and buy limit -----------------------------------------------------------------------------
section("C. A sniper fee from 30% over 100 slots, a buy limit of 0.2 SOL for 150 slots, a creator fee of 1%, and a lock of 30 days declared");
const SNIPER = 100n, LIMIT = 150n, MAX_BUY = sol(0.2), DECLARED = 30n * 86_400n;
const C = await launchCoin("C", "Rules Sniper", "RSNIPE",
  { sniperSlots: SNIPER, sniperStartFeeBps: 3_000, maxBuyQuote: MAX_BUY, limitSlots: LIMIT, buy: { creatorBps: 100 }, sell: { creatorBps: 100 }, creatorLockSeconds: DECLARED },
  { dev: W.devC, devBuy: sol(0.1), table: true, dropLock: true });
{
  const start = C.launch.slot;
  check(C.first.feeBpsApplied === 3_000, "C: the launcher's own first buy paid the sniper fee of the first slot in full, 30%");
  // inside both windows
  const w1 = await trade(C, W.x, DIRECTION.BUY, sol(0.1), "C: a buy for 0.1 SOL inside the sniper window", 100, { window: true });
  const limit = rulesBuyLimit(w1.info.rules, w1.slot);
  check(limit && limit.maxBuyQuote === MAX_BUY && limit.untilSlot === start + LIMIT, `C: the SDK reads the buy limit: at most ${fmt(MAX_BUY)} SOL per buy until slot ${limit.untilSlot}`);
  await trade(C, W.x, DIRECTION.BUY, MAX_BUY, "C: a buy of exactly the limit, 0.2 SOL", 100, { window: true });
  {
    const pool = await client.pool(C.pool);
    let said = null;
    try { await client.quoteLocal(pool, platform, DIRECTION.BUY, MAX_BUY + 1n, await client.hookInfo(pool)); } catch (e) { said = e.message; }
    check(said !== null && said.includes("buy limit"), "C: the SDK refuses to quote a buy one lamport above the limit");
    await refused(await client.swapInstructions(W.x.publicKey, pool, await client.hookRef(pool, W.x.publicKey), DIRECTION.BUY, MAX_BUY + 1n, 0n), [W.x], "C: that buy, sent all the same", "BuyTooLarge");
  }
  // No liquidity is added while the sniper fee runs: the fee is a pool fee, and a wallet
  // that added liquidity for a moment would take part of every sniper's fee out with it.
  const liquidity = async () => {
    const pool = await client.pool(C.pool);
    const lpSupply = (await client.mint(pool.lpMint)).supply;
    const lp = lpSupply / 1_000n;                      // a thousandth of the pool
    const most = (reserve) => (mulDivCeil(lp, reserve, lpSupply) * 101n) / 100n;
    return { pool, lp, ixs: await client.addLiquidityInstructions(W.x.publicKey, pool, lp, most(pool.reserveBase), most(pool.reserveQuote)) };
  };
  check((await client.rulesState(C.pool)).liquidityOpenSlot === start + SNIPER, `C: the SDK says liquidity can be added from slot ${start + SNIPER} on, the end of the sniper window`);
  await refused((await liquidity()).ixs, [W.x], "C: a wallet adds liquidity inside the sniper window", "LiquidityInSniperWindow");
  const sell = await trade(C, W.x, DIRECTION.SELL, (await client.tokenBalance(W.x.publicKey, C.mint)) / 2n, "C: a sell inside both windows is not touched by either", 100);
  check(sell.slot < start + SNIPER, `C: all of that happened inside the sniper window (it ends at slot ${start + SNIPER}; the sell landed in ${sell.slot})`);
  // sniper window over, limit still on
  console.log(`  waiting for the sniper window to end (slot ${start + SNIPER})`);
  await waitForSlot(conn, start + SNIPER);
  const mid = await trade(C, W.x, DIRECTION.BUY, sol(0.1), "C: a buy after the sniper window, still inside the limit window", 100);
  check(mid.slot >= start + SNIPER && mid.slot < start + LIMIT, "C: it landed between the end of the sniper window and the end of the limit window");
  {
    const add = await liquidity();
    const ra = await send(add.ixs, [W.x], "C: the same wallet adds liquidity after the sniper window");
    const ea = ra.events.find((e) => e.kind === "LiquidityChanged");
    check(ea && ea.added && ea.lpAmount === add.lp && (await client.tokenBalance(W.x.publicKey, add.pool.lpMint)) === add.lp, "C: it passes now: the wallet holds the LP it asked for");
    const rr = await send(await client.removeLiquidityInstructions(W.x.publicKey, await client.pool(C.pool), add.lp, 0n, 0n), [W.x], "C: and takes it out again");
    check(rr.events.some((e) => e.kind === "LiquidityChanged" && !e.added && e.lpAmount === add.lp) && (await client.tokenBalance(W.x.publicKey, add.pool.lpMint)) === 0n, "C: removing liquidity never calls the hook and is never refused");
  }
  {
    const pool = await client.pool(C.pool);
    await refused(await client.swapInstructions(W.x.publicKey, pool, await client.hookRef(pool, W.x.publicKey), DIRECTION.BUY, sol(0.5), 0n), [W.x], "C: a buy for 0.5 SOL while the limit still runs", "BuyTooLarge");
  }
  console.log(`  waiting for the buy limit to end (slot ${start + LIMIT})`);
  await waitForSlot(conn, start + LIMIT);
  const big = await trade(C, W.x, DIRECTION.BUY, sol(0.5), "C: the same buy for 0.5 SOL after the limit window", 100);
  check(big.slot >= start + LIMIT && rulesBuyLimit(big.info.rules, big.slot) === null, "C: it passed, and the SDK says no limit is in force");

  // a lock that was declared and not made: the program cannot make a launcher lock anything
  const pool = await client.pool(C.pool);
  let lock = await client.rulesLock(C.pool);
  const held = await client.tokenBalance(W.devC.publicKey, C.mint);
  check(lock.record === null && lock.vaultBalance === 0n && !lock.locked && lock.declaredSeconds === DECLARED && lock.declaredUntil === (await client.rulesState(C.pool)).config.startTime + DECLARED && held === C.first.amountOut,
    "C: this launch left the lock instruction out. The config still says 30 days; the SDK's lock reader says the truth: no record, nothing in the vault, the launcher holds its coins");
  const now = (await client.chainTime()).unixTime;
  await refused(await client.rulesLockInstructions(W.devC.publicKey, pool, LOCK_WHOLE_BALANCE, now + 3_600n), [W.devC], "C: the launcher locks its coins for one hour only", "UnlockBeforeDeclared");
  const until = lock.declaredUntil + 60n;
  const rl = await send(await client.rulesLockInstructions(W.devC.publicKey, pool, LOCK_WHOLE_BALANCE, until), [W.devC], "C: the launcher locks everything it holds until a minute past the declared 30 days");
  measure("lock_creator, first call (opens the lock record and the vault)", rl);
  const le = rl.events.find((e) => e.kind === "CreatorLocked");
  lock = await client.rulesLock(C.pool);
  check(le && le.amount === held && le.locked === held && le.unlockAt === until && lock.locked && lock.vaultBalance === held && lock.record.amount === held && lock.unlockAt === until
    && (await client.tokenBalance(W.devC.publicKey, C.mint)) === 0n, `C: ${fmt(held, 6)} coins are in the lock vault until Unix time ${until}; the launcher's wallet holds none`);
  await refused(await client.rulesLockInstructions(W.devC.publicKey, pool, 0n, until - 1n), [W.devC], "C: the launcher moves the end of the lock one second earlier", "UnlockEarlier");
  await refused(await client.rulesLockInstructions(W.devC.publicKey, pool, 0n, now + BigInt(RULES_CEILINGS.creatorLockSeconds) + 3_600n), [W.devC], "C: the launcher moves it more than 365 days ahead", "UnlockTooFar");
  await refused(await client.rulesUnlockInstructions(W.devC.publicKey, pool), [W.devC], "C: the launcher takes the coins back now", "StillLocked");
  await send((await client.rulesClaimCreatorInstructions(W.devC.publicKey, pool)).instructions, [W.devC], "C: the launcher claims the creator fee");
  C.book.claimCreator();
  await agree(C, "C, at the end");
}

// ---- D. a creator lock inside the launch -------------------------------------------------------------------------
section("D. A creator lock made in the launch transaction: 4 seconds declared, so that it can be watched opening");
const LOCK_SECONDS = 4n, MARGIN = 12;
const D = await launchCoin("D", "Rules Locked", "RLOCK", { buy: { creatorBps: 50 }, sell: { creatorBps: 50 }, creatorLockSeconds: LOCK_SECONDS, lockMarginSeconds: MARGIN }, { dev: W.devD, devBuy: sol(0.3), table: true });
{
  const pool = await client.pool(D.pool);
  const cfg = (await client.rulesState(D.pool)).config;
  let lock = await client.rulesLock(D.pool);
  check(D.plan.lock && D.plan.lock.unlockAt === D.plan.lock.landBefore + LOCK_SECONDS && cfg.startTime <= D.plan.lock.landBefore, `D: the SDK set the end of the lock to the chain's time at building + ${MARGIN} seconds to land + the ${LOCK_SECONDS} seconds declared; the launch landed in time`);
  check(lock.record && lock.record.amount === D.first.amountOut && lock.vaultBalance === D.first.amountOut && lock.unlockAt === D.plan.lock.unlockAt && lock.unlockAt >= lock.declaredUntil
    && (await client.tokenBalance(W.devD.publicKey, D.mint)) === 0n,
    `D: everything the first buy bought, ${fmt(D.first.amountOut, 6)} coins, went from the buy into the lock vault in the same transaction; the launcher's wallet holds none`);
  const le = D.launch.events.find((e) => e.kind === "CreatorLocked");
  if (le) check(le.amount === D.first.amountOut && le.locked === le.amount && le.unlockAt === lock.unlockAt && le.creator.equals(W.devD.publicKey), "D: the launch transaction carries the CreatorLocked event");
  else console.log("  NOTE   the CreatorLocked event is not in the launch transaction's logs: " + (D.launch.logs.some((l) => l.includes("Log truncated")) ? "the node cut the logs of this transaction (\"Log truncated\")" : "no such log line"));
  check(lock.locked, "D: the SDK says the coins are locked");
  await refused(await client.rulesUnlockInstructions(W.devD.publicKey, pool), [W.devD], "D: the launcher takes the coins back at once", "StillLocked");
  await refused([ix.rulesUnlockCreator(W.stranger.publicKey, client.keys(pool), pda.ata(W.devD.publicKey, D.mint))], [W.stranger], "D: a stranger sends the unlock", "NotCreator");
  // the end can move later, never earlier
  const later = lock.unlockAt + 3n;
  const rl = await send(await client.rulesLockInstructions(W.devD.publicKey, pool, 0n, later), [W.devD], "D: the launcher moves the end of the lock three seconds later, adding no coins");
  measure("lock_creator, a later call", rl);
  lock = await client.rulesLock(D.pool);
  check(lock.unlockAt === later && lock.record.amount === D.first.amountOut, "D: the record carries the later time and the same coins");
  console.log(`  waiting for the chain's clock to reach ${later}`);
  while ((await client.chainTime()).unixTime < later) await sleep(500);
  lock = await client.rulesLock(D.pool);
  check(!lock.locked && lock.vaultBalance === D.first.amountOut, "D: the time has come: the SDK says the lock is open, the coins are still in the vault");
  const ru = await send(await client.rulesUnlockInstructions(W.devD.publicKey, pool), [W.devD], "D: the launcher takes the coins back");
  measure("unlock_creator", ru);
  const ue = ru.events.find((e) => e.kind === "CreatorUnlocked");
  lock = await client.rulesLock(D.pool);
  check(ue && ue.amount === D.first.amountOut && (await client.tokenBalance(W.devD.publicKey, D.mint)) === D.first.amountOut && lock.vaultBalance === 0n && lock.record.amount === 0n && lock.record.unlockAt === 0n && !lock.locked,
    "D: all of them are back in the launcher's wallet, the vault is empty and the record reads zero");
  const t = await trade(D, W.t1, DIRECTION.BUY, sol(0.2), "D: the coin trades like any other", 50);
  measure("swap on a rules pool (buy), second measure", t);
}

// ---- the rules never moved ----------------------------------------------------------------------------------------
section("All four: the rules at the end are the rules at launch");
for (const c of coins) check((await ruleBytes(c.pool)) === c.rulesAtLaunch, `${c.letter}: bytes 8 to 239 of the config did not change through any of it`);

console.log("\ncompute units and sizes (sent transactions):");
for (const m of measures) {
  const sizes = m.sizes ? `; ${fits(m.sizes.legacy)} without the lookup table, ${fits(m.sizes.v0)} with it` : `; ${m.size} bytes ${m.table ? "with" : "without"} the lookup table`;
  console.log(`  ${m.what}: ${m.cu} compute units${sizes}`);
}
console.log("\ncoins left on the chain:");
for (const c of coins) console.log(`  ${c.letter}  ${c.name} (${c.symbol})  coin ${c.mint.toBase58()}  pool ${c.pool.toBase58()}  launcher ${c.dev.publicKey.toBase58()}`);
console.log(`\nrules e2e passed: ${checks} checks`);
