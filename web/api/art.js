// Vercel serverless function: the piece renderer. vercel.json rewrites /art/<path> here as
// /api/art?path=<path>. Same answers as the local server (web/serve.js), through web/api/_art.js.
import { artRoute } from "./_art.js";
import CONFIG from "../config.js";

export default async function handler(req, res) {
  const u = new URL(req.url, "http://localhost");
  const path = u.searchParams.get("path") || "";
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost");
  const rpc = process.env.PROGRAMMABLE_RPC || CONFIG.rpc || "";
  // a local RPC address means nothing on a hosted function; the collection name then falls back
  const usable = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(rpc) ? "" : rpc;
  // the requester's address (the first X-Forwarded-For entry on Vercel) feeds the drawing budget
  const visitor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const out = await artRoute("/art/" + path, proto + "://" + host, usable, { search: u.search, visitor, head: req.method === "HEAD" });
  res.statusCode = out.status;
  res.setHeader("content-type", out.type);
  res.setHeader("cache-control", out.cache);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-expose-headers", "x-art");
  res.setHeader("x-content-type-options", "nosniff");
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.end(req.method === "HEAD" ? undefined : out.body);
}
