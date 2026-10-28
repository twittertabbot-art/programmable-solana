// Custom hooks: the hooks somebody else wrote, read from the chain. A card per hook, in the grid
// of Explore: what the chain lets it do, what its author says it does, whether that text is
// pinned, its coins and what it collected, and the mark of a hook Programmable approved.
//
// While the platform's approval rule is on, the grid lists the approved programs, also those
// without a coin yet, each with its mark, its report and a launch button. Outside hooks that
// have coins but are not on the list go into a closed section "Not reviewed", without a launch
// button. While the rule is off, every frozen hook with a coin is listed, and approved ones
// carry the mark.
import { boot, ctx, $, el, fmtSol, fmtInt, short, monogram, rpcFailText } from "./common.js";
import { workshopHooks, hookName, powerShort, descriptorLabel, loadReviewed, approvalOf, reviewMark, reportLine } from "./workshop-lib.js";

await boot("workshop.html");
$("rpcName").textContent = ctx.rpcHost;
/// hooks: the main grid. unreviewed: outside hooks with coins that are not approved while the rule is on.
const S = { hooks: null, unreviewed: [], plat: null, approval: null, reviewed: new Map(), loading: false };

/// The words a card shows when its author published no descriptor in use.
const NO_WORDS = { none: "Its author published no description.", refused: "Its author's description was refused. Its page says why.", unreachable: "Its author's description could not be loaded." };

function card(h, kind) {
  const x = h.descriptor, d = x.state === "ok" ? x.d : null;
  const name = hookName(h) || "Unnamed hook";
  const power = powerShort(h.flags, S.plat);
  const label = descriptorLabel(x);
  const img = el("img", { alt: "", loading: "lazy" });
  img.src = monogram(name);
  const approved = S.approval.approved.has(h.id);
  const r = S.reviewed.get(h.id) || null;
  return el("article", { class: "coin-card ws-card", "data-hook": h.id, "data-descriptor": x.state, "data-approved": approved ? "yes" : "no" },
    el("span", { class: "coin-art" }, img),
    el("div", { class: "coin-body" },
      el("div", { class: "coin-title" },
        el("a", { class: "coin-link", href: "workshop-hook.html?id=" + h.id, text: name }),
        el("span", { class: "coin-pair mono", text: short(h.id, 4), title: h.id })),
      approved ? el("div", { class: "ws-mark" }, reviewMark(r)) : kind === "unreviewed" ? el("div", { class: "ws-mark" }, el("span", { class: "badge warn", text: "Not reviewed" })) : null,
      // the chain's voice: what the pool lets it do, from its flags
      el("div", { class: "coin-kind ws-power" }, el("b", { text: power.main }), power.runs ? ", " + power.runs : ""),
      // the author's voice: the summary of its description
      el("p", { class: "ws-says" + (d ? "" : " none"), text: d ? d.summary : NO_WORDS[x.state] || NO_WORDS.none }),
      // whether that text can still change; a card without a description in use says so in the line above
      d ? el("p", { class: "ws-desc", "data-pin": x.pinned ? "yes" : "no", text: label }) : null,
      el("div", { class: "coin-figs" },
        el("span", null, el("span", { class: "l", text: "Coins" }), el("span", { class: "v launches", text: fmtInt(h.launches) })),
        el("span", { class: "ws-collected" }, el("span", { class: "l", text: "Collected" }), el("span", { class: "v collected", text: fmtSol(h.collected, 4) + " SOL" }))),
      // an approved hook while the rule is on: its report and the way to launch on it
      kind === "approved" ? el("div", { class: "ws-acts" },
        el("a", { class: "btn btn-sm ws-launch", href: "launch-hook.html?hook=" + h.id, text: "Launch a coin" }),
        reportLine(r)) : approved ? el("div", { class: "ws-acts" }, reportLine(r)) : null));
}

/// The text a hook is found by: its name, program id, author and summary.
const haystack = (h) => [hookName(h), h.id, h.descriptor.state === "ok" ? h.descriptor.d.author : "", h.descriptor.state === "ok" ? h.descriptor.d.summary : ""].join(" ").toLowerCase();

function render() {
  const box = $("hooks");
  if (!S.hooks) return;
  const on = S.approval.required;
  const q = $("search").value.trim().toLowerCase();
  const shown = q ? S.hooks.filter((h) => haystack(h).includes(q)) : S.hooks;
  const n = (k) => (k === 1 ? "1 hook" : k + " hooks");
  const what = on ? (k) => (k === 1 ? "1 approved hook" : k + " approved hooks") : n;
  $("count").textContent = q ? shown.length + " of " + what(S.hooks.length) : what(S.hooks.length);
  // the hooks that are not reviewed, in their own closed section
  const rest = q ? S.unreviewed.filter((h) => haystack(h).includes(q)) : S.unreviewed;
  $("unreviewed").hidden = !on || !S.unreviewed.length;
  $("unreviewedCount").textContent = q ? rest.length + " of " + S.unreviewed.length : String(S.unreviewed.length);
  $("unreviewedHooks").replaceChildren(...rest.map((h) => card(h, "unreviewed")));
  if (!S.hooks.length) {
    box.replaceChildren(el("div", { class: "explore-state ws-empty" },
      el("p", { text: on ? "No hook from another builder is approved yet. Programmable reviews a hook on request. Once approved, it is listed here and anyone can launch a coin on it." : "No hook from another builder has a coin yet. A hook is listed here from its first coin." }),
      el("a", { class: "btn btn-primary", href: "review-hook.html", text: "Get your hook reviewed" })));
    return;
  }
  if (!shown.length) { box.replaceChildren(el("div", { class: "explore-state ws-empty" }, el("p", { text: "No hook matches that search." }))); return; }
  box.replaceChildren(...shown.map((h) => card(h, on ? "approved" : "listed")));
}

async function load() {
  if (S.loading) return;
  S.loading = true;
  const btn = $("refresh"); btn.disabled = true;
  try {
    // the platform is read again on every load: the rule and the list can change at any time
    const [plat, reviewed] = await Promise.all([ctx.client.platform(), loadReviewed()]);
    ctx.platform = plat; S.plat = plat; S.reviewed = reviewed;
    S.approval = approvalOf(plat);
    const on = S.approval.required;
    $("lede").textContent = on
      ? "Hooks other people built. Programmable reviewed each one and put it on the approved list. Only an approved hook can open a pool."
      : "Hooks other people built and froze. A hook is listed from its first coin. The ones Programmable reviewed carry its mark.";
    // approved programs without a coin yet are listed too, so a launcher can use a newly approved hook
    const all = await workshopHooks(undefined, [...S.approval.approved]);
    const isApproved = (h) => S.approval.approved.has(h.id);
    if (on) {
      S.hooks = all.filter(isApproved);
      S.unreviewed = all.filter((h) => !isApproved(h) && h.launches > 0);
    } else {
      // today's listing: every frozen hook from its first coin
      S.hooks = all.filter((h) => h.launches > 0);
      S.unreviewed = [];
    }
    render();
  } catch (e) {
    $("hooks").replaceChildren(el("div", { class: "explore-state ws-empty bad" }, el("p", { text: rpcFailText(e) })));
  } finally {
    S.loading = false; btn.disabled = false;
  }
}

$("refresh").addEventListener("click", load);
$("search").addEventListener("input", render);
await load();
