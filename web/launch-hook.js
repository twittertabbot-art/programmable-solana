// Custom hook: a coin on a hook. The platform's own hooks come first (tax, launch guard,
// buyback), then the frozen hooks other people built, then a program id pasted by hand. The
// shared parts of a launch are in launch-core.js.
import { boot, ctx, H, Wallet, $, el, fmtSol, fmtPct, fmtInt, minutesToSlots, slotsToSeconds, fmtSpan, applyBps, short, checkHook, checkLines, copyButton, flagSentences, templateOfProgram, rpcFailText, allPools as poolsList } from "./common.js";
import { startLaunch, pct, sol, costOf } from "./launch-core.js";
// a hook's own settings from its descriptor, the guard on its setup, the list of community hooks,
// and the approved list: while the platform's rule is on, only an approved hook can open a pool
import { customHookSetup, workshopHooks, hookName, approvalOf, NOT_REVIEWED } from "./workshop-lib.js";

await boot("launch.html");
const { Keypair, PublicKey, DIRECTION } = H;
const core = await startLaunch();
const plat = core.plat;
const PLATFORM_HOOKS = ["tax", "launch_guard", "buyback"];

$("taxCap").textContent = fmtPct(core.maxHookBps, 0);
$("guardCap").textContent = fmtPct(core.maxOverrideBps, 0);
// a buyback buys against a price the pool had this many slots earlier; its minimum has a ceiling
$("bbWait").textContent = String(H.BURN_INTERVAL_SLOTS);
$("bbMinMax").textContent = "max " + fmtSol(H.MAX_BUYBACK_MIN_QUOTE) + " SOL";

// ---- which hook is picked ---------------------------------------------------------------------------
// P.pick: "" (none yet), "tax", "launch_guard", "buyback", or "custom" for a program id.
const P = { pick: "" };
function pick(what) {
  P.pick = what;
  for (const b of document.querySelectorAll(".hook-option")) {
    const mine = b.dataset.hook ? b.dataset.hook === what : what === "custom" && b.dataset.hookId === $("customId").value.trim();
    b.setAttribute("aria-pressed", mine ? "true" : "false");
  }
  for (const n of document.querySelectorAll(".hook-body")) n.hidden = n.dataset.for !== what;
  if (what === "custom") prepareCustom();
  core.summarize();
}
for (const b of $("platformHooks").querySelectorAll(".hook-option")) b.addEventListener("click", () => pick(b.dataset.hook));

// ---- a hook by its program id -----------------------------------------------------------------------
// The mint keypair is made as soon as a program id is picked, so the pool address is known
// before the launch and the dev can create a per-pool config for it.
// C.setup: the helper customHookSetup returns when the hook's author published a descriptor
// (the settings fields, the hook's setup instruction, the guard). null for a hook without one.
// C.checking: the check that is running, so a click on Launch waits for it.
const C = { mint: null, check: null, checking: null, setup: null, settings: null, hookSetup: null };
function prepareCustom() {
  if (!C.mint) C.mint = Keypair.generate();
  const pool = H.pda.pool(C.mint.publicKey, H.NATIVE_MINT);
  const box = $("customPool");
  // a hook no pool may open on gets no pool address
  box.hidden = !!(C.check && C.check.notApproved);
  if (box.hidden) return;
  box.replaceChildren(
    el("div", { class: "verdict", text: "This pool will be at" }),
    el("div", { style: "display:flex;align-items:center;gap:4px;flex-wrap:wrap" }, el("span", { class: "mono", text: pool.toBase58() }), copyButton(pool.toBase58(), "Copy pool address")),
    el("p", { class: "help", text: (C.setup && C.setup.d.setup ? "The form creates this hook's settings for this pool address in the first transaction." : "If your hook needs a per-pool config, create it for this pool address before step 2.") + " The mint will be " + short(C.mint.publicKey.toBase58(), 6) + "." }));
}
$("customId").addEventListener("input", () => { if ($("customId").value.trim()) pick("custom"); else if (P.pick === "custom") pick(""); });
$("customId").addEventListener("blur", () => { if (P.pick === "custom") runCustomCheck(); });
$("customId").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pick("custom"); runCustomCheck(); } });
function runCustomCheck() { C.checking = customCheck(); return C.checking; }
async function customCheck() {
  const out = $("customVerdict");
  const raw = $("customId").value.trim();
  C.check = null; C.setup = null; $("customSetup").hidden = true;
  if (!raw) { out.replaceChildren(); $("customTreasuryField").hidden = true; return null; }
  let id;
  try { id = new PublicKey(raw); } catch (_) { out.replaceChildren(el("p", { class: "error-text", text: "That is not a valid address." })); return null; }
  // one of the platform's own programs: the page has an option for it, or another page does
  const named = templateOfProgram(id);
  if (PLATFORM_HOOKS.includes(named)) { $("customId").value = ""; out.replaceChildren(); $("customTreasuryField").hidden = true; pick(named); return null; }
  if (named !== "custom") {
    const page = named === "collectible" ? ["launch-collectible.html", "the Collectible page"] : ["launch-modules.html", "Module Mode"];
    out.replaceChildren(el("p", { class: "help" }, "This is the platform's " + (named === "collectible" ? "collectible" : "rules") + " program. Launch on it from ", el("a", { class: "link", href: page[0], text: page[1] }), "."));
    return null;
  }
  out.replaceChildren(el("p", { class: "help", text: "Reading the program" }));
  try {
    // the approved list first: a hook that is not on it while the rule is on stops here
    const appr = await ctx.client.hookApproval(id, await ctx.client.platform());
    if (!appr.allowed) {
      C.check = { id, notApproved: true, accepts: false, manifest: null };
      $("customTreasuryField").hidden = true;
      out.replaceChildren(el("div", { class: "verdict-box", id: "customNotApproved" },
        el("div", { class: "verdict bad", text: NOT_REVIEWED }),
        el("p", { class: "help", style: "margin: 0" }, appr.listCorrupt ? "The platform's approved list cannot be read right now, so no pool can open on an outside hook. " : "Programmable reviews a hook before it can open a pool. ",
          el("a", { class: "link", href: "review-hook.html", text: "Get your hook reviewed" }), " or ", el("a", { class: "link", href: "workshop-hook.html?id=" + id.toBase58(), text: "see its page" }), ".")));
      core.summarize();
      if (P.pick === "custom") prepareCustom();
      return C.check;
    }
    const c = await checkHook(id);
    C.check = c;
    const lines = checkLines(c);
    const kids = [];
    // the launchpad itself refuses one kind of hook the pool would take: a hook that sets the price
    c.ownsCurve = !!(c.manifest && (c.manifest.flags & H.FLAGS.OVERRIDE_CURVE));
    const fits = c.accepts && !c.ownsCurve;
    if (c.exists && c.executable) kids.push(el("div", { class: "verdict " + (fits ? "ok" : "bad"), text: fits ? "The pool would accept this hook." : c.ownsCurve && c.accepts ? "The launchpad does not take a hook that sets the price itself." : "The pool would refuse this hook." }));
    // the pool has never called a hook that no pool runs on, and the hook's own code can still
    // refuse the pool in step 2, after step 1 created the coin
    if (fits) {
      let used = true;
      try { used = (await poolsList()).some((p) => p.hasHook && p.hookProgram.equals(id)); } catch (_) {}
      if (!used) kids.push(el("p", { class: "small muted", id: "customNoPool", style: "margin: 0 0 10px", text: "No pool has been created on this hook yet, so nothing on chain shows that the pool can call it. A launch is two transactions. If the hook refuses the pool in the second one, the coin of the first stays created and paid for." }));
    }
    kids.push(el("ul", { class: "check-lines" }, ...lines.map((l) => el("li", { class: l.ok === true ? "ok" : l.ok === false ? "bad" : "muted", text: l.text }))));
    if (c.manifest) kids.push(el("ul", { class: "check-lines", style: "margin-top:8px" }, ...flagSentences(c.manifest.flags, "custom", null, plat).map((s) => el("li", { text: s }))));
    out.replaceChildren(el("div", { class: "verdict-box" }, ...kids));
    core.summarize();
    const takesFee = !!(c.manifest && (c.manifest.flags & H.FLAGS.TAKE_HOOK_FEE));
    $("customTreasuryField").hidden = !takesFee;
    const W = Wallet.current();
    if (takesFee && W.publicKey && !$("customTreasury").value) $("customTreasury").placeholder = W.publicKey.toBase58();
    // the hook's own settings, when its author published a descriptor and the pool would take the hook
    if (fits) { try { C.setup = await customHookSetup($("customSetup"), c, () => Wallet.current().publicKey); } catch (_) { C.setup = null; } }
    if (P.pick === "custom") prepareCustom(); // its last line depends on who creates the hook's settings
    return c;
  } catch (e) {
    out.replaceChildren(el("p", { class: "error-text", text: rpcFailText(e) }));
    return null;
  }
}

// ---- the hooks other people built, from the chain ----------------------------------------------------
async function listCommunity() {
  const box = $("communityHooks");
  try {
    // while the rule is on: the approved hooks, also those without a coin yet. Otherwise: every frozen hook with a coin
    const A = approvalOf(await ctx.client.platform());
    const all = await workshopHooks(undefined, [...A.approved]);
    const hooks = A.required ? all.filter((h) => A.approved.has(h.id)) : all.filter((h) => h.launches > 0);
    if (A.required) $("communityLede").replaceChildren("Hooks other people built that Programmable reviewed and approved, from ", el("a", { class: "link", href: "workshop.html", text: "Custom hooks" }), ". Only an approved hook can open a pool. Read a hook's page and its report before you launch on it.");
    if (!hooks.length) {
      box.replaceChildren(el("div", { class: "inline-msg", text: A.required ? "No hook from another builder is approved yet." : "No hook from another builder has a coin yet. Paste a program id below to launch the first coin on one." }));
      return;
    }
    box.replaceChildren(...hooks.map((h) => el("button", { class: "hook-option", type: "button", "data-hook-id": h.id, "data-approved": A.approved.has(h.id) ? "yes" : "no", "aria-pressed": P.pick === "custom" && $("customId").value.trim() === h.id ? "true" : "false",
      onclick: () => { $("customId").value = h.id; pick("custom"); runCustomCheck(); } },
      el("b", { text: hookName(h) || "Unnamed hook" }),
      el("span", { class: "mono", text: short(h.id, 6), title: h.id }),
      el("span", { text: (h.launches === 1 ? "1 coin" : fmtInt(h.launches) + " coins") + (A.approved.has(h.id) ? ". Reviewed by Programmable" : "") }))));
  } catch (e) {
    box.replaceChildren(el("div", { class: "inline-msg", text: "The list could not be read from " + ctx.rpcHost + ". You can still paste a program id below." }));
  }
}

for (const id of ["taxBuy", "taxSell", "taxMax", "guardFee", "guardMin", "bbBuy", "bbSell", "bbMin", "taxTreasury", "customTreasury"]) $(id).addEventListener("input", core.summarize);

// ---- the review --------------------------------------------------------------------------------------
const num = (x) => Number.isInteger(x) && x >= 0;
const isKey = (v) => { try { new PublicKey(v); return true; } catch (_) { return false; } };
/// What is wrong with the picked hook's numbers, in sentences under its fields. Drawn as they are typed.
function hookProblems(c) {
  const t = P.pick, errs = { tax: [], launch_guard: [], buyback: [], custom: [] };
  if (t === "tax") {
    const b = pct("taxBuy"), s = pct("taxSell"), m = pct("taxMax");
    if (![b, s, m].every(num)) errs.tax.push("Type the taxes as numbers.");
    else {
      if (m > core.maxHookBps) errs.tax.push("The ceiling is " + fmtPct(m) + ". The most is " + fmtPct(core.maxHookBps, 0) + ".");
      if (b > m || s > m) errs.tax.push("The buy tax and the sell tax must stay under the ceiling of " + fmtPct(m) + ".");
    }
    const tr = $("taxTreasury").value.trim();
    if (tr && !isKey(tr)) errs.tax.push("The treasury wallet is not a valid address.");
  } else if (t === "launch_guard") {
    const f = pct("guardFee"), min = Number(String($("guardMin").value).replace(",", "."));
    if (!num(f)) errs.launch_guard.push("Type the start fee as a number.");
    else if (f <= c.lp) errs.launch_guard.push("The start fee must be above the pool fee of " + fmtPct(c.lp) + ".");
    else if (f > core.maxOverrideBps) errs.launch_guard.push("The start fee is " + fmtPct(f) + ". The most is " + fmtPct(core.maxOverrideBps, 0) + ".");
    if (!isFinite(min) || min <= 0) errs.launch_guard.push("Type the window in minutes.");
    else if (minutesToSlots(min) > 10_800) errs.launch_guard.push("The window is " + fmtSpan(min * 60) + ". The most is 72 min.");
  } else if (t === "buyback") {
    const b = pct("bbBuy"), s = pct("bbSell"), m = sol("bbMin");
    if (![b, s].every(num)) errs.buyback.push("Type the shares as numbers.");
    else if (b > core.maxHookBps || s > core.maxHookBps) errs.buyback.push("A share is above " + fmtPct(core.maxHookBps, 0) + ", the most a hook can take.");
    if (!m || m <= 0n) errs.buyback.push("Type the minimum in SOL.");
    else if (m > H.MAX_BUYBACK_MIN_QUOTE) errs.buyback.push("The minimum cannot be above " + fmtSol(H.MAX_BUYBACK_MIN_QUOTE) + " SOL.");
  } else if (t === "custom") {
    const tr = $("customTreasury").value.trim();
    if (tr && !isKey(tr)) errs.custom.push("The treasury owner is not a valid address.");
  }
  for (const k of Object.keys(errs)) $(k + "Err").replaceChildren(...errs[k].map((x) => el("span", { text: x })));
  const all = Object.values(errs).flat();
  return { count: all.length, first: all[0] || "" };
}
function review(c) {
  const r = reviewOf(c), pr = hookProblems(c);
  if (pr.count) r.problems = "Change what is marked under The hook before you launch.";
  return r;
}
function reviewOf(c) {
  const t = P.pick;
  const slots = minutesToSlots(Number(String($("guardMin").value).replace(",", ".")) || 0);
  $("guardSlots").textContent = fmtInt(slots) + " slots at 400 ms";
  if (t === "tax") {
    const b = pct("taxBuy"), s = pct("taxSell"), m = pct("taxMax");
    const q = num(b) ? core.quoteFirst(c, Math.min(b, core.maxHookBps)) : null;
    return {
      buy: core.side(num(b) ? [["Tax", "to the treasury wallet", b]] : [], num(b) ? b : 0),
      sell: core.side(num(s) ? [["Tax", "to the treasury wallet", s]] : [], num(s) ? s : 0),
      notes: ["Each fee is taken from what the one before it left, so a trade pays a little less than the sum.", num(m) ? "The owner of the tax can change both taxes up to the ceiling of " + fmtPct(m) + ", or renounce and freeze them. The ceiling never changes." : ""].filter(Boolean),
      first: q ? { rows: core.firstRows(q, c, "Tax " + fmtPct(b), ""), note: "Your first buy pays the buy tax like any other buy." } : null,
      rentNote: "The rent includes the treasury's wrapped SOL account when it does not exist yet.",
    };
  }
  if (t === "launch_guard") {
    const f = pct("guardFee");
    const ok = num(f) && f > c.lp && slots > 0;
    const q = ok ? core.quoteFirst(c, 0, Math.min(f, core.maxOverrideBps)) : null;
    return {
      buy: core.side(), sell: core.side(),
      notes: [ok ? "For the first " + fmtSpan(slotsToSeconds(slots)) + " a buy pays a higher pool fee. It starts at " + fmtPct(f) + " and falls to " + fmtPct(c.lp) + ". A buy in the first slot pays " + fmtPct(core.protocol + f) + " in total. Sells are never touched." : "Type a start fee above the pool fee and a window in minutes.", "Nobody can add liquidity until the window is over."],
      first: q ? { rows: core.firstRows(q, c, "", "the start fee"), note: "Your first buy is the first trade of the pool. It pays the start fee in full." } : null,
    };
  }
  if (t === "buyback") {
    const b = pct("bbBuy"), s = pct("bbSell");
    // what one buyback run may spend on a coin with these shares and this pool fee, by the SDK's rule
    $("bbRun").textContent = plat && num(b) && num(s)
      ? "With these shares and this pool fee, one run spends up to " + fmtPct(H.buybackCapBps({ buyBps: b, sellBps: s }, plat, c.lp)) + " of the pool's SOL. The slice follows the fees of a coin and is never above " + fmtPct(H.MAX_BURN_CAP_BPS) + ". A large treasury takes several runs."
      : "";
    const q = num(b) ? core.quoteFirst(c, Math.min(b, core.maxHookBps)) : null;
    return {
      buy: core.side(num(b) ? [["Buyback", "buys the coin and burns it", b]] : [], num(b) ? b : 0),
      sell: core.side(num(s) ? [["Buyback", "buys the coin and burns it", s]] : [], num(s) ? s : 0),
      notes: ["Each fee is taken from what the one before it left, so a trade pays a little less than the sum."],
      first: q ? { rows: core.firstRows(q, c, "Buyback " + fmtPct(b), ""), note: "Your first buy pays the buy share like any other buy." } : null,
    };
  }
  if (t === "custom") {
    const flags = C.check && C.check.manifest ? C.check.manifest.flags : 0;
    const takes = !!(flags & H.FLAGS.TAKE_HOOK_FEE), moves = !!(flags & H.FLAGS.OVERRIDE_FEE);
    const extra = takes ? [["Hook fee", "to the hook's treasury", "up to " + fmtPct(core.maxHookBps)]] : [];
    const total = takes || moves ? "up to " + fmtPct(core.protocol + (moves ? Math.max(c.lp, core.maxOverrideBps) : c.lp) + (takes ? core.maxHookBps : 0)) : "";
    const notes = [];
    if (!C.check) notes.push("Paste the program id of a hook, or pick one from the list. The review then shows what the hook may add to a trade.");
    else if (C.check.notApproved) notes.push(NOT_REVIEWED);
    else if (!C.check.manifest) notes.push("This program has no manifest, so the pool would refuse it.");
    else {
      if (moves) notes.push("This hook can change the pool fee on a trade, up to " + fmtPct(core.maxOverrideBps) + ".");
      notes.push("A hook can refuse a trade it is called on. The pool checks that its code is frozen. It does not check what the code does.");
    }
    // the payload carries the real SOL only; the form cannot know what the hook reads (review note F5)
    if (c.curve) notes.push("On the curve, a hook that works out a price from what the pool sends it must add the pool's virtual SOL. This form cannot check what a hook reads.");
    return {
      buy: core.side(extra, 0, total), sell: core.side(extra, 0, total), notes,
      rentNote: "A custom hook can create accounts of its own at launch. Their rent comes on top of this.",
      devBuyNote: c.dev > 0n ? "With a custom hook your first buy accepts whatever the hook returns, within the platform caps." : "",
    };
  }
  return { buy: core.side(), sell: core.side(), notes: ["Pick a hook. The review then shows what it adds to a trade."] };
}

core.run({
  template: () => P.pick,
  // the buy rate the first buy pays, for "graduates in the launch transaction" (the SDK's rule)
  firstBuyRates: () => ({ tax: { buyBps: pct("taxBuy") }, buyback: { buyBps: pct("bbBuy") } }),
  kind: () => (P.pick === "custom" ? "Custom hook" : P.pick ? "Platform hook" : ""),
  rent() {
    const t = P.pick;
    if (t === "tax") return costOf("tax") + core.treasuryRent("taxTreasury");
    if (t === "custom") return costOf("none") + (C.check && C.check.manifest && (C.check.manifest.flags & H.FLAGS.TAKE_HOOK_FEE) ? core.treasuryRent("customTreasury") : 0n);
    return costOf(t);
  },
  review,
  validate(out) {
    const t = out.template;
    if (!t) throw new Error("Pick a hook first.");
    const pr = hookProblems(core.values());
    if (pr.count) throw new Error("Check the hook. " + pr.first);
    if (t === "tax") {
      const b = pct("taxBuy"), s = pct("taxSell"), m = pct("taxMax");
      if (![b, s, m].every(num)) throw new Error("Tax percentages must be numbers.");
      if (m > core.maxHookBps) throw new Error("The tax ceiling cannot be above " + fmtPct(core.maxHookBps, 0) + ".");
      if (b > m || s > m) throw new Error("Buy and sell taxes must stay under the ceiling.");
      let treasury;
      const tr = $("taxTreasury").value.trim();
      if (tr) { try { treasury = new PublicKey(tr); } catch (_) { throw new Error("The treasury wallet is not a valid address."); } }
      out.tax = { buyBps: b, sellBps: s, maxBps: m, treasury };
    } else if (t === "launch_guard") {
      const f = pct("guardFee");
      const min = Number(String($("guardMin").value).replace(",", "."));
      if (!Number.isInteger(f) || f <= out.lpFeeBps) throw new Error("The start fee must be above the pool fee.");
      if (f > core.maxOverrideBps) throw new Error("The start fee cannot be above " + fmtPct(core.maxOverrideBps, 0) + ".");
      if (!isFinite(min) || min <= 0) throw new Error("Give the guard a window in minutes.");
      const slots = minutesToSlots(min);
      if (slots > 10_800) throw new Error("The guard window cannot be longer than 72 minutes (10,800 slots).");
      out.guard = { guardSlots: BigInt(slots), startFeeBps: f };
    } else if (t === "buyback") {
      const b = pct("bbBuy"), s = pct("bbSell");
      const m = sol("bbMin");
      if (![b, s].every(num)) throw new Error("Buyback shares must be numbers.");
      if (b > core.maxHookBps || s > core.maxHookBps) throw new Error("Buyback shares cannot be above " + fmtPct(core.maxHookBps, 0) + ".");
      if (!m || m <= 0n) throw new Error("Give the buyback a minimum in SOL.");
      if (m > H.MAX_BUYBACK_MIN_QUOTE) throw new Error("The minimum to trigger cannot be above " + fmtSol(H.MAX_BUYBACK_MIN_QUOTE) + " SOL.");
      out.buyback = { buyBps: b, sellBps: s, minQuote: m };
    } else if (t === "custom") {
      let program;
      try { program = new PublicKey($("customId").value.trim()); } catch (_) { throw new Error("Paste the program id of your hook."); }
      let treasuryOwner;
      const tr = $("customTreasury").value.trim();
      if (tr) { try { treasuryOwner = new PublicKey(tr); } catch (_) { throw new Error("The treasury owner is not a valid address."); } }
      out.custom = { program, treasuryOwner };
    }
  },
  /// A program id: wait for its check, refuse what the pool or the launchpad would refuse, and
  /// read what the launcher chose in the hook's own settings fields.
  async before(v) {
    C.settings = null; C.hookSetup = null;
    if (v.template !== "custom") return;
    if (C.checking) await C.checking;
    const c = C.check && C.check.id.equals(v.custom.program) ? C.check : await runCustomCheck();
    if (c && c.notApproved) throw new Error(NOT_REVIEWED);
    // the SDK's own check, the one its launch builder runs, read again right before the launch
    try { await ctx.client.requireHookAllowed(v.custom.program, await ctx.client.platform()); }
    catch (e) { if (e instanceof H.HookApprovalRefusal) throw new Error(NOT_REVIEWED); throw e; }
    if (c && c.accepts && c.ownsCurve) throw new Error("The launchpad does not take a hook that sets the price itself.");
    if (!c || !c.accepts) throw new Error("The pool would refuse this hook. Fix what the check above says first.");
    if (C.setup) C.settings = C.setup.read();
  },
  mint: (v) => (v.template === "custom" && C.mint ? C.mint : null),
  /// A hook with a descriptor: its setup instruction goes into the first transaction.
  async setup(v, dev, mint) {
    C.hookSetup = C.settings ? await C.setup.instructions(dev, mint.publicKey, C.settings) : null;
    if (C.hookSetup) v.custom.setup = C.hookSetup.ixs;
  },
  minOut(v) {
    // a custom hook's answer is unknown here, so its first buy accepts any output
    if (v.template === "custom") return 1n;
    const hookFeeBps = v.template === "tax" ? v.tax.buyBps : v.template === "buyback" ? v.buyback.buyBps : 0;
    const feeOverrideBps = v.template === "launch_guard" ? v.guard.startFeeBps : null;
    return applyBps(H.quoteSwap({ direction: DIRECTION.BUY, amountIn: v.dev, ...core.firstPool(v), lpFeeBps: v.lpFeeBps, protocolFeeBps: plat.protocolFeeBps, hookFeeBps, feeOverrideBps }).amountOut, 100);
  },
  /// The setup is code of the hook, run with this wallet's signature. Simulate the first
  /// transaction before the wallet opens, refuse when the setup takes more than its rent, and
  /// end the transaction with a floor under the wallet's balance (workshop-lib.js guardSetup).
  async guard(v, dev, plan, say) {
    if (!(C.hookSetup && C.hookSetup.ixs.length)) return "";
    say("Simulating");
    const g = await C.setup.guard(dev, plan.createTx, C.hookSetup.ixs, C.hookSetup.own);
    if (!g.ok) throw new Error(g.reason);
    plan.createTx.push(g.floorIx);
    return "A simulation says it takes " + fmtSol(g.takes, 6) + " SOL from your wallet. ";
  },
});

// launch-hook.html?hook=tax (or launch_guard, buyback) opens that platform hook;
// ?hook=<program id> opens the check of that program
{
  const hook = new URLSearchParams(location.search).get("hook");
  if (hook && PLATFORM_HOOKS.includes(hook)) pick(hook);
  else if (hook) {
    let named = "";
    try { named = templateOfProgram(new PublicKey(hook)); } catch (_) {}
    if (PLATFORM_HOOKS.includes(named)) pick(named);
    else { $("customId").value = hook; pick("custom"); setTimeout(runCustomCheck, 0); }
  }
}
listCommunity();
