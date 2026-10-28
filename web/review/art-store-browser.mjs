// Review tool: the browser store (web/js/art-store.js, and art-store-turbo.js or art-store-irys.js
// when the site is set to them) inside a real headless Edge, on the site's own origin, against the
// local stand-in. Node pays the upload key's credit on the LOCAL chain first (the page's wallet
// part is the launch page's job, covered by flow-art.mjs); the browser then prices, reads the
// balance and uploads a small folder; Node checks what the gateway and the resolver answer.
//   node web/review/art-store-browser.mjs http://localhost:8794 [--h2 https://127.0.0.1:8795]
// The site must use the stand-in (store "local", or "turbo" pointed at the stand-in's Turbo paths).
// For "turbo", start the stand-in with --h2-port 8795 and pass --h2: Edge sends Turbo's uploads as
// a streamed body, which it does only over HTTP/2, so the page's upload node becomes the stand-in's
// HTTP/2 address (self-signed: this Edge alone ignores certificate errors).
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction, Connection, Transaction } from "@solana/web3.js";
import { startEdge } from "./edge.mjs";
import { openStore, MEMO_PROGRAM } from "../js/art-store.js";
import { checkCollection, encodeCollection, collectionArtHex, artFileUrl } from "../api/_artpack.js";
import { encodePng } from "../api/_artpng.js";

const SITE = String(process.argv[2] || "http://localhost:8794").replace(/\/+$/, "");
const RPC = "http://127.0.0.1:8899";
let checks = 0, failed = 0;
const check = (cond, msg) => { checks++; if (!cond) failed++; console.log((cond ? "  check  " : "  FAILED ") + msg); };
const LOCAL_URL = /^https?:\/\/127\.0\.0\.1:\d+(\/[\w/.-]*)?$/;
const settings = await (await fetch(SITE + "/art/settings")).json();
const h2At = process.argv.indexOf("--h2");
const H2 = h2At > 0 ? String(process.argv[h2At + 1] || "").replace(/\/+$/, "") : "";
if (![settings.node, settings.payment, ...settings.gateways, H2].filter(Boolean).every((x) => LOCAL_URL.test(x))) { console.error("The site's store is not the stand-in on this machine: nothing is sent."); process.exit(1); }
// the page uploads to the stand-in's HTTP/2 address; Node keeps the plain one
const pageSettings = H2 ? { ...settings, node: settings.node.replace(/^http:\/\/127\.0\.0\.1:\d+/, H2) } : settings;

// the folder: collection.json, a cover and two pictures
const tile = (r, g, b) => { const d = new Uint8Array(24 * 24 * 4); for (let i = 0; i < d.length; i += 4) d.set([r, g, b, 255], i); return encodePng(24, 24, d); };
const c = checkCollection({ version: 1, kind: "pictures", name: "Browser", symbol: "BRW", description: "Made in Edge.", cover: "cover.png", items: [
  { image: "img/a.png", name: "A", attributes: [{ trait_type: "Side", value: "a" }], weight: 1 },
  { image: "img/b.png", name: "B", attributes: [{ trait_type: "Side", value: "b" }], weight: 2 }] }).collection;
const files = [["collection.json", encodeCollection(c), "application/json"], ["cover.png", tile(9, 9, 9), "image/png"], ["img/a.png", tile(200, 0, 0), "image/png"], ["img/b.png", tile(0, 0, 200), "image/png"]];
const bytes = files.reduce((n, f) => n + f[1].length, 0);

// Node funds a new upload key with exactly the price, from a throwaway wallet on the local chain
const conn = new Connection(RPC, "confirmed");
const wallet = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
const pay = async (to, lamports, memo) => {
  if (!(await conn.getAccountInfo(new PublicKey(to)))) await conn.confirmTransaction(await conn.requestAirdrop(new PublicKey(to), LAMPORTS_PER_SOL), "confirmed");
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(to), lamports }));
  if (memo) tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(memo, "utf8") }));
  const sig = await conn.sendTransaction(tx, [wallet]);
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
};
// Irys: the balance is the wallet's own, and its store runs only in a browser, so Node pays the way
// the store would (a plain transfer, then the transaction id to the node). The page then signs the
// folder's one message with the same throwaway test wallet (WebCrypto Ed25519).
const IRYS = settings.store === "irys";
let session = null, jwk = null;
if (IRYS) {
  const info = await (await fetch(settings.node + "/info")).json();
  const sig = await pay(info.addresses.solana, 2_000_000);
  const r = await fetch(settings.node + "/account/balance/solana", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_id: sig }) });
  const bal = await (await fetch(settings.node + "/account/balance/solana?address=" + wallet.publicKey.toBase58())).json();
  check(r.status === 200 && BigInt(bal.balance) >= 2_000_000n, "irys: the wallet's balance at the node is paid on the local chain (" + bal.balance + " lamports)");
  const b64u = (b) => Buffer.from(b).toString("base64url");
  jwk = { kty: "OKP", crv: "Ed25519", d: b64u(wallet.secretKey.slice(0, 32)), x: b64u(wallet.publicKey.toBytes()), ext: true };
} else {
  const nodeStore = await openStore({ wallet: { publicKey: wallet.publicKey }, settings });
  const price = await nodeStore.price(bytes, files.length);
  await nodeStore.fund(price, pay);
  check((await nodeStore.balance()) >= price, settings.store + ": the upload key holds the price (" + price + " lamports), paid on the local chain");
  session = nodeStore.session;
}

const edge = await startEdge({ name: "art-store", width: 1000, height: 700, args: H2 ? ["--ignore-certificate-errors"] : [] });
let out = null;
try {
  const ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const cdp = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: SITE + "/art/settings" });
  await new Promise((r) => setTimeout(r, 1500));
  const payload = JSON.stringify({ settings: pageSettings, session, jwk, address: wallet.publicKey.toBase58(), files: files.map(([p, b, t]) => [p, Buffer.from(b).toString("base64"), t]) });
  const script = "(async () => { const a = " + payload + ";" +
    "const m = await import('/js/art-store.js');" +
    "let signed = 0; const key = a.jwk ? await crypto.subtle.importKey('jwk', a.jwk, { name: 'Ed25519' }, false, ['sign']) : null;" +
    "const signMessage = async (msg) => { signed++; return new Uint8Array(await crypto.subtle.sign('Ed25519', key, msg)); };" +
    "const store = await m.openStore({ wallet: { publicKey: a.address, signMessage }, settings: a.settings, session: a.session });" +
    "const files = a.files.map(([path, b64, type]) => ({ path, type, bytes: new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }) }));" +
    "const before = String(await store.balance());" +
    "const price = String(await store.price(files.reduce((n, f) => n + f.bytes.size, 0), files.length));" +
    "let progress = 0; const r = await store.uploadFolder(files, { onProgress: (d) => { progress = d; } });" +
    "return { kind: store.kind, same: store.session === a.session, signed, before, price, after: String(await store.balance()), progress, id: r.id, receipts: r.receipts, ua: navigator.userAgent }; })()";
  const res = await cdp("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true, timeout: 120000 });
  out = res.result && !res.result.exceptionDetails && res.result.result && res.result.result.value;
  if (!out || !out.id) { out = null; console.log("  page error: " + JSON.stringify(res.result && (res.result.exceptionDetails || res.result) || res).slice(0, 1200)); }
  ws.close();
} finally { console.log("  " + await edge.close()); }

check(out && out.kind === settings.store && out.same && /Edg\//.test(out.ua), "in Edge: the store opened with the saved session (" + (out && out.kind) + ")");
check(out && out.progress === files.length && /^[A-Za-z0-9_-]{43,44}$/.test(out.id), "in Edge: the folder uploaded, id " + (out && out.id));
check(out && out.signed === (IRYS ? 1 : 0), "in Edge: the wallet signed " + (out && out.signed) + " message(s) (" + (IRYS ? "Irys: one for the whole folder" : "none: the upload key signs") + ")");
const took = out ? BigInt(out.before) - BigInt(out.after) : -1n;
check(out && took > 0n && took <= BigInt(out.price), "in Edge: the upload took " + took + " lamports of the key's balance, within the price " + (out && out.price));
if (out && out.id) {
  for (const [p, b] of files) {
    const r = await fetch(artFileUrl(settings.gateways[0], out.id, p));
    check(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(Buffer.from(b)), "the gateway serves " + p + " of the folder byte for byte");
  }
  const cj = await fetch(SITE + "/art/u/" + out.id + "/collection.json");
  check(cj.status === 200 && cj.headers.get("x-art") === collectionArtHex(encodeCollection(c)), "the resolver reads the folder's collection.json and its art bytes");
}
console.log((failed ? "FAILED " : "passed ") + (checks - failed) + " of " + checks + " checks");
process.exitCode = failed ? 1 : 0;
