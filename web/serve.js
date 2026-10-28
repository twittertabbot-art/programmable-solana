// Local server for the Programmable site: static files from this folder plus the JSON routes.
//   node web/serve.js            -> http://localhost:8787
//   PORT=9000 node web/serve.js
// GET /art/...: the piece renderer, and under /art/u/<folder>/ the resolver of a launcher's own
//   art (web/api/_art.js lists the routes and its ART_* settings; HOOKS.md section 13).
// GET /api/v1/quote and POST /api/v1/swap: the trade API for bots and other sites. The code
//   is web/api/_trade.js, the same module the Vercel functions in web/api/v1/ call. API.md
//   in the project folder lists the fields, the limits and the environment variables.
// POST /api/metadata  body: { name, symbol, description, image, extensions }
//   `image` may be an https URL or a data URL (png, jpeg, webp, gif, max 1.5 MB decoded).
//   Saves the image and the Metaplex JSON under web/uploads/ and answers { url, image }.
//   The same handler shape runs on Vercel in web/api/metadata.js with Vercel Blob.
// POST /api/metadata  body: a hook descriptor ({ "programmable_hook": 1, ... })
//   Checks it with the validator the pages use, saves it as it was sent under
//   web/uploads/<first 20 hex characters of its SHA-256>.json and answers { url, pin }.
//   `pin` is what a manifest's link carries after "#s=" to pin this file: the first 16 bytes
//   of the SHA-256 of the stored bytes, as 22 characters of base64url. A manifest holds 128
//   bytes and the pin takes 25, so the address has to fit in 103. The file's name is in hex,
//   not the pin itself, because some file systems do not tell capital letters from small ones.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkDescriptor, pinOf, MAX_DESCRIPTOR_BYTES } from "./workshop-descriptor.js";

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// On a server: the public address the uploads and the piece renderer are addressed from (they
// are written on chain and never change), and a folder for uploads outside the site's files.
const ORIGIN = String(process.env.PUBLIC_ORIGIN || "http://localhost:" + PORT).replace(/\/+$/, "");
const UPLOADS = path.resolve(process.env.UPLOADS_DIR || path.join(ROOT, "uploads"));
const TRUST_PROXY = process.env.PROGRAMMABLE_TRUST_PROXY === "1";
const PER_HOUR = Number(process.env.UPLOAD_LIMIT_PER_HOUR || 30), PER_DAY = Number(process.env.UPLOAD_LIMIT_PER_DAY || 2000);
const uploadsBy = new Map(); let uploadsDay = { day: "", n: 0 };
/// The visitor's address: behind a proxy the last X-Forwarded-For entry (the one Caddy added).
function visitor(req) {
  if (TRUST_PROXY) { const p = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean); if (p.length) return p[p.length - 1]; }
  return String((req.socket && req.socket.remoteAddress) || "unknown");
}
/// At most PER_HOUR uploads an hour from one visitor and PER_DAY in all: the disk cannot be filled.
function uploadAllowed(req) {
  const now = Date.now(), day = new Date().toISOString().slice(0, 10);
  if (uploadsDay.day !== day) uploadsDay = { day, n: 0 };
  if (uploadsDay.n >= PER_DAY) return false;
  const ip = visitor(req), list = (uploadsBy.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (list.length >= PER_HOUR) { uploadsBy.set(ip, list); return false; }
  list.push(now); uploadsBy.set(ip, list); uploadsDay.n++;
  if (uploadsBy.size > 50_000) uploadsBy.clear();
  return true;
}
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8", ".woff2": "font/woff2",
};
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
// a browser must take every answer for what the header says it is, never guess (an uploaded or
// a resolved file is never run as a page of this site)
const NOSNIFF = { "x-content-type-options": "nosniff" };
const MAX_BODY = 3_000_000;
const MAX_IMAGE = 1_500_000;

function looksLike(buf, type) {
  if (buf.length < 12) return false;
  if (type === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (type === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === "image/webp") return buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
  if (type === "image/gif") return buf.toString("ascii", 0, 4) === "GIF8";
  return false;
}

/// Validates the request body and returns { json, image } where image is null or { type, ext, buf }.
/// For a hook descriptor it returns { json, image: null, descriptor: { text, pin, file } }:
/// the text to store, the pin of those bytes, and the file name to store it under.
/// Shared logic with api/metadata.js; a thrown Error carries `status`.
export function prepareMetadata(body) {
  const fail = (status, message) => { const e = new Error(message); e.status = status; return e; };
  if (!body || typeof body !== "object") throw fail(400, "Send a JSON object.");
  // A hook descriptor (hook-template/README.md, "Describe your hook"), checked by the validator
  // the pages use. It is stored as it was sent: a site pins a descriptor by a hash of its
  // bytes, so the file must not be rewritten after the builder has seen it.
  if (body.programmable_hook !== undefined) {
    const c = checkDescriptor(body);
    if (!c.ok) throw fail(400, "This is not a valid hook descriptor. " + c.errors[0]);
    const text = JSON.stringify(body, null, 2) + "\n";
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_DESCRIPTOR_BYTES) throw fail(413, "A descriptor is at most " + MAX_DESCRIPTOR_BYTES + " bytes.");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    return { json: body, image: null, descriptor: { text, pin: pinOf(bytes), file: sha256.slice(0, 20) + ".json" } };
  }
  const name = String(body.name || "").trim();
  const symbol = String(body.symbol || "").trim();
  const description = String(body.description || "").trim().slice(0, 1000);
  if (!name || name.length > 32) throw fail(400, "Name must be 1 to 32 characters.");
  if (!symbol || symbol.length > 10) throw fail(400, "Symbol must be 1 to 10 characters.");
  const ext = body.extensions && typeof body.extensions === "object" ? body.extensions : {};
  const link = (v) => { const s = String(v || "").trim().slice(0, 200); return /^https?:\/\//i.test(s) ? s : ""; };
  const extensions = {};
  if (link(ext.website)) extensions.website = link(ext.website);
  if (link(ext.twitter)) extensions.twitter = link(ext.twitter);
  if (link(ext.telegram)) extensions.telegram = link(ext.telegram);
  let image = null;
  let imageUrl = "";
  const raw = String(body.image || "").trim();
  if (raw.startsWith("data:")) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(raw);
    if (!m) throw fail(415, "Image must be a PNG, JPG, WebP or GIF.");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > MAX_IMAGE) throw fail(413, "Image must be under 1.5 MB.");
    if (!looksLike(buf, m[1])) throw fail(415, "That file is not a " + EXT[m[1]].toUpperCase() + " image.");
    image = { type: m[1], ext: EXT[m[1]], buf };
  } else if (raw) {
    if (!/^https?:\/\//i.test(raw) || raw.length > 300) throw fail(400, "Image must be an https URL or an uploaded file.");
    imageUrl = raw;
  }
  const json = { name, symbol, description, image: imageUrl, extensions };
  return { json, image };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("Body too large (3 MB max)."), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function metadataRoute(req, res) {
  if (req.method !== "POST") { res.writeHead(405, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "POST only" })); }
  try {
    if (!uploadAllowed(req)) throw Object.assign(new Error("Too many uploads from this address. Try again in an hour."), { status: 429 });
    const buf = await readBody(req);
    let body;
    try { body = JSON.parse(buf.toString("utf8")); } catch (_) { throw Object.assign(new Error("Body is not JSON."), { status: 400 }); }
    const { json, image, descriptor } = prepareMetadata(body);
    const dir = UPLOADS;
    fs.mkdirSync(dir, { recursive: true });
    const base = ORIGIN + "/uploads/";
    if (descriptor) {
      // named by its content: the same descriptor sent twice is one file
      fs.writeFileSync(path.join(dir, descriptor.file), descriptor.text);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...NOSNIFF });
      return res.end(JSON.stringify({ url: base + descriptor.file, pin: descriptor.pin }));
    }
    if (image) {
      const imgName = crypto.randomUUID() + "." + image.ext;
      fs.writeFileSync(path.join(dir, imgName), image.buf);
      json.image = base + imgName;
    }
    const jsonName = crypto.randomUUID() + ".json";
    fs.writeFileSync(path.join(dir, jsonName), JSON.stringify(json, null, 2));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...NOSNIFF });
    res.end(JSON.stringify({ url: base + jsonName, image: json.image }));
  } catch (e) {
    res.writeHead(e.status || 500, { "content-type": "application/json", ...NOSNIFF });
    res.end(JSON.stringify({ error: e.message || "failed" }));
  }
}

/// The server's own files in the site's folder: this file, the API code (web/api: its routes are
/// answered above, never as files), the tests and the build and host settings. No secret is in
/// them, but they need not be public, so they answer 404 like a file that is not there. `rel` is
/// the path inside the site's folder. Compared without case and without the dots and spaces a
/// Windows disk ignores at the end of a name, so "/API/_sdk.js" or "/serve.js." is hidden too.
const HIDDEN_FILES = new Set(["serve.js", "vercel.json", "package.json", "package-lock.json", "sdk-gaps.md"]);
// tools: the operator's scripts copied next to the site on a server (the art hide switch);
// review: the browser test tools and their screenshots
const HIDDEN_DIRS = new Set(["api", "node_modules", "tools", "review"]);
export function isServerFile(rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase().replace(/::\$data$/, "").replace(/[. ]+$/, ""));
  if (!parts.length) return false;
  if (HIDDEN_DIRS.has(parts[0])) return true;
  return parts.length === 1 && HIDDEN_FILES.has(parts[0]);
}

/// The art resolver's own files in the uploads folder: its cache and the hide list. `rel` is the
/// path inside the uploads folder, compared the way isServerFile compares.
export function isArtPrivate(rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase().replace(/::\$data$/, "").replace(/[. ]+$/, ""));
  return parts.length > 0 && (parts[0] === "art-cache" || parts[0] === "art-hidden.txt");
}

function serveStatic(req, res, u) {
  let file;
  // a path with a broken percent escape must not stop the server
  try { file = decodeURIComponent(u.pathname); } catch (_) { res.writeHead(400, { "content-type": "text/plain" }); return res.end("bad request"); }
  // a NUL byte decodes fine ("%00") but makes the file system calls throw instead of answering
  if (file.includes("\0")) { res.writeHead(400, { "content-type": "text/plain" }); return res.end("bad request"); }
  if (file === "/" || file === "") file = "/index.html";
  // uploads live in their own folder (UPLOADS_DIR on a server)
  const inUploads = file.startsWith("/uploads/");
  const base = inUploads ? UPLOADS : ROOT;
  const abs = path.normalize(path.join(base, inUploads ? file.slice("/uploads".length) : file));
  if (!abs.startsWith(base + path.sep) && abs !== base) { res.writeHead(403); return res.end(); }
  if (!inUploads && isServerFile(path.relative(ROOT, abs))) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
  // the art resolver's cache and the operator's hide list sit in the uploads folder by default
  if (inUploads && isArtPrivate(path.relative(UPLOADS, abs))) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache", ...NOSNIFF });
    res.end(data);
  });
}

// GET /art/...: the piece renderer (JSON, SVG, collection JSON), same code as the Vercel function,
// and a launcher's own art under /art/u/<folder>/ (web/api/_art.js lists the routes and the ART_*
// settings: store, gateways, cache folder and size, hide list).
let artSettingsOnce = null;
async function artHandler(req, res, u) {
  try {
    const [{ artRoute, artSettings }, { default: CONFIG }] = await Promise.all([import("./api/_art.js"), import("./config.js")]);
    if (!artSettingsOnce) artSettingsOnce = artSettings(process.env, { origin: ORIGIN, uploadsDir: UPLOADS });
    // the requester's address feeds the drawing budget; a HEAD never draws a piece
    const out = await artRoute(u.pathname, ORIGIN, process.env.PROGRAMMABLE_RPC || CONFIG.rpc || "", { settings: artSettingsOnce, search: u.search, visitor: visitor(req), head: req.method === "HEAD" });
    res.writeHead(out.status, { "content-type": out.type, "cache-control": out.cache, "access-control-allow-origin": "*", "access-control-expose-headers": "x-art", ...NOSNIFF, ...(out.headers || {}) });
    res.end(req.method === "HEAD" ? undefined : out.body);
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json", ...NOSNIFF });
    res.end(JSON.stringify({ error: e.message || "renderer failed" }));
  }
}

// /api/v1/<route>: the trade API, and the review requests of Custom hooks (/api/v1/hook-reviews...
// and /api/v1/hooks/approved, web/api/_reviews.js). Each handler answers every case itself, errors included.
async function tradeApi(req, res, u) {
  try {
    const route = u.pathname.slice("/api/v1/".length).replace(/\/+$/, "");
    if (route === "hook-reviews" || route.startsWith("hook-reviews/") || route === "hooks/approved") {
      const { handleReviews } = await import("./api/_reviews.js");
      return await handleReviews(req, res, route);
    }
    const { handleRequest } = await import("./api/_trade.js");
    await handleRequest(req, res, route);
  } catch (_) {
    if (res.headersSent) return res.end();
    res.writeHead(500, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: { code: "INTERNAL", message: "Something went wrong on our side. Try again." } }));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  http.createServer((req, res) => {
    let u;
    // a request line that is not a URL ("//") must not stop the server either
    try { u = new URL(req.url, "http://localhost"); } catch (_) { res.writeHead(400, { "content-type": "text/plain" }); return res.end("bad request"); }
    // one request must never take the process down: the site, the trade API and the art resolver
    // all run in it. A handler that throws before answering gets a 500 and the server goes on.
    try {
      if (u.pathname === "/api/metadata") return metadataRoute(req, res);
      if (u.pathname === "/api/v1" || u.pathname.startsWith("/api/v1/")) return tradeApi(req, res, u);
      if (u.pathname.startsWith("/art/")) return artHandler(req, res, u);
      return serveStatic(req, res, u);
    } catch (e) {
      console.error("request failed: " + (e && e.message ? e.message : e));
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      return res.end("server error");
    }
  }).listen(PORT, "127.0.0.1", () => console.log("Programmable site on http://localhost:" + PORT + (ORIGIN.startsWith("http://localhost") ? "" : ", public address " + ORIGIN + ", uploads in " + UPLOADS) + "  (Ctrl+C stops it)"));
}
