// The owner's command line for the review requests of Custom hooks. It is the only way to
// change a request's status. Run it on the server, next to the site, as the site's user.
//
//   node scripts/hook-reviews.mjs list                          one line per request: id, status, name, created, SOL paid
//   node scripts/hook-reviews.mjs show <id>                     every field of one request, the X and Telegram handles, the contact and the history included
//   node scripts/hook-reviews.mjs set <id> <status> [note...]   sets the status and the note the request page shows (no words: no note)
//   node scripts/hook-reviews.mjs report <id> <url or path>     links the request to its review report (https address or /path on the site)
//   node scripts/hook-reviews.mjs program <id> <program>        sets the program id by hand (the status stays)
//
// The statuses: waiting, in-review, changes-needed, passed, checking, approved, rejected.
// The file is REVIEWS_FILE, or state/hook-reviews.json in the folder above web/, the same
// default as the server. Every change takes the store's lock, reads the file again, changes
// one request, adds a line to its history and writes the file atomically, so a request the
// server takes at the same time is kept.
import { ReviewStore, STATUSES, adminSetProgram, adminSetReport, adminSetStatus, defaultReviewsFile, solOf, statusText } from "../web/api/_reviews.js";

const [cmd, id, ...rest] = process.argv.slice(2);
const file = process.env.REVIEWS_FILE || defaultReviewsFile();
const store = new ReviewStore(file, { log: (line) => console.error(line) });

const USAGE = [
  "usage:",
  "  node scripts/hook-reviews.mjs list",
  "  node scripts/hook-reviews.mjs show <id>",
  "  node scripts/hook-reviews.mjs set <id> <status> [note words...]",
  "  node scripts/hook-reviews.mjs report <id> <url or site path>",
  "  node scripts/hook-reviews.mjs program <id> <program>",
  "statuses: " + Object.keys(STATUSES).join(", "),
].join("\n");

const pad = (v, w) => { const t = String(v ?? ""); return t.length >= w ? t.slice(0, w) : t + " ".repeat(w - t.length); };
const when = (iso) => String(iso || "").replace("T", " ").replace(/\.\d+Z$/, "Z");

function printRequest(r) {
  const lines = [
    ["id", r.id], ["status", r.status + " (" + statusText(r.status) + ")"], ["note", r.note || "(none)"],
    ["name", r.name], ["repo", r.repo], ["commit", r.commit], ["wallet", r.wallet], ["x", r.x || "(none)"], ["telegram", r.telegram || "(none)"], ["contact", r.contact || "(none)"],
    ["paid", r.paid ? solOf(r.paid.lamports) + " SOL (" + r.paid.lamports + " lamports) in " + r.paid.signature + ", slot " + r.paid.slot + ", block time " + r.paid.blockTime : "(none)"],
    ["program", r.program || "(none)"], ["report", r.report || "(none)"], ["created", when(r.createdAt)], ["updated", when(r.updatedAt)],
  ];
  for (const [k, v] of lines) console.log(pad(k, 9) + v);
  console.log("description");
  for (const l of String(r.description || "").split("\n")) console.log("  " + l);
  console.log("history");
  for (const h of r.history || []) console.log("  " + when(h.at) + "  " + pad(h.status, 15) + (h.note || ""));
}

function run() {
  if (cmd === "list") {
    const data = store.read();
    const all = Object.values(data.requests).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    console.log(pad("ID", 18) + pad("STATUS", 16) + pad("NAME", 34) + pad("CREATED", 22) + "PAID SOL");
    for (const r of all) console.log(pad(r.id, 18) + pad(r.status, 16) + pad(r.name, 34) + pad(when(r.createdAt), 22) + (r.paid ? solOf(r.paid.lamports) : "-"));
    console.log(all.length + " requests, " + Object.keys(data.quotes).length + " quotes kept. File: " + store.file);
    return 0;
  }
  if (cmd === "show" && id && rest.length === 0) {
    const r = store.read().requests[id];
    if (!r) { console.error("No review request has the id " + id + "."); return 1; }
    printRequest(r);
    return 0;
  }
  if (cmd === "set" && id && rest.length >= 1) {
    const r = adminSetStatus(store, id, rest[0], rest.slice(1).join(" "));
    console.log("request " + r.id + " is now " + r.status + (r.note ? ", note: " + r.note : ", no note"));
    if (r.status === "approved") console.log("This sets the status only. The program goes on the approved list on chain with the platform admin's approve_hook.");
    return 0;
  }
  if (cmd === "report" && id && rest.length === 1) {
    const r = adminSetReport(store, id, rest[0]);
    console.log("request " + r.id + " links to the report " + r.report);
    return 0;
  }
  if (cmd === "program" && id && rest.length === 1) {
    const r = adminSetProgram(store, id, rest[0]);
    console.log("request " + r.id + " has the program " + r.program + " (status " + r.status + ")");
    return 0;
  }
  console.error(USAGE);
  return 2;
}

try {
  process.exitCode = run();
} catch (e) {
  console.error(e && e.admin ? e.message : "failed: " + String((e && e.message) || e));
  process.exitCode = 1;
}
