// The release check of an outside hook (HOOKS.md section 6.1). Read-only: it sends nothing.
// It prints what Programmable checks on chain before it puts a program on the approved list,
// each line PASS or FAIL, and ends with READY TO APPROVE or NOT READY.
//
//   node scripts/check-hook-release.mjs <localnet|devnet|mainnet> <program id> [<repository url> <commit>]
//
// Give the repository and the 40-character commit that passed the review: the check then
// compares them with the verified build. The verified build comes from the verification
// service that Solana's explorers use (verify.osec.io): the developer uploads the build record
// with the program's upgrade authority BEFORE freezing, then asks for a remote verification
// (hook-template/README.md, "Release"). Its on-chain hash is the program's bytes with the
// trailing zeros removed, the same hash this script computes.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { HookpoolClient, decodeHookManifest, describeFlags, isTemplateProgram, pda } from "../sdk/dist/index.js";
import { clusterArg, connection } from "./cluster.mjs";

const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const LOADER_V4 = new PublicKey("LoaderV411111111111111111111111111111111111");
const LOADER_V2 = new PublicKey("BPFLoader2111111111111111111111111111111111");
const LOADER_V1 = new PublicKey("BPFLoader1111111111111111111111111111111111");
const VERIFY_API = process.env.VERIFY_API ?? "https://verify.osec.io";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
/// The program's bytes without the zeros a deploy pads them with: the verified-build hash.
export function trimmedHash(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return sha256(bytes.subarray(0, end));
}

/// "https://github.com/a/b.git", ".../a/b/tree/<commit>", ".../a/b/" all read as "github.com/a/b".
export function repoKey(url) {
  try {
    const u = new URL(String(url));
    const parts = u.pathname.replace(/\.git$/, "").split("/").filter(Boolean).slice(0, 2);
    return (u.hostname.toLowerCase() + "/" + parts.join("/")).toLowerCase();
  } catch { return ""; }
}

/// Everything the chain says about a hook program. Each check is { ok, text }.
export async function hookFacts(conn, program) {
  const checks = [];
  const add = (ok, text) => { checks.push({ ok, text }); return ok; };
  const out = { program, checks, frozen: false, hash: null, manifest: null, flags: null, extraMetas: null, approved: null, rule: null, template: isTemplateProgram(program) };
  const acct = await conn.getAccountInfo(program);
  if (!add(!!acct && acct.executable, acct ? (acct.executable ? "the program account exists and is executable" : "the account is not a program") : "no account at this address"))
    return out;
  if (acct.owner.equals(LOADER_V3)) {
    const pd = await conn.getAccountInfo(pda.programData(program));
    if (!add(!!pd && pd.data.length > 45, pd ? "its ProgramData was read" : "its ProgramData is missing")) return out;
    const hasAuthority = pd.data[12] === 1;
    out.frozen = !hasAuthority;
    out.deploySlot = pd.data.readBigUInt64LE(4);
    out.hash = trimmedHash(pd.data.subarray(45));
    add(out.frozen, out.frozen ? "frozen: the upgrade authority is removed, the code can never change"
      : "NOT frozen: it can still be upgraded by " + new PublicKey(pd.data.subarray(13, 45)).toBase58());
  } else if (acct.owner.equals(LOADER_V4)) {
    const status = acct.data.length >= 48 ? acct.data.readBigUInt64LE(40) : -1n;
    out.frozen = status === 2n;
    out.hash = trimmedHash(acct.data.subarray(48));
    add(out.frozen, out.frozen ? "frozen: finalized under loader v4" : "NOT frozen: loader v4 status " + status);
  } else if (acct.owner.equals(LOADER_V2) || acct.owner.equals(LOADER_V1)) {
    out.frozen = true;
    out.hash = trimmedHash(acct.data);
    add(true, "frozen: a legacy loader has no upgrade path");
  } else {
    add(false, "an unknown loader owns it: " + acct.owner.toBase58());
    return out;
  }
  add(!out.template, out.template ? "this is one of the platform's own templates: it needs no approval" : "an outside hook, not one of the platform's own templates");

  const [man, em, plat] = await conn.getMultipleAccountsInfo([pda.manifest(program), pda.extraMetas(program), pda.platform()]);
  if (add(!!man && man.owner.equals(program), man ? (man.owner.equals(program) ? "its manifest exists and belongs to it" : "its manifest belongs to another program") : "it has no manifest: no pool can open on it")) {
    try {
      out.manifest = decodeHookManifest(new Uint8Array(man.data));
      out.flags = describeFlags(out.manifest.flags);
    } catch (e) { add(false, "its manifest cannot be read: " + e.message); }
  }
  add(!!em && em.owner.equals(program), em ? (em.owner.equals(program) ? "its extra-accounts list exists and belongs to it" : "its extra-accounts list belongs to another program") : "it has no extra-accounts list");
  if (em) out.extraMetas = { length: em.data.length, sha256: sha256(em.data) };
  if (plat) {
    const client = new HookpoolClient(conn);
    const p = await client.platform();
    out.rule = p.hookApprovalRequired;
    out.approved = p.approvedHooks.some((k) => k.equals(program));
  }
  return out;
}

/// The verified build, from the verification service. null when it cannot be reached.
export async function verifiedBuild(program) {
  try {
    const r = await fetch(`${VERIFY_API}/status/${program.toBase58()}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { error: "the verification service answered " + r.status };
    return await r.json();
  } catch (e) { return { error: "the verification service could not be reached (" + String(e.message || e).slice(0, 80) + ")" }; }
}

export function releaseChecks(facts, build, repo, commit) {
  const checks = [];
  const add = (ok, text) => checks.push({ ok, text });
  if (!build || build.error) {
    add(false, (build && build.error ? build.error : "no answer") + `: open ${VERIFY_API}/status/${facts.program.toBase58()} in a browser and compare by hand`);
    return checks;
  }
  add(build.is_verified === true, build.is_verified ? "the verification service marks the program verified" : "NOT verified by the verification service: " + (build.message || "no message"));
  add(!!facts.hash && build.on_chain_hash === facts.hash, `the service's on-chain hash ${String(build.on_chain_hash || "none").slice(0, 16)} equals the bytes read now ${String(facts.hash).slice(0, 16)}`);
  add(!!build.executable_hash && build.executable_hash === facts.hash, `the verified build's hash ${String(build.executable_hash || "none").slice(0, 16)} equals the bytes on chain`);
  if (commit) add(String(build.commit || "").toLowerCase() === commit.toLowerCase(), `the verified commit ${String(build.commit || "none").slice(0, 12)} is the reviewed commit ${commit.slice(0, 12)}`);
  if (repo) add(repoKey(build.repo_url) === repoKey(repo), `the verified repository ${repoKey(build.repo_url) || "none"} is the reviewed one ${repoKey(repo)}`);
  return checks;
}

async function main() {
  const cluster = clusterArg();
  const [programArg, repo, commit] = process.argv.slice(3);
  let program;
  try { program = new PublicKey(programArg); } catch { console.error("usage: node scripts/check-hook-release.mjs <cluster> <program id> [<repository url> <commit>]"); return 2; }
  if (commit && !/^[0-9a-f]{40}$/i.test(commit)) { console.error("the commit must be the full 40-character hash"); return 2; }
  const conn = connection(cluster);
  const facts = await hookFacts(conn, program);
  console.log(`hook ${program.toBase58()} on ${cluster}`);
  if (facts.manifest) {
    console.log(`  name "${facts.manifest.name}", declared admin ${facts.manifest.admin ? facts.manifest.admin.toBase58() : "none"}, uri ${facts.manifest.uri || "none"}`);
    for (const s of facts.flags.sentences) console.log("  " + s);
  }
  if (facts.hash) console.log(`  program hash ${facts.hash}`);
  if (facts.extraMetas) console.log(`  extra-accounts list ${facts.extraMetas.length} bytes, sha256 ${facts.extraMetas.sha256.slice(0, 16)}`);
  if (facts.rule !== null) console.log(`  approved list: rule ${facts.rule ? "on" : "off"}, this program ${facts.approved ? "IS" : "is not"} on it`);
  const all = [...facts.checks];
  if (facts.hash && cluster !== "localnet") all.push(...releaseChecks(facts, await verifiedBuild(program), repo, commit));
  else if (cluster === "localnet") all.push({ ok: true, text: "local chain: the verified build is not checked here" });
  if (!repo || !commit) all.push({ ok: false, text: "no reviewed repository and commit given: the build is not compared with the review" });
  for (const c of all) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.text}`);
  const ready = all.every((c) => c.ok) && !facts.template;
  console.log(ready ? "READY TO APPROVE: node scripts/hook-approval.mjs " + cluster + " approve " + program.toBase58() : "NOT READY: fix every FAIL line first");
  return ready ? 0 : 1;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main().then((code) => { process.exitCode = code; }, (e) => { console.error(String(e.message || e)); process.exitCode = 1; });
