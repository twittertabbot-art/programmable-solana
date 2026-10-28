// Review tool: a launcher's own art for a collectible coin, end to end, in headless Edge with real
// mouse and keyboard input, signed by throwaway wallets made here (localnet only, airdropped,
// never written to disk), with the local stand-ins for the storage service and its gateway.
//   node web/review/flow-art.mjs <site origin> <out prefix> [parts]
//   node web/review/flow-art.mjs http://localhost:8797 web/review/h-art
// The site at <origin> must run the art routes and the storage stand-in (web/serve.js with the
// settings of the stand-in; HOOKS.md, "Collectible art", says which).
// F. reading files: a CSV with a file column, and images alone. No chain.
// A. a launch with 20 pictures in the Metaplex layout (0.png and 0.json ...): the table, a
//    weight changed, the price, Pay and upload, the launch. Then a second wallet buys on the
//    coin page, with the deposit for the NFTs in the buy, and a watcher with the mint crank (started
//    here, stopped at the end) mints them: each Core asset's URI is <uri_base>/p/<art>/<seed>, its
//    JSON is valid Metaplex JSON with the attributes as uploaded, its image loads and is the
//    uploaded file, and the coin page shows the traits with their chances.
// Y. a launch with 4 layers (one can be empty): the same, and the image is the composite PNG.
// E. the owner's editor on the coin page of A: upload the layers as a new version and save. The
//    collection on chain then names the new folder and its art bytes.
// H. the operator hides the folder of A (scripts/art-hide.mjs, run with UPLOADS_DIR or
//    ART_HIDDEN_FILE as the site has them; skipped without either): its pieces answer the
//    placeholder, the coin page says so, and the folder shows again once it is removed.
// S. screenshots at 1440 and 390 of the new sections.
// "parts": all (the default), or some of F,A,Y,E,H,S. E and H need A.
// One line per check, "  ok    ..." or "  FAIL  ...". The browser is started and closed by edge.mjs.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as SDK from "../../sdk/dist/index.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startEdge } from "./edge.mjs";
import { makeFixtures } from "./art-fixtures.mjs";
import { startMintKeeper } from "./mint-keeper.mjs";

const { HookpoolClient, DIRECTION, PROGRAMS, collectible: col } = SDK;
const pickPiece = SDK.pickPiece || (SDK.art && SDK.art.pickPiece);
const [origin, prefix, partsArg = "all"] = process.argv.slice(2);
if (!origin || !prefix) { console.error("usage: node web/review/flow-art.mjs <site origin> <out prefix> [parts]"); process.exit(1); }
const PARTS = ["F", "A", "Y", "E", "H", "S"];
const wanted = partsArg === "all" ? PARTS : partsArg.split(",").map((s) => s.trim().toUpperCase());
for (const w of wanted) if (!PARTS.includes(w)) { console.error("unknown part " + w + ". Parts: " + PARTS.join(", ")); process.exit(1); }
const want = (part) => wanted.includes(part);
const RPC = "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const W = 1440, HGT = 1300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);
const say = (label, value) => console.log("        " + (label + ":").padEnd(30) + " " + (typeof value === "string" ? value : JSON.stringify(value, (k, v) => (typeof v === "bigint" ? String(v) : v))));
let total = 0, failed = 0;
const failures = [];
const check = (ok, text) => { total++; if (!ok) { failed++; failures.push(text); } console.log((ok ? "  ok    " : "  FAIL  ") + text); return !!ok; };
const fund = async (kp, sol) => conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
const sha = (b) => createHash("sha256").update(b).digest();
const run = String(Math.floor(Math.random() * 900) + 100);
const FX_DIR = path.join(os.tmpdir(), "programmable-art-" + process.pid);
const fx = makeFixtures(FX_DIR, { pictures: 20, size: 256 });

// ---- the browser ------------------------------------------------------------------------------------
const edge = await startEdge({ name: "art", width: W, height: HGT });
let id = 0; const pending = new Map(); const events = []; const pageErrors = [];
let ws = null, where = "about:blank", walletScriptId = null;
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
const shots = [];
const shot = async (name, full) => {
  let params = { format: "png" };
  if (full) {
    const m = await call("Page.getLayoutMetrics");
    params = { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 9000), scale: 1 } };
  }
  const s = await call("Page.captureScreenshot", params);
  writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64")); shots.push(prefix + name + ".png");
  console.log("        wrote " + prefix + name + ".png");
};
/// A picture of one element of the page, whole, wherever it sits.
const shotOf = async (selector, name) => {
  const r = JSON.parse(await ev("(() => { const e = document.querySelector(" + q(selector) + "); if (!e) return 'null'; const b = e.getBoundingClientRect(); return JSON.stringify({ x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }); })()"));
  if (!r) { console.log("        note: nothing to capture for " + selector); return; }
  const s = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: r.x, y: r.y, width: r.w, height: Math.min(r.h, 8000), scale: 1 } });
  writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64")); shots.push(prefix + name + ".png");
  console.log("        wrote " + prefix + name + ".png");
};
const until = async (expression, ms = 30000, step = 150) => { for (let t = 0; t < ms; t += step) { try { if (await ev(expression)) return true; } catch (_) {} await sleep(step); } return false; };
const mouse = (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const clearToasts = async () => { await ev("(() => { for (const t of document.querySelectorAll('#toasts .toast')) t.click(); return true; })()"); await sleep(300); };
async function click(selector) {
  const at = () => ev("(() => { const e = document.querySelector(" + q(selector) + "); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width, b.height]; })()");
  if (!(await at())) throw new Error("nothing matches " + selector);
  for (let attempt = 0; ; attempt++) {
    await ev("document.querySelector(" + q(selector) + ").scrollIntoView({ block: 'center' }); true");
    await sleep(120);
    const [x, y] = await at();
    const top = await ev("(() => { const e = document.elementFromPoint(" + x + ", " + y + "); const want = document.querySelector(" + q(selector) + "); return !!e && (e === want || want.contains(e)); })()");
    if (top) { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); return; }
    if (attempt > 0) throw new Error("something covers " + selector);
    await clearToasts();
  }
}
async function type(selector, text) {
  await click(selector);
  await ev("(() => { const e = document.querySelector(" + q(selector) + "); e.select(); return true; })()");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  if (text) await call("Input.insertText", { text });
  await sleep(250);
}
/// Hand files or a folder to a file input, as the file dialog would.
async function setFiles(selector, files) {
  const doc = await call("DOM.getDocument", { depth: -1, pierce: true });
  const node = await call("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (!node.nodeId) throw new Error("no file input " + selector);
  await call("DOM.setFileInputFiles", { nodeId: node.nodeId, files });
}
const text = (selector) => ev("(() => { const e = document.querySelector(" + q(selector) + "); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()");
const standin = (kp) => JSON.stringify({ secret: Array.from(kp.secretKey), address: kp.publicKey.toBase58() });
/// The stand-in wallet (as in flow-launch.mjs): signs with the throwaway key, and notes every
/// transaction Phantom would block (already signed by another key, or failing before it is signed).
const walletScript = (kp) => `
  (() => {
    let who = ${standin(kp)};
    try { const s = localStorage.getItem("__standin"); if (s) who = JSON.parse(s); } catch (_) {}
    localStorage.setItem("Programmable.wallet", "phantom");
    const SECRET = who.secret, ADDRESS = who.address;
    window.__who = ADDRESS; window.__signPrompts = 0;
    const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(SECRET)); };
    const flag = (why) => { try { const a = JSON.parse(localStorage.getItem("__phantomFlags") || "[]"); a.push(why); localStorage.setItem("__phantomFlags", JSON.stringify(a)); } catch (_) {} };
    const phantomCheck = async (tx) => {
      if (tx.signatures.some((s) => s.some((b) => b !== 0))) flag(location.pathname + ": handed to the wallet already signed by another key");
      try {
        const H = await import("/js/hookpool.js");
        const r = await new H.Connection("http://127.0.0.1:8899", "confirmed").simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
        if (r.value.err) flag(location.pathname + ": fails simulation before signing: " + JSON.stringify(r.value.err) + " | " + (r.value.logs || []).slice(-2).join(" | "));
      } catch (e) { flag(location.pathname + ": could not be simulated: " + e.message); }
    };
    const publicKey = { toBase58: () => ADDRESS };
    const w = { isPhantom: true, publicKey, on() {}, disconnect: async () => {},
      connect: async () => ({ publicKey }),
      signTransaction: async (tx) => { window.__signPrompts++; await phantomCheck(tx); tx.sign([await key()]); return tx; },
      signAllTransactions: async (txs) => { window.__signPrompts++; const k = await key(); for (const t of txs) { await phantomCheck(t); t.sign([k]); } return txs; },
      // a message (the storage asks for one per upload): ed25519 with the same key, through WebCrypto
      signMessage: async (bytes) => { window.__signPrompts++; window.__messages = (window.__messages || 0) + 1; const pk8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...SECRET.slice(0, 32)]); const k = await crypto.subtle.importKey("pkcs8", pk8, { name: "Ed25519" }, false, ["sign"]); return { signature: new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k, bytes)), publicKey }; } };
    window.phantom = { solana: w };
  })();`;
const waitLoad = async () => { for (let i = 0; i < 200 && !events.includes("Page.loadEventFired"); i++) await sleep(100); };
async function open(kp, p, ready) {
  if (!walletScriptId) walletScriptId = (await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript(kp) })).identifier;
  if (where === "about:blank") { events.length = 0; await call("Page.navigate", { url: origin + "/package.json" }); await waitLoad(); where = "/package.json"; }
  await ev("localStorage.setItem(\"__standin\", " + JSON.stringify(standin(kp)) + "); true");
  for (let attempt = 0; attempt < 2; attempt++) {
    events.length = 0; where = p;
    await call("Page.navigate", { url: origin + p });
    await waitLoad();
    if (await until(ready, 14000)) { await sleep(500); return; }
    if (!(await ev("!!document.querySelector('#walletBtn.on')"))) {
      await ev("(async () => { try { const W = await import('/wallet.js'); const H = await import('/js/hookpool.js'); if (W.available().length) await W.connect(W.available()[0], H.PublicKey); } catch (_) {} return true; })()");
      if (await until(ready, 8000)) { await sleep(500); return; }
    }
    console.log("        note: the page was not ready, loading it once more: " + p);
  }
  throw new Error("the page did not get ready: " + p);
}
async function view(width, height) {
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setTouchEmulationEnabled", { enabled: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(400);
}
const overflow = () => ev("document.documentElement.scrollWidth <= window.innerWidth");
{
  ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    const page = String(where || "").split("?")[0];
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === "Runtime.exceptionThrown") pageErrors.push(page + "  EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") pageErrors.push(page + "  console.error " + d.params.args.map((a) => a.value || a.description).join(" "));
    else if (d.method) events.push(d.method);
  };
  await call("Page.enable"); await call("Runtime.enable"); await call("DOM.enable");
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await view(W, HGT);
}

// ---- wallets ---------------------------------------------------------------------------------------
const dev = Keypair.generate(), trader = Keypair.generate();
await Promise.all([fund(dev, 30), fund(trader, 5)]);
const launchReady = "!!document.querySelector('#walletBtn.on') && !!document.querySelector('#launchBtn') && !!document.querySelector('#costs dd') && !!document.querySelector('#artStudio') && document.querySelector('#launchBtn').textContent === 'Launch'";
const STUDIO = "#artStudio";
const rows = (mode) => STUDIO + " [data-body=" + mode + "] .art-row:not(.head)";
async function seedMode() {
  if (await ev("!!document.querySelector('input[name=start][value=seed]') && !document.querySelector('input[name=start][value=seed]').checked")) await click("label.choice:has(input[name=start][value=seed]) .title");
}
async function fillCoin(name, symbol, firstBuy) {
  await type("#name", name);
  await type("#symbol", symbol);
  await seedMode();
  await type("#seed", "1");
  await type("#devBuy", firstBuy);
  if (!(await ev("document.querySelector('details.more').open"))) await click("details.more > summary");
  await type("#metaUrl", origin + "/package.json?coin=" + symbol.toLowerCase());
}
/// Pick a way in the art section.
async function artMode(root, mode) { await click(root + " label.choice[data-mode=" + mode + "] .title"); await sleep(300); }
/// Pay and upload in the art section `root`. Returns { id, uriBase, prompts }. `failPath`: the
/// stand-in refuses that file once, so the page must stop, say so, and upload the rest on the
/// next press without paying again.
async function payAndUpload(root, what, failPath) {
  const priced = await until("(() => { const d = [...document.querySelectorAll(" + q(root + " .art-store dd") + ")].map((x) => x.textContent); return d.length === 3 && / SOL$/.test(d[2]); })()", 20000);
  const kv = await ev("[...document.querySelectorAll(" + q(root + " .art-store dd") + ")].map((x) => x.textContent)");
  say(what + ": the store box", kv);
  check(priced, what + ": before paying, the page shows the files, the size and the price in SOL (" + kv.join(", ") + ")");
  const notes = await ev("[...document.querySelectorAll(" + q(root + " .art-store > .help") + ")].map((x) => x.textContent).join(' ')");
  check(/stored on [A-Za-z ]+ for good/.test(notes) && /connected wallet pays/.test(notes) && /Rarity is a chance/.test(notes), what + ": it says where the files are stored for good, that the connected wallet pays, and that rarity is a chance (" + (/stored on ([A-Za-z ]+) for good/.exec(notes) || [])[1] + ")");
  const prompts0 = await ev("window.__signPrompts");
  const bal0 = BigInt(await conn.getBalance(new PublicKey(await ev("window.__who"))));
  await clearToasts();
  const node = failPath ? String((await (await fetch(origin + "/art/settings")).json()).node || "") : "";
  if (failPath) await fetch(node + "/_control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ failPaths: [failPath] }) });
  await click(root + " .art-store > .btn-primary");
  if (failPath) {
    const stopped = await until("!!document.querySelector(" + q(root + " .art-store .error-text") + ").textContent", 90000, 250);
    const said = await text(root + " .art-store .error-text");
    const btn = await text(root + " .art-store > .btn-primary");
    check(stopped && /files? of \d+ stored/.test(said || "") && btn === "Upload the rest", what + ": a file that fails stops the upload with a sentence, and the button offers the rest (" + said + " | " + btn + ")");
    await fetch(node + "/_control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ failPaths: [] }) });
    const p1 = await ev("window.__signPrompts"), b1 = BigInt(await conn.getBalance(new PublicKey(await ev("window.__who"))));
    await click(root + " .art-store > .btn-primary");
    await until("!!document.querySelector(" + q(root + " .art-stored .ok") + ") || !!document.querySelector(" + q(root + " .art-store .error-text") + ").textContent", 90000, 250);
    const p2 = (await ev("window.__signPrompts")) - p1, b2 = b1 - BigInt(await conn.getBalance(new PublicKey(await ev("window.__who"))));
    check(p2 === 0 && b2 === 0n, what + ": Upload the rest stores what is left without a new payment (" + p2 + " prompts, " + (Number(b2) / 1e9).toFixed(6) + " SOL)");
  }
  const done = await until("!!document.querySelector(" + q(root + " .art-stored .ok") + ") || !!document.querySelector(" + q(root + " .art-store .error-text") + ").textContent", 90000, 250);
  const err = await text(root + " .art-store .error-text");
  if (!check(done && !err, what + ": Pay and upload went through" + (err ? " (the page says: " + err + ")" : ""))) return null;
  const line = await text(root + " .art-stored .help");
  const m = /(https?:\/\/\S+\/art\/u\/([A-Za-z0-9_-]{43}))\./.exec(line || "");
  check(!!m, what + ": the page names the folder and the address the pieces will have (" + line + ")");
  const prompts = (await ev("window.__signPrompts")) - prompts0;
  const spent = bal0 - BigInt(await conn.getBalance(new PublicKey(await ev("window.__who"))));
  say(what + ": the upload", prompts + " wallet prompt(s), the wallet spent " + (Number(spent) / 1e9).toFixed(6) + " SOL");
  check(prompts >= 1, what + ": the wallet was asked to pay (" + prompts + " prompt)");
  return m ? { id: m[2], uriBase: m[1], prompts } : null;
}
/// Press Launch and wait. Returns the pool or null.
async function launch(what) {
  const problems = await text("#revProblems");
  check(problems === "", what + ": the review names no problem once the art is stored" + (problems ? " (" + problems + ")" : ""));
  const prompts0 = await ev("window.__signPrompts");
  await clearToasts();
  await click("#launchBtn");
  const done = await until("!!document.querySelector('#result a.btn') || !!document.querySelector('#result .bad')", 120000, 250);
  const bad = await text("#result .bad");
  if (!check(done && !bad, what + ": the launch went through" + (bad ? " (the page says: " + bad + ")" : ""))) return null;
  check((await ev("window.__signPrompts")) - prompts0 === 2, what + ": two wallet prompts for the launch");
  const href = await ev("document.querySelector('#result a.btn').getAttribute('href')");
  return new PublicKey(/pool=([1-9A-HJ-NP-Za-km-z]+)/.exec(href)[1]);
}
/// Buy on the coin page as `kp` until the earned pieces are minted. Returns how many.
async function buyPieces(kp, pool, what) {
  await open(kp, "/coin.html?pool=" + pool.toBase58(), "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on')");
  await ev("(() => { const i = document.getElementById('amount'); i.value = '0.5'; i.dispatchEvent(new Event('input')); return true; })()");
  await sleep(900);
  const earn = await ev("document.querySelector('.earn-line') ? document.querySelector('.earn-line').innerText.replace(/\\n/g, ' | ') : ''");
  const said = /^This buy earns (\d+) pieces?/.exec(earn || "");
  check(!!said, what + ": the trade form says what the buy earns (" + earn + ")");
  await click("#tradeCard .btn-buy");
  let drawn = 0;
  for (let i = 0; i < 200; i++) {
    const o = JSON.parse(await ev("JSON.stringify({ blank: document.querySelectorAll('#colMine .piece.blank').length, drawn: document.querySelectorAll('#colMine .piece.own').length })"));
    if (o.blank === 0 && o.drawn > 0) { drawn = o.drawn; break; }
    await sleep(250);
  }
  const ticket = await col.fetchTicket(conn, pool, kp.publicKey);
  check(drawn > 0 && !!ticket && ticket.owned.length === drawn && ticket.pending === 0, what + ": the pieces are minted: the page shows " + drawn + ", the wallet's list on chain holds " + (ticket ? ticket.owned.length : 0));
  return drawn;
}
const isMetaplex = (j) => !!j && typeof j.name === "string" && typeof j.symbol === "string" && typeof j.image === "string" && Array.isArray(j.attributes) && j.properties && Array.isArray(j.properties.files) && j.properties.category === "image";
const sameAttrs = (a, b) => JSON.stringify((a || []).map((x) => [x.trait_type, String(x.value)])) === JSON.stringify((b || []).map((x) => [x.trait_type, String(x.value)]));
/// The pieces of `owner` on `pool`, checked against the folder: the Core asset's URI, the JSON,
/// the attributes from the draw, the image.
async function checkPieces(pool, owner, up, manifest, what, imageCheck) {
  const cfg = await col.fetchCollectionConfig(conn, pool);
  const pieces = await col.fetchOwnedPieces(conn, pool, owner);
  check(pieces.length > 0, what + ": the wallet holds " + pieces.length + " Core assets of the collection");
  let n = 0;
  for (const p of pieces) {
    const tag = what + ": piece " + p.name;
    const m = /^(.*)\/p\/([0-9a-f]{32})\/([0-9a-f]{32})$/.exec(p.uri);
    if (!check(!!m && m[1] === cfg.uriBase && m[2] === up.artHex, tag + ": its Core asset's URI is <uri_base>/p/<art>/<seed> with the uploaded art bytes (" + p.uri + ")")) continue;
    const seed = m[3];
    const r = await fetch(p.uri);
    const j = await r.json().catch(() => null);
    if (!check(r.ok && isMetaplex(j), tag + ": the URI answers Metaplex JSON (name, symbol, image, attributes, properties.files, category image)" + (r.ok ? "" : " (" + r.status + " " + JSON.stringify(j) + ")"))) continue;
    if (pickPiece) {
      const d = pickPiece(manifest, seed);
      const what2 = manifest.kind === "pictures" ? "the uploaded ones of picture " + (d.item + 1) + ", the one the seed draws" : "one per layer, the options the seed draws";
      check(sameAttrs(j.attributes, d.attributes), tag + ": its attributes are " + what2 + " (" + j.attributes.map((a) => a.trait_type + "=" + a.value).join(", ") + ")");
      if (manifest.kind === "pictures") {
        const n = Number(/images\/(\d+)\./.exec(manifest.items[d.item].image)[1]);
        check(sameAttrs(manifest.items[d.item].attributes, fx.items[n].attributes), tag + ": and they are the attributes of that picture's own JSON file, " + n + ".json");
      }
    }
    const img = await fetch(j.image);
    const bytes = Buffer.from(await img.arrayBuffer());
    check(img.ok && /^image\//.test(img.headers.get("content-type") || "") && bytes[0] === 0x89 && bytes[1] === 0x50, tag + ": its image loads as a PNG (" + img.status + ", " + (img.headers.get("content-type") || "") + ", " + bytes.length + " bytes)");
    if (imageCheck) imageCheck(tag, j, bytes, seed);
    if (++n >= 3) break;
  }
}
/// On the coin page: pick a piece in the wallet's list and in the collection, and read its traits.
async function coinTraits(what, wantTypes) {
  await ev("document.getElementById('colMine').scrollIntoView({ block: 'start' }); true");
  await click("#colMine .piece.own");
  const ok = await until("(() => { const d = document.querySelector('#colMine .pd-traits'); return !!d && d.querySelectorAll('dt').length > 0 && !/reading/.test(d.textContent); })()", 15000);
  const traits = await ev("[...document.querySelectorAll('#colMine .pd-traits dt')].map((d) => d.textContent + '=' + d.nextElementSibling.textContent)");
  say(what + ": traits on the coin page", traits);
  check(ok && wantTypes.every((t) => traits.some((x) => x.startsWith(t + "="))), what + ": the coin page shows the piece's traits (" + wantTypes.join(", ") + ")");
  check(traits.length > 0 && traits.every((x) => /\d%$/.test(x)), what + ": each trait carries its chance in percent");
  const img = await until("(() => { const i = document.querySelector('#colMine .pd-img img'); return !!i && i.complete && i.naturalWidth > 0; })()", 10000);
  check(img, what + ": the picked piece's picture loads on the coin page");
  const line = await text("#colMine .pd-line");
  check(/comes up in [\d.]+% of draws/.test(line || ""), what + ": the panel says how often this art comes up (" + line + ")");
}

const made = {};
// One approval: a buy pays the deposit for its NFTs and a keeper mints them. A watcher with the mint crank runs
// for the parts that buy (A, Y), stopped at the end by its own process id.
let mk = null;
try {
  if (want("A") || want("Y")) {
    mk = await startMintKeeper({ rpc: RPC });
    check(mk.ok, "a watcher with the mint crank runs for the buys (process " + mk.pid + ")");
  }
  // ---- F. reading files ---------------------------------------------------------------------------
  if (want("F")) {
    console.log("\nF. reading files: a CSV, images alone");
    await open(dev, "/launch-collectible.html", launchReady);
    await artMode(STUDIO, "pictures");
    await setFiles(STUDIO + " [data-body=pictures] input[data-pick=folder]", [fx.csv]);
    await until("document.querySelectorAll(" + q(rows("pictures")) + ").length === 5", 10000);
    const csv = await ev("[...document.querySelectorAll(" + q(rows("pictures")) + ")].map((r) => [...r.querySelectorAll('input')].map((i) => i.value).concat(r.querySelector('.art-chance').textContent))");
    say("CSV rows", csv);
    check(csv.length === 5, "a CSV with a file column: five pictures in the table");
    check(csv[2] && csv[2][0] === "Calm, at last", "a quoted name with a comma in it is read whole");
    check(csv.map((r) => r[2]).join(",") === "10,20,30,40,50", "the weight column is read as the weights");
    check(csv[0] && csv[0][1] === "Background: Night, Mood: Loud", "every other column is a trait");
    check(csv.map((r) => r[3]).join(",") === "6.67%,13.3%,20%,26.7%,33.3%", "each picture's chance is its weight over the sum (" + csv.map((r) => r[3]).join(", ") + ")");
    check(/from the CSV file/.test(await text(STUDIO + " [data-body=pictures] .art-count")), "the page says it read the CSV");
    await setFiles(STUDIO + " [data-body=pictures] input[data-pick=files]", ["blue_1.png", "blue_2.png", "blue_3.png"].map((f) => path.join(fx.alone, f)));
    await until("document.querySelectorAll(" + q(rows("pictures")) + ").length === 3", 10000);
    const alone = await ev("[...document.querySelectorAll(" + q(rows("pictures")) + ")].map((r) => r.querySelector('input').value + '|' + r.querySelector('.art-chance').textContent)");
    check(alone.join(",") === "blue 1|33.3%,blue 2|33.3%,blue 3|33.3%", "images alone: one entry each, named after the file, the same chance (" + alone.join(", ") + ")");
    // a drop on the zone: two PNG files drawn in the page, carried by a DataTransfer
    await ev(`(async () => {
      const png = async (hue) => { const c = document.createElement("canvas"); c.width = 32; c.height = 32; const g = c.getContext("2d"); g.fillStyle = "hsl(" + hue + " 70% 50%)"; g.fillRect(0, 0, 32, 32); return new Uint8Array(await (await new Promise((r) => c.toBlob(r, "image/png"))).arrayBuffer()); };
      const dt = new DataTransfer();
      dt.items.add(new File([await png(10)], "dropped_one.png", { type: "image/png" }));
      dt.items.add(new File([await png(200)], "dropped_two.png", { type: "image/png" }));
      const zone = document.querySelector("#artStudio [data-drop=pictures]");
      zone.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
      zone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    const dropped = await until("document.querySelectorAll(" + q(rows("pictures")) + ").length === 2", 10000);
    const names = await ev("[...document.querySelectorAll(" + q(rows("pictures")) + ")].map((r) => r.querySelector('input').value).join(',')");
    check(dropped && names === "dropped one,dropped two", "files dropped on the zone fill the table (" + names + ")");
  }

  // ---- A. pictures --------------------------------------------------------------------------------
  if (want("A")) {
    console.log("\nA. a launch with 20 pictures in the Metaplex layout");
    const sym = "PIC" + run;
    await open(dev, "/launch-collectible.html", launchReady);
    await type("#colName", "Shapes " + run);
    await artMode(STUDIO, "pictures");
    check(/Drop your pictures/.test(await text("#revProblems")), "with no pictures yet, the review asks for them (" + (await text("#revProblems")) + ")");
    await setFiles(STUDIO + " [data-body=pictures] input[data-pick=folder]", [fx.pictures]);
    check(await until("document.querySelectorAll(" + q(rows("pictures")) + ").length === 20", 15000), "the folder's 20 pictures fill the table");
    check(/Metaplex layout/.test(await text(STUDIO + " [data-body=pictures] .art-count")), "the page says it read the Metaplex layout");
    const first = await ev("[...document.querySelectorAll(" + q(rows("pictures") + ":first-of-type input, " + rows("pictures")) + ")].slice(0, 1).map((r) => [...r.querySelectorAll('input')].map((i) => i.value))[0]");
    check(first && first[0] === fx.items[0].name && first[1] === "Background: Night, Shape: Circle, Power: 10", "row 1 carries the name and the traits of 0.json (" + JSON.stringify(first) + ")");
    check(await ev("[...document.querySelectorAll(" + q(rows("pictures") + " .art-chance") + ")].every((c) => c.textContent === '5%')"), "twenty pictures of weight 1: each shows a chance of 5%");
    await type("[aria-label='Weight of picture 1']", "3");
    const ch = await ev("[...document.querySelectorAll(" + q(rows("pictures") + " .art-chance") + ")].slice(0, 2).map((c) => c.textContent)");
    check(ch.join(",") === "13.6%,4.55%", "a weight of 3 on picture 1: its chance is 3 in 22, the others 1 in 22 (" + ch.join(", ") + ")");
    check(/royalty of 5%/.test(await text(STUDIO + " .art-royalty")), "the royalty in the files is said to be information only");
    check(/Upload your pictures before you launch/.test(await text("#revProblems")), "before the upload the review says to upload first");
    await fillCoin("Pictures " + run, sym, "0.05");
    await shotOf(STUDIO, "-pictures-before-1440");
    const up = await payAndUpload(STUDIO, "pictures", "images/5.png");
    if (up) {
      await shotOf(STUDIO + " .art-store", "-pictures-stored-1440");
      const pool = await launch("pictures");
      if (pool) {
        const cfg = await col.fetchCollectionConfig(conn, pool);
        check(cfg.uriBase === up.uriBase, "the collection on chain has uri_base " + up.uriBase + " (" + cfg.uriBase + ")");
        const json = await fetch(up.uriBase + "/collection.json");
        const raw = Buffer.from(await json.arrayBuffer());
        const artHex = sha(raw).subarray(0, 16).toString("hex");
        check(json.ok && col.hexOf(cfg.art) === artHex, "its art bytes are the first 16 bytes of the SHA-256 of collection.json as stored (" + col.hexOf(cfg.art) + ")");
        let manifest = null;
        try { manifest = JSON.parse(raw.toString("utf8")); } catch (_) {}
        check(!!manifest && manifest.kind === "pictures" && manifest.items.length === 20 && manifest.items[0].weight === 3 && sameAttrs(manifest.items[5].attributes, fx.items[5].attributes), "collection.json holds the 20 pictures with the weights and traits of the table");
        made.A = { pool, up: { ...up, artHex }, manifest, sym };
        await buyPieces(trader, pool, "pictures");
        await checkPieces(pool, trader.publicKey, made.A.up, manifest, "pictures", (tag, j, bytes, seed) => {
          if (!pickPiece) return;
          const d = pickPiece(manifest, seed);
          const i = d.item;
          const file = readFileSync(path.join(fx.pictures, Number(/images\/(\d+)\./.exec(manifest.items[i].image)[1]) + ".png"));
          check(Buffer.compare(file, bytes) === 0, tag + ": the image is the uploaded file " + manifest.items[i].image + " byte for byte");
        });
        await coinTraits("pictures", ["Background", "Shape", "Power"]);
        await ev("document.getElementById('colAll').scrollIntoView({ block: 'start' }); true");
        if (await until("document.querySelectorAll('#colAll .piece.own').length > 0", 15000)) {
          await click("#colAll .piece.own");
          await until("!!document.querySelector('#colAll .pd-traits dt')", 10000);
          await sleep(800);
          await shotOf("#colAll", "-pictures-coin-1440");
        }
      }
    }
  }

  // ---- Y. layers ------------------------------------------------------------------------------------
  if (want("Y")) {
    console.log("\nY. a launch with 4 layers");
    const sym = "LAY" + run;
    await open(dev, "/launch-collectible.html", launchReady);
    await type("#colName", "Layers " + run);
    await artMode(STUDIO, "layers");
    await setFiles(STUDIO + " [data-body=layers] input[data-pick=folder]", [fx.layers]);
    check(await until("document.querySelectorAll(" + q(STUDIO + " .layer") + ").length === 4", 15000), "the folder's four layer folders become four layers");
    const names = await ev("[...document.querySelectorAll(" + q(STUDIO + " .layer .layer-name") + ")].map((i) => i.value)");
    check(names.join(",") === "Background,Body,Eyes,Hat", "in the order of their folders, without the number before the name (" + names.join(", ") + ")");
    const bg = await ev("[...document.querySelectorAll(" + q(STUDIO + " .layer:first-child .layer-opt:not(.head):not(.layer-empty)") + ")].map((r) => [...r.querySelectorAll('input')].map((i) => i.value).concat(r.querySelector('.art-chance').textContent).join('|'))");
    check(bg.join(",") === "Blue|30|50%,Green|20|33.3%,Sand|10|16.7%", "the weight after # in each file name is read, and the chances follow (" + bg.join(", ") + ")");
    // the hat can be left out
    await click(STUDIO + " .layer:nth-child(4) .layer-empty-sw");
    await type(STUDIO + " .layer:nth-child(4) .layer-empty input", "6");
    const hat = await ev("[...document.querySelectorAll(" + q(STUDIO + " .layer:nth-child(4) .art-chance") + ")].map((c) => c.textContent)");
    check(hat.join(",") === "41.7%,8.33%,50%", "Can be empty with a weight of 6: Cap 5, Crown 1 and empty 6 share the draw (" + hat.join(", ") + ")");
    // the arrows move a layer, and back
    await click(STUDIO + " .layer:nth-child(2) .layer-arrows button:last-child");
    const moved = await ev("[...document.querySelectorAll(" + q(STUDIO + " .layer .layer-name") + ")].map((i) => i.value).join(',')");
    await click(STUDIO + " .layer:nth-child(3) .layer-arrows button:first-child");
    const back = await ev("[...document.querySelectorAll(" + q(STUDIO + " .layer .layer-name") + ")].map((i) => i.value).join(',')");
    check(moved === "Background,Eyes,Body,Hat" && back === "Background,Body,Eyes,Hat", "the arrows move a layer down and up again (" + moved + ", then " + back + ")");
    const drawn = await until("(() => { const c = [...document.querySelectorAll(" + q(STUDIO + " .art-strip canvas") + ")]; return c.length === 6 && c.every((x) => x.title); })()", 10000);
    check(drawn, "the preview draws six pieces from random seeds, each with its traits");
    await fillCoin("Layers " + run, sym, "0.05");
    await shotOf(STUDIO, "-layers-before-1440");
    const up = await payAndUpload(STUDIO, "layers");
    if (up) {
      const pool = await launch("layers");
      if (pool) {
        const cfg = await col.fetchCollectionConfig(conn, pool);
        check(cfg.uriBase === up.uriBase, "the collection on chain has uri_base " + up.uriBase);
        const raw = Buffer.from(await (await fetch(up.uriBase + "/collection.json")).arrayBuffer());
        const artHex = sha(raw).subarray(0, 16).toString("hex");
        check(col.hexOf(cfg.art) === artHex, "its art bytes are the first 16 bytes of the SHA-256 of collection.json as stored");
        let manifest = null;
        try { manifest = JSON.parse(raw.toString("utf8")); } catch (_) {}
        check(!!manifest && manifest.kind === "layers" && manifest.layers.length === 4 && manifest.layers[3].options.some((o) => o.none && o.weight === 6) && manifest.layers[0].options[0].weight === 30 && manifest.width === 256, "collection.json holds the four layers in order, with their weights and the empty hat");
        made.Y = { pool, up: { ...up, artHex }, manifest, sym };
        await buyPieces(trader, pool, "layers");
        await checkPieces(pool, trader.publicKey, made.Y.up, manifest, "layers", (tag, j, bytes) => {
          check(/\.png$/.test(j.image) && bytes.readUInt32BE(16) === 256 && bytes.readUInt32BE(20) === 256, tag + ": the image is the composite PNG at the layers' size (" + bytes.readUInt32BE(16) + " by " + bytes.readUInt32BE(20) + ")");
        });
        await coinTraits("layers", ["Background", "Body", "Eyes"]);
        await ev("document.getElementById('colAll').scrollIntoView({ block: 'start' }); true");
        if (await until("document.querySelectorAll('#colAll .piece.own').length > 0", 15000)) {
          await click("#colAll .piece.own");
          await until("!!document.querySelector('#colAll .pd-traits dt')", 10000);
          await sleep(800);
          await shotOf("#colAll", "-layers-coin-1440");
        }
      }
    }
  }

  // ---- E. the owner's editor -------------------------------------------------------------------------
  if (want("E") && made.A) {
    console.log("\nE. the owner uploads a new version on the coin page");
    await open(dev, "/coin.html?pool=" + made.A.pool.toBase58(), "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on') && !document.getElementById('colEdit').hidden");
    const ER = "#editArt";
    check(/files in folder/.test((await text(ER + " .art-now")) || ""), "the editor says the pieces use the uploaded folder now (" + (await text(ER + " .art-now")) + ")");
    check(await ev("![...document.querySelectorAll('#editArt .art-modes input')].some((r) => r.checked)"), "nothing is picked at first: the art stays as it is until the owner picks a way");
    await artMode(ER, "layers");
    await setFiles(ER + " [data-body=layers] input[data-pick=folder]", [fx.layers]);
    check(await until("document.querySelectorAll('#editArt .layer').length === 4", 15000), "the owner drops the layers folder in the editor");
    const up = await payAndUpload(ER, "new version");
    if (up) {
      await shotOf("#colEdit", "-edit-1440");
      const before = await col.fetchCollectionConfig(conn, made.A.pool);
      await clearToasts();
      await click("#colSave");
      let after = before;
      for (let i = 0; i < 60 && after.uriBase === before.uriBase; i++) { await sleep(500); after = await col.fetchCollectionConfig(conn, made.A.pool); }
      const said = await text("#toasts .toast.ok");
      check(after.uriBase === up.uriBase && col.hexOf(after.art) !== col.hexOf(before.art) && after.artVersion === before.artVersion + 1, "Save sets the new folder and its art bytes on chain (" + after.uriBase + ", art version " + before.artVersion + " to " + after.artVersion + ")");
      check(/Collection updated/.test(said || ""), "the page says the collection was updated (" + said + ")");
      const json = Buffer.from(await (await fetch(up.uriBase + "/collection.json")).arrayBuffer());
      check(col.hexOf(after.art) === sha(json).subarray(0, 16).toString("hex"), "the new art bytes are the hash of the new collection.json");
    }
  }

  // ---- H. the operator's hide switch -----------------------------------------------------------------------
  if (want("H") && made.A) {
    console.log("\nH. the operator hides a folder");
    if (!process.env.UPLOADS_DIR && !process.env.ART_HIDDEN_FILE) console.log("        note: skipped. Run the flow with the site's UPLOADS_DIR or ART_HIDDEN_FILE to test the hide switch.");
    else {
      const hide = (cmd) => execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/art-hide.mjs", import.meta.url)), cmd, made.A.up.id], { env: process.env, encoding: "utf8" });
      const pieces = await col.fetchOwnedPieces(conn, made.A.pool, trader.publicKey);
      hide("add");
      await sleep(3000);
      const j = await (await fetch(pieces[0].uri)).json().catch(() => null);
      check(!!j && /Hidden by the site operator/.test(j.description || ""), "a hidden folder's piece answers the words Hidden by the site operator (" + (j && j.description) + ")");
      // as a visitor who has not seen these pieces in the last minutes: the piece JSON may be kept
      // by a browser for 10 minutes (the resolver's cache header), so this browser's cache is off
      await call("Network.enable"); await call("Network.setCacheDisabled", { cacheDisabled: true });
      await open(trader, "/coin.html?pool=" + made.A.pool.toBase58(), "!!document.querySelector('#tradeCard .btn-buy') && !!document.querySelector('#walletBtn.on')");
      await ev("document.getElementById('colMine').scrollIntoView({ block: 'start' }); true");
      await click("#colMine .piece.own");
      const said = await until("/hid this collection/.test((document.querySelector('#colMine .pd-line') || {}).textContent || '')", 15000);
      await call("Network.setCacheDisabled", { cacheDisabled: false });
      check(said, "the coin page says the site operator hid the art (" + (await text("#colMine .pd-line")) + ")");
      await shotOf("#colMine", "-hidden-1440");
      hide("remove");
      await sleep(3000);
      const back = await (await fetch(pieces[0].uri)).json().catch(() => null);
      check(!!back && !/Hidden by the site operator/.test(back.description || "") && back.attributes.length > 0, "removed from the list, the piece answers its own art again");
    }
  }

  // ---- S. screenshots at 1440 and 390 ----------------------------------------------------------------------
  if (want("S")) {
    console.log("\nS. screenshots");
    for (const [width, height] of [[1440, 1300], [390, 844]]) {
      await view(width, height);
      for (const mode of ["generated", "pictures", "layers", "renderer"]) {
        await open(dev, "/launch-collectible.html", launchReady);
        if (mode !== "generated") await artMode(STUDIO, mode);
        if (mode === "pictures") { await setFiles(STUDIO + " [data-body=pictures] input[data-pick=folder]", [fx.pictures]); await until("document.querySelectorAll(" + q(rows("pictures")) + ").length === 20", 15000); }
        if (mode === "layers") { await setFiles(STUDIO + " [data-body=layers] input[data-pick=folder]", [fx.layers]); await until("document.querySelectorAll(" + q(STUDIO + " .art-strip canvas[title]") + ").length === 6", 15000); }
        await sleep(600);
        check(await overflow(), "the art section in " + mode + " does not scroll sideways at " + width);
        if (width < 600) { const small = await ev("[...document.querySelectorAll('#artStudio button, #artStudio .choice, #artStudio input.input, #artStudio .file-btn, #artStudio textarea')].filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height < 44).map((e) => (e.getAttribute('aria-label') || e.textContent.trim().slice(0, 24)) + ' ' + Math.round(e.getBoundingClientRect().height))"); check(small.length === 0, "every control of the art section in " + mode + " is at least 44 px high on a phone" + (small.length ? " (" + small.slice(0, 6).join(", ") + ")" : "")); }
        await shotOf("#artStudio", "-art-" + mode + "-" + width);
      }
      if (made.A) {
        await open(trader, "/coin.html?pool=" + made.A.pool.toBase58(), "!!document.querySelector('#tradeCard .btn-buy')");
        await ev("document.getElementById('colAll').scrollIntoView({ block: 'start' }); true");
        if (await until("document.querySelectorAll('#colAll .piece.own').length > 0", 15000)) { await click("#colAll .piece.own"); await until("!!document.querySelector('#colAll .pd-traits dt')", 10000); await sleep(800); await shotOf("#colAll", "-coin-all-" + width); }
        check(await overflow(), "the coin page with a picked piece does not scroll sideways at " + width);
      }
    }
    await view(W, HGT);
  }

  const flags = JSON.parse((await ev("localStorage.getItem('__phantomFlags') || '[]'")) || "[]");
  check(flags.length === 0, "the wallet was never handed a transaction Phantom blocks (already signed by another key, or failing before it is signed)" + (flags.length ? ": " + flags.length + "\n    " + flags.join("\n    ") : ""));
} catch (e) {
  check(false, "the run stopped: " + e.message);
} finally {
  console.log("\n" + (await edge.close()));
  if (mk) {
    const lines = mk.lines.filter((l) => / mint: /.test(l));
    console.log("the watcher's mints: " + (lines.length ? "\n  " + lines.join("\n  ") : "none"));
    await mk.stop(); console.log("stopped the watcher (process " + mk.pid + ")");
  }
  try { rmSync(FX_DIR, { recursive: true, force: true }); } catch (_) {}
  // the trader sells its coins back, so the pools end as they began
  for (const k of Object.keys(made)) {
    try {
      const p = await client.pool(made[k].pool);
      const amount = await client.tokenBalance(trader.publicKey, p.baseMint, p.baseTokenProgram);
      if (amount > 0n) {
        const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(trader.publicKey, await client.swapInstructions(trader.publicKey, p, await client.hookRef(p, trader.publicKey), DIRECTION.SELL, amount, 0n));
        tx.sign([trader]);
        await conn.confirmTransaction({ signature: await conn.sendTransaction(tx), blockhash, lastValidBlockHeight }, "confirmed");
      }
    } catch (e) { console.log("        note: could not sell back on " + k + ": " + e.message); }
  }
}

const mine = pageErrors.filter((e) => /EXCEPTION/.test(e) || !/ERR_FAILED|Failed to load resource/.test(e));
console.log("\npage errors that are the site's own: " + (mine.length ? "\n  " + [...new Set(mine)].join("\n  ") : "none"));
console.log("\n" + (total - failed) + " of " + total + " checks passed" + (failed ? "\nFAILED:\n  " + failures.join("\n  ") : ""));
console.log("launched: " + (Object.entries(made).map(([k, m]) => k + " " + m.sym + " " + m.pool.toBase58()).join(", ") || "nothing"));
console.log("screenshots: " + shots.length);
process.exit(failed ? 1 : 0);
