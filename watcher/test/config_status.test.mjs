import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv, parseArgs, buildConfig } from "../lib/config.mjs";
import { poolEntry, buildStatus, writeStatusAtomic, summaryTable } from "../lib/status.mjs";
import { loadState, saveState, emptyState, trimList } from "../lib/state.mjs";

test("parseEnv handles comments, quotes and blank values", () => {
  const v = parseEnv('# c\nRPC_URL=http://x:1 # trailing\nCLUSTER="devnet"\nEMPTY=\nQUOTED=\'a b\'\nBAD LINE\n=nokey\n');
  assert.deepEqual(v, { RPC_URL: "http://x:1", CLUSTER: "devnet", EMPTY: "", QUOTED: "a b" });
});

test("buildConfig defaults, overrides and validation", () => {
  const c = buildConfig({}, parseArgs([]), "/w");
  assert.equal(c.cluster, "localnet"); assert.equal(c.rpcUrl, "http://127.0.0.1:8899"); assert.equal(c.intervalSeconds, 60);
  assert.equal(c.probeLamports, 50_000_000n); assert.equal(c.port, 8790); assert.equal(c.alertCooldownSeconds, 3600);
  assert.equal(c.statusFile, path.join("/w", "status/pools.json")); assert.equal(c.noServer, false);
  const d = buildConfig({ CLUSTER: "mainnet-beta", PROBE_SOL: "0.1", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" }, parseArgs(["--once", "--pool", "Abc"]), "/w");
  assert.equal(d.cluster, "mainnet"); assert.equal(d.rpcUrl, "https://api.mainnet-beta.solana.com"); assert.equal(d.probeLamports, 100_000_000n);
  assert.equal(d.once, true); assert.equal(d.pool, "Abc"); assert.equal(d.verbose, true); assert.equal(d.noServer, true);
  assert.throws(() => buildConfig({ INTERVAL_SECONDS: "abc" }, parseArgs([])), /not a number/);
  assert.throws(() => buildConfig({ INTERVAL_SECONDS: "1" }, parseArgs([])), /below the minimum/);
  assert.throws(() => buildConfig({ CLUSTER: "testnet" }, parseArgs([])), /CLUSTER/);
  assert.throws(() => buildConfig({ TELEGRAM_BOT_TOKEN: "t" }, parseArgs([])), /together/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});

test("poolEntry forces the exact schema", () => {
  const e = poolEntry({ lastCheck: "t", score: "danger", hookKind: "platform", template: "tax", buySim: { ok: true, error: null, amountOut: 123n, stage: null }, sellSim: { ok: false, error: "swap: x", amountOut: null, holder: "H", logs: [] }, effectiveBuyTaxBps: 300, effectiveSellTaxBps: null, declared: { buyBps: 300, minQuote: 5n }, configChanges: [{ time: "t", slot: 7n, field: "buyBps", from: 1, to: 2 }], alerts: [{ time: "t", level: "weird", message: "m" }], notes: ["n"], extra: 1 });
  assert.deepEqual(Object.keys(e), ["lastCheck", "score", "hookKind", "template", "buySim", "sellSim", "effectiveBuyTaxBps", "effectiveSellTaxBps", "declared", "configChanges", "alerts", "notes"]);
  assert.deepEqual(e.buySim, { ok: true, error: null, amountOut: "123" });
  assert.deepEqual(e.sellSim, { ok: false, error: "swap: x", amountOut: null, holder: "H" });
  assert.deepEqual(e.declared, { buyBps: 300, minQuote: "5" });
  assert.deepEqual(e.configChanges, [{ time: "t", slot: 7, field: "buyBps", from: "1", to: "2" }]);
  assert.equal(e.alerts[0].level, "info");
  assert.equal(poolEntry({ score: "nonsense" }).score, "warning");
  assert.equal(poolEntry({}).buySim.error, "not simulated");
});

test("buildStatus, atomic write and the summary table", () => {
  const platform = { paused: false, whitelist: ["W1"], protocolFeeBps: 20, maxHookFeeBps: 1000, maxFeeOverrideBps: 5000, treasury: "T", admin: "A" };
  const st = buildStatus({ updatedAt: "2026-10-01T00:00:00.000Z", cluster: "localnet", platform, platformChanges: [{ time: "t", field: "paused", from: "false", to: "true" }], pools: { P1: { lastCheck: "t", score: "clean", hookKind: "none", template: "none", buySim: { ok: true, amountOut: 5n }, sellSim: { ok: true, amountOut: 6n, holder: "H" } } } });
  assert.deepEqual(Object.keys(st.platform), ["paused", "whitelist", "protocolFeeBps", "maxHookFeeBps", "maxFeeOverrideBps", "treasury", "admin", "changes"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programmable-watcher-"));
  const file = path.join(dir, "status", "pools.json");
  writeStatusAtomic(file, st);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), st);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  const table = summaryTable(st, { P1: "HTC" });
  assert.ok(table.includes("P1") && table.includes("HTC") && table.includes("1 pools: 1 clean, 0 warning, 0 danger"));
  assert.ok(/^[\x20-\x7e\n]*$/.test(table));
  const sfile = path.join(dir, "state", "state.json");
  const s = emptyState(); s.pools.P1 = { firstSeen: "t" };
  saveState(sfile, s);
  assert.deepEqual(loadState(sfile), s);
  fs.writeFileSync(sfile, "{not json");
  assert.deepEqual(loadState(sfile).pools, {});
  assert.equal(trimList([1, 2, 3, 4], 2).join(), "3,4");
  fs.rmSync(dir, { recursive: true, force: true });
});
