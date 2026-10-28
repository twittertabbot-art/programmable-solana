// Review fixtures for the collectible art: a folder of finished pictures in the Metaplex / Sugar
// layout and a folder of layers, written as real PNG files into a folder the caller names (a
// temp folder, never the repository).
//   import { makeFixtures } from "./art-fixtures.mjs";
//   const f = makeFixtures(dir, { pictures: 20, size: 256 });
//   f.pictures  the folder with 0.png ... 19.png, 0.json ... 19.json, collection.json, collection.png
//   f.layers    the folder with one folder per layer: 1_Background, 2_Body, 3_Eyes, 4_Hat
//   f.items     what each picture's JSON says (name, attributes), in order
//   f.layerSpec the layers as written: [{ folder, name, options: [{ file, value, weight }] }]
//   f.csv       five pictures and list.csv (semicolons, a quoted name with a comma, a weight column)
//   f.alone     three pictures with no JSON and no CSV
// The pictures are flat colours with a few shapes, the layers are drawn with transparency, so
// a composite shows every layer that was drawn.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/// An RGBA PNG from a pixel function (x, y) -> [r, g, b, a].
export function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, b, a] = px(x, y); const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return [f(0), f(8), f(4)];
}

export function makeFixtures(dir, { pictures = 20, size = 256 } = {}) {
  rmSync(dir, { recursive: true, force: true });
  const pic = path.join(dir, "my-collection"), lay = path.join(dir, "my-layers");
  mkdirSync(pic, { recursive: true });
  const BG = ["Night", "Dawn", "Sea", "Moss"], SHAPE = ["Circle", "Square", "Diamond"], items = [];
  for (let i = 0; i < pictures; i++) {
    const hue = (i * 360) / pictures, bg = BG[i % BG.length], shape = SHAPE[i % SHAPE.length];
    const [r, g, b] = hsl(hue, 60, 22), [fr, fg, fb] = hsl((hue + 160) % 360, 80, 62);
    const c = size / 2, rad = size * (0.18 + (i % 5) * 0.03);
    const inside = (x, y) => shape === "Circle" ? (x - c) ** 2 + (y - c) ** 2 < rad * rad : shape === "Square" ? Math.abs(x - c) < rad && Math.abs(y - c) < rad : Math.abs(x - c) + Math.abs(y - c) < rad * 1.3;
    writeFileSync(path.join(pic, i + ".png"), png(size, size, (x, y) => (inside(x, y) ? [fr, fg, fb, 255] : [r, g, b, 255])));
    const meta = { name: "Shape #" + (i + 1), symbol: "SHP", description: "Picture number " + (i + 1) + " of the review collection.", seller_fee_basis_points: 500, image: i + ".png",
      attributes: [{ trait_type: "Background", value: bg }, { trait_type: "Shape", value: shape }, { trait_type: "Power", value: 10 + i, display_type: "number" }],
      properties: { files: [{ uri: i + ".png", type: "image/png" }], category: "image", creators: [] } };
    writeFileSync(path.join(pic, i + ".json"), JSON.stringify(meta, null, 2));
    items.push(meta);
  }
  writeFileSync(path.join(pic, "collection.json"), JSON.stringify({ name: "Review Shapes", symbol: "SHP", description: "A collection made for the review flow.", image: "collection.png" }, null, 2));
  writeFileSync(path.join(pic, "collection.png"), png(size, size, (x, y) => ((x >> 4) + (y >> 4)) % 2 ? [40, 40, 48, 255] : [220, 212, 200, 255]));

  // four layers with transparency: a background, a body, eyes and a hat that can be left out
  const layerSpec = [
    { folder: "1_Background", name: "Background", options: [["Blue", 30, (x, y) => [40, 70, 160, 255]], ["Green", 20, () => [40, 130, 80, 255]], ["Sand", 10, () => [200, 170, 110, 255]]] },
    { folder: "2_Body", name: "Body", options: [["Round", 25, (x, y) => ((x - size / 2) ** 2 + (y - size * 0.6) ** 2 < (size * 0.3) ** 2 ? [235, 225, 210, 255] : [0, 0, 0, 0])], ["Tall", 15, (x, y) => (Math.abs(x - size / 2) < size * 0.2 && y > size * 0.3 && y < size * 0.95 ? [180, 90, 60, 255] : [0, 0, 0, 0])]] },
    { folder: "3_Eyes", name: "Eyes", options: [["Dots", 40, (x, y) => (((x - size * 0.42) ** 2 + (y - size * 0.55) ** 2 < (size * 0.03) ** 2 || (x - size * 0.58) ** 2 + (y - size * 0.55) ** 2 < (size * 0.03) ** 2) ? [10, 10, 12, 255] : [0, 0, 0, 0])], ["Visor", 10, (x, y) => (Math.abs(y - size * 0.55) < size * 0.03 && Math.abs(x - size / 2) < size * 0.14 ? [230, 40, 60, 255] : [0, 0, 0, 0])]] },
    { folder: "4_Hat", name: "Hat", options: [["Cap", 5, (x, y) => (y > size * 0.2 && y < size * 0.32 && Math.abs(x - size / 2) < size * 0.18 ? [250, 200, 40, 255] : [0, 0, 0, 0])], ["Crown", 1, (x, y) => (y > size * 0.14 && y < size * 0.3 && Math.abs(x - size / 2) < size * 0.14 && (y > size * 0.22 || Math.floor(x / (size * 0.05)) % 2 === 0) ? [255, 215, 0, 255] : [0, 0, 0, 0])]] },
  ];
  for (const l of layerSpec) {
    mkdirSync(path.join(lay, l.folder), { recursive: true });
    l.options = l.options.map(([value, weight, px]) => { const file = value + "#" + weight + ".png"; writeFileSync(path.join(lay, l.folder, file), png(size, size, px)); return { file, value, weight }; });
  }
  // a CSV with five pictures (semicolons, a quoted name with a comma in it, a weight column),
  // and three pictures alone
  const csv = path.join(dir, "my-csv"), alone = path.join(dir, "my-images");
  mkdirSync(csv, { recursive: true }); mkdirSync(alone, { recursive: true });
  const csvRows = [["file", "name", "weight", "Background", "Mood"]];
  for (let i = 0; i < 5; i++) {
    const [r, g, b] = hsl(i * 70, 70, 50);
    writeFileSync(path.join(csv, "art_" + (i + 1) + ".png"), png(64, 64, () => [r, g, b, 255]));
    csvRows.push(["art_" + (i + 1) + ".png", i === 2 ? "\"Calm, at last\"" : "Card " + (i + 1), String((i + 1) * 10), BG[i % BG.length], i % 2 ? "Calm" : "Loud"]);
  }
  writeFileSync(path.join(csv, "list.csv"), csvRows.map((r) => r.join(";")).join("\r\n") + "\r\n");
  for (let i = 0; i < 3; i++) { const [r, g, b] = hsl(200 + i * 40, 60, 40); writeFileSync(path.join(alone, "blue_" + (i + 1) + ".png"), png(64, 64, () => [r, g, b, 255])); }
  return { pictures: pic, layers: lay, items, layerSpec, csv, alone };
}
