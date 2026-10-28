// Builds three bundles:
//   dist/index.js          ESM for Node (watcher, scripts), web3.js left external
//   ../web/js/hookpool.js  ESM for the browser, everything bundled, `window.Buffer` provided
//   ../web/api/_sdk.js     ESM for Node with web3.js bundled in, for the trade API handlers in
//                          web/api (the site root on Vercel is web/, so they cannot import
//                          sdk/dist or the repo's node_modules). The leading underscore keeps
//                          Vercel from exposing it as a route.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
mkdirSync("../web/js", { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["@solana/web3.js"],
  sourcemap: false,
});

await build({
  entryPoints: ["src/browser.ts"],
  outfile: "../web/js/hookpool.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  inject: ["./buffer-shim.js"],
});

// Same entry as the browser bundle (the SDK plus the pieces of web3.js a caller needs), built
// for Node. web3.js and its dependencies are CommonJS inside, so the bundle gets a `require`.
// web3.js only falls back to node-fetch when there is no global fetch. Node 18 and later
// have one, so the package is left out: it would add 100 KB and a deprecation warning
// (punycode) on every start.
const nativeFetch = {
  name: "native-fetch",
  setup(b) {
    b.onResolve({ filter: /^node-fetch$/ }, () => ({ path: "node-fetch", namespace: "native-fetch" }));
    b.onLoad({ filter: /.*/, namespace: "native-fetch" }, () => ({ contents: "module.exports = globalThis.fetch;", loader: "js" }));
  },
};
await build({
  entryPoints: ["src/browser.ts"],
  outfile: "../web/api/_sdk.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external: ["bufferutil", "utf-8-validate"],
  plugins: [nativeFetch],
  banner: { js: 'import { createRequire as programmableCreateRequire } from "node:module"; const require = programmableCreateRequire(import.meta.url);' },
});

// The art module alone (collection.json checks, the draw, the addresses), for the resolver in
// web/api/_art.js: a few kilobytes, so serving a piece never loads web3.js.
await build({
  entryPoints: ["src/artpack.ts"],
  outfile: "../web/api/_artpack.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "node20",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: { js: "// Built from sdk/src/artpack.ts by sdk/esbuild.mjs (npm run build -w sdk). Do not edit." },
});

// The browser's upload of a collection (web/js/art-store.js), loaded by the launch page only when a
// launcher brings their own art. The stores of the real services are their own files next to it.
await build({
  entryPoints: ["src/artstore.ts"],
  outfile: "../web/js/art-store.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
});

console.log("sdk built: dist/index.js, ../web/js/hookpool.js, ../web/api/_sdk.js, ../web/api/_artpack.js and ../web/js/art-store.js");
