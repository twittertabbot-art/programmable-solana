// The report pages in this folder. Each page sets <base href="../">, so the shared header, the
// footer, the deployments file and every link of the site resolve from the site's root as on any
// other page. This file starts the shell and fills in what the chain says now: the platform's
// caps, the program's link to an explorer, and, on the list of reports, the approved hooks.
import { boot, ctx, H, el, explorer, short, fmtPct, platform } from "../common.js";
import { loadReviewed } from "../workshop-lib.js";

await boot("reviews");

// the list of sections beside a report, from its headings. With <base href="../"> a bare "#id"
// would lead to the site's root, so each link carries the page's own path.
const toc = document.getElementById("toc");
if (toc) toc.replaceChildren(...[...document.querySelectorAll(".doc h2[id]")].map((h) =>
  el("li", null, el("a", { href: location.pathname + "#" + h.id, text: h.textContent }))));

// a program id in the text: a link to the explorer of the cluster this site runs on
for (const n of document.querySelectorAll("[data-program]")) {
  const id = n.dataset.program;
  n.replaceChildren(el("a", { class: "link mono", href: explorer("account", id), target: "_blank", rel: "noopener", title: id, text: n.dataset.short ? short(id, 6) : id }));
}

try {
  const p = await platform();
  // the platform's caps, read live: the pool cuts every answer of a hook to them
  if (p) for (const n of document.querySelectorAll("[data-plat]")) n.textContent = fmtPct(p[n.dataset.plat]);
  // the list of reports: the hooks Programmable approved, each with its report when the registry has one
  const box = document.getElementById("approvedList");
  if (box && p) {
    const reviewed = await loadReviewed();
    // each hook's name: the registry's, else the one its manifest carries on chain
    const manifests = p.approvedHooks.length ? await ctx.connection.getMultipleAccountsInfo(p.approvedHooks.map((k) => H.pda.manifest(k))).catch(() => []) : [];
    const rows = p.approvedHooks.map((k, i) => {
      const id = k.toBase58(), r = reviewed.get(id) || null;
      let onChain = "";
      try { onChain = manifests[i] ? H.decodeHookManifest(new Uint8Array(manifests[i].data)).name : ""; } catch (_) {}
      return el("li", null, el("a", { href: r && r.report ? r.report : "workshop-hook.html?id=" + id, "data-approved": id },
        el("b", { text: (r && r.name) || onChain || "Approved hook" }),
        el("span", { text: r && r.report ? "Its report" + (r.date ? ", " + r.date : "") + "." : "Report coming. This opens its page in Custom hooks." }),
        el("span", { class: "mono", text: id })));
    });
    box.replaceChildren(...rows);
    document.getElementById("approvedEmpty").hidden = rows.length > 0;
    document.getElementById("approvedCluster").textContent = ctx.cluster;
  }
} catch (_) {}
