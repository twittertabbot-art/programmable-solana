// The pegged coin in the pool report: the fixtures of the new layouts, the coin's name, the kind of coin read
// from its mint, the score, the config diff and the accounts of a simulated swap. None of it touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { HookpoolClient, HOOK_KIND, PROGRAMS, collectible, decodeTransferHook, decodeToken2022Metadata, pda } from "../../sdk/dist/index.js";
import { coinFacts, coinStatus, transferHookOf } from "../lib/coin.mjs";
import { metadataOf, readCoins, readMetadata } from "../lib/chain.mjs";
import { scorePool } from "../lib/score.mjs";
import { diffHookConfig, decodeConfigFields } from "../lib/diff.mjs";
import { hookRefFor, isPeggedPool, peggedSwapAccounts } from "../lib/simulate.mjs";
import { readUnbacked, planSettles } from "../lib/crank.mjs";
import { poolEntry } from "../lib/status.mjs";
import {
  collectionConfig, ticketBytes, splMintBytes, mint2022Bytes, metaplexMetadataBytes, extraMetasBytes, tokenAccount2022Bytes,
  POOL, OWNER, OTHER, SYSTEM, BASE_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, HOOK_COLLECTIBLE, BATCH_WAITING,
} from "./bytes.mjs";

const key = () => Keypair.generate().publicKey;
const ctx = { time: "2026-10-04T12:00:00.000Z", slot: 900 };
const FLAGS = 4162;   // AFTER_SWAP | ON_POOL_CREATE | CALL_ON_BUY: the collectible hook, no CALL_ON_SELL
const ok = { ok: true, stage: null, error: null };
const failSwap = { ok: false, stage: "swap", error: "swap: custom error 6000" };
const NAME = { name: "Programmable", symbol: "SHOT", uri: "https://example.com/meta/shot.json" };
/// A mint account as the RPC returns it.
const acct = (owner, data) => ({ owner, data: Buffer.from(data), lamports: 1, executable: false });
const splMint = () => acct(TOKEN_PROGRAM, splMintBytes());
const peggedMint = (hook = { program: HOOK_COLLECTIBLE }) => acct(TOKEN_2022_PROGRAM, mint2022Bytes({ transferHook: hook, metadata: NAME }));
/// A decoded pool, as far as the coin check and the swap accounts read it.
const pool = (over = {}) => ({
  address: POOL, baseMint: BASE_MINT, quoteMint: SYSTEM, hasHook: true, hookProgram: HOOK_COLLECTIBLE, hookKind: HOOK_KIND.PLATFORM, hookFlags: FLAGS,
  baseTokenProgram: TOKEN_2022_PROGRAM, hookExtraMetas: OTHER, hookQuoteTreasury: SYSTEM, ...over,
});
const plainPool = (over = {}) => pool({ baseTokenProgram: TOKEN_PROGRAM, ...over });
const cfgOf = (over = {}) => collectible.decodeCollectionConfig(collectionConfig(over));
const peggedCfg = () => cfgOf({ pegged: true, tokenProgram: TOKEN_2022_PROGRAM });
const scoreInput = (over = {}) => ({ hasHook: true, flags: FLAGS, hookKind: 2, template: "collectible", buySim: ok, sellSim: ok, effectiveBuyTaxBps: 0, effectiveSellTaxBps: 0, capBps: 0, declaredMismatchBps: 0, taxChangedRecently: false, rendererMovedRecently: false, manifestAdminSet: false, upgradeAuthority: OWNER.toBase58(), recentAlertLevels: [], ...over });

test("fixtures: the config carries `pegged` after the token program, the ticket carries `staged` and `stagedSlot` after the rolls", () => {
  const plain = cfgOf({ minted: 7, live: 5 });
  assert.deepEqual([plain.pegged, plain.tokenProgram.toBase58(), plain.unit, plain.minted, plain.live], [false, TOKEN_PROGRAM.toBase58(), 50_000_000_000_000n, 7, 5]);
  const pegged = cfgOf({ pegged: true, tokenProgram: TOKEN_2022_PROGRAM, minted: 7, live: 5, name: "Shots II" });
  assert.deepEqual([pegged.pegged, pegged.tokenProgram.toBase58(), pegged.unit, pegged.minted, pegged.live, pegged.name], [true, TOKEN_2022_PROGRAM.toBase58(), 50_000_000_000_000n, 7, 5, "Shots II"]);
  // 8 discriminator + 3 bumps + 6 keys: the flag is byte 203, and it is the only byte that differs
  const a = collectionConfig(); const b = collectionConfig({ pegged: true });
  assert.deepEqual([a.length, b.length, a[203], b[203]], [a.length, a.length, 0, 1]);
  assert.deepEqual([...a.keys()].filter((i) => a[i] !== b[i]), [203]);

  const [p1, p2] = [key(), key()];
  const raw = ticketBytes({ user: OTHER, minted: 3, rolls: 9, staged: 2, stagedSlot: 777n, owned: [p1, p2], batches: [{ state: BATCH_WAITING, pieces: 1, firstRoll: 8, targetSlot: 500n }] });
  const t = collectible.decodeTicket(raw);
  assert.deepEqual([t.minted, t.rolls, t.staged, t.stagedSlot, t.pending, t.owned.map((k) => k.toBase58())], [3, 9, 2, 777n, 1, [p1.toBase58(), p2.toBase58()]]);
  assert.deepEqual([t.batches[0].state, t.batches[0].pieces, t.batches[0].firstRoll, t.batches[0].targetSlot], [BATCH_WAITING, 1, 8, 500n]);
  // the program's own offsets: staged at 81, its slot at 82, the batches at 90 (63 bytes each), the count of the list at 342
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  assert.deepEqual([raw[81], view.getBigUint64(82, true), raw[90], raw[91], view.getUint32(342, true), raw.length], [2, 777n, BATCH_WAITING, 1, 2, 346 + 64]);
  // a ticket written without them decodes to nothing staged
  const bare = collectible.decodeTicket(ticketBytes({ user: OTHER }));
  assert.deepEqual([bare.staged, bare.stagedSlot, bare.owned, bare.pending], [0, 0n, [], 0]);
});

test("fixtures: a pegged mint is 436 bytes with the pointer, the transfer hook and its own name", () => {
  const data = mint2022Bytes({ transferHook: { program: HOOK_COLLECTIBLE }, metadata: NAME });
  assert.deepEqual([data.length, data[165]], [436, 1]);
  const hook = decodeTransferHook(data);
  assert.deepEqual([hook.program.toBase58(), hook.authority], [HOOK_COLLECTIBLE.toBase58(), null]);
  const md = decodeToken2022Metadata(BASE_MINT, data);
  assert.deepEqual([md.name, md.symbol, md.uri, md.isMutable], ["Programmable", "SHOT", NAME.uri, false]);
  assert.equal(splMintBytes().length, 82);
  assert.equal(mint2022Bytes().length, 82);
});

test("the transfer hook of a mint: none on a plain coin, program and authority on a hooked one", () => {
  assert.equal(transferHookOf(null), null);
  assert.equal(transferHookOf(splMint()), null);
  assert.equal(transferHookOf(acct(TOKEN_2022_PROGRAM, mint2022Bytes())), null);
  assert.equal(transferHookOf(acct(TOKEN_2022_PROGRAM, mint2022Bytes({ metadata: NAME }))), null);
  // the same bytes under the classic token program are not a Token-2022 mint: nothing runs
  assert.equal(transferHookOf(acct(TOKEN_PROGRAM, mint2022Bytes({ transferHook: { program: HOOK_COLLECTIBLE } }))), null);
  assert.deepEqual(transferHookOf(peggedMint()), { program: HOOK_COLLECTIBLE.toBase58(), authority: null });
  assert.deepEqual(transferHookOf(peggedMint({ program: HOOK_COLLECTIBLE, authority: OTHER })), { program: HOOK_COLLECTIBLE.toBase58(), authority: OTHER.toBase58() });
  // no program yet, but a key that can set one: the SDK's decoder and the watcher both report it
  const armed = peggedMint({ program: null, authority: OTHER });
  const raw = decodeTransferHook(new Uint8Array(armed.data));
  assert.deepEqual([raw.program, raw.authority.toBase58()], [null, OTHER.toBase58()]);
  assert.deepEqual(transferHookOf(armed), { program: null, authority: OTHER.toBase58() });
  // bytes that are not a mint at all never throw
  assert.equal(transferHookOf(acct(TOKEN_2022_PROGRAM, new Uint8Array(170).fill(255))), null);
});

test("the name of a pegged coin is read from the coin itself, a plain coin's from its Metaplex account", async () => {
  const plainMint = key(); const peggedCoin = key(); const nameless = key(); const gone = key();
  const peggedData = mint2022Bytes({ mint: peggedCoin, transferHook: { program: HOOK_COLLECTIBLE }, metadata: NAME });
  const accounts = new Map([
    [pda.metadata(plainMint).toBase58(), acct(OTHER, metaplexMetadataBytes({ mint: plainMint, name: "Shot Coin", symbol: "PLAIN" }))],
    [plainMint.toBase58(), splMint()],
    [peggedCoin.toBase58(), acct(TOKEN_2022_PROGRAM, peggedData)],
    [nameless.toBase58(), splMint()],
  ]);
  let calls = 0;
  const connection = { async getMultipleAccountsInfoAndContext(keys) { calls += 1; return { context: { slot: 77 }, value: keys.map((k) => accounts.get(k.toBase58()) ?? null) }; } };
  const { metas, mints } = await readCoins(connection, [plainMint, peggedCoin, nameless, gone, peggedCoin]);
  assert.equal(calls, 1);   // two accounts per coin, all in one read
  assert.deepEqual([metas.get(plainMint.toBase58()).name, metas.get(plainMint.toBase58()).symbol], ["Shot Coin", "PLAIN"]);
  assert.deepEqual([metas.get(peggedCoin.toBase58()).name, metas.get(peggedCoin.toBase58()).symbol], ["Programmable", "SHOT"]);
  assert.deepEqual([metas.get(nameless.toBase58()), metas.get(gone.toBase58())], [null, null]);
  assert.deepEqual([mints.size, mints.get(gone.toBase58()), mints.get(peggedCoin.toBase58()).owner.toBase58()], [4, null, TOKEN_2022_PROGRAM.toBase58()]);
  assert.equal((await readMetadata(connection, [peggedCoin])).get(peggedCoin.toBase58()).symbol, "SHOT");
  // the Metaplex account wins when a coin has both; a Token-2022 mint without a name of its own has none
  const both = metadataOf(peggedCoin, acct(OTHER, metaplexMetadataBytes({ mint: peggedCoin, symbol: "MPLX" })), acct(TOKEN_2022_PROGRAM, peggedData));
  assert.equal(both.symbol, "MPLX");
  assert.equal(metadataOf(peggedCoin, null, acct(TOKEN_2022_PROGRAM, mint2022Bytes({ transferHook: { program: HOOK_COLLECTIBLE } }))), null);
  assert.equal(metadataOf(peggedCoin, null, null), null);
});

test("coin facts: a plain coin runs no program, and says so only on a collectible pool", () => {
  const f = coinFacts({ pool: plainPool(), mintInfo: splMint(), template: "collectible", collectibleCfg: cfgOf() });
  assert.deepEqual([f.kind, f.tokenProgram, f.transferHook, f.runsHook, f.verified, f.problems], ["plain", "spl-token", null, false, false, []]);
  assert.deepEqual(f.notes, ["Plain coin (SPL Token): the coin runs no program of its own. Checked on its mint this pass."]);
  assert.deepEqual(coinStatus(f), { kind: "plain", tokenProgram: "spl-token", transferHookProgram: null, transferHookAuthority: null });
  const t22 = coinFacts({ pool: plainPool(), mintInfo: acct(TOKEN_2022_PROGRAM, mint2022Bytes({ metadata: NAME })), template: "collectible", collectibleCfg: cfgOf({ tokenProgram: TOKEN_2022_PROGRAM }) });
  assert.deepEqual([t22.kind, t22.tokenProgram, t22.problems], ["plain", "token-2022", []]);
  assert.ok(t22.notes[0].startsWith("Plain coin (Token-2022 without a transfer hook)"));
  // every other pool with a plain coin: nothing to say, nothing changes
  for (const template of ["tax", "launch_guard", "buyback", "custom", "none"]) {
    const g = coinFacts({ pool: plainPool({ hookProgram: PROGRAMS.hook_tax }), mintInfo: splMint(), template });
    assert.deepEqual([g.kind, g.problems, g.notes, g.runsHook], ["plain", [], [], false]);
  }
});

test("coin facts: a pegged coin is stated as facts, each one checked on the mint", () => {
  const f = coinFacts({ pool: pool(), mintInfo: peggedMint(), template: "collectible", collectibleCfg: peggedCfg() });
  assert.deepEqual([f.kind, f.tokenProgram, f.runsHook, f.verified, f.problems], ["pegged", "token-2022", true, true, []]);
  assert.deepEqual(f.transferHook, { program: HOOK_COLLECTIBLE.toBase58(), authority: null });
  assert.deepEqual(f.notes, [
    `Pegged coin: a Token-2022 coin whose transfer hook is this pool's own hook program ${HOOK_COLLECTIBLE.toBase58()}. Checked on its mint this pass.`,
    "The coin runs that platform program inside every transfer, sells included.",
    "Nobody can change which program the coin runs: its transfer hook authority is none.",
    "A plain transfer carries the piece to the receiver, or burns it. The receiver takes one piece per whole unit the transfer sends. A piece burns when the receiver has no ticket, gains no whole unit, or took the coins outside its associated token account.",
  ]);
  assert.deepEqual(coinStatus(f), { kind: "pegged", tokenProgram: "token-2022", transferHookProgram: HOOK_COLLECTIBLE.toBase58(), transferHookAuthority: null });
  for (const n of f.notes) assert.ok(/^[\x20-\x7e]*$/.test(n), n);
});

test("coin facts: a transfer hook the pool should have refused is a danger finding", () => {
  const danger = (input) => {
    const f = coinFacts({ template: "collectible", collectibleCfg: peggedCfg(), pool: pool(), ...input });
    assert.equal(f.kind, "mismatch");
    assert.equal(f.verified, false);
    assert.deepEqual(f.notes, []);
    for (const p of f.problems) { assert.ok(p.includes("should be impossible"), p); assert.ok(/^[\x20-\x7e]*$/.test(p), p); }
    return f;
  };
  // another program runs inside every transfer
  const other = danger({ mintInfo: peggedMint({ program: PROGRAMS.hook_tax }) });
  assert.deepEqual([other.problems.length, other.runsHook], [1, false]);
  assert.ok(other.problems[0].startsWith(`the coin runs program ${PROGRAMS.hook_tax.toBase58()} inside every transfer, sells included. That is not this pool's hook program.`));
  // the right program, but a key is left that can point the coin somewhere else
  const armed = danger({ mintInfo: peggedMint({ program: HOOK_COLLECTIBLE, authority: OTHER }) });
  assert.deepEqual([armed.problems.length, armed.runsHook], [1, true]);
  assert.ok(armed.problems[0].startsWith(`the coin's transfer hook can still be changed by ${OTHER.toBase58()}.`));
  // both at once: two findings
  assert.equal(danger({ mintInfo: peggedMint({ program: PROGRAMS.hook_tax, authority: OTHER }) }).problems.length, 2);
  // no program yet, and a key that can set one
  const later = danger({ mintInfo: peggedMint({ program: null, authority: OTHER }) });
  assert.ok(later.problems[0].startsWith(`the coin has no transfer hook program yet, but ${OTHER.toBase58()} can set one.`));
  // the pool's own program, but the platform does not run it
  const frozen = danger({ pool: pool({ hookKind: HOOK_KIND.FROZEN }), mintInfo: peggedMint() });
  assert.ok(frozen.problems[0].includes("but the platform does not run that program"));
  // a pool without a hook must trade a coin that runs nothing
  const hookless = danger({ pool: pool({ hasHook: false, hookProgram: SYSTEM, hookKind: HOOK_KIND.NONE }), mintInfo: peggedMint(), template: "none", collectibleCfg: null });
  assert.ok(hookless.problems[0].includes("This pool has no hook, so its coin may run no program."));
  // the config and the mint disagree, either way
  const noHook = danger({ mintInfo: splMint() });
  assert.ok(noHook.problems[0].startsWith("the collection config says the coin is pegged, but the coin's mint has no transfer hook."));
  const unsaid = danger({ mintInfo: peggedMint(), collectibleCfg: cfgOf({ tokenProgram: TOKEN_2022_PROGRAM }) });
  assert.ok(unsaid.problems[0].startsWith("the coin runs the collectible program inside every transfer, but the collection config does not say pegged."));
  // a mint that no token program owns
  assert.ok(danger({ mintInfo: acct(OTHER, splMintBytes()) }).problems[0].includes("That is not a token program."));
});

test("coin facts: an unreadable mint is not guessed at", () => {
  const f = coinFacts({ pool: pool(), mintInfo: null, template: "collectible", collectibleCfg: peggedCfg() });
  assert.deepEqual([f.kind, f.tokenProgram, f.runsHook, f.problems], ["unknown", "unknown", false, []]);
  assert.deepEqual(f.notes, ["The coin's mint could not be read this pass. What kind of coin it is was not checked."]);
});

test("score: a pegged coin is clean, its sells count against the hook, and plain pools score exactly as before", () => {
  const pegged = scorePool(scoreInput({ coinRunsHook: true }));
  assert.equal(pegged.score, "clean");
  assert.deepEqual(pegged.reasons, []);
  assert.deepEqual(pegged.notes, ["The pool does not call this hook on a sell (no CALL_ON_SELL flag). The coin still runs the hook's program inside the sell, so every simulation of the pool includes a sell as the largest holder."]);
  // the coin's program runs inside the sell, so a sell that fails in the swap is the hook's: danger
  const stuck = scorePool(scoreInput({ coinRunsHook: true, sellSim: failSwap }));
  assert.deepEqual([stuck.score, stuck.reasons], ["danger", ["sell simulation failed inside the swap: swap: custom error 6000"]]);
  // the same failure on a plain coin stays a warning: the hook is never called there
  const plain = scorePool(scoreInput({ sellSim: failSwap }));
  assert.equal(plain.score, "warning");
  assert.ok(plain.reasons[0].includes("this hook is never called on sells"));
  // a plain pool scores the same with or without the new inputs
  for (const over of [{}, { sellSim: failSwap }, { buySim: failSwap }, { rendererMovedRecently: true }, { recentAlertLevels: ["danger"] }, { template: "tax", flags: 12865, effectiveBuyTaxBps: 300, capBps: 1000 }]) {
    assert.deepEqual(scorePool(scoreInput({ ...over, coinRunsHook: false, coinProblem: null })), scorePool(scoreInput(over)));
  }
  // a transfer hook the pool should have refused: danger, with the finding as the reason
  const bad = scorePool(scoreInput({ coinProblem: "the coin runs program X inside every transfer" }));
  assert.deepEqual([bad.score, bad.reasons], ["danger", ["the coin runs program X inside every transfer"]]);
  // also on a pool without a hook, which then no longer claims that nothing can block a trade
  const hookless = scorePool({ hasHook: false, buySim: ok, sellSim: ok, coinProblem: "the coin runs program X inside every transfer" });
  assert.deepEqual([hookless.score, hookless.notes], ["danger", ["No pool hook."]]);
  assert.deepEqual(scorePool({ hasHook: false, buySim: ok, sellSim: ok, coinProblem: null }), scorePool({ hasHook: false, buySim: ok, sellSim: ok }));
});

test("config diff: `pegged` is part of the config and can never change", () => {
  assert.equal(decodeConfigFields("collectible", collectionConfig({ pegged: true })).pegged, true);
  for (const [from, to] of [[false, true], [true, false]]) {
    const r = diffHookConfig("collectible", collectionConfig({ pegged: from }), collectionConfig({ pegged: to }), ctx);
    assert.deepEqual(r.changes, [{ time: ctx.time, slot: 900, field: "pegged", from: String(from), to: String(to) }]);
    assert.deepEqual(r.alerts, [{ level: "danger", message: `collectible pegged changed from ${from} to ${to} (should be impossible)` }]);
  }
  // counters moving on a pegged pool are still not a change
  assert.deepEqual(diffHookConfig("collectible", collectionConfig({ pegged: true, minted: 7, live: 7 }), collectionConfig({ pegged: true, minted: 8, live: 6, reservedPending: 1 }), ctx), { changes: [], alerts: [] });
});

test("status: only a collectible entry carries the coin, in a fixed shape", () => {
  const e = poolEntry({ template: "collectible", coin: { kind: "pegged", tokenProgram: "token-2022", transferHookProgram: HOOK_COLLECTIBLE, transferHookAuthority: null, extra: 1 } });
  assert.deepEqual(e.coin, { kind: "pegged", tokenProgram: "token-2022", transferHookProgram: HOOK_COLLECTIBLE.toBase58(), transferHookAuthority: null });
  assert.deepEqual(poolEntry({ template: "collectible", coin: { kind: "weird", tokenProgram: "x" } }).coin, { kind: "unknown", tokenProgram: "unknown", transferHookProgram: null, transferHookAuthority: null });
  assert.equal("coin" in poolEntry({ template: "tax" }), false);
});

test("the settle crank still covers a pegged coin: a holder that burned its coins directly is settled", async () => {
  // A burn is not a transfer, so the coin's hook does not run and the wallet stays above the peg. The settle
  // crank reads the balance in the coin's own token program (Token-2022) and at the Token-2022 address.
  const UNIT = 50_000_000_000_000n;
  const [burner, keeper2, classic] = [key(), key(), key()];
  const pieces = [key(), key()];
  const coinsOf = (user, program) => collectible.coinsAddress(user, BASE_MINT, program);
  const balances = new Map([
    [coinsOf(burner, TOKEN_2022_PROGRAM).toBase58(), acct(TOKEN_2022_PROGRAM, tokenAccount2022Bytes({ owner: burner, amount: UNIT }))],            // burned down to one unit
    [coinsOf(keeper2, TOKEN_2022_PROGRAM).toBase58(), acct(TOKEN_2022_PROGRAM, tokenAccount2022Bytes({ owner: keeper2, amount: UNIT * 2n }))],     // still backed
    // a classic SPL account at the classic address backs nothing for a Token-2022 coin
    [coinsOf(classic, TOKEN_PROGRAM).toBase58(), acct(TOKEN_PROGRAM, tokenAccount2022Bytes({ owner: classic, amount: UNIT * 5n }).subarray(0, 165))],
  ]);
  const hook = PROGRAMS.hook_collectible;
  const tickets = [ticketBytes({ user: burner, owned: pieces }), ticketBytes({ user: keeper2, owned: [key(), key()] }), ticketBytes({ user: classic, owned: [key()] })];
  const config = { owner: hook, data: Buffer.from(collectionConfig({ pegged: true, tokenProgram: TOKEN_2022_PROGRAM, unit: UNIT })) };
  const cfgKey = collectible.collectiblePda.cfg(POOL).toBase58();
  const connection = {
    async getAccountInfo() { return config; },
    async getProgramAccounts() { return tickets.map((data) => ({ pubkey: key(), account: { owner: hook, data: Buffer.from(data) } })); },
    // the config rides in the batched read with the balances
    async getMultipleAccountsInfo(list) { return list.map((k) => (k.toBase58() === cfgKey ? config : balances.get(k.toBase58()) ?? null)); },
  };
  const { unbacked, unread } = await readUnbacked(connection, [POOL]);
  assert.deepEqual(unread, []);
  const plan = planSettles(unbacked).send;
  assert.deepEqual(plan.map((it) => it.user.toBase58()).sort(), [burner.toBase58(), classic.toBase58()].sort());
  const b = plan.find((it) => it.user.equals(burner));
  assert.deepEqual([b.allowed, b.held, b.balance, b.burn.map((k) => k.toBase58()), b.coins.toBase58()], [1, 2, UNIT, [pieces[1].toBase58()], coinsOf(burner, TOKEN_2022_PROGRAM).toBase58()]);
  assert.equal(plan.find((it) => it.user.equals(classic)).balance, 0n);
});

test("a simulated swap on a pegged pool carries the accounts the coin's transfer hook needs, as the SDK's hookRef does", async () => {
  const user = key();
  const client = new HookpoolClient({});
  // pegged = a collectible pool with a Token-2022 coin, the SDK's own rule
  const cases = [pool(), plainPool(), pool({ hookProgram: PROGRAMS.hook_tax }), pool({ hasHook: false, hookProgram: SYSTEM, hookKind: HOOK_KIND.NONE })];
  assert.deepEqual(cases.map(isPeggedPool), [true, false, false, false]);
  assert.deepEqual(cases.map((p) => client.isPegged(p)), [true, false, false, false]);
  const flat = (list) => list.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]);
  // the vault's side of the transfer (a ticket that never exists), the burn queue, the hook's account list
  assert.deepEqual(flat(peggedSwapAccounts(pool())), [
    [collectible.collectiblePda.ticket(POOL, POOL).toBase58(), false, true],
    [collectible.collectiblePda.queue(POOL).toBase58(), false, true],
    [collectible.collectiblePda.validation(BASE_MINT).toBase58(), false, false],
  ]);
  // the same three the SDK passes at launch, after the callback's own accounts
  assert.deepEqual(flat(peggedSwapAccounts(pool())), flat(collectible.callbackExtras(POOL, user, BASE_MINT).slice(3)));

  // against the SDK's client.hookRef, fed with the same extra-accounts list. The SDK asks the collection config
  // whether the coin is pegged, so the fake chain holds one that says so.
  const metas = extraMetasBytes([{ pubkey: collectible.collectiblePda.cfg(POOL), isWritable: true }, { pubkey: collectible.SLOT_HASHES, isWritable: false }]);
  const cfgBytes = collectionConfig({ pegged: true, tokenProgram: TOKEN_2022_PROGRAM });
  const connection = {
    async getAccountInfo(k) {
      if (k.equals(OTHER)) return acct(HOOK_COLLECTIBLE, metas);
      if (k.equals(collectible.collectiblePda.cfg(POOL))) return acct(HOOK_COLLECTIBLE, cfgBytes);
      return null;
    },
  };
  const sdk = new HookpoolClient(connection);
  for (const p of [pool(), plainPool()]) {
    const mine = await hookRefFor(connection, p, user, metas);
    const theirs = await sdk.hookRef(p, user);
    assert.deepEqual(flat(mine.extra), flat(theirs.extra));
    assert.deepEqual([mine.program.toBase58(), mine.treasury.toBase58()], [theirs.program.toBase58(), theirs.treasury.toBase58()]);
    assert.equal(mine.extra.length, isPeggedPool(p) ? 5 : 2);
  }
});
