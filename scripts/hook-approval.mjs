// The approved list (HOOKS.md section 6.1), for the platform admin.
//
//   node scripts/hook-approval.mjs <cluster> status                 the rule and the list, read only
//   node scripts/hook-approval.mjs <cluster> rule on                 only approved outside hooks may open pools
//   node scripts/hook-approval.mjs <cluster> rule off                every frozen hook may open pools again
//   node scripts/hook-approval.mjs <cluster> approve <program id>    put a frozen hook on the list
//   node scripts/hook-approval.mjs <cluster> revoke <program id>     take it off (its pools keep it)
//
// Every change is checked here first, then simulated, and sent only after you type "yes"
// (add --yes to skip the question in a script you trust). The admin keypair is read the way
// every script here reads it (scripts/cluster.mjs): <secrets>/<cluster>-deployer.json.
// Before an approve, run scripts/check-hook-release.mjs with the reviewed repository and
// commit: it must end with READY TO APPROVE.
import { createInterface } from "node:readline/promises";
import { PublicKey, Transaction } from "@solana/web3.js";
import { HookpoolClient, ix, isTemplateProgram } from "../sdk/dist/index.js";
import { clusterArg, connection, deployer, send } from "./cluster.mjs";
import { hookFacts } from "./check-hook-release.mjs";

let cluster;
function printState(p) {
  console.log(`approved list on ${cluster}: the rule is ${p.hookApprovalRequired ? "ON (only approved outside hooks may open pools)" : "OFF (every frozen hook may open pools)"}`);
  if (p.approvedListCorrupt) console.log("  WARNING: the list cannot be read; while the rule is on, the program refuses every outside hook");
  if (!p.approvedHooks.length) console.log("  the list is empty");
  for (const k of p.approvedHooks) console.log("  " + k.toBase58());
}

async function main() {
  cluster = clusterArg();
  const args = process.argv.slice(3).filter((a) => a !== "--yes");
  const yes = process.argv.includes("--yes");
  const [cmd, arg] = args;
  const usage = () => { console.error("usage: node scripts/hook-approval.mjs <cluster> status | rule on|off | approve <program id> | revoke <program id> [--yes]"); return 2; };
  if (!["status", "rule", "approve", "revoke"].includes(cmd)) return usage();

  const conn = connection(cluster);
  const client = new HookpoolClient(conn);
  const platform = await client.platform();
  if (!platform) { console.error("the platform is not initialised on " + cluster); return 1; }


  if (cmd === "status") { printState(platform); return 0; }

  const admin = deployer(cluster);
  if (!platform.admin.equals(admin.publicKey)) {
    console.error(`only the platform admin ${platform.admin.toBase58()} can change the list; the key here is ${admin.publicKey.toBase58()}`);
    return 1;
  }

  let instruction, label;
  if (cmd === "rule") {
    if (arg !== "on" && arg !== "off") return usage();
    const on = arg === "on";
    if (platform.hookApprovalRequired === on) { console.log(`the rule is already ${arg}: nothing to send`); return 0; }
    instruction = ix.updatePlatform(admin.publicKey, { hookApprovalRequired: on });
    label = `switch the approved-list rule ${arg.toUpperCase()}`;
  } else {
    let program;
    try { program = new PublicKey(arg); } catch { return usage(); }
    if (cmd === "approve") {
      if (isTemplateProgram(program)) { console.error("this is one of the platform's own templates: it needs no approval"); return 1; }
      if (platform.approvedHooks.some((k) => k.equals(program))) { console.log("already on the list: nothing to send"); return 0; }
      const facts = await hookFacts(conn, program);
      for (const c of facts.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.text}`);
      if (facts.manifest) console.log(`  name "${facts.manifest.name}": ${facts.flags.sentences.join(" ")}`);
      if (facts.hash) console.log(`  program hash ${facts.hash}`);
      if (!facts.checks.every((c) => c.ok)) { console.error("not approved: fix every FAIL line first (nothing was sent)"); return 1; }
      instruction = ix.approveHook(admin.publicKey, program);
      label = `APPROVE ${program.toBase58()}`;
    } else {
      if (!platform.approvedHooks.some((k) => k.equals(program))) { console.error("this program is not on the list: nothing to revoke"); return 1; }
      instruction = ix.revokeHook(admin.publicKey, program);
      label = `REVOKE ${program.toBase58()} (its pools keep it; new pools are refused)`;
    }
  }

  // simulate first: a refusal costs nothing and is shown with the program's own words
  const tx = new Transaction().add(instruction);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(admin);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    console.error("the simulation refused it, nothing was sent:");
    console.error((sim.value.logs || []).filter((l) => /Error|failed|log:/.test(l)).slice(-6).join("\n"));
    return 1;
  }
  console.log(`simulation OK. About to send on ${cluster}: ${label}`);
  if (!yes) {
    if (!process.stdin.isTTY) { console.error("no terminal to ask in: add --yes to send"); return 1; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Type yes and press Enter to send it: ')).trim().toLowerCase();
    rl.close();
    if (answer !== "yes") { console.log("not sent"); return 0; }
  }
  await send(conn, [instruction], [admin], label);
  printState(await client.platform());
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(String(e.message || e)); process.exitCode = 1; });
