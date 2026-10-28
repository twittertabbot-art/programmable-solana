// Review tool: the server-side renderer (web/api/_art.js) must be byte-identical to the SDK's
// renderPieceSvg, and the running local server must serve the same bytes.
//   node web/review/art-check.mjs            (from the repo root, server on 8787 optional)
import { renderPieceSvg as sdkSvg, pieceMetadata as sdkMeta, pieceTraits as sdkTraits } from "../../sdk/dist/index.js";
import { renderPieceSvg, pieceMetadata, pieceTraits } from "../api/_art.js";
import { randomBytes } from "node:crypto";

let bad = 0;
const N = 500;
for (let i = 0; i < N; i++) {
  const art = randomBytes(16).toString("hex"), seed = randomBytes(16).toString("hex");
  if (renderPieceSvg(art, seed) !== sdkSvg(art, seed)) bad++;
  if (renderPieceSvg(art, seed, 96) !== sdkSvg(art, seed, 96)) bad++;
  if (JSON.stringify(pieceTraits(art, seed)) !== JSON.stringify(sdkTraits(art, seed))) bad++;
  if (JSON.stringify(pieceMetadata(art, seed, "x", "y")) !== JSON.stringify(sdkMeta(art, seed, "x", "y"))) bad++;
}
console.log("copy vs sdk: " + N + " random pieces, mismatches " + bad);

try {
  const art = randomBytes(16).toString("hex"), seed = randomBytes(16).toString("hex");
  const base = "http://localhost:8787/art/p/" + art + "/" + seed;
  const svg = await fetch(base + ".svg");
  const body = await svg.text();
  console.log("server svg: status " + svg.status + ", type " + svg.headers.get("content-type") + ", cache " + svg.headers.get("cache-control") + ", identical to H.renderPieceSvg " + (body === sdkSvg(art, seed)));
  const json = await (await fetch(base)).json();
  console.log("server json: image " + json.image + ", rarity " + json.attributes[0].value);
  const badReq = await fetch("http://localhost:8787/art/p/zz/" + seed + ".svg");
  console.log("bad art hex: status " + badReq.status);
} catch (e) { console.log("server not reachable: " + e.message); }
process.exitCode = bad ? 1 : 0;
