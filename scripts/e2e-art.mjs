// A launcher's own art, end to end on the LOCAL chain with the local storage stand-in:
//   1. two collections are made (finished pictures, and layers), checked with the SDK and
//      uploaded through the browser's store module (web/js/art-store.js, kind "local"): the price
//      first, ONE payment from the wallet for the shortfall, the upload, a failed file resumed
//      without paying twice;
//   2. the site's resolver answers every piece from the folder, exactly as the SDK's pickPiece
//      draws it, and refuses a piece whose art bytes do not match;
//   3. a collectible coin is launched with each folder as its art, pieces are bought and minted,
//      and each Metaplex Core asset's address answers the right JSON and image;
//   4. the operator's hide switch, a gateway that is down, a missing folder and a broken one.
// It never talks to a public network: it refuses to run unless the site's store is "local" and
// the chain is on this machine.
//   node web/review/art-standin.mjs --port 8792 --dir <folder>
//   PORT=8794 ART_STORE=local ART_STANDIN_URL=http://127.0.0.1:8792 UPLOADS_DIR=<folder> node web/serve.js
//   node scripts/e2e-art.mjs http://localhost:8794 <UPLOADS_DIR>/art-hidden.txt
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { HookpoolClient, NATIVE_MINT, DIRECTION, collectible as col, checkCollection, encodeCollection, collectionArt, collectionArtHex, pickPiece, artUriBase, artFileUrl } from "../sdk/dist/index.js";
import { connection, loadAlt, sendV0, RPC } from "./cluster.mjs";
import { encodePng, decodePng, compositeLayers } from "../web/api/_artpng.js";
import { openStore, MEMO_PROGRAM } from "../web/js/art-store.js";

const SITE = String(process.argv[2] || "http://localhost:8794").replace(/\/+$/, "");
const HIDDEN_FILE = process.argv[3] || "";
let checks = 0;
const check = (cond, msg) => { if (!cond) { console.error("CHECK FAILED: " + msg); process.exit(1); } checks++; console.log("  check  " + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => { const r = await fetch(url); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { /* not JSON */ } return { status: r.status, json: j, headers: r.headers }; };
const getBytes = async (url, opts) => { const r = await fetch(url, opts); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), headers: r.headers }; };

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SITE)) { console.error("This rehearsal runs against a site on this machine only."); process.exit(1); }
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(RPC.localnet)) { console.error("The local chain must be on this machine."); process.exit(1); }
const settings = (await getJson(SITE + "/art/settings")).json;
// the local store, or the real Turbo store's code pointed at the stand-in's Turbo protocol
const LOCAL_URL = /^http:\/\/127\.0\.0\.1:\d+(\/[\w/.-]*)?$/;
const local = settings && [settings.node, settings.payment, ...(settings.gateways || [])].filter(Boolean).every((x) => LOCAL_URL.test(x));
if (settings && settings.store === "irys") { console.error("The Irys store is a browser bundle (its packages need a browser): check it with node web/review/art-store-browser.mjs."); process.exit(2); }
check(settings && ["local", "turbo"].includes(settings.store) && local, "the site's art store (" + (settings && settings.store) + ") and its gateway are the stand-in on this machine (" + (settings && settings.node) + ")");
const TURBO = settings.store === "turbo";
const STANDIN = settings.gateways[0];
const ORIGIN = settings.uriBase.replace(/\/art\/u\/$/, "");
const GATEWAY = settings.gateways[0];

const conn = connection("localnet");
const client = new HookpoolClient(conn, { lookupTable: loadAlt("localnet") });
if (!client.options.lookupTable) { console.error("run init-platform first: no lookup table file"); process.exit(1); }
const sendIxs = (ixs, signers, label) => sendV0(conn, client, ixs, signers, label);
async function airdrop(to, sol) { await conn.confirmTransaction(await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL), "confirmed"); }
async function waitPastSlot(slot) { for (;;) { const s = BigInt(await conn.getSlot("confirmed")); if (s > slot + 1n) return; await sleep(400); } }

// ---- the art: small images made here -----------------------------------------------------------------

function png(w, h, paint) { const d = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = paint(x, y); d.set(c, (y * w + x) * 4); } return encodePng(w, h, d); }
const solid = (r, g, b) => png(48, 48, (x, y) => (y % 12 < 2 ? [255, 255, 255, 255] : [r, g, b, 255]));
const disc = (r, g, b, a, radius) => png(64, 64, (x, y) => (Math.hypot(x - 32, y - 34) < radius ? [r, g, b, a] : [0, 0, 0, 0]));
const hat = () => png(64, 64, (x, y) => (y >= 6 && y < 16 && x >= 20 && x < 44 ? [200, 30, 40, 255] : [0, 0, 0, 0]));
const back = (r, g, b) => png(64, 64, (x, y) => [r, (g + y) & 255, b, 255]);

const colors = [["Red", 220, 40, 40], ["Blue", 40, 80, 220], ["Green", 40, 180, 80], ["Gold", 230, 180, 30], ["Black", 20, 20, 20], ["White", 240, 240, 240]];
const pictureFiles = colors.map(([n, r, g, b], i) => ({ path: "images/" + i + ".png", bytes: solid(r, g, b), type: "image/png" }));
const pictures = {
  version: 1, kind: "pictures", name: "Local Pics", symbol: "LPIC", description: "Six colours, each its own chance.", cover: "cover.png",
  attributes: [{ trait_type: "Power", value: 7, display_type: "number" }],
  items: colors.map(([n], i) => ({ image: "images/" + i + ".png", name: n + " card", attributes: [{ trait_type: "Colour", value: n }, { trait_type: "Stripe", value: i % 2 ? "thin" : "none" }], weight: [1, 2, 3, 4, 5, 10][i] })),
};
const layerFiles = [
  ["layers/Background/Night.png", back(10, 10, 60)], ["layers/Background/Dawn.png", back(200, 100, 60)], ["layers/Background/Moss.png", back(30, 90, 40)],
  ["layers/Body/Blob.png", disc(120, 200, 240, 255, 18)], ["layers/Body/Ghost.png", disc(250, 250, 250, 160, 22)],
  ["layers/Hat/Cap.png", hat()],
].map(([path, bytes]) => ({ path, bytes, type: "image/png" }));
const layers = {
  version: 1, kind: "layers", name: "Local Mix", symbol: "LMIX", description: "Three layers.", cover: "cover.png", width: 64, height: 64,
  attributes: [{ trait_type: "Season", value: "One" }],
  layers: [
    { name: "Background", options: [{ value: "Night", weight: 5, image: "layers/Background/Night.png" }, { value: "Dawn", weight: 3, image: "layers/Background/Dawn.png" }, { value: "Moss", weight: 1, image: "layers/Background/Moss.png" }] },
    { name: "Body", options: [{ value: "Blob", weight: 3, image: "layers/Body/Blob.png" }, { value: "Ghost", weight: 1, image: "layers/Body/Ghost.png" }] },
    { name: "Hat", options: [{ value: "None", weight: 2, none: true }, { value: "Cap", weight: 1, image: "layers/Hat/Cap.png" }] },
  ],
};
const cover = { path: "cover.png", bytes: solid(90, 60, 160), type: "image/png" };

function folderOf(json, files) {
  const r = checkCollection(json, [...files, cover].map((f) => ({ path: f.path, bytes: f.bytes.length, type: f.type, ...(decodeSize(f)) })));
  check(r.ok, json.kind + ": checkCollection accepts the collection and its " + r.paths.length + " files (" + r.bytes + " bytes)" + (r.errors.length ? " " + r.errors.join(" ") : ""));
  const manifest = encodeCollection(r.collection);
  return { collection: r.collection, manifest, art: collectionArtHex(manifest), files: [{ path: "collection.json", bytes: manifest, type: "application/json" }, cover, ...files] };
}
function decodeSize(f) { const i = decodePng(f.bytes); return { width: i.width, height: i.height }; }

// ---- 1. upload, paid by the wallet ---------------------------------------------------------------------

const wallet = Keypair.generate();
await airdrop(wallet.publicKey, 20);
const deposit = TURBO ? (await getJson(settings.payment + "/v1/info")).json.addresses.solana : (await getJson(settings.node + "/info")).json.deposit;
if (!(await conn.getAccountInfo(new PublicKey(deposit)))) await airdrop(new PublicKey(deposit), 1);
const control = (c) => fetch(STANDIN + "/_control", { method: "POST", body: JSON.stringify(c) });
const prompts = [];
const pay = async (to, lamports, memo) => {
  prompts.push({ to, lamports, memo });
  const ixs = [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(to), lamports })];
  if (memo) ixs.push(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(memo, "utf8") }));
  return sendIxs(ixs, [wallet], "wallet pays the storage " + lamports + " lamports");
};
// the stores here never ask the wallet to sign a message: count it if one does
let signed = 0;
const signer = { publicKey: wallet.publicKey, signMessage: async () => { signed++; throw new Error("no message to sign"); } };
let store = await openStore({ wallet: signer, settings });
const session = store.session;
check(store.kind === settings.store && typeof session === "string" && store.payer !== wallet.publicKey.toBase58(), "the " + store.kind + " store made its own upload key; the wallet keeps its key to itself");
store = await openStore({ wallet: signer, settings, session });
check(store.session === session, "a saved session opens the same upload key again");

async function upload(folder, label, failAt) {
  const bytes = folder.files.reduce((n, f) => n + f.bytes.length, 0);
  // price() covers the files and the folder's own list: paying exactly it must be enough
  const price = await store.price(bytes, folder.files.length);
  const before = await store.balance();
  const short = price > before ? price - before : 0n;
  if (short > 0n) await store.fund(short, pay);
  const funded = await store.balance();
  check(funded >= price, label + ": the price is " + price + " lamports; the wallet paid the shortfall " + short + " in one transfer");
  let receipts = {};
  const full = funded;
  if (failAt) {
    // the files before `failAt` land, then the next one fails every retry
    await control({ failAfter: failAt, failCount: 12 });
    let failed = null;
    try { await store.uploadFolder(folder.files); } catch (e) { failed = e; }
    await control({ failUploads: 0, failAfter: -1, failCount: 0 });
    check(failed && failed.receipts && Object.keys(failed.receipts).length === failAt, label + ": a failed upload stops with the receipts of the " + (failed && failed.receipts ? Object.keys(failed.receipts).length : "?") + " files that landed");
    receipts = failed.receipts;
  }
  const mid = await store.balance();
  let progress = 0;
  const out = await store.uploadFolder(folder.files, { already: receipts, onProgress: (d) => { progress = d; } });
  const after = await store.balance();
  const paidFirst = full - mid, paid = mid - after;
  check(progress === folder.files.length && paid > 0n && paid + paidFirst <= price, label + ": the " + (failAt ? "resumed " : "") + "upload paid " + paid + " lamports" + (failAt ? " after " + paidFirst + " for the files that landed the first time" : "") + ", within the price");
  if (failAt) check(paid < price - paidFirst / 2n && paidFirst > 0n, label + ": the files of the failed run were not paid again");
  check(/^[A-Za-z0-9_-]{43}$/.test(out.id), label + ": folder id " + out.id);
  const again = await store.uploadFolder(folder.files, { already: out.receipts });
  check(again.id === out.id && (await store.balance()) === after, label + ": the same folder sent again is the same id and costs nothing");
  return out.id;
}
const picsFolder = folderOf(pictures, pictureFiles);
const mixFolder = folderOf(layers, layerFiles);
const picsId = await upload(picsFolder, "pictures", 5);
const mixId = await upload(mixFolder, "layers");
check(prompts.every((p) => p.memo === "turboCreditDestinationAddress=" + store.payer) && signed === 0, "every payment names the upload key in its memo, " + prompts.length + " wallet transfer(s) in all; the wallet signed no message");

// ---- 2. the resolver -----------------------------------------------------------------------------------

const seedOf = (i) => Buffer.from(Array.from({ length: 16 }, (_, k) => (i * 37 + k * 11 + (i >> 3)) & 255)).toString("hex");
for (const [id, folder] of [[picsId, picsFolder], [mixId, mixFolder]]) {
  const kind = folder.collection.kind;
  const c = await getBytes(SITE + "/art/u/" + id + "/collection.json");
  check(c.status === 200 && c.bytes.equals(Buffer.from(folder.manifest)) && c.headers.get("x-art") === folder.art, kind + ": /collection.json answers the bytes as uploaded, x-art " + folder.art);
  check((await getJson(SITE + "/art/u/" + id + "/collection.json?art=" + "0".repeat(32))).status === 409, kind + ": ?art= with other bytes answers 409");
  let same = 0, images = 0;
  for (let i = 0; i < 24; i++) {
    const seed = seedOf(i);
    const pick = pickPiece(folder.collection, seed);
    const r = await getJson(SITE + "/art/u/" + id + "/p/" + folder.art + "/" + seed);
    if (r.status === 200 && JSON.stringify(r.json.attributes) === JSON.stringify(pick.attributes) && r.json.name === pick.name && r.json.properties.category === "image") same++;
    if (i < 6) {
      if (kind === "pictures") {
        const want = artFileUrl(GATEWAY, id, pick.images[0]);
        const img = await getBytes(r.json.image);
        if (r.json.image === want && img.bytes.equals(Buffer.from(pictureFiles.find((f) => f.path === pick.images[0]).bytes))) images++;
        const redirect = await fetch(SITE + "/art/u/" + id + "/p/" + folder.art + "/" + seed + ".png", { redirect: "manual" });
        if (redirect.status !== 302 || redirect.headers.get("location") !== want) images = -100;
      } else {
        const t0 = performance.now();
        const img = await getBytes(r.json.image);
        const ms = performance.now() - t0;
        const expected = Buffer.from(decodePng(compositeLayers(pick.images.map((p) => Buffer.from(layerFiles.find((f) => f.path === p).bytes)), 64, 64)).data);
        const again = await getBytes(r.json.image);
        if (img.status === 200 && img.headers.get("content-type") === "image/png" && Buffer.from(decodePng(img.bytes).data).equals(expected) && again.bytes.equals(img.bytes)) images++;
        if (i === 0) console.log("        first composite through the server " + ms.toFixed(0) + " ms");
      }
    }
  }
  check(same === 24, kind + ": 24 pieces answer the name and attributes pickPiece draws");
  check(images === 6, kind === "pictures" ? "pictures: the image is the picture on the gateway, byte for byte, and .png redirects to it" : "layers: the .png is the layers drawn in order, pixel for pixel the compositor's, the same file again from the cache");
  const wrong = await getJson(SITE + "/art/u/" + id + "/p/" + "ab".repeat(16) + "/" + seedOf(1));
  check(wrong.status === 409 && wrong.json.code === "ART_MISMATCH", kind + ": a piece with other art bytes answers 409 ART_MISMATCH, not the wrong picture");
}

// ---- 3. launch with the uploaded art, buy, mint ------------------------------------------------------

async function launchWith(id, folder, name) {
  const dev = Keypair.generate();
  await airdrop(dev.publicKey, 10);
  const mint = Keypair.generate();
  const unit = 50_000_000n * 1_000_000n;
  const uriBase = artUriBase(ORIGIN, id);
  const art = collectionArt(folder.manifest);
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name, symbol: folder.collection.symbol, uri: "https://example.com/meta/" + name + ".json", decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: BigInt(2 * LAMPORTS_PER_SOL), devBuyQuote: BigInt(0.3 * LAMPORTS_PER_SOL), minDevBuyOut: 1n,
    template: "collectible", collectible: { name, uriBase, unit, maxSupply: 1000, maxPerBuy: 3, art },
  });
  await sendIxs(plan.createTx, [dev, mint], name + ": create coin + collection");
  await sendIxs(plan.launchTx, [dev], name + ": launch + dev buy");
  const cfg = await col.fetchCollectionConfig(conn, plan.pool);
  check(cfg.uriBase === uriBase && col.hexOf(cfg.art) === folder.art, name + ": the coin's uri_base is " + uriBase + " (" + uriBase.length + " bytes) and its art bytes are the hash of collection.json");
  const trader = Keypair.generate();
  await airdrop(trader.publicKey, 3);
  const pool = await client.pool(plan.pool);
  const q = await client.quoteOnChain(trader.publicKey, pool, DIRECTION.BUY, BigInt(0.5 * LAMPORTS_PER_SOL));
  await sendIxs(await client.swapInstructions(trader.publicKey, pool, await client.hookRef(pool, trader.publicKey), DIRECTION.BUY, BigInt(0.5 * LAMPORTS_PER_SOL), q), [trader], name + ": a trader buys");
  for (const w of [dev, trader]) {
    const t = await col.fetchTicket(conn, plan.pool, w.publicKey);
    const waiting = t.batches.filter((b) => b.pieces > 0);
    if (waiting.length) { await waitPastSlot(waiting.reduce((m, b) => (b.targetSlot > m ? b.targetSlot : m), 0n)); await sendIxs(await client.collectibleMintInstructions(w.publicKey, plan.pool), [w], name + ": mint"); }
  }
  const pieces = await col.fetchCollectionPieces(conn, plan.pool);
  check(pieces.length >= 2, name + ": " + pieces.length + " pieces minted as Metaplex Core assets");
  let good = 0;
  for (const p of pieces) {
    const r = await getJson(p.uri);
    const pick = pickPiece(folder.collection, p.seed);
    const img = await getBytes(r.json && r.json.image);
    const okImage = img.status === 200 && (folder.collection.kind === "pictures" ? img.bytes.equals(Buffer.from(pictureFiles.find((f) => f.path === pick.images[0]).bytes)) : decodePng(img.bytes).width === 64);
    if (p.uri === uriBase + "/p/" + folder.art + "/" + p.seed && p.art === folder.art && r.status === 200 && JSON.stringify(r.json.attributes) === JSON.stringify(pick.attributes) && okImage) good++;
  }
  check(good === pieces.length, name + ": every piece's Core URI is <uri_base>/p/<art>/<seed>, answers the attributes as uploaded, and its image loads");
  // the collection asset: Metaplex Core BaseCollectionV1 (key 5, update authority, name, uri)
  const ca = await conn.getAccountInfo(cfg.collection);
  const d = Buffer.from(ca.data); const nl = d.readUInt32LE(33), name2 = d.subarray(37, 37 + nl).toString("utf8"), ul = d.readUInt32LE(37 + nl), curi = d.subarray(41 + nl, 41 + nl + ul).toString("utf8");
  const cj = await getJson(curi);
  check(d[0] === 5 && curi === uriBase + "/c/" + plan.pool.toBase58() && cj.status === 200 && cj.json.image === artFileUrl(GATEWAY, id, folder.collection.cover) && cj.json.name === name2, name + ": the collection's Core URI answers its name and the cover from the folder");
  return { pool: plan.pool, pieces };
}
const picsCoin = await launchWith(picsId, picsFolder, "LocalPics");
await launchWith(mixId, mixFolder, "LocalMix");

// ---- 4. hide switch, failures ---------------------------------------------------------------------------

if (HIDDEN_FILE) {
  const cli = (...a) => spawnSync(process.execPath, [fileURLToPath(new URL("./art-hide.mjs", import.meta.url)), ...a, "--file", HIDDEN_FILE], { encoding: "utf8" });
  const pieceUri = picsCoin.pieces[0].uri;
  cli("add", pieceUri, "e2e check");
  let hidden = null;
  for (let i = 0; i < 20 && !hidden; i++) { await sleep(300); const r = await getJson(pieceUri); if (r.json && r.json.description === "Hidden by the site operator.") hidden = r.json; }
  const ph = hidden && (await getBytes(hidden.image));
  check(hidden && hidden.image === ORIGIN + "/art/hidden.png" && ph.status === 200 && decodePng(ph.bytes).width === 256, "hide: the CLI hides the folder from a piece's address; its pieces answer a plain image and 'Hidden by the site operator.' within seconds");
  check((await getJson(SITE + "/art/u/" + picsId + "/collection.json")).status === 410, "hide: the hidden folder's collection.json answers 410");
  cli("remove", picsId);
  let back = false;
  for (let i = 0; i < 20 && !back; i++) { await sleep(300); const r = await getJson(pieceUri); back = r.json && r.json.description !== "Hidden by the site operator."; }
  check(back, "hide: removed from the list, the pieces show their art again, nothing changed on chain");
}
const tiny = folderOf({ ...pictures, name: "Tiny", items: pictures.items.slice(0, 1) }, pictureFiles.slice(0, 1));
const tinyId = await upload(tiny, "a third folder");
await control({ gatewayDown: true });
const down = await getJson(SITE + "/art/u/" + tinyId + "/p/" + tiny.art + "/" + seedOf(2));
await control({ gatewayDown: false });
check(down.status === 502 && down.json.code === "GATEWAY" && /did not answer/.test(down.json.error), "a gateway that is down answers 502 GATEWAY with a sentence, the server keeps running");
const cached = await getJson(SITE + "/art/u/" + picsId + "/p/" + picsFolder.art + "/" + seedOf(3));
check(cached.status === 200, "a folder read before keeps answering from the cache meanwhile");
const missing = await getJson(SITE + "/art/u/" + "Q".repeat(43) + "/p/" + "00".repeat(16) + "/" + seedOf(4));
check(missing.status === 404 && missing.json.code === "NOT_FOUND", "a folder the gateway does not have answers 404 NOT_FOUND");
const brokenFiles = [{ path: "collection.json", bytes: new TextEncoder().encode('{"version":1,"kind":"pictures"}'), type: "application/json" }];
await store.fund(await store.price(400, 2), pay);
const brokenId = (await store.uploadFolder(brokenFiles)).id;
const broken = await getJson(SITE + "/art/u/" + brokenId + "/p/" + collectionArtHex(brokenFiles[0].bytes) + "/" + seedOf(5));
check(broken.status === 422 && broken.json.code === "BAD_COLLECTION", "a folder whose collection.json is not valid answers 422 BAD_COLLECTION: " + (broken.json && broken.json.error));
await sleep(21000);
const up = await getJson(SITE + "/art/u/" + tinyId + "/p/" + tiny.art + "/" + seedOf(2));
check(up.status === 200, "once the gateway is back (the failure is remembered 20 seconds), the folder answers");
console.log("art e2e passed: " + checks + " checks. folders " + picsId + " (pictures), " + mixId + " (layers)");
