// Give the seven programs ids of your own. Run it ONCE, before the first deploy, and only if
// you do not want to deploy at the ids this repository ships with.
//
//   node scripts/rekey.mjs            use the keypairs in <secrets>/program-keys, making the missing ones
//   node scripts/rekey.mjs --dry      show what would change, write nothing
//
// <secrets> is $SOLHOOKS_SECRETS, or "sol-secrets" in your home folder. A program id is the
// public key of <secrets>/program-keys/<program>.json. Whoever holds that file can deploy the
// program at that address on a cluster where it does not exist yet, so keep the files private.
//
// The ids are written into the programs (declare_id), the crate hooks build against, the
// SDK, the Jupiter adapter, tests and docs. This script replaces every one of them, and the
// hook caller addresses the documents derive from them, then tells you what to rebuild. It
// never prints or copies a secret key.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { secretsDir } from "./cluster.mjs";

const PROGRAMS = ["hookpool", "hooklaunch", "hook_tax", "hook_launch_guard", "hook_buyback", "hook_collectible", "hook_rules"];
const root = fileURLToPath(new URL("..", import.meta.url));
const dry = process.argv.includes("--dry");
const keysDir = path.join(secretsDir(), "program-keys");

// the ids in force today: Anchor.toml [programs.localnet]
const anchor = readFileSync(path.join(root, "Anchor.toml"), "utf8");
const section = /\[programs\.localnet\]([^[]*)/.exec(anchor);
if (!section) { console.error("Anchor.toml has no [programs.localnet] section"); process.exit(1); }
const current = {};
for (const line of section[1].split("\n")) { const m = /^\s*(\w+)\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(line); if (m) current[m[1]] = m[2]; }

const map = new Map();
for (const p of PROGRAMS) {
  if (!current[p]) { console.error(`Anchor.toml has no id for ${p}`); process.exit(1); }
  const file = path.join(keysDir, p + ".json");
  let kp;
  if (existsSync(file)) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
  else {
    kp = Keypair.generate();
    if (!dry) { mkdirSync(keysDir, { recursive: true }); writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 }); }
    console.log(`${dry ? "would make" : "made"} a new keypair for ${p}`);
  }
  const id = kp.publicKey.toBase58();
  console.log(`  ${p.padEnd(18)} ${current[p]}  ->  ${id}${id === current[p] ? "   (unchanged)" : ""}`);
  if (id !== current[p]) map.set(current[p], id);
}
if (map.size === 0) { console.log("every id already matches its keypair. Nothing to change."); process.exit(0); }

// The documents also print addresses that FOLLOW from the ids: the address the pool signs a
// hook's callbacks with, one per hook program and one for a pool without a hook
// (["caller", hook program] under the pool program). They move with the ids.
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const callerOf = (pool, hook) => PublicKey.findProgramAddressSync([Buffer.from("caller"), new PublicKey(hook).toBuffer()], new PublicKey(pool))[0].toBase58();
const idNow = (p) => map.get(current[p]) || current[p];
let callers = 0;
for (const p of [...PROGRAMS.filter((x) => x !== "hookpool" && x !== "hooklaunch"), null]) {
  const from = callerOf(current.hookpool, p ? current[p] : SYSTEM_PROGRAM);
  const to = callerOf(idNow("hookpool"), p ? idNow(p) : SYSTEM_PROGRAM);
  if (from !== to) { map.set(from, to); callers++; }
}
console.log(`  and ${callers} hook caller addresses that follow from the ids`);

// every text file of the repository, except what is installed, built or snapshotted
const SKIP_DIRS = new Set(["node_modules", "target", ".git", ".anchor", "fixtures", "state", "status", "uploads"]);
const TEXT = /\.(rs|toml|ts|js|mjs|cjs|json|md|sh|html|css|txt|yml|yaml|service|example)$/i;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; } // a dangling link
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full); }
    else if (TEXT.test(name) && st.size < 8_000_000) files.push(full);
  }
})(root);

let changed = 0, replaced = 0;
for (const file of files) {
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const [from, to] of map) {
    const parts = after.split(from);
    if (parts.length > 1) { replaced += parts.length - 1; after = parts.join(to); }
  }
  if (after !== before) {
    changed++;
    if (!dry) writeFileSync(file, after);
    console.log(`  ${dry ? "would change" : "changed"} ${path.relative(root, file)}`);
  }
}
console.log(`${dry ? "would replace" : "replaced"} ${replaced} ids in ${changed} files.`);
if (!dry) {
  console.log(`
Next, in this order:
  1. bash build.sh build                    the programs, with their new ids
  2. bash build.sh test                     must pass before anything else
  3. npm run build -w sdk                   the SDK bundles (the site and the API load them)
  4. node --test "web/api/_test/*.test.mjs" and node --test "watcher/test/*.test.mjs"
  5. bash scripts/localnet.sh up, node scripts/init-platform.mjs localnet, then the e2e scripts
  6. node jupiter-adapter/scripts/make-fixtures.mjs localnet, then
     RPC=http://127.0.0.1:8899 REFRESH=1 FRESH_PROGRAMS=1 bash jupiter-adapter/test.sh
     (pool addresses follow the program id, so the adapter's snapshots must be made again)
  7. node scripts/check-integrators-doc.mjs http://127.0.0.1:8899
     (it compares every address, layout and formula INTEGRATORS.md prints with the chain)
Do not run "anchor keys sync": the ids now in the source are the right ones.`);
}
