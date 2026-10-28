// PNG decoding, layer compositing and PNG encoding for the art resolver (web/api/_art.js), in
// plain JavaScript on node:zlib: no native package to install on the server.
//   decodePng(bytes, limits)        any PNG (every colour type, bit depths 1 to 16, interlaced or
//                                   not) as { width, height, data } with data RGBA, 8 bits each
//   encodePng(width, height, rgba)  an RGBA PNG, one filter chosen per row
//   compositeLayers(pngs, w, h)     the layers drawn in order (source over), encoded as a PNG
//   compositeLayersAsync(...)       the same in short steps with streamed zlib: little memory, and
//                                   the server answers other requests while it draws
//   startCompositor()               one drawing at a time, a queue with a limit, optionally in a
//                                   worker thread
import zlib from "node:zlib";
import fs from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
// Adam7: start x, start y, step x, step y of the seven passes
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function fail(message) { const e = new Error(message); e.code = "BAD_IMAGE"; return e; }

/// Undo the PNG row filters of one (sub-)image, in place in `raw` (rows of a filter byte and
/// `stride` bytes, starting at `at`). Returns where the next sub-image starts.
function unfilter(raw, at, rows, stride, bpp) {
  let prev = -1;
  for (let y = 0; y < rows; y++) {
    const f = raw[at], row = at + 1;
    if (f === undefined || row + stride > raw.length) throw fail("The PNG image data is too short.");
    switch (f) {
      case 0: break;
      case 1: for (let i = bpp; i < stride; i++) raw[row + i] = (raw[row + i] + raw[row + i - bpp]) & 255; break;
      case 2: if (prev >= 0) for (let i = 0; i < stride; i++) raw[row + i] = (raw[row + i] + raw[prev + i]) & 255; break;
      case 3: for (let i = 0; i < stride; i++) raw[row + i] = (raw[row + i] + (((i >= bpp ? raw[row + i - bpp] : 0) + (prev >= 0 ? raw[prev + i] : 0)) >> 1)) & 255; break;
      case 4: for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? raw[row + i - bpp] : 0, b = prev >= 0 ? raw[prev + i] : 0, c = i >= bpp && prev >= 0 ? raw[prev + i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        raw[row + i] = (raw[row + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } break;
      default: throw fail("The PNG has an unknown row filter (" + f + ").");
    }
    prev = row;
    at = row + stride;
  }
  return at;
}

/// Any PNG as RGBA, 8 bits per channel. `limits`: { maxSide, maxPixels } refuse a large image
/// before any pixel is inflated. `into`: a buffer of width * height * 4 bytes to reuse.
export function decodePng(bytes, limits = {}, into = null) {
  const p = readPng(bytes, limits);
  const out = into && into.length >= p.width * p.height * 4 ? into.subarray(0, p.width * p.height * 4) : new Uint8Array(p.width * p.height * 4);
  if (p.interlace) { fillPixels(p, out); return { width: p.width, height: p.height, data: out }; }
  const w4 = p.width * 4;
  eachRow(p, (y, row) => out.set(row, y * w4));
  return { width: p.width, height: p.height, data: out };
}

/// Reads a PNG and hands every row to `emit(y, rgba)`, top to bottom, as RGBA with 8 bits per
/// channel. The row is a view that the next call overwrites: copy what you keep. Only one copy
/// of the inflated image is ever in memory (an interlaced image is put together whole first).
export function eachPngRow(bytes, limits, emit) {
  const p = readPng(bytes, limits);
  if (p.interlace) {
    const all = new Uint8Array(p.width * p.height * 4);
    fillPixels(p, all);
    const w4 = p.width * 4;
    for (let y = 0; y < p.height; y++) emit(y, all.subarray(y * w4, y * w4 + w4));
  } else eachRow(p, emit);
  return { width: p.width, height: p.height };
}

/// The rows of a non-interlaced PNG, unfiltered in place, as RGBA.
function eachRow(p, emit) {
  const stride = p.strideOf(p.width);
  unfilter(p.raw, 0, p.height, stride, p.bpp);
  if (p.color === 6 && p.depth === 8) {
    // the common case: a row is already RGBA, handed out without a copy
    for (let y = 0; y < p.height; y++) { const s = y * (stride + 1) + 1; emit(y, p.raw.subarray(s, s + stride)); }
    return;
  }
  const row = new Uint8Array(p.width * 4);
  for (let y = 0; y < p.height; y++) { convertRow(p, y * (stride + 1) + 1, p.width, row, 0, 0, 1); emit(y, row); }
}
/// Every pixel of a PNG (interlaced or not) into `out` (width * height * 4 bytes).
function fillPixels(p, out) {
  if (p.interlace) out.fill(0);
  let next = 0;
  for (const ps of p.passes) {
    const stride = p.strideOf(ps.w), start = next;
    next = unfilter(p.raw, next, ps.h, stride, p.bpp);
    for (let y = 0; y < ps.h; y++) convertRow(p, start + y * (stride + 1) + 1, ps.w, out, (ps.y0 + y * ps.dy) * p.width * 4, ps.x0, ps.dx);
  }
}

/// Reads the chunks and inflates the image data, before any pixel is converted.
function readPng(bytes, limits = {}) {
  const p = readChunks(bytes, limits);
  let raw;
  try { raw = zlib.inflateSync(p.idat.length === 1 ? p.idat[0] : Buffer.concat(p.idat), { maxOutputLength: p.expected + 1024 }); }
  catch (e) { throw fail("The PNG image data does not inflate (" + (e.code || e.message) + ")."); }
  if (raw.length < p.expected) throw fail("The PNG image data is too short.");
  p.raw = raw;
  return p;
}

/// The chunks of a PNG, checked: header, palette, transparency and the image data, not inflated.
function readChunks(bytes, limits = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw fail("This file is not a PNG image.");
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  let at = 8, sawHeader = false;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8), data = at + 8;
    if (data + len + 4 > buf.length) throw fail("The PNG file is cut short.");
    if (type === "IHDR") {
      width = buf.readUInt32BE(data); height = buf.readUInt32BE(data + 4); depth = buf[data + 8]; color = buf[data + 9]; interlace = buf[data + 12];
      if (!CHANNELS[color] || !DEPTHS[color].includes(depth)) throw fail("The PNG uses an unknown colour type or bit depth.");
      if (buf[data + 10] !== 0 || buf[data + 11] !== 0 || interlace > 1) throw fail("The PNG uses an unknown compression, filter or interlace method.");
      if (!width || !height) throw fail("The PNG has no pixels.");
      if (limits.width && (width !== limits.width || height !== limits.height)) throw fail("A layer is " + width + " by " + height + " pixels; the collection says " + limits.width + " by " + limits.height + ".");
      if ((limits.maxSide && (width > limits.maxSide || height > limits.maxSide)) || (limits.maxPixels && width * height > limits.maxPixels)) {
        throw fail("The PNG is " + width + " by " + height + " pixels, larger than this server draws.");
      }
      sawHeader = true;
    } else if (type === "PLTE") palette = buf.subarray(data, data + len);
    else if (type === "tRNS") trns = buf.subarray(data, data + len);
    else if (type === "IDAT") idat.push(buf.subarray(data, data + len));
    else if (type === "IEND") break;
    at = data + len + 4;
  }
  if (!sawHeader) throw fail("The PNG has no header.");
  if (!idat.length) throw fail("The PNG has no image data.");
  if (color === 3 && !palette) throw fail("The PNG has no palette.");
  const channels = CHANNELS[color], bits = channels * depth, bpp = Math.max(1, bits >> 3);
  const strideOf = (w) => Math.ceil((w * bits) / 8);
  const passes = interlace ? ADAM7.map(([x0, y0, dx, dy]) => ({ x0, y0, dx, dy, w: Math.ceil((width - x0) / dx), h: Math.ceil((height - y0) / dy) })).filter((p) => p.w > 0 && p.h > 0)
    : [{ x0: 0, y0: 0, dx: 1, dy: 1, w: width, h: height }];
  const expected = passes.reduce((n, p) => n + p.h * (1 + strideOf(p.w)), 0);
  // tRNS for grey and truecolour: one colour (in the file's own depth) that is fully transparent
  const tGrey = trns && color === 0 && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  const tRgb = trns && color === 2 && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  return { width, height, depth, color, interlace, palette, trns, tGrey, tRgb, channels, bpp, raw: null, idat, expected, passes, strideOf, max: (1 << depth) - 1 };
}

/// Undo one row's filter: `row` (stride bytes, filtered) against `prev` (the row above, already
/// unfiltered, or null for the first row), in place.
function unfilterRow(f, row, prev, bpp) {
  const n = row.length;
  switch (f) {
    case 0: return;
    case 1: for (let i = bpp; i < n; i++) row[i] = (row[i] + row[i - bpp]) & 255; return;
    case 2: if (prev) for (let i = 0; i < n; i++) row[i] = (row[i] + prev[i]) & 255; return;
    case 3: for (let i = 0; i < n; i++) row[i] = (row[i] + (((i >= bpp ? row[i - bpp] : 0) + (prev ? prev[i] : 0)) >> 1)) & 255; return;
    case 4: for (let i = 0; i < n; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev ? prev[i] : 0, c = i >= bpp && prev ? prev[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    } return;
    default: throw fail("The PNG has an unknown row filter (" + f + ").");
  }
}

/// Like eachPngRow, but the image data is inflated as a stream, a few rows at a time, so a layer
/// never takes more memory than two of its rows (an interlaced PNG is read whole, as before). The
/// work runs in many short steps, so the server answers other requests meanwhile.
export async function streamPngRows(bytes, limits, emit) {
  const p = readChunks(bytes, limits);
  if (p.interlace) { p.raw = readPng(bytes, limits).raw; const all = new Uint8Array(p.width * p.height * 4); fillPixels(p, all); const w4 = p.width * 4; for (let y = 0; y < p.height; y++) emit(y, all.subarray(y * w4, y * w4 + w4)); return { width: p.width, height: p.height }; }
  const stride = p.strideOf(p.width), rgba8 = p.color === 6 && p.depth === 8;
  let cur = new Uint8Array(stride), prev = new Uint8Array(stride), hasPrev = false;
  const out = rgba8 ? null : new Uint8Array(p.width * 4);
  // convertRow reads p.raw at an offset: point it at the current row
  const view = { ...p };
  let y = 0, filter = -1, fill = 0, total = 0;
  const take = (chunk) => {
    let at = 0;
    total += chunk.length;
    if (total > p.expected + 1024) throw fail("The PNG image data is longer than its header says.");
    while (at < chunk.length && y < p.height) {
      if (filter < 0) { filter = chunk[at++]; fill = 0; continue; }
      const n = Math.min(stride - fill, chunk.length - at);
      cur.set(chunk.subarray(at, at + n), fill); fill += n; at += n;
      if (fill === stride) {
        unfilterRow(filter, cur, hasPrev ? prev : null, p.bpp);
        if (rgba8) emit(y, cur);
        else { view.raw = cur; convertRow(view, 0, p.width, out, 0, 0, 1); emit(y, out); }
        const t = prev; prev = cur; cur = t; hasPrev = true;
        y++; filter = -1;
      }
    }
  };
  await new Promise((resolve, reject) => {
    const inf = zlib.createInflate({ chunkSize: 65536 });
    inf.on("data", (c) => { try { take(c); } catch (e) { inf.destroy(); reject(e); } });
    inf.on("error", (e) => reject(fail("The PNG image data does not inflate (" + (e.code || e.message) + ").")));
    inf.on("end", resolve);
    for (const part of p.idat) inf.write(part);
    inf.end();
  });
  if (y < p.height) throw fail("The PNG image data is too short.");
  return { width: p.width, height: p.height };
}

/// encodePng in steps: the rows are filtered and deflated a band at a time, and the image data
/// goes out as several IDAT chunks, so no full-size filtered copy of the image is made.
export async function encodePngStream(width, height, rgba, level = 6) {
  const stride = width * 4, band = Math.max(1, Math.floor(262144 / (stride + 1)));
  const def = zlib.createDeflate({ level, chunkSize: 262144 });
  const parts = [];
  def.on("data", (c) => parts.push(c));
  const done = new Promise((resolve, reject) => { def.on("end", resolve); def.on("error", reject); });
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y0 = 0; y0 < height; y0 += band) {
    const rows = Math.min(band, height - y0), buf = Buffer.allocUnsafe(rows * (stride + 1));
    for (let k = 0; k < rows; k++) filterRow(rgba, (y0 + k) * stride, y0 + k > 0, stride, cand, buf, k * (stride + 1));
    if (!def.write(buf)) await new Promise((r) => def.once("drain", r));
  }
  def.end();
  await done;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, ...chunk("IHDR", ihdr), ...parts.flatMap((c) => chunk("IDAT", c)), ...chunk("IEND", Buffer.alloc(0))]);
}

/// One row of `w` pixels of the inflated, unfiltered data at `row` into `out` as RGBA, pixel x
/// going to `base + (x0 + x * dx) * 4`.
function convertRow(p, row, w, out, base, x0, dx) {
  const { depth, color, channels, palette, trns, tGrey, tRgb, max } = p, rows = p.raw;
  {
    {
      for (let x = 0; x < w; x++) {
        const o = base + (x0 + x * dx) * 4;
        let R, G, B, A = 255;
        if (depth < 8) {
          const bit = x * depth, v = (rows[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
          if (color === 3) { const k = v * 3; R = palette[k]; G = palette[k + 1]; B = palette[k + 2]; A = trns && v < trns.length ? trns[v] : 255; }
          else { R = G = B = Math.round((v * 255) / max); if (v === tGrey) A = 0; }
        } else if (depth === 8) {
          const i = row + x * channels;
          if (color === 6) { R = rows[i]; G = rows[i + 1]; B = rows[i + 2]; A = rows[i + 3]; }
          else if (color === 2) { R = rows[i]; G = rows[i + 1]; B = rows[i + 2]; if (tRgb && R === tRgb[0] && G === tRgb[1] && B === tRgb[2]) A = 0; }
          else if (color === 0) { R = G = B = rows[i]; if (R === tGrey) A = 0; }
          else if (color === 4) { R = G = B = rows[i]; A = rows[i + 1]; }
          else { const k = rows[i] * 3; R = palette[k]; G = palette[k + 1]; B = palette[k + 2]; A = trns && rows[i] < trns.length ? trns[rows[i]] : 255; }
        } else {
          const i = row + x * channels * 2, s = (k) => (rows[i + k * 2] << 8) | rows[i + k * 2 + 1];
          if (color === 6) { R = rows[i]; G = rows[i + 2]; B = rows[i + 4]; A = rows[i + 6]; }
          else if (color === 2) { R = rows[i]; G = rows[i + 2]; B = rows[i + 4]; if (tRgb && s(0) === tRgb[0] && s(1) === tRgb[1] && s(2) === tRgb[2]) A = 0; }
          else if (color === 0) { R = G = B = rows[i]; if (s(0) === tGrey) A = 0; }
          else { R = G = B = rows[i]; A = rows[i + 2]; }
        }
        out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = A;
      }
    }
  }
}

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
/// A chunk as its three parts (length and type, data, CRC), so the data is never copied for it.
function chunk(type, data) {
  const head = Buffer.alloc(8), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
  let c = -1;
  for (let i = 4; i < 8; i++) c = CRC[(c ^ head[i]) & 255] ^ (c >>> 8);
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 255] ^ (c >>> 8);
  tail.writeUInt32BE((c ^ -1) >>> 0);
  return [head, data, tail];
}

/// Filters the RGBA row at `row` (none, sub, up or paeth, whichever sums smallest, the usual
/// heuristic) and writes the filter byte and the row into `out` at `o`.
function filterRow(rgba, row, hasUp, stride, cand, out, o) {
  const up = hasUp ? row - stride : -1;
  let best = 0, bestSum = Infinity;
  for (let f = 0; f < 4; f++) {
    const c = cand[f]; let sum = 0;
    for (let i = 0; i < stride; i++) {
      const v = rgba[row + i], a = i >= 4 ? rgba[row + i - 4] : 0, b = up >= 0 ? rgba[up + i] : 0;
      let r;
      if (f === 0) r = v;
      else if (f === 1) r = (v - a) & 255;
      else if (f === 2) r = (v - b) & 255;
      else { const cc = i >= 4 && up >= 0 ? rgba[up + i - 4] : 0, p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); r = (v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc)) & 255; }
      c[i] = r; sum += r < 128 ? r : 256 - r;
      if (sum >= bestSum) break;
    }
    if (sum < bestSum) { bestSum = sum; best = f; }
  }
  // the loop above may have stopped early for the winner's rivals, never for the winner
  out[o] = best === 3 ? 4 : best;
  out.set(cand[best], o + 1);
}

/// An RGBA image (8 bits per channel) as a PNG. Each row gets the filter (none, sub, up or
/// paeth) whose bytes sum smallest, the usual heuristic.
export function encodePng(width, height, rgba, level = 6) {
  // every byte is written below
  const stride = width * 4;
  let raw = Buffer.allocUnsafe(height * (stride + 1));
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < height; y++) filterRow(rgba, y * stride, y > 0, stride, cand, raw, y * (stride + 1));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const packed = zlib.deflateSync(raw, { level });
  raw = null;
  return Buffer.concat([SIGNATURE, ...chunk("IHDR", ihdr), ...chunk("IDAT", packed), ...chunk("IEND", Buffer.alloc(0))]);
}

/// Draws the layers in order, each over what is below it (straight alpha, source over), and
/// returns the PNG. Every layer must be `width` by `height`. A layer is the PNG's bytes, or
/// { file } to read it from disk only when its turn comes (one layer file in memory at a time).
export function compositeLayers(pngs, width, height, limits = {}) {
  const canvas = new Uint8Array(width * height * 4), w4 = width * 4;
  let first = true;
  for (const layer of pngs) {
    const png = layer && typeof layer.file === "string" ? fs.readFileSync(layer.file) : layer;
    const copy = first;
    // row by row, straight from the inflated layer: no full-size copy of a layer is made
    eachPngRow(png, { ...limits, width, height }, (y, s) => blendRow(canvas, y * w4, s, w4, copy));
    first = false;
  }
  return encodePng(width, height, canvas);
}

/// compositeLayers in steps (streamPngRows, encodePngStream): the memory it takes is the canvas,
/// one layer file, a few rows and the finished PNG, and the server keeps answering while it
/// draws. The same pixels as compositeLayers; the file holds them in several IDAT chunks.
export async function compositeLayersAsync(pngs, width, height, limits = {}) {
  const canvas = new Uint8Array(width * height * 4), w4 = width * 4;
  let first = true;
  for (const layer of pngs) {
    const png = layer && typeof layer.file === "string" ? await fs.promises.readFile(layer.file) : layer;
    const copy = first;
    await streamPngRows(png, { ...limits, width, height }, (y, s) => blendRow(canvas, y * w4, s, w4, copy));
    first = false;
  }
  return encodePngStream(width, height, canvas);
}
/// One row of a layer over the canvas (source over, straight alpha); the first layer is copied.
function blendRow(canvas, base, s, w4, copy) {
  if (copy) { canvas.set(s, base); return; }
  for (let j = 0; j < w4; j += 4) {
    const sa = s[j + 3];
    if (sa === 0) continue;
    const i = base + j;
    if (sa === 255) { canvas[i] = s[j]; canvas[i + 1] = s[j + 1]; canvas[i + 2] = s[j + 2]; canvas[i + 3] = 255; continue; }
    const da = canvas[i + 3], keep = (da * (255 - sa) + 127) / 255, oa = sa + keep;
    canvas[i] = Math.round((s[j] * sa + canvas[i] * keep) / oa);
    canvas[i + 1] = Math.round((s[j + 1] * sa + canvas[i + 1] * keep) / oa);
    canvas[i + 2] = Math.round((s[j + 2] * sa + canvas[i + 2] * keep) / oa);
    canvas[i + 3] = Math.round(oa);
  }
}

// ---- the worker thread ------------------------------------------------------------------------------

if (!isMainThread && parentPort && workerData && workerData.programmableArtCompositor) {
  parentPort.on("message", async (m) => {
    try {
      const png = await compositeLayersAsync(m.layers, m.width, m.height, m.limits);
      // handed over, not copied, when the buffer is the PNG's alone
      const own = png.byteOffset === 0 && png.byteLength === png.buffer.byteLength;
      parentPort.postMessage({ id: m.id, png }, own ? [png.buffer] : []);
    } catch (e) { parentPort.postMessage({ id: m.id, error: e.message, code: e.code || "" }); }
  });
}

/// A compositor: run(layers, width, height, limits) -> Promise<Buffer>, layers as for
/// compositeLayers (give { file } paths so the layers never pass through the server's memory).
/// One composite at a time (the server has one processor), at most `queue` waiting; past that it
/// refuses with code "BUSY". It draws in steps (compositeLayersAsync), so the server keeps
/// answering meanwhile. With `worker` (the default) the steps run in a worker thread with a
/// small heap: the worker costs about 13 MB while it lives, but its collector frees each layer's
/// buffers at once, so the peak is lower than in the server's own thread. It stops after `idleMs`
/// without work.
export function startCompositor({ worker = true, queue = 16, idleMs = 60000 } = {}) {
  let w = null, idle = null, seq = 0, running = null;
  const waiting = [];
  const stopWorker = () => { if (w) { const x = w; w = null; x.terminate().catch(() => {}); } };
  const ensure = () => {
    if (w) return w;
    // a small heap: the pixels live in buffers outside it, and a tight heap makes the
    // collector free each layer's buffers soon after the layer is drawn
    w = new Worker(new URL(import.meta.url), { workerData: { programmableArtCompositor: true }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 2 } });
    w.unref();
    w.on("message", (m) => {
      if (!running || m.id !== running.id) return;
      const r = running; running = null;
      if (m.error) { const e = new Error(m.error); e.code = m.code; r.reject(e); } else r.resolve(Buffer.from(m.png.buffer, m.png.byteOffset, m.png.byteLength));
      pump();
    });
    w.on("error", (e) => { const r = running; running = null; w = null; if (r) r.reject(e); pump(); });
    w.on("exit", () => { if (running) { const r = running; running = null; r.reject(new Error("The drawing worker stopped.")); } w = null; pump(); });
    return w;
  };
  const pump = () => {
    if (running || !waiting.length) {
      if (!running && !waiting.length && w && !idle) { idle = setTimeout(() => { idle = null; if (!running && !waiting.length) stopWorker(); }, idleMs); idle.unref(); }
      return;
    }
    if (idle) { clearTimeout(idle); idle = null; }
    running = waiting.shift();
    if (!worker) {
      const r = running;
      compositeLayersAsync(r.layers, r.width, r.height, r.limits).then(r.resolve, r.reject).finally(() => { if (running === r) running = null; pump(); });
      return;
    }
    ensure().postMessage({ id: running.id, layers: running.layers, width: running.width, height: running.height, limits: running.limits });
  };
  return {
    run(layers, width, height, limits = {}) {
      if (waiting.length >= queue) { const e = new Error("The server is drawing many pieces right now. Try again in a minute."); e.code = "BUSY"; return Promise.reject(e); }
      return new Promise((resolve, reject) => { waiting.push({ id: ++seq, layers, width, height, limits, resolve, reject }); pump(); });
    },
    pending: () => waiting.length + (running ? 1 : 0),
    stop: () => { waiting.splice(0).forEach((r) => r.reject(new Error("stopped"))); stopWorker(); },
  };
}
