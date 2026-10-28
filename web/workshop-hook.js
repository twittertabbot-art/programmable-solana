// One workshop hook: its author's rules next to what the chain allows it, the checks this
// page runs in the visitor's browser, its coins and what it collected.
import {
  boot, ctx, H, Wallet, $, el, platform, currentSlot, fmtSol, fmtInt, short, flagSentences, timeAgo, slotAge, copyButton, extLinks, extLink, explorer,
  checkHook, templateOfProgram, TEMPLATE_LABEL, coinImage, setImage, monogram, mapLimit, fetchJson, explainTxError, setTitle, rpcFailText, allPools as poolsList, webHref,
} from "./common.js";
import { loadDescriptor, loadReviewed, hookTotals, powerRows, descriptorSentence, PINNED_SENTENCE, PIN_MEANS, UNPINNED_SENTENCE, reviewMark, reportLine, NOT_REVIEWED } from "./workshop-lib.js";

await boot("workshop.html");
const { PublicKey, DIRECTION } = H;
/// The buy the trade check simulates, and what a wallet needs to hold for the simulation to run.
const TRY_BUY = 10_000_000n, TRY_NEEDS = 50_000_000n;

function state(text, ...more) {
  $("page").hidden = true;
  const s = $("state"); s.hidden = false;
  s.replaceChildren(el("p", { text }), ...more);
}
const toWorkshop = () => el("a", { class: "btn", href: "workshop.html", text: "Open Custom hooks" });

let id = null;

// ---- the checks ---------------------------------------------------------------------------------------

const WORD = { passed: "Passed", failed: "Failed", notrun: "Not run", none: "Not published", yes: "Yes", no: "No", running: "Running", unlisted: "Not approved" };
const TONE = { passed: "ok", yes: "ok", failed: "bad", unlisted: "bad" };
/// One check: `means` is a sentence, or a list of text and nodes (a link).
function setCheck(key, result, what, means) {
  const li = el("li", { "data-check": key, "data-result": result },
    el("span", { class: "badge res " + (TONE[result] || ""), text: WORD[result] }),
    el("div", null, el("div", { class: "what", text: what }), el("p", { class: "means" }, ...[].concat(means))));
  const old = $("checks").querySelector('[data-check="' + key + '"]');
  if (old) old.replaceWith(li); else $("checks").append(li);
}

/// A buy, then a sell of the coins it gave, in one simulated transaction, with the connected
/// wallet. Nothing is sent. Without a wallet: the watcher's verdict, when this site has one.
let tradeRun = 0;
async function tradeCheck(pool, symbol) {
  const what = "A buy and a sell go through right now";
  const run = ++tradeRun;
  const set = (result, means) => { if (run === tradeRun) setCheck("trade", result, what, means); };
  if (!pool) return set("notrun", "No coin trades on this hook yet, so there is no pool to try.");
  const coin = symbol || short(pool.baseMint.toBase58());
  const user = Wallet.current().publicKey;
  if (!user) {
    const w = ctx.watcherUrl ? await fetchJson(ctx.watcherUrl + "/pools.json", 5000) : null;
    const v = w && w.pools && w.pools[pool.address.toBase58()];
    if (v && v.buySim && v.sellSim) {
      // a simulation the watcher could not run (its own reads failed, or no holder to sell from)
      // is no verdict on the hook: said as not run, never as a failure
      const ran = (s) => s.ok === true || (s.ok === false && !s.skipped && !/^(watcher|setup):/i.test(String(s.error || "")));
      const word = (s) => (s.ok === true ? "passes" : ran(s) ? "fails" : "was not run");
      const when = v.lastCheck ? ", " + timeAgo((Date.now() - Date.parse(v.lastCheck)) / 1000) : "";
      const result = v.buySim.ok === true && v.sellSim.ok === true ? "passed" : (ran(v.buySim) && v.buySim.ok === false) || (ran(v.sellSim) && v.sellSim.ok === false) ? "failed" : "notrun";
      return set(result, "From this site's watcher" + when + ", on " + coin + ". Buy simulation " + word(v.buySim) + ", sell simulation " + word(v.sellSim) + ". Connect a wallet to run it yourself.");
    }
    return set("notrun", "Connect a wallet that holds " + fmtSol(TRY_NEEDS) + " SOL on " + ctx.cluster + ". The page then simulates a buy and a sell on " + coin + " with it. It sends nothing.");
  }
  set("running", "Simulating a buy and a sell on " + coin + " with your wallet. Nothing is sent.");
  try {
    if (BigInt(await ctx.connection.getBalance(user)) < TRY_NEEDS) return set("notrun", "Your wallet holds less than " + fmtSol(TRY_NEEDS) + " SOL on " + ctx.cluster + ". A simulation fails for a wallet that could not pay for the trade.");
    const fresh = (await ctx.client.pool(pool.address)) || pool;
    const hook = await ctx.client.hookRef(fresh, user);
    const isPool = (ix) => ix.programId.equals(H.PROGRAMS.hookpool);
    const noBudget = (ix) => !ix.programId.equals(H.ComputeBudgetProgram.programId);
    const sim = async (ixs) => (await ctx.connection.simulateTransaction((await ctx.client.buildTx(user, ixs)).tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" })).value;
    const why = (v) => { const e = new Error(JSON.stringify(v.err)); e.logs = v.logs || []; return explainTxError(e, "trade"); };
    const buyAll = await ctx.client.swapInstructions(user, fresh, hook, DIRECTION.BUY, TRY_BUY, 0n);
    const buy = buyAll.slice(0, buyAll.findIndex(isPool) + 1);
    const first = await sim(buy);
    if (first.err) return set("failed", "A buy of " + fmtSol(TRY_BUY) + " SOL on " + coin + " failed in a simulation. " + (await why(first)));
    const rd = first.returnData;
    const got = rd && rd.programId === H.PROGRAMS.hookpool.toBase58() ? Buffer.from(rd.data[0], "base64").readBigUInt64LE(0) : 0n;
    if (got <= 0n) return set("failed", "A buy of " + fmtSol(TRY_BUY) + " SOL on " + coin + " gave no coins in a simulation.");
    const sellAll = await ctx.client.swapInstructions(user, fresh, hook, DIRECTION.SELL, got, 0n);
    const sell = sellAll.slice(0, sellAll.findIndex(isPool) + 1);
    const both = [H.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...buy.filter(noBudget), ...sell.filter(noBudget)];
    const second = await sim(both);
    if (second.err) return set("failed", "The buy went through. The sell of the coins it gave failed in the same simulated transaction on " + coin + ". " + (await why(second)));
    set("passed", "A buy of " + fmtSol(TRY_BUY) + " SOL and a sell of the coins it gave ran in one simulated transaction on " + coin + ", with your wallet, just now. Nothing was sent. A hook can answer the next trade differently.");
  } catch (e) {
    set("notrun", "The simulation could not be run. " + (e && e.message ? e.message : ""));
  }
}

// ---- the page -----------------------------------------------------------------------------------------

async function show() {
  const id58 = id.toBase58();
  const [c, plat, pools, reviewed, slot] = await Promise.all([checkHook(id), platform().catch(() => null), poolsList(), loadReviewed(), currentSlot()]);
  if (!c.exists) return state("There is no account at this address on " + ctx.cluster + ".", toWorkshop());
  if (!c.executable) return state("This address is not a program.", toWorkshop());
  const tpl = templateOfProgram(id);
  if (tpl !== "custom") return state("This program is the platform hook \"" + TEMPLATE_LABEL[tpl] + "\". Custom hooks lists hooks other people built.", el("a", { class: "btn", href: "hooks.html?id=" + id58, text: "Open it in the hook checker" }));

  const mine = pools.filter((p) => p.hasHook && p.hookProgram.equals(id)).sort((a, b) => (a.createdSlot < b.createdSlot ? -1 : a.createdSlot > b.createdSlot ? 1 : 0));
  const x = await loadDescriptor(id, c.manifest);
  const d = x.state === "ok" ? x.d : null;
  // what a new pool on this hook gets is in the manifest. A pool keeps the flags it was created with.
  const flags = c.manifest ? c.manifest.flags : mine.length ? mine[0].hookFlags : null;
  const name = d ? d.name : (c.manifest && c.manifest.name) || "Unnamed hook";
  setTitle(name);
  $("state").hidden = true; $("page").hidden = false;

  // head
  $("name").textContent = name;
  $("art").src = monogram(name);
  const by = $("by");
  by.replaceChildren();
  if (d && d.author) {
    let who = el("b", { text: d.author });
    try { if (new PublicKey(d.author).toBase58() === d.author) who = extLink(explorer("account", d.author), short(d.author), d.author); } catch (_) {}
    by.append("Built by ", who, ", says its descriptor. ");
  } else by.append("Its author is not named. ");
  if (mine.length) by.append("The wallet ", extLink(explorer("account", mine[0].creator.toBase58()), short(mine[0].creator.toBase58()), mine[0].creator.toBase58()), " launched the first coin on it.");
  else by.append("No coin has launched on it yet.");
  $("idRow").replaceChildren(el("span", { text: "Program" }), el("span", { class: "mono", id: "programId", text: id58 }), copyButton(id58, "Copy program id"), extLinks(id58));

  // the author's rules
  const rules = $("rules");
  if (d) {
    rules.replaceChildren(...[
      el("p", { id: "summary", text: d.summary }),
      el("ol", { class: "ws-rules lg", id: "ruleList" }, ...d.rules.map((r) => el("li", { text: r }))),
      el("p", { class: "small muted", style: "margin-top: 14px" }, "The hook's author wrote these rules. This site shows them and does not check them against the code. ",
        webHref(d.source) ? el("a", { class: "link", id: "source", href: webHref(d.source), target: "_blank", rel: "noopener", text: "The code, as linked by the author" }) : "The author gave no link to the code."),
      // can this text still change: the manifest pins the file's content, or only its address
      el("p", { class: "small " + (x.pinned ? "ok" : "muted"), id: "pinNote", "data-pin": x.pinned ? "yes" : "no", text: x.pinned ? PINNED_SENTENCE : UNPINNED_SENTENCE }),
      x.pinned ? el("p", { class: "small muted", id: "pinMeans", text: PIN_MEANS }) : null,
      el("p", { class: "small dim" }, "Descriptor: ", webHref(x.url) ? el("a", { class: "link", id: "descriptorUrl", href: webHref(x.url), target: "_blank", rel: "noopener", text: x.url }) : el("span", { id: "descriptorUrl", text: String(x.url || "") }))].filter(Boolean));
  } else {
    rules.replaceChildren(...[
      el("p", { id: "noRules", class: x.state === "none" ? "muted" : "bad", text: x.state === "none" ? "The author published no descriptor, so this hook has no rules in words." : descriptorSentence(x) }),
      el("p", { class: "small muted", text: "What the hook may do is read from the chain. A descriptor would add what its author says it does." }),
      x.link ? el("p", { class: "small dim" }, "Its manifest links to ", webHref(x.link) ? el("a", { class: "link", id: "manifestLink", href: webHref(x.link), target: "_blank", rel: "noopener", text: x.link }) : el("span", { id: "manifestLink", text: String(x.link) })) : null].filter(Boolean));
  }

  // what the chain allows
  if (flags === null) {
    $("sentences").replaceChildren(el("li", { text: "This program has published no manifest, so it has no powers a pool would grant." }));
    $("powers").replaceChildren();
  } else {
    $("sentences").replaceChildren(...flagSentences(flags, "custom", null, plat).map((t) => el("li", { text: t })));
    $("powers").replaceChildren(...powerRows(flags, plat).flatMap(([k, v, tone]) => [el("dt", { text: k }), el("dd", { class: tone, text: v })]));
  }

  // the checks
  $("checks").replaceChildren();
  setCheck("frozen", c.frozen === true ? "passed" : "failed", "The program is frozen",
    c.frozen === true ? "Its upgrade authority is gone, so nobody can change its code. The accounts it keeps can still change, as far as that code allows."
      : c.frozen === false ? "It can still be upgraded by " + short(c.authority ? c.authority.toBase58() : "", 5) + ". The pool refuses a hook whose code can change."
        : "Its loader could not be read. " + c.reason);
  const listed = !!c.manifest && c.extra !== null;
  setCheck("manifest", listed ? "passed" : "failed", "It published its manifest and its account list",
    listed ? "The pool reads what the hook may do from the manifest (flags " + c.manifest.flags + ") and which accounts to pass from the list (" + c.extra + " bytes)."
      : !c.manifest ? "There is no manifest under this program" + (c.manifestErr ? " (" + c.manifestErr + ")" : "") + ". No pool can use it." : "There is no account list under this program. No pool can use it.");
  setCheck("descriptor", x.state === "ok" ? "passed" : x.state === "none" ? "none" : "failed", "Its descriptor loads and names this program",
    x.state === "ok" ? "The file its manifest links to is a valid descriptor for " + short(id58, 5) + ". It holds the author's words. Nothing in it is checked against the code. " + (x.pinned ? "Its content is the one the manifest pins." : "The manifest does not pin its content.")
      : x.state === "none" ? "The author published no descriptor. " + (x.link ? "The manifest carries a plain link." : "The manifest carries no link.") + " This page shows chain facts only."
        : descriptorSentence(x) + " Address: " + x.url);
  const sol = mine.filter((p) => p.quoteMint.equals(H.NATIVE_MINT));
  const tryPool = sol.slice().sort((a, b) => (b.reserveQuote > a.reserveQuote ? 1 : b.reserveQuote < a.reserveQuote ? -1 : 0))[0] || null;
  setCheck("trade", "running", "A buy and a sell go through right now", "Waiting for the pools.");
  // the review: the approved list on chain decides; the registry only gives the report and its date
  const r = reviewed.get(id58) || null;
  const appr = plat ? await ctx.client.hookApproval(id, plat).catch(() => null) : null;
  const approved = !!(appr && appr.approved);
  const toReview = el("a", { class: "link", href: "review-hook.html", text: "How the review works" });
  if (approved) setCheck("reviewed", "yes", "Reviewed by Programmable",
    ["Programmable reviewed this hook and put its program on the approved list" + (r && r.date ? ", on " + r.date : "") + ". ", reportLine(r), ". A review is not an audit and not a promise."]);
  else if (appr && appr.required) setCheck("reviewed", "unlisted", "Reviewed by Programmable",
    ["This program is not on Programmable's approved list, so no new coin can launch on it." + (mine.length ? " Coins already on it keep it, because a pool's hook can never change." : "") + " ", toReview]);
  else setCheck("reviewed", "no", "Reviewed by Programmable", ["Programmable has not reviewed this hook. Pools on this platform take a frozen hook without a review. ", toReview]);
  // the mark beside the name, with its report
  $("markRow").hidden = !approved;
  $("markRow").replaceChildren(...(approved ? [reviewMark(r), " ", reportLine(r)] : []));

  // totals and the launch button
  const t = hookTotals(mine);
  // each figure a label over its value, as in a row of the token page
  const fig = (label, id, value) => el("div", null, el("dt", { text: label }), el("dd", { id, text: value }));
  $("totals").replaceChildren(
    fig("Coins", "tLaunches", fmtInt(t.launches)),
    fig("Collected by the hook", "tCollected", fmtSol(t.collected, 6) + " SOL"),
    fig("Volume", "tVolume", fmtSol(t.volume, 4) + " SOL"),
    fig("Trades", "tSwaps", fmtInt(t.swaps)));
  const ownsCurve = flags !== null && (flags & H.FLAGS.OVERRIDE_CURVE) !== 0;
  const box = $("launchBox");
  // the approved list: a pool refuses a hook that is not on it while the rule is on
  const allowed = !appr || appr.allowed;
  if (c.accepts && !ownsCurve && !allowed) {
    box.replaceChildren(
      el("p", { class: "help", id: "noLaunch", text: NOT_REVIEWED + (mine.length ? " Coins already on it keep it, because a pool's hook can never change." : "") }),
      el("a", { class: "btn btn-block", id: "toReview", href: "review-hook.html", text: "Get your hook reviewed" }));
  } else if (c.accepts && !ownsCurve) box.replaceChildren(
    el("a", { class: "btn btn-primary btn-main btn-block", id: "launchOn", href: "launch-hook.html?hook=" + id58, text: "Launch a coin on this hook" }),
    el("p", { class: "help", text: d && d.setup ? "The launch form builds this hook's settings from its descriptor. The first transaction runs the hook's own setup with your signature, so the form simulates it before your wallet opens and refuses when it takes more than its rent. A simulation is not a guarantee. The hook's code is the truth."
      : d ? "This hook's descriptor names no settings for a pool. The launch form asks for nothing more."
        : "This hook has no descriptor in use. If it keeps settings for each pool, you create them yourself. The launch form names the pool address." }));
  else box.replaceChildren(el("p", { class: "help", id: "noLaunch", text: ownsCurve ? "The launchpad does not take a hook that sets the price itself." : "A pool would refuse this hook today. The checks say why." }));
  // A frozen hook with a manifest passes the checks above and can still refuse every pool, for
  // example one built for an earlier version of the pool program. Its first pool is the proof.
  if (c.accepts && !ownsCurve && allowed && !mine.length) box.append(el("p", { class: "help", id: "firstLaunch", text: "No pool has been created on this hook yet, so nothing on chain shows that the pool can call it. A launch is two transactions. If the hook refuses the pool in the second one, the coin of the first stays created and paid for." }));
  if (t.otherQuote) box.append(el("p", { class: "help", text: t.otherQuote + (t.otherQuote === 1 ? " pool trades" : " pools trade") + " against another quote token. The SOL totals leave them out." }));

  // its coins
  const tbody = $("coins").querySelector("tbody"), thead = $("coins").querySelector("thead");
  if (!mine.length) {
    $("coinsLede").textContent = "No coin has launched on this hook yet. " + (appr && appr.required ? (approved ? "It is listed in Custom hooks because Programmable approved it." : "It is listed in Custom hooks once Programmable approves it.") : "It is listed in Custom hooks after its first launch.");
    $("coinsWrap").hidden = true;
    tradeCheck(null, "");
    return;
  }
  $("coinsLede").textContent = mine.length === 1 ? "One coin trades on this hook." : mine.length + " coins trade on this hook. The oldest is first.";
  const meta = await mapLimit(mine, 4, (p) => ctx.client.metadata(p.baseMint));
  const th = (text, cls) => el("th", { class: cls || "", text });
  thead.replaceChildren(el("tr", null, th("Coin"), th("Launched", "r"), th("Pooled", "r"), th("Trades", "r"), th("Hook collected", "r"), th("")));
  tbody.replaceChildren(...mine.map((p, i) => {
    const addr = p.address.toBase58(), md = meta[i];
    const symbol = (md && md.symbol) || "";
    const img = el("img", { class: "avatar", alt: "", width: 32, height: 32 });
    img.src = monogram(symbol);
    coinImage(md ? md.uri : "", symbol).then((src) => setImage(img, src, symbol));
    const isSol = p.quoteMint.equals(H.NATIVE_MINT);
    return el("tr", { "data-pool": addr },
      el("td", { class: "full" }, el("a", { class: "coin-cell", href: "coin.html?pool=" + addr }, img, el("div", { style: "min-width:0" }, el("div", { class: "name" }, (md && md.name) || "Unnamed coin", el("span", { class: "sym", text: symbol })), el("div", { class: "sub", text: short(p.baseMint.toBase58(), 5) })))),
      el("td", { class: "r", "data-label": "Launched", text: timeAgo(slotAge(p.createdSlot, slot)) }),
      el("td", { class: "r", "data-label": "Pooled", text: isSol ? fmtSol(p.reserveQuote, 2) + " SOL" : "another token" }),
      el("td", { class: "r", "data-label": "Trades", text: fmtInt(p.swapCount) }),
      el("td", { class: "r", "data-label": "Hook collected", text: isSol ? fmtSol(p.hookFeesQuoteTotal, 6) + " SOL" : "another token" }),
      el("td", { class: "act" }, el("a", { class: "btn btn-sm", href: "coin.html?pool=" + addr, text: "Trade" })));
  }));
  const symbolOf = (p) => { const i = mine.indexOf(p); return i >= 0 && meta[i] ? meta[i].symbol : ""; };
  const again = () => tradeCheck(tryPool, tryPool ? symbolOf(tryPool) : "");
  Wallet.onChange(again);
  again();
}

const asked = new URLSearchParams(location.search).get("id");
if (!asked) state("This page shows one hook. Pick one in Custom hooks.", toWorkshop());
else { try { id = new PublicKey(asked.trim()); } catch (_) { state("That is not a valid address.", toWorkshop()); } }
if (id) { try { await show(); } catch (e) { state(rpcFailText(e)); } }
