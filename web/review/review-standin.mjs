// Review tool: a stand-in for the hook review API (web/api/_reviews.js, API.md "Hook reviews"),
// for a site check on the local validator. It answers the contract the review page calls and
// passes every other request on to the site, so the pages it serves are the site's own files:
//   node web/review/review-standin.mjs [--port 8796] [--site http://localhost:8787] [--rpc http://127.0.0.1:8899] [--sol-usd 150]
// or, from a review tool: import { startReviewStandin } from "./review-standin.mjs".
//
//   GET  /api/v1/hook-reviews/price            { usd, solUsd, lamports, treasury, source, at }
//   POST /api/v1/hook-reviews/quote  {wallet}  { id, wallet, lamports, usd, solUsd, treasury, memo, expiresAt }
//   POST /api/v1/hook-reviews        {id, signature, name, repo, commit, description, x?, telegram?}
//                                              { id, status, statusText }, 409 NOT_CONFIRMED_YET
//   GET  /api/v1/hook-reviews/<id>             the public view (never the handles, never the description)
//   POST /api/v1/hook-reviews/<id>/program {program, signature}
//   GET  /api/v1/hooks/approved                { required, programs, corrupt }
// Errors are { error: { code, message } }. The payment is read from the local chain and checked
// the way the contract says: the quote's wallet pays the platform's treasury at least the quoted
// lamports, with a memo that is exactly the quote's memo, in a transaction that succeeded.
//
// What a review tool can set, on this stand-in only (never part of the real API):
//   POST /__standin/config  { priceDown, notConfirmedTimes, solUsd, failNextSubmit }   the price
//        fails with 503; the next N submits answer NOT_CONFIRMED_YET whatever the chain says;
//        another price; the next submit fails with { status, code, message }
//   POST /__standin/set     { id, status, note, report }   what the owner's command line does
//   GET  /__standin/state   how often each endpoint was called, and every stored request in full
// It keeps everything in memory. Stop it by its process id, or close() it.
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { HookpoolClient } from "../../sdk/dist/index.js";

export const STATUS_TEXT = {
  waiting: "Paid. Waiting for a reviewer.",
  "in-review": "A reviewer is reading the code.",
  "changes-needed": "The code needs changes before it can pass. See the note.",
  passed: "The code passed the review. Deploy exactly this commit, freeze it, then give the program id below.",
  checking: "Programmable is checking the program on chain.",
  approved: "Approved. The hook is on the approved list and appears under Custom hooks.",
  rejected: "Not approved. See the note.",
};
const MEMO_PROGRAMS = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function fromBase58(s) {
  let n = 0n;
  for (const c of String(s)) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of String(s)) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
const clean = (v) => String(v === undefined || v === null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

export async function startReviewStandin({ port = 0, site = "http://localhost:8787", rpc = "http://127.0.0.1:8899", solUsd = 150 } = {}) {
  const conn = new Connection(rpc, "confirmed");
  const client = new HookpoolClient(conn);
  const cfg = { priceDown: false, notConfirmedTimes: 0, solUsd, failNextSubmit: null };
  const calls = { price: 0, quote: 0, submit: 0, view: 0, program: 0, approved: 0, proxied: 0 };
  const quotes = new Map(), requests = new Map(), usedSignatures = new Set();
  const treasury = async () => (await client.platform()).treasury;
  const lamportsNow = () => { const raw = Math.ceil((25 / cfg.solUsd) * 1e9); return BigInt(Math.ceil(raw / 1000) * 1000); };
  const view = (r) => ({ id: r.id, name: r.name, repo: r.repo, commit: r.commit, status: r.status, statusText: STATUS_TEXT[r.status], note: r.note, program: r.program, report: r.report, createdAt: r.createdAt, updatedAt: r.updatedAt, paid: { signature: r.paid.signature, lamports: r.paid.lamports } });
  const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

  function checkFields(b) {
    const name = clean(b.name), repo = clean(b.repo), commit = clean(b.commit), description = clean(b.description), x = clean(b.x), telegram = clean(b.telegram);
    if (!name || name.length > 32 || !/^[\x20-\x7E]+$/.test(name)) throw fail(400, "BAD_NAME", "The name must be 1 to 32 plain characters.");
    if (repo.length > 200 || !/^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw fail(400, "BAD_REPO", "The repository must be an https address on github.com, gitlab.com or codeberg.org.");
    if (!/^[0-9a-f]{40}$/.test(commit)) throw fail(400, "BAD_COMMIT", "The commit must be 40 lowercase hex characters.");
    if (!description || description.length > 2000) throw fail(400, "BAD_DESCRIPTION", "The description must be 1 to 2,000 characters.");
    if (x && !/^@[A-Za-z0-9_]{1,15}$/.test(x)) throw fail(400, "INVALID_PARAMETER", "x must be an X handle.");
    if (telegram && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegram)) throw fail(400, "INVALID_PARAMETER", "telegram must be a Telegram username.");
    return { name, repo, commit, description, x, telegram };
  }

  async function paymentOf(q, signature) {
    if (cfg.notConfirmedTimes > 0) { cfg.notConfirmedTimes -= 1; throw fail(409, "NOT_CONFIRMED_YET", "The payment is not confirmed yet. Try again in a few seconds."); }
    const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) throw fail(409, "NOT_CONFIRMED_YET", "The payment is not confirmed yet. Try again in a few seconds.");
    if (tx.meta && tx.meta.err) throw fail(400, "PAYMENT_FAILED", "That transaction failed on chain.");
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const wallet = new PublicKey(q.wallet), to = await treasury();
    if (!keys.get(0).equals(wallet)) throw fail(400, "WRONG_WALLET", "The fee was not paid by the wallet of the quote.");
    let paid = 0n, memo = false;
    for (const ix of tx.transaction.message.compiledInstructions) {
      const program = keys.get(ix.programIdIndex).toBase58(), data = Buffer.from(ix.data);
      if (program === SystemProgram.programId.toBase58() && data.length >= 12 && data.readUInt32LE(0) === 2) {
        const from = keys.get(ix.accountKeyIndexes[0]), dest = keys.get(ix.accountKeyIndexes[1]);
        if (from.equals(wallet) && dest.equals(to)) paid += data.readBigUInt64LE(4);
      }
      if (MEMO_PROGRAMS.includes(program) && data.toString("utf8") === q.memo) memo = true;
    }
    if (paid < q.lamports) throw fail(400, "UNDERPAID", "The transaction pays less than the quote.");
    if (!memo) throw fail(400, "WRONG_MEMO", "The transaction does not carry the memo of the quote.");
    return { signature, lamports: String(paid), slot: tx.slot, blockTime: tx.blockTime };
  }

  async function route(req, u, body) {
    const p = u.pathname.replace(/\/+$/, "");
    if (p === "/api/v1/hook-reviews/price" && req.method === "GET") {
      calls.price++;
      if (cfg.priceDown) throw fail(503, "PRICE_UNAVAILABLE", "The SOL price could not be read. Try again in a minute.");
      return { usd: 25, solUsd: cfg.solUsd, lamports: String(lamportsNow()), treasury: (await treasury()).toBase58(), source: "stand-in", at: new Date().toISOString() };
    }
    if (p === "/api/v1/hook-reviews/quote" && req.method === "POST") {
      calls.quote++;
      let wallet;
      try { wallet = new PublicKey(String(body.wallet || "")); } catch (_) { throw fail(400, "BAD_WALLET", "Give the wallet that pays, as a base58 address."); }
      const id = crypto.randomBytes(8).toString("hex");
      const q = { id, wallet: wallet.toBase58(), lamports: lamportsNow(), usd: 25, solUsd: cfg.solUsd, treasury: (await treasury()).toBase58(), memo: "programmable-review:" + id, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), used: false };
      quotes.set(id, q);
      return { ...q, lamports: String(q.lamports), used: undefined };
    }
    if (p === "/api/v1/hook-reviews" && req.method === "POST") {
      calls.submit++;
      // a failure the review tool asked for, once: the fee is paid and the request is not taken
      if (cfg.failNextSubmit) { const f = cfg.failNextSubmit; cfg.failNextSubmit = null; throw fail(f.status || 400, f.code || "STANDIN_FAIL", f.message || "The stand-in refused this request on purpose."); }
      const q = quotes.get(String(body.id || ""));
      if (!q) throw fail(404, "QUOTE_NOT_FOUND", "There is no quote with this id.");
      if (q.used) throw fail(409, "QUOTE_USED", "This quote was used for another request.");
      const fields = checkFields(body);
      const signature = String(body.signature || "");
      if (usedSignatures.has(signature)) throw fail(409, "SIGNATURE_USED", "This payment was used for another request.");
      const paid = await paymentOf(q, signature);
      q.used = true; usedSignatures.add(signature);
      const now = new Date().toISOString();
      const r = { id: q.id, wallet: q.wallet, ...fields, paid, status: "waiting", note: "", program: null, report: null, createdAt: now, updatedAt: now, history: [{ at: now, status: "waiting", note: "" }] };
      requests.set(r.id, r);
      return { id: r.id, status: r.status, statusText: STATUS_TEXT[r.status] };
    }
    const one = /^\/api\/v1\/hook-reviews\/([A-Za-z0-9_-]{1,64})(\/program)?$/.exec(p);
    if (one) {
      const r = requests.get(one[1]);
      if (!one[2] && req.method === "GET") { calls.view++; if (!r) throw fail(404, "NOT_FOUND", "There is no review request with this id."); return view(r); }
      if (one[2] && req.method === "POST") {
        calls.program++;
        if (!r) throw fail(404, "NOT_FOUND", "There is no review request with this id.");
        if (r.status !== "passed" && r.status !== "checking") throw fail(409, "WRONG_STATUS", "A program id can be given once the code passed the review.");
        let program;
        try { program = new PublicKey(String(body.program || "")); } catch (_) { throw fail(400, "BAD_PROGRAM", "That is not a program address."); }
        const sig = fromBase58(body.signature);
        const message = Buffer.from("Programmable hook review " + r.id + ": my program is " + program.toBase58(), "utf8");
        const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(new PublicKey(r.wallet).toBytes()).toString("base64url") }, format: "jwk" });
        if (!sig || sig.length !== 64 || !crypto.verify(null, message, key, Buffer.from(sig))) throw fail(400, "BAD_SIGNATURE", "The signature is not the wallet's that paid for this review.");
        r.program = program.toBase58(); r.status = "checking"; r.updatedAt = new Date().toISOString();
        r.history.push({ at: r.updatedAt, status: "checking", note: "program " + r.program });
        return view(r);
      }
    }
    if (p === "/api/v1/hooks/approved" && req.method === "GET") {
      calls.approved++;
      const pl = await client.platform();
      return { required: pl.hookApprovalRequired, programs: pl.approvedHooks.map((k) => k.toBase58()), corrupt: pl.approvedListCorrupt };
    }
    // the stand-in's own switches
    if (p === "/__standin/config" && req.method === "POST") { for (const k of ["priceDown", "notConfirmedTimes", "solUsd", "failNextSubmit"]) if (k in body) cfg[k] = body[k]; return { ...cfg }; }
    if (p === "/__standin/set" && req.method === "POST") {
      const r = requests.get(String(body.id || ""));
      if (!r) throw fail(404, "NOT_FOUND", "no such request");
      if (!STATUS_TEXT[body.status]) throw fail(400, "BAD_STATUS", "no such status");
      r.status = body.status; if ("note" in body) r.note = String(body.note || ""); if ("report" in body) r.report = body.report || null;
      r.updatedAt = new Date().toISOString(); r.history.push({ at: r.updatedAt, status: r.status, note: r.note });
      return view(r);
    }
    if (p === "/__standin/state" && req.method === "GET") return { calls: { ...calls }, config: { ...cfg }, quotes: [...quotes.values()].map((q) => ({ ...q, lamports: String(q.lamports) })), requests: [...requests.values()] };
    return undefined;
  }

  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, "http://localhost"); } catch (_) { res.writeHead(400); return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
    const ours = u.pathname.startsWith("/api/v1/hook-reviews") || u.pathname.startsWith("/api/v1/hooks/approved") || u.pathname.startsWith("/__standin/");
    if (ours) {
      try {
        let body = {};
        if (req.method === "POST") { try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch (_) { return json(400, { error: { code: "BAD_JSON", message: "The body is not JSON." } }); } }
        const out = await route(req, u, body && typeof body === "object" ? body : {});
        if (out === undefined) return json(404, { error: { code: "NOT_FOUND", message: "No such endpoint." } });
        return json(200, out);
      } catch (e) {
        return json(e.status || 500, { error: { code: e.code || "INTERNAL", message: e.status ? e.message : "Something went wrong in the stand-in: " + e.message } });
      }
    }
    // everything else is the site's own answer
    calls.proxied++;
    try {
      const r = await fetch(site + req.url, { method: req.method, headers: req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}, body: req.method === "GET" || req.method === "HEAD" ? undefined : raw });
      const head = {};
      for (const k of ["content-type", "cache-control", "x-content-type-options"]) { const v = r.headers.get(k); if (v) head[k] = v; }
      res.writeHead(r.status, head);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502, { "content-type": "text/plain" }); res.end("the site at " + site + " did not answer"); }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = "http://localhost:" + server.address().port;
  return { url, port: server.address().port, cfg, calls, requests, quotes, close: () => new Promise((r) => server.close(() => r())) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
  const s = await startReviewStandin({ port: Number(opt("port", "8796")), site: opt("site", "http://localhost:8787"), rpc: opt("rpc", "http://127.0.0.1:8899"), solUsd: Number(opt("sol-usd", "150")) });
  console.log("review API stand-in on " + s.url + " (process " + process.pid + "), the rest from the site");
}
