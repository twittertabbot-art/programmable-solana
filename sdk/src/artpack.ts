// A launcher's own art for a collectible coin: the collection.json schema (v1), its checks and
// limits, the draw that picks what a piece shows, the chances, and the addresses.
//
// A coin's pieces have the metadata address <uri_base>/p/<art 32 hex>/<seed 32 hex>. With
// uploaded art, uri_base is <site>/art/u/<folder id>: a folder stored on permanent storage that
// holds collection.json and the image files. The coin's 16 art bytes are the first 16 bytes of
// the SHA-256 of collection.json as uploaded, so a piece names the exact collection it was
// minted under. The seed is random per piece (a later block decides it), so a picture is never
// given to an exact number of pieces: a weight is a CHANCE, and two pieces can show the same
// picture.
//
// Pure code with no dependency and no await: the same functions run in the launch page's
// preview, in the site's resolver (web/api/_art.js) and in anyone else's tools.
import { sha256 } from "./hash.js";

/// The manifest's path in the folder.
export const ART_FILE = "collection.json";
/// The most bytes a coin's uri_base may have (hook_collectible MAX_URI_BASE).
export const ART_URI_BASE_MAX = 80;
/// The image types a folder may hold, by extension. Layers are PNG only.
export const ART_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/// The limits a collection must keep. Lengths are UTF-8 bytes.
export const ART_LIMITS = {
  /// pictures in one collection
  items: 10000,
  /// layers in one collection
  layers: 16,
  optionsPerLayer: 100,
  /// options of all layers together
  options: 600,
  /// attributes of one piece, the common ones included
  attributes: 32,
  /// the collection's name and an item's name
  nameBytes: 64,
  symbolBytes: 10,
  /// the collection's or an item's description
  descriptionBytes: 2000,
  /// a trait_type, and a value written as text
  traitBytes: 64,
  /// one file path in the folder
  pathBytes: 120,
  /// external_url
  urlBytes: 200,
  /// one weight: a whole number from 0 to this
  weight: 1000000,
  /// the sum of the weights of one list (the items, or the options of one layer)
  totalWeight: 4294967295,
  /// one picture, or the cover
  fileBytes: 20000000,
  /// one layer PNG
  layerFileBytes: 4000000,
  /// layers: width and height at most this many pixels
  layerSide: 2048,
  /// layers: width times height at most this
  layerPixels: 4194304,
  /// collection.json itself
  manifestBytes: 4000000,
  /// files in the folder besides collection.json
  files: 10001,
  /// the whole folder, collection.json included
  totalBytes: 1000000000,
};
const L = ART_LIMITS;
const DISPLAY_TYPES = ["number", "boost_number", "boost_percentage", "date"];

export type ArtAttribute = { trait_type: string; value: string | number; display_type?: "number" | "boost_number" | "boost_percentage" | "date" };
/// One finished picture. `weight` is its relative chance.
export interface ArtItem { image: string; name: string; description?: string; attributes: ArtAttribute[]; weight: number }
/// One option of a layer. `none`: the layer is left out of the piece (no image).
export interface ArtOption { value: string; weight: number; image?: string; none?: boolean }
/// One layer; its name is the trait_type of the pieces.
export interface ArtLayer { name: string; options: ArtOption[] }
/// collection.json, version 1.
export interface ArtCollection {
  version: 1;
  kind: "pictures" | "layers";
  name: string;
  symbol: string;
  description: string;
  external_url?: string;
  /// the path of the collection's image
  cover: string;
  /// Information only: nothing on chain enforces a royalty (the pieces cannot be sold apart from their coins anyway).
  seller_fee_basis_points?: number;
  /// Information only.
  creators?: { address: string; share: number }[];
  /// Attributes every piece carries, whatever it draws (stats, skills).
  attributes?: ArtAttribute[];
  /// kind "pictures"
  items?: ArtItem[];
  /// kind "layers", in draw order: layers[0] is drawn first, at the bottom
  layers?: ArtLayer[];
  /// kind "layers": the size of every layer PNG, in pixels
  width?: number;
  height?: number;
}
/// What the launcher's files are, for checkCollection: size, and type and pixel size when known.
export interface ArtFileInfo { path: string; bytes: number; type?: string; width?: number; height?: number }
export interface ArtCheck {
  ok: boolean;
  /// Plain sentences, each says where.
  errors: string[];
  /// Plain sentences about things that do not block.
  warnings: string[];
  /// The collection, normalised: trimmed text, known fields only, fixed key order. Null when not ok.
  collection: ArtCollection | null;
  /// Every file the collection uses, the cover first, no duplicates.
  paths: string[];
  /// With `files`: the bytes of the whole folder (the used files and collection.json). Else 0.
  bytes: number;
}

const enc = new TextEncoder();
const utf8Len = (s: string) => enc.encode(s).length;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_KEEP_LINES = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/// The extension of a path, lowercase, "" when none.
export function artExtension(path: string): string { const m = /\.([A-Za-z0-9]+)$/.exec(path); return m ? m[1].toLowerCase() : ""; }
/// The image type of a path from its extension, "" when it is not one of ART_TYPES.
export function artTypeOf(path: string): string { return ART_TYPES[artExtension(path)] || ""; }

/// Is `p` a path a folder may hold? See checkCollection for the rules.
export function isArtPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || utf8Len(p) > L.pathBytes) return false;
  if (p.toLowerCase() === ART_FILE) return false;
  return p.split("/").every((s) => SEGMENT.test(s)) && !!artTypeOf(p);
}

/// Checks a collection.json (parsed) and, with `files`, the files it uses. Never throws.
export function checkCollection(json: unknown, files?: ArtFileInfo[]): ArtCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (s: string) => { if (errors.length < 50) errors.push(s); else if (errors.length === 50) errors.push("There are more problems; fix these first."); };
  const fail = (): ArtCheck => ({ ok: false, errors, warnings, collection: null, paths: [], bytes: 0 });
  if (!isObj(json)) { err("collection.json must be a JSON object."); return fail(); }
  const j = json;
  if (j.version !== 1) err("version must be 1.");
  const kind = j.kind;
  if (kind !== "pictures" && kind !== "layers") { err('kind must be "pictures" or "layers".'); return fail(); }

  /// Text: a string, trimmed, `min` to `max` bytes, no control characters (descriptions keep new lines).
  const text = (v: unknown, label: string, min: number, max: number, lines = false): string | null => {
    if (v === undefined || v === null) { if (min > 0) { err(label + " is missing."); return null; } return ""; }
    if (typeof v !== "string") { err(label + " must be text."); return null; }
    const s = v.trim();
    const n = utf8Len(s);
    if (n < min) { err(label + " is empty."); return null; }
    if (n > max) { err(label + " is " + n + " bytes long; the most is " + max + "."); return null; }
    if ((lines ? CONTROL_KEEP_LINES : CONTROL).test(s)) { err(label + " has a control character in it."); return null; }
    return s;
  };
  const path = (v: unknown, label: string, pngOnly: boolean): string | null => {
    if (typeof v !== "string" || !v) { err(label + ": the image path is missing."); return null; }
    if (utf8Len(v) > L.pathBytes) { err(label + ": the path " + v.slice(0, 40) + " is longer than " + L.pathBytes + " bytes."); return null; }
    if (v.toLowerCase() === ART_FILE) { err(label + ": " + ART_FILE + " cannot be an image."); return null; }
    if (!v.split("/").every((s) => SEGMENT.test(s))) { err(label + ": the path " + v + " may only use letters, digits, dot, dash and underscore, with / between folders, and no part may start with a dot."); return null; }
    const ext = artExtension(v);
    if (pngOnly ? ext !== "png" : !ART_TYPES[ext]) { err(label + ": " + v + (pngOnly ? " must be a PNG file (a layer needs transparency)." : " must be a png, jpg, gif or webp file.")); return null; }
    return v;
  };
  const weight = (v: unknown, label: string): number | null => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > L.weight) { err(label + ": the weight must be a whole number from 0 to " + L.weight + "."); return null; }
    return v;
  };
  const attrs = (v: unknown, label: string): ArtAttribute[] | null => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { err(label + ": attributes must be a list."); return null; }
    if (v.length > L.attributes) { err(label + ": at most " + L.attributes + " attributes."); return null; }
    const out: ArtAttribute[] = [];
    for (let i = 0; i < v.length; i++) {
      const a = v[i];
      const where = label + ", attribute " + (i + 1);
      if (!isObj(a)) { err(where + " must be an object with trait_type and value."); continue; }
      const t = text(a.trait_type, where + ": trait_type", 1, L.traitBytes);
      let value: string | number | null = null;
      if (typeof a.value === "number") { if (Number.isFinite(a.value)) value = a.value; else err(where + ": the value is not a finite number."); }
      else value = text(a.value, where + " (" + (t || "?") + "): the value", 1, L.traitBytes);
      let display: ArtAttribute["display_type"] | undefined;
      if (a.display_type !== undefined && a.display_type !== null) {
        if (!DISPLAY_TYPES.includes(a.display_type)) err(where + ": display_type must be one of " + DISPLAY_TYPES.join(", ") + ".");
        else if (typeof value !== "number") err(where + ": a display_type needs a number value.");
        else display = a.display_type;
      }
      if (t === null || value === null) continue;
      out.push(display ? { trait_type: t, value, display_type: display } : { trait_type: t, value });
    }
    return out;
  };
  const noRepeat = (list: ArtAttribute[], label: string) => {
    const seen = new Set<string>();
    for (const a of list) { const k = a.trait_type.toLowerCase(); if (seen.has(k)) err(label + ": the trait " + a.trait_type + " is listed twice."); seen.add(k); }
  };

  const name = text(j.name, "The collection name", 1, L.nameBytes);
  const symbol = text(j.symbol, "The symbol", 0, L.symbolBytes);
  const description = text(j.description, "The description", 0, L.descriptionBytes, true);
  let external: string | undefined;
  if (j.external_url !== undefined && j.external_url !== null && j.external_url !== "") {
    const u = text(j.external_url, "external_url", 1, L.urlBytes);
    if (u !== null) { if (/^https?:\/\/[^\s]+$/i.test(u)) external = u; else err("external_url must be an http or https address."); }
  }
  const cover = path(j.cover, "The cover", false);
  let fee: number | undefined;
  if (j.seller_fee_basis_points !== undefined && j.seller_fee_basis_points !== null) {
    const f = j.seller_fee_basis_points;
    if (typeof f !== "number" || !Number.isInteger(f) || f < 0 || f > 10000) err("seller_fee_basis_points must be a whole number from 0 to 10000.");
    else fee = f;
  }
  let creators: { address: string; share: number }[] | undefined;
  if (j.creators !== undefined && j.creators !== null) {
    if (!Array.isArray(j.creators) || j.creators.length < 1 || j.creators.length > 5) err("creators must be a list of 1 to 5 entries.");
    else {
      const list: { address: string; share: number }[] = [];
      let sum = 0;
      j.creators.forEach((c: any, i: number) => {
        if (!isObj(c) || typeof c.address !== "string" || !B58.test(c.address)) { err("Creator " + (i + 1) + ": the address must be a Solana address."); return; }
        if (typeof c.share !== "number" || !Number.isInteger(c.share) || c.share < 0 || c.share > 100) { err("Creator " + (i + 1) + ": the share must be a whole number from 0 to 100."); return; }
        sum += c.share; list.push({ address: c.address, share: c.share });
      });
      if (list.length === j.creators.length) { if (sum !== 100) err("The creators' shares must add up to 100."); else creators = list; }
    }
  }
  const common = attrs(j.attributes, "The common attributes");
  if (common) noRepeat(common, "The common attributes");

  const out: ArtCollection = { version: 1, kind, name: name || "", symbol: symbol || "", description: description || "", cover: cover || "" };
  if (external) out.external_url = external;
  out.cover = cover || "";
  if (fee !== undefined) out.seller_fee_basis_points = fee;
  if (creators) out.creators = creators;
  if (common && common.length) out.attributes = common;
  const commonCount = common ? common.length : 0;
  const commonKeys = new Set((common || []).map((a) => a.trait_type.toLowerCase()));
  const layerPaths = new Set<string>();

  if (kind === "pictures") {
    if (j.layers !== undefined) err("A pictures collection has no layers.");
    if (!Array.isArray(j.items) || j.items.length < 1) err("items must be a list of at least one picture.");
    else if (j.items.length > L.items) err("At most " + L.items + " pictures; this one has " + j.items.length + ".");
    else {
      const items: ArtItem[] = [];
      let total = 0;
      j.items.forEach((it: any, i: number) => {
        const nm = isObj(it) && typeof it.name === "string" ? it.name.trim().slice(0, 30) : "";
        const where = "Item " + (i + 1) + (nm ? " (" + nm + ")" : "");
        if (!isObj(it)) { err(where + " must be an object."); return; }
        const image = path(it.image, where, false);
        const iname = text(it.name, where + ": the name", 1, L.nameBytes);
        const idesc = text(it.description, where + ": the description", 0, L.descriptionBytes, true);
        const a = attrs(it.attributes, where);
        const w = weight(it.weight, where);
        if (a) {
          noRepeat(a, where);
          if (a.length + commonCount > L.attributes) err(where + ": with the common attributes it has more than " + L.attributes + " attributes.");
          for (const x of a) if (commonKeys.has(x.trait_type.toLowerCase())) err(where + ": the trait " + x.trait_type + " is also a common attribute.");
        }
        if (image === null || iname === null || idesc === null || a === null || w === null) return;
        total += w;
        const item: ArtItem = { image, name: iname, attributes: a, weight: w };
        if (idesc) item.description = idesc;
        items.push({ image: item.image, name: item.name, ...(item.description ? { description: item.description } : {}), attributes: item.attributes, weight: item.weight });
      });
      if (items.length === j.items.length) {
        if (total <= 0) err("At least one picture needs a weight above 0.");
        else if (total > L.totalWeight) err("The weights add up to more than " + L.totalWeight + ".");
      }
      out.items = items;
    }
  } else {
    if (j.items !== undefined) err("A layers collection has no items.");
    const side = (v: unknown, label: string) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= L.layerSide ? v : (err(label + " must be a whole number of pixels from 1 to " + L.layerSide + "."), null));
    const width = side(j.width, "width"), height = side(j.height, "height");
    if (width && height && width * height > L.layerPixels) err("The layers are " + width + " by " + height + " pixels; at most " + L.layerPixels + " pixels in all.");
    if (width && height) { out.width = width; out.height = height; }
    if (!Array.isArray(j.layers) || j.layers.length < 1) err("layers must be a list of at least one layer.");
    else if (j.layers.length > L.layers) err("At most " + L.layers + " layers; this one has " + j.layers.length + ".");
    else {
      if (j.layers.length + commonCount > L.attributes) err("With the common attributes a piece would have more than " + L.attributes + " attributes.");
      const layers: ArtLayer[] = [];
      const names = new Set<string>();
      let optionCount = 0;
      j.layers.forEach((ly: any, li: number) => {
        const nm = isObj(ly) && typeof ly.name === "string" ? ly.name.trim().slice(0, 30) : "";
        const where = "Layer " + (li + 1) + (nm ? " (" + nm + ")" : "");
        if (!isObj(ly)) { err(where + " must be an object."); return; }
        const lname = text(ly.name, where + ": the name", 1, L.traitBytes);
        if (lname !== null) {
          const k = lname.toLowerCase();
          if (names.has(k)) err(where + ": two layers are called " + lname + ".");
          if (commonKeys.has(k)) err(where + ": " + lname + " is also a common attribute.");
          names.add(k);
        }
        if (!Array.isArray(ly.options) || ly.options.length < 1) { err(where + ": options must be a list of at least one option."); return; }
        if (ly.options.length > L.optionsPerLayer) { err(where + ": at most " + L.optionsPerLayer + " options."); return; }
        optionCount += ly.options.length;
        const options: ArtOption[] = [];
        let total = 0;
        ly.options.forEach((o: any, oi: number) => {
          const on = isObj(o) && typeof o.value === "string" ? o.value.trim().slice(0, 30) : "";
          const w2 = where + ", option " + (oi + 1) + (on ? " (" + on + ")" : "");
          if (!isObj(o)) { err(w2 + " must be an object."); return; }
          const value = text(o.value, w2 + ": the value", 1, L.traitBytes);
          const w = weight(o.weight, w2);
          if (o.none !== undefined && typeof o.none !== "boolean") { err(w2 + ": none must be true or false."); return; }
          let image: string | null | undefined;
          if (o.none === true) { if (o.image !== undefined && o.image !== null && o.image !== "") { err(w2 + ": an empty option has no image."); return; } }
          else image = path(o.image, w2, true);
          if (value === null || w === null || image === null) return;
          total += w;
          const opt: ArtOption = { value, weight: w };
          if (image) { opt.image = image; layerPaths.add(image); }
          if (o.none === true) opt.none = true;
          options.push(opt);
        });
        if (options.length === ly.options.length) {
          if (total <= 0) err(where + ": at least one option needs a weight above 0.");
          else if (total > L.totalWeight) err(where + ": the weights add up to more than " + L.totalWeight + ".");
        }
        if (lname !== null) layers.push({ name: lname, options });
      });
      if (optionCount > L.options) err("At most " + L.options + " options in all layers together; this one has " + optionCount + ".");
      out.layers = layers;
    }
  }
  if (errors.length) return fail();

  // fixed key order, so the same collection always encodes to the same bytes
  const c = { version: 1, kind: out.kind, name: out.name, symbol: out.symbol, description: out.description } as ArtCollection;
  if (out.external_url) c.external_url = out.external_url;
  c.cover = out.cover;
  if (out.seller_fee_basis_points !== undefined) c.seller_fee_basis_points = out.seller_fee_basis_points;
  if (out.creators) c.creators = out.creators;
  if (out.attributes) c.attributes = out.attributes;
  if (kind === "layers") { c.width = out.width; c.height = out.height; c.layers = out.layers; } else c.items = out.items;

  const paths: string[] = [];
  const seen = new Set<string>();
  const use = (p: string) => { if (!seen.has(p)) { seen.add(p); paths.push(p); } };
  use(c.cover);
  for (const it of c.items || []) use(it.image);
  for (const ly of c.layers || []) for (const o of ly.options) if (o.image) use(o.image);
  if (paths.length > L.files) err("The folder would hold " + paths.length + " files; the most is " + L.files + ".");
  const manifestBytes = encodeCollection(c).length;
  if (manifestBytes > L.manifestBytes) err("collection.json would be " + manifestBytes + " bytes; the most is " + L.manifestBytes + ".");

  let bytes = 0;
  if (files) {
    const byPath = new Map<string, ArtFileInfo>();
    for (const f of files) if (f && typeof f.path === "string" && f.path !== ART_FILE) byPath.set(f.path, f);
    bytes = manifestBytes;
    for (const p of paths) {
      const f = byPath.get(p);
      if (!f) { err("The file " + p + " is missing."); continue; }
      const isLayer = layerPaths.has(p);
      const cap = isLayer ? L.layerFileBytes : L.fileBytes;
      if (!(f.bytes > 0)) err("The file " + p + " is empty.");
      else if (f.bytes > cap) err("The file " + p + " is " + f.bytes + " bytes; the most is " + cap + (isLayer ? " for a layer." : "."));
      bytes += f.bytes > 0 ? f.bytes : 0;
      const want = artTypeOf(p);
      if (f.type && f.type !== want) err("The file " + p + " is a " + f.type + " file, but its name says " + want + ".");
      if (isLayer && c.width && c.height && f.width !== undefined && f.height !== undefined && (f.width !== c.width || f.height !== c.height)) {
        err("The layer image " + p + " is " + f.width + " by " + f.height + " pixels; every layer must be " + c.width + " by " + c.height + ".");
      }
    }
    const unused = files.filter((f) => f && f.path !== ART_FILE && !seen.has(f.path)).length;
    if (unused) warnings.push(unused === 1 ? "One file is not used by the collection. It is left out of the upload." : unused + " files are not used by the collection. They are left out of the upload.");
    if (bytes > L.totalBytes) err("The folder would be " + bytes + " bytes; the most is " + L.totalBytes + ".");
  }
  if (c.kind === "pictures" && c.items) {
    const zero = c.items.filter((i) => i.weight === 0).length;
    if (zero) warnings.push(zero === 1 ? "One picture has a weight of 0. No piece will ever show it." : zero + " pictures have a weight of 0. No piece will ever show them.");
  }
  if (errors.length) return fail();
  return { ok: true, errors, warnings, collection: c, paths, bytes };
}

/// The exact bytes to upload as collection.json: compact JSON in UTF-8 and a new line. The coin's
/// art bytes are the hash of these bytes.
export function encodeCollection(c: ArtCollection): Uint8Array { return enc.encode(JSON.stringify(c) + "\n"); }

/// Reads collection.json as stored and checks it. Throws an Error with a plain sentence.
export function parseCollection(input: Uint8Array | string): ArtCollection {
  let s: string;
  if (typeof input === "string") s = input;
  else {
    if (input.length > L.manifestBytes) throw new Error("collection.json is larger than " + L.manifestBytes + " bytes.");
    try { s = new TextDecoder("utf-8", { fatal: true }).decode(input); } catch (_) { throw new Error("collection.json is not UTF-8 text."); }
  }
  let j: unknown;
  try { j = JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s); } catch (_) { throw new Error("collection.json is not valid JSON."); }
  const r = checkCollection(j);
  if (!r.ok || !r.collection) throw new Error("collection.json is not valid: " + r.errors[0]);
  return r.collection;
}

/// The coin's 16 art bytes for collection.json bytes: the first 16 bytes of their SHA-256.
export function collectionArt(bytes: Uint8Array): Uint8Array { return sha256(bytes).subarray(0, 16); }
/// The same, as the 32 hex characters a piece's address carries.
export function collectionArtHex(bytes: Uint8Array): string { return hex(collectionArt(bytes)); }
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ---- the draw ------------------------------------------------------------------------------------------

const ROLL_TAG = enc.encode("programmable-art-v1:");
function seedBytes(seedHex: string): Uint8Array {
  if (typeof seedHex !== "string" || !/^[0-9a-fA-F]{32}$/.test(seedHex)) throw new Error("A seed is 32 hex characters.");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
/// The roll of draw number `index` for a piece's seed: the first 6 bytes, big-endian, of
/// sha256("programmable-art-v1:" || seed (16 bytes) || index (1 byte)). A number below 2^48.
export function artRoll(seedHex: string, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error("A draw index is 0 to 255.");
  const msg = new Uint8Array(ROLL_TAG.length + 17);
  msg.set(ROLL_TAG, 0); msg.set(seedBytes(seedHex), ROLL_TAG.length); msg[ROLL_TAG.length + 16] = index;
  const h = sha256(msg);
  return ((((h[0] * 256 + h[1]) * 256 + h[2]) * 256 + h[3]) * 256 + h[4]) * 256 + h[5];
}
/// The entry a roll picks from weights: roll mod the sum, then the first entry whose running sum exceeds it.
function pickIndex(weights: number[], roll: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("Nothing to draw: every weight is 0.");
  const r = roll % total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (r < acc) return i; }
  return weights.length - 1;
}
export interface ArtPick {
  kind: "pictures" | "layers";
  /// pictures: the index of the drawn item; layers: -1
  item: number;
  /// layers: the option drawn in each layer, in layer order; pictures: []
  options: number[];
  /// the image paths to draw, bottom first (pictures: one; layers: the drawn options that have an image)
  images: string[];
  /// pictures: the item's name; layers: the collection's name
  name: string;
  /// the item's description, else the collection's
  description: string;
  /// pictures: the item's; layers: one per layer (its name, the option's value); then the common ones
  attributes: ArtAttribute[];
  /// the chance that a piece is exactly this, 0 to 1
  chance: number;
}
/// What a piece with this seed shows. Deterministic: the same in every page, server and tool.
export function pickPiece(c: ArtCollection, seedHex: string): ArtPick {
  const common = c.attributes || [];
  if (c.kind === "pictures") {
    const items = c.items || [];
    const w = items.map((i) => i.weight);
    const total = w.reduce((a, b) => a + b, 0);
    const i = pickIndex(w, artRoll(seedHex, 0));
    const it = items[i];
    return {
      kind: "pictures", item: i, options: [], images: [it.image], name: it.name, description: it.description || c.description,
      attributes: [...it.attributes, ...common].map((a) => ({ ...a })), chance: it.weight / total,
    };
  }
  const layers = c.layers || [];
  const options: number[] = [];
  const images: string[] = [];
  const attributes: ArtAttribute[] = [];
  let chance = 1;
  layers.forEach((ly, li) => {
    const w = ly.options.map((o) => o.weight);
    const total = w.reduce((a, b) => a + b, 0);
    const oi = pickIndex(w, artRoll(seedHex, li));
    const o = ly.options[oi];
    options.push(oi);
    if (o.image && !o.none) images.push(o.image);
    attributes.push({ trait_type: ly.name, value: o.value });
    chance *= o.weight / total;
  });
  for (const a of common) attributes.push({ ...a });
  return { kind: "layers", item: -1, options, images, name: c.name, description: c.description, attributes, chance };
}

export interface TraitOdds { trait_type: string; values: { value: string | number; weight: number; chance: number }[] }
/// The chance of every value of every trait, in the order they first appear. Common attributes
/// have a chance of 1. For pictures, a trait an item does not carry is simply absent from it.
export function traitOdds(c: ArtCollection): TraitOdds[] {
  const out: TraitOdds[] = [];
  if (c.kind === "pictures") {
    const items = c.items || [];
    const total = items.reduce((a, i) => a + i.weight, 0);
    const byTrait = new Map<string, TraitOdds>();
    const byValue = new Map<string, { value: string | number; weight: number; chance: number }>();
    for (const it of items) for (const a of it.attributes) {
      let t = byTrait.get(a.trait_type);
      if (!t) { t = { trait_type: a.trait_type, values: [] }; byTrait.set(a.trait_type, t); out.push(t); }
      const k = a.trait_type + "\u0000" + typeof a.value + "\u0000" + String(a.value);
      let v = byValue.get(k);
      if (!v) { v = { value: a.value, weight: 0, chance: 0 }; byValue.set(k, v); t.values.push(v); }
      v.weight += it.weight;
    }
    for (const t of out) for (const v of t.values) v.chance = total > 0 ? v.weight / total : 0;
  } else {
    for (const ly of c.layers || []) {
      const total = ly.options.reduce((a, o) => a + o.weight, 0);
      const t: TraitOdds = { trait_type: ly.name, values: [] };
      const byValue = new Map<string, { value: string; weight: number; chance: number }>();
      for (const o of ly.options) {
        let v = byValue.get(o.value);
        if (!v) { v = { value: o.value, weight: 0, chance: 0 }; byValue.set(o.value, v); t.values.push(v); }
        v.weight += o.weight;
      }
      for (const v of t.values) v.chance = total > 0 ? v.weight / total : 0;
      out.push(t);
    }
  }
  for (const a of c.attributes || []) out.push({ trait_type: a.trait_type, values: [{ value: a.value, weight: 1, chance: 1 }] });
  return out;
}
/// Pictures: the chance of each item, 0 to 1. Layers: [].
export function itemChances(c: ArtCollection): number[] {
  if (c.kind !== "pictures") return [];
  const items = c.items || [];
  const total = items.reduce((a, i) => a + i.weight, 0);
  return items.map((i) => (total > 0 ? i.weight / total : 0));
}
/// Layers: for each layer, the chance of each option, 0 to 1. Pictures: [].
export function optionChances(c: ArtCollection): number[][] {
  if (c.kind !== "layers") return [];
  return (c.layers || []).map((ly) => { const total = ly.options.reduce((a, o) => a + o.weight, 0); return ly.options.map((o) => (total > 0 ? o.weight / total : 0)); });
}

// ---- addresses -------------------------------------------------------------------------------------------

/// A folder id: an Arweave id (43 characters of base64url) or an Irys id (base58), 32 to 44 characters.
export function isFolderId(s: unknown): s is string { return typeof s === "string" && /^[A-Za-z0-9_-]{32,44}$/.test(s); }
/// The uri_base of a coin whose art is the folder `folderId`, served by the site at `origin`.
/// Throws a plain sentence when it would not fit in a coin (80 bytes).
export function artUriBase(origin: string, folderId: string): string {
  const o = String(origin || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s?#]+$/i.test(o)) throw new Error("The site address must start with http:// or https://.");
  if (!isFolderId(folderId)) throw new Error("That is not a folder id.");
  const u = o + "/art/u/" + folderId;
  const n = utf8Len(u);
  if (n > ART_URI_BASE_MAX) {
    throw new Error("The art address " + u + " is " + n + " bytes, and a coin allows " + ART_URI_BASE_MAX + ". This site's address is too long for uploaded art: it can be at most " + (ART_URI_BASE_MAX - 7 - folderId.length) + " characters.");
  }
  return u;
}
/// The site and the folder of a uri_base made by artUriBase, or null for any other address.
export function parseArtUriBase(uriBase: string): { origin: string; folderId: string } | null {
  const m = /^(https?:\/\/[^\s?#]+?)\/art\/u\/([A-Za-z0-9_-]{32,44})$/.exec(String(uriBase || ""));
  return m ? { origin: m[1], folderId: m[2] } : null;
}
/// Where a gateway serves a file of a folder: <gateway>/<folder id>/<path>.
export function artFileUrl(gateway: string, folderId: string, path: string): string {
  return String(gateway).replace(/\/+$/, "") + "/" + folderId + "/" + String(path).split("/").map(encodeURIComponent).join("/");
}
/// Any file name as a path a folder may hold: accents dropped, other characters made "_",
/// the extension in lowercase. "My Pics/Blue Eyes.PNG" becomes "My_Pics/Blue_Eyes.png".
export function safeArtPath(name: string): string {
  const parts = String(name || "").replace(/\\/g, "/").normalize("NFKD").replace(/[̀-ͯ]/g, "").split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .map((s) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").replace(/_+/g, "_") || "x");
  if (!parts.length) return "x";
  const last = parts.length - 1;
  parts[last] = parts[last].replace(/\.([A-Za-z0-9]+)$/, (_m, e: string) => "." + e.toLowerCase());
  if (parts[last].toLowerCase() === ART_FILE) parts[last] = "collection-image.json";
  let p = parts.join("/");
  while (utf8Len(p) > L.pathBytes && parts.length > 1) { parts.shift(); p = parts.join("/"); }
  if (utf8Len(p) > L.pathBytes) {
    const m = /^(.*?)(\.[a-z0-9]+)?$/.exec(p)!;
    p = m[1].slice(0, L.pathBytes - (m[2] || "").length) + (m[2] || "");
  }
  return p;
}
/// What an image file is, from its first bytes: png, jpeg, gif or webp, with its pixel size when
/// it is easy to read (PNG, GIF, WebP). Null for anything else.
export function sniffImage(b: Uint8Array): { type: string; ext: string; width?: number; height?: number } | null {
  if (!b || b.length < 12) return null;
  const u32be = (o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return b.length >= 24 ? { type: "image/png", ext: "png", width: u32be(16), height: u32be(20) } : { type: "image/png", ext: "png" };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { type: "image/gif", ext: "gif", width: b[6] + b[7] * 256, height: b[8] + b[9] * 256 };
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const out: { type: string; ext: string; width?: number; height?: number } = { type: "image/webp", ext: "webp" };
    if (b.length >= 30) {
      const chunk = ascii(12, 4);
      if (chunk === "VP8X") { out.width = 1 + b[24] + (b[25] << 8) + (b[26] << 16); out.height = 1 + b[27] + (b[28] << 8) + (b[29] << 16); }
      else if (chunk === "VP8 ") { out.width = (b[26] + (b[27] << 8)) & 0x3fff; out.height = (b[28] + (b[29] << 8)) & 0x3fff; }
      else if (chunk === "VP8L" && b[20] === 0x2f) { const v = b[21] + (b[22] << 8) + (b[23] << 16) + (b[24] << 24 >>> 0); out.width = (v & 0x3fff) + 1; out.height = ((v >>> 14) & 0x3fff) + 1; }
    }
    return out;
  }
  return null;
}

// ---- the JSON a piece and the collection answer -----------------------------------------------------------

/// A piece's Metaplex JSON. `imageUrl`: the picture on the gateway, or the site's composite for layers.
export function artPieceMetadata(c: ArtCollection, pick: ArtPick, imageUrl: string, imageType: string, externalUrl?: string) {
  const ext = externalUrl || c.external_url;
  return {
    name: pick.name, symbol: c.symbol, description: pick.description, image: imageUrl,
    ...(ext ? { external_url: ext } : {}),
    attributes: pick.attributes,
    properties: { category: "image", files: [{ uri: imageUrl, type: imageType }] },
  };
}
/// The collection's Metaplex JSON. `coverUrl`: the cover on the gateway.
export function artCollectionMetadata(c: ArtCollection, coverUrl: string, coverType: string, externalUrl?: string) {
  const ext = externalUrl || c.external_url;
  return {
    name: c.name, symbol: c.symbol, description: c.description, image: coverUrl,
    ...(ext ? { external_url: ext } : {}),
    properties: { category: "image", files: [{ uri: coverUrl, type: coverType }] },
  };
}
