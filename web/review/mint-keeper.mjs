// Review helper: a watcher that runs the trades feed, the reveal crank and the mint crank, for the flows whose buys
// pay the deposit for their NFTs (one approval: the keeper mints them into the buyer's wallet a few seconds later).
// It runs watcher/index.mjs against the local validator, with its state, its status file, its feed files, its
// ticket index and a new keeper key in a temporary folder, and its HTTP on a free port. The feed runs every 2 s
// here: that is how the mint crank learns of a buy (every buy is a transaction of the pool program the feed
// reads), as on the live watcher; its own poll of the collectible program stays at the default, a safety net once
// a minute. POST /notify is on (NOTIFY=on, whatever the environment says), so a coin page pointed at this watcher
// (`url`, for ?watcher=) covers the page's notify path too: the signature's status first, the transaction only for
// a signature the chain knows. Its feed lock lives in the same temporary folder (LOCK_DIR), never next to another
// watcher's files. stop() ends that one process, by its own id, and removes the folder. The keeper key is read for
// its public address only and never printed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const WATCHER_DIR = fileURLToPath(new URL("../../watcher/", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
export const getJson = (url) => new Promise((resolve) => {
  const req = http.get(url, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on("error", () => resolve(null)); req.setTimeout(3000, () => { req.destroy(); resolve(null); });
});

/// Start it and wait for its first mint pass (and its first feed pass). Answers { pid, port, url, keeper, lines,
/// health(), stop() }; `ok` is false when it did not come up within a minute, or came up without the feed or the
/// notify route (then it is stopped already).
/// `feedIntervalSeconds` is the feed's clock (2 s: a buy reaches the mint crank within about that long).
export async function startMintKeeper({ rpc = "http://127.0.0.1:8899", feedIntervalSeconds = 2 } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mint-keeper-"));
  const port = await freePort();
  const lines = [];
  const child = spawn(process.execPath, ["index.mjs", "--no-settle", "--no-upkeep", "--no-burn", "--no-graduate"], {
    cwd: WATCHER_DIR, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, RPC_URL: rpc, CLUSTER: "localnet", PORT: String(port), INTERVAL_SECONDS: "3600", MINT_CRANK: "on",
      FEED: "on", FEED_INTERVAL_SECONDS: String(feedIntervalSeconds), NOTIFY: "on",
      STATE_FILE: path.join(tmp, "state.json"), STATUS_FILE: path.join(tmp, "pools.json"), PROBE_KEYPAIR: path.join(tmp, "keeper.json"),
      MARKET_FILE: path.join(tmp, "market.json"), TRADES_DIR: path.join(tmp, "trades"), FEED_STATE_FILE: path.join(tmp, "feed.json"), MARKET_CACHE_FILE: path.join(tmp, "market-cache.json"),
      TICKET_INDEX_FILE: path.join(tmp, "tickets.json"), LOCK_DIR: tmp,
    },
  });
  for (const s of [child.stdout, child.stderr]) s.on("data", (b) => { for (const l of String(b).split("\n")) if (l.trim()) lines.push(l); });
  const health = () => getJson("http://127.0.0.1:" + port + "/health");
  const stop = async () => {
    if (child.exitCode === null) {
      const done = new Promise((r) => child.once("exit", r));
      child.kill();
      await Promise.race([done, sleep(5000)]);
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* left for the system */ }
  };
  let h = null;
  const up = (x) => !!(x && x.lastMintAt && x.lastFeedAt);
  for (let i = 0; i < 120 && !up(h) && child.exitCode === null; i++) { h = await health(); if (!up(h)) await sleep(500); }
  const ok = !!(h && h.mintCrankEnabled && h.feedEnabled && h.notifyEnabled && up(h));
  let keeper = null;
  try { keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.join(tmp, "keeper.json"), "utf8")))).publicKey; } catch (_) { keeper = null; }
  if (!ok) await stop();
  return { ok, pid: child.pid, port, url: "http://127.0.0.1:" + port, keeper, lines, health, stop };
}
