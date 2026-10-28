// The hook descriptor, version 1: the format, its validator, and the pin that ties a
// descriptor's content to a hook's manifest. A descriptor is a small JSON file a hook's
// author hosts and the hook's manifest links to (hook-template/README.md, "Describe your
// hook"). This file imports nothing, so the pages, the "List yours" guide and the upload
// server (web/serve.js, in Node) all run the same code: a descriptor one of them accepts is
// one the others accept.

// ---- the descriptor format, version 1 ---------------------------------------------------------------

export const DESCRIPTOR_VERSION = 1;
/// The largest descriptor the site reads, in bytes.
export const MAX_DESCRIPTOR_BYTES = 16384;
export const LIMITS = { name: 48, summary: 280, rules: 12, rule: 200, source: 200, author: 80, args: 12, accounts: 12, label: 48, unit: 12, help: 200, seeds: 4, seed: 32 };
/// Borsh types of an argument the launcher chooses, with the range of the integers.
export const ARG_TYPES = {
  u8: { bytes: 1, min: 0n, max: 255n },
  u16: { bytes: 2, min: 0n, max: 65535n },
  u32: { bytes: 4, min: 0n, max: 4294967295n },
  u64: { bytes: 8, min: 0n, max: 18446744073709551615n },
  i64: { bytes: 8, min: -9223372036854775808n, max: 9223372036854775807n },
  bool: { bytes: 1 },
  pubkey: { bytes: 32 },
};
/// Addresses the site knows at launch. As an argument type the site fills the address in.
/// As a seed, { "key": <name> } puts the address into a PDA.
export const KEY_NAMES = ["pool", "launcher", "base_mint", "quote_mint"];
/// The only accounts a setup instruction may ask for. No other address, no other signer.
export const ROLES = ["launcher", "pda", "system_program", "pool", "base_mint", "quote_mint", "token_program", "token_2022_program"];
export const ROLE_WORDS = {
  launcher: "the wallet that launches, as signer and payer",
  pda: "an account of the hook program, derived from the seeds",
  system_program: "the system program",
  pool: "the pool of the new coin (it does not exist yet)",
  base_mint: "the new coin's mint",
  quote_mint: "the quote token's mint (wrapped SOL)",
  token_program: "the token program",
  token_2022_program: "the Token-2022 program",
};

export const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/// Text an author wrote: a string without control characters or direction overrides.
const hidden = (s) => { for (const ch of s) { const c = ch.codePointAt(0); if (c < 0x20 || c === 0x7f || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true; } return false; };
export const utf8 = (s) => new TextEncoder().encode(s);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/// Is this text a Solana address: base58 that decodes to exactly 32 bytes.
export function isKey(s) {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  const bytes = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return false;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  for (const ch of s) { if (ch === "1") zeros += 1; else break; }
  let n = bytes.length;
  while (n > 0 && bytes[n - 1] === 0) n -= 1;
  return n + zeros === 32;
}

/// A decimal number as raw units: "2.5" with 2 decimals is 250n. null when it is not one.
/// A comma is not read as a decimal point: "1,000" could mean one or one thousand.
export function toRaw(value, decimals = 0) {
  const s = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : typeof value === "string" ? value.trim() : "";
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && !m[3])) return null;
  const frac = m[3] || "";
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) return null;
  const raw = BigInt(m[2] || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return m[1] ? -raw : raw;
}
/// Raw units as the decimal number a launcher types: 250n with 2 decimals is "2.5".
export function fromRaw(raw, decimals = 0) {
  raw = BigInt(raw);
  const neg = raw < 0n; if (neg) raw = -raw;
  const base = 10n ** BigInt(decimals);
  const frac = decimals ? (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return (neg ? "-" : "") + (raw / base).toString() + (frac ? "." + frac : "");
}

/// Validate a descriptor. `expectProgram`: the program id (base58) it was loaded for. A
/// descriptor that names another program is refused. Returns { ok, errors, d } where d is
/// the descriptor with every number parsed, or null.
export function checkDescriptor(json, expectProgram = null) {
  const errors = [];
  const bad = (text) => { errors.push(text); };
  if (!isObject(json)) return { ok: false, errors: ["The file is not a JSON object."], d: null };
  if (json.programmable_hook !== DESCRIPTOR_VERSION) bad("\"programmable_hook\" must be " + DESCRIPTOR_VERSION + ". This site reads version " + DESCRIPTOR_VERSION + " only.");
  const text = (field, max, required) => {
    const v = json[field];
    if (v === undefined || v === null || v === "") { if (required) bad("\"" + field + "\" is missing."); return ""; }
    if (typeof v !== "string") { bad("\"" + field + "\" must be text."); return ""; }
    const s = v.trim();
    if (!s && required) { bad("\"" + field + "\" is empty."); return ""; }
    if (s.length > max) bad("\"" + field + "\" is longer than " + max + " characters.");
    if (hidden(s)) bad("\"" + field + "\" holds control characters.");
    return s;
  };
  let program = "";
  if (typeof json.program !== "string" || !isKey(json.program)) bad("\"program\" must be the hook's program id.");
  else {
    program = json.program;
    if (expectProgram && program !== expectProgram) bad("It names another program (" + program + "). A descriptor counts only for the program it names.");
  }
  const name = text("name", LIMITS.name, true);
  const summary = text("summary", LIMITS.summary, true);
  const author = text("author", LIMITS.author, false);
  const source = text("source", LIMITS.source, false);
  if (source && !/^https:\/\/[^\s]+$/.test(source)) bad("\"source\" must be an https link.");
  const rules = [];
  if (!Array.isArray(json.rules) || json.rules.length < 1) bad("\"rules\" must be a list with at least one sentence.");
  else {
    if (json.rules.length > LIMITS.rules) bad("\"rules\" holds more than " + LIMITS.rules + " sentences.");
    json.rules.slice(0, LIMITS.rules).forEach((r, i) => {
      if (typeof r !== "string" || !r.trim()) return bad("Rule " + (i + 1) + " is empty or not text.");
      if (r.trim().length > LIMITS.rule) bad("Rule " + (i + 1) + " is longer than " + LIMITS.rule + " characters.");
      if (hidden(r)) bad("Rule " + (i + 1) + " holds control characters.");
      rules.push(r.trim());
    });
  }
  let setup = null;
  if (json.setup !== undefined && json.setup !== null) setup = checkSetup(json.setup, bad);
  const d = { version: DESCRIPTOR_VERSION, program, name, summary, rules, source, author, setup };
  return { ok: errors.length === 0, errors, d: errors.length === 0 ? d : null };
}

function onlyKeys(obj, allowed, where, bad) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(where + " has a field this site does not know: \"" + k + "\".");
}

function checkSetup(s, bad) {
  if (!isObject(s)) { bad("\"setup\" must be an object."); return null; }
  onlyKeys(s, ["instruction", "args", "accounts"], "\"setup\"", bad);
  const instruction = typeof s.instruction === "string" ? s.instruction : "";
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(instruction)) bad("\"setup.instruction\" must be the instruction's name in snake_case, as in the hook's Rust code.");
  const args = [];
  const seen = new Set();
  if (!Array.isArray(s.args)) bad("\"setup.args\" must be a list. An instruction without arguments has an empty one.");
  else {
    if (s.args.length > LIMITS.args) bad("\"setup.args\" holds more than " + LIMITS.args + " arguments.");
    s.args.slice(0, LIMITS.args).forEach((a, i) => { const out = checkArg(a, i, seen, bad); if (out) args.push(out); });
  }
  const accounts = [];
  if (!Array.isArray(s.accounts) || s.accounts.length < 1) bad("\"setup.accounts\" must be a list with at least one account.");
  else {
    if (s.accounts.length > LIMITS.accounts) bad("\"setup.accounts\" holds more than " + LIMITS.accounts + " accounts.");
    s.accounts.slice(0, LIMITS.accounts).forEach((a, i) => { const out = checkAccount(a, i, bad); if (out) accounts.push(out); });
  }
  return { instruction, args, accounts };
}

function checkArg(a, i, seen, bad) {
  const where = "Argument " + (i + 1);
  if (!isObject(a)) { bad(where + " must be an object."); return null; }
  const name = typeof a.name === "string" ? a.name : "";
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) bad(where + " needs a \"name\" in snake_case.");
  else if (seen.has(name)) bad(where + " repeats the name \"" + name + "\".");
  seen.add(name);
  const type = typeof a.type === "string" ? a.type : "";
  if (KEY_NAMES.includes(type)) {
    // an address the site fills in: nothing for the launcher to choose
    onlyKeys(a, ["name", "type"], where, bad);
    return { name, type, fixed: true };
  }
  const t = ARG_TYPES[type];
  if (!t) { bad(where + " has the type \"" + type + "\". The types are " + Object.keys(ARG_TYPES).join(", ") + ", " + KEY_NAMES.join(", ") + "."); return null; }
  onlyKeys(a, ["name", "type", "label", "unit", "decimals", "min", "max", "default", "help"], where, bad);
  const str = (field, max, required) => {
    const v = a[field];
    if (v === undefined || v === null || v === "") { if (required) bad(where + " needs a \"" + field + "\": the launcher chooses this value."); return ""; }
    if (typeof v !== "string") { bad(where + ": \"" + field + "\" must be text."); return ""; }
    if (v.trim().length > max) bad(where + ": \"" + field + "\" is longer than " + max + " characters.");
    if (hidden(v)) bad(where + ": \"" + field + "\" holds control characters.");
    return v.trim();
  };
  const out = { name, type, fixed: false, label: str("label", LIMITS.label, true), unit: str("unit", LIMITS.unit, false), help: str("help", LIMITS.help, false), decimals: 0, min: null, max: null, def: null };
  if (type === "bool") {
    for (const f of ["decimals", "min", "max"]) if (a[f] !== undefined) bad(where + ": a bool takes no \"" + f + "\".");
    if (a.default !== undefined && typeof a.default !== "boolean") bad(where + ": the default of a bool is true or false.");
    out.def = a.default === undefined ? null : a.default;
    return out;
  }
  if (type === "pubkey") {
    for (const f of ["decimals", "min", "max", "unit"]) if (a[f] !== undefined) bad(where + ": an address takes no \"" + f + "\".");
    if (a.default !== undefined && a.default !== "launcher") bad(where + ": the only default of an address is \"launcher\", the wallet that launches.");
    out.def = a.default === "launcher" ? "launcher" : null;
    return out;
  }
  if (a.decimals !== undefined) {
    if (!Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > 12) bad(where + ": \"decimals\" must be a whole number from 0 to 12.");
    else out.decimals = a.decimals;
  }
  const num = (field) => {
    if (a[field] === undefined || a[field] === null) return null;
    const raw = toRaw(a[field], out.decimals);
    if (raw === null) { bad(where + ": \"" + field + "\" is not a number with at most " + out.decimals + " decimals."); return null; }
    if (raw < t.min || raw > t.max) { bad(where + ": \"" + field + "\" does not fit in a " + type + "."); return null; }
    return raw;
  };
  const min = num("min"), max = num("max");
  out.min = min === null ? t.min : min;
  out.max = max === null ? t.max : max;
  out.def = num("default");
  if (out.min > out.max) bad(where + ": \"min\" is above \"max\".");
  else if (out.def !== null && (out.def < out.min || out.def > out.max)) bad(where + ": \"default\" is outside \"min\" and \"max\".");
  return out;
}

function checkAccount(a, i, bad) {
  const where = "Account " + (i + 1);
  if (!isObject(a)) { bad(where + " must be an object."); return null; }
  const role = typeof a.role === "string" ? a.role : "";
  if (!ROLES.includes(role)) { bad(where + " has the role \"" + role + "\". The roles are " + ROLES.join(", ") + "."); return null; }
  if (role !== "pda") { onlyKeys(a, ["role"], where, bad); return { role }; }
  onlyKeys(a, ["role", "seeds", "writable"], where, bad);
  if (a.writable !== undefined && typeof a.writable !== "boolean") bad(where + ": \"writable\" is true or false.");
  const seeds = [];
  if (!Array.isArray(a.seeds) || a.seeds.length < 1 || a.seeds.length > LIMITS.seeds) bad(where + " needs 1 to " + LIMITS.seeds + " seeds.");
  else for (const s of a.seeds) {
    if (typeof s === "string") {
      const n = utf8(s).length;
      if (n < 1 || n > LIMITS.seed) bad(where + ": a seed is 1 to " + LIMITS.seed + " bytes of text.");
      else seeds.push({ text: s });
    } else if (isObject(s) && KEY_NAMES.includes(s.key) && Object.keys(s).length === 1) seeds.push({ key: s.key });
    else bad(where + ": a seed is text, or { \"key\": one of " + KEY_NAMES.join(", ") + " }.");
  }
  return { role, seeds, writable: a.writable === true };
}

// SHA-256, for Anchor's instruction discriminator and for the pin. Written out because crypto.subtle only
// exists on https pages and on localhost.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256(bytes) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  // the message, one 0x80 byte and the 8 bytes of its length, rounded up to whole blocks of 64
  const len = bytes.length, total = ((len + 72) >> 6) << 6;
  const msg = new Uint8Array(total);
  msg.set(bytes); msg[len] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(total - 8, Math.floor(len / 0x20000000)); view.setUint32(total - 4, (len << 3) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}
/// Anchor's discriminator of an instruction: sha256("global:<name>"), the first 8 bytes.
export function anchorDiscriminator(name) { return sha256(utf8("global:" + name)).subarray(0, 8); }

// ---- the link in a manifest, and the pin ------------------------------------------------------------------
// A manifest names the ADDRESS of a descriptor. Without more, its author could put another
// text there later. So the link may end with "#s=" and a pin: the first 16 bytes of the
// SHA-256 of the file's exact bytes, written as 22 characters of base64url without padding.
// A site hashes the bytes it fetched and refuses a file whose pin is another one. The
// manifest is written once, before the freeze, so the pin of a hook never changes.
//
// What the pin is worth. It proves that the file is the one its author pinned. It is not a
// signature, and it says nothing about the code: nobody checks the words against the
// program. The pin is 128 bits because the whole link has 128 bytes. Nobody can make another
// file for a pin that somebody else chose: that takes about 2^128 tries. An author who
// prepares TWO files with the same pin before deploying needs about 2^64 tries, which a
// large budget can pay for. Such an author could later swap between those two texts and no
// others. The code is frozen either way.

/// The bytes a manifest's uri holds.
export const MAX_URI_BYTES = 128;
const PIN_START = "s=";
/// The characters of a pin: 16 bytes in base64url, without padding.
export const PIN_CHARS = 22;
/// The bytes the pin takes at the end of the link: "#s=" and the 22 characters.
export const PIN_BYTES = 1 + PIN_START.length + PIN_CHARS;
/// The longest address of a descriptor that still fits with its pin.
export const MAX_PINNED_ADDRESS_BYTES = MAX_URI_BYTES - PIN_BYTES;
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/// Bytes as base64url without padding.
export function base64url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + (i + 1 < bytes.length ? B64URL[(n >> 6) & 63] : "") + (i + 2 < bytes.length ? B64URL[n & 63] : "");
  }
  return out;
}
/// Is this text a pin as pinOf writes one. 22 characters hold 132 bits and a pin has 128, so
/// the last character can only be one of four. Any other spelling is not a pin.
export const isPin = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(s);
/// The pin of a file: the first 16 bytes of the SHA-256 of its bytes, as 22 characters.
export function pinOf(bytes) { return base64url(sha256(bytes).subarray(0, 16)); }
/// An address with the pin of the file behind it.
export function pinnedUri(address, bytes) { return address + "#" + PIN_START + pinOf(bytes); }

/// What a manifest's uri is.
///   url   the address to load a descriptor from, without the fragment. Empty when the uri
///         is no descriptor address: not https (on a local chain, with `allowLocal`, this
///         machine's own http address counts too), or a path that does not end in .json
///   link  the uri as a link to show, when it is a web address at all
///   pin   the pin the link carries, 22 characters, or empty
///   pinError  a sentence, when the link carries "#s=" and what follows is not a pin
/// A fragment that does not start with "s=" is not a pin and is left out: the link is read as
/// an address without a pin.
export function parseUri(uri, allowLocal = false) {
  const none = { url: "", link: "", pin: "", pinError: "" };
  let u;
  try { u = new URL(String(uri || "").trim()); } catch (_) { return none; }
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !(local && allowLocal)) return none;
  const link = u.href;
  if (!/\.json$/i.test(u.pathname)) return { ...none, link };
  const fragment = u.hash.replace(/^#/, "");
  u.hash = "";
  const out = { url: u.href, link, pin: "", pinError: "" };
  if (fragment.toLowerCase().startsWith(PIN_START)) {
    const value = fragment.slice(PIN_START.length);
    if (fragment.startsWith(PIN_START) && isPin(value)) out.pin = value;
    else out.pinError = "The link carries a pin that is not one. After \"#s=\" a pin has " + PIN_CHARS + " characters.";
  }
  return out;
}
