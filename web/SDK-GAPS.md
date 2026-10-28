# What the site does on top of the SDK

The pages in `web/` are built on the SDK in `sdk/` (bundled for the browser as
`web/js/hookpool.js`). This file lists the places where a page needed something the SDK
does not give, and what the page does instead. None of them stops a page from working.
If you build your own site on the SDK you will meet the same gaps, and if you change the
SDK these are the places in `web/` that have to follow.

Each item names the file and the function that holds the workaround.

## Hooks in general

1. **Loader v4 programs.** `decodeUpgradeAuthority` reads the upgradeable loader only.
   `common.js checkHook` (the checker on the Hooks page, the Custom hook card of the launch
   form, the Hooks tab of Explore) reads the loader v4 layout itself: the authority at bytes
   8 to 40, the status as a u64 at 40 to 48, where 2 means finalized. It treats programs
   under BPFLoader1 and BPFLoader2 as frozen. This mirrors `programs/hookpool/src/loader.rs`.

2. **Limits of the templates.** `hookInfo` does not know the limits each template enforces.
   The launch form takes the fee limits from the platform account and carries the launch
   guard's longest window, 10,800 slots, as a number of its own. The launch rules are the
   exception: the SDK exports `RULES_POLICY` and `RULES_CEILINGS`, and the form takes every
   bound of a rule from the policy. The ceiling of a buyback's minimum is
   `MAX_BUYBACK_MIN_QUOTE`.

3. **Hook flags in words.** `describeFlags` gives one sentence per power and stops there.
   `common.js flagSentences` adds three things. It writes the two platform caps as numbers
   ("up to the platform cap of 10%"). For a hook that is not a platform template it adds
   that the hook can refuse a trade it is called on, because a callback that fails stops the
   whole transaction. For a pegged coin it replaces "never called on a sell", which is true
   for the pool's callbacks only: the same program is the coin's transfer hook and runs
   inside every transfer, a sell included. `rulesTags` drops the "sells: never called" tag
   for a pegged coin and adds "pegged".

4. **Which hooks are in use.** No SDK call lists the hook programs of a chain. The Hooks tab
   of Explore groups `allPools()` by `hookProgram`, adds the five templates, and runs
   `checkHook` on each.

5. **Refreshing a hook's own config.** `hookInfo` makes three reads. A tax can be changed
   by its owner and a buyback moves its counters, so the coin page reads the config again
   after every trade and on a timer. It reads only the config account and decodes it by
   template (`coin.js refreshHookConfig`). A rules coin is read through the SDK's own four
   calls instead (item 51).

## Quotes

6. **A simulated trade with its fees.** `quoteLocal` is exact for a pool without a hook and
   for the five templates. For any other hook it assumes the hook takes nothing.
   `quoteOnChain` simulates the trade and answers the amount, and only the amount. On a
   pool whose hook can change the amounts (it is called before the swap on that side and
   holds a fee, a fee override or the curve) the coin page shows the simulated trade as the
   quote, with the fee the hook took. So `coin.js simulateSwap` builds the same transaction
   `quoteOnChain` builds, simulates it with `innerInstructions: true`, and reads the
   `Swapped` event the pool emits. A node that does not return inner instructions gets
   `quoteOnChain` and a fee row that says the fee is inside the amount.

7. **Inner instructions of a simulation.** They come in the parsed form, with the program
   address and base58 data. `eventsFromInnerInstructions` takes the compiled form, with a
   program index. `simulateSwap` keeps the pool's own inner instructions and hands them
   over with an account list of one entry.

8. **A funded wallet is needed to simulate.** A simulation fails for a wallet that cannot
   pay for the trade. The coin page simulates only when a wallet is connected. Without one,
   on a pool whose hook sets the amounts, it shows the formula as "Without the hook" and
   asks for a wallet.

9. **The settle of a sell is not in the quote.** `quoteOnChain` and `simulateSwap` stop at
   the swap, so a sell on a collectible coin is simulated without the `settle` the real
   transaction carries. A settle that fails would only show when the sell is sent.

10. **One slot for the pool, the platform and the hook.** `client.pool`, `client.platform`
    and `client.hookInfo` are separate reads, and `quoteLocal` without a slot asks for one
    more. A launch-guard quote can mix the reserves of one slot with the fee of another.
    The trade API reads all of them in one call and passes that slot on. The coin page
    does not. Inside a guard window, or the sniper window of a rules coin, its quote can be
    a few slots old, and a buy that lands later pays a lower fee and gives more than the
    quote. `SwapQuote` does not say that a window raised the fee. The page compares
    `feeBpsApplied` with the pool's own fee and then writes "or more" next to the amount
    (`coin.js feeWindow`).

## Wrapped SOL

11. **Where the SOL of a sell lands.** The SDK leaves a wallet's wrapped SOL account as it
    found it. A wallet that has none receives plain SOL. A wallet that has one, or whose
    wrapped SOL account is the pool's hook treasury, is paid there as wrapped SOL.
    `swapInstructions` decides this and tells nobody. The coin page works the rule out again
    (`coin.js sellPaysWrapped`) to say it before the click, and the pool page does the same
    for a withdrawal and for the change of a deposit. If the rule changes in the SDK, these
    two have to follow.

12. **Unwrapping.** `unwrapInstructions` closes the wrapped SOL account and opens it again
    in one transaction. It fails for a wallet that has no such account. The pages offer
    Unwrap, and Take it on a tax coin, only when the account holds something
    (`common.js wrappedSol`, `unwrapSol`).

13. **The owner of a treasury.** The tax card shows "In your treasury" to the wallet the
    pool names as `hookTreasuryOwner`, when the treasury is that wallet's wrapped SOL
    account. A treasury in another quote token has no button on the site.

## Liquidity and launch

14. **The locked part of a pool.** No SDK call answers "what part of this pool is locked".
    The pool page and the coin page read the pool's lock account and the LP mint and divide
    (`pool.js renderLocked`, `coin.js readLp`). `Launch.lpLocked` is what the launch put
    there. The lock account also holds the 1,000 raw units every pool locks at creation.

15. **What a launch costs.** The SDK gives no estimate. `launch-core.js` carries one number per
    launch type: the fall of a dev wallet's balance over a launch on a local validator, less
    the seed, the first buy and the platform fee. It adds the rent of a treasury account
    when the launch has to create one, the rent of the dev's ticket on a collectible coin
    with a first buy, and the bytes of the name, symbol and metadata URL of a pegged coin.
    A launch with rules costs 45,441,400 lamports with any set of rules, with or without a
    first buy, and 3,326,880 more with a creator lock (the lock record and the lock vault).
    A buyback launch costs 42,121,480 since its config grew by 24 bytes.
    `web/review/flow-rules.mjs` does for the rules what `flow-templates.mjs` does for the
    other types.
    `web/review/flow-templates.mjs` prints what a launch really spent next to what the form
    showed. Run both after any change to the programs and correct the numbers.

16. **The first buy on a custom hook.** Nothing can say what a custom hook will take from
    the dev's first buy, so the launch form sends a minimum of 1 unit and says so. The pool
    is created and bought in the same transaction, so nothing can trade in between.
    `launchInstructions` refuses a hook that sets the price itself or that can still be
    upgraded. The launch form says the first of the two before the wallet opens.

17. **The size of the first transaction.** `launchInstructions` does not check it. A pegged
    coin carries its name, symbol and metadata URL in the coin. With a 200 character URL,
    an 80 byte renderer base, names at their limits and a first buy, its first transaction
    is over the 1,232 bytes a transaction may hold. The launch form builds it first and says how
    many bytes are too many.

18. **A deposit of a pegged coin burns pieces.** A deposit is a transfer of the coin to the
    pool, so the pieces the wallet's coins no longer back burn inside it.
    `addLiquidityInstructions` does not say so and adds no `reap`. The pool page works it
    out with `pegStatus` and names the pieces before the signature.

## History and metadata

19. **Trades.** `recentSwaps` sees what the RPC node still holds. A local validator keeps
    a few minutes of history, so an older pool shows no trades and no candles. The pool's
    totals come from the pool account and are always right.

20. **Coin images.** The SDK decodes the metadata account and stops at the URL.
    `common.js coinImage` and `coinMeta` fetch the JSON with a 3.5 second limit and fall
    back to a drawn monogram.

## Collectible coins: buy, reveal, mint

21. **Pieces a buy earns.** No helper. The coin page works out
    `min(maxPerBuy, floor(amountOut / unit), maxSupply - live - reservedPending,
    200 - owned - pending)` from the config, the ticket and the quote, as the hook does.

22. **A full ticket.** A ticket holds four batches, and a buy earns nothing when all four
    hold pieces that are not minted. The page tests it and says "Mint your waiting pieces
    first".

23. **Minting right after a buy.** `collectibleMintInstructions` reads the ticket as it is
    now, so it cannot build the mint of a buy that has not landed. To sign the buy and the
    mint in one prompt the page builds the mint itself (`coin.js buyOnCollectible`), with
    the first index the ticket will have after the buy. When that guess is wrong, or the
    blockhash is too old, it falls back to `collectibleMintInstructions` and a second
    signature.

24. **The deciding block.** Nothing tells a client that it is in. The page asks for the
    slot and the ticket every 400 ms, for 24 seconds at most, and then sends the mint.

25. **Four per mint.** `mintPieces` mints at most four pieces a call. A ticket with more
    waiting needs more than one press of "Mint N waiting".

26. **The dev's own pieces.** `launchInstructions` does not mint the pieces of a first buy.
    The launch page sends the dev to the coin page, which shows them as waiting.

27. **The whole collection.** `fetchCollectionPieces` is a `getProgramAccounts` on Metaplex
    Core. A public RPC node may refuse it or be slow, so the grid loads when it scrolls into
    view, shows the latest 24, and prints the node's error in place.

28. **The renderer.** `web/api/_art.js` cannot import the SDK on a host whose site root is
    `web/`, so it carries its own copy of `pieceTraits`, `renderPieceSvg` and
    `pieceMetadata`. `web/review/art-check.mjs` compares 500 random pieces with the SDK and
    must print 0 mismatches after any change to the art. The collection route reads the
    config account by byte offsets that are written down in that file. A change to the
    layout of `CollectionConfig` has to be made there too.

## Collectible coins: the peg

29. **What a wallet holds.** The page needs the ticket, the pieces and the coins that back
    them. They are three calls (`fetchTicket`, `fetchOwnedPieces`, `fetchBacking`). The page
    treats the ticket's list as the truth and uses the piece accounts for names and art.

30. **Names.** `pegStatus` and `predictTransfer` answer addresses. The page maps them to
    the names it already holds, to write "This sell burns 1 piece: Shots #5."

31. **Six burns per transaction.** A sell settles at most six. When a sell costs more, the
    form says how many burn with the sell and that anyone can burn the others right after.
    Until then the wallet is above the peg and the program refuses its reorder and send.

32. **Positions, not pieces.** `reorder` takes positions. A burn or a send between the
    draw and the click shifts the list, so the page reads the ticket again right before
    signing and looks the piece up by its address.

33. **Changes made elsewhere.** Anyone can settle a wallet or send it a piece. The coin
    page reads the wallet again every 20 seconds and redraws only when something changed.

34. **Which balance backs pieces.** `fetchBacking` is the one. `fetchCoinBalances` is still
    exported and is not. `tokenBalance` and `pda.ata` default to the classic token program,
    so every call on a pegged coin passes `pool.baseTokenProgram`.

## Pegged coins

35. **What a transfer does while the user types.** `collectibleTransferInstructions`
    answers the outcome only together with built instructions. The Send coins form reads
    the receiver itself (`coin.js readReceiver`) and calls `predictTransfer` on every
    keystroke. The rule it follows: the receiver takes one piece for each whole unit the
    transfer sends, while it has a ticket, its coins back the piece and it holds fewer than
    200. After the transfer the page reads both lists and reports what the chain did.

36. **An address that is not a wallet.** A transfer to the pool, to a token account or to a
    program is built without a word, and the pieces would burn. `readReceiver` refuses
    those three.

37. **The NFTs follow.** A transfer delivers or burns the NFTs of its first six pieces.
    The rest waits for `collectibleUpkeepInstructions`. The coin page shows one line for it
    with a button that sends up to four of those transactions.

38. **The collection grid.** Metaplex lags the lists on a pegged coin. The grid drops what
    is in the burn queue and takes each holder from the tickets.

## The trade API

`web/api/_trade.js` answers `GET /api/v1/quote` and `POST /api/v1/swap`. It uses a second
bundle of the SDK, `web/api/_sdk.js`, built by `sdk/esbuild.mjs`. After a change in
`sdk/src` both bundles are rebuilt, and a server that is already running keeps the old one
until it is restarted.

39. **Pieces left from earlier buys.** `swapInstructions` puts their mint into a new buy.
    The API promises a transaction that holds the trade and nothing else, so it takes that
    instruction out and says in its notes that pieces are waiting. It also checks every
    instruction the SDK returns against a list and refuses to answer when it finds one it
    does not know.

40. **One read for everything.** The API reads the pool, the platform, the hook's config
    and the wallet's accounts in one call and gives the SDK a view of the connection that
    answers from that batch. It depends on which accounts the SDK asks for. If
    `swapInstructions` starts to read another account, the API still works and costs one
    call more.

41. **The output of a whole swap transaction.** The return data of a simulated swap is gone
    once a later instruction runs, and a swap transaction can end with the unwrap. The API
    simulates the transaction it hands out and reads the `Swapped` event, as item 6 does.

## Custom hooks (the workshop files)

The Custom hooks pages list hooks other people built (`workshop.html`), gives each a page
(`workshop-hook.html`) and guides a builder (`workshop-guide.html`). The shared code is
`web/workshop-lib.js`. `web/review/flow-workshop.mjs` checks all of it against a local chain.

42. **Which hooks other people built.** No SDK call lists them. `workshopHooks` takes
    `allPools()`, keeps the pools whose `hookKind` is frozen and whose program is not a
    platform template, groups them by program and adds up `hookFeesQuoteTotal`,
    `volumeQuoteTotal` and `swapCount`. The SOL totals count pools against wrapped SOL
    only. A hook with no pool is in no list. Its page still opens by its program id.

43. **Who built a hook.** A frozen program has no authority left, and nothing on chain
    names who deployed it. The pages show two things and say which is which: the author
    as the hook's descriptor names it, and the wallet that created the hook's first pool
    (`pool.creator` of the oldest pool).

44. **The descriptor.** `decodeHookManifest` gives the manifest's `uri` and stops. A hook
    describes itself in a JSON file behind that link (the format is in
    `hook-template/README.md`). `loadDescriptor` loads it only from an https address that
    ends in `.json`, with a 5 second limit and 16,384 bytes at most, and `checkDescriptor`
    validates it and refuses a file that names another program. The pages never put a
    descriptor's text into HTML. A host that does not allow other sites to read the file
    counts as a descriptor that could not be loaded. The format, the validator and the
    pin live in `web/workshop-descriptor.js`, a file without imports that the upload
    server runs too.

    The manifest names an address, not a content. So a link may end with `#s=` and a pin
    of 22 characters: the first 16 bytes of the SHA-256 of the file, in base64url without
    padding. The loader hashes the bytes it fetched with its own SHA-256 and refuses a
    file whose pin is another one. The pin takes 25 of the uri's 128 bytes, which leaves
    103 for the address. That is the only way to write a pin: any other ending after `#`
    is read as no pin. The pages say under an author's rules whether the text is pinned or
    can still change, and what a pin is worth. It proves that the file is the one the
    author pinned. It is not a signature, and it says nothing about the code. With 128
    bits, an author who prepared two files with the same pin before deploying (about 2^64
    tries) could swap between those two.

45. **A hook's own instruction.** `launchInstructions` takes `custom.setup` as finished
    instructions and cannot build them. `buildSetup` builds one from a descriptor:
    Anchor's discriminator, the arguments in borsh, the accounts by role. The page carries
    its own SHA-256, because the browser's exists on https and localhost only. The SDK
    exports `sha256` and `anchorDiscriminator` now. The page keeps its own, in a file
    without imports, because the upload server runs that same file.

46. **What a hook's setup takes from the launcher.** The SDK does not simulate a launch.
    The setup is code of the hook that runs with the launcher's signature, so
    `guardSetup` simulates the first transaction twice, with the setup and without it,
    asks the simulator for every account the transaction may write, and compares. It
    depends on `launchInstructions` putting the very instruction objects of `custom.setup`
    into `createTx`: it finds them there by identity and refuses to judge when it cannot.
    The form then appends one instruction of its own to `createTx`, a transfer from the
    wallet to itself of the balance the simulation left. It fails on chain when the wallet
    holds less or is no longer owned by the system program. If the SDK ever adds an
    instruction after the setup that takes SOL from the launcher only sometimes, that
    floor would have to move.

47. **A setup that exists already.** `launchInstructions` adds the setup it is given, and
    the hook's `init` fails on an account that exists. The form asks the chain for the
    hook's writable accounts first and leaves the setup out when all of them exist, for
    a launcher who created the settings by hand.

48. **A buy and a sell for a wallet that holds no coins.** `quoteOnChain` simulates one
    trade for a wallet that could make it, and a sell needs coins. The hook page builds
    one transaction with a buy and a sell of what the buy gave, with one compute budget
    instruction, and simulates that (`workshop-hook.js tradeCheck`). It needs a connected
    wallet with 0.05 SOL. Without one it shows the watcher's verdict for that pool, when
    `watcherUrl` is set.

49. **Two files the operator keeps.** They are not chain data. `workshop/reviewed.json`
    lists the hooks the operator has read. `workshop/site.json` says whether the upload
    endpoint stores descriptors. `prepareMetadata` in `web/serve.js` takes a body with
    `programmable_hook`, checks it with the pages' validator, stores it as it was sent under
    the first 20 hex characters of its SHA-256, and answers `{ url, pin }`. The address
    has 55 bytes on a local server. The Vercel handler stores it the same way. A Vercel
    Blob address of that shape has about 85 bytes, inside the 103 a pin leaves. That
    handler has not been run.

## Launch rules

Module Mode and the review beside it are in `launch-modules.js`, on the shared parts of
`launch-core.js`. The coin
page's part is in `coin.js`, from `readRules` to `unlockAct`. `web/review/flow-rules.mjs`
checks all of it against a local chain.

50. **Problems in the form's own words.** `rulesProblems` answers a code and a message in
    the program's terms: windows in slots, the lock in seconds. The form is in minutes and
    days, so `launch-modules.js rulesForm` keeps the code and writes the sentence itself. A problem
    of one side has no field that says which side: the form reads it from the message
    ("on buys"). Four things the bounds do not cover are checked by the form alone: a first
    buy above the coin's own buy limit and a lock without a first buy (`launchInstructions`
    would throw for both), a sniper start fee that is not above the pool fee, and a rule
    that is switched on with nothing typed.

51. **Four reads for one coin.** `rulesState`, `rulesStakeOf`, `rulesLock` and
    `rulesBurnInstructions` each read the chain on their own, and the last one reads the
    state and the platform once more. The coin page calls all four after every trade and
    every 8 seconds (`coin.js readRules`). Their snapshots can be a slot apart.

52. **A clock between two reads.** Nothing tells a page that a slot passed. Between two
    reads the coin page works the slot and the chain's time out from the last read, at 400
    ms a slot, and moves the sniper fee and every countdown once a second (`coin.js tick`).
    When a window ends or something opens it reads the chain again. A slot is not exactly
    400 ms, so the page says "about".

53. **The date in a launch with a lock.** `launchInstructions` fixes the unlock time when it
    builds, and the program refuses the launch when the pool is created after
    `lock.landBefore`. `launch-core.js sendLaunch` asks `chainTime` before the wallet opens and
    again when the wallet returns the signature, with 90 seconds of room. When the date is
    too old it calls `launchInstructions` again with the same mint, takes the new second
    transaction and asks for the signature again, three times at most. The review shows
    the date from the browser's clock as "about". The exact date is read from the lock
    account after the launch (`rulesLock`).

54. **The size of a launch with a lock.** `launchInstructions` does not check it. Without
    the lookup table the second transaction is 1,251 bytes. The form builds it before the
    first signature and refuses when it does not fit, so no coin is created without its
    pool.

55. **The buy limit in words.** `quoteLocal` throws for a buy above the limit, with the
    amount in raw units and a slot. The trade form asks `rulesBuyLimit` first and says the
    amount in SOL and the time left (`coin.js overLimit`). It does so again before it
    builds a trade, so the wallet never opens for a buy the chain would refuse.

56. **A payer for a read.** `rulesBurnInstructions` and `buybackInstructions` need a payer
    even when the page only wants to know what a call would do. With no wallet connected
    the page passes the all-zero address and never sends what comes back.

57. **The step after "too soon".** A `BurnRun` whose step is "tooSoon" gives the slot a
    call opens in and an estimate of the next buy. It does not say whether that call will
    buy or record the pool again. The page asks `burnStep` for the opening slot itself to
    name the button that is off (`coin.js runWords`). The same function words the button
    and its sentence for a buyback and for a burn.

58. **What a run did.** The outcome of a run is in its event and in its return data, not in
    what the SDK foresaw. After a run, a claim or an unlock the page reads the transaction
    back and takes the amounts from its events (`coin.js eventsOf`). A node that does not
    hand the transaction over in three seconds gets the figures the SDK foresaw.

59. **The rent of a stake record.** The SDK exports no account sizes. The page asks the
    node for the rent of 113 bytes, the size `RULES.md` gives, to say what a first stake
    costs.

60. **Dust in the burn pot.** Rounding leaves a lamport or two of every trade in the pot,
    also on a coin with no burn rate. The page shows the Burn block when the coin has a
    burn rate or a rewards rate, or once a run has bought. A coin with a creator fee alone
    has no Burn block, and its dust stays in the pot.

61. **The tags of a rules coin.** `hookInfo` is three reads per pool. Explore reads the
    config, the lock record and the lock vault of every rules coin in one call per 33
    coins and decodes them with the SDK's decoders (`common.js rulesFacts`). A sniper fee
    and a buy limit are tagged while they run, a lock while coins sit in the lock account
    before their date.

62. **A window on new liquidity.** `addLiquidityInstructions` does not look at the window
    of a rules coin or of a launch guard, and the chain refuses by name. The pool page
    takes `liquidityOpenSlot`, reads the slot, keeps Add liquidity off and counts down
    (`pool.js renderWindow`). For a hook the platform did not write, `canBlockAdding`
    says that it could refuse and nothing says when.

63. **A hook that no pool runs on yet.** `checkHook` reads what `create_pool` reads before
    it calls a hook: the loader state, the manifest, the extra accounts list, the
    whitelist. A hook can still refuse its own `on_pool_create`, and nothing but a pool
    shows that it does not. The checker on the Hooks page counts the pools of the program
    in `allPools()` and says so under its verdict when there is none (`hooks.js check`).

64. **A strict coin.** Module Mode reaches the SDK's strict calls through one function,
    `strictSdk()` in `launch-strict.js`: the bounds are `RULES_STRICT_POLICY`, the checks
    `strictProblems`, the cap `strictMaxWalletAmount`, the rent of a record
    `HOLDER_RECORD_RENT`, and a coin is strict when `decodeRulesConfig(...).kind` is
    `RULES_KIND.STRICT`. The SDK gives no cost estimate for a strict launch: the function
    carries the figures measured on a local validator (30,207,480 lamports, plus 6,960 per byte
    of the name, the ticker and the metadata address, plus the launcher's holder record with a
    first buy and a lock record with a creator lock). The coin page reads `rulesHolderOf`,
    passes the wallet to `quoteLocal` and asks `strictTradeCheck` before a buy
    (`coin.js renderStrict`, `strictNotes`).

65. **The first buy against the max wallet.** The launcher's first buy lands in the
    launcher's wallet before the lock moves it. The form compares what
    `rulesFirstBuyQuote` returns with the max wallet amount and refuses a launch that
    must fail (`launch-strict.js read`). If the program exempts the launch's own first
    buy, that check must go.

66. **What a custom hook takes.** For a hook the platform did not write, the review can
    only say "up to" the platform caps: the flags say that the hook may take a fee or
    change the pool fee, not how much (`launch-hook.js review`). A descriptor does not
    carry rates in a form a page can read.

67. **The kind of a coin on Explore.** A card is labelled from the pool's hook program:
    Modules for the rules program, Collectible, Platform hook for tax, launch guard and
    buyback, Custom hook for any other program, and nothing for a pool without a hook
    (`index.js kindOf`). The SDK has no call that names a pool's kind.

## The curve launch

The choice "How the pool starts" and the launch on the curve are in `launch-core.js`. The
coin page's part is in `coin.js` (the section "the curve", `quoteError`, `drawQuote`,
`refreshSwaps`), the pool page's in `pool.js` (`renderCurve`, `renderShut`), Explore's in
`index.js curveRow`, the docs' in the script of `docs.html`. `web/review/flow-curve.mjs`
checks all of it against a local chain.

68. **The supply of a curve coin.** The program takes any supply, as long as the pool gets
    all of it. The SDK has no constant for it. The site fixes 1,000,000,000 coins with 6
    decimals (`launch-core.js CURVE_SUPPLY_WHOLE`), and the docs page imports that number.

69. **What a curve launch costs.** The SDK gives no cost estimate. Measured on a local
    validator, a curve launch creates the same accounts as a seeded launch of the same kind
    and costs the same rent to the lamport (none 35,551,240; tax 39,253,960 with its
    treasury; launch guard 37,075,480; buyback 42,121,480; rules 45,441,400; collectible
    41,070,520, 44,369,560 with a first buy; strict 30,555,480, 32,344,200 with a first buy).
    So the form keeps one table, `COST`, and the Total on the curve is the first buy, the
    launch fee and the rent, with no seed.

70. **The curve's numbers for a launch now.** `curveProgress` and `graduationBurn` take a
    pool. Before a launch there is no pool, so the form and the docs page build one from
    the platform account: the whole supply, no real SOL, the platform's virtual SOL, target
    and fee (`launch-core.js curveFacts`). The share sold at the target is the supply less
    `reserveBaseAfter + burned` of `graduationBurn`. An SDK call such as
    `curveFactsForLaunch(platform, supply)` would remove that.

71. **A first buy that graduates the coin.** `launchInstructions` says so in
    `plan.curve.graduatesAtLaunch`, after it built the launch. The review needs it before.
    The form repeats the SDK's rule: what is left of the first buy after the protocol fee
    and a hook fee at the platform's cap reaches the target (`launch-core.js
    graduatesAtLaunch`). If the SDK changes its rule, this function must follow.

72. **The curve's events on the coin page.** `curveEvents` reads up to 1,000 transactions.
    The coin page reads the pool's last 200 transactions once with `allEvents`, and takes
    the trades, `CurveOpened` and `Graduated` from the same read (`coin.js refreshSwaps`).
    Only a graduated pool whose events lie further back gets one `curveEvents` read of
    1,000. The `Graduated` event does not carry the virtual SOL. When `CurveOpened` is out
    of reach, the chart prices the trades before graduation with the platform's virtual
    SOL of today, which is wrong if the admin changed it since. A virtual SOL field in
    `Graduated` would close that. A local validator keeps only the most recent part of its
    history (about 1,700 slots on the running chain), so an older coin shows no trades and
    the Graduated mark without its slot.

73. **Curve refusals in words.** A `CurveRefusal` carries the program's own short text
    ("a sell cannot take more than the real reserve"). The site says each number in a
    sentence for the trader (`common.js curveSentence`), and a failed transaction's logs go
    through `curveErrorFromLogs` first (`common.js explainLogs`). A dust trade throws a
    plain Error "amount too small" with no code: the coin page matches the text
    (`coin.js quoteError`).

74. **The floor of a graduating trade.** `swapInstructions` sends the minimum it is given,
    and the card derives it from `quote.amountOut` with the trader's slippage, as on any
    other trade. "Min received" is what the wallet signs (`coin.js drawQuote`). The card
    reads `quote.graduateFirst` to say, once, whether the trade graduates the coin after it
    (a buy that crosses the target) or first (a pool that already stands past its target,
    quoted on the graduated pool). The page's own simulation finds the swap by its
    discriminator, because `graduate` can come before it (`coin.js simulateSwap`).

75. **The impact of a simulated trade.** On a pool whose hook answers each trade itself,
    the card works the price impact out from the simulated `Swapped` event, which carries
    the real reserves. On an open curve pool it adds the pool's virtual SOL to the SOL side
    (`coin.js drawQuote`).

76. **The pool page on the curve.** `addLiquidityInstructions` and
    `removeLiquidityInstructions` throw `CurveOpen`, but the page works its own LP numbers
    out from the reserves first, and a fresh curve pool holds no real SOL to divide by. So
    the page asks `isOnCurve` before any of that and switches both forms off
    (`pool.js addPlan`, `removePlan`, `renderShut`).

77. **A curve pool without a launch record.** A pool made with `create_curve_pool` has no
    `Launch` record, so `Launch.curve` cannot tell it. Every page reads the pool's own
    `curveState` instead.

78. **A graduating trade far below the target.** `quoteLocal` works `amountOutIfGraduated`
    out on the pool graduated at its CURRENT reserves (`graduationIfNow`). When the trade
    starts far below the target, that pool is one nobody can make: a graduation needs the
    target first. The fill it gives is then far too low, and `swapInstructions` lowers the
    signed floor to it. Measured on the local chain: a buy of 89.44 SOL into a coin with
    0.29 SOL raised quotes 734,665,658 coins and signs a floor of 9,512,146 (98.7% lower);
    a buy of 47.31 SOL at 40.4 SOL raised quotes 170,963,153 and signs 130,584,829 (23.6%
    lower). The trade API answered the same floors.
    CLOSED (2026-10-16, SDK floor fix and hookpool revision 3): nothing lowers a floor any
    more. A buy that crosses the target is quoted on the curve with `graduate` after it, and
    the trader's slippage on that quote protects it like any price move. A trade on a pool
    that already stands past its target gets `graduate` first and is quoted on the pool as
    graduation leaves it (`poolAfterGraduation`), which is exact whoever graduates first.
    `amountOutIfGraduated` is gone from the quote, and the site no longer uses
    `floorForGraduation` or `amountOutFloor`. `flow-curve.mjs` checks both cases: the floor is
    the quote less the slippage, and each buy fills exactly its quote.

79. **The trade API.** The coin page trades through the SDK in the browser, not through the
    trade API. `flow-curve.mjs` with `API_ORIGIN` set compares the API's quote of each
    graduating buy with the card: the same fill, and the same floor, the slippage on it.
