// Vercel serverless function: hosts a coin's Metaplex JSON (and its image) in Vercel Blob.
// POST /api/metadata  body: { name, symbol, description, image, extensions }
//   `image` is an https URL or a data URL (png, jpeg, webp, gif, max 1.5 MB decoded).
//   Answers { url, image }. Without BLOB_READ_WRITE_TOKEN it answers 503 and says why.
// POST /api/metadata  body: a hook descriptor ({ "programmable_hook": 1, ... })
//   Stores it as it was sent under h/<first 20 hex characters of its SHA-256>.json and
//   answers { url, pin }, as web/serve.js does. `pin` is what a manifest's link carries after
//   "#s=" to pin the file. A manifest has room for an address of 103 bytes next to the pin.
//   A Vercel Blob address of this shape has about 85, so it should fit. This path has not
//   been run: check the length of the address your store answers before you rely on it.
// Same validation as web/serve.js (prepareMetadata), different storage.
import { randomUUID } from "node:crypto";
import { prepareMetadata } from "../serve.js";

export const config = { api: { bodyParser: false } };

const MAX_BODY = 3_000_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("Body too large (3 MB max)."), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") { res.statusCode = 405; return res.end(JSON.stringify({ error: "POST only" })); }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: "Metadata hosting is not set up on this deployment: BLOB_READ_WRITE_TOKEN is missing. Host the JSON yourself and paste its URL." }));
  }
  try {
    const buf = await readBody(req);
    let body;
    try { body = JSON.parse(buf.toString("utf8")); } catch (_) { throw Object.assign(new Error("Body is not JSON."), { status: 400 }); }
    const { json, image, descriptor } = prepareMetadata(body);
    const { put } = await import("@vercel/blob");
    if (descriptor) {
      // named by its content: the same descriptor sent twice is one file
      const blob = await put("h/" + descriptor.file, descriptor.text, { access: "public", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });
      res.statusCode = 200;
      return res.end(JSON.stringify({ url: blob.url, pin: descriptor.pin }));
    }
    if (image) {
      const blob = await put("coins/" + randomUUID() + "." + image.ext, image.buf, { access: "public", contentType: image.type, addRandomSuffix: false });
      json.image = blob.url;
    }
    const meta = await put("coins/" + randomUUID() + ".json", JSON.stringify(json, null, 2), { access: "public", contentType: "application/json", addRandomSuffix: false });
    res.statusCode = 200;
    res.end(JSON.stringify({ url: meta.url, image: json.image }));
  } catch (e) {
    res.statusCode = e.status || 502;
    res.end(JSON.stringify({ error: e.message || "Storage error" }));
  }
}
