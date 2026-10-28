// market.json (lib/market.mjs) and the shared pool list (lib/pools.mjs), offline: pools and coins built byte by
// byte, the metadata JSON from a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAMS, ACCOUNT_DISC, TOKEN_2022_PROGRAM, CLOCK_SYSVAR, pda, rulesPda, decodePool, decodeRulesConfig, curveProgress, spotPrice } from "../../sdk/dist/index.js";
import {
  marketEntry, buildMarket, coinPart, metaFromJson, imageAddress, webAddress, privateHost, metadataUrl, fetchMetadataJson, nextJsonTry, ratioDecimal, Market,
  MAX_DATA_IMAGE, RETRY_SOON_MS, RETRY_LATER_MS,
} from "../lib/market.mjs";
import { PoolCache } from "../lib/pools.mjs";
import { poolBytes, rulesConfig, splMintBytes, metaplexMetadataBytes, tokenAccountBytes, clockBytes, BASE_MINT, OWNER, TOKEN_PROGRAM } from "./bytes.mjs";

const key = () => Keypair.generate().publicKey;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "market-test-"));
const POOL_FIELDS = ["address", "account", "baseMint", "quoteMint", "lpMint", "baseTokenProgram", "creator", "lpFeeBps", "hasHook", "hookProgram", "hookKind", "hookFlags", "template", "pegged",
  "reserveBase", "reserveQuote", "virtualQuote", "volumeQuoteTotal", "hookFeesQuoteTotal", "swapCount", "createdSlot", "createdTime", "lastTradeTime", "curveState", "graduationTarget", "graduationFeeBps",
  "curve", "price", "marketCap", "coin", "rules"];
const COIN_FIELDS = ["mint", "name", "symbol", "uri", "image", "description", "links", "metadataJson", "decimals", "supply", "tokenProgram", "mintAuthority", "freezeAuthority"];

function pool(o = {}) {
  const address = o.address ?? key();
  const bytes = poolBytes(o);
  return { pool: decodePool(address, bytes), bytes };
}
const coin = (o = {}) => ({ name: "Coin", symbol: "CN", uri: "https://x.example/c.json", decimals: 6, supply: "1000000000000000", tokenProgram: TOKEN_PROGRAM.toBase58(), mintAuthority: null, freezeAuthority: null, json: { status: "ok", image: "https://x.example/c.png", description: "words", links: { website: "https://x.example", twitter: null, telegram: null } }, ...o });

test("an entry carries every field of the contract, the pool account as read, and numbers that equal the SDK's", () => {
  const { pool: p, bytes } = pool({ reserveBase: 800_000_000_000_000n, reserveQuote: 2_000_000_000n, virtualQuote: 30_000_000_000n, graduationTarget: 85_000_000_000n, curveState: 1, createdSlot: 4242n });
  const e = marketEntry({ pool: p, bytes, coin: coin(), info: { createdTime: 1_760_000_000, lastTradeTime: 1_760_000_100 } });
  assert.deepEqual(Object.keys(e), POOL_FIELDS);
  assert.deepEqual(Object.keys(e.coin), COIN_FIELDS);
  // the account decodes back to the very same pool
  const again = decodePool(new PublicKey(e.address), new Uint8Array(Buffer.from(e.account, "base64")));
  assert.deepEqual(JSON.stringify(again, (_, v) => (typeof v === "bigint" ? v.toString() : v)), JSON.stringify(p, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.deepEqual([e.reserveBase, e.reserveQuote, e.virtualQuote, e.createdSlot, e.curveState, e.graduationTarget, e.template, e.hookKind, e.pegged], ["800000000000000", "2000000000", "30000000000", "4242", "open", "85000000000", "none", "none", false]);
  assert.deepEqual([e.createdTime, e.lastTradeTime], [1_760_000_000, 1_760_000_100]);
  // the market cap is the SDK's curveProgress figure, to the unit; the price is the trade API's decimal
  const supply = 1_000_000_000_000_000n;
  assert.equal(e.marketCap, curveProgress(p, supply).marketCapQuote.toString());
  assert.equal(e.price, ratioDecimal((p.reserveQuote + p.virtualQuote) * 10n ** 6n, p.reserveBase * 10n ** 9n));
  assert.ok(Math.abs(Number(e.price) - spotPrice(p, 6, 9)) / spotPrice(p, 6, 9) < 1e-8);
  assert.deepEqual(e.curve, { state: "open", virtualQuote: "30000000000", raised: "2000000000", target: "85000000000", raisedBps: 235, soldBps: 2000, graduationFeeBps: 0, graduates: false });
  assert.deepEqual([e.coin.name, e.coin.image, e.coin.links.website, e.coin.metadataJson, e.coin.supply], ["Coin", "https://x.example/c.png", "https://x.example", "ok", "1000000000000000"]);
  // a seeded pool: no curve; a coin that was never read: the fields are there, empty or null
  const seeded = marketEntry({ pool: pool().pool, bytes: null, coin: null });
  assert.deepEqual([seeded.curve, seeded.account, seeded.marketCap, seeded.price, seeded.coin.metadataJson, seeded.coin.decimals, seeded.coin.name], [null, null, "0", "0", "pending", null, ""]);
  assert.deepEqual(Object.keys(seeded.coin), COIN_FIELDS);
});

test("the file: newest pool first, the contract's top fields", () => {
  const a = marketEntry({ pool: pool({ createdSlot: 10n }).pool, bytes: null, coin: coin() });
  const b = marketEntry({ pool: pool({ createdSlot: 30n }).pool, bytes: null, coin: coin() });
  const c = marketEntry({ pool: pool({ createdSlot: 20n }).pool, bytes: null, coin: coin() });
  const m = buildMarket({ cluster: "localnet", updatedAt: "u", slot: 5, checkedAt: "c", checkedSlot: 6, entries: [a, b, c] });
  assert.deepEqual(Object.keys(m), ["version", "cluster", "updatedAt", "slot", "checkedAt", "checkedSlot", "pools"]);
  assert.deepEqual(m.pools.map((x) => x.createdSlot), ["30", "20", "10"]);
});

test("what a card takes from the metadata JSON: a picture, a description, three links; nothing else", () => {
  const j = metaFromJson({ image: " https://img.example/a.png ", description: "a\u0000b ".repeat(300), extensions: { website: "https://site.example", twitter: "javascript:alert(1)" }, telegram: "https://t.me/x", other: "x" });
  assert.equal(j.image, "https://img.example/a.png");
  assert.equal(j.description.length, 500);
  assert.ok(!j.description.includes("\u0000"));
  assert.deepEqual(j.links, { website: "https://site.example", twitter: null, telegram: "https://t.me/x" });
  assert.equal(imageAddress("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(imageAddress("data:image/png;base64," + "A".repeat(MAX_DATA_IMAGE)), null, "a large inline picture stays out of market.json");
  assert.equal(imageAddress("ipfs://abc"), null);
  assert.equal(webAddress("ftp://x"), null);
  assert.deepEqual(metaFromJson(null), { image: null, description: null, links: { website: null, twitter: null, telegram: null } });
});

test("addresses the watcher does not fetch on a server: the machine, its network, link-local; localnet allows them", () => {
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "[::1]", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "metadata.google.internal", "x.local"]) assert.equal(privateHost(h), true, h);
  for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "arweave.net", "2606:4700::1"]) assert.equal(privateHost(h), false, h);
  assert.equal(metadataUrl("http://169.254.169.254/latest/meta-data/"), null);
  assert.equal(metadataUrl("http://user:pw@example.com/a.json"), null);
  assert.equal(metadataUrl("file:///etc/passwd"), null);
  assert.equal(metadataUrl("http://localhost:8787/x.json", { allowPrivate: true }).host, "localhost:8787");
  assert.equal(metadataUrl("https://example.com/a.json").href, "https://example.com/a.json");
});

test("fetching a metadata JSON: a timeout, a size cap, redirects checked, plain answers", async () => {
  const res = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, body: null, text: async () => body });
  const at = (map) => async (url) => { const r = map[url]; if (!r) throw new Error("no route"); return r; };
  assert.deepEqual(await fetchMetadataJson("https://a.example/m.json", { fetchImpl: at({ "https://a.example/m.json": res(200, JSON.stringify({ image: "https://a.example/i.png" })) }) }), { status: "ok", image: "https://a.example/i.png", description: null, links: { website: null, twitter: null, telegram: null } });
  assert.equal((await fetchMetadataJson("https://a.example/m.json", { fetchImpl: at({ "https://a.example/m.json": res(404, "") }) })).status, "unreachable");
  assert.equal((await fetchMetadataJson("https://a.example/m.json", { fetchImpl: at({ "https://a.example/m.json": res(200, "<html>") }) })).status, "invalid");
  assert.equal((await fetchMetadataJson("https://a.example/m.json", { fetchImpl: at({ "https://a.example/m.json": res(200, "[1,2]") }) })).status, "invalid");
  assert.equal((await fetchMetadataJson("https://a.example/m.json", { maxBytes: 10, fetchImpl: at({ "https://a.example/m.json": res(200, JSON.stringify({ image: "https://a.example/i.png" })) }) })).status, "unreachable");
  assert.equal((await fetchMetadataJson("https://a.example/m.json", { fetchImpl: async () => { throw new Error("timeout"); } })).status, "unreachable");
  // a redirect to the machine itself is refused; one to another public host is followed
  assert.equal((await fetchMetadataJson("https://a.example/m.json", { fetchImpl: at({ "https://a.example/m.json": res(302, "", { location: "http://127.0.0.1:8790/health" }) }) })).status, "invalid");
  const hop = await fetchMetadataJson("https://a.example/m.json", { fetchImpl: at({ "https://a.example/m.json": res(301, "", { location: "https://b.example/m.json" }), "https://b.example/m.json": res(200, "{}") }) });
  assert.equal(hop.status, "ok");
  assert.equal((await fetchMetadataJson("ipfs://x")).status, "none");
  assert.deepEqual([nextJsonTry(1, 0), nextJsonTry(2, 0), nextJsonTry(9, 0)], [RETRY_SOON_MS, RETRY_LATER_MS, RETRY_LATER_MS]);
});

/// A chain of accounts in memory that counts its batched reads.
function fakeChain(accounts) {
  const calls = [];
  return {
    calls,
    async getMultipleAccountsInfoAndContext(keys) { calls.push(keys.length); return { context: { slot: 77 }, value: keys.map((k) => accounts.get(k.toBase58()) ?? null) }; },
  };
}

test("the market reads a coin once, a changed pool's supply again, every mint on its clock, and nothing when idle", async () => {
  const dir = tmpDir();
  const accounts = new Map();
  const mintA = key(); const mintB = key();
  const put = (k, owner, data) => accounts.set(k.toBase58(), { owner, data: Buffer.from(data), lamports: 1, executable: false });
  put(mintA, TOKEN_PROGRAM, splMintBytes({ supply: 1_000n, decimals: 6 }));
  put(pda.metadata(mintA), new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"), metaplexMetadataBytes({ mint: mintA, name: "Alpha", symbol: "ALP", uri: "https://a.example/a.json" }));
  put(mintB, TOKEN_PROGRAM, splMintBytes({ supply: 2_000n, decimals: 9 }));
  const chain = fakeChain(accounts);
  let now = Date.parse("2026-10-20T12:00:00Z");
  const fetched = [];
  const market = new Market({ connection: chain, cluster: "mainnet", file: path.join(dir, "market.json"), cacheFile: path.join(dir, "cache.json"), now: () => now, mintRefreshMs: 600_000, fetchJson: async (uri) => { fetched.push(uri); return { status: "ok", image: "https://a.example/p.png", description: null, links: { website: null, twitter: null, telegram: null } }; } });
  const A = pool({ baseMint: mintA }); const B = pool({ baseMint: mintB });
  const bytes = new Map([[A.pool.address.toBase58(), A.bytes], [B.pool.address.toBase58(), B.bytes]]);
  const pools = [A.pool, B.pool];
  // first: both coins, metadata and mint, in one batched read; the one uri read
  let r = await market.refresh({ pools, bytes, slot: 10 });
  assert.deepEqual([chain.calls, r.coins, fetched], [[4], 2, ["https://a.example/a.json"]]);
  let m = market.build({ pools, bytes, slot: 10, updatedAt: "u", checkedAt: "c", checkedSlot: 10 });
  const ea = m.pools.find((x) => x.baseMint === mintA.toBase58());
  const eb = m.pools.find((x) => x.baseMint === mintB.toBase58());
  assert.deepEqual([ea.coin.name, ea.coin.symbol, ea.coin.supply, ea.coin.decimals, ea.coin.image, ea.coin.metadataJson], ["Alpha", "ALP", "1000", 6, "https://a.example/p.png", "ok"]);
  assert.deepEqual([eb.coin.name, eb.coin.uri, eb.coin.supply, eb.coin.decimals, eb.coin.metadataJson], ["", "", "2000", 9, "none"]);
  // nothing changed: nothing read, nothing fetched
  chain.calls.length = 0; fetched.length = 0;
  r = await market.refresh({ pools, bytes, slot: 11 });
  assert.deepEqual([chain.calls, fetched, r.reads], [[], [], 0]);
  // pool A traded (its account changed) and its coin burned some supply: A's mint alone is read again
  put(mintA, TOKEN_PROGRAM, splMintBytes({ supply: 900n, decimals: 6 }));
  const A2 = pool({ baseMint: mintA, address: A.pool.address, reserveQuote: 7n });
  const bytes2 = new Map([[A.pool.address.toBase58(), A2.bytes], [B.pool.address.toBase58(), B.bytes]]);
  r = await market.refresh({ pools: [A2.pool, B.pool], bytes: bytes2, slot: 12 });
  assert.deepEqual([chain.calls, r.changed], [[1], 1]);
  m = market.build({ pools: [A2.pool, B.pool], bytes: bytes2, slot: 12, updatedAt: "u", checkedAt: "c", checkedSlot: 12 });
  assert.equal(m.pools.find((x) => x.baseMint === mintA.toBase58()).coin.supply, "900");
  // ten minutes later every mint is read again, in one batch
  put(mintB, TOKEN_PROGRAM, splMintBytes({ supply: 1_500n, decimals: 9 }));
  now += 600_000; chain.calls.length = 0;
  await market.refresh({ pools: [A2.pool, B.pool], bytes: bytes2, slot: 13 });
  assert.deepEqual(chain.calls, [2]);
  m = market.build({ pools: [A2.pool, B.pool], bytes: bytes2, slot: 13, updatedAt: "u", checkedAt: "c", checkedSlot: 13 });
  assert.equal(m.pools.find((x) => x.baseMint === mintB.toBase58()).coin.supply, "1500");
  // the cache survives a restart: a new market reads nothing for coins it knows
  const again = new Market({ connection: chain, cluster: "mainnet", file: path.join(dir, "market.json"), cacheFile: path.join(dir, "cache.json"), now: () => now, fetchJson: async () => { throw new Error("no fetch expected"); } });
  chain.calls.length = 0;
  again.lastBytes = new Map(market.lastBytes);
  await again.refresh({ pools: [A2.pool, B.pool], bytes: bytes2, slot: 14 });
  assert.deepEqual(chain.calls, []);
});

test("a rules pool carries its config and creator lock, read with the Clock; an unreachable JSON is tried again later", async () => {
  const dir = tmpDir();
  const accounts = new Map();
  const mint = key();
  const address = pda.pool(mint, new PublicKey("So11111111111111111111111111111111111111112"));
  const put = (k, owner, data) => accounts.set(k.toBase58(), { owner, data: Buffer.from(data), lamports: 1, executable: false });
  put(mint, TOKEN_PROGRAM, splMintBytes({ supply: 5_000n }));
  put(pda.metadata(mint), new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"), metaplexMetadataBytes({ mint, uri: "https://down.example/m.json" }));
  const cfg = rulesConfig({ pool: address, baseMint: mint });
  put(rulesPda.cfg(address), PROGRAMS.hook_rules, cfg);
  // the lock record: 8 disc, bump, pool, amount, unlockAt (57 bytes, as decodeLockRecord reads it)
  const lock = Buffer.alloc(57);
  Buffer.from(ACCOUNT_DISC.LockRecord).copy(lock, 0);
  address.toBuffer().copy(lock, 9);
  lock.writeBigUInt64LE(123_456n, 41);
  lock.writeBigInt64LE(1_800_000_000n, 49);
  put(rulesPda.lock(address), PROGRAMS.hook_rules, lock);
  put(rulesPda.lockVault(address), TOKEN_PROGRAM, tokenAccountBytes({ mint, owner: OWNER, amount: 123_456n }));
  put(CLOCK_SYSVAR, new PublicKey("Sysvar1111111111111111111111111111111111111"), clockBytes({ slot: 999n, unixTime: 1_790_000_000n }));
  const chain = fakeChain(accounts);
  let now = Date.parse("2026-10-20T12:00:00Z");
  const market = new Market({ connection: chain, cluster: "mainnet", file: path.join(dir, "market.json"), cacheFile: path.join(dir, "cache.json"), now: () => now, fetchJson: async () => ({ status: "unreachable" }) });
  const R = pool({ address, baseMint: mint, hookProgram: PROGRAMS.hook_rules, hookKind: 2, hookFlags: 13125 });
  const bytes = new Map([[address.toBase58(), R.bytes]]);
  await market.refresh({ pools: [R.pool], bytes, slot: 50 });
  assert.deepEqual(chain.calls, [6], "metadata, mint, config, lock, lock vault, Clock: one read");
  const e = market.build({ pools: [R.pool], bytes, slot: 50, updatedAt: "u", checkedAt: "c", checkedSlot: 50 }).pools[0];
  assert.deepEqual(Object.keys(e.rules), ["config", "strict", "lockAmount", "lockUnlockAt", "readAt", "slot", "unixTime"]);
  assert.equal(e.rules.config, Buffer.from(cfg).toString("base64"));
  assert.deepEqual(decodeRulesConfig(new Uint8Array(Buffer.from(e.rules.config, "base64"))).buy, decodeRulesConfig(cfg).buy);
  assert.deepEqual([e.rules.strict, e.rules.lockAmount, e.rules.lockUnlockAt, e.rules.slot, e.rules.unixTime], [false, "123456", "1800000000", 999, 1_790_000_000]);
  assert.equal(e.coin.metadataJson, "unreachable");
  const c = market.cache.coins[mint.toBase58()];
  assert.deepEqual([c.json.tries, c.json.nextTryAt], [1, now + RETRY_SOON_MS]);
  // not before its time
  let calls = 0;
  market.fetchJson = async () => { calls += 1; return { status: "unreachable" }; };
  await market.refresh({ pools: [R.pool], bytes, slot: 51 });
  assert.equal(calls, 0);
  now += RETRY_SOON_MS;
  await market.refresh({ pools: [R.pool], bytes, slot: 52 });
  assert.equal(calls, 1);
  assert.equal(market.cache.coins[mint.toBase58()].json.nextTryAt, now + RETRY_LATER_MS);
});

test("the shared pool list: read once for every loop, confirmed by the feed, read again when too old", async () => {
  let reads = 0;
  let now = 1_000_000;
  let release;
  const gate = new Promise((r) => { release = r; });
  const cache = new PoolCache({ now: () => now, read: async () => { reads += 1; await gate; return { pools: [{ address: key() }], bytes: new Map(), slot: 9 }; } });
  // three loops ask at the same moment: one read
  const asks = [cache.get(15_000), cache.get(60_000), cache.get(15_000)];
  release();
  const got = await Promise.all(asks);
  assert.equal(reads, 1);
  assert.ok(got[0] === got[1] && got[1] === got[2]);
  assert.equal(cache.slot, 9);
  // younger than asked: no read
  now += 10_000;
  await cache.get(15_000);
  assert.equal(reads, 1);
  // older: read again, unless the feed confirmed it in the meantime
  now += 10_000;
  cache.confirm(now - 1_000);
  await cache.get(15_000);
  assert.equal(reads, 1, "the feed found no transaction of the pool program since: still the chain's");
  now += 20_000;
  await cache.get(15_000);
  assert.equal(reads, 2);
  // a list read by the feed becomes the list
  cache.set({ pools: [], bytes: new Map(), slot: 11 }, now);
  assert.deepEqual([await cache.get(1), cache.slot, reads], [[], 11, 2]);
});

test("a coin's part from what the cache holds: the contract's fields, null where unknown", () => {
  assert.deepEqual(coinPart(BASE_MINT, null), { mint: BASE_MINT.toBase58(), name: "", symbol: "", uri: "", image: null, description: null, links: { website: null, twitter: null, telegram: null }, metadataJson: "pending", decimals: null, supply: null, tokenProgram: null, mintAuthority: null, freezeAuthority: null });
  assert.equal(coinPart(BASE_MINT, coin({ tokenProgram: TOKEN_2022_PROGRAM.toBase58() })).tokenProgram, TOKEN_2022_PROGRAM.toBase58());
});
