// Round 9 review (R4): the watcher's HTTP server against hostile request targets, and the metadata fetcher's
// private-host guard. A test named BUG asserts the behaviour the watcher SHOULD have and fails until it is fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, tradesPathPool } from "../lib/server.mjs";
import { privateHost, metadataUrl, fetchMetadataJson } from "../lib/market.mjs";

const quiet = { info: () => {}, error: () => {} };
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
/// A raw request line, so that the target can be anything Node's parser lets through (an absolute-form URI).
function raw(port, line) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`${line} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let out = "";
    s.on("data", (d) => { out += d; });
    s.on("close", () => resolve(out.split("\r\n")[0] || "(no answer)"));
    s.on("error", () => resolve("(socket error)"));
    setTimeout(() => { s.destroy(); resolve(out.split("\r\n")[0] || "(no answer)"); }, 1500);
  });
}

test("BUG: a request whose absolute-form target is not a URL must get a 400, not throw out of the handler (the process would exit)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r9-server-"));
  const statusFile = path.join(dir, "pools.json");
  fs.writeFileSync(statusFile, JSON.stringify({ updatedAt: new Date().toISOString(), cluster: "localnet", platform: {}, pools: {} }));
  const port = await freePort();
  const server = startServer({ port, host: "127.0.0.1", statusFile, marketFile: null, tradesDir: null, cluster: "localnet", getStatus: () => null, staleAfterMs: 1000, log: quiet });
  const thrown = [];
  const onUncaught = (e) => thrown.push(e);
  process.on("uncaughtException", onUncaught);
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await raw(port, "GET /pools.json"), "HTTP/1.1 200 OK", "a normal request works");
    for (const target of ["GET http://[::1/health", "GET http://[::1]:x/health", "GET http://%/health"]) {
      const answer = await raw(port, target);
      assert.ok(/^HTTP\/1\.1 400\b/.test(answer), `${target}: expected a 400, got ${answer}`);
    }
    assert.equal(thrown.length, 0, `the handler threw ${thrown.length} uncaught exception(s): ${thrown.map((e) => e.message).join("; ")}`);
    assert.equal(await raw(port, "GET /health"), "HTTP/1.1 503 Service Unavailable", "the server still answers afterwards");
  } finally {
    process.off("uncaughtException", onUncaught);
    server.close();
  }
});

test("the trades route takes a base58 pool only: traversal and encoded slashes are refused", () => {
  assert.equal(tradesPathPool("/trades/../../etc/passwd"), null);
  assert.equal(tradesPathPool("/trades/x%2F..%2F..%2Fetc%2Fpasswd.json"), null);
  assert.equal(tradesPathPool("/trades/2hMdoq9N3Eym2xcLDFTLF1NFW4PM5M78hZSD2JoUAwjZ.json"), "2hMdoq9N3Eym2xcLDFTLF1NFW4PM5M78hZSD2JoUAwjZ");
  assert.equal(tradesPathPool("/trades/2hMdoq9N3Eym2xcLDFTLF1NFW4PM5M78hZSD2JoUAwjZ.json.bak"), null);
});

test("BUG: the private-host guard judges names as written, so a public name that resolves to a private address passes", () => {
  // These names resolve to 127.0.0.1 on the public DNS (nip.io, localtest.me); an attacker's own name can point at
  // 169.254.169.254 or 10.x just as well. On mainnet (allowPrivate false) the watcher fetches them.
  for (const name of ["127.0.0.1.nip.io", "localtest.me", "169.254.169.254.nip.io", "10.0.0.1.nip.io"]) {
    assert.equal(privateHost(name), true, `${name} should count as private (it names a private address)`);
    assert.equal(metadataUrl(`http://${name}/x.json`), null, `${name} should not be fetched`);
  }
});

test("the private-host guard refuses what it knows: literal private addresses, localhost names, IPv4-mapped IPv6", () => {
  for (const h of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "localhost", "a.localhost", "metadata.google.internal", "::1", "[::ffff:127.0.0.1]", "fd00::1", "fe80::1"]) {
    assert.equal(privateHost(h), true, h);
  }
  assert.equal(privateHost("example.com"), false);
  assert.equal(metadataUrl("ftp://example.com/x"), null);
  assert.equal(metadataUrl("http://user:pw@example.com/x"), null);
});

test("the metadata fetch follows a redirect only to an allowed host, and reads at most the size limit", async () => {
  const calls = [];
  const fetchImpl = async (href) => {
    calls.push(href);
    if (href === "https://a.example/x.json") return { status: 302, ok: false, headers: new Map([["location", "http://127.0.0.1/secret"]]) };
    return { status: 200, ok: true, headers: new Map([["content-length", "0"]]), body: null, text: async () => JSON.stringify({ image: "https://a.example/i.png" }) };
  };
  const r = await fetchMetadataJson("https://a.example/x.json", { fetchImpl, allowPrivate: false });
  assert.equal(r.status, "invalid", "a redirect to a private address is not followed");
  assert.deepEqual(calls, ["https://a.example/x.json"]);
  const big = await fetchMetadataJson("https://b.example/x.json", { fetchImpl: async () => ({ status: 200, ok: true, headers: new Map([["content-length", "999999999"]]) }), allowPrivate: false });
  assert.equal(big.status, "unreachable");
});
