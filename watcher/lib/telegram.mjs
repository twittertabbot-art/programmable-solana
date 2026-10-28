// Alerts: always the log, Telegram too when a token and chat id are configured. One message per alert, the same
// pool + text not repeated within the cooldown. Plain ASCII, no markdown.
import { ascii } from "./log.mjs";

export function explorerLink(address, cluster) {
  return cluster === "mainnet" ? `https://solscan.io/account/${address}` : `https://solscan.io/account/${address}?cluster=${cluster}`;
}

export function formatAlert({ level, cluster, symbol, pool, message }) {
  const lines = [`[${String(level).toUpperCase()}] Programmable watcher (${cluster})`];
  if (pool) {
    lines.push(`${symbol ? `${symbol} ` : ""}pool ${pool}`);
    lines.push(String(message));
    lines.push(explorerLink(pool, cluster));
  } else {
    lines.push(`platform: ${message}`);
  }
  return ascii(lines.join("\n"));
}

export function dedupeKey(pool, message) { return `${pool ?? "platform"}|${message}`; }

/// lastSent: { key: unix seconds }. A stamp in the future (clock corrected backwards) counts as never sent.
export function shouldSend(lastSent, key, nowSec, cooldownSec) {
  const last = lastSent[key];
  if (last === undefined) return true;
  if (last > nowSec) return true;
  return nowSec - last >= cooldownSec;
}

export function markSent(lastSent, key, nowSec) { lastSent[key] = nowSec; return lastSent; }

export function pruneLastSent(lastSent, nowSec, cooldownSec) {
  for (const [k, t] of Object.entries(lastSent)) if (nowSec - t >= cooldownSec || t > nowSec) delete lastSent[k];
  return lastSent;
}

/// The request has a timeout on purpose: fetch has none, and a server whose way out is blackholed hangs
/// instead of refusing, which would freeze the whole pass.
export async function sendTelegram(token, chatId, text, fetchImpl = globalThis.fetch, timeoutMs = 10000) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return !!res.ok;
}

export function createNotifier({ cfg, state, log, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  if (!state.telegram) state.telegram = { lastSent: {} };
  if (!state.telegram.lastSent) state.telegram.lastSent = {};
  return {
    /// Returns true when a Telegram message went out, false when muted, logged only, or refused.
    async alert({ pool = null, symbol = null, level, message }) {
      const nowSec = Math.floor(now() / 1000);
      const key = dedupeKey(pool, message);
      const text = formatAlert({ level, cluster: cfg.cluster, symbol, pool, message });
      if (!shouldSend(state.telegram.lastSent, key, nowSec, cfg.alertCooldownSeconds)) {
        log.debug("alert muted by the cooldown:", key);
        return false;
      }
      markSent(state.telegram.lastSent, key, nowSec);
      pruneLastSent(state.telegram.lastSent, nowSec, cfg.alertCooldownSeconds);
      const say = level === "danger" ? log.error : level === "warning" ? log.warn : log.info;
      say("ALERT", text.replace(/\n/g, " | "));
      if (!cfg.telegramToken || !cfg.telegramChatId) return false;
      try {
        const ok = await sendTelegram(cfg.telegramToken, cfg.telegramChatId, text, fetchImpl);
        if (!ok) log.warn("telegram refused the alert");
        return ok;
      } catch (e) {
        log.warn("telegram send failed:", e && e.message ? e.message : String(e));
        return false;
      }
    },
  };
}
