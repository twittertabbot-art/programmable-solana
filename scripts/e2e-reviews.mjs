// The review requests of Custom hooks end to end on the local validator: a fresh wallet asks
// for a quote, pays the review fee with a real transfer and memo, sends the request, reads its
// status; the owner's command line sets it to passed; the wallet signs the program message and
// the status becomes checking. On the way it proves the refusals a live chain can show
// (underpaid, a wrong memo, a used signature, a used quote, a program id too early, another
// wallet's signature), the public view without the contact, the approved list, and the log
// line of a new request when Telegram is not set.
//   node scripts/e2e-reviews.mjs [localnet]
// Local validator only: it airdrops and sends transfers. It starts its own web/serve.js on a free
// port with REVIEW_SOL_USD=150 and a store in a temporary folder, and stops only that process.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { HookpoolClient } from "../sdk/dist/index.js";
import { RPC, connection } from "./cluster.mjs";

if (process.argv[2] && process.argv[2] !== "localnet") { console.error("usage: node scripts/e2e-reviews.mjs [localnet]  (the local validator only)"); process.exit(1); }
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC.localnet)) { console.error("LOCALNET_RPC must be a local address: this script sends transactions"); process.exit(1); }
const conn = connection("localnet");
const SERVE = fileURLToPath(new URL("../web/serve.js", import.meta.url));
const CLI = fileURLToPath(new URL("./hook-reviews.mjs", import.meta.url));
const MEMO_V2 = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SOL_USD = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let checks = 0;
let server = null;
const stop = () => { if (server) { try { process.kill(server.pid); } catch (_) { /* gone */ } server = null; } };
process.on("exit", stop);
const check = (cond, msg) => {
  if (!cond) { console.error("CHECK FAILED: " + msg); stop(); process.exit(1); }
  checks++; console.log("  check  " + msg);
};
const head = (t) => console.log("\n== " + t);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
async function call(method, route, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  const r = await fetch(server.url + "/api/v1/" + route, init);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, headers: r.headers, json, text };
}
/// The ed25519 signature of the wallet over the UTF-8 bytes of `text`, as Phantom's signMessage makes it, in base58.
function signText(kp, text) {
  const key = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: Buffer.from(kp.secretKey.slice(0, 32)).toString("base64url"), x: Buffer.from(kp.publicKey.toBytes()).toString("base64url") }, format: "jwk" });
  const sig = crypto.sign(null, Buffer.from(text, "utf8"), key);
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + sig.toString("hex")); let s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of sig) { if (b === 0) s = "1" + s; else break; }
  return s;
}
/// A payment as the request page sends it: the transfer to the treasury and the memo, signed by the wallet.
async function pay(wallet, treasury, lamports, memo) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(treasury), lamports }),
    new TransactionInstruction({ programId: MEMO_V2, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo, "utf8") }),
  );
  return sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
}
/// Sends the request, again while the payment is not confirmed yet, as the page does.
async function submit(body) {
  for (let i = 0; i < 20; i++) {
    const r = await call("POST", "hook-reviews", body);
    if (!(r.status === 409 && r.json && r.json.error.code === "NOT_CONFIRMED_YET")) return r;
    await sleep(1000);
  }
  return call("POST", "hook-reviews", body);
}
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, REVIEWS_FILE: storeFile }, encoding: "utf8" });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-reviews-"));
const storeFile = path.join(tmp, "state", "hook-reviews.json");

head("the local chain");
const memoInfo = await conn.getAccountInfo(MEMO_V2);
check(!!memoInfo && memoInfo.executable, "the SPL Memo program v2 is on the local validator");
const platform = await new HookpoolClient(conn).platform();
check(!!platform, "the platform exists, treasury " + platform.treasury.toBase58() + ", approved-list rule " + (platform.hookApprovalRequired ? "on" : "off"));

head("a server of our own");
{
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), PROGRAMMABLE_CLUSTER: "localnet", PROGRAMMABLE_RPC: RPC.localnet, REVIEW_SOL_USD: String(SOL_USD), REVIEWS_FILE: storeFile };
  delete env.REVIEW_TELEGRAM_BOT_TOKEN; delete env.REVIEW_TELEGRAM_CHAT_ID; delete env.REVIEW_FEE_USD;
  const child = spawn(process.execPath, [SERVE], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  server = { pid: child.pid, port, url: "http://127.0.0.1:" + port, log: () => out };
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(server.url + "/config.js")).ok; } catch (_) { await sleep(150); } }
  check(up, "web/serve.js answers on port " + port + " (process " + child.pid + "), store " + storeFile);
}

head("price and quote");
const price = await call("GET", "hook-reviews/price");
const want = Math.ceil(Math.ceil(25 * 1e9 / SOL_USD) / 1000) * 1000;
check(price.status === 200 && price.json.usd === 25 && price.json.solUsd === SOL_USD && price.json.source === "fixed", "GET /api/v1/hook-reviews/price: 25 USD at " + SOL_USD + " USD per SOL (fixed by REVIEW_SOL_USD)");
check(price.json.lamports === want && want === 166_667_000, "the fee is " + price.json.lamports + " lamports: 25 / 150 SOL rounded up to a whole 1,000");
check(price.json.treasury === platform.treasury.toBase58(), "the treasury is the platform's, read from the chain");
const wallet = Keypair.generate();
{
  const sig = await conn.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}
check((await conn.getBalance(wallet.publicKey)) === 2 * LAMPORTS_PER_SOL, "a fresh wallet " + wallet.publicKey.toBase58() + " holds 2 SOL");
const quote = await call("POST", "hook-reviews/quote", { wallet: wallet.publicKey.toBase58() });
check(quote.status === 200 && /^[0-9a-f]{16}$/.test(quote.json.id) && quote.json.memo === "programmable-review:" + quote.json.id && quote.json.lamports === want, "POST /api/v1/hook-reviews/quote: id " + quote.json.id + ", memo " + quote.json.memo);
const minutes = (Date.parse(quote.json.expiresAt) - Date.now()) / 60000;
check(minutes > 29 && minutes <= 30, "the quote ends in 30 minutes, at " + quote.json.expiresAt);

head("the payment and the request");
const FIELDS = { name: "Rehearsal hook", repo: "https://github.com/example/rehearsal-hook", commit: "0123456789abcdef0123456789abcdef01234567", description: "A hook for the rehearsal.\nIt takes 1% on sells.", contact: "rehearsal@example.com" };
const before = await conn.getBalance(platform.treasury);
const paid = await pay(wallet, quote.json.treasury, quote.json.lamports, quote.json.memo);
check((await conn.getBalance(platform.treasury)) - before === want, "a real transfer of " + want + " lamports to the treasury with the memo, transaction " + paid);
const sent = await submit({ id: quote.json.id, signature: paid, ...FIELDS });
check(sent.status === 201 && sent.json.status === "waiting" && sent.json.statusText === "Paid. Waiting for a reviewer.", "POST /api/v1/hook-reviews: 201, " + JSON.stringify(sent.json));
let view = await call("GET", "hook-reviews/" + quote.json.id);
check(view.status === 200 && view.json.status === "waiting" && view.json.paid.signature === paid && view.json.paid.lamports === want, "GET /api/v1/hook-reviews/<id>: waiting, paid " + view.json.paid.lamports + " lamports");
check(!view.text.includes(FIELDS.contact) && !view.text.includes("rehearsal.") && view.json.description === undefined && view.json.contact === undefined, "the public view carries no contact and no description");
const again = await call("POST", "hook-reviews", { id: quote.json.id, signature: paid, ...FIELDS });
check(again.status === 200 && again.json.id === quote.json.id, "the same request sent twice: 200 and the same answer");
await sleep(300);
check(/new paid review request [0-9a-f]{16}: Rehearsal hook, https:\/\/github\.com\/example\/rehearsal-hook at 0123456789abcdef0123456789abcdef01234567, 0\.166667 SOL from /.test(server.log()) && !server.log().includes(FIELDS.contact), "with Telegram not set the server logs one line for the new request, without the contact");

head("the refusals a live chain shows");
{
  const q2 = (await call("POST", "hook-reviews/quote", { wallet: wallet.publicKey.toBase58() })).json;
  const under = await pay(wallet, q2.treasury, q2.lamports - 1000, q2.memo);
  let r = await submit({ id: q2.id, signature: under, ...FIELDS });
  check(r.status === 422 && r.json.error.code === "UNDERPAID" && r.json.error.paid === q2.lamports - 1000, "underpaid by 1,000 lamports: 422 UNDERPAID");
  const q3 = (await call("POST", "hook-reviews/quote", { wallet: wallet.publicKey.toBase58() })).json;
  const wrongMemo = await pay(wallet, q3.treasury, q3.lamports, q2.memo);
  r = await submit({ id: q3.id, signature: wrongMemo, ...FIELDS });
  check(r.status === 422 && r.json.error.code === "MEMO_MISMATCH", "the memo of another quote: 422 MEMO_MISMATCH");
  r = await call("POST", "hook-reviews", { id: q3.id, signature: paid, ...FIELDS });
  check(r.status === 409 && r.json.error.code === "SIGNATURE_USED", "the first payment sent for another quote: 409 SIGNATURE_USED");
  r = await call("POST", "hook-reviews", { id: quote.json.id, signature: under, ...FIELDS });
  check(r.status === 409 && r.json.error.code === "QUOTE_USED", "a used quote with another payment: 409 QUOTE_USED");
  r = await call("POST", "hook-reviews", { id: q3.id, signature: wrongMemo, ...FIELDS, commit: "XYZ" });
  check(r.status === 400 && r.json.error.code === "INVALID_PARAMETER" && r.json.error.parameter === "commit", "a commit that is not 40 hex characters: 400, parameter commit");
}

head("the owner's command line, then the program id");
const program = Keypair.generate().publicKey.toBase58();
const message = "Programmable hook review " + quote.json.id + ": my program is " + program;
let r = await call("POST", "hook-reviews/" + quote.json.id + "/program", { program, signature: signText(wallet, message) });
check(r.status === 409 && r.json.error.code === "WRONG_STATUS", "a program id while the request waits: 409 WRONG_STATUS");
let run = cli("list");
check(run.status === 0 && run.stdout.includes(quote.json.id) && run.stdout.includes("waiting") && run.stdout.includes("0.166667"), "hook-reviews.mjs list shows the request");
run = cli("set", quote.json.id, "passed", "The", "code", "passed.");
check(run.status === 0 && /is now passed, note: The code passed\./.test(run.stdout), "hook-reviews.mjs set " + quote.json.id + " passed: " + run.stdout.trim());
view = await call("GET", "hook-reviews/" + quote.json.id);
check(view.json.status === "passed" && view.json.note === "The code passed." && /give the program id/.test(view.json.statusText), "the server reads the owner's change at once: passed, note \"" + view.json.note + "\"");
r = await call("POST", "hook-reviews/" + quote.json.id + "/program", { program, signature: signText(Keypair.generate(), message) });
check(r.status === 403 && r.json.error.code === "SIGNATURE_INVALID", "the message signed by another wallet: 403 SIGNATURE_INVALID");
r = await call("POST", "hook-reviews/" + quote.json.id + "/program", { program, signature: signText(wallet, message) });
check(r.status === 200 && r.json.status === "checking" && r.json.program === program, "the wallet signs \"" + message + "\": " + JSON.stringify(r.json));
view = await call("GET", "hook-reviews/" + quote.json.id);
check(view.json.status === "checking" && view.json.program === program && view.json.statusText === "Programmable is checking the program on chain.", "GET status: checking, with the program id");
await sleep(300);
check(server.log().includes("program id given for review request " + quote.json.id + ": " + program), "the server logs one line for the program id");
run = cli("show", quote.json.id);
check(run.status === 0 && run.stdout.includes(FIELDS.contact) && (run.stdout.match(/^\s+20\d\d-/gm) || []).length === 3, "hook-reviews.mjs show: every field, the contact, three lines of history");
console.log(run.stdout.split("\n").filter((l) => /^(id|status|paid|program|history|\s+20\d\d-)/.test(l)).map((l) => "    " + l).join("\n"));

head("the approved list");
r = await call("GET", "hooks/approved");
check(r.status === 200 && r.json.required === platform.hookApprovalRequired && Array.isArray(r.json.programs) && r.json.corrupt === false, "GET /api/v1/hooks/approved: " + JSON.stringify(r.json));

head("the store");
const stored = JSON.parse(fs.readFileSync(storeFile, "utf8"));
check(Object.keys(stored.requests).length === 1 && Object.keys(stored.quotes).length === 2, "one request and the two open quotes in the file, outside web/");
check(!fs.existsSync(storeFile + ".lock") && fs.readdirSync(path.dirname(storeFile)).every((f) => !f.includes(".tmp")), "no lock and no temporary file left behind");
check(!/https?:\/\/127\.0\.0\.1:8899/.test(JSON.stringify([price.text, quote.text, sent.text, view.text])), "no answer carries the RPC address");

const ours = server;
stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n" + checks + " checks passed. The server on port " + ours.port + " (process " + ours.pid + ") was ours and is stopped; its store is deleted.");
