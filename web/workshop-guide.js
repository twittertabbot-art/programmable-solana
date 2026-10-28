// Build a hook: four steps that mirror the real flow, each a numbered block that opens its detail. Step 1 turns ticked powers into the FLAGS
// line of lib.rs and into the sentences people will read. Step 3 is a form that produces the
// descriptor, checked by the same function the site uses when it reads one. Step 4 sends the
// builder to the review first (review-hook.html), then writes the deploy command for the
// address the descriptor is hosted at, for the commit that passed.
import { boot, ctx, H, $, el, platform, flagSentences, copy, fetchJson } from "./common.js";
import { checkDescriptor, descriptorUrl, readAddress, pinOf, setupFields, ARG_TYPES, KEY_NAMES, ROLES, ROLE_WORDS, MAX_URI_BYTES, MAX_PINNED_ADDRESS_BYTES } from "./workshop-lib.js";

await boot("workshop.html");

// ---- the four steps: a block opens its detail, one at a time ------------------------------------------------

const STEPS = [1, 2, 3, 4];
/// Open step n and close the others. 0 closes all of them.
function openStep(n) {
  for (const k of STEPS) {
    const on = k === n;
    $("step" + k + "Head").setAttribute("aria-expanded", on ? "true" : "false");
    $("step" + k + "Body").hidden = !on;
    $("step" + k).dataset.open = on ? "true" : "false";
  }
}
for (const k of STEPS) $("step" + k + "Head").addEventListener("click", () => openStep($("step" + k + "Head").getAttribute("aria-expanded") === "true" ? 0 : k));
const stepOfHash = () => { const m = /^#step([1-4])$/.exec(location.hash); return m ? Number(m[1]) : 0; };
window.addEventListener("hashchange", () => { if (stepOfHash()) openStep(stepOfHash()); });
openStep(stepOfHash() || 1);
const plat = await platform().catch(() => null);
const bytesOf = (s) => new TextEncoder().encode(s).length;
/// The cluster the deploy command names: the one this site runs on (the script takes localnet, devnet or mainnet).
const DEPLOY_CLUSTER = ["localnet", "devnet", "mainnet"].includes(ctx.cluster) ? ctx.cluster : "localnet";
// on a public cluster the local chain is for tests only: the pool program of this site runs there
if (DEPLOY_CLUSTER !== "localnet") $("chainNote").textContent = "Test your hook on this local chain first. Run these from the root of the package. This site runs on " + DEPLOY_CLUSTER + ", so the deploy command of step 4 names " + DEPLOY_CLUSTER + ".";
/// Does this site's upload endpoint store a descriptor? The operator says so in workshop/site.json.
const site = await fetchJson("workshop/site.json", 3000);
const canUpload = !!(site && site.descriptorUpload === true);
$("gUpload").hidden = !canUpload;
$("gHost").textContent = canUpload
  ? "Host the file at an address that will not change. This site can host it for you, and step 4 pins it."
  : "Host the file yourself, at an address that will not change. An address of at most " + MAX_PINNED_ADDRESS_BYTES + " bytes can be pinned in step 4.";

// ---- step 1: the flags ---------------------------------------------------------------------------------

const CALLS = [
  ["CALL_ON_BUY", "On buys"],
  ["CALL_ON_SELL", "On sells"],
  ["BEFORE_SWAP", "Before the trade. Its answer can change what the trade pays."],
  ["AFTER_SWAP", "After the trade. It watches, and it can refuse the trade by failing."],
  ["BEFORE_ADD_LIQ", "Before liquidity is added. It can refuse the deposit."],
  ["AFTER_ADD_LIQ", "After liquidity is added. It can refuse the deposit by failing."],
  ["BEFORE_REMOVE_LIQ", "Before liquidity is removed. It can refuse the withdrawal."],
  ["AFTER_REMOVE_LIQ", "After liquidity is removed. It can refuse the withdrawal by failing."],
  ["ON_POOL_CREATE", "Once, when a pool is created on it. Needed when it keeps settings for each pool."],
];
const POWERS = [
  ["TAKE_HOOK_FEE", "Take a fee to a treasury, in the quote token"],
  ["OVERRIDE_FEE", "Set the pool's own fee for one trade"],
  ["OVERRIDE_CURVE", "Set the price itself"],
];
// the kit's template as it ships
let flags = H.FLAGS.BEFORE_SWAP | H.FLAGS.ON_POOL_CREATE | H.FLAGS.TAKE_HOOK_FEE | H.FLAGS.CALL_ON_BUY | H.FLAGS.CALL_ON_SELL;

function flagItem([name, words]) {
  const box = el("input", { type: "checkbox", "data-flag": name });
  box.checked = (flags & H.FLAGS[name]) !== 0;
  box.addEventListener("change", () => { flags = box.checked ? flags | H.FLAGS[name] : flags & ~H.FLAGS[name]; drawFlags(); });
  return el("li", null, el("label", null, box, el("span", null, words, el("code", { text: name }))));
}
function drawFlags() {
  const names = Object.keys(H.FLAGS).filter((k) => (flags & H.FLAGS[k]) !== 0);
  $("flagRust").textContent = "pub const FLAGS: u32 = " + (names.join(" | ") || "0") + ";\n// the number a pool stores: " + flags;
  $("flagWords").replaceChildren(...flagSentences(flags, "custom", null, plat).map((t) => el("li", { text: t })));
  const has = (f) => (flags & H.FLAGS[f]) !== 0;
  const warn = [];
  if ((has("TAKE_HOOK_FEE") || has("OVERRIDE_FEE") || has("OVERRIDE_CURVE")) && !has("BEFORE_SWAP")) warn.push("The pool reads an answer from the call before the trade only. Without that call a fee, a pool fee or a price is never used.");
  if (has("OVERRIDE_CURVE")) warn.push("The launchpad does not take a hook that sets the price itself. Such a hook gets a pool through the pool program, not through a launch on this site.");
  const w = $("flagWarn");
  w.hidden = !warn.length; w.textContent = warn.join(" ");
}
$("flagCalls").replaceChildren(...CALLS.map(flagItem));
$("flagPowers").replaceChildren(...POWERS.map(flagItem));
drawFlags();

// ---- step 3: the descriptor ------------------------------------------------------------------------------

/// The form starts as the descriptor of the kit's template, hook-template/hook.json, without
/// its program id. web/review/flow-workshop.mjs compares the two.
const START = {
  programmable_hook: 1,
  program: "",
  name: "Fixed fee",
  summary: "Takes a fixed share of every buy and every sell, in SOL, for a wallet the launcher names.",
  rules: [
    "Every buy and every sell pays the fee the launcher set.",
    "The fee goes to the wallet the launcher named. The author of this hook gets none of it.",
    "The owner of a coin's settings can change the fee at any time, from zero up to the ceiling.",
    "The ceiling is set at launch, is at most 10%, and never changes.",
    "The owner can hand the settings to another wallet, or give them up for good.",
  ],
  source: "https://example.com/hook-template/programs/my_hook/src/lib.rs",
  author: "The hook kit",
  setup: {
    instruction: "init_pool_config",
    args: [
      { name: "pool", type: "pool" },
      { name: "fee_bps", type: "u16", label: "Fee on every trade", unit: "%", decimals: 2, min: 0, max: 10, default: 2.5, help: "The share of every buy and every sell that goes to the treasury." },
      { name: "max_bps", type: "u16", label: "Ceiling", unit: "%", decimals: 2, min: 0, max: 10, default: 5, help: "The fee can never be raised above this. It cannot be changed after the launch." },
    ],
    accounts: [
      { role: "launcher" },
      { role: "launcher" },
      { role: "pda", seeds: ["cfg", { key: "pool" }], writable: true },
      { role: "system_program" },
    ],
  },
};

const text = (v) => (v === undefined || v === null ? "" : String(v));
/// A number stays a number in the JSON when it prints back as typed. "0.000000001" stays text.
const numOrText = (t) => { const n = Number(t); return t !== "" && Number.isFinite(n) && String(n) === t ? n : t; };
function field(label, key, value, opts = {}) {
  const input = el("input", { class: "input" + (opts.mono ? " mono" : ""), "data-k": key, autocomplete: "off", spellcheck: "false", placeholder: opts.placeholder || null, inputmode: opts.inputmode || null });
  input.value = text(value);
  return el("label", { class: "field " + (opts.cls || ""), "data-f": key }, el("span", null, el("span", { text: label }), opts.hint ? el("span", { class: "dim", text: opts.hint }) : null), input);
}
function tools(box, what) {
  return el("div", { class: "tools" },
    el("span", { class: "cap" }),
    el("button", { class: "btn btn-sm", type: "button", text: "Move up", "aria-label": "Move this " + what + " up", onclick: () => { if (box.previousElementSibling) box.parentNode.insertBefore(box, box.previousElementSibling); judged = true; update(); } }),
    el("button", { class: "btn btn-sm", type: "button", text: "Remove", "aria-label": "Remove this " + what, onclick: () => { box.remove(); judged = true; update(); } }));
}

function argRow(a = { type: "u64" }) {
  const box = el("div", { class: "rowbox", "data-row": "arg" });
  const type = el("select", { "data-k": "type", "aria-label": "Type" },
    ...Object.keys(ARG_TYPES).map((t) => el("option", { value: t, text: t })),
    ...KEY_NAMES.map((k) => el("option", { value: k, text: k + ", filled in by the site" })));
  type.value = a.type in ARG_TYPES || KEY_NAMES.includes(a.type) ? a.type : "u64";
  const chosen = el("div", { "data-part": "chosen" },
    el("div", { class: "row" }, field("Label a launcher reads", "label", a.label, { cls: "wide" }), field("Unit", "unit", a.unit, { cls: "narrow", placeholder: "%" }), field("Decimals", "decimals", a.decimals, { cls: "narrow", inputmode: "numeric", placeholder: "0" })),
    el("div", { class: "row" }, field("Min", "min", a.min, { cls: "narrow", mono: true }), field("Max", "max", a.max, { cls: "narrow", mono: true }), field("Default", "default", a.default, { cls: "narrow", mono: true })),
    field("Help sentence", "help", a.help));
  const shape = () => {
    const t = type.value;
    chosen.hidden = KEY_NAMES.includes(t);
    const plain = t === "bool" || t === "pubkey";
    for (const k of ["decimals", "min", "max"]) chosen.querySelector('[data-f="' + k + '"]').hidden = plain;
    chosen.querySelector('[data-f="unit"]').hidden = t === "pubkey";
    chosen.querySelector('[data-k="default"]').placeholder = t === "bool" ? "true or false" : t === "pubkey" ? "launcher, or empty" : "";
  };
  type.addEventListener("change", shape);
  box.append(tools(box, "argument"),
    el("div", { class: "row" }, field("Name in your code", "name", a.name, { mono: true }), el("label", { class: "field" }, el("span", null, el("span", { text: "Type" })), type)),
    chosen);
  shape();
  return box;
}
function readArg(box) {
  const v = (k) => box.querySelector('[data-k="' + k + '"]').value.trim();
  const a = { name: v("name"), type: v("type") };
  if (KEY_NAMES.includes(a.type)) return a;
  a.label = v("label");
  if (a.type !== "pubkey" && v("unit")) a.unit = v("unit");
  if (a.type === "bool") { if (v("default")) a.default = v("default") === "true" ? true : v("default") === "false" ? false : v("default"); }
  else if (a.type === "pubkey") { if (v("default")) a.default = v("default"); }
  else {
    if (v("decimals")) a.decimals = numOrText(v("decimals"));
    for (const k of ["min", "max", "default"]) if (v(k)) a[k] = numOrText(v(k));
  }
  if (v("help")) a.help = v("help");
  return a;
}

const seedsText = (seeds) => (Array.isArray(seeds) ? seeds : []).map((s) => (typeof s === "string" ? s : s && s.key ? "{" + s.key + "}" : "")).join(", ");
const seedsOf = (t) => t.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const m = /^\{([a-z_]+)\}$/.exec(s); return m ? { key: m[1] } : s; });
function accountRow(a = { role: "launcher" }) {
  const box = el("div", { class: "rowbox", "data-row": "account" });
  const role = el("select", { "data-k": "role", "aria-label": "Account" }, ...ROLES.map((r) => el("option", { value: r, text: ROLE_WORDS[r].charAt(0).toUpperCase() + ROLE_WORDS[r].slice(1) })));
  role.value = ROLES.includes(a.role) ? a.role : "launcher";
  const seeds = field("Seeds", "seeds", seedsText(a.seeds), { cls: "wide", mono: true, placeholder: "cfg, {pool}" });
  const writable = el("input", { type: "checkbox", "data-k": "writable" });
  writable.checked = a.writable === true;
  const wrap = el("label", { class: "check-row", "data-f": "writable" }, writable, el("span", { text: "The instruction writes to it" }));
  const shape = () => { seeds.hidden = wrap.hidden = role.value !== "pda"; };
  role.addEventListener("change", shape);
  box.append(tools(box, "account"), el("div", { class: "row" }, el("label", { class: "field wide" }, el("span", null, el("span", { text: "Account" })), role), seeds), wrap);
  shape();
  return box;
}
function readAccount(box) {
  const role = box.querySelector('[data-k="role"]').value;
  if (role !== "pda") return { role };
  const a = { role, seeds: seedsOf(box.querySelector('[data-k="seeds"]').value) };
  if (box.querySelector('[data-k="writable"]').checked) a.writable = true;
  return a;
}

/// Put a descriptor into the form. It takes what it can read and leaves the rest empty.
function fill(j) {
  const o = j && typeof j === "object" ? j : {};
  $("gProgram").value = text(o.program);
  $("gName").value = text(o.name);
  $("gAuthor").value = text(o.author);
  $("gSummary").value = text(o.summary);
  $("gRules").value = (Array.isArray(o.rules) ? o.rules : []).map(text).join("\n");
  $("gSource").value = text(o.source);
  const s = o.setup && typeof o.setup === "object" ? o.setup : null;
  $("gHasSetup").checked = !!s;
  $("gInstruction").value = s ? text(s.instruction) : "init_pool_config";
  $("gArgs").replaceChildren(...(s && Array.isArray(s.args) ? s.args : []).map((a) => argRow(a && typeof a === "object" ? a : {})));
  $("gAccounts").replaceChildren(...(s && Array.isArray(s.accounts) ? s.accounts : []).map((a) => accountRow(a && typeof a === "object" ? a : {})));
  update();
}

/// The descriptor the form holds now, as the JSON an author hosts.
function current() {
  const j = { programmable_hook: 1, program: $("gProgram").value.trim(), name: $("gName").value.trim(), summary: $("gSummary").value.trim(), rules: $("gRules").value.split("\n").map((s) => s.trim()).filter(Boolean) };
  if ($("gSource").value.trim()) j.source = $("gSource").value.trim();
  if ($("gAuthor").value.trim()) j.author = $("gAuthor").value.trim();
  if ($("gHasSetup").checked) j.setup = { instruction: $("gInstruction").value.trim(), args: [...$("gArgs").children].map(readArg), accounts: [...$("gAccounts").children].map(readAccount) };
  return j;
}

/// The page opens on the kit's sample, which has no program id yet. Until the reader has touched
/// the form, the sample is shown as a sample, not judged. From the first edit on, every change
/// is judged at once.
let judged = false;
const SAMPLE_SENTENCE = "This is the kit's sample. Type your program id and change the words, and the site judges the result as you go.";
function update() {
  $("gSetup").hidden = !$("gHasSetup").checked;
  // the numbers the list of things to fix uses
  [...$("gArgs").children].forEach((b, i) => { b.querySelector(".cap").textContent = "Argument " + (i + 1); });
  [...$("gAccounts").children].forEach((b, i) => { b.querySelector(".cap").textContent = "Account " + (i + 1); });
  $("gNameCount").textContent = $("gName").value.length + "/48";
  $("gSummaryCount").textContent = $("gSummary").value.length + "/280";
  const j = current();
  const c = checkDescriptor(j);
  $("gJson").textContent = JSON.stringify(j, null, 2);
  const v = $("gVerdict");
  if (!judged) {
    v.className = "verdict"; v.textContent = SAMPLE_SENTENCE;
    $("gErrors").replaceChildren();
  } else {
    v.className = "verdict " + (c.ok ? "ok" : "bad");
    v.textContent = c.ok ? "This descriptor is valid. The site will read it for the program it names." : c.errors.length === 1 ? "One thing to fix before the site reads this descriptor." : c.errors.length + " things to fix before the site reads this descriptor.";
    $("gErrors").replaceChildren(...c.errors.map((e) => el("li", { text: e })));
  }
  const preview = $("gPreview");
  const fields = c.ok && c.d.setup ? setupFields(c.d) : null;
  preview.hidden = !(fields && fields.count);
  if (fields && fields.count) preview.replaceChildren(el("h4", { class: "ws-sub", text: "What a launcher will see" }), fields.node);
  for (const id of ["gDownload", "gCopy", "gUpload"]) $(id).disabled = !c.ok;
  drawDeploy();
}

const touched = () => { judged = true; update(); };
$("descForm").addEventListener("input", touched);
$("descForm").addEventListener("change", touched);
$("gAddArg").addEventListener("click", () => { $("gArgs").append(argRow()); touched(); });
$("gAddAccount").addEventListener("click", () => { $("gAccounts").append(accountRow()); touched(); });
$("gFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try { judged = true; fill(JSON.parse(await f.text())); note("Opened " + f.name + ".", false); }
  catch (_) { note("That file is not JSON.", true); }
});

function note(message, bad) {
  const n = $("gUploadNote");
  n.hidden = !message; n.className = bad ? "error-text" : "help"; n.textContent = message;
}
$("gDownload").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(current(), null, 2) + "\n"], { type: "application/json" }));
  const a = el("a", { href: url, download: "hook.json" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  note("Saved as hook.json. Host it, then type its address in step 4.", false);
});
$("gCopy").addEventListener("click", () => copy(JSON.stringify(current(), null, 2) + "\n"));
// The site's own upload is the one the launch form uses for a coin's details (POST /api/metadata).
// The button shows only when the operator says the endpoint stores descriptors (workshop/site.json).
// The guide reads the stored file back and counts the upload only when it is a descriptor of
// this program. From those bytes it also knows the pin.
$("gUpload").addEventListener("click", async () => {
  const btn = $("gUpload");
  const j = current();
  const self = "Host hook.json yourself and type its address in step 4.";
  btn.disabled = true; btn.textContent = "Uploading";
  try {
    const r = await fetch("/api/metadata", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(j) });
    let a = null; try { a = await r.json(); } catch (_) {}
    const read = r.ok && a && typeof a.url === "string" ? await readDescriptorAt(a.url, j.program) : null;
    if (read && read.pin) { hosted = { url: descriptorUrl(a.url).url, pin: read.pin }; $("gUrl").value = a.url; note("Hosted at " + a.url + ". Step 4 has the deploy command.", false); }
    else note("This site did not store the descriptor. " + self, true);
  } catch (_) { note("The upload did not answer. " + self, true); }
  btn.textContent = "Upload to this site";
  update();
});

// ---- step 4: the address, the pin and the deploy command ---------------------------------------------------

/// The file the guide last read at an address: { url, pin }. The pin is made from the SHA-256
/// of its bytes (pinOf in workshop-descriptor.js).
let hosted = null;
/// Read an address and say whether a valid descriptor of `program` is there.
/// Returns { pin } or { error }.
async function readDescriptorAt(url, program) {
  const address = descriptorUrl(url).url;
  if (!address) return { error: "That is not the address of a .json file." };
  const got = await readAddress(address);
  if (got.error) return { error: got.error, unread: true };
  let json;
  try { json = JSON.parse(new TextDecoder().decode(got.bytes)); } catch (_) { return { error: "The file there is not JSON." }; }
  const c = checkDescriptor(json, program);
  return c.ok ? { pin: pinOf(got.bytes) } : { error: "The file there is not a valid descriptor of this program. " + c.errors[0] };
}
let readNote = { text: "", bad: false };
$("gRead").addEventListener("click", async () => {
  const btn = $("gRead");
  const address = descriptorUrl($("gUrl").value.trim()).url;
  if (!address) return drawDeploy();
  btn.disabled = true; btn.textContent = "Reading";
  const read = await readDescriptorAt(address, $("gProgram").value.trim());
  hosted = read.pin ? { url: address, pin: read.pin } : null;
  readNote = read.pin ? { text: "", bad: false }
    : read.unread ? { text: "This page could not read that address. " + read.error + " The deploy script reads it from your machine, and pins the file if it can.", bad: false }
      : { text: read.error, bad: true };
  btn.disabled = false; btn.textContent = "Read the address";
  drawDeploy();
});

function drawDeploy() {
  const typed = $("gUrl").value.trim();
  const program = $("gProgram").value.trim();
  let key = false;
  try { key = new H.PublicKey(program).toBase58() === program; } catch (_) {}
  // a link pasted with its pin is taken apart: the address is what counts against the limits
  const parsed = descriptorUrl(typed);
  const address = parsed.url;
  const size = bytesOf(address || typed);
  const canPin = size <= MAX_PINNED_ADDRESS_BYTES;
  $("gUrlCount").textContent = !typed ? "" : canPin ? size + "/" + MAX_PINNED_ADDRESS_BYTES + " bytes" : size + "/" + MAX_URI_BYTES + " bytes, too long to pin";
  const fits = !!address && !parsed.pinError && size <= MAX_URI_BYTES && !typed.includes("'");
  const pre = $("gDeploy"), say = $("gDeployNote"), pinNote = $("gPinNote");
  pre.hidden = !fits; say.hidden = fits; pinNote.hidden = !fits;
  $("gRead").disabled = !fits;
  if (!typed) { say.className = "small muted"; say.textContent = "Type the address and the deploy command appears here."; }
  else if (!fits) { say.className = "error-text"; say.textContent = parsed.pinError || "That address will not work. It must start with https, end in .json and have at most " + MAX_URI_BYTES + " bytes."; }
  else {
    const name = $("gName").value.trim();
    const named = name && bytesOf(name) <= 32 && !/["$`\\]/.test(name) ? "HOOK_NAME=\"" + name + "\" " : "";
    const pin = hosted && hosted.url === address ? hosted.pin : parsed.pin;
    const line = (uri, more) => "WALLET=~/my-wallet.json " + named + more + "HOOK_URI='" + uri + "' bash scripts/deploy-freeze.sh " + DEPLOY_CLUSTER;
    pinNote.className = "help";
    if (!canPin) {
      pre.textContent = line(address, "DESCRIPTOR_PIN=no ");
      pinNote.textContent = "This address is " + (size - MAX_PINNED_ADDRESS_BYTES) + " bytes too long to carry the pin. The command links your descriptor without pinning it, and sites will say that you can still change the text. An address of at most " + MAX_PINNED_ADDRESS_BYTES + " bytes can be pinned.";
    } else if (pin) {
      pre.textContent = line(address + "#s=" + pin, "");
      pinNote.textContent = "This command pins your text. The link carries the pin of the file at that address, and sites refuse any other file there. Change the file before you deploy and the script stops.";
    } else {
      pre.textContent = line(address, "");
      pinNote.textContent = "The deploy script reads this address and adds the pin of the file it finds. Press Read the address to see the pinned link here.";
    }
    if (readNote.text && !(hosted && hosted.url === address)) { pinNote.className = readNote.bad ? "error-text" : "help"; pinNote.textContent = readNote.text; }
  }
  $("gPage").href = key ? "workshop-hook.html?id=" + program : "workshop.html";
}
$("gUrl").addEventListener("input", () => { readNote = { text: "", bad: false }; drawDeploy(); });

fill(START);
