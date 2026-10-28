// Configuration: watcher/.env (parsed here, no dependency) overridden by the process environment,
// then the command line. Every value has a default and is validated; a bad value stops the start.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WATCHER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_DIR = path.dirname(WATCHER_DIR);

export const CLUSTERS = ["localnet", "devnet", "mainnet"];
const DEFAULT_RPC = { localnet: "http://127.0.0.1:8899", devnet: "https://api.devnet.solana.com", mainnet: "https://api.mainnet-beta.solana.com" };
const KNOWN = ["RPC_URL", "CLUSTER", "INTERVAL_SECONDS", "PROBE_SOL", "PROBE_KEYPAIR", "PORT", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ALERT_COOLDOWN_SECONDS", "STATUS_FILE", "STATE_FILE", "NO_HOOK_SIM_SECONDS", "RPC_TIMEOUT_MS", "REVEAL_INTERVAL_SECONDS", "KEEPER_MIN_LAMPORTS", "SETTLE_INTERVAL_SECONDS", "UPKEEP_INTERVAL_SECONDS", "BURN_KEEPER", "BURN_INTERVAL_SECONDS", "BURN_MAX_CALLS", "BURN_MIN_POT_LAMPORTS", "BURN_SLIPPAGE_BPS", "HOLDER_SYNC", "HOLDER_SYNC_MIN_BPS", "GRADUATE_KEEPER", "GRADUATE_INTERVAL_SECONDS",
  "FEED", "FEED_INTERVAL_SECONDS", "FEED_MAX_TX_PER_PASS", "MARKET_REFRESH_SECONDS", "MINT_REFRESH_SECONDS", "METADATA_REFRESH_SECONDS", "METADATA_TIMEOUT_MS",
  "MARKET_FILE", "TRADES_DIR", "FEED_STATE_FILE", "MARKET_CACHE_FILE", "SIM_MAX_AGE_MINUTES",
  "MINT_CRANK", "MINT_INTERVAL_SECONDS", "MINT_SWEEP_SECONDS", "MINT_PRIORITY_MICROLAMPORTS",
  "TICKET_INDEX_FILE", "TICKET_RECONCILE_SECONDS", "NOTIFY", "NOTIFY_PER_MINUTE", "NOTIFY_GLOBAL_PER_MINUTE", "SETTLE_SWEEP_SECONDS", "LOCK_DIR",
  "APPROVAL_WATCH", "HOOK_ACCOUNTS_WATCH", "HOLDER_SIMS", "HOLDER_SIMS_PER_POOL"];
/// The most a mint_for's priority fee may be, in micro-lamports a compute unit (lib/mint.mjs, MAX_MINT_PRICE_MICROLAMPORTS
/// at a limit of 250,000 units): above it the keeper would pay more for the transaction than the deposit pays it back.
const MAX_MINT_PRICE = 20_000;

/// dotenv-style parsing: KEY=value lines, # comments, optional single or double quotes, a trailing " # comment".
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    const dq = v.length >= 2 && v.startsWith('"') && v.endsWith('"');
    const sq = v.length >= 2 && v.startsWith("'") && v.endsWith("'");
    if (dq || sq) v = v.slice(1, -1);
    else { const h = v.indexOf(" #"); if (h >= 0) v = v.slice(0, h).trim(); }
    out[key] = v;
  }
  return out;
}

export function parseArgs(argv) {
  const a = { once: false, pool: null, verbose: false, help: false, noServer: false, noCrank: false, noSettle: false, noUpkeep: false, noBurn: false, noGraduate: false, noFeed: false, noMint: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--once") a.once = true;
    else if (x === "--pool") { a.pool = argv[++i] ?? null; if (!a.pool) throw new Error("--pool needs an address"); }
    else if (x.startsWith("--pool=")) a.pool = x.slice(7);
    else if (x === "-v" || x === "--verbose") a.verbose = true;
    else if (x === "--no-server") a.noServer = true;
    else if (x === "--no-crank") a.noCrank = true;
    else if (x === "--no-settle") a.noSettle = true;
    else if (x === "--no-upkeep") a.noUpkeep = true;
    else if (x === "--no-burn") a.noBurn = true;
    else if (x === "--no-graduate") a.noGraduate = true;
    else if (x === "--no-feed") a.noFeed = true;
    else if (x === "--no-mint") a.noMint = true;
    else if (x === "-h" || x === "--help") a.help = true;
    else throw new Error(`unknown argument ${x}`);
  }
  if (a.pool) a.verbose = true;
  return a;
}

/// Pure: variables (already merged) plus parsed args to a validated config object.
export function buildConfig(vars, args, baseDir = WATCHER_DIR) {
  const bad = [];
  const pick = (name, dflt) => { const v = vars[name]; return v === undefined || v === "" ? dflt : String(v); };
  const num = (name, dflt, min, max) => {
    const raw = pick(name, String(dflt));
    const v = Number(raw);
    if (!Number.isFinite(v)) { bad.push(`${name}=${raw} is not a number`); return dflt; }
    if (min !== undefined && v < min) { bad.push(`${name}=${v} is below the minimum ${min}`); return dflt; }
    if (max !== undefined && v > max) { bad.push(`${name}=${v} is above the maximum ${max}`); return dflt; }
    return v;
  };
  let cluster = pick("CLUSTER", "localnet").toLowerCase();
  if (cluster === "mainnet-beta") cluster = "mainnet";
  if (!CLUSTERS.includes(cluster)) { bad.push(`CLUSTER=${cluster} must be one of ${CLUSTERS.join(", ")}`); cluster = "localnet"; }
  const probeSol = num("PROBE_SOL", 0.05, 0.000001, 1000);
  // The burn keeper's switch in the settings: on unless it says off. --no-burn and --no-crank turn it off too.
  const burnSwitch = pick("BURN_KEEPER", "on").toLowerCase();
  if (!["on", "off", "1", "0", "true", "false", "yes", "no"].includes(burnSwitch)) bad.push(`BURN_KEEPER=${burnSwitch} must be on or off`);
  const burnOn = ["on", "1", "true", "yes"].includes(burnSwitch);
  // The holder sync of strict coins runs in the burn keeper's pass: on unless it says off, and never without it.
  const syncSwitch = pick("HOLDER_SYNC", "on").toLowerCase();
  if (!["on", "off", "1", "0", "true", "false", "yes", "no"].includes(syncSwitch)) bad.push(`HOLDER_SYNC=${syncSwitch} must be on or off`);
  const syncOn = ["on", "1", "true", "yes"].includes(syncSwitch);
  // The graduate crank's switch (pools on the curve): on unless it says off. --no-graduate and --no-crank turn it
  // off too.
  const graduateSwitch = pick("GRADUATE_KEEPER", "on").toLowerCase();
  if (!["on", "off", "1", "0", "true", "false", "yes", "no"].includes(graduateSwitch)) bad.push(`GRADUATE_KEEPER=${graduateSwitch} must be on or off`);
  const graduateOn = ["on", "1", "true", "yes"].includes(graduateSwitch);
  // The trades feed and market.json: on unless it says off. --no-feed turns it off too. It sends nothing, so
  // --no-crank leaves it on.
  const feedSwitch = pick("FEED", "on").toLowerCase();
  if (!["on", "off", "1", "0", "true", "false", "yes", "no"].includes(feedSwitch)) bad.push(`FEED=${feedSwitch} must be on or off`);
  const feedOn = ["on", "1", "true", "yes"].includes(feedSwitch);
  // The mint crank (collectible coins, one approval): on unless it says off. --no-mint and --no-crank turn it off
  // too.
  const mintSwitch = pick("MINT_CRANK", "on").toLowerCase();
  if (!["on", "off", "1", "0", "true", "false", "yes", "no"].includes(mintSwitch)) bad.push(`MINT_CRANK=${mintSwitch} must be on or off`);
  const mintOn = ["on", "1", "true", "yes"].includes(mintSwitch);
  // POST /notify (the coin page hands the watcher the signature of a buy that paid a deposit, so that the keeper
  // mints right after the buy's block): on unless it says off. Off whenever the mint crank is off.
  const notifySwitch = pick("NOTIFY", "on").toLowerCase();
  if (!["on", "off", "1", "0", "true", "false", "yes", "no"].includes(notifySwitch)) bad.push(`NOTIFY=${notifySwitch} must be on or off`);
  const notifyOn = ["on", "1", "true", "yes"].includes(notifySwitch);
  // The approved list (lib/approvals.mjs) and the hook accounts (lib/hookaccounts.mjs): on unless they say off. Both
  // read nothing of their own: the pool pass reads the platform and the hooks anyway.
  const onOff = (name) => {
    const v = pick(name, "on").toLowerCase();
    if (!["on", "off", "1", "0", "true", "false", "yes", "no"].includes(v)) bad.push(`${name}=${v} must be on or off`);
    return ["on", "1", "true", "yes"].includes(v);
  };
  const approvalWatch = onOff("APPROVAL_WATCH");
  const hookAccountsWatch = onOff("HOOK_ACCOUNTS_WATCH");
  // Sells as recent buyers (lib/holdersells.mjs): the most such simulations one pool pass runs, 0 (or off) for none.
  const holderSimsRaw = pick("HOLDER_SIMS", "30").toLowerCase();
  const holderSims = holderSimsRaw === "off" ? 0 : holderSimsRaw === "on" ? 30 : Math.floor(num("HOLDER_SIMS", 30, 0, 1000));
  const rel =(p) => (path.isAbsolute(p) ? p : path.join(baseDir, p));
  const cfg = {
    rpcUrl: pick("RPC_URL", DEFAULT_RPC[cluster]),
    cluster,
    intervalSeconds: num("INTERVAL_SECONDS", 60, 5, 86400),
    probeSol,
    probeLamports: BigInt(Math.round(probeSol * 1e9)),
    probeKeypair: rel(pick("PROBE_KEYPAIR", "state/probe-keypair.json")),
    port: num("PORT", 8790, 1, 65535),
    telegramToken: pick("TELEGRAM_BOT_TOKEN", ""),
    telegramChatId: pick("TELEGRAM_CHAT_ID", ""),
    alertCooldownSeconds: num("ALERT_COOLDOWN_SECONDS", 3600, 0, 31 * 86400),
    statusFile: rel(pick("STATUS_FILE", "status/pools.json")),
    stateFile: rel(pick("STATE_FILE", "state/state.json")),
    noHookSimSeconds: num("NO_HOOK_SIM_SECONDS", 3600, 60, 7 * 86400),
    rpcTimeoutMs: num("RPC_TIMEOUT_MS", 20000, 1000, 600000),
    // A collectible batch must be revealed within 512 slots (about 3.5 minutes): the crank period stays well under it.
    revealIntervalSeconds: num("REVEAL_INTERVAL_SECONDS", 20, 5, 60),
    keeperMinLamports: BigInt(Math.round(num("KEEPER_MIN_LAMPORTS", 10000000, 0, 1e15))),
    // The settle crank has no deadline to meet: an unbacked piece only waits a little longer for its burn. Its
    // tickets come from the ticket index (read by address), so a short period costs no read of the whole program.
    // With the feed on, a pass reads only the tickets of the wallets the feed saw trade or earn pieces in the last
    // few minutes (an off-site sell is settled within a pass), and every SETTLE_SWEEP_SECONDS all of them (a plain
    // transfer of coins, which no pool transaction shows, is settled within that).
    settleIntervalSeconds: num("SETTLE_INTERVAL_SECONDS", 10, 5, 3600),
    settleSweepSeconds: num("SETTLE_SWEEP_SECONDS", 300, 10, 86400),
    // The upkeep crank (pegged coins) has no deadline either, but a holder looks at its wallet right after a
    // transfer: the default is short, so the piece a wallet shows matches its list within seconds.
    upkeepIntervalSeconds: num("UPKEEP_INTERVAL_SECONDS", 10, 5, 3600),
    // The burn keeper (buyback pools and rules pools). The chain takes a call on a pool at most once every 25
    // slots, about ten seconds, so a shorter period would only find calls that are too soon.
    burnIntervalSeconds: num("BURN_INTERVAL_SECONDS", 30, 5, 3600),
    // The most calls one pass sends, one per pool. More pools than this wait for the next pass.
    burnMaxCalls: Math.floor(num("BURN_MAX_CALLS", 10, 1, 100)),
    // A pot under this is left alone: a call costs the keeper 5,000 lamports and earns it nothing.
    burnMinPotLamports: BigInt(Math.round(num("BURN_MIN_POT_LAMPORTS", 100000, 1, 1e15))),
    // How far under the SDK's quote a buy of the keeper may land before the chain refuses it.
    burnSlippageBps: Math.floor(num("BURN_SLIPPAGE_BPS", 100, 0, 5000)),
    crank: !args.noCrank,
    // --no-crank sends nothing at all, so it turns the settle crank, the upkeep crank and the burn keeper off
    // too. --no-settle, --no-upkeep and --no-burn each turn one off and keep the others.
    settle: !args.noCrank && !args.noSettle,
    upkeep: !args.noCrank && !args.noUpkeep,
    burn: !args.noCrank && !args.noBurn && burnOn,
    // A record of a strict coin is synced when it stands above its wallet's coins by at least this share of all
    // the coins in holder records, in basis points: that is the part of the holders' share it takes wrongly.
    holderSyncMinBps: Math.floor(num("HOLDER_SYNC_MIN_BPS", 10, 0, 10000)),
    holderSync: !args.noCrank && !args.noBurn && burnOn && syncOn,
    // The graduate crank (pools on the curve). A pool past its target trades on the curve until somebody sends
    // graduate, and the SDK sends it inside most trades already: a short period, but no deadline to meet.
    graduateIntervalSeconds: num("GRADUATE_INTERVAL_SECONDS", 15, 5, 3600),
    graduate: !args.noCrank && !args.noGraduate && graduateOn,
    // The mint crank (collectible coins). A buy that paid a deposit has its pieces minted into the wallet by the
    // keeper, paid back from that deposit. The buys reach it from the trades feed (every buy is a transaction of
    // the pool program the feed reads anyway) and from POST /notify (the coin page, right after its buy landed):
    // the crank's own poll of the collectible program (one getSignaturesForAddress) is a safety net, once a
    // minute. While a wallet waits for its pieces the passes come every half second.
    mint: !args.noCrank && !args.noMint && mintOn,
    mintIntervalSeconds: num("MINT_INTERVAL_SECONDS", 60, 1, 3600),
    // Every ticket with pieces waiting and a deposit is looked for this often (the indexed tickets, read by
    // address), to find what the feed and the poll missed (the watcher was down, a deposit sent on its own).
    mintSweepSeconds: num("MINT_SWEEP_SECONDS", 300, 30, 86400),
    // POST /notify: on or off, how many signatures one address may hand in a minute, and how many everybody
    // together. Each one costs at most one share of a getSignatureStatuses and, for a signature the chain knows,
    // its transaction (read at most twice).
    notify: !args.noCrank && !args.noMint && mintOn && notifyOn,
    notifyPerMinute: Math.floor(num("NOTIFY_PER_MINUTE", 3, 1, 600)),
    notifyGlobalPerMinute: Math.floor(num("NOTIFY_GLOBAL_PER_MINUTE", 30, 1, 6000)),
    // The ticket index (lib/tickets.mjs): where it lives (next to the state file unless told otherwise, so a run
    // with its own STATE_FILE keeps its own index), and how often the whole collectible program is listed again
    // (addresses only) to find tickets the feed did not see.
    ticketIndexFile: rel(pick("TICKET_INDEX_FILE", path.join(path.dirname(pick("STATE_FILE", "state/state.json")), "tickets.json"))),
    ticketReconcileSeconds: num("TICKET_RECONCILE_SECONDS", 3600, 600, 86400),
    // A priority fee for the keeper's mints, in micro-lamports a compute unit. 0 by default; at most 20,000, where
    // the network fee (charged on the limit of 250,000 units) reaches the 10,000 lamports a mint pays the keeper.
    mintPriceMicroLamports: Math.floor(num("MINT_PRIORITY_MICROLAMPORTS", 0, 0, MAX_MINT_PRICE)),
    // The trades feed and market.json (lib/feed.mjs, lib/market.mjs). One pass every FEED_INTERVAL_SECONDS: one
    // getSignaturesForAddress on the pool program, the transactions that arrived, the pools again after any.
    // Off with --pool: one pool's run writes no feed.
    feed: !args.noFeed && feedOn && !args.pool,
    feedIntervalSeconds: num("FEED_INTERVAL_SECONDS", 10, 2, 3600),
    feedMaxTxPerPass: Math.floor(num("FEED_MAX_TX_PER_PASS", 200, 10, 5000)),
    // The reconciliation read of every pool (one getProgramAccounts), and the rules locks: the feed reads the
    // pools its transactions touched by address every pass, so this is only a safety net for a pool it missed.
    marketRefreshSeconds: num("MARKET_REFRESH_SECONDS", 1800, 30, 86400),
    // Every coin's mint again (its supply), for burns made outside any pool.
    mintRefreshSeconds: num("MINT_REFRESH_SECONDS", 600, 30, 86400),
    // Every coin's name, symbol and uri again.
    metadataRefreshSeconds: num("METADATA_REFRESH_SECONDS", 21600, 300, 30 * 86400),
    // How long the read of one coin's metadata JSON may take.
    metadataTimeoutMs: num("METADATA_TIMEOUT_MS", 3000, 500, 20000),
    marketFile: rel(pick("MARKET_FILE", "status/market.json")),
    tradesDir: rel(pick("TRADES_DIR", "status/trades")),
    feedStateFile: rel(pick("FEED_STATE_FILE", "state/feed.json")),
    // Where the feed's lock lives (one feed per state file). Empty: next to FEED_STATE_FILE. On a server: the
    // service's runtime folder, /run/programmable-watcher (systemd RuntimeDirectory=), which a reboot empties.
    lockDir: pick("LOCK_DIR", "") ? rel(pick("LOCK_DIR", "")) : null,
    marketCacheFile: rel(pick("MARKET_CACHE_FILE", "state/market-cache.json")),
    // A pool with a hook is simulated again when what the simulations depend on changed, while a launch window
    // runs, and at least this often.
    simMaxAgeMinutes: num("SIM_MAX_AGE_MINUTES", 60, 1, 1440),
    // Each pass compares the platform's approved-list rule and list with the last pass, and says per pool where its
    // hook stands with the list (`hookApproval` in pools.json).
    approvalWatch,
    // Each pass hashes the manifest and the extra-accounts list of every hook program a pool uses, from the bytes the
    // pass read anyway, and alerts on a change.
    hookAccountsWatch,
    // For a pool whose hook runs on sells, when its simulations are due and the sell probe went through: a sell of 1%
    // as up to HOLDER_SIMS_PER_POOL wallets that bought lately and still hold, at most HOLDER_SIMS of them a pass.
    holderSims,
    holderSimsPerPool: Math.floor(num("HOLDER_SIMS_PER_POOL", 3, 1, 10)),
    once: !!args.once,
    pool: args.pool ?? null,
    verbose: !!args.verbose,
    noServer: !!args.noServer || !!args.once,
  };
  if (!/^https?:\/\//.test(cfg.rpcUrl)) bad.push("RPC_URL must start with http:// or https:// (its value is not printed: it may hold a key)");
  if ((cfg.telegramToken && !cfg.telegramChatId) || (!cfg.telegramToken && cfg.telegramChatId)) bad.push("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together");
  if (bad.length) throw new Error("bad configuration:\n  - " + bad.join("\n  - "));
  return cfg;
}

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const envFile = path.join(WATCHER_DIR, ".env");
  const envFileFound = fs.existsSync(envFile);
  const merged = envFileFound ? parseEnv(fs.readFileSync(envFile, "utf8")) : {};
  for (const k of KNOWN) if (env[k] !== undefined && env[k] !== "") merged[k] = env[k];
  return { cfg: buildConfig(merged, args), args, envFileFound };
}

/// The RPC as it may be printed: its scheme and host, never the path or the query, where a paid RPC keeps its key.
export function rpcShown(url) {
  try { const u = new URL(url); const hidden = (u.pathname && u.pathname !== "/") || u.search ? " (path hidden)" : ""; return `${u.protocol}//${u.host}${hidden}`; } catch { return "(not an address)"; }
}

/// What may be printed at startup. Never the Telegram token, never the RPC's path (its key).
export function describeConfig(cfg) {
  return {
    cluster: cfg.cluster,
    rpc: rpcShown(cfg.rpcUrl),
    interval: `${cfg.intervalSeconds} s`,
    probe: `${cfg.probeSol} SOL`,
    probeKeypair: cfg.probeKeypair,
    port: cfg.noServer ? "(no server in this mode)" : String(cfg.port),
    telegram: cfg.telegramToken ? `on (chat ${cfg.telegramChatId})` : "off (stdout only)",
    alertCooldown: `${cfg.alertCooldownSeconds} s`,
    revealCrank: cfg.crank ? `every ${cfg.revealIntervalSeconds} s, keeper minimum ${cfg.keeperMinLamports} lamports` : "off (--no-crank)",
    settleCrank: cfg.settle ? `every ${cfg.settleIntervalSeconds} s` : `off (${cfg.crank ? "--no-settle" : "--no-crank"})`,
    ...(cfg.settle ? { settleSweep: cfg.feed ? `each pass the wallets the feed saw trade or earn pieces in the last 5 minutes, every ${cfg.settleSweepSeconds} s every indexed ticket` : "every indexed ticket each pass (the feed is off)" } : {}),
    upkeepCrank: cfg.upkeep ? `every ${cfg.upkeepIntervalSeconds} s` : `off (${cfg.crank ? "--no-upkeep" : "--no-crank"})`,
    holderSync: cfg.holderSync ? `in the burn keeper's pass, records above their wallet's coins by ${cfg.holderSyncMinBps} bps of the registered coins or more` : "off",
    burnKeeper: cfg.burn ?`every ${cfg.burnIntervalSeconds} s, at most ${cfg.burnMaxCalls} calls a pass, pots of ${cfg.burnMinPotLamports} lamports and more, slippage ${cfg.burnSlippageBps} bps` : `off (${cfg.crank ? "--no-burn or BURN_KEEPER=off" : "--no-crank"})`,
    mintCrank: cfg.mint ? `the buys from the feed${cfg.notify ? ` and from POST /notify (${cfg.notifyPerMinute} a minute per address, ${cfg.notifyGlobalPerMinute} a minute in all)` : ""},its own poll every ${cfg.mintIntervalSeconds} s (every 0.5 s while a wallet waits for its pieces), the indexed tickets read every ${cfg.mintSweepSeconds} s, priority fee ${cfg.mintPriceMicroLamports} micro-lamports a unit` : `off (${cfg.crank ? "--no-mint or MINT_CRANK=off" : "--no-crank"})`,
    ticketIndex: `${cfg.ticketIndexFile}, the whole collectible program listed again every ${cfg.ticketReconcileSeconds} s`,
    graduateCrank: cfg.graduate ? `every ${cfg.graduateIntervalSeconds} s, for every pool on the curve that stands at or past its graduation target` : `off (${cfg.crank ? "--no-graduate or GRADUATE_KEEPER=off" : "--no-crank"})`,
    feed: cfg.feed ? `every ${cfg.feedIntervalSeconds} s, at most ${cfg.feedMaxTxPerPass} transactions a pass, the pools its transactions touched read again by address, every pool at least every ${cfg.marketRefreshSeconds} s` : `off (${cfg.pool ? "--pool" : "--no-feed or FEED=off"})`,
    simulations: `on a change, while a launch window runs, and at least every ${cfg.simMaxAgeMinutes} minutes`,
    approvedList: cfg.approvalWatch ? "each pass: the rule and the list compared with the last pass, hookApproval per pool" : "off (APPROVAL_WATCH=off)",
    hookAccounts: cfg.hookAccountsWatch ? "each pass: the manifest and the extra-accounts list of every hook program hashed and compared" : "off (HOOK_ACCOUNTS_WATCH=off)",
    holderSells: cfg.holderSims > 0 ? `when a hook that runs on sells is simulated: a sell as up to ${cfg.holderSimsPerPool} recent buyers who still hold, at most ${cfg.holderSims} a pass` : "off (HOLDER_SIMS=0)",
    statusFile: cfg.statusFile,
    stateFile: cfg.stateFile,
    ...(cfg.feed ? { marketFile: cfg.marketFile, tradesDir: cfg.tradesDir, lockDir: cfg.lockDir ?? "(next to the feed's state file)" } : {}),
  };
}
