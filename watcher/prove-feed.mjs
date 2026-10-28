#!/usr/bin/env node
// Live proof of the trades feed and market.json, on the local validator only (it airdrops).
//
//   node watcher/prove-feed.mjs                     launches three coins, trades them, runs the watcher, compares
//   node watcher/prove-feed.mjs --rpc <url>         the watcher reads the chain through <url> (a counting proxy,
//                                                   for example web/review/rpc-count.mjs), the proof itself does not
//
// What it does, with fresh wallets that exist only in this run:
//   1. It launches two coins on the curve (A and B) and one seeded coin with a tax hook (C), and trades each once:
//      these are pools that exist before the feed starts, so the feed backfills them.
//   2. It starts the real watcher in its loop (node index.mjs --no-crank), with every file in a temporary folder
//      and a feed pass every 2 seconds, and waits for its first passes: market.json holds every pool of the
//      chain, and the three files of its pools hold their backfilled events.
//   3. A trader buys and sells A, B and C, and buys A past its graduation target: the SDK puts graduate into that
//      buy. The watcher's feed picks the transactions up.
//   4. It compares, to the unit: every event of trades/<pool>.json of the three pools with the chain's own events
//      (client.allEvents, the three kinds, newest first), the curve's two pinned events, and market.json with the
//      chain's pools (the pool account byte for byte, the reserves, the curve, the coin's name, symbol, uri,
//      decimals and supply, the price and the market cap worked out again from the chain).
//   5. It stops the watcher, trades twice more, starts it again on the same files: the feed goes on after its
//      cursor, no event doubled, none missing. And it reads both routes over HTTP: CORS open, a short cache.
//
// It never prints a secret. The coins are throwaway: nothing is cleaned up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, NATIVE_MINT, NO_HOOK, PROGRAMS, CURVE_GRADUATED, decodePool, curveProgress } from "../sdk/dist/index.js";
import { loadConfig, WATCHER_DIR, REPO_DIR } from "./lib/config.mjs";
import { ratioDecimal } from "./lib/market.mjs";

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const { cfg } = loadConfig([], process.env);
if (cfg.cluster !== "localnet" || !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(cfg.rpcUrl)) {
  console.error(`this proof airdrops, so it runs on the local validator only (cluster ${cfg.cluster}, rpc ${cfg.rpcUrl})`);
  process.exit(2);
}
const watcherRpc = argOf("--rpc") ?? cfg.rpcUrl;
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(watcherRpc)) { console.error("--rpc must be an address on this machine"); process.exit(2); }
const conn = new Connection(cfg.rpcUrl, "confirmed");
const altFile = path.join(REPO_DIR, "web", "deployments", "localnet-alt.json");
const lookupTable = fs.existsSync(altFile) ? new PublicKey(JSON.parse(fs.readFileSync(altFile, "utf8")).lookupTable) : undefined;
const client = new HookpoolClient(conn, lookupTable ? { lookupTable } : {});
const platform = await client.platform();
if (!platform) { console.error("Programmable is not set up on this validator: run `node scripts/init-platform.mjs localnet` first"); process.exit(2); }
if (!platform.curveEnabled) { console.error("curve launches are off on this platform"); process.exit(2); }

const say = (s = "") => console.log(s);
const step = (s) => console.log(`\n== ${s}`);
let checks = 0;
const check = (cond, msg) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); checks += 1; console.log(`  check  ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));
const KINDS = new Set(["Swapped", "CurveOpened", "Graduated"]);

async function fund(pubkey, lamports) {
  const sig = await conn.requestAirdrop(pubkey, Number(lamports));
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}
async function send(ixs, signers, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
      tx.sign(signers);
      const signature = await conn.sendTransaction(tx, { skipPreflight: false });
      const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)}`);
      say(`  sent   ${label}: ${signature}`);
      return signature;
    } catch (e) {
      // a program upgraded in place by another job refuses a transaction in that slot once: try again
      if (attempt >= 2 || !/not deployed|ProgramAccountNotFound|blockhash/i.test(String(e && e.message))) throw e;
      await sleep(1000);
    }
  }
}
async function launch(dev, symbol, o) {
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({ dev: dev.publicKey, mint, name: `Feed Proof ${symbol}`, symbol, uri: `https://example.com/meta/${symbol.toLowerCase()}.json`, decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n, quoteMint: NATIVE_MINT, lpFeeBps: 100, devBuyQuote: 0n, minDevBuyOut: 0n, ...o });
  await send(plan.createTx, [dev, mint], `launch ${symbol}: the coin`);
  await send(plan.launchTx, [dev], `launch ${symbol}: the pool`);
  return plan.pool;
}
async function trade(trader, poolKey, side, amount, label, opts = {}) {
  const pool = await client.pool(poolKey);
  const hook = pool.hasHook ? await client.hookRef(pool, trader.publicKey) : NO_HOOK;
  const direction = side === "buy" ? DIRECTION.BUY : DIRECTION.SELL;
  const q = await client.quoteLocal(pool, platform, direction, amount, pool.hasHook ? await client.hookInfo(pool) : null);
  const ixs = await client.swapInstructions(trader.publicKey, pool, hook, direction, amount, (q.amountOut * 98n) / 100n, opts);
  return send(ixs, [trader], label);
}
const balanceOf = async (owner, poolKey) => { const p = await client.pool(poolKey); return client.tokenBalance(owner, p.baseMint, p.baseTokenProgram); };

// ---- the watcher -------------------------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => { let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }); } catch (e) { reject(e); } }); }).on("error", reject);
  });
}
let child = null;
async function startWatcher(tmp, port) {
  const env = {
    ...process.env, RPC_URL: watcherRpc, CLUSTER: "localnet", PORT: String(port), FEED_INTERVAL_SECONDS: "2",
    STATE_FILE: path.join(tmp, "state.json"), STATUS_FILE: path.join(tmp, "pools.json"), PROBE_KEYPAIR: path.join(tmp, "probe.json"),
    MARKET_FILE: path.join(tmp, "market.json"), TRADES_DIR: path.join(tmp, "trades"), FEED_STATE_FILE: path.join(tmp, "feed.json"), MARKET_CACHE_FILE: path.join(tmp, "market-cache.json"),
  };
  const log = fs.openSync(path.join(tmp, "watcher.log"), "a");
  child = spawn(process.execPath, ["index.mjs", "--no-crank", "-v"], { cwd: WATCHER_DIR, env, stdio: ["ignore", log, log] });
  say(`  the watcher runs as process ${child.pid}, http on ${port}, every file in ${tmp}`);
  for (let i = 0; i < 100; i++) {
    try { const h = await getJson(port, "/health"); if (h.body.lastFeedAt) return; } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error("the watcher did not finish a feed pass in 30 s (see watcher.log in the temporary folder)");
}
async function stopWatcher() {
  if (!child) return;
  const c = child; child = null;
  const gone = new Promise((r) => c.once("exit", r));
  c.kill("SIGTERM");
  await Promise.race([gone, sleep(10_000)]);
}
/// Wait until the feed is complete up to `slot` and market.json is confirmed the chain's up to it.
async function caughtUp(port, slot) {
  for (let i = 0; i < 150; i++) {
    const h = (await getJson(port, "/health")).body;
    const m = await getJson(port, "/market.json").catch(() => null);
    if (h.feedSlot >= slot && m && m.status === 200 && m.body.checkedSlot >= slot) return h;
    await sleep(400);
  }
  throw new Error(`the feed did not reach slot ${slot} in a minute`);
}

// ---- what the chain says ---------------------------------------------------------------------------------

/// The chain's events of a pool as the contract writes them: newest first, the three kinds, bigints as strings.
async function chainEvents(poolKey) {
  const all = await client.allEvents(poolKey, 1000);
  return all.filter((e) => KINDS.has(e.kind) && e.pool.equals(poolKey)).map((e) => {
    const out = { kind: e.kind, signature: e.signature, blockTime: e.blockTime };
    for (const [k, v] of Object.entries(e)) if (!["kind", "signature", "blockTime"].includes(k)) out[k] = typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v;
    return out;
  });
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

async function compareTrades(port, tmp, poolKey, label) {
  const want = await chainEvents(poolKey);
  const file = JSON.parse(fs.readFileSync(path.join(tmp, "trades", `${poolKey.toBase58()}.json`), "utf8"));
  check(JSON.stringify(file.events) === JSON.stringify(want), `${label}: trades/<pool>.json holds the chain's ${want.length} events, in the chain's order, every field equal`);
  const opened = want.find((e) => e.kind === "CurveOpened") ?? null;
  const graduated = want.find((e) => e.kind === "Graduated") ?? null;
  check(JSON.stringify(file.curve) === JSON.stringify({ opened, graduated }), `${label}: the pinned curve events are the chain's (${opened ? "opened" : "no opening"}, ${graduated ? "graduated" : "not graduated"})`);
  const served = await getJson(port, `/trades/${poolKey.toBase58()}.json`);
  check(served.status === 200 && served.headers["access-control-allow-origin"] === "*" && served.headers["cache-control"] === "public, max-age=5" && JSON.stringify(served.body.events) === JSON.stringify(file.events),
    `${label}: GET /trades/<pool>.json serves the same file, CORS open, cached five seconds`);
  return want;
}

async function compareMarket(port, mine) {
  const m = (await getJson(port, "/market.json")).body;
  const chainPools = await client.allPools();
  const byAddr = new Map(m.pools.map((p) => [p.address, p]));
  const newer = chainPools.filter((p) => !byAddr.has(p.address.toBase58()) && p.createdSlot > BigInt(m.slot));
  check(chainPools.length - newer.length === m.pools.length && chainPools.every((p) => byAddr.has(p.address.toBase58()) || newer.includes(p)), `market.json holds every pool of the chain: ${m.pools.length}${newer.length ? ` (and ${newer.length} created since its read)` : ""}`);
  // every pool: the account as read decodes to the chain's pool, unless a transaction changed it after the market
  // was confirmed (other jobs share this chain). Ours change only by this proof: they must match exactly.
  const asText = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  let same = 0; let moved = 0;
  for (const p of chainPools) {
    const e = byAddr.get(p.address.toBase58());
    if (!e) continue;
    const d = decodePool(p.address, new Uint8Array(Buffer.from(e.account, "base64")));
    if (asText(d) === asText(p)) same += 1;
    else if (mine.some(([, k]) => k.equals(p.address))) throw new Error(`CHECK FAILED: pool ${p.address.toBase58()} of this proof differs from market.json`);
    else moved += 1;
  }
  check(same + moved === m.pools.length && moved * 2 < m.pools.length, `every pool's account in market.json is the chain's byte for byte (${same}), or changed after the market's last check (${moved}, by other jobs on this chain)`);
  for (const [label, key] of mine) {
    const p = chainPools.find((x) => x.address.equals(key));
    const e = byAddr.get(key.toBase58());
    const created = (await client.allEvents(key, 1000)).find((x) => x.kind === "PoolCreated" && x.pool.equals(key));
    check(!!created && e.createdTime === created.blockTime && e.createdSlot === p.createdSlot.toString(), `${label}: created at slot ${e.createdSlot}, Unix time ${e.createdTime}, the block time of its PoolCreated event`);
    const [md, mint] = await Promise.all([client.metadata(p.baseMint), client.mint(p.baseMint)]);
    check(e.reserveBase === p.reserveBase.toString() && e.reserveQuote === p.reserveQuote.toString() && e.virtualQuote === p.virtualQuote.toString() && e.swapCount === p.swapCount.toString() && e.volumeQuoteTotal === p.volumeQuoteTotal.toString(),
      `${label}: reserves, virtual SOL, swap count and volume to the unit (${e.reserveQuote} lamports real, ${e.swapCount} swaps)`);
    check(e.coin.name === md.name && e.coin.symbol === md.symbol && e.coin.uri === md.uri && e.coin.decimals === mint.decimals && e.coin.supply === mint.supply.toString() && e.coin.tokenProgram === mint.tokenProgram.toBase58(),
      `${label}: the coin as the chain holds it: ${e.coin.symbol}, ${e.coin.decimals} decimals, supply ${e.coin.supply}`);
    const c = curveProgress(p, mint.supply);
    const priceWant = p.reserveBase === 0n ? "0" : ratioDecimal((p.reserveQuote + p.virtualQuote) * 10n ** BigInt(mint.decimals), p.reserveBase * 10n ** 9n);
    check(e.marketCap === c.marketCapQuote.toString() && e.price === priceWant, `${label}: market cap ${e.marketCap} lamports and price ${e.price} SOL, worked out again from the chain`);
    const curveWant = c.state === "none" ? null : { state: c.state, virtualQuote: p.virtualQuote.toString(), raised: c.raised.toString(), target: c.target.toString(), raisedBps: c.raisedBps, soldBps: c.soldBps, graduationFeeBps: p.graduationFeeBps, graduates: p.curveState === 1 && p.graduationTarget > 0n && p.reserveQuote >= p.graduationTarget };
    check(JSON.stringify(e.curve) === JSON.stringify(curveWant), `${label}: the curve as the chain holds it: ${JSON.stringify(e.curve)}`);
  }
  return m;
}

// ---- the scene -------------------------------------------------------------------------------------------

step(`trades feed and market.json proof on ${cfg.rpcUrl}${watcherRpc !== cfg.rpcUrl ? `, the watcher through ${watcherRpc}` : ""}`);
let failure = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-feed-proof-"));
const port = await freePort();
try {
  step("1. three coins that exist before the feed starts, one trade each");
  const dev = Keypair.generate(); const trader = Keypair.generate();
  await fund(dev.publicKey, sol(5));
  await fund(trader.publicKey, sol(120));
  const A = await launch(dev, "FPA", { curve: true, template: "none" });
  const B = await launch(dev, "FPB", { curve: true, template: "none" });
  const C = await launch(dev, "FPC", { quoteAmount: sol(2), template: "tax", tax: { buyBps: 200, sellBps: 300, maxBps: 1000 } });
  const mine = [["A (curve)", A], ["B (curve)", B], ["C (seeded, tax)", C]];
  for (const [label, key] of mine) await trade(trader, key, "buy", sol(0.5), `buy ${label} for 0.5 SOL`);

  step("2. the watcher starts: market.json and the backfill of the three pools");
  await startWatcher(tmp, port);
  const slot0 = await conn.getSlot("confirmed");
  const h0 = await caughtUp(port, slot0);
  check(h0.feedEnabled && Number.isFinite(h0.feedSlot) && h0.feedLagSlots !== null, `/health carries the feed: slot ${h0.feedSlot}, ${h0.feedLagSlots} slots behind the newest slot the watcher read`);
  for (let i = 0; i < 50 && !mine.every(([, k]) => fs.existsSync(path.join(tmp, "trades", `${k.toBase58()}.json`))); i++) await sleep(400);
  for (const [label, key] of mine) {
    const f = JSON.parse(fs.readFileSync(path.join(tmp, "trades", `${key.toBase58()}.json`), "utf8"));
    check(f.backfill.transactions >= 2 && f.backfill.reachedCreation === true, `${label}: backfilled once from ${f.backfill.transactions} transactions, back to its creation`);
    await compareTrades(port, tmp, key, label);
  }
  const m0 = await compareMarket(port, mine);
  check(m0.pools.find((p) => p.address === C.toBase58()).template === "tax" && m0.pools.find((p) => p.address === A.toBase58()).curveState === "open", "the templates and curve states are the chain's");

  step("3. trading while the watcher runs, a graduation among it");
  await trade(trader, B, "buy", sol(1.5), "buy B for 1.5 SOL");
  await trade(trader, C, "buy", sol(0.7), "buy C for 0.7 SOL");
  const half = (await balanceOf(trader.publicKey, B)) / 2n;
  await trade(trader, B, "sell", half, "sell half of B");
  await trade(trader, C, "sell", (await balanceOf(trader.publicKey, C)) / 3n, "sell a third of C");
  const pA = await client.pool(A);
  const past = pA.graduationTarget - pA.reserveQuote + sol(2);
  await trade(trader, A, "buy", past, `buy A past its graduation target, for ${Number(past) / LAMPORTS_PER_SOL} SOL (the SDK appends graduate)`);
  check((await client.pool(A)).curveState === CURVE_GRADUATED, "A graduated inside that buy");
  await trade(trader, A, "sell", (await balanceOf(trader.publicKey, A)) / 10n, "sell a tenth of A on the graduated pool");
  const slot1 = await conn.getSlot("confirmed");
  await caughtUp(port, slot1);
  await sleep(500);
  const evA = await compareTrades(port, tmp, A, "A");
  check(evA.some((e) => e.kind === "Graduated") && evA.filter((e) => e.kind === "Swapped").length === 3, "A: the graduation and its three swaps are in the file");
  await compareTrades(port, tmp, B, "B");
  await compareTrades(port, tmp, C, "C");
  await compareMarket(port, mine);

  step("4. a restart: the watcher stops, two trades land, the watcher goes on from its cursor");
  await stopWatcher();
  const feedState = JSON.parse(fs.readFileSync(path.join(tmp, "feed.json"), "utf8"));
  check(typeof feedState.cursor === "string" && feedState.transactions > 0, `the feed kept its cursor and counted ${feedState.transactions} transactions`);
  await trade(trader, B, "buy", sol(0.3), "buy B for 0.3 SOL while the watcher is down");
  await trade(trader, C, "buy", sol(0.3), "buy C for 0.3 SOL while the watcher is down");
  await startWatcher(tmp, port);
  await caughtUp(port, await conn.getSlot("confirmed"));
  await sleep(500);
  const evB = await compareTrades(port, tmp, B, "B after the restart");
  check(new Set(evB.map((e) => e.signature + e.kind)).size === evB.length, "B after the restart: no event twice");
  await compareTrades(port, tmp, C, "C after the restart");
  await compareMarket(port, mine);
  const mh = await getJson(port, "/market.json");
  check(mh.headers["access-control-allow-origin"] === "*" && mh.headers["cache-control"] === "public, max-age=5", "GET /market.json: CORS open, cached five seconds");
  const log = fs.readFileSync(path.join(tmp, "watcher.log"), "utf8");
  const backfills = log.split("\n").filter((l) => / feed: pool \S+ backfilled/.test(l) && mine.some(([, k]) => l.includes(k.toBase58())));
  check(backfills.length === 3, `each of the three pools was backfilled exactly once over both runs (${backfills.length} backfill lines)`);
} catch (e) {
  failure = e;
} finally {
  await stopWatcher();
}
if (failure) {
  console.error(`\n${failure.message}`);
  console.error(`the watcher's log and files stay in ${tmp}`);
  process.exit(1);
}
say(`\n${checks} checks passed. The watcher's log and files are in ${tmp}`);
