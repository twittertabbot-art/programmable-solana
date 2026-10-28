# Integrating the pools: for bots, aggregators, other DEXes and indexers

This is everything an outside system needs to find the pools, quote them, trade them and
index them. Nothing here needs the TypeScript SDK or the website.

Two files turn this document into running code. Both use `@solana/web3.js` and nothing
else.

* `scripts/raw-swap-example.mjs` quotes and trades every kind of pool, pools on the curve
  included, sends a coin from one wallet to another with the accounts its transfer hook
  needs, graduates a pool on the curve, and decodes swap events by hand. Every offset and
  byte below is the one it uses.
* `node scripts/check-integrators-doc.mjs <rpc url>` reads the pools of a cluster and checks
  every offset, discriminator, seed and formula of this document against them, by reading
  accounts and simulating instructions. It sends no transaction.

## 1. What you are integrating

* A pool is a constant-product market (`x * y = k`) between one coin (the **base**) and one
  **quote** token. The launchpad's site and SDK quote every coin in wrapped SOL.
* A **buy** sends quote and receives base. A **sell** sends base and receives quote.
* Swaps are exact-input with a minimum output. There is no exact-output swap.
* A pool may name one **hook** program, fixed when the pool is created. The pool calls the
  hook around swaps. The hook never touches funds. It can answer with a fee, and the pool
  holds every answer to caps set on the platform account:
  * a hook fee, in the quote token, for a treasury fixed at pool creation, at most
    `max_hook_fee_bps`;
  * a replacement for the pool fee on one trade, at most `max_fee_override_bps`;
  * an output of its own, only if the pool carries the `OVERRIDE_CURVE` flag. The
    launchpad refuses such hooks, so no launched coin has one.
* A hook can also refuse a trade, by failing. Of the five platform templates one does: the
  rules template refuses a buy above the coin's buy limit during its first slots
  (section 6). As a pool hook, none of the five can refuse a sell. A strict coin of the
  rules template is different: the hook also runs inside every transfer of the coin, and
  while the coin's windows run it can refuse a sell or a send (section 9 has every case).
* A hook is called on a direction only when the pool's flags say so. A pool without
  `CALL_ON_SELL` never calls its hook on a sell, so that hook can neither tax nor block a
  sell. The flags never change after the pool is created.
* A hook whose flags carry a liquidity bit is also asked when liquidity is added or
  removed. Two templates use that to keep new liquidity out during their launch window
  (section 11). No template is asked when liquidity is removed.
* The reserves are fields of the pool account, not the vault balances. One account read
  gives both. A vault holds more than its reserve (section 5).
* A pool may have been **launched on the curve** (section 14). Such a pool prices the coin
  with SOL it does not hold, its virtual quote, pays sells from the real SOL only, and
  refuses liquidity until it graduates. Graduation drops the virtual part and burns coins
  from the pool so that the price stays where it was. The pool keeps its address for the
  coin's whole life: there is no second pool and no migration.

What every pool guarantees, whoever created it:

* The coin has no freeze authority. Nobody can freeze the pool's vault or your account.
* A Token-2022 coin carries no extension except its own name (metadata pointer, token
  metadata) and, on a pegged coin or a strict coin (section 9), a transfer hook that is
  the pool's own platform hook. There are no transfer-fee coins: the amount that arrives is the amount
  that was sent.
* The hook program was either frozen when the pool was created (no upgrade authority, so
  its code can never change) or upgradeable only by a key on the platform's whitelist,
  which is how the five templates are run. Byte 367 of the pool says which. A frozen
  hook's own settings may still change, if its code allows it: frozen code, not a frozen
  answer.

What only a coin launched through the launchpad guarantees: no mint authority, and all
the launch liquidity locked forever (section 11). Such a coin has a launch record
(section 4). A pool on the curve gives both guarantees whoever created it: the pool
program itself requires a closed mint whose whole supply goes into the pool, and puts
every LP share into the lock account when the pool is created (section 14). `create_pool` of the pool program is open to anyone, so a pool without a
launch record may have a coin that can still be minted, liquidity its creator can
withdraw, and any quote token. Check for the launch record before you list a pool.

## 2. Four ways in

| Way | Use it when | Where |
|---|---|---|
| HTTP trade API | you want a quote and a ready-to-sign transaction with two HTTP calls | `API.md` |
| TypeScript SDK | you build a site or a bot in JavaScript and want every instruction | `sdk/README.md` |
| The raw instruction | you run your own stack, in any language | this document, `scripts/raw-swap-example.mjs` |
| Jupiter `Amm` trait, in Rust | you are a router that takes adapters in Jupiter's format | `jupiter-adapter/` |

The Anchor IDL of every program is in `idl/`.

## 3. Addresses

These are the program ids of this build. They are the same on every cluster where this
build is deployed. Whoever deploys the programs may give them ids of their own first
(`scripts/rekey.mjs` rewrites every id in the repository, this document included), so
take the ids from the copy of this document that ships with the deployment you
integrate.

| Program | Id |
|---|---|
| the pool program (`hookpool`) | `7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh` |
| the launchpad (`hooklaunch`) | `9cDfF7wD6EirDZbb5DWCw3HZ3ZPQ1oeh87YyMGvbPRxi` |
| hook: tax | `jwdXDuSQ9pNV1pXj8BFvBb5fhqtTL3duQkwsTjXunhr` |
| hook: launch guard | `G59xnMnbenifbGR1y6QjaTRa6wa1FFfqZB3KZBUyckPW` |
| hook: buyback | `3M824Hn8Z6S7r1t1zqpNQpioKFd31jrQwSN2oxV2ovo5` |
| hook: collectible | `3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m` |
| hook: launch rules | `3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr` |

Derived addresses. Seeds are ASCII strings unless they name an account.

| Account | Seeds | Program |
|---|---|---|
| platform | `"platform"` | pool program |
| pool | `"pool"`, base mint, quote mint | pool program |
| base vault, quote vault | `"vault"`, pool, mint (also stored in the pool account) | pool program |
| LP mint | `"lp"`, pool (also stored in the pool account) | pool program |
| LP lock account | `"lp-lock"`, pool (also stored in the pool account) | pool program |
| hook caller (signs the pool's calls into one hook program) | `"caller"`, hook program | pool program |
| event authority | `"__event_authority"` | the program that emits the event: the pool program, the launchpad, the buyback hook, the rules hook |
| a hook's manifest | `"manifest"` | the hook program |
| a hook's extra-accounts list | `"extra-metas"` (also stored in the pool account) | the hook program |
| a template hook's per-pool config | `"cfg"`, pool | the hook program |
| the hook's authority for a pool: it owns the treasury | `"hook-authority"`, pool | the buyback hook, the rules hook |
| stake vault of a rules pool | `"stake-vault"`, pool | the rules hook |
| stake record of a wallet on a rules pool | `"stake"`, pool, wallet | the rules hook |
| creator lock of a rules pool: record, vault | `"lock"`, pool and `"lock-vault"`, pool | the rules hook |
| holder record of a wallet on a strict coin | `"holder"`, pool, wallet | the rules hook |
| a coin's own account list, read by Token-2022 in every transfer (pegged and strict coins) | `"extra-account-metas"`, base mint | the coin's transfer hook: the collectible hook or the rules hook |
| launch record of a coin | `"launch"`, base mint | launchpad |

The pool of a coin against SOL is `["pool", coin mint, So11111111111111111111111111111111111111112]`.
The same two mints in the other order would be a different pool with buy and sell
reversed. The launchpad never creates one; treat the coin's SOL pool as its market.

**The hook caller.** The pool signs its calls into a hook with an address of its own, and
that address is different for every hook program:

```
hook caller = PDA(["caller", hook program], pool program)
```

The hook program is the 32 bytes at pool offset 267. A pool without a hook has the system
program there, 32 zero bytes, and its caller is derived from those. Every instruction
that carries a hook caller (`swap`, `add_liquidity`, `remove_liquidity`, `create_pool`)
checks it against the hook program account of the same instruction, also when no hook
runs, and fails with Anchor 2006 `ConstraintSeeds` on any other address. For the ids
above:

<!-- callers -->
| Pool's hook | Hook program | Hook caller |
|---|---|---|
| none | the system program, `11111111111111111111111111111111` | `4KAaLB15b1x5mkDcZn9MZAmsspzHbYYnSmdbGiufYFXW` |
| tax | `jwdXDuSQ9pNV1pXj8BFvBb5fhqtTL3duQkwsTjXunhr` | `26BWz6HmVq56Yz2sMVCZd1dtXuGy7chR5aCXr922bvBa` |
| launch guard | `G59xnMnbenifbGR1y6QjaTRa6wa1FFfqZB3KZBUyckPW` | `CMSeHgr5DRi3oiwXsVZqxgNhYgCEBB2qXxzdr29ScGS8` |
| buyback | `3M824Hn8Z6S7r1t1zqpNQpioKFd31jrQwSN2oxV2ovo5` | `HqPtMeLYma3cUC6wTx28XPzTWaEAFcCXpeTQh4ynYFjq` |
| collectible | `3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m` | `CWG2sKGDNGQ3ijGBnh2q6CKzYeiZKGTHUWkLMHWkthWA` |
| launch rules | `3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr` | `G34yNuoVSXdpyhQg5V7h9PX8Qwq65RGZXWe4QiF8ozc7` |

A pool on any other hook program has the caller of that program: derive it, do not look
it up. There is no caller that fits every pool: `["caller"]` alone, without a hook
program, is an address no pool accepts. The six addresses above follow from the program
ids. If the ids of your deployment differ, derive them again; the check script fails
when a row does not match the ids it runs with.

**The lookup table.** Transactions fit more easily with the address lookup table the
operator creates at deployment. Its address is different on every deployment: read the
`lookupTable` field of `web/deployments/<cluster>-alt.json`, or ask the operator. It
holds the seven program ids, the platform account and its treasury, the hook caller of a
pool without a hook and of each of the five templates, the event authorities of the pool
program, the launchpad, the buyback hook and the rules hook, the manifest, the
extra-accounts list and the program data account of each template hook, the wrapped SOL
mint, the rent sysvar, and the token, Token-2022, associated token, system, compute
budget, Metaplex Token Metadata and Metaplex Core programs: 43 addresses. It does not
hold the caller of a third-party hook. It is optional for a swap: every trade
`scripts/raw-swap-example.mjs` sends fits in a transaction without it. Pass its address
to the check script with `--lookup-table` to have its contents checked.

## 4. Finding pools

```
getProgramAccounts(pool program, filters: [ memcmp(offset 0, bytes "hQrXeCntzbV") ])
```

`hQrXeCntzbV` is the base58 form of the discriminator of a pool account,
`[241,154,109,4,17,177,109,188]`, in hex `f19a6d0411b16dbc`. Add
`memcmp(offset 9, coin mint)` for one coin, or `memcmp(offset 267, hook program)` for the
pools of one hook. `memcmp(offset 522, "2")` finds the pools on the curve and
`memcmp(offset 522, "3")` the graduated ones: `2` and `3` are the bytes 1 and 2 in
base58. A pool account is always 528 bytes.

Every launch leaves a record: an account of the launchpad at `["launch", base mint]` with
the discriminator `[144,51,51,163,206,85,213,38]` (base58 `R7vQE78exjo`), and a `Launched`
event (section 10).

<!-- layout:launch size=265 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 32 | dev, the wallet that launched |
| 41 | 32 | pool |
| 73 | 32 | base mint |
| 105 | 32 | quote mint |
| 137 | 32 | hook program (all zeros when none) |
| 169 | 8 | LP locked by the launch |
| 177 | 8 | launch fee paid, lamports |
| 185 | 8 | dev buy, quote units (0 when the dev bought nothing) |
| 193 | 8 | slot of the launch |
| 201 | 64 | reserved. Byte 201 is 1 for a launch on the curve (`launch_curve`) and 0 for a seeded launch; the other 63 bytes are zeros |

## 5. The pool account and the platform account

Anchor accounts: an 8-byte discriminator, then the fields in order, little endian.

Pool (528 bytes):

<!-- layout:pool size=528 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 32 | base mint |
| 41 | 32 | quote mint |
| 73 | 32 | base vault |
| 105 | 32 | quote vault |
| 137 | 32 | LP mint |
| 169 | 32 | LP lock account |
| 201 | 32 | base token program (SPL Token, or Token-2022) |
| 233 | 32 | quote token program |
| 265 | 2 | `lp_fee_bps`, the pool fee |
| 267 | 32 | hook program. All zeros (the system program) when the pool has no hook |
| 299 | 4 | hook flags |
| 303 | 32 | the hook's extra-accounts list |
| 335 | 32 | hook treasury, a quote token account. All zeros when the hook takes no fee |
| 367 | 1 | hook kind: 0 none, 1 frozen custom hook, 2 platform template |
| 368 | 8 | `reserve_base` |
| 376 | 8 | `reserve_quote` |
| 384 | 8 | protocol fees owed, base |
| 392 | 8 | protocol fees owed, quote |
| 400 | 8 | hook fees charged so far, quote: paid to the treasury or still waiting |
| 408 | 8 | volume so far, quote |
| 416 | 8 | number of swaps |
| 424 | 8 | slot of creation |
| 432 | 32 | creator |
| 464 | 8 | `hook_fees_owed_quote`: hook fees that wait for the treasury (section 6) |
| 472 | 32 | `hook_treasury_owner`: the wallet whose associated token account the treasury is. All zeros when the hook takes no fee |
| 504 | 8 | `virtual_quote`: quote counted in the price while the pool is on the curve, and not held. 0 on a seeded pool and after graduation (section 14) |
| 512 | 8 | `graduation_target`: the `reserve_quote` at which anyone may graduate the pool. 0 on a seeded pool and after graduation |
| 520 | 2 | `graduation_fee_bps`: the share of the target graduation takes for the platform. Kept after graduation as a record |
| 522 | 1 | `curve_state`: 0 a seeded pool, 1 on the curve, 2 graduated |
| 523 | 5 | reserved, zeros |

`reserve_quote` is always the real quote reserve, the quote the pool holds and pays out.
A pool made before the curve existed has zeros from 504 on: it reads as a seeded pool.

What a vault holds:

```
base vault balance   = reserve_base  + protocol fees owed, base
quote vault balance  = reserve_quote + protocol fees owed, quote + hook_fees_owed_quote
```

The virtual quote is in no vault. Price in quote per base is
`(reserve_quote + virtual_quote) / reserve_base`, adjusted for the two decimals; off the
curve `virtual_quote` is 0 and this is `reserve_quote / reserve_base`. Never derive a price
or a quote from a vault balance.

Platform (451 bytes, discriminator `[77,92,204,58,187,98,91,12]`):

<!-- layout:platform size=451 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 32 | admin |
| 41 | 32 | pending admin |
| 73 | 32 | treasury, the wallet that receives protocol fees and launch fees |
| 105 | 2 | `protocol_fee_bps`, taken from the input of every swap |
| 107 | 2 | `max_lp_fee_bps` |
| 109 | 2 | `max_hook_fee_bps` |
| 111 | 2 | `max_fee_override_bps` |
| 113 | 8 | launch fee, lamports |
| 121 | 1 | paused: swaps, new pools and new liquidity stop; removing liquidity never does |
| 122 | 1 | number of whitelisted hook authorities |
| 123 | 256 | the whitelist, eight public keys |
| 379 | 8 | number of pools created |
| 387 | 8 | `curve_virtual_quote`: the virtual quote a new pool on the curve gets |
| 395 | 8 | `curve_graduation_target`: the graduation target a new pool on the curve gets |
| 403 | 2 | `curve_graduation_fee_bps`: the graduation fee a new pool on the curve gets, at most 1,000 |
| 405 | 1 | `hook_approval_required`: 1 while only approved outside hooks may open pools (HOOKS.md section 6.1) |
| 406 | 45 | reserved, zeros |

A pool on the curve copies the three settings at 387 to 403 when it is created, and keeps
its copy: a later change reaches new pools only. Either of the first two at 0 switches
curve launches off. Read a running pool's numbers from the pool, never from here.

The account can be longer than 451 bytes: the approved list follows the fixed part. Byte
451 holds a u32 little-endian count, then come 32 bytes per approved hook program, in no
particular order. An account of exactly 451 bytes has no list. A router needs the list only
to explain a refused pool creation: it never changes a swap, and a pool whose hook was taken
off the list later trades as before. The SDK reads it into `approvedHooks`
(`decodeApprovedList` for the raw bytes).

Hook flags:

| Bit | Name | Meaning for a trade |
|---|---|---|
| 0 | `BEFORE_SWAP` | the hook is asked before the curve runs. Only this answer can change the amounts |
| 1 | `AFTER_SWAP` | the hook is told after the transfers. It cannot change the amounts. It can fail the swap |
| 2, 3 | `BEFORE_ADD_LIQ`, `AFTER_ADD_LIQ` | the hook is called when liquidity is added, and can refuse it |
| 4, 5 | `BEFORE_REMOVE_LIQ`, `AFTER_REMOVE_LIQ` | the hook is called when liquidity is removed |
| 6 | `ON_POOL_CREATE` | the hook was called once, when the pool was created |
| 8 | `OVERRIDE_FEE` | may replace the pool fee for one trade |
| 9 | `TAKE_HOOK_FEE` | may take a fee in the quote token |
| 10 | `OVERRIDE_CURVE` | may set the output. Never on a launched coin |
| 12 | `CALL_ON_BUY` | swap callbacks run on buys |
| 13 | `CALL_ON_SELL` | swap callbacks run on sells |

A swap callback runs only when its own bit and the bit of the direction are both set.

Every pool on a platform template carries the flags of that template:

<!-- flags -->
| Template | Flags | Bits |
|---|---|---|
| tax | 12,865 | `BEFORE_SWAP`, `ON_POOL_CREATE`, `TAKE_HOOK_FEE`, `CALL_ON_BUY`, `CALL_ON_SELL` |
| launch guard | 4,421 | `BEFORE_SWAP`, `BEFORE_ADD_LIQ`, `ON_POOL_CREATE`, `OVERRIDE_FEE`, `CALL_ON_BUY` |
| buyback | 12,865 | `BEFORE_SWAP`, `ON_POOL_CREATE`, `TAKE_HOOK_FEE`, `CALL_ON_BUY`, `CALL_ON_SELL` |
| collectible | 4,162 | `AFTER_SWAP`, `ON_POOL_CREATE`, `CALL_ON_BUY` |
| rules | 13,125 | `BEFORE_SWAP`, `BEFORE_ADD_LIQ`, `ON_POOL_CREATE`, `OVERRIDE_FEE`, `TAKE_HOOK_FEE`, `CALL_ON_BUY`, `CALL_ON_SELL` |

## 6. Quoting

All divisions are integer divisions. Fees round up, the curve rounds down.

```
fee(x, bps)   = ceil(x * bps / 10000)

quote side    = reserve_quote + virtual_quote      (pool offsets 376 and 504; virtual_quote is 0 off the curve)
on a buy:       reserve_in = quote side,  reserve_out = reserve_base
on a sell:      reserve_in = reserve_base, reserve_out = quote side

protocol_fee  = fee(amount_in, protocol_fee_bps)
left          = amount_in - protocol_fee
hook_fee_in   = fee(left, hook_fee_bps)            on a buy, else 0
left          = left - hook_fee_in
lp_fee        = fee(left, fee_override_bps if the hook gave one, else lp_fee_bps)
net_in        = left - lp_fee
gross         = reserve_out * net_in / (reserve_in + net_in)
hook_fee_out  = fee(gross, hook_fee_bps)           on a sell, else 0
amount_out    = gross - hook_fee_out
```

The program refuses a swap whose `net_in` or `amount_out` is zero, or whose `gross`
rounds to zero, a dust trade (error 6006). It refuses one where a hook that owns the
price curve answered an output of zero or not below `reserve_out` (error 6035; no
launched coin has such a hook). On a pool on the curve it refuses a sell whose `gross` is
above `reserve_quote`, the real quote reserve (error 6049): the virtual quote is counted
in the price and is never paid out. Section 14 shows why no sell on chain can reach that
bound. Do not quote such a sell.

After the swap, in the pool account. The reserve fields hold real amounts, and the
virtual quote does not move:

```
reserve_in                          += net_in + lp_fee      (the real field: reserve_base or reserve_quote)
reserve_out                         -= gross
protocol fees owed, input side      += protocol_fee
hook fees charged so far (400)      += hook_fee_in + hook_fee_out
volume (408)                        += amount_in on a buy, gross on a sell
number of swaps (416)               += 1
```

This holds for every swap, whether the hook fee was paid out or not.

`hook_fee_bps` and `fee_override_bps` come from the hook's `before_swap`. They are zero
and none when the pool has no hook, when `BEFORE_SWAP` is not set, or when the bit of the
direction is not set. For the five platform templates the answer is read from the hook's
per-pool config, `["cfg", pool]` under the hook program:

| Hook | Answer | Config fields (offset, size) |
|---|---|---|
| tax | `hook_fee_bps` = buy tax on a buy, sell tax on a sell | buy 73, 2; sell 75, 2 |
| buyback | `hook_fee_bps` = buy share on a buy, sell share on a sell | buy 138, 2; sell 140, 2 |
| launch guard | on buys only, while the window runs: `fee_override_bps = start_fee - (start_fee - lp_fee_bps) * (slot - start_slot) / guard_slots`. Nothing once `slot - start_slot >= guard_slots`, or when `start_fee <= lp_fee_bps` | start slot 41, 8; guard slots 49, 8; start fee 57, 2 |
| rules | `hook_fee_bps` = the three rates of the side added up. On buys only, while the sniper window runs, also a `fee_override_bps`, by the launch guard's line. A buy above the buy limit, inside its window, fails. See "Rules pools" below | buy rates 180, 6; sell rates 186, 6; sniper slots 170, 8; start fee 178, 2; buy limit 192, 8; limit slots 200, 8; start slot 216, 8 |
| collectible | nothing. It runs after buys, takes no fee and changes no amount | none needed |

The pool clamps what a hook answers: `hook_fee_bps` to `max_hook_fee_bps`,
`fee_override_bps` to `max_fee_override_bps`. Clamp the same way.

### Rules pools

A rules coin is launched with a set of rules that nobody can change afterwards: bytes 8 to
239 of its config never change once the pool exists. A quote needs four things from the
config and the current slot. It needs nothing about staking: what a trader pays does not
depend on who staked.

```
elapsed       = slot - start_slot                                   (config offset 216)

hook_fee_bps  = creator_bps + holders_bps + burn_bps of the side    (buys 180, 182, 184; sells 186, 188, 190)
                clamped to max_hook_fee_bps

on a buy:
  refused       when max_buy_quote > 0 and elapsed < limit_slots and amount_in > max_buy_quote
                                                                    (192 and 200)
  fee_override_bps = start_fee - (start_fee - lp_fee_bps) * elapsed / sniper_slots
                when sniper_slots > 0 and elapsed < sniper_slots and start_fee > lp_fee_bps
                                                                    (170 and 178)
                clamped to max_fee_override_bps
on a sell:      no limit and no override, ever
```

* **The three rates.** Every trade pays all three rates of its side as one hook fee. The
  pool pays it to the hook's treasury, and the hook splits it later between the launcher,
  the stakers and the burn pot (section 13). A rate may be zero on one side and not on
  the other.
* **The sniper window.** For the first `sniper_slots` slots a buy pays a pool fee that
  starts at `start_fee` and falls in a straight line to the pool's own fee. It covers
  `elapsed` 0 to `sniper_slots - 1`. The fee goes to the pool's liquidity, as any pool
  fee does. A config has both numbers or neither; both zero means no sniper fee.
* **The buy limit.** For the first `limit_slots` slots one buy may send at most
  `max_buy_quote` raw units of the quote token. `amount_in` is the whole input of the
  swap, before any fee. A buy of exactly the limit passes. A buy above it gets nothing:
  the hook fails and the whole swap fails with it, error 6017 `BuyTooLarge` of the rules
  hook. Nothing is filled in part. The limit is per swap, so a wallet can buy several
  times. Do not quote a buy above the limit; offer it again from slot
  `start_slot + limit_slots`. Both numbers zero means no limit.
* **The two windows are separate.** Each has its own length, and both start in the slot
  the pool was created (config offset 216, the same number as pool offset 424).
* **The platform caps.** When the platform's `max_hook_fee_bps` is below the three rates
  together, the trade pays the cap. The program holds the three rates of one side to
  1,000 bps together and the sniper start fee to 5,000 bps.

### The template configs

<!-- layout:tax_config size=111 -->
| Offset | Size | Field (tax config, 111 bytes, discriminator `[38,187,35,231,115,102,30,82]`) |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 32 | pool |
| 41 | 32 | owner, who may change the tax. All zeros: renounced, the tax can never change |
| 73 | 2 | buy tax, bps |
| 75 | 2 | sell tax, bps |
| 77 | 2 | ceiling, bps. The owner can set both taxes anywhere up to it, at any time |
| 79 | 32 | creator of the config |

<!-- layout:guard_config size=91 -->
| Offset | Size | Field (launch guard config, 91 bytes, discriminator `[95,175,118,50,193,113,37,250]`) |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 32 | pool |
| 41 | 8 | start slot, the slot the pool was created in |
| 49 | 8 | guard slots, the length of the window |
| 57 | 2 | start fee, bps |
| 59 | 32 | creator of the config |

<!-- layout:buyback_config size=230 -->
| Offset | Size | Field (buyback config, 230 bytes, discriminator `[226,30,39,139,66,159,153,171]`) |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 1 | bump of the hook authority |
| 10 | 32 | pool |
| 42 | 32 | base mint |
| 74 | 32 | quote mint |
| 106 | 32 | treasury, the pool's hook treasury |
| 138 | 2 | buy share, bps |
| 140 | 2 | sell share, bps |
| 142 | 8 | smallest treasury balance a buyback runs on, at most 1,000,000,000 |
| 150 | 8 | quote spent by buybacks so far |
| 158 | 8 | coins burned by buybacks so far |
| 166 | 8 | number of calls that bought |
| 174 | 32 | creator of the config |
| 206 | 8 | the observation: the slot it was taken in (section 12) |
| 214 | 8 | the observation: `reserve_base`. Zero while there is no observation |
| 222 | 8 | the observation: the quote reserve, `reserve_quote + virtual_quote` (section 12). Zero while there is no observation |

<!-- layout:rules_config size=414 -->
| Offset | Size | Field (rules config, 414 bytes, discriminator `[187,99,136,70,234,55,67,212]`) |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 1 | bump of the hook authority |
| 10 | 32 | pool |
| 42 | 32 | base mint |
| 74 | 32 | quote mint |
| 106 | 32 | treasury, the pool's hook treasury |
| 138 | 32 | creator: the wallet that launched. It receives the creator fee and makes the lock |
| 170 | 8 | `sniper_slots`, the length of the sniper window. 0: no sniper fee |
| 178 | 2 | `sniper_start_fee_bps`, the pool fee of a buy in the first slot |
| 180 | 6 | rates of a buy, three u16: `creator_bps`, `holders_bps`, `burn_bps` |
| 186 | 6 | rates of a sell, the same three |
| 192 | 8 | `max_buy_quote`, the most one buy may send inside the limit window. 0: no limit |
| 200 | 8 | `limit_slots`, the length of the limit window |
| 208 | 8 | `creator_lock_seconds`, the lock the launcher declared (section 13). 0: none |
| 216 | 8 | `start_slot`, the slot the pool was created in |
| 224 | 8 | `start_time`, the clock time the pool was created at, i64 |
| 232 | 8 | `min_eligible`: stakers earn while at least this much is staked. A thousandth of the coin's supply at launch |
| 240 | 8 | `fees_seen`: the hook fees settled so far (section 13) |
| 248 | 6 | `last_split`, three u16: the rates of the last trade's side, for settling its fee |
| 254 | 8 | `creator_owed`: quote units the creator can claim, as of the last settlement |
| 262 | 8 | `burn_pot`: quote units waiting to buy and burn, as of the last settlement |
| 270 | 16 | `acc_per_share`, u128: rewards per staked unit so far, times 10^12 |
| 286 | 8 | `reward_rem`: remainder of the last division, carried forward |
| 294 | 8 | `total_staked` |
| 302 | 8 | `rewards_owed_total`: the sum of what the stake records are owed |
| 310 | 8 | quote paid to the creator so far |
| 318 | 8 | quote paid to stakers so far |
| 326 | 8 | quote spent by burns so far |
| 334 | 8 | coins burned so far |
| 342 | 8 | number of calls of `run_burn` that bought |
| 350 | 8 | the observation: the slot it was taken in (section 12) |
| 358 | 8 | the observation: `reserve_base`. Zero while there is no observation |
| 366 | 8 | the observation: the quote reserve, `reserve_quote + virtual_quote` (section 12). Zero while there is no observation |
| 374 | 1 | `kind`: 0 a plain coin, 1 a strict coin (section 9). Fixed when the config is made |
| 375 | 1 | `buy_mark`: set inside a buy only; 0 whenever the account can be read |
| 376 | 1 | strict coin: the bump of the pool's vault of the coin, written when the pool is created |
| 377 | 2 | strict coin: `max_wallet_bps`, the max wallet as a share of the supply. 0: none |
| 379 | 2 | strict coin: `early_slots`, the early window. 0: no early lock |
| 381 | 4 | strict coin: `max_wallet_slots`, how long the max wallet runs |
| 385 | 4 | strict coin: `early_unlock_slots`: early coins are locked until `start_slot` + this |
| 389 | 8 | strict coin: `max_wallet_amount` = max(1, supply * `max_wallet_bps` / 10000), written when the pool is created |
| 397 | 17 | reserved, zeros |

A tax owner can change the tax between your quote and your trade. Read the config with
every quote, and set a minimum output. The rules of a rules pool cannot change, so its
rates and windows can be read once; the running numbers from offset 240 on move with
every trade. On a plain coin bytes 374 to 413 are zeros. On a strict coin byte 374 and
bytes 376 to 396 never change once the pool exists, byte 375 is 0 between instructions,
and bytes 397 to 413 stay zero.

### When a quote is exact

* No hook, tax, buyback, collectible, and rules outside its sniper window: exact to the
  last unit. Also on the curve. A pool on the curve that stands at or past its graduation
  target is about to graduate: send `graduate` in front of the trade and quote the trade
  on the pool as graduation leaves it, which is exact whoever graduates first (section
  14).
* Launch guard and rules, on a buy inside the window: the chain uses the slot the
  transaction lands in. The fee only falls, so the buyer receives the quoted amount or
  more.
* Rules, on a buy inside the limit window: a buy above the limit fails, whatever was
  quoted. A buy quoted as refused goes through once the window is over.
* Any other hook, on a direction where `BEFORE_SWAP` runs: not predictable. The hook may
  take any fee up to the cap. Quote by simulation, below.
* Any other hook, on a direction where only `AFTER_SWAP` runs: the formula gives the
  amount, but the hook can refuse the trade.
* Any other hook, on a direction where the pool does not call it: plain curve math, exact.

### Quoting by simulation

A swap returns its `amount_out` as return data, 8 bytes, little endian, set by the pool
program. Simulate a transaction and read it. This is exact for every pool, including
hooks nobody has seen before.

* The swap must be the last instruction of the simulated transaction: an instruction
  after it clears the return data. Give it a minimum of zero.
* The account the input leaves must exist and hold the amount. For a buy, put the wrap
  instructions before the swap (create the wrapped SOL account, transfer, `SyncNative`).
* Call `simulateTransaction` with `sigVerify: false` and `replaceRecentBlockhash: true`.
  No signature is needed, so any funded wallet can be the fee payer.
* The value is `returnData.data[0]`, base64, and `returnData.programId` is the pool
  program.

### The hook fee and its treasury

The hook fee belongs to the treasury at pool offset 335, a quote token account. For a tax
coin that is by default the wrapped SOL associated account of the coin's dev: an ordinary
token account, which its owner can close. A closed treasury never stops trades and never
costs the hook its fee:

* A swap that finds the treasury account missing still charges the fee. The trader pays
  and receives exactly what the formula says. The fee stays in the quote vault and is
  added to `hook_fees_owed_quote` (offset 464). It is not part of `reserve_quote`.
* The next swap that charges a hook fee and finds the treasury alive pays that fee and
  everything that waited, and sets offset 464 to zero.
* Or anyone sends `collect_hook_fees`, below.
* "Missing" means: no lamports, or not owned by the quote token program, or shorter than
  a token account.

The treasury of a buyback pool and of a rules pool belongs to the hook's authority for
that pool, `["hook-authority", pool]` of the hook program (pool offset 472). Only the
hook can sign for it, and neither hook has an instruction that closes it, so on those
pools the fee is always paid at once.

What an indexer must do:

* Nothing changes for reserves. `reserve_in += net_in + lp_fee`, `reserve_out -= gross`
  holds in both cases, and so do the reserves reported in the `Swapped` event.
* The `Swapped` event reports the hook fee charged, not whether it was paid. What the
  treasury has received so far is offset 400 minus offset 464.
* Do not reconcile reserves against vault balances without the three "owed" fields at
  offsets 384, 392 and 464.

`collect_hook_fees` of the pool program pays what waits. Its data is the discriminator
alone, `[161,80,95,45,41,49,96,93]`. It has no signer of its own: anyone may send it, and
the money only ever goes to the pool's treasury.

<!-- accounts:hookpool.collect_hook_fees -->
| # | Account | Writable |
|---|---|---|
| 0 | pool | yes |
| 1 | quote mint | no |
| 2 | quote vault | yes |
| 3 | hook treasury (pool offset 335). It must exist | yes |
| 4 | quote token program | no |

The treasury is the associated token account of the wallet at pool offset 472 for the
quote mint, so anyone can create it again first, with the associated token program's
`CreateIdempotent` and that wallet as the owner. The instruction fails with 6040
`NothingToCollect` when nothing waits, with 6029 `HookTreasuryMismatch` for any other
account, and with Anchor 3012 while the treasury does not exist.

It logs `HookFeesCollected`, discriminator `[9,60,154,77,40,27,96,111]`. This one is a log
event (section 10), 72 bytes after the discriminator:

<!-- layout:hook_fees_collected size=72 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 32 | pool |
| 32 | 32 | treasury |
| 64 | 8 | amount, quote units |

Protocol fees work the same way on the platform's side: they wait in the vaults (offsets
384 and 392) until anyone sends `collect_protocol_fees`, which moves them to the
platform treasury and logs `ProtocolFeesCollected`. Reserves do not move.

## 7. The swap instruction

Program: the pool program. Data, 25 bytes:

<!-- layout:swap_data size=25 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 8 | `f8c69e91e17587c8`, that is `[248,198,158,145,225,117,135,200]` |
| 8 | 1 | direction: 0 buy, 1 sell |
| 9 | 8 | `amount_in` |
| 17 | 8 | `min_amount_out` |

Accounts, in this order:

<!-- accounts:hookpool.swap -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the wallet that may spend the input | yes | no |
| 1 | platform | | no |
| 2 | pool | | yes |
| 3 | base mint | | no |
| 4 | quote mint | | no |
| 5 | base vault | | yes |
| 6 | quote vault | | yes |
| 7 | a base token account: spent on a sell, paid on a buy | | yes |
| 8 | a quote token account: spent on a buy, paid on a sell | | yes |
| 9 | hook treasury from the pool account, whether or not that account exists. When offset 335 is all zeros, any writable account, for example account 8 | | yes |
| 10 | hook program from the pool account (the system program when there is no hook) | | no |
| 11 | the hook's extra-accounts list from the pool account (the system program when there is no hook) | | no |
| 12 | hook caller: `["caller", account 10]` of the pool program (section 3) | | no |
| 13 | base token program | | no |
| 14 | quote token program | | no |
| 15 | event authority of the pool program | | no |
| 16 | the pool program | | no |
| 17.. | the hook's accounts, section 8 | | as listed |

Rules:

* The signer must be able to spend the account the input leaves, as its owner or as a
  delegate. The token program enforces it.
* The account that receives may belong to anyone. A router or a bot can sign with one
  wallet and pay out to another. It can never be the pool's own vault.
* Both token accounts must exist and hold the right mint. They need not be associated
  token accounts.
* The pool pays `amount_out` or fails with `Slippage` (6008). Nothing is partially filled.
* Account 9 must be writable on every swap.
* Account 12 goes with account 10: it is the caller of the pool's own hook program, one
  address per hook program. The caller of another hook, or of no hook, fails with 2006.

### Wrapped SOL, and the account you must not close

A pool quoted in SOL takes and pays wrapped SOL. If you build the transaction yourself:
create the signer's wrapped SOL associated account if it is missing (`CreateIdempotent`),
transfer the lamports of a buy into it, send `SyncNative`, swap, and close the account at
the end to turn what it holds back into SOL.

Close it only when your own transaction created it. A wrapped SOL account that existed
before your transaction may be the fee treasury of a coin: the treasury of a tax coin is
by default the wrapped SOL associated account of its dev, and the dev trades too. For a
wallet that already has the account, wrap exactly the amount of a buy and leave the
account open; a sell then pays wrapped SOL into it.

If a treasury is closed anyway, nothing is lost: the fees wait in the pool as described
in section 6, and anyone can reopen the account and collect them.

### Errors

Every program numbers its own errors from 6000, so a number means nothing without the
program that failed. The log names it: `Program <id> failed: custom program error: 0x...`.

Custom errors of the pool program a trader can meet:

<!-- errors:hookpool -->
| Code | Name | Meaning |
|---|---|---|
| 6000 | `Paused` | the platform is paused |
| 6006 | `ZeroAmount` | zero input, or the fees take all of it, or the output rounds to zero (a dust trade), or nothing is left of the output after the hook fee |
| 6007 | `BadDirection` | the direction byte is neither 0 nor 1 |
| 6008 | `Slippage` | output below `min_amount_out` |
| 6010 | `MathOverflow` | an amount so large that a reserve would not fit in 64 bits |
| 6011 | `InsufficientLiquidity` | a reserve is zero |
| 6015 | `TokenProgramMismatch` | account 13 or 14 is a token program, but not the pool's |
| 6023 | `HookProgramMismatch` | account 10 is not the pool's hook program, and account 12 is the caller of the program that was passed |
| 6025 | `HookExtraMetasAddress` | account 11 is not the hook's extra-accounts list |
| 6027 | `HookExtraAccounts` | a hook account is missing from the instruction |
| 6029 | `HookTreasuryMismatch` | account 9 is not the pool's treasury, on a swap that owes a hook fee |
| 6032 | `BadHookReturn` | the hook answered with bytes the pool cannot read |
| 6033 | `HookPowerNotGranted` | the hook answered with a power its flags do not grant |
| 6035 | `HookCurveInvalid` | a hook's curve answer is zero or would take the whole reserve. Only a hook with `OVERRIDE_CURVE` answers one, and no launched coin has such a hook |
| 6049 | `CurveRealReserve` | a sell on a pool on the curve whose gross output is above the real quote reserve (section 14) |

Errors from elsewhere in the same swap:

| Error | From | Meaning |
|---|---|---|
| 2000 `ConstraintMut` | Anchor | an account that must be writable was passed read-only: the pool, a vault, a token account, account 9 |
| 2001 `ConstraintHasOne` | Anchor | account 3, 4, 5 or 6 is not the pool's mint or vault |
| 2006 `ConstraintSeeds` | Anchor | account 12 is not the hook caller of the program at account 10. Also another program at account 10 with the right caller of the pool's own hook |
| 2014 `ConstraintTokenMint` | Anchor | account 7 or 8 is a token account of another mint |
| 2040 `ConstraintDuplicateMutableAccount` | Anchor | account 7 or 8 is this pool's own vault |
| 3012 `AccountNotInitialized` | Anchor | account 7 or 8 does not exist. Also an address that holds nothing in place of the platform |
| `PrivilegeEscalation` | the runtime | a hook account was passed read-only where the hook's list says writable: the config of a buyback, launch guard, rules or collectible pool |
| custom 1 | the token program | the input account holds less than `amount_in` |
| custom 4 | the token program | the signer is neither the owner nor a delegate of the input account |
| 6017 `BuyTooLarge` | the rules hook | a buy above the coin's buy limit, inside its window (section 6) |
| 3005 `AccountNotEnoughKeys` | the collectible program, inside Token-2022 | a pegged coin without its three extra accounts (section 9) |
| 3005 `AccountNotEnoughKeys` | the token program | a strict coin without its three accounts (section 9) |
| 6044 `MaxWallet`, 6045 `EarlyLocked`, 6046 `CreatorLocked`, 6047 `HolderRecordRequired` | the rules hook, inside Token-2022 | a strict coin's rules hold the transfer (section 9) |

An error of another program inside the swap is the hook refusing the trade. Errors 6000,
6010, 6011, 6032, 6033 and 6049 are described from the program's source and its tests:
the test chain was never paused, and no pool on it can produce the other five. For 6049
that is the point: no wallet holds coins that would make a pool on the curve pay out more
than its real reserve.

Errors you will only see when a pool is created. They are why the guarantees of section 1
hold:

<!-- errors:hookpool -->
| Code | Name | Meaning |
|---|---|---|
| 6014 | `MintExtensionNotAllowed` | a Token-2022 mint with an extension the pool does not accept |
| 6042 | `BaseMintFreezable` | the coin has a freeze authority |
| 6052 | `HookNotApproved` | the platform's approved-list rule is on and the hook is an outside hook that is not on the list (HOOKS.md section 6.1) |
| 6056 | `ApprovedListCorrupt` | the rule is on and the list after the platform account cannot be read |

### Compute units

Units of the swap instruction alone, measured by simulation on a local validator (Agave
4.3.0) on 2026-10-13, for a buy of 0.1 SOL and a sell of half of what it bought:

| Pool | Buy | Sell |
|---|---|---|
| no hook | 29,100 | 29,200 to 29,300 |
| no hook, Token-2022 coin | 31,300 | 31,500 |
| tax | 45,500 to 48,500 | 45,600 to 48,700 |
| buyback | 43,900 to 47,000 | 44,100 to 47,200 |
| launch guard | 43,400 to 49,400 | 29,700 |
| rules | 44,800 to 52,500 | 45,300 to 53,000 |
| collectible | 48,700 to 68,200 | 28,800 |
| pegged coin | 87,200 to 144,200 | 67,300 to 103,300 |
| strict coin | 83,800 to 109,700 | 84,300 to 105,300 |

A range is the spread between the pools of that kind on the test chain, two to six of
each: deriving a pool's addresses costs a different number of tries for each pool, 1,500
units a try. The launch guard and rules rows cover pools inside their window and after
it. The collectible and pegged rows are for a signer without a ticket. A signer with a
ticket uses about 2,500 units more on a collectible or pegged buy, and 2,700 to 10,200
more on a pegged sell. The strict coin row was measured on 2026-10-15, on buys that stay
under the coin's max wallet, and leaves out the `open_holder` sent before an early buy.
A tax swap whose fee waits for a missing treasury uses about
2,100 less than the same swap with the treasury alive. `collect_hook_fees` uses 10,700.
A pool on the curve uses a few hundred units more than a seeded pool of the same kind:
measured on 2026-10-16 for the same buy of 0.1 SOL, 29,500 without a hook (29,300 on a
seeded pool), and 46,000 on a rules pool (45,400 seeded); a graduated pool the same as on
the curve.
Liquidity is in section 11, the buyback and the burn in section 12, the other
instructions of the rules hook in section 13. `scripts/check-integrators-doc.mjs` prints
these figures again for the cluster it runs on.

These are the units of one runtime version. The programs' own test suite runs the same
swaps in another one and counts about 40 percent more: 41,400 without a hook, 65,400 on
a tax pool, 66,400 to 67,700 on a rules pool. So leave room: ask for 250,000 units, also
for a strict coin (what the SDK and the trade API ask for), and 450,000 for collectible
and pegged coins.

`create_pool` sent directly to the pool program used 85,000 to 115,000 units on twelve
pools without a hook, and its units depend on the addresses in the same way, with more
addresses to derive. Ask for 400,000.

Call depth: a swap goes pool, hook: two levels. On a pegged coin it goes pool, token
program, hook: three. The runtime allows five, so a router that calls the pool by CPI has
room.

## 8. Hook accounts

A hook's callbacks may need accounts of their own: a config, a counter, an account per
trader. The hook publishes them once, in the account at pool offset 303. The pool never
passes one of them as a signer, whatever the list says, and a client must not either.

The list is in the format of Token-2022 transfer hooks (`spl-tlv-account-resolution`):

```
repeated:  8 bytes key | 4 bytes length | value
the entry whose key is [60,167,17,250,28,149,188,66] holds the list:
  4 bytes count, then `count` entries of 35 bytes:
    1 byte   kind:  0 a fixed address | 1 a PDA of the hook program | 128+n a PDA of the program at account n
    32 bytes the address (kind 0), or packed seeds (other kinds)
    1 byte   is_signer (ignore it: these accounts never sign)
    1 byte   is_writable
packed seeds, one after another, 0 ends them:
    1, len, bytes        literal bytes
    2, index, len        bytes of the callback's instruction data (no template uses it)
    3, n                 the address of account n
    4, n, offset, len    bytes of account n's data
```

Account numbers count the five accounts every callback receives, then the entries
already resolved: `0` pool, `1` the hook caller of the pool's hook program, `2` the
signer of the swap, `3` quote mint, `4` base mint, `5` the first entry, and so on.

Pass the resolved accounts after the seventeen fixed ones. The pool finds them by
address, so their order does not matter, and an account it does not need is ignored.
They are needed on every swap in which the pool calls the hook. Passing them in the other
direction too is harmless, and simpler.

What the templates publish:

| Hook | Accounts after the fixed seventeen |
|---|---|
| tax | config `["cfg", pool]`, read-only |
| launch guard | config, writable |
| buyback | config, writable |
| rules | config, writable. A strict coin adds three accounts of its own, section 9 |
| collectible | config, writable; the signer's ticket `["ticket", pool, signer]`, writable; the SlotHashes sysvar `SysvarS1otHashes111111111111111111111111111` |

An account the list marks writable must be passed writable, or the runtime stops the
swap with `PrivilegeEscalation`. That includes the config of a buyback pool, on buys and
on sells: the hook keeps the observation of its buyback in it (section 12).

The ticket of a wallet that never opened one does not exist. Pass its address anyway: the
buy goes through and earns no piece.

## 9. The kinds of coin

**Plain SPL coins.** Nothing special.

**Token-2022 coins without a transfer hook.** Use the token program at pool offset 201
for the coin's accounts. The launchpad does not create such coins; a pool created
directly may have one.

**Rules coins** (hook: rules). An ordinary coin without a transfer hook: sending it from
one wallet to another is free and is not a trade. The rules apply to trades on its pool:
the three rates, the sniper fee and the buy limit of section 6, and no new liquidity
during the sniper window (section 11). Holders can stake the coin with the hook to earn
the holders' share of the fees, and the launcher's first buy can sit in a lock account.
Neither changes a quote. Staking, the claims and the lock are in section 13, the burn in
section 12.

**Strict coins** (hook: rules, and the rules hook as the coin's transfer hook). A strict
coin is a Token-2022 coin whose transfer hook is the rules hook,
`3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr`, with no authority on the extension. So
the hook runs inside every transfer of the coin, the ones between a wallet and the pool
included, and nobody can change or remove it. It gives a coin three rules a plain coin
cannot have: a max wallet, a lock on coins bought early, and the holders' share paid to
wallets that hold the coin, without staking. `RULES.md`, "The strict coin", is the
specification.

* Detect it: the base token program is Token-2022, the mint's transfer hook extension
  (14) names the rules hook, and byte 374 of the rules config is 1.
* A quote is the quote of a plain rules coin (section 6). The coin's rules can refuse the
  trade, but they never change an amount.
* A wallet receives the coin only in its associated token account (`NotAssociatedAccount`
  otherwise). The receiving account of a buy must be one.
* The coin trades in its own pool only.

The accounts every instruction that moves the coin must carry, in addition to its own.
The pool finds them by address and Token-2022 resolves them by address, so their order
does not matter. All are addresses of the rules hook:

| Instruction | Accounts to add |
|---|---|
| `swap`, buy or sell | after the seventeen: the config `["cfg", pool]` (writable; the hook's own account of section 8), the holder record of the wallet that owns the coin account of the swap `["holder", pool, wallet]` (writable), the pool's holder record address `["holder", pool, pool]` (writable), the coin's account list `["extra-account-metas", base mint]` (read-only). All four on buys and on sells, whether the records exist or not |
| `add_liquidity`, `remove_liquidity` | the same four, after the nineteen |
| `create_pool`, the launchpad's `launch` | the same four, with the wallet that creates the pool |
| `collect_protocol_fees` | after its fourteen: the config (writable), `["holder", pool, pool]` (writable), the holder record address of the platform treasury's wallet `["holder", pool, treasury wallet]` (writable), the account list (read-only), the rules hook (read-only) |
| a send from one wallet to another | the `TransferChecked` instruction of Token-2022 (source account, mint, destination account, owner of the source), then: the config (writable), the sender's holder record (writable), the receiver's holder record (writable), the account list, the rules hook. The receiver's associated token account must exist: create it in the same transaction if it does not |
| `run_burn_strict`, the pool's `hook_buy_burn` (section 12), a token `Burn` by a wallet | none: no coin is transferred |

A buy paid out to another wallet names that wallet's holder record in place of the
signer's. Without it the pool fails with 6027 `HookExtraAccounts`; without all three
accounts of the coin the token program fails with 3005.

The coin's account list holds three entries, in the format of section 8 with the
Token-2022 key `[105,37,101,197,75,251,102,26]` (`spl-transfer-hook-interface:execute`):
the config as a fixed address, writable; then `["holder", bytes 10 to 42 of the config,
bytes 32 to 64 of the source token account]` and the same with the destination token
account, both writable. Bytes 10 to 42 of the config are the pool, bytes 32 to 64 of a
token account its owner. The standard transfer hook resolution of the SPL token libraries
produces exactly the accounts above (checked with `@solana/spl-token` 0.4.15,
`createTransferCheckedWithTransferHookInstruction`). It reads the receiver's token account
to find its owner, so it fails (`TokenTransferHookAccountDataNotFound`) while that account
does not exist. A client that creates the account in the same transaction derives the
receiver's holder record itself, from the receiver's wallet, as
`scripts/raw-swap-example.mjs` does.

**The windows.** They count from `start_slot` (config offset 216) with the numbers at
377 to 396 (section 6):

* The max wallet runs while `slot - start_slot < max_wallet_slots`. A buy or a send fails
  when it would leave the receiving wallet with more than `max_wallet_amount`. A sell, a
  removal of liquidity and a collection of protocol fees are never held to it. While it
  runs, nobody can add liquidity (section 11).
* A buy is early while `slot - start_slot < early_slots`. An early buy needs the buyer's
  holder record: send `open_holder` (section 13) before the swap when the wallet has none.
  Coins bought early cannot leave the wallet while `slot - start_slot <
  early_unlock_slots`; the wallet's other coins can.
* The creator lock: the creator's locked coins (holder record offset 113, until 121) stay
  in the creator's wallet until the date, which is at most 365 days after the call that
  sets it.

**What can make a sell or a send of a strict coin fail.** While a window runs, the coin's
rules can hold coins back:

* 6045 `EarlyLocked`: coins bought from the pool in the early window cannot leave the
  wallet before the early unlock.
* 6044 `MaxWallet`: while the max wallet runs, a buy or a send fails when it would leave
  the receiving wallet above the cap. A sell is never held by it.
* 6047 `HolderRecordRequired`: a buy in the early window needs the buyer's holder record.
  It holds a buy, never a sell or a send.
* 6046 `CreatorLocked`: the creator's locked coins cannot leave the creator's wallet
  before the date. It holds the creator only.

After the windows, coins outside the creator lock are held back by no rule of the coin. A
sell then fails only when the platform is paused (pool 6000), when it would pay less than
the seller's minimum (pool 6008), when the amount is zero or the fees take all of it
(pool 6006), when the wallet does not hold the amount (the token program), or when the
client leaves out the accounts above or calls the pool through more than one program (a
swap of a strict coin is already three programs deep: pool, token program, hook). A send
then fails only when the receiving account is not the receiver's associated token account
(6043 `NotAssociatedAccount`), when that account does not exist and the sender does not
create it in the same transaction, or when the wallet does not hold the amount or the
client leaves out the accounts. The numbers are errors of the rules hook unless they say
pool. Nobody can freeze the coin, mint more of it or change its hook. The pool program and
the rules hook are upgradeable by the platform (section 1), and an upgrade could change
any of this.

**Collectible coins** (hook: collectible). Every buy can earn the buyer NFTs, called
pieces: one per `unit` coins the buy pays out, at most `max_per_buy` per buy, while the
collection has pieces left and the wallet holds fewer than 200. A wallet keeps at most
one piece per `unit` coins it holds in its associated token account.

The collection's config, `["cfg", pool]` of the collectible program:

<!-- layout:collection_config size=359 -->
| Offset | Size | Field (359 bytes, discriminator `[223,110,152,160,174,157,106,255]`) |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 3 | three bumps |
| 11 | 32 | pool |
| 43 | 32 | creator of the config |
| 75 | 32 | owner, who may change name and art. All zeros: locked |
| 107 | 32 | the Metaplex Core collection, `["collection", pool]` of the collectible program |
| 139 | 32 | the coin |
| 171 | 32 | the coin's token program |
| 203 | 1 | 1 for a pegged coin, else 0 |
| 204 | 8 | `unit`: raw coin units behind one piece |
| 212 | 4 | the most pieces that may exist at once |
| 216 | 4 | pieces ever minted |
| 220 | 4 | pieces that exist now |
| 224 | 4 | pieces earned and not minted yet |
| 228 | 1 | `max_per_buy` |
| 229 | 2 | art version |
| 231 | 16 | art bytes |
| 247 | 112 | name, then the renderer's base address: two strings, each a 4-byte length and its bytes |

A wallet's ticket, `["ticket", pool, wallet]` of the collectible program, is 346 bytes
when new and grows by 32 bytes for every piece in its list:

<!-- layout:ticket size=346 -->
| Offset | Size | Field (discriminator `[41,228,24,165,78,90,235,200]`) |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 32 | pool |
| 41 | 32 | wallet |
| 73 | 4 | pieces this wallet ever minted on this pool |
| 77 | 4 | pieces this wallet ever earned on this pool |
| 81 | 1 | pieces staged to travel with the next transfer (pegged coins) |
| 82 | 8 | the slot that stage holds for |
| 90 | 252 | four batches of waiting pieces, 63 bytes each |
| 342 | 4 | number of pieces in the list |
| 346 | 0 | the list: 32 bytes for each piece, the address of its Metaplex Core asset |

One batch:

<!-- layout:batch size=63 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 1 | state: 0 empty, 1 waiting, 2 revealed, 3 expired |
| 1 | 1 | pieces of this batch not minted yet |
| 2 | 1 | pieces of this batch already minted |
| 3 | 4 | number of the batch's first piece, counted per wallet |
| 7 | 8 | target slot: the block that decides how the pieces look |
| 15 | 32 | seed, zeros until revealed |
| 47 | 16 | the collection's art bytes when the pieces were earned |

* Pieces go to the wallet that signs the swap, and only if that wallet has a ticket. A
  router that signs with its own authority earns nobody a piece. The trade itself is the
  same either way.
* A wallet opens its ticket once: instruction `open_ticket(pool)` of the collectible
  program, discriminator `[154,120,166,69,155,111,27,207]`, data = the discriminator and
  the pool address, accounts = the wallet (signer, writable), the ticket (writable), the
  system program. The wallet pays the rent of 346 bytes: 2,407,920 lamports on mainnet
  (3,299,040 on a local validator; read it from the chain). Opening a ticket that is
  already open does nothing and does not fail. `open_ticket_for(pool, wallet)`,
  discriminator `[207,104,147,202,15,229,57,135]`, data = the discriminator, the pool and
  the wallet, same accounts with the payer first, opens the ticket of any wallet.
* How to see that a buy earned pieces: the count at ticket offset 77 rises by the number
  of pieces, a batch has state 1 with that many pieces and a target slot of the buy's
  slot plus 2 (another buy that lands before the target slot adds its pieces to the same
  batch), the config's count at offset 224 rises, and the log carries `PiecesEarned`
  (section 10).
* Minting the pieces a buy earned is a separate transaction at least two slots later
  (`mint` by the wallet, or the permissionless `mint_for` by anyone, see
  `idl/hook_collectible.json`). A router does not have to send either.
* One approval. A buy may pay the rent of the NFTs it earns as a deposit: a plain System
  Program transfer from the wallet to its own ticket `["ticket", pool, wallet]`, after the
  swap, in the buy transaction. Whatever a ticket holds above its rent-exempt minimum is
  the wallet's deposit. Anyone may then send `mint_for`, which mints the wallet's decided
  pieces into the wallet and pays its sender back from that deposit, what it spent plus
  10,000 lamports; the operator's keeper (`watcher/`) does it within seconds. The SDK's
  `mintDepositFor` says how much to deposit; `swapInstructions(..., { mintDeposit })` and
  the trade API add it. The wallet takes what is left back with `withdraw_deposit`
  (HOOKS.md section 13, "One approval").
* Never put a `mint` of earlier pieces into a buy. Once a ticket holds a deposit, anyone's
  `mint_for` may land first: the wallet's next asset address moves, the buy's `mint` names
  the wrong one and the whole buy fails with `WrongAsset`.
* On a plain collectible coin, selling leaves the seller with more pieces than its coins
  back. They stay on the ticket until someone sends `settle`, which drops the waiting
  pieces and burns the minted ones from the end of the seller's list. The SDK adds it to
  its own sells. For every other sell the operator's keeper (`watcher/`) sends it, when
  one is running. A router does not have to.

`settle` of the collectible program: data is the discriminator alone,
`[175,42,185,87,144,131,102,212]`. Anyone may send it for any wallet.

<!-- accounts:hook_collectible.settle -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | payer. It receives the rent of the pieces it burns | yes | yes |
| 1 | config `["cfg", pool]` | | yes |
| 2 | the ticket of the wallet to settle | | yes |
| 3 | that wallet's associated token account for the coin (it may not exist) | | no |
| 4 | the collection `["collection", pool]` (config offset 107) | | yes |
| 5 | the collection authority `["authority", pool]` of the collectible program | | no |
| 6 | Metaplex Core, `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` | | no |
| 7 | the system program | | no |
| 8.. | the pieces that may burn, from the wallet's list, in any order | | yes |

It burns the last piece of the list while the wallet holds more pieces than its coins
back and that piece is among the accounts given, then stops. With no piece accounts it
only drops waiting pieces.

**Pegged coins.** A collectible coin whose mint is a Token-2022 mint with a transfer hook
pointing at the collectible program. The program then runs inside every transfer of the
coin, the one between the wallet and the pool included, and moves or burns the pieces in
that transfer. No `settle` is needed.

* Detect it: the base token program is Token-2022 and the mint carries extension 14
  (`TransferHook`) with a program set. Config offset 203 is 1.
* Three more accounts go after the hook's own: the pool's own ticket
  `["ticket", pool, pool]`, writable; the burn queue `["queue", pool]`, writable; the
  coin's account list `["extra-account-metas", base mint]`, read-only. All three are
  addresses of the collectible program. They are needed on every swap, in both
  directions, and when liquidity is added or removed.
* A buy paid out to another wallet than the signer also needs that wallet's ticket
  address, `["ticket", pool, wallet]`, writable, anywhere after the seventeen.
* The transfer rule. When a transfer leaves the sender with more pieces than its coins
  back, the pieces that lost their backing go: waiting pieces are dropped first, then
  minted pieces leave the end of the sender's list. The receiver takes one piece for
  every whole `unit` the transfer sends, if it has a ticket, the coins arrive in its
  associated token account, its coins back the piece and it holds fewer than 200. Every
  other piece that left is burned. So 2.5 units sent carry at most two pieces, and 0.75
  unit carries none. A sell is a transfer to the pool: its pieces burn inside the swap.
  (A wallet can also send chosen pieces on purpose, with `stage`; see the IDL.)
* A burned piece is first written to the burn queue (count at offset 40 of that account,
  then 32 bytes for each piece). Its Metaplex Core asset is burned later by `reap`, which
  anyone may send.
* A plain wallet-to-wallet transfer of the coin needs the transfer hook's accounts, as
  for any Token-2022 coin with a transfer hook. The standard token library resolves them
  (`createTransferCheckedWithTransferHookInstruction`), except when the destination
  token account does not exist yet: create it first.
* A pegged coin trades in one pool only, the one its mint was bound to when the coin was
  created.

A router that does not want this case can skip pegged coins: `jupiter-adapter/` does.

## 10. Events

There are two kinds, and they are read in different places.

**Inner-instruction events.** The program calls itself with data `e445a52e51cb9a1d`,
then the 8-byte event discriminator, then the fields. Inner instructions are never cut.
Read them from `meta.innerInstructions` of `getTransaction`, where the program of the
inner instruction is the program that emits the event. `getTransaction` returns inner
instruction data in base58.

| Event | Program | Discriminator | Fields after the 16 bytes of tag and discriminator |
|---|---|---|---|
| `Swapped` | pool program | `[217,52,52,83,147,135,96,109]` | 132 bytes, table below |
| `PoolCreated` | pool program | `[202,44,41,88,104,220,157,82]` | 199 bytes: pool, base mint, quote mint, creator, hook program (pubkeys); hook flags u32; hook kind u8; lp fee bps u16; base amount, quote amount, lp minted, slot (u64) |
| `LiquidityChanged` | pool program | `[132,132,193,214,12,99,40,28]` | 113 bytes: pool, user (pubkeys); added bool; base amount, quote amount, lp amount, reserve base, reserve quote, slot (u64) |
| `Launched` | launchpad | `[209,127,29,152,129,212,189,183]` | 224 bytes: launch record, pool, dev, base mint, quote mint, hook program (pubkeys); lp locked, launch fee paid, dev buy quote, slot (u64) |
| `CurveOpened` | pool program | `[222,62,115,103,123,108,79,149]` | 58 bytes, table below: a pool on the curve was created |
| `Graduated` | pool program | `[51,241,66,50,140,245,156,192]` | 88 bytes, table below: a pool left the curve |
| `BuybackExecuted` | buyback hook | `[150,109,157,10,124,24,38,189]` | 73 bytes, table below |
| `BurnExecuted` | rules hook | `[148,9,16,114,196,85,217,2]` | 73 bytes, the same table |

**Log events.** The other events are written to the transaction log as
`Program data: <base64>`: the 8-byte event discriminator, then the fields. A node cuts a
log longer than 10 KB, so a busy transaction can lose them. Read them from
`meta.logMessages`. Their layouts are in the IDLs.

| Event | Program | Discriminator | Fields after the discriminator |
|---|---|---|---|
| `HookFeesCollected` | pool program | `[9,60,154,77,40,27,96,111]` | 72 bytes: pool, treasury (pubkeys); amount u64 |
| `ProtocolFeesCollected` | pool program | `[165,34,125,155,15,86,99,191]` | 48 bytes: pool (pubkey); base amount, quote amount (u64) |
| `TokenCreated` | launchpad | `[236,19,41,255,130,78,147,172]` | 73 bytes: mint, dev (pubkeys); decimals u8; total supply u64 |
| `Staked` | rules hook | `[11,146,45,205,230,58,213,240]` | 96 bytes, table below |
| `Unstaked` | rules hook | `[27,179,156,215,47,71,195,7]` | 96 bytes, the same table |
| `RewardsClaimed` | rules hook | `[75,98,88,18,219,112,88,121]` | 72 bytes: pool, staker (pubkeys); amount u64, quote units |
| `CreatorClaimed` | rules hook | `[118,206,30,219,62,164,54,200]` | 72 bytes: pool, creator (pubkeys); amount u64, quote units |
| `CreatorLocked` | rules hook | `[236,6,11,225,235,131,19,250]` | 88 bytes, table below |
| `CreatorUnlocked` | rules hook | `[123,215,182,89,245,169,75,154]` | 72 bytes: pool, creator (pubkeys); amount u64, coin units |
| `HolderOpened` | rules hook | `[133,172,228,247,214,213,195,160]` | 72 bytes, table below: the balance the record started with |
| `HolderSynced` | rules hook | `[65,47,59,202,75,82,26,121]` | 72 bytes, the same table: the balance after the sync |
| `HolderClaimed` | rules hook | `[135,192,236,75,181,166,203,87]` | 72 bytes, the same table: the quote units paid |
| `HolderClosed` | rules hook | `[75,130,114,152,178,171,89,93]` | 64 bytes: pool, wallet (pubkeys) |
| `PiecesEarned` | collectible hook | `[212,211,116,170,229,104,148,129]` | 84 bytes: pool, wallet (pubkeys); pieces u32; slot, target slot (u64) |
| `PiecesCancelled` | collectible hook | `[102,58,224,15,114,161,31,151]` | 68 bytes: pool, wallet (pubkeys); waiting pieces dropped u32 |
| `PiecesTransferred` | collectible hook | `[180,181,161,207,66,8,176,169]` | 108 bytes: pool, from, to (pubkeys); waiting pieces dropped, pieces moved, pieces burned (u32) |
| `PieceBurned` | collectible hook | `[178,48,28,62,239,160,146,227]` | 128 bytes: pool, wallet, asset, sender of the instruction (pubkeys) |
| `PieceMinted` | collectible hook | `[104,29,116,162,88,116,224,25]` | 118 bytes: pool, wallet, asset (pubkeys); number u32; seed 16 bytes; art version u16 |
| `DepositUsed` | collectible hook | `[61,253,173,67,126,32,170,27]` | 116 bytes: pool, wallet, sender of the mint (pubkeys); pieces minted u32; lamports paid to the sender u64; deposit left u64 |
| `DepositWithdrawn` | collectible hook | `[152,139,194,204,237,235,26,134]` | 72 bytes: pool, wallet (pubkeys); lamports u64 |

`HolderOpened`, `HolderSynced` and `HolderClaimed`, after the 8 bytes of the discriminator:

<!-- layout:holder_event size=72 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 32 | pool |
| 32 | 32 | wallet |
| 64 | 8 | the balance (opened, synced) or the amount paid (claimed) |

The transfer hook of a strict coin emits nothing: a transfer is the token program's, and a
holder's balance is in its record. The callbacks of the rules hook emit nothing. A trade on a rules pool is the pool's
`Swapped`; how its hook fee was split is in the config after the next settlement
(section 13).

`Swapped`. Offsets are after the 16 bytes of tag and discriminator:

<!-- layout:swapped size=132 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 32 | pool |
| 32 | 32 | the wallet that signed |
| 64 | 1 | direction: 0 buy, 1 sell |
| 65 | 8 | `amount_in` |
| 73 | 8 | `amount_out` |
| 81 | 8 | protocol fee, in the input token |
| 89 | 8 | hook fee charged, in the quote token |
| 97 | 8 | pool fee, in the input token |
| 105 | 2 | the pool fee applied, in bps (the override when a hook gave one) |
| 107 | 8 | `reserve_base` after the swap |
| 115 | 8 | `reserve_quote` after the swap |
| 123 | 8 | slot |
| 131 | 1 | 1 when a hook made the swap itself (a buyback, a burn), else 0 |

The reserves at 107 and 115 are the real ones. The price after a trade is
`(reserve_quote + virtual_quote) / reserve_base`, where `virtual_quote` is the pool's at
the time of the trade: the `virtual_quote` of its `CurveOpened` event for a trade that
came before its `Graduated` event, and 0 for a trade after it and on a seeded pool. Order
trades of the graduation's slot by their place in the block, and inside one transaction
by instruction. The SDK sends `graduate` right after a buy that crosses the target, so
that buy is a trade on the curve, and right before a trade on a pool already at or past
its target, so that trade is a trade on the graduated pool. Volume in quote is
`amount_in` of a buy, and `amount_out` plus the hook fee of a sell.

`CurveOpened`, after the 16 bytes of tag and discriminator. `create_curve_pool` emits it
right after its `PoolCreated`, in the same instruction:

<!-- layout:curve_opened size=58 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 32 | pool |
| 32 | 8 | `virtual_quote` the pool got |
| 40 | 8 | `graduation_target` the pool got |
| 48 | 2 | `graduation_fee_bps` the pool got |
| 50 | 8 | slot |

`Graduated`, after the 16 bytes of tag and discriminator. `graduate` emits it, and a
`graduate` on a pool that already graduated emits nothing:

<!-- layout:graduated size=88 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 32 | pool |
| 32 | 8 | `reserve_quote` before |
| 40 | 8 | `reserve_quote` after: before, less the graduation fee |
| 48 | 8 | `reserve_base` before |
| 56 | 8 | `reserve_base` after |
| 64 | 8 | coins burned from the pool's base vault: before less after |
| 72 | 8 | the graduation fee, quote units: it joins the protocol fees owed (pool offset 392) |
| 80 | 8 | slot |

`BuybackExecuted` and `BurnExecuted`. One is emitted by every call of `execute_buyback`
or `run_burn` that returns Ok, also by a call that bought nothing (section 12). Offsets
are after the 16 bytes of tag and discriminator:

<!-- layout:burn_executed size=73 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 32 | pool |
| 32 | 8 | quote spent. Zero unless the call bought |
| 40 | 8 | coins burned. Zero unless the call bought |
| 48 | 8 | slot |
| 56 | 1 | outcome: 1 it took the first observation, 2 it waited, 3 it bought |
| 57 | 8 | `reserve_base` of the observation the call left in the config |
| 65 | 8 | `reserve_quote` of that observation |

A call that bought also carries a `Swapped` of the pool program in the same transaction:
byte 131 set, no hook fee, and as signer the hook's authority for the pool,
`["hook-authority", pool]` of the hook program, not a wallet. Its `amount_in` is the
quote spent, and the reserves after it are the observation in the hook's event: on a pool
on the curve, the observation's quote reserve is the event's real reserve plus the pool's
`virtual_quote`.

`Staked` and `Unstaked`, after the 8 bytes of the discriminator:

<!-- layout:staked size=96 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 32 | pool |
| 32 | 32 | staker |
| 64 | 8 | coins moved by this call |
| 72 | 8 | coins in the staker's record after it |
| 80 | 8 | coins staked on the pool after it, the config's `total_staked` |
| 88 | 8 | slot |

`CreatorLocked`, after the 8 bytes of the discriminator:

<!-- layout:creator_locked size=88 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 32 | pool |
| 32 | 32 | creator |
| 64 | 8 | coins added by this call |
| 72 | 8 | coins in the lock record after it |
| 80 | 8 | unlock time, Unix seconds, i64 |

A launch with a creator lock writes `CreatorLocked` at the end of a long transaction.
Read a lock from the lock record (section 13), not from the event.

**Finding a pool's transactions.** `getSignaturesForAddress(pool)` lists every swap and
liquidity change of a pool, its creation, every collection of fees, every buyback and
burn, and on a rules pool every stake, unstake and claim. `lock_creator` and
`unlock_creator` name the config and not the pool: `getSignaturesForAddress(config)`
lists those, and with them every other instruction on a rules pool. The launch
transaction carries `PoolCreated`, then `Swapped` when the dev bought, then `Launched`.
In `PoolCreated`, `lp minted` is what the creator received: the LP supply less the 1,000
units the pool locks itself. In `Launched` and in the launch record, `lp locked` is that
same amount, moved to the lock account by the launch.

A launch on the curve carries `PoolCreated`, `CurveOpened`, then `Swapped` when the dev
bought, then `Launched`. Its `PoolCreated` has a quote amount of 0 and `lp minted` 0: the
pool minted every LP share into its lock account and the creator received none. Its
`Launched` and its launch record give the whole LP supply as `lp locked`. A pool created
directly with `create_curve_pool` carries `PoolCreated` and `CurveOpened` the same way.
`getSignaturesForAddress(pool)` also lists the `graduate` of a pool on the curve, with its
`Graduated`.

A feed in the format chart sites ask for (latest block, asset, pair, events by slot
range) is a thin layer over these: `PoolCreated` gives the pair and its two assets,
`Swapped` gives each trade with the reserves after it, `LiquidityChanged` gives joins and
exits.

## 11. Liquidity

`add_liquidity(lp_amount, max_base, max_quote)`, discriminator
`[181,157,89,67,143,182,52,72]`, and `remove_liquidity(lp_amount, min_base, min_quote)`,
discriminator `[80,85,209,72,24,206,177,108]`. Three u64 after the discriminator. Both
take the same accounts:

```
0 user (signer)          1 platform               2 pool (w)
3 base mint              4 quote mint             5 base vault (w)       6 quote vault (w)
7 LP mint (w)            8 user base (w)          9 user quote (w)      10 user LP (w)
11 hook program         12 hook extra-accounts list                     13 hook caller
14 base token program   15 quote token program   16 SPL Token (the LP mint's program)
17 event authority      18 the pool program      19.. the hook's accounts
```

* The caller names the LP amount, in raw units. LP tokens are SPL Token tokens with 6
  decimals. The pool takes or pays both tokens in proportion to the reserves, rounded
  against the caller: adding takes `ceil(lp_amount * reserve / supply)` of each token,
  removing pays `floor(lp_amount * reserve / supply)`.
* Account 13 is the hook caller of the pool's hook program, `["caller", account 11]`, as
  in a swap, also on a pool whose hook is never asked about liquidity.
* Accounts 8, 9 and 10 must exist and belong to the signer (Anchor 3012 when one does
  not exist, 2015 `ConstraintTokenOwner` when it belongs to someone else). Create the LP
  token account first: any SPL Token account of the LP mint owned by the signer.
* Errors: 6006 `ZeroAmount` for an LP amount of zero, or one so small that removing it
  would pay nothing of a token; 6009 `InputAboveMax` when adding needs more than
  `max_base` or `max_quote`;
  6008 `Slippage` when removing pays less than `min_base` or `min_quote`; 6000 `Paused`
  for adding while the platform is paused. Removing is never paused. 6045 `CurveOpen`
  for both on a pool on the curve, whatever the amounts: liquidity opens at graduation
  (section 14). After graduation both work as on any pool.
* Both emit `LiquidityChanged` (section 10).

**The hook's accounts (19 onwards)** are needed when the pool's hook flags carry one of
the four liquidity bits (section 5), and on a pegged coin, where the coin's transfer
runs the collectible program: pass the same accounts as for a swap.

* Tax, buyback and plain collectible pools set none of the liquidity bits and take
  liquidity without the hook's accounts.
* Launch guard and rules pools set `BEFORE_ADD_LIQ`. `add_liquidity` on them must carry
  the hook's one account, the config, writable. Without it the pool fails with 6027
  `HookExtraAccounts`.
* `remove_liquidity` calls no hook on any template. It needs no hook account, except on
  a pegged coin or a strict coin, and no template can refuse it.
* A strict coin: both instructions carry the four accounts of section 9. While the max
  wallet runs, `add_liquidity` is refused with 6048 `LiquidityInMaxWalletWindow` of
  the rules hook. A removal is never refused and never held to the max wallet.

**The launch windows.** Both hooks refuse `add_liquidity` while their window runs, so
that nobody can add liquidity for a moment and take part of the high fee a sniper pays.
The pool's own liquidity is not touched by this: it comes in with `create_pool`.

| Pool | `add_liquidity` is refused while | The first slot it passes | Error |
|---|---|---|---|
| launch guard | `slot - start_slot < guard_slots` (config offsets 41 and 49) | `start_slot + guard_slots` | 6007 `LiquidityInGuardWindow` of the launch guard hook |
| rules | `sniper_slots > 0` and `slot - start_slot < sniper_slots` (config offsets 216 and 170) | `start_slot + sniper_slots` | 6033 `LiquidityInSniperWindow` of the rules hook |

A rules pool without a sniper fee refuses nothing. The buy limit of a rules pool has no
effect on liquidity. The errors of the launch guard hook, all of them:

<!-- errors:hook_launch_guard -->
| Code | Name | Meaning |
|---|---|---|
| 6000 | `StartFeeTooHigh` | at launch: a start fee above 5,000 bps |
| 6001 | `WindowTooLong` | at launch: a window above 10,800 slots |
| 6002 | `WindowTooShort` | at launch: a window of zero slots |
| 6003 | `WrongPool` | at launch: the config is not this pool's |
| 6004 | `AlreadyArmed` | at launch: the pool of this config exists already |
| 6005 | `WrongCreator` | at launch: the pool's creator did not make the config |
| 6006 | `WrongHook` | at launch: the pool does not run this hook |
| 6007 | `LiquidityInGuardWindow` | `add_liquidity` while the guard window runs |

Compute units of the instruction alone, measured as in section 7: `add_liquidity` 31,500
to 33,100 on a pool without a hook and on tax, buyback and collectible pools, 47,100 to
53,100 on a launch guard pool, 44,400 to 51,900 on a rules pool, 70,900 to 107,100 on a
pegged coin, 83,000 to 104,000 on a strict coin; `remove_liquidity` 31,400 to 33,200,
70,700 to 106,900 on a pegged coin and 73,000 to 95,500 on a strict coin. A Token-2022 coin without a transfer hook adds about 2,300 to either.

A coin launched through the launchpad has its launch liquidity locked: the launch moves
every LP token it minted into the pool's lock account, `["lp-lock", pool]` (pool offset
169), a token account owned by the pool. The pool program has no instruction that moves
it. After a launch the LP supply is `floor(sqrt(base amount * quote amount))` raw units,
for example 1,414,213,562,373 for 1,000,000,000 coins with 6 decimals against 2 SOL, and
the lock account holds all of it. Anyone can add liquidity on top and remove what they
added; the launch liquidity never leaves. The smallest deposit is one raw LP unit, which
on that pool takes about 700 raw coin units and 1 lamport.

A pool created directly with `create_pool` locks only the first 1,000 raw LP units. Its
creator holds the rest and can remove it.

A pool on the curve, launched or created directly, mints all of its LP into the lock
account when it is created, and none to anyone: `floor(sqrt(supply * virtual_quote))` raw
units, for example 5,477,225,575,051 for 1,000,000,000 coins with 6 decimals and 30
virtual SOL. Its creator never holds any. After graduation anyone can add liquidity and
remove what they added, as on any pool; the shares in the lock account never leave.

## 12. Buy and burn

Two templates buy the coin back from its own pool with the fees they collect, and burn
what they buy:

| Hook | Instruction | What it spends | Discriminator |
|---|---|---|---|
| buyback | `execute_buyback(min_amount_out)` | the hook's treasury, all of the hook fee | `[47,32,19,100,184,96,144,49]` |
| rules | `run_burn(min_amount_out)` | the burn pot: the burn share of the hook fee, and the holders' share while too little is staked | `[28,101,229,246,103,87,18,16]` |
| rules, strict coin | `run_burn_strict(min_amount_out)` | the same pot. It buys through the pool's `hook_buy_burn`, below | `[159,241,149,218,41,46,171,38]` |

Anyone may send either one and choose its `min_amount_out`. There is no reward for the
sender. Whoever looks after a coin runs it on a timer: the operator's keeper (`watcher/`)
does, when one is running. Data: the discriminator, then `min_amount_out` as a u64, 16
bytes. The two instructions take the same accounts:

<!-- accounts:hook_buyback.execute_buyback -->
<!-- accounts:hook_rules.run_burn -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the wallet that sends it. Anyone | yes | no |
| 1 | config `["cfg", pool]` of the hook | | yes |
| 2 | the hook's authority `["hook-authority", pool]` | | no |
| 3 | platform | | no |
| 4 | pool | | yes |
| 5 | base mint, the coin | | yes |
| 6 | quote mint | | no |
| 7 | base vault | | yes |
| 8 | quote vault | | yes |
| 9 | the hook treasury (pool offset 335) | | yes |
| 10 | the authority's associated token account for the coin: what is bought lands here and is burned | | yes |
| 11 | the pool program | | no |
| 12 | event authority of the pool program | | no |
| 13 | base token program | | no |
| 14 | quote token program | | no |
| 15 | event authority of the hook program | | no |
| 16 | the hook program | | no |

### The rule: a call may record, wait or buy

A caller who could choose the price would buy first, trigger the buy at the price it
made, and sell into it. So a call never buys at a price or on a depth its caller just
made. The config keeps an **observation** of the pool: the two reserves as they were at
an earlier moment, and the slot (buyback config offsets 206, 214, 222; rules config
offsets 350, 358, 366). Everywhere in this section the quote reserve is the one the price
is made of, `reserve_quote + virtual_quote` (section 5): on a pool on the curve that is
the real reserve plus the virtual one, on every other pool the real one. A call does the
first of these that applies:

| Step | When | What the call does | Result |
|---|---|---|---|
| nothing to spend | buyback: the treasury is empty or below the config's minimum at 142. Rules: the burn pot is zero after settling | fails, writes nothing | error 6004 `BelowThreshold` of the buyback hook, 6023 `NothingToBurn` of the rules hook |
| observe | there is no observation: one of its reserves is zero | records the pool's reserves and the slot. Buys nothing | Ok, outcome 1 |
| too soon | `slot < observation slot + 25` | fails, writes nothing | error 6007 `TooSoon` of the buyback hook, 6032 `BurnTooSoon` of the rules hook |
| wait | the price is above the observed price by more than `2 * cap_bps` basis points | records the pool's reserves and the slot. Buys nothing | Ok, outcome 2 |
| buy | otherwise | spends `spend`, burns what it bought, records the reserves after the buy and the slot | Ok, outcome 3 |

All numbers are whole, divisions round down, and the products of the price check do not
fit 64 bits: use 128-bit or arbitrary-size integers.

```
protocol = platform.protocol_fee_bps          max_hook = platform.max_hook_fee_bps
lp       = pool.lp_fee_bps

buyback:  sure = protocol + min(buy share, max_hook) + min(sell share, max_hook)
rules:    burn_side(r) = 0 when r.creator_bps + r.holders_bps + r.burn_bps is 0, else
                         min(r.creator_bps + r.holders_bps + r.burn_bps, max_hook) * r.burn_bps
                           / (r.creator_bps + r.holders_bps + r.burn_bps)
          sure = protocol + burn_side(buy rates) + burn_side(sell rates)

soft     = protocol + 2 * lp
cap_bps  = (sure + min(sure, soft)) / 4, not below 1 and not above 50

ran_away = reserve_quote * obs_reserve_base * 10000
             > obs_reserve_quote * reserve_base * (10000 + 2 * cap_bps)
spend    = min(pot, max(1, min(reserve_quote, obs_reserve_quote) * cap_bps / 10000))
```

`reserve_base` and `reserve_quote` are the pool's reserves when the call runs, the quote
reserve with the pool's `virtual_quote` added. So one buy spends at most 0.5 percent of
the smaller of the quote reserve now and the observed one, and two buys are at least 25
slots apart, about ten seconds. Graduation keeps the price, so an observation made on the
curve still compares right after it: the first call after a graduation buys, it does not
wait. Its spend is then measured on the smaller depth, the real reserve. With a protocol fee of 20
bps and a pool fee of 100 bps the cap is 50 bps on a buyback pool that takes 2 percent a
side, and 10 bps on a rules pool with no burn rate.

Between two calls every swap can lower the observation. In `before_swap`, when a trade
starts at a price below the observed one, the observed price moves down to the price
that trade starts at. The observed depth is never raised, and the slot stays:

```
if obs_reserve_base != 0 and obs_reserve_quote != 0
   and reserve_base != 0 and reserve_quote != 0
   and reserve_quote * obs_reserve_base < obs_reserve_quote * reserve_base:
       obs_reserve_quote = min(reserve_quote, obs_reserve_quote)
       obs_reserve_base  = ceil(obs_reserve_quote * reserve_base / reserve_quote)
```

`reserve_base` and `reserve_quote` are the reserves before the swap, the quote reserve
with the virtual quote added. The hook reads `virtual_quote` from the pool account it is
given; the swap's payload carries the real reserve (section 14). The second line uses the
quote reserve the first line just wrote, and rounds up. When the pool is not
deeper than the observation the result is the pool's own two reserves. When it is
deeper, because liquidity came in since the observation, the observation keeps its own
quote reserve and takes only the pool's price. This is why the config is writable in
every swap on these pools. A price is bought at only when no trade started below it for
25 slots, and `spend` is never measured on liquidity that came in after the observation.

### The pot

* Buyback: the balance of the treasury. Nothing else is needed.
* Rules: `burn_pot` (config offset 262) after settling. The config is one trade behind:
  the hook fee of the last trade is split by the next instruction that runs for the
  pool, and `run_burn` does that first. Do the same on a copy, with the settlement of
  section 13, or simulate the call.

### The outcome

Every call that returns Ok says what it did, in two places:

* The event, `BuybackExecuted` or `BurnExecuted` (section 10), an inner instruction of
  the hook program.
* Return data set by the hook program, 17 bytes. A simulation returns it, and a landed
  transaction keeps it in `meta.returnData`. The call must be the last instruction.

<!-- layout:burn_result size=17 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 1 | outcome: 1 it took the first observation, 2 it waited, 3 it bought |
| 1 | 8 | quote spent. Zero unless it bought |
| 9 | 8 | coins burned. Zero unless it bought |

The buy is a buy of the pool made by the hook's authority: the protocol fee and the
pool's own fee apply, no hook fee, and no sniper fee even inside the sniper window. It
pays `quote(spend)` of section 6 with `hook_fee_bps` 0 and no override. `min_amount_out`
applies to this buy only; below it the call fails with 6008 `Slippage` of the pool
program. A call that does not buy ignores `min_amount_out`. Everything in the burn
account is burned, so coins that somebody sent there are burned with the next buy, and
"coins burned" can be more than the buy paid.

### What a keeper does

Read the config, the pool, the platform and, for a buyback, the treasury, in one call.
Then:

1. Nothing to spend: do nothing.
2. No observation: send the call with `min_amount_out` 0. It records the pool. Come back
   25 slots later.
3. `slot < observation slot + 25`: wait. A call before that fails.
4. `ran_away`: send the call with `min_amount_out` 0 all the same. It records the pool
   as it is now, so that the next call can buy. Come back 25 slots later.
5. Otherwise send the call with `min_amount_out` = the pool's quote for a buy of `spend`
   with no hook fee, less the slippage you accept.

A keeper that prefers not to compute simulates the call and reads the return data. Do
not send a call that would come too soon: it fails and pays the network fee for nothing.

Compute units of the instruction alone, measured as in section 7: `execute_buyback`
20,300 when it records, 21,000 when it waits, 56,300 to 56,500 when it buys; `run_burn`
23,600 to 28,800 when it records or waits, 59,200 to 64,000 when it buys. Ask for
200,000. Call depth when it buys: hook, pool, token program: three levels.

### A strict coin: `run_burn_strict` and the pool's `hook_buy_burn`

On a strict coin `run_burn` cannot work: its buy pays the coins out to the burn account,
which is a transfer of the coin, and the token program would call the rules hook from
inside the rules hook. A strict coin has no burn account, so `run_burn` fails there with
Anchor 3012. It burns with `run_burn_strict`: the same rule, the same outcomes, event and
17 bytes of return data, the same `min_amount_out`. Its accounts are those of `run_burn`
without the burn account:

<!-- accounts:hook_rules.run_burn_strict -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the wallet that sends it. Anyone | yes | no |
| 1 | config `["cfg", pool]` | | yes |
| 2 | the hook's authority `["hook-authority", pool]` | | no |
| 3 | platform | | no |
| 4 | pool | | yes |
| 5 | base mint, the coin: its supply falls | | yes |
| 6 | quote mint | | no |
| 7 | base vault | | yes |
| 8 | quote vault | | yes |
| 9 | the hook treasury (pool offset 335) | | yes |
| 10 | the pool program | | no |
| 11 | event authority of the pool program | | no |
| 12 | base token program, Token-2022 | | no |
| 13 | quote token program | | no |
| 14 | event authority of the rules hook | | no |
| 15 | the rules hook | | no |

It buys with the pool's `hook_buy_burn(amount_in, min_amount_out, authority_bump)`,
discriminator `[8,103,173,214,106,75,167,33]`: the buy of `hook_swap`, signed by the
hook's authority for the pool, paid from the account at 7, with the protocol fee and the
pool fee and no hook fee. The coins bought are not paid out: the pool burns them in its
own base vault. No coin is transferred and no transfer hook runs. Data, 25 bytes:

<!-- layout:hook_buy_burn_data size=25 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 8 | `amount_in`, quote units |
| 16 | 8 | `min_amount_out` |
| 24 | 1 | the bump of `["hook-authority", pool]` of the pool's hook program |

<!-- accounts:hookpool.hook_buy_burn -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the hook's authority `["hook-authority", pool]` of the pool's hook program | yes | no |
| 1 | platform | | no |
| 2 | pool | | yes |
| 3 | base mint: its supply falls | | yes |
| 4 | quote mint | | no |
| 5 | base vault | | yes |
| 6 | quote vault | | yes |
| 7 | the quote token account the buy is paid from, owned by the hook's authority | | yes |
| 8 | base token program | | no |
| 9 | quote token program | | no |
| 10 | event authority of the pool program | | no |
| 11 | the pool program | | no |

These are the accounts of `hook_swap` without the account that receives the coins. Only
the authority of the pool's own hook program can sign it: any other signer fails with
pool 6037 `HookAuthorityMismatch`, a pool without a hook with 6038 `NoHook`.

What an indexer sees. The pool emits a `Swapped` exactly as for a `hook_swap` buy:
direction 0, byte 131 set, no hook fee, the hook's authority as the signer, `amount_out`
the coins bought. The reserves after it are those of that buy. The coins do not reach any
wallet: in the same instruction the token program burns `amount_out` from the pool's base
vault (a token `Burn` on the vault, inner instruction of the pool program), the supply
of the mint falls by it, and no `TransferChecked` of the coin leaves the vault. To tell
it from a `hook_swap` buy, read the pool program's instruction (discriminator
`[8,103,173,214,106,75,167,33]`, against `[122,98,77,213,6,114,102,250]` for
`hook_swap`), or look for that burn. Count it in volume as a buy by the hook, which it
is, and in holders as a fall of the supply that nobody receives. `BurnExecuted` of the
rules hook comes after the `Swapped`, in the same instruction.

Compute units of `run_burn_strict`, measured as in section 7: 20,400 when it records, 53,900
when it buys. Call depth when it buys: hook, pool, token program: three levels.

The errors of the buyback hook, all of them:

<!-- errors:hook_buyback -->
| Code | Name | Meaning |
|---|---|---|
| 6000 | `TaxTooHigh` | at launch: a share above 1,000 bps |
| 6001 | `WrongPool` | at launch: the config is not this pool's, or not the pool of the two mints |
| 6002 | `WrongTreasury` | at launch: the pool's treasury is not the hook's |
| 6003 | `WrongMints` | at launch: a mint is not the config's |
| 6004 | `BelowThreshold` | `execute_buyback` with an empty treasury, or one below the config's minimum |
| 6005 | `NothingBought` | the buy bought nothing |
| 6006 | `WrongCreator` | at launch: the pool's creator did not make the config |
| 6007 | `TooSoon` | `execute_buyback` while its observation is less than 25 slots old |
| 6008 | `MinQuoteTooHigh` | at launch: a minimum above 1,000,000,000 quote units |

What the rule does not stop, and why the cap has this shape, is in `HOOKS.md` section 7
and under "Known limits" in `RULES.md`. For an integrator the consequences are two: a
burn is slow on purpose, and on a coin whose price is rising calls come back with
outcome 2 until the price stands still for 25 slots.

## 13. The rules template: fees, staking, the creator lock

Everything here is an instruction of the rules hook,
`3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr`. None of it changes a quote. A router
needs section 6 and nothing of this section; a wallet, a site or an indexer that shows a
rules coin needs it. The rules themselves, their bounds and their limits are in
`RULES.md`.

The accounts of one rules pool, all derived under the rules hook (seeds in section 3):

| Account | What it is |
|---|---|
| config | the rules and the running numbers (layout in section 6). It owns the stake vault and the lock vault |
| authority | owns the treasury and the burn account, and signs the burn's buy. Holds no data |
| treasury | the authority's associated token account for the quote mint. It receives the hook fee of every trade. Pool offset 335 |
| burn account | the authority's associated token account for the coin |
| stake vault | a token account of the coin, owned by the config. Staked coins |
| stake record | one per staker, 113 bytes |
| lock record, lock vault | the creator lock, made by the first `lock_creator`. They do not exist on a coin whose creator never locked |

### How the hook fee is split

The pool pays the whole hook fee of a trade into the treasury. The hook splits it the
next time it runs for that pool: at the next trade, or at the start of `stake`,
`unstake`, `claim_rewards`, `claim_creator` and `run_burn`, and on a strict coin of
`open_holder`, `sync_holder`, `claim_holder` and `run_burn_strict`. On a strict coin
`total_staked` is the sum of the holder records' balances, and a holder record takes the
place of a stake record. So the numbers in the config
are one trade behind. To show what a claim or a burn would find, do the settlement on a
copy:

```
paid    = pool offset 400 - pool offset 464            hook fees the treasury has received
fresh   = paid - fees_seen (240), zero when not above
c, h, b = the three rates at 248, the side of the last trade;  t = c + h + b
creator = fresh * c / t       holders = fresh * h / t       burn = fresh - creator - holders
          (when t is 0 everything is burn)

if holders > 0:
    if total_staked (294) > 0 and total_staked >= min_eligible (232):
        n = holders * 10^12 + reward_rem (286)
        acc_per_share (270) += n / total_staked        reward_rem = n % total_staked
    else:
        burn += holders

creator_owed (254) += creator        burn_pot (262) += burn        fees_seen = paid
```

The holders' share of a trade goes to whoever is staked when that trade is settled, and
to the burn pot while less than `min_eligible` is staked. What a stake record can claim
is `owed (97) + amount (73) * (acc_per_share after settling - acc_snapshot (81)) / 10^12`.

<!-- layout:stake_record size=113 -->
| Offset | Size | Field (stake record, 113 bytes, discriminator `[174,163,11,208,150,236,11,205]`) |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 32 | pool |
| 41 | 32 | staker |
| 73 | 8 | coins staked |
| 81 | 16 | `acc_snapshot`, u128: the config's `acc_per_share` when the record was last brought up to date |
| 97 | 8 | rewards settled into the record and not paid yet, quote units |
| 105 | 8 | slot of the last stake |

<!-- layout:lock_record size=57 -->
| Offset | Size | Field (lock record, 57 bytes, discriminator `[157,145,17,26,171,35,61,131]`) |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 32 | pool |
| 41 | 8 | coins the creator put in and has not taken back |
| 49 | 8 | unlock time, Unix seconds, i64. Zero when nothing is locked |

### Staking and rewards

`stake(amount)`, discriminator `[206,176,202,18,200,209,179,108]`, then the amount as a
u64. It moves coins from the wallet to the stake vault. The first stake of a wallet
creates its record and pays the rent. A stake earns nothing of the trades before it.

<!-- accounts:hook_rules.stake -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the staker | yes | yes |
| 1 | config | | yes |
| 2 | pool | | no |
| 3 | the staker's stake record, `["stake", pool, staker]` | | yes |
| 4 | base mint, the coin | | no |
| 5 | stake vault | | yes |
| 6 | the coin account the coins leave. The staker must be able to spend it | | yes |
| 7 | base token program | | no |
| 8 | the system program | | no |

`unstake(amount)`, discriminator `[90,95,107,42,205,124,50,225]`, then the amount as a
u64. It moves coins back to any coin account the staker names. It is refused until 9,000
slots, about one hour, after the record's last stake (offset 105), with 6019
`UnstakeTooEarly`. Every new stake starts that hour again for the whole record; an
unstake does not.

<!-- accounts:hook_rules.unstake -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the staker | yes | no |
| 1 | config | | yes |
| 2 | pool | | no |
| 3 | the staker's stake record | | yes |
| 4 | base mint, the coin | | no |
| 5 | stake vault | | yes |
| 6 | the coin account that receives | | yes |
| 7 | base token program | | no |

`claim_rewards()`, discriminator `[4,144,132,71,116,23,151,80]`, no argument. It pays the
staker what its record is owed, in the quote token, to any quote token account the staker
names. On a pool quoted in SOL that is wrapped SOL. It can be sent at any time and fails
with 6021 `NothingToClaim` when nothing is owed.

<!-- accounts:hook_rules.claim_rewards -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the staker | yes | no |
| 1 | config | | yes |
| 2 | pool | | no |
| 3 | the staker's stake record | | yes |
| 4 | the hook's authority `["hook-authority", pool]` | | no |
| 5 | quote mint | | no |
| 6 | treasury | | yes |
| 7 | the quote token account that receives | | yes |
| 8 | quote token program | | no |

### The creator

`claim_creator()`, discriminator `[231,240,197,249,244,10,21,59]`, no argument. It pays
`creator_owed` after settling to any quote token account the creator names. The signer
must be the creator at config offset 138, or it fails with 6022 `NotCreator`.

<!-- accounts:hook_rules.claim_creator -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the creator | yes | no |
| 1 | config | | yes |
| 2 | pool | | no |
| 3 | the hook's authority `["hook-authority", pool]` | | no |
| 4 | quote mint | | no |
| 5 | treasury | | yes |
| 6 | the quote token account that receives | | yes |
| 7 | quote token program | | no |

`lock_creator(amount, unlock_at)`, discriminator `[68,25,135,252,161,20,52,207]`, then the
amount as a u64 and the unlock time as an i64, Unix seconds. It moves coins from a coin
account the creator can spend into the lock vault. The first call creates the lock
record and the lock vault. An amount of 18,446,744,073,709,551,615, the largest u64,
means everything that coin account holds: a launch uses it to lock what the first buy
bought. Later calls may add coins or move the time later. The time can never move
earlier (6025 `UnlockEarlier`), must not be before the launch time at 224 plus the
declared lock at 208 (6026 `UnlockBeforeDeclared`), must be in the future (6028
`UnlockInPast`) and at most 365 days ahead (6027 `UnlockTooFar`).

<!-- accounts:hook_rules.lock_creator -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the creator | yes | yes |
| 1 | config | | no |
| 2 | lock record `["lock", pool]` | | yes |
| 3 | base mint, the coin | | no |
| 4 | lock vault `["lock-vault", pool]` | | yes |
| 5 | the coin account the coins leave | | yes |
| 6 | base token program | | no |
| 7 | the system program | | no |

`unlock_creator()`, discriminator `[27,121,55,205,155,241,167,230]`, no argument. From the
unlock time on it moves everything in the lock vault to any coin account the creator
names and sets the record to zero. Before that it fails with 6029 `StillLocked`. On a
coin whose creator never locked anything the lock record does not exist and the call
fails with Anchor 3012.

<!-- accounts:hook_rules.unlock_creator -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the creator | yes | no |
| 1 | config | | no |
| 2 | lock record | | yes |
| 3 | base mint, the coin | | no |
| 4 | lock vault | | yes |
| 5 | the coin account that receives | | yes |
| 6 | base token program | | no |

What to show for a lock: `creator_lock_seconds` in the config is what the launcher
declared, the earliest a lock may end. The program cannot make a launcher lock anything.
Whether coins are locked, how many and until when is in the lock record and the balance
of the lock vault.

Compute units of the instruction alone, measured as in section 7: `stake` 22,700 to
33,300 for the first stake of a wallet, `unstake` 22,700 to 22,900, `claim_rewards`
19,200 to 20,000, `claim_creator` 14,500 to 14,900, `lock_creator` 22,000 to 37,000
for the first call and 16,900 to 19,900 for a later one, `unlock_creator` 13,400.

### The strict coin's instructions

A strict coin (section 9) has no stake, no stake vault, no lock vault and no burn account.
The instructions of a plain coin that use them fail there: `stake`, `unstake`,
`claim_rewards`, `run_burn` and `unlock_creator` with Anchor 3012, because an account
they need does not exist, and `lock_creator` with 6034 `StrictCoin`. `claim_creator` is
the one of a plain coin. In their place, all instructions of the rules hook:

`open_holder()`, discriminator `[138,210,211,159,140,172,28,65]`, no argument. It makes
the wallet's holder record with what its associated token account holds now, and the
wallet pays the rent of 129 bytes: 1,305,560 lamports on mainnet (1,788,720 on a local
validator; read it from the chain). Opening twice does nothing. A buy in the early
window needs it first. The holders' share goes only to wallets with a record.

<!-- accounts:hook_rules.open_holder -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the wallet | yes | yes |
| 1 | config | | yes |
| 2 | pool | | no |
| 3 | the wallet's holder record `["holder", pool, wallet]` | | yes |
| 4 | the wallet's associated token account of the coin (it may not exist yet) | | no |
| 5 | the system program | | no |

`claim_holder()`, discriminator `[155,200,53,56,103,22,12,161]`. It pays what the record is
owed, in the quote token, to any quote token account the wallet names; 6021
`NothingToClaim` when nothing is owed. What it pays: do the settlement of "How the hook
fee is split" on a copy of the config, then `owed (97) + balance (73) * (acc_per_share
after settling - acc_snapshot (81)) / 10^12`.

<!-- accounts:hook_rules.claim_holder -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the wallet | yes | no |
| 1 | config | | yes |
| 2 | pool | | no |
| 3 | the wallet's holder record | | yes |
| 4 | the hook's authority `["hook-authority", pool]` | | no |
| 5 | quote mint | | no |
| 6 | treasury | | yes |
| 7 | the quote token account that receives | | yes |
| 8 | quote token program | | no |

`sync_holder()`, discriminator `[33,218,181,194,137,165,224,210]`. Anyone may send it. It
lowers a record to what the wallet's associated token account holds, and never raises
it: a token `Burn` by a wallet calls no hook and leaves its record above its balance.

<!-- accounts:hook_rules.sync_holder -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | config | | yes |
| 1 | pool | | no |
| 2 | the holder record | | yes |
| 3 | the associated token account of the record's wallet | | no |

`close_holder()`, discriminator `[88,22,239,228,245,64,37,78]`. It closes a record that
holds nothing (no balance, nothing owed, nothing locked, no early coins under their lock)
and returns the rent to the wallet; 6049 `HolderNotEmpty` otherwise.

<!-- accounts:hook_rules.close_holder -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the wallet | yes | yes |
| 1 | config | | no |
| 2 | the wallet's holder record | | yes |

`lock_creator_strict(amount, unlock_at)`, discriminator `[95,63,12,246,255,133,33,131]`, a
u64 and an i64. The creator lock of a strict coin: a floor on the creator's own wallet.
The creator needs a holder record (Anchor 3012 without one). `amount` is added to what
is locked; the largest u64 means everything the wallet holds; more than the wallet holds
fails with 6051 `LockAboveBalance`. The date rules are those of `lock_creator` (6025 to
6028). The lock record `["lock", pool]` and the creator's holder record (offsets 113 and
121) both carry the lock. It logs `CreatorLocked`.

<!-- accounts:hook_rules.lock_creator_strict -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the creator | yes | yes |
| 1 | config | | no |
| 2 | lock record `["lock", pool]` | | yes |
| 3 | the creator's holder record | | yes |
| 4 | the creator's associated token account of the coin | | no |
| 5 | the system program | | no |

`unlock_creator_strict()`, discriminator `[165,65,106,11,205,9,40,136]`. From the unlock
time on it sets both records' lock to zero; before it, 6029 `StillLocked`. The coins never
left the creator's wallet. It logs `CreatorUnlocked`.

<!-- accounts:hook_rules.unlock_creator_strict -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | the creator | yes | no |
| 1 | config | | no |
| 2 | lock record | | yes |
| 3 | the creator's holder record | | yes |

A launcher binds a strict coin with `init_strict_config(pool, args, strict)`,
discriminator `[75,34,171,72,212,105,211,38]`, in place of `init_pool_config`: the 46
bytes of `args` of a plain coin, then the 12 bytes of `strict`:

<!-- layout:strict_args size=12 -->
| Offset | Size | Field |
|---|---|---|
| 0 | 2 | `max_wallet_bps`: 0, or 10 to 5,000 |
| 2 | 4 | `max_wallet_slots`: 0, or 1 to 6,480,000 |
| 6 | 2 | `early_slots`: 0, or 1 to 9,000 |
| 8 | 4 | `early_unlock_slots`: 0, or from `early_slots` to 1,512,000 |

The transfer hook itself is `execute(amount)`, discriminator
`[105,37,101,197,75,251,102,26]`, called by Token-2022 only (6042 `NotATransfer`
otherwise).

`HolderRecord`, 129 bytes, `["holder", pool, wallet]` of the rules hook. The config's
`total_staked` (294) is the sum of the balances in a strict coin's holder records.

<!-- layout:holder_record size=129 -->
| Offset | Size | Field (holder record, discriminator `[215,67,31,41,155,251,178,128]`) |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | bump |
| 9 | 32 | pool |
| 41 | 32 | wallet |
| 73 | 8 | `balance`: what the wallet held after its last transfer. The holders' share is paid on it |
| 81 | 16 | `acc_snapshot`, u128: `acc_per_share` when the record was last brought up to date |
| 97 | 8 | `owed`: settled and not paid yet, quote units |
| 105 | 8 | `early_bought`: coins bought from the pool in the early window |
| 113 | 8 | `locked`: the creator lock, on the creator's record only |
| 121 | 8 | `locked_until`, i64: the date of that lock |

Compute units of the instruction alone, measured as in section 7: `open_holder` 16,300 to
21,500, `claim_holder` 19,400 to 20,300, `sync_holder` 12,300 to 17,400. A send between
two wallets: 28,900 to 37,900 for the `TransferChecked`, the hook inside it included.
`collect_protocol_fees` on a strict coin: 105,000. `close_holder`,
`lock_creator_strict` and `unlock_creator_strict` were not measured.

### Errors of the rules hook

All of them. A trader meets 6017, and on a strict coin 6043 to 6047. A keeper meets 6023
and 6032, a staker 6018 to 6021, a creator 6022, 6025 to 6030 and 6051, someone who adds
liquidity 6033 and 6048, a holder 6021 and 6049. The others are refusals at launch, or
cannot happen.

<!-- errors:hook_rules -->
| Code | Name | Meaning |
|---|---|---|
| 6000 | `CreatorFeeTooHigh` | at launch: a creator rate above 500 bps |
| 6001 | `HoldersFeeTooHigh` | at launch: a holders' rate above 500 bps |
| 6002 | `BurnFeeTooHigh` | at launch: a burn rate above 500 bps |
| 6003 | `SideTooHigh` | at launch: the three rates of one side above 1,000 bps together |
| 6004 | `StartFeeTooHigh` | at launch: a sniper start fee above 5,000 bps |
| 6005 | `SniperWindowTooLong` | at launch: a sniper window above 10,800 slots |
| 6006 | `SniperIncomplete` | at launch: a sniper window without a start fee, or the reverse |
| 6007 | `LimitWindowTooLong` | at launch: a limit window above 9,000 slots |
| 6008 | `LimitIncomplete` | at launch: a buy limit without a window, or the reverse |
| 6009 | `LockTooLong` | at launch: a declared lock above 365 days |
| 6010 | `WrongPool` | the pool is not the config's, or not the pool of the two mints |
| 6011 | `WrongHook` | a callback for a pool that does not run this hook |
| 6012 | `WrongCreator` | at launch: the pool's creator did not make the config |
| 6013 | `WrongMints` | a mint is not the config's |
| 6014 | `WrongTreasury` | a treasury is not the config's |
| 6015 | `AlreadyStarted` | at launch: the pool of this config exists already |
| 6016 | `NotStarted` | `stake`, `lock_creator` or `lock_creator_strict` before the pool exists |
| 6017 | `BuyTooLarge` | a buy above the buy limit, inside its window |
| 6018 | `ZeroAmount` | a stake or an unstake of nothing, or a first lock of nothing |
| 6019 | `UnstakeTooEarly` | `unstake` less than 9,000 slots after the record's last stake |
| 6020 | `InsufficientStake` | `unstake` of more than the record holds |
| 6021 | `NothingToClaim` | a claim with nothing owed |
| 6022 | `NotCreator` | the signer is not the creator of the config |
| 6023 | `NothingToBurn` | `run_burn` with an empty burn pot |
| 6024 | `NothingBought` | the burn's buy bought nothing |
| 6025 | `UnlockEarlier` | `lock_creator` with an unlock time before the lock's present one |
| 6026 | `UnlockBeforeDeclared` | `lock_creator` with an unlock time before the launch plus the declared lock |
| 6027 | `UnlockTooFar` | `lock_creator` with an unlock time more than 365 days ahead |
| 6028 | `UnlockInPast` | `lock_creator` with an unlock time that is not in the future |
| 6029 | `StillLocked` | `unlock_creator` before the unlock time |
| 6030 | `NothingLocked` | `unlock_creator` with an empty lock vault |
| 6031 | `MathOverflow` | arithmetic that cannot happen |
| 6032 | `BurnTooSoon` | `run_burn` while its observation is less than 25 slots old |
| 6033 | `LiquidityInSniperWindow` | `add_liquidity` while the sniper window runs |
| 6034 | `StrictCoin` | `lock_creator` on a strict coin |
| 6035 | `NotStrict` | an instruction of the strict coin on a plain coin |
| 6036 | `WrongKind` | at launch: the coin's transfer hook and the kind of its config do not agree |
| 6037 | `StrictNoBurn` | returned by nothing; kept so that the numbers after it do not move |
| 6038 | `MaxWalletOutOfBounds` | at launch: a max wallet outside its bounds |
| 6039 | `MaxWalletIncomplete` | at launch: a max wallet share without a window, or the reverse |
| 6040 | `EarlyOutOfBounds` | at launch: an early lock outside its bounds |
| 6041 | `EarlyIncomplete` | at launch: an early window without an unlock, or the reverse |
| 6042 | `NotATransfer` | `execute` called outside a transfer of the coin |
| 6043 | `NotAssociatedAccount` | a strict coin sent to an account that is not its owner's associated token account |
| 6044 | `MaxWallet` | a buy or a send that would leave the receiving wallet above the max wallet |
| 6045 | `EarlyLocked` | coins bought early leave the wallet before the early unlock |
| 6046 | `CreatorLocked` | the creator's locked coins leave the creator's wallet before the date |
| 6047 | `HolderRecordRequired` | a buy in the early window by a wallet without a holder record |
| 6048 | `LiquidityInMaxWalletWindow` | `add_liquidity` while the max wallet runs |
| 6049 | `HolderNotEmpty` | `close_holder` on a record that still holds something |
| 6050 | `WrongHolder` | an account that is not the associated token account of the record's wallet |
| 6051 | `LockAboveBalance` | `lock_creator_strict` of more than the creator holds |

A pause of the platform stops trades and new liquidity, and with them the buy of
`run_burn` and of `execute_buyback`. Stake, unstake, the two claims, lock and unlock do
not depend on it.

## 14. Pools on the curve

A coin can be launched in two ways. A seeded launch puts real SOL into the pool next to
the supply (section 11). A launch on the curve puts in none. The pool holds the whole
supply and prices it as if it also held its **virtual quote**, SOL that is not there.
Buyers put real SOL in, and the price follows the constant product of section 6 with
`reserve_quote + virtual_quote` as the quote side. When the real SOL reaches the pool's
**graduation target**, anyone may send `graduate`. The virtual quote is dropped and the
pool burns enough of its own coins to keep the price. From then on it is an ordinary
pool: the virtual quote is 0, liquidity opens, and every formula of this document holds
as written.

It is one pool account at one address from the launch to the end. Nothing migrates and no
second pool appears at graduation, so a router, a bot or an indexer follows one account.

### How to tell

* Pool byte 522, `curve_state`: 0 a seeded pool, 1 on the curve, 2 graduated. Section 4
  has the filters that find each.
* Byte 201 of the launch record is 1 for a launch on the curve (`launch_curve`). A pool
  on the curve made directly with `create_curve_pool` has no launch record.
* `CurveOpened` is emitted when the pool is created and `Graduated` when it graduates
  (section 10).

### The numbers

Read a pool's numbers from the pool: `virtual_quote` at 504, `graduation_target` at 512,
`graduation_fee_bps` at 520. The platform's settings at 387 to 403 are what the next pool
gets. With the defaults of this build, 30 virtual SOL, graduation at 85 real SOL and no
fee, a coin of 1,000,000,000 coins with 6 decimals:

* starts at 0.00000003 SOL a coin, a market cap of 30 SOL;
* holds 260,869,565,217,391 raw units when 85 real SOL are in: 73.9 percent is sold;
* graduating at exactly 85 SOL burns 68,052,930,056,711 units, 6.8 percent of the supply,
  and leaves 85 SOL and 192,816,635,160,680 units in the pool;
* has a market cap of about 441 SOL at graduation, before the burn on the whole supply,
  at the same price after it.

LP fees stay in the real reserve and move these a little. Nothing stops a buy at the
target, so a pool can graduate with more SOL than its target. Without fees the share of
the supply graduation burns is `(virtual_quote / (reserve_quote + virtual_quote))^2`: 6.8
percent at 85 SOL, 2.0 percent at 180 SOL. Show the 6.8 percent as the figure at the
target, never as a promise.

### Progress, price and market cap, for a page or an indexer

```
raised          = reserve_quote                                   (pool offset 376, real SOL)
target          = graduation_target                               (pool offset 512)
shown as        "raised <raised> of <target> SOL", which can pass 100 percent before the graduate lands
share sold      = (supply - reserve_base) / supply               (supply: the base mint, offset 36)
price           = (reserve_quote + virtual_quote) / reserve_base  (adjusted for the decimals)
market cap      = supply * price
```

The supply falls only when coins are burned: by a holder, by a buy and burn (section 12),
and at graduation. A pool on the curve holds the whole supply when it opens, so its first
price is `virtual_quote / supply` and its first market cap `virtual_quote`. For a chart,
price each `Swapped` with the virtual quote until the `Graduated` event (section 10).
After graduation show the pool as graduated, with the same address and the same coin.

### Quoting and trading

* Quote with the formula of section 6. The virtual quote counts in the price and is
  never paid out: a sell whose gross output is above `reserve_quote` is refused with
  6049, and is not to be quoted. A pool that has just opened holds no real SOL, so no
  sell can be paid yet; buys are open from the first slot.
* No sell on chain reaches that bound. The pool opens with the whole supply of a mint
  that can never mint again, only trades move its reserves until it graduates, and no
  hook that owns the curve can run it. A buy and a sell both leave
  `(reserve_quote + virtual_quote) * reserve_base` at least where it was, and every coin
  outside the pool came out of it, so selling all of them back never pays more than
  `reserve_quote`. Tokens or SOL sent straight to a vault change no reserve field.
* A pool that stands at or past its target and has not graduated is still on the curve,
  and anyone may graduate it at any moment. A trade quoted on the curve that lands after
  a graduation fills on a pool with the same price and less depth, `reserve_quote - fee`
  in place of `reserve_quote + virtual_quote`: on a pool at 100 SOL a 5 SOL buy gets
  about 1 percent fewer coins, a 20 SOL buy about 4 percent fewer. So on such a pool,
  buy or sell, send `graduate` right before the trade, in the same transaction, and quote
  the trade on the pool as graduation leaves it: the formula below, then section 6 with
  `virtual_quote` 0. That quote is exact whoever graduates first. Your `graduate`
  graduates the pool, or does nothing because somebody else's landed first, and either
  way your trade meets the same pool.
* A buy that crosses the target from below is quoted on the curve, with `graduate` right
  after it in the same transaction. A trade that lands in front of it moves the price as
  any trade does, and the buy's minimum output protects it.
* Take the minimum output from the quote with your slippage, and never lower it. Above all
  never take it from the fill on the pool "as if it graduated now" while the pool is
  below its target: that pool cannot exist, and the minimum it gives can be far under the
  real quote (for a buy of 89 SOL into a pool that has raised 0.3 SOL, 98.7 percent under
  it), which leaves the trade open to a sandwich. The SDK follows these rules
  (`swapInstructions`, `quoteLocal`).
* Liquidity is refused while the pool is on the curve, with 6045 `CurveOpen`.
* The swap's accounts and data are those of every pool (section 7).
* A hook sees the real reserve. `SwapPayload.reserve_quote`, in every callback, is the
  real one; a hook that computes a price or a depth from it must add the
  `virtual_quote` of the pool account it receives as account 0 (`HOOKS.md`, section 2).
  The platform's templates do. A hook built before the curve existed may not, and nothing
  on chain can tell.

A strict coin (section 9) may launch on the curve; a pegged coin may not. A strict coin's
max wallet in coins (config offset 389) and its staking threshold (offset 232) are fixed
from the supply at launch. Graduation burns part of the supply, so after it they are a
slightly larger share of the coins that exist: a max wallet of 1 percent is about 1.07
percent after a graduation at the target. No rule is bypassed.

### `graduate`

Program: the pool program. Data: the discriminator alone,
`[45,235,225,181,17,218,64,130]`. It has no signer of its own: anyone who pays the fee
of the transaction sends it.

<!-- accounts:hookpool.graduate -->
| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | platform | | no |
| 1 | pool | | yes |
| 2 | base mint: its supply falls | | yes |
| 3 | base vault | | yes |
| 4 | base token program (pool offset 201) | | no |
| 5 | event authority of the pool program | | no |
| 6 | the pool program | | no |

No hook account and no transfer hook account: graduation calls no hook, and a burn runs no
transfer hook, also on a strict coin.

* It graduates a pool whose `curve_state` is 1 and whose `reserve_quote` has reached
  `graduation_target`.
* On a pool on the curve below its target, and on a pool that has already graduated, it
  succeeds and does nothing: no write, no event. So a `graduate` sent with a trade on a
  pool on the curve can never fail that trade: not when somebody else graduated the pool
  first, and not when a sell that landed in between took the pool back under its target.
* It is refused with 6047 `NotOnCurve` on a seeded pool, and with 6000 `Paused` while the
  platform is paused, unless the pool has already graduated.
* What it does, all integers, the product in 128 bits:

```
fee        = min(graduation_target * graduation_fee_bps / 10000, reserve_quote - 1)
R2         = reserve_quote - fee
B2         = floor(R2 * reserve_base / (reserve_quote + virtual_quote))
burned     = reserve_base - B2

reserve_base = B2, reserve_quote = R2, protocol fees owed in quote (392) += fee,
virtual_quote = 0, graduation_target = 0, curve_state = 2; graduation_fee_bps stays
```

* The pool burns `burned` coins from its base vault (a token `Burn` of the vault, signed
  by the pool) and the mint's supply falls by them. The price after, `R2 / B2`, is never
  below the price before and above it by less than one unit of the coin. The fee stays in
  the quote vault and goes to the platform with `collect_protocol_fees`.
* It emits `Graduated` (section 10). It used 16,012 compute units on the local validator
  on 2026-10-16: the default budget is enough.
* Who sends it: the platform's keeper (`watcher/`) when a pool stands at or past its
  target, and the SDK, in front of every trade on a pool at or past its target and right
  after a buy that crosses it. A router does not have to.

### Creating a pool on the curve

* The launchpad's `launch_curve(lp_fee_bps u16, dev_buy_quote u64, min_dev_buy_out u64)`,
  discriminator `[109,19,238,79,112,150,113,219]`, takes the 29 accounts of `launch`, in
  the same order (`idl/hooklaunch.json`). The dev's coin account must hold the whole
  supply. A first buy of `dev_buy_quote` is optional and is priced on the curve.
* The pool program's `create_curve_pool(lp_fee_bps u16, base_amount u64)`, discriminator
  `[92,46,170,252,226,105,215,157]`, takes the 26 accounts of `create_pool`, in the same
  order (`idl/hookpool.json`). `base_amount` must be the mint's whole supply. Nothing in
  quote is taken.
* Both refuse a mint that can still mint (6044), a hook that owns the curve (6046), and a
  pegged coin (6050 from the pool program, 6011 from the launchpad). The platform's
  curve settings must be on (6043).

### Errors of the curve

Of the pool program:

<!-- errors:hookpool -->
| Code | Name | Meaning |
|---|---|---|
| 6043 | `CurveDisabled` | the platform's curve settings are off: no pool on the curve can be created |
| 6044 | `CurveSupplyNotInPool` | at creation: the pool does not get the whole supply, or the mint can still mint |
| 6045 | `CurveOpen` | `add_liquidity` or `remove_liquidity` while the pool is on the curve |
| 6046 | `CurveHook` | at creation: the hook's flags carry `OVERRIDE_CURVE` |
| 6047 | `NotOnCurve` | `graduate` on a seeded pool |
| 6048 | `GraduationNotReached` | returned by no instruction: `graduate` below the target does nothing. Kept so that no number moves |
| 6049 | `CurveRealReserve` | a sell whose gross output is above the real quote reserve; it cannot happen on chain |
| 6050 | `CurvePegged` | at creation: a pegged coin, whose transfer hook is the collectible program |
| 6051 | `CurveSettingsOutOfBounds` | `update_platform`: a virtual quote above u64::MAX / 4, or a target below a thousandth of the virtual quote |

Of the launchpad:

<!-- errors:hooklaunch -->
| Code | Name | Meaning |
|---|---|---|
| 6011 | `CurvePegged` | `launch_curve` of a pegged coin |

## 15. A checklist for a router

1. Read the pool and the platform. Skip the pool while the platform is paused.
2. Hook program all zeros: quote with the formula. Done.
3. Hook is one of the five templates: read its config, quote with the formula. For a
   rules pool refuse a buy above its limit while the limit window runs.
4. Any other hook: route only the directions on which the pool does not call it, or quote
   by simulation.
5. Base mint in Token-2022 with a transfer hook: add the accounts of section 9 (three for
   a pegged coin, three more after the config for a strict coin), or skip the pool. On a
   strict coin also expect the refusals of section 9 while its windows run, and put
   `open_holder` before a buy in its early window.
6. Derive the hook caller from the pool's hook program, also for a pool without a hook.
   Never use one caller for every pool.
7. Resolve the hook's account list once per pool and signer. It only changes with the
   signer. Pass every account the list marks writable as writable: the config of a
   buyback, launch guard, rules or collectible pool.
8. Refresh the pool account before every quote, and the config of a tax pool with it. For
   a launch guard and for a rules pool inside a window also use the current slot.
9. Take reserves from the pool account or from the `Swapped` event, never from the vault
   balances.
10. Pass the pool's treasury as account 9 whether or not it exists, and never close a
    wrapped SOL account your transaction did not create.
11. Read pool offsets 504 and 522. On a pool on the curve quote with `reserve_quote +
    virtual_quote`, never quote a sell above `reserve_quote`, and offer the pool from its
    first slot even with no real SOL in it. Do not send liquidity to it. `graduate` is not
    yours to send, and it never fails a trade on a pool on the curve. If you send it, put
    it in front of a trade on a pool at or past its target and quote that trade on the
    graduated pool, or after a buy that crosses the target. Never lower a minimum output.
