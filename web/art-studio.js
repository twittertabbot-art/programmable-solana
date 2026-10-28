// The art of a collectible coin: the launch page's art section and the coin page's art editor.
//
// Four ways, one choice:
//   Generated          the site's pixel creatures, drawn from the 16 art bytes and each piece's
//                      seed (the renderer at <site>/art, as before)
//   Your pictures      finished images, each with its own name, traits and weight
//   Your layers        one image per layer (background, body, eyes...), mixed per piece
//   Your own renderer  an address that answers each piece's JSON, for experts
//
// Your pictures and Your layers end in an upload: collection.json and the image files go to
// Arweave as one folder, paid in SOL by the connected wallet, before the launch. The coin's
// uri_base is then <this site>/art/u/<folder id> and its art bytes are the first 16 bytes of the
// SHA-256 of collection.json as uploaded. The resolver (web/api/_art.js) serves each piece from
// that folder, and only when the file hashes to the art bytes in the piece's address.
//
// The draw (which picture, or which option of each layer, a piece shows) is the SDK's
// pickPiece(manifest, seed), the same function the resolver runs. The chances shown here are
// the SDK's traitOdds(manifest).
//
// artStudio(opts) builds the section and returns what the page reads from it. pieceArt(piece)
// is for the coin page: what one piece shows, read through the resolver.
import { ctx, H, Wallet, el, svg, fmtSol, fmtInt, toast, artEditor, signTx, sendSigned, requireWallet, openWallet, copyButton, short } from "./common.js";

// ---- the SDK's art module (sdk/src/artpack.ts) ------------------------------------------------------
// The schema and its checks (checkCollection), the exact bytes of collection.json
// (encodeCollection), the art bytes (collectionArt), the draw (pickPiece) and the chances
// (traitOdds). The page never has its own copy of any of them.

/// The limits of collection.json and of the files (the SDK's ART_LIMITS).
function limits() {
  const L = H.ART_LIMITS || {};
  return {
    items: L.items || 10000, layers: L.layers || 16, optionsPerLayer: L.optionsPerLayer || 100, options: L.options || 600,
    attributes: L.attributes || 32, nameBytes: L.nameBytes || 64, descriptionBytes: L.descriptionBytes || 2000, traitBytes: L.traitBytes || 64,
    urlBytes: L.urlBytes || 200, weight: L.weight || 1_000_000, fileBytes: L.fileBytes || 20_000_000, layerFileBytes: L.layerFileBytes || 4_000_000,
    layerSide: L.layerSide || 2048, layerPixels: L.layerPixels || 4_194_304, files: L.files || 10001, totalBytes: L.totalBytes || 1_000_000_000,
  };
}
const sdkPick = () => H.pickPiece || null;
const sdkOdds = () => H.traitOdds || null;
const sdkCheck = () => H.checkCollection || null;
/// A file name made safe for a path in the folder (the SDK's safeArtPath).
const safePath = (name) => (H.safeArtPath ? H.safeArtPath(name) : String(name).replace(/[^A-Za-z0-9._/-]+/g, "_").replace(/(^|\/)\.+/g, "$1"));
/// A folder id: an Arweave id (43 characters) or an Irys id (base58), 32 to 44 characters.
const isFolderId = (s) => (H.isFolderId ? H.isFolderId(String(s || "")) : /^[A-Za-z0-9_-]{32,44}$/.test(String(s || "")));

/// The site's storage settings (GET /art/settings): the store, the node, the gateways and the
/// start of an uploaded collection's uri_base. Read once.
let settingsPromise = null;
export function artSettings() {
  if (!settingsPromise) settingsPromise = fetch("/art/settings", { headers: { accept: "application/json" } })
    .then(async (r) => { const j = await r.json().catch(() => null); if (!r.ok || !j || !j.uriBase) throw new Error((j && j.error) || "This site does not offer uploads."); return j; })
    .catch((e) => { settingsPromise = null; throw e; });
  return settingsPromise;
}

// ---- small helpers ----------------------------------------------------------------------------------

const enc = new TextEncoder();
const bytesOf = (s) => enc.encode(String(s)).length;
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const extOf = (p) => { const m = /\.([a-z0-9]+)$/i.exec(p); return m ? m[1].toLowerCase() : ""; };
const baseOf = (p) => String(p).split("/").pop();
const stemOf = (p) => baseOf(p).replace(/\.[^.]+$/, "");
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare;
const plural = (n, one, many) => fmtInt(n) + " " + (n === 1 ? one : many || one + "s");
/// Put children into a node, leaving out the empty ones (replaceChildren would print "null").
const fill = (node, ...kids) => node.replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); }
/// A size in words: "812 KB", "4.2 MB".
export function fmtBytes(n) {
  if (n < 1000) return fmtInt(n) + " bytes";
  if (n < 1_000_000) return (n / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " KB";
  return (n / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: n < 10_000_000 ? 1 : 0 }) + " MB";
}
/// A chance in percent with the digits it needs: "25%", "3.33%", "0.012%".
export function fmtChance(p) {
  if (!isFinite(p) || p <= 0) return "0%";
  const digits = p >= 10 ? 1 : p >= 1 ? 2 : p >= 0.01 ? 3 : 4;
  return p.toLocaleString("en-US", { maximumFractionDigits: digits }) + "%";
}
function uniquePath(p, taken) { let out = p, i = 2; while (taken.has(out)) out = p.replace(/(\.[a-z0-9]+)?$/i, (m) => "-" + i++ + m); taken.add(out); return out; }

/// Does the file start the way its type says? png, jpeg, gif and webp only.
async function sniff(file) {
  const b = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer);
    return { type: "image/png", ext: "png", width: b.length >= 24 ? v.getUint32(16) : 0, height: b.length >= 24 ? v.getUint32(20) : 0 };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { type: "image/gif", ext: "gif" };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { type: "image/webp", ext: "webp" };
  return null;
}

// ---- reading what the launcher drops ----------------------------------------------------------------

const MAX_READ = 20000;
const SKIP = /(^|\/)(\.[^/]*|__MACOSX|thumbs\.db|desktop\.ini)(\/|$)/i;
function cleanEntries(list) {
  return list.map((x) => ({ path: String(x.path).replace(/\\/g, "/").replace(/^\/+/, ""), file: x.file }))
    .filter((x) => x.path && !SKIP.test(x.path)).slice(0, MAX_READ);
}
/// What a drop carries, taken while the drop event lasts (a DataTransfer empties after it).
function snapshotDrop(dt) {
  const items = dt && dt.items ? [...dt.items].filter((i) => i.kind === "file") : [];
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null));
  return { entries: entries.length && entries.every(Boolean) ? entries : null, files: dt && dt.files ? [...dt.files] : [] };
}
/// The files of a drop, folders walked: [{ path, file }] with paths like "Background/blue.png".
async function readDrop(snap) {
  if (!snap.entries) return cleanEntries(snap.files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f })));
  const out = [];
  const walk = async (entry, prefix) => {
    if (out.length >= MAX_READ) return;
    if (entry.isFile) out.push({ path: prefix + entry.name, file: await new Promise((res, rej) => entry.file(res, rej)) });
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, prefix + entry.name + "/");
      }
    }
  };
  for (const e of snap.entries) await walk(e, "");
  return cleanEntries(out);
}
const readInput = (input) => cleanEntries([...(input.files || [])].map((f) => ({ path: f.webkitRelativePath || f.name, file: f })));

/// A CSV file as rows of cells. The separator is the one the header line uses most: a comma,
/// a semicolon or a tab. Quoted cells may hold the separator, quotes ("") and line breaks.
export function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, "");
  const head = text.split(/\r?\n/, 1)[0] || "";
  const count = (c) => head.split(c).length - 1;
  const sep = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\"") { if (text[i + 1] === "\"") { cell += "\""; i++; } else quoted = false; }
      else cell += c;
    } else if (c === "\"" && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}

/// Attributes as the table shows them: "Background: Blue, Eyes: Laser".
export function traitsText(attrs) { return (attrs || []).map((a) => a.trait_type + ": " + a.value).join(", "); }
/// The table's text back into attributes. Returns { attrs, bad } where bad names the first part
/// that is not "Type: value". A value of digits only becomes a number, as wallets show stats.
export function parseTraits(text, before = []) {
  const attrs = [], keep = new Map((before || []).map((a) => [a.trait_type, a]));
  for (const part of String(text).split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    if (i <= 0 || !part.slice(i + 1).trim()) return { attrs, bad: part };
    const trait_type = part.slice(0, i).trim(), raw = part.slice(i + 1).trim();
    const value = /^-?\d+(\.\d+)?$/.test(raw) && raw.length < 16 ? Number(raw) : raw;
    const a = { trait_type, value };
    const was = keep.get(trait_type);
    if (was && was.display_type) a.display_type = was.display_type;
    attrs.push(a);
  }
  return { attrs, bad: "" };
}
function cleanAttrs(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && typeof a === "object" && a.trait_type !== undefined && a.value !== undefined && a.value !== null)
    .map((a) => { const o = { trait_type: String(a.trait_type).trim(), value: typeof a.value === "number" ? a.value : String(a.value).trim() }; if (a.display_type) o.display_type = String(a.display_type); return o; })
    .filter((a) => a.trait_type && a.value !== "");
}
const wholeWeight = (v) => { const n = Number(String(v).replace(/[,\s]/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n) : NaN; };

/// Finished pictures from a drop. Three layouts are read, the first that fits:
///   a CSV with a file column (file, name, weight, description, every other column a trait)
///   the Metaplex / Sugar layout: 0.png with 0.json next to it (name, description, attributes),
///     collection.json and collection.png for the collection itself
///   images alone: each one an entry named after its file
/// Returns { items, source, collection, cover, problems, notes }.
export async function readPictures(entries) {
  const problems = [], notes = [];
  const images = [], jsons = [], csvs = [], others = [];
  for (const e of entries) {
    const x = extOf(e.path);
    if (IMAGE_TYPES[x]) images.push(e); else if (x === "json") jsons.push(e); else if (x === "csv") csvs.push(e); else others.push(e);
  }
  if (others.length) notes.push(plural(others.length, "file") + " of another kind " + (others.length === 1 ? "was" : "were") + " left out: " + others.slice(0, 3).map((o) => baseOf(o.path)).join(", ") + (others.length > 3 ? " and more" : "") + ".");
  // images by their name, without case and without folders
  const byBase = new Map(), byStem = new Map();
  for (const im of images) { byBase.set(baseOf(im.path).toLowerCase(), im); if (!byStem.has(stemOf(im.path).toLowerCase())) byStem.set(stemOf(im.path).toLowerCase(), im); }
  const find = (name) => { if (!name) return null; const b = baseOf(String(name)).toLowerCase(); return byBase.get(b) || byStem.get(b.replace(/\.[^.]+$/, "")) || null; };
  const collection = {}; let cover = null;
  const used = new Set();
  let items = [], source = "images";

  // the collection's own files, in any layout
  for (const j of jsons) {
    if (stemOf(j.path).toLowerCase() !== "collection") continue;
    try {
      const c = JSON.parse(await j.file.text());
      if (c && typeof c === "object") for (const k of ["name", "symbol", "description", "external_url", "seller_fee_basis_points"]) if (c[k] !== undefined) collection[k] = c[k];
      if (c && c.properties && Array.isArray(c.properties.creators)) collection.creators = c.properties.creators;
      if (c && c.image) cover = find(c.image);
    } catch (_) { problems.push(baseOf(j.path) + " is not valid JSON."); }
  }
  if (!cover) cover = find("collection.png") || find("collection.jpg") || find("cover.png") || find("cover.jpg") || null;
  if (cover) used.add(cover);

  if (csvs.length) {
    source = "csv";
    if (csvs.length > 1) notes.push("Only " + baseOf(csvs[0].path) + " was read. The other CSV files were left out.");
    const rows = parseCsv(await csvs[0].file.text());
    const head = (rows.shift() || []).map((h) => h.toLowerCase());
    const col = (names) => head.findIndex((h) => names.includes(h.replace(/[\s-]+/g, "_")));
    const fi = col(["file", "filename", "file_name", "image", "picture", "path"]);
    const ni = col(["name", "title"]), di = col(["description"]);
    let wi = col(["weight", "rarity", "chance", "odds"]);
    if (fi < 0) problems.push(baseOf(csvs[0].path) + " has no file column. Name one column file, with the picture's file name in it.");
    else {
      // a rarity column of words (common, rare) is a trait, not a weight
      if (wi >= 0 && rows.some((r) => r[wi] && !Number.isFinite(wholeWeight(r[wi])))) wi = -1;
      const rawHead = rows.length ? head : [];
      rows.forEach((r, n) => {
        const im = find(r[fi]);
        if (!im) { problems.push("Row " + (n + 2) + " of the CSV names " + (r[fi] || "no file") + ", which was not dropped."); return; }
        used.add(im);
        const attributes = [];
        head.forEach((h, k) => { if (k === fi || k === ni || k === di || k === wi || !r[k]) return; attributes.push({ trait_type: csvHeadOriginal(rawHead, k, h), value: r[k] }); });
        items.push({ src: im, name: ni >= 0 && r[ni] ? r[ni] : stemOf(im.path), description: di >= 0 ? r[di] || "" : "", attributes, weight: wi >= 0 ? wholeWeight(r[wi]) || 1 : 1 });
      });
    }
  } else {
    const metas = [];
    for (const j of jsons) {
      const stem = stemOf(j.path).toLowerCase();
      if (stem === "collection" || stem.startsWith("_")) continue;
      if (j.file.size > 100_000) { problems.push(baseOf(j.path) + " is larger than 100 KB, so it was left out."); continue; }
      let m;
      try { m = JSON.parse(await j.file.text()); } catch (_) { problems.push(baseOf(j.path) + " is not valid JSON."); continue; }
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      const fromField = typeof m.image === "string" && !/^[a-z]+:/i.test(m.image) ? find(m.image) : null;
      const im = fromField || find(stemOf(j.path));
      if (!im) { problems.push(baseOf(j.path) + " has no picture next to it. Drop " + stemOf(j.path) + ".png with it."); continue; }
      used.add(im);
      metas.push({ stem, item: { src: im, name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : stemOf(im.path), description: typeof m.description === "string" ? m.description : "", attributes: cleanAttrs(m.attributes), weight: Number.isFinite(wholeWeight(m.weight)) ? wholeWeight(m.weight) : 1 } });
      if (collection.seller_fee_basis_points === undefined && Number.isFinite(m.seller_fee_basis_points)) collection.seller_fee_basis_points = m.seller_fee_basis_points;
      if (!collection.creators && m.properties && Array.isArray(m.properties.creators)) collection.creators = m.properties.creators;
    }
    if (metas.length) {
      source = "metaplex";
      metas.sort((a, b) => natural(a.stem, b.stem));
      items = metas.map((x) => x.item);
    }
  }
  // the pictures nothing named: entries of their own
  const rest = images.filter((im) => !used.has(im)).sort((a, b) => natural(a.path, b.path));
  if (rest.length && source !== "images") notes.push(plural(rest.length, "picture") + " had no entry in your files. " + (rest.length === 1 ? "It was" : "They were") + " added with " + (rest.length === 1 ? "its" : "their") + " file name.");
  for (const im of rest) items.push({ src: im, name: stemOf(im.path).replace(/[_-]+/g, " ").trim() || stemOf(im.path), description: "", attributes: [], weight: 1 });
  // each picture's real type, read from its first bytes
  const L = limits();
  const kept = [];
  for (const it of items) {
    const kind = await sniff(it.src.file);
    if (!kind) { problems.push(baseOf(it.src.path) + " is not a png, jpg, gif or webp image."); continue; }
    if (it.src.file.size > L.fileBytes) { problems.push(baseOf(it.src.path) + " is " + fmtBytes(it.src.file.size) + ". One picture may be at most " + fmtBytes(L.fileBytes) + "."); continue; }
    kept.push({ ...it, file: it.src.file, path: it.src.path, type: kind.type, ext: kind.ext, size: it.src.file.size, width: kind.width, height: kind.height });
  }
  if (kept.length > L.items) { problems.push("You dropped " + fmtInt(kept.length) + " pictures. A collection may hold " + fmtInt(L.items) + "."); kept.length = L.items; }
  let coverOut = null;
  if (cover) { const kind = await sniff(cover.file); if (kind) coverOut = { file: cover.file, path: cover.path, type: kind.type, ext: kind.ext, size: cover.file.size }; }
  return { items: kept, source, collection, cover: coverOut, problems, notes };
}
function csvHeadOriginal(head, k, h) { return h ? h.replace(/(^|[\s_])([a-z])/g, (m, s, c) => (s === "_" ? " " : s) + c.toUpperCase()).trim() : "Trait " + (k + 1); }

/// Layers from a drop: one group per folder (the folder right above the file), or per name
/// before a slash. A number before the folder's name orders the layers ("1_Background") and is
/// left out of the trait's name. A weight after # in a file's name ("Blue#20.png") is kept as
/// the option's weight. Returns { layers, problems, notes, width, height }.
export async function readLayers(entries) {
  const problems = [], notes = [];
  const groups = new Map();
  const L = limits();
  let width = 0, height = 0;
  for (const e of entries) {
    const x = extOf(e.path);
    if (x === "json" || x === "csv" || x === "txt" || x === "md") continue;
    const parts = e.path.split("/");
    if (parts.length < 2) { problems.push(baseOf(e.path) + " is not inside a layer folder. Put each layer's files in a folder named after the layer."); continue; }
    if (x !== "png") { problems.push(baseOf(e.path) + " is not a PNG. Layers are PNG files with transparency."); continue; }
    const kind = await sniff(e.file);
    if (!kind || kind.type !== "image/png") { problems.push(baseOf(e.path) + " is not a PNG image."); continue; }
    if (e.file.size > L.layerFileBytes) { problems.push(baseOf(e.path) + " is " + fmtBytes(e.file.size) + ". One layer image may be at most " + fmtBytes(L.layerFileBytes) + "."); continue; }
    if (!width) { width = kind.width; height = kind.height; }
    else if (kind.width !== width || kind.height !== height) { problems.push(parts.slice(-2).join("/") + " is " + kind.width + " by " + kind.height + " pixels. The other layers are " + width + " by " + height + ". Every layer must be the same size."); continue; }
    const folder = parts[parts.length - 2];
    if (!groups.has(folder)) groups.set(folder, []);
    const stem = stemOf(e.path);
    const m = /^(.*?)#(\d+(?:\.\d+)?)$/.exec(stem);
    groups.get(folder).push({ file: e.file, path: e.path, size: e.file.size, value: (m ? m[1] : stem).replace(/[_]+/g, " ").trim() || stem, weight: m ? wholeWeight(m[2]) || 1 : 1 });
  }
  const folders = [...groups.keys()].sort(natural);
  let layers = folders.map((f) => ({ name: f.replace(/^\d+[\s._-]+/, "").replace(/[_]+/g, " ").trim() || f, options: groups.get(f).sort((a, b) => natural(a.value, b.value)), empty: false, emptyWeight: 1 }));
  if (layers.length > L.layers) { problems.push("You dropped " + layers.length + " layers. A collection may have " + L.layers + "."); layers = layers.slice(0, L.layers); }
  for (const l of layers) if (l.options.length > L.optionsPerLayer - 1) { problems.push("The layer " + l.name + " has " + l.options.length + " images. A layer may have " + (L.optionsPerLayer - 1) + "."); l.options.length = L.optionsPerLayer - 1; }
  if (width > L.layerSide || height > L.layerSide || width * height > L.layerPixels) problems.push("The layers are " + width + " by " + height + " pixels. The most is " + L.layerSide + " on a side.");
  return { layers, problems, notes, width, height };
}

// ---- the manifest -----------------------------------------------------------------------------------

/// The draw of one piece from a manifest and a seed: the SDK's pickPiece (ArtPick: item,
/// options, images bottom first, attributes, chance 0..1). null when it cannot be drawn.
export function drawPiece(manifest, seedHex) {
  const pick = sdkPick();
  if (!pick || !manifest) return null;
  try { return pick(manifest, seedHex); } catch (_) { return null; }
}
/// Every trait value's chance in percent: { "Background": { "Blue": 25, ... } }, from the
/// SDK's traitOdds (chance 0..1 per value).
export function oddsOf(manifest) {
  const f = sdkOdds();
  if (!f || !manifest) return null;
  try {
    const out = {};
    for (const t of f(manifest) || []) { const m = (out[t.trait_type] = out[t.trait_type] || {}); for (const v of t.values || []) m[String(v.value)] = Number(v.chance) * 100; }
    return out;
  } catch (_) { return null; }
}
/// The SDK's checks of a manifest with the files it names: { errors, warnings, collection, bytes }.
function checkManifest(m, files) {
  const f = sdkCheck();
  if (!f) return { errors: ["The site's art module did not load. Reload the page."], warnings: [], collection: null, bytes: 0 };
  try { const r = f(m, files); return { errors: r.errors || [], warnings: r.warnings || [], collection: r.collection || null, bytes: r.bytes || 0 }; }
  catch (e) { return { errors: [String(e.message || e)], warnings: [], collection: null, bytes: 0 }; }
}

// ---- receipts of files stored earlier, so a file is never paid twice --------------------------------

const RECEIPTS = "Programmable.artReceipts";
function receipts() { try { return JSON.parse(localStorage.getItem(RECEIPTS) || "{}") || {}; } catch (_) { return {}; } }
function keepReceipts(store, list) {
  try {
    const all = receipts();
    for (const [hash, id] of list) all[store + ":" + hash] = id;
    const keys = Object.keys(all);
    if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete all[k];
    localStorage.setItem(RECEIPTS, JSON.stringify(all));
  } catch (_) {}
}

// ---- the storage module (Irys on mainnet, the local stand-in in tests) -------------------------------

/// The storage module of each store: the local stand-in, Arweave through Turbo, Irys. A setting
/// `module` (a file name in js/) names another one.
const STORE_MODULES = { local: "art-store.js", turbo: "art-store-turbo.js", irys: "art-store-irys.js" };
const storeModule = (settings) => "./js/" + (/^[a-z0-9-]+\.js$/.test(String(settings.module || "")) ? settings.module : STORE_MODULES[settings.store] || "art-store.js");
// The store keeps an opaque session (a throwaway upload key) that a payment funds. The page keeps
// it per wallet in this browser until the coin is launched (or the collection saved), and hands it
// back when the store is opened again, so a paid balance and a failed run's receipts are not lost.
// It is never shown and never sent anywhere else.
const SESSIONS = "Programmable.artSession";
const sessionKey = (who) => SESSIONS + "." + who;
function savedSession(who) { try { return who ? localStorage.getItem(sessionKey(who)) || null : null; } catch (_) { return null; } }
function keepSession(who, session) { try { if (who && session) localStorage.setItem(sessionKey(who), String(session)); } catch (_) {} }
function dropSession(who) { try { if (who) localStorage.removeItem(sessionKey(who)); } catch (_) {} }
let storeOpen = null; // { session, promise }
/// The storage module (Turbo, Irys or the local stand-in, as /art/settings says), opened with the
/// connected wallet's saved session. Opened again only when that session changes. It throws a
/// sentence when it cannot be loaded.
function loadStore() {
  const who = Wallet.current().publicKey ? Wallet.current().publicKey.toBase58() : "";
  const session = savedSession(who);
  if (storeOpen && (storeOpen.session === session || (!session && !who))) return storeOpen.promise;
  const promise = (async () => {
    const settings = await artSettings();
    const m = await import(storeModule(settings));
    if (typeof m.openStore !== "function") throw new Error("The storage module has no openStore.");
    const store = await m.openStore({ connection: ctx.connection, cluster: ctx.cluster, wallet: walletFace(), settings, session: session || undefined });
    if (who && store.session) keepSession(who, store.session);
    return store;
  })().catch((e) => { storeOpen = null; throw new Error("The storage service could not be loaded. " + plainMsg(e)); });
  storeOpen = { session, promise };
  return promise;
}
/// What the storage module may use of the wallet: its address and, for the stores that need it,
/// one signed message per upload. It never gets a transaction to sign: the page pays with its
/// own transfer.
function walletFace() {
  return {
    get publicKey() { return Wallet.current().publicKey; },
    signMessage: (bytes) => Wallet.signMessage(bytes),
  };
}
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/// What an upload of `count` new files of `bytes` in all costs, in a folder of `paths` files. The
/// store's price counts the folder's own list of paths and the rounding of a price taken file by
/// file. Files stored before are not sent again, but the list still names them: about 190 bytes
/// each, added here.
async function quote(store, bytes, count, paths = count) {
  return BigInt(await store.price(bytes + Math.max(0, paths - count) * 190, count));
}
/// The page's own payment: one plain SOL transfer, built here, signed by the wallet first, with a
/// memo when the store asks for one (it names the key the payment credits). It is simulated
/// before the wallet sees it: the wallet is never handed a transaction that fails now. A payment
/// to an address with no account is raised to the least such an account may hold.
async function payTo(to, lamports, memo) {
  const from = requireWallet();
  const dest = new H.PublicKey(String(to));
  let amount = BigInt(lamports);
  const [info, min] = await Promise.all([ctx.connection.getAccountInfo(dest, "confirmed"), ctx.connection.getMinimumBalanceForRentExemption(0)]);
  if (!info && amount < BigInt(min)) amount = BigInt(min);
  const ixs = [H.SystemProgram.transfer({ fromPubkey: from, toPubkey: dest, lamports: amount })];
  if (typeof memo === "string" && memo) ixs.push(new H.TransactionInstruction({ programId: new H.PublicKey(MEMO_PROGRAM), keys: [], data: enc.encode(memo) }));
  const built = await ctx.client.buildTx(from, ixs);
  const sim = await ctx.connection.simulateTransaction(built.tx, { sigVerify: false, commitment: "confirmed" });
  if (sim.value.err) throw new Error("The payment of " + fmtSol(amount, 6) + " SOL would fail now, so it was not sent. Check the SOL in this wallet.");
  return sendSigned(await signTx(built.tx), built, "storage payment");
}

// ---- the section ------------------------------------------------------------------------------------

const MODES = [
  { key: "generated", title: "Generated", line: "Pixel creatures drawn by this site from each piece's seed." },
  { key: "pictures", title: "Your pictures", line: "Finished images, each with its own name, traits and rarity." },
  { key: "layers", title: "Your layers", line: "Backgrounds, bodies, eyes. Each piece mixes one of each." },
  { key: "renderer", title: "Your own renderer", line: "Your server answers each piece. For experts." },
];
const ICON_UP = "M6 15l6-6 6 6", ICON_DOWN = "M6 9l6 6 6-6", ICON_GRIP = "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01";
const ICON_FILES = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6";
const ICON_FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6";
const PAGE_ROWS = 50;

/// The art section. opts:
///   id            the id of the section's root (the review tools find it by that)
///   context       "launch" (a new coin) or "edit" (the coin page, before the collection is locked)
///   art           the art bytes to start the generated editor with (Uint8Array(16) or null)
///   uriBase       the coin's uri_base, on the coin page: the section starts on what it is
///   name, symbol  functions that return the collection's name and the coin's ticker
///   onChange      called after every change the page's review depends on
/// Returns { node, mode(), problem(), fieldProblems(), target(), note(), storeCost() }.
export function artStudio(opts = {}) {
  const origin = location.origin;
  // the start of an uploaded collection's uri_base, from /art/settings once it is read
  let uploadBase = origin + "/art/u/";
  let tooLong = bytesOf(uploadBase) + 43 > 80;
  const onChange = () => { if (opts.onChange) opts.onChange(); };
  const S = {
    mode: "generated",
    pictures: null,  // { items, source, collection, problems, notes }
    layers: null,    // { layers, problems, notes, width, height }
    covers: {},      // per way: { file, type, ext, url, fromDrop } the launcher chose or dropped
    description: "", external: "",
    common: [],      // traits every piece of a layered collection has
    upload: null,    // { id, art: Uint8Array, artHex, jsonHash, files } of the last upload
    busy: false, failed: null, price: null, priceFor: -1, priceErr: "", store: null,
    seeds: Array.from({ length: 6 }, randomSeed), coverSeed: randomSeed(),
    showAll: false,
  };
  // On the coin page nothing is picked at first: the art stays as it is until the owner picks
  // one of the four ways ("keep"). The line above the choice says what the pieces use now.
  // S.cover is the cover of the way that is picked: pictures and layers keep their own
  Object.defineProperty(S, "cover", { get: () => S.covers[S.mode] || null, set: (v) => { S.covers[S.mode] = v; } });
  const current = { uriBase: String(opts.uriBase || ""), folder: folderOf(opts.uriBase) };
  if (opts.context === "edit") S.mode = "keep";

  // -- the choice --
  const choices = el("div", { class: "choices art-modes", role: "radiogroup", "aria-label": "Where the art comes from" });
  const name = (opts.id || "art") + "Mode";
  for (const m of MODES) choices.append(el("label", { class: "choice", "data-mode": m.key },
    el("input", { type: "radio", name, value: m.key }),
    el("div", { class: "title", text: m.title }), el("p", { text: m.line })));
  const offLine = el("p", { class: "help", hidden: true });
  /// Your pictures and Your layers are off when the site offers no uploads, or when its address
  /// leaves no room for a folder id in the 80 bytes of a uri_base.
  function uploadsOff(why) {
    for (const k of ["pictures", "layers"]) { const c = choices.querySelector("[data-mode=" + k + "]"); c.classList.toggle("off", !!why); c.querySelector("input").disabled = !!why; }
    offLine.hidden = !why; offLine.textContent = why || "";
    if (why && (S.mode === "pictures" || S.mode === "layers")) setMode(opts.context === "edit" ? "keep" : "generated");
  }
  const longWhy = () => "Your pictures and Your layers are off on this site. Its address is too long: a piece's address may hold 80 bytes, and this site needs " + (bytesOf(uploadBase) + 43) + ".";
  const nowLine = el("p", { class: "help art-now", hidden: true });

  // -- generated --
  const editor = artEditor(opts.art && opts.art.length === 16 ? opts.art : null, onChange);
  editor.node.classList.add("wide");
  const genBody = el("div", { class: "art-body", "data-body": "generated" }, editor.node);

  // -- your own renderer --
  const ownRenderer = current.uriBase && !current.folder && current.uriBase.replace(/\/+$/, "") !== origin + "/art";
  const baseIn = el("input", { class: "input mono", maxlength: 80, autocomplete: "off", spellcheck: "false", value: ownRenderer ? current.uriBase : origin + "/art", "aria-label": "Renderer base" });
  const artIn = el("input", { class: "input mono", maxlength: 32, autocomplete: "off", spellcheck: "false", placeholder: "32 hex characters", "aria-label": "Art bytes" });
  const baseErr = el("p", { class: "error-text", "aria-live": "polite" });
  baseIn.addEventListener("input", () => { drawRendererErrors(); onChange(); });
  artIn.addEventListener("input", () => { drawRendererErrors(); onChange(); });
  const renBody = el("div", { class: "art-body", "data-body": "renderer", hidden: true },
    el("label", { class: "field" }, el("span", null, el("span", { text: "Renderer base" }), el("span", { class: "dim", text: "at most 80 bytes" })), baseIn),
    el("label", { class: "field" }, el("span", null, el("span", { text: "Art bytes" }), el("span", { class: "dim", text: "optional" })), artIn),
    baseErr,
    el("p", { class: "help", text: "A piece's address is the base, then /p/, the 16 art bytes and the piece's 16 seed bytes, in hex. The collection's is the base, then /c/ and the pool. Your server answers both with Metaplex JSON. Empty art bytes take the colours of Generated." }));

  // -- your pictures --
  const picDrop = dropZone("pictures", "Drop a folder or your pictures here", "Numbered pairs such as 0.png and 0.json (the Metaplex layout), a CSV with a file column, or images alone.", (entries) => ingest("pictures", entries));
  const picSummary = el("div", { class: "art-summary", "aria-live": "polite" });
  const picTable = el("div", { class: "art-table", role: "table", "aria-label": "Your pictures" });
  const picMore = el("div", { class: "art-more" });
  const picHelp = el("div", { class: "art-help", hidden: true },
    el("p", { class: "help", text: "Weight is the rarity. A picture of weight 2 is drawn twice as often as a picture of weight 1. Chance is its share of every draw." }),
    el("p", { class: "help", text: "Write traits as Type: value, with a comma between two traits. Wallets and marketplaces show them." }));
  const picBody = el("div", { class: "art-body", "data-body": "pictures", hidden: true }, picDrop.node, picSummary, picTable, picMore, picHelp);

  // -- your layers --
  const layDrop = dropZone("layers", "Drop your layers folder here", "One folder per layer, PNG files with transparency, all the same size. A weight after # in a file name is kept, as in Blue#20.png.", (entries) => ingest("layers", entries));
  const laySummary = el("div", { class: "art-summary", "aria-live": "polite" });
  const layList = el("div", { class: "layer-list" });
  const commonIn = el("input", { class: "input", autocomplete: "off", placeholder: "Type: value, Type: value", "aria-label": "Traits every piece has" });
  const commonErr = el("p", { class: "error-text", "aria-live": "polite" });
  commonIn.addEventListener("input", () => { const r = parseTraits(commonIn.value, S.common); commonErr.textContent = r.bad ? "Write each trait as Type: value. This part is not: " + r.bad : ""; if (!r.bad) S.common = r.attrs; changed(); });
  const strip = el("div", { class: "piece-strip art-strip" });
  const previewNote = el("p", { class: "error-text", hidden: true });
  const shuffle = el("button", { class: "btn btn-sm", type: "button", text: "Shuffle", onclick: () => { S.seeds = Array.from({ length: 6 }, randomSeed); drawPreview(); } });
  const preview = el("div", { class: "art-preview-box", hidden: true },
    el("div", { class: "art-preview-head" }, el("h3", { text: "Preview" }), shuffle),
    strip, previewNote,
    el("p", { class: "help", text: "Six pieces from random seeds, drawn the way the site will draw them. Each layer picks one option with the weights above." }));
  const commonBox = el("label", { class: "field art-common", hidden: true }, el("span", null, el("span", { text: "Traits every piece has" }), el("span", { class: "dim", text: "optional" })), commonIn);
  const layBody = el("div", { class: "art-body", "data-body": "layers", hidden: true }, layDrop.node, laySummary, layList, commonBox, commonErr, preview);

  // -- the collection's details and the upload, for pictures and layers --
  const descIn = el("textarea", { maxlength: 1000, placeholder: "About the collection", "aria-label": "Collection description" });
  descIn.addEventListener("input", () => { S.description = descIn.value; changed(); });
  const extIn = el("input", { class: "input", type: "url", placeholder: "https://", autocomplete: "off", "aria-label": "Collection website" });
  extIn.addEventListener("input", () => { S.external = extIn.value.trim(); changed(); });
  const coverImg = el("img", { class: "art-cover", alt: "", width: 56, height: 56 });
  const coverLine = el("span", { class: "help art-cover-line" });
  const coverInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", "aria-label": "Choose a cover" });
  coverInput.addEventListener("change", async () => {
    const f = coverInput.files && coverInput.files[0];
    coverInput.value = "";
    if (!f) return;
    const kind = await sniff(f);
    if (!kind) { toast("The cover must be a png, jpg, gif or webp image.", "err"); return; }
    if (S.cover && S.cover.url) URL.revokeObjectURL(S.cover.url);
    S.cover = { file: f, type: kind.type, ext: kind.ext, url: URL.createObjectURL(f) };
    changed();
  });
  const coverBtn = el("span", { class: "btn btn-sm file-btn" }, svg("M4 16l4.5-4.5 4 4 2.5-2.5 5 5M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"), "Choose a cover", coverInput);
  const details = el("div", { class: "art-details", hidden: true },
    el("h3", { text: "Cover and description" }),
    el("div", { class: "field art-cover-row" }, coverImg, el("div", null, coverBtn, coverLine)),
    el("label", { class: "field" }, el("span", null, el("span", { text: "Description" }), el("span", { class: "dim", text: "shown with every piece without its own" })), descIn),
    el("label", { class: "field" }, el("span", null, el("span", { text: "Website" }), el("span", { class: "dim", text: "optional" })), extIn),
    el("p", { class: "help art-royalty", hidden: true }));

  const storeKv = el("dl", { class: "kv" });
  // where the files go: Arweave unless the site's settings name another network
  const netLine = el("p", { class: "help" });
  const network = (name) => { netLine.textContent = "The files are stored on " + name + " for good. The connected wallet pays for them in SOL, " + (opts.context === "edit" ? "before you save." : "before the launch."); };
  network("Arweave");
  const storeErr = el("p", { class: "error-text", "aria-live": "polite" });
  const bar = el("span");
  const progress = el("div", { class: "art-progress", hidden: true }, el("div", { class: "art-bar" }, bar), el("p", { class: "small", "aria-live": "polite" }));
  const upBtn = el("button", { class: "btn btn-primary btn-block", type: "button", text: "Pay and upload" });
  upBtn.addEventListener("click", () => upload());
  const stored = el("div", { class: "art-stored", hidden: true });
  const storeBox = el("div", { class: "raised art-store", hidden: true },
    el("h3", { text: "Store the art" }),
    storeKv,
    netLine,
    el("p", { class: "help", text: "Rarity is a chance. A later block picks each piece's seed, and the seed draws its art. Two pieces can show the same art, and no art is promised a number of pieces." }),
    el("p", { class: "help", text: "A burned piece frees its place for a new one, so over a coin's life more pieces are drawn than the max supply." }),
    progress, storeErr, upBtn, stored);

  const node = el("div", { class: "art-studio", id: opts.id || null }, nowLine, choices, offLine, genBody, picBody, layBody, renBody, details, storeBox);

  // ---- the drop zones ----
  function dropZone(kind, title, line, take) {
    const files = el("input", { type: "file", multiple: true, accept: kind === "layers" ? "image/png" : "image/png,image/jpeg,image/gif,image/webp,application/json,.json,text/csv,.csv", "aria-label": "Choose files", "data-pick": "files" });
    const folder = el("input", { type: "file", multiple: true, webkitdirectory: true, "aria-label": "Choose a folder", "data-pick": "folder" });
    const zone = el("div", { class: "art-drop", "data-drop": kind },
      el("div", { class: "art-drop-t", text: title }),
      el("p", { class: "help", text: line }),
      el("div", { class: "art-drop-btns" },
        el("span", { class: "btn btn-sm file-btn" }, svg(ICON_FOLDER), "Choose a folder", folder),
        el("span", { class: "btn btn-sm file-btn" }, svg(ICON_FILES), "Choose files", files)));
    const read = async (getEntries) => {
      zone.classList.add("reading");
      try { take(await getEntries()); } catch (e) { toast("Those files could not be read. " + (e && e.message ? e.message : ""), "err"); }
      zone.classList.remove("reading");
    };
    for (const input of [files, folder]) input.addEventListener("change", () => { const list = readInput(input); input.value = ""; read(async () => list); });
    let depth = 0;
    zone.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; zone.classList.add("over"); });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
    zone.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove("over"); });
    zone.addEventListener("drop", (e) => { e.preventDefault(); depth = 0; zone.classList.remove("over"); const snap = snapshotDrop(e.dataTransfer); read(() => readDrop(snap)); });
    return { node: zone, files, folder };
  }

  async function ingest(kind, entries) {
    if (!entries.length) { toast("No files came in.", "err"); return; }
    if (kind === "pictures") {
      if (S.pictures) for (const it of S.pictures.items) if (it.url) URL.revokeObjectURL(it.url);
      const r = await readPictures(entries);
      for (const it of r.items) it.url = URL.createObjectURL(it.file);
      S.pictures = r; S.showAll = false;
      if (r.collection.description && !S.description) { S.description = String(r.collection.description); descIn.value = S.description; }
      if (r.collection.external_url && !S.external) { S.external = String(r.collection.external_url); extIn.value = S.external; }
      // a collection image in the drop is the cover, unless the launcher chose one by hand
      if (!S.cover || S.cover.fromDrop) S.cover = r.cover ? { file: r.cover.file, type: r.cover.type, ext: r.cover.ext, url: URL.createObjectURL(r.cover.file), fromDrop: true } : null;
    } else {
      if (S.layers) for (const l of S.layers.layers) for (const o of l.options) if (o.url) URL.revokeObjectURL(o.url);
      const r = await readLayers(entries);
      for (const l of r.layers) for (const o of l.options) o.url = URL.createObjectURL(o.file);
      S.layers = r;
      bitmaps.clear();
    }
    changed(true);
  }

  // ---- drawing ----
  function setMode(m) {
    S.mode = m;
    for (const r of choices.querySelectorAll("input")) r.checked = r.value === m;
    genBody.hidden = m !== "generated";
    picBody.hidden = m !== "pictures";
    layBody.hidden = m !== "layers";
    renBody.hidden = m !== "renderer";
    if (m === "pictures" || m === "layers") loadStore().then((s) => { S.store = s; S.priceFor = -1; drawStore(); }).catch((e) => { S.priceErr = e.message; drawStore(); });
    changed(true);
  }
  for (const r of choices.querySelectorAll("input")) r.addEventListener("change", () => { if (r.checked) setMode(r.value); });

  function drawNow() {
    if (opts.context !== "edit") { nowLine.hidden = true; return; }
    nowLine.hidden = false;
    nowLine.replaceChildren(current.folder
      ? el("span", null, "The pieces now use the files in folder ", el("span", { class: "mono", text: short(current.folder, 6) }), ". Pick a way below to change the art of later pieces.")
      : current.uriBase.replace(/\/+$/, "") === origin + "/art" ? "The pieces are now generated by this site. Pick a way below to change the art of later pieces." : el("span", null, "The pieces are now served by ", el("span", { class: "mono", text: current.uriBase }), ". Pick a way below to change the art of later pieces."));
  }

  function drawPictures() {
    const P = S.pictures;
    picTable.replaceChildren(); picMore.replaceChildren();
    picHelp.hidden = !P || !P.items.length;
    if (!P) { picSummary.replaceChildren(); return; }
    const total = P.items.reduce((s, x) => s + (Number.isFinite(x.weight) ? x.weight : 0), 0);
    const size = P.items.reduce((s, x) => s + x.size, 0);
    const from = { csv: "Read from the CSV file.", metaplex: "Read in the Metaplex layout.", images: "Read as images alone." }[P.source];
    fill(picSummary,
      P.items.length ? el("p", { class: "art-count" }, el("b", { text: plural(P.items.length, "picture") }), ", " + fmtBytes(size) + ". " + from) : el("p", { class: "art-count", text: "No pictures came in." }),
      ...P.notes.map((t) => el("p", { class: "help", text: t })),
      P.problems.length ? el("div", { class: "note refuse art-problems" }, el("h4", { text: P.problems.length === 1 ? "One file was left out" : plural(P.problems.length, "file") + " were left out" }), el("ul", null, ...P.problems.slice(0, 8).map((t) => el("li", { text: t })), P.problems.length > 8 ? el("li", { text: "And " + (P.problems.length - 8) + " more." }) : null)) : null);
    if (!P.items.length) return;
    picTable.append(el("div", { class: "art-row head", role: "row" }, ...["Picture", "Name", "Traits", "Weight", "Chance"].map((t) => el("span", { role: "columnheader", text: t }))));
    const shown = S.showAll ? P.items : P.items.slice(0, PAGE_ROWS);
    shown.forEach((it, i) => picTable.append(pictureRow(it, i, total)));
    if (P.items.length > PAGE_ROWS) picMore.append(el("button", { class: "btn btn-sm", type: "button", text: S.showAll ? "Show the first " + PAGE_ROWS : "Show all " + fmtInt(P.items.length), onclick: () => { S.showAll = !S.showAll; drawPictures(); } }));
  }
  function pictureRow(it, i, total) {
    const nameIn = el("input", { class: "input", value: it.name, maxlength: 64, autocomplete: "off", "aria-label": "Name of picture " + (i + 1) });
    const traitIn = el("input", { class: "input", value: traitsText(it.attributes), autocomplete: "off", placeholder: "Type: value", "aria-label": "Traits of picture " + (i + 1) });
    const wIn = el("input", { class: "input num", value: Number.isFinite(it.weight) ? String(it.weight) : "", inputmode: "numeric", autocomplete: "off", "aria-label": "Weight of picture " + (i + 1) });
    const chance = el("span", { class: "art-chance", role: "cell", "data-chance": i, text: total > 0 && Number.isFinite(it.weight) ? fmtChance((it.weight * 100) / total) : "" });
    nameIn.addEventListener("input", () => { it.name = nameIn.value; nameIn.toggleAttribute("aria-invalid", !it.name.trim()); changed(); });
    traitIn.addEventListener("input", () => { const r = parseTraits(traitIn.value, it.attributes); traitIn.setAttribute("aria-invalid", r.bad ? "true" : "false"); it.bad = r.bad; if (!r.bad) it.attributes = r.attrs; changed(); });
    wIn.addEventListener("input", () => { it.weight = wholeWeight(wIn.value); wIn.setAttribute("aria-invalid", Number.isFinite(it.weight) ? "false" : "true"); redrawChances(); changed(); });
    return el("div", { class: "art-row", role: "row" },
      el("span", { class: "art-thumb-cell", role: "cell" }, el("img", { class: "art-thumb", src: it.url, alt: "", width: 48, height: 48, loading: "lazy", decoding: "async" })),
      el("span", { role: "cell", class: "c-name" }, nameIn), el("span", { role: "cell", class: "c-traits" }, traitIn), el("span", { role: "cell", class: "c-weight" }, el("span", { class: "ph-label", "aria-hidden": "true", text: "Weight" }), wIn), chance);
  }
  function redrawChances() {
    if (S.mode === "pictures" && S.pictures) {
      const total = S.pictures.items.reduce((s, x) => s + (Number.isFinite(x.weight) ? x.weight : 0), 0);
      for (const c of picTable.querySelectorAll("[data-chance]")) { const it = S.pictures.items[Number(c.dataset.chance)]; c.textContent = total > 0 && Number.isFinite(it.weight) ? fmtChance((it.weight * 100) / total) : ""; }
    }
    if (S.mode === "layers" && S.layers) for (const l of S.layers.layers) {
      const total = l.options.reduce((s, o) => s + (Number.isFinite(o.weight) ? o.weight : 0), 0) + (l.empty && Number.isFinite(l.emptyWeight) ? l.emptyWeight : 0);
      for (const o of l.options) if (o.chanceNode) o.chanceNode.textContent = total > 0 && Number.isFinite(o.weight) ? fmtChance((o.weight * 100) / total) : "";
      if (l.emptyChance) l.emptyChance.textContent = l.empty && total > 0 && Number.isFinite(l.emptyWeight) ? fmtChance((l.emptyWeight * 100) / total) : "";
    }
  }

  // layers: a card per layer, in draw order; drag by the grip or move with the arrows
  let dragFrom = -1;
  function drawLayers() {
    const Ly = S.layers;
    layList.replaceChildren();
    preview.hidden = !Ly || !Ly.layers.length;
    commonBox.hidden = !Ly || !Ly.layers.length;
    if (!Ly) { laySummary.replaceChildren(); return; }
    const files = Ly.layers.reduce((n, l) => n + l.options.length, 0), size = Ly.layers.reduce((s, l) => s + l.options.reduce((t, o) => t + o.size, 0), 0);
    const combos = Ly.layers.reduce((n, l) => n * (l.options.length + (l.empty ? 1 : 0)), 1);
    fill(laySummary,
      Ly.layers.length ? el("p", { class: "art-count" }, el("b", { text: plural(Ly.layers.length, "layer") }), ", " + plural(files, "image") + ", " + fmtBytes(size) + (Ly.width ? ", " + Ly.width + " by " + Ly.height + " pixels" : "") + ". " + (combos > 1e9 ? "More than a billion" : fmtInt(combos)) + " different pieces can be drawn.") : el("p", { class: "art-count", text: "No layers came in." }),
      ...Ly.notes.map((t) => el("p", { class: "help", text: t })),
      Ly.problems.length ? el("div", { class: "note refuse art-problems" }, el("h4", { text: Ly.problems.length === 1 ? "One file was left out" : plural(Ly.problems.length, "file") + " were left out" }), el("ul", null, ...Ly.problems.slice(0, 8).map((t) => el("li", { text: t })), Ly.problems.length > 8 ? el("li", { text: "And " + (Ly.problems.length - 8) + " more." }) : null)) : null,
      Ly.layers.length > 1 ? el("p", { class: "help", text: "The first layer is drawn first, at the back. Drag a layer by its handle or use the arrows to change the order." }) : null);
    Ly.layers.forEach((l, i) => layList.append(layerCard(l, i, Ly.layers.length)));
    redrawChances();
  }
  function layerCard(l, i, n) {
    const nameIn = el("input", { class: "input layer-name", value: l.name, maxlength: 32, autocomplete: "off", "aria-label": "Name of layer " + (i + 1) });
    nameIn.addEventListener("input", () => { l.name = nameIn.value; nameIn.setAttribute("aria-invalid", l.name.trim() ? "false" : "true"); changed(); });
    const up = el("button", { class: "icon-btn", type: "button", title: "Move up", "aria-label": "Move " + l.name + " up", disabled: i === 0, onclick: () => moveLayer(i, i - 1) }, svg(ICON_UP));
    const down = el("button", { class: "icon-btn", type: "button", title: "Move down", "aria-label": "Move " + l.name + " down", disabled: i === n - 1, onclick: () => moveLayer(i, i + 1) }, svg(ICON_DOWN));
    const grip = el("span", { class: "layer-grip", title: "Drag to reorder", "aria-hidden": "true" }, svg(ICON_GRIP));
    const rows = l.options.map((o, k) => {
      const vIn = el("input", { class: "input", value: o.value, maxlength: 64, autocomplete: "off", "aria-label": l.name + " option " + (k + 1) + " name" });
      const wIn = el("input", { class: "input num", value: Number.isFinite(o.weight) ? String(o.weight) : "", inputmode: "numeric", autocomplete: "off", "aria-label": l.name + " option " + (k + 1) + " weight" });
      o.chanceNode = el("span", { class: "art-chance" });
      vIn.addEventListener("input", () => { o.value = vIn.value; vIn.setAttribute("aria-invalid", o.value.trim() ? "false" : "true"); changed(); });
      wIn.addEventListener("input", () => { o.weight = wholeWeight(wIn.value); wIn.setAttribute("aria-invalid", Number.isFinite(o.weight) ? "false" : "true"); redrawChances(); changed(); });
      return el("div", { class: "layer-opt" }, el("img", { class: "art-thumb checker", src: o.url, alt: "", width: 40, height: 40, loading: "lazy", decoding: "async" }), vIn, wIn, o.chanceNode);
    });
    const emptyW = el("input", { class: "input num", value: String(l.emptyWeight), inputmode: "numeric", autocomplete: "off", "aria-label": l.name + " empty weight", hidden: !l.empty });
    l.emptyChance = el("span", { class: "art-chance" });
    emptyW.addEventListener("input", () => { l.emptyWeight = wholeWeight(emptyW.value); emptyW.setAttribute("aria-invalid", Number.isFinite(l.emptyWeight) ? "false" : "true"); redrawChances(); changed(); });
    const sw = el("button", { class: "layer-empty-sw", type: "button", role: "switch", "aria-checked": l.empty ? "true" : "false" }, el("span", { class: "toggle" }), el("span", { text: "Can be empty" }));
    sw.addEventListener("click", () => { l.empty = !l.empty; sw.setAttribute("aria-checked", l.empty ? "true" : "false"); emptyW.hidden = !l.empty; redrawChances(); changed(); });
    const card = el("div", { class: "layer", "data-layer": i },
      el("div", { class: "layer-head" }, grip, el("span", { class: "layer-n mono", text: String(i + 1) }), nameIn, el("span", { class: "layer-arrows" }, up, down)),
      el("div", { class: "layer-opts" }, el("div", { class: "layer-opt head" }, el("span"), el("span", { text: "Option" }), el("span", { text: "Weight" }), el("span", { text: "Chance" })), ...rows),
      el("div", { class: "layer-opt layer-empty" }, sw, emptyW, l.emptyChance));
    // drag and drop between cards, started on the grip only, so the fields stay selectable
    grip.addEventListener("pointerdown", () => { card.draggable = true; });
    card.addEventListener("dragstart", (e) => { dragFrom = i; card.classList.add("dragging"); if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "layer " + i); } });
    card.addEventListener("dragend", () => { card.draggable = false; card.classList.remove("dragging"); for (const c of layList.children) c.classList.remove("drop-before", "drop-after"); dragFrom = -1; });
    card.addEventListener("dragover", (e) => { if (dragFrom < 0) return; e.preventDefault(); const b = card.getBoundingClientRect(); const after = e.clientY > b.top + b.height / 2; card.classList.toggle("drop-after", after); card.classList.toggle("drop-before", !after); });
    card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
    card.addEventListener("drop", (e) => { if (dragFrom < 0) return; e.preventDefault(); e.stopPropagation(); const b = card.getBoundingClientRect(); let to = e.clientY > b.top + b.height / 2 ? i + 1 : i; if (dragFrom < to) to--; moveLayer(dragFrom, to); });
    return card;
  }
  function moveLayer(from, to) {
    const list = S.layers.layers;
    if (to < 0 || to >= list.length || from === to) return;
    const before = new Map([...layList.children].map((c, k) => [list[k], c.getBoundingClientRect()]));
    const [l] = list.splice(from, 1); list.splice(to, 0, l);
    changed(true);
    // the cards glide from where they were to where they are
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) [...layList.children].forEach((c, k) => { const a = before.get(list[k]); if (!a) return; const dy = a.top - c.getBoundingClientRect().top; if (dy) c.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }); });
    const btn = layList.children[to] && layList.children[to].querySelector(from > to ? ".layer-arrows button:first-child" : ".layer-arrows button:last-child");
    if (btn && !btn.disabled) btn.focus();
  }

  // the preview of six pieces, drawn with the SDK's pickPiece on canvases
  const bitmaps = new Map();
  const bitmapOf = (o) => { if (!bitmaps.has(o)) bitmaps.set(o, createImageBitmap(o.file, { resizeWidth: 192, resizeHeight: 192, resizeQuality: "high" }).catch(() => null)); return bitmaps.get(o); };
  let previewSeq = 0;
  async function drawPreview() {
    if (S.mode !== "layers" || !S.layers || !S.layers.layers.length) return;
    const seq = ++previewSeq;
    const built = buildManifest(true);
    const tiles = S.seeds.map(() => el("canvas", { class: "piece-img art-canvas", width: 192, height: 192, role: "img", "aria-label": "sample piece" }));
    strip.replaceChildren(...tiles);
    previewNote.hidden = true;
    if (!built.manifest) return;
    for (let t = 0; t < tiles.length; t++) {
      const d = drawPiece(built.manifest, S.seeds[t]);
      if (!d) { previewNote.hidden = false; previewNote.textContent = built.problems[0] || "The preview could not be drawn. Check the layers above."; return; }
      const g = tiles[t].getContext("2d");
      for (const p of d.images || []) {
        const src = built.optionOf.get(p);
        if (!src) continue;
        const bmp = await bitmapOf(src);
        if (seq !== previewSeq) return;
        if (bmp) g.drawImage(bmp, 0, 0, 192, 192);
      }
      const words = (d.attributes || []).map((a) => a.trait_type + ": " + a.value).join(", ");
      tiles[t].title = words;
      tiles[t].setAttribute("aria-label", words || "a piece");
    }
    // the cover a layered collection gets when the launcher chooses none: one mixed piece
    if (!S.cover) {
      const d = drawPiece(built.manifest, S.coverSeed);
      const c = document.createElement("canvas"); c.width = 112; c.height = 112;
      const g = c.getContext("2d");
      for (const p of (d && d.images) || []) { const src = built.optionOf.get(p); const bmp = src ? await bitmapOf(src) : null; if (seq !== previewSeq) return; if (bmp) g.drawImage(bmp, 0, 0, 112, 112); }
      S.drawnCover = c.toDataURL("image/png");
      drawStore();
    }
  }

  // ---- the manifest and the files of an upload ----
  /// collection.json as the page holds it now, and the files it names. Returns { manifest,
  /// files: [{ path, file, type, size, width?, height? }] (collection.json and a drawn cover left
  /// out), optionOf: path -> layer option, problems: sentences the page finds itself }. The SDK's
  /// checkCollection runs on the whole folder at upload (uploadFiles).
  function buildManifest() {
    const problems = [], files = [], taken = new Set(["collection.json"]), optionOf = new Map();
    const L = limits();
    const collName = String(opts.name ? opts.name() : "").trim(), symbol = String(opts.symbol ? opts.symbol() : "").trim();
    const m = { version: 1, kind: S.mode === "layers" ? "layers" : "pictures", name: collName, symbol, description: S.description.trim() };
    if (S.external) m.external_url = S.external;
    const extra = S.pictures && S.mode === "pictures" ? S.pictures.collection : {};
    if (S.mode === "pictures") {
      const P = S.pictures;
      if (!P || !P.items.length) return { manifest: null, files, optionOf, problems: ["Drop your pictures first."] };
      m.items = P.items.map((it, i) => {
        if (!it.name.trim()) problems.push("Picture " + (i + 1) + " has no name.");
        else if (bytesOf(it.name.trim()) > L.nameBytes) problems.push("The name of picture " + (i + 1) + " is longer than " + L.nameBytes + " bytes.");
        if (!Number.isFinite(it.weight) || it.weight < 1) problems.push("Picture " + (i + 1) + " needs a weight of 1 or more.");
        else if (it.weight > L.weight) problems.push("The weight of picture " + (i + 1) + " is above " + fmtInt(L.weight) + ".");
        if (it.bad) problems.push("The traits of picture " + (i + 1) + " are not written as Type: value.");
        const path = uniquePath("images/" + i + "." + it.ext, taken);
        files.push({ path, file: it.file, type: it.type, size: it.size, width: it.width, height: it.height });
        const o = { image: path, name: it.name.trim(), attributes: it.attributes, weight: Number.isFinite(it.weight) ? it.weight : 0 };
        if (it.description && it.description.trim()) o.description = it.description.trim();
        return o;
      });
    } else {
      const Ly = S.layers;
      if (!Ly || !Ly.layers.length) return { manifest: null, files, optionOf, problems: ["Drop your layers first."] };
      m.width = Ly.width; m.height = Ly.height;
      const names = new Set();
      m.layers = Ly.layers.map((l, li) => {
        const lname = l.name.trim(), label = lname || "layer " + (li + 1);
        if (!lname) problems.push("Layer " + (li + 1) + " has no name.");
        else if (names.has(lname.toLowerCase())) problems.push("Two layers are named " + lname + ". Each layer needs a name of its own.");
        names.add(lname.toLowerCase());
        const dir = "layers/" + safePath(lname || "layer-" + (li + 1)).replace(/\//g, "_") + "/";
        const values = new Set();
        const options = l.options.map((o, k) => {
          const v = o.value.trim();
          if (!v) problems.push("Option " + (k + 1) + " of " + label + " has no name.");
          else if (values.has(v.toLowerCase())) problems.push("Two options of " + label + " are named " + v + ".");
          values.add(v.toLowerCase());
          if (!Number.isFinite(o.weight) || o.weight < 1) problems.push("Option " + (v || k + 1) + " of " + label + " needs a weight of 1 or more.");
          const path = uniquePath(dir + safePath(v || "option-" + (k + 1)).replace(/\//g, "_").replace(/\.png$/i, "") + ".png", taken);
          files.push({ path, file: o.file, type: "image/png", size: o.size, width: Ly.width, height: Ly.height });
          optionOf.set(path, o);
          return { value: v, weight: Number.isFinite(o.weight) ? o.weight : 0, image: path };
        });
        // "can be empty": one more option with no image; its value is what the trait says then
        if (l.empty) {
          if (!Number.isFinite(l.emptyWeight) || l.emptyWeight < 1) problems.push("The layer " + label + " can be empty, and that needs a weight of 1 or more.");
          options.push({ value: values.has("none") ? "Empty" : "None", weight: Number.isFinite(l.emptyWeight) ? l.emptyWeight : 0, none: true });
        }
        return { name: lname, options };
      });
      if (S.common.length) m.attributes = S.common;
    }
    if (!collName) problems.push("Give the collection a name under The collection.");
    if (!symbol) problems.push("Give the coin a ticker under Coin details. The collection carries it.");
    if (bytesOf(m.description) > L.descriptionBytes) problems.push("The description is longer than " + L.descriptionBytes + " bytes.");
    if (S.external && !/^https?:\/\//.test(S.external)) problems.push("The website must start with http.");
    // royalties and creators are kept as information only, and only when they are well formed
    const fee = Number(extra && extra.seller_fee_basis_points);
    if (Number.isInteger(fee) && fee >= 0 && fee <= 10000) m.seller_fee_basis_points = fee;
    const cr = extra && Array.isArray(extra.creators) ? extra.creators.filter((c) => c && typeof c.address === "string" && Number.isFinite(Number(c.share))).map((c) => ({ address: c.address, share: Number(c.share) })) : [];
    if (cr.length && cr.length <= 5 && cr.reduce((s, c) => s + c.share, 0) === 100) m.creators = cr;
    // the cover: the one the launcher chose, the first picture, or a mixed piece drawn at upload
    if (S.cover) { const path = uniquePath("cover." + S.cover.ext, taken); files.push({ path, file: S.cover.file, type: S.cover.type, size: S.cover.file.size }); m.cover = path; }
    else if (m.kind === "pictures") m.cover = m.items[0].image;
    else m.cover = "cover.png";
    return { manifest: m, files, optionOf, problems };
  }
  /// The cover of a layered collection when the launcher chose none: the first preview piece,
  /// drawn at the layers' own size, as a PNG.
  async function drawnCover(built) {
    const Ly = S.layers;
    const w = Ly.width || 1000, h = Ly.height || 1000;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d");
    const d = drawPiece(built.manifest, S.coverSeed);
    for (const p of (d && d.images) || []) {
      const src = built.optionOf.get(p);
      if (!src) continue;
      const bmp = await createImageBitmap(src.file);
      g.drawImage(bmp, 0, 0, w, h); bmp.close();
    }
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ---- the upload ----
  /// The bytes of every file of the upload, collection.json first (the SDK's exact bytes), each
  /// with its hash. The SDK checks the collection against the files before anything is paid.
  async function uploadFiles() {
    const built = buildManifest();
    if (built.problems.length) throw new Error(built.problems[0]);
    // one file in memory at a time: each is read for its hash, then handed to the store as the
    // File it is, and the store reads it again when it sends it
    const out = [];
    for (const f of built.files) out.push({ path: f.path, body: f.file, size: f.size, type: f.type, width: f.width, height: f.height, hash: hex(await sha256(new Uint8Array(await f.file.arrayBuffer()))) });
    if (built.manifest.kind === "layers" && !S.cover) { const b = await drawnCover(built); out.push({ path: "cover.png", body: b, size: b.length, type: "image/png", width: S.layers.width, height: S.layers.height, hash: hex(await sha256(b)) }); }
    const r = checkManifest(built.manifest, out.map((f) => ({ path: f.path, bytes: f.size, type: f.type, width: f.width, height: f.height })));
    if (r.errors.length || !r.collection) throw new Error(r.errors[0] || "The collection could not be checked.");
    const json = H.encodeCollection(r.collection);
    out.unshift({ path: H.ART_FILE || "collection.json", body: json, size: json.length, type: "application/json", hash: hex(await sha256(json)) });
    return { manifest: r.collection, files: out, json, warnings: r.warnings };
  }
  /// The files and bytes the upload would store now.
  function pendingBytes() {
    const built = buildManifest();
    if (!built.manifest) return null;
    const drawn = built.manifest.kind === "layers" && !S.cover;
    const size = built.files.reduce((s, f) => s + f.size, 0) + bytesOf(JSON.stringify(built.manifest)) + 1 + (drawn ? estimateCover() : 0);
    return { size, count: built.files.length + 1 + (drawn ? 1 : 0) };
  }
  const estimateCover = () => { const Ly = S.layers; return Ly && Ly.layers.length ? Math.round(Ly.layers.reduce((s, l) => s + l.options.reduce((t, o) => t + o.size, 0) / Math.max(1, l.options.length), 0)) : 0; };

  let priceTimer = 0;
  function drawStore() {
    const show = (S.mode === "pictures" && S.pictures && S.pictures.items.length) || (S.mode === "layers" && S.layers && S.layers.layers.length);
    storeBox.hidden = !show; details.hidden = !show;
    if (!show) return;
    const p = pendingBytes();
    const rows = [["Files", p ? fmtInt(p.count) : ""], ["Size", p ? fmtBytes(p.size) : ""]];
    if (S.priceErr) rows.push(["Price", "not available"]);
    else if (S.price !== null && S.priceFor === (p ? p.size : -1)) rows.push(["Price", fmtSol(S.price, 6) + " SOL"]);
    else rows.push(["Price", "reading"]);
    storeKv.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
    if (S.priceErr) storeErr.textContent = S.priceErr;
    // the price follows the size, read once the launcher stops typing
    if (p && S.store && S.priceFor !== p.size && !S.priceErr) {
      clearTimeout(priceTimer);
      const size = p.size, count = p.count;
      priceTimer = setTimeout(async () => {
        try { S.price = await quote(S.store, size, count); S.priceFor = size; storeErr.textContent = ""; }
        catch (e) { S.price = null; S.priceFor = -1; storeErr.textContent = "The storage price could not be read. " + plainMsg(e); }
        drawStore(); onChange();
      }, 350);
    }
    // the cover row
    const cov = S.cover ? S.cover.url : S.mode === "pictures" && S.pictures && S.pictures.items[0] ? S.pictures.items[0].url : S.mode === "layers" ? S.drawnCover || "" : "";
    coverImg.hidden = !cov; if (cov) coverImg.src = cov;
    coverLine.textContent = S.cover ? (S.cover.fromDrop ? "Your collection image." : "Your cover.") : S.mode === "pictures" ? "The first picture is the cover until you choose one." : "A mixed piece is the cover until you choose one.";
    const fee = S.pictures && S.mode === "pictures" ? S.pictures.collection.seller_fee_basis_points : undefined;
    const roy = details.querySelector(".art-royalty");
    roy.hidden = !(fee > 0);
    roy.textContent = fee > 0 ? "Your files name a royalty of " + (fee / 100).toLocaleString("en-US") + "%. It is kept in collection.json as information. The program does not enforce royalties." : "";
    // the stored folder, and whether the page still matches it
    const W = Wallet.current();
    if (S.busy) { upBtn.disabled = true; return; }
    upBtn.disabled = false;
    const same = S.upload && S.upload.sig === signature();
    stored.hidden = !S.upload;
    if (S.upload) fill(stored,
      el("p", { class: same ? "ok" : "warn" }, same ? "Stored. " : "You changed the collection after the upload. Upload again to use the change. Files stored before are not paid again. ", same ? el("span", null, "Folder ", el("span", { class: "mono", text: short(S.upload.id, 8) }), copyButton(S.upload.id, "Copy the folder id")) : null),
      same ? el("p", { class: "help", text: "Each piece's address starts with " + uploadBase + S.upload.id + "." }) : null);
    upBtn.hidden = !!same;
    upBtn.textContent = !W.publicKey ? "Connect wallet" : S.failed ? "Upload the rest" : S.upload ? "Upload again" : "Pay and upload";
  }
  /// What the last upload must still match: the manifest as the page would build it now, and
  /// the files it names.
  function signature() {
    const b = buildManifest(true);
    if (!b.manifest) return "";
    return JSON.stringify(b.manifest) + "|" + b.files.map((f) => f.path + ":" + f.size + ":" + (f.file.lastModified || 0)).join(",") + "|" + (S.cover ? "c" : S.coverSeed);
  }

  async function upload() {
    if (S.busy) return;
    storeErr.textContent = "";
    if (!Wallet.current().publicKey) { openWallet(); return; }
    let store;
    try { store = S.store = await loadStore(); } catch (e) { storeErr.textContent = e.message; return; }
    S.busy = true; drawStore();
    const say = (t) => { progress.hidden = false; progress.querySelector("p").textContent = t; };
    const fillBar = (f) => { bar.style.transform = "scaleX(" + Math.max(0, Math.min(1, f)) + ")"; };
    fillBar(0);
    try {
      say("Reading the files.");
      const sig = signature();
      const up = await uploadFiles();
      const known = receipts();
      const kind = store.kind || "store";
      const already = {};
      let fresh = 0;
      for (const f of up.files) { const r = known[kind + ":" + f.hash]; if (r) already[f.path] = r; else fresh += f.size; }
      // pay what the files that are not stored yet cost, less what the wallet has there already
      say("Reading the price.");
      const freshCount = up.files.filter((f) => !already[f.path]).length;
      const price = await quote(store, fresh, freshCount, up.files.length);
      const have = price > 0n && store.balance ? BigInt(await store.balance()) : 0n;
      if (price > have) {
        const need = price - have;
        const lamports = BigInt(await ctx.connection.getBalance(requireWallet(), "confirmed"));
        if (lamports < need + 10_000n) throw new Error("This wallet holds " + fmtSol(lamports, 6) + " SOL. Storing the art needs " + fmtSol(need, 6) + " SOL and a network fee.");
        say("Confirm the payment of " + fmtSol(need, 6) + " SOL in your wallet.");
        upBtn.textContent = "Confirm in your wallet";
        await store.fund(need, payTo);
      }
      upBtn.textContent = "Uploading";
      say("Uploading 0 of " + up.files.length + ".");
      let res;
      try {
        res = await store.uploadFolder(up.files.map((f) => ({ path: f.path, bytes: f.body, type: f.type })), {
          already,
          onProgress: (done, total, path) => { fillBar(total ? done / total : 0); say("Uploading " + done + " of " + total + (path ? ": " + path : "") + "."); },
        });
      } catch (e) {
        if (e && e.receipts) keepReceipts(kind, up.files.filter((f) => e.receipts[f.path]).map((f) => [f.hash, e.receipts[f.path]]));
        const landed = e && e.receipts ? Object.keys(e.receipts).length : 0;
        S.failed = { landed };
        throw new Error((landed ? plural(landed, "file") + " of " + up.files.length + " stored. " : "") + "The upload stopped. " + plainMsg(e) + " Press Upload the rest to go on. What was stored is not paid again.");
      }
      if (res.receipts) keepReceipts(kind, up.files.filter((f) => res.receipts[f.path]).map((f) => [f.hash, res.receipts[f.path]]));
      if (!isFolderId(res.id)) throw new Error("The storage service returned no folder id.");
      if (bytesOf(uploadBase + res.id) > 80) throw new Error("The address of this folder is " + bytesOf(uploadBase + res.id) + " bytes. A piece's address may hold 80.");
      const art = H.collectionArt(up.json);
      S.upload = { id: res.id, art, artHex: hex(art), json: up.json, manifest: up.manifest, sig };
      S.failed = null;
      fillBar(1); say("All " + up.files.length + " files are stored.");
      toast("The art is stored.", "ok");
    } catch (e) {
      storeErr.textContent = plainMsg(e);
    }
    S.busy = false;
    drawStore(); onChange();
  }

  function drawRendererErrors() {
    const errs = rendererProblems();
    baseErr.replaceChildren(...errs.map((t) => el("span", { text: t })));
  }
  function rendererProblems() {
    if (S.mode !== "renderer") return [];
    const errs = [];
    const base = baseIn.value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(base)) errs.push("The renderer base must start with http.");
    else if (bytesOf(base) > 80) errs.push("The renderer base is " + bytesOf(base) + " bytes. The most is 80.");
    const a = artIn.value.trim();
    if (a && !/^[0-9a-fA-F]{32}$/.test(a)) errs.push("The art bytes are 32 hex characters.");
    return errs;
  }

  function changed(redraw = false) {
    if (redraw) { drawPictures(); drawLayers(); drawPreview(); }
    else if (S.mode === "layers") { clearTimeout(changed.t); changed.t = setTimeout(drawPreview, 200); }
    drawStore(); drawRendererErrors();
    onChange();
  }

  Wallet.onChange(() => drawStore());
  drawNow();
  setMode(S.mode);
  if (tooLong) uploadsOff(longWhy());
  // the site's own word on uploads: where a collection's address starts, or that it offers none
  artSettings().then((st) => {
    uploadBase = String(st.uriBase);
    if (typeof st.network === "string" && /^[A-Za-z0-9 ]{2,24}$/.test(st.network)) network(st.network);
    tooLong = bytesOf(uploadBase) + 43 > Number(st.maxUriBase || 80);
    uploadsOff(tooLong ? longWhy() : "");
    drawStore();
  }).catch(() => uploadsOff("Your pictures and Your layers are off on this site. It does not offer uploads."));

  /// One sentence the review shows while the art is not ready to launch with, or "".
  function problem() {
    const when = opts.context === "edit" ? "before you save" : "before you launch";
    if (S.mode === "renderer") { const e = rendererProblems(); return e.length ? "Check the renderer base. " + e[0] : ""; }
    if (S.mode === "pictures" || S.mode === "layers") {
      if (S.busy) return "The art is uploading.";
      if (!S.upload) return S.mode === "pictures" ? (S.pictures && S.pictures.items.length ? "Upload your pictures " + when + "." : "Drop your pictures, then upload them.") : (S.layers && S.layers.layers.length ? "Upload your layers " + when + "." : "Drop your layers, then upload them.");
      if (S.upload.sig !== signature()) return "You changed the collection after the upload. Upload again " + when + ".";
    }
    return "";
  }
  return {
    node,
    mode: () => S.mode,
    problem,
    fieldProblems: () => rendererProblems(),
    /// What the program gets: { uriBase, art }, or null while the coin page keeps the art as it
    /// is. Throws a sentence when the art is not ready.
    target() {
      if (S.mode === "keep") return null;
      const p = problem();
      if (p) throw new Error(p);
      if (S.mode === "pictures" || S.mode === "layers") return { uriBase: uploadBase + S.upload.id, art: S.upload.art, folder: S.upload.id };
      if (S.mode === "renderer") {
        const a = artIn.value.trim();
        return { uriBase: baseIn.value.trim().replace(/\/+$/, ""), art: a ? H.collectible.bytesOfHex(a.toLowerCase()) : editor.art() };
      }
      return { uriBase: origin + "/art", art: editor.art() };
    },
    /// A sentence for the review about the art and its storage.
    note() {
      if (S.mode === "pictures" && S.pictures && S.pictures.items.length) return "The art is " + plural(S.pictures.items.length, "picture") + " of your own" + (S.upload ? ", stored on Arweave." : ". Storing them is paid when you upload, before the launch" + (S.price !== null ? ": about " + fmtSol(S.price, 6) + " SOL." : "."));
      if (S.mode === "layers" && S.layers && S.layers.layers.length) return "The art is " + plural(S.layers.layers.length, "layer") + " of your own" + (S.upload ? ", stored on Arweave." : ". Storing them is paid when you upload, before the launch" + (S.price !== null ? ": about " + fmtSol(S.price, 6) + " SOL." : "."));
      if (S.mode === "renderer") return "Your renderer serves every piece. Its address goes on chain as the renderer base.";
      return "";
    },
    storeCost: () => (S.mode === "pictures" || S.mode === "layers") && !S.upload ? S.price : null,
    /// Draw the store box again: the page calls it when a field outside the section changes
    /// what collection.json would hold (the collection name, the ticker).
    refresh: () => drawStore(),
    /// Forget the storage session of the connected wallet: the page calls it once the coin is
    /// launched or the collection saved with the upload.
    forgetSession: () => { const W = Wallet.current(); if (W.publicKey) dropSession(W.publicKey.toBase58()); storeOpen = null; S.store = null; },
    /// For the review tools: the folder of the last upload, or "".
    folder: () => (S.upload ? S.upload.id : ""),
  };
}

function plainMsg(e) {
  let s = String((e && e.message) || e || "").replace(/\s+/g, " ").trim();
  if (s.length > 180) s = s.slice(0, 177).replace(/\s+\S*$/, "") + "...";
  if (s && !/[.!?]$/.test(s)) s += ".";
  return s;
}
function randomSeed() { const b = new Uint8Array(16); crypto.getRandomValues(b); return hex(b); }

// ---- the coin page: what a piece shows ---------------------------------------------------------------

/// The folder id in a uri_base or a piece's address of this site's uploaded art, or "".
export function folderOf(uri) {
  const m = /\/art\/u\/([A-Za-z0-9_-]{32,44})(?:\/|$)/.exec(String(uri || ""));
  return m ? m[1] : "";
}
const pieceCache = new Map(), manifestCache = new Map();
/// What a piece of uploaded art shows, from the resolver: { image, name, attributes, hidden,
/// error }. The answer is cached per address. null for a piece of generated art.
export function pieceArt(piece) {
  const uri = piece && piece.uri;
  if (!folderOf(uri)) return null;
  if (!pieceCache.has(uri)) pieceCache.set(uri, (async () => {
    try {
      const r = await fetch(uri, { headers: { accept: "application/json" } });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) return { error: (j && j.error) || "The art of this piece could not be read.", attributes: [] };
      const hidden = /hidden by the site operator/i.test(String(j.description || "")) || j.hidden === true;
      return { image: String(j.image || ""), name: String(j.name || ""), attributes: Array.isArray(j.attributes) ? j.attributes : [], description: String(j.description || ""), hidden };
    } catch (_) { return { error: "The art of this piece could not be read.", attributes: [] }; }
  })());
  return pieceCache.get(uri);
}
/// A folder's collection.json through the resolver, for the chance of each trait. null when the
/// site does not serve it.
export function folderManifest(uri) {
  const id = folderOf(uri);
  if (!id) return Promise.resolve(null);
  const base = String(uri).slice(0, String(uri).indexOf("/art/u/") + 7) + id;
  if (!manifestCache.has(base)) manifestCache.set(base, (async () => {
    try { const r = await fetch(base + "/collection.json"); if (!r.ok) return null; const j = await r.json(); return j && j.version === 1 ? j : null; } catch (_) { return null; }
  })());
  return manifestCache.get(base);
}
