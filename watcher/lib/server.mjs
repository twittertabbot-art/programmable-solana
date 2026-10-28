// GET /pools.json (the status file, CORS open), GET /market.json and GET /trades/<pool>.json (the two feeds, CORS
// open, a five second cache), GET /health, and POST /notify (the coin page hands in the signature of a buy that
// paid a deposit). Plain node:http, nothing else. Nothing a request carries can throw out of the handler: a target
// that is not a URL gets a 400, anything unforeseen a 500, and the process goes on.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { crankStale } from "./crank.mjs";

/// A crank that has not completed a READ of what it serves for this long makes /health answer stale (503).
export const READ_STALE_MS = 600_000;
/// The most bytes a POST /notify body may have.
export const NOTIFY_BODY_MAX = 1024;

/// Pure: has a crank gone without a completed read for too long? `r` is { streak, since, lastReadAt } (the watcher's
/// read table for one crank): stale when its reads have been failing since more than READ_STALE_MS.
export function readStale(r, nowMs, enabled = true, staleMs = READ_STALE_MS) {
  if (!enabled || !r || !r.since) return false;
  const t = Date.parse(r.since);
  return Number.isFinite(t) && (r.streak ?? 0) > 0 && nowMs - t > staleMs;
}

/// Pure: what /health answers. Stale when the last pool pass is too old, or when the reveal crank, the settle
/// crank, the upkeep crank or the burn keeper is enabled and has not completed a run for three of its intervals.
/// The settle numbers: `lastSettleSent` is the last pass, the four totals count since the state was last cleared.
/// The upkeep numbers (pegged coins) follow the same rule: `lastUpkeepSent` is the last pass, the others are
/// totals. `deliveriesSent` and `reapsSent` count confirmed transactions, `assetsDelivered` and `assetsBurned`
/// count assets, `upkeepRentReceivedLamports` is what the burned assets and their queue entries paid the keeper.
/// The burn keeper's numbers (buyback pools and rules pools) follow the same rule again: `lastBurnSent` is the
/// last pass, the others are totals. `burnCalls` counts confirmed calls, split into `burnObserved`, `burnWaited`
/// and `burnBought` by what the chain reported. `burnSpentLamports` is what the buys spent out of the pots,
/// `burnFeesLamports` what the keeper paid to send the calls.
/// The graduate crank (pools on the curve) follows the same rule once more: `lastGraduateSent` is the last pass,
/// the others are totals. `graduatesSent` counts confirmed calls, split into `coinsGraduated` (the call graduated
/// the coin) and `graduatesAlready` (somebody graduated it first and the call changed nothing).
/// The trades feed and market.json (`feed`): `feedSlot` is the slot the feed is complete to, `feedLagSlots` the
/// newest slot this watcher has read through any of its calls minus that slot (null before the first pass),
/// `feedUnreadable` the transactions of the pool program it could not read and walked past (a version 1
/// transaction is one). A feed that is on and has not completed a pass for three of its intervals makes the answer
/// stale, like a crank.
/// The mint crank (collectible coins, one approval) follows the same rule: `lastMintSent` is the last pass,
/// `mintWatching` the wallets it waits on now, the others are totals. `mintsSent` counts confirmed mint_for
/// transactions, `piecesMintedForWallets` the pieces they minted into the buyers' wallets, `mintPaidBackLamports`
/// what the deposits paid the keeper back, `mintFeesLamports` the network fees it paid and `mintNetLamports` its
/// balance change over all of them, which stays at or above zero. `mintMintedFirst` counts wallets that minted
/// their pieces themselves before the crank, `mintDepositShort` wallets whose deposit did not cover the mint (the
/// crank sends nothing for them), `mintRefused` simulations that refused a mint (nothing was sent).
/// `mintLastSlotsAfterBuy` is how many slots after its buy the last mint landed. The crank counts as stale after
/// three of its intervals or 60 seconds, whichever is longer: a pass waits for its mint to confirm.
/// `mintHanded` counts the wallets the feed and POST /notify handed the crank, `notifyEnabled`, `notifyAccepted` and
/// `notifyRefused` the endpoint, `notifyStatusCalls` the getSignatureStatuses it cost, `notifyUnknown` the
/// signatures the chain did not know (dropped with no other call), `notifyTransactionsRead` and `notifyBuysFound`.
/// `feedLocked` (with `feedLockedBy`, `feedLockedSince`): the feed was asked for but another running watcher held its
/// lock at the start, so this one serves no market.json: `ok` is false while it runs that way.
/// The reads (`reads`, one entry per crank: settle, upkeep, burn, holderSync, reveal): `<crank>UnreadStreak` is how
/// many passes in a row the crank could not complete its read of the chain, `last<Crank>ReadAt` when it last did,
/// `<crank>ReadStale` whether that has gone on for READ_STALE_MS; `readStale` is any of them, and makes `ok` false.
/// The ticket index (`tickets`): `ticketIndexSize`, `ticketIndexReconciledAt`, `ticketIndexReconcileFailures`,
/// `ticketIndexReconcileFailedSince`, `ticketIndexEmptied` (tickets that left empty and that the listing does not take
/// back for a while), `ticketIndexHot` (wallets that traded lately). The one list of pools (`pools`): `poolsReadAt` (the last read of any pool),
/// `poolsFullReadAt` (the last read of the whole program), `poolsReadOwed` (a read failed and nothing has been
/// confirmed since), `poolsFullReadFailures`, `poolsFullReadFailedSince`, `poolsPatched` and `poolsFullReads`
/// (counts since the start).
export function healthBody({ status, crank, settle, upkeep, burn, graduate, feed, mint, reads, tickets, pools, notify, nowMs, staleAfterMs, cluster }) {
  const age = status && status.updatedAt ? nowMs - Date.parse(status.updatedAt) : null;
  const passStale = age === null || !Number.isFinite(age) || (!!staleAfterMs && age > staleAfterMs);
  const c = crank ?? { enabled: false, lastCrankAt: null, lastCrankRevealed: 0, intervalSeconds: 0 };
  const isCrankStale = crankStale({ enabled: !!c.enabled, lastCrankAt: c.lastCrankAt, nowMs, intervalSeconds: c.intervalSeconds });
  const s = settle ?? { enabled: false, lastSettleAt: null, lastSettleSent: 0, intervalSeconds: 0, totals: null };
  const isSettleStale = crankStale({ enabled: !!s.enabled, lastCrankAt: s.lastSettleAt, nowMs, intervalSeconds: s.intervalSeconds });
  const t = s.totals ?? {};
  const u = upkeep ?? { enabled: false, lastUpkeepAt: null, lastUpkeepSent: 0, intervalSeconds: 0, totals: null };
  const isUpkeepStale = crankStale({ enabled: !!u.enabled, lastCrankAt: u.lastUpkeepAt, nowMs, intervalSeconds: u.intervalSeconds });
  const ut = u.totals ?? {};
  const b = burn ?? { enabled: false, lastBurnAt: null, lastBurnSent: 0, intervalSeconds: 0, totals: null };
  const isBurnStale = crankStale({ enabled: !!b.enabled, lastCrankAt: b.lastBurnAt, nowMs, intervalSeconds: b.intervalSeconds });
  const bt = b.totals ?? {};
  const g = graduate ?? { enabled: false, lastGraduateAt: null, lastGraduateSent: 0, intervalSeconds: 0, totals: null };
  const isGraduateStale = crankStale({ enabled: !!g.enabled, lastCrankAt: g.lastGraduateAt, nowMs, intervalSeconds: g.intervalSeconds });
  const gt = g.totals ?? {};
  const f = feed ?? { enabled: false, lastFeedAt: null, intervalSeconds: 0, feedSlot: null, latestSlot: null };
  const isFeedStale = crankStale({ enabled: !!f.enabled, lastCrankAt: f.lastFeedAt, nowMs, intervalSeconds: f.intervalSeconds });
  const lag = Number.isFinite(f.feedSlot) && Number.isFinite(f.latestSlot) ? Math.max(0, f.latestSlot - f.feedSlot) : null;
  const m = mint ?? { enabled: false, lastMintAt: null, lastMintSent: 0, intervalSeconds: 0, watching: 0, totals: null };
  const isMintStale = crankStale({ enabled: !!m.enabled, lastCrankAt: m.lastMintAt, nowMs, intervalSeconds: Math.max(m.intervalSeconds ?? 0, 20) });
  const mt = m.totals ?? {};
  const r = reads ?? {};
  const rd = (name, enabled) => { const x = r[name] ?? { streak: 0, since: null, lastReadAt: null }; return { streak: x.streak ?? 0, lastReadAt: x.lastReadAt ?? null, stale: readStale(x, nowMs, enabled) }; };
  const rs = rd("settle", !!s.enabled); const ru = rd("upkeep", !!u.enabled); const rb = rd("burn", !!b.enabled); const rh = rd("holderSync", !!b.syncEnabled); const rr = rd("reveal", !!c.enabled);
  const isReadStale = rs.stale || ru.stale || rb.stale || rh.stale || rr.stale;
  const ti = tickets ?? {};
  const po = pools ?? {};
  const no = notify ?? { enabled: false, accepted: 0, refused: 0 };
  const stale = passStale || isCrankStale || isSettleStale || isUpkeepStale || isBurnStale || isGraduateStale || isFeedStale || isMintStale || isReadStale;
  // the feed was asked for and another process held its lock at the start: this watcher serves no market.json
  const feedLocked = !!f.locked;
  return {
    ok: !!status && !stale && !feedLocked,
    updatedAt: status ? status.updatedAt : null,
    pools: status ? Object.keys(status.pools ?? {}).length : 0,
    cluster,
    stale,
    ageSeconds: age === null || !Number.isFinite(age) ? null : Math.round(age / 1000),
    lastCrankAt: c.lastCrankAt ?? null,
    lastCrankRevealed: c.lastCrankRevealed ?? 0,
    crankEnabled: !!c.enabled,
    crankStale: isCrankStale,
    lastSettleAt: s.lastSettleAt ?? null,
    lastSettleSent: s.lastSettleSent ?? 0,
    settleEnabled: !!s.enabled,
    settleStale: isSettleStale,
    settlesSent: t.sent ?? 0,
    settlesFailed: t.failed ?? 0,
    piecesDropped: t.dropped ?? 0,
    piecesBurned: t.burned ?? 0,
    rentReceivedLamports: t.rentLamports ?? 0,
    settleFeesLamports: t.feeLamports ?? 0,
    lastUpkeepAt: u.lastUpkeepAt ?? null,
    lastUpkeepSent: u.lastUpkeepSent ?? 0,
    upkeepEnabled: !!u.enabled,
    upkeepStale: isUpkeepStale,
    deliveriesSent: ut.deliveries ?? 0,
    reapsSent: ut.reaps ?? 0,
    upkeepFailed: ut.failed ?? 0,
    assetsDelivered: ut.delivered ?? 0,
    assetsBurned: ut.burned ?? 0,
    upkeepRentReceivedLamports: ut.rentLamports ?? 0,
    upkeepFeesLamports: ut.feeLamports ?? 0,
    lastBurnAt: b.lastBurnAt ?? null,
    lastBurnSent: b.lastBurnSent ?? 0,
    burnEnabled: !!b.enabled,
    burnStale: isBurnStale,
    burnCalls: bt.calls ?? 0,
    burnFailed: bt.failed ?? 0,
    burnObserved: bt.observed ?? 0,
    burnWaited: bt.waited ?? 0,
    burnBought: bt.bought ?? 0,
    burnSpentLamports: bt.spentLamports ?? 0,
    burnFeesLamports: bt.feeLamports ?? 0,
    holderSyncEnabled: !!b.syncEnabled,
    holderSyncsSent: (b.syncTotals && b.syncTotals.sent) ?? 0,
    holderRecordsSynced: (b.syncTotals && b.syncTotals.records) ?? 0,
    holderSyncFailed: (b.syncTotals && b.syncTotals.failed) ?? 0,
    holderSyncFeesLamports: (b.syncTotals && b.syncTotals.feeLamports) ?? 0,
    lastGraduateAt: g.lastGraduateAt ?? null,
    lastGraduateSent: g.lastGraduateSent ?? 0,
    graduateEnabled: !!g.enabled,
    graduateStale: isGraduateStale,
    graduatesSent: gt.sent ?? 0,
    graduatesFailed: gt.failed ?? 0,
    coinsGraduated: gt.graduated ?? 0,
    graduatesAlready: gt.already ?? 0,
    graduateFeesLamports: gt.feeLamports ?? 0,
    mintCrankEnabled: !!m.enabled,
    mintCrankStale: isMintStale,
    lastMintAt: m.lastMintAt ?? null,
    lastMintSent: m.lastMintSent ?? 0,
    mintWatching: m.watching ?? 0,
    mintsSent: mt.sent ?? 0,
    mintsFailed: mt.failed ?? 0,
    piecesMintedForWallets: mt.pieces ?? 0,
    mintPaidBackLamports: mt.paidLamports ?? 0,
    mintFeesLamports: mt.feeLamports ?? 0,
    mintNetLamports: mt.netLamports ?? 0,
    mintMintedFirst: mt.mintedFirst ?? 0,
    mintDepositShort: mt.short ?? 0,
    mintRefused: mt.refused ?? 0,
    mintLastSlotsAfterBuy: mt.lastSlotsAfterBuy ?? null,
    mintHanded: m.handed ?? 0,
    notifyEnabled: !!no.enabled,
    notifyAccepted: no.accepted ?? 0,
    notifyRefused: no.refused ?? 0,
    notifyStatusCalls: no.statusCalls ?? 0,
    notifyUnknown: no.unknown ?? 0,
    notifyTransactionsRead: no.reads ?? 0,
    notifyBuysFound: no.found ?? 0,
    feedEnabled: !!f.enabled,
    feedLocked,
    feedLockedBy: feedLocked ? (f.locked.pid ?? null) : null,
    feedLockedSince: feedLocked ? (f.locked.since ?? null) : null,
    feedStale: isFeedStale,
    lastFeedAt: f.lastFeedAt ?? null,
    feedSlot: Number.isFinite(f.feedSlot) ? f.feedSlot : null,
    feedLagSlots: lag,
    feedPools: f.pools ?? 0,
    feedTransactions: f.transactions ?? 0,
    feedUnreadable: f.unreadable ?? 0,
    marketUpdatedAt: f.marketUpdatedAt ?? null,
    marketPools: f.marketPools ?? 0,
    readStale: isReadStale,
    settleUnreadStreak: rs.streak, lastSettleReadAt: rs.lastReadAt, settleReadStale: rs.stale,
    upkeepUnreadStreak: ru.streak, lastUpkeepReadAt: ru.lastReadAt, upkeepReadStale: ru.stale,
    burnUnreadStreak: rb.streak, lastBurnReadAt: rb.lastReadAt, burnReadStale: rb.stale,
    holderSyncUnreadStreak: rh.streak, lastHolderSyncReadAt: rh.lastReadAt, holderSyncReadStale: rh.stale,
    revealUnreadStreak: rr.streak, lastRevealReadAt: rr.lastReadAt, revealReadStale: rr.stale,
    ticketIndexSize: ti.size ?? 0,
    ticketIndexReconciledAt: ti.reconciledAt ?? null,
    ticketIndexReconcileFailures: ti.reconcileFailures ?? 0,
    ticketIndexReconcileFailedSince: ti.reconcileFailedSince ?? null,
    ticketIndexEmptied: ti.emptied ?? 0,
    ticketIndexHot: ti.hot ?? 0,
    poolsReadAt: po.readAt ?? null,
    poolsFullReadAt: po.fullAt ?? null,
    poolsReadOwed: !!po.owed,
    poolsFullReadFailures: po.fullFailures ?? 0,
    poolsFullReadFailedSince: po.fullFailedSince ?? null,
    poolsPatched: po.patches ?? 0,
    poolsFullReads: po.reads ?? 0,
  };
}

/// A file of the status folder as an HTTP answer, with a short cache: the site and any reader may keep it five
/// seconds. null when there is no such file yet. With `gzip`, the file compressed, kept until the file changes:
/// market.json holds about 2.3 KB per pool (2.3 MB for a thousand coins), and about a quarter of that compressed.
const gzipped = new Map();   // file -> { mtimeMs, size, body }
function readServed(file, gzip = false) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!gzip) { try { return fs.readFileSync(file); } catch { return null; } }
  const hit = gzipped.get(file);
  // every write is a new file renamed into place: its inode, time or size differs from the one compressed before
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.ino === stat.ino) return hit.body;
  let raw;
  try { raw = fs.readFileSync(file); } catch { return null; }
  const body = zlib.gzipSync(raw, { level: 6 });
  if (gzipped.size > 2000) gzipped.clear();
  gzipped.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, body });
  return body;
}
const acceptsGzip = (req) => /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""));

/// The pool of a /trades/<pool>.json path: a base58 address, or null for anything else (no other file of the
/// folder can be named).
export function tradesPathPool(pathname) {
  const m = /^\/trades\/([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(pathname);
  return m ? m[1] : null;
}

// ---- POST /notify ------------------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Length(s) {
  let n = 0n;
  for (const c of s) { const v = B58.indexOf(c); if (v < 0) return -1; n = n * 58n + BigInt(v); }
  let bytes = 0;
  while (n > 0n) { bytes += 1; n >>= 8n; }
  for (const c of s) { if (c === "1") bytes += 1; else break; }
  return bytes;
}

/// A transaction signature as text: base58 of exactly 64 bytes. Anything else is null.
export function parseSignature(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(s)) return null;
  return bs58Length(s) === 64 ? s : null;
}

/// The signature in a POST /notify body: JSON { "signature": "..." }, or the signature alone as text. null when
/// there is none.
export function notifyBodySignature(body) {
  const text = String(body ?? "").trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try { const j = JSON.parse(text); return j && typeof j === "object" ? parseSignature(j.signature) : null; } catch { return null; }
  }
  return parseSignature(text.replace(/^"|"$/g, ""));
}

/// What POST /notify takes a minute: from one address, and from everybody together. A buyer's page sends one per
/// buy that earns NFTs; anything over these is somebody else's flood, and the keeper finds every buy by itself.
export const NOTIFY_PER_MINUTE = 3;
export const NOTIFY_GLOBAL_PER_MINUTE = 30;

/// A sliding window of a minute per address, and one for everybody. `allow(ip)` answers false over the limits.
export class NotifyLimiter {
  constructor({ perMinute = NOTIFY_PER_MINUTE, globalPerMinute = NOTIFY_GLOBAL_PER_MINUTE, now = () => Date.now() } = {}) {
    Object.assign(this, { perMinute, globalPerMinute, now });
    this.byIp = new Map();
    this.all = [];
  }
  allow(ip) {
    const t = this.now();
    const cut = t - 60_000;
    this.all = this.all.filter((x) => x > cut);
    if (this.all.length >= this.globalPerMinute) return false;
    const list = (this.byIp.get(ip) ?? []).filter((x) => x > cut);
    if (list.length >= this.perMinute) { this.byIp.set(ip, list); return false; }
    list.push(t); this.byIp.set(ip, list); this.all.push(t);
    if (this.byIp.size > 5000) for (const [k, v] of this.byIp) if (!v.some((x) => x > cut)) this.byIp.delete(k);
    return true;
  }
}

/// An address of a hop between the caller and this server rather than of a caller on the internet: this machine,
/// a private network (10/8, 172.16/12, 192.168/16, 100.64/10), link-local, and their IPv6 kinds (::1, fc00::/7,
/// fe80::/10, IPv4-mapped forms). Documentation and other public ranges are callers.
export function proxyHop(ip) {
  let a = String(ip ?? "").trim().toLowerCase();
  if (a.startsWith("[")) a = a.slice(1, a.indexOf("]") > 0 ? a.indexOf("]") : undefined);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(:\d+)?$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127) || x === 0;
  }
  if (a === "::1" || a === "::") return true;
  return /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a);
}

/// The address a request came from: the socket's, or, when the socket is this machine (a proxy in front, Caddy
/// or nginx on the server, the site's own /watcher/ proxy), the address the proxies added to X-Forwarded-For: the
/// LAST entry that is not a hop of their own (proxyHop), as the RPC proxy and the site count it. The entries before
/// it are the caller's to write, so they never pick the bucket. All hops: the last entry.
export function clientIp(req) {
  const ra = String((req.socket && req.socket.remoteAddress) || "");
  const local = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(ra) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(ra);
  const fwd = req.headers ? req.headers["x-forwarded-for"] : null;
  if (local && fwd) {
    const list = (Array.isArray(fwd) ? fwd.join(",") : String(fwd)).split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = list.length - 1; i >= 0; i--) if (!proxyHop(list[i])) return list[i].slice(0, 64);
    if (list.length) return list[list.length - 1].slice(0, 64);
  }
  return ra || "unknown";
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      // too large: the rest is drained unread, so that the 413 reaches the caller on a clean connection
      if (size > max) { done = true; reject(Object.assign(new Error("body too large"), { code: "E2BIG" })); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

/// GET /pools.json, GET /health, with the feed on GET /market.json and GET /trades/<pool>.json, and with `notify`
/// POST /notify. `marketFile` and `tradesDir` name where the feed writes them (null: the feed is off and the two
/// routes answer 404). `notify` is { handle: async (signature) => { accepted, reason }, perMinute, globalPerMinute }
/// or null (the route answers 404). The getters feed /health.
export function startServer({ port, host = "0.0.0.0", statusFile, marketFile = null, tradesDir = null, cluster, getStatus, getCrank, getSettle, getUpkeep, getBurn, getGraduate, getFeed, getMint, getReads = null, getTickets = null, getPools = null, getNotify = null, notify = null, staleAfterMs, log }) {
  const base = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  const json = { ...base, "content-type": "application/json; charset=utf-8" };
  // the two feeds may be kept five seconds by a browser or a proxy in front
  const cached = { ...json, "Cache-Control": "public, max-age=5" };
  const limiter = notify ? new NotifyLimiter({ perMinute: notify.perMinute ?? NOTIFY_PER_MINUTE, globalPerMinute: notify.globalPerMinute ?? NOTIFY_GLOBAL_PER_MINUTE }) : null;
  const handle = async (req, res) => {
    const send = (status, headers, body) => { res.writeHead(status, { ...headers, "content-length": body.length }); return res.end(req.method === "HEAD" ? undefined : body); };
    const fail = (status, error) => send(status, json, Buffer.from(JSON.stringify({ error })));
    // an absolute-form target that is not a URL (Node's parser lets it through) is a bad request, not a crash
    let url;
    try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return fail(400, "bad request target"); }
    if (req.method === "OPTIONS") { res.writeHead(204, { ...base, "Access-Control-Allow-Methods": "GET, HEAD, POST", "Access-Control-Allow-Headers": "*" }); return res.end(); }
    if (req.method === "POST") {
      if (url.pathname !== "/notify") return fail(404, "not found");
      if (!notify) return fail(404, "this watcher takes no notifications (the mint crank is off, or NOTIFY=off)");
      let body;
      try { body = await readBody(req, NOTIFY_BODY_MAX); } catch (e) {
        const big = e && e.code === "E2BIG";
        res.writeHead(big ? 413 : 400, { ...json, connection: "close" });
        return res.end(JSON.stringify({ error: big ? "body too large" : "bad body" }));
      }
      const signature = notifyBodySignature(body);
      if (!signature) return fail(400, "send the signature of the buy: {\"signature\": \"<base58>\"}");
      if (!limiter.allow(clientIp(req))) return fail(429, "too many notifications right now; the keeper finds the buy by itself");
      const r = await notify.handle(signature);
      return send(r && r.accepted ? 202 : 200, json, Buffer.from(JSON.stringify({ accepted: !!(r && r.accepted), reason: r && r.reason ? r.reason : null })));
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, base); return res.end(); }
    if (url.pathname === "/pools.json") {
      let body;
      try { body = fs.readFileSync(statusFile); } catch { res.writeHead(503, json); return res.end(JSON.stringify({ error: "no status yet" })); }
      res.writeHead(200, { ...json, "content-length": body.length });
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    // the two feeds, compressed for a reader that takes gzip (every browser does)
    const z = acceptsGzip(req);
    const feedHeaders = z ? { ...cached, "content-encoding": "gzip", vary: "Accept-Encoding" } : { ...cached, vary: "Accept-Encoding" };
    if (url.pathname === "/market.json") {
      if (!marketFile) return fail(404, "this watcher runs without the feed (FEED=off)");
      const body = readServed(marketFile, z);
      return body ? send(200, feedHeaders, body) : fail(503, "no market.json yet: the first feed pass has not finished");
    }
    if (url.pathname.startsWith("/trades/")) {
      if (!tradesDir) return fail(404, "this watcher runs without the feed (FEED=off)");
      const pool = tradesPathPool(url.pathname);
      if (!pool) return fail(400, "ask for /trades/<pool address>.json");
      const body = readServed(path.join(tradesDir, `${pool}.json`), z);
      return body ? send(200, feedHeaders, body) : fail(404, "this watcher has no trades of that pool yet");
    }
    if (url.pathname === "/health" || url.pathname === "/") {
      const body = healthBody({
        status: getStatus(), crank: getCrank ? getCrank() : null, settle: getSettle ? getSettle() : null, upkeep: getUpkeep ? getUpkeep() : null, burn: getBurn ? getBurn() : null, graduate: getGraduate ? getGraduate() : null,
        feed: getFeed ? getFeed() : null, mint: getMint ? getMint() : null, reads: getReads ? getReads() : null, tickets: getTickets ? getTickets() : null, pools: getPools ? getPools() : null, notify: getNotify ? getNotify() : null,
        nowMs: Date.now(), staleAfterMs, cluster,
      });
      res.writeHead(body.ok ? 200 : 503, json);
      return res.end(JSON.stringify(body));
    }
    res.writeHead(404, json);
    res.end(JSON.stringify({ error: "not found" }));
  };
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      // nothing a request does may stop the watcher: say so, answer 500 when the answer has not started
      log.error(`http: request ${req.method} ${String(req.url).slice(0, 200)} failed: ${e && e.message ? e.message : e}`);
      try { if (!res.headersSent) res.writeHead(500, json); res.end(JSON.stringify({ error: "internal error" })); } catch { /* the socket is gone */ }
    });
  });
  server.on("error", (e) => log.error(`http server error: ${e.message}`));
  server.on("clientError", (e, socket) => { try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch { /* gone */ } });
  server.listen(port, host, () => log.info(`http: serving /pools.json${marketFile ? ", /market.json, /trades/<pool>.json" : ""}${notify ? ", POST /notify" : ""} and /health on http://${host}:${port}`));
  return server;
}
