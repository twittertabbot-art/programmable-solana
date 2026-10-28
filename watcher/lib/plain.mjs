// Errors in words, for everything a reader sees: the site prints a pool's simulation errors, its alerts and its
// notes exactly as pools.json holds them.
//
// An RPC error as web3.js throws it can carry a whole JSON answer ("403 Forbidden: {"jsonrpc":"2.0",...}"), a
// chain error is a JSON object ({"InstructionError":[2,{"Custom":6008}]}), and an RPC address may carry its API key
// in the path or the query. So every such text passes here first: JSON fragments become the message they carry
// (or go), an address becomes its host, and the text is one line of at most 300 characters. A sentence without
// JSON and without an address comes back unchanged. Pure, tested offline.

const MAX = 300;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>()[\]{}]+/gi;

/// The host of an address (with its port), never its path or query, where an API key may live. "" when the text is
/// not an address.
export function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return ""; }
}

/// A chain error object in words. {"InstructionError":[2,{"Custom":6008}]} is "instruction 2: custom error 6008",
/// {"InsufficientFundsForRent":{"account_index":0}} is "InsufficientFundsForRent (account_index 0)", a string stays.
export function chainErrWords(err) {
  if (err === null || err === undefined) return "";
  if (typeof err === "string") return err;
  if (typeof err !== "object") return String(err);
  if (Array.isArray(err)) return err.map(chainErrWords).filter(Boolean).join(" ");
  if (Array.isArray(err.InstructionError) && err.InstructionError.length === 2) {
    const [idx, inner] = err.InstructionError;
    return `instruction ${idx}: ${innerWords(inner)}`;
  }
  const keys = Object.keys(err);
  if (keys.length === 1) {
    const k = keys[0]; const v = err[k];
    if (v === null || v === undefined) return k;
    if (typeof v !== "object") return `${k} ${v}`;
    if (Array.isArray(v)) return `${k} ${v.map((x) => (typeof x === "object" ? chainErrWords(x) : String(x))).join(" ")}`.trim();
    const parts = Object.entries(v).map(([a, b]) => (typeof b === "object" && b !== null ? `${a} ${chainErrWords(b)}` : `${a} ${b}`));
    return parts.length ? `${k} (${parts.join(", ")})` : k;
  }
  return keys.join(", ");
}

/// The error inside an instruction error: a name, a program's own number, or an object.
export function innerWords(inner) {
  if (typeof inner === "string") return inner;
  if (inner && typeof inner === "object" && inner.Custom !== undefined) return `custom error ${inner.Custom}`;
  return chainErrWords(inner);
}

/// The message a parsed JSON fragment carries: a JSON-RPC answer's error message, an object's message, a chain
/// error in words. An array (a list of log lines, say) carries nothing a reader needs.
function fragmentWords(v) {
  if (Array.isArray(v)) return "";
  if (!v || typeof v !== "object") return typeof v === "string" ? v : "";
  if (v.error && typeof v.error === "object" && typeof v.error.message === "string") return v.error.message;
  if (typeof v.error === "string") return v.error;
  if (typeof v.message === "string") return v.message;
  if ("jsonrpc" in v || "id" in v || "result" in v) return "";
  return chainErrWords(v);
}

/// The end of the balanced JSON fragment that starts at `i` (a "{" or a "["), or -1.
function fragmentEnd(s, i) {
  const open = s[i]; const close = open === "{" ? "}" : "]";
  let depth = 0; let inStr = false; let esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") { inStr = true; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return s[j] === close ? j : -1; }
  }
  return -1;
}

/// Every JSON fragment of a text replaced by the words it carries. A bracket that does not open valid JSON stays.
function replaceJson(s) {
  let out = ""; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "{" || c === "[") {
      const end = fragmentEnd(s, i);
      if (end > i) {
        const frag = s.slice(i, end + 1);
        let parsed; let ok = false;
        try { parsed = JSON.parse(frag); ok = true; } catch { ok = false; }
        if (ok && (typeof parsed === "object" && parsed !== null)) {
          // A bare list of numbers or words in a sentence ("[1, 2]") is no answer of anything: it stays.
          const plainList = Array.isArray(parsed) && parsed.every((x) => typeof x === "number");
          if (!plainList) { out += fragmentWords(parsed); i = end + 1; continue; }
        }
      }
    }
    out += c; i++;
  }
  return out;
}

/// Any text as a reader may see it: JSON fragments replaced by the message they carry, every address cut to its
/// host, one line, at most `max` characters. A sentence with neither comes back unchanged (bar extra spaces).
export function plainText(s, max = MAX) {
  if (s === null || s === undefined) return s;
  let t = String(s);
  // the common case, a sentence: untouched
  if (!/[[{]|:\/\/|\s\s|\n/.test(t) && t.length <= max) return t;
  t = t.replace(URL_RE, (u) => hostOf(u) || "the RPC");
  if (/[[{]/.test(t)) t = replaceJson(t);
  t = t.replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/([:,;])(?:\s*[:,;])+/g, "$1")
    .replace(/\.(?:\s*\.)+(?!\.)/g, ".")
    .replace(/\b(?:Logs|Message|Data):\s*(?=$|[.,;])/g, "")
    .replace(/[\s:;,]+$/, "")
    .trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/// The words of an HTTP status the RPC answered with.
const STATUS_WORDS = { 401: "refused the call (401 Unauthorized)", 403: "refused the call (403 Forbidden)", 404: "does not know this call (404 Not Found)", 413: "refused a request that was too large (413)", 429: "refused the call for now: too many requests (429)", 500: "failed on its side (500)", 502: "was not reachable through its gateway (502)", 503: "is not available right now (503)", 504: "did not answer in time (504)" };

/// An error as a short sentence for a reader: an HTTP refusal of the RPC in words, a JSON-RPC error by its message,
/// a network failure as "the RPC could not be reached", no JSON, no address, one line.
export function plainError(e, max = MAX) {
  const raw = e && typeof e === "object" && typeof e.message === "string" ? e.message : String(e);
  const http = /^\s*(\d{3}) ([A-Za-z][A-Za-z ]*?)\s*:\s*([\s\S]*)$/.exec(raw);
  if (http) {
    const code = Number(http[1]);
    const said = plainText(http[3], max);
    const head = `the RPC ${STATUS_WORDS[code] ?? `answered ${code} ${http[2].trim()}`}`;
    return plainText(said ? `${head}: ${said}` : head, max);
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(raw)) return "the RPC could not be reached";
  if (/aborted due to timeout|TimeoutError|timed out|ETIMEDOUT/i.test(raw)) return "the RPC did not answer in time";
  return plainText(raw, max);
}

/// Did the RPC refuse this method for good, as a shared node refuses a call it keeps for dedicated ones? Then
/// asking again soon only spends a request. A rate limit or a network failure is not such a refusal.
export function isRefusal(e) {
  const raw = e && typeof e === "object" && typeof e.message === "string" ? e.message : String(e);
  const code = e && typeof e === "object" ? e.code : undefined;
  if (code === -32601) return true;
  if (/^\s*(429|5\d\d)\b/.test(raw)) return false;
  if (/^\s*(401|403|404)\b/.test(raw)) return true;
  return /method not found|not available|only available|dedicated node|not supported|not allowed|disabled|forbidden/i.test(raw);
}
