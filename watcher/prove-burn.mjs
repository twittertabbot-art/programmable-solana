#!/usr/bin/env node
// Live proof of the burn keeper, on the local validator only (it airdrops).
//
//   node watcher/prove-burn.mjs                      launches a buyback coin, a rules coin, a strict rules coin and
//                                                    a rules coin on the curve, each with a burn rate, trades on all
//                                                    four, then runs the watcher on each
//   node watcher/prove-burn.mjs --buyback <pool>     use a buyback pool that exists instead of launching one
//   node watcher/prove-burn.mjs --rules <pool>       use a plain rules pool that exists instead of launching one
//   node watcher/prove-burn.mjs --strict <pool>      use a strict rules pool that exists instead of launching one
//   node watcher/prove-burn.mjs --curve <pool>       use a plain rules pool on the curve that exists instead
//
// A pool given by address must hold something to spend and must never have been looked at by a buyback or a
// burn (no observation in its config): the proof shows the first call, and a pool has only one first call.
//
// What it does, with fresh wallets that exist only in this run:
//   1. It launches the four coins. The first three are seeded with 5 SOL of liquidity. The buyback coin takes 2%
//      of every trade for its buybacks. The rules coin takes 1.5% of a buy and 2.5% of a sell: 0.5% for its
//      creator, the rest for the burn. The strict coin (its rules run inside every transfer, so its burn is
//      run_burn_strict) takes the same plus 1% for holders with a holder record. The curve coin has the rules
//      coin's rates and launches on the curve: no SOL from its creator, 30 SOL of virtual SOL in its price. Its
//      burn compares prices and depths on the effective quote, `reserveQuote + virtualQuote`, and every number
//      this proof works out by hand does the same (on a seeded pool the virtual part is 0).
//   2. A trader buys and sells on all four until each pot holds more than one buy of the burn may spend. On
//      the strict coin its first buy opens its holder record; then it burns half its coins with a token Burn,
//      which leaves the record counting coins that are gone.
//   3. For each coin it runs the real watcher (node index.mjs --once --pool <pool>) one round at a time, with
//      its state and status files in a temporary folder, and reads the chain after every round:
//        round 1   the keeper sends one call. It records the pool (the observation) and buys nothing. On the
//                  strict coin it also sends one sync_holder, and the trader's record counts its coins again.
//        round 2   at once, inside 25 slots: the keeper sends nothing. A call would be refused as too soon.
//        round 3   after 25 slots: the keeper sends one call. It buys and burns: the coin's supply falls by
//                  what the event says, the pot falls by what was spent, the observation is the pool after
//                  the buy.
//   4. It adds up what the keeper paid.
//
// The only key file it opens is the watcher's own probe keypair, to learn the keeper's public address. It never
// prints a secret. The coins are throwaway: nothing is cleaned up, and nobody else is expected to trade them
// while the proof runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  HookpoolClient, DIRECTION, NATIVE_MINT, PROGRAMS, BURN_INTERVAL_SLOTS, BURN_OUTCOME, RULES_KIND, TOKEN_2022_PROGRAM, CURVE_OPEN, decodeBuybackConfig, decodeTokenAmount, eventsFromTransaction, ix, pda, rulesPda,
} from "../sdk/dist/index.js";
import { loadConfig, WATCHER_DIR, REPO_DIR } from "./lib/config.mjs";

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const given = { buyback: argOf("--buyback"), rules: argOf("--rules"), strict: argOf("--strict"), curve: argOf("--curve") };

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
const OURS = Object.values(PROGRAMS).map((p) => p.toBase58());

const say = (s = "") => console.log(s);
const step = (s) => console.log(`\n== ${s}`);
let checks = 0;
const check = (cond, msg) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); checks += 1; console.log(`  check  ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9);
const lamportsOf = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const least = (a, b) => (a < b ? a : b);

/// Airdrop, two SOL at a time.
async function fund(pubkey, lamports) {
  for (let left = Math.ceil(lamports); left > 0; left -= 2 * LAMPORTS_PER_SOL) {
    const sig = await conn.requestAirdrop(pubkey, Math.min(left, 2 * LAMPORTS_PER_SOL));
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }
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
async function waitForSlot(slot) {
  for (;;) { const now = BigInt(await conn.getSlot("confirmed")); if (now >= slot) return now; await sleep(400); }
}
const tokenAmount = async (account) => { const a = await conn.getAccountInfo(account); return a ? decodeTokenAmount(new Uint8Array(a.data)) : 0n; };

// ---- the rule of a buy, written out again here (HOOKS.md section 7), without the SDK ------------------

/// The share of a trade's hook fee that the burn of a rules coin keeps, in basis points.
const burnShare = (side) => { const total = side.creatorBps + side.holdersBps + side.burnBps; return total === 0 ? 0 : Math.floor((Math.min(total, platform.maxHookFeeBps) * side.burnBps) / total); };
/// The cap of one buy in basis points of the pool's quote reserve.
function capBpsOf(coin, lpFeeBps) {
  const sure = platform.protocolFeeBps + (coin.kind === "buyback"
    ? Math.min(coin.fees.buyBps, platform.maxHookFeeBps) + Math.min(coin.fees.sellBps, platform.maxHookFeeBps)
    : burnShare(coin.fees.buy) + burnShare(coin.fees.sell));
  const soft = platform.protocolFeeBps + 2 * lpFeeBps;
  return Math.min(50, Math.max(1, Math.floor((sure + Math.min(sure, soft)) / 4)));
}
/// What one buy spends: the pot, up to the cap of the smaller of the pool's quote reserve now and the observed one.
/// Both are effective reserves: on a pool on the curve the virtual SOL counts in the depth, as in the price.
function spendOf(pot, reserveQuote, obsReserveQuote, capBps) {
  const cap = (least(reserveQuote, obsReserveQuote) * BigInt(capBps)) / 10_000n;
  return least(pot, cap > 1n ? cap : 1n);
}
/// The quote reserve a price is made of: the real one plus the virtual SOL of a pool on the curve (0 otherwise).
const eff = (pool) => pool.reserveQuote + pool.virtualQuote;

// ---- reading one coin ------------------------------------------------------------------------------------

/// The pool, the hook's config as bytes, the observation in it, the pot, the counter of buys, the supply.
async function read(coin) {
  const pool = await client.pool(coin.pool);
  const cfgInfo = await conn.getAccountInfo(coin.cfgKey);
  const bytes = Buffer.from(cfgInfo.data);
  let pot; let obs; let buys; let burnedTotal;
  if (coin.kind === "buyback") {
    const c = decodeBuybackConfig(new Uint8Array(bytes));
    pot = await tokenAmount(pool.hookQuoteTreasury);
    obs = { slot: c.obsSlot, reserveBase: c.obsReserveBase, reserveQuote: c.obsReserveQuote };
    buys = c.buybacks; burnedTotal = c.totalBaseBurned;
  } else {
    const st = await client.rulesState(coin.pool);
    pot = st.burnPot;       // with the fee of the last trade counted in, as the program settles it
    obs = { slot: st.config.obsSlot, reserveBase: st.config.obsReserveBase, reserveQuote: st.config.obsReserveQuote };
    buys = st.config.burns; burnedTotal = st.config.totalBaseBurned;
  }
  const supply = (await client.mint(pool.baseMint)).supply;
  return { pool, bytes, pot, obs, observed: obs.reserveBase !== 0n && obs.reserveQuote !== 0n, buys, burnedTotal, supply, burnAccount: await tokenAmount(coin.burnAccount) };
}

// ---- the watcher -----------------------------------------------------------------------------------------

/// Run the real watcher once, on one pool, and return what it printed.
function runWatcher(coin, tmp) {
  const env = { ...process.env, STATE_FILE: path.join(tmp, "state.json"), STATUS_FILE: path.join(tmp, "pools.json") };
  const r = spawnSync(process.execPath, ["index.mjs", "--once", "--pool", coin.pool.toBase58()], { cwd: WATCHER_DIR, env, encoding: "utf8", timeout: 180000 });
  const lines = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n");
  // the burn keeper's own lines, and any alert, warning or error that names this pool
  const shown = lines.filter((l) => /^\d{4}-\d\d-\d\dT/.test(l) && (/ burn: | burn done: | burn totals: | burn FAILED: | sync: | sync FAILED: | sync totals: /.test(l) || (/ALERT| warn | error /.test(l) && l.includes(coin.pool.toBase58()))));
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
    let tx = null;
    for (let i = 0; i < 20 && !tx; i++) { tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); if (!tx) await sleep(200); }
    if (!tx || !tx.meta) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).keySegments().flat();
    const at = keys.findIndex((k) => k.equals(keeper));
    const size = tx.transaction.message.serialize().length + 1 + 64 * tx.transaction.signatures.length;
    out.push({
      signature: s.signature, slot: BigInt(tx.slot), paidByKeeper: at === 0, fee: at === 0 ? tx.meta.fee : 0, delta: at >= 0 ? tx.meta.postBalances[at] - tx.meta.preBalances[at] : 0,
      cu: tx.meta.computeUnitsConsumed, size, logs: tx.meta.logMessages ?? [], events: eventsFromTransaction(tx, OURS), touches: (key) => keys.some((k) => k.equals(key)), err: tx.meta.err,
    });
  }
  return out;
}
/// One round of the real watcher on one coin, and what the keeper did in it.
async function watcherRound(coin, tmp, label) {
  const last = (await conn.getSignaturesForAddress(keeper, { limit: 1 }, "confirmed"))[0];
  const keeperBefore = await conn.getBalance(keeper);
  say(`  the watcher, ${label}. Its lines about the burn keeper:`);
  const run = runWatcher(coin, tmp);
  check(run.status === 0, "the watcher finished with exit code 0");
  const txs = await keeperTxsSince(last ? last.signature : null);
  const keeperAfter = await conn.getBalance(keeper);
  const moved = txs.reduce((n, t) => n + t.delta, 0);
  check(keeperAfter - keeperBefore === moved, `the keeper's SOL balance moved by the sum of its ${txs.length} transaction(s) of this round: ${signed(moved)} lamports`);
  const calls = txs.filter((t) => t.paidByKeeper && t.touches(coin.cfgKey) && t.events.some((e) => e.kind === coin.event));
  return { run, txs, calls };
}

// ---- the scene -------------------------------------------------------------------------------------------

step(`burn keeper proof on ${cfg.rpcUrl}`);
say(`  keeper (the watcher's probe wallet): ${keeper.toBase58()}`);
say(`  platform: protocol fee ${platform.protocolFeeBps} bps, hook fee cap ${platform.maxHookFeeBps} bps`);
if ((await conn.getBalance(keeper)) < LAMPORTS_PER_SOL / 2) { await fund(keeper, LAMPORTS_PER_SOL); say("  keeper was low: airdropped 1 SOL"); }

const SUPPLY = 1_000_000_000n * 1_000_000n;
const LIQUIDITY = lamportsOf(5);
const FEES = {
  buyback: { buyBps: 200, sellBps: 200 },
  rules: { buy: { creatorBps: 50, holdersBps: 0, burnBps: 100 }, sell: { creatorBps: 50, holdersBps: 0, burnBps: 200 } },
  // a strict coin: the same burn, a holders' share, and no window (its rules run inside every transfer)
  strict: { buy: { creatorBps: 50, holdersBps: 100, burnBps: 100 }, sell: { creatorBps: 50, holdersBps: 100, burnBps: 200 }, strict: {} },
  // a rules coin on the curve: the rules coin's rates
  curve: { buy: { creatorBps: 50, holdersBps: 0, burnBps: 100 }, sell: { creatorBps: 50, holdersBps: 0, burnBps: 200 } },
};
const NAMES = { buyback: ["KBB", "Keeper Buyback Proof"], rules: ["KRB", "Keeper Burn Proof"], strict: ["KSB", "Keeper Strict Proof"], curve: ["KCB", "Keeper Curve Burn Proof"] };
/// The trader's buy on each coin. A pool on the curve is about seven times deeper than a 5 SOL seeded pool (30 SOL
/// of virtual SOL), so one buy of its burn may spend about seven times more: it takes larger trades to fill the pot.
const TRADE_SOL = { buyback: 1.5, rules: 1.5, strict: 1.5, curve: 5 };
async function launch(kind) {
  const dev = Keypair.generate(); const mint = Keypair.generate();
  await fund(dev.publicKey, 7 * LAMPORTS_PER_SOL);
  const [symbol, name] = NAMES[kind];
  const onCurve = kind === "curve";
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name, symbol, uri: `https://example.com/meta/${symbol.toLowerCase()}.json`, decimals: 6, totalSupply: SUPPLY,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, ...(onCurve ? { curve: true } : { quoteAmount: LIQUIDITY }), devBuyQuote: 0n, minDevBuyOut: 0n, template: kind === "buyback" ? "buyback" : "rules",
    ...(kind === "buyback" ? { buyback: { ...FEES.buyback, minQuote: 1_000_000n } } : { rules: FEES[kind] }),
  });
  await send(plan.createTx, [dev, mint], `launch the ${kind} coin ${symbol}: the coin and its hook's config`);
  await send(plan.launchTx, [dev], onCurve ? `launch the ${kind} coin ${symbol}: the pool on the curve, no SOL from the creator` : `launch the ${kind} coin ${symbol}: the pool, 5 SOL of liquidity`);
  return plan.pool;
}
/// Everything the proof needs to know about one coin.
async function coinOf(kind, address) {
  const pool = await client.pool(address);
  const program = kind === "buyback" ? PROGRAMS.hook_buyback : PROGRAMS.hook_rules;
  if (!pool || !pool.hookProgram.equals(program)) { console.error(`${address.toBase58()} is not a ${kind} pool`); process.exit(2); }
  const authority = pda.hookAuthority(address, program)[0];
  const info = await client.hookInfo(pool);
  const fees = kind === "buyback" ? { buyBps: info.buyback.buyBps, sellBps: info.buyback.sellBps } : { buy: info.rules.buy, sell: info.rules.sell };
  if (kind !== "buyback" && (info.rules.kind === RULES_KIND.STRICT) !== (kind === "strict")) { console.error(`${address.toBase58()} is not a ${kind} rules coin`); process.exit(2); }
  if ((pool.curveState === CURVE_OPEN) !== (kind === "curve")) { console.error(`${address.toBase58()} is ${pool.curveState === CURVE_OPEN ? "" : "not "}on the curve: not a ${kind} pool for this proof`); process.exit(2); }
  const md = await client.metadata(pool.baseMint);
  return {
    // the watcher calls both rules kinds "rules" in its burn lines
    kind, burnKind: kind === "buyback" ? "buyback" : "rules",
    pool: address, symbol: md && md.symbol ? md.symbol : "?", mint: pool.baseMint, cfgKey: pda.cfg(program, address), fees,
    burnAccount: kind === "buyback" ? pda.ata(authority, pool.baseMint, pool.baseTokenProgram) : rulesPda.burnAccount(address, pool.baseMint, pool.baseTokenProgram),
    event: kind === "buyback" ? "BuybackExecuted" : "BurnExecuted", what: kind === "buyback" ? "buyback treasury" : "burn pot",
  };
}

let failure = null;
let tmp = null;
const paid = [];
try {
  step("1. the four coins");
  const coins = [];
  for (const kind of ["buyback", "rules", "strict", "curve"]) {
    const address = given[kind] ? new PublicKey(given[kind]) : await launch(kind);
    const coin = await coinOf(kind, address);
    coins.push(coin);
    const p = await client.pool(address);
    coin.capBps = capBpsOf(coin, p.lpFeeBps);
    say(`  ${kind} coin ${coin.symbol}: pool ${address.toBase58()}, coin ${coin.mint.toBase58()}, ${sol(p.reserveQuote)} SOL in the pool${p.virtualQuote > 0n ? `, on the curve with ${sol(p.virtualQuote)} SOL of virtual SOL` : ""}`);
    say(`    ${kind === "buyback" ? `fee for buybacks: ${coin.fees.buyBps} bps of a buy, ${coin.fees.sellBps} bps of a sell` : `burn rate: ${coin.fees.buy.burnBps} bps of a buy, ${coin.fees.sell.burnBps} bps of a sell (the creator takes ${coin.fees.buy.creatorBps} and ${coin.fees.sell.creatorBps})`}; one buy of the burn may spend ${coin.capBps} bps of the pool's SOL, worked out by hand`);
  }

  step("2. a trader buys and sells on all four, until each pot holds more than one buy may spend");
  const trader = Keypair.generate();
  await fund(trader.publicKey, 16 * LAMPORTS_PER_SOL);
  for (const coin of coins) {
    for (let round = 1; round <= 4; round++) {
      const now = await read(coin);
      const one = spendOf(now.pot + 1n, eff(now.pool), eff(now.pool), coin.capBps);
      if (now.pot > (one * 3n) / 2n) break;
      const amount = lamportsOf(TRADE_SOL[coin.kind]);
      const hook = await client.hookRef(now.pool, trader.publicKey);
      const out = await client.quoteOnChain(trader.publicKey, now.pool, DIRECTION.BUY, amount);
      await send(await client.swapInstructions(trader.publicKey, now.pool, hook, DIRECTION.BUY, amount, (out * 98n) / 100n), [trader], `${coin.symbol}: the trader buys for ${TRADE_SOL[coin.kind]} SOL`);
      const p2 = await client.pool(coin.pool);
      const coinsHeld = await client.tokenBalance(trader.publicKey, coin.mint, p2.baseTokenProgram);
      const sellAmount = (coinsHeld * 9n) / 10n;
      const back = await client.quoteOnChain(trader.publicKey, p2, DIRECTION.SELL, sellAmount);
      await send(await client.swapInstructions(trader.publicKey, p2, await client.hookRef(p2, trader.publicKey), DIRECTION.SELL, sellAmount, (back * 98n) / 100n), [trader], `${coin.symbol}: the trader sells nine tenths of it`);
    }
    const now = await read(coin);
    const one = spendOf(now.pot, eff(now.pool), eff(now.pool), coin.capBps);
    check(now.pot > one && now.pot >= cfg.burnMinPotLamports, `${coin.symbol}: ${now.pot} lamports (${sol(now.pot)} SOL) wait in the ${coin.what}; one buy may spend ${one}, so the pot takes more than one buy`);
    if (coin.kind === "curve") check(now.pool.curveState === CURVE_OPEN && now.pool.reserveQuote < now.pool.graduationTarget, `${coin.symbol}: the pool is still on the curve, ${sol(now.pool.reserveQuote)} SOL of real SOL of the ${sol(now.pool.graduationTarget)} it graduates at`);
    check(!now.observed && now.buys === 0n, `${coin.symbol}: no buyback or burn has ever looked at this pool: its config holds no observation`);
    if (coin.kind === "strict") {
      // A token Burn calls no transfer hook: the trader's holder record keeps counting the burned coins until
      // somebody syncs it. The watcher's burn keeper does, in its next pass.
      const h0 = await client.rulesHolderOf(coin.pool, trader.publicKey);
      check(!!h0 && !!h0.record && h0.record.balance === h0.balance && h0.balance > 0n, `${coin.symbol}: the trader's first buy opened its holder record, which counts its ${h0 && h0.balance} raw coins`);
      const burned = h0.balance / 2n;
      await send([ix.strictBurn(trader.publicKey, coin.mint, burned, 6)], [trader], `${coin.symbol}: the trader burns half its coins with a token Burn`);
      const h1 = await client.rulesHolderOf(coin.pool, trader.publicKey);
      check(h1.record.balance === h0.balance && h1.balance === h0.balance - burned, `${coin.symbol}: the record still counts ${h1.record.balance} raw coins, the wallet holds ${h1.balance}: it stands ${h1.record.balance - h1.balance} above`);
      coin.sync = { wallet: trader.publicKey, recordBalance: h1.record.balance, balance: h1.balance };
    }
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-burn-proof-"));
  for (const coin of coins) {
    step(`3. the ${coin.kind} coin ${coin.symbol}, pool ${coin.pool.toBase58()}`);
    const s0 = await read(coin);

    // ---- round 1: the observation
    say(`  before: pot ${s0.pot} lamports, supply ${s0.supply} raw coins, pool reserves ${s0.pool.reserveBase} raw coins and ${s0.pool.reserveQuote} lamports`);
    const r1 = await watcherRound(coin, tmp, "round 1");
    check(r1.calls.length === 1 && !r1.calls[0].err, `round 1: the keeper sent one call for this pool: ${r1.calls[0] ? r1.calls[0].signature : "none"}`);
    const c1 = r1.calls[0];
    const e1 = c1.events.find((e) => e.kind === coin.event);
    const s1 = await read(coin);
    check(e1.outcome === BURN_OUTCOME.OBSERVED && e1.quoteSpent === 0n && e1.baseBurned === 0n && e1.pool.equals(coin.pool), `the chain's ${coin.event} event says outcome ${e1.outcome} (observed): nothing spent, nothing burned`);
    check(s1.observed && s1.obs.slot === c1.slot && s1.obs.reserveBase === s0.pool.reserveBase && s1.obs.reserveQuote === eff(s0.pool) && e1.obsReserveBase === s1.obs.reserveBase && e1.obsReserveQuote === s1.obs.reserveQuote,
      `the config now holds the observation: slot ${s1.obs.slot}, ${s1.obs.reserveBase} raw coins and ${s1.obs.reserveQuote} lamports, the pool's reserves as they were${s0.pool.virtualQuote > 0n ? " with the virtual SOL in" : ""}`);
    if (coin.kind === "curve") check(s1.obs.reserveQuote === s0.pool.reserveQuote + s0.pool.virtualQuote && s1.obs.reserveQuote > s0.pool.reserveQuote, `on the curve the observation is the EFFECTIVE quote: ${s0.pool.reserveQuote} real + ${s0.pool.virtualQuote} virtual = ${s1.obs.reserveQuote} lamports`);
    check(s1.supply === s0.supply && s1.pot === s0.pot && s1.buys === s0.buys && s1.pool.reserveQuote === s0.pool.reserveQuote, "the supply, the pot, the pool and the counter of buys did not move");
    check(r1.run.lines.some((l) => l.includes(`burn: pool ${coin.pool.toBase58()} (${coin.burnKind}): observed`)), `the watcher's own line says "observed"`);
    check(c1.size <= 1232 && c1.fee === 5000 && c1.delta === -5000, `that transaction is ${c1.size} bytes, used ${c1.cu} compute units and cost the keeper its fee of ${c1.fee} lamports, nothing else`);
    paid.push({ coin: coin.symbol, what: "observe", ...c1 });
    if (coin.sync) {
      // the same round synced the trader's record
      const syncs = r1.txs.filter((t) => t.paidByKeeper && t.events.some((e) => e.kind === "HolderSynced"));
      const ev = syncs.length ? syncs[0].events.find((e) => e.kind === "HolderSynced") : null;
      const h2 = await client.rulesHolderOf(coin.pool, coin.sync.wallet);
      check(syncs.length === 1 && !syncs[0].err && ev.owner.equals(coin.sync.wallet) && ev.balance === coin.sync.balance && syncs[0].logs.some((l) => l.includes("Instruction: SyncHolder")),
        `round 1 also sent one sync_holder for the trader's record: HolderSynced says ${ev && ev.balance} raw coins, ${syncs[0] ? syncs[0].signature : "none"}`);
      check(h2.record.balance === h2.balance && h2.balance === coin.sync.balance, `the record counts what the wallet holds again: ${h2.record.balance} raw coins`);
      check(r1.run.lines.some((l) => l.includes(`sync: pool ${coin.pool.toBase58()} wallet ${coin.sync.wallet.toBase58()}: holder record lowered from ${coin.sync.recordBalance} to ${coin.sync.balance} raw units`)), "the watcher's own line says so, with both numbers");
      check(syncs[0].fee === 5000 && syncs[0].delta === -5000, `that transaction is ${syncs[0].size} bytes, used ${syncs[0].cu} compute units and cost the keeper its fee of 5000 lamports`);
      paid.push({ coin: coin.symbol, what: "sync", ...syncs[0] });
    }

    // ---- round 2: too soon
    const dueSlot = s1.obs.slot + BURN_INTERVAL_SLOTS;
    const r2 = await watcherRound(coin, tmp, "round 2, at once");
    const slotAfter = BigInt(await conn.getSlot("confirmed"));
    const tooSoonLine = r2.run.lines.find((l) => l.includes(`burn: pool ${coin.pool.toBase58()} (${coin.burnKind}): too soon`));
    check(!!tooSoonLine, `round 2 ran inside the 25 slots (the chain is at slot ${slotAfter}, a call is taken from slot ${dueSlot}); the watcher says: ${tooSoonLine ? tooSoonLine.slice(tooSoonLine.indexOf("burn:")) : "(no such line: this machine was too slow to run round 2 inside ten seconds)"}`);
    check(r2.calls.length === 0 && !r2.txs.some((t) => t.touches(coin.cfgKey)), "round 2: the keeper sent nothing for this pool" + (coin.sync ? ", no sync either: the record stands where it should" : ""));
    const s2 = await read(coin);
    check(s2.bytes.equals(s1.bytes) && s2.supply === s1.supply && s2.pot === s1.pot, "the hook's config is the same byte for byte; supply and pot did not move");

    // ---- round 3: the buy
    await waitForSlot(dueSlot + 1n);
    const s3 = await read(coin);
    const spend = spendOf(s3.pot, eff(s3.pool), s3.obs.reserveQuote, coin.capBps);
    const sdk = coin.kind === "buyback" ? await client.buybackInstructions(keeper, s3.pool, cfg.burnSlippageBps) : await client.rulesBurnInstructions(keeper, coin.pool, cfg.burnSlippageBps);
    check(sdk && sdk.step === "buy" && sdk.spend === spend && sdk.capBps === coin.capBps, `25 slots later a call buys. By hand it spends ${spend} lamports: ${coin.capBps} bps of ${least(eff(s3.pool), s3.obs.reserveQuote)} lamports, the smaller of the pool now and the observed one. The SDK says the same, and expects ${sdk ? sdk.expectedOut : "?"} raw coins for it`);
    const r3 = await watcherRound(coin, tmp, "round 3, after 25 slots");
    check(r3.calls.length === 1 && !r3.calls[0].err, `round 3: the keeper sent one call for this pool: ${r3.calls[0] ? r3.calls[0].signature : "none"}`);
    const c3 = r3.calls[0];
    const e3 = c3.events.find((e) => e.kind === coin.event);
    const swap = c3.events.find((e) => e.kind === "Swapped");
    const s4 = await read(coin);
    check(e3.outcome === BURN_OUTCOME.BOUGHT && e3.quoteSpent === spend && e3.baseBurned > 0n && e3.slot === c3.slot, `the chain's ${coin.event} event says outcome ${e3.outcome} (bought): ${e3.quoteSpent} lamports spent, ${e3.baseBurned} raw coins burned, in slot ${e3.slot}`);
    check(s3.supply - s4.supply === e3.baseBurned && e3.baseBurned === sdk.expectedOut, `the coin's supply fell from ${s3.supply} to ${s4.supply}: by ${s3.supply - s4.supply} raw coins, exactly what the event says, and what the SDK quoted`);
    check(s3.pot - s4.pot === e3.quoteSpent && s4.pot > 0n, `the ${coin.what} fell from ${s3.pot} to ${s4.pot} lamports: by ${s3.pot - s4.pot}, exactly what was spent. The rest waits for the next buy`);
    check(!!swap && swap.byHook && swap.hookFee === 0n && swap.amountIn === spend && swap.amountOut === e3.baseBurned && swap.direction === DIRECTION.BUY, "the pool's own event shows a buy made by the hook, for that amount, with no hook fee");
    check(s4.burnAccount === 0n && s4.buys === s3.buys + 1n && s4.burnedTotal - s3.burnedTotal === e3.baseBurned, `everything bought was burned in the same instruction: the hook's coin account is empty, and the config counts ${s4.buys} buy(s) and ${s4.burnedTotal} raw coins burned`);
    check(s4.obs.slot === c3.slot && s4.obs.reserveBase === s4.pool.reserveBase && s4.obs.reserveQuote === eff(s4.pool) && e3.obsReserveQuote === eff(s4.pool), `the observation is now the pool as the buy left it, in slot ${s4.obs.slot}: the next buy can follow 25 slots later`);
    check(r3.run.lines.some((l) => l.includes(`burn: pool ${coin.pool.toBase58()} (${coin.burnKind}): bought, spent ${e3.quoteSpent} lamports, burned ${e3.baseBurned} raw coins, ${s4.pot} lamports left in the pot`)), "the watcher's own line carries the same three numbers: spent, burned, left in the pot");
    check(c3.size <= 1232 && c3.fee === 5000 && c3.delta === -5000, `that transaction is ${c3.size} bytes, used ${c3.cu} compute units and cost the keeper its fee of ${c3.fee} lamports; the keeper received nothing`);
    paid.push({ coin: coin.symbol, what: "buy", ...c3 });
    if (coin.kind === "strict") {
      check(c3.logs.some((l) => l.includes("Instruction: RunBurnStrict")) && c3.logs.some((l) => l.includes("Instruction: HookBuyBurn")) && !c3.logs.some((l) => /Instruction: RunBurn$/.test(l)),
        "on a strict coin the keeper's call is run_burn_strict, which buys through the pool's hook_buy_burn: the pool burns the coins in its own vault and no transfer runs");
    }

    // what the pool report says
    const entry = r3.run.entry;
    check(!!entry && entry.template === coin.burnKind && entry.hookKind === "platform" && entry.score !== "danger" && (coin.kind !== "strict" || entry.declared.kind === "strict"), `the pool report: template ${entry && entry.template}${coin.kind === "strict" ? ", kind " + (entry && entry.declared.kind) : ""}, a platform template, score ${entry && entry.score}`);
    if (coin.kind === "curve") {
      // the simulations quote with the virtual SOL: the coin's own 1.5% and 2.5% are what the probes read, no false alarm
      check(entry.score === "clean" && !!entry.curve && entry.curve.state === "open" && entry.curve.raised === s4.pool.reserveQuote.toString() && entry.curve.virtualQuote === s4.pool.virtualQuote.toString()
        && entry.effectiveBuyTaxBps === 150 && entry.effectiveSellTaxBps === 250,
        `on the curve the report is clean, its curve part is the pool's (${entry.curve && entry.curve.raised} lamports raised), and the probes read the coin's own rates: ${entry.effectiveBuyTaxBps} bps on a buy, ${entry.effectiveSellTaxBps} bps on a sell`);
    } else check(!("curve" in entry), "a seeded pool's report has no curve part");
    check(!!entry.burn && entry.burn.keeper.calls === 2 && entry.burn.keeper.bought === 1 && entry.burn.keeper.spentLamports === Number(spend) && entry.burn.keeper.lastOutcome === "bought" && entry.burn.pot === s4.pot.toString() && entry.burn.capBps === coin.capBps && entry.burn.observedAtSlot === Number(s4.obs.slot),
      `the pool report counts the keeper's work on this pool: ${JSON.stringify(entry.burn)}`);
    say("  what the pool report says about the burn:");
    for (const n of entry.notes.filter((x) => /wait in the|Anyone may run that buy/.test(x))) say(`    note: ${n}`);
    const totals = r3.run.lines.find((l) => l.includes("burn totals:"));
    say(`  the watcher's running totals: ${totals ? totals.slice(totals.indexOf("burn totals:")) : "(no line)"}`);
  }
} catch (e) {
  failure = e;
  console.error(String(e && e.message ? e.message : e));
}

if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder left behind is harmless */ } }

step("result");
if (failure) { say(`  FAILED after ${checks} checks.`); process.exit(1); }
say(`  ${checks} checks passed.`);
const fees = paid.reduce((n, p) => n + p.fee, 0);
say(`  the keeper sent ${paid.length} calls and paid ${fees} lamports of fees (${sol(fees)} SOL). Nothing came back to it: a buyback or a burn pays its sender nothing.`);
for (const p of paid) say(`  ${p.coin} ${p.what.padEnd(7)} ${p.signature}  (${p.size} bytes, ${p.cu} compute units, fee ${p.fee} lamports)`);
