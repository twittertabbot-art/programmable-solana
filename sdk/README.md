# hookpool-sdk

The TypeScript client for the Programmable programs. It reads the on-chain state, quotes
trades, resolves the accounts a pool's hook needs, and builds complete transactions for
swaps, launches, liquidity and the collectible coins. The reference site in `web/`, the
trade API in `web/api`, the watcher and every script in `scripts/` are built on it.

It depends on `@solana/web3.js` 1.x and nothing else at run time.

## Build

From the repository root:

```
npm install
npm run build -w sdk
```

The build writes three bundles, two small ones for a launcher's own art, and the type
declarations:

| File | For |
|---|---|
| `sdk/dist/index.js`, `sdk/dist/*.d.ts` | Node. `@solana/web3.js` stays an external dependency. |
| `web/js/hookpool.js` | The browser. Everything is inside, `window.Buffer` included. It also exports the parts of web3.js a page needs (`Connection`, `PublicKey`, `Keypair`, `Transaction`, `TransactionInstruction`, `VersionedTransaction`, `TransactionMessage`, `SystemProgram`, `ComputeBudgetProgram`, `AddressLookupTableAccount`, `LAMPORTS_PER_SOL`). |
| `web/api/_sdk.js` | The trade API handlers, which run where they cannot reach `node_modules`. |
| `web/api/_artpack.js` | The art module alone (`src/artpack.ts`), for the art resolver: a few kilobytes, no web3.js. |
| `web/js/art-store.js` | The browser's upload of a collection (`src/artstore.ts`), loaded by the launch page only when needed. |

The stores of the real storage services (`web/js/art-store-turbo.js`, `art-store-irys.js`, about
2 MB each) are built apart, so their packages never reach the SDK: `cd sdk/art-vendor`, then
`npm ci --ignore-scripts` and `npm run build`. The versions are pinned there.

`npm run typecheck -w sdk` checks the types without building.

The package is not on npm. Use it by path (`import ... from "../sdk/dist/index.js"`, as the
scripts do) or install the folder into another project with
`npm install --install-links <path to this repository>/sdk`.

## Program ids

The seven program ids are constants in `src/constants.ts` (`PROGRAMS`): `hookpool`,
`hooklaunch` and the five template hooks `hook_tax`, `hook_launch_guard`, `hook_buyback`,
`hook_collectible`, `hook_rules`. They are the ids of this build. Whoever deploys the
programs under new ids runs `node scripts/rekey.mjs` from the repository root, which
rewrites the ids everywhere (programs, SDK, site, adapter), and then rebuilds.

## Try it

`sdk/examples/quickstart.mjs` launches a coin with a tax on a local validator, quotes, buys,
sells, reads the trade back from the chain and takes the tax; then it launches a second
coin on the curve, buys it to graduation and trades it afterwards. Read it first: it is the
shortest complete use of the SDK.

```
bash scripts/localnet.sh up
node scripts/init-platform.mjs localnet
node sdk/examples/quickstart.mjs
```

## The client

```js
import { Connection, PublicKey } from "@solana/web3.js";
import { HookpoolClient } from "hookpool-sdk";

const client = new HookpoolClient(new Connection(rpcUrl, "confirmed"), { lookupTable });
```

`lookupTable` is optional. It is the address lookup table that `scripts/init-platform.mjs`
creates and writes to `web/deployments/<cluster>-alt.json`. With it, `client.buildTx(payer,
instructions)` compiles a v0 transaction in which every fixed address costs one byte. A buy
on a collectible pool needs it to fit in one transaction. Without it everything else works.

All amounts are `bigint` in raw units: lamports for SOL, the smallest unit for a coin.
Fees are in basis points (100 = 1%). `DIRECTION.BUY` spends the quote token (SOL) for the
coin, `DIRECTION.SELL` the other way.

### Reading

| Call | Gives |
|---|---|
| `platform()` | The platform account: fees, caps, treasury, paused flag, whitelist, and the curve settings (`curveVirtualQuote`, `curveGraduationTarget`, `curveGraduationFeeBps`, `curveEnabled`). |
| `pool(address)`, `poolByMints(base, quote)`, `allPools()` | Pools. A pool carries its reserves, its fee, its hook program, the hook's flags and treasury, `hookFeesOwedQuote` (see "Hook fees that wait"), and the curve (`curveState`, `virtualQuote`, `graduationTarget`, `graduationFeeBps`; see "The curve launch"). |
| `launchForMint(mint)`, `allLaunches()` | The launch record of a coin: who launched it, with which hook, how much LP was locked, and whether it was launched on the curve (`curve`). |
| `curveProgress(pool)`, `curveEvents(pool)` | A coin on the curve: raised, target, share sold, market cap, the burn at graduation; its `CurveOpened` and `Graduated` events. |
| `mint(mint)`, `metadata(mint)`, `tokenBalance(owner, mint, tokenProgram?)` | The coin itself. `metadata` reads a Metaplex account or, for a pegged coin, the name stored in the Token-2022 mint. |
| `hookInfo(pool)` | What the pool's hook is: which template (`"tax"`, `"launch_guard"`, `"buyback"`, `"collectible"`, `"rules"`, or `"custom"`), its flags in words (`summary.sentences`), its settings (`tax`, `guard`, `buyback`, `collectible`, `rules`), and `upgradeAuthority` (`null` = frozen). For a rules coin, `rulesSentences` states every rule that is switched on, with its rates and windows. |
| `rulesState(pool)`, `rulesStakeOf(pool, wallet)`, `rulesLock(pool)` | A rules coin as of now: see "Launch rules". |
| `chainTime()` | The slot and the Unix time the programs see (the Clock sysvar). |
| `recentSwaps(pool, limit)`, `allEvents(address, limit)` | History, decoded from the chain's events. `candlesFromSwaps` turns swaps into candles. |
| `poolView(pool, opts)`, `rulesView(pool, opts)`, `walletBalances(owner, pool)`, `readAccounts(keys)` | Everything a page shows in one read: see "Reading cheaply". |
| `recentEventsSince(address, until, limit)`, `curveEventsFromStart(pool)` | History that reads only what is new, and the curve's two events found from the pool's first transaction. |
| `getTransactionsBySignature(connection, signatures, opts)` | `getTransaction` for many signatures, batched, each answer paired with its signature by the transaction's own signature. See "Reading many transactions". |

### Reading many transactions

web3.js `connection.getTransactions(signatures)` sends one batched request and pairs the
answers with the signatures by their position. Some RPC providers answer a batch in any
order, so that pairing gives a signature the wrong transaction. Every reader of the SDK
(`recentSwaps`, `allEvents`, `recentEventsSince`, `curveEventsFromStart`) fetches with
`getTransactionsBySignature(connection, signatures, opts)` instead, and so should a caller
that reads transactions itself:

```js
const { transactions, unreadable } = await getTransactionsBySignature(connection, signatures, { commitment: "confirmed", perRequest: 100, pauseMs: 0 });
// transactions[i] is the transaction of signatures[i], or null
```

`transactions` has one entry per signature, in the same order; null means the node has no
such transaction (yet). `opts`: `maxSupportedTransactionVersion` (default 0), `commitment`
(default the connection's), `perRequest` (signatures per batched request, default 100) and
`pauseMs` (a pause between two requests, default 0). A signature asked twice is fetched once.

A transaction of a version the request does not support (mainnet carries version 1
transactions; the node answers error -32015 for one) makes web3.js throw the whole batch
away. The helper then asks that batch again one signature a request (four at a time): a
signature that answers -32015, or whose answer web3.js cannot take apart, goes to
`unreadable` (`{ signature, code, message }`, in the order asked) with null in
`transactions`, and the others are kept. Any other error is thrown, as before.
`isUnreadableTransactionError(e)` and `UNREADABLE_TRANSACTION_CODE` are exported. The
readers skip an unreadable transaction: `recentEventsSince` and `curveEventsFromStart` count
them in `unreadable`, and `recentEventsSince` still moves `newest` past them.

### Reading cheaply

A paid RPC bills by the call, and an archive call (`getTransaction`, `getSignaturesForAddress`)
counts twice. A page that reads every account on its own, and the last 200 transactions every
20 seconds, makes hundreds of calls a minute. These reads give the same figures for far fewer.

| Call | Gives, and what it costs |
|---|---|
| `poolView(pool, opts)` | One `getMultipleAccounts` for a pool read before (two for an address): the pool, its coin's mint, the quote mint (not for SOL), the LP supply and the lock account, the hook (`hook`, as `hookInfo` gives it, with `upgradeAuthority` "unknown" unless `upgradeAuthority: true`), the hook's treasury (`treasury`), and as asked the platform (`platform: true`, or one you read before), `metadata`, `launch`, a wallet's balances (`wallet`), a rules coin's `rulesView` (`rules`) and a buyback coin's next run (`buyback`, with a platform). `slot` is the slot of the read: no `getSlot` beside it. |
| `rulesView(pool, { wallet, platform, config })` | A rules coin in one read: `state` (`rulesState`), `lock` (`rulesLock`), `stake` (`rulesStakeOf`) or, on a strict coin, `holder` (`rulesHolderOf`), and `run` (`rulesBurnInstructions`), all of the same slot. Pass a `config` read before and a strict coin stays one read too. |
| `walletBalances(owner, pool)` | One read: the wallet's SOL, coin, quote token, wrapped SOL (null without the account) and LP. |
| `recentEventsSince(address, until, limit = 50)` | The events of the transactions newer than the signature `until` (null: the newest `limit`), in the order of `allEvents`. Failed transactions are not fetched. Keep `newest` and pass it next time: when nothing happened the call is one `getSignaturesForAddress` and nothing else. `unreadable` counts the transactions skipped as unreadable (see "Reading many transactions"). |
| `curveEventsFromStart(pool)` | `CurveOpened` and `Graduated`, searched from the pool's first transaction forward, so a graduation is found however many trades came after it (`curveEvents` reads from the newest). A page can keep the result: it never changes. |
| `eventToJson(event)`, `eventFromJson(json)` | An event as plain JSON (addresses as base58, `bigint` as strings) and back. The watcher's `trades/<pool>.json` holds events in this shape. |
| `hookInfoFromAccounts`, `rulesStateFromAccounts`, `rulesStakeFromAccounts`, `rulesLockFromAccounts`, `rulesHolderFromAccounts`, `walletKeys`, `walletFromAccounts`, `client.buybackRun`, `client.rulesBurnRun` | The same results from accounts you read yourself, in a batch of your own. No read. |

A page that opens a coin calls `poolView(address, { platform: true, metadata: true, launch: true,
wallet })` once, then `poolView(view.pool, { wallet, platform })` on its timer, and reads the
trades from the watcher's feed or with `recentEventsSince`. The reference site does so
(`web/coin.js`); `web/review/rpc-count.mjs` counts what a page asks of the RPC.

What the reference site's pages cost, counted on a local validator (calls; a coin with 481
trades; "with a watcher" means the trades and the Explore list come from the watcher's feed):

| Page | Before | Now, without a watcher | Now, with a watcher |
|---|---|---|---|
| A coin page, first load | 210 | 53 (50 of them the one history read) | 2 |
| A coin page open for 2 minutes, nobody trading | 1,271 | 64 | 3 |
| Explore, first load | 81 (38 coins) | 84 (41 coins, the same reads) | 0 |
| The liquidity page open for 2 minutes | 37 | 12 | 6 |
| A buy, until the page has read everything again | 16 | 9 | 9 |

### Quoting

`quoteLocal(pool, platform, direction, amountIn, hookInfo, slot?)` is instant and exact for
a pool without a hook and for the platform's templates (tax, buyback, collectible, rules,
and a launch guard whose window is over). While a launch guard's window or the sniper
window of a rules coin runs, the fee of a buy falls every slot, so the chain gives the
quoted amount or more; with `slot` set to the slot a trade landed in, the quote is that
trade to the unit. The quote also carries `amountOutCeiling`, the most the trade can pay
out when it lands later: inside such a window the quote at the pool's normal fee,
otherwise the same as `amountOut`. A rule on the receiver's balance after the trade (the
max wallet of a strict coin) is checked against the ceiling, so the check leaves room for
the falling fee. A price fall between the quote and the landing also raises the output, so
a buy within a hair of the cap can still be refused by the chain; a client that must land
should keep a margin.

On a rules coin a trade pays the three rates of its side (creator, holders, burn) whoever
is staked, so the quote depends on the rules alone, and the rules never change. A buy above
the coin's buy limit, inside its window, makes `quoteLocal` throw: the chain would refuse
that buy. `rulesBuyLimit(hookInfo.rules, slot)` tells the limit beforehand.

For a hook the platform did not write, the local quote assumes the hook takes nothing.
`quoteOnChain(user, pool, direction, amountIn)` simulates the swap and returns the real
output. Use it for the amount you show and for the minimum you send whenever
`hookInfo.template === "custom"`.

On a pool on the curve the price is made of the real quote reserve plus the pool's virtual
quote (`quoteSwap` takes `virtualQuote`; `quoteLocal` passes the pool's). The reserves the
quote reports (`reserveInAfter`, `reserveOutAfter`) are the real ones. The quote carries
`graduates`: true when the trade leaves the pool at or past its graduation target, which is
when `swapInstructions` appends `graduate`. A sell that would take more than the real
reserve throws a `CurveRefusal` (`CurveRealReserve`), as the chain refuses it.

The quote is the same arithmetic as the program, in the same order with the same rounding
(`src/math.ts` is a port of `programs/hookpool/src/math.rs`).

### Swapping

```js
const hookRef = await client.hookRef(pool, user);     // the hook's extra accounts for this wallet
const ixs = await client.swapInstructions(user, pool, hookRef, DIRECTION.BUY, amountIn, minOut);
const { tx } = await client.buildTx(user, ixs);       // or put them in a legacy Transaction
```

`swapInstructions` adds what the trade needs around the swap: the compute limit, the
wallet's token account for the coin if it has none, wrapping SOL, the ticket and the upkeep
of a collectible coin, and on a pool on the curve the `graduate` that goes with a trade at
the target (before the swap on a pool that stands at or past it, after the swap for a buy
that crosses it; see "The curve launch"). `opts.recipient` sends what the swap pays out to
another wallet; `user` still signs and pays. `opts.graduate` decides that `graduate`
(`true`, `false`, or left out: the SDK decides). `opts.mintDeposit` adds, to a buy of a
collectible coin, the deposit that lets a keeper mint its NFTs (see "One approval").
`minAmountOut` is sent as given: the SDK never lowers a floor.

**Wrapped SOL.** The pools trade wrapped SOL. The builders leave the wallet's wrapped SOL
account as they found it:

* A wallet that had none gets one for the length of the transaction and holds plain SOL at
  the end.
* A wallet that already had one keeps it open. A buy wraps and spends exactly the amount. A
  sell pays into that account, wrapped. Nothing the wallet held there moves.

The reason is the tax template: by default a coin's tax is paid into its dev's wrapped SOL
account, and closing that account would stop the payments. `client.unwrapInstructions(owner)`
turns everything in the account into plain SOL and leaves it open (the wallet must have
such an account: the call fails for one that has none). It is also how the
owner of a tax treasury takes the tax.

### Hook fees that wait

A pool whose hook takes a fee pays it to a treasury token account. If that account does not
exist at the moment of a trade, the trade still goes through, and the fee waits inside the
pool (`pool.hookFeesOwedQuote`). The next trade that finds the account pays everything that
waited. `client.hookFeesInstructions(payer, pool)` does it at once: it recreates the account
for its owner and pays it. Anyone may send it. It returns an empty list when nothing waits.

### Launching a coin

`launchInstructions(options)` returns two lists of instructions, `createTx` and `launchTx`,
the pool address and the extra signer (the mint keypair).

1. `createTx` creates the coin (fixed supply, no mint authority, no freeze authority) and
   the settings of the hook. Signers: the dev and the mint.
2. `launchTx` pays the launch fee, creates the pool with the chosen hook, locks all the
   launch liquidity forever, and makes the dev's first buy if one was asked. Signer: the dev.

The first transaction is not undone if the second fails, so send the second right away,
and do not publish the mint address before the first has landed.

There are two ways to start the pool. A SEEDED launch (`quoteAmount` above zero) puts the
creator's SOL into the pool next to the whole supply. A launch ON THE CURVE (`curve: true`,
no `quoteAmount`) puts no SOL in: the pool prices the coin with the platform's virtual SOL
and graduates once buyers have put in the target. See "The curve launch".

`template` chooses the hook:

| `template` | Options | What the coin does |
|---|---|---|
| `"none"` | | A plain pool. |
| `"tax"` | `tax: { buyBps, sellBps, maxBps, treasury? }` | A share of every buy and sell goes to the treasury wallet in SOL. The owner can lower or raise it up to `maxBps`, hand it over, or renounce (`ix.taxSetTax`, `ix.taxSetOwner`). |
| `"launch_guard"` | `guard: { guardSlots, startFeeBps }` | Buys in the first slots pay a high pool fee that falls to the normal fee. The fee stays in the pool. Sells are never touched. No liquidity can be added while the window runs. |
| `"buyback"` | `buyback: { buyBps, sellBps, minQuote }` | A share of every trade collects in a treasury nobody controls. Anyone can run a buyback that buys the coin with it and burns it (`client.buybackInstructions`). `minQuote`, the least the treasury must hold for a buyback, is at most 1 SOL (`MAX_BUYBACK_MIN_QUOTE`). |
| `"collectible"` | `collectible: { name, uriBase, unit, maxSupply, maxPerBuy, art, pegged? }` | Buys earn collectible pieces, and a wallet keeps one piece per `unit` of coins it holds. With `pegged: true` the coin is a Token-2022 coin whose pieces move or burn inside every transfer. A pegged coin cannot launch on the curve. |
| `"rules"` | `rules: { sniperSlots?, sniperStartFeeBps?, buy?, sell?, maxBuyQuote?, limitSlots?, creatorLockSeconds?, lockMarginSeconds? }` | The launcher switches on rules and sets their numbers; nobody can change them afterwards. See "Launch rules" below. |
| `"custom"` | `custom: { program, treasuryOwner?, setup? }` | A hook somebody else wrote. It must be frozen and have published its manifest. `setup` holds that hook's own instructions for its per-pool settings. The SDK refuses, before building anything, a hook that can still be upgraded or that owns the price curve. |

### The curve launch

A launch on the curve needs no SOL from the creator. `scripts/e2e-curve.mjs` uses every
call below on a live chain; HOOKS.md section 2 ("A pool on the curve") is the program's
side.

```js
const plan = await client.launchInstructions({
  dev, mint, name, symbol, uri, decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
  quoteMint: NATIVE_MINT, lpFeeBps: 100,
  curve: true,                       // no quoteAmount: the curve stands in for it
  devBuyQuote, minDevBuyOut,         // a first buy is allowed, priced on the curve
  template: "none",                  // or any template; a pegged collectible coin is refused
});
// plan.curve = { virtualQuote, graduationTarget, graduationFeeBps, lpLocked, graduatesAtLaunch }
```

How it works. The whole supply goes into the pool and the real quote reserve starts at 0.
The pool prices every trade as if it also held the platform's virtual quote
(`platform.curveVirtualQuote`, 30 SOL by default): the price is `(reserveQuote +
virtualQuote) / reserveBase`, so the coin starts at a market cap equal to the virtual
quote. A sell is paid from the real reserve only; the virtual part is never owed to anyone,
because the pool holds the whole supply of a closed mint when it opens and nothing but
trades moves its reserves. `add_liquidity` and `remove_liquidity` are refused while the
curve is open (`CurveOpen`, "liquidity opens at graduation"); the builders throw a
`CurveRefusal` with that sentence before anything is sent. The LP of the pool
(`curveInitialLp(supply, virtualQuote)` = `isqrt(supply * virtualQuote)`) is minted into the
pool's lock account at creation; nobody holds any.

Graduation. Once the real reserve has reached the platform's target
(`platform.curveGraduationTarget`, 85 SOL by default), anyone may send `graduate`
(`ix.graduate`, `client.graduateInstructions(pool)`): the virtual quote is dropped, the
platform's share of the target (`graduationFeeBps`, 0 by default, at most 10%) moves out
of the reserve into the protocol fees, and enough coins are burned from the pool's own
vault to keep the price. The exact arithmetic is `graduation(reserveBase, reserveQuote,
virtualQuote, target, feeBps)`:

```
fee  = min(target * feeBps / 10_000, reserveQuote - 1)        (floor)
R2   = reserveQuote - fee
B2   = floor(R2 * reserveBase / (reserveQuote + virtualQuote))
burn = reserveBase - B2
```

The price after, `R2 / B2`, is never below the price before and above it by less than one
unit of the coin. After graduation the pool is an ordinary pool of this DEX: same address,
liquidity open, the hook still running, `virtualQuote` and `graduationTarget` 0,
`curveState` `CURVE_GRADUATED`.

The SDK never hard-codes the numbers; it reads the platform account and the pool. With the
defaults and a supply of 1,000,000,000 coins at 6 decimals, `quoteSwap` and `graduation`
give: a start price of 30 / 1e9 = 0.00000003 SOL per coin; at 85 SOL raised the pool holds
`30 * 1e15 / 115` = 260,869,565,217,391 units (73.9% of the supply sold); a graduation at
exactly 85 SOL burns 68,052,930,056,711 units (6.8% of the supply) and leaves
192,816,635,160,680 units and 85 SOL, at the same price; the market cap at graduation is
about 441 SOL. With pool fees in the real reserve the figures move a little: the functions
are exact. The 6.8% is the figure at the target: a coin graduated later, after more buys,
burns less, `reserveBase * virtualQuote / (reserveQuote + virtualQuote)` at that moment
(`graduationIfNow(pool)` once the pool stands at or past its target;
`curveProgress(pool).burnIfGraduatedNow` is that number then, and the burn at the target
before; `burnAtTarget` is always the figure at the target).

Where graduate goes, and the floor. A pool between its target and its graduation still
trades on the curve, and anyone may graduate it at any moment. So every trade the SDK
builds on a pool on the curve follows one of two rules, and `quoteLocal` quotes it the same
way (its quote says `graduates` and `graduateFirst`):

1. The pool stands at or past its target before the trade (`readyToGraduate(pool)`), a buy
   or a sell: the transaction sends `graduate` right BEFORE the swap, and the trade is
   quoted on the pool as graduation leaves it (`poolAfterGraduation(pool)`: the coins
   burned, the fee taken, no virtual part). Our own transaction then always runs on the
   graduated pool, whether we graduate it or somebody did a moment earlier (a second
   `graduate` lands and changes nothing), so the quote is exact. `graduateFirst: true`.
   A sell that would have taken the pool back under its target on the curve is simply a
   sell on the graduated pool.
2. A buy that crosses the target from below: quoted on the curve, `graduate` right AFTER
   the swap. `graduateFirst: false`. A wallet that moves the pool first (and maybe
   graduates it) is a price move like any front-run: the buy's floor, the user's slippage
   on `amountOut`, protects it, and the trade reverts when the floor is not met.

The floor is always the caller's slippage on `amountOut`; `swapInstructions` sends
`minAmountOut` as given and nothing in the SDK lowers it. An earlier rule lowered the floor
to the fill on a pool graduated at its current reserves; far below the target that is a
pool that cannot exist, and the floor fell almost to nothing (an 89 SOL buy from 0.3 SOL
raised signed a floor 98.7% under its quote), which let a front-runner who pushes the pool
to its target and graduates it fill that buy at almost any price. On revision 3 of the pool
program a `graduate` that finds an open pool below its target (a sell landed first) lands
and does nothing, so a `graduate` in a transaction never fails it; the SDK does not depend
on either answer of the chain. `opts.graduate: false` leaves `graduate` out (a keeper that
cranks graduation itself, or a test that leaves a pool standing past its target), `true`
forces it. A dev buy large enough to reach the target on its own graduates the coin in the
launch transaction, after the buy (`plan.curve.graduatesAtLaunch`). The rule is
`firstBuyGraduates(devBuyQuote, platform, hookFeeBps)`: what the buy leaves in the pool
after the protocol fee and the hook fee (`firstBuyRaised`) reaches the target. The hook fee
is `firstBuyHookFeeBps(template, { tax, buyback }, platform.maxHookFeeBps)`: 0 without a
hook and for the launch guard (its fee is a pool fee and stays in the pool), the coin's own
buy rate for a tax or buyback coin, and the platform's cap for any other hook, whose fee is
not known in advance, so `graduate` is never added to a first buy that may fall short. A
launch form can call the same two functions to say so before the launch.

`floorForGraduation(minAmountOut, quote)` and `SwapQuote.amountOutFloor` are deprecated:
the first returns its input, the second equals `amountOut`. They are kept so that callers
written for the earlier rule keep running, and will be removed.

| Call | Does |
|---|---|
| `launchInstructions({ ..., curve: true })` | The launch above. Refused before anything is built: a pegged collectible coin (`CurvePegged`), a platform with the curve off (`CurveDisabled`), a `quoteAmount` above zero. |
| `createCurvePoolInstructions(creator, baseMint, quoteMint, lpFeeBps, baseAmount, hook?, baseTokenProgram?)` | A curve pool made directly, without the launchpad. The mint must be closed and `baseAmount` its whole supply. |
| `graduateInstructions(pool, { check? })` | `graduate` alone, for a keeper or a page. With `check` (the default) it throws `NotOnCurve` for a seeded pool and `GraduationNotReached` for an open pool below its target, as a message before sending (the chain refuses only the first; on revision 3 it lands the second and changes nothing); on a graduated pool it builds the instruction, which lands and changes nothing. |
| `curveProgress(pool)` | `{ state, raised, target, raisedBps, soldBps, startMarketCapQuote, marketCapQuote, virtualQuote, burnIfGraduatedNow, burnAtTarget, open, graduated }`, with the supply read from the mint. `state` is "none", "open" or "graduated". |
| `curveEvents(pool, limit?)` | The pool's `CurveOpened` and `Graduated` events from its last `limit` transactions (default 1,000), or null. |
| `platformUpdate(admin, wanted)` | `update_platform` for the fields that differ from the account, curve settings included; `{ changes, instructions }`, empty when nothing differs. For `scripts/init-platform.mjs`. |

Pure functions (`src/curve.ts`): `effectiveQuote(pool)`, `isOnCurve(pool)`,
`curveStateName(state)`, `priceOf(reserveBase, reserveQuote, virtualQuote, baseDecimals,
quoteDecimals)`, `graduation(...)` (with the program's checks), `readyToGraduate(pool)`
(on the curve and at or past its target), `graduationIfNow(pool)` (what `graduate` does
now: the graduation on a pool ready for it, nothing otherwise; `allowed` says which),
`poolAfterGraduation(pool)` (the pool as that graduation leaves it), `graduationBurn(pool)`
(exact at or past the target, a forecast at the target along the fee-less curve below it:
`forecast` says which), `curveProgress(pool, supply)`, `willGraduate(pool, direction,
quote)` (rule 1 or rule 2 above), `curveInitialLp(supply, virtualQuote)` (math.ts). `npm test -w sdk` runs their unit tests
(`test/curve.test.mjs`) on the built bundle. Constants: `CURVE_NONE`, `CURVE_OPEN`, `CURVE_GRADUATED`, `LAUNCH_KIND_CURVE`,
`DEFAULT_CURVE_VIRTUAL_QUOTE`, `DEFAULT_CURVE_GRADUATION_TARGET`,
`HARD_MAX_GRADUATION_FEE_BPS`, `MAX_CURVE_VIRTUAL_QUOTE`. `CURVE_ERRORS` holds the pool
program's nine curve errors (6043 to 6051: `CurveDisabled`, `CurveSupplyNotInPool`,
`CurveOpen`, `CurveHook`, `NotOnCurve`, `GraduationNotReached`, `CurveRealReserve`, the
pool's own `CurvePegged` for a pegged coin made into a curve pool directly, and
`CurveSettingsOutOfBounds` for the admin) with their texts, and `CURVE_PEGGED_ERROR` the
launchpad's `CurvePegged` (6011), which a launch meets first; `curveErrorFromLogs(logs)`
finds one in a failed transaction's logs; `curveSettingsProblem(virtual, target)` names
what a pair of settings breaks (a virtual quote above `u64::MAX / 4`, or a target below a
thousandth of the virtual quote when both are on); `CurveRefusal` (`.number`, `.code`,
`.message`, `.info`) is what the SDK throws. A trade whose output rounds to zero throws
"amount too small" (the program's `ZeroAmount`, on every pool); "not enough liquidity" is
a hook's curve answer (`HookCurveInvalid`).

Prices. `spotPrice(pool, ...)` and `priceOf` use the effective quote. The `Swapped` event
carries the real reserves, so `candlesFromSwaps(swaps, baseDecimals, quoteDecimals,
bucketSeconds, curve?)` takes `curve: { virtualQuote, graduatedSlot? }`: swaps up to and
including the graduation slot are priced with the virtual part (the graduating buy is in
the same transaction as `graduate`), later ones without. `curveEvents` gives both numbers.

The modules on a curve pool. `hook_rules` and `hook_buyback` measure prices and depths on
the effective quote: the observation of a burn or a buyback stores `(reserveBase,
reserveQuote + virtualQuote)`, and the cap of one buy is measured on the smaller of the
effective reserve now and the observed one. `buybackInstructions`, `rulesBurnInstructions`
and the pure `burnStep`, `burnLowered`, `buybackSpend` callers in the client pass effective
values, so the SDK's prediction of a buy equals the chain's on a curve pool as on a seeded
one. After graduation the virtual part is 0 and an observation taken on the curve still
compares right, because graduation keeps the price.

Events: `CurveOpened { pool, virtualQuote, graduationTarget, graduationFeeBps, slot }`
follows the `PoolCreated` of a curve pool; `Graduated { pool, reserveQuoteBefore,
reserveQuoteAfter, reserveBaseBefore, reserveBaseAfter, burnedBase, feeQuote, slot }` is
the one event of `graduate`. Both are inner instructions, decoded with the others.

### Buyback and burn: one rule for both

A buyback coin (`template: "buyback"`) and the burn of a rules coin buy the coin with
collected fees through an instruction anyone may send. So that its sender cannot make the
price or the depth it buys at, the instruction buys against an **observation** of the pool
that it recorded itself at least 25 slots (`BURN_INTERVAL_SLOTS`, about ten seconds)
earlier:

* The first call for a pool only records the pool's reserves. It buys nothing.
* A call that comes less than 25 slots after the last accepted call is refused by the
  chain (`TooSoon`, `BurnTooSoon`) and changes nothing.
* A call that finds the price above the observed one by more than the tolerance (twice the
  cap) records the reserves again and buys nothing: the price has to stand for 25 slots.
* Otherwise it buys. It spends the pot, at most the pool's cap of the SMALLER of the quote
  reserve now and the observed one, and records the pool as the buy left it.
* Between two calls the hook lowers the observation by itself: a trade that starts at a
  price below the observed one moves the observed price down to the price it starts at
  and leaves the slot. It never raises the observed depth (`burnLowered` is the exact
  rule), so liquidity added after an observation does not make the next buy larger. A
  pumped price is bought at only when no trade started below it for the whole interval.
  The config a client reads already carries this.

The cap is `burnCapBps(protocolFeeBps, lpFeeBps, buyFeeBps, sellFeeBps)`, between 1 and 50
basis points. It follows the fees a trade pays and nobody gets back: for a buyback coin
its two hook fees (`buybackCapBps`), for a rules coin the burn share of each side only
(`rulesBurnCapBps`). A large pot therefore takes several buys, 25 slots apart: whoever
looks after a coin calls the instruction on a timer.

`buybackInstructions(payer, pool, slippageBps = 300)` and
`rulesBurnInstructions(payer, pool, slippageBps = 300)` return the same shape, a `BurnRun`:

| Field | Meaning |
|---|---|
| `step` | What a call sent now does: `"observe"`, `"wait"`, `"buy"`, or `"tooSoon"` (the chain refuses it). |
| `due`, `dueSlot`, `slot` | Whether the chain accepts a call now, the first slot in which it does, and the slot this was worked out for. `due` is also false for a `"buy"` whose spend is so small that the pool would refuse it; `reason` then says so in a sentence. |
| `observation` | The observation in the config (`{ slot, reserveBase, reserveQuote }`), `null` when there is none yet. |
| `pot`, `capBps` | What waits to be spent, and the cap of one buy on this pool. |
| `spend`, `potLeft` | The next buy: what it spends and what stays. Exact when `step` is `"buy"`. Otherwise an estimate of the buy that follows, should the pool stand as it is. |
| `expectedOut`, `minOut` | What the buy buys and burns and the floor sent with it, when `step` is `"buy"`. `0n` otherwise: only a buy is quoted, so a pot of a few lamports (rounding) still gets its observation call. |
| `instructions` | The transaction. Empty when `step` is `"tooSoon"` or `due` is false. For `"observe"` and `"wait"` it is worth sending: it records the observation the next buy needs. |

Both return `null` when there is nothing to do: the pool has no such hook, a buyback
treasury is below the pool's minimum, or a burn pot is empty. `buybackInstructions` also
carries `treasuryLeft`, the older name of `potLeft`. `burnStep` is the rule itself as a
pure function, a port of `burn_step` in the interface crate; `BURN_OUTCOME` names the
outcome byte of the `BuybackExecuted` and `BurnExecuted` events (1 observed, 2 waited,
3 bought).

### Liquidity

`addLiquidityInstructions(user, pool, lpAmount, maxBase, maxQuote)` and
`removeLiquidityInstructions(user, pool, lpAmount, minBase, minQuote)`. `lpAmount` is in raw
LP units (LP has 6 decimals). The amounts for a number of LP units are
`mulDivCeil(lpAmount, reserve, lpSupply)` on a deposit and `mulDivFloor` on a withdrawal.
The liquidity a launch puts in is locked in the pool's lock account and can never be taken
out; liquidity somebody adds later is theirs to remove.

Two templates refuse `add_liquidity` for a while: the launch guard while its window runs,
and a rules coin while its sniper window runs. Their extra fee is a pool fee, and a wallet
that added liquidity for a moment would take part of it. `liquidityOpenSlot(hookInfo)`
returns the first slot in which adding works (`0n` when it always does). Removing
liquidity is never refused by a template. For a hook the platform did not write,
`hookInfo.summary.canBlockAdding` and `canBlockRemoval` say what its flags allow.

### Launch rules

`template: "rules"` launches a coin on the `hook_rules` template: the launcher switches on
rules, sets their numbers inside fixed bounds, and nobody can change them afterwards.
`RULES.md` at the repository root is the reference; `scripts/e2e-rules.mjs` uses every call
below on a live chain.

```js
const plan = await client.launchInstructions({
  dev, mint, name, symbol, uri, decimals: 6, totalSupply, quoteMint: NATIVE_MINT,
  lpFeeBps: 100, quoteAmount, devBuyQuote, minDevBuyOut,
  template: "rules",
  rules: {
    sniperSlots: 150, sniperStartFeeBps: 3000,            // buys pay 30% falling to the pool fee over 150 slots
    buy:  { creatorBps: 50, holdersBps: 100, burnBps: 50 }, // the three shares of a buy
    sell: { creatorBps: 100, holdersBps: 200 },             // and of a sell
    maxBuyQuote: 200_000_000n, limitSlots: 750,             // no buy above 0.2 SOL for 750 slots
    creatorLockSeconds: 30 * 86400,                         // the first buy is locked for 30 days
  },
});
```

Everything left out is zero, which means off. Rates are basis points per side, windows are
slots, `maxBuyQuote` is in lamports.

**Bounds.** `RULES_CEILINGS` is what the program refuses above and `RULES_POLICY` what a
launch form should offer; both have the same keys (`creatorBps`, `holdersBps`, `burnBps`,
`sideBps`, `sniperStartFeeBps`, `sniperSlots`, `limitSlots`, `creatorLockSeconds`).
`rulesProblems(rulesArgs(input), bounds)` lists what is wrong with a set of numbers, each
with the name of the error the program would answer. `launchInstructions` checks the
ceilings before it reads or builds anything, and throws. It also refuses a first buy above
the coin's own buy limit (the launch would fail) and a creator lock without a first buy
(there would be nothing to lock). `describeRules(rulesArgs(input))` words a set of rules
in sentences; `rulesFirstBuyQuote(args, launch, platform)` is the launcher's first buy to
the unit, before the pool exists.

**The creator lock.** With `creatorLockSeconds` above zero the launch transaction ends with
`lock_creator` for everything the dev's coin account holds after the first buy, so the
coins are never loose. The lock ends at the chain's time when the launch was built, plus
`lockMarginSeconds` (default 600) for the launch to land, plus `creatorLockSeconds`. The
result carries `lock: { unlockAt, landBefore }`: sent after `landBefore`, the program
refuses the lock and the whole launch with it, so build the launch again (same mint
keypair) when the second transaction is sent late. Because of the margin, a lock at the
ceiling of 365 days cannot be made inside a launch.

**Size.** `createTx` is about 945 bytes and `launchTx` about 1,150 as legacy transactions.
With the creator lock `launchTx` is about 1,250 bytes, over the limit of 1,232: send it
through `client.buildTx` with the platform's lookup table (about 980 bytes). Both
transactions ask for 400,000 compute units.

**A rules coin as of now.** The numbers in the config account are one trade behind: the
fee of a trade is split when the program next runs for the pool. The readers do that
split on a copy, the way the program will, so a page shows what is true this moment.

| Call | Gives |
|---|---|
| `rulesState(pool)` | The config as stored (`config`), the same after the settlement (`settled`), `creatorClaimable`, `burnPot`, `unsettledFee`, `stakersEligible`, `liquidityOpenSlot`, the chain's `slot` and `unixTime`, and the `pool` read in the same call. |
| `rulesStakeOf(pool, wallet)` | The wallet's stake: `staked`, `claimable` (what a claim pays now), `unstakeOpenSlot`, `canUnstake`, `shareBps`. |
| `rulesLock(pool)` | The creator lock: `record`, `vaultBalance`, `unlockAt`, `locked`, and what the launcher declared (`declaredSeconds`, `declaredUntil`). Show the record and the vault, not the declaration: the program cannot make a launcher lock anything. |

**Staking and claiming.** Holders who stake the coin share the holders' rate, paid in SOL.
While less than 0.1% of the supply is staked (`config.minEligible`), that share goes to
the burn pot instead.

| Call | Does |
|---|---|
| `rulesStakeInstructions(user, pool, amount)` | Stakes coins. The first stake opens the wallet's stake record. Every stake restarts the unstake delay of everything the wallet staked. |
| `rulesUnstakeInstructions(user, pool, amount)` | Takes staked coins back. The program refuses until `UNSTAKE_DELAY_SLOTS` (9,000 slots, about an hour) after the wallet's last stake. |
| `rulesClaimRewardsInstructions(user, pool)` | `{ amount, instructions }`: the staker's rewards. Empty when there is nothing to claim. |
| `rulesClaimCreatorInstructions(creator, pool)` | `{ amount, instructions }`: the creator fee collected so far. Only the wallet that launched the coin. |
| `rulesBurnInstructions(payer, pool)` | One call of the burn: see "Buyback and burn". |
| `rulesLockInstructions(creator, pool, amount, unlockAt)` | Locks coins of the creator or moves the end of the lock later. `amount` may be `LOCK_WHOLE_BALANCE`, or zero once something is locked. |
| `rulesUnlockInstructions(creator, pool)` | Takes the locked coins back once the unlock time has come. |

The two claims follow the wrapped SOL rule of the swaps: a wallet that had no wrapped SOL
account is paid plain SOL, a wallet that had one keeps it open with the payment inside.

`ix.rulesInitPoolConfig`, `ix.rulesStake`, `ix.rulesUnstake`, `ix.rulesClaimRewards`,
`ix.rulesClaimCreator`, `ix.rulesRunBurn`, `ix.rulesLockCreator`, `ix.rulesUnlockCreator`
are the single instructions; `rulesPda` derives the template's addresses (config,
authority, treasury, burn account, stake vault, stake record, lock record, lock vault);
`decodeRulesConfig`, `decodeStakeRecord`, `decodeLockRecord` decode its accounts;
`rulesSniperFee`, `rulesSplit`, `rulesSettle`, `rulesPendingRewards`, `rulesBurnCapBps` are
the program's arithmetic as pure functions.

### The strict coin

`rules.strict` launches a strict coin: a Token-2022 coin whose transfer hook is
`hook_rules`, so the program runs inside every transfer of the coin, in its pool and
between wallets. It adds a real max wallet, an early lock, and holder rewards without
staking. `RULES.md` ("The strict coin") is the reference; `scripts/e2e-strict.mjs` uses
every call below on a live chain.

```js
const client = new HookpoolClient(connection, { lookupTable });   // required for a strict launch
const plan = await client.launchInstructions({
  ...sameAsAbove, template: "rules",
  rules: {
    buy: { creatorBps: 100, holdersBps: 200 }, sell: { creatorBps: 100, holdersBps: 200 },
    strict: {
      maxWalletBps: 300, maxWalletSlots: 216_000,       // no wallet above 3% of the supply for about 24 hours
      earlySlots: 1_500, earlyUnlockSlots: 216_000,     // coins bought in the first 10 minutes stay put for 24 hours
    },
  },
});
// send plan.createTx (signers: dev, plan.signers) and plan.launchTx through client.buildTx
```

`strict: {}` is a strict coin with neither window. Transaction 1 creates the coin through
the launchpad's pegged path (`create_pegged_mint`, the two metadata instructions,
`finish_pegged_token`), binds it with `init_strict_config` and, when there is a first buy,
opens the launcher's holder record. Transaction 2 is the launch, the first buy and, with
`creatorLockSeconds`, `lock_creator_strict`. Transaction 2 of a strict coin is above the
legacy limit even without a lock (about 1,280 bytes, 1,350 with the lock), so the client
needs the platform's lookup table: without one `launchInstructions` throws. The plan
carries `sizes` (both transactions as legacy transactions, null when they do not compile),
`needsLookupTable`, and `strict.maxWalletAmount`. It asks for 400,000 and 600,000 compute
units.

**Bounds.** `RULES_STRICT_CEILINGS` (what the program refuses) and `RULES_STRICT_POLICY`
(what a form should offer: 0.5% to 5% for at most 24 hours, an early window of at most 10
minutes, an unlock at most 24 hours after launch). `strictProblems(strictArgs(input),
bounds)` names each problem by the program's error. `launchInstructions` also refuses a
first buy above the coin's own max wallet.

**What the coin refuses, and what the SDK says first.** `RULES_ERRORS` holds every error
of `hook_rules` (6000 to 6051) with a plain sentence; `rulesErrorFromLogs(logs)` finds the
one in a failed transaction's logs. The SDK throws a `StrictRefusal` (`.number`, `.code`,
`.message`, `.info`) before anything is sent:

- `quoteLocal(pool, platform, direction, amountIn, hook, slot, wallet)`: with `wallet`, a
  buy above the max wallet (`MaxWallet`), a sell of early coins before the unlock
  (`EarlyLocked`) or of the creator's locked coins (`CreatorLocked`). Without `wallet` it
  quotes as before. The max wallet is checked with the quote's `amountOutCeiling`: inside
  the sniper window the chain pays more than the slot's quote, and the program holds the
  wallet's balance after the buy to the cap, so the check leaves room for the falling fee
  and the refusal says so. The largest buy it accepts is smaller than the slot's quote
  alone would allow; it lands.
- `strictSendInstructions(user, pool, to, amount, { check })`: the same rules for a send
  (also the receiver's max wallet). It builds Token-2022 `TransferChecked` with the hook's
  accounts and creates the receiver's account when missing. `check: false` skips the check.
- `swapInstructions`: a buy by a wallet without a holder record gets `open_holder` in
  front, the way a collectible coin's ticket is opened (`opts.openHolder: false` leaves it
  out, except in the early window, where the chain refuses a buy without a record). A buy
  for a `recipient` without a record in the early window throws.
- `rulesStakeInstructions` throws `StrictCoin`: a strict coin has no staking.

**Readers.**

| Call | Gives |
|---|---|
| `rulesState(pool)` | As for a plain coin, plus `strict`: `maxWalletAmount`, `maxWalletRuns`, `maxWalletUntil`, `earlyWindowRuns`, `earlyUntil`, `earlyLocked`, `earlyUnlock`, `registered` (coins counted by holder records), `minRegistered` (0.1% of the supply). `liquidityOpenSlot` counts the max wallet window. `strict` is null on a plain coin. |
| `rulesHolderOf(pool, wallet)` | The wallet on a strict coin: `record` (null without one), `balance` (its coin account), `counted` (what the record counts), `claimable` now, `earlyBought`, `earlyLocked`, `earlyUnlock`, `locked`, `creatorLocked`, `lockedUntil`, `free` (what it may move now), `shareBps`. Null on a plain coin. |
| `rulesLock(pool)` | On a strict coin `vault` is the creator's own coin account, where the locked coins stay. |
| `isStrictPool(pool)` | Whether the pool's coin is a strict coin (read once, then remembered). |

**Builders.**

| Call | Does |
|---|---|
| `rulesOpenHolderInstructions(user, pool)` | Opens the wallet's holder record (empty when it has one). Its balance counts from then on. Rent about 0.0013 SOL on mainnet (the chain's rent of `HOLDER_RECORD_SIZE` bytes; `HOLDER_RECORD_RENT` is the local validator's 0.0018), back on close. |
| `rulesClaimRewardsInstructions(user, pool)` | On a strict coin: `claim_holder` (also `rulesClaimHolderInstructions`). Same shape and wrapped SOL rule. |
| `rulesSyncHolderInstructions(pool, wallet)` | Lowers a record to what the wallet holds after a token Burn (a burn calls no hook). Anyone may send it. Empty when there is nothing to lower. |
| `rulesCloseHolderInstructions(user, pool)` | Closes an empty record (no coins counted, nothing owed or locked, no early coins under their lock); throws `HolderNotEmpty` otherwise. |
| `rulesLockInstructions` / `rulesUnlockInstructions` | On a strict coin: `lock_creator_strict` / `unlock_creator_strict`. The coins stay in the creator's wallet, which the hook keeps at or above the locked amount until the date. |
| `rulesBurnInstructions(payer, pool)` | On a strict coin: `run_burn_strict`, same steps and result. |
| `collectProtocolFeesInstructions(payer, pool)` | The platform's protocol fees, with the strict coin's accounts when needed. |
| `createPoolInstructions(..., hook, baseTokenProgram)` | A Token-2022 coin's pool made directly: pass `TOKEN_2022_PROGRAM` and a hook ref whose extra accounts are the config and `ix.strictPoolExtras(pool, mint, creator)`. |

`hookRef` adds the coin's own accounts (`ix.strictPoolExtras`: the wallet's holder record,
the pool's holder address, the account list) to every swap and every change of liquidity.
The single instructions are `ix.rulesInitStrictConfig`, `ix.rulesOpenHolder`,
`ix.rulesClaimHolder`, `ix.rulesSyncHolder`, `ix.rulesCloseHolder`,
`ix.rulesLockCreatorStrict`, `ix.rulesUnlockCreatorStrict`, `ix.rulesRunBurnStrict`,
`ix.strictTransfer`, `ix.strictBurn`, with `ix.strictTransferExtras` and
`ix.strictCollectExtras`. `rulesPda.holder(pool, wallet)` and `rulesPda.validation(mint)`
derive the record and the coin's account list; `decodeHolderRecord` decodes a record;
`strictWindows`, `strictTransferRefusal`, `strictMaxWalletAmount`, `strictHolderClaimable`
are the program's rules as pure functions. The events `HolderOpened`, `HolderClaimed`,
`HolderSynced` and `HolderClosed` are decoded with the others.

### Collectible coins

The `collectible` namespace holds the decoders, the instructions and the readers of the
collectible hook (`fetchTicket`, `fetchOwnedPieces`, `pegStatus`, `predictTransfer`,
`renderPieceSvg`, ...). The client has the complete flows:

| Call | Does |
|---|---|
| `collectibleMintInstructions(user, pool)` | The wallet's own mint: reveals and mints the pieces a buy earned, its deposit paying first. Send it at least two slots after the buy, built from a fresh read of the ticket (see "One approval"). |
| `collectibleBuyDeposit(user, pool, amountOut)` | What a buy that pays out `amountOut` coins earns, and the deposit for the NFTs: `{ pieces, need, deposit, topUp }`. |
| `collectibleMintForInstructions(payer, pool, user)` | For a keeper: `mint_for` of the wallet's decided pieces into the wallet, paid back from its deposit. Empty when nothing is decided or the deposit does not cover it. Simulate before sending. |
| `collectibleWithdrawInstructions(user, pool)` | The wallet takes its whole deposit back. Empty when there is none. |
| `collectiblePegAfterSell(user, pool, amountIn)` | Says which pieces a sell would burn, before the sell. |
| `collectibleReorderInstructions(user, pool, from, to)` | Moves a piece inside the wallet's list. The end of the list burns first. |
| `collectibleSendInstructions(user, pool, to, pieces)` | Plain coin: sends chosen pieces with exactly their coins. |
| `collectibleTransferInstructions(user, pool, to, amount)` | Pegged coin: a transfer of coins, with what it will do to the pieces (`outcome`). |
| `collectibleSettleInstructions(payer, pool, user)`, `collectibleUpkeepInstructions(payer, pool)` | Upkeep anyone may send: burn the pieces a wallet no longer backs, deliver and burn the Metaplex assets of a pegged coin. The watcher sends these. |

### One approval

The pieces a buy earns are decided by a block two slots after the buy, so the buy cannot
mint their NFTs. It can pay for them instead: a deposit, a plain SOL transfer from the
wallet to its own ticket, right after the swap, in the buy transaction. Anyone may then
send the permissionless `mint_for`, which mints the wallet's decided pieces into the
wallet and pays its sender back from the deposit, what it spent plus `KEEPER_FEE` (10,000
lamports). The operator's watcher does it a few seconds after the buy (`watcher/`,
`MINT_CRANK`). The wallet approves once.

```js
// a buy that earns pieces, with the deposit for their NFTs
const quote = await client.quoteLocal(pool, platform, DIRECTION.BUY, amountIn);
const ixs = await client.swapInstructions(user, pool, hookRef, DIRECTION.BUY, amountIn, minOut, { mintDeposit: { amountOut: quote.amountOut } });
```

* `mintDeposit` is off unless asked. `true` counts the pieces from the SDK's own quote,
  `{ amountOut }` from the coins your quote pays out, `{ pieces }` as given. Nothing is
  added when the buy earns nothing, when the deposit already covers it, or on a buy paid
  out to another wallet.
* The amount is `collectible.mintDepositTopUp`: `mintDepositFor` of every piece the wallet
  will have waiting, less what its ticket holds. `mintDepositFor(rent, cfg, pieces)` sizes
  each NFT at its largest, so the deposit holds whenever the keeper comes: the number at
  ten digits, and while the collection is not locked the 24-byte name and 80-byte address
  its owner may still set (`depositAssetSize`). Then Metaplex Core's fee (`CORE_CREATE_FEE`,
  0.0015 SOL), 32 bytes of ticket and one `KEEPER_FEE` a piece. About 0.0036 SOL a piece on
  mainnet on a collection that is not locked (3,638,520 lamports). What the mint does not
  use stays the wallet's.
* The `rent` is the chain's, never a constant: `client.rent()` reads it once (two calls)
  and keeps it for an hour; `collectible.rentFrom(conn)` reads it plain. Mainnet charges
  5,080 lamports a byte of account and a local validator 6,960, so the same piece is about
  0.0044 SOL in a rehearsal on the local chain. `collectible.STANDARD_RENT` is that local
  number, kept for tests. `swapInstructions` with `mintDeposit`, `collectibleBuyDeposit`,
  `collectibleMintForInstructions` and `collectibleWithdrawInstructions` all use
  `client.rent()`.
* `collectible.ticketDeposit(conn, pool, user, rent?)` reads a deposit the way
  `withdraw_deposit` pays it, at the chain's rent (read when not given): what the ticket
  holds above the rent of its list. The program shrinks a ticket to its list before it
  pays, so a ticket left longer than its list gives the rent of its spare bytes back too.
  `withdrawableDeposit(lamports, size, pieces in the list, rent)` does the same from an
  account already read; show and decide a withdraw on it. `depositOf(lamports, size, rent)`
  is what the ticket holds above the rent of its current size: what a mint can use, and
  what `mint_for` checks. The rent is required by both.
  `collectibleWithdrawInstructions(user, pool)` gives the deposit back.
* A buy never carries a `mint`, with or without the deposit. Once a ticket holds a deposit
  anyone's `mint_for` may land first, and a mint inside the buy would then name the wrong
  asset and fail the whole buy. Earlier pieces are minted by the keeper or by the wallet.
* The wallet's own mint (`collectibleMintInstructions`) stays as the fallback, for a
  keeper that does not come. It takes from the deposit first. Build it from a fresh read
  of the ticket and simulate it first: a mint built before the keeper's that lands after
  it fails (the next asset address moved), and one that finds nothing decided does nothing.
* A sell names, besides the pieces it burns, the asset addresses of the waiting pieces it
  drops (`collectible.nextAssets`). If a keeper mints them before the sell lands, the sell
  burns those NFTs and their rent comes back to the seller. Metaplex Core's fee does not.
* For a keeper: `collectible.fetchDepositTickets(conn, pool?, rent?)` lists the tickets with
  pieces waiting and a deposit, `mintForCount` says what a `mint_for` mints now and
  `mintForCost` exactly what it costs the deposit. `collectibleMintForInstructions(payer,
  pool, user)` puts it together. Simulate before sending: a wallet may sell, withdraw or
  mint itself in the meantime. Keep the priority fee under 5,000 lamports a call, or the
  network fee passes what the deposit pays back.

### A launcher's own art

A collectible coin can take its art from a folder the launcher uploaded: finished pictures
or layers, described by a `collection.json` (HOOKS.md section 13, "A launcher's own art",
has the format, the limits and the draw). `sdk/src/artpack.ts` is pure code with no
dependency; it is in every bundle and alone in `web/api/_artpack.js`.

| Name | Does |
|---|---|
| `checkCollection(json, files?)` | Checks a collection.json, and with `files` (`{ path, bytes, type?, width?, height? }`) the files it uses. Answers `{ ok, errors, warnings, collection, paths, bytes }`; the errors are plain sentences that say where. Never throws. |
| `encodeCollection(c)`, `parseCollection(bytes)` | The exact bytes to upload; reading them back (throws a sentence). |
| `collectionArt(bytes)`, `collectionArtHex(bytes)` | The coin's 16 art bytes: the first 16 bytes of the SHA-256 of collection.json as uploaded. |
| `pickPiece(c, seedHex)` | What a piece with that seed shows: `{ item, options, images, name, description, attributes, chance }`. The same everywhere. |
| `artRoll(seedHex, i)` | The draw's roll number `i`, for anyone who checks the draw by hand. |
| `traitOdds(c)`, `itemChances(c)`, `optionChances(c)` | The chance of every trait value, of every picture, of every layer option. |
| `artUriBase(origin, folderId)`, `parseArtUriBase(uriBase)` | The coin's `uri_base` for a folder (refuses one over 80 bytes with a sentence), and back. |
| `artFileUrl(gateway, folderId, path)`, `isFolderId(s)`, `safeArtPath(name)`, `isArtPath(p)`, `artTypeOf(p)`, `sniffImage(bytes)` | Addresses, paths and image types. |
| `artPieceMetadata(c, pick, image, type)`, `artCollectionMetadata(c, cover, type, externalUrl)` | The Metaplex JSON the resolver answers. |
| `ART_LIMITS`, `ART_TYPES`, `ART_FILE`, `ART_URI_BASE_MAX` | The limits and constants. |

The upload itself is `web/js/art-store.js` (built from `src/artstore.ts`): `openStore({
wallet, settings, session })` with `price`, `balance`, `fund` and `uploadFolder`. It loads
the store of the real service on demand (`web/js/art-store-turbo.js` or
`art-store-irys.js`, built in `art-vendor/`).

### Events

`eventsFromTransaction(tx, programIds)` decodes every event of a transaction returned by
`getTransaction`. The second argument is the list of program ids to accept, as base58
strings: `Object.values(PROGRAMS).map((p) => p.toBase58())`. A log line counts only when
one of those programs logged it: the decoder follows the runtime's `Program <id> invoke [n]`
and `Program <id> success` lines and gives every `Program data:` line to the innermost
program running at that point, so another program in the same transaction cannot plant an
event. `eventsFromLogs(logs, programIds?)` does the same for log lines alone (the default
set is `EVENT_LOG_PROGRAMS`, every program of the SDK; logs with no invoke line at all are
taken as they are), and `attributedDataLogs(logs)` lists the lines with their program.
Trades, pool creation,
liquidity changes, launches, buybacks and the burn of a rules coin (`BurnExecuted`) are
emitted as inner instructions, which a node never cuts; the others are log lines. The log
events of a rules coin are `Staked`, `Unstaked`, `RewardsClaimed`, `CreatorClaimed`,
`CreatorLocked` and `CreatorUnlocked`. Every instruction of a rules coin names its config,
so `client.allEvents(rulesPda.cfg(pool))` is the coin's whole history apart from its
trades, which are the pool's.

### Lower level

`ix.*` are the single instructions (`ix.swap`, `ix.createPool`, `ix.createCurvePool`,
`ix.graduate`, `ix.launch`, `ix.launchCurve`, `ix.collectHookFees`, `ix.taxSetTax`, ...;
`ix.updatePlatform` writes the ten borsh options of `UpdatePlatformArgs`, the three curve
settings last). `pda.*` derives every address. `quoteSwap`, `guardFee`, `burnCapBps`,
`burnStep`, `buybackSpend`, `initialLp`, `curveInitialLp`, `graduation` are the pure
functions.
`decodePool`, `decodePlatform`, `decodeLaunch` and the others decode raw account data.
`resolveExtraAccounts` resolves a hook's account list. `IX`, `ACCOUNT_DISC`, `EVENT_DISC`
are the discriminators, generated from the programs by `node gen-discriminators.mjs`.

**The hook caller.** The pool signs a hook's callbacks with an address that belongs to
that hook: `pda.caller(hookProgram)`, the PDA `["caller", hookProgram]` of the pool
program. Every swap, launch, pool creation and liquidity change names it, and the hook's
account list is resolved with it. Pass the pool's hook program, which is the system
program for a pool without a hook (`pool.hookProgram` is right in both cases). The
argument has no default: an address derived for another hook fails on chain with
`ConstraintSeeds` (2006). The builders (`ix.swap`, `ix.launch`, `client.hookRef`, ...) take
it from the hook they are given.

**For a hook of your own.** `anchorDiscriminator("global", "set_fee")` gives the eight
bytes Anchor puts in front of an instruction's data (`"account"` and `"event"` for the
other two kinds), and `sha256(bytes)` is the hash underneath. Both work in a page and in
Node without waiting.

## What the SDK does not do

`web/SDK-GAPS.md` lists every place where the reference site needed something the SDK does
not give, and what the page does instead. Read it before you build a site on the SDK.


* It does not sign or hold keys. It returns instructions; the caller signs.
* It does not retry or set priority fees. Add a `ComputeBudgetProgram.setComputeUnitPrice`
  instruction yourself when the network needs one.
* A wallet transfer of a pegged coin made with another tool works without the SDK, but the
  Metaplex assets of the pieces follow only when somebody sends the upkeep instructions.
  Run the watcher.
