// Get your hook reviewed. The page says what the review is, its rules and its two costs, and
// holds the request form: the five fields are checked first, then the wallet pays the review fee
// and the request goes out in the same step. With ?id=<id> the page shows that one request
// instead: its status, Programmable's note, the payment, and once the code passed, the form that
// gives the program id with a signed message.
//
// The review API (API.md, "Hook reviews"):
//   GET  /api/v1/hook-reviews/price            { usd, solUsd, lamports, treasury, source, at }
//   POST /api/v1/hook-reviews/quote  {wallet}  { id, wallet, lamports, usd, solUsd, treasury, memo, expiresAt }
//   POST /api/v1/hook-reviews        {id, signature, name, repo, commit, description, x?, telegram?}
//   GET  /api/v1/hook-reviews/<id>             the public view of one request
//   POST /api/v1/hook-reviews/<id>/program {program, signature}
// Errors are { error: { code, message } }. Every text the API sends is put on the page as text.
import { boot, ctx, H, Wallet, $, el, fmtSol, short, explorer, sendIxs, openWallet, webHref, setTitle, fmtDate, platform, checkHook, copyButton, sleep } from "./common.js";

await boot("review-hook.html");
const { PublicKey } = H;

// ---- small helpers --------------------------------------------------------------------------------------

/// The API's answer, or a thrown ApiError with its code and its message.
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
/// An X or Telegram handle as "@name", whether it was typed with or without the "@" or as a profile
/// link; "" when the field is empty. The review service checks the same rules again.
function handleOf(v) {
  let s = String(v || "").trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\//i, "").replace(/^(www\.)?(x\.com|twitter\.com|t\.me)\//i, "").replace(/\/+$/, "").replace(/^@/, "");
  return "@" + s;
}
const X_RE = /^@[A-Za-z0-9_]{1,15}$/;
const TG_RE = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
async function api(path, body) {
  const opts = body === undefined ? { cache: "no-store" } : { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch("/api/v1/" + path, opts); } catch (_) { throw new ApiError(0, "NETWORK", "The site did not answer. Check your connection and try again."); }
  let j = null;
  try { j = await r.json(); } catch (_) {}
  if (!r.ok) {
    const e = j && j.error && typeof j.error === "object" ? j.error : {};
    throw new ApiError(r.status, typeof e.code === "string" ? e.code : "HTTP_" + r.status, typeof e.message === "string" && e.message ? e.message : "The review service answered " + r.status + ". Try again in a minute.");
  }
  if (!j || typeof j !== "object") throw new ApiError(r.status, "EMPTY", "The review service sent an empty answer. Try again in a minute.");
  return j;
}
/// Bytes as base58, the way Solana writes keys and signatures.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
/// Kept in this browser only. A private window or blocked storage just keeps nothing.
const STORE_PENDING = "Programmable.reviewPending", STORE_MINE = "Programmable.reviewRequests";
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v === null ? d : v; } catch (_) { return d; } };
const save = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
/// An id of a request as the API makes them: 16 hex characters. Anything close to that is asked for; the API decides.
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const usdText = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
/// A time the API sends (an ISO string, or seconds or milliseconds since 1970) in the reader's own time zone.
function when(v) {
  const ms = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v || ""));
  return Number.isFinite(ms) && ms > 0 ? fmtDate(Math.floor(ms / 1000)) : "";
}
/// The address of a report: a web address, or a page of this site's reviews folder.
function reportHref(v) {
  const s = String(v || "").trim();
  if (webHref(s)) return s;
  return /^\/?reviews\/[A-Za-z0-9_-]+\.html$/.test(s) ? s.replace(/^\//, "") : "";
}
function canSignMessage() {
  const W = Wallet.current();
  if (!W.raw) return false;
  return W.kind === "standard" ? !!(W.raw.features && W.raw.features["solana:signMessage"]) : typeof W.raw.signMessage === "function";
}

const asked = new URLSearchParams(location.search).get("id");
if (asked !== null) await showStatus(asked.trim());
else await showForm();

// ---- the form ---------------------------------------------------------------------------------------------

async function showForm() {
  // S.price: the last price the API gave. S.quote: an open quote for the connected wallet.
  // S.paid: a fee that went through for a request the API has not taken yet; the next press
  // sends that request again and pays nothing.
  const S = { price: null, priceErr: "", quote: null, paid: null, busy: false, label: "" };

  // the five fields, checked as the review service checks them, before anything is paid
  const FIELDS = [
    ["fName", "eName", (v) => (!v ? "Give the hook a name." : v.length > 32 ? "The name has " + v.length + " characters. The most is 32." : !/^[\x20-\x7E]+$/.test(v) ? "Use plain letters, digits, spaces and punctuation only." : "")],
    ["fRepo", "eRepo", (v) => {
      if (!v) return "Give the address of the public repository.";
      if (v.length > 200) return "The address has " + v.length + " characters. The most is 200.";
      const m = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(v);
      if (!m || [m[2], m[3]].some((p) => /^\.+$/.test(p))) return "Give the https address of the repository on github.com, gitlab.com or codeberg.org, such as https://github.com/you/your-hook.";
      return "";
    }],
    ["fCommit", "eCommit", (v) => (!v ? "Give the commit Programmable should review." : !/^[0-9a-f]{40}$/.test(v.toLowerCase()) ? "A commit is its full hash: 40 characters, 0 to 9 and a to f." : "")],
    ["fDesc", "eDesc", (v) => (!v ? "Say what the hook does." : v.length > 2000 ? "The text has " + v.length.toLocaleString("en-US") + " characters. The most is 2,000." : "")],
    ["fX", "eX", (v) => (!v || X_RE.test(handleOf(v)) ? "" : "An X handle has 1 to 15 letters, digits or underscores, such as @yourname.")],
    ["fTg", "eTg", (v) => (!v || TG_RE.test(handleOf(v)) ? "" : "A Telegram handle has 5 to 32 letters, digits or underscores and starts with a letter, such as @yourname.")],
  ];
  /// The fields as the API takes them, or null after marking what is wrong.
  function readFields(mark = true) {
    let first = null;
    for (const [id, err, check] of FIELDS) {
      const why = check($(id).value.trim());
      if (mark) { $(err).textContent = why; $(id).setAttribute("aria-invalid", why ? "true" : "false"); }
      if (why && !first) first = id;
    }
    if (first) { if (mark) $(first).focus(); return null; }
    const out = { name: $("fName").value.trim(), repo: $("fRepo").value.trim(), commit: $("fCommit").value.trim().toLowerCase(), description: $("fDesc").value.trim() };
    const x = handleOf($("fX").value), tg = handleOf($("fTg").value);
    if (x) out.x = x;
    if (tg) out.telegram = tg;
    return out;
  }
  // a field that was marked is checked again as it is typed in, so its line goes away once it is right
  for (const [id, err, check] of FIELDS) $(id).addEventListener("input", () => {
    if ($(id).getAttribute("aria-invalid") === "true") { const why = check($(id).value.trim()); $(err).textContent = why; $(id).setAttribute("aria-invalid", why ? "true" : "false"); }
    counts();
  });
  function counts() {
    const n = $("fName").value.trim().length, d = $("fDesc").value.trim().length;
    $("nameCount").textContent = n ? n + "/32" : "at most 32 characters";
    $("nameCount").classList.toggle("over", n > 32);
    $("descCount").textContent = d ? d.toLocaleString("en-US") + "/2,000" : "at most 2,000 characters";
    $("descCount").classList.toggle("over", d > 2000);
  }

  // ---- the price ----
  async function readPrice() {
    try {
      const p = await api("hook-reviews/price");
      const lamports = BigInt(String(p.lamports));
      if (lamports <= 0n) throw new ApiError(0, "BAD_PRICE", "The review service sent a price of zero.");
      S.price = { usd: Number(p.usd) || 25, solUsd: Number(p.solUsd) || 0, lamports, treasury: new PublicKey(String(p.treasury)) };
      S.priceErr = "";
    } catch (e) {
      S.price = null;
      S.priceErr = e.code === "PRICE_UNAVAILABLE" ? "The SOL price could not be read right now, so the fee in SOL is not known. Try again in a minute." : e.message || "The price could not be read.";
    }
    drawPrice();
  }
  function drawPrice() {
    const p = S.price;
    $("feeUsd").textContent = usdText(p ? p.usd : 25);
    $("sUsd").textContent = usdText(p ? p.usd : 25) + " USD";
    if (!p) {
      $("feeSol").textContent = S.priceErr; $("feeSol").classList.add("bad");
      $("sSol").textContent = ""; $("sTo").textContent = "";
      $("payLine").className = "rv-pay off"; $("payLine").textContent = S.priceErr;
    } else {
      $("feeSol").classList.remove("bad");
      $("feeSol").replaceChildren(el("span", { class: "mono", id: "feeSolAmount", text: fmtSol(p.lamports, 6) + " SOL" }), " now" + (p.solUsd ? ", at " + usdText(p.solUsd) + " USD a SOL" : ""));
      $("sSol").textContent = fmtSol(p.lamports, 6) + " SOL";
      const to = p.treasury.toBase58();
      $("sTo").replaceChildren(el("a", { class: "link mono", href: explorer("account", to), target: "_blank", rel: "noopener", title: to, text: short(to, 4) }));
      $("payLine").className = "rv-pay";
      $("payLine").replaceChildren("You will pay ", el("span", { class: "mono", id: "payAmount", text: fmtSol(p.lamports, 6) + " SOL" }), " (" + usdText(p.usd) + " USD).");
    }
    drawButton();
  }

  // ---- the button and the wallet ----
  function drawButton() {
    const btn = $("payBtn"), W = Wallet.current();
    $("sWallet").replaceChildren(W.publicKey ? el("span", { class: "mono", title: W.publicKey.toBase58(), text: short(W.publicKey.toBase58(), 4) }) : "not connected");
    if (S.busy) { btn.disabled = true; btn.textContent = S.label; return; }
    if (!W.publicKey) { btn.disabled = false; btn.textContent = "Connect wallet"; return; }
    if (S.paid) { btn.disabled = false; btn.textContent = "Send the request again"; return; }
    btn.textContent = "Pay and send";
    btn.disabled = !S.price;
  }
  const busy = (label) => { S.busy = true; S.label = label; drawButton(); };
  const say = (...nodes) => $("result").replaceChildren(...nodes);
  const bad = (text) => el("p", { class: "bad", text });

  async function press() {
    if (S.busy) return;
    const W = Wallet.current();
    if (!W.publicKey) { openWallet(); return; }
    const values = readFields();
    if (!values) { say(bad(S.paid ? "Fix the fields marked in red, then send the request again. Your fee is paid already." : "Fix the fields marked in red. Nothing was paid.")); return; }
    say();
    // a fee that went through already: only the request goes out again
    if (S.paid) { try { await submit(S.paid, values); } finally { S.busy = false; drawButton(); } return; }
    if (!S.price) { say(bad(S.priceErr || "The price is not known yet. Nothing was paid.")); return; }
    let paidNow = false;
    try {
      busy("Preparing");
      // a quote binds this wallet and the amount for 30 minutes, and is used once
      let q = S.quote;
      if (!q || q.wallet !== W.publicKey.toBase58() || q.expiresAt - Date.now() < 60_000) { q = await quote(W.publicKey); S.quote = q; }
      // the line beside the button is what the wallet will show: a higher amount is shown first and asked for again
      if (q.lamports > S.price.lamports) {
        S.price = { ...S.price, lamports: q.lamports, usd: q.usd || S.price.usd, solUsd: q.solUsd || S.price.solUsd };
        S.busy = false; drawPrice();
        say(bad("The SOL price moved. You will now pay " + fmtSol(q.lamports, 6) + " SOL. Press the button again to pay it. Nothing was paid."));
        return;
      }
      if (q.lamports !== S.price.lamports) { S.price = { ...S.price, lamports: q.lamports }; drawPrice(); }
      busy("Confirm in your wallet");
      const ixs = [
        H.SystemProgram.transfer({ fromPubkey: W.publicKey, toPubkey: q.treasury, lamports: q.lamports }),
        // the note that names the request, read by the review service from the transaction
        new H.TransactionInstruction({ programId: H.MEMO_PROGRAM, keys: [], data: Buffer.from(q.memo, "utf8") }),
      ];
      const signature = await sendIxs(ixs, [], "review fee");
      paidNow = true;
      S.paid = { id: q.id, signature, wallet: W.publicKey.toBase58(), lamports: String(q.lamports) };
      S.quote = null;
      // until the service has the request, this browser keeps what it needs to send it again
      save(STORE_PENDING, { ...S.paid, fields: values, at: Date.now() });
      await submit(S.paid, values);
    } catch (e) {
      say(bad(e.message + (paidNow || /Nothing was (sent|paid)/.test(e.message) ? "" : " Nothing was paid.")));
    } finally {
      S.busy = false; drawButton();
    }
  }
  /// A quote from the API, checked: the treasury must be the platform's own, read from the chain.
  async function quote(wallet) {
    const j = await api("hook-reviews/quote", { wallet: wallet.toBase58() });
    let treasury;
    try { treasury = new PublicKey(String(j.treasury)); } catch (_) { throw new Error("The review service named no valid treasury."); }
    const plat = await platform().catch(() => null);
    if (!plat) throw new Error("The platform account could not be read from " + ctx.rpcHost + ", so the treasury cannot be checked.");
    if (!plat.treasury.equals(treasury)) throw new Error("The review service named another treasury than the platform's own.");
    if (typeof j.id !== "string" || !ID_RE.test(j.id) || typeof j.memo !== "string" || !j.memo || j.memo.length > 200) throw new Error("The review service sent a quote this page cannot read.");
    const lamports = BigInt(String(j.lamports));
    if (lamports <= 0n) throw new Error("The review service sent a fee of zero.");
    const expiresAt = Date.parse(String(j.expiresAt)) || Date.now() + 25 * 60_000;
    return { id: j.id, wallet: String(j.wallet || wallet.toBase58()), lamports, usd: Number(j.usd) || 0, solUsd: Number(j.solUsd) || 0, treasury, memo: j.memo, expiresAt };
  }
  /// Send the request of a paid fee. The service may not see the payment for a few seconds:
  /// it answers NOT_CONFIRMED_YET, and the page asks again every six seconds (the service takes ten
  /// requests a minute from one address) for a minute and a half.
  async function submit(paid, values) {
    busy("Sending the request");
    const body = { id: paid.id, signature: paid.signature, ...values };
    const start = Date.now();
    for (;;) {
      try {
        const r = await api("hook-reviews", body);
        const id = typeof r.id === "string" && ID_RE.test(r.id) ? r.id : paid.id;
        save(STORE_PENDING, null);
        const mine = load(STORE_MINE, []).filter((m) => m && m.id !== id);
        mine.unshift({ id, name: values.name, at: Date.now() });
        save(STORE_MINE, mine.slice(0, 20));
        S.paid = null;
        say(el("p", { class: "ok", text: "Sent. Opening your request." }));
        const u = new URL(location.href); u.searchParams.set("id", id);
        location.assign(u.href);
        return;
      } catch (e) {
        if (e.code === "NOT_CONFIRMED_YET" && Date.now() - start < 90_000) {
          say(el("p", { class: "help", id: "waitLine", text: "Your fee is paid. The review service does not see the payment yet, so the page asks again every six seconds. " + Math.round((Date.now() - start) / 1000) + " s so far." }));
          await sleep(6000);
          continue;
        }
        afterPayFailed(e, paid);
        return;
      }
    }
  }
  /// The fee went through and the request did not. The form stays filled; the next press sends
  /// it again without a new payment. The two lines a developer needs to write to Programmable.
  function afterPayFailed(e, paid) {
    const sig = paid.signature;
    say(bad(e.code === "NOT_CONFIRMED_YET" ? "The review service did not see your payment within a minute and a half." : e.message),
      el("div", { class: "note warn", id: "paidNote" },
        el("b", { text: "Your fee is paid." }),
        el("p", { style: "margin: 4px 0 8px", text: "Fix what the line above says and press Send the request again. It pays nothing more. If it keeps failing, open a ticket in Programmable's Discord with these two lines." }),
        el("div", { class: "kv", style: "font-size: var(--fs-sm)" },
          el("span", { class: "muted", text: "Request" }), el("span", { class: "mono", id: "paidId", text: paid.id }),
          el("span", { class: "muted", text: "Payment" }), el("span", null, el("a", { class: "link mono", id: "paidSig", href: explorer("tx", sig), target: "_blank", rel: "noopener", title: sig, text: short(sig, 8) }), copyButton(sig, "Copy the payment signature")))));
  }

  // ---- a paid request this browser could not send, and the requests it sent ----
  async function pendingNote() {
    const p = load(STORE_PENDING, null);
    const box = $("pending");
    if (!p || typeof p.id !== "string" || typeof p.signature !== "string" || !p.fields) { box.hidden = true; return; }
    // the service may have taken it after all: then it is a request like the others
    // (an answer other than the request itself, a 404 or a failed read, offers to send it)
    try {
      await api("hook-reviews/" + encodeURIComponent(p.id));
      save(STORE_PENDING, null);
      const mine = load(STORE_MINE, []);
      if (!mine.some((m) => m && m.id === p.id)) { mine.unshift({ id: p.id, name: String(p.fields.name || ""), at: p.at || Date.now() }); save(STORE_MINE, mine.slice(0, 20)); }
      box.hidden = true; drawMine();
      return;
    } catch (_) {}
    box.hidden = false;
    box.replaceChildren(el("div", { class: "note warn" },
      el("b", { text: "A paid request from this browser was not sent." }),
      el("p", { style: "margin: 4px 0 0", text: "Its fee went through, so sending it costs nothing more. The form below holds it again." }),
      el("button", { class: "btn btn-sm", type: "button", id: "pendingBtn", text: "Send it now", onclick: async () => {
        for (const [k, id] of [["name", "fName"], ["repo", "fRepo"], ["commit", "fCommit"], ["description", "fDesc"], ["x", "fX"], ["telegram", "fTg"]]) $(id).value = String(p.fields[k] || "");
        counts();
        S.paid = { id: p.id, signature: p.signature, wallet: p.wallet, lamports: p.lamports };
        box.hidden = true; drawButton();
        $("payBtn").scrollIntoView({ block: "center" });
        await press();
      } })));
  }
  function drawMine() {
    const mine = load(STORE_MINE, []).filter((m) => m && typeof m.id === "string" && ID_RE.test(m.id));
    $("mine").hidden = !mine.length;
    $("mineList").replaceChildren(...mine.map((m) => el("li", null,
      el("a", { class: "link", href: "review-hook.html?id=" + encodeURIComponent(m.id), text: String(m.name || "Review request").slice(0, 40) }),
      el("span", { class: "mono dim", text: m.id }),
      m.at ? el("span", { class: "dim", text: when(Number(m.at)) }) : null)));
  }

  $("payBtn").addEventListener("click", press);
  Wallet.onChange(drawButton);
  counts();
  // until the price is read the page keeps its "Reading" lines, and the button waits for it
  drawButton();
  drawMine();
  await readPrice();
  pendingNote();
  // a price older than a minute is read again while the page stays open
  setInterval(() => { if (!S.busy && !document.hidden) readPrice(); }, 60_000);
}

// ---- one request --------------------------------------------------------------------------------------------

async function showStatus(id) {
  $("intro").hidden = true; $("status").hidden = false;
  const stateLine = (text) => { $("stPanel").hidden = true; $("progPanel").hidden = true; const s = $("stState"); s.hidden = false; s.replaceChildren(el("p", { text }), el("a", { class: "btn", href: "review-hook.html", text: "Get your hook reviewed" })); };
  if (!ID_RE.test(id)) { stateLine("That is not the id of a review request."); return; }
  $("stSub").textContent = "Review request " + id;
  const WORD = { waiting: "Waiting", "in-review": "In review", "changes-needed": "Changes needed", passed: "Passed", checking: "Checking", approved: "Approved", rejected: "Not approved" };
  /// What the developer does, or waits for, after each status.
  const NEXT = {
    waiting: "A reviewer takes the requests in the order they were paid. Programmable answers in your Discord ticket, and this page shows every change.",
    "in-review": "A reviewer reads the commit against the ten review rules. The answer comes in your Discord ticket and on this page.",
    "changes-needed": "Change the code as the note says. A new commit needs a new request, with a new fee.",
    passed: "Use the kit's release steps. They deploy the commit, write the verified build record and freeze the program, in that order. The form below takes the program id.",
    checking: "Programmable checks on chain that the program is frozen and is the build of the reviewed commit. Then it goes on the approved list.",
    approved: "The hook is on the approved list. It shows in Custom hooks with the mark, and anyone can launch a coin on it.",
    rejected: "The note says why. Changed code is a new request with a new fee.",
  };
  const TONE = { "changes-needed": "warn", passed: "ok", approved: "ok", rejected: "bad" };
  let current = null;

  async function read() {
    try { current = await api("hook-reviews/" + encodeURIComponent(id)); draw(current); }
    catch (e) { stateLine(e.status === 404 ? "No review request has this id. Check the address of this page." : e.message); }
  }
  function draw(r) {
    $("stState").hidden = true; $("stPanel").hidden = false;
    const name = typeof r.name === "string" && r.name ? r.name : "";
    $("stName").textContent = name || "Review request";
    setTitle(name ? name + ", review request" : "Review request");
    const status = String(r.status || "");
    $("stBadge").textContent = WORD[status] || status;
    $("stBadge").className = "badge rv-st " + (TONE[status] || "");
    $("stBadge").dataset.status = status;
    $("stText").textContent = String(r.statusText || "");
    // the Discord ticket: the request id to paste, with a copy button
    $("stTicketId").textContent = id;
    $("stTicketCopy").replaceChildren(copyButton(id, "Copy the request id"));
    $("stTicket").hidden = status === "approved" || status === "rejected";
    $("stNext").textContent = NEXT[status] || "This page shows every change of your request.";
    const note = typeof r.note === "string" ? r.note.trim() : "";
    $("stNote").hidden = !note; $("stNoteText").textContent = note;
    const facts = [];
    const row = (label, ...value) => facts.push(el("dt", { text: label }), el("dd", null, ...value));
    const repo = String(r.repo || "");
    row("Repository", webHref(repo) ? el("a", { class: "link", id: "stRepo", href: repo, target: "_blank", rel: "noopener", text: repo }) : el("span", { id: "stRepo", text: repo }));
    row("Commit", el("span", { class: "mono", id: "stCommit", text: String(r.commit || "") }));
    let program = null;
    try { program = r.program ? new PublicKey(String(r.program)) : null; } catch (_) {}
    if (program) {
      const p58 = program.toBase58();
      row("Program", el("span", { class: "mono", id: "stProgram", text: p58 }), " ", el("a", { class: "link", href: explorer("account", p58), target: "_blank", rel: "noopener", text: "Solscan" }),
        status === "approved" ? [" ", el("a", { class: "link", href: "workshop-hook.html?id=" + p58, text: "Its page in Custom hooks" })] : null);
    } else row("Program", el("span", { class: "muted", id: "stProgram", text: "not given yet" }));
    const report = reportHref(r.report);
    row("Report", report ? el("a", { class: "link", id: "stReport", href: report, ...(webHref(report) ? { target: "_blank", rel: "noopener" } : {}), text: "Read the report" }) : el("span", { class: "muted", id: "stReport", text: "not written yet" }));
    const paid = r.paid && typeof r.paid === "object" ? r.paid : {};
    let lamports = null;
    try { lamports = paid.lamports !== undefined && paid.lamports !== null ? BigInt(String(paid.lamports)) : null; } catch (_) {}
    if (lamports !== null) row("Review fee paid", el("span", { class: "mono", id: "stFee", text: fmtSol(lamports, 6) + " SOL" }));
    const sig = typeof paid.signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(paid.signature) ? paid.signature : "";
    if (sig) row("Payment", el("a", { class: "link mono", id: "stSig", href: explorer("tx", sig), target: "_blank", rel: "noopener", title: sig, text: short(sig, 8) }));
    if (when(r.createdAt)) row("Sent", el("span", { text: when(r.createdAt) }));
    if (when(r.updatedAt)) row("Last change", el("span", { text: when(r.updatedAt) }));
    $("stFacts").replaceChildren(...facts);
    // the program id form: only once the code passed, and while Programmable checks the program
    const open = status === "passed" || status === "checking";
    $("progPanel").hidden = !open;
    if (open) $("progLede").textContent = status === "checking" && program
      ? "Programmable is checking the program above. If you gave the wrong id, give the right one here."
      : "Deploy exactly the reviewed commit with the kit's release steps. Write the verified build record, then freeze the program. Then give its program id here.";
    drawMessage();
  }

  // ---- the program id, with a message the wallet signs ----
  const message = (program) => "Programmable hook review " + id + ": my program is " + program;
  function typedProgram() {
    const v = $("fProgram").value.trim();
    try { const k = new PublicKey(v); return k.toBase58() === v ? k : null; } catch (_) { return null; }
  }
  function drawMessage() {
    const k = typedProgram();
    $("progMsg").textContent = message(k ? k.toBase58() : "<program id>");
  }
  $("fProgram").addEventListener("input", () => { drawMessage(); $("eProgram").textContent = ""; $("fProgram").setAttribute("aria-invalid", "false"); });
  let sending = false;
  async function sendProgram() {
    if (sending) return;
    const out = $("progResult"), btn = $("progBtn");
    const fail = (text) => out.replaceChildren(el("p", { class: "bad", text }));
    const program = typedProgram();
    if (!program) { $("eProgram").textContent = "That is not a program address."; $("fProgram").setAttribute("aria-invalid", "true"); $("fProgram").focus(); return; }
    if (!Wallet.current().publicKey) { openWallet(); return; }
    if (!canSignMessage()) { fail("This wallet cannot sign a message. Phantom and Backpack can. Connect one of them with the wallet that paid the review fee."); return; }
    sending = true; btn.disabled = true; out.replaceChildren();
    try {
      // what the approval needs, read from the chain before the wallet opens
      btn.textContent = "Reading the program";
      const c = await checkHook(program);
      if (!c.exists || !c.executable) throw new Error("There is no program at this address on " + ctx.cluster + ".");
      if (c.frozen !== true) throw new Error("This program can still be upgraded. Freeze it first, as the kit's release steps do. Approval covers a frozen program only.");
      if (!c.manifest || c.extra === null) throw new Error("This program has no manifest or no list of extra accounts, so no pool could use it.");
      btn.textContent = "Sign in your wallet";
      const sig = await Wallet.signMessage(new TextEncoder().encode(message(program.toBase58())));
      btn.textContent = "Sending";
      await api("hook-reviews/" + encodeURIComponent(id) + "/program", { program: program.toBase58(), signature: base58(sig) });
      out.replaceChildren(el("p", { class: "ok", text: "Sent. Programmable now checks the program on chain." }));
      $("fProgram").value = "";
      await read();
    } catch (e) {
      fail(e.message);
    } finally {
      sending = false; btn.disabled = false; btn.textContent = "Sign and send";
    }
  }
  $("progBtn").addEventListener("click", sendProgram);
  $("stRefresh").addEventListener("click", async () => { $("stRefresh").disabled = true; await read(); $("stRefresh").disabled = false; });
  await read();
}
