// Calls this hook's `init_manifest(name, uri)`: it creates the manifest account (flags,
// name, uri) and the extra-accounts list. Only the program's upgrade authority may call
// it, so it has to run after the deploy and before the freeze. deploy-freeze.sh does.
//
//   node scripts/publish-manifest.mjs <program id> <rpc url> <wallet keypair file> <name> <uri>
//   node scripts/publish-manifest.mjs --check      only checks that @solana/web3.js loads
//
// Node looks for @solana/web3.js in node_modules next to this file and then in every
// folder above it. Inside the Programmable repository that finds the repository's own copy
// (run `npm install` at the repository root once). Anywhere else, run
// `npm install @solana/web3.js` in this hook's folder.
//
// The instruction it builds is the template's: two strings, and the accounts authority,
// program data, manifest, extra-metas list, system program. If you change
// `init_manifest` in your hook, change this file with it.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";

if (process.argv[2] === "--check") process.exit(0);

const [programId, rpc, walletPath, name, uri] = process.argv.slice(2);
if (!programId || !rpc || !walletPath || name === undefined || uri === undefined) {
  console.error("usage: node scripts/publish-manifest.mjs <program id> <rpc url> <wallet keypair file> <name> <uri>");
  process.exit(1);
}
if (Buffer.byteLength(name, "utf8") > 32) { console.error("the name is longer than 32 bytes"); process.exit(1); }
if (Buffer.byteLength(uri, "utf8") > 128) { console.error("the uri is longer than 128 bytes"); process.exit(1); }

const pid = new PublicKey(programId);
const conn = new Connection(rpc, "confirmed");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const programData = PublicKey.findProgramAddressSync([pid.toBuffer()], LOADER)[0];
const manifest = PublicKey.findProgramAddressSync([Buffer.from("manifest")], pid)[0];
const extraMetas = PublicKey.findProgramAddressSync([Buffer.from("extra-metas")], pid)[0];

if (await conn.getAccountInfo(manifest)) {
  console.log("manifest already published at " + manifest.toBase58());
  process.exit(0);
}

// Anchor instruction data: sha256("global:init_manifest")[..8], then each string as a
// u32 length (little endian) and its bytes.
const disc = createHash("sha256").update("global:init_manifest").digest().subarray(0, 8);
const str = (s) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
const ix = new TransactionInstruction({
  programId: pid,
  data: Buffer.concat([disc, str(name), str(uri)]),
  keys: [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: programData, isSigner: false, isWritable: false },
    { pubkey: manifest, isSigner: false, isWritable: true },
    { pubkey: extraMetas, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
// A program can be called from the slot AFTER the one it was deployed in. The deploy has
// only just returned, so wait for that slot to pass, and try again a few times if the
// chain still answers that the program is not there.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = await conn.getAccountInfo(programData);
if (data && data.data.length >= 12) {
  const deployedAt = data.data.readBigUInt64LE(4);
  for (let i = 0; i < 40 && BigInt(await conn.getSlot("confirmed")) <= deployedAt + 1n; i++) await sleep(400);
}
const notYet = (text) => /Unsupported program id|ProgramAccountNotFound|not deployed|invalid program for execution/i.test(text);
for (let attempt = 1; ; attempt++) {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [wallet], { commitment: "confirmed" });
    console.log("manifest published at " + manifest.toBase58() + "  (transaction " + sig + ")");
    break;
  } catch (e) {
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null);
    const text = String(e.message) + " " + (logs ? logs.join(" ") : "");
    if (attempt < 8 && notYet(text)) { await sleep(800); continue; }
    console.error("init_manifest failed: " + e.message);
    if (logs) console.error(logs.join("\n"));
    process.exit(1);
  }
}
