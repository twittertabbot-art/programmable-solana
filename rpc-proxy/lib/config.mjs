// Settings, read from the environment. Every value has a default except UPSTREAM_RPC.
// Nothing here prints a value: the upstream address carries the provider's key.

/// The JSON-RPC methods the site and the SDK call over HTTP (web/*.js, sdk/src). web3.js names a few
/// of them differently: getMultipleAccountsInfo is getMultipleAccounts, getSignatureStatus is
/// getSignatureStatuses, sendRawTransaction is sendTransaction, getAddressLookupTable is getAccountInfo.
/// confirmTransaction polls getBlockHeight and reads getSignatureStatuses once its subscription is up.
export const DEFAULT_METHODS = [
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance",
  "getTokenAccountBalance", "getTokenAccountsByOwner",
  "getLatestBlockhash", "getBlockHeight", "getSlot", "getEpochInfo",
  "getSignatureStatuses", "getSignaturesForAddress", "getTransaction",
  "simulateTransaction", "sendTransaction",
  "getMinimumBalanceForRentExemption", "getFeeForMessage",
  "getVersion", "getHealth",
];

/// What the pages send on the WebSocket: confirmTransaction subscribes to one signature and
/// unsubscribes; web3.js sends a "ping" notification every 5 seconds to keep the socket open.
export const DEFAULT_WS_METHODS = ["signatureSubscribe", "signatureUnsubscribe", "ping"];

/// The site's own addresses: the only browser origins the proxy serves.
export const DEFAULT_ALLOWED_ORIGINS = ["https://programmableonsol.com", "https://www.programmableonsol.com"];

const MB = 1024 * 1024;

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 8797,
  wsPort: 0,
  ratePerMinute: 60,
  rateBurst: 120,
  sendPerMinute: 10,
  globalPerMinute: 1500,
  ratePerDay: 20_000,
  globalPerDay: 600_000,
  bytesPerMinute: 50 * MB,
  globalBytesPerMinute: 200 * MB,
  globalBytesBurst: 32 * MB,
  maxAnswerBytes: 8 * MB,
  bodyLimitBytes: 65536,
  batchLimit: 50,
  upstreamTimeoutMs: 20000,
  wsConnectionsPerIp: 4,
  wsConnectionsMax: 200,
  wsSubscriptionsPerConnection: 20,
  wsIdleSeconds: 60,
  wsFramesPerMinute: 120,
  summaryEverySeconds: 300,
};

/// One origin as a browser sends it: scheme, host and an optional port, lower case, no path. "*" is
/// every origin (for a run by hand only).
function origins(raw) {
  const s = String(raw === undefined || raw === null ? "" : raw).trim();
  const items = s ? s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) : [...DEFAULT_ALLOWED_ORIGINS];
  const out = new Set();
  for (const item of items) {
    if (item === "*") { out.add("*"); continue; }
    const o = item.replace(/\/+$/, "").toLowerCase();
    if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(o) && !/^https?:\/\/\[[0-9a-f:.]+\](:\d{1,5})?$/.test(o)) throw new Error("ALLOWED_ORIGINS: each entry is a scheme and a host only, like https://example.com (or * for every origin)");
    out.add(o);
  }
  return out;
}

/// The WebSocket address web3.js derives from an HTTP address: ws for http, wss for https, the port
/// plus one when the address names a port, the same path. A validator on 8899 listens on 8900; a
/// provider behind a reverse proxy takes the upgrade on the same address.
export function deriveWsUrl(httpUrl) {
  const u = new URL(httpUrl);
  const out = new URL(httpUrl);
  out.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (u.port) out.port = String(Number(u.port) + 1);
  return out.href;
}

function num(raw, dflt, min, max) {
  const s = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!s) return dflt;
  const n = Number(s);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function list(raw, dflt) {
  const s = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!s) return [...dflt];
  return [...new Set(s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
}

/// The host of an address, never its path or query (a provider's key sits there).
export function hostOf(url) {
  try { return new URL(url).host || "the upstream"; } catch (_) { return "the upstream"; }
}

/// Build the settings from an environment object. Throws a plain sentence when UPSTREAM_RPC is
/// missing or not an http(s) address; the sentence never repeats the value.
export function loadConfig(env = process.env) {
  const upstream = String(env.UPSTREAM_RPC || "").trim();
  if (!upstream) throw new Error("UPSTREAM_RPC is not set. Put the provider's HTTP address in the environment file.");
  let u;
  try { u = new URL(upstream); } catch (_) { throw new Error("UPSTREAM_RPC is not a URL."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("UPSTREAM_RPC must start with http:// or https://.");
  let upstreamWs = String(env.UPSTREAM_WS || "").trim();
  if (upstreamWs) {
    let w;
    try { w = new URL(upstreamWs); } catch (_) { throw new Error("UPSTREAM_WS is not a URL."); }
    if (!/^wss?:$/.test(w.protocol)) throw new Error("UPSTREAM_WS must start with ws:// or wss://.");
    upstreamWs = w.href;
  } else {
    upstreamWs = deriveWsUrl(u.href);
  }
  // a provider that only serves requests carrying an allowed browser origin (an origin lock) needs
  // the proxy to send that origin itself: the site's own, which the lock allows
  const upstreamOrigin = String(env.UPSTREAM_ORIGIN || "").trim();
  if (upstreamOrigin && !/^https?:\/\/[^\s\/]+$/i.test(upstreamOrigin)) throw new Error("UPSTREAM_ORIGIN must be a scheme and host only, like https://example.com");
  const cfg = {
    upstreamRpc: u.href,
    upstreamWs,
    upstreamOrigin,
    upstreamHost: u.host,
    host: String(env.HOST || DEFAULTS.host).trim() || DEFAULTS.host,
    port: num(env.PORT, DEFAULTS.port, 0, 65535),
    wsPort: num(env.WS_PORT, DEFAULTS.wsPort, 0, 65535),
    ratePerMinute: num(env.RATE_PER_MINUTE, DEFAULTS.ratePerMinute, 1, 1_000_000),
    rateBurst: num(env.RATE_BURST, DEFAULTS.rateBurst, 1, 1_000_000),
    sendPerMinute: num(env.SEND_PER_MINUTE, DEFAULTS.sendPerMinute, 1, 1_000_000),
    globalPerMinute: num(env.GLOBAL_PER_MINUTE, DEFAULTS.globalPerMinute, 1, 100_000_000),
    ratePerDay: num(env.RATE_PER_DAY, DEFAULTS.ratePerDay, 1, 1_000_000_000),
    globalPerDay: num(env.GLOBAL_PER_DAY, DEFAULTS.globalPerDay, 1, 1_000_000_000),
    bytesPerMinute: num(env.BYTES_PER_MINUTE, DEFAULTS.bytesPerMinute, 1024, 64 * 1024 * MB),
    globalBytesPerMinute: num(env.GLOBAL_BYTES_PER_MINUTE, DEFAULTS.globalBytesPerMinute, 1024, 64 * 1024 * MB),
    globalBytesBurst: num(env.GLOBAL_BYTES_BURST, DEFAULTS.globalBytesBurst, 1024, 64 * 1024 * MB),
    maxAnswerBytes: num(env.MAX_ANSWER_BYTES, DEFAULTS.maxAnswerBytes, 1024, 1024 * MB),
    bodyLimitBytes: num(env.BODY_LIMIT_BYTES, DEFAULTS.bodyLimitBytes, 1024, 16 * 1024 * 1024),
    batchLimit: num(env.BATCH_LIMIT, DEFAULTS.batchLimit, 1, 1000),
    upstreamTimeoutMs: num(env.UPSTREAM_TIMEOUT_MS, DEFAULTS.upstreamTimeoutMs, 1000, 600_000),
    wsConnectionsPerIp: num(env.WS_CONNECTIONS_PER_IP, DEFAULTS.wsConnectionsPerIp, 1, 10_000),
    wsConnectionsMax: num(env.WS_CONNECTIONS_MAX, DEFAULTS.wsConnectionsMax, 1, 100_000),
    wsSubscriptionsPerConnection: num(env.WS_SUBSCRIPTIONS_PER_CONNECTION, DEFAULTS.wsSubscriptionsPerConnection, 1, 10_000),
    wsIdleSeconds: num(env.WS_IDLE_SECONDS, DEFAULTS.wsIdleSeconds, 1, 86_400),
    wsFramesPerMinute: num(env.WS_FRAMES_PER_MINUTE, DEFAULTS.wsFramesPerMinute, 10, 1_000_000),
    summaryEverySeconds: num(env.SUMMARY_EVERY_SECONDS, DEFAULTS.summaryEverySeconds, 0, 86_400),
    methods: new Set(list(env.METHODS, DEFAULT_METHODS)),
    wsMethods: new Set(list(env.WS_METHODS, DEFAULT_WS_METHODS)),
    allowedOrigins: origins(env.ALLOWED_ORIGINS),
  };
  if (cfg.rateBurst < cfg.ratePerMinute) cfg.rateBurst = cfg.ratePerMinute;
  // an answer the byte budget could never hold would be refused every time
  if (cfg.bytesPerMinute < cfg.maxAnswerBytes) cfg.bytesPerMinute = cfg.maxAnswerBytes;
  if (cfg.globalBytesPerMinute < cfg.bytesPerMinute) cfg.globalBytesPerMinute = cfg.bytesPerMinute;
  // the bytes the whole proxy may stream at once: always room for one answer at the cap
  if (cfg.globalBytesBurst < cfg.maxAnswerBytes) cfg.globalBytesBurst = cfg.maxAnswerBytes;
  if (cfg.globalPerDay < cfg.ratePerDay) cfg.globalPerDay = cfg.ratePerDay;
  // every string that must never appear in a log line or an answer: the two addresses, and whatever
  // follows the host in each (the key, when the provider puts it in the path or the query)
  const secrets = new Set([cfg.upstreamRpc, cfg.upstreamWs]);
  for (const href of [cfg.upstreamRpc, cfg.upstreamWs]) {
    const x = new URL(href);
    const tail = x.pathname + x.search;
    if (tail.length > 1) secrets.add(tail);
    if (x.search.length > 1) secrets.add(x.search);
    if (x.pathname.length > 1) secrets.add(x.pathname);
    for (const part of x.pathname.split("/")) if (part.length >= 8) secrets.add(part);
    for (const [, v] of x.searchParams) if (v.length >= 8) secrets.add(v);
    if (x.username) secrets.add(x.username);
    if (x.password) secrets.add(x.password);
  }
  cfg.secrets = [...secrets].sort((a, b) => b.length - a.length);
  return cfg;
}

/// One line that says what runs, with the upstream named by its host only.
export function describeConfig(cfg) {
  const mb = (n) => (Math.round(n / MB * 10) / 10) + " MB";
  return "upstream " + cfg.upstreamHost + ", listening on " + cfg.host + ":" + cfg.port
    + (cfg.wsPort ? " (WebSocket also on " + cfg.wsPort + ")" : "")
    + ", origins " + [...cfg.allowedOrigins].join(" ") + " (and requests without an Origin)"
    + ", " + cfg.ratePerMinute + "/min per address (burst " + cfg.rateBurst + ", sendTransaction " + cfg.sendPerMinute + "/min, " + cfg.ratePerDay + "/day), "
    + cfg.globalPerMinute + "/min in all (" + cfg.globalPerDay + "/day), answers up to " + mb(cfg.maxAnswerBytes) + ", "
    + mb(cfg.bytesPerMinute) + "/min per address and " + mb(cfg.globalBytesPerMinute) + "/min in all (" + mb(cfg.globalBytesBurst) + " at once), "
    + "batches up to " + cfg.batchLimit + ", bodies up to " + cfg.bodyLimitBytes + " bytes, "
    + cfg.methods.size + " methods, WebSocket " + cfg.wsConnectionsPerIp + " connections per address (" + cfg.wsConnectionsMax + " in all) and "
    + cfg.wsSubscriptionsPerConnection + " subscriptions each";
}
