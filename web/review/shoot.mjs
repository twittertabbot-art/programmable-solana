// Review tool: screenshots through the DevTools protocol, so a capture can land mid-animation
// and a real phone viewport and colour scheme can be emulated without the iframe harness.
//   node web/review/shoot.mjs <url> <out.png> [width] [height] [delayMs] [dark|light] [js to run after load] [wallet address] [full]
// "wallet address": a read-only stand-in wallet, so pages draw their connected state (it cannot sign).
// "full": capture the whole page, not only the first screen. The page width is printed either way.
// Starts its own headless Edge (no extensions, a profile folder of its own) and closes exactly
// that one through its DevTools port when it ends. See edge.mjs.
import { writeFileSync } from "node:fs";
import { startEdge } from "./edge.mjs";

const [url, out, w = "1440", h = "1000", delay = "1200", scheme = "dark", evalJs = "", walletKey = "", full = ""] = process.argv.slice(2);
if (!url || !out) { console.error("usage: node web/review/shoot.mjs <url> <out.png> [width] [height] [delayMs] [dark|light] [js to run after load] [wallet address] [full]"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = await startEdge({ name: "shoot", width: Number(w), height: Number(h) });
let id = 0; const pending = new Map(); const events = []; const errors = [];
function call(ws, method, params = {}) {
  return new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
}
try {
  const ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === "Runtime.exceptionThrown") errors.push("EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push("console.error " + d.params.args.map((a) => a.value || a.description).join(" "));
    else if (d.method) events.push(d.method);
  };
  await call(ws, "Page.enable"); await call(ws, "Runtime.enable");
  await call(ws, "Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 600 });
  await call(ws, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  if (walletKey) await call(ws, "Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem(\"Programmable.wallet\", \"phantom\"); window.phantom = { solana: { isPhantom: true, publicKey: { toBase58: () => \"" + walletKey + "\" }, connect: async () => ({ publicKey: { toBase58: () => \"" + walletKey + "\" } }), on() {}, disconnect: async () => {} } };" });
  await call(ws, "Page.navigate", { url });
  for (let i = 0; i < 100 && !events.includes("Page.loadEventFired"); i++) await sleep(100);
  if (evalJs) { await sleep(600); await call(ws, "Runtime.evaluate", { expression: evalJs, awaitPromise: true }); }
  await sleep(Number(delay));
  const size = (await call(ws, "Runtime.evaluate", { expression: "JSON.stringify([document.documentElement.scrollWidth, window.innerWidth, document.documentElement.scrollHeight])", returnByValue: true })).result.value;
  const [scrollW, innerW, scrollH] = JSON.parse(size);
  if (full) {
    // a taller viewport instead of a capture beyond it: sticky bars and vh layouts stay where they are
    await call(ws, "Emulation.setDeviceMetricsOverride", { width: Number(w), height: Math.min(scrollH, 12000), deviceScaleFactor: 1, mobile: Number(w) < 600 });
    await sleep(500);
  }
  const shot = await call(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("wrote " + out + "  (page width " + scrollW + " of " + innerW + (scrollW > innerW ? ", SCROLLS SIDEWAYS" : "") + ")");
  if (errors.length) console.log("page errors:\n" + errors.join("\n"));
  ws.close();
} catch (e) {
  console.error("shoot failed: " + e.message); process.exitCode = 1;
} finally {
  console.log(await edge.close());
}
