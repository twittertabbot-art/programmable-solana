// JSON-RPC 2.0 shapes: what a request must look like, and the error answers this proxy gives.

export const ERR = {
  PARSE: -32700,     // the body is not JSON
  INVALID: -32600,   // not a request, a batch too long, a body too large
  METHOD: -32601,    // a method the proxy does not pass on
  PARAMS: -32602,    // params the proxy does not pass on (getMultipleAccounts: repeated keys, over 100 keys)
  UPSTREAM: -32000,  // the upstream did not answer, or its answer was over the size cap
  RATE: -32029,      // too many requests (HTTP 429)
};

/// The most keys of one getMultipleAccounts. The validator refuses more itself; checked here so that
/// the request never leaves.
export const MULTIPLE_ACCOUNTS_MAX = 100;
/// How many times one getMultipleAccounts may name the same key. Twice, not once: the SDK's rules
/// view reads a strict coin's creator account and the wallet's in one call, and with no wallet
/// connected (or the creator's own) that is the same key twice. Twice costs no more than two
/// different keys; a hundred times is the 80 MB answer for one token.
export const MULTIPLE_ACCOUNTS_SAME_KEY_MAX = 2;

/// Params that make one item cost far more than one item: getMultipleAccounts with the same key many
/// times (one program's data account 100 times is an 80 MB answer for one token) or with more keys
/// than the validator takes. Returns the refusal message, or null when the params may go.
function paramsProblem(method, params) {
  if (method !== "getMultipleAccounts") return null;
  if (!Array.isArray(params) || !Array.isArray(params[0])) return "getMultipleAccounts takes a list of keys first";
  const keys = params[0];
  if (keys.length > MULTIPLE_ACCOUNTS_MAX) return "getMultipleAccounts takes at most " + MULTIPLE_ACCOUNTS_MAX + " keys";
  const seen = new Map();
  for (const k of keys) {
    if (typeof k !== "string") return "getMultipleAccounts takes keys as strings";
    const n = (seen.get(k) || 0) + 1;
    if (n > MULTIPLE_ACCOUNTS_SAME_KEY_MAX) return "getMultipleAccounts names the same key more than " + MULTIPLE_ACCOUNTS_SAME_KEY_MAX + " times";
    seen.set(k, n);
  }
  return null;
}

export function isObject(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }

/// The id of a request as the answer must carry it: a string, a number or null. Anything else
/// (missing, an object) is answered with null, as the specification says.
export function idOf(item) {
  if (isObject(item) && "id" in item) {
    const id = item.id;
    if (typeof id === "string" || typeof id === "number" || id === null) return id;
  }
  return null;
}

/// An error answer. The message is plain ASCII and never carries anything from the upstream.
export function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message: String(message).replace(/[^\x20-\x7e]/g, "?") } };
}

/// One request of a body, checked: { item, id, method, error, refusal }. `error` is the answer to
/// give instead of forwarding it (null when it may go to the upstream); `refusal` names the counter.
export function checkItem(item, cfg) {
  const id = idOf(item);
  if (!isObject(item) || typeof item.method !== "string") return { item, id, method: null, error: rpcError(id, ERR.INVALID, "invalid request"), refusal: "json" };
  if (item.params !== undefined && item.params !== null && typeof item.params !== "object") return { item, id, method: item.method, error: rpcError(id, ERR.INVALID, "params must be an array or an object"), refusal: "json" };
  if (!cfg.methods.has(item.method)) return { item, id, method: item.method, error: rpcError(id, ERR.METHOD, "method not allowed by this proxy: " + item.method.replace(/[^\x21-\x7e]/g, "?").slice(0, 64)), refusal: "method" };
  const problem = paramsProblem(item.method, item.params);
  if (problem) return { item, id, method: item.method, error: rpcError(id, ERR.PARAMS, "invalid params: " + problem), refusal: "params" };
  return { item, id, method: item.method, error: null, refusal: null };
}

/// A parsed body, checked. Either { ok: false, status, counter, body } (answer `body` with HTTP
/// `status`) or { ok: true, batch, entries } with one checkItem() entry per request.
export function checkBody(parsed, cfg) {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { ok: false, status: 400, counter: "json", body: rpcError(null, ERR.INVALID, "empty batch") };
    if (parsed.length > cfg.batchLimit) return { ok: false, status: 400, counter: "batch", body: rpcError(null, ERR.INVALID, "batch over " + cfg.batchLimit + " requests") };
    return { ok: true, batch: true, entries: parsed.map((item) => checkItem(item, cfg)) };
  }
  if (!isObject(parsed)) return { ok: false, status: 400, counter: "json", body: rpcError(null, ERR.INVALID, "a JSON-RPC request is an object or an array of objects") };
  return { ok: true, batch: false, entries: [checkItem(parsed, cfg)] };
}
