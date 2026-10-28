// Renderer for "Collectible per buy" pieces, shared by web/serve.js and the Vercel function
// web/api/art.js. The three art functions are a plain-JS copy of sdk/src/collectible.ts and
// must stay byte-identical to H.renderPieceSvg (web/review/art-check.mjs compares them).
//   GET /art/p/<art 32 hex>/<seed 32 hex>       Metaplex JSON, image points at the .svg below
//   GET /art/p/<art 32 hex>/<seed 32 hex>.svg   the 24x24 pixel creature
//   GET /art/c/<pool>                           collection JSON, name read from the chain
// A launcher's own art, a folder on permanent storage (collection.json and the images; the
// schema and the draw are sdk/src/artpack.ts, built alone as ./_artpack.js):
//   GET /art/u/<id>/p/<art>/<seed>              Metaplex JSON of the piece
//   GET /art/u/<id>/p/<art>/<seed>.png          layers: the piece drawn (cached on disk);
//                                               pictures: a redirect to the picture
//   GET /art/u/<id>/c/<pool>                    collection JSON, image = the cover
//   GET /art/u/<id>/collection.json[?art=<hex>] the folder's collection.json as stored
//   GET /art/settings                           where the launch page uploads and reads
//   GET /art/hidden.png                         what a hidden folder's pieces show
// A piece answers only when the folder's collection.json hashes to the art bytes in the
// piece's address, so it always shows the collection it was minted under. The settings are
// environment variables, read by artSettings() below.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ART from "./_artpack.js";
import { startCompositor, encodePng } from "./_artpng.js";

export const HOOK_COLLECTIBLE = "3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m";
const IMMUTABLE = "public, max-age=31536000, immutable";

export function bytesOfHex(hex) { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }

export function pieceTraits(artHex, seedHex) {
  const art = bytesOfHex(artHex); const s = bytesOfHex(seedHex);
  const spread = art[4] || 24;
  const wob = (b) => ((b / 255) * 2 - 1) * spread;
  const roll = s[9];
  const rareAt = art[5] || 12;
  return {
    body: s[0] % 6, eyes: s[1] % 5, horn: s[2] % 4, mark: s[3] % 6, mirror: (s[4] & 1) === 0,
    hueMain: Math.round((art[2] * 360) / 255 + wob(s[5]) + 360) % 360,
    hueAccent: Math.round((art[3] * 360) / 255 + wob(s[6]) + 360) % 360,
    hueBg: Math.round((art[1] * 360) / 255 + wob(s[7]) / 2 + 360) % 360,
    rarity: roll < rareAt ? "rare" : roll < Math.min(rareAt * 4, 255) ? "uncommon" : "common",
  };
}

export function renderPieceSvg(artHex, seedHex, size = 480) {
  const t = pieceTraits(artHex, seedHex);
  const s = bytesOfHex(seedHex);
  const N = 24;
  const grid = Array.from({ length: N }, () => Array(N).fill(0));
  let st = 0;
  for (const b of s) st = (st * 31 + b + 7) >>> 0;
  const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
  const cx = 11, cy = 13, rx = 5 + (t.body % 3), ry = 6 + (t.body >> 1);
  for (let y = 0; y < N; y++) for (let x = 0; x < 12; x++) {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    const d = dx * dx + dy * dy;
    if (d < 1 - rnd() * 0.25) grid[y][x] = 1;
  }
  for (let y = 6; y < 20; y++) for (let x = 5; x < 12; x++) if (grid[y][x] === 1 && rnd() < 0.08 + t.mark * 0.03) grid[y][x] = 2;
  const hornH = 2 + t.horn;
  for (let i = 0; i < hornH; i++) { const y = cy - ry - i; if (y >= 0) { grid[y][cx - (t.horn % 2 ? i >> 1 : 0)] = 2; } }
  const ey = cy - 2 + (t.eyes % 2), ex = cx - 2 - (t.eyes >> 2);
  grid[ey][ex] = 3; if (t.eyes > 2) grid[ey + 1][ex] = 3;
  for (let y = 0; y < N; y++) for (let x = 0; x < 12; x++) grid[y][N - 1 - x] = grid[y][x];
  if (!t.mirror) for (let y = cy; y < cy + 3; y++) grid[y][N - 1 - (cx - 3)] = 2;
  const light = t.rarity === "rare" ? 62 : 54;
  const col = ["", `hsl(${t.hueMain} 78% ${light}%)`, `hsl(${t.hueAccent} 85% 62%)`, "#0a0a0d"];
  const bg = t.rarity === "rare" ? `hsl(${t.hueBg} 55% 20%)` : `hsl(${t.hueBg} 30% 13%)`;
  let rects = "";
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (grid[y][x]) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${col[grid[y][x]]}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${N}" height="${N}" fill="${bg}"/>${rects}</svg>`;
}

export function pieceMetadata(artHex, seedHex, name, imageUrl) {
  const t = pieceTraits(artHex, seedHex);
  return {
    name, image: imageUrl,
    description: "Minted by a trade on Programmable. The seed and the art parameters are fixed in this piece's address on chain.",
    attributes: [
      { trait_type: "Rarity", value: t.rarity }, { trait_type: "Body", value: t.body }, { trait_type: "Eyes", value: t.eyes },
      { trait_type: "Horn", value: t.horn }, { trait_type: "Mark", value: t.mark }, { trait_type: "Mirror", value: t.mirror ? "yes" : "no" },
      { trait_type: "Seed", value: seedHex }, { trait_type: "Art", value: artHex },
    ],
  };
}

// ---- collection config, read with one plain JSON-RPC call (no web3.js needed here) -------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const isBase58Key = (s) => typeof s === "string" && s.length >= 32 && s.length <= 44 && [...s].every((c) => B58.includes(c));

/// CollectionConfig layout after the 8-byte discriminator: 3 bumps, pool, creator, owner,
/// collection, base_mint, token_program (32 each), pegged bool, unit u64, max_supply u32,
/// minted u32, live u32, reserved u32, max_per_buy u8, art_version u16, art [16], name
/// string, uri_base string. The pool sits at offset 11, pegged at 203, max_supply at 212,
/// the art at 231, the name at 247. Mirrors sdk/src/collectible.ts decodeCollectionConfig.
const CFG = { pool: 11, pegged: 203, maxSupply: 212, minted: 216, live: 220, art: 231, name: 247 };
// sha256("account:CollectionConfig")[0..8]: only a config may answer, never a ticket or a burn queue
const CFG_DISC = createHash("sha256").update("account:CollectionConfig").digest().subarray(0, 8);
export function decodeCollection(d) {
  if (d.length < CFG.name + 4 || !d.subarray(0, 8).equals(CFG_DISC)) return null;
  const nameLen = d.readUInt32LE(CFG.name);
  if (nameLen > 64 || CFG.name + 4 + nameLen > d.length) return null;
  return {
    art: d.subarray(CFG.art, CFG.art + 16).toString("hex"), name: d.subarray(CFG.name + 4, CFG.name + 4 + nameLen).toString("utf8"),
    pegged: d[CFG.pegged] === 1, maxSupply: d.readUInt32LE(CFG.maxSupply), minted: d.readUInt32LE(CFG.minted), live: d.readUInt32LE(CFG.live),
  };
}
/// The chain's name of a pool's collection, read at most once in ten minutes per pool (a pool
/// that has none is asked again after a minute): the route is public, and one getProgramAccounts
/// per request would let anyone spend the RPC budget.
const chainNames = new Map(); // pool -> { until, value }, oldest first
// A key never asked before costs one chain read, and any address is a valid key, so new keys are
// budgeted: at most CHAIN_READS_PER_MINUTE_IP a visitor and CHAIN_READS_PER_MINUTE in all. Past it the
// answer goes out without the chain's name (the folder's own name), uncached, and nothing is read.
const boundedEnv = (name, def, min, max) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= min && n <= max ? n : def; };
const CHAIN_READS_PER_MINUTE = boundedEnv("ART_CHAIN_READS_PER_MINUTE", 60, 1, 6000);
const CHAIN_READS_PER_MINUTE_IP = boundedEnv("ART_CHAIN_READS_PER_MINUTE_IP", 6, 1, 600);
const chainReads = { all: [], by: new Map() };
function chainReadAllowed(visitor) {
  const now = Date.now(), fresh = (l) => { while (l.length && now - l[0] > 60000) l.shift(); return l; };
  if (fresh(chainReads.all).length >= CHAIN_READS_PER_MINUTE) return false;
  const mine = visitor ? fresh(chainReads.by.get(visitor) || []) : [];
  if (visitor && mine.length >= CHAIN_READS_PER_MINUTE_IP) return false;
  chainReads.all.push(now);
  if (visitor) { mine.push(now); chainReads.by.set(visitor, mine); if (chainReads.by.size > 10000) chainReads.by.clear(); }
  return true;
}
async function readCollectionCached(rpcUrl, pool, visitor) {
  const now = Date.now();
  const hit = chainNames.get(pool);
  if (hit && hit.until > now) return hit.value;
  if (!chainReadAllowed(visitor)) return undefined; // not read (budget): the caller answers uncacheable
  return once("c:" + pool, async () => {
    const value = await readCollection(rpcUrl, pool);
    chainNames.delete(pool);
    chainNames.set(pool, { until: Date.now() + (value ? 600000 : 60000), value });
    // the oldest entries go first, so the pools asked for most stay
    for (const k of chainNames.keys()) { if (chainNames.size <= 5000) break; chainNames.delete(k); }
    return value;
  });
}
async function readCollection(rpcUrl, pool) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [HOOK_COLLECTIBLE, { encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: CFG.pool, bytes: pool } }] }] }),
    });
    const j = await r.json();
    for (const acc of (j && j.result) || []) {
      const c = decodeCollection(Buffer.from(acc.account.data[0], "base64"));
      if (c) return c;
    }
    return null;
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}

// ---- uploaded art: settings ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORES = {
  // the local stand-in (web/review/art-standin.mjs): uploads and reads on this machine only
  local: (standin) => ({ node: standin, gateways: [standin] }),
  // Irys: since October 2026 uploader.irys.xyz stores on Irys's own chain; its gateway serves it
  irys: () => ({ node: "https://uploader.irys.xyz", gateways: ["https://gateway.irys.xyz"] }),
  // Arweave through ArDrive Turbo (uploads and payments are two services)
  turbo: () => ({ node: "https://upload.ardrive.io", payment: "https://payment.ardrive.io", gateways: ["https://arweave.net", "https://turbo-gateway.com"] }),
};
const isLocalOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(String(o || ""));
const list = (s) => String(s || "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter((x) => /^https?:\/\/[^\s]+$/i.test(x));

/// The uploaded-art settings, from environment variables. `opts.origin`: the site's public
/// address; `opts.uploadsDir`: the uploads folder, under which the cache and the hide list go
/// unless their own settings say otherwise.
///   ART_STORE              local | irys | turbo. Default: local on a localhost origin, else irys.
///   ART_STANDIN_URL        the local stand-in, default http://127.0.0.1:8792
///   ART_NODE               where the page uploads (default: the store's own)
///   ART_PAYMENT            turbo only: Turbo's payment service (default https://payment.ardrive.io)
///   ART_GATEWAYS           comma list of gateways, tried in order; the first one is written
///                          into the pieces' JSON (default: the store's own)
///   ART_CACHE_DIR          default <uploads>/art-cache
///   ART_CACHE_MAX_MB       disk cache size, oldest unused files go first (default 1024)
///   ART_HIDDEN_FILE        the hide list, default <uploads>/art-hidden.txt
///   ART_FETCH_TIMEOUT_MS   one gateway request (default 8000)
///   ART_COMPOSITE_QUEUE    pieces waiting to be drawn before the server says it is busy (16)
///   ART_COMPOSITE_WORKER   0 draws in the server's own thread, in short steps (default: a worker
///                          thread with a small heap, which keeps the memory peak lower; it
///                          stops after a minute without work)
///   ART_DRAW_MS_PER_MINUTE     drawing time the server spends on new pieces in a rolling minute, in
///                              all (default 20000: a third of one core); past it a piece not drawn
///                              before answers 429 for a while. Pieces drawn before come from the cache.
///   ART_DRAW_MS_PER_MINUTE_IP  the same for one visitor (default 8000)
export function artSettings(env = process.env, opts = {}) {
  const origin = String(opts.origin || env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  const uploads = path.resolve(opts.uploadsDir || env.UPLOADS_DIR || path.join(HERE, "..", "uploads"));
  let store = String(env.ART_STORE || "").trim().toLowerCase();
  if (!STORES[store]) store = isLocalOrigin(origin) || !origin ? "local" : "irys";
  const standin = list(env.ART_STANDIN_URL || "http://127.0.0.1:8792")[0] || "http://127.0.0.1:8792";
  const d = STORES[store](standin);
  const num = (v, def, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : def; };
  return {
    origin, store,
    node: list(env.ART_NODE)[0] || d.node,
    ...(store === "turbo" ? { payment: list(env.ART_PAYMENT)[0] || d.payment } : {}),
    gateways: list(env.ART_GATEWAYS).length ? list(env.ART_GATEWAYS) : d.gateways,
    cacheDir: path.resolve(env.ART_CACHE_DIR || path.join(uploads, "art-cache")),
    cacheMaxBytes: num(env.ART_CACHE_MAX_MB, 1024, 16, 1048576) * 1048576,
    hiddenFile: path.resolve(env.ART_HIDDEN_FILE || path.join(uploads, "art-hidden.txt")),
    timeoutMs: num(env.ART_FETCH_TIMEOUT_MS, 8000, 500, 120000),
    queue: num(env.ART_COMPOSITE_QUEUE, 16, 1, 1000),
    worker: env.ART_COMPOSITE_WORKER !== "0",
    drawMsPerMinute: num(env.ART_DRAW_MS_PER_MINUTE, 20000, 500, 600000),
    drawMsPerMinuteIp: num(env.ART_DRAW_MS_PER_MINUTE_IP, 8000, 100, 600000),
  };
}

// ---- the drawing budget ---------------------------------------------------------------------------------
// Anyone can ask for a piece of any layers collection under any seed, and a seed never drawn
// before costs a full composite (up to seconds of the one core the trade API shares). So the time
// spent drawing is budgeted: in a rolling minute at most drawMsPerMinute in all and
// drawMsPerMinuteIp per visitor. A draw is booked when it starts (at the folder's last measured
// time, a second when unknown) and settled when it ends, so a burst cannot slip through the
// check. Cache hits cost nothing and are never refused.
const drawn = { all: [], by: new Map(), last: new Map() }; // [{ at, ms }], ip -> [{ at, ms }], id -> ms
function spentIn(list, now) {
  let i = 0;
  while (i < list.length && now - list[i].at > 60000) i++;
  if (i) list.splice(0, i);
  let s = 0;
  for (const x of list) s += x.ms;
  return s;
}
/// null when the budget is spent, else the booking to settle with `settleDraw`.
function bookDraw(S, visitor, id) {
  const now = Date.now();
  const mine = visitor ? drawn.by.get(visitor) || [] : null;
  if (spentIn(drawn.all, now) >= S.drawMsPerMinute) return null;
  if (mine && spentIn(mine, now) >= S.drawMsPerMinuteIp) return null;
  const slot = { at: now, ms: drawn.last.get(id) || 1000, started: now };
  drawn.all.push(slot);
  if (mine) {
    mine.push(slot);
    drawn.by.set(visitor, mine);
    if (drawn.by.size > 10000) { for (const [k, v] of drawn.by) if (spentIn(v, now) === 0) drawn.by.delete(k); if (drawn.by.size > 10000) drawn.by.clear(); }
  }
  return slot;
}
function settleDraw(slot, id, drew) {
  const ms = drew ? Math.max(1, Date.now() - slot.started) : 0;
  slot.ms = ms;
  if (drew) drawn.last.set(id, ms);
  if (drawn.last.size > 5000) drawn.last.clear();
}
/// For tests: forget every booking.
export function resetDrawBudget() { drawn.all.length = 0; drawn.by.clear(); drawn.last.clear(); }

// ---- the hide list --------------------------------------------------------------------------------------

/// The folder ids in a hide list: one per line, the first word of the line; "#" starts a note.
export function parseHiddenList(text) {
  const ids = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const word = line.replace(/#.*$/, "").trim().split(/\s+/)[0];
    if (ART.isFolderId(word)) ids.add(word);
  }
  return ids;
}
let hidden = { file: "", mtime: -2, checked: 0, ids: new Set() };
/// Is this folder hidden by the site operator? The file is read again when it changes (looked at
/// at most every 2 seconds), so an id added by scripts/art-hide.mjs counts within seconds.
export function isHidden(S, id) {
  const now = Date.now();
  if (hidden.file !== S.hiddenFile || now - hidden.checked > 2000) {
    hidden.checked = now;
    let st = null;
    try { st = fs.statSync(S.hiddenFile); } catch (_) { /* no list: nothing hidden */ }
    const mtime = st ? st.mtimeMs : -1;
    if (hidden.file !== S.hiddenFile || mtime !== hidden.mtime) {
      let ids = new Set();
      try { if (st) ids = parseHiddenList(fs.readFileSync(S.hiddenFile, "utf8")); } catch (_) { ids = hidden.ids; }
      hidden = { file: S.hiddenFile, mtime, checked: now, ids };
    }
  }
  return hidden.ids.has(id);
}

// ---- the disk cache: collection.json files, layer files and drawn pieces, oldest unused out first ---------

const disk = { dir: "", index: null, total: 0 };
function cacheIndex(S) {
  if (disk.index && disk.dir === S.cacheDir) return disk.index;
  disk.dir = S.cacheDir; disk.index = new Map(); disk.total = 0;
  try {
    for (const sub of fs.readdirSync(S.cacheDir)) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      for (const f of fs.readdirSync(path.join(S.cacheDir, sub))) {
        if (f.endsWith(".tmp")) continue;
        try { const st = fs.statSync(path.join(S.cacheDir, sub, f)); disk.index.set(sub + "/" + f, { size: st.size, used: st.mtimeMs }); disk.total += st.size; } catch (_) { /* gone */ }
      }
    }
  } catch (_) { /* no cache yet */ }
  return disk.index;
}
const cacheName = (key, ext) => { const h = createHash("sha256").update(key).digest("hex"); return h.slice(0, 2) + "/" + h.slice(2, 42) + ext; };
function cacheGet(S, key, ext) {
  const idx = cacheIndex(S), name = cacheName(key, ext), e = idx.get(name);
  if (!e) return null;
  try { const b = fs.readFileSync(path.join(S.cacheDir, name)); e.used = Date.now(); return b; }
  catch (_) { idx.delete(name); disk.total -= e.size; return null; }
}
function cachePut(S, key, ext, bytes) {
  const idx = cacheIndex(S), name = cacheName(key, ext), file = path.join(S.cacheDir, name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
    const old = idx.get(name);
    if (old) disk.total -= old.size;
    idx.set(name, { size: bytes.length, used: Date.now() });
    disk.total += bytes.length;
    if (disk.total > S.cacheMaxBytes) {
      const goal = S.cacheMaxBytes * 0.9;
      for (const [n, v] of [...idx.entries()].sort((a, b) => a[1].used - b[1].used)) {
        if (disk.total <= goal) break;
        if (n === name) continue;
        try { fs.unlinkSync(path.join(S.cacheDir, n)); } catch (_) { /* already gone */ }
        idx.delete(n); disk.total -= v.size;
      }
    }
  } catch (_) { /* a read-only or full disk only costs a fetch next time */ }
}

// ---- reading a folder from the gateways ----------------------------------------------------------------

class ArtError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

/// Is `url` on one of the gateways (same scheme and host, same path prefix when a gateway has one)?
function onGateways(url, gateways) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  return gateways.some((g) => {
    let b;
    try { b = new URL(g); } catch (_) { return false; }
    const prefix = b.pathname.replace(/\/+$/, "");
    return u.protocol === b.protocol && u.host === b.host && (u.pathname === prefix || u.pathname.startsWith(prefix + "/"));
  });
}
/// One GET with a time limit and a size limit: { ok, bytes } or { missing } or { large } or { failed }.
/// A redirect is followed only onto one of the `gateways`, at most three times: the gateways are
/// the only hosts this server ever reads from.
async function fetchCapped(url, cap, timeoutMs, gateways = []) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let r = await fetch(url, { signal: ctl.signal, redirect: "manual" });
    for (let hops = 0; hops < 3 && [301, 302, 303, 307, 308].includes(r.status); hops++) {
      let next;
      try { next = new URL(r.headers.get("location") || "", url).href; } catch (_) { next = ""; }
      if (!next || !onGateways(next, gateways)) { ctl.abort(); return { failed: "a redirect off the storage gateway" }; }
      r = await fetch(next, { signal: ctl.signal, redirect: "manual" });
    }
    if ([301, 302, 303, 307, 308].includes(r.status)) { ctl.abort(); return { failed: "too many redirects" }; }
    if (r.status === 404 || r.status === 410) { ctl.abort(); return { missing: true }; }
    if (!r.ok) { ctl.abort(); return { failed: "HTTP " + r.status }; }
    if (Number(r.headers.get("content-length") || 0) > cap) { ctl.abort(); return { large: true }; }
    const chunks = []; let n = 0;
    for await (const c of r.body) {
      n += c.length;
      if (n > cap) { ctl.abort(); return { large: true }; }
      chunks.push(c);
    }
    return { ok: true, bytes: Buffer.concat(chunks.map((c) => Buffer.from(c))) };
  } catch (e) { return { failed: e && e.name === "AbortError" ? "no answer in time" : (e && e.message) || "failed" }; }
  finally { clearTimeout(timer); }
}
/// A file of a folder from the first gateway that has it. Throws an ArtError.
async function fromGateways(S, id, file, cap) {
  let missing = 0, failure = "";
  for (const gw of S.gateways) {
    const r = await fetchCapped(ART.artFileUrl(gw, id, file), cap, S.timeoutMs, S.gateways);
    if (r.ok) return r.bytes;
    if (r.large) throw new ArtError(422, "TOO_LARGE", "The file " + file + " of folder " + id + " is larger than " + cap + " bytes.");
    if (r.missing) missing++; else failure = r.failed;
  }
  if (missing === S.gateways.length) throw new ArtError(404, "NOT_FOUND", "The folder " + id + " has no file " + file + " on the storage gateway.");
  throw new ArtError(502, "GATEWAY", "The storage gateway did not answer for folder " + id + " (" + failure + "). Try again later.");
}

const MEM_MAX = 16 * 1048576;
const mem = new Map();          // id -> { bytes, art, collection }
let memBytes = 0;
const misses = new Map();       // key -> { until, error }: answers that failed, not asked again for a while
const inflight = new Map();     // key -> promise
const once = (key, fn) => { if (inflight.has(key)) return inflight.get(key); const p = fn().finally(() => inflight.delete(key)); inflight.set(key, p); return p; };
function remember(key, e) {
  // a folder never changes, so a broken one stays broken; a gateway that failed may come back
  const ms = e.code === "GATEWAY" ? 20000 : e.code === "NOT_FOUND" ? 60000 : 600000;
  misses.set(key, { until: Date.now() + ms, error: e });
  if (misses.size > 5000) misses.clear();
}
function recall(key) { const m = misses.get(key); if (!m) return; if (m.until < Date.now()) { misses.delete(key); return; } throw m.error; }

/// The folder's collection.json: { bytes, art (32 hex of its hash), collection }. Throws an ArtError.
export async function loadCollection(S, id) {
  const hit = mem.get(id);
  if (hit) { mem.delete(id); mem.set(id, hit); return hit; }
  const key = "m:" + id;
  recall(key);
  return once(key, async () => {
    let bytes = cacheGet(S, key, ".json");
    const fresh = !bytes;
    try {
      if (!bytes) bytes = await fromGateways(S, id, ART.ART_FILE, ART.ART_LIMITS.manifestBytes);
      let collection;
      try { collection = ART.parseCollection(new Uint8Array(bytes)); } catch (e) { throw new ArtError(422, "BAD_COLLECTION", "Folder " + id + ": " + e.message); }
      if (fresh) cachePut(S, key, ".json", bytes);
      const entry = { bytes, art: ART.collectionArtHex(new Uint8Array(bytes)), collection };
      mem.set(id, entry); memBytes += bytes.length;
      for (const [k, v] of mem) { if (memBytes <= MEM_MAX && mem.size <= 64) break; mem.delete(k); memBytes -= v.bytes.length; }
      return entry;
    } catch (e) { const err = e instanceof ArtError ? e : new ArtError(500, "INTERNAL", e.message || "failed"); remember(key, err); throw err; }
  });
}
async function loadFile(S, id, file, cap) {
  const key = "f:" + id + ":" + file;
  const hit = cacheGet(S, key, ".bin");
  if (hit) return hit;
  recall(key);
  return once(key, async () => {
    try { const b = await fromGateways(S, id, file, cap); cachePut(S, key, ".bin", b); return b; }
    catch (e) { const err = e instanceof ArtError ? e : new ArtError(500, "INTERNAL", e.message || "failed"); remember(key, err); throw err; }
  });
}

/// A layer for the drawing: { file } in the disk cache (fetched into it first when needed), or
/// its bytes when the cache cannot hold it.
async function layerSource(S, id, file) {
  const key = "f:" + id + ":" + file, name = cacheName(key, ".bin"), abs = path.join(S.cacheDir, name);
  const idx = cacheIndex(S);
  if (idx.has(name) && fs.existsSync(abs)) { idx.get(name).used = Date.now(); return { file: abs }; }
  const bytes = await loadFile(S, id, file, ART.ART_LIMITS.layerFileBytes);
  return idx.has(name) && fs.existsSync(abs) ? { file: abs } : bytes;
}

let compositor = null;
function drawer(S) { if (!compositor) compositor = startCompositor({ worker: S.worker, queue: S.queue }); return compositor; }
/// The piece of a layers collection drawn as a PNG, from the disk cache when drawn before. Pieces
/// that drew the same options share one file. A piece not drawn before counts against the drawing
/// budget of `visitor` and of the server (429 RATE_LIMIT when it is spent).
async function drawPiece(S, id, entry, pick, visitor) {
  const c = entry.collection;
  const key = "p:" + id + ":" + entry.art + ":" + pick.options.join(",");
  const hit = cacheGet(S, key, ".png");
  if (hit) return hit;
  return once(key, async () => {
    const slot = bookDraw(S, visitor, id);
    if (!slot) throw new ArtError(429, "RATE_LIMIT", "Too many new pieces drawn in a short time. Pieces drawn before still answer; try this one again in a minute.");
    let drew = false;
    try {
      const limits = { maxSide: ART.ART_LIMITS.layerSide, maxPixels: ART.ART_LIMITS.layerPixels };
      // the layers go to the drawing as files of the disk cache, so their bytes never sit in the
      // server's memory or get copied into the worker; bytes only when the cache cannot keep them
      const layers = [];
      for (const p of pick.images) layers.push(await layerSource(S, id, p));
      let png;
      try {
        drew = true;
        try { png = await drawer(S).run(layers, c.width, c.height, limits); }
        catch (e) {
          if (e.code !== "ENOENT") throw e;
          // a layer file left the cache in between: draw from the bytes
          const bytes = [];
          for (const p of pick.images) bytes.push(await loadFile(S, id, p, ART.ART_LIMITS.layerFileBytes));
          png = await drawer(S).run(bytes, c.width, c.height, limits);
        }
      } catch (e) {
        if (e.code === "BUSY") { drew = false; throw new ArtError(503, "BUSY", e.message); }
        if (e instanceof ArtError) throw e;
        throw new ArtError(422, "BAD_COLLECTION", "Folder " + id + ": a layer cannot be drawn. " + (e.message || ""));
      }
      cachePut(S, key, ".png", png);
      return png;
    } finally {
      settleDraw(slot, id, drew);
    }
  });
}

let placeholder = null;
/// What a hidden piece shows: a plain grey square.
function hiddenPng() {
  if (!placeholder) {
    const n = 256, d = new Uint8Array(n * n * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = 0x2a; d[i + 1] = 0x2a; d[i + 2] = 0x30; d[i + 3] = 255; }
    placeholder = encodePng(n, n, d, 9);
  }
  return placeholder;
}

const JSON_TYPE = "application/json; charset=utf-8";
const answer = (status, body, cache, headers) => ({ status, type: JSON_TYPE, cache, body: JSON.stringify(body), ...(headers ? { headers } : {}) });
const problem = (e) => answer(e.status || 500, { error: e.message, code: e.code || "INTERNAL" }, e.status === 503 || e.status === 429 || e.code === "GATEWAY" ? "no-store" : "public, max-age=60", e.status === 429 || e.status === 503 ? { "retry-after": "30" } : undefined);
const HIDDEN_TEXT = "Hidden by the site operator.";

/// The /art/u/ and /art/settings answers. `S`: artSettings(). `opts.visitor`: the requester's
/// address, for the drawing budget; `opts.head`: a HEAD request (a piece is not drawn for it).
export async function uploadedArtRoute(pathname, search, origin, rpcUrl, S, opts = {}) {
  if (pathname === "/art/settings") {
    const network = S.store === "turbo" ? "Arweave" : S.store === "irys" ? "Irys" : "this computer";
    return answer(200, { store: S.store, network, module: "art-store.js", node: S.node, ...(S.payment ? { payment: S.payment } : {}), gateways: S.gateways, uriBase: origin + "/art/u/", maxUriBase: ART.ART_URI_BASE_MAX }, "public, max-age=60");
  }
  if (pathname === "/art/hidden.png") return { status: 200, type: "image/png", cache: "public, max-age=86400", body: hiddenPng() };
  let m = /^\/art\/u\/([A-Za-z0-9_-]{32,44})\/(.*)$/.exec(pathname);
  if (!m) return null;
  const id = m[1], rest = m[2];
  const hiddenNow = isHidden(S, id);
  try {
    if (rest === ART.ART_FILE) {
      if (hiddenNow) return answer(410, { error: HIDDEN_TEXT, code: "HIDDEN", hidden: true }, "public, max-age=60");
      const e = await loadCollection(S, id);
      const want = /(?:^|[?&])art=([0-9a-f]{32})(?:&|$)/.exec(search || "");
      if (want && want[1] !== e.art) return answer(409, { error: "This folder's collection.json does not hash to the art bytes " + want[1] + ".", code: "ART_MISMATCH", art: e.art }, "public, max-age=600");
      return { status: 200, type: JSON_TYPE, cache: "public, max-age=3600", body: e.bytes, headers: { "x-art": e.art } };
    }
    if ((m = /^p\/([0-9a-f]{32})\/([0-9a-f]{32})(\.png)?$/.exec(rest))) {
      const [, art, seed, png] = m;
      if (hiddenNow) {
        if (png) return { status: 200, type: "image/png", cache: "public, max-age=300", body: hiddenPng() };
        const image = origin + "/art/hidden.png";
        return answer(200, { name: "Hidden piece", symbol: "", description: HIDDEN_TEXT, image, attributes: [], properties: { category: "image", files: [{ uri: image, type: "image/png" }] } }, "public, max-age=300");
      }
      const e = await loadCollection(S, id);
      if (e.art !== art) {
        return answer(409, { error: "This piece was minted with art bytes " + art + ", but the collection.json of folder " + id + " hashes to " + e.art + ". The piece belongs to another version of the art.", code: "ART_MISMATCH" }, "public, max-age=600");
      }
      const c = e.collection, pick = ART.pickPiece(c, seed);
      if (png) {
        if (c.kind === "pictures") return { status: 302, type: "text/plain; charset=utf-8", cache: "public, max-age=3600", body: "", headers: { location: ART.artFileUrl(S.gateways[0], id, pick.images[0]) } };
        // a HEAD asks what the answer would be, not for the drawing itself
        if (opts.head) return { status: 200, type: "image/png", cache: "public, max-age=86400", body: "" };
        return { status: 200, type: "image/png", cache: "public, max-age=86400", body: await drawPiece(S, id, e, pick, opts.visitor) };
      }
      const image = c.kind === "pictures" ? ART.artFileUrl(S.gateways[0], id, pick.images[0]) : origin + "/art/u/" + id + "/p/" + art + "/" + seed + ".png";
      const type = c.kind === "pictures" ? ART.artTypeOf(pick.images[0]) : "image/png";
      return answer(200, ART.artPieceMetadata(c, pick, image, type), "public, max-age=600");
    }
    if ((m = /^c\/([^/]+)$/.exec(rest)) && isBase58Key(m[1])) {
      const pool = m[1];
      if (hiddenNow) {
        const image = origin + "/art/hidden.png";
        return answer(200, { name: "Hidden collection", symbol: "", description: HIDDEN_TEXT, image, external_url: origin + "/coin.html?pool=" + pool, properties: { category: "image", files: [{ uri: image, type: "image/png" }] } }, "public, max-age=300");
      }
      const e = await loadCollection(S, id);
      const chain = rpcUrl ? await readCollectionCached(rpcUrl, pool, opts.visitor) : null;
      const c = e.collection;
      const body = ART.artCollectionMetadata(c, ART.artFileUrl(S.gateways[0], id, c.cover), ART.artTypeOf(c.cover), origin + "/coin.html?pool=" + pool);
      if (chain && chain.name) body.name = chain.name;
      // an answer made without the chain's read (the budget was spent) must not be kept by caches
      return answer(200, body, chain === undefined && rpcUrl ? "no-store" : "public, max-age=600");
    }
    return answer(404, { error: "Not an art path. Use /art/u/<folder>/p/<art>/<seed>, the same with .png, /art/u/<folder>/c/<pool> or /art/u/<folder>/collection.json.", code: "NOT_FOUND" }, "public, max-age=60");
  } catch (e) {
    if (e instanceof ArtError) return problem(e);
    return answer(500, { error: "The art could not be read: " + (e && e.message ? e.message : "failed"), code: "INTERNAL" }, "no-store");
  }
}

let defaultSettings = null;
/// One answer for every /art/ path: { status, type, cache, body, headers? }. `opts.settings`:
/// artSettings() of the server (read from the environment when missing); `opts.search`: the
/// query string of the request; `opts.visitor`: the requester's address (the drawing budget);
/// `opts.head`: a HEAD request.
export async function artRoute(pathname, origin, rpcUrl, opts = {}) {
  if (pathname.startsWith("/art/u/") || pathname === "/art/settings" || pathname === "/art/hidden.png") {
    const S = opts.settings || defaultSettings || (defaultSettings = artSettings(process.env, { origin }));
    const out = await uploadedArtRoute(pathname, opts.search || "", origin, rpcUrl, S, { visitor: opts.visitor, head: !!opts.head });
    if (out) return out;
  }
  let m;
  if ((m = /^\/art\/p\/([0-9a-f]{32})\/([0-9a-f]{32})\.svg$/.exec(pathname))) {
    return { status: 200, type: "image/svg+xml", cache: IMMUTABLE, body: renderPieceSvg(m[1], m[2]) };
  }
  if ((m = /^\/art\/p\/([0-9a-f]{32})\/([0-9a-f]{32})$/.exec(pathname))) {
    const image = origin + "/art/p/" + m[1] + "/" + m[2] + ".svg";
    return { status: 200, type: "application/json; charset=utf-8", cache: IMMUTABLE, body: JSON.stringify(pieceMetadata(m[1], m[2], "Programmable piece " + m[2].slice(0, 6), image)) };
  }
  if ((m = /^\/art\/c\/([^/]+)$/.exec(pathname)) && isBase58Key(m[1])) {
    const pool = m[1];
    const c = rpcUrl ? await readCollectionCached(rpcUrl, pool, opts.visitor) : null;
    const art = c ? c.art : "00000000000000000000000000000000";
    const seed = createHash("sha256").update(pool).digest("hex").slice(0, 32);
    const body = {
      name: c ? c.name : "Programmable collection",
      description: "Pieces minted by buys of this coin on Programmable. A wallet keeps one piece per set amount of coins it holds.",
      image: origin + "/art/p/" + art + "/" + seed + ".svg",
      external_url: origin + "/coin.html?pool=" + pool,
    };
    return { status: 200, type: "application/json; charset=utf-8", cache: c === undefined && rpcUrl ? "no-store" : "public, max-age=60", body: JSON.stringify(body) };
  }
  return { status: 404, type: "application/json; charset=utf-8", cache: "no-store", body: JSON.stringify({ error: "Not an art path. Use /art/p/<art 32 hex>/<seed 32 hex>, the same with .svg, or /art/c/<pool>." }) };
}
