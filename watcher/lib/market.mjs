// market.json: every pool with what the Explore page and a coin card need, so a visitor reads one file from the
// watcher instead of a getProgramAccounts and two reads per coin.
//
// The pools come from the shared list (lib/pools.mjs), which the feed reads again after any transaction of the
// pool program. What does not live in the pool account is read once per coin and kept in state/market-cache.json:
// the coin's name, symbol and uri (its Metaplex metadata account, or the metadata a Token-2022 mint carries), its
// mint (decimals, supply, token program, authorities), the picture and links of the uri's JSON, and for a coin on
// the launch rules template its rules config and creator lock. Then:
//   - the supply again for every pool whose account changed (a graduation and the burns of the buyback and rules
//     templates lower it), and for every coin every MINT_REFRESH_SECONDS (a holder's own token burn);
//   - the name, symbol and uri every METADATA_REFRESH_SECONDS;
//   - the rules lock with every pool change of that pool and every MARKET_REFRESH_SECONDS;
//   - the uri's JSON once; an unreachable one again after 15 minutes, then every hour.
// All the account reads of one pass go in one batched read (one call per hundred accounts).
//
// The top half is pure and tested offline. The bottom half reads the chain and the metadata JSON.
import fs from "node:fs";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { PublicKey } from "@solana/web3.js";
import { CLOCK_SYSVAR, HOOK_KIND, RULES_KIND, pda, rulesPda, decodeMint, decodeRulesConfig, decodeLockRecord, decodeTokenAmount, curveStateName } from "../../sdk/dist/index.js";
import { getMany, metadataOf, templateOf } from "./chain.mjs";
import { curveEntry } from "./curve.mjs";
import { isPeggedPool } from "./simulate.mjs";
import { writeJsonAtomic } from "./feed.mjs";

export const MARKET_VERSION = 1;
const KIND = { [HOOK_KIND.NONE]: "none", [HOOK_KIND.FROZEN]: "frozen", [HOOK_KIND.PLATFORM]: "platform" };
/// A data: picture longer than this is left out of market.json (a page reads the uri itself for it).
export const MAX_DATA_IMAGE = 16_384;
export const MAX_DESCRIPTION = 500;
/// The most metadata JSON files one pass reads, and the most bytes one may have.
export const JSON_PER_PASS = 8;
export const MAX_JSON_BYTES = 262_144;
/// An unreachable JSON is tried again after this, then after RETRY_LATER_MS each time.
export const RETRY_SOON_MS = 15 * 60_000;
export const RETRY_LATER_MS = 60 * 60_000;

const b58 = (k) => (k ? k.toBase58() : null);
const clean = (s, max) => String(s ?? "").replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, max);

// ---- pure part ---------------------------------------------------------------------------------------------

/// num / den as a plain decimal string with `sig` significant digits, cut, not rounded (the trade API's own).
export function ratioDecimal(num, den, sig = 9) {
  if (den <= 0n || num < 0n) return "0";
  const SCALE = 36;
  const s = ((num * 10n ** BigInt(SCALE)) / den).toString().padStart(SCALE + 1, "0");
  const int = s.slice(0, s.length - SCALE);
  let frac = s.slice(s.length - SCALE);
  if (int !== "0") frac = frac.slice(0, Math.max(0, sig - int.length));
  else {
    const lead = frac.search(/[1-9]/);
    if (lead < 0) return "0";
    frac = frac.slice(0, lead + sig);
  }
  frac = frac.replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/// An http(s) address, trimmed, or null.
export function webAddress(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^https?:\/\//i.test(t) && t.length <= 2048 ? t : null;
}
/// A picture address: http(s), or a data:image URL of at most MAX_DATA_IMAGE characters. Else null.
export function imageAddress(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (/^https?:\/\//i.test(t)) return t.length <= 2048 ? t : null;
  if (/^data:image\//i.test(t)) return t.length <= MAX_DATA_IMAGE ? t : null;
  return null;
}

/// What a coin card takes from a coin's metadata JSON: the picture, the description and three links (from
/// `extensions`, else from the top level, as the site reads them).
export function metaFromJson(j) {
  const ext = j && typeof j.extensions === "object" && j.extensions ? j.extensions : {};
  const link = (k) => webAddress(ext[k]) ?? webAddress(j ? j[k] : null);
  return {
    image: imageAddress(j ? j.image : null),
    description: j && typeof j.description === "string" && j.description.trim() ? clean(j.description, MAX_DESCRIPTION) : null,
    links: { website: link("website"), twitter: link("twitter"), telegram: link("telegram") },
  };
}

/// An IPv4 address that is not a public one: this machine, a private network, link local (the cloud's metadata
/// service lives there), carrier NAT, the reserved and test ranges, multicast and above.
function privateV4(a, b, c) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
}

/// An IP address (IPv4 or IPv6, as DNS answers it) that the watcher must not connect to: loopback, unspecified,
/// a private or link-local network, carrier NAT, the reserved ranges, multicast, and the IPv6 forms that carry an
/// IPv4 address (mapped, NAT64, 6to4) when that address is one of those. Anything that is not an address: true.
export function privateAddress(ip) {
  const s = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const kind = net.isIP(s);
  if (kind === 4) {
    const p = s.split(".").map(Number);
    return privateV4(p[0], p[1], p[2]);
  }
  if (kind === 6) {
    const words = expandV6(s);
    if (!words) return true;
    const hex = words.map((w) => w.toString(16).padStart(4, "0")).join("");
    if (/^0{31}[01]$/.test(hex)) return true;                    // :: and ::1
    if (/^0{20}ffff/.test(hex)) return privateV4((words[6] >> 8) & 255, words[6] & 255, (words[7] >> 8) & 255);   // ::ffff:a.b.c.d
    if (/^0{24}/.test(hex) && !/^0{32}$/.test(hex)) return privateV4((words[6] >> 8) & 255, words[6] & 255, (words[7] >> 8) & 255); // ::a.b.c.d (compatible)
    if (hex.startsWith("0064ff9b")) return privateV4((words[6] >> 8) & 255, words[6] & 255, (words[7] >> 8) & 255);   // 64:ff9b::/96 (NAT64)
    if (hex.startsWith("2002")) return privateV4((words[1] >> 8) & 255, words[1] & 255, (words[2] >> 8) & 255);         // 2002::/16 (6to4)
    if (hex.startsWith("20010000")) return true;                   // 2001::/32 (Teredo): a tunnel to anything
    if (hex.startsWith("20010db8")) return true;                   // 2001:db8::/32 (documentation)
    const first = words[0];
    if ((first & 0xfe00) === 0xfc00) return true;                  // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true;                  // fe80::/10 link local
    if ((first & 0xffc0) === 0xfec0) return true;                  // fec0::/10 site local (deprecated)
    if ((first & 0xff00) === 0xff00) return true;                  // ff00::/8 multicast
    return false;
  }
  return true;
}

/// The eight 16-bit words of an IPv6 address, or null when it is not one (an IPv4 tail is folded in).
function expandV6(s) {
  let str = s;
  const tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (tail) {
    const p = tail[1].split(".").map(Number);
    if (p.length !== 4 || p.some((x) => x > 255)) return null;
    str = str.slice(0, tail.index) + ":" + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const parts = [...left, ...Array(fill).fill("0"), ...right];
  if (parts.length !== 8) return null;
  const words = parts.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return words.some((w) => Number.isNaN(w)) ? null : words;
}

/// Names that answer a loopback or private address on the public DNS by design (wildcard DNS services), and so
/// may not be fetched whatever they look like.
export const PRIVATE_NAME_SUFFIXES = ["localtest.me", "lvh.me", "vcap.me", "localho.st", "lacolhost.com", "readme.localhost", "fuf.me", "127-0-0-1.nip.io", "yoogle.com"];

/// A host the watcher must not fetch on a server, judged by its name alone: the machine itself, its network,
/// link-local addresses (the cloud's metadata service among them), the IPv6 forms of those, a name of a wildcard
/// DNS service that answers such an address, and a name that carries such an address in it (127.0.0.1.nip.io,
/// 10-0-0-1.sslip.io: those services answer the address the name holds). The name's real addresses are checked
/// again when it is fetched (`pinnedFetch`): this is the first gate, not the only one. On localnet private hosts
/// are allowed, because the local site serves the coins' JSON.
export function privateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal") return true;
  if (net.isIP(h)) return privateAddress(h);
  for (const suffix of PRIVATE_NAME_SUFFIXES) if (h === suffix || h.endsWith(`.${suffix}`)) return true;
  // an IPv4 address written into the name, dotted or dashed (a label of digits and dots or dashes that reads as one)
  for (const m of h.matchAll(/(?:^|[.-])(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})(?=[.-]|$)/g)) {
    const p = [m[1], m[2], m[3], m[4]].map(Number);
    if (p.every((x) => x <= 255) && privateV4(p[0], p[1], p[2])) return true;
  }
  return false;
}

/// A DNS lookup for `net.connect` that refuses a name whose answers hold ANY address the watcher must not connect
/// to (`privateAddress`), and otherwise hands the socket one checked address, so that the name cannot be made to
/// point elsewhere between the check and the connection. `resolve(hostname)` answers [{ address, family }] (the
/// system resolver, all addresses, by default).
export function pinnedLookup({ resolve = (host) => dns.promises.lookup(host, { all: true, verbatim: true }), allowPrivate = false } = {}) {
  return (hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options ?? {};
    Promise.resolve().then(() => resolve(hostname)).then((list) => {
      const addresses = (Array.isArray(list) ? list : [list]).filter((a) => a && a.address);
      if (!addresses.length) { const e = new Error(`${hostname}: no address`); e.code = "ENOTFOUND"; throw e; }
      if (!allowPrivate) {
        const bad = addresses.find((a) => privateAddress(a.address));
        if (bad) { const e = new Error(`${hostname} resolves to ${bad.address}, an address the watcher does not fetch`); e.code = "EPRIVATE"; throw e; }
      }
      const pick = opts.family === 6 ? addresses.find((a) => a.family === 6) ?? addresses[0] : opts.family === 4 ? addresses.find((a) => a.family === 4) ?? addresses[0] : addresses[0];
      if (opts.all) cb(null, [{ address: pick.address, family: pick.family }]);
      else cb(null, pick.address, pick.family);
    }).catch((e) => cb(e));
  };
}

/// A small fetch over node:http and node:https whose connection goes to an address `pinnedLookup` checked:
/// the name is resolved once, every address must be public, and the socket connects to that address while TLS
/// still checks the certificate against the name. Follows no redirect itself (`redirect: "manual"`: the caller
/// checks the location); honours `init.signal`; answers { status, ok, headers (a Map, lower-case names), body
/// (the response stream, async iterable), text() }. A refused name throws an error with code EPRIVATE.
export function pinnedFetch(href, init = {}, { lookup = null, allowPrivate = false } = {}) {
  const u = new URL(href);
  const mod = u.protocol === "https:" ? https : http;
  const look = lookup ?? pinnedLookup({ allowPrivate });
  // a host written as an address goes to no lookup at all (node connects to it as it is): judged here
  const literal = u.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && net.isIP(literal) && privateAddress(literal)) {
    const e = new Error(`${literal} is an address the watcher does not fetch`); e.code = "EPRIVATE";
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: init.method ?? "GET", headers: init.headers ?? {}, lookup: look }, (res) => {
      const headers = new Map();
      for (const [k, v] of Object.entries(res.headers)) headers.set(k.toLowerCase(), Array.isArray(v) ? v.join(", ") : v);
      resolve({
        status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, headers, body: res,
        text: async () => { const parts = []; for await (const c of res) parts.push(Buffer.from(c)); return Buffer.concat(parts).toString("utf8"); },
      });
    });
    req.on("error", reject);
    if (init.signal) {
      const abort = () => { const e = new Error("aborted"); e.name = "AbortError"; req.destroy(e); };
      if (init.signal.aborted) abort(); else init.signal.addEventListener("abort", abort, { once: true });
    }
    req.end();
  });
}

/// The address to fetch a coin's metadata JSON from, or null when it is not one the watcher fetches.
export function metadataUrl(uri, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(uri ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (!allowPrivate && privateHost(u.hostname)) return null;
  return u;
}

/// When an unreachable JSON is tried again: 15 minutes after the first miss, then every hour.
export function nextJsonTry(tries, nowMs) { return nowMs + (tries <= 1 ? RETRY_SOON_MS : RETRY_LATER_MS); }

/// The `coin` part of an entry from the cached coin (or null when the coin was never read).
export function coinPart(mint, c) {
  const j = c && c.json ? c.json : null;
  return {
    mint: b58(mint),
    name: c ? c.name ?? "" : "", symbol: c ? c.symbol ?? "" : "", uri: c ? c.uri ?? "" : "",
    image: j && j.image ? j.image : null, description: j && j.description ? j.description : null,
    links: { website: j && j.links ? j.links.website ?? null : null, twitter: j && j.links ? j.links.twitter ?? null : null, telegram: j && j.links ? j.links.telegram ?? null : null },
    metadataJson: j ? j.status : "pending",
    decimals: c && Number.isInteger(c.decimals) ? c.decimals : null,
    supply: c && typeof c.supply === "string" ? c.supply : null,
    tokenProgram: c ? c.tokenProgram ?? null : null,
    mintAuthority: c ? c.mintAuthority ?? null : null, freezeAuthority: c ? c.freezeAuthority ?? null : null,
  };
}

/// One pool's entry, in the exact shape of FEED-CONTRACT.md. `bytes` is the pool account as read, `coin` the
/// cached coin, `rules` the cached rules part (rules pools), `info` the feed's { createdTime, lastTradeTime }.
export function marketEntry({ pool, bytes, coin = null, rules = null, info = {} }) {
  const supply = coin && typeof coin.supply === "string" ? BigInt(coin.supply) : null;
  const dec = coin && Number.isInteger(coin.decimals) ? coin.decimals : null;
  const effective = pool.reserveQuote + pool.virtualQuote;
  return {
    address: pool.address.toBase58(),
    account: bytes ? Buffer.from(bytes).toString("base64") : null,
    baseMint: pool.baseMint.toBase58(), quoteMint: pool.quoteMint.toBase58(), lpMint: pool.lpMint.toBase58(), baseTokenProgram: pool.baseTokenProgram.toBase58(), creator: pool.creator.toBase58(),
    lpFeeBps: pool.lpFeeBps,
    hasHook: pool.hasHook, hookProgram: pool.hookProgram.toBase58(), hookKind: KIND[pool.hookKind] ?? "none", hookFlags: pool.hookFlags,
    template: pool.hasHook ? templateOf(pool.hookProgram) : "none",
    pegged: isPeggedPool(pool),
    reserveBase: pool.reserveBase.toString(), reserveQuote: pool.reserveQuote.toString(), virtualQuote: pool.virtualQuote.toString(),
    volumeQuoteTotal: pool.volumeQuoteTotal.toString(), hookFeesQuoteTotal: pool.hookFeesQuoteTotal.toString(), swapCount: pool.swapCount.toString(),
    createdSlot: pool.createdSlot.toString(),
    createdTime: info && Number.isFinite(info.createdTime) ? info.createdTime : null,
    lastTradeTime: info && Number.isFinite(info.lastTradeTime) ? info.lastTradeTime : null,
    curveState: curveStateName(pool.curveState), graduationTarget: pool.graduationTarget.toString(), graduationFeeBps: pool.graduationFeeBps,
    curve: curveEntry(pool, supply),
    price: dec === null || pool.reserveBase === 0n ? "0" : ratioDecimal(effective * 10n ** BigInt(dec), pool.reserveBase * 10n ** 9n),
    marketCap: supply === null || pool.reserveBase === 0n ? "0" : ((effective * supply) / pool.reserveBase).toString(),
    coin: coinPart(pool.baseMint, coin),
    rules: rules ? { config: rules.config, strict: !!rules.strict, lockAmount: rules.lockAmount ?? "0", lockUnlockAt: rules.lockUnlockAt ?? "0", readAt: rules.readAt ?? null, slot: rules.slot ?? null, unixTime: rules.unixTime ?? null } : null,
  };
}

/// The whole file: the pools newest first (createdSlot descending, then address).
export function buildMarket({ cluster, updatedAt, slot, checkedAt, checkedSlot, entries }) {
  const pools = [...entries].sort((a, b) => {
    const x = BigInt(a.createdSlot); const y = BigInt(b.createdSlot);
    return x > y ? -1 : x < y ? 1 : a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });
  return { version: MARKET_VERSION, cluster, updatedAt, slot, checkedAt, checkedSlot, pools };
}

/// A coin as the cache keeps it, from its metadata account (or null) and its mint account (or null). `prev` is
/// what the cache had: its JSON part stays when the uri did not change.
export function coinFromAccounts(mint, metadataInfo, mintInfo, prev, { nowMs, slot }) {
  const md = metadataOf(mint, metadataInfo, mintInfo);
  let m = null;
  if (mintInfo && mintInfo.data && mintInfo.data.length >= 82) { try { m = decodeMint(new Uint8Array(mintInfo.data), mintInfo.owner); } catch { m = null; } }
  const uri = md ? clean(md.uri, 512) : "";
  const keepJson = prev && prev.json && prev.uri === uri ? prev.json : null;
  return {
    name: md ? clean(md.name, 64) : "", symbol: md ? clean(md.symbol, 16) : "", uri,
    decimals: m ? m.decimals : prev ? prev.decimals ?? null : null,
    supply: m ? m.supply.toString() : prev ? prev.supply ?? null : null,
    tokenProgram: mintInfo ? mintInfo.owner.toBase58() : prev ? prev.tokenProgram ?? null : null,
    mintAuthority: m ? b58(m.mintAuthority) : prev ? prev.mintAuthority ?? null : null,
    freezeAuthority: m ? b58(m.freezeAuthority) : prev ? prev.freezeAuthority ?? null : null,
    metaReadAt: nowMs, supplyReadAt: m ? nowMs : prev ? prev.supplyReadAt ?? null : null, supplySlot: m ? slot : prev ? prev.supplySlot ?? null : null,
    json: keepJson,
  };
}

/// The supply part of a cached coin, from a fresh read of its mint.
export function withSupply(prev, mintInfo, { nowMs, slot }) {
  if (!prev || !mintInfo || !mintInfo.data || mintInfo.data.length < 82) return prev;
  let m;
  try { m = decodeMint(new Uint8Array(mintInfo.data), mintInfo.owner); } catch { return prev; }
  return { ...prev, supply: m.supply.toString(), decimals: m.decimals, mintAuthority: b58(m.mintAuthority), freezeAuthority: b58(m.freezeAuthority), tokenProgram: mintInfo.owner.toBase58(), supplyReadAt: nowMs, supplySlot: slot };
}

/// The rules part of a rules pool from its config, lock record and lock vault, and the Clock of the same read.
export function rulesFromAccounts(cfgInfo, lockInfo, vaultInfo, clockInfo, { nowIso, slot }) {
  if (!cfgInfo) return null;
  let cfg;
  try { cfg = decodeRulesConfig(new Uint8Array(cfgInfo.data)); } catch { return null; }
  let unlockAt = 0n;
  if (lockInfo) { try { unlockAt = decodeLockRecord(new Uint8Array(lockInfo.data)).unlockAt; } catch { unlockAt = 0n; } }
  const amount = vaultInfo && vaultInfo.data && vaultInfo.data.length >= 72 ? decodeTokenAmount(new Uint8Array(vaultInfo.data)) : 0n;
  const clock = clockInfo && clockInfo.data && clockInfo.data.length >= 40 ? Buffer.from(clockInfo.data) : null;
  return {
    config: Buffer.from(cfgInfo.data).toString("base64"), strict: cfg.kind === RULES_KIND.STRICT,
    lockAmount: amount.toString(), lockUnlockAt: unlockAt.toString(), readAt: nowIso,
    slot: clock ? Number(clock.readBigUInt64LE(0)) : slot, unixTime: clock ? Number(clock.readBigInt64LE(32)) : null,
  };
}

// ---- network -----------------------------------------------------------------------------------------------

/// A coin's metadata JSON, read once with a timeout, a size limit, and redirects checked like the address
/// itself. Answers { status, image, description, links }: status "ok", "unreachable" (no answer, an HTTP error,
/// or too large), "invalid" (not a JSON object, a redirect elsewhere, or a name whose addresses the watcher does
/// not connect to) or "none" (no address the watcher reads). The transport (`fetchImpl`) is `pinnedFetch` by
/// default: the name is resolved first, refused when any of its addresses is private, and the connection goes to
/// the checked address (so a name that answers a public address to one lookup and a private one to the next gets
/// nowhere). On localnet (`allowPrivate`) the system's fetch is used as it is.
export async function fetchMetadataJson(uri, { timeoutMs = 3000, allowPrivate = false, maxBytes = MAX_JSON_BYTES, fetchImpl = null } = {}) {
  let u = metadataUrl(uri, { allowPrivate });
  if (!u) return { status: "none" };
  const signal = AbortSignal.timeout(timeoutMs);
  const transport = fetchImpl ?? (allowPrivate ? fetch : (href, init) => pinnedFetch(href, init, { allowPrivate }));
  try {
    for (let hop = 0; hop < 4; hop++) {
      const res = await transport(u.href, { redirect: "manual", signal, headers: { accept: "application/json" } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        const next = loc ? metadataUrl(new URL(loc, u).href, { allowPrivate }) : null;
        if (!next) return { status: "invalid" };
        u = next;
        continue;
      }
      if (!res.ok) return { status: "unreachable" };
      const len = Number(res.headers.get("content-length") || 0);
      if (len > maxBytes) return { status: "unreachable" };
      let size = 0;
      const chunks = [];
      if (res.body && typeof res.body[Symbol.asyncIterator] === "function") {
        for await (const c of res.body) { size += c.length; if (size > maxBytes) return { status: "unreachable" }; chunks.push(Buffer.from(c)); }
      } else {
        const t = Buffer.from(await res.text());
        if (t.length > maxBytes) return { status: "unreachable" };
        chunks.push(t);
      }
      let j;
      try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return { status: "invalid" }; }
      if (!j || typeof j !== "object" || Array.isArray(j)) return { status: "invalid" };
      return { status: "ok", ...metaFromJson(j) };
    }
    return { status: "invalid" };
  } catch (e) {
    return { status: e && e.code === "EPRIVATE" ? "invalid" : "unreachable" };
  }
}

export class Market {
  constructor({ connection, cluster, file, cacheFile, log = null, now = () => Date.now(), mintRefreshMs = 600_000, metadataRefreshMs = 21_600_000, marketRefreshMs = 300_000, metadataTimeoutMs = 3000, fetchJson = fetchMetadataJson }) {
    Object.assign(this, { connection, cluster, file, cacheFile, log, now, mintRefreshMs, metadataRefreshMs, marketRefreshMs, metadataTimeoutMs, fetchJson });
    this.allowPrivate = cluster === "localnet";
    this.cache = { version: MARKET_VERSION, coins: {}, rules: {}, mintsAt: 0, metadataAt: 0, rulesAt: 0 };
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (c && c.version === MARKET_VERSION && c.coins && typeof c.coins === "object") this.cache = { ...this.cache, ...c };
    } catch { /* starts empty */ }
    this.lastBytes = new Map();   // pool -> base64 of its account at the last market pass
    this.calls = 0;               // RPC calls of the market's own reads, since the start
    this.last = null;             // the last file written
  }

  /// Which pools changed since the last market pass (new ones included), from their account bytes.
  changedPools(pools, bytes) {
    const out = new Set();
    for (const p of pools) {
      const k = p.address.toBase58();
      const b = bytes.get(k);
      const now = b ? Buffer.from(b).toString("base64") : null;
      if (this.lastBytes.get(k) !== now) out.add(k);
    }
    return out;
  }

  /// Read what the pools need beyond their own accounts, in one batched read. `changed`: pools whose account
  /// changed (their supply and rules lock are read again). Then the metadata JSON of a few coins.
  async refresh({ pools, bytes, slot, changed = null }) {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const ch = changed ?? this.changedPools(pools, bytes);
    const mintsDue = nowMs - (this.cache.mintsAt || 0) >= this.mintRefreshMs;
    const metaDue = nowMs - (this.cache.metadataAt || 0) >= this.metadataRefreshMs;
    const rulesDue = nowMs - (this.cache.rulesAt || 0) >= this.marketRefreshMs;
    const coinKeys = new Map();   // mint -> "new" | "meta" | "supply"
    const rulesWanted = [];
    for (const p of pools) {
      const mint = p.baseMint.toBase58();
      const have = this.cache.coins[mint];
      const want = !have ? "new" : metaDue ? "meta" : mintsDue || ch.has(p.address.toBase58()) ? "supply" : null;
      if (want && (!coinKeys.has(mint) || want === "new" || (want === "meta" && coinKeys.get(mint) === "supply"))) coinKeys.set(mint, want);
      if (p.hasHook && templateOf(p.hookProgram) === "rules") {
        const k = p.address.toBase58();
        if (!this.cache.rules[k] || rulesDue || ch.has(k)) rulesWanted.push(p.address);
      }
    }
    // one list of keys for everything: metadata + mint for a new coin or a metadata refresh, the mint alone for a
    // supply refresh, config + lock + lock vault for a rules pool, and the Clock with them
    const keys = [];
    const slots = [];
    for (const [mint, want] of coinKeys) {
      const m = new PublicKey(mint);
      if (want === "supply") { slots.push({ kind: "supply", mint, at: keys.length }); keys.push(m); }
      else { slots.push({ kind: "coin", mint, at: keys.length }); keys.push(pda.metadata(m), m); }
    }
    for (const pool of rulesWanted) { slots.push({ kind: "rules", pool: pool.toBase58(), at: keys.length }); keys.push(rulesPda.cfg(pool), rulesPda.lock(pool), rulesPda.lockVault(pool)); }
    let clockAt = -1;
    if (rulesWanted.length) { clockAt = keys.length; keys.push(CLOCK_SYSVAR); }
    let reads = 0;
    if (keys.length) {
      const { infos } = await getMany(this.connection, keys);
      reads = Math.ceil(keys.length / 100);
      this.calls += reads;
      const clock = clockAt >= 0 ? infos[clockAt] : null;
      for (const s of slots) {
        if (s.kind === "coin") this.cache.coins[s.mint] = coinFromAccounts(new PublicKey(s.mint), infos[s.at], infos[s.at + 1], this.cache.coins[s.mint], { nowMs, slot });
        else if (s.kind === "supply") this.cache.coins[s.mint] = withSupply(this.cache.coins[s.mint], infos[s.at], { nowMs, slot });
        else {
          const r = rulesFromAccounts(infos[s.at], infos[s.at + 1], infos[s.at + 2], clock, { nowIso, slot });
          if (r) this.cache.rules[s.pool] = r;
        }
      }
    }
    if (mintsDue) this.cache.mintsAt = nowMs;
    if (metaDue) this.cache.metadataAt = nowMs;
    if (rulesDue) this.cache.rulesAt = nowMs;
    // the metadata JSON of a few coins: never tried, or due for another try
    const due = Object.entries(this.cache.coins).filter(([, c]) => c && c.uri && (!c.json || (c.json.status !== "ok" && c.json.status !== "none" && (c.json.nextTryAt ?? 0) <= nowMs)));
    let fetched = 0;
    await Promise.all(due.slice(0, JSON_PER_PASS).map(async ([mint, c]) => {
      const got = await this.fetchJson(c.uri, { timeoutMs: this.metadataTimeoutMs, allowPrivate: this.allowPrivate });
      const tries = (c.json && c.json.tries ? c.json.tries : 0) + 1;
      this.cache.coins[mint] = { ...c, json: { ...got, tries, nextTryAt: got.status === "ok" || got.status === "none" ? null : nextJsonTry(tries, nowMs) } };
      fetched += 1;
    }));
    for (const [mint, c] of Object.entries(this.cache.coins)) if (c && !c.uri && !c.json) this.cache.coins[mint] = { ...c, json: { status: "none", tries: 0, nextTryAt: null } };
    for (const p of pools) { const k = p.address.toBase58(); const b = bytes.get(k); this.lastBytes.set(k, b ? Buffer.from(b).toString("base64") : null); }
    try { writeJsonAtomic(this.cacheFile, JSON.stringify(this.cache)); } catch (e) { if (this.log) this.log.warn(`market: the cache could not be saved: ${e.message}`); }
    return { reads, coins: coinKeys.size, rules: rulesWanted.length, fetched, changed: ch.size };
  }

  /// market.json from the pools and the cache. `info(pool)` gives the feed's { createdTime, lastTradeTime }.
  build({ pools, bytes, slot, updatedAt, checkedAt, checkedSlot, info = () => ({}) }) {
    const entries = pools.map((p) => {
      const k = p.address.toBase58();
      return marketEntry({ pool: p, bytes: bytes.get(k) ?? null, coin: this.cache.coins[p.baseMint.toBase58()] ?? null, rules: p.hasHook && templateOf(p.hookProgram) === "rules" ? this.cache.rules[k] ?? null : null, info: info(k) });
    });
    return buildMarket({ cluster: this.cluster, updatedAt, slot, checkedAt, checkedSlot, entries });
  }

  write(market) {
    writeJsonAtomic(this.file, JSON.stringify(market));
    this.last = { updatedAt: market.updatedAt, checkedAt: market.checkedAt, pools: market.pools.length };
  }
}
