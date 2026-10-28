// Hooks page: the "pick your hook" panel (live flags and pool counts from the chain) and the checker.
import { boot, ctx, H, $, el, short, explorer, checkHook, checkLines, TEMPLATE_LABEL, templateOfProgram, fmtPct, fmtSpan, slotsToSeconds, platform, flagSentences, svg, rpcFailText, allPools as poolsList } from "./common.js";
import { TEMPLATE_REPORTS } from "./workshop-lib.js";

await boot("hooks.html");
const { PublicKey } = H;

// ---- pick your hook ---------------------------------------------------------------------------------

/// The share of the supply that has to be staked before a rules coin pays its stakers.
const ELIGIBLE = fmtPct(10_000 / Number(H.RULES_ELIGIBLE_DIVISOR));
/// A buyback or a burn buys against a price the pool had this long ago.
const RUN_WAIT = H.BURN_INTERVAL_SLOTS + " slots";
const PICKS = {
  rules: {
    title: "Launch rules", program: H.PROGRAMS.hook_rules, fallbackFlags: 13125,
    text: [
      "The launcher switches on the rules a coin should have and sets their numbers. They are fixed at launch. Nobody can change one afterwards, because the program has no instruction that does.",
      "There are six rules. A sniper fee makes buys pay a high pool fee in the first minutes, and that fee stays in the pool. A creator fee sets a share of every trade aside for the launcher. Rewards pay a share of every trade, in SOL, to wallets that stake the coin. A burn collects a share of every trade, buys the coin with it a slice at a time, and burns what it buys. A buy limit caps what one buy can spend in the first minutes. A creator lock holds the launcher's first buy in a lock account until a date.",
      "The three shares each have one rate for buys and one for sells. The coin stays a normal Solana coin. The rules apply to trades in its pool, and sending the coin from wallet to wallet is free.",
    ],
    more: {
      title: "What the rules do not do",
      text: [
        ["Rewards.", "They go to wallets that stake the coin on its page, not to every holder. While less than " + ELIGIBLE + " of the supply is staked, that share buys and burns the coin instead. Staked coins can be taken out about " + fmtSpan(slotsToSeconds(H.UNSTAKE_DELAY_SLOTS)) + " after the wallet's last stake."],
        ["Buy limit.", "It is per trade. A wallet can split a large buy into several."],
        ["Creator lock.", "It holds the coins that were put into the lock account, and the coin page shows that account. It says nothing about coins the launcher buys later or holds in another wallet."],
        ["Sniper fee.", "The launcher's own first buy pays it too. Nobody can add liquidity while it runs. Taking liquidity out always works."],
        ["Burn.", "A run buys against a price the pool had at least " + RUN_WAIT + " earlier, and it waits while the price climbs. A large pot takes several runs."],
      ],
    },
    chips: ["Platform template", "Fixed at launch", "Rewards in SOL for stakers", "The coin stays a normal coin"],
  },
  tax: {
    title: "Tax to treasury", program: H.PROGRAMS.hook_tax, fallbackFlags: 12865,
    text: "A share of every buy and every sell, in SOL, goes to a wallet you choose at launch. It collects as wrapped SOL in that wallet's wrapped SOL account, and the owner takes it from the coin page. The ceiling is fixed forever. Under it you can lower or raise the taxes from the coin page, or renounce and freeze them. The hook cannot touch the price or the pool fee.",
    chips: ["Platform template", "Taxes adjustable under a fixed ceiling"],
  },
  launch_guard: {
    title: "Launch guard", program: H.PROGRAMS.hook_launch_guard, fallbackFlags: 4421,
    text: "Buys pay a high fee in the first minutes after launch. The fee falls every slot down to the pool fee and stays in the pool as liquidity, so nobody collects it. Nobody can add liquidity while the window runs. The hook is never called on a sell. Once the window is over the pool behaves like one without a hook.",
    chips: ["Platform template", "Never called on sells", "Fee stays in the pool"],
  },
  buyback: {
    title: "Buyback and burn", program: H.PROGRAMS.hook_buyback, fallbackFlags: 12865,
    text: "A share of every trade, in SOL, collects in a treasury only the hook controls. Once it reaches the minimum, anyone can run a buyback. A run buys the coin with a slice of the treasury, and every coin it buys is burned. The slice follows the fees of the coin and is never above " + fmtPct(H.MAX_BURN_CAP_BPS) + " of the pool's SOL, so a large treasury takes several runs. A run buys against a price the pool had at least " + RUN_WAIT + " earlier, so the first call only records the pool. The hook cannot touch the price or the pool fee.",
    chips: ["Platform template", "Anyone can trigger", "Bought coins are burned"],
  },
  collectible: {
    title: "Collectible per buy", program: H.PROGRAMS.hook_collectible, fallbackFlags: 4162,
    text: [
      "Every buy earns the buyer one piece per set amount of coins, up to a maximum per trade. The buy only commits. The hash of a block two slots later decides what each piece looks like, so nobody can know it or pick it in advance, and a later buy cannot re-roll an earlier one. Anyone can reveal a ticket once the block exists. A batch nobody reveals within about three and a half minutes expires and its pieces are common. The one influence left is the block producer of that slot. The buyer mints the pieces in a second transaction.",
      "The pieces are pegged to the coin. A wallet keeps one piece per set amount of coins it holds. What its coins no longer back leaves the wallet. Waiting pieces are dropped first, then minted pieces go from the end of the wallet's list. The wallet orders its list with reorder, so it chooses which piece goes first. A wallet can reorder only while its coins back every piece it holds. The max supply counts the pieces that exist at once, so a burned piece frees its place.",
      "The hook takes no fee and cannot change the price. The pool never calls it on a sell.",
    ],
    // the launcher picks one of two kinds of coin; [lead, rest] draws the lead in bold
    more: {
      title: "Two kinds of coin",
      text: [
        "The launcher picks the kind at launch. It never changes.",
        ["Plain coin.", "A normal Solana coin. No program of ours runs when it moves between wallets. When coins leave a wallet, settle burns the pieces they no longer back. Anyone can call settle, and the site adds it to every sell. A plain send of coins leaves the piece behind, and it burns a few seconds later. A piece moves to another wallet only with send, which moves its coins too."],
        ["Pegged coin.", "A Token-2022 coin whose transfer hook is this program. The program runs inside every transfer of the coin, sells included. A transfer carries one piece for each whole unit it sends, when the receiver has a ticket, took the coins in its normal token account, and holds the coins to back the piece. The other pieces burn. A sell burns them inside the swap. The NFT in the wallet follows in a delivery or a burn that anyone can send."],
        "A pegged coin has costs. Fewer wallets, exchanges and apps support such coins. A wallet app can fail to send it to a wallet that never held it. A plain send to a wallet without a ticket burns the piece. Send on the coin page opens the ticket first. After a transfer made outside this site, the NFT picture in the wallet can follow a few seconds later. The coin trades in one pool only.",
      ],
    },
    chips: ["Platform template", "Takes no fee", "Plain or pegged coin", "Decided by a later block", "Pegged to the coin"],
  },
  custom: {
    title: "Your own hook", program: null, fallbackFlags: null,
    text: "Write the callbacks and test them with the kit. Programmable reviews the code. Once it passes, you deploy that code, publish the manifest and the extra accounts list, and remove the upgrade authority. Programmable then puts the program on the approved list. The launch form reads your manifest, resolves your extra accounts and creates the fee treasury if your flags take a fee. The pool cuts every fee you return down to the platform caps.",
    chips: ["Frozen by you", "Reviewed by Programmable", "Flags from your manifest"],
  },
};
const counts = { rules: 0, tax: 0, launch_guard: 0, buyback: 0, collectible: 0, custom: 0 };
const flagsOf = { rules: null, tax: null, launch_guard: null, buyback: null, collectible: null };
let plat = null;
/// Every pool on the chain, read once for the pick list. The checker looks in it for pools on the hook it reads.
let allPools = null;

async function loadPickData() {
  try {
    const [pools, p] = await Promise.all([poolsList(), platform()]);
    plat = p; allPools = pools;
    for (const pool of pools) if (pool.hasHook) counts[templateOfProgram(pool.hookProgram)] += 1;
    for (const k of ["rules", "tax", "launch_guard", "buyback", "collectible"]) {
      if (!PICKS[k].program) continue;
      const info = await ctx.connection.getAccountInfo(H.pda.manifest(PICKS[k].program));
      if (info) { try { flagsOf[k] = H.decodeHookManifest(new Uint8Array(info.data)).flags; } catch (_) {} }
    }
  } catch (_) {}
  for (const n of document.querySelectorAll("[data-count]")) { const c = counts[n.dataset.count]; n.textContent = c ? c + (c === 1 ? " pool" : " pools") : ""; }
}

function diagram(hookName, variant) {
  const step = (name, sub, hook) => el("div", { class: "flow-step" + (hook ? " hook" : "") }, el("b", { text: name }), el("span", { text: sub }));
  const arrow = (label) => el("div", { class: "flow-arrow" }, svg("M5 12h14M13 6l6 6-6 6"), el("span", { text: label }));
  const steps = variant === "collectible"
    // four stations: the pool calls the hook after the swap, the hook writes the commitment into
    // the ticket, two slots later a reveal fixes the seed, then the buyer mints
    ? [step("Pool", "swap, then after_swap"), arrow("amount out"), step("Hook", "after_swap", true), arrow("commits"), step("Ticket", "N pieces, block S + 2"), arrow("2 slots, then a reveal"), step("Mint", "the buyer creates the NFTs")]
    : [step("Pool", "swap(direction, amount)"), arrow("direction, amount, reserves"), step(hookName.length > 15 ? "Hook" : hookName, "before_swap answers a fee, an override or a curve", true), arrow("the answer, clamped"), step("Pool", "clamps, runs the curve, transfers")];
  const notes = variant === "collectible"
    ? ["The buy commits. The hash of the block at slot S + 2 fixes the seed. Anyone can reveal, then the buyer mints.", "A wallet keeps one piece per unit of coins it holds. A sell burns from the end of its list in the same transaction."]
    : ["A fee above the cap is cut to the cap. A field without its flag fails the swap."];
  return el("div", { class: "diagram" },
    el("div", { class: "flow", role: "img", "aria-label": variant === "collectible" ? "The pool calls the hook after the swap, the hook commits pieces to the ticket, a block two slots later fixes the seed, then the buyer mints" : "The pool calls the hook before the swap, the hook answers, the pool clamps the answer and executes the trade" }, ...steps),
    ...notes.map((t) => el("p", { class: "help", text: t })));
}

function renderPick(key) {
  const p = PICKS[key];
  const panel = $("pickPanel");
  const flags = key === "custom" ? null : (flagsOf[key] !== null ? flagsOf[key] : p.fallbackFlags);
  const sentences = flags === null ? [] : flagSentences(flags, key, null, plat);
  const chips = p.chips.slice();
  if (counts[key]) chips.push(counts[key] + (counts[key] === 1 ? " pool uses it" : " pools use it"));
  if (plat && key !== "custom" && key !== "collectible" && key !== "launch_guard") chips.push("fee cap " + fmtPct(plat.maxHookFeeBps, 0));
  if (plat && (key === "launch_guard" || key === "rules")) chips.push("override cap " + fmtPct(plat.maxFeeOverrideBps, 0));
  panel.replaceChildren(
    el("div", { class: "eyebrow", text: key === "custom" ? "Custom" : "Template" }),
    el("h2", { text: p.title }),
    ...[].concat(p.text).map((t) => el("p", { class: "muted", text: t })),
    ...(p.more ? [el("h3", { style: "margin: 20px 0 10px", text: p.more.title }), ...p.more.text.map((t) => Array.isArray(t) ? el("p", { class: "muted" }, el("b", { text: t[0] }), " " + t[1]) : el("p", { class: "muted", text: t }))] : []),
    el("div", { class: "chips-row" }, ...chips.map((c) => el("span", { class: "chip", text: c }))),
    sentences.length ? el("ul", { class: "sentences" }, ...sentences.map((t) => el("li", { text: t }))) : el("p", { class: "small muted", text: "Your manifest decides the flags. The checker below reads them and turns them into sentences." }),
    diagram(key === "custom" ? "Your hook" : p.title, key),
    el("div", { class: "foot" },
      el("a", { class: "btn btn-primary", href: "launch.html?template=" + key, text: "Launch with this hook" }),
      p.program ? el("a", { class: "link small", href: "hooks.html?id=" + p.program.toBase58(), text: "Check " + short(p.program.toBase58(), 5) }) : el("a", { class: "link small", href: "#checker", text: "Check a program id" }),
      // each of the platform's own hooks has a report, written from its code
      TEMPLATE_REPORTS[key] ? el("a", { class: "link small", "data-report": key, href: TEMPLATE_REPORTS[key], text: "Read its report" }) : null,
      // hooks other people already built are listed on the Custom hooks page; a new one is reviewed first
      key === "custom" ? el("a", { class: "link small", href: "workshop.html", text: "See the hooks other people built" }) : null,
      key === "custom" ? el("a", { class: "link small", href: "review-hook.html", text: "Get your hook reviewed" }) : null),
  );
}

for (const b of $("pickList").querySelectorAll("button")) b.addEventListener("click", () => {
  for (const x of $("pickList").querySelectorAll("button")) x.setAttribute("aria-pressed", x === b ? "true" : "false");
  renderPick(b.dataset.pick);
});
renderPick("rules");
loadPickData().then(() => renderPick(document.querySelector("#pickList button[aria-pressed=true]").dataset.pick));

// ---- checker ---------------------------------------------------------------------------------------

$("try").replaceChildren(
  el("span", { class: "small dim", text: "Try:" }),
  ...[["launch rules", "hook_rules"], ["tax", "hook_tax"], ["launch guard", "hook_launch_guard"], ["buyback", "hook_buyback"], ["collectible", "hook_collectible"]].filter(([, key]) => H.PROGRAMS[key]).map(([label, key]) =>
    el("button", { class: "btn btn-sm", type: "button", text: label, onclick: () => { $("hookId").value = H.PROGRAMS[key].toBase58(); check(); } })));
$("checkBtn").addEventListener("click", check);
$("hookId").addEventListener("keydown", (e) => { if (e.key === "Enter") check(); });
const preset = new URLSearchParams(location.search).get("id");
if (preset) { $("hookId").value = preset; check(); }

function line(ok, text) { return el("li", { class: ok === true ? "yes" : ok === false ? "no" : "" }, el("span", { class: "dot" }), el("span", { text })); }

async function check() {
  const out = $("checkOut");
  let id;
  try { id = new PublicKey($("hookId").value.trim()); } catch (_) { out.replaceChildren(el("p", { class: "bad small", text: "That is not a valid address." })); return; }
  out.replaceChildren(el("p", { class: "small muted", text: "Reading the program" }));
  try {
    const c = await checkHook(id);
    const lines = checkLines(c);
    // the approved list: while the platform's rule is on, a pool takes an outside hook only from it
    let appr = null;
    if (c.exists && c.executable) { try { appr = await ctx.client.hookApproval(id, await ctx.client.platform()); } catch (_) {} }
    if (appr) lines.push({ ok: appr.own ? null : appr.approved ? true : appr.required ? false : null, approval: true,
      text: "Approved list: " + (appr.own ? "not needed (one of the platform's own hooks)." : appr.approved ? "approved." : "not approved." + (appr.required ? " The platform takes an outside hook only from the list." : " The platform does not ask for it today.")) });
    c.accepts = c.accepts && (!appr || appr.allowed);
    const kids = [];
    if (c.exists && c.executable) kids.push(el("div", { class: "verdict " + (c.accepts ? "ok" : "bad"), text: c.accepts ? "A pool would accept this hook." : appr && !appr.allowed ? "A pool would refuse this hook. It is not on the approved list." : "A pool would refuse this hook." }));
    // The verdict is what create_pool reads before it calls the hook. The hook's own code can still
    // refuse that first call, so a hook that no pool runs on yet has not shown that it can be called.
    if (c.accepts) {
      if (!allPools) { try { allPools = await poolsList(); } catch (_) {} }
      if (allPools && !allPools.some((p) => p.hasHook && p.hookProgram.equals(id))) kids.push(el("p", { class: "small muted", id: "checkNoPool", style: "margin: 0 0 10px", text: "No pool has been created on it yet, so nothing shows that the pool can call it. The pool reads what is listed here before its first call, and the hook's own code can still refuse that call." }));
    }
    kids.push(el("ul", { class: "check-list" }, ...lines.map((l) => { const li = line(l.ok, l.text); if (l.approval) li.id = "approvalLine"; return li; })));
    if (appr && !appr.allowed) kids.push(el("p", { class: "small", style: "margin-top:10px" }, "This hook has not been reviewed by Programmable yet, so no coin can launch on it. ", el("a", { class: "link", href: "review-hook.html", text: "Get your hook reviewed" })));
    if (c.manifest) {
      const names = Object.entries(H.FLAGS).filter(([, v]) => (c.manifest.flags & v) !== 0).map(([k]) => k);
      kids.push(el("div", { style: "margin-top:14px" }, el("h4", { text: "Flags in words" }),
        el("ul", { class: "check-list", style: "margin-top:6px" }, ...flagSentences(c.manifest.flags, templateOfProgram(id), null, await platform().catch(() => null)).map((s) => line(null, s))),
        el("p", { class: "small dim mono", style: "margin-top:8px", text: names.join(" ") || "no flags set" }),
        el("p", { class: "small dim", style: "margin-top:4px", text: "Manifest admin: " + (c.manifest.admin ? short(c.manifest.admin.toBase58(), 5) : "none") + ". Flags: " + c.manifest.flags + "." })));
    }
    if (c.exists) kids.push(el("p", { class: "small", style: "margin-top:12px" }, el("a", { class: "link", href: explorer("account", id.toBase58()), target: "_blank", rel: "noopener", text: "Program on Solscan" })));
    // a hook somebody else wrote has a page in Custom hooks: its author's rules, its coins, what it collected
    if (c.manifest && templateOfProgram(id) === "custom") kids.push(el("p", { class: "small", style: "margin-top:6px" }, el("a", { class: "link", href: "workshop-hook.html?id=" + id.toBase58(), text: "Its page in Custom hooks" })));
    // the launchpad refuses one kind of hook a pool would take: one that sets the price itself
    const ownsCurve = !!(c.manifest && (c.manifest.flags & H.FLAGS.OVERRIDE_CURVE));
    if (c.accepts && ownsCurve) kids.push(el("p", { class: "small muted", style: "margin-top:10px", text: "The launchpad does not take a hook that sets the price itself. A pool for it is created with the pool program directly." }));
    else if (c.accepts) kids.push(el("a", { class: "btn btn-sm", style: "margin-top:10px", href: "launch.html?template=" + (templateOfProgram(id) === "custom" ? "custom&hook=" + id.toBase58() : templateOfProgram(id)), text: "Launch with this hook" }));
    out.replaceChildren(...kids);
  } catch (e) {
    out.replaceChildren(el("p", { class: "bad small", text: rpcFailText(e) }));
  }
}
