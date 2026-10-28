// Liquidity page: the wallet's LP position, add by SOL or by LP amount, remove by percent, and
// what part of the pool is locked. Every figure of the "Locked forever" card is read from the
// chain: the balance of the pool's lock account against the LP supply.
import { boot, ctx, H, Wallet, $, el, platform, marketPools, fetchJson, coinImage, setImage, monogram, fmtUnits, fmtPct, parseUnits, applyBps, toast, sendIxs, requireWallet, explorer, short, addrChip, extLinks, SOL_DECIMALS, SLOT_MS, mapLimit, isPegged, fmtLp, fmtShare, wrappedSol, unwrapSol, fmtInt, fmtSpan, liquidityWindow, setTitle, curveSentence, rpcFailText, notAccountOf, fmtAmount } from "./common.js";
// the warning on a pool whose outside hook is not on the approved list
import { TAKEN_OFF } from "./workshop-lib.js";

await boot("pool.html");
const { PublicKey } = H;
const q = new URLSearchParams(location.search);
const headEl = $("head");

async function pickPool() {
  try {
    // the watcher's market has every pool and its coin's name: no read of the chain at all
    const market = await marketPools().catch(() => null);
    const rows = market ? market.rows : (await ctx.client.allPools()).map((pool) => ({ pool, md: undefined }));
    rows.sort((a, b) => (b.pool.createdSlot > a.pool.createdSlot ? 1 : -1));
    const pools = rows.map((r) => r.pool);
    if (!pools.length) { headEl.replaceChildren(el("div", { class: "card" }, el("p", { text: "No pools yet. Launch the first coin and its pool comes with it." }), el("a", { class: "btn btn-primary btn-sm", href: "launch.html", text: "Launch a coin" }))); return; }
    const mds = await mapLimit(rows, 6, (r) => (r.md !== undefined ? r.md : ctx.client.metadata(r.pool.baseMint)));
    headEl.replaceChildren(
      el("div", { class: "page-top" }, el("h1", { text: "Liquidity" }), el("p", { text: "Pick a pool to add or remove liquidity." })),
      el("div", { class: "card pool-pick" }, ...pools.map((p, i) => {
        const md = mds[i];
        const sym = (md && md.symbol) || "";
        const img = el("img", { class: "avatar", alt: "", width: 36, height: 36 }); img.src = monogram(sym);
        coinImage(md ? md.uri : "", sym).then((s) => setImage(img, s, sym));
        return el("a", { href: "pool.html?pool=" + p.address.toBase58() }, img, el("span", null, el("b", { text: (md && md.name) || "Unnamed coin" }), el("span", { class: "sym", text: sym })), el("span", { class: "dim small mono", style: "margin-left:auto", text: fmtAmount(p.reserveQuote, SOL_DECIMALS, 2) + " SOL" + (H.isOnCurve(p) ? " raised" : "") }));
      })));
  } catch (e) { headEl.replaceChildren(el("div", { class: "card", text: rpcFailText(e) })); }
}

let poolKey = null;
try { poolKey = new PublicKey(q.get("pool") || ""); } catch (_) {}
if (!poolKey) await pickPool(); else await page();

async function page() {

// S.lock is what the pool's lock account holds, S.lp the LP mint (its supply). S.wsol is what the
// wallet's wrapped SOL account holds, null when the wallet has none: a wallet that keeps one
// receives the SOL of a withdrawal there, and the change of a deposit stays there.
// S.col is set for a pegged coin only: a deposit is a transfer of the coin to the pool, so the
// pieces the wallet's coins no longer back burn inside it. S.ticket, S.pieces and S.backing say which.
// S.info is the pool's hook as the SDK reads it. A rules coin and a launch guard refuse new liquidity
// while their sniper or guard window runs: S.slot, read at S.slotAt, tells whether it still does.
const S = { pool: null, plat: null, md: null, mint: null, lp: null, lock: null, launch: null, baseDec: 6, quoteDec: SOL_DECIMALS, quoteSym: "SOL", quoteIsSol: true, symbol: "", name: "", lpBal: 0n, baseBal: 0n, solBal: 0n, wsol: null, mode: "sol", slipBps: 100, col: null, ticket: null, pieces: [], backing: 0n, info: null, slot: 0n, slotAt: 0, closed: false };

// The pool, its coin, its LP, its hook and the wallet's balances come in ONE read (client.poolView),
// two on the first load. Its slot is the page's clock. Nothing is read while the tab is hidden.
try {
  const v = await ctx.client.poolView(poolKey, { platform: ctx.platform || true, metadata: true, launch: true, rules: false, wallet: Wallet.current().publicKey });
  if (!v) { headEl.replaceChildren(el("div", { class: "card", text: "No pool at " + poolKey.toBase58() + " on " + ctx.cluster + "." })); return; }
  const pool = v.pool;
  ctx.platform = v.platform;
  S.plat = v.platform; S.md = v.metadata; S.mint = v.mint; S.launch = v.launch; S.info = v.hook;
  applyView(v);
  S.baseDec = S.mint ? S.mint.decimals : 6;
  S.quoteIsSol = pool.quoteMint.equals(H.NATIVE_MINT);
  if (!S.quoteIsSol) { S.quoteDec = v.quoteMint ? v.quoteMint.decimals : 9; const qmd = await ctx.client.metadata(pool.quoteMint); S.quoteSym = (qmd && qmd.symbol) || short(pool.quoteMint.toBase58()); }
  S.symbol = (S.md && S.md.symbol) || "COIN"; S.name = (S.md && S.md.name) || "Unnamed coin";
  // a pegged coin: its collection config came with the hook's config
  if (isPegged(pool)) S.col = (v.hook && v.hook.collectible) || null;
  setTitle(S.symbol + " liquidity");
} catch (e) { headEl.replaceChildren(el("div", { class: "card", text: notAccountOf(e, "Pool") ? "No pool at " + poolKey.toBase58() + " on " + ctx.cluster + "." : rpcFailText(e) })); return; }

/// Take in a read of the pool (client.poolView): the pool, the LP supply and the lock account,
/// the slot, and the connected wallet's balances.
function applyView(v) {
  S.pool = v.pool;
  if (v.mint) S.mint = v.mint;
  if (v.lp) { S.lp = { supply: v.lp.supply }; S.lock = v.lp.locked; }
  S.slot = v.slot; S.slotAt = Date.now();
  const w = v.wallet, k = Wallet.current().publicKey;
  if (w && k && w.owner.equals(k)) { S.lpBal = w.lp; S.baseBal = w.base; S.solBal = S.quoteIsSol ? w.sol : w.quote; S.wsol = w.wsol; }
}

const img = el("img", { class: "avatar lg", alt: "", width: 56, height: 56 }); img.src = monogram(S.symbol);
coinImage(S.md ? S.md.uri : "", S.symbol).then((s) => setImage(img, s, S.symbol));
headEl.replaceChildren(
  el("div", { class: "pool-head" }, img, el("h1", null, S.name, el("span", { class: "sym", text: S.symbol })), el("a", { class: "btn btn-sm", style: "margin-left:auto", href: "coin.html?pool=" + S.pool.address.toBase58(), text: "Trade " + S.symbol })),
  el("div", { class: "addr-row" }, addrChip("Pool", S.pool.address.toBase58()), extLinks(S.pool.address.toBase58()), addrChip("LP mint", S.pool.lpMint.toBase58())),
  el("div", { class: "curve-line pool-curve", id: "curveLine", hidden: true }));
// an outside hook that is not on the approved list while the platform's rule is on: the same
// warning as on the coin page, from the platform account this page read
{
  const p = S.pool, pl = S.plat;
  const delisted = !!pl && pl.hookApprovalRequired === true && !pl.approvedListCorrupt && p.hasHook && p.hookKind === H.HOOK_KIND.FROZEN
    && !H.isTemplateProgram(p.hookProgram) && !pl.approvedHooks.some((k) => k.equals(p.hookProgram));
  if (delisted) headEl.append(el("p", { class: "note warn", id: "delistedNote", style: "margin: 4px 0 16px" }, TAKEN_OFF + " ", el("a", { class: "link", href: "workshop-hook.html?id=" + p.hookProgram.toBase58(), text: "The hook's page" })));
}
$("layout").hidden = false;

// ---- a pool on the curve ----------------------------------------------------------------------------
// While it is open it refuses every deposit and every withdrawal (CurveOpen): both forms are off and
// say why, and the head says what the pool has raised of its target. After graduation it is an
// ordinary pool and both forms work.
const onCurve = () => H.isOnCurve(S.pool);
function renderCurve() {
  const box = $("curveLine");
  if (S.pool.curveState === H.CURVE_NONE || !S.mint) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  if (!onCurve()) {
    box.replaceChildren(el("div", { class: "curve-done" }, el("span", { class: "tag", id: "curveMark", text: "Graduated" }), el("span", { class: "small muted", text: "This pool left the curve. Liquidity is open." })));
    return;
  }
  const p = H.curveProgress(S.pool, S.mint.supply);
  const pct = p.raisedBps / 100;
  box.replaceChildren(
    el("div", { class: "curve-top" },
      el("span", { class: "curve-raised", id: "curveRaised" }, "Raised ", el("b", { text: fmtAmount(p.raised, S.quoteDec, 2) }), " of " + fmtUnits(p.target, S.quoteDec, 2) + " " + S.quoteSym),
      el("span", { class: "curve-sold", text: fmtPct(p.soldBps, 1) + " of the supply sold" })),
    el("div", { class: "curve-bar", role: "progressbar", "aria-label": "Raised toward graduation", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, el("span", { style: "width:" + Math.min(100, pct) + "%" })));
}
/// The two forms on an open curve pool: off, with the sentence that says why.
function renderShut() {
  const shut = onCurve();
  $("addCurve").hidden = !shut; $("removeCurve").hidden = !shut;
  $("addAmount").disabled = shut; $("removePct").disabled = shut;
  for (const b of document.querySelectorAll("#addMode button, #removeQuick button")) b.disabled = shut;
  if ($("addBtn").textContent === "Add liquidity") $("addBtn").disabled = shut || S.closed;
  if ($("removeBtn").textContent === "Remove liquidity") $("removeBtn").disabled = shut;
}
for (const s of document.querySelectorAll("#addMode button")) s.addEventListener("click", () => setMode(s.dataset.mode));
$("addAmount").addEventListener("input", () => { $("addResult").replaceChildren(); renderAdd(); });
$("removePct").addEventListener("input", renderRemove);
$("removeQuick").replaceChildren(...[25, 50, 100].map((p) => el("button", { type: "button", text: p + "%", onclick: () => { $("removePct").value = String(p); renderRemove(); } })));
$("addBtn").addEventListener("click", add);
$("removeBtn").addEventListener("click", remove);

const supply = () => S.lp ? S.lp.supply : 0n;
const connected = () => !!Wallet.current().publicKey;
/// An amount cut to `frac` decimals, or with all of them when the short form would read 0 for an amount that is not zero.
const amt = (v, dec, frac) => { const s = fmtUnits(v, dec, frac); return s === "0" && BigInt(v) > 0n ? fmtUnits(v, dec, dec) : s; };

function setMode(m) {
  S.mode = m;
  for (const s of document.querySelectorAll("#addMode button")) s.setAttribute("aria-pressed", s.dataset.mode === m ? "true" : "false");
  $("addLabel").textContent = m === "sol" ? S.quoteSym + " to add" : "LP to receive";
  $("addSuffix").textContent = m === "sol" ? S.quoteSym : "LP";
  $("addAmount").value = "";
  $("addResult").replaceChildren();
  renderAdd();
}

/// What the typed deposit mints and takes. null when nothing is typed. { tooSmall } when the
/// amount is below one raw unit of LP, with the smallest deposit the pool takes.
function addPlan() {
  const sup = supply();
  if (sup === 0n || onCurve()) return null;
  const v = parseUnits($("addAmount").value, S.mode === "sol" ? S.quoteDec : H.LP_DECIMALS);
  if (!v || v <= 0n) return null;
  const lp = S.mode === "sol" ? H.mulDivFloor(v, sup, S.pool.reserveQuote) : v;
  if (lp <= 0n) return { tooSmall: true, leastBase: H.mulDivCeil(1n, S.pool.reserveBase, sup), leastQuote: H.mulDivCeil(1n, S.pool.reserveQuote, sup) };
  const base = H.mulDivCeil(lp, S.pool.reserveBase, sup);
  const quote = H.mulDivCeil(lp, S.pool.reserveQuote, sup);
  const maxBase = (base * BigInt(10000 + S.slipBps)) / 10000n + 1n;
  const maxQuote = (quote * BigInt(10000 + S.slipBps)) / 10000n + 1n;
  return { lp, base, quote, maxBase, maxQuote };
}
const tooSmallText = (p) => "That is too little to mint any LP. The smallest deposit here is " + fmtUnits(p.leastQuote, S.quoteDec, S.quoteDec) + " " + S.quoteSym + " with " + fmtUnits(p.leastBase, S.baseDec, S.baseDec) + " " + S.symbol + ".";
/// Why the wallet cannot make this deposit, or "".
function shortOf(p) {
  if (!connected()) return "";
  const coin = p.base > S.baseBal, quote = p.quote > S.solBal;
  if (coin && quote) return "Your wallet holds less " + S.symbol + " and less " + S.quoteSym + " than this deposit needs.";
  if (coin) return "Your wallet holds less " + S.symbol + " than this deposit needs.";
  if (quote) return "Your wallet holds less " + S.quoteSym + " than this deposit needs.";
  return "";
}
/// The window in which this pool's hook refuses new liquidity, when it runs right now. null otherwise.
function addWindow() {
  if (!S.info || !S.slotAt) return null;
  return liquidityWindow(S.info, S.slot + BigInt(Math.max(0, Math.floor((Date.now() - S.slotAt) / SLOT_MS))));
}
/// Say when adding opens, and keep the button off until then. Removing is never refused by a template.
function renderWindow() {
  const w = addWindow(), box = $("addWindow"), btn = $("addBtn");
  S.closed = !!w;
  if (btn.textContent === "Add liquidity") btn.disabled = S.closed || onCurve();
  if (!w) { if (!box.hidden) { box.hidden = true; box.replaceChildren(); } return; }
  const left = "in about " + fmtSpan(Math.max(1, Math.ceil(w.seconds)));
  const span = $("addOpens");
  if (span) { if (span.textContent !== left) span.textContent = left; return; }
  box.replaceChildren("This pool takes no new liquidity while its " + w.what + " runs. Adding opens at slot " + fmtInt(w.openSlot) + ", ", el("span", { id: "addOpens", text: left }), ". Removing liquidity is always possible.");
  box.hidden = false;
}
function renderAdd() {
  const p = addPlan();
  const kv = $("addKv");
  const cost = $("addCost");
  const msg = $("addMsg");
  cost.replaceChildren(); msg.textContent = ""; msg.className = "help";
  if (!p) { kv.replaceChildren(); return; }
  if (p.tooSmall) { kv.replaceChildren(); msg.textContent = tooSmallText(p); msg.className = "error-text"; return; }
  if (S.col && S.ticket && connected() && p.base <= S.backing) {
    const peg = H.collectible.pegStatus(S.ticket, S.backing - p.base, S.col.unit);
    const names = new Map(S.pieces.map((x) => [x.address.toBase58(), x.name]));
    const list = peg.burn.map((k) => names.get(k.toBase58()) || short(k.toBase58()));
    if (list.length) cost.append(el("div", { text: "This deposit burns " + list.length + (list.length === 1 ? " piece: " : " pieces: ") + list.slice(0, 6).join(", ") + (list.length > 6 ? " and " + (list.length - 6) + " more" : "") + "." }));
    if (peg.dropWaiting) cost.append(el("div", { text: "This deposit drops " + peg.dropWaiting + (peg.dropWaiting === 1 ? " waiting piece." : " waiting pieces.") }));
    if (list.length || peg.dropWaiting) cost.append(el("div", { class: "sub", text: "The coins you add leave your wallet. The pieces they backed do not come back when you remove liquidity." }));
  }
  const w = connected();
  kv.replaceChildren(
    el("dt", { text: "LP you receive" }), el("dd", { text: fmtLp(p.lp) }),
    el("dt", { text: S.symbol + " needed" }), el("dd", { class: p.base > S.baseBal && w ? "bad" : "", text: amt(p.base, S.baseDec, 4) }),
    el("dt", { text: S.quoteSym + " needed" }), el("dd", { class: p.quote > S.solBal && w ? "bad" : "", text: amt(p.quote, S.quoteDec, 6) }),
    el("dt", { text: "Your share after" }), el("dd", { text: fmtShare(S.lpBal + p.lp, supply() + p.lp) }),
    el("dt", { text: "Max spent with " + fmtPct(S.slipBps, 1) + " room" }), el("dd", { text: fmtUnits(p.maxBase, S.baseDec, 2) + " " + S.symbol + ", " + fmtUnits(p.maxQuote, S.quoteDec, 4) + " " + S.quoteSym }));
  const short2 = shortOf(p);
  if (short2) { msg.textContent = short2; msg.className = "error-text"; }
  else if (w && S.quoteIsSol && S.wsol !== null) msg.textContent = "Your wallet keeps a wrapped SOL account. The form wraps the most this deposit can cost. What it does not use stays there as wrapped SOL.";
}
function removePlan() {
  const pct = Number($("removePct").value);
  if (!pct || S.lpBal === 0n || supply() === 0n || onCurve()) return null;
  const lp = S.lpBal * BigInt(pct) / 100n;
  if (lp <= 0n) return null;
  const base = H.mulDivFloor(lp, S.pool.reserveBase, supply());
  const quote = H.mulDivFloor(lp, S.pool.reserveQuote, supply());
  return { lp, base, quote, minBase: applyBps(base, S.slipBps), minQuote: applyBps(quote, S.slipBps) };
}
function renderRemove() {
  $("removeOut").textContent = $("removePct").value + "%";
  const p = removePlan();
  const kv = $("removeKv");
  const msg = $("removeMsg");
  msg.textContent = "";
  if (!p) { kv.replaceChildren(); return; }
  kv.replaceChildren(
    el("dt", { text: "LP you give back" }), el("dd", { text: fmtLp(p.lp) }),
    el("dt", { text: S.symbol + " out" }), el("dd", { text: amt(p.base, S.baseDec, 4) }),
    el("dt", { text: S.quoteSym + " out" }), el("dd", { text: amt(p.quote, S.quoteDec, 6) }),
    el("dt", { text: "Minimum with " + fmtPct(S.slipBps, 1) + " room" }), el("dd", { text: fmtUnits(p.minBase, S.baseDec, 2) + " " + S.symbol + ", " + fmtUnits(p.minQuote, S.quoteDec, 4) + " " + S.quoteSym }));
  if (connected() && S.quoteIsSol && S.wsol !== null) msg.textContent = "The SOL arrives as wrapped SOL in your wrapped SOL account. Unwrap, under Your position, turns it into plain SOL.";
}

function renderPosition() {
  const sup = supply();
  const kv = $("position");
  const wrap = $("wrapped");
  if (!connected()) { kv.replaceChildren(el("dt", { text: "Connect a wallet to see your LP." }), el("dd")); wrap.hidden = true; wrap.replaceChildren(); return; }
  const base = sup > 0n ? H.mulDivFloor(S.lpBal, S.pool.reserveBase, sup) : 0n;
  const quote = sup > 0n ? H.mulDivFloor(S.lpBal, S.pool.reserveQuote, sup) : 0n;
  kv.replaceChildren(
    el("dt", { text: "LP balance" }), el("dd", { text: fmtLp(S.lpBal) }),
    el("dt", { text: "Pool share" }), el("dd", { text: fmtShare(S.lpBal, sup) }),
    el("dt", { text: "Worth in " + S.symbol }), el("dd", { text: amt(base, S.baseDec, 2) }),
    el("dt", { text: "Worth in " + S.quoteSym }), el("dd", { text: amt(quote, S.quoteDec, 6) }),
    el("dt", { text: "Wallet " + S.symbol }), el("dd", { text: fmtUnits(S.baseBal, S.baseDec, 2) }),
    el("dt", { text: "Wallet " + S.quoteSym }), el("dd", { text: fmtUnits(S.solBal, S.quoteDec, 4) }));
  // wrapped SOL the wallet holds, with the button that turns it into plain SOL
  if (S.quoteIsSol && S.wsol !== null && S.wsol > 0n) {
    const btn = el("button", { class: "btn btn-sm", type: "button", text: "Unwrap" });
    btn.addEventListener("click", () => unwrapSol(btn, refresh));
    wrap.replaceChildren(
      el("div", { class: "hook-act-v" }, el("span", { text: "Wrapped SOL in your wallet" }), el("b", { class: "mono", text: fmtUnits(S.wsol, SOL_DECIMALS, 6) })),
      el("div", { class: "hook-act-row" }, el("span", { class: "small muted", text: "Unwrap turns it into plain SOL. The account stays open." }), btn));
    wrap.hidden = false;
  } else { wrap.hidden = true; wrap.replaceChildren(); }
}
/// The locked part of the pool, from the chain: what the lock account holds against the LP supply.
function renderLocked() {
  const sup = supply();
  const lock = S.lock === null ? 0n : S.lock;
  const out = sup > lock ? sup - lock : 0n;
  const lockedBase = sup > 0n ? H.mulDivFloor(lock, S.pool.reserveBase, sup) : 0n;
  const lockedQuote = sup > 0n ? H.mulDivFloor(lock, S.pool.reserveQuote, sup) : 0n;
  $("locked").replaceChildren(
    el("dt", { text: "In the lock account" }), el("dd", { text: fmtLp(lock) + " LP" }),
    el("dt", { text: "LP supply" }), el("dd", { text: fmtLp(sup) + " LP" }),
    el("dt", { text: "Held by wallets" }), el("dd", { text: fmtLp(out) + " LP" }),
    el("dt", { text: "Locked share" }), el("dd", { class: "accent", text: fmtShare(lock, sup) }),
    el("dt", { text: "Locked reserves" }), el("dd", { text: fmtUnits(lockedBase, S.baseDec, 0) + " " + S.symbol + ", " + fmtUnits(lockedQuote, S.quoteDec, 4) + " " + S.quoteSym }));
  const how = S.pool.curveState !== H.CURVE_NONE ? "A pool on the curve put all its liquidity into its lock account when it was created. " : S.launch ? "The launch put all the liquidity it made into the pool's lock account. " : "Every pool keeps a small minimum in its lock account. ";
  $("lockedNote").textContent = how + "The pool program has no instruction that moves what is there, so that share of the reserves can never be withdrawn. "
    + (out > 0n ? "The rest belongs to wallets that added liquidity. They can take it out." : "No wallet holds LP of this pool right now.");
}

async function refresh() {
  try {
    const W = Wallet.current();
    // the pool, the LP, the lock account, the slot and the wallet: one read
    const v = await ctx.client.poolView(S.pool, { wallet: W.publicKey, platform: S.plat, rules: false, manifest: false });
    if (v) { const info = S.info; applyView(v); if (info && v.hook) { if (v.hook.guard) info.guard = v.hook.guard; if (v.hook.collectible && S.col) S.col = v.hook.collectible; } }
    if (W.publicKey) {
      if (S.col) {
        const [ticket, pieces, [backing]] = await Promise.all([H.collectible.fetchTicket(ctx.connection, S.pool.address, W.publicKey), H.collectible.fetchOwnedPieces(ctx.connection, S.pool.address, W.publicKey), H.collectible.fetchBacking(ctx.connection, S.col, [W.publicKey])]);
        S.ticket = ticket; S.pieces = pieces; S.backing = backing;
      }
    } else { S.lpBal = 0n; S.baseBal = 0n; S.solBal = 0n; S.wsol = null; S.ticket = null; S.pieces = []; S.backing = 0n; }
  } catch (_) {}
  renderPosition(); renderLocked(); renderWindow(); renderAdd(); renderRemove(); renderCurve(); renderShut();
}

async function add() {
  const btn = $("addBtn"), out = $("addResult");
  out.replaceChildren();
  const p = addPlan();
  if (!p) { $("addAmount").focus(); return; }
  if (p.tooSmall) { out.replaceChildren(el("span", { class: "bad", text: tooSmallText(p) })); $("addAmount").focus(); return; }
  let user; try { user = requireWallet(); } catch (_) { $("walletBtn").click(); return; }
  const lack = shortOf(p);
  if (lack) { out.replaceChildren(el("span", { class: "bad", text: lack })); return; }
  if (addWindow()) { renderWindow(); return; }
  btn.disabled = true; btn.textContent = "Confirm in your wallet";
  try {
    const ixs = await ctx.client.addLiquidityInstructions(user, S.pool, p.lp, p.maxBase, p.maxQuote);
    const sig = await sendIxs(ixs, [], "deposit");
    out.replaceChildren(el("span", { class: "ok", text: "Added. " }), el("a", { class: "link", href: explorer("tx", sig), target: "_blank", rel: "noopener", text: short(sig, 6) }));
    toast("Liquidity added.", "ok");
    $("addAmount").value = "";
    await refresh();
  } catch (e) { out.replaceChildren(el("span", { class: "bad", text: e instanceof H.CurveRefusal ? curveSentence(e) : e.message })); }
  finally { btn.textContent = "Add liquidity"; btn.disabled = false; renderWindow(); renderShut(); }
}
async function remove() {
  const btn = $("removeBtn"), out = $("removeResult");
  out.replaceChildren();
  const p = removePlan();
  if (!p) {
    const why = !connected() ? "Connect a wallet that holds LP of this pool." : S.lpBal === 0n ? "Your wallet holds no LP of this pool." : "Pick a percent of your LP above zero.";
    out.replaceChildren(el("span", { class: "muted", text: why }));
    return;
  }
  let user; try { user = requireWallet(); } catch (_) { $("walletBtn").click(); return; }
  btn.disabled = true; btn.textContent = "Confirm in your wallet";
  try {
    // read right before building, the way the SDK does: a wrapped SOL account that is open now stays open
    const wrapped = S.quoteIsSol && (await wrappedSol(user)) !== null;
    const ixs = await ctx.client.removeLiquidityInstructions(user, S.pool, p.lp, p.minBase, p.minQuote);
    const sig = await sendIxs(ixs, [], "withdrawal");
    out.replaceChildren(el("span", { class: "ok", text: "Removed. " }), el("a", { class: "link", href: explorer("tx", sig), target: "_blank", rel: "noopener", text: short(sig, 6) }));
    if (wrapped) out.append(el("div", { class: "muted", text: "The SOL arrived as wrapped SOL in your wrapped SOL account." }));
    toast("Liquidity removed.", "ok");
    $("removePct").value = "0";
    await refresh();
  } catch (e) { out.replaceChildren(el("span", { class: "bad", text: e instanceof H.CurveRefusal ? curveSentence(e) : e.message })); }
  finally { btn.disabled = false; btn.textContent = "Remove liquidity"; renderShut(); }
}

setMode("sol");
const walletNow = () => { const k = Wallet.current().publicKey; return k ? k.toBase58() : ""; };
const walletAtFirstRead = walletNow();
await refresh();
Wallet.onChange(refresh);
// After a reload the browser wallet reconnects on its own, often during the first read and before
// the line above has run: that reconnect was missed and the balances stayed empty. Read it now.
if (walletNow() !== walletAtFirstRead) refresh();
// the chain every 12 seconds; with a watcher once a minute, and at once when its feed shows a new
// trade of this pool (the feed costs no RPC). Nothing while the tab is hidden.
let lastRead = Date.now(), feedTop = "";
setInterval(() => { if (!document.hidden && Date.now() - lastRead >= (ctx.watcherUrl ? 60_000 : 12_000) - 500) { lastRead = Date.now(); refresh(); } }, 1000);
if (ctx.watcherUrl) setInterval(async () => {
  if (document.hidden) return;
  const j = await fetchJson(ctx.watcherUrl + "/trades/" + S.pool.address.toBase58() + ".json", 4000);
  const top = j && Array.isArray(j.events) && j.events[0] ? j.events[0].signature : "";
  if (top && feedTop && top !== feedTop) { lastRead = Date.now(); refresh(); }
  if (top) feedTop = top;
}, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastRead = Date.now(); refresh(); } });
// while a window runs: the countdown every second, and the button comes on by itself when it ends
setInterval(() => { if (!document.hidden && S.closed) { renderWindow(); if (!S.closed) refresh(); } }, 1000);
}
