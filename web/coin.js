// Coin page: header, hook card (with the owner's controls of a tax coin, the buyback trigger and
// the payout of hook fees that wait in the pool), buy/sell, chart, trades, pool stats, watcher verdict.
import {
  boot, ctx, H, Wallet, $, el, platform, currentSlot, coinImage, coinMeta, setImage, monogram, fmtPrice, fmtCompact, fmtUnits, fmtSol, fmtPct, fmtInt,
  fmtTime, timeAgo, slotAge, slotsToMinutes, hookBadge, templateOf, TEMPLATE_LABEL, short, explorer, addrChip, extLinks, copyButton, parseUnits, applyBps,
  debounce, toast, sendIxs, requireWallet, fetchJson, toNumber, SOL_DECIMALS, SLOT_MS, rulesTags, tagsEl, pieceImg, pieceBlank, sendSigned, sleep, isPegged, flagSentences,
  fmtLp, fmtShare, wrappedSol, unwrapSol, explainTxError, fmtSpan, fmtDate, slotsToSeconds, liquidityWindow, setTitle, copy, svg, signTx, signTxs, traceMark, curveSentence,
  rpcFailText, notAccountOf, fmtAmount, plainError, webHref, manifestLink,
} from "./common.js";
import { STRICT_MODULES } from "./launch-strict.js";
import { artStudio, folderOf, pieceArt, folderManifest, oddsOf, drawPiece, fmtChance } from "./art-studio.js";
// the warning on a coin whose outside hook is not on the approved list
import { TAKEN_OFF } from "./workshop-lib.js";

await boot("coin.html");
const { PublicKey, DIRECTION, HOOK_KIND } = H;
const q = new URLSearchParams(location.search);
const headEl = $("head");

async function page() {
function fail(text) { $("loadMsg").replaceChildren(el("div", { class: "card" }, el("p", { text }), el("a", { class: "btn btn-sm", href: "index.html", text: "Back to Explore" }))); }

let poolKey;
try { poolKey = new PublicKey(q.get("pool") || ""); } catch (_) { fail("Open a coin from the Explore page. This page needs a pool address in the URL."); return; }

// S.balances.wsol: what the wallet's wrapped SOL account holds, null when the wallet has none.
// S.local is the quote worked out here from the pool's formula, S.sim the same trade simulated
// on chain with the connected wallet. S.lp is the pool's LP supply and the part of it that sits
// in the lock account.
// S.curve: a pool launched on the curve. opened and graduated are its CurveOpened and Graduated
// events once read (null until then, or when they lie further back than the page reads).
const S = {
  pool: null, plat: null, md: null, mint: null, quoteMint: null, info: null, launch: null, meta: null,
  baseDec: 6, quoteDec: SOL_DECIMALS, quoteSym: "SOL", quoteIsSol: true, symbol: "", name: "",
  swaps: [], bucket: 60, chart: null, series: null, dir: DIRECTION.BUY, slippageBps: 100,
  balances: { sol: 0n, base: 0n, quote: 0n, wsol: null }, quoting: 0, watcher: null,
  local: null, sim: null, lp: null, hookSeq: 0, hookDrawn: "",
  curve: { opened: null, graduated: null, searched: false },
};
// A coin on the launch rules template. RU.st is client.rulesState (the rules, and the running
// numbers settled to this moment), RU.stake the wallet's stake, RU.lock the creator lock, RU.run
// what a press of the burn button would do. RU.at is when they were read: between two reads the
// page works the slot and the clock out from it, so the numbers that fall move every second.
const RU = { st: null, stake: null, lock: null, run: null, at: 0, phase: "", drawn: "", busy: false, amount: null, result: null, rent: null, holderRent: null, holder: null, said: null, error: "" };
// The chain's rent, read once per page (two reads, kept an hour by the SDK client) and only on a coin that
// needs it: a collectible coin for its deposits, a rules coin for its record rents. Mainnet charges 5,080
// lamports a byte and a local validator 6,960, so nothing here sizes or reads a deposit from a constant.
let RENT = null;
async function loadRent() { if (!RENT) RENT = await ctx.client.rent(); return RENT; }
// S.run: the same for a buyback coin (client.buybackInstructions), null below the minimum.
const OUR = Object.values(H.PROGRAMS).map((p) => p.toBase58());

// What the page reads, and how often (the RPC is paid by the call):
// - the pool, its coin, its hook, its LP, the launch record and the wallet's balances come in ONE
//   read (client.poolView), two on the first load. Its slot is the page's clock: no getSlot.
// - the trades come from the watcher's feed (ctx.watcherUrl, trades/<pool>.json), which costs no
//   RPC at all. Without a watcher: one read of the last 50 transactions, then only the
//   transactions newer than the newest one seen, and only when the pool says it traded.
// - with a watcher the chain is read again when the feed shows a new trade, and once a minute in
//   any case; without one, every 10 seconds. Nothing is read while the tab is hidden.
const WATCHED = !!ctx.watcherUrl;
const POLL_MS = WATCHED ? 60_000 : 10_000, FEED_MS = 5_000;
// S.view: the last client.poolView. S.nowSlot is its slot and S.slotAt when it was read.
S.view = null; S.slotAt = 0;
S.hist = { newest: null, newestSlot: null, events: [], feedNewest: "", feedDown: 0, busy: null, again: false };
try {
  const v = await ctx.client.poolView(poolKey, { platform: ctx.platform || true, metadata: true, launch: true, wallet: Wallet.current().publicKey });
  if (!v) { fail("No pool at " + poolKey.toBase58() + " on " + ctx.cluster + "."); return; }
  ctx.platform = v.platform;
  S.plat = v.platform; S.md = v.metadata; S.info = v.hook; S.launch = v.launch;
  applyView(v);
  const pool = S.pool;
  S.baseDec = S.mint ? S.mint.decimals : 6;
  S.quoteIsSol = pool.quoteMint.equals(H.NATIVE_MINT);
  S.quoteDec = S.quoteIsSol ? SOL_DECIMALS : (v.quoteMint ? v.quoteMint.decimals : SOL_DECIMALS);
  if (!S.quoteIsSol) { const qmd = await ctx.client.metadata(pool.quoteMint); S.quoteSym = (qmd && qmd.symbol) || short(pool.quoteMint.toBase58()); }
  S.symbol = (S.md && S.md.symbol) || "COIN"; S.name = (S.md && S.md.name) || "Unnamed coin";
  setTitle(S.name + " (" + S.symbol + ")");
} catch (e) {
  // an address that holds another kind of account is "no pool", not an RPC that failed
  fail(notAccountOf(e, "Pool") ? "No pool at " + poolKey.toBase58() + " on " + ctx.cluster + "." : rpcFailText(e));
  return;
}

// ---- header ---------------------------------------------------------------------------------------

const price = () => H.spotPrice(S.pool, S.baseDec, S.quoteDec);
const mcap = () => price() * (S.mint ? toNumber(S.mint.supply, S.baseDec) : 0);

const ICON = {
  website: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z",
  x: "M5 4l14 16M19 4L5 20",
  telegram: "M21 4L3 11l6 2.5L11 20l3-4 4.5 3zM9 13.5L21 4",
  copy: "M8 3h9a2 2 0 0 1 2 2v9M5 7h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z",
};
function renderHead() {
  const img = el("img", { class: "avatar lg", alt: "", width: 64, height: 64 }); img.src = monogram(S.symbol);
  coinImage(S.md ? S.md.uri : "", S.symbol).then((src) => setImage(img, src, S.symbol));
  const links = [];
  if (S.meta) {
    const ext = S.meta.extensions || {};
    const add = (label, href, d) => { if (typeof href === "string" && /^https?:\/\//i.test(href)) links.push(el("a", { href, target: "_blank", rel: "noopener noreferrer", title: label, "aria-label": label + " of " + S.name }, svg(d))); };
    add("Website", ext.website || S.meta.external_url, ICON.website); add("X", ext.twitter, ICON.x); add("Telegram", ext.telegram, ICON.telegram);
  }
  const badge = hookBadge(S.pool);
  const mintAddr = S.pool.baseMint.toBase58();
  headEl.replaceChildren(
    el("div", { class: "coin-head" }, img,
      el("div", { class: "coin-id" },
        el("div", { class: "coin-name" }, el("h1", null, S.name, el("span", { class: "sym", text: S.symbol + " / " + S.quoteSym })), links.length ? el("span", { class: "head-links" }, ...links) : null),
        el("div", { class: "head-tags", id: "headTags" }, el("span", { class: "badge " + badge.cls, text: badge.label }), tagsEl(headTags())))),
    ...(S.meta && S.meta.description ? [el("p", { class: "muted small coin-desc", text: String(S.meta.description).slice(0, 280) })] : []),
    el("div", { class: "addr-row" },
      el("button", { class: "btn btn-sm copy-addr", type: "button", onclick: () => copy(mintAddr) }, svg(ICON.copy), "Copy address"),
      addrChip("Mint", mintAddr), extLinks(mintAddr),
      addrChip("Pool", S.pool.address.toBase58()), extLinks(S.pool.address.toBase58())),
    el("div", { class: "figs", id: "figs" }, ...figures()),
    el("div", { class: "curve-line", id: "curveLine", hidden: true }));
  drawCurve();
}
/// The row of figures under the name: read again with every refresh of the pool.
function figures() {
  const p = S.pool;
  return [["Price", "headPrice", fmtPrice(price()) + " " + S.quoteSym], ["Market cap", "headMcap", fmtCompact(mcap()) + " " + S.quoteSym],
    ["In the pool", "headLiq", fmtAmount(p.reserveQuote, S.quoteDec, 2) + " " + S.quoteSym], ["Volume", "headVol", fmtUnits(p.volumeQuoteTotal, S.quoteDec, 2) + " " + S.quoteSym], ["Trades", "headSwaps", fmtInt(p.swapCount)]]
    .map(([l, id, v]) => el("div", { class: "fig" }, el("div", { class: "l", text: l }), el("div", { class: "v", id, text: v })));
}
function drawFigures() { const box = $("figs"); if (box) box.replaceChildren(...figures()); drawCurve(); }

// ---- the curve -------------------------------------------------------------------------------------
// A pool launched on the curve. While it is open: what it has raised of its target, with a bar,
// the share of the supply sold, and that liquidity opens at graduation. Once it graduated: a quiet
// mark with the slot, the time and the coins the graduation burned, from its Graduated event.
const isCurvePool = () => !!S.pool && S.pool.curveState !== H.CURVE_NONE;
const isCurveOpen = () => !!S.pool && H.isOnCurve(S.pool);
const solText = (v, frac = 2) => fmtUnits(v, S.quoteDec, frac) + " " + S.quoteSym;
function curveNow() { return S.mint ? H.curveProgress(S.pool, S.mint.supply) : null; }
function drawCurve() {
  const box = $("curveLine");
  if (!box) return;
  if (!isCurvePool()) { box.hidden = true; box.replaceChildren(); return; }
  const p = curveNow();
  if (!p) { box.hidden = true; return; }
  box.hidden = false;
  if (p.open) {
    const pct = p.raisedBps / 100;
    const reached = S.pool.reserveQuote >= S.pool.graduationTarget;
    const bar = el("div", { class: "curve-bar", role: "progressbar", "aria-label": "Raised toward graduation", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, el("span", { style: "width:" + Math.min(100, pct) + "%" }));
    box.replaceChildren(
      el("div", { class: "curve-top" },
        el("span", { class: "curve-raised", id: "curveRaised" }, "Raised ", el("b", { text: fmtAmount(p.raised, S.quoteDec, 2) }), " of " + solText(p.target)),
        el("span", { class: "curve-sold", id: "curveSold", text: fmtPct(p.soldBps, 1) + " of the supply sold" })),
      bar,
      el("p", { class: "curve-note", id: "curveNote", text: reached ? "The pool has reached its target. The next trade graduates the coin." : "Liquidity opens at graduation, when the pool has raised " + solText(p.target) + "." }));
    box.dataset.state = "open";
    return;
  }
  // graduated: the slot, the time and the burn come from the pool's Graduated event
  const g = S.curve.graduated;
  const said = g ? "In slot " + fmtInt(g.slot) + (g.blockTime ? " (" + fmtDate(g.blockTime) + ")" : "") + ". Graduation burned " + fmtUnits(g.burnedBase, S.baseDec, 0) + " " + S.symbol + " so the price did not move." : "The pool raised its target and left the curve. It is now an ordinary pool.";
  box.replaceChildren(el("div", { class: "curve-done" }, el("span", { class: "tag", id: "curveMark", text: "Graduated" }), el("span", { class: "small muted", id: "curveDone", text: said })));
  box.dataset.state = "graduated";
}
/// The curve settings the price was made of when a trade landed: the virtual SOL while the curve
/// was open, up to the slot of the graduation. Passed to the SDK's candles. undefined for a seeded pool.
function curveCandles() {
  if (isCurveOpen()) return { virtualQuote: S.pool.virtualQuote, graduatedSlot: null };
  if (!isCurvePool()) return undefined;
  const v = S.curve.opened ? S.curve.opened.virtualQuote : S.plat ? S.plat.curveVirtualQuote : 0n;
  // a graduation further back than the page reads: every trade it shows came after it
  return { virtualQuote: v, graduatedSlot: S.curve.graduated ? S.curve.graduated.slot : 0n };
}
/// The tags next to the coin's name. A rules coin is tagged with the rules it has, once they are read.
function headTags() {
  // a coin without a hook: the badge beside the tags says "No hook" already
  if (!S.pool.hasHook) return [];
  const facts = RU.st ? { cfg: RU.st.config, lpFeeBps: S.pool.lpFeeBps, locked: RU.lock ? RU.lock.vaultBalance : 0n, unlockAt: RU.lock ? RU.lock.unlockAt : 0n, slot: ruSlot(), unixTime: ruUnix() } : null;
  return rulesTags(S.pool.hookFlags, templateOf(S.pool), S.pool.hasHook, isPegged(S.pool), facts);
}
function drawHeadTags() {
  const box = $("headTags"); if (!box) return;
  const tags = headTags(), old = box.querySelector(".tags");
  if (old && [...old.children].map((t) => t.textContent).join("|") === tags.join("|")) return;
  if (old) old.replaceWith(tagsEl(tags));
}
renderHead();
coinMeta(S.md ? S.md.uri : "").then((m) => { if (m) { S.meta = m; renderHead(); } });
$("layout").hidden = false;
$("loadMsg").hidden = true;
$("thQuote").textContent = S.quoteSym; $("thBase").textContent = S.symbol;

// ---- hook card ---------------------------------------------------------------------------------------
// The card is drawn again after every trade and on every poll, so its numbers follow the chain
// without a reload. A draw is skipped when nothing it shows has changed. The controls of a tax
// coin's owner are one node that is rebuilt only when the tax itself changes (TAX.node), so a
// poll never takes away what the owner is typing.

const walletKey = () => { const k = Wallet.current().publicKey; return k ? k.toBase58() : ""; };
/// What a token account holds. null when the account does not exist.
async function tokenAmountAt(address) {
  const a = await ctx.connection.getAccountInfo(address);
  return a && a.data.length >= 72 ? H.decodeTokenAmount(new Uint8Array(a.data)) : null;
}
/// Is the connected wallet the owner of this pool's hook treasury, with its wrapped SOL account as the treasury?
function isTreasuryOwner() {
  const k = Wallet.current().publicKey;
  return !!k && S.quoteIsSol && S.pool.hookTreasuryOwner.equals(k) && S.pool.hookQuoteTreasury.equals(H.pda.ata(k, H.NATIVE_MINT));
}
/// Can this pool's hook change the amounts of a trade in this direction? Only a hook that is
/// not a platform template, called before the swap on that side, with a fee, a fee override
/// or the curve in its flags. No formula knows such a hook's answer: the trade is simulated.
function hookSetsAmounts(dir) {
  const p = S.pool;
  if (!p.hasHook || templateOf(p) !== "custom") return false;
  const F = H.FLAGS, side = dir === DIRECTION.BUY ? F.CALL_ON_BUY : F.CALL_ON_SELL;
  return (p.hookFlags & side) !== 0 && (p.hookFlags & F.BEFORE_SWAP) !== 0 && (p.hookFlags & (F.TAKE_HOOK_FEE | F.OVERRIDE_FEE | F.OVERRIDE_CURVE)) !== 0;
}
const plain = (k, v) => (typeof v === "bigint" ? String(v) : v);
/// Is this coin's hook an outside hook that is not on the approved list while the platform's
/// rule is on (a hook taken off it, or a pool made before the rule)? From the platform the page
/// reads; from the watcher's `hookApproval` when the platform carries no rule.
function delisted() {
  const p = S.pool;
  if (!p || !p.hasHook || p.hookKind !== HOOK_KIND.FROZEN || templateOf(p) !== "custom") return false;
  if (S.plat && typeof S.plat.hookApprovalRequired === "boolean") {
    if (!S.plat.hookApprovalRequired || S.plat.approvedListCorrupt) return false;
    return !S.plat.approvedHooks.some((k) => k.equals(p.hookProgram));
  }
  const w = S.watcher && S.watcher.pools && S.watcher.pools[p.address.toBase58()];
  return !!w && w.hookApproval === "not approved";
}

async function renderHook(force) {
  const card = $("hookCard");
  const pool = S.pool, info = S.info;
  const id = ++S.hookSeq;
  const t = templateOf(pool);
  // what the card shows beyond the pool account and the hook's own config, from the page's last
  // read of the pool (S.view, the same slot): the hook's treasury, and on a buyback coin what a
  // press of the button would do, as the SDK works it out. The guard's slot moves on with the clock.
  const live = { slot: info && info.guard ? slotNow() : 0n, treasury: null, run: null };
  const v = S.view;
  try {
    if (info && info.buyback) {
      live.run = v ? v.buyback : null;
      live.treasury = !v ? null : info.buyback.treasury.equals(pool.hookQuoteTreasury) ? v.treasury : await tokenAmountAt(info.buyback.treasury);
      live.slot = live.run ? live.run.slot : slotNow();
    } else if (info && (info.tax || t === "custom") && isTreasuryOwner()) live.treasury = v ? v.treasury : null;
  } catch (_) {}
  if (id !== S.hookSeq) return; // a newer draw is on its way
  S.run = live.run; S.runAt = live.run ? S.slotAt : Date.now();
  // a rules coin: the card holds its fixed rules and its two windows, whose numbers the clock moves (tickRules)
  const ru = info && info.rules && RU.st ? RU.st : null;
  const drawn = [walletKey(), delisted() ? "delisted" : "", pool.hookFeesQuoteTotal, pool.hookFeesOwedQuote, pool.reserveQuote, info && info.buyback ? "" : live.slot, live.treasury,
    live.run ? [live.run.step, live.run.due, live.run.reason || "", live.run.dueSlot, live.run.spend, live.run.capBps].join() : "", ru ? rulesPhase() : "",
    info ? JSON.stringify(info.tax || info.guard || info.buyback || info.collectible || (info.rules ? [info.rules.buy, info.rules.sell, info.rules.sniperSlots, info.rules.limitSlots] : info.flags), plain) : "none"].join("|");
  if (!force && drawn === S.hookDrawn) return;
  S.hookDrawn = drawn;

  const badge = hookBadge(pool);
  // a collectible coin is one of two kinds, fixed at launch: the card says which next to the hook's name
  const kindTag = info && info.collectible ? el("span", { class: "tag" + (info.collectible.pegged ? " accent" : ""), text: info.collectible.pegged ? "pegged coin" : "plain coin" }) : null;
  const kids = [el("div", { class: "kind" }, el("h2", { class: "panel-title", text: t === "rules" || !pool.hasHook ? "Modules" : "Hook" }), el("span", { class: "badge " + badge.cls, text: badge.label }), kindTag)];
  if (!pool.hasHook) {
    kids.push(el("ul", { class: "sentences" },
      el("li", { text: "This pool has no hook. Every trade is plain x*y=k with the pool fee and the protocol fee." }),
      el("li", { text: "No program runs on a trade, so nothing can tax, block or reprice it later." })));
    card.replaceChildren(...kids);
    // the watcher checks plain coins too: its verdict shows on every coin page (docs, "Watcher")
    renderWatcher($("watchCard"));
    return;
  }
  // the flags speak for the pool's callbacks only: on a pegged coin the same program also runs inside every transfer
  let sentences = flagSentences(pool.hookFlags, t, t === "collectible" ? isPegged(pool) : null, S.plat);
  // the flags know nothing about the peg, so the card states its rule itself
  if (info && info.collectible) sentences = sentences.concat(pegRule());
  kids.push(el("ul", { class: "sentences" }, ...sentences.map((s) => el("li", { text: s }))));
  let status, cls = "";
  if (pool.hookKind === HOOK_KIND.FROZEN) { status = "Frozen. Nobody can change this hook's code. The accounts it keeps can still change."; cls = "frozen"; }
  else if (pool.hookKind === HOOK_KIND.PLATFORM) { status = "Platform template, upgradeable by the platform's team."; cls = "platform"; }
  else status = "Upgrade status unknown.";
  kids.push(el("div", { class: "status " + cls }, el("span", { class: "dot" }), el("span", { text: status })));
  // an outside hook that is not on the approved list while the platform's rule is on
  if (delisted()) kids.push(el("p", { class: "note warn", id: "delistedNote", style: "margin-top:10px", text: TAKEN_OFF }));
  if (info && info.manifest) {
    const m = info.manifest;
    const ml = manifestLink(pool.hookProgram, m.uri);
    kids.push(el("div", { class: "small dim", style: "margin-top:8px" }, "Manifest: " + (m.name || "unnamed") + " ", ml ? el("a", { class: "link", href: ml.href, ...(ml.own ? {} : { target: "_blank", rel: "noopener" }), text: ml.text }) : null));
  }
  kids.push(el("div", { class: "small dim", style: "margin-top:4px;display:flex;align-items:center;gap:4px;flex-wrap:wrap" }, "Program ", el("span", { class: "mono", text: short(pool.hookProgram.toBase58(), 5), title: pool.hookProgram.toBase58() }), copyButton(pool.hookProgram.toBase58(), "Copy hook program id"),
    el("a", { class: "link", href: "hooks.html?id=" + pool.hookProgram.toBase58(), text: "Check it" })));

  // the hook's numbers
  const params = el("div", { class: "params" });
  if (info && info.tax) {
    const x = info.tax;
    params.append(el("dl", { class: "kv" },
      el("dt", { text: "Buy tax" }), el("dd", { text: fmtPct(x.buyBps) }),
      el("dt", { text: "Sell tax" }), el("dd", { text: fmtPct(x.sellBps) }),
      el("dt", { text: "Ceiling, fixed forever" }), el("dd", { text: fmtPct(x.maxBps) }),
      el("dt", { text: "Owner" }), el("dd", { text: x.renounced ? "renounced" : short(x.owner.toBase58(), 5), title: x.renounced ? "" : x.owner.toBase58() }),
      el("dt", { text: "Treasury" }), el("dd", { text: short(pool.hookQuoteTreasury.toBase58(), 5), title: pool.hookQuoteTreasury.toBase58() }),
      el("dt", { text: "Collected so far" }), el("dd", { text: fmtUnits(pool.hookFeesQuoteTotal, S.quoteDec, 4) + " " + S.quoteSym })));
    params.append(el("p", { class: "help", text: x.renounced ? "The owner renounced. These taxes can never change." : "The owner can move the taxes anywhere between 0% and the ceiling, or renounce and freeze them." }));
    if (isTreasuryOwner()) params.append(takeLine(live.treasury));
    const admin = taxAdmin(x);
    if (admin) params.append(admin);
  } else if (info && info.guard) {
    const g = info.guard;
    const slot = live.slot;
    const fee = H.guardFee(slot, g.startSlot, g.guardSlots, g.startFeeBps, pool.lpFeeBps);
    const elapsed = g.startSlot > 0n && slot > g.startSlot ? slot - g.startSlot : 0n;
    const left = g.guardSlots > elapsed ? g.guardSlots - elapsed : 0n;
    const mins = slotsToMinutes(g.guardSlots);
    params.append(el("dl", { class: "kv" },
      el("dt", { text: "Start fee on buys" }), el("dd", { text: fmtPct(g.startFeeBps) }),
      el("dt", { text: "Window" }), el("dd", { text: fmtInt(g.guardSlots) + " slots, " + (mins >= 1 ? mins.toLocaleString("en-US", { maximumFractionDigits: 1 }) + " min" : Math.round(mins * 60) + " s") }),
      el("dt", { text: "Slots left" }), el("dd", { text: fmtInt(left) }),
      el("dt", { text: "Buy fee right now" }), el("dd", { class: fee !== null ? "accent" : "", text: fmtPct(fee !== null ? fee : pool.lpFeeBps) })));
    params.append(el("p", { class: "help", text: fee !== null ? "The fee falls every slot (" + SLOT_MS + " ms) until it reaches the pool fee of " + fmtPct(pool.lpFeeBps) + ". The extra stays in the pool as liquidity. Nobody collects it. Nobody can add liquidity until the window is over." : "The guard window is over. Buys pay the pool fee of " + fmtPct(pool.lpFeeBps) + " like any other pool." }));
  } else if (info && info.buyback) {
    const b = info.buyback;
    const treasury = live.treasury || 0n;
    const run = live.run;
    // the cap of one run follows the fees of this coin (the SDK's buybackCapBps); the next buy is the SDK's own figure
    const cap = H.buybackCapBps(b, S.plat, pool.lpFeeBps);
    const w = runWords(run, { buy: "Run buyback", pot: "treasury", empty: "Runs once the treasury reaches the minimum of " + fmtUnits(b.minQuote, S.quoteDec, 4) + " " + S.quoteSym + ". Anyone can send it." });
    params.append(el("dl", { class: "kv" },
      el("dt", { text: "Buy share" }), el("dd", { text: fmtPct(b.buyBps) }),
      el("dt", { text: "Sell share" }), el("dd", { text: fmtPct(b.sellBps) }),
      el("dt", { text: "Treasury balance" }), el("dd", { text: fmtUnits(treasury, S.quoteDec, 4) + " " + S.quoteSym }),
      el("dt", { text: "Minimum to trigger" }), el("dd", { text: fmtUnits(b.minQuote, S.quoteDec, 4) + " " + S.quoteSym }),
      el("dt", { text: "One run spends at most" }), el("dd", { text: fmtPct(cap) + " of the pool's " + S.quoteSym }),
      el("dt", { text: "The next buy would spend" }), el("dd", { class: run ? "accent" : "", text: run ? fmtUnits(run.spend, S.quoteDec, 6) + " " + S.quoteSym : "nothing yet" }),
      el("dt", { text: "Burned so far" }), el("dd", { text: fmtUnits(b.totalBaseBurned, S.baseDec, 2) + " " + S.symbol }),
      el("dt", { text: "Buybacks run" }), el("dd", { text: fmtInt(b.buybacks) })));
    const btn = el("button", { class: "btn btn-sm", type: "button", disabled: w.disabled, text: w.label });
    btn.addEventListener("click", () => runBuyback(btn));
    params.append(el("div", { class: "hook-run" }, btn, el("span", { class: "small muted", id: "runNote" }, ...w.nodes)));
    params.append(el("p", { class: "help", text: "A run buys the coin with a slice of the treasury and burns what it buys. It buys against a price the pool had at least " + H.BURN_INTERVAL_SLOTS + " slots earlier, so the first call only records the pool. A treasury larger than one slice takes several runs." }));
  } else if (ru) {
    params.append(...rulesParams(ru));
  } else if (info && info.collectible) {
    const c = info.collectible;
    params.append(el("dl", { class: "kv" },
      el("dt", { text: "Pieces now" }), el("dd", { text: fmtInt(c.live) + " of " + fmtInt(c.maxSupply) }),
      el("dt", { text: "Ever minted" }), el("dd", { text: fmtInt(c.minted) }),
      el("dt", { text: "Coins per piece" }), el("dd", { text: unitText() }),
      el("dt", { text: "Pieces per buy" }), el("dd", { text: "up to " + c.maxPerBuy }),
      el("dt", { text: "Waiting in tickets" }), el("dd", { text: fmtInt(c.reservedPending) }),
      el("dt", { text: "Art" }), el("dd", { text: artWords(c.uriBase), title: c.uriBase }),
      el("dt", { text: "Art version" }), el("dd", { text: String(c.artVersion) }),
      el("dt", { text: "Collection" }), el("dd", { text: c.locked ? "locked" : "updatable by " + short(c.owner.toBase58()), title: c.locked ? "" : c.owner.toBase58() })));
    const fixed = " The cap of " + fmtInt(c.maxSupply) + " pieces at once and the coins per piece were fixed at launch.";
    params.append(el("p", { class: "help", text: (c.locked ? "The collection is locked. Its name, art and renderer can never change again." : "The owner can still change the name, the art and the renderer for later pieces. Existing pieces never change.") + fixed }));
    if (folderOf(c.uriBase)) params.append(el("p", { class: "help", text: "The art is the launcher's own files, stored on Arweave. Rarity is a chance: each piece's seed draws its art, so two pieces can show the same art." }));
  } else if (t === "custom") {
    // a hook of someone else: its limits in numbers, as the platform account and the pool hold them
    const sum = H.describeFlags(pool.hookFlags);
    const rows = [];
    if (sum.canTakeFee) rows.push(el("dt", { text: "Most it can take per trade" }), el("dd", { text: fmtPct(S.plat.maxHookFeeBps) }));
    if (sum.canOverrideFee) rows.push(el("dt", { text: "Highest pool fee it can set" }), el("dd", { text: fmtPct(S.plat.maxFeeOverrideBps) }));
    if (sum.canTakeFee) rows.push(
      el("dt", { text: "Treasury" }), el("dd", { text: short(pool.hookQuoteTreasury.toBase58(), 5), title: pool.hookQuoteTreasury.toBase58() }),
      el("dt", { text: "Taken so far" }), el("dd", { text: fmtUnits(pool.hookFeesQuoteTotal, S.quoteDec, 4) + " " + S.quoteSym }));
    if (rows.length) params.append(el("dl", { class: "kv" }, ...rows));
    if (sum.canOverrideCurve) params.append(el("p", { class: "help", text: "This hook sets the price itself, and no cap limits that. The trade form simulates your trade on chain and shows what you would receive." }));
    else if (sum.canTakeFee || sum.canOverrideFee) params.append(el("p", { class: "help", text: "The hook answers every trade itself, anywhere from 0% to these limits. The pool enforces them. The trade form simulates your trade on chain and shows what the hook takes." }));
    // the wallet that receives this hook's fee takes it the way a tax owner does
    if (sum.canTakeFee && isTreasuryOwner()) params.append(takeLine(live.treasury, "fee"));
  }
  if (params.childNodes.length) kids.push(params);
  // hook fees the pool could not pay: their treasury account was missing when they were taken
  if (pool.hookFeesOwedQuote > 0n) {
    const btn = el("button", { class: "btn btn-sm", type: "button", text: "Pay them out" });
    btn.addEventListener("click", () => payHookFees(btn));
    kids.push(el("div", { class: "hook-act owed" },
      el("div", { text: fmtUnits(pool.hookFeesOwedQuote, S.quoteDec, 6) + " " + S.quoteSym + " of hook fees wait in the pool. Their treasury account was missing." }),
      el("div", { class: "hook-act-row" }, el("span", { class: "small muted", text: "Anyone can pay them out. That opens the account for its owner again." }), btn)));
  }
  // a redraw moves the owner's form: keep the field that had the focus, and its cursor
  const active = document.activeElement;
  const typing = TAX.node && TAX.node.contains(active) ? { node: active, a: active.selectionStart, b: active.selectionEnd } : null;
  card.replaceChildren(...kids);
  applyFailNote();
  if (typing && card.contains(typing.node)) { typing.node.focus(); try { typing.node.setSelectionRange(typing.a, typing.b); } catch (_) {} }
  renderWatcher($("watchCard"));
}

/// For the wallet that owns the treasury of a tax coin, or of a custom hook that takes a fee: what
/// waits there, and the button that takes it.
function takeLine(amount, what = "tax") {
  const has = amount !== null && amount > 0n;
  const btn = el("button", { class: "btn btn-sm btn-primary", type: "button", disabled: !has, text: "Take it" });
  btn.addEventListener("click", () => unwrapSol(btn, async () => { await refreshPool(); await renderHook(true); }));
  return el("div", { class: "hook-act" },
    el("div", { class: "hook-act-v" }, el("span", { text: "In your treasury" }), el("b", { class: "mono", text: fmtUnits(amount || 0n, S.quoteDec, 6) + " " + S.quoteSym })),
    el("div", { class: "hook-act-row" },
      el("span", { class: "small muted", text: amount === null
        ? "Your wrapped SOL account is closed. The " + what + " waits in the pool until the account is open again."
        : "The treasury is your wrapped SOL account. Take it turns all of it into plain SOL and leaves the account open." }),
      btn));
}

/// For the wallet that owns the tax: change it under its ceiling, or renounce. Built once per
/// state of the tax and handed back as the same node on every draw.
const TAX = { node: null, key: "" };
function taxAdmin(x) {
  const k = Wallet.current().publicKey;
  if (!k || x.renounced || !x.owner.equals(k)) { TAX.node = null; TAX.key = ""; return null; }
  const key = [k.toBase58(), x.buyBps, x.sellBps, x.maxBps].join("|");
  if (TAX.node && TAX.key === key) return TAX.node;
  TAX.key = key;
  const field = (label, bps) => {
    const input = el("input", { class: "input num", type: "text", inputmode: "decimal", autocomplete: "off", value: String(bps / 100), "aria-label": label + " in percent" });
    return { input, node: el("label", { class: "field" }, el("span", null, el("span", { text: label })), el("div", { class: "input-wrap" }, input, el("span", { class: "suffix", text: "%" }))) };
  };
  const buy = field("Buy tax", x.buyBps), sell = field("Sell tax", x.sellBps);
  const out = el("div", { class: "tx-result" });
  const say = (cls, text) => out.replaceChildren(el("span", { class: cls, text }));
  const bpsOf = (input) => { const v = Number(String(input.value).trim().replace(",", ".")); return input.value.trim() !== "" && isFinite(v) && v >= 0 ? Math.round(v * 100) : NaN; };
  const save = el("button", { class: "btn btn-sm", type: "button", text: "Save the tax" });
  save.addEventListener("click", async () => {
    const b = bpsOf(buy.input), s = bpsOf(sell.input);
    if (!Number.isInteger(b) || !Number.isInteger(s)) { say("bad", "Type both taxes as numbers."); return; }
    if (b > x.maxBps || s > x.maxBps) { say("bad", "Both taxes must stay at or under the ceiling of " + fmtPct(x.maxBps) + "."); return; }
    if (b === x.buyBps && s === x.sellBps) { say("muted", "Nothing changed."); return; }
    save.disabled = true; save.textContent = "Confirm in your wallet";
    try {
      const sig = await sendIxs([H.ix.taxSetTax(requireWallet(), S.pool.address, b, s)], [], "tax change");
      toast("Tax changed to " + fmtPct(b) + " on buys and " + fmtPct(s) + " on sells. It applies from the next trade.", "ok", { href: explorer("tx", sig), text: "View" });
      await refreshPool();
      quoteNow();
    } catch (e) { say("bad", e.message); save.disabled = false; save.textContent = "Save the tax"; }
  });
  // renouncing cannot be undone: one step that says so, then the signature
  const confirmBox = el("div", { class: "confirm-line", hidden: true });
  const renounce = el("button", { class: "btn btn-sm", type: "button", text: "Renounce" });
  renounce.addEventListener("click", () => {
    const yes = el("button", { class: "btn btn-sm", type: "button", text: "Renounce forever" });
    const no = el("button", { class: "btn btn-sm", type: "button", text: "Keep control" });
    no.addEventListener("click", () => { confirmBox.hidden = true; renounce.hidden = false; });
    yes.addEventListener("click", async () => {
      yes.disabled = true; no.disabled = true; yes.textContent = "Confirm in your wallet";
      try {
        const sig = await sendIxs([H.ix.taxSetOwner(requireWallet(), S.pool.address, H.SYSTEM_PROGRAM)], [], "renounce");
        toast("Renounced. The taxes can never change again.", "ok", { href: explorer("tx", sig), text: "View" });
        await refreshPool();
      } catch (e) { say("bad", e.message); yes.disabled = false; no.disabled = false; yes.textContent = "Renounce forever"; }
    });
    confirmBox.replaceChildren(
      el("div", { text: "Renouncing is forever. The taxes stay at " + fmtPct(x.buyBps) + " on buys and " + fmtPct(x.sellBps) + " on sells. Nobody can change them again." }),
      el("div", { class: "confirm-acts" }, yes, no));
    confirmBox.hidden = false; renounce.hidden = true;
  });
  TAX.node = el("div", { class: "hook-admin" },
    el("h4", { text: "You own this tax" }),
    el("div", { class: "row" }, buy.node, sell.node),
    el("p", { class: "help", text: "Anywhere from 0% to the ceiling of " + fmtPct(x.maxBps) + ". A change applies from the next trade." }),
    el("div", { class: "hook-admin-acts" }, save, renounce),
    out, confirmBox);
  return TAX.node;
}

// ---- a failure under the button that was pressed ---------------------------------------------------
// The toast goes, the sentence under the button stays. The blocks are redrawn after every action,
// so the sentence is put back after each draw until the button is pressed again.
let FAIL_NOTE = null;
function sayUnder(btn, text) {
  if (!btn || !btn.parentElement) return;
  const host = btn.parentElement;
  let n = host.nextElementSibling;
  if (!n || !n.classList.contains("act-note")) { n = el("p", { class: "error-text act-note", "aria-live": "polite" }); host.after(n); }
  n.textContent = text;
}
function failNote(btn, text) { FAIL_NOTE = btn && btn.id ? { id: btn.id, text } : null; sayUnder(btn, text); }
function applyFailNote() { if (FAIL_NOTE) sayUnder($(FAIL_NOTE.id), FAIL_NOTE.text); }

// ---- a run of a buyback or of a burn ---------------------------------------------------------------
// Both templates buy the coin through the pool the same way (the SDK's BurnRun): a buy is made
// against a price the pool had at least 25 slots earlier. So a press does one of three things,
// and the button and its sentence say which before the click: record the pool, record it again
// because the price ran up, or buy and burn.

/// The slot right now, worked out from a read `at` milliseconds ago.
function slotSince(slot, at) { return BigInt(slot) + BigInt(Math.max(0, Math.floor((Date.now() - at) / SLOT_MS))); }
const WAIT_TEXT = H.BURN_INTERVAL_SLOTS + " slots later, about " + fmtSpan(slotsToSeconds(H.BURN_INTERVAL_SLOTS));
/// The button and the sentence for what the SDK says a call does now. `words`: { buy: the
/// button's label for a buy, pot: "pot" or "treasury", empty: the sentence when nothing can run }.
/// Returns { label, disabled, nodes, dueSlot }. `dueSlot` is set while the chain refuses a call.
function runWords(run, words) {
  if (!run) return { label: words.buy, disabled: true, nodes: [words.empty], dueSlot: 0n };
  const q = (v) => fmtUnits(v, S.quoteDec, 6) + " " + S.quoteSym;
  // the SDK found that a call cannot buy now (a pot too small for one unit, for example): its own sentence
  if (!run.due && run.reason && run.step !== "tooSoon") return { label: words.buy, disabled: true, dueSlot: 0n, nodes: [run.reason.charAt(0).toUpperCase() + run.reason.slice(1) + (/[.!?]$/.test(run.reason) ? "" : ".")] };
  if (run.step === "observe") return { label: "Record the pool", disabled: false, dueSlot: 0n, nodes: ["Nothing is recorded yet. This call records the pool's price and buys nothing. A buy can follow " + WAIT_TEXT + ". Anyone can send it."] };
  if (run.step === "wait") return { label: "Record the pool again", disabled: false, dueSlot: 0n, nodes: ["The price is more than " + fmtPct(H.burnToleranceBps(run.capBps)) + " above the recorded one, so a call now buys nothing. It records the pool again, and a buy can follow " + WAIT_TEXT + "."] };
  if (run.step === "tooSoon") {
    // what the call does once it opens, should the pool stand as it is: a buy, or one more record
    // the price on the curve is made of the real and the virtual SOL, as the hook reads it
    const next = H.burnStep(run.observation, S.pool.reserveBase, H.effectiveQuote(S.pool), run.dueSlot, run.capBps, run.pot);
    return { label: next.step === "wait" ? "Record the pool again" : words.buy, disabled: true, dueSlot: run.dueSlot,
      nodes: ["The pool was recorded at slot " + fmtInt(run.observation.slot) + ". The next call opens at slot " + fmtInt(run.dueSlot) + ", ", el("span", { id: "runDue", text: dueText(run.dueSlot, run.slot) }), "."] };
  }
  if (run.step !== "buy" || !run.due) return { label: words.buy, disabled: true, dueSlot: 0n, nodes: [run.reason || words.empty] };
  return { label: words.buy, disabled: false, dueSlot: 0n, nodes: ["A call now spends " + q(run.spend) + " and burns about " + fmtUnits(run.expectedOut, S.baseDec, 2) + " " + S.symbol + "." + (run.potLeft > 0n ? " " + q(run.potLeft) + " stays in the " + words.pot + " for later runs." : "") + " Anyone can send it."] };
}
function dueText(dueSlot, slot) { const left = dueSlot > slot ? dueSlot - slot : 0n; return left > 0n ? "in about " + fmtSpan(Math.max(1, Math.ceil(slotsToSeconds(left)))) : "now"; }
/// What a run did, from the event it left in its own transaction. `fallback` is the step the
/// SDK foresaw, for a node that does not hand the transaction over in time.
async function runOutcome(sig, kind, fallback) {
  const ev = (await eventsOf(sig)).find((e) => e.kind === kind && e.pool.equals(S.pool.address));
  if (ev) return { outcome: ev.outcome, spent: ev.quoteSpent, burned: ev.baseBurned };
  return { outcome: fallback.step === "buy" ? H.BURN_OUTCOME.BOUGHT : fallback.step === "wait" ? H.BURN_OUTCOME.WAITED : H.BURN_OUTCOME.OBSERVED, spent: fallback.spend, burned: null };
}
function outcomeText(o, what) {
  if (o.outcome === H.BURN_OUTCOME.BOUGHT) return what + " done. It spent " + fmtUnits(o.spent, S.quoteDec, 6) + " " + S.quoteSym + (o.burned === null ? "" : " and burned " + fmtUnits(o.burned, S.baseDec, 2) + " " + S.symbol) + ".";
  if (o.outcome === H.BURN_OUTCOME.WAITED) return "The price was above the recorded one, so nothing was bought. The pool is recorded again. A buy can follow " + WAIT_TEXT + ".";
  return "The pool is recorded. A buy can follow " + WAIT_TEXT + ".";
}
/// The events of a transaction that just confirmed, read back from the chain.
async function eventsOf(sig) {
  for (let i = 0; i < 10; i++) {
    try { const tx = await ctx.connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); if (tx) return H.eventsFromTransaction(tx, OUR); } catch (_) {}
    await sleep(300);
  }
  return [];
}

async function runBuyback(btn) {
  FAIL_NOTE = null;
  const label = btn.textContent;
  try {
    const user = requireWallet();
    btn.disabled = true; btn.textContent = "Confirm in your wallet";
    const pool = (await ctx.client.pool(S.pool.address)) || S.pool;
    // the SDK works out what this call does, what a buy may spend and a floor for what it buys
    const plan = await ctx.client.buybackInstructions(user, pool);
    if (!plan) throw new Error("The treasury is still below the minimum, so there is nothing to buy back yet.");
    if (!plan.due) throw new Error("The pool was recorded less than " + H.BURN_INTERVAL_SLOTS + " slots ago. The next call opens " + dueText(plan.dueSlot, plan.slot) + ".");
    const sig = await sendIxs(plan.instructions, [], "buyback");
    toast(outcomeText(await runOutcome(sig, "BuybackExecuted", plan), "Buyback"), "ok", { href: explorer("tx", sig), text: "View" });
    await refreshPool(); await renderHook(true); await refreshSwaps(true);
  } catch (e) { toast(e.message, "err"); failNote(btn, e.message); btn.textContent = label; btn.disabled = false; await renderHook(true); }
}

// ---- a coin on the launch rules template ---------------------------------------------------------
// Its rules are fixed at launch and are stated as facts from its config. What moves is read
// again after every trade and on the page's timer: what is staked, what waits, what was burned,
// the lock. Between two reads the clock moves the sniper fee and the countdowns (tickRules).

function isRules() { return !!(S.info && S.info.template === "rules" && S.info.rules); }
/// A strict coin: a Token-2022 coin whose transfer hook is the rules program.
function isStrictCoin() { return STRICT_MODULES && isRules() && !!(RU.st && RU.st.strict); }
/// The slot and the chain's clock right now, worked out from the last read.
function ruSlot() { return RU.st ? slotSince(RU.st.slot, RU.at) : 0n; }
function ruUnix() { return RU.st ? RU.st.unixTime + BigInt(Math.max(0, Math.floor((Date.now() - RU.at) / 1000))) : 0n; }
/// Everything the page shows about a rules coin (its state, the wallet's stake or holder record,
/// the lock and the next burn) comes with the pool's read (refreshPool, client.poolView, whose
/// `rules` is client.rulesView of the same slot).
/// What a rules view says, into RU. null: the rules account was not found.
function applyRules(rv) {
  if (!rv) { RU.error = "The coin's rules account was not found on " + ctx.cluster + "."; return; }
  RU.error = "";
  RU.st = rv.state; RU.stake = rv.stake; RU.lock = rv.lock; RU.run = rv.run; RU.holder = rv.holder; RU.at = Date.now();
  S.info.rules = rv.state.config;
  RU.phase = rulesPhase();
}
/// Which side of each of its moments the coin is on. A change means the page has to read again.
function rulesPhase() {
  if (!RU.st) return "";
  const c = RU.st.config, slot = ruSlot(), now = ruUnix();
  return [
    H.rulesSniperFee(slot, c.startSlot, c.sniperSlots, c.sniperStartFeeBps, S.pool.lpFeeBps) !== null, !!H.rulesBuyLimit(c, slot),
    !!RU.run && !RU.run.due && slot < RU.run.dueSlot, !!RU.stake && RU.stake.staked > 0n && slot < RU.stake.unstakeOpenSlot,
    !!RU.lock && RU.lock.vaultBalance > 0n && now < RU.lock.unlockAt,
  ].join();
}
/// The rules in the hook card: what a buy and a sell pay, and the two windows.
function rulesParams(st) {
  const c = st.config, pool = S.pool, cap = S.plat.maxHookFeeBps, slot = ruSlot();
  const out = [];
  const pc = (bps) => fmtPct(bps);
  const rows = [];
  const row = (name, buy, sell, cls) => rows.push(el("tr", { class: cls || null }, el("td", { text: name }), el("td", { text: pc(buy) }), el("td", { text: pc(sell) })));
  if (c.buy.creatorBps || c.sell.creatorBps) row("Creator fee", c.buy.creatorBps, c.sell.creatorBps);
  if (c.buy.holdersBps || c.sell.holdersBps) row(c.kind === H.RULES_KIND.STRICT ? "Rewards for holders" : "Rewards for stakers", c.buy.holdersBps, c.sell.holdersBps);
  if (c.buy.burnBps || c.sell.burnBps) row("Burn", c.buy.burnBps, c.sell.burnBps);
  row("Pool fee", pool.lpFeeBps, pool.lpFeeBps);
  row("Protocol fee", S.plat.protocolFeeBps, S.plat.protocolFeeBps);
  const hookBuy = H.rulesHookFeeBps(c, DIRECTION.BUY, cap), hookSell = H.rulesHookFeeBps(c, DIRECTION.SELL, cap);
  row("In total", S.plat.protocolFeeBps + pool.lpFeeBps + hookBuy, S.plat.protocolFeeBps + pool.lpFeeBps + hookSell, "sum");
  out.push(el("table", { class: "rates", id: "ruRates" }, el("thead", null, el("tr", null, el("th", { text: "A trade pays" }), el("th", { text: "Buy" }), el("th", { text: "Sell" }))), el("tbody", null, ...rows)));
  // a coin launched on the template with every rule left off
  const bare = rows.length === 3 && c.sniperSlots === 0n && c.maxBuyQuote === 0n && c.creatorLockSeconds === 0n;
  if (bare) out.push(el("p", { class: "help", id: "ruBare", text: "No rule was switched on at launch. This coin trades like a pool without a hook." }));
  out.push(el("p", { class: "help", id: "ruNever", text: bare ? "That can never change. The program has no instruction that changes a rule." : "These rules can never change. The program has no instruction that changes one." }));
  const kv = [];
  const fee = H.rulesSniperFee(slot, c.startSlot, c.sniperSlots, c.sniperStartFeeBps, pool.lpFeeBps);
  const notes = [];
  if (c.sniperSlots > 0n) {
    const span = fmtSpan(slotsToSeconds(c.sniperSlots));
    if (fee !== null) {
      kv.push(el("dt", { text: "Pool fee of a buy right now" }), el("dd", { class: "accent", id: "ruSniperFee", text: pc(Math.min(fee, S.plat.maxFeeOverrideBps)) }),
        el("dt", { text: "Sniper fee ends" }), el("dd", { id: "ruSniperLeft", text: dueText(c.startSlot + c.sniperSlots, slot) }));
      notes.push("The sniper fee started at " + pc(c.sniperStartFeeBps) + " and falls every slot to the pool fee of " + pc(pool.lpFeeBps) + ". It stays in the pool. Nobody can add liquidity until it ends. Sells pay the pool fee.");
    } else {
      kv.push(el("dt", { text: "Sniper fee" }), el("dd", { id: "ruSniperLeft", text: "ended" }));
      notes.push("A sniper fee ran for the first " + span + ", from " + pc(c.sniperStartFeeBps) + " down to the pool fee. Buys pay the pool fee of " + pc(pool.lpFeeBps) + " now.");
    }
  }
  if (c.maxBuyQuote > 0n) {
    const lim = H.rulesBuyLimit(c, slot), amount = fmtUnits(c.maxBuyQuote, S.quoteDec, 6) + " " + S.quoteSym;
    if (lim) {
      kv.push(el("dt", { text: "Most one buy can spend" }), el("dd", { class: "accent", text: amount }),
        el("dt", { text: "Buy limit ends" }), el("dd", { id: "ruLimitLeft", text: dueText(lim.untilSlot, slot) }));
      notes.push("The limit is per trade, so a wallet can split a large buy into several. Sells are never limited.");
    } else {
      kv.push(el("dt", { text: "Buy limit" }), el("dd", { id: "ruLimitLeft", text: "ended" }));
      notes.push("For the first " + fmtSpan(slotsToSeconds(c.limitSlots)) + " one buy could spend " + amount + " at most. That limit is over.");
    }
  }
  if (kv.length) out.push(el("dl", { class: "kv", id: "ruWindows" }, ...kv), ...notes.map((t) => el("p", { class: "help", text: t })));
  return out;
}

/// Once a second: what the clock moves on a rules coin and on a run that waits, without a
/// read. When a window ends or something opens, the chain is read and the cards are drawn again.
function tick() {
  if (document.hidden) return;
  const put = (id, text) => { const n = $(id); if (n && n.textContent !== text) n.textContent = text; };
  // a launch guard: its fee and its window follow the slot, worked out from the last read
  if (S.info && S.info.guard && (S.guardTick = (S.guardTick || 0) + 1) % 8 === 0) { renderHook(); renderLiq(); }
  // a buyback run the chain refuses for a few more slots
  if (S.run && !S.run.due) {
    const slot = slotSince(S.run.slot, S.runAt);
    put("runDue", dueText(S.run.dueSlot, slot));
    if (slot >= S.run.dueSlot && !S.runAsked) { S.runAsked = true; refreshPool().then(() => { S.runAsked = false; }); }
  }
  if (!isRules() || !RU.st) return;
  const c = RU.st.config, slot = ruSlot(), now = ruUnix();
  const fee = H.rulesSniperFee(slot, c.startSlot, c.sniperSlots, c.sniperStartFeeBps, S.pool.lpFeeBps);
  if (fee !== null) { put("ruSniperFee", fmtPct(Math.min(fee, S.plat.maxFeeOverrideBps))); put("ruSniperLeft", dueText(c.startSlot + c.sniperSlots, slot)); }
  const lim = H.rulesBuyLimit(c, slot);
  if (lim) put("ruLimitLeft", dueText(lim.untilSlot, slot));
  if (RU.run && !RU.run.due) put("runDue", dueText(RU.run.dueSlot, slot));
  if (RU.stake && RU.stake.staked > 0n && slot < RU.stake.unstakeOpenSlot) put("ruUnstakeIn", dueText(RU.stake.unstakeOpenSlot, slot));
  if (RU.lock && RU.lock.vaultBalance > 0n && now < RU.lock.unlockAt) put("ruLockIn", "in " + fmtSpan(Number(RU.lock.unlockAt - now)));
  const w = liquidityWindow(S.info, slot);
  if (w) put("liqOpens", "in about " + fmtSpan(Math.max(1, Math.ceil(w.seconds))));
  if (rulesPhase() !== RU.phase && !RU.asked) { RU.asked = true; refreshPool().then(() => { RU.asked = false; }); }
}

/// The card under the chart of a rules coin: staking, the burn, the creator's fee, the lock.
/// The amount field of the staking form is one node kept across draws, so a poll never takes
/// away what is being typed.
function renderRulesCard(force) {
  renderStrict();
  const card = $("rulesCard");
  if (!isRules()) { card.hidden = true; return; }
  if (!RU.st) {
    card.hidden = !RU.error;
    if (RU.error) card.replaceChildren(el("section", { class: "panel" }, el("h2", { class: "panel-title", text: "Modules" }), el("p", { class: "error-text", id: "rulesError", text: RU.error })));
    return;
  }
  const st = RU.st, c = st.config, s = st.settled, k = Wallet.current().publicKey, slot = ruSlot(), now = ruUnix();
  const mine = !!k && c.creator.equals(k);
  const drawn = [walletKey(), JSON.stringify([s.totalStaked, st.stakersEligible, s.totalRewardsPaid, st.burnPot, s.totalBaseBurned, s.totalQuoteBurned, s.burns, st.creatorClaimable, s.totalCreatorPaid,
    RU.stake ? [RU.stake.staked, RU.stake.claimable, RU.stake.unstakeOpenSlot, RU.stake.shareBps] : null, RU.lock ? [RU.lock.vaultBalance, RU.lock.unlockAt, !!RU.lock.record] : null,
    RU.run ? [RU.run.step, RU.run.due, RU.run.reason || "", RU.run.dueSlot, RU.run.spend, RU.run.expectedOut, RU.run.potLeft] : null, S.balances.base, S.balances.wsol === null, S.pool.reserveQuote], plain), RU.phase, RU.rent, RU.holderRent].join("|");
  if (!force && drawn === RU.drawn) return;
  RU.drawn = drawn;
  const q = (v, frac = 6) => fmtUnits(v, S.quoteDec, frac) + " " + S.quoteSym;
  const coin = (v, frac = 2) => fmtUnits(v, S.baseDec, frac) + " " + S.symbol;
  const row = (kText, v, cls, id) => [el("dt", { text: kText }), el("dd", { class: cls || null, id: id || null, text: v })];
  const blocks = [];
  const wrappedNote = k && S.quoteIsSol && S.balances.wsol !== null ? " Your wallet keeps a wrapped SOL account, so it arrives there as wrapped SOL." : "";

  // ---- staking
  const pays = c.buy.holdersBps > 0 || c.sell.holdersBps > 0;
  if (isStrictCoin()) {
    if (pays || s.totalRewardsPaid > 0n) blocks.push(holderBlock(st, c, k, q, coin, row, wrappedNote, pays));
  } else if (pays || s.totalStaked > 0n || (RU.stake && RU.stake.staked > 0n)) {
    const share = fmtPct(10_000 / Number(H.RULES_ELIGIBLE_DIVISOR));
    const need = s.minEligible > s.totalStaked ? s.minEligible - s.totalStaked : 0n;
    const kv = [
      ...row("Staked by all wallets", coin(s.totalStaked), "", "ruStaked"),
      ...row("Rewards right now", !pays ? "none on this coin" : st.stakersEligible ? "paid to stakers" : "burned for now", pays && st.stakersEligible ? "accent" : "", "ruPaying"),
      ...row("Payments start at " + share, coin(s.minEligible, 0) + " staked", "", "ruStart"),
      ...row("Claimed by stakers so far", q(s.totalRewardsPaid)),
    ];
    if (k) kv.push(...row("Your stake", RU.stake && RU.stake.staked > 0n ? coin(RU.stake.staked) + ", " + fmtPct(RU.stake.shareBps) + " of all" : "0 " + S.symbol, "", "ruMyStake"), ...row("You can claim", q(RU.stake ? RU.stake.claimable : 0n, 9), RU.stake && RU.stake.claimable > 0n ? "accent" : "", "ruClaimable"));
    const state = !pays ? "This coin sets no share of its trades aside for stakers, so a stake earns nothing."
      : st.stakersEligible ? "Wallets that stake share " + sidesText(c.buy.holdersBps, c.sell.holdersBps) + ", in " + S.quoteSym + ". A wallet that only holds the coin earns nothing."
      : "Less than " + share + " of the supply is staked, so the stakers' share buys and burns the coin for now. Payments to stakers start once " + coin(s.minEligible, 0) + " are staked. That takes " + coin(need) + " more.";
    if (!RU.amount) {
      RU.amount = el("input", { class: "input num", id: "ruAmount", type: "text", inputmode: "decimal", placeholder: "0.0", autocomplete: "off", "aria-label": "Coins to stake or to unstake" });
      RU.result = el("div", { class: "tx-result", id: "ruStakeResult", "aria-live": "polite" });
    }
    const stakeBtn = el("button", { class: "btn btn-sm btn-primary", type: "button", id: "ruStake", text: "Stake" });
    const canUnstake = !!RU.stake && RU.stake.staked > 0n && slot >= RU.stake.unstakeOpenSlot;
    const unstakeBtn = el("button", { class: "btn btn-sm", type: "button", id: "ruUnstake", disabled: !canUnstake, text: "Unstake" });
    const claimBtn = el("button", { class: "btn btn-sm", type: "button", id: "ruClaim", disabled: !(RU.stake && RU.stake.claimable > 0n), text: "Claim" });
    stakeBtn.addEventListener("click", () => stakeAct(stakeBtn, true));
    unstakeBtn.addEventListener("click", () => stakeAct(unstakeBtn, false));
    claimBtn.addEventListener("click", () => claimAct(claimBtn, "rewards"));
    const fill = (v) => () => { RU.amount.value = fmtUnits(v, S.baseDec, S.baseDec).replace(/,/g, ""); RU.amount.focus(); };
    const delay = fmtSpan(slotsToSeconds(H.UNSTAKE_DELAY_SLOTS));
    const unstakeLine = !k ? ["Staked coins can be taken out about " + delay + " after the wallet's last stake. Each new stake restarts that time."]
      : RU.stake && RU.stake.staked > 0n && !canUnstake ? ["Unstake opens about " + delay + " after your last stake, ", el("span", { id: "ruUnstakeIn", text: dueText(RU.stake.unstakeOpenSlot, slot) }), ". Each new stake restarts that time."]
      : canUnstake ? ["You can unstake now. A new stake closes it again for about " + delay + "."]
      : ["Staked coins can be taken out about " + delay + " after your last stake. Each new stake restarts that time." + (RU.rent ? " Your first stake opens an account that costs " + q(RU.rent) + " of rent, which does not come back." : "")];
    blocks.push(el("div", { class: "rule-block", id: "ruStaking" }, el("h4", { text: "Staking" }), el("dl", { class: "kv" }, ...kv),
      el("p", { class: "help", id: "ruStakeState", text: state }),
      el("div", { class: "rule-acts" }, el("div", { class: "input-wrap" }, RU.amount, el("span", { class: "suffix", text: S.symbol })), stakeBtn, unstakeBtn, claimBtn),
      k ? el("div", { class: "balance" }, el("span", null, "In your wallet " + coin(S.balances.base) + " ", el("button", { type: "button", id: "ruMaxWallet", text: "Max", onclick: fill(S.balances.base) })),
        RU.stake && RU.stake.staked > 0n ? el("span", null, "Staked " + coin(RU.stake.staked) + " ", el("button", { type: "button", id: "ruMaxStaked", text: "Max", onclick: fill(RU.stake.staked) })) : null) : null,
      el("p", { class: "help", id: "ruUnstakeLine" }, ...unstakeLine),
      RU.result));
  }

  // ---- the burn. A coin with rewards feeds the pot too, while too little is staked.
  if (c.buy.burnBps > 0 || c.sell.burnBps > 0 || pays || s.burns > 0n) {
    const run = RU.run;
    const w = runWords(run, { buy: "Buy and burn", pot: "pot", empty: "Nothing waits in the pot." });
    const btn = el("button", { class: "btn btn-sm", type: "button", id: "ruBurn", disabled: w.disabled, text: w.label });
    btn.addEventListener("click", () => burnAct(btn));
    const cap = H.rulesBurnCapBps(c, S.plat, S.pool.lpFeeBps);
    blocks.push(el("div", { class: "rule-block", id: "ruBurnBlock" }, el("h4", { text: "Burn" }), el("dl", { class: "kv" },
      ...row("Waits in the pot", q(st.burnPot, 9), st.burnPot > 0n ? "accent" : "", "ruPot"),
      ...row("One run spends at most", fmtPct(cap) + " of the pool's " + S.quoteSym),
      ...row("Burned so far", coin(s.totalBaseBurned), "", "ruBurned"),
      ...row("Spent on it so far", q(s.totalQuoteBurned)),
      ...row("Runs that bought", fmtInt(s.burns), "", "ruBurns")),
      el("p", { class: "help", id: "ruBurnNote" }, ...w.nodes),
      el("div", { class: "rule-acts" }, btn),
      el("p", { class: "help", text: "A run buys the coin with a slice of the pot and burns what it buys. It buys against a price the pool had at least " + H.BURN_INTERVAL_SLOTS + " slots earlier, and it waits while the price climbs." })));
  }

  // ---- the creator's fee
  if (c.buy.creatorBps > 0 || c.sell.creatorBps > 0 || st.creatorClaimable > 0n || s.totalCreatorPaid > 0n) {
    const kids = [el("h4", { text: "Creator fee" }), el("dl", { class: "kv" },
      ...row("Creator", short(c.creator.toBase58(), 5) + (mine ? ", your wallet" : "")),
      ...row("Waits for the creator", q(st.creatorClaimable, 9), st.creatorClaimable > 0n ? "accent" : "", "ruCreatorWaits"),
      ...row("Claimed so far", q(s.totalCreatorPaid), "", "ruCreatorPaid"))];
    if (mine) {
      const btn = el("button", { class: "btn btn-sm btn-primary", type: "button", id: "ruClaimCreator", disabled: st.creatorClaimable === 0n, text: "Claim" });
      btn.addEventListener("click", () => claimAct(btn, "creator"));
      kids.push(el("p", { class: "help", text: "You launched this coin, so its creator fee is yours. Claim pays it to your wallet in " + S.quoteSym + "." + wrappedNote }), el("div", { class: "rule-acts" }, btn));
    } else kids.push(el("p", { class: "help", text: "Only the wallet that launched the coin can claim it. Nobody can change who that is." }));
    blocks.push(el("div", { class: "rule-block", id: "ruCreator" }, ...kids));
  }

  // ---- the lock: what the lock account holds, not what was declared
  const L = RU.lock;
  if (L && (L.declaredSeconds > 0n || L.record)) {
    // on a strict coin the lock is a floor on the creator's own account: what is locked is the record's amount, not what the account holds
    const held = isStrictCoin() ? (L.record ? L.record.amount : 0n) : L.vaultBalance, supply = S.mint ? S.mint.supply : 0n;
    const kids = [el("h4", { text: "Creator lock" })];
    const declared = L.declaredSeconds > 0n ? "At launch the creator declared a lock of " + fmtSpan(Number(L.declaredSeconds)) + "." : "";
    if (held > 0n) {
      const open = now >= L.unlockAt;
      kids.push(el("dl", { class: "kv" },
        ...row(isStrictCoin() ? "In the creator's wallet" : "In the lock account", coin(held) + (supply > 0n ? ", " + fmtShare(held, supply) + " of the supply" : ""), "accent", "ruLocked"),
        ...row(open ? "Lock ended" : "Locked until", fmtDate(L.unlockAt), "", "ruLockDate"),
        ...row("Opens", open ? "now" : "in " + fmtSpan(Number(L.unlockAt - now)), "", "ruLockIn")));
      kids.push(el("p", { class: "help", id: "ruLockState", text: (open ? "The date has passed. The creator can take these coins out now." : "The creator cannot take these coins out before that date.") + " The lock holds the coins in this account only. It says nothing about coins the creator holds elsewhere." }));
      if (mine) {
        const btn = el("button", { class: "btn btn-sm", type: "button", id: "ruUnlock", disabled: !open, text: "Unlock" });
        btn.addEventListener("click", () => unlockAct(btn));
        kids.push(el("div", { class: "rule-acts" }, btn));
      }
    } else {
      kids.push(el("dl", { class: "kv" }, ...row(isStrictCoin() ? "Locked in the creator's wallet" : "In the lock account", "nothing is locked", "", "ruLocked")));
      kids.push(el("p", { class: "help", id: "ruLockState", text: L.record ? (declared + " The lock ended and the creator took the coins out.").trim() : (declared + " No coins were put into the lock account. A declared lock is only a statement. What is locked is what this account holds.").trim() }));
    }
    kids.push(el("div", { class: "small dim", style: "margin-top:8px;display:flex;align-items:center;gap:4px;flex-wrap:wrap" }, isStrictCoin() ? "The creator's coin account " : "Lock account ", el("span", { class: "mono", text: short(L.vault.toBase58(), 5), title: L.vault.toBase58() }), copyButton(L.vault.toBase58(), "Copy the lock account")));
    blocks.push(el("div", { class: "rule-block", id: "ruLock" }, ...kids));
  }
  if (!blocks.length) { card.hidden = true; return; }
  const active = document.activeElement === RU.amount ? { a: RU.amount.selectionStart, b: RU.amount.selectionEnd } : null;
  const of = (id) => blocks.find((x) => x.id === id) || null;
  const panel = (title, parts) => (parts.some(Boolean) ? el("section", { class: "panel" }, el("h2", { class: "panel-title", text: title }), el("div", { class: "rule-blocks" }, ...parts.filter(Boolean))) : null);
  card.replaceChildren(...[panel("Rewards", [of("ruStaking") || of("ruHolders")]), panel("Burn", [of("ruBurnBlock")]), panel("Creator", [of("ruCreator"), of("ruLock")])].filter(Boolean));
  renderStrict();
  applyFailNote();
  card.hidden = false;
  if (active && card.contains(RU.amount)) { RU.amount.focus(); try { RU.amount.setSelectionRange(active.a, active.b); } catch (_) {} }
}
/// "1% of every buy and 2% of every sell", as the SDK's own sentences word it.
function sidesText(buy, sell) {
  if (buy === sell) return fmtPct(buy) + " of every buy and every sell";
  if (sell === 0) return fmtPct(buy) + " of every buy and nothing on sells";
  if (buy === 0) return fmtPct(sell) + " of every sell and nothing on buys";
  return fmtPct(buy) + " of every buy and " + fmtPct(sell) + " of every sell";
}
const ruSay = (cls, text) => { if (RU.result) RU.result.replaceChildren(el("span", { class: cls, text })); };
/// After an action on a rules coin: the pool, the rules and the wallet again, in one read (refreshPool), then every card.
async function refreshRules() { await refreshPool(); renderRulesCard(true); renderStrict(); await renderHook(true); drawHeadTags(); }

async function stakeAct(btn, staking) {
  const label = btn.textContent;
  let user;
  try { user = requireWallet(); } catch (_) { $("walletBtn").click(); return; }
  const amount = parseUnits(RU.amount.value, S.baseDec);
  if (!amount || amount <= 0n) { RU.amount.focus(); ruSay("muted", "Type how many " + S.symbol + " to " + (staking ? "stake." : "unstake.")); return; }
  if (staking && amount > S.balances.base) { ruSay("bad", "Your wallet holds less " + S.symbol + " than that."); return; }
  if (!staking && (!RU.stake || amount > RU.stake.staked)) { ruSay("bad", "That is more than you have staked."); return; }
  if (RU.busy) return;
  RU.busy = true; btn.disabled = true; btn.textContent = "Confirm in your wallet"; RU.result.replaceChildren();
  try {
    const pool = (await ctx.client.pool(S.pool.address)) || S.pool;
    const ixs = staking ? await ctx.client.rulesStakeInstructions(user, pool, amount) : await ctx.client.rulesUnstakeInstructions(user, pool, amount);
    const sig = await sendIxs(ixs, [], staking ? "stake" : "unstake");
    RU.amount.value = "";
    const text = staking ? "Staked " + fmtUnits(amount, S.baseDec, 2) + " " + S.symbol + ". It earns from the next trade on." : "Unstaked " + fmtUnits(amount, S.baseDec, 2) + " " + S.symbol + ". The coins are back in your wallet.";
    toast(text, "ok", { href: explorer("tx", sig), text: "View" });
    RU.result.replaceChildren(el("span", { class: "ok", text: text + " " }), el("a", { class: "link", href: explorer("tx", sig), target: "_blank", rel: "noopener", text: short(sig, 6) }));
  } catch (e) { ruSay("bad", e.message); }
  RU.busy = false; btn.textContent = label;
  await refreshRules();
}
/// Claim the wallet's rewards, or the creator's fee. The amount in the message is the one the chain paid.
async function claimAct(btn, what) {
  FAIL_NOTE = null;
  const label = btn.textContent;
  let user;
  try { user = requireWallet(); } catch (_) { $("walletBtn").click(); return; }
  btn.disabled = true; btn.textContent = "Confirm in your wallet";
  try {
    const pool = (await ctx.client.pool(S.pool.address)) || S.pool;
    // read right before building, the way the SDK does: a wrapped SOL account that is open now stays open
    const wrapped = S.quoteIsSol && (await wrappedSol(user)) !== null;
    const plan = what === "creator" ? await ctx.client.rulesClaimCreatorInstructions(user, pool) : await ctx.client.rulesClaimRewardsInstructions(user, pool);
    if (!plan.instructions.length) throw new Error("There is nothing to claim right now.");
    const sig = await sendIxs(plan.instructions, [], "claim");
    const ev = (await eventsOf(sig)).find((e) => e.kind === (what === "creator" ? "CreatorClaimed" : "RewardsClaimed") && e.pool.equals(S.pool.address));
    const paid = ev ? ev.amount : plan.amount;
    toast("Claimed " + fmtUnits(paid, S.quoteDec, 9) + " " + S.quoteSym + (what === "creator" ? " of creator fee." : " of rewards.") + (wrapped ? " It arrived as wrapped SOL in your wrapped SOL account." : ""), "ok", { href: explorer("tx", sig), text: "View" });
  } catch (e) { toast(e.message, "err"); failNote(btn, e.message); }
  btn.textContent = label;
  await refreshRules();
}
async function burnAct(btn) {
  FAIL_NOTE = null;
  const label = btn.textContent;
  let user;
  try { user = requireWallet(); } catch (_) { $("walletBtn").click(); return; }
  btn.disabled = true; btn.textContent = "Confirm in your wallet";
  try {
    // the SDK works out what this call does now, what a buy may spend and a floor for what it buys
    const plan = await ctx.client.rulesBurnInstructions(user, S.pool.address);
    if (!plan) throw new Error("Nothing waits in the burn pot.");
    if (!plan.due) throw new Error("The pool was recorded less than " + H.BURN_INTERVAL_SLOTS + " slots ago. The next call opens " + dueText(plan.dueSlot, plan.slot) + ".");
    const sig = await sendIxs(plan.instructions, [], "burn");
    toast(outcomeText(await runOutcome(sig, "BurnExecuted", plan), "Burn"), "ok", { href: explorer("tx", sig), text: "View" });
    await refreshSwaps(true);
  } catch (e) { toast(e.message, "err"); failNote(btn, e.message); }
  btn.textContent = label;
  await refreshRules();
}
async function unlockAct(btn) {
  FAIL_NOTE = null;
  const label = btn.textContent;
  let user;
  try { user = requireWallet(); } catch (_) { $("walletBtn").click(); return; }
  btn.disabled = true; btn.textContent = "Confirm in your wallet";
  try {
    const pool = (await ctx.client.pool(S.pool.address)) || S.pool;
    const sig = await sendIxs(await ctx.client.rulesUnlockInstructions(user, pool), [], "unlock");
    const ev = (await eventsOf(sig)).find((e) => e.kind === "CreatorUnlocked" && e.pool.equals(S.pool.address));
    toast("Unlocked." + (ev ? " " + fmtUnits(ev.amount, S.baseDec, 2) + " " + S.symbol + " are back in your wallet." : " The coins are back in your wallet."), "ok", { href: explorer("tx", sig), text: "View" });
  } catch (e) { toast(e.message, "err"); failNote(btn, e.message); }
  btn.textContent = label;
  await refreshRules();
}

/// Pay the hook fees that wait in the pool into the hook's treasury. Anyone can send it.
async function payHookFees(btn) {
  FAIL_NOTE = null;
  try {
    const user = requireWallet();
    btn.disabled = true; btn.textContent = "Confirm in your wallet";
    const pool = (await ctx.client.pool(S.pool.address)) || S.pool;
    const ixs = await ctx.client.hookFeesInstructions(user, pool);
    if (!ixs.length) toast("Nothing is waiting any more.");
    else {
      const sig = await sendIxs(ixs, [], "payout");
      toast(fmtUnits(pool.hookFeesOwedQuote, S.quoteDec, 6) + " " + S.quoteSym + " paid to the hook's treasury.", "ok", { href: explorer("tx", sig), text: "View" });
    }
  } catch (e) { toast(e.message, "err"); failNote(btn, e.message); btn.textContent = "Pay them out"; btn.disabled = false; }
  await refreshPool();
}

async function renderWatcher(card) {
  if (!ctx.watcherUrl) return;
  if (!S.watcher) S.watcher = await fetchJson(ctx.watcherUrl + "/pools.json", 5000);
  const w = S.watcher;
  const v = w && w.pools && w.pools[S.pool.address.toBase58()];
  if (!v) return;
  const cls = v.score === "clean" ? "ok" : v.score === "danger" ? "bad" : "accent";
  const buy = simWords(v.buySim), sell = simWords(v.sellSim);
  const box = el("div", { class: "watch" },
    el("div", { style: "display:flex;justify-content:space-between;gap:8px;align-items:baseline" },
      el("span", null, "Watcher: ", el("span", { class: "score " + cls, text: String(v.score || "") })),
      el("span", { class: "dim small", text: v.lastCheck ? "checked " + timeAgo((Date.now() - Date.parse(v.lastCheck)) / 1000) : "" })),
    el("dl", { class: "kv", style: "margin-top:8px" },
      el("dt", { text: "Buy simulation" }), el("dd", { class: buy.cls, text: buy.text }),
      el("dt", { text: "Sell simulation" }), el("dd", { class: sell.cls, text: sell.text }),
      el("dt", { text: "Effective buy tax" }), el("dd", { text: v.effectiveBuyTaxBps === null || v.effectiveBuyTaxBps === undefined ? "not measured" : fmtPct(v.effectiveBuyTaxBps) }),
      el("dt", { text: "Effective sell tax" }), el("dd", { text: v.effectiveSellTaxBps === null || v.effectiveSellTaxBps === undefined ? "not measured" : fmtPct(v.effectiveSellTaxBps) }),
      el("dt", { text: "Config changes" }), el("dd", { text: String((v.configChanges || []).length) })));
  // a buyback or a rules coin: what the watcher's own keeper did with the treasury or the burn pot so far
  const keeper = v.burn && v.burn.keeper && v.burn.keeper.calls > 0 ? v.burn.keeper : null;
  if (keeper) {
    const when = keeper.lastAt && isFinite(Date.parse(keeper.lastAt)) ? timeAgo((Date.now() - Date.parse(keeper.lastAt)) / 1000) : "";
    const did = { observed: "recorded the pool", waited: "recorded the pool again", bought: "bought and burned", failed: "failed" }[keeper.lastOutcome] || "";
    box.querySelector("dl").append(
      el("dt", { text: "Keeper runs" }), el("dd", { text: fmtInt(keeper.calls) + " sent, " + fmtInt(keeper.bought) + " bought" }),
      el("dt", { text: "Keeper spent on burns" }), el("dd", { text: fmtUnits(BigInt(Math.max(0, Math.trunc(Number(keeper.spentLamports) || 0))), S.quoteDec, 6) + " " + S.quoteSym }),
      el("dt", { text: "Keeper's last run" }), el("dd", { class: keeper.lastOutcome === "failed" ? "bad" : "", text: [when, did].filter(Boolean).join(", ") }));
  }
  const alerts = (v.alerts || []).slice(-3).reverse();
  if (alerts.length) box.append(el("ul", null, ...alerts.map((a) => el("li", { class: a.level === "danger" ? "bad" : a.level === "warning" ? "accent" : "", text: watcherWords(a.message) }))));
  card.replaceChildren(el("h2", { class: "panel-title", text: "Watcher" }), box);
  card.hidden = false;
}
/// A text of the watcher's report for a visitor: never an RPC's raw answer. A failure of the
/// watcher's own reads (an error that starts with "watcher:", or one that carries an RPC status
/// or JSON) is said as such, in plain words; anything else is cut to one plain sentence without
/// addresses or JSON.
function watcherWords(text) {
  const s = String(text || "");
  if (!s) return "";
  if (/^watcher:/i.test(s) || /\b(403|429|50[0-4])\s+[A-Z][a-z]/.test(s) || /forbidden|jsonrpc|dedicated node|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(s)) return "The watcher could not read the chain for this check.";
  return plainError(s);
}
/// One simulation of the watcher's report ({ ok, error } or a skipped one with a note) as the
/// card says it: passes, fails and why, or not run and why.
function simWords(sim) {
  if (!sim) return { text: "", cls: "" };
  if (sim.ok === true) return { text: "passes", cls: "ok" };
  const why = sim.error || sim.note || (typeof sim.skipped === "string" ? sim.skipped : "") || sim.reason || "";
  // "setup: ...": the watcher could not set its own test up (no wallet holds the coin to sell
  // from, the probe wallet is short, ...). That is no verdict on the coin.
  const setup = /^setup:/i.test(String(why));
  const said = setup && /no holder/i.test(String(why))
    ? "No wallet that holds this coin was found to test a sell with"
    : watcherWords(String(why).replace(/^setup:\s*/i, "")).replace(/\.$/, "");
  // the watcher's own reads failed, or it skipped the check (no holder to sell from): no verdict on the coin
  if (sim.ok !== false || sim.skipped || setup || /^watcher:/i.test(String(why)) || said === "The watcher could not read the chain for this check") {
    return { text: "not run" + (said ? ". " + said.charAt(0).toUpperCase() + said.slice(1) + "." : ""), cls: "" };
  }
  return { text: "fails" + (said ? ", " + said : ""), cls: "bad" };
}

// ---- a strict coin ------------------------------------------------------------------------------------
// A strict coin (launch-strict.js) runs the rules program inside every transfer. Where its parts
// go once the SDK has strict coins:
// - #strictCard, right under the Modules panel: what applies to the connected wallet. How much
//   more it may hold under the max wallet, its early coins and when they unlock, and whether it
//   is registered for rewards without staking, with the button that registers it and the claim.
// - the trade box (T.note): the same facts for the buy or the sell that is typed, in the
//   sentences of RULES.md "What can make a sell or a send fail" (STRICT-CHANGES.md section 7),
//   before the button is pressed.
// - the Rewards panel: rewards for holders in place of staking (stake and unstake are refused).
// - the Burn panel: the same button, through run_burn_strict.
// - the Creator panel: the lock is a floor on the creator's own wallet, read from the same
//   LockRecord. There is no lock vault.
// - the Liquidity panel: deposits are refused while the max wallet runs.
// Until then the switch is off and #strictCard stays hidden.
const ST = { to: null, amount: null, btn: null, result: null, drawn: "" };
/// A slot of this coin's windows as a time of day in the viewer's zone, from the chain's clock.
function slotWhen(target) { const now = ruSlot(); const secs = target > now ? Number(target - now) * SLOT_MS / 1000 : 0; return "about " + fmtDate(Math.floor(Date.now() / 1000 + secs)) + " (slot " + fmtInt(target) + ")"; }
/// What can hold back a sell or a send of this coin right now, in the sentences of RULES.md.
function strictRuleLines() {
  const x = RU.st.strict, out = [];
  if (x.earlyLocked) out.push("Coins bought from the pool in the early window cannot leave the wallet before the early unlock. The wallet's other coins can.");
  if (x.maxWalletRuns) out.push("While the max wallet runs, a buy or a send fails when it would leave the receiving wallet above the cap. A sell is never held by it.");
  if (x.earlyWindowRuns) out.push("A buy in the early window needs the buyer's holder record. This page opens it inside the buy.");
  if (RU.lock && RU.lock.locked) out.push("The creator's locked coins cannot leave the creator's wallet before " + fmtDate(RU.lock.unlockAt) + ". It holds the creator only.");
  if (!out.length) out.push("No rule of this coin holds back a sell or a send now. Coins outside the creator lock move freely.");
  out.push("A wallet can only receive this coin in its standard token account. The send form below uses it and creates it when it is missing.");
  return out;
}
function renderStrict() {
  const card = $("strictCard");
  const on = isStrictCoin();
  card.hidden = !on;
  if (!on) return;
  const st = RU.st, x = st.strict, c = st.config, h = RU.holder, k = Wallet.current().publicKey, slot = ruSlot();
  const coin = (v, frac = 2) => fmtUnits(v, S.baseDec, frac) + " " + S.symbol;
  const drawn = JSON.stringify([walletKey(), x, h ? [h.balance, h.earlyBought, h.earlyLocked, h.locked, h.creatorLocked, h.free] : null, RU.lock ? RU.lock.locked : null], plain);
  if (drawn === ST.drawn && card.childElementCount) return;
  ST.drawn = drawn;
  const row = (key, v, id) => [el("dt", { text: key }), el("dd", { id: id || null, text: v })];
  const rules = [
    ...row("Max wallet", c.maxWalletBps > 0 ? (x.maxWalletRuns ? coin(x.maxWalletAmount, 0) + " a wallet, until " + slotWhen(x.maxWalletUntil) : "ended") : "none", "stMaxWallet"),
    ...row("Early window", c.earlySlots > 0 ? (x.earlyWindowRuns ? "runs until " + slotWhen(x.earlyUntil) : "ended") : "none", "stEarly"),
    ...row("Early coins unlock", c.earlySlots > 0 ? (x.earlyLocked ? slotWhen(x.earlyUnlock) : "unlocked") : "none", "stUnlock"),
  ];
  const kids = [el("h2", { class: "panel-title", text: "Strict coin" }),
    el("p", { class: "muted", text: "A program of this coin's rules runs inside every transfer of it. Its rules are fixed." }),
    el("dl", { class: "kv" }, ...rules),
    el("h4", { style: "margin: 16px 0 6px", text: "What can hold back a sell or a send now" }),
    el("ul", { class: "check-lines", id: "stLines" }, ...strictRuleLines().map((t) => el("li", { text: t })))];
  if (k) {
    const mine = [...row("In your wallet", coin(h ? h.balance : S.balances.base), "stBalance")];
    if (h && h.earlyBought > 0n) mine.push(...row("Your early coins", coin(h.earlyBought) + (h.earlyLocked ? ", locked until " + slotWhen(h.earlyUnlock) : ", free"), "stMyEarly"));
    if (h && h.creatorLocked) mine.push(...row("Your creator lock", coin(h.locked) + " until " + fmtDate(h.lockedUntil), "stMyLock"));
    if (x.maxWalletRuns) mine.push(...row("Room under the max wallet", coin(x.maxWalletAmount > (h ? h.balance : S.balances.base) ? x.maxWalletAmount - (h ? h.balance : S.balances.base) : 0n), "stRoom"));
    if (h) mine.push(...row("Free to sell or send", coin(h.free), "stFree"));
    kids.push(el("h4", { style: "margin: 16px 0 6px", text: "Your wallet" }), el("dl", { class: "kv" }, ...mine));
    if (!ST.to) {
      ST.to = el("input", { class: "input mono", id: "stTo", placeholder: "wallet address", autocomplete: "off", spellcheck: "false", "aria-label": "Send to" });
      ST.amount = el("input", { class: "input num", id: "stAmount", inputmode: "decimal", placeholder: "0.0", autocomplete: "off", "aria-label": "Coins to send" });
      ST.btn = el("button", { class: "btn btn-primary", type: "button", id: "stSend", text: "Send" });
      ST.result = el("div", { class: "tx-result", id: "stResult", "aria-live": "polite" });
      ST.btn.addEventListener("click", () => strictSend(ST.btn));
    }
    kids.push(el("h4", { style: "margin: 16px 0 8px", text: "Send coins" }),
      el("div", { class: "send-coins" }, el("div", { class: "coin-to" }, ST.to), el("div", { class: "input-wrap" }, ST.amount, el("span", { class: "suffix", text: S.symbol })), ST.btn),
      el("p", { class: "help", text: "The page checks the coin's rules before your wallet opens, and creates the receiver's token account when it is missing." }), ST.result);
  }
  card.replaceChildren(...kids);
}
/// Rewards for holders on a strict coin: the record, what it earned, Register and Claim.
function holderBlock(st, c, k, q, coin, row, wrappedNote, pays) {
  const x = st.strict, s = st.settled, h = RU.holder;
  const share = fmtPct(10_000 / Number(H.RULES_ELIGIBLE_DIVISOR));
  const paying = pays && x.registered >= x.minRegistered;
  const kids = [el("h4", { text: "Rewards for holders" }), el("dl", { class: "kv" },
    ...row("Held by registered wallets", coin(x.registered), "", "ruRegistered"),
    ...row("Rewards right now", !pays ? "none on this coin" : paying ? "paid to registered holders" : "burned for now", paying ? "accent" : "", "ruPaying"),
    ...row("Payments start at " + share, coin(x.minRegistered, 0) + " registered", "", "ruStart"),
    ...row("Claimed by holders so far", q(s.totalRewardsPaid)))];
  kids.push(el("p", { class: "help", id: "ruHolderState", text: !pays ? "This coin sets no share of its trades aside for holders." : "Registered wallets share " + sidesText(c.buy.holdersBps, c.sell.holdersBps) + ", in " + S.quoteSym + ", by what they hold. Nothing is staked." + (paying ? "" : " While registered wallets hold less than " + share + " of the supply, that share buys and burns the coin.") }));
  if (k) {
    const registered = !!(h && h.record);
    kids.push(el("dl", { class: "kv", style: "margin-top: 10px" },
      ...row("Your wallet", registered ? "registered" : "not registered", registered ? "ok" : "", "ruMyRecord"),
      ...row("You can claim", q(h ? h.claimable : 0n, 9), h && h.claimable > 0n ? "accent" : "", "ruMyClaim")));
    const acts = [];
    if (!registered) { const b = el("button", { class: "btn btn-sm btn-primary", type: "button", id: "ruRegister", text: "Register" }); b.addEventListener("click", () => holderAct(b, "open")); acts.push(b); }
    const cl = el("button", { class: "btn btn-sm", type: "button", id: "ruClaimHolder", disabled: !(h && h.claimable > 0n), text: "Claim" });
    cl.addEventListener("click", () => holderAct(cl, "claim"));
    acts.push(cl);
    kids.push(el("div", { class: "rule-acts" }, ...acts),
      el("p", { class: "help", text: registered ? "Claim pays what your wallet earned in " + S.quoteSym + "." + wrappedNote : "Registering opens a small record for your wallet. It costs " + (RU.holderRent ? q(RU.holderRent) + " of rent, once." : "a small rent, once.") + " A buy on this page registers the wallet by itself." }),
      el("div", { class: "tx-result", id: "ruHolderResult" }, RU.said ? el("span", { class: RU.said.cls, text: RU.said.text }) : null));
  }
  return el("div", { class: "rule-block", id: "ruHolders" }, ...kids);
}
async function holderAct(btn, what) {
  const label = btn.textContent;
  let user;
  try { user = requireWallet(); } catch (_) { $("walletBtn").click(); return; }
  btn.disabled = true; btn.textContent = "Confirm in your wallet";
  try {
    const pool = (await ctx.client.pool(S.pool.address)) || S.pool;
    if (what === "open") {
      const ixs = await ctx.client.rulesOpenHolderInstructions(user, pool);
      if (!ixs.length) throw new Error("Your wallet is registered already.");
      const sig = await sendIxs(ixs, [], "registration");
      RU.said = { cls: "ok", text: "Your wallet is registered. It earns from now on." };
      toast("Registered.", "ok", { href: explorer("tx", sig), text: "View" });
    } else {
      const plan = await ctx.client.rulesClaimHolderInstructions(user, pool);
      if (!plan.instructions.length || plan.amount <= 0n) throw new Error("There is nothing to claim right now.");
      const sig = await sendIxs(plan.instructions, [], "claim");
      const ev = (await eventsOf(sig)).find((e) => e.kind === "HolderClaimed" && e.pool.equals(S.pool.address));
      const paid = ev ? ev.amount : plan.amount;
      RU.said = { cls: "ok", text: "Claimed " + fmtUnits(paid, S.quoteDec, 9) + " " + S.quoteSym + "." };
      toast("Claimed " + fmtUnits(paid, S.quoteDec, 9) + " " + S.quoteSym + " of rewards.", "ok", { href: explorer("tx", sig), text: "View" });
    }
  } catch (e) { RU.said = { cls: "bad", text: e.message }; toast(e.message, "err"); }
  btn.textContent = label;
  await refreshRules();
}
/// Send coins of a strict coin: the SDK checks the rules first and creates the receiver's account.
async function strictSend(btn) {
  let user;
  try { user = requireWallet(); } catch (_) { $("walletBtn").click(); return; }
  const say = (cls, text) => ST.result.replaceChildren(el("span", { class: cls, text }));
  let to;
  try { to = new PublicKey(ST.to.value.trim()); } catch (_) { say("bad", "That is not a valid wallet address."); return; }
  const amount = parseUnits(String(ST.amount.value).replace(",", "."), S.baseDec);
  if (!amount || amount <= 0n) { say("bad", "Type how many coins to send."); return; }
  // more than the wallet holds: said here, the way the trade card says it, not by a transfer that fails in the wallet
  if (amount > S.balances.base) { say("bad", "Your wallet holds " + fmtUnits(S.balances.base, S.baseDec, 4) + " " + S.symbol + ". That is not enough for this send."); return; }
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Confirm in your wallet";
  try {
    const pool = (await ctx.client.pool(S.pool.address)) || S.pool;
    const ixs = await ctx.client.strictSendInstructions(user, pool, to, amount);
    const sig = await sendIxs(ixs, [], "send");
    say("ok", "Sent " + fmtUnits(amount, S.baseDec, S.baseDec) + " " + S.symbol + ".");
    ST.result.append(" ", el("a", { class: "link", href: explorer("tx", sig), target: "_blank", rel: "noopener", text: "View" }));
    ST.amount.value = "";
  } catch (e) { say("bad", e.message); }
  btn.textContent = label; btn.disabled = false;
  await refreshRules();
}

// ---- trade panel -------------------------------------------------------------------------------------
// Two ways to know what a trade gives. The pool's formula, worked out here at once: exact for a
// pool without a hook and for the platform templates. And the same trade simulated on chain with
// the connected wallet: the only truth on a pool whose hook answers each trade itself
// (hookSetsAmounts). There the large figure, the minimum, the fee rows and the floor that is
// signed all come from the simulation, and the formula is shown as "Without the hook".

const T = {};
function renderTradePanel() {
  const card = $("tradeCard");
  T.seg = el("div", { class: "seg buysell full", role: "group", "aria-label": "Direction" },
    el("button", { type: "button", "data-dir": "buy", "aria-pressed": "true", text: "Buy" }),
    el("button", { type: "button", "data-dir": "sell", "aria-pressed": "false", text: "Sell" }));
  T.input = el("input", { class: "input num", id: "amount", type: "text", inputmode: "decimal", placeholder: "0.0", autocomplete: "off", "aria-label": "Amount" });
  T.suffix = el("span", { class: "suffix", text: S.quoteSym });
  T.quick = el("div", { class: "quick" });
  T.balance = el("div", { class: "balance" });
  T.outV = el("span", { class: "v", text: "0" });
  T.outU = el("span", { class: "l", text: S.symbol });
  T.note = el("div", { class: "trade-note", "aria-live": "polite" });
  T.kv = el("dl", { class: "kv" });
  T.earn = el("div", { class: "earn-line" });
  T.cost = el("div", { class: "earn-line cost", "aria-live": "polite" });
  T.slip = el("div", { class: "slip" });
  T.btn = el("button", { class: "btn btn-block btn-main btn-buy", type: "button", text: "Buy " + S.symbol });
  T.result = el("div", { class: "tx-result" });
  T.wrap = el("div", { class: "wrapped", hidden: true });
  card.replaceChildren(
    el("h2", { class: "sr-only", text: "Trade" }), T.seg,
    el("div", { class: "field amount-box" }, el("span", null, el("span", { text: "You pay" })), el("div", { class: "input-wrap" }, T.input, T.suffix), T.quick, T.balance),
    el("div", { class: "out" }, el("span", { class: "l", text: "You receive" }), el("span", null, T.outV, " ", T.outU)),
    T.note, T.kv, T.earn, T.cost,
    el("div", { class: "field", style: "margin:14px 0" }, el("span", null, el("span", { text: "Slippage" })), T.slip, T.slipNote = el("div", { class: "small bad slip-note", "aria-live": "polite", hidden: true })),
    T.btn, T.result, T.wrap);
  for (const b of T.seg.querySelectorAll("button")) b.addEventListener("click", () => setDir(b.dataset.dir === "buy" ? DIRECTION.BUY : DIRECTION.SELL));
  T.input.addEventListener("input", amountChanged);
  T.btn.addEventListener("click", trade);
  for (const bps of [50, 100, 200]) {
    const b = el("button", { type: "button", "aria-pressed": bps === S.slippageBps ? "true" : "false", text: fmtPct(bps, 1) });
    b.addEventListener("click", () => setSlippage(bps));
    T.slip.append(b);
  }
  T.slipCustom = el("input", { class: "input num", type: "text", inputmode: "decimal", placeholder: "custom %", "aria-label": "Custom slippage percent" });
  T.slipCustom.addEventListener("input", () => {
    const typed = T.slipCustom.value.trim().replace(",", ".");
    const v = Number(typed);
    if (!typed) { slipNote(""); return; }
    // the page takes a slippage above 0 and below 50%: anything else is said, and the last one stays
    if (!isFinite(v) || v <= 0) { slipNote("Type a slippage above 0%. It stays at " + fmtPct(S.slippageBps, 2) + "."); return; }
    if (v >= 50) { slipNote("A slippage of 50% or more is above the limit. It stays at " + fmtPct(S.slippageBps, 2) + "."); return; }
    slipNote("");
    setSlippage(Math.round(v * 100), true);
  });
  T.slip.append(T.slipCustom);
  setDir(DIRECTION.BUY);
}
function slipNote(text) { T.slipNote.textContent = text; T.slipNote.hidden = !text; }
function setSlippage(bps, custom) {
  S.slippageBps = bps;
  for (const b of T.slip.querySelectorAll("button")) b.setAttribute("aria-pressed", !custom && Number(b.textContent.replace("%", "")) * 100 === bps ? "true" : "false");
  if (!custom) { T.slipCustom.value = ""; slipNote(""); }
  quoteNow();
}
/// The trader changed the amount (typed, a quick button, Max): the line under the button spoke
/// of the last attempt, so it goes.
function amountChanged() {
  T.result.replaceChildren();
  quoteNow();
}
function setDir(dir) {
  S.dir = dir;
  const buy = dir === DIRECTION.BUY;
  for (const b of T.seg.querySelectorAll("button")) b.setAttribute("aria-pressed", (b.dataset.dir === "buy") === buy ? "true" : "false");
  T.suffix.textContent = buy ? S.quoteSym : S.symbol;
  T.outU.textContent = buy ? S.symbol : S.quoteSym;
  T.btn.className = "btn btn-block btn-main " + (buy ? "btn-buy" : "btn-sell");
  T.btn.textContent = (buy ? "Buy " : "Sell ") + S.symbol;
  T.quick.replaceChildren(...(buy
    ? [0.1, 0.5, 1].map((v) => el("button", { type: "button", text: v + " " + S.quoteSym, onclick: () => { T.input.value = String(v); amountChanged(); } }))
    : [25, 50, 100].map((p) => el("button", { type: "button", text: p + "%", onclick: () => { const bal = S.balances.base; T.input.value = fmtUnits(bal * BigInt(p) / 100n, S.baseDec, S.baseDec).replace(/,/g, ""); amountChanged(); } }))));
  T.input.value = "";
  T.result.replaceChildren();
  renderBalance();
  quoteNow();
}
function renderBalance() {
  const W = Wallet.current();
  renderWrapped();
  if (!W.publicKey) { T.balance.replaceChildren(); return; }
  const buy = S.dir === DIRECTION.BUY;
  const bal = buy ? (S.quoteIsSol ? S.balances.sol : S.balances.quote) : S.balances.base;
  const dec = buy ? S.quoteDec : S.baseDec;
  const unit = buy ? S.quoteSym : S.symbol;
  T.balance.replaceChildren(el("span", { text: "Balance " + fmtUnits(bal, dec, 4) + " " + unit }),
    el("button", { type: "button", text: "Max", onclick: () => {
      let v = bal;
      if (buy && S.quoteIsSol) v = bal > 20_000_000n ? bal - 20_000_000n : 0n; // keep 0.02 SOL for fees and rent
      T.input.value = fmtUnits(v, dec, dec).replace(/,/g, ""); amountChanged();
    } }));
}
/// The wallet's wrapped SOL, with the button that turns it into plain SOL. A wallet that keeps
/// a wrapped SOL account receives the SOL of every sell there.
function renderWrapped() {
  const w = Wallet.current().publicKey ? S.balances.wsol : null;
  if (w === null || w === undefined || w <= 0n) { T.wrap.hidden = true; T.wrap.replaceChildren(); return; }
  const btn = el("button", { class: "btn btn-sm", type: "button", text: "Unwrap" });
  btn.addEventListener("click", () => unwrapSol(btn, async () => { await refreshPool(); }));
  T.wrap.replaceChildren(
    el("div", { class: "hook-act-v" }, el("span", { text: "Wrapped SOL in your wallet" }), el("b", { class: "mono", text: fmtUnits(w, SOL_DECIMALS, 6) })),
    el("div", { class: "hook-act-row" }, el("span", { class: "small muted", text: "Unwrap turns it into plain SOL. The account stays open." }), btn));
  T.wrap.hidden = false;
}
/// Does a sell by this wallet pay wrapped SOL? Yes when the wallet keeps a wrapped SOL account,
/// or when that account is this pool's hook treasury: the SDK then leaves it open.
function sellPaysWrapped(wallet, wsol) {
  return S.quoteIsSol && (wsol !== null || S.pool.hookQuoteTreasury.equals(H.pda.ata(wallet, H.NATIVE_MINT)));
}
function amountIn() {
  const dec = S.dir === DIRECTION.BUY ? S.quoteDec : S.baseDec;
  const v = parseUnits(T.input.value, dec);
  return v && v > 0n ? v : null;
}

/// What a trade does to a coin on the curve, said once on the trade card. `graduateFirst`: the
/// pool stands at or past its target, so the transaction graduates the coin before the trade.
function graduateWords(qt) {
  return qt.graduateFirst ? "This pool has reached its target. This trade graduates the coin first and is priced on the graduated pool." : "This trade graduates the coin.";
}
/// Why the SDK could not quote a trade, in a sentence for the trader. On the curve a sell can
/// only be paid from the real SOL (CurveRefusal 6049); a dust trade gives nothing back.
function quoteError(e) {
  if (e instanceof H.CurveRefusal) return curveSentence(e);
  if (/amount too small/.test(String(e && e.message))) return "This amount is too small to trade. It would give nothing back.";
  return e.message;
}
/// Work out the formula quote for what is typed, draw, and ask the chain for the simulated trade.
/// Runs on every change of the amount, the direction, the slippage and the wallet.
/// The slot a quote is worked out for, on a pool whose fee or limit depends on it: a launch
/// guard, or a rules coin with a sniper fee or a buy limit. undefined for every other pool.
async function quoteSlot() {
  const i = S.info;
  if (!(i && (i.guard || (i.rules && (i.rules.sniperSlots > 0n || i.rules.maxBuyQuote > 0n))))) return undefined;
  // long after its window the fee and the limit no longer move: the slot of the last read, moved on
  // by the clock, gives the same quote without a read
  const est = slotNow(), w = i.guard ? [i.guard.startSlot, i.guard.startSlot + i.guard.guardSlots] : [i.rules.startSlot, i.rules.startSlot + (i.rules.sniperSlots > i.rules.limitSlots ? i.rules.sniperSlots : i.rules.limitSlots)];
  if (est > 0n && w[0] > 0n && est > w[1] + 300n) return est;
  return BigInt(await currentSlot());
}
/// A buy above the buy limit of a rules coin, inside its window: the sentence for the trader. "" otherwise.
function overLimit(dir, amount, slot) {
  if (!isRules() || dir !== DIRECTION.BUY || slot === undefined) return "";
  const lim = H.rulesBuyLimit(S.info.rules, slot);
  if (!lim || amount <= lim.maxBuyQuote) return "";
  return "This coin limits one buy to " + fmtUnits(lim.maxBuyQuote, S.quoteDec, 6) + " " + S.quoteSym + " for about " + fmtSpan(Math.max(1, Math.ceil(slotsToSeconds(lim.untilSlot - slot)))) + " more. Buy that much or less, or wait.";
}
/// Does a window of this pool raise the fee of a buy right now? Then a buy that lands later pays less.
function feeWindow(qt) {
  if (!qt || S.dir !== DIRECTION.BUY || qt.feeBpsApplied === S.pool.lpFeeBps) return "";
  return S.info && S.info.rules ? "sniper fee" : S.info && S.info.guard ? "guard" : "";
}
async function quoteNow() {
  const a = amountIn(), dir = S.dir;
  const id = S.localSeq = (S.localSeq || 0) + 1;
  renderCost();
  if (!a) { S.local = null; drawQuote(); return; }
  let local;
  try {
    const slot = await quoteSlot();
    const over = overLimit(dir, a, slot);
    local = over ? { dir, amount: a, qt: null, error: over } : { dir, amount: a, qt: await ctx.client.quoteLocal(S.pool, S.plat, dir, a, S.info, slot, isStrictCoin() ? Wallet.current().publicKey || undefined : undefined), error: "" };
    if (local.qt && isStrictCoin() && Wallet.current().publicKey) local.strict = await ctx.client.strictTradeCheck(S.pool, Wallet.current().publicKey, dir, a).catch(() => null);
  } catch (e) { local = { dir, amount: a, qt: null, error: quoteError(e) }; }
  if (id !== S.localSeq) return; // something newer was typed meanwhile
  S.local = local;
  drawQuote();
  quoteChainDebounced();
}
/// The simulated trade that belongs to what is typed now, by the wallet connected now. null otherwise.
function simNow(a) {
  const s = S.sim;
  // a simulation of the pool as it was before someone traded says nothing about the pool now
  return s && a && s.dir === S.dir && s.amount === a && s.who === walletKey() && s.rb === S.pool.reserveBase && s.rq === S.pool.reserveQuote ? s : null;
}

/// One trade simulated on chain, cut right after the swap: what the pool would pay out and the
/// Swapped event it would emit, with the fees the pool and the hook really took. A thrown Error
/// carries a sentence for the trader.
async function simulateSwap(user, pool, dir, amount) {
  const hook = await ctx.client.hookRef(pool, user);
  // the simulation stops right after the swap: only a graduate in front of it matters, on a pool
  // ready to graduate, and the SDK need not work out whether the buy crosses the target
  const all = await ctx.client.swapInstructions(user, pool, hook, dir, amount, 0n, { graduate: H.readyToGraduate(pool) });
  // the swap, found by its discriminator: on a pool ready to graduate, graduate comes before it
  const disc = H.IX.hookpool.swap;
  const at = all.findIndex((i) => i.programId.equals(H.PROGRAMS.hookpool) && disc.every((b, n) => i.data[n] === b));
  const { tx } = await ctx.client.buildTx(user, all.slice(0, at + 1));
  const sim = await ctx.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true });
  if (sim.value.err) {
    const e = new Error(JSON.stringify(sim.value.err)); e.logs = sim.value.logs || [];
    throw new Error(await explainTxError(e, "trade"));
  }
  // the pool emits its events as inner instructions to itself; the simulator hands them over with the program's address
  const id = H.PROGRAMS.hookpool.toBase58();
  const own = [];
  for (const group of sim.value.innerInstructions || []) for (const ins of (group && group.instructions) || []) {
    if (ins && typeof ins.data === "string" && String(ins.programId) === id) own.push({ programIdIndex: 0, data: ins.data });
  }
  let ev = null;
  try { ev = H.eventsFromInnerInstructions([{ instructions: own }], [id], [id]).find((x) => x.kind === "Swapped" && x.pool.equals(pool.address)) || null; } catch (_) {}
  if (ev) return { amountOut: ev.amountOut, ev };
  // an RPC node that keeps the inner instructions to itself: the SDK's own simulation gives the amount alone
  return { amountOut: await ctx.client.quoteOnChain(user, pool, dir, amount), ev: null };
}
const quoteChainDebounced = debounce(quoteChain, 350);
async function quoteChain() {
  const a = amountIn(), dir = S.dir;
  const W = Wallet.current();
  if (!a || !W.publicKey) return;
  const who = W.publicKey.toBase58(), pool = S.pool;
  const id = ++S.quoting;
  let sim;
  try { sim = { ...(await simulateSwap(W.publicKey, pool, dir, a)), error: "" }; }
  catch (e) { sim = { amountOut: 0n, ev: null, error: e.message || "The simulation failed." }; }
  if (id !== S.quoting) return; // a newer simulation is on its way
  S.sim = { dir, amount: a, who, rb: pool.reserveBase, rq: pool.reserveQuote, ...sim };
  drawQuote();
}

/// Draw "You receive" and the rows under it from what is known now.
/// On a buy of a strict coin: what applies to these coins before the wallet opens. A sell after
/// the windows is never held back, so nothing is said about one.
function strictNotes(L, note) {
  if (!isStrictCoin() || S.dir !== DIRECTION.BUY || !L.qt) return;
  const x = RU.st.strict, chk = L.strict, k = Wallet.current().publicKey;
  if (x.earlyWindowRuns) note("The coins of this buy are early. They cannot be sold or sent until " + slotWhen(x.earlyUnlock) + ".", "wrapped-note");
  if (x.maxWalletRuns) {
    const held = chk && chk.holder ? chk.holder.balance : S.balances.base;
    const room = x.maxWalletAmount > held ? x.maxWalletAmount - held : 0n;
    const most = L.qt.amountOutCeiling && L.qt.amountOutCeiling > L.qt.amountOut ? L.qt.amountOutCeiling : L.qt.amountOut;
    note("Room left under the max wallet: " + fmtUnits(room, S.baseDec, 2) + " " + S.symbol + ". This buy takes " + (most > L.qt.amountOut ? "up to " : "") + fmtUnits(most, S.baseDec, 2) + " " + S.symbol + " of it" + (most > L.qt.amountOut ? ", because the fee falls while it waits to land." : "."));
  }
  if (k && (chk ? chk.needsHolder || !(chk.holder && chk.holder.record) : !(RU.holder && RU.holder.record))) note("This buy also registers your wallet for rewards. That costs " + (RU.holderRent ? fmtUnits(RU.holderRent, 9, 6) + " SOL of rent, once." : "a small rent, once."));
}
function drawQuote() {
  const a = amountIn();
  const buy = S.dir === DIRECTION.BUY;
  const outDec = buy ? S.baseDec : S.quoteDec, outUnit = buy ? S.symbol : S.quoteSym, outFrac = buy ? 2 : 6;
  const inDec = buy ? S.quoteDec : S.baseDec, inUnit = buy ? S.quoteSym : S.symbol;
  const amt = (v) => fmtUnits(v, outDec, outFrac);
  const row = (k, v, cls) => [el("dt", { text: k }), el("dd", { class: cls || "", text: v })];
  const note = (text, cls) => T.note.append(el("div", { class: cls || "", text }));
  T.kv.replaceChildren(); T.note.replaceChildren(); T.earn.replaceChildren();
  T.deposit = 0n;
  if (T.lastFail && T.lastFail.amount === a && T.lastFail.dir === S.dir) note(T.lastFail.text, "bad");
  T.outU.textContent = outUnit;
  // a redraw while a trade is being signed must not hand the button back
  if (!T.busy) T.btn.disabled = false;
  S.lastQuote = null;
  const L = a && S.local && S.local.amount === a && S.local.dir === S.dir ? S.local : null;
  if (!a) T.outV.textContent = "0";
  else if (L && !L.qt) {
    // a refusal the page knows before the wallet opens: words where the figure would be, the reason under it, and the button is off
    T.outV.textContent = "No quote"; T.outU.textContent = "";
    note(L.error, "bad");
    if (!T.busy) T.btn.disabled = true;
  } else if (L && !hookSetsAmounts(S.dir)) {
    strictNotes(L, note);
    // the formula is the quote; the simulation confirms it in the last row
    const qt = L.qt, sim = Wallet.current().publicKey ? simNow(a) : null;
    S.lastQuote = qt;
    T.outV.textContent = amt(qt.amountOut);
    // inside a sniper or guard window the fee falls every slot: a buy that lands later gives more
    const win = feeWindow(qt);
    if (win) { T.outU.textContent = outUnit + " or more"; note("The " + (win === "guard" ? "guard" : "sniper") + " fee falls every slot. A buy that lands a moment later pays less and gives this amount or more.", "muted"); }
    // on a rules coin the hook fee is the coin's own three shares of this side, added up
    const hookLabel = isRules() ? "Launch rules " + fmtPct(H.rulesHookFeeBps(S.info.rules, S.dir, S.plat.maxHookFeeBps)) : "Hook fee";
    // the curve: a buy that crosses the target graduates the coin right after it; on a pool that
    // already stands at or past its target the trade graduates the coin first and is quoted on the
    // graduated pool. The floor is the slippage on the quote either way
    if (qt.graduates) note(graduateWords(qt), "curve-grad");
    T.kv.append(
      ...row("Min received", amt(applyBps(qt.amountOut, S.slippageBps)) + " " + outUnit),
      ...row("Price impact", fmtPct(qt.impactBps), qt.impactBps > 500 ? "bad" : ""),
      ...row("Protocol fee " + fmtPct(S.plat.protocolFeeBps), fmtUnits(qt.protocolFee, inDec, 6) + " " + inUnit),
      ...row(hookLabel, qt.hookFee > 0n ? fmtUnits(qt.hookFee, S.quoteDec, 6) + " " + S.quoteSym : "0"),
      ...row("Pool fee " + fmtPct(qt.feeBpsApplied) + (win ? " (" + win + ")" : ""), fmtUnits(qt.lpFee, inDec, 6) + " " + inUnit),
      ...(sim ? [el("dt", { text: "Exact quote" }), el("dd", { id: "exactOut", class: sim.error ? "bad" : "", title: sim.error ? sim.error : null, text: sim.error ? "simulation failed" : amt(sim.amountOut) + (sim.amountOut === qt.amountOut ? ", same as above" : "") })] : []));
    renderEarn(qt);
  } else if (L) {
    // a hook that answers each trade itself: only the simulated trade is shown as the amount
    const qt = L.qt, sim = Wallet.current().publicKey ? simNow(a) : null;
    const without = row("Without the hook", amt(qt.amountOut) + " " + outUnit, "dim");
    if (!sim || sim.error) {
      T.outV.textContent = "";
      T.kv.append(...without);
      if (!Wallet.current().publicKey) note("Connect a wallet to see what you receive. This hook answers each trade itself, so the amount comes from a simulation with your wallet.");
      else if (!sim) note("Simulating this trade on chain.", "muted");
      else note(sim.error + " The amount cannot be shown without a simulation.", "bad");
    } else {
      const ev = sim.ev;
      T.outV.textContent = amt(sim.amountOut);
      T.kv.append(...row("Min received", amt(applyBps(sim.amountOut, S.slippageBps)) + " " + outUnit));
      if (ev) {
        // the hook fee is taken from what is paid in on a buy and from what is paid out on a sell, always in the quote token
        const gross = buy ? ev.amountOut : ev.amountOut + ev.hookFee;
        const netIn = ev.amountIn - ev.protocolFee - ev.lpFee - (buy ? ev.hookFee : 0n);
        // the event carries the REAL reserves; on the curve the price also counts the virtual SOL
        const v = isCurveOpen() ? S.pool.virtualQuote : 0n;
        const rIn = (buy ? ev.reserveQuote + v : ev.reserveBase) - netIn - ev.lpFee, rOut = (buy ? ev.reserveBase : ev.reserveQuote + v) + gross;
        const impact = rIn > 0n && netIn > 0n && rOut > 0n ? Math.max(0, Number(10_000n - (gross * rIn * 10_000n) / (netIn * rOut))) : 0;
        const feeBase = buy ? ev.amountIn - ev.protocolFee : gross;
        const hookBps = feeBase > 0n ? Number((ev.hookFee * 100_000n) / feeBase + 5n) / 10 : 0;
        T.kv.append(
          ...row("Price impact", fmtPct(impact), impact > 500 ? "bad" : ""),
          ...row("Protocol fee " + fmtPct(S.plat.protocolFeeBps), fmtUnits(ev.protocolFee, inDec, 6) + " " + inUnit),
          ...row("Hook fee" + (ev.hookFee > 0n ? " " + fmtPct(Math.floor(hookBps)) : ""), ev.hookFee > 0n ? fmtUnits(ev.hookFee, S.quoteDec, 6) + " " + S.quoteSym : "0"),
          ...row("Pool fee " + fmtPct(ev.feeBpsApplied), fmtUnits(ev.lpFee, inDec, 6) + " " + inUnit));
      } else T.kv.append(...row("Hook fee", "inside the amount above"));
      T.kv.append(...without);
      note("From a simulation of this trade on chain. The hook answers each trade itself, so the next one can differ.", "muted");
      if (qt && qt.graduates) note(graduateWords(qt), "curve-grad");
    }
  }
  // more than the wallet holds, by its balances or by the simulation: said here, and the button is
  // off, so the wallet never opens for a trade that cannot land
  const lack = a ? notEnough(a) : "";
  const simSaid = a && Wallet.current().publicKey ? simNow(a) : null;
  const simLack = simSaid && simSaid.error && /does not hold enough/.test(simSaid.error) ? simSaid.error : "";
  if (lack || simLack) {
    // a hook that answers each trade itself: its branch above already says the simulation's words
    if (lack || !hookSetsAmounts(S.dir)) note(lack || simLack, "bad");
    if (!T.busy) T.btn.disabled = true;
  }
  // where the SOL of a sell lands, said before the click
  const k = Wallet.current().publicKey;
  if (!buy && k && sellPaysWrapped(k, S.balances.wsol)) note("Arrives as wrapped SOL in your wrapped SOL account. Unwrap, under this form, turns it into plain SOL.", "wrapped-note");
}
/// The sentence when the wallet holds less than the amount typed: a sell of more coins than it
/// holds, or a buy of more than its SOL (or quote token). "" otherwise, and "" until the
/// balances of the connected wallet are read.
function notEnough(a) {
  const k = walletKey();
  if (!k || S.balancesOf !== k) return "";
  if (S.dir === DIRECTION.SELL) {
    return a > S.balances.base ? "Your wallet holds " + fmtUnits(S.balances.base, S.baseDec, 4) + " " + S.symbol + ". That is not enough for this sell." : "";
  }
  const have = S.quoteIsSol ? S.balances.sol : S.balances.quote;
  // a collectible buy also pays the deposit for its NFTs (renderEarn worked it out for this quote)
  const dep = isCollectible() ? T.deposit || 0n : 0n;
  if (dep > 0n && a <= have && a + dep > have) return "Your wallet holds " + fmtUnits(have, S.quoteDec, 4) + " " + S.quoteSym + ". That is not enough for this buy and the deposit for its NFTs.";
  return a > have ? "Your wallet holds " + fmtUnits(have, S.quoteDec, 4) + " " + S.quoteSym + ". That is not enough for this buy." : "";
}

async function trade() {
  const a = amountIn();
  if (!a) { T.input.focus(); return; }
  let user;
  try { user = requireWallet(); } catch (_) { $("walletBtn").click(); return; }
  const buy = S.dir === DIRECTION.BUY;
  const label = buy ? "buy" : "sell";
  if (T.busy) return;
  T.busy = true; T.btn.disabled = true; const old = T.btn.textContent; T.btn.textContent = "Confirm in your wallet";
  T.result.replaceChildren();
  T.lastFail = null;
  traceMark("click");
  try {
    const pool = await ctx.client.pool(S.pool.address) || S.pool;
    traceMark("pool read");
    S.pool = pool;
    let qt, minOut, swapOpts = {};
    if (hookSetsAmounts(S.dir)) {
      // no formula knows this hook's answer: the floor that is signed comes from the trade simulated now
      const sim = await simulateSwap(user, pool, S.dir, a);
      qt = { amountOut: sim.amountOut };
      minOut = applyBps(sim.amountOut, S.slippageBps);
    } else {
      const slot = await quoteSlot();
      // a buy above the coin's buy limit is refused here, in words, before the wallet opens
      const over = overLimit(S.dir, a, slot);
      if (over) throw new Error(over);
      qt = await ctx.client.quoteLocal(pool, S.plat, S.dir, a, S.info, slot, isStrictCoin() ? user : undefined);
      minOut = applyBps(qt.amountOut, S.slippageBps);
      // the quote already says whether this trade graduates the coin (the SDK's own rule, from the
      // same pool): the SDK need not read the platform and the hook again to work it out
      swapOpts = { graduate: qt.graduates === true };
    }
    traceMark("quoted");
    // a collectible buy that earns pieces pays the deposit for their NFTs in the same transaction: one
    // approval, and the keeper mints them into the wallet (collectibleBuyPlan)
    const plan = isCollectible() && buy ? await collectibleBuyPlan(user, qt) : null;
    if (plan && plan.mintDeposit) swapOpts = { ...swapOpts, mintDeposit: plan.mintDeposit };
    if (plan && plan.topUp > 0n) {
      const have = S.quoteIsSol ? S.balances.sol : S.balances.quote;
      if (S.balancesOf === user.toBase58() && a + plan.topUp > have) throw new Error("Your wallet holds " + fmtUnits(have, S.quoteDec, 4) + " " + S.quoteSym + ". That is not enough for this buy and the deposit for its NFTs.");
    }
    // read right before building, the way the SDK does: a wrapped SOL account that is open now stays open
    const wrapped = !buy && S.quoteIsSol && sellPaysWrapped(user, await wrappedSol(user));
    const hook = await ctx.client.hookRef(pool, user);
    const ixs = await ctx.client.swapInstructions(user, pool, hook, S.dir, a, minOut, swapOpts);
    traceMark("instructions built");
    T.btn.textContent = "Sending";
    // the list as it stood before a sell, to say afterwards which pieces it burned
    const held = isCollectible() && S.dir === DIRECTION.SELL ? C.pieces.slice() : null;
    const sig = plan ? await buyOnCollectible(user, ixs, label, plan) : await sendIxs(ixs, [], label);
    T.result.replaceChildren(el("span", { class: "ok", text: (buy ? "Bought. " : "Sold. ") }), el("a", { class: "link", href: explorer("tx", sig), target: "_blank", rel: "noopener", text: short(sig, 6) }));
    // the NFTs of this buy: minted by the keeper a few seconds after it (keeperMint updates the line)
    if (plan && C.flow && C.flow.keeper) T.result.append(el("div", { class: "mint-said", id: "mintSaid", "aria-live": "polite", text: nftWords(C.flow.nfts, "being minted") }));
    if (wrapped) T.result.append(el("div", { class: "burned", text: "The SOL arrived as wrapped SOL in your wrapped SOL account." }));
    toast((buy ? "Buy" : "Sell") + " confirmed.", "ok", { href: explorer("tx", sig), text: "View" });
    T.input.value = "";
    const wasOpen = isCurveOpen();
    // the pool and the wallet in one read, then the trades newer than the newest one seen
    await refreshPool(true);
    await refreshSwaps(true);
    if (wasOpen && !isCurveOpen()) T.result.append(el("div", { class: "grad-said", id: "gradSaid", text: "This trade graduated the coin. Liquidity is open now." }));
    if (held) {
      await refreshCollectible();
      const left = new Set(C.pieces.map((p) => p.address.toBase58()));
      const gone = held.filter((p) => !left.has(p.address.toBase58())).reverse(); // burn order: the end of the list first
      if (gone.length) T.result.append(el("div", { class: "burned", text: "This sell burned " + plural(gone.length, "piece") + ": " + nameList(gone.map((p) => p.name)) + "." }));
    } else refreshCollectible();
    quoteNow();
  } catch (e) {
    // said where the eye is, under the amount, and kept there while this amount stands
    const said = quoteError(e);
    T.lastFail = { amount: a, dir: S.dir, text: said };
    T.result.replaceChildren(el("span", { class: "bad", text: said }));
    toast(said, "err");
  } finally {
    // drawQuote decides the button again: off when the amount cannot be traded
    T.busy = false; T.btn.textContent = old;
    drawQuote();
  }
}

/// The wallet's SOL, coin, quote token and wrapped SOL come with every read of the pool
/// (refreshPool, the wallet part of client.poolView): one read for both.
/// The balances of a read, for the wallet connected now.
function setBalances(b) {
  const k = Wallet.current().publicKey;
  if (!b || !k || !b.owner.equals(k)) return; // a read for a wallet that is no longer the connected one
  S.balances = { sol: b.sol, base: b.base, quote: b.quote, wsol: b.wsol };
  // whose balances these are: the trade card holds a trade back only on balances read for this wallet
  S.balancesOf = k.toBase58();
}
function drawBalances() {
  renderBalance();
  drawQuote();
  renderCost();
  if (isRules()) renderRulesCard();
}

// ---- collectible per buy ---------------------------------------------------------------------------
// Pieces are pegged to the coin: a wallet keeps one piece per unit of coins it holds. What its
// coins no longer back is removed from the end of its own list. So the page shows that list in
// order, marks the piece that burns first, names what a sell costs before it is signed, and
// lets the wallet reorder the list or send a piece together with its coins.

// C.backing is the coins that back the wallet's pieces, counted the way the program counts them
// (H.collectible.fetchBacking). It is not the raw token balance the trade form shows.
// Pegged coins only: C.queue is the pool's burn queue (pieces burned in a transfer whose NFT still
// exists), C.stale the wallet's pieces whose NFT is still with an earlier holder, C.send the Send
// coins form and C.rx what was last read about the wallet typed into it.
const C = { allLoaded: false, ticket: null, pieces: [], st: null, backing: 0n, flow: null, sel: "", sendTo: "", busy: false, seq: 0, drawn: "", flip: false, fresh: false, queue: [], stale: [], send: null, rx: null, rxSeq: 0 };
const reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
/// Tiles of the wallet's list drawn before "Show all": the end of the list, which burns first.
const SHOWN = 12;
function isCollectible() { return !!(S.info && S.info.template === "collectible" && S.info.collectible); }
const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
const keyOf = (p) => p.address.toBase58();
function nameList(names) { const shown = names.slice(0, 6); return shown.join(", ") + (names.length > shown.length ? " and " + (names.length - shown.length) + " more" : ""); }
function unitText() { return fmtUnits(S.info.collectible.unit, S.baseDec, 0) + " " + S.symbol; }

/// A pegged coin: a Token-2022 coin whose transfer hook is the collectible program, so its
/// pieces move or burn inside every transfer of the coin. A plain coin keeps the peg by settle.
function isPeggedCoin() { return isCollectible() && !!S.info.collectible.pegged; }

/// The peg in four sentences, for the hook card. A pegged coin has its own four.
function pegRule() {
  const keep = "A wallet keeps one piece per " + unitText() + " it holds.";
  if (isPeggedCoin()) return [
    keep,
    "A transfer carries one piece for each whole " + unitText() + " it sends. A piece that cannot travel burns.",
    "A sell burns the piece in the same trade.",
    "Pieces leave from the end of your list. You set its order.",
  ];
  return [
    keep,
    "A sell burns from the end of your list.",
    "You set the order of your list.",
    "A piece moves to another wallet only with its coins.",
  ];
}

/// Pieces a buy of this size earns: one per unit, capped per buy, by the room left under the
/// collection's cap and by the room left in the wallet's list. The cap counts pieces that
/// exist now, so a burned piece frees its place.
function roomLeft() { const c = S.info.collectible; return Math.max(0, c.maxSupply - c.live - c.reservedPending); }
/// A wallet holds at most 200 pieces of one coin, minted and waiting together.
function walletRoom(t) { return Math.max(0, H.collectible.MAX_PIECES_PER_WALLET - (t ? t.owned.length + t.pending : 0)); }
function earnCount(qt, t) {
  const c = S.info.collectible;
  return Math.min(c.maxPerBuy, Number(qt.amountOut / c.unit), roomLeft(), walletRoom(t));
}
/// A ticket holds four batches. When every one holds unminted pieces a new buy earns none.
function ticketFull(t) { return !!(t && t.batches.every((b) => b.pieces > 0)); }

function renderEarn(qt) {
  T.earn.replaceChildren();
  T.deposit = 0n;
  if (!isCollectible() || S.dir !== DIRECTION.BUY || !qt) return;
  const c = S.info.collectible;
  if (walletRoom(C.ticket) <= 0) { T.earn.append(el("div", { text: "This wallet holds " + H.collectible.MAX_PIECES_PER_WALLET + " pieces, the most one wallet can hold. This buy earns none." })); return; }
  if (ticketFull(C.ticket)) { T.earn.append(el("div", { text: "Mint your waiting pieces first. This buy would earn none." })); return; }
  if (roomLeft() <= 0) { T.earn.append(el("div", { text: "All " + fmtInt(c.maxSupply) + " pieces exist right now. This buy earns none until one burns." })); return; }
  const n = earnCount(qt, C.ticket);
  // a buy smaller than one piece's coins earns none: say how many coins a piece takes
  if (n === 0) {
    T.earn.append(el("div", { text: "This buy earns no piece." }),
      el("div", { class: "sub", text: "A piece takes " + fmtInt(Number(c.unit / 10n ** BigInt(S.baseDec))) + " " + S.symbol + " in one buy. This buy gets " + fmtCompact(toNumber(qt.amountOut, S.baseDec)) + "." }));
    return;
  }
  // the deposit for the NFTs rides in the same transaction: what every piece the wallet will have waiting
  // needs, less what its ticket already holds (the SDK's mintDepositTopUp, the amount the buy adds), at the
  // chain's rent. Before that rent is in (the first quote can come before the ticket's first read) the line
  // names the pieces and is drawn again, with the deposit, when it arrives.
  if (!RENT) {
    loadRent().then(() => { if (S.lastQuote && amountIn()) renderEarn(S.lastQuote); }).catch(() => {});
    T.earn.append(el("div", { text: "This buy earns " + plural(n, "piece") + "." }));
    return;
  }
  const topUp = H.collectible.mintDepositTopUp(RENT, c, C.ticket, C.deposit || 0n, n);
  T.deposit = topUp;
  const it = n === 1 ? "it" : "them", nft = n === 1 ? "the NFT" : "the NFTs";
  T.earn.append(el("div", { text: "This buy earns " + plural(n, "piece") + ". " + (topUp > 0n
    ? "It adds a " + solUpText(topUp) + " SOL deposit for " + (n === 1 ? "the NFT" : "the NFTs") + ", used to mint " + it + " into your wallet."
    : "Your deposit already covers " + nft + ". " + (n === 1 ? "It is" : "They are") + " minted into your wallet.") }),
    el("div", { class: "sub", text: "Which pieces is decided by a later block. Nobody can know it in advance." }));
}
/// An amount of SOL for a sentence, rounded up to four decimals (a deposit is never said as less than it is).
function solUpText(lamports) { return fmtUnits(((BigInt(lamports) + 99_999n) / 100_000n) * 100_000n, SOL_DECIMALS, 4); }
/// "Your NFT is being minted." and its other forms, for `n` NFTs.
function nftWords(n, what) {
  const one = n === 1;
  if (what === "being minted") return one ? "Your NFT is being minted." : "Your NFTs are being minted.";
  if (what === "in") return one ? "Your NFT is in your wallet." : "Your NFTs are in your wallet.";
  return one ? "Your NFT is not minted yet. You can mint it yourself." : "Your NFTs are not minted yet. You can mint them yourself.";
}

/// What the typed sell costs in pieces: the peg with the balance the sell leaves behind.
function sellCost() {
  if (!isCollectible() || S.dir !== DIRECTION.SELL || !C.ticket || !Wallet.current().publicKey) return null;
  const a = amountIn();
  if (!a || a > S.balances.base) return null; // more than the wallet holds: the sell cannot happen
  const peg = H.collectible.pegStatus(C.ticket, C.backing > a ? C.backing - a : 0n, S.info.collectible.unit);
  return peg.dropWaiting > 0 || peg.burn.length > 0 ? peg : null;
}
/// What anyone could remove right now: the wallet holds more than its coins back. The
/// program also refuses a reorder in that state.
function abovePeg() {
  if (!isCollectible() || !C.ticket || !Wallet.current().publicKey) return null;
  const peg = H.collectible.pegStatus(C.ticket, C.backing, S.info.collectible.unit);
  return peg.dropWaiting > 0 || peg.burn.length > 0 ? peg : null;
}
function pieceName(address) { const k = address.toBase58(); const p = C.pieces.find((x) => keyOf(x) === k); return p ? p.name : short(k); }
function renderCost() {
  if (!T.cost) return;
  T.cost.replaceChildren();
  const peg = sellCost();
  markBurns(peg || abovePeg());
  if (!peg) return;
  if (peg.burn.length) T.cost.append(el("div", { text: "This sell burns " + plural(peg.burn.length, "piece") + ": " + nameList(peg.burn.map(pieceName)) + "." }));
  if (peg.dropWaiting) T.cost.append(el("div", { text: "This sell drops " + plural(peg.dropWaiting, "waiting piece") + "." }));
  // a deposit pays a keeper to mint the waiting pieces within seconds: one that lands before the sell turns
  // them into NFTs, and the sell burns those. Their rent comes back, Metaplex's create fee does not.
  if (peg.dropWaiting && C.deposit > 0n) T.cost.append(el("div", { class: "sub", text: "Their NFTs may be minted before this sell lands. Then the sell burns them. Their rent comes back to you, but not Metaplex's fee of " + fmtUnits(H.collectible.CORE_CREATE_FEE, SOL_DECIMALS, 4) + " SOL each." }));
  const cap = H.collectible.MAX_BURNS_PER_SETTLE;
  // a plain coin settles six burns with the sell; a pegged coin takes every piece off the list inside the sell and burns six NFTs with it
  if (peg.burn.length > cap) T.cost.append(el("div", { class: "sub", text: isPeggedCoin()
    ? "All " + peg.burn.length + " leave your list in the sell. The NFTs of " + (peg.burn.length - cap) + " burn right after."
    : "The sell burns " + cap + " in its own transaction. Anyone can burn the other " + (peg.burn.length - cap) + " right after." }));
}
/// Mark on the list what the typed sell would remove.
function markBurns(peg) {
  const burn = new Set(peg ? peg.burn.map((k) => k.toBase58()) : []);
  for (const t of document.querySelectorAll("#colMine .piece.own")) {
    const on = burn.has(t.dataset.addr);
    t.classList.toggle("burns", on);
    const r = t.querySelector(".ribbon");
    if (r) { r.textContent = on ? "burns" : t.dataset.last ? "burns first" : ""; r.hidden = !r.textContent; }
  }
  const blanks = [...document.querySelectorAll("#colMine .piece.blank")];
  const drop = peg ? peg.dropWaiting : 0;
  blanks.forEach((b, i) => b.classList.toggle("burns", i >= blanks.length - drop));
}

async function refreshCollectible() {
  if (!isCollectible()) return;
  try { const cfg = await H.collectible.fetchCollectionConfig(ctx.connection, S.pool.address); if (cfg) S.info.collectible = cfg; } catch (_) {}
  await renderMine();
  renderEdit();
  if (C.allLoaded) loadAll();
}

/// Read the wallet's list, its waiting pieces and its coins, then draw. Skips the draw when
/// nothing changed, so a poll never wipes a form the holder is typing in.
async function renderMine(force) {
  const card = $("colMine");
  card.hidden = false;
  const W = Wallet.current();
  const head = () => el("div", { class: "card-head" }, el("h3", { text: "Your pieces" }));
  if (!W.publicKey) {
    C.seq++; C.ticket = null; C.pieces = []; C.st = null; C.backing = 0n; C.sel = ""; C.sendTo = ""; C.drawn = ""; C.queue = []; C.stale = []; C.rx = null; C.deposit = 0n; C.withdrawable = 0n; C.ticketLen = 0;
    clearTimeout(C.recheck);
    card.replaceChildren(head(), el("p", { class: "small muted", text: "Connect a wallet to see the pieces you hold on this coin." }));
    renderCost();
    return;
  }
  const id = ++C.seq;
  let ticket = null, ticketInfo = null, owned = [], slot = 0, backing = 0n, queue = [];
  try {
    // the ticket as an account: its list and waiting pieces, and its lamports above the rent, the deposit. The
    // chain's rent rides in the first read only (the SDK client keeps it an hour).
    [ticketInfo, owned, slot, [backing], queue] = await Promise.all([
      ctx.connection.getAccountInfo(H.collectiblePda.ticket(S.pool.address, W.publicKey)),
      H.collectible.fetchOwnedPieces(ctx.connection, S.pool.address, W.publicKey),
      ctx.connection.getSlot("confirmed"),
      H.collectible.fetchBacking(ctx.connection, S.info.collectible, [W.publicKey]),
      isPeggedCoin() ? H.collectible.fetchQueue(ctx.connection, S.pool.address) : Promise.resolve([]),
      loadRent(),
    ]);
  } catch (_) {
    if (id !== C.seq) return;
    if (!C.drawn) card.replaceChildren(head(), el("p", { class: "small muted", text: "The RPC at " + ctx.rpcHost + " did not return your pieces." }));
    // a read that failed is tried again soon, three times at most, then the next poll takes over
    C.fails = (C.fails || 0) + 1;
    clearTimeout(C.recheck);
    if (C.fails <= 3) C.recheck = setTimeout(() => renderMine(), 2500);
    return;
  }
  if (id !== C.seq) return; // a newer read is on its way
  C.fails = 0;
  const open = !!ticketInfo && ticketInfo.data.length > 0;
  try { ticket = open ? H.collectible.decodeTicket(new Uint8Array(ticketInfo.data)) : null; } catch (_) { ticket = null; }
  // what a mint can use: the lamports above the rent of the ticket's length (the keeper's check)
  C.deposit = open ? H.collectible.depositOf(ticketInfo.lamports, ticketInfo.data.length, RENT) : 0n;
  // what Withdraw deposit pays: the program first shrinks the ticket to its list, so the rent of
  // the places that pieces left comes back too
  C.withdrawable = ticket && H.collectible.withdrawableDeposit ? H.collectible.withdrawableDeposit(ticketInfo.lamports, ticketInfo.data.length, ticket.owned.length, RENT) : C.deposit;
  C.ticketLen = open ? ticketInfo.data.length : 0;
  C.slot = BigInt(slot);
  // the ticket is the list; the piece accounts only add names and art
  const byKey = new Map(owned.map((p) => [keyOf(p), p]));
  const pieces = ticket ? ticket.owned.map((k) => byKey.get(k.toBase58()) || { address: k, name: short(k.toBase58()), art: null, seed: null }) : [];
  const st = ticket ? H.collectible.ticketStatus(ticket, BigInt(slot)) : { undecided: 0, mintable: 0, nextRevealAfterSlot: 0n };
  C.ticket = ticket; C.pieces = pieces; C.st = st; C.backing = backing;
  // a piece that came in a transfer is in the list at once; its NFT follows when someone delivers it
  C.queue = queue; C.stale = isPeggedCoin() ? pieces.filter((p) => p.owner && !p.owner.equals(W.publicKey)) : [];
  // pieces found undecided on load: look again once their block is in, so "deciding" becomes "waiting";
  // pieces the keeper is about to mint: look again until they are in
  clearTimeout(C.recheck);
  if (!C.flow && (st.undecided > 0 || keeperExpected())) C.recheck = setTimeout(() => renderMine(), 1500);
  if (C.sel && !pieces.some((p) => keyOf(p) === C.sel)) { C.sel = ""; C.sendTo = ""; }
  const state = [W.publicKey.toBase58(), pieces.map(keyOf).join(","), st.undecided, st.mintable, String(backing), C.flow ? C.flow.state + C.flow.earned : "", C.busy ? 1 : 0, C.said || "", C.queue.length, C.stale.length, String(C.deposit), String(C.withdrawable), keeperExpected() ? 1 : 0].join("|");
  if (!force && state === C.drawn) return;
  C.drawn = state;
  drawMine();
}

function drawMine() {
  const card = $("colMine");
  const c = S.info.collectible;
  const st = C.st || { undecided: 0, mintable: 0 };
  const flow = C.flow, pieces = C.pieces;
  const head = el("div", { class: "card-head" }, el("h3", { text: "Your pieces" }));
  const kids = [head];
  if (flow && flow.state === "deciding") kids.push(el("p", { class: "mine-status", text: flow.earned > 0 ? flow.earned + (flow.earned === 1 ? " piece earned. Its look is" : " pieces earned. Their look is") + " decided by a block two slots from now." : nftWords(flow.nfts, "being minted") }));
  else if (flow && flow.state === "keeper") kids.push(el("p", { class: "mine-status", text: nftWords(flow.nfts, "being minted") }));
  // the keeper mints pieces whose deposit covers them a few seconds after their block; until then the
  // page says so, and a wallet that would mint them itself never meets the keeper's mint
  const keeper = !flow && keeperExpected();
  if (keeper) kids.push(el("p", { class: "mine-status", text: nftWords(C.ticket.pending, "being minted") }));
  // pieces left over from earlier buys: decided, not minted yet, and no keeper is minting them
  else if (!flow && st.mintable > 0) {
    const btn = el("button", { class: "btn btn-sm btn-primary", type: "button", text: "Mint " + st.mintable + " waiting" });
    btn.addEventListener("click", () => mintWaiting(btn));
    head.append(btn);
  }
  // a deposit left over with nothing waiting: the wallet can take it back, the rent of the places freed
  // by pieces that left its list included
  if (!flow && C.ticket && C.ticket.pending === 0 && C.withdrawable > 0n) {
    const btn = el("button", { class: "btn btn-sm", type: "button", id: "withdrawDeposit", text: "Withdraw deposit" });
    btn.addEventListener("click", () => withdrawDeposit(btn));
    head.append(btn);
    kids.push(el("p", { class: "small muted deposit-line", text: "Your deposit holds " + fmtAmount(C.withdrawable, SOL_DECIMALS, 6) + " SOL. It pays for the NFTs of your next buy, or you can withdraw it." }));
  }
  if (C.said) kids.push(el("p", { class: "error-text", "aria-live": "polite", text: C.said }));
  // waiting pieces join the end of the list once minted, so their blank tiles come last
  const blanks = [];
  const waiting = st.undecided + st.mintable;
  if (flow) for (let i = 0; i < Math.max(waiting, flow.state === "deciding" ? flow.earned : 0); i++) blanks.push(pieceBlank(flow.state === "deciding" ? "deciding" : "minting", true));
  else {
    for (let i = 0; i < st.undecided; i++) blanks.push(pieceBlank("deciding", true));
    for (let i = 0; i < st.mintable; i++) blanks.push(keeper ? pieceBlank("minting", true) : pieceBlank("waiting", false));
  }
  if (!pieces.length && !blanks.length) kids.push(el("p", { class: "small muted", text: "No pieces yet. A buy of at least " + unitText() + " earns one. You keep it while you hold those coins." }));
  else {
    if (!flow) kids.push(pegLine(pieces.length, waiting, c));
    // a long list shows its end first: those are the pieces a sell burns
    const n = pieces.length;
    const from = n > SHOWN && !C.all ? n - SHOWN : 0;
    if (n > SHOWN) {
      const more = el("button", { class: "btn btn-sm", type: "button", text: C.all ? "Show the last " + SHOWN : "Show all " + n });
      more.addEventListener("click", () => { C.all = !C.all; drawMine(); });
      kids.push(el("div", { class: "pieces-more" }, more, C.all ? null : el("span", { class: "small muted", text: "The last " + SHOWN + " are shown. They burn first." })));
    }
    if (C.sel && !pieces.slice(from).some((p) => keyOf(p) === C.sel)) { C.sel = ""; C.sendTo = ""; }
    // the panel of the picked piece sits in the grid, on the row under its tile
    const tiles = [];
    pieces.forEach((p, i) => { if (i < from) return; tiles.push(ownTile(p, i, n)); if (C.sel === keyOf(p)) tiles.push(piecePanel()); });
    kids.push(el("div", { class: "pieces mine" }, ...tiles, ...blanks));
    if (n && !C.sel) kids.push(el("p", { class: "help", text: "Pick a piece to move it or send it." }));
  }
  const typing = card.contains(document.activeElement) && document.activeElement.classList.contains("send-to");
  const before = C.flip && !reduceMotion ? tileRects() : null;
  mountMine(card, kids);
  if (before) playFlip(before);
  if (typing) { const i = card.querySelector(".send-to"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  C.flip = false; C.fresh = false;
  if (S.lastQuote && T.earn) renderEarn(amountIn() ? S.lastQuote : null);
  renderCost();
}

/// One plain line: what the wallet holds and what its coins back.
function pegLine(held, waiting, c) {
  const peg = H.collectible.pegStatus(C.ticket, C.backing, c.unit);
  const are = waiting === 1 ? " is" : " are";
  const holds = held === 0 && waiting ? plural(waiting, "piece") + are + " waiting" : "You hold " + plural(held, "piece") + (waiting ? " and " + waiting + are + " waiting" : "");
  const p = el("p", { class: "mine-peg" }, holds + ". Your coins back " + (peg.allowed > peg.held ? "up to " : "") + peg.allowed + ".");
  const extra = peg.dropWaiting + peg.burn.length;
  if (extra > 0) {
    const one = 10n ** BigInt(S.baseDec);
    const need = (BigInt(peg.held) * c.unit - C.backing + one - 1n) / one;
    p.append(el("span", { class: "over", text: " Anyone can burn the extra " + (extra === 1 ? "one" : extra) + ", from the end of your list. Buy " + need.toLocaleString("en-US") + " " + S.symbol + " and you keep " + (extra === 1 ? "it" : "them") + "." }));
  }
  return p;
}

// ---- what a piece shows: the generated creature, or the launcher's own art ---------------------------
// A piece's address on chain is <uri_base>/p/<art>/<seed>. Under this site's /art/u/<folder> the
// art is the launcher's upload and the resolver answers the piece's JSON (its image and traits);
// anything else is drawn here from the art and seed bytes, as the generated renderer does.

/// The art of a collection in a few words, from its uri_base.
function artWords(uriBase) {
  const f = folderOf(uriBase);
  if (f) return "your files, folder " + short(f, 5);
  if (/\/art\/?$/.test(String(uriBase || ""))) return "generated";
  try { return "renderer at " + new URL(uriBase).host; } catch (_) { return "renderer"; }
}
/// The rarity tag of a generated piece, "" for the launcher's own art.
function generatedRarity(p) { return !folderOf(p.uri) && p.art && p.seed ? H.pieceTraits(p.art, p.seed).rarity : ""; }
/// A piece's picture at `size` pixels: the uploaded image through the resolver, or the generated one.
function pieceVisual(p, size, alt = "") {
  if (folderOf(p.uri)) {
    const img = el("img", { class: "piece-img art", width: size, height: size, alt, decoding: "async" });
    img.onerror = () => { img.onerror = null; img.removeAttribute("src"); img.classList.add("blank-img"); };
    const a = pieceArt(p);
    if (a) a.then((r) => { if (r && r.image) img.src = r.image; else img.classList.add("blank-img"); if (r && r.hidden) img.title = "Hidden by the site operator"; });
    return img;
  }
  return p.art && p.seed ? pieceImg(p.art, p.seed, size, alt) : el("span", { class: "piece-img blank-img" });
}
/// The chance of each trait of a generated piece: the renderer reads one seed byte per trait.
function generatedRows(p) {
  const t = H.pieceTraits(p.art, p.seed), art = H.collectible.bytesOfHex(p.art);
  const rareAt = art[5] || 12, uncAt = Math.min(rareAt * 4, 255);
  const share = (n, v) => { let c = 0; for (let b = 0; b < 256; b++) if (b % n === v) c++; return (c * 100) / 256; };
  return [
    ["Rarity", t.rarity, ((t.rarity === "rare" ? rareAt : t.rarity === "uncommon" ? uncAt - rareAt : 256 - uncAt) * 100) / 256],
    ["Body", t.body, share(6, t.body)], ["Eyes", t.eyes, share(5, t.eyes)], ["Horn", t.horn, share(4, t.horn)], ["Mark", t.mark, share(6, t.mark)], ["Mirror", t.mirror ? "yes" : "no", 50],
  ];
}
/// A piece's picture with its traits and the chance of each, for the panel of a picked piece.
/// `owner`: the wallet that holds it, said in the collection's grid.
function pieceDetail(p, owner) {
  const list = el("dl", { class: "kv pd-traits" });
  const line = el("p", { class: "help pd-line" });
  const artName = el("p", { class: "pd-name", hidden: true });
  const links = el("div", { class: "pd-links small" },
    el("a", { class: "link", href: explorer("account", keyOf(p)), target: "_blank", rel: "noopener", text: "View on Solscan" }),
    webHref(p.uri) ? el("a", { class: "link", href: webHref(p.uri), target: "_blank", rel: "noopener", text: "Metadata" }) : null);
  const row = (k, v, pct) => [el("dt", { text: String(k) }), el("dd", null, el("span", { text: String(v) }), pct !== null && pct !== undefined && isFinite(pct) ? el("span", { class: "pd-pct", text: fmtChance(pct) }) : null)];
  (async () => {
    if (folderOf(p.uri)) {
      list.replaceChildren(el("dt", { text: "Traits" }), el("dd", { text: "reading" }));
      const [a, m] = await Promise.all([pieceArt(p), folderManifest(p.uri)]);
      if (!a || a.error) { list.replaceChildren(); line.textContent = (a && a.error) || "The art of this piece could not be read."; return; }
      if (a.hidden) { list.replaceChildren(); line.textContent = "The site operator hid this collection's art."; return; }
      const odds = m ? oddsOf(m) : null;
      const at = (t, v) => (odds && odds[t] && odds[t][String(v)] !== undefined ? odds[t][String(v)] : null);
      // the art's own name, when it says more than the piece's name on chain (a picture's title)
      if (a.name && !String(p.name).startsWith(a.name)) { artName.textContent = a.name; artName.hidden = false; }
      list.replaceChildren(...a.attributes.filter((x) => x && x.trait_type !== undefined).flatMap((x) => row(x.trait_type, x.value, at(x.trait_type, x.value))));
      if (!a.attributes.length) list.append(el("dt", { text: "Traits" }), el("dd", { text: "none" }));
      // the chance of this exact picture, or of this mix of layers
      const d = m && p.seed ? drawPiece(m, p.seed) : null;
      if (d && isFinite(d.chance)) line.textContent = (m.kind === "pictures" ? "This picture" : "This mix of layers") + " comes up in " + fmtChance(d.chance * 100) + " of draws.";
    } else if (p.art && p.seed) list.replaceChildren(...generatedRows(p).flatMap(([k, v, pct]) => row(k, v, pct)));
  })();
  return el("div", { class: "pd" },
    el("div", { class: "pd-img" }, pieceVisual(p, 160, p.name)),
    el("div", { class: "pd-body" }, artName, owner ? el("p", { class: "small muted pd-owner" }, "Held by ", el("span", { class: "mono", text: short(owner.toBase58(), 5), title: owner.toBase58() })) : null, list, line, links));
}

/// A piece of the wallet's list: its position, its art, and a mark on the one that burns first.
function ownTile(p, i, n) {
  const last = i === n - 1;
  const rarity = generatedRarity(p);
  return el("button", { class: "piece own", type: "button", "data-addr": keyOf(p), "data-last": last ? "1" : null, "aria-pressed": C.sel === keyOf(p) ? "true" : "false",
    "aria-label": p.name + ", number " + (i + 1) + " of " + n + (last ? ", burns first" : ""), onclick: () => pick(keyOf(p)) },
    el("span", { class: "piece-frame" },
      pieceVisual(p, 96, ""),
      el("span", { class: "pos", text: String(i + 1) }),
      el("span", { class: "ribbon", hidden: !last, text: last ? "burns first" : "" })),
    el("span", { class: "n", text: p.name }),
    rarity ? el("span", { class: "meta" }, el("span", { class: "tag" + (rarity === "rare" ? " accent" : ""), text: rarity })) : null);
}
function pick(key) {
  if (C.busy) return;
  C.sel = C.sel === key ? "" : key;
  C.sendTo = ""; C.fresh = true;
  drawMine();
}

/// Why Move and Send are off for a wallet above the peg, and what to do about it.
const LOCKED = "You hold more pieces than your coins back, so moving and sending are locked. Buy the coins back, or the extra pieces burn.";

/// The controls of the picked piece: move it to either end of the list, or send it.
function piecePanel() {
  const i = C.pieces.findIndex((p) => keyOf(p) === C.sel);
  if (i < 0) return null;
  const p = C.pieces[i], n = C.pieces.length;
  // the program refuses a reorder and a send while the wallet holds more pieces than its coins back
  const locked = !!abovePeg();
  const first = el("button", { class: "btn btn-sm", type: "button", disabled: i === 0 || C.busy || locked, text: "Move first" });
  const last = el("button", { class: "btn btn-sm", type: "button", disabled: i === n - 1 || C.busy || locked, text: "Move last" });
  first.addEventListener("click", () => movePiece(p, true, first));
  last.addEventListener("click", () => movePiece(p, false, last));
  const to = el("input", { class: "input mono send-to", type: "text", placeholder: "Recipient address", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Recipient address", value: C.sendTo, disabled: locked });
  const err = el("div", { class: "error-text", role: "alert" });
  const send = el("button", { class: "btn btn-sm", type: "submit", disabled: C.busy || locked, text: "Send" });
  to.addEventListener("input", () => { C.sendTo = to.value; err.textContent = ""; });
  const form = el("form", { class: "send-row" }, to, send);
  form.addEventListener("submit", (e) => { e.preventDefault(); sendPiece(p, to, send, err); });
  return el("div", { class: "piece-panel" + (C.fresh ? " in" : "") },
    el("div", { class: "pp-head" }, el("span", { class: "mono", text: p.name }), el("span", { class: "dim small", text: "number " + (i + 1) + " of " + n })),
    pieceDetail(p),
    locked ? el("p", { class: "lock", text: LOCKED }) : null,
    el("div", { class: "pp-row" }, first, last),
    locked ? null : el("p", { class: "help", text: isPeggedCoin() ? "A sell burns from the end of your list. A transfer takes from the end too. Number 1 goes last." : "A sell burns from the end of your list. Number 1 burns last." }),
    form,
    el("p", { class: "help", text: isPeggedCoin() ? "The piece travels with exactly " + unitText() + ". Send opens the receiver's ticket first, so it arrives." : "The piece travels with " + unitText() + "." }),
    err);
}

/// One reorder instruction, one signature. The position is read again right before signing,
/// because a burn or a send in the meantime shifts the list.
async function movePiece(p, toFront, btn) {
  if (C.busy) return;
  const verb = btn.textContent;
  let done = false;
  try {
    const user = requireWallet();
    C.busy = true; btn.disabled = true; btn.textContent = "Confirm in your wallet";
    const t = await H.collectible.fetchTicket(ctx.connection, S.pool.address, user);
    const from = t ? t.owned.findIndex((k) => k.toBase58() === keyOf(p)) : -1;
    if (from < 0) throw new Error("This wallet no longer holds " + p.name + ".");
    const to = toFront ? 0 : t.owned.length - 1;
    if (from !== to) {
      const sig = await sendIxs(await ctx.client.collectibleReorderInstructions(user, S.pool.address, from, to), [], "move");
      toast(p.name + " is now number " + (to + 1) + ".", "ok", { href: explorer("tx", sig), text: "View" });
    }
    done = true;
  } catch (e) { toast(e.message, "err"); sayUnder(btn, e.message); }
  C.busy = false; C.flip = done;
  btn.textContent = verb;
  await renderMine(true);
}

/// Send a piece with the coins behind it. The address is checked here, the rest by the program.
async function sendPiece(p, input, btn, err) {
  if (C.busy) return;
  err.textContent = "";
  const raw = input.value.trim();
  if (!raw) { input.focus(); return; }
  let to, user;
  try { to = new PublicKey(raw); } catch (_) { err.textContent = "That is not a valid address."; return; }
  try { user = requireWallet(); } catch (e) { err.textContent = e.message; return; }
  if (to.equals(user)) { err.textContent = "That is your own wallet."; return; }
  if (abovePeg()) { err.textContent = LOCKED; return; }
  if (S.balances.base < S.info.collectible.unit) { err.textContent = "You need " + unitText() + " in this wallet to send a piece."; return; }
  C.busy = true; btn.disabled = true; btn.textContent = "Confirm in your wallet";
  try {
    // on a pegged coin a piece that finds no room at the receiver stays behind or burns while its coins still move
    if (isPeggedCoin()) { const no = noRoom(await readReceiver(to)); if (no) throw new Error(no); }
    const ixs = await ctx.client.collectibleSendInstructions(user, S.pool.address, to, [p.address]);
    const sig = await sendIxs(ixs, [], "send");
    toast(p.name + " sent with " + unitText() + ".", "ok", { href: explorer("tx", sig), text: "View" });
    C.sel = ""; C.sendTo = "";
  } catch (e) {
    C.busy = false; btn.disabled = false; btn.textContent = "Send";
    err.textContent = e.message;
    return;
  }
  C.busy = false;
  await refreshPool();
  await renderMine(true);
  if (C.allLoaded) loadAll();
}

// ---- pegged coin: send coins, and the NFTs that follow their pieces --------------------------------
// On a pegged coin every transfer of the coin runs the collectible program. The pieces the
// sender's coins no longer back leave the end of its list inside that transfer: they go to the
// receiver, one piece per whole unit the transfer sends, while it has a ticket and its
// coins back them, and burn otherwise. The form below
// sends coins through the SDK, which opens the receiver's ticket first, and says beforehand,
// by name, what the transfer does to the pieces.

/// A wallet that never held a piece of this coin, as the transfer finds it once its ticket is open.
const NO_TICKET = { owned: [], pending: 0 };

/// Put the drawn list into the card. The Send coins form is one node kept across draws and is
/// left where it stands, so a poll never takes the focus or the typed text away.
function mountMine(card, kids) {
  const send = sendBox();
  const tail = upkeepLine();
  if (send && send.parentNode === card) {
    for (const n of [...card.childNodes]) if (n !== send) n.remove();
    send.before(...kids);
    if (tail) send.after(tail);
  } else card.replaceChildren(...kids, ...[send, tail].filter(Boolean));
}

/// The Send coins form, for a connected wallet that holds coins of a pegged coin. Null otherwise.
/// A wallet that just sent its last coins keeps the result of that transfer, without the form.
function sendBox() {
  const W = Wallet.current();
  if (!isPeggedCoin() || !W.publicKey) return null;
  const who = W.publicKey.toBase58(), empty = C.backing <= 0n;
  if (empty && !(C.send && C.send.sent === who)) return null;
  if (!C.send) C.send = buildSendBox();
  const b = C.send;
  if (b.who !== who) { b.who = who; b.sent = ""; b.to.value = ""; b.amt.value = ""; b.err.textContent = ""; b.res.replaceChildren(); C.rx = null; }
  b.form.hidden = empty; b.balanceRow.hidden = empty; b.help.hidden = empty;
  b.balance.textContent = "Balance " + fmtUnits(C.backing, S.baseDec, 4) + " " + S.symbol;
  if (!b.sending) b.btn.disabled = C.busy;
  if (C.rx) lookupReceiver(); // the receiver may have changed too: read it again, keep what is shown meanwhile
  sendOutcome();
  return b.node;
}
function buildSendBox() {
  const to = el("input", { class: "input mono coin-to", type: "text", placeholder: "Recipient address", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Recipient address" });
  const amt = el("input", { class: "input num coin-amt", type: "text", inputmode: "decimal", placeholder: "0.0", autocomplete: "off", "aria-label": "Amount of " + S.symbol + " to send" });
  const btn = el("button", { class: "btn btn-sm", type: "submit", text: "Send" });
  const balance = el("span");
  const carry = el("div", { class: "earn-line", "aria-live": "polite" });
  const cost = el("div", { class: "earn-line cost", "aria-live": "polite" });
  const err = el("div", { class: "error-text", role: "alert" });
  const res = el("div", { class: "tx-result" });
  const typed = () => { err.textContent = ""; res.replaceChildren(); if (C.send) C.send.sent = ""; sendOutcome(); };
  to.addEventListener("input", typed);
  amt.addEventListener("input", typed);
  const max = el("button", { type: "button", text: "Max", onclick: () => { amt.value = fmtUnits(C.backing, S.baseDec, S.baseDec).replace(/,/g, ""); typed(); } });
  const form = el("form", { class: "send-coins" }, to, el("div", { class: "input-wrap" }, amt, el("span", { class: "suffix", text: S.symbol })), btn);
  form.addEventListener("submit", (e) => { e.preventDefault(); sendCoins(); });
  const balanceRow = el("div", { class: "balance" }, balance, max);
  const help = el("p", { class: "help", text: "A transfer carries the pieces your coins no longer back. They leave from the end of your list." });
  const node = el("div", { class: "mine-send" }, el("h4", { text: "Send coins" }), form, balanceRow, carry, cost, err, res, help);
  return { node, form, balanceRow, help, to, amt, btn, balance, carry, cost, err, res, who: "", sent: "", sending: false };
}
function sendInputs() {
  const b = C.send;
  let to = null;
  try { to = new PublicKey(b.to.value.trim()); } catch (_) {}
  const a = parseUnits(b.amt.value, S.baseDec);
  return { to, amount: a && a > 0n ? a : null };
}

/// What a pegged coin's transfer finds at the other end: the wallet's ticket and the coins in its
/// token account. `problem` is a sentence when the address is not a wallet to send to.
async function readReceiver(to) {
  const c = S.info.collectible, W = Wallet.current();
  const [acct, ticketInfo, coins] = await ctx.connection.getMultipleAccountsInfo([to, H.collectiblePda.ticket(S.pool.address, to), H.collectible.coinsAddress(to, c.baseMint, c.tokenProgram)]);
  let problem = "";
  if (W.publicKey && to.equals(W.publicKey)) problem = "That is your own wallet.";
  else if (to.equals(S.pool.address)) problem = "That is the pool. Sell in the trade form to send coins to it.";
  else if (acct && (acct.owner.equals(H.TOKEN_PROGRAM) || acct.owner.equals(H.TOKEN_2022_PROGRAM))) problem = "That is a token account or a coin. Enter the wallet address.";
  else if (acct && acct.executable) problem = "That is a program, not a wallet.";
  let ticket = null;
  if (ticketInfo && ticketInfo.data.length) { try { ticket = H.collectible.decodeTicket(new Uint8Array(ticketInfo.data)); } catch (_) {} }
  return { key: to.toBase58(), ticket, backing: H.collectible.backingOf(coins, to, c.baseMint, c.tokenProgram), problem };
}
/// Why a wallet cannot take one more piece with exactly its coins, or "" when it can.
function noRoom(rx) {
  if (rx.problem) return rx.problem;
  const c = S.info.collectible;
  const theirs = rx.ticket ? rx.ticket.owned.length + rx.ticket.pending : 0;
  if (theirs >= H.collectible.MAX_PIECES_PER_WALLET) return "That wallet already holds " + H.collectible.MAX_PIECES_PER_WALLET + " pieces of this coin. It cannot take more.";
  if ((rx.backing + c.unit) / c.unit <= BigInt(theirs)) return "That wallet holds more pieces than its coins back. It cannot take this piece now.";
  return "";
}
const lookupReceiver = debounce(async () => {
  if (!C.send) return;
  const { to } = sendInputs();
  if (!to) return;
  const id = ++C.rxSeq;
  let rx;
  try { rx = await readReceiver(to); } catch (_) { return; }
  if (id !== C.rxSeq) return;
  C.rx = rx;
  sendOutcome();
}, 250);

/// What the typed transfer does to the pieces, by name. Before the receiver is read it says
/// what leaves the list. Once its ticket and coins are known it says what arrives and what burns.
function sendOutcome() {
  const b = C.send;
  if (!b) return;
  b.carry.replaceChildren(); b.cost.replaceChildren();
  const { to, amount } = sendInputs();
  const known = to && C.rx && C.rx.key === to.toBase58() ? C.rx : null;
  if (to && !known) lookupReceiver();
  if (known && known.problem && !b.sending) b.err.textContent = known.problem;
  if (!amount || amount > C.backing || !C.ticket) return;
  const unit = S.info.collectible.unit;
  if (!known || known.problem) {
    const peg = H.collectible.pegStatus(C.ticket, C.backing - amount, unit);
    if (peg.burn.length) b.carry.append(el("div", { text: "This transfer moves " + plural(peg.burn.length, "piece") + " off your list: " + nameList(peg.burn.map(pieceName)) + "." }));
    if (peg.dropWaiting) b.cost.append(el("div", { text: "This transfer drops " + plural(peg.dropWaiting, "waiting piece") + "." }));
    return;
  }
  const o = H.collectible.predictTransfer(C.ticket, C.backing, known.ticket || NO_TICKET, known.backing, amount, unit);
  if (o.moved.length) {
    b.carry.append(el("div", { text: "This transfer carries " + plural(o.moved.length, "piece") + ": " + nameList(o.moved.map(pieceName)) + "." }));
    if (!known.ticket) b.carry.append(el("div", { class: "sub", text: "This wallet has no ticket for " + S.symbol + " yet. Send opens it, so the " + (o.moved.length === 1 ? "piece arrives." : "pieces arrive.") }));
  }
  if (o.burned.length) {
    const theirs = known.ticket ? known.ticket.owned.length + known.ticket.pending : 0;
    const full = theirs + o.moved.length >= H.collectible.MAX_PIECES_PER_WALLET;
    b.cost.append(el("div", { text: "This transfer burns " + plural(o.burned.length, "piece") + ": " + nameList(o.burned.map(pieceName)) + "." }),
      el("div", { class: "sub", text: full ? "The receiver already holds " + H.collectible.MAX_PIECES_PER_WALLET + " pieces." : "The receiver takes one piece for each whole " + unitText() + " this transfer sends." }));
  }
  if (o.dropWaiting) b.cost.append(el("div", { text: "This transfer drops " + plural(o.dropWaiting, "waiting piece") + "." }));
}

/// Send coins of a pegged coin. The SDK opens the receiver's token account and ticket, sends the
/// transfer, and hands over or burns the NFTs of the pieces that left, all in one transaction.
/// Afterwards the two lists are read again, and the result says what the chain did.
async function sendCoins() {
  const b = C.send;
  if (C.busy || !b) return;
  b.err.textContent = ""; b.res.replaceChildren();
  const raw = b.to.value.trim();
  if (!raw) { b.to.focus(); return; }
  let to, user;
  try { to = new PublicKey(raw); } catch (_) { b.err.textContent = "That is not a valid address."; return; }
  try { user = requireWallet(); } catch (e) { b.err.textContent = e.message; return; }
  const amount = parseUnits(b.amt.value, S.baseDec);
  if (!amount || amount <= 0n) { b.amt.focus(); return; }
  if (amount > C.backing) { b.err.textContent = "You hold " + fmtUnits(C.backing, S.baseDec, S.baseDec) + " " + S.symbol + "."; return; }
  C.busy = true; b.sending = true; b.btn.disabled = true; b.btn.textContent = "Confirm in your wallet";
  const held = C.pieces.slice();
  let sig = "";
  try {
    const rx = await readReceiver(to);
    if (rx.problem) throw new Error(rx.problem);
    const { instructions } = await ctx.client.collectibleTransferInstructions(user, S.pool.address, to, amount);
    sig = await sendIxs(instructions, [], "transfer");
    toast("Sent " + fmtUnits(amount, S.baseDec, S.baseDec) + " " + S.symbol + ".", "ok", { href: explorer("tx", sig), text: "View" });
    b.to.value = ""; b.amt.value = ""; C.rx = null; b.sent = user.toBase58();
  } catch (e) { b.err.textContent = e.message; }
  C.busy = false; b.sending = false; b.btn.textContent = "Send";
  await refreshPool();
  await renderMine(true);
  b.btn.disabled = false;
  if (sig) {
    b.res.replaceChildren(el("span", { class: "ok", text: "Sent. " }), el("a", { class: "link", href: explorer("tx", sig), target: "_blank", rel: "noopener", text: short(sig, 6) }));
    const left = new Set(C.pieces.map(keyOf));
    const gone = held.filter((p) => !left.has(keyOf(p))).reverse(); // the end of the list left first
    if (gone.length) {
      let theirs = new Set();
      try { const t = await H.collectible.fetchTicket(ctx.connection, S.pool.address, to); if (t) theirs = new Set(t.owned.map((k) => k.toBase58())); } catch (_) {}
      const carried = gone.filter((p) => theirs.has(keyOf(p))), burned = gone.filter((p) => !theirs.has(keyOf(p)));
      if (carried.length) b.res.append(el("div", { class: "burned", text: "This transfer carried " + plural(carried.length, "piece") + ": " + nameList(carried.map((p) => p.name)) + "." }));
      if (burned.length) b.res.append(el("div", { class: "burned", text: "This transfer burned " + plural(burned.length, "piece") + ": " + nameList(burned.map((p) => p.name)) + "." }));
    }
  }
  if (C.allLoaded) loadAll();
}

/// One quiet line for the NFTs that have not followed their pieces yet. A piece moves or burns
/// inside the transfer; its Metaplex NFT follows in a delivery or a burn that anyone can send.
/// The site adds both to its own transactions, so this shows after a transfer made elsewhere.
function upkeepLine() {
  if (!isPeggedCoin() || !Wallet.current().publicKey) return null;
  const stale = C.stale.length, queued = C.queue.length;
  if (!stale && !queued) return null;
  const parts = [];
  if (stale) parts.push(stale === 1 ? "The NFT of 1 of your pieces has not reached your wallet yet." : "The NFTs of " + stale + " of your pieces have not reached your wallet yet.");
  if (queued) parts.push(queued === 1 ? "The NFT of 1 burned piece still exists." : "The NFTs of " + queued + " burned pieces still exist.");
  const verb = stale && queued ? "Deliver and burn" : stale ? "Deliver" : "Burn";
  const btn = el("button", { class: "btn btn-sm", type: "button", disabled: C.busy, text: verb });
  btn.addEventListener("click", () => runUpkeep(btn, verb));
  return el("div", { class: "mine-upkeep" },
    el("div", null, el("div", { text: parts.join(" ") }), el("div", { class: "dim", text: "Anyone can send this. It costs a transaction fee." + (queued ? " Burning pays the sender the rent." : "") })),
    btn);
}
/// Send the deliveries and burns the pool has waiting: at most four transactions per click, signed in one prompt when the wallet allows it.
async function runUpkeep(btn, verb) {
  if (C.busy) return;
  let user;
  try { user = requireWallet(); } catch (e) { toast(e.message, "err"); return; }
  C.busy = true; btn.disabled = true; btn.textContent = "Confirm in your wallet";
  try {
    const txs = (await ctx.client.collectibleUpkeepInstructions(user, S.pool.address)).slice(0, 4);
    if (!txs.length) toast("Nothing is waiting.");
    else {
      let sig;
      if (txs.length > 1 && Wallet.canSignAll()) {
        const built = [];
        for (const ixs of txs) built.push(await ctx.client.buildTx(user, ixs));
        const signed = await signTxs(built.map((x) => x.tx));
        for (let i = 0; i < built.length; i++) sig = await sendSigned(signed[i], built[i], "delivery");
      } else for (const ixs of txs) sig = await sendIxs(ixs, [], "delivery");
      toast(verb === "Deliver" ? "Delivered." : verb === "Burn" ? "Burned." : "Delivered and burned.", "ok", { href: explorer("tx", sig), text: "View" });
    }
  } catch (e) { toast(e.message, "err"); sayUnder(btn, e.message); btn.textContent = verb; }
  C.busy = false;
  await refreshPool();
  await renderMine(true);
  if (C.allLoaded) loadAll();
}

/// After a reorder the tiles glide from where they were to where they are.
function tileRects() { const m = new Map(); for (const t of document.querySelectorAll("#colMine .piece.own")) m.set(t.dataset.addr, t.getBoundingClientRect()); return m; }
function playFlip(before) {
  for (const t of document.querySelectorAll("#colMine .piece.own")) {
    const a = before.get(t.dataset.addr);
    if (!a) continue;
    const b = t.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (dx || dy) t.animate([{ transform: "translate(" + dx + "px, " + dy + "px)" }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }
}

/// The wallet's own mint of its waiting pieces: the fallback when no keeper minted them. It is built from a
/// fresh read of the ticket (a keeper that minted a moment ago moved the wallet's next piece address, and a mint
/// built on an older read would fail) and simulated before the wallet sees it, so the wallet is never handed a
/// transaction that fails now. A deposit pays this mint first.
async function mintWaiting(btn) {
  C.said = "";
  const label = btn.textContent;
  try {
    const user = requireWallet();
    btn.disabled = true; btn.textContent = "Checking";
    let ixs = [];
    for (let round = 0; ; round++) {
      ixs = await ctx.client.collectibleMintInstructions(user, S.pool.address);
      if (!ixs.length) break;
      const why = await simulateFirst(user, ixs, "mint");
      if (!why) break;
      // the ticket changed between the read and the simulation: read it once more
      if (round >= 1) throw new Error(why);
      await sleep(800);
    }
    if (!ixs.length) toast("Your pieces are minted already.", "ok");
    else {
      btn.textContent = "Confirm in your wallet";
      const sig = await sendIxs(ixs, [], "mint");
      toast("Pieces minted.", "ok", { href: explorer("tx", sig), text: "View" });
    }
  } catch (e) { toast(e.message, "err"); sayUnder(btn, e.message); btn.textContent = label; btn.disabled = false; }
  await refreshPool();
  await refreshCollectible();
}

/// Take back what the ticket holds above its rent. The wallet signs; nothing else moves.
async function withdrawDeposit(btn) {
  C.said = "";
  const label = btn.textContent;
  try {
    const user = requireWallet();
    btn.disabled = true; btn.textContent = "Checking";
    const ixs = await ctx.client.collectibleWithdrawInstructions(user, S.pool.address);
    if (!ixs.length) toast("There is no deposit to withdraw.");
    else {
      const why = await simulateFirst(user, ixs, "withdraw");
      if (why) throw new Error(why);
      btn.textContent = "Confirm in your wallet";
      const sig = await sendIxs(ixs, [], "withdraw");
      toast("Deposit withdrawn.", "ok", { href: explorer("tx", sig), text: "View" });
    }
  } catch (e) { toast(e.message, "err"); sayUnder(btn, e.message); btn.textContent = label; btn.disabled = false; }
  await refreshPool();
  await refreshCollectible();
}

/// A simulation of `ixs` against the newest state, before the wallet sees them. "" when they would land, else
/// the sentence for the trader.
async function simulateFirst(user, ixs, label) {
  const { tx } = await ctx.client.buildTx(user, ixs);
  const sim = await ctx.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" });
  if (!sim.value.err) return "";
  const e = new Error(JSON.stringify(sim.value.err)); e.logs = sim.value.logs || [];
  return explainTxError(e, label);
}

/// What a collectible buy carries, read right before it is built. A buy that earns pieces pays the deposit
/// for their NFTs in the same transaction: one approval, and the keeper mints them into the wallet a few
/// seconds later (`mint_for`, paid back from that deposit). The deposit covers every piece the wallet will
/// have waiting, earlier ones too. A buy never carries a mint of its own: one that met anybody's mint_for would
/// fail the whole buy. A buy that earns nothing adds no deposit; earlier pieces with no deposit for them wait
/// for the wallet's own "Mint N waiting".
async function collectibleBuyPlan(user, qt) {
  // the ticket and the chain's rent (kept by the SDK client; read now only if the page never had it)
  let info = null, rent;
  try { [info, rent] = await Promise.all([ctx.connection.getAccountInfo(H.collectiblePda.ticket(S.pool.address, user)), loadRent()]); }
  catch (e) { if (!RENT) throw new Error(rpcFailText(e)); info = null; rent = RENT; }
  const open = !!info && info.data.length > 0;
  let t = null;
  try { t = open ? H.collectible.decodeTicket(new Uint8Array(info.data)) : null; } catch (_) {}
  const deposit = open ? H.collectible.depositOf(info.lamports, info.data.length, rent) : 0n;
  const out = typeof qt.amountOutCeiling === "bigint" ? qt.amountOutCeiling : qt.amountOut;
  const earns = ticketFull(t) ? 0 : earnCount({ amountOut: out }, t);
  const waitingBefore = t ? t.pending : 0;
  const need = H.collectible.mintDepositFor(rent, S.info.collectible, waitingBefore + earns);
  const keeper = earns > 0 || (waitingBefore > 0 && deposit >= need);
  // a ticket whose four batches are all taken earns nothing: the SDK is told so, and deposits for no piece of this buy
  const how = ticketFull(t) ? { pieces: 0 } : { amountOut: out };
  return { ticket: t, deposit, earns, nfts: waitingBefore + earns, keeper, topUp: keeper && need > deposit ? need - deposit : 0n, mintDeposit: keeper ? how : null };
}

/// Will a keeper mint this wallet's waiting pieces in a moment? Yes while the deposit covers the mint and the
/// newest batch's block is less than a minute old, unless the page already waited for it in vain.
const KEEPER_GRACE_SLOTS = 150n;
function keeperExpected() {
  const t = C.ticket;
  if (!isCollectible() || !t || t.pending === 0 || !(C.deposit > 0n) || C.keeperGaveUp || !RENT) return false;
  const n = Math.min(H.collectible.MAX_MINT_PER_CALL, t.pending);
  // the deposit (read at the chain's rent) against what the mint costs at the same rent
  const cost = H.collectible.mintForCost(RENT, S.info.collectible, C.ticketLen, t.owned.length, n);
  if (C.deposit < cost) return false;
  const newest = t.batches.filter((b) => b.pieces > 0).reduce((m, b) => (b.targetSlot > m ? b.targetSlot : m), 0n);
  return !!C.slot && C.slot - newest < KEEPER_GRACE_SLOTS;
}

/// A buy on a collectible pool. The pieces it earns are decided by a block two slots later, so they cannot
/// be minted in the buy. The buy pays the deposit for their NFTs (plan.keeper), the wallet signs once and a
/// keeper mints them; the page watches the ticket (keeperMint). "Mint N waiting" stays for a keeper that
/// does not come.
async function buyOnCollectible(user, ixs, label, plan) {
  C.said = ""; C.keeperGaveUp = false;
  const buy = await ctx.client.buildTx(user, ixs);
  // the wallet is handed the buy alone: anything signed up front that can only land after it would fail
  // the wallet's check against the chain as it is, and Phantom blocks such a request as unsafe
  const signedBuy = await signTx(buy.tx);
  const sig = await sendSigned(signedBuy, buy, label);
  // the watcher is told the buy landed, so that its keeper mints right after the buy's block. Fire and forget: the
  // keeper finds the buy by itself within a minute anyway. A plain-text body, so the browser sends no preflight.
  if (plan.keeper && plan.nfts > 0 && ctx.watcherUrl) { try { fetch(ctx.watcherUrl + "/notify", { method: "POST", body: JSON.stringify({ signature: sig }), keepalive: true }).catch(() => {}); } catch (_) {} }
  if (plan.keeper && plan.nfts > 0) { C.flow = { state: "deciding", earned: plan.earns, nfts: plan.nfts, keeper: true }; keeperMint(user, plan.nfts); }
  return sig;
}

/// After a buy that paid the deposit: the keeper mints the pieces into the wallet a few seconds after their
/// block. The page reads the ticket every half second, says "being minted" and shows the NFTs once they are in.
/// When no keeper came 30 seconds after the block, it says so and "Mint N waiting" comes back.
async function keeperMint(user, nfts) {
  renderMine(true);
  const t0 = Date.now();
  let ticket = null, decidedAt = null;
  const said = (text) => { const m = $("mintSaid"); if (m) m.textContent = text; };
  while (Date.now() - t0 < 90_000) {
    await sleep(500);
    const W = Wallet.current();
    if (!W.publicKey || !W.publicKey.equals(user) || !C.flow) return; // another wallet, or the page moved on
    let slot;
    try { [ticket, slot] = await Promise.all([H.collectible.fetchTicket(ctx.connection, S.pool.address, user), ctx.connection.getSlot("confirmed")]); } catch (_) { continue; }
    if (!ticket) continue;
    if (ticket.pending === 0) break;
    const st = H.collectible.ticketStatus(ticket, BigInt(slot));
    if (st.undecided === 0 && C.flow.state !== "keeper") { C.flow = { ...C.flow, state: "keeper" }; decidedAt = Date.now(); renderMine(true); }
    if (decidedAt && Date.now() - decidedAt > 30_000) break;
  }
  C.flow = null;
  if (ticket && ticket.pending === 0) { said(nftWords(nfts, "in")); toast(nftWords(nfts, "in"), "ok"); }
  else { C.keeperGaveUp = true; C.said = nftWords(nfts, "late"); said(C.said); }
  await refreshPool();
  await refreshCollectible();
}

async function loadAll() {
  const card = $("colAll");
  const c = S.info.collectible;
  // burned pieces are gone: the grid and its count are the pieces that exist now
  const head = el("div", { class: "card-head" }, el("h3", { text: "Collection" }), el("span", { class: "small dim mono", text: fmtInt(c.live) + " of " + fmtInt(c.maxSupply) + " exist now" }));
  let pieces = [];
  // on a pegged coin the wallet lists are the truth: a burned piece keeps its NFT until someone burns
  // it, and a moved piece keeps its old NFT owner until someone delivers it
  const holder = new Map();
  try {
    pieces = await H.collectible.fetchCollectionPieces(ctx.connection, S.pool.address);
    if (c.pegged) {
      const [queue, tickets] = await Promise.all([H.collectible.fetchQueue(ctx.connection, S.pool.address), H.collectible.fetchTickets(ctx.connection, S.pool.address)]);
      const gone = new Set(queue.map((k) => k.toBase58()));
      pieces = pieces.filter((p) => !gone.has(keyOf(p)));
      for (const t of tickets) for (const k of t.owned) holder.set(k.toBase58(), t.user);
    }
  } catch (e) { card.replaceChildren(head, el("p", { class: "small muted", text: "The RPC did not return the collection. " + e.message })); return; }
  C.allData = { head, pieces, holder };
  drawAll();
}
/// The collection's latest pieces. A press on one opens its picture and traits under its row.
function drawAll() {
  const card = $("colAll"), c = S.info.collectible;
  const { head, pieces, holder } = C.allData;
  const latest = pieces.slice(-24).reverse();
  if (!latest.length) { card.replaceChildren(head, el("p", { class: "small muted", text: c.minted > 0 ? "No pieces exist right now. " + fmtInt(c.minted) + " were minted and all of them burned." : "No pieces minted yet. The first buy big enough mints piece 1." })); return; }
  if (C.allSel && !latest.some((p) => keyOf(p) === C.allSel)) C.allSel = "";
  const tiles = [];
  for (const p of latest) {
    const k = keyOf(p), owner = holder.get(k) || p.owner, rarity = generatedRarity(p);
    tiles.push(el("button", { class: "piece own", type: "button", "data-addr": k, "aria-pressed": C.allSel === k ? "true" : "false", "aria-label": p.name + ", show its traits", onclick: () => { C.allSel = C.allSel === k ? "" : k; C.allFresh = true; drawAll(); } },
      el("span", { class: "piece-frame" }, pieceVisual(p, 96, "")),
      el("span", { class: "n", text: p.name }),
      el("span", { class: "meta" }, rarity ? el("span", { class: "tag" + (rarity === "rare" ? " accent" : ""), text: rarity }) : null, el("span", { class: "dim", text: short(owner.toBase58()) }))));
    if (C.allSel === k) tiles.push(el("div", { class: "piece-panel" + (C.allFresh ? " in" : "") }, el("div", { class: "pp-head" }, el("span", { class: "mono", text: p.name })), pieceDetail(p, owner)));
  }
  C.allFresh = false;
  const kids = [head, el("div", { class: "pieces all" }, ...tiles)];
  if (pieces.length > latest.length) kids.push(el("p", { class: "help", text: "Showing the latest " + latest.length + " of " + fmtInt(pieces.length) + "." }));
  if (!C.allSel) kids.push(el("p", { class: "help", text: "Pick a piece to see its traits." }));
  card.replaceChildren(...kids);
}

function renderEdit() {
  const card = $("colEdit");
  const c = S.info.collectible;
  const W = Wallet.current();
  if (!W.publicKey || c.locked || !W.publicKey.equals(c.owner)) { card.hidden = true; card.dataset.built = ""; return; }
  if (card.dataset.built === "1") return; // keep what the owner is editing while the page polls
  card.hidden = false; card.dataset.built = "1";
  const name = el("input", { class: "input", maxlength: 24, value: c.name, autocomplete: "off", "aria-label": "Collection name" });
  // the art: as it is until the owner picks one of the four ways; an upload is paid here, before Save
  const said = el("p", { class: "error-text", "aria-live": "polite" });
  let studio = null;
  studio = artStudio({ id: "editArt", context: "edit", art: c.art, uriBase: c.uriBase, name: () => name.value.trim(), symbol: () => S.symbol || "", onChange: () => { said.textContent = studio ? studio.problem() : ""; } });
  const out = el("div", { class: "tx-result" });
  const save = el("button", { class: "btn btn-primary btn-block", id: "colSave", type: "button", text: "Save changes" });
  save.addEventListener("click", async () => {
    out.replaceChildren();
    const args = {};
    const newName = name.value.trim();
    const bytes = new TextEncoder().encode(newName).length;
    if (!bytes || bytes > 24) { out.replaceChildren(el("span", { class: "bad", text: "The name must be 1 to 24 bytes." })); return; }
    if (newName !== c.name) args.name = newName;
    let target = null;
    try { target = studio.target(); } catch (e) { out.replaceChildren(el("span", { class: "bad", text: e.message })); return; }
    if (target) {
      if (new TextEncoder().encode(target.uriBase).length > 80 || !/^https?:\/\//.test(target.uriBase)) { out.replaceChildren(el("span", { class: "bad", text: "The address of the art must start with http and be at most 80 bytes." })); return; }
      if (H.collectible.hexOf(target.art) !== H.collectible.hexOf(c.art)) args.art = target.art;
      if (target.uriBase !== c.uriBase) args.uriBase = target.uriBase;
    }
    if (!("name" in args) && !("art" in args) && !("uriBase" in args)) { out.replaceChildren(el("span", { class: "muted", text: "Nothing changed." })); return; }
    save.disabled = true; save.textContent = "Confirm in your wallet";
    try {
      const sig = await sendIxs([H.collectible.updateCollection(requireWallet(), S.pool.address, args)], [], "update");
      toast("Collection updated. Later pieces use it.", "ok", { href: explorer("tx", sig), text: "View" });
      if ("uriBase" in args && target && target.folder) studio.forgetSession();
      card.dataset.built = "";
      await refreshPool(); await refreshCollectible();
    } catch (e) { out.replaceChildren(el("span", { class: "bad", text: e.message })); save.disabled = false; save.textContent = "Save changes"; }
  });
  const confirmBox = el("div", { class: "confirm-line", hidden: true });
  const lock = el("button", { class: "btn btn-sm", type: "button", text: "Lock forever" });
  lock.addEventListener("click", () => {
    confirmBox.hidden = false;
    const yes = el("button", { class: "btn btn-sm", type: "button", text: "Lock forever" });
    yes.addEventListener("click", async () => {
      yes.disabled = true; yes.textContent = "Confirm in your wallet";
      try {
        const sig = await sendIxs([H.collectible.setCollectionOwner(requireWallet(), S.pool.address, H.SYSTEM_PROGRAM)], [], "lock");
        toast("Collection locked.", "ok", { href: explorer("tx", sig), text: "View" });
        await refreshPool(); await refreshCollectible();
      } catch (e) { out.replaceChildren(el("span", { class: "bad", text: e.message })); yes.disabled = false; yes.textContent = "Lock forever"; }
    });
    confirmBox.replaceChildren(el("div", { text: "Locking is permanent. The name, the art and the renderer can never change again, and this panel goes away." }), yes);
  });
  card.replaceChildren(
    el("h3", { text: "Edit collection" }),
    el("p", { class: "small muted", text: "A new name applies to pieces minted from now on. New art applies to pieces bought from now on. Existing pieces never change." }),
    el("label", { class: "field" }, el("span", null, el("span", { text: "Collection name" }), el("span", { class: "dim", text: "max 24" })), name),
    el("div", { class: "field" }, el("span", { class: "label" }, el("span", { text: "Art" })), studio.node), said, save, out,
    el("div", { style: "margin-top:14px;padding-top:14px;border-top:1px solid var(--line)" }, lock, confirmBox));
}

function initCollectible() {
  if (!isCollectible()) return;
  const all = $("colAll");
  all.hidden = false;
  all.replaceChildren(el("div", { class: "card-head" }, el("h3", { text: "Collection" })), el("p", { class: "small muted", text: "Reading the pieces" }));
  const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); C.allLoaded = true; loadAll(); } }, { rootMargin: "200px" });
  io.observe(all);
  renderMine();
  renderEdit();
}

// ---- chart and trades ------------------------------------------------------------------------------

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
/// A decimal number as text, times 10^places (places below zero divide), moved as text so no
/// float error creeps in: shiftDecimal("300.05", -9) is "0.00000030005".
function shiftDecimal(s, places) {
  const neg = s.startsWith("-"); if (neg) s = s.slice(1);
  const [i, f = ""] = s.split(".");
  let digits = i + f, point = i.length + places;
  if (point <= 0) { digits = "0".repeat(1 - point) + digits; point = 1; }
  if (point > digits.length) digits += "0".repeat(point - digits.length);
  let out = digits.slice(0, point).replace(/^0+(?=\d)/, "") + (point < digits.length ? "." + digits.slice(point) : "");
  if (out.includes(".")) out = out.replace(/\.?0+$/, "");
  return (neg && out !== "0" ? "-" : "") + out;
}
/// The price axis and its labels: the series holds price * S.chartScale (a power of ten), so a
/// label is the scaled value with the digits it has (at most the four decimals of minMove), moved
/// back. Two neighbouring ticks never read the same, as they did with three significant digits.
function axisPrice(v) {
  if (!isFinite(v) || v <= 0) return "0";
  const e = Math.round(Math.log10(S.chartScale || 1));
  return shiftDecimal(v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""), -e);
}
function initChart() {
  const LW = window.LightweightCharts;
  const host = $("chart");
  if (!LW) { $("chartEmpty").hidden = false; $("chartEmpty").textContent = "The chart library did not load."; return; }
  const line = cssVar("--line"), text = cssVar("--muted");
  S.chart = LW.createChart(host, {
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: text, fontFamily: cssVar("--font-mono") || "monospace", fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: line }, horzLines: { color: line } },
    rightPriceScale: { borderColor: line },
    timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    handleScale: { axisPressedMouseMove: true }, handleScroll: true,
  });
  const up = cssVar("--buy"), down = cssVar("--sell");
  // prices are around 1e-9 SOL, far below what the axis can format, so the series holds
  // price * S.chartScale and the formatter divides it back for the labels
  S.chartScale = 1;
  S.series = S.chart.addSeries(LW.CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down,
    priceFormat: { type: "custom", minMove: 0.0001, formatter: axisPrice } });
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const l = cssVar("--line"), t = cssVar("--muted");
    S.chart.applyOptions({ layout: { textColor: t }, grid: { vertLines: { color: l }, horzLines: { color: l } }, rightPriceScale: { borderColor: l }, timeScale: { borderColor: l } });
    S.series.applyOptions({ upColor: cssVar("--buy"), downColor: cssVar("--sell"), wickUpColor: cssVar("--buy"), wickDownColor: cssVar("--sell") });
  });
}
function drawChart() {
  if (!S.series) return;
  // the Swapped event carries the real reserves: on the curve the SDK adds the virtual SOL up to graduation
  const candles = H.candlesFromSwaps(S.swaps, S.baseDec, S.quoteDec, S.bucket, curveCandles());
  // a review tool compares the candles of two pages (web/review/flow-feed.mjs): window.__reviewChart = true
  if (window.__reviewChart) window.__chartData = candles;
  const empty = $("chartEmpty");
  if (!candles.length) { empty.hidden = false; empty.textContent = "No trades in the recent history to chart."; S.series.setData([]); return; }
  empty.hidden = true;
  const p = candles[candles.length - 1].close || price();
  // bring the latest price into the 1 to 1000 range for the axis
  S.chartScale = p > 0 ? 10 ** (2 - Math.floor(Math.log10(p))) : 1;
  const k = S.chartScale;
  // the axis prints UTC; shift by the zone offset so it matches the local times in the trades table
  const shift = -new Date().getTimezoneOffset() * 60;
  S.series.setData(candles.map((c) => ({ time: c.time + shift, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k })));
  S.chart.timeScale().fitContent();
}
for (const b of $("bucketSeg").querySelectorAll("button")) b.addEventListener("click", () => {
  S.bucket = Number(b.dataset.bucket);
  for (const x of $("bucketSeg").querySelectorAll("button")) x.setAttribute("aria-pressed", x === b ? "true" : "false");
  drawChart();
});

function renderTrades() {
  const tbody = $("trades").querySelector("tbody");
  const empty = $("tradesEmpty");
  if (!S.swaps.length) { tbody.replaceChildren(); $("trades").hidden = true; empty.hidden = false; empty.textContent = "No trades in the recent history."; $("tradesNote").textContent = ""; return; }
  $("trades").hidden = false; empty.hidden = true;
  $("tradesNote").textContent = S.swaps.length + " shown";
  tbody.replaceChildren(...S.swaps.slice(0, 60).map((s) => {
    const buy = s.direction === DIRECTION.BUY;
    const quoteAmt = buy ? s.amountIn : s.amountOut;
    const baseAmt = buy ? s.amountOut : s.amountIn;
    const pr = Number(baseAmt) > 0 ? (toNumber(quoteAmt, S.quoteDec) / toNumber(baseAmt, S.baseDec)) : 0;
    return el("tr", null,
      el("td", { text: s.blockTime ? fmtTime(s.blockTime) : "" }),
      el("td", { class: buy ? "buy" : "sell", text: s.byHook ? (isRules() ? "burn" : "buyback") : buy ? "buy" : "sell" }),
      el("td", { text: fmtUnits(quoteAmt, S.quoteDec, 4) }),
      el("td", { text: fmtCompact(toNumber(baseAmt, S.baseDec)) }),
      el("td", { text: fmtPrice(pr) }),
      el("td", null, el("a", { href: explorer("account", s.user.toBase58()), target: "_blank", rel: "noopener", text: short(s.user.toBase58()), title: s.user.toBase58() })),
      el("td", null, el("a", { href: explorer("tx", s.signature), target: "_blank", rel: "noopener", text: "view" })));
  }));
}

function renderStats() {
  const p = S.pool;
  const createdAgo = S.nowSlot ? timeAgo(slotAge(p.createdSlot, S.nowSlot)) : "";
  $("stats").replaceChildren(
    stat("Reserve " + S.symbol, fmtCompact(toNumber(p.reserveBase, S.baseDec))),
    stat("Reserve " + S.quoteSym, fmtUnits(p.reserveQuote, S.quoteDec, 4)),
    stat("Pool fee", fmtPct(p.lpFeeBps)),
    stat("Swaps", fmtInt(p.swapCount)),
    stat("Total volume", fmtUnits(p.volumeQuoteTotal, S.quoteDec, 2) + " " + S.quoteSym),
    stat("Hook fees total", fmtUnits(p.hookFeesQuoteTotal, S.quoteDec, 4) + " " + S.quoteSym),
    stat("Created", "slot " + fmtInt(p.createdSlot) + (createdAgo ? ", " + createdAgo : "")),
    stat("Protocol fee", fmtPct(S.plat.protocolFeeBps)),
    stat("Creator", short(p.creator.toBase58(), 5)),
    // a pool on the curve: the virtual SOL in its price (the target is in the raised line above), or that it graduated
    ...(isCurveOpen() ? [stat("Virtual " + S.quoteSym, fmtUnits(p.virtualQuote, S.quoteDec, 2))]
      : isCurvePool() ? [stat("Curve", S.curve.graduated ? "graduated in slot " + fmtInt(S.curve.graduated.slot) : "graduated")] : []),
  );
}
function stat(l, v) { return el("div", { class: "stat" }, el("div", { class: "l", text: l }), el("div", { class: "v", text: v })); }

// S.lp: the pool's LP supply and the part of it in the pool's lock account, from the pool's read
// (applyView). A launch puts all the liquidity it makes there. The pool program has no
// instruction that moves it.
function renderLiq() {
  const lp = S.lp;
  let text = "Anyone can add liquidity to this pool and take their own out again.";
  if (lp && lp.supply > 0n) {
    const rest = " Wallets that added liquidity hold the rest and can take it out.";
    if (lp.locked >= lp.supply) text = "All of this pool's liquidity is locked. Its " + fmtLp(lp.locked) + " LP sit in the pool's lock account, and the pool program has no instruction that moves them.";
    else if (lp.locked * 10_000n >= lp.supply) text = fmtShare(lp.locked, lp.supply) + " of this pool's liquidity is locked. " + fmtLp(lp.locked) + " LP of " + fmtLp(lp.supply) + " sit in the pool's lock account, and the pool program has no instruction that moves them." + rest;
    else text = "Almost none of this pool's liquidity is locked. " + fmtLp(lp.locked) + " LP of " + fmtLp(lp.supply) + " sit in the pool's lock account. Whoever holds the rest can take it out.";
  }
  // on the curve the pool takes and gives no liquidity until it graduates
  if (isCurveOpen()) text = "This pool is on the curve. Liquidity opens at graduation, when it has raised " + solText(S.pool.graduationTarget) + ". Until then it only trades." + (lp && lp.supply > 0n && lp.locked >= lp.supply ? " All of its LP sits in the pool's lock account, and nobody holds any." : "");
  // a sniper fee or a launch guard: the hook refuses new liquidity until its window is over
  const w = S.nowSlot && !isCurveOpen() ? liquidityWindow(S.info, isRules() && RU.st ? ruSlot() : slotNow()) : null;
  const kids = [el("h3", { text: "Liquidity" }), el("p", { class: "small muted", id: "liqText", text })];
  if (w) kids.push(el("p", { class: "small", id: "liqWindow" }, "This pool takes no new liquidity while its " + w.what + " runs. Adding opens at slot " + fmtInt(w.openSlot) + ", ", el("span", { id: "liqOpens", text: "in about " + fmtSpan(Math.max(1, Math.ceil(w.seconds))) }), ". Taking liquidity out always works."));
  kids.push(el("a", { class: "btn btn-sm", href: "pool.html?pool=" + S.pool.address.toBase58(), text: "Add or remove liquidity" }));
  $("liqCard").replaceChildren(...kids);
}

/// The slot right now, worked out from the page's last read of the pool and the clock since.
function slotNow() { return S.nowSlot ? BigInt(S.nowSlot) + BigInt(Math.max(0, Math.floor((Date.now() - S.slotAt) / SLOT_MS))) : 0n; }

/// Take in a read of the pool (client.poolView): the pool, the coin's mint (the supply falls at
/// graduation and with every burn), the LP, the hook's config (an owner can change a tax, a
/// buyback moves its counters, a collection its numbers), a rules coin's state, the wallet's
/// balances, and the slot of the read as the page's clock.
function applyView(v) {
  S.view = v;
  S.pool = v.pool;
  if (v.mint) S.mint = v.mint;
  if (v.lp) S.lp = v.lp;
  S.nowSlot = Number(v.slot); S.slotAt = Date.now();
  // the shared clock of common.js: a getSlot within five seconds of this read is not needed
  ctx.slot = S.nowSlot; ctx.slotAt = S.slotAt;
  const i = S.info, h = v.hook;
  if (i && h) {
    if (h.tax) i.tax = h.tax;
    if (h.guard) i.guard = h.guard;
    if (h.buyback) i.buyback = h.buyback;
    if (h.collectible) i.collectible = h.collectible;
  }
  if (i && i.template === "rules") applyRules(v.rules);
  if (v.wallet) setBalances(v.wallet);
}

/// Read the pool, its hook's config, its LP and the wallet again, in one read, and redraw what
/// shows them. Runs after every action and on the page's timer, so no card needs a reload to be
/// true. When the pool traded since the last read, the trades are read too (`noHistory`: the
/// caller reads them itself right after).
async function refreshPool(noHistory) {
  try {
    const was = S.pool;
    const k = Wallet.current().publicKey;
    const v = await ctx.client.poolView(S.pool, { wallet: k, payer: k || PublicKey.default, platform: S.plat, rulesConfig: RU.st ? RU.st.config : (S.info && S.info.rules) || null });
    if (!v) return;
    const colWas = collectionKey();
    applyView(v);
    if (!k) S.balances = { sol: 0n, base: 0n, quote: 0n, wsol: null };
    drawFigures();
    renderStats();
    renderLiq();
    if (S.pool.hasHook) await renderHook();
    if (isRules()) { renderRulesCard(); drawHeadTags(); }
    renderBalance(); renderCost();
    // someone else traded: what is typed in the form is quoted again against the pool as it is now.
    // Inside a sniper or guard window the fee fell since the last quote, so it is quoted again too.
    if (amountIn() && (S.pool.reserveBase !== was.reserveBase || S.pool.reserveQuote !== was.reserveQuote || S.pool.curveState !== was.curveState || feeWindow(S.lastQuote) || (S.local && !S.local.qt))) quoteNow();
    else drawQuote();
    const traded = S.pool.swapCount !== was.swapCount || S.pool.curveState !== was.curveState;
    if (traded && !noHistory) refreshSwaps();
    // a collectible coin: the wallet's pieces follow the pool's trades, its coins, and the collection's
    // counts (a settle or a burn by anyone changes them), all in the read above
    if (isCollectible() && !C.busy && !C.flow && (traded || (v.wallet && v.wallet.base !== C.lastBase) || collectionKey() !== colWas)) { C.lastBase = v.wallet ? v.wallet.base : null; renderMine(); }
  } catch (_) {}
}
/// What a settle, a mint or a burn of any wallet changes in the collection's config.
function collectionKey() { const c = S.info && S.info.collectible; return c ? [c.live, c.minted, c.reservedPending, c.artVersion].join() : ""; }

// ---- the trades -------------------------------------------------------------------------------------
// S.hist.events: the pool's events newest first, at most 300, from the watcher's feed and from
// the chain together. An event is known by its transaction and its place in it, so the same
// trade from both is one row.

const MAX_EVENTS = 300, SHOWN_KINDS = new Set(["Swapped", "CurveOpened", "Graduated"]);
const evKey = (e, n) => e.signature + "#" + e.kind + "#" + n;
/// New events first, then the ones known before; one row per event.
function mergeEvents(fresh, known) {
  const seen = new Set(), out = [];
  for (const list of [fresh, known]) {
    const count = new Map();
    for (const e of list) {
      const c = (count.get(e.signature + e.kind) || 0) + 1; count.set(e.signature + e.kind, c);
      const key = evKey(e, c);
      if (seen.has(key)) continue;
      seen.add(key); out.push(e);
    }
  }
  // newest first by slot; events of one slot keep the order they came in
  return out.map((e, i) => [e, i]).sort((a, b) => (a[0].slot > b[0].slot ? -1 : a[0].slot < b[0].slot ? 1 : a[1] - b[1])).map((x) => x[0]).slice(0, MAX_EVENTS);
}
/// The watcher's feed of this pool: { events, opened, graduated, newest } or null when it has none.
async function readFeed() {
  if (!WATCHED || Date.now() < S.hist.feedDown) return null;
  const j = await fetchJson(ctx.watcherUrl + "/trades/" + S.pool.address.toBase58() + ".json", 4000);
  if (!j || !Array.isArray(j.events)) { S.hist.feedDown = Date.now() + 60_000; return null; } // tried again in a minute; the chain stands in meanwhile
  const revive = (x) => { try { return x ? H.eventFromJson(x) : null; } catch (_) { return null; } };
  const events = j.events.map(revive).filter((e) => e && e.pool && e.pool.equals(S.pool.address));
  const c = j.curve || {};
  return { events, opened: revive(c.opened), graduated: revive(c.graduated), newest: events.length ? events[0].signature : "", slot: j.slot };
}
/// The curve's two events of a graduated pool, kept in this browser once found: they never change.
const curveKey = () => "Programmable.curve." + ctx.cluster + "." + S.pool.address.toBase58();
function curveCached() { try { const j = JSON.parse(localStorage.getItem(curveKey()) || "null"); return j ? { opened: j.opened ? H.eventFromJson(j.opened) : null, graduated: j.graduated ? H.eventFromJson(j.graduated) : null } : null; } catch (_) { return null; } }
function curveKeep() { try { if (S.curve.opened && S.curve.graduated) localStorage.setItem(curveKey(), JSON.stringify({ opened: H.eventToJson(S.curve.opened), graduated: H.eventToJson(S.curve.graduated) })); } catch (_) {} }

/// Read the trades again and redraw the table, the chart and the curve. From the watcher's feed
/// when there is one (no RPC); from the chain otherwise, and right after the page's own trade
/// (`mine`), since the feed follows a few seconds behind: there only the transactions newer than
/// the newest one seen are read. Calls that come while one runs are folded into one more.
async function refreshSwaps(mine) {
  if (S.hist.busy) { S.hist.again = S.hist.again || (mine ? "mine" : "yes"); return S.hist.busy; }
  const run = (async () => {
    const addr = S.pool.address;
    try {
      const feed = mine ? null : await readFeed();
      if (feed) {
        // the chain's events newer than the feed's stay until the feed has them
        S.hist.events = mergeEvents(feed.events, S.hist.events.filter((e) => e.slot > BigInt(feed.slot || 0)));
        S.hist.feedNewest = feed.newest;
        // the newest transaction known, from either source: a read of the chain starts after it
        const top = feed.events[0];
        if (top && (S.hist.newestSlot === null || top.slot > S.hist.newestSlot)) { S.hist.newest = top.signature; S.hist.newestSlot = top.slot; }
        if (feed.opened) S.curve.opened = S.curve.opened || feed.opened;
        if (feed.graduated) S.curve.graduated = S.curve.graduated || feed.graduated;
      } else {
        const r = await ctx.client.recentEventsSince(addr, S.hist.newest, 50);
        // the three kinds the page shows, as the watcher keeps them: the trades and the curve's two events
        S.hist.events = mergeEvents(r.events.filter((e) => SHOWN_KINDS.has(e.kind) && e.pool.equals(addr)), S.hist.events);
        if (r.newestSlot !== null) { S.hist.newest = r.newest; S.hist.newestSlot = r.newestSlot; }
      }
      S.swaps = S.hist.events.filter((e) => e.kind === "Swapped" && e.pool.equals(addr));
      if (isCurvePool()) {
        const opened = S.hist.events.find((e) => e.kind === "CurveOpened"), graduated = S.hist.events.find((e) => e.kind === "Graduated");
        if (opened) S.curve.opened = opened;
        if (graduated) S.curve.graduated = graduated;
        // a graduated pool whose events lie further back: kept in this browser, or one search
        // from the pool's first transaction forward, once
        if (!isCurveOpen() && (!S.curve.graduated || !S.curve.opened) && !S.curve.searched) {
          S.curve.searched = true;
          const ev = curveCached() || await ctx.client.curveEventsFromStart(addr).catch(() => null);
          if (ev) { S.curve.opened = S.curve.opened || ev.opened; S.curve.graduated = S.curve.graduated || ev.graduated; curveKeep(); }
        }
        drawCurve(); renderStats();
      }
    } catch (_) { S.swaps = S.swaps || []; }
    renderTrades(); drawChart();
  })();
  S.hist.busy = run;
  try { await run; } finally { S.hist.busy = null; }
  if (S.hist.again) { const m = S.hist.again === "mine"; S.hist.again = false; await refreshSwaps(m); }
}

// ---- go --------------------------------------------------------------------------------------------

renderTradePanel();
renderLiq();
initCollectible();
initChart();
renderStats();
// a rules coin: its rules and running numbers came with the pool's first read (applyView)
// a hook card that fails to draw (a hook's own data the page cannot read) must not stop the rest of the page
await Promise.all([renderHook().catch((e) => console.error("hook card:", e)), refreshSwaps()]);
drawBalances();
renderLiq();
if (isRules()) {
  renderRulesCard(); drawHeadTags(); renderLiq();
  // what a wallet's first stake costs: the rent of its stake record (113 bytes, RULES.md), which never comes
  // back; and on a strict coin the rent of a holder record (129 bytes). Both at the chain's rent, read once
  // (two reads): mainnet's 5,080 lamports a byte is not the local validator's 6,960.
  loadRent().then((r) => { RU.rent = r(H.STAKE_RECORD_SIZE); RU.holderRent = r(H.HOLDER_RECORD_SIZE); renderRulesCard(); }).catch(() => {});
}
const onWallet = async () => {
  // the new wallet's balances, stake and holder record come with the pool, in one read
  await refreshPool(); quoteNow(); renderHook(); renderRulesCard(true); $("colEdit").dataset.built = ""; refreshCollectible();
};
Wallet.onChange(onWallet);
// After a reload the browser wallet reconnects on its own, often while the page is still loading and
// before the line above has run: that reconnect was missed and the balances stayed empty until the
// next refresh. A wallet that is connected by now is read at once.
if (Wallet.current().publicKey) onWallet();

// ---- the page's timers. None of them reads anything while the tab is hidden. ----------------------
setInterval(tick, 1000);
let lastPoll = Date.now();
// the chain: every 10 seconds without a watcher, once a minute with one
setInterval(() => { if (document.hidden || Date.now() - lastPoll < POLL_MS - 500) return; lastPoll = Date.now(); refreshPool(); }, 1000);
// the watcher's feed (no RPC): a new trade in it reads the pool again at once
if (WATCHED) setInterval(async () => {
  if (document.hidden || S.hist.busy) return;
  const before = S.hist.feedNewest;
  await refreshSwaps();
  if (S.hist.feedNewest && S.hist.feedNewest !== before) { lastPoll = Date.now(); refreshPool(true); }
}, FEED_MS);
// a collectible coin: someone else may have settled this wallet; its pieces are read again now and then
setInterval(() => { if (!document.hidden && isCollectible() && !C.busy && !C.flow && Wallet.current().publicKey) renderMine(); }, 60_000);
// coming back to a hidden tab reads everything at once instead of waiting for the next tick
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  lastPoll = Date.now();
  refreshPool();
  if (WATCHED) refreshSwaps();
  if (isCollectible() && !C.busy && !C.flow) renderMine();
});
}
page();
