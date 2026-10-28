// Review tool: a stand-in for the watcher's two feeds, for a site check on the local validator
// when the watcher itself is not running. It serves the shapes of FEED-CONTRACT.md (market.json
// and trades/<pool>.json) from plain SDK reads, made when asked (cached five seconds):
//   node web/review/feed-standin.mjs [--port 8791] [--rpc http://127.0.0.1:8899]
// It is not the watcher: it reads the chain on every request after the cache, keeps no state and
// reads at most 200 transactions of a pool. The site cannot tell the two apart, which is the point:
// a page fed by it must show what a page fed by the chain shows. Stop it by its process id.
import http from "node:http";
import { Connection, PublicKey } from "@solana/web3.js";
import { HookpoolClient, eventToJson, curveProgress, spotPrice, rulesPda, decodeTokenAmount, decodeLockRecord, PROGRAMS, SYSTEM_PROGRAM } from "../../sdk/dist/index.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const PORT = Number(opt("port", "8791"));
const conn = new Connection(opt("rpc", "http://127.0.0.1:8899"), "confirmed");
const client = new HookpoolClient(conn);
const cache = new Map();
const cached = async (key, fn) => { const c = cache.get(key); if (c && Date.now() - c.at < 5000) return c.value; const value = await fn(); cache.set(key, { at: Date.now(), value }); return value; };
const metaJson = new Map();
async function coinJson(uri) {
  if (!/^https?:\/\//i.test(uri || "")) return { status: "none" };
  if (metaJson.has(uri)) return metaJson.get(uri);
  let out = { status: "unreachable" };
  try { const r = await fetch(uri, { signal: AbortSignal.timeout(3000) }); try { out = { status: "ok", json: await r.json() }; } catch (_) { out = { status: "invalid" }; } } catch (_) {}
  metaJson.set(uri, out);
  return out;
}
const web = (v) => (typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? v.trim() : null);

async function market() {
  const pools = await client.allPools();
  const raw = new Map();
  for (let i = 0; i < pools.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(pools.slice(i, i + 100).map((p) => p.address));
    infos.forEach((a, j) => { if (a) raw.set(pools[i + j].address.toBase58(), a.data); });
  }
  const plat = await client.platform();
  const out = [];
  for (const p of pools) {
    const [md, mint] = await Promise.all([client.metadata(p.baseMint), client.mint(p.baseMint)]);
    const data = raw.get(p.address.toBase58());
    if (!data) continue;
    const j = await coinJson(md ? md.uri : "");
    const ext = j.json && typeof j.json.extensions === "object" ? j.json.extensions : {};
    const cp = mint && p.curveState !== 0 ? curveProgress(p, mint.supply) : null;
    let rules = null;
    if (p.hasHook && p.hookProgram.equals(PROGRAMS.hook_rules)) {
      const [cfg, lock, vault, clock] = await conn.getMultipleAccountsInfo([rulesPda.cfg(p.address), rulesPda.lock(p.address), rulesPda.lockVault(p.address), new PublicKey("SysvarC1ock11111111111111111111111111111111")]);
      const dv = new DataView(clock.data.buffer, clock.data.byteOffset);
      rules = cfg ? { config: Buffer.from(cfg.data).toString("base64"), strict: cfg.data[374] === 1, lockAmount: String(vault ? decodeTokenAmount(new Uint8Array(vault.data)) : 0n), lockUnlockAt: String(lock ? decodeLockRecord(new Uint8Array(lock.data)).unlockAt : 0n), readAt: new Date().toISOString(), slot: Number(dv.getBigUint64(0, true)), unixTime: Number(dv.getBigInt64(32, true)) } : null;
    }
    out.push({
      address: p.address.toBase58(), account: Buffer.from(data).toString("base64"), baseMint: p.baseMint.toBase58(), quoteMint: p.quoteMint.toBase58(), lpMint: p.lpMint.toBase58(),
      baseTokenProgram: p.baseTokenProgram.toBase58(), creator: p.creator.toBase58(), lpFeeBps: p.lpFeeBps, hasHook: p.hasHook, hookProgram: p.hookProgram.toBase58(),
      template: !p.hasHook ? "none" : (Object.entries({ rules: PROGRAMS.hook_rules, tax: PROGRAMS.hook_tax, launch_guard: PROGRAMS.hook_launch_guard, buyback: PROGRAMS.hook_buyback, collectible: PROGRAMS.hook_collectible }).find(([, k]) => k.equals(p.hookProgram)) || ["custom"])[0],
      reserveBase: String(p.reserveBase), reserveQuote: String(p.reserveQuote), virtualQuote: String(p.virtualQuote), swapCount: String(p.swapCount), createdSlot: String(p.createdSlot),
      curveState: ["none", "open", "graduated"][p.curveState] || "none", graduationTarget: String(p.graduationTarget),
      price: mint ? String(spotPrice(p, mint.decimals, 9)) : "0", marketCap: cp ? String(cp.marketCapQuote ?? 0n) : "0",
      coin: { mint: p.baseMint.toBase58(), name: md ? md.name : "", symbol: md ? md.symbol : "", uri: md ? md.uri : "",
        image: j.json && typeof j.json.image === "string" ? j.json.image : null, description: j.json && j.json.description ? String(j.json.description).slice(0, 500) : null,
        links: { website: web(ext.website || (j.json && j.json.website)), twitter: web(ext.twitter || (j.json && j.json.twitter)), telegram: web(ext.telegram || (j.json && j.json.telegram)) },
        metadataJson: j.status, decimals: mint ? mint.decimals : 0, supply: mint ? String(mint.supply) : "0", tokenProgram: mint ? mint.tokenProgram.toBase58() : "", mintAuthority: null, freezeAuthority: null },
      rules,
    });
  }
  out.sort((a, b) => (BigInt(b.createdSlot) > BigInt(a.createdSlot) ? 1 : BigInt(b.createdSlot) < BigInt(a.createdSlot) ? -1 : a.address < b.address ? -1 : 1));
  const slot = await conn.getSlot();
  const at = new Date().toISOString();
  return { version: 1, cluster: "localnet", updatedAt: at, slot, checkedAt: at, checkedSlot: slot, pools: out, platformFeeBps: plat ? plat.protocolFeeBps : 0 };
}
async function trades(pool) {
  const address = new PublicKey(pool);
  const slot = await conn.getSlot();
  const all = (await client.allEvents(address, 200)).filter((e) => ["Swapped", "CurveOpened", "Graduated"].includes(e.kind) && e.pool.equals(address));
  const opened = all.find((e) => e.kind === "CurveOpened") || null, graduated = all.find((e) => e.kind === "Graduated") || null;
  return { version: 1, pool, updatedAt: new Date().toISOString(), slot, backfill: { transactions: 200, reachedCreation: !!opened }, curve: { opened: opened && eventToJson(opened), graduated: graduated && eventToJson(graduated) }, events: all.slice(0, 300).map(eventToJson) };
}

http.createServer(async (req, res) => {
  const head = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=5", "Content-Type": "application/json; charset=utf-8" };
  try {
    const u = new URL(req.url, "http://x");
    let body;
    if (u.pathname === "/market.json") body = await cached("market", market);
    else { const m = /^\/trades\/([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(u.pathname); if (!m) { res.writeHead(404, head); res.end(JSON.stringify({ error: "not found" })); return; } body = await cached("t" + m[1], () => trades(m[1])); }
    res.writeHead(200, head); res.end(JSON.stringify(body));
  } catch (e) { res.writeHead(503, head); res.end(JSON.stringify({ error: String(e && e.message) })); }
}).listen(PORT, "127.0.0.1", () => console.log("feed stand-in on http://127.0.0.1:" + PORT + " (process " + process.pid + ")"));
