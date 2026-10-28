// The strict modules of Module Mode: Max wallet, Early lock and Rewards without staking.
// A coin with one of them on is a strict coin: a Token-2022 coin whose transfer hook is the
// rules program, so that program runs inside every transfer of the coin.
//
// STRICT_MODULES is the one switch. While it is false the group is not drawn and none of the
// code below runs. Everything this file needs from the SDK goes through strictSdk(): fill
// that one function from the SDK, set the switch to true, and the group is on the form.
import { H, el, fmtPct, fmtSpan, fmtDate, fmtUnits } from "./common.js";
import { moduleRow, plain, DECIMALS, perByte, rentOf, rentKnown, measuredCost } from "./launch-core.js";

export const STRICT_MODULES = true;

const HOUR_SLOTS = 9_000; // one hour of 400 ms slots
const hoursToSlots = (h) => Math.max(0, Math.round(Number(h) * HOUR_SLOTS));
const minutesToSlotsExact = (m) => Math.max(0, Math.round(Number(m) * 150));
/// What a strict launch costs beyond the seed, the first buy and the platform fee, measured on a
/// local validator and kept as rent bytes (launch-core.js explains): the Token-2022 coin with its
/// name, ticker and metadata address inside it (one byte of rent for each byte of the three), the
/// rules, the transfer hook's account list and the pool's own holder record, 4,338 bytes of rent
/// with the account overheads, plus three signatures. No Metaplex account, so no Metaplex fee. A
/// first buy adds the launcher's holder record, a creator lock its lock record, each at the
/// chain's rent of its size.
const STRICT_BASE_BYTES = 4338;
const STRICT_FEES = 15_000n;
const bytes = (s) => new TextEncoder().encode(String(s || "")).length;

/// Everything the strict modules need from the SDK, in one place.
export function strictSdk() {
  const P = H.RULES_STRICT_POLICY;
  const area = { MaxWalletIncomplete: "maxWallet", MaxWalletOutOfBounds: "maxWallet", EarlyIncomplete: "earlyLock", EarlyOutOfBounds: "earlyLock" };
  return {
    /// The bounds the form holds the modules to: the SDK's RULES_STRICT_POLICY.
    policy: {
      maxWalletMinBps: P.maxWalletBpsMin, maxWalletMaxBps: P.maxWalletBpsMax, maxWalletSlots: P.maxWalletSlots,
      earlySlots: P.earlySlots, earlyUnlockSlots: P.earlyUnlockSlots,
      holdersBps: H.RULES_POLICY.holdersBps,
    },
    /// The strict part of the `rules` input of client.launchInstructions. A module that is off
    /// is 0, so "Rewards without staking" alone is a strict coin with neither window.
    rulesInput: (s) => ({ strict: { maxWalletBps: s.maxWalletBps, maxWalletSlots: s.maxWalletSlots, earlySlots: s.earlySlots, earlyUnlockSlots: s.earlyUnlockSlots } }),
    /// What the program would refuse, from the SDK's strictProblems against the policy.
    problems: (s) => {
      let a;
      try { a = H.strictArgs({ maxWalletBps: s.maxWalletBps, maxWalletSlots: s.maxWalletSlots, earlySlots: s.earlySlots, earlyUnlockSlots: s.earlyUnlockSlots }); }
      catch (e) { return [{ module: "maxWallet", message: e.message }]; }
      return H.strictProblems(a, P).map((p) => ({ module: area[p.code] || "maxWallet", code: p.code, message: p.message.charAt(0).toUpperCase() + p.message.slice(1) + "." }));
    },
    /// Lamports a strict launch costs beyond the seed, the first buy and the platform fee.
    launchCost: (c, lock, url) => measuredCost(STRICT_BASE_BYTES, STRICT_FEES) + perByte() * BigInt(bytes(c.name) + bytes(c.symbol) + bytes(url)) + (c.dev > 0n ? rentOf(H.HOLDER_RECORD_SIZE) : 0n) + (lock && c.dev > 0n ? rentOf(H.LOCK_RECORD_SIZE) : 0n),
    /// The coins one wallet may hold while the max wallet runs.
    cap: (supply, bps) => (bps > 0 ? H.strictMaxWalletAmount(supply, bps) : 0n),
    /// Rent of the record a wallet opens once to earn rewards without staking, in lamports, at the
    /// chain's rent (0n while that is not read: the sentence then names no number).
    get holderRent() { return rentKnown() ? rentOf(H.HOLDER_RECORD_SIZE) : 0n; },
    /// Is a coin strict, from its rules account.
    isStrict: (cfg) => !!cfg && cfg.kind === H.RULES_KIND.STRICT,
    ready: true,
  };
}

const ICONS = {
  maxWallet: "M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2zM16 13h2",
  earlyLock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2",
  holderRewards: "M12 4l2.3 4.7 5.2.8-3.75 3.65.9 5.15L12 15.9l-4.65 2.4.9-5.15L4.5 9.5l5.2-.8z",
};
const INPUTS = { maxWallet: ["sMaxWalletPct", "sMaxWalletHours"], earlyLock: ["sEarlyMin", "sEarlyUnlockHours"], holderRewards: ["sHoldBuy", "sHoldSell"] };
export const STRICT_KEYS = Object.keys(INPUTS);

/// Build the strict group into `box` and its cost panel into `panel`. `onChange` runs after
/// every switch and keystroke. Returns the group's state readers.
export function mountStrict(box, panel, onChange) {
  const sdk = strictSdk(), P = sdk.policy;
  const on = { maxWallet: false, earlyLock: false, holderRewards: false };
  const hours = (slots) => plain(slots / HOUR_SLOTS), minutes = (slots) => plain(slots / 150);
  const rows = [
    moduleRow({ key: "maxWallet", name: "Max wallet", icon: ICONS.maxWallet,
      fields: [
        { id: "sMaxWalletPct", label: "Most per wallet", suffix: "%", value: "1", hint: plain(P.maxWalletMinBps / 100) + " to " + plain(P.maxWalletMaxBps / 100) + "%" },
        { id: "sMaxWalletHours", label: "For", suffix: "h", value: "24", hint: "max " + hours(P.maxWalletSlots) + " h" }],
      help: "While this runs, no wallet can hold more than this share of the supply. A buy or a transfer that would pass it fails. A sell is never stopped by it." }),
    moduleRow({ key: "earlyLock", name: "Early lock", icon: ICONS.earlyLock,
      fields: [
        { id: "sEarlyMin", label: "Early window", suffix: "min", value: "5", hint: "max " + minutes(P.earlySlots) + " min" },
        { id: "sEarlyUnlockHours", label: "Unlock after", suffix: "h", value: "24", hint: "max " + hours(P.earlyUnlockSlots) + " h" }],
      help: "Coins bought from the pool in the first minutes cannot be sold or sent until the unlock. Coins a wallet got another way stay free. Your own first buy is early too." }),
    moduleRow({ key: "holderRewards", name: "Rewards without staking", icon: ICONS.holderRewards,
      fields: [
        { id: "sHoldBuy", label: "On buys", suffix: "%", value: "1", hint: "max " + plain(P.holdersBps / 100) + "%" },
        { id: "sHoldSell", label: "On sells", suffix: "%", value: "1", hint: "max " + plain(P.holdersBps / 100) + "%" }],
      help: "A share of every trade is paid in SOL to the wallets that hold the coin. Nothing is staked. A wallet earns from the moment it has registered once, and this site registers a wallet inside its first buy." }),
  ];
  box.replaceChildren(
    el("h3", { text: "Strict modules" }),
    el("p", { text: "These three need a strict coin. Switching the first one on makes the coin strict." }),
    ...rows);
  for (const b of box.querySelectorAll("[data-switch]")) b.addEventListener("click", () => { on[b.dataset.switch] = !on[b.dataset.switch]; onChange(b.dataset.switch); });
  for (const ids of Object.values(INPUTS)) for (const id of ids) box.querySelector("#" + id).addEventListener("input", () => onChange(""));
  const val = (id) => box.querySelector("#" + id).value;

  /// What the group holds: which modules are on, the numbers for the SDK, and what is wrong,
  /// by module. `c` is the form's shared values (supply, first buy), `firstOut` what the first
  /// buy receives, when it can be quoted.
  function read(c, firstOut) {
    const errs = { maxWallet: [], earlyLock: [], holderRewards: [] };
    const num = (id, key) => {
      const s = String(val(id)).trim().replace(",", ".");
      if (s === "") return 0;
      const v = Number(s);
      if (!isFinite(v) || v < 0) { if (!errs[key].includes("Type a number.")) errs[key].push("Type a number."); return 0; }
      return v;
    };
    const s = { maxWalletBps: 0, maxWalletSlots: 0, earlySlots: 0, earlyUnlockSlots: 0, holdersBuyBps: 0, holdersSellBps: 0 };
    if (on.maxWallet) {
      s.maxWalletBps = Math.round(num("sMaxWalletPct", "maxWallet") * 100);
      s.maxWalletSlots = hoursToSlots(num("sMaxWalletHours", "maxWallet"));
      if (!errs.maxWallet.length) {
        if (s.maxWalletBps < P.maxWalletMinBps || s.maxWalletBps > P.maxWalletMaxBps) errs.maxWallet.push("The max wallet is " + fmtPct(s.maxWalletBps) + " of the supply. It must be from " + fmtPct(P.maxWalletMinBps) + " to " + fmtPct(P.maxWalletMaxBps) + ".");
        if (s.maxWalletSlots < 1) errs.maxWallet.push("Type the hours the max wallet runs.");
        else if (s.maxWalletSlots > P.maxWalletSlots) errs.maxWallet.push("The max wallet would run for " + fmtSpan(s.maxWalletSlots * 0.4) + ". The most is " + hours(P.maxWalletSlots) + " h.");
        // the launcher's first buy lands in the launcher's wallet like any other buy
        const cap = sdk.cap(c.supply, s.maxWalletBps);
        if (firstOut && cap > 0n && firstOut > cap) errs.maxWallet.push("Your first buy would hold " + fmtUnits(firstOut, DECIMALS, 0) + " " + c.sym + ". That is above the max wallet of " + fmtUnits(cap, DECIMALS, 0) + ", so the launch would fail.");
      }
    }
    if (on.earlyLock) {
      s.earlySlots = minutesToSlotsExact(num("sEarlyMin", "earlyLock"));
      s.earlyUnlockSlots = hoursToSlots(num("sEarlyUnlockHours", "earlyLock"));
      if (!errs.earlyLock.length) {
        if (s.earlySlots < 1) errs.earlyLock.push("Type the minutes in which a buy counts as early.");
        else if (s.earlySlots > P.earlySlots) errs.earlyLock.push("Buys would be early for " + fmtSpan(s.earlySlots * 0.4) + ". The most is " + minutes(P.earlySlots) + " min.");
        if (s.earlyUnlockSlots > P.earlyUnlockSlots) errs.earlyLock.push("The unlock would come " + fmtSpan(s.earlyUnlockSlots * 0.4) + " after the launch. The most is " + hours(P.earlyUnlockSlots) + " h.");
        else if (s.earlySlots >= 1 && s.earlyUnlockSlots < s.earlySlots) errs.earlyLock.push("The unlock cannot come before the early window ends.");
      }
    }
    if (on.holderRewards) {
      const rate = (id) => { const v = num(id, "holderRewards"); if (v > 100) { errs.holderRewards.push("A share cannot be above 100%."); return 0; } return Math.round(v * 100); };
      s.holdersBuyBps = rate("sHoldBuy"); s.holdersSellBps = rate("sHoldSell");
      if (!errs.holderRewards.length) {
        if (s.holdersBuyBps === 0 && s.holdersSellBps === 0) errs.holderRewards.push("Type a share for buys, for sells, or for both.");
        for (const [side, bps] of [["buys", s.holdersBuyBps], ["sells", s.holdersSellBps]]) if (bps > P.holdersBps) errs.holderRewards.push("The rewards on " + side + " are " + fmtPct(bps) + ". The most is " + fmtPct(P.holdersBps) + ".");
      }
    }
    const strict = on.maxWallet || on.earlyLock || on.holderRewards;
    if (strict) for (const p of sdk.problems(s)) errs[p.module && errs[p.module] ? p.module : "maxWallet"].push(p.message);
    return { on: { ...on }, strict, values: s, errs, count: Object.values(errs).flat().length, first: Object.values(errs).flat()[0] || "" };
  }

  /// Draw the switches, each module's one-line sum and its problems, and the cost panel.
  function draw(r, c, opts = {}) {
    const s = r.values;
    const rateSum = (buy, sell) => (buy === sell ? fmtPct(buy) + " of every trade" : fmtPct(buy) + " buys, " + fmtPct(sell) + " sells");
    const sums = {
      maxWallet: fmtPct(s.maxWalletBps) + " for " + fmtSpan(s.maxWalletSlots * 0.4),
      earlyLock: fmtSpan(s.earlySlots * 0.4) + ", unlock after " + fmtSpan(s.earlyUnlockSlots * 0.4),
      holderRewards: rateSum(s.holdersBuyBps, s.holdersSellBps),
    };
    for (const k of STRICT_KEYS) {
      box.querySelector('[data-rule="' + k + '"]').dataset.on = on[k] ? "true" : "false";
      box.querySelector('[data-switch="' + k + '"]').setAttribute("aria-checked", on[k] ? "true" : "false");
      box.querySelector('[data-fields="' + k + '"]').hidden = !on[k];
      box.querySelector('[data-sum="' + k + '"]').textContent = on[k] ? sums[k] : "";
      box.querySelector('[data-err="' + k + '"]').replaceChildren(...r.errs[k].map((t) => el("span", { text: t })));
    }
    panel.hidden = !r.strict;
    if (!r.strict) return;
    const lines = [
      "This coin is a Token-2022 coin. A small program runs inside every transfer of it.",
      "Aggregators such as Jupiter will probably not route it. It trades on this site and through the trade API.",
      "Fewer wallets and exchanges handle such coins well.",
      "A wallet can only receive it in its standard token account.",
    ];
    if (on.maxWallet) lines.push("The max wallet counts one wallet at a time. One person with several wallets can pass it.");
    if (on.maxWallet) lines.push("While the max wallet runs, nobody can add liquidity to the pool.");
    // on the curve the cap is worked out from the supply at launch, and graduation burns part of the supply
    if (on.maxWallet && c && c.curve) lines.push("The max wallet is a number of coins fixed at launch. The burn at graduation does not change it.");
    if (on.earlyLock) lines.push("With the early lock, coins bought in the window cannot be sold or sent until the unlock. Buyers see this before they buy.");
    if ((on.maxWallet || on.earlyLock) && c && c.dev > 0n) lines.push("Your own first buy is a buy like any other. It is early, and it counts against the max wallet.");
    if (opts.lock) lines.push("On a strict coin the creator lock keeps your first buy in your own wallet. Those coins cannot leave it before the date.");
    if (on.holderRewards) lines.push("With rewards without staking, a wallet earns from the moment it has registered once. This site does that inside the wallet's first buy. It costs a small rent, once" + (sdk.holderRent > 0n ? ", of " + fmtUnits(sdk.holderRent, 9, 6) + " SOL." : "."));
    lines.push("Like every module, these are final at launch.");
    panel.replaceChildren(
      el("h3", { text: "This is now a strict coin" }),
      el("ul", null, ...lines.map((t) => el("li", { text: t }))),
      el("p", { class: "help", text: "Switch the last strict module off and the coin is a normal coin again." }));
  }

  /// Sentences for the review about what the strict modules do to a trade. `launchAt`: about
  /// when the launch lands, in Unix seconds.
  function notes(r, c, launchAt) {
    const s = r.values, out = [];
    if (r.on.maxWallet && s.maxWalletBps > 0 && s.maxWalletSlots > 0) out.push("For the first " + fmtSpan(s.maxWalletSlots * 0.4) + " no wallet can hold more than " + fmtPct(s.maxWalletBps) + " of the supply, " + fmtUnits(sdk.cap(c.supply, s.maxWalletBps), DECIMALS, 0) + " " + c.sym + ".");
    if (r.on.earlyLock && s.earlySlots > 0) out.push("Coins bought in the first " + fmtSpan(s.earlySlots * 0.4) + " cannot be sold or sent until about " + fmtDate(launchAt + s.earlyUnlockSlots * 0.4) + ", your local time." + (c.dev > 0n ? " Your first buy is one of them." : ""));
    if (r.on.holderRewards) out.push("Rewards go to wallets that hold the coin and have registered. Nothing is staked.");
    return out;
  }

  return { read, draw, notes, sdk, isOn: () => on.maxWallet || on.earlyLock || on.holderRewards, turnOff: (k) => { on[k] = false; } };
}
