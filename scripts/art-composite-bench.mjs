// Measures the resolver's layer compositor (web/api/_artpng.js): time and memory to draw a piece of
// N layers of W x H pixels, the way GET /art/u/<id>/p/<art>/<seed>.png does it (the layers are
// files of the disk cache, read one at a time). Run it on the server that will serve the site to
// see what that machine can take:
//   node scripts/art-composite-bench.mjs              10 layers of 1000 x 1000, 5 rounds
//   node scripts/art-composite-bench.mjs 16 2048 2    16 layers of 2048 x 2048 (the most allowed)
// It makes its own test layers (a grainy background, then shapes with soft edges on a transparent
// field) in a temporary folder, removed at the end, and measures each way in a fresh process:
// "stream" is what the server does by default (in its own thread, in short steps), "worker" the
// same in a worker thread (ART_COMPOSITE_WORKER=1), "sync" the one-piece code (compositeLayers),
// for comparison. "longest pause" is the longest time the server could not answer anything else.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodePng, compositeLayers, compositeLayersAsync, startCompositor, decodePng } from "../web/api/_artpng.js";

const mb = (n) => (n / 1048576).toFixed(1) + " MB";
const LIMITS = { maxSide: 4096, maxPixels: 16777216 };

if (process.argv[2] === "--measure") {
  // a child: one way, from a clean process
  const [, , , dir, side, rounds, mode] = process.argv;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => ({ file: path.join(dir, f) }));
  globalThis.gc && globalThis.gc();
  const before = process.memoryUsage().rss;
  let peak = before, last = performance.now(), pause = 0;
  // a tick every 2 ms: the longest gap between two ticks is the longest the server was held up
  const watch = setInterval(() => { const now = performance.now(); pause = Math.max(pause, now - last); last = now; peak = Math.max(peak, process.memoryUsage().rss); }, 2);
  const times = [];
  let out = null, idle = 0;
  const S = Number(side);
  if (mode === "sync") {
    for (let i = 0; i < Number(rounds); i++) { await new Promise((r) => setTimeout(r, 20)); const t = performance.now(); out = compositeLayers(files, S, S, LIMITS); times.push(performance.now() - t); peak = Math.max(peak, process.memoryUsage().rss); }
  } else {
    const c = startCompositor({ worker: mode === "worker", idleMs: 60000 });
    if (mode === "worker") {
      // what a started worker costs before it draws anything: one 1 x 1 layer
      await c.run([encodePng(1, 1, new Uint8Array(4))], 1, 1);
      idle = process.memoryUsage().rss - before;
    }
    for (let i = 0; i < Number(rounds); i++) { const t = performance.now(); out = await c.run(files, S, S, LIMITS); times.push(performance.now() - t); }
    c.stop();
  }
  clearInterval(watch);
  const img = decodePng(out);
  console.log(JSON.stringify({ mode, times: times.map((t) => Math.round(t)), before, peak, idle, pause: Math.round(pause), out: out.length, w: img.width }));
  process.exit(0);
}

const layers = Number(process.argv[2] || 10), side = Number(process.argv[3] || 1000), rounds = Number(process.argv[4] || 5);
// drawn art is not flat: a little grain on every colour makes the files about as large as real layers
function makeLayer(k, w, h) {
  const d = new Uint8Array(w * h * 4);
  let st = 0x9e3779b9 ^ k;
  const grain = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return (st & 31) - 16; };
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const cx = w * (0.2 + 0.6 * ((k * 37) % 100) / 100), cy = h * (0.2 + 0.6 * ((k * 61) % 100) / 100), r = Math.min(w, h) * (0.15 + 0.02 * (k % 5));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (k === 0) { d[o] = clamp((x * 255) / w + grain()); d[o + 1] = clamp((y * 255) / h + grain()); d[o + 2] = clamp(120 + grain()); d[o + 3] = 255; continue; }
    const dist = Math.hypot(x - cx, y - cy);
    const a = dist < r ? 255 : dist < r + 6 ? Math.round(255 * (1 - (dist - r) / 6)) : 0;
    if (a) { d[o] = clamp(((k * 53) & 255) + grain()); d[o + 1] = clamp(((k * 97) & 255) + grain()); d[o + 2] = clamp(((k * 151) & 255) + grain()); d[o + 3] = a; }
  }
  return encodePng(w, h, d);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-bench-"));
try {
  let bytes = 0;
  for (let k = 0; k < layers; k++) { const b = makeLayer(k, side, side); bytes += b.length; fs.writeFileSync(path.join(dir, k + ".png"), b); }
  console.log(layers + " layers of " + side + " x " + side + ", " + mb(bytes) + " of PNG files");
  const label = { stream: "in steps (the default):", worker: "in a worker thread:    ", sync: "in one piece:          " };
  for (const mode of ["stream", "worker", "sync"]) {
    const r = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--measure", dir, String(side), String(rounds), mode], { encoding: "utf8" });
    const line = (r.stdout || "").trim().split(/\r?\n/).pop();
    let m; try { m = JSON.parse(line); } catch (_) { console.log(mode + ": failed " + (r.stderr || r.stdout).slice(0, 400)); continue; }
    console.log(label[mode] + " " + m.times.join(", ") + " ms per piece; memory +" + mb(m.peak - m.before) + " at the peak" + (mode === "worker" ? " (" + mb(m.idle) + " of it the started worker)" : "") + "; longest pause " + m.pause + " ms; the piece is a " + mb(m.out) + " PNG");
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
