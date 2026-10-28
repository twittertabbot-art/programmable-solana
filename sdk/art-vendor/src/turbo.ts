// The store for Arweave through ArDrive Turbo (@ardrive/turbo-sdk 2.1.2, web build), built as
// web/js/art-store-turbo.js. Same surface as the local store in sdk/src/artstore.ts.
//
// How the launcher pays: the store makes a throwaway Solana key in the browser (kept by the page
// as `session`). The wallet sends ONE SOL transfer to Turbo's deposit address with a Memo
// instruction "turboCreditDestinationAddress=<that key>", so Turbo credits the key; the page tells
// Turbo the transaction (submitFundTransaction) and the key signs every file. The wallet signs
// nothing else: no message per picture. A file that landed is not sent again on a retry (its
// receipt), and the price is asked again before each payment, so only the shortfall is paid.
// Turbo has no way to send credit back: what the key holds is only ever the price of the upload.
import { TurboFactory } from "@ardrive/turbo-sdk/web";
import { sessionKey, bytesOf, receiptOf, receiptId, pathManifest, listBytes, MANIFEST_TYPE } from "../../src/artstore";
import type { ArtStore, OpenStoreOptions } from "../../src/artstore";

const GIB = 1073741824n;
const LAMPORTS = 1000000000n;
/// What one data item adds to its file on Arweave: a Solana signature, owner, tags and headers.
const ITEM_OVERHEAD = 1100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = (e: any): number => Number((e && (e.status || e.statusCode || (e.response && e.response.status))) || (/\b(4\d\d|5\d\d)\b/.exec(String(e && e.message)) || [])[1] || 0);
function failWith(message: string, receipts: Record<string, string>): Error { const e: any = new Error(message); e.receipts = { ...receipts }; return e; }

export async function openStore(o: OpenStoreOptions): Promise<ArtStore> {
  const s: any = o.settings;
  const uploadUrl = String(s.node || "https://upload.ardrive.io").replace(/\/+$/, "");
  const paymentUrl = String(s.payment || "https://payment.ardrive.io").replace(/\/+$/, "");
  const key = sessionKey(o.session);
  const turbo: any = TurboFactory.authenticated({ privateKey: key.session, token: "solana", paymentServiceConfig: { url: paymentUrl }, uploadServiceConfig: { url: uploadUrl } } as any);
  let rate: { fixed: bigint; perGiB: bigint; wincPerSol: bigint; at: number } | null = null;
  let lastFund = "";
  async function rates() {
    if (rate && Date.now() - rate.at < 60000) return rate;
    const [zero] = await turbo.getUploadCosts({ bytes: [0] });
    const [gib] = await turbo.getUploadCosts({ bytes: [Number(GIB)] });
    const sol = await turbo.getWincForToken({ tokenAmount: Number(LAMPORTS) });
    const fixed = BigInt(zero.winc), perGiB = BigInt(gib.winc) - fixed, wincPerSol = BigInt(sol.winc);
    if (wincPerSol <= 0n) throw new Error("Turbo did not give a price for SOL.");
    rate = { fixed, perGiB, wincPerSol, at: Date.now() };
    return rate;
  }
  const lamportsOf = (winc: bigint, r: { wincPerSol: bigint }) => (winc * LAMPORTS + r.wincPerSol - 1n) / r.wincPerSol;
  async function sendOne(bytes: Uint8Array, tags: { name: string; value: string }[], label: string): Promise<string> {
    let last: any = null;
    // a 402 right after a payment: Turbo has not credited it yet. Tell it again and wait.
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const r = await turbo.upload({ data: bytes, dataItemOpts: { tags } });
        if (r && typeof r.id === "string") return r.id;
        last = new Error("Turbo answered without an id.");
      } catch (e: any) {
        last = e;
        if (statusOf(e) !== 402) break;
        if (lastFund) { try { await turbo.submitFundTransaction({ txId: lastFund }); } catch (_) { /* asked again below */ } }
        await sleep(5000);
      }
    }
    throw new Error(label + ": " + (last && last.message ? last.message : "the upload failed"));
  }
  return {
    kind: "turbo", gateway: (s.gateways && s.gateways[0]) || "https://arweave.net", session: key.session, payer: key.address,
    async price(bytes, files = 1) {
      const r = await rates();
      const n = Math.max(1, Math.ceil(files)) + 1;
      const total = BigInt(Math.max(0, Math.ceil(bytes)) + listBytes(n - 1) + ITEM_OVERHEAD * n);
      const winc = r.fixed * BigInt(n) + (r.perGiB * total + GIB - 1n) / GIB;
      // the price moves a little between the quote and the upload: 2% more, the rest stays with the key
      return (lamportsOf(winc, r) * 102n) / 100n + 1n;
    },
    async balance() {
      const b = await turbo.getBalance(key.address);
      const r = await rates();
      const winc = BigInt((b && (b.effectiveBalance || b.winc)) || "0");
      return (winc * LAMPORTS) / r.wincPerSol;
    },
    async fund(lamports, pay) {
      const wallets = await turbo.getTurboCryptoWallets();
      const to = wallets && wallets.solana;
      if (!to) throw new Error("Turbo did not say where to pay in SOL.");
      const signature = await pay(to, lamports, "turboCreditDestinationAddress=" + key.address);
      lastFund = signature;
      let last: any = null;
      for (let n = 0; n < 10; n++) {
        try { await turbo.submitFundTransaction({ txId: signature }); return { signature }; }
        catch (e: any) { last = e; await sleep(3000); }
      }
      throw new Error("Turbo has not taken the payment " + signature + " yet (" + (last && last.message) + "). It is not lost: keep this page open and try again; it is not paid twice.");
    },
    async uploadFolder(files, opts = {}) {
      const receipts: Record<string, string> = {};
      const ids: Record<string, string> = {};
      let done = 0;
      for (const f of files) {
        const bytes = await bytesOf(f.bytes);
        const known = receiptId(opts.already && opts.already[f.path], bytes);
        const id = known || (await sendOne(bytes, [{ name: "Content-Type", value: f.type || "application/octet-stream" }], f.path).catch((e) => { throw failWith(e.message, receipts); }));
        ids[f.path] = id; receipts[f.path] = receiptOf(id, bytes);
        opts.onProgress && opts.onProgress(++done, files.length, f.path);
      }
      const id = await sendOne(pathManifest(ids), [{ name: "Type", value: "manifest" }, { name: "Content-Type", value: MANIFEST_TYPE }], "the folder's list").catch((e) => { throw failWith(e.message, receipts); });
      return { id, receipts };
    },
  };
}
