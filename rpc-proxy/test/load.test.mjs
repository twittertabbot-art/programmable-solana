// The load check the brief asks for: 500 requests inside a minute from one address must hit the
// limit, and traffic from another address must keep answering all the while.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startAll, call, sleep } from "./helpers.mjs";

test("500 requests from one address: the burst passes, the rest get 429; another address answers every time", async () => {
  const t = await startAll();
  try {
    const flood = { "x-forwarded-for": "203.0.113.50" }, site = { "x-forwarded-for": "203.0.113.51" };
    let ok = 0, refused = 0, other = 0;
    const siteResults = [];
    // the site's own reads, one every 100 ms, while the flood runs
    const siteRun = (async () => { for (let i = 0; i < 40; i++) { siteResults.push((await t.rpc(call("s" + i, "getSlot"), site)).status); await sleep(100); } })();
    const t0 = Date.now();
    const batch = async (from, to) => { for (let i = from; i < to; i++) { const r = await t.rpc(call(i, "getSlot"), flood); if (r.status === 200) ok++; else if (r.status === 429) refused++; else other++; } };
    await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => batch(k * 50, k * 50 + 50)));
    const took = Date.now() - t0;
    await siteRun;
    assert.ok(took < 60_000, "500 requests went in " + took + " ms");
    assert.equal(other, 0);
    // 120 at once, then one a second while the flood lasts
    assert.ok(ok >= 120 && ok <= 120 + Math.ceil(took / 1000) + 1, "the burst passed: " + ok + " ok in " + took + " ms");
    assert.ok(refused >= 500 - ok - 1 && refused <= 500 - 120, "the rest was refused: " + refused);
    assert.equal(siteResults.length, 40);
    assert.ok(siteResults.every((s) => s === 200), "the other address was answered every time: " + siteResults.join(","));
    const h = await t.health();
    assert.equal(h.refused.rate, refused);
    assert.equal(h.requests.http, 540);
    assert.equal(t.fake.calls.length, ok + 40, "the upstream only saw what passed");
  } finally { await t.close(); }
});
