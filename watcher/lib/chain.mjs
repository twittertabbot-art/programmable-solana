// Batched reads. One getMultipleAccountsInfo per hundred accounts instead of three getAccountInfo per pool.
import { PROGRAMS, TOKEN_2022_PROGRAM, pda, decodeHookManifest, decodeUpgradeAuthority, decodeTaxConfig, decodeGuardConfig, decodeBuybackConfig, decodeRulesConfig, decodeMetaplexMetadata, decodeToken2022Metadata, decodePool, describeFlags, collectible } from "../../sdk/dist/index.js";

const safe = (f) => { try { return f(); } catch { return null; } };

/// The platform's template a hook program is, or "custom" for a program the platform did not write.
export function templateOf(program) {
  if (program.equals(PROGRAMS.hook_tax)) return "tax";
  if (program.equals(PROGRAMS.hook_launch_guard)) return "launch_guard";
  if (program.equals(PROGRAMS.hook_buyback)) return "buyback";
  if (PROGRAMS.hook_collectible && program.equals(PROGRAMS.hook_collectible)) return "collectible";
  if (PROGRAMS.hook_rules && program.equals(PROGRAMS.hook_rules)) return "rules";
  return "custom";
}

/// AccountInfo | null for every key, in order, plus the slot of the first chunk (`slot`) and of every chunk
/// (`slots`: the answer for keys[i] is as of slots[Math.floor(i / chunk)]). `config` goes to every call as it is
/// (`{ minContextSlot }`: a node behind that slot answers JSON-RPC error -32016 instead of an older state); without
/// it each call carries the keys alone.
export async function getMany(connection, keys, chunk = 100, config = undefined) {
  const infos = [];
  const slots = [];
  let slot = null;
  for (let i = 0; i < keys.length; i += chunk) {
    const part = keys.slice(i, i + chunk);
    const res = config === undefined ? await connection.getMultipleAccountsInfoAndContext(part) : await connection.getMultipleAccountsInfoAndContext(part, config);
    const s = res && res.context ? res.context.slot : null;
    if (slot === null) slot = s;
    slots.push(s);
    infos.push(...res.value);
  }
  return { infos, slot, slots };
}

/// JSON-RPC error -32016: the node has not reached the minimum context slot the call asked for (it lags behind the
/// node that served the transactions). Not a failure of the call as such: the read is tried again at the next pass.
export function isMinSlotNotReached(e) {
  return !!e && (e.code === -32016 || /minimum context slot/i.test(String(e.message ?? e)));
}

export function decodeHook(pool, manifestInfo, programDataInfo, cfgInfo, extraMetasInfo) {
  const program = pool.hookProgram;
  const template = templateOf(program);
  const manifestBytes = manifestInfo ? new Uint8Array(manifestInfo.data) : null;
  const cfgBytes = cfgInfo ? new Uint8Array(cfgInfo.data) : null;
  const manifest = manifestBytes ? safe(() => decodeHookManifest(manifestBytes)) : null;
  // null = frozen (no authority). "unknown" = no loader-v3 ProgramData (another loader, or unreadable).
  let upgradeAuthority = "unknown";
  // The slot the program was last deployed in (bytes 4 to 11 of a loader-v3 ProgramData): an upgrade of the hook
  // program changes it, and the pool pass then simulates its pools again (lib/schedule.mjs).
  let deploySlot = null;
  if (programDataInfo) {
    try { upgradeAuthority = decodeUpgradeAuthority(new Uint8Array(programDataInfo.data)); } catch { upgradeAuthority = "unknown"; }
    const d = programDataInfo.data;
    if (d && d.length >= 12) deploySlot = Buffer.from(d.subarray ? d.subarray(4, 12) : d.slice(4, 12)).readBigUInt64LE(0).toString();
  }
  const info = {
    program, kind: pool.hookKind, flags: pool.hookFlags, manifest, manifestBytes, cfgBytes,
    extraMetasBytes: extraMetasInfo ? new Uint8Array(extraMetasInfo.data) : null,
    template, upgradeAuthority, deploySlot, summary: describeFlags(pool.hookFlags),
  };
  if (cfgBytes) {
    if (template === "tax") info.tax = safe(() => decodeTaxConfig(cfgBytes)) ?? undefined;
    if (template === "launch_guard") info.guard = safe(() => decodeGuardConfig(cfgBytes)) ?? undefined;
    if (template === "buyback") info.buyback = safe(() => decodeBuybackConfig(cfgBytes)) ?? undefined;
    if (template === "collectible") info.collectible = safe(() => collectible.decodeCollectionConfig(cfgBytes)) ?? undefined;
    if (template === "rules") info.rules = safe(() => decodeRulesConfig(cfgBytes)) ?? undefined;
  }
  return info;
}

/// For every pool with a hook: manifest, program data, per-pool config and extra-metas, in a few RPC calls. Pools
/// of the same hook program share its manifest, program data and account list: each account is asked for once,
/// so thirty pools of one template cost about thirty accounts, not a hundred and twenty.
export async function readHooks(connection, pools) {
  const hooked = pools.filter((p) => p.hasHook);
  const unique = new Map();
  const want = (k) => { const id = k.toBase58(); if (!unique.has(id)) unique.set(id, { key: k, at: unique.size }); return unique.get(id).at; };
  const slotsOf = hooked.map((p) => [want(pda.manifest(p.hookProgram)), want(pda.programData(p.hookProgram)), want(pda.cfg(p.hookProgram, p.address)), want(p.hookExtraMetas)]);
  const keys = [...unique.values()].map((u) => u.key);
  const { infos, slot } = keys.length ? await getMany(connection, keys) : { infos: [], slot: null };
  const hooks = new Map();
  hooked.forEach((p, i) => {
    const [m, pdI, c, em] = slotsOf[i].map((at) => infos[at] ?? null);
    hooks.set(p.address.toBase58(), decodeHook(p, m, pdI, c, em));
  });
  return { hooks, slot };
}

/// Name and symbol of a coin, the rule of the SDK's client.metadata: the Metaplex metadata account when there is
/// one. Otherwise, for a Token-2022 mint, the metadata the mint carries in itself. A pegged coin keeps its name
/// there: Metaplex refuses mints with a transfer hook. null when neither can be read.
export function metadataOf(mint, metadataInfo, mintInfo) {
  if (metadataInfo) {
    const md = safe(() => decodeMetaplexMetadata(new Uint8Array(metadataInfo.data)));
    if (md) return md;
  }
  if (mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM)) return safe(() => decodeToken2022Metadata(mint, new Uint8Array(mintInfo.data)));
  return null;
}

/// For every mint: its metadata (name, symbol; null where unreadable) and the mint account itself (null when it
/// does not exist). Two accounts per mint in the same batched read: the Metaplex metadata account and the mint.
/// The mint account also says what kind of coin it is (lib/coin.mjs).
export async function readCoins(connection, mints) {
  const unique = [...new Map(mints.map((m) => [m.toBase58(), m])).values()];
  const keys = unique.flatMap((m) => [pda.metadata(m), m]);
  const { infos } = keys.length ? await getMany(connection, keys) : { infos: [] };
  const metas = new Map();
  const mintInfos = new Map();
  unique.forEach((m, i) => {
    const metadataInfo = infos[i * 2] ?? null; const mintInfo = infos[i * 2 + 1] ?? null;
    metas.set(m.toBase58(), metadataOf(m, metadataInfo, mintInfo));
    mintInfos.set(m.toBase58(), mintInfo);
  });
  return { metas, mints: mintInfos };
}

/// Name and symbol for every mint, null where unreadable. Pegged coins included.
export async function readMetadata(connection, mints) {
  return (await readCoins(connection, mints)).metas;
}

/// Fresh copies of pools, by address, to see whether reserves moved during a check.
export async function readPools(connection, addresses) {
  const { infos } = addresses.length ? await getMany(connection, addresses) : { infos: [] };
  const out = new Map();
  addresses.forEach((a, i) => { const info = infos[i]; out.set(a.toBase58(), info ? safe(() => decodePool(a, new Uint8Array(info.data))) : null); });
  return out;
}
