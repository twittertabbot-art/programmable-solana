// Unit tests for the art resolver of a launcher's own art (web/api/_art.js) and its PNG code
// (web/api/_artpng.js). No chain and no network: a small gateway runs inside the test.
//   node --test "web/api/_test/*.test.mjs"        (from the project folder)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { artRoute, artSettings, uploadedArtRoute, parseHiddenList, renderPieceSvg } from "../_art.js";
import { decodePng, encodePng, compositeLayers, compositeLayersAsync, streamPngRows, eachPngRow, encodePngStream, startCompositor } from "../_artpng.js";
const pixels = (png) => Buffer.from(decodePng(png).data);
import { checkCollection, encodeCollection, collectionArtHex, pickPiece, artFileUrl } from "../_artpack.js";
import { isArtPrivate, isServerFile } from "../../serve.js";

// ---- a PNG writer independent of the decoder under test ---------------------------------------------

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "latin1"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/// sample(x, y) -> array of channel values in the file's own depth. filter: 0..4 for every row.
function writePng(w, h, color, depth, sample, { plte, trns, interlace = 0, filter = 0 } = {}) {
  const ch = CH[color], bits = ch * depth, bpp = Math.max(1, bits >> 3);
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const out = [];
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * bits) / 8);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < ph; y++) {
      const row = Buffer.alloc(stride);
      let bit = 0;
      for (let x = 0; x < pw; x++) for (const v of sample(x0 + x * dx, y0 + y * dy)) {
        if (depth === 16) { row.writeUInt16BE(v, bit >> 3); bit += 16; }
        else if (depth === 8) { row[bit >> 3] = v; bit += 8; }
        else { row[bit >> 3] |= v << (8 - depth - (bit & 7)); bit += depth; }
      }
      const f = Buffer.alloc(stride);
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
        f[i] = (row[i] - pred) & 255;
      }
      out.push(Buffer.from([filter]), f);
      prev = row;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = color; ihdr[12] = interlace;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...(plte ? [chunk("PLTE", Buffer.from(plte))] : []), ...(trns ? [chunk("tRNS", Buffer.from(trns))] : []), chunk("IDAT", zlib.deflateSync(Buffer.concat(out))), chunk("IEND", Buffer.alloc(0))]);
}
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

test("decodePng reads every colour type and bit depth, interlaced or not, every row filter", () => {
  const W = 13, H = 7;
  for (const depth of [1, 2, 4, 8, 16]) {
    const max = (1 << depth) - 1;
    const v = (x, y) => (x * 3 + y * 5) % (max + 1);
    for (const interlace of [0, 1]) {
      const img = decodePng(writePng(W, H, 0, depth, (x, y) => [v(x, y)], { interlace }));
      for (const [x, y] of [[0, 0], [5, 3], [12, 6]]) { const g = depth === 16 ? v(x, y) >> 8 : Math.round((v(x, y) * 255) / max); assert.deepEqual(px(img, x, y), [g, g, g, 255], "grey " + depth + " bit, interlace " + interlace); }
    }
  }
  for (const filter of [0, 1, 2, 3, 4]) for (const depth of [8, 16]) for (const interlace of [0, 1]) {
    const f = (x, y) => (depth === 16 ? [(x * 4000 + y) & 65535, (y * 3000) & 65535, 513 * x, 60000 - x * 100] : [x * 19, y * 31, (x * y) & 255, 255 - x * 3]);
    const img = decodePng(writePng(W, H, 6, depth, f, { interlace, filter }));
    for (const [x, y] of [[0, 0], [1, 1], [7, 4], [12, 6]]) { const s = f(x, y); assert.deepEqual(px(img, x, y), depth === 16 ? s.map((c) => c >> 8) : s, "rgba " + depth + " filter " + filter + " interlace " + interlace); }
    const rgb = decodePng(writePng(W, H, 2, depth, (x, y) => f(x, y).slice(0, 3), { interlace, filter }));
    assert.deepEqual(px(rgb, 7, 4), [...(depth === 16 ? f(7, 4).slice(0, 3).map((c) => c >> 8) : f(7, 4).slice(0, 3)), 255]);
    const ga = decodePng(writePng(W, H, 4, depth, (x, y) => [f(x, y)[0], f(x, y)[3]], { interlace, filter }));
    const g = depth === 16 ? f(7, 4)[0] >> 8 : f(7, 4)[0];
    assert.deepEqual(px(ga, 7, 4), [g, g, g, depth === 16 ? f(7, 4)[3] >> 8 : f(7, 4)[3]]);
  }
  for (const depth of [1, 2, 4, 8]) for (const interlace of [0, 1]) {
    const n = Math.min(1 << depth, 6), plte = [], trns = [0, 128];
    for (let i = 0; i < n; i++) plte.push(i * 40, 255 - i * 40, i * 10);
    const img = decodePng(writePng(W, H, 3, depth, (x, y) => [(x + y) % n], { plte, trns, interlace }));
    for (const [x, y] of [[0, 0], [1, 0], [3, 2], [12, 6]]) { const i = (x + y) % n; assert.deepEqual(px(img, x, y), [i * 40, 255 - i * 40, i * 10, i < 2 ? trns[i] : 255], "palette " + depth + " bit"); }
  }
  const tg = decodePng(writePng(4, 1, 0, 8, (x) => [x * 10], { trns: [0, 20] }));
  assert.deepEqual([px(tg, 1, 0)[3], px(tg, 2, 0)[3]], [255, 0], "a grey tRNS colour is transparent");
  const tc = decodePng(writePng(2, 1, 2, 8, (x) => [x, 2, 3], { trns: [0, 1, 0, 2, 0, 3] }));
  assert.deepEqual([px(tc, 0, 0)[3], px(tc, 1, 0)[3]], [255, 0], "an RGB tRNS colour is transparent");
});

test("encodePng round-trips; bad or too large files are refused with BAD_IMAGE", () => {
  const w = 37, h = 11, d = new Uint8Array(w * h * 4);
  for (let i = 0; i < d.length; i++) d[i] = (i * 7 + (i >> 5)) & 255;
  const png = encodePng(w, h, d);
  const back = decodePng(png);
  assert.deepEqual([back.width, back.height], [w, h]);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(d));
  for (const [bytes, re] of [
    [Buffer.from("not a png at all, really not one"), /not a PNG/],
    [png.subarray(0, 40), /cut short|no image data/],
    [writePng(3000, 10, 6, 8, () => [0, 0, 0, 0]), /larger than this server draws/],
  ]) assert.throws(() => decodePng(bytes, { maxSide: 2048, maxPixels: 4194304 }), (e) => e.code === "BAD_IMAGE" && re.test(e.message));
  // an IDAT that inflates to far more than the header allows (a zip bomb) stops early
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(10, 0); ihdr.writeUInt32BE(10, 4); ihdr[8] = 8; ihdr[9] = 6;
  const bomb = Buffer.concat([png.subarray(0, 8), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc(50_000_000))), chunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => decodePng(bomb), (e) => e.code === "BAD_IMAGE" && /does not inflate/.test(e.message));
  // PNGs made by a browser (the review screenshots, when there are any) decode at their header's size
  const dir = new URL("../../review/", import.meta.url);
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".png")).slice(0, 3)) {
    const b = fs.readFileSync(new URL(f, dir));
    const img = decodePng(b);
    assert.deepEqual([img.width, img.height], [b.readUInt32BE(16), b.readUInt32BE(20)], f);
  }
});

test("compositeLayers draws source over, in order", () => {
  const solid = (c) => { const d = new Uint8Array(4 * 4 * 4); for (let i = 0; i < d.length; i += 4) d.set(c, i); return encodePng(4, 4, d); };
  const img = decodePng(compositeLayers([solid([255, 0, 0, 255]), solid([0, 0, 255, 128]), solid([0, 255, 0, 0])], 4, 4));
  const [r, g, b, a] = px(img, 2, 2);
  assert.ok(Math.abs(r - 127) <= 1 && g === 0 && Math.abs(b - 128) <= 1 && a === 255, "half blue over red " + [r, g, b, a]);
  const top = decodePng(compositeLayers([solid([255, 0, 0, 255]), solid([0, 255, 0, 255])], 4, 4));
  assert.deepEqual(px(top, 0, 0), [0, 255, 0, 255]);
  const two = decodePng(compositeLayers([solid([0, 0, 0, 0]), solid([200, 100, 50, 100]), solid([10, 20, 30, 100])], 4, 4));
  assert.ok(two.data[3] > 100 && two.data[3] < 200, "two half layers over nothing are more opaque than either");
  assert.equal(decodePng(compositeLayers([], 4, 4)).data.every((x) => x === 0), true, "no layer: a transparent piece");
  assert.throws(() => compositeLayers([solid([0, 0, 0, 255])], 5, 4), /the collection says 5 by 4/);
});

test("the drawing in steps gives the same pixels: streamed rows, streamed encoding, every PNG kind", async () => {
  const W = 13, H = 7;
  const kinds = [[6, 8, {}], [6, 16, {}], [2, 8, { filter: 3 }], [0, 4, {}], [3, 2, { plte: [1, 2, 3, 40, 50, 60, 70, 80, 90, 100, 110, 120], trns: [0] }], [4, 8, { filter: 4 }], [6, 8, { interlace: 1 }]];
  for (const [color, depth, o] of kinds) {
    const max = (1 << depth) - 1;
    const png = writePng(W, H, color, depth, (x, y) => Array.from({ length: CH[color] }, (_, c) => (x * 7 + y * 3 + c * 5) % (max + 1)), o);
    const rows = [];
    await streamPngRows(png, {}, (y, r) => { rows[y] = Buffer.from(r); });
    const sync = [];
    eachPngRow(png, {}, (y, r) => { sync[y] = Buffer.from(r); });
    assert.deepEqual(Buffer.concat(rows), Buffer.from(decodePng(png).data), "streamed rows, colour " + color + " depth " + depth);
    assert.deepEqual(Buffer.concat(sync), Buffer.from(decodePng(png).data));
  }
  const d = new Uint8Array(300 * 700 * 4); for (let i = 0; i < d.length; i++) d[i] = (i * 13 + (i >> 9)) & 255;
  const s = await encodePngStream(300, 700, d);
  assert.deepEqual(pixels(s), Buffer.from(d), "the streamed encoding (several IDAT chunks) decodes to the same pixels");
  const layers = [0, 1, 2].map((k) => { const x = new Uint8Array(40 * 40 * 4); for (let i = 0; i < x.length; i++) x[i] = (i * (k + 3)) & 255; return encodePng(40, 40, x); });
  assert.deepEqual(pixels(await compositeLayersAsync(layers, 40, 40)), pixels(compositeLayers(layers, 40, 40)));
  await assert.rejects(compositeLayersAsync([layers[0]], 41, 40), /the collection says 41 by 40/);
  await assert.rejects(streamPngRows(Buffer.from("nope, not a png at all......"), {}, () => {}), /not a PNG/);
  const cut = Buffer.from(layers[0]); cut.writeUInt32BE(41, 16);
  await assert.rejects(compositeLayersAsync([cut], 41, 40), (e) => e.code === "BAD_IMAGE");
});

test("the compositor: a worker gives the same pixels; a full queue answers BUSY", async () => {
  const layers = [0, 1, 2].map((k) => { const d = new Uint8Array(32 * 32 * 4); for (let i = 0; i < d.length; i++) d[i] = (i * (k + 3)) & 255; return encodePng(32, 32, d); });
  const w = startCompositor({ worker: true, idleMs: 200 });
  const a = await w.run(layers, 32, 32);
  w.stop();
  assert.deepEqual(pixels(a), pixels(compositeLayers(layers, 32, 32)));
  const q = startCompositor({ worker: false, queue: 1 });
  const runs = [q.run(layers, 32, 32), q.run(layers, 32, 32), q.run(layers, 32, 32)];
  const out = await Promise.allSettled(runs);
  assert.equal(out.filter((r) => r.status === "rejected" && r.reason.code === "BUSY").length, 1);
  assert.equal(out.filter((r) => r.status === "fulfilled").length, 2);
});

// ---- the resolver against a gateway in this process -------------------------------------------------

const folders = new Map();   // id -> Map(path -> { bytes, type })
const hits = new Map();      // path asked -> count
let mode = "";               // "", "fail", "slow"
const gateway = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
  if (mode === "fail") { res.writeHead(500); return res.end("down"); }
  const [, id, ...rest] = u.pathname.split("/");
  const f = folders.get(id) && folders.get(id).get(rest.map(decodeURIComponent).join("/"));
  const go = () => { if (!f) { res.writeHead(404); return res.end("no"); } res.writeHead(200, { "content-type": f.type, "content-length": f.bytes.length }); res.end(f.bytes); };
  if (mode === "slow") setTimeout(go, 1500); else go();
});
const empty = http.createServer((req, res) => { res.writeHead(404); res.end(); });
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
await new Promise((r) => empty.listen(0, "127.0.0.1", r));
const GW = "http://127.0.0.1:" + gateway.address().port, GW404 = "http://127.0.0.1:" + empty.address().port;
test.after(() => { gateway.close(); empty.close(); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "art-test-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const newId = () => createHash("sha256").update("folder" + ++n).digest("base64url").slice(0, 43);
let sn = 0;
// each settings object has its own cache folder and hide list (the list is looked at again every 2 s)
const settings = (extra = {}) => { sn++; return { ...artSettings({ ART_STORE: "local", ART_GATEWAYS: GW404 + "," + GW, ART_FETCH_TIMEOUT_MS: "800", ART_COMPOSITE_WORKER: "0", ART_CACHE_DIR: path.join(tmp, "cache" + sn), ART_HIDDEN_FILE: path.join(tmp, "hidden" + sn + ".txt") }, { origin: "http://site.test" }), ...extra }; };
const ORIGIN = "http://site.test";
const route = (S, p, search = "") => uploadedArtRoute(p, search, ORIGIN, "", S);
const body = (out) => JSON.parse(Buffer.isBuffer(out.body) ? out.body.toString("utf8") : out.body);
const tile = (c, side = 16) => { const d = new Uint8Array(side * side * 4); for (let i = 0; i < d.length; i += 4) d.set(c, i); return encodePng(side, side, d); };
function addFolder(collection, files) {
  const id = newId();
  const c = checkCollection(collection).collection;
  const manifest = Buffer.from(encodeCollection(c));
  const m = new Map([["collection.json", { bytes: manifest, type: "application/json" }]]);
  for (const [p, bytes] of Object.entries(files)) m.set(p, { bytes: Buffer.from(bytes), type: "image/png" });
  folders.set(id, m);
  return { id, c, art: collectionArtHex(manifest), manifest };
}
const pics = () => ({ version: 1, kind: "pictures", name: "P", symbol: "P", description: "d", cover: "cover.png", items: [0, 1, 2].map((i) => ({ image: "i/" + i + ".png", name: "N" + i, attributes: [{ trait_type: "T", value: "v" + i }], weight: i + 1 })) });
const picFiles = { "cover.png": tile([1, 2, 3, 255]), "i/0.png": tile([255, 0, 0, 255]), "i/1.png": tile([0, 255, 0, 255]), "i/2.png": tile([0, 0, 255, 255]) };
const mix = () => ({ version: 1, kind: "layers", name: "M", symbol: "M", description: "", cover: "cover.png", width: 16, height: 16, layers: [
  { name: "Bg", options: [{ value: "A", weight: 1, image: "l/a.png" }, { value: "B", weight: 1, image: "l/b.png" }] },
  { name: "Top", options: [{ value: "None", weight: 1, none: true }, { value: "Dot", weight: 1, image: "l/dot.png" }] }] });
const dot = () => { const d = new Uint8Array(16 * 16 * 4); d.set([255, 255, 255, 200], (8 * 16 + 8) * 4); return encodePng(16, 16, d); };
const mixFiles = { "cover.png": tile([9, 9, 9, 255]), "l/a.png": tile([10, 20, 30, 255]), "l/b.png": tile([200, 100, 0, 255]), "l/dot.png": dot() };
const seed = (i) => createHash("sha256").update("s" + i).digest("hex").slice(0, 32);

test("settings: the store, its network, gateways and the uri_base prefix; env defaults", async () => {
  const S = settings();
  const out = await route(S, "/art/settings");
  assert.deepEqual(body(out), { store: "local", network: "this computer", module: "art-store.js", node: "http://127.0.0.1:8792", gateways: [GW404, GW], uriBase: ORIGIN + "/art/u/", maxUriBase: 80 });
  assert.equal(artSettings({}, { origin: "https://programmableonsol.com" }).store, "irys");
  const t = artSettings({ ART_STORE: "turbo" }, { origin: "https://programmableonsol.com", uploadsDir: tmp });
  assert.deepEqual([t.node, t.gateways, t.cacheDir, t.hiddenFile], ["https://upload.ardrive.io", ["https://arweave.net", "https://turbo-gateway.com"], path.join(tmp, "art-cache"), path.join(tmp, "art-hidden.txt")]);
  assert.equal(artSettings({ ART_STORE: "nonsense" }, { origin: "http://localhost:8787" }).store, "local");
  assert.equal(artSettings({ ART_CACHE_MAX_MB: "abc" }).cacheMaxBytes, 1024 * 1048576);
});

test("pictures: the piece JSON is pickPiece's, the image is the gateway's file, .png redirects", async () => {
  const S = settings();
  const f = addFolder(pics(), picFiles);
  for (let i = 0; i < 12; i++) {
    const out = await route(S, "/art/u/" + f.id + "/p/" + f.art + "/" + seed(i));
    const pick = pickPiece(f.c, seed(i));
    assert.equal(out.status, 200);
    const j = body(out);
    assert.deepEqual(j.attributes, pick.attributes);
    assert.equal(j.image, artFileUrl(GW404, f.id, pick.images[0]), "the first gateway of the list is written into the JSON");
    assert.equal(j.properties.files[0].type, "image/png");
    const r = await route(S, "/art/u/" + f.id + "/p/" + f.art + "/" + seed(i) + ".png");
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, j.image);
  }
  assert.equal(hits.get("/" + f.id + "/collection.json"), 1, "collection.json is read from the gateway once, then from memory");
  const cj = await route(S, "/art/u/" + f.id + "/collection.json");
  assert.equal(cj.status, 200); assert.deepEqual(cj.body, f.manifest); assert.equal(cj.headers["x-art"], f.art);
  assert.equal((await route(S, "/art/u/" + f.id + "/collection.json", "?art=" + "1".repeat(32))).status, 409);
  assert.equal((await route(S, "/art/u/" + f.id + "/collection.json", "?art=" + f.art)).status, 200);
  const mis = await route(S, "/art/u/" + f.id + "/p/" + "0".repeat(32) + "/" + seed(1));
  assert.equal(mis.status, 409); assert.equal(body(mis).code, "ART_MISMATCH");
  const coll = body(await route(S, "/art/u/" + f.id + "/c/11111111111111111111111111111111"));
  assert.equal(coll.image, artFileUrl(GW404, f.id, "cover.png"));
  assert.equal(coll.external_url, ORIGIN + "/coin.html?pool=11111111111111111111111111111111");
  assert.equal((await route(S, "/art/u/" + f.id + "/c/not-a-key")).status, 404);
  assert.equal((await route(S, "/art/u/" + f.id + "/zzz")).status, 404);
});

test("layers: the .png is drawn once, cached on disk, shared by pieces that drew the same options", async () => {
  const S = settings();
  const f = addFolder(mix(), mixFiles);
  const seen = new Map();
  for (let i = 0; i < 16; i++) {
    const s = seed(100 + i), pick = pickPiece(f.c, s);
    const j = body(await route(S, "/art/u/" + f.id + "/p/" + f.art + "/" + s));
    assert.equal(j.image, ORIGIN + "/art/u/" + f.id + "/p/" + f.art + "/" + s + ".png");
    assert.deepEqual(j.attributes, pick.attributes);
    const png = await route(S, "/art/u/" + f.id + "/p/" + f.art + "/" + s + ".png");
    assert.equal(png.status, 200); assert.equal(png.type, "image/png");
    assert.deepEqual(pixels(png.body), pixels(compositeLayers(pick.images.map((p) => Buffer.from(mixFiles[p])), 16, 16)));
    seen.set(pick.options.join(","), true);
  }
  assert.equal(seen.size, 4, "every combination came up");
  for (const p of ["l/a.png", "l/b.png", "l/dot.png"]) assert.equal(hits.get("/" + f.id + "/" + p), 1, p + " fetched once");
  const files = fs.readdirSync(S.cacheDir, { recursive: true }).filter((x) => String(x).endsWith(".png"));
  assert.equal(files.length, 4, "one cached drawing per combination");
  // a second server (a restart) answers from the disk without the gateway
  const before = [...hits.values()].reduce((a, b) => a + b, 0);
  mode = "fail";
  try {
    const S2 = { ...S };
    const out = await route(S2, "/art/u/" + f.id + "/p/" + f.art + "/" + seed(100) + ".png");
    assert.equal(out.status, 200);
  } finally { mode = ""; }
  assert.equal([...hits.values()].reduce((a, b) => a + b, 0), before);
});

test("the disk cache keeps to its size: the oldest unused drawings go first", async () => {
  const side = 64;
  const noisy = (k) => { const d = new Uint8Array(side * side * 4); let s = k * 7919 + 1; for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = i % 4 === 3 ? 255 : s >>> 24; } return encodePng(side, side, d); };
  const opts = Array.from({ length: 8 }, (_, k) => ({ value: "o" + k, weight: 1, image: "l/" + k + ".png" }));
  const files = Object.fromEntries([["cover.png", tile([0, 0, 0, 255])], ...opts.map((o, k) => [o.image, noisy(k)])]);
  const f = addFolder({ version: 1, kind: "layers", name: "Z", symbol: "", description: "", cover: "cover.png", width: side, height: side, layers: [{ name: "L", options: opts }] }, files);
  const S = settings({ cacheMaxBytes: 80000 });
  const one = noisy(0).length;
  for (let i = 0; i < 40; i++) assert.equal((await route(S, "/art/u/" + f.id + "/p/" + f.art + "/" + seed(300 + i) + ".png")).status, 200);
  let total = 0;
  for (const x of fs.readdirSync(S.cacheDir, { recursive: true })) { const st = fs.statSync(path.join(S.cacheDir, String(x))); if (st.isFile()) total += st.size; }
  assert.ok(total <= 80000 + one, "cache " + total + " bytes, cap 80000");
});

test("hidden by the operator: plain image and words, collection.json 410; parseHiddenList", async () => {
  const S = settings();
  const f = addFolder(pics(), picFiles);
  fs.writeFileSync(S.hiddenFile, "# hidden folders\n" + f.id + "  # bad upload\nnot-an-id\n");
  const j = body(await route(S, "/art/u/" + f.id + "/p/" + f.art + "/" + seed(1)));
  assert.equal(j.description, "Hidden by the site operator.");
  assert.equal(j.image, ORIGIN + "/art/hidden.png");
  const png = await route(S, "/art/u/" + f.id + "/p/" + f.art + "/" + seed(1) + ".png");
  assert.equal(png.status, 200); assert.equal(decodePng(png.body).width, 256);
  assert.equal((await route(S, "/art/u/" + f.id + "/collection.json")).status, 410);
  assert.equal(body(await route(S, "/art/u/" + f.id + "/c/11111111111111111111111111111111")).description, "Hidden by the site operator.");
  assert.equal(hits.get("/" + f.id + "/collection.json"), undefined, "a hidden folder is not even read");
  assert.equal((await route(S, "/art/hidden.png")).type, "image/png");
  assert.deepEqual([...parseHiddenList("a\n" + f.id + " x\r\n  # " + newId() + "\n\t" + f.id)], [f.id]);
});

test("failures answer JSON with a code, never a crash: not found, gateway down or slow, too large, broken", async () => {
  const S = settings();
  const missing = newId();
  let out = await route(S, "/art/u/" + missing + "/p/" + "0".repeat(32) + "/" + seed(1));
  assert.equal(out.status, 404); assert.equal(body(out).code, "NOT_FOUND");
  await route(S, "/art/u/" + missing + "/p/" + "0".repeat(32) + "/" + seed(2));
  assert.equal(hits.get("/" + missing + "/collection.json"), 1, "a missing folder is remembered for a while");
  const f = addFolder(pics(), picFiles);
  mode = "fail";
  try { out = await route(S, "/art/u/" + f.id + "/p/" + f.art + "/" + seed(1)); } finally { mode = ""; }
  assert.equal(out.status, 502); assert.equal(body(out).code, "GATEWAY"); assert.equal(out.cache, "no-store");
  const g = addFolder(pics(), picFiles);
  mode = "slow";
  try { out = await route(S, "/art/u/" + g.id + "/p/" + g.art + "/" + seed(1)); } finally { mode = ""; }
  assert.equal(out.status, 502); assert.match(body(out).error, /no answer in time/);
  const big = newId();
  folders.set(big, new Map([["collection.json", { bytes: Buffer.alloc(4_000_001, 32), type: "application/json" }]]));
  out = await route(S, "/art/u/" + big + "/p/" + "0".repeat(32) + "/" + seed(1));
  assert.equal(out.status, 422); assert.equal(body(out).code, "TOO_LARGE");
  const bad = newId();
  folders.set(bad, new Map([["collection.json", { bytes: Buffer.from('{"version":1,"kind":"pictures","name":"x"}'), type: "application/json" }]]));
  out = await route(S, "/art/u/" + bad + "/p/" + "0".repeat(32) + "/" + seed(1));
  assert.equal(out.status, 422); assert.equal(body(out).code, "BAD_COLLECTION"); assert.match(body(out).error, /collection.json is not valid/);
  const lay = addFolder(mix(), { ...mixFiles, "l/b.png": Buffer.from("not a png") });
  let sawBad = false;
  for (let i = 0; i < 12 && !sawBad; i++) {
    const s = seed(500 + i);
    if (pickPiece(lay.c, s).options[0] !== 1) continue;
    out = await route(S, "/art/u/" + lay.id + "/p/" + lay.art + "/" + s + ".png");
    sawBad = out.status === 422 && body(out).code === "BAD_COLLECTION";
  }
  assert.ok(sawBad, "a layer file that is not a PNG answers 422");
});

test("the generated renderer's routes answer as before", async () => {
  const art = "0".repeat(31) + "1", s = seed(9);
  const svg = await artRoute("/art/p/" + art + "/" + s + ".svg", ORIGIN, "");
  assert.equal(svg.status, 200); assert.equal(svg.body, renderPieceSvg(art, s)); assert.equal(svg.cache, "public, max-age=31536000, immutable");
  const j = JSON.parse((await artRoute("/art/p/" + art + "/" + s, ORIGIN, "")).body);
  assert.equal(j.image, ORIGIN + "/art/p/" + art + "/" + s + ".svg");
  const c = JSON.parse((await artRoute("/art/c/11111111111111111111111111111111", ORIGIN, "")).body);
  assert.equal(c.name, "Programmable collection");
  const no = await artRoute("/art/nothing", ORIGIN, "");
  assert.equal(no.status, 404); assert.match(JSON.parse(no.body).error, /^Not an art path/);
});

test("serve.js keeps the resolver's cache and hide list out of /uploads", () => {
  for (const p of ["art-cache/ab/cd.png", "ART-CACHE", "art-hidden.txt", "art-hidden.txt.", "Art-Hidden.TXT::$DATA"]) assert.equal(isArtPrivate(p), true, p);
  for (const p of ["a.png", "art-cache-x/a", "x/art-hidden.txt"]) assert.equal(isArtPrivate(p), false, p);
  assert.equal(isServerFile("api/_art.js"), true);
});
