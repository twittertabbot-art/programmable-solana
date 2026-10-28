// A launcher's own art (sdk/src/artpack.ts): collection.json checks, the draw, the chances and
// the addresses. Offline. Runs on the built bundle:
//   npm run build -w sdk && npm test -w sdk
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ART_FILE, ART_LIMITS, ART_URI_BASE_MAX, checkCollection, encodeCollection, parseCollection, collectionArt, collectionArtHex,
  artRoll, pickPiece, traitOdds, itemChances, optionChances, isFolderId, artUriBase, parseArtUriBase, artFileUrl, safeArtPath,
  sniffImage, artPieceMetadata, artCollectionMetadata, isArtPath, artTypeOf,
} from "../dist/index.js";

const pictures = () => ({
  version: 1, kind: "pictures", name: "Cards", symbol: "CRD", description: "Six cards.", cover: "cover.png",
  attributes: [{ trait_type: "Power", value: 7, display_type: "number" }],
  items: [
    { image: "images/0.png", name: "Red", attributes: [{ trait_type: "Colour", value: "Red" }, { trait_type: "Stripe", value: "none" }], weight: 1 },
    { image: "images/1.png", name: "Blue", attributes: [{ trait_type: "Colour", value: "Blue" }, { trait_type: "Stripe", value: "thin" }], weight: 3 },
    { image: "images/2.jpg", name: "Green", description: "The green one.", attributes: [{ trait_type: "Colour", value: "Green" }], weight: 6 },
    { image: "images/3.gif", name: "Never", attributes: [{ trait_type: "Colour", value: "Grey" }], weight: 0 },
  ],
});
const layers = () => ({
  version: 1, kind: "layers", name: "Mix", symbol: "MIX", description: "", cover: "cover.png", width: 100, height: 100,
  layers: [
    { name: "Background", options: [{ value: "Night", weight: 1, image: "l/bg/night.png" }, { value: "Day", weight: 3, image: "l/bg/day.png" }] },
    { name: "Hat", options: [{ value: "None", weight: 1, none: true }, { value: "Cap", weight: 1, image: "l/hat/cap.png" }] },
    { name: "Eyes", options: [{ value: "Round", weight: 1, image: "l/eyes/a.png" }, { value: "Round", weight: 1, image: "l/eyes/b.png" }, { value: "Slit", weight: 2, image: "l/eyes/c.png" }] },
  ],
});
const seeds = (n, salt = 0) => Array.from({ length: n }, (_, i) => createHash("sha256").update("seed" + salt + ":" + i).digest("hex").slice(0, 32));
const errs = (j, files) => checkCollection(j, files).errors.join(" | ");

test("a valid pictures collection is accepted, normalised and its files listed", () => {
  const j = pictures();
  j.name = "  Cards  "; j.extra = "dropped"; j.items[0].note = "dropped too";
  const r = checkCollection(j);
  assert.equal(r.ok, true, r.errors.join(" "));
  assert.equal(r.collection.name, "Cards");
  assert.equal(r.collection.extra, undefined);
  assert.equal(r.collection.items[0].note, undefined);
  assert.deepEqual(Object.keys(r.collection), ["version", "kind", "name", "symbol", "description", "cover", "attributes", "items"]);
  assert.deepEqual(r.paths, ["cover.png", "images/0.png", "images/1.png", "images/2.jpg", "images/3.gif"]);
  assert.match(r.warnings.join(" "), /weight of 0/);
});

test("a valid layers collection is accepted; width and height are required", () => {
  const r = checkCollection(layers());
  assert.equal(r.ok, true, r.errors.join(" "));
  assert.equal(r.collection.layers[1].options[0].none, true);
  assert.equal(r.collection.layers[1].options[0].image, undefined);
  const j = layers(); delete j.width;
  assert.match(errs(j), /width must be a whole number/);
  const k = layers(); k.width = 2048; k.height = 2049;
  assert.match(errs(k), /height must be a whole number of pixels from 1 to 2048/);
  const big = layers(); big.width = 2048; big.height = 2048;
  assert.equal(checkCollection(big).ok, true);
});

test("what checkCollection refuses, each with a sentence that says where", () => {
  const cases = [
    [(j) => { j.version = 2; }, /version must be 1/],
    [(j) => { j.kind = "mixed"; }, /kind must be "pictures" or "layers"/],
    [(j) => { j.name = ""; }, /The collection name is empty/],
    [(j) => { j.name = "x".repeat(65); }, /is 65 bytes long; the most is 64/],
    [(j) => { j.symbol = "TOOLONGSYMB"; }, /The symbol is 11 bytes long/],
    [(j) => { j.items[1].image = "images/my file.png"; }, /Item 2 \(Blue\): the path images\/my file.png may only use/],
    [(j) => { j.items[1].image = "images/../x.png"; }, /no part may start with a dot/],
    [(j) => { j.items[1].image = "collection.json"; }, /collection.json cannot be an image/],
    [(j) => { j.items[1].image = "images/1.bmp"; }, /must be a png, jpg, gif or webp file/],
    [(j) => { j.items[1].weight = 1.5; }, /Item 2 \(Blue\): the weight must be a whole number from 0 to 1000000/],
    [(j) => { j.items[1].weight = -1; }, /the weight must be a whole number/],
    [(j) => { j.items[1].weight = 1000001; }, /the weight must be a whole number/],
    [(j) => { for (const i of j.items) i.weight = 0; }, /At least one picture needs a weight above 0/],
    [(j) => { j.items[0].attributes.push({ trait_type: "colour", value: "x" }); }, /the trait colour is listed twice/],
    [(j) => { j.items[0].attributes.push({ trait_type: "Power", value: 1 }); }, /the trait Power is also a common attribute/],
    [(j) => { j.items[0].attributes[0].display_type = "number"; }, /a display_type needs a number value/],
    [(j) => { j.items[0].attributes[0].value = ""; }, /the value is empty/],
    [(j) => { j.items[0].attributes = Array.from({ length: 33 }, (_, i) => ({ trait_type: "t" + i, value: 1 })); }, /at most 32 attributes/],
    [(j) => { j.items[0].attributes = Array.from({ length: 32 }, (_, i) => ({ trait_type: "t" + i, value: 1 })); }, /with the common attributes it has more than 32/],
    [(j) => { j.items[0].name = "a\u0001b"; }, /control character/],
    [(j) => { j.description = "x".repeat(2001); }, /The description is 2001 bytes long/],
    [(j) => { j.external_url = "ftp://x"; }, /external_url must be an http or https address/],
    [(j) => { j.seller_fee_basis_points = 10001; }, /seller_fee_basis_points must be a whole number from 0 to 10000/],
    [(j) => { j.creators = [{ address: "11111111111111111111111111111111", share: 60 }, { address: "Vote111111111111111111111111111111111111111", share: 30 }]; }, /shares must add up to 100/],
    [(j) => { j.creators = [{ address: "not an address", share: 100 }]; }, /Creator 1: the address must be a Solana address/],
    [(j) => { j.layers = []; }, /A pictures collection has no layers/],
    [(j) => { j.items = []; }, /items must be a list of at least one picture/],
    [(j) => { delete j.cover; }, /The cover: the image path is missing/],
  ];
  for (const [change, want] of cases) { const j = pictures(); change(j); const r = checkCollection(j); assert.equal(r.ok, false, String(want)); assert.equal(r.collection, null); assert.match(r.errors.join(" | "), want); }
  const lcases = [
    [(j) => { j.layers[0].options[0].image = "l/bg/night.jpg"; }, /Layer 1 \(Background\), option 1 \(Night\): l\/bg\/night.jpg must be a PNG file/],
    [(j) => { j.layers[1].options[0].image = "l/x.png"; }, /an empty option has no image/],
    [(j) => { j.layers[1].name = "background"; }, /two layers are called background/],
    [(j) => { j.layers[2].options = []; }, /options must be a list of at least one option/],
    [(j) => { j.layers[2].options = Array.from({ length: 101 }, (_, i) => ({ value: "v" + i, weight: 1, image: "l/" + i + ".png" })); }, /at most 100 options/],
    [(j) => { j.layers = Array.from({ length: 17 }, (_, i) => ({ name: "L" + i, options: [{ value: "a", weight: 1, image: "l/" + i + ".png" }] })); }, /At most 16 layers/],
    [(j) => { j.items = []; }, /A layers collection has no items/],
    [(j) => { for (const o of j.layers[0].options) o.weight = 0; }, /Layer 1 \(Background\): at least one option needs a weight above 0/],
    [(j) => { j.attributes = [{ trait_type: "Hat", value: "x" }]; }, /Hat is also a common attribute/],
    [(j) => { j.width = 2048; j.height = 2048; j.width = 4000; }, /width must be a whole number/],
  ];
  for (const [change, want] of lcases) { const j = layers(); change(j); assert.match(errs(j), want); }
  assert.match(errs(null), /must be a JSON object/);
  assert.match(errs([]), /must be a JSON object/);
});

test("with the files: missing, too large, wrong type, wrong layer size, unused, totals", () => {
  const j = pictures();
  const files = [
    { path: "cover.png", bytes: 1000, type: "image/png" }, { path: "images/0.png", bytes: 2000, type: "image/png" }, { path: "images/1.png", bytes: 3000 },
    { path: "images/2.jpg", bytes: 4000, type: "image/jpeg" }, { path: "images/3.gif", bytes: 500, type: "image/gif" }, { path: "extra.png", bytes: 10 }, { path: ART_FILE, bytes: 99 },
  ];
  const r = checkCollection(j, files);
  assert.equal(r.ok, true, r.errors.join(" "));
  assert.equal(r.bytes, 1000 + 2000 + 3000 + 4000 + 500 + encodeCollection(r.collection).length);
  assert.match(r.warnings.join(" "), /One file is not used by the collection/);
  assert.match(errs(j, files.filter((f) => f.path !== "images/1.png")), /The file images\/1.png is missing/);
  assert.match(errs(j, files.map((f) => (f.path === "images/1.png" ? { ...f, bytes: ART_LIMITS.fileBytes + 1 } : f))), /images\/1.png is 20000001 bytes; the most is 20000000/);
  assert.match(errs(j, files.map((f) => (f.path === "images/1.png" ? { ...f, bytes: 0 } : f))), /images\/1.png is empty/);
  assert.match(errs(j, files.map((f) => (f.path === "images/2.jpg" ? { ...f, type: "image/png" } : f))), /images\/2.jpg is a image\/png file, but its name says image\/jpeg/);
  const l = layers();
  const lf = [{ path: "cover.png", bytes: 10 }, ...l.layers.flatMap((ly) => ly.options.filter((o) => o.image).map((o) => ({ path: o.image, bytes: 10, width: 100, height: 100 })))];
  assert.equal(checkCollection(l, lf).ok, true);
  assert.match(errs(l, lf.map((f) => (f.path === "l/hat/cap.png" ? { ...f, width: 99 } : f))), /The layer image l\/hat\/cap.png is 99 by 100 pixels; every layer must be 100 by 100/);
  assert.match(errs(l, lf.map((f) => (f.path === "l/hat/cap.png" ? { ...f, bytes: ART_LIMITS.layerFileBytes + 1 } : f))), /for a layer/);
  assert.match(errs(j, files.map((f) => (f.path === "images/0.png" ? { ...f, bytes: ART_LIMITS.totalBytes } : f))), /The folder would be/);
});

test("10,000 pictures are accepted; 10,001 are not", () => {
  const j = pictures();
  j.items = Array.from({ length: ART_LIMITS.items }, (_, i) => ({ image: "images/" + i + ".png", name: "Card #" + i, attributes: [{ trait_type: "N", value: i }], weight: 1 + (i % 7) }));
  const t0 = Date.now();
  const r = checkCollection(j);
  assert.equal(r.ok, true, r.errors.join(" "));
  assert.ok(Date.now() - t0 < 2000, "checking 10,000 items takes under 2 s");
  assert.ok(encodeCollection(r.collection).length < ART_LIMITS.manifestBytes);
  j.items.push({ ...j.items[0] });
  assert.match(errs(j), /At most 10000 pictures/);
});

test("encodeCollection is the exact upload; parseCollection reads it back; collectionArt is its hash", () => {
  const c = checkCollection(pictures()).collection;
  const bytes = encodeCollection(c);
  assert.equal(new TextDecoder().decode(bytes), JSON.stringify(c) + "\n");
  assert.deepEqual(encodeCollection(checkCollection(JSON.parse(new TextDecoder().decode(bytes))).collection), bytes, "encoding is stable");
  assert.deepEqual(parseCollection(bytes), c);
  assert.deepEqual(parseCollection("﻿" + JSON.stringify(c)), c, "a byte order mark is accepted");
  assert.throws(() => parseCollection(Uint8Array.from([0xff, 0xfe, 0x00])), /not UTF-8 text/);
  assert.throws(() => parseCollection("{"), /not valid JSON/);
  assert.throws(() => parseCollection('{"version":1}'), /collection.json is not valid: kind must be/);
  assert.throws(() => parseCollection(new Uint8Array(ART_LIMITS.manifestBytes + 1)), /larger than/);
  const want = createHash("sha256").update(bytes).digest().subarray(0, 16);
  assert.deepEqual(Buffer.from(collectionArt(bytes)), want);
  assert.equal(collectionArtHex(bytes), want.toString("hex"));
});

test("artRoll is sha256('programmable-art-v1:' || seed || index), first 6 bytes big-endian", () => {
  const seed = "00112233445566778899aabbccddeeff";
  for (const i of [0, 1, 7, 255]) {
    const h = createHash("sha256").update(Buffer.concat([Buffer.from("programmable-art-v1:"), Buffer.from(seed, "hex"), Buffer.from([i])])).digest();
    assert.equal(artRoll(seed, i), h.readUIntBE(0, 6));
  }
  assert.equal(artRoll(seed.toUpperCase(), 3), artRoll(seed, 3));
  assert.throws(() => artRoll("00", 0), /A seed is 32 hex characters/);
  assert.throws(() => artRoll(seed, 256), /0 to 255/);
});

test("the draw is fixed: a known collection and seed give a known piece (third parties rely on this)", () => {
  const c = checkCollection(layers()).collection;
  const seed = "00112233445566778899aabbccddeeff";
  const p = pickPiece(c, seed);
  const expect = c.layers.map((ly, i) => { const w = ly.options.map((o) => o.weight); const total = w.reduce((a, b) => a + b, 0); let r = artRoll(seed, i) % total; return w.findIndex((x) => (r -= x) < 0); });
  assert.deepEqual(p.options, expect);
  assert.deepEqual([0, 1, 2].map((i) => artRoll(seed, i)), [31474065579687, 157154941731317, 247093959500929], "the rolls written in HOOKS.md");
  assert.deepEqual(p.options, [1, 1, 1], "the vector written in HOOKS.md");
  assert.deepEqual(p.images, ["l/bg/day.png", "l/hat/cap.png", "l/eyes/b.png"]);
  assert.deepEqual(p.attributes, [{ trait_type: "Background", value: "Day" }, { trait_type: "Hat", value: "Cap" }, { trait_type: "Eyes", value: "Round" }]);
  assert.equal(p.chance, (3 / 4) * (1 / 2) * (1 / 4));
  const q = pickPiece(checkCollection(pictures()).collection, seed);
  assert.equal(q.item, 2, "the vector written in HOOKS.md");
  assert.equal(q.description, "The green one.");
  assert.deepEqual(q.attributes, [{ trait_type: "Colour", value: "Green" }, { trait_type: "Power", value: 7, display_type: "number" }]);
  assert.equal(q.chance, 0.6);
});

test("pictures are drawn by weight; a weight of 0 is never drawn", () => {
  const c = checkCollection(pictures()).collection;
  const counts = [0, 0, 0, 0];
  const N = 20000;
  for (const s of seeds(N)) counts[pickPiece(c, s).item]++;
  assert.equal(counts[3], 0);
  for (const [i, w] of [[0, 0.1], [1, 0.3], [2, 0.6]]) assert.ok(Math.abs(counts[i] / N - w) < 0.015, "item " + i + " drawn " + counts[i] / N + ", weight share " + w);
  assert.deepEqual(itemChances(c), [0.1, 0.3, 0.6, 0]);
  assert.deepEqual(optionChances(c), []);
});

test("layers draw one option per layer, independently; an empty option draws no image", () => {
  const c = checkCollection(layers()).collection;
  const N = 20000;
  const joint = new Map(); const hat = [0, 0]; let noImageHat = 0;
  for (const s of seeds(N, 1)) {
    const p = pickPiece(c, s);
    const k = p.options[0] + "," + p.options[1];
    joint.set(k, (joint.get(k) || 0) + 1);
    hat[p.options[1]]++;
    if (p.options[1] === 0) { if (!p.images.includes("l/hat/cap.png") && p.images.length === 2) noImageHat++; }
  }
  assert.equal(noImageHat, hat[0]);
  for (const [k, n] of joint) { const [a, b] = k.split(",").map(Number); const want = (a ? 0.75 : 0.25) * 0.5; assert.ok(Math.abs(n / N - want) < 0.015, "joint " + k + " " + n / N + " vs " + want); }
  const odds = traitOdds(c);
  assert.deepEqual(odds.map((t) => t.trait_type), ["Background", "Hat", "Eyes"]);
  assert.deepEqual(odds[2].values.map((v) => [v.value, v.weight, v.chance]), [["Round", 2, 0.5], ["Slit", 2, 0.5]], "two options with one value add up");
  for (const t of odds) assert.ok(Math.abs(t.values.reduce((a, v) => a + v.chance, 0) - 1) < 1e-12);
  assert.deepEqual(optionChances(c), [[0.25, 0.75], [0.5, 0.5], [0.25, 0.25, 0.5]]);
});

test("traitOdds for pictures, common attributes have a chance of 1", () => {
  const c = checkCollection(pictures()).collection;
  const odds = traitOdds(c);
  const colour = odds.find((t) => t.trait_type === "Colour");
  assert.deepEqual(colour.values.map((v) => [v.value, v.chance]), [["Red", 0.1], ["Blue", 0.3], ["Green", 0.6], ["Grey", 0]]);
  assert.deepEqual(odds.find((t) => t.trait_type === "Stripe").values.map((v) => [v.value, v.chance]), [["none", 0.1], ["thin", 0.3]]);
  assert.deepEqual(odds.find((t) => t.trait_type === "Power").values, [{ value: 7, weight: 1, chance: 1 }]);
});

test("addresses: folder ids, uri_base within 80 bytes, gateway file addresses, safe paths", () => {
  const ar = "je67CqI5FeALMas3l_yC0Ne3qKnB8MFup1IilXilpv4", irys = "8eNpkShMwdbiNBtGuVGBKp8feDZCa21VppX2eDi3eLME";
  assert.ok(isFolderId(ar) && isFolderId(irys));
  for (const bad of ["", "short", "x".repeat(45), "je67CqI5FeALMas3l/yC0Ne3qKnB8MFup1IilXilpv4", null]) assert.equal(isFolderId(bad), false);
  const u = artUriBase("https://programmableonsol.com/", ar);
  assert.equal(u, "https://programmableonsol.com/art/u/" + ar);
  assert.equal(u.length, 79);
  assert.equal(artUriBase("https://programmableonsol.com", irys).length, 80);
  assert.equal(ART_URI_BASE_MAX, 80);
  assert.throws(() => artUriBase("https://www.programmableonsol.com", irys), /is 84 bytes, and a coin allows 80\. This site's address is too long for uploaded art: it can be at most 29 characters/);
  assert.throws(() => artUriBase("programmableonsol.com", ar), /must start with http/);
  assert.throws(() => artUriBase("https://a.b", "nope"), /not a folder id/);
  assert.deepEqual(parseArtUriBase(u), { origin: "https://programmableonsol.com", folderId: ar });
  assert.equal(parseArtUriBase("https://programmableonsol.com/art"), null);
  assert.equal(parseArtUriBase(u + "/p"), null);
  assert.equal(artFileUrl("https://arweave.net/", ar, "images/a b#.png"), "https://arweave.net/" + ar + "/images/a%20b%23.png");
  assert.equal(safeArtPath("My Pics\\Blue Eyes.PNG"), "My_Pics/Blue_Eyes.png");
  assert.equal(safeArtPath("../.hidden/ü x.JPG"), "hidden/u_x.jpg");
  assert.equal(safeArtPath("collection.json"), "collection-image.json");
  const long = safeArtPath("a".repeat(70) + "/" + "b".repeat(70) + "/c.png");
  assert.ok(isArtPath(long) && long.endsWith("/c.png") && long.length <= 120);
  assert.ok(isArtPath(safeArtPath("Hats/Top Hat (rare).png")));
  assert.equal(artTypeOf("x/Y.JPEG"), "image/jpeg");
  assert.equal(isArtPath("x.svg"), false);
});

test("sniffImage reads the type and, for PNG, GIF and WebP, the size", () => {
  const pngHead = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 3, 232, 0, 0, 2, 88, 8, 6, 0, 0, 0])]);
  assert.deepEqual(sniffImage(pngHead), { type: "image/png", ext: "png", width: 1000, height: 600 });
  assert.deepEqual(sniffImage(Buffer.from("GIF89a\x20\x00\x10\x00......", "latin1")), { type: "image/gif", ext: "gif", width: 32, height: 16 });
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])).type, "image/jpeg");
  const vp8x = Buffer.alloc(30); vp8x.write("RIFF", 0); vp8x.write("WEBP", 8); vp8x.write("VP8X", 12); vp8x.writeUIntLE(499, 24, 3); vp8x.writeUIntLE(299, 27, 3);
  assert.deepEqual(sniffImage(vp8x), { type: "image/webp", ext: "webp", width: 500, height: 300 });
  assert.equal(sniffImage(Buffer.from("<svg xmlns=...>")), null);
});

test("the JSON a piece and the collection answer (Metaplex fields)", () => {
  const c = checkCollection({ ...pictures(), external_url: "https://example.com" }).collection;
  const pick = pickPiece(c, "00112233445566778899aabbccddeeff");
  const j = artPieceMetadata(c, pick, "https://gw/x/images/2.jpg", "image/jpeg");
  assert.deepEqual(Object.keys(j), ["name", "symbol", "description", "image", "external_url", "attributes", "properties"]);
  assert.deepEqual(j.properties, { category: "image", files: [{ uri: "https://gw/x/images/2.jpg", type: "image/jpeg" }] });
  assert.equal(j.symbol, "CRD");
  const k = artCollectionMetadata(c, "https://gw/x/cover.png", "image/png", "https://site/coin.html?pool=P");
  assert.equal(k.external_url, "https://site/coin.html?pool=P");
  assert.equal(k.image, "https://gw/x/cover.png");
});
