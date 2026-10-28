// Round 12 review (V1): the proxy started the way the service starts it (node --max-old-space-size=96
// index.mjs; the unit adds MemoryMax=150M) against a stand-in upstream that answers with a big body.
// A test named BUG asserts the behaviour the proxy SHOULD have and fails until it is fixed; a test
// named SOUND passes today and guards what works.
//
// What a big answer is on the real chain: getMultipleAccounts accepts the same key many times, and a
// program's data account is 0.5 to 0.8 MB (the hookpool program's is 833 KB of base64 on the local
// chain). 50 copies of it are a 40 MB answer to ONE item; it costs one token.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { freePort, sleep, call } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "..", "index.mjs");
const MB = 1048576;

/// An upstream that answers every POST with one batch answer whose first result holds `mb` megabytes.
async function bigUpstream(mb) {
  const filler = Buffer.alloc(mb * MB, 0x41); // "AAAA...", like base64 account data
  const head = Buffer.from('[{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":[{"data":["');
  const tail = Buffer.from('","base64"],"executable":false,"lamports":1,"owner":"11111111111111111111111111111111","rentEpoch":0,"space":1}]}}]');
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "content-length": head.length + filler.length + tail.length });
      res.write(head);
      // in 1 MB pieces, the way a socket delivers it
      let i = 0;
      const more = () => { while (i < filler.length) { const ok = res.write(filler.subarray(i, i + MB)); i += MB; if (!ok) return res.once("drain", more); } res.end(tail); };
      more();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: "http://127.0.0.1:" + server.address().port, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }) };
}

/// The peak resident memory of a process, in MB (Windows: PeakWorkingSet64; Linux: VmHWM).
function peakMb(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-Process -Id " + pid + ").PeakWorkingSet64"], { encoding: "utf8" });
      return Math.round(Number(out.trim()) / MB);
    }
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync("/proc/" + pid + "/status", "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : NaN;
  } catch (_) { return NaN; }
}

/// Start index.mjs as the unit does, against `upstream`. Returns { port, child, exited, output(), stop() }.
async function startService(upstream, extra = {}) {
  const port = await freePort();
  const env = { ...process.env, UPSTREAM_RPC: upstream + "/KEYKEYKEYKEY1234", PORT: String(port), SUMMARY_EVERY_SECONDS: "0", ...extra };
  const child = spawn(process.execPath, ["--max-old-space-size=96", INDEX, "--env", path.join(HERE, "no-such-env-file")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  let exitCode = null;
  const exited = new Promise((r) => child.on("exit", (code, sig) => { exitCode = code === null ? sig : code; r(exitCode); }));
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch("http://127.0.0.1:" + port + "/health"); if (r.ok) break; } catch (_) {}
    await sleep(100);
  }
  return { port, child, exited, exitCode: () => exitCode, output: () => out, stop: async () => { if (exitCode === null) { child.kill(); await exited; } } };
}

async function post(port, body) {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, bytes: text.length };
  } catch (e) { return { status: 0, error: String(e && e.cause ? e.cause.code || e.cause.message : e) }; }
}

test("FIXED (round 14): a 45 MB answer is refused cleanly at the default answer cap (8 MB): a JSON-RPC error, nothing of it sent, the process small and alive (it used to stream through for one token)", async () => {
  const up = await bigUpstream(45);
  const svc = await startService(up.origin);
  try {
    const res = await fetch("http://127.0.0.1:" + svc.port + "/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([call(1, "getMultipleAccounts", [["x"], { encoding: "base64" }])]) });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body[0].id, 1);
    assert.equal(body[0].error.code, -32000);
    assert.match(body[0].error.message, /over 8388608 bytes/);
    await sleep(200);
    assert.equal(svc.exitCode(), null, "still running");
    const peak = peakMb(svc.child.pid);
    console.log("refused 45 MB: peak memory " + peak + " MB");
    assert.ok(!(peak > 150), "peak " + peak + " MB stays under MemoryMax=150M");
  } finally { await svc.stop(); await up.close(); }
});

test("SOUND: with the cap and the byte budget raised to 64 MB, a 45 MB answer to a batch with nothing refused streams through; the process stays small and alive", async () => {
  const up = await bigUpstream(45);
  const svc = await startService(up.origin, { MAX_ANSWER_BYTES: String(64 * MB), BYTES_PER_MINUTE: String(64 * MB) });
  try {
    const r = await post(svc.port, [call(1, "getMultipleAccounts", [["x"], { encoding: "base64" }])]);
    assert.equal(r.status, 200);
    assert.ok(r.bytes > 45 * MB, "the whole answer came through");
    await sleep(200);
    assert.equal(svc.exitCode(), null, "still running");
    const peak = peakMb(svc.child.pid);
    console.log("streamed 45 MB: peak memory " + peak + " MB");
    assert.ok(!(peak > 150), "peak " + peak + " MB stays under MemoryMax=150M");
  } finally { await svc.stop(); await up.close(); }
});

test("BUG: one batch with a refused item and a 45 MB answer must not take the proxy over its memory (the merge path reads, parses and re-serialises the whole answer)", async () => {
  const up = await bigUpstream(45);
  const svc = await startService(up.origin);
  try {
    // one item the allow-list refuses is enough to switch the answer to the merge path
    const r = await post(svc.port, [call(1, "getMultipleAccounts", [["x"], { encoding: "base64" }]), call(2, "getClusterNodes")]);
    await sleep(500);
    const alive = svc.exitCode() === null;
    const peak = alive ? peakMb(svc.child.pid) : NaN;
    const fatal = /heap out of memory|Reached heap limit|FATAL ERROR/i.test(svc.output());
    console.log("merge path, 45 MB: answer " + JSON.stringify(r) + ", process " + (alive ? "alive, peak " + peak + " MB" : "EXITED (" + svc.exitCode() + ")") + (fatal ? ", V8 heap out of memory" : ""));
    assert.ok(alive, "the process must survive (it exited with " + svc.exitCode() + (fatal ? ", V8 heap out of memory" : "") + ")");
    assert.ok(!(peak > 150), "peak " + peak + " MB must stay under MemoryMax=150M (the cgroup would kill it)");
  } finally { await svc.stop(); await up.close(); }
});
