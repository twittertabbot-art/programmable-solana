// Review tool: "Get your hook reviewed" end to end, in headless Edge with real mouse and keyboard
// input, against a stand-in of the review API (review-standin.mjs) that this run starts on a free
// port and closes at the end. The stand-in passes every other request to the site, so the pages
// are the site's own files. Wallets are throwaway keypairs made here (localnet only, airdropped,
// never written to disk). The fee is a real transfer with a memo on the local validator.
//   node web/review/flow-review.mjs <site origin> <out prefix> [parts]
//   node web/review/flow-review.mjs http://localhost:8787 web/review/r13-review
// P. the page: the mark, the ten rules, the costs with the live price, the six steps, the form;
//    1440 and 375 wide, no sideways scroll, plain ASCII words, no word the owner bans.
// F. the five fields are checked before anything is paid: no quote is asked and no wallet opens.
// Q. the price: down, moved between the line and the quote, and a wallet that refuses.
// R. a request goes through: one wallet prompt, a transfer and a memo on chain, NOT_CONFIRMED_YET
//    answered by asking again, the status view, the request in the list of this browser.
// X. a paid request the service did not take: the page keeps it, sends it again without a new
//    payment, and offers it again after a reload.
// S. the status view for every status; the program id form only for passed and checking; a bad
//    id, an upgradeable program, a wallet without signMessage and the wrong wallet are refused;
//    the right wallet signs and the request moves to checking.
// "parts": all (the default), or some of P,F,Q,R,X,S. S needs R in the same run.
// One line per check, "  ok    ..." or "  FAIL  ...". Screenshots go to <out prefix>-<name>.png.
// Nothing is stopped or restarted. The browser is started and closed by edge.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { HookpoolClient, PROGRAMS } from "../../sdk/dist/index.js";
import { startEdge } from "./edge.mjs";
import { startReviewStandin, STATUS_TEXT } from "./review-standin.mjs";

const [origin, prefix, partsArg = "all"] = process.argv.slice(2);
if (!origin || !prefix) { console.error("usage: node web/review/flow-review.mjs <site origin> <out prefix> [parts]"); process.exit(1); }
const PARTS = ["P", "F", "Q", "R", "X", "S"];
const wanted = partsArg === "all" ? PARTS : partsArg.split(",").map((s) => s.trim().toUpperCase());
const want = (p) => wanted.includes(p);
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const RPC = "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const client = new HookpoolClient(conn);
const plat = await client.platform();
const W = 1440, HGT = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);
let total = 0, failed = 0;
const failures = [], notRun = [];
const check = (ok, text) => { total++; if (!ok) { failed++; failures.push(text); } console.log((ok ? "  ok    " : "  FAIL  ") + text); return !!ok; };
const skip = (text) => { notRun.push(text); console.log("  NOT RUN  " + text); };
const say = (label, value) => console.log("        " + (label + ":").padEnd(30) + " " + (typeof value === "string" ? value : JSON.stringify(value)));
const sol = (lamports, frac = 6) => { const v = BigInt(lamports), base = 10n ** 9n; const f = (v % base).toString().padStart(9, "0").slice(0, frac).replace(/0+$/, ""); return (v / base).toLocaleString("en-US") + (f ? "." + f : ""); };
const fund = async (kp, n) => conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, n * LAMPORTS_PER_SOL), "confirmed");

// ---- the stand-in, the wallets, the browser -----------------------------------------------------------------
const standin = await startReviewStandin({ port: 0, site: origin.replace(/\/+$/, ""), rpc: RPC, solUsd: 150 });
const base = standin.url;
const payer = Keypair.generate(), other = Keypair.generate();
await Promise.all([fund(payer, 3), fund(other, 1)]);
const fixtures = (() => { try { return JSON.parse(readFileSync(here("./workshop-fixtures/hooks.json"), "utf8")); } catch (_) { return {}; } })();
const edge = await startEdge({ name: "review", width: W, height: HGT });
let id = 0; const pending = new Map(); const events = []; const pageErrors = [];
let ws, where = "about:blank";
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); return r.result.value; };
const pg = (fn, ...args) => ev("(" + fn.toString() + ")(" + args.map((a) => JSON.stringify(a)).join(", ") + ")");
const until = async (expression, ms = 20000, step = 150) => { for (let t = 0; t < ms; t += step) { try { if (await ev(expression)) return true; } catch (_) {} await sleep(step); } return false; };
const txt = (selector) => pg((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; }, selector);
const shots = [];
const shot = async (name) => { const s = await call("Page.captureScreenshot", { format: "png" }); writeFileSync(prefix + "-" + name + ".png", Buffer.from(s.data, "base64")); shots.push(prefix + "-" + name + ".png"); console.log("        wrote " + prefix + "-" + name + ".png"); };
/// The whole page in one picture: the viewport is made as tall as the page for the capture.
async function shotFull(name, width) {
  const h = Math.min(await ev("document.documentElement.scrollHeight"), 12000);
  await call("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(400); await shot(name);
  await call("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 800 : HGT, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(300);
}
const view = async (width, height) => { await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 }); await sleep(400); };
const fits = async () => { const [a, b] = await ev("[document.documentElement.scrollWidth, window.innerWidth]"); return a <= b; };
const mouse = (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
async function click(selector) {
  await ev("(() => { const e = document.querySelector(" + q(selector) + "); if (!e) throw new Error('nothing matches " + selector + "'); e.scrollIntoView({ block: 'center' }); return true; })()");
  await sleep(150);
  const [x, y] = await ev("(() => { const b = document.querySelector(" + q(selector) + ").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()");
  await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y);
}
async function type(selector, text) {
  await click(selector);
  await ev("(() => { const e = document.querySelector(" + q(selector) + "); e.select(); return true; })()");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  if (text) await call("Input.insertText", { text });
  await sleep(120);
}
const standinOf = (kp, opts = {}) => JSON.stringify(kp ? { secret: Array.from(kp.secretKey), address: kp.publicKey.toBase58(), ...opts } : { secret: [], address: "" });
// The stand-in wallet: Phantom's shape. It signs transactions with the keypair, and messages with
// WebCrypto's Ed25519 from the keypair's seed. Who it is comes from localStorage, so one script
// serves the whole run. reject: it refuses to sign. noMessage: it has no signMessage.
const walletScript = `
  (() => {
    let who = { secret: [], address: "" };
    try { const s = localStorage.getItem("__standin"); if (s) who = JSON.parse(s); } catch (_) {}
    window.__signPrompts = 0; window.__msgPrompts = 0;
    if (!who.address) { try { localStorage.removeItem("Programmable.wallet"); } catch (_) {} return; }
    localStorage.setItem("Programmable.wallet", "phantom");
    const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(who.secret)); };
    const publicKey = { toBase58: () => who.address };
    const w = { isPhantom: true, publicKey, on() {}, disconnect: async () => {}, connect: async () => ({ publicKey }),
      signTransaction: async (tx) => { window.__signPrompts++; if (who.reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 }); tx.sign([await key()]); return tx; },
      signAllTransactions: async (txs) => { window.__signPrompts++; const k = await key(); for (const t of txs) t.sign([k]); return txs; } };
    if (!who.noMessage) w.signMessage = async (bytes) => {
      window.__msgPrompts++;
      const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...who.secret.slice(0, 32)]);
      const k = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
      return { signature: new Uint8Array(await crypto.subtle.sign("Ed25519", k, bytes)) };
    };
    window.phantom = { solana: w };
  })();`;
const waitLoad = async () => { for (let i = 0; i < 200 && !events.includes("Page.loadEventFired"); i++) await sleep(100); };
/// Open a page of the stand-in's origin as a wallet (null: none) and wait until `ready` holds.
async function open(kp, path, ready, opts = {}) {
  if (where === "about:blank") { events.length = 0; await call("Page.navigate", { url: base + "/review-hook.html" }); await waitLoad(); }
  await ev("(() => { localStorage.setItem('__standin', " + q(standinOf(kp, opts)) + "); return true; })()");
  events.length = 0; where = path;
  await call("Page.navigate", { url: base + path });
  await waitLoad();
  if (await until(ready, 15000)) { await sleep(300); return; }
  // a wallet the page did not restore: connect it the way the menu does
  if (kp) await ev("(async () => { const Wl = await import('/wallet.js'); const H = await import('/js/hookpool.js'); if (Wl.available().length) await Wl.connect(Wl.available()[0], H.PublicKey); return true; })()");
  if (!(await until(ready, 15000))) throw new Error("the page did not get ready: " + path);
  await sleep(300);
}
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); }
  catch (e) { check(false, "this part stopped early: " + ((e && e.message) || String(e))); try { await shot("failure-" + title.split(/[ .]/)[0].toLowerCase()); } catch (_) {} try { await view(W, HGT); } catch (_) {} }
}
const formReady = "!!document.querySelector('#payBtn') && !/Reading/.test(document.querySelector('#payLine').textContent)";
const formWallet = formReady + " && /Pay and send|Send the request again/.test(document.querySelector('#payBtn').textContent)";
const statusReady = "!document.querySelector('#status').hidden && (!document.querySelector('#stPanel').hidden || !document.querySelector('#stState').hidden)";
const GOOD = { name: "Fee splitter " + Math.floor(Math.random() * 1000), repo: "https://github.com/example-dev/fee-splitter", commit: "0123456789ABCDEF0123456789abcdef01234567", desc: "Takes a fixed share of every buy and every sell for a wallet the launcher names. The share is fixed at launch. Nothing can change after launch.", x: "example_dev", tg: "@example_dev_tg" };
async function fill(v) { await type("#fName", v.name); await type("#fRepo", v.repo); await type("#fCommit", v.commit); await type("#fDesc", v.desc); await type("#fX", v.x); await type("#fTg", v.tg); }
const prompts = () => ev("window.__signPrompts");
const statusSet = async (body) => { const r = await fetch(base + "/__standin/set", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); };
const configure = async (body) => { const r = await fetch(base + "/__standin/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json(); };
const priceNow = async () => (await (await fetch(base + "/api/v1/hook-reviews/price")).json());
const R = {};

try {
  ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === "Runtime.exceptionThrown") pageErrors.push(where.split("?")[0] + "  EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") pageErrors.push(where.split("?")[0] + "  console.error " + d.params.args.map((a) => a.value || a.description).join(" "));
    else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") pageErrors.push(where.split("?")[0] + "  " + d.params.entry.source + " error " + d.params.entry.text + (d.params.entry.url ? " " + d.params.entry.url.slice(0, 120) : ""));
    else if (d.method) events.push(d.method);
  };
  await call("Page.enable"); await call("Runtime.enable"); await call("Log.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript });
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await view(W, HGT);
  console.log("site " + origin + " through the review stand-in " + base + ", chain " + RPC + ", payer " + payer.publicKey.toBase58() + ", platform treasury " + plat.treasury.toBase58());

  // ---- P. the page ----------------------------------------------------------------------------------------
  if (want("P")) await section("P. the page: the mark, the rules, the costs, the steps, the form", async () => {
    await open(null, "/review-hook.html", formReady);
    const form = await pg(() => ({ note: (document.querySelector("#ticketNote") || {}).textContent || "", link: (document.querySelector("#ticketNote a") || {}).href || "", x: !!document.querySelector("#fX"), tg: !!document.querySelector("#fTg"), contact: !!document.querySelector("#fContact") }));
    check(/open a ticket in Programmable's Discord/i.test(form.note) && /request id/.test(form.note) && form.link === "https://discord.com/invite/programmable" && form.x && form.tg && !form.contact, "under the form: open a ticket in Programmable's Discord with the request id; two optional handles, X and Telegram, and no other contact field");
    const price = await priceNow();
    const p = await pg(() => {
      const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
      return { title: document.title, h1: t(document.querySelector("h1")), mark: t(document.querySelector("#markSample")), rules: [...document.querySelectorAll("#rules li b")].map(t), steps: document.querySelectorAll(".rv-steps .rv-step").length,
        fee: t(document.querySelector("#feeUsd")), feeSol: t(document.querySelector("#feeSol")), pay: t(document.querySelector("#payLine")), btn: t(document.querySelector("#payBtn")), to: (document.querySelector("#sTo a") || {}).title || "",
        text: document.body.innerText, back: document.querySelector(".back").getAttribute("href"), reports: [...document.querySelectorAll("a[href='reviews/index.html']")].length };
    });
    check(p.title === "Get your hook reviewed | Programmable" && p.h1 === "Get your hook reviewed", "the page is titled \"" + p.title + "\"");
    check(p.mark === "Reviewed by Programmable", "the mark reads \"" + p.mark + "\"");
    const RULES = ["Public source, pinned", "Frozen, and the reviewed code", "Sells always go through", "Fees bounded in code", "No power that hurts holders", "Written once", "Asks only for what it uses", "Calls only what it names", "Checks its caller and its settings", "Fits"];
    check(JSON.stringify(p.rules) === JSON.stringify(RULES), "the ten review rules, in the order of R13-COMMON.md: " + p.rules.join(" | "));
    check(/Every fee the hook can charge has a ceiling fixed when the pool is created, and the coin's page shows it\./.test(p.text) && /moves only between zero and that ceiling, and the report names who can change it\./.test(p.text) && /None of them can block trades, lift a fee above its ceiling or take funds the hook holds for others/.test(p.text), "rules 4 and 5 carry the updated words: a ceiling fixed at creation, a fee that moves only between zero and it, no setting lifts a fee above it");
    check(p.steps === 6, "six steps from the code to an approved hook");
    say("price from the stand-in", price.lamports + " lamports at " + price.solUsd + " USD a SOL");
    check(p.pay === "You will pay " + sol(price.lamports) + " SOL (25 USD)." && p.fee === "25" && p.feeSol.startsWith(sol(price.lamports) + " SOL now, at 150 USD a SOL"), "the price line before the wallet: \"" + p.pay + "\", and the fee card \"" + p.feeSol + "\"");
    check(p.to === plat.treasury.toBase58(), "the fee goes to the platform's treasury, " + plat.treasury.toBase58() + ", as the price endpoint names it");
    check(p.btn === "Connect wallet", "without a wallet the button reads \"" + p.btn + "\"");
    check(/1 to 4 SOL/.test(p.text) && /paid to the network|You pay it to the network/.test(p.text) && /whatever the outcome/.test(p.text), "both costs are named: about 1 to 4 SOL of rent to the network, and the review fee whatever the outcome");
    check(/A review is not an audit and not a promise\./.test(p.text), "the page says a review is not an audit and not a promise");
    const banned = /\b(safe|secure|guaranteed|certified|verified safe)\b/i.exec(p.text);
    check(!banned && !/audit(?!\s+and not a promise)/i.test(p.text.replace(/not an audit/gi, "")), "no word the owner bans for a review (safe, secure, guaranteed, certified): " + (banned ? banned[0] : "none"));
    check(!/[^\x00-\x7E]/.test(p.text.replace(/\u00a0/g, " ")), "the page's text is plain keyboard characters");
    check(p.back === "workshop.html" && p.reports >= 1, "it leads back to Custom hooks and to the reports");
    await shot("review-1440");
    await shotFull("review-full-1440", W);
    await ev("document.querySelector('#formTitle').scrollIntoView({ block: 'start' }); window.scrollBy(0, -90); true"); await sleep(300); await shot("review-form-1440");
    await view(375, 800);
    check(await fits(), "375 wide: no sideways scroll (" + (await ev("document.documentElement.scrollWidth")) + " of 375)");
    await ev("window.scrollTo(0, 0); true"); await sleep(200); await shot("review-375");
    await ev("document.querySelector('#formTitle').scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); true"); await sleep(300); await shot("review-form-375");
    await shotFull("review-full-375", 375);
    await view(W, HGT);
  });

  // ---- F. the field checks, before anything is paid ------------------------------------------------------------
  if (want("F")) await section("F. the five fields are checked before any quote and any wallet prompt", async () => {
    await open(payer, "/review-hook.html", formWallet);
    const quotes0 = standin.calls.quote;
    const cases = [
      ["#fName", "", "#eName", /Give the hook a name\./],
      ["#fName", "x".repeat(33), "#eName", /33 characters\. The most is 32\./],
      ["#fName", "Fee \u00e9t\u00e9", "#eName", /plain letters/],
      ["#fRepo", "http://github.com/a/b", "#eRepo", /https address of the repository/],
      ["#fRepo", "https://github.com/onlyowner", "#eRepo", /https address of the repository/],
      ["#fRepo", "https://example.com/a/b", "#eRepo", /github\.com, gitlab\.com or codeberg\.org/],
      ["#fRepo", "https://github.com/a/b?tab=1", "#eRepo", /https address of the repository/],
      ["#fRepo", "https://github.com/../b", "#eRepo", /https address of the repository/],
      ["#fCommit", "0123456789abcdef0123456789abcdef0123456", "#eCommit", /40 characters/],
      ["#fCommit", "g123456789abcdef0123456789abcdef01234567", "#eCommit", /40 characters/],
      ["#fDesc", "", "#eDesc", /Say what the hook does\./],
      ["#fDesc", "d".repeat(2001), "#eDesc", /2,001 characters\. The most is 2,000\./],
      ["#fX", "bad-name", "#eX", /X handle has 1 to 15 letters/],
      ["#fX", "a".repeat(16), "#eX", /X handle has 1 to 15 letters/],
      ["#fTg", "abc", "#eTg", /Telegram handle has 5 to 32 letters/],
      ["#fTg", "1alice", "#eTg", /starts with a letter/],
    ];
    await fill(GOOD);
    let all = true;
    for (const [field, value, err, want] of cases) {
      const goodValue = { "#fName": GOOD.name, "#fRepo": GOOD.repo, "#fCommit": GOOD.commit, "#fDesc": GOOD.desc, "#fX": GOOD.x, "#fTg": GOOD.tg }[field];
      await type(field, value);
      await click("#payBtn"); await sleep(250);
      const said = await txt(err), invalid = await ev("document.querySelector(" + q(field) + ").getAttribute('aria-invalid')"), result = await txt("#result");
      const ok = want.test(said || "") && invalid === "true" && /Nothing was paid\./.test(result || "");
      if (!ok) { all = false; say("refused badly", field + " = " + JSON.stringify(value.slice(0, 40)) + ": " + said + " | " + result); }
      await type(field, goodValue);
    }
    check(all, "each of " + cases.length + " bad values is refused under its own field with its reason, and the line under the button says nothing was paid");
    check((await prompts()) === 0 && standin.calls.quote === quotes0, "no wallet prompt and no quote for any of them: " + (await prompts()) + " prompts, " + (standin.calls.quote - quotes0) + " quotes");
    // a refused field marks itself, and the mark goes away once it is typed right
    await type("#fCommit", "xyz"); await click("#payBtn"); await sleep(200);
    await shot("review-fields-1440");
    await type("#fCommit", GOOD.commit); await sleep(200);
    check((await txt("#eCommit")) === "" && (await ev("document.querySelector('#fCommit').getAttribute('aria-invalid')")) === "false", "a marked field clears its line as soon as it is typed right");
    check((await txt("#nameCount")) === GOOD.name.length + "/32", "the name counts its characters: " + (await txt("#nameCount")));
  });

  // ---- Q. the price down, a moved price, a wallet that refuses ------------------------------------------------
  if (want("Q")) await section("Q. the price down, a moved price, and a wallet that refuses", async () => {
    await configure({ priceDown: true });
    await open(payer, "/review-hook.html", "/could not be read/.test(document.querySelector('#payLine').textContent)");
    const line = await txt("#payLine"), dis = await ev("document.querySelector('#payBtn').disabled");
    check(/^The SOL price could not be read right now, so the fee in SOL is not known\./.test(line) && dis, "with the price down the line says so and the button is off: \"" + line + "\"");
    await configure({ priceDown: false, solUsd: 150 });
    // the price moves between the line on the page and the quote
    await open(payer, "/review-hook.html", formWallet);
    const shown = (await priceNow()).lamports;
    await configure({ solUsd: 120 });
    const moved = (await priceNow()).lamports;
    await fill({ ...GOOD, name: "Moved price" });
    const p0 = await prompts();
    await click("#payBtn");
    await until("/The SOL price moved/.test(document.querySelector('#result').textContent)", 15000);
    const said = await txt("#result"), pay = await txt("#payLine");
    check(BigInt(moved) > BigInt(shown) && (await prompts()) === p0 && /^The SOL price moved\. You will now pay /.test(said) && pay === "You will pay " + sol(moved) + " SOL (25 USD).", "a quote above the line on the page stops before the wallet and shows the new amount: \"" + said + "\" and \"" + pay + "\"");
    await configure({ solUsd: 150 });
    // a wallet that refuses
    await open(payer, "/review-hook.html", formWallet, { reject: true });
    await fill({ ...GOOD, name: "Refused" });
    const submits = standin.calls.submit;
    await click("#payBtn");
    await until("/did not sign/.test(document.querySelector('#result').textContent)", 15000);
    const r = await txt("#result");
    check(r === "The wallet did not sign. Nothing was sent." && standin.calls.submit === submits, "a wallet that refuses: \"" + r + "\", and no request is sent");
  });

  // ---- R. a request goes through ---------------------------------------------------------------------------------
  if (want("R")) await section("R. a request goes through: one prompt, the fee and the memo on chain, the status view", async () => {
    await configure({ notConfirmedTimes: 2, solUsd: 150 });
    await open(payer, "/review-hook.html", formWallet);
    await ev("localStorage.removeItem('Programmable.reviewRequests'); localStorage.removeItem('Programmable.reviewPending'); true");
    await fill(GOOD);
    const s0 = standin.calls.submit, q0 = standin.calls.quote, p0 = await prompts();
    const price = await priceNow();
    await click("#payBtn");
    const sawWait = await until("/does not see the payment yet/.test(document.querySelector('#result').textContent)", 30000, 80);
    check(sawWait, "while the service answers NOT_CONFIRMED_YET the page says it asks again: \"" + (await txt("#result")) + "\"");
    const arrived = await until("location.search.includes('id=') && !document.querySelector('#stPanel').hidden", 60000, 200);
    if (!check(arrived, "the request is sent and the page opens its status")) throw new Error("no status page");
    const reqId = await ev("new URLSearchParams(location.search).get('id')");
    const stored = standin.requests.get(reqId);
    R.id = reqId; R.request = stored;
    say("request", reqId + ", payment " + (stored ? stored.paid.signature : "none"));
    check(standin.calls.quote === q0 + 1 && standin.calls.submit >= s0 + 3, "one quote, and the request was sent " + (standin.calls.submit - s0) + " times: twice NOT_CONFIRMED_YET, then taken");
    check(!!stored && stored.name === GOOD.name && stored.repo === GOOD.repo && stored.commit === GOOD.commit.toLowerCase() && stored.description === GOOD.desc && stored.x === "@" + GOOD.x && stored.telegram === GOOD.tg, "the service holds the fields as typed, the commit in small letters and the X handle with its @: " + (stored ? stored.commit + " " + stored.x + " " + stored.telegram : ""));
    // one wallet prompt in this run of the page: the status page is a new document, so the count is read from the chain
    const tx = await conn.getTransaction(stored.paid.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const ixs = tx.transaction.message.compiledInstructions;
    const transfer = ixs.find((i) => keys.get(i.programIdIndex).equals(SystemProgram.programId));
    const memo = ixs.find((i) => keys.get(i.programIdIndex).toBase58() === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    const lam = transfer ? Buffer.from(transfer.data).readBigUInt64LE(4) : 0n;
    check(keys.get(0).equals(payer.publicKey) && tx.transaction.signatures.length === 1, "chain: one signature, the wallet's own, pays the fee: " + keys.get(0).toBase58());
    check(!!transfer && keys.get(transfer.accountKeyIndexes[1]).equals(plat.treasury) && String(lam) === String(price.lamports), "chain: a transfer of " + sol(lam, 9) + " SOL from the wallet to the platform's treasury, the quoted amount");
    check(!!memo && Buffer.from(memo.data).toString("utf8") === "programmable-review:" + reqId && memo.accountKeyIndexes.length === 0, "chain: a memo that names the request, \"programmable-review:" + reqId + "\", with no account");
    check(ixs.length <= 4, "the transaction holds the transfer, the memo and the compute budget only: " + ixs.map((i) => keys.get(i.programIdIndex).toBase58().slice(0, 6)).join(", "));
    const v = await pg(() => { const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : ""); return { badge: t(document.querySelector("#stBadge")), text: t(document.querySelector("#stText")), fee: t(document.querySelector("#stFee")), sig: (document.querySelector("#stSig") || {}).href || "", program: t(document.querySelector("#stProgram")), report: t(document.querySelector("#stReport")), repo: (document.querySelector("#stRepo") || {}).href || "", commit: t(document.querySelector("#stCommit")), prog: !document.querySelector("#progPanel").hidden, h1: t(document.querySelector("#stName")), sub: t(document.querySelector("#stSub")), title: document.title }; });
    check(v.badge === "Waiting" && v.text === STATUS_TEXT.waiting && v.h1 === GOOD.name && v.sub === "Review request " + reqId, "the status view: \"" + v.badge + "\", \"" + v.text + "\", under the hook's name");
    const tk = await pg(() => ({ shown: !document.querySelector("#stTicket").hidden, id: (document.querySelector("#stTicketId") || {}).textContent || "", copy: !!document.querySelector("#stTicketCopy button"), discord: (document.querySelector("#stDiscord") || {}).href || "", next: (document.querySelector("#stNext") || {}).textContent || "" }));
    check(tk.shown && tk.id === reqId && tk.copy && tk.discord === "https://discord.com/invite/programmable" && /Discord ticket/.test(tk.next), "the status view asks for a Discord ticket with the request id " + tk.id + ", with a copy button and a link to Programmable's Discord");
    check(v.sig.includes("solscan.io/tx/" + stored.paid.signature) && v.fee === sol(price.lamports) + " SOL", "the payment links to Solscan (" + v.sig.slice(0, 60) + "...) and the fee reads " + v.fee);
    check(v.program === "not given yet" && v.report === "not written yet" && !v.prog && v.repo === GOOD.repo && v.commit === GOOD.commit.toLowerCase(), "no program yet, no report yet, no program id form while it waits");
    check(!(await ev("localStorage.getItem('Programmable.reviewPending')")) && JSON.parse(await ev("localStorage.getItem('Programmable.reviewRequests')") || "[]").some((m) => m.id === reqId), "this browser keeps the request in its list and forgets the pending payment");
    await shot("status-waiting-1440");
    await view(375, 800); check(await fits(), "status view at 375: no sideways scroll"); await shot("status-waiting-375"); await view(W, HGT);
    // the list of this browser's requests on the page
    await open(payer, "/review-hook.html", formWallet);
    const mine = await pg(() => [...document.querySelectorAll("#mineList a")].map((a) => [a.textContent, a.getAttribute("href")]));
    check(!(await ev("document.querySelector('#mine').hidden")) && mine.some(([t, h]) => t === GOOD.name && h === "review-hook.html?id=" + reqId), "back on the form, \"Requests sent from this browser\" links to it");
  });

  // ---- X. a paid request the service did not take -------------------------------------------------------------------
  if (want("X")) await section("X. a paid request the service did not take is sent again without a new payment", async () => {
    await configure({ solUsd: 150, failNextSubmit: { status: 400, code: "BAD_REPO", message: "The repository could not be read as an address." } });
    await open(payer, "/review-hook.html", formWallet);
    await ev("localStorage.removeItem('Programmable.reviewPending'); true");
    await fill({ ...GOOD, name: "Second try" });
    const q0 = standin.calls.quote;
    await click("#payBtn");
    await until("!!document.querySelector('#paidNote')", 30000);
    const r = await pg(() => { const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : ""); return { bad: t(document.querySelector("#result .bad")), id: t(document.querySelector("#paidId")), sig: (document.querySelector("#paidSig") || {}).title || "", btn: t(document.querySelector("#payBtn")), name: document.querySelector("#fName").value, pending: localStorage.getItem("Programmable.reviewPending") }; });
    check(r.bad === "The repository could not be read as an address." && /^[0-9a-f]{16}$/.test(r.id) && r.sig.length > 60 && r.name === "Second try" && r.btn === "Send the request again", "the service's message, the request id and the payment, the form still filled, and the button \"" + r.btn + "\"");
    check(!!r.pending && JSON.parse(r.pending).id === r.id, "the paid request waits in this browser");
    // sent again and refused again: the page pays nothing and the button comes back
    await configure({ failNextSubmit: { status: 409, code: "STANDIN_BUSY", message: "The review service is busy. Try again in a minute." } });
    const s1 = standin.calls.submit;
    await click("#payBtn");
    await until("/is busy/.test(document.querySelector('#result').textContent) && !document.querySelector('#payBtn').disabled", 20000);
    check(standin.calls.submit === s1 + 1 && standin.calls.quote === q0 + 1 && (await txt("#payBtn")) === "Send the request again" && !!(await ev("document.querySelector('#paidNote')")), "sent again and refused again: no new quote, no new payment, the service's words, and the button is back: \"" + (await txt("#payBtn")) + "\"");
    await ev("document.querySelector('#formTitle').scrollIntoView({ block: 'start' }); window.scrollBy(0, -90); true"); await sleep(250);
    await shot("paid-not-sent-1440");
    // after a reload the page offers it again
    await open(payer, "/review-hook.html", formWallet + " && !document.querySelector('#pending').hidden");
    check(/A paid request from this browser was not sent\./.test(await txt("#pending")), "after a reload: \"" + (await txt("#pending .note b")) + "\"");
    await ev("document.querySelector('#formTitle').scrollIntoView({ block: 'start' }); window.scrollBy(0, -90); true"); await sleep(250);
    await shot("paid-pending-1440");
    await click("#pendingBtn");
    const ok = await until("location.search.includes('id=') && !document.querySelector('#stPanel').hidden", 30000, 200);
    const reqId = ok ? await ev("new URLSearchParams(location.search).get('id')") : "";
    // the page pays only after a quote, so an unchanged count of quotes means no second payment
    check(ok && reqId === r.id && standin.calls.quote === q0 + 1, "\"Send it now\" sends the same request, and no new quote is asked, so nothing is paid twice: " + reqId);
    check(!!standin.requests.get(reqId) && standin.requests.get(reqId).paid.signature === r.sig, "the stored request carries the first payment, " + r.sig.slice(0, 16) + "...");
    check(!(await ev("localStorage.getItem('Programmable.reviewPending')")), "the pending payment is forgotten once the request is taken");  });

  // ---- S. every status, and the program id ------------------------------------------------------------------------
  if (want("S")) await section("S. every status, and the program id signed by the wallet", async () => {
    if (!R.id) { skip("S: no request from part R in this run"); return; }
    const page = "/review-hook.html?id=" + R.id;
    const readS = () => pg(() => { const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : ""); return { badge: t(document.querySelector("#stBadge")), status: document.querySelector("#stBadge").dataset.status, text: t(document.querySelector("#stText")), note: document.querySelector("#stNote").hidden ? "" : document.querySelector("#stNoteText").textContent, noteTags: document.querySelectorAll("#stNoteText *").length, prog: !document.querySelector("#progPanel").hidden, lede: t(document.querySelector("#progLede")), program: t(document.querySelector("#stProgram")), report: (document.querySelector("a#stReport") || { getAttribute: () => "" }).getAttribute("href"), page: (document.querySelector("#stFacts a[href^='workshop-hook.html']") || { getAttribute: () => "" }).getAttribute("href") }; });
    const WORDS = { waiting: "Waiting", "in-review": "In review", "changes-needed": "Changes needed", passed: "Passed", checking: "Checking", approved: "Approved", rejected: "Not approved" };
    const NOTE = "Fees must have a ceiling. <b>line two</b>\nSecond line.";
    let formRight = true;
    for (const st of ["in-review", "changes-needed", "rejected", "waiting", "passed"]) {
      await statusSet({ id: R.id, status: st, note: st === "changes-needed" || st === "rejected" ? NOTE : "" });
      await open(payer, page, statusReady + " && document.querySelector('#stBadge').dataset.status === " + q(st));
      const s = await readS();
      const open_ = st === "passed";
      if (s.badge !== WORDS[st] || s.text !== STATUS_TEXT[st] || s.prog !== open_) { formRight = false; say("status " + st, s); }
      if (st === "changes-needed") {
        check(s.note === NOTE && s.noteTags === 0, "a note from Programmable is shown as text, markup and line breaks as typed: no element was made from it");
        await shot("status-changes-1440");
      }
    }
    check(formRight, "in-review, changes-needed, rejected, waiting and passed: each shows its word and the API's text, and the program id form only for passed");
    await shot("status-passed-1440");
    await view(375, 800); await ev("document.querySelector('#progPanel').scrollIntoView({ block: 'start' }); true"); await sleep(250);
    check(await fits(), "the program id form at 375: no sideways scroll"); await shot("status-passed-375"); await view(W, HGT);
    // refusals before the wallet
    const m0 = await ev("window.__msgPrompts"), c0 = standin.calls.program;
    await type("#fProgram", "not-a-program"); await click("#progBtn"); await sleep(250);
    check((await txt("#eProgram")) === "That is not a program address." && (await ev("window.__msgPrompts")) === m0, "a bad program id is refused under the field, before the wallet");
    await type("#fProgram", PROGRAMS.hook_tax.toBase58()); await click("#progBtn");
    await until("document.querySelector('#progResult').textContent.length > 0", 15000);
    check(/can still be upgraded/.test(await txt("#progResult")) && (await ev("window.__msgPrompts")) === m0 && standin.calls.program === c0, "an upgradeable program is refused before the wallet: \"" + (await txt("#progResult")) + "\"");
    const fee = fixtures.fee || "";
    if (!fee) { skip("S: the program id of a frozen hook. web/review/workshop-fixtures/hooks.json names none."); return; }
    // a wallet without signMessage
    await open(payer, page, statusReady, { noMessage: true });
    await type("#fProgram", fee); await click("#progBtn"); await sleep(400);
    check((await txt("#progResult")) === "This wallet cannot sign a message. Phantom and Backpack can. Connect one of them with the wallet that paid the review fee.", "a wallet without signMessage is refused politely: \"" + (await txt("#progResult")) + "\"");
    // the message the wallet signs is shown before it signs
    await open(payer, page, statusReady);
    await type("#fProgram", fee);
    const msg = await txt("#progMsg");
    check(msg === "Programmable hook review " + R.id + ": my program is " + fee, "the message is shown as the wallet will sign it: \"" + msg + "\"");
    await click("#progBtn");
    await until("/Sent\\./.test(document.querySelector('#progResult').textContent) || document.querySelector('#progResult .bad')", 20000);
    const after = await readS();
    check((await txt("#progResult")) === "Sent. Programmable now checks the program on chain." && (await ev("window.__msgPrompts")) === 1 && after.status === "checking" && after.program.startsWith(fee), "the right wallet signs once and the request moves to checking with the program: " + after.badge + ", " + after.program.slice(0, 20));
    check(after.prog && /If you gave the wrong id/.test(after.lede), "while Programmable checks, the form stays and says it takes another id");
    check(standin.requests.get(R.id).program === fee, "the stand-in verified the ed25519 signature against the paying wallet and stored the program");
    await ev("window.scrollTo(0, 0); true"); await sleep(200);
    await shot("status-checking-1440");
    // the wrong wallet
    await open(other, page, statusReady);
    await type("#fProgram", fee); await click("#progBtn");
    await until("document.querySelector('#progResult .bad')", 20000);
    check((await txt("#progResult")) === "The signature is not the wallet's that paid for this review.", "another wallet's signature is refused by the service, and the page shows its words: \"" + (await txt("#progResult")) + "\"");
    // approved, with its report
    await statusSet({ id: R.id, status: "approved", note: "", report: "reviews/tax.html" });
    await open(payer, page, statusReady + " && document.querySelector('#stBadge').dataset.status === 'approved'");
    const ap = await readS();
    check(ap.badge === "Approved" && !ap.prog && ap.report === "reviews/tax.html" && ap.page === "workshop-hook.html?id=" + fee, "approved: no form, the report link, and the hook's page in Custom hooks");
    await shot("status-approved-1440");
    await view(375, 800); await shot("status-approved-375"); await view(W, HGT);
    // a report that is not a site page or a web address is not a link
    await statusSet({ id: R.id, status: "approved", report: "javascript:alert(1)" });
    await open(payer, page, statusReady + " && document.querySelector('#stBadge').dataset.status === 'approved'");
    check((await ev("!!document.querySelector('a#stReport')")) === false && (await txt("#stReport")) === "not written yet", "a report address that is neither a page of the reviews folder nor a web address is never made a link");
    // ids that do not exist, or are not ids
    await open(payer, "/review-hook.html?id=0000000000000000", statusReady);
    check((await txt("#stState p")) === "No review request has this id. Check the address of this page.", "an unknown id: \"" + (await txt("#stState p")) + "\"");
    await open(payer, "/review-hook.html?id=%3Cb%3E", statusReady);
    check((await txt("#stState p")) === "That is not the id of a review request.", "a malformed id: \"" + (await txt("#stState p")) + "\"");
  });
} catch (e) {
  check(false, "the run stopped: " + ((e && e.message) || String(e)));
} finally {
  console.log("\npage errors: " + (pageErrors.length ? "\n  " + pageErrors.join("\n  ") : "none"));
  // the errors a run causes on purpose: the price endpoint answering 503, the API's refusals (400, 404, 409)
  const own = pageErrors.filter((e) => !/status of (400|404|409|503)/.test(e));
  check(own.length === 0, "no console error the run did not cause on purpose (" + pageErrors.length + " logged, " + (pageErrors.length - own.length) + " were API answers the run asked for)");
  try { ws && ws.close(); } catch (_) {}
  console.log(await edge.close());
  await standin.close();
  console.log("closed the review stand-in on " + base);
}
console.log("\n" + total + " checks, " + (total - failed) + " ok, " + failed + " failed" + (notRun.length ? ", " + notRun.length + " NOT RUN" : ""));
if (failures.length) console.log("failed:\n  - " + failures.join("\n  - "));
if (notRun.length) console.log("not run:\n  - " + notRun.join("\n  - "));
console.log("screenshots:\n  " + shots.join("\n  "));
process.exit(failed ? 1 : 0);
