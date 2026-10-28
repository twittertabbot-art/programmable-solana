# Programmable adapter for Jupiter

A Rust crate that implements Jupiter's `Amm` trait (`jupiter-amm-interface` 0.6.1) for
Programmable pools, with a parity suite built on Jupiter's own test kit. It is the piece
Jupiter asks a DEX for before it can route through it.

It makes no network call. It quotes a pool from the accounts Jupiter caches and hands
back the pool's native swap accounts in on-chain order.

## What a quote reads

| Account | Why |
|---|---|
| the pool | reserves, pool fee, the hook program and its flags, and for a coin launched on the curve its virtual quote and its curve state |
| the platform (`["platform"]` of the pool program) | protocol fee, the caps hooks are held to, the pause switch |
| the hook's per-pool config (`["cfg", pool]` of the hook program) | what a template hook will answer |
| the hook's extra-accounts list (`pool.hook_extra_metas`) | to build the swap's account list |
| the coin's mint, when it lives in Token-2022 | to see whether it carries a transfer hook |

The reserves are fields of the pool account, not vault balances, so one account read
gives both. `src/state.rs` reads the leading fields of each account by hand; the layouts
are in `../INTEGRATORS.md`.

## What is routed

| Pool | Routed | How it is quoted |
|---|---|---|
| no hook | both directions | protocol fee, pool fee, constant product |
| `hook_tax`, `hook_buyback` | both directions | plus the hook's fee from its config, clamped to the platform cap as the pool does |
| `hook_launch_guard` | both directions | on buys the guard's fee replaces the pool fee and falls every slot (`AmmContext.clock_ref`) |
| `hook_rules` | both directions | plus the three rates of the side from its config, as one hook fee. Inside the sniper window the sniper fee replaces the pool fee on buys and falls every slot, as the launch guard's does. A buy above the coin's buy limit, inside its window, is an error |
| `hook_collectible` on a plain coin | both directions | the hook takes no fee; a wallet without a ticket earns no piece and the buy goes through |
| a coin with a Token-2022 transfer hook (a "pegged" coin) | no | its own program runs inside every transfer and needs per-wallet accounts |
| a strict coin of `hook_rules` (Token-2022, the rules hook as its transfer hook) | no | the same: the rules hook runs inside every transfer, keeps a holder record per wallet, and can refuse a buy, a sell or a send while the coin's windows run (`../INTEGRATORS.md`, section 9) |
| any other hook | only the directions on which the pool never calls it | plain curve math |

A hook this crate does not know may answer any fee under the caps, or refuse the swap, so
a direction on which the pool calls it cannot be quoted. The pool calls a hook on a
direction only when the hook's `CALL_ON_BUY` or `CALL_ON_SELL` flag is set, and the flags
are fixed when the pool is created. A pool whose unknown hook is called on buys only is
offered as a one-way market, coin to quote (`unidirectional`), so holders can always be
routed out.

`is_active()` is false, and `quote` returns an error, for everything that is not routed,
while the platform is paused, and until the accounts above have been read once.

Every kind in the table may also have been launched on the curve, below. That changes how a
pool is quoted, not whether it is routed.

### Pools on the curve

A coin can be launched in two ways. A seeded launch puts real SOL into the pool next to the
supply. A launch on the curve puts in no SOL at all: the pool holds the whole supply, prices
the coin as if it also held the platform's virtual SOL (30 SOL by default), and pays sells
from the real SOL that buyers put in. When the real SOL reaches the pool's graduation target
(85 SOL by default), anyone may send `graduate`: the virtual SOL is dropped and coins are
burned from the pool so that the price stays where it was. It is the same pool account, at
the same address, before and after; nothing migrates.

The pool account says all of it (layout in `../INTEGRATORS.md`, section 5): the virtual quote
at offset 504, the graduation target at 512, the graduation fee at 520 and the curve state at
522 (0 seeded, 1 on the curve, 2 graduated). `src/state.rs` reads them; no other account is
needed.

* **The quote** runs on the effective quote reserve, `reserve_quote + virtual_quote`, with
  the same fees and the same rounding as any pool. The virtual quote is 0 on a seeded pool and
  after graduation, so one formula covers every pool.
* **A pool on the curve is tradable from its first slot**, with no real SOL in it. The rule
  "a pool whose quote reserve is zero is not routed" uses the effective quote. A sell needs
  real SOL to be paid from: while the pool holds none, `routable(false)` is false and every
  sell is an error.
* **A sell is paid from the real SOL only.** A sell whose gross output would pass
  `reserve_quote` is not quoted: `quote` returns the error it returns for any amount the
  pool refuses, and the pool would fail it with `CurveRealReserve` (6049). On chain such a
  sell cannot exist, because the coins outside the pool all came out of it; a test kit that
  hands a wallet coins from nowhere can build one, and the parity suite does, to show that
  the chain refuses it.
* **Liquidity is not this crate's business.** The pool refuses `add_liquidity` and
  `remove_liquidity` until graduation (`CurveOpen`); a router never sends them.

**`graduate` is not sent by this crate.** It is permissionless and the platform's watcher
(`../watcher/`) sends it when a pool stands at or past its target; the SDK also sends it in
front of a trade on such a pool and after a buy that crosses the target. Between the moment
the target is reached and the moment a
`graduate` lands, the pool is still on the curve: it prices with the virtual SOL, and a quote
from this crate stays exact. A swap quoted on the curve that lands after somebody else's
`graduate` fills on a pool that keeps the price but has lost the virtual depth: on a pool at
100 SOL, a 5 SOL buy then gets about 1% fewer coins and a 20 SOL buy about 4% fewer. The
router's minimum output covers that: the swap fails with `Slippage` instead of filling worse
than allowed. Keep that minimum where the quote puts it; never lower it for a graduation that
may come. The next `update` reads the graduated pool, and from then on it is quoted like any
pool. A Jupiter swap is the pool's one instruction, so this crate cannot put a `graduate` in
front of it the way the SDK does; the window lasts until the watcher's `graduate` lands.

### Rules pools

A rules coin is launched with rules nobody can change afterwards. The adapter reads them
from the config once per update: the three rates of a buy and of a sell, the sniper
window and its start fee, the buy limit and its window, and the slot the pool was
created in. It reads nothing about staking: what a trader pays does not depend on who
staked.

* **Outside the windows** the quote is exact: the pool's fees plus the three rates of the
  side.
* **Inside the sniper window** the quote is exact for the slot of `clock_ref`. The fee of
  a buy only falls, so a swap that lands a slot later pays out the quoted amount or more.
  Sells never pay the sniper fee.
* **Inside the limit window** a buy above the limit is refused by the chain: the whole
  swap fails. `quote` returns an error for it, not a number. Smaller buys and every sell
  are quoted, so `is_active()` stays true: the pool is offered, with a largest buy. A
  router that probes with fixed sizes sees errors for the sizes above the limit until
  the window is over, at most 9,000 slots after the launch, about one hour.

The burn of a rules coin and the buyback of a buyback coin are instructions anyone may
send. They buy on the pool as any trade does and need nothing from a router.

## What an aggregator must know about fees and reserves

* **Quote from the reserve fields, never from the vault balances.** A vault holds its
  reserve and more: the protocol fees that wait to be collected, and, in the quote vault,
  the hook fees that wait for a treasury (pool offset 464, `hook_fees_owed_quote`). This
  crate only ever reads `reserve_base` and `reserve_quote` of the pool account.
* **A closed treasury changes nothing for the trader.** The treasury of a tax coin is a
  token account its owner can close. A swap that finds it missing still charges the hook
  fee: the trader pays and receives exactly what the quote says, and the fee stays in the
  quote vault, outside the reserves, until the account is back. So the quote is the same
  with or without the treasury, and the adapter does not read that account. It passes the
  pool's treasury address as the swap's account 9 whether or not the account exists, as
  the pool requires.
* **The reserves after a swap follow one rule in both cases**: the side that receives
  grows by the net input and the pool fee, the other side falls by the gross output. The
  adapter does not carry reserves forward: `update` decodes the pool account again.
* The parity test `a_taxed_pool_whose_treasury_is_closed` runs all of this against the
  real programs: a pool whose treasury account does not exist, snapshotted with a fee
  already waiting, where the quote vault holds more than `reserve_quote`.

## The swap

`get_swap_and_account_metas` returns the pool's native `swap` accounts: seventeen fixed
ones, then the hook's own, resolved offline from the hook's list.

* The signer is `token_transfer_authority`. The pool asks the token program to move the
  input out of the source account with that authority, so it may be the owner or a
  delegate. The account that receives may belong to anyone.
* `Swap::Placeholder { data: Some(vec![direction]) }`: `0` buys (quote to coin), `1`
  sells. `swap_instruction_data(direction, amount_in, min_amount_out)` builds the
  instruction data: the 8-byte discriminator, the direction, two little-endian `u64`.
* Account 12 is the hook caller, the address the pool signs its calls into a hook with.
  There is one per hook program: `["caller", hook program]` of the pool program, where
  the hook program is the one in the pool account, and the system program for a pool
  without a hook. `caller_address(&hook_program)` derives it. A swap with the caller of
  another hook program fails with Anchor 2006.
* Each of the hook's accounts keeps the writable bit of the hook's list. The config of a
  buyback, launch guard or rules pool is writable, on buys and on sells: the hook writes
  to it in every swap. Passed read-only, the runtime stops the swap.
* A buy on a collectible pool passes the signer's ticket address. On a route where the
  signer is the trader, a trader who holds a ticket earns pieces. Where the signer is an
  intermediate authority, nobody does. The swap itself is the same either way.
* The swap emits its event through a self-CPI, so the event authority and the program are
  the last two fixed accounts.
* A pool quoted in SOL takes and pays wrapped SOL. A router that wraps and unwraps for
  the trader must not close a wrapped SOL account that existed before its transaction:
  it may be the fee treasury of a coin.

## Tests

```
bash test.sh                                   unit tests and the parity suite, offline
RPC=<url> bash test.sh                         snapshot missing fixtures from a cluster first
RPC=<url> REFRESH=1 bash test.sh               snapshot every fixture again
FRESH_PROGRAMS=1 bash test.sh                  copy the programs from the last local build first
```

* 31 unit tests: the math against the vectors of the programs' own unit tests (the swap,
  the launch guard's fee, the sniper fee, the buy limit, the first buy on the curve, a sell
  past the real reserve, a dust trade, the price kept across a graduation), the decoders
  (the rules config at its documented offsets, the buyback config of 230 bytes, the curve
  fields of the pool at 504 to 522 and the platform's curve settings at 387 to 403), the
  extra-accounts resolver, and what is offered for routing on hand-built accounts: unknown
  hooks in every flag combination, a paused platform, a missing config, a tax above the
  cap, a coin with a transfer hook, a rules pool at slots inside and outside both of its
  windows, the hook caller of every hook program, the account order of the swap, the
  writable config of a buyback and a rules pool, and pools on the curve: just opened with
  no real SOL, with 2 SOL raised up to the largest sell the real SOL can pay, past the
  target, graduated, a tax pool on the curve, a curve state this build does not know.
* 22 parity tests with `jupiter-amm-test-kit`. For each kind of routed pool: five buys
  from 0.001 SOL to 3 SOL and four sells from a thousand coins to a third of the pool.
  Each swap runs the real pool and hook programs in LiteSVM, and the amount that reaches
  the wallet must equal `quote().out_amount` exactly. The fifteen routed pools are: no
  hook, tax, tax with its treasury closed, buyback, a launch guard after its window, a
  launch guard snapshotted inside its window (where the fee depends on the slot), the
  collectible hook on a plain coin, a rules coin with a creator fee, a rules coin with
  three rates that differ between buys and sells, a rules coin snapshotted inside its
  sniper window and its limit window, and five coins launched on the curve: one with no
  real SOL yet (buys only), one after a first buy of 5 SOL, a rules coin on the curve,
  one bought past its graduation target that nobody graduated, and one graduated. On the
  rules coin inside its windows the buys stop at the limit, half a SOL, and one buy is
  exactly the limit. On the two curve pools that hold a few SOL the sells stop at what
  that SOL can pay, and the last sell is the largest the adapter quotes: its gross output
  is the whole real reserve, and the chain pays it. A pegged coin's fixture and a strict
  coin's prove that neither is offered: the adapter is not active for them and every
  quote is an error.
* Four of the twenty-two must fail inside, and are written to. Two run the adapter with a
  clock that says every window is over. With it the adapter quotes a buy above the
  limit, and the rules hook refuses the swap with `BuyTooLarge`. And its quote of a buy
  inside the sniper window is not what the chain pays. So the limit is the chain's, not
  an extra caution of the adapter, and the clock matters. Two run an adapter that
  answers where this one refuses: a sell on the pool with no real SOL, and a sell one
  unit above the largest one quoted. The pool refuses both with `CurveRealReserve`. So
  what the adapter does not quote is what the chain will not pay.

Checked on 2026-10-13, and for the curve on 2026-10-16, that the suite fails when the
adapter is wrong. One line of `src/` was broken at a time, the suite run offline, the line
restored:

| What was broken | Parity tests that failed |
|---|---|
| fees rounded down instead of up | all ten routed pools |
| the launch guard's clock: always the first slot of its window | both launch guard pools |
| the rules pool's clock: always the first slot of its windows | the rules pool inside its sniper window, and the test of the buy above the limit |
| the tax and buyback fee: the buy fee on sells too | both taxed pools |
| the rules fee: the buy rates on sells too | the rules pool with three rates |
| the rules fee: the burn rate left out | the rules pool with three rates |
| the buy limit never refused | the rules pool inside its sniper window |
| one hook caller for every pool | every test that swaps: twelve |
| the hook's accounts all read-only | every pool whose hook writes: the two guards, buyback, the three rules pools, collectible, and the two tests that must fail inside |
| the check for a transfer hook on the coin left out (checked on 2026-10-15) | the pegged coin and the strict coin |
| the quote without the virtual quote | the curve pools with no real SOL, after a first buy, with rules and past the target, the test of the sell past the real SOL, and two unit tests |
| a sell past the real reserve quoted (the check and the subtraction after it) | the curve pool after a first buy, the rules pool on the curve, the test of the sell past the real SOL, and two unit tests |
| the old rule: a pool whose real quote reserve is zero is not routed | the curve pool with no real SOL, and one unit test |
| every pool launched on the curve left out | the five curve pools, the test of the sell past the real SOL, and two unit tests |

The copy of the math holds the real reserve twice: the explicit check, then the subtraction
of the gross output from the real reserve, which fails when it would go below zero. With
only one of the two lines broken every test passes and no number changes.

### What you need to run them

* Linux, or WSL on Windows. `test.sh` keeps the build output outside the source folder,
  in `$HOME/targets/programmable-jupiter` (`CARGO_TARGET_DIR` changes it).
* Rust 1.85 or newer with `cargo` (the crate is edition 2024). The first build downloads
  the Jupiter crates from GitHub at the commit pinned in `Cargo.toml`; after that the
  suite runs offline.
* Nothing else for the tests themselves: the programs they execute are the `.so` files
  in `tests/fixtures`, and the accounts are the snapshots in `tests/fixtures/accounts`.
* For the helper scripts below: Node (they were run with Node 24), `npm install` at the
  root of the repository, and the built SDK (`sdk/dist`).

### The fixtures, and how to make them again

The fixtures in `tests/fixtures/accounts` are snapshots of seventeen pools of one chain: the
local test validator, where every kind of pool exists. The addresses of those pools are
the constants at the top of `tests/parity.rs`. They are used for offline runs too, since
each snapshot folder is named after its pool.

They go stale in four cases: the local validator was started again from nothing (the
pools are gone, so `REFRESH` finds nothing to snapshot), the program ids changed (pool
addresses follow the program id, and so does every hook caller), an account layout
changed, or a program changed what it does in a swap. Then make them again:

```
node jupiter-adapter/scripts/make-fixtures.mjs localnet
RPC=http://127.0.0.1:8899 REFRESH=1 FRESH_PROGRAMS=1 bash jupiter-adapter/test.sh
```

* The first command launches the seventeen coins: twelve seeded, five on the curve. It
  closes the treasury of one of the two tax coins and makes one trade on it so that a fee
  waits, and buys two of the curve coins past their graduation target, one with
  `graduate` in the same transaction and one without. It waits until the launches are
  final (the test kit reads accounts at the `finalized` commitment), writes the new
  addresses into `tests/parity.rs` and deletes the old snapshots. It signs with the
  deployer wallet of the cluster, which needs about 230 SOL, most of it for the two buys
  to the target (`scripts/cluster.mjs` says where that key is read from). On the local
  validator it tops that wallet up by airdrop when it holds less. It stops when the
  platform's curve settings are not the defaults the tests assert, 30 virtual SOL and 85
  SOL to graduate.
* Run the second command within the hour. Two fixtures must still be inside a window
  when they are snapshotted: a launch guard, whose longest window is 10,800 slots, about
  72 minutes, and a rules coin with a sniper window of 10,800 slots and a limit window
  of 9,000 slots, about one hour. Snapshotted later, the tests of those pools fail and
  tell you: the assertion that the buy fee is above the pool fee, the assertion that a
  buy above the limit is refused, and the two tests that must fail inside. Run it soon
  for a third reason: the curve pool past its target must still be on the curve, and
  anyone may graduate it (the platform's watcher does). Snapshotted after that, its test
  says the pool is not on the curve any more.
* `FRESH_PROGRAMS=1` copies the six programs from the workspace's build output
  (`$HOME/targets/sol-hooks/deploy`, or `PROGRAMMABLE_DEPLOY_DIR`) into `tests/fixtures`. Use
  it after any change to the pool program or a template hook: a quote that no longer
  matches fails here first. Without it the committed copies are used. The copies in this
  folder are the programs of the curve launch that ran on the test chain on 2026-10-16
  (the pool program's sha256 starts `ab5ccf55`); their hashes are the ones the programs'
  build reported.
* With `REFRESH` the tests run one at a time, because several of them read the fixtures
  of the same pool.
* Anyone may reopen the closed treasury of the `TAX_CLOSED` coin on the chain and collect
  its fees. If that has happened since the fixtures were made, a refresh fails the test
  of that pool, which requires the treasury to be missing: run `make-fixtures.mjs` again.

Before a submission to Jupiter: deploy, put the mainnet pool addresses in
`tests/parity.rs`, and run with `RPC` and `REFRESH`.

### Helper scripts

All in `scripts/`, run from the root of the repository with Node.

| Script | What it does |
|---|---|
| `make-fixtures.mjs <cluster>` | launches the fixture coins and rewrites the addresses in `tests/parity.rs`, as described above |
| `launch-guard-pool.mjs <cluster>` | launches one coin on the launch guard with the longest window, to replace only that fixture by hand |
| `list-pools.mjs [rpc url]` | lists the pools of a cluster by kind, with reserves, flags and, for a launch guard or a rules coin, its rates and whether its windows still run |
| `measure-cu.mjs <pool> [<pool> ...]` | simulates a buy of 0.1 SOL on each pool of the local validator and prints the compute units of the swap instruction alone (no `graduate` after it) |

## Why this crate stands alone

Jupiter's interface and test kit use a newer generation of the Solana crates (LiteSVM
0.14, `solana-pubkey` 4) than the programs next door (Anchor 1.2, Solana 3.x). One
lockfile cannot hold both. This crate is its own workspace and depends on none of the
program crates: `src/state.rs` decodes the accounts by hand, and `src/math.rs` is a copy
of the pool's swap math with the same vectors as the program's unit tests. The parity
suite is what keeps the copy honest.

`Cargo.lock` started from the lockfile of the `jupiter-amm-interface` repository. Its
README explains why: LiteSVM 0.14 breaks with the 3.2 releases of `solana-clock`. Do not
`cargo update` past those pins without moving LiteSVM too. The interface and the kit are
taken from the same git commit so that the trait the kit asserts on is the trait
implemented here; `jupiter-amm-interface` 0.6.1 on crates.io is that commit's `interface`
crate.

The program ids in `src/lib.rs` are the ids of this build. A deployer who gives the
programs other ids runs `scripts/rekey.mjs` of the repository, which rewrites them here
too, and then makes the fixtures again. Apart from the fixture pools in
`tests/parity.rs`, no derived address is written in this crate: the platform, the hook
callers and the configs are derived from the ids when they are needed.

## Not covered

* Exact-out quotes. The pool has no exact-out swap.
* Pegged coins and strict coins. See the table above.
* A largest buy as a number. Jupiter's trait has no field for it: inside the limit
  window of a rules coin a buy above the limit is an error from `quote`, as described
  above.
* Compute budget. Measured on the local validator on 2026-10-13 for the swap instruction
  alone, a buy of 0.1 SOL on the fixture pools (`scripts/measure-cu.mjs`): no hook
  29,066 units, tax 48,466 (49,350 on the fixture whose fee waits for a closed
  treasury), buyback 46,920, launch guard 46,856 inside its window and 43,362 after it,
  collectible with a ticket 53,766, rules 44,791 with a creator fee, 44,791 with three
  rates and 52,537 inside its sniper window. The figures move by a few thousand units
  from pool to pool, with the pool's addresses, so two pools of one kind differ more
  than two kinds do. The kit runs every swap with the maximum budget. The curve adds a
  few hundred units: measured on 2026-10-16, no hook 29,255 seeded against 29,485 to
  29,507 on the curve, before and after graduation; rules 45,414 seeded and 46,018 on the
  curve.
* `graduate`. See "Pools on the curve" above: the platform sends it, not a router.
* Submission. Jupiter also asks for a security audit and for traction. See
  `../LISTINGS.md`.
