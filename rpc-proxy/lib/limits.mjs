// Token buckets: per address for requests (a minute and a day), for sendTransaction, and for the bytes
// of the answers; the same for the whole proxy. A bucket holds at most `capacity` tokens and gains
// `perMinute` of them a minute, smoothly. A request takes one token per JSON-RPC item; a batch of 50
// takes 50. An answer takes one byte token per byte.
import net from "node:net";

export class Bucket {
  constructor(capacity, perMinute, now = Date.now()) {
    this.capacity = Math.max(1, capacity);
    this.perMs = Math.max(0, perMinute) / 60000;
    this.tokens = this.capacity;
    this.at = now;
  }
  refill(now) {
    if (now > this.at) { this.tokens = Math.min(this.capacity, this.tokens + (now - this.at) * this.perMs); this.at = now; }
  }
  /// Would `n` tokens be there right now?
  can(n = 1, now = Date.now()) { this.refill(now); return this.tokens >= n; }
  /// Take `n` tokens; false, and nothing taken, when they are not there.
  take(n = 1, now = Date.now()) {
    this.refill(now);
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
  /// Take `n` tokens whatever is there: the bucket may go below zero, and then refuses until it has
  /// refilled past zero again. For what is spent before it can be counted (the bytes of a streamed answer).
  spend(n, now = Date.now()) { this.refill(now); this.tokens -= n; return this.tokens >= 0; }
  /// Is the bucket full again (nothing left to remember)?
  full(now = Date.now()) { this.refill(now); return this.tokens >= this.capacity; }
  /// Seconds until `n` tokens are there, rounded up; 0 when they are.
  waitSeconds(n = 1, now = Date.now()) {
    this.refill(now);
    if (this.tokens >= n) return 0;
    if (this.perMs <= 0) return 60;
    return Math.ceil((n - this.tokens) / this.perMs / 1000);
  }
}

/// The eight groups of an IPv6 address, as numbers, or null when it is not one.
function ipv6Groups(text) {
  let s = text;
  let tail = [];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const p = v4.slice(1).map(Number);
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    s = s.slice(0, -v4[0].length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(":").map((g) => parseInt(g, 16)) : []);
  const left = part(halves[0]);
  const right = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - left.length - right.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? fill : 0).fill(0), ...right, ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/// The key a client address is charged under: an IPv4 address as it is (an IPv4-mapped IPv6 address
/// as its IPv4 address), an IPv6 address by its /64, the network one machine usually gets. Anything
/// else as it is.
export function addressKey(ip) {
  let s = String(ip === undefined || ip === null ? "" : ip).trim();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(s);
  if (mapped) return mapped[1];
  if (net.isIPv6(s)) {
    const g = ipv6Groups(s.toLowerCase());
    if (g) return g.slice(0, 4).map((x) => x.toString(16)).join(":") + "::/64";
  }
  return s;
}

/// The per-address table. An entry is { requests, sends, daily, bytes: Bucket, ws: number of open
/// WebSocket connections, seen: last use }. The table is kept in order of last use (a Map re-inserts
/// on every use), so the least recently used entry is the first one. An entry idle for `idleMs`, with no
/// connection and a full daily bucket, is dropped on prune(). At `maxEntries` a new address takes the
/// place of the least recently used one without a connection, at once: a flood of addresses cannot
/// fill the memory, and no request scans the table.
export class AddressTable {
  constructor({ ratePerMinute, rateBurst, sendPerMinute, ratePerDay = 20_000, bytesPerMinute = 50 * 1048576, idleMs = 600_000, maxEntries = 20_000 }) {
    this.ratePerMinute = ratePerMinute; this.rateBurst = rateBurst; this.sendPerMinute = sendPerMinute;
    this.ratePerDay = ratePerDay; this.bytesPerMinute = bytesPerMinute;
    this.idleMs = idleMs; this.maxEntries = maxEntries;
    this.map = new Map();
  }
  get size() { return this.map.size; }
  get(ip, now = Date.now()) {
    const key = addressKey(ip);
    let e = this.map.get(key);
    if (e) {
      this.map.delete(key);
      this.map.set(key, e);
      e.seen = now;
      return e;
    }
    if (this.map.size >= this.maxEntries) this.evict();
    e = {
      requests: new Bucket(this.rateBurst, this.ratePerMinute, now),
      sends: new Bucket(this.sendPerMinute, this.sendPerMinute, now),
      daily: new Bucket(this.ratePerDay, this.ratePerDay / 1440, now),
      bytes: new Bucket(this.bytesPerMinute, this.bytesPerMinute, now),
      ws: 0,
      seen: now,
    };
    this.map.set(key, e);
    return e;
  }
  /// Drop the least recently used entry that holds no connection. The entries with a connection are
  /// few (the proxy holds at most WS_CONNECTIONS_MAX), so this stops after a few steps.
  evict() {
    for (const [key, e] of this.map) {
      if (e.ws > 0) continue;
      this.map.delete(key);
      return true;
    }
    return false;
  }
  /// Drop the entries idle for `idleMs` with no connection and nothing left to remember (the daily
  /// bucket full again). From the front: the first entry used within `idleMs` ends the walk.
  prune(now = Date.now()) {
    for (const [key, e] of this.map) {
      if (now - e.seen <= this.idleMs) break;
      if (e.ws > 0) continue;
      if (e.daily.full(now)) this.map.delete(key);
    }
  }
}

/// Every budget in one place: the address table and the proxy's own buckets. charge() checks them all
/// and takes from all of them, or from none; chargeBytes() takes the bytes of an answer.
export function createLimits(cfg) {
  const table = new AddressTable(cfg);
  const global = {
    requests: new Bucket(cfg.globalPerMinute, cfg.globalPerMinute),
    daily: new Bucket(cfg.globalPerDay, cfg.globalPerDay / 1440),
    // its burst is smaller than its minute: it bounds the bytes streaming at the same moment, so many big
    // answers asked at once cannot all be in flight together
    bytes: new Bucket(cfg.globalBytesBurst || cfg.globalBytesPerMinute, cfg.globalBytesPerMinute),
  };
  const refusal = (counter, wait, text, status = 429) => ({ counter, wait: Math.max(1, Math.min(120, wait)), text: text + ", try again in " + Math.max(1, Math.min(120, wait)) + " s", status });

  /// Take `n` requests (`sends` of them sendTransaction) from `entry` and from the proxy. Returns null
  /// when taken, or the refusal { counter, wait, text, status } and nothing taken.
  function charge(entry, n, sends = 0, now = Date.now()) {
    if (!entry.requests.can(n, now)) return refusal("rate", entry.requests.waitSeconds(n, now), "too many requests from this address");
    if (sends && !entry.sends.can(sends, now)) return refusal("rateSend", entry.sends.waitSeconds(sends, now), "too many transactions from this address");
    if (!entry.daily.can(n, now)) return refusal("rateDaily", entry.daily.waitSeconds(n, now), "this address used its " + cfg.ratePerDay + " requests of the day");
    if (!entry.bytes.can(1, now)) return refusal("bytes", entry.bytes.waitSeconds(1, now), "this address read too many bytes this minute");
    if (!global.requests.can(n, now)) return refusal("rateGlobal", global.requests.waitSeconds(n, now), "the proxy is busy");
    if (!global.daily.can(n, now)) return refusal("rateGlobalDaily", global.daily.waitSeconds(n, now), "the proxy used its " + cfg.globalPerDay + " requests of the day");
    if (!global.bytes.can(1, now)) return refusal("bytesGlobal", global.bytes.waitSeconds(1, now), "the proxy is busy");
    entry.requests.take(n, now);
    if (sends) entry.sends.take(sends, now);
    entry.daily.take(n, now);
    global.requests.take(n, now);
    global.daily.take(n, now);
    return null;
  }

  /// Take the `n` bytes of an answer whose length is known, from `entry` and from the proxy, before any of
  /// it is sent. Null when taken, else the refusal and nothing taken.
  function chargeBytes(entry, n, now = Date.now()) {
    if (!entry.bytes.can(n, now)) return refusal("bytes", entry.bytes.waitSeconds(n, now), "this address read too many bytes this minute");
    if (!global.bytes.can(n, now)) return refusal("bytesGlobal", global.bytes.waitSeconds(n, now), "the proxy is busy");
    entry.bytes.take(n, now);
    global.bytes.take(n, now);
    return null;
  }

  /// Spend the `n` bytes of one piece of an answer whose length is not known, as it streams. The piece
  /// that overdraws a budget is not sent (the answer is cut there) but stays spent: the budget is in
  /// debt, and the next request of the address waits until it has refilled. Null while within budget.
  function spendBytes(entry, n, now = Date.now()) {
    const mine = entry.bytes.spend(n, now);
    const all = global.bytes.spend(n, now);
    if (!mine) return refusal("bytes", entry.bytes.waitSeconds(1, now), "this address read too many bytes this minute");
    if (!all) return refusal("bytesGlobal", global.bytes.waitSeconds(1, now), "the proxy is busy");
    return null;
  }

  return { table, global, charge, chargeBytes, spendBytes };
}

/// The client's address: behind Caddy (the socket is loopback) the LAST X-Forwarded-For entry, the one
/// Caddy added; anywhere else the socket's own address. A request from the internet cannot pick its
/// address: Caddy appends the real one after whatever the request carried.
export function clientAddress(req) {
  const sock = String((req.socket && req.socket.remoteAddress) || "");
  if (/^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(sock)) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1].slice(0, 64);
  }
  return sock || "unknown";
}
