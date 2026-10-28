// Pure parts of the trade API (web/api/v1): input validation with bounds, slippage math,
// decimal formatting, the error shape, the wording of chain errors and the per-IP limiter.
// No imports and no chain access, so the unit tests run without a validator:
//   node --test web/api/_test/
// The chain side lives in web/api/_trade.js.

export const U64_MAX = 18446744073709551615n;
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 5000;
/// Highest priority fee a caller may ask for, in micro-lamports per compute unit. The
/// largest transaction asks for 600,000 units, so this is at most 0.003 SOL.
export const MAX_CU_PRICE = 5_000_000;
export const MAX_BODY_BYTES = 4096;
export const MAX_URL_LENGTH = 1024;

// ---- errors ----------------------------------------------------------------------------------

/// The only error the API shows to a caller. Anything else becomes INTERNAL with a fixed text.
export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    if (extra && typeof extra === "object") this.extra = extra;
  }
}

/// One shape for every failure: { error: { code, message } }. `parameter` is added on
/// INVALID_PARAMETER and `programError` when a program said why. Never a stack trace, a
/// file path or the text of an error this code did not write itself.
export function errorResponse(err) {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, ...(err.extra || {}) } } };
  }
  return { status: 500, body: { error: { code: "INTERNAL", message: "Something went wrong on our side. Try again." } } };
}

const bad = (parameter, message) => new ApiError(400, "INVALID_PARAMETER", message, { parameter });

// ---- public keys -------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));

/// Bytes of a base58 string, or null when a character is not base58 or it is longer than `max`.
export function base58Decode(s, max = 128) {
  if (typeof s !== "string" || s.length === 0 || s.length > max) return null;
  let n = 0n;
  for (const c of s) {
    const v = B58_INDEX.get(c);
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

/// True for a base58 string that decodes to exactly 32 bytes.
export function isPublicKey(s) {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  const b = base58Decode(s);
  return !!b && b.length === 32;
}

function publicKeyField(v, name) {
  if (!isPublicKey(v)) throw bad(name, name + " must be a base58 public key.");
  return v;
}

// ---- fields ------------------------------------------------------------------------------------

function amountField(v, name) {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,19}$/.test(v)) {
    throw bad(name, name + " must be a string of digits in raw units, greater than zero. No decimals, no leading zero.");
  }
  const n = BigInt(v);
  if (n > U64_MAX) throw bad(name, name + " is larger than a 64-bit amount.");
  return n;
}

function intField(v, name, min, max) {
  let n;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^(0|[1-9][0-9]{0,9})$/.test(v)) n = Number(v);
  else throw bad(name, name + " must be a whole number from " + min + " to " + max + ".");
  if (!Number.isInteger(n) || n < min || n > max) throw bad(name, name + " must be a whole number from " + min + " to " + max + ".");
  return n;
}

const QUOTE_FIELDS = ["mint", "pool", "side", "amount", "slippageBps", "userPublicKey"];
const SWAP_FIELDS = [...QUOTE_FIELDS, "recipient", "minOutAmount", "computeUnitPriceMicroLamports", "simulate", "mintDeposit"];
const SECRET_NAME = /^(private[_-]?key|secret[_-]?key|secret|key[_-]?pair|seed|seed[_-]?phrase|mnemonic)$/i;

function knownFields(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError(400, "INVALID_JSON", "Send a JSON object.");
  for (const k of Object.keys(input)) {
    if (SECRET_NAME.test(k)) throw bad(k, "Never send a private key. This API builds unsigned transactions. Sign them on your side.");
    if (!allowed.includes(k)) throw bad(k.slice(0, 40), "Unknown field. Allowed fields: " + allowed.join(", ") + ".");
  }
}

function common(input) {
  const hasMint = input.mint !== undefined;
  const hasPool = input.pool !== undefined;
  if (hasMint === hasPool) throw bad(hasMint ? "pool" : "mint", "Send mint or pool. One of them, not both.");
  const mint = hasMint ? publicKeyField(input.mint, "mint") : null;
  const pool = hasPool ? publicKeyField(input.pool, "pool") : null;
  if (input.side !== "buy" && input.side !== "sell") throw bad("side", "side must be buy or sell.");
  if (input.amount === undefined) throw bad("amount", "amount is missing.");
  const amount = amountField(input.amount, "amount");
  const slippageBps = input.slippageBps === undefined ? DEFAULT_SLIPPAGE_BPS : intField(input.slippageBps, "slippageBps", 0, MAX_SLIPPAGE_BPS);
  return { mint, pool, side: input.side, amount, slippageBps };
}

/// Fields of GET /api/v1/quote, validated. Throws ApiError 400. `userPublicKey` is optional
/// here: on a strict coin the quote then checks the coin's rules against that wallet.
export function parseQuoteParams(input) {
  knownFields(input, QUOTE_FIELDS);
  const out = common(input);
  if (input.userPublicKey !== undefined && input.userPublicKey !== null && input.userPublicKey !== "") out.userPublicKey = publicKeyField(input.userPublicKey, "userPublicKey");
  return out;
}

/// Fields of POST /api/v1/swap, validated. Throws ApiError 400.
export function parseSwapParams(input, opts = {}) {
  knownFields(input, SWAP_FIELDS);
  const out = common(input);
  if (input.userPublicKey === undefined) throw bad("userPublicKey", "userPublicKey is missing.");
  out.userPublicKey = publicKeyField(input.userPublicKey, "userPublicKey");
  out.recipient = input.recipient === undefined || input.recipient === null ? null : publicKeyField(input.recipient, "recipient");
  if (out.recipient === out.userPublicKey) out.recipient = null;
  out.minOutAmount = input.minOutAmount === undefined || input.minOutAmount === null ? null : amountField(input.minOutAmount, "minOutAmount");
  const maxPrice = Number.isInteger(opts.maxCuPrice) ? opts.maxCuPrice : MAX_CU_PRICE;
  out.computeUnitPriceMicroLamports = input.computeUnitPriceMicroLamports === undefined || input.computeUnitPriceMicroLamports === null
    ? 0 : intField(input.computeUnitPriceMicroLamports, "computeUnitPriceMicroLamports", 0, maxPrice);
  if (input.simulate !== undefined && typeof input.simulate !== "boolean") throw bad("simulate", "simulate must be true or false.");
  out.simulate = input.simulate === true;
  // a collectible buy pays the deposit for its NFTs in the same transaction unless the caller says false
  if (input.mintDeposit !== undefined && typeof input.mintDeposit !== "boolean") throw bad("mintDeposit", "mintDeposit must be true or false.");
  out.mintDeposit = input.mintDeposit !== false;
  return out;
}

/// The query string of a GET as a plain object. A field given twice is refused.
export function queryObject(searchParams) {
  const out = Object.create(null);   // no prototype: a field called __proto__ is a field like any other
  for (const [k, v] of searchParams) {
    if (Object.prototype.hasOwnProperty.call(out, k)) throw bad(k.slice(0, 40), "This field is given twice.");
    out[k] = v;
  }
  return out;
}

/// A request body as an object. Throws INVALID_JSON.
export function parseJsonBody(text) {
  let v;
  try { v = JSON.parse(text); } catch (_) { throw new ApiError(400, "INVALID_JSON", "The body is not JSON."); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ApiError(400, "INVALID_JSON", "Send a JSON object.");
  return v;
}

// ---- numbers -----------------------------------------------------------------------------------

/// The smallest output accepted after slippage: floor(out * (10000 - bps) / 10000).
export function minOutAfterSlippage(outAmount, slippageBps) {
  if (typeof outAmount !== "bigint" || outAmount < 0n) throw new Error("outAmount must be a non-negative bigint");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new Error("slippageBps out of range");
  return (outAmount * BigInt(10_000 - slippageBps)) / 10_000n;
}

/// num / den as a plain decimal string with `sig` significant digits, cut, not rounded.
/// No exponent form and no float on the way.
export function ratioDecimal(num, den, sig = 9) {
  if (den <= 0n || num < 0n) return "0";
  const SCALE = 36;
  let s = ((num * 10n ** BigInt(SCALE)) / den).toString().padStart(SCALE + 1, "0");
  const int = s.slice(0, s.length - SCALE);
  let frac = s.slice(s.length - SCALE);
  if (int !== "0") {
    frac = frac.slice(0, Math.max(0, sig - int.length));
  } else {
    const lead = frac.search(/[1-9]/);
    if (lead < 0) return "0";
    frac = frac.slice(0, lead + sig);
  }
  frac = frac.replace(/0+$/, "");
  return frac ? int + "." + frac : int;
}

/// Raw units as a decimal string of whole coins: 1500000 with 6 decimals is "1.5".
export function formatUnits(amount, decimals) {
  const s = amount.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? int + "." + frac : int;
}

/// Basis points as a percent string: 250 is "2.5", 100 is "1".
export function pctOfBps(bps) {
  const s = (bps / 100).toFixed(2);
  return s.replace(/\.?0+$/, "");
}

// ---- chain errors in words ---------------------------------------------------------------------

const ANCHOR = /Error Code: ([A-Za-z0-9_]+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/;
/// The rules program's errors of a strict coin that hold a trade: number, name, the API's code
/// and the sentence. Ask for a quote with userPublicKey to get the numbers of the wallet.
const STRICT_REFUSALS = {
  6044: ["MaxWallet", "MAX_WALLET_EXCEEDED", "This buy would leave the receiving wallet above the coin's max wallet. Ask for a quote with userPublicKey: it says how much the wallet can still receive."],
  6045: ["EarlyLocked", "EARLY_LOCKED", "Coins this wallet bought in the coin's first slots cannot leave it yet. Ask for a quote with userPublicKey: it says how much the wallet can sell now."],
  6046: ["CreatorLocked", "CREATOR_LOCKED", "The creator's locked coins cannot leave the creator's wallet before the unlock date. Ask for a quote with userPublicKey: it says how much the wallet can sell now."],
  6047: ["HolderRecordRequired", "HOLDER_RECORD_REQUIRED", "A buy in this coin's first slots needs a holder record of the wallet that receives the coins."],
};
/// The pool program's errors of a pool on the curve that a trade can meet: number, name, the API's code and
/// the sentence.
const CURVE_REFUSALS = {
  6049: ["CurveRealReserve", "CURVE_REAL_RESERVE", "This coin is on the curve. Its pool pays a sell from the real SOL it holds, and this sell would take more than that. Ask for a quote: it names the largest sell the pool pays now."],
  6048: ["GraduationNotReached", "SIMULATION_FAILED", "The pool fell back under its graduation target before this trade, so the graduate at the end of the transaction was refused. Ask for a new quote."],
};

/// What a failed simulation means, as { code, message, programError? }. `err` is the
/// `err` field of simulateTransaction and `logs` its log lines.
export function explainSimulationError(err, logs) {
  const lines = Array.isArray(logs) ? logs.filter((l) => typeof l === "string") : [];
  const has = (re) => lines.some((l) => re.test(l));
  const funds = (message) => ({ code: "INSUFFICIENT_FUNDS", message });
  if (err === "AccountNotFound") return funds("The wallet has no SOL on this cluster. It needs SOL for the trade and for the network fee.");
  if (err === "InsufficientFundsForFee") return funds("The wallet holds too little SOL to pay the network fee.");
  if (err && typeof err === "object" && "InsufficientFundsForRent" in err) {
    return funds("The trade would leave the wallet with too little SOL to stay open. Keep about 0.001 SOL in it, or trade a smaller amount.");
  }
  if (has(/insufficient funds for rent|insufficient lamports/i)) return funds("The wallet holds too little SOL for this trade. It pays the amount, the network fee and the rent of new token accounts.");
  let anchor = null;
  for (const l of lines) { const m = ANCHOR.exec(l); if (m) anchor = { name: m[1], number: Number(m[2]), text: m[3], line: l }; }
  if (anchor) {
    const programError = { name: anchor.name, number: anchor.number };
    // Error numbers and names are per program: a hook may have its own "Slippage". Only the
    // pool program's own errors get the pool's meaning.
    const pools = /programs\/hookpool\//.test(anchor.line);
    if (pools && anchor.name === "Slippage" && anchor.number === 6008) {
      return { code: "SLIPPAGE_EXCEEDED", message: "The price moved. The trade would give less than minOutAmount. Ask for a new quote, or raise slippageBps.", programError };
    }
    if (pools && anchor.name === "Paused" && anchor.number === 6000) return { code: "TRADING_PAUSED", message: "Trading is paused on Programmable.", programError };
    // The launch rules template refuses one thing in a swap: a buy above the coin's buy limit.
    // The API refuses such a buy before it builds; this is the same answer for an RPC node
    // that simulated at an earlier slot than the one the pool was read at.
    if (/programs\/hook_rules\//.test(anchor.line) && anchor.name === "BuyTooLarge" && anchor.number === 6017) {
      return { code: "BUY_LIMIT_EXCEEDED", message: "This coin has a buy limit and this buy is above it. Ask for a quote: its notes say the limit and when it ends.", programError };
    }
    // The four rules of a strict coin, which the rules program checks inside the transfer of
    // the coin. The API refuses them before it builds; these answer the same for an RPC node
    // that simulated at another slot than the one the pool was read at.
    const strict = /programs\/hook_rules\//.test(anchor.line) ? STRICT_REFUSALS[anchor.number] : null;
    if (strict && strict[0] === anchor.name) return { code: strict[1], message: strict[2], programError };
    // A pool on the curve. The API refuses such a sell before it builds; this is the same answer for an RPC
    // node that simulated after another trade. The second one fails the graduate at the end of a trade.
    const curve = pools ? CURVE_REFUSALS[anchor.number] : null;
    if (curve && curve[0] === anchor.name) return { code: curve[1], message: curve[2], programError };
    return { code: "SIMULATION_FAILED", message: "The program refused the trade: " + plain(anchor.text) + " (" + anchor.name + ").", programError };
  }
  if (has(/Error: insufficient funds/)) return funds("The wallet does not hold enough of the token it sends.");
  if (has(/exceeded CUs meter|Computational budget exceeded/i) || instructionError(err) === "ProgramFailedToComplete" || instructionError(err) === "ComputationalBudgetExceeded") {
    return { code: "SIMULATION_FAILED", message: "The transaction ran out of compute units." };
  }
  const ie = err && typeof err === "object" && Array.isArray(err.InstructionError) ? err.InstructionError : null;
  if (ie) {
    const what = typeof ie[1] === "string" ? ie[1] : ie[1] && typeof ie[1] === "object" && "Custom" in ie[1] ? "custom error " + Number(ie[1].Custom) : "an error";
    return { code: "SIMULATION_FAILED", message: "The chain refused the transaction. Instruction " + Number(ie[0]) + " failed with " + plain(what) + "." };
  }
  return { code: "SIMULATION_FAILED", message: "The chain refused the transaction" + (typeof err === "string" ? ": " + plain(err) + "." : ".") };
}

function instructionError(err) {
  const ie = err && typeof err === "object" && Array.isArray(err.InstructionError) ? err.InstructionError : null;
  return ie && typeof ie[1] === "string" ? ie[1] : null;
}

/// Text from a program log, cut down to plain ASCII words so nothing odd reaches a caller.
function plain(s) {
  return String(s).replace(/[^\x20-\x7E]/g, "").replace(/[<>"`\\]/g, "").slice(0, 160).trim();
}

/// Text of the SDK's quote errors, as an ApiError 422.
export function quoteError(e) {
  const m = e && typeof e.message === "string" ? e.message : "";
  if (/amount too small|greater than zero/.test(m)) return new ApiError(422, "CANNOT_QUOTE", "The amount is too small. Nothing would come out after the fees.");
  if (/not enough liquidity/.test(m)) return new ApiError(422, "CANNOT_QUOTE", "The pool does not hold enough liquidity for this trade.");
  return new ApiError(422, "CANNOT_QUOTE", "This trade cannot be quoted.");
}

// ---- abuse limits --------------------------------------------------------------------------------

/// A fixed-window counter per key, held in memory. `limit` 0 turns it off.
export function createRateLimiter({ limit, windowMs, maxKeys = 20_000, now = Date.now }) {
  const hits = new Map();
  const sweep = (t) => {
    for (const [k, e] of hits) if (e.reset <= t) hits.delete(k);
    // still full of live keys: drop the oldest tenth, so memory stays bounded under a flood
    if (hits.size >= maxKeys) { let n = Math.ceil(maxKeys / 10); for (const k of hits.keys()) { hits.delete(k); if (--n <= 0) break; } }
  };
  return {
    limit, windowMs,
    check(key) {
      if (!(limit > 0)) return { ok: true, limit: 0, remaining: 0, retryAfterSeconds: 0, resetAt: 0 };
      const t = now();
      let e = hits.get(key);
      if (!e || e.reset <= t) {
        if (!e && hits.size >= maxKeys) sweep(t);
        e = { count: 0, reset: t + windowMs };
        hits.set(key, e);
      }
      e.count++;
      return { ok: e.count <= limit, limit, remaining: Math.max(0, limit - e.count), retryAfterSeconds: Math.max(1, Math.ceil((e.reset - t) / 1000)), resetAt: e.reset };
    },
    size: () => hits.size,
  };
}

/// The address a request is counted under.
///   "direct": the socket address (the default; headers are not trusted)
///   "proxy":  the last entry of X-Forwarded-For, the one your own reverse proxy added
///   "vercel": X-Real-IP, which Vercel sets itself
export function clientIp(headers, remoteAddress, mode = "direct") {
  const h = headers || {};
  const one = (v) => String(Array.isArray(v) ? v[0] : v || "");
  if (mode === "vercel") {
    const real = one(h["x-real-ip"]).trim();
    if (real) return real.slice(0, 64);
    const first = one(h["x-forwarded-for"]).split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  if (mode === "proxy") {
    const parts = one(h["x-forwarded-for"]).split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return String(remoteAddress || "unknown").slice(0, 64);
}

/// A whole number from an environment variable, or the default when unset or malformed.
export function envInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!/^[0-9]{1,12}$/.test(String(value))) return fallback;
  const n = Number(value);
  return n < min || n > max ? fallback : n;
}
