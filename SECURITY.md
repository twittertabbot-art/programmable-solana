# Security model

## What the pool guarantees to traders and LPs

1. **Hooks never touch funds.** Vault authority is the pool PDA. The five fixed accounts
   a hook receives are read-only, and it answers through return data. The extra accounts a
   hook lists for itself may be writable, which lets it keep state of its own: a program
   can only change accounts it owns, and the one signature the pool lends a hook belongs
   to an address that owns nothing and that no other hook accepts (point 14). The only
   transfer a hook can cause is the hook fee, which goes to the treasury fixed at pool
   creation and is capped.
2. **Hooks cannot grow.** Flags are copied into the pool at creation. A hook that was
   created as "fee only" is refused if it later returns a fee override or a curve. Caps
   (`max_hook_fee_bps`, `max_fee_override_bps`) are enforced by the pool on every swap.
3. **A hook without `CALL_ON_SELL` is never called on sells.** On Solana a failed CPI
   fails the whole transaction and the pool cannot catch it, so the only way to make
   "cannot block sells" true is to never ask. The website shows this flag in words.
   Two kinds of coin run hook code inside a sell anyway, by the launcher's choice: the
   pegged coin (point 12) and the strict coin of the rules template (point 17).
4. **Hooks cannot reenter.** The Solana runtime forbids `pool -> hook -> pool`. A hook that
   wants to trade (a buyback, a burn) uses `hook_swap`, which runs no callbacks and pays
   no hook fee. Point 15 says when the templates may do so.
5. **Hooks are frozen or ours.** `create_pool` reads the hook's loader state and refuses
   it unless its upgrade authority is removed (frozen) or is in the platform whitelist.
   `hook_kind` records which, and the website labels pools "frozen custom hook" or
   "platform template". While the platform's approved-list rule is on, a frozen outside
   hook must also be on the approved list (point 20).
6. **LPs can always leave.** `remove_liquidity` ignores `paused`. A hook with
   `BEFORE_REMOVE_LIQ` could refuse removals; that flag is visible before anyone adds.
   On a strict coin the transfer hook never refuses or caps coins the pool pays out of
   its vault for a removal; it refuses DEPOSITS while the coin's max wallet runs.
   Nobody can freeze the coin's vault: `create_pool` refuses a base coin that has a
   freeze authority, and a Token-2022 mint with any extension other than its own name
   (metadata pointer, token metadata) and, for the platform's pegged coin only, a transfer
   hook without an authority. The list is an allow-list, so an extension added to
   Token-2022 later is refused until the pool is taught about it. The quote token is not
   checked for a freeze authority: a pool against SOL depends on nobody, a pool against a
   token whose issuer can freeze accounts depends on that issuer. A pool on the curve
   (point 18) is the one exception, by design: nobody holds any of its LP, and both
   `add_liquidity` and `remove_liquidity` are refused with `CurveOpen` until it graduates.
   From then on its liquidity behaves as on any pool.
7. **Launch liquidity can never be pulled.** `hooklaunch` moves every LP token the launch
   mints into the pool's lock account, in the same transaction. That account belongs to
   the pool, and the pool program has no instruction that moves LP out of it. The dev
   keeps none. The LP is locked rather than burned so that the LP supply stays large:
   anyone can still add and remove liquidity of their own in amounts as small as they like.
   A launch on the curve needs no lock step: the pool program mints every share into the
   lock account when it creates the pool, and none is ever minted to the dev or to anyone.
8. **Hooks never get the trader's signature.** The trader is passed to callbacks as a
   read-only, non-signing account, so a hook cannot spend from the trader's wallet. A hook
   that needs the trader to pay uses separate instructions the trader signs in the same
   transaction. The collectible template's NFT rent: the buyer either signs `mint` and pays
   it, or pays it in the buy as a deposit, a plain SOL transfer it signs to its own ticket.
   Anyone's `mint_for` then mints the pieces into the buyer's wallet and is paid back out of
   that deposit exactly what it spent plus a fixed fee of 10,000 lamports. Only the buyer's
   own pieces are ever paid from its deposit, only the buyer can take the rest back
   (`withdraw_deposit`), and no other instruction moves it (HOOKS.md section 13, "One
   approval").
9. **Collectible rarity cannot be predicted or re-rolled by a buyer.** A buy commits to a
   block two slots ahead; that block's hash decides the pieces; reveal is permissionless
   and the watcher reveals every ticket; an unrevealed batch expires to the common tier;
   a later buy locks earlier batches before adding anything. A piece is minted with the
   art that was in force when it was bought, so the collection's owner cannot change the
   odds of pieces already earned. Covered by tests that try each of those angles. The
   remaining influence is the producer of the target block; see "What the pool does not
   guarantee".
10. **Collectible pieces are pegged to the coin.** A wallet holds at most one piece per
   `unit` coins in its associated token account. `settle` is permissionless, drops waiting
   pieces first and burns minted ones from the end of the wallet's own list, refuses any
   other piece and stops when the wallet is backed. Pieces are frozen in Metaplex Core
   (permanent freeze, transfer and burn plugins held by the program's PDA), so they move
   only together with their coins: through `send_pieces` on a plain coin, inside the
   transfer itself on a pegged coin. Covered by tests that sell and
   try to keep the piece, move the coins to a second wallet, burn a backed piece, burn the
   wrong piece, and move or burn a piece through Metaplex Core directly. A wallet can be
   above the peg only until someone settles it; the site settles in the sell itself and
   the watcher sweeps every 20 seconds.
11. **Quotes are exact.** A simulated swap returns `amount_out` as return data. The SDK
   uses it so custom curves quote correctly without any per-hook code.
12. **A pegged coin carries its pieces in every transfer, and its hook cannot refuse
   one.** A pegged coin is a Token-2022 mint whose transfer hook is the collectible
   program. The pool accepts a mint with a transfer hook only as the base coin of a pool
   whose own hook is that same program, only when the platform runs that program, and
   only when the extension has no authority, so the coin can never be pointed at other
   code. The hook's `execute` makes no CPI, takes effect only when Token-2022 calls it in
   the middle of a real transfer of that coin (the `transferring` flag on both token
   accounts), and answers `Ok` whatever the tickets look like. It moves list entries
   and their rent between program-owned accounts; the Metaplex assets follow through the
   permissionless `deliver` and `reap`. A piece is in exactly one place: one wallet's
   list, or the burn queue. A piece reaches a wallet only together with a whole unit of
   coins sent in that same transfer, so nobody can fill another wallet's list, and dust
   that happens to complete a unit carries nothing. Covered by tests for a transfer to a
   wallet with and without a ticket, a full receiver, a sell, a direct call, a second
   pool, a second binding, one chosen piece sent with exactly its coins, a dust transfer,
   a list that changed under a send, a full burn queue, and by random walks that check
   every invariant after every step.
13. **A hook fee is never lost and never stops a trade.** The treasury is a token account
   that its owner can close (a wallet that unwraps its SOL closes its wrapped SOL account).
   A trade that finds the treasury missing still goes through; the fee stays in the vault,
   outside the reserves, counted in the pool (`hook_fees_owed_quote`). The next trade that
   finds the treasury pays everything owed, and anyone may recreate the account for its
   owner and call `collect_hook_fees`. The money can only go to the treasury fixed at
   pool creation.
14. **A callback comes from the pool, for this hook, or it is refused.** The pool signs
   each callback with an address that belongs to one hook program
   (`["caller", hook program]` under the pool program). Every template and every hook of
   the kit accepts only the address derived from its own program id (`verify_caller`). A
   program that is called with a signer can pass that signer on, so a hook the pool calls
   can call a second hook with the pool's signature attached; what it holds is its own
   address, which no other hook accepts. A hostile hook therefore cannot make another hook
   believe that a trade, a deposit or a pool creation happened. Covered by tests in which
   a hook built to relay tries every callback that writes state.
15. **A buyback or a burn never buys at a price its caller just made, and never more than
   a slice.** `hook_buyback::execute_buyback` and `hook_rules::run_burn` follow one rule,
   written once in the interface crate (on a strict coin, `run_burn_strict`, which buys
   through the pool's `hook_buy_burn`: the coins are burned inside the vault and never
   transferred). A run buys only against a record of the pool that
   the instruction itself took at least 25 slots earlier. It buys nothing while the price
   is above that record by more than twice the cap. It spends at most the cap of the
   smaller of the pool now and the recorded one. The cap is between 0.01% and 0.5% of the
   SOL in the pool and follows what a buy and a sell cost on that pool and nobody gets
   back. A trade that starts below the recorded price lowers the record's price and never
   raises its depth. On a pool on the curve the record, the price check and the cap use
   the quote the price is made of, the real reserve plus the virtual one, so a doubling of
   the real SOL is not read as a doubled price; graduation keeps the price, so a record
   taken on the curve still compares right after it. `HOOKS.md` section 7 has the
   formulas. Covered by tests that buy
   before a run and sell after it, stack runs, add liquidity around a run, nudge the
   price, and repeat all of that 25 slots later, on chain and over grids of sizes with
   the pool's own math. What is left is under "What the pool does not guarantee".
16. **Launch rules are fixed at launch, and the money they collect has three places to
   go.** A coin on the rules template (`hook_rules`, `RULES.md`) has no owner: the
   program has no instruction that changes a rate, a window, the buy limit or the declared
   lock, for the launcher or for anyone. The hook fee of a trade is split by the program
   between the launcher, the wallets that staked the coin, and the burn pot, in the
   proportions the config fixed. Staked coins and locked coins sit in vaults that belong
   to the coin's config, not to the address that signs the hook's trades, so no buy the
   hook starts can reach them. A staker takes its own coins out after the delay; the
   launcher takes locked coins out after the date and can only move the date later.
   Covered by tests for every rule, every bound, and random walks over all instructions
   that compare every balance with a model after each step.
17. **A strict coin's hook refuses only what its rules say, and never moves a coin.** A
   strict coin is a Token-2022 coin whose transfer hook is `hook_rules` (`RULES.md`,
   "The strict coin"). Inside a transfer the hook makes no call of its own: it reads the
   two token accounts and writes its own config and the two holder records. It takes
   effect only when Token-2022 calls it in the middle of a real transfer of that coin; a
   direct call or a relay through another hook does nothing. It can refuse a transfer for
   these reasons only: coins bought in the early window leaving before the unlock, a
   receiving wallet above the max wallet while it runs, the creator's locked coins leaving
   before the date (also through a delegate), a buy in the early window for a wallet that
   has no holder record (so that its early coins can be told apart), and a receiving
   account that is not its owner's associated token account. After the windows, coins
   that are not locked can
   always be sold and sent. The holder bookkeeping cannot fail a transfer. Nobody can open
   or close another wallet's holder record. Covered by 19 tests and random walks over every
   instruction and every kind of transfer, with every number checked against a model after
   each step, solvency against the real treasury balance, and the rule that every unit of
   the coin sits in the pool's vault or in a known wallet's associated account.
18. **A pool on the curve pays out its real reserve only.** A coin launched on the curve
   (`HOOKS.md` section 2, `INTEGRATORS.md` section 14) trades in a pool that prices with
   `reserve_quote + virtual_quote` but can pay out only `reserve_quote`, the SOL buyers put
   in. A sell can never take more than `reserve_quote` (`CurveRealReserve`): the virtual
   part is never owed to anyone. That holds because the pool holds the whole supply of a
   closed mint when it opens (`create_curve_pool` checks the supply and the mint
   authority itself, whoever calls it), nothing but trades moves its reserves until it
   graduates (`add_liquidity` and `remove_liquidity` are refused with `CurveOpen`, point
   6), no hook that owns the price curve can run it, and no pegged coin can be on it.
   Every LP share of the pool goes into its lock account when the pool is created (point
   7). Tokens or SOL sent straight to a vault change no reserve: the pool reads its
   reserve fields, never its vault balances, and no instruction syncs them. The bound is a
   belt: on the pool's own math alone it can be reached only at a real reserve of 0, a
   state in which no coin is outside the pool, so no sell exists. Covered by tests that
   walk buys and sells from several wallets with fees on and sell everything back, send
   coins and quote straight to the vaults, and by the fuzz of the seventh review.
19. **Graduation keeps the price, and anyone may send it.** `graduate` needs no signature
   but the fee payer's. Once the real reserve reaches the pool's target it takes the
   platform's graduation fee out of that reserve (at most 10% of the target, fixed when
   the pool was created, 0 by default), drops the virtual quote and burns, from the pool's
   own vault, the coins that keep the price: the price after is never below the price
   before and above it by less than one unit of the coin. On a pool below its target, and
   on a pool that has already graduated, it succeeds and does nothing, so a `graduate`
   sent with a trade on a pool on the curve can never make that trade fail. It fails only
   on a seeded pool, and while the platform is paused. It calls no hook, touches no
   account but the platform, the pool, the coin's mint and the base vault, and the pool
   keeps its address. Covered by tests with and without a fee, by a wallet that never
   traded, below the target, twice, after trades past the target, with a sell that takes
   the pool back under its target between a crossing buy and its `graduate`, on a strict
   coin, and by 300,000 random graduations in the seventh review.

20. **While the rule is on, only approved outside hooks open pools.** `create_pool` and
   `create_curve_pool` read the approved list kept after the Platform account's fixed part
   and refuse an outside (frozen) hook that is not on it (`HookNotApproved`), on every path:
   directly, through the launchpad, or from any other client. Only a frozen program can be
   approved, so the approved code can never change. A revoke stops new pools only: a pool's
   hook is fixed at its creation and keeps trading. Tested in `tests/tests/approvals.rs`
   (the launchpad binary there is the one live on mainnet, unchanged) and on a validator
   by `scripts/e2e-approvals.mjs`.

## What the pool does not guarantee

* A hook that IS called on sells may revert them. A hook with `OVERRIDE_CURVE` sets the
  price. Both are allowed powers; the risk card says so, and the watcher simulates sells
  on every hooked pool.
* A frozen program can still have mutable state. Freezing fixes the code, not the
  accounts the program owns: per-pool settings, and also its manifest and its list of extra
  accounts if its code has an instruction that rewrites them. The pool reads the list
  again on every swap the hook is called on, so a hook that empties its list makes those
  swaps fail, exactly as a hook that reverts does. Neither reaches a direction the hook
  is not called on. Template hooks limit their state with ceilings fixed at creation (tax)
  or no owner at all (launch guard). Custom hooks declare an `admin` in their manifest;
  the declaration is the hook's own word, nothing checks it. Read the code of a custom
  hook before listing it.
* The block that decides a collectible buy can be produced by a party with an interest.
  The roll is fixed by the hash of the block two slots after the buy. A leader produces
  four slots in a row, so the validator that includes a buy often also produces the
  deciding block, and it may skip its own slot to move the roll to the next block. That
  is one validator biasing its own buys, at the cost of a block; it is not a way for an
  ordinary buyer to choose.
* A roll costs a round trip, not a holding. A buy earns its waiting pieces for the wallet
  that signs even when the coins are sold or paid elsewhere in the same transaction. The
  wallet sees the result two slots later and can then decide to buy the coins that back
  the pieces, or not. A piece is only ever minted for coins the wallet holds, and waiting
  pieces without coins are dropped by any settle, which frees their place in the supply.
  The price of looking is the fees of a buy and a sell: about 1% of the amount on a pool
  with a 0.3% fee, where the 0.2% protocol fee is also paid each way. A launcher who wants
  looking to cost more sets a higher pool fee.
* A reveal needs somebody to send it. A batch nobody reveals within 512 slots (about three
  and a half minutes) falls to the common tier. The site reveals in the buyer's own next
  transaction and the watcher reveals every ticket; with neither running, buyers lose
  their chance at a rare piece.
* What a piece looks like is served off chain. The chain fixes each piece's seed and art
  bytes and the address the metadata is read from. Whoever runs that address draws the
  picture. Keep the renderer running at the same address for as long as the pieces exist.
* On a pegged coin the collectible program runs inside every transfer, sells included.
  It is written to never fail one, and it is our program: an upgrade could change that.
  A launcher who wants no hook code on sells picks a plain coin.
* Our own programs are upgradeable. Whoever holds the upgrade authority of the pool
  program can change anything in this document with an upgrade, the locked launch
  liquidity included: "no instruction moves it" is a statement about the code deployed
  today. People trust that key the same way they trust any Solana protocol team. Verified
  builds and a multisig on the authority are the mitigations, not immutability.
* A pump that stands in the open can still take part of a large burn pot. If a wallet
  pumps the price, lets a run record the pumped pool, and leaves the pump and its
  liquidity in the pool for 25 slots, and no trade starts below that price in the
  meantime, the next run buys at it. Any holder who sells into the pumped price takes
  that gain instead. What can be taken is never more than the pot, so a burn that is run
  regularly leaves little to take; the watcher runs it. `RULES.md`, "Known limits", has
  the measured figures and the other limits of the same kind: a pool where trades cost
  next to nothing, liquidity that stays in the pool across two runs, and that anyone can
  make a run wait by trading.
* A plain rules coin is not a transfer hook. It cannot cap what a wallet holds, lock coins
  somebody bought, or stop a transfer. The strict coin can, at the costs it lists:
  aggregators will probably not route it, fewer wallets and exchanges handle it, a program
  that keeps coins in its own token accounts cannot receive it, and the max wallet is per
  wallet, so several wallets pass it.
* On a strict coin, a wallet that buys just before a lot of trading earns a share of the
  holders' rate on it and can sell afterwards. Measured on a pool of 100 SOL with holder
  rewards of 1% each side: it pays when the volume that follows is above about four times
  the value of the coins already registered. Fees paid twice, the sniper fee and the early
  lock limit it, and a site that registers buyers in their first buy keeps the registered
  share high. There is no waiting time before new coins earn: the owner chose rewards
  that need no action.
* On a strict coin, a token Burn (not a transfer) leaves the burner's holder record above
  its real balance until anyone sends `sync_holder`; until then it keeps a share of the
  holders' rate. It only moves rewards between registered holders; the treasury stays
  solvent.
* `hook_buy_burn` has no cap of its own: a hook that calls it decides how much to spend.
  Only the pool's own hook can call it and the caller receives nothing; the rules template
  calls it behind the same observation rule and cap as every burn.
* On a plain rules coin the buy limit is per trade, so a buyer can split a buy; the
  creator lock holds the coins in the lock vault and says nothing about coins the
  launcher buys later with another wallet (`creator_lock_seconds` is what the launcher
  declared, and a page shows the lock itself); and rewards go to wallets that stake, not
  to every holder: a wallet can stake just before a large trade and take the holders'
  share of it, and its coins then stay staked for about an hour.
* A sniper fee or a launch guard fee goes to the pool's liquidity, and nobody can add
  liquidity while the window runs. Through the launchpad that liquidity is locked. A pool
  made by calling `create_pool` directly leaves the LP tokens with its creator, who then
  receives that fee.
* The Custom hooks pages of the reference site list hooks; they do not vouch for them. A hook is
  listed because it is frozen and has a pool, read from the chain. Nobody approved it.
  `web/workshop/reviewed.json` is the only place where the operator vouches for a hook,
  and it ships empty.
* What a hook's page says about its rules is a descriptor: text its author wrote and
  hosts. The site never checks it against the code, never puts it into the page as HTML,
  loads it only from an https address that ends in `.json`, reads at most 16,384 bytes
  and refuses one that names another program. A manifest's link may pin the file
  (`#s=` and 22 characters, the first 16 bytes of its SHA-256). The pin proves that the
  file is the one the author pinned. It is not a signature and says nothing about the
  code. An author who prepared two files with the same pin before deploying, about 2^64
  tries, could swap between those two.
* The setup instruction of a third-party hook runs with the launcher's signature. A
  descriptor may name only the launcher, accounts of the hook's own program, the system
  and token programs, the pool and the two mints. The launch form simulates the first
  transaction with and without the setup and refuses a setup that takes more than the
  rent plus 0.001 SOL, more than 0.05 SOL in all, or that changes an account that is not
  the hook's, and it ends the transaction with a floor on the wallet's balance. That
  protects the launch transaction. It is no guarantee about later trades: read the code
  of a hook, or the watcher's simulated trades, for those.
* A hook can pass every check `create_pool` makes before it calls the hook and still
  refuse its own `on_pool_create`. A hook built with a copy of the interface crate from
  before finding 28 does exactly that: it deploys and freezes, and no pool can be created
  on it. A launch on such a hook fails in its second transaction, after the first has
  created the coin and paid for it.
* A pool made by calling `create_pool` directly, outside the launchpad, may trade a coin
  whose supply can still grow: only the launchpad requires that the mint authority is
  gone. A coin that came through the launchpad has a launch record (`["launch", mint]`
  under the launchpad program); a site should say when a pool has none. A pool on the
  curve is the exception: `create_curve_pool` itself requires a closed mint.
* A pool on the curve graduates only when somebody sends `graduate`. Until then it keeps
  trading on the curve, also past its target, and keeps refusing liquidity. The watcher
  sends it, and the SDK puts it in front of every trade on a pool at or past its target
  and after a buy that crosses the target; with neither running, the pool waits for
  anyone.
* A trade quoted on the curve that lands after somebody else's `graduate` fills on a pool
  that has kept the price and lost the virtual depth: on a pool at 100 SOL, about 1% fewer
  coins for a 5 SOL buy and 4% fewer for 20 SOL. Its minimum output protects it: below it
  the trade fails with `Slippage`. A client avoids the case: on a pool at or past its
  target the SDK sends `graduate` first and quotes the trade on the pool as graduation
  leaves it, which is exact whoever graduates first. Nothing in the SDK lowers a minimum
  output. A client that takes its minimum from the fill of a pool "as if graduated now"
  while the pool is below its target signs a minimum far under its quote and can be
  sandwiched; `INTEGRATORS.md` section 14 says so.
* A hook sees the real reserve in its swap payload. A third-party hook that computes a
  price or a depth from it misprices a pool on the curve by the whole virtual part.
  `HOOKS.md` tells hook authors to add the pool's `virtual_quote`, the platform's
  templates do, and nothing on chain can tell what a frozen hook reads.
* The curve's numbers are the admin's: the virtual quote, the target and the graduation
  fee of new pools. A pool copies them when it is created and nobody can change them for
  it afterwards. The fee is at most 10% of the target, the virtual quote at most
  u64::MAX / 4, and the target at least a thousandth of the virtual quote.
* A strict coin's max wallet and its staking threshold are fixed from the supply at
  launch. Graduation burns part of the supply, so after it they are a slightly larger
  share of the coins that exist: a max wallet of 1% is about 1.07% after a graduation at
  the target.

## Platform keys

* Program upgrade authority and platform admin: the deployer key, moving to a Squads
  multisig before mainnet volume. These keys can change template hooks under every coin.
* `init_platform` and every template's `init_manifest` require the program's current
  upgrade authority as signer, so a fresh deploy cannot be front-run.
* The whitelist is at most 8 upgrade-authority keys and lives in the Platform account.
  The watcher logs every change.
* The platform admin also keeps the approved list (HOOKS.md section 6.1): it decides which
  outside hooks can open new pools while the rule is on. It cannot change a hook, and it
  cannot take a hook away from a pool that already has it. A stolen admin key could approve
  a hostile hook for new pools, or switch the rule off; the watcher logs every change of the
  list and of the rule.

## Review status

* 322 Rust tests in the working tree (264 LiteSVM integration tests with the real Token-2022
  and Metaplex Core binaries, 58 unit tests), the review files in `tests/tests/review_*.rs`
  included, among them a hostile hook that returns every
  forbidden answer (fee override without the flag, curve without the flag, fee above cap,
  garbage, wrong version, revert) and relays the pool's signature to other hooks, a hook
  without `CALL_ON_SELL` that cannot stop sells, random walks of 3,600 steps over every
  instruction of the pegged coin, random walks over every instruction of the rules
  template and of its strict coin, random walks of buys and sells on the curve, with
  the invariants checked after each step, and the approved list on every path a pool can be
  created by (`tests/tests/approvals.rs`). The kit for third-party hooks has 14 tests of its
  own (5, 4 and 5).
* End-to-end rehearsal through the TypeScript SDK on a local validator for all templates,
  for coins launched on the curve, for a third-party hook, for the approved list
  (`scripts/e2e-approvals.mjs`), for the trade API, for the review requests with a real
  payment (`scripts/e2e-reviews.mjs`) and for a raw integration without the SDK.
* Eight rounds of independent adversarial review by review agents (read-only, exploits
  proven with tests): see the findings log at the bottom of this file. Every finding of
  severity low or higher is fixed with a regression test, except those listed as "noted,
  not changed", each with its reason.

| Round | Date | Scope | Result |
|---|---|---|---|
| 1 | 2026-10-02 | pool, launchpad, three fee templates | 2 high, 2 medium, 1 low. All fixed. |
| 2 | 2026-10-04 | the collectible peg | 2 high, 2 medium, 1 low. All fixed. |
| 3 | 2026-10-04 | the pegged coin | no critical or high; 3 medium, 4 low. All fixed. |
| 4 | 2026-10-12 | everything, before the first handoff: two security reviews, an integrator and a hook author working from the documents alone, a browser test of the site | no critical or high; 2 medium, 8 low. All fixed. |
| 5 | 2026-10-13 | the launch rules template and what it shares with the other programs: its author's own review, then two rounds by a second agent | 1 high, 3 medium, 5 low, 1 note. All fixed. The high one and one medium were also in the code of 2026-10-12. |
| 6 | 2026-10-15 | the strict coin and the pool's new `hook_buy_burn`: its author's review while building, then a second agent's read-only review against the running binaries | no exploitable bug. While building, the author found and closed one medium (the max wallet passed through liquidity). Two regression tests added at the reviewer's request. |
| 7 | 2026-10-16 | the curve launch: `create_curve_pool`, `graduate` and the effective quote of the pool's swaps, the launchpad's `launch_curve`, the price reads of the rules and buyback templates. A second agent's read-only review against the built binaries, with a fuzz of the pool's own math and 11 tests of its own | the invariant holds: no way found to make a pool on the curve pay out its virtual part, move its price at graduation, graduate early or twice, or starve it. 1 medium and 1 low finding, and 1 informational one older than the curve, all fixed (numbers 40 to 42); the admin's curve settings bounded from a note; four more notes taken into the documents. A follow-up from the trade API's review made `graduate` below the target a no-op too (number 40). |
| 13 | 2026-10-24 | the approved list (HOOKS.md section 6.1): the rule at byte 405 of the platform, the list after its fixed part, `approve_hook`, `revoke_hook`, the check in pool creation, and the SDK that reads them. A second agent's read-only review against the built binary, with 4 tests of its own (`tests/tests/review_round13.rs`) | no bug. Two notes: a revoke sends any extra lamports on the platform account to the admin with the freed rent (documented in HOOKS.md); the SDK did not recognise a loader-v4 program of the platform's own (fixed, tested). The live launchpad binary was proven to obey the rule unchanged. |
* No external audit by a security firm. None of the reviews replaces one. Get one before
  real money is at stake.

## Reporting

Tell whoever operates the deployment you are using. Please do not trade against a bug you
found.

## Findings log

Independent adversarial review, 2026-10-02 (read-only agent, full code and tests). All
five findings fixed the same day, each with a regression test.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | high | Template ceilings (20%) sat above the platform hook-fee cap (10%) and the pool failed swaps above the cap, so a tax owner could set the sell tax to 15% and every sell died while buys worked. Lowering a cap would brick pools the same way. | The pool clamps hook fees and fee overrides to the caps instead of failing. Template ceilings equal the cap. Local quotes mirror the clamp. |
| 2 | high | The launchpad accepted any base mint, so a dev could launch a coin whose mint kept its freeze authority and later freeze buyers or the vault. | `launch` requires no mint authority and no freeze authority. It also refuses hooks that own the curve. |
| 3 | medium | The hook treasury could be any quote token account; closing it made every taxed swap fail (a sell-only honeypot lever, or an accident when a dev unwraps SOL). | The treasury must be its owner's associated token account and never the vault. A closed treasury routes the fee to the pool's LPs and the trade goes through. |
| 4 | medium | `execute_buyback` spent the whole treasury at spot with a caller-chosen minimum, so a sandwich became profitable once the treasury grew. | Each call spends at most 0.5% of the quote reserve. |
| 5 | low | Per-pool template configs for a predictable future pool could be pre-created by a stranger with hostile parameters. | Configs record who paid for them; `on_pool_create` requires that to be the pool creator. |

Second review, 2026-10-04, of the collectible peg (read-only agent, exploits proven with
LiteSVM tests against the real Metaplex Core binary). It found no way to steal a piece,
burn a backed piece, exceed the supply or re-roll an outcome. Every finding below was
fixed the same day with a regression test; the watcher's own run added number 10.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 6 | high | The address of a wallet's next piece is predictable. One transfer of 890,880 lamports to it made every later mint by that wallet fail, and with it the buys the site bundles a mint into. | `mint` hands lamports found on the address to the minter before creating the piece. `init_pool_config` does the same for the collection address. |
| 7 | high | After a burn or a send the ticket account was larger than its list. The next `mint` shrank it and moved lamports that the following Metaplex call did not carry, so the runtime rejected the mint. A wallet that sold everything could not mint again. | The ticket only ever grows in `mint`. |
| 8 | medium | A list above 256 pieces used most of the program's 32 KB heap: six burns in one settle ran out of memory, so the shipped watcher could not settle such a wallet, and at 512 nothing could be minted. | At most 200 pieces per wallet and pool. A full wallet earns nothing on a buy and cannot be sent more. Six burns on a list of 200 are tested. |
| 9 | low | `settle` required the burn accounts in exact list order, so a wallet above the peg could reorder just before the watcher's settle landed and make it fail. | `settle` burns the last piece wherever it sits among the accounts passed and never fails on a wrong one. `reorder` is refused while the wallet is above the peg. |
| 10 | medium | The SDK judged a wallet backed from the raw balance of its token account, while the program also requires the account to still belong to the wallet. A holder could hand the account to another owner and the watcher would not settle it, although anyone could. | The SDK reads the balance exactly as the program does (`backingOf`, `fetchBacking`). |

Changed on 2026-10-05, for aggregators and bots: a swap no longer requires both token
accounts to belong to the signer. The token program still refuses a signer that may not
spend the account the coins leave; the account that receives may belong to anyone, and
never is the pool's own vault. Covered by a test that pays out to another wallet in both
directions, tries to spend an account it does not control, spends as a delegate, and
tries to pay out into the vault. The peg is not affected: a buy paid out to another
wallet earns the signer waiting pieces, which can be minted only for coins the signer
itself holds and are dropped by a settle otherwise, also covered by a test.

Third review, 2026-10-04, of the pegged coin (read-only agent; every finding proven with a
LiteSVM test against the real Token-2022 and Metaplex Core binaries, plus three random
walks (1,500 steps each at the time, 1,200 each now) over every instruction with the
invariants checked after each step).
No critical or high finding: no piece was duplicated, no counter drifted, no plain transfer
or sell failed in a state reachable on chain. Every finding below was fixed the same day
with a regression test, and the random walk is now part of the suite.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 11 | medium | A receiver's room was its whole free backing, and a staged piece travelled with any amount. A stranger could push pieces into another wallet's list for one raw coin: the victim's next sell then dropped its own waiting pieces instead, and a list filled to 200 earned nothing on a buy. | The receiver takes one piece per whole unit the transfer adds to it. A staged piece travels only with a whole unit of its own. |
| 12 | medium | A send was "put the piece last, stage one". A piece that reached the sender's list before the send landed travelled in place of the chosen one. | `stage` names its pieces and fails when the end of the list is not exactly them. The SDK also refuses, before signing, a send the receiver has no room for. |
| 13 | medium | A staged send dropped the sender's own waiting pieces although the coins that stayed still backed them. | Staged pieces that travel are counted out before anything is judged unbacked. |
| 14 | low | The burn queue was one account without a ceiling. At the 10 MB account limit every transfer or sell that had to burn a piece would have failed inside the hook (about 327,000 unreaped entries). | At most 4,096 entries. A transfer that would go past it leaves the pieces on the sender's list for `settle`. Growing an account inside the hook can no longer return an error. |
| 15 | low | The raw readers accepted a Token-2022 multisig (355 free-form bytes) as "a token account of this coin in transfer" for a mint address whose first bytes fit. Nothing could be changed through it: one later check (the source must be the wallet's associated account) stopped every write. | Accounts of a multisig's length are never read as a token account or a mint, as in the token program. |
| 16 | low | Launchpad: a pegged coin could reach `launch` with a name its dev could still rewrite (second step skipped, supply minted by hand), and coins minted between the two steps made the supply larger than the stated one. | `launch` requires a Token-2022 coin's name to be final (no metadata update authority, no pointer authority), and present when the coin has a transfer hook. `finish_pegged_token` requires a supply of zero. |
| 17 | low | A stage stayed armed after a sell, or after a transfer out of another token account of the wallet, for the wallet's next transfer in the same slot. | A stage is spent by the first transfer of the wallet that reaches the hook, whatever it is. |

Also from this round. The SDK decoder for tickets no longer allocates on the word of a
list count larger than the data (bytes in another layout ran a keeper out of memory), a
keeper skips tickets it cannot read, the transfer hook decoder reports a hook authority
that has no program yet, and `hookRef` asks the collection config whether a coin is
pegged instead of guessing from the pool. `deliver` emits an event.

Noted, not changed. A stranger who sees a coin's mint address before its config exists can
create that config first, and the coin can then never be bound (the launchpad path creates
the mint, the config and the binding in one transaction signed by the mint, so the address
is not visible beforehand). A transfer from a token account to itself does not reach the
hook, so it does not spend a stage; a stage only holds for its slot. After a token `Burn`
(not a transfer) a wallet is above the peg until anyone settles it; its next transfer
moves the unbacked piece only together with whole units, and burns it otherwise. Every
transfer of a pegged coin writes the same config account and the burn queue, so transfers
of one coin do not run in parallel. One transfer can leave up to 200 deliveries for the
keeper, which pays a fee for each batch of six and earns nothing on deliveries; the
watcher bounds its work per pass. The call depth launchpad, pool, token program, hook is
four, and the runtime allows five: a program that wraps a launch has one level to spare,
one that wraps a swap has two. Tested up to the launch, not beyond.

Noted, not changed (second review): a stranger can create the config of a pool that does not exist yet,
which blocks that pool from using the template (the launchpad is not affected: it creates
the coin and the config in one transaction, so the pool address is not known beforehand).
A holder can add their own Metaplex plugins to a piece; the permanent plugins still win.
The fallback seed of a batch nobody revealed for 512 slots is predictable, and always the
common tier. If Metaplex ever enables asset compression, a compressed piece could not be
burned without a proof; today the instruction is refused by Metaplex Core itself.

Hardening from the informational notes: extra accounts resolved from a hook's list are
required to be non-signers in the pool itself (not only by the resolver library); the
swap and liquidity `user` accounts are no longer marked writable; the curve-override
flag is described to traders as "can hand the pool's reserves to anyone".

Noted, not changed: a hook owner's `set_owner` is one-step; the hook-initiated swap path
prices with the plain curve and skips callbacks (only the hook's own PDA can use it);
the same two mints in reverse order form a second pool without the hook, so the website
treats a coin's wSOL pair as the one market.

Fourth review, 2026-10-12, before the code was handed over: one agent on the pool, the
launchpad and the three fee templates, one on the collectible hook, one that integrated
the pools from the documents alone, one that wrote two hooks from the documents alone, and
a browser test of the reference site. No critical or high finding. The earlier fixes were
re-checked against the code and hold. Everything below was fixed the same day with a
regression test, unless it is listed under "noted, not changed".

| # | Severity | Finding | Fix |
|---|---|---|---|
| 18 | medium | The art of a piece, and with it the odds of a rare one, was read at mint. The collection's owner could change the art after pieces were earned and revealed: downgrade a buyer's pieces, or upgrade its own inside one transaction and put the art back. | A batch stores the art in force when it was bought, and `mint` uses it. |
| 19 | medium | A hook fee whose treasury account did not exist was charged to the trader and left in the reserves, so it went to the LPs. The default treasury of a tax coin is its dev's wrapped SOL account, and the SDK itself closed that account whenever the dev traded. A dev could lose the tax without noticing. | The fee waits in the pool, outside the reserves, and is paid by the next trade that finds the treasury, or by `collect_hook_fees`. The SDK and the trade API never close a wrapped SOL account that existed before the transaction. |
| 20 | low | `create_pool` called directly accepted a coin that kept its freeze authority. That authority could freeze the pool's own vault: no trades, and LPs could not leave. Only the launchpad checked. | `create_pool` refuses a base coin with a freeze authority. |
| 21 | low | The Token-2022 check was a list of forbidden extensions. An extension added to the token program later would have been accepted unseen, and two existing ones let a coin's creator rescale the amounts wallets display. | The check is a list of allowed extensions. Everything else is refused. |
| 22 | low | The launch burned its LP, which left an LP supply of 1,000 units. Liquidity could then only be added in steps of 0.1% of the pool. No value could be taken this way, but small deposits were impossible. | The launch moves its LP into the pool's lock account instead. Nothing can take it out, and the supply stays fine-grained. |
| 23 | low | In a transfer of a pegged coin the receiver took a piece when its balance crossed a unit, so ten raw coins sent to a wallet just below a unit pushed a piece into its list, and the wallet's next sell dropped one of its own waiting pieces instead. | The receiver takes one piece per whole unit the transfer itself sends. |
| 24 | low | A stage stored how many pieces travel, not which. A piece that reached the wallet's list between its stage and its transfer travelled in place of the one it named. | A stage is cleared whenever the list under it changes: a piece arrives, a mint, a reorder. |
| 25 | low | `open_ticket` failed when the ticket was already open, so a stranger who opened a wallet's ticket first made that wallet's first buy fail once. | Opening an open ticket does nothing. |
| 26 | low | The SDK copied the signer bit from a hook's account list into the transaction. A hook that listed a signer made every swap on its pools unsignable by anyone else, although the pool itself never passes such an account as a signer. | The SDK never marks an account from a hook's list as a signer. |
| 27 | low | The trade API handed out a transaction that had to fail for a custom hook that takes a fee (the floor came from a quote that assumed no fee), accepted any address as `recipient`, and read a hook's own error named `Slippage` or `Paused` as the pool's. | The API simulates such trades itself and takes the floor from the result, requires `recipient` to be a wallet, and gives the pool's meaning only to the pool program's errors. |

Noted, not changed (fourth review). A roll can be taken with no coins held, for the price
of a round trip: see "What the pool does not guarantee". The fix would need the signer's
token account in every collectible callback and would still leave the same loop open on a
plain coin, where the hook is never called on a sell. A frozen custom hook can rewrite its
own list of extra accounts when its code allows it, and every pool on that hook follows at
once; it gains no power the flags do not already show, since it could refuse the same
trades by reverting. A ticket's rent (346 bytes: about 0.0024 SOL on mainnet) is never returned: no instruction
closes a ticket. A ticket may also hold a deposit above that rent (HOOKS.md section 13);
the wallet takes the deposit back with `withdraw_deposit`, and the rent stays. When a piece burns, the keeper that sends the burn receives part of its
rent, the rest stays with Metaplex Core, and the old holder receives nothing unless it
sends the burn itself. Metaplex's own count of a collection can be above the cap for as
long as burned pieces wait in the queue. An aggregator that signs swaps with its own
account, rather than the trader's, earns the pieces of a collectible buy instead of the
trader.

Fifth review, 2026-10-13, of the rules template (`hook_rules`) and of what
it shares with the other programs. The program's author reviewed it while building it, and
a second, read-only agent then reviewed the result twice, proving every finding with a
LiteSVM test. Numbers 28 and 29 were also in the code handed over on 2026-10-12: a
deployment of that code should be replaced, not patched, because 28 changes an address
that the pool and every hook must agree on. Everything below is fixed with a regression
test, unless it is listed under "noted, not changed".

| # | Severity | Finding | Fix |
|---|---|---|---|
| 28 | high | Callback relay. The pool signed every callback with one address for all hooks. A hook the pool calls could pass that signature on to another hook, with accounts and a payload it made up: credit collectible pieces and choose their block, arm another coin's launch guard, start a rules config, move the counters of a kit hook. No funds of the pool were in reach, but every hook that keeps state trusted that signature. | The caller is one address per hook program, `["caller", hook program]`. Each hook accepts only the address derived from its own id. |
| 29 | medium | A buyback or a burn could be stacked. Finding 4 capped one call at 0.5% of the reserve, but nothing limited the number of calls: a wallet could buy, call the instruction many times in the same transaction against its own pumped price, and sell. | A run needs a record of the pool at least 25 slots old and leaves a fresh one, so two runs are at least 25 slots apart. |
| 30 | medium, high on a buyback coin with a large minimum | The cap was measured on the pool's reserve at the moment of the call. A wallet could buy, add liquidity, run, remove the liquidity and sell: the deepened pool made the slice larger, and the wallet kept about a third of what the run spent. It all fits in one transaction, so borrowed money was enough. | The cap is measured on the smaller of the pool now and the recorded one, and a run buys nothing while the price is above the record by more than twice the cap. |
| 31 | low | On a rules coin the launcher could sandwich its own burn: the cap grew with every rate of the coin, the creator's included, and the launcher gets its own rate back. | The cap counts only what nobody gets back: the protocol fee and the burn share of a buy and a sell. The creator's rate and the holders' rate are left out. |
| 32 | medium | A record could be fooled across two transactions. A wallet pumped, had a run record the pumped pool, sold back, and pumped again 25 slots later against a record that said the price had not moved. | A trade that starts below the recorded price lowers the record, and keeps its slot. |
| 33 | low | That lowering copied the pool's two reserves, the depth included. A holder with enough coins could add liquidity, make two small sells, and have one run spend twelve slices at an honest price. Nothing was taken; the pace of the burn was broken. | The lowering moves the recorded price only. The recorded depth can go down, never up. |
| 34 | low | The sniper fee and the launch guard fee go to the pool's liquidity. Liquidity added during the window, which is not locked, took a share of it: a launcher could add liquidity next to the locked launch liquidity, collect most of the fee the snipers paid, and take it out. | The rules template and the launch guard refuse `add_liquidity` while their window runs. Removing liquidity is never refused. |
| 35 | note | On a rules coin the holders' rate was charged only while enough was staked. Staking or unstaking 0.1% of the supply switched the rate on or off between a quote and its trade, so a quote could be made wrong on purpose. | The holders' rate is always charged. While too little is staked its part goes to the burn pot. A quote no longer depends on what is staked. |
| 36 | low | A buyback config had no ceiling on `min_quote`. A high minimum lets the treasury grow large next to the pool before the first run, which is what makes a run worth attacking, and a minimum the treasury never reaches means no buyback at all. A config could also be created for an address that is not the pool of its two mints, and a stranger who created the hook's token accounts first blocked the config. | `min_quote` is at most 1 SOL. The config's pool must be the pool address of its two mints. Token accounts that already exist are accepted. |
| 37 | low | In `on_pool_create` the templates and the kit hooks believed the callback's payload: who created the pool, and that it exists. | They also read the Pool account, which only the pool program writes: the pool must exist, name this hook, and have the creator the config was made by. |

Noted, not changed (fifth review). A pump that stands in the open for 25 slots can take
part of a large pot; see "What the pool does not guarantee". Liquidity that is in the pool
at two runs in a row makes the second run larger, at an honest price: closing that would
need a callback when liquidity leaves, and a hook that can be called then can also refuse
it, which point 6 forbids for the templates. Anyone can make a run wait by trading, at
the price of the fees. A wallet that stakes just before a large trade takes the holders'
share of it. `min_eligible` is fixed from the supply when the pool is created, so a coin
made outside the launchpad with a live mint authority can set it to almost nothing. Stake
records, the lock record and the two vaults are never closed, so their rent is not
returned. The burn of a busy coin can wait for a long time, because a run buys only in a
calm stretch or a fall; the pot is not lost while it waits.

Sixth review, 2026-10-15, of the strict coin of the rules template and of the pool's new
`hook_buy_burn`. The program's author attacked its own design while building it; a second
agent then reviewed the result read-only against the binaries that run, with every
existing suite run against them. The second agent found no exploitable bug: no way to
move, freeze, take or block anybody's coins or SOL, to inflate or take holder rewards, to
pass the max wallet, the early lock or the creator floor with one wallet, to make a
transfer fail that the rules say must pass, or to use `hook_buy_burn` beyond what
`hook_swap` already allows. It asked for two more regression tests, which were added: the
creator floor against a delegate, and a holder record closed and opened again earning
nothing of the time between. What the author found and changed while building:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 38 | medium | With the max wallet on, one wallet could pass it through liquidity: deposit coins, buy up to the cap again, take the deposit back, repeat. Capping removals instead would have broken point 6. | While the max wallet runs, deposits are refused. Removals are never refused or capped. |
| 39 | design | A burn on a strict coin cannot transfer the bought coins: the hook would be entered again inside its own call (the runtime refuses that) and the creator's lock could not use a vault for the same reason. | The pool gained `hook_buy_burn`, which burns the bought coins inside the vault; the creator lock is a floor on the creator's own wallet, enforced by the transfer hook. |

Noted, not changed (sixth review): the wallet that buys just before a lot of trading on a
strict coin, a record left high after a token Burn until `sync_holder`, the max wallet per
wallet, and `hook_buy_burn` without a cap of its own (see "What the pool does not
guarantee"). A pool of a strict coin made with `create_pool` directly, outside the
launchpad, leaves the LP tokens with its creator, who can take liquidity out above the
max wallet; a launchpad coin locks its launch liquidity forever.

Seventh review, 2026-10-16, of the curve launch: the pool program's `create_curve_pool`,
`graduate` and the effective quote of `swap`, `hook_swap` and `hook_buy_burn`, the
launchpad's `launch_curve`, and the lines of `hook_rules` and `hook_buyback` that read
prices. A second agent, who did not write the code, reviewed it read-only against the
binaries the programs' author built. It checked the author's proof that the virtual part
is never owed (points 18 and 19) step by step against the code, and fuzzed the pool's own
math: supplies from 2 units to u64::MAX, virtual quotes from 1 to 10^18 lamports, every
fee up to its hard cap, 18,295 buys, 11,462 sells and 3,438 buy-and-burns, then everybody
selling everything; and 300,000 random graduations. The bound was never what stopped a
sell, the product of the effective reserves never fell, every coin was accounted for, and
graduation never lowered the price nor raised it by a whole unit. It tried 21 attacks that
lost, among them selling coins that did not come out of the pool, liquidity before graduation through every path, rounding at
1 lamport and at 10^18, the fee caps, sandwiching a graduation in both orders, a whale buy
that leaves 30 coins in the pool, donations to the vaults, and the two templates across a
graduation. The three findings below were fixed in the pool program the same day, each
with a regression test. The reviewer's own 11 tests, `tests/tests/review_curve.rs`, were
updated to assert the fixed behaviour and pass; that file is not in the package.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 40 | medium | A `graduate` sent after a trade failed the whole trade once anyone had graduated the pool first: `graduate` refused a graduated pool with `NotOnCurve`. The SDK sends it after the trade that takes a pool to its target and the watcher sends it too, so at the busiest moment of a coin only the first transaction would land, and a griefer could make the trades in flight fail by sending `graduate` first. No funds were at risk. | `graduate` on a graduated pool succeeds and does nothing: no write, no event. `NotOnCurve` stays for a seeded pool. Tests: `graduate_does_nothing_before_the_target_anyone_graduates_the_pool_at_it_and_the_price_is_kept` (a second call by anyone lands and changes nothing, byte for byte on the pool, the supply and both vaults; `[swap, graduate]` lands on a graduated pool as a plain trade), and the reviewer's `review_a_graduate_appended_to_a_trade_fails_the_whole_trade_once_anyone_graduated_first`, which now asserts that the trade lands. The same day the trade API's own review found the same failure from the other side: a sell that landed between a buy crossing the target and its `graduate` took the pool back under the target, and the `graduate` then failed with `GraduationNotReached` and took the buy down with it. So `graduate` on a pool below its target also succeeds and does nothing (revision 3 of the curve); 6048 is returned by no instruction any more. Test: `a_crossing_buy_a_sell_that_takes_the_pool_back_under_and_the_appended_graduate_land_in_one_transaction`. |
| 41 | low | The rule that a pegged coin cannot launch on the curve was the launchpad's alone. `create_curve_pool` sent directly took a pegged collectible coin. Nothing could be taken or broken with it, but a pool existed that the design says cannot. | `create_curve_pool` refuses a Token-2022 coin whose transfer hook is the collectible program, with the pool's own `CurvePegged` (6050); the launchpad keeps its 6011. Tests: `create_curve_pool_refuses_a_pegged_collectible_coin_that_a_seeded_pool_takes`, and the reviewer's `review_the_pool_program_takes_a_pegged_coin_on_the_curve_that_the_launchpad_refuses`, which now asserts the refusal. |
| 42 | informational, older than the curve | A trade whose output rounds to zero, on a pool without a hook, failed with `HookCurveInvalid` (6035), the error of a hook's curve answer, so a client that maps error names blamed a hook that does not exist. The curve's tiny first prices made such dust trades more common. | A dust trade fails with `ZeroAmount` (6006) on every pool; `HookCurveInvalid` is a hook's answer only. Tests: `math::tests::a_dust_trade_is_a_zero_amount_and_a_hooks_zero_is_the_hooks_error`, and the reviewer's `review_math_a_dust_sell_fails_with_the_hooks_curve_error_on_a_pool_without_a_hook`, which now asserts `ZeroAmount`. |

Hardening from a note of this round: the admin's curve settings have bounds.
`init_platform` and `update_platform` refuse a virtual quote above u64::MAX / 4 and, when
both are on, a graduation target below a thousandth of the virtual quote, with
`CurveSettingsOutOfBounds` (6051). A virtual quote near u64::MAX would have made every trade
overflow on the pools created with it, and a target far below it could leave a pool too
small to ever graduate. Tests: `platform::tests::the_curve_settings_have_bounds`, and the
bounds on chain in `a_curve_pool_opens_with_no_real_quote_every_share_locked_and_the_platforms_settings_copied`.

Noted, not changed (seventh review). A trade quoted on the curve that lands after somebody
else's `graduate` fills lower at the same price; its minimum output protects it. The
first answer to that in the SDK, a minimum taken from the smaller of two fills (on the
curve, and on the pool as if it graduated now), was withdrawn the same day: on a pool
below its target the second fill belongs to a pool that cannot exist, and a buy of 89 SOL
into a pool that had raised 0.3 SOL signed a minimum 98.7% under its quote, open to a
sandwich. The SDK now sends `graduate` in front of a trade on a pool at or past its target
and quotes it on the graduated pool, sends it after a buy that crosses the target, and
never lowers a minimum (see "What the pool does not guarantee"). A strict coin's max wallet and staking threshold are shares of the supply at
launch, and slightly larger shares after graduation burns part of it; no rule is passed. A
third-party hook that prices from the swap payload sees only the real reserve on a pool on
the curve; nothing on chain can tell, and `HOOKS.md` tells hook authors what to add. "About
6.8% of the supply is burned at graduation" holds at exactly the target; a later
graduation burns less, and the documents say so. Points 6 and 7 above now say what a pool
on the curve does with its liquidity.
