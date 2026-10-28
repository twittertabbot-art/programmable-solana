// The strict coin of the "launch rules" template (RULES.md, "The strict coin") end to end
// through the SDK on a live chain. A strict coin is a Token-2022 coin whose transfer hook is
// hook_rules: the program runs inside every transfer of the coin, in its pool and between
// wallets, so it can hold a real max wallet, lock early coins and pay holders without
// staking. Four strict coins and one plain coin are launched:
//
//   S1  every strict rule: a max wallet of 3%, an early window, an early lock, a creator
//       fee, holder rewards and a burn rate
//   S2  a creator lock: the launcher's coins stay in its own wallet, under a floor
//   S3  no first buy: the holders' share goes to the burn pot until 0.1% of the supply is
//       registered; then two holders in proportion, a token Burn and sync_holder,
//       close_holder, and the burn through its steps with run_burn_strict
//   S4  a pool made directly with create_pool: no deposit while the max wallet runs, and a
//       removal of liquidity is paid in full above the max wallet
//   P   a plain rules coin, to show that the strict instructions refuse it
//
// The script keeps its own book of each strict coin, written out below without the SDK
// ("How the money moves" in RULES.md, with holder records in place of stakes), and compares
// three things all along: the chain, the SDK, the book.
//
//   node scripts/e2e-strict.mjs <localnet|devnet>
//   STRICT_ONLY=S1,S3 node scripts/e2e-strict.mjs localnet     (some parts only)
//
// It needs no key from your machine: every wallet is made here and funded by airdrop. It
// waits for the windows of the coins to pass, so it runs for about five minutes.
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionMessage, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  HookpoolClient, NATIVE_MINT, DIRECTION, FLAGS, PROGRAMS, TOKEN_2022_PROGRAM, BURN_INTERVAL_SLOTS, BURN_OUTCOME, LOCK_WHOLE_BALANCE, RULES_ERRORS, RULES_KIND,
  RULES_STRICT_CEILINGS, RULES_STRICT_POLICY, HOLDER_RECORD_RENT, StrictRefusal, IX, decodeTokenAmount, eventsFromTransaction, ix, pda, poolKeys, rulesArgs, rulesFirstBuyQuote,
  rulesPda, rulesErrorFromLogs, rulesLiquidityOpenSlot, rulesSniperFee, strictArgs, strictProblems, strictMaxWalletAmount, token2022Extension,
} from "../sdk/dist/index.js";
import { RPC, connection, loadAlt, sendRefused, waitForSlot } from "./cluster.mjs";

const cluster = process.argv[2];
if (cluster !== "localnet" && cluster !== "devnet") {
  console.error("usage: node scripts/e2e-strict.mjs <localnet|devnet>\nThis rehearsal spends SOL on throwaway coins: it runs on a test chain only.");
  process.exit(1);
}
const conn = connection(cluster);
const table = loadAlt(cluster);
const client = new HookpoolClient(conn, { lookupTable: table });
const bare = new HookpoolClient(conn);            // the same client without the lookup table
const platform = await client.platform().catch(() => null);
if (!platform) { console.error(`Programmable is not initialised on ${cluster} (${RPC[cluster]}). From the repository root:\n  bash scripts/localnet.sh up\n  node scripts/init-platform.mjs localnet`); process.exit(1); }
if (!table) { console.error("the platform's lookup table is missing (web/deployments/<cluster>-alt.json): run node scripts/init-platform.mjs first"); process.exit(1); }
const OURS = Object.values(PROGRAMS).map((p) => p.toBase58());
const ONLY = (process.env.STRICT_ONLY ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const part = (name) => ONLY.length === 0 || ONLY.includes(name);

// ---- small tools ---------------------------------------------------------------------------
let checks = 0;
const check = (cond, msg) => { if (!cond) { console.error("CHECK FAILED: " + msg); process.exit(1); } checks++; console.log("  check  " + msg); };
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));
const fmt = (v, dec = 9) => (Number(v) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dec });
const coins6 = (v) => fmt(v, 6);
const UNIT = 1_000_000n;                              // one coin, 6 decimals
const SUPPLY = 1_000_000_000n * UNIT;
const LIQUIDITY = sol(2), LP_FEE_BPS = 100;
const SCALE = 10n ** 12n;
const measures = [];
const measure = (what, r, sizes) => measures.push({ what, cu: r.cu, size: r.size, table: r.table, sizes });
const isIx = (i, name) => i.programId.equals(PROGRAMS.hook_rules) && Buffer.from(i.data).subarray(0, 8).equals(Buffer.from(IX.hook_rules[name]));

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
/// Send something the chain must refuse and check the reason it gives. For an error of
/// hook_rules, the SDK's `rulesErrorFromLogs` must name it from the logs too.
async function refused(ixs, signers, label, reason) {
  const text = await sendRefused(conn, ixs, signers, label);
  if (!text.includes(reason)) console.error(text);
  const named = rulesErrorFromLogs(text.split("\n"));
  const ours = Object.values(RULES_ERRORS).find((e) => e.name === reason);
  check(text.includes(reason) && (!ours || (named && named.number === ours.number)), `refused, and the reason is ${reason}${ours ? ` (${ours.number}; the SDK reads it from the logs: "${ours.message}")` : ""}`);
}
/// Call something the SDK must refuse with a StrictRefusal of this number.
async function sdkRefuses(f, number, label) {
  let err = null;
  try { await f(); } catch (e) { err = e; }
  if (!(err instanceof StrictRefusal) || err.number !== number) console.error(err);
  check(err instanceof StrictRefusal && err.number === number && err.code === RULES_ERRORS[number].name && err.message === RULES_ERRORS[number].message,
    `${label}: the SDK refuses before anything is sent, with ${RULES_ERRORS[number].name} (${number})`);
}
const tokenAmount = async (account) => { const a = await conn.getAccountInfo(account); return a ? decodeTokenAmount(new Uint8Array(a.data)) : 0n; };
const coinsOf = (wallet, mint) => tokenAmount(pda.ata(wallet, mint, TOKEN_2022_PROGRAM));
const ruleBytes = async (pool) => Buffer.from((await conn.getAccountInfo(rulesPda.cfg(pool))).data.subarray(8, 240)).toString("hex");
const strictBytes = async (pool) => Buffer.from((await conn.getAccountInfo(rulesPda.cfg(pool))).data.subarray(377, 389)).toString("hex");
const slotNow = async () => BigInt(await conn.getSlot("confirmed"));

// ---- the pool's fees, by hand ----------------------------------------------------------------
const ceilFee = (amount, bps) => (bps === 0 || amount === 0n ? 0n : (amount * BigInt(bps) + 9_999n) / 10_000n);
const buyHookFee = (amountIn, bps) => ceilFee(amountIn - ceilFee(amountIn, platform.protocolFeeBps), bps);
const sellHookFee = (event, bps) => ceilFee(event.amountOut + event.hookFee, bps);

// ---- the script's own book of one strict coin ------------------------------------------------------
// RULES.md, "How the money moves", with holder records in place of stakes. A trade pays all
// three rates of its side. Its hook fee is split the next time the program settles: in the
// next trade's before_swap, in open_holder, claim_holder, sync_holder and the burn. A
// transfer settles nothing: it brings the records of its two wallets up to date with the
// accumulator as it stands (what the old balance earned goes into `owed`), then sets their
// balance to what the wallets hold after it. The holders' part goes into the accumulator
// while the records together hold at least 0.1% of the supply, into the burn pot otherwise.
class Book {
  constructor(rules, minEligible) {
    this.rules = rules; this.minEligible = minEligible; this.started = false;
    this.fees = 0n; this.last = null;
    this.creator = 0n; this.burn = 0n; this.acc = 0n; this.rem = 0n; this.staked = 0n;
    this.paidCreator = 0n; this.paidRewards = 0n; this.burnedQuote = 0n;
    this.holdersBurned = 0n; this.holdersShared = 0n;
    this.records = new Map();       // wallet -> { balance, snap, owed, early }
  }
  clone() {
    const b = Object.assign(new Book(this.rules, this.minEligible), this);
    b.last = this.last && { ...this.last };
    b.records = new Map([...this.records].map(([k, v]) => [k, { ...v }]));
    return b;
  }
  rates(isBuy) { const s = isBuy ? this.rules.buy : this.rules.sell; return { c: BigInt(s.creatorBps), h: BigInt(s.holdersBps), b: BigInt(s.burnBps) }; }
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
  rec(w) { return this.records.get(w.toBase58()); }
  accrue(r) { r.owed += (r.balance * (this.acc - r.snap)) / SCALE; r.snap = this.acc; }
  touch(w, balance) { const r = this.rec(w); if (!r) return; this.accrue(r); this.staked += balance - r.balance; r.balance = balance; }
  open(w, balance) { if (this.started) this.settle(); this.records.set(w.toBase58(), { balance, snap: this.acc, owed: 0n, early: 0n }); this.staked += balance; }
  trade(fee, isBuy, touches) { this.settle(); for (const [w, b] of touches) this.touch(w, b); this.fees += fee; this.last = { fee, ...this.rates(isBuy) }; }
  move(touches) { for (const [w, b] of touches) this.touch(w, b); }
  claim(w) { this.settle(); const r = this.rec(w); this.accrue(r); const a = r.owed; r.owed = 0n; this.paidRewards += a; return a; }
  sync(w, real) { if (this.started) this.settle(); const r = this.rec(w); if (real < r.balance) { this.accrue(r); this.staked -= r.balance - real; r.balance = real; } }
  close(w) { this.records.delete(w.toBase58()); }
  claimCreator() { this.settle(); const a = this.creator; this.creator = 0n; this.paidCreator += a; return a; }
  burnRun(spend) { this.settle(); this.burn -= spend; this.burnedQuote += spend; }
  owedTotal() { let s = 0n; for (const r of this.records.values()) s += r.owed; return s; }
  claimable(w) { const b = this.clone(); b.settle(); const r = b.rec(w); return r ? r.owed + (r.balance * (b.acc - r.snap)) / SCALE : 0n; }
  promised() { let owed = 0n; for (const r of this.records.values()) owed += r.owed + (r.balance * (this.acc - r.snap)) / SCALE; return this.creator + this.burn + owed; }
}

// ---- launching a strict coin -------------------------------------------------------------------
const coins = [];
async function launchStrict(letter, name, symbol, input, { dev, devBuy }) {
  const mint = Keypair.generate();
  const args = rulesArgs(input);
  const strict = strictArgs(input.strict);
  const first = devBuy > 0n ? rulesFirstBuyQuote(args, { totalSupply: SUPPLY, quoteAmount: LIQUIDITY, lpFeeBps: LP_FEE_BPS, devBuyQuote: devBuy }, platform) : null;
  const opts = {
    dev: dev.publicKey, mint, name, symbol, uri: `https://example.com/meta/${symbol.toLowerCase()}.json`, decimals: 6, totalSupply: SUPPLY,
    quoteMint: NATIVE_MINT, lpFeeBps: LP_FEE_BPS, quoteAmount: LIQUIDITY, devBuyQuote: devBuy, minDevBuyOut: first ? first.amountOut : 0n, template: "rules", rules: input,
  };
  const plan = await client.launchInstructions(opts);
  const s1 = await sizesOf(plan.createTx, dev.publicKey), s2 = await sizesOf(plan.launchTx, dev.publicKey);
  console.log(`  transaction 1 (coin, rules${devBuy > 0n ? ", the launcher's holder record" : ""}): ${fits(s1.legacy)} without the lookup table, ${fits(s1.v0)} with it`);
  console.log(`  transaction 2 (launch${devBuy > 0n ? ", first buy" : ""}${plan.lock ? ", creator lock" : ""}): ${fits(s2.legacy)} without the lookup table, ${fits(s2.v0)} with it`);
  const big = [s1.legacy, s2.legacy].some((s) => s === null || s > 1232);
  check(plan.sizes.createTx === s1.legacy && plan.sizes.launchTx === s2.legacy && plan.needsLookupTable === big && s1.v0 !== null && s1.v0 <= 1232 && s2.v0 !== null && s2.v0 <= 1232,
    `${letter}: the plan states the legacy size of both transactions and ${big ? "says the lookup table is needed" : "says no lookup table is needed"}; with the table both fit`);
  if (big) {
    let said = null;
    try { await bare.launchInstructions({ ...opts, mint: Keypair.generate() }); } catch (e) { said = e.message; }
    check(said !== null && said.includes("lookup table"), `${letter}: a client without the lookup table refuses to build this launch, and says why`);
  }
  const maxWallet = strictMaxWalletAmount(SUPPLY, strict.maxWalletBps);
  check(plan.strict && plan.strict.maxWalletAmount === maxWallet, `${letter}: the plan states the max wallet the pool will have: ${maxWallet === 0n ? "none" : coins6(maxWallet) + " coins"}`);
  check(plan.createTx.some((i) => isIx(i, "init_strict_config")) && plan.createTx.some((i) => isIx(i, "open_holder")) === devBuy > 0n,
    `${letter}: transaction 1 binds the coin with init_strict_config${devBuy > 0n ? " and opens the launcher's holder record before the pool exists" : " and opens no record: there is no first buy"}`);

  const t1 = await send(plan.createTx, [dev, ...plan.signers], `${letter}: transaction 1, the coin and its rules (with the lookup table)`, { table: true });
  const t2 = await send(plan.launchTx, [dev], `${letter}: transaction 2, the pool (with the lookup table)`, { table: true });
  measure(`${letter} launch, transaction 1`, t1, s1);
  measure(`${letter} launch, transaction 2${devBuy > 0n ? " with a first buy" : ""}${plan.lock ? " and the creator lock" : ""}`, t2, s2);

  const pool = await client.pool(plan.pool);
  const st = await client.rulesState(plan.pool);
  const c = st.config;
  const mintInfo = await conn.getAccountInfo(mint.publicKey);
  const hookExt = token2022Extension(new Uint8Array(mintInfo.data), 14);
  const m = await client.mint(mint.publicKey);
  check(mintInfo.owner.equals(TOKEN_2022_PROGRAM) && hookExt && hookExt.subarray(0, 32).every((b) => b === 0) && new PublicKey(hookExt.subarray(32, 64)).equals(PROGRAMS.hook_rules)
    && m.mintAuthority === null && m.freezeAuthority === null && m.supply === SUPPLY,
    `${letter}: the coin is a Token-2022 mint whose transfer hook is hook_rules, with no hook authority, no mint authority and no freeze authority`);
  const validation = await conn.getAccountInfo(rulesPda.validation(mint.publicKey));
  check(validation && validation.owner.equals(PROGRAMS.hook_rules), `${letter}: the coin's account list ["extra-account-metas", mint] exists under hook_rules`);
  check(c.kind === RULES_KIND.STRICT && c.strict && c.maxWalletBps === strict.maxWalletBps && c.maxWalletSlots === strict.maxWalletSlots && c.earlySlots === strict.earlySlots
    && c.earlyUnlockSlots === strict.earlyUnlockSlots && c.maxWalletAmount === maxWallet && c.startSlot === t2.slot && c.minEligible === SUPPLY / 1_000n,
    `${letter}: the config is a strict one (kind 1) with the numbers that were asked, started in slot ${c.startSlot}; holder rewards need ${coins6(c.minEligible)} coins registered`);
  check(st.strict && st.strict.maxWalletAmount === maxWallet && st.strict.maxWalletUntil === (strict.maxWalletSlots ? c.startSlot + BigInt(strict.maxWalletSlots) : 0n)
    && st.strict.earlyUntil === (strict.earlySlots ? c.startSlot + BigInt(strict.earlySlots) : 0n) && st.strict.earlyUnlock === (strict.earlySlots ? c.startSlot + BigInt(strict.earlyUnlockSlots) : 0n)
    && st.liquidityOpenSlot === [rulesLiquidityOpenSlot(c), st.strict.maxWalletUntil].reduce((x, y) => (x > y ? x : y)),
    `${letter}: rulesState reads the strict part: max wallet until slot ${st.strict.maxWalletUntil}, early window until ${st.strict.earlyUntil}, early unlock at ${st.strict.earlyUnlock}; deposits open at slot ${st.liquidityOpenSlot}`);
  const info = await client.hookInfo(pool);
  check(info.template === "rules" && info.rules.strict && info.rulesSentences.some((s) => s.startsWith("Strict coin")), `${letter}: hookInfo names the template and words the coin as a strict coin:`);
  for (const s of info.rulesSentences) console.log("           " + s);
  const ref = await client.hookRef(pool, dev.publicKey);
  const keys = ref.extra.map((a) => `${a.pubkey.toBase58()}${a.isWritable ? "w" : ""}`);
  check(keys.join(" ") === [`${rulesPda.cfg(plan.pool).toBase58()}w`, `${rulesPda.holder(plan.pool, dev.publicKey).toBase58()}w`, `${rulesPda.holder(plan.pool, plan.pool).toBase58()}w`, rulesPda.validation(mint.publicKey).toBase58()].join(" "),
    `${letter}: hookRef carries the pool's extra account (the config) and the coin's own: the wallet's holder record, the pool's holder address, the account list`);
  check(pool.baseTokenProgram.equals(TOKEN_2022_PROGRAM) && await client.isStrictPool(pool), `${letter}: the SDK knows the pool's coin is a strict coin`);

  const book = new Book(args, c.minEligible);
  const coin = { letter, name, symbol, mint: mint.publicKey, pool: plan.pool, dev, args, strict, plan, first, book, launch: t2, start: c.startSlot, maxWallet, treasury: c.treasury, wallets: [dev.publicKey],
    rulesAtLaunch: await ruleBytes(plan.pool), strictAtLaunch: await strictBytes(plan.pool), burned: new Set() };
  if (devBuy > 0n) {
    const opened = t1.events.find((e) => e.kind === "HolderOpened");
    check(opened && opened.owner.equals(dev.publicKey) && opened.balance === SUPPLY && opened.pool.equals(plan.pool),
      `${letter}: in transaction 1 the launcher's record registered the whole supply, which the launchpad hands it (HolderOpened)`);
    book.open(dev.publicKey, SUPPLY);
    book.touch(dev.publicKey, 0n);          // the launch moves the supply into the pool
    book.started = true;
    const buy = t2.events.find((e) => e.kind === "Swapped");
    const bps = args.buy.creatorBps + args.buy.holdersBps + args.buy.burnBps;
    check(buy && buy.amountOut === first.amountOut && buy.hookFee === first.hookFee && buy.hookFee === buyHookFee(devBuy, bps),
      `${letter}: the first buy got ${coins6(buy.amountOut)} coins, exactly what the SDK worked out before the pool existed (hook fee ${buy.hookFee} lamports)`);
    book.trade(buy.hookFee, true, [[dev.publicKey, buy.amountOut]]);
    if (strict.earlySlots > 0) book.rec(dev.publicKey).early = buy.amountOut;
    const h = await client.rulesHolderOf(plan.pool, dev.publicKey);
    check(h.record && h.record.balance === buy.amountOut && h.balance === buy.amountOut && h.record.earlyBought === (strict.earlySlots > 0 ? buy.amountOut : 0n)
      && (maxWallet === 0n || buy.amountOut <= maxWallet),
      `${letter}: the launch moved the supply into the pool and the first buy back: the record counts the ${coins6(buy.amountOut)} coins the launcher holds${strict.earlySlots > 0 ? ", all of them early" : ""}${maxWallet > 0n ? `, under the max wallet of ${coins6(maxWallet)}` : ""}`);
  } else book.started = true;
  coins.push(coin);
  await agree(coin, `${letter}, after the launch`);
  return coin;
}

/// Everything the chain, the SDK and the book say about a coin, compared to the unit.
async function agree(coin, label) {
  const st = await client.rulesState(coin.pool);
  const c = st.config, b = coin.book;
  const s = b.clone(); s.settle();
  check(st.unsettledFee === (b.last ? b.last.fee : 0n) && c.creatorOwed === b.creator && c.burnPot === b.burn && c.accPerShare === b.acc && c.rewardRem === b.rem && c.totalStaked === b.staked
    && c.rewardsOwedTotal === b.owedTotal() && c.totalCreatorPaid === b.paidCreator && c.totalRewardsPaid === b.paidRewards && c.totalQuoteBurned === b.burnedQuote,
    `${label}: chain and book agree: ${coins6(c.totalStaked)} coins registered, ${c.creatorOwed} lamports owed to the creator, ${c.burnPot} in the burn pot, ${c.totalRewardsPaid} paid to holders`);
  check(st.settled.creatorOwed === s.creator && st.settled.burnPot === s.burn && st.settled.accPerShare === s.acc && st.settled.rewardRem === s.rem,
    `${label}: the SDK's settled view (the last trade's ${st.unsettledFee} lamports split) is the book's`);
  const treasury = await tokenAmount(coin.treasury);
  const dust = treasury - s.promised();
  check(treasury === b.fees - b.paidCreator - b.paidRewards - b.burnedQuote && dust >= 0n && dust < 1_000n,
    `${label}: the treasury holds ${treasury} lamports, every hook fee less what was paid and burned; what is promised is covered with ${dust} lamports of rounding left`);
  let sum = 0n, n = 0;
  for (const w of coin.wallets) {
    const h = await client.rulesHolderOf(coin.pool, w);
    const r = b.rec(w);
    if (!r) { if (h.record !== null || h.claimable !== 0n || h.counted !== 0n) { console.error(h); check(false, `${label}: ${w.toBase58()} has no record in the book but one on chain`); } continue; }
    n++; sum += h.record.balance;
    const ok = h.record.balance === r.balance && h.record.owed === r.owed && h.record.accSnapshot === r.snap && h.record.earlyBought === r.early && h.claimable === b.claimable(w)
      && (coin.burned.has(w.toBase58()) || h.balance === r.balance);
    if (!ok) { console.error({ wallet: w.toBase58(), chain: h.record, book: r, claimable: [h.claimable, b.claimable(w)], balance: h.balance }); check(false, `${label}: the record of ${w.toBase58()} is not the book's`); }
  }
  check(sum === c.totalStaked, `${label}: ${n} holder records, each the book's to the unit (balance, snapshot, owed, early coins, claimable now); together they hold the registered total`);
  return st;
}

/// One trade with every comparison: the SDK's quote (with the wallet, so that it checks the
/// strict rules), the chain's simulation, what the chain paid, the hook fee by hand.
/// `window: true`: inside the sniper window the pool fee falls every slot, so the chain
/// gives the quote or more, and exactly the quote of the slot the trade landed in.
async function trade(coin, wallet, direction, amountIn, label, { openHolder, window = false } = {}) {
  const isBuy = direction === DIRECTION.BUY;
  const pool = await client.pool(coin.pool);
  const info = await client.hookInfo(pool);
  const local = await client.quoteLocal(pool, platform, direction, amountIn, info, undefined, wallet.publicKey);
  const simulated = await client.quoteOnChain(wallet.publicKey, pool, direction, amountIn);
  const before = await coinsOf(wallet.publicKey, coin.mint);
  const ixs = await client.swapInstructions(wallet.publicKey, pool, await client.hookRef(pool, wallet.publicKey), direction, amountIn, local.amountOut, { openHolder });
  const opens = ixs.some((i) => isIx(i, "open_holder"));
  const r = await send(ixs, [wallet], label);
  const ev = r.events.find((e) => e.kind === "Swapped");
  const after = await coinsOf(wallet.publicKey, coin.mint);
  if (!coin.wallets.some((w) => w.equals(wallet.publicKey))) coin.wallets.push(wallet.publicKey);
  if (opens) coin.book.open(wallet.publicKey, before);
  coin.book.trade(ev.hookFee, isBuy, [[wallet.publicKey, after]]);
  const early = isBuy && coin.strict.earlySlots > 0 && r.slot - coin.start < BigInt(coin.strict.earlySlots);
  if (early && coin.book.rec(wallet.publicKey)) coin.book.rec(wallet.publicKey).early += ev.amountOut;
  const side = isBuy ? coin.args.buy : coin.args.sell;
  const bps = side.creatorBps + side.holdersBps + side.burnBps;
  const moved = isBuy ? after - before === ev.amountOut : before - after === amountIn;
  const byHand = isBuy ? buyHookFee(amountIn, bps) : sellHookFee(ev, bps);
  if (window) {
    const exact = await client.quoteLocal(pool, platform, direction, amountIn, info, ev.slot);
    const fee = rulesSniperFee(ev.slot, info.rules.startSlot, info.rules.sniperSlots, info.rules.sniperStartFeeBps, pool.lpFeeBps);
    check(simulated >= local.amountOut && ev.amountOut >= simulated && moved && exact.amountOut === ev.amountOut && ev.feeBpsApplied === fee && fee > pool.lpFeeBps && ev.hookFee === byHand,
      `${label}: quoted ${coins6(local.amountOut)} coins at the read slot, paid ${coins6(ev.amountOut)}: the quote or more, because the buy landed ${ev.slot - info.rules.startSlot} slots into the sniper window at a pool fee of ${fee} bps; for that slot the SDK's quote is exact; hook fee ${ev.hookFee} lamports, ${bps} bps by hand`);
  } else {
    check(local.amountOut === simulated && simulated === ev.amountOut && moved && ev.hookFee === byHand,
      `${label}: quoted ${isBuy ? coins6(local.amountOut) + " coins" : fmt(local.amountOut) + " SOL"}, simulated the same, paid the same; hook fee ${ev.hookFee} lamports, ${bps} bps by hand${early ? "; an early buy" : ""}`);
  }
  if (opens) {
    const oe = r.events.find((e) => e.kind === "HolderOpened");
    check(oe && oe.owner.equals(wallet.publicKey) && oe.balance === before, `${label}: the SDK put open_holder in front of the buy; the record registered the ${coins6(before)} coins the wallet held before it`);
  }
  measure(`swap on a strict coin (${isBuy ? "buy" : "sell"}${opens ? ", with open_holder" : ""})`, r);
  return { ...r, ev, before, after, local, opens, early };
}

/// A wallet-to-wallet send through the SDK, with the book's two touches.
async function sendCoins(coin, from, to, amount, label) {
  const pool = await client.pool(coin.pool);
  const [fromBefore, toBefore, toAta] = [await coinsOf(from.publicKey, coin.mint), await coinsOf(to, coin.mint), await client.exists(pda.ata(to, coin.mint, TOKEN_2022_PROGRAM))];
  const ixs = await client.strictSendInstructions(from.publicKey, pool, to, amount);
  check(ixs.length === (toAta ? 1 : 2) && ixs[ixs.length - 1].programId.equals(TOKEN_2022_PROGRAM), `${label}: the SDK builds a Token-2022 TransferChecked with the hook's accounts${toAta ? "" : ", and creates the receiver's account first"}`);
  const r = await send(ixs, [from], label);
  coin.book.move([[from.publicKey, fromBefore - amount], [to, toBefore + amount]]);
  if (!coin.wallets.some((w) => w.equals(to))) coin.wallets.push(to);
  check((await coinsOf(from.publicKey, coin.mint)) === fromBefore - amount && (await coinsOf(to, coin.mint)) === toBefore + amount, `${label}: ${coins6(amount)} coins moved`);
  measure(`send of a strict coin${toAta ? "" : " (with the receiver's account created)"}`, r);
  return r;
}
/// The SOL a buy needs for about `target` coins now (a little less), from the SDK's quote.
async function quoteFor(coin, target) {
  const pool = await client.pool(coin.pool);
  const info = await client.hookInfo(pool);
  let lo = 1n, hi = sol(1);
  while (hi - lo > 1_000n) {
    const mid = (lo + hi) / 2n;
    const q = await client.quoteLocal(pool, platform, DIRECTION.BUY, mid, info);
    if (q.amountOut <= target) lo = mid; else hi = mid;
  }
  return lo;
}
async function claimHolder(coin, wallet, label) {
  const pool = await client.pool(coin.pool);
  const predicted = coin.book.claimable(wallet.publicKey);
  const c = await client.rulesClaimRewardsInstructions(wallet.publicKey, pool);
  check(c.amount === predicted && c.instructions.some((i) => isIx(i, "claim_holder")), `${label}: the SDK offers claim_holder for ${c.amount} lamports, the book's number`);
  // a wallet that keeps a wrapped SOL account is paid into it (the SDK's wrapped SOL rule)
  const wsol = pda.ata(wallet.publicKey, NATIVE_MINT);
  const wrapped = await client.exists(wsol);
  const before = wrapped ? await tokenAmount(wsol) : BigInt(await conn.getBalance(wallet.publicKey));
  const r = await send(c.instructions, [wallet], label);
  const paid = coin.book.claim(wallet.publicKey);
  const ev = r.events.find((e) => e.kind === "HolderClaimed");
  const got = wrapped ? (await tokenAmount(wsol)) - before : BigInt(await conn.getBalance(wallet.publicKey)) - before + 5_000n;
  check(ev && ev.amount === paid && paid === c.amount && ev.owner.equals(wallet.publicKey) && got === paid, `${label}: ${fmt(paid)} SOL paid to the wallet in plain SOL, to the lamport (HolderClaimed)`);
  measure("claim_holder", r);
  return paid;
}

// ====================================================================================================
console.log(`cluster ${cluster} (${RPC[cluster]}), lookup table ${table.toBase58()}`);
const W = Object.fromEntries(["d1", "d2", "d3", "d4", "d5", "dp", "a", "b", "c", "q", "r", "x", "h1", "h2", "h3", "m1", "m2", "stranger"].map((n) => [n, Keypair.generate()]));
await fund([W.d1, W.d2, W.d3, W.d4, W.d5, W.dp], 5);
await fund([W.a, W.b, W.c, W.q, W.x, W.h1, W.h2, W.h3, W.m1, W.m2], 3);
await fund([W.stranger, W.r], 1);
const N = Keypair.generate();                         // never funded: receives coins only

// ---- 0. the bounds ----------------------------------------------------------------------------------
if (part("S0")) {
  section("0. The strict bounds: the SDK refuses a strict coin the program would refuse, before it builds anything");
  const C = RULES_STRICT_CEILINGS;
  const base = { dev: W.d1.publicKey, name: "No", symbol: "NO", uri: "https://example.com/no.json", decimals: 6, totalSupply: SUPPLY, quoteMint: NATIVE_MINT, lpFeeBps: LP_FEE_BPS, quoteAmount: LIQUIDITY, devBuyQuote: sol(0.01), minDevBuyOut: 1n, template: "rules" };
  const bad = [
    ["MaxWalletOutOfBounds", { maxWalletBps: C.maxWalletBpsMax + 1, maxWalletSlots: 100 }],
    ["MaxWalletOutOfBounds", { maxWalletBps: C.maxWalletBpsMin - 1, maxWalletSlots: 100 }],
    ["MaxWalletOutOfBounds", { maxWalletBps: 300, maxWalletSlots: C.maxWalletSlots + 1 }],
    ["MaxWalletIncomplete", { maxWalletBps: 300 }],
    ["MaxWalletIncomplete", { maxWalletSlots: 100 }],
    ["EarlyOutOfBounds", { earlySlots: C.earlySlots + 1, earlyUnlockSlots: C.earlySlots + 1 }],
    ["EarlyOutOfBounds", { earlySlots: 100, earlyUnlockSlots: 99 }],
    ["EarlyOutOfBounds", { earlySlots: 100, earlyUnlockSlots: C.earlyUnlockSlots + 1 }],
    ["EarlyIncomplete", { earlySlots: 100 }],
    ["EarlyIncomplete", { earlyUnlockSlots: 100 }],
  ];
  for (const [code, s] of bad) {
    const problems = strictProblems(strictArgs(s));
    let said = null;
    try { await client.launchInstructions({ ...base, mint: Keypair.generate(), rules: { buy: { creatorBps: 100 }, strict: s } }); } catch (e) { said = e.message; }
    check(problems.length === 1 && problems[0].code === code && said !== null && said.includes(code), `strict ${JSON.stringify(s)}: refused by the SDK with ${code}`);
  }
  const edge = { maxWalletBps: C.maxWalletBpsMax, maxWalletSlots: C.maxWalletSlots, earlySlots: C.earlySlots, earlyUnlockSlots: C.earlyUnlockSlots };
  check(strictProblems(strictArgs(edge)).length === 0 && strictProblems(strictArgs({})).length === 0 && strictProblems(strictArgs({ earlySlots: 100, earlyUnlockSlots: 100 })).length === 0,
    "every ceiling itself is allowed, a strict coin with neither window is allowed, and the unlock may come with the end of the early window");
  const policy = strictProblems(strictArgs(edge), RULES_STRICT_POLICY);
  check(policy.length === 2 && policy[0].code === "MaxWalletOutOfBounds" && policy[1].code === "EarlyOutOfBounds"
    && strictProblems(strictArgs({ maxWalletBps: 300, maxWalletSlots: RULES_STRICT_POLICY.maxWalletSlots, earlySlots: RULES_STRICT_POLICY.earlySlots, earlyUnlockSlots: RULES_STRICT_POLICY.earlyUnlockSlots }), RULES_STRICT_POLICY).length === 0,
    `RULES_STRICT_POLICY, the launch form's tighter bounds (${RULES_STRICT_POLICY.maxWalletBpsMin / 100}% to ${RULES_STRICT_POLICY.maxWalletBpsMax / 100}% for at most ${RULES_STRICT_POLICY.maxWalletSlots} slots, an early window of at most ${RULES_STRICT_POLICY.earlySlots} slots), flags the program's ceilings`);
  {
    let said = null;
    try { await client.launchInstructions({ ...base, mint: Keypair.generate(), devBuyQuote: sol(0.5), rules: { strict: { maxWalletBps: 100, maxWalletSlots: 100 } } }); } catch (e) { said = e.message; }
    check(said !== null && said.includes("MaxWallet"), "a first buy that would get more than the coin's own max wallet (0.5 SOL against a max wallet of 1%) is refused by the SDK");
  }
  // the program refuses the same numbers: the SDK's own coin transaction, with the strict
  // numbers changed after it was built
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({ ...base, mint, rules: { buy: { creatorBps: 100 }, strict: { maxWalletBps: 300, maxWalletSlots: 100 } } });
  const k = poolKeys(mint.publicKey, NATIVE_MINT, TOKEN_2022_PROGRAM);
  for (const [code, s] of [["MaxWalletOutOfBounds", { maxWalletBps: C.maxWalletBpsMax + 1, maxWalletSlots: 100, earlySlots: 0, earlyUnlockSlots: 0 }], ["EarlyOutOfBounds", { maxWalletBps: 0, maxWalletSlots: 0, earlySlots: 100, earlyUnlockSlots: 99 }]]) {
    const ixs = plan.createTx.filter((i) => !isIx(i, "open_holder")).map((i) => (isIx(i, "init_strict_config") ? ix.rulesInitStrictConfig(W.d1.publicKey, k, rulesArgs({ buy: { creatorBps: 100 } }), s) : i));
    const { tx } = await client.buildTx(W.d1.publicKey, ixs);
    tx.sign([W.d1, mint]);
    let text = "";
    const sim = await conn.simulateTransaction(tx, { sigVerify: false });
    text = (sim.value.logs ?? []).join("\n");
    check(sim.value.err && text.includes(code), `the program refuses the same coin with ${code} when the numbers are changed by hand after the SDK built it`);
  }
}

// ---- S1. every strict rule ------------------------------------------------------------------------------
if (part("S1")) {
  const EARLY = 80, UNLOCK = 200, MW = 330;
  section(`S1. A max wallet of 3% for ${MW} slots, an early window of ${EARLY} slots with an unlock at ${UNLOCK}, a creator fee, holder rewards and a burn rate`);
  const S1 = await launchStrict("S1", "Strict Full", "SFULL", {
    buy: { creatorBps: 100, holdersBps: 200, burnBps: 100 }, sell: { creatorBps: 100, holdersBps: 200, burnBps: 100 },
    strict: { maxWalletBps: 300, maxWalletSlots: MW, earlySlots: EARLY, earlyUnlockSlots: UNLOCK },
  }, { dev: W.d1, devBuy: sol(0.02) });
  const at = (slot, what) => check(slot - S1.start < BigInt(what[1]) && slot - S1.start >= BigInt(what[0]), `S1: that landed ${slot - S1.start} slots after the launch, inside ${what[2]}`);

  section("S1, inside the early window");
  {
    const pool = await client.pool(S1.pool);
    const hook = await client.hookRef(pool, W.a.publicKey);
    const all = await client.swapInstructions(W.a.publicKey, pool, hook, DIRECTION.BUY, sol(0.03), 0n);
    check(all.some((i) => isIx(i, "open_holder")), "S1: in the early window the SDK puts open_holder in front of a buy by a wallet without a record");
    await refused(all.filter((i) => !isIx(i, "open_holder")), [W.a], "S1: the same buy without open_holder, sent by hand", "HolderRecordRequired");
    let said = null;
    try { await client.swapInstructions(W.x.publicKey, pool, await client.hookRef(pool, W.x.publicKey), DIRECTION.BUY, sol(0.01), 0n, { recipient: W.r.publicKey }); } catch (e) { said = e; }
    check(said instanceof StrictRefusal && said.number === 6047, "S1: a buy for another wallet that has no record is refused by the SDK in the early window: only that wallet can open its record");
  }
  const a1 = await trade(S1, W.a, DIRECTION.BUY, sol(0.03), "S1: a wallet buys for 0.03 SOL in the early window, through the SDK");
  check(a1.opens && a1.early, "S1: the buy opened the record and was early");
  await trade(S1, W.a, DIRECTION.BUY, sol(0.005), "S1: the same wallet buys again in the early window");
  {
    const h = await client.rulesHolderOf(S1.pool, W.a.publicKey);
    check(h.earlyBought === h.balance && h.earlyLocked && h.free === 0n && h.earlyUnlock === S1.start + BigInt(UNLOCK), `S1: rulesHolderOf: all ${coins6(h.balance)} coins of the wallet are early and locked until slot ${h.earlyUnlock}; it may move none`);
  }
  {
    const pool = await client.pool(S1.pool);
    const info = await client.hookInfo(pool);
    await sdkRefuses(() => client.quoteLocal(pool, platform, DIRECTION.SELL, UNIT, info, undefined, W.a.publicKey), 6045, "S1: a sell of one early coin");
    await refused(await client.swapInstructions(W.a.publicKey, pool, await client.hookRef(pool, W.a.publicKey), DIRECTION.SELL, UNIT, 0n), [W.a], "S1: that sell, sent all the same", "EarlyLocked");
    await sdkRefuses(() => client.strictSendInstructions(W.a.publicKey, pool, W.b.publicKey, UNIT), 6045, "S1: a send of one early coin");
    await refused(await client.strictSendInstructions(W.a.publicKey, pool, W.b.publicKey, UNIT, { check: false }), [W.a], "S1: that send, built without the SDK's check", "EarlyLocked");
    at(await slotNow(), [0, EARLY, "the early window"]);
  }
  await agree(S1, "S1, in the early window");

  section("S1, after the early window, while the early coins are locked and the max wallet runs");
  await waitForSlot(conn, S1.start + BigInt(EARLY));
  const b1 = await trade(S1, W.b, DIRECTION.BUY, sol(0.02), "S1: a second wallet buys for 0.02 SOL after the early window");
  check(b1.opens && !b1.early && S1.book.rec(W.b.publicKey).early === 0n, "S1: the SDK opened its record too (openHolder is on by default); none of its coins are early");
  // a wallet near the max wallet
  const room = 2_000_000n * UNIT;
  const nearCap = await quoteFor(S1, S1.maxWallet - room);
  const c1 = await trade(S1, W.c, DIRECTION.BUY, nearCap, `S1: a third wallet buys up to about 2 million coins under the max wallet of ${coins6(S1.maxWallet)}`);
  check(c1.after <= S1.maxWallet && S1.maxWallet - c1.after < 3n * room, `S1: the wallet holds ${coins6(c1.after)} coins`);
  const q1 = await trade(S1, W.q, DIRECTION.BUY, sol(0.005), "S1: a fourth wallet buys with openHolder: false", { openHolder: false });
  check(!q1.opens && (await client.rulesHolderOf(S1.pool, W.q.publicKey)).record === null, "S1: outside the early window a buy without a record is allowed; this wallet has none, so it is not counted");
  {
    const pool = await client.pool(S1.pool);
    const info = await client.hookInfo(pool);
    await sdkRefuses(() => client.quoteLocal(pool, platform, DIRECTION.BUY, sol(0.02), info, undefined, W.c.publicKey), 6044, "S1: a buy that would take the third wallet over the max wallet");
    await refused(await client.swapInstructions(W.c.publicKey, pool, await client.hookRef(pool, W.c.publicKey), DIRECTION.BUY, sol(0.02), 0n), [W.c], "S1: that buy, sent all the same", "MaxWallet");
    const left = S1.maxWallet - (await coinsOf(W.c.publicKey, S1.mint));
    await sdkRefuses(() => client.strictSendInstructions(W.b.publicKey, pool, W.c.publicKey, left + 1n), 6044, `S1: a send of ${coins6(left + 1n)} coins, one raw unit more than the third wallet's room under the max wallet`);
    await refused(await client.strictSendInstructions(W.b.publicKey, pool, W.c.publicKey, left + 1n, { check: false }), [W.b], "S1: that send, built without the SDK's check", "MaxWallet");
    const exact = await client.strictSendInstructions(W.b.publicKey, pool, W.c.publicKey, left);
    check(exact.length > 0, "S1: a send of exactly the room is allowed by the SDK (balance after = the max wallet)");
  }
  await sendCoins(S1, W.b, W.c.publicKey, 1_000_000n * UNIT, "S1: the second wallet sends 1 million coins to the third, which stays under the max wallet");
  await sendCoins(S1, W.b, W.a.publicKey, 1_000_000n * UNIT, "S1: the second wallet sends 1 million coins to the first, whose own coins are all early");
  {
    const h = await client.rulesHolderOf(S1.pool, W.a.publicKey);
    check(h.earlyLocked && h.free === 1_000_000n * UNIT, "S1: rulesHolderOf: the first wallet may now move the 1 million coins it received, and nothing more");
  }
  await trade(S1, W.a, DIRECTION.SELL, 1_000_000n * UNIT, "S1: the first wallet sells exactly those 1 million coins");
  {
    const pool = await client.pool(S1.pool);
    await sdkRefuses(async () => client.quoteLocal(pool, platform, DIRECTION.SELL, UNIT, await client.hookInfo(pool), undefined, W.a.publicKey), 6045, "S1: one coin more");
    await refused(await client.swapInstructions(W.a.publicKey, pool, await client.hookRef(pool, W.a.publicKey), DIRECTION.SELL, UNIT, 0n), [W.a], "S1: one coin more, sent all the same", "EarlyLocked");
  }
  await sendCoins(S1, W.b, N.publicKey, 500_000n * UNIT, "S1: the second wallet sends 500,000 coins to a new wallet that has no coin account and no record");
  {
    const pool = await client.pool(S1.pool);
    const lpSupply = (await client.mint(pool.lpMint)).supply;
    const bBal = await coinsOf(W.b.publicKey, S1.mint);
    const lp = (lpSupply * (bBal / 4n)) / pool.reserveBase;
    await refused(await client.addLiquidityInstructions(W.b.publicKey, pool, lp, bBal, sol(0.5)), [W.b], "S1: the second wallet adds liquidity while the max wallet runs", "LiquidityInMaxWalletWindow");
    at(await slotNow(), [EARLY, UNLOCK, "the early lock, after the early window"]);
  }
  await agree(S1, "S1, after the early window");

  section("S1, after the early unlock, while the max wallet still runs");
  await waitForSlot(conn, S1.start + BigInt(UNLOCK));
  {
    const h = await client.rulesHolderOf(S1.pool, W.a.publicKey);
    check(!h.earlyLocked && h.free === h.balance && h.earlyBought > 0n, "S1: rulesHolderOf: the early coins are free now");
  }
  const aHalf = (await coinsOf(W.a.publicKey, S1.mint)) / 2n;
  await trade(S1, W.a, DIRECTION.SELL, aHalf, "S1: the first wallet sells half of its early coins");
  await sendCoins(S1, W.a, W.b.publicKey, 1_000_000n * UNIT, "S1: and sends 1 million of them to the second wallet");
  {
    const pool = await client.pool(S1.pool);
    await sdkRefuses(() => client.rulesCloseHolderInstructions(W.a.publicKey, pool), 6049, "S1: the first wallet closes its record while it holds coins");
    at(await slotNow(), [UNLOCK, MW, "the max wallet window"]);
  }
  await agree(S1, "S1, after the early unlock");

  section("S1, after the max wallet window");
  await waitForSlot(conn, S1.start + BigInt(MW));
  const big = await trade(S1, W.c, DIRECTION.BUY, sol(0.05), "S1: the third wallet buys for 0.05 SOL, which takes it over 3% of the supply");
  check(big.after > S1.maxWallet, `S1: it holds ${coins6(big.after)} coins, more than the old max wallet: the window is over`);
  {
    const pool = await client.pool(S1.pool);
    const lpSupply = (await client.mint(pool.lpMint)).supply;
    const bBal = await coinsOf(W.b.publicKey, S1.mint);
    const lp = (lpSupply * (bBal / 4n)) / pool.reserveBase;
    const ra = await send(await client.addLiquidityInstructions(W.b.publicKey, pool, lp, bBal, sol(0.5)), [W.b], "S1: the second wallet adds liquidity now");
    S1.book.move([[W.b.publicKey, await coinsOf(W.b.publicKey, S1.mint)]]);
    measure("add_liquidity on a strict coin", ra);
    const rr = await send(await client.removeLiquidityInstructions(W.b.publicKey, await client.pool(S1.pool), lp, 0n, 0n), [W.b], "S1: and takes it out again");
    S1.book.move([[W.b.publicKey, await coinsOf(W.b.publicKey, S1.mint)]]);
    measure("remove_liquidity on a strict coin", rr);
  }
  await agree(S1, "S1, after the liquidity");
  {
    const pool = await client.pool(S1.pool);
    const opened = await client.rulesOpenHolderInstructions(W.q.publicKey, pool);
    const held = await coinsOf(W.q.publicKey, S1.mint);
    const ro = await send(opened, [W.q], "S1: the fourth wallet opens its record now");
    S1.book.open(W.q.publicKey, held);
    const oe = ro.events.find((e) => e.kind === "HolderOpened");
    check(oe && oe.balance === held && (await client.rulesOpenHolderInstructions(W.q.publicKey, pool)).length === 0, `S1: open_holder registered its ${coins6(held)} coins; the SDK offers nothing to open a second time`);
    measure("open_holder", ro);
    check((await client.rulesHolderOf(S1.pool, W.q.publicKey)).claimable === 0n, "S1: it earned nothing for the time it held without a record");
  }
  await trade(S1, W.b, DIRECTION.SELL, 2_000_000n * UNIT, "S1: the second wallet sells 2 million coins");
  await trade(S1, W.x, DIRECTION.BUY, sol(0.04), "S1: a fifth wallet buys for 0.04 SOL");
  await trade(S1, W.c, DIRECTION.SELL, 5_000_000n * UNIT, "S1: the third wallet sells 5 million coins");
  await agree(S1, "S1, before the claims");

  section("S1, the claims: every holder is paid in proportion to what it held, to the lamport");
  for (const [w, name] of [[W.a, "first"], [W.b, "second"], [W.c, "third"], [W.q, "fourth"], [W.d1, "launcher's"]]) {
    await claimHolder(S1, w, `S1: the ${name} wallet claims its holder rewards`);
  }
  {
    const pool = await client.pool(S1.pool);
    const none = await client.rulesClaimRewardsInstructions(N.publicKey, pool);
    const h = await client.rulesHolderOf(S1.pool, N.publicKey);
    check(none.amount === 0n && none.instructions.length === 0 && h.record === null && h.balance === 500_000n * UNIT, "S1: the wallet that received coins and never opened a record has nothing to claim, and the SDK builds nothing");
    await refused([ix.rulesClaimHolder(N.publicKey, client.keys(pool))], [W.stranger, N], "S1: a claim for a wallet without a record, by hand", "AccountNotInitialized");
    const creator = await client.rulesClaimCreatorInstructions(W.d1.publicKey, pool);
    await send(creator.instructions, [W.d1], "S1: the launcher claims the creator fee");
    check(S1.book.claimCreator() === creator.amount && creator.amount > 0n, `S1: the creator fee paid is the book's ${fmt(creator.amount)} SOL`);
    const share = S1.book.holdersShared, burned = S1.book.holdersBurned;
    check(share > 0n && burned === 0n, `S1: the holders' share of every trade (${share} lamports in all) went to the records: more than 0.1% of the supply was registered from the first buy on`);
  }
  await agree(S1, "S1, after the claims");
  {
    let pool = await client.pool(S1.pool);
    const fees = await client.collectProtocolFeesInstructions(W.stranger.publicKey, pool);
    if (pool.protocolFeesBase > 0n) {
      const tBefore = await coinsOf(platform.treasury, S1.mint);
      const r = await send(fees, [W.stranger], "S1: a stranger collects the protocol fees, the coin's part through its transfer hook");
      check((await coinsOf(platform.treasury, S1.mint)) - tBefore === pool.protocolFeesBase && r.events.some((e) => e.kind === "ProtocolFeesCollected"), `S1: the platform treasury received the ${coins6(pool.protocolFeesBase)} coins of protocol fee`);
      measure("collect_protocol_fees on a strict coin", r);
    } else console.log("  NOTE   the pool holds no protocol fee in coins: collect_protocol_fees was not tried with the hook");
  }
  check((await ruleBytes(S1.pool)) === S1.rulesAtLaunch && (await strictBytes(S1.pool)) === S1.strictAtLaunch, "S1: the rules and the strict numbers at the end are the ones of the launch, byte for byte");
}

// ---- S2. the creator lock ----------------------------------------------------------------------------
if (part("S2")) {
  const LOCK_SECONDS = 4n, MARGIN = 12;
  section("S2. A creator lock made in the launch: the launcher's coins stay in its wallet, under a floor; no window");
  const S2 = await launchStrict("S2", "Strict Lock", "SLOCK", {
    buy: { creatorBps: 50, holdersBps: 100 }, sell: { creatorBps: 50, holdersBps: 100 }, creatorLockSeconds: LOCK_SECONDS, lockMarginSeconds: MARGIN, strict: {},
  }, { dev: W.d2, devBuy: sol(0.3) });
  const pool0 = await client.pool(S2.pool);
  let lock = await client.rulesLock(S2.pool);
  let h = await client.rulesHolderOf(S2.pool, W.d2.publicKey);
  check(S2.plan.launchTx.some((i) => isIx(i, "lock_creator_strict")) && lock.record && lock.record.amount === S2.first.amountOut && lock.vault.equals(pda.ata(W.d2.publicKey, S2.mint, TOKEN_2022_PROGRAM))
    && lock.vaultBalance === S2.first.amountOut && lock.locked && lock.unlockAt === S2.plan.lock.unlockAt,
    `S2: the launch ended with lock_creator_strict: ${coins6(lock.record.amount)} coins, everything the first buy got, are locked in the launcher's own wallet until ${lock.unlockAt}`);
  check(h.record.locked === S2.first.amountOut && h.record.lockedUntil === lock.unlockAt && h.creatorLocked && h.free === 0n,
    "S2: the launcher's holder record carries the lock, and rulesHolderOf says it may move nothing");
  await sdkRefuses(() => client.strictSendInstructions(W.d2.publicKey, pool0, W.x.publicKey, UNIT), 6046, "S2: a send of one locked coin");
  await refused(await client.strictSendInstructions(W.d2.publicKey, pool0, W.x.publicKey, UNIT, { check: false }), [W.d2], "S2: that send, built without the SDK's check", "CreatorLocked");
  await sdkRefuses(async () => client.quoteLocal(pool0, platform, DIRECTION.SELL, UNIT, await client.hookInfo(pool0), undefined, W.d2.publicKey), 6046, "S2: a sell of one locked coin");
  await refused(await client.swapInstructions(W.d2.publicKey, pool0, await client.hookRef(pool0, W.d2.publicKey), DIRECTION.SELL, UNIT, 0n), [W.d2], "S2: that sell, sent all the same", "CreatorLocked");
  const more = await trade(S2, W.d2, DIRECTION.BUY, sol(0.01), "S2: the launcher buys more coins");
  h = await client.rulesHolderOf(S2.pool, W.d2.publicKey);
  check(h.free === more.ev.amountOut, `S2: it may move the ${coins6(h.free)} coins above the floor`);
  await trade(S2, W.d2, DIRECTION.SELL, more.ev.amountOut, "S2: the launcher sells exactly the coins above the floor");
  await refused(await client.swapInstructions(W.d2.publicKey, pool0, await client.hookRef(pool0, W.d2.publicKey), DIRECTION.SELL, UNIT, 0n), [W.d2], "S2: one coin more", "CreatorLocked");
  await refused(await client.rulesLockInstructions(W.d2.publicKey, pool0, 1n, lock.unlockAt), [W.d2], "S2: the launcher locks one coin more than it holds", "LockAboveBalance");
  await refused(await client.rulesUnlockInstructions(W.d2.publicKey, pool0), [W.d2], "S2: the launcher clears the lock before the date", "StillLocked");
  // what a strict coin does not have
  await sdkRefuses(() => client.rulesStakeInstructions(W.d2.publicKey, pool0, UNIT), 6034, "S2: staking");
  // by hand: the program refuses them, by name where the accounts let the call reach it
  for (const [what, i] of [
    ["stake", ix.rulesStake(W.d2.publicKey, client.keys(pool0), UNIT)],
    ["lock_creator (the plain coin's lock)", ix.rulesLockCreator(W.d2.publicKey, client.keys(pool0), 0n, lock.unlockAt + 10n)],
    ["run_burn (the plain coin's burn)", ix.rulesRunBurn(W.d2.publicKey, client.keys(pool0), 0n)],
  ]) {
    const text = await sendRefused(conn, [i], [W.d2], `S2: ${what} on a strict coin, by hand`);
    const named = rulesErrorFromLogs(text.split("\n"));
    const account = text.match(/Error Code: (AccountNotInitialized|AccountOwnedByWrongProgram|ConstraintSeeds|InvalidAccountData)/);
    check((named && named.name === "StrictCoin") || account, `S2: ${what} is refused: ${named && named.name === "StrictCoin" ? "StrictCoin (6034)" : `${account[1]}, an account the plain instruction needs does not exist on a strict coin`}`);
  }
  console.log(`  waiting for the chain's clock to reach ${lock.unlockAt}`);
  while ((await client.chainTime()).unixTime < lock.unlockAt) await sleep(500);
  h = await client.rulesHolderOf(S2.pool, W.d2.publicKey);
  lock = await client.rulesLock(S2.pool);
  check(!h.creatorLocked && h.free === h.balance && !lock.locked && lock.record.amount > 0n, "S2: the date has passed: the SDK says the coins are free, though the record still shows the lock");
  await sendCoins(S2, W.d2, W.x.publicKey, UNIT, "S2: the launcher sends one coin before clearing the lock");
  const ru = await send(await client.rulesUnlockInstructions(W.d2.publicKey, pool0), [W.d2], "S2: the launcher clears the lock");
  measure("unlock_creator_strict", ru);
  lock = await client.rulesLock(S2.pool);
  h = await client.rulesHolderOf(S2.pool, W.d2.publicKey);
  check(ru.events.some((e) => e.kind === "CreatorUnlocked") && lock.record.amount === 0n && h.record.locked === 0n && h.record.lockedUntil === 0n, "S2: the lock record and the holder record read zero (CreatorUnlocked)");
  await claimHolder(S2, W.d2, "S2: the launcher claims its holder rewards, earned on its locked coins too");
  await agree(S2, "S2, at the end");
}

// ---- S3. registration, proportion, burn, sync, close, the burn ----------------------------------------
if (part("S3")) {
  section("S3. No first buy and no window: holder rewards of 3% and a burn of 2% on each side");
  const S3 = await launchStrict("S3", "Strict Holders", "SHOLD", { buy: { holdersBps: 300, burnBps: 200 }, sell: { holdersBps: 300, burnBps: 200 }, strict: {} }, { dev: W.d3, devBuy: 0n });
  await trade(S3, W.h1, DIRECTION.BUY, sol(0.0004), "S3: a first holder buys for 0.0004 SOL");
  await trade(S3, W.h2, DIRECTION.BUY, sol(0.0004), "S3: a second holder buys for 0.0004 SOL");
  let st = await agree(S3, "S3, below 0.1% registered");
  check(S3.book.holdersBurned > 0n && st.config.accPerShare === 0n && st.config.totalStaked < st.config.minEligible && st.strict.registered === st.config.totalStaked && st.strict.minRegistered === st.config.minEligible,
    `S3: ${coins6(st.config.totalStaked)} coins registered, below the ${coins6(st.config.minEligible)} needed: the holders' share of the first trade (${S3.book.holdersBurned} lamports) went to the burn pot`);
  await trade(S3, W.h1, DIRECTION.BUY, sol(0.02), "S3: the first holder buys for 0.02 SOL, which takes the records over 0.1% of the supply");
  await trade(S3, W.h2, DIRECTION.BUY, sol(0.01), "S3: the second holder buys for 0.01 SOL");
  await trade(S3, W.h3, DIRECTION.BUY, sol(0.05), "S3: a third wallet buys for 0.05 SOL without a record", { openHolder: false });
  await trade(S3, W.h3, DIRECTION.SELL, (await coinsOf(W.h3.publicKey, S3.mint)) / 2n, "S3: it sells half");
  st = await agree(S3, "S3, above 0.1% registered");
  check(st.config.accPerShare > 0n && S3.book.holdersShared > 0n, `S3: the holders' share now goes to the records (${S3.book.holdersShared} lamports so far)`);
  {
    const h1 = await client.rulesHolderOf(S3.pool, W.h1.publicKey), h2 = await client.rulesHolderOf(S3.pool, W.h2.publicKey);
    console.log(`           first holder: ${coins6(h1.counted)} coins, ${h1.shareBps} bps of the registered total, ${h1.claimable} lamports to claim`);
    console.log(`           second holder: ${coins6(h2.counted)} coins, ${h2.shareBps} bps of the registered total, ${h2.claimable} lamports to claim`);
  }
  // a token Burn calls no hook
  const half = (await coinsOf(W.h2.publicKey, S3.mint)) / 2n;
  const rb = await send([ix.strictBurn(W.h2.publicKey, S3.mint, half, 6)], [W.h2], "S3: the second holder burns half its coins with a token Burn");
  S3.burned.add(W.h2.publicKey.toBase58());
  let h2 = await client.rulesHolderOf(S3.pool, W.h2.publicKey);
  check(h2.counted === h2.balance + half && rb.events.length === 0, `S3: the burn called no hook: the record still counts ${coins6(h2.counted)} coins, the wallet holds ${coins6(h2.balance)}`);
  await trade(S3, W.h1, DIRECTION.BUY, sol(0.01), "S3: a trade before anybody syncs the record");
  await agree(S3, "S3, with the record above the balance");
  const sync = await client.rulesSyncHolderInstructions(await client.pool(S3.pool), W.h2.publicKey);
  check(sync.length === 1 && isIx(sync[0], "sync_holder"), "S3: the SDK offers sync_holder for that record");
  const rs = await send(sync, [W.stranger], "S3: a stranger sends sync_holder");
  S3.book.sync(W.h2.publicKey, h2.balance);
  S3.burned.delete(W.h2.publicKey.toBase58());
  h2 = await client.rulesHolderOf(S3.pool, W.h2.publicKey);
  const se = rs.events.find((e) => e.kind === "HolderSynced");
  check(se && se.balance === h2.balance && h2.counted === h2.balance && (await client.rulesSyncHolderInstructions(await client.pool(S3.pool), W.h2.publicKey)).length === 0,
    "S3: the record is lowered to what the wallet holds (HolderSynced), and the SDK has nothing more to sync");
  measure("sync_holder", rs);
  await agree(S3, "S3, after sync_holder");
  // close_holder
  await trade(S3, W.h2, DIRECTION.SELL, await coinsOf(W.h2.publicKey, S3.mint), "S3: the second holder sells everything it has left");
  {
    const pool = await client.pool(S3.pool);
    await sdkRefuses(() => client.rulesCloseHolderInstructions(W.h2.publicKey, pool), 6049, "S3: closing the record while rewards are owed");
    await refused([ix.rulesCloseHolder(W.h2.publicKey, client.keys(pool))], [W.h2], "S3: that close, by hand", "HolderNotEmpty");
    await refused([ix.rulesCloseHolder(W.h1.publicKey, client.keys(pool))], [W.h1], "S3: the first holder closes its record while it holds coins, by hand", "HolderNotEmpty");
  }
  await trade(S3, W.h1, DIRECTION.BUY, sol(0.001), "S3: one more trade, so that the claim settles it");
  await claimHolder(S3, W.h2, "S3: the second holder claims");
  {
    const pool = await client.pool(S3.pool);
    const before = BigInt(await conn.getBalance(W.h2.publicKey));
    const rc = await send(await client.rulesCloseHolderInstructions(W.h2.publicKey, pool), [W.h2], "S3: and closes its record");
    S3.book.close(W.h2.publicKey);
    const back = BigInt(await conn.getBalance(W.h2.publicKey)) - before + 5_000n;
    check(rc.events.some((e) => e.kind === "HolderClosed") && !(await client.exists(rulesPda.holder(S3.pool, W.h2.publicKey))) && back === HOLDER_RECORD_RENT,
      `S3: the record is gone (HolderClosed) and its rent came back: ${fmt(back)} SOL`);
    measure("close_holder", rc);
  }
  await agree(S3, "S3, after close_holder");
  // the burn
  const supplyNow = async () => (await client.mint(S3.mint)).supply;
  const supply0 = await supplyNow();
  const first = await client.rulesBurnInstructions(W.stranger.publicKey, S3.pool);
  check(first.step === "observe" && first.instructions.some((i) => isIx(i, "run_burn_strict")), `S3: the burn pot holds ${fmt(first.pot)} SOL; the SDK builds run_burn_strict, whose first call only records the pool`);
  const r0 = await send(first.instructions, [W.stranger], "S3: a stranger calls the burn for the first time");
  measure("run_burn_strict that records an observation", r0);
  S3.book.settle();
  const e0 = r0.events.find((e) => e.kind === "BurnExecuted");
  check(e0 && e0.outcome === BURN_OUTCOME.OBSERVED && (await supplyNow()) === supply0, `S3: it bought nothing and recorded the pool (outcome ${BURN_OUTCOME.OBSERVED})`);
  await agree(S3, "S3, after the first call of the burn");
  const soon = await client.rulesBurnInstructions(W.stranger.publicKey, S3.pool);
  check(soon.step === "tooSoon" && soon.instructions.length === 0 && soon.dueSlot === r0.slot + BURN_INTERVAL_SLOTS, `S3: the SDK says the next call is refused before slot ${soon.dueSlot}`);
  await refused([ix.rulesRunBurnStrict(W.stranger.publicKey, client.keys(await client.pool(S3.pool)), 0n)], [W.stranger], "S3: a second call inside 25 slots, by hand", "BurnTooSoon");
  await waitForSlot(conn, soon.dueSlot);
  const run = await client.rulesBurnInstructions(W.stranger.publicKey, S3.pool);
  check(run.step === "buy" && run.spend > 0n, `S3: 25 slots later the call buys for ${fmt(run.spend)} SOL`);
  const rb2 = await send(run.instructions, [W.stranger], "S3: a stranger calls the burn again");
  measure("run_burn_strict that buys and burns", rb2);
  S3.book.burnRun(run.spend);
  const burned = supply0 - (await supplyNow());
  const be = rb2.events.find((e) => e.kind === "BurnExecuted");
  check(be && be.outcome === BURN_OUTCOME.BOUGHT && be.quoteSpent === run.spend && be.baseBurned === burned && burned === run.expectedOut && burned > 0n,
    `S3: it bought ${coins6(burned)} coins, exactly the SDK's quote, and burned them in the pool's vault: no transfer, no transfer hook`);
  await agree(S3, "S3, after the burn");
  check((await ruleBytes(S3.pool)) === S3.rulesAtLaunch, "S3: the rules at the end are the ones of the launch");
}

// ---- S4. a pool made directly ---------------------------------------------------------------------------
if (part("S4")) {
  const MW = 70;
  section(`S4. A pool made directly with create_pool, with a max wallet of 1% for ${MW} slots: removals are always paid`);
  const mint = Keypair.generate();
  const args = rulesArgs({ buy: { creatorBps: 100 }, sell: { creatorBps: 100 } });
  const strict = strictArgs({ maxWalletBps: 100, maxWalletSlots: MW });
  const k = poolKeys(mint.publicKey, NATIVE_MINT, TOKEN_2022_PROGRAM);
  const tokenArgs = { name: "Strict Direct", symbol: "SDIRECT", uri: "https://example.com/meta/sdirect.json", decimals: 6, totalSupply: SUPPLY };
  const tx1 = [...ix.createPeggedToken(W.d4.publicKey, mint.publicKey, PROGRAMS.hook_rules, tokenArgs), ix.rulesInitStrictConfig(W.d4.publicKey, k, args, strict)];
  tx1.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  await send(tx1, [W.d4, mint], "S4: the coin and its strict rules (the launchpad's pegged path, then init_strict_config)", { table: true });
  const KEEP = 20_000_000n * UNIT;
  const hook = { program: PROGRAMS.hook_rules, treasury: rulesPda.treasury(k.pool, NATIVE_MINT), extra: [{ pubkey: rulesPda.cfg(k.pool), isSigner: false, isWritable: true }, ...ix.strictPoolExtras(k.pool, mint.publicKey, W.d4.publicKey)] };
  const rc = await send(await client.createPoolInstructions(W.d4.publicKey, mint.publicKey, NATIVE_MINT, LP_FEE_BPS, SUPPLY - KEEP, sol(1), hook, TOKEN_2022_PROGRAM), [W.d4], "S4: the creator makes the pool with create_pool, keeping 20 million coins", { table: true });
  measure("create_pool of a strict coin", rc);
  const st = await client.rulesState(k.pool);
  const pool = await client.pool(k.pool);
  const lp = await tokenAmount(pda.ata(W.d4.publicKey, pool.lpMint));
  check(st.config.strict && st.config.startSlot === rc.slot && st.config.maxWalletAmount === SUPPLY / 100n && lp > 0n && (await client.isStrictPool(pool)),
    `S4: the pool started the strict config; the max wallet is ${coins6(st.config.maxWalletAmount)} coins; the creator holds ${lp} LP tokens`);
  await refused(await client.addLiquidityInstructions(W.d4.publicKey, pool, lp / 1000n, KEEP, sol(0.1)), [W.d4], "S4: the creator adds liquidity while the max wallet runs", "LiquidityInMaxWalletWindow");
  const before = await coinsOf(W.d4.publicKey, mint.publicKey);
  const rr = await send(await client.removeLiquidityInstructions(W.d4.publicKey, pool, lp / 2n, 0n, 0n), [W.d4], "S4: the creator takes half of the liquidity out while the max wallet runs");
  const got = (await coinsOf(W.d4.publicKey, mint.publicKey)) - before;
  check(rr.slot - st.config.startSlot < BigInt(MW) && before + got > st.config.maxWalletAmount * 10n,
    `S4: it landed ${rr.slot - st.config.startSlot} slots into the window and paid ${coins6(got)} coins: the wallet holds ${coins6(before + got)}, far above the max wallet, because a removal is never held to it`);
  await waitForSlot(conn, st.config.startSlot + BigInt(MW));
  const after = await client.pool(k.pool);
  const lpSupply = (await client.mint(after.lpMint)).supply;
  const ra = await send(await client.addLiquidityInstructions(W.d4.publicKey, after, lpSupply / 100n, before + got, sol(0.5)), [W.d4], "S4: after the window the creator adds liquidity again");
  check(ra.slot - st.config.startSlot >= BigInt(MW), "S4: deposits are open once the max wallet window is over");
  coins.push({ letter: "S4", name: tokenArgs.name, symbol: tokenArgs.symbol, mint: mint.publicKey, pool: k.pool, dev: W.d4 });
}

// ---- S5. the sniper window against the max wallet; a burn pot of one lamport ----------------------------
if (part("S5")) {
  const SNIPER = 400n, MW = 600;
  section(`S5. A sniper fee of 30% over ${SNIPER} slots with a max wallet of 3% for ${MW} slots, a creator fee and holder rewards of 1% and no burn rate`);
  const S5 = await launchStrict("S5", "Strict Sniper", "SSNIPE", {
    sniperSlots: SNIPER, sniperStartFeeBps: 3_000, buy: { creatorBps: 100, holdersBps: 100 }, sell: { creatorBps: 100, holdersBps: 100 },
    strict: { maxWalletBps: 300, maxWalletSlots: MW },
  }, { dev: W.d5, devBuy: sol(0.05) });

  section("S5, a burn pot of one lamport: the observation call is built and accepted, the buy is not due");
  // With a creator rate and a holders' rate of 1% each and no burn rate, each trade leaves
  // its fee modulo 2 in the burn pot: the two shares are rounded down, the pot takes the
  // rest. The launcher's first buy has an even fee; one buy with an odd fee makes a pot
  // of exactly one lamport.
  check(S5.first.hookFee % 2n === 0n, `S5: the launcher's first buy paid a hook fee of ${S5.first.hookFee} lamports, an even number: it leaves nothing in the burn pot`);
  let odd = sol(0.01);
  while (buyHookFee(odd, 200) % 2n === 0n) odd += 1n;
  const t1 = await trade(S5, W.m1, DIRECTION.BUY, odd, `S5: a wallet buys for ${odd} lamports, whose hook fee is odd`, { window: true });
  check(t1.ev.hookFee % 2n === 1n, `S5: the hook fee was ${t1.ev.hookFee} lamports, so the pot will hold one`);
  const tiny = await client.rulesBurnInstructions(W.stranger.publicKey, S5.pool);
  check(tiny && tiny.pot === 1n && tiny.step === "observe" && tiny.due && tiny.reason === undefined && tiny.expectedOut === 0n && tiny.minOut === 0n && tiny.instructions.some((i) => isIx(i, "run_burn_strict")),
    "S5: the burn pot holds one lamport of rounding and the burn never looked at this pool: the SDK builds the first call, which only records the pool, and quotes no buy (expectedOut and minOut are 0)");
  const r0 = await send(tiny.instructions, [W.stranger], "S5: a stranger sends it");
  S5.book.settle();
  const e0 = r0.events.find((e) => e.kind === "BurnExecuted");
  check(e0 && e0.outcome === BURN_OUTCOME.OBSERVED && e0.quoteSpent === 0n, `S5: the chain accepted it and recorded the pool (outcome ${BURN_OUTCOME.OBSERVED})`);
  await agree(S5, "S5, after the observation");
  await waitForSlot(conn, r0.slot + BURN_INTERVAL_SLOTS);
  const tinyBuy = await client.rulesBurnInstructions(W.stranger.publicKey, S5.pool);
  check(tinyBuy && tinyBuy.step === "buy" && !tinyBuy.due && tinyBuy.spend === 1n && tinyBuy.expectedOut === 0n && tinyBuy.minOut === 0n && tinyBuy.instructions.length === 0 && typeof tinyBuy.reason === "string" && tinyBuy.reason.length > 0,
    `S5: 25 slots later the step is a buy of one lamport, which cannot be quoted: the SDK says it is not due, builds nothing and says why: "${tinyBuy.reason}"`);
  {
    const text = await sendRefused(conn, [ix.rulesRunBurnStrict(W.stranger.publicKey, client.keys(await client.pool(S5.pool)), 0n)], [W.stranger], "S5: that buy, by hand");
    const code = text.match(/Error Code: (\w+)/) ?? text.match(/(custom program error: 0x[0-9a-f]+)/);
    check(!!code, `S5: the chain refuses it too: ${code ? code[1] : "no error name in the logs"}`);
  }

  section("S5, inside the sniper window: the largest buy the SDK accepts for a wallet near the cap lands on chain");
  const m2 = W.m2;
  /// The largest buy the SDK accepts for the wallet (quoteLocal with the wallet throws
  /// MaxWallet above it), found at one read slot.
  const largestAccepted = async () => {
    const pool = await client.pool(S5.pool); const info = await client.hookInfo(pool); const slot = await slotNow();
    let lo = 0n, hi = sol(3);
    while (hi - lo > 1_000n) {
      const mid = (lo + hi) / 2n;
      let ok = true;
      try { await client.quoteLocal(pool, platform, DIRECTION.BUY, mid, info, slot, m2.publicKey); } catch (e) { if (!(e instanceof StrictRefusal) || e.number !== 6044) throw e; ok = false; }
      if (ok) lo = mid; else hi = mid;
    }
    return { amount: lo, pool, info, slot };
  };
  /// The way a client without the ceiling would size it: the slot's quote against the room.
  const largestBySlotQuote = async () => {
    const pool = await client.pool(S5.pool); const info = await client.hookInfo(pool); const slot = await slotNow();
    const room = S5.maxWallet - (await coinsOf(m2.publicKey, S5.mint));
    let lo = 0n, hi = sol(3);
    while (hi - lo > 1_000n) { const mid = (lo + hi) / 2n; const q = await client.quoteLocal(pool, platform, DIRECTION.BUY, mid, info, slot); if (q.amountOut <= room) lo = mid; else hi = mid; }
    return { amount: lo, slot };
  };
  for (const round of [1, 2]) {
    const { amount, pool, info, slot } = await largestAccepted();
    const q = await client.quoteLocal(pool, platform, DIRECTION.BUY, amount, info, slot, m2.publicKey);
    const balance = await coinsOf(m2.publicKey, S5.mint);
    check(q.amountOutCeiling > q.amountOut && balance + q.amountOutCeiling <= S5.maxWallet && q.feeBpsApplied > pool.lpFeeBps,
      `S5, round ${round}: the largest buy the SDK accepts is ${amount} lamports: ${coins6(q.amountOut)} coins at slot ${slot}'s pool fee of ${q.feeBpsApplied} bps, at most ${coins6(q.amountOutCeiling)} at the pool's own ${pool.lpFeeBps} bps, which keeps the wallet (${coins6(balance)} coins) under the cap of ${coins6(S5.maxWallet)}`);
    await sleep(3_000);
    const r = await trade(S5, m2, DIRECTION.BUY, amount, `S5, round ${round}: that buy, sent about eight slots later`, { window: true });
    check(r.after <= S5.maxWallet && r.ev.amountOut > q.amountOut && r.ev.amountOut <= q.amountOutCeiling,
      `S5, round ${round}: it landed ${r.ev.slot - slot} slots after the quote with ${coins6(r.ev.amountOut)} coins, more than the slot's quote and within the ceiling; the wallet holds ${coins6(r.after)}, ${coins6(S5.maxWallet - r.after)} under the cap`);
  }
  {
    const { amount: naive, slot } = await largestBySlotQuote();
    const { amount: accepted, pool, info } = await largestAccepted();
    check(naive > accepted, `S5: sized by the slot's quote alone, the largest buy would be ${naive} lamports, above the ${accepted} the SDK accepts`);
    let said = null;
    try { await client.quoteLocal(pool, platform, DIRECTION.BUY, naive, info, undefined, m2.publicKey); } catch (e) { said = e; }
    check(said instanceof StrictRefusal && said.number === 6044 && said.message.includes("falling fee"), `S5: the SDK refuses it with MaxWallet and says why: "${said && said.message}"`);
    await sleep(3_000);
    const now = await client.pool(S5.pool);
    await refused(await client.swapInstructions(m2.publicKey, now, await client.hookRef(now, m2.publicKey), DIRECTION.BUY, naive, 0n), [m2], `S5: that buy, sent all the same about eight slots after slot ${slot}`, "MaxWallet");
  }
  await agree(S5, "S5, at the end");
}

// ---- P. the strict instructions on a plain coin ------------------------------------------------------------
if (part("P")) {
  section("P. A plain rules coin: the strict instructions refuse it");
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({
    dev: W.dp.publicKey, mint, name: "Plain Rules", symbol: "PLAIN", uri: "https://example.com/meta/plain.json", decimals: 6, totalSupply: SUPPLY,
    quoteMint: NATIVE_MINT, lpFeeBps: LP_FEE_BPS, quoteAmount: LIQUIDITY, devBuyQuote: 0n, minDevBuyOut: 0n, template: "rules", rules: { buy: { creatorBps: 100, burnBps: 100 } },
  });
  check(plan.needsLookupTable === false && plan.strict === undefined, "P: a plain launch needs no lookup table and states no max wallet");
  await send(plan.createTx, [W.dp, ...plan.signers], "P: transaction 1");
  await send(plan.launchTx, [W.dp], "P: transaction 2");
  const pool = await client.pool(plan.pool);
  const st = await client.rulesState(plan.pool);
  check(st.config.kind === RULES_KIND.PLAIN && !st.config.strict && st.strict === null && !(await client.isStrictPool(pool)) && (await client.rulesHolderOf(plan.pool, W.dp.publicKey)) === null,
    "P: kind 0; rulesState has no strict part and rulesHolderOf answers null");
  await refused([ix.rulesOpenHolder(W.dp.publicKey, client.keys(pool))], [W.dp], "P: open_holder on a plain coin, by hand", "NotStrict");
  coins.push({ letter: "P", name: "Plain Rules", symbol: "PLAIN", mint: mint.publicKey, pool: plan.pool, dev: W.dp });
}

console.log("\ncompute units and sizes (sent transactions):");
const seen = new Set();
for (const m of measures) {
  if (seen.has(m.what) && !m.what.includes("launch")) continue;
  seen.add(m.what);
  const sizes = m.sizes ? `; ${fits(m.sizes.legacy)} without the lookup table, ${fits(m.sizes.v0)} with it` : `; ${m.size} bytes ${m.table ? "with" : "without"} the lookup table`;
  console.log(`  ${m.what}: ${m.cu} compute units${sizes}`);
}
console.log("\ncoins left on the chain:");
for (const c of coins) console.log(`  ${c.letter}  ${c.name} (${c.symbol})  coin ${c.mint.toBase58()}  pool ${c.pool.toBase58()}  launcher ${c.dev.publicKey.toBase58()}`);
console.log(`\nstrict e2e passed: ${checks} checks`);
