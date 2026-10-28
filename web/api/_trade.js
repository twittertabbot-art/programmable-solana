// The trade API: GET /api/v1/quote and POST /api/v1/swap. Any bot or site can buy and sell
// a Programmable coin with these two calls. The quote is computed here; the swap answers one
// complete unsigned transaction that the caller signs and sends itself. API.md in the
// project folder is the reference for callers.
//
// One module, two homes: web/serve.js calls handleRequest for the self-hosted site, and the
// Vercel functions web/api/v1/quote.js and swap.js call the same function. The SDK comes
// from ./_sdk.js, a bundle built by sdk/esbuild.mjs (the site root on Vercel is web/, so
// nothing outside it can be imported).
//
// Environment (all optional):
//   PROGRAMMABLE_RPC                 RPC URL, for a private node. Never returned or logged.
//   PROGRAMMABLE_CLUSTER             localnet, devnet or mainnet. Default: web/config.js.
//   PROGRAMMABLE_LOOKUP_TABLE        the platform's lookup table, or "none". Default:
//                                web/deployments/<cluster>-alt.json.
//   PROGRAMMABLE_API_QUOTE_LIMIT     quote calls per IP per window. Default 120. 0 = no limit.
//   PROGRAMMABLE_API_SWAP_LIMIT      swap calls per IP per window. Default 30. 0 = no limit.
//   PROGRAMMABLE_API_WINDOW_SECONDS  length of the window. Default 60.
//   PROGRAMMABLE_API_MAX_CU_PRICE    highest priority fee accepted, micro-lamports per unit.
//   PROGRAMMABLE_RPC_TIMEOUT_MS      how long one RPC call may take. Default 8000.
//   PROGRAMMABLE_TRUST_PROXY=1       count callers by the last X-Forwarded-For entry (set it
//                                only behind your own reverse proxy).
import { readFileSync } from "node:fs";
import * as H from "./_sdk.js";
import CONFIG from "../config.js";
import {
  ApiError, MAX_BODY_BYTES, MAX_CU_PRICE, MAX_URL_LENGTH, U64_MAX, base58Decode, clientIp, createRateLimiter, envInt, errorResponse,
  explainSimulationError, formatUnits, minOutAfterSlippage, parseJsonBody, parseQuoteParams, parseSwapParams, pctOfBps, queryObject,
  quoteError, ratioDecimal,
} from "./_trade-core.js";

const { PublicKey } = H;
const col = H.collectible;
const HOOKPOOL_ID = H.PROGRAMS.hookpool.toBase58();
const PLATFORM_KEY = H.pda.platform();
/// Sizes of the accounts a swap may create, whose rent is counted in what a buy needs: a token
/// account (165 bytes, the size of a wrapped SOL account too) and a Token-2022 associated token
/// account of a coin with a transfer hook (a pegged or a strict coin: 175 bytes with its two
/// extensions). Their rent is the chain's (`chainRent`): never a constant here, because mainnet
/// charges 5,080 lamports a byte over 128 bytes of overhead and a local validator 6,960.
const TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_2022_ACCOUNT_SIZE = 175;
const tokenAccountRent = (rent, tokenProgram) => rent(tokenProgram.equals(H.TOKEN_2022_PROGRAM) ? TOKEN_2022_ACCOUNT_SIZE : TOKEN_ACCOUNT_SIZE);
/// Lamports of one signature, the base network fee of every transaction built here.
const SIGNATURE_FEE = 5000n;
/// The start of the quote's sentence about the deposit a swap adds to a collectible buy. /swap says the exact
/// amount for its wallet instead.
const DEPOSIT_NOTE = "A swap adds a deposit of";
/// The compute a swap asks for on top of its own when it ends with `graduate` (the instruction takes about
/// 20,500 units on a local validator; the rest is a margin). Exported for the unit tests.
export const GRADUATE_COMPUTE_UNITS = 25_000;
const STATIC_TTL_MS = 10 * 60_000;
const MAX_KNOWN_POOLS = 5000;

// ---- settings --------------------------------------------------------------------------------

const env = (k) => { const v = process.env[k]; return v === undefined || v === "" ? undefined : v; };

function readDeployment(name) {
  try { return JSON.parse(readFileSync(new URL("../deployments/" + name + ".json", import.meta.url), "utf8")); } catch (_) { return null; }
}

let settingsCache = null;
/// Cluster, RPC, lookup table and limits, read once. Same order as the site: environment,
/// then web/config.js, then web/deployments/<cluster>.json, then the public endpoint.
export function settings() {
  if (settingsCache) return settingsCache;
  const raw = String(env("PROGRAMMABLE_CLUSTER") || CONFIG.cluster || "localnet").toLowerCase();
  const cluster = /^[a-z0-9-]{1,20}$/.test(raw) ? raw : "localnet";
  const dep = readDeployment(cluster);
  const rpc = env("PROGRAMMABLE_RPC") || CONFIG.rpc || (dep && dep.rpc)
    || (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : cluster === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899");
  let lookupTable = null;
  const altEnv = env("PROGRAMMABLE_LOOKUP_TABLE");
  if (altEnv !== "none") {
    const alt = altEnv || (readDeployment(cluster + "-alt") || {}).lookupTable;
    try { if (alt) lookupTable = new PublicKey(alt); } catch (_) { lookupTable = null; }
  }
  settingsCache = {
    cluster, rpc, lookupTable,
    quoteLimit: envInt(env("PROGRAMMABLE_API_QUOTE_LIMIT"), 120, 0, 1_000_000),
    swapLimit: envInt(env("PROGRAMMABLE_API_SWAP_LIMIT"), 30, 0, 1_000_000),
    windowMs: envInt(env("PROGRAMMABLE_API_WINDOW_SECONDS"), 60, 1, 86_400) * 1000,
    maxCuPrice: envInt(env("PROGRAMMABLE_API_MAX_CU_PRICE"), MAX_CU_PRICE, 0, 1_000_000_000),
    rpcTimeoutMs: envInt(env("PROGRAMMABLE_RPC_TIMEOUT_MS"), 8000, 500, 60_000),
    ipMode: process.env.VERCEL ? "vercel" : env("PROGRAMMABLE_TRUST_PROXY") === "1" ? "proxy" : "direct",
  };
  return settingsCache;
}

let sharedConnection = null;
/// The one RPC connection of the server (the review requests in ./_reviews.js use it too).
export function connection() {
  if (sharedConnection) return sharedConnection;
  const s = settings();
  const timed = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(s.rpcTimeoutMs) });
  try {
    // no retry loop on a rate-limited RPC: the caller gets a 502 at once and decides itself
    sharedConnection = new H.Connection(s.rpc, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: timed });
  } catch (_) {
    throw new ApiError(502, "RPC_UNAVAILABLE", "The Solana RPC did not answer. Try again.");
  }
  return sharedConnection;
}

/// The text of an error for the server's own log, with the RPC URL taken out.
function scrub(e) {
  let m = String((e && e.message) || e).slice(0, 300);
  const rpc = settingsCache && settingsCache.rpc;
  if (rpc) m = m.split(rpc).join("<rpc>");
  return m.replace(/https?:\/\/[^\s"']+/g, "<url>");
}

function rpcDown(e) {
  if (e instanceof ApiError) return e;
  console.error("[trade-api] rpc: " + scrub(e));
  return new ApiError(502, "RPC_UNAVAILABLE", "The Solana RPC did not answer. Try again.");
}

// ---- caches -----------------------------------------------------------------------------------
// What does not change per request is kept for ten minutes: the lookup table, a hook's
// extra-accounts list, and the facts of a pool that are fixed at its creation (mints, hook
// program, token programs) together with the coin's symbol and decimals. Reserves, the
// platform account, the hook's settings and the wallet's accounts are read fresh, in one call.

const staticAccounts = new Map();   // by address: { info, expires }
const staticIds = new Set();        // addresses that may be served from staticAccounts
const knownPools = new Map();       // by pool address: { expires, template, cfgKey, coin }
let lookupTableCache = null;        // { key, result, expires }

/// Both maps stay bounded: when one is full its oldest tenth goes.
function remember(map, key, value) {
  if (map.size >= MAX_KNOWN_POOLS) { let n = Math.ceil(MAX_KNOWN_POOLS / 10); for (const k of map.keys()) { map.delete(k); if (--n <= 0) break; } }
  map.set(key, value);
}
function markStatic(key) {
  if (staticIds.size >= MAX_KNOWN_POOLS) staticIds.clear();
  staticIds.add(key.toBase58());
}

/// For tests: forget everything cached.
export function resetCaches() {
  staticAccounts.clear(); staticIds.clear(); knownPools.clear(); lookupTableCache = null; rentCache = null;
}

/// The chain's rent: read once per process (two calls, outside the request's count) and kept an
/// hour (collectible.RENT_TTL_MS). Every deposit this API sizes or reads, and every rent it counts
/// in what a buy needs, is priced at it. A local validator charges 6,960 lamports a byte and
/// mainnet 5,080: a deposit sized at the local rent was 787,720 lamports too much a piece on the
/// live chain, and a deposit read at it 891,120 short on an empty ticket.
let rentCache = null; // { rent, at }
let rentInflight = null; // callers on a cold cache share one read
async function chainRent(deps) {
  const now = deps.now || Date.now;
  if (rentCache && now() - rentCache.at < col.RENT_TTL_MS) return rentCache.rent;
  if (!rentInflight) {
    rentInflight = (async () => {
      try { const rent = await col.rentFrom(deps.connection); rentCache = { rent, at: now() }; return rent; }
      catch (e) { throw rpcDown(e); }
      finally { rentInflight = null; }
    })();
  }
  return rentInflight;
}

/// A view of the connection for one request. Every account read is remembered for the
/// length of the request, so the SDK's own reads of accounts already fetched cost nothing,
/// and any RPC failure becomes RPC_UNAVAILABLE. `calls()` counts the RPC round trips.
function requestScope(base, now) {
  const memo = new Map();
  let calls = 0;
  const rpc = async (fn) => { calls++; try { return await fn(); } catch (e) { throw rpcDown(e); } };
  async function getMany(keys) {
    const out = new Array(keys.length);
    const missing = [];
    keys.forEach((k, i) => {
      const id = k.toBase58();
      if (memo.has(id)) { out[i] = memo.get(id); return; }
      const s = staticIds.has(id) ? staticAccounts.get(id) : undefined;
      if (s && s.expires > now()) { out[i] = s.info; memo.set(id, s.info); return; }
      missing.push(i);
    });
    if (missing.length) {
      const got = await rpc(() => base.getMultipleAccountsInfo(missing.map((i) => keys[i])));
      missing.forEach((i, j) => {
        const id = keys[i].toBase58();
        out[i] = got[j]; memo.set(id, got[j]);
        if (staticIds.has(id)) remember(staticAccounts, id, { info: got[j], expires: now() + STATIC_TTL_MS });
      });
    }
    return out;
  }
  /// One call for many accounts, never from a cache, with the slot they were read at.
  async function fresh(keys) {
    const r = await rpc(() => base.getMultipleAccountsInfoAndContext(keys, "confirmed"));
    keys.forEach((k, i) => memo.set(k.toBase58(), r.value[i]));
    return r;
  }
  async function lookupTable(key) {
    const id = key.toBase58();
    if (lookupTableCache && lookupTableCache.key === id && lookupTableCache.expires > now()) return lookupTableCache.result;
    const result = await rpc(() => base.getAddressLookupTable(key));
    // a table that is missing is asked for again soon; one that exists only ever grows
    lookupTableCache = { key: id, result, expires: now() + (result && result.value ? STATIC_TTL_MS : 15_000) };
    return result;
  }
  // A read with a `dataSlice` (the SDK asks for one byte of a rules config, to know whether
  // the coin is a strict coin) is served from the same memory, cut the way the RPC cuts it.
  const sliced = (info, opts) => {
    const s = opts && typeof opts === "object" ? opts.dataSlice : null;
    if (!info || !s) return info;
    const data = Buffer.from(info.data).subarray(s.offset, s.offset + s.length);
    return { ...info, data };
  };
  const own = { getAccountInfo: async (k, opts) => sliced((await getMany([k]))[0], opts), getMultipleAccountsInfo: (keys) => getMany(keys), getAddressLookupTable: lookupTable };
  const conn = new Proxy(base, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(own, prop)) return own[prop];
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? (...args) => rpc(() => v.apply(target, args)) : v;
    },
  });
  return { conn, fresh, memo, calls: () => calls };
}

// ---- reading a pool -----------------------------------------------------------------------------

const templateOf = (program) => program.equals(H.PROGRAMS.hook_tax) ? "tax" : program.equals(H.PROGRAMS.hook_launch_guard) ? "launch_guard"
  : program.equals(H.PROGRAMS.hook_buyback) ? "buyback" : program.equals(H.PROGRAMS.hook_collectible) ? "collectible"
    : program.equals(H.PROGRAMS.hook_rules) ? "rules" : "custom";

function poolNotFound(p) {
  return new ApiError(404, "POOL_NOT_FOUND", p.mint
    ? "No Programmable pool trades this mint against SOL on " + settings().cluster + "."
    : "No Programmable pool at this address on " + settings().cluster + ".");
}

/// A pool account decoded, or null when the account is missing, belongs to another program
/// or is not a pool.
function decodePoolAccount(key, info) {
  if (!info || !info.owner || !info.owner.equals(H.PROGRAMS.hookpool)) return null;
  try { return H.decodePool(key, new Uint8Array(info.data)); } catch (_) { return null; }
}

/// What is true of a pool forever, or changes rarely: its hook, and its coin's name.
function checkSupported(pool) {
  if (!pool.quoteMint.equals(H.NATIVE_MINT)) {
    throw new ApiError(422, "UNSUPPORTED_POOL", "This pool does not trade against SOL. The API trades coins against SOL only.");
  }
}

const clean = (s, max) => String(s || "").replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, max);

/// The facts of a pool that never change, from one read of its account. Its coin (name, symbol, decimals) is
/// read in the same call as the platform and the pool (loadTrade), and only then is the pool remembered.
async function learnPool(scope, poolKey, p, now) {
  const pool = decodePoolAccount(poolKey, await scope.conn.getAccountInfo(poolKey));
  if (!pool) throw poolNotFound(p);
  checkSupported(pool);
  const known = {
    expires: now() + STATIC_TTL_MS,
    template: pool.hasHook ? templateOf(pool.hookProgram) : "none",
    cfgKey: pool.hasHook ? H.pda.cfg(pool.hookProgram, poolKey) : null,
    baseMint: pool.baseMint, baseTokenProgram: pool.baseTokenProgram,
    // a strict coin is a Token-2022 coin on the rules template; its config says so (kind 1)
    maybeStrict: pool.hasHook && pool.hookProgram.equals(H.PROGRAMS.hook_rules) && pool.baseTokenProgram.equals(H.TOKEN_2022_PROGRAM),
    // a pool that opened on the curve stays one (open, then graduated); a seeded pool never becomes one. The
    // quote of such a pool reads the coin's supply with the pool, for the share of it that was sold.
    curvePool: pool.curveState !== H.CURVE_NONE,
    coin: null,
  };
  if (pool.hasHook) markStatic(pool.hookExtraMetas);
  return known;
}

/// The coin of a pool the server learns, from its mint and its Metaplex metadata account read with the pool:
/// the SDK's client.metadata rule (the Metaplex account, else the metadata a Token-2022 mint carries itself).
function coinOf(known, mintInfo, metadataInfo) {
  if (!mintInfo || !mintInfo.data || mintInfo.data.length < 82) throw new ApiError(422, "CANNOT_QUOTE", "The coin of this pool could not be read.");
  let mint;
  try { mint = H.decodeMint(new Uint8Array(mintInfo.data), mintInfo.owner); } catch (_) { throw new ApiError(422, "CANNOT_QUOTE", "The coin of this pool could not be read."); }
  let md = null;
  if (metadataInfo) { try { md = H.decodeMetaplexMetadata(new Uint8Array(metadataInfo.data)); } catch (_) { md = null; } }
  if (!md && mintInfo.owner.equals(H.TOKEN_2022_PROGRAM)) { try { md = H.decodeToken2022Metadata(known.baseMint, new Uint8Array(mintInfo.data)); } catch (_) { md = null; } }
  return { mint: known.baseMint.toBase58(), symbol: clean(md && md.symbol, 16), name: clean(md && md.name, 40), decimals: mint.decimals, tokenProgram: known.baseTokenProgram.toBase58() };
}

/// The hook as the SDK's quote wants it, built from the pool account and the hook's settings
/// read in this request. The flags and the kind come from the pool itself.
function hookInfoOf(pool, known, cfgInfo) {
  if (!pool.hasHook) return null;
  const info = { program: pool.hookProgram, kind: pool.hookKind, flags: pool.hookFlags, manifest: null, template: known.template, upgradeAuthority: "unknown", summary: H.describeFlags(pool.hookFlags) };
  if (known.template === "custom") return info;
  const unreadable = () => new ApiError(422, "CANNOT_QUOTE", "The settings of this pool's hook could not be read.");
  if (!cfgInfo || !cfgInfo.owner.equals(pool.hookProgram)) throw unreadable();
  const d = new Uint8Array(cfgInfo.data);
  try {
    if (known.template === "tax") info.tax = H.decodeTaxConfig(d);
    if (known.template === "launch_guard") info.guard = H.decodeGuardConfig(d);
    if (known.template === "buyback") info.buyback = H.decodeBuybackConfig(d);
    if (known.template === "collectible") info.collectible = col.decodeCollectionConfig(d);
    if (known.template === "rules") info.rules = H.decodeRulesConfig(d);
  } catch (_) { throw unreadable(); }
  // a rules config that does not name this pool, or whose pool never started, is not this pool's
  if (info.rules && (!info.rules.pool.equals(pool.address) || !info.rules.started)) throw unreadable();
  return info;
}

/// Everything a quote needs, read in one RPC call once the pool is known: platform, pool,
/// hook settings, plus `walletKeys(poolKey, known)` for a swap.
///
/// `strictWallets`: the wallets whose coins the rules of a strict coin are checked for (the
/// receiver of a buy, the seller of a sell). On a coin that may be a strict coin their
/// holder records, their coin accounts and the clock ride in the same call, so the SDK's
/// own checks of the strict rules read nothing more.
async function loadTrade(deps, p, walletKeys, strictWallets = []) {
  const now = deps.now || Date.now;
  const scope = requestScope(deps.connection, now);
  const client = new H.HookpoolClient(scope.conn, deps.lookupTable ? { lookupTable: deps.lookupTable } : {});
  // the chain's rent, from the process cache (read once an hour)
  const rent = await chainRent(deps);
  const poolKey = p.pool ? new PublicKey(p.pool) : H.pda.pool(new PublicKey(p.mint), H.NATIVE_MINT);
  let known = knownPools.get(poolKey.toBase58());
  // a pool the server does not know (or no longer): one read of the pool account first, its coin in the call below
  const learning = !known || known.expires <= now();
  if (learning) known = await learnPool(scope, poolKey, p, now);
  const keys = [PLATFORM_KEY, poolKey];
  if (known.cfgKey) keys.push(known.cfgKey);
  // the coin's mint, on a pool that opened on the curve: its supply is fresh in every answer. And the first time,
  // on any pool: its decimals, with its metadata account for the name and symbol.
  const mintAt = known.curvePool || learning ? keys.push(known.baseMint) - 1 : -1;
  const metadataAt = learning ? keys.push(H.pda.metadata(known.baseMint)) - 1 : -1;
  const strictKeys = [];
  if (known.maybeStrict) {
    strictKeys.push(H.CLOCK_SYSVAR);
    for (const w of strictWallets) strictKeys.push(H.rulesPda.holder(poolKey, w), H.pda.ata(w, known.baseMint, known.baseTokenProgram));
  }
  keys.push(...strictKeys);
  const extra = walletKeys ? walletKeys(poolKey, known) : [];
  const { context, value } = await scope.fresh([...keys, ...extra]);
  if (!value[0]) throw new ApiError(503, "NOT_DEPLOYED", "Programmable is not set up on " + settings().cluster + " yet.");
  let platform;
  try { platform = H.decodePlatform(new Uint8Array(value[0].data)); } catch (_) { throw new ApiError(503, "NOT_DEPLOYED", "Programmable is not set up on " + settings().cluster + " yet."); }
  const pool = decodePoolAccount(poolKey, value[1]);
  if (!pool) throw poolNotFound(p);
  checkSupported(pool);
  if (learning) {
    known.coin = coinOf(known, value[mintAt], value[metadataAt]);
    remember(knownPools, poolKey.toBase58(), known);
  }
  const hook = hookInfoOf(pool, known, known.cfgKey ? value[2] : null);
  // the supply of a curve pool's coin (bytes 36 to 43 of a mint, under either token program); null when unread
  const mintInfo = mintAt >= 0 ? value[mintAt] : null;
  const supply = mintInfo && mintInfo.data.length >= 44 ? Buffer.from(mintInfo.data).readBigUInt64LE(36) : null;
  // what each checked wallet holds of a strict coin, and its holder record
  const holders = new Map();
  if (strictKeys.length) {
    const at = keys.length - strictKeys.length;
    const clock = value[at];
    strictWallets.forEach((w, i) => {
      const rec = value[at + 1 + 2 * i]; const ata = value[at + 2 + 2 * i];
      let record = null;
      if (rec && rec.owner.equals(H.PROGRAMS.hook_rules)) { try { record = H.decodeHolderRecord(new Uint8Array(rec.data)); } catch (_) { record = null; } }
      const balance = ata && ata.owner.equals(known.baseTokenProgram) && ata.data.length >= 72 ? H.decodeTokenAmount(new Uint8Array(ata.data)) : 0n;
      holders.set(w.toBase58(), { address: w, record, balance });
    });
    if (clock && clock.data.length >= 40) {
      const d = Buffer.from(clock.data);
      holders.clock = { slot: d.readBigUInt64LE(0), unixTime: d.readBigInt64LE(32) };
    }
  }
  return { scope, client, rent, slot: context.slot, platform, pool, hook, known, holders, supply, wallet: value.slice(keys.length) };
}

// ---- the quote --------------------------------------------------------------------------------

function hookFeeBpsOf(hook, isBuy, platform) {
  if (!hook) return 0;
  const runs = isBuy ? hook.summary.runsOnBuys : hook.summary.runsOnSells;
  let bps = 0;
  if (runs && hook.tax) bps = isBuy ? hook.tax.buyBps : hook.tax.sellBps;
  if (runs && hook.buyback) bps = isBuy ? hook.buyback.buyBps : hook.buyback.sellBps;
  // launch rules: the three rates of the side, always all three, whoever is staked
  if (runs && hook.rules) bps = H.rulesRatesTotal(H.rulesSideRates(hook.rules, isBuy ? H.DIRECTION.BUY : H.DIRECTION.SELL));
  return Math.min(bps, platform.maxHookFeeBps);
}

/// Seconds that `slots` slots take, at the usual 400 ms a slot, rounded up.
const secondsOf = (slots) => Math.ceil(Number(slots) * 0.4);

/// The notes about the three shares of a rules coin on one side of a trade. They say where
/// the hook fee goes by the coin's rules, never what is staked right now: the fee a trader
/// pays does not depend on it.
function rulesShareNotes(rules, isBuy, platform) {
  // on a strict coin the holders' share goes to wallets with a holder record, not to stakers
  const strict = rules.kind === H.RULES_KIND.STRICT;
  const holders = strict ? "holders with a holder record" : "holders who stake the coin";
  const side = isBuy ? rules.buy : rules.sell;
  const what = isBuy ? "buy" : "sell";
  const total = H.rulesRatesTotal(side);
  if (total === 0) return ["The rules of this coin take nothing from a " + what + ".", "The rules of this coin were fixed at launch and can never change."];
  const notes = [];
  const capped = total > platform.maxHookFeeBps;
  notes.push("This coin takes " + pctOfBps(total) + "% of every " + what + ", in SOL." + (capped
    ? " The platform caps this fee at " + pctOfBps(platform.maxHookFeeBps) + "%, so this trade pays " + pctOfBps(platform.maxHookFeeBps) + "% and the shares below shrink in the same proportion."
    : "") + " The quote includes it.");
  const parts = [];
  if (side.creatorBps > 0) parts.push([side.creatorBps, "for the coin's creator", "goes to the coin's creator"]);
  if (side.holdersBps > 0) parts.push([side.holdersBps, "for " + holders, "goes to " + holders]);
  if (side.burnBps > 0) parts.push([side.burnBps, "to buy the coin back and burn it", "buys the coin back and burns it"]);
  if (parts.length === 1) notes.push("All of it " + parts[0][2] + ".");
  else {
    const list = parts.map(([bps, words]) => pctOfBps(bps) + "% " + words);
    notes.push("It is split in " + (parts.length === 2 ? "two" : "three") + ": " + list.slice(0, -1).join(", ") + " and " + list[list.length - 1] + ".");
  }
  if (side.holdersBps > 0) notes.push(strict ? "While less than 0.1% of the coin's supply is in holder records, the holders' share goes to the burn instead." : "While less than 0.1% of the coin's supply is staked, the holders' share goes to the burn instead.");
  notes.push("These rates were fixed at launch and can never change.");
  return notes;
}

// ---- the strict coin ------------------------------------------------------------------------------
// A strict coin is a coin of the rules template whose own transfer hook is the rules
// program, so its rules run inside every transfer: a max wallet, a lock on coins bought in
// the first slots, and the holders' share paid to wallets that opened a holder record.

const nOrNull = (v) => (v === 0n ? null : Number(v));
const isoOf = (unix) => new Date(Number(unix) * 1000).toISOString().replace(/\.000Z$/, "Z");

/// What the strict rules hold back of a wallet now: the larger of its early coins (while the
/// early lock runs) and the creator's locked coins (before their date).
function heldOf(rules, w, slot, unixTime) {
  if (!w || !w.record) return { early: 0n, creator: 0n, held: 0n };
  const early = w.record.earlyBought > 0n && H.strictEarlyLocked(rules, slot) ? w.record.earlyBought : 0n;
  const creator = w.record.locked > 0n && unixTime < w.record.lockedUntil ? w.record.locked : 0n;
  return { early, creator, held: early > creator ? early : creator };
}

/// The MOST a buy of `amount` can give on a rules pool: the output at the pool's own fee, with
/// no fee override. Inside the sniper window the fee falls every slot, so a buy that lands
/// later gives more coins than the quote of the slot the pool was read at, and never more than
/// this. The max wallet of a strict coin is judged against this number, because the program
/// checks the receiving wallet's balance after the transfer, at the landing slot. Outside the
/// window it is the output of the quote itself. 0n when the amount cannot be quoted.
function buyOutAtBaseFee(pool, platform, hook, amount) {
  try {
    return H.quoteSwap({
      direction: H.DIRECTION.BUY, amountIn: amount, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: pool.virtualQuote, lpFeeBps: pool.lpFeeBps,
      protocolFeeBps: platform.protocolFeeBps, hookFeeBps: hookFeeBpsOf(hook, true, platform), feeOverrideBps: null,
    }).amountOut;
  } catch (_) { return 0n; }
}

/// The largest buy, in lamports, whose coins still fit in `room`: the curve read backwards with
/// `outAt(amount)`, the most a buy can give (0n for an amount the pool cannot quote). The
/// amounts the pool takes and whose coins fit are one stretch above the amounts too small to
/// quote, so the search climbs past those; the answer is a buy the pool takes, or 0 when no
/// such buy fits.
export function largestBuyUnder(outAt, room, hi) {
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const out = outAt(mid);
    if (out === 0n || out <= room) lo = mid; else hi = mid - 1n;
  }
  return lo > 0n && outAt(lo) > 0n ? lo : 0n;
}

/// A refusal of a strict coin's rules as the API answers it, with the numbers a caller needs
/// to change its trade. `e` is the SDK's StrictRefusal, or `{ number }` for a refusal the API
/// found itself. `s.out` is the most this buy can give, `s.outAt` the same for any amount,
/// `s.falling` whether the sniper fee is falling (then the chain gives more than the quote).
async function strictError(e, s) {
  const { rules, w, slot, unixTime, isBuy, out, amount, outAt, falling } = s;
  const win = H.strictWindows(rules);
  const held = heldOf(rules, w, slot, unixTime);
  const balance = w ? w.balance : 0n;
  const free = balance > held.held ? balance - held.held : 0n;
  if (e.number === 6044 && isBuy) {
    const cap = rules.maxWalletAmount;
    const room = cap > balance ? cap - balance : 0n;
    const maxAmount = largestBuyUnder(outAt, room, amount);
    return new ApiError(422, "MAX_WALLET_EXCEEDED",
      "This coin has a max wallet. Until slot " + win.maxWalletUntil + ", in about " + secondsOf(win.maxWalletUntil - slot) + " seconds, one wallet can hold at most " + cap + " raw units of the coin. "
      + "The receiving wallet holds " + balance + ", so it can receive " + room + " more, and this buy would give it " + (falling ? "up to " : "") + out + ". "
      + (maxAmount > 0n ? "The largest buy it can make now is " + maxAmount + " lamports." : "It can buy nothing more until then.")
      + (falling ? " The sniper fee falls every slot, so the check counts the most a buy can give, at the pool's normal fee." : ""),
      { maxWallet: cap.toString(), walletBalance: balance.toString(), room: room.toString(), maxAmount: maxAmount.toString(), endsAtSlot: Number(win.maxWalletUntil) });
  }
  if (e.number === 6045 && !isBuy) {
    return new ApiError(422, "EARLY_LOCKED",
      "Coins this wallet bought in the coin's first slots cannot leave it before slot " + win.earlyUnlock + ", in about " + secondsOf(win.earlyUnlock - slot) + " seconds. "
      + "The wallet holds " + balance + " raw units, " + held.early + " of them bought early, so it can sell at most " + free + " now.",
      { walletBalance: balance.toString(), locked: held.early.toString(), free: free.toString(), unlockSlot: Number(win.earlyUnlock) });
  }
  if (e.number === 6046 && !isBuy) {
    const until = w && w.record ? w.record.lockedUntil : 0n;
    return new ApiError(422, "CREATOR_LOCKED",
      "This wallet is the coin's creator, and " + held.creator + " raw units of its coins are locked until " + isoOf(until) + " (Unix time " + until + "). "
      + "The wallet holds " + balance + ", so it can sell at most " + free + " now.",
      { walletBalance: balance.toString(), locked: held.creator.toString(), free: free.toString(), unlockAt: Number(until) });
  }
  if (e.number === 6047) return holderRecordRequired(s.recipient, win.earlyUntil, slot);
  return new ApiError(422, "CANNOT_QUOTE", "The rules of this coin refuse this trade: " + e.message);
}

function holderRecordRequired(recipient, earlyUntil, slot) {
  return new ApiError(422, "HOLDER_RECORD_REQUIRED",
    "A buy in this coin's first slots needs a holder record of the wallet that receives the coins, and only that wallet can open it. The recipient has none. "
    + "Until slot " + earlyUntil + ", in about " + secondsOf(earlyUntil - slot) + " seconds, buy for a wallet that has one, or let the recipient buy for itself: the API opens a wallet's own record in front of its buy.",
    { recipient: recipient ? recipient.toBase58() : null, endsAtSlot: Number(earlyUntil) });
}

/// The notes and the `hook.rules.strict` part of a quote on a strict coin. `w` is the wallet
/// the rules are checked for (null when the caller named none), `opens` says that /swap puts
/// `open_holder` in front of this buy.
/// `out` is the most this buy can give (the quote's output, or the output at the pool's normal
/// fee while the sniper fee falls, `falling`).
function strictPart(rules, s) {
  const { isBuy, out, amount, slot, unixTime, w, opens, falling } = s;
  const win = H.strictWindows(rules);
  const notes = ["This is a strict coin. Its rules run inside every transfer of the coin, not only in this pool."];
  const maxRuns = H.strictMaxWalletRuns(rules, slot);
  const earlyRuns = H.strictEarlyWindowRuns(rules, slot);
  const earlyLocked = H.strictEarlyLocked(rules, slot);
  const holdersShare = rules.buy.holdersBps > 0 || rules.sell.holdersBps > 0;
  if (isBuy && maxRuns) {
    notes.push("A max wallet is running on this coin. Until slot " + win.maxWalletUntil + ", in about " + secondsOf(win.maxWalletUntil - slot) + " seconds, one wallet can hold at most " + rules.maxWalletAmount + " raw units of the coin. A sell is never held by it.");
    if (falling) notes.push("The sniper fee falls every slot, so a buy that lands later gives more coins than this quote. The max wallet check leaves room for that: it counts the most this buy can give, at the pool's normal fee. A price fall between the quote and the landing can still push a buy within a hair of the cap over it, so keep a margin.");
  }
  if (isBuy && earlyRuns) {
    notes.push("Coins bought until slot " + win.earlyUntil + ", in about " + secondsOf(win.earlyUntil - slot) + " seconds, are early coins. They cannot leave the wallet before slot " + win.earlyUnlock + ", in about " + secondsOf(win.earlyUnlock - slot) + " seconds.");
  }
  if (!isBuy && earlyLocked) {
    notes.push("Coins bought in the coin's first slots cannot be sold before slot " + win.earlyUnlock + ", in about " + secondsOf(win.earlyUnlock - slot) + " seconds. Other coins can.");
  }
  let wallet = null;
  if (w) {
    const held = heldOf(rules, w, slot, unixTime);
    const after = isBuy ? w.balance + out : w.balance > amount ? w.balance - amount : 0n;
    const lockedNow = held.held;
    if (isBuy && maxRuns) {
      const room = rules.maxWalletAmount > after ? rules.maxWalletAmount - after : 0n;
      notes.push(falling
        ? "After this buy the receiving wallet holds up to " + after + " raw units, at least " + room + " under the cap."
        : "After this buy the receiving wallet holds " + after + " raw units, " + room + " under the cap.");
    }
    if (isBuy && earlyRuns) {
      notes.push(falling
        ? "The coins of this buy, up to " + out + " raw units, are early coins. They stay locked in the wallet until slot " + win.earlyUnlock + "."
        : "The " + out + " raw units of this buy are early coins. They stay locked in the wallet until slot " + win.earlyUnlock + ".");
    }
    if (isBuy) {
      const earns = holdersShare ? ", so its coins earn a part of the holders' share" : "";
      if (w.record) notes.push("The receiving wallet has a holder record" + earns + ".");
      else if (opens) notes.push("The receiving wallet has no holder record. /api/v1/swap opens it in front of the buy" + earns + ". The record's rent, " + s.rent(H.HOLDER_RECORD_SIZE) + " lamports, is paid by the wallet that signs and comes back when the record is closed.");
      else notes.push("The receiving wallet has no holder record, so its coins earn no part of the holders' share until it opens one. Only that wallet can open it.");
    }
    if (!isBuy && lockedNow > 0n) {
      const free = w.balance > lockedNow ? w.balance - lockedNow : 0n;
      const until = held.early >= held.creator ? "slot " + win.earlyUnlock : isoOf(w.record.lockedUntil);
      notes.push("This wallet holds " + w.balance + " raw units of the coin. " + lockedNow + " of them are locked until " + until + ", so it can sell at most " + free + " now.");
    }
    const finalHeld = isBuy && earlyRuns ? lockedNow + out : lockedNow;
    wallet = {
      address: w.address.toBase58(), balance: w.balance.toString(), after: after.toString(), holderRecord: !!w.record, opensHolderRecord: !!opens,
      locked: finalHeld.toString(), creatorLockedUntil: held.creator > 0n ? Number(w.record.lockedUntil) : null,
    };
  } else if (isBuy && holdersShare) {
    notes.push("Only wallets with a holder record earn the holders' share. /api/v1/swap opens the buyer's record in front of its first buy. The record's rent, " + s.rent(H.HOLDER_RECORD_SIZE) + " lamports, comes back when the record is closed.");
  }
  return {
    notes,
    strict: {
      maxWallet: rules.maxWalletBps > 0 ? rules.maxWalletAmount.toString() : null,
      maxWalletEndsAtSlot: nOrNull(win.maxWalletUntil), earlyEndsAtSlot: nOrNull(win.earlyUntil), earlyUnlockSlot: nOrNull(win.earlyUnlock),
      wallet,
    },
  };
}

// ---- the curve ------------------------------------------------------------------------------------
// A coin launched on the curve opens its pool with no real SOL. The pool prices trades with
// `reserveQuote + virtualQuote` and pays out `reserveQuote` only. Once the real reserve reaches the
// graduation target, `graduate` (anyone may send it) drops the virtual part and burns coins from the pool
// so that the price stays where it is. One pool, one address, for the coin's whole life.
//
// The rule of a trade that graduates a coin, and of its floor:
//   - a trade on a pool that stands at or past its target sends `graduate` FIRST, and is quoted on the
//     graduated pool. Whoever graduates the pool first, the trade runs on the graduated pool: the quote is
//     exact, and its floor is the caller's slippage on it;
//   - a buy that takes a pool under its target to the target is quoted on the curve, and `graduate` follows
//     the swap. Its floor is the caller's slippage on that quote;
//   - nothing ever lowers a floor: not the one the API takes from slippageBps, not the one a caller sends.

// The SDK holds the rule: `H.readyToGraduate(pool)` says a pool stands at or past its target, and
// `H.poolAfterGraduation(pool)` is that pool as graduate leaves it (the pool itself otherwise); `quoteLocal`
// quotes a trade on a pool ready to graduate on that graduated pool and says `graduates` and `graduateFirst`;
// `swapInstructions` puts graduate before or after the swap from `opts.graduate` and sends the floor as given.

/// The curve part of a quote: where the pool stands now, whether this transaction graduates it, and whether the
/// graduate comes first. `supply` is the coin's supply as read with the pool (null when it could not be read).
function curvePart(pool, supply, graduates, graduateFirst) {
  const state = H.curveStateName(pool.curveState);
  if (state === "none") return { state, virtualQuote: "0", raised: "0", target: "0", raisedBps: 0, soldBps: 0, graduates: false, graduateFirst: false };
  const c = H.curveProgress(pool, supply ?? 0n);
  return {
    state, virtualQuote: pool.virtualQuote.toString(), raised: c.raised.toString(), target: c.target.toString(), raisedBps: c.raisedBps,
    soldBps: supply === null ? null : c.soldBps, graduates: !!graduates, graduateFirst: !!graduates && !!graduateFirst,
  };
}

/// The largest amount for which `pays(amount)` holds, from 0 to `hi`. `pays` holds for every amount up to a
/// point and for none after it.
function largestUnder(pays, hi) {
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (pays(mid)) lo = mid; else hi = mid - 1n;
  }
  return lo;
}

/// The refusal of a sell that would take more than the real SOL of a pool on the curve, with the largest
/// sell the pool pays now. `params` are the quote's own numbers for a sell.
function curveRealReserveError(pool, params, amount) {
  const pays = (x) => { try { H.quoteSwap({ ...params, amountIn: x }); return true; } catch (e) { return !(e instanceof H.CurveRefusal); } };
  let max = largestUnder(pays, amount);
  // the last amount it pays may still be too small to quote: then no sell is paid
  if (max > 0n) { try { H.quoteSwap({ ...params, amountIn: max }); } catch (_) { max = 0n; } }
  return new ApiError(422, "CURVE_REAL_RESERVE",
    "This coin is on the curve. Its pool counts " + formatUnits(pool.virtualQuote, 9) + " SOL of virtual SOL in the price, but pays a sell from the real SOL it holds, " + pool.reserveQuote + " lamports. "
    + "This sell would take more than that. " + (max > 0n ? "The largest sell it pays now is " + max + " raw units of the coin." : "It pays no sell now."),
    { realReserve: pool.reserveQuote.toString(), maxAmount: max.toString() });
}

/// The notes of a trade on a pool on the curve. `pool` is the pool as it stands now.
function curveNotes(pool, graduates, isBuy, pastTarget) {
  const notes = [];
  notes.push("This coin trades on the curve. Its price counts " + formatUnits(pool.virtualQuote, 9) + " SOL of virtual SOL that the pool does not hold.");
  notes.push("The pool holds " + formatUnits(pool.reserveQuote, 9) + " SOL of real SOL. It graduates at " + formatUnits(pool.graduationTarget, 9) + " SOL." + (isBuy || pastTarget ? "" : " A sell is paid from the real SOL only."));
  if (pastTarget) {
    notes.push("The pool stands past its graduation target, so this transaction graduates it before the trade. The trade runs on the graduated pool, whoever graduates it first, and this quote is that pool's.");
    notes.push("Graduation drops the virtual SOL and burns coins from the pool, so the price stays where it is. Liquidity opens after it.");
  } else if (graduates) {
    notes.push("This trade takes the pool to its graduation target, so the transaction ends with graduate.");
    notes.push("Graduation drops the virtual SOL and burns coins from the pool, so the price stays where it is. Liquidity opens after it.");
  }
  return notes;
}

/// The quote as the API answers it. `ctx` comes from loadTrade. On a strict coin
/// `ctx.checked` is the wallet the coin's rules are checked for (the receiver of a buy, the
/// seller of a sell), `ctx.recipient` the receiver named by a swap, and `ctx.opens` whether
/// /swap puts `open_holder` in front.
async function makeQuote(ctx, p) {
  const { client, pool, platform, hook, known, slot } = ctx;
  if (platform.paused) throw new ApiError(503, "TRADING_PAUSED", "Trading is paused on Programmable.");
  const isBuy = p.side === "buy";
  const direction = isBuy ? H.DIRECTION.BUY : H.DIRECTION.SELL;
  // A rules coin may limit what one buy spends for its first slots. The pool would refuse
  // a larger buy, so it is refused here, in words, before anything is quoted or built.
  const rules = hook && hook.rules ? hook.rules : null;
  const buyLimit = rules && isBuy ? H.rulesBuyLimit(rules, BigInt(slot)) : null;
  if (buyLimit && p.amount > buyLimit.maxBuyQuote) {
    throw new ApiError(422, "BUY_LIMIT_EXCEEDED",
      "This coin has a buy limit. One buy can spend at most " + buyLimit.maxBuyQuote + " lamports (" + formatUnits(buyLimit.maxBuyQuote, 9) + " SOL) until slot " + buyLimit.untilSlot
      + ", in about " + secondsOf(buyLimit.untilSlot - BigInt(slot)) + " seconds. This buy sends " + p.amount + " lamports. Send a smaller amount, or wait until the limit ends.",
      { maxAmount: buyLimit.maxBuyQuote.toString(), endsAtSlot: Number(buyLimit.untilSlot) });
  }
  // A strict coin checks its rules against the wallet that receives a buy or makes a sell.
  // Everything the SDK reads for that came in the same RPC call as the pool.
  const strict = rules && rules.kind === H.RULES_KIND.STRICT ? rules : null;
  const bslot = BigInt(slot);
  const unixTime = ctx.holders && ctx.holders.clock ? ctx.holders.clock.unixTime : BigInt(Math.floor(Date.now() / 1000));
  const w = strict && ctx.checked ? ctx.holders.get(ctx.checked.toBase58()) || null : null;
  if (strict && isBuy && ctx.recipient && w && !w.record && H.strictEarlyWindowRuns(strict, bslot)) throw holderRecordRequired(ctx.recipient, H.strictWindows(strict).earlyUntil, bslot);
  // The sniper fee of a rules coin is the launch guard's line: a pool fee on buys that falls
  // every slot of the window. A buy that lands later gives more than the quote of this slot.
  const sniperRunning = !!rules && isBuy && H.rulesSniperFee(bslot, rules.startSlot, rules.sniperSlots, rules.sniperStartFeeBps, pool.lpFeeBps) !== null;
  // A pool on the curve that stands at or past its target: the transaction graduates it before the trade, so
  // the trade is quoted on the graduated pool (`qp`). Every other pool is quoted as it stands.
  const onCurve = H.isOnCurve(pool);
  const pastTarget = H.readyToGraduate(pool);
  const qp = H.poolAfterGraduation(pool);
  // The most a buy can give on this pool: at the pool's normal fee, which is what the chain
  // pays once the sniper fee is gone. The max wallet is judged against it (see buyOutAtBaseFee).
  const outAt = (amount) => buyOutAtBaseFee(qp, platform, hook, amount);
  const refusal = (e) => strictError(e, { rules: strict, w, slot: bslot, unixTime, isBuy, out: outAt(p.amount), amount: p.amount, outAt, falling: sniperRunning, recipient: ctx.recipient });
  if (strict && isBuy && w && H.strictMaxWalletRuns(strict, bslot)) {
    const most = outAt(p.amount);
    if (most > 0n && w.balance + most > strict.maxWalletAmount) throw await refusal({ number: 6044 });
  }
  let q;
  // the slot is given, so the SDK quotes from memory: no RPC call here
  try { q = await client.quoteLocal(pool, platform, direction, p.amount, hook, bslot, w ? w.address : undefined); } catch (e) {
    // a sell on the curve that would take more than the real SOL of the pool
    if (e instanceof H.CurveRefusal && e.number === 6049) {
      throw curveRealReserveError(qp, {
        direction, reserveBase: qp.reserveBase, reserveQuote: qp.reserveQuote, virtualQuote: qp.virtualQuote, lpFeeBps: qp.lpFeeBps,
        protocolFeeBps: platform.protocolFeeBps, hookFeeBps: hookFeeBpsOf(hook, isBuy, platform), feeOverrideBps: null,
      }, p.amount);
    }
    if (e instanceof H.CurveRefusal) throw new ApiError(422, "CANNOT_QUOTE", "The pool refuses this trade: " + e.message + ".");
    if (!(e instanceof H.StrictRefusal)) throw quoteError(e);
    throw await refusal(e);
  }
  if (q.reserveInAfter > U64_MAX) throw new ApiError(422, "CANNOT_QUOTE", "The amount is too large for this pool.");

  const base = pool.baseMint.toBase58();
  const sol = pool.quoteMint.toBase58();
  const inMint = isBuy ? sol : base;
  const dec = known.coin.decimals;
  // The price of any pool is (reserveQuote + virtualQuote) / reserveBase: on a pool on the curve the virtual
  // SOL counts. The reserves after a trade are the real ones; the virtual part is added back. A trade that
  // graduates the pool keeps that price: graduation burns coins to hold it. Both prices are those of the pool
  // the trade is quoted on (the graduated one, past the target, whose price is the pool's now).
  const priceOf = (reserveQuote, reserveBase) => ratioDecimal((reserveQuote + qp.virtualQuote) * 10n ** BigInt(dec), reserveBase * 10n ** 9n);
  const [quoteAfter, baseAfter] = isBuy ? [q.reserveInAfter, q.reserveOutAfter] : [q.reserveOutAfter, q.reserveInAfter];

  const guard = hook && hook.guard ? hook.guard : null;
  const guardRunning = !!guard && isBuy && H.guardFee(BigInt(slot), guard.startSlot, guard.guardSlots, guard.startFeeBps, pool.lpFeeBps) !== null;
  const custom = !!hook && hook.template === "custom";
  // A custom hook can change the amounts of a trade only where the pool asks it before the
  // swap, on this direction, and its flags grant it a fee, a fee override or the curve.
  const F = H.FLAGS;
  const directionFlag = isBuy ? F.CALL_ON_BUY : F.CALL_ON_SELL;
  const customCalled = custom && (pool.hookFlags & directionFlag) !== 0 && (pool.hookFlags & (F.BEFORE_SWAP | F.AFTER_SWAP)) !== 0;
  const customChanges = custom && (pool.hookFlags & directionFlag) !== 0 && (pool.hookFlags & F.BEFORE_SWAP) !== 0
    && (pool.hookFlags & (F.TAKE_HOOK_FEE | F.OVERRIDE_FEE | F.OVERRIDE_CURVE)) !== 0;
  const pegged = !!(hook && hook.collectible && hook.collectible.pegged);

  // The curve. Past the target, the transaction graduates the pool first, whatever the trade. Under it, a buy
  // that takes the pool to its target ends with `graduate` (willGraduate on the quote). A custom hook may take
  // a fee on a buy that the quote does not know, and a buy that falls short of the target would make the
  // appended graduate fail the trade: on such a hook a buy graduates only when it reaches the target even with
  // the platform's whole hook fee taken, as the SDK does. The fee override of a hook changes nothing here: the
  // pool fee stays in the real reserve.
  let graduates = onCurve && !!q.graduates;
  const graduateFirst = graduates && !!q.graduateFirst;
  if (graduates && !graduateFirst && isBuy && customChanges && (pool.hookFlags & F.TAKE_HOOK_FEE) !== 0) {
    let worst = null;
    try {
      worst = H.quoteSwap({
        direction, amountIn: p.amount, reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: pool.virtualQuote, lpFeeBps: pool.lpFeeBps,
        protocolFeeBps: platform.protocolFeeBps, hookFeeBps: platform.maxHookFeeBps, feeOverrideBps: null,
      });
    } catch (_) { worst = null; }
    if (!worst || !H.willGraduate(pool, direction, worst)) graduates = false;
  }
  // The floor is the caller's slippage on the quote, always: on the curve, on the graduated pool, anywhere.
  // Nothing lowers it.
  const exact = !customChanges && !guardRunning && !sniperRunning;

  const notes = [];
  if (sniperRunning) {
    const end = rules.startSlot + rules.sniperSlots;
    notes.push("A sniper fee is running on this coin. Buys pay a pool fee of " + pctOfBps(q.feeBpsApplied) + "% at slot " + slot + ". Sells do not pay it.");
    notes.push("The fee falls every slot. It is back to " + pctOfBps(pool.lpFeeBps) + "% at slot " + end + ", in about " + secondsOf(end - BigInt(slot)) + " seconds.");
    notes.push("This quote uses the fee of slot " + slot + ". A trade that lands later gives the same amount or more.");
  }
  if (buyLimit) {
    notes.push("A buy limit is running on this coin. One buy can spend at most " + buyLimit.maxBuyQuote + " lamports (" + formatUnits(buyLimit.maxBuyQuote, 9) + " SOL). The limit ends at slot " + buyLimit.untilSlot
      + ", in about " + secondsOf(buyLimit.untilSlot - BigInt(slot)) + " seconds. Sells are never limited.");
  }
  if (rules) notes.push(...rulesShareNotes(rules, isBuy, platform));
  // the most this buy can give: the SDK's ceiling (the quote at the pool's own fee inside the sniper window,
  // the quote itself outside it), the same number as outAt when the SDK does not carry it
  const mostOut = typeof q.amountOutCeiling === "bigint" ? q.amountOutCeiling : sniperRunning ? outAt(p.amount) : q.amountOut;
  const strictView = strict ? strictPart(strict, { isBuy, out: mostOut, amount: p.amount, slot: bslot, unixTime, w, opens: !!ctx.opens && !!w && !w.record, falling: sniperRunning, rent: ctx.rent }) : null;
  if (strictView) notes.push(...strictView.notes);
  if (guardRunning) {
    const end = guard.startSlot + guard.guardSlots;
    const left = end - BigInt(slot);
    notes.push("A launch guard is running on this pool. Buys pay a pool fee of " + pctOfBps(q.feeBpsApplied) + "% at slot " + slot + ".");
    notes.push("The fee falls every slot. It is back to " + pctOfBps(pool.lpFeeBps) + "% at slot " + end + ", in about " + Math.ceil(Number(left) * 0.4) + " seconds.");
    notes.push("This quote uses the fee of slot " + slot + ". A trade that lands later gives the same amount or more.");
  }
  if (hook && hook.tax) {
    notes.push("This coin has a tax of " + pctOfBps(hook.tax.buyBps) + "% on buys and " + pctOfBps(hook.tax.sellBps) + "% on sells, taken in SOL for the coin's treasury. The quote includes it.");
    notes.push(hook.tax.renounced ? "The tax can never change." : "The owner of the tax can change it, up to " + pctOfBps(hook.tax.maxBps) + "%.");
  }
  if (hook && hook.buyback) {
    notes.push("A fee of " + pctOfBps(hook.buyback.buyBps) + "% on buys and " + pctOfBps(hook.buyback.sellBps) + "% on sells funds buybacks of this coin. The quote includes it.");
  }
  if (pool.hasHook && pool.hookFeesOwedQuote > 0n) {
    notes.push("The account that receives this coin's fee did not exist at an earlier trade. " + pool.hookFeesOwedQuote + " lamports of fees wait in the pool and are paid when it is back. What a trader pays and receives is the same.");
  }
  // One approval: what a buy that earns pieces adds to the deposit for their NFTs (the SDK's mintDepositFor),
  // for a wallet with nothing waiting and no deposit yet. /swap answers the exact amount for its wallet.
  let mintDeposit = null;
  if (hook && hook.collectible) {
    const c = hook.collectible;
    if (isBuy) {
      const earns = col.piecesEarned(c, null, q.amountOut);
      const lamports = col.mintDepositFor(ctx.rent, c, earns);
      mintDeposit = { pieces: earns, lamports: lamports.toString(), included: earns > 0 };
      notes.push("This is a collectible coin. A buy earns one piece for every " + formatUnits(c.unit, dec) + " coins received, at most " + c.maxPerBuy + " per buy.");
      notes.push(earns > 0 ? "This buy earns up to " + earns + (earns === 1 ? " piece." : " pieces.") : "This buy earns no piece.");
      if (earns > 0) notes.push(DEPOSIT_NOTE + " " + lamports + " lamports for " + (earns === 1 ? "its NFT" : "their NFTs") + " to the buy. A keeper mints " + (earns === 1 ? "it" : "them") + " into the wallet a few seconds after the buy and is paid back from that deposit. With mintDeposit false the wallet mints " + (earns === 1 ? "it" : "them") + " itself.");
    } else {
      notes.push("This is a collectible coin. A sell burns the pieces the wallet's coins no longer back, the last piece first.");
    }
    if (pegged) notes.push("This is a pegged coin. Its pieces move or burn inside every transfer of the coin.");
  }
  if (custom && customChanges) {
    const sum = hook.summary;
    notes.push("This pool runs a custom hook. This quote assumes the hook takes nothing.");
    if (sum.canTakeFee) notes.push("The hook can take a fee of up to " + pctOfBps(platform.maxHookFeeBps) + "%.");
    if (sum.canOverrideFee) notes.push("The hook can change the pool fee, up to " + pctOfBps(platform.maxFeeOverrideBps) + "%.");
    if (sum.canOverrideCurve) notes.push("The hook sets the price itself.");
    notes.push("/api/v1/swap asks the chain and answers the real output.");
  } else if (custom) {
    notes.push(customCalled
      ? "This pool runs a custom hook. It cannot change the amounts of this trade. It can refuse it."
      : "This pool runs a custom hook. The pool does not call it on this trade.");
  }
  if (onCurve) notes.push(...curveNotes(pool, graduates, isBuy, pastTarget));

  return {
    pool: pool.address.toBase58(),
    side: p.side,
    inputMint: inMint,
    outputMint: isBuy ? base : sol,
    inAmount: p.amount.toString(),
    outAmount: q.amountOut.toString(),
    minOutAmount: minOutAfterSlippage(q.amountOut, p.slippageBps).toString(),
    slippageBps: p.slippageBps,
    priceBefore: priceOf(qp.reserveQuote, qp.reserveBase),
    priceAfter: priceOf(quoteAfter, baseAfter),
    priceImpactPct: (q.impactBps / 100).toFixed(2),
    fees: {
      protocol: { amount: q.protocolFee.toString(), mint: inMint, bps: platform.protocolFeeBps },
      pool: { amount: q.lpFee.toString(), mint: inMint, bps: q.feeBpsApplied },
      hook: { amount: q.hookFee.toString(), mint: sol, bps: hookFeeBpsOf(hook, isBuy, platform) },
    },
    hook: hook ? {
      program: hook.program.toBase58(),
      template: hook.template,
      kind: pool.hookKind === H.HOOK_KIND.PLATFORM ? "platform" : "frozen",
      runsOnBuys: hook.summary.runsOnBuys,
      // a pegged coin's own transfer hook is the same program and runs inside the sell
      runsOnSells: hook.summary.runsOnSells || pegged,
      // launch rules only: the three rates of this side as the coin's rules set them, and
      // the two windows where they touch this trade (both touch buys only)
      ...(rules ? {
        rules: {
          creatorBps: H.rulesSideRates(rules, direction).creatorBps, holdersBps: H.rulesSideRates(rules, direction).holdersBps, burnBps: H.rulesSideRates(rules, direction).burnBps,
          sniperEndsAtSlot: sniperRunning ? Number(rules.startSlot + rules.sniperSlots) : null,
          buyLimit: buyLimit ? { maxAmount: buyLimit.maxBuyQuote.toString(), endsAtSlot: Number(buyLimit.untilSlot) } : null,
          // the strict coin: its windows, and the checked wallet when the caller named one
          strict: strictView ? strictView.strict : null,
        },
      } : {}),
    } : null,
    coin: {
      mint: known.coin.mint, symbol: known.coin.symbol, name: known.coin.name, decimals: dec, tokenProgram: known.coin.tokenProgram,
      collectible: hook && hook.collectible ? { kind: pegged ? "pegged" : "plain", unit: hook.collectible.unit.toString(), maxPerBuy: hook.collectible.maxPerBuy } : null,
    },
    // a buy of a collectible coin: the pieces it earns, and the deposit for their NFTs the swap adds to it
    mintDeposit,
    curve: curvePart(pool, ctx.supply ?? null, graduates, graduateFirst),
    exact,
    slot,
    notes,
  };
}

function defaults() {
  return { connection: connection(), lookupTable: settings().lookupTable };
}

/// GET /api/v1/quote. `p` comes from parseQuoteParams. `deps` is for tests.
export async function quote(p, deps = defaults()) {
  // `userPublicKey` is optional here. On a strict coin the quote then checks the coin's rules
  // against that wallet, as /swap does, and says what its coins will be after the trade.
  const wallet = p.userPublicKey ? new PublicKey(p.userPublicKey) : null;
  const ctx = await loadTrade(deps, p, null, wallet ? [wallet] : []);
  ctx.checked = wallet;
  ctx.recipient = null;
  ctx.opens = !!wallet && p.side === "buy";
  const out = await makeQuote(ctx, p);
  return { body: out, rpcCalls: ctx.scope.calls() };
}

// ---- the swap ---------------------------------------------------------------------------------

const startsWith = (data, disc) => data.length >= disc.length && disc.every((b, i) => data[i] === b);
/// The pool's swap instruction (not its graduate).
const isSwapIx = (i) => i.programId.equals(H.PROGRAMS.hookpool) && startsWith(Buffer.from(i.data), H.IX.hookpool.swap);

/// What one instruction of a built swap is, or null for anything this API never hands out.
/// The transaction may hold only: compute budget, creation of token accounts, the buyer's
/// ticket, wrapping and unwrapping of SOL, the swap, the peg upkeep of a sell, and the `graduate` of a
/// pool on the curve that the trade takes to its target (after the swap) or that stands past it (before).
/// A template's own instructions (a buyback, a burn, a stake, a claim, a lock) are never
/// part of a trade: none of them is named here, so none can leave this server.
/// Exported for the unit tests.
export function instructionKind(ins, t) {
  const pid = ins.programId;
  const d = Buffer.from(ins.data);
  const key = (i) => (ins.keys[i] ? ins.keys[i].pubkey : null);
  const is = (i, k) => !!key(i) && key(i).equals(k);
  if (pid.equals(H.ComputeBudgetProgram.programId)) return d[0] === 2 ? "compute_unit_limit" : d[0] === 3 ? "compute_unit_price" : null;
  if (pid.equals(H.ATA_PROGRAM)) {
    const owner = key(2); const mint = key(3);
    const okOwner = !!owner && (owner.equals(t.user) || (!!t.recipient && owner.equals(t.recipient)));
    const okMint = !!mint && (mint.equals(t.pool.baseMint) || mint.equals(t.pool.quoteMint));
    return d.length === 1 && d[0] === 1 && is(0, t.user) && okOwner && okMint ? "create_token_account" : null;
  }
  if (pid.equals(H.SYSTEM_PROGRAM)) {
    const transfer = d.length === 12 && d.readUInt32LE(0) === 2 && t.isBuy && is(0, t.user);
    if (transfer && d.readBigUInt64LE(4) === t.amount && is(1, t.userWsol)) return "wrap_sol";
    // one approval: the deposit for the NFTs of a collectible buy, from the signer to its own ticket on this
    // pool, of exactly the amount this server worked out
    if (transfer && t.collectible && !t.recipient && typeof t.deposit === "bigint" && t.deposit > 0n && d.readBigUInt64LE(4) === t.deposit && is(1, col.collectiblePda.ticket(t.pool.address, t.user))) return "mint_deposit";
    return null;
  }
  if (pid.equals(H.TOKEN_PROGRAM)) {
    if (d.length === 1 && d[0] === 17 && is(0, t.userWsol)) return "sync_wrapped_sol";
    if (d.length === 1 && d[0] === 9 && is(0, t.userWsol) && (is(1, t.user) || (!!t.recipient && is(1, t.recipient))) && is(2, t.user)) return "unwrap_sol";
    return null;
  }
  if (pid.equals(H.PROGRAMS.hookpool)) {
    // A pool on the curve: `graduate` of this pool, after a trade that leaves it at or past its target. It
    // takes no signer and no argument, and moves nothing of the wallet's.
    if (startsWith(d, H.IX.hookpool.graduate)) {
      const ok = !!t.graduate && d.length === 8 && ins.keys.length === 7 && ins.keys.every((m) => !m.isSigner)
        && is(0, PLATFORM_KEY) && is(1, t.pool.address) && is(2, t.pool.baseMint) && is(3, t.pool.baseVault) && is(4, t.pool.baseTokenProgram)
        && is(5, H.pda.eventAuthority(H.PROGRAMS.hookpool)) && is(6, H.PROGRAMS.hookpool);
      return ok ? "graduate" : null;
    }
    const ok = startsWith(d, H.IX.hookpool.swap) && d.length === 25 && d[8] === t.direction && d.readBigUInt64LE(9) === t.amount && d.readBigUInt64LE(17) === t.minOut && is(0, t.user);
    // This pool, its own hook program, and the address the pool signs that hook's callbacks
    // with: one per hook program (the system program stands for "no hook").
    const own = is(2, t.pool.address) && is(10, t.pool.hookProgram) && is(12, H.pda.caller(t.pool.hookProgram)[0]);
    return ok && own ? "swap" : null;
  }
  // A strict coin: the signer's own holder record, opened in front of its buy, on this pool.
  if (pid.equals(H.PROGRAMS.hook_rules) && t.strict) {
    const ok = startsWith(d, H.IX.hook_rules.open_holder) && d.length === 8 && t.isBuy && is(0, t.user) && !!ins.keys[0] && ins.keys[0].isSigner
      && is(1, H.rulesPda.cfg(t.pool.address)) && is(2, t.pool.address) && is(3, H.rulesPda.holder(t.pool.address, t.user)) && ins.keys.length === 6;
    return ok ? "open_holder" : null;
  }
  if (pid.equals(H.PROGRAMS.hook_collectible) && t.collectible) {
    if (startsWith(d, H.IX.hook_collectible.open_ticket) && t.isBuy && is(0, t.user)) return "open_ticket";
    if (startsWith(d, H.IX.hook_collectible.mint) && t.isBuy) return "mint_pieces";
    if (startsWith(d, H.IX.hook_collectible.settle) && !t.isBuy) return "settle";
    if (startsWith(d, H.IX.hook_collectible.reap) && !t.isBuy) return "reap";
  }
  return null;
}

const tokenAmountOf = (info, tokenProgram) => info && info.owner.equals(tokenProgram) && info.data.length >= 72 ? H.decodeTokenAmount(new Uint8Array(info.data)) : 0n;

/// The amount the pool paid out in a simulated transaction: the Swapped event of this pool
/// in the inner instructions. null when the RPC node did not return inner instructions.
function simulatedOut(value, poolKey) {
  for (const group of value.innerInstructions || []) {
    for (const ins of (group && group.instructions) || []) {
      if (!ins || typeof ins.data !== "string" || !ins.programId || String(ins.programId) !== HOOKPOOL_ID) continue;
      const bytes = base58Decode(ins.data, 600);
      if (!bytes || bytes.length < 16 || !H.EVENT_IX_TAG.every((b, i) => bytes[i] === b)) continue;
      try {
        const ev = H.decodeEvent(bytes.subarray(8));
        if (ev && ev.kind === "Swapped" && ev.pool.equals(poolKey)) return ev.amountOut;
      } catch (_) { /* not an event of ours */ }
    }
  }
  return null;
}

/// POST /api/v1/swap. `p` comes from parseSwapParams. `deps` is for tests.
export async function swap(p, deps = defaults()) {
  const user = new PublicKey(p.userPublicKey);
  const recipient = p.recipient ? new PublicKey(p.recipient) : null;
  const isBuy = p.side === "buy";
  const direction = isBuy ? H.DIRECTION.BUY : H.DIRECTION.SELL;
  const userWsol = H.pda.ata(user, H.NATIVE_MINT);
  // The wallet itself, and the three accounts the SDK reads to build the swap. They ride in
  // the same RPC call as the pool, so building costs no further account read.
  const walletKeys = (poolKey, known) => [user, H.pda.ata(user, known.baseMint, known.baseTokenProgram), userWsol, col.collectiblePda.ticket(poolKey, user), ...(recipient ? [recipient, H.pda.ata(recipient, known.baseMint, known.baseTokenProgram)] : [])];
  // On a strict coin the rules are checked for the wallet that receives a buy and for the
  // wallet that makes a sell. The SDK opens the signer's holder record in front of its buy.
  const checked = isBuy && recipient ? recipient : user;
  const ctx = await loadTrade(deps, p, walletKeys, [checked]);
  ctx.checked = checked;
  ctx.recipient = isBuy ? recipient : null;
  ctx.opens = isBuy && !recipient;
  const { scope, client, pool, hook } = ctx;
  const [walletInfo, baseInfo, wsolInfo, ticketInfo, recipientInfo, recipientBaseInfo] = ctx.wallet;
  // The output goes to the recipient's associated token account. A token account, a mint
  // or a program given by mistake would strand it, so only a wallet is taken: an address
  // that holds nothing yet, or one the system program owns.
  if (recipient && recipientInfo && !recipientInfo.owner.equals(H.SYSTEM_PROGRAM)) {
    throw new ApiError(400, "INVALID_PARAMETER", "recipient must be a wallet address. This one is a token account, a mint or a program.", { parameter: "recipient" });
  }
  const q = await makeQuote(ctx, p);
  let outAmount = BigInt(q.outAmount);
  // the quote's general sentence about the deposit gives way to this wallet's own below
  const notes = q.notes.filter((n) => !n.startsWith(DEPOSIT_NOTE));
  // The wallet's ticket on a collectible pool: its pieces, and the deposit it holds above its rent.
  const ticket = ticketInfo && ticketInfo.data.length > 0 && hook && hook.collectible ? safely(() => col.decodeTicket(new Uint8Array(ticketInfo.data))) : null;
  const held = ticket ? col.depositOf(ticketInfo.lamports, ticketInfo.data.length, ctx.rent) : 0n;
  // One approval: a buy that earns pieces adds the deposit for their NFTs, right after the swap, unless the
  // caller sends mintDeposit false. It covers every piece the wallet will have waiting (the SDK's
  // mintDepositTopUp); a keeper then mints them into the wallet and is paid back from it. A buy for another
  // wallet earns no piece and adds nothing.
  let deposit = null;
  if (isBuy && hook && hook.collectible) {
    // a ticket whose four batches all hold unminted pieces earns nothing until they are minted
    const full = !!ticket && ticket.batches.every((b) => b.pieces > 0);
    const pieces = recipient || full ? 0 : col.piecesEarned(hook.collectible, ticket, outAmount);
    const topUp = pieces > 0 ? col.mintDepositTopUp(ctx.rent, hook.collectible, ticket, held, pieces) : 0n;
    deposit = { pieces, topUp, add: p.mintDeposit && topUp > 0n, covered: pieces > 0 && topUp === 0n, keeper: pieces > 0 && p.mintDeposit };
    q.mintDeposit = { pieces, lamports: (deposit.add ? topUp : 0n).toString(), included: deposit.add };
  }

  // the floor the chain enforces: the caller's own, or the quote less the slippage
  let minOut = BigInt(q.minOutAmount);
  if (p.minOutAmount !== null) {
    if (outAmount < p.minOutAmount) {
      throw new ApiError(422, "SLIPPAGE_EXCEEDED", "The price moved. The trade would now give " + outAmount + ", below your minOutAmount of " + p.minOutAmount + ".");
    }
    minOut = p.minOutAmount;
    q.minOutAmount = minOut.toString();
  }

  // A wallet that cannot pay is told so here, in words. A buy takes, at its peak, the amount,
  // the network fee, the rent of every account the transaction creates (the coin's token
  // account of the receiver, a wrapped SOL account for the length of the transaction, the
  // signer's holder record on a strict coin), all paid before the swap runs.
  const lamports = walletInfo ? BigInt(walletInfo.lamports) : 0n;
  const coins = tokenAmountOf(baseInfo, pool.baseTokenProgram);
  const treasuryIsWallet = pool.hookQuoteTreasury.equals(userWsol);
  // what the wallet must hold: checked here, before anything is built, and once more with the priority fee
  // when the compute limit of the built transaction is known
  const costs = isBuy ? [[p.amount, "for the buy"], [SIGNATURE_FEE, "for the network fee"]] : [[SIGNATURE_FEE, "for the network fee"]];
  if (isBuy) {
    const receiverBaseInfo = recipient ? recipientBaseInfo : baseInfo;
    if (!receiverBaseInfo) costs.push([tokenAccountRent(ctx.rent, pool.baseTokenProgram), "for the rent of " + (recipient ? "the recipient's" : "its") + " token account for this coin"]);
    if (!wsolInfo && !treasuryIsWallet) costs.push([ctx.rent(TOKEN_ACCOUNT_SIZE), "for the rent of a wrapped SOL account, which comes back at the end of the transaction"]);
    const holder = ctx.holders && ctx.holders.get(user.toBase58());
    if (hook && hook.rules && hook.rules.kind === H.RULES_KIND.STRICT && !recipient && holder && !holder.record) costs.push([ctx.rent(H.HOLDER_RECORD_SIZE), "for the rent of its holder record, which comes back when the record is closed"]);
    if (deposit && deposit.add) costs.push([deposit.topUp, "for the deposit for the NFTs of its pieces, what is left of it stays the wallet's"]);
    const need = costs.reduce((n, [v]) => n + v, 0n);
    if (lamports < need) {
      throw new ApiError(422, "INSUFFICIENT_FUNDS", "The wallet holds " + lamports + " lamports. This buy needs " + need + ": " + costs.map(([v, what]) => v + " " + what).join(", ") + ".");
    }
  }
  if (!isBuy && coins < p.amount) {
    throw new ApiError(422, "INSUFFICIENT_FUNDS", "The wallet holds " + coins + " units of this coin. This sell sends " + p.amount + ".");
  }
  if (!isBuy && lamports < SIGNATURE_FEE) {
    throw new ApiError(422, "INSUFFICIENT_FUNDS", "The wallet holds too little SOL to pay the network fee.");
  }
  // The SDK leaves the signer's wrapped SOL account as it was found: one that was open
  // before the trade is never closed (it may be the fee treasury of a coin), and nothing
  // the signer already held in it moves.
  const wsolStays = treasuryIsWallet || !!wsolInfo;

  // A pool on the curve: the quote says whether the transaction graduates the pool (q.curve.graduates) and
  // whether the graduate comes FIRST (q.curve.graduateFirst: the pool stands at or past its target, the trade
  // runs on the graduated pool it was quoted on) or right after the swap (a buy that takes the pool to its
  // target). The SDK's swapInstructions is told with `graduate`, so it reads nothing more to decide, places it
  // that way, and sends the floor it is given: the quote's minOutAmount, which nothing lowers.
  const graduates = !!(q.curve && q.curve.graduates);
  const graduateFirst = graduates && !!q.curve.graduateFirst;
  const buildOpts = { ...(recipient ? { recipient } : {}), graduate: graduates };

  // A custom hook that may change the amounts: no quote from memory knows its answer, and a
  // floor taken from one would make the transaction fail. Ask the chain first: the same
  // swap with no floor, simulated, says what the trade really gives.
  if (!q.exact && hook && hook.template === "custom") {
    let probe;
    try {
      const hookRef = await client.hookRef(pool, user);
      // the probe runs up to the swap, the graduate in front of it included: past the target the trade runs on
      // the graduated pool
      const all = await client.swapInstructions(user, pool, hookRef, direction, p.amount, 0n, buildOpts);
      const at = all.findIndex(isSwapIx);
      probe = await client.buildTx(user, all.slice(0, at + 1));
    } catch (e) {
      if (e instanceof ApiError) throw e;
      console.error("[trade-api] probe: " + scrub(e));
      throw new ApiError(422, "UNSUPPORTED_POOL", "The accounts of this pool's hook could not be resolved, so the trade cannot be built.");
    }
    const sim = await scope.conn.simulateTransaction(probe.tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true });
    if (sim.value.err) {
      const why = explainSimulationError(sim.value.err, sim.value.logs);
      throw new ApiError(why.code === "TRADING_PAUSED" ? 503 : 422, why.code, why.message, why.programError ? { programError: why.programError } : undefined);
    }
    const real = simulatedOut(sim.value, pool.address);
    if (real !== null) {
      outAmount = real;
      q.outAmount = real.toString();
      if (p.minOutAmount === null) {
        minOut = minOutAfterSlippage(real, p.slippageBps);
        q.minOutAmount = minOut.toString();
        notes.push("The output and the minimum of this answer come from a simulation of the trade, not from the formula.");
      } else {
        // the caller's own floor stays; one the hook already puts out of reach is refused here
        if (real < p.minOutAmount) {
          throw new ApiError(422, "SLIPPAGE_EXCEEDED", "The trade would give " + real + " after this pool's hook, below your minOutAmount of " + p.minOutAmount + ".");
        }
        notes.push("The output of this answer comes from a simulation of the trade, not from the formula. The minimum is the one you sent.");
      }
    }
  }

  let ixs;
  try {
    const hookRef = await client.hookRef(pool, user);
    // the coin graduates in the same transaction; a graduate that comes after somebody else's lands and
    // changes nothing
    ixs = await client.swapInstructions(user, pool, hookRef, direction, p.amount, minOut, buildOpts);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // the SDK refuses a buy for a recipient without a holder record in a strict coin's early window
    if (e instanceof H.StrictRefusal && e.number === 6047 && hook && hook.rules) throw holderRecordRequired(recipient, H.strictWindows(hook.rules).earlyUntil, BigInt(ctx.slot));
    console.error("[trade-api] build: " + scrub(e));
    throw new ApiError(422, "UNSUPPORTED_POOL", "The accounts of this pool's hook could not be resolved, so the trade cannot be built.");
  }

  // Only what the caller asked for goes into the transaction. A buy never mints: an SDK that
  // still put a mint of earlier pieces into a buy would make the buy fail whenever somebody
  // minted them first, so such a mint is taken out here. Anything this code does not know
  // stops the request.
  const target = { user, recipient, pool, userWsol, amount: p.amount, minOut, direction, isBuy, collectible: !!(hook && hook.collectible), strict: !!(hook && hook.rules && hook.rules.kind === H.RULES_KIND.STRICT), graduate: graduates, deposit: deposit && deposit.add ? deposit.topUp : 0n };
  const kinds = [];
  const kept = [];
  for (const ins of ixs) {
    const kind = instructionKind(ins, target);
    if (!kind) { console.error("[trade-api] refused an instruction of program " + ins.programId.toBase58()); throw new Error("unexpected instruction"); }
    if (kind === "mint_pieces") continue;
    kinds.push(kind); kept.push(ins);
  }
  // the deposit goes right after the swap (and after the graduate that follows it): the ticket is open by then
  if (deposit && deposit.add) {
    let at = kept.findIndex(isSwapIx) + 1;
    if (kinds[at] === "graduate") at += 1;
    const ins = col.depositTransfer(user, pool.address, deposit.topUp);
    if (instructionKind(ins, target) !== "mint_deposit") throw new Error("unexpected instruction");
    kept.splice(at, 0, ins); kinds.splice(at, 0, "mint_deposit");
  }
  // A swap that ends with `graduate` asks for the compute of both: the priority fee, which is the limit times
  // the price, counts the graduation too.
  const limitAt = kept.findIndex((i) => i.programId.equals(H.ComputeBudgetProgram.programId) && i.data[0] === 2);
  if (graduates && limitAt >= 0) {
    kept[limitAt] = H.ComputeBudgetProgram.setComputeUnitLimit({ units: Buffer.from(kept[limitAt].data).readUInt32LE(1) + GRADUATE_COMPUTE_UNITS });
  }
  if (p.computeUnitPriceMicroLamports > 0) {
    kept.splice(1, 0, H.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.computeUnitPriceMicroLamports }));
    kinds.splice(1, 0, "compute_unit_price");
  }
  const limitIx = kept.find((i) => i.programId.equals(H.ComputeBudgetProgram.programId) && i.data[0] === 2);
  const computeUnitLimit = limitIx ? Buffer.from(limitIx.data).readUInt32LE(1) : 200_000;
  // The priority fee is paid before the trade runs, like the network fee: a wallet that cannot pay it is told
  // so here, with every part of what the transaction takes.
  if (p.computeUnitPriceMicroLamports > 0) {
    const priority = (BigInt(computeUnitLimit) * BigInt(p.computeUnitPriceMicroLamports) + 999_999n) / 1_000_000n;
    const all = [...costs, [priority, "for the priority fee of " + computeUnitLimit + " compute units at " + p.computeUnitPriceMicroLamports + " micro-lamports"]];
    const need = all.reduce((n, [v]) => n + v, 0n);
    if (lamports < need) {
      throw new ApiError(422, "INSUFFICIENT_FUNDS", "The wallet holds " + lamports + " lamports. This " + (isBuy ? "buy" : "sell") + " needs " + need + ": " + all.map(([v, what]) => v + " " + what).join(", ") + ".");
    }
  }
  if (graduates) notes.push((graduateFirst ? "The transaction sends graduate right before the swap." : "The transaction sends graduate right after the swap.") + " Its compute limit is " + GRADUATE_COMPUTE_UNITS + " units higher for it.");

  // notes about this wallet
  if (hook && hook.collectible) {
    if (isBuy && recipient) notes.push("Pieces go to the wallet that signs. A buy for another wallet earns none.");
    if (isBuy && !recipient && !ticket) notes.push("The transaction opens the wallet's ticket for this coin. The wallet pays its rent once.");
    if (deposit && deposit.add) {
      notes.push("The transaction adds a deposit of " + deposit.topUp + " lamports to the wallet's ticket, after the swap, for the NFTs of " + (deposit.pieces === 1 ? "its piece" : "its " + deposit.pieces + " pieces") + ". A keeper mints them into the wallet a few seconds after the buy and is paid back from it. What is left stays the wallet's: it pays for later NFTs, or comes back with withdraw_deposit.");
    } else if (deposit && deposit.keeper && deposit.covered) {
      notes.push("The wallet's deposit already covers the NFTs of " + (deposit.pieces === 1 ? "its piece" : "its " + deposit.pieces + " pieces") + ". A keeper mints them into the wallet a few seconds after the buy.");
    } else if (deposit && deposit.pieces > 0 && !p.mintDeposit) {
      notes.push("mintDeposit is false, so the transaction adds no deposit. The wallet mints its pieces itself once their block is in, on the coin page or with the SDK's collectibleMintInstructions.");
    }
    if (isBuy && ticket && ticket.pending > 0) {
      const what = "This wallet has " + ticket.pending + (ticket.pending === 1 ? " piece" : " pieces") + " waiting from earlier buys.";
      notes.push(deposit && deposit.keeper ? what + " The deposit covers them too: a keeper mints them with the pieces of this buy." : what + " Mint them on the coin page.");
    }
    if (isBuy && !recipient && ticket && ticket.owned.length + ticket.pending >= col.MAX_PIECES_PER_WALLET) {
      notes.push("This wallet holds " + col.MAX_PIECES_PER_WALLET + " pieces of this coin, the most a wallet can. This buy earns none, whatever the quote's notes say.");
    } else if (isBuy && !recipient && ticket && ticket.batches.every((b) => b.pieces > 0)) {
      notes.push("The pieces of this wallet's last four buys are not minted yet, and a ticket holds no more than that. This buy earns none until they are minted, whatever the quote's notes say.");
    }
    if (!isBuy && ticket) {
      const backing = col.backingOf(baseInfo, user, pool.baseMint, pool.baseTokenProgram);
      const peg = col.pegStatus(ticket, backing > p.amount ? backing - p.amount : 0n, hook.collectible.unit);
      if (peg.burn.length > 0) notes.push("This sell burns " + peg.burn.length + (peg.burn.length === 1 ? " piece" : " pieces") + " of the wallet.");
      if (peg.dropWaiting > 0) notes.push("This sell drops " + peg.dropWaiting + (peg.dropWaiting === 1 ? " piece" : " pieces") + " that " + (peg.dropWaiting === 1 ? "was" : "were") + " not minted yet.");
      if (peg.burn.length > col.MAX_BURNS_PER_SETTLE) notes.push("The transaction burns " + col.MAX_BURNS_PER_SETTLE + " of them. The watcher burns the others within seconds.");
    }
  }
  if (isBuy && !recipient && !baseInfo) notes.push("The transaction creates the wallet's token account for this coin. The wallet pays its rent, about 0.002 SOL.");
  if (isBuy && recipient) notes.push("If the recipient has no token account for this coin, the transaction creates it and the signer pays its rent, about 0.002 SOL.");
  if (wsolStays && !isBuy) {
    const why = treasuryIsWallet ? "is this pool's fee treasury" : "was open before this trade";
    notes.push(recipient
      ? "The signer's wrapped SOL account " + why + " and stays open. The recipient receives wrapped SOL in its own token account."
      : "The wallet's wrapped SOL account " + why + " and stays open. The SOL of this sell arrives there as wrapped SOL.");
  } else if (wsolStays) {
    // a buy by a wallet that keeps a wrapped SOL account: the lamports of the buy are
    // wrapped and spent, the account and what it held stay as they were
  } else if (recipient && !isBuy) notes.push("The SOL reaches the recipient when the signer's wrapped SOL account is closed. The rent of that account, " + ctx.rent(TOKEN_ACCOUNT_SIZE) + " lamports, goes to the recipient too.");

  let built;
  const hasTable = !!deps.lookupTable;
  try {
    built = await client.buildTx(user, kept);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw tooLarge(e, hasTable);
  }
  const { tx, blockhash, lastValidBlockHeight } = built;
  let wire;
  try { wire = tx.serialize(); } catch (e) { throw tooLarge(e, hasTable); }
  if (wire.length > 1232) throw tooLarge(null, hasTable);
  // the caller is promised one signer: the wallet it named, which also pays
  if (tx.message.header.numRequiredSignatures !== 1 || !tx.message.staticAccountKeys[0].equals(user)) throw new Error("unexpected signer set");

  let simulation = null;
  if (p.simulate) {
    const sim = await scope.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", innerInstructions: true });
    if (sim.value.err) {
      const why = explainSimulationError(sim.value.err, sim.value.logs);
      throw new ApiError(why.code === "TRADING_PAUSED" ? 503 : 422, why.code, why.message, why.programError ? { programError: why.programError } : undefined);
    }
    const out = simulatedOut(sim.value, pool.address);
    simulation = { outAmount: out === null ? null : out.toString(), unitsConsumed: sim.value.unitsConsumed ?? null, slot: sim.context.slot };
  }

  return {
    body: {
      transaction: Buffer.from(wire).toString("base64"),
      blockhash,
      lastValidBlockHeight,
      userPublicKey: user.toBase58(),
      recipient: (recipient || user).toBase58(),
      instructions: kinds,
      computeUnitLimit,
      computeUnitPriceMicroLamports: p.computeUnitPriceMicroLamports,
      quote: q,
      simulation,
      notes,
    },
    rpcCalls: scope.calls(),
  };
}

function safely(f) { try { return f(); } catch (_) { return null; } }

/// A transaction over the 1232 bytes of a packet. With the platform's lookup table every
/// swap fits (the largest, a pegged sell that burns six pieces, is about 1080 bytes).
function tooLarge(e, hasTable) {
  if (e && !(e instanceof RangeError) && !/too large|encoding overruns|offset|out of range/i.test(String(e.message))) {
    console.error("[trade-api] compile: " + scrub(e));
    return new Error("could not compile the transaction");
  }
  return new ApiError(422, "TRANSACTION_TOO_LARGE", "The transaction does not fit in one Solana packet." + (hasTable ? "" : " This server has no lookup table for the platform."));
}

// ---- HTTP --------------------------------------------------------------------------------------

let limiters = null;
function limiterFor(route) {
  if (!limiters) {
    const s = settings();
    limiters = { quote: createRateLimiter({ limit: s.quoteLimit, windowMs: s.windowMs }), swap: createRateLimiter({ limit: s.swapLimit, windowMs: s.windowMs }) };
  }
  return limiters[route];
}

const bodyTooLarge = () => new ApiError(413, "BODY_TOO_LARGE", "The body is larger than " + MAX_BODY_BYTES + " bytes.");

/// The JSON body of a POST as an object, at most MAX_BODY_BYTES long.
export async function readJson(req) {
  if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) throw bodyTooLarge();
  if (req.readableEnded) {
    // a platform that read the stream itself (Vercel's helpers) leaves the result on req.body
    let b;
    try { b = req.body; } catch (_) { throw new ApiError(400, "INVALID_JSON", "The body is not JSON."); }
    if (Buffer.isBuffer(b)) b = b.toString("utf8");
    if (typeof b === "string") { if (b.length > MAX_BODY_BYTES) throw bodyTooLarge(); return parseJsonBody(b); }
    if (b && typeof b === "object" && !Array.isArray(b)) return b;
    throw new ApiError(400, "INVALID_JSON", "Send a JSON object.");
  }
  const text = await new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { done = true; reject(bodyTooLarge()); req.resume(); } else chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    req.on("error", () => { if (!done) { done = true; reject(new ApiError(400, "INVALID_JSON", "The body could not be read.")); } });
  });
  return parseJsonBody(text);
}

const ROUTES = { quote: "GET", swap: "POST" };

/// Answers one request to /api/v1/<route>. Never throws: every failure is one JSON shape.
export async function handleRequest(req, res, route) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
  };
  const send = (status, body) => {
    if (res.headersSent) return;
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(body === null ? "" : JSON.stringify(body));
  };
  try {
    const method = ROUTES[route];
    if (!method) throw new ApiError(404, "NOT_FOUND", "No such endpoint. Use GET /api/v1/quote or POST /api/v1/swap.");
    if (req.method === "OPTIONS") {
      headers["access-control-allow-methods"] = method + ", OPTIONS";
      headers["access-control-allow-headers"] = "Content-Type";
      headers["access-control-max-age"] = "86400";
      delete headers["content-type"];
      return send(204, null);
    }
    if (req.method !== method) {
      headers.allow = method + ", OPTIONS";
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use " + method + " for this endpoint.");
    }
    const s = settings();
    const hit = limiterFor(route).check(clientIp(req.headers, req.socket && req.socket.remoteAddress, s.ipMode));
    if (hit.limit > 0) {
      headers["x-ratelimit-limit"] = String(hit.limit);
      headers["x-ratelimit-remaining"] = String(hit.remaining);
      headers["x-ratelimit-reset"] = String(hit.retryAfterSeconds);
    }
    if (!hit.ok) {
      headers["retry-after"] = String(hit.retryAfterSeconds);
      throw new ApiError(429, "RATE_LIMITED", "Too many requests. This address may make " + hit.limit + " " + route + " calls every " + Math.round(s.windowMs / 1000) + " seconds. Try again in " + hit.retryAfterSeconds + " seconds.");
    }
    if (String(req.url || "").length > MAX_URL_LENGTH) throw new ApiError(400, "INVALID_PARAMETER", "The request URL is too long.", { parameter: "url" });
    let out;
    if (route === "quote") {
      let u;
      try { u = new URL(req.url, "http://localhost"); } catch (_) { throw new ApiError(400, "INVALID_PARAMETER", "The request URL is malformed.", { parameter: "url" }); }
      out = await quote(parseQuoteParams(queryObject(u.searchParams)));
    } else {
      out = await swap(parseSwapParams(await readJson(req), { maxCuPrice: s.maxCuPrice }));
    }
    headers["x-rpc-calls"] = String(out.rpcCalls);
    return send(200, out.body);
  } catch (e) {
    const { status, body } = errorResponse(e);
    if (status === 500) console.error("[trade-api] internal: " + scrub(e));
    if (status === 413) headers.connection = "close";
    return send(status, body);
  }
}
