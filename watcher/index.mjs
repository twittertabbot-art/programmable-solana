#!/usr/bin/env node
// Programmable watcher. Start here.
//
//   node index.mjs                            loop every INTERVAL_SECONDS, serve GET /pools.json and GET /health,
//                                             run the trades feed every FEED_INTERVAL_SECONDS (GET /market.json,
//                                             GET /trades/<pool>.json), the reveal crank every REVEAL_INTERVAL_SECONDS, the settle
//                                             crank every SETTLE_INTERVAL_SECONDS, the upkeep crank every
//                                             UPKEEP_INTERVAL_SECONDS, the burn keeper every
//                                             BURN_INTERVAL_SECONDS, the graduate crank every
//                                             GRADUATE_INTERVAL_SECONDS and the mint crank every
//                                             MINT_INTERVAL_SECONDS
//   node index.mjs --once                     one reveal pass, one settle pass, one upkeep pass, one burn pass,
//                                             one graduate pass, one mint round, one pool pass, summary table,
//                                             exit 0 on success
//   node index.mjs --pool <address> --once    one pool, verbose, the full status entry printed
//   node index.mjs --no-crank                 never send a transaction (report only)
//   node index.mjs --no-settle                never send a settle, keep the other cranks
//   node index.mjs --no-upkeep                never send a deliver or a reap, keep the other cranks
//   node index.mjs --no-burn                  never run a buyback or a burn, keep the other cranks
//   node index.mjs --no-graduate              never send a graduate, keep the other cranks
//   node index.mjs --no-feed                  no trades feed and no market.json
//   node index.mjs --no-mint                  never send a mint_for, keep the other cranks
//
// Configuration: watcher/.env (copy .env.example). README.md has the server setup.
// Every trade the watcher makes is a simulation. The only transactions it ever sends are permissionless ones,
// signed and paid by the probe wallet acting as keeper: `reveal`, `settle`, `deliver` and `reap` of the
// collectible template (lib/crank.mjs), `mint_for` of the same template for a buy that paid a deposit
// (lib/mint.mjs), `execute_buyback` and `run_burn` of the buyback and rules templates (lib/burn.mjs), and
// `graduate` of a pool on the curve that stands past its graduation target (lib/curve.mjs). A settle and a
// reap pay the rent of what they burn back to that wallet. A mint_for pays it back what it spent, out of the
// buyer's deposit, plus 10,000 lamports. A buyback or a burn spends the pool's own pot on the pool's own coin
// and pays the keeper nothing; a graduate neither.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  HookpoolClient, DIRECTION, HOOK_KIND, NATIVE_MINT, NO_HOOK, CLOCK_SYSVAR, RULES_KIND, PROGRAMS, guardFee, describeRules, rulesBuyLimit, rulesSniperFee, rulesStakersEligible, rulesPda, decodeHolderRecord,
  strictWindows, strictMaxWalletRuns, strictEarlyWindowRuns, strictEarlyLocked, CURVE_OPEN,
} from "../sdk/dist/index.js";
import { curveEntry, curveNotes, supplyOf, readyToGraduate, planGraduates, graduateAll, sendGraduateTx, readGraduateEffect, graduateLine, graduatedMessage, graduateStrikes, graduateStuckMessage, addGraduateTotals, addGraduatePoolStats, NO_GRADUATE_TOTALS, GRADUATES_PER_PASS } from "./lib/curve.mjs";
import { loadConfig, describeConfig, REPO_DIR } from "./lib/config.mjs";
import { log, setVerbose } from "./lib/log.mjs";
import { loadState, saveState, emptyPoolState, trimList } from "./lib/state.mjs";
import { createNotifier } from "./lib/telegram.mjs";
import { readHooks, readCoins, templateOf } from "./lib/chain.mjs";
import { coinFacts, coinStatus } from "./lib/coin.mjs";
import { simulateProbes, impliedTaxBps, declaredMismatchBps, platformCapBps, isPeggedPool, TOLERANCE_BPS } from "./lib/simulate.mjs";
import { plainError, hostOf } from "./lib/plain.mjs";
import { burnKind, burnPot, burnView, planBurns, burnAll, burnLine, burnSkipLine, burnStrikes, burnStuckMessage, addBurnTotals, addBurnPoolStats, readBurnCandidates, readBuybackTreasuries, sendBurnTx, readBurnEffect, NO_BURN_TOTALS, readHolderExcess, syncAll, sendSyncTx, readSyncEffect, syncLine, NO_SYNC_TOTALS, SYNCS_PER_PASS } from "./lib/burn.mjs";
import { diffHookConfig, diffManifest, upgradeAuthorityAlerts, ceilingAlerts, decodeConfigFields, platformSnapshot, diffPlatform, uriHost } from "./lib/diff.mjs";
import { scorePool, recentLevels, callsOnSell, capRuleApplies, RECENT_MS } from "./lib/score.mjs";
import { buildStatus, writeStatusAtomic, readStatus, summaryTable, jsonReplacer } from "./lib/status.mjs";
import { startServer } from "./lib/server.mjs";
import { readTickets, ticketsToReveal, anyWaiting, revealAll, sendRevealTx, summarizeTickets, diffBatches, expiredMessage, keeperBalanceAlert, canPayReveal, describeOutcome, confirmByPolling, NO_TICKETS } from "./lib/crank.mjs";
import { readUnbacked, planSettles, settleAll, sendSettleTx, readSettleEffect, settleLine, settleStrikes, settleStuckMessage, addSettleTotals, NO_SETTLE_TOTALS } from "./lib/crank.mjs";
import { readUpkeep, waitingAssets, upkeepRound, planUpkeep, upkeepAll, sendUpkeepTx, readUpkeepEffect, upkeepLine, triedKeys, upkeepTried, upkeepStuckMessage, addUpkeepTotals, NO_UPKEEP_TOTALS } from "./lib/crank.mjs";
import { MintCrank, addMintTotals, MINT_FAST_MS, NO_MINT_TOTALS } from "./lib/mint.mjs";
import { PoolCache } from "./lib/pools.mjs";
import { TicketIndex, RECONCILE_ALERT_FAILURES } from "./lib/tickets.mjs";
import { TradesFeed, tradersOf, acquireFeedLock } from "./lib/feed.mjs";
import { Market } from "./lib/market.mjs";
import { simKey, windowRuns, simulationDue, simToJson, simFromJson, keptNote, quietSkip, quietAfter } from "./lib/schedule.mjs";
import { approvalSnapshot, diffApprovals, nextSnapshot, approvalAlerts, poolsByHook, hookApprovalOf } from "./lib/approvals.mjs";
import { hookAccountsOf, trackHookAccounts, hookAccountAlert } from "./lib/hookaccounts.mjs";
import { checkHolderSells, holderSellsAlert, holderSellsNote } from "./lib/holdersells.mjs";

const KIND_LABEL = { [HOOK_KIND.NONE]: "none", [HOOK_KIND.FROZEN]: "frozen", [HOOK_KIND.PLATFORM]: "platform" };
const STATUS_KEEP = 50;
const HELP = [
  "Programmable watcher",
  "",
  "  node index.mjs                           loop, serve /pools.json, /market.json, /trades/<pool>.json and /health",
  "  node index.mjs --once                    one reveal pass, one settle pass, one upkeep pass, one burn pass, one graduate pass, one mint round, one pool pass, summary table, exit 0 on success",
  "  node index.mjs --pool <address> --once   one pool, verbose (the settle, upkeep, burn, graduate and mint passes look at that pool only)",
  "  --no-crank                               never send a transaction: no reveal, no settle, no deliver, no reap, no buyback, no burn, no graduate, no mint (report only)",
  "  --no-mint                                never send a mint_for for a buy that paid a deposit, keep the other cranks (the same as MINT_CRANK=off)",
  "  --no-settle                              never send a collectible settle, keep the other cranks",
  "  --no-upkeep                              never send a deliver or a reap for pegged coins, keep the other cranks",
  "  --no-burn                                never run a buyback or a burn, keep the other cranks (the same as BURN_KEEPER=off)",
  "  --no-graduate                            never send a graduate for a pool on the curve, keep the other cranks (the same as GRADUATE_KEEPER=off)",
  "  --no-feed                                write and serve no market.json and no trades/<pool>.json (the same as FEED=off)",
  "  --no-server                              do not serve HTTP",
  "  -v                                       more detail in the log",
  "",
  "Configuration: watcher/.env (copy .env.example). Read watcher/README.md first.",
].join("\n");

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});
const errMsg = (e) => (e && e.message ? e.message : String(e));
const pcs = (n) => (n === 1 ? "1 piece" : `${n} pieces`);
const simToState = (x) => (x ? { ok: x.ok, error: x.error ?? null, amountOut: x.amountOut === null || x.amountOut === undefined ? null : x.amountOut.toString(), stage: x.stage ?? null, holder: x.holder ?? null } : null);
const simFromState = (x) => (x ? { ...x, amountOut: x.amountOut === null ? null : BigInt(x.amountOut) } : null);

function loadOrCreateProbe(file) {
  if (fs.existsSync(file)) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
    return { keypair: kp, publicKey: kp.publicKey, created: false };
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return { keypair: kp, publicKey: kp.publicKey, created: true };
}

/// web/deployments/<cluster>-alt.json, written by init-platform. Absent on a server that only carries watcher/.
function loadLookupTable(cluster) {
  try {
    const file = path.join(REPO_DIR, "web", "deployments", `${cluster}-alt.json`);
    if (!fs.existsSync(file)) return null;
    return new PublicKey(JSON.parse(fs.readFileSync(file, "utf8")).lookupTable);
  } catch { return null; }
}

/// The strict part of a rules coin for the status file: the four numbers fixed at launch, the max wallet in raw
/// units, and where each window stands at `at` (a slot, or null when unknown).
function strictDeclared(r, at) {
  const w = strictWindows(r);
  const s = (v) => (v === 0n ? null : v.toString());
  return {
    maxWalletBps: r.maxWalletBps, maxWalletSlots: r.maxWalletSlots, maxWalletAmount: r.maxWalletAmount.toString(), earlySlots: r.earlySlots, earlyUnlockSlots: r.earlyUnlockSlots,
    maxWalletEndsAtSlot: s(w.maxWalletUntil), earlyEndsAtSlot: s(w.earlyUntil), earlyUnlockSlot: s(w.earlyUnlock),
    maxWalletActive: at !== null && strictMaxWalletRuns(r, at), earlyActive: at !== null && strictEarlyWindowRuns(r, at), earlyLockActive: at !== null && strictEarlyLocked(r, at),
    registered: r.totalStaked.toString(), minRegistered: r.minEligible.toString(),
  };
}

/// The template's own numbers, for the site. null when there is nothing declared.
function declaredOf(hook, pool, slot) {
  if (hook.template === "tax") {
    const t = hook.tax;
    return t ? { buyBps: t.buyBps, sellBps: t.sellBps, maxBps: t.maxBps, owner: t.owner.toBase58(), renounced: t.renounced } : null;
  }
  if (hook.template === "launch_guard") {
    const g = hook.guard;
    if (!g) return null;
    const fee = slot ? guardFee(BigInt(slot), g.startSlot, g.guardSlots, g.startFeeBps, pool.lpFeeBps) : null;
    return {
      startSlot: g.startSlot.toString(), guardSlots: g.guardSlots.toString(), startFeeBps: g.startFeeBps,
      armed: g.startSlot !== 0n, active: fee !== null, currentBuyFeeBps: fee ?? pool.lpFeeBps,
      endsAtSlot: g.startSlot === 0n ? null : (g.startSlot + g.guardSlots).toString(),
    };
  }
  if (hook.template === "buyback") {
    const b = hook.buyback;
    // The counters and the observation of the pool (the slot a buyback last recorded it in, and the two
    // reserves) are running numbers: they are shown here and never diffed as configuration.
    return b ? {
      buyBps: b.buyBps, sellBps: b.sellBps, minQuote: b.minQuote.toString(), treasury: b.treasury.toBase58(), creator: b.creator.toBase58(),
      totalQuoteSpent: b.totalQuoteSpent.toString(), totalBaseBurned: b.totalBaseBurned.toString(), buybacks: b.buybacks.toString(),
      obsSlot: b.obsSlot.toString(), obsReserveBase: b.obsReserveBase.toString(), obsReserveQuote: b.obsReserveQuote.toString(),
    } : null;
  }
  if (hook.template === "rules") {
    const r = hook.rules;
    if (!r) return null;
    // The rules are fixed at launch. The numbers after them are as stored, which is one trade behind: the fee
    // of the last trade is split the next time the program runs for the pool. `burnPot` in the pool's `burn`
    // entry is the pot with that fee counted in.
    const at = slot ? BigInt(slot) : null;
    const sniper = at === null ? null : rulesSniperFee(at, r.startSlot, r.sniperSlots, r.sniperStartFeeBps, pool.lpFeeBps);
    const limit = at === null ? null : rulesBuyLimit(r, at);
    return {
      buy: { ...r.buy }, sell: { ...r.sell },
      sniperSlots: r.sniperSlots.toString(), sniperStartFeeBps: r.sniperStartFeeBps, sniperActive: sniper !== null, currentBuyFeeBps: sniper ?? pool.lpFeeBps,
      sniperEndsAtSlot: r.sniperSlots === 0n ? null : (r.startSlot + r.sniperSlots).toString(),
      maxBuyQuote: r.maxBuyQuote.toString(), limitSlots: r.limitSlots.toString(), buyLimitActive: limit !== null,
      buyLimitEndsAtSlot: r.maxBuyQuote === 0n ? null : (r.startSlot + r.limitSlots).toString(),
      creatorLockSeconds: r.creatorLockSeconds.toString(), creator: r.creator.toBase58(), treasury: r.treasury.toBase58(),
      startSlot: r.startSlot.toString(), startTime: r.startTime.toString(), minEligible: r.minEligible.toString(),
      totalStaked: r.totalStaked.toString(), stakersEligible: rulesStakersEligible(r),
      creatorOwed: r.creatorOwed.toString(), burnPot: r.burnPot.toString(), rewardsOwedTotal: r.rewardsOwedTotal.toString(),
      totalCreatorPaid: r.totalCreatorPaid.toString(), totalRewardsPaid: r.totalRewardsPaid.toString(), totalQuoteBurned: r.totalQuoteBurned.toString(),
      totalBaseBurned: r.totalBaseBurned.toString(), burns: r.burns.toString(),
      obsSlot: r.obsSlot.toString(), obsReserveBase: r.obsReserveBase.toString(), obsReserveQuote: r.obsReserveQuote.toString(),
      // a strict coin: its rules run inside every transfer. `totalStaked` is then what the holder records count.
      kind: r.kind === RULES_KIND.STRICT ? "strict" : "plain",
      strict: r.kind === RULES_KIND.STRICT ? strictDeclared(r, at) : null,
    };
  }
  if (hook.template === "collectible") {
    const c = hook.collectible;
    return c ? { name: c.name, unit: c.unit.toString(), maxSupply: c.maxSupply, minted: c.minted, live: c.live, reservedPending: c.reservedPending, maxPerBuy: c.maxPerBuy, artVersion: c.artVersion, owner: c.owner.toBase58(), locked: c.locked, pegged: c.pegged } : null;
  }
  const m = hook.manifest;
  const ua = hook.upgradeAuthority === "unknown" ? "unknown" : hook.upgradeAuthority ? hook.upgradeAuthority.toBase58() : null;
  return { name: m ? m.name : null, uri: m ? m.uri : null, admin: m && m.admin ? m.admin.toBase58() : null, manifestFlags: m ? m.flags : null, poolFlags: hook.flags, upgradeAuthority: ua, program: hook.program.toBase58() };
}

/// How old the shared list of pools may be for each loop (lib/pools.mjs). With the feed on it is never older than
/// one feed pass, so these only matter with the feed off. The pool pass and the graduate crank look at reserves;
/// the settle, upkeep and burn cranks only at which template a pool runs, which never changes.
const POOLS_MAX_AGE_MS = { pass: 15_000, graduate: 15_000, settle: 60_000, upkeep: 60_000, burn: 60_000, reveal: 60_000, mint: 60_000 };
/// The upkeep crank takes the collectible program's newest signature from the mint crank's last look when it is
/// at most this old, instead of asking the RPC itself.
const MINT_HEAD_MAX_AGE_MS = 15_000;
/// The newest signature of a program that has none in the node's history.
const NO_SIGNATURE = "(none)";
/// The keeper's balance is read again after this long, or at once after a crank sent a transaction.
const KEEPER_BALANCE_TTL_MS = 60_000;
/// The burn keeper and the graduate crank take the platform's pause flag from a read at most this old (the pool
/// pass reads the platform every pass). A call sent in the seconds after a pause is refused by the chain's
/// simulation before it is sent, and costs nothing.
const PLATFORM_MAX_AGE_MS = 15_000;
/// The burn keeper and the reveal crank read again after this long even when none of their pools changed.
const BURN_QUIET_MS = 600_000;
/// The upkeep crank reads everything again after this long even when the collectible program had no transaction.
const UPKEEP_QUIET_MS = 300_000;
/// A crank whose reads of the chain fail this long in a row raises one warning alert. /health says `readStale`
/// (and answers 503) after READ_STALE_MS of it (lib/server.mjs).
const READ_ALERT_MS = 300_000;
/// A read of the indexed tickets in flight is shared by every loop that asks meanwhile (lib/tickets.mjs); a finished
/// one is answered again to a loop that asks within this many milliseconds of it.
const TICKET_READ_SHARE_MS = 3000;
/// The pool pass's report of the tickets takes the newest read of every ticket when it is at most this old.
const TICKET_VIEW_MAX_AGE_MS = 300_000;
/// The signatures handed in through POST /notify are looked at (one getSignatureStatuses for all of them) at most
/// this often, and the mint loop is woken by them at most this often too.
const NOTIFY_PASS_MIN_MS = 1000;
/// The reads of the whole pool program (the reconciliation) failing this long raise one warning alert.
const FULL_READ_ALERT_MS = 3_600_000;
const emptyRead = () => ({ streak: 0, since: null, lastReadAt: null, lastError: null, alerted: false });

/// A digest of the accounts of some pools as the shared list holds them: it changes with any trade on them.
function poolsDigest(pools, bytes) {
  const h = crypto.createHash("sha256");
  for (const p of pools) { const k = p.address.toBase58(); h.update(k); const b = bytes.get(k); h.update(b ? Buffer.from(b) : Buffer.from(JSON.stringify(p, jsonReplacer))); }
  return h.digest("hex");
}

class Watcher {
  constructor({ cfg, connection, client, state, notifier, probe, keeper }) {
    Object.assign(this, { cfg, connection, client, state, notifier, probe, keeper });
    // One list of the pools for every loop, kept fresh by the feed when it runs (the feed is then its only reader).
    this.poolCache = new PoolCache({ connection, feedOwned: !!cfg.feed, fullEveryMs: cfg.marketRefreshSeconds * 1000 });
    // The tickets of the collectible program by address (lib/tickets.mjs): what the settle, reveal, upkeep and
    // mint cranks and the pool pass read, a hundred a call, in place of the whole program.
    this.ticketIndex = new TicketIndex({ file: cfg.ticketIndexFile, log, reconcileEveryMs: cfg.ticketReconcileSeconds * 1000 });
    // Per crank: how many passes in a row its read of the chain failed, since when, and when it last completed one.
    this.reads = { settle: emptyRead(), upkeep: emptyRead(), burn: emptyRead(), holderSync: emptyRead(), reveal: emptyRead() };
    this.notifyCounts = { accepted: 0, refused: 0 };
    // The look at the notified signatures: at most once every NOTIFY_PASS_MIN_MS, never two at once.
    this.notifyTimer = null; this.notifyRunning = false; this.notifyAgain = false; this.notifyLastAt = 0;
    this.fullReadAlerted = false;
    // The feed's lock as another watcher held it at the start ({ pid, since }), when the feed was asked for: /health
    // then answers ok false, and one alert says so.
    this.feedLocked = null;
    // When the settle crank last read every indexed ticket (between two such sweeps it reads the hot wallets only).
    this.settleSweptAt = null;
    // The mint loop's wake-up call: the feed and the notified buys use it when they hand the crank a wallet.
    this.wakeMint = () => {};
    // The settle loop's: the feed uses it when it saw a sell on a collectible pool.
    this.wakeSettle = () => {};
    this.feed = null;
    this.market = null;
    this.lastFeed = { at: null, slot: null, transactions: 0, sigs: 0, pools: 0, backfilled: 0, more: false };
    // The newest slot this watcher has read through any of its calls, and when: the feed's lag is counted against
    // it, and a feed pass that has a fresh one asks for no getSlot of its own.
    this.latestSlot = null;
    this.latestSlotAt = null;
    this.keeperBalance = null;   // { lamports, at }
    this.holderScans = {};       // the holder sync's table of the last reads of each strict pool (lib/burn.mjs)
    // On the very first pass every pool is new; announcing all of them would be noise.
    this.firstEverPass = Object.keys(state.pools).length === 0;
    this.lastStatus = readStatus(cfg.statusFile);
    this.symbols = {};
    this.stopping = false;
    this.ticketView = null;
    this.lastCrank = { at: null, revealed: 0, failed: 0, due: 0, openTickets: 0 };
    this.lastSettle = { at: null, pools: 0, unbacked: 0, sent: 0, failed: 0, dropped: 0, burned: 0, rentLamports: 0, more: 0 };
    this.lastUpkeep = { at: null, pools: 0, waiting: 0, sent: 0, failed: 0, delivered: 0, burned: 0, rentLamports: 0, more: 0 };
    if (!state.tickets) state.tickets = { seen: {} };
    if (!state.settle) state.settle = { fails: {}, totals: NO_SETTLE_TOTALS() };
    if (!state.upkeep) state.upkeep = { waiting: {}, totals: NO_UPKEEP_TOTALS() };
    this.lastBurn = { at: null, pools: 0, waiting: 0, sent: 0, failed: 0, observed: 0, waited: 0, bought: 0, spentLamports: 0, more: 0 };
    if (!state.burn) state.burn = { fails: {}, totals: NO_BURN_TOTALS(), pools: {} };
    this.lastGraduate = { at: null, pools: 0, due: 0, sent: 0, failed: 0, graduated: 0, already: 0, more: 0 };
    if (!state.graduate) state.graduate = { fails: {}, totals: NO_GRADUATE_TOTALS(), pools: {} };
    this.lastMint = { at: null, watching: 0, sent: 0, failed: 0, pieces: 0 };
    if (!state.mint) state.mint = { totals: NO_MINT_TOTALS() };
    // The transactions of the collectible program this watcher sent itself (reveals, settles, deliveries, burns):
    // the mint crank never reads them back.
    this.ownSigs = new Set();
    this.buybackTreasuries = new Map();
    // The mint crank lives from the start: the feed hands it the buys it reads, whether or not a pass ran yet.
    this.mintCrank = cfg.mint ? this.newMintCrank() : null;
  }

  newMintCrank() {
    const { cfg, connection, client } = this;
    return new MintCrank({
      connection, keeper: this.keeper, log, price: cfg.mintPriceMicroLamports, sweepMs: cfg.mintSweepSeconds * 1000,
      pools: cfg.pool ? [cfg.pool] : null, tickets: this.ticketIndex,
      buildTx: (payer, ixs) => client.buildTx(payer, ixs),
      canSend: async () => (await this.ensureKeeperFunded()).canSend,
      isOwn: (s) => this.ownSigs.has(s),
    });
  }

  /// What /health and the status file say about the mint crank.
  mintStatus() {
    const { cfg, state } = this;
    return { enabled: cfg.mint, lastMintAt: this.lastMint.at, lastAt: this.lastMint.at, lastMintSent: this.lastMint.sent, watching: this.lastMint.watching, intervalSeconds: cfg.mintIntervalSeconds, totals: state.mint.totals, handed: this.mintCrank ? this.mintCrank.handed : 0 };
  }

  /// A signature handed in through POST /notify (validated by the server): it waits for the next look at the
  /// notified signatures, within NOTIFY_PASS_MIN_MS (one getSignatureStatuses for all of them; the transaction
  /// only for a signature the chain knows). The mint loop is woken only when that transaction is a buy that earned
  /// pieces. Nothing of the caller's is trusted but the signature.
  notify(signature) {
    if (!this.mintCrank) return { accepted: false, reason: "the mint crank is off" };
    const r = this.mintCrank.notify(signature);
    if (r.accepted) { this.notifyCounts.accepted += 1; this.kickNotify(); } else this.notifyCounts.refused += 1;
    return r;
  }

  /// Ask for a look at the notified signatures: now, or NOTIFY_PASS_MIN_MS after the last one; one that is asked
  /// for while a look runs or waits follows it.
  kickNotify() {
    if (this.stopping || !this.mintCrank) return;
    if (this.notifyRunning || this.notifyTimer) { this.notifyAgain = true; return; }
    const wait = Math.max(0, this.notifyLastAt + NOTIFY_PASS_MIN_MS - Date.now());
    this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.runNotify(); }, wait);
  }

  async runNotify() {
    this.notifyRunning = true; this.notifyAgain = false; this.notifyLastAt = Date.now();
    try {
      const r = await this.mintCrank.readNotified();
      if (r.found) { log.info(`notify: ${r.found} wallets handed to the mint crank from ${r.transactions} notified buys`); this.wakeMint(); }
      else if (r.looked) log.debug(`notify: ${r.looked} signatures looked at: ${r.unknown} unknown to the chain, ${r.failed} failed, ${r.read} transactions read, ${r.left} wait`);
    } catch (e) {
      log.warn(`notify: the look at the notified signatures failed: ${errMsg(e)}`);
    } finally {
      this.notifyRunning = false;
      if ((this.notifyAgain || this.mintCrank.notifyPending()) && !this.stopping) this.kickNotify();
    }
  }

  stopNotify() { if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; } }

  /// What /health says about POST /notify.
  notifyStatus() {
    const t = this.mintCrank ? this.mintCrank.notifyTotals : {};
    return { enabled: this.cfg.notify, ...this.notifyCounts, statusCalls: t.statusCalls ?? 0, unknown: t.unknown ?? 0, reads: t.reads ?? 0, found: t.found ?? 0 };
  }

  /// A crank completed (or failed) its read of the chain this pass. Five minutes of failures in a row: one
  /// warning alert; the first good read after them: one line. /health shows the streaks (lib/server.mjs).
  async noteRead(name, ok, error = null) {
    const r = this.reads[name];
    const now = Date.now();
    if (ok) {
      if (r.streak > 0) log.info(`${name}: the read of the chain works again after ${r.streak} failed passes`);
      r.streak = 0; r.since = null; r.lastError = null; r.alerted = false; r.lastReadAt = new Date(now).toISOString();
      return;
    }
    r.streak += 1;
    r.lastError = error ? String(error) : null;
    if (r.since === null) r.since = new Date(now).toISOString();
    if (!r.alerted && now - Date.parse(r.since) >= READ_ALERT_MS) {
      r.alerted = true;
      await this.notifier.alert({ pool: null, level: "warning", message: `${name}: no complete read of the chain for ${Math.round((now - Date.parse(r.since)) / 60000)} minutes (${r.streak} passes in a row): ${r.lastError ?? "unknown error"}. Its work waits until the RPC answers again.` });
    }
  }

  readsStatus() {
    const out = {};
    for (const [k, r] of Object.entries(this.reads)) out[k] = { streak: r.streak, since: r.since, lastReadAt: r.lastReadAt, lastError: r.lastError };
    return out;
  }

  poolsStatus() {
    const c = this.poolCache;
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    return { readAt: iso(c.readAt), fullAt: iso(c.fullAt), owed: c.owed, fullFailures: c.fullFailures, fullFailedSince: iso(c.fullFailedSince), patches: c.patches, reads: c.reads };
  }

  /// Every indexed ticket, read by address (one call per hundred). A read in flight is shared by every loop that
  /// asks meanwhile, and a finished one with a loop that asks within TICKET_READ_SHARE_MS of it; `fresh` asks for a
  /// read that begins after this call.
  async indexedTickets({ fresh = false, maxAgeMs = TICKET_READ_SHARE_MS } = {}) {
    const r = await this.ticketIndex.read(this.connection, { maxAgeMs: fresh ? 0 : maxAgeMs, fresh });
    if (r.slot !== null) this.noteSlot(r.slot);
    return r;
  }

  /// The tickets that still hold pieces and the slot to judge them at, from the index (what readTickets read from
  /// the whole program before).
  async openTickets(opts = {}) {
    const r = await this.indexedTickets(opts);
    return readTickets(this.connection, { tickets: r.tickets, slot: r.slot ?? this.latestSlot ?? 0 });
  }

  /// The reconciliation of the ticket index (lib/tickets.mjs), when it is due: one getProgramAccounts of the
  /// collectible program, addresses only. A failure is logged and tried again later with a growing pause;
  /// RECONCILE_ALERT_FAILURES in a row raise one warning alert. Never throws.
  async reconcileTickets({ force = false } = {}) {
    const idx = this.ticketIndex;
    if (!force && !idx.reconcileDue()) return null;
    try {
      const r = await idx.reconcile(this.connection);
      const line = `tickets: the index holds ${r.total} tickets after listing the collectible program (${r.listed} listed, ${r.added} new, ${r.skipped ?? 0} left out: read empty lately)${r.recovered ? `, the listing works again after ${r.recovered} failures` : ""}`;
      if (r.added || r.recovered) log.info(line); else log.debug(line);
      return r;
    } catch (e) {
      const n = idx.state.reconcileFailures;
      log.warn(`tickets: the listing of the collectible program failed (${n} in a row): ${errMsg(e)}. The index keeps its ${idx.size()} tickets; the feed adds new buys; next try at ${idx.status().nextReconcileAt}`);
      if (n >= RECONCILE_ALERT_FAILURES && !idx.alerted) {
        idx.alerted = true;
        await this.notifier.alert({ pool: null, level: "warning", message: `the listing of the collectible program's tickets failed ${n} times in a row (${errMsg(e)}). The cranks keep working on the ${idx.size()} tickets they know and on every new buy; a ticket they do not know waits for the listing to work again.` });
      }
      return null;
    }
  }

  /// A signature this watcher sent on the collectible program. The mint crank skips it.
  own(signature) {
    if (signature) { this.ownSigs.add(signature); if (this.ownSigs.size > 1000) this.ownSigs.delete(this.ownSigs.values().next().value); }
    return signature;
  }

  // ---- the mint crank (collectible template, one approval) ------------------------------------------

  /// One mint pass (lib/mint.mjs). A buy that paid a deposit has its pieces minted into the buyer's wallet by
  /// the keeper, `mint_for`, paid back from that deposit, a few seconds after the buy. Answers whether a wallet
  /// waits on its pieces, so the loop comes back in half a second.
  async mint() {
    const { cfg, connection, client, state } = this;
    // No pool of the collectible template: no ticket can exist, nothing is read.
    const collectibles = (await this.poolCache.get(POOLS_MAX_AGE_MS.mint)).filter((p) => p.hasHook && templateOf(p.hookProgram) === "collectible");
    if (!collectibles.length && !(this.mintCrank && this.mintCrank.watch.size)) {
      this.lastMint = { at: new Date().toISOString(), watching: 0, sent: 0, failed: 0, pieces: 0 };
      return { busy: false };
    }
    if (!this.mintCrank) this.mintCrank = this.newMintCrank();
    const p = await this.mintCrank.pass();
    if (p.sent || p.failed) this.spent();
    if (p.slot !== undefined) this.noteSlot(p.slot);
    this.lastMint = { at: p.at, watching: p.watching, sent: p.sent, failed: p.failed, pieces: p.pieces };
    // the state file is written only when something was counted
    if (p.results.length || p.mintedFirst || p.short || p.refused) {
      state.mint.totals = addMintTotals(state.mint.totals, p);
      saveState(cfg.stateFile, state);
    }
    const line = `mint done: ${p.signatures} new signatures, ${p.transactions} transactions read, ${p.found} wallets found${p.swept ? " (every ticket read)" : ""}, ${p.watching} waiting, ${p.sent} mints sent (${p.pieces} pieces), ${p.failed} failed, ${p.mintedFirst} minted first by their wallet, ${p.short} with a deposit too small, ${p.refused} refused by a simulation`;
    if (p.sent || p.failed || p.found) log.info(line); else log.debug(line);
    if (p.failed) await this.notifier.alert({ pool: null, level: "warning", message: `mint crank: ${p.failed} mint_for transactions failed this pass (${p.results.find((r) => !r.signature).error})` });
    return { busy: p.watching > 0 };
  }

  // ---- the reveal crank (collectible template) ---------------------------------------------------

  /// One crank pass: reveal every ticket whose deciding block exists, 8 per transaction, paid by the keeper.
  async crank() {
    const { cfg, connection, client, state } = this;
    const t0 = Date.now();
    const nowIso = new Date(t0).toISOString();
    // No pool of the collectible template: no ticket can exist, so nothing is read. Pieces wait for a reveal only
    // after a buy, and a buy changes its pool: when no collectible pool changed since a pass that found no ticket
    // with waiting pieces, there is still none, and nothing is read either (every ten minutes it reads anyway).
    const collectibles = (await this.poolCache.get(POOLS_MAX_AGE_MS.reveal)).filter((p) => p.hasHook && templateOf(p.hookProgram) === "collectible");
    const digest = poolsDigest(collectibles, this.poolCache.bytes);
    if (!collectibles.length || quietSkip(this.revealQuiet, digest, t0, BURN_QUIET_MS)) {
      this.lastCrank = { at: new Date().toISOString(), revealed: 0, failed: 0, due: 0, openTickets: 0 };
      await this.noteRead("reveal", true);
      log.debug(collectibles.length ? "crank done: no collectible pool changed since a pass that found no waiting piece, nothing read" : "crank done: no collectible pool, nothing read");
      return this.lastCrank;
    }
    const funding = await this.ensureKeeperFunded();
    // the tickets, from the index (by address): a read that fails ends this pass, the next one reads again
    let before;
    try { before = await this.openTickets(); } catch (e) {
      await this.noteRead("reveal", false, errMsg(e));
      log.warn(`crank: the tickets could not be read this pass: ${errMsg(e)}`);
      this.lastCrank = { at: new Date().toISOString(), revealed: 0, failed: 0, due: 0, openTickets: 0 };
      return this.lastCrank;
    }
    await this.noteRead("reveal", true);
    this.noteSlot(before.slot);
    this.revealQuiet = quietAfter(this.revealQuiet, digest, !anyWaiting(before.tickets), t0, BURN_QUIET_MS);
    // Seen WAITING now, so that a batch this very crank reveals too late is recognised as expired afterwards.
    await this.observeTickets(before, nowIso);
    const due = ticketsToReveal(before.tickets, before.slot);
    let done = []; let failed = []; let after = before;
    if (due.length && !funding.canSend) {
      failed = due.map((t) => ({ ...t, error: "the keeper wallet cannot pay the fee" }));
      log.error(`crank: ${due.length} tickets are due but the keeper wallet ${this.probe.toBase58()} cannot pay the 5000 lamport fee`);
    } else if (due.length) {
      const send = async (group) => this.own(await sendRevealTx({ connection, client, keeper: this.keeper, group }));
      ({ done, failed } = await revealAll({ due, send, log }));
      this.spent();
      try { after = await this.openTickets({ fresh: true }); } catch (e) { log.warn(`crank: the tickets could not be read again after the reveals: ${errMsg(e)}`); after = before; }
      const byTicket = new Map(after.tickets.map((t) => [`${t.pool.toBase58()}:${t.user.toBase58()}`, t]));
      for (const t of done) {
        const outcome = describeOutcome(byTicket.get(`${t.pool.toBase58()}:${t.user.toBase58()}`), t.targetSlots);
        log.info(`crank: revealed ticket of wallet ${t.user.toBase58()} on pool ${t.pool.toBase58()} (${pcs(t.pieces)}): ${outcome}, tx ${t.signature}`);
      }
      for (const t of failed) log.error(`crank: reveal FAILED for wallet ${t.user.toBase58()} on pool ${t.pool.toBase58()}: ${t.error}`);
      await this.observeTickets(after, nowIso);
    }
    this.lastCrank = { at: new Date().toISOString(), revealed: done.length, failed: failed.length, due: due.length, openTickets: after.tickets.length };
    saveState(cfg.stateFile, state);
    const line = `crank done: ${after.tickets.length} open tickets, ${due.length} due, ${done.length} revealed, ${failed.length} failed, slot ${before.slot}, ${Date.now() - t0} ms`;
    if (due.length) log.info(line); else log.debug(line);
    if (failed.length) await this.notifier.alert({ pool: null, level: "warning", message: `reveal crank: ${failed.length} of ${due.length} reveals failed (first error: ${failed[0].error})` });
    return this.lastCrank;
  }

  /// A reveal, settle, deliver, reap, buyback or burn transaction costs 5,000 lamports. Airdrop on localnet and
  /// devnet; elsewhere a danger alert once the balance is under KEEPER_MIN_LAMPORTS, because an empty keeper
  /// means reveals stop and pieces expire, settles stop and unbacked pieces stay, deliveries stop and wallets
  /// show stale pieces, buybacks and burns stop and the pots grow. Every crank calls this, so the one alert
  /// covers them all.
  async ensureKeeperFunded() {
    const { cfg, probe } = this;
    let bal = await this.keeperLamports();
    if (bal < cfg.keeperMinLamports && cfg.cluster !== "mainnet") {
      try {
        bal = await this.airdrop(cfg.cluster === "localnet" ? 2_000_000_000 : 1_000_000_000);
        log.info(`keeper wallet ${probe.toBase58()} received an airdrop, balance now ${Number(bal) / 1e9} SOL`);
      } catch (e) {
        log.warn(`airdrop to the keeper wallet failed: ${errMsg(e)}`);
      }
    }
    const alert = keeperBalanceAlert({ cluster: cfg.cluster, lamports: bal, minLamports: cfg.keeperMinLamports, address: probe.toBase58() });
    if (alert) await this.notifier.alert({ pool: null, level: alert.level, message: alert.message });
    return { lamports: bal, canSend: canPayReveal(bal) };
  }

  async airdrop(lamports) {
    const sig = await this.connection.requestAirdrop(this.probe, lamports);
    await confirmByPolling(this.connection, sig, null);
    this.keeperBalance = null;
    return this.keeperLamports();
  }

  /// The keeper's (and probe's) balance. Five cranks and the pool pass ask for it; it is read at most once a
  /// minute, and again at once after a crank sent a transaction (`spent`).
  async keeperLamports() {
    const now = Date.now();
    if (this.keeperBalance && now - this.keeperBalance.at < KEEPER_BALANCE_TTL_MS) return this.keeperBalance.lamports;
    const lamports = BigInt(await this.connection.getBalance(this.probe));
    this.keeperBalance = { lamports, at: now };
    return lamports;
  }
  spent() { this.keeperBalance = null; }

  /// The platform account, read again when the last read is older than `maxAgeMs`.
  async platformAt(maxAgeMs) {
    const now = Date.now();
    if (this.platformRead && now - this.platformRead.at <= maxAgeMs) return this.platformRead.platform;
    const platform = await this.client.platform();
    this.platformRead = { platform, at: now };
    return platform;
  }

  /// A slot this watcher has read: the newest one is what the feed's lag is counted against.
  noteSlot(slot) {
    const n = slot === null || slot === undefined ? NaN : Number(slot);
    if (!Number.isFinite(n)) return;
    if (this.latestSlot === null || n >= this.latestSlot) { this.latestSlot = n; this.latestSlotAt = Date.now(); }
  }

  /// Remember which batches were seen waiting. A batch that shows up EXPIRED after that was not revealed in
  /// time: one warning per batch, recorded on its pool but marked as the keeper's doing, not the pool's.
  async observeTickets(snap, nowIso) {
    const { state } = this;
    const d = diffBatches(state.tickets.seen ?? {}, snap.tickets);
    state.tickets.seen = d.seen;
    for (const ev of d.expired) {
      const symbol = await this.symbolFor(ev.pool);
      const message = expiredMessage(ev, symbol);
      const ps = state.pools[ev.pool];
      if (ps) this.recordAlert(ps, { level: "warning", message, keeper: true }, nowIso);
      await this.notifier.alert({ pool: ev.pool, symbol, level: "warning", message });
    }
    return d.expired.length;
  }

  async symbolFor(addr) {
    if (this.symbols[addr] !== undefined) return this.symbols[addr] || null;
    try {
      const pool = await this.client.pool(new PublicKey(addr));
      const md = pool ? await this.client.metadata(pool.baseMint) : null;
      this.symbols[addr] = md && md.symbol ? md.symbol : "";
    } catch { return null; }
    return this.symbols[addr] || null;
  }

  // ---- the settle crank (collectible template) ---------------------------------------------------

  /// One settle pass. Pieces are pegged to the coin: a wallet holds at most one piece per unit of coins. On every
  /// collectible pool, find the wallets that hold more than their coins back and settle them, one transaction
  /// per wallet, signed and paid by the keeper. The keeper receives the rent of every piece it burns.
  /// With the feed on, a pass reads the tickets of the wallets the feed saw trade or earn pieces in the last few
  /// minutes (the ticket index's hot wallets: an off-site sell is settled within a pass), and every
  /// SETTLE_SWEEP_SECONDS every indexed ticket (a plain transfer of coins shows in no pool transaction: it is
  /// settled within that sweep). With the feed off every pass reads every ticket. No ticket to read, no call.
  async settle() {
    const { cfg, connection, client, state } = this;
    const t0 = Date.now();
    const nowIso = new Date(t0).toISOString();
    const pools = await this.collectiblePools();
    // the tickets from the index (by address), then the configs and the holders' coins
    let unbacked = []; let unread = []; let scope = "none";
    let indexed = null;
    if (pools.length) {
      const sweep = !cfg.feed || this.settleSweptAt === null || t0 - this.settleSweptAt >= cfg.settleSweepSeconds * 1000;
      try {
        if (sweep) { indexed = await this.indexedTickets(); scope = "all"; }
        else {
          const hot = this.ticketIndex.hotAddresses(t0);
          indexed = hot.length ? await this.ticketIndex.read(connection, { only: hot }) : { tickets: [], slot: null };
          scope = `${hot.length} recent`;
          if (indexed.slot !== null) this.noteSlot(indexed.slot);
        }
      } catch (e) { indexed = null; unread = pools.map((p) => ({ pool: p.toBase58(), error: `the tickets could not be read: ${errMsg(e)}` })); }
      // only tickets that hold or wait for pieces need the configs and the coins
      if (indexed && indexed.tickets.some((t) => t.owned.length + t.pending > 0)) ({ unbacked, unread } = await readUnbacked(connection, pools, { tickets: indexed.tickets }));
      if (indexed && sweep && !unread.length) this.settleSweptAt = t0;
    }
    // No collectible pool, or nobody above the peg: nothing to pay for.
    const funding = unbacked.length ? await this.ensureKeeperFunded() : { canSend: false };
    await this.noteRead("settle", unread.length === 0, unread.length ? unread[0].error : null);
    for (const u of unread) log.warn(`settle: pool ${u.pool} could not be read this pass: ${u.error}`);
    const plan = planSettles(unbacked, state.settle.fails);
    let results = [];
    if (plan.send.length && !funding.canSend) {
      log.error(`settle: ${plan.send.length} wallets are above the peg but the keeper wallet ${this.probe.toBase58()} cannot pay the 5000 lamport fee`);
    } else if (plan.send.length) {
      results = await settleAll({
        plan: plan.send,
        send: async (item) => this.own(await sendSettleTx({ connection, client, keeper: this.keeper, item })),
        readEffect: (signature) => readSettleEffect(connection, signature),
      });
      this.spent();
      // One line per settle. A failed one is logged here, once, and the pass has already moved on.
      for (const r of results) { if (r.signature) log.info(settleLine(r)); else log.warn(settleLine(r)); }
    }
    const strikes = settleStrikes(state.settle.fails, plan.keys, results, { unread: unread.map((u) => u.pool) });
    state.settle.fails = strikes.fails;
    state.settle.totals = addSettleTotals(state.settle.totals, results);
    // Three failed rounds in a row for one wallet: one alert. It is shown on the pool and marked as the keeper's,
    // so it never moves the pool's score.
    for (const ev of strikes.alerts) {
      const symbol = await this.symbolFor(ev.pool);
      const message = settleStuckMessage(ev, symbol);
      const ps = state.pools[ev.pool];
      if (ps) this.recordAlert(ps, { level: "danger", message, keeper: true }, nowIso);
      await this.notifier.alert({ pool: ev.pool, symbol, level: "danger", message });
    }
    const sum = (f) => results.reduce((n, r) => n + (r.effect ? f(r.effect) : 0), 0);
    const sent = results.filter((r) => r.signature).length;
    // Work left for the very next round: a wallet with more burns than one settle takes, or more wallets than
    // one pass sends.
    const more = plan.later.length + results.filter((r) => r.ok && r.burnLater > 0).length;
    this.lastSettle = {
      at: new Date().toISOString(), pools: pools.length, unbacked: unbacked.length, sent, failed: results.length - sent,
      dropped: sum((e) => e.dropped), burned: sum((e) => e.burned), rentLamports: sum((e) => e.rentLamports), more,
    };
    saveState(cfg.stateFile, state);
    const s = this.lastSettle;
    const line = `settle done: ${pools.length} collectible pools, tickets read: ${scope}, ${unbacked.length} wallets above the peg, ${s.sent} settles sent, ${s.failed} failed, ${s.dropped} pieces dropped, ${s.burned} burned, ${s.rentLamports} lamports of rent received, ${plan.resting.length} resting, ${Date.now() - t0} ms`;
    if (unbacked.length) log.info(line); else log.debug(line);
    return this.lastSettle;
  }

  /// The pools that use the collectible template. With --pool, that pool only.
  async collectiblePools() {
    let pools = (await this.poolCache.get(POOLS_MAX_AGE_MS.settle)).filter((p) => p.hasHook && templateOf(p.hookProgram) === "collectible");
    if (this.cfg.pool) pools = pools.filter((p) => p.address.toBase58() === this.cfg.pool);
    return pools.map((p) => p.address).sort((a, b) => (a.toBase58() < b.toBase58() ? -1 : 1));
  }

  // ---- the upkeep crank (pegged coins) -------------------------------------------------------------

  /// One upkeep pass. On a pegged coin the wallet lists change inside every transfer of the coin, and the
  /// Metaplex assets follow. On every pegged pool: hand the asset of each moved piece to the wallet whose list
  /// holds it now (`deliver`), and burn the assets of the pieces that transfers burned (`reap`). One transaction
  /// per group of up to six assets, signed and paid by the keeper. The keeper receives the rent of what it burns.
  async upkeep() {
    const { cfg, connection, client, state } = this;
    const t0 = Date.now();
    const nowIso = new Date(t0).toISOString();
    const pools = await this.peggedPools();
    // A wallet list or an asset's owner changes only in a transaction of the collectible program: a transfer of a
    // pegged coin (its transfer hook), a trade, a mint, a delivery, a burn. So when the last pass left nothing
    // waiting and that program has had no transaction since, nothing waits now: one look at its newest signature
    // is the whole pass. Every five minutes it reads everything all the same.
    // With the mint crank on, that newest signature comes from its own look of a few seconds ago, at no cost.
    let newest;
    if (pools.length && quietSkip(this.upkeepQuiet, this.upkeepQuiet ? this.upkeepQuiet.key : null, t0, UPKEEP_QUIET_MS)) {
      newest = await this.collectibleHead();
      if (newest === this.upkeepQuiet.key) {
        this.lastUpkeep = { at: new Date().toISOString(), pools: pools.length, waiting: 0, sent: 0, failed: 0, delivered: 0, burned: 0, rentLamports: 0, more: 0 };
        await this.noteRead("upkeep", true);
        log.debug("upkeep done: no transaction of the collectible program since a pass that left nothing waiting, nothing read");
        return this.lastUpkeep;
      }
    }
    // the newest transaction of the program before the read: what lands during it is seen by the next pass
    const head = pools.length ? [newest !== undefined ? newest : await this.collectibleHead()].filter((s) => s !== null).map((signature) => ({ signature })) : [];
    // No pegged pool: nothing to read, nothing to pay for.
    const funding = pools.length ? await this.ensureKeeperFunded() : { canSend: false };
    // the tickets from the index (by address), then the configs, the queues and the assets
    let work = []; let unread = [];
    if (pools.length) {
      let indexed = null;
      try { indexed = await this.indexedTickets(); } catch (e) { unread = pools.map((p) => ({ pool: p.toBase58(), error: `the tickets could not be read: ${errMsg(e)}` })); }
      if (indexed) ({ work, unread } = await readUpkeep(connection, pools, { tickets: indexed.tickets }));
    }
    await this.noteRead("upkeep", unread.length === 0, unread.length ? unread[0].error : null);
    for (const u of unread) log.warn(`upkeep: pool ${u.pool} could not be read this pass: ${u.error}`);
    const waiting = waitingAssets(work);
    // An asset that was sent five rounds in a row and still waits is stuck: one alert, then it rests.
    const round = upkeepRound(state.upkeep.waiting, waiting, { unread: unread.map((u) => u.pool) });
    const plan = planUpkeep(work, round.table);
    let results = [];
    if (plan.send.length && !funding.canSend) {
      log.error(`upkeep: ${plan.send.length} transactions are due but the keeper wallet ${this.probe.toBase58()} cannot pay the 5000 lamport fee`);
    } else if (plan.send.length) {
      results = await upkeepAll({
        plan: plan.send,
        send: async (item) => this.own(await sendUpkeepTx({ connection, client, keeper: this.keeper, item })),
        readEffect: (signature, kind) => readUpkeepEffect(connection, signature, kind),
      });
      this.spent();
      // One line per transaction. No alert per delivery or burn: that is the crank's everyday work.
      for (const r of results) { if (r.signature) log.info(upkeepLine(r)); else log.warn(upkeepLine(r)); }
    }
    state.upkeep.waiting = upkeepTried(round.table, plan.keys, triedKeys(results));
    state.upkeep.totals = addUpkeepTotals(state.upkeep.totals, results);
    // Stuck assets: one alert per pool and kind. Shown on the pool and marked as the keeper's, so it never moves
    // the pool's score.
    const groups = new Map();
    for (const ev of round.stuck) { const k = `${ev.pool}:${ev.kind}`; groups.set(k, [...(groups.get(k) ?? []), ev]); }
    for (const events of groups.values()) {
      const pool = events[0].pool;
      const symbol = await this.symbolFor(pool);
      const message = upkeepStuckMessage(events, symbol);
      const ps = state.pools[pool];
      if (ps) this.recordAlert(ps, { level: "danger", message, keeper: true }, nowIso);
      await this.notifier.alert({ pool, symbol, level: "danger", message });
    }
    const sum = (f) => results.reduce((n, r) => n + (r.effect ? f(r.effect) : 0), 0);
    const sent = results.filter((r) => r.signature).length;
    this.lastUpkeep = {
      at: new Date().toISOString(), pools: work.length, waiting: waiting.length, sent, failed: results.length - sent,
      delivered: sum((e) => e.delivered), burned: sum((e) => e.burned), rentLamports: sum((e) => e.rentLamports),
      // Work left for the very next round: more transactions than one pass sends.
      more: plan.later.length,
    };
    // nothing waits and nothing was sent: the next passes look at the program's newest signature first
    const idle = !unread.length && !waiting.length && !results.length && !plan.later.length;
    this.upkeepQuiet = quietAfter(this.upkeepQuiet, head.length ? head[0].signature : null, idle, t0, UPKEEP_QUIET_MS);
    saveState(cfg.stateFile, state);
    const s = this.lastUpkeep;
    const line = `upkeep done: ${work.length} pegged pools, ${waiting.length} assets waiting, ${s.sent} transactions sent, ${s.failed} failed, ${s.delivered} assets delivered, ${s.burned} burned, ${s.rentLamports} lamports of rent received, ${plan.resting.length} resting, ${Date.now() - t0} ms`;
    if (waiting.length) log.info(line); else log.debug(line);
    return this.lastUpkeep;
  }

  /// The collectible program's newest signature (null when it has none): the mint crank's last look when it is at
  /// most MINT_HEAD_MAX_AGE_MS old, else one getSignaturesForAddress.
  async collectibleHead() {
    // a program that has no transaction in the node's history (a fresh chain) answers NO_SIGNATURE: a key that stays
    // the same until its first transaction, so the upkeep crank's quiet check works there too
    const h = this.mintCrank ? this.mintCrank.head() : null;
    if (h && h.at !== null && Date.now() - h.at <= MINT_HEAD_MAX_AGE_MS) return h.signature ?? NO_SIGNATURE;
    const s = await this.connection.getSignaturesForAddress(PROGRAMS.hook_collectible, { limit: 1 }, "confirmed");
    return s.length ? s[0].signature : NO_SIGNATURE;
  }

  /// The pools whose coin may be a pegged coin: a collectible pool with a Token-2022 coin. readUpkeep keeps the
  /// ones whose config says pegged. With --pool, that pool only.
  async peggedPools() {
    let pools = (await this.poolCache.get(POOLS_MAX_AGE_MS.upkeep)).filter((p) => isPeggedPool(p));
    if (this.cfg.pool) pools = pools.filter((p) => p.address.toBase58() === this.cfg.pool);
    return pools.map((p) => p.address).sort((a, b) => (a.toBase58() < b.toBase58() ? -1 : 1));
  }

  // ---- the burn keeper (buyback pools and rules pools) ------------------------------------------------

  /// One burn pass. A buyback pool and a rules pool collect a share of every trade to buy the coin back and
  /// burn it. The buy is an instruction anyone may send, and the programs rely on somebody sending it
  /// regularly, so that the pots stay small (HOOKS.md section 7). On every such pool with something to spend:
  /// ask the SDK what a call would do now, send it when it would record the pool or buy, skip it when the
  /// chain would refuse it as too soon. One transaction per pool, signed and paid by the keeper.
  async burn() {
    const { cfg, connection, client, state } = this;
    const t0 = Date.now();
    const nowIso = new Date(t0).toISOString();
    const pools = await this.burnPools();
    const done = (extra) => {
      this.lastBurn = { at: new Date().toISOString(), pools: pools.length, waiting: 0, sent: 0, failed: 0, observed: 0, waited: 0, bought: 0, spentLamports: 0, more: 0, ...extra };
      return this.lastBurn;
    };
    // No buyback or rules pool: nothing to read, nothing to pay for.
    if (!pools.length) { log.debug("burn done: no buyback or rules pool, nothing read"); return done({}); }
    const funding = await this.ensureKeeperFunded();
    // Strict coins: holder records that stand above their wallets' coins after a token Burn. A sync is no trade,
    // so a pause does not stop it.
    if (cfg.holderSync) await this.syncHolders(pools, funding);
    // A pot grows only with the trades of its pool, and a trade changes the pool account. So when no pool of
    // these templates changed since a pass that found nothing to spend, there is still nothing: the pass reads
    // nothing more. Every ten minutes it reads all the same.
    const digest = poolsDigest(pools, this.poolCache.bytes);
    if (quietSkip(this.burnQuiet, digest, t0, BURN_QUIET_MS)) {
      await this.noteRead("burn", true);
      log.debug("burn done: no buyback or rules pool changed since a pass that found nothing to spend, nothing read");
      return done({});
    }
    // A paused platform refuses trades, and the buy of a buyback or a burn is a trade: nothing is sent.
    const platform = await this.platformAt(PLATFORM_MAX_AGE_MS);
    if (!platform || platform.paused) {
      log.debug(`burn done: ${platform ? "the platform is paused, a buyback or a burn that buys would fail" : "no platform account"}, nothing sent`);
      return done({});
    }
    const { candidates, unread, waiting } = await readBurnCandidates(connection, client, this.probe, pools, { minPot: cfg.burnMinPotLamports, slippageBps: cfg.burnSlippageBps });
    this.burnQuiet = quietAfter(this.burnQuiet, digest, !candidates.length && !unread.length, t0, BURN_QUIET_MS);
    await this.noteRead("burn", unread.length === 0, unread.length ? unread[0].error : null);
    for (const u of unread) log.warn(`burn: pool ${u.pool} could not be read this pass: ${u.error}`);
    const plan = planBurns(candidates, state.burn.fails, { maxCalls: cfg.burnMaxCalls, minPot: cfg.burnMinPotLamports });
    for (const t of plan.tooSoon) log.debug(burnSkipLine(t));
    let results = [];
    if (plan.send.length && !funding.canSend) {
      log.error(`burn: ${plan.send.length} calls are due but the keeper wallet ${this.probe.toBase58()} cannot pay the 5000 lamport fee`);
    } else if (plan.send.length) {
      results = await burnAll({
        plan: plan.send,
        send: (item) => sendBurnTx({ connection, client, keeper: this.keeper, item }),
        readEffect: (signature) => readBurnEffect(connection, signature),
      });
      this.spent();
      // a buy of a burn is a swap: the pools it touched changed, the next loop reads them again
      if (results.some((r) => r.signature)) this.poolCache.invalidate();
      // One line per call, with the outcome the chain reported. No alert per buy: that is the keeper's everyday work.
      for (const r of results) { if (r.signature) log.info(burnLine(r)); else log.warn(burnLine(r)); }
    }
    const strikes = burnStrikes(state.burn.fails, plan.keys, results, { unread: unread.map((u) => u.pool) });
    state.burn.fails = strikes.fails;
    state.burn.totals = addBurnTotals(state.burn.totals, results);
    state.burn.pools = addBurnPoolStats(state.burn.pools, results, nowIso);
    // Three failed passes in a row for one pool: one alert. It is shown on the pool and marked as the keeper's,
    // so it never moves the pool's score.
    for (const ev of strikes.alerts) {
      const symbol = await this.symbolFor(ev.pool);
      const message = burnStuckMessage(ev, symbol);
      const ps = state.pools[ev.pool];
      if (ps) this.recordAlert(ps, { level: "danger", message, keeper: true }, nowIso);
      await this.notifier.alert({ pool: ev.pool, symbol, level: "danger", message });
    }
    const count = (outcome) => results.filter((r) => r.effect && r.effect.outcome === outcome).length;
    const sent = results.filter((r) => r.signature).length;
    const s = done({
      waiting, sent, failed: results.length - sent, observed: count("observed"), waited: count("waited"), bought: count("bought"),
      spentLamports: results.reduce((n, r) => n + (r.effect ? Number(r.effect.quoteSpent) : 0), 0),
      // Work left for the very next pass: more pools were due than one pass calls.
      more: plan.later.length,
    });
    saveState(cfg.stateFile, state);
    const line = `burn done: ${pools.length} buyback and rules pools, ${waiting} with something to spend, ${s.sent} calls sent (${s.observed} observed, ${s.waited} waited, ${s.bought} bought), ${s.failed} failed, ${plan.tooSoon.length} too soon, ${plan.later.length} left for the next pass, ${plan.resting.length} resting, ${s.spentLamports} lamports spent on burns, ${Date.now() - t0} ms`;
    if (results.length) log.info(line); else log.debug(line);
    return s;
  }

  /// The holder records of strict coins that stand above their wallets' coins by at least HOLDER_SYNC_MIN_BPS of
  /// what is registered: one `sync_holder` each, up to five per transaction, at most ten per pass, paid by the
  /// keeper. A record a sync lowered is gone from the next read; one that failed is read again next pass.
  async syncHolders(pools, funding) {
    const { cfg, connection, client, state } = this;
    // The records of a strict pool are read again only when its coin's supply moved (a token Burn), while some
    // wait for a sync, and every ten minutes (holderScanDue in lib/burn.mjs).
    const { work, unread } = await readHolderExcess(connection, pools, { minBps: cfg.holderSyncMinBps, scans: this.holderScans, nowMs: Date.now() });
    // a pool whose records could not be read waits before its next try (30 s, then 60, ..., 10 minutes: lib/burn.mjs)
    await this.noteRead("holderSync", unread.length === 0, unread.length ? unread[0].error : null);
    for (const u of unread) log.warn(`sync: pool ${u.pool} could not be read this pass: ${u.error}`);
    if (!state.burn.syncTotals) state.burn.syncTotals = NO_SYNC_TOTALS();
    const t = state.burn.syncTotals;
    let budget = SYNCS_PER_PASS;
    for (const w of work) {
      for (const it of w.later) log.debug(`sync: pool ${w.pool.address.toBase58()} wallet ${it.owner.toBase58()}: waits for the next pass`);
      const items = w.send.slice(0, budget);
      if (!items.length) continue;
      if (!funding.canSend) { log.error(`sync: ${items.length} holder records stand above their wallets' coins but the keeper wallet ${this.probe.toBase58()} cannot pay the 5000 lamport fee`); return; }
      budget -= items.length;
      const r = await syncAll({
        pool: w.pool, items,
        send: (owners) => sendSyncTx({ connection, client, keeper: this.keeper, pool: w.pool, owners }),
        readEffect: (signature) => readSyncEffect(connection, signature),
      });
      this.spent();
      for (const x of r.results) { if (x.signature) log.info(syncLine(w.pool.address, x.item, x.signature)); else log.warn(syncLine(w.pool.address, x.item, null, x.error)); }
      t.records += r.results.filter((x) => x.signature).length;
      t.failed += r.results.filter((x) => !x.signature).length;
      t.sent += new Set(r.results.filter((x) => x.signature).map((x) => x.signature)).size;
      t.feeLamports += r.feeLamports;
      if (budget <= 0) break;
    }
  }

  /// The pools of the two templates that buy their coin back: buyback and rules. With --pool, that pool only.
  async burnPools() {
    let pools = (await this.poolCache.get(POOLS_MAX_AGE_MS.burn)).filter((p) => burnKind(p) !== null);
    if (this.cfg.pool) pools = pools.filter((p) => p.address.toBase58() === this.cfg.pool);
    return pools.sort((a, b) => (a.address.toBase58() < b.address.toBase58() ? -1 : 1));
  }

  // ---- the graduate crank (pools on the curve) --------------------------------------------------------

  /// One graduate pass. A pool on the curve whose real reserve reached its graduation target may be graduated by
  /// anyone, and keeps trading on the curve until somebody does. For each such pool: one `graduate`, signed and
  /// paid by the keeper. The chain refuses it on a paused platform, so nothing is sent then.
  async graduate() {
    const { cfg, connection, client, state } = this;
    const t0 = Date.now();
    const nowIso = new Date(t0).toISOString();
    let pools = (await this.poolCache.get(POOLS_MAX_AGE_MS.graduate)).filter((p) => p.curveState === CURVE_OPEN);
    if (cfg.pool) pools = pools.filter((p) => p.address.toBase58() === cfg.pool);
    const done = (extra) => {
      this.lastGraduate = { at: new Date().toISOString(), pools: pools.length, due: 0, sent: 0, failed: 0, graduated: 0, already: 0, more: 0, ...extra };
      return this.lastGraduate;
    };
    // Nothing more is read unless a pool stands at or past its target: the keeper's balance and the platform's
    // pause only matter for a call.
    const due = pools.some((p) => readyToGraduate(p));
    const funding = due ? await this.ensureKeeperFunded() : { canSend: false };
    const platform = due ? await this.platformAt(PLATFORM_MAX_AGE_MS) : null;
    if (due && (!platform || platform.paused)) {
      log.debug(`graduate done: ${platform ? "the platform is paused, the chain would refuse a graduate" : "no platform account"}, nothing sent`);
      return done({});
    }
    const plan = planGraduates(pools, state.graduate.fails, state.graduate.pools, { maxCalls: GRADUATES_PER_PASS, nowMs: t0 });
    for (const r of plan.recent) log.warn(`graduate: pool ${r.key}: this watcher graduated it at ${r.since} (tx ${r.signature}), but the RPC still shows it open; nothing sent`);
    let results = [];
    if (plan.send.length && !funding.canSend) {
      log.error(`graduate: ${plan.send.length} pools stand past their graduation target but the keeper wallet ${this.probe.toBase58()} cannot pay the 5000 lamport fee`);
    } else if (plan.send.length) {
      results = await graduateAll({
        plan: plan.send,
        send: (item) => sendGraduateTx({ connection, client, keeper: this.keeper, pool: item.pool }),
        readEffect: (signature, item) => readGraduateEffect(connection, signature, item.pool.address),
      });
      this.spent();
      // a graduated pool changed: the next loop reads the pools again
      if (results.some((r) => r.signature)) this.poolCache.invalidate();
      for (const r of results) {
        if (r.signature) log.info(graduateLine(r)); else log.warn(graduateLine(r));
        // A coin that graduated: one line to the alerts too, once in its life. It is the keeper's doing, so it is
        // marked as such and never counts in the pool's score.
        if (r.effect && r.effect.outcome === "graduated") {
          const symbol = await this.symbolFor(r.key);
          const message = graduatedMessage(r, symbol);
          const ps = state.pools[r.key];
          if (ps) this.recordAlert(ps, { level: "info", message, keeper: true }, nowIso);
          await this.notifier.alert({ pool: r.key, symbol, level: "info", message });
        }
      }
    }
    const strikes = graduateStrikes(state.graduate.fails, plan.keys, results);
    state.graduate.fails = strikes.fails;
    state.graduate.totals = addGraduateTotals(state.graduate.totals, results);
    state.graduate.pools = addGraduatePoolStats(state.graduate.pools, results, nowIso);
    // Three failed passes in a row for one pool: one alert, marked as the keeper's.
    for (const ev of strikes.alerts) {
      const symbol = await this.symbolFor(ev.pool);
      const message = graduateStuckMessage(ev, symbol);
      const ps = state.pools[ev.pool];
      if (ps) this.recordAlert(ps, { level: "danger", message, keeper: true }, nowIso);
      await this.notifier.alert({ pool: ev.pool, symbol, level: "danger", message });
    }
    const count = (outcome) => results.filter((r) => r.effect && r.effect.outcome === outcome).length;
    const sent = results.filter((r) => r.signature).length;
    const s = done({ due: plan.keys.length, sent, failed: results.length - sent, graduated: count("graduated"), already: count("already"), more: plan.later.length });
    saveState(cfg.stateFile, state);
    const line = `graduate done: ${pools.length} pools on the curve, ${plan.keys.length} at or past their target, ${s.sent} graduate calls sent (${s.graduated} graduated, ${s.already} had graduated already), ${s.failed} failed, ${plan.later.length} left for the next pass, ${plan.resting.length} resting, ${Date.now() - t0} ms`;
    if (plan.keys.length) log.info(line); else log.debug(line);
    return s;
  }

  // ---- the trades feed and market.json ---------------------------------------------------------------

  /// One feed pass (lib/feed.mjs, lib/market.mjs, lib/pools.mjs): one getSignaturesForAddress on the pool program
  /// and the transactions that arrived; the pools those transactions touched, read again by address (one
  /// getMultipleAccountsInfo per hundred) and patched into the shared list; the whole program (one
  /// getProgramAccounts) only as a reconciliation every MARKET_REFRESH_SECONDS, at the start, and after a gap;
  /// when nothing landed, the list is confirmed as still the chain's, unless a read is owed. The buys that earned
  /// pieces go to the mint crank and the ticket index. Then what the pools need beyond their accounts, for new
  /// coins and changed pools; the backfill of pools that existed before the feed started; the files. Answers
  /// `more` when transactions were left for the next pass.
  ///
  /// A read that fails never makes market.json say "checked" about a list that may be behind the chain: the pools
  /// stay owed, `checkedAt` stands still, and the next pass reads them again (the cursor has moved, so the pools
  /// the failed pass should have read are remembered by the list itself, lib/pools.mjs `owedPools`).
  async feedPass() {
    const { cfg, connection, feed, market, poolCache } = this;
    const t0 = Date.now();
    // the newest slot this watcher saw lately serves as the pass's slot; a getSlot only when nothing read one
    const slot = this.latestSlot !== null && this.latestSlotAt !== null && t0 - this.latestSlotAt < cfg.feedIntervalSeconds * 1000 ? this.latestSlot : await connection.getSlot("confirmed");
    this.noteSlot(slot);
    const c = await feed.collect(slot);
    // the buys that earned pieces, and the wallets that received pieces by a move: the mint crank and the ticket
    // index take them at no cost; the wallets that traded on a collectible pool are hot for the settle crank
    if (c.earned.length || c.received.length) {
      const nowIso = new Date().toISOString();
      this.ticketIndex.addFromEvents(c.earned, nowIso);
      this.ticketIndex.addFromEvents(c.received, nowIso);
      this.ticketIndex.save();
      if (this.mintCrank && c.earned.length) { const n = this.mintCrank.addEarned(c.earned); if (n) { log.info(`feed: ${c.earned.length} buys earned pieces, ${n} wallets handed to the mint crank`); this.wakeMint(); } }
    }
    if (c.swaps.length && poolCache.pools) {
      const collectibles = new Set(poolCache.pools.filter((p) => p.hasHook && templateOf(p.hookProgram) === "collectible").map((p) => p.address.toBase58()));
      let sells = 0;
      for (const s of c.swaps) if (collectibles.has(s.pool)) { this.ticketIndex.markHot(s.pool, s.user, t0); if (s.direction === DIRECTION.SELL) sells += 1; }
      // a sell can leave its wallet above the peg (a buy cannot): the settle crank looks at once
      if (sells) this.wakeSettle();
    }
    // From here the cursor has moved: whatever fails below, the events read are written (finally).
    let written = 0; let flushed = false;
    const flush = () => { if (!flushed) { flushed = true; written = feed.flush(c.completeSlot); } };
    let poolsRead = "unchanged"; let pools; let m; let backfilled; let patched = null;
    try {
      // a transaction walked past unread, or a gap (more transactions than one pass lists), touched pools nobody
      // knows: the whole program is owed a read, and until it is read market.json is not marked as checked
      // (and so does a cursor the RPC no longer knows: what came between is not known either)
      if (c.unreadable > 0 || c.gap || c.cursorLost) poolCache.oweFull();
      const touched = [...new Set([...c.touchedPools, ...poolCache.owedPools])];
      // the pools are read at the state of the newest transaction walked, or later (a node behind it answers
      // -32016 and they stay owed); a pool born in this walk that the answer does not hold yet stays owed too
      const readOpts = { minSlot: c.newestSlot, created: c.created };
      if (c.gap || c.first || poolCache.fullDue(t0)) {
        try {
          await poolCache.refresh({ minSlot: c.newestSlot });
          poolsRead = "all";
          if (this.fullReadAlerted) { log.info("feed: the read of the whole pool program works again"); this.fullReadAlerted = false; }
        } catch (e) {
          log.warn(`feed: the read of every pool failed (${poolCache.fullFailures} in a row): ${errMsg(e)}. Next try at ${new Date(poolCache.nextFullAt).toISOString()}; the pools the transactions touched are read by address meanwhile`);
          if (!this.fullReadAlerted && poolCache.fullFailingFor(t0) >= FULL_READ_ALERT_MS) {
            this.fullReadAlerted = true;
            await this.notifier.alert({ pool: null, level: "warning", message: `the read of every pool (getProgramAccounts) has been failing for ${Math.round(poolCache.fullFailingFor(t0) / 60000)} minutes: ${errMsg(e)}. The pools that trade are still read one by one; a pool created in a transaction the feed could not read is missing from Explore until it works again.` });
          }
          if (touched.length && poolCache.pools) {
            try { patched = await poolCache.refreshSome(touched, readOpts); poolsRead = "patched"; } catch (e2) { log.warn(`feed: the read of the ${touched.length} pools the transactions touched failed too: ${errMsg(e2)}. They are owed, the next pass reads them again`); }
          }
        }
      } else if (touched.length || c.created.length) {
        try { patched = await poolCache.refreshSome(touched, readOpts); poolsRead = "patched"; } catch (e) {
          log.warn(`feed: the read of the ${touched.length} pools the transactions touched failed: ${errMsg(e)}. They are owed, the next pass reads them again; market.json is not marked as checked meanwhile`);
        }
      } else if (!poolCache.owed) {
        // nothing of the pool program landed since the last read: the list is still the chain's
        poolCache.confirm(t0);
      }
      if (!poolCache.pools) throw new Error("the pools could not be read yet: no market.json this pass");
      if (poolCache.slot !== null) this.noteSlot(poolCache.slot);
      pools = poolCache.pools;
      feed.register(pools);
      m = await market.refresh({ pools, bytes: poolCache.bytes, slot: poolCache.slot ?? slot });
      backfilled = await feed.backfill();
      for (const b of backfilled) log.debug(`feed: pool ${b.pool} backfilled from ${b.transactions} transactions, ${b.events} events${b.reachedCreation ? ", back to its creation" : ""}`);
    } finally {
      flush();
    }
    // checkedAt: this pass, when the list is the chain's as far as the feed can tell; the last time it was, else
    const checkedMs = poolCache.owed ? poolCache.validAt || poolCache.readAt : t0;
    const out = market.build({
      pools, bytes: poolCache.bytes, slot: poolCache.slot ?? slot, updatedAt: new Date(poolCache.readAt).toISOString(),
      checkedAt: new Date(checkedMs).toISOString(), checkedSlot: poolCache.owed ? Math.min(c.completeSlot, poolCache.slot ?? c.completeSlot) : c.completeSlot, info: (k) => feed.info(k),
    });
    market.write(out);
    this.lastFeed = {
      at: new Date().toISOString(), slot: c.completeSlot, transactions: c.transactions, sigs: c.sigs, pools: Object.keys(feed.state.pools).length,
      touched: c.touched.length, backfilled: backfilled.length, written, poolsRead, more: c.more, marketPools: out.pools.length, marketUpdatedAt: out.updatedAt,
    };
    const poolsWord = poolsRead === "all" ? "all read again" : poolsRead === "patched" ? `${patched.read} read again by address (${patched.changed} changed, ${patched.added} new, ${patched.dropped} gone${patched.owed ? `, ${patched.owed} still owed` : ""})` : poolCache.owed ? `unchanged, a read is still owed (${poolCache.owedPools.size} pools${poolCache.changesUnknown ? ", and the whole program" : ""})` : "unchanged";
    const line = `feed done: slot ${c.completeSlot}, ${c.sigs} new signatures, ${c.transactions} transactions read, ${c.touched.length} pools with new events, ${c.earned.length} buys with pieces, ${backfilled.length} backfilled, ${written} files written, pools ${poolsWord}, ${m.reads} reads for coins and rules, ${m.fetched} metadata files fetched${c.rateLimited ? `, ${c.rateLimited} pauses for a 429` : ""}${c.more ? ", more left for the next pass" : ""}, ${Date.now() - t0} ms`;
    if (c.transactions || backfilled.length || c.gap || poolCache.owed) log.info(line); else log.debug(line);
    return { more: c.more };
  }

  // ---- the pool pass --------------------------------------------------------------------------------

  async pass() {
    const t0 = Date.now();
    const nowIso = new Date(t0).toISOString();
    const { cfg, client, connection, state } = this;
    const platform = await client.platform();
    if (!platform) throw new Error("platform account not found on this RPC: wrong cluster, or init-platform was never run");
    this.platformRead = { platform, at: Date.now() };
    await this.trackPlatform(platform, nowIso);
    // the ticket index lists the collectible program again when that is due (lib/tickets.mjs)
    await this.reconcileTickets();

    // the shared list (lib/pools.mjs): with the feed on, never older than one feed pass
    let pools = [...(await this.poolCache.get(POOLS_MAX_AGE_MS.pass))];
    // The approved list, from the platform read above: a change is an alert that names the pools of the hook.
    const approvals = cfg.approvalWatch ? await this.trackApprovals(platform, pools, nowIso) : null;
    if (cfg.pool) {
      pools = pools.filter((p) => p.address.toBase58() === cfg.pool);
      if (!pools.length) throw new Error(`pool ${cfg.pool} not found`);
    }
    pools.sort((a, b) => (a.address.toBase58() < b.address.toBase58() ? -1 : 1));
    const { hooks, slot } = await readHooks(connection, pools);
    this.noteSlot(slot);
    // The manifest and the extra-accounts list of every hook program, from the bytes just read: a change is an alert,
    // and the alerts of each program are recorded on its pools in the loop below.
    this.hookAccountAlerts = cfg.hookAccountsWatch ? await this.followHookAccounts(pools, hooks, slot, nowIso) : new Map();
    // The sells as recent buyers of this pass share one budget (HOLDER_SIMS).
    this.holderBudget = { left: cfg.holderSims };
    // Names and symbols, and the mint of every coin: the mint says what kind of coin a pool trades.
    const { metas, mints } = await readCoins(connection, pools.map((p) => p.baseMint));
    // The probe wallet's balance matters only to a pool that is simulated in this pass: read then, once.
    let fundingRead = null;
    const funding = () => fundingRead ?? (fundingRead = platform.paused ? Promise.resolve({ ok: false, message: "platform paused" }) : this.ensureProbeFunded());
    // What every buyback pool's treasury holds, for the report of what waits to be spent on the coin.
    try { this.buybackTreasuries = await readBuybackTreasuries(connection, pools); } catch (e) { this.buybackTreasuries = new Map(); log.warn(`buyback treasuries could not be read this pass: ${errMsg(e)}`); }

    // Tickets of the collectible pools, from the index: the crank keeps them revealed, this is the report of where
    // they stand. The newest read of every ticket serves when it is at most TICKET_VIEW_MAX_AGE_MS old (the settle
    // sweep, the mint sweep and the reveal crank read them that often or more): the report costs no call of its own.
    this.ticketView = null;
    if (pools.some((p) => p.hasHook && templateOf(p.hookProgram) === "collectible")) {
      try {
        // (--once reads them again: its report shows the tickets as the cranks of the same run left them)
        const snap = await this.openTickets({ maxAgeMs: cfg.once ? TICKET_READ_SHARE_MS : TICKET_VIEW_MAX_AGE_MS });
        await this.observeTickets(snap, nowIso);
        this.ticketView = summarizeTickets(snap.tickets, snap.slot);
      } catch (e) {
        log.warn(`collectible tickets could not be read this pass: ${errMsg(e)}`);
      }
    }

    const entries = {};
    let hooked = 0;
    for (const pool of pools) {
      const addr = pool.address.toBase58();
      const md = metas.get(pool.baseMint.toBase58());
      const symbol = md && md.symbol ? md.symbol : null;
      this.symbols[addr] = symbol ?? "";
      const mintInfo = mints.get(pool.baseMint.toBase58()) ?? null;
      try {
        if (pool.hasHook) { hooked++; entries[addr] = await this.checkHooked(pool, hooks.get(addr), platform, symbol, nowIso, slot, funding, mintInfo); }
        else entries[addr] = await this.checkPlain(pool, platform, symbol, nowIso, funding, mintInfo);
        log.debug(`pool ${addr} ${symbol ?? ""}: ${entries[addr].score}, ${entries[addr].template}, buy tax ${entries[addr].effectiveBuyTaxBps} bps, sell tax ${entries[addr].effectiveSellTaxBps} bps`);
      } catch (e) {
        log.error(`pool ${addr}: check failed: ${errMsg(e)}`);
        entries[addr] = this.fallbackEntry(pool, e, nowIso);
      }
      // where the pool's hook stands with the approved list, and when its hook's accounts last changed
      if (approvals) entries[addr].hookApproval = hookApprovalOf(pool, approvals);
      if (cfg.hookAccountsWatch && pool.hasHook) entries[addr].hookAccountsChangedAtSlot = state.hookAccounts[pool.hookProgram.toBase58()]?.changedAtSlot ?? null;
      // A pool that launched on the curve: where it stands, as read in this pass, and the same in words, in front
      // of the reasons of the score. A seeded pool's entry carries no `curve`.
      const curve = curveEntry(pool, supplyOf(mintInfo));
      if (curve) {
        const e = entries[addr];
        e.curve = curve;
        const words = curveNotes(pool, { crank: cfg.graduate, intervalSeconds: cfg.graduateIntervalSeconds });
        const notes = (e.notes ?? []).filter((n) => !words.includes(n));
        const at = notes.findIndex((n) => n.startsWith("Score reason:"));
        notes.splice(at < 0 ? notes.length : at, 0, ...words);
        e.notes = notes;
      }
    }
    this.firstEverPass = false;

    const status = buildStatus({ updatedAt: new Date().toISOString(), cluster: cfg.cluster, platform, platformChanges: state.platform.changes.slice(-STATUS_KEEP), pools: entries, mintCrank: this.mintStatus(), approvedList: approvals });
    if (cfg.pool) log.info("status file not written in --pool mode (it would hold one pool only)");
    else { writeStatusAtomic(cfg.statusFile, status); this.lastStatus = status; }
    saveState(cfg.stateFile, state);
    const counts = { clean: 0, warning: 0, danger: 0 };
    for (const e of Object.values(status.pools)) counts[e.score]++;
    log.info(`pass done: ${pools.length} pools (${hooked} with a hook): ${counts.clean} clean, ${counts.warning} warning, ${counts.danger} danger, ${Date.now() - t0} ms`);
    return status;
  }

  async trackPlatform(platform, nowIso) {
    const snap = platformSnapshot(platform);
    const prev = this.state.platform.snapshot;
    if (prev) {
      for (const d of diffPlatform(prev, snap)) {
        this.state.platform.changes.push({ time: nowIso, field: d.field, from: d.from, to: d.to });
        await this.notifier.alert({ pool: null, level: "warning", message: `${d.field} changed from ${d.from} to ${d.to}` });
      }
      this.state.platform.changes = trimList(this.state.platform.changes);
    } else {
      log.info(`platform: admin ${snap.admin}, treasury ${snap.treasury}, protocol fee ${snap.protocolFeeBps} bps, hook fee cap ${snap.maxHookFeeBps} bps, fee override cap ${snap.maxFeeOverrideBps} bps, paused ${snap.paused}, whitelist ${snap.whitelist.join(",") || "(empty)"}`);
    }
    if (platform.paused) log.warn("platform is paused: swaps are blocked by the platform, simulations are skipped this pass");
    this.state.platform.snapshot = snap;
  }

  /// The approved-list rule and list (lib/approvals.mjs), against the last pass: a change is an alert and a line in
  /// `platform.changes`. The first pass (or a state from before this check) only records them. Answers the snapshot
  /// the pools are judged by.
  async trackApprovals(platform, pools, nowIso) {
    const prev = this.state.approvals ?? null;
    const read = approvalSnapshot(platform);
    const changes = diffApprovals(prev, read);
    const next = nextSnapshot(prev, read);
    if (!prev) log.info(`approved list: the rule is ${next.required ? "on" : "off"}, ${next.programs.length} programs on the list${next.corrupt ? ", and the list cannot be read" : ""}`);
    for (const a of approvalAlerts(changes, poolsByHook(pools))) {
      this.state.platform.changes.push({ time: nowIso, ...a.change });
      await this.notifier.alert({ pool: null, level: a.level, message: a.message });
    }
    this.state.platform.changes = trimList(this.state.platform.changes);
    this.state.approvals = next;
    return next;
  }

  /// The manifest and the extra-accounts list of every hook program of `pools` (lib/hookaccounts.mjs), from the
  /// bytes readHooks read: a change is one alert naming the hook, the account and the pools, and the same alert is
  /// recorded on each of those pools (answered by program, quiet: it is sent once, here).
  async followHookAccounts(pools, hooks, slot, nowIso) {
    const changes = trackHookAccounts(this.state.hookAccounts, hookAccountsOf(pools, hooks), { slot, nowIso });
    const byProgram = new Map();
    for (const c of changes) {
      const a = hookAccountAlert(c);
      await this.notifier.alert({ pool: null, level: a.level, message: a.message });
      if (!byProgram.has(c.program)) byProgram.set(c.program, []);
      byProgram.get(c.program).push({ ...a, quiet: true });
    }
    return byProgram;
  }

  /// The buy probe needs PROBE_SOL plus a little for rent and fees. Airdrop on localnet and devnet; alert elsewhere.
  async ensureProbeFunded() {
    const { cfg, connection, probe } = this;
    const need = cfg.probeLamports + 10_000_000n;
    let bal = await this.keeperLamports();
    if (bal >= need) return { ok: true };
    if (cfg.cluster !== "mainnet") {
      try {
        bal = await this.airdrop(Math.max(cfg.cluster === "localnet" ? 2_000_000_000 : 1_000_000_000, Number(need)));
        log.info(`probe wallet ${probe.toBase58()} received an airdrop, balance now ${Number(bal) / 1e9} SOL`);
        if (bal >= need) return { ok: true };
      } catch (e) {
        log.warn(`airdrop to the probe wallet failed: ${errMsg(e)}`);
      }
    }
    const have = (Number(bal) / 1e9).toFixed(4);
    const want = (Number(need) / 1e9).toFixed(4);
    await this.notifier.alert({ pool: null, level: "warning", message: `probe wallet ${probe.toBase58()} holds ${have} SOL, needs ${want} SOL: buy probes are skipped until it is funded` });
    return { ok: false, message: `probe wallet not funded (${have} SOL, needs ${want} SOL)` };
  }

  async checkHooked(pool, hook, platform, symbol, nowIso, slot, funding, mintInfo) {
    const { cfg, connection, client, state } = this;
    const addr = pool.address.toBase58();
    const isNew = !state.pools[addr];
    const ps = state.pools[addr] ?? (state.pools[addr] = { ...emptyPoolState(nowIso), upgradeAuthority: "unseen" });
    const alerts = [];
    const notes = [];
    const push = (level, message) => alerts.push({ level, message });
    const kindLabel = KIND_LABEL[pool.hookKind] ?? "none";
    if (isNew && !this.firstEverPass) push("info", `new pool with a ${hook.template} hook (${kindLabel})`);
    if (!hook.manifestBytes) notes.push("Hook manifest account not found.");
    if (!hook.cfgBytes && hook.template !== "custom") notes.push("Per-pool config account of this template hook not found.");

    // (a) upgrade authority of the hook program
    const ua = hook.upgradeAuthority === "unknown" ? "unknown" : hook.upgradeAuthority ? hook.upgradeAuthority.toBase58() : null;
    for (const a of upgradeAuthorityAlerts({ hookKind: pool.hookKind, prev: ps.upgradeAuthority, next: ua, whitelist: platform.whitelist.map((k) => k.toBase58()) })) push(a.level, a.message);

    // (a2) the coin itself, read from its mint this pass and never assumed. A plain coin runs no program. A
    // pegged coin runs this pool's own hook program inside every transfer, sells included: a fact, not a danger,
    // as long as the platform runs that program and no authority is left on the coin's transfer hook. A transfer
    // hook that breaks one of those is danger: the pool program refuses such coins, so it should be impossible.
    const coin = coinFacts({ pool, mintInfo, template: hook.template, collectibleCfg: hook.collectible ?? null });
    for (const p of coin.problems) push("danger", p);

    const sells = callsOnSell(hook.flags) || coin.runsHook;
    let buy; let sell; let moved = false; let cur = pool;
    let effBuy = null; let effSell = null; let mismatch = null; let mb = null; let ms = null;
    let simulated = false;
    // (b, c) the simulations, when they are due (lib/schedule.mjs): what they depend on changed, a launch window
    // runs, or the last ones are SIM_MAX_AGE_MINUTES old. Otherwise the last ones are kept and said so.
    const key = simKey({
      poolBytes: this.poolCache.bytes.get(addr) ?? JSON.stringify(pool, jsonReplacer), cfgBytes: hook.cfgBytes, manifestBytes: hook.manifestBytes,
      extraMetasBytes: hook.extraMetasBytes, deploySlot: hook.deploySlot ?? null, upgradeAuthority: ua, platform: platformSnapshot(platform),
    });
    const sched = platform.paused ? { due: false, reason: null } : simulationDue({ last: ps.hookSims ?? null, key, nowMs: Date.parse(nowIso), maxAgeMs: cfg.simMaxAgeMinutes * 60_000, windowRunning: windowRuns(hook, pool, slot) });
    if (platform.paused) {
      buy = { ok: false, amountOut: null, error: "setup: platform paused, swaps are blocked by the platform", stage: "setup", slot: null };
      sell = { ...buy, holder: null, amountIn: null };
      notes.push("Platform paused: swaps are blocked by the platform, not by this hook. Simulations skipped.");
    } else if (sched.due) {
      const f = await funding();
      // The taxes are derived from the simulated output AND the reserves the simulation ran on. A trade landing
      // between the two reads would make the numbers lie, so the pool is re-read afterwards and, if its
      // reserves moved, the simulations run once more on the fresh state.
      for (let attempt = 0; ; attempt++) {
        ({ buy, sell } = await this.simulatePair(cur, hook, f, slot, platform));
        const fresh = await client.pool(cur.address);
        moved = !fresh || fresh.reserveBase !== cur.reserveBase || fresh.reserveQuote !== cur.reserveQuote;
        if (!moved || !fresh || attempt >= 1) break;
        log.debug(`pool ${addr}: reserves moved during the check, simulating again on the fresh state`);
        cur = fresh;
      }
      simulated = true;
    } else {
      const k = ps.hookSims;
      buy = simFromJson(k.buy); sell = simFromJson(k.sell);
      ({ effBuy, effSell, mismatch, mb, ms } = k);
      moved = !!k.moved;
      notes.push(keptNote(k.at, cfg.simMaxAgeMinutes));
    }
    log.debug(`pool ${addr}: ${simulated ? `simulated (${sched.reason})` : platform.paused ? "paused" : "simulations kept"}: buy ${buy.ok ? `ok ${buy.amountOut}` : `FAIL ${buy.error}`}; sell ${sell.ok ? `ok ${sell.amountOut}` : `FAIL ${sell.error}`} as ${sell.holder ?? "nobody"}`);
    // The buy that was simulated: the configured probe, or less on a rules coin whose buy limit is running.
    const buyIn = buy.amountIn ?? cfg.probeLamports;
    if (buy.probeLimit) notes.push(`A buy limit is running on this coin: one buy can spend at most ${buy.probeLimit.maxBuyQuote} lamports until slot ${buy.probeLimit.untilSlot}. The buy probe was ${buyIn} lamports.`);
    if (buy.probeMaxWallet) notes.push(`A max wallet is running on this coin: one wallet can hold at most ${buy.probeMaxWallet.amount} raw units until slot ${buy.probeMaxWallet.untilSlot}. The buy probe was ${buyIn} lamports, the most whose coins stay under it.`);

    // (d) effective taxes versus a plain pool, and versus the declared template parameters
    if (simulated) {
      // The two platform caps ride along: the declared output of a rules pool is clamped by them, as the pool does.
      // The virtual SOL of a pool on the curve rides along too: the pool prices with it.
      const q = { reserveBase: cur.reserveBase, reserveQuote: cur.reserveQuote, virtualQuote: cur.virtualQuote, lpFeeBps: cur.lpFeeBps, protocolFeeBps: platform.protocolFeeBps, maxHookFeeBps: platform.maxHookFeeBps, maxFeeOverrideBps: platform.maxFeeOverrideBps };
      effBuy = buy.ok && !moved ? impliedTaxBps(q, DIRECTION.BUY, buyIn, buy.amountOut) : null;
      effSell = sell.ok && !moved ? impliedTaxBps(q, DIRECTION.SELL, sell.amountIn, sell.amountOut) : null;
      if (hook.template !== "custom" && !moved) {
        mb = buy.ok ? declaredMismatchBps(q, DIRECTION.BUY, buyIn, hook, buy.slot, buy.amountOut) : null;
        ms = sell.ok ? declaredMismatchBps(q, DIRECTION.SELL, sell.amountIn, hook, sell.slot, sell.amountOut) : null;
        const worst = Math.max(mb ?? -1, ms ?? -1);
        mismatch = worst < 0 ? null : worst;
      }
      // what the next passes keep while nothing changes; a buy probe the probe wallet could not pay for is tried
      // again, and so is a sell probe that could not be set up for a reason that may be gone at the next pass (the
      // trades feed had nothing for the pool yet, a read failed)
      const unfunded = !buy.ok && typeof buy.error === "string" && buy.error.startsWith("setup: probe wallet not funded");
      ps.hookSims = { at: nowIso, key, reason: sched.reason, retry: unfunded || !!sell.retry, buy: simToJson(buy), sell: simToJson(sell), effBuy, effSell, mismatch, mb, ms, moved };
    }
    if (hook.template !== "custom" && !moved) {
      if (mismatch !== null && mismatch > TOLERANCE_BPS) push("warning", `simulated output differs from the declared ${hook.template} parameters by ${mismatch} bps (buy ${mb ?? "n/a"}, sell ${ms ?? "n/a"})`);
    } else if (moved) {
      notes.push("Reserves moved twice while the pool was being checked (busy pool); effective taxes were not derived this pass.");
    }
    const cap = platformCapBps({ flags: hook.flags, maxHookFeeBps: platform.maxHookFeeBps, maxFeeOverrideBps: platform.maxFeeOverrideBps, lpFeeBps: pool.lpFeeBps });
    // The collectible template takes no fee at all: a non-zero tax there is the mismatch warning above, not this.
    const capRule = capRuleApplies(hook.template);
    if (capRule && effBuy !== null && effBuy > cap + TOLERANCE_BPS) push("danger", `effective buy tax ${effBuy} bps is above what the platform caps allow for this hook (${cap} bps)`);
    if (capRule && sells && effSell !== null && effSell > cap + TOLERANCE_BPS) push("danger", `effective sell tax ${effSell} bps is above what the platform caps allow for this hook (${cap} bps)`);

    // (e) per-pool config and manifest, byte for byte against the previous pass
    // the slot the declared numbers are read at: the simulations' own, or this pass's when they were kept
    const ctx = { time: nowIso, slot: Number((simulated ? buy.slot ?? sell.slot : null) ?? slot ?? 0) };
    const prevCfg = ps.cfg ? new Uint8Array(Buffer.from(ps.cfg, "base64")) : null;
    const prevMan = ps.manifest ? new Uint8Array(Buffer.from(ps.manifest, "base64")) : null;
    const dc = diffHookConfig(hook.template, prevCfg, hook.cfgBytes, ctx);
    const dm = diffManifest(prevMan, hook.manifestBytes, ctx);
    for (const c of [...dc.changes, ...dm.changes]) {
      ps.configChanges.push(c);
      log.info(`pool ${addr}: ${c.field} changed from ${c.from} to ${c.to} (slot ${c.slot})`);
    }
    for (const a of [...dc.alerts, ...dm.alerts]) push(a.level, a.message);
    if (dc.changes.some((c) => c.field === "buyBps" || c.field === "sellBps")) ps.lastTaxChangeAt = nowIso;
    const renderer = hook.template === "collectible" ? dc.changes.find((c) => c.field === "uriBase") : null;
    if (renderer && uriHost(renderer.from) !== uriHost(renderer.to)) ps.lastRendererMoveAt = nowIso;
    for (const a of ceilingAlerts(hook.template, decodeConfigFields(hook.template, hook.cfgBytes))) push(a.level, a.message);
    if (ps.sellOk === true && sell.ok === false && sell.stage === "swap") push(sells ? "danger" : "warning", `sells started failing: ${sell.error}`);
    if (ps.sellOk === false && sell.ok === true) push("info", "sells work again");
    if (ps.buyOk === true && buy.ok === false && buy.stage === "swap") push("warning", `buys started failing: ${buy.error}`);
    // (e2) the hook's manifest or extra-accounts list changed in this pass: the alert went out once, for the hook
    for (const a of this.hookAccountAlerts?.get(pool.hookProgram.toBase58()) ?? []) alerts.push(a);

    // (e3) sells as recent buyers (lib/holdersells.mjs): when the simulations ran and the sell probe went through, a
    // sell of 1% as wallets that bought lately and still hold. A wallet the hook refuses is a danger alert.
    const holderCheck = cfg.holderSims > 0 && sells;
    let holderSells = ps.holderSells ?? null;
    if (holderCheck && simulated) {
      if (sell.ok) {
        const r = await checkHolderSells({ connection, client, pool: cur, hook, dir: cfg.tradesDir, perPool: cfg.holderSimsPerPool, budget: this.holderBudget, exclude: [this.probe, sell.holder] });
        if (r.tried > 0) {
          if (r.failed.length) push("danger", holderSellsAlert(r).message);
          else if (holderSells && holderSells.failed > 0) push("info", "sells work again for the wallets that bought lately: the hook refused none of them");
          holderSells = { at: nowIso, tried: r.tried, passed: r.passed, failed: r.failed.length, wallets: r.failed, other: r.other.length, skipped: r.skipped };
        } else {
          // nothing simulated this time: what the last check found stands
          holderSells = { ...(holderSells ?? { at: null, tried: 0, passed: 0, failed: 0, wallets: [], other: 0 }), skipped: r.skipped };
        }
      } else {
        holderSells = { ...(holderSells ?? { at: null, tried: 0, passed: 0, failed: 0, wallets: [], other: 0 }), skipped: "the sell probe did not go through, so no wallet's sell was compared with it" };
      }
      ps.holderSells = holderSells;
    }
    if (holderCheck) notes.push(holderSellsNote(holderSells, cfg.holderSimsPerPool));

    // This pass's alerts join the record before scoring, so the score sees them as recent.
    for (const a of alerts) this.recordAlert(ps, a, nowIso);
    ps.configChanges = trimList(ps.configChanges);

    // (f) score
    const taxChangedRecently = !!ps.lastTaxChangeAt && Date.now() - Date.parse(ps.lastTaxChangeAt) < RECENT_MS;
    const rendererMovedRecently = !!ps.lastRendererMoveAt && Date.now() - Date.parse(ps.lastRendererMoveAt) < RECENT_MS;
    const scored = scorePool({
      hasHook: true, flags: hook.flags, hookKind: pool.hookKind, template: hook.template, buySim: buy, sellSim: sell,
      effectiveBuyTaxBps: effBuy, effectiveSellTaxBps: effSell, capBps: cap, declaredMismatchBps: mismatch, taxChangedRecently, rendererMovedRecently,
      manifestAdminSet: !!(hook.manifest && hook.manifest.admin), upgradeAuthority: ua, recentAlertLevels: recentLevels(ps.alerts, Date.now()),
      coinRunsHook: coin.runsHook, coinProblem: coin.problems[0] ?? null, hookFeesOwed: pool.hookFeesOwedQuote ?? 0n,
    });
    notes.push(...scored.notes);
    notes.push(...coin.notes);
    notes.push(...scored.reasons.map((r) => `Score reason: ${r}`));

    for (const a of alerts) if (!a.quiet) await this.notifier.alert({ pool: addr, symbol, level: a.level, message: a.message });

    ps.cfg = hook.cfgBytes ? Buffer.from(hook.cfgBytes).toString("base64") : null;
    ps.manifest = hook.manifestBytes ? Buffer.from(hook.manifestBytes).toString("base64") : null;
    ps.upgradeAuthority = ua;
    if (sell.ok) ps.sellOk = true; else if (sell.stage === "swap") ps.sellOk = false;
    if (buy.ok) ps.buyOk = true; else if (buy.stage === "swap") ps.buyOk = false;
    if (simulated) ps.lastSimAt = nowIso;

    const entry = {
      lastCheck: nowIso, score: scored.score, hookKind: kindLabel, template: hook.template,
      buySim: { ok: buy.ok, error: buy.error, amountOut: buy.amountOut },
      sellSim: { ok: sell.ok, error: sell.error, amountOut: sell.amountOut, holder: sell.holder },
      effectiveBuyTaxBps: effBuy, effectiveSellTaxBps: effSell, declared: declaredOf(hook, pool, ctx.slot),
      configChanges: ps.configChanges.slice(-STATUS_KEEP), alerts: ps.alerts.slice(-STATUS_KEEP), notes,
    };
    if (holderCheck) entry.holderSellFails = holderSells && holderSells.failed > 0 ? { at: holderSells.at, tried: holderSells.tried, failed: holderSells.failed, wallets: holderSells.wallets } : null;
    if (hook.template === "rules" && hook.rules) {
      // The rules in words (the SDK's own sentences), then where the coin stands right now.
      const r = hook.rules;
      notes.push("Launch rules: the rates and windows of this coin were fixed at launch. The program has no instruction that changes them, so any change in that part of its config is a danger alert.");
      for (const sentence of describeRules(r)) notes.push(sentence);
      const at = BigInt(ctx.slot || slot || 0);
      const sniper = rulesSniperFee(at, r.startSlot, r.sniperSlots, r.sniperStartFeeBps, pool.lpFeeBps);
      if (sniper !== null) notes.push(`The sniper fee is running: a buy pays a pool fee of ${sniper} bps at slot ${at}, back to the pool's ${pool.lpFeeBps} bps at slot ${r.startSlot + r.sniperSlots}. Nobody can add liquidity until then.`);
      else if (r.sniperSlots > 0n) notes.push(`The sniper fee ended at slot ${r.startSlot + r.sniperSlots}.`);
      const limit = rulesBuyLimit(r, at);
      if (!limit && r.maxBuyQuote > 0n) notes.push(`The buy limit ended at slot ${r.startSlot + r.limitSlots}.`);
      const isStrict = r.kind === RULES_KIND.STRICT;
      const counted = isStrict ? "in holder records" : "staked";
      const who = isStrict ? "the wallets with a holder record" : "the stakers";
      if (r.buy.holdersBps > 0 || r.sell.holdersBps > 0) {
        notes.push(rulesStakersEligible(r)
          ? `${r.totalStaked} raw coins are ${counted}, at least the ${r.minEligible} needed: the holders' share of a trade goes to ${who}.`
          : `${r.totalStaked} raw coins are ${counted}, under the ${r.minEligible} needed (0.1% of the supply at launch): the holders' share of a trade goes to the burn pot. A trader pays the same either way.`);
      }
      if (isStrict) {
        // where the three windows of a strict coin stand
        const w = strictWindows(r);
        notes.push("A strict coin: the rules program is also the coin's transfer hook, so its rules run inside every transfer of the coin, sends between wallets included.");
        if (strictMaxWalletRuns(r, at)) notes.push(`The max wallet is running: no wallet can end a buy or a receive above ${r.maxWalletAmount} raw units until slot ${w.maxWalletUntil}. Nobody can add liquidity until then.`);
        else if (r.maxWalletSlots > 0) notes.push(`The max wallet ended at slot ${w.maxWalletUntil}.`);
        if (strictEarlyWindowRuns(r, at)) notes.push(`The early window is running until slot ${w.earlyUntil}: coins bought in it stay in the buyer's wallet until slot ${w.earlyUnlock}, and a buy in it needs the buyer's holder record.`);
        else if (strictEarlyLocked(r, at)) notes.push(`The early window ended at slot ${w.earlyUntil}. Coins bought in it stay in their wallets until slot ${w.earlyUnlock}.`);
        else if (r.earlySlots > 0) notes.push(`The early lock ended at slot ${w.earlyUnlock}.`);
      }
    }
    const kind = burnKind(pool);
    if (kind && (kind === "buyback" ? hook.buyback : hook.rules)) {
      // What waits to be spent on the coin, and who runs the buy. The burn pot of a rules coin is counted the
      // way the program settles it, with the fee of the last trade in.
      const seen = burnPot({ kind, pool: cur, cfgBytes: hook.cfgBytes, treasuryBytes: this.buybackTreasuries.get(addr) ?? null });
      if (seen) {
        const view = burnView({ kind, pool: cur, platform, cfg: seen.cfg, pot: seen.pot, slot: ctx.slot || slot });
        entry.burn = { ...view, keeper: state.burn.pools[addr] ?? null };
        const where = kind === "buyback" ? "buyback treasury" : "burn pot";
        const below = kind === "buyback" && seen.held > 0n && seen.pot === 0n ? ` That is under this coin's minimum of ${seen.cfg.minQuote} lamports: a buyback runs once the treasury holds that much.` : "";
        notes.push(`${seen.held} lamports wait in the ${where}.${below} One buy spends at most ${view.capBps / 100}% of the pool's SOL, against a record of the pool at least 25 slots old, and burns what it buys.`);
        notes.push(cfg.burn
          ? `Anyone may run that buy. This watcher does it every ${cfg.burnIntervalSeconds} s, for a pot of ${cfg.burnMinPotLamports} lamports or more.`
          : "Anyone may run that buy. This watcher runs without the burn keeper, so somebody else must: a pot that nobody runs keeps growing.");
      }
    }
    if (hook.template === "collectible") {
      // Where this pool's tickets stand. When the tickets could not be read this pass, the last known numbers.
      entry.tickets = this.ticketView ? (this.ticketView.get(addr) ?? NO_TICKETS()) : (ps.lastEntry && ps.lastEntry.tickets) || NO_TICKETS();
      // What kind of coin backs the pieces, as read from its mint this pass.
      entry.coin = coinStatus(coin);
      if (coin.kind === "pegged") {
        // The peg of a pegged coin, in words. The coin's own program keeps it inside every transfer; the
        // Metaplex assets follow through `deliver` and `reap`; `settle` is left with one case.
        notes.push("Pieces are pegged to the coin: a wallet keeps at most one piece per unit of coins it holds. A sell burns the pieces the coins no longer back inside the swap, newest first. Waiting pieces are dropped first.");
        notes.push(cfg.upkeep
          ? `The Metaplex assets follow the wallet lists. Anyone may deliver a moved piece's asset or burn a burned piece's asset. This watcher does it every ${cfg.upkeepIntervalSeconds} s.`
          : "The Metaplex assets follow the wallet lists. Anyone may deliver a moved piece's asset or burn a burned piece's asset. This watcher runs without the upkeep crank, so somebody else must.");
        notes.push(cfg.settle
          ? `A settle is still needed for one case: a holder that burns its coins directly. Anyone may settle such a wallet. This watcher does it every ${cfg.settleIntervalSeconds} s.`
          : "A settle is still needed for one case: a holder that burns its coins directly. Anyone may settle such a wallet. This watcher runs without the settle crank, so somebody else must.");
      } else {
        // The peg of a plain coin, in words. The hook itself never sees a sell; the pieces follow the coins
        // through `settle`.
        notes.push("Pieces are pegged to the coin: a wallet keeps at most one piece per unit of coins it holds. Coins that leave by a sell or a transfer take their pieces with them, newest first: waiting pieces are dropped, minted pieces are burned.");
        notes.push(cfg.settle
          ? `Anyone may settle a wallet that is above the peg. This watcher does it every ${cfg.settleIntervalSeconds} s.`
          : "Anyone may settle a wallet that is above the peg. This watcher runs without the settle crank, so somebody else must.");
      }
      // One approval: a buy that pays a deposit for its NFTs gets them minted into the wallet by a keeper.
      notes.push(cfg.mint
        ? "A buy can pay a deposit for its NFTs in the same transaction. This watcher then mints them into the buyer's wallet a few seconds after the buy, paid back from that deposit."
        : "A buy can pay a deposit for its NFTs in the same transaction. Anyone may then mint them into the buyer's wallet. This watcher runs without the mint crank, so somebody else must, or the buyer mints them.");
      if (entry.tickets.awaitingReveal > 0) {
        notes.push(cfg.crank
          ? `Waiting for a reveal: ${pcs(entry.tickets.awaitingReveal)}. The crank reveals every ${cfg.revealIntervalSeconds} s.`
          : `Waiting for a reveal: ${pcs(entry.tickets.awaitingReveal)}. This watcher runs with --no-crank, so somebody else must reveal within 512 slots.`);
      }
      if (entry.tickets.expired > 0) notes.push(`Not revealed in time: ${pcs(entry.tickets.expired)}, held in expired batches. They mint as the common tier.`);
    }
    ps.lastEntry = JSON.parse(JSON.stringify(entry, jsonReplacer));
    return entry;
  }

  /// No hook: nothing can block or tax a trade, so a light entry with the simulations refreshed once an hour.
  async checkPlain(pool, platform, symbol, nowIso, funding, mintInfo) {
    const { cfg, connection, client, state } = this;
    const addr = pool.address.toBase58();
    const isNew = !state.pools[addr];
    const ps = state.pools[addr] ?? (state.pools[addr] = emptyPoolState(nowIso));
    const alerts = [];
    if (isNew && !this.firstEverPass) alerts.push({ level: "info", message: "new pool without a hook" });
    // A pool without a hook must trade a coin that runs no program. A transfer hook on its coin is danger.
    const coin = coinFacts({ pool, mintInfo, template: "none" });
    for (const p of coin.problems) alerts.push({ level: "danger", message: p });
    const q = { reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote, virtualQuote: pool.virtualQuote, lpFeeBps: pool.lpFeeBps, protocolFeeBps: platform.protocolFeeBps };
    // a sell probe that found no holder only because the trades feed had nothing for the pool yet is tried again
    const due = !ps.lastSimAt || !ps.lastSims || !!ps.lastSims.retry || Date.now() - Date.parse(ps.lastSimAt) >= cfg.noHookSimSeconds * 1000;
    let buy; let sell; let effBuy = null; let effSell = null;
    if (platform.paused) {
      buy = { ok: false, amountOut: null, error: "setup: platform paused, swaps are blocked by the platform", stage: "setup" };
      sell = { ...buy, holder: null };
    } else if (due) {
      const f = await funding();
      ({ buy, sell } = await this.simulatePair(pool, null, f, null, null));
      effBuy = buy.ok ? impliedTaxBps(q, DIRECTION.BUY, cfg.probeLamports, buy.amountOut) : null;
      effSell = sell.ok ? impliedTaxBps(q, DIRECTION.SELL, sell.amountIn, sell.amountOut) : null;
      ps.lastSimAt = nowIso;
      ps.lastSims = { buy: simToState(buy), sell: simToState(sell), effBuy, effSell, retry: !!sell.retry };
    } else {
      buy = simFromState(ps.lastSims.buy);
      sell = simFromState(ps.lastSims.sell);
      effBuy = ps.lastSims.effBuy ?? null;
      effSell = ps.lastSims.effSell ?? null;
    }
    const scored = scorePool({ hasHook: false, buySim: buy, sellSim: sell, coinProblem: coin.problems[0] ?? null });
    const notes = [...scored.notes, `Pools without a hook are simulated once every ${Math.round(cfg.noHookSimSeconds / 60)} minutes; last simulation ${ps.lastSimAt ?? "pending"}.`];
    notes.push(...scored.reasons.map((r) => `Score reason: ${r}`));
    for (const a of alerts) {
      this.recordAlert(ps, a, nowIso);
      await this.notifier.alert({ pool: addr, symbol, level: a.level, message: a.message });
    }
    const entry = {
      lastCheck: nowIso, score: scored.score, hookKind: "none", template: "none",
      buySim: { ok: buy.ok, error: buy.error, amountOut: buy.amountOut },
      sellSim: { ok: sell.ok, error: sell.error, amountOut: sell.amountOut, holder: sell.holder ?? null },
      effectiveBuyTaxBps: effBuy, effectiveSellTaxBps: effSell, declared: null,
      configChanges: [], alerts: ps.alerts.slice(-STATUS_KEEP), notes,
    };
    ps.lastEntry = JSON.parse(JSON.stringify(entry, jsonReplacer));
    return entry;
  }

  /// (b) a buy of PROBE_SOL as the probe wallet; (c) a sell of 1% of a large holder's balance, as that holder
  /// (lib/simulate.mjs simulateProbes; `hook` null for a pool without a hook). The holders come from the RPC's list
  /// of the coin's largest accounts, or, on an RPC that refuses that call (a shared node), from the wallets that
  /// traded the pool lately in the trades feed's files (status/trades, read from disk, so a `--pool` run finds the
  /// service's files too). Finding no holder never fails the check: the sell is then not set up, said in words.
  async simulatePair(pool, hook, funding, slot, platform) {
    const { cfg, connection, client } = this;
    const addr = pool.address.toBase58();
    return simulateProbes({
      connection, client, pool, hook, probe: this.probe, probeLamports: cfg.probeLamports, funding, slot, platform,
      traders: () => tradersOf(cfg.tradesDir, addr),
      onHolders: (found) => {
        if (found.refusedNow) log.warn(`the RPC refuses getTokenLargestAccounts (${found.largestError}): for the next 24 hours the sell probes take their holders from the trades feed`);
        if (!found.holders.length) log.debug(`pool ${addr}: ${found.reason}${found.largestError ? ` (largest accounts: ${found.largestError})` : ""}`);
        else if (found.source === "feed") log.debug(`pool ${addr}: sell probe holders from the trades feed: ${found.holders.length}`);
      },
    });
  }

  /// The recorded alerts follow the Telegram rule: the same text is not written again within the cooldown,
  /// so a condition that persists shows once per cooldown instead of once per pass.
  recordAlert(ps, a, nowIso) {
    const now = Date.parse(nowIso);
    const windowMs = this.cfg.alertCooldownSeconds * 1000;
    const dup = ps.alerts.some((x) => x.message === a.message && now - Date.parse(x.time) < windowMs);
    // `keeper` marks an alert about the keeper's own lateness: shown on the pool, never counted in its score.
    if (!dup) ps.alerts.push(a.keeper ? { time: nowIso, level: a.level, message: a.message, keeper: true } : { time: nowIso, level: a.level, message: a.message });
    ps.alerts = trimList(ps.alerts);
  }

  /// One failing pool never stops the pass: show the previous result with a note, or an honest "could not check".
  fallbackEntry(pool, err, nowIso) {
    const addr = pool.address.toBase58();
    const ps = this.state.pools[addr];
    // in words: the site prints this as it stands (an RPC error can carry a whole JSON answer)
    const msg = plainError(err);
    if (ps && ps.lastEntry) {
      const notes = (ps.lastEntry.notes ?? []).filter((n) => !n.startsWith("Check failed this pass"));
      return { ...ps.lastEntry, lastCheck: nowIso, notes: [...notes, `Check failed this pass: ${msg}. Showing the previous result.`] };
    }
    return {
      lastCheck: nowIso, score: "warning", hookKind: KIND_LABEL[pool.hookKind] ?? "none", template: pool.hasHook ? templateOf(pool.hookProgram) : "none",
      buySim: { ok: false, error: `watcher: ${msg}`, amountOut: null }, sellSim: { ok: false, error: `watcher: ${msg}`, amountOut: null, holder: null },
      effectiveBuyTaxBps: null, effectiveSellTaxBps: null, declared: null, configChanges: [], alerts: [],
      notes: [`The watcher could not check this pool: ${msg}`],
    };
  }
}

async function main() {
  let loaded;
  try { loaded = loadConfig(); } catch (e) { console.error(`${new Date().toISOString()} error ${errMsg(e)}`); console.error(HELP); return 2; }
  const { cfg, args, envFileFound } = loaded;
  if (args.help) { console.log(HELP); return 0; }
  setVerbose(cfg.verbose);
  log.info("Programmable watcher starting");
  if (!envFileFound) log.info("  no watcher/.env found, using defaults (copy .env.example to .env to change them)");
  for (const [k, v] of Object.entries(describeConfig(cfg))) log.info(`  ${k.padEnd(14)} ${v}`);

  // Every RPC call gets a timeout: fetch has none, and a hung endpoint must not freeze the pass forever.
  const connection = new Connection(cfg.rpcUrl, {
    commitment: "confirmed",
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(cfg.rpcTimeoutMs) }),
  });
  // The platform lookup table, when the deploy wrote one. Simulations do not need it; the client takes it so
  // that anything built through client.buildTx compiles the same way the site does.
  const lookupTable = loadLookupTable(cfg.cluster);
  const client = new HookpoolClient(connection, lookupTable ? { lookupTable } : {});
  log.info(`  lookup table   ${lookupTable ? lookupTable.toBase58() : "none (not needed for simulations)"}`);
  const state = loadState(cfg.stateFile);
  const notifier = createNotifier({ cfg, state, log });
  const probe = loadOrCreateProbe(cfg.probeKeypair);
  const duties = [cfg.crank ? "reveals" : null, cfg.settle ? "settles" : null, cfg.upkeep ? "deliveries and burns of pegged coins" : null, cfg.burn ? "the buybacks and burns of buyback and rules pools" : null, cfg.graduate ? "the graduation of pools on the curve" : null, cfg.mint ? "the mints of NFTs for buys that paid a deposit" : null].filter(Boolean);
  log.info(`  probe wallet   ${probe.publicKey.toBase58()}${probe.created ? ` (new keypair written to ${cfg.probeKeypair})` : ""}${duties.length ? `, also the keeper that pays for ${duties.join(", ")}` : ""}`);
  // One feed per state file: a second watcher on the same files (a --once next to the service) runs without it.
  // The lock is settled BEFORE the watcher is made: everything that depends on the feed (the one list of pools is
  // the feed's to read, or each loop's) follows the outcome. The lock names the process, the boot and the
  // process's start, so a lock left from before a reboot, or under a process id the system reused, is taken over.
  let feedLocked = null;
  if (cfg.feed) {
    const lock = acquireFeedLock(cfg.feedStateFile, { dir: cfg.lockDir });
    if (lock.fallback) log.warn(`${lock.fallback}: the feed's lock is kept next to its state file instead (${lock.file})`);
    if (!lock.ok) {
      if (lock.error) log.error(`${lock.error}: this run goes without the trades feed, so that no two feeds run on the same files. /health answers ok false while it runs this way.`);
      else log.error(`the trades feed on ${cfg.feedStateFile} is run by another watcher right now (process ${lock.pid}, since ${lock.since ?? "unknown"}; lock ${lock.file}): this run goes without the feed, so that no transaction is read twice. /health answers ok false while it runs this way. Use --pool <address> for a check by hand, or stop the other watcher first.`);
      cfg.feed = false;
      feedLocked = { pid: lock.pid, since: lock.since ?? null };
    } else {
      process.on("exit", lock.release);
    }
  }
  const watcher = new Watcher({ cfg, connection, client, state, notifier, probe: probe.publicKey, keeper: probe.keypair });
  watcher.feedLocked = feedLocked;
  // the ticket index is written at most once a minute: the last changes go to disk when the process ends
  process.on("exit", () => { try { watcher.ticketIndex.save({ force: true }); } catch { /* the next start lists the program again */ } });
  if (cfg.feed) {
    watcher.feed = new TradesFeed({ connection, dir: cfg.tradesDir, stateFile: cfg.feedStateFile, log, maxTxPerPass: cfg.feedMaxTxPerPass });
    watcher.market = new Market({
      connection, cluster: cfg.cluster, file: cfg.marketFile, cacheFile: cfg.marketCacheFile, log,
      mintRefreshMs: cfg.mintRefreshSeconds * 1000, metadataRefreshMs: cfg.metadataRefreshSeconds * 1000, marketRefreshMs: cfg.marketRefreshSeconds * 1000, metadataTimeoutMs: cfg.metadataTimeoutMs,
    });
    const st = watcher.feed.state;
    log.info(`  feed state     ${st.startSlot === null ? "new: the first pass sets the cursor and backfills every pool once" : `started at slot ${st.startSlot}, cursor at slot ${st.cursorSlot ?? "none"}, ${Object.keys(st.pools).length} pools known, ${watcher.feed.pending().length} still to backfill`}`);
  }
  // The ticket index: the collectible program is listed once at every start (one call, addresses only), so that
  // a buy made while the watcher was down is found before anything reads the index; empty on a first start (or
  // after the file was deleted), the index is built from that listing. A listing that fails is tried again by
  // the pool pass, later, and the cranks work from the tickets the file knows meanwhile.
  const idx = watcher.ticketIndex;
  log.info(`  ticket index   ${idx.size()} tickets${idx.state.reconciledAt ? `, listed at ${idx.state.reconciledAt}` : ", never listed"}; listing the collectible program now`);
  await watcher.reconcileTickets({ force: true });

  let server = null;
  if (!cfg.noServer) {
    const getCrank = () => ({ enabled: cfg.crank, lastCrankAt: watcher.lastCrank.at, lastCrankRevealed: watcher.lastCrank.revealed, intervalSeconds: cfg.revealIntervalSeconds });
    const getSettle = () => ({ enabled: cfg.settle, lastSettleAt: watcher.lastSettle.at, lastSettleSent: watcher.lastSettle.sent, intervalSeconds: cfg.settleIntervalSeconds, totals: state.settle.totals });
    const getUpkeep = () => ({ enabled: cfg.upkeep, lastUpkeepAt: watcher.lastUpkeep.at, lastUpkeepSent: watcher.lastUpkeep.sent, intervalSeconds: cfg.upkeepIntervalSeconds, totals: state.upkeep.totals });
    const getBurn = () => ({ enabled: cfg.burn, lastBurnAt: watcher.lastBurn.at, lastBurnSent: watcher.lastBurn.sent, intervalSeconds: cfg.burnIntervalSeconds, totals: state.burn.totals, syncEnabled: cfg.holderSync, syncTotals: state.burn.syncTotals ?? null });
    const getGraduate = () => ({ enabled: cfg.graduate, lastGraduateAt: watcher.lastGraduate.at, lastGraduateSent: watcher.lastGraduate.sent, intervalSeconds: cfg.graduateIntervalSeconds, totals: state.graduate.totals });
    const getMint = () => watcher.mintStatus();
    const getFeed = () => ({
      enabled: cfg.feed, locked: watcher.feedLocked, lastFeedAt: watcher.lastFeed.at, intervalSeconds: cfg.feedIntervalSeconds, feedSlot: watcher.lastFeed.slot, latestSlot: watcher.latestSlot,
      pools: watcher.feed ? Object.keys(watcher.feed.state.pools).length : 0, transactions: watcher.feed ? watcher.feed.state.transactions : 0, unreadable: watcher.feed ? watcher.feed.state.unreadable : 0,
      marketUpdatedAt: watcher.lastFeed.marketUpdatedAt ?? null, marketPools: watcher.lastFeed.marketPools ?? 0,
    });
    const getReads = () => watcher.readsStatus();
    const getTickets = () => watcher.ticketIndex.status();
    const getPools = () => watcher.poolsStatus();
    const getNotify = () => watcher.notifyStatus();
    server = startServer({
      port: cfg.port, statusFile: cfg.statusFile, marketFile: cfg.feed ? cfg.marketFile : null, tradesDir: cfg.feed ? cfg.tradesDir : null, cluster: cfg.cluster,
      getStatus: () => watcher.lastStatus, getCrank, getSettle, getUpkeep, getBurn, getGraduate, getFeed, getMint, getReads, getTickets, getPools, getNotify,
      notify: cfg.notify ? { handle: async (signature) => watcher.notify(signature), perMinute: cfg.notifyPerMinute, globalPerMinute: cfg.notifyGlobalPerMinute } : null,
      staleAfterMs: cfg.intervalSeconds * 1000 * 5, log,
    });
  }

  if (cfg.once) {
    try {
      // The feed first: it reads the pools that every pass below then shares.
      if (cfg.feed) {
        await watcher.feedPass();
        const f = watcher.lastFeed;
        log.info(`feed totals: ${watcher.feed.state.transactions} transactions read since the feed started, ${f.pools} pools known, ${watcher.feed.pending().length} still to backfill, market.json holds ${f.marketPools} pools`);
      }
      // The cranks first, so the pool pass reports the tickets as they stand right after them.
      if (cfg.crank) await watcher.crank();
      if (cfg.settle) {
        await watcher.settle();
        // There is no /health in this mode, so the running totals go to the log.
        const t = state.settle.totals;
        log.info(`settle totals: ${t.sent} settles sent, ${t.failed} failed, ${t.dropped} pieces dropped, ${t.burned} pieces burned, ${t.rentLamports} lamports of rent received, ${t.feeLamports} lamports of fees paid`);
      }
      if (cfg.upkeep) {
        await watcher.upkeep();
        const t = state.upkeep.totals;
        log.info(`upkeep totals: ${t.deliveries} deliveries sent, ${t.reaps} burns sent, ${t.failed} failed, ${t.delivered} assets delivered, ${t.burned} assets burned, ${t.rentLamports} lamports of rent received, ${t.feeLamports} lamports of fees paid`);
      }
      if (cfg.burn) {
        await watcher.burn();
        const t = state.burn.totals;
        log.info(`burn totals: ${t.calls} calls sent (${t.observed} observed, ${t.waited} waited, ${t.bought} bought), ${t.failed} failed, ${t.spentLamports} lamports spent on burns, ${t.feeLamports} lamports of fees paid`);
        if (cfg.holderSync) {
          const y = state.burn.syncTotals ?? NO_SYNC_TOTALS();
          log.info(`sync totals: ${y.records} holder records lowered in ${y.sent} transactions, ${y.failed} failed, ${y.feeLamports} lamports of fees paid`);
        }
      }
      if (cfg.graduate) {
        await watcher.graduate();
        const t = state.graduate.totals;
        log.info(`graduate totals: ${t.sent} graduate calls sent (${t.graduated} graduated a coin, ${t.already} found it graduated already), ${t.failed} failed, ${t.feeLamports} lamports of fees paid`);
      } else {
        log.info("graduate crank off: no graduate is sent (--no-graduate, --no-crank or GRADUATE_KEEPER=off)");
      }
      if (cfg.mint) {
        // one round: every ticket with a deposit read once, then the passes while a wallet waits for its block,
        // 20 seconds at most
        const until = Date.now() + 20_000;
        while ((await watcher.mint()).busy && Date.now() < until) await sleep(MINT_FAST_MS);
        const t = state.mint.totals;
        log.info(`mint totals: ${t.sent} mints sent, ${t.pieces} pieces minted into wallets, ${t.failed} failed, ${t.paidLamports} lamports paid back from deposits, ${t.feeLamports} lamports of fees paid, keeper ${t.netLamports} lamports over all of them, ${t.mintedFirst} minted first by their wallet, ${t.short} with a deposit too small, ${t.refused} refused by a simulation`);
      } else {
        log.info("mint crank off: no mint_for is sent (--no-mint, --no-crank or MINT_CRANK=off)");
      }
      // the report shows the pools as the cranks left them (with the feed on, the list is the feed's: read it again here)
      if (cfg.feed) { try { await watcher.poolCache.refresh(); } catch (e) { log.warn(`the pools could not be read again for the report: ${errMsg(e)}`); } } else watcher.poolCache.invalidate();
      const status = await watcher.pass();
      if (cfg.pool) console.log(JSON.stringify(status.pools[cfg.pool], jsonReplacer, 2));
      else console.log(summaryTable(status, watcher.symbols));
      return 0;
    } catch (e) {
      log.error(`pass failed: ${errMsg(e)}`);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up|timeout/i.test(errMsg(e))) log.error(`the RPC at ${hostOf(cfg.rpcUrl) || "RPC_URL"} is not reachable`);
      return 1;
    }
  }

  // A service that runs without the feed it was asked for serves no market.json: the site's Explore and coin pages
  // then read the chain themselves. Said once, loudly (the log above, /health ok false, this alert).
  if (watcher.feedLocked) {
    await notifier.alert({ pool: null, level: "warning", message: `this watcher started WITHOUT the trades feed: its lock is held by process ${watcher.feedLocked.pid} (since ${watcher.feedLocked.since ?? "unknown"}). No market.json is served until that process stops and this one restarts. If no other watcher runs on these files, the lock is stale: restart this one.` });
  }

  const ac = new AbortController();
  const stop = (sig) => {
    if (watcher.stopping) return;
    watcher.stopping = true;
    watcher.stopNotify();
    log.info(`got ${sig}, finishing the current pass and stopping`);
    ac.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("unhandledRejection", (e) => log.error("unhandled rejection:", errMsg(e)));
  // An exception nobody caught (a request handler, a timer) must not take the loops down with it: it is logged,
  // said once in an alert, and the loops go on. The pass that was running when it happened fails on its own.
  let uncaughtAlerted = false;
  process.on("uncaughtException", (e) => {
    log.error(`uncaught exception (the loops go on): ${e && e.stack ? e.stack : errMsg(e)}`);
    if (!uncaughtAlerted) { uncaughtAlerted = true; notifier.alert({ pool: null, level: "warning", message: `uncaught exception in the watcher (it keeps running): ${errMsg(e)}` }).catch(() => {}); }
  });

  // A sleep that a wake-up call (`wake`) or the stop signal ends early.
  const sleepOrWake = (ms, setWake) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); ac.signal.removeEventListener("abort", finish); setWake(() => {}); resolve(); };
    const t = setTimeout(finish, ms);
    ac.signal.addEventListener("abort", finish, { once: true });
    setWake(finish);
  });

  // The trades feed and market.json have their own clock: every FEED_INTERVAL_SECONDS. A pass that left
  // transactions for the next one is followed by it at once. It starts first, and the other loops wait for its
  // first pass (at most 15 s), so they find the pools read.
  const feedLoop = !cfg.feed ? Promise.resolve() : (async () => {
    while (!watcher.stopping) {
      const t0 = Date.now();
      let more = false;
      try {
        more = (await watcher.feedPass()).more;
      } catch (e) {
        log.error(`feed pass failed: ${errMsg(e)}`);
      }
      if (watcher.stopping) break;
      await sleep(more ? 2000 : Math.max(1000, cfg.feedIntervalSeconds * 1000 - (Date.now() - t0)), ac.signal);
    }
  })();
  if (cfg.feed) {
    const until = Date.now() + 15_000;
    while (!watcher.lastFeed.at && !watcher.stopping && Date.now() < until) await sleep(200, ac.signal);
  }

  // The reveal crank runs on its own, faster clock: a batch must be revealed within 512 slots (about
  // 3.5 minutes), and the 60 s pool pass can take long on a busy day.
  const crankLoop = !cfg.crank ? Promise.resolve() : (async () => {
    while (!watcher.stopping) {
      const t0 = Date.now();
      try {
        await watcher.crank();
      } catch (e) {
        log.error(`crank failed: ${errMsg(e)}`);
        await notifier.alert({ pool: null, level: "warning", message: `reveal crank failed: ${errMsg(e)}` });
      }
      if (watcher.stopping) break;
      await sleep(Math.max(2000, cfg.revealIntervalSeconds * 1000 - (Date.now() - t0)), ac.signal);
    }
  })();

  // The mint crank has its own clock. The buys reach it from the feed and from POST /notify, which wake it at once;
  // its own poll of the collectible program is the safety net, every MINT_INTERVAL_SECONDS. While a wallet waits
  // for its deciding block the passes come every half second.
  const mintLoop = !cfg.mint ? Promise.resolve() : (async () => {
    while (!watcher.stopping) {
      const t0 = Date.now();
      let busy = false;
      try {
        busy = (await watcher.mint()).busy;
      } catch (e) {
        log.error(`mint crank failed: ${errMsg(e)}`);
        await notifier.alert({ pool: null, level: "warning", message: `mint crank failed: ${errMsg(e)}` });
      }
      if (watcher.stopping) break;
      await sleepOrWake(busy ? MINT_FAST_MS : Math.max(500, cfg.mintIntervalSeconds * 1000 - (Date.now() - t0)), (wake) => { watcher.wakeMint = wake; });
    }
  })();

  // The settle crank has its own clock too. A pass that left work behind (a wallet with more burns than one
  // settle takes, or more wallets than one pass sends) is followed by the next one at once.
  const settleLoop = !cfg.settle ? Promise.resolve() : (async () => {
    while (!watcher.stopping) {
      const t0 = Date.now();
      let more = 0;
      try {
        more = (await watcher.settle()).more;
      } catch (e) {
        log.error(`settle crank failed: ${errMsg(e)}`);
        await notifier.alert({ pool: null, level: "warning", message: `settle crank failed: ${errMsg(e)}` });
      }
      if (watcher.stopping) break;
      // a feed pass that saw a sell on a collectible pool wakes this loop (once a feed pass at most), so a sell made
      // with another client is settled right after the feed read it
      await sleepOrWake(more > 0 ? 2000 : Math.max(2000, cfg.settleIntervalSeconds * 1000 - (Date.now() - t0)), (wake) => { watcher.wakeSettle = wake; });
    }
  })();

  // The upkeep crank (pegged coins) has its own clock too, the shortest: a holder looks at its wallet right after
  // a transfer. A pass that left transactions unsent is followed by the next one at once.
  const upkeepLoop = !cfg.upkeep ? Promise.resolve() : (async () => {
    while (!watcher.stopping) {
      const t0 = Date.now();
      let more = 0;
      try {
        more = (await watcher.upkeep()).more;
      } catch (e) {
        log.error(`upkeep crank failed: ${errMsg(e)}`);
        await notifier.alert({ pool: null, level: "warning", message: `upkeep crank failed: ${errMsg(e)}` });
      }
      if (watcher.stopping) break;
      await sleep(more > 0 ? 2000 : Math.max(2000, cfg.upkeepIntervalSeconds * 1000 - (Date.now() - t0)), ac.signal);
    }
  })();

  // The burn keeper has its own clock too. The chain takes a call on a pool at most once every 25 slots, so a
  // pass finds each pool either due or too soon. A pass that left due pools uncalled (more than BURN_MAX_CALLS)
  // is followed by the next one at once.
  const burnLoop = !cfg.burn ? Promise.resolve() : (async () => {
    while (!watcher.stopping) {
      const t0 = Date.now();
      let more = 0;
      try {
        more = (await watcher.burn()).more;
      } catch (e) {
        log.error(`burn keeper failed: ${errMsg(e)}`);
        await notifier.alert({ pool: null, level: "warning", message: `burn keeper failed: ${errMsg(e)}` });
      }
      if (watcher.stopping) break;
      await sleep(more > 0 ? 2000 : Math.max(2000, cfg.burnIntervalSeconds * 1000 - (Date.now() - t0)), ac.signal);
    }
  })();

  // The graduate crank has its own clock too. A pass that left due pools uncalled is followed by the next one at once.
  const graduateLoop = !cfg.graduate ? Promise.resolve() : (async () => {
    while (!watcher.stopping) {
      const t0 = Date.now();
      let more = 0;
      try {
        more = (await watcher.graduate()).more;
      } catch (e) {
        log.error(`graduate crank failed: ${errMsg(e)}`);
        await notifier.alert({ pool: null, level: "warning", message: `graduate crank failed: ${errMsg(e)}` });
      }
      if (watcher.stopping) break;
      await sleep(more > 0 ? 2000 : Math.max(2000, cfg.graduateIntervalSeconds * 1000 - (Date.now() - t0)), ac.signal);
    }
  })();

  while (!watcher.stopping) {
    const t0 = Date.now();
    try {
      await watcher.pass();
    } catch (e) {
      log.error(`pass failed: ${errMsg(e)}`);
      await notifier.alert({ pool: null, level: "warning", message: `pass failed: ${errMsg(e)}` });
    }
    if (watcher.stopping) break;
    const wait = Math.max(5000, cfg.intervalSeconds * 1000 - (Date.now() - t0));
    log.debug(`next pass in ${Math.round(wait / 1000)} s`);
    await sleep(wait, ac.signal);
  }
  await feedLoop;
  await crankLoop;
  await mintLoop;
  await settleLoop;
  await upkeepLoop;
  await burnLoop;
  await graduateLoop;
  watcher.stopNotify();
  try { saveState(cfg.stateFile, state); } catch (e) { log.warn(`could not save the state: ${errMsg(e)}`); }
  watcher.ticketIndex.save({ force: true });
  if (server) server.close();
  log.info("stopped");
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { log.error(e && e.stack ? e.stack : errMsg(e)); process.exit(1); });
