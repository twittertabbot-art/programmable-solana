// Review tool: drive a headless page with real mouse input and print what the script returns.
//   node web/review/eval.mjs <url> <width> <height> <script.mjs exporting default async ({ ev, mouse, sleep, call })>
// Starts its own headless Edge (no extensions, a profile folder of its own) and closes exactly
// that one through its DevTools port when it ends. See edge.mjs.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { startEdge } from "./edge.mjs";

const [url, w = "1440", h = "900", script] = process.argv.slice(2);
if (!url || !script) { console.error("usage: node web/review/eval.mjs <url> <width> <height> <script.mjs>"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = await startEdge({ name: "eval", width: Number(w), height: Number(h) });
let id = 0; const pending = new Map(); const logs = [];
try {
  const ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const call = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); if (d.error) p.rej(new Error(d.error.message)); else p.res(d.result); }
    else if (d.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") logs.push("console.error " + d.params.args.map((a) => a.value || a.description).join(" "));
  };
  await call("Page.enable"); await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url });
  await sleep(2500);
  const mouse = (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  const ev = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  const run = (await import(pathToFileURL(resolve(script)).href)).default;
  console.log(JSON.stringify(await run({ ev, mouse, sleep, call }), null, 1));
  console.log(logs.length ? logs.join("\n") : "no page errors");
  ws.close();
} catch (e) { console.error("eval failed: " + e.message); process.exitCode = 1; } finally { console.log(await edge.close()); }
