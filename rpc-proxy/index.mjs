#!/usr/bin/env node
// Programmable RPC proxy. Start here.
//
//   UPSTREAM_RPC=https://<provider>/<key> node index.mjs
//
// The site's pages read the chain through this process instead of through the provider directly,
// so the provider's key never reaches a browser. It takes POST JSON-RPC at / (and /rpc), the
// WebSocket upgrade at the same path, and answers GET /health with its counters. Only the methods
// the site uses pass; every client address has a budget of requests a minute; the whole proxy has
// one too. README.md has the server setup.
//
// Configuration: the environment. On a server systemd passes /etc/programmable/rpc.env
// (programmable-rpc.service); for a run by hand a file named .env next to this one is read too,
// for the keys the environment does not set. .env.example lists every setting.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, describeConfig } from "./lib/config.mjs";
import { createLogger } from "./lib/log.mjs";
import { startProxy } from "./lib/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/// KEY=VALUE lines into process.env, for keys not set yet. Values are never printed.
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return 0; }
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    if (process.env[key] === undefined) { process.env[key] = value; n++; }
  }
  return n;
}

const envArg = process.argv.indexOf("--env");
loadEnvFile(envArg >= 0 && process.argv[envArg + 1] ? path.resolve(process.argv[envArg + 1]) : path.join(HERE, ".env"));

let cfg;
try { cfg = loadConfig(process.env); } catch (e) { console.error("programmable-rpc: " + e.message); process.exit(2); }
const log = createLogger(cfg.secrets);

let proxy;
try { proxy = await startProxy(cfg, { log }); } catch (e) { log.error("programmable-rpc could not start: " + (e && (e.code === "EADDRINUSE" ? "port " + cfg.port + " is taken" : e.message))); process.exit(1); }
log.info("programmable-rpc: " + describeConfig(cfg) + ", process " + process.pid);

let stopping = false;
const stop = (why) => {
  if (stopping) return;
  stopping = true;
  log.info("programmable-rpc: stopping (" + why + "), " + proxy.counters.summary());
  proxy.close().then(() => process.exit(0), () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("uncaughtException", (e) => log.error("uncaught: " + (e && e.stack || e)));
process.on("unhandledRejection", (e) => log.error("unhandled: " + (e && e.stack || e)));
