// Shared bits for the node scripts: cluster config, deployer keypair, send helper.
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ComputeBudgetProgram, Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

/// A paid RPC is read from the environment, or from <secrets>/<cluster>.env (one NAME=value per
/// line, the file deploy.sh reads too), so its key is never typed on a command line.
function fromEnvFile(cluster, name) {
  try {
    const file = path.join(process.env.SOLHOOKS_SECRETS ?? path.join(os.homedir(), "sol-secrets"), `${cluster}.env`);
    if (!existsSync(file)) return undefined;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0 && line.slice(0, i).trim() === name) return line.slice(i + 1).trim() || undefined;
    }
  } catch (_) { /* unreadable: fall back to the public endpoint */ }
  return undefined;
}

export const RPC = {
  localnet: process.env.LOCALNET_RPC ?? "http://127.0.0.1:8899",
  devnet: process.env.DEVNET_RPC ?? fromEnvFile("devnet", "DEVNET_RPC") ?? "https://api.devnet.solana.com",
  mainnet: process.env.MAINNET_RPC ?? fromEnvFile("mainnet", "MAINNET_RPC") ?? "https://api.mainnet-beta.solana.com",
};

export function clusterArg() {
  const c = process.argv[2];
  if (!c || !(c in RPC)) {
    console.error("usage: node scripts/<script>.mjs <localnet|devnet|mainnet>");
    process.exit(1);
  }
  return c;
}

/// Keys never live in this repository. They are read from SOLHOOKS_SECRETS, or from
/// "sol-secrets" in the home folder of whoever runs the script:
///   <cluster>-deployer.json        the wallet that pays, and holds the upgrade authority
///   program-keys/<program>.json    the program id keypairs (only deploy.sh reads them)
export function secretsDir() {
  return process.env.SOLHOOKS_SECRETS ?? path.join(os.homedir(), "sol-secrets");
}

export function loadKeypair(path) {
  if (!existsSync(path)) throw new Error(`missing keypair ${path}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export function deployer(cluster) {
  return loadKeypair(path.join(secretsDir(), `${cluster}-deployer.json`));
}

export function connection(cluster) {
  return new Connection(RPC[cluster], "confirmed");
}

/// On a public cluster a transaction without a priority fee can expire unprocessed when the
/// network is busy: there every send carries one (PRIORITY_MICROLAMPORTS, from the environment
/// or the cluster's env file, default 100000; about 0.00002 SOL a transaction).
function priorityIxs(conn) {
  if (/127\.0\.0\.1|localhost/.test(conn.rpcEndpoint)) return [];
  const cluster = /devnet/.test(conn.rpcEndpoint) ? "devnet" : "mainnet";
  const price = Number(process.env.PRIORITY_MICROLAMPORTS ?? fromEnvFile(cluster, "PRIORITY_MICROLAMPORTS") ?? 100000);
  return price > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })] : [];
}

export async function send(conn, ixs, signers, label) {
  const tx = new Transaction().add(...priorityIxs(conn), ...ixs);
  tx.feePayer = signers[0].publicKey;
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", maxRetries: 10 });
    console.log(`  ok  ${label}  ${sig}`);
    return sig;
  } catch (e) {
    console.error(`  FAILED ${label}`);
    if (e.logs) console.error(e.logs.join("\n"));
    throw e;
  }
}

export const fmt = (v, dec) => (Number(v) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: 6 });

/// Send something the chain must refuse, and return the logs of the refusal as one text
/// (a program names its error there: "Error Code: TooSoon"). Stops the script when the
/// chain accepts it. The refusal comes from the simulation a send starts with, so nothing
/// lands and no fee is paid.
export async function sendRefused(conn, ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  try { await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" }); }
  catch (e) {
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null);
    console.log(`  refused  ${label}`);
    return (logs ?? [String(e.message)]).join("\n");
  }
  console.error(`CHECK FAILED: the chain accepted what it had to refuse: ${label}`);
  process.exit(1);
}

/// Wait until the chain has reached `slot` (a number or a bigint). Returns the slot it is at.
export async function waitForSlot(conn, slot) {
  for (;;) {
    const now = BigInt(await conn.getSlot("confirmed"));
    if (now >= BigInt(slot)) return now;
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---- address lookup table (written by init-platform, read by the site and the scripts) ----
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
export function altFile(cluster) {
  return fileURLToPath(new URL(`../web/deployments/${cluster}-alt.json`, import.meta.url));
}
export function loadAlt(cluster) {
  const f = altFile(cluster);
  if (!existsSync(f)) return undefined;
  try { return new PublicKey(JSON.parse(readFileSync(f, "utf8")).lookupTable); } catch { return undefined; }
}

/// Send instructions as one v0 transaction compiled with the platform lookup table.
/// Returns the signature, the wire size and the compute used.
export async function sendV0(conn, client, ixs, signers, label) {
  const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(signers[0].publicKey, ixs);
  tx.sign(signers);
  const size = tx.serialize().length;
  try {
    const sig = await conn.sendTransaction(tx, { skipPreflight: false });
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw Object.assign(new Error("transaction failed: " + JSON.stringify(res.value.err)), { sig });
    const got = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    console.log(`  ok  ${label}  (${size} bytes, ${got?.meta?.computeUnitsConsumed ?? "?"} CU)`);
    return sig;
  } catch (e) {
    console.error(`  FAILED ${label} (${size} bytes)`);
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null);
    if (logs) console.error(logs.join("\n"));
    else if (e.sig) { const t = await conn.getTransaction(e.sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); console.error((t?.meta?.logMessages ?? []).join("\n")); }
    throw e;
  }
}
