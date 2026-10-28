// Review tool: the workshop, end to end, in headless Edge with real mouse and keyboard input,
// signed by throwaway wallets made here (localnet only, airdropped, never written to disk).
//   node web/review/flow-workshop.mjs <site origin> <out prefix> [parts]
//   node web/review/flow-workshop.mjs http://localhost:8787 web/review/w-workshop
// L. a coin launched on a workshop hook through the launch form, with the settings form built
//    from the hook's descriptor: for the kit's template and for both examples. The coin and
//    the hook's config are read back from chain. A setting the hook itself refuses stops the
//    launch in the simulation, before any wallet prompt.
// A. the list of Custom hooks against the chain: which hooks, coins, collected, names, what each
//    may do, its author's summary, whether that text is pinned, and the search.
// B. a hook's page: every fact and every check result against the chain. A hook without a
//    descriptor, one whose descriptor names another program, one whose manifest pins its
//    descriptor, and one whose pinned descriptor was changed afterwards (refused). The trade
//    check with a wallet, with a poor wallet, without one, and from a watcher's status file
//    in the shape the watcher writes (the run answers config.js and pools.json itself).
// D. the guard: a hook whose setup takes 0.25 SOL on top of its rent is refused before the
//    wallet opens. The comparison rule on its own. The floor instruction on chain.
// E. the guide, "Build a hook": the flags, the descriptor form against the kit's hook.json files,
//    Download and Copy, the review before the deploy, the address and its pin, the deploy command.
// U. the upload of a descriptor, for real: this part starts its OWN copy of the site's server
//    on a free port (the code of web/serve.js as it is on disk), uploads through the guide,
//    reads the stored file from disk, removes it and stops that server by its process id.
// V. the approved list on the pages. With the localnet admin (read the way init-platform.mjs
//    reads it) the part approves a fixture hook with the rule off, switches the platform's
//    approval rule on, approves a hook without a coin, and reads every page that changes: the
//    list with its "Not reviewed" section, a hook's page, the launch form, the hook checker, the
//    coin and the pool of a hook that is not on the list. Then it takes a hook off the list.
//    At the end it switches the rule off and empties the list again, as it found them.
// N. navigation: Custom hooks in the menu and the footer of every page, the community hooks on the
//    Custom hook launch page, the hook checker's link, the docs.
// "parts": all (the default), or some of L,A,B,D,E,U,V,N.
//
// THE FIXTURES. The parts need frozen copies of the kit's hooks whose manifests link to
// descriptors this site serves: web/review/workshop-fixtures/<name>.json, and hooks.json in
// the same folder with the program id of each copy. To make them on a new chain (in Linux
// or WSL, from the root of the package):
//   1. copy hook-template, examples/hooks/early-bird (twice) and examples/hooks/loyalty-points
//      to folders OUTSIDE the package (Anchor.toml, Cargo.toml, Cargo.lock, programs/), and
//      point hookpool-interface in each Cargo.toml at crates/hookpool-interface. In one more
//      copy of hook-template add to init_pool_config a system transfer of 250,000,000
//      lamports from payer to cfg: that is the "greedy" hook. Build each once
//      (HOOK_DIR=<copy> bash hook-template/scripts/build.sh prints its program id).
//   2. node web/review/flow-workshop.mjs fixtures fee=<id> early=<id> points=<id> copycat=<id> greedy=<id>
//      writes the files from the hook.json of each kit hook, with those program ids.
//   3. for each: HOOK_DIR=<copy> WALLET=<funded keypair> HOOK_NAME=<name>
//      HOOK_URI=http://localhost:8787/review/workshop-fixtures/<file>.json FREEZE=yes
//      bash hook-template/scripts/deploy-freeze.sh localnet
//      Files: fee.json, early.json, points.json, greedy.json. The second copy of early-bird
//      ("copycat") gets early.json too, with DESCRIPTOR_CHECK=no: its descriptor names
//      another program, which the site has to refuse.
// Three more fixtures are optional, each one more key in the command of step 2:
//   late=<id>  one more copy of loyalty-points with late.json as its link. On a new chain no
//              fixture has a coin and part A shows them entering the list. Once every
//              fixture has a coin, a new "late" shows it again.
//   pin=<id>   one more copy of hook-template whose manifest PINS its descriptor.
//   off=<id>   one more copy of early-bird whose manifest pins a file that was changed after.
//   For these two, step 2 prints the HOOK_URI to deploy with: the address, "#s=" and the pin
//   of the file (the first 16 bytes of its SHA-256, in base64url). The deploy script cannot
//   read a site on this machine from inside WSL, so it takes the pin as given and only warns.
// The site origin has to be http://localhost:8787, the address in the manifests: a browser
// lets a page read a descriptor from another origin only when that host allows it. The site's
// server does not serve web/review/, so the run answers the loads of the fixture files itself,
// from this folder (the Fetch domain of the DevTools protocol).
// One line per check, "  ok    ..." or "  FAIL  ...". Screenshots go to <out prefix>-<name>.png.
// The validator and the site are only read and traded on: nothing is stopped, restarted or
// deployed. The browser is started and closed by edge.mjs. Every throwaway wallet sells back
// what it holds when the run ends.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  HookpoolClient, DIRECTION, FLAGS, HOOK_KIND, NATIVE_MINT, PROGRAMS, pda, feeCeil, decodeHookManifest, decodeUpgradeAuthority, describeFlags, ix,
} from "../../sdk/dist/index.js";
// the localnet admin, loaded the way scripts/init-platform.mjs loads it (part V switches the approval rule)
import { deployer } from "../../scripts/cluster.mjs";
// the format and its validator, the same file the pages and the upload server run
import { checkDescriptor, parseUri, MAX_PINNED_ADDRESS_BYTES, MAX_URI_BYTES, PIN_BYTES } from "../workshop-descriptor.js";
// the watcher's own schema of the status file a site reads (pools.json)
import { buildStatus } from "../../watcher/lib/status.mjs";
import { startEdge } from "./edge.mjs";
// the site's name as the pages read it (web/config.js): a page title ends with " | <name>" when one is set
import CONFIG from "../config.js";
const SITE_NAME = String((CONFIG.site && CONFIG.site.name) || "").trim().slice(0, 40);
const TITLE_TAIL = SITE_NAME ? " | " + SITE_NAME : "";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const FIX_DIR = here("./workshop-fixtures/");
/// Where the manifests of the fixture hooks point: this site, on the port the flow is run against.
const FIX_ORIGIN = "http://localhost:8787/review/workshop-fixtures/";
const KIT = { fee: "../../hook-template/hook.json", early: "../../examples/hooks/early-bird/hook.json", points: "../../examples/hooks/loyalty-points/hook.json" };
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/// The pin of a file, worked out with Node's own SHA-256 and base64url, apart from the code
/// the pages run: the first 16 bytes of the hash as 22 characters.
const pin22 = (bytes) => createHash("sha256").update(bytes).digest().subarray(0, 16).toString("base64url");

// ---- "fixtures": write the descriptors of the local copies ------------------------------------------
if (process.argv[2] === "fixtures") {
  const ids = Object.fromEntries(process.argv.slice(3).map((a) => a.split("=")));
  for (const k of ["fee", "early", "points", "copycat", "greedy"]) { try { new PublicKey(ids[k]); } catch (_) { console.error("usage: node web/review/flow-workshop.mjs fixtures fee=<id> early=<id> points=<id> copycat=<id> greedy=<id> [late=<id>] [pin=<id>] [off=<id>]"); process.exit(1); } }
  mkdirSync(FIX_DIR, { recursive: true });
  const has = (k) => { try { new PublicKey(ids[k]); return true; } catch (_) { return false; } };
  const wrote = [];
  for (const [k, src] of Object.entries({ ...KIT, greedy: KIT.fee, ...(has("late") ? { late: KIT.points } : {}) })) {
    const j = readJson(here(src));
    j.program = ids[k];
    if (k === "greedy") { j.name = "Greedy setup"; j.summary = "A test hook. Its setup takes 0.25 SOL on top of its rent. The launch form has to refuse it."; j.rules = ["This hook exists to test the launch form. Do not launch on it."]; j.author = "The workshop review tool"; delete j.source; }
    if (k === "late") j.name = "Buyer points";
    writeFileSync(FIX_DIR + k + ".json", JSON.stringify(j, null, 2) + "\n");
    wrote.push(k + ".json");
  }
  // The two pinned fixtures. A manifest keeps its pin forever, so their files are written
  // once: a file that is there and names the right program is left as it is.
  const kept = (file, id) => existsSync(FIX_DIR + file) && readJson(FIX_DIR + file).program === id;
  if (has("pin")) {
    if (!kept("pin.json", ids.pin)) { const j = readJson(here(KIT.fee)); j.program = ids.pin; j.name = "Pinned fee"; writeFileSync(FIX_DIR + "pin.json", JSON.stringify(j, null, 2) + "\n"); wrote.push("pin.json"); }
    console.log("pin: deploy with HOOK_URI='" + FIX_ORIGIN + "pin.json#s=" + pin22(readFileSync(FIX_DIR + "pin.json")) + "'");
  }
  if (has("off")) {
    // The file on disk is never the pinned one, so it is written again on every run.
    const j = readJson(here(KIT.early)); j.program = ids.off; j.name = "Changed rules";
    const deployedWith = JSON.stringify(j, null, 2) + "\n";
    // what its author put at the address afterwards: the same descriptor with another first rule
    j.rules = ["Every buy pays the normal pool fee from the first slot.", ...j.rules.slice(1)];
    writeFileSync(FIX_DIR + "off.json", JSON.stringify(j, null, 2) + "\n"); wrote.push("off.json");
    console.log("off: deploy with HOOK_URI='" + FIX_ORIGIN + "off.json#s=" + pin22(Buffer.from(deployedWith)) + "' (the pin of the file BEFORE its first rule was changed; the file on disk is the changed one)");
  }
  const all = { fee: ids.fee, early: ids.early, points: ids.points, copycat: ids.copycat, greedy: ids.greedy };
  for (const k of ["late", "pin", "off"]) if (has(k)) all[k] = ids[k];
  writeFileSync(FIX_DIR + "hooks.json", JSON.stringify(all, null, 2) + "\n");
  console.log("wrote " + wrote.join(", ") + " and hooks.json to web/review/workshop-fixtures/");
  process.exit(0);
}

const [origin, prefix, partsArg = "all"] = process.argv.slice(2);
if (!origin || !prefix) { console.error("usage: node web/review/flow-workshop.mjs <site origin> <out prefix> [parts]\n       node web/review/flow-workshop.mjs fixtures fee=<id> early=<id> points=<id> copycat=<id> greedy=<id> [late=<id>] [pin=<id>] [off=<id>]"); process.exit(1); }
const PARTS = ["L", "A", "B", "D", "E", "U", "V", "N"];
const wanted = partsArg === "all" ? PARTS : partsArg.split(",").map((s) => s.trim().toUpperCase());
for (const w of wanted) if (!PARTS.includes(w)) { console.error("unknown part " + w + ". Parts: " + PARTS.join(", ")); process.exit(1); }
const want = (part) => wanted.includes(part);
const RPC = "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const alt = readJson(here("../deployments/localnet-alt.json")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const OUR = Object.values(PROGRAMS).map((p) => p.toBase58());
const W = 1440, HGT = 1500;
const SUPPLY = 1_000_000_000n * 1_000_000n;
const SEED_TEXT = "2", SEED = 2_000_000_000n;
const FIRST_TEXT = "0.05", FIRST = 50_000_000n;
/// The two limits of the guard, as web/workshop-lib.js states them. Part D reads them from the page too.
const MARGIN = 1_000_000n, CAP = 50_000_000n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);
const say = (label, value) => console.log("        " + (label + ":").padEnd(34) + " " + (typeof value === "string" ? value : JSON.stringify(value)));
let total = 0, failed = 0;
const failures = [], notRun = [];
const check = (ok, text) => { total++; if (!ok) { failed++; failures.push(text); } console.log((ok ? "  ok    " : "  FAIL  ") + text); return !!ok; };
const skip = (text) => { notRun.push(text); console.log("  NOT RUN  " + text); };
const fund = async (kp, sol) => conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
async function sendNode(ixs, signers, opts = {}) {
  const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx, opts);
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err && !opts.mayFail) throw new Error("node transaction failed: " + JSON.stringify(res.value.err));
  return { sig, err: res.value.err };
}

// ---- the page's own formatting and wording, written again here to compare with the chain ---------------
function fmtUnits(v, decimals, maxFrac = 4) {
  v = BigInt(v);
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return (neg ? "-" : "") + (v / base).toLocaleString("en-US") + (frac ? "." + frac : "");
}
const sol = (lamports, frac = 9) => fmtUnits(lamports, 9, frac);
const fmtPct = (bps, frac = 2) => (Number(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: frac }) + "%";
const short = (addr, n = 4) => { const s = String(addr); return s.length <= n * 2 + 3 ? s : s.slice(0, n) + "..." + s.slice(-n); };
const plat = await client.platform();
if (!plat) { console.error("no platform account on " + RPC); process.exit(1); }
/// What the site says a hook somebody else wrote may do, from its flags (common.js flagSentences).
function words(flags) {
  const s = describeFlags(flags);
  const out = s.sentences.slice();
  if ((s.canTakeFee || s.canOverrideFee || s.canOverrideCurve) && (s.runsOnBuys || s.runsOnSells)) out.splice(1, 0, "It can refuse " + (s.runsOnBuys && s.runsOnSells ? "a buy or a sell" : s.runsOnSells ? "a sell" : "a buy") + ". The pool cannot overrule that.");
  return out.map((t) => (t === "Can take a fee in the quote token to its treasury, up to the platform cap." ? t.slice(0, -1) + " of " + fmtPct(plat.maxHookFeeBps) + "."
    : t === "Can change the pool fee per trade, up to the platform cap." ? t.slice(0, -1) + " of " + fmtPct(plat.maxFeeOverrideBps) + "." : t));
}
/// The powers table of a hook's page (workshop-lib.js powerRows).
function powers(flags) {
  const s = describeFlags(flags);
  return {
    "The pool calls it on": s.runsOnBuys && s.runsOnSells ? "buys and sells" : s.runsOnBuys ? "buys only" : s.runsOnSells ? "sells only" : "no trade",
    "Fee it can take per trade": s.canTakeFee ? "at most " + fmtPct(plat.maxHookFeeBps) : "none",
    "Pool fee it can set": s.canOverrideFee ? "at most " + fmtPct(plat.maxFeeOverrideBps) : "it cannot",
    "Sets the price itself": s.canOverrideCurve ? "yes" : "no",
    "Can stop a deposit of liquidity": s.canBlockAdding ? "yes" : "no",
    "Can stop a withdrawal of liquidity": s.canBlockRemoval ? "yes" : "no",
  };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/// Deep equality that does not care about the order of an object's keys.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const alike = (a, b) => same(canon(a), canon(b));

// ---- the hooks' own instructions and accounts, built by hand as a hook's client would ----------------------
const disc = (name) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(Number(v)); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const cfgOf = (program, pool) => pda.cfg(program, pool);
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
/// hook-template: init_pool_config(pool, fee_bps, max_bps), accounts payer, owner, cfg, system program.
const feeInit = (program, payer, pool, feeBps, maxBps) => new TransactionInstruction({ programId: program, data: Buffer.concat([disc("init_pool_config"), pool.toBuffer(), u16(feeBps), u16(maxBps)]),
  keys: [meta(payer, true, true), meta(payer, true, true), meta(cfgOf(program, pool), false, true), meta(SystemProgram.programId, false, false)] });
/// early-bird: init_pool_config(pool, window_slots, discount_bps), accounts payer, cfg, system program.
const earlyInit = (program, payer, pool, windowSlots, discountBps) => new TransactionInstruction({ programId: program, data: Buffer.concat([disc("init_pool_config"), pool.toBuffer(), u64(windowSlots), u16(discountBps)]),
  keys: [meta(payer, true, true), meta(cfgOf(program, pool), false, true), meta(SystemProgram.programId, false, false)] });
/// loyalty-points: init_pool_config(pool, quote_per_point), accounts payer, cfg, system program.
const pointsInit = (program, payer, pool, quotePerPoint) => new TransactionInstruction({ programId: program, data: Buffer.concat([disc("init_pool_config"), pool.toBuffer(), u64(quotePerPoint)]),
  keys: [meta(payer, true, true), meta(cfgOf(program, pool), false, true), meta(SystemProgram.programId, false, false)] });
const key = (b, o) => new PublicKey(b.subarray(o, o + 32));
const DECODE = {
  // bump u8 | pool | owner | fee_bps u16 | max_bps u16 | creator
  fee: (b) => ({ pool: key(b, 9), owner: key(b, 41), feeBps: b.readUInt16LE(73), maxBps: b.readUInt16LE(75), creator: key(b, 77) }),
  // bump u8 | pool | creator | window_slots u64 | discount_bps u16 | created_slot u64
  early: (b) => ({ pool: key(b, 9), creator: key(b, 41), windowSlots: b.readBigUInt64LE(73), discountBps: b.readUInt16LE(81), createdSlot: b.readBigUInt64LE(83) }),
  // bump u8 | pool | creator | quote_per_point u64 | live bool | total_points u64 | buys_seen u64 | buys_rewarded u64
  points: (b) => ({ pool: key(b, 9), creator: key(b, 41), quotePerPoint: b.readBigUInt64LE(73), live: b[81] === 1 }),
};
async function txOf(sig) {
  for (let i = 0; i < 40; i++) { const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); if (t) return t; await sleep(250); }
  throw new Error("the transaction " + sig + " could not be read back");
}
const sigIn = (href) => { const m = /\/tx\/([1-9A-HJ-NP-Za-km-z]{60,90})/.exec(String(href || "")); return m ? m[1] : ""; };

// ---- the fixtures and the chain -----------------------------------------------------------------------------
const FIX = {};
if (existsSync(FIX_DIR + "hooks.json")) {
  const ids = readJson(FIX_DIR + "hooks.json");
  for (const k of Object.keys(ids)) {
    const id = new PublicKey(ids[k]);
    const [pd, man] = await Promise.all([conn.getAccountInfo(pda.programData(id), { dataSlice: { offset: 0, length: 45 } }), conn.getAccountInfo(pda.manifest(id))]);
    let frozen = false; try { frozen = !!pd && decodeUpgradeAuthority(new Uint8Array(pd.data)) === null; } catch (_) {}
    if (!frozen || !man) { console.log("note: the fixture hook \"" + k + "\" (" + ids[k] + ") is not on this chain, frozen, with a manifest. The header of this file says how to deploy it."); continue; }
    // What the site has to make of this hook, worked out here from its manifest and the file
    // its link names: the address, the pin, and whether the file is the pinned one.
    const manifest = decodeHookManifest(new Uint8Array(man.data));
    const link = parseUri(manifest.uri, true);
    const file = FIX_DIR + link.url.split("/").pop();
    const bytes = link.url && existsSync(file) ? readFileSync(file) : null;
    const descriptor = bytes ? JSON.parse(bytes.toString("utf8")) : null;
    // `hash` is the pin of the file as it is on disk now, taken with Node's own SHA-256
    const f = FIX[k] = { id, id58: ids[k], manifest, address: link.url, pin: link.pin, descriptor, hash: bytes ? pin22(bytes) : "" };
    f.expect = !descriptor ? "unknown" : f.pin && f.pin !== f.hash ? "refused" : !checkDescriptor(descriptor, f.id58).ok ? "refused" : "ok";
    f.why = f.expect !== "refused" ? "" : f.pin && f.pin !== f.hash ? "pin" : "program";
  }
} else console.log("note: web/review/workshop-fixtures/hooks.json is missing. The header of this file says how to make the fixtures.");
/// The sentences the pages say about whether an author's text can still change, and what a pin is worth.
const PINNED_SENTENCE = "This description is pinned. The hook's manifest holds a fingerprint of this file, and the site refuses any other file at that address.";
const PINNED_ON_CARD = "This text is pinned. The site refuses any other file at its address.";
const PIN_MEANS = "The pin proves that this is the file the author pinned. It is not a signature, and it says nothing about the code.";
const UNPINNED_SENTENCE = "The author can still change this text, and the code cannot change either way.";
const PIN_REFUSAL = "The file at this address is not the one the hook was deployed with.";
/// The hooks the workshop has to list, from the pools on chain: frozen, not a platform program.
async function chainHooks() {
  const pools = await client.allPools();
  const by = new Map();
  for (const p of pools) {
    if (!p.hasHook || p.hookKind !== HOOK_KIND.FROZEN || OUR.includes(p.hookProgram.toBase58())) continue;
    const k = p.hookProgram.toBase58();
    if (!by.has(k)) by.set(k, { id: p.hookProgram, id58: k, pools: [] });
    by.get(k).pools.push(p);
  }
  const list = [...by.values()];
  const mans = list.length ? await conn.getMultipleAccountsInfo(list.map((h) => pda.manifest(h.id))) : [];
  list.forEach((h, i) => {
    h.pools.sort((a, b) => (a.createdSlot < b.createdSlot ? -1 : a.createdSlot > b.createdSlot ? 1 : 0));
    h.manifest = mans[i] ? decodeHookManifest(new Uint8Array(mans[i].data)) : null;
    h.launches = h.pools.length;
    h.collected = h.pools.filter((p) => p.quoteMint.equals(NATIVE_MINT)).reduce((n, p) => n + p.hookFeesQuoteTotal, 0n);
    h.volume = h.pools.filter((p) => p.quoteMint.equals(NATIVE_MINT)).reduce((n, p) => n + p.volumeQuoteTotal, 0n);
    h.swaps = h.pools.reduce((n, p) => n + p.swapCount, 0n);
    // what the site should make of the manifest's link
    const fix = Object.entries(FIX).find(([, f]) => f.id58 === h.id58);
    h.fix = fix ? fix[0] : "";
    h.expect = !parseUri(h.manifest ? h.manifest.uri : "", true).url ? "none" : fix ? fix[1].expect : "unknown";
    h.why = fix ? fix[1].why : "";
    h.pinned = !!(fix && fix[1].pin);
    h.descriptor = h.expect === "ok" ? fix[1].descriptor : null;
    h.name = h.descriptor ? h.descriptor.name : h.manifest ? h.manifest.name : "";
  });
  list.sort((a, b) => b.launches - a.launches || (b.collected > a.collected ? 1 : b.collected < a.collected ? -1 : 0) || (a.id58 < b.id58 ? -1 : 1));
  return list;
}

// ---- wallets --------------------------------------------------------------------------------------
const dev = Keypair.generate(), visitor = Keypair.generate(), trader = Keypair.generate(), poor = Keypair.generate(), victim = Keypair.generate();
await Promise.all([fund(dev, 18), fund(visitor, 1), fund(trader, 2), fund(victim, 4)]);
/// [wallet, pool] pairs that may hold coins when the run ends.
const held = [];
async function sellBack(kp, poolKey) {
  try {
    const p = await client.pool(poolKey);
    if (!p) return 0n;
    const amount = await client.tokenBalance(kp.publicKey, p.baseMint, p.baseTokenProgram);
    if (amount <= 0n) return 0n;
    await sendNode(await client.swapInstructions(kp.publicKey, p, await client.hookRef(p, kp.publicKey), DIRECTION.SELL, amount, 0n), [kp]);
    return amount;
  } catch (e) { console.error("  could not sell back for " + kp.publicKey.toBase58() + ": " + e.message); return 0n; }
}

// ---- the browser ------------------------------------------------------------------------------------
const run = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
const edge = await startEdge({ name: "workshop", width: W, height: HGT + 200 });
let cleaned = false;
/// The site server part U starts, while it runs. It is stopped by its own process id.
let ownServer = null;
process.on("SIGINT", async () => { console.log("\ninterrupted: closing the browser and selling back"); try { await cleanup(); } finally { process.exit(130); } });
let id = 0; const pending = new Map(); const events = []; const pageErrors = [];
let ws, where = "about:blank";
/// Answers for requests the run takes over: url part -> { status, body }. Empty most of the time.
const takeover = new Map();
/// Console errors the run causes on purpose (an answer of 404 or 400 it gave itself).
const onPurpose = [];
const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
/// Run a function inside the page. It must not use anything from this file but its arguments.
const pg = (fn, ...args) => ev("(" + fn.toString() + ")(" + args.map((a) => JSON.stringify(a)).join(", ") + ")");
const shots = [];
const shot = async (name) => { const s = await call("Page.captureScreenshot", { format: "png" }); writeFileSync(prefix + name + ".png", Buffer.from(s.data, "base64")); shots.push(prefix + name + ".png"); console.log("        wrote " + prefix + name + ".png"); };
const until = async (expression, ms = 30000, step = 150) => { for (let t = 0; t < ms; t += step) { try { if (await ev(expression)) return true; } catch (_) {} await sleep(step); } return false; };
const mouse = (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const clearToasts = async () => { await ev("(() => { for (const t of document.querySelectorAll('#toasts .toast')) t.click(); return true; })()"); await sleep(350); };
/// A real click in the middle of an element, after bringing it into view.
async function click(selector) {
  // on the guide, an element inside a closed step: open that step first, as a reader would
  const closed = await ev("(() => { const e = document.querySelector(" + q(selector) + "); const b = e && e.closest('.ws-step-body'); return b && b.hidden ? b.id.replace('Body', 'Head') : ''; })()");
  if (closed) { await click("#" + closed); await sleep(300); }
  const at = () => ev("(() => { const e = document.querySelector(" + q(selector) + "); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width, b.height]; })()");
  if (!(await at())) throw new Error("nothing matches " + selector);
  for (let attempt = 0; ; attempt++) {
    await ev("document.querySelector(" + q(selector) + ").scrollIntoView({ block: 'center' }); true");
    await sleep(120);
    const [x, y] = await at();
    const top = await ev("(() => { const e = document.elementFromPoint(" + x + ", " + y + "); const want = document.querySelector(" + q(selector) + "); return !!e && (e === want || want.contains(e)); })()");
    if (top) { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); return; }
    if (attempt > 0) throw new Error("something covers " + selector);
    await clearToasts(); // a toast in the corner can sit on a button
  }
}
/// The launch form opens on the curve. The launches of this flow are seeded: pick "Seed it
/// yourself" the way a launcher would, before the seed field is typed into.
async function seedMode() {
  if (await ev("!!document.querySelector('input[name=start][value=seed]') && !document.querySelector('input[name=start][value=seed]').checked")) await click("label.choice:has(input[name=start][value=seed]) .title");
}
/// Click a field, clear it, type into it the way a keyboard would.
async function type(selector, text) {
  if (selector === "#seed") await seedMode();
  await click(selector);
  await ev("(() => { const e = document.querySelector(" + q(selector) + "); e.select(); return true; })()");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  if (text) await call("Input.insertText", { text });
  await sleep(300);
}
const standin = (kp) => JSON.stringify(kp ? { secret: Array.from(kp.secretKey), address: kp.publicKey.toBase58() } : { secret: [], address: "" });
const walletScript = (kp) => `
  (() => {
    // one script for the whole run: a later wallet, or no wallet, is handed over through localStorage
    let who = ${standin(kp)};
    try { const s = localStorage.getItem("__standin"); if (s) who = JSON.parse(s); } catch (_) {}
    window.__signPrompts = 0;
    window.__who = who.address;
    if (!who.address) { localStorage.removeItem("Programmable.wallet"); return; }
    localStorage.setItem("Programmable.wallet", "phantom");
    const SECRET = who.secret;
    const ADDRESS = who.address;
    const key = async () => { const H = await import("/js/hookpool.js"); return H.Keypair.fromSecretKey(Uint8Array.from(SECRET)); };
    const publicKey = { toBase58: () => ADDRESS };
    const w = { isPhantom: true, publicKey, on() {}, disconnect: async () => {},
      connect: async () => ({ publicKey }),
      signTransaction: async (tx) => { window.__signPrompts++; tx.sign([await key()]); return tx; },
      signAllTransactions: async (txs) => { window.__signPrompts++; const k = await key(); for (const t of txs) t.sign([k]); return txs; } };
    window.phantom = { solana: w };
  })();`;
let walletScriptId = null;
const prompts = () => ev("window.__signPrompts");
const waitLoad = async () => { for (let i = 0; i < 200 && !events.includes("Page.loadEventFired"); i++) await sleep(100); };
/// Wait until `ready` holds. The page sometimes boots before the stand-in wallet is injected, so the
/// silent reconnect finds no wallet: then connect it the way the Connect wallet button does.
async function settle(ready, path, withWallet) {
  if (await until(ready, 9000)) { await sleep(500); return true; }
  if (withWallet && !(await ev("!!document.querySelector('#walletBtn.on')"))) {
    const how = await ev("(async () => { try { const W = await import('/wallet.js'); const H = await import('/js/hookpool.js'); if (!W.available().length) return 'no wallet in the page'; await W.connect(W.available()[0], H.PublicKey); return 'connected by hand'; } catch (e) { return 'connect threw ' + e.message; } })()");
    console.log("        note: the stand-in wallet was not restored on " + path.split("?")[0] + ": " + how);
  }
  if (await until(ready, 14000)) { await sleep(500); return true; }
  return false;
}
/// Open a page of the site as one of the throwaway wallets (null: no wallet) and wait until `ready` holds.
async function open(kp, path, ready, base = origin) {
  if (!walletScriptId) walletScriptId = (await call("Page.addScriptToEvaluateOnNewDocument", { source: walletScript(kp) })).identifier;
  await ev("(() => { try { localStorage.setItem(\"__standin\", " + JSON.stringify(standin(kp)) + "); } catch (_) {} return true; })()");
  for (let attempt = 0; attempt < 2; attempt++) {
    events.length = 0; where = path;
    await call("Page.navigate", { url: base + path });
    await waitLoad();
    if (await settle(ready, path, !!kp)) return;
    console.log("        note: the page was not ready, loading it once more: " + path);
  }
  throw new Error("the page did not get ready: " + path);
}
/// Follow a link of the page with a real click and wait for the page it leads to.
async function follow(selector, ready) {
  const href = await ev("document.querySelector(" + q(selector) + ").getAttribute('href')");
  events.length = 0; where = "/" + href;
  await clearToasts();
  await click(selector);
  await waitLoad();
  if (!(await settle(ready, href, true))) throw new Error("the page did not get ready after the link " + href);
  return href;
}
const overflow = () => ev("document.documentElement.scrollWidth + ' of ' + window.innerWidth");
/// A phone that meets content wider than its screen widens its layout to fit it, so the page
/// then reports a window wider than the screen. Both numbers have to be the screen's.
let screenW = W;
const fits = async () => { const [a, b] = (await overflow()).split(" of ").map(Number); return a <= b && b <= screenW; };
const view = async (width, height, scheme = "dark") => {
  screenW = width;
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await sleep(500);
};
const scrollTo = (selector) => ev("(() => { document.querySelector(" + q(selector) + ").scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); return true; })()");
const txt = (selector) => pg((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; }, selector);
const kvOf = (selector) => pg((s) => { const root = document.querySelector(s); if (!root) return null; const o = {}; for (const dt of root.querySelectorAll("dt")) { const dd = dt.nextElementSibling; o[dt.textContent.replace(/\s+/g, " ").trim()] = dd ? dd.textContent.replace(/\s+/g, " ").trim() : ""; } return o; }, selector);
/// Screenshots of the page that is open, at 1440 and at 375, and the check that 375 does not scroll sideways.
/// The site has one dark look, so there is no light shot.
async function pair(name, label, at375) {
  await clearToasts();
  await ev("window.scrollTo(0, 0); true"); await sleep(300);
  await shot("-" + name + "-1440");
  await view(375, 900);
  if (at375) { await scrollTo(at375); await sleep(300); } else { await ev("window.scrollTo(0, 0); true"); await sleep(300); }
  await shot("-" + name + "-375");
  check(await fits(), label + ": no horizontal scroll at 375 (" + (await overflow()) + ")");
  await view(W, HGT);
}
/// A part of the run: a thrown error is one failed check, and the next part still runs.
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); }
  catch (e) {
    check(false, "this part stopped early: " + ((e && e.message) || JSON.stringify(e) || String(e)));
    if (e && e.stack) console.log(String(e.stack).split("\n").slice(0, 4).join("\n"));
    try { await shot("-failure-" + title.split(/[ .]/)[0].toLowerCase()); } catch (_) {}
    try { await view(W, HGT); } catch (_) {}
  }
}

// ---- reading the workshop pages -------------------------------------------------------------------------
const listReady = "document.querySelectorAll('#hooks .ws-card').length > 0 || !!document.querySelector('#hooks .ws-empty')";
const readList = () => pg(() => {
  const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  return [...document.querySelectorAll("#hooks .ws-card")].map((c) => ({
    id: c.dataset.hook, state: c.dataset.descriptor, href: c.querySelector(".coin-link").getAttribute("href"), name: t(c.querySelector(".coin-link")),
    lot: t(c.querySelector(".coin-pair")), lotTitle: c.querySelector(".coin-pair").title, art: !!c.querySelector(".coin-art img"),
    power: t(c.querySelector(".ws-power")), powerMain: t(c.querySelector(".ws-power b")), says: t(c.querySelector(".ws-says")),
    desc: t(c.querySelector(".ws-desc")), pinned: (c.querySelector(".ws-desc") || { dataset: {} }).dataset.pin || "",
    launches: t(c.querySelector(".launches")), collected: t(c.querySelector(".collected")),
  }));
});
/// What a card says a hook may do, in a few words (workshop-lib.js powerShort).
function powerShortOf(flags) {
  const s = describeFlags(flags);
  const main = s.canOverrideCurve ? "Sets the price" : s.canTakeFee ? "Fee up to " + fmtPct(plat.maxHookFeeBps) : s.canOverrideFee ? "Sets the pool fee" : s.runsOnBuys || s.runsOnSells ? "No fee" : "Called on no trade";
  const runs = s.runsOnBuys && s.runsOnSells ? "called on buys and sells" : s.runsOnBuys ? "called on buys only" : s.runsOnSells ? "called on sells only" : "";
  return { main, text: runs ? main + ", " + runs : main };
}
/// What a card says when its author published no descriptor in use (workshop.js).
const NO_WORDS = { none: "Its author published no description.", refused: "Its author's description was refused. Its page says why." };
const hookReady = "!document.querySelector('#page').hidden && !!document.querySelector('#checks [data-check=trade]') && document.querySelector('#checks [data-check=trade]').dataset.result !== 'running' && !!document.querySelector('#totals dd')";
/// The same, once the trade check has run with the wallet the page was opened with: the page
/// runs it once before the wallet is restored and once after.
const hookTraded = hookReady + " && ['passed', 'failed'].includes(document.querySelector('#checks [data-check=trade]').dataset.result)";
const hookPoor = hookReady + " && /Your wallet holds less/.test(((document.querySelector('#checks [data-check=trade] .means') || {}).textContent || ''))";
const hookNoWallet = hookReady + " && /^Connect a wallet/.test(((document.querySelector('#checks [data-check=trade] .means') || {}).textContent || ''))";
/// A hook nobody has launched on yet has no pool to try: its trade check says so and stays there.
const hookNoCoin = hookReady + " && /No coin trades on this hook yet/.test(((document.querySelector('#checks [data-check=trade] .means') || {}).textContent || ''))";
const readHook = () => pg(() => {
  const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const $ = (s) => document.querySelector(s);
  const kv = (sel) => { const o = {}; for (const dt of document.querySelectorAll(sel + " dt")) o[t(dt)] = t(dt.nextElementSibling); return o; };
  const checks = {}; for (const li of document.querySelectorAll("#checks li")) checks[li.dataset.check] = { result: li.dataset.result, word: t(li.querySelector(".res")), what: t(li.querySelector(".what")), means: t(li.querySelector(".means")) };
  return {
    title: document.title, name: t($("#name")), by: t($("#by")), program: t($("#programId")), copy: !!$("#idRow .icon-btn"), explorers: [...document.querySelectorAll("#idRow .ext-links a")].map((a) => a.href),
    summary: t($("#summary")), rules: [...document.querySelectorAll("#ruleList li")].map(t), source: $("#source") ? $("#source").href : "", descriptorUrl: $("#descriptorUrl") ? $("#descriptorUrl").href : "",
    noRules: t($("#noRules")), pinNote: t($("#pinNote")), pinMeans: t($("#pinMeans")), pinned: $("#pinNote") ? $("#pinNote").dataset.pin : "", manifestLink: $("#manifestLink") ? $("#manifestLink").href : "", rulesCard: t($("#rulesCard")),
    sentences: [...document.querySelectorAll("#sentences li")].map(t), powers: kv("#powers"), checks, order: [...document.querySelectorAll("#checks li")].map((li) => li.dataset.check),
    lede: t($("#checked .lede")), totals: kv("#totals"), launch: $("#launchOn") ? $("#launchOn").getAttribute("href") : "", launchHelp: t($("#launchBox .help")), firstLaunch: t($("#firstLaunch")), noLaunch: t($("#noLaunch")),
    coinsLede: t($("#coinsLede")), coins: [...document.querySelectorAll("#coins tbody tr")].map((tr) => ({ pool: tr.dataset.pool, href: tr.querySelector("a.coin-cell").getAttribute("href"), name: t(tr.querySelector(".name")), cells: [...tr.querySelectorAll("td[data-label]")].map((td) => td.dataset.label + " " + t(td)) })),
    state: t($("#state")), stateHidden: $("#state").hidden,
  };
});
const formReady = "!!document.querySelector('#walletBtn.on') && !!document.querySelector('#launchBtn') && !!document.querySelector('#customVerdict .verdict') && !document.querySelector('#customPool').hidden && !!document.querySelector('#customSetup [data-descriptor]')";
/// The hook's settings as the Custom hook card of the launch form shows them.
const readSetup = () => pg(() => {
  const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const box = document.querySelector("#customSetup");
  const tag = box.querySelector("[data-descriptor]");
  return {
    state: tag ? tag.dataset.descriptor : "", head: t(tag), all: t(box), link: (box.querySelector("a.link") || { getAttribute: () => "" }).getAttribute("href"),
    fields: [...box.querySelectorAll(".setup-fields label.field")].map((l) => { const i = l.querySelector("[data-arg]"); return { arg: i.dataset.arg, label: t(l.querySelector("span > span")), hint: t(l.querySelector("span > .dim")), value: i.value, unit: t(l.querySelector(".suffix")), help: t(l.querySelector(".help")) }; }),
    guard: t(box.querySelector("#customGuard")), pin: t(box.querySelector("[data-pin]")), pinned: (box.querySelector("[data-pin]") || { dataset: {} }).dataset.pin || "",
  };
});
/// What the settings fields of a descriptor should look like (workshop-lib.js setupFields).
function expectedFields(d) {
  const range = { u8: [0n, 255n], u16: [0n, 65535n], u32: [0n, 4294967295n], u64: [0n, 18446744073709551615n], i64: [-9223372036854775808n, 9223372036854775807n] };
  const raw = (v, dec) => { const [w, f = ""] = String(v).split("."); return BigInt(w) * 10n ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0"); };
  const back = (r, dec) => { const base = 10n ** BigInt(dec); const f = dec ? (r % base).toString().padStart(dec, "0").replace(/0+$/, "") : ""; return (r / base).toString() + (f ? "." + f : ""); };
  return d.setup.args.filter((a) => !["pool", "launcher", "base_mint", "quote_mint"].includes(a.type)).map((a) => {
    const dec = a.decimals || 0, [tMin, tMax] = range[a.type];
    const min = a.min === undefined ? tMin : raw(a.min, dec), max = a.max === undefined ? tMax : raw(a.max, dec);
    const hint = min === tMin && max === tMax ? "" : max === tMax ? "at least " + back(min, dec) : back(min, dec) + " to " + back(max, dec);
    return { arg: a.name, label: a.label, hint, value: a.default === undefined ? "" : back(raw(a.default, dec), dec), unit: a.unit || "", help: a.help || "" };
  });
}

/// Launch a coin through the launch form that is open on a custom hook. `settings`: text to
/// type into the hook's own fields, by argument name. Returns what the page said and did.
async function launchOnForm(kp, sym, name, settings, opts = {}) {
  const out = { sym };
  out.pool = new PublicKey(await txt("#customPool .mono"));
  await type("#name", name);
  await type("#symbol", sym);
  await type("#seed", SEED_TEXT);
  await type("#devBuy", FIRST_TEXT);
  if (!(await ev("document.querySelector('details.more').open"))) await click("details.more summary");
  // a JSON file the site serves stands for the coin's metadata (serve.js does not serve package.json)
  await type("#metaUrl", origin + "/workshop/site.json?coin=" + sym.toLowerCase());
  for (const [arg, value] of Object.entries(settings || {})) await type("#customSetup [data-arg=" + arg + "]", value);
  if (opts.beforeLaunch) await opts.beforeLaunch(out);
  out.before = BigInt(await conn.getBalance(kp.publicKey));
  const p0 = await prompts();
  await click("#launchBtn");
  await until("!!document.querySelector('#result a.btn') || !!document.querySelector('#result .bad')", 90000, 300);
  await sleep(400);
  out.ok = await ev("!!document.querySelector('#result a.btn')");
  out.prompts = (await prompts()) - p0;
  out.result = await txt("#result");
  out.steps = await txt("#steps");
  out.setup = await readSetup();
  out.spent = out.before - BigInt(await conn.getBalance(kp.publicKey));
  if (out.ok) {
    const links = await pg(() => [...document.querySelectorAll("#result a")].map((a) => ({ text: a.textContent.trim(), href: a.href })));
    out.sig1 = sigIn((links.find((l) => l.text === "tx 1") || {}).href); out.sig2 = sigIn((links.find((l) => l.text === "tx 2") || {}).href);
    held.push([kp, out.pool]);
  }
  return out;
}
/// The first number before "SOL" after a marker in a sentence of the guard, as lamports.
const solAfter = (text, marker) => { const m = new RegExp(marker + "[^0-9]*([0-9][0-9,]*(?:\\.[0-9]+)?) SOL").exec(text || ""); if (!m) return null; const [w, f = ""] = m[1].replace(/,/g, "").split("."); return BigInt(w) * 1_000_000_000n + BigInt((f + "000000000").slice(0, 9)); };

try {
  ws = new WebSocket((await edge.page()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === "Fetch.requestPaused") {
      // a request this run takes over, to show what the page does with another answer
      const hit = [...takeover.entries()].find(([part]) => d.params.request.url.includes(part));
      // The fixture descriptors live in web/review/workshop-fixtures/, a folder the site's server
      // does not serve (serve.js hides review/). Their manifests name them under the site's
      // address, so the run answers those loads itself, from the files on disk, to any origin.
      const fx = !hit && /\/review\/workshop-fixtures\/([A-Za-z0-9_-]+\.json)(?:[?#].*)?$/.exec(d.params.request.url);
      if (fx && existsSync(FIX_DIR + fx[1])) call("Fetch.fulfillRequest", { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }, { name: "cache-control", value: "no-store" }, { name: "access-control-allow-origin", value: "*" }], body: readFileSync(FIX_DIR + fx[1]).toString("base64") }).catch(() => {});
      else if (!hit) call("Fetch.continueRequest", { requestId: d.params.requestId }).catch(() => {});
      else call("Fetch.fulfillRequest", { requestId: d.params.requestId, responseCode: hit[1].status, responseHeaders: [{ name: "content-type", value: hit[1].type || "application/json" }, { name: "cache-control", value: "no-store" }], body: Buffer.from(hit[1].body).toString("base64") }).catch(() => {});
    }
    else if (d.method === "Runtime.exceptionThrown") pageErrors.push(where.split("?")[0] + "  EXCEPTION " + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") pageErrors.push(where.split("?")[0] + "  console.error " + d.params.args.map((a) => a.value || a.description).join(" "));
    else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") pageErrors.push(where.split("?")[0] + "  " + d.params.entry.source + " error " + d.params.entry.text + (d.params.entry.url ? " " + d.params.entry.url.slice(0, 120) : ""));
    else if (d.method) events.push(d.method);
  };
  await call("Page.enable"); await call("Runtime.enable"); await call("Log.enable"); await call("DOM.enable");
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Fetch.enable", { patterns: [{ urlPattern: "*workshop/reviewed.json*" }, { urlPattern: "*workshop/site.json*" }, { urlPattern: "*workshop-fixtures/*" }, { urlPattern: "*/api/metadata*" }, { urlPattern: "*/config.js*" }, { urlPattern: "*__watcher/*" }] });
  await view(W, HGT);
  console.log("run " + run + ", parts " + wanted.join(",") + ", site " + origin + ", chain " + RPC + ", platform caps: hook fee " + fmtPct(plat.maxHookFeeBps) + ", fee override " + fmtPct(plat.maxFeeOverrideBps));
  console.log("wallets: launcher " + dev.publicKey.toBase58() + ", visitor " + visitor.publicKey.toBase58() + ", trader " + trader.publicKey.toBase58());
  console.log("fixture hooks on chain: " + (Object.entries(FIX).map(([k, f]) => k + " " + f.id58).join(", ") || "none"));
  const listedBefore = new Set((await chainHooks()).map((h) => h.id58));
  const R = {};

  // ---- L. launches through the launch form -----------------------------------------------------------
  if (want("L")) await section("L. a coin launched on a workshop hook through the launch form, with the hook's own settings", async () => {
    if (!FIX.fee) { skip("L: launches on the fixture hooks. They are not on this chain."); return; }
    // from the hook's page, by its button, as a visitor would come
    const f = FIX.fee;
    await open(dev, "/workshop-hook.html?id=" + f.id58, listedBefore.has(f.id58) ? hookTraded : hookNoCoin);
    const page0 = await readHook();
    check(page0.launch === "launch-hook.html?hook=" + f.id58 && /builds this hook's settings from its descriptor/.test(page0.launchHelp) && /A simulation is not a guarantee\. The hook's code is the truth\./.test(page0.launchHelp), "the hook's page offers \"Launch a coin on this hook\" and says the form simulates the setup, and that a simulation is not a guarantee");
    await follow("#launchOn", formReady);
    check((await ev("location.pathname")) === "/launch-hook.html" && (await ev("document.querySelector('#customId').value")) === f.id58, "the button opens the Custom hook launch page with the hook filled in");
    let s = await readSetup();
    say("the form says about the hook", s.head + " | " + s.fields.map((x) => x.label + " [" + x.value + " " + x.unit + ", " + x.hint + "]").join(" | "));
    check(s.state === "ok" && s.head === f.descriptor.name + ", by " + f.descriptor.author && s.all.includes(f.descriptor.summary), "the form loaded the descriptor the manifest links to: \"" + s.head + "\"");
    check(same(s.fields, expectedFields(f.descriptor)), "the settings form is built from the descriptor: every field's label, unit, range, default and help sentence are the descriptor's");
    check(s.all.includes("A simulation is not a guarantee. The hook's code is the truth.") && s.all.includes("plus " + sol(MARGIN, 6) + " SOL") && s.all.includes("more than " + sol(CAP, 6) + " SOL in all"), "the card states the guard and its limits (" + sol(MARGIN, 6) + " SOL above the rent, " + sol(CAP, 6) + " SOL in all), and that a simulation is not a guarantee");
    check(s.link === "workshop-hook.html?id=" + f.id58, "the card links back to the hook's page in the workshop");
    check(!f.pin && s.pinned === "no" && s.pin === UNPINNED_SENTENCE, "this hook's manifest holds the address of its descriptor and no pin, and the card says so in one sentence: \"" + s.pin + "\"");
    await scrollTo("#customVerdict"); await sleep(250); await shot("-launch-settings-1440");
    await view(375, 900); await scrollTo("#customSetup"); await sleep(250); await shot("-launch-settings-375");
    check(await fits(), "launch form with a hook's settings: no horizontal scroll at 375 (" + (await overflow()) + ")");
    await view(W, HGT);

    // 1. a setting the hook's own code refuses: the fee above the ceiling. The simulation stops it.
    const sym = "WSF" + run;
    let r = await launchOnForm(dev, sym, "Workshop Fee " + run, { fee_bps: "8", max_bps: "7.5" });
    const mintOf = async (pool) => { const p = await client.pool(pool); return p ? p.baseMint : null; };
    say("a fee above the ceiling", r.result);
    check(!r.ok && r.prompts === 0 && /^The first transaction failed in a simulation\. Nothing was sent\./.test(r.result) && /fee above the ceiling fixed at creation/.test(r.result), "a setting the hook refuses stops the launch in the simulation, with the hook's own reason, and the wallet is never asked: " + r.prompts + " prompts");
    check(r.spent === 0n && (await mintOf(r.pool)) === null, "nothing was sent: the wallet holds what it held and no pool exists");
    // a value outside the descriptor's own range is refused by the form before any simulation
    await type("#customSetup [data-arg=fee_bps]", "12");
    await click("#launchBtn"); await until("!!document.querySelector('#result .bad')", 15000); await sleep(300);
    check((await txt("#result")) === "\"Fee on every trade\" must be between 0 and 10 %.", "a value outside the descriptor's range is refused by the form: " + (await txt("#result")));

    // 2. the launch
    r = await launchOnForm(dev, sym, "Workshop Fee " + run, { fee_bps: "3.25", max_bps: "7.5" });
    if (!check(r.ok && r.prompts === 2, "both launch transactions confirm, with two wallet prompts" + (r.ok ? "" : ". The page said: " + r.result + " | " + r.steps))) throw new Error("the launch did not go through");
    say("the guard said", r.setup.guard);
    const tx1 = await txOf(r.sig1);
    const keys = tx1.transaction.message.getAccountKeys({ accountKeysFromLookups: tx1.meta.loadedAddresses });
    const took = BigInt(tx1.meta.preBalances[0]) - BigInt(tx1.meta.postBalances[0]);
    const cfg = await conn.getAccountInfo(cfgOf(f.id, r.pool));
    const saidTakes = solAfter(r.setup.guard, "takes"), saidRent = solAfter(r.setup.guard, "wallet\\. "), saidFloor = solAfter(r.setup.guard, "less than");
    check(keys.get(0).equals(dev.publicKey) && saidTakes === (took / 1000n) * 1000n, "the simulation was right: the page said the first transaction takes " + sol(saidTakes || 0n, 6) + " SOL, and it took " + sol(took) + " SOL");
    check(!!cfg && saidRent === (BigInt(cfg.lamports) / 1000n) * 1000n && BigInt(cfg.lamports) === BigInt(await conn.getMinimumBalanceForRentExemption(cfg.data.length)), "what the page called the rent of the hook's settings is the rent of its config account: " + sol(cfg ? cfg.lamports : 0) + " SOL for " + (cfg ? cfg.data.length : 0) + " bytes, and the hook holds nothing above it");
    const ixs = tx1.transaction.message.compiledInstructions, last = ixs[ixs.length - 1];
    const lastData = Buffer.from(last.data);
    const isFloor = keys.get(last.programIdIndex).equals(SystemProgram.programId) && last.accountKeyIndexes.length === 2 && last.accountKeyIndexes.every((i) => keys.get(i).equals(dev.publicKey)) && lastData.readUInt32LE(0) === 2;
    check(isFloor && lastData.readBigUInt64LE(4) === BigInt(tx1.meta.postBalances[0]) && saidFloor === (BigInt(tx1.meta.postBalances[0]) / 1000n) * 1000n, "the first transaction ends with the floor: a transfer from the wallet to itself of " + (isFloor ? sol(lastData.readBigUInt64LE(4)) : "?") + " SOL, the balance the simulation left and the transaction left");
    const hookIx = ixs.find((i) => keys.get(i.programIdIndex).equals(f.id));
    const want1 = feeInit(f.id, dev.publicKey, r.pool, 325, 750);
    check(!!hookIx && Buffer.from(hookIx.data).equals(want1.data) && same(hookIx.accountKeyIndexes.map((i) => keys.get(i).toBase58()), want1.keys.map((k) => k.pubkey.toBase58())), "the setup instruction the form built from the descriptor is byte for byte the one the hook's own client builds by hand: init_pool_config(pool, 325, 750) with payer, owner, config, system program");
    const c = cfg ? DECODE.fee(Buffer.from(cfg.data)) : null;
    check(!!c && c.pool.equals(r.pool) && c.owner.equals(dev.publicKey) && c.creator.equals(dev.publicKey) && c.feeBps === 325 && c.maxBps === 750, "chain: the hook's config for this pool holds what was typed: fee " + (c ? c.feeBps : "?") + " bps, ceiling " + (c ? c.maxBps : "?") + " bps, owned and created by the launcher");
    let p = await client.pool(r.pool);
    const firstFee = feeCeil(FIRST - feeCeil(FIRST, plat.protocolFeeBps), 325);
    check(!!p && p.hookProgram.equals(f.id) && p.hookKind === HOOK_KIND.FROZEN && p.hookFlags === f.manifest.flags && p.creator.equals(dev.publicKey) && p.hookTreasuryOwner.equals(dev.publicKey), "chain: the pool is at the address the form named, on the hook " + short(f.id58) + ", a frozen custom hook, created by the launcher");
    check(p.hookFeesQuoteTotal === firstFee, "chain: the launcher's own first buy already paid the hook 3.25%: " + sol(p.hookFeesQuoteTotal) + " SOL");
    const buy = 200_000_000n;
    await sendNode(await client.swapInstructions(trader.publicKey, p, await client.hookRef(p, trader.publicKey), DIRECTION.BUY, buy, 0n), [trader]);
    held.push([trader, r.pool]);
    p = await client.pool(r.pool);
    check(p.hookFeesQuoteTotal === firstFee + feeCeil(buy - feeCeil(buy, plat.protocolFeeBps), 325), "chain: a buy by a second wallet pays the same 3.25% to the hook: " + sol(p.hookFeesQuoteTotal) + " SOL collected in all");
    R.fee = { pool: r.pool, sym, took, cfgRent: BigInt(cfg.lamports) };

    // 3. the two examples: other argument types, another account list
    const more = [
      ["early", "WSE" + run, "Workshop Early " + run, { window_slots: "40", discount_bps: "25" }, (b, pool) => { const x = DECODE.early(b); return { ok: x.pool.equals(pool) && x.creator.equals(dev.publicKey) && x.windowSlots === 40n && x.discountBps === 2500 && x.createdSlot > 0n, text: "window " + x.windowSlots + " slots, an early buyer pays " + x.discountBps + " bps of the pool fee, started at slot " + x.createdSlot }; }, (pool) => earlyInit(FIX.early.id, dev.publicKey, pool, 40n, 2500)],
      ["points", "WSP" + run, "Workshop Points " + run, { quote_per_point: "0.02" }, (b, pool) => { const x = DECODE.points(b); return { ok: x.pool.equals(pool) && x.creator.equals(dev.publicKey) && x.quotePerPoint === 20_000_000n && x.live, text: sol(x.quotePerPoint) + " SOL a point, live" }; }, (pool) => pointsInit(FIX.points.id, dev.publicKey, pool, 20_000_000n)],
    ];
    // the optional sixth fixture: a hook that had no coin when this run began gets its first one here
    if (FIX.late && !listedBefore.has(FIX.late.id58)) more.push(["late", "WSL" + run, "Workshop Late " + run, { quote_per_point: "0.05" }, (b, pool) => { const x = DECODE.points(b); return { ok: x.pool.equals(pool) && x.creator.equals(dev.publicKey) && x.quotePerPoint === 50_000_000n && x.live, text: sol(x.quotePerPoint) + " SOL a point, live" }; }, (pool) => pointsInit(FIX.late.id, dev.publicKey, pool, 50_000_000n)]);
    for (const [k, sy, nm, settings, verify, byHand] of more) {
      const h = FIX[k];
      if (!h) { skip("L: a launch on the fixture hook \"" + k + "\". It is not on this chain."); continue; }
      await open(dev, "/launch-hook.html?hook=" + h.id58, formReady);
      s = await readSetup();
      check(s.state === "ok" && s.head === h.descriptor.name + ", by " + h.descriptor.author && same(s.fields, expectedFields(h.descriptor)), "\"" + h.descriptor.name + "\": the settings form is the descriptor's: " + s.fields.map((x) => x.label + " [" + x.value + (x.unit ? " " + x.unit : "") + "]").join(", "));
      r = await launchOnForm(dev, sy, nm, settings);
      if (!check(r.ok && r.prompts === 2, "\"" + h.descriptor.name + "\": both launch transactions confirm, with two wallet prompts" + (r.ok ? "" : ". The page said: " + r.result + " | " + r.steps))) continue;
      const t1 = await txOf(r.sig1);
      const ks = t1.transaction.message.getAccountKeys({ accountKeysFromLookups: t1.meta.loadedAddresses });
      const hi = t1.transaction.message.compiledInstructions.find((i) => ks.get(i.programIdIndex).equals(h.id)), wantIx = byHand(r.pool);
      check(!!hi && Buffer.from(hi.data).equals(wantIx.data) && same(hi.accountKeyIndexes.map((i) => ks.get(i).toBase58()), wantIx.keys.map((x) => x.pubkey.toBase58())), "\"" + h.descriptor.name + "\": the setup instruction from the descriptor is byte for byte the one of the hook's own client");
      const info = await conn.getAccountInfo(cfgOf(h.id, r.pool));
      const v = info ? verify(Buffer.from(info.data), r.pool) : { ok: false, text: "no config account" };
      const pl = await client.pool(r.pool);
      check(v.ok && !!pl && pl.hookProgram.equals(h.id) && pl.hookKind === HOOK_KIND.FROZEN, "\"" + h.descriptor.name + "\": chain: the coin trades on the hook and its config holds what was typed: " + v.text);
      const tookK = BigInt(t1.meta.preBalances[0]) - BigInt(t1.meta.postBalances[0]);
      check(solAfter(r.setup.guard, "takes") === (tookK / 1000n) * 1000n, "\"" + h.descriptor.name + "\": the page said the first transaction takes " + sol(solAfter(r.setup.guard, "takes") || 0n, 6) + " SOL, and it took " + sol(tookK) + " SOL");
      R[k] = { pool: r.pool, sym: sy };
    }

    // 4. the hook whose descriptor names another program: the form refuses the descriptor and
    //    still launches, with the config made by hand as the form says
    const cc = FIX.copycat;
    if (!cc) skip("L: the launch form on the hook whose descriptor names another program. It is not on this chain.");
    else {
      await open(dev, "/launch-hook.html?hook=" + cc.id58, formReady);
      s = await readSetup();
      say("the form says about its descriptor", s.all);
      check(s.state === "refused" && s.fields.length === 0 && s.all.includes("It names another program (" + FIX.early.id58 + ")") && s.all.includes("The form does not use it.") && /create them yourself for the pool address below before step 2/.test(s.all), "a descriptor that names another program is refused by the launch form: no settings fields, and the form says why");
      if (listedBefore.has(cc.id58)) say("note", "this hook already has a coin from an earlier run, so no second one is launched on it");
      else {
        r = await launchOnForm(dev, "WSC" + run, "Workshop Copy " + run, null, { beforeLaunch: async (o) => { await sendNode([earlyInit(cc.id, dev.publicKey, o.pool, 20n, 5000)], [dev]); } });
        check(r.ok && r.prompts === 2 && !!(await client.pool(r.pool)), "without a descriptor in use the form still launches, on a config made by hand for the pool address it named: " + (r.ok ? "pool " + r.pool.toBase58() : r.result));
      }
    }

    // 5. a hook whose manifest pins its descriptor: used, and labelled as pinned
    const pf = FIX.pin;
    if (!pf) skip("L: the launch form on the hook whose manifest pins its descriptor. It is not on this chain.");
    else {
      await open(dev, "/launch-hook.html?hook=" + pf.id58, formReady);
      s = await readSetup();
      check(!!pf.pin && pf.pin === pf.hash && s.state === "ok" && s.pinned === "yes" && s.pin === PINNED_SENTENCE + " " + PIN_MEANS && same(s.fields, expectedFields(pf.descriptor)), "a hook whose manifest pins its descriptor (" + pf.manifest.uri.length + " bytes of link, pin " + pf.pin + "): the file at the address has that pin, the form uses it, says the description is pinned, and says what a pin is worth: \"" + PIN_MEANS + "\"");
      if (listedBefore.has(pf.id58)) say("note", "the pinned hook already has a coin from an earlier run, so no second one is launched on it");
      else {
        r = await launchOnForm(dev, "WSN" + run, "Workshop Pinned " + run, { fee_bps: "1.5", max_bps: "4" });
        const info = r.ok ? await conn.getAccountInfo(cfgOf(pf.id, r.pool)) : null;
        const c2 = info ? DECODE.fee(Buffer.from(info.data)) : null;
        check(r.ok && r.prompts === 2 && !!c2 && c2.feeBps === 150 && c2.maxBps === 400, "a coin launches on the pinned hook through its settings form, and its config on chain holds what was typed: " + (c2 ? "fee " + c2.feeBps + " bps, ceiling " + c2.maxBps + " bps" : r.result));
        if (r.ok) R.pin = { pool: r.pool, sym: "WSN" + run };
      }
    }
    // 6. a hook whose pinned descriptor was changed afterwards: refused, although the file is valid
    const xf = FIX.off;
    if (!xf) skip("L: the launch form on the hook whose pinned descriptor was changed afterwards. It is not on this chain.");
    else {
      await open(dev, "/launch-hook.html?hook=" + xf.id58, formReady);
      s = await readSetup();
      say("the form says about its descriptor", s.all);
      check(xf.why === "pin" && checkDescriptor(xf.descriptor, xf.id58).ok && s.state === "refused" && s.fields.length === 0 && s.all.includes(PIN_REFUSAL) && s.all.includes("The form does not use it."), "a hook whose pinned descriptor was changed afterwards: the file at the address is a valid descriptor of this very program, and the form refuses it all the same, because it is not the file the manifest pins");
      if (listedBefore.has(xf.id58)) say("note", "this hook already has a coin from an earlier run, so no second one is launched on it");
      else {
        r = await launchOnForm(dev, "WSX" + run, "Workshop Changed " + run, null, { beforeLaunch: async (o) => { await sendNode([earlyInit(xf.id, dev.publicKey, o.pool, 20n, 5000)], [dev]); } });
        check(r.ok && r.prompts === 2 && !!(await client.pool(r.pool)), "it still gets a coin, on a config made by hand, and so enters the list: " + (r.ok ? "pool " + r.pool.toBase58() : r.result));
      }
    }
  });

  // ---- A. the list ----------------------------------------------------------------------------------
  if (want("A")) await section("A. the workshop lists every frozen hook of another builder that has a pool, from the chain", async () => {
    await open(visitor, "/workshop.html", listReady);
    let chain = await chainHooks(), cards = await readList();
    if (cards.length !== chain.length) { await click("#refresh"); await sleep(2500); chain = await chainHooks(); cards = await readList(); }
    say("chain", chain.map((h) => short(h.id58) + " " + (h.name || "?") + " x" + h.launches + " " + sol(h.collected, 4)).join(", ") || "no such hook");
    say("page", cards.map((c) => c.lot + " " + c.name + " x" + c.launches + " " + c.collected).join(", ") || "no card");
    check(same(cards.map((c) => c.id), chain.map((h) => h.id58)), "the page lists exactly the hooks the chain has, most launches first: " + cards.length + " on the page, " + chain.length + " on chain");
    check((await txt("#count")) === (chain.length === 1 ? "1 hook" : chain.length + " hooks"), "the heading counts them: " + (await txt("#count")));
    const byId = new Map(chain.map((h) => [h.id58, h]));
    let facts = true, voices = true;
    for (const c of cards) {
      const h = byId.get(c.id); if (!h) { facts = false; continue; }
      const p = powerShortOf(h.manifest.flags);
      const ok = c.launches === String(h.launches) && c.collected === sol(h.collected, 4) + " SOL" && c.name === (h.name || "Unnamed hook") && c.lot === short(h.id58, 4) && c.lotTitle === h.id58 && c.href === "workshop-hook.html?id=" + h.id58 && c.powerMain === p.main && c.power === p.text && c.art;
      if (!ok) { facts = false; say("differs", { page: c, chain: { launches: h.launches, collected: sol(h.collected, 4), name: h.name, power: p.text } }); }
      if (h.expect === "ok") voices = voices && c.state === "ok" && c.says === h.descriptor.summary && c.pinned === (h.pinned ? "yes" : "no") && c.desc === (h.pinned ? "Pinned description" : "Description can change");
      else if (h.expect === "none") voices = voices && c.state === "none" && c.says === NO_WORDS.none && c.desc === "";
      else if (h.expect === "refused") voices = voices && c.state === "refused" && c.says === NO_WORDS.refused && c.desc === "";
    }
    check(facts, "every card agrees with the chain: name, program id in short and in full, coins, SOL collected, the link to its page, and what the pool lets it do in a few words with the cap in numbers (" + [...new Set(cards.map((c) => c.power))].join("; ") + ")");
    check(voices, "every card keeps the two voices apart: a line from the chain and a line in its author's words. A hook with a descriptor shows its summary, one without says so, one whose descriptor was refused says so");
    const states = cards.reduce((o, c) => { o[c.state] = (o[c.state] || 0) + 1; return o; }, {});
    say("descriptors", states);
    const pinnedCards = cards.filter((c) => c.pinned === "yes"), openCards = cards.filter((c) => c.pinned === "no");
    check(openCards.length > 0 && pinnedCards.length === chain.filter((h) => h.expect === "ok" && h.pinned).length && pinnedCards.every((c) => c.desc === "Pinned description") && openCards.every((c) => c.desc === "Description can change"), "every card with a descriptor in use says whether its text can still change: " + pinnedCards.length + " \"Pinned description\", " + openCards.length + " \"Description can change\". A card without one says nothing of the kind");
    const head = await txt(".page-top"), means = await txt("#means");
    const ruleOn = (await client.platform()).hookApprovalRequired;
    check(!ruleOn && /^Custom hooks /.test(head) && /A hook is listed from its first coin\. The ones Programmable reviewed carry its mark\./.test(head) && (await ev("document.querySelector('#listYours').getAttribute('href')")) === "review-hook.html" && (await txt("#listYours")) === "Get your hook reviewed", "with the approval rule off the head says what lists a hook and that reviewed ones carry the mark, and has one action, Get your hook reviewed");
    check(/Programmable reviews a hook's code against ten rules before it can open a pool\./.test(means) && /A review is not an audit and not a promise\./.test(means) && /An approval covers that one frozen program\./.test(means) && (await ev("document.querySelector('#unreviewed').hidden")), "a panel under the list says what a listing means: the review, the frozen code, the two voices, and that a review is not an audit. No \"Not reviewed\" section while the rule is off");
    // the search narrows the grid and the count says so
    const probe = (FIX.pin && cards.find((c) => c.id === FIX.pin.id58)) || cards[0];
    if (probe) {
      await type("#search", probe.name);
      const found = await readList(), countNow = await txt("#count");
      check(found.some((c) => c.id === probe.id) && found.length < cards.length && countNow === found.length + " of " + (chain.length === 1 ? "1 hook" : chain.length + " hooks"), "the search narrows the grid: \"" + probe.name + "\" leaves " + found.length + " of " + cards.length + " cards, and the count reads \"" + countNow + "\"");
      await type("#search", "no such hook here");
      check((await txt("#hooks .ws-empty")) === "No hook matches that search.", "a search that matches nothing says so");
      await type("#search", "");
      check((await readList()).length === cards.length, "clearing the search brings every card back");
    }
    // listing is automatic: a hook is listed by its first coin, and one without a coin is not
    const fresh = Object.entries(FIX).filter(([k, f]) => k !== "greedy" && !listedBefore.has(f.id58) && cards.some((c) => c.id === f.id58)).map(([k]) => k);
    if (fresh.length) check(true, "with the rule off listing is automatic: the fixture " + (fresh.length === 1 ? "hook \"" + fresh[0] + "\" had no coin when this run began, so the workshop did not list it. This run launched a coin on it, and it is listed now" : "hooks " + fresh.join(", ") + " had no coin when this run began, so the workshop did not list them. This run launched a coin on each, and they are listed now"));
    else say("note", "every fixture hook already had a coin from an earlier run, so this run could not show a hook entering the list");
    if (FIX.greedy) check(!cards.some((c) => c.id === FIX.greedy.id58) && !(await chainHooks()).some((h) => h.id58 === FIX.greedy.id58), "a frozen hook that has no coin is not listed: " + short(FIX.greedy.id58) + " has a manifest and a descriptor, and no pool");
    await pair("list", "workshop");
    // a card is one link to the hook's page
    if (cards.length) {
      await follow("#hooks .ws-card .coin-link", hookTraded);
      check((await ev("location.pathname + location.search")) === "/workshop-hook.html?id=" + cards[0].id, "a card opens the hook's own page");
    }
  });

  // ---- B. a hook's page ------------------------------------------------------------------------------
  if (want("B")) await section("B. a hook's page: every fact and every check against the chain", async () => {
    const chain = await chainHooks();
    /// What to wait for on a hook's page: the trade check run with the wallet, or, for a hook without a coin, its sentence.
    const readyFor = (f) => (chain.some((x) => x.id58 === f.id58) ? hookTraded : hookNoCoin);
    const target = chain.find((h) => h.fix === "fee") || chain.find((h) => h.expect === "ok");
    if (!target) skip("B: the page of a hook with a descriptor. No such hook has a pool on this chain.");
    else {
      const f = target;
      await open(visitor, "/workshop-hook.html?id=" + f.id58, hookTraded);
      const h = await readHook();
      const [pd, extra, mds, slot] = await Promise.all([conn.getAccountInfo(pda.programData(f.id), { dataSlice: { offset: 0, length: 45 } }), conn.getAccountInfo(pda.extraMetas(f.id)), Promise.all(f.pools.map((p) => client.metadata(p.baseMint))), conn.getSlot()]);
      const d = f.descriptor;
      say("page", h.name + " | " + h.by + " | " + h.program);
      check(h.name === d.name && h.title === d.name + TITLE_TAIL && h.program === f.id58 && h.copy && h.explorers.length === 2 && h.explorers.every((u) => u.includes(f.id58)), "the head: the descriptor's name, the whole program id with a copy button, and two explorer links to the program");
      check(h.by === "Built by " + d.author + ", says its descriptor. The wallet " + short(f.pools[0].creator.toBase58()) + " launched the first coin on it.", "the builder: the author as the descriptor names it, marked as the descriptor's word, and the wallet that created the first pool, from the chain: \"" + h.by + "\"");
      check(same(h.rules, d.rules) && h.summary === d.summary && h.source === d.source && h.descriptorUrl === f.manifest.uri && /The hook's author wrote these rules\. This site shows them and does not check them against the code\./.test(h.rulesCard), "the rules: all " + d.rules.length + " of the descriptor, numbered, marked as the author's words, with the author's link to the code and the address of the descriptor");
      check(same(h.sentences, words(f.manifest.flags)) && same(h.powers, powers(f.manifest.flags)), "the powers, from the chain: the flags " + f.manifest.flags + " in words, and the platform caps as numbers: " + Object.entries(h.powers).map(([k, v]) => k + " " + v).join("; "));
      check(same(h.order, ["frozen", "manifest", "descriptor", "trade", "reviewed"]) && /They are not an audit\./.test(h.lede) && /Your browser ran these checks just now/.test(h.lede), "\"How it was checked\" lists five checks, says the browser ran them, and that they are not an audit");
      const frozen = !!pd && decodeUpgradeAuthority(new Uint8Array(pd.data)) === null;
      check(h.checks.frozen.result === "passed" && h.checks.frozen.word === "Passed" && frozen, "check a, the program is frozen: " + h.checks.frozen.word + ". Chain: the program has no upgrade authority");
      check(h.checks.manifest.result === "passed" && h.checks.manifest.means.includes("flags " + f.manifest.flags) && h.checks.manifest.means.includes("(" + extra.data.length + " bytes)"), "check b, manifest and account list: " + h.checks.manifest.word + ". Chain: flags " + f.manifest.flags + ", list of " + extra.data.length + " bytes");
      check(h.checks.descriptor.result === "passed" && h.checks.descriptor.means.includes(short(f.id58, 5)), "check c, the descriptor loads and names this program: " + h.checks.descriptor.word);
      check(!f.pin && h.pinned === "no" && h.pinNote === UNPINNED_SENTENCE && /The manifest does not pin its content\.$/.test(h.checks.descriptor.means), "the manifest of this hook holds an address without a pin, and the page says so in one plain sentence: \"" + h.pinNote + "\"");
      const tryPool = f.pools.slice().sort((a, b) => (b.reserveQuote > a.reserveQuote ? 1 : b.reserveQuote < a.reserveQuote ? -1 : 0))[0];
      let sdkBuy = 0n; try { sdkBuy = await client.quoteOnChain(visitor.publicKey, await client.pool(tryPool.address), DIRECTION.BUY, 10_000_000n); } catch (_) {}
      check(h.checks.trade.result === "passed" && /A buy of 0\.01 SOL and a sell of the coins it gave ran in one simulated transaction/.test(h.checks.trade.means) && /Nothing was sent\./.test(h.checks.trade.means) && sdkBuy > 0n, "check d, a buy and a sell go through right now: " + h.checks.trade.word + ", simulated with the visitor's wallet. The SDK's own simulation of that buy also passes");
      const approvedNow = (await client.platform()).approvedHooks.some((k) => k.equals(f.id));
      check(!approvedNow && h.checks.reviewed.result === "no" && h.checks.reviewed.word === "No" && h.checks.reviewed.what === "Reviewed by Programmable" && /^Programmable has not reviewed this hook\./.test(h.checks.reviewed.means) && readJson(here("../workshop/reviewed.json")).hooks.length === 0, "check e, reviewed by Programmable, read from the chain: " + h.checks.reviewed.word + ". The program is not on the approved list, the rule is off, and the registry web/workshop/reviewed.json is empty: \"" + h.checks.reviewed.means + "\"");
      const int = (n) => Number(n).toLocaleString("en-US");
      const want = { Coins: int(f.launches), "Collected by the hook": sol(f.collected, 6) + " SOL", Volume: sol(f.volume, 4) + " SOL", Trades: int(f.swaps) };
      // the chain is shared, and the visitor's own simulation sends nothing: the totals are read a moment apart
      const now = (await chainHooks()).find((x) => x.id58 === f.id58);
      const want2 = { Coins: int(now.launches), "Collected by the hook": sol(now.collected, 6) + " SOL", Volume: sol(now.volume, 4) + " SOL", Trades: int(now.swaps) };
      check(same(h.totals, want) || same(h.totals, want2), "the totals: " + Object.entries(h.totals).map(([k, v]) => k + " " + v).join("; ") + ". Chain: " + Object.entries(want2).map(([k, v]) => k + " " + v).join("; "));
      const rows = f.pools.map((p, i) => ({ pool: p.address.toBase58(), href: "coin.html?pool=" + p.address.toBase58(), name: ((mds[i] && mds[i].name) || "Unnamed coin") + ((mds[i] && mds[i].symbol) || "") }));
      check(h.coins.length === now.pools.length && rows.every((r, i) => h.coins[i] && h.coins[i].pool === r.pool && h.coins[i].href === r.href && h.coins[i].name.replace(/\s+/g, "") === r.name.replace(/\s+/g, "")), "its coins: " + h.coins.length + " rows, the oldest first, each with its name and a link to its coin page");
      const cellOk = h.coins.every((c, i) => { const p = now.pools[i]; return c.cells.includes("Pooled " + sol(p.reserveQuote, 2) + " SOL") && c.cells.includes("Trades " + String(p.swapCount)) && c.cells.includes("Hook collected " + sol(p.hookFeesQuoteTotal, 6) + " SOL"); });
      check(cellOk, "each coin's row agrees with its pool on chain: SOL pooled, trades, and what the hook collected there");
      check(h.launch === "launch-hook.html?hook=" + f.id58 && h.firstLaunch === "", "\"Launch a coin on this hook\" leads to the Custom hook card with the hook filled in. This hook has pools, so the button carries no first-launch warning");
      await pair("hook", "a hook's page", "#checked");
      await ev("window.scrollTo(0, 0); true"); await view(375, 900); await sleep(300); await shot("-hook-375-top"); await view(W, HGT);

      // the same page for a wallet that cannot pay for a trade, and for no wallet
      await open(poor, "/workshop-hook.html?id=" + f.id58, hookPoor);
      let t = (await readHook()).checks.trade;
      check(t.result === "notrun" && /Your wallet holds less than 0\.05 SOL/.test(t.means), "check d with a wallet that holds no SOL: \"" + t.word + "\". " + t.means);
      await open(null, "/workshop-hook.html?id=" + f.id58, hookNoWallet);
      t = (await readHook()).checks.trade;
      check(t.result === "notrun" && /^Connect a wallet that holds 0\.05 SOL on localnet\./.test(t.means) && /It sends nothing\.$/.test(t.means), "check d without a wallet: \"" + t.word + "\". " + t.means);

      // Check d without a wallet on a site that has a watcher: the page shows the watcher's verdict
      // for the pool. The site's config names no watcher, so for these loads the run answers
      // config.js with a watcher address and answers that address itself. The status file is built
      // by the watcher's own code (watcher/lib/status.mjs), with a launch-rules pool and its burn
      // entry next to this hook's pool, as the watcher writes them today.
      const configText = readFileSync(here("../config.js"), "utf8");
      const withWatcher = configText.replace(/watcherUrl:\s*""/, "watcherUrl: \"" + origin + "/__watcher\"");
      if (withWatcher === configText) skip("B: check d from the watcher's verdict. web/config.js names a watcher already, or is written another way.");
      else {
        const rulesPool = (await client.allPools()).find((p) => p.hasHook && p.hookProgram.equals(PROGRAMS.hook_rules));
        const sims = (buyOk, sellOk) => ({ buySim: { ok: buyOk, error: buyOk ? null : "the hook refused the buy", amountOut: buyOk ? 123456n : null }, sellSim: { ok: sellOk, error: sellOk ? null : "the hook refused the sell", amountOut: sellOk ? 9000n : null, holder: visitor.publicKey.toBase58() } });
        const statusFile = (buyOk, sellOk) => JSON.stringify(buildStatus({
          updatedAt: new Date().toISOString(), cluster: "localnet",
          platform: { paused: false, whitelist: OUR, protocolFeeBps: plat.protocolFeeBps, maxHookFeeBps: plat.maxHookFeeBps, maxFeeOverrideBps: plat.maxFeeOverrideBps, treasury: null, admin: null }, platformChanges: [],
          pools: {
            [tryPool.address.toBase58()]: { lastCheck: new Date(Date.now() - 90_000).toISOString(), score: buyOk && sellOk ? "clean" : "danger", hookKind: "frozen", template: "custom", ...sims(buyOk, sellOk), effectiveBuyTaxBps: 325, effectiveSellTaxBps: 325, declared: null, notes: ["A hook somebody else wrote."] },
            ...(rulesPool ? { [rulesPool.address.toBase58()]: { lastCheck: new Date().toISOString(), score: "clean", hookKind: "platform", template: "rules", ...sims(true, true), effectiveBuyTaxBps: 100, effectiveSellTaxBps: 100,
              declared: { sniperSlots: "100", sniperStartFeeBps: 3000, buy: { creatorBps: 100, holdersBps: 0, burnBps: 0 }, sell: { creatorBps: 100, holdersBps: 0, burnBps: 0 }, maxBuyQuote: "0", limitSlots: "0", creatorLockSeconds: "0", burnPot: "1200", obsSlot: "0", obsReserveBase: "0", obsReserveQuote: "0" },
              burn: { pot: 1200n, capBps: 12, step: "observe", observedAtSlot: null, nextCallAtSlot: null, keeper: { calls: 2, bought: 1, spentLamports: 900, lastAt: new Date().toISOString(), lastOutcome: "bought" } }, notes: ["Launch rules: the rates and windows of this coin were fixed at launch."] } } : {}),
          },
        }));
        const sym = ((mds[f.pools.indexOf(tryPool)] || {}).symbol) || short(tryPool.baseMint.toBase58());
        const fromWatcher = hookReady + " && /^From this site's watcher/.test(((document.querySelector('#checks [data-check=trade] .means') || {}).textContent || ''))";
        takeover.set("/config.js", { status: 200, type: "text/javascript; charset=utf-8", body: withWatcher });
        try {
          const shape = JSON.parse(statusFile(true, true));
          takeover.set("__watcher/pools.json", { status: 200, body: statusFile(true, true) });
          // This stand-in watcher publishes only the status file. The page asks a watcher for
          // market.json first (common.js allPools), gets a 404 here and reads the pools from the
          // chain instead: that 404 is staged, not a fault of the site.
          onPurpose.push(/__watcher\/market\.json/);
          await open(null, "/workshop-hook.html?id=" + f.id58, fromWatcher);
          let w = await readHook();
          check(w.checks.trade.result === "passed" && w.checks.trade.word === "Passed" && w.checks.trade.means === "From this site's watcher, 1m ago, on " + sym + ". Buy simulation passes, sell simulation passes. Connect a wallet to run it yourself." && w.name === d.name && same(w.rules, d.rules) && w.coins.length === f.pools.length,
            "check d without a wallet on a site with a watcher: the page shows the watcher's verdict for the pool, read from a status file in the watcher's shape of today (" + Object.keys(shape.pools).length + " pools" + (rulesPool ? ", one of them a launch-rules pool with a \"burn\" entry and the new \"declared\" keys" : "") + "), and the rest of the page is whole: \"" + w.checks.trade.means + "\"");
          takeover.set("__watcher/pools.json", { status: 200, body: statusFile(true, false) });
          await open(null, "/workshop-hook.html?id=" + f.id58, fromWatcher);
          w = await readHook();
          check(w.checks.trade.result === "failed" && w.checks.trade.word === "Failed" && /Buy simulation passes, sell simulation fails\./.test(w.checks.trade.means), "and when the watcher's sell simulation fails the check says Failed: \"" + w.checks.trade.means + "\"");
          // with a wallet the page runs the check itself, watcher or not
          await open(visitor, "/workshop-hook.html?id=" + f.id58, hookTraded);
          w = await readHook();
          check(w.checks.trade.result === "passed" && /with your wallet, just now/.test(w.checks.trade.means), "with a wallet connected the page runs the simulation itself and does not repeat the watcher's verdict");
        } finally { takeover.delete("/config.js"); takeover.delete("__watcher/pools.json"); }
      }

      // the registry alone gives no mark: an entry for a program that is not on the approved list
      // changes nothing (the chain decides; part V shows the approved states)
      takeover.set("workshop/reviewed.json", { status: 200, body: JSON.stringify({ schema: 2, hooks: [{ program: f.id58, name: "Fixed fee", reviewedAt: "2026-10-24", report: "reviews/tax.html" }] }) });
      await open(visitor, "/workshop-hook.html?id=" + f.id58, hookTraded);
      t = (await readHook()).checks.reviewed;
      const markShown = await ev("!document.querySelector('#markRow').hidden");
      takeover.delete("workshop/reviewed.json");
      check(t.result === "no" && !markShown, "check e when the registry names a program that is not on the approved list: still \"" + t.word + "\", and no mark. The registry only supplies a report's link");

      // the author's file now names another program: refused, and the page falls back to chain facts
      const other = Object.values(FIX).find((x) => x.id58 !== f.id58 && x.expect === "ok");
      if (other) {
        takeover.set(new URL(f.manifest.uri).pathname, { status: 200, body: JSON.stringify(other.descriptor) });
        await open(visitor, "/workshop-hook.html?id=" + f.id58, hookTraded);
        const r = await readHook();
        takeover.delete(new URL(f.manifest.uri).pathname);
        say("when the file names another program", r.checks.descriptor.word + ". " + r.checks.descriptor.means);
        check(r.checks.descriptor.result === "failed" && r.checks.descriptor.means.includes("It names another program (" + other.id58 + ")") && r.rules.length === 0 && r.name === f.manifest.name && /^The descriptor was refused\./.test(r.noRules), "a descriptor that names another program is refused: check c says Failed with the reason, no rule of that file is shown, and the name falls back to the manifest's \"" + f.manifest.name + "\"");
        check(same(r.sentences, words(f.manifest.flags)) && /no descriptor in use/.test(r.launchHelp), "the chain facts stay: the powers are still the flags', and the launch button says the form will not build settings");
      }
      takeover.set(new URL(f.manifest.uri).pathname, { status: 404, body: "{}" });
      onPurpose.push(/workshop-fixtures/);
      await open(visitor, "/workshop-hook.html?id=" + f.id58, hookTraded);
      const gone = await readHook();
      takeover.delete(new URL(f.manifest.uri).pathname);
      check(gone.checks.descriptor.result === "failed" && /The descriptor could not be loaded\. The address answered 404\./.test(gone.checks.descriptor.means) && gone.rules.length === 0, "a descriptor that does not load: check c says Failed, \"" + gone.checks.descriptor.means + "\"");
      takeover.set(new URL(f.manifest.uri).pathname, { status: 200, body: JSON.stringify({ ...f.descriptor, summary: "x".repeat(20000) }) });
      await open(visitor, "/workshop-hook.html?id=" + f.id58, hookTraded);
      const big = await readHook();
      takeover.delete(new URL(f.manifest.uri).pathname);
      check(big.checks.descriptor.result === "failed" && /The file is larger than 16384 bytes\./.test(big.checks.descriptor.means) && big.rules.length === 0, "a file larger than a descriptor may be is not read to its end and is refused: \"" + big.checks.descriptor.means + "\"");
    }
    // a frozen hook nobody has launched on yet: its page works, and says what lists it
    if (FIX.greedy && !chain.some((h) => h.id58 === FIX.greedy.id58)) {
      const g = FIX.greedy;
      await open(visitor, "/workshop-hook.html?id=" + g.id58, hookReady + " && /No coin trades on this hook yet/.test(((document.querySelector('#checks [data-check=trade] .means') || {}).textContent || ''))");
      const h = await readHook();
      check(h.name === g.descriptor.name && h.totals.Coins === "0" && h.coins.length === 0 && h.coinsLede === "No coin has launched on this hook yet. It is listed in Custom hooks after its first launch." && /No coin has launched on it yet\.$/.test(h.by) && h.checks.trade.result === "notrun" && h.checks.frozen.result === "passed" && h.checks.descriptor.result === "passed", "a frozen hook without a coin has a page too, by its program id: its rules, its checks, no coin, and the sentence that its first launch lists it");
      check(h.firstLaunch === "No pool has been created on this hook yet, so nothing on chain shows that the pool can call it. A launch is two transactions. If the hook refuses the pool in the second one, the coin of the first stays created and paid for." && h.launch === "launch-hook.html?hook=" + g.id58, "and its launch button comes with a warning that a hook with a pool does not get: \"" + h.firstLaunch + "\"");
    }

    // a hook whose author published no descriptor
    const plain = chain.find((h) => h.expect === "none");
    if (!plain) skip("B: the page of a hook without a descriptor. Every hook on this chain has one.");
    else {
      await open(visitor, "/workshop-hook.html?id=" + plain.id58, hookTraded);
      const h = await readHook();
      check(h.name === plain.manifest.name && h.checks.descriptor.result === "none" && h.checks.descriptor.word === "Not published" && h.noRules === "The author published no descriptor, so this hook has no rules in words." && h.rules.length === 0, "a hook without a descriptor (" + short(plain.id58) + ", manifest link " + plain.manifest.uri + "): listed from chain facts alone, check c says \"Not published\", and the rules card says the author published none");
      check(h.manifestLink === plain.manifest.uri && same(h.sentences, words(plain.manifest.flags)) && h.checks.frozen.result === "passed" && h.checks.manifest.result === "passed" && h.totals.Coins === String(plain.launches) && /^Its author is not named\./.test(h.by), "its page still has every chain fact: the frozen check, the manifest, the powers in words, its coins, and the manifest's plain link, which the site shows and does not load");
      await ev("window.scrollTo(0, 0); true"); await sleep(300); await shot("-hook-plain-1440");
    }
    // the hook that borrows another hook's descriptor
    const cc = FIX.copycat;
    if (!cc) skip("B: the page of the hook whose manifest links to another hook's descriptor. It is not on this chain.");
    else {
      await open(visitor, "/workshop-hook.html?id=" + cc.id58, readyFor(cc));
      const h = await readHook();
      say("its descriptor check", h.checks.descriptor.word + ". " + h.checks.descriptor.means);
      check(cc.manifest.uri === FIX.early.manifest.uri && h.checks.descriptor.result === "failed" && h.checks.descriptor.means.includes("It names another program (" + FIX.early.id58 + "). A descriptor counts only for the program it names."), "a hook whose manifest links to another hook's descriptor (the same address as \"" + FIX.early.descriptor.name + "\"): check c says Failed, the file names another program");
      check(h.name === cc.manifest.name && h.rules.length === 0 && !h.rulesCard.includes(FIX.early.descriptor.rules[0]) && /^The descriptor was refused\./.test(h.noRules), "none of the borrowed rules is shown, and the page carries the manifest's own name \"" + cc.manifest.name + "\"");
      await ev("window.scrollTo(0, 0); true"); await sleep(300); await shot("-hook-refused-1440");
    }
    // a hook whose manifest pins its descriptor: the description can never change
    const pf = FIX.pin;
    if (!pf) skip("B: the page of the hook whose manifest pins its descriptor. It is not on this chain.");
    else {
      await open(visitor, "/workshop-hook.html?id=" + pf.id58, readyFor(pf));
      const h = await readHook();
      const linkBytes = Buffer.byteLength(pf.manifest.uri);
      say("its manifest's link", pf.manifest.uri);
      // the file the pages are served at that address: the run answers those loads from this folder
      const served = readFileSync(FIX_DIR + pf.address.split("/").pop());
      check(pf.manifest.uri === pf.address + "#s=" + pf.hash && pin22(served) === pf.hash && /^[A-Za-z0-9_-]{22}$/.test(pf.hash) && linkBytes === Buffer.byteLength(pf.address) + PIN_BYTES && linkBytes <= MAX_URI_BYTES, "chain: the manifest's link is the address and \"#s=\" with the pin of the file as the site serves it now (the first 16 bytes of its SHA-256 in base64url, " + pf.hash + "), " + linkBytes + " of the manifest's " + MAX_URI_BYTES + " bytes (address " + Buffer.byteLength(pf.address) + ", pin " + PIN_BYTES + ")");
      check(h.checks.descriptor.result === "passed" && /Its content is the one the manifest pins\.$/.test(h.checks.descriptor.means) && h.pinned === "yes" && h.pinNote === PINNED_SENTENCE && h.pinMeans === PIN_MEANS && same(h.rules, pf.descriptor.rules) && h.descriptorUrl === pf.address, "a pinned descriptor that is still the file the hook was deployed with: check c says Passed, the rules are shown, and the page says \"" + h.pinNote + "\" and what that is worth: \"" + h.pinMeans + "\"");
      await ev("window.scrollTo(0, 0); true"); await sleep(300); await shot("-hook-pinned-1440");
      // the same hook when the file at its address is changed: one rule rewritten, still a valid descriptor of this program
      const changed = { ...pf.descriptor, rules: ["The fee is whatever its author says today.", ...pf.descriptor.rules.slice(1)] };
      takeover.set(new URL(pf.address).pathname, { status: 200, body: JSON.stringify(changed, null, 2) + "\n" });
      await open(visitor, "/workshop-hook.html?id=" + pf.id58, readyFor(pf));
      const r = await readHook();
      takeover.delete(new URL(pf.address).pathname);
      say("when its file is changed", r.checks.descriptor.word + ". " + r.checks.descriptor.means);
      check(checkDescriptor(changed, pf.id58).ok && r.checks.descriptor.result === "failed" && r.checks.descriptor.means.includes(PIN_REFUSAL) && r.rules.length === 0 && !r.rulesCard.includes(changed.rules[0]) && r.pinNote === "" && r.name === pf.manifest.name, "when the file at that address is changed, by one rule, and is still a valid descriptor of this program, the site refuses it: check c says Failed, \"" + PIN_REFUSAL + "\", and none of the new text is shown");
    }
    // a hook that was deployed with a pin, and whose author changed the file afterwards
    const xf = FIX.off;
    if (!xf) skip("B: the page of the hook whose pinned descriptor was changed afterwards. It is not on this chain.");
    else {
      await open(visitor, "/workshop-hook.html?id=" + xf.id58, readyFor(xf));
      const h = await readHook();
      say("its descriptor check", h.checks.descriptor.word + ". " + h.checks.descriptor.means);
      check(xf.why === "pin" && !!xf.pin && xf.pin !== xf.hash && checkDescriptor(xf.descriptor, xf.id58).ok, "chain and disk: this hook's manifest pins " + xf.pin + ", the file at its address has the pin " + xf.hash + ", and that file is a valid descriptor of this very program");
      check(h.checks.descriptor.result === "failed" && h.checks.descriptor.means.includes(PIN_REFUSAL) && h.rules.length === 0 && !h.rulesCard.includes(xf.descriptor.rules[0]) && h.name === xf.manifest.name && /^The descriptor was refused\./.test(h.noRules) && /no descriptor in use/.test(h.launchHelp), "a pinned descriptor whose content was changed after the deploy is refused: check c says Failed, none of the changed rules is shown, and the page carries the manifest's own name \"" + xf.manifest.name + "\"");
      await ev("window.scrollTo(0, 0); true"); await sleep(300); await shot("-hook-pin-refused-1440");
    }
    // addresses that are no workshop hook
    await open(visitor, "/workshop-hook.html", "!document.querySelector('#state').hidden && /Custom hooks/.test(document.querySelector('#state').textContent)");
    check(/^This page shows one hook\. Pick one in Custom hooks\./.test(await txt("#state")) && (await ev("document.querySelector('#state a').getAttribute('href')")) === "workshop.html", "without an address the page says what it is for and leads to the workshop");
    await open(visitor, "/workshop-hook.html?id=nothing", "!document.querySelector('#state').hidden && /address/.test(document.querySelector('#state').textContent)");
    check(/^That is not a valid address\./.test(await txt("#state")), "text that is no address: \"" + (await txt("#state")) + "\"");
    await open(visitor, "/workshop-hook.html?id=" + PROGRAMS.hook_tax.toBase58(), "!document.querySelector('#state').hidden && /platform hook/.test(document.querySelector('#state').textContent)");
    check(/^This program is the platform hook "Tax to treasury"\. Custom hooks lists hooks other people built\./.test(await txt("#state")), "a platform hook is not a custom hook: \"" + (await txt("#state")) + "\"");
  });

  // ---- D. the guard -------------------------------------------------------------------------------------
  if (want("D")) await section("D. the guard on a hook's setup: the simulation, the rule, and the floor on chain", async () => {
    // 1. a real hook whose setup takes more than its rent
    const g = FIX.greedy;
    if (!g) skip("D: the launch form on a hook whose setup takes 0.25 SOL on top of its rent. That hook is not on this chain.");
    else {
      await open(victim, "/launch-hook.html?hook=" + g.id58, formReady);
      const s = await readSetup();
      check(s.state === "ok" && s.fields.length === 2, "the greedy hook looks like any other on the form: a valid descriptor and two settings fields");
      const r = await launchOnForm(victim, "WSG" + run, "Workshop Greedy " + run, { fee_bps: "2", max_bps: "5" });
      say("the form said", r.result);
      const rent = BigInt(await conn.getMinimumBalanceForRentExemption(109));
      const wantText = "This hook's setup would take " + sol(rent + 250_000_000n, 6) + " SOL from your wallet. The rent of the accounts it creates is " + sol(rent, 6) + " SOL, and this site allows " + sol(MARGIN, 6) + " SOL above that. Nothing was sent.";
      check(!r.ok && r.result === wantText, "a setup that takes 0.25 SOL on top of its rent is refused, with the numbers: the hook would take " + sol(rent + 250_000_000n, 6) + " SOL, its config's rent is " + sol(rent, 6) + " SOL");
      check(r.prompts === 0 && r.spent === 0n && r.setup.guard === wantText, "the wallet was never asked to sign (" + r.prompts + " prompts) and holds what it held. The reason also stands under the settings");
      check((await conn.getAccountInfo(cfgOf(g.id, r.pool))) === null && (await client.pool(r.pool)) === null, "chain: nothing of that launch exists, no config and no pool");
      await scrollTo("#customSetup"); await sleep(250); await shot("-guard-refused-1440");

      // 2. the floor: the same transaction sent past the form, with the floor an honest setup would leave
      const mint = Keypair.generate(), pool = pda.pool(mint.publicKey, NATIVE_MINT);
      const setup = feeInit(g.id, victim.publicKey, pool, 200, 500);
      const plan = await client.launchInstructions({ dev: victim.publicKey, mint, name: "Floor " + run, symbol: "FLR" + run, uri: origin + "/workshop/site.json?coin=floor", decimals: 6, totalSupply: SUPPLY, quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: SEED, devBuyQuote: 0n, minDevBuyOut: 0n, template: "custom", custom: { program: g.id, setup: [setup] } });
      const base = plan.createTx.filter((i) => i !== setup);
      const sim = await conn.simulateTransaction((await client.buildTx(victim.publicKey, base)).tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [victim.publicKey.toBase58()] } });
      const honest = BigInt(sim.value.accounts[0].lamports) - rent;
      const floor = SystemProgram.transfer({ fromPubkey: victim.publicKey, toPubkey: victim.publicKey, lamports: honest });
      const before = BigInt(await conn.getBalance(victim.publicKey));
      const sent = await sendNode([...plan.createTx, floor], [victim, mint], { skipPreflight: true, mayFail: true });
      const t = await txOf(sent.sig);
      const lost = before - BigInt(await conn.getBalance(victim.publicKey));
      const at = sent.err && sent.err.InstructionError ? sent.err.InstructionError[0] : -1;
      check(!!sent.err && at === t.transaction.message.compiledInstructions.length - 1 && (t.meta.logMessages || []).some((l) => /Transfer: insufficient lamports/.test(l)), "the floor holds on chain: the same greedy setup sent past the form, with the floor an honest setup would leave, fails at the floor instruction: " + JSON.stringify(sent.err));
      check(lost === BigInt(t.meta.fee) && (await conn.getAccountInfo(mint.publicKey)) === null && (await conn.getAccountInfo(cfgOf(g.id, pool))) === null, "the whole transaction was undone: the wallet lost the network fee of " + sol(lost) + " SOL and nothing else, and neither the coin nor the config exists");
    }

    // 3. the guard run on instructions that stand in for a hostile setup, with the real simulation
    await open(victim, "/workshop.html", listReady);
    const doubles = await ev(`(async () => {
      const L = await import("/workshop-lib.js"); const C = await import("/common.js"); const H = C.H;
      const dev = C.Wallet.current().publicKey;
      const fresh = () => H.Keypair.generate().publicKey;
      const pay = (to, lamports) => H.SystemProgram.transfer({ fromPubkey: dev, toPubkey: to, lamports });
      const base = [pay(fresh(), 1000000)];   // stands for the coin's own creation
      const ata = H.pda.ata(dev, H.NATIVE_MINT);
      const out = {};
      const run = async (name, setup, own) => { const v = await L.guardSetup(dev, [...base, ...setup], setup, own); out[name] = { ok: v.ok, code: v.code, reason: v.reason, cost: String(v.cost), rent: String(v.rent), floor: v.floorIx ? String(v.floor) : "" }; };
      const mine = fresh();
      await run("honest", [pay(mine, 890880)], [{ address: mine, writable: true }]);
      const mine2 = fresh();
      await run("tooMuch", [pay(mine2, 890880 + 300000000)], [{ address: mine2, writable: true }]);
      const mine3 = fresh();
      await run("atTheMargin", [pay(mine3, 890880 + 1000000)], [{ address: mine3, writable: true }]);
      await run("toAStranger", [pay(fresh(), 2000000)], []);
      await run("takesTheWallet", [H.SystemProgram.assign({ accountPubkey: dev, programId: H.TOKEN_PROGRAM })], []);
      await run("tokenAccount", [H.ix.createAtaIdempotent(dev, dev, H.NATIVE_MINT), pay(ata, 5000000), H.ix.syncNative(ata)], []);
      await run("fails", [pay(fresh(), 1)], []);
      return out;
    })()`);
    say("stand-ins, simulated", Object.entries(doubles).map(([k, v]) => k + ": " + (v.ok ? "allowed" : v.code)).join(", "));
    check(doubles.honest.ok && doubles.honest.cost === "890880" && doubles.honest.rent === "890880" && doubles.honest.floor !== "", "a setup that pays exactly the rent of the account it creates is allowed, and gets its floor");
    check(doubles.atTheMargin.ok && !doubles.tooMuch.ok && doubles.tooMuch.code === "sol" && doubles.tooMuch.cost === "300890880", "the rent plus " + sol(MARGIN, 6) + " SOL is the limit: exactly that much is allowed, 0.3 SOL above the rent is refused (\"" + doubles.tooMuch.reason + "\")");
    check(!doubles.toAStranger.ok && doubles.toAStranger.code === "foreign", "a setup that pays an account that is not its own is refused: \"" + doubles.toAStranger.reason.replace(/\([^)]*\)/, "(the address)") + "\"");
    check(!doubles.takesTheWallet.ok && doubles.takesTheWallet.code === "wallet", "a setup that assigns the wallet's account to another program takes no SOL in that transaction, and is refused: \"" + doubles.takesTheWallet.reason + "\"");
    check(!doubles.tokenAccount.ok && doubles.tokenAccount.code === "token", "a setup that changes a token account of the wallet is refused: \"" + doubles.tokenAccount.reason.replace(/\([^)]*\)/, "(the address)") + "\"");
    check(!doubles.fails.ok && doubles.fails.code === "simulation" && /^The first transaction failed in a simulation\. Nothing was sent\./.test(doubles.fails.reason), "a setup that fails in the simulation is refused: \"" + doubles.fails.reason + "\"");

    // 4. the rule alone, on numbers
    const rule = await ev(`(async () => {
      const L = await import("/workshop-lib.js");
      const SYS = "11111111111111111111111111111111";
      const j = (wallet, rent, others = []) => { const v = L.judgeSetup({ wallet: { owner: SYS, dataLength: 0, withoutSetup: 1000000000n, ...wallet }, rent, others }); return v.ok ? "ok" : v.code; };
      return {
        margin: String(L.SETUP_MARGIN), cap: String(L.SETUP_CAP),
        exactRent: j({ withSetup: 1000000000n - 1500000n }, 1500000n),
        rentPlusMargin: j({ withSetup: 1000000000n - 1500000n - L.SETUP_MARGIN }, 1500000n),
        oneLamportMore: j({ withSetup: 1000000000n - 1500000n - L.SETUP_MARGIN - 1n }, 1500000n),
        bigRentUnderCap: j({ withSetup: 1000000000n - 40000000n }, 40000000n),
        bigRentOverCap: j({ withSetup: 1000000000n - 60000000n }, 60000000n),
        paysTheWallet: j({ withSetup: 1000000000n + 5n }, 0n),
        otherOwner: j({ owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", withSetup: 1000000000n }, 0n),
        walletWithData: j({ dataLength: 8, withSetup: 1000000000n }, 0n),
        tokenChanged: j({ withSetup: 1000000000n }, 0n, [{ address: "a", changed: true, tokenOfWallet: true }]),
        tokenUntouched: j({ withSetup: 1000000000n }, 0n, [{ address: "a", changed: false, tokenOfWallet: true }]),
        strangerChanged: j({ withSetup: 1000000000n }, 0n, [{ address: "b", changed: true, tokenOfWallet: false }]),
      };
    })()`);
    say("the rule on numbers", rule);
    check(rule.margin === String(MARGIN) && rule.cap === String(CAP), "the limits the code holds are the ones the pages state: " + sol(MARGIN, 6) + " SOL above the rent, " + sol(CAP, 6) + " SOL in all");
    check(rule.exactRent === "ok" && rule.rentPlusMargin === "ok" && rule.oneLamportMore === "sol" && rule.paysTheWallet === "ok", "the rule on SOL: the rent is allowed, the rent plus the margin is allowed, one lamport more is refused");
    check(rule.bigRentUnderCap === "ok" && rule.bigRentOverCap === "cap", "the rule on the cap: 0.04 SOL of rent is allowed, 0.06 SOL is refused although it is all rent");
    check(rule.otherOwner === "wallet" && rule.walletWithData === "wallet" && rule.tokenChanged === "token" && rule.tokenUntouched === "ok" && rule.strangerChanged === "foreign", "the rule on accounts: a wallet handed to another program, a changed token account of the wallet and a changed account of a stranger are each refused, and an untouched token account is not");

    // 5. what a descriptor may ask for
    const kit = Object.fromEntries(Object.entries(KIT).map(([k, f]) => [k, readJson(here(f))]));
    const LENS = [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 16384];
    /// A pin that is one, for the links below: the pin of the three bytes "abc".
    const samplePin = pin22(Buffer.from("abc"));
    const verdicts = await pg(async (kit, lens, fixture, p22) => {
      const L = await import("/workshop-lib.js");
      const copy = (o) => JSON.parse(JSON.stringify(o));
      const base = kit.fee;
      const bad = (change, expect) => { const j = copy(base); change(j); const c = L.checkDescriptor(j, base.program); return { ok: c.ok, hit: c.errors.some((e) => e.includes(expect)), errors: c.errors }; };
      const out = {};
      for (const k of Object.keys(kit)) out["kit_" + k] = L.checkDescriptor(kit[k], kit[k].program).ok;
      out.otherProgram = !L.checkDescriptor(base, kit.early.program).ok;
      out.version = bad((j) => { j.programmable_hook = 2; }, "This site reads version 1 only");
      out.noRules = bad((j) => { j.rules = []; }, "at least one sentence");
      out.manyRules = bad((j) => { j.rules = Array(13).fill("A rule."); }, "more than 12");
      out.httpSource = bad((j) => { j.source = "http://example.com/x"; }, "must be an https link");
      out.script = bad((j) => { j.source = "javascript:alert(1)"; }, "must be an https link");
      out.control = bad((j) => { j.name = "Fixed" + String.fromCharCode(0x202e) + "fee"; }, "control characters");
      out.anyAddress = bad((j) => { j.setup.accounts.push({ role: "address", address: "So11111111111111111111111111111111111111112" }); }, "has the role");
      out.anotherSigner = bad((j) => { j.setup.accounts[2].signer = true; }, "a field this site does not know");
      out.launcherExtras = bad((j) => { j.setup.accounts[0].writable = false; }, "a field this site does not know");
      out.tokenAccount = bad((j) => { j.setup.accounts.push({ role: "launcher_token_account" }); }, "has the role");
      out.badSeed = bad((j) => { j.setup.accounts[2].seeds = ["cfg", { key: "wallet" }]; }, "a seed is text, or");
      out.longSeed = bad((j) => { j.setup.accounts[2].seeds = ["x".repeat(33)]; }, "1 to 32 bytes");
      out.badType = bad((j) => { j.setup.args[1].type = "string"; }, "has the type");
      out.noLabel = bad((j) => { delete j.setup.args[1].label; }, "needs a \"label\"");
      out.minAboveMax = bad((j) => { j.setup.args[1].min = 11; }, "\"min\" is above \"max\"");
      out.defaultOutside = bad((j) => { j.setup.args[1].default = 11; }, "\"default\" is outside");
      out.tooBig = bad((j) => { j.setup.args[1].max = 700; }, "does not fit in a u16");
      out.badInstruction = bad((j) => { j.setup.instruction = "Init Pool"; }, "snake_case");
      out.setupExtras = bad((j) => { j.setup.signers = ["x"]; }, "a field this site does not know");
      const j = copy(base); j.website = "https://example.com"; out.unknownTopLevel = L.checkDescriptor(j, base.program).ok;
      const plain = copy(base); delete plain.setup; delete plain.source; delete plain.author; out.onlyWords = L.checkDescriptor(plain, base.program).ok;
      const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      out.sha = hexOf(L.sha256(new TextEncoder().encode("abc")));
      out.hashes = lens.map((n) => hexOf(L.sha256(new Uint8Array(n).fill(7))));
      out.pinsOf = lens.map((n) => L.pinOf(new Uint8Array(n).fill(7)));
      out.filePin = fixture ? L.pinOf(new Uint8Array(await (await fetch(fixture, { cache: "no-store" })).arrayBuffer())) : "";
      const u = (x) => L.descriptorUrl(x);
      const at = "https://example.com/h.json";
      out.pins = {
        plain: u(at), pinned: u(at + "#s=" + p22), capital: u(at + "#S=" + p22), short: u(at + "#s=abc"), long: u(at + "#s=" + p22 + "A"),
        // 22 characters that no 16 bytes spell: the last one carries two bits only
        badEnd: u(at + "#s=" + p22.slice(0, 21) + "B"), plus: u(at + "#s=" + "+".repeat(22)),
        old: u(at + "#sha256=" + "ab".repeat(32)), other: u(at + "#top"), docs: u("https://example.com/docs#s=" + p22),
      };
      out.isPin = [p22, p22.slice(0, 21) + "B", p22.slice(0, 21), "", p22 + "="].map((x) => L.isPin(x));
      out.limits = [L.MAX_URI_BYTES, L.PIN_BYTES, L.MAX_PINNED_ADDRESS_BYTES, L.PIN_CHARS];
      out.urls = ["https://example.com/hook.json", "https://example.com/hook", "http://example.com/hook.json", "http://localhost:8787/x.json", "ipfs://x/hook.json", "javascript:alert(1)//.json", ""].map((u) => !!L.descriptorUrl(u).url);
      return out;
    }, kit, LENS, FIX.fee ? FIX.fee.address : "", samplePin);
    const refused = Object.entries(verdicts).filter(([, v]) => v && typeof v === "object" && "hit" in v);
    for (const [k, v] of refused) if (v.ok || !v.hit) say("not refused as expected: " + k, v.errors);
    check(verdicts.kit_fee && verdicts.kit_early && verdicts.kit_points && verdicts.unknownTopLevel && verdicts.onlyWords, "the site reads the three descriptors of the kit (hook-template, early-bird, loyalty-points), one with a field it does not know at the top, and one that only holds words");
    check(verdicts.otherProgram, "a descriptor loaded for another program than the one it names is refused");
    check(refused.every(([, v]) => !v.ok && v.hit), "a descriptor cannot ask for more than the safe list: " + refused.length + " changed copies are each refused for the right reason (another signer, an arbitrary address, a token account of the launcher, an unknown role or seed, a script link, a hidden character, numbers outside their type)");
    check(verdicts.sha === createHash("sha256").update("abc").digest("hex"), "the page's own SHA-256, which makes the instruction's first 8 bytes, agrees with Node's");
    check(same(verdicts.hashes, LENS.map((n) => sha(Buffer.alloc(n, 7)))), "the page's SHA-256 agrees with Node's on whole messages of " + LENS.join(", ") + " bytes, the lengths around the edges of its 64-byte blocks included");
    check(same(verdicts.pinsOf, LENS.map((n) => pin22(Buffer.alloc(n, 7)))) && verdicts.pinsOf.every((p) => /^[A-Za-z0-9_-]{21}[AQgw]$/.test(p)) && (!FIX.fee || verdicts.filePin === FIX.fee.hash), "the pin of a file is the same 22 characters wherever it is taken: the page's pin agrees with Node's own SHA-256 and base64url on those messages" + (FIX.fee ? " and on a fixture file as the site serves it (" + verdicts.filePin + ")" : ""));
    const pz = verdicts.pins, at = "https://example.com/h.json";
    const notOne = (x) => x.pin === "" && /^The link carries a pin that is not one\. After "#s=" a pin has 22 characters\.$/.test(x.pinError);
    check(pz.plain.url === at && pz.plain.pin === "" && pz.plain.pinError === "" && pz.pinned.url === at && pz.pinned.pin === samplePin && pz.pinned.pinError === "" && pz.docs.url === "", "a link's pin: \"#s=\" with the 22 characters is read as the pin, and the address is the link without it. A link that is no .json address is never loaded, pin or not");
    check(notOne(pz.short) && notOne(pz.long) && notOne(pz.badEnd) && notOne(pz.plus) && notOne(pz.capital) && same(verdicts.isPin, [true, false, false, false, false]), "one way to write a pin and no other: 3 or 23 characters, 22 characters that no 16 bytes spell, characters outside base64url, padding, and \"#S=\" with a capital letter each make the link unusable (\"" + pz.short.pinError + "\")");
    check(pz.old.url === at && pz.old.pin === "" && pz.old.pinError === "" && pz.other.url === at && pz.other.pin === "" && pz.other.pinError === "", "the earlier form \"#sha256=\" with 64 hex characters is not a pin any more: like any other fragment it is left out, and the link is read as an address without a pin, so the pages say that the author can still change the text");
    check(same(verdicts.limits, [MAX_URI_BYTES, PIN_BYTES, MAX_PINNED_ADDRESS_BYTES, 22]) && MAX_URI_BYTES === 128 && PIN_BYTES === 25 && MAX_PINNED_ADDRESS_BYTES === 103, "the limits the pages and the server share: a manifest's link holds " + MAX_URI_BYTES + " bytes, the pin takes " + PIN_BYTES + " (\"#s=\" and 22 characters), so the longest address that can be pinned has " + MAX_PINNED_ADDRESS_BYTES);
    check(same(verdicts.urls, [true, false, false, true, false, false, false]), "which manifest links are loaded as a descriptor: an https address that ends in .json, and on a local chain this machine's own http address. A plain link, an http address elsewhere and anything that is not a web address are not");
  });

  // ---- E. the guide --------------------------------------------------------------------------------------
  if (want("E")) await section("E. \"Build a hook\": the guide in four steps, the review before the deploy", async () => {
    const guideReady = "!!document.querySelector('#gJson') && document.querySelector('#gJson').textContent.length > 20 && document.querySelectorAll('#flagCalls input').length === 9";
    await open(visitor, "/workshop-guide.html", guideReady);
    const openStep = async (n) => { if ((await ev("document.querySelector('#step" + n + "Head').getAttribute('aria-expanded')")) !== "true") { await click("#step" + n + "Head"); await sleep(300); } };
    const stepState = () => pg(() => [1, 2, 3, 4].map((n) => document.getElementById("step" + n + "Head").getAttribute("aria-expanded") + "/" + (document.getElementById("step" + n + "Body").hidden ? "hidden" : "shown")));
    const steps = await pg(() => [...document.querySelectorAll(".ws-step-head")].map((b) => b.querySelector(".ws-step-n").textContent.trim() + " " + b.querySelector(".ws-step-title").textContent.trim()));
    check(same(steps, ["01 Choose its powers", "02 Build and test it", "03 Describe it", "04 Review, deploy, freeze"]) && same(await stepState(), ["true/shown", "false/hidden", "false/hidden", "false/hidden"]), "four numbered steps, in the order of the real flow, the first one open: " + steps.join(" | "));
    await click("#step2Head"); await sleep(300);
    const s2 = await stepState();
    await click("#step2Head"); await sleep(300);
    const s0 = await stepState();
    check(same(s2, ["false/hidden", "true/shown", "false/hidden", "false/hidden"]) && same(s0, ["false/hidden", "false/hidden", "false/hidden", "false/hidden"]), "a step opens its detail and closes the one that was open, and a click on the open step closes it again");
    await openStep(1);
    // step 1
    const lib = readFileSync(here("../../hook-template/programs/my_hook/src/lib.rs"), "utf8");
    const flagsLine = /pub const FLAGS: u32 = [^;]+;/.exec(lib)[0];
    const tplFlags = FLAGS.BEFORE_SWAP | FLAGS.ON_POOL_CREATE | FLAGS.TAKE_HOOK_FEE | FLAGS.CALL_ON_BUY | FLAGS.CALL_ON_SELL;
    const readFlags = () => pg(() => ({ rust: document.querySelector("#flagRust").textContent, words: [...document.querySelectorAll("#flagWords li")].map((l) => l.textContent.trim()), warn: document.querySelector("#flagWarn").hidden ? "" : document.querySelector("#flagWarn").textContent.trim() }));
    let fl = await readFlags();
    check(fl.rust === flagsLine + "\n// the number a pool stores: " + tplFlags && same(fl.words, words(tplFlags)), "step 1 starts on the kit's template: the line is the one in hook-template's lib.rs (\"" + flagsLine + "\"), the number is " + tplFlags + ", and the sentences are the ones the site shows for those flags");
    await click("#flagCalls input[data-flag=CALL_ON_SELL]"); await sleep(250);
    fl = await readFlags();
    check(fl.rust.endsWith(String(tplFlags & ~FLAGS.CALL_ON_SELL)) && same(fl.words, words(tplFlags & ~FLAGS.CALL_ON_SELL)) && fl.words[0].startsWith("Runs on buys only."), "unticking \"On sells\" changes the line, the number and the sentences: \"" + fl.words[0] + "\"");
    await click("#flagCalls input[data-flag=CALL_ON_SELL]");
    await click("#flagPowers input[data-flag=OVERRIDE_CURVE]"); await sleep(250);
    fl = await readFlags();
    check(/The launchpad does not take a hook that sets the price itself\./.test(fl.warn), "ticking \"Set the price itself\" warns that the launchpad does not take such a hook");
    await click("#flagPowers input[data-flag=OVERRIDE_CURVE]"); await sleep(200);
    // step 2
    await openStep(2);
    const readme = readFileSync(here("../../hook-template/README.md"), "utf8");
    const cmds = await pg(() => ["cmdCopy", "cmdBuild", "cmdChain"].flatMap((id) => document.getElementById(id).textContent.split("\n").map((s) => s.trim()).filter(Boolean)));
    check(cmds.length === 8 && cmds.every((c) => readme.includes(c)), "step 2 gives the kit's own commands: each of the " + cmds.length + " lines stands in hook-template/README.md");
    // step 3
    const readForm = () => pg(() => ({ json: JSON.parse(document.querySelector("#gJson").textContent), verdict: document.querySelector("#gVerdict").textContent.trim(), errors: [...document.querySelectorAll("#gErrors li")].map((l) => l.textContent.trim()), disabled: ["gDownload", "gCopy", "gUpload"].map((id) => document.getElementById(id).disabled), preview: [...document.querySelectorAll("#gPreview label.field span > span:first-child")].map((s) => s.textContent.trim()), previewHidden: document.querySelector("#gPreview").hidden }));
    const tpl = readJson(here(KIT.fee));
    let form = await readForm();
    check(alike(form.json, { ...tpl, program: "" }), "step 3 starts as the descriptor of the kit's template, hook-template/hook.json, without a program id");
    const kitFiles = Object.values(KIT).map((k) => readFileSync(here(k), "utf8"));
    const plain = (s) => s.replace(/"?programmable_hook"?/g, "");
    check(!/programmable/i.test(plain(JSON.stringify(form.json))) && kitFiles.every((s) => !/programmable/i.test(plain(s))) && form.json.author === "The hook kit", "the sample and the kit's three descriptors name no project: the author is \"" + form.json.author + "\", the source " + form.json.source);
    // before the reader touches the form, the sample is a sample: a plain sentence, no verdict, no list of things to fix
    const SAMPLE = "This is the kit's sample. Type your program id and change the words, and the site judges the result as you go.";
    check(form.verdict === SAMPLE && form.errors.length === 0 && same(form.disabled, [true, true, true]), "as it opens, the form shows the sample without a verdict (\"" + form.verdict + "\") and keeps Download, Copy and Upload disabled");
    // the first edit, here the name typed again as it is, makes the form judge from then on
    await type("#gName", tpl.name);
    form = await readForm();
    check(same(form.errors, ["\"program\" must be the hook's program id."]) && form.verdict === "One thing to fix before the site reads this descriptor." && same(form.disabled, [true, true, true]) && alike(form.json, { ...tpl, program: "" }), "from the first edit on the form judges: without a program id it says the one thing to fix and keeps the three buttons disabled");
    const someId = (FIX.fee || { id58: tpl.program }).id58;
    await type("#gProgram", someId);
    form = await readForm();
    check(form.verdict === "This descriptor is valid. The site will read it for the program it names." && form.errors.length === 0 && same(form.disabled, [false, false, false]) && alike(form.json, { ...tpl, program: someId }), "with the program id the descriptor is valid, and it is hook-template/hook.json for that program" + (FIX.fee ? ", the very file the fixture hook's manifest links to: " + alike(form.json, FIX.fee.descriptor) : ""));
    check(!form.previewHidden && same(form.preview, tpl.setup.args.filter((a) => a.label).map((a) => a.label)), "the form shows what a launcher will see: the fields " + form.preview.join(", "));
    // the same validator as the site: a seed the site would refuse
    await type("#gAccounts .rowbox:nth-child(3) [data-k=seeds]", "cfg, {wallet}");
    form = await readForm();
    check(form.errors.length === 1 && /^Account 3: a seed is text, or/.test(form.errors[0]) && form.disabled[0], "the form validates as the site does: a seed the site does not know is refused with the site's own sentence, \"" + (form.errors[0] || "") + "\"");
    await type("#gAccounts .rowbox:nth-child(3) [data-k=seeds]", "cfg, {pool}");
    await click("#gAddArg"); await sleep(250);
    form = await readForm();
    check(form.json.setup.args.length === tpl.setup.args.length + 1 && form.errors.some((e) => /^Argument 4 needs a "name"/.test(e)), "\"Add an argument\" adds a row, and an empty row is named in the list of things to fix");
    await click("#gArgs .rowbox:last-child .tools button:last-child"); await sleep(250);
    form = await readForm();
    check(form.errors.length === 0 && alike(form.json, { ...tpl, program: someId }), "\"Remove\" takes it out again");
    // the two examples, opened as files
    const doc = await call("DOM.getDocument", { depth: 0 });
    for (const k of ["early", "points"]) {
      const node = await call("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#gFile" });
      await call("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [here(KIT[k])] });
      await sleep(700);
      form = await readForm();
      const file = readJson(here(KIT[k]));
      check(alike(form.json, file) && form.errors.length === 0 && same(form.preview, file.setup.args.filter((a) => a.label).map((a) => a.label)), "\"Open a hook.json\" with the kit's " + file.name + ": the form holds it whole, it is valid, and what comes out is the file again");
    }
    await scrollTo("#step3"); await sleep(250); await shot("-guide-step3-1440");
    // Download and Copy: what leaves the page is the descriptor shown, to the byte
    const points = readJson(here(KIT.points));
    const shown = await ev("document.querySelector('#gJson').textContent");
    const dl = path.join(os.tmpdir(), "programmable-workshop-download-" + process.pid);
    rmSync(dl, { recursive: true, force: true }); mkdirSync(dl, { recursive: true });
    await call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dl });
    await click("#gDownload");
    let saved = null;
    for (let i = 0; i < 60 && !saved; i++) { await sleep(250); try { if (existsSync(path.join(dl, "hook.json"))) saved = readFileSync(path.join(dl, "hook.json")); } catch (_) {} }
    check(!!saved && saved.toString("utf8") === shown + "\n" && checkDescriptor(JSON.parse(saved.toString("utf8")), points.program).ok, "\"Download hook.json\" saves a file of that name which is the descriptor shown, to the byte, and a valid descriptor: " + (saved ? saved.length + " bytes, SHA-256 " + sha(saved).slice(0, 12) + "..." : "no file arrived in " + dl));
    rmSync(dl, { recursive: true, force: true });
    await call("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch((e) => console.log("        note: the clipboard permission could not be granted: " + e.message));
    await clearToasts();
    await click("#gCopy");
    await until("document.querySelectorAll('#toasts .toast').length > 0", 8000);
    const copied = await txt("#toasts .toast");
    // Windows hands text back from its clipboard with its own line ends
    const clip = String(await ev("navigator.clipboard.readText().catch((e) => 'the clipboard could not be read: ' + e.message)")).replace(/\r\n/g, "\n");
    check(copied === "Copied" && clip === shown + "\n", "\"Copy\" puts the same text on the clipboard: the page says \"" + copied + "\"" + (clip === shown + "\n" ? ", and the clipboard holds the descriptor, line for line" : ", and the clipboard holds: " + clip.slice(0, 90)));
    // hosting: the operator's file says whether this site's upload stores descriptors
    const siteFile = readJson(here("../workshop/site.json"));
    const hostSay = await txt("#gHost"), uploadShown = await ev("!document.querySelector('#gUpload').hidden");
    check(uploadShown === (siteFile.descriptorUpload === true) && hostSay === (uploadShown ? "Host the file at an address that will not change. This site can host it for you, and step 4 pins it." : "Host the file yourself, at an address that will not change. An address of at most " + MAX_PINNED_ADDRESS_BYTES + " bytes can be pinned in step 4."), "web/workshop/site.json says descriptorUpload " + siteFile.descriptorUpload + ", so \"Upload to this site\" is " + (uploadShown ? "offered" : "not offered") + ": \"" + hostSay + "\"");
    // step 4: the address, the pin and the deploy command
    const readDeploy = () => pg(() => ({ cmd: document.querySelector("#gDeploy").hidden ? "" : document.querySelector("#gDeploy").textContent, note: document.querySelector("#gDeployNote").hidden ? "" : document.querySelector("#gDeployNote").textContent.trim(), pin: document.querySelector("#gPinNote").hidden ? "" : document.querySelector("#gPinNote").textContent.trim(), reviewTop: document.querySelector("#gReviewTop").getAttribute("href"), page: document.querySelector("#gPage").getAttribute("href"), count: document.querySelector("#gUrlCount").textContent }));
    const line = (name, uri, more = "") => "WALLET=~/my-wallet.json HOOK_NAME=\"" + name + "\" " + more + "HOOK_URI='" + uri + "' bash scripts/deploy-freeze.sh localnet";
    await type("#gUrl", "https://example.com/hooks/points.json");
    let dep = await readDeploy();
    check(dep.cmd === line(points.name, "https://example.com/hooks/points.json") && dep.count === "37/" + MAX_PINNED_ADDRESS_BYTES + " bytes" && /^The deploy script reads this address and adds the pin of the file it finds\./.test(dep.pin), "step 4 writes the deploy command for the address typed, counts the address against the " + MAX_PINNED_ADDRESS_BYTES + " bytes that leave room for the pin (" + dep.count + "), and says that the script adds the pin");
    check(dep.reviewTop === "review-hook.html" && dep.page === "workshop-hook.html?id=" + points.program, "step 4 leads to the review first, above the deploy command, and at its end to the hook's own page");
    // Addresses people really have. A raw file in a code repository, and a file in the blob
    // store the site's own upload uses when it is deployed (the shape of such an address: a
    // store name of 16 characters, then the path the upload writes).
    const raw = "https://raw.githubusercontent.com/acme/fee-hook/main/hook.json";
    const blob = "https://abcdefghijklmnop.public.blob.vercel-storage.com/h/0123456789abcdef0123.json";
    let roomy = true;
    for (const a of [raw, blob]) {
      await type("#gUrl", a);
      dep = await readDeploy();
      const n = Buffer.byteLength(a);
      roomy = roomy && n <= MAX_PINNED_ADDRESS_BYTES && n + PIN_BYTES <= MAX_URI_BYTES && dep.count === n + "/" + MAX_PINNED_ADDRESS_BYTES + " bytes" && dep.cmd === line(points.name, a) && /^The deploy script reads this address and adds the pin of the file it finds\./.test(dep.pin);
    }
    check(roomy && Buffer.byteLength(raw) === 62 && Buffer.byteLength(blob) === 83, "addresses people really have fit together with the pin: a raw file in a code repository (62 bytes, 87 with its pin) and an address of the shape a blob store gives (83 bytes, 108 with its pin). The guide writes the plain deploy command for each and says that the script adds the pin");
    const long = "https://raw.githubusercontent.com/a-longer-organisation-name/a-hook-with-a-long-repository-name/main/hook.json";
    await type("#gUrl", long);
    dep = await readDeploy();
    const over = Buffer.byteLength(long) - MAX_PINNED_ADDRESS_BYTES;
    check(over > 0 && Buffer.byteLength(long) <= MAX_URI_BYTES && dep.count === Buffer.byteLength(long) + "/" + MAX_URI_BYTES + " bytes, too long to pin" && dep.cmd === line(points.name, long, "DESCRIPTOR_PIN=no ") && dep.pin.startsWith("This address is " + over + " bytes too long to carry the pin.") && /sites will say that you can still change the text/.test(dep.pin) && dep.pin.endsWith("An address of at most " + MAX_PINNED_ADDRESS_BYTES + " bytes can be pinned."), "an address too long to pin, here " + Buffer.byteLength(long) + " bytes: the command links it with DESCRIPTOR_PIN=no, and the guide says by how many bytes it is too long (" + over + ") and what sites will say");
    await type("#gUrl", "https://example.com/hooks/points");
    dep = await readDeploy();
    check(dep.cmd === "" && dep.note === "That address will not work. It must start with https, end in .json and have at most " + MAX_URI_BYTES + " bytes.", "an address the site would not load as a descriptor gets no deploy command: \"" + dep.note + "\"");
    await type("#gUrl", "https://example.com/hooks/points.json#s=abc");
    dep = await readDeploy();
    check(dep.cmd === "" && dep.note === "The link carries a pin that is not one. After \"#s=\" a pin has 22 characters.", "a link typed with something after \"#s=\" that is no pin gets no deploy command: \"" + dep.note + "\"");
    const end = await txt("#step4");
    check(/Freezing cannot be undone, and the rent of a frozen program never comes back\./.test(end) && /Get it reviewed first/.test(end) && /Once the code passes, deploy exactly that commit/.test(end) && /puts it on the approved list/.test(end) && /Programmable reviews the code\./.test(await txt(".page-top")) && !/Nobody has to approve it/.test(await txt("main")), "the guide says that freezing is final, that the review comes before the deploy, and that an approved hook goes on the approved list. It no longer says that nobody approves a hook");
    check(/The pin is 22 characters made from the SHA-256 of the hosted file\./.test(end) && /The pin takes 25 of the 128 bytes, so an address of up to 103 bytes can be pinned\./.test(end) && /a site refuses any other file at that address/.test(end) && /A pin proves that the file is the one you pinned\. It is not a signature, and it says nothing about your code\./.test(end), "the guide says what the pin is, what it costs in bytes, and what it is worth: it proves the file is the one the author pinned, it is not a signature, and it says nothing about the code");
    // "Read the address": the guide reads the hosted file and writes the pinned link itself
    if (FIX.pin && FIX.early) {
      await type("#gProgram", FIX.pin.id58);
      await type("#gUrl", FIX.pin.address);
      await click("#gRead");
      await until("document.querySelector('#gRead').textContent === 'Read the address' && /pins your text|could not read|is not/.test(document.querySelector('#gPinNote').textContent)", 15000);
      dep = await readDeploy();
      check(dep.cmd === line(points.name, FIX.pin.address + "#s=" + FIX.pin.hash) && dep.cmd.includes("HOOK_URI='" + FIX.pin.manifest.uri + "'") && /^This command pins your text\./.test(dep.pin), "\"Read the address\" reads the hosted file, finds a descriptor of this program, takes its pin and writes the pinned link into the command. It is the very link the fixture hook's manifest holds");
      await scrollTo("#step4"); await sleep(250); await shot("-guide-step4-1440");
      await type("#gUrl", FIX.early.address);
      await click("#gRead");
      await until("document.querySelector('#gRead').textContent === 'Read the address' && /is not a valid descriptor/.test(document.querySelector('#gPinNote').textContent)", 15000);
      dep = await readDeploy();
      check(/^The file there is not a valid descriptor of this program\. It names another program/.test(dep.pin) && !dep.cmd.includes("#"), "an address that holds another hook's descriptor is read and named for what it is, and gets no pin: \"" + dep.pin.slice(0, 110) + "\"");
    }
    await type("#gUrl", "https://example.com/hooks/points.json");
    await pair("guide", "the guide", "#step3");
    await openStep(3); await view(375, 900); await scrollTo("#gArgs"); await sleep(300); await shot("-guide-375-rows"); check(await fits(), "the guide's rows of arguments: no horizontal scroll at 375 (" + (await overflow()) + ")");
    await openStep(4); await scrollTo("#step4"); await sleep(300); await shot("-guide-375-step4"); check(await fits(), "the guide's step 4: no horizontal scroll at 375 (" + (await overflow()) + ")"); await view(W, HGT);

    await open(visitor, "/workshop-guide.html#step3", guideReady);
    check(same(await stepState(), ["false/hidden", "false/hidden", "true/shown", "false/hidden"]), "a link to a step (workshop-guide.html#step3) opens that step");
    // The guide's side of an upload, with the answers of the endpoint taken over: one that
    // stores the file, one that stored something else, one that refuses. The real upload is part U.
    if (FIX.fee && FIX.early) {
      const hosted = FIX.fee.address;
      takeover.set("workshop/site.json", { status: 200, body: JSON.stringify({ descriptorUpload: true }) });
      takeover.set("/api/metadata", { status: 200, body: JSON.stringify({ url: hosted }) });
      await open(visitor, "/workshop-guide.html", guideReady);
      await type("#gProgram", FIX.fee.id58);
      const offered = await ev("!document.querySelector('#gUpload').hidden && !document.querySelector('#gUpload').disabled");
      await click("#gUpload");
      await until("!document.querySelector('#gUploadNote').hidden && document.querySelector('#gUpload').textContent === 'Upload to this site'", 15000);
      await sleep(300);
      dep = await readDeploy();
      check(offered && (await txt("#gUploadNote")) === "Hosted at " + hosted + ". Step 4 has the deploy command." && dep.cmd === line(tpl.name, hosted + "#s=" + FIX.fee.hash), "an endpoint that stores the file: the guide reads the stored file back, finds a descriptor of its program, and writes the address with the pin of that file into the deploy command");
      takeover.set("/api/metadata", { status: 200, body: JSON.stringify({ url: FIX.early.address }) });
      await type("#gUrl", "");
      await click("#gUpload");
      await until("/did not store/.test(document.querySelector('#gUploadNote').textContent)", 15000);
      check((await txt("#gUploadNote")) === "This site did not store the descriptor. Host hook.json yourself and type its address in step 4." && (await ev("document.querySelector('#gUrl').value")) === "", "an endpoint that stored something else than the descriptor sent is not believed: the guide read the file back, found another program in it, and filled in no address");
      onPurpose.push(/api\/metadata/);
      takeover.set("/api/metadata", { status: 400, body: JSON.stringify({ error: "Symbol must be 1 to 10 characters." }) });
      await ev("document.querySelector('#gUploadNote').textContent = ''; true");
      await click("#gUpload");
      await until("/did not store/.test(document.querySelector('#gUploadNote').textContent)", 15000);
      check((await txt("#gUploadNote")) === "This site did not store the descriptor. Host hook.json yourself and type its address in step 4.", "an endpoint that refuses: the guide says so and how to go on");
      takeover.delete("workshop/site.json"); takeover.delete("/api/metadata");
    }
  });

  // ---- U. the upload, for real -------------------------------------------------------------------------------
  if (want("U")) await section("U. a descriptor uploaded for real, through a server this part starts on another port", async () => {
    // a free port, and this package's own server on it: the code of web/serve.js as it is on disk
    const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const own = "http://localhost:" + port;
    ownServer = spawn(process.execPath, [here("../serve.js")], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
    const uploads = here("../uploads/");
    const before = existsSync(uploads) ? readdirSync(uploads) : [];
    try {
      let up = false;
      for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(own + "/workshop/site.json")).ok; } catch (_) { await sleep(150); } }
      if (!up) throw new Error("the server did not start on port " + port);
      say("the server of this part", own + ", process " + ownServer.pid + ". The site on " + origin + " keeps the code it was started with");
      const guideReady = "!!document.querySelector('#gJson') && document.querySelector('#gJson').textContent.length > 20 && document.querySelectorAll('#flagCalls input').length === 9";
      await open(visitor, "/workshop-guide.html", guideReady, own);
      // the kit's template, described for a program id nobody has
      const program = Keypair.generate().publicKey.toBase58();
      await type("#gProgram", program);
      const offered = await ev("!document.querySelector('#gUpload').hidden && !document.querySelector('#gUpload').disabled");
      const shown = await ev("document.querySelector('#gJson').textContent");
      await click("#gUpload");
      await until("!document.querySelector('#gUploadNote').hidden && document.querySelector('#gUpload').textContent === 'Upload to this site'", 20000);
      await sleep(300);
      const note = await txt("#gUploadNote"), url = await ev("document.querySelector('#gUrl').value");
      const added = readdirSync(uploads).filter((f) => !before.includes(f));
      const file = added.length === 1 ? readFileSync(uploads + added[0]) : null;
      const hash = file ? sha(file) : "", pin = file ? pin22(file) : "";
      check(offered && added.length === 1 && note === "Hosted at " + url + ". Step 4 has the deploy command." && url === own + "/uploads/" + hash.slice(0, 20) + ".json", "the guide uploads the descriptor through POST /api/metadata of the server on " + own + ", and the server stores one file and answers with its address, named after the file's own content: " + url);
      check(!!file && file.toString("utf8") === shown + "\n" && checkDescriptor(JSON.parse(file.toString("utf8")), program).ok, "the file on disk under web/uploads is the descriptor the form showed, to the byte, and a valid descriptor of that program" + (file ? " (" + file.length + " bytes)" : ""));
      const cmd = await ev("document.querySelector('#gDeploy').hidden ? '' : document.querySelector('#gDeploy').textContent");
      const size = Buffer.byteLength(url);
      check(size <= MAX_PINNED_ADDRESS_BYTES && size + PIN_BYTES <= MAX_URI_BYTES && cmd === "WALLET=~/my-wallet.json HOOK_NAME=\"Fixed fee\" HOOK_URI='" + url + "#s=" + pin + "' bash scripts/deploy-freeze.sh localnet", "the address the upload returns has " + size + " bytes, so it fits a manifest together with its pin (" + (size + PIN_BYTES) + " of " + MAX_URI_BYTES + "), and step 4 writes that pinned link: the pin the guide took from the stored file is the file's own (" + pin + ")");
      // the same again, what is no descriptor, and a coin's details
      const post = async (to, body) => { const r = await fetch(to + "/api/metadata", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, json: j || {} }; };
      const sent = JSON.parse(shown);
      const again = await post(own, sent);
      check(again.status === 200 && again.json.url === url && again.json.pin === pin && !("sha256" in again.json) && readdirSync(uploads).filter((f) => !before.includes(f)).length === 1, "the same descriptor sent again is the same file at the same address, and the answer carries its pin in the one form there is: " + JSON.stringify(again.json));
      const wrong = await post(own, { ...sent, setup: { ...sent.setup, accounts: [{ role: "launcher", signer: true }] } });
      const big = await post(own, { ...sent, notes: "x".repeat(17000) });
      const noId = await post(own, { ...sent, program: "nobody" });
      check(wrong.status === 400 && /^This is not a valid hook descriptor\. Account 1 has a field this site does not know: "signer"\.$/.test(wrong.json.error || "") && noId.status === 400 && big.status === 413 && readdirSync(uploads).filter((f) => !before.includes(f)).length === 1, "the server runs the validator of the pages before it stores anything: a descriptor that asks for another signer is refused with the site's own sentence (\"" + (wrong.json.error || "") + "\"), one without a program id is refused, and one above 16,384 bytes is refused");
      const coin = await post(own, { name: "Upload Probe " + run, symbol: "UPL", description: "A coin's details still upload.", image: "", extensions: {} });
      check(coin.status === 200 && /\/uploads\/[0-9a-f-]{36}\.json$/.test(coin.json.url || ""), "a coin's details still upload as before: " + (coin.json.url || JSON.stringify(coin.json)));
      const main = await post(origin, sent).catch(() => ({ status: 0, json: {} }));
      say("the same upload sent to " + origin, main.status === 200 && main.json.pin === pin ? "stored, and answered with the pin: that server runs the code that is on disk"
        : main.status === 200 ? "stored, but the answer carries no \"pin\" (" + Object.keys(main.json).join(", ") + "): that server still runs the code it was started with, and answers in today's form after a restart. The guide does not depend on it: it reads the stored file back and takes the pin itself"
          : "answered " + main.status + ": that server still runs the code it was started with, and takes descriptors after a restart");
    } finally {
      const mine = existsSync(uploads) ? readdirSync(uploads).filter((f) => !before.includes(f)) : [];
      for (const f of mine) { try { unlinkSync(uploads + f); } catch (_) {} }
      const pid = ownServer.pid;
      ownServer.kill(); ownServer = null;
      console.log("        removed the " + mine.length + " files this part put under web/uploads, and stopped the server it started (process " + pid + ")");
    }
  });

  // ---- V. the approved list on the pages: rule off, rule on with an approved hook, rule on with one that is not ----
  if (want("V")) await section("V. the review on the pages: the approved list with the rule off and on, read from the chain", async () => {
    // the localnet admin, read the way scripts/init-platform.mjs reads it, and never printed
    let admin = null;
    try { admin = deployer("localnet"); } catch (_) {}
    const p0 = await client.platform();
    if (!admin || !p0.admin.equals(admin.publicKey)) { skip("V: the localnet admin keypair is not the platform's admin on this chain"); return; }
    if (p0.hookApprovalRequired || p0.approvedHooks.length) { skip("V: the local platform's rule is on or its approved list is not empty: this part starts from the rule off and an empty list, and leaves it so"); return; }
    const chain = await chainHooks();
    const A = chain.find((h) => h.fix === "fee"), B = chain.find((h) => h.fix && h.fix !== "fee" && h.launches > 0), C = FIX.greedy;
    if (!A || !B || !C || chain.some((h) => h.id58 === C.id58)) { skip("V: it needs the fixture hooks fee and another one with coins, and greedy without a coin"); return; }
    say("hooks of this part", "approved with coins " + short(A.id58) + " (" + A.name + "), not approved with coins " + short(B.id58) + " (" + B.name + "), approved without a coin " + short(C.id58));
    const approved = [];
    const admit = async (h) => { await sendNode([ix.approveHook(admin.publicKey, h.id)], [admin]); approved.push(h.id); };
    const rule = async (on) => sendNode([ix.updatePlatform(admin.publicKey, { hookApprovalRequired: on })], [admin]);
    const cardOf = (id) => pg((i) => { const c = document.querySelector("#hooks .ws-card[data-hook='" + i + "'], #unreviewedHooks .ws-card[data-hook='" + i + "']"); if (!c) return null; const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : ""); const m = c.querySelector(".rv-mark"); return { approved: c.dataset.approved, mark: t(m), markHref: m && m.tagName === "A" ? m.getAttribute("href") : "", launch: (c.querySelector(".ws-launch") || { getAttribute: () => "" }).getAttribute("href"), report: t(c.querySelector("[data-report]")), badge: t(c.querySelector(".badge")), launches: t(c.querySelector(".launches")), where: c.closest("#unreviewedHooks") ? "unreviewed" : "grid" }; }, id);
    try {
      // 1. the rule off, one hook approved: today's listing, with the mark on that one
      await admit(A);
      await open(visitor, "/workshop.html", listReady);
      let cards = await readList();
      const a1 = await cardOf(A.id58), b1 = await cardOf(B.id58);
      check(same(cards.map((c) => c.id), chain.map((h) => h.id58)) && (await ev("document.querySelector('#unreviewed').hidden")), "rule off, one hook approved: the list is today's, every frozen hook with a coin, and no \"Not reviewed\" section");
      check(!!a1 && a1.approved === "yes" && a1.mark === "Reviewed by Programmable" && a1.report === "Report coming" && a1.launch === "" && !!b1 && b1.approved === "no" && b1.mark === "", "the approved hook's card carries the mark \"" + (a1 && a1.mark) + "\" and \"Report coming\", as the registry has no report for it. The others carry none");
      takeover.set("workshop/reviewed.json", { status: 200, body: JSON.stringify({ schema: 2, hooks: [{ program: A.id58, name: "Fixed fee", repo: "https://github.com/example-dev/fixed-fee", commit: "0".repeat(40), buildHash: "f".repeat(64), reviewedAt: "2026-10-24", report: "reviews/tax.html" }] }) });
      await open(visitor, "/workshop.html", listReady);
      const a2 = await cardOf(A.id58);
      check(a2.markHref === "reviews/tax.html" && a2.mark === "Reviewed by Programmable 2026-10-24" && a2.report === "Read the report", "with a registry entry (schema 2) the mark carries the date of the review and links to the report: \"" + a2.mark + "\"");
      await pair("v-list-off", "the list with the rule off and one hook approved");
      await open(visitor, "/workshop-hook.html?id=" + A.id58, hookTraded);
      let h = await readHook();
      const markRow = await txt("#markRow");
      takeover.delete("workshop/reviewed.json");
      check(h.checks.reviewed.result === "yes" && h.checks.reviewed.word === "Yes" && /put its program on the approved list, on 2026-10-24\. Read the report\. A review is not an audit and not a promise\./.test(h.checks.reviewed.means) && markRow === "Reviewed by Programmable 2026-10-24 Read the report" && h.launch === "launch-hook.html?hook=" + A.id58, "its page: check e reads the approved list on chain, \"" + h.checks.reviewed.means + "\", the mark sits under its name, and it keeps its launch button");
      await ev("window.scrollTo(0, 0); true"); await sleep(200); await shot("-v-hook-approved-1440");
      await view(375, 900); await sleep(250); await shot("-v-hook-approved-375"); check(await fits(), "an approved hook's page: no horizontal scroll at 375 (" + (await overflow()) + ")"); await view(W, HGT);

      // 2. the rule on: the approved hooks, also one without a coin, and the others in "Not reviewed"
      await rule(true);
      await admit(C);
      await open(visitor, "/workshop.html", listReady);
      cards = await readList();
      const rest = chain.filter((x) => x.id58 !== A.id58);
      const unrev = await pg(() => [...document.querySelectorAll("#unreviewedHooks .ws-card")].map((c) => c.dataset.hook));
      check(same(cards.map((c) => c.id), [A.id58, C.id58]) && (await txt("#count")) === "2 approved hooks", "rule on: the grid lists exactly the approved programs, the one without a coin too: " + cards.map((c) => c.name + " x" + c.launches).join(", ") + ", \"" + (await txt("#count")) + "\"");
      const a3 = await cardOf(A.id58), c3 = await cardOf(C.id58);
      check(a3.launch === "launch-hook.html?hook=" + A.id58 && c3.launch === "launch-hook.html?hook=" + C.id58 && a3.mark === "Reviewed by Programmable" && c3.mark === "Reviewed by Programmable" && c3.launches === "0" && c3.report === "Report coming", "each approved card has the mark, its report line and a launch button; the approved hook without a coin shows 0 coins and can be launched on");
      check(!(await ev("document.querySelector('#unreviewed').hidden")) && !(await ev("document.querySelector('#unreviewed').open")) && same([...unrev].sort(), rest.map((x) => x.id58).sort()) && (await txt("#unreviewedCount")) === String(rest.length), "the outside hooks with coins that are not on the list sit in a closed section \"Not reviewed\" (" + rest.length + ")");
      const b3 = await cardOf(B.id58);
      check(b3.where === "unreviewed" && b3.badge === "Not reviewed" && b3.launch === "" && /^These hooks have coins on them, but they are not on Programmable's approved list\. No new coin can launch on them\./.test(await txt("#unreviewedNote")), "a card there says \"Not reviewed\", has no launch button, and the section's warning says no new coin can launch on them");
      check(/^Hooks other people built\. Programmable reviewed each one and put it on the approved list\. Only an approved hook can open a pool\.$/.test(await txt("#lede")), "the head says that only an approved hook can open a pool");
      await pair("v-list-on", "the list with the rule on");
      await click("#unreviewed summary"); await sleep(400);
      await ev("document.querySelector('#unreviewed').scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); true"); await sleep(250); await shot("-v-list-unreviewed-1440");
      // a hook that is not on the list
      await open(visitor, "/workshop-hook.html?id=" + B.id58, hookTraded);
      h = await readHook();
      check(h.checks.reviewed.result === "unlisted" && h.checks.reviewed.word === "Not approved" && /^This program is not on Programmable's approved list, so no new coin can launch on it\. Coins already on it keep it/.test(h.checks.reviewed.means), "the page of a hook that is not on the list: check e says \"" + h.checks.reviewed.word + "\": " + h.checks.reviewed.means);
      check(h.launch === "" && h.noLaunch === "This hook has not been reviewed by Programmable yet, so no coin can launch on it. Coins already on it keep it, because a pool's hook can never change." && (await ev("document.querySelector('#toReview').getAttribute('href')")) === "review-hook.html" && (await ev("document.querySelector('#markRow').hidden")), "no launch button: \"" + h.noLaunch + "\", and a link to the review page");
      await pair("v-hook-unlisted", "a hook that is not on the list");
      // an approved hook without a coin
      await open(visitor, "/workshop-hook.html?id=" + C.id58, hookNoCoin);
      h = await readHook();
      check(h.checks.reviewed.result === "yes" && h.launch === "launch-hook.html?hook=" + C.id58 && h.coinsLede === "No coin has launched on this hook yet. It is listed in Custom hooks because Programmable approved it.", "an approved hook without a coin: the mark, the launch button, and \"" + h.coinsLede + "\"");
      // the launch form stops a hook that is not on the list before anything is built
      await open(dev, "/launch-hook.html?hook=" + B.id58, "!!document.querySelector('#customNotApproved') && document.querySelectorAll('#communityHooks .hook-option').length > 0");
      const lf = await pg(() => { const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : ""); return { verdict: t(document.querySelector("#customNotApproved .verdict")), link: (document.querySelector("#customNotApproved a[href='review-hook.html']") || {}).textContent || "", pool: document.querySelector("#customPool").hidden, community: [...document.querySelectorAll("#communityHooks .hook-option")].map((b) => b.dataset.hookId), lede: t(document.querySelector("#communityLede")) }; });
      check(lf.verdict === "This hook has not been reviewed by Programmable yet, so no coin can launch on it." && lf.link === "Get your hook reviewed" && lf.pool, "the Custom hook launch page, given a hook that is not on the list, stops at once: \"" + lf.verdict + "\", with a link to the review page and no pool address");
      check(same([...lf.community].sort(), [A.id58, C.id58].sort()) && /Only an approved hook can open a pool\./.test(lf.lede), "its list of community hooks offers the approved hooks only, the one without a coin too");
      await type("#name", "Refused " + run); await type("#symbol", "RFS" + run);
      const p0n = await prompts();
      await click("#launchBtn");
      await until("!!document.querySelector('#result .bad')", 20000);
      check((await txt("#result")) === "This hook has not been reviewed by Programmable yet, so no coin can launch on it." && (await prompts()) === p0n, "pressing Launch says the same sentence and the wallet never opens");
      await scrollTo("#customVerdict"); await sleep(250); await shot("-v-launch-refused-1440");
      await view(375, 900); await scrollTo("#customVerdict"); await sleep(250); await shot("-v-launch-refused-375"); check(await fits(), "the refusal on the launch form: no horizontal scroll at 375 (" + (await overflow()) + ")"); await view(W, HGT);
      let sdkRefuses = false;
      try { await client.requireHookAllowed(B.id); } catch (e) { sdkRefuses = e.name === "HookApprovalRefusal" && e.number === 6052; }
      check(sdkRefuses, "the SDK check the page uses refuses the same hook with HookNotApproved (6052)");
      // the hook checker
      const checkerOf = async (id) => { await open(visitor, "/hooks.html?id=" + id, "!!document.querySelector('#approvalLine')"); return pg(() => ({ line: document.querySelector("#approvalLine").textContent.trim(), verdict: (document.querySelector("#checkOut .verdict") || { textContent: "" }).textContent.trim(), launch: !!document.querySelector("#checkOut a.btn") })); };
      const kB = await checkerOf(B.id58), kA = await checkerOf(A.id58), kT = await checkerOf(PROGRAMS.hook_tax.toBase58());
      check(kB.line === "Approved list: not approved. The platform takes an outside hook only from the list." && kB.verdict === "A pool would refuse this hook. It is not on the approved list." && !kB.launch, "the hook checker on a hook that is not on the list: \"" + kB.line + "\", \"" + kB.verdict + "\", no launch button");
      check(kA.line === "Approved list: approved." && kA.verdict === "A pool would accept this hook." && kA.launch && kT.line === "Approved list: not needed (one of the platform's own hooks).", "on an approved hook: \"" + kA.line + "\"; on a template: \"" + kT.line + "\"");
      await open(visitor, "/hooks.html?id=" + B.id58, "!!document.querySelector('#approvalLine')"); await scrollTo("#checker"); await sleep(250); await shot("-v-checker-1440");
      // the list of reports names the approved hooks, read from the chain
      await open(visitor, "/reviews/index.html", "document.querySelectorAll('#approvedList a').length > 0");
      const listed = await pg(() => [...document.querySelectorAll("#approvedList a")].map((a) => a.dataset.approved));
      check(same([...listed].sort(), [A.id58, C.id58].sort()) && (await ev("document.querySelector('#approvedEmpty').hidden")), "the list of reports names the approved hooks from the chain, each with its report or \"Report coming\"");
      await scrollTo("#approvedTitle"); await sleep(250); await shot("-v-reports-approved-1440");
      // the coin and the pool of a coin whose hook is not on the list
      const TAKEN = "This hook is not on Programmable's approved list. Coins already on it keep it, because a pool's hook can never change. Read the hook's report, if it has one, before you trade.";
      const coinB = B.pools[0].address.toBase58(), coinA = A.pools[0].address.toBase58();
      await open(visitor, "/coin.html?pool=" + coinB, "!!document.querySelector('#hookCard .status')");
      check((await txt("#delistedNote")) === TAKEN, "the coin page of a coin on a hook that is not on the list warns next to the hook: \"" + (await txt("#delistedNote")) + "\"");
      await scrollTo("#hookCard"); await sleep(250); await shot("-v-coin-delisted-1440");
      await view(375, 900); await scrollTo("#delistedNote"); await sleep(250); await shot("-v-coin-delisted-375"); check(await fits(), "the warning on the coin page: no horizontal scroll at 375 (" + (await overflow()) + ")"); await view(W, HGT);
      await open(visitor, "/pool.html?pool=" + coinB, "!document.querySelector('#layout').hidden");
      check((await txt("#delistedNote")) === TAKEN + " The hook's page", "the liquidity page of that pool carries the same warning, with a link to the hook's page");
      await shot("-v-pool-delisted-1440");
      await view(375, 900); await sleep(250); await shot("-v-pool-delisted-375"); check(await fits(), "the warning on the liquidity page: no horizontal scroll at 375 (" + (await overflow()) + ")"); await view(W, HGT);
      await open(visitor, "/coin.html?pool=" + coinA, "!!document.querySelector('#hookCard .status')");
      check(!(await ev("!!document.querySelector('#delistedNote')")), "a coin on an approved hook carries no warning");
      // 3. a hook taken off the list: its coins keep it, its page and its coins say so
      await sendNode([ix.revokeHook(admin.publicKey, A.id)], [admin]);
      approved.splice(approved.findIndex((k) => k.equals(A.id)), 1);
      await open(visitor, "/coin.html?pool=" + coinA, "!!document.querySelector('#hookCard .status')");
      check((await txt("#delistedNote")) === TAKEN, "once taken off the list, the coins already on that hook show the warning");
      await open(visitor, "/workshop.html", listReady);
      check(same((await readList()).map((c) => c.id), [C.id58]) && (await pg(() => [...document.querySelectorAll("#unreviewedHooks .ws-card")].map((c) => c.dataset.hook))).includes(A.id58), "and the hook leaves the grid for \"Not reviewed\"");
    } finally {
      // back as it was: the rule off and the approved list empty
      let now = await client.platform();
      if (now.hookApprovalRequired) await rule(false);
      now = await client.platform();
      for (const k of now.approvedHooks) if (approved.some((a) => a.equals(k))) await sendNode([ix.revokeHook(admin.publicKey, k)], [admin]);
      const end = await client.platform();
      check(!end.hookApprovalRequired && end.approvedHooks.length === 0, "the local platform is back as this part found it: the rule off, the approved list empty");
    }
  });

  // ---- N. navigation ----------------------------------------------------------------------------------------
  if (want("N")) await section("N. Custom hooks is reachable from every page, and its hooks from the Custom hook launch page", async () => {
    // every page carries the two mount points the shell fills, and the shell links to Custom hooks twice
    const pages = readdirSync(here("../")).filter((f) => f.endsWith(".html"));
    const bare = [];
    for (const f of pages) {
      const html = await (await fetch(origin + "/" + f)).text();
      if (!/<header class="site-header" id="siteHeader"><\/header>/.test(html) || !/<footer class="site-footer" id="siteFooter"><\/footer>/.test(html)) bare.push(f);
    }
    check(bare.length === 0, "every page of the site carries the header and the footer the shell fills: " + pages.length + " pages" + (bare.length ? ". Not: " + bare.join(", ") : ""));
    const shellOf = () => pg(() => ({ menu: [...document.querySelectorAll("#menuSheet a.menu-item")].map((a) => a.textContent.trim() + " -> " + a.getAttribute("href")), foot: [...document.querySelectorAll("#siteFooter a")].map((a) => a.textContent.trim() + " -> " + a.getAttribute("href")) }));
    let shellOk = true;
    for (const p of ["/index.html", "/launch.html", "/launch-hook.html", "/workshop-guide.html"]) {
      await open(visitor, p, "!!document.querySelector('#menuSheet') && document.querySelectorAll('#siteFooter a').length > 3");
      const s = await shellOf();
      shellOk = shellOk && s.menu.includes("Custom hooks -> workshop.html") && s.foot.includes("Custom hooks -> workshop.html") && s.foot.includes("Get your hook reviewed -> review-hook.html") && s.foot.includes("Hook reports -> reviews/index.html") && s.foot.includes("Build a hook -> workshop-guide.html");
    }
    check(shellOk, "the menu and the footer of Explore, Launch a token, the Custom hook launch page and the guide link to Custom hooks, and the footer to Get your hook reviewed, the hook reports and the guide, Build a hook");
    // the Custom hook launch page lists the same hooks, from the same function
    const chain = await chainHooks();
    await open(visitor, "/launch-hook.html", "document.querySelectorAll('#communityHooks .hook-option').length > 0 || /No hook/.test(document.querySelector('#communityHooks').textContent)");
    const offered = await pg(() => [...document.querySelectorAll("#communityHooks .hook-option")].map((b) => b.dataset.hookId));
    const listLink = await ev("(() => { const a = document.querySelector('#communityHooks') && document.querySelector('#communityHooks').parentElement.querySelector('a[href=\"workshop.html\"]'); return a ? a.getAttribute('href') : ''; })()");
    check(same([...offered].sort(), chain.map((h) => h.id58).sort()) && listLink === "workshop.html", "the Custom hook launch page offers exactly the " + chain.length + " hooks of Custom hooks, from the same list, and links to it");
    await scrollTo("#communityHooks"); await sleep(300); await shot("-launch-community-1440");
    // on a phone: the menu opens, and its Custom hooks link leads to the page and is marked as the current one
    await view(375, 900);
    await open(visitor, "/index.html", "!!document.querySelector('#menuBtn')");
    await click("#menuBtn"); await sleep(400);
    await shot("-menu-375");
    await follow("#menuSheet a.menu-item[href='workshop.html']", listReady);
    check((await ev("location.pathname")) === "/workshop.html" && (await ev("(() => { const a = document.querySelector('#menuSheet a.menu-item[aria-current=page]'); return a ? a.textContent.trim() : ''; })()")) === "Custom hooks" && (await fits()), "on a phone the menu opens, its Custom hooks link leads to the page, the page marks it as the current one, and nothing scrolls sideways (" + (await overflow()) + ")");
    await view(W, HGT);
    // the hook checker links a hook of another builder to its page
    if (chain[0]) {
      const href = "workshop-hook.html?id=" + chain[0].id58;
      await open(visitor, "/hooks.html?id=" + chain[0].id58, "!!document.querySelector('a[href=\"" + href + "\"]')");
      check(await ev("!!document.querySelector('a[href=\"" + href + "\"]')"), "the hook checker links a hook of another builder to its page in Custom hooks");
    }
    await open(visitor, "/docs.html", "!!document.querySelector('#workshop') && !!document.querySelector('[data-plat]') && document.querySelector('[data-plat]').textContent !== ''");
    const docs = await pg(() => { const out = []; let n = document.querySelector("#workshop"); while (n && !(n.tagName === "H2" && n.id !== "workshop")) { out.push(n.textContent.replace(/\s+/g, " ").trim()); n = n.nextElementSibling; } return out.join(" "); });
    check(docs.includes("plus " + sol(MARGIN, 6) + " SOL, or more than " + sol(CAP, 6) + " SOL in all") && /These checks are not an audit\./.test(docs) && /The mark Reviewed by Programmable says that the code passed the review\./.test(docs) && /A simulation is not a guarantee of what a hook does on later trades\. The hook's code is the truth\./.test(docs) && /workshop\/reviewed\.json/.test(docs) && !/Nobody approves a hook/.test(docs), "the docs explain the workshop: the listing with and without the approval rule, the descriptor, the five checks that are not an audit, the registry of reports, and the guard with its two limits taken from the code");
    const review = await pg(() => { const out = []; let n = document.querySelector("#review"); while (n && !(n.tagName === "H2" && n.id !== "review")) { out.push(n.textContent.replace(/\s+/g, " ").trim()); n = n.nextElementSibling; } return { text: out.join(" "), links: [...document.querySelectorAll("#review ~ p a")].map((a) => a.getAttribute("href")).filter((h) => /review-hook|reviews\//.test(h)), toc: !!document.querySelector(".toc a[href='#review']") }; });
    check(review.toc && /25 USD in SOL/.test(review.text) && /1 to 4 SOL/.test(review.text) && /approved list/.test(review.text) && /A review is not an audit and not a promise\./.test(review.text) && review.links.includes("review-hook.html") && review.links.includes("reviews/index.html"), "the docs have a section \"Custom hooks and the review\" in their list: what it is, the fee, the approved list, and links to the review page and the reports");
    // the docs have to name the pin the way the site reads it: a builder who follows them writes it by hand
    const docsHtml = await (await fetch(origin + "/docs.html")).text();
    check(!docsHtml.includes("#sha256=") && docs.includes("#s=") && /It is not a signature, and it says nothing about the code\./.test(docs), "the docs name the pin in the one form the site reads (\"#s=\" and 22 characters) and say what it is worth" + (docsHtml.includes("#sha256=") ? ". They still name the earlier form \"#sha256=\", which the site now reads as no pin: web/docs.html, the paragraph that starts \"A manifest's link can also pin the file.\"" : ""));
    // plain keyboard characters in every file of the workshop
    const files = ["../workshop.html", "../workshop.js", "../workshop-hook.html", "../workshop-hook.js", "../workshop-guide.html", "../workshop-guide.js", "../workshop-lib.js", "../workshop-descriptor.js", "../workshop.css", "../workshop/reviewed.json", "../workshop/site.json", "../serve.js", "../api/metadata.js", "../../hook-template/scripts/deploy-freeze.sh", "../../hook-template/hook.json", "../../examples/hooks/early-bird/hook.json", "../../examples/hooks/loyalty-points/hook.json",
      "../../hook-template/README.md", "../../examples/hooks/README.md", "../../examples/hooks/early-bird/README.md", "../../examples/hooks/loyalty-points/README.md", "./flow-workshop.mjs",
      "../review-hook.html", "../review-hook.js", "../reviews/index.html", "../reviews/tax.html", "../reviews/launch-guard.html", "../reviews/buyback.html", "../reviews/collectible.html", "../reviews/launch-rules.html", "../reviews/reviews.css", "../reviews/report.js", "./flow-review.mjs", "./review-standin.mjs"];
    const odd = files.filter((f) => /[^\x00-\x7E]/.test(readFileSync(here(f), "utf8")));
    check(odd.length === 0, "the workshop's files hold plain keyboard characters only (" + files.length + " files)" + (odd.length ? ". Not: " + odd.join(", ") : ""));
  });

  // ---- summary ------------------------------------------------------------------------------------------
  console.log("\nSUMMARY");
  for (const [k, v] of Object.entries(R)) console.log("  launched on \"" + k + "\": " + v.sym + ", pool " + v.pool.toBase58());
  const seen = new Map();
  for (const e of pageErrors) seen.set(e, (seen.get(e) || 0) + 1);
  console.log("\npage errors (" + pageErrors.length + "): " + (pageErrors.length ? "\n" + [...seen].map(([e, n]) => "  " + (n > 1 ? n + "x " : "") + e).join("\n") : "none"));
  // Two kinds of logged errors are not the site's. The run answers one descriptor with 404 and one
  // upload with 400 on purpose, and the browser logs those loads as failed. And a coin's picture
  // comes from the address in the coin's own metadata: when that host does not let a browser
  // read it, the browser logs it, on this page as on Explore, and the page draws a monogram.
  const coinHosts = new Set();
  for (const p of await client.allPools()) { try { const md = await client.metadata(p.baseMint); if (md && /^https?:\/\//.test(md.uri)) coinHosts.add(md.uri); } catch (_) {} }
  const staged = (e) => /status of 40[04]/.test(e) && onPurpose.some((re) => re.test(e));
  // coins of earlier runs carry the address of package.json, which serve.js no longer serves: their metadata host refuses like any other
  const coinHost = (e) => [...coinHosts].some((u) => e.includes(u));
  const own = pageErrors.filter((e) => !staged(e) && !coinHost(e));
  check(own.length === 0, "no console error caused by the site (" + pageErrors.length + " logged: " + pageErrors.filter(staged).length + " are failed loads this run answered on purpose, " + pageErrors.filter((e) => !staged(e) && coinHost(e)).length + " are coin pictures whose own host refused the browser)" + (own.length ? ": " + own.join(" | ") : ""));
  console.log("\nscreenshots (" + shots.length + "): " + shots.join(", "));
  ws.close();
} catch (e) {
  check(false, "the run stopped: " + e.message);
  if (pageErrors.length) console.error(pageErrors.join("\n"));
  try { await shot("-failure"); } catch (_) {}
} finally {
  await cleanup();
  console.log("\n" + total + " checks, " + (total - failed) + " ok, " + failed + " failed" + (notRun.length ? ", " + notRun.length + " part" + (notRun.length === 1 ? "" : "s") + " NOT RUN" : ""));
  if (failures.length) console.log("failed:\n" + failures.map((f) => "  - " + f).join("\n"));
  if (notRun.length) console.log("not run:\n" + notRun.map((f) => "  - " + f).join("\n"));
  if (failed) process.exitCode = 1;
}

/// Close the browser and give the pools their coins back. Runs once: at the end, or on Ctrl+C.
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (ownServer) { try { ownServer.kill(); } catch (_) {} ownServer = null; }
  console.log("\n" + (await edge.close()));
  console.log("\nselling back what the throwaway wallets hold");
  let sold = 0n, left = 0n;
  for (const [kp, poolKey] of held) sold += await sellBack(kp, poolKey);
  for (const [kp, poolKey] of held) { const p = await client.pool(poolKey); if (p) left += await client.tokenBalance(kp.publicKey, p.baseMint, p.baseTokenProgram); }
  console.log("  sold back " + fmtUnits(sold, 6, 6) + " coins over " + held.length + " positions. Coins still held by the throwaway wallets: " + fmtUnits(left, 6, 6));
}
