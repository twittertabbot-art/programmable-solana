// Builds the browser stores of the real storage services:
//   ../../web/js/art-store-turbo.js   Arweave through ArDrive Turbo   (src/turbo.ts)
//   ../../web/js/art-store-irys.js    Irys                            (src/irys.ts)
// Their packages pull in Node modules (crypto, stream, events, buffer); the browser gets the
// usual stand-ins for them, and the ones no upload uses (fs, os, net...) are empty.
//   cd sdk/art-vendor && npm ci --ignore-scripts && npm run build
// The versions are pinned in package.json and package-lock.json. web/js/art-store.js (built by
// sdk/esbuild.mjs) loads one of these files only when the site's store is "turbo" or "irys".
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const require = createRequire(import.meta.url);
const resolve = (m) => require.resolve(m);
const alias = {
  crypto: resolve("crypto-browserify"), "node:crypto": resolve("crypto-browserify"),
  stream: resolve("stream-browserify"), "node:stream": resolve("stream-browserify"),
  events: resolve("events/"), "node:events": resolve("events/"),
  buffer: resolve("buffer/"), "node:buffer": resolve("buffer/"),
  process: resolve("process/browser.js"), "node:process": resolve("process/browser.js"),
  path: resolve("path-browserify"), "node:path": resolve("path-browserify"),
  util: resolve("util/"), "node:util": resolve("util/"),
  assert: resolve("assert/"), "node:assert": resolve("assert/"),
  vm: resolve("vm-browserify"),
};
const EMPTY = ["fs", "fs/promises", "os", "child_process", "net", "tls", "http", "https", "zlib", "readline", "worker_threads", "perf_hooks", "http2", "dns", "module"];
const empty = {
  name: "empty-node-modules",
  setup(b) {
    const re = new RegExp("^(node:)?(" + EMPTY.map((m) => m.replace("/", "\\/")).join("|") + ")$");
    b.onResolve({ filter: re }, (a) => ({ path: a.path, namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default {};", loader: "js" }));
  },
};
// absolute paths (an alias also rewrites "process/..." and "buffer/..."), so the shim is made
// in the system's temporary folder for this build and removed after it, never left in the repository
const abs = (m) => JSON.stringify(resolve(m).replace(/\\/g, "/"));
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "art-vendor-"));
const shim = path.join(shimDir, "shim.js");
fs.writeFileSync(shim, "import { Buffer } from " + abs("buffer/") + ";\nimport process from " + abs("process/browser.js") + ";\nexport { Buffer, process };\n");
process.on("exit", () => fs.rmSync(shimDir, { recursive: true, force: true }));

const common = {
  bundle: true, format: "esm", platform: "browser", target: ["es2022"], minify: true, sourcemap: false, legalComments: "none",
  mainFields: ["browser", "module", "main"], conditions: ["browser", "import", "default"],
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  inject: [shim], alias, plugins: [empty],
  external: ["x402-fetch", "commander", "cli-progress", "prompts"],
  logLevel: "warning",
};
for (const [name, entry] of [["turbo", "./src/turbo.ts"], ["irys", "./src/irys.ts"]]) {
  const outfile = here("../../web/js/art-store-" + name + ".js");
  await build({ ...common, entryPoints: [here(entry)], outfile, banner: { js: "// Built from sdk/art-vendor/src/" + name + ".ts by sdk/art-vendor/build.mjs. Do not edit." } });
  console.log("built web/js/art-store-" + name + ".js: " + (fs.statSync(outfile).size / 1048576).toFixed(2) + " MB");
}
