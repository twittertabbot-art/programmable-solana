// Module Mode: a coin and the modules it runs, each a row with a toggle. A coin with every
// module off is a plain coin with no hook. The shared parts of a launch are in launch-core.js,
// the strict modules in launch-strict.js.
import { boot, ctx, H, $, el, fmtSol, fmtPct, fmtUnits, fmtSpan, fmtDate, minutesToSlots, slotsToSeconds, applyBps } from "./common.js";
import { startLaunch, moduleRow, sol, feeBps, plain, costOf, rulesLockRent, DECIMALS } from "./launch-core.js";
import { STRICT_MODULES, STRICT_KEYS, mountStrict } from "./launch-strict.js";

await boot("launch.html");
const core = await startLaunch();
const plat = core.plat;

// ---- the modules --------------------------------------------------------------------------------
// RL.on says which modules are switched on, the inputs hold their numbers. Every bound is the
// SDK's RULES_POLICY, and H.rulesProblems finds what is over one. The review is worked out with
// the SDK's own arithmetic, so it is what the chain charges.
const RL = { on: { sniper: false, creator: false, holders: false, burn: false, limit: false, lock: false } };
const POLICY = H.RULES_POLICY;
const RULE_INPUTS = { sniper: ["rSniperFee", "rSniperMin"], creator: ["rCreatorBuy", "rCreatorSell"], holders: ["rHoldersBuy", "rHoldersSell"], burn: ["rBurnBuy", "rBurnSell"], limit: ["rLimitSol", "rLimitMin"], lock: ["rLockDays"] };
const RULE_KEYS = Object.keys(RULE_INPUTS);
const slotMinutes = (slots) => Number(slots) * H.RULES_SLOT_MS / 60000;
/// The most the form takes in each field, from the policy, in the field's own unit.
const INPUT_MAX = {
  rSniperFee: POLICY.sniperStartFeeBps / 100, rSniperMin: slotMinutes(POLICY.sniperSlots),
  rCreatorBuy: POLICY.creatorBps / 100, rCreatorSell: POLICY.creatorBps / 100,
  rHoldersBuy: POLICY.holdersBps / 100, rHoldersSell: POLICY.holdersBps / 100,
  rBurnBuy: POLICY.burnBps / 100, rBurnSell: POLICY.burnBps / 100,
  rLimitMin: slotMinutes(POLICY.limitSlots), rLockDays: POLICY.creatorLockSeconds / 86400,
};
/// The share of the supply that has to be staked before stakers are paid.
const ELIGIBLE = plain(100 / Number(H.RULES_ELIGIBLE_DIVISOR)) + "%";
const MODULES = [
  { key: "sniper", name: "Sniper fee", icon: "M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
    fields: [{ id: "rSniperFee", label: "Start fee", suffix: "%", value: "30", max: "sniperStartFeeBps" }, { id: "rSniperMin", label: "Length", suffix: "min", value: "2", max: "sniperSlots" }],
    help: "A buy pays a high pool fee right after the launch. The fee falls in a straight line to the pool fee, and it stays in the pool. Nobody can add liquidity while it runs. Your own first buy pays the start fee. Sells are never touched." },
  { key: "creator", name: "Creator fee", icon: "M12 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM5 20a7 7 0 0 1 14 0",
    fields: [{ id: "rCreatorBuy", label: "On buys", suffix: "%", value: "1", max: "creatorBps" }, { id: "rCreatorSell", label: "On sells", suffix: "%", value: "1", max: "creatorBps" }],
    help: "A share of every trade is set aside for your wallet, in SOL. You claim it on the coin page." },
  { key: "holders", name: "Rewards", icon: "M12 5c3.9 0 7 1.1 7 2.5S15.9 10 12 10 5 8.9 5 7.5 8.1 5 12 5zM5 7.5V12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V7.5M5 12v4.5C5 17.9 8.1 19 12 19s7-1.1 7-2.5V12",
    fields: [{ id: "rHoldersBuy", label: "On buys", suffix: "%", value: "1", max: "holdersBps" }, { id: "rHoldersSell", label: "On sells", suffix: "%", value: "1", max: "holdersBps" }],
    help: "A share of every trade is paid in SOL to wallets that stake the coin on its page. A wallet that only holds the coin earns nothing. While less than " + ELIGIBLE + " of the supply is staked, this share buys and burns the coin instead." },
  { key: "burn", name: "Burn", icon: "M12 3c.5 3.5 5 5.5 5 10.5a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.5 2 3 0-3 .5-6 1-9z",
    fields: [{ id: "rBurnBuy", label: "On buys", suffix: "%", value: "0.5", max: "burnBps" }, { id: "rBurnSell", label: "On sells", suffix: "%", value: "0.5", max: "burnBps" }],
    help: "A share of every trade collects in a pot, in SOL. Anyone can run a buy of the coin with the pot, a slice at a time. What it buys is burned. A run waits while the price climbs." },
  { key: "limit", name: "Buy limit", icon: "M4 6h16M8 20V10M12 20v-7M16 20v-4",
    fields: [{ id: "rLimitSol", label: "Most per buy", suffix: "SOL", value: "0.1", hintId: "rLimitShare" }, { id: "rLimitMin", label: "Length", suffix: "min", value: "10", max: "limitSlots" }],
    help: "No single buy can spend more than this right after the launch. The limit is per trade, so a wallet can split a large buy into several. It binds your own first buy too. Sells are never limited." },
  { key: "lock", name: "Creator lock", icon: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6zM12 15v2",
    fields: [{ id: "rLockDays", label: "Locked for", suffix: "days", value: "30", max: "creatorLockSeconds" }],
    help: "Your first buy is locked in the launch transaction and cannot leave before the date. On a normal coin it waits in a lock account. On a strict coin it stays in your own wallet. The lock holds those coins only, and it needs a first buy." },
];
$("ruleList").append(...MODULES.map(moduleRow));
{
  const unit = { sniperStartFeeBps: "%", creatorBps: "%", holdersBps: "%", burnBps: "%", sniperSlots: " min", limitSlots: " min", creatorLockSeconds: " days" };
  const most = { sniperStartFeeBps: INPUT_MAX.rSniperFee, creatorBps: INPUT_MAX.rCreatorBuy, holdersBps: INPUT_MAX.rHoldersBuy, burnBps: INPUT_MAX.rBurnBuy, sniperSlots: INPUT_MAX.rSniperMin, limitSlots: INPUT_MAX.rLimitMin, creatorLockSeconds: INPUT_MAX.rLockDays };
  for (const n of $("ruleList").querySelectorAll("[data-max]")) n.textContent = "max " + plain(most[n.dataset.max]) + unit[n.dataset.max];
}

// ---- the strict modules: drawn only while the one switch in launch-strict.js is on ----------------
const S = STRICT_MODULES ? mountStrict($("strictList"), $("strictPanel"), (key) => {
  // rewards go to stakers or to holders, never to both
  if (key === "holderRewards" && S.isOn()) RL.on.holders = false;
  core.summarize();
}) : null;
if (S) $("strictList").hidden = false;

// ---- presets ---------------------------------------------------------------------------------------
/// The numbers of each module a preset switches on, in the order of the module's fields. "seed"
/// is a twentieth of the SOL the price starts from: the seed, or the virtual SOL on the curve.
/// A number above the policy is cut to it.
const PRESETS = [
  { key: "creator", name: "Creator fee only", rules: { creator: [1, 1] } },
  { key: "hold", name: "Built to hold", rules: { sniper: [30, 2], creator: [0.5, 0.5], holders: [1, 1], limit: ["seed", 10], lock: [90] } },
  { key: "burn", name: "Rewards and burn", rules: { creator: [0.5, 0.5], holders: [0.5, 0.5], burn: [0.5, 0.5] } },
  { key: "sells", name: "Sells pay stakers", rules: { creator: [0.5, 0.5], holders: [0, 2], lock: [30] } },
];
function presetValues(p) {
  const out = {};
  for (const [k, list] of Object.entries(p.rules)) {
    out[k] = list.map((v, i) => {
      const id = RULE_INPUTS[k][i];
      if (v === "seed") { const depth = core.values().depth; return depth > 0n ? fmtSol(depth / 20n, 4).replace(/,/g, "") : "0.1"; }
      return plain(id in INPUT_MAX ? Math.min(v, INPUT_MAX[id]) : v);
    });
  }
  return out;
}
function applyPreset(p) {
  const values = presetValues(p);
  for (const k of RULE_KEYS) {
    RL.on[k] = !!values[k];
    if (values[k]) values[k].forEach((v, i) => { $(RULE_INPUTS[k][i]).value = v; });
  }
  // a preset is a normal coin
  if (S) for (const k of STRICT_KEYS) S.turnOff(k);
  core.summarize();
}
/// The preset the form holds right now, when it holds one exactly.
function presetNow() {
  if (S && S.isOn()) return null;
  return PRESETS.find((p) => {
    const values = presetValues(p);
    return RULE_KEYS.every((k) => RL.on[k] === !!values[k] && (!values[k] || values[k].every((v, i) => Number(String($(RULE_INPUTS[k][i]).value).replace(",", ".")) === Number(v))));
  }) || null;
}
$("rulePresets").replaceChildren(...PRESETS.map((p) => el("button", { type: "button", "data-preset": p.key, "aria-pressed": "false", text: p.name, onclick: () => applyPreset(p) })));
for (const b of $("ruleList").querySelectorAll("[data-switch]")) b.addEventListener("click", () => {
  const k = b.dataset.switch;
  RL.on[k] = !RL.on[k];
  if (k === "holders" && RL.on.holders && S) S.turnOff("holderRewards");
  core.summarize();
});
for (const ids of Object.values(RULE_INPUTS)) for (const id of ids) $(id).addEventListener("input", core.summarize);

// ---- what the form holds --------------------------------------------------------------------------
const anyOn = () => RULE_KEYS.some((k) => RL.on[k]) || !!(S && S.isOn());
/// What the launch asks the SDK for: a coin with modules, or a plain coin with no hook.
const template = () => (anyOn() ? "rules" : "none");

/// The modules as the SDK's input, the same as the program's argument, and what is wrong with
/// them, in sentences, by module. `sides` is for the three shares together.
function rulesForm(c) {
  const errs = { sniper: [], creator: [], holders: [], burn: [], limit: [], lock: [], sides: [] };
  const num = (id, key) => {
    const s = String($(id).value).trim().replace(",", ".");
    if (s === "") return 0;
    const v = Number(s);
    if (!isFinite(v) || v < 0) { if (!errs[key].includes("Type a number.")) errs[key].push("Type a number."); return 0; }
    return v;
  };
  const rate = (id, key) => { const v = num(id, key); if (v > 100) { errs[key].push("A share cannot be above 100%."); return 0; } return Math.round(v * 100); };
  const slots = (id, key) => { const m = num(id, key); return m > 0 ? Math.min(minutesToSlots(m), 4_000_000_000) : 0; };
  const input = { buy: {}, sell: {} };
  if (RL.on.sniper) { input.sniperStartFeeBps = rate("rSniperFee", "sniper"); input.sniperSlots = slots("rSniperMin", "sniper"); }
  for (const [k, field] of [["creator", "creatorBps"], ["holders", "holdersBps"], ["burn", "burnBps"]]) {
    if (!RL.on[k]) continue;
    input.buy[field] = rate(RULE_INPUTS[k][0], k); input.sell[field] = rate(RULE_INPUTS[k][1], k);
    if (!errs[k].length && input.buy[field] === 0 && input.sell[field] === 0) errs[k].push("Type a share for buys, for sells, or for both.");
  }
  if (RL.on.limit) { input.maxBuyQuote = sol("rLimitSol") || 0n; if (input.maxBuyQuote >= 2n ** 63n) input.maxBuyQuote = 0n; input.limitSlots = slots("rLimitMin", "limit"); }
  if (RL.on.lock) { const d = num("rLockDays", "lock"); input.creatorLockSeconds = d > 0 ? Math.min(Math.round(d * 86400), 4_000_000_000) : 0; }
  // a strict coin pays its rewards to holders: the share is typed in the strict group
  let strict = S ? S.read(c, null) : null;
  if (strict && strict.on.holderRewards) { input.buy.holdersBps = strict.values.holdersBuyBps; input.sell.holdersBps = strict.values.holdersSellBps; }
  const args = H.rulesArgs(input);
  const side = (m) => (/on buys/.test(m) ? "buys" : "sells");
  for (const p of H.rulesProblems(args, POLICY)) {
    const s = side(p.message), r = s === "buys" ? args.buy : args.sell;
    if (p.code === "CreatorFeeTooHigh") errs.creator.push("The creator fee on " + s + " is " + fmtPct(r.creatorBps) + ". The most is " + fmtPct(POLICY.creatorBps) + ".");
    else if (p.code === "HoldersFeeTooHigh") { if (RL.on.holders) errs.holders.push("The rewards on " + s + " are " + fmtPct(r.holdersBps) + ". The most is " + fmtPct(POLICY.holdersBps) + "."); }
    else if (p.code === "BurnFeeTooHigh") errs.burn.push("The burn on " + s + " is " + fmtPct(r.burnBps) + ". The most is " + fmtPct(POLICY.burnBps) + ".");
    else if (p.code === "SideTooHigh") errs.sides.push("Creator fee, rewards and burn together take " + fmtPct(H.rulesRatesTotal(r)) + " on " + s + ". The most is " + fmtPct(POLICY.sideBps) + " a side.");
    else if (p.code === "StartFeeTooHigh") errs.sniper.push("The sniper fee starts at " + fmtPct(args.sniperStartFeeBps) + ". The most is " + fmtPct(POLICY.sniperStartFeeBps) + ".");
    else if (p.code === "SniperWindowTooLong") errs.sniper.push("The sniper fee would run for " + fmtSpan(slotsToSeconds(args.sniperSlots)) + ". The most is " + plain(INPUT_MAX.rSniperMin) + " min.");
    else if (p.code === "SniperIncomplete") errs.sniper.push("A sniper fee needs a start fee and a length.");
    else if (p.code === "LimitWindowTooLong") errs.limit.push("The buy limit would run for " + fmtSpan(slotsToSeconds(args.limitSlots)) + ". The most is " + plain(INPUT_MAX.rLimitMin) + " min.");
    else if (p.code === "LimitIncomplete") errs.limit.push("A buy limit needs an amount in SOL and a length.");
    else if (p.code === "LockTooLong") errs.lock.push("The lock would last " + fmtSpan(Number(args.creatorLockSeconds)) + ". The most is " + plain(INPUT_MAX.rLockDays) + " days.");
    else errs.sides.push(p.message.charAt(0).toUpperCase() + p.message.slice(1) + ".");
  }
  // what the bounds do not cover and the launch would still refuse, or make pointless
  const dev = c.dev, lp = c.lp;
  if (RL.on.sniper && args.sniperStartFeeBps > 0 && args.sniperStartFeeBps <= lp) errs.sniper.push("The start fee must be above the pool fee of " + fmtPct(lp) + ".");
  if (RL.on.limit && args.maxBuyQuote > 0n && dev > args.maxBuyQuote) errs.limit.push("Your first buy of " + fmtSol(dev, 4) + " SOL is above this limit, so the launch would fail.");
  if (RL.on.lock) {
    if (args.creatorLockSeconds === 0n && !errs.lock.length) errs.lock.push("Type the days the lock lasts.");
    else if (dev === 0n) errs.lock.push("A lock holds your first buy, and your first buy is 0. Type one under Launch settings, or switch the lock off.");
    if (!ctx.lookupTable) errs.lock.push("A launch with a creator lock needs the platform lookup table, and deployments/" + ctx.cluster + "-alt.json is missing on this site.");
  }
  // the first buy, with the pool as the launch creates it (seeded, or on the curve): nothing can trade before it
  let q = null;
  if (plat && dev > 0n && c.depth > 0n && c.supply > 0n && c.supply < 2n ** 64n && !(args.maxBuyQuote > 0n && dev > args.maxBuyQuote)) {
    try { q = H.rulesFirstBuyQuote(args, { totalSupply: c.supply, quoteAmount: c.seed, lpFeeBps: lp, devBuyQuote: dev, virtualQuote: c.virtual }, plat); } catch (_) {}
  }
  if (S) {
    strict = S.read(c, q ? q.amountOut : null);
    if (strict.strict && RL.on.holders) errs.holders.push("A strict coin has no staking, so nobody could earn these rewards. Switch Rewards off and use Rewards without staking.");
  }
  const all = [...Object.values(errs).flat(), ...(strict ? Object.values(strict.errs).flat() : [])];
  return { input, args, errs, q, strict, count: all.length, first: all[0] || "" };
}
const rateSum = (buy, sell) => (buy === sell ? fmtPct(buy) + " of every trade" : fmtPct(buy) + " buys, " + fmtPct(sell) + " sells");
/// Draw the switches, what each module adds up to, and each problem under its own fields.
function drawRules(f, c) {
  const a = f.args;
  const sums = {
    sniper: fmtPct(a.sniperStartFeeBps) + " for " + fmtSpan(slotsToSeconds(a.sniperSlots)),
    creator: rateSum(a.buy.creatorBps, a.sell.creatorBps), holders: rateSum(a.buy.holdersBps, a.sell.holdersBps), burn: rateSum(a.buy.burnBps, a.sell.burnBps),
    limit: fmtSol(a.maxBuyQuote, 4) + " SOL for " + fmtSpan(slotsToSeconds(a.limitSlots)),
    lock: fmtSpan(Number(a.creatorLockSeconds)),
  };
  const list = $("ruleList");
  for (const k of RULE_KEYS) {
    const on = RL.on[k];
    list.querySelector('[data-rule="' + k + '"]').dataset.on = on ? "true" : "false";
    list.querySelector('[data-switch="' + k + '"]').setAttribute("aria-checked", on ? "true" : "false");
    list.querySelector('[data-fields="' + k + '"]').hidden = !on;
    list.querySelector('[data-sum="' + k + '"]').textContent = on ? sums[k] : "";
    list.querySelector('[data-err="' + k + '"]').replaceChildren(...f.errs[k].map((t) => el("span", { text: t })));
  }
  $("ruleSides").replaceChildren(...f.errs.sides.map((t) => el("span", { text: t })));
  const now = presetNow();
  for (const b of $("rulePresets").querySelectorAll("button")) b.setAttribute("aria-pressed", now && now.key === b.dataset.preset ? "true" : "false");
  // what one buy at the limit takes of the supply at the launch price, to give the SOL amount a scale
  let share = "";
  if (RL.on.limit && a.maxBuyQuote > 0n && c.depth > 0n && c.supply > 0n && c.supply < 2n ** 64n) share = plain(Number((a.maxBuyQuote * 1_000n) / (c.depth + a.maxBuyQuote)) / 10) + "% of supply";
  $("rLimitShare").textContent = share;
  if (S) S.draw(f.strict, c, { lock: RL.on.lock });
}

/// The review: what a buy and a sell pay and where each part goes, the first buy as the launch
/// will make it, the lock, and the notes under the cost.
function review(c) {
  const f = rulesForm(c);
  drawRules(f, c);
  if (template() === "none") {
    const q = core.quoteFirst(c);
    return {
      buy: core.side(), sell: core.side(),
      notes: ["No module is on, so this is a plain coin. Nothing runs on a trade. The two fees above are the only ones, and they never change."],
      first: q ? { rows: core.firstRows(q, c, "", ""), note: "" } : null,
    };
  }
  const a = f.args, lp = c.lp, protocol = core.protocol;
  const cap = plat ? plat.maxHookFeeBps : 10_000;
  const isStrict = !!(f.strict && f.strict.strict);
  const one = (dir) => {
    const r = H.rulesSideRates(a, dir), hook = H.rulesHookFeeBps(a, dir, cap);
    const rows = [];
    if (r.creatorBps) rows.push(["Creator fee", "to your wallet", r.creatorBps]);
    if (r.holdersBps) rows.push(["Rewards", isStrict ? "to registered holders of the coin" : "to wallets that stake the coin", r.holdersBps]);
    if (r.burnBps) rows.push(["Burn", "buys the coin and burns it", r.burnBps]);
    return { ...core.side(rows, hook), hook, cut: hook < H.rulesRatesTotal(r) };
  };
  const buy = one(H.DIRECTION.BUY), sell = one(H.DIRECTION.SELL);
  const notes = ["Each fee is taken from what the one before it left, so a trade pays a little less than the sum."];
  const start = Math.min(a.sniperStartFeeBps, plat ? plat.maxFeeOverrideBps : 10_000);
  if (RL.on.sniper && a.sniperSlots > 0n && start > lp) notes.push("For the first " + fmtSpan(slotsToSeconds(a.sniperSlots)) + " a buy pays a higher pool fee. It starts at " + fmtPct(start) + " and falls to " + fmtPct(lp) + ". A buy in the first slot pays " + fmtPct(protocol + start + buy.hook) + " in total.");
  if (buy.cut || sell.cut) notes.push("The platform caps what a hook takes at " + fmtPct(cap) + " a trade. The three shares are cut to it in proportion.");
  if (!isStrict && (a.buy.holdersBps > 0 || a.sell.holdersBps > 0)) notes.push("While less than " + ELIGIBLE + " of the supply is staked, the rewards buy and burn the coin instead.");
  if (isStrict) notes.push(...S.notes(f.strict, c, Math.floor(Date.now() / 1000)));
  if (isStrict && (a.buy.holdersBps > 0 || a.sell.holdersBps > 0)) notes.push("While registered wallets hold less than " + ELIGIBLE + " of the supply, the rewards buy and burn the coin instead.");
  const q = f.q;
  const lock = RL.on.lock && a.creatorLockSeconds > 0n && !!q;
  return {
    buy, sell, notes,
    first: q ? { rows: core.firstRows(q, c, "Creator fee, rewards and burn " + fmtPct(buy.hook), "the sniper fee"), note: q.feeBpsApplied !== lp ? "Your first buy is the first trade of the pool. It pays the sniper fee of the first slot in full." : "" } : null,
    lock: lock && isStrict ? "The " + fmtUnits(q.amountOut, DECIMALS, 2) + " " + c.sym + " of your first buy stay in your own wallet. They cannot leave it before about " + fmtDate(Math.floor(Date.now() / 1000) + H.RULES_LOCK_MARGIN_SECONDS + Number(a.creatorLockSeconds)) + ", your local time. The launch sets the exact minute."
      : lock ? "The " + fmtUnits(q.amountOut, DECIMALS, 2) + " " + c.sym + " of your first buy go into a lock account in the launch transaction. They stay there until about " + fmtDate(Math.floor(Date.now() / 1000) + H.RULES_LOCK_MARGIN_SECONDS + Number(a.creatorLockSeconds)) + ", your local time. The launch sets the exact minute." : "",
    rentNote: isStrict ? "The rent pays for the coin with its name, ticker and metadata address inside it, its rules, the account list of its transfer hook and the pool's holder record" + (c.dev > 0n ? ", your holder record" + (RL.on.lock ? " and your lock record." : ".") : ".") + " Longer names cost a little more rent."
      : "The rent pays for this coin's treasury, its burn account and its vault for staked coins" + (RL.on.lock ? ", and for the lock account of your first buy." : "."),
    problems: f.count ? "Change what is marked under Modules before you launch." : "",
  };
}

core.run({
  template,
  kind: () => (S && S.isOn() ? "Strict" : anyOn() ? "Modules" : ""),
  rent: (c) => {
    if (template() !== "rules") return costOf("none");
    // a strict coin keeps its name, ticker and metadata address inside the coin; the site's own upload answers an address of its origin plus 50 characters
    if (S && S.isOn()) return S.sdk.launchCost(c, RL.on.lock, $("metaUrl").value.trim() || location.origin + "/uploads/" + "x".repeat(41));
    return costOf("rules") + (RL.on.lock ? rulesLockRent() : 0n);
  },
  review,
  validate(out) {
    if (out.template !== "rules") return;
    const f = rulesForm(core.values());
    if (f.count) throw new Error("Check the modules. " + f.first);
    out.rules = f.input; out.rulesArgs = f.args;
    if (f.strict && f.strict.strict) {
      if (!S.sdk.ready) throw new Error("The SDK calls for a strict coin are not filled in. See strictSdk in launch-strict.js.");
      if (!ctx.lookupTable) throw new Error("A strict coin needs the platform lookup table, and deployments/" + ctx.cluster + "-alt.json is missing on this site.");
      Object.assign(out.rules, S.sdk.rulesInput(f.strict.values));
    }
  },
  minOut(v) {
    if (v.template === "rules") return applyBps(H.rulesFirstBuyQuote(v.rulesArgs, { totalSupply: v.totalSupply, quoteAmount: v.seed, lpFeeBps: v.lpFeeBps, devBuyQuote: v.dev, virtualQuote: core.firstPool(v).virtualQuote }, plat).amountOut, 100);
    return applyBps(H.quoteSwap({ direction: H.DIRECTION.BUY, amountIn: v.dev, ...core.firstPool(v), lpFeeBps: v.lpFeeBps, protocolFeeBps: plat.protocolFeeBps, hookFeeBps: 0, feeOverrideBps: null }).amountOut, 100);
  },
});

// under 1180 px the three columns are three views, one at a time
const studio = $("studio");
for (const b of $("studioTabs").querySelectorAll("button")) b.addEventListener("click", () => {
  studio.dataset.view = b.dataset.view;
  for (const x of $("studioTabs").querySelectorAll("button")) x.setAttribute("aria-selected", x === b ? "true" : "false");
});
