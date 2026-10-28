// One event per line, time first, plain ASCII. Anything that is not keyboard ASCII becomes "?".
let verbose = false;
export function setVerbose(v) { verbose = !!v; }

export function ascii(s) { return String(s).replace(/[^\x20-\x7e\n]/g, "?"); }

function fmt(x) {
  if (typeof x === "string") return x;
  if (typeof x === "bigint") return x.toString();
  if (x instanceof Error) return x.message;
  try { return JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)); } catch { return String(x); }
}

function line(level, args) {
  const text = `${new Date().toISOString()} ${level.padEnd(5)} ${ascii(args.map(fmt).join(" "))}`;
  if (level === "error" || level === "warn") console.error(text); else console.log(text);
}

export const log = {
  info: (...a) => line("info", a),
  warn: (...a) => line("warn", a),
  error: (...a) => line("error", a),
  debug: (...a) => { if (verbose) line("debug", a); },
};
