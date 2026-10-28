// Shared by every review tool: start one headless Edge for the tool and close exactly that one.
//
//   import { startEdge } from "./edge.mjs";
//   const edge = await startEdge({ name: "templates", width: 1440, height: 1700 });
//   const ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
//   ...
//   console.log(await edge.close());
//
// Rules this file keeps for all of them:
// - Edge always starts with --disable-extensions and a profile folder made for this run. Edge copies
//   the machine's registered extensions into a new profile, and a real wallet extension that loads
//   before the stand-in wallet takes window.phantom.
// - The browser is closed through its own DevTools port (Browser.close). child.kill() does not do
//   it: the process node spawns hands over to another msedge.exe and exits at once, so the browser
//   would live on. Nothing is ever stopped by name.
// - Edge picks its own DevTools port (--remote-debugging-port=0) and writes it into the profile
//   folder of this run (the file DevToolsActivePort). The tool reads the port from there, so it
//   can never drive or close a browser that belongs to someone else, however many are open.
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const EDGE_PATH = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Start a headless Edge. `name` goes into the profile folder's name. Returns
/// { port, profile, page(), close() }. page() is the DevTools target of the browser's blank page.
export async function startEdge({ name = "review", width = 1440, height = 1000, args = [] } = {}) {
  const profile = path.join(process.env.TEMP || os.tmpdir(), "programmable-" + name + "-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  const child = spawn(EDGE_PATH, [
    "--headless=new", "--disable-extensions", "--no-first-run", "--disable-gpu", "--hide-scrollbars",
    "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=" + width + "," + height, ...args,
    "about:blank",
  ], { stdio: "ignore" });
  child.on("error", () => {});
  let port = 0, browserPath = "", mine = null;
  for (let i = 0; i < 100 && !mine; i++) {
    try {
      const lines = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/);
      port = Number(lines[0]); browserPath = lines[1] || "";
      const v = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
      // the socket the port answers with is the one this profile folder names
      if (browserPath && String(v.webSocketDebuggerUrl).endsWith(browserPath)) {
        const pages = (await (await fetch("http://127.0.0.1:" + port + "/json")).json()).filter((x) => x.type === "page");
        // a new profile also opens Edge's own sign-in dialog; the tool's page is the blank one
        mine = pages.find((p) => p.url === "about:blank") || null;
      }
    } catch (_) {}
    if (!mine) await sleep(200);
  }
  if (!mine) throw new Error("Edge did not report a DevTools port in the profile of this run (" + profile + ").");
  let closed = false;

  /// Close this browser, and nothing else. Returns one line that says what happened.
  async function close() {
    if (closed) return "the Edge of this run was closed already";
    closed = true;
    let pids = [];
    try {
      const b = new WebSocket("ws://127.0.0.1:" + port + browserPath);
      await new Promise((r, j) => { b.onopen = r; b.onerror = j; });
      const ask = (n, method) => new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 3000);
        b.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id === n) { clearTimeout(t); resolve(d.result || null); } });
        b.send(JSON.stringify({ id: n, method }));
      });
      // the process ids the browser reports for itself: only these may be ended below
      const info = await ask(1, "SystemInfo.getProcessInfo");
      pids = ((info && info.processInfo) || []).map((p) => p.id);
      await ask(2, "Browser.close");
    } catch (_) {}
    const answers = async () => { try { await fetch("http://127.0.0.1:" + port + "/json/version"); return true; } catch (_) { return false; } };
    for (let i = 0; i < 25 && (await answers()); i++) await sleep(200);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
    await sleep(500);
    // whatever is left of this browser's own processes, by the ids it gave: never by name
    const left = pids.filter(alive);
    for (const pid of left) { try { process.kill(pid); } catch (_) {} }
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    return "closed the Edge this run started (DevTools port " + port + "): " + pids.length + " processes of its own, " + left.length + " had to be ended by their ids, the port " + ((await answers()) ? "STILL answers" : "is gone");
  }

  return { port, profile, page: async () => mine, close };
}
