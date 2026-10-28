import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSend, markSent, pruneLastSent, dedupeKey, formatAlert, explorerLink, createNotifier } from "../lib/telegram.mjs";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test("explorer link omits the cluster on mainnet only", () => {
  assert.equal(explorerLink("Pool111", "mainnet"), "https://solscan.io/account/Pool111");
  assert.equal(explorerLink("Pool111", "devnet"), "https://solscan.io/account/Pool111?cluster=devnet");
});

test("alert text is ASCII, names the coin, the pool and the link", () => {
  const t = formatAlert({ level: "danger", cluster: "localnet", symbol: "HTC", pool: "Pool111", message: `sells fail ${String.fromCharCode(0x2192)} bad` });
  assert.equal(t.split("\n")[0], "[DANGER] Programmable watcher (localnet)");
  assert.ok(t.includes("HTC pool Pool111"));
  assert.ok(t.includes("sells fail ? bad"));
  assert.ok(t.endsWith("https://solscan.io/account/Pool111?cluster=localnet"));
  assert.ok(/^[\x20-\x7e\n]*$/.test(t));
  const p = formatAlert({ level: "warning", cluster: "mainnet", pool: null, message: "paused changed from false to true" });
  assert.ok(p.includes("platform: paused changed"));
});

test("dedupe: same pool and message muted inside the cooldown, free after it, clock jumps tolerated", () => {
  const last = {};
  const k = dedupeKey("Pool111", "sells started failing");
  assert.equal(shouldSend(last, k, 1000, 3600), true);
  markSent(last, k, 1000);
  assert.equal(shouldSend(last, k, 1000 + 3599, 3600), false);
  assert.equal(shouldSend(last, k, 1000 + 3600, 3600), true);
  assert.equal(shouldSend(last, dedupeKey("Pool222", "sells started failing"), 1001, 3600), true);
  assert.equal(shouldSend(last, dedupeKey("Pool111", "another text"), 1001, 3600), true);
  markSent(last, "future", 999_999);
  assert.equal(shouldSend(last, "future", 5000, 3600), true);
  pruneLastSent(last, 1000 + 3600, 3600);
  assert.deepEqual(Object.keys(last), []);
});

test("notifier sends once, mutes the repeat, sends again after the cooldown, and never fetches without a token", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  let now = 1_000_000_000_000;
  const state = { telegram: { lastSent: {} } };
  const cfg = { cluster: "devnet", telegramToken: "123:abc", telegramChatId: "42", alertCooldownSeconds: 3600 };
  const n = createNotifier({ cfg, state, log: quiet, fetchImpl, now: () => now });
  assert.equal(await n.alert({ pool: "Pool111", symbol: "HTC", level: "danger", message: "sells started failing" }), true);
  assert.equal(await n.alert({ pool: "Pool111", symbol: "HTC", level: "danger", message: "sells started failing" }), false);
  now += 3600 * 1000;
  assert.equal(await n.alert({ pool: "Pool111", symbol: "HTC", level: "danger", message: "sells started failing" }), true);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.startsWith("https://api.telegram.org/bot123:abc/sendMessage"));
  assert.equal(calls[0].body.chat_id, "42");
  assert.ok(calls[0].body.text.includes("HTC pool Pool111"));
  const silent = createNotifier({ cfg: { ...cfg, telegramToken: "", telegramChatId: "" }, state: { telegram: { lastSent: {} } }, log: quiet, fetchImpl, now: () => now });
  assert.equal(await silent.alert({ pool: "Pool111", level: "info", message: "hello" }), false);
  assert.equal(calls.length, 2);
});

test("a failing fetch never throws out of the notifier", async () => {
  const n = createNotifier({ cfg: { cluster: "devnet", telegramToken: "t", telegramChatId: "c", alertCooldownSeconds: 0 }, state: { telegram: { lastSent: {} } }, log: quiet, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(await n.alert({ pool: null, level: "warning", message: "x" }), false);
});
