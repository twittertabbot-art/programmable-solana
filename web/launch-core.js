// What the three launch pages share: the coin's details and launch settings, the preview, the
// review of what a buy and a sell pay and what the launch costs, and the launch itself (the
// metadata, two transactions, the retry of the second one). Each page hands run() a `path`:
// the part that differs. Module Mode is launch-modules.js, Collectible is
// launch-collectible.js, Custom hook is launch-hook.js.
//
// A page carries four empty elements: #mDetails, #mPreview, #mReview and #mGo. startLaunch()
// fills them, so the fields and their ids are the same on every path.
//
// How the pool starts is the first choice of the launch settings. On the curve (the default)
// the launcher puts no SOL into the pool: the pool prices trades with the platform's virtual
// SOL and graduates once buyers have put in the platform's target. The supply is then fixed.
// Seeded, the launcher puts SOL next to the supply, as before. A path can switch the curve off
// with a reason (blockCurve): the pegged collectible coin does.
import { ctx, H, Wallet, $, el, svg, platform, monogram, fmtSol, fmtPct, fmtUnits, fmtDate, parseUnits, applyBps, toast, sendIxs, sendSigned, signTx, requireWallet, openWallet, explorer, short, curveSentence, plainError } from "./common.js";

const { Keypair, PublicKey, DIRECTION } = H;
export const DECIMALS = 6;
/// The supply of a coin launched on the curve, in whole coins. The program takes any supply as
/// long as the pool holds all of it; the site fixes the number pump.fun uses, so every curve coin
/// starts at the same market cap and its numbers read the same.
export const CURVE_SUPPLY_WHOLE = 1_000_000_000n;
// What a launch costs beyond the seed, the first buy and the platform fee: the rent of the
// accounts its two transactions create, and fees that are the same on every chain. Each type
// was measured as the fall of a dev wallet's balance over one launch on a local validator with
// the programs of this package, less the seed, the first buy and the platform fee. The rent
// part depends on the chain: a local validator charges 6,960 lamports a byte and mainnet 5,080
// (each over 128 bytes of overhead per account, so the rent of an account is its data plus 128,
// times the rate). So each cost is kept as RENT BYTES, the data plus overhead of every account
// the launch creates (the measured lamports less the fees, over 6,960), and priced at the rent
// of the chain the page is on, read once by startLaunch (ctx.client.rent(): two reads, kept an
// hour). Never a rent constant on a public cluster. The fees: three signatures (15,000 lamports)
// and, for a coin with a Metaplex metadata account, that program's create fee of 0.01 SOL. A
// pegged coin keeps its name, symbol and metadata address inside the coin (Token-2022) and pays
// no Metaplex fee; every byte of the three adds one byte of rent (perByte()).
const SIGNATURES = 15_000n;
const METAPLEX_METADATA_FEE = 10_000_000n;
export const COST_BYTES = {
  none: 3669,
  // without the treasury account: tokenAccountRent() is added when the launch has to create it
  tax: 3908,
  launch_guard: 3888,
  buyback: 4613,
  // modules: the coin, its rules, the hook's treasury, burn account and stake vault. The same
  // with any set of modules and with or without a first buy. A creator lock adds rulesLockRent().
  rules: 5090,
  collectible: 4462,
  pegged: 4503,
};
const COST_FEES = { none: SIGNATURES + METAPLEX_METADATA_FEE, tax: SIGNATURES + METAPLEX_METADATA_FEE, launch_guard: SIGNATURES + METAPLEX_METADATA_FEE, buyback: SIGNATURES + METAPLEX_METADATA_FEE, rules: SIGNATURES + METAPLEX_METADATA_FEE, collectible: SIGNATURES + METAPLEX_METADATA_FEE, pegged: SIGNATURES };
/// Sizes of the accounts whose rent the cost panel adds on their own: a token account (the
/// treasury of a tax coin or of a custom hook that takes a fee, the lock vault), the dev's ticket.
const TOKEN_ACCOUNT_SIZE = 165;
/// The chain's rent, once startLaunch has read it: `fn` gives the rent of an account of n bytes
/// of data, `perByte` the rent of one byte. Until it is read every cost function throws, and
/// the cost panel says the rent could not be read instead of showing a number of another chain.
const RENT = { fn: null, perByte: 0n };
export const rentKnown = () => !!RENT.fn;
const needRent = () => { if (!RENT.fn) throw new Error("The chain's rent could not be read from " + ctx.rpcHost + "."); };
/// The rent function of this chain (what the SDK's deposit helpers take).
export function rentFn() { needRent(); return RENT.fn; }
/// The rent of an account of `bytes` of data on this chain.
export function rentOf(bytes) { needRent(); return RENT.fn(bytes); }
/// The rent of one byte on this chain.
export function perByte() { needRent(); return RENT.perByte; }
/// A measured cost priced on this chain: `rentBytes` of rent (data plus overhead of every account)
/// and the fees that do not change.
export function measuredCost(rentBytes, fees) { needRent(); return RENT.perByte * BigInt(rentBytes) + fees; }
/// What a launch of `kind` costs beyond the seed, the first buy and the platform fee, on this chain.
export function costOf(kind) { const k = COST_BYTES[kind] !== undefined ? kind : "none"; return measuredCost(COST_BYTES[k], COST_FEES[k]); }
/// Rent of one token account (165 bytes).
export const tokenAccountRent = () => rentOf(TOKEN_ACCOUNT_SIZE);
/// Rent of the dev's ticket (346 bytes), opened when a collectible coin is launched with a first buy.
export const ticketRent = () => rentOf(H.collectible.TICKET_BASE_SIZE);
/// Rent of the lock record (57 bytes) and of the lock vault, a token account: what a creator lock
/// adds to a launch with modules.
export const rulesLockRent = () => rentOf(H.LOCK_RECORD_SIZE) + rentOf(TOKEN_ACCOUNT_SIZE);
/// The most bytes one Solana transaction may hold.
export const MAX_TX_BYTES = 1232;
/// Seconds the second transaction is given to land after the last look at the chain's clock.
const LAND_ROOM = 90n;

export const keyOrNull = (text) => { try { return new PublicKey(String(text).trim()); } catch (_) { return null; } };
export const pct = (id) => { const v = Number(String($(id).value).replace(",", ".")); return isFinite(v) ? Math.round(v * 100) : NaN; };
export const sol = (id) => parseUnits(String($(id).value).replace(",", "."), 9);
export const wholeCoins = (id) => { try { return BigInt(String($(id).value).replace(/[,\s]/g, "") || "0"); } catch (_) { return 0n; } };
export const plain = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 4, useGrouping: false });
/// An amount in SOL rounded up to `frac` decimals, so a total is never shown below what is spent.
export function solUp(lamports, frac) { const step = 10n ** BigInt(9 - frac); return ((lamports + step - 1n) / step) * step; }
export function feeBps() { return Number(document.querySelector("input[name=fee]:checked").value); }

/// A labelled number field of a module or of a hook: { id, label, suffix, value, hint, hintId, max }.
/// `max` names a bound whose text the page fills in later (data-max).
export function numField(f) {
  return el("label", { class: "field" },
    el("span", null, el("span", { text: f.label }), el("span", { class: "dim", id: f.hintId || null, "data-max": f.max || null, text: f.hint || "" })),
    el("div", { class: "input-wrap" },
      el("input", { class: "input num", id: f.id, inputmode: "decimal", value: f.value, autocomplete: "off" }),
      el("span", { class: "suffix", text: f.suffix })));
}
/// A module: a row with its icon, its name and a toggle, and the fields that open under it.
/// { key, name, icon, fields, help }. The whole row is the switch (data-switch = key).
export function moduleRow(m) {
  return el("div", { class: "module", "data-rule": m.key, "data-on": "false" },
    el("button", { class: "module-head", type: "button", role: "switch", "aria-checked": "false", "data-switch": m.key },
      el("span", { class: "module-icon" }, svg(m.icon)),
      el("span", { class: "module-name" }, m.name, el("small", { "data-sum": m.key })),
      el("span", { class: "toggle" })),
    el("div", { class: "module-body", "data-fields": m.key, hidden: true },
      m.fields.length ? el("div", { class: "row" }, ...m.fields.map(numField)) : null,
      el("p", { class: "error-text", "data-err": m.key, "aria-live": "polite" }),
      el("p", { class: "help", "data-help": m.key, text: m.help || "" })));
}

const DETAILS_HTML = `
<div class="field image-pick">
  <img class="avatar lg" id="thumb" alt="" width="56" height="56">
  <span class="btn file-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM4 16l4.500-4.500 4 4 2.500-2.500 5 5M15 8.500h.010" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round" stroke-linejoin="round"/></svg>Add image<input type="file" id="imageFile" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Add image"></span>
</div>
<label class="field"><span><span>Name</span><span class="dim" id="nameCount">0/32</span></span><input class="input" id="name" maxlength="32" required placeholder="Coin name" autocomplete="off"></label>
<label class="field"><span><span>Ticker</span><span class="dim" id="symCount">0/10</span></span><input class="input" id="symbol" maxlength="10" required placeholder="COIN" autocomplete="off" spellcheck="false"></label>
<div class="raised settings">
  <h3>Launch settings</h3>
  <div class="field start-field">
    <span class="label"><span>How the pool starts</span></span>
    <div class="choices start-choices" id="startChoices" role="radiogroup" aria-label="How the pool starts">
      <label class="choice" data-start="curve"><input type="radio" name="start" value="curve" checked><div class="title">Curve</div><p id="startCurveLine">No SOL from you.</p></label>
      <label class="choice" data-start="seed"><input type="radio" name="start" value="seed"><div class="title">Seed it yourself</div><p>You add SOL. It stays locked.</p></label>
    </div>
    <p class="help" id="startOff" hidden></p>
  </div>
  <div class="row">
    <label class="field" id="seedField" hidden><span><span>Seed</span></span><div class="input-wrap"><input class="input num" id="seed" inputmode="decimal" value="2" required autocomplete="off"><span class="suffix">SOL</span></div></label>
    <label class="field"><span><span>First buy</span></span><div class="input-wrap"><input class="input num" id="devBuy" inputmode="decimal" value="0" autocomplete="off"><span class="suffix">SOL</span></div></label>
  </div>
  <div class="field">
    <span class="label"><span>Pool fee</span><span class="dim">stays in the pool</span></span>
    <div class="fee-choices">
      <label class="choice"><input type="radio" name="fee" value="30"><div class="title">0.3%</div><p>deep pools</p></label>
      <label class="choice"><input type="radio" name="fee" value="100" checked><div class="title">1%</div><p>the usual</p></label>
      <label class="choice"><input type="radio" name="fee" value="300"><div class="title">3%</div><p>thin pools</p></label>
    </div>
  </div>
  <label class="field" id="supplyField" hidden><span><span>Total supply</span><span class="dim">6 decimals, fixed</span></span><input class="input num" id="supply" inputmode="numeric" value="1,000,000,000" required autocomplete="off"></label>
  <div class="field fact" id="supplyFact"><span class="label"><span>Total supply</span><span class="dim">fixed on the curve</span></span><div class="fact-v" id="supplyFactV">1,000,000,000</div></div>
</div>
<label class="field" style="margin-top: 14px"><span><span>Description</span></span><textarea id="description" maxlength="600" placeholder="About your coin"></textarea></label>
<details class="more">
  <summary>Links</summary>
  <label class="field"><span><span>Website</span></span><input class="input" id="website" type="url" placeholder="https://"></label>
  <label class="field"><span><span>X</span></span><input class="input" id="twitter" type="url" placeholder="https://x.com/"></label>
  <label class="field"><span><span>Telegram</span></span><input class="input" id="telegram" type="url" placeholder="https://t.me/"></label>
  <label class="field"><span><span>Image address</span><span class="dim">instead of a file</span></span><input class="input" id="imageUrl" type="url" placeholder="https://" autocomplete="off"></label>
  <label class="field"><span><span>Metadata file</span><span class="dim">if you host it yourself</span></span><input class="input" id="metaUrl" type="url" placeholder="https://" maxlength="200" autocomplete="off"></label>
</details>`;

const PREVIEW_HTML = `
<div class="coin-preview" id="coinPreview">
  <img id="pvImg" alt="" width="172" height="172">
  <div class="name" id="pvName">Your coin</div>
  <div class="ticker" id="pvTicker">COIN</div>
  <div class="kind" id="pvKind"></div>
  <div class="pair" id="pvPair">COIN / SOL</div>
</div>`;

const REVIEW_HTML = `
<h2 class="panel-title">Review</h2>
<div class="review-sides">
  <div><h4>A buy pays</h4><dl class="kv fees" id="revBuy"></dl></div>
  <div><h4>A sell pays</h4><dl class="kv fees" id="revSell"></dl></div>
</div>
<div id="revNote"></div>
<div class="review-part" id="revFirst" hidden><h4>Your first buy</h4><dl class="kv" id="revFirstKv"></dl><p class="help" id="revFirstNote"></p></div>
<div class="review-part" id="revLock" hidden><h4>Creator lock</h4><p class="small" id="revLockText"></p></div>
<div class="review-part">
  <h4>This launch costs</h4>
  <dl class="kv" id="costs"></dl>
  <div class="total"><span>Total</span><span class="v" id="total"></span></div>
  <p class="help" id="rentNote"></p>
  <p class="help" id="devBuyNote"></p>
  <div class="start-note" id="startNote"></div>
</div>`;

const STEP2_SEED = "Seed, lock the liquidity, first buy.";
const STEP2_CURVE = "Open the pool on the curve, first buy.";
const GO_HTML = `
<p class="error-text" id="revProblems" aria-live="polite"></p>
<ol class="steps" id="steps" hidden>
  <li id="step1"><span class="n">1</span><span><b>Create the coin</b><span class="d" id="step1d"> Mint, metadata and the hook config.</span></span></li>
  <li id="step2"><span class="n">2</span><span><b>Create the pool</b><span class="d" id="step2d"> Open the pool on the curve, first buy.</span></span></li>
</ol>
<div class="go-total"><span>This launch costs</span><span class="v" id="goTotal"></span></div>
<button class="btn btn-primary btn-main btn-block" id="launchBtn" type="button">Launch</button>
<div class="tx-result" id="result"></div>`;

/// Fill the page's four mounts and read the platform. Returns the core; the page then calls
/// core.run(path).
export async function startLaunch() {
  $("mDetails").innerHTML = DETAILS_HTML;
  $("mPreview").innerHTML = PREVIEW_HTML;
  $("mReview").innerHTML = REVIEW_HTML;
  $("mGo").innerHTML = GO_HTML;
  reviewFold();
  // the platform and the chain's rent, read together: every cost below is priced at that rent
  const readRent = async () => { const r = await ctx.client.rent(); RENT.fn = r; RENT.perByte = r(1) - r(0); };
  let plat = null;
  await Promise.all([platform().then((p) => { plat = p; }).catch(() => {}), readRent().catch(() => {})]);
  const protocol = plat ? plat.protocolFeeBps : 0;
  let path = null;
  let imageData = ""; // data URL of the picked file, shrunk
  let busy = false, launched = false, retryOf = null;

  // ---- how the pool starts ----
  // START.wanted: the launcher's choice, "curve" or "seed". START.block: why the curve cannot be
  // used here ("" when it can), set by the path (a pegged coin) or by the platform (curve off).
  const START = { wanted: "curve", block: "" };
  const platformBlock = () => (!plat ? "" : plat.curveEnabled ? "" : "Curve launches are switched off on this platform. The pool starts with a seed you put in.");
  const curveBlock = () => START.block || platformBlock();
  const isCurve = () => START.wanted === "curve" && !curveBlock();
  const CURVE_SUPPLY = CURVE_SUPPLY_WHOLE * 10n ** BigInt(DECIMALS);
  /// The curve's numbers for a coin launched now, worked out by the SDK from the platform
  /// account: the market cap it opens at, the target, the burn at the target as a share of the
  /// supply, the share sold by then, and the platform's cut at graduation. null without a platform.
  function curveFacts() {
    if (!plat) return null;
    const fresh = { reserveBase: CURVE_SUPPLY, reserveQuote: 0n, virtualQuote: plat.curveVirtualQuote, graduationTarget: plat.curveGraduationTarget, graduationFeeBps: plat.curveGraduationFeeBps, curveState: H.CURVE_OPEN };
    let progress = null, burn = null;
    try { progress = H.curveProgress(fresh, CURVE_SUPPLY); burn = H.graduationBurn(fresh); } catch (_) { return null; }
    const baseAtTarget = burn.reserveBaseAfter + burn.burned;
    return {
      startCap: progress.startMarketCapQuote || plat.curveVirtualQuote, target: plat.curveGraduationTarget,
      burnBps: Number((burn.burned * 10_000n) / CURVE_SUPPLY), soldBps: Number(((CURVE_SUPPLY - baseAtTarget) * 10_000n) / CURVE_SUPPLY),
      fee: burn.fee, feeBps: plat.curveGraduationFeeBps,
    };
  }
  /// Draw the choice, the fields it shows and hides, and the sentence when the curve is off.
  function drawStart() {
    const curve = isCurve(), block = curveBlock();
    for (const r of document.querySelectorAll("input[name=start]")) {
      r.checked = r.value === (curve ? "curve" : "seed");
      if (r.value === "curve") { r.disabled = !!block; r.closest(".choice").classList.toggle("off", !!block); }
    }
    $("startOff").hidden = !block; $("startOff").textContent = block;
    $("seedField").hidden = curve;
    $("supplyField").hidden = curve;
    $("supplyFact").hidden = !curve;
    $("supplyFactV").textContent = CURVE_SUPPLY_WHOLE.toLocaleString("en-US");
    const f = curveFacts();
    $("startCurveLine").textContent = f ? "No SOL from you. It graduates at " + fmtSol(f.target, 2) + " SOL." : "No SOL from you.";
  }
  for (const r of document.querySelectorAll("input[name=start]")) r.addEventListener("change", () => { if (r.checked) { START.wanted = r.value; drawStart(); summarize(); } });
  drawStart();

  // ---- the coin's own fields ----
  const picture = () => { const v = $("imageUrl").value.trim(); return imageData || (/^https?:\/\//.test(v) ? v : monogram($("symbol").value)); };
  const drawPicture = () => { for (const id of ["thumb", "pvImg"]) { const img = $(id); img.onerror = () => { img.onerror = null; img.src = monogram($("symbol").value); }; img.src = picture(); } };
  $("symbol").addEventListener("input", () => { $("symbol").value = $("symbol").value.toUpperCase().replace(/\s+/g, ""); $("symCount").textContent = $("symbol").value.length + "/10"; drawPicture(); });
  $("name").addEventListener("input", () => { $("nameCount").textContent = $("name").value.length + "/32"; });
  $("imageUrl").addEventListener("input", () => { imageData = ""; drawPicture(); });
  $("imageFile").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try { imageData = await shrink(f, 512); $("imageUrl").value = ""; drawPicture(); }
    catch (_) { toast("That image could not be read.", "err"); }
  });
  drawPicture();

  /// Does a wrapped SOL account exist for this wallet? Read from the chain once per wallet.
  /// Until the answer is in, the estimate counts the rent of a new one.
  const wsolOpen = new Map();
  function treasuryExists(owner) {
    const k = owner.toBase58();
    if (wsolOpen.has(k)) return wsolOpen.get(k) === true;
    wsolOpen.set(k, null);
    ctx.client.exists(H.pda.ata(owner, H.NATIVE_MINT)).then((yes) => { wsolOpen.set(k, yes); summarize(); }).catch(() => wsolOpen.delete(k));
    return false;
  }
  /// Rent of the treasury a hook fee is paid into: the wrapped SOL account of the wallet typed
  /// in `field`, or of the launcher. Zero when it exists already.
  const treasuryRent = (field) => { const owner = keyOrNull($(field).value) || Wallet.current().publicKey; return owner && treasuryExists(owner) ? 0n : tokenAccountRent(); };

  /// What the shared fields hold right now. `curve`: the pool starts on the curve, with no seed,
  /// `virtual` virtual SOL and the fixed supply. `depth`: the SOL the price starts from, the seed
  /// or the virtual SOL.
  function values() {
    const curve = isCurve();
    const supplyWhole = curve ? CURVE_SUPPLY_WHOLE : wholeCoins("supply");
    const symbol = $("symbol").value.trim();
    const seed = curve ? 0n : sol("seed") || 0n, virtual = curve && plat ? plat.curveVirtualQuote : 0n;
    return { curve, seed, virtual, depth: curve ? virtual : seed, dev: sol("devBuy") || 0n, supplyWhole, supply: supplyWhole * 10n ** BigInt(DECIMALS), lp: feeBps(), name: $("name").value.trim(), symbol, sym: symbol || "coins" };
  }
  /// The pool the first buy meets, as quoteSwap's reserves: the seed, or the virtual SOL on the
  /// curve. `c` is values() or what validate() returned.
  function firstPool(c) {
    return { reserveBase: c.totalSupply !== undefined ? c.totalSupply : c.supply, reserveQuote: c.curve ? 0n : c.seed, virtualQuote: c.curve ? c.virtual : 0n };
  }
  /// One side of the review: the protocol fee, the pool fee, then what the path adds.
  /// `extra`: [[name, where it goes, bps or text]]. `hookBps`: what the hook takes in all.
  function side(extra = [], hookBps = 0, totalText = "") {
    const lp = feeBps();
    return { rows: [["Protocol fee", "to the platform", protocol], ["Pool fee", "stays in the pool", lp], ...extra], total: totalText || fmtPct(protocol + lp + hookBps) };
  }
  /// The first buy against the pool as the launch creates it. null when it cannot be quoted.
  function quoteFirst(c, hookFeeBps = 0, feeOverrideBps = null) {
    if (!plat || c.dev <= 0n || c.depth <= 0n || c.supply <= 0n || c.supply >= 2n ** 64n) return null;
    try { return H.quoteSwap({ direction: DIRECTION.BUY, amountIn: c.dev, ...firstPool(c), lpFeeBps: c.lp, protocolFeeBps: protocol, hookFeeBps, feeOverrideBps }); } catch (_) { return null; }
  }
  /// Does a first buy of `dev` lamports reach the curve's target on its own? The SDK's rule
  /// (firstBuyGraduates): what is left after the protocol fee and the hook fee. The hook fee is
  /// 0 without a hook, the coin's buy rate for a tax or buyback coin, the platform's cap for any
  /// other hook. Then the launch transaction ends with graduate.
  const graduatesAtLaunch = (c) => {
    if (!plat || !c.curve || c.dev <= 0n) return false;
    const rates = path && path.firstBuyRates ? path.firstBuyRates() : {};
    return H.firstBuyGraduates(c.dev, plat, H.firstBuyHookFeeBps(path && path.template ? path.template() : undefined, rates, plat.maxHookFeeBps));
  };
  /// The rows of "Your first buy" from a quote. `hookLabel` names the hook's share, `raised`
  /// what a pool fee above the usual one is.
  function firstRows(q, c, hookLabel, raised) {
    return [
      ["You pay", fmtSol(c.dev, 9) + " SOL"],
      ["Protocol fee " + fmtPct(protocol), fmtSol(q.protocolFee, 9) + " SOL"],
      q.hookFee > 0n ? [hookLabel, fmtSol(q.hookFee, 9) + " SOL"] : null,
      ["Pool fee " + fmtPct(q.feeBpsApplied) + (q.feeBpsApplied !== c.lp && raised ? ", " + raised : ""), fmtSol(q.lpFee, 9) + " SOL"],
      ["You receive", fmtUnits(q.amountOut, DECIMALS, DECIMALS) + " " + c.sym],
    ].filter(Boolean);
  }

  // ---- the review and the cost ----
  /// Under the cost: what happens to the seed, or how the curve works, with the platform's numbers.
  function drawStartNote(c) {
    const f = c.curve ? curveFacts() : null;
    const lines = !c.curve ? ["The seed becomes liquidity, and the launch locks it in the pool. You get no LP for it. Nobody can withdraw it."]
      : !f ? ["You put no SOL into the pool. Liquidity opens at graduation."]
      : [
        "You put no SOL into the pool. The coin opens at a market cap of " + fmtSol(f.startCap, 2) + " SOL.",
        "It graduates when buyers have put " + fmtSol(f.target, 2) + " SOL into the pool." + (f.fee > 0n ? " The platform then keeps " + fmtSol(f.fee, 4) + " SOL of it." : ""),
        "At graduation about " + fmtPct(f.burnBps, 1) + " of the supply is burned, so the price does not move. A later graduation burns less.",
        "Liquidity opens at graduation.",
      ];
    $("startNote").replaceChildren(...lines.map((t) => el("p", { class: "help", text: t })));
  }
  function summarize() {
    if (!path) return;
    const c = values();
    // the rent could not be read when the page opened: tried again now (at most every five seconds), and the
    // panel redrawn when it is in
    if (!rentKnown() && !(RENT.retryAt > Date.now())) { RENT.retryAt = Date.now() + 5000; readRent().then(summarize).catch(() => {}); }
    // rounded up to the fourth decimal, so the Total is never below what the wallet spends. Null while the
    // chain's rent is unknown: a number of another chain is never shown.
    const rent = rentKnown() ? solUp(path.rent(c), 4) : null;
    const launchFee = plat ? plat.launchFeeLamports : 0n;
    // a collectible coin: the first buy's pieces get their NFTs from a deposit paid in the launch itself
    const deposit = rentKnown() && path.deposit ? path.deposit(c) : 0n;
    // on the curve the launcher puts no SOL into the pool: the first row of a seeded launch is gone
    $("costs").replaceChildren(
      ...(c.curve ? [] : [el("dt", { text: "Seed, locked in the pool" }), el("dd", { text: fmtSol(c.seed, 4) + " SOL" })]),
      el("dt", { text: "Your first buy" }), el("dd", { text: fmtSol(c.dev, 4) + " SOL" }),
      ...(deposit > 0n ? [el("dt", { text: "Deposit for its NFTs" }), el("dd", { text: fmtSol(solUp(deposit, 4), 4) + " SOL" })] : []),
      el("dt", { text: "Platform launch fee" }), el("dd", { text: fmtSol(launchFee, 4) + " SOL" }),
      el("dt", { text: "Rent and network fees" }), el("dd", { text: rent === null ? "not read yet: the RPC at " + ctx.rpcHost + " did not answer" : "about " + fmtSol(rent, 4) + " SOL" }));
    $("total").textContent = rent === null ? "waiting for the chain's rent" : fmtSol(solUp(c.seed + c.dev + deposit + launchFee + rent, 4), 4) + " SOL";
    drawStartNote(c);
    // said once more right above the button: on a phone the review is another view
    $("goTotal").textContent = $("total").textContent;
    const r = path.review(c);
    const kids = (s) => [
      ...s.rows.flatMap(([name, to, v]) => [el("dt", null, name, el("span", { class: "to", text: to })), el("dd", { text: typeof v === "number" ? fmtPct(v) : v })]),
      el("dt", { class: "sum", text: "In total" }), el("dd", { class: "sum", text: s.total })];
    $("revBuy").replaceChildren(...kids(r.buy)); $("revSell").replaceChildren(...kids(r.sell));
    $("revNote").replaceChildren(...(r.notes || []).map((t) => el("p", { class: "help", text: t })));
    $("revFirst").hidden = !r.first;
    if (r.first) {
      $("revFirstKv").replaceChildren(...r.first.rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
      const grad = graduatesAtLaunch(c) ? "Your first buy reaches the target of " + fmtSol(plat.curveGraduationTarget, 2) + " SOL on its own, so the coin graduates in the launch transaction." : "";
      $("revFirstNote").textContent = [r.first.note || "", grad].filter(Boolean).join(" ");
    }
    $("revLock").hidden = !r.lock;
    $("revLockText").textContent = r.lock || "";
    $("rentNote").textContent = r.rentNote || "";
    $("devBuyNote").textContent = r.devBuyNote || "";
    $("revProblems").textContent = r.problems || "";
    // the preview: the coin as its card will show it
    $("pvName").textContent = c.name || "Your coin";
    $("pvTicker").textContent = c.symbol || "COIN";
    $("pvPair").textContent = (c.symbol || "COIN") + " / SOL";
    $("pvKind").textContent = path.kind ? path.kind() : "";
  }

  // ---- validation and metadata ----
  function validate() {
    const c = values();
    if (!c.name || c.name.length > 32) throw new Error("Give the coin a name of 1 to 32 characters.");
    if (!c.symbol || c.symbol.length > 10) throw new Error("Give the coin a ticker of 1 to 10 characters.");
    if (c.supplyWhole <= 0n) throw new Error("Total supply must be above zero.");
    if (c.supply >= 2n ** 64n) throw new Error("Total supply is too large for a token. Keep it under 18,000,000,000,000.");
    // on the curve the pool needs no seed: the platform's virtual SOL stands in for it
    let seed = 0n;
    if (!c.curve) {
      seed = sol("seed");
      if (!seed || seed < 10_000_000n) throw new Error("Seed the pool with at least 0.01 SOL.");
    }
    const out = { name: c.name, symbol: c.symbol, totalSupply: c.supply, supplyWhole: c.supplyWhole, curve: c.curve, virtual: c.virtual, seed, dev: c.dev, lpFeeBps: c.lp, template: path.template() };
    path.validate(out);
    return out;
  }
  async function metadataUrl(v) {
    const manual = $("metaUrl").value.trim();
    if (manual) { if (!/^https?:\/\//.test(manual) || manual.length > 200) throw new Error("The metadata file's address must start with https and be under 200 characters."); return manual; }
    const image = imageData || $("imageUrl").value.trim();
    const body = { name: v.name, symbol: v.symbol, description: $("description").value.trim(), image, extensions: { website: $("website").value.trim(), twitter: $("twitter").value.trim(), telegram: $("telegram").value.trim() } };
    const r = await fetch("/api/metadata", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((j && j.error) || "The metadata upload failed (" + r.status + "). You can host the file yourself and paste its address under Links.");
    if (!j || !j.url) throw new Error("The metadata upload returned no address.");
    if (j.url.length > 200) throw new Error("The hosted metadata address is longer than 200 characters, which the program refuses.");
    return j.url;
  }

  // ---- the launch ----
  const btn = $("launchBtn"), result = $("result");
  const idle = () => (Wallet.current().publicKey ? "Launch" : "Connect wallet");
  function step(n, state, text) { const li = $("step" + n); li.className = state; if (text !== undefined) $("step" + n + "d").textContent = " " + text; }
  const fail = (text) => result.replaceChildren(el("span", { class: "bad", text }));

  async function launch() {
    // a coin that was created and still waits for its pool: this press sends step 2 of that
    // launch again. It must never start a second launch, with a second coin, next to it.
    if (retryOf) { retry(); return; }
    if (busy || launched) return;
    let dev;
    try { dev = requireWallet(); } catch (_) { openWallet(); return; }
    result.replaceChildren();
    let v;
    try { v = validate(); } catch (e) { fail(e.message); return; }
    if (!plat) { fail("The platform account could not be read from " + ctx.rpcHost + "."); return; }
    // a collectible launch sizes the deposit of its first buy at the chain's rent: it must be known by now
    if (!rentKnown()) { try { await readRent(); } catch (_) { fail("The chain's rent could not be read from " + ctx.rpcHost + ". Try again."); return; } }
    busy = true; btn.disabled = true; btn.textContent = "Preparing";
    $("steps").hidden = false; // the two steps show from the moment a launch starts
    step(1, "", "Mint, metadata and the hook config."); step(2, "", v.curve ? STEP2_CURVE : STEP2_SEED);
    try {
      if (path.before) await path.before(v, dev);
      const uri = await metadataUrl(v);
      const mint = (path.mint && path.mint(v)) || Keypair.generate();
      if (path.setup) await path.setup(v, dev, mint);
      // the first buy is quoted against the pool as it will be one instruction earlier, with 1% room
      const minDevBuyOut = v.dev > 0n ? path.minOut(v) : 0n;
      // on the curve: launch_curve, with no SOL into the pool (the SDK's curve option)
      const launchArgs = {
        dev, mint, name: v.name, symbol: v.symbol, uri, decimals: DECIMALS, totalSupply: v.totalSupply,
        quoteMint: H.NATIVE_MINT, lpFeeBps: v.lpFeeBps, ...(v.curve ? { curve: true } : { quoteAmount: v.seed }), devBuyQuote: v.dev, minDevBuyOut,
        template: v.template, tax: v.tax, guard: v.guard, buyback: v.buyback, custom: v.custom, collectible: v.collectible, rules: v.rules,
      };
      // a path may add to the end of the launch transaction: a collectible coin pays the deposit for the
      // NFTs of the first buy there, and a keeper mints them into the wallet after the launch
      const extend = (p) => (path.extendLaunch ? { ...p, launchTx: [...p.launchTx, ...path.extendLaunch(v, dev, p)] } : p);
      let plan;
      try { plan = extend(await ctx.client.launchInstructions(launchArgs)); }
      catch (e) { throw e instanceof H.CurveRefusal ? new Error(curveSentence(e)) : e instanceof H.HookApprovalRefusal ? new Error("This hook has not been reviewed by Programmable yet, so no coin can launch on it.") : new Error(buildSentence(e)); }
      // a path can look at the first transaction before the wallet opens (a custom hook's setup is simulated there)
      const said = path.guard ? (await path.guard(v, dev, plan, (t) => { btn.textContent = t; })) || "" : "";
      // a pegged coin carries its name, symbol and metadata address inside the coin, which makes its
      // first transaction the largest one a launch builds. Say so before the wallet opens.
      const over = (await ctx.client.buildTx(dev, plan.createTx)).tx.serialize().length - MAX_TX_BYTES;
      if (over > 0) throw new Error("The first transaction is " + over + " bytes too large. Shorten the metadata address, the renderer base or the names.");
      // a launch that locks the first buy fits one transaction only with the platform's lookup table
      if (plan.lock) {
        let size = MAX_TX_BYTES + 1;
        try { size = (await ctx.client.buildTx(dev, plan.launchTx)).tx.serialize().length; } catch (_) {}
        if (size > MAX_TX_BYTES) throw new Error("The launch with the creator lock does not fit in one transaction on this site. Switch the creator lock off to launch.");
      }
      // the second transaction of a launch with a lock carries the date the lock ends: it is built
      // again, with the same coin, when that date has grown too old to land (sendLaunch)
      const L = { plan, symbol: v.symbol, curve: v.curve, rebuild: async () => extend(await ctx.client.launchInstructions(launchArgs)) };
      step(1, "doing", said + "Confirm the first transaction in your wallet.");
      btn.textContent = "Signing 1 of 2";
      const sig1 = await sendIxs(plan.createTx, plan.signers, "coin creation");
      step(1, "done", "Coin " + short(mint.publicKey.toBase58(), 5) + " created.");
      step(2, "doing", "Confirm the second transaction in your wallet.");
      btn.textContent = "Signing 2 of 2";
      let sig2;
      try {
        sig2 = await sendLaunch(L);
      } catch (e) {
        step(2, "failed", e.message);
        fail("The coin exists but the pool was not created. You can retry step 2 with the same settings. The mint is " + mint.publicKey.toBase58() + ".");
        retryOf = L; busy = false;
        btn.textContent = "Retry step 2";
        btn.disabled = false;
        return;
      }
      step(2, "done", "Pool " + short(plan.pool.toBase58(), 5) + poolDone(L));
      const href = "coin.html?pool=" + plan.pool.toBase58();
      result.replaceChildren(el("a", { class: "btn btn-primary btn-block", href, text: "Open " + v.symbol }), el("div", { class: "small muted", style: "margin-top: 8px" }, el("a", { class: "link", href: explorer("tx", sig1), target: "_blank", rel: "noopener", text: "tx 1" }), " ", el("a", { class: "link", href: explorer("tx", sig2), target: "_blank", rel: "noopener", text: "tx 2" })));
      if (path.done) path.done(v, result);
      if (L.plan.lock) await lockedLine(L);
      toast(v.symbol + " is live.", "ok");
      launched = true; busy = false;
      btn.textContent = "Launched";
    } catch (e) {
      if ($("step1").className === "doing") step(1, "failed", e.message);
      fail(e.message);
      busy = false; btn.disabled = false; btn.textContent = idle();
    }
  }
  /// An error the SDK threw while the launch was built, as one plain sentence for the red line
  /// under the button: the SDK's words are for a developer ("amount must be greater than zero").
  function buildSentence(e) {
    const raw = String((e && e.message) || e || "");
    if (/amount must be greater than zero/i.test(raw)) return "The first buy must be above zero. Leave it empty to launch without one.";
    const why = plainError(raw);
    return "The launch could not be built." + (why ? " " + why.charAt(0).toUpperCase() + why.slice(1) : "");
  }
  /// The end of the line that says step 2 is done, after "Pool <address>".
  function poolDone(L) {
    if (!L.curve) return " created, liquidity locked.";
    return L.plan.curve && L.plan.curve.graduatesAtLaunch ? " opened on the curve and graduated by your first buy, liquidity locked." : " opened on the curve, liquidity locked.";
  }
  /// Can a launch that carries this lock date still land in time? The program refuses the lock,
  /// and the whole launch with it, when the pool is created after `landBefore`.
  async function lockInTime(lock) { return (await ctx.client.chainTime()).unixTime + LAND_ROOM <= lock.landBefore; }
  /// Send the second transaction. With a creator lock it is built again when its date is too old,
  /// before the wallet opens and again after a wallet that stayed open for long: a launch that
  /// must fail is never sent.
  async function sendLaunch(L) {
    if (!L.plan.lock) return sendIxs(L.plan.launchTx, [], "launch");
    const dev = requireWallet();
    for (let round = 0; round < 3; round++) {
      if (!(await lockInTime(L.plan.lock))) {
        step(2, "doing", "The lock date in this transaction is too old to land now. Building it again with a new date.");
        const again = await L.rebuild();
        L.plan = { ...L.plan, launchTx: again.launchTx, lock: again.lock };
        step(2, "doing", "The lock date was set again. Confirm the second transaction in your wallet.");
      }
      const built = await ctx.client.buildTx(dev, L.plan.launchTx);
      const signed = await signTx(built.tx);
      if (await lockInTime(L.plan.lock)) return sendSigned(signed, built, "launch");
      step(2, "doing", "Your wallet stayed open longer than the lock date in this transaction allows, so it was not sent. Confirm once more.");
    }
    throw new Error("The wallet stayed open too long three times, so nothing was sent. Press Retry step 2 and confirm at once.");
  }
  /// After a launch with a lock: what the lock account holds and until when, read from the chain.
  async function lockedLine(L) {
    try {
      const lock = await ctx.client.rulesLock(L.plan.pool);
      if (lock && lock.vaultBalance > 0n) result.append(el("p", { class: "help", id: "lockedLine", text: fmtUnits(lock.vaultBalance, DECIMALS, DECIMALS) + " " + L.symbol + " of your first buy are locked until " + fmtDate(lock.unlockAt) + ", your local time." }));
    } catch (_) {}
  }
  async function retry() {
    if (!retryOf || busy) return;
    busy = true; btn.disabled = true; btn.textContent = "Signing 2 of 2";
    step(2, "doing", "Confirm the second transaction in your wallet.");
    try {
      const sig2 = await sendLaunch(retryOf);
      step(2, "done", "Pool" + poolDone(retryOf));
      const href = "coin.html?pool=" + retryOf.plan.pool.toBase58();
      result.replaceChildren(el("a", { class: "btn btn-primary btn-block", href, text: "Open the coin" }), el("div", { class: "small muted", style: "margin-top: 8px" }, el("a", { class: "link", href: explorer("tx", sig2), target: "_blank", rel: "noopener", text: "tx 2" })));
      if (retryOf.plan.lock) await lockedLine(retryOf);
      retryOf = null; launched = true; busy = false;
      btn.textContent = "Launched";
    } catch (e) {
      step(2, "failed", e.message);
      busy = false; btn.disabled = false; btn.textContent = "Retry step 2";
    }
  }

  const core = {
    plat, protocol,
    maxHookBps: plat ? plat.maxHookFeeBps : 1000,
    maxOverrideBps: plat ? plat.maxFeeOverrideBps : 5000,
    values, side, quoteFirst, firstRows, treasuryRent, summarize, firstPool, isCurve, curveFacts,
    // the chain's rent, for a path's own costs
    rentKnown, rentFn, rentOf, perByte, measuredCost, costOf, tokenAccountRent, ticketRent, rulesLockRent,
    /// Switch the curve off for this path with a sentence that says why ("" switches it back
    /// on). The launcher's own choice comes back when the reason goes.
    blockCurve(reason) { START.block = reason || ""; drawStart(); summarize(); },
    /// Hand over the path and start: the review is drawn and the button is live.
    run(p) {
      path = p;
      for (const id of ["seed", "devBuy", "supply", "name", "symbol", "metaUrl"]) $(id).addEventListener("input", summarize);
      for (const r of document.querySelectorAll("input[name=fee]")) r.addEventListener("change", summarize);
      // the rent of a treasury account depends on the wallet that will own it
      Wallet.onChange(() => { if (!busy && !launched && !retryOf) btn.textContent = idle(); summarize(); });
      btn.textContent = idle();
      btn.addEventListener("click", launch);
      summarize();
    },
  };
  return core;
}

/// On a wide screen the review beside the form scrolls inside its panel when it is taller than
/// the window (styles.css, .review-scroll), so its last sentences can sit below the fold. While
/// more of it is out of sight, a bar at its foot says "More below", and a press scrolls on. The
/// bar follows every change of the review and of the window. A page without .review-scroll
/// (Module Mode) gets nothing.
function reviewFold() {
  const box = document.querySelector(".review-scroll");
  if (!box) return;
  const btn = el("button", { class: "btn btn-sm", type: "button", text: "More below" });
  const bar = el("div", { class: "review-more", id: "reviewMore", hidden: true }, btn);
  box.after(bar);
  const check = () => { bar.hidden = box.scrollHeight - box.scrollTop - box.clientHeight <= 4; };
  let queued = false;
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; check(); }); };
  btn.addEventListener("click", () => {
    const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollBy({ top: Math.max(80, box.clientHeight - 80), behavior: still ? "auto" : "smooth" });
  });
  box.addEventListener("scroll", later, { passive: true });
  window.addEventListener("resize", later);
  if (window.ResizeObserver) new ResizeObserver(later).observe(box);
  if (window.MutationObserver) new MutationObserver(later).observe(box, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
  later();
}

async function shrink(file, size) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(size, Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = s; c.height = s;
    const g = c.getContext("2d");
    const scale = s / Math.max(img.width, img.height);
    const w = img.width * scale, h = img.height * scale;
    g.drawImage(img, (s - w) / 2, (s - h) / 2, w, h);
    const keepPng = file.type === "image/png" || file.type === "image/gif" || file.type === "image/webp";
    return c.toDataURL(keepPng ? "image/png" : "image/jpeg", 0.9);
  } finally { URL.revokeObjectURL(url); }
}
