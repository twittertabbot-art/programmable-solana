// Shared by every page: config and deployment loading, the connection and the SDK client,
// the shell (header, menu with the wallet, footer), formatting, toasts, transaction sending,
// the hook checker and the rules tags.
import * as H from "./js/hookpool.js";
import CONFIG from "./config.js";
import * as Wallet from "./wallet.js";

export { H, Wallet };

const { Connection, PublicKey, VersionedTransaction } = H;
export const SOL_DECIMALS = 9;
export const SLOT_MS = 400;
const BPF_LOADER_2 = new PublicKey("BPFLoader2111111111111111111111111111111111");
const BPF_LOADER_1 = new PublicKey("BPFLoader1111111111111111111111111111111111");

export const ctx = {
  // rpcHost: the RPC's host only. A page prints that, never ctx.rpc: a provider's key sits in
  // the path or the query of the address.
  cluster: "", rpc: "", rpcHost: "", watcherUrl: "", deployment: null,
  connection: null, client: null, platform: null, lookupTable: null,
  slot: 0, slotAt: 0,
};

// ---- boot ---------------------------------------------------------------------------------------

export async function boot(activePage) {
  const q = new URLSearchParams(location.search);
  // ?cluster= picks another cluster only when this site serves its deployments file; anything else
  // (a cluster this site does not run, a name that is not letters, digits and dashes) keeps the site's own
  const own = CONFIG.cluster || "localnet";
  const asked = String(q.get("cluster") || "").toLowerCase();
  const readDeployment = async (name) => {
    try { const r = await fetch("deployments/" + name + ".json", { cache: "no-store" }); return r.ok ? await r.json() : null; } catch (_) { return null; }
  };
  let cluster = own, d = null;
  if (/^[a-z0-9-]{1,32}$/.test(asked) && asked !== own) { d = await readDeployment(asked); if (d) cluster = asked; }
  if (!d) d = await readDeployment(cluster);
  ctx.cluster = cluster;
  ctx.rpc = cluster === own ? CONFIG.rpc || "" : "";
  // the site's watcher reports on the site's own cluster only
  ctx.watcherUrl = cluster === own ? String(CONFIG.watcherUrl || "").replace(/\/+$/, "") : "";
  if (d) {
    ctx.deployment = d;
    if (!ctx.rpc && d.rpc) ctx.rpc = d.rpc;
    if (d.programs) {
      for (const [k, v] of Object.entries(d.programs)) {
        const sdk = H.PROGRAMS[k];
        if (sdk && sdk.toBase58() !== v) console.warn("deployments/" + cluster + ".json has " + k + " = " + v + " but the SDK uses " + sdk.toBase58());
      }
    }
  }
  if (!ctx.rpc) ctx.rpc = cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : cluster === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899";
  // A review tool can point a page at an RPC or a watcher of its own: ?rpc= and ?watcher=. They
  // are honoured on localnet only, and only for an address on this machine (web/review/rpc-count.mjs).
  let ws = "";
  if (cluster === "localnet") {
    const rpc = localUrl(q.get("rpc")), watcher = localUrl(q.get("watcher"));
    if (rpc) { ctx.rpc = rpc; ws = rpc.replace(/^http/, "ws"); CARRY.rpc = rpc; }
    if (watcher) { ctx.watcherUrl = watcher; CARRY.watcher = watcher; }
  }
  ctx.rpcHost = hostOf(ctx.rpc);
  ctx.connection = new Connection(ctx.rpc, { commitment: "confirmed", disableRetryOnRateLimit: false, ...(ws ? { wsEndpoint: ws } : {}) });
  // the platform lookup table: every transaction is compiled against it when the file exists
  ctx.lookupTable = null;
  try {
    const r = await fetch("deployments/" + cluster + "-alt.json", { cache: "no-store" });
    if (r.ok) { const j = await r.json(); if (j && j.lookupTable) ctx.lookupTable = new PublicKey(j.lookupTable); }
  } catch (_) {}
  ctx.client = new H.HookpoolClient(ctx.connection, ctx.lookupTable ? { lookupTable: ctx.lookupTable } : {});
  // the lookup table is read once, when a wallet connects, and cached by the client, so a transaction
  // later needs one blockhash read before the wallet opens. A visitor without a wallet never reads it.
  Wallet.onChange((W) => { if (W && W.publicKey) ctx.client.lookupTables().catch(() => {}); });
  mountShell(activePage);
  mountToasts();
  Wallet.restore(PublicKey).catch(() => null);
  return ctx;
}

/// The ?rpc= and ?watcher= a page was opened with, when boot() honoured them: links carry them on.
const CARRY = {};

// ---- the RPC's address, said without its key ----------------------------------------------------

/// The host of an address ("example.com" or "127.0.0.1:8899"), never its path or query.
export function hostOf(url) {
  try { return new URL(url).host || "the RPC"; } catch (_) { return "the RPC"; }
}
/// The scheme and host of an address ("http://127.0.0.1:8899"), never its path or query.
export function originOf(url) {
  try { const u = new URL(url); return u.origin && u.origin !== "null" ? u.origin : hostOf(url); } catch (_) { return hostOf(url); }
}
/// `text` with every address in it cut to its scheme and host: an error message may carry the
/// RPC's full address, and a provider's key sits in its path or query.
export function redactUrls(text) {
  return String(text || "").replace(/\b(https?|wss?):\/\/([^\s/?#"'<>]+)[^\s"'<>]*/gi, (_, s, h) => s + "://" + h);
}
/// An error message as one short plain sentence: addresses cut to their host, no raw JSON.
export function plainError(text) {
  let s = redactUrls(text).replace(/\s+/g, " ").trim();
  const j = s.search(/[{[]\s*"/);
  if (j >= 0) s = s.slice(0, j).replace(/[\s:,.-]+$/, "").trim();
  if (s.length > 160) s = s.slice(0, 157).replace(/\s+\S*$/, "") + "...";
  if (s && !/[.!?]$/.test(s)) s += ".";
  return s;
}
/// A read of the chain that failed, for a page: the RPC named by its host, what it said in plain
/// words. `e` is what the read threw.
export function rpcFailText(e) {
  const raw = String((e && e.message) || e || "");
  const at = "The RPC at " + (ctx.rpcHost || "the RPC");
  if (/\b429\b|too many requests/i.test(raw)) return at + " is rate limiting this browser. Wait a few seconds and try again.";
  if (/\b403\b|forbidden|dedicated nodes/i.test(raw)) return at + " refused the request.";
  const why = plainError(raw);
  return at + " did not answer." + (why ? " " + why.charAt(0).toUpperCase() + why.slice(1) : "");
}
/// Did a read throw because the account at the address is of another kind ("not a Pool account")?
export function notAccountOf(e, kind) {
  return new RegExp("not a " + kind + " account").test(String((e && e.message) || e || ""));
}
/// An http(s) address on this machine, without a trailing slash, or "".
function localUrl(v) {
  if (!v) return "";
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) ? u.href.replace(/\/+$/, "") : "";
  } catch (_) { return ""; }
}

export async function platform() {
  if (!ctx.platform) ctx.platform = await ctx.client.platform();
  return ctx.platform;
}

/// Current slot, cached for 5 seconds.
export async function currentSlot() {
  if (ctx.slot && Date.now() - ctx.slotAt < 5000) return ctx.slot;
  ctx.slot = await ctx.connection.getSlot();
  ctx.slotAt = Date.now();
  return ctx.slot;
}

// ---- the shell: header, menu with the wallet, footer ------------------------------------------------
// Every page carries two empty elements, <header class="site-header" id="siteHeader"> and
// <footer class="site-footer" id="siteFooter">. boot() fills both here, so the links, the
// wallet and the site's name live in one place. The name and the mark come from config.js.

const SITE = {
  name: String((CONFIG.site && CONFIG.site.name) || "").trim().slice(0, 40),
  mark: String((CONFIG.site && CONFIG.site.mark) || "").trim(),
  icon: String((CONFIG.site && CONFIG.site.icon) || "").trim(),
};
/// The site's name from config.js, or "" when none is set.
export function siteName() { return SITE.name; }
/// Set the page title. The site's name follows it when config.js has one.
export function setTitle(text) { document.title = SITE.name ? text + " | " + SITE.name : text; }

const NS = "http://www.w3.org/2000/svg";
/// The plain mark drawn when config.js names no image: a ring.
function plainMark() {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 34 34"); s.setAttribute("aria-hidden", "true");
  const c = document.createElementNS(NS, "circle");
  c.setAttribute("cx", "17"); c.setAttribute("cy", "17"); c.setAttribute("r", "11.5"); c.setAttribute("fill", "none"); c.setAttribute("stroke", "currentColor"); c.setAttribute("stroke-width", "3.4");
  s.append(c);
  return s;
}
const PLAIN_ICON = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 34 34'><rect width='34' height='34' fill='#000'/><circle cx='17' cy='17' r='10' fill='none' stroke='#F8F0E9' stroke-width='3.4'/></svg>");
function markNode() {
  if (!SITE.mark) return plainMark();
  const img = el("img", { src: SITE.mark, alt: "", width: 34, height: 34 });
  img.onerror = () => img.replaceWith(plainMark());
  return img;
}

const MENU_LINKS = [
  { href: "index.html", text: "Explore", icon: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z", phoneOnly: true },
  { href: "workshop.html", text: "Custom hooks", icon: "M9 3v6a3 3 0 0 0 6 0V3M12 12v3a4 4 0 0 1-8 0v-1" },
  { href: "hooks.html", text: "Hook checker", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" },
  { href: "docs.html", text: "Docs", icon: "M5 5a2 2 0 0 1 2-2h12v16H7a2 2 0 0 0-2 2zM5 19a2 2 0 0 1 2-2h12M9 7h6" },
];
const FOOT_PRODUCT = [["index.html", "Explore"], ["launch.html", "Launch a token"], ["launch-modules.html", "Module Mode"], ["launch-collectible.html", "Collectible"], ["launch-hook.html", "Custom hook"], ["pool.html", "Liquidity"]];
const FOOT_RESOURCES = [["docs.html", "Docs"], ["hooks.html", "Hook checker"], ["workshop.html", "Custom hooks"], ["review-hook.html", "Get your hook reviewed"], ["reviews/index.html", "Hook reports"], ["workshop-guide.html", "Build a hook"]];

let menu = null; // { open(), close(), showWallet() }
/// Open the menu on the wallet: the list of wallets to connect, or the connected one.
export function openWallet() { if (menu) menu.showWallet(); }

function mountShell(activePage) {
  // a page written for the earlier shell: its nav and footer are replaced in place
  let header = document.getElementById("siteHeader");
  const oldNav = document.getElementById("nav");
  if (!header && oldNav) { header = el("header", { class: "site-header", id: "siteHeader" }); oldNav.replaceWith(header); }
  let footer = document.getElementById("siteFooter");
  const oldFoot = !footer && document.querySelector("body > footer");
  if (oldFoot) { footer = el("footer", { class: "site-footer", id: "siteFooter" }); oldFoot.replaceWith(footer); }
  // the tab's title and icon
  if (SITE.name && !document.title.includes(SITE.name)) document.title = document.title + " | " + SITE.name;
  let icon = document.querySelector('link[rel="icon"]');
  if (!icon) { icon = el("link", { rel: "icon" }); document.head.append(icon); }
  icon.removeAttribute("type");
  icon.href = SITE.icon || SITE.mark || PLAIN_ICON;
  if (footer) mountFooter(footer);
  if (!header) return;

  const current = (href) => (href === activePage ? "page" : null);
  const btn = el("button", { class: "menu-btn", id: "menuBtn", type: "button", "aria-label": "Menu", "aria-expanded": "false", "aria-controls": "menuSheet" }, svg("M4 7h16M4 12h16M4 17h16"));
  const walletBtn = el("button", { class: "menu-item wallet-btn", id: "walletBtn", type: "button", "aria-expanded": "false", "aria-controls": "walletPop" });
  const pop = el("div", { class: "pop", id: "walletPop", hidden: true });
  const sheet = el("div", { class: "menu-sheet", id: "menuSheet", hidden: true },
    el("nav", { "aria-label": "More pages" }, ...MENU_LINKS.map((l) => el("a", { class: "menu-item" + (l.phoneOnly ? " phone-only" : ""), href: l.href, "aria-current": current(l.href) }, svg(l.icon), l.text))),
    el("div", { class: "menu-wallet" }, walletBtn, pop),
    el("div", { class: "menu-foot" }, "Network ", el("span", { class: "mono", text: ctx.cluster, title: "RPC " + ctx.rpcHost })));
  header.replaceChildren(el("div", { class: "site-header-in" },
    el("a", { class: "site-mark", href: "index.html", "aria-label": SITE.name ? SITE.name + ", home" : "Home" }, markNode()),
    el("nav", { class: "site-nav", "aria-label": "Main" },
      el("a", { href: "index.html", "data-nav": "explore", "aria-current": current("index.html"), text: "Explore" }),
      el("a", { href: "launch.html", "data-nav": "launch", "aria-current": current("launch.html"), text: "Launch a token" })),
    el("div", { class: "site-menu" }, btn, sheet)));

  const qCluster = new URLSearchParams(location.search).get("cluster");
  const carry = [qCluster ? "cluster=" + ctx.cluster : "", ...Object.entries(CARRY).map(([k, v]) => k + "=" + encodeURIComponent(v))].filter(Boolean).join("&");
  if (carry) {
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (href && !/^(https?:|#|mailto:|data:)/.test(href) && !href.includes("cluster=") && !href.includes("rpc=")) a.setAttribute("href", href + (href.includes("?") ? "&" : "?") + carry);
    }
  }

  const dot = el("span", { class: "on-dot", hidden: true });
  btn.append(dot);
  const renderWallet = (W) => {
    walletBtn.replaceChildren(svg("M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2zM16 13h2"));
    if (W.publicKey) {
      const s = short(W.publicKey.toBase58());
      walletBtn.append(el("span", { class: "addr", text: s }), el("span", { class: "dot" }));
      walletBtn.classList.add("on"); walletBtn.title = W.name + " " + s; walletBtn.setAttribute("aria-label", "Wallet " + s);
    } else {
      walletBtn.append(el("span", { class: "addr", text: "Connect wallet" }));
      walletBtn.classList.remove("on"); walletBtn.title = ""; walletBtn.setAttribute("aria-label", "Connect wallet");
    }
    dot.hidden = !W.publicKey;
    btn.setAttribute("aria-label", W.publicKey ? "Menu, wallet connected" : "Menu");
    if (!pop.hidden) fillPop(pop, closeWallet);
  };

  let open = false, openedAt = 0, hideTimer = 0;
  const showWalletList = () => { fillPop(pop, closeWallet); pop.hidden = false; walletBtn.setAttribute("aria-expanded", "true"); };
  const closeWallet = () => { pop.hidden = true; walletBtn.setAttribute("aria-expanded", "false"); };
  const show = () => {
    if (open) return;
    clearTimeout(hideTimer);
    open = true; openedAt = Date.now();
    sheet.classList.remove("out"); sheet.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    if (!open) return;
    open = false;
    btn.setAttribute("aria-expanded", "false");
    sheet.classList.add("out");
    hideTimer = setTimeout(() => { sheet.hidden = true; sheet.classList.remove("out"); closeWallet(); }, 120);
  };
  btn.addEventListener("click", () => (open ? close() : show()));
  // a page's own button can press this one while the menu is shut: the menu then opens on the wallet
  walletBtn.addEventListener("click", () => {
    if (!open) { show(); showWalletList(); return; }
    pop.hidden ? showWalletList() : closeWallet();
  });
  // a click that opened the menu from a button of the page is still on its way up here: let it pass
  document.addEventListener("click", (e) => { if (open && Date.now() - openedAt > 50 && !header.querySelector(".site-menu").contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) { close(); btn.focus(); } });
  menu = { open: show, close, showWallet: () => { show(); showWalletList(); } };
  Wallet.onChange(renderWallet);
  renderWallet(Wallet.current());
}

function mountFooter(footer) {
  const col = (label, links) => el("div", { class: "foot-col" }, el("h2", { class: "foot-label", text: label }),
    el("div", { class: "foot-links" }, ...links.map(([href, text]) => el("a", { href, text }))));
  footer.replaceChildren(el("div", { class: "wrap site-footer-in" },
    el("div", { class: "foot-brand" }, markNode(), SITE.name ? el("span", { class: "foot-name", text: SITE.name }) : null),
    col("Product", FOOT_PRODUCT),
    col("Resources", FOOT_RESOURCES),
    el("div", { class: "foot-col foot-risk" }, el("h2", { class: "foot-label", text: "Risk notice" }),
      el("p", { text: "A confirmed trade cannot be undone. A coin can lose all of its value or become hard to sell." }))));
}

function fillPop(pop, close) {
  pop.replaceChildren();
  const W = Wallet.current();
  if (W.publicKey) {
    const addr = W.publicKey.toBase58();
    pop.append(
      popItem("Copy address", short(addr), () => { copy(addr); }),
      popLink("View on Solscan", explorer("account", addr)),
      popItem("Disconnect", W.name, async () => { await Wallet.disconnect(); close(); }),
    );
    return;
  }
  const list = Wallet.available();
  if (!list.length) {
    const d = document.createElement("div");
    d.className = "empty-w";
    d.textContent = "No Solana wallet found in this browser.";
    pop.append(d,
      popLink("Get Phantom", "https://phantom.app/download"),
      popLink("Get Solflare", "https://solflare.com/download"),
      popLink("Get Backpack", "https://backpack.app/download"));
  } else {
    for (const w of list) {
      const it = popItem(w.name, w.kind === "standard" ? "wallet standard" : "browser extension", async () => {
        try { await Wallet.connect(w, PublicKey); close(); toast("Connected to " + w.name, "ok"); }
        catch (e) { toast(e.message, "err"); }
      });
      if (w.icon) { const img = document.createElement("img"); img.src = w.icon; img.alt = ""; it.prepend(img); it.querySelector(".ph").remove(); }
      pop.append(it);
    }
  }
  if (ctx.cluster === "localnet") {
    const n = document.createElement("div");
    n.className = "note";
    n.textContent = "This site is on localnet. In Phantom, open Settings, then Developer settings, turn on Testnet mode and pick Solana Localnet. In Backpack, set a custom RPC of " + originOf(ctx.rpc) + " in its settings. Solflare has no setting for a local chain, so it cannot connect here.";
    pop.append(n);
  }
}
function popItem(title, sub, onClick) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "item";
  const ph = document.createElement("span"); ph.className = "ph";
  const t = document.createElement("span"); t.textContent = title;
  if (sub) { const s = document.createElement("span"); s.className = "sub"; s.textContent = sub; t.append(s); }
  b.append(ph, t);
  b.addEventListener("click", onClick);
  return b;
}
function popLink(title, href) {
  const a = document.createElement("a");
  a.className = "item"; a.href = href; a.target = "_blank"; a.rel = "noopener";
  const ph = document.createElement("span"); ph.className = "ph";
  const t = document.createElement("span"); t.textContent = title;
  const s = document.createElement("span"); s.className = "sub"; s.textContent = new URL(href).host; t.append(s);
  a.append(ph, t);
  return a;
}

/// The one sentence for a wallet that did not sign: a cancel, a close, a refusal, or nothing back.
export const WALLET_NO = "The wallet did not sign. Nothing was sent.";
/// Did the wallet refuse, close, cancel, or answer with nothing.
export function walletRefused(e) {
  const msg = String((e && (e.message || (e.error && e.error.message))) || "");
  const code = e && (e.code || (e.error && e.error.code));
  return code === 4001 || msg === "" || /reject|declin|cancel|denied|closed the wallet|did not sign|returned no signature|did not go through\. Try again/i.test(msg);
}
const noSign = (e) => new Error(walletRefused(e) ? WALLET_NO : "The wallet did not sign. " + e.message);
/// Ask the wallet for one signature. A wallet that did not sign throws WALLET_NO, whatever it said.
export async function signTx(tx) { try { return await Wallet.signTransaction(tx, VersionedTransaction); } catch (e) { throw noSign(e); } }
/// The same for several transactions in one prompt.
export async function signTxs(txs) { try { return await Wallet.signAllTransactions(txs, VersionedTransaction); } catch (e) { throw noSign(e); } }
/// A timing mark for a review tool: window.__traceTrades = true makes the page record them in window.__trace.
export function traceMark(what) { if (typeof window !== "undefined" && window.__traceTrades) (window.__trace = window.__trace || []).push([what, Math.round(performance.now())]); }

/// The connected public key, or a thrown Error with a sentence for the user.
export function requireWallet() {
  const W = Wallet.current();
  if (!W.publicKey) throw new Error("Connect a wallet first.");
  return W.publicKey;
}

// ---- toasts ---------------------------------------------------------------------------------------

function mountToasts() {
  if (document.getElementById("toasts")) return;
  const d = document.createElement("div"); d.className = "toasts"; d.id = "toasts"; d.setAttribute("aria-live", "polite");
  document.body.append(d);
}
export function toast(message, kind = "", link) {
  const box = document.getElementById("toasts"); if (!box) return;
  const t = document.createElement("div");
  t.className = "toast" + (kind ? " " + kind : "");
  t.textContent = message;
  if (link) { t.append(" "); const a = document.createElement("a"); a.href = link.href; a.target = "_blank"; a.rel = "noopener"; a.textContent = link.text; t.append(a); }
  box.append(t);
  const remove = () => { t.classList.add("out"); setTimeout(() => t.remove(), 240); };
  const timer = setTimeout(remove, link ? 9000 : 5000);
  t.addEventListener("click", () => { clearTimeout(timer); remove(); });
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied", "ok"); }
  catch (_) { toast("Copy failed. Select the text and copy it by hand.", "err"); }
}

// ---- formatting -----------------------------------------------------------------------------------

export function short(addr, n = 4) { const s = String(addr); return s.length <= n * 2 + 3 ? s : s.slice(0, n) + "..." + s.slice(-n); }

export function fmtUnits(v, decimals, maxFrac = 4) {
  v = BigInt(v);
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  return (neg ? "-" : "") + w + (frac ? "." + frac : "");
}
export function fmtSol(lamports, maxFrac = 4) { return fmtUnits(lamports, SOL_DECIMALS, maxFrac); }
/// An amount for a figure that is usually cut to `maxFrac` decimals: the same text as fmtUnits,
/// except that an amount above zero which would read 0 shows its first two significant digits
/// (0.0009, 0.00093), so a pool that holds a little SOL never reads "0 SOL".
export function fmtAmount(v, decimals, maxFrac = 2) {
  v = BigInt(v);
  const cut = fmtUnits(v, decimals, maxFrac);
  if (v === 0n || cut !== "0" && cut !== "-0") return cut;
  const a = v < 0n ? -v : v;
  const frac = a.toString().padStart(decimals, "0");
  const first = frac.search(/[1-9]/);
  return fmtUnits(v, decimals, Math.min(decimals, first + 2));
}
/// LP amounts with all six decimals: a share of a pool can be a few raw units.
export function fmtLp(v) { return fmtUnits(v, H.LP_DECIMALS, H.LP_DECIMALS); }
/// A share as a percent with up to four decimals, cut and never rounded up, so "100%" is said only when it is all of it.
export function fmtShare(part, whole) {
  part = BigInt(part); whole = BigInt(whole);
  if (whole <= 0n) return "0%";
  return (Number(part * 1_000_000n / whole) / 10000).toLocaleString("en-US", { maximumFractionDigits: 4 }) + "%";
}
export function toNumber(v, decimals) { return Number(BigInt(v)) / 10 ** decimals; }

export function fmtPrice(p) {
  if (!isFinite(p) || p <= 0) return "0";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const s = Number(p.toPrecision(3));
  return s.toLocaleString("en-US", { maximumFractionDigits: 20, useGrouping: false });
}
export function fmtCompact(n, frac = 2) {
  if (!isFinite(n)) return "";
  const a = Math.abs(n);
  // the unit is picked after rounding, so 999,999,999.9 reads 1B and never 1000.00M; zeros at
  // the end are dropped (1.50M reads 1.5M)
  const at = (d) => Number((a / d).toFixed(frac));
  const put = (d, u) => { const t = (n / d).toFixed(frac); return (t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t) + u; };
  if (a >= 1e9 || at(1e6) >= 1000) return put(1e9, "B");
  if (a >= 1e6 || at(1e3) >= 1000) return put(1e6, "M");
  if (a >= 1e4) return put(1e3, "K");
  if (a >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: frac });
  return fmtPrice(n);
}
export function fmtPct(bps, frac = 2) { return (Number(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: frac }) + "%"; }
export function fmtInt(n) { return Number(n).toLocaleString("en-US"); }
/// An address from the chain or a file as a link's href: only a web address, else "" (no link).
/// A coin or a hook made outside this site can carry any text where an address is expected.
export function webHref(url) {
  const s = String(url || "").trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(s)) return "";
  // and one the browser can parse: a link that only looks right ("http://[") must not reach code that
  // builds a URL from it
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) && u.host ? s : ""; } catch (_) { return ""; }
}

export function timeAgo(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
export function slotAge(slot, nowSlot) { return Math.max(0, Number(BigInt(nowSlot) - BigInt(slot))) * SLOT_MS / 1000; }
export function slotsToMinutes(slots) { return Number(slots) * SLOT_MS / 60000; }
export function minutesToSlots(min) { return Math.max(1, Math.round(Number(min) * 60000 / SLOT_MS)); }
export function fmtTime(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
export function slotsToSeconds(slots) { return Number(slots) * SLOT_MS / 1000; }
/// A length of time in words: "45 s", "3 min 20 s", "2 h 5 min", "90 days".
export function fmtSpan(seconds) {
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return s + " s";
  if (s < 3600) { const r = s % 60; return Math.floor(s / 60) + " min" + (r ? " " + r + " s" : ""); }
  if (s < 172800) { const m = Math.floor((s % 3600) / 60); return Math.floor(s / 3600) + " h" + (m ? " " + m + " min" : ""); }
  const d = Math.round(s / 8640) / 10;
  return d.toLocaleString("en-US") + (d === 1 ? " day" : " days");
}
/// A Unix time as a day and a time of day in the viewer's own time zone: "14 Jan 2027, 15:04".
export function fmtDate(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function parseUnits(str, decimals) {
  const s = String(str || "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [w, f = ""] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}
export function applyBps(v, bps) { return (BigInt(v) * BigInt(10000 - bps)) / 10000n; }
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---- explorers --------------------------------------------------------------------------------------

export function explorer(kind, value, site = "solscan") {
  if (site === "solanafm") {
    const c = ctx.cluster === "mainnet" ? "mainnet-alpha" : ctx.cluster === "devnet" ? "devnet-alpha" : "localnet-solana";
    return "https://solana.fm/" + (kind === "tx" ? "tx/" : "address/") + value + "?cluster=" + c;
  }
  const base = "https://solscan.io/" + (kind === "tx" ? "tx/" : "account/") + value;
  if (ctx.cluster === "mainnet") return base;
  if (ctx.cluster === "devnet") return base + "?cluster=devnet";
  return base + "?cluster=custom&customUrl=" + encodeURIComponent(ctx.rpc);
}

// ---- the watcher's market ------------------------------------------------------------------------------
// With `watcherUrl` set, the watcher publishes market.json: every pool with its account, its coin's
// metadata, mint and picture, and a rules coin's config and lock (FEED-CONTRACT.md has the
// fields). A page that lists coins reads it instead of the chain: no getProgramAccounts, no read
// per coin, no RPC at all.

const b64bytes = (s) => Uint8Array.from(atob(String(s || "")), (c) => c.charCodeAt(0));
/// The market as the page uses it, or null when there is no watcher or it did not answer.
/// rows[i] = { pool (the SDK's Pool), md { name, symbol, uri }, mint { decimals, supply },
/// meta (the coin's metadata JSON as far as the watcher read it, or undefined), rules (what
/// rulesFacts gives for a rules coin, or null) }. `slot` is the chain's slot now, worked out from
/// the market's last pass and the clock since; `checkedAt` when that pass ran.
export async function marketPools() {
  if (!ctx.watcherUrl) return null;
  const j = await fetchJson(ctx.watcherUrl + "/market.json", 6000);
  if (!j || !Array.isArray(j.pools)) return null;
  const checkedAt = Date.parse(j.checkedAt || j.updatedAt) || Date.now();
  const slot = Number(j.checkedSlot || j.slot || 0) + Math.max(0, Math.floor((Date.now() - checkedAt) / SLOT_MS));
  const rows = [];
  for (const e of j.pools) {
    try {
      const address = new PublicKey(e.address);
      const pool = H.decodePool(address, b64bytes(e.account));
      const c = e.coin || {};
      const md = c.name || c.symbol || c.uri ? { name: c.name || "", symbol: c.symbol || "", uri: c.uri || "" } : null;
      const mint = c.supply !== undefined && c.supply !== null ? { decimals: Number(c.decimals), supply: BigInt(c.supply) } : null;
      // the coin's metadata JSON: only what the watcher could read; otherwise the page reads it itself
      const meta = c.metadataJson === "ok" ? { image: c.image || "", description: c.description || "", extensions: { website: (c.links && c.links.website) || "", twitter: (c.links && c.links.twitter) || "", telegram: (c.links && c.links.telegram) || "" } } : c.metadataJson === "none" || c.metadataJson === "invalid" ? null : undefined;
      let rules = null;
      if (e.rules && e.rules.config) {
        const r = e.rules;
        // the chain's clock now, from the moment the watcher read the coin's rules
        const readAt = Date.parse(r.readAt) || checkedAt;
        rules = { cfg: H.decodeRulesConfig(b64bytes(r.config)), lpFeeBps: pool.lpFeeBps, locked: BigInt(r.lockAmount || "0"), unlockAt: BigInt(r.lockUnlockAt || "0"),
          slot: BigInt(slot), unixTime: BigInt(Math.floor(Number(r.unixTime || 0) + Math.max(0, (Date.now() - readAt) / 1000))) };
      }
      rows.push({ pool, md, mint, meta, rules });
    } catch (_) {} // an entry this page cannot read is left out, not the whole market
  }
  return { slot, checkedAt, rows };
}
/// Every pool: from the watcher's market when there is one, from the chain otherwise.
export async function allPools() {
  const m = await marketPools().catch(() => null);
  return m ? m.rows.map((r) => r.pool) : ctx.client.allPools();
}

// ---- coin images -------------------------------------------------------------------------------------

export async function fetchJson(url, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

const imageCache = new Map();
export async function coinImage(uri, symbol) {
  const key = uri || ("sym:" + symbol);
  if (imageCache.has(key)) return imageCache.get(key);
  let url = "";
  if (uri && /^https?:\/\//i.test(uri)) {
    const j = await fetchJson(uri, 3500);
    const img = j && typeof j.image === "string" ? j.image.trim() : "";
    if (/^(https?:\/\/|data:image\/)/i.test(img)) url = img;
  }
  const out = url || monogram(symbol);
  imageCache.set(key, out);
  return out;
}
export async function coinMeta(uri) {
  if (!uri || !/^https?:\/\//i.test(uri)) return null;
  return fetchJson(uri, 3500);
}
/// The picture of a coin that has none: its first two letters on a quiet colour of its own.
/// With no symbol yet it is an empty square with a ring. The square fills its frame, and the
/// frame rounds the corners.
export function monogram(symbol) {
  const s = String(symbol || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  if (!s) return "data:image/svg+xml;utf8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='#16191E'/><circle cx='32' cy='32' r='9' fill='none' stroke='#3A3E47' stroke-width='3'/></svg>");
  let h = 0; for (const ch of String(symbol || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const bg = "hsl(" + hue + " 20% 26%)";
  const svgText = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='" + bg + "'/><text x='32' y='" + (s.length > 1 ? 38 : 39.5) + "' text-anchor='middle' font-family='Helvetica Neue, Helvetica, Arial, sans-serif' font-size='" + (s.length > 1 ? 17 : 21) + "' font-weight='600' letter-spacing='-0.5' fill='#F5F5F7'>" + s + "</text></svg>";
  return "data:image/svg+xml;utf8," + encodeURIComponent(svgText);
}
export function setImage(img, src, symbol) {
  img.src = src;
  img.onerror = () => { img.onerror = null; img.src = monogram(symbol); };
}

// ---- hooks in words ---------------------------------------------------------------------------------

export function templateOf(pool) {
  if (!pool.hasHook) return "none";
  return templateOfProgram(pool.hookProgram);
}
export function templateOfProgram(p) {
  if (p.equals(H.PROGRAMS.hook_tax)) return "tax";
  if (p.equals(H.PROGRAMS.hook_launch_guard)) return "launch_guard";
  if (p.equals(H.PROGRAMS.hook_buyback)) return "buyback";
  if (H.PROGRAMS.hook_collectible && p.equals(H.PROGRAMS.hook_collectible)) return "collectible";
  if (H.PROGRAMS.hook_rules && p.equals(H.PROGRAMS.hook_rules)) return "rules";
  return "custom";
}
export const TEMPLATE_LABEL = { none: "No hook", rules: "Launch rules", tax: "Tax to treasury", launch_guard: "Launch guard", buyback: "Buyback and burn", collectible: "Collectible per buy", custom: "Custom hook" };
/// Where a hook's manifest link takes a visitor. The platform's five templates published links to
/// pages under programmable.market/hooks/ that were never made, and a manifest is written once and
/// cannot change; for those the site shows its own docs section instead. Any other hook keeps its
/// own link (a web address only). Answers { href, text } or null.
const TEMPLATE_DOCS = { tax: "docs.html#tpl-tax", launch_guard: "docs.html#tpl-guard", buyback: "docs.html#tpl-buyback", collectible: "docs.html#tpl-collectible", rules: "docs.html#rules" };
export function manifestLink(programId, uri) {
  const t = programId ? templateOfProgram(programId) : "custom";
  if (TEMPLATE_DOCS[t] && /^https:\/\/programmable\.market\/hooks\//i.test(String(uri || ""))) return { href: TEMPLATE_DOCS[t], text: "the docs", own: true };
  const href = webHref(uri);
  if (!href) return null;
  try { return { href, text: new URL(href).host, own: false }; } catch (_) { return null; }
}
/// The platform's template programs, in the order the site lists them.
export const TEMPLATE_PROGRAMS = ["hook_rules", "hook_tax", "hook_launch_guard", "hook_buyback", "hook_collectible"];

export function hookBadge(pool) {
  if (!pool.hasHook) return { label: "No hook", cls: "" };
  const t = templateOf(pool);
  if (pool.hookKind === H.HOOK_KIND.PLATFORM) return { label: t === "custom" ? "Platform hook" : TEMPLATE_LABEL[t], cls: "accent" };
  if (pool.hookKind === H.HOOK_KIND.FROZEN) return { label: "Frozen custom hook", cls: "ok" };
  return { label: "Hook", cls: "" };
}

/// A pegged coin: a Token-2022 coin whose transfer hook is the collectible program.
export function isPegged(pool) { return !!pool && !!pool.hasHook && ctx.client.isPegged(pool); }

/// Small mono tags for a pool's rules, from its flags and template. `pegged`: the coin runs
/// the collectible program inside every transfer, so "sells: never called" would be false.
/// `facts`: for a coin on the launch rules template, what rulesFacts read about it. Its tags
/// then say which rules the coin has.
export function rulesTags(flags, template, hasHook = true, pegged = false, facts = null) {
  if (!hasHook) return ["no hook"];
  if (template === "rules") return facts ? rulesCoinTags(facts) : ["rules"];
  const s = H.describeFlags(flags);
  const t = [];
  if (template === "tax") t.push("tax");
  else if (template === "launch_guard") t.push("guard");
  else if (template === "buyback") t.push("burn");
  else if (template === "collectible") { t.push("mint"); if (pegged) t.push("pegged"); }
  else {
    if (s.canTakeFee) t.push("fee");
    if (s.canOverrideFee) t.push("fee override");
  }
  if (s.canOverrideCurve) t.push("curve");
  if (!s.runsOnSells && !pegged) t.push("sells: never called");
  if (s.canBlockRemoval) t.push("liq gate");
  if (template === "custom" && !s.canTakeFee && !s.canOverrideFee && !s.canOverrideCurve && (s.runsOnBuys || s.runsOnSells)) t.push("allow or refuse");
  if (template === "custom" && !s.runsOnBuys && !s.runsOnSells) t.push("off on trades");
  return t;
}
/// The flags of a hook in sentences. The collectible template's flags say it is never called
/// on a sell. That is the pool's side only: on a pegged coin the same program is the coin's
/// transfer hook and runs inside every transfer. `pegged`: true or false for one coin,
/// null for the template in general.
/// `caps`: the platform account. With it the two caps are said in numbers. A hook that is not
/// a platform template also gets the sentence the flags leave out: a callback that fails stops
/// the whole trade, so a hook can refuse any trade it is called on.
export function flagSentences(flags, template, pegged = null, caps = null) {
  const s = H.describeFlags(flags);
  let out = s.sentences.slice();
  if (template === "collectible" && pegged !== false && !s.runsOnSells) {
    out[0] = pegged === true
      ? "The pool calls the hook on buys only. The same program runs inside every transfer of this coin, sells included."
      : "The pool calls the hook on buys only. On a plain coin it never sees a sell. On a pegged coin it runs inside every transfer of the coin, sells included.";
  }
  if (template === "custom" && (s.canTakeFee || s.canOverrideFee || s.canOverrideCurve) && (s.runsOnBuys || s.runsOnSells)) {
    const what = s.runsOnBuys && s.runsOnSells ? "a buy or a sell" : s.runsOnSells ? "a sell" : "a buy";
    out.splice(1, 0, "It can refuse " + what + ". The pool cannot overrule that.");
  }
  if (caps) {
    out = out.map((t) => t === "Can take a fee in the quote token to its treasury, up to the platform cap." ? t.slice(0, -1) + " of " + fmtPct(caps.maxHookFeeBps) + "."
      : t === "Can change the pool fee per trade, up to the platform cap." ? t.slice(0, -1) + " of " + fmtPct(caps.maxFeeOverrideBps) + "." : t);
  }
  return out;
}
const QUIET_TAGS = ["sells: never called", "no hook", "rules", "no rule on"];
export function tagsEl(tags) {
  return el("span", { class: "tags" }, ...tags.map((t) => el("span", { class: "tag" + (QUIET_TAGS.includes(t) ? "" : " accent"), text: t })));
}

// ---- coins on the launch rules template ---------------------------------------------------------------

/// What the chain holds about the coins on the launch rules template among `pools`: each coin's
/// rules, what its lock account holds and until when, and the chain's clock. One read per 33
/// coins. Returns a Map of pool address to { cfg, lpFeeBps, locked, unlockAt, slot, unixTime }.
export async function rulesFacts(pools) {
  const out = new Map();
  const list = pools.filter((p) => p.hasHook && templateOf(p) === "rules");
  if (!list.length) return out;
  const time = await ctx.client.chainTime();
  for (let i = 0; i < list.length; i += 33) {
    const part = list.slice(i, i + 33);
    const keys = [];
    for (const p of part) keys.push(H.rulesPda.cfg(p.address), H.rulesPda.lock(p.address), H.rulesPda.lockVault(p.address));
    const infos = await ctx.connection.getMultipleAccountsInfo(keys);
    part.forEach((p, n) => {
      const [c, l, v] = infos.slice(n * 3, n * 3 + 3);
      if (!c) return;
      try {
        const cfg = H.decodeRulesConfig(new Uint8Array(c.data));
        const rec = l ? H.decodeLockRecord(new Uint8Array(l.data)) : null;
        out.set(p.address.toBase58(), { cfg, lpFeeBps: p.lpFeeBps, locked: v ? H.decodeTokenAmount(new Uint8Array(v.data)) : 0n, unlockAt: rec ? rec.unlockAt : 0n, slot: time.slot, unixTime: time.unixTime });
      } catch (_) {}
    });
  }
  return out;
}
/// The tags of a rules coin: one per rule it has. A sniper fee and a buy limit are named
/// while they run, a lock while coins sit in the lock account before their date.
export function rulesCoinTags(f) {
  const c = f.cfg, t = [];
  if (c.buy.creatorBps > 0 || c.sell.creatorBps > 0) t.push("creator fee");
  if (c.buy.holdersBps > 0 || c.sell.holdersBps > 0) t.push("rewards");
  if (c.buy.burnBps > 0 || c.sell.burnBps > 0) t.push("burn");
  if (H.rulesSniperFee(f.slot, c.startSlot, c.sniperSlots, c.sniperStartFeeBps, f.lpFeeBps) !== null) t.push("sniper fee");
  if (H.rulesBuyLimit(c, f.slot)) t.push("buy limit");
  if (f.locked > 0n && f.unixTime < f.unlockAt) t.push("locked");
  return t.length ? t : ["no rule on"];
}
/// The first slot in which a pool with this hook takes new liquidity, and how long that is
/// from `slot`. The rules template and the launch guard refuse a deposit while their window
/// runs. null when the pool is open now. `info` is client.hookInfo(pool).
export function liquidityWindow(info, slot) {
  const open = info ? H.liquidityOpenSlot(info) : 0n;
  if (open <= 0n || BigInt(slot) >= open) return null;
  // a strict coin refuses deposits while its max wallet runs: when that ends last, it is what keeps the pool closed
  const r = info.rules;
  const maxWalletEnd = r && r.kind === H.RULES_KIND.STRICT && Number(r.maxWalletSlots) > 0 ? BigInt(r.startSlot) + BigInt(r.maxWalletSlots) : 0n;
  return { openSlot: open, seconds: slotsToSeconds(open - BigInt(slot)), what: !r ? "launch guard" : maxWalletEnd > 0n && open === maxWalletEnd ? "max wallet" : "sniper fee" };
}

/// Reads a program the way create_pool does: loader state, manifest, extra-metas, whitelist.
export async function checkHook(id) {
  const conn = ctx.connection;
  const out = { id, exists: false, executable: false, loader: "", frozen: null, authority: null, whitelisted: false, manifest: null, manifestErr: "", extra: null, reason: "", accepts: false };
  const [acc, plat, manifestInfo, extraInfo] = await Promise.all([conn.getAccountInfo(id), platform(), conn.getAccountInfo(H.pda.manifest(id)), conn.getAccountInfo(H.pda.extraMetas(id))]);
  if (!acc) return out;
  out.exists = true; out.executable = !!acc.executable;
  if (!acc.executable) return out;
  const whitelist = plat ? plat.whitelist : [];
  if (acc.owner.equals(H.BPF_LOADER_UPGRADEABLE)) {
    out.loader = "upgradeable loader (v3)";
    // only the header: the upgrade authority sits in the first 45 bytes of an account that holds the whole program
    const pd = await conn.getAccountInfo(H.pda.programData(id), { dataSlice: { offset: 0, length: 45 } });
    if (!pd) out.reason = "The program data account is missing.";
    else {
      try { out.authority = H.decodeUpgradeAuthority(new Uint8Array(pd.data)); out.frozen = out.authority === null; }
      catch (_) { out.reason = "The program data account could not be parsed."; }
      out.whitelisted = !!out.authority && whitelist.some((k) => k.equals(out.authority));
    }
  } else if (acc.owner.equals(H.LOADER_V4)) {
    out.loader = "loader v4";
    const d = new Uint8Array(acc.data);
    if (d.length >= 48) {
      out.authority = new PublicKey(d.subarray(8, 40));
      const status = Number(new DataView(d.buffer, d.byteOffset + 40, 8).getBigUint64(0, true));
      out.frozen = status === 2;
      out.whitelisted = status === 1 && whitelist.some((k) => k.equals(out.authority));
      if (status === 0) out.reason = "The program is retracted.";
    } else out.reason = "The loader v4 state is too short to read.";
  } else if (acc.owner.equals(BPF_LOADER_2) || acc.owner.equals(BPF_LOADER_1)) {
    out.loader = "non-upgradeable loader"; out.frozen = true;
  } else {
    out.loader = "unknown loader " + short(acc.owner.toBase58()); out.reason = "The pool does not know this loader.";
  }
  if (manifestInfo) { try { out.manifest = H.decodeHookManifest(new Uint8Array(manifestInfo.data)); } catch (_) { out.manifestErr = "found but not a HookManifest"; } }
  out.extra = extraInfo ? extraInfo.data.length : null;
  out.accepts = (out.frozen === true || out.whitelisted) && !!out.manifest && out.extra !== null;
  return out;
}

/// The checker's findings as short lines: [{ ok: true|false|null, text }].
export function checkLines(c) {
  if (!c.exists) return [{ ok: false, text: "No account at this address on " + ctx.cluster + "." }];
  if (!c.executable) return [{ ok: false, text: "This account is not a program." }];
  const lines = [];
  // one of the programs this site ships with, or someone else's
  const third = templateOfProgram(c.id) === "custom";
  lines.push({ ok: c.frozen === true ? true : c.whitelisted ? null : false, text: c.frozen === true ? "Frozen. Nobody can change this program's code. The accounts it keeps can still change." : c.frozen === false ? "Not frozen: upgrade authority " + short(c.authority ? c.authority.toBase58() : "", 5) + "." : "Freeze status unknown. " + c.reason });
  lines.push({ ok: c.whitelisted ? true : c.frozen === false ? false : null, text: c.whitelisted ? "Whitelisted authority: a platform key, so the pool accepts it as a platform " + (third ? "hook." : "template.") : c.frozen === false ? "Not whitelisted." : "Whitelist not needed for a frozen program." });
  if (third && !c.whitelisted) lines.push({ ok: null, text: "Not a platform program. Someone else wrote it. " + (c.frozen === true ? "The pool checks that its code is frozen and, while the approved list is on, that Programmable approved it. The pool does not check what the code does." : "The pool takes such a program only once its code is frozen.") });
  const ml = c.manifest ? manifestLink(c.id, c.manifest.uri) : null;
  lines.push({ ok: !!c.manifest, text: c.manifest ? "Manifest found: " + (c.manifest.name || "unnamed") + (ml && ml.own ? ". Its page is in this site's docs." : c.manifest.uri ? ", " + c.manifest.uri : "") : c.manifestErr ? "Manifest " + c.manifestErr + "." : "No manifest at the [\"manifest\"] PDA." });
  lines.push({ ok: c.extra !== null, text: c.extra !== null ? "Extra accounts list found (" + c.extra + " bytes)." : "No extra accounts list at the [\"extra-metas\"] PDA." });
  lines.push({ ok: null, text: "Loader: " + c.loader + "." });
  return lines;
}

// ---- transactions -------------------------------------------------------------------------------

export async function sendIxs(ixs, extraSigners = [], label = "transaction") {
  const payer = requireWallet();
  traceMark("blockhash requested");
  const built = await ctx.client.buildTx(payer, ixs);
  traceMark("sign requested");
  // the wallet signs first, the site's own keys (a new coin's mint) after it: a wallet that is
  // handed a transaction someone already signed treats it as unsafe (Phantom blocks the request)
  const signed = await signTx(built.tx);
  if (extraSigners.length) signed.sign(extraSigners);
  traceMark("signed");
  return sendSigned(signed, built, label);
}

/// Send and confirm a transaction that is already signed. built is what client.buildTx
/// returned for it. A thrown error has expired = true when its blockhash was too old.
export async function sendSigned(signed, built, label = "transaction") {
  const conn = ctx.connection;
  const stale = (t) => /Blockhash not found|block height exceeded|expired/i.test(String(t || ""));
  let signature;
  try {
    signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  } catch (e) {
    const err = new Error(await explainTxError(e, label));
    err.expired = stale(e && e.message) || stale((e && e.logs || []).join(" "));
    throw err;
  }
  traceMark("sent");
  let res;
  try { res = await conn.confirmTransaction({ signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed"); }
  catch (e) { const err = new Error(explainLogs(null, String((e && e.message) || e), label)); err.expired = true; throw err; }
  if (res.value && res.value.err) {
    let logs = null;
    try { const t = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 }); logs = t && t.meta && t.meta.logMessages; } catch (_) {}
    throw new Error(explainLogs(logs, JSON.stringify(res.value.err), label));
  }
  return signature;
}

// ---- wrapped SOL ------------------------------------------------------------------------------------
// The SDK leaves a wallet's wrapped SOL account as it found it. A wallet that keeps one receives
// the SOL of a sell or of a withdrawal inside it, as wrapped SOL. For the owner of a tax coin
// that account is the coin's treasury.

/// What the wallet's wrapped SOL account holds, in lamports. null when the wallet has none.
export async function wrappedSol(owner) {
  const info = await ctx.connection.getAccountInfo(H.pda.ata(owner, H.NATIVE_MINT));
  return info ? H.decodeTokenAmount(new Uint8Array(info.data)) : null;
}
/// Turn the connected wallet's wrapped SOL into plain SOL. The account stays open, so a tax
/// that is paid into it keeps arriving. `after` runs when the transaction is through or failed.
export async function unwrapSol(btn, after) {
  const label = btn.textContent;
  try {
    const user = requireWallet();
    btn.disabled = true; btn.textContent = "Confirm in your wallet";
    const sig = await sendIxs(ctx.client.unwrapInstructions(user), [], "unwrap");
    toast("Done. It is plain SOL in your wallet now.", "ok", { href: explorer("tx", sig), text: "View" });
  } catch (e) { toast(e.message, "err"); }
  btn.textContent = label; btn.disabled = false;
  if (after) await after();
}

/// A curve refusal in words for the page: the SDK's CurveRefusal (thrown before anything is
/// sent) or the curve error a failed transaction names in its logs (H.curveErrorFromLogs).
/// `info` is anything with the error's number. "" when the number is not a curve error.
export function curveSentence(info) {
  const n = info && (info.number !== undefined ? info.number : info.info && info.info.number);
  switch (n) {
    case 6043: return "Curve launches are switched off on this platform. Choose Seed it yourself.";
    case 6044: return "A pool on the curve must hold the whole supply, and the coin's mint must be closed.";
    case 6045: return "Liquidity opens at graduation. Until then this pool only trades.";
    case 6046: return "A hook that sets the price itself cannot run a pool on the curve.";
    case 6047: return "This pool is not on the curve.";
    case 6048: return "This pool has not reached its target yet, so it cannot graduate.";
    case 6049: return "The pool cannot pay this sell. A sell on the curve is paid only from the SOL buyers put in. Sell less.";
    case 6011: case 6050: return "A pegged coin cannot launch on the curve. Choose Seed it yourself.";
    case 6051: return "These curve settings are out of bounds.";
    default: return info && info.message ? String(info.message).charAt(0).toUpperCase() + String(info.message).slice(1) + "." : "";
  }
}

export async function explainTxError(e, label) {
  let logs = Array.isArray(e && e.logs) ? e.logs : null;
  if (!logs && e && typeof e.getLogs === "function") { try { logs = await e.getLogs(ctx.connection); } catch (_) {} }
  const msg = String((e && e.message) || e || "");
  if (/reject|declin|cancel|denied|closed the wallet|did not sign/i.test(msg)) return WALLET_NO;
  return explainLogs(logs, msg, label);
}

function explainLogs(logs, msg, label) {
  const text = ((logs || []).join("\n") + "\n" + msg);
  const has = (re) => re.test(text);
  // a refusal of the curve, by its number in the logs
  const curve = logs && logs.length ? H.curveErrorFromLogs(logs) : null;
  if (curve) return curveSentence(curve);
  // a hook the approved list does not hold (HOOKS.md section 6.1), for instance taken off it between the two launch steps
  const approval = logs && logs.length ? H.approvalErrorFromLogs(logs) : null;
  if (approval && approval.number === 6052) return "This hook has not been reviewed by Programmable yet, so no coin can launch on it.";
  if (approval && approval.number === 6056) return "The approved list of the platform cannot be read right now, so no coin can launch on an outside hook. Try again later.";
  if (has(/output below min_amount_out/)) return "The price moved more than your slippage allows. Raise the slippage or try again.";
  if (has(/input above the maximum you allowed/)) return "The pool now needs more than the maximum you allowed. Refresh the amounts and try again.";
  if (has(/platform is paused/)) return "The platform is paused right now. Removing liquidity still works.";
  if (has(/not enough liquidity/)) return "The pool does not have enough liquidity for this amount.";
  if (has(/amount must be greater than zero|amount too small/)) return "The amount is too small.";
  if (has(/treasury below min_quote/)) return "The treasury is still below the minimum, so there is nothing to buy back yet.";
  if (has(/nothing was bought/)) return "The run bought nothing. Try again in a moment.";
  if (has(/observation of the pool is less than 25 slots old/)) return "The pool was recorded less than " + H.BURN_INTERVAL_SLOTS + " slots ago. Try again in a few seconds.";
  if (has(/min_quote above the maximum/)) return "The buyback minimum cannot be above " + fmtSol(H.MAX_BUYBACK_MIN_QUOTE) + " SOL.";
  if (has(/buy above the limit of the launch window/)) return "This buy is above the coin's buy limit. Buy less, or wait until the limit ends.";
  if (has(/liquidity cannot be added while the sniper fee runs/)) return "This pool takes no new liquidity while its sniper fee runs. Removing liquidity still works.";
  if (has(/liquidity cannot be added while the guard window runs/)) return "This pool takes no new liquidity while its launch guard runs. Removing liquidity still works.";
  if (has(/unstake is not open yet/)) return "Unstaking is not open yet. It opens about one hour after your last stake.";
  if (has(/more than this record has staked/)) return "That is more than you have staked.";
  if (has(/nothing to claim/)) return "There is nothing to claim right now.";
  if (has(/only the creator of the config can do this/)) return "Only the wallet that launched this coin can do that.";
  if (has(/the burn pot is empty/)) return "Nothing waits in the burn pot.";
  if (has(/the creator lock is not over yet/)) return "The lock is not over yet.";
  if (has(/nothing is locked/)) return "Nothing is locked.";
  if (has(/unlock time is before the lock declared at launch/)) return "This transaction came too late for the lock date inside it. Build it again with a new date.";
  if (has(/tax above the ceiling fixed at launch/)) return "That tax is above the ceiling fixed at launch.";
  if (has(/only the config owner can do this/)) return "Only the owner of this tax can do that.";
  if (has(/config is renounced/)) return "The owner renounced. These taxes can never change.";
  if (has(/hook is upgradeable and its authority is not whitelisted/)) return "The pool refused this hook: it is upgradeable and its authority is not whitelisted.";
  if (has(/slot hashes sysvar could not be read/)) return "The network did not hand over recent block hashes. Try again in a moment.";
  if (has(/holds more pieces than its coins back/)) return "This wallet holds more pieces than its coins back, so moving and sending are locked. Buy the coins back first.";
  if (has(/receiving wallet's list is full/)) return "That wallet already holds " + H.collectible.MAX_PIECES_PER_WALLET + " pieces of this coin. It cannot take more.";
  if (has(/wallet does not hold (this|that) piece/)) return "This wallet no longer holds that piece.";
  // one approval: the deposit a buy pays for its NFTs, and the mint that uses it
  if (has(/asset account is not the expected address/)) return "Your pieces were minted a moment ago. The page shows them now.";
  if (has(/deposit does not cover this mint/)) return "The deposit does not cover this mint. Mint the pieces yourself.";
  if (has(/no decided piece to mint/)) return "No piece is ready to mint yet. Try again in a few seconds.";
  if (has(/this ticket holds no deposit/)) return "There is no deposit to withdraw.";
  if (has(/collection is locked/)) return "The collection is locked. Its name, art and renderer can never change again.";
  if (has(/only the collection owner can do this/)) return "Only the collection owner can do this.";
  if (has(/name is empty or longer than 24 bytes/)) return "The collection name must be 1 to 24 bytes.";
  if (has(/renderer base uri is empty or longer than 80 bytes/)) return "The renderer base must be 1 to 80 bytes.";
  if (has(/manifest yet|extra-accounts list yet/)) return "This hook has not published its manifest and extra accounts list yet.";
  if (has(/insufficient lamports|Attempt to debit an account but found no record of a prior credit|insufficient funds for rent|AccountNotFound/i)) return "Your wallet does not hold enough SOL for this on " + ctx.cluster + ".";
  if (has(/Error: insufficient funds|custom program error: 0x1\b/)) return "Your wallet does not hold enough of the token for this.";
  if (has(/Blockhash not found|block height exceeded|expired/i)) return "The network did not confirm the " + label + " in time. Try again.";
  if (has(/Transaction too large/i)) return "The transaction is too large for one block. Try a smaller change.";
  if (has(/429|Too many requests/i)) return "The RPC is rate limiting this browser. Wait a few seconds and try again.";
  if (has(/Failed to fetch|NetworkError|ECONNREFUSED/i)) return "The RPC at " + ctx.rpcHost + " did not answer.";
  const m = /Error Message: ([^.\n]+)/.exec(text);
  if (m) return "The program refused the " + label + ": " + m[1].trim() + ".";
  // the wallet's or the RPC's own words: addresses cut to their host, no raw JSON
  const plain = plainError(msg);
  if (plain) return plain;
  return "The " + label + " did not go through. Try again.";
}

// ---- tiny DOM helpers ---------------------------------------------------------------------------

export const $ = (id) => document.getElementById(id);
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
export function svg(d, size) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
  if (size) { s.setAttribute("width", size); s.setAttribute("height", size); }
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "1.8"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
  s.append(p);
  return s;
}
export function copyButton(text, title = "Copy") {
  return el("button", { class: "icon-btn", type: "button", title, "aria-label": title, onclick: () => copy(text) },
    svg("M8 3h9a2 2 0 0 1 2 2v9M5 7h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"));
}
/// Short address in the accent with an outward arrow mark.
export function extLink(href, text, title) {
  return el("a", { class: "ext", href, target: href.startsWith("http") ? "_blank" : null, rel: "noopener", title: title || "", text }, svg("M7 17L17 7M9 7h8v8"));
}
export function addrChip(label, addr) {
  return el("span", { class: "addr" },
    el("span", { class: "label", text: label }),
    el("span", { class: "mono", text: short(addr, 5), title: addr }),
    copyButton(addr, "Copy " + label.toLowerCase()));
}
export function extLinks(addr) {
  return el("span", { class: "ext-links" },
    el("a", { href: explorer("account", addr), target: "_blank", rel: "noopener", text: "Solscan" }),
    el("a", { href: explorer("account", addr, "solanafm"), target: "_blank", rel: "noopener", text: "Solana FM" }));
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = null; } }
  });
  await Promise.all(workers);
  return out;
}

// ---- collectible pieces -------------------------------------------------------------------------

export function randomSeedHex() { const b = new Uint8Array(16); crypto.getRandomValues(b); return H.collectible.hexOf(b); }
export const hueToByte = (deg) => Math.max(0, Math.min(255, Math.round((Number(deg) * 255) / 360)));
export const byteToHue = (b) => Math.round((Number(b) * 360) / 255);
/// art[0] theme, art[1] background hue, art[2] main hue, art[3] accent hue, art[4] hue spread, art[5] rare chance.
export function artFromHues({ bg, main, accent, spread, theme = 0, rare = 12 }) {
  const a = new Uint8Array(16);
  a[0] = theme; a[1] = hueToByte(bg); a[2] = hueToByte(main); a[3] = hueToByte(accent); a[4] = Math.max(1, Math.min(255, Math.round(spread))); a[5] = rare;
  return a;
}
export function pieceDataUrl(artHex, seedHex, size = 96) { return "data:image/svg+xml;utf8," + encodeURIComponent(H.renderPieceSvg(artHex, seedHex, size)); }
export function pieceImg(artHex, seedHex, size = 96, alt = "") {
  return el("img", { class: "piece-img", src: pieceDataUrl(artHex, seedHex, size), width: size, height: size, alt, loading: "lazy" });
}
/// A piece tile: image, name, rarity tag, optional sub line.
export function pieceTile(artHex, seedHex, name, sub) {
  const t = H.pieceTraits(artHex, seedHex);
  return el("div", { class: "piece" }, pieceImg(artHex, seedHex, 96, name || "piece"),
    el("div", { class: "n", text: name || "" }),
    el("div", { class: "meta" }, el("span", { class: "tag" + (t.rarity === "rare" ? " accent" : ""), text: t.rarity }), sub ? el("span", { class: "dim", text: sub }) : null));
}

/// A piece that is earned but has no look yet: an empty tile with a short label.
export function pieceBlank(label, pulsing) {
  return el("div", { class: "piece blank" }, el("div", { class: "piece-img blank-img" + (pulsing ? " pulsing" : "") }), el("div", { class: "n", text: label }));
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Four sliders (background, body and accent hue, spread) with a strip of six sample pieces.
/// Returns { node, art() -> Uint8Array(16), shuffle() }.
export function artEditor(initial, onChange) {
  const a0 = initial && initial.length === 16 ? initial : artFromHues({ bg: 240, main: 330, accent: 40, spread: 24 });
  const st = { bg: byteToHue(a0[1]), main: byteToHue(a0[2]), accent: byteToHue(a0[3]), spread: a0[4] || 24, theme: a0[0], rare: a0[5] || 12 };
  let seeds = Array.from({ length: 6 }, randomSeedHex);
  const strip = el("div", { class: "piece-strip" });
  const art = () => artFromHues(st);
  const draw = () => { const hex = H.collectible.hexOf(art()); strip.replaceChildren(...seeds.map((s) => pieceImg(hex, s, 72, "sample piece"))); };
  const row = (label, key, min, max, unit) => {
    const out = el("output", { class: "mono", text: st[key] + unit });
    const input = el("input", { type: "range", min, max, step: 1, value: st[key], "aria-label": label });
    input.addEventListener("input", () => { st[key] = Number(input.value); out.textContent = st[key] + unit; draw(); if (onChange) onChange(art()); });
    return el("div", { class: "rg-field" }, el("span", { class: "label" }, el("span", { text: label }), out), input);
  };
  const shuffle = () => { seeds = Array.from({ length: 6 }, randomSeedHex); draw(); };
  const node = el("div", { class: "art-editor" },
    el("div", { class: "art-sliders" }, row("Background hue", "bg", 0, 360, " deg"), row("Body hue", "main", 0, 360, " deg"), row("Accent hue", "accent", 0, 360, " deg"), row("Hue spread between pieces", "spread", 1, 90, " deg")),
    el("div", { class: "art-preview" }, strip, el("button", { class: "btn btn-sm", type: "button", text: "Shuffle samples", onclick: (e) => { e.preventDefault(); shuffle(); } })));
  draw();
  return { node, art, shuffle };
}
