// Shared by the tests: a proxy started in process against the fake upstream, with a log that is
// kept in memory, and small request helpers.
import net from "node:net";
import { loadConfig } from "../lib/config.mjs";
import { createLogger } from "../lib/log.mjs";
import { startProxy } from "../lib/server.mjs";
import { startFakeUpstream, SECRET } from "./fake-upstream.mjs";

export { SECRET };

export function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

/// Start the fake upstream (its address carries SECRET in the path, like a provider's key) and a
/// proxy in front of it. `env` overrides the proxy's settings. Returns everything the tests look at.
export async function startAll(env = {}, fakeOpts = {}) {
  const fake = await startFakeUpstream(fakeOpts);
  const lines = [];
  // PORT "pair": two ports next to each other, picked once the fake has its own (web3.js derives the
  // WebSocket port as the RPC port plus one)
  if (env.PORT === "pair") { const p = await freePortPair(); env = { ...env, PORT: String(p), WS_PORT: String(p + 1) }; }
  // the fake takes the WebSocket on its HTTP port; without UPSTREAM_WS the proxy would use the port plus
  // one, as web3.js does for a validator (8899 and 8900)
  const cfg = loadConfig({ UPSTREAM_RPC: fake.origin + "/v1/" + SECRET, UPSTREAM_WS: "ws://127.0.0.1:" + fake.port + "/v1/" + SECRET, PORT: "0", SUMMARY_EVERY_SECONDS: "0", ...env });
  const log = createLogger(cfg.secrets, (level, text) => lines.push(level + " " + text));
  let proxy;
  try { proxy = await startProxy(cfg, { log }); } catch (e) { await fake.close(); throw e; }
  const origin = "http://127.0.0.1:" + proxy.port;
  const responses = [];
  /// POST a JSON-RPC body (an object, an array, or a raw string). Answers { status, headers, body, text }.
  async function rpc(body, headers = {}) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const res = await fetch(origin + "/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: text });
    const out = await res.text();
    responses.push(out);
    let parsed = null;
    try { parsed = JSON.parse(out); } catch (_) {}
    return { status: res.status, headers: res.headers, body: parsed, text: out };
  }
  async function health() { const res = await fetch(origin + "/health"); const text = await res.text(); responses.push(text); return JSON.parse(text); }
  async function close() { await proxy.close(); await fake.close(); }
  return { fake, cfg, log, lines, proxy, origin, rpc, health, responses, close };
}

/// Two free ports next to each other (web3.js derives the WebSocket port as the RPC port plus one).
export async function freePortPair() {
  for (let i = 0; i < 20; i++) {
    const p = await freePort();
    const ok = await new Promise((resolve) => { const s = net.createServer(); s.on("error", () => resolve(false)); s.listen(p + 1, "127.0.0.1", () => s.close(() => resolve(true))); });
    if (ok) return p;
  }
  throw new Error("no free port pair");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const call = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
