// One event per line, time first, plain ASCII, and never the upstream address: every line goes
// through redact() first, which replaces the address and its key wherever they appear.
export function ascii(s) { return String(s).replace(/[^\x20-\x7e\n]/g, "?"); }

function fmt(x) {
  if (typeof x === "string") return x;
  if (typeof x === "bigint") return x.toString();
  if (x instanceof Error) return x.message + (x.cause && x.cause.message ? " (" + x.cause.message + ")" : "");
  try { return JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)); } catch (_) { return String(x); }
}

/// A logger whose lines never carry the strings in `secrets` (the upstream address, its key).
/// `sink` takes (level, line); the default writes to stdout and stderr like the watcher.
export function createLogger(secrets = [], sink = null) {
  const list = [...secrets].filter((s) => typeof s === "string" && s.length > 0).sort((a, b) => b.length - a.length);
  const redact = (text) => {
    let s = String(text);
    for (const sec of list) s = s.split(sec).join("<upstream>");
    return s;
  };
  const write = sink || ((level, text) => { if (level === "error" || level === "warn") console.error(text); else console.log(text); });
  const line = (level, args) => write(level, ascii(redact(new Date().toISOString() + " " + level.padEnd(5) + " " + args.map(fmt).join(" "))));
  return {
    redact,
    info: (...a) => line("info", a),
    warn: (...a) => line("warn", a),
    error: (...a) => line("error", a),
  };
}
