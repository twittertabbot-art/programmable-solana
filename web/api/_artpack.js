// Built from sdk/src/artpack.ts by sdk/esbuild.mjs (npm run build -w sdk). Do not edit.

// src/hash.ts
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
function sha256(input) {
  const msg = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const bits = msg.length * 8;
  const padded = new Uint8Array((msg.length + 8 >> 6) + 1 << 6);
  padded.set(msg);
  padded[msg.length] = 128;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bits / 4294967296), false);
  dv.setUint32(padded.length - 4, bits >>> 0, false);
  const h = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => x >>> n | x << 32 - n;
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = e & f ^ ~e & g;
      const t1 = hh + s1 + ch + K[i] + w[i] >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const t2 = s0 + maj >>> 0;
      hh = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    h[0] = h[0] + a >>> 0;
    h[1] = h[1] + b >>> 0;
    h[2] = h[2] + c >>> 0;
    h[3] = h[3] + d >>> 0;
    h[4] = h[4] + e >>> 0;
    h[5] = h[5] + f >>> 0;
    h[6] = h[6] + g >>> 0;
    h[7] = h[7] + hh >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i], false);
  return out;
}

// src/artpack.ts
var ART_FILE = "collection.json";
var ART_URI_BASE_MAX = 80;
var ART_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
var ART_LIMITS = {
  /// pictures in one collection
  items: 1e4,
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
  descriptionBytes: 2e3,
  /// a trait_type, and a value written as text
  traitBytes: 64,
  /// one file path in the folder
  pathBytes: 120,
  /// external_url
  urlBytes: 200,
  /// one weight: a whole number from 0 to this
  weight: 1e6,
  /// the sum of the weights of one list (the items, or the options of one layer)
  totalWeight: 4294967295,
  /// one picture, or the cover
  fileBytes: 2e7,
  /// one layer PNG
  layerFileBytes: 4e6,
  /// layers: width and height at most this many pixels
  layerSide: 2048,
  /// layers: width times height at most this
  layerPixels: 4194304,
  /// collection.json itself
  manifestBytes: 4e6,
  /// files in the folder besides collection.json
  files: 10001,
  /// the whole folder, collection.json included
  totalBytes: 1e9
};
var L = ART_LIMITS;
var DISPLAY_TYPES = ["number", "boost_number", "boost_percentage", "date"];
var enc = new TextEncoder();
var utf8Len = (s) => enc.encode(s).length;
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var CONTROL = /[\u0000-\u001f\u007f]/;
var CONTROL_KEEP_LINES = /[\u0000-\u0009\u000b-\u001f\u007f]/;
var SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
var B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function artExtension(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
}
function artTypeOf(path) {
  return ART_TYPES[artExtension(path)] || "";
}
function isArtPath(p) {
  if (typeof p !== "string" || !p || utf8Len(p) > L.pathBytes) return false;
  if (p.toLowerCase() === ART_FILE) return false;
  return p.split("/").every((s) => SEGMENT.test(s)) && !!artTypeOf(p);
}
function checkCollection(json, files) {
  const errors = [];
  const warnings = [];
  const err = (s) => {
    if (errors.length < 50) errors.push(s);
    else if (errors.length === 50) errors.push("There are more problems; fix these first.");
  };
  const fail = () => ({ ok: false, errors, warnings, collection: null, paths: [], bytes: 0 });
  if (!isObj(json)) {
    err("collection.json must be a JSON object.");
    return fail();
  }
  const j = json;
  if (j.version !== 1) err("version must be 1.");
  const kind = j.kind;
  if (kind !== "pictures" && kind !== "layers") {
    err('kind must be "pictures" or "layers".');
    return fail();
  }
  const text = (v, label, min, max, lines = false) => {
    if (v === void 0 || v === null) {
      if (min > 0) {
        err(label + " is missing.");
        return null;
      }
      return "";
    }
    if (typeof v !== "string") {
      err(label + " must be text.");
      return null;
    }
    const s = v.trim();
    const n = utf8Len(s);
    if (n < min) {
      err(label + " is empty.");
      return null;
    }
    if (n > max) {
      err(label + " is " + n + " bytes long; the most is " + max + ".");
      return null;
    }
    if ((lines ? CONTROL_KEEP_LINES : CONTROL).test(s)) {
      err(label + " has a control character in it.");
      return null;
    }
    return s;
  };
  const path = (v, label, pngOnly) => {
    if (typeof v !== "string" || !v) {
      err(label + ": the image path is missing.");
      return null;
    }
    if (utf8Len(v) > L.pathBytes) {
      err(label + ": the path " + v.slice(0, 40) + " is longer than " + L.pathBytes + " bytes.");
      return null;
    }
    if (v.toLowerCase() === ART_FILE) {
      err(label + ": " + ART_FILE + " cannot be an image.");
      return null;
    }
    if (!v.split("/").every((s) => SEGMENT.test(s))) {
      err(label + ": the path " + v + " may only use letters, digits, dot, dash and underscore, with / between folders, and no part may start with a dot.");
      return null;
    }
    const ext = artExtension(v);
    if (pngOnly ? ext !== "png" : !ART_TYPES[ext]) {
      err(label + ": " + v + (pngOnly ? " must be a PNG file (a layer needs transparency)." : " must be a png, jpg, gif or webp file."));
      return null;
    }
    return v;
  };
  const weight = (v, label) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > L.weight) {
      err(label + ": the weight must be a whole number from 0 to " + L.weight + ".");
      return null;
    }
    return v;
  };
  const attrs = (v, label) => {
    if (v === void 0 || v === null) return [];
    if (!Array.isArray(v)) {
      err(label + ": attributes must be a list.");
      return null;
    }
    if (v.length > L.attributes) {
      err(label + ": at most " + L.attributes + " attributes.");
      return null;
    }
    const out2 = [];
    for (let i = 0; i < v.length; i++) {
      const a = v[i];
      const where = label + ", attribute " + (i + 1);
      if (!isObj(a)) {
        err(where + " must be an object with trait_type and value.");
        continue;
      }
      const t = text(a.trait_type, where + ": trait_type", 1, L.traitBytes);
      let value = null;
      if (typeof a.value === "number") {
        if (Number.isFinite(a.value)) value = a.value;
        else err(where + ": the value is not a finite number.");
      } else value = text(a.value, where + " (" + (t || "?") + "): the value", 1, L.traitBytes);
      let display;
      if (a.display_type !== void 0 && a.display_type !== null) {
        if (!DISPLAY_TYPES.includes(a.display_type)) err(where + ": display_type must be one of " + DISPLAY_TYPES.join(", ") + ".");
        else if (typeof value !== "number") err(where + ": a display_type needs a number value.");
        else display = a.display_type;
      }
      if (t === null || value === null) continue;
      out2.push(display ? { trait_type: t, value, display_type: display } : { trait_type: t, value });
    }
    return out2;
  };
  const noRepeat = (list, label) => {
    const seen2 = /* @__PURE__ */ new Set();
    for (const a of list) {
      const k = a.trait_type.toLowerCase();
      if (seen2.has(k)) err(label + ": the trait " + a.trait_type + " is listed twice.");
      seen2.add(k);
    }
  };
  const name = text(j.name, "The collection name", 1, L.nameBytes);
  const symbol = text(j.symbol, "The symbol", 0, L.symbolBytes);
  const description = text(j.description, "The description", 0, L.descriptionBytes, true);
  let external;
  if (j.external_url !== void 0 && j.external_url !== null && j.external_url !== "") {
    const u = text(j.external_url, "external_url", 1, L.urlBytes);
    if (u !== null) {
      if (/^https?:\/\/[^\s]+$/i.test(u)) external = u;
      else err("external_url must be an http or https address.");
    }
  }
  const cover = path(j.cover, "The cover", false);
  let fee;
  if (j.seller_fee_basis_points !== void 0 && j.seller_fee_basis_points !== null) {
    const f = j.seller_fee_basis_points;
    if (typeof f !== "number" || !Number.isInteger(f) || f < 0 || f > 1e4) err("seller_fee_basis_points must be a whole number from 0 to 10000.");
    else fee = f;
  }
  let creators;
  if (j.creators !== void 0 && j.creators !== null) {
    if (!Array.isArray(j.creators) || j.creators.length < 1 || j.creators.length > 5) err("creators must be a list of 1 to 5 entries.");
    else {
      const list = [];
      let sum = 0;
      j.creators.forEach((c2, i) => {
        if (!isObj(c2) || typeof c2.address !== "string" || !B58.test(c2.address)) {
          err("Creator " + (i + 1) + ": the address must be a Solana address.");
          return;
        }
        if (typeof c2.share !== "number" || !Number.isInteger(c2.share) || c2.share < 0 || c2.share > 100) {
          err("Creator " + (i + 1) + ": the share must be a whole number from 0 to 100.");
          return;
        }
        sum += c2.share;
        list.push({ address: c2.address, share: c2.share });
      });
      if (list.length === j.creators.length) {
        if (sum !== 100) err("The creators' shares must add up to 100.");
        else creators = list;
      }
    }
  }
  const common = attrs(j.attributes, "The common attributes");
  if (common) noRepeat(common, "The common attributes");
  const out = { version: 1, kind, name: name || "", symbol: symbol || "", description: description || "", cover: cover || "" };
  if (external) out.external_url = external;
  out.cover = cover || "";
  if (fee !== void 0) out.seller_fee_basis_points = fee;
  if (creators) out.creators = creators;
  if (common && common.length) out.attributes = common;
  const commonCount = common ? common.length : 0;
  const commonKeys = new Set((common || []).map((a) => a.trait_type.toLowerCase()));
  const layerPaths = /* @__PURE__ */ new Set();
  if (kind === "pictures") {
    if (j.layers !== void 0) err("A pictures collection has no layers.");
    if (!Array.isArray(j.items) || j.items.length < 1) err("items must be a list of at least one picture.");
    else if (j.items.length > L.items) err("At most " + L.items + " pictures; this one has " + j.items.length + ".");
    else {
      const items = [];
      let total = 0;
      j.items.forEach((it, i) => {
        const nm = isObj(it) && typeof it.name === "string" ? it.name.trim().slice(0, 30) : "";
        const where = "Item " + (i + 1) + (nm ? " (" + nm + ")" : "");
        if (!isObj(it)) {
          err(where + " must be an object.");
          return;
        }
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
        const item = { image, name: iname, attributes: a, weight: w };
        if (idesc) item.description = idesc;
        items.push({ image: item.image, name: item.name, ...item.description ? { description: item.description } : {}, attributes: item.attributes, weight: item.weight });
      });
      if (items.length === j.items.length) {
        if (total <= 0) err("At least one picture needs a weight above 0.");
        else if (total > L.totalWeight) err("The weights add up to more than " + L.totalWeight + ".");
      }
      out.items = items;
    }
  } else {
    if (j.items !== void 0) err("A layers collection has no items.");
    const side = (v, label) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= L.layerSide ? v : (err(label + " must be a whole number of pixels from 1 to " + L.layerSide + "."), null);
    const width = side(j.width, "width"), height = side(j.height, "height");
    if (width && height && width * height > L.layerPixels) err("The layers are " + width + " by " + height + " pixels; at most " + L.layerPixels + " pixels in all.");
    if (width && height) {
      out.width = width;
      out.height = height;
    }
    if (!Array.isArray(j.layers) || j.layers.length < 1) err("layers must be a list of at least one layer.");
    else if (j.layers.length > L.layers) err("At most " + L.layers + " layers; this one has " + j.layers.length + ".");
    else {
      if (j.layers.length + commonCount > L.attributes) err("With the common attributes a piece would have more than " + L.attributes + " attributes.");
      const layers = [];
      const names = /* @__PURE__ */ new Set();
      let optionCount = 0;
      j.layers.forEach((ly, li) => {
        const nm = isObj(ly) && typeof ly.name === "string" ? ly.name.trim().slice(0, 30) : "";
        const where = "Layer " + (li + 1) + (nm ? " (" + nm + ")" : "");
        if (!isObj(ly)) {
          err(where + " must be an object.");
          return;
        }
        const lname = text(ly.name, where + ": the name", 1, L.traitBytes);
        if (lname !== null) {
          const k = lname.toLowerCase();
          if (names.has(k)) err(where + ": two layers are called " + lname + ".");
          if (commonKeys.has(k)) err(where + ": " + lname + " is also a common attribute.");
          names.add(k);
        }
        if (!Array.isArray(ly.options) || ly.options.length < 1) {
          err(where + ": options must be a list of at least one option.");
          return;
        }
        if (ly.options.length > L.optionsPerLayer) {
          err(where + ": at most " + L.optionsPerLayer + " options.");
          return;
        }
        optionCount += ly.options.length;
        const options = [];
        let total = 0;
        ly.options.forEach((o, oi) => {
          const on = isObj(o) && typeof o.value === "string" ? o.value.trim().slice(0, 30) : "";
          const w2 = where + ", option " + (oi + 1) + (on ? " (" + on + ")" : "");
          if (!isObj(o)) {
            err(w2 + " must be an object.");
            return;
          }
          const value = text(o.value, w2 + ": the value", 1, L.traitBytes);
          const w = weight(o.weight, w2);
          if (o.none !== void 0 && typeof o.none !== "boolean") {
            err(w2 + ": none must be true or false.");
            return;
          }
          let image;
          if (o.none === true) {
            if (o.image !== void 0 && o.image !== null && o.image !== "") {
              err(w2 + ": an empty option has no image.");
              return;
            }
          } else image = path(o.image, w2, true);
          if (value === null || w === null || image === null) return;
          total += w;
          const opt = { value, weight: w };
          if (image) {
            opt.image = image;
            layerPaths.add(image);
          }
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
  const c = { version: 1, kind: out.kind, name: out.name, symbol: out.symbol, description: out.description };
  if (out.external_url) c.external_url = out.external_url;
  c.cover = out.cover;
  if (out.seller_fee_basis_points !== void 0) c.seller_fee_basis_points = out.seller_fee_basis_points;
  if (out.creators) c.creators = out.creators;
  if (out.attributes) c.attributes = out.attributes;
  if (kind === "layers") {
    c.width = out.width;
    c.height = out.height;
    c.layers = out.layers;
  } else c.items = out.items;
  const paths = [];
  const seen = /* @__PURE__ */ new Set();
  const use = (p) => {
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };
  use(c.cover);
  for (const it of c.items || []) use(it.image);
  for (const ly of c.layers || []) for (const o of ly.options) if (o.image) use(o.image);
  if (paths.length > L.files) err("The folder would hold " + paths.length + " files; the most is " + L.files + ".");
  const manifestBytes = encodeCollection(c).length;
  if (manifestBytes > L.manifestBytes) err("collection.json would be " + manifestBytes + " bytes; the most is " + L.manifestBytes + ".");
  let bytes = 0;
  if (files) {
    const byPath = /* @__PURE__ */ new Map();
    for (const f of files) if (f && typeof f.path === "string" && f.path !== ART_FILE) byPath.set(f.path, f);
    bytes = manifestBytes;
    for (const p of paths) {
      const f = byPath.get(p);
      if (!f) {
        err("The file " + p + " is missing.");
        continue;
      }
      const isLayer = layerPaths.has(p);
      const cap = isLayer ? L.layerFileBytes : L.fileBytes;
      if (!(f.bytes > 0)) err("The file " + p + " is empty.");
      else if (f.bytes > cap) err("The file " + p + " is " + f.bytes + " bytes; the most is " + cap + (isLayer ? " for a layer." : "."));
      bytes += f.bytes > 0 ? f.bytes : 0;
      const want = artTypeOf(p);
      if (f.type && f.type !== want) err("The file " + p + " is a " + f.type + " file, but its name says " + want + ".");
      if (isLayer && c.width && c.height && f.width !== void 0 && f.height !== void 0 && (f.width !== c.width || f.height !== c.height)) {
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
function encodeCollection(c) {
  return enc.encode(JSON.stringify(c) + "\n");
}
function parseCollection(input) {
  let s;
  if (typeof input === "string") s = input;
  else {
    if (input.length > L.manifestBytes) throw new Error("collection.json is larger than " + L.manifestBytes + " bytes.");
    try {
      s = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch (_) {
      throw new Error("collection.json is not UTF-8 text.");
    }
  }
  let j;
  try {
    j = JSON.parse(s.charCodeAt(0) === 65279 ? s.slice(1) : s);
  } catch (_) {
    throw new Error("collection.json is not valid JSON.");
  }
  const r = checkCollection(j);
  if (!r.ok || !r.collection) throw new Error("collection.json is not valid: " + r.errors[0]);
  return r.collection;
}
function collectionArt(bytes) {
  return sha256(bytes).subarray(0, 16);
}
function collectionArtHex(bytes) {
  return hex(collectionArt(bytes));
}
var hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
var ROLL_TAG = enc.encode("programmable-art-v1:");
function seedBytes(seedHex) {
  if (typeof seedHex !== "string" || !/^[0-9a-fA-F]{32}$/.test(seedHex)) throw new Error("A seed is 32 hex characters.");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function artRoll(seedHex, index) {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error("A draw index is 0 to 255.");
  const msg = new Uint8Array(ROLL_TAG.length + 17);
  msg.set(ROLL_TAG, 0);
  msg.set(seedBytes(seedHex), ROLL_TAG.length);
  msg[ROLL_TAG.length + 16] = index;
  const h = sha256(msg);
  return ((((h[0] * 256 + h[1]) * 256 + h[2]) * 256 + h[3]) * 256 + h[4]) * 256 + h[5];
}
function pickIndex(weights, roll) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("Nothing to draw: every weight is 0.");
  const r = roll % total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return weights.length - 1;
}
function pickPiece(c, seedHex) {
  const common = c.attributes || [];
  if (c.kind === "pictures") {
    const items = c.items || [];
    const w = items.map((i2) => i2.weight);
    const total = w.reduce((a, b) => a + b, 0);
    const i = pickIndex(w, artRoll(seedHex, 0));
    const it = items[i];
    return {
      kind: "pictures",
      item: i,
      options: [],
      images: [it.image],
      name: it.name,
      description: it.description || c.description,
      attributes: [...it.attributes, ...common].map((a) => ({ ...a })),
      chance: it.weight / total
    };
  }
  const layers = c.layers || [];
  const options = [];
  const images = [];
  const attributes = [];
  let chance = 1;
  layers.forEach((ly, li) => {
    const w = ly.options.map((o2) => o2.weight);
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
function traitOdds(c) {
  const out = [];
  if (c.kind === "pictures") {
    const items = c.items || [];
    const total = items.reduce((a, i) => a + i.weight, 0);
    const byTrait = /* @__PURE__ */ new Map();
    const byValue = /* @__PURE__ */ new Map();
    for (const it of items) for (const a of it.attributes) {
      let t = byTrait.get(a.trait_type);
      if (!t) {
        t = { trait_type: a.trait_type, values: [] };
        byTrait.set(a.trait_type, t);
        out.push(t);
      }
      const k = a.trait_type + "\0" + typeof a.value + "\0" + String(a.value);
      let v = byValue.get(k);
      if (!v) {
        v = { value: a.value, weight: 0, chance: 0 };
        byValue.set(k, v);
        t.values.push(v);
      }
      v.weight += it.weight;
    }
    for (const t of out) for (const v of t.values) v.chance = total > 0 ? v.weight / total : 0;
  } else {
    for (const ly of c.layers || []) {
      const total = ly.options.reduce((a, o) => a + o.weight, 0);
      const t = { trait_type: ly.name, values: [] };
      const byValue = /* @__PURE__ */ new Map();
      for (const o of ly.options) {
        let v = byValue.get(o.value);
        if (!v) {
          v = { value: o.value, weight: 0, chance: 0 };
          byValue.set(o.value, v);
          t.values.push(v);
        }
        v.weight += o.weight;
      }
      for (const v of t.values) v.chance = total > 0 ? v.weight / total : 0;
      out.push(t);
    }
  }
  for (const a of c.attributes || []) out.push({ trait_type: a.trait_type, values: [{ value: a.value, weight: 1, chance: 1 }] });
  return out;
}
function itemChances(c) {
  if (c.kind !== "pictures") return [];
  const items = c.items || [];
  const total = items.reduce((a, i) => a + i.weight, 0);
  return items.map((i) => total > 0 ? i.weight / total : 0);
}
function optionChances(c) {
  if (c.kind !== "layers") return [];
  return (c.layers || []).map((ly) => {
    const total = ly.options.reduce((a, o) => a + o.weight, 0);
    return ly.options.map((o) => total > 0 ? o.weight / total : 0);
  });
}
function isFolderId(s) {
  return typeof s === "string" && /^[A-Za-z0-9_-]{32,44}$/.test(s);
}
function artUriBase(origin, folderId) {
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
function parseArtUriBase(uriBase) {
  const m = /^(https?:\/\/[^\s?#]+?)\/art\/u\/([A-Za-z0-9_-]{32,44})$/.exec(String(uriBase || ""));
  return m ? { origin: m[1], folderId: m[2] } : null;
}
function artFileUrl(gateway, folderId, path) {
  return String(gateway).replace(/\/+$/, "") + "/" + folderId + "/" + String(path).split("/").map(encodeURIComponent).join("/");
}
function safeArtPath(name) {
  const parts = String(name || "").replace(/\\/g, "/").normalize("NFKD").replace(/[̀-ͯ]/g, "").split("/").filter((s) => s && s !== "." && s !== "..").map((s) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").replace(/_+/g, "_") || "x");
  if (!parts.length) return "x";
  const last = parts.length - 1;
  parts[last] = parts[last].replace(/\.([A-Za-z0-9]+)$/, (_m, e) => "." + e.toLowerCase());
  if (parts[last].toLowerCase() === ART_FILE) parts[last] = "collection-image.json";
  let p = parts.join("/");
  while (utf8Len(p) > L.pathBytes && parts.length > 1) {
    parts.shift();
    p = parts.join("/");
  }
  if (utf8Len(p) > L.pathBytes) {
    const m = /^(.*?)(\.[a-z0-9]+)?$/.exec(p);
    p = m[1].slice(0, L.pathBytes - (m[2] || "").length) + (m[2] || "");
  }
  return p;
}
function sniffImage(b) {
  if (!b || b.length < 12) return null;
  const u32be = (o) => (b[o] << 24 >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10) {
    return b.length >= 24 ? { type: "image/png", ext: "png", width: u32be(16), height: u32be(20) } : { type: "image/png", ext: "png" };
  }
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return { type: "image/jpeg", ext: "jpg" };
  if (b[0] === 71 && b[1] === 73 && b[2] === 70 && b[3] === 56) return { type: "image/gif", ext: "gif", width: b[6] + b[7] * 256, height: b[8] + b[9] * 256 };
  const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const out = { type: "image/webp", ext: "webp" };
    if (b.length >= 30) {
      const chunk = ascii(12, 4);
      if (chunk === "VP8X") {
        out.width = 1 + b[24] + (b[25] << 8) + (b[26] << 16);
        out.height = 1 + b[27] + (b[28] << 8) + (b[29] << 16);
      } else if (chunk === "VP8 ") {
        out.width = b[26] + (b[27] << 8) & 16383;
        out.height = b[28] + (b[29] << 8) & 16383;
      } else if (chunk === "VP8L" && b[20] === 47) {
        const v = b[21] + (b[22] << 8) + (b[23] << 16) + (b[24] << 24 >>> 0);
        out.width = (v & 16383) + 1;
        out.height = (v >>> 14 & 16383) + 1;
      }
    }
    return out;
  }
  return null;
}
function artPieceMetadata(c, pick, imageUrl, imageType, externalUrl) {
  const ext = externalUrl || c.external_url;
  return {
    name: pick.name,
    symbol: c.symbol,
    description: pick.description,
    image: imageUrl,
    ...ext ? { external_url: ext } : {},
    attributes: pick.attributes,
    properties: { category: "image", files: [{ uri: imageUrl, type: imageType }] }
  };
}
function artCollectionMetadata(c, coverUrl, coverType, externalUrl) {
  const ext = externalUrl || c.external_url;
  return {
    name: c.name,
    symbol: c.symbol,
    description: c.description,
    image: coverUrl,
    ...ext ? { external_url: ext } : {},
    properties: { category: "image", files: [{ uri: coverUrl, type: coverType }] }
  };
}
export {
  ART_FILE,
  ART_LIMITS,
  ART_TYPES,
  ART_URI_BASE_MAX,
  artCollectionMetadata,
  artExtension,
  artFileUrl,
  artPieceMetadata,
  artRoll,
  artTypeOf,
  artUriBase,
  checkCollection,
  collectionArt,
  collectionArtHex,
  encodeCollection,
  isArtPath,
  isFolderId,
  itemChances,
  optionChances,
  parseArtUriBase,
  parseCollection,
  pickPiece,
  safeArtPath,
  sniffImage,
  traitOdds
};
