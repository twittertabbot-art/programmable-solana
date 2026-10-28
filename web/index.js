// Explore: every coin as a card, from the watcher's market.json when the site has a watcher
// (no RPC), read from the chain otherwise. Search, filters, paging.
import {
  boot, ctx, H, $, el, svg, currentSlot, coinMeta, setImage, monogram, fmtCompact, fmtUnits, timeAgo, slotAge,
  templateOf, rulesTags, rulesFacts, mapLimit, toNumber, isPegged, marketPools, rpcFailText, fmtAmount,
} from "./common.js";
import { strictSdk } from "./launch-strict.js";

await boot("index.html");
const QUOTE_DEC = 9;
const PAGE = 20;
// S.start filters by how the pool started: "all", "open" (on the curve now), "graduated", "none" (seeded)
const S = { sort: "newest", kind: "all", start: "all", q: "", page: 0, rows: null, slot: 0, updatedAt: 0, loading: false, error: "" };
const STRICT = strictSdk();

/// What a coin runs, as the label on its card. Nothing for a coin without a hook.
function kindOf(pool, template, facts) {
  if (!pool.hasHook) return "";
  if (template === "rules") return facts && STRICT.isStrict(facts.cfg) ? "Strict" : "Modules";
  if (template === "collectible") return "Collectible";
  if (template === "custom") return "Custom hook";
  return "Platform hook";
}
/// A link from a coin's metadata, when it is a web address.
const web = (v) => (typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? v.trim() : "");
const LINKS = [
  ["website", "Website", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z"],
  ["twitter", "X", "M5 4l14 16M19 4L5 20"],
  ["telegram", "Telegram", "M21 4L3 11l6 2.5L11 20l3-4 4.5 3zM9 13.5L21 4"],
];

// ---- loading --------------------------------------------------------------------------------------

async function load() {
  if (S.loading) return;
  S.loading = true; S.error = "";
  const btn = $("refresh"); btn.disabled = true; btn.textContent = "Refreshing";
  if (!S.rows) render();
  try {
    // with a watcher, its market.json has every coin and what a card shows: no RPC at all.
    // Without one (or when it does not answer), the chain: every pool, then each coin's name and mint.
    const market = await marketPools().catch(() => null);
    let pools, details, facts;
    if (market) {
      pools = market.rows.map((r) => r.pool);
      S.slot = market.slot;
      details = market.rows.map((r) => ({ md: r.md, mint: r.mint, meta: r.meta }));
      facts = new Map(market.rows.filter((r) => r.rules).map((r) => [r.pool.address.toBase58(), r.rules]));
    } else {
      const [all, slot] = await Promise.all([ctx.client.allPools(), currentSlot()]);
      pools = all;
      S.slot = slot;
      details = await mapLimit(pools, 6, async (p) => {
        const [md, mint] = await Promise.all([ctx.client.metadata(p.baseMint), ctx.client.mint(p.baseMint)]);
        return { md, mint };
      });
      // the coins with modules: which ones each has, to say it on the card
      facts = await rulesFacts(pools).catch(() => new Map());
    }
    const old = new Map((S.rows || []).map((r) => [r.addr, r]));
    S.rows = pools.map((p, i) => {
      const d = details[i] || {};
      const dec = d.mint ? d.mint.decimals : 6;
      const price = H.spotPrice(p, dec, QUOTE_DEC);
      const supply = d.mint ? toNumber(d.mint.supply, dec) : 0;
      const name = (d.md && d.md.name) || "Unnamed coin";
      const symbol = (d.md && d.md.symbol) || "";
      const addr = p.address.toBase58();
      const prev = old.get(addr);
      const template = templateOf(p);
      const f = facts.get(addr) || null;
      const kind = kindOf(p, template, f);
      // for a coin with modules the card names them; a platform or custom hook is named by what it may do
      const tags = p.hasHook ? rulesTags(p.hookFlags, template, true, isPegged(p), f).filter((t) => t !== "rules" && t !== "no rule on" && t !== "sells: never called") : [];
      // a coin on the curve: its state, and what it has raised of its target while it is open
      const curve = H.curveStateName(p.curveState);
      const progress = curve === "open" && d.mint ? H.curveProgress(p, d.mint.supply) : null;
      return {
        pool: p, addr, name, symbol, uri: d.md ? d.md.uri : "", mcap: price * supply, kind, tags, curve, progress,
        // the picture and the links: from the watcher's market when it read them, else from the coin's own file below
        meta: d.meta !== undefined ? d.meta : prev ? prev.meta : undefined,
        search: (name + " " + symbol + " " + p.baseMint.toBase58() + " " + addr).toLowerCase(),
      };
    });
    S.updatedAt = Date.now();
    render();
    // pictures and links come from each coin's metadata file, a few at a time
    mapLimit(S.rows, 4, async (r) => {
      if (r.meta === undefined) r.meta = (await coinMeta(r.uri)) || null;
      const card = document.querySelector('.coin-card[data-pool="' + r.addr + '"]');
      if (card) fillMeta(card, r);
    });
  } catch (e) {
    S.error = rpcFailText(e);
    render();
  } finally {
    S.loading = false; btn.disabled = false; btn.textContent = "Refresh";
  }
}

// ---- rendering -------------------------------------------------------------------------------------

function shown() {
  const q = S.q.trim().toLowerCase();
  let rows = S.rows.filter((r) => (!q || r.search.includes(q)) && (S.kind === "all" || r.kind === S.kind || (S.kind === "Modules" && r.kind === "Strict")) && (S.start === "all" || r.curve === S.start));
  if (S.sort === "mcap") rows.sort((a, b) => b.mcap - a.mcap);
  else if (S.sort === "volume") rows.sort((a, b) => (b.pool.volumeQuoteTotal > a.pool.volumeQuoteTotal ? 1 : b.pool.volumeQuoteTotal < a.pool.volumeQuoteTotal ? -1 : 0));
  else if (S.sort === "liquidity") rows.sort((a, b) => (b.pool.reserveQuote > a.pool.reserveQuote ? 1 : b.pool.reserveQuote < a.pool.reserveQuote ? -1 : 0));
  else rows.sort((a, b) => (b.pool.createdSlot > a.pool.createdSlot ? 1 : b.pool.createdSlot < a.pool.createdSlot ? -1 : 0));
  return rows;
}
/// The picture and the link icons of a card, once the coin's metadata file is read.
function fillMeta(card, r) {
  const m = r.meta || {};
  const image = typeof m.image === "string" && /^(https?:\/\/|data:image\/)/i.test(m.image.trim()) ? m.image.trim() : "";
  if (image) setImage(card.querySelector(".coin-art img"), image, r.symbol);
  const ext = m.extensions && typeof m.extensions === "object" ? m.extensions : {};
  const links = LINKS.map(([key, label, icon]) => { const href = web(ext[key] || m[key]); return href ? el("a", { href, target: "_blank", rel: "noopener noreferrer", "aria-label": label + " of " + r.name, title: label }, svg(icon)) : null; }).filter(Boolean);
  card.querySelector(".coin-links").replaceChildren(...links);
}
/// The curve on a card: "Curve" with what the pool has raised of its target and a thin bar while
/// it is open, a quiet "Graduated" after. Nothing for a seeded pool.
function curveRow(r) {
  if (r.curve === "open" && r.progress) {
    const p = r.progress;
    // "raised" is said by the title: on a phone the card is two to a row and the line must stay one line
    const said = fmtAmount(p.raised, QUOTE_DEC, 2) + " of " + fmtUnits(p.target, QUOTE_DEC, 2) + " SOL";
    return el("div", { class: "coin-curve", "data-curve": "open", title: "On the curve. Raised " + said + "." },
      el("div", { class: "coin-curve-top" }, el("span", { class: "curve-mark", text: "Curve" }), el("span", { class: "coin-raised", text: said })),
      el("div", { class: "curve-bar thin", "aria-hidden": "true" }, el("span", { style: "width:" + Math.min(100, p.raisedBps / 100) + "%" })));
  }
  if (r.curve === "graduated") return el("div", { class: "coin-curve", "data-curve": "graduated" }, el("div", { class: "coin-curve-top" }, el("span", { class: "curve-mark done", text: "Graduated" })));
  return null;
}
function card(r) {
  const img = el("img", { alt: "", loading: "lazy" });
  img.src = monogram(r.symbol);
  const node = el("article", { class: "coin-card", "data-pool": r.addr, "data-kind": r.kind, "data-tags": r.tags.join(",") },
    el("span", { class: "coin-art" }, img),
    el("div", { class: "coin-body" },
      el("div", { class: "coin-title" }, el("a", { class: "coin-link", href: "coin.html?pool=" + r.addr, text: r.name }), el("span", { class: "coin-pair", text: (r.symbol || "?") + " / SOL" })),
      el("div", { class: "coin-kind", title: r.tags.join(", ") || null }, r.kind ? el("b", { text: r.kind }) : null, r.kind === "Modules" || r.kind === "Strict" ? r.tags.join(", ") : ""),
      curveRow(r),
      el("div", { class: "coin-figs" },
        el("span", null, el("span", { class: "l", text: "Market cap" }), el("span", { class: "v", text: fmtCompact(r.mcap) + " SOL" })),
        el("span", { class: "coin-age", text: timeAgo(slotAge(r.pool.createdSlot, S.slot)) }))),
    el("div", { class: "coin-links" }));
  if (r.meta !== undefined) fillMeta(node, r);
  return node;
}
function state(text, withLaunch) {
  $("grid").hidden = true;
  const e = $("empty"); e.hidden = false;
  e.replaceChildren(...[el("div", { text }), withLaunch ? el("a", { class: "btn btn-primary", href: "launch.html", text: "Launch a token" }) : null].filter(Boolean));
}
function render() {
  const grid = $("grid"), prev = $("prevPage"), next = $("nextPage");
  prev.disabled = next.disabled = true;
  $("pageSay").textContent = "";
  if (S.error) return state(S.error, false);
  if (!S.rows) {
    // the first read: ten quiet placeholders where the cards will be
    grid.hidden = false; $("empty").hidden = true;
    grid.replaceChildren(...Array.from({ length: 10 }, () => el("div", { class: "coin-card ghost", "aria-hidden": "true" }, el("span", { class: "coin-art" }), el("div", { class: "coin-body" }, el("span", { class: "bar" }), el("span", { class: "bar short" })))));
    return;
  }
  if (!S.rows.length) return state("No coin has been launched here yet.", true);
  const rows = shown();
  if (!rows.length) return state("No coin matches.", false);
  const pages = Math.ceil(rows.length / PAGE);
  S.page = Math.min(S.page, pages - 1);
  grid.hidden = false; $("empty").hidden = true;
  grid.replaceChildren(...rows.slice(S.page * PAGE, S.page * PAGE + PAGE).map(card));
  prev.disabled = S.page === 0; next.disabled = S.page >= pages - 1;
  $("pageSay").textContent = rows.length + (rows.length === 1 ? " coin. " : " coins. ") + "Page " + (S.page + 1) + " of " + pages + ".";
}

// ---- controls ---------------------------------------------------------------------------------------

const again = () => { S.page = 0; if (S.rows) render(); };
for (const [box, key] of [["sort", "sort"], ["kind", "kind"], ["start", "start"]]) for (const b of $(box).querySelectorAll("button")) b.addEventListener("click", () => {
  S[key] = b.dataset[key];
  for (const x of $(box).querySelectorAll("button")) x.setAttribute("aria-pressed", x === b ? "true" : "false");
  again();
});
$("search").addEventListener("input", (e) => { S.q = e.target.value; again(); });
$("filtersBtn").addEventListener("click", () => {
  const open = $("filters").hidden;
  $("filters").hidden = !open;
  $("filtersBtn").setAttribute("aria-expanded", open ? "true" : "false");
});
$("prevPage").addEventListener("click", () => { if (S.page > 0) { S.page--; render(); window.scrollTo({ top: 0 }); } });
$("nextPage").addEventListener("click", () => { S.page++; render(); window.scrollTo({ top: 0 }); });
$("refresh").addEventListener("click", load);
setInterval(() => { if (S.updatedAt) $("updated").textContent = "Updated " + timeAgo((Date.now() - S.updatedAt) / 1000); }, 1000);

await load();
