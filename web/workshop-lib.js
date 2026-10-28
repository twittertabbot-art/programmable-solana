// The workshop: hooks other people built. Shared by workshop.html, workshop-hook.html,
// workshop-guide.html and the Custom hook card of the launch form.
//
// Four things live here.
// 1. Loading a hook's descriptor: a small JSON file a hook's author hosts and the hook's
//    manifest links to. The format, its one validator (checkDescriptor) and the pin of a
//    descriptor's content are in workshop-descriptor.js, which the upload server runs too.
// 2. The setup instruction a descriptor describes, built for one launch, and the guard that
//    simulates the first launch transaction before the wallet is asked to sign it.
// 3. The list of workshop hooks, read from the pools on chain and from the approved list.
// 4. The review: the approved list as the platform account holds it, the registry of review
//    reports (workshop/reviewed.json) and the mark "Reviewed by Programmable".
import { ctx, H, templateOfProgram, fetchJson, fmtSol, mapLimit, explainTxError, el, allPools as poolsList } from "./common.js";
import { MAX_DESCRIPTOR_BYTES, ARG_TYPES, checkDescriptor, isKey, isObject, utf8, toRaw, fromRaw, anchorDiscriminator, parseUri, pinOf } from "./workshop-descriptor.js";

export * from "./workshop-descriptor.js";

const { PublicKey } = H;

// ---- loading a descriptor -------------------------------------------------------------------------------

/// What a manifest's uri is to this site (parseUri in workshop-descriptor.js): the address of
/// a descriptor, with or without the pin of its content, or a plain link that the site shows
/// and never loads. On a local chain an http address of this machine counts too.
export function descriptorUrl(uri) { return parseUri(uri, ctx.cluster === "localnet"); }

/// What a page says about whether an author's text can still change.
export const PINNED_SENTENCE = "This description is pinned. The hook's manifest holds a fingerprint of this file, and the site refuses any other file at that address.";
/// The same on a card of the list, where there is room for one line.
export const PINNED_ON_CARD = "This text is pinned. The site refuses any other file at its address.";
/// And what a pin is worth, said wherever a pinned text is shown in full.
export const PIN_MEANS ="The pin proves that this is the file the author pinned. It is not a signature, and it says nothing about the code.";
export const UNPINNED_SENTENCE = "The author can still change this text, and the code cannot change either way.";

/// The bytes behind an address a stranger chose: at most `max` of them, within 5 seconds,
/// without cookies and without saying where the request comes from.
/// Returns { bytes } or { error, tooLarge }.
export async function readAddress(url, max = MAX_DESCRIPTOR_BYTES) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!r.ok) return { error: "The address answered " + r.status + "." };
    const bytes = await readCapped(r, max);
    return bytes ? { bytes } : { error: "The file is larger than " + max + " bytes.", tooLarge: true };
  } catch (_) {
    return { error: "The address did not answer, or does not let other sites read it." };
  } finally { clearTimeout(timer); }
}
/// The body of an answer, or null when it is longer than `max` bytes. The page stops reading
/// at the limit instead of taking everything in.
async function readCapped(r, max) {
  if (Number(r.headers.get("content-length") || 0) > max) return null;
  if (!r.body || !r.body.getReader) { const all = new Uint8Array(await r.arrayBuffer()); return all.length > max ? null : all; }
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch (_) {} return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return all;
}

const loaded = new Map();
/// The descriptor of a hook, from the uri in its manifest.
/// state: "none"        the manifest names no descriptor (link: its plain link, if it has one)
///        "unreachable" the address did not answer with JSON
///        "refused"     the file is not a valid descriptor, names another program, or is not
///                      the file the manifest pins
///        "ok"          d holds the checked descriptor
/// pinned: the manifest's link carries the pin of the file, and the file that was loaded has it.
/// pin: the pin the link carries, also when the file was refused.
export function loadDescriptor(programId, manifest) {
  const id = programId.toBase58();
  const key = id + " " + ((manifest && manifest.uri) || "");
  if (!loaded.has(key)) loaded.set(key, readDescriptor(id, manifest));
  return loaded.get(key);
}
async function readDescriptor(id, manifest) {
  const { url, link, pin, pinError } = descriptorUrl(manifest ? manifest.uri : "");
  const out = (state, errors, d = null) => ({ state, url, link, d, errors, pinned: !!pin, pin });
  if (!url) return out("none", []);
  if (pinError) return out("refused", [pinError]);
  const got = await readAddress(url);
  if (got.error) return out(got.tooLarge ? "refused" : "unreachable", [got.error]);
  // the pin is over the bytes as they were fetched, before anything reads them as text
  if (pin && pinOf(got.bytes) !== pin) return out("refused", ["The file at this address is not the one the hook was deployed with. The manifest pins a file with another content."]);
  let json;
  try { json = JSON.parse(new TextDecoder().decode(got.bytes)); } catch (_) { return out("unreachable", ["The file is not JSON."]); }
  const c = checkDescriptor(json, id);
  return c.ok ? out("ok", [], c.d) : out("refused", c.errors);
}
/// One sentence for a descriptor that is not in use.
export function descriptorSentence(x) {
  if (x.state === "ok") return "";
  if (x.state === "none") return "The author published no descriptor.";
  if (x.state === "unreachable") return "The descriptor could not be loaded. " + x.errors.join(" ");
  return "The descriptor was refused. " + x.errors.join(" ");
}

// ---- the review: the approved list on chain, and the registry of reports -------------------------------

/// The registry of review reports, workshop/reviewed.json. Map of program id to
/// { program, name, repo, commit, buildHash, date, report, note }.
/// Schema 2: { schema: 2, hooks: [{ program, name, repo, commit, buildHash, reviewedAt, report }] }.
/// The first shape is read too: a program id, or { program, date, note }.
/// The registry only supplies a report's link and date. Whether a hook is approved is read
/// from the chain (approvalOf below): a program in this file that is not on the approved list
/// carries no mark.
let reviewedOnce = null;
export function loadReviewed() {
  if (!reviewedOnce) reviewedOnce = fetchJson("workshop/reviewed.json", 4000).then((j) => {
    const map = new Map();
    const text = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    for (const h of (j && Array.isArray(j.hooks) ? j.hooks : [])) {
      if (typeof h === "string" && isKey(h)) { map.set(h, { program: h, name: "", repo: "", commit: "", buildHash: "", date: "", report: "", note: "" }); continue; }
      if (!isObject(h) || !isKey(h.program)) continue;
      map.set(h.program, {
        program: h.program, name: text(h.name, 48), repo: text(h.repo, 200), commit: text(h.commit, 64), buildHash: text(h.buildHash, 64),
        date: text(h.reviewedAt, 20) || text(h.date, 20), report: reportHref(h.report), note: text(h.note, 200),
      });
    }
    return map;
  }).catch(() => new Map());
  return reviewedOnce;
}
/// A report's address as a link of this site: a page of the reviews folder, or a web address.
export function reportHref(v) {
  const s = typeof v === "string" ? v.trim() : "";
  if (/^\/?reviews\/[A-Za-z0-9_-]+\.html$/.test(s)) return s.replace(/^\//, "");
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
}
/// What the site says wherever no coin can launch on a hook because it is not on the approved list.
export const NOT_REVIEWED = "This hook has not been reviewed by Programmable yet, so no coin can launch on it.";
/// And on a coin or a pool whose hook is an outside hook that is not on the list while the rule is on.
export const TAKEN_OFF = "This hook is not on Programmable's approved list. Coins already on it keep it, because a pool's hook can never change. Read the hook's report, if it has one, before you trade.";
/// The reports of the platform's own hooks, by template name.
export const TEMPLATE_REPORTS = { rules: "reviews/launch-rules.html", tax: "reviews/tax.html", launch_guard: "reviews/launch-guard.html", buyback: "reviews/buyback.html", collectible: "reviews/collectible.html" };
/// The approved list and the rule, from a Platform the SDK decoded:
/// { required, approved: Set of program ids, corrupt }. A platform written before the rule
/// existed reads as rule off, nothing approved.
export function approvalOf(plat) {
  return {
    required: !!(plat && plat.hookApprovalRequired),
    approved: new Set(plat && Array.isArray(plat.approvedHooks) ? plat.approvedHooks.map((k) => k.toBase58()) : []),
    corrupt: !!(plat && plat.approvedListCorrupt),
  };
}
/// The mark of an approved hook: "Reviewed by Programmable", the date of its review, and a link
/// to its report, or "Report coming" when the registry has none yet. `r`: the registry's entry or null.
export function reviewMark(r) {
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.setAttribute("viewBox", "0 0 24 24"); ring.setAttribute("aria-hidden", "true");
  const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "8"); c.setAttribute("fill", "none"); c.setAttribute("stroke", "currentColor"); c.setAttribute("stroke-width", "2.4");
  ring.append(c);
  // the spaces between the parts are for a reader and a copy of the text; the layout ignores them
  const kids = [ring, " ", el("span", { text: "Reviewed by Programmable" }), r && r.date ? " " : null, r && r.date ? el("span", { class: "rv-mark-date", text: r.date }) : null];
  const mark = r && r.report
    ? el("a", { class: "rv-mark", "data-mark": "reviewed", href: r.report, title: "Read the review report", ...(/^https:/.test(r.report) ? { target: "_blank", rel: "noopener" } : {}) }, ...kids)
    : el("span", { class: "rv-mark", "data-mark": "reviewed" }, ...kids);
  return mark;
}
/// One line under a mark: the report's link, or that it is coming.
export function reportLine(r) {
  return r && r.report
    ? el("a", { class: "link", "data-report": "yes", href: r.report, ...(/^https:/.test(r.report) ? { target: "_blank", rel: "noopener" } : {}), text: "Read the report" })
    : el("span", { class: "dim", "data-report": "coming", text: "Report coming" });
}

// ---- the hooks in use ------------------------------------------------------------------------------------

/// Every frozen hook somebody else wrote that has at least one pool, from the pools on chain,
/// and the programs of `more` (the approved list) that have none yet.
/// Each entry: { program, id, pools (oldest first), flags, launches, collected, volume, swaps,
/// otherQuote, first, firstBy, manifest, descriptor }. `first` and `firstBy` are null for a
/// hook without a pool, whose flags are its manifest's.
export async function workshopHooks(pools, more = []) {
  const all = pools || await poolsList();
  const by = new Map();
  for (const p of all) {
    if (!p.hasHook || p.hookKind !== H.HOOK_KIND.FROZEN || templateOfProgram(p.hookProgram) !== "custom") continue;
    const id = p.hookProgram.toBase58();
    if (!by.has(id)) by.set(id, { program: p.hookProgram, id, pools: [] });
    by.get(id).pools.push(p);
  }
  for (const k of more) {
    const id = typeof k === "string" ? k : k.toBase58();
    if (by.has(id)) continue;
    try { const program = new PublicKey(id); if (templateOfProgram(program) === "custom") by.set(id, { program, id, pools: [] }); } catch (_) {}
  }
  const list = [...by.values()];
  const manifests = list.length ? await ctx.connection.getMultipleAccountsInfo(list.map((h) => H.pda.manifest(h.program))) : [];
  list.forEach((h, i) => {
    h.pools.sort((a, b) => (a.createdSlot < b.createdSlot ? -1 : a.createdSlot > b.createdSlot ? 1 : 0));
    Object.assign(h, hookTotals(h.pools));
    h.manifest = null;
    if (manifests[i]) { try { h.manifest = H.decodeHookManifest(new Uint8Array(manifests[i].data)); } catch (_) {} }
    // a pool keeps the flags it was created with: the first pool's are the hook's own
    h.first = h.pools[0] || null;
    h.flags = h.first ? h.first.hookFlags : h.manifest ? h.manifest.flags : 0;
    h.firstBy = h.first ? h.first.creator : null;
  });
  await mapLimit(list, 4, async (h) => { h.descriptor = await loadDescriptor(h.program, h.manifest); });
  list.sort((a, b) => b.launches - a.launches || (b.collected > a.collected ? 1 : b.collected < a.collected ? -1 : 0) || (a.id < b.id ? -1 : 1));
  return list;
}
/// Launches, and what the hook collected, over a list of pools. The fee of a hook is paid in
/// the pool's quote token. Only pools against wrapped SOL are summed. `otherQuote` counts the rest.
export function hookTotals(pools) {
  let collected = 0n, volume = 0n, swaps = 0n, otherQuote = 0;
  for (const p of pools) {
    swaps += p.swapCount;
    if (!p.quoteMint.equals(H.NATIVE_MINT)) { otherQuote += 1; continue; }
    collected += p.hookFeesQuoteTotal; volume += p.volumeQuoteTotal;
  }
  return { launches: pools.length, collected, volume, swaps, otherQuote };
}
/// The name to show for a hook: the descriptor's, else the manifest's, else nothing.
export function hookName(h) {
  if (h.descriptor && h.descriptor.state === "ok") return h.descriptor.d.name;
  return (h.manifest && h.manifest.name) || "";
}

// ---- the setup instruction of one launch ------------------------------------------------------------------

function encodeArg(type, value) {
  if (type === "bool") return Uint8Array.of(value ? 1 : 0);
  if (type === "pubkey") return value.toBytes();
  const t = ARG_TYPES[type];
  const out = new Uint8Array(t.bytes);
  let v = BigInt.asUintN(t.bytes * 8, BigInt(value));
  for (let i = 0; i < t.bytes; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/// The instruction a descriptor's setup describes, for one launch.
/// `keys`: { launcher, pool, base_mint, quote_mint } as public keys. `values`: what the
/// launcher chose, by argument name (a bigint in raw units, a boolean, or a public key).
/// Returns { instruction, own }. `own` lists the accounts of the hook program the instruction
/// names, with `writable`.
export function buildSetup(d, keys, values) {
  const program = new PublicKey(d.program);
  const parts = [anchorDiscriminator(d.setup.instruction)];
  for (const a of d.setup.args) {
    if (a.fixed) { parts.push(keys[a.type].toBytes()); continue; }
    if (!(a.name in values)) throw new Error("The setting \"" + a.label + "\" has no value.");
    parts.push(encodeArg(a.type, values[a.name]));
  }
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { data.set(p, at); at += p.length; }
  const own = [];
  const metas = d.setup.accounts.map((a) => {
    if (a.role === "launcher") return { pubkey: keys.launcher, isSigner: true, isWritable: true };
    if (a.role === "pda") {
      const address = PublicKey.findProgramAddressSync(a.seeds.map((s) => (s.key ? keys[s.key].toBytes() : utf8(s.text))), program)[0];
      own.push({ address, writable: a.writable });
      return { pubkey: address, isSigner: false, isWritable: a.writable };
    }
    const pubkey = a.role === "system_program" ? H.SYSTEM_PROGRAM : a.role === "token_program" ? H.TOKEN_PROGRAM : a.role === "token_2022_program" ? H.TOKEN_2022_PROGRAM : keys[a.role];
    return { pubkey, isSigner: false, isWritable: false };
  });
  // a Transaction turns the plain object into an instruction
  const instruction = new H.Transaction().add({ programId: program, keys: metas, data: Buffer.from(data) }).instructions[0];
  return { instruction, own };
}

/// The settings a launcher chooses, as form fields. Returns { node, read }. read() gives the
/// values by argument name or throws an Error with a sentence that names the field.
export function setupFields(d, launcherKey = null) {
  const chosen = d.setup ? d.setup.args.filter((a) => !a.fixed) : [];
  const inputs = new Map();
  const range = (a) => {
    const t = ARG_TYPES[a.type];
    const lo = fromRaw(a.min, a.decimals), hi = fromRaw(a.max, a.decimals);
    if (a.min === t.min && a.max === t.max) return "";
    if (a.max === t.max) return "at least " + lo;
    return lo + " to " + hi;
  };
  const fields = chosen.map((a) => {
    let control, hint = "";
    if (a.type === "bool") {
      control = el("select", { "data-arg": a.name }, el("option", { value: "true", text: "Yes" }), el("option", { value: "false", text: "No" }));
      control.value = a.def === false ? "false" : "true";
    } else if (a.type === "pubkey") {
      control = el("input", { class: "input mono", "data-arg": a.name, placeholder: "wallet address", autocomplete: "off", spellcheck: "false" });
      hint = a.def === "launcher" ? "empty means your wallet" : "";
    } else {
      const input = el("input", { class: "input num", "data-arg": a.name, inputmode: "decimal", autocomplete: "off", value: a.def === null ? "" : fromRaw(a.def, a.decimals) });
      control = a.unit ? el("div", { class: "input-wrap" }, input, el("span", { class: "suffix", text: a.unit })) : input;
      hint = range(a);
    }
    inputs.set(a.name, control.matches("[data-arg]") ? control : control.querySelector("[data-arg]"));
    return el("label", { class: "field" }, el("span", null, el("span", { text: a.label }), el("span", { class: "dim", text: hint })), control, a.help ? el("p", { class: "help", text: a.help }) : null);
  });
  const node = el("div", { class: "row setup-fields" }, ...fields);
  const read = () => {
    const out = {};
    for (const a of chosen) {
      const raw = inputs.get(a.name).value.trim();
      if (a.type === "bool") { out[a.name] = raw === "true"; continue; }
      if (a.type === "pubkey") {
        if (!raw && a.def === "launcher") { out[a.name] = launcherKey ? launcherKey() : null; if (!out[a.name]) throw new Error("Connect a wallet first."); continue; }
        try { out[a.name] = new PublicKey(raw); } catch (_) { throw new Error("\"" + a.label + "\" is not a valid address."); }
        continue;
      }
      const v = toRaw(raw, a.decimals);
      const unit = a.unit ? " " + a.unit : "";
      if (v === null) throw new Error("\"" + a.label + "\" must be a number" + (a.decimals ? " with at most " + a.decimals + " decimals." : " without decimals."));
      if (v < a.min || v > a.max) throw new Error("\"" + a.label + "\" must be between " + fromRaw(a.min, a.decimals) + " and " + fromRaw(a.max, a.decimals) + unit + ".");
      out[a.name] = v;
    }
    return out;
  };
  return { node, read, count: chosen.length };
}

// ---- the guard: simulate the first launch transaction before the wallet signs it ------------------------------
// The setup instruction is code of the hook program, run with the launcher's signature. A
// program can move SOL out of a wallet that signs for it, and can take the wallet's account
// itself. So the form simulates the transaction twice, with the setup and without it, and
// compares. It also ends the real transaction with a floor: a transfer from the wallet to
// itself of the balance the simulation left. That instruction fails when the wallet holds
// less at that point, or is no longer a plain wallet account, and then the whole transaction
// fails. A simulation is not a guarantee of what the hook does later. The hook's code is the truth.

/// The setup may take the rent of the accounts it creates plus this much.
export const SETUP_MARGIN = 1_000_000n;
/// And never more than this in all, rent included.
export const SETUP_CAP = 50_000_000n;
const SYSTEM = "11111111111111111111111111111111";

/// The comparison alone. All amounts in lamports, as bigint.
///   wallet: { owner, dataLength, withoutSetup, withSetup }   the launcher's account after each simulation
///   rent:   the rent-exempt minimum of the accounts the setup creates, added up
///   others: [{ address, changed, tokenOfWallet }]   every other account the transaction may write
/// Returns { ok, code, reason, cost, rent, allowed }.
export function judgeSetup({ wallet, rent, others }) {
  const cost = wallet.withoutSetup - wallet.withSetup;
  const allowed = rent + SETUP_MARGIN;
  const out = (code, reason) => ({ ok: !code, code, reason, cost, rent, allowed });
  if (wallet.owner !== SYSTEM || wallet.dataLength !== 0) return out("wallet", "This hook's setup would hand your wallet's account to another program. Nothing was sent.");
  const token = others.find((o) => o.changed && o.tokenOfWallet);
  if (token) return out("token", "This hook's setup would change a token account of your wallet (" + token.address + "). Nothing was sent.");
  const foreign = others.find((o) => o.changed);
  if (foreign) return out("foreign", "This hook's setup would change an account that is not its own (" + foreign.address + "). Nothing was sent.");
  if (cost > allowed) return out("sol", "This hook's setup would take " + fmtSol(cost, 6) + " SOL from your wallet. The rent of the accounts it creates is " + fmtSol(rent, 6) + " SOL, and this site allows " + fmtSol(SETUP_MARGIN, 6) + " SOL above that. Nothing was sent.");
  if (cost > SETUP_CAP) return out("cap", "This hook's setup would take " + fmtSol(cost, 6) + " SOL from your wallet. This site allows at most " + fmtSol(SETUP_CAP, 6) + " SOL for a hook's settings. Nothing was sent.");
  return out("", "");
}

const stateOf = (a) => {
  if (!a) return null;
  const data = Array.isArray(a.data) ? a.data[0] : Buffer.from(a.data).toString("base64");
  return { lamports: BigInt(a.lamports), owner: typeof a.owner === "string" ? a.owner : a.owner.toBase58(), data, bytes: Buffer.from(data, "base64") };
};
const sameState = (a, b) => (!a && !b) || (!!a && !!b && a.lamports === b.lamports && a.owner === b.owner && a.data === b.data);
/// A token account whose owner field is `wallet`.
function tokenOf(state, wallet) {
  if (!state || state.bytes.length < 165) return false;
  if (state.owner !== H.TOKEN_PROGRAM.toBase58() && state.owner !== H.TOKEN_2022_PROGRAM.toBase58()) return false;
  return new PublicKey(state.bytes.subarray(32, 64)).equals(wallet);
}

/// Simulate the first launch transaction with and without the hook's setup and judge the
/// difference. `createTx`: the instructions of the transaction. `setupIxs`: the ones of
/// them that belong to the hook. `own`: the accounts of the hook the setup names.
/// Returns what judgeSetup returns plus { takes, floor, floorIx }: what the whole transaction
/// takes from the wallet, the balance it leaves, and the instruction that holds it to that.
export async function guardSetup(dev, createTx, setupIxs, own) {
  const conn = ctx.connection;
  // The comparison needs the transaction without the setup. If the setup's instructions are not
  // in the list as the very objects handed to the SDK, the two simulations would be the same
  // transaction and every setup would look free: refuse instead.
  if (!setupIxs.length || setupIxs.some((ix) => !createTx.includes(ix))) return { ok: false, code: "simulation", reason: "The form could not tell this hook's setup apart from the rest of the first transaction, so it cannot check it. Nothing was sent.", cost: 0n, rent: 0n, allowed: 0n };
  const baseIxs = createTx.filter((ix) => !setupIxs.includes(ix));
  const writable = (ixs) => {
    const m = new Map([[dev.toBase58(), dev]]);
    for (const ix of ixs) for (const k of ix.keys) if (k.isWritable) m.set(k.pubkey.toBase58(), k.pubkey);
    return m;
  };
  const fullW = writable(createTx), baseW = writable(baseIxs);
  const fullList = [...fullW.keys()], baseList = [...baseW.keys()];
  const simulate = async (ixs, addresses) => {
    const { tx } = await ctx.client.buildTx(dev, ixs);
    const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses } });
    return r.value;
  };
  const [pre, full, base] = await Promise.all([conn.getMultipleAccountsInfo([...fullW.values()]), simulate(createTx, fullList), simulate(baseIxs, baseList)]);
  const failed = async (sim, withSetup) => {
    const e = new Error(JSON.stringify(sim.err)); e.logs = sim.logs || [];
    let why = await explainTxError(e, "coin creation");
    // an error no page has words for comes back as the chain's own answer
    if (/^[{\["]/.test(why)) why = "The chain's answer was " + why;
    return { ok: false, code: "simulation", reason: "The first transaction failed in a simulation" + (withSetup ? "" : ", even without the hook's setup") + ". Nothing was sent. " + why, cost: 0n, rent: 0n, allowed: 0n };
  };
  if (base.err) return failed(base, false);
  if (full.err) return failed(full, true);
  const before = new Map(fullList.map((k, i) => [k, stateOf(pre[i])]));
  const after = new Map(fullList.map((k, i) => [k, stateOf(full.accounts[i])]));
  const without = new Map(baseList.map((k, i) => [k, stateOf(base.accounts[i])]));
  // an account the transaction without the setup does not write is, without the setup, as it is now
  const baseOf = (k) => (without.has(k) ? without.get(k) : before.get(k));
  const me = dev.toBase58();
  const ownKeys = new Set(own.map((o) => o.address.toBase58()));
  let rent = 0n;
  for (const k of ownKeys) {
    const a = after.get(k), b = before.get(k);
    if (!a) continue;
    const need = BigInt(await conn.getMinimumBalanceForRentExemption(a.bytes.length));
    const had = b ? BigInt(await conn.getMinimumBalanceForRentExemption(b.bytes.length)) : 0n;
    if (need > had) rent += need - had;
  }
  const others = fullList.filter((k) => k !== me && !ownKeys.has(k)).map((k) => {
    const b = baseOf(k), a = after.get(k);
    return { address: k, changed: !sameState(b, a), tokenOfWallet: tokenOf(b, dev) || tokenOf(a, dev) };
  });
  const w = after.get(me), wb = without.get(me);
  if (!w || !wb) return { ok: false, code: "simulation", reason: "The simulation did not report your wallet's balance, so the form cannot check this hook's setup. Nothing was sent.", cost: 0n, rent: 0n, allowed: 0n };
  const verdict = judgeSetup({ wallet: { owner: w.owner, dataLength: w.bytes.length, withoutSetup: wb.lamports, withSetup: w.lamports }, rent, others });
  const start = before.get(me) ? before.get(me).lamports : 0n;
  verdict.takes = start - w.lamports;
  verdict.floor = w.lamports;
  verdict.floorIx = verdict.ok ? H.SystemProgram.transfer({ fromPubkey: dev, toPubkey: dev, lamports: w.lamports }) : null;
  return verdict;
}

// ---- the Custom hook card of the launch form -------------------------------------------------------------

/// Fills `box` with what the form knows about a hook from its descriptor, and returns the
/// card's helper for a launch, or null when the hook has no descriptor in use.
///   check: what common.js checkHook returned for the hook
///   wallet: a function that answers the connected public key, or null
/// The helper: { d, read(), instructions(launcher, mint), guard(dev, createTx) }.
export async function customHookSetup(box, check, wallet) {
  box.hidden = true; box.replaceChildren();
  if (!check || !check.manifest) return null;
  const id = check.id.toBase58();
  const x = await loadDescriptor(check.id, check.manifest);
  box.hidden = false;
  const page = el("a", { class: "link", href: "workshop-hook.html?id=" + id, text: "Its page in Custom hooks" });
  if (x.state !== "ok") {
    box.replaceChildren(el("p", { class: x.state === "none" ? "help" : "error-text", "data-descriptor": x.state },
      x.state === "none"
        ? "The author of this hook published no descriptor, so this form cannot build its settings. If the hook keeps settings for each pool, create them yourself for the pool address below before step 2. "
        : descriptorSentence(x) + " The form does not use it. If the hook keeps settings for each pool, create them yourself for the pool address below before step 2. ", page));
    return null;
  }
  const d = x.d;
  const fields = d.setup ? setupFields(d, wallet) : null;
  const kids = [
    el("div", { class: "verdict", "data-descriptor": "ok", text: d.name + (d.author ? ", by " + d.author : "") }),
    el("p", { class: "muted", style: "margin: 0 0 8px", text: d.summary }),
    el("p", { class: "help", "data-pin": x.pinned ? "yes" : "no", style: "margin: 0 0 8px", text: x.pinned ? PINNED_SENTENCE + " " + PIN_MEANS : UNPINNED_SENTENCE }),
  ];
  if (fields && fields.count) kids.push(el("h4", { style: "margin: 12px 0 8px", text: "This hook's settings for your coin" }), fields.node);
  if (d.setup) kids.push(
    el("p", { class: "help", text: "These fields come from the hook's descriptor, a file its author wrote. The first transaction runs the hook's own setup with your signature. The form simulates that transaction before your wallet opens and shows what it takes. It refuses a setup that takes more than the rent of the accounts it creates plus " + fmtSol(SETUP_MARGIN, 6) + " SOL, or more than " + fmtSol(SETUP_CAP, 6) + " SOL in all, or that touches anything but its own accounts." }),
    el("p", { class: "help" }, el("b", { text: "A simulation is not a guarantee. The hook's code is the truth." }), " ", page));
  else kids.push(el("p", { class: "help" }, "The descriptor of this hook names no settings for a pool, so the first transaction runs none of its code. ", page));
  kids.push(el("div", { class: "setup-guard", id: "customGuard", "aria-live": "polite" }));
  box.replaceChildren(el("div", { class: "verdict-box" }, ...kids));
  if (!d.setup) return { d, read: () => ({}), instructions: async () => ({ ixs: [], own: [], exists: false }), guard: null };
  const say = (cls, text) => { const g = box.querySelector("#customGuard"); if (g) g.replaceChildren(el("p", { class: cls, style: "margin: 8px 0 0", text })); };
  return {
    d,
    read: () => fields.read(),
    /// The setup of this launch. An empty list when the hook's accounts for this pool exist already.
    async instructions(launcher, mint, values) {
      const pool = H.pda.pool(mint, H.NATIVE_MINT);
      const { instruction, own } = buildSetup(d, { launcher, pool, base_mint: mint, quote_mint: H.NATIVE_MINT }, values);
      const mine = own.filter((o) => o.writable);
      if (mine.length) {
        const infos = await ctx.connection.getMultipleAccountsInfo(mine.map((o) => o.address));
        if (infos.every(Boolean)) { say("help", "This pool's settings exist on chain already, so the form does not create them again."); return { ixs: [], own, exists: true }; }
      }
      return { ixs: [instruction], own, exists: false };
    },
    /// Simulates, says what it found under the fields, and returns the verdict.
    async guard(dev, createTx, setupIxs, own) {
      say("help", "Simulating the first transaction");
      const v = await guardSetup(dev, createTx, setupIxs, own);
      if (!v.ok) say("error-text", v.reason);
      else say("ok small", "Simulated just now. The first transaction takes " + fmtSol(v.takes, 6) + " SOL from your wallet. "
        + (v.cost > 0n ? "The hook's setup takes " + fmtSol(v.cost, 6) + " SOL of that" + (v.cost === v.rent ? ", the rent of its settings." : ". The rent of its settings is " + fmtSol(v.rent, 6) + " SOL.") : "The hook's setup takes none of that.")
        + " The transaction fails on chain if it leaves your wallet less than " + fmtSol(v.floor, 6) + " SOL.");
      return v;
    },
  };
}

// ---- what a hook may do, as numbers ---------------------------------------------------------------------------

/// What the chain lets a hook do, in a few words for a card: its strongest power, and the
/// trades the pool calls it on.
export function powerShort(flags, plat) {
  const s = H.describeFlags(flags);
  const pct = (bps) => (Number(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%";
  const main = s.canOverrideCurve ? "Sets the price"
    : s.canTakeFee ? "Fee up to " + (plat ? pct(plat.maxHookFeeBps) : "the platform cap")
      : s.canOverrideFee ? "Sets the pool fee"
        : s.runsOnBuys || s.runsOnSells ? "No fee" : "Called on no trade";
  const runs = s.runsOnBuys && s.runsOnSells ? "called on buys and sells" : s.runsOnBuys ? "called on buys only" : s.runsOnSells ? "called on sells only" : "";
  return { main, runs };
}
/// The state of a hook's description in two or three words.
export function descriptorLabel(x) {
  if (x.state === "ok") return x.pinned ? "Pinned description" : "Description can change";
  if (x.state === "none") return "No description";
  if (x.state === "refused") return "Description refused";
  return "Description not loaded";
}

/// The powers of a hook as short rows: [label, value, tone]. tone "bad" marks the power to set the price.
export function powerRows(flags, plat) {
  const s = H.describeFlags(flags);
  const pct = (bps) => (Number(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%";
  const runs = s.runsOnBuys && s.runsOnSells ? "buys and sells" : s.runsOnBuys ? "buys only" : s.runsOnSells ? "sells only" : "no trade";
  return [
    ["The pool calls it on", runs, ""],
    ["Fee it can take per trade", s.canTakeFee ? (plat ? "at most " + pct(plat.maxHookFeeBps) : "up to the platform cap") : "none", ""],
    ["Pool fee it can set", s.canOverrideFee ? (plat ? "at most " + pct(plat.maxFeeOverrideBps) : "up to the platform cap") : "it cannot", ""],
    ["Sets the price itself", s.canOverrideCurve ? "yes" : "no", s.canOverrideCurve ? "bad" : ""],
    ["Can stop a deposit of liquidity", s.canBlockAdding ? "yes" : "no", ""],
    ["Can stop a withdrawal of liquidity", s.canBlockRemoval ? "yes" : "no", ""],
  ];
}
