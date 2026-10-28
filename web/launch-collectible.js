// Collectible: a coin whose buys earn pieces of a collection, as a plain coin or as a pegged
// coin. The shared parts of a launch are in launch-core.js, the art section in art-studio.js.
import { boot, ctx, H, $, el, applyBps, fmtInt, fmtAmount } from "./common.js";
import { startLaunch, wholeCoins, costOf, ticketRent, perByte, rentFn, DECIMALS } from "./launch-core.js";
import { artStudio } from "./art-studio.js";

await boot("launch.html");
const core = await startLaunch();
const plat = core.plat;

// K.kind: "plain" is a classic SPL coin, "pegged" a Token-2022 coin whose transfer hook is the
// collectible program. The choice is made here once and can never change after the launch.
const K = { studio: null, unitTouched: false, maxTouched: false, kind: new URLSearchParams(location.search).get("kind") === "pegged" ? "pegged" : "plain" };
function setKind(kind) {
  K.kind = kind === "pegged" ? "pegged" : "plain";
  for (const b of $("colKind").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.kind === K.kind ? "true" : "false");
  for (const n of document.querySelectorAll("[data-kind-body]")) n.hidden = n.dataset.kindBody !== K.kind;
  // the launchpad refuses a pegged coin on the curve (CurvePegged): the choice is off for it
  core.blockCurve(K.kind === "pegged" ? "A pegged coin cannot launch on the curve. Its pool starts with a seed you put in." : "");
  unitShare();
}
for (const b of $("colKind").querySelectorAll("button")) b.addEventListener("click", () => setKind(b.dataset.kind));

// the art: generated (the default), the launcher's pictures or layers (uploaded before the
// launch), or a renderer of the launcher's own
K.studio = artStudio({ id: "artStudio", context: "launch", name: () => $("colName").value.trim(), symbol: () => $("symbol").value.trim(), onChange: () => core.summarize() });
$("colArt").replaceChildren(K.studio.node);
for (const id of ["colName", "symbol"]) $(id).addEventListener("input", () => K.studio.refresh());
$("colName").addEventListener("input", () => { $("colNameCount").textContent = new TextEncoder().encode($("colName").value).length + "/24"; });
$("colUnit").addEventListener("input", () => { K.unitTouched = true; unitShare(); core.summarize(); });
$("supply").addEventListener("input", unitShare);
$("colMax").addEventListener("input", () => { K.maxTouched = true; });
for (const id of ["colName", "colMax", "colPerBuy"]) $(id).addEventListener("input", core.summarize);
{
  const note = $("colAltNote");
  note.hidden = !!ctx.lookupTable;
  note.textContent = ctx.lookupTable ? "" : "A collectible needs the platform lookup table, and deployments/" + ctx.cluster + "-alt.json is missing on this site. The launch does not fit in one transaction without it.";
}
/// Coins per piece starts at a hundredth of the supply and follows it until the launcher types one.
/// The supply is the field's on a seeded launch and the fixed one on the curve.
for (const r of document.querySelectorAll("input[name=start]")) r.addEventListener("change", () => unitShare());
function unitShare() {
  const supply = core.values().supplyWhole;
  if (!K.unitTouched && supply > 0n) $("colUnit").value = (supply / 100n).toLocaleString("en-US");
  const unit = wholeCoins("colUnit");
  $("colUnitShare").textContent = supply > 0n && unit > 0n ? (Number(unit * 1000000n / supply) / 10000).toLocaleString("en-US", { maximumFractionDigits: 4 }) + "% of supply" : "";
  // max supply follows the most pieces the coins can back, until the launcher types one
  if (!K.maxTouched && supply > 0n && unit > 0n) $("colMax").value = fmtInt(Number(maxBacked(supply, unit)));
}
/// The most pieces that can exist at once: every wallet keeps one piece per `unit` coins, so all
/// the coins together back at most supply / unit pieces (fewer while the pool holds coins).
function maxBacked(supply, unit) { const n = supply / unit; return n < 1n ? 1n : n > 4294967295n ? 4294967295n : n; }
unitShare();

/// The SOL one buy at the launch price needs to get `want` raw coins, or null when the pool
/// cannot be quoted yet (a seeded launch with no seed typed). Found by halving: quoteSwap is pure.
function solFor(c, want) {
  let pool;
  try { pool = core.firstPool(c); } catch (_) { return null; }
  // values() names the pool fee `lp`, validate()'s output `lpFeeBps`
  const lpFeeBps = c.lp ?? c.lpFeeBps;
  const out = (lamports) => { try { return H.quoteSwap({ direction: H.DIRECTION.BUY, amountIn: lamports, ...pool, lpFeeBps, protocolFeeBps: plat.protocolFeeBps, hookFeeBps: 0, feeOverrideBps: null }).amountOut; } catch (_) { return -1n; } };
  let lo = 1n, hi = 1_000_000_000_000n; // 1000 SOL
  if (out(hi) < want) return null;
  while (lo < hi) { const mid = (lo + hi) / 2n; if (out(mid) >= want) hi = mid; else lo = mid + 1n; }
  return lo;
}
/// "What these numbers mean": the collection's settings said in plain sentences with the numbers typed.
function explain(c) {
  const lines = [];
  const unit = wholeCoins("colUnit"), perBuy = Number($("colPerBuy").value), max = Number(wholeCoins("colMax"));
  const sym = c.sym || "coins";
  if (unit > 0n && c.supplyWhole > 0n && unit <= c.supplyWhole) {
    const sol = solFor(c, unit * 10n ** BigInt(DECIMALS));
    lines.push("One piece takes " + fmtInt(Number(unit)) + " " + sym + " in one buy." + (sol !== null ? " At the launch price that is about " + fmtAmount(sol, 9, 3) + " SOL. It costs more as the price rises." : ""));
    if (perBuy > 1) {
      const solMax = solFor(c, unit * BigInt(perBuy) * 10n ** BigInt(DECIMALS));
      lines.push("A buy of " + fmtInt(Number(unit) * perBuy) + " " + sym + " or more earns " + perBuy + " pieces, the most one buy can earn." + (solMax !== null ? " At the launch price that is about " + fmtAmount(solMax, 9, 3) + " SOL." : ""));
    } else lines.push("One buy earns 1 piece at most, however big it is.");
    const cap = maxBacked(c.supplyWhole, unit);
    lines.push("Your coin has " + fmtInt(Number(c.supplyWhole)) + " " + sym + ", so at most " + fmtInt(Number(cap)) + " pieces can exist at the same time.");
    if (Number.isInteger(max) && BigInt(max) > cap) lines.push("Your max supply of " + fmtInt(max) + " is more than that, so it changes nothing. " + fmtInt(Number(cap)) + " is enough.");
    lines.push("A wallet keeps one piece for each " + fmtInt(Number(unit)) + " " + sym + " it holds, 200 at most. Selling the coins burns their pieces.");
  }
  lines.push("The coins per piece and the max supply can never change after the launch. The name and the art can, until you lock the collection.");
  $("colExplainLines").replaceChildren(...lines.map((t) => el("li", { text: t })));
}

const bytes = (s) => new TextEncoder().encode(s).length;
/// What is wrong with the collection's fields, in sentences under them. An empty name is
/// said on Launch only, so a fresh form shows no problem. The art section says its own.
function colProblems(c) {
  const errs = { A: [], B: [] };
  const nameBytes = bytes($("colName").value.trim());
  if (nameBytes > 24) errs.A.push("The collection name is " + nameBytes + " bytes. The most is 24.");
  const unit = wholeCoins("colUnit");
  if (unit <= 0n) errs.A.push("Coins per piece must be above zero.");
  else if (c.supplyWhole > 0n && unit > c.supplyWhole) errs.A.push("Coins per piece cannot be more than the total supply.");
  const max = Number(wholeCoins("colMax"));
  if (!Number.isInteger(max) || max < 1 || max > 4294967295) errs.B.push("Max supply of pieces must be from 1 to " + fmtInt(4294967295) + ".");
  for (const k of Object.keys(errs)) $("colErr" + k).replaceChildren(...errs[k].map((x) => el("span", { text: x })));
  const all = [...Object.values(errs).flat(), ...K.studio.fieldProblems()];
  return { count: all.length, first: all[0] || "" };
}

/// The pieces a first buy earns and the deposit for their NFTs. The launch transaction pays that deposit to
/// the launcher's ticket, right after the first buy, and a keeper mints the NFTs into the launcher's wallet a few
/// seconds after the launch: no further approval. `out` is what the first buy receives, `col` the collection as
/// the program gets it ({ name, uriBase, unit, maxPerBuy, maxSupply }). The SDK's own numbers: one piece per
/// unit received, at most max per buy, within the max supply; mintDepositFor of those pieces at the rent of the
/// chain this page is on (launch-core read it once; mainnet's is not the local validator's).
/// `lamports` is null while the chain's rent is not read yet (the review then names no amount).
function firstDeposit(out, col) {
  if (!out || out <= 0n || !col || col.unit <= 0n) return { pieces: 0, lamports: 0n };
  const per = out / col.unit;
  const pieces = Math.max(0, Math.min(Number(per > 255n ? 255n : per), col.maxPerBuy, col.maxSupply, H.collectible.MAX_PIECES_PER_WALLET));
  if (pieces === 0) return { pieces, lamports: 0n };
  return { pieces, lamports: core.rentKnown() ? H.collectible.mintDepositFor(rentFn(), { name: col.name, uriBase: col.uriBase, minted: 0 }, pieces) : null };
}
/// The collection as the form stands, for the cost panel. An art address that is not ready yet counts as the
/// longest one the program takes (80 bytes), so the Total is never below what the launch pays.
function formCollection() {
  let uriBase = "";
  try { const t = K.studio.target(); uriBase = t ? t.uriBase : ""; } catch (_) { uriBase = ""; }
  if (!uriBase) uriBase = "x".repeat(80);
  return { name: $("colName").value.trim(), uriBase, unit: wholeCoins("colUnit") * 10n ** BigInt(DECIMALS), maxPerBuy: Number($("colPerBuy").value), maxSupply: Number(wholeCoins("colMax")) };
}
const firstOut = (c) => { const q = core.quoteFirst(c); return q ? q.amountOut : 0n; };

core.run({
  template: () => "collectible",
  kind: () => "Collectible",
  /// the deposit for the NFTs of the first buy, paid in the launch transaction
  deposit(c) { return firstDeposit(firstOut(c), formCollection()).lamports; },
  extendLaunch(v, dev, plan) {
    // no first buy, no pieces, no deposit: the first buy is quoted only when there is one (quoteSwap refuses a
    // zero amount, and the form's default is no first buy)
    if (!(v.dev > 0n)) return [];
    const out = H.quoteSwap({ direction: H.DIRECTION.BUY, amountIn: v.dev, ...core.firstPool(v), lpFeeBps: v.lpFeeBps, protocolFeeBps: plat.protocolFeeBps, hookFeeBps: 0, feeOverrideBps: null }).amountOut;
    const d = firstDeposit(out, v.collectible);
    return d.lamports > 0n ? [H.collectible.depositTransfer(dev, plan.pool, d.lamports)] : [];
  },
  rent(c) {
    if (K.kind !== "pegged") return costOf("collectible") + (c.dev > 0n ? ticketRent() : 0n);
    // the site's own upload answers an address of the site's origin plus 50 characters
    const url = $("metaUrl").value.trim() || location.origin + "/uploads/" + "x".repeat(41);
    return costOf("pegged") + perByte() * BigInt(bytes(c.name) + bytes(c.symbol) + bytes(url)) + (c.dev > 0n ? ticketRent() : 0n);
  },
  review(c) {
    explain(c);
    const q = core.quoteFirst(c);
    const unit = wholeCoins("colUnit"), perBuy = Number($("colPerBuy").value);
    const notes = ["The collectible hook takes no fee. The two fees above are the only ones."];
    if (unit > 0n) notes.push("A buy earns one piece for each " + unit.toLocaleString("en-US") + " " + c.sym + " it buys, at most " + perBuy + " a buy. A wallet keeps one piece for each " + unit.toLocaleString("en-US") + " " + c.sym + " it holds.");
    if (K.kind === "pegged") notes.push("This is a pegged coin. The collectible program runs inside every transfer of it, sells included.");
    const art = K.studio.note();
    if (art) notes.push(art);
    const artProblem = K.studio.problem();
    return {
      buy: core.side(), sell: core.side(), notes,
      first: q ? { rows: core.firstRows(q, c, "", ""), note: firstNote(q, c) } : null,
      rentNote: K.kind === "pegged" ? "A pegged coin stores its name, ticker and metadata address in the coin, so longer ones cost a little more rent." : "",
      problems: !ctx.lookupTable ? "This site is missing the platform lookup table, so a collectible cannot be launched from it." : colProblems(c).count ? "Change what is marked under The collection before you launch." : artProblem,
    };
  },
  validate(out) {
    if (!ctx.lookupTable) throw new Error("A collectible needs the platform lookup table, and deployments/" + ctx.cluster + "-alt.json is missing on this site.");
    const pr = colProblems(core.values());
    if (pr.count) throw new Error("Check the collection. " + pr.first);
    const cname = $("colName").value.trim();
    const nameBytes = bytes(cname);
    if (!nameBytes || nameBytes > 24) throw new Error("Give the collection a name of 1 to 24 bytes.");
    const unitWhole = wholeCoins("colUnit");
    if (unitWhole <= 0n) throw new Error("Coins per piece must be above zero.");
    if (unitWhole > out.supplyWhole) throw new Error("Coins per piece cannot be more than the total supply.");
    const maxSupply = Number(wholeCoins("colMax"));
    if (!Number.isInteger(maxSupply) || maxSupply < 1 || maxSupply > 4294967295) throw new Error("Max supply of pieces must be between 1 and " + fmtInt(4294967295) + ".");
    const maxPerBuy = Number($("colPerBuy").value);
    // the art: where each piece's address points and the 16 art bytes in it
    const art = K.studio.target();
    if (!/^https?:\/\//.test(art.uriBase) || bytes(art.uriBase) > 80) throw new Error("The address of the art must start with http and be at most 80 bytes.");
    out.collectible = { name: cname, uriBase: art.uriBase, unit: unitWhole * 10n ** BigInt(DECIMALS), maxSupply, maxPerBuy, art: art.art, pegged: K.kind === "pegged" };
  },
  minOut: (v) => applyBps(H.quoteSwap({ direction: H.DIRECTION.BUY, amountIn: v.dev, ...core.firstPool(v), lpFeeBps: v.lpFeeBps, protocolFeeBps: plat.protocolFeeBps, hookFeeBps: 0, feeOverrideBps: null }).amountOut, 100),
  done(v, result) {
    // the upload's storage session has done its work once the coin carries the folder
    if (K.studio.mode() === "pictures" || K.studio.mode() === "layers") K.studio.forgetSession();
    if (v.dev > 0n) result.append(el("p", { class: "help", text: "Your first buy earned pieces. A block two slots after the launch decides their look. Their NFTs are minted into your wallet a few seconds later. Open the coin to see them." }));
  },
});
/// What the review says under "Your first buy": the pieces it earns and the deposit for their NFTs.
function firstNote(q, c) {
  const d = firstDeposit(q.amountOut, formCollection());
  if (!d.pieces) return "Your first buy is smaller than one piece's coins, so it earns no piece.";
  const nfts = d.pieces === 1 ? "its NFT" : "their NFTs", it = d.pieces === 1 ? "it" : "them";
  const amount = d.lamports === null ? "a deposit" : "a deposit of " + fmtAmount(((d.lamports + 99_999n) / 100_000n) * 100_000n, 9, 4) + " SOL";
  return "Your first buy also earns " + (d.pieces === 1 ? "1 piece" : d.pieces + " pieces") + ", decided the same way. The launch adds " + amount + " for " + nfts + ", used to mint " + it + " into your wallet a few seconds after the launch. " + (d.pieces === 1 ? "It stays" : "They stay") + " yours while you hold the coins behind " + it + ".";
}
setKind(K.kind);
