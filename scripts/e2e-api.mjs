// The trade API end to end on a live cluster: GET /api/v1/quote and POST /api/v1/swap of
// web/serve.js, for every kind of pool that exists there. For each kind a throwaway wallet
// asks for a quote, asks for the transaction, signs it, sends it, and the script compares
// what the chain did with what the API said, to the last unit. It also proves the recipient
// option, the simulation, the slippage floor, every error code it can reach on a live
// chain, the rate limit, and that no response carries the RPC URL. Everything bought is
// sold back, so the shared pools end close to where they started.
// The kinds: no hook, tax, buyback, launch rules, launch guard (over and running), plain
// and pegged collectible coins, and a hook the platform did not write. For the launch rules
// template it also launches a coin with a short sniper window and a short buy limit, trades
// inside both, and waits for them to end (about 80 seconds).
//   node scripts/e2e-api.mjs <localnet|devnet> [base URL of a running server]
// Without a base URL it starts its own web/serve.js on a free port and stops it at the end.
// It never touches the server on 8787 and only ever stops processes it started itself.
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  HookpoolClient, NATIVE_MINT, DIRECTION, FLAGS, PROGRAMS, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM, IX, pda, ix,
  collectible as col, decodeGuardConfig, eventsFromTransaction, guardFee, rulesBuyLimit, rulesPda, rulesRatesTotal, rulesSniperFee,
  RULES_KIND, HOLDER_RECORD_RENT, HOLDER_RECORD_SIZE, decodeHolderRecord, CURVE_NONE, CURVE_OPEN, CURVE_GRADUATED,
} from "../sdk/dist/index.js";
import { explainSimulationError, ratioDecimal } from "../web/api/_trade-core.js";
import { clusterArg, connection, loadAlt, sendRefused, sendV0, waitForSlot } from "./cluster.mjs";

const cluster = clusterArg();
const conn = connection(cluster);
const client = new HookpoolClient(conn, { lookupTable: loadAlt(cluster) });
const SERVE = fileURLToPath(new URL("../web/serve.js", import.meta.url));
const OUR = Object.values(PROGRAMS).map((p) => p.toBase58());
const WSOL_RENT = 2_039_280n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));

let checks = 0;
const started = [];
function stopAll() { for (const s of started) s.stop(); }
process.on("exit", stopAll);
const check = (cond, msg) => {
  if (!cond) { console.error("CHECK FAILED: " + msg); stopAll(); process.exit(1); }
  checks++; console.log("  check  " + msg);
};
const head = (t) => console.log("\n== " + t);

// ---- servers ------------------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
/// Starts web/serve.js on a free port with extra environment. `stop` ends that one process.
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVE], { env: { ...process.env, PORT: String(port), ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  child.stderr.on("data", (d) => { log += d; });
  const url = "http://127.0.0.1:" + port;
  const server = { url, pid: child.pid, log: () => log, stop: () => { try { child.kill(); } catch (_) { /* gone */ } } };
  started.push(server);
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url + "/config.js"); if (r.ok) return server; } catch (_) { /* not up yet */ }
    await sleep(150);
  }
  server.stop();
  throw new Error("the test server did not start");
}

async function call(base, method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); if (!init.headers["content-type"]) init.headers["content-type"] = "application/json"; }
  const r = await fetch(base + path, init);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  return { status: r.status, headers: r.headers, json, text };
}
let BASE = process.argv[3] ? process.argv[3].replace(/\/+$/, "") : "";
const getQuote = (params, base = BASE) => call(base, "GET", "/api/v1/quote?" + new URLSearchParams(params));
const postSwap = (body, base = BASE) => call(base, "POST", "/api/v1/swap", body);
async function okQuote(params) {
  const r = await getQuote(params);
  if (r.status !== 200) check(false, "quote answered " + r.status + " " + r.text);
  return r;
}
async function okSwap(body) {
  const r = await postSwap(body);
  if (r.status !== 200) check(false, "swap answered " + r.status + " " + r.text);
  return r;
}

// ---- chain helpers ------------------------------------------------------------------------------

async function fund(pubkey, amountSol) {
  const sig = await conn.requestAirdrop(pubkey, Math.round(amountSol * LAMPORTS_PER_SOL));
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}
async function newWallet(amountSol) { const k = Keypair.generate(); if (amountSol > 0) await fund(k.publicKey, amountSol); return k; }
const lamportsOf = async (pk) => BigInt(await conn.getBalance(pk, "confirmed"));
async function fetchTx(sig) {
  for (let i = 0; i < 40; i++) {
    const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (t) return t;
    await sleep(200);
  }
  throw new Error("transaction " + sig + " not found");
}
async function waitPastSlot(slot) {
  for (;;) { const s = BigInt(await conn.getSlot("confirmed")); if (s > slot + 1n) return s; await sleep(400); }
}
/// Lamport change of every account of a landed transaction, by address.
function lamportDeltas(got) {
  const keys = got.transaction.message.getAccountKeys({ accountKeysFromLookups: got.meta.loadedAddresses }).keySegments().flat();
  const m = new Map();
  keys.forEach((k, i) => m.set(k.toBase58(), BigInt(got.meta.postBalances[i]) - BigInt(got.meta.preBalances[i])));
  return m;
}

// What a transaction of the API may contain, decoded here with no help from the API.
const COLLECTIBLE_IX = Object.entries(IX.hook_collectible);
const startsWith = (data, disc) => data.length >= disc.length && disc.every((b, i) => data[i] === b);
function nameOf(ins) {
  const pid = ins.programId; const d = Buffer.from(ins.data);
  if (pid.equals(ComputeBudgetProgram.programId)) return "compute_budget:" + (d[0] === 2 ? "limit" : d[0] === 3 ? "price" : "other");
  if (pid.equals(ATA_PROGRAM)) return "ata:" + (d.length === 1 && d[0] === 1 ? "create_idempotent" : "other");
  if (pid.equals(SYSTEM_PROGRAM)) return "system:" + (d.length === 12 && d.readUInt32LE(0) === 2 ? "transfer" : "other");
  if (pid.equals(TOKEN_PROGRAM)) return "token:" + (d[0] === 17 ? "sync_native" : d[0] === 9 ? "close_account" : "other");
  if (pid.equals(PROGRAMS.hookpool)) return "hookpool:" + (startsWith(d, IX.hookpool.swap) ? "swap" : startsWith(d, IX.hookpool.graduate) ? "graduate" : "other");
  if (pid.equals(PROGRAMS.hook_collectible)) { const hit = COLLECTIBLE_IX.find(([, disc]) => startsWith(d, disc)); return "collectible:" + (hit ? hit[0] : "other"); }
  if (pid.equals(PROGRAMS.hook_rules)) { const hit = RULES_IX.find(([, disc]) => startsWith(d, disc)); return "rules:" + (hit ? hit[0] : "other"); }
  return "unknown:" + pid.toBase58();
}
const RULES_IX = Object.entries(IX.hook_rules);
const ALLOWED = new Set([
  "compute_budget:limit", "compute_budget:price", "ata:create_idempotent", "system:transfer", "token:sync_native", "token:close_account",
  "hookpool:swap", "collectible:open_ticket", "collectible:settle", "collectible:reap", "rules:open_holder",
  // a pool on the curve: the trade that takes it to its graduation target graduates it in the same transaction
  "hookpool:graduate",
]);

/// Every swap inspected, and those that graduate a coin: the floor rule is checked on each of them.
const floorsSeen = { n: 0, graduating: 0 };
/// Decodes the transaction of a swap answer and checks the promises of the API: unsigned,
/// one signer who pays, only the allowed instructions, and the quote's floor inside the swap.
async function inspect(sw, wallet) {
  const raw = Buffer.from(sw.transaction, "base64");
  const tx = VersionedTransaction.deserialize(raw);
  if (tx.message.header.numRequiredSignatures !== 1) throw new Error("more than one signer");
  if (!tx.message.staticAccountKeys[0].equals(wallet)) throw new Error("the fee payer is not the user");
  if (tx.signatures.length !== 1 || !tx.signatures[0].every((b) => b === 0)) throw new Error("the transaction is not unsigned");
  if (tx.message.recentBlockhash !== sw.blockhash) throw new Error("blockhash mismatch");
  if (raw.length > 1232) throw new Error("larger than one packet");
  const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: await client.lookupTables() });
  const kinds = msg.instructions.map(nameOf);
  for (const k of kinds) if (!ALLOWED.has(k)) throw new Error("instruction not allowed: " + k);
  const swapIx = msg.instructions.filter((i) => i.programId.equals(PROGRAMS.hookpool) && startsWith(Buffer.from(i.data), IX.hookpool.swap));
  if (swapIx.length !== 1) throw new Error("expected exactly one swap");
  const d = Buffer.from(swapIx[0].data);
  // `graduate` only where the quote says the trade graduates the coin, of this pool: right in front of the
  // swap on a pool that stands at or past its target (the trade runs on the graduated pool), right after it on
  // a buy that takes the pool to its target
  const grads = msg.instructions.filter((i) => i.programId.equals(PROGRAMS.hookpool) && startsWith(Buffer.from(i.data), IX.hookpool.graduate));
  const c = sw.quote.curve;
  const graduates = !!(c && c.graduates);
  if (grads.length !== (graduates ? 1 : 0)) throw new Error("graduate is in the transaction " + grads.length + " times, the quote says graduates: " + graduates);
  const first = graduates && c.graduateFirst === true;
  if (graduates && c.graduateFirst !== (c.state === "open" && BigInt(c.raised) >= BigInt(c.target))) throw new Error("graduateFirst does not say whether the pool stands past its target");
  if (graduates && (msg.instructions.indexOf(grads[0]) !== msg.instructions.indexOf(swapIx[0]) + (first ? -1 : 1) || !grads[0].keys[1].pubkey.equals(new PublicKey(sw.quote.pool)))) throw new Error(`graduate is not right ${first ? "before" : "after"} the swap, or names another pool`);
  // the floor inside the swap is never below the quote less the slippage: nothing lowers it
  if (d.readBigUInt64LE(17) < (BigInt(sw.quote.outAmount) * BigInt(10_000 - sw.quote.slippageBps)) / 10_000n) throw new Error(`the swap's floor ${d.readBigUInt64LE(17)} is below the quote ${sw.quote.outAmount} less ${sw.quote.slippageBps} bps`);
  floorsSeen.n += 1;
  if (graduates) floorsSeen.graduating += 1;
  if (d[8] !== (sw.quote.side === "buy" ? DIRECTION.BUY : DIRECTION.SELL)) throw new Error("direction mismatch");
  if (d.readBigUInt64LE(9) !== BigInt(sw.quote.inAmount)) throw new Error("amount mismatch");
  if (d.readBigUInt64LE(17) !== BigInt(sw.quote.minOutAmount)) throw new Error("the swap does not carry minOutAmount");
  if (!swapIx[0].keys[0].pubkey.equals(wallet) || !swapIx[0].keys[0].isSigner) throw new Error("the swap is not signed by the user");
  // The pool signs a hook's callbacks with an address of its own for that hook program,
  // ["caller", hook program] (the system program stands for "no hook"). The swap names this
  // pool, its hook and that address, worked out here from the pool as the chain holds it.
  const pool = await poolOf(sw.quote.pool);
  const k = swapIx[0].keys;
  if (!k[2].pubkey.equals(pool.address) || !k[10].pubkey.equals(pool.hookProgram)) throw new Error("the swap names another pool or another hook");
  if (!k[12].pubkey.equals(pda.caller(pool.hookProgram)[0])) throw new Error("the swap does not name the caller of this pool's hook program");
  return { tx, size: raw.length, kinds, tables: tx.message.addressTableLookups.length, hookAccounts: k.slice(17) };
}
const poolsSeen = new Map();
async function poolOf(address) {
  if (!poolsSeen.has(address)) poolsSeen.set(address, await client.pool(new PublicKey(address)));
  return poolsSeen.get(address);
}

/// The swaps this script landed, by pool: the check of the shared pools at the end tells its own trades from
/// those of other wallets on the same chain.
const ownSwaps = new Map();
async function land(tx, wallet, sw, opts = {}) {
  tx.sign([wallet]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: !!opts.skipPreflight });
  const res = await conn.confirmTransaction({ signature: sig, blockhash: sw.blockhash, lastValidBlockHeight: sw.lastValidBlockHeight }, "confirmed");
  if (!res.value.err && sw.quote) ownSwaps.set(sw.quote.pool, (ownSwaps.get(sw.quote.pool) ?? 0) + 1);
  return { sig, err: res.value.err, got: await fetchTx(sig) };
}

const rows = [];
/// One trade through the API, checked against the chain. Returns what was observed.
///   opts.recipient   a public key that receives the output
///   opts.runningGuard  the quote is not exact; the chain gives the same or more (a buy
///                      while a launch guard or the sniper fee of a rules coin runs)
async function trade(kind, poolAddr, wallet, side, amount, opts = {}) {
  const pool0 = await client.pool(poolAddr);
  const mint = pool0.baseMint;
  const params = { mint: mint.toBase58(), side, amount: String(amount) };
  if (opts.slippageBps !== undefined) params.slippageBps = String(opts.slippageBps);
  const q = (await okQuote(params)).json;
  const body = { ...params, userPublicKey: wallet.publicKey.toBase58(), simulate: true };
  if (opts.slippageBps !== undefined) body.slippageBps = opts.slippageBps;
  if (opts.recipient) body.recipient = opts.recipient.toBase58();
  if (opts.mintDeposit !== undefined) body.mintDeposit = opts.mintDeposit;
  const sr = await okSwap(body);
  const sw = sr.json;
  const seen = await inspect(sw, wallet.publicKey);
  const exact = !opts.runningGuard;
  if (q.exact !== exact || sw.quote.exact !== exact) check(false, `${kind} ${side}: exact should be ${exact}`);
  if (exact && q.outAmount !== sw.quote.outAmount) check(false, `${kind} ${side}: the pool moved between the quote and the swap (run again)`);
  if (exact && sw.simulation.outAmount !== sw.quote.outAmount) check(false, `${kind} ${side}: simulation says ${sw.simulation.outAmount}, quote says ${sw.quote.outAmount}`);

  const receiver = opts.recipient ?? wallet.publicKey;
  const coins0 = await client.tokenBalance(receiver, mint, pool0.baseTokenProgram);
  const lam0 = await lamportsOf(receiver);
  const { sig, err, got } = await land(seen.tx, wallet, sw);
  if (err) check(false, `${kind} ${side}: the transaction failed on chain: ${JSON.stringify(err)}`);
  const coins1 = await client.tokenBalance(receiver, mint, pool0.baseTokenProgram);
  const lam1 = await lamportsOf(receiver);
  const ev = eventsFromTransaction(got, OUR).find((e) => e.kind === "Swapped");
  const d = lamportDeltas(got);
  const fee = BigInt(got.meta.fee);
  const out = BigInt(sw.quote.outAmount);

  // the chain's own record of the trade against the quote, field by field
  if (!ev || ev.amountIn !== BigInt(amount)) check(false, `${kind} ${side}: no Swapped event for this amount`);
  if (exact) {
    const same = ev.amountOut === out && ev.protocolFee === BigInt(sw.quote.fees.protocol.amount) && ev.lpFee === BigInt(sw.quote.fees.pool.amount)
      && ev.hookFee === BigInt(sw.quote.fees.hook.amount) && ev.feeBpsApplied === sw.quote.fees.pool.bps;
    if (!same) check(false, `${kind} ${side}: the chain's event differs from the quote: out ${ev.amountOut} vs ${out}, fees ${ev.protocolFee}/${ev.lpFee}/${ev.hookFee} vs ${sw.quote.fees.protocol.amount}/${sw.quote.fees.pool.amount}/${sw.quote.fees.hook.amount}`);
  }
  let got1; let rentBack = 0n;
  if (side === "buy") {
    got1 = coins1 - coins0;
    if (got1 !== ev.amountOut) check(false, `${kind} buy: the wallet got ${got1} coins, the pool paid ${ev.amountOut}`);
    if (exact && got1 !== out) check(false, `${kind} buy: the wallet got ${got1}, the quote said ${out}`);
    if (!exact && got1 < out) check(false, `${kind} buy: the wallet got ${got1}, less than the quote ${out}`);
  } else {
    // SOL: what reached the receiver, with the network fee and any rent that came back counted apart
    const vaultDelta = d.get(pool0.quoteVault.toBase58()) ?? 0n;
    const treasury = pool0.hookQuoteTreasury.toBase58();
    const paidToTreasury = ev.hookFee > 0n ? (d.get(treasury) ?? 0n) : 0n;
    if (vaultDelta !== -(ev.amountOut + paidToTreasury)) check(false, `${kind} sell: the vault lost ${-vaultDelta}, expected ${ev.amountOut + paidToTreasury}`);
    const walletKey = wallet.publicKey.toBase58();
    const wsolKey = pda.ata(wallet.publicKey, NATIVE_MINT).toBase58();
    // a wallet that kept a wrapped SOL account receives the SOL of the sell inside it
    const ownWrapped = -(d.get(wsolKey) ?? 0n);
    const skip = new Set([walletKey, pool0.quoteVault.toBase58(), treasury, wsolKey]);
    if (opts.recipient) skip.add(opts.recipient.toBase58());
    for (const [k, v] of d) if (!skip.has(k)) rentBack -= v;
    if (opts.recipient) {
      got1 = lam1 - lam0;
      if (got1 !== out + WSOL_RENT) check(false, `${kind} sell: the recipient got ${got1} lamports, expected ${out} + ${WSOL_RENT} of rent`);
      if (d.get(walletKey) !== -fee - WSOL_RENT + rentBack) check(false, `${kind} sell: the signer's balance moved by ${d.get(walletKey)}`);
    } else {
      got1 = lam1 - lam0 + fee - rentBack - ownWrapped;
      if (lam1 - lam0 !== d.get(walletKey)) check(false, `${kind} sell: balance change ${lam1 - lam0} differs from the transaction record ${d.get(walletKey)}`);
      if (exact && got1 !== out) check(false, `${kind} sell: the wallet got ${got1} lamports (fee ${fee}, rent back ${rentBack}), the quote said ${out}`);
    }
  }
  const row = {
    kind, side, in: String(amount), quote: sw.quote.outAmount, simulated: sw.simulation.outAmount, chain: ev.amountOut.toString(), wallet: got1.toString(), exact,
    fees: `${ev.protocolFee}/${ev.lpFee}/${ev.hookFee}`, bytes: seen.size, cu: got.meta.computeUnitsConsumed, rpc: sr.headers.get("x-rpc-calls"), rentBack, kinds: seen.kinds, notes: sw.notes, sig, slot: got.slot, ev, sw, q, fee,
    hookAccounts: seen.hookAccounts,
  };
  rows.push(row);
  return row;
}
const say = (r, extra = "") => check(true, `${r.kind} ${r.side} ${r.in}: quote ${r.quote}, simulated ${r.simulated}, chain paid ${r.chain}, ${r.kind.includes("+recipient") ? "recipient" : "wallet"} received ${r.wallet}${r.wallet === r.quote ? " (equal to the last unit)" : ""}; fees protocol/pool/hook ${r.fees}; ${r.bytes} bytes, ${r.cu} CU, ${r.rpc} RPC calls${extra}`);

// ---- setup ---------------------------------------------------------------------------------------

head("setup");
if (!client.options.lookupTable) { console.error("run init-platform first: no lookup table file"); process.exit(1); }
const platform = await client.platform();
if (!platform) { console.error("run init-platform first"); process.exit(1); }
const ownServer = !BASE;
if (!BASE) { const s = await startServer({ PROGRAMMABLE_API_QUOTE_LIMIT: "100000", PROGRAMMABLE_API_SWAP_LIMIT: "100000" }); BASE = s.url; console.log("  started web/serve.js as PID " + s.pid + " on " + BASE); }
else console.log("  using the server at " + BASE);

const allPools = (await client.allPools()).filter((p) => p.quoteMint.equals(NATIVE_MINT)).sort((a, b) => a.address.toBase58().localeCompare(b.address.toBase58()));
const slotNow = BigInt(await conn.getSlot("confirmed"));
const found = {};
// Of several pools of one kind the script takes the one that suits it best (`rank`), then
// the oldest. A chain that other rehearsals use holds many pools: a rehearsal running next
// to this one launches its own coins and expects them to stay as it left them, and the
// oldest pools are the ones the chain was set up with. Pools with little in them are left
// out: the trades here are 0.02 to 0.6 SOL and should move a price by a few percent.
const rank = new Map();
const MIN_DEPTH = sol(1);
/// A hook the platform did not write can change the amounts of a buy when the pool calls it
/// before the swap and its flags grant it a fee, a fee override or the curve.
const changesBuys = (x) => (x.hookFlags & FLAGS.BEFORE_SWAP) !== 0 && (x.hookFlags & FLAGS.CALL_ON_BUY) !== 0 && (x.hookFlags & (FLAGS.TAKE_HOOK_FEE | FLAGS.OVERRIDE_FEE | FLAGS.OVERRIDE_CURVE)) !== 0;
// Pools that opened on the curve (open or graduated) are a kind of their own: the script launches its own
// further down. The kinds below are seeded pools, as before the curve existed.
const curvePools = allPools.filter((p) => p.curveState !== CURVE_NONE);
for (const p of allPools) {
  let kind = "none";
  let suits = 0;
  if (p.curveState !== CURVE_NONE) continue;
  if (p.reserveQuote < MIN_DEPTH) continue;
  if (p.hasHook) {
    if (p.hookProgram.equals(PROGRAMS.hook_tax)) kind = "tax";
    else if (p.hookProgram.equals(PROGRAMS.hook_buyback)) kind = "buyback";
    else if (p.hookProgram.equals(PROGRAMS.hook_launch_guard)) {
      const g = decodeGuardConfig(new Uint8Array((await conn.getAccountInfo(pda.cfg(PROGRAMS.hook_launch_guard, p.address))).data));
      const end = g.startSlot + g.guardSlots;
      kind = slotNow + 900n < end ? "guard_running" : slotNow >= end ? "guard_over" : "guard_ending";
    } else if (p.hookProgram.equals(PROGRAMS.hook_collectible)) {
      const cfg = await col.fetchCollectionConfig(conn, p.address);
      if (!cfg || cfg.live + 20 > cfg.maxSupply) continue;
      // a pegged coin with a small unit, where two small buys earn eight pieces
      if (cfg.pegged && cfg.unit === 1_000_000_000_000n && cfg.maxPerBuy === 4) kind = "pegged_small";
      // the other flows want a unit a 0.02 SOL buy stays under and a 0.6 SOL buy reaches
      else if (cfg.unit === 50_000_000_000_000n) kind = cfg.pegged ? "pegged" : "collectible";
      else continue;
    } else if (p.hookProgram.equals(PROGRAMS.hook_rules)) {
      // The launch rules template. For the round trip the script wants a coin whose two
      // windows are over (the quote is exact both ways) and that has as many of the three
      // shares switched on as possible. A coin inside a window is launched further down.
      const st = await client.rulesState(p.address);
      if (!st) continue;
      const c = st.config;
      // a strict coin is a kind of its own: the script launches one further down
      if (c.kind === RULES_KIND.STRICT) continue;
      if (slotNow < c.startSlot + c.sniperSlots || rulesBuyLimit(c, slotNow) !== null) continue;
      if (rulesRatesTotal(c.buy) === 0 || rulesRatesTotal(c.sell) === 0) continue;
      kind = "rules";
      suits = [c.buy.creatorBps, c.buy.holdersBps, c.buy.burnBps, c.sell.creatorBps, c.sell.holdersBps, c.sell.burnBps].filter((b) => b > 0).length;
    } else if (OUR.includes(p.hookProgram.toBase58())) {
      continue;   // a platform program this script does not know: never mistaken for somebody else's hook
    } else {
      // A hook the platform did not write. Best is one that takes a fee on buys, then one
      // that can change the amounts of a buy in another way, then any.
      kind = "custom";
      suits = changesBuys(p) ? ((p.hookFlags & FLAGS.TAKE_HOOK_FEE) !== 0 ? 2 : 1) : 0;
    }
  }
  const before = found[kind];
  if (!before || suits > rank.get(kind) || (suits === rank.get(kind) && p.createdSlot < before.createdSlot)) { found[kind] = p; rank.set(kind, suits); }
}
console.log("  pools on chain: " + allPools.length + ". Kinds found: " + Object.keys(found).sort().join(", ")
  + ". On the curve: " + curvePools.filter((p) => p.curveState === CURVE_OPEN).length + " open, " + curvePools.filter((p) => p.curveState === CURVE_GRADUATED).length + " graduated (left alone: the script launches its own)");

// E2E_LAUNCH=1 launches the two coins below even when the chain has them (to rehearse the launches)
const forceLaunch = process.env.E2E_LAUNCH === "1";
// a launch guard that is still running does not stay on a chain: launch one when none is left
if (!found.guard_running || forceLaunch) {
  const dev = await newWallet(4);
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name: "API Guard Test", symbol: "AGT", uri: "https://example.com/meta/agt.json", decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: sol(2), devBuyQuote: 0n, minDevBuyOut: 0n,
    template: "launch_guard", guard: { guardSlots: 9000n, startFeeBps: 3000 },
  });
  await sendV0(conn, client, plan.createTx, [dev, mint], "launch a guard coin: create");
  await sendV0(conn, client, plan.launchTx, [dev], "launch a guard coin: pool, guard of 9000 slots from 30%");
  found.guard_running = await client.pool(plan.pool);
}
// a launch guard whose window is over: on a chain a few minutes old every guard still runs
if (!found.guard_over || forceLaunch) {
  const dev = await newWallet(4);
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name: "API Guard Done", symbol: "AGD", uri: "https://example.com/meta/agd.json", decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: sol(2), devBuyQuote: 0n, minDevBuyOut: 0n,
    template: "launch_guard", guard: { guardSlots: 10n, startFeeBps: 3000 },
  });
  await sendV0(conn, client, plan.createTx, [dev, mint], "launch a guard coin with a short window: create");
  await sendV0(conn, client, plan.launchTx, [dev], "launch a guard coin with a short window: pool, guard of 10 slots");
  const made = await client.pool(plan.pool);
  await waitPastSlot(made.createdSlot + 10n);
  found.guard_over = await client.pool(plan.pool);
}
if (!found.pegged_small || forceLaunch) {
  const dev = await newWallet(4);
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name: "API Peg Test", symbol: "APT", uri: "https://example.com/meta/apt.json", decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: sol(2), devBuyQuote: 0n, minDevBuyOut: 0n,
    template: "collectible",
    collectible: { name: "API Shots", uriBase: "http://localhost:8787/art", unit: 1_000_000_000_000n, maxSupply: 1000, maxPerBuy: 4, art: Uint8Array.from([1, 28, 30, 150, 24, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), pegged: true },
  });
  await sendV0(conn, client, plan.createTx, [dev, mint], "launch a pegged coin: coin, collection, peg");
  await sendV0(conn, client, plan.launchTx, [dev], "launch a pegged coin: pool, one piece per 1,000,000 coins");
  found.pegged_small = await client.pool(plan.pool);
}
// a coin on the launch rules template with no window running: launched when the chain has none
const RULES_SUPPLY = 1_000_000_000n * 1_000_000n;
async function launchRulesCoin(symbol, name, rules, label) {
  const dev = await newWallet(4);
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name, symbol, uri: "https://example.com/meta/" + symbol.toLowerCase() + ".json", decimals: 6, totalSupply: RULES_SUPPLY,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: sol(2), devBuyQuote: 0n, minDevBuyOut: 0n, template: "rules", rules,
  });
  await sendV0(conn, client, plan.createTx, [dev, mint], label + ": the coin and its rules");
  await sendV0(conn, client, plan.launchTx, [dev], label + ": the pool");
  return client.pool(plan.pool);
}
if (!found.rules || forceLaunch) {
  found.rules = await launchRulesCoin("ARL", "API Rules Test", { buy: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, sell: { creatorBps: 100, holdersBps: 200, burnBps: 100 } }, "launch a rules coin");
}
for (const k of ["none", "tax", "buyback", "rules", "guard_over", "guard_running", "collectible", "pegged", "pegged_small"]) check(!!found[k], `a pool of kind ${k}: ${found[k] ? found[k].address.toBase58() : "missing"}`);
if (found.custom) console.log("  a pool with a hook the platform did not write: " + found.custom.address.toBase58());
else console.log("  no pool with a third-party hook exists on this chain (hook-template/README.md shows how to make one): that path is then covered by the unit tests only");
// the tax of the tax coin, as its config holds it: the quote must say these numbers
const taxOf = (await client.hookInfo(found.tax)).tax;
const priceOf = (p) => Number(p.reserveQuote) / Number(p.reserveBase);
const priceBefore = {};
for (const [k, p] of Object.entries(found)) priceBefore[k] = priceOf(p);

// ---- the shape of the answers ----------------------------------------------------------------------

head("answers");
{
  const p = found.tax;
  const r = await okQuote({ mint: p.baseMint.toBase58(), side: "buy", amount: "200000000" });
  const q = r.json;
  const keys = Object.keys(q).join(",");
  check(keys === "pool,side,inputMint,outputMint,inAmount,outAmount,minOutAmount,slippageBps,priceBefore,priceAfter,priceImpactPct,fees,hook,coin,mintDeposit,curve,exact,slot,notes", "quote fields: " + keys);
  check(JSON.stringify(q.curve) === JSON.stringify({ state: "none", virtualQuote: "0", raised: "0", target: "0", raisedBps: 0, soldBps: 0, graduates: false, graduateFirst: false }), "a seeded pool's quote carries the curve part with nothing in it: " + JSON.stringify(q.curve));
  check(q.pool === p.address.toBase58() && q.inputMint === NATIVE_MINT.toBase58() && q.outputMint === p.baseMint.toBase58(), "pool and both mints named");
  check(typeof q.inAmount === "string" && typeof q.outAmount === "string" && /^[0-9]+$/.test(q.outAmount), "amounts are strings of digits");
  check(q.slippageBps === 100 && BigInt(q.minOutAmount) === (BigInt(q.outAmount) * 9900n) / 10000n, `default slippage 100 bps: minOutAmount ${q.minOutAmount} of ${q.outAmount}`);
  check(q.hook.template === "tax" && q.hook.kind === "platform" && q.hook.runsOnBuys && q.hook.runsOnSells && q.hook.program === PROGRAMS.hook_tax.toBase58(), "hook: " + JSON.stringify(q.hook));
  check(q.fees.hook.bps === taxOf.buyBps && q.fees.hook.bps > 0 && q.fees.hook.mint === NATIVE_MINT.toBase58() && q.fees.protocol.bps === platform.protocolFeeBps && q.fees.pool.bps === p.lpFeeBps, "fees: " + JSON.stringify(q.fees));
  check(q.coin.decimals === 6 && q.coin.symbol.length > 0 && q.coin.collectible === null, "coin: " + JSON.stringify(q.coin));
  check(q.exact === true && Number.isInteger(q.slot) && Array.isArray(q.notes) && q.notes.length === (p.hookFeesOwedQuote > 0n ? 3 : 2), "exact, slot " + q.slot + ", notes: " + JSON.stringify(q.notes));
  check(Number(q.priceAfter) > Number(q.priceBefore) && Number(q.priceImpactPct) > 0, `price from ${q.priceBefore} to ${q.priceAfter} SOL per coin, impact ${q.priceImpactPct}%`);
  const byPool = (await okQuote({ pool: p.address.toBase58(), side: "buy", amount: "200000000" })).json;
  check(byPool.outAmount === q.outAmount, "the same quote by pool address");
  const zero = (await okQuote({ mint: p.baseMint.toBase58(), side: "buy", amount: "200000000", slippageBps: "0" })).json;
  check(zero.minOutAmount === zero.outAmount, "slippageBps 0: minOutAmount equals outAmount");
  check(r.headers.get("access-control-allow-origin") === "*" && r.headers.get("cache-control") === "no-store", "CORS and no-store headers on a quote");
  const warm = await okQuote({ mint: p.baseMint.toBase58(), side: "sell", amount: "1000000000" });
  check(warm.headers.get("x-rpc-calls") === "1", "a quote of a pool the server has seen costs 1 RPC call");
  for (const route of ["quote", "swap"]) {
    const o = await call(BASE, "OPTIONS", "/api/v1/" + route, undefined, { origin: "https://bot.example", "access-control-request-method": route === "quote" ? "GET" : "POST", "access-control-request-headers": "content-type" });
    check(o.status === 204 && o.headers.get("access-control-allow-origin") === "*" && o.headers.get("access-control-allow-methods").includes(route === "quote" ? "GET" : "POST") && /content-type/i.test(o.headers.get("access-control-allow-headers")),
      `OPTIONS /api/v1/${route}: 204, methods ${o.headers.get("access-control-allow-methods")}, headers ${o.headers.get("access-control-allow-headers")}`);
  }
}

// ---- every kind of pool, both directions ------------------------------------------------------------

head("round trips: quote, swap, sign, send, compare with the chain");
for (const kind of ["none", "tax", "buyback", "rules", "guard_over"]) {
  const pool = found[kind];
  const w = await newWallet(2);
  const buy = await trade(kind, pool.address, w, "buy", sol(0.2));
  say(buy);
  check(buy.kinds.join(" ") === "compute_budget:limit ata:create_idempotent ata:create_idempotent system:transfer token:sync_native hookpool:swap token:close_account", `${kind} buy holds only: ${buy.kinds.join(", ")}`);
  const sell = await trade(kind, pool.address, w, "sell", BigInt(buy.wallet));
  say(sell);
  check(sell.rentBack === 0n && sell.kinds.join(" ") === "compute_budget:limit ata:create_idempotent hookpool:swap token:close_account", `${kind} sell holds only: ${sell.kinds.join(", ")}`);
  if (kind === "tax") check(buy.ev.hookFee > 0n && sell.ev.hookFee > 0n && buy.sw.quote.fees.hook.bps === taxOf.buyBps && sell.sw.quote.fees.hook.bps === taxOf.sellBps, `tax: ${taxOf.buyBps / 100}% of the buy (${buy.ev.hookFee} lamports) and ${taxOf.sellBps / 100}% of the sell (${sell.ev.hookFee} lamports) went to the treasury, as quoted`);
  if (kind === "buyback") check(buy.ev.hookFee > 0n && sell.ev.hookFee > 0n, `buyback: fees of ${buy.ev.hookFee} and ${sell.ev.hookFee} lamports, as quoted`);
  // every swap on a buyback pool may lower the observation its buybacks buy against, so the config goes in writable
  if (kind === "buyback") {
    const cfgKey = pda.cfg(PROGRAMS.hook_buyback, pool.address);
    check([buy, sell].every((t) => t.hookAccounts.length === 1 && t.hookAccounts[0].pubkey.equals(cfgKey) && t.hookAccounts[0].isWritable && !t.hookAccounts[0].isSigner),
      "buyback: both swaps pass the hook's one account, its config, writable; and the pool's caller for the buyback program (checked in every transaction)");
    check(buy.notes[0] === buy.q.notes[0] && /^A fee of [0-9.]+% on buys and [0-9.]+% on sells funds buybacks of this coin\. The quote includes it\.$/.test(buy.notes[0]), "buyback note: " + buy.notes[0]);
  }
  if (kind === "rules") {
    const c = (await client.rulesState(pool.address)).config;
    const cfgKey = rulesPda.cfg(pool.address);
    const hq = buy.sw.quote.hook; const hs = sell.sw.quote.hook;
    check(hq.template === "rules" && hq.kind === "platform" && hq.program === PROGRAMS.hook_rules.toBase58() && hq.runsOnBuys && hq.runsOnSells, `rules: the quote names a platform template called rules: ${JSON.stringify(hq)}`);
    check(buy.sw.quote.fees.hook.bps === Math.min(rulesRatesTotal(c.buy), platform.maxHookFeeBps) && sell.sw.quote.fees.hook.bps === Math.min(rulesRatesTotal(c.sell), platform.maxHookFeeBps) && buy.ev.hookFee > 0n && sell.ev.hookFee > 0n,
      `rules: fees.hook is the three rates of the side together, ${buy.sw.quote.fees.hook.bps} bps of the buy (${buy.ev.hookFee} lamports) and ${sell.sw.quote.fees.hook.bps} bps of the sell (${sell.ev.hookFee} lamports), as the chain charged`);
    check(hq.rules.creatorBps === c.buy.creatorBps && hq.rules.holdersBps === c.buy.holdersBps && hq.rules.burnBps === c.buy.burnBps && hs.rules.creatorBps === c.sell.creatorBps && hs.rules.holdersBps === c.sell.holdersBps && hs.rules.burnBps === c.sell.burnBps
      && hq.rules.sniperEndsAtSlot === null && hq.rules.buyLimit === null, `rules: hook.rules carries the three rates of each side as the config holds them, and no window: ${JSON.stringify(hq.rules)}`);
    check(buy.sw.quote.exact && sell.sw.quote.exact && buy.q.notes.some((n) => n === "These rates were fixed at launch and can never change.") && /^This coin takes [0-9.]+% of every buy, in SOL\./.test(buy.q.notes[0]) && /^This coin takes [0-9.]+% of every sell, in SOL\./.test(sell.q.notes[0]),
      "rules: exact both ways; notes of the buy: " + JSON.stringify(buy.q.notes));
    check(Object.keys(hq.rules).join(",") === "creatorBps,holdersBps,burnBps,sniperEndsAtSlot,buyLimit,strict" && hq.rules.strict === null, `rules: hook.rules holds the rules and nothing about what is staked (${c.totalStaked} raw coins are staked on this pool right now), and no strict part on a plain coin: ${Object.keys(hq.rules).join(", ")}`);
    check([buy, sell].every((t) => t.hookAccounts.length === 1 && t.hookAccounts[0].pubkey.equals(cfgKey) && t.hookAccounts[0].isWritable && !t.hookAccounts[0].isSigner),
      "rules: both swaps pass the hook's one account, its config, writable; no instruction of the rules program is in the transaction");
  }
  if (kind === "guard_over") check(buy.sw.quote.fees.pool.bps === pool.lpFeeBps && buy.sw.quote.notes.length === 0, "guard over: the pool fee is the normal one and the quote carries no note");
}

head("a launch guard that is still running");
{
  const pool = found.guard_running;
  const w = await newWallet(2);
  const pool0 = await client.pool(pool.address);
  const hookInfo = await client.hookInfo(pool0);
  const buy = await trade("guard_running", pool.address, w, "buy", sol(0.2), { runningGuard: true });
  say(buy);
  const feeQuoted = buy.sw.quote.fees.pool.bps;
  const feeLanded = buy.ev.feeBpsApplied;
  check(feeQuoted > pool.lpFeeBps && feeLanded <= feeQuoted, `quote at slot ${buy.sw.quote.slot} used a pool fee of ${feeQuoted} bps; the trade landed at slot ${buy.slot} and paid ${feeLanded} bps`);
  check(feeLanded === guardFee(BigInt(buy.slot), hookInfo.guard.startSlot, hookInfo.guard.guardSlots, hookInfo.guard.startFeeBps, pool.lpFeeBps), "the fee the chain applied is the guard's fee of the landing slot");
  const atLanding = await client.quoteLocal(pool0, platform, DIRECTION.BUY, sol(0.2), hookInfo, BigInt(buy.slot));
  check(atLanding.amountOut === BigInt(buy.wallet), `the same quote at the landing slot gives ${atLanding.amountOut}: equal to what the wallet received`);
  check(BigInt(buy.wallet) >= BigInt(buy.quote), `the wallet received ${BigInt(buy.wallet) - BigInt(buy.quote)} units more than quoted, never less`);
  check(buy.sw.quote.notes.length === 3 && /launch guard is running/.test(buy.notes[0]), "notes: " + JSON.stringify(buy.sw.quote.notes));
  const sell = await trade("guard_running", pool.address, w, "sell", BigInt(buy.wallet));
  say(sell, " (the guard does not touch sells: exact)");
  check(sell.sw.quote.fees.pool.bps === pool.lpFeeBps, "a sell pays the normal pool fee");
}

// ---- a rules coin inside its two windows ----------------------------------------------------------------

head("a rules coin inside its sniper window and its buy limit (launched now: 150 slots of sniper fee, 200 slots of limit)");
{
  const SNIPER_SLOTS = 150n; const LIMIT_SLOTS = 200n; const LIMIT = sol(0.2);
  const made = await launchRulesCoin("ARW", "API Rules Window", {
    sniperSlots: SNIPER_SLOTS, sniperStartFeeBps: 3000, maxBuyQuote: LIMIT, limitSlots: LIMIT_SLOTS,
    buy: { creatorBps: 100, burnBps: 50 }, sell: { creatorBps: 100, holdersBps: 100 },
  }, "launch a rules coin with a sniper fee from 30% and a buy limit of 0.2 SOL");
  found.rules_window = made;
  priceBefore.rules_window = priceOf(made);
  const mint = made.baseMint.toBase58();
  const c = (await client.rulesState(made.address)).config;
  const sniperEnd = c.startSlot + SNIPER_SLOTS; const limitEnd = c.startSlot + LIMIT_SLOTS;
  console.log(`  the pool was created in slot ${c.startSlot}: the sniper fee ends at slot ${sniperEnd}, the buy limit at slot ${limitEnd}`);
  const w = await newWallet(3);
  const hookInfo = await client.hookInfo(made);

  // a buy above the limit: refused in words by both calls, before a transaction exists
  const over = { mint, side: "buy", amount: String(sol(0.3)) };
  const rq = await getQuote(over);
  const rs = await postSwap({ ...over, userPublicKey: w.publicKey.toBase58(), simulate: true });
  for (const [name, r] of [["/quote", rq], ["/swap", rs]]) {
    const e = r.json && r.json.error;
    check(r.status === 422 && !!e && e.code === "BUY_LIMIT_EXCEEDED" && e.maxAmount === LIMIT.toString() && e.endsAtSlot === Number(limitEnd) && Object.keys(r.json).length === 1 && !("transaction" in r.json),
      `${name} refuses a buy of 0.3 SOL: 422 ${e ? e.code : r.text}, maxAmount ${e && e.maxAmount}, endsAtSlot ${e && e.endsAtSlot}: ${e && e.message}`);
  }
  // the chain refuses the same buy, by the name the API's own wording of chain errors knows
  const byHand = await sendRefused(conn, await client.swapInstructions(w.publicKey, made, await client.hookRef(made, w.publicKey), DIRECTION.BUY, sol(0.3), 0n), [w], "the same buy of 0.3 SOL sent to the chain without the API");
  const worded = explainSimulationError({ InstructionError: [5, { Custom: 6017 }] }, byHand.split("\n"));
  check(/Error Code: BuyTooLarge\. Error Number: 6017/.test(byHand) && worded.code === "BUY_LIMIT_EXCEEDED", `the chain's own refusal is BuyTooLarge (6017) of the rules program, which the API words as ${worded.code}`);

  // a buy of exactly the limit, inside both windows
  const buy = await trade("rules_window", made.address, w, "buy", LIMIT, { runningGuard: true });
  say(buy);
  const feeQuoted = buy.sw.quote.fees.pool.bps; const feeLanded = buy.ev.feeBpsApplied;
  check(BigInt(buy.slot) < sniperEnd, `the buy landed in slot ${buy.slot}, ${BigInt(buy.slot) - c.startSlot} slots into the sniper window`);
  check(feeQuoted > made.lpFeeBps && feeLanded <= feeQuoted && feeLanded > made.lpFeeBps, `the quote at slot ${buy.sw.quote.slot} used a pool fee of ${feeQuoted} bps; the trade landed at slot ${buy.slot} and paid ${feeLanded} bps`);
  check(feeLanded === rulesSniperFee(BigInt(buy.slot), c.startSlot, c.sniperSlots, c.sniperStartFeeBps, made.lpFeeBps), "the fee the chain applied is the sniper fee of the landing slot");
  const atLanding = await client.quoteLocal(made, platform, DIRECTION.BUY, LIMIT, hookInfo, BigInt(buy.slot));
  check(atLanding.amountOut === BigInt(buy.wallet) && BigInt(buy.wallet) >= BigInt(buy.quote), `the same quote at the landing slot gives ${atLanding.amountOut}: equal to what the wallet received, ${BigInt(buy.wallet) - BigInt(buy.quote)} units more than quoted, never less`);
  check(buy.sw.quote.fees.hook.bps === 150 && buy.ev.hookFee === BigInt(buy.sw.quote.fees.hook.amount) && buy.ev.hookFee === ((LIMIT - buy.ev.protocolFee) * 150n + 9999n) / 10000n,
    `the hook fee does not follow the window: 150 bps, ${buy.ev.hookFee} lamports, in the quote and on the chain`);
  const hr = buy.sw.quote.hook.rules;
  check(hr.sniperEndsAtSlot === Number(sniperEnd) && hr.buyLimit && hr.buyLimit.maxAmount === LIMIT.toString() && hr.buyLimit.endsAtSlot === Number(limitEnd), "hook.rules names both windows: " + JSON.stringify(hr));
  check(buy.q.notes.length === 7 && /^A sniper fee is running on this coin\. Buys pay a pool fee of [0-9.]+% at slot [0-9]+\. Sells do not pay it\.$/.test(buy.q.notes[0]) && buy.q.notes[1].includes("at slot " + sniperEnd)
    && buy.q.notes[3] === `A buy limit is running on this coin. One buy can spend at most ${LIMIT} lamports (0.2 SOL). The limit ends at slot ${limitEnd}, in about ${Math.ceil(Number(limitEnd - BigInt(buy.q.slot)) * 0.4)} seconds. Sells are never limited.`,
    "notes of the quote: " + JSON.stringify(buy.q.notes));

  // a sell inside the windows: neither touches it
  const half = BigInt(buy.wallet) / 2n;
  const sell = await trade("rules_window", made.address, w, "sell", half);
  say(sell, " (the windows do not touch sells: exact)");
  check(BigInt(sell.slot) < sniperEnd && sell.sw.quote.fees.pool.bps === made.lpFeeBps && sell.sw.quote.fees.hook.bps === 200 && sell.sw.quote.hook.rules.sniperEndsAtSlot === null && sell.sw.quote.hook.rules.buyLimit === null && !sell.q.notes.some((n) => /sniper|buy limit/.test(n)),
    `a sell in slot ${sell.slot} pays the normal pool fee and the 2% of the sell side; its notes: ${JSON.stringify(sell.q.notes)}`);

  // the sniper fee is over, the limit still runs: exact again, and the large buy is still refused
  await waitForSlot(conn, sniperEnd + 1n);
  const calm = await trade("rules_limit", made.address, w, "buy", sol(0.1));
  say(calm);
  check(BigInt(calm.slot) < limitEnd, `this buy landed in slot ${calm.slot}, after the sniper window and inside the limit window`);
  check(calm.sw.quote.fees.pool.bps === made.lpFeeBps && calm.sw.quote.hook.rules.sniperEndsAtSlot === null && calm.sw.quote.hook.rules.buyLimit.endsAtSlot === Number(limitEnd) && calm.q.notes.length === 4 && /^A buy limit is running/.test(calm.q.notes[0]),
    "after the sniper window the pool fee is the normal one and the quote is exact; the limit is still in the notes: " + calm.q.notes[0]);
  const still = await getQuote(over);
  check(still.status === 422 && still.json.error.code === "BUY_LIMIT_EXCEEDED", "a buy of 0.3 SOL is still refused: " + still.json.error.message);

  // both windows over: any buy, and no word about them
  await waitForSlot(conn, limitEnd + 1n);
  const free = await trade("rules_after", made.address, w, "buy", sol(0.3));
  say(free);
  check(free.sw.quote.hook.rules.buyLimit === null && free.sw.quote.hook.rules.sniperEndsAtSlot === null && free.q.notes.length === 3 && !free.q.notes.some((n) => /sniper|buy limit/.test(n)),
    `after slot ${limitEnd} the same buy of 0.3 SOL is quoted, built and lands; notes: ${JSON.stringify(free.q.notes)}`);
  say(await trade("rules_after", made.address, w, "sell", await client.tokenBalance(w.publicKey, made.baseMint)));
}

// ---- a strict coin ----------------------------------------------------------------------------------

head("a strict coin (its rules run in every transfer): a sniper fee from 30% for 60 slots, max wallet 3% for 200 slots, early window 75 slots, early unlock at 150, a creator lock");
{
  const SNIPER = 60n; const EARLY = 75n; const UNLOCK = 150n; const MAXW = 200n;
  const dev = await newWallet(4);
  const mintKp = Keypair.generate();
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint: mintKp, name: "API Strict Test", symbol: "AST", uri: "https://example.com/meta/ast.json", decimals: 6, totalSupply: RULES_SUPPLY,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: sol(2), devBuyQuote: sol(0.01), minDevBuyOut: 0n, template: "rules",
    rules: {
      sniperSlots: SNIPER, sniperStartFeeBps: 3000,
      buy: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, sell: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, creatorLockSeconds: 600, lockMarginSeconds: 120,
      strict: { maxWalletBps: 300, maxWalletSlots: Number(MAXW), earlySlots: Number(EARLY), earlyUnlockSlots: Number(UNLOCK) },
    },
  });
  await sendV0(conn, client, plan.createTx, [dev, mintKp], "launch a strict coin: the coin, its rules, the launcher's holder record");
  await sendV0(conn, client, plan.launchTx, [dev], "launch a strict coin: the pool, the first buy, the creator lock");
  const made = await client.pool(plan.pool);
  found.strict = made;
  priceBefore.strict = priceOf(made);
  const mint = made.baseMint.toBase58();
  const st0 = await client.rulesState(made.address);
  const c = st0.config;
  const start = c.startSlot;
  const cap = c.maxWalletAmount;
  check(c.kind === RULES_KIND.STRICT && made.baseTokenProgram.equals(TOKEN_2022_PROGRAM) && cap === (RULES_SUPPLY * 300n) / 10_000n,
    `a strict coin in Token-2022, pool created in slot ${start}; the max wallet is ${cap} raw units, 3% of the supply`);
  const holderOf = async (w) => { const a = await conn.getAccountInfo(rulesPda.holder(made.address, w)); return a ? decodeHolderRecord(new Uint8Array(a.data)) : null; };
  const errOf = (r) => (r.json && r.json.error ? r.json.error : null);
  const A = await newWallet(2); const B = await newWallet(3); const D = await newWallet(1);
  const C = Keypair.generate();
  const MARGIN = "The sniper fee falls every slot, so a buy that lands later gives more coins than this quote. The max wallet check leaves room for that: it counts the most this buy can give, at the pool's normal fee. A price fall between the quote and the landing can still push a buy within a hair of the cap over it, so keep a margin.";
  // the most a buy can give on this pool: its output at the pool's own fee, with the two rates of the buy side, by hand
  const ceilFee = (amount, bps) => (bps === 0 ? 0n : (amount * BigInt(bps) + 9999n) / 10000n);
  const mostOut = (pool, amount) => {
    const protocol = ceilFee(amount, platform.protocolFeeBps); const hookIn = ceilFee(amount - protocol, Math.min(rulesRatesTotal(c.buy), platform.maxHookFeeBps)); const lp = ceilFee(amount - protocol - hookIn, pool.lpFeeBps);
    const net = amount - protocol - hookIn - lp;
    return (pool.reserveBase * net) / (pool.reserveQuote + net);
  };

  // a quote that names no wallet: the windows and the general notes; inside the sniper window it is not exact
  const q0 = (await okQuote({ mint, side: "buy", amount: String(sol(0.05)) })).json;
  const s0 = q0.hook.rules.strict;
  check(q0.hook.template === "rules" && q0.exact === false && q0.fees.pool.bps > made.lpFeeBps && s0 && s0.maxWallet === cap.toString() && s0.maxWalletEndsAtSlot === Number(start + MAXW) && s0.earlyEndsAtSlot === Number(start + EARLY) && s0.earlyUnlockSlot === Number(start + UNLOCK) && s0.wallet === null,
    "a quote inside the windows names them in hook.rules.strict, and is not exact while the sniper fee falls: " + JSON.stringify(s0));
  check(q0.notes.includes("This is a strict coin. Its rules run inside every transfer of the coin, not only in this pool.") && q0.notes.some((n) => n.startsWith("A max wallet is running on this coin.")) && q0.notes.includes(MARGIN) && q0.notes.some((n) => n.startsWith("Coins bought until slot " + (start + EARLY)))
    && q0.notes.some((n) => n.startsWith("Only wallets with a holder record earn the holders' share.")) && q0.notes.some((n) => n.startsWith("It is split in three") && n.includes("holders with a holder record")),
    "its notes, the margin sentence among them: " + JSON.stringify(q0.notes.slice(6)));

  // A's first buy, in the early window: the API opens A's holder record in front of the swap
  check((await holderOf(A.publicKey)) === null, "A has no holder record");
  const qa = (await okQuote({ mint, side: "buy", amount: String(sol(0.05)), userPublicKey: A.publicKey.toBase58() })).json;
  const pa = await client.pool(made.address);
  check(qa.hook.rules.strict.wallet && qa.hook.rules.strict.wallet.holderRecord === false && qa.hook.rules.strict.wallet.opensHolderRecord === true && BigInt(qa.hook.rules.strict.wallet.after) === mostOut(pa, sol(0.05)) && BigInt(qa.hook.rules.strict.wallet.after) > BigInt(qa.outAmount) && qa.hook.rules.strict.wallet.locked === qa.hook.rules.strict.wallet.after
    && qa.notes.some((n) => n.startsWith("The receiving wallet has no holder record. /api/v1/swap opens it in front of the buy")) && qa.notes.some((n) => n.startsWith("After this buy the receiving wallet holds up to ")) && qa.notes.some((n) => n.startsWith("The coins of this buy, up to ")),
    "a quote with userPublicKey says what A's coins will be at most, the sniper fee falling: " + JSON.stringify(qa.hook.rules.strict.wallet));
  const buyA = await trade("strict", made.address, A, "buy", sol(0.05), { runningGuard: true });
  say(buyA, " (inside the sniper window: the chain gives the quote or more)");
  check(BigInt(buyA.wallet) <= BigInt(qa.hook.rules.strict.wallet.after), `A received ${buyA.wallet} raw units, no more than the most the quote said (${qa.hook.rules.strict.wallet.after})`);
  const recA = await holderOf(A.publicKey);
  check(buyA.kinds.includes("rules:open_holder") && buyA.kinds.indexOf("rules:open_holder") === buyA.kinds.indexOf("hookpool:swap") - 1 && buyA.sw.instructions.includes("open_holder"), "the transaction holds open_holder right before the swap: " + buyA.kinds.join(", "));
  check(!!recA && recA.balance === BigInt(buyA.wallet) && recA.earlyBought === BigInt(buyA.wallet), `A's holder record exists now, counts its ${recA && recA.balance} raw units, all of them bought early`);
  const extras = buyA.hookAccounts.map((m) => m.pubkey.toBase58() + (m.isWritable ? " w" : ""));
  check(extras.join(",") === [rulesPda.cfg(made.address).toBase58() + " w", rulesPda.holder(made.address, A.publicKey).toBase58() + " w", rulesPda.holder(made.address, made.address).toBase58() + " w", rulesPda.validation(made.baseMint).toBase58()].join(","),
    "the swap passes the strict coin's four accounts: the config, A's holder record, the pool's holder address, the coin's account list");

  // A sells in the early lock: refused by the API, and by the chain
  const sellA = { mint, side: "sell", amount: String(BigInt(buyA.wallet) / 2n), userPublicKey: A.publicKey.toBase58() };
  for (const [name, r] of [["/quote", await getQuote(sellA)], ["/swap", await postSwap(sellA)]]) {
    const e = errOf(r);
    check(r.status === 422 && e && e.code === "EARLY_LOCKED" && e.locked === buyA.wallet && e.free === "0" && e.unlockSlot === Number(start + UNLOCK), `${name}: 422 ${e && e.code}, locked ${e && e.locked}, free ${e && e.free}, unlock slot ${e && e.unlockSlot}: ${e && e.message}`);
  }
  const byHandA = await sendRefused(conn, await client.swapInstructions(A.publicKey, made, await client.hookRef(made, A.publicKey), DIRECTION.SELL, BigInt(buyA.wallet) / 2n, 0n), [A], "the same sell sent to the chain without the API");
  check(/Error Code: EarlyLocked\. Error Number: 6045/.test(byHandA) && explainSimulationError({ InstructionError: [3, { Custom: 6045 }] }, byHandA.split("\n")).code === "EARLY_LOCKED", "the chain refuses it: EarlyLocked (6045), which the API words as EARLY_LOCKED");

  // a buy for another wallet that has no record, in the early window
  const forC = await postSwap({ mint, side: "buy", amount: String(sol(0.01)), userPublicKey: B.publicKey.toBase58(), recipient: C.publicKey.toBase58() });
  check(forC.status === 422 && errOf(forC).code === "HOLDER_RECORD_REQUIRED" && errOf(forC).recipient === C.publicKey.toBase58() && errOf(forC).endsAtSlot === Number(start + EARLY), "a buy for a recipient without a holder record: 422 HOLDER_RECORD_REQUIRED: " + errOf(forC).message);
  const noRecord = (await client.swapInstructions(D.publicKey, made, await client.hookRef(made, D.publicKey), DIRECTION.BUY, sol(0.01), 0n)).filter((i) => !i.programId.equals(PROGRAMS.hook_rules));
  const byHandD = await sendRefused(conn, noRecord, [D], "a buy in the early window by a wallet without a record, open_holder left out, sent to the chain");
  check(/Error Code: HolderRecordRequired\. Error Number: 6047/.test(byHandD), "the chain holds the same rule for the receiving wallet: HolderRecordRequired (6047)");

  // B and the max wallet, inside the sniper window: the largest buy is sized at the pool's own fee, the most the
  // window can pay out, so it lands whatever slot it lands in
  const bigB = { mint, side: "buy", amount: String(sol(1)), userPublicKey: B.publicKey.toBase58() };
  const rq = await getQuote(bigB); const rs = await postSwap(bigB);
  const eq = errOf(rq);
  for (const [name, r] of [["/quote", rq], ["/swap", rs]]) {
    const e = errOf(r);
    check(r.status === 422 && e && e.code === "MAX_WALLET_EXCEEDED" && e.maxWallet === cap.toString() && e.walletBalance === "0" && e.room === cap.toString() && BigInt(e.maxAmount) > 0n && e.endsAtSlot === Number(start + MAXW)
      && /would give it up to /.test(e.message) && e.message.endsWith("The sniper fee falls every slot, so the check counts the most a buy can give, at the pool's normal fee."),
      `${name}: a buy of 1 SOL by B: 422 ${e && e.code}, room ${e && e.room}, largest buy ${e && e.maxAmount} lamports: ${e && e.message}`);
  }
  const byHandB = await sendRefused(conn, await client.swapInstructions(B.publicKey, made, await client.hookRef(made, B.publicKey), DIRECTION.BUY, sol(1), 0n), [B], "the same buy sent to the chain without the API");
  check(/Error Code: MaxWallet\. Error Number: 6044/.test(byHandB), "the chain refuses it: MaxWallet (6044)");
  const maxAmount = BigInt(eq.maxAmount);
  const pb = await client.pool(made.address);
  check(mostOut(pb, maxAmount) <= cap && mostOut(pb, maxAmount + 1n) > cap, `maxAmount ${maxAmount} is the largest buy whose coins fit at the pool's own fee (${mostOut(pb, maxAmount)} of ${cap} raw units); one lamport more passes the cap once the sniper fee is gone`);
  const over = await getQuote({ mint, side: "buy", amount: String(maxAmount + 1000n), userPublicKey: B.publicKey.toBase58() });
  check(over.status === 422 && errOf(over).code === "MAX_WALLET_EXCEEDED", `a buy 1000 lamports above the largest one is refused too`);
  const buyB = await trade("strict", made.address, B, "buy", maxAmount, { runningGuard: true });
  say(buyB, " (the largest buy the API named, inside the sniper window)");
  check(BigInt(buyB.wallet) <= cap && BigInt(buyB.wallet) > BigInt(buyB.quote), `B holds ${buyB.wallet} raw units, ${cap - BigInt(buyB.wallet)} under the cap of ${cap}: more than the quote of the read slot (${buyB.quote}), as the fee fell, and never above the cap`);

  // the sniper fee is over, the max wallet still runs: the largest buy is exact and lands at the cap
  await waitForSlot(conn, start + SNIPER + 1n);
  const again = errOf(await getQuote(bigB));
  check(!!again && again.code === "MAX_WALLET_EXCEEDED" && again.walletBalance === buyB.wallet && !/up to/.test(again.message) && BigInt(again.maxAmount) > 0n, `after the sniper window: B holds ${again && again.walletBalance}, room ${again && again.room}, largest buy ${again && again.maxAmount} lamports: ${again && again.message}`);
  const buyB2 = await trade("strict", made.address, B, "buy", BigInt(again.maxAmount));
  say(buyB2, " (the largest buy the API named, exact)");
  const heldB = await client.tokenBalance(B.publicKey, made.baseMint, TOKEN_2022_PROGRAM);
  check(BigInt(buyB2.wallet) <= BigInt(again.room) && heldB <= cap && cap - heldB < heldB / 1000n, `B holds ${heldB} raw units, ${cap - heldB} under the cap of ${cap}: the room of ${again.room} was filled to within one lamport's worth of coins`);
  // a non-zero maxAmount always lands, down to the last quotable buy; then nothing more fits
  for (let round = 1; ; round++) {
    const more = errOf(await getQuote({ mint, side: "buy", amount: String(sol(0.01)), userPublicKey: B.publicKey.toBase58() }));
    check(!!more && more.code === "MAX_WALLET_EXCEEDED" && more.walletBalance === (await client.tokenBalance(B.publicKey, made.baseMint, TOKEN_2022_PROGRAM)).toString(), `B is at the cap: one more buy of 0.01 SOL is refused, and the error counts B's coins: ${more && more.room} raw units of room, largest buy ${more && more.maxAmount} lamports`);
    if (more.maxAmount === "0") { check(more.message.endsWith("It can buy nothing more until then."), "no quotable buy fits in the room left: maxAmount is 0 and the message says so"); break; }
    check(round <= 3, "the room closes within three buys");
    say(await trade("strict", made.address, B, "buy", BigInt(more.maxAmount)), ` (round ${round}: the tiny largest buy the API named lands)`);
  }

  // after the early unlock: A's early coins move
  await waitForSlot(conn, start + UNLOCK + 1n);
  const qs = (await okQuote({ mint, side: "sell", amount: buyA.wallet, userPublicKey: A.publicKey.toBase58() })).json;
  check(qs.hook.rules.strict.wallet.locked === "0" && !qs.notes.some((n) => /cannot be sold before/.test(n)), "after the early unlock a quote of A's sell holds no lock");
  const sellAll = await trade("strict", made.address, A, "sell", BigInt(buyA.wallet));
  say(sellAll, " (A's early coins, after the unlock)");

  // the creator's coins are locked in its own wallet
  const devCoins = await client.tokenBalance(dev.publicKey, made.baseMint, TOKEN_2022_PROGRAM);
  const sellDev = { mint, side: "sell", amount: String(devCoins / 2n), userPublicKey: dev.publicKey.toBase58() };
  const lock = await client.rulesLock(made.address);
  for (const [name, r] of [["/quote", await getQuote(sellDev)], ["/swap", await postSwap(sellDev)]]) {
    const e = errOf(r);
    check(r.status === 422 && e && e.code === "CREATOR_LOCKED" && e.locked === devCoins.toString() && e.free === "0" && e.unlockAt === Number(lock.unlockAt), `${name}: the creator sells half its coins: 422 ${e && e.code}, locked ${e && e.locked} until ${e && e.unlockAt}: ${e && e.message}`);
  }
  const byHandDev = await sendRefused(conn, await client.swapInstructions(dev.publicKey, made, await client.hookRef(made, dev.publicKey), DIRECTION.SELL, devCoins / 2n, 0n), [dev], "the same sell sent to the chain without the API");
  check(/Error Code: CreatorLocked\. Error Number: 6046/.test(byHandDev), "the chain refuses it: CreatorLocked (6046)");

  // after the max wallet: a quote outside every window
  await waitForSlot(conn, start + MAXW + 1n);
  const qb = (await okQuote({ mint, side: "buy", amount: String(sol(0.5)), userPublicKey: B.publicKey.toBase58() })).json;
  check(qb.exact && qb.hook.rules.strict.wallet.holderRecord === true && qb.hook.rules.strict.wallet.opensHolderRecord === false && qb.hook.rules.strict.wallet.locked === "0"
    && !qb.notes.some((n) => /max wallet is running|are early coins|under the cap/.test(n)) && qb.notes.includes("The receiving wallet has a holder record, so its coins earn a part of the holders' share."),
    "outside the windows a buy of 0.5 SOL by B, above the old cap, is quoted; the notes keep only what still holds: " + JSON.stringify(qb.notes.slice(4)));
  const late = await trade("strict", made.address, B, "buy", sol(0.5));
  say(late, " (above the old cap, after the max wallet)");
  check(!late.kinds.includes("rules:open_holder"), "B has a record already: no open_holder in front");
  say(await trade("strict", made.address, B, "sell", await client.tokenBalance(B.publicKey, made.baseMint, TOKEN_2022_PROGRAM)), " (everything B holds)");
  // the rent the notes name is the chain's rent of a holder record (129 bytes), read from the chain, never a constant:
  // on this local validator the SDK's documented local number (1788720), on mainnet 1305560
  const holderRent = (await col.rentFrom(conn))(HOLDER_RECORD_SIZE);
  check(qa.notes.some((n) => n.includes("The record's rent, " + holderRent + " lamports, is paid by the wallet that signs")), "the record's rent the notes name is the chain's rent of 129 bytes: " + holderRent + " lamports" + (cluster === "localnet" ? " (the SDK's local number, " + HOLDER_RECORD_RENT + ")" : ""));
}

// ---- a coin on the curve --------------------------------------------------------------------------------
// A launch that needs no SOL from its creator: the whole supply goes into the pool, which prices trades with
// the platform's virtual SOL, pays out real SOL only, and graduates once it holds the platform's target of
// real SOL. The price of a pool is (reserveQuote + virtualQuote) / reserveBase, written here by hand.

const chainPrice = (p) => ratioDecimal((p.reserveQuote + p.virtualQuote) * 10n ** 6n, p.reserveBase * 10n ** 9n);
const closeTo = (a, b) => Math.abs(Number(a) / Number(b) - 1) < 1e-9;
async function launchCurveCoin(symbol, name, extra, label) {
  const dev = await newWallet(1);
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name, symbol, uri: "https://example.com/meta/" + symbol.toLowerCase() + ".json", decimals: 6, totalSupply: RULES_SUPPLY,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, curve: true, devBuyQuote: 0n, minDevBuyOut: 0n, template: "none", ...extra,
  });
  await sendV0(conn, client, plan.createTx, [dev, mint], label + ": the coin");
  await sendV0(conn, client, plan.launchTx, [dev], label + ": the pool on the curve, no SOL from the creator");
  return { dev, pool: await client.pool(plan.pool), plan };
}

head("a coin on the curve: quotes and trades while it is open, the buy that graduates it, trades after");
{
  check(platform.curveEnabled, `the platform has curve launches on: ${platform.curveVirtualQuote} lamports of virtual SOL, graduation at ${platform.curveGraduationTarget} lamports, fee ${platform.curveGraduationFeeBps} bps`);
  const { pool: made } = await launchCurveCoin("ACV", "API Curve Test", {}, "launch a coin on the curve");
  check(made.curveState === CURVE_OPEN && made.reserveQuote === 0n && made.reserveBase === RULES_SUPPLY && made.virtualQuote === platform.curveVirtualQuote,
    `the pool opens on the curve with the whole supply and no real SOL: ${made.address.toBase58()}`);
  const mint = made.baseMint.toBase58();
  const V = made.virtualQuote; const TARGET = made.graduationTarget;
  const w = await newWallet(110);

  // the first buy: the curve part says where the pool stands, the prices count the virtual SOL
  const first = await trade("curve_open", made.address, w, "buy", sol(1));
  say(first);
  const c1 = first.q.curve;
  check(c1.state === "open" && c1.virtualQuote === V.toString() && c1.raised === "0" && c1.target === TARGET.toString() && c1.raisedBps === 0 && c1.soldBps === 0 && c1.graduates === false && !("amountOutIfGraduated" in c1),
    "the quote's curve part as the chain holds the pool: " + JSON.stringify(c1));
  const p1 = await client.pool(made.address);
  check(first.q.priceBefore === chainPrice(made) && first.sw.quote.priceAfter === chainPrice(p1), `the API's prices are the chain's, virtual SOL in: ${first.q.priceBefore} before, ${first.sw.quote.priceAfter} after (the pool reads ${chainPrice(p1)})`);
  check(first.q.notes[0] === "This coin trades on the curve. Its price counts " + Number(V) / 1e9 + " SOL of virtual SOL that the pool does not hold." && first.q.notes[1] === "The pool holds 0 SOL of real SOL. It graduates at " + Number(TARGET) / 1e9 + " SOL.",
    "the notes say it in words: " + JSON.stringify(first.q.notes));
  const supply = (await client.mint(made.baseMint)).supply;
  const q2 = (await okQuote({ mint, side: "buy", amount: String(sol(0.1)) })).json;
  check(q2.curve.raised === p1.reserveQuote.toString() && q2.curve.raisedBps === Number((p1.reserveQuote * 10_000n) / TARGET) && q2.curve.soldBps === Number(((supply - p1.reserveBase) * 10_000n) / supply),
    `after the buy: ${q2.curve.raised} lamports raised (${q2.curve.raisedBps} bps of the target), ${q2.curve.soldBps} bps of the supply sold, as the chain says`);

  // a sell of more than the real SOL can pay: refused in words by both calls, with the largest sell it pays
  const held = BigInt(first.wallet);
  const tooMuch = { mint, side: "sell", amount: String(held * 20n) };
  const rq = await getQuote(tooMuch);
  const rs = await postSwap({ ...tooMuch, userPublicKey: w.publicKey.toBase58() });
  for (const [name, r] of [["/quote", rq], ["/swap", rs]]) {
    const e = r.json && r.json.error;
    check(r.status === 422 && !!e && e.code === "CURVE_REAL_RESERVE" && e.realReserve === p1.reserveQuote.toString() && BigInt(e.maxAmount) > 0n && Object.keys(r.json).length === 1,
      `${name} refuses a sell of ${held * 20n} raw units, twenty times what came out of the pool: 422 ${e ? e.code : r.text}, real reserve ${e && e.realReserve}, largest sell ${e && e.maxAmount}: ${e && e.message}`);
  }
  const maxSell = BigInt(rq.json.error.maxAmount);
  const atMax = await getQuote({ mint, side: "sell", amount: maxSell.toString() });
  const overMax = await getQuote({ mint, side: "sell", amount: (maxSell + 1n).toString() });
  check(atMax.status === 200 && BigInt(atMax.json.outAmount) <= p1.reserveQuote && overMax.status === 422 && overMax.json.error.code === "CURVE_REAL_RESERVE",
    `a sell of maxAmount is quoted (${atMax.json.outAmount} lamports of the ${p1.reserveQuote} real), one unit more is refused. No wallet can hold that many: only ${held} raw units ever left the pool`);

  // a sell, paid from the real SOL
  const back = await trade("curve_open", made.address, w, "sell", held / 2n);
  say(back);
  check(back.ev.amountOut <= p1.reserveQuote && back.q.notes[1].endsWith("A sell is paid from the real SOL only."), `the sell was paid ${back.ev.amountOut} of the ${p1.reserveQuote} lamports of real SOL`);

  // up to 80 SOL of real SOL: still on the curve
  const p2 = await client.pool(made.address);
  const toEighty = ((sol(80) - p2.reserveQuote) * 10_000n) / BigInt(10_000 - platform.protocolFeeBps);
  const big = await trade("curve_open", made.address, w, "buy", toEighty);
  say(big);
  const p3 = await client.pool(made.address);
  check(big.sw.quote.curve.graduates === false && !big.kinds.includes("hookpool:graduate") && p3.curveState === CURVE_OPEN && p3.reserveQuote < TARGET,
    `a buy of ${toEighty} lamports leaves ${p3.reserveQuote} lamports of real SOL in the pool, under the target: no graduate`);

  // the buy that crosses the target: the transaction graduates the coin
  const crossing = (await okQuote({ mint, side: "buy", amount: String(sol(10)) })).json;
  check(crossing.curve.graduates === true && crossing.curve.graduateFirst === false && !("amountOutIfGraduated" in crossing.curve) && BigInt(crossing.minOutAmount) === (BigInt(crossing.outAmount) * 9900n) / 10000n && crossing.exact === true,
    `a buy of 10 SOL takes the pool past its target: graduates; under the target nobody can graduate it first without moving the price, so the floor is the usual one: ${crossing.minOutAmount} of ${crossing.outAmount}`);
  const supplyBefore = (await client.mint(made.baseMint)).supply;
  const cross = await trade("curve_graduates", made.address, w, "buy", sol(10));
  say(cross, " (the transaction ends with graduate)");
  check(cross.kinds.indexOf("hookpool:graduate") === cross.kinds.indexOf("hookpool:swap") + 1 && cross.sw.instructions.join(" ").includes("swap graduate") && cross.sw.computeUnitLimit === 275000,
    `the transaction holds graduate right after the swap: ${cross.sw.instructions.join(", ")}; compute limit ${cross.sw.computeUnitLimit}, ${cross.cu} used`);
  const got = await fetchTx(cross.sig);
  const grad = eventsFromTransaction(got, OUR).find((e) => e.kind === "Graduated");
  const p4 = await client.pool(made.address);
  check(!!grad && grad.pool.equals(made.address) && p4.curveState === CURVE_GRADUATED && p4.virtualQuote === 0n && p4.graduationTarget === 0n,
    `the chain graduated the coin in that transaction: the Graduated event is there, the pool is graduated, its virtual SOL is gone`);
  // the burn, by hand: the fee out of the real reserve, the base reserve that keeps the price
  const wanted = (TARGET * BigInt(made.graduationFeeBps)) / 10_000n;
  const fee = wanted < grad.reserveQuoteBefore - 1n ? wanted : grad.reserveQuoteBefore - 1n;
  const keptBase = ((grad.reserveQuoteBefore - fee) * grad.reserveBaseBefore) / (grad.reserveQuoteBefore + V);
  check(grad.reserveQuoteBefore === cross.ev.reserveQuote && grad.reserveBaseBefore === cross.ev.reserveBase && grad.burnedBase === grad.reserveBaseBefore - keptBase && grad.reserveBaseAfter === keptBase && p4.reserveBase === keptBase && p4.reserveQuote === grad.reserveQuoteBefore - fee,
    `the burn by hand: ${grad.burnedBase} raw units of the ${grad.reserveBaseBefore} the trade left, fee ${fee}; the pool holds ${p4.reserveQuote} lamports and ${p4.reserveBase} raw units`);
  const supplyAfter = (await client.mint(made.baseMint)).supply;
  check(supplyBefore - supplyAfter === grad.burnedBase, `the coin's supply fell by the burn: ${supplyBefore} to ${supplyAfter}`);
  check(cross.q.priceBefore === chainPrice(p3) && closeTo(cross.sw.quote.priceAfter, chainPrice(p4)),
    `the API's price before is the chain's (${cross.q.priceBefore}); its price after the trade, ${cross.sw.quote.priceAfter}, is the graduated pool's (${chainPrice(p4)}): graduation kept it`);

  // trades on the graduated pool: an ordinary pool now, quoted to the unit
  const gq = (await okQuote({ mint, side: "buy", amount: String(sol(0.2)) })).json;
  check(gq.curve.state === "graduated" && gq.curve.virtualQuote === "0" && gq.curve.target === "0" && gq.curve.raisedBps === 10000 && gq.curve.raised === p4.reserveQuote.toString() && gq.curve.graduates === false && gq.notes.length === 0 && gq.priceBefore === chainPrice(p4),
    "a quote on the graduated pool: " + JSON.stringify(gq.curve));
  const after = await trade("curve_graduated", made.address, w, "buy", sol(0.2));
  say(after);
  const all = await client.tokenBalance(w.publicKey, made.baseMint);
  const out = await trade("curve_graduated", made.address, w, "sell", all);
  say(out, " (everything the wallet held, sold on the graduated pool)");
  check(!after.kinds.includes("hookpool:graduate") && !out.kinds.includes("hookpool:graduate"), "no graduate after graduation");
}

head("coins on the curve left past their target: the API's trade graduates the pool first and is quoted on the graduated pool, whoever graduates it");
{
  /// A coin on the curve bought past its target with a swap built without graduate, the way a trade built
  /// without the SDK would leave it.
  async function pastTarget(symbol, name) {
    const { pool: made } = await launchCurveCoin(symbol, name, {}, "launch a coin on the curve (" + symbol + ")");
    const w = await newWallet(100);
    const past = ((made.graduationTarget + sol(1)) * 10_000n) / BigInt(10_000 - platform.protocolFeeBps);
    const ql = await client.quoteLocal(made, platform, DIRECTION.BUY, past);
    await sendV0(conn, client, await client.swapInstructions(w.publicKey, made, await client.hookRef(made, w.publicKey), DIRECTION.BUY, past, (ql.amountOut * 99n) / 100n, { graduate: false }), [w], symbol + ": a buy past the target, no graduate (SDK, graduate: false)");
    const p = await client.pool(made.address);
    check(p.curveState === CURVE_OPEN && p.reserveQuote >= p.graduationTarget, `${symbol}: the pool stands past its target and is still on the curve: ${p.reserveQuote} lamports of real SOL`);
    return { p, w, mint: made.baseMint.toBase58() };
  }
  const PAST_NOTE = "The pool stands past its graduation target, so this transaction graduates it before the trade. The trade runs on the graduated pool, whoever graduates it first, and this quote is that pool's.";

  // 1. nobody else: the API's own transaction graduates the pool, then trades on it
  {
    const { p, w, mint } = await pastTarget("ACP", "API Curve Past");
    // a sell large enough to take the pool back under its target, quoted: the pool graduates first, so it is a
    // sell on the graduated pool, exact, with the usual floor
    const back = (await okQuote({ mint, side: "sell", amount: String((await client.tokenBalance(w.publicKey, p.baseMint)) / 4n) })).json;
    check(back.curve.graduates === true && back.curve.graduateFirst === true && back.exact === true && BigInt(back.minOutAmount) === (BigInt(back.outAmount) * 9900n) / 10000n && back.notes.includes(PAST_NOTE),
      `a sell that would take the pool back under its target: it graduates the pool first and is quoted on the graduated pool, exact, floor ${back.minOutAmount} of ${back.outAmount}`);
    const buy = await trade("curve_past", p.address, w, "buy", sol(1));
    say(buy, " (graduate first, then the swap)");
    const got = await fetchTx(buy.sig);
    const grad = eventsFromTransaction(got, OUR).find((e) => e.kind === "Graduated");
    const priceAtGraduation = ratioDecimal(grad.reserveQuoteAfter * 10n ** 6n, grad.reserveBaseAfter * 10n ** 9n);
    check(buy.kinds.indexOf("hookpool:graduate") === buy.kinds.indexOf("hookpool:swap") - 1 && !!grad && grad.reserveQuoteBefore === p.reserveQuote && (await client.pool(p.address)).curveState === CURVE_GRADUATED,
      `the transaction holds graduate right before the swap (${buy.kinds.join(", ")}) and graduated the coin itself: the Graduated event is in it`);
    check(BigInt(buy.wallet) === BigInt(buy.sw.quote.outAmount) && buy.sw.quote.priceBefore === priceAtGraduation && buy.sw.quote.exact === true && BigInt(buy.sw.quote.minOutAmount) === (BigInt(buy.sw.quote.outAmount) * 9900n) / 10000n,
      `the quote was the graduated pool's: the wallet received ${buy.wallet}, the quote to the unit; its price before, ${buy.sw.quote.priceBefore}, is the pool's right after graduate; the floor is the slippage on it`);
    say(await trade("curve_graduated", p.address, w, "sell", await client.tokenBalance(w.publicKey, p.baseMint)), " (everything the wallet held, sold on the graduated pool)");
  }

  // 2. somebody graduates the pool between the API's answer and the landing: the trade fills the same
  {
    const { p, w, mint } = await pastTarget("ACQ", "API Curve Race");
    const sw = (await okSwap({ mint, side: "buy", amount: String(sol(1)), userPublicKey: w.publicKey.toBase58(), simulate: true })).json;
    const qc = sw.quote.curve;
    check(sw.quote.exact === true && qc.graduates === true && qc.graduateFirst === true && qc.raisedBps === 10000 && !("amountOutIfGraduated" in qc) && BigInt(sw.quote.minOutAmount) === (BigInt(sw.quote.outAmount) * 9900n) / 10000n
      && sw.instructions.join(" ").includes("graduate swap") && sw.simulation.outAmount === sw.quote.outAmount,
      `past the target the quote is the graduated pool's and exact: ${sw.quote.outAmount}, floor ${sw.quote.minOutAmount}, the slippage on it; the transaction sends graduate right before the swap`);
    const seen = await inspect(sw, w.publicKey);
    await sendV0(conn, client, client.graduateInstructions(p), [w], "somebody else sends graduate first");
    check((await client.pool(p.address)).curveState === CURVE_GRADUATED, "the coin graduated before the API's transaction landed");
    const coins0 = await client.tokenBalance(w.publicKey, p.baseMint);
    const { err, got } = await land(seen.tx, w, sw);
    const ev = got && eventsFromTransaction(got, OUR).find((e) => e.kind === "Swapped");
    const coins1 = await client.tokenBalance(w.publicKey, p.baseMint);
    check(!err && !!ev && ev.amountOut === BigInt(sw.quote.outAmount) && coins1 - coins0 === ev.amountOut && !eventsFromTransaction(got, OUR).some((e) => e.kind === "Graduated"),
      `the API's transaction landed all the same and filled ${ev && ev.amountOut} raw units: the quote, to the unit. Its graduate changed nothing`);
    say(await trade("curve_graduated", p.address, w, "sell", await client.tokenBalance(w.publicKey, p.baseMint)), " (everything the wallet held, sold on the graduated pool)");
  }
}

head("a strict coin on the curve: max wallet 3% for 300 slots, early window 75 slots, early unlock at 150, a creator lock");
{
  const EARLY = 75n; const UNLOCK = 150n; const MAXW = 300n;
  const dev = await newWallet(1);
  const mintKp = Keypair.generate();
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint: mintKp, name: "API Strict Curve", symbol: "ASC", uri: "https://example.com/meta/asc.json", decimals: 6, totalSupply: RULES_SUPPLY,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, curve: true, devBuyQuote: sol(0.01), minDevBuyOut: 0n, template: "rules",
    rules: {
      buy: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, sell: { creatorBps: 50, holdersBps: 100, burnBps: 50 }, creatorLockSeconds: 600, lockMarginSeconds: 120,
      strict: { maxWalletBps: 300, maxWalletSlots: Number(MAXW), earlySlots: Number(EARLY), earlyUnlockSlots: Number(UNLOCK) },
    },
  });
  await sendV0(conn, client, plan.createTx, [dev, mintKp], "launch a strict coin on the curve: the coin, its rules, the launcher's holder record");
  await sendV0(conn, client, plan.launchTx, [dev], "launch a strict coin on the curve: the pool, the first buy, the creator lock");
  const made = await client.pool(plan.pool);
  const mint = made.baseMint.toBase58();
  const c = (await client.rulesState(made.address)).config;
  const start = c.startSlot; const cap = c.maxWalletAmount;
  check(made.curveState === CURVE_OPEN && c.kind === RULES_KIND.STRICT && made.baseTokenProgram.equals(TOKEN_2022_PROGRAM), `a strict coin in Token-2022 on the curve, pool created in slot ${start}, max wallet ${cap} raw units`);
  const errOf = (r) => (r.json && r.json.error ? r.json.error : null);
  const A = await newWallet(2); const B = await newWallet(3);
  const C = Keypair.generate();

  // a quote names the windows and the curve together
  const q0 = (await okQuote({ mint, side: "buy", amount: String(sol(0.05)) })).json;
  check(q0.exact === true && q0.curve.state === "open" && q0.hook.rules.strict && q0.hook.rules.strict.maxWallet === cap.toString() && q0.notes.includes("This is a strict coin. Its rules run inside every transfer of the coin, not only in this pool.") && q0.notes.some((n) => n.startsWith("This coin trades on the curve.")),
    "a quote on the strict coin names its windows and the curve: " + JSON.stringify(q0.curve));
  // A's first buy opens its holder record in front of the swap
  const buyA = await trade("strict_curve", made.address, A, "buy", sol(0.05));
  say(buyA);
  check(buyA.kinds.indexOf("rules:open_holder") === buyA.kinds.indexOf("hookpool:swap") - 1, "the transaction holds open_holder right before the swap: " + buyA.kinds.join(", "));
  // the early lock
  const sellA = { mint, side: "sell", amount: String(BigInt(buyA.wallet) / 2n), userPublicKey: A.publicKey.toBase58() };
  for (const [name, r] of [["/quote", await getQuote(sellA)], ["/swap", await postSwap(sellA)]]) {
    const e = errOf(r);
    check(r.status === 422 && e && e.code === "EARLY_LOCKED" && e.locked === buyA.wallet && e.free === "0" && e.unlockSlot === Number(start + UNLOCK), `${name}: A sells in the early lock: 422 ${e && e.code}: ${e && e.message}`);
  }
  const byHandA = await sendRefused(conn, await client.swapInstructions(A.publicKey, made, await client.hookRef(made, A.publicKey), DIRECTION.SELL, BigInt(buyA.wallet) / 2n, 0n, { graduate: false }), [A], "the same sell sent to the chain without the API");
  check(/Error Code: EarlyLocked\. Error Number: 6045/.test(byHandA), "the chain refuses it the same way: EarlyLocked (6045)");
  // a buy for a wallet without a record, in the early window
  const forC = await postSwap({ mint, side: "buy", amount: String(sol(0.01)), userPublicKey: B.publicKey.toBase58(), recipient: C.publicKey.toBase58() });
  check(forC.status === 422 && errOf(forC).code === "HOLDER_RECORD_REQUIRED" && errOf(forC).endsAtSlot === Number(start + EARLY), "a buy for a recipient without a holder record: 422 HOLDER_RECORD_REQUIRED: " + (errOf(forC) && errOf(forC).message));
  // the max wallet, judged on the curve's price
  const bigB = { mint, side: "buy", amount: String(sol(2)), userPublicKey: B.publicKey.toBase58() };
  const rq = await getQuote(bigB); const rs = await postSwap(bigB);
  for (const [name, r] of [["/quote", rq], ["/swap", rs]]) {
    const e = errOf(r);
    check(r.status === 422 && e && e.code === "MAX_WALLET_EXCEEDED" && e.maxWallet === cap.toString() && BigInt(e.maxAmount) > 0n && e.endsAtSlot === Number(start + MAXW), `${name}: a buy of 2 SOL by B: 422 ${e && e.code}, largest buy ${e && e.maxAmount} lamports`);
  }
  const ceilFee = (amount, bps) => (bps === 0 ? 0n : (amount * BigInt(bps) + 9999n) / 10000n);
  const mostOut = (pool, amount) => {
    const protocol = ceilFee(amount, platform.protocolFeeBps); const hookIn = ceilFee(amount - protocol, Math.min(rulesRatesTotal(c.buy), platform.maxHookFeeBps)); const lp = ceilFee(amount - protocol - hookIn, pool.lpFeeBps);
    const net = amount - protocol - hookIn - lp;
    return (pool.reserveBase * net) / (pool.reserveQuote + pool.virtualQuote + net);
  };
  const maxAmount = BigInt(errOf(rq).maxAmount);
  const pb = await client.pool(made.address);
  check(mostOut(pb, maxAmount) <= cap && mostOut(pb, maxAmount + 1n) > cap, `maxAmount ${maxAmount} is the largest buy whose coins fit, on the curve's price with the virtual SOL in (by hand: ${mostOut(pb, maxAmount)} of ${cap} raw units)`);
  const buyB = await trade("strict_curve", made.address, B, "buy", maxAmount);
  say(buyB, " (the largest buy the API named)");
  check(BigInt(buyB.wallet) <= cap && cap - BigInt(buyB.wallet) < cap / 1000n, `B holds ${buyB.wallet} raw units, ${cap - BigInt(buyB.wallet)} under the cap`);
  // after the early unlock: the creator's coins are still locked
  await waitForSlot(conn, start + UNLOCK + 1n);
  const devCoins = await client.tokenBalance(dev.publicKey, made.baseMint, TOKEN_2022_PROGRAM);
  const sellDev = { mint, side: "sell", amount: String(devCoins / 2n), userPublicKey: dev.publicKey.toBase58() };
  for (const [name, r] of [["/quote", await getQuote(sellDev)], ["/swap", await postSwap(sellDev)]]) {
    const e = errOf(r);
    check(r.status === 422 && e && e.code === "CREATOR_LOCKED" && e.locked === devCoins.toString() && e.free === "0", `${name}: the creator sells half its coins: 422 ${e && e.code}: ${e && e.message}`);
  }
  // A's early coins move now, and B sells everything
  say(await trade("strict_curve", made.address, A, "sell", BigInt(buyA.wallet)), " (A's early coins, after the unlock)");
  say(await trade("strict_curve", made.address, B, "sell", await client.tokenBalance(B.publicKey, made.baseMint, TOKEN_2022_PROGRAM)), " (everything B holds)");
  check((await client.pool(made.address)).curveState === CURVE_OPEN, "the strict coin is still on the curve: nothing here graduates it");
}

// ---- collectible coins --------------------------------------------------------------------------------

async function burnedAsset(address) { const a = await conn.getAccountInfo(address); return !!a && a.data.length === 1 && a.data[0] === 0; }
// a second server that has no lookup table, asked for the largest transactions on the way
const noTable = await startServer({ PROGRAMMABLE_LOOKUP_TABLE: "none" });
const noTableSeen = [];
async function probeNoTable(label, body, withTableBytes) {
  const r = await postSwap(body, noTable.url);
  noTableSeen.push({ label, status: r.status, code: r.json && r.json.error ? r.json.error.code : null, message: r.json && r.json.error ? r.json.error.message : null, bytes: r.status === 200 ? Buffer.from(r.json.transaction, "base64").length : null, withTableBytes });
}
for (const kind of ["collectible", "pegged"]) {
  head(kind === "pegged" ? "a pegged collectible coin (Token-2022 with its own transfer hook)" : "a plain collectible coin");
  const pool = found[kind];
  const tp = kind === "pegged" ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  check(pool.baseTokenProgram.equals(tp), "the coin lives in " + (kind === "pegged" ? "Token-2022" : "the classic token program"));

  // a buy too small for a piece, and its sell: nothing but the swap moves SOL
  const a = await newWallet(2);
  await probeNoTable(`${kind} first buy`, { mint: pool.baseMint.toBase58(), side: "buy", amount: String(sol(0.02)), userPublicKey: a.publicKey.toBase58() });
  const small = await trade(kind, pool.address, a, "buy", sol(0.02));
  noTableSeen[noTableSeen.length - 1].withTableBytes = small.bytes;
  say(small);
  check(small.sw.quote.coin.collectible.kind === (kind === "pegged" ? "pegged" : "plain") && small.sw.quote.hook.template === "collectible" && small.sw.quote.hook.runsOnSells === (kind === "pegged"), `coin kind ${small.sw.quote.coin.collectible.kind}, hook runs on sells: ${small.sw.quote.hook.runsOnSells}`);
  check(small.kinds.includes("collectible:open_ticket") && small.notes.some((n) => n === "This buy earns no piece."), "the buy opens the ticket; notes: " + JSON.stringify(small.notes));
  const smallSell = await trade(kind, pool.address, a, "sell", BigInt(small.wallet));
  say(smallSell);
  check(smallSell.rentBack === 0n, "a sell that burns nothing moves no rent");

  // a buy that earns pieces
  const b = await newWallet(3);
  const big = await trade(kind, pool.address, b, "buy", sol(0.6));
  say(big);
  const t1 = await col.fetchTicket(conn, pool.address, b.publicKey);
  const earned = t1.pending;
  check(earned >= 1 && big.notes.some((n) => n === `This buy earns up to ${earned} piece${earned === 1 ? "." : "s."}`), `the buy earned ${earned} piece(s), as the notes said: ${JSON.stringify(big.notes)}`);
  // one approval: the buy carried the deposit for the NFTs, right after the swap, to the wallet's own ticket
  const md = big.sw.quote.mintDeposit;
  const held = await col.ticketDeposit(conn, pool.address, b.publicKey);
  // the deposit at the CHAIN's rent (the API reads it once an hour): on mainnet 3,638,520 lamports a piece on an open
  // collection, where the local validator's 6,960 a byte gave 4,426,240
  check(md && md.included === true && md.pieces === earned && BigInt(md.lamports) === col.mintDepositFor(await col.rentFrom(conn), await col.fetchCollectionConfig(conn, pool.address), earned), `the quote of the swap says the deposit, sized at the chain's rent: ${JSON.stringify(md)}`);
  check(big.sw.instructions.indexOf("mint_deposit") === big.sw.instructions.indexOf("swap") + 1 && held === BigInt(md.lamports), `the deposit came right after the swap and the ticket holds it: ${held} lamports above its rent`);
  check(big.notes.some((n) => n.startsWith(`The transaction adds a deposit of ${md.lamports} lamports`)), "the notes say so");
  // the opt-out: the same buy with mintDeposit false adds no deposit
  const c = await newWallet(3);
  const optOut = await trade(kind, pool.address, c, "buy", sol(0.6), { mintDeposit: false });
  say(optOut);
  check(!optOut.sw.instructions.includes("mint_deposit") && optOut.sw.quote.mintDeposit.included === false && (await col.ticketDeposit(conn, pool.address, c.publicKey)) === 0n, "with mintDeposit false the buy adds no deposit; notes: " + optOut.notes.find((n) => /mintDeposit/.test(n)));
  {
    const coinsC = await client.tokenBalance(c.publicKey, pool.baseMint, tp);
    await trade(kind, pool.address, c, "sell", coinsC);
  }
  // a second buy while pieces wait: the API must not mint them inside it
  const again = await trade(kind, pool.address, b, "buy", sol(0.02));
  say(again);
  check(!again.kinds.some((k) => k.startsWith("collectible:mint")) && again.notes.some((n) => /waiting from earlier buys/.test(n)), "a buy with pieces waiting holds no mint; note: " + again.notes.find((n) => /waiting/.test(n)));
  // no keeper runs here: the wallet mints its pieces itself, through the SDK (the coin page's "Mint N waiting"),
  // and its deposit pays first
  const t2 = await col.fetchTicket(conn, pool.address, b.publicKey);
  await waitPastSlot(t2.batches.filter((x) => x.pieces > 0).reduce((m, x) => (x.targetSlot > m ? x.targetSlot : m), 0n));
  const lamB = await lamportsOf(b.publicKey);
  const heldB = await col.ticketDeposit(conn, pool.address, b.publicKey);
  await sendV0(conn, client, await client.collectibleMintInstructions(b.publicKey, pool.address), [b], "mint the pieces (SDK, the wallet's own mint)");
  const t3 = await col.fetchTicket(conn, pool.address, b.publicKey);
  check(t3.owned.length >= 1 && t3.pending === 0, `the wallet holds ${t3.owned.length} minted piece(s)`);
  const paid = lamB - (await lamportsOf(b.publicKey));
  const usedB = heldB - (await col.ticketDeposit(conn, pool.address, b.publicKey));
  check(paid === 5000n && usedB > 0n, `the wallet's own mint took ${usedB} lamports from its deposit, the wallet paid only its signature (${paid})`);
  // what is left of the deposit goes back to the wallet
  const leftB = await col.ticketDeposit(conn, pool.address, b.publicKey);
  if (leftB > 0n) {
    const lw0 = await lamportsOf(b.publicKey);
    await sendV0(conn, client, await client.collectibleWithdrawInstructions(b.publicKey, pool.address), [b], "withdraw what is left of the deposit");
    check((await col.ticketDeposit(conn, pool.address, b.publicKey)) === 0n && (await lamportsOf(b.publicKey)) - lw0 === leftB - 5000n, `withdraw_deposit gave the wallet its ${leftB} lamports back`);
  }
  // sell everything: the pieces burn in the same transaction
  const coins = await client.tokenBalance(b.publicKey, pool.baseMint, tp);
  // first the same sell asked of the server without a table (not sent), then the real one
  await probeNoTable(`${kind} sell that burns ${t3.owned.length} pieces`, { mint: pool.baseMint.toBase58(), side: "sell", amount: coins.toString(), userPublicKey: b.publicKey.toBase58() });
  const sell = await trade(kind, pool.address, b, "sell", coins);
  noTableSeen[noTableSeen.length - 1].withTableBytes = sell.bytes;
  say(sell, `; rent of the burned pieces that came back: ${sell.rentBack} lamports`);
  const upkeep = kind === "pegged" ? "collectible:reap" : "collectible:settle";
  check(sell.kinds.includes(upkeep) && sell.notes.some((n) => n === `This sell burns ${t3.owned.length} piece${t3.owned.length === 1 ? "" : "s"} of the wallet.`), `the sell carries ${upkeep}; notes: ${JSON.stringify(sell.notes)}`);
  const t4 = await col.fetchTicket(conn, pool.address, b.publicKey);
  let gone = 0;
  for (const asset of t3.owned) if (await burnedAsset(asset)) gone++;
  check(t4.owned.length === 0 && gone === t3.owned.length && sell.rentBack > 0n, `${gone} of ${t3.owned.length} pieces burned in the sell, the wallet's list is empty`);
}

head("a wallet with eight pieces of a pegged coin: more burns than one transaction carries");
{
  const pool = found.pegged_small;
  const m = await newWallet(2);
  for (let round = 0; round < 2; round++) {
    const buy = await trade("pegged_small", pool.address, m, "buy", sol(0.02));
    say(buy);
    const t = await col.fetchTicket(conn, pool.address, m.publicKey);
    await waitPastSlot(t.batches.filter((x) => x.pieces > 0).reduce((a, x) => (x.targetSlot > a ? x.targetSlot : a), 0n));
    await sendV0(conn, client, await client.collectibleMintInstructions(m.publicKey, pool.address), [m], "mint 4 pieces (SDK, second transaction)");
  }
  const t = await col.fetchTicket(conn, pool.address, m.publicKey);
  check(t.owned.length === 8 && t.pending === 0, "the wallet holds 8 minted pieces");
  const coins = await client.tokenBalance(m.publicKey, pool.baseMint, TOKEN_2022_PROGRAM);
  await probeNoTable("pegged sell that burns 8 pieces (6 in the transaction)", { mint: pool.baseMint.toBase58(), side: "sell", amount: coins.toString(), userPublicKey: m.publicKey.toBase58() });
  const sell = await trade("pegged_small", pool.address, m, "sell", coins);
  noTableSeen[noTableSeen.length - 1].withTableBytes = sell.bytes;
  say(sell, `; rent that came back: ${sell.rentBack} lamports`);
  check(sell.notes.includes("This sell burns 8 pieces of the wallet.") && sell.notes.includes("The transaction burns 6 of them. The watcher burns the others within seconds."), "notes: " + JSON.stringify(sell.notes.slice(-2)));
  const left = await col.fetchQueue(conn, pool.address);
  const mine = left.filter((a) => t.owned.some((o) => o.equals(a)));
  check((await col.fetchTicket(conn, pool.address, m.publicKey)).owned.length === 0 && mine.length <= 2, `the wallet's list is empty; ${mine.length} of its pieces wait in the burn queue for their NFT to be burned`);
  // what the watcher does within seconds: burn the NFTs still in the queue
  for (const tx of await client.collectibleUpkeepInstructions(m.publicKey, pool.address)) await sendV0(conn, client, tx, [m], "upkeep (SDK): burn what is left in the queue");
  let gone = 0;
  for (const asset of t.owned) if (await burnedAsset(asset)) gone++;
  check(gone === 8, "all 8 pieces are burned");
}

// ---- a hook the platform did not write -----------------------------------------------------------------

if (found.custom) {
  head("a hook the platform did not write: the API asks the chain what the trade gives");
  const p = found.custom;
  const mint = p.baseMint.toBase58();
  const w = await newWallet(2);
  const ask = async (side, amount) => {
    const q = (await okQuote({ mint, side, amount: String(amount) })).json;
    // no simulate flag and the default slippage: what a bot sends when it knows nothing about the hook
    const sw = (await okSwap({ mint, side, amount: String(amount), userPublicKey: w.publicKey.toBase58() })).json;
    const seen = await inspect(sw, w.publicKey);
    const { err, got } = await land(seen.tx, w, sw);
    const ev = err ? null : eventsFromTransaction(got, OUR).find((e) => e.kind === "Swapped");
    return { q, sw, err, ev };
  };
  const buy = await ask("buy", sol(0.1));
  check(buy.q.hook.template === "custom" && buy.q.hook.kind === "frozen", `the quote names the hook: ${buy.q.hook.program}, frozen, not a platform template; exact: ${buy.q.exact}`);
  check(!buy.err && !!buy.ev, "the buy built by the API landed" + (buy.err ? ": " + JSON.stringify(buy.err) : ""));
  check(buy.ev.amountOut >= BigInt(buy.sw.quote.minOutAmount), `the chain paid ${buy.ev.amountOut}, the floor in the transaction was ${buy.sw.quote.minOutAmount}`);
  if (buy.q.exact) check(buy.ev.amountOut === BigInt(buy.q.outAmount), "this hook cannot change the amounts of a buy: the quote was exact, and the chain paid it");
  else check(buy.ev.amountOut === BigInt(buy.sw.quote.outAmount) && buy.sw.notes.some((n) => /simulation/.test(n)) && BigInt(buy.sw.quote.outAmount) <= BigInt(buy.q.outAmount),
    `the quote (${buy.q.outAmount}) assumed the hook takes nothing; /swap simulated and answered ${buy.sw.quote.outAmount}, which is what the chain paid; hook fee in the event: ${buy.ev.hookFee}`);
  // a caller that sends its own floor: the server still asks the chain, keeps the floor, and
  // refuses one the hook already puts out of reach instead of handing out a transaction that fails
  if (!buy.q.exact) {
    const plain = (await okQuote({ mint, side: "buy", amount: String(sol(0.1)), slippageBps: "0" })).json;
    const refused = await postSwap({ mint, side: "buy", amount: String(sol(0.1)), userPublicKey: w.publicKey.toBase58(), minOutAmount: plain.outAmount });
    check(refused.status === 422 && !!refused.json.error && refused.json.error.code === "SLIPPAGE_EXCEEDED", `a floor equal to the plain quote is refused: ${refused.json.error ? refused.json.error.message : refused.text}`);
    const low = ((BigInt(plain.outAmount) * 9000n) / 10000n).toString();
    const kept = (await okSwap({ mint, side: "buy", amount: String(sol(0.1)), userPublicKey: w.publicKey.toBase58(), minOutAmount: low })).json;
    check(kept.quote.minOutAmount === low && BigInt(kept.quote.outAmount) < BigInt(plain.outAmount) && kept.notes.some((n) => /minimum is the one you sent/.test(n)),
      `a lower floor of the caller's own is kept (${low}); the answer carries the simulated output ${kept.quote.outAmount}, not the plain quote ${plain.outAmount}`);
  }
  const sell = await ask("sell", buy.ev.amountOut);
  check(!sell.err && !!sell.ev && sell.ev.amountOut >= BigInt(sell.sw.quote.minOutAmount), "the sell built by the API landed above its floor" + (sell.err ? ": " + JSON.stringify(sell.err) : ""));
  if (sell.q.exact) check(sell.ev.amountOut === BigInt(sell.q.outAmount), `the hook cannot change the amounts of a sell: the quote was exact (${sell.q.outAmount}); note: ${sell.q.notes[sell.q.notes.length - 1]}`);
  else check(sell.ev.amountOut === BigInt(sell.sw.quote.outAmount) && sell.sw.notes.some((n) => /simulation/.test(n)),
    `/swap simulated the sell and answered ${sell.sw.quote.outAmount}, which is what the chain paid (the plain quote said ${sell.q.outAmount}); hook fee in the event: ${sell.ev.hookFee}`);
}

// ---- recipient ---------------------------------------------------------------------------------------

head("recipient: one wallet signs and pays, another receives");
{
  const pool = found.none;
  const signer = await newWallet(2);
  const friend = Keypair.generate();
  const buy = await trade("none+recipient", pool.address, signer, "buy", sol(0.2), { recipient: friend.publicKey });
  say(buy);
  check((await client.tokenBalance(signer.publicKey, pool.baseMint)) === 0n && buy.sw.recipient === friend.publicKey.toBase58(), `the coins are in the recipient's account (${buy.wallet}), the signer holds none`);
  // the signer buys for itself, then sells with the SOL going to a wallet that does not exist yet
  const own = await trade("none", pool.address, signer, "buy", sol(0.2));
  const fresh = Keypair.generate();
  const sell = await trade("none+recipient", pool.address, signer, "sell", BigInt(own.wallet), { recipient: fresh.publicKey });
  say(sell);
  check(BigInt(sell.wallet) === BigInt(sell.quote) + WSOL_RENT, `the recipient received ${sell.wallet} lamports: the quoted ${sell.quote} plus ${WSOL_RENT} of rent of the signer's wrapped SOL account`);
  check(sell.notes.some((n) => n.includes(String(WSOL_RENT))), "the notes say so: " + sell.notes[sell.notes.length - 1]);
  // the friend sells the coins it was given, so the pool gets them back
  await fund(friend.publicKey, 0.05);
  say(await trade("none", pool.address, friend, "sell", BigInt(buy.wallet)));

  // a signer that already keeps a wrapped SOL account: the account stays, to the lamport
  const holder = await newWallet(2);
  const mine = await trade("none", pool.address, holder, "buy", sol(0.2));
  const wsol = pda.ata(holder.publicKey, NATIVE_MINT);
  await sendV0(conn, client, [ix.createAtaIdempotent(holder.publicKey, holder.publicKey, NATIVE_MINT), ix.transferLamports(holder.publicKey, wsol, sol(0.25)), ix.syncNative(wsol)], [holder], "the wallet wraps 0.25 SOL");
  const half = BigInt(mine.wallet) / 2n;
  // a sell for another wallet: that wallet is paid in wrapped SOL, in its own token account
  const other = Keypair.generate();
  const forOther = (await okSwap({ mint: pool.baseMint.toBase58(), side: "sell", amount: String(half), userPublicKey: holder.publicKey.toBase58(), recipient: other.publicKey.toBase58(), simulate: true })).json;
  const seenOther = await inspect(forOther, holder.publicKey);
  const landedOther = await land(seenOther.tx, holder, forOther);
  const otherWsol = await client.tokenBalance(other.publicKey, NATIVE_MINT);
  check(!landedOther.err && otherWsol === BigInt(forOther.quote.outAmount) && (await client.tokenBalance(holder.publicKey, NATIVE_MINT)) === sol(0.25) && forOther.notes.some((n) => /stays open/.test(n)),
    `a signer that keeps a wrapped SOL account sold for another wallet: that wallet holds ${otherWsol} wrapped lamports, the quote ${forOther.quote.outAmount}; the signer's 0.25 wrapped SOL did not move; note: ${forOther.notes[forOther.notes.length - 1]}`);
  // a sell for itself: the SOL arrives in the wrapped account, which stays open
  const lamBefore = await lamportsOf(holder.publicKey);
  const back = await trade("none", pool.address, holder, "sell", BigInt(mine.wallet) - half);
  const wrappedNow = await client.tokenBalance(holder.publicKey, NATIVE_MINT);
  check(wrappedNow === sol(0.25) + BigInt(back.quote) && (await lamportsOf(holder.publicKey)) === lamBefore - back.fee && back.notes.some((n) => /stays open/.test(n)),
    `sold for itself: the wrapped SOL account holds ${wrappedNow}, its 0.25 SOL plus the quote ${back.quote}; note: ${back.notes[back.notes.length - 1]}`);
  // and the wallet empties it without closing it
  await sendV0(conn, client, client.unwrapInstructions(holder.publicKey), [holder], "the wallet unwraps");
  check((await client.tokenBalance(holder.publicKey, NATIVE_MINT)) === 0n && (await client.exists(wsol)), "unwrapInstructions: the wrapped SOL is plain SOL again and the account is still open");

  // a pegged coin for another wallet: the coins arrive, no piece is earned
  const peg = found.pegged;
  const friend2 = Keypair.generate();
  const pbuy = await trade("pegged+recipient", peg.address, signer, "buy", sol(0.3), { recipient: friend2.publicKey });
  say(pbuy);
  check((await col.fetchTicket(conn, peg.address, friend2.publicKey)) === null && (await col.fetchTicket(conn, peg.address, signer.publicKey)) === null && pbuy.notes.some((n) => /earns none/.test(n)), "no ticket was opened and no piece earned: " + pbuy.notes.find((n) => /earns none/.test(n)));
  await fund(friend2.publicKey, 0.05);
  say(await trade("pegged", peg.address, friend2, "sell", BigInt(pbuy.wallet)));
}

// ---- slippage -----------------------------------------------------------------------------------------

head("slippage: the chain enforces minOutAmount");
{
  const pool = found.none;
  const mint = pool.baseMint.toBase58();
  const a = await newWallet(1);
  const mover = await newWallet(2);
  const held = (await okSwap({ mint, side: "buy", amount: String(sol(0.1)), slippageBps: 50, userPublicKey: a.publicKey.toBase58() })).json;
  check(held.simulation === null && BigInt(held.quote.minOutAmount) === (BigInt(held.quote.outAmount) * 9950n) / 10000n, `wallet A holds a signed-later buy: out ${held.quote.outAmount}, floor ${held.quote.minOutAmount} (50 bps)`);
  const seen = await inspect(held, a.publicKey);
  const move = await trade("none", pool.address, mover, "buy", sol(0.4));
  const now = (await okQuote({ mint, side: "buy", amount: String(sol(0.1)) })).json;
  check(BigInt(now.outAmount) < BigInt(held.quote.minOutAmount), `another wallet bought 0.4 SOL: the same buy now gives ${now.outAmount}, below A's floor`);
  // the API refuses to build on a floor the pool no longer meets
  const pinned = await postSwap({ mint, side: "buy", amount: String(sol(0.1)), minOutAmount: held.quote.minOutAmount, userPublicKey: a.publicKey.toBase58() });
  check(pinned.status === 422 && pinned.json.error.code === "SLIPPAGE_EXCEEDED", `asking again with A's floor as minOutAmount: 422 SLIPPAGE_EXCEEDED: ${pinned.json.error.message}`);
  // the transaction A already holds goes to the chain as it is
  const { err, got } = await land(seen.tx, a, held, { skipPreflight: true });
  const logs = got.meta.logMessages.filter((l) => /Error Code/.test(l));
  check(!!err && /Error Code: Slippage\. Error Number: 6008/.test(logs.join(" ")), `A's transaction failed on chain: ${JSON.stringify(err)}; log: ${logs[0]}`);
  check((await client.tokenBalance(a.publicKey, pool.baseMint)) === 0n, "A received nothing and paid only the network fee of " + got.meta.fee + " lamports");
  say(await trade("none", pool.address, mover, "sell", BigInt(move.wallet)));
  // a floor the pool does meet is carried into the swap as given
  const fresh = (await okQuote({ mint, side: "buy", amount: String(sol(0.1)) })).json;
  const own = BigInt(fresh.outAmount) - 12345n;
  const kept = (await okSwap({ mint, side: "buy", amount: String(sol(0.1)), minOutAmount: own.toString(), userPublicKey: a.publicKey.toBase58() })).json;
  await inspect(kept, a.publicKey);
  check(kept.quote.minOutAmount === own.toString(), "a caller's own minOutAmount goes into the swap unchanged: " + kept.quote.minOutAmount);
}

// ---- a wallet that cannot pay ----------------------------------------------------------------------------

head("a wallet with too little SOL or too few coins gets words");
{
  const mint = found.none.baseMint.toBase58();
  const empty = Keypair.generate();
  const r1 = await postSwap({ mint, side: "buy", amount: String(sol(0.1)), userPublicKey: empty.publicKey.toBase58(), simulate: true });
  check(r1.status === 422 && r1.json.error.code === "INSUFFICIENT_FUNDS", "no SOL at all: 422 INSUFFICIENT_FUNDS: " + r1.json.error.message);
  const thin = Keypair.generate();
  await fund(thin.publicKey, 0.1001);
  const r2 = await postSwap({ mint, side: "buy", amount: String(sol(0.1)), userPublicKey: thin.publicKey.toBase58(), simulate: true });
  check(r2.status === 422 && r2.json.error.code === "INSUFFICIENT_FUNDS" && /for the rent of/.test(r2.json.error.message), "enough for the amount, not for the rent (counted before anything is built): 422 INSUFFICIENT_FUNDS: " + r2.json.error.message);
  const r3 = await postSwap({ mint, side: "sell", amount: "1000000", userPublicKey: thin.publicKey.toBase58() });
  check(r3.status === 422 && r3.json.error.code === "INSUFFICIENT_FUNDS", "a sell of coins the wallet does not hold: 422 INSUFFICIENT_FUNDS: " + r3.json.error.message);
  for (const r of [r1, r2, r3]) if (/\bat\b.*\.(js|mjs|ts):\d+|node_modules|[A-Z]:\\|\/Users\//.test(r.text)) check(false, "an error leaked a path or a stack: " + r.text);
  check(true, "none of the three answers carries a stack trace or a file path");
}

// ---- every error code ---------------------------------------------------------------------------------------

head("error codes");
{
  const p = found.none;
  const mint = p.baseMint.toBase58();
  const user = (await newWallet(1)).publicKey.toBase58();
  const good = { mint, side: "buy", amount: "100000000" };
  const cases = [
    ["INVALID_JSON", 400, () => call(BASE, "POST", "/api/v1/swap", "not json")],
    ["INVALID_JSON", 400, () => call(BASE, "POST", "/api/v1/swap", "[1,2]")],
    ["INVALID_PARAMETER", 400, () => getQuote({ side: "buy", amount: "1" })],
    ["INVALID_PARAMETER", 400, () => getQuote({ ...good, pool: p.address.toBase58() })],
    ["INVALID_PARAMETER", 400, () => getQuote({ ...good, mint: "not-a-key" })],
    ["INVALID_PARAMETER", 400, () => getQuote({ ...good, side: "long" })],
    ["INVALID_PARAMETER", 400, () => getQuote({ ...good, amount: "1.5" })],
    ["INVALID_PARAMETER", 400, () => getQuote({ ...good, amount: "0" })],
    ["INVALID_PARAMETER", 400, () => getQuote({ ...good, amount: "18446744073709551616" })],
    ["INVALID_PARAMETER", 400, () => getQuote({ ...good, slippageBps: "5001" })],
    ["INVALID_PARAMETER", 400, () => getQuote({ ...good, slippage: "50" })],
    ["INVALID_PARAMETER", 400, () => call(BASE, "GET", "/api/v1/quote?mint=" + mint + "&side=buy&amount=5&amount=6")],
    ["INVALID_PARAMETER", 400, () => call(BASE, "GET", "/api/v1/quote?mint=" + mint + "&side=buy&amount=5&x=" + "a".repeat(1100))],
    ["INVALID_PARAMETER", 400, () => postSwap({ ...good })],
    ["INVALID_PARAMETER", 400, () => postSwap({ ...good, userPublicKey: user, amount: 100000000 })],
    ["INVALID_PARAMETER", 400, () => postSwap({ ...good, userPublicKey: user, recipient: "x" })],
    ["INVALID_PARAMETER", 400, () => postSwap({ ...good, userPublicKey: user, computeUnitPriceMicroLamports: 5000001 })],
    ["INVALID_PARAMETER", 400, () => postSwap({ ...good, userPublicKey: user, simulate: "yes" })],
    ["INVALID_PARAMETER", 400, () => postSwap({ ...good, userPublicKey: user, privateKey: "never-sent-for-real" })],
    ["NOT_FOUND", 404, () => call(BASE, "GET", "/api/v1/orders")],
    ["METHOD_NOT_ALLOWED", 405, () => call(BASE, "POST", "/api/v1/quote", {})],
    ["METHOD_NOT_ALLOWED", 405, () => call(BASE, "GET", "/api/v1/swap")],
    ["BODY_TOO_LARGE", 413, () => postSwap({ ...good, userPublicKey: user, recipient: "A".repeat(5000) })],
    ["POOL_NOT_FOUND", 404, () => getQuote({ ...good, mint: Keypair.generate().publicKey.toBase58() })],
    ["POOL_NOT_FOUND", 404, () => getQuote({ side: "buy", amount: "5", pool: pda.platform().toBase58() })],
    ["CANNOT_QUOTE", 422, () => getQuote({ ...good, amount: "1" })],
    ["INSUFFICIENT_FUNDS", 422, () => postSwap({ ...good, userPublicKey: Keypair.generate().publicKey.toBase58() })],
    ["SLIPPAGE_EXCEEDED", 422, () => postSwap({ ...good, userPublicKey: user, minOutAmount: "18446744073709551615" })],
    // what a trade pays out must go to a wallet: a program, a mint or a token account given as
    // the recipient by mistake is refused before anything is built
    ["INVALID_PARAMETER", 400, async () => {
      const w = await newWallet(1);
      const b = await trade("none", p.address, w, "buy", sol(0.05));
      const r = await postSwap({ mint, side: "sell", amount: b.wallet, userPublicKey: w.publicKey.toBase58(), recipient: TOKEN_PROGRAM.toBase58(), simulate: true });
      await trade("none", p.address, w, "sell", BigInt(b.wallet));
      return r;
    }],
    ["INVALID_PARAMETER", 400, () => postSwap({ ...good, userPublicKey: user, recipient: mint })],
  ];
  const seenCodes = new Set();
  for (const [code, status, run] of cases) {
    const r = await run();
    const e = r.json && r.json.error;
    const shape = !!e && typeof e.code === "string" && typeof e.message === "string" && Object.keys(r.json).length === 1;
    check(r.status === status && shape && e.code === code && r.headers.get("access-control-allow-origin") === "*", `${status} ${code}${e && e.parameter ? " (" + e.parameter + ")" : ""}: ${e ? e.message : r.text}`);
    if (/[^\x20-\x7E]/.test(r.text)) check(false, "non-ASCII text in an error: " + r.text);
    seenCodes.add(code);
  }
  check(true, `codes reached on the live chain: ${[...seenCodes].join(", ")}, plus RATE_LIMITED, RPC_UNAVAILABLE, TRANSACTION_TOO_LARGE below`);
  console.log("  not reachable on a live chain without the admin key or another deployment: UNSUPPORTED_POOL, TRADING_PAUSED, NOT_DEPLOYED, INTERNAL. The unit tests reach them.");
  if (ownServer) {
    // requests that are not even URLs must not stop the server that also serves the API
    const broken = [(await call(BASE, "GET", "/%E0%A4%A")).status, (await call(BASE, "GET", "//")).status];
    check(broken.join(",") === "400,400" && (await getQuote(good)).status === 200, `a path with a broken escape and a bare "//": ${broken.join(", ")}, and the server keeps answering`);
  }
  const priced = (await okSwap({ ...good, userPublicKey: user, computeUnitPriceMicroLamports: 20000 })).json;
  const seen = await inspect(priced, new PublicKey(user));
  check(seen.kinds[1] === "compute_budget:price" && priced.computeUnitPriceMicroLamports === 20000 && priced.computeUnitLimit === 250000, `a priority fee adds one compute budget instruction: ${seen.kinds.slice(0, 2).join(", ")}; limit ${priced.computeUnitLimit} units`);
}

// ---- rate limit ------------------------------------------------------------------------------------------------

head("rate limit (a second server with small numbers)");
{
  const s = await startServer({ PROGRAMMABLE_API_QUOTE_LIMIT: "5", PROGRAMMABLE_API_SWAP_LIMIT: "2", PROGRAMMABLE_API_WINDOW_SECONDS: "3" });
  const mint = found.none.baseMint.toBase58();
  const statuses = []; const remaining = [];
  let last;
  for (let i = 0; i < 7; i++) { last = await getQuote({ mint, side: "buy", amount: "100000000" }, s.url); statuses.push(last.status); remaining.push(last.headers.get("x-ratelimit-remaining")); }
  check(statuses.join(",") === "200,200,200,200,200,429,429", `7 quotes with a limit of 5 per 3 seconds: ${statuses.join(", ")}; remaining header: ${remaining.join(", ")}`);
  check(last.json.error.code === "RATE_LIMITED" && Number(last.headers.get("retry-after")) >= 1 && last.headers.get("access-control-allow-origin") === "*", `429 RATE_LIMITED, Retry-After ${last.headers.get("retry-after")}: ${last.json.error.message}`);
  const sw = [];
  for (let i = 0; i < 3; i++) sw.push((await postSwap({}, s.url)).status);
  check(sw.join(",") === "400,400,429", `swaps have their own limit of 2: ${sw.join(", ")} (a refused request counts too)`);
  const opt = await call(s.url, "OPTIONS", "/api/v1/quote");
  check(opt.status === 204, "a preflight is never limited: 204");
  await sleep(3200);
  const after = await getQuote({ mint, side: "buy", amount: "100000000" }, s.url);
  check(after.status === 200, "after the window of 3 seconds the same address is served again: 200");
  s.stop();
}

// ---- the RPC --------------------------------------------------------------------------------------------------

head("the RPC: a dead one answers 502, a private URL never leaves the server");
{
  const dead = await startServer({ PROGRAMMABLE_RPC: "http://127.0.0.1:9/?api-key=DEADSECRET" });
  const t0 = Date.now();
  const r = await getQuote({ mint: found.none.baseMint.toBase58(), side: "buy", amount: "100000000" }, dead.url);
  check(r.status === 502 && r.json.error.code === "RPC_UNAVAILABLE", `502 RPC_UNAVAILABLE in ${Date.now() - t0} ms: ${r.json.error.message}`);
  check(!/DEADSECRET|127\.0\.0\.1|api-key/.test(r.text) && !/DEADSECRET|api-key/.test(dead.log()), "neither the answer nor the server's log holds the RPC URL. Log line: " + dead.log().trim().split("\n")[0]);
  dead.stop();

  const priv = await startServer({ PROGRAMMABLE_RPC: conn.rpcEndpoint.replace(/\/+$/, "") + "/?api-key=LIVESECRET", PROGRAMMABLE_API_QUOTE_LIMIT: "1000", PROGRAMMABLE_API_SWAP_LIMIT: "1000" });
  const w = await newWallet(1);
  const mint = found.tax.baseMint.toBase58();
  const answers = [
    await getQuote({ mint, side: "buy", amount: "100000000" }, priv.url),
    await postSwap({ mint, side: "buy", amount: "100000000", userPublicKey: w.publicKey.toBase58(), simulate: true }, priv.url),
    await postSwap({ mint, side: "sell", amount: "100000000", userPublicKey: w.publicKey.toBase58(), simulate: true }, priv.url),
    await getQuote({ mint: Keypair.generate().publicKey.toBase58(), side: "buy", amount: "100000000" }, priv.url),
    await call(priv.url, "GET", "/api/v1/nope"),
  ];
  const all = answers.map((a) => a.text + JSON.stringify([...a.headers])).join("\n");
  check(answers[0].status === 200 && answers[1].status === 200 && answers[2].status === 422 && answers[3].status === 404, `a server on an RPC URL with a key in it works: ${answers.map((a) => a.status).join(", ")}`);
  check(!/LIVESECRET|api-key|127\.0\.0\.1/.test(all), "5 answers (bodies and headers) searched for the RPC URL: not there");
  priv.stop();
}

// ---- no lookup table ---------------------------------------------------------------------------------------------

head("a server without the platform's lookup table");
{
  const w = await newWallet(1);
  const body = { mint: found.none.baseMint.toBase58(), side: "buy", amount: "50000000", userPublicKey: w.publicKey.toBase58() };
  await probeNoTable("no hook, first buy", body);
  noTableSeen[noTableSeen.length - 1].withTableBytes = Buffer.from((await okSwap(body)).json.transaction, "base64").length;
  for (const x of noTableSeen) console.log(`  ${x.label}: ${x.status === 200 ? x.bytes + " bytes" : x.status + " " + x.code} without the table, ${x.withTableBytes} bytes with it`);
  const plain = noTableSeen[noTableSeen.length - 1];
  check(plain.status === 200 && plain.bytes > plain.withTableBytes, `a trade on a pool without a hook fits without the table: ${plain.bytes} bytes against ${plain.withTableBytes}`);
  const tooBig = noTableSeen.filter((x) => x.status === 422 && x.code === "TRANSACTION_TOO_LARGE");
  check(noTableSeen.every((x) => x.status === 200 || x.code === "TRANSACTION_TOO_LARGE"), "every answer is a transaction that fits, or 422 TRANSACTION_TOO_LARGE");
  if (tooBig.length) check(true, `422 TRANSACTION_TOO_LARGE reached by: ${tooBig.map((x) => x.label).join("; ")}: ${tooBig[0].message}`);
  else console.log("  TRANSACTION_TOO_LARGE was not reached: every transaction of this run fits in one packet even without the table");
  noTable.stop();
}

// ---- the Vercel functions -------------------------------------------------------------------------------------------

head("the same code as Vercel functions (web/api/v1/quote.js and swap.js called the way Vercel calls them)");
{
  const vq = (await import("../web/api/v1/quote.js")).default;
  const vs = (await import("../web/api/v1/swap.js")).default;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/api/v1/quote") return vq(req, res);
    if (u.pathname === "/api/v1/swap") return vs(req, res);
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + srv.address().port;
  const params = { mint: found.buyback.baseMint.toBase58(), side: "sell", amount: "5000000000000" };
  const a = (await getQuote(params, url)).json; const b = (await okQuote(params)).json;
  delete a.slot; delete b.slot;
  check(JSON.stringify(a) === JSON.stringify(b), `the function and web/serve.js give the same quote: out ${a.outAmount}`);
  const w = await newWallet(1);
  const sw = await postSwap({ mint: found.buyback.baseMint.toBase58(), side: "buy", amount: "50000000", userPublicKey: w.publicKey.toBase58(), simulate: true }, url);
  const seen = await inspect(sw.json, w.publicKey);
  check(sw.status === 200 && sw.json.simulation.outAmount === sw.json.quote.outAmount, `the swap function builds and simulates: ${seen.size} bytes, simulated out ${sw.json.simulation.outAmount}`);
  const bad = await call(url, "POST", "/api/v1/swap", "{");
  check(bad.status === 400 && bad.json.error.code === "INVALID_JSON", "and shapes errors the same way: 400 INVALID_JSON");
  await new Promise((r) => srv.close(r));
}

// ---- where the pools ended -------------------------------------------------------------------------------------------

head("the floor rule");
check(floorsSeen.n > 0 && floorsSeen.graduating >= 3, `every swap this script inspected carried a floor at or above its quote less the slippage, none lowered: ${floorsSeen.n} swaps, ${floorsSeen.graduating} of them graduating a coin on the curve`);

head("the shared pools after the run");
for (const [k, p0] of Object.entries(found)) {
  const p1 = await client.pool(p0.address);
  const drift = ((priceOf(p1) / priceBefore[k]) - 1) * 100;
  // A chain that other rehearsals use: a wallet of theirs may trade a pool this script picked while it runs.
  // Then the price is theirs as much as ours, and only the pools nobody else traded are judged.
  const mine = ownSwaps.get(p0.address.toBase58()) ?? 0;
  const theirs = Number(p1.swapCount - p0.swapCount) - mine;
  if (theirs > 0) { check(true, `${k}: ${theirs} swap(s) of another wallet landed on this shared pool during the run, next to this script's ${mine}; its price moved ${drift >= 0 ? "+" : ""}${drift.toFixed(3)}%, not this script's to judge`); continue; }
  check(Math.abs(drift) < 15, `${k}: price moved ${drift >= 0 ? "+" : ""}${drift.toFixed(3)}% (fees of the test trades stay in the pool), ${p1.swapCount - p0.swapCount} swaps, all of them this script's`);
}

head("summary");
console.log("  kind              side  in               quote = chain?     exact  bytes  CU      RPC");
for (const r of rows) console.log(`  ${r.kind.padEnd(17)} ${r.side.padEnd(5)} ${r.in.padEnd(16)} ${(r.quote + (r.quote === r.chain ? " =" : " <")).padEnd(18)} ${String(r.exact).padEnd(6)} ${String(r.bytes).padEnd(6)} ${String(r.cu).padEnd(7)} ${r.rpc}`);
stopAll();
console.log(`\ne2e-api passed: ${checks} checks, ${rows.length} trades sent through the API.`);
process.exit(0);
