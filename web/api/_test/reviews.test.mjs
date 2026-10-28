// Unit tests for the review requests of Custom hooks (web/api/_reviews.js): the price, the quote,
// every check of a paid request against a transaction, the program id signed by the wallet,
// the store and its two writers (the server and the owner's command line), the public view,
// the rate limits and the HTTP answers. The chain is a stand-in connection that holds real
// web3.js messages; the price sources are a stand-in fetch. No network.
//   node --test "web/api/_test/*.test.mjs"        (from the project folder)
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage,
} from "@solana/web3.js";
import * as H from "../_sdk.js";
import {
  MAX_QUOTES, MEMO_PROGRAMS, PRICE_SOURCES, QUOTE_TTL_MS, RATE_LIMITS, ReviewStore, STATUSES, adminSetProgram, adminSetReport, adminSetStatus,
  checkRepo, checkXHandle, checkTelegramHandle, cleanLines, cleanText, createReviewService, feeLamports, feeUsdFrom, programMessage, publicView, telegramNotifier,
} from "../_reviews.js";

const CLI = fileURLToPath(new URL("../../../scripts/hook-reviews.mjs", import.meta.url));
const T0 = Date.parse("2026-10-24T12:00:00.000Z");
const TREASURY = Keypair.generate().publicKey;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const FIELDS = { name: "Fair tax", repo: "https://github.com/someone/fair-tax", commit: COMMIT, description: "A tax of 2% on buys and sells.\nFixed at launch.", x: "@fairdev", telegram: "@fair_dev_tg", contact: "dev@example.com" };

// ---- helpers ------------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
const randomSignature = () => b58(crypto.randomBytes(64));
/// The ed25519 signature a wallet (Phantom's signMessage) makes over the UTF-8 bytes of `text`.
function signText(kp, text) {
  const key = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: Buffer.from(kp.secretKey.slice(0, 32)).toString("base64url"), x: Buffer.from(kp.publicKey.toBytes()).toString("base64url") }, format: "jwk" });
  return b58(crypto.sign(null, Buffer.from(text, "utf8"), key));
}

/// A Platform account of the current layout: 451 bytes, the rule at byte 405, then the list.
function platformAccount({ treasury = TREASURY, required = false, programs = [], corrupt = false } = {}) {
  const b = Buffer.alloc(451 + (programs.length || corrupt ? 4 + 32 * programs.length : 0));
  Buffer.from(H.ACCOUNT_DISC.Platform).copy(b, 0);
  b[8] = 255;
  Keypair.generate().publicKey.toBuffer().copy(b, 9);
  treasury.toBuffer().copy(b, 73);
  b.writeUInt16LE(30, 105);
  b[405] = required ? 1 : 0;
  if (programs.length || corrupt) {
    b.writeUInt32LE(corrupt ? 300 : programs.length, 451);
    programs.forEach((p, i) => p.toBuffer().copy(b, 455 + 32 * i));
  }
  return { owner: H.PROGRAMS.hookpool, data: b, lamports: 1, executable: false };
}

const memoIx = (text, program = MEMO_PROGRAMS[0], signer = null) => new TransactionInstruction({ programId: new PublicKey(program), keys: signer ? [{ pubkey: signer, isSigner: true, isWritable: false }] : [], data: Buffer.from(text, "utf8") });
/// What getTransaction answers for a transaction made of `instructions`, paid by `payer`.
function confirmed({ payer, instructions, err = null, blockTime = Math.floor(T0 / 1000) + 60, slot = 5000, legacy = false, tables = [] }) {
  const m = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions });
  const message = legacy ? m.compileToLegacyMessage() : m.compileToV0Message(tables);
  const loaded = { writable: [], readonly: [] };
  if (!legacy) {
    for (const l of message.addressTableLookups) {
      const t = tables.find((x) => x.key.equals(l.accountKey));
      loaded.writable.push(...l.writableIndexes.map((i) => t.state.addresses[i]));
      loaded.readonly.push(...l.readonlyIndexes.map((i) => t.state.addresses[i]));
    }
  }
  return { slot, blockTime, meta: { err, loadedAddresses: loaded, fee: 5000 }, transaction: { message, signatures: [randomSignature()] }, version: legacy ? "legacy" : 0 };
}
const payment = (q, wallet, o = {}) => confirmed({
  payer: o.payer ?? wallet,
  instructions: o.instructions ?? [
    SystemProgram.transfer({ fromPubkey: o.from ?? wallet, toPubkey: o.to ?? new PublicKey(q.treasury), lamports: o.lamports ?? q.lamports }),
    ...(o.memo === null ? [] : [memoIx(o.memo ?? q.memo, o.memoProgram, o.memoSigner === undefined ? wallet : o.memoSigner)]),
  ],
  ...o,
});

function fakeReq(method, url, body, ip = "10.0.0.1", headers = {}) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return Object.assign(Readable.from(text ? [Buffer.from(text)] : []), { method, url, headers: { "content-type": "application/json", ...headers }, socket: { remoteAddress: ip } });
}
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: null, headersSent: false };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b) => { res.body = b ?? ""; res.headersSent = true; };
  return res;
}
const json = (res) => (res.body ? JSON.parse(res.body) : null);

/// A service on a temp store, a clock that moves only when told, a chain in memory.
function harness(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviews-test-"));
  const file = o.file ?? path.join(dir, "state", "hook-reviews.json");
  const clock = { t: o.start ?? T0 };
  const now = () => clock.t;
  const chain = { txs: new Map(), platform: o.platform ?? platformAccount(), calls: { getAccountInfo: 0, getTransaction: 0 }, down: false };
  const connection = {
    async getAccountInfo(k) { chain.calls.getAccountInfo++; if (chain.down) throw new Error("fetch failed at https://rpc.example/key"); assert.ok(k.equals(H.pda.platform())); return chain.platform; },
    async getTransaction(sig, cfg) {
      chain.calls.getTransaction++;
      if (chain.down) throw new Error("fetch failed");
      assert.deepEqual(cfg, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      return chain.txs.get(sig) ?? null;
    },
  };
  const told = [];
  const logs = [];
  const make = (extra = {}) => createReviewService({
    connection, cluster: o.cluster ?? "localnet", env: o.env ?? { REVIEW_SOL_USD: "150" }, file, now, ipMode: "direct",
    notify: o.notify ?? (async (message, line) => { told.push({ message, line }); }), log: (l) => logs.push(l), fetch: o.fetch, random: o.random, limits: o.limits, ...extra,
  });
  const svc = make();
  return { dir, file, clock, chain, connection, svc, told, logs, make, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
async function refused(p) {
  try { await p; } catch (e) { return e; }
  assert.fail("did not throw");
}
const tick = () => new Promise((r) => setImmediate(r));

/// A quote for a new wallet, its payment on the chain, and the signature of that payment.
async function paidQuote(h, o = {}) {
  const wallet = o.wallet ?? Keypair.generate();
  const q = await h.svc.quote({ wallet: wallet.publicKey.toBase58() });
  const sig = randomSignature();
  h.chain.txs.set(sig, payment(q, wallet.publicKey, o));
  return { wallet, q, sig };
}

// ---- price ---------------------------------------------------------------------------------------

test("price: the fixed price on localnet, the fee rounded up to a whole 1,000 lamports, the treasury from the chain", async () => {
  const h = harness();
  const p = await h.svc.price();
  assert.deepEqual(Object.keys(p), ["usd", "solUsd", "lamports", "treasury", "source", "at"]);
  assert.deepEqual([p.usd, p.solUsd, p.lamports, p.treasury, p.source], [25, 150, 166_667_000, TREASURY.toBase58(), "fixed"]);
  assert.equal(p.at, new Date(T0).toISOString());
  assert.equal(feeLamports(25, 100.49), 248_781_000, "25 / 100.49 SOL is 248,780,973.2 lamports: up to 248,781,000");
  assert.equal(feeLamports(25, 125), 200_000_000, "an exact amount stays as it is");
  assert.equal(feeLamports(1000, 1), 1_000_000_000_000);
  // the platform is read once for many prices
  await h.svc.price(); await h.svc.price();
  assert.equal(h.chain.calls.getAccountInfo, 1);
  h.clock.t += 31_000; await h.svc.price();
  assert.equal(h.chain.calls.getAccountInfo, 2, "read again after 30 s");
  h.cleanup();
});

test("price: REVIEW_FEE_USD from 1 to 1000, 25 otherwise; REVIEW_SOL_USD only on localnet and inside the bounds", async () => {
  assert.deepEqual(["", undefined, "10", "99.5", "0", "1001", "abc", "-5", "1e3", "10.123"].map(feeUsdFrom), [25, 25, 10, 99.5, 25, 25, 25, 25, 25, 25]);
  const h = harness({ env: { REVIEW_SOL_USD: "150", REVIEW_FEE_USD: "50" } });
  assert.deepEqual([(await h.svc.price()).usd, (await h.svc.price()).lamports], [50, 333_334_000]);
  for (const v of ["0.5", "20000", "abc"]) {
    const x = harness({ env: { REVIEW_SOL_USD: v } });
    const e = await refused(x.svc.price());
    assert.deepEqual([e.status, e.code], [503, "PRICE_UNAVAILABLE"], v);
    x.cleanup();
  }
  // off localnet the variable is not read: the price comes from the sources
  let asked = 0;
  const m = harness({ cluster: "mainnet", env: { REVIEW_SOL_USD: "150" }, fetch: async (url) => { asked++; assert.ok(url.startsWith("https://api.coingecko.com/")); return new Response(JSON.stringify({ solana: { usd: 200 } })); } });
  const p = await m.svc.price();
  assert.deepEqual([p.solUsd, p.source, p.lamports, asked], [200, "coingecko", 125_000_000, 1]);
  h.cleanup(); m.cleanup();
});

test("price: CoinGecko first, Jupiter when CoinGecko fails or is out of bounds, 503 when both fail, cached 60 s", async () => {
  const answers = { coingecko: null, jupiter: null };
  const asked = [];
  const fetch = async (url, init) => {
    assert.ok(init.signal, "every price read has a timeout");
    const which = url.includes("coingecko") ? "coingecko" : url.includes("jup.ag") ? "jupiter" : "?";
    asked.push(which);
    const a = answers[which];
    if (a === "down") throw new Error("fetch failed");
    if (typeof a === "number") return new Response("{}", { status: a });
    return new Response(JSON.stringify(a));
  };
  const h = harness({ cluster: "mainnet", env: {}, fetch });
  assert.deepEqual(PRICE_SOURCES.map((s) => s.name), ["coingecko", "jupiter"]);
  answers.coingecko = { solana: { usd: 180.25 } };
  assert.deepEqual([(await h.svc.price()).solUsd, (await h.svc.price()).source], [180.25, "coingecko"]);
  assert.deepEqual(asked, ["coingecko"], "the second price came from the cache");
  h.clock.t += 61_000;
  answers.coingecko = "down"; answers.jupiter = { So11111111111111111111111111111111111111112: { usdPrice: 181.5 } };
  let p = await h.svc.price();
  assert.deepEqual([p.solUsd, p.source], [181.5, "jupiter"]);
  h.clock.t += 61_000;
  answers.coingecko = { solana: { usd: 0.4 } };
  p = await h.svc.price();
  assert.deepEqual([p.solUsd, p.source], [181.5, "jupiter"], "a CoinGecko price under 1 USD is refused");
  h.clock.t += 61_000;
  answers.coingecko = { solana: { usd: 12_000 } }; answers.jupiter = 500;
  const e = await refused(h.svc.price());
  assert.deepEqual([e.status, e.code], [503, "PRICE_UNAVAILABLE"]);
  const n = asked.length;
  await refused(h.svc.price());
  assert.equal(asked.length, n, "after a failure the sources rest for 10 s");
  h.clock.t += 11_000;
  answers.coingecko = { solana: { usd: 150 } };
  assert.equal((await h.svc.price()).lamports, 166_667_000);
  assert.ok(h.logs.every((l) => !/https?:\/\//.test(l)), "the log names the source, not its address");
  h.cleanup();
});

// ---- quote ---------------------------------------------------------------------------------------

test("quote: binds the wallet and the amount for 30 minutes, the memo carries its id, kept in the store", async () => {
  const h = harness({ random: (() => { let i = 0; return () => (++i).toString(16).padStart(16, "a"); })() });
  const wallet = Keypair.generate().publicKey.toBase58();
  const q = await h.svc.quote({ wallet });
  assert.deepEqual(Object.keys(q), ["id", "wallet", "lamports", "usd", "solUsd", "treasury", "memo", "expiresAt"]);
  assert.match(q.id, /^[0-9a-f]{16}$/);
  assert.deepEqual([q.wallet, q.lamports, q.usd, q.solUsd, q.treasury, q.memo, q.expiresAt], [wallet, 166_667_000, 25, 150, TREASURY.toBase58(), "programmable-review:" + q.id, new Date(T0 + QUOTE_TTL_MS).toISOString()]);
  const kept = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.deepEqual(kept.quotes[q.id], { ...q, createdAt: new Date(T0).toISOString(), expiresAt: q.expiresAt });
  for (const bad of [{}, { wallet: "nope" }, { wallet: 5 }, { wallet, extra: 1 }, { wallet, secretKey: "x" }]) {
    const e = await refused(h.svc.quote(bad));
    assert.equal(e.status, 400, JSON.stringify(bad));
  }
  const ids = new Set();
  for (let i = 0; i < 3; i++) ids.add((await h.svc.quote({ wallet })).id);
  assert.equal(ids.size, 3, "every quote has its own id");
  h.cleanup();
});

test("quote: at most 5,000 quotes kept, the oldest dropped first, ended ones after a day", async () => {
  const h = harness();
  const data = { version: 1, quotes: {}, requests: {} };
  for (let i = 0; i < MAX_QUOTES; i++) {
    const id = i.toString(16).padStart(16, "0");
    data.quotes[id] = { id, createdAt: new Date(T0 - (MAX_QUOTES - i) * 1000).toISOString(), expiresAt: new Date(T0 + QUOTE_TTL_MS).toISOString() };
  }
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.writeFileSync(h.file, JSON.stringify(data));
  const q = await h.svc.quote({ wallet: Keypair.generate().publicKey.toBase58() });
  const after = JSON.parse(fs.readFileSync(h.file, "utf8")).quotes;
  assert.equal(Object.keys(after).length, MAX_QUOTES);
  assert.ok(after[q.id] && !after["0000000000000000"] && after["0000000000000001"], "the oldest one went");
  h.clock.t += QUOTE_TTL_MS + 25 * 3_600_000;
  await h.svc.quote({ wallet: Keypair.generate().publicKey.toBase58() });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(h.file, "utf8")).quotes).length, 1, "quotes that ended a day ago are dropped");
  h.cleanup();
});

// ---- submit --------------------------------------------------------------------------------------

test("submit: a good payment is stored, the quote is used, the owner is told; the public view has no contact", async () => {
  const h = harness();
  const { wallet, q, sig } = await paidQuote(h);
  const out = await h.svc.submit({ id: q.id, signature: sig, ...FIELDS });
  assert.deepEqual(out, { status: 201, body: { id: q.id, status: "waiting", statusText: "Paid. Waiting for a reviewer." } });
  const r = JSON.parse(fs.readFileSync(h.file, "utf8")).requests[q.id];
  assert.deepEqual(Object.keys(r), ["id", "wallet", "name", "repo", "commit", "description", "x", "telegram", "contact", "paid", "status", "note", "program", "report", "createdAt", "updatedAt", "history"]);
  assert.deepEqual(r.paid, { signature: sig, lamports: 166_667_000, slot: 5000, blockTime: Math.floor(T0 / 1000) + 60 });
  assert.deepEqual([r.wallet, r.name, r.repo, r.commit, r.description, r.x, r.telegram, r.contact, r.status, r.note, r.program, r.report], [wallet.publicKey.toBase58(), ...Object.values(FIELDS), "waiting", "", null, null]);
  assert.deepEqual(r.history, [{ at: new Date(T0).toISOString(), status: "waiting", note: "Paid 0.166667 SOL." }]);
  assert.equal(JSON.parse(fs.readFileSync(h.file, "utf8")).quotes[q.id], undefined, "the quote is gone");
  if (process.platform !== "win32") assert.equal(fs.statSync(h.file).mode & 0o777, 0o600, "the store holds contacts: the owner's alone");
  await tick();
  assert.equal(h.told.length, 1);
  for (const part of [FIELDS.name, FIELDS.repo, COMMIT, q.id, wallet.publicKey.toBase58(), "0.166667 SOL", FIELDS.contact, FIELDS.x, FIELDS.telegram, "Discord ticket"]) assert.ok(h.told[0].message.includes(part), part);
  assert.ok(!h.told[0].line.includes(FIELDS.contact), "the log line never carries the contact");
  const v = h.svc.status(q.id);
  assert.deepEqual(Object.keys(v), ["id", "name", "repo", "commit", "status", "statusText", "note", "program", "report", "createdAt", "updatedAt", "paid"]);
  assert.deepEqual(v.paid, { signature: sig, lamports: 166_667_000 });
  assert.ok(![FIELDS.contact, FIELDS.x, FIELDS.telegram, "Fixed at launch"].some((p) => JSON.stringify(v).includes(p)), "no handles, no contact, no description");
  assert.deepEqual(publicView(r), v);
  h.cleanup();
});

test("submit: underpaid, wrong wallet, wrong treasury, wrong memo, no memo, a failed transaction", async () => {
  const h = harness();
  const cases = [
    ["underpaid", (q) => ({ lamports: q.lamports - 1000 }), 422, "UNDERPAID"],
    ["signed and paid by another wallet", () => { const o = Keypair.generate().publicKey; return { payer: o, from: o, memoSigner: null }; }, 422, "WRONG_WALLET"],
    ["paid to another address", () => ({ to: Keypair.generate().publicKey }), 422, "PAYMENT_MISSING"],
    ["the memo of another quote", () => ({ memo: "programmable-review:ffffffffffffffff" }), 422, "MEMO_MISMATCH"],
    ["no memo", () => ({ memo: null }), 422, "MEMO_MISSING"],
    ["a memo of a program that is not the memo program", (q) => ({ memoProgram: Keypair.generate().publicKey.toBase58(), memo: q.memo }), 422, "MEMO_MISSING"],
    ["failed on chain", () => ({ err: { InstructionError: [0, { Custom: 1 }] } }), 422, "TRANSACTION_FAILED"],
  ];
  for (const [what, opts, status, code] of cases) {
    const wallet = Keypair.generate();
    const q = await h.svc.quote({ wallet: wallet.publicKey.toBase58() });
    const sig = randomSignature();
    h.chain.txs.set(sig, payment(q, wallet.publicKey, opts(q)));
    const e = await refused(h.svc.submit({ id: q.id, signature: sig, ...FIELDS }));
    assert.deepEqual([e.status, e.code], [status, code], what);
    assert.ok(JSON.parse(fs.readFileSync(h.file, "utf8")).quotes[q.id], what + ": the quote stays open");
  }
  // an underpaid answer says both amounts
  const wallet = Keypair.generate();
  const q = await h.svc.quote({ wallet: wallet.publicKey.toBase58() });
  const sig = randomSignature();
  h.chain.txs.set(sig, payment(q, wallet.publicKey, { lamports: 100 }));
  const e = await refused(h.svc.submit({ id: q.id, signature: sig, ...FIELDS }));
  assert.deepEqual(e.extra, { paid: 100, lamports: q.lamports });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(h.file, "utf8")).requests).length, 0, "nothing stored");
  assert.equal(h.told.length, 0);
  h.cleanup();
});

test("submit: a v1 memo, a legacy transaction, a treasury loaded from a lookup table, a paying second signer", async () => {
  const h = harness();
  let x = await paidQuote(h, { memoProgram: MEMO_PROGRAMS[1] });
  assert.equal((await h.svc.submit({ id: x.q.id, signature: x.sig, ...FIELDS })).status, 201, "memo v1");
  x = await paidQuote(h, { legacy: true });
  assert.equal((await h.svc.submit({ id: x.q.id, signature: x.sig, ...FIELDS })).status, 201, "legacy");
  const wallet = Keypair.generate();
  const q = await h.svc.quote({ wallet: wallet.publicKey.toBase58() });
  const table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [TREASURY] } });
  let sig = randomSignature();
  h.chain.txs.set(sig, payment(q, wallet.publicKey, { tables: [table] }));
  assert.ok(h.chain.txs.get(sig).meta.loadedAddresses.writable[0].equals(TREASURY), "the treasury is a loaded address");
  assert.equal((await h.svc.submit({ id: q.id, signature: sig, ...FIELDS })).status, 201, "lookup table");
  // a relayer pays the fee, the quote's wallet signs and pays the fee of the review
  const w2 = Keypair.generate();
  const q2 = await h.svc.quote({ wallet: w2.publicKey.toBase58() });
  sig = randomSignature();
  h.chain.txs.set(sig, payment(q2, w2.publicKey, { payer: Keypair.generate().publicKey }));
  assert.equal((await h.svc.submit({ id: q2.id, signature: sig, ...FIELDS })).status, 201, "the wallet as a second signer");
  h.cleanup();
});

test("submit: not confirmed yet, then confirmed; expired; a quote long over with nothing on chain", async () => {
  const h = harness();
  const wallet = Keypair.generate();
  const q = await h.svc.quote({ wallet: wallet.publicKey.toBase58() });
  const sig = randomSignature();
  const e = await refused(h.svc.submit({ id: q.id, signature: sig, ...FIELDS }));
  assert.deepEqual([e.status, e.code, e.extra], [409, "NOT_CONFIRMED_YET", { retryAfterSeconds: 6 }]);
  h.chain.txs.set(sig, payment(q, wallet.publicKey));
  assert.equal((await h.svc.submit({ id: q.id, signature: sig, ...FIELDS })).status, 201);
  // block time 121 s after the quote's end: too late. 120 s: in time.
  const end = Math.floor(Date.parse(q.expiresAt) / 1000);
  for (const [dt, ok] of [[121, false], [120, true]]) {
    const w = Keypair.generate();
    const qq = await h.svc.quote({ wallet: w.publicKey.toBase58() });
    const s = randomSignature();
    h.chain.txs.set(s, payment(qq, w.publicKey, { blockTime: Math.floor(Date.parse(qq.expiresAt) / 1000) + dt }));
    if (ok) assert.equal((await h.svc.submit({ id: qq.id, signature: s, ...FIELDS })).status, 201, "120 s after the end");
    else { const x = await refused(h.svc.submit({ id: qq.id, signature: s, ...FIELDS })); assert.deepEqual([x.status, x.code], [410, "QUOTE_EXPIRED"]); }
  }
  assert.ok(end > 0);
  // a payment made in time and sent in hours later still counts
  const w = Keypair.generate();
  const late = await h.svc.quote({ wallet: w.publicKey.toBase58() });
  const s = randomSignature();
  h.chain.txs.set(s, payment(late, w.publicKey, { blockTime: Math.floor(h.clock.t / 1000) + 10 }));
  h.clock.t += 5 * 3_600_000;
  assert.equal((await h.svc.submit({ id: late.id, signature: s, ...FIELDS })).status, 201);
  // a quote over for more than 3.5 minutes, and still nothing on chain: expired, not "wait"
  const w3 = Keypair.generate();
  const gone = await h.svc.quote({ wallet: w3.publicKey.toBase58() });
  h.clock.t += QUOTE_TTL_MS + 211_000;
  const x = await refused(h.svc.submit({ id: gone.id, signature: randomSignature(), ...FIELDS }));
  assert.deepEqual([x.status, x.code], [410, "QUOTE_EXPIRED"]);
  // the RPC down: 502, its address never in the answer
  h.chain.down = true;
  const w4 = Keypair.generate();
  h.chain.down = false;
  const q4 = await h.svc.quote({ wallet: w4.publicKey.toBase58() });
  h.chain.down = true;
  const d = await refused(h.svc.submit({ id: q4.id, signature: randomSignature(), ...FIELDS }));
  assert.deepEqual([d.status, d.code], [502, "RPC_UNAVAILABLE"]);
  assert.ok(!d.message.includes("rpc.example") && h.logs.every((l) => !l.includes("rpc.example/key")));
  h.cleanup();
});

test("submit: a used quote, a used signature, the same request sent twice, an unknown quote", async () => {
  const h = harness();
  const a = await paidQuote(h);
  assert.equal((await h.svc.submit({ id: a.q.id, signature: a.sig, ...FIELDS })).status, 201);
  // the same request again (the page lost the answer): the same answer, nothing new stored
  assert.deepEqual(await h.svc.submit({ id: a.q.id, signature: a.sig, ...FIELDS }), { status: 200, body: { id: a.q.id, status: "waiting", statusText: STATUSES.waiting } });
  const other = randomSignature();
  h.chain.txs.set(other, payment(a.q, a.wallet.publicKey));
  let e = await refused(h.svc.submit({ id: a.q.id, signature: other, ...FIELDS }));
  assert.deepEqual([e.status, e.code], [409, "QUOTE_USED"]);
  // the first payment's signature sent for a second quote of the same wallet
  const q2 = await h.svc.quote({ wallet: a.wallet.publicKey.toBase58() });
  const calls = h.chain.calls.getTransaction;
  e = await refused(h.svc.submit({ id: q2.id, signature: a.sig, ...FIELDS }));
  assert.deepEqual([e.status, e.code], [409, "SIGNATURE_USED"]);
  assert.equal(h.chain.calls.getTransaction, calls, "a used signature costs no RPC call");
  e = await refused(h.svc.submit({ id: "0123456789abcdef", signature: a.sig, ...FIELDS }));
  assert.deepEqual([e.status, e.code], [404, "QUOTE_NOT_FOUND"]);
  await tick();
  assert.equal(h.told.length, 1, "the owner is told once");
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(h.file, "utf8")).requests).length, 1);
  h.cleanup();
});

test("submit: bad fields, each with its own parameter; control characters taken out", async () => {
  const h = harness();
  const { q, sig } = await paidQuote(h);
  const cases = [
    [{ id: "XYZ" }, "id"], [{ id: q.id.toUpperCase() }, "id"],
    [{ name: "" }, "name"], [{ name: "x".repeat(33) }, "name"], [{ name: "caf\u00e9" }, "name"], [{ name: 5 }, "name"], [{ name: undefined }, "name"],
    [{ repo: "http://github.com/a/b" }, "repo"], [{ repo: "https://example.com/a/b" }, "repo"], [{ repo: "https://github.com/a" }, "repo"],
    [{ repo: "https://github.com/a/b/c" }, "repo"], [{ repo: "https://github.com/a/b?x=1" }, "repo"], [{ repo: "https://user@github.com/a/b" }, "repo"],
    [{ repo: "https://github.com/../b" }, "repo"], [{ repo: "https://github.com/a/" + "b".repeat(200) }, "repo"], [{ repo: "https://github.com:8443/a/b" }, "repo"],
    [{ commit: COMMIT.slice(1) }, "commit"], [{ commit: COMMIT.toUpperCase() }, "commit"], [{ commit: COMMIT + "0" }, "commit"], [{ commit: "g".repeat(40) }, "commit"],
    [{ description: "" }, "description"], [{ description: " \n\t " }, "description"], [{ description: "d".repeat(2001) }, "description"],
    [{ contact: "ab" }, "contact"], [{ contact: "c".repeat(121) }, "contact"],
    [{ x: "a".repeat(16) }, "x"], [{ x: "bad-name" }, "x"], [{ x: "@" }, "x"], [{ x: 5 }, "x"],
    [{ telegram: "abc" }, "telegram"], [{ telegram: "1alice" }, "telegram"], [{ telegram: "a".repeat(33) }, "telegram"], [{ telegram: "al ice" }, "telegram"],
    [{ signature: "nope" }, "signature"], [{ signature: b58(crypto.randomBytes(32)) }, "signature"],
    [{ extra: "x" }, "extra"], [{ privateKey: "x" }, "privateKey"],
  ];
  for (const [over, parameter] of cases) {
    const body = { id: q.id, signature: sig, ...FIELDS, ...over };
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete body[k];
    const e = await refused(h.svc.submit(body));
    assert.deepEqual([e.status, e.code, e.extra && e.extra.parameter], [400, "INVALID_PARAMETER", parameter], JSON.stringify(over).slice(0, 80));
  }
  assert.equal(h.chain.calls.getTransaction, 0, "no field error costs an RPC call");
  for (const ok of ["https://gitlab.com/group-a/repo.name.git", "https://codeberg.org/x_y/z-1/", "https://GitHub.com/A/B"]) assert.ok(checkRepo(ok).startsWith("https://"), ok);
  assert.equal(checkRepo("https://GitHub.com/A/B/"), "https://github.com/A/B");
  assert.equal(cleanText(" a\u0000b\u202ec\u200b\u0007 "), "abc");
  assert.equal(cleanLines("one\r\ntwo\u0000\u2028\rthree"), "one\ntwo\nthree");
  const out = await h.svc.submit({ id: q.id, signature: sig, ...FIELDS, name: " Fair\u0007 tax\u202e ", description: "line one\r\nline two\u0000", contact: "@dev\u200b " });
  assert.equal(out.status, 201);
  const r = JSON.parse(fs.readFileSync(h.file, "utf8")).requests[q.id];
  assert.deepEqual([r.name, r.description, r.contact], ["Fair tax", "line one\nline two", "@dev"]);
  h.cleanup();
});

// ---- the program id ------------------------------------------------------------------------------

test("program id: the wallet's signature, a bad one, another wallet's, the wrong status, our own programs", async () => {
  const h = harness();
  const { wallet, q, sig } = await paidQuote(h);
  await h.svc.submit({ id: q.id, signature: sig, ...FIELDS });
  const program = Keypair.generate().publicKey.toBase58();
  const good = signText(wallet, programMessage(q.id, program));
  assert.equal(programMessage(q.id, program), "Programmable hook review " + q.id + ": my program is " + program);
  let e = await refused(Promise.resolve().then(() => h.svc.giveProgram(q.id, { program, signature: good })));
  assert.deepEqual([e.status, e.code], [409, "WRONG_STATUS"], "while the code waits for its review");
  adminSetStatus(h.svc.store, q.id, "passed", "Looks good", T0 + 1000);
  const tries = [
    [{ program, signature: signText(wallet, programMessage(q.id, Keypair.generate().publicKey.toBase58())) }, 403, "SIGNATURE_INVALID", "signed for another program"],
    [{ program, signature: signText(Keypair.generate(), programMessage(q.id, program)) }, 403, "SIGNATURE_INVALID", "another wallet"],
    [{ program, signature: signText(wallet, programMessage("0000000000000000", program)) }, 403, "SIGNATURE_INVALID", "another request"],
    [{ program, signature: randomSignature() }, 403, "SIGNATURE_INVALID", "random bytes"],
    [{ program, signature: "x" }, 400, "INVALID_PARAMETER", "not a signature"],
    [{ program: "nope", signature: good }, 400, "INVALID_PARAMETER", "not a program"],
    [{ program: H.PROGRAMS.hook_tax.toBase58(), signature: signText(wallet, programMessage(q.id, H.PROGRAMS.hook_tax.toBase58())) }, 400, "INVALID_PARAMETER", "a template"],
    [{ program, signature: good, extra: 1 }, 400, "INVALID_PARAMETER", "unknown field"],
  ];
  for (const [body, status, code, what] of tries) {
    e = await refused(Promise.resolve().then(() => h.svc.giveProgram(q.id, body)));
    assert.deepEqual([e.status, e.code], [status, code], what);
  }
  e = await refused(Promise.resolve().then(() => h.svc.giveProgram("ffffffffffffffff", { program, signature: good })));
  assert.deepEqual([e.status, e.code], [404, "REQUEST_NOT_FOUND"]);
  const out = h.svc.giveProgram(q.id, { program, signature: good });
  assert.deepEqual(out, { id: q.id, status: "checking", statusText: STATUSES.checking, program });
  await tick();
  assert.equal(h.told.length, 2);
  assert.ok(h.told[1].message.includes(program) && h.told[1].message.includes(FIELDS.contact));
  // given again while checking: the same answer, no second message; another program replaces it
  h.svc.giveProgram(q.id, { program, signature: good });
  await tick();
  assert.equal(h.told.length, 2);
  const p2 = Keypair.generate().publicKey.toBase58();
  assert.equal(h.svc.giveProgram(q.id, { program: p2, signature: signText(wallet, programMessage(q.id, p2)) }).program, p2);
  const r = JSON.parse(fs.readFileSync(h.file, "utf8")).requests[q.id];
  assert.deepEqual(r.history.map((x) => x.status), ["waiting", "passed", "checking", "checking"]);
  adminSetStatus(h.svc.store, q.id, "approved", "", T0 + 5000);
  e = await refused(Promise.resolve().then(() => h.svc.giveProgram(q.id, { program, signature: good })));
  assert.deepEqual([e.status, e.code], [409, "WRONG_STATUS"], "once approved");
  h.cleanup();
});

// ---- the store -----------------------------------------------------------------------------------

test("store: a restart keeps the requests and the open quotes; a corrupt file is kept aside", async () => {
  const h = harness();
  const a = await paidQuote(h);
  await h.svc.submit({ id: a.q.id, signature: a.sig, ...FIELDS });
  const open = await h.svc.quote({ wallet: Keypair.generate().publicKey.toBase58() });
  const again = h.make();
  assert.equal(again.status(a.q.id).status, "waiting", "a new process reads the request");
  const sig = randomSignature();
  h.chain.txs.set(sig, payment(open, new PublicKey(open.wallet)));
  assert.equal((await again.submit({ id: open.id, signature: sig, ...FIELDS })).status, 201, "and the quote taken before the restart");
  fs.writeFileSync(h.file, "{ not json");
  const after = h.make();
  assert.throws(() => after.status(a.q.id), (e) => e.code === "REQUEST_NOT_FOUND");
  const aside = fs.readdirSync(path.dirname(h.file)).filter((f) => f.startsWith("hook-reviews.json.bad-"));
  assert.equal(aside.length, 1, "the corrupt file is kept aside");
  assert.equal(fs.readFileSync(path.join(path.dirname(h.file), aside[0]), "utf8"), "{ not json");
  assert.ok(h.logs.some((l) => l.includes("kept aside")));
  // the store starts empty and works
  await after.quote({ wallet: Keypair.generate().publicKey.toBase58() });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(h.file, "utf8")).quotes).length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)).filter((f) => f.endsWith(".lock") || f.includes(".tmp")), [], "no lock and no temp file left");
  h.cleanup();
});

test("store: the owner's command line changes a status while the server holds the requests; the server then takes a new request; both changes stay", async () => {
  const h = harness();
  const a = await paidQuote(h);
  await h.svc.submit({ id: a.q.id, signature: a.sig, ...FIELDS });
  const b = await paidQuote(h);   // its quote is open in the server's memory and on disk
  assert.equal(h.svc.status(a.q.id).status, "waiting", "the server holds the request");
  // the owner, in another process, on the same file
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, REVIEWS_FILE: h.file }, encoding: "utf8" });
  let run = cli("set", a.q.id, "in-review", "Reading", "the", "code");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /is now in-review, note: Reading the code/);
  // the server reads the change at once
  assert.deepEqual([h.svc.status(a.q.id).status, h.svc.status(a.q.id).note], ["in-review", "Reading the code"]);
  // the server takes the second request: the owner's change stays
  assert.equal((await h.svc.submit({ id: b.q.id, signature: b.sig, ...FIELDS })).status, 201);
  // and another owner change after it keeps the server's request
  run = cli("report", a.q.id, "/reviews/fair-tax.html");
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.deepEqual([data.requests[a.q.id].status, data.requests[a.q.id].report, data.requests[b.q.id].status], ["in-review", "/reviews/fair-tax.html", "waiting"]);
  assert.deepEqual(data.requests[a.q.id].history.map((x) => [x.status, x.note]), [["waiting", "Paid 0.166667 SOL."], ["in-review", "Reading the code"], ["in-review", "Report: /reviews/fair-tax.html"]]);
  // the same in one process with two stores, as two processes see the file
  const owner = new ReviewStore(h.file);
  owner.read();
  adminSetStatus(owner, b.q.id, "changes-needed", "Fix the sell path", T0 + 9000);
  const c = await paidQuote(h);
  await h.svc.submit({ id: c.q.id, signature: c.sig, ...FIELDS });
  adminSetProgram(owner, c.q.id, Keypair.generate().publicKey.toBase58(), T0 + 9500);
  const end = JSON.parse(fs.readFileSync(h.file, "utf8")).requests;
  assert.deepEqual([end[a.q.id].status, end[b.q.id].status, end[c.q.id].status, !!end[c.q.id].program], ["in-review", "changes-needed", "waiting", true]);
  // a lock left by a process that died is taken over after 10 seconds; a fresh one makes a writer wait
  fs.writeFileSync(h.file + ".lock", "123");
  const old = new Date(Date.now() - 11_000);
  fs.utimesSync(h.file + ".lock", old, old);
  adminSetReport(owner, a.q.id, "https://example.com/r.html", T0 + 9900);
  assert.equal(fs.existsSync(h.file + ".lock"), false);
  fs.writeFileSync(h.file + ".lock", "123");
  const t = Date.now();
  assert.throws(() => adminSetStatus(owner, a.q.id, "passed", "", T0), (e) => e.code === "BUSY");
  assert.ok(Date.now() - t >= 1500, "it waited about two seconds");
  fs.unlinkSync(h.file + ".lock");
  h.cleanup();
});

test("the command line: list, show, set, report, program, and its refusals", async () => {
  const h = harness();
  const a = await paidQuote(h);
  await h.svc.submit({ id: a.q.id, signature: a.sig, ...FIELDS });
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, REVIEWS_FILE: h.file }, encoding: "utf8" });
  let r = cli("list");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(a.q.id) && r.stdout.includes("waiting") && r.stdout.includes("Fair tax") && r.stdout.includes("0.166667") && r.stdout.includes("1 requests"));
  r = cli("show", a.q.id);
  assert.equal(r.status, 0);
  for (const part of [FIELDS.contact, COMMIT, "Fixed at launch.", a.sig, "history"]) assert.ok(r.stdout.includes(part), part);
  r = cli("set", a.q.id, "bogus");
  assert.equal(r.status, 1); assert.match(r.stderr, /Unknown status "bogus"\. The statuses: waiting, in-review, changes-needed, passed, checking, approved, rejected/);
  r = cli("set", "ffffffffffffffff", "passed");
  assert.equal(r.status, 1); assert.match(r.stderr, /No review request has the id ffffffffffffffff/);
  r = cli("report", a.q.id, "javascript:alert(1)");
  assert.equal(r.status, 1); assert.match(r.stderr, /https address or a path/);
  r = cli("program", a.q.id, "nope");
  assert.equal(r.status, 1);
  r = cli("set", a.q.id, "approved");
  assert.equal(r.status, 0); assert.match(r.stdout, /approve_hook/);
  assert.equal(JSON.parse(fs.readFileSync(h.file, "utf8")).requests[a.q.id].note, "", "no words: no note");
  r = cli("frobnicate");
  assert.equal(r.status, 2); assert.match(r.stderr, /usage:/);
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(fs.readFileSync(CLI, "utf8")), "the script is plain ASCII");
  h.cleanup();
});

// ---- the approved list ---------------------------------------------------------------------------

test("approved list: from the platform account, cached 30 s; a corrupt list said so; no platform", async () => {
  const p1 = Keypair.generate().publicKey; const p2 = Keypair.generate().publicKey;
  const h = harness({ platform: platformAccount({ required: true, programs: [p1, p2] }) });
  assert.deepEqual(await h.svc.approved(), { required: true, programs: [p1.toBase58(), p2.toBase58()], corrupt: false });
  h.chain.platform = platformAccount({ required: false });
  assert.equal((await h.svc.approved()).required, true, "from the cache");
  h.clock.t += 30_001;
  assert.deepEqual(await h.svc.approved(), { required: false, programs: [], corrupt: false });
  h.clock.t += 30_001;
  h.chain.platform = platformAccount({ required: true, corrupt: true });
  assert.deepEqual(await h.svc.approved(), { required: true, programs: [], corrupt: true });
  h.clock.t += 30_001;
  h.chain.platform = null;
  const e = await refused(h.svc.approved());
  assert.deepEqual([e.status, e.code], [503, "NOT_DEPLOYED"]);
  h.clock.t += 30_001;
  h.chain.down = true;
  assert.equal((await refused(h.svc.price())).code, "RPC_UNAVAILABLE");
  h.cleanup();
});

// ---- notification ----------------------------------------------------------------------------------

test("notification: Telegram with both settings, a log line without them, never the token; a failed send fails nothing", async () => {
  const sent = [];
  const lines = [];
  const ok = telegramNotifier({ REVIEW_TELEGRAM_BOT_TOKEN: "123:SECRET", REVIEW_TELEGRAM_CHAT_ID: "42" }, async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }, (l) => lines.push(l));
  assert.equal(await ok("hello", "line"), true);
  assert.deepEqual(sent, [{ url: "https://api.telegram.org/bot123:SECRET/sendMessage", body: { chat_id: "42", text: "hello", disable_web_page_preview: true } }]);
  const refusedSend = telegramNotifier({ REVIEW_TELEGRAM_BOT_TOKEN: "123:SECRET", REVIEW_TELEGRAM_CHAT_ID: "42" }, async () => new Response("{}", { status: 401 }), (l) => lines.push(l));
  assert.equal(await refusedSend("x", "y"), false);
  const down = telegramNotifier({ REVIEW_TELEGRAM_BOT_TOKEN: "123:SECRET", REVIEW_TELEGRAM_CHAT_ID: "42" }, async () => { throw new TypeError("fetch failed https://api.telegram.org/bot123:SECRET/sendMessage"); }, (l) => lines.push(l));
  assert.equal(await down("x", "y"), false);
  const off = telegramNotifier({ REVIEW_TELEGRAM_BOT_TOKEN: "123:SECRET" }, async () => assert.fail("no send with one setting"), (l) => lines.push(l));
  assert.equal(await off("x", "new paid review request abc"), false);
  assert.ok(lines.every((l) => !l.includes("SECRET")), "the token is never logged");
  assert.ok(lines.some((l) => l.includes("HTTP 401")) && lines.some((l) => l.includes("new paid review request abc")));
  // a notifier that throws never fails the request
  const h = harness({ notify: async () => { throw new Error("boom"); } });
  const a = await paidQuote(h);
  assert.equal((await h.svc.submit({ id: a.q.id, signature: a.sig, ...FIELDS })).status, 201);
  await tick();
  h.cleanup();
});

// ---- HTTP ------------------------------------------------------------------------------------------

test("http: routes, methods, preflight, JSON only, the rate limits of each route, Retry-After on NOT_CONFIRMED_YET", async () => {
  const h = harness();
  const call = async (method, route, body, ip, headers) => { const res = fakeRes(); await h.svc.handle(fakeReq(method, "/api/v1/" + route, body, ip, headers), res, route); return res; };
  let res = await call("GET", "hook-reviews/price");
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.headers["content-type"], res.headers["x-content-type-options"], res.headers["cache-control"], res.headers["access-control-allow-origin"]], ["application/json; charset=utf-8", "nosniff", "no-store", "*"]);
  assert.equal(json(res).lamports, 166_667_000);
  res = await call("OPTIONS", "hook-reviews/quote");
  assert.deepEqual([res.statusCode, res.headers["access-control-allow-methods"], res.body], [204, "POST, OPTIONS", ""]);
  res = await call("GET", "hook-reviews/quote");
  assert.deepEqual([res.statusCode, json(res).error.code, res.headers.allow], [405, "METHOD_NOT_ALLOWED", "POST, OPTIONS"]);
  res = await call("GET", "hook-reviews/x/y/z");
  assert.deepEqual([res.statusCode, json(res).error.code], [404, "NOT_FOUND"]);
  res = await call("GET", "hook-reviews/NOT-AN-ID");
  assert.deepEqual([res.statusCode, json(res).error.code, json(res).error.parameter], [400, "INVALID_PARAMETER", "id"]);
  res = await call("POST", "hook-reviews/quote", "nope");
  assert.deepEqual([res.statusCode, json(res).error.code], [400, "INVALID_JSON"]);
  res = await call("POST", "hook-reviews", "x".repeat(20_000));
  assert.deepEqual([res.statusCode, json(res).error.code], [413, "BODY_TOO_LARGE"]);
  res = await call("GET", "hooks/approved");
  assert.deepEqual(json(res), { required: false, programs: [], corrupt: false });
  // a full request over HTTP, through NOT_CONFIRMED_YET
  const wallet = Keypair.generate();
  res = await call("POST", "hook-reviews/quote", { wallet: wallet.publicKey.toBase58() }, "10.0.0.2");
  const q = json(res);
  const sig = randomSignature();
  res = await call("POST", "hook-reviews", { id: q.id, signature: sig, ...FIELDS }, "10.0.0.2");
  assert.deepEqual([res.statusCode, json(res).error.code, res.headers["retry-after"]], [409, "NOT_CONFIRMED_YET", "6"]);
  h.chain.txs.set(sig, payment(q, wallet.publicKey));
  res = await call("POST", "hook-reviews", { id: q.id, signature: sig, ...FIELDS }, "10.0.0.2");
  assert.deepEqual([res.statusCode, json(res)], [201, { id: q.id, status: "waiting", statusText: STATUSES.waiting }]);
  res = await call("GET", "hook-reviews/" + q.id);
  assert.equal(json(res).status, "waiting");
  assert.ok(!res.body.includes(FIELDS.contact));
  // the limits: quote 10 a minute per address, then 429 with Retry-After; another address is not held
  assert.deepEqual(RATE_LIMITS, { price: 60, status: 60, approved: 60, quote: 10, submit: 10, program: 10 });
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await call("POST", "hook-reviews/quote", { wallet: wallet.publicKey.toBase58() }, "10.0.0.9")).statusCode);
  assert.deepEqual(codes, [...Array(10).fill(200), 429]);
  res = await call("POST", "hook-reviews/quote", { wallet: wallet.publicKey.toBase58() }, "10.0.0.9");
  assert.deepEqual([json(res).error.code, Number(res.headers["retry-after"]) > 0, res.headers["x-ratelimit-limit"]], ["RATE_LIMITED", true, "10"]);
  assert.equal((await call("POST", "hook-reviews/quote", { wallet: wallet.publicKey.toBase58() }, "10.0.0.10")).statusCode, 200);
  const statusCodes = [];
  for (let i = 0; i < 61; i++) statusCodes.push((await call("GET", "hook-reviews/" + q.id, undefined, "10.0.0.11")).statusCode);
  assert.deepEqual([statusCodes.filter((c) => c === 200).length, statusCodes[60]], [60, 429]);
  assert.equal((await call("GET", "hook-reviews/price", undefined, "10.0.0.11")).statusCode, 200, "price has its own count");
  const submits = [];
  for (let i = 0; i < 11; i++) submits.push((await call("POST", "hook-reviews", { id: q.id, signature: sig, ...FIELDS }, "10.0.0.12")).statusCode);
  assert.deepEqual(submits, [...Array(10).fill(200), 429]);
  const programs = [];
  for (let i = 0; i < 11; i++) programs.push((await call("POST", "hook-reviews/" + q.id + "/program", { program: Keypair.generate().publicKey.toBase58(), signature: randomSignature() }, "10.0.0.13")).statusCode);
  assert.deepEqual(programs, [...Array(10).fill(403), 429]);
  h.clock.t += 61_000;
  assert.equal((await call("POST", "hook-reviews/quote", { wallet: wallet.publicKey.toBase58() }, "10.0.0.9")).statusCode, 200, "a new minute");
  // a failing RPC is one fixed sentence, never its error, a stack or a path
  const broken = h.make({ connection: { getAccountInfo: async () => { throw new Error("socket hang up at C:\\x\\y.js https://rpc.example/key"); } } });
  const r2 = fakeRes();
  await broken.handle(fakeReq("GET", "/api/v1/hook-reviews/price"), r2, "hook-reviews/price");
  assert.deepEqual([r2.statusCode, json(r2)], [502, { error: { code: "RPC_UNAVAILABLE", message: "The Solana RPC did not answer. Try again." } }]);
  assert.ok(h.logs.every((l) => !l.includes("rpc.example")), "the log hides the RPC address");
  h.cleanup();
});

test("http: the server's routes reach the review module, the trade API keeps its own", async () => {
  const serve = fs.readFileSync(fileURLToPath(new URL("../../serve.js", import.meta.url)), "utf8");
  assert.ok(serve.includes('route === "hook-reviews" || route.startsWith("hook-reviews/") || route === "hooks/approved"'));
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(fs.readFileSync(fileURLToPath(new URL("../_reviews.js", import.meta.url)), "utf8")), "the module is plain ASCII");
});

test("submit: the handles and the contact are optional; a handle is kept as @name whatever way it was written", async () => {
  const h = harness();
  const { q, sig } = await paidQuote(h);
  const body = { id: q.id, signature: sig, name: FIELDS.name, repo: FIELDS.repo, commit: COMMIT, description: FIELDS.description };
  const out = await h.svc.submit(body);
  assert.equal(out.status, 201, "no handle and no contact: the Discord ticket is the way in");
  let r = JSON.parse(fs.readFileSync(h.file, "utf8")).requests[q.id];
  assert.deepEqual([r.x, r.telegram, r.contact], ["", "", ""]);
  await tick();
  assert.ok(h.told[0].message.includes("Discord ticket") && !/^(X|Telegram|Contact): /m.test(h.told[0].message), "the owner's message names only the ways given");
  const b = await paidQuote(h);
  await h.svc.submit({ id: b.q.id, signature: b.sig, name: FIELDS.name, repo: FIELDS.repo, commit: COMMIT, description: FIELDS.description, x: "https://x.com/Dev_1/", telegram: "t.me/alice_dev", contact: "" });
  r = JSON.parse(fs.readFileSync(h.file, "utf8")).requests[b.q.id];
  assert.deepEqual([r.x, r.telegram, r.contact], ["@Dev_1", "@alice_dev", ""]);
  for (const [v, want] of [["dev_1", "@dev_1"], ["@dev_1", "@dev_1"], ["twitter.com/dev_1", "@dev_1"], ["", ""]]) assert.equal(checkXHandle(v), want, v);
  for (const [v, want] of [["alice_dev", "@alice_dev"], ["@alice_dev", "@alice_dev"], ["https://t.me/alice_dev", "@alice_dev"], [undefined, ""]]) assert.equal(checkTelegramHandle(v), want, String(v));
  h.cleanup();
});
