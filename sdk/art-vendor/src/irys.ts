// The store for Irys (@irys/web-upload 0.0.15 with @irys/web-upload-solana 0.1.8), built as
// web/js/art-store-irys.js. Same surface as the local store in sdk/src/artstore.ts.
//
// Since October 2026 uploader.irys.xyz keeps files on Irys's own chain, not on Arweave; the
// files are read at gateway.irys.xyz. The balance belongs to the connected wallet: the wallet
// sends ONE SOL transfer to Irys's deposit address (the page builds it), the store tells Irys the
// transaction, and the whole folder goes as one bundle that the wallet signs with ONE message
// (Irys signs the files inside with a throwaway key of its own). A failed upload sends the whole
// folder again; the balance is kept, so only the shortfall is ever paid.
import { WebUploader } from "@irys/web-upload";
import { WebSolana } from "@irys/web-upload-solana";
import { PublicKey } from "@solana/web3.js";
import { bytesOf, receiptOf, listBytes, addressOf } from "../../src/artstore";
import type { ArtStore, OpenStoreOptions } from "../../src/artstore";

/// What one item adds in an Irys bundle: a 512-byte RSA signature, a 512-byte owner, tags, headers.
const ITEM_OVERHEAD = 1200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const big = (v: any) => BigInt(typeof v === "object" && v && typeof v.toFixed === "function" ? v.integerValue(1).toFixed(0) : String(v));

export async function openStore(o: OpenStoreOptions): Promise<ArtStore> {
  const s: any = o.settings;
  const node = String(s.node || "https://uploader.irys.xyz").replace(/\/+$/, "");
  const w = o.wallet;
  if (!w || typeof w.signMessage !== "function") throw new Error("Irys needs the wallet to sign one message for the upload.");
  const address = addressOf(w.publicKey);
  const provider = {
    publicKey: new PublicKey(address),
    signMessage: async (m: Uint8Array) => w.signMessage!(m),
    sendTransaction: async () => { throw new Error("The page sends the payment itself."); },
  };
  const rpc = (o.connection as any) && (o.connection as any).rpcEndpoint;
  let builder: any = WebUploader(WebSolana).withProvider(provider).bundlerUrl(node);
  if (rpc) builder = builder.withRpc(rpc);
  const irys: any = await builder.build();
  return {
    kind: "irys", gateway: (s.gateways && s.gateways[0]) || "https://gateway.irys.xyz", session: null, payer: address,
    async price(bytes, files = 1) {
      const n = Math.max(1, Math.ceil(files)) + 2; // the files, the folder's list and the bundle around them
      const p = big(await irys.getPrice(Math.max(0, Math.ceil(bytes)) + listBytes(n - 2) + ITEM_OVERHEAD * n));
      return (p * 102n) / 100n + 1n;
    },
    async balance() { return big(await irys.getBalance(address)); },
    async fund(lamports, pay) {
      const info = await (await fetch(node + "/info")).json();
      const to = info && info.addresses && info.addresses.solana;
      if (!to) throw new Error("Irys did not say where to pay in SOL.");
      const signature = await pay(to, lamports);
      let last: any = null;
      for (let n = 0; n < 10; n++) {
        try { await irys.funder.submitFundTransaction(signature); return { signature }; }
        catch (e: any) { last = e; await sleep(3000); }
      }
      throw new Error("Irys has not taken the payment " + signature + " yet (" + (last && last.message) + "). It is not lost: keep this page open and try again; it is not paid twice.");
    },
    async uploadFolder(files, opts = {}) {
      const items: any[] = [];
      const byPath = new Map<string, Uint8Array>();
      for (const f of files) {
        const bytes = await bytesOf(f.bytes);
        byPath.set(f.path, bytes);
        // Irys takes the path from `name`; a real File would lose its folders
        items.push({ name: f.path, type: f.type || "application/octet-stream", size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      }
      let res: any;
      try { res = await irys.uploadFolder(items, { indexFileRelPath: "collection.json" }); }
      catch (e: any) { const err: any = new Error("Irys did not take the folder: " + (e && e.message ? e.message : "failed") + ". Nothing was stored; try again."); err.receipts = {}; throw err; }
      const receipts: Record<string, string> = {};
      for (const [p, v] of Object.entries((res.manifest && res.manifest.paths) || {})) { const b = byPath.get(p); if (b) receipts[p] = receiptOf((v as any).id, b); }
      files.forEach((f, i) => opts.onProgress && opts.onProgress(i + 1, files.length, f.path));
      return { id: res.manifestId, receipts };
    },
  };
}
