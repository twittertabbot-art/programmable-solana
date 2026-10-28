// The browser side of uploading a collection to permanent storage, paid by the launcher's wallet.
// Built alone as web/js/art-store.js; the launch page loads it with import() only when the
// launcher picks their own pictures or layers. The real services sit in their own, larger files
// that this one loads on demand: web/js/art-store-turbo.js (Arweave through ArDrive Turbo) and
// web/js/art-store-irys.js (Irys). Kind "local" talks to web/review/art-standin.mjs.
//
//   const store = await openStore({ wallet: { publicKey, signMessage }, settings, session });
//   settings: the answer of GET /art/settings on the site. session: what store.session was the
//   last time (keep it until the coin is launched: a paid balance and the receipts of a failed
//   run belong to it).
//   store.price(bytes, files)   lamports to store that many bytes in that many files, the folder's
//                               own list (one more file) included, rounded up
//   store.balance()             lamports already paid in and not spent
//   store.fund(lamports, pay)   pay(toAddress, lamports, memo?) is the page's own SOL transfer
//                               (with a Memo instruction when memo is given); the store then
//                               tells the service about it
//   store.uploadFolder(files, { onProgress, already })   -> { id, receipts }
//
// Why a throwaway key: Turbo charges the key that signs each file. Signing every file with the
// wallet would ask the launcher to approve one message per picture. The store makes a key of its
// own in the browser, the wallet's one payment credits that key (the memo names it), and the key
// signs the files. Only the upload credit is ever held by that key.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "./hash.js";

export interface ArtUploadFile { path: string; bytes: Uint8Array | Blob; type: string }
export interface ArtStoreSettings { store: "local" | "turbo" | "irys"; network?: string; node: string; gateways: string[]; uriBase?: string; maxUriBase?: number }
export interface ArtWallet { publicKey: { toBase58(): string } | string; signMessage?: (bytes: Uint8Array) => Promise<Uint8Array> }
export type ArtPay = (toAddress: string, lamports: bigint, memo?: string) => Promise<string>;
export interface ArtStore {
  kind: "local" | "turbo" | "irys";
  /// where the files are read: <gateway>/<id>/<path>
  gateway: string;
  /// keep it and pass it back as opts.session (null for irys)
  session: string | null;
  /// the address whose balance pays the upload
  payer: string;
  price(bytes: number, files?: number): Promise<bigint>;
  balance(): Promise<bigint>;
  fund(lamports: bigint, pay: ArtPay): Promise<{ signature: string }>;
  uploadFolder(files: ArtUploadFile[], opts?: { onProgress?: (done: number, total: number, path: string) => void; already?: Record<string, string> }): Promise<{ id: string; receipts: Record<string, string> }>;
}
export interface OpenStoreOptions { wallet: ArtWallet; settings: ArtStoreSettings; session?: string | null; connection?: unknown }

/// The path manifest's content type (Arweave's), and the program the payment's memo goes to.
export const MANIFEST_TYPE = "application/x.arweave-manifest+json";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ---- small helpers, shared with the real stores ------------------------------------------------------

const A58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes: Uint8Array): string {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ""; while (n > 0n) { s = A58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const i = A58.indexOf(c); if (i < 0) throw new Error("not base58"); n = n * 58n + BigInt(i); }
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const enc = new TextEncoder();
const b64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
export async function bytesOf(x: Uint8Array | Blob): Promise<Uint8Array> { return x instanceof Uint8Array ? x : new Uint8Array(await x.arrayBuffer()); }
export const addressOf = (k: ArtWallet["publicKey"]) => (typeof k === "string" ? k : k.toBase58());

/// A throwaway upload key: a Solana secret key (64 bytes, base58) and its address. `session`
/// from an earlier run is kept; anything else makes a new key.
export function sessionKey(session?: string | null): { session: string; seed: Uint8Array; address: string } {
  if (session) {
    try {
      const sk = b58decode(session);
      if (sk.length === 64) {
        const seed = sk.slice(0, 32), pub = ed25519.getPublicKey(seed);
        if (hex(pub) === hex(sk.slice(32))) return { session, seed, address: b58encode(pub) };
      }
    } catch (_) { /* a broken session: start again */ }
  }
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  const pub = ed25519.getPublicKey(seed);
  const sk = new Uint8Array(64); sk.set(seed); sk.set(pub, 32);
  return { session: b58encode(sk), seed, address: b58encode(pub) };
}
/// A receipt says which bytes went where: "<id>.<first 16 hex of their sha256>". Opaque to pages.
export const receiptOf = (id: string, bytes: Uint8Array) => id + "." + hex(sha256(bytes)).slice(0, 16);
export function receiptId(receipt: string | undefined, bytes: Uint8Array): string | null {
  if (!receipt) return null;
  const i = receipt.lastIndexOf(".");
  return i > 0 && receipt.slice(i + 1) === hex(sha256(bytes)).slice(0, 16) ? receipt.slice(0, i) : null;
}
/// About how many bytes the path manifest of `files` files takes (path and id per file), kept on
/// the high side: paths are at most 120 bytes, an id 43.
export const listBytes = (files: number) => 200 + 190 * Math.max(0, files);
/// The folder's path manifest, the form Arweave gateways read.
export function pathManifest(ids: Record<string, string>, index = "collection.json"): Uint8Array {
  const paths: Record<string, { id: string }> = {};
  for (const p of Object.keys(ids).sort()) paths[p] = { id: ids[p] };
  return enc.encode(JSON.stringify({ manifest: "arweave/paths", version: "0.2.0", index: { path: index }, paths }));
}
async function json(r: Response): Promise<any> {
  const t = await r.text();
  try { return JSON.parse(t); } catch (_) { return { error: t.slice(0, 200) }; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function failWith(message: string, receipts: Record<string, string>): Error { const e: any = new Error(message); e.receipts = { ...receipts }; return e; }

// ---- the local stand-in -------------------------------------------------------------------------------

function localStore(o: OpenStoreOptions): ArtStore {
  const node = String(o.settings.node).replace(/\/+$/, "");
  const key = sessionKey(o.session);
  let info: any = null;
  const getInfo = async () => info || (info = await json(await fetch(node + "/info")));
  return {
    kind: "local", gateway: (o.settings.gateways && o.settings.gateways[0]) || node, session: key.session, payer: key.address,
    async price(bytes, files = 1) {
      // the folder's own list is one more file; each file's price is rounded up on its own
      const n = Math.max(1, Math.ceil(files));
      const r = await fetch(node + "/price?bytes=" + (Math.max(0, Math.ceil(bytes)) + listBytes(n)) + "&files=" + (n + 1));
      const j = await json(r);
      if (!r.ok) throw new Error(j.error || "The storage price is not available.");
      return BigInt(j.lamports) + BigInt(n + 1);
    },
    async balance() { const j = await json(await fetch(node + "/balance?address=" + key.address)); return BigInt(j.lamports || 0); },
    async fund(lamports, pay) {
      const i = await getInfo();
      const signature = await pay(i.deposit, lamports, "turboCreditDestinationAddress=" + key.address);
      for (let n = 0; n < 30; n++) {
        const r = await fetch(node + "/fund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature }) });
        const j = await json(r);
        if (r.status === 200) return { signature };
        if (r.status !== 202) throw new Error(j.error || "The storage service did not take the payment.");
        await sleep(1000);
      }
      throw new Error("The payment " + signature + " is not visible to the storage service yet. Keep this page open and try again: it is not paid twice.");
    },
    async uploadFolder(files, opts = {}) {
      const receipts: Record<string, string> = {};
      const ids: Record<string, string> = {};
      const total = files.length;
      let done = 0;
      for (const f of files) {
        const bytes = await bytesOf(f.bytes);
        const known = receiptId(opts.already && opts.already[f.path], bytes);
        if (known) { ids[f.path] = known; receipts[f.path] = receiptOf(known, bytes); opts.onProgress && opts.onProgress(++done, total, f.path); continue; }
        const id = await sendLocal(node, key.seed, key.address, bytes, f.type, f.path).catch((e) => { throw failWith(e.message, receipts); });
        ids[f.path] = id; receipts[f.path] = receiptOf(id, bytes);
        opts.onProgress && opts.onProgress(++done, total, f.path);
      }
      const manifest = pathManifest(ids);
      const id = await sendLocal(node, key.seed, key.address, manifest, MANIFEST_TYPE, "").catch((e) => { throw failWith("The folder's list could not be stored: " + e.message, receipts); });
      return { id, receipts };
    },
  };
}
async function sendLocal(node: string, seed: Uint8Array, owner: string, bytes: Uint8Array, type: string, path: string): Promise<string> {
  const message = sha256(enc.encode("programmable-standin-v1\n" + type + "\n" + hex(sha256(bytes))));
  const signature = ed25519.sign(message, seed);
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: Response;
    try {
      r = await fetch(node + "/upload", { method: "POST", headers: { "content-type": type, "x-owner": owner, "x-signature": b64(signature), "x-path": path }, body: bytes as BodyInit });
    } catch (e: any) { last = e && e.message ? e.message : "no answer"; await sleep(500 * (attempt + 1)); continue; }
    const j = await json(r);
    if (r.ok && j.id) return j.id;
    last = j.error || "HTTP " + r.status;
    if (r.status >= 400 && r.status < 500) break;
    await sleep(500 * (attempt + 1));
  }
  throw new Error((path ? path + ": " : "") + last);
}

// ---- the entry --------------------------------------------------------------------------------------

/// The store the site's settings name. The real services load their own file on demand.
export async function openStore(o: OpenStoreOptions): Promise<ArtStore> {
  if (!o || !o.settings || !o.wallet) throw new Error("openStore needs { wallet, settings }.");
  const kind = o.settings.store;
  if (kind === "local") return localStore(o);
  if (kind === "turbo" || kind === "irys") {
    const url = new URL("./art-store-" + kind + ".js", import.meta.url).href;
    const mod: any = await import(/* @vite-ignore */ url);
    return mod.openStore(o);
  }
  throw new Error("This site's art storage is set to an unknown kind: " + kind + ".");
}
