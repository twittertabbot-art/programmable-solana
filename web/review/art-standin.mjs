// A local stand-in for the permanent storage a launcher pays to hold a collection (Arweave
// through ArDrive Turbo on the live site), and for the gateway that serves it. It lets the whole
// "your pictures" and "your layers" launch run on this machine with the local chain: nothing
// goes to a public network.
//
//   node web/review/art-standin.mjs [--port 8792] [--dir <folder>] [--rpc http://127.0.0.1:8899]
//   Environment: STANDIN_PORT, STANDIN_DIR (default: <system temp>/programmable-art-standin),
//   STANDIN_RPC, STANDIN_LAMPORTS_PER_MIB (default 792000, about Turbo's price in October 2026),
//   STANDIN_LAMPORTS_PER_FILE (default 3000, Turbo's fixed charge per file).
//   Then start the site with ART_STORE=local ART_STANDIN_URL=http://127.0.0.1:8792.
//
// It works the way the real store does for the page (web/js/art-store.js, kind "local"):
//   GET  /info                     { deposit, gateway, lamportsPerMiB, lamportsPerFile }
//   GET  /price?bytes=N&files=K    { lamports }: what K files of N bytes in all cost
//   GET  /balance?address=A        { lamports }: what A has paid in and not spent
//   POST /fund { signature }       reads that transaction on the LOCAL chain: a SOL transfer to
//                                  the deposit address is credited to the address its memo names
//                                  ("turboCreditDestinationAddress=<address>"), else to its sender.
//                                  A signature counts once. 202 { pending } while it is not visible.
//   POST /upload (the file's bytes) headers content-type, x-owner (base58 key), x-signature
//                                  (base64 ed25519 signature of sha256("programmable-standin-v1\n"
//                                  + content type + "\n" + hex sha256 of the bytes)), x-path. The
//                                  price of the file is taken from the owner's balance (402 when it
//                                  is short). The id is base64url(sha256(signature)), 43 characters,
//                                  as on Arweave, so the same file sent again by the same key is the
//                                  same id and is not charged twice.
//   GET  /<id>                     the file, with its content type
//   GET  /<id>/<path>              when <id> is a path manifest ({ "manifest": "arweave/paths",
//                                  "version": "0.2.0", "paths": { "<path>": { "id" } } }, content type
//                                  application/x.arweave-manifest+json): the file at that path
// It also speaks ArDrive Turbo's own protocol, so the real Turbo store (web/js/art-store-turbo.js,
// the @ardrive/turbo-sdk code) runs against this machine: start the site with ART_STORE=turbo
// ART_NODE=http://127.0.0.1:8792/turbo/upload ART_PAYMENT=http://127.0.0.1:8792/turbo/payment
// ART_GATEWAYS=http://127.0.0.1:8792.
//   GET  /turbo/payment/v1/info, /price/bytes/<n>, /price/solana/<lamports>,
//        /account/balance/solana?address=      prices and balances in winc, as Turbo answers
//   POST /turbo/payment/v1/account/balance/solana { tx_id }   the same reading of the local chain
//   POST /turbo/upload/v1/tx/solana            an ANS-104 data item (signature type 4: ed25519
//        over the hex of its deep hash); the signature is checked, the price is taken, the item's
//        data is kept with its Content-Type tag and served by the gateway above. Larger files
//        (over 10 MiB) go through Turbo's chunked upload, which the stand-in does not have.
//   POST /_control { failUploads, failPaths, failAfter, failCount, gatewayDown, slowMs }   for
//                                  tests: the next `failUploads` uploads (or those whose x-path is
//                                  in failPaths) answer 500; with failAfter N and failCount K, N
//                                  more uploads go through and the K after them answer 500 (each
//                                  retry counts); gatewayDown makes every gateway read answer 503;
//                                  slowMs delays every gateway read. GET /_control shows it.
// Every answer carries access-control-allow-origin: *. It listens on 127.0.0.1 only.
// --irys-port <port> answers Irys's protocol at that port's root (Irys asks for absolute paths):
//   GET /info, /price/solana/<bytes> (plain lamports), /account/balance/solana?address=;
//   POST /account/balance/solana { tx_id } (the same reading of the local chain, sender credited);
//   POST /tx/solana: a data item signed by the wallet (type 4) holding a binary bundle of items
//   signed by Irys's throwaway RSA key (type 1); every signature is checked, the bundle's price is
//   taken from the wallet's balance, and the items (with the "irys/paths" manifest) are served by
//   the gateway above under their base58 ids. Start the site with ART_STORE=irys
//   ART_NODE=http://127.0.0.1:<irys port> ART_GATEWAYS=http://127.0.0.1:8792.
// --h2-port <port> also serves everything over HTTPS with HTTP/2, with a throwaway self-signed
// certificate made by openssl in the stand-in's folder: Chrome and Edge send Turbo's uploads as a
// streamed body, which they only do over HTTP/2 (the real upload service has it). A browser test
// then starts Edge with --ignore-certificate-errors (web/review/art-store-browser.mjs --h2).
import http from "node:http";
import http2 from "node:http2";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const arg = (name) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : undefined; };
const PORT = Number(arg("port") || process.env.STANDIN_PORT || 8792);
const DIR = path.resolve(arg("dir") || process.env.STANDIN_DIR || path.join(os.tmpdir(), "programmable-art-standin"));
const RPC = String(arg("rpc") || process.env.STANDIN_RPC || "http://127.0.0.1:8899");
const PER_MIB = BigInt(process.env.STANDIN_LAMPORTS_PER_MIB || 792000);
const PER_FILE = BigInt(process.env.STANDIN_LAMPORTS_PER_FILE || 3000);
const MAX_FILE = 64 * 1048576;
const MEMO = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
const MANIFEST_TYPE = "application/x.arweave-manifest+json";

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC)) {
  console.error("The stand-in reads payments only from a chain on this machine (http://127.0.0.1:<port>), not " + RPC + ".");
  process.exit(1);
}

const A58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ""; while (n > 0n) { s = A58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
function b58decode(s) {
  let n = 0n; for (const c of s) { const i = A58.indexOf(c); if (i < 0) throw new Error("not base58"); n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
}
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

fs.mkdirSync(path.join(DIR, "items"), { recursive: true });
const STATE_FILE = path.join(DIR, "state.json");
let state = { deposit: "", balances: {}, funds: {}, items: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch (_) { /* a new folder */ }
if (!state.deposit) state.deposit = b58encode(crypto.randomBytes(32));
const save = () => { const tmp = STATE_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, STATE_FILE); };
save();
// failAfter: let that many more uploads through, then fail the next failCount ones (any store)
const control = { failUploads: 0, failPaths: [], failAfter: -1, failCount: 0, gatewayDown: false, slowMs: 0 };
/// Should this upload fail on purpose? Counts down failAfter, then failCount.
function failNow() {
  if (control.failUploads > 0) { control.failUploads--; return true; }
  if (control.failAfter > 0) { control.failAfter--; return false; }
  if (control.failAfter === 0 && control.failCount > 0) { control.failCount--; return true; }
  return false;
}

const priceOf = (bytes, files) => PER_FILE * BigInt(files) + (BigInt(bytes) * PER_MIB + 1048575n) / 1048576n;
const balanceOf = (a) => BigInt(state.balances[a] || "0");

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-owner, x-signature, x-path", "access-control-allow-methods": "GET, HEAD, POST, OPTIONS", "cache-control": "no-store", "content-type": isBuf ? "application/octet-stream" : "application/json; charset=utf-8", ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > cap) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

/// Credits a SOL transfer to the deposit address, read from the local chain.
async function fund(signature) {
  if (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return [400, { error: "Send { signature } of the transfer." }];
  if (state.funds[signature]) return [200, { ...state.funds[signature], again: true, balance: String(balanceOf(state.funds[signature].address)) }];
  const tx = await rpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  if (!tx) return [202, { pending: true, error: "The transaction is not visible yet. Ask again in a moment." }];
  if (tx.meta && tx.meta.err) return [409, { error: "That transaction failed on chain." }];
  const ixs = tx.transaction.message.instructions || [];
  let lamports = 0n, sender = "", memo = "";
  for (const ix of ixs) {
    if (ix.program === "system" && ix.parsed && ix.parsed.type === "transfer" && ix.parsed.info.destination === state.deposit) { lamports += BigInt(ix.parsed.info.lamports); sender = ix.parsed.info.source; }
    if (MEMO.has(ix.programId) && typeof ix.parsed === "string") memo = ix.parsed;
  }
  if (lamports === 0n) return [409, { error: "That transaction pays nothing to the deposit address " + state.deposit + "." }];
  const m = /^turboCreditDestinationAddress=([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(memo.trim());
  const address = m ? m[1] : sender;
  state.balances[address] = String(balanceOf(address) + lamports);
  state.funds[signature] = { address, lamports: String(lamports), at: Date.now() };
  save();
  return [200, { address, lamports: String(lamports), balance: state.balances[address] }];
}

function verify(owner, signatureB64, message) {
  try {
    const pub = b58decode(owner);
    if (pub.length !== 32) return false;
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(pub) }, format: "jwk" });
    const sig = Buffer.from(signatureB64, "base64");
    return sig.length === 64 && crypto.verify(null, message, key, sig);
  } catch (_) { return false; }
}

async function upload(req) {
  const owner = String(req.headers["x-owner"] || ""), sigB64 = String(req.headers["x-signature"] || ""), type = String(req.headers["content-type"] || "application/octet-stream").slice(0, 100), p = String(req.headers["x-path"] || "").slice(0, 200);
  const body = await readBody(req, MAX_FILE);
  if ((p && control.failPaths.includes(p)) || failNow()) return [500, { error: "The stand-in was told to fail this upload." }];
  const message = sha256(Buffer.from("programmable-standin-v1\n" + type + "\n" + sha256(body).toString("hex")));
  if (!verify(owner, sigB64, message)) return [401, { error: "The signature does not match the owner and the file." }];
  const id = b64url(sha256(Buffer.from(sigB64, "base64")));
  if (state.items[id]) return [200, { id, owner, charged: "0", balance: String(balanceOf(owner)), again: true }];
  const cost = priceOf(body.length, 1);
  const have = balanceOf(owner);
  if (have < cost) return [402, { error: "Not enough paid in: this file costs " + cost + " lamports and the balance is " + have + ".", need: String(cost), balance: String(have) }];
  fs.writeFileSync(path.join(DIR, "items", id + ".bin"), body);
  state.balances[owner] = String(have - cost);
  state.items[id] = { type, bytes: body.length, owner, path: p, at: Date.now() };
  save();
  return [200, { id, owner, charged: String(cost), balance: state.balances[owner] }];
}

// ---- ArDrive Turbo's protocol ------------------------------------------------------------------------

// Turbo's numbers in October 2026: a fixed charge per item, a price per byte, winc per lamport.
const WINC_FIXED = 5024078n, WINC_PER_BYTE = 13377n, WINC_PER_LAMPORT = 17768n;
const wincOf = (address) => BigInt((state.winc || {})[address] || "0");
const wincPrice = (bytes) => WINC_FIXED + BigInt(bytes) * WINC_PER_BYTE;
const sha384 = (b) => crypto.createHash("sha384").update(b).digest();
/// Arweave's deep hash: what an ANS-104 data item's signature covers.
function deepHash(x) {
  if (Array.isArray(x)) {
    let acc = sha384(Buffer.concat([Buffer.from("list"), Buffer.from(String(x.length))]));
    for (const c of x) acc = sha384(Buffer.concat([acc, deepHash(c)]));
    return acc;
  }
  return sha384(Buffer.concat([sha384(Buffer.concat([Buffer.from("blob"), Buffer.from(String(x.length))])), sha384(x)]));
}
/// Avro array of { name: bytes, value: bytes }, as ANS-104 stores tags.
function readTags(b) {
  let at = 0;
  const long = () => { let n = 0n, shift = 0n, byte; do { byte = b[at++]; n |= BigInt(byte & 0x7f) << shift; shift += 7n; } while (byte & 0x80); return Number((n >> 1n) ^ -(n & 1n)); };
  const bytes = () => { const n = long(); const v = b.subarray(at, at + n); at += n; return v; };
  const tags = [];
  for (;;) {
    let count = long();
    if (count === 0) break;
    if (count < 0) { count = -count; long(); }
    for (let i = 0; i < count; i++) tags.push({ name: bytes().toString("utf8"), value: bytes().toString("utf8") });
  }
  return tags;
}
/// Reads and checks an ANS-104 data item signed by a Solana key (signature type 4) or, inside an
/// Irys bundle, by an Arweave RSA key (type 1, RSA-PSS with SHA-256).
function readDataItem(b, types = [4]) {
  if (b.length < 2 + 64 + 32 + 2 + 16) throw new Error("too short for a data item");
  const type = b.readUInt16LE(0);
  if (!types.includes(type)) throw new Error("signature type " + type + " is not taken here");
  const [sigLen, ownerLen] = type === 1 ? [512, 512] : [64, 32];
  const sig = b.subarray(2, 2 + sigLen), owner = b.subarray(2 + sigLen, 2 + sigLen + ownerLen);
  let at = 2 + sigLen + ownerLen;
  const target = b[at] === 1 ? b.subarray(at + 1, at + 33) : Buffer.alloc(0); at += b[at] === 1 ? 33 : 1;
  const anchor = b[at] === 1 ? b.subarray(at + 1, at + 33) : Buffer.alloc(0); at += b[at] === 1 ? 33 : 1;
  const tagCount = Number(b.readBigUInt64LE(at)), tagBytes = Number(b.readBigUInt64LE(at + 8)); at += 16;
  const rawTags = b.subarray(at, at + tagBytes); at += tagBytes;
  const data = b.subarray(at);
  const tags = tagCount ? readTags(rawTags) : [];
  const hash = deepHash([Buffer.from("dataitem"), Buffer.from("1"), Buffer.from(String(type)), owner, target, anchor, rawTags, data]);
  if (type === 1) {
    const key = crypto.createPublicKey({ key: { kty: "RSA", n: b64url(owner), e: "AQAB" }, format: "jwk" });
    if (!crypto.verify("sha256", hash, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig)) throw new Error("a bundled item's RSA signature does not match");
    return { id: b58encode(sha256(sig)), owner: b64url(sha256(owner)), tags, data, sig };
  }
  const ownerB58 = b58encode(owner);
  if (!verify(ownerB58, sig.toString("base64"), Buffer.from(hash.toString("hex")))) throw new Error("the data item's signature does not match its owner");
  return { id: b64url(sha256(sig)), b58id: b58encode(sha256(sig)), owner: ownerB58, tags, data, sig };
}
/// The items of an ANS-104 binary bundle: a count, then a size and an id per item, then the items.
function readBundle(b) {
  const n = Number(b.readBigUInt64LE(0));
  if (n > 100000 || 32 + n * 64 > b.length) throw new Error("not a bundle");
  const items = [];
  let at = 32 + n * 64;
  for (let i = 0; i < n; i++) {
    const size = Number(b.readBigUInt64LE(32 + i * 64));
    items.push(readDataItem(b.subarray(at, at + size), [1, 4]));
    at += size;
  }
  return items;
}

// ---- Irys's protocol (on its own port: Irys asks for absolute paths such as /tx/solana) -------------

async function irys(req, res) {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;
  const ok = (body, status = 200) => send(res, status, body);
  if (req.method === "OPTIONS") return send(res, 204, {}, req.headers["access-control-request-headers"] ? { "access-control-allow-headers": String(req.headers["access-control-request-headers"]) } : {});
  if (p === "/info" || p === "/") return ok({ version: "stand-in", addresses: { solana: state.deposit }, gateway: "127.0.0.1:" + PORT });
  let m;
  if ((m = /^\/price\/solana\/(\d+)$/.exec(p))) { res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" }); return res.end(String(priceOf(Number(m[1]), 1))); }
  if (p === "/account/balance/solana" && req.method === "GET") return ok({ balance: String(balanceOf(String(u.searchParams.get("address") || ""))) });
  if (p === "/account/balance/solana" && req.method === "POST") {
    let body; try { body = JSON.parse((await readBody(req, 10000)).toString("utf8")); } catch (_) { return ok({ error: "Send JSON." }, 400); }
    const [status, out] = await fund(body && body.tx_id);
    return status === 200 ? ok({ confirmed: true, ...out }) : ok(out, status === 202 ? 404 : status);
  }
  if (p === "/tx/solana" && req.method === "POST") {
    const body = await readBody(req, MAX_FILE);
    if (failNow()) return ok({ error: "The stand-in was told to fail this upload." }, 500);
    let outer, items;
    try {
      outer = readDataItem(body, [4]);
      if (!outer.tags.some((t) => t.name === "Bundle-Format" && t.value === "binary")) throw new Error("only folder bundles are taken here");
      items = readBundle(outer.data);
    } catch (e) { return ok({ error: "Invalid upload: " + e.message }, 400); }
    const cost = priceOf(body.length, 1), have = balanceOf(outer.owner);
    if (have < cost) return ok("Not enough balance for transaction", 402);
    for (const it of items) {
      const type = (it.tags.find((t) => t.name.toLowerCase() === "content-type") || {}).value || "application/octet-stream";
      fs.writeFileSync(path.join(DIR, "items", it.id + ".bin"), it.data);
      state.items[it.id] = { type, bytes: it.data.length, owner: it.owner, path: "", at: Date.now() };
    }
    state.balances[outer.owner] = String(have - cost);
    save();
    return ok({ id: outer.b58id, timestamp: Date.now(), version: "1.0.0", public: outer.owner, signature: b64url(outer.sig), deadlineHeight: 0, validatorSignatures: [] });
  }
  return ok({ error: "Not an Irys path the stand-in knows." }, 404);
}

async function turbo(req, res, u) {
  const p = u.pathname;
  const ok = (body, status = 200) => send(res, status, body);
  if (p === "/turbo/payment/v1/info") return ok({ addresses: { solana: state.deposit } });
  let m;
  if ((m = /^\/turbo\/payment\/v1\/price\/bytes\/(\d+)$/.exec(p))) return ok({ winc: String(wincPrice(m[1])), adjustments: [] });
  if ((m = /^\/turbo\/payment\/v1\/price\/solana\/(\d+)$/.exec(p))) return ok({ winc: String(BigInt(m[1]) * WINC_PER_LAMPORT), fees: [], actualPaymentAmount: Number(m[1]) });
  if (p === "/turbo/payment/v1/account/balance/solana" && req.method === "GET") {
    const w = wincOf(String(u.searchParams.get("address") || ""));
    if (w === 0n) return ok({ error: "User Not Found" }, 404);
    return ok({ winc: String(w), controlledWinc: String(w), effectiveBalance: String(w), givenApprovals: [], receivedApprovals: [] });
  }
  if (p === "/turbo/payment/v1/account/balance/solana" && req.method === "POST") {
    let body; try { body = JSON.parse((await readBody(req, 10000)).toString("utf8")); } catch (_) { return ok({ error: "Send JSON." }, 400); }
    const before = state.funds[body && body.tx_id];
    const [status, out] = await fund(body && body.tx_id);
    if (status !== 200) return ok({ error: out.error }, status === 202 ? 404 : status);
    // the credit of a Turbo payment is in winc, to the same address
    state.winc = state.winc || {};
    if (!before) {
      const lamports = BigInt(out.lamports);
      state.balances[out.address] = String(balanceOf(out.address) - lamports);
      state.winc[out.address] = String(wincOf(out.address) + lamports * WINC_PER_LAMPORT);
      save();
    }
    const f = state.funds[body.tx_id];
    return ok({ creditedTransaction: { transactionId: body.tx_id, transactionQuantity: f.lamports, transactionSenderAddress: f.address, destinationAddress: f.address, winstonCreditAmount: String(BigInt(f.lamports) * WINC_PER_LAMPORT), tokenType: "solana", blockHeight: 0 } });
  }
  if (p === "/turbo/upload/v1/tx/solana" && req.method === "POST") {
    const body = await readBody(req, MAX_FILE);
    if (failNow()) return ok({ error: "The stand-in was told to fail this upload." }, 500);
    let item;
    try { item = readDataItem(body); } catch (e) { return ok({ error: "Invalid data item: " + e.message }, 400); }
    const type = (item.tags.find((t) => t.name.toLowerCase() === "content-type") || {}).value || "application/octet-stream";
    const receipt = { id: item.id, owner: item.owner, dataCaches: ["standin"], fastFinalityIndexes: ["standin"], deadlineHeight: 0, timestamp: Date.now(), version: "0.2.0", signature: b64url(item.sig) };
    if (state.items[item.id]) return ok({ ...receipt, winc: "0" });
    const cost = wincPrice(body.length);
    const have = wincOf(item.owner);
    if (have < cost) return ok({ error: "Insufficient balance" }, 402);
    fs.writeFileSync(path.join(DIR, "items", item.id + ".bin"), item.data);
    state.winc[item.owner] = String(have - cost);
    state.items[item.id] = { type, bytes: item.data.length, owner: item.owner, path: "", at: Date.now(), tags: item.tags };
    save();
    return ok({ ...receipt, winc: String(cost) });
  }
  return ok({ error: "Not a Turbo path the stand-in knows." }, 404);
}

/// The gateway: an item, or a file of a path manifest.
async function gateway(req, res, parts) {
  if (control.slowMs) await new Promise((r) => setTimeout(r, control.slowMs));
  if (control.gatewayDown) return send(res, 503, { error: "The stand-in gateway was told to be down." });
  const id = parts[0];
  const item = state.items[id];
  if (!item) return send(res, 404, { error: "No such item." });
  let target = id, meta = item;
  const isManifest = item.type.startsWith(MANIFEST_TYPE) || item.type.startsWith("application/x.irys-manifest+json");
  if (parts.length > 1 || isManifest) {
    if (!isManifest) return send(res, 404, { error: "Not a folder." });
    let man;
    try { man = JSON.parse(fs.readFileSync(path.join(DIR, "items", id + ".bin"), "utf8")); } catch (_) { return send(res, 500, { error: "Broken manifest." }); }
    if (man.manifest !== "arweave/paths" && man.manifest !== "irys/paths") return send(res, 404, { error: "Not a path manifest." });
    let want;
    try { want = parts.length > 1 ? parts.slice(1).map(decodeURIComponent).join("/") : man.index && man.index.path; } catch (_) { return send(res, 400, { error: "bad path" }); }
    const entry = want && man.paths && man.paths[want];
    if (!entry || !state.items[entry.id]) return send(res, 404, { error: "Unable to find that path in the folder." });
    target = entry.id; meta = state.items[entry.id];
  }
  const bytes = fs.readFileSync(path.join(DIR, "items", target + ".bin"));
  res.writeHead(200, { "access-control-allow-origin": "*", "content-type": meta.type, "content-length": bytes.length, "cache-control": "public, max-age=60" });
  res.end(req.method === "HEAD" ? undefined : bytes);
}

async function handle(req, res) {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    if (req.method === "OPTIONS") return send(res, 204, {}, req.headers["access-control-request-headers"] ? { "access-control-allow-headers": String(req.headers["access-control-request-headers"]), "access-control-max-age": "600" } : {});
    const parts = u.pathname.split("/").filter(Boolean);
    if (u.pathname === "/info") return send(res, 200, { name: "local stand-in", deposit: state.deposit, gateway: "http://127.0.0.1:" + PORT, lamportsPerMiB: String(PER_MIB), lamportsPerFile: String(PER_FILE) });
    if (u.pathname === "/price") {
      const bytes = Number(u.searchParams.get("bytes")), files = Number(u.searchParams.get("files") || 1);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(files) || files < 0) return send(res, 400, { error: "bytes and files must be whole numbers." });
      return send(res, 200, { lamports: String(priceOf(bytes, files)) });
    }
    if (u.pathname === "/balance") return send(res, 200, { lamports: String(balanceOf(String(u.searchParams.get("address") || ""))) });
    if (u.pathname === "/fund" && req.method === "POST") {
      let body; try { body = JSON.parse((await readBody(req, 10000)).toString("utf8")); } catch (_) { return send(res, 400, { error: "Send JSON." }); }
      const [status, out] = await fund(body && body.signature);
      return send(res, status, out);
    }
    if (u.pathname === "/upload" && req.method === "POST") { const [status, out] = await upload(req); return send(res, status, out); }
    if (u.pathname.startsWith("/turbo/")) return turbo(req, res, u);
    if (u.pathname === "/_control") {
      if (req.method === "POST") { const b = JSON.parse((await readBody(req, 10000)).toString("utf8") || "{}"); for (const k of Object.keys(control)) if (k in b) control[k] = b[k]; }
      return send(res, 200, control);
    }
    if ((req.method === "GET" || req.method === "HEAD") && parts.length >= 1 && /^[A-Za-z0-9_-]{32,44}$/.test(parts[0])) return gateway(req, res, parts);
    return send(res, 404, { error: "Not a stand-in path." });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || "failed" });
  }
}
http.createServer(handle).listen(PORT, "127.0.0.1", () => console.log("art storage stand-in on http://127.0.0.1:" + PORT + ", files in " + DIR + ", deposit " + state.deposit + ", payments read from " + RPC));
const IRYS = Number(arg("irys-port") || 0);
if (IRYS) {
  http.createServer((req, res) => irys(req, res).catch((e) => { if (!res.headersSent) send(res, e.status || 500, { error: e.message || "failed" }); }))
    .listen(IRYS, "127.0.0.1", () => console.log("and Irys's protocol on http://127.0.0.1:" + IRYS));
}
const H2 = Number(arg("h2-port") || 0);
if (H2) {
  const key = path.join(DIR, "h2-key.pem"), cert = path.join(DIR, "h2-cert.pem");
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "30", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    if (r.status !== 0) { console.error("openssl could not make the test certificate; --h2-port needs it."); process.exit(1); }
  }
  http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), allowHTTP1: true }, handle)
    .listen(H2, "127.0.0.1", () => console.log("and over HTTPS with HTTP/2 on https://127.0.0.1:" + H2 + " (self-signed, for browser tests only)"));
}
