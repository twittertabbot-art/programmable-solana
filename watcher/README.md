# Programmable watcher

A small Node service that protects traders on Programmable. Every minute it checks every pool that has a hook:
it simulates a buy and a sell when anything the answer depends on changed, compares what comes out with what the
hook declares and with the platform caps, notices when a hook's parameters change or its program grows an upgrade
authority, writes `status/pools.json` for the website, serves it over HTTP and sends Telegram alerts.

It also publishes two feeds for the website, so that a visitor's browser does not read the chain for them: the
recent trades of every pool (`/trades/<pool>.json`) and every pool with what a coin card shows (`/market.json`).
Both are built from one read of the pool program's new transactions every 10 seconds (the trades feed, below).

It also has five real duties. Three are on the "Collectible per buy" template. It is the keeper that reveals
every ticket in time (the reveal crank, below). It is the keeper that settles every wallet holding more pieces
than its coins back (the settle crank, below). And for pegged coins it is the keeper that makes the Metaplex
assets follow the wallet lists: it delivers the pieces that moved and burns the pieces that burned (the upkeep
crank, below). The fourth is on the two templates that buy their coin back and burn it, "Buyback and burn" and
"Launch rules": it is the keeper that runs those buys regularly, so that the money waiting for them stays small
(the burn keeper, below). The fifth is on coins launched on the curve: it graduates every pool on the curve that
stands at or past its graduation target and was not graduated by a trade (the graduate crank, below).

Every trade it makes is a simulation. The only transactions it ever sends are permissionless ones, signed and
paid by the probe wallet, 5,000 lamports each: those reveals, settles, deliveries and burns of pieces, the
buybacks and burns of coins, the holder syncs of strict coins, and the graduations of pools on the curve. A settle and a burn of pieces pay the rent of what they burn back to that wallet.
A buyback or a burn of a coin spends the pool's own pot on the pool's own coin and pays the wallet nothing; a
graduation neither. The wallet holds fee money only and has no power over anybody's funds: anyone may send the
same nine instructions.

## Coins on the curve

A coin launched on the curve opens its pool with the whole supply and no SOL from its creator. The pool prices
trades as if it held some SOL that is not there, the virtual SOL (30 SOL with the platform's defaults): the price
is `(reserveQuote + virtualQuote) / reserveBase`. It pays a sell from the real SOL only, and it refuses liquidity
until it graduates. Once the real SOL in the pool reaches the graduation target (85 SOL by default), anyone may
send `graduate`: it drops the virtual SOL and burns coins from the pool so that the price stays where it is.
From then on it is an ordinary pool, at the same address. HOOKS.md section 2 has the details.

What the watcher does about it:

- It quotes such a pool the way the pool does. Every simulated output, plain or declared, is computed with the
  virtual SOL in, and so are the two numbers of the burn keeper on a buyback or rules coin on the curve. Read on
  the real SOL alone, a plain buy on a fresh curve pool would look taxed at more than 90%: a false alarm. With
  the virtual SOL in, a pool on the curve gets the verdict any other pool with the same hook gets.
- The entry of such a pool carries `curve` (see "Status schema"), and its `notes` say where it stands in words:
  `This coin is on the curve. Its pool prices trades with 30 SOL of virtual SOL that it does not hold, and pays
  out only its real SOL.` and `It holds 2.1 SOL of real SOL and graduates at 85 SOL. Liquidity opens at
  graduation.` After graduation: `This coin graduated from the curve. Its pool holds real SOL only now, and every
  share of its liquidity stays locked.`
- It graduates the pools that stand at or past their target (the graduate crank, below).

## Two kinds of coin on the collectible template

A coin launched with "Collectible per buy" is one of two kinds. The watcher reads the coin's mint every pass
and says which one it is, in the pool's `notes` and in its `coin` field. It assumes nothing.

- A PLAIN coin is an SPL Token coin (or a Token-2022 coin without a transfer hook). It runs no program of its
  own. The peg (a wallet holds at most one piece per `unit` coins) is kept by `settle`: the site sends it with
  every sell, the settle crank sends it for everything else. The hook is never called on a sell.
- A PEGGED coin is a Token-2022 coin whose transfer hook is the collectible program. That program runs inside
  EVERY transfer of the coin, sells included. The pieces the sender's coins no longer back leave the sender's
  list inside that transfer. They move to the receiver's list when the receiver has a ticket and got the coins
  in its associated token account, one piece per whole unit the transfer sends. The rest burn. A sell burns inside the swap. The wallet
  lists are the truth. The Metaplex Core assets follow by two permissionless instructions: `deliver` hands a
  moved piece's asset to the wallet whose list holds it, `reap` burns the asset of a piece that a transfer
  burned. The site adds both to its own transactions. The upkeep crank sends them for transfers made anywhere
  else. `settle` is still needed for one case: a holder that burns its coins directly, because a burn is not a
  transfer and the hook does not run. The settle crank covers it.

For a pegged coin the pool report states three facts, as facts and not as danger, each one checked on the mint:

1. The coin runs a platform program inside every transfer, sells included. It is the pool's own hook program.
2. Nobody can change which program: the coin's transfer hook authority is none.
3. A plain transfer carries the piece to the receiver, or burns it.

The pool program only accepts a transfer hook on a coin when the hook is the pool's own hook program, the
platform runs that program, and no authority is left on the hook. So a coin whose transfer hook breaks one of
those is a DANGER finding on any pool, with or without a hook: another program, an authority that is still set,
a program the platform does not run, or a collection config that disagrees with the mint. It should be
impossible. The alert says which one it is.

Scores of pools with a plain coin are not affected by any of this. One rule differs for a pegged coin: its
program runs inside the sell, so a simulated sell that fails inside the swap counts against the hook (danger),
as it does for a hook with CALL_ON_SELL. A pegged coin keeps its name and symbol in the coin itself (Token-2022
metadata), not in a Metaplex metadata account. The watcher reads both places.

## What it checks, every INTERVAL_SECONDS (default 60)

What one pass reads, with nothing to simulate: the platform account (one call), the hooks' manifests, program data,
configs and account lists (one batched call per hundred accounts; pools of one template share the template's
accounts), every coin's metadata account and mint (one call per fifty coins), the treasuries of buyback pools
(one call), and with collectible pools their tickets (two calls). The list of pools comes from the trades feed's
shared list (lib/pools.mjs), which costs this pass nothing. Each pool that is due for simulations adds about ten
calls; the probe wallet's balance is read only when one is due.

1. The platform account: paused flag, whitelist, caps, treasury, admin, and the three curve settings a new
   curve pool copies (`curveVirtualQuote`, `curveGraduationTarget`, `curveGraduationFeeBps`; a running curve
   keeps the ones it was created with). Any change is a warning alert and a line in `platform.changes`. A
   field that the state file of an older watcher does not hold is recorded on the first pass, without an alert.
2. Every pool with a hook:
   - flags, kind (frozen or platform), template parameters, upgrade authority of the hook program. A frozen
     hook whose program now has an upgrade authority, or a whitelisted hook whose authority changed, is danger.
   - the two simulations below run only when they are due (lib/schedule.mjs). A simulation's answer depends on
     the pool account, the hook's per-pool config and manifest, its account list, the hook program itself (the
     slot it was last deployed in), the platform's caps and pause, and on a few templates the slot. So a pool is
     simulated again when it was never simulated, when any of those accounts changed since (a trade, a tax
     change, an upgrade of the hook program, a new platform cap), while a window whose fee or limit moves with
     the slot runs (the launch guard, the sniper fee and buy limit of a rules coin, the max wallet, early window
     and early lock of a strict coin), after a buy probe the probe wallet could not pay for, and at least every
     SIM_MAX_AGE_MINUTES (default 60). Otherwise the pass keeps the last simulations, says so in a note
     (`Simulated at <time>. Nothing the simulations depend on changed since: ...`), and runs every other check
     below as before. The alerts on a change (sells start failing, buys start failing, sells work again) come
     from a new simulation, as before. A pool nobody trades costs no simulation for an hour.
   - a simulated BUY of PROBE_SOL as the probe wallet. On a rules coin whose buy limit is running the probe
     is the limit, when the limit is smaller: the pool refuses a larger buy, and that says nothing about the
     hook. A note on the pool says so.
   - a simulated SELL of 1% of the largest holder's balance, as that holder, without its signature (the RPC
     simulates with signature checks off; the swap is the last instruction so its return data is read). On a
     pool with a pegged coin both simulations carry the three accounts the coin's transfer hook needs, the
     same ones the site passes.
     The holders come from the RPC's list of the coin's largest token accounts (getTokenLargestAccounts). A
     shared node of a paid RPC may refuse that call for good: Chainstack's shared nodes answer 403, "only
     available on dedicated nodes". Then the watcher leaves the call alone for an hour (one warning in the log)
     and takes the holders from the wallets that traded the pool lately, as the trades feed's file of the pool
     holds them (`status/trades/<pool>.json`, read from disk, so a `--pool` check by hand finds the service's
     files too): their own token accounts of the coin, read in one call, the largest balance first. When no
     holder is found the sell probe is not set up and the entry says why in words, for example `setup: no holder
     found to sell as: this RPC does not list a coin's largest holders, and the trades feed has no trades of
     this pool yet`. That is a setup failure: it never counts against the hook, and the buy probe is simulated
     all the same. While the feed has no file for the pool yet, the pool is simulated again at the next pass.
   - the coin's mint: its token program and its transfer hook, if it has one (see "Two kinds of coin" above).
     A transfer hook the pool should have refused is danger.
   - the effective buy and sell tax: the hook fee a plain pool would need to produce the simulated output,
     in bps. Compared with the declared parameters (tax bps, guard fee at that slot, buyback bps, the rates
     and the sniper fee of a rules coin at that slot): more than 5 bps apart is a warning. Above what the
     platform caps allow is danger.
   - the hook's per-pool config account and manifest, byte for byte against the previous pass. Changes are
     decoded for the templates and recorded as `{time, slot, field, from, to}`: info when a launch guard is
     armed, warning for any tax change, danger if sells went from working to failing or a declared tax sits
     above its ceiling.
   - the "Buyback and burn" template (`hook_buyback`): its fee, its minimum, its treasury and its creator are
     fixed at launch, so a change of any of them is danger (impossible on chain). Its counters
     (`totalQuoteSpent`, `totalBaseBurned`, `buybacks`) and its observation of the pool (`obsSlot` and the two
     reserves, which every buyback writes and every trade below the observed price lowers) are running
     numbers. They are shown in `declared` and are not config changes: a buyback that ran raises no alert.
   - the "Launch rules" template (`hook_rules`): a platform template. Its rates and windows are fixed at
     launch, and the program has no instruction that changes them. The config account is 414 bytes, and
     bytes 8 to 239 of it never change once the pool exists: the rules, the creator, the treasury, the mints,
     and what the pool's creation wrote. ANY change in those bytes is a danger alert that names the field
     (`rules sellCreatorBps changed from 100 to 500 (should be impossible: the rules of a coin are fixed at
     launch)`). Bytes 240 to 373 move with every trade and are not config: what is owed to the creator, the
     burn pot, the reward counter, what is staked, the totals, the burn's observation of the pool. Rates
     above what the program allows are danger too (impossible on chain).
     A trade pays the three rates of its side (creator, holders, burn) together, whoever is staked, and a
     buy inside the sniper window pays the window's pool fee of the slot. That is the declared output the
     simulations are compared with. The hook runs on sells, so a sell that fails inside the swap is danger.
     The entry's `notes` say the rules in words, whether the sniper fee and the buy limit are running, how
     much is staked and where the holders' share goes right now, and what waits in the burn pot.
   - the strict coin of the launch rules template: a Token-2022 coin whose own transfer hook is `hook_rules`,
     so the coin's rules run inside every transfer of it (RULES.md, "The strict coin"). Its config says
     `kind` 1 at byte 374. The strict numbers are fixed bytes too: byte 374 and bytes 376 to 396 (the kind,
     the max wallet in basis points and in raw units, the early window, the max wallet window, the early
     unlock) never change once the pool exists, and a change of any of them is a danger alert that names the
     field. Byte 375 is the buy mark, which is 0 whenever anybody can read the account, and bytes 397 to 413
     are a reserve of zeros: either one found otherwise is a danger alert on every read. So are strict numbers
     outside what the program allows, and strict numbers in the config of a plain coin. On a strict coin
     `totalStaked` is what the holder records count. The two simulations carry the coin's extra accounts
     (the wallet's holder record, the pool's holder address, the coin's account list). The probe wallet has
     no holder record: inside the early window a buy needs one, and the SDK puts `open_holder` in front of
     the buy, so the simulated transaction opens it too (its rent is only simulated). While the max wallet
     runs, the buy probe is cut to the largest buy whose coins stay under the cap, and a note says so. The cut
     counts the most a buy can give: while the sniper fee falls, its output at the pool's own fee, because the
     simulation runs a slot or two after the read and the chain checks the wallet's balance after the
     transfer. A probe the coin's max wallet refuses all the same (`MaxWallet`, 6044, when the price moved
     between the read and the simulation) is a setup failure of the probe, never a failing buy: the note says
     `setup: the coin's max wallet refused the buy probe (MaxWallet, 6044): the probe was fitted to the cap at
     the slot the pool was read at and the pool moved before the simulation. Not the hook's doing.` The
     sell probe skips holders whose coins the early lock or the creator lock hold right now: their sell would
     be refused by the coin's rule, which says nothing about the hook. When every large holder is held, the
     sell probe is not set up and the note says why (`setup: the coins of every large holder are held by the
     coin's early lock or creator lock right now`); it does not count against the hook. The notes also say
     whether the max wallet, the early window and the early lock are running, and until which slot.
   - a score: `danger`, `warning` or `clean`. A hook WITHOUT the CALL_ON_SELL flag is never called on a sell,
     so it can never block or tax sells; the entry says so in `notes` and is never marked danger for sells.
   - the "Collectible per buy" template (`hook_collectible`): it takes no fee and is never called on sells, so
     the effective tax must be 0 both ways (anything else is a warning). Name, art, renderer (`uriBase`) and
     owner changes are recorded; a renderer that moves to another host is a warning for 24 hours, a locked
     collection is info, and a change of `unit`, `maxSupply`, `maxPerBuy`, `collection`, `baseMint`,
     `tokenProgram` or `pegged` (impossible on chain) is danger.
     The `minted`, `live` and `reservedPending` counters move with every buy, mint and burn and are not config
     changes. `minted` counts the pieces ever minted, `live` the pieces that exist now.
     The pieces are pegged to the coin: a wallet keeps at most one piece per `unit` coins it holds, and coins
     that leave by a sell or a transfer take their pieces with them, newest first. On a plain coin the hook
     itself never sees a sell; the pieces follow the coins through the separate `settle` instruction. The
     entry's `notes` say so in two sentences, and say whether this watcher runs the settle crank. On a pegged
     coin the notes state the three facts above, and say whether this watcher runs the upkeep crank and the
     settle crank.
     Each collectible pool's entry carries `coin`: the kind (`plain`, `pegged`, `mismatch` for a danger finding,
     `unknown` when the mint could not be read), the token program, and the transfer hook's program and
     authority.
     Each collectible pool's entry also carries `tickets`: how many tickets hold pieces (`open`), how many
     pieces are not revealable yet (`undecided`), matured but not revealed (`awaitingReveal`, 0 right after a
     crank) and sitting in batches that were not revealed in time (`expired`).
   - a buyback pool's and a rules pool's entry carries `burn`: what waits to be spent on the coin (`pot`),
     the cap of one buy in basis points of the pool's SOL (`capBps`), what a call sent now would do (`step`),
     when the pool was last recorded and from which slot the chain takes the next call, and what this
     watcher's burn keeper did on the pool (`keeper`). The `notes` say the same in two sentences, and whether
     this watcher runs the burn keeper.
3. Pools without a hook: a light entry, score clean, simulations refreshed once an hour. Their coin's mint is
   read every pass too: a pool without a hook must trade a coin that runs no program.
4. Pools on the curve, with or without a hook: the simulations and the declared outputs count the virtual SOL,
   and the entry carries `curve` with notes in words (see "Coins on the curve" above). The coin's supply comes
   from the mint read of the same pass.
5. The approved list (lib/approvals.mjs; `APPROVAL_WATCH`, on by default). An outside hook opens a pool only
   once Programmable reviewed it and put its program on the platform's approved list, while the platform's rule
   is on (HOOKS.md section 6.1). The platform account read in step 1 holds the rule (byte 405) and the list (after
   byte 451), so this check costs no call. The state keeps the rule and the list. A change from one pass to the
   next is an alert and a line in `platform.changes`: `the approved-list rule is now on` (info), `the approved-list
   rule is now off` (warning), `hook <program> was approved` (info), `hook <program> was taken off the approved
   list` (warning, with the pools that use it: they keep their hook, no new pool can open on it), and a list the
   program cannot read (danger: the pool program then refuses every outside hook that needs the list; no hook is
   reported as taken off while it is so). The first pass, and the first pass of a state written before this check,
   only record. Every pool entry carries `hookApproval`: `own` (no hook, a template, or a hook the platform
   whitelists), `approved` (an outside hook on the list) or `not approved` (an outside hook not on the list: a pool
   made before the rule or before its review, or a hook taken off the list; also any outside hook while the list
   cannot be read). An outside hook that nobody reviewed is `not approved` with the rule off too. The site warns on
   `not approved`. The status file carries the list itself as `approvedList`.
6. The hook accounts (lib/hookaccounts.mjs; `HOOK_ACCOUNTS_WATCH`, on by default). A hook writes its manifest and
   its extra-accounts list once, at setup (review rule 6): a rewritten list can stop every pool on the hook at once.
   For every distinct hook program a pool uses, the pass hashes both accounts (SHA-256 of their data) from the
   bytes it read for the hooks anyway (one batched call per hundred accounts, each account asked for once), and
   keeps the hashes in the state. A change is ONE alert that names the hook, the account and every pool on it:
   `hook <program> rewrote its extra-accounts list (account <address>) at slot <slot>: ...` (danger) or the same for
   the manifest (warning); `closed` and `created` say an account went away or appeared. The same alert is recorded
   on each of those pools (it counts in their score) without a Telegram message per pool. Each pool with a hook
   carries `hookAccountsChangedAtSlot`: the slot of the last pass that saw its hook's accounts change, null while
   none did. The first pass, and the first pass that sees a program, only record. The simulations of those pools
   run again in the same pass: the account list is part of what they depend on.
7. Sells as recent buyers (lib/holdersells.mjs; `HOLDER_SIMS`, `HOLDER_SIMS_PER_POOL`). The buy probe runs from the
   watcher's own wallet and the sell probe as one large holder. A hostile hook could know those wallets and let
   them through while it refuses everyone else. So for a pool whose hook runs on sells (`CALL_ON_SELL`, or a pegged
   coin), when its simulations are due and the sell probe went through, the pass also simulates a sell of 1% of the
   wallet's coins (at least 1 raw unit) as up to `HOLDER_SIMS_PER_POOL` (default 3) wallets that bought on the pool
   lately and still hold the coin. Who bought comes from the trades feed's file of the pool (`status/trades/<pool>.json`,
   read from disk: buys only, newest first, never the hook's own buys, the probe wallet or the sell probe's holder).
   Who still holds comes from one batched read of their token accounts (on a strict coin the clock and their holder
   records ride in it, and a wallet whose coins the early lock or the creator lock hold is left out). Each simulation
   is that wallet's own sell, the wallet as fee payer, with `sigVerify: false` and `replaceRecentBlockhash: true`. A
   sell that the HOOK refuses (the first program that failed is the hook program, or the pool refused what the hook
   answered: `BadHookReturn`, `HookPowerNotGranted`, `HookCurveInvalid`, `HookFeeTooHigh`) is a danger alert:
   `sells fail for some holders: <n> of <m> wallets that bought lately could not sell 1% of their coins in a
   simulation, while the sell probe went through. <the hook's error>`. Not the hook's doing, so no alert: a failure
   before the swap instruction, the token or system program refusing (the wallet's SOL or coins), Anchor's account
   errors (3000 to 3999: an account the wallet lacks), the pool's slippage, the rules of a strict coin. The entry
   carries `holderSellFails` (null, or the last check that found refusals) and a note with the counts of the last
   check. When the hook refuses nobody again, an info alert says sells work again. `HOLDER_SIMS` (default 30) is the
   most of these simulations one pass runs in all, `0` or `off` turns the check off; a pool the budget did not reach
   says so in its note and is checked at its next simulations.

## The trades feed and market.json, every FEED_INTERVAL_SECONDS (default 10)

A coin page shows the last trades of its pool, and the Explore page shows every coin with its price, its market
cap and its picture. Read from the chain by each visitor, that is a getSignaturesForAddress and up to 200
getTransaction calls per coin page and refresh, and a getProgramAccounts plus two reads per coin per Explore
visit: a cost that grows with the visitors and the coins. The watcher reads each of those things once and
publishes them. The exact fields are in "The two feeds" below.

One feed pass (lib/feed.mjs, lib/market.mjs):

1. One getSignaturesForAddress on the pool program, `until` the last signature the feed has seen, page after page
   (1,000 a page) when more arrived. (The slot of the pass is the newest slot any call of the watcher read in the
   last interval; a getSlot is asked for only when none did.) Every transaction that touches a pool, a trade, a launch, a
   deposit, a graduation, invokes the pool program, so this one list sees them all. Nothing new is older than that
   last signature, so a signature in an older slot ends the list. That matters on an RPC made of several nodes
   behind one address: a node that lags behind does not know the last signature yet and lists from its own newest
   one down, all of it read already. Such a pass reads nothing and the next one goes on. A signature the feed read
   lately is never read again, even when a node lists it twice. A node that no longer knows that last signature at
   all (it keeps a short history and the pool program was quiet for longer: the local validator keeps about 2,000
   slots, some 13 minutes) answers "not found": the feed then drops its cursor, lists the new signatures down to
   the cursor's slot instead, says so in one warning line, and owes the whole program a read (what came between is
   not known). Without this, every later pass would fail the same way.
2. The new transactions that did not fail, oldest first, read with getTransaction in batches of 25 (with a pause
   of 0.6 s between batches: about 40 requests a second, under the 50 a second of the paid plan the watcher runs
   on, which counts every item of a batch), at most FEED_MAX_TX_PER_PASS (200) a pass. A batch the RPC refuses as
   too many requests (HTTP 429) is sent again after 1 s, then 2, 4, 8 and 16 s, before the pass fails: a busy
   minute does not fail the pass at the same batch every ten seconds. What is left waits for the next pass, which
   then starts at once. A transaction the RPC lists but
   cannot serve yet stops the pass right before it; the next pass reads it. After 30 passes in a row it is
   skipped as unreadable (below), so that one transaction an RPC never serves cannot stop the feed for good.
   Every answer of a batch is paired with its signature by the transaction's own first signature
   (`transaction.signatures[0]`), never by its place in the answer. An RPC may answer a batch in any order (each
   answer carries its request id, and web3.js pairs by position): Chainstack does. An answer that is missing is a
   transaction not served yet.
   A version 1 transaction cannot be read here: the feed asks with `maxSupportedTransactionVersion: 0`, as the SDK
   decodes legacy and version 0 transactions, and the RPC answers error -32015 for it. web3.js then throws the whole
   batch away, so that batch is read again one transaction at a time (eight at once): the version 1 transaction is
   skipped, the others are read. A skipped transaction is counted (`feedUnreadable` in `/health`), named in
   `state/feed.json` (`unreadableLast`, the last 20, with the reason) and logged once as a warning (`feed:
   transaction <signature> (slot S) cannot be read and is skipped: ...`). The feed moves its cursor past it. Any
   trade in it is missing from the trades files. No program of the platform sends version 1 transactions; a trade
   in one would come from another client. An error of the RPC as a whole (not reachable, refused, rate limited)
   fails the pass, and the next pass tries again.
3. Their events, decoded by the SDK's own decoder. The Swapped, CurveOpened and Graduated events of each pool go
   into `status/trades/<pool>.json`, newest first, at most 300; the pool's CurveOpened and Graduated events are
   also kept apart in the file, so they stay there after they fall out of the 300. A failed transaction has no
   events and is never read. An event is kept once, by its transaction's signature, its kind and its index among
   the events of that kind in that transaction (one transaction may hold two Swapped events of a pool: a trade and
   the hook's own buy). The events merged in are deduplicated among themselves too, and a file that holds an
   exact double (written by an older watcher) loses it at its next merge, with a warning in the log.
4. The pools. A pool account changes only in a transaction of the pool program. So when step 1 found none, the
   pools are still what the last read said, and nothing is read: the shared list of pools (lib/pools.mjs) is only
   marked as still current (`checkedAt` in market.json). When it found some, the pools those transactions touched
   are read again BY ADDRESS, one getMultipleAccountsInfo per hundred, and patched into the list: the pools of
   every event in them, the pools their PoolCreated events name, and every known pool among their account keys (a
   pool that changes is writable in its transaction, so it is there even when no event names it). That read asks
   the node for the state of the newest transaction walked or later (`minContextSlot`): a node of the endpoint
   that lags behind it answers "minimum context slot not reached" instead of older reserves, and the pools stay
   owed for the next pass. A pool a PoolCreated event of the walk names that the answer does not hold yet is owed
   too (three reads), not dropped. The whole
   program is read in one getProgramAccounts only as a reconciliation: at the start, after a gap of the feed,
   when a transaction was walked past unread (its pools are not known), and every MARKET_REFRESH_SECONDS (1800).
   That is the one call a shared RPC node aborts under load, so it is rare now; when it fails, the next try waits
   30 s, then 60, up to 15 minutes, the patches go on meanwhile, and an hour of failures raises one warning alert
   (`poolsFullReadFailures`, `poolsFullReadFailedSince` in `/health`). A read that fails, by address or of the
   whole program, leaves the list OWED a read: market.json is then written with the last good reserves and a
   `checkedAt` that does not advance, the owed pools are read again by the next pass, and `/health` says
   `poolsReadOwed`. After a gap or a transaction walked past unread the whole program is owed: until it is read,
   the patches of the pools that traded go on but `checkedAt` stands still. Every loop of the watcher (the pool
   pass, the settle, upkeep, burn and graduate cranks) takes its pools from that list and never reads the program
   itself; with the feed on, the feed is the list's only reader, and a loop takes the list as it stands, whatever
   its age. Before the feed's first good read, a loop that asks while the pause after a failed read runs gets that
   failure again without a call.
   The buys that earned pieces among those transactions (the collectible hook's `PiecesEarned` events, taken only
   from the lines that hook logged) go to the mint crank and to the ticket index at no cost in calls.
5. What a coin card needs beyond the pool, in one batched read: for a coin seen for the first time its Metaplex
   metadata account (or the metadata a Token-2022 mint carries) and its mint, once; for a pool whose account
   changed, its coin's mint again (a graduation and the burns of the buyback and rules templates lower the
   supply); every mint every MINT_REFRESH_SECONDS (600; a holder's own token burn happens outside any pool); every
   name, symbol and uri every METADATA_REFRESH_SECONDS (21600); for a coin on the launch rules template its rules
   config and creator lock, with the Clock. Then the uri's JSON of up to eight coins: read once, within
   METADATA_TIMEOUT_MS (3000), at most 256 KB, for its picture, description and three links. One that does not
   answer is tried again after 15 minutes, then every hour. On a server the watcher refuses to fetch an address
   on the machine itself or its network (localhost, 10.x, 172.16.x, 192.168.x, 169.254.x and the like, redirects
   included); on localnet it allows them, because the local site serves the coins' JSON. Only the picture, the
   description and the links of the JSON are published.
6. The backfill. A pool that existed before the feed started is read once on its own: its last 200 transactions
   (one getSignaturesForAddress, then the transactions), merged into its file without doubles. At most about 400
   transactions of backfill a pass, the newest pools first. A pool created while the feed runs needs none: its
   creation is in the feed. Until its backfill ran, a pool has no file to serve (404), and the site reads the
   chain for it.
7. The files, written atomically (temp file, then rename): every pool file that changed, `status/market.json`
   every pass, and the feed's memory in `state/feed.json` (the cursor, the slot it started at, what is known of
   each pool, the transactions skipped as unreadable) and `state/market-cache.json` (the coins and the rules
   locks). A restart goes on after the cursor: nothing is doubled, nothing is missed. Delete the two files and the
   `status/trades` folder to start clean (see "Regenerating the trades files on a server" below).

One feed per state file. A watcher that runs the feed holds a lock while it runs: `state/feed.json.lock` next to
the feed's state, or, with `LOCK_DIR` set, `feed-<12 hex digits>.lock` in that folder (named after the state file's
full path). On a server `LOCK_DIR=/run/programmable-watcher`, the service's runtime folder (the unit file's
`RuntimeDirectory=`), which every reboot empties. The lock holds the process id, the machine's boot and the time
the process started. A second watcher started on the same files, a `node index.mjs --once` next to the service for
example, finds the lock held by the running process that wrote it, says so in its log and runs without the feed:
two feeds on the same files would each read every new transaction and write over each other's files. A lock left
by a process that is gone, by an earlier boot, or under a process id the system has handed to another process
since, is taken over. A watcher in its loop that runs without the feed it was asked for says so loudly: an error
line, one warning alert, and `/health` with `ok` false and `feedLocked`, `feedLockedBy`, `feedLockedSince`; its
loops then read the pools themselves, as with the feed off. A check by hand with `--pool <address>` never runs the
feed, so it is always safe next to the service.

More than 20,000 new transactions in one pass (the watcher was off for a long time) is a gap: the feed starts
again from the newest one and backfills every pool once more; the files it wrote stay and are merged into.

`/health` says how far the feed is: `feedSlot` (every event up to this slot is in the files), `feedLagSlots` (the
newest slot this watcher has read through any of its calls, minus `feedSlot`), `lastFeedAt`, `feedStale` (no pass
for three intervals: `/health` answers 503), `feedPools`, `feedTransactions` (transactions read since the state was
cleared, each once), `feedUnreadable` (transactions of the pool program skipped as unreadable: see step 2),
`marketUpdatedAt`, `marketPools`.

`/health` also says where the one list of pools stands: `poolsReadAt` (the last read of any pool), `poolsFullReadAt`
(the last read of the whole program), `poolsReadOwed`, `poolsFullReadFailures`, `poolsFullReadFailedSince`,
`poolsPatched` and `poolsFullReads` (counts since the start).

`--no-feed` or `FEED=off` turns it off. `--pool <address>` turns it off too: one pool's run writes no feed. The
feed sends nothing, so `--no-crank` leaves it on. With the feed off, each loop reads the pools itself when its
copy is older than its own interval (one getProgramAccounts shared by the loops that ask at the same moment).

To see it work on the local validator: `node watcher/prove-feed.mjs` from the repo root. It launches two coins on
the curve and one seeded coin with a tax hook, trades each once, starts the real watcher in its loop with every
file in a temporary folder, and checks the backfill. Then it trades all three while the watcher runs, buys one
past its graduation target (the SDK puts graduate into the buy), and compares, to the unit: every event of the
three files with the chain's own events (`client.allEvents`, the three kinds, newest first), the pinned curve
events, and market.json with the chain's pools (every pool account byte for byte, the reserves, the curve, the
coin's name, symbol, uri, decimals and supply, the creation time, the price and the market cap worked out again
from the chain). Then it stops the watcher, trades twice, starts it again on the same files and compares once
more. `--rpc <url>` sends the watcher's calls through a counting proxy. It runs on localnet only. Through a proxy
that answers every batch in a shuffled order, as Chainstack does, it passes the same way: each answer is paired by
its own signature.

### Regenerating the trades files on a server

The trades files written before this version may hold events paired with the wrong transaction (an RPC that
answers a batch in any order, read by position) and events twice. The watcher does not rewrite what it wrote
before. To build them again from the chain, stop the service, delete the feed's memory and the trades folder, and
start it: the first pass sets a new cursor and backfills every pool once (its last 200 transactions, about 400
transactions a pass, the newest pools first). Until a pool's backfill ran, its route answers 404 and the site
reads the chain for it, as on a fresh start. A pool with more than 200 transactions gets its last 200 back, and
its creation time in `market.json` stays null (the backfill does not reach its creation). `market.json` is written
again at the first pass; the coins' cache (`state/market-cache.json`) and the pool report (`state/state.json`)
stay. On the server, as root, one line at a time:

```
systemctl stop programmable-watcher
```
```
rm -f /home/programmable/sol-hooks/watcher/state/feed.json /home/programmable/sol-hooks/watcher/state/feed.json.lock
```

(With `LOCK_DIR=/run/programmable-watcher` the lock is in that folder, and the service's stop removes it.)
```
rm -rf /home/programmable/sol-hooks/watcher/status/trades
```
```
systemctl start programmable-watcher
```
```
journalctl -u programmable-watcher -n 50 --no-pager
```

The log says `feed state     new: the first pass sets the cursor and backfills every pool once`, then `feed done`
lines with `backfilled`. A minute or two later `curl -s http://127.0.0.1:8790/health` shows `feedPools` at the
number of pools and `feedTransactions` growing with the new trades only (the backfill does not count). Do not run
`node index.mjs --once` without `--pool` while the service runs: it would start a second feed on the same files
(this version refuses that and runs without the feed, with an error line saying so).

### HTTPS on a server

The site is served over HTTPS, so a browser reads the watcher over HTTPS too: a page on https:// may not read an
http:// address. On a server, put Caddy (or nginx) in front of the watcher and set `watcherUrl` in `web/config.js`
to the HTTPS address, for example `https://watcher.YOUR_DOMAIN`. With Caddy, on the server, one line at a time:

```
apt -y install caddy
```
```
printf 'watcher.YOUR_DOMAIN {\n  reverse_proxy 127.0.0.1:8790\n}\n' > /etc/caddy/Caddyfile
```
```
systemctl restart caddy
```
```
ufw allow 80/tcp && ufw allow 443/tcp && ufw delete allow 8790/tcp
```

The domain's DNS record must point at the server first: Caddy then fetches the certificate itself. The watcher's
routes already answer `Access-Control-Allow-Origin: *`, so nothing else is needed.

## The reveal crank, every REVEAL_INTERVAL_SECONDS (default 20)

On the collectible template a buy only records "N pieces, decided by the first block at or after slot S + 2".
Anyone may call the permissionless `reveal` once that block exists. If nobody does within 512 slots (about
3.5 minutes) the batch expires and its pieces are forced to the common tier. A buyer must never be able to
look at a bad result and leave it unrevealed, so the watcher reveals everything, promptly:

1. It reads the tickets the ticket index knows (see "The ticket index"), by address, one `getMultipleAccountsInfo`
   per hundred, and takes the slot from that read: one call a pass with up to a hundred tickets, however many
   pools, and never a read of the whole program. With no pool of the collectible template on the chain it reads
   nothing. A batch waits for its reveal only after a buy, and a buy changes its pool: when no collectible pool
   changed since a pass that found no batch waiting (pieces revealed and not minted yet need no keeper), the pass
   reads nothing either (every ten minutes it reads all the same). A read that fails ends the pass, is counted in
   `/health` (`revealUnreadStreak`) and is tried again at the next one.
2. For every ticket with a WAITING batch whose target slot has passed it sends `reveal`, up to 8 per
   transaction, signed and paid by the keeper (the probe wallet, `PROBE_KEYPAIR`), compiled with the platform
   lookup table when `web/deployments/<cluster>-alt.json` exists. It waits for confirmation and logs one line
   per ticket. A reveal on a ticket with nothing matured is a harmless no-op, so racing with users is fine.
   A transaction that fails is retried one ticket at a time: one bad ticket never holds back the others.
3. Alerts: warning `N pieces expired unrevealed on <SYM>: the keeper was not revealing in time` when a batch
   seen WAITING shows up EXPIRED (once per batch; it is shown on the pool but does not change the pool's
   score, because it is the keeper's failure, not the hook's). Danger when the keeper's balance falls below
   `KEEPER_MIN_LAMPORTS` on devnet or mainnet, because an empty keeper means reveals, settles, the upkeep
   of pegged coins and the buybacks and burns all stop.

What it costs: 5,000 lamports per reveal transaction (one signature), so 0.01 SOL pays for 2,000 of them. On
localnet and devnet the watcher airdrops to the keeper by itself. On mainnet YOU fund it.

`--no-crank` turns every crank off, the burn keeper included (the report still works). `--once` runs one
feed pass, one reveal pass, one settle pass, one upkeep pass, one burn pass, then one pool pass.

## The settle crank, every SETTLE_INTERVAL_SECONDS (default 10)

On the collectible template the pieces are pegged to the coin: a wallet holds at most one piece per `unit`
coins in its token account. When coins leave a wallet, the pieces they no longer back must go, newest first.
Waiting (unminted) pieces are dropped. Then minted pieces are burned from the end of the wallet's own list.
The instruction that does it is `settle`. It is permissionless: anyone may settle any wallet, and whoever
sends it receives the rent of every piece it burns.

The site adds `settle` to every sell, so a normal sell settles itself. The watcher settles everybody else:
coins that left by a plain wallet transfer, sells made with another client, a token account handed to another
owner. Without this crank a wallet could keep a piece without holding the coins.

1. It reads the tickets the ticket index knows (see "The ticket index"), by address, one `getMultipleAccountsInfo`
   per hundred; the configs of all collectible pools in one batched read; and the coin balances of the wallets
   that hold pieces (one read per hundred wallets, all pools together): what the SDK's `fetchUnbacked` does for
   one pool, for all the pools at once and without a read of the whole program. Three calls a pass with few
   holders, however many pools; none without a collectible pool. With the feed on, a pass reads only the tickets
   of the "hot" wallets, the ones the feed saw trade on a collectible pool or earn pieces in the last five minutes
   (none: no call at all), and every `SETTLE_SWEEP_SECONDS` (default 300) every indexed ticket. A feed pass that
   reads a sell on a collectible pool wakes the settle crank at once. So a sell made with another client is
   settled right after the feed reads it, within about ten seconds of the sell (measured on the local validator
   with the feed every 10 s: 1.6 s and 4.2 s after the sell), and a plain transfer of coins to another wallet, which no pool transaction shows, within the sweep. With the feed off every pass reads every ticket. It keeps the
   wallets that hold more pieces than their coins back. A wallet that still holds its coins is never touched. A
   read that fails leaves every pool
   unread for the pass, is counted in `/health` (`settleUnreadStreak`, `lastSettleReadAt`) and is tried again at
   the next pass; five minutes of failed reads raise one warning alert (see "When a read fails").
   The balance is counted the way the program counts it: the wallet's own token account for the coin, and
   only while that account belongs to the coin's token program, holds this coin and is still owned by the
   wallet. A token account that was closed, or handed to another owner, backs nothing.
2. For each of them it sends one `settle`, one per transaction, signed and paid by the keeper (the probe
   wallet), compiled with the platform lookup table when there is one. It waits for confirmation. The
   transaction is 649 bytes at its largest without the lookup table, against the 1,232 byte limit.
3. One settle burns at most 6 pieces (`MAX_BURNS_PER_SETTLE` in the SDK): the last 6 of the wallet's list.
   The program burns the last piece of the list while it finds it among the accounts passed, in any order,
   and stops when the wallet is backed. A wallet further above the peg is settled again by the next round,
   from a fresh read of the chain. That round starts 2 seconds later instead of waiting for the interval. A
   wallet holds at most 200 pieces, so the longest case takes 34 rounds. One pass sends at most 10 settles;
   the others wait for the next pass, which also starts at once.
4. It logs one line per settle: `settle: pool <pool> wallet <wallet>: dropped N, burned M, rent received R
   lamports, tx <signature>`. The numbers come from the transaction itself: the events the program logged and
   the keeper's balance before and after. The running totals (settles sent, pieces dropped, pieces burned,
   rent received, fees paid) are in `GET /health`, and with `--once` in one `settle totals:` log line.
5. The program never refuses a settle: it removes what it may and stops. So the round that does not work is
   usually a settle that is confirmed and removes nothing. The realistic cause is somebody else settling the
   wallet first: `settle` pays the rent to whoever sends it, so others will race the keeper for it. The log
   line then ends with `Nothing was removed`. A settle that is not confirmed at all (an RPC hiccup, an
   expired transaction) is logged as `settle FAILED`. Both are logged once, the pass moves on, and the next
   round reads the chain again. Neither raises an alert. A wallet above the peg cannot reorder its list (the
   program refuses), so it cannot shuffle its pieces away from the keeper.
6. Alerts: none per burn. If the settle of the same wallet does not work three rounds in a row, one danger
   alert: `settle failed 3 rounds in a row for wallet <wallet> on <SYM>: <error>. A piece that cannot be
   removed should be impossible. Look at it.` A lost race does not get there: the wallet somebody else settled
   is gone from the list by the next round. Three rounds in a row mean the chain keeps saying the wallet is
   above the peg and keeps removing nothing. The alert is shown on the pool and never changes the pool's
   score. After it the wallet is tried again only once every 30 rounds, so it costs neither log lines nor
   fees. The low keeper balance alert of the reveal crank covers this crank too: all cranks check the same
   wallet.

What it costs and what it earns: a settle transaction costs 5,000 lamports, like a reveal. Every piece it
burns pays its rent to the keeper. Measured on the local validator: 1,245,840 lamports (about 0.0012 SOL) for
one piece, so 1,240,840 lamports net of the fee. The rent per byte is the same on mainnet; the exact amount
follows the length of the piece's name and uri. (The burned account keeps 2,397,840 lamports: the rent of
its 1 byte plus 0.0015 SOL, the size of the Metaplex Core fee charged at mint. That part does not come
back.)

So the crank pays for itself through the rent of the pieces it burns. Two cases earn nothing and still cost
the fee: a settle that only drops waiting pieces, and a settle somebody else was faster on. The keeper wallet
still needs a small balance to start, because the first fee is paid before any rent comes in. The 0.1 SOL of
the setup below is plenty.

`--no-settle` turns this crank off and keeps the others. `--no-crank` turns them all off. With
`--pool <address>` the settle pass looks at that pool only.

On a pegged coin this crank has one case left: a holder that burns its coins directly. A burn is not a
transfer, so the coin's program does not run and the wallet stays above the peg until somebody settles it. The
crank reads the balances through the SDK, in the coin's own token program, so it finds that wallet like any
other.

To see it work on the local validator: `node watcher/prove-settle.mjs` from the repo root. It makes a fresh
wallet buy and mint a piece, moves the wallet's coins away with a plain transfer, runs the watcher for two
rounds and checks the chain after each: the piece account is left with 1 byte, the wallet's list is empty, the
keeper received the rent minus the fee, and a second wallet that kept its coins was not touched. With
`--hand-over` that second wallet then hands its token account to another owner: the coins do not move, they
back nothing any more, and one more watcher round burns its piece. The script refuses to run anywhere but on
localnet, because it airdrops.

## The upkeep crank, every UPKEEP_INTERVAL_SECONDS (default 10)

Only for pegged coins. There the wallet lists change inside every transfer of the coin, and the Metaplex Core
assets follow by `deliver` and `reap`. Both are permissionless. The site adds them to the transactions it
builds, so a transfer or a sell made on the site leaves nothing behind. A transfer made anywhere else (a
wallet's own Send button, another app) changes the lists and nothing else. Then a wallet shows a piece its list
no longer holds, or misses one it does hold, until somebody sends the two instructions. This crank does, so the
NFT a wallet shows matches its list within seconds.

1. It takes every collectible pool with a Token-2022 coin and reads its config. A pool whose config does not
   say `pegged` is left alone. For the others it reads the assets whose Metaplex owner is not the wallet whose
   list holds them and the pool's burn queue, the way the SDK's `fetchUndelivered` and `fetchQueue` read one
   pool, for all the pools at once. A wallet that simply holds its coins and its pieces is never touched. Cost
   per pass, however many pegged pools: one look at the collectible program's newest signature, one batched read
   of the configs and queues, one read per hundred of the tickets the ticket index knows (no read of the whole
   program), one per hundred pieces the lists hold. None without such a pool. A read that fails is counted in
   `/health` (`upkeepUnreadStreak`) and tried again at the next pass. A wallet list or an asset's owner changes only in a transaction of the collectible
   program (a transfer of a pegged coin runs it as the coin's transfer hook; trades, mints, deliveries and burns
   run it too). So when a pass left nothing waiting and the program has had no transaction since, the next pass
   is one getSignaturesForAddress and nothing more. Every five minutes it reads everything all the same.
2. It sends one `deliver` per holder and one `reap` per pool, with up to 6 assets each (the SDK's number), one
   per transaction, signed and paid by the keeper, compiled with the platform lookup table when there is one.
   Deliveries go first. It waits for each confirmation. A transaction with 6 assets is 649 bytes (deliver) or
   616 bytes (reap) without the lookup table, against the 1,232 byte limit.
3. The work of one pass is bounded: at most 10 transactions. What is left waits for the next pass, which then
   starts 2 seconds later instead of waiting for the interval.
4. The program skips an asset that does not qualify (already delivered, already burned, moved on) and the
   transaction does not fail for it. So racing with the site or with another keeper is fine.
5. A transaction that fails is logged once as `upkeep FAILED` and the pass moves on. When it named several
   assets, the crank sends it again one asset at a time, so one bad asset never holds back the others.
6. It logs one line per transaction: `upkeep: pool <pool>: delivered N assets to wallet <wallet>, tx
   <signature>` or `upkeep: pool <pool>: burned N assets from the burn queue, rent received R lamports, tx
   <signature>`. The numbers come from the transaction itself. The running totals are in `GET /health`, and
   with `--once` in one `upkeep totals:` log line.
7. Alerts: none per delivery or burn. If the same asset still waits after it was sent 5 rounds in a row, one
   danger alert: `asset <asset> on <SYM> is still not delivered to wallet <wallet> after 5 rounds in a row. ...
   This should be impossible. Look at it.` (or `is still in the burn queue`). Several assets of one pool that
   get stuck in the same round share one alert. The alert is shown on the pool and never changes the pool's
   score. After it the asset is tried again only once every 30 rounds, so it costs neither log lines nor fees.
   An asset that somebody else delivers or burns in the meantime is forgotten. The low keeper balance alert
   covers this crank too: every crank checks the same wallet.

What it costs and what it earns: every transaction costs 5,000 lamports. A delivery earns nothing. A burn pays
the keeper the rent of the asset plus the rent of its entry in the burn queue. Measured on the local validator:
1,218,000 lamports for the asset (a 176 byte piece; the amount follows the length of its name and uri) and
222,720 lamports for the queue entry, 1,440,720 lamports together, about 0.0014 SOL. With one asset each, a
delivery used 19,850 compute units and a burn 22,612, against a limit of 400,000. (The burned account keeps
2,397,840 lamports, as with a settle.) So one burn pays the fees of 287 other keeper transactions. The keeper
still needs its small balance to start.

`--no-upkeep` turns this crank off and keeps the others. `--no-crank` turns them all off. With
`--pool <address>` the upkeep pass looks at that pool only.

To see it work on the local validator: `node watcher/prove-upkeep.mjs` from the repo root. It needs a pegged
pool (`node scripts/e2e-pegged.mjs localnet` makes one) and `@solana/spl-token` in the workspace, which builds
the transfers the way a wallet does. With `--pool <address>` it runs on that pool; without, on the pool it was
written against, or on the deepest pegged pool when the validator no longer has that one. On a validator shared
with other work, pass `--pool`. A fresh wallet buys and mints a piece and moves all its coins, with a
plain transfer, to a wallet that has a ticket: the list moves, Metaplex still shows the sender. One watcher
round later Metaplex shows the receiver. That wallet then moves the coins on to a wallet without a ticket: the
piece leaves the list and sits in the burn queue. One more watcher round: the asset account is left with 1 byte,
the queue is empty, the keeper received the two rents minus the fee. A third round sends nothing. A control
wallet that kept its coins is checked after every round: nothing of it was touched. At the end the coins are
sold back. The script refuses to run anywhere but on localnet, because it airdrops.

## The burn keeper, every BURN_INTERVAL_SECONDS (default 30)

Two templates collect a share of every trade to buy the coin back and burn it. A coin on "Buyback and burn"
keeps that money in a treasury only its hook controls. A coin on "Launch rules" keeps it in its burn pot. The
buy itself is an instruction anyone may send: `execute_buyback` for the first, `run_burn` for the second.
Nothing in the programs sends it. Somebody has to.

Why it matters. An instruction that anybody may trigger, and that buys, can be gamed: pump the price, trigger
the buy at the pumped price, sell into it. The two programs guard against that (HOOKS.md section 7). A call
buys only against a record of the pool that an earlier call took at least 25 slots before (the observation).
It buys only while the price has not run above that record by more than a small tolerance. And one buy spends
only a slice of the pool's SOL, between 0.01% and 0.5% of it, which follows the pool's fees. What is left is a
pump that really stands in the pool for those 25 slots. It can take a part of the pot, and never more than
the pot. So a pot that is run regularly leaves little to take, and a pot that nobody runs grows until it is
worth an attack. Whoever looks after a coin runs its burn on a timer. This crank does it for every coin.

1. The shared list of pools gives the pools of the two templates (`--pool <address>`: that pool only). One
   batched read of their configs and treasuries says where something waits. A pool with nothing to spend is
   left alone, and costs nothing more. So is a buyback pool whose treasury is under the coin's own minimum, where
   the program refuses a call, and a pot under `BURN_MIN_POT_LAMPORTS`: a coin without a burn rate still collects
   a few lamports of rounding in its pot, and a call would cost more than it burns. A pot grows only with the
   trades of its pool, and a trade changes the pool account: when no pool of the two templates changed since a
   pass that found nothing to spend, the pass reads nothing at all (every ten minutes it reads all the same).
2. For every pool that is left it asks the SDK what a call sent now would do (`client.buybackInstructions`,
   `client.rulesBurnInstructions`: one more read for a buyback pool, two for a rules pool). There are four
   answers:
   - `observe`: the pool was never recorded. The call records it and buys nothing. The keeper sends it.
   - `wait`: the price is above the record by more than the tolerance. The call records the pool again and
     buys nothing, so that the next call can buy. The keeper sends it.
   - `buy`: the call buys and burns. The keeper sends it, with the SDK's floor for what the buy must give:
     the pool's own quote for that buy, less `BURN_SLIPPAGE_BPS`.
   - `tooSoon`: the record is less than 25 slots old. The chain would refuse a call, so the keeper sends
     nothing and comes back at the next pass.
3. It sends one transaction per pool, signed and paid by the keeper, compiled with the platform lookup table
   when there is one, and waits for each confirmation. A pass sends at most `BURN_MAX_CALLS`. The larger pots
   go first. What is left waits for the next pass, which then starts 2 seconds later instead of waiting for
   the interval. A paused platform refuses trades, and the buy of a burn is a trade: the keeper sends nothing
   while the platform is paused.
4. It logs one line per call, with the outcome the chain reported. The outcome is read from the transaction
   itself: the event the program emitted (`BuybackExecuted` or `BurnExecuted`), or else its return data.
   - `burn: pool <pool> (rules): observed, the pool is recorded and nothing is bought yet, pot N lamports, next
     call from slot S, tx <signature>`
   - `burn: pool <pool> (buyback): waited, the price is above the observation, the pool is recorded again and
     nothing is bought, pot N lamports, next call from slot S, tx <signature>`
   - `burn: pool <pool> (rules): bought, spent N lamports, burned M raw coins, L lamports left in the pot, next
     call from slot S, tx <signature>`
   - `burn FAILED: pool <pool> (rules): a call expected to buy was not confirmed: <the program's error>`
   A pool that was too soon gets a line only with `-v`. Every pass ends with one `burn done:` line that counts
   the pools, the calls and their outcomes. The running totals are in `GET /health`, and with `--once` in one
   `burn totals:` log line.
5. What the chain does can differ from what the SDK said a moment before, because a trade landed in between.
   A call expected to buy may come back as `waited`, and the line says what the chain did. A call that is
   refused (another keeper was faster, and the record is young again) is logged once as `burn FAILED` and the
   pass moves on. A buy that would give less than its floor is refused by the chain and costs nothing: the
   refusal comes from the simulation that precedes every send.
6. Alerts: none per call. If the call for the same pool fails three passes in a row, one danger alert: `the
   burn call failed 3 passes in a row on <SYM>: <error>. N lamports wait in its burn pot and are not being
   spent. Look at it.` It is shown on the pool and never changes the pool's score. After it the pool is tried
   again only once every 30 passes. A call that is confirmed clears the count, whatever its outcome: observed,
   waited and bought are all the chain's own answers. A pass that skips the pool as too soon neither counts
   nor clears. The low keeper balance alert covers this crank too.
7. A coin that keeps rising makes its burn wait: every call comes back as `waited` until the price stands
   still for 25 slots or falls. That is the rule working, not a fault, and it raises no alert. The keeper
   keeps calling, because each of those calls renews the record the next buy needs.

What it costs and what it earns: every call costs the keeper 5,000 lamports and earns it nothing. The coins
are bought with the pool's own pot and burned, and no rent comes back. The chain takes at most one call per
pool every 25 slots, and the keeper makes at most one per pool per pass. At the default 30 seconds that is at
most 2,880 calls a day for a pool that always has something to spend: 0.0144 SOL a day for that pool. A pool
with an empty pot costs nothing. Measured on the local validator with the lookup table, in two runs of the
proof below: each call is a transaction of 540 bytes. A call that records used 20,500 compute units on a
buyback pool and 23,800 to 28,300 on a rules pool. A call that buys used 56,600 on a buyback pool and 59,600
to 64,100 on a rules pool. The numbers move by a few thousand with the addresses involved; the limit the SDK
asks for is 300,000 and 250,000. Unlike the settle crank and the upkeep crank, this one does not pay for
itself: with many buyback and rules pools, watch the keeper's balance.

Settings: `BURN_KEEPER` (`on` or `off`), `BURN_INTERVAL_SECONDS`, `BURN_MAX_CALLS`, `BURN_MIN_POT_LAMPORTS`
and `BURN_SLIPPAGE_BPS`, all in the table below. `--no-burn` turns this crank off and keeps the others, the
same as `BURN_KEEPER=off`. `--no-crank` turns them all off. With the burn keeper off, the pool report says so
on every buyback and rules pool: somebody else must run those buys.

A strict coin of the launch rules template burns through its own instruction, `run_burn_strict`: the pool
buys with `hook_buy_burn` and burns the coins in its own vault, so no transfer of the coin runs. The SDK's
`rulesBurnInstructions` builds that call for a strict coin, so the keeper does nothing different. Measured: a
call that records 19,900 compute units, a call that buys 54,300, 508 bytes with the lookup table.

### The holder sync of strict coins (part of the burn keeper's pass)

A strict coin pays its holders' share to the wallets that opened a holder record, on what the record counted
at the wallet's last transfer. A token Burn calls no transfer hook. So after a burn the record still counts
the burned coins, and that wallet keeps being paid on coins that are gone, out of the other holders' part,
until its next transfer or until anybody sends `sync_holder`, which lowers a record to what its wallet holds.

Finding such records is cheap, so the burn keeper does it. In every pass: one batched read of the configs and the
coins' mints of all strict pools. A record can stand above its wallet's coins only after a token Burn, and a burn
lowers the coin's supply. So a strict pool's holder records are read (one read of its records, and one of their
wallets' coin accounts per hundred) only when its coin's supply moved since the last read, while the last read
found records to sync, and at least every ten minutes. That read of the records is a `getProgramAccounts`, the
one call a shared RPC node aborts under load: a pool whose read failed waits 30 seconds before the next try, then
60, 120, up to ten minutes, while the other pools go on; the failures are counted in `/health`
(`holderSyncUnreadStreak`) and five minutes of them raise one warning alert. A record that stands above its wallet's coins by at least
`HOLDER_SYNC_MIN_BPS` (default 10, that is 0.1%) of all the coins in holder records gets a `sync_holder`. Up to
five go in one transaction, at most ten per pass, the largest excess first, signed and paid by the keeper. A
transaction that fails is sent again one record at a time. The minimum keeps the keeper from paying 5,000
lamports to correct a few raw units: a smaller excess takes a share of the holders' part that is smaller
still.

One log line per record, with what the chain did (its `HolderSynced` event):
`sync: pool <pool> wallet <wallet>: holder record lowered from R to B raw units, it stood E above the wallet's
coins (X bps of the coins in holder records), tx <signature>`, or `sync FAILED: pool <pool> wallet <wallet>:
<the program's error>`. A failed one is read again in the next pass; no alert, because the next transfer of
that wallet, or anybody's sync, corrects it too. With `--once` the totals are one `sync totals:` log line.
`/health` counts them (below). A sync costs 5,000 lamports for up to five records and earns nothing; it used
14,700 compute units and 311 bytes for one record. It needs the burn keeper: `HOLDER_SYNC=off` turns only the
sync off, `--no-burn` and `BURN_KEEPER=off` turn both off. A sync is no trade, so a pause of the platform does
not stop it.

To see it work on the local validator: `node watcher/prove-burn.mjs` from the repo root. It launches a buyback
coin, a rules coin and a strict rules coin with a burn rate, has a wallet trade on all three until each pot
holds more than one buy may spend, and then runs the watcher on each coin, one round at a time, reading the
chain after every round. On the strict coin the wallet's first buy opens its holder record, and then the
wallet burns half its coins with a token Burn. Round 1: the keeper sends one call, and the hook's config holds
the pool's reserves and the slot; on the strict coin it also sends one `sync_holder`, and the wallet's record
counts its coins again. Round 2, at once: the keeper sends nothing, and says the call would be too soon. Round
3, after 25 slots: the keeper sends one call that buys (`run_burn_strict` on the strict coin). The coin's
supply falls by exactly what the event says, the pot falls by exactly what was spent, and the record is the
pool as the buy left it. At the end it adds up what the keeper paid: seven transactions, 35,000 lamports. With
`--buyback <pool>`, `--rules <pool>` or `--strict <pool>` it uses a pool that exists, which must hold something
to spend and must never have been recorded. The script refuses to run anywhere but on localnet, because it
airdrops.

The proof also launches a fourth coin: a rules coin on the curve, with the rules coin's rates (`--curve <pool>`
uses one that exists). It needs larger trades to fill its pot, because one buy of its burn may spend a slice of
the effective SOL, about seven times the 5 SOL of the seeded coins. Every number it works out by hand counts
the virtual SOL: round 1 checks that the observation holds `reserveQuote + virtualQuote`, round 3 that the buy
spent the cap of the smaller of the effective quote now and the observed one, and the pool report is clean,
with the coin's own 1.5% and 2.5% as its effective taxes. For round 10 (`test/review_r10_fixes.test.mjs`): the
one list of pools that owes a read after a failure and is patched by address, the ticket index (add, read a
hundred a call, drop what is gone or empty, list the program again with a growing pause, the file), the events
attributed to the program that logged them (a forged `PiecesEarned` is not the hook's), the pools a feed pass
touched and the buys it hands on, the 429 pauses, the cranks fed by the index (no `getProgramAccounts`, no
`getSlot`), the mint crank fed by the feed and by `/notify` (a stranger's transaction adds nothing), the holder
sync's pause after a failed read, the read streaks in `/health`, the server that answers 400 to a bad target and
takes, limits and refuses notifications, and the private-host guard that judges names that carry an address,
addresses in every IPv6 form, and a name's real addresses before it connects.

## The graduate crank, every GRADUATE_INTERVAL_SECONDS (default 15)

A pool on the curve that reached its graduation target keeps trading on the curve, with the virtual SOL in its
price, until somebody sends `graduate`. The SDK and the trade API put it into the trade that takes a pool to its
target (after the swap) and into any trade on a pool that stands past it (before the swap), so most coins
graduate inside a trade. A trade built without them does not. This crank graduates those pools.

1. The shared list of pools gives the pools on the curve (`--pool <address>`: that pool only). A pool whose real
   SOL is at or past its target is due. Nothing else is read: with no pool due a pass costs no call at all, and
   the keeper's balance and the platform's pause are read only for a call.
2. For every due pool it sends one `graduate`, signed and paid by the keeper, and waits for the confirmation.
   The instruction takes no signer and no argument: whoever pays the fee sends it. A pass sends at most ten,
   the pools with more SOL first; what is left waits for the next pass, which then starts 2 seconds later. A
   paused platform refuses a graduate, so the crank sends nothing while it is paused.
3. Once. A pool that graduated is no longer on the curve and is never due again. A pool this watcher graduated
   less than two minutes ago is not sent another call even if a lagging RPC still shows it open (a warning line
   says so). A second graduate would land and change nothing: the program lets it through, so that the one a
   trade carries can never fail the trade. The crank reads what the chain did from the transaction itself:
   - `graduate: pool <pool>: graduated with R lamports of real SOL raised, burned B raw coins to keep the price,
     F lamports for the platform; the pool holds R2 lamports and B2 raw coins now, tx <signature>` (the
     `Graduated` event)
   - `graduate: pool <pool>: the pool had graduated already, the call changed nothing, tx <signature>` (no event:
     a trade or another keeper was first)
   - `graduate FAILED: pool <pool>: <the program's error>`
   Every pass ends with one `graduate done:` line (debug unless a pool was due). With `--once` the running totals
   are one `graduate totals:` line; in the loop they are in `GET /health`.
4. Alerts: one info alert per coin that this crank graduates, an event of the coin's life: `<SYM> graduated
   from the curve: 86.9 SOL raised, B raw coins burned so that the price stays, 0 SOL for the platform. Its
   liquidity is open now. Sent by this watcher, tx <signature>`. If the call for the same pool fails three passes
   in a row, one danger alert: `the graduate call failed 3 passes in a row on <SYM>: <error>. The pool holds R SOL
   of real SOL, past its target of T SOL, and keeps trading on the curve until somebody graduates it. Look at
   it.` Both are shown on the pool and never change its score. After the danger alert the pool is tried again
   only once every 30 passes. The low keeper balance alert covers this crank too.

What it costs: 5,000 lamports per graduation, once in a coin's life, and it earns nothing. Measured on the local
validator: 319 bytes, about 16,000 to 21,000 compute units. A pass with nothing due costs no RPC call.

Settings: `GRADUATE_KEEPER` (`on` or `off`, default `on`) and `GRADUATE_INTERVAL_SECONDS` (5 to 3600, default 15),
in the table below. `--no-graduate` turns this crank off and keeps the others, the same as `GRADUATE_KEEPER=off`.
`--no-crank` turns them all off. With the crank off, the report of a pool past its target says that somebody else
must send graduate, and `--once` says `graduate crank off` in place of its pass.

To see it work on the local validator: `node watcher/prove-graduate.mjs` from the repo root. It launches a coin
on the curve, has a wallet buy 42.5 SOL of it, and runs the watcher on the pool one round at a time, reading the
chain after every round. Round 1, under the target: nothing is sent, the report carries the curve as the chain
holds it, with a clean verdict. Then the wallet buys past the target with a swap the SDK builds without graduate
(`swapInstructions(..., { graduate: false })`). Round 2, with `GRADUATE_KEEPER=off`: nothing is sent. Round 3: one
graduate, the pool graduated, the price held to within one unit of the coin, the burn is the program's formula
and the supply fell by it. Round 4: nothing more. Then the wallet sells on the graduated pool. With `--pool
<pool>` it uses an open pool on the curve that exists and stands under its target. It runs on localnet only.

## The mint crank, fed by the feed and by POST /notify, its own poll every MINT_INTERVAL_SECONDS (default 60)

One approval for a buy that earns NFTs. A buy of a collectible coin cannot mint its pieces: a block two slots
after the buy decides how they look. So the site and the trade API add a deposit to the buy, in the same
transaction: a plain SOL transfer from the buyer to its own ticket. Anyone may then send the permissionless
`mint_for`, which mints the wallet's decided pieces into the WALLET and pays its sender back, out of that deposit,
exactly what it spent on the NFTs plus `KEEPER_FEE`, 10,000 lamports. This crank is that sender. The buyer signs
once, and its NFTs are in its wallet a few seconds after the buy (on the local validator: 4 to 5 slots after the
buy, under 2.5 seconds after it confirmed).

1. Finding the buys, at no cost in RPC calls. Every buy is a transaction of the pool program, and the trades feed
   reads those anyway: a buy that earned pieces logs `PiecesEarned { pool, user, pieces, slot, target_slot }`
   (taken only from the lines the collectible program itself logged), and the feed hands that wallet to the crank
   the moment it reads the transaction, within a feed interval of the buy. The coin page does better: right after
   its buy landed it POSTs the buy's signature to `/notify` (through the site's `/watcher/` proxy), the crank asks
   for that signature's status within a second, reads the transaction when the chain knows it, and the mint goes
   out as soon as the deciding block is in, a few slots after the buy. Nothing of the caller's is trusted but the
   signature: the transaction must be one of the pool program with a `PiecesEarned` the hook logged, and the
   ticket is read from the chain before anything is sent.
   The crank's own poll, one `getSignaturesForAddress` on the collectible program every `MINT_INTERVAL_SECONDS`
   (default 60) for the signatures newer than the last one seen, is the safety net for a buy that reached neither
   way. Nothing new and nobody waiting: that is the whole poll. The new transactions are read in one batched
   call, the watcher's own transactions skipped. When the RPC no longer knows the signature the poll's cursor
   points at (a node with a short history, or one that lags), the cursor is dropped and set again by the next
   poll, and the tickets are swept, instead of every poll failing the same way. At the start and every `MINT_SWEEP_SECONDS` (default 300) a
   read of the tickets the ticket index knows (by address, one call per hundred, never the whole program) adds
   the tickets with pieces waiting and a deposit: what the feed, the page and the poll all missed (the watcher
   was down, a deposit sent on its own, more than 100 transactions between two polls, which also brings the next
   sweep forward). The program is listed again at every start, so a buy made while the watcher was down is in the
   index before that first sweep.
2. While a wallet waits, the passes come every half second: one `getSlot`, then one `getMultipleAccountsInfo`
   for the wallets whose deciding block is in (their tickets, the coins that back their pieces, the configs). A
   wallet whose block is not in yet is not read. A wallet with one batch decided and another still waiting
   waits up to five seconds for it, so that one `mint_for` (one keeper fee) takes them all.
3. For each wallet, one `mint_for` of every decided piece, up to four, and only when:
   - the deposit covers it to the lamport (the SDK's `mintForCost`, which the chain matches exactly), and
   - a simulation against the newest state of the node succeeds and shows the keeper's balance after the
     transaction, fee included, no lower than before it. The node's own preflight runs on the same state.
   So the keeper is never out of pocket: a wallet that sold, withdrew or deposited too little costs it a
   simulation, no fee. Every mint it sends earns it 10,000 lamports less the 5,000 of the signature.
4. What it does not send: a wallet that minted its pieces itself first is dropped (`mintedFirst`), so is one
   whose deposit is short of the mint (`short`, one log line per deposit: the wallet mints itself, its deposit
   pays first). A simulation that fails with `WrongAsset` or `NothingToMint` (the wallet is minting, the node's
   view lags) is tried again at the next pass. Any other refusal waits 5 seconds, then 10, and after three in a
   row the wallet rests for ten minutes. A mint that fails on chain (a wallet that minted or withdrew in the
   very slots between the simulation and the landing: it costs the keeper one signature) waits 30 seconds, then
   60, and rests after the third. One wallet per transaction, ten transactions a pass at most.
5. Log lines: `mint: pool <pool> wallet <wallet>: minted 3 pieces into the wallet, 4 slots after the buy, paid
   back 10857520 lamports from its deposit (40880 left), keeper +5000 lamports after the fee, tx <signature>`,
   `mint FAILED: ...`, and one `mint done:` line per pass (debug unless something was found or sent). A failed
   mint raises a warning alert.

What it needs in the keeper wallet: a mint makes the keeper pay the NFTs' rent and Metaplex Core's fee first, and
the deposit pays it back at the end of the same transaction. So the keeper must hold that much while the
transaction runs: about 0.0045 SOL a piece, 0.018 SOL for a mint of four. Keep at least 0.05 SOL in it (and
`KEEPER_MIN_LAMPORTS` at 50000000 or more); a keeper short of it is refused by the simulation, sends nothing and
pays nothing, and the wallets then mint their pieces themselves.

What it costs in RPC calls: the poll is one call (2 request units) a minute at the default; the feed's hand-over
costs nothing. `/notify` costs one `getSignatureStatuses` for every signature waiting at that moment (at most one
look a second, 256 signatures a call), and the transaction (once, twice at most) only for a signature the chain
knows; a signature of nothing is dropped after the status call, and nothing a caller sends wakes the mint loop or
makes the crank read every ticket. At the default limits (3 a minute per address, 30 in all) a flood of made-up
signatures costs at most 30 calls a minute. A buy costs about ten calls (its
transaction, a few slot and account reads while its block comes, the balance, the simulation, the send, the
confirmation, the transaction it sent). The sweep is one call per hundred indexed tickets every five minutes.
With the mint crank on, the upkeep crank takes the collectible program's newest signature from the crank's last
poll when that is less than 15 seconds old.

Settings: `MINT_CRANK` (`on` or `off`, default `on`), `MINT_INTERVAL_SECONDS` (1 to 3600, default 60),
`MINT_SWEEP_SECONDS` (30 to 86400, default 300), `MINT_PRIORITY_MICROLAMPORTS` (0 to 20000, default 0: a
mint asks for 250,000 compute units, the fee is charged on that limit, and at 20,000 a unit the network fee of a
mint reaches the 10,000 lamports the deposit pays back), `NOTIFY` (`on` or `off`, default `on`: the `/notify`
route; off whenever the mint crank is off), `NOTIFY_PER_MINUTE` (1 to 600, default 3: signatures one address may
hand in a minute) and `NOTIFY_GLOBAL_PER_MINUTE` (1 to 6000, default 30: everybody together); more answer 429.
`--no-mint` turns this crank off and keeps the others;
`--no-crank` turns them all off. With `--once` the round is the sweep and the passes while a wallet waits for its
block, 20 seconds at most, then one `mint totals:` line. `/health` counts the buys handed in (`mintHanded`,
`notifyAccepted`, `notifyRefused`).

To see it work on the local validator: `node watcher/prove-mint.mjs` from the repo root. It starts the real
watcher in its loop (state, status, the ticket index and a new keeper key in a temporary folder, the feed off, so
the crank's own poll finds the buys), then: a buy with the deposit on a plain seeded coin, on a pegged coin and on
a plain coin on the curve (the live configuration; the buy is sized on the pool's real and virtual SOL together),
one signature each, minted into the buyer within seconds by one `mint_for` of the keeper, the deposit paying
exactly the mint's cost and the keeper ending 5,000 lamports richer; a wallet that races the keeper with its own
mint (each piece minted once, whoever wins); a deposit of 1 lamport (nothing sent, the wallet mints itself); a buy
while the watcher is down (the listing at its start finds the ticket, the start sweep mints it); and `/health`.
Every wallet sells back and withdraws what is left of its deposit. It runs on localnet only.

## The ticket index (state/tickets.json)

A ticket is the collectible hook's account `["ticket", pool, wallet]`: a wallet's pieces on one pool, waiting and
minted. The reveal, settle and upkeep cranks, the mint crank's sweep and the pool pass all need the tickets, and
each used to read every account of the program with a `getProgramAccounts` a pass: on a shared RPC node that call
is aborted under load ("scan aborted: scan abandoned after waiting ... for a scan slot"), several times a day. So
the watcher keeps the tickets BY ADDRESS, in `state/tickets.json`, and reads them with `getMultipleAccountsInfo`,
a hundred an answer:

- every buy that earns pieces is a transaction of the pool program the trades feed reads: its `PiecesEarned` event
  names the ticket (pool, wallet), and the feed adds it; so does a `PiecesTransferred` that moved pieces to a
  wallet (a pegged coin's transfer inside a trade);
- the mint crank's own poll and `/notify` see `PiecesEarned`, `DepositUsed`, `PiecesTransferred` and `PieceSent`
  too, and add theirs (a pegged coin's transfer outside any pool reaches the index this way, within a poll);
- a reconciliation lists the program once: one `getProgramAccounts` filtered to tickets with `dataSlice` length 0
  (addresses only, a small answer), at every start and then every `TICKET_RECONCILE_SECONDS` (default 3600). A
  listing that fails is tried again after 1 minute, then 2, 4, ... up to an hour, and three failures in a row
  raise one warning alert; the cranks work from the tickets the file knows meanwhile, and every new buy reaches
  them through the feed.

A ticket read with nothing waiting and nothing owned three reads in a row leaves the index and is remembered as
empty, with its pool, for six hours: the hourly listing leaves it out meanwhile instead of adding every ticket
ever opened again for three reads each (the program never closes a ticket). Its next buy, or a move of pieces to
it, puts it back at once; after the six hours the listing takes it back once, and it leaves again if it is still
empty. An address that holds no account leaves at once, unless an event named it in the last ten minutes: an RPC
node a few slots behind the buy answers no account for a ticket the buy has just made. Such a ticket keeps its
place with no strike while the answer's slot is older than the event's, is read again for three reads otherwise,
and joins the index again when it shows up. So the index holds about the tickets that hold pieces, and a read of
them costs one call per hundred.

A read in flight is shared by every loop that asks meanwhile (so two reads never run over the same tickets at once,
and an empty read counts once), and a finished read is answered again to a loop that asks within three seconds of
it. The wallets the feed saw trade or earn pieces in the last five minutes are "hot": the settle crank reads their
tickets alone every pass (see "The settle crank"). `state/tickets.json` is written when something in it changed,
at most once a minute, and when the watcher stops.

`/health`: `ticketIndexSize`, `ticketIndexReconciledAt`, `ticketIndexReconcileFailures`,
`ticketIndexReconcileFailedSince`, `ticketIndexEmptied`, `ticketIndexHot`. The file is safe to delete: the next
start lists the program again. With a `STATE_FILE` of its own (a proof, a second watcher) the index lives next to
that file unless `TICKET_INDEX_FILE` says otherwise.

## When a read fails

Every crank reads the chain before it decides anything. A read that fails (the RPC aborted the call, timed out,
answered 429) leaves the pass with nothing to do and is tried again at the next one; nothing is sent on stale
knowledge. The watcher counts those failures per crank: `/health` carries, for the settle, upkeep, burn, holder
sync and reveal cranks, `<crank>UnreadStreak` (passes in a row without a complete read), `last<Crank>ReadAt` and
`<crank>ReadStale`; five minutes of failures in a row raise one warning alert (`settle: no complete read of the
chain for 5 minutes ...`), the first good read after them logs `the read of the chain works again`, and ten
minutes of failures make `/health` answer 503 with `readStale: true`, like a crank that stopped running. The reads
of the whole pool program (the feed's reconciliation) and of the holder records (the holder sync) are the two
`getProgramAccounts` left, and both back off after a failure as said in their sections.

An exception nobody caught (a request handler, a timer) does not stop the watcher: it is logged, said once in an
alert, and the loops go on. The HTTP server answers 400 to a request target that is not a URL and 500 to anything
unforeseen, and never throws out of its handler.

## Files

| Path | What |
|---|---|
| `index.mjs` | the loop, the CLI, the per-pool check |
| `lib/simulate.mjs` | signature-less swap simulation, effective-tax math, platform cap |
| `lib/score.mjs` | the score rules (pure) |
| `lib/diff.mjs` | platform, config, manifest and upgrade-authority diffing (pure) |
| `lib/telegram.mjs` | alert text, dedupe, sending |
| `lib/status.mjs` | the status schema, atomic write, summary table |
| `lib/chain.mjs` | batched account reads: hooks, pools, and for every coin its name and its mint |
| `lib/coin.mjs` | what kind of coin a pool trades, read from the mint: plain, pegged, or a transfer hook that should be impossible (pure) |
| `lib/crank.mjs` | the reveal crank (which tickets are due, batching, sending, the expired diff, the balance rule), the settle crank (which wallets are above the peg, the burn list of each round, sending, the three strikes rule, the totals) and the upkeep crank of pegged coins (which assets wait, the plan of a pass, sending, the stuck rule, the totals) |
| `lib/burn.mjs` | the burn keeper of buyback pools and rules pools (where something waits, the decision for each of the SDK's answers, the plan of a pass, sending, what a call did as the chain reports it, the three strikes rule, the totals), and the holder sync of strict coins (which records stand above their wallets' coins, the batches, the log line) |
| `lib/mint.mjs` | the mint crank of collectible coins (the buys handed in by the feed and by `/notify`, the decision for each wallet, the refusals, the watch list, the sweep over the indexed tickets, the simulation and the send, the totals) |
| `lib/events.mjs` | the collectible hook's `PiecesEarned` and `DepositUsed` events out of a transaction's log lines, each line attributed to the program that logged it; the account keys of a transaction (pure) |
| `lib/tickets.mjs` | the ticket index: the tickets by address, fed by the feed and the mint crank, read a hundred a call, listed again at the start and every TICKET_RECONCILE_SECONDS |
| `lib/curve.mjs` | pools on the curve: the `curve` part of an entry and its notes, and the graduate crank (which pools are due, the plan of a pass, sending, what a call did as the chain reports it, the three strikes rule, the totals) |
| `lib/feed.mjs` | the trades feed: the list of the pool program's new transactions, their events per pool, the 300 cap, the backfill, the cursor |
| `lib/market.mjs` | market.json: one entry per pool, the coins' metadata and mints read once and cached, the metadata JSON fetched with a timeout |
| `lib/pools.mjs` | the one list of the pools that every loop shares: patched by address by the feed after every transaction, the whole program read only as a reconciliation, owed a read after a failure |
| `lib/schedule.mjs` | when a pool with a hook is simulated again |
| `lib/plain.mjs` | errors in words for everything the site prints: JSON fragments replaced by their message, an address cut to its host, the chain's errors by name (pure) |
| `lib/server.mjs` | `GET /pools.json`, `GET /market.json`, `GET /trades/<pool>.json`, `GET /health`, `POST /notify` |
| `lib/config.mjs`, `lib/state.mjs`, `lib/log.mjs` | .env parsing, persisted state, log lines |
| `status/pools.json` | what the website reads (written atomically) |
| `status/market.json`, `status/trades/<pool>.json` | the two feeds (written atomically; `status/trades/part/` holds pools waiting for their backfill, not served) |
| `state/state.json` | memory between passes; safe to delete, the watcher starts clean |
| `state/feed.json`, `state/market-cache.json` | the feed's cursor and what it knows of each pool, the coins' cached metadata; safe to delete together with `status/trades/` |
| `state/tickets.json` | the ticket index: every ticket of the collectible program that holds pieces, by address, and the tickets read empty lately (see "The ticket index"); written at most once a minute and at the stop; safe to delete, the next start lists the program again |
| `state/feed.json.lock` | the lock of the watcher that runs the feed on these files (one feed per state file: its process id, the boot, the process's start); removed when it stops, taken over when that process is gone. With `LOCK_DIR` it lives in that folder instead (`/run/programmable-watcher/feed-<id>.lock` on a server) |
| `state/probe-keypair.json` | the probe wallet, also the keeper that pays for reveals, settles, deliveries, burns of pieces, buybacks and burns of coins, and graduations; created on first start if missing |
| `test/` | `node --test "watcher/test/*.test.mjs"` from the repo root runs the offline unit tests |
| `prove-settle.mjs` | live proof of the settle crank on the local validator (localnet only, it airdrops) |
| `prove-upkeep.mjs` | live proof of the upkeep crank on a pegged pool of the local validator (localnet only, it airdrops) |
| `prove-burn.mjs` | live proof of the burn keeper on a buyback coin, a rules coin, a strict rules coin and a rules coin on the curve it launches on the local validator, the holder sync included (localnet only, it airdrops) |
| `prove-mint.mjs` | live proof of the mint crank: buys with a deposit on a plain and a pegged coin, minted into the buyer by the real watcher in its loop (localnet only, it airdrops) |
| `prove-graduate.mjs` | live proof of the graduate crank on a coin on the curve it launches on the local validator and buys past its target without graduating it (localnet only, it airdrops) |
| `prove-feed.mjs` | live proof of the trades feed and market.json against the chain, to the unit, a restart included (localnet only, it airdrops) |
| `programmable-watcher.service` | systemd unit |

## Running it on your PC

The watcher imports the SDK build at `../sdk/dist/index.js` and `@solana/web3.js` from the repo root
`node_modules`. From the repo root, once:

```
npm install
```
```
npm run sdk
```

Then, one line at a time:

```
cd watcher
```
```
copy .env.example .env
```
```
node index.mjs --once
```

`--once` runs one feed pass, one reveal pass, one settle pass, one upkeep pass, one burn pass, one graduate pass, one mint round and one pool
pass, prints a table and exits 0 on success. `node index.mjs --pool <address> --once` prints the full entry of
one pool. `node index.mjs` loops and serves `http://localhost:8790/pools.json`, `http://localhost:8790/market.json`
and `http://localhost:8790/trades/<pool>.json`. For the local site, set `watcherUrl: "http://localhost:8790"` in
`web/config.js`. Add `--no-crank` to any of them
to send no transaction at all, `--no-settle` to send no settle, `--no-upkeep` to send no deliver and no reap,
`--no-burn` to run no buyback and no burn, `--no-graduate` to send no graduate, or `--no-mint` to send no `mint_for`.

Against the local validator the probe wallet is airdropped automatically. Against mainnet you fund it by hand
(see below).

## Settings (watcher/.env)

| Setting | Default | What |
|---|---|---|
| `RPC_URL` | the cluster's public endpoint | Solana RPC. Use a paid one on mainnet. |
| `CLUSTER` | `localnet` | `localnet`, `devnet` or `mainnet`. |
| `INTERVAL_SECONDS` | `60` | Seconds between two pool passes. Minimum 5. |
| `REVEAL_INTERVAL_SECONDS` | `20` | Seconds between two reveal crank passes, independent of the pool pass. 5 to 60: it must stay well under the 3.5 minute reveal window. |
| `SETTLE_INTERVAL_SECONDS` | `10` | Seconds between two settle crank passes, independent of the other clocks. 5 to 3600. Its tickets come from the ticket index, by address: no read of the whole program. With the feed on, a pass reads only the tickets of the wallets the feed saw trade or earn pieces in the last five minutes. |
| `SETTLE_SWEEP_SECONDS` | `300` | How often the settle crank reads every indexed ticket (a plain transfer of coins shows in no pool transaction: it is settled within this). 10 to 86400. With the feed off every pass reads every ticket. |
| `UPKEEP_INTERVAL_SECONDS` | `10` | Seconds between two upkeep crank passes (pegged coins: deliver moved pieces, burn burned ones), independent of the other clocks. 5 to 3600. Short on purpose: a holder looks at its wallet right after a transfer. |
| `BURN_KEEPER` | `on` | `on` or `off`: the burn keeper of buyback pools and rules pools. `--no-burn` turns it off too. |
| `BURN_INTERVAL_SECONDS` | `30` | Seconds between two passes of the burn keeper, independent of the other clocks. 5 to 3600. The chain takes a call on a pool at most once every 25 slots, about ten seconds. |
| `BURN_MAX_CALLS` | `10` | The most calls one burn pass sends, one per pool. 1 to 100. |
| `BURN_MIN_POT_LAMPORTS` | `100000` | A pot under this is left alone (0.0001 SOL): a call costs the keeper 5,000 lamports and earns it nothing. |
| `HOLDER_SYNC` | `on` | `on` or `off`: the holder sync of strict coins, in the burn keeper's pass. Off whenever the burn keeper is off. |
| `HOLDER_SYNC_MIN_BPS` | `10` | A holder record is synced when it stands above its wallet's coins by at least this share of all the coins in holder records, in basis points. 0 to 10000. |
| `BURN_SLIPPAGE_BPS` | `100` | How far under the SDK's quote a buy of the keeper may land before the chain refuses it, in basis points. 0 to 5000. |
| `GRADUATE_KEEPER` | `on` | `on` or `off`: the graduate crank of pools on the curve. `--no-graduate` turns it off too. |
| `GRADUATE_INTERVAL_SECONDS` | `15` | Seconds between two passes of the graduate crank, independent of the other clocks. 5 to 3600. |
| `MINT_CRANK` | `on` | `on` or `off`: the mint crank of collectible coins, which mints the pieces of a buy that paid a deposit into the buyer's wallet. `--no-mint` turns it off too. |
| `MINT_INTERVAL_SECONDS` | `60` | Seconds between two passes of the mint crank's own poll, independent of the other clocks. 1 to 3600. The buys reach the crank from the feed and from `POST /notify`; the poll (one `getSignaturesForAddress`) is the safety net. Every half second while a wallet waits for its block. |
| `MINT_SWEEP_SECONDS` | `300` | The indexed tickets are read this often (by address), to find a deposit the feed, the page and the poll missed. 30 to 86400. |
| `NOTIFY` | `on` | `on` or `off`: `POST /notify`, the coin page's word that a deposit buy landed. Off whenever the mint crank is off. |
| `NOTIFY_PER_MINUTE` | `3` | Signatures one address may hand in a minute; more answer 429. 1 to 600. |
| `NOTIFY_GLOBAL_PER_MINUTE` | `30` | Signatures everybody together may hand in a minute; more answer 429. 1 to 6000. |
| `TICKET_INDEX_FILE` | `tickets.json` next to `STATE_FILE` | Where the ticket index lives. |
| `TICKET_RECONCILE_SECONDS` | `3600` | How often the whole collectible program is listed again (addresses only) to find tickets the feed did not see; also at every start. 600 to 86400. |
| `MINT_PRIORITY_MICROLAMPORTS` | `0` | A priority fee for the keeper's mints, in micro-lamports a compute unit. 0 to 20000: a mint asks for 250,000 units and the fee is charged on that limit; above 20,000 the fee of a mint would pass what the deposit pays the keeper. |
| `KEEPER_MIN_LAMPORTS` | `10000000` | Danger alert when the keeper wallet holds less (0.01 SOL, 2,000 keeper transactions). Covers every crank. Not on localnet. The balance is read at most once a minute, and again after a crank sent a transaction. |
| `FEED` | `on` | `on` or `off`: the trades feed and market.json. `--no-feed` turns it off too, and so does `--pool`. |
| `FEED_INTERVAL_SECONDS` | `10` | Seconds between two feed passes. 2 to 3600. A trade shows in the feeds within about this long. |
| `FEED_MAX_TX_PER_PASS` | `200` | The most transactions one feed pass reads; the rest waits for the next pass, which starts at once. 10 to 5000. |
| `MARKET_REFRESH_SECONDS` | `1800` | Every pool is read in one `getProgramAccounts` this often (the reconciliation; the pools that trade are read by address every pass), and so are the creator locks of rules coins. 30 to 86400. |
| `MINT_REFRESH_SECONDS` | `600` | Every coin's mint (its supply) is read again this often. 30 to 86400. |
| `METADATA_REFRESH_SECONDS` | `21600` | Every coin's name, symbol and uri are read again this often. 300 to 2592000. |
| `METADATA_TIMEOUT_MS` | `3000` | How long the read of one coin's metadata JSON may take. 500 to 20000. |
| `MARKET_FILE`, `TRADES_DIR` | `status/market.json`, `status/trades` | Where the two feeds are written. |
| `FEED_STATE_FILE`, `MARKET_CACHE_FILE` | `state/feed.json`, `state/market-cache.json` | The feed's memory and the coins' cache. |
| `LOCK_DIR` | empty: next to `FEED_STATE_FILE` | Where the feed's lock lives. On a server with the systemd unit: `/run/programmable-watcher`, the service's runtime folder, which a reboot empties (see "One feed per state file"). |
| `SIM_MAX_AGE_MINUTES` | `60` | A pool with a hook is simulated at least this often, and at once when anything its simulations depend on changed. 1 to 1440. |
| `APPROVAL_WATCH` | `on` | `on` or `off`: the approved-list rule and list followed each pass, and `hookApproval` on every pool. No call of its own. |
| `HOOK_ACCOUNTS_WATCH` | `on` | `on` or `off`: the manifest and the extra-accounts list of every hook program hashed each pass, an alert on a change, `hookAccountsChangedAtSlot` on pools with a hook. No call of its own. |
| `HOLDER_SIMS` | `30` | The most sells as recent buyers one pool pass simulates, in all pools together. `0` or `off` turns the check off. 0 to 1000. |
| `HOLDER_SIMS_PER_POOL` | `3` | The most wallets that bought lately one pool's check sells as. 1 to 10. |
| `PROBE_SOL` | `0.05` | Size of the simulated buy, in SOL. |
| `PROBE_KEYPAIR` | `state/probe-keypair.json` | Keypair of the probe wallet, which is also the keeper that signs and pays the reveals, the settles, the deliveries, the burns of pieces, the buybacks and the burns of coins and the graduations, and receives the rent of the pieces it burns. |
| `PORT` | `8790` | HTTP port. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | empty | Telegram alerts. Empty means the log only. |
| `ALERT_COOLDOWN_SECONDS` | `3600` | The same alert is not repeated within this many seconds. |

Command line: `--once`, `--pool <address>`, `--no-crank`, `--no-settle`, `--no-upkeep`, `--no-burn`,
`--no-graduate`, `--no-mint`, `--no-feed`, `--no-server`, `-v`. `--once` runs one feed pass first, then the cranks and the
pool pass.

## HTTP

- `GET /pools.json`: the status file, `Access-Control-Allow-Origin: *`.
- `GET /market.json` and `GET /trades/<pool>.json`: the two feeds (below), `Access-Control-Allow-Origin: *`,
  `Cache-Control: public, max-age=5`, compressed with gzip for a reader that accepts it (a browser does:
  market.json is about 2.3 KB a pool, about a quarter of that compressed). 503 before the first feed pass, 404
  for a pool the feed does not know yet (or not backfilled yet), 400 for anything but an address, and 404 for both
  when the feed is off. Behind HTTPS on a server: see "HTTPS on a server" above.
- `GET /health`: 200 with `updatedAt`, the pool count, `lastCrankAt` and `lastCrankRevealed` (tickets revealed
  by the last crank pass). 503 when the last pool pass is more than five intervals old, when a crank is
  on and has not completed a run for three of its intervals, or when the feed was asked for and another running
  watcher held its lock at the start (`feedLocked`).
  The settle crank adds: `settleEnabled`, `settleStale`, `lastSettleAt`, `lastSettleSent` (settles confirmed
  by the last pass), and the totals `settlesSent`, `settlesFailed`, `piecesDropped`, `piecesBurned`,
  `rentReceivedLamports` and `settleFeesLamports`. The totals count from the moment `state/state.json` was
  last cleared, and survive a restart.
  The upkeep crank adds: `upkeepEnabled`, `upkeepStale`, `lastUpkeepAt`, `lastUpkeepSent` (transactions
  confirmed by the last pass), and the totals `deliveriesSent` and `reapsSent` (confirmed transactions),
  `upkeepFailed`, `assetsDelivered`, `assetsBurned`, `upkeepRentReceivedLamports` and `upkeepFeesLamports`.
  Same rule: they count from the moment the state was last cleared, and survive a restart.
  The holder sync adds `holderSyncEnabled`, and the totals `holderSyncsSent` (confirmed transactions),
  `holderRecordsSynced`, `holderSyncFailed` and `holderSyncFeesLamports`.
  The burn keeper adds: `burnEnabled`, `burnStale`, `lastBurnAt`, `lastBurnSent` (calls confirmed by the last
  pass), and the totals `burnCalls` (confirmed calls), `burnFailed`, `burnObserved`, `burnWaited` and
  `burnBought` (the confirmed calls by what the chain reported), `burnSpentLamports` (what the buys spent out
  of the pots) and `burnFeesLamports` (what the keeper paid to send the calls). Same rule again.
  The graduate crank adds: `graduateEnabled`, `graduateStale`, `lastGraduateAt`, `lastGraduateSent` (calls
  confirmed by the last pass), and the totals `graduatesSent` (confirmed calls), `graduatesFailed`,
  `coinsGraduated` (calls that graduated a coin), `graduatesAlready` (calls that found the pool graduated and
  changed nothing) and `graduateFeesLamports`. Same rule again.
  The mint crank adds: `mintCrankEnabled`, `mintCrankStale` (no pass for three intervals or 60 seconds,
  whichever is longer), `lastMintAt`, `lastMintSent` (mints confirmed by the last pass), `mintWatching` (wallets
  it waits on now), and the totals `mintsSent` (confirmed `mint_for` transactions), `mintsFailed`,
  `piecesMintedForWallets`, `mintPaidBackLamports` (what the deposits paid the keeper), `mintFeesLamports`,
  `mintNetLamports` (the keeper's balance change over all its mints: at or above zero), `mintMintedFirst`
  (wallets that minted their pieces themselves first), `mintDepositShort` (deposits too small: nothing sent),
  `mintRefused` (simulations that refused a mint: nothing sent) and `mintLastSlotsAfterBuy`. Same rule again.
  The feed adds: `feedEnabled`, `feedStale`, `lastFeedAt`, `feedSlot`, `feedLagSlots`, `feedPools`,
  `feedTransactions`, `feedUnreadable`, `marketUpdatedAt` and `marketPools` (see "The trades feed and
  market.json"), `feedLocked`, `feedLockedBy` and `feedLockedSince` (the feed was asked for and another running
  watcher held its lock at the start: this one serves no market.json, and `ok` is false while it runs that way),
  and for the one list of pools `poolsReadAt`, `poolsFullReadAt`, `poolsReadOwed`, `poolsFullReadFailures`,
  `poolsFullReadFailedSince`, `poolsPatched`, `poolsFullReads`.
  The reads add, per crank (settle, upkeep, burn, holderSync, reveal): `<crank>UnreadStreak`, `last<Crank>ReadAt`
  and `<crank>ReadStale`, and `readStale` for all of them (503 when true; see "When a read fails").
  The ticket index adds `ticketIndexSize`, `ticketIndexReconciledAt`, `ticketIndexReconcileFailures`,
  `ticketIndexReconcileFailedSince`, `ticketIndexEmptied` (tickets that left the index empty, which the listing
  leaves out for six hours) and `ticketIndexHot` (wallets that traded or earned pieces in the last five minutes);
  the notify route `notifyEnabled`, `notifyAccepted`, `notifyRefused`, `notifyStatusCalls` (the
  getSignatureStatuses calls it cost), `notifyUnknown` (signatures the chain did not know, dropped with no other
  call), `notifyTransactionsRead` and `notifyBuysFound`; and the mint crank `mintHanded` (wallets handed in by the
  feed and by `/notify`).
- `POST /notify`: the coin page's word that a buy with a deposit landed, so that the keeper mints right after the
  buy's block. Body: `{"signature": "<base58>"}` (or the signature alone as text; the page sends plain text, so a
  browser makes no preflight request). Answers 202 `{"accepted": true}` when the signature waits for the crank's
  next look, 200 `{"accepted": false, "reason": ...}` when it knows it already (or it is the watcher's own, or 256
  wait already), 400 for anything that is not a signature of 64 bytes, 413 for a body over 1 KB, 429 over
  `NOTIFY_PER_MINUTE` from one address or `NOTIFY_GLOBAL_PER_MINUTE` from everybody, 404 when the mint crank or
  `NOTIFY` is off. Behind a proxy on this machine (the socket is the loopback) the address is the last
  `X-Forwarded-For` entry that is not a private network address, the one the proxy added; the entries before it are
  the caller's to write and never pick the bucket. Nothing of the body is trusted: the signature's status is asked
  first (one `getSignatureStatuses` for every signature waiting, at most once a second), one the chain does not
  know is dropped with no other call, and a known one's transaction is read (at most twice), must be one of the
  pool program with a `PiecesEarned` the collectible program logged, and the ticket is read before any mint. Only
  then is the mint loop woken. A notification never makes the watcher read every ticket. On the server the site
  reaches it through the same proxy path as the feeds (`/watcher/notify`).

## Status schema

```
{ "updatedAt": iso, "cluster": "localnet"|"devnet"|"mainnet",
  "platform": { "paused": bool, "whitelist": [str], "protocolFeeBps": n, "maxHookFeeBps": n, "maxFeeOverrideBps": n,
                "treasury": str, "admin": str, "changes": [{"time", "field", "from", "to"}] },
  "pools": { "<pool>": {
      "lastCheck": iso, "score": "clean"|"warning"|"danger",
      "hookKind": "none"|"frozen"|"platform", "template": "tax"|"launch_guard"|"buyback"|"collectible"|"rules"|"custom"|"none",
      "buySim":  { "ok": bool, "error": str|null, "amountOut": str|null },
      "sellSim": { "ok": bool, "error": str|null, "amountOut": str|null, "holder": str|null },
      "effectiveBuyTaxBps": n|null, "effectiveSellTaxBps": n|null, "declared": object|null,
      "configChanges": [{"time", "slot", "field", "from", "to"}],
      "alerts": [{"time", "level": "info"|"warning"|"danger", "message"}],
      "notes": [str],
      "tickets": { "open": n, "undecided": n, "awaitingReveal": n, "expired": n },   (collectible pools only)
      "coin": { "kind": "plain"|"pegged"|"mismatch"|"unknown", "tokenProgram": "spl-token"|"token-2022"|"unknown",
                "transferHookProgram": str|null, "transferHookAuthority": str|null },  (collectible pools only)
      "burn": { "pot": str, "capBps": n, "step": "nothing"|"observe"|"tooSoon"|"wait"|"buy",
                "observedAtSlot": n|null, "nextCallAtSlot": n|null,
                "keeper": { "calls": n, "bought": n, "spentLamports": n, "lastAt": iso|null,
                            "lastOutcome": "observed"|"waited"|"bought"|"failed"|null } },  (buyback and rules pools only)
      "curve": { "state": "open"|"graduated", "virtualQuote": str, "raised": str, "target": str,
                 "raisedBps": n, "soldBps": n|null, "graduationFeeBps": n, "graduates": bool },  (pools on the curve only)
      "hookApproval": "own"|"approved"|"not approved",                   (every pool, with APPROVAL_WATCH on)
      "hookAccountsChangedAtSlot": n|null,                    (pools with a hook, with HOOK_ACCOUNTS_WATCH on)
      "holderSellFails": null | { "at": iso, "tried": n, "failed": n,
                                  "wallets": [{ "wallet": str, "error": str }] }
                                        (pools whose hook runs on sells, with HOLDER_SIMS above 0)
  } },
  "mintCrank": { "enabled": bool, "intervalSeconds": n, "lastAt": iso|null, "watching": n, "sent": n, "failed": n,
                 "pieces": n, "paidLamports": n, "feeLamports": n, "netLamports": n, "mintedFirst": n, "short": n,
                 "refused": n, "lastSlotsAfterBuy": n|null },
  "approvedList": { "required": bool, "programs": [str], "corrupt": bool } }   (with APPROVAL_WATCH on)
```

`hookApproval` says where the pool's hook stands with the platform's approved list (step 5 of "What it checks"):
`own` for no hook or one of the platform's own, `approved` for an outside hook on the list, `not approved` for an
outside hook that is not on it (or any outside hook while the list cannot be read). `approvedList` is the rule and
the list as the platform account holds them; while `corrupt` is true, `programs` is the last list that could be
read. `hookAccountsChangedAtSlot` is the slot of the last pass that saw the hook's manifest or extra-accounts list
change (step 6), null while none did. `holderSellFails` is null while the last check of the sells as recent buyers
found no refusal by the hook (or none ran yet), and otherwise that check: when it ran, how many wallets it sold as,
how many the hook refused, and those wallets with the hook's error in words (step 7). A pool's notes say the counts
of the last check either way.

`mintCrank` says whether this watcher mints the pieces of buys that paid a deposit, and what it has done: the
same numbers as `/health` (above), as they stood at the pool pass. A collectible pool's notes say it too: "A buy
can pay a deposit for its NFTs in the same transaction. This watcher then mints them into the buyer's wallet a
few seconds after the buy, paid back from that deposit."

`curve` is on the entry of every pool that launched on the curve, open or graduated, and on no other: a seeded
pool's entry has no `curve`. Its fields are the ones the trade API's quote carries, as the pool stands at the
check. `virtualQuote` is the virtual SOL counted in the price, in lamports (`"0"` once graduated). `raised` is the
real SOL in the pool, in lamports. `target` is the real SOL it graduates at (`"0"` once graduated). `raisedBps` is
`raised` over `target`, at most 10000, and 10000 once graduated. `soldBps` is the share of the coin's supply out
of the pool (null when the mint could not be read). `graduationFeeBps` is the share of the target the platform
takes at graduation, kept as a record after it. `graduates` is true while the pool stands at or past its target
and waits for `graduate`: the graduate crank sends it. An example, an open pool with 2.1 SOL raised:

```
"curve": { "state": "open", "virtualQuote": "30000000000", "raised": "2105531268", "target": "85000000000",
           "raisedBps": 247, "soldBps": 628, "graduationFeeBps": 0, "graduates": false }
```

`burn.pot` is what a call may spend from, in lamports: the buyback treasury once it holds the coin's minimum, or
the burn pot of a rules coin with the fee of the last trade counted in. `capBps` is the most one buy spends, in
basis points of the pool's SOL. `step` is what a call sent at the time of the check would do. `keeper` is this
watcher's own work on the pool since its state was last cleared.

`error` strings start with `setup:` when the probe itself could not be set up (no SOL, not an ATA, platform
paused, no holder found to sell as) and with `swap:` when the pool refused the trade. Only `swap:` failures count
against a hook.

The site prints `buySim.error`, `sellSim.error`, the alerts' `message` and the `notes` as they stand. So they are
words only (lib/plain.mjs, applied in lib/status.mjs): a chain error by its name (`setup: InsufficientFundsForRent
(account_index 2)`, never its JSON), an RPC's refusal in words (`the RPC refused the call (403 Forbidden): ...`,
never the JSON answer), and an address by its host only, never the path or the query where a paid RPC keeps its
key. The log keeps the RPC's own words; the RPC address in the log is its host only too.

For a collectible pool `declared` holds `name`, `unit`, `maxSupply`, `minted` (pieces ever minted), `live`
(pieces that exist now, after burns), `reservedPending`, `maxPerBuy`, `artVersion`, `owner`, `locked` and
`pegged` (what the collection config says; `coin.kind` is what the mint says).

For a buyback pool `declared` holds `buyBps`, `sellBps`, `minQuote`, `treasury`, `creator`, the counters
`totalQuoteSpent`, `totalBaseBurned` and `buybacks` (buybacks that bought), and the observation `obsSlot`,
`obsReserveBase`, `obsReserveQuote` (zero reserves: the pool was never recorded).

For a rules pool `declared` holds the rules: `buy` and `sell` (each `creatorBps`, `holdersBps`, `burnBps`),
`sniperSlots`, `sniperStartFeeBps`, `maxBuyQuote`, `limitSlots`, `creatorLockSeconds`, `creator`, `treasury`,
`startSlot`, `startTime`, `minEligible`. It says where the windows stand: `sniperActive`, `currentBuyFeeBps`,
`sniperEndsAtSlot`, `buyLimitActive`, `buyLimitEndsAtSlot`. And it holds the running numbers as the account
stores them, which is one trade behind: `totalStaked`, `stakersEligible`, `creatorOwed`, `burnPot`,
`rewardsOwedTotal`, `totalCreatorPaid`, `totalRewardsPaid`, `totalQuoteBurned`, `totalBaseBurned`, `burns`,
`obsSlot`, `obsReserveBase`, `obsReserveQuote`. `creatorLockSeconds` is what the launcher declared, not what
is locked: the lock is its own account, which the watcher does not read. `kind` is `plain` or `strict`, and
`strict` is null on a plain coin. On a strict coin it holds the strict numbers (`maxWalletBps`,
`maxWalletSlots`, `maxWalletAmount` in raw units, `earlySlots`, `earlyUnlockSlots`), the first slot after each
window (`maxWalletEndsAtSlot`, `earlyEndsAtSlot`, `earlyUnlockSlot`; null for a rule that is off), whether each
runs at the time of the check (`maxWalletActive`, `earlyActive`, `earlyLockActive`), and what the holder
records count against what the holders' share needs (`registered`, `minRegistered`).

## The two feeds

Every amount is a string of digits in raw units (lamports, raw coin units), as the SDK's bigint: revive it with
`BigInt(s)`. Every address is a base58 string: `new PublicKey(s)`. Numbers the SDK keeps as numbers (bps, decimals,
flags, direction) stay numbers. `...At` fields are ISO times; `blockTime`, `createdTime`, `lastTradeTime` and
`unixTime` are Unix seconds. A field that is not known is `null`; no field is ever left out.

`GET /market.json`:

```
{ "version": 1, "cluster": "localnet"|"devnet"|"mainnet",
  "updatedAt": iso, "slot": n,             (when and at which slot the pools were read)
  "checkedAt": iso, "checkedSlot": n,      (the last feed pass that confirmed nothing changed since)
  "pools": [ {                             (newest first: createdSlot descending, then address)
      "address": str, "account": str,      (base64 of the pool account as read: H.decodePool gives every field)
      "baseMint": str, "quoteMint": str, "lpMint": str, "baseTokenProgram": str, "creator": str, "lpFeeBps": n,
      "hasHook": bool, "hookProgram": str, "hookKind": "none"|"frozen"|"platform", "hookFlags": n,
      "template": "rules"|"tax"|"launch_guard"|"buyback"|"collectible"|"custom"|"none", "pegged": bool,
      "reserveBase": str, "reserveQuote": str, "virtualQuote": str, "volumeQuoteTotal": str, "hookFeesQuoteTotal": str,
      "swapCount": str, "createdSlot": str, "createdTime": n|null, "lastTradeTime": n|null,
      "curveState": "none"|"open"|"graduated", "graduationTarget": str, "graduationFeeBps": n,
      "curve": null | { the `curve` of pools.json },
      "price": str,                        (SOL per whole coin, 9 significant digits, cut: the trade API's priceBefore)
      "marketCap": str,                    (lamports: (reserveQuote + virtualQuote) * supply / reserveBase, rounded down)
      "coin": { "mint": str, "name": str, "symbol": str, "uri": str, "image": str|null, "description": str|null,
                "links": { "website": str|null, "twitter": str|null, "telegram": str|null },
                "metadataJson": "ok"|"unreachable"|"invalid"|"none"|"pending",
                "decimals": n|null, "supply": str|null, "tokenProgram": str|null, "mintAuthority": str|null, "freezeAuthority": str|null },
      "rules": null | { "config": str (base64 of the rules config; use its fixed part), "strict": bool,
                        "lockAmount": str, "lockUnlockAt": str, "readAt": iso, "slot": n, "unixTime": n } } ] }
```

`GET /trades/<pool>.json`:

```
{ "version": 1, "pool": str, "updatedAt": iso, "slot": n,
  "backfill": { "transactions": n, "reachedCreation": bool },
  "curve": { "opened": event|null, "graduated": event|null },
  "events": [ event, ... ] }               (newest first, at most 300)
```

An event is the SDK's decoded event with `signature` and `blockTime` added, its own `slot` that of its transaction:

```
Swapped:     kind, signature, blockTime, pool, user, direction, amountIn, amountOut, protocolFee, hookFee, lpFee,
             feeBpsApplied, reserveBase, reserveQuote, slot, byHook
CurveOpened: kind, signature, blockTime, pool, virtualQuote, graduationTarget, graduationFeeBps, slot
Graduated:   kind, signature, blockTime, pool, reserveQuoteBefore, reserveQuoteAfter, reserveBaseBefore,
             reserveBaseAfter, burnedBase, feeQuote, slot
```

The order is the newest transaction first, and the events of one transaction in the order the SDK decodes them:
`client.allEvents(pool, n)` filtered to the three kinds and to the pool gives the same list. `backfill.reachedCreation`
is false when the backfill stopped at 200 transactions, or when the RPC kept no history that far back.

## What it costs in RPC calls

A paid RPC plan counts request units: Chainstack's Growth plan gives 20 million a month (about 463 a minute), one
unit a call, two for an archive call (getTransaction, getSignaturesForAddress), at most 250 requests a second. The
watcher's cost, measured on the local validator through a counting proxy (`web/review/rpc-count.mjs`), a month
counted as 43,200 minutes:

| | Calls a minute | Units a minute | Units a month | Share of 20M |
|---|---|---|---|---|
| Before this round: 38 pools (9 with a hook), every crank on, idle | 146 | 146 | 6.3 million | 32% |
| Before this round: 101 pools (51 with a hook), cranks off, idle | 432 | 432 | 18.7 million | 93% |
| Now: 39 pools (9 with a hook), every crank on, idle | 19 to 20 | 25 to 26 | 1.1 million | 5.6% |
| Now: 99 pools (51 with a hook), cranks off, idle | 27 to 40 | 33 to 47 | 1.4 to 2.0 million | 7 to 10% |
| Now: 99 pools, cranks off, 10 trades a minute on two pools (one with a tax hook) | 57 to 75 | 73 to 91 | | |

The cranks' reads the second chain adds, with collectible and pegged pools on it: the settle crank 9 calls a
minute, the upkeep crank 6 getSignaturesForAddress (12 units) while nothing moves, the reveal crank none while no
piece waits, the holder sync 2: about 17 calls and 23 units a minute more, whatever the number of pools.

Where the idle minute of the first chain goes now: the feed 12 calls (6 getSlot, 6 getSignaturesForAddress: 18
units), the pool pass 4 (the platform, the hooks, the coins, the buyback treasuries), the holder sync 2, the
keeper's balance 1, the platform for the burn keeper 1. On the second chain the pool pass also reads the tickets
(2 calls) and simulates the few pools inside a launch window every pass. Before, every pass simulated every pool
with a hook (about eight calls each), and every crank read the whole pool program itself, every pass.

What trading adds: one getTransaction (2 units) per transaction of the pool program, one getProgramAccounts and
one read of the changed coins' mints per feed pass that saw any, the simulations of a pool with a hook that traded
(about ten calls, once a pass at most), and what the cranks send. So the cost follows the trades, not the coins:
1,000 idle coins cost about what 40 do, plus one call per hundred accounts in the batched reads.

What a crank costs a pass, idle: reveal 2 calls with collectible pools, else none; settle 3 with collectible
pools, else none; upkeep 3 with pegged pools, else none; burn 1 (the holder sync, with strict coins) and none more
while no pot changed; graduate none until a pool is due. None of them grows with the number of idle pools, except
by one call per hundred accounts.

The site's own cost, and what it saves by reading these feeds, is measured with the same proxy (`?rpc=` on
localnet). The first backfill of a chain with many coins reads up to 200 transactions per pool, once.

### Round 10: no routine getProgramAccounts

The shared node of the paid plan aborts `getProgramAccounts` under load ("scan aborted: scan abandoned after
waiting ... for a scan slot"), several times a day. This round took that call out of every routine pass: the
pools are patched by address (feed step 4), the tickets come from the ticket index, and the whole program is read
only as a reconciliation (every pool every 30 minutes, the tickets' addresses every hour and at the start). The
holder sync's read of a strict pool's records is the one `getProgramAccounts` left in a pass, at most every ten
minutes per pool and only when its supply moved, with a pause after a failure. Measured on the local validator
through the counting proxy, the same chain state back to back, 55 pools (39 with a hook: 11 collectible, 5 of
them pegged, 15 on the launch rules template, 3 of them strict), every crank on, the live settings of 2026-10-23,
idle (nothing to send), five minutes each:

| | Calls a minute | Units a minute | getProgramAccounts | getSlot | getSignaturesForAddress | getMultipleAccounts |
|---|---|---|---|---|---|---|
| Before this round (settle every 30 s, mint poll every 10 s, every pool every 15 minutes) | 48 | 62 | 5.2 | 7 | 14 | 15 |
| Now (settle every 10 s, mint poll every 60 s, every pool every 30 minutes, tickets listed every hour) | 44 | 55.4 | 0 | 0 | 11.4 | 25.6 |

Where the minute goes now: the feed 6 `getSignaturesForAddress` (12 units) and nothing else while nothing trades;
the settle crank 6 passes of 3 `getMultipleAccountsInfo` (the indexed tickets, the configs, the holders' coins:
the price of settling within 10 seconds, 18 of the 25.6); the reveal crank its ticket read when the settle's is
older than 3 seconds; the upkeep crank, with pegged pools, 6 `getSignaturesForAddress` for the collectible
program's newest signature (the mint poll's own look is too old for it at 60 s) and its reads when that moved;
the mint crank 1; the holder sync 2 batched reads; the pool pass 4 to 6. What a trade adds: one
`getTransaction` (2 units), one `getMultipleAccountsInfo` for the pools it touched, the coins' supplies, and the
simulations of a hooked pool that changed. A buy with a deposit reaches the mint crank at no cost (the feed, or
the coin page's `POST /notify`, which costs the one `getTransaction` it reads) and is minted for about ten calls,
as before: measured 10 slots after the buy through the feed (3.5 s after it confirmed, with the feed every 10 s)
and 5 slots after the buy through `/notify`.

### Round 13: what a flood of /notify and a growing index cost

`POST /notify` used to read every signature handed in up to five times and then sweep every indexed ticket. A
flood of made-up signatures, measured on the local validator through the counting proxy (a watcher with the mint
and reveal cranks, the feed off; 121 signatures in one minute from twelve addresses):

| | Accepted | Units in the 2.2 minutes | Transactions read | Ticket reads (sweeps) | Units per signature |
|---|---|---|---|---|---|
| Before (round 12) | 121 | 993 | 622 | 121 | 7.6 |
| Now, with the old limits (10 a minute per address, 120 in all) | 121 | 69 | 0 | 0 | 0.5 |
| Now, with the new limits (3 and 30) | 34 (87 answered 429) | 25 | 0 | 0 | 0.5 |

Now every look at the waiting signatures is one `getSignatureStatuses` (at most one a second), a signature of
nothing is dropped after it, and nothing wakes the mint loop. The same watcher idle, the minute before: 2 calls (it
was 32 before). A real buy through the coin page: one status call, one transaction read, minted 5 slots after the
buy.

The ticket index over three simulated hours (the program never closes a ticket, so the hourly listing finds every
ticket ever opened; T of them empty, H holding pieces), with the settle crank's hot wallets and five-minute sweep,
the pool pass taking a read up to five minutes old, and the memory of tickets read empty:

| Tickets (T empty, H holding) | Reads by address a day, before | now | Coin reads of the settle crank a day, before | now | MB written a day, before | now |
|---|---|---|---|---|---|---|
| 2,000 and 200 | 22,176 | 1,632 | 17,280 | 576 | 33 | 11 |
| 20,000 and 1,000 | 118,080 | 10,560 | 86,400 | 2,880 | 305 | 105 |
| 100,000 and 3,000 | 383,040 | 41,280 | 259,200 | 8,640 | 1,480 | 512 |

### Reviewed hooks: what the three new checks cost

The approved list and the hook accounts cost no call: the pass reads the platform account and every hook's
manifest and extra-accounts list anyway. The sells as recent buyers run only for a pool whose hook runs on sells,
only when its simulations are due (a trade, a change, a launch window, or once an hour) and only when the sell probe
went through: one batched read of the recent buyers' token accounts (with the clock and their holder records on a
strict coin), then per wallet the SDK's read of the wallet's accounts as it builds the swap (one
`getMultipleAccountsInfo`), the reads it needs to resolve the hook's extra accounts (none for a list of fixed
addresses or seeds) and one `simulateTransaction` (no `getLatestBlockhash`: the RPC replaces the blockhash). With the
defaults that is about 1 + 2 x 3 = 7 calls more per due pool, and at most 30 simulations a pass in all
(`HOLDER_SIMS`). Measured on the local validator through a counting connection: one pool of the kit's hook with three
recent buyers, 4 `getMultipleAccountsInfo` and 3 `simulateTransaction` in the pass that simulated it, nothing in the
passes that kept its simulations.

## Telegram

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`. One message per alert, plain text, with the coin
symbol, the pool address and a solscan link. The same pool and text is not repeated within
`ALERT_COOLDOWN_SECONDS` (default 3600). Without a token, alerts go to the log only.

## Putting it on a DigitalOcean droplet

Written to be copied one line at a time. The only places where you type something of your own are marked
`YOUR_SERVER_IP` (the droplet's address) and the two Telegram values inside `.env`.

### 1. The droplet

Create a droplet: Ubuntu 24.04 LTS, the smallest Basic plan (1 vCPU, 1 GB) is enough, region Frankfurt or
Amsterdam. Add your SSH key or take the root password they email you. Write down its IP.

### 2. First login and basic safety

From your PC:

```
ssh root@YOUR_SERVER_IP
```

On the server, one line at a time:

```
apt update
```
```
apt -y upgrade
```
```
apt -y install curl git ufw unattended-upgrades
```
```
ufw allow OpenSSH
```
```
ufw allow 8790/tcp
```
```
ufw --force enable
```
```
adduser --disabled-password --gecos "" programmable
```

Port 8790 is the status endpoint the website reads. If you put nginx with HTTPS in front of it later, close
8790 again with `ufw delete allow 8790/tcp`.

### 3. Node 22

```
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
```
```
apt -y install nodejs
```
```
node -v
```

It must print something starting with `v22`.

### 4. The code

The watcher needs the repo folders `watcher/`, `sdk/dist/` and the root `node_modules`. Pack them on your PC,
WITHOUT any `.env` or state. In PowerShell on your PC, one line at a time:

```
cd "the folder that holds sol-hooks"
```
```
tar -czf "$env:USERPROFILE\programmable-watcher.tgz" --exclude=".env" --exclude="watcher/state" --exclude="watcher/status" --exclude="sdk/node_modules" sol-hooks/watcher sol-hooks/sdk/dist sol-hooks/sdk/package.json sol-hooks/package.json sol-hooks/package-lock.json
```
```
scp "$env:USERPROFILE\programmable-watcher.tgz" root@YOUR_SERVER_IP:/home/programmable/
```

Back on the server:

```
cd /home/programmable && tar -xzf programmable-watcher.tgz && rm programmable-watcher.tgz
```
```
cd /home/programmable/sol-hooks && sudo -u programmable npm install --omit=dev --ignore-scripts --workspaces=false
```
```
chown -R programmable:programmable /home/programmable/sol-hooks
```

`npm install` fetches `@solana/web3.js`, the only dependency.

### 5. Configuration

```
cd /home/programmable/sol-hooks/watcher
```
```
sudo -u programmable cp .env.example .env
```
```
nano .env
```

Set these lines (everything else can stay as it is):

```
RPC_URL=https://api.mainnet-beta.solana.com
CLUSTER=mainnet
TELEGRAM_BOT_TOKEN=     <- your bot token, from @BotFather
TELEGRAM_CHAT_ID=       <- your chat id
```

A paid RPC is strongly recommended on mainnet: the public endpoint rate limits simulations. Save with Ctrl+O,
Enter, then Ctrl+X.

### 6. The probe wallet

The first run creates `state/probe-keypair.json` and prints its address:

```
sudo -u programmable node index.mjs --once
```

The pass will say the probe wallet is not funded. Send about 0.1 SOL to the address it printed. Then run the
line above again: the table should now show `ok` in the BUY column.

This wallet is also the keeper that reveals collectible tickets, settles the wallets above the peg, for
pegged coins delivers moved pieces and burns burned ones, and runs the buybacks and burns of buyback and rules
pools. The simulated trades never spend its SOL; each keeper transaction costs 5,000 lamports (0.000005 SOL),
so 0.1 SOL covers the buy probe and about 8,000 of them. A settle or a burn of a piece pays the rent of what
it burns to this wallet (0.0012 to 0.0014 SOL a piece), so those two cranks pay for themselves and for the
deliveries; the wallet still needs this small balance to start. The burn keeper earns nothing back: at the
default settings it costs at most 0.0144 SOL a day for each buyback or rules pool that always has something to
spend, and nothing for a pool whose pot is empty. On mainnet nobody tops the wallet up but you: the watcher
sends a danger alert when it holds less than `KEEPER_MIN_LAMPORTS` (0.01 SOL), and if it ever runs dry reveals
stop and pieces expire to the common tier, settles stop and unbacked pieces stay, deliveries stop and wallets
show stale pieces, buybacks and burns stop and the pots grow. The key in `state/probe-keypair.json` can only
spend that fee money; it has no power over anybody's funds.

### 7. As a service

```
cp /home/programmable/sol-hooks/watcher/programmable-watcher.service /etc/systemd/system/
```
```
systemctl daemon-reload
```
```
systemctl enable --now programmable-watcher
```
```
systemctl status programmable-watcher
```
```
curl -s http://127.0.0.1:8790/health
```

The last line must answer with `"ok":true` after the first pass (give it a minute).

### 8. Everyday commands

| I want to | Command |
|---|---|
| see the log live | `journalctl -u programmable-watcher -f` |
| see the last 100 lines | `journalctl -u programmable-watcher -n 100` |
| restart after changing `.env` | `systemctl restart programmable-watcher` |
| stop it | `systemctl stop programmable-watcher` |
| check one pool by hand | `cd /home/programmable/sol-hooks/watcher && sudo -u programmable node index.mjs --pool POOL_ADDRESS --once --no-server` |
| forget everything and start clean | `systemctl stop programmable-watcher && rm /home/programmable/sol-hooks/watcher/state/state.json && systemctl start programmable-watcher` |
| build the trades files again from the chain | the five lines of "Regenerating the trades files on a server" above |

### 9. Updating

Repeat step 4 (pack on the PC, copy, unpack), then:

```
systemctl restart programmable-watcher
```

The `.env`, the state and the probe keypair are not in the archive, so they survive the update.

#### Updating to the version with the ticket index (round 10)

This version adds one state file, `state/tickets.json`, and builds it by itself: at its first start the watcher
lists the collectible program once (one call, addresses only), and from then on the feed keeps the index fed.
Nothing has to be regenerated and the old state files stay as they are. On the server, as root, one line at a
time:

```
systemctl stop programmable-watcher
```

Unpack the new code (step 4), then put the settings of this version into `/home/programmable/sol-hooks/watcher/.env`
(the names; the values here are the ones the live watcher runs with):

```
SETTLE_INTERVAL_SECONDS=10
```
```
MINT_INTERVAL_SECONDS=60
```
```
MARKET_REFRESH_SECONDS=1800
```
```
TICKET_RECONCILE_SECONDS=3600
```
```
NOTIFY=on
```
```
NOTIFY_PER_MINUTE=10
```

Then start it and watch the first minute:

```
systemctl start programmable-watcher
```
```
journalctl -u programmable-watcher -n 60 --no-pager
```

The log says `ticket index   0 tickets, never listed; listing the collectible program now`, then
`tickets: the index holds N tickets after listing the collectible program`. After that
`curl -s http://127.0.0.1:8796/health` shows `ticketIndexSize` at N, `poolsFullReads` at 1 and `poolsPatched`
growing with the trades; `settleUnreadStreak`, `poolsReadOwed` and `readStale` stay at 0 and false. If the listing
fails at the start (the node aborted it), the log says so and names the next try; the cranks start with an empty
index, every new buy reaches them through the feed, and the listing is tried again by the pool pass. The folders
the service writes stay the same two: `/home/programmable/sol-hooks/watcher/state` (now with `tickets.json`) and
`/home/programmable/sol-hooks/watcher/status`; the unit file needs no change. The site's `/watcher/` proxy passes
`POST /watcher/notify` through as it passes the feeds; the coin page posts there after a deposit buy, and a 404
from an older watcher is harmless (the page ignores the answer).

#### Updating to the version with the lock in /run (round 13)

This version moves the feed's lock to the service's runtime folder, `/run/programmable-watcher`, which every reboot
empties, and the lock names the boot and the process's start besides its id: a lock left from before a reboot, or
under a process id the system gave to another program since, can no longer keep the feed off. The unit file gets
three lines (`RuntimeDirectory=programmable-watcher`, `RuntimeDirectoryMode=0755`, `RuntimeDirectoryPreserve=yes`),
so it is copied again. `POST /notify` costs one status call for what waits instead of a read per signature, and its
limits come down to 3 a minute per address and 30 in all. The settle crank reads the wallets that traded lately every
pass and every ticket every five minutes. `state/tickets.json` gains the tickets read empty (the listing leaves them
out for six hours) and is written at most once a minute. Nothing has to be regenerated: the ticket index and the
other state files are read as they are. On the server, as root, one line at a time:

```
systemctl stop programmable-watcher
```

Unpack the new code (step 4), then copy the unit file again and drop the old lock, which the new version no longer
looks at:

```
cp /home/programmable/sol-hooks/watcher/programmable-watcher.service /etc/systemd/system/
```
```
systemctl daemon-reload
```
```
rm -f /home/programmable/sol-hooks/watcher/state/feed.json.lock
```

Put the settings of this version into `/home/programmable/sol-hooks/watcher/.env` (the names; the values are the
defaults, so only `LOCK_DIR` is needed, the others are written out to be seen). `LOCK_DIR` belongs in `.env`, not
in the unit file: a run by hand reads the same `.env` and so finds the service's lock. Keep `NOTIFY=off` if the
live watcher runs that way now, and set it to `on` once this version runs:

```
LOCK_DIR=/run/programmable-watcher
```
```
NOTIFY_PER_MINUTE=3
```
```
NOTIFY_GLOBAL_PER_MINUTE=30
```
```
SETTLE_INTERVAL_SECONDS=10
```
```
SETTLE_SWEEP_SECONDS=300
```

Then start it and watch the first minute:

```
systemctl start programmable-watcher
```
```
journalctl -u programmable-watcher -n 60 --no-pager
```
```
ls -l /run/programmable-watcher
```

The log lists `lockDir        /run/programmable-watcher` among the settings and no line saying the feed is run by
another watcher; the folder holds one `feed-<id>.lock`. `curl -s http://127.0.0.1:8796/health` shows `ok` true,
`feedEnabled` true and `feedLocked` false, and, once `NOTIFY=on`, `notifyStatusCalls` growing by one per look at the
notified signatures, never by one per signature. `settle done` lines (with `-v`) say `tickets read: N recent` between
the sweeps and `tickets read: all` every five minutes.

## Tests

From the repo root:

```
node --test "watcher/test/*.test.mjs"
```

For the trades feed they cover an event as the file holds it, which events a transaction gives, the merge (newest
first, no doubles, the 300 cap, the pinned curve events), the paging until the cursor, the walk of a busy pass and
of a lagging RPC, a restart on the same files, the one backfill of a pool that existed before the feed (and none
for a pool born under it, and its 200 limit), and a gap. Then the answers of a batch paired by their own
signature on an RPC that answers in reverse or shuffled order (the reads alone, the feed, the backfill), a version
1 transaction (the batch read one at a time, the transaction skipped and counted, the cursor past it, in the feed
and in a backfill, across a restart; an error of the RPC itself still fails the pass), a transaction never
served (skipped after its passes), the doubles by signature, kind and index (two Swapped events of one
transaction kept, doubles in the incoming list and in an old file removed), a node behind the cursor (nothing
read twice, no false gap, a signature listed twice read once), the traders of a pool from its file, and the one
feed per state file. For the pool check on an RPC that refuses getTokenLargestAccounts with Chainstack's 403: the
buy simulated, the sell's holder found among the pool's traders, the call left alone for an hour, no holder in
words (and tried again while the feed has nothing), a network failure that is no refusal, a read that fails while
the sell is set up; on an RPC that lists the largest holders, the old way. And the errors in words: no JSON, no
RPC address with its key, the chain's errors by name, a sentence unchanged, pools.json carrying words only. For market.json: every field of an entry against the SDK's
own numbers, the order of the file, what a card takes from a metadata JSON, the addresses never fetched on a server,
the fetch with its timeout, size cap and redirects, the reads of a pass (a coin once, a changed pool's supply, every
mint on its clock, nothing when idle, the cache across a restart), a rules pool's config and lock, the retry of an
unreachable JSON, and the shared pool list. For the schedule: the key, every reason a pool is simulated again, the
windows, the kept simulations through the state file. Then the feed's settings, its fields in `/health`, and the two
routes over HTTP. The settle and upkeep tests read all pools at once and count the calls of a pass.
They cover the score rules, the config diffing fed with raw bytes, the effective-tax math, the Telegram
dedupe, the .env parsing, the status schema, the reveal crank and the settle crank (which wallets get settled,
how the coins behind a wallet are counted, which pieces burn and the batching across rounds, the three
strikes alert, the size of the transaction). For the pegged coin they cover the two new account layouts, the
kind of coin read from raw mint bytes (plain, pegged, every transfer hook that should be impossible), its
name, the score of a pegged pool, the accounts of a simulated swap, and the upkeep crank (which assets wait,
the plan of a pass checked against the SDK's own, what a transaction did, a failing transaction, the stuck
alert, the totals, the size of the transactions). For the launch rules template they cover the 414 byte config
built by hand (every byte of its fixed part bent, one at a time, is a danger alert, and no byte after it is),
the declared output of a trade with the sniper fee of the slot and the platform's caps, the size of the buy
probe under a buy limit, the score and the status schema. For the burn keeper they cover where something waits
(the buyback config of 230 bytes, the settled burn pot), the keeper's decision for each of the SDK's four
answers, taken from the SDK's own `buybackInstructions` and `rulesBurnInstructions` on a connection made of raw
bytes, the floor in the buy, the plan of a pass, what a call did as the chain reports it, the three strikes
alert, the totals, the settings and the size of the two transactions. For the strict coin they cover the strict part of the config (every fixed byte bent is danger, the buy mark and the reserve on every read, strict numbers out of bounds or on a plain coin), the buy probe under a max wallet (fitted at the pool's own fee while the sniper fee falls, and a MaxWallet refusal of it read as a setup failure), the sell probe around the two locks, the accounts of a simulated swap, and the holder sync (which records, one read of a pool's records, the batches and their retry, the log lines, the settings, the totals). For coins on the curve they cover the `curve` part of an entry and its schema (a seeded entry keeps the base schema), the notes, the graduate crank (which pools are due, exactly at the target and one lamport short, the order and the split of a pass, the pools that rest and the ones just graduated, what a call did as its `Graduated` event says, the log lines, the alerts, the three strikes rule, the totals, the settings, the state and the health), and the simulation and the burn view with the virtual SOL counted: a plain trade on a fresh curve pool reads as no tax at all, where it would read as a tax above 90% without the virtual SOL, the declared output of a rules coin on the curve matches, the buy probe of a strict coin on the curve fits its max wallet, and a doubling of the real SOL of a curve pool is a wait for the burn, as the program decides. None of them touches the network.

The round 13 tests (`test/r13_fixes.test.mjs`) cover POST /notify (signatures the chain does not know cost one status
call for all of them and no read, a confirmed buy read once, a processed one asked again, the cap of the queue, no
sweep ever), the ticket index (a read in flight shared, a ticket named by a buy kept while the node is behind it, the
tickets read empty left out of the listing for six hours, the hot wallets, the file written at most once a minute),
the pools read at the walked slot (-32016 owed, a new pool owed and not dropped), the feed's lock across a reboot and a reused process id, the address behind the proxy and the limits, and the settings.

The reviewed-hooks tests (`test/reviewed_hooks.test.mjs`) cover the approved list (where a pool stands: own,
approved, not approved, with the rule on and off and with a list that cannot be read; the first pass only records;
the rule, an approval, a revoke and a corrupt list as changes, with no revoke while the list cannot be read; the
alerts in words with the pools of the hook; the lines of `platform.changes`; `hookApproval` and `approvedList` in the
status file), the hook accounts (one entry per program, recorded first, a rewritten list as a danger alert naming
the hook, the account and its pools, a closed manifest, a program seen later, the short history, the state across a
restart, `hookAccountsChangedAtSlot`), and the sells as recent buyers (the buyers from a trades file, who still holds
in one read, a strict coin's locked holders left out, the simulation as the wallet with sigVerify off and the
blockhash replaced, the hook's refusal told from the refusals any trade can meet, a hook that spares the large holder
and refuses the others caught, the budget of a pass, the reasons nothing was simulated, the note, `holderSellFails`
and the settings).
