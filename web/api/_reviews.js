// The review requests of Custom hooks. A developer asks Programmable to review a hook program
// and pays the review fee, 25 USD in SOL, to the platform's treasury in the same step. The
// site's request page calls these routes; API.md in the project folder lists them.
//
//   GET  /api/v1/hook-reviews/price          the fee in USD, the SOL price, the fee in lamports, the treasury
//   POST /api/v1/hook-reviews/quote          { wallet }: binds a wallet and an amount for 30 minutes
//   POST /api/v1/hook-reviews                { id, signature, name, repo, commit, description, x?, telegram?, contact? }:
//                                            the paid request, checked against the transaction on chain
//   GET  /api/v1/hook-reviews/<id>           the public view of a request (never the contact)
//   POST /api/v1/hook-reviews/<id>/program   { program, signature }: the program id, signed by the wallet
//   GET  /api/v1/hooks/approved              the platform's approved list, as the chain holds it
//
// web/serve.js sends these routes here. The trade API (web/api/_trade.js) gives the cluster,
// the RPC and its connection. Only the owner's command line (scripts/hook-reviews.mjs)
// changes a status. Every text field is data: the answers are JSON, never HTML.
//
// Environment (all optional):
//   REVIEWS_FILE                 the store, one JSON file. Default: state/hook-reviews.json in
//                                the folder above web/ (never inside web/: it would be served).
//   REVIEW_FEE_USD               the review fee in USD. Default 25. 1 to 1000.
//   REVIEW_SOL_USD               a fixed SOL price in USD, for tests. Read on localnet only.
//   REVIEW_TELEGRAM_BOT_TOKEN    with REVIEW_TELEGRAM_CHAT_ID: one Telegram message to the
//   REVIEW_TELEGRAM_CHAT_ID      owner's chat on a new paid request and on a program id given.
//                                Unset: one line in the server's log instead. Never logged.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as H from "./_sdk.js";
import { connection as tradeConnection, settings } from "./_trade.js";
import { ApiError, base58Decode, clientIp, createRateLimiter, errorResponse, formatUnits, isPublicKey, parseJsonBody } from "./_trade-core.js";

const { PublicKey } = H;

// ---- the contract ------------------------------------------------------------------------------

/// The statuses of a request, in the order a request usually goes through them, and the
/// sentence the request page shows for each.
export const STATUSES = Object.freeze({
  "waiting": "Paid. Waiting for a reviewer.",
  "in-review": "A reviewer is reading the code.",
  "changes-needed": "The code needs changes before it can pass. See the note.",
  "passed": "The code passed the review. Deploy exactly this commit, freeze it, then give the program id below.",
  "checking": "Programmable is checking the program on chain.",
  "approved": "Approved. The hook is on the approved list and appears under Custom hooks.",
  "rejected": "Not approved. See the note.",
});
export const statusText = (status) => STATUSES[status] ?? "";

/// The memo a payment carries: this text and the quote's id.
export const MEMO_PREFIX = "programmable-review:";
/// The SPL Memo program, version 2 and version 1. A payment's memo may come from either.
export const MEMO_PROGRAMS = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];
/// What the wallet signs to give the program id of a request.
export const programMessage = (id, program) => "Programmable hook review " + id + ": my program is " + program;

export const QUOTE_TTL_MS = 30 * 60_000;
/// A payment counts when its block time is at most this many seconds after the quote's end.
export const EXPIRY_GRACE_SECONDS = 120;
/// A quote is kept this long after its end, so that a payment made in time can still be sent in.
export const QUOTE_KEEP_MS = 24 * 3_600_000;
export const MAX_QUOTES = 5000;
export const MAX_REQUESTS = 10_000;
export const PRICE_TTL_MS = 60_000;
/// After both price sources failed, the next price read waits this long.
export const PRICE_RETRY_MS = 10_000;
export const PRICE_TIMEOUT_MS = 4000;
export const SOL_USD_MIN = 1;
export const SOL_USD_MAX = 10_000;
export const PLATFORM_TTL_MS = 30_000;
export const MAX_REVIEW_BODY_BYTES = 16_384;
/// Requests per address per minute, by route.
export const RATE_LIMITS = Object.freeze({ price: 60, status: 60, approved: 60, quote: 10, submit: 10, program: 10 });
/// What the page should wait before it sends a request again after NOT_CONFIRMED_YET.
export const RETRY_AFTER_SECONDS = 6;

/// The public price sources, no key needed. CoinGecko first, Jupiter when CoinGecko fails.
export const PRICE_SOURCES = Object.freeze([
  { name: "coingecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", read: (j) => j && j.solana && j.solana.usd },
  { name: "jupiter", url: "https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", read: (j) => j && j.So11111111111111111111111111111111111111112 && j.So11111111111111111111111111111111111111112.usdPrice },
]);

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ID_RE = /^[0-9a-f]{16}$/;
const SECRET_NAME = /^(private[_-]?key|secret[_-]?key|secret|key[_-]?pair|seed|seed[_-]?phrase|mnemonic)$/i;

/// The store's default place: state/hook-reviews.json in the folder that holds web/.
export function defaultReviewsFile() {
  return path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), "state", "hook-reviews.json");
}

// ---- fields ------------------------------------------------------------------------------------

const bad = (parameter, message) => new ApiError(400, "INVALID_PARAMETER", message, { parameter });

/// Refuses anything but a JSON object, a field that looks like a private key, and a field this
/// route does not take.
function knownFields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "INVALID_JSON", "Send a JSON object.");
  for (const k of Object.keys(body)) {
    if (SECRET_NAME.test(k)) throw bad(k.slice(0, 40), "Never send a private key. Programmable never needs one.");
    if (!allowed.includes(k)) throw bad(k.slice(0, 40), "Unknown field. Allowed fields: " + allowed.join(", ") + ".");
  }
}

// Control and format characters (bidi overrides, zero-width marks) and the line separators.
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const CONTROL_BUT_NEWLINE = /[\0-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/gu;

function text(v, name) {
  if (typeof v !== "string") throw bad(name, name + " is missing. Send it as a string.");
  return v;
}
/// A text field with every control character taken out, trimmed.
export function cleanText(v) { return String(v).replace(CONTROL, "").trim(); }
/// The same for a text of several lines: line breaks stay, as plain newlines.
export function cleanLines(v) { return String(v).replace(/\r\n?/g, "\n").replace(CONTROL_BUT_NEWLINE, "").trim(); }
const length = (s) => [...s].length;

export function checkName(v) {
  const s = cleanText(text(v, "name"));
  if (!/^[\x20-\x7e]{1,32}$/.test(s)) throw bad("name", "name must be 1 to 32 printable ASCII characters.");
  return s;
}

const REPO_RE = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
/// An https address of a repository on GitHub, GitLab or Codeberg: /<owner>/<repo>, with an
/// optional .git and an optional slash at the end. Nothing is ever fetched from it.
export function checkRepo(v) {
  const s = cleanText(text(v, "repo"));
  const why = "repo must be the https address of a public repository on github.com, gitlab.com or codeberg.org, as https://github.com/<owner>/<repo>, at most 200 characters.";
  if (s.length === 0 || s.length > 200) throw bad("repo", why);
  // the scheme and the host in small letters, one slash at the end taken off
  const url = s.replace(/\/$/, "").replace(/^https:\/\/[^/]+/i, (h) => h.toLowerCase());
  const m = REPO_RE.exec(url);
  if (!m) throw bad("repo", why);
  const repo = m[3].replace(/\.git$/, "");
  for (const part of [m[2], repo]) if (!part || /^\.+$/.test(part)) throw bad("repo", why);
  return url;
}

export function checkCommit(v) {
  const s = cleanText(text(v, "commit"));
  if (!/^[0-9a-f]{40}$/.test(s)) throw bad("commit", "commit must be the full commit id: exactly 40 characters of 0 to 9 and a to f, in lower case.");
  return s;
}

export function checkDescription(v) {
  const s = cleanLines(text(v, "description"));
  const n = length(s);
  if (n < 1 || n > 2000) throw bad("description", "description must be 1 to 2000 characters.");
  return s;
}

/// Optional: an email address or any other way to reach the developer, 3 to 120 characters.
/// Left out or empty, it is "". The developer's way in is a ticket in Programmable's Discord.
export function checkContact(v) {
  if (v === undefined || v === null || v === "") return "";
  const s = cleanText(text(v, "contact"));
  const n = length(s);
  if (n === 0) return "";
  if (n < 3 || n > 120) throw bad("contact", "contact must be 3 to 120 characters, or left out.");
  return s;
}

/// A handle with or without its "@", or a link to the profile, as "@name"; "" when left out.
function handle(v, field, re, prefixes, why) {
  if (v === undefined || v === null || v === "") return "";
  let s = cleanText(text(v, field)).trim();
  if (!s) return "";
  for (const p of prefixes) if (s.toLowerCase().startsWith(p)) { s = s.slice(p.length); break; }
  s = s.replace(/\/+$/, "").replace(/^@/, "");
  if (!re.test(s)) throw bad(field, why);
  return "@" + s;
}
/// Optional: the developer's X handle, 1 to 15 letters, digits or underscores, "@" optional.
export function checkXHandle(v) {
  return handle(v, "x", /^[A-Za-z0-9_]{1,15}$/, ["https://x.com/", "https://twitter.com/", "x.com/", "twitter.com/"],
    "x must be an X handle: 1 to 15 letters, digits or underscores, with or without the @.");
}
/// Optional: the developer's Telegram handle, 5 to 32 letters, digits or underscores, "@" optional.
export function checkTelegramHandle(v) {
  return handle(v, "telegram", /^[A-Za-z][A-Za-z0-9_]{4,31}$/, ["https://t.me/", "t.me/"],
    "telegram must be a Telegram username: 5 to 32 letters, digits or underscores, starting with a letter, with or without the @.");
}

function checkId(v) {
  if (typeof v !== "string" || !ID_RE.test(v)) throw bad("id", "id must be the 16 characters of a quote's id.");
  return v;
}

function checkWallet(v, name = "wallet") {
  if (!isPublicKey(v)) throw bad(name, name + " must be a base58 public key.");
  return v;
}

/// A base58 signature of 64 bytes, as bytes.
function signatureBytes(v, name = "signature") {
  const b = typeof v === "string" ? base58Decode(v, 100) : null;
  if (!b || b.length !== 64) throw bad(name, name + " must be a base58 signature of 64 bytes.");
  return b;
}

/// True when `signature` (64 bytes) is the ed25519 signature of `wallet` (base58) over the
/// UTF-8 bytes of `message`.
export function verifyWalletSignature(wallet, message, signature) {
  try {
    const raw = base58Decode(wallet);
    if (!raw || raw.length !== 32 || !signature || signature.length !== 64) return false;
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature));
  } catch (_) { return false; }
}

// ---- money -------------------------------------------------------------------------------------

/// The review fee in USD from REVIEW_FEE_USD: 25 unless it holds a number from 1 to 1000
/// (cents at most).
export function feeUsdFrom(value) {
  if (value === undefined || value === null || value === "") return 25;
  if (!/^[0-9]{1,4}(\.[0-9]{1,2})?$/.test(String(value).trim())) return 25;
  const n = Number(value);
  return n >= 1 && n <= 1000 ? n : 25;
}

/// A SOL price in USD that may be used: a finite number from 1 to 10,000.
export const priceInBounds = (v) => typeof v === "number" && Number.isFinite(v) && v >= SOL_USD_MIN && v <= SOL_USD_MAX;

const ceilDiv = (a, b) => (a + b - 1n) / b;
/// `usd` at `solUsd` USD per SOL, in lamports, rounded up to a whole 1,000 lamports.
export function feeLamports(usd, solUsd) {
  const usdMicro = BigInt(Math.round(usd * 1e6));
  const priceMicro = BigInt(Math.round(solUsd * 1e6));
  if (priceMicro <= 0n) throw new Error("no price");
  const raw = ceilDiv(usdMicro * 1_000_000_000n, priceMicro);
  return Number(ceilDiv(raw, 1000n) * 1000n);
}

// ---- the transaction ---------------------------------------------------------------------------

/// What a confirmed transaction (getTransaction with maxSupportedTransactionVersion 0) holds
/// for a payment: whether it failed, its fee payer and signers, its System Program transfers
/// and its memos, all from the top-level instructions.
export function paymentFacts(tx) {
  const message = tx && tx.transaction && tx.transaction.message;
  if (!message) throw new Error("no message");
  let keys;
  if (typeof message.getAccountKeys === "function") {
    const lookups = tx.meta && tx.meta.loadedAddresses ? tx.meta.loadedAddresses : undefined;
    const all = message.getAccountKeys(lookups ? { accountKeysFromLookups: lookups } : undefined);
    keys = [];
    for (let i = 0; i < all.length; i++) keys.push(all.get(i).toBase58());
  } else {
    keys = (message.staticAccountKeys || message.accountKeys || []).map((k) => (typeof k === "string" ? k : k.toBase58()));
  }
  const header = message.header || {};
  const signers = keys.slice(0, Number(header.numRequiredSignatures || 1));
  const transfers = [];
  const memos = [];
  for (const ins of message.compiledInstructions || []) {
    const program = keys[ins.programIdIndex];
    const data = Buffer.from(ins.data || []);
    const accounts = (ins.accountKeyIndexes || []).map((i) => keys[i]);
    if (program === SYSTEM_PROGRAM && data.length === 12 && data.readUInt32LE(0) === 2 && accounts.length >= 2) {
      transfers.push({ from: accounts[0], to: accounts[1], lamports: data.readBigUInt64LE(4) });
    }
    if (MEMO_PROGRAMS.includes(program)) memos.push(data.toString("utf8"));
  }
  return { failed: !!(tx.meta && tx.meta.err), feePayer: keys[0], signers, transfers, memos };
}

/// Checks a payment against its quote, in the order of the contract. Throws the ApiError of the
/// first check that fails, or answers the transfer that pays. `tx` is what getTransaction gave.
export function checkPayment(quote, tx, nowMs) {
  const blockTime = typeof tx.blockTime === "number" ? tx.blockTime : Math.floor(nowMs / 1000);
  if (blockTime > Math.floor(Date.parse(quote.expiresAt) / 1000) + EXPIRY_GRACE_SECONDS) {
    throw new ApiError(410, "QUOTE_EXPIRED", "This payment landed after the quote ended. Ask for a new quote and pay again. Write to Programmable for the SOL of this one.");
  }
  let f;
  try { f = paymentFacts(tx); } catch (_) { throw new ApiError(422, "PAYMENT_UNREADABLE", "This transaction could not be read as a payment."); }
  if (f.failed) throw new ApiError(422, "TRANSACTION_FAILED", "This transaction failed on chain, so it paid nothing.");
  if (f.feePayer !== quote.wallet && !f.signers.includes(quote.wallet)) {
    throw new ApiError(422, "WRONG_WALLET", "This transaction was not signed by the wallet of the quote, " + quote.wallet + ".");
  }
  const paying = f.transfers.filter((t) => t.from === quote.wallet && t.to === quote.treasury);
  if (!paying.length) {
    throw new ApiError(422, "PAYMENT_MISSING", "This transaction holds no transfer of SOL from " + quote.wallet + " to the Programmable treasury, " + quote.treasury + ".");
  }
  const best = paying.reduce((a, b) => (b.lamports > a.lamports ? b : a));
  if (best.lamports < BigInt(quote.lamports)) {
    throw new ApiError(422, "UNDERPAID", "This transaction paid " + best.lamports + " lamports. The quote asks for " + quote.lamports + " lamports.", { paid: Number(best.lamports), lamports: quote.lamports });
  }
  if (!f.memos.length) throw new ApiError(422, "MEMO_MISSING", "This transaction holds no memo. The payment must carry the memo " + quote.memo + ".");
  if (!f.memos.includes(quote.memo)) throw new ApiError(422, "MEMO_MISMATCH", "The memo of this transaction is not the memo of the quote, " + quote.memo + ".");
  return { lamports: Number(best.lamports), slot: Number(tx.slot), blockTime };
}

// ---- the store -----------------------------------------------------------------------------------

const emptyData = () => ({ version: 1, quotes: {}, requests: {} });
/// A lock file older than this was left by a process that died, and is taken over.
export const LOCK_STALE_MS = 10_000;
const syncSleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* no wait */ } };

/// One JSON file for the quotes and the requests. The server and the owner's command line both
/// write it: every change takes the lock file next to it, reads the file again, changes it and
/// writes it to a temporary file that is then renamed over it. A reader never sees half a file.
/// A file that is not JSON is kept aside as <file>.bad-<time> and the store starts empty.
export class ReviewStore {
  constructor(file, { now = Date.now, log = (line) => console.error(line) } = {}) {
    this.file = path.resolve(file);
    this.now = now;
    this.log = log;
    this.data = null;
    this.stamp = null;
  }

  stampOf() {
    try { const s = fs.statSync(this.file, { bigint: true }); return s.ino + ":" + s.mtimeNs + ":" + s.size; } catch (e) { if (e.code === "ENOENT") return "missing"; throw e; }
  }

  /// The data as the file holds it now: read again only when the file changed.
  read() {
    const stamp = this.stampOf();
    if (this.data && stamp === this.stamp) return this.data;
    this.data = this.load();
    this.stamp = this.stampOf();
    return this.data;
  }

  load() {
    let raw;
    try { raw = fs.readFileSync(this.file, "utf8"); } catch (e) { if (e.code === "ENOENT") return emptyData(); throw e; }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.requests !== "object" || parsed.requests === null || Array.isArray(parsed.requests)) {
      const aside = this.file + ".bad-" + new Date(this.now()).toISOString().replace(/[:.]/g, "-");
      try { fs.renameSync(this.file, aside); } catch (_) { /* left where it is */ }
      this.log("[hook-reviews] the store " + path.basename(this.file) + " could not be read. It was kept aside as " + path.basename(aside) + " and the store starts empty.");
      return emptyData();
    }
    const data = emptyData();
    for (const [id, r] of Object.entries(parsed.requests)) if (ID_RE.test(id) && r && typeof r === "object") data.requests[id] = r;
    const quotes = parsed.quotes && typeof parsed.quotes === "object" && !Array.isArray(parsed.quotes) ? parsed.quotes : {};
    for (const [id, q] of Object.entries(quotes)) if (ID_RE.test(id) && q && typeof q === "object") data.quotes[id] = q;
    return data;
  }

  lock() {
    const lock = this.file + ".lock";
    // the store holds the developers' contacts: its folder and its file are the owner's alone
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    for (let i = 0; ; i++) {
      try { const fd = fs.openSync(lock, "wx"); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return () => { try { fs.unlinkSync(lock); } catch (_) { /* gone */ } }; } catch (e) {
        if (e.code !== "EEXIST") throw e;
        // a lock left by a process that died: older than LOCK_STALE_MS
        try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch (_) { continue; }
        if (i >= 80) throw new ApiError(503, "BUSY", "The review requests are being written. Try again in a few seconds.");
        syncSleep(25);
      }
    }
  }

  write(data) {
    const tmp = this.file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n", { mode: 0o600 });
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, this.file); break; } catch (e) {
        // a virus scanner or a sync client may hold the file for a moment on Windows
        if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) { try { fs.unlinkSync(tmp); } catch (_) { /* gone */ } throw e; }
        syncSleep(50);
      }
    }
  }

  /// Runs `change(data)` on the file as it stands, under the lock, and writes the result. What
  /// `change` returns is returned. A change that throws writes nothing.
  mutate(change) {
    const unlock = this.lock();
    try {
      this.data = null;
      const data = this.read();
      let out;
      // a change that fails leaves nothing behind in memory either: the next read is the file's
      try { out = change(data); this.write(data); } catch (e) { this.data = null; throw e; }
      this.stamp = this.stampOf();
      this.data = data;
      return out;
    } finally { unlock(); }
  }
}

/// Drops the quotes that ended more than QUOTE_KEEP_MS ago, then the oldest beyond MAX_QUOTES.
export function pruneQuotes(data, nowMs, max = MAX_QUOTES) {
  for (const [id, q] of Object.entries(data.quotes)) {
    const end = Date.parse(q.expiresAt);
    if (!Number.isFinite(end) || end + QUOTE_KEEP_MS < nowMs) delete data.quotes[id];
  }
  const ids = Object.keys(data.quotes);
  if (ids.length > max) {
    ids.sort((a, b) => String(data.quotes[a].createdAt).localeCompare(String(data.quotes[b].createdAt)));
    for (const id of ids.slice(0, ids.length - max)) delete data.quotes[id];
  }
}

/// What anyone may read of a request: never its handles or contact, never its description.
export function publicView(r) {
  return {
    id: r.id, name: r.name, repo: r.repo, commit: r.commit, status: r.status, statusText: statusText(r.status), note: r.note ?? "",
    program: r.program ?? null, report: r.report ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt,
    paid: { signature: r.paid ? r.paid.signature : null, lamports: r.paid ? r.paid.lamports : null },
  };
}

const sol = (lamports) => formatUnits(BigInt(lamports), 9);
export const solOf = sol;

// ---- the owner's changes (scripts/hook-reviews.mjs) ------------------------------------------------
// Each one is a locked read-modify-write of the file: what the server wrote meanwhile stays.

const adminFail = (message) => Object.assign(new Error(message), { admin: true });

/// The link of a review report: an https address, or a path on the site ("/reviews/x.html").
export function checkReport(v) {
  const s = String(v ?? "").trim();
  if (/^https:\/\/[^\s<>"'`\\]{1,290}$/.test(s)) {
    try { const u = new URL(s); if (u.protocol === "https:" && !u.username && !u.password) return s; } catch (_) { /* not an address */ }
  }
  if (/^\/(?!\/)[A-Za-z0-9._~\/%#?=&+-]{0,199}$/.test(s) && !s.includes("..")) return s;
  throw adminFail("A report is an https address or a path on the site that starts with /, at most 200 characters.");
}

function adminChange(store, id, nowMs, change) {
  if (!ID_RE.test(String(id))) throw adminFail("An id is 16 characters of 0 to 9 and a to f.");
  return store.mutate((d) => {
    const r = d.requests[id];
    if (!r) throw adminFail("No review request has the id " + id + ".");
    const at = new Date(nowMs).toISOString();
    const entry = change(r);
    r.updatedAt = at;
    r.history = [...(Array.isArray(r.history) ? r.history : []), { at, status: r.status, note: entry }];
    return r;
  });
}

/// Sets a request's status and its note (an empty note clears it).
export function adminSetStatus(store, id, status, note = "", nowMs = Date.now()) {
  if (!Object.prototype.hasOwnProperty.call(STATUSES, status)) throw adminFail("Unknown status " + JSON.stringify(String(status).slice(0, 40)) + ". The statuses: " + Object.keys(STATUSES).join(", ") + ".");
  const clean = cleanText(note).slice(0, 1000);
  return adminChange(store, id, nowMs, (r) => { r.status = status; r.note = clean; return clean; });
}

/// Links a request to its review report.
export function adminSetReport(store, id, report, nowMs = Date.now()) {
  const link = checkReport(report);
  return adminChange(store, id, nowMs, (r) => { r.report = link; return "Report: " + link; });
}

/// Sets a request's program id by hand. The status stays as it is.
export function adminSetProgram(store, id, program, nowMs = Date.now()) {
  if (!isPublicKey(program)) throw adminFail("A program id is a base58 public key.");
  return adminChange(store, id, nowMs, (r) => { r.program = program; return "Program id set by hand: " + program + "."; });
}

// ---- notification --------------------------------------------------------------------------------

/// One plain-text Telegram message to the owner's chat, or one line in the log when the two
/// settings are not both set. A failure is a line in the log; the token never is.
export function telegramNotifier(env, fetchImpl = globalThis.fetch, log = (line) => console.log(line)) {
  const token = env.REVIEW_TELEGRAM_BOT_TOKEN;
  const chat = env.REVIEW_TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    return async (_message, line) => { log("[hook-reviews] " + line + " (no Telegram message: REVIEW_TELEGRAM_BOT_TOKEN and REVIEW_TELEGRAM_CHAT_ID are not both set)"); return false; };
  }
  return async (message) => {
    try {
      const r = await fetchImpl("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ chat_id: chat, text: message, disable_web_page_preview: true }),
      });
      if (!r.ok) log("[hook-reviews] Telegram refused the message (HTTP " + r.status + ").");
      return !!r.ok;
    } catch (e) {
      log("[hook-reviews] the Telegram message could not be sent (" + String((e && e.name) || "error").slice(0, 40) + ").");
      return false;
    }
  };
}

function paidMessage(r) {
  return ["New hook review request, paid", "Name: " + r.name, "Repository: " + r.repo, "Commit: " + r.commit, "Request: " + r.id,
    "Wallet: " + r.wallet, "Paid: " + sol(r.paid.lamports) + " SOL", "Transaction: " + r.paid.signature, ...reachLines(r)].join("\n");
}
function programGivenMessage(r) {
  return ["Hook review: program id given", "Name: " + r.name, "Repository: " + r.repo, "Commit: " + r.commit, "Request: " + r.id,
    "Wallet: " + r.wallet, "Program: " + r.program, "Paid: " + sol(r.paid.lamports) + " SOL", ...reachLines(r)].join("\n");
}
/// The ways to reach the developer that the request carries, one line each.
function reachLines(r) {
  return [r.x ? "X: " + r.x : null, r.telegram ? "Telegram: " + r.telegram : null, r.contact ? "Contact: " + r.contact : null, "They open a Discord ticket with the request id."].filter(Boolean);
}

// ---- the service ---------------------------------------------------------------------------------

/// The review requests as one object. Every dependency can be given, for the tests:
///   connection   an RPC connection (default: the trade API's)
///   cluster      default: the trade API's settings
///   env          default: process.env
///   file         the store (default: REVIEWS_FILE, else defaultReviewsFile())
///   fetch        for the price sources and Telegram
///   now, random  the clock and the random bytes of an id
///   notify       (message, logLine) => Promise, in place of Telegram
///   limits       requests per address per minute, by route (RATE_LIMITS)
export function createReviewService(opts = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? ((line) => console.error(line));
  const iso = (ms = now()) => new Date(ms).toISOString();
  const conn = () => opts.connection ?? tradeConnection();
  const cluster = () => opts.cluster ?? settings().cluster;
  const store = new ReviewStore(opts.file ?? env.REVIEWS_FILE ?? defaultReviewsFile(), { now, log });
  const notify = opts.notify ?? telegramNotifier(env, fetchImpl, (line) => console.log(line));
  const random = opts.random ?? (() => crypto.randomBytes(8).toString("hex"));
  const feeUsd = feeUsdFrom(env.REVIEW_FEE_USD);
  const windowMs = 60_000;
  const limits = { ...RATE_LIMITS, ...(opts.limits || {}) };
  const limiters = Object.fromEntries(Object.entries(limits).map(([k, limit]) => [k, createRateLimiter({ limit, windowMs, now })]));

  const rpc = async (what, fn) => {
    try { return await fn(); } catch (e) {
      if (e instanceof ApiError) throw e;
      let m = String((e && e.message) || e).slice(0, 200).replace(/https?:\/\/[^\s"']+/g, "<url>");
      log("[hook-reviews] rpc (" + what + "): " + m);
      throw new ApiError(502, "RPC_UNAVAILABLE", "The Solana RPC did not answer. Try again.");
    }
  };

  // ---- the platform account (treasury and approved list), read at most every 30 seconds
  let platformCache = null; let platformInflight = null;
  async function platform() {
    if (platformCache && now() - platformCache.at < PLATFORM_TTL_MS) return platformCache.platform;
    if (!platformInflight) {
      platformInflight = (async () => {
        try {
          const info = await rpc("platform", () => conn().getAccountInfo(H.pda.platform()));
          const notSet = () => new ApiError(503, "NOT_DEPLOYED", "Programmable is not set up on " + cluster() + " yet.");
          if (!info || !info.owner || !info.owner.equals(H.PROGRAMS.hookpool)) throw notSet();
          let p;
          try { p = H.decodePlatform(new Uint8Array(info.data)); } catch (_) { throw notSet(); }
          platformCache = { platform: p, at: now() };
          return p;
        } finally { platformInflight = null; }
      })();
    }
    return platformInflight;
  }

  // ---- the SOL price
  let priceCache = null; let priceFailedAt = 0; let priceInflight = null;
  async function readSource(src) {
    const r = await fetchImpl(src.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(PRICE_TIMEOUT_MS) });
    if (!r.ok) throw new Error(src.name + " answered " + r.status);
    const body = await r.text();
    if (body.length > 100_000) throw new Error(src.name + " answered too much");
    const v = Number(src.read(JSON.parse(body)));
    if (!priceInBounds(v)) throw new Error(src.name + " gave a price outside 1 to 10000 USD");
    return v;
  }
  async function solPrice() {
    if (cluster() === "localnet" && env.REVIEW_SOL_USD !== undefined && env.REVIEW_SOL_USD !== "") {
      const v = Number(env.REVIEW_SOL_USD);
      if (!priceInBounds(v)) throw new ApiError(503, "PRICE_UNAVAILABLE", "REVIEW_SOL_USD must be a price from 1 to 10000 USD.");
      return { solUsd: v, source: "fixed", at: iso() };
    }
    if (priceCache && now() - priceCache.atMs < PRICE_TTL_MS) return priceCache;
    if (now() - priceFailedAt < PRICE_RETRY_MS) throw new ApiError(503, "PRICE_UNAVAILABLE", "The price of SOL could not be read. Try again in a minute.");
    if (!priceInflight) {
      priceInflight = (async () => {
        try {
          for (const src of opts.priceSources ?? PRICE_SOURCES) {
            try {
              const v = await readSource(src);
              priceCache = { solUsd: v, source: src.name, at: iso(), atMs: now() };
              return priceCache;
            } catch (e) { log("[hook-reviews] price from " + src.name + " failed: " + String((e && e.message) || e).slice(0, 120)); }
          }
          priceFailedAt = now();
          throw new ApiError(503, "PRICE_UNAVAILABLE", "The price of SOL could not be read. Try again in a minute.");
        } finally { priceInflight = null; }
      })();
    }
    return priceInflight;
  }

  async function price() {
    const p = await solPrice();
    const plat = await platform();
    return { usd: feeUsd, solUsd: p.solUsd, lamports: feeLamports(feeUsd, p.solUsd), treasury: plat.treasury.toBase58(), source: p.source, at: p.at };
  }

  // ---- POST /hook-reviews/quote
  async function quote(body) {
    knownFields(body, ["wallet"]);
    const wallet = checkWallet(body.wallet);
    if (Object.keys(store.read().requests).length >= MAX_REQUESTS) throw new ApiError(503, "REVIEWS_FULL", "Programmable takes no new review requests right now. Write to Programmable.");
    const p = await price();
    const created = now();
    return store.mutate((data) => {
      pruneQuotes(data, created, MAX_QUOTES - 1);
      let id = random();
      for (let i = 0; data.quotes[id] || data.requests[id]; i++) { if (i > 5) throw new Error("no free id"); id = random(); }
      const q = { id, wallet, lamports: p.lamports, usd: p.usd, solUsd: p.solUsd, treasury: p.treasury, memo: MEMO_PREFIX + id, createdAt: iso(created), expiresAt: iso(created + QUOTE_TTL_MS) };
      data.quotes[id] = q;
      return { id, wallet, lamports: q.lamports, usd: q.usd, solUsd: q.solUsd, treasury: q.treasury, memo: q.memo, expiresAt: q.expiresAt };
    });
  }

  // ---- POST /hook-reviews
  const SUBMIT_FIELDS = ["id", "signature", "name", "repo", "commit", "description", "x", "telegram", "contact"];
  const answerOf = (r) => ({ id: r.id, status: r.status, statusText: statusText(r.status) });
  async function submit(body) {
    knownFields(body, SUBMIT_FIELDS);
    const id = checkId(body.id);
    const data = store.read();
    const existing = data.requests[id];
    if (existing) {
      // the same request sent again (the page lost the first answer): the same answer
      if (existing.paid && existing.paid.signature === body.signature) return { status: 200, body: answerOf(existing) };
      throw new ApiError(409, "QUOTE_USED", "This quote was used for a request already. Ask for a new quote.");
    }
    const q = data.quotes[id];
    if (!q) throw new ApiError(404, "QUOTE_NOT_FOUND", "No quote has this id. Ask for a new quote.");
    const fields = {
      name: checkName(body.name), repo: checkRepo(body.repo), commit: checkCommit(body.commit),
      description: checkDescription(body.description), x: checkXHandle(body.x), telegram: checkTelegramHandle(body.telegram), contact: checkContact(body.contact),
    };
    signatureBytes(body.signature);
    const signature = body.signature;
    if (Object.values(data.requests).some((r) => r.paid && r.paid.signature === signature)) {
      throw new ApiError(409, "SIGNATURE_USED", "This transaction paid for another request already.");
    }
    const tx = await rpc("transaction", () => conn().getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
    if (!tx) {
      // long after the quote ended, a payment that is still not there cannot count any more
      if (now() > Date.parse(q.expiresAt) + (EXPIRY_GRACE_SECONDS + 90) * 1000) throw new ApiError(410, "QUOTE_EXPIRED", "This quote ended and no payment for it is on chain. Ask for a new quote.");
      throw new ApiError(409, "NOT_CONFIRMED_YET", "The payment is not confirmed on chain yet. Send the request again in a few seconds.", { retryAfterSeconds: RETRY_AFTER_SECONDS });
    }
    const paid = checkPayment(q, tx, now());
    const t = iso();
    let created = false;
    const request = store.mutate((d) => {
      if (d.requests[id]) {
        if (d.requests[id].paid && d.requests[id].paid.signature === signature) return d.requests[id];
        throw new ApiError(409, "QUOTE_USED", "This quote was used for a request already. Ask for a new quote.");
      }
      if (Object.values(d.requests).some((r) => r.paid && r.paid.signature === signature)) throw new ApiError(409, "SIGNATURE_USED", "This transaction paid for another request already.");
      if (Object.keys(d.requests).length >= MAX_REQUESTS) throw new ApiError(503, "REVIEWS_FULL", "Programmable takes no new review requests right now. Write to Programmable.");
      const r = {
        id, wallet: q.wallet, ...fields,
        paid: { signature, lamports: paid.lamports, slot: paid.slot, blockTime: paid.blockTime },
        status: "waiting", note: "", program: null, report: null, createdAt: t, updatedAt: t,
        history: [{ at: t, status: "waiting", note: "Paid " + sol(paid.lamports) + " SOL." }],
      };
      d.requests[id] = r;
      delete d.quotes[id];
      created = true;
      return r;
    });
    if (created) {
      Promise.resolve().then(() => notify(paidMessage(request), "new paid review request " + request.id + ": " + request.name + ", " + request.repo + " at " + request.commit + ", " + sol(request.paid.lamports) + " SOL from " + request.wallet)).catch(() => {});
      return { status: 201, body: answerOf(request) };
    }
    return { status: 200, body: answerOf(request) };
  }

  function findRequest(id) {
    if (typeof id !== "string" || !ID_RE.test(id)) throw bad("id", "id must be the 16 characters of a request's id.");
    const r = store.read().requests[id];
    if (!r) throw new ApiError(404, "REQUEST_NOT_FOUND", "No review request has this id.");
    return r;
  }

  // ---- GET /hook-reviews/<id>
  function status(id) { return publicView(findRequest(id)); }

  // ---- POST /hook-reviews/<id>/program
  const OWN_PROGRAMS = new Set([SYSTEM_PROGRAM, ...Object.values(H.PROGRAMS).map((p) => p.toBase58())]);
  function giveProgram(id, body) {
    knownFields(body, ["program", "signature"]);
    const r = findRequest(id);
    const program = checkWallet(body.program, "program");
    if (OWN_PROGRAMS.has(program)) throw bad("program", "program is one of Programmable's own programs. Give the id of your hook program.");
    const sig = signatureBytes(body.signature);
    if (!verifyWalletSignature(r.wallet, programMessage(r.id, program), sig)) {
      throw new ApiError(403, "SIGNATURE_INVALID", "The signature is not the request wallet's signature of the text \"" + programMessage(r.id, program) + "\".");
    }
    const t = iso();
    let changed = false;
    const after = store.mutate((d) => {
      const cur = d.requests[r.id];
      if (!cur) throw new ApiError(404, "REQUEST_NOT_FOUND", "No review request has this id.");
      if (cur.status !== "passed" && cur.status !== "checking") {
        throw new ApiError(409, "WRONG_STATUS", "A program id can be given once the code passed the review. This request is " + cur.status + ": " + statusText(cur.status));
      }
      if (cur.status === "checking" && cur.program === program) return cur;
      cur.program = program; cur.status = "checking"; cur.updatedAt = t;
      cur.history = [...(Array.isArray(cur.history) ? cur.history : []), { at: t, status: "checking", note: "Program id given: " + program + "." }];
      changed = true;
      return cur;
    });
    if (changed) Promise.resolve().then(() => notify(programGivenMessage(after), "program id given for review request " + after.id + ": " + after.program + " (" + after.name + ", " + after.repo + " at " + after.commit + ")")).catch(() => {});
    return { id: after.id, status: after.status, statusText: statusText(after.status), program: after.program };
  }

  // ---- GET /hooks/approved
  async function approved() {
    const p = await platform();
    return { required: !!p.hookApprovalRequired, programs: (p.approvedHooks || []).map((k) => k.toBase58()), corrupt: !!p.approvedListCorrupt };
  }

  // ---- HTTP
  function routeOf(route, method) {
    if (route === "hook-reviews/price") return { name: "price", method: "GET", run: () => price() };
    if (route === "hook-reviews/quote") return { name: "quote", method: "POST", body: true, run: (b) => quote(b) };
    if (route === "hook-reviews") return { name: "submit", method: "POST", body: true, run: (b) => submit(b) };
    if (route === "hooks/approved") return { name: "approved", method: "GET", run: () => approved() };
    let m = /^hook-reviews\/([^/]+)\/program$/.exec(route);
    if (m) return { name: "program", method: "POST", body: true, run: (b) => giveProgram(m[1], b) };
    m = /^hook-reviews\/([^/]+)$/.exec(route);
    if (m) return { name: "status", method: "GET", run: () => status(m[1]) };
    return null;
  }

  /// Answers one request to /api/v1/<route>. Never throws: every failure is one JSON shape.
  async function handle(req, res, route) {
    const headers = {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*", "access-control-expose-headers": "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
    };
    const send = (code, body) => {
      if (res.headersSent) return;
      res.statusCode = code;
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(body === null ? "" : JSON.stringify(body));
    };
    try {
      const r = routeOf(String(route || ""), req.method);
      if (!r) throw new ApiError(404, "NOT_FOUND", "No such endpoint. The review routes are /api/v1/hook-reviews/price, /api/v1/hook-reviews/quote, /api/v1/hook-reviews, /api/v1/hook-reviews/<id>, /api/v1/hook-reviews/<id>/program and /api/v1/hooks/approved.");
      if (req.method === "OPTIONS") {
        headers["access-control-allow-methods"] = r.method + ", OPTIONS";
        headers["access-control-allow-headers"] = "Content-Type";
        headers["access-control-max-age"] = "86400";
        delete headers["content-type"];
        return send(204, null);
      }
      if (req.method !== r.method) { headers.allow = r.method + ", OPTIONS"; throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use " + r.method + " for this endpoint."); }
      const ipMode = opts.ipMode ?? settings().ipMode;
      const hit = limiters[r.name].check(clientIp(req.headers, req.socket && req.socket.remoteAddress, ipMode));
      if (hit.limit > 0) {
        headers["x-ratelimit-limit"] = String(hit.limit);
        headers["x-ratelimit-remaining"] = String(hit.remaining);
        headers["x-ratelimit-reset"] = String(hit.retryAfterSeconds);
      }
      if (!hit.ok) {
        headers["retry-after"] = String(hit.retryAfterSeconds);
        throw new ApiError(429, "RATE_LIMITED", "Too many requests. This address may make " + hit.limit + " of these calls a minute. Try again in " + hit.retryAfterSeconds + " seconds.");
      }
      const body = r.body ? parseJsonBody(await readBody(req)) : undefined;
      const out = await r.run(body);
      if (out && typeof out.status === "number" && out.body) return send(out.status, out.body);
      return send(200, out);
    } catch (e) {
      const { status: code, body } = errorResponse(e);
      if (code === 500) log("[hook-reviews] internal: " + String((e && e.message) || e).slice(0, 200));
      if (e instanceof ApiError && e.code === "NOT_CONFIRMED_YET") headers["retry-after"] = String(RETRY_AFTER_SECONDS);
      if (code === 413) headers.connection = "close";
      return send(code, body);
    }
  }

  return { handle, price, quote, submit, status, giveProgram, approved, store, feeUsd };
}

/// The body of a POST as text, at most MAX_REVIEW_BODY_BYTES (a description of 2,000
/// characters fits).
export async function readBody(req, max = MAX_REVIEW_BODY_BYTES) {
  const tooLarge = () => new ApiError(413, "BODY_TOO_LARGE", "The body is larger than " + max + " bytes.");
  if (Number((req.headers && req.headers["content-length"]) || 0) > max) throw tooLarge();
  if (req.readableEnded) {
    let b = req.body;
    if (Buffer.isBuffer(b)) b = b.toString("utf8");
    if (typeof b === "string") { if (Buffer.byteLength(b) > max) throw tooLarge(); return b; }
    if (b && typeof b === "object") return JSON.stringify(b);
    throw new ApiError(400, "INVALID_JSON", "Send a JSON object.");
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > max) { done = true; reject(tooLarge()); req.resume(); } else chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    req.on("error", () => { if (!done) { done = true; reject(new ApiError(400, "INVALID_JSON", "The body could not be read.")); } });
  });
}

let service = null;
/// The server's one service, made on the first request (web/serve.js).
export async function handleReviews(req, res, route) {
  if (!service) service = createReviewService();
  return service.handle(req, res, route);
}
