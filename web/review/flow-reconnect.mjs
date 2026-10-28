// A wallet that the browser reconnects on its own after a reload must show its balances at once.
// The stand-in Phantom here remembers the site (localStorage) and answers the silent reconnect
// ({ onlyIfTrusted: true }) after a delay: once during the page's own first reads, once after
// them. Each time the trade card must show "Balance ..." within a few seconds, not at the next
// timed refresh of the pool. Then the same on the liquidity page.
//   node web/review/flow-reconnect.mjs <site origin> <pool address>
import { startEdge } from "./edge.mjs";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

// <pool> for the coin page (any pool); <liquidity pool> for the liquidity page: a pool whose
// liquidity is open (seeded, or graduated), since a pool on the curve shows no wallet amounts there
const [origin, pool, liqPool = pool] = process.argv.slice(2);
if (!origin || !pool) { console.error("usage: node web/review/flow-reconnect.mjs <site origin> <pool address> [<liquidity pool>]"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, failed = 0;
const check = (ok, what) => { checks++; if (!ok) failed++; console.log((ok ? "  ok    " : "  FAIL  ") + what); };

// a throwaway wallet with SOL on the local chain
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const kp = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");

const script = (delayMs) => `
  (() => {
    localStorage.setItem("Programmable.wallet", "phantom");
    const ADDRESS = ${JSON.stringify(kp.publicKey.toBase58())};
    const publicKey = { toBase58: () => ADDRESS };
    window.__reconnectedAt = 0;
    const w = { isPhantom: true, publicKey: null, on() {}, disconnect: async () => {},
      connect: async (opts) => {
        if (opts && opts.onlyIfTrusted) await new Promise((r) => setTimeout(r, ${delayMs}));
        w.publicKey = publicKey; window.__reconnectedAt = Date.now();
        return { publicKey };
      },
      signTransaction: async () => { throw new Error("not in this test"); } };
    window.phantom = { solana: w };
  })();`;

const edge = await startEdge({ name: "reconnect", width: 1280, height: 900 });
try {
  const ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waits = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } };
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => ((await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result || {}).result?.value;
  await call("Page.enable"); await call("Runtime.enable");
  for (const [page, sel, label] of [["/coin.html?pool=" + pool, ".trade .balance, .balance", "coin page"], ["/pool.html?pool=" + liqPool, "body", "liquidity page"]]) {
    for (const delay of [300, 4000]) {
      const { identifier } = await call("Page.addScriptToEvaluateOnNewDocument", { source: script(delay) });
      await call("Page.navigate", { url: origin + page });
      // wait until the wallet reconnected, then give the page 4 seconds to show the balance
      let at = 0;
      for (let i = 0; i < 150 && !at; i++) { await sleep(100); at = await ev("window.__reconnectedAt || 0"); }
      let shown = false, text = "";
      for (let i = 0; i < 40 && !shown; i++) {
        await sleep(100);
        text = await ev(label === "coin page"
          ? "[...document.querySelectorAll('.balance')].map((e) => e.textContent).join(' | ')"
          : "document.body.innerText");
        // the liquidity page: "Wallet SOL" followed by the wallet's 2 SOL (1.9xxx after fees)
        shown = label === "coin page" ? /Balance\s+[1-9]/.test(text || "") : /Wallet SOL\s*(1\.9|2)/.test(text || "");
      }
      check(at > 0 && shown, label + ", the wallet reconnects " + (delay < 1000 ? "during the first reads" : "after the page is ready") + " (" + delay + " ms): its balance shows within 4 seconds" + (shown ? "" : " (saw: " + String(text).replace(/\s+/g, " ").slice(0, 120) + ")"));
      await call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
  }
  ws.close();
} finally {
  console.log(await edge.close());
}
console.log(checks + " checks, " + (checks - failed) + " ok, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
