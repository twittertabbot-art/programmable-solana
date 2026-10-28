#!/usr/bin/env node
// Live proof of the mint crank (collectible coins, one approval), on the local validator only (it airdrops).
//
//   node watcher/prove-mint.mjs                          a plain and a pegged collectible pool of the validator
//   node watcher/prove-mint.mjs --pool <a> --pool <b>    those pools
//
// A buy that earns pieces pays their rent as a deposit in the buy transaction itself (the SDK's
// swapInstructions with mintDeposit). The watcher's keeper then mints the pieces into the buyer's wallet with the
// permissionless mint_for, paid back from that deposit. The buyer signs ONE transaction. This script shows it with
// fresh wallets that exist only in this run, against the real watcher running in its loop:
//   1. It starts the watcher (node index.mjs) with its state, its status file and a new keeper key in a temporary
//      folder, its HTTP on a free port, the trades feed off and the pool pass once an hour. The reveal crank and
//      the mint crank run; the settle, upkeep, burn and graduate cranks are off. It waits for /health.
//   2. On each pool, BUYER buys coins for three pieces with the deposit in the same transaction: one signature.
//      The script then only watches. Within 20 seconds the three pieces are in BUYER's list and Metaplex shows
//      BUYER as their owner. They were minted by the keeper (a mint_for whose DepositUsed event names the keeper),
//      a few slots after the buy. The deposit paid what the mint cost, and the keeper ended that transaction richer
//      by 10,000 lamports less its fee.
//   3. RACER buys with a deposit and races the keeper: it mints itself the moment its block is in, from a fresh
//      read of its ticket, after a simulation (what the coin page does). Whoever wins, each piece is minted once,
//      no keeper transaction fails on chain, and the deposit paid for it.
//   4. SHORT buys with a deposit of 1 lamport, too small for a mint. The keeper sends nothing for it. SHORT mints
//      its pieces itself; its deposit pays first, the wallet the rest.
//   5. The watcher is stopped. LATE buys with a deposit. The watcher starts again: its first read of every ticket
//      finds LATE and mints its pieces.
//   6. /health counts the mints, the pieces, the deposits too small, no failed mint, and a keeper never out of
//      pocket.
//   7. Every wallet sells its coins back and takes what is left of its deposit (withdraw_deposit). The watcher is
//      stopped by its own process id.
// Step 7 also runs when a check fails, so a failed proof does not leave coins stranded.
//
// It never prints a secret: the keeper key is created by the watcher in the temporary folder and only its public
// address is read. Other people may trade on the pools while it runs: the checks only look at its own wallets and
// at the keeper's own transactions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, PROGRAMS, collectible as col } from "../sdk/dist/index.js";
import { loadConfig, WATCHER_DIR, REPO_DIR } from "./lib/config.mjs";
import { depositUsedFromLogs } from "./lib/mint.mjs";

const args = process.argv.slice(2);
const poolArgs = args.flatMap((a, i) => (a === "--pool" && args[i + 1] ? [args[i + 1]] : []));

const { cfg } = loadConfig([], process.env);
if (cfg.cluster !== "localnet" || !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(cfg.rpcUrl)) {
  console.error(`this proof airdrops, so it runs on the local validator only (cluster ${cfg.cluster}, rpc ${cfg.rpcUrl})`);
  process.exit(2);
}
const conn = new Connection(cfg.rpcUrl, "confirmed");
const altFile = path.join(REPO_DIR, "web", "deployments", "localnet-alt.json");
const lookupTable = fs.existsSync(altFile) ? new PublicKey(JSON.parse(fs.readFileSync(altFile, "utf8")).lookupTable) : undefined;
const client = new HookpoolClient(conn, lookupTable ? { lookupTable } : {});
const { KEEPER_FEE } = col;
// the chain's rent, read once: never a constant, the local validator's 6,960 a byte is not mainnet's 5,080
const RENT = await col.rentFrom(conn);

const say = (s = "") => console.log(s);
const step = (s) => console.log(`\n== ${s}`);
let checks = 0;
const check = (cond, msg) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); checks += 1; console.log(`  check  ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9);
const short = (e) => String(e && e.message ? e.message : e).replace(/\s+/g, " ").slice(0, 240);

// ---- the pools -----------------------------------------------------------------------------------------

/// The seeded plain, the pegged and the curve (plain coin, on the curve: the live configuration) collectible pool
/// with the most coins in reserve: there the proof moves the price least.
async function findPools() {
  if (poolArgs.length) return poolArgs.map((a) => new PublicKey(a));
  const best = { plain: null, pegged: null, curve: null };
  for (const p of await client.allPools()) {
    if (!p.hasHook || !p.hookProgram.equals(PROGRAMS.hook_collectible)) continue;
    let c = null;
    try { c = await col.fetchCollectionConfig(conn, p.address); } catch { c = null; }
    if (!c || c.maxPerBuy < 3 || c.live + c.reservedPending + 20 > c.maxSupply) continue;
    const kind = c.pegged ? "pegged" : p.virtualQuote > 0n ? "curve" : "plain";
    if (!best[kind] || p.reserveQuote > best[kind].reserveQuote) best[kind] = p;
  }
  return [best.plain, best.pegged, best.curve].filter(Boolean).map((p) => p.address);
}

// ---- the watcher ---------------------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prove-mint-"));
let watcher = null; let port = null; const watcherLines = [];
async function startWatcher() {
  port = port ?? (await freePort());
  const env = {
    ...process.env, RPC_URL: cfg.rpcUrl, CLUSTER: "localnet", PORT: String(port), FEED: "off", INTERVAL_SECONDS: "3600",
    STATE_FILE: path.join(tmp, "state.json"), STATUS_FILE: path.join(tmp, "pools.json"), PROBE_KEYPAIR: path.join(tmp, "keeper.json"),
    MINT_CRANK: "on", MINT_INTERVAL_SECONDS: "2",
  };
  const child = spawn(process.execPath, ["index.mjs", "--no-settle", "--no-upkeep", "--no-burn", "--no-graduate"], { cwd: WATCHER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  const take = (buf) => { for (const l of String(buf).split("\n")) if (l.trim()) watcherLines.push(l); };
  child.stdout.on("data", take); child.stderr.on("data", take);
  watcher = child;
  say(`  started the watcher as process ${child.pid}, /health on port ${port}`);
  for (let i = 0; i < 120; i++) {
    const h = await getJson(`http://127.0.0.1:${port}/health`);
    if (h && h.mintCrankEnabled && h.lastMintAt) return h;
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  throw new Error(`the watcher did not answer /health with a mint pass: ${watcherLines.slice(-5).join(" | ")}`);
}
async function stopWatcher() {
  if (!watcher || watcher.exitCode !== null) return;
  const pid = watcher.pid;
  const done = new Promise((r) => watcher.once("exit", r));
  watcher.kill();
  await Promise.race([done, sleep(5000)]);
  say(`  stopped the watcher (process ${pid})`);
  watcher = null;
}
const keeperKey = () => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(tmp, "keeper.json"), "utf8")))).publicKey;

// ---- trading -------------------------------------------------------------------------------------------

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
const wallets = [];
/// What a buy of coins for `units` pieces costs on a pool right now, about: the pool prices with its real and its
/// virtual SOL together (a coin on the curve), plus 4% for the fees and the slippage.
async function buyCostFor(poolKey, units) {
  const c = await col.fetchCollectionConfig(conn, poolKey);
  const pool = await client.pool(poolKey);
  const want = c.unit * BigInt(units) + c.unit / 20n;
  return ((pool.reserveQuote + pool.virtualQuote) * want) / (pool.reserveBase - want) * 104n / 100n;
}
/// A fresh wallet of this run, funded with `lamports` (3 SOL unless the buy it is for costs more).
async function wallet(name, lamports = 3 * LAMPORTS_PER_SOL) {
  const kp = Keypair.generate();
  await fund(kp.publicKey, Math.max(3 * LAMPORTS_PER_SOL, Number(lamports)));
  wallets.push({ name, kp });
  say(`  ${name} is ${kp.publicKey.toBase58()}`);
  return kp;
}
/// Buy coins for `units` pieces, with the deposit for them in the same transaction (or `deposit` lamports instead,
/// to make it too small). One signature. Returns the buy's signature and slot and the ticket right after it.
async function buyWithDeposit(poolKey, kp, units, who, { deposit = null } = {}) {
  const c = await col.fetchCollectionConfig(conn, poolKey);
  for (let attempt = 1; ; attempt++) {
    const pool = await client.pool(poolKey);
    const want = c.unit * BigInt(units) + c.unit / 20n;
    // the pool prices with its virtual SOL too (a coin on the curve): size the buy on the effective quote
    let amountIn = ((pool.reserveQuote + pool.virtualQuote) * want) / (pool.reserveBase - want) * 104n / 100n;
    for (let i = 0; i < 20 && (await client.quoteOnChain(kp.publicKey, pool, DIRECTION.BUY, amountIn)) < want; i++) amountIn = (amountIn * 103n) / 100n;
    let ixs = await client.swapInstructions(kp.publicKey, pool, await client.hookRef(pool, kp.publicKey), DIRECTION.BUY, amountIn, want, deposit === null ? { mintDeposit: { amountOut: want } } : {});
    if (deposit !== null) ixs = [...ixs.slice(0, -1), col.depositTransfer(kp.publicKey, poolKey, deposit), ...ixs.slice(-1)];
    try {
      const signature = await send(ixs, [kp], `${who} buys coins for ${units} pieces for ${sol(amountIn)} SOL, ${deposit === null ? "with the deposit for them" : `with a deposit of ${deposit} lamport`} (one signature)`);
      const got = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      const info = await conn.getAccountInfo(col.collectiblePda.ticket(poolKey, kp.publicKey));
      return { signature, slot: BigInt(got.slot), sigs: got.transaction.signatures.length, ticket: col.decodeTicket(new Uint8Array(info.data)), info, cfg: await col.fetchCollectionConfig(conn, poolKey) };
    } catch (e) {
      if (attempt >= 3) throw e;
      say(`  the buy did not go through (${short(e)}), quoting again`);
    }
  }
}
/// The Metaplex owner of each asset (null when it does not exist).
async function ownersOf(keys) {
  const infos = keys.length ? await conn.getMultipleAccountsInfo(keys) : [];
  return infos.map((info) => (info && info.data.length > 33 && info.data[0] === 1 ? new PublicKey(info.data.subarray(1, 33)).toBase58() : null));
}
/// Wait until the wallet's ticket has nothing waiting, `ms` at most. Answers the ticket and the seconds it took.
async function waitMinted(poolKey, user, ms) {
  const t0 = Date.now();
  for (;;) {
    const t = await col.fetchTicket(conn, poolKey, user);
    if (t && t.pending === 0) return { ticket: t, seconds: (Date.now() - t0) / 1000 };
    if (Date.now() - t0 > ms) return { ticket: t, seconds: null };
    await sleep(250);
  }
}
/// The keeper's mint_for transactions that minted for `user`, with what each did to the keeper's balance.
async function keeperMintsFor(keeper, user) {
  const out = [];
  for (const s of await conn.getSignaturesForAddress(keeper, { limit: 100 }, "confirmed")) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx || !tx.meta) continue;
    const used = depositUsedFromLogs(tx.meta.logMessages).filter((u) => u.user.equals(user));
    if (!used.length) continue;
    out.push({ signature: s.signature, slot: BigInt(tx.slot), err: tx.meta.err, used: used[0], fee: tx.meta.fee, delta: tx.meta.postBalances[0] - tx.meta.preBalances[0], payer: tx.transaction.message.staticAccountKeys[0].toBase58() });
  }
  return out;
}
/// Everything the keeper sent in this run that failed on chain: the error's name, the fee, and the wallets named.
async function keeperFailures(keeper) {
  const out = [];
  for (const s of (await conn.getSignaturesForAddress(keeper, { limit: 200 }, "confirmed")).filter((x) => x.err)) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const logs = (tx && tx.meta && tx.meta.logMessages) || [];
    const m = /Error Code: (\w+)\./.exec(logs.join("\n"));
    const keys = tx ? tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }) : null;
    const named = keys ? [...keys.staticAccountKeys, ...(keys.accountKeysFromLookups ? [...keys.accountKeysFromLookups.writable, ...keys.accountKeysFromLookups.readonly] : [])].map((k) => k.toBase58()) : [];
    out.push({ signature: s.signature, error: m ? m[1] : JSON.stringify(s.err), mintFor: logs.some((l) => /Instruction: MintFor/.test(l)), fee: tx ? tx.meta.fee : null, named });
  }
  return out;
}
/// The race step 3 runs: a keeper mint that lost it fails on chain, costs the keeper its fee and nothing else.
const lostRace = (f, wallet) => f.mintFor && (f.error === "NothingToMint" || f.error === "WrongAsset") && f.fee === 5000 && f.named.includes(wallet.toBase58());
let racerKey = null;

/// Step 2: one buy with a deposit, minted by the keeper.
async function proveOne(poolKey, label) {
  const c0 = await col.fetchCollectionConfig(conn, poolKey);
  step(`2. ${label}: one buy with a deposit, the NFTs minted by the keeper (pool ${poolKey.toBase58()}, ${c0.pegged ? "pegged coin" : "plain coin"}${(await client.pool(poolKey)).virtualQuote > 0n ? ", on the curve" : ""})`);
  // funded for the buy and its deposit at this pool's price (a coin on the curve near its target costs more)
  const kp = await wallet(`BUYER on ${label}`, Number(await buyCostFor(poolKey, 3)) * 2 + LAMPORTS_PER_SOL);
  const b = await buyWithDeposit(poolKey, kp, 3, "BUYER");
  check(b.sigs === 1, "the buy carries one signature, the buyer's");
  const pending = b.ticket.pending;
  const deposit0 = col.depositOf(b.info.lamports, b.info.data.length, RENT);
  const need = col.mintDepositFor(RENT, b.cfg, pending);
  check(pending >= 1 && deposit0 >= need, `the buy earned ${pending} pieces and left a deposit of ${deposit0} lamports in the ticket, what ${pending} pieces need (${need})`);
  const cost = col.mintForCost(RENT, b.cfg, b.info.data.length, b.ticket.owned.length, Math.min(4, pending));
  const w = await waitMinted(poolKey, kp.publicKey, 20_000);
  check(w.seconds !== null, `the pieces left the waiting list ${w.seconds} s after the buy confirmed, with no other signature from the buyer`);
  check(w.ticket.owned.length === pending, `the buyer's list holds ${w.ticket.owned.length} pieces`);
  const owners = await ownersOf(w.ticket.owned);
  check(owners.every((o) => o === kp.publicKey.toBase58()), "Metaplex shows the buyer as the owner of every one");
  const keeper = keeperKey();
  const mints = await keeperMintsFor(keeper, kp.publicKey);
  check(mints.length === 1 && !mints[0].err && mints[0].payer === keeper.toBase58() && mints[0].used.by.equals(keeper), `one mint_for by the keeper ${keeper.toBase58()}: ${mints.map((m) => m.signature).join(", ")}`);
  const m = mints[0];
  check(m.used.pieces === pending, `its DepositUsed event says ${m.used.pieces} pieces`);
  say(`  minted ${m.slot - b.slot} slots after the buy (buy at slot ${b.slot}, mint at slot ${m.slot})`);
  check(m.slot - b.slot <= 40n, "minted within 40 slots of the buy");
  const deposit1 = await col.ticketDeposit(conn, poolKey, kp.publicKey);
  check(deposit0 - deposit1 === cost || (await col.fetchCollectionConfig(conn, poolKey)).minted !== b.cfg.minted + pending, `the deposit paid ${deposit0 - deposit1} lamports, the cost of the mint (${cost}); ${deposit1} lamports are left`);
  check(m.used.left === deposit1, "the event's `left` is what the ticket holds above its rent");
  check(m.delta === Number(KEEPER_FEE) - m.fee && m.delta >= 0, `the keeper's balance moved by ${m.delta} lamports in that transaction: KEEPER_FEE ${KEEPER_FEE} less its fee ${m.fee}`);
  return { kp, mints: 1, pieces: pending };
}

const cleanup = [];
const result = { pools: [], mints: 0, pieces: 0 };
let failed = null;
try {
  const pools = await findPools();
  if (!pools.length) { console.error("no collectible pool with room for three pieces on this validator: run `node scripts/e2e-collectible.mjs localnet` first, or pass --pool"); process.exit(2); }
  step("1. the watcher, in its loop, with only the reveal and the mint crank");
  await startWatcher();
  const keeper = keeperKey();
  say(`  keeper ${keeper.toBase58()} (its key lives in the temporary folder ${tmp})`);

  const labels = [];
  for (const poolKey of pools) {
    const c = await col.fetchCollectionConfig(conn, poolKey);
    const onCurve = (await client.pool(poolKey)).virtualQuote > 0n;
    const label = c.pegged ? "the pegged coin" : onCurve ? "the plain coin on the curve" : "the plain coin";
    labels.push([poolKey, label]);
    const r = await proveOne(poolKey, label);
    cleanup.push({ poolKey, kp: r.kp });
    result.mints += r.mints; result.pieces += r.pieces;
    result.pools.push(poolKey.toBase58());
  }

  const [poolKey, label] = labels[0];
  step(`3. RACER on ${label}: the wallet mints itself the moment its block is in, the keeper too`);
  {
    const kp = await wallet("RACER");
    const b = await buyWithDeposit(poolKey, kp, 2, "RACER");
    cleanup.push({ poolKey, kp });
    const target = b.ticket.batches.filter((x) => x.pieces > 0).reduce((mx, x) => (x.targetSlot > mx ? x.targetSlot : mx), 0n);
    for (;;) { if (BigInt(await conn.getSlot("confirmed")) > target) break; await sleep(100); }
    try {
      // what the coin page does: a fresh read of the ticket, a simulation, then the wallet
      const ixs = await client.collectibleMintInstructions(kp.publicKey, poolKey);
      if (ixs.length) {
        const { tx } = await client.buildTx(kp.publicKey, ixs);
        const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "processed" });
        if (!sim.value.err) await send(ixs, [kp], "RACER sends its own mint");
        else say(`  RACER's mint fails in a simulation (${JSON.stringify(sim.value.err)}): the keeper got there first, nothing is sent`);
      } else say("  RACER finds nothing waiting: the keeper got there first");
    } catch (e) { say(`  RACER's mint did not go through (${short(e)})`); }
    const w = await waitMinted(poolKey, kp.publicKey, 20_000);
    // who minted: the keeper's mint_for says so in its DepositUsed event; a wallet's own mint that came second
    // found nothing decided and did nothing
    const byKeeper = (await keeperMintsFor(keeper, kp.publicKey)).filter((x) => !x.err);
    const who = byKeeper.length ? "the keeper" : "the wallet";
    check(w.seconds !== null && w.ticket.owned.length === b.ticket.pending, `${who} minted the ${b.ticket.pending} pieces, each once: the list holds ${w.ticket.owned.length}`);
    const owners = await ownersOf(w.ticket.owned);
    check(owners.every((o) => o === kp.publicKey.toBase58()), "every asset is RACER's");
    racerKey = kp.publicKey;
    await sleep(3000);
    const fails = await keeperFailures(keeper);
    const race = fails.filter((f) => lostRace(f, kp.publicKey));
    if (race.length) say(`  the keeper lost the race: its mint_for ${race[0].signature} landed after RACER's own mint and failed (${race[0].error}), which cost it the ${race[0].fee} lamports of one signature and nothing else`);
    else say(who === "the keeper" ? "  the keeper won the race: RACER's own mint came second, found nothing decided and did nothing" : "  the wallet won the race: the keeper saw its mint in its simulation and sent nothing");
    check(fails.length === race.length && race.length <= 1, `no transaction of the keeper failed on chain in this run, apart from at most one mint_for that lost this race (${fails.map((f) => f.error).join(", ") || "none"})`);
    if (who === "the keeper") { result.mints += 1; result.pieces += b.ticket.pending; }
  }

  step(`4. SHORT on ${label}: a deposit of 1 lamport, too small for a mint`);
  {
    const kp = await wallet("SHORT");
    const healthBefore = await getJson(`http://127.0.0.1:${port}/health`);
    const b = await buyWithDeposit(poolKey, kp, 1, "SHORT", { deposit: 1n });
    cleanup.push({ poolKey, kp });
    check(col.depositOf(b.info.lamports, b.info.data.length, RENT) === 1n, "the ticket holds a deposit of 1 lamport");
    const target = b.ticket.batches.filter((x) => x.pieces > 0).reduce((mx, x) => (x.targetSlot > mx ? x.targetSlot : mx), 0n);
    for (;;) { if (BigInt(await conn.getSlot("confirmed")) > target + 10n) break; await sleep(300); }
    await sleep(4000);
    const t = await col.fetchTicket(conn, poolKey, kp.publicKey);
    check(t.pending === b.ticket.pending && t.owned.length === 0, "four seconds after its block the pieces still wait: the keeper sent nothing");
    check((await keeperMintsFor(keeper, kp.publicKey)).length === 0, "no mint_for of the keeper names SHORT");
    const h = await getJson(`http://127.0.0.1:${port}/health`);
    check(h.mintDepositShort > healthBefore.mintDepositShort, `/health counts a deposit too small (${healthBefore.mintDepositShort} before, ${h.mintDepositShort} now)`);
    const before = await conn.getBalance(kp.publicKey);
    await send(await client.collectibleMintInstructions(kp.publicKey, poolKey), [kp], "SHORT mints its pieces itself");
    const after = await col.fetchTicket(conn, poolKey, kp.publicKey);
    check(after.pending === 0 && after.owned.length === b.ticket.pending, "SHORT holds its pieces");
    check((await col.ticketDeposit(conn, poolKey, kp.publicKey)) === 0n, "its 1 lamport of deposit was used first");
    say(`  SHORT paid ${before - (await conn.getBalance(kp.publicKey))} lamports for its own mint`);
  }

  step(`5. LATE on ${label}: a buy while the watcher is down; the watcher's first read finds it`);
  {
    await stopWatcher();
    const kp = await wallet("LATE");
    const b = await buyWithDeposit(poolKey, kp, 1, "LATE");
    cleanup.push({ poolKey, kp });
    await sleep(2000);
    check((await col.fetchTicket(conn, poolKey, kp.publicKey)).pending === b.ticket.pending, "with no watcher the pieces wait");
    await startWatcher();
    const w = await waitMinted(poolKey, kp.publicKey, 30_000);
    check(w.seconds !== null && w.ticket.owned.length === b.ticket.pending, `the watcher minted LATE's pieces ${w.seconds} s after it started`);
    const mints = await keeperMintsFor(keeper, kp.publicKey);
    check(mints.length === 1 && !mints[0].err, "by one mint_for of the keeper");
    result.mints += 1; result.pieces += b.ticket.pending;
  }

  step("6. /health");
  {
    const h = await getJson(`http://127.0.0.1:${port}/health`);
    say(`  ${JSON.stringify(Object.fromEntries(Object.entries(h).filter(([k]) => /^mint|piecesMinted|lastMint/.test(k))))}`);
    check(h.mintCrankEnabled && !h.mintCrankStale, "the mint crank is on and not stale");
    const race = (await keeperFailures(keeper)).filter((f) => racerKey && lostRace(f, racerKey)).length;
    check(h.mintsFailed === race, `no mint failed${race ? ", apart from the one that lost the race of step 3" : ""} (${h.mintsFailed})`);
    check(h.mintNetLamports >= -5000 * race, `the keeper is not out of pocket over the mints this watcher sent: ${h.mintNetLamports} lamports${race ? " (a lost race costs 5000)" : ""}`);
    check(h.mintsSent >= 1 && h.piecesMintedForWallets >= 1, `${h.mintsSent} mints and ${h.piecesMintedForWallets} pieces counted since the restart (the state file is kept across it)`);
    const status = JSON.parse(fs.readFileSync(path.join(tmp, "pools.json"), "utf8"));
    check(!!status.mintCrank && status.mintCrank.enabled === true, `the status file carries the mint crank: ${JSON.stringify(status.mintCrank)}`);
    const keeperTxs = await conn.getSignaturesForAddress(keeper, { limit: 200 }, "confirmed");
    say(`  the keeper sent ${keeperTxs.length} transactions in this run, none failed: ${keeperTxs.every((s) => !s.err)}`);
  }
} catch (e) {
  failed = e;
  console.error(`\n${short(e)}`);
  const tail = watcherLines.filter((l) => /mint|error|warn/.test(l)).slice(-15);
  if (tail.length) console.error("the watcher's last lines about the mint crank:\n  " + tail.join("\n  "));
} finally {
  step("7. clean up: the coins go back to the pools, the deposits back to the wallets, the watcher stops");
  await stopWatcher();
  for (const { poolKey, kp } of cleanup) {
    try {
      const pool = await client.pool(poolKey);
      const amount = await client.tokenBalance(kp.publicKey, pool.baseMint, pool.baseTokenProgram);
      if (amount > 0n) await send(await client.swapInstructions(kp.publicKey, pool, await client.hookRef(pool, kp.publicKey), DIRECTION.SELL, amount, 0n), [kp], `sell back ${amount} raw coins`);
      const w = await client.collectibleWithdrawInstructions(kp.publicKey, poolKey);
      if (w.length) await send(w, [kp], `withdraw the deposit left (${await col.ticketDeposit(conn, poolKey, kp.publicKey)} lamports)`);
    } catch (e) { say(`  clean up of ${kp.publicKey.toBase58()} failed: ${short(e)}`); }
  }
  const lines = watcherLines.filter((l) => /\bmint\b|mint:/.test(l) && !/mint done: 0 new/.test(l));
  say(`\nthe watcher's lines about mints (${lines.length}):`);
  for (const l of lines.slice(-30)) say(`  ${l}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left for the system to clean */ }
}
if (failed) { console.log(`\nFAILED after ${checks} checks`); process.exit(1); }
console.log(`\nall ${checks} checks passed: ${result.mints} mints by the keeper, ${result.pieces} pieces minted into the buyers' wallets, on ${result.pools.length} pools`);
