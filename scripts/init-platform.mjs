// One-time platform setup after deploy.sh: platform account, whitelist, template manifests.
// Idempotent: skips whatever already exists.
//   node scripts/init-platform.mjs <localnet|devnet|mainnet>
// Mainnet: set TREASURY=<address only> and the caps you want via env (see below).
//
// The curve (a launch that needs no SOL from the creator): `init_platform` writes the
// program's defaults, 30 virtual SOL and graduation at 85 real SOL with no fee. The script
// prints what the platform holds. To change them it sends `update_platform` (admin only)
// when one of these is set:
//   CURVE_VIRTUAL_SOL=30     virtual SOL counted in the price while a pool is on the curve (0 switches curve launches off)
//   CURVE_TARGET_SOL=85      real SOL in the pool at which anyone may graduate it (0 switches curve launches off)
//   CURVE_FEE_BPS=0          share of the target the platform takes at graduation, at most 1000 (10%)
// A change reaches pools created afterwards; a pool on the curve keeps the settings it was
// created with.
import { PublicKey } from "@solana/web3.js";
import { HookpoolClient, ix, pda, PROGRAMS } from "../sdk/dist/index.js";
import { clusterArg, connection, deployer, send } from "./cluster.mjs";

const cluster = clusterArg();
const conn = connection(cluster);
const admin = deployer(cluster);
const client = new HookpoolClient(conn);

const treasury = process.env.TREASURY ? new PublicKey(process.env.TREASURY) : admin.publicKey;
const args = {
  treasury,
  protocolFeeBps: Number(process.env.PROTOCOL_FEE_BPS ?? 20),
  maxLpFeeBps: Number(process.env.MAX_LP_FEE_BPS ?? 1000),
  maxHookFeeBps: Number(process.env.MAX_HOOK_FEE_BPS ?? 1000),
  maxFeeOverrideBps: Number(process.env.MAX_FEE_OVERRIDE_BPS ?? 5000),
  launchFeeLamports: BigInt(process.env.LAUNCH_FEE_LAMPORTS ?? 10_000_000),
};
const uriBase = process.env.HOOK_URI_BASE ?? "https://programmable.market/hooks";

console.log(`cluster ${cluster}, admin ${admin.publicKey.toBase58()}, treasury ${treasury.toBase58()}`);
if (cluster === "mainnet" && !process.env.TREASURY) {
  console.error("mainnet needs TREASURY=<wallet address> in the environment");
  process.exit(1);
}

let platform = await client.platform();
if (!platform) {
  await send(conn, [ix.initPlatform(admin.publicKey, args)], [admin], "init_platform");
  platform = await client.platform();
} else console.log("  platform already initialised");
console.log(`  protocol fee ${platform.protocolFeeBps} bps, launch fee ${platform.launchFeeLamports} lamports, paused ${platform.paused}`);
const sol = (v) => (Number(v) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });
const curveLine = (p) => `curve: virtual ${sol(p.curveVirtualQuote)} SOL, graduation at ${sol(p.curveGraduationTarget)} real SOL, fee ${p.curveGraduationFeeBps} bps (${p.curveEnabled ? "curve launches on" : "curve launches OFF"})`;
console.log("  " + curveLine(platform));
{
  // the curve settings asked for in the environment, applied only where they differ
  const wanted = {};
  if (process.env.CURVE_VIRTUAL_SOL !== undefined) wanted.curveVirtualQuote = BigInt(Math.round(Number(process.env.CURVE_VIRTUAL_SOL) * 1e9));
  if (process.env.CURVE_TARGET_SOL !== undefined) wanted.curveGraduationTarget = BigInt(Math.round(Number(process.env.CURVE_TARGET_SOL) * 1e9));
  if (process.env.CURVE_FEE_BPS !== undefined) wanted.curveGraduationFeeBps = Number(process.env.CURVE_FEE_BPS);
  if (Object.keys(wanted).length) {
    if (!platform.admin.equals(admin.publicKey)) { console.error(`  the curve settings can only be changed by the platform admin ${platform.admin.toBase58()}`); process.exit(1); }
    const update = await client.platformUpdate(admin.publicKey, wanted);
    if (update.instructions.length === 0) console.log("  curve settings already as asked");
    else {
      await send(conn, update.instructions, [admin], `update_platform (${update.changes.join("; ")})`);
      platform = await client.platform();
      console.log("  " + curveLine(platform));
    }
  }
}

if (!platform.whitelist.some((k) => k.equals(admin.publicKey))) {
  await send(conn, [ix.setWhitelist(admin.publicKey, [admin.publicKey])], [admin], "set_whitelist [admin]");
} else console.log("  admin already whitelisted");

// The platform's template hooks. Each publishes its manifest once.
const TEMPLATES = ["hook_tax", "hook_launch_guard", "hook_buyback", "hook_collectible", "hook_rules"];
for (const name of TEMPLATES) {
  const m = await conn.getAccountInfo(pda.manifest(PROGRAMS[name]));
  if (m) { console.log(`  ${name} manifest already published`); continue; }
  await send(conn, [ix.initManifest(name, admin.publicKey, `${uriBase}/${name}`)], [admin], `init_manifest ${name}`);
}
// ---- address lookup table: every fixed address the platform's transactions use --------
// One byte per address instead of 32. Stored next to the deployment file for the site.
const { AddressLookupTableProgram } = await import("@solana/web3.js");
const { writeFileSync } = await import("node:fs");
const { altFile, loadAlt } = await import("./cluster.mjs");
const sdk = await import("../sdk/dist/index.js");
const fixed = [
  ...Object.values(PROGRAMS),
  sdk.TOKEN_PROGRAM, sdk.TOKEN_2022_PROGRAM, sdk.ATA_PROGRAM, sdk.SYSTEM_PROGRAM, sdk.RENT_SYSVAR, sdk.METAPLEX_METADATA, sdk.MPL_CORE,
  sdk.NATIVE_MINT, new PublicKey("ComputeBudget111111111111111111111111111111"),
  pda.platform(),
  // The address the pool signs a hook's callbacks with is one per hook program: the one of
  // the system program (a pool without a hook) and the one of each template. A swap, a
  // launch and a liquidity change name exactly one of them.
  pda.caller(sdk.SYSTEM_PROGRAM)[0], ...TEMPLATES.map((n) => pda.caller(PROGRAMS[n])[0]),
  // event CPI: the pool and the launchpad on every trade and launch, the buyback and the
  // burn of a rules coin on every run
  pda.eventAuthority(PROGRAMS.hookpool), pda.eventAuthority(PROGRAMS.hooklaunch), pda.eventAuthority(PROGRAMS.hook_buyback), pda.eventAuthority(PROGRAMS.hook_rules),
  ...TEMPLATES.flatMap((n) => [pda.manifest(PROGRAMS[n]), pda.extraMetas(PROGRAMS[n]), pda.programData(PROGRAMS[n])]),
  platform.treasury,
];
const want = [...new Map(fixed.map((k) => [k.toBase58(), k])).values()];
let alt = loadAlt(cluster);
let table = alt ? (await conn.getAddressLookupTable(alt)).value : null;
if (!table) {
  const recentSlot = await conn.getSlot("finalized");
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey, recentSlot });
  await send(conn, [createIx], [admin], "create lookup table");
  alt = address;
  table = { state: { addresses: [] } };
}
const have = new Set(table.state.addresses.map((k) => k.toBase58()));
const missing = want.filter((k) => !have.has(k.toBase58()));
for (let i = 0; i < missing.length; i += 20) {
  const ixExt = AddressLookupTableProgram.extendLookupTable({ payer: admin.publicKey, authority: admin.publicKey, lookupTable: alt, addresses: missing.slice(i, i + 20) });
  await send(conn, [ixExt], [admin], `extend lookup table (+${Math.min(20, missing.length - i)})`);
}
writeFileSync(altFile(cluster), JSON.stringify({ cluster, lookupTable: alt.toBase58(), addresses: want.length }, null, 2) + "\n");
console.log(`  lookup table ${alt.toBase58()} holds ${want.length} addresses`);
console.log("done");
