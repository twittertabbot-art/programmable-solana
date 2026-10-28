// What GET /health answers: counts since the start. No address of any client is kept anywhere.

/// The process's memory, in whole megabytes: what the system sees (rss) and what the JavaScript heap
/// holds. The service runs under MemoryMax=150M.
function memoryMb() {
  const m = process.memoryUsage();
  return { rssMb: Math.round(m.rss / 1048576), heapUsedMb: Math.round(m.heapUsed / 1048576) };
}

export function createCounters(cfg) {
  const startedAt = new Date().toISOString();
  const c = {
    requests: { http: 0, items: 0, batches: 0, forwarded: 0, answered: 0 },
    refused: { origin: 0, method: 0, params: 0, rate: 0, rateSend: 0, rateDaily: 0, rateGlobal: 0, rateGlobalDaily: 0, bytes: 0, bytesGlobal: 0, answerSize: 0, body: 0, json: 0, batch: 0, path: 0 },
    upstream: { errors: 0, timeouts: 0, badStatus: 0, unreadable: 0, wsErrors: 0 },
    answers: { bytes: 0, largest: 0, cut: 0 },
    methods: {},
    ws: { total: 0, upstreamsOpened: 0, messages: 0, waited: 0, refusedConnections: 0, refusedFull: 0, refusedSubscriptions: 0, refusedMethod: 0, refusedRate: 0, refusedFrames: 0, methods: {} },
    // set by the WebSocket side: what is open right now, counted from the live connections
    wsLive: () => ({ open: 0, upstreams: 0, subscriptions: 0, pending: 0, waiting: 0 }),
  };
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  /// The JSON for /health. `addresses` is how many client addresses the limiter remembers right now.
  c.snapshot = (addresses = 0, now = Date.now()) => {
    const { methods: wsMethods, ...ws } = c.ws;
    return {
      ok: true,
      service: "programmable-rpc",
      startedAt,
      uptimeSeconds: Math.floor((now - Date.parse(startedAt)) / 1000),
      upstreamHost: cfg.upstreamHost,
      limits: {
        perMinute: cfg.ratePerMinute, burst: cfg.rateBurst, sendPerMinute: cfg.sendPerMinute, perDay: cfg.ratePerDay,
        globalPerMinute: cfg.globalPerMinute, globalPerDay: cfg.globalPerDay,
        bytesPerMinute: cfg.bytesPerMinute, globalBytesPerMinute: cfg.globalBytesPerMinute, globalBytesBurst: cfg.globalBytesBurst, answerBytes: cfg.maxAnswerBytes,
        batch: cfg.batchLimit, bodyBytes: cfg.bodyLimitBytes, upstreamTimeoutMs: cfg.upstreamTimeoutMs,
        wsConnectionsPerAddress: cfg.wsConnectionsPerIp, wsConnections: cfg.wsConnectionsMax, wsSubscriptionsPerConnection: cfg.wsSubscriptionsPerConnection,
        wsIdleSeconds: cfg.wsIdleSeconds, wsFramesPerMinute: cfg.wsFramesPerMinute,
        origins: [...cfg.allowedOrigins],
      },
      requests: { ...c.requests },
      refused: { ...c.refused },
      upstream: { ...c.upstream },
      answers: { ...c.answers },
      methods: sorted(c.methods),
      ws: { ...c.wsLive(), ...ws, methods: sorted(wsMethods) },
      addresses,
      memory: memoryMb(),
    };
  };
  /// One line for the journal.
  c.summary = () => {
    const r = Object.values(c.refused).reduce((a, b) => a + b, 0);
    const u = c.upstream.errors + c.upstream.timeouts + c.upstream.badStatus + c.upstream.unreadable;
    const live = c.wsLive();
    return "requests " + c.requests.http + " (" + c.requests.items + " items), refused " + r + ", upstream failures " + u
      + ", answers " + Math.round(c.answers.bytes / 1048576) + " MB (largest " + c.answers.largest + " bytes, cut " + c.answers.cut + ")"
      + ", websocket open " + live.open + " of " + c.ws.total + ", subscriptions " + live.subscriptions;
  };
  return c;
}
