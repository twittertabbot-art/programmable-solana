# Launch rules: one hook, several rules, fixed at launch

`hook_rules` is a platform template hook. A launcher switches on the rules a coin should
have, sets their numbers inside fixed bounds, and launches. After the launch nobody can
change a rule: the program has no instruction that does, for the launcher or for anyone.

It is a pool hook like the other templates (`HOOKS.md`). The coin is an ordinary SPL coin,
so it works in every wallet. The rules apply to trades on the coin's pool; sending the coin
from one wallet to another is free and is not a trade.

Program id: `3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr`. Source:
`programs/hook_rules/src/lib.rs`. Tests: `tests/tests/rules.rs`.

## The rules

| Rule | What it does | Where it is enforced |
|---|---|---|
| Sniper fee | For the first slots after launch, a buy pays a high pool fee that falls in a straight line to the pool's normal fee. The fee goes to the pool's liquidity. While the window runs nobody can add liquidity, so it goes to the liquidity the pool was created with, which a launch locks forever. Sells are never touched. | `before_swap` answers a fee override; `before_add_liquidity` refuses deposits |
| Creator fee | A share of every trade is set aside for the launcher, in SOL. | hook fee, split by the program |
| Holder rewards | A share of every trade is paid in SOL to holders who stake the coin in the rule's vault. Every trade pays this share. While less than 0.1% of the supply is staked it goes to the burn pot instead. | hook fee, split by the program |
| Burn | A share of every trade collects in a pot. Anyone may run a buy of the coin with the pot, a slice at a time and never at a price the caller just made; what it buys is burned. | hook fee, then `run_burn` |
| Buy and sell rates | Each of the three shares above has its own rate for buys and for sells. A coin can, for example, pay holders on sells only. | per-side rates in the config |
| Buy limit | For the first slots after launch, no single buy may spend more than a set amount of SOL. Sells are never limited. | `before_swap` refuses the buy |
| Creator lock | The launcher's first buy is put in a lock account in the launch transaction and cannot be taken out before the date. | `lock_creator`, `unlock_creator` |

What this template cannot do on an ordinary coin, and why: it cannot stop a holder from
sending the coin to another wallet, cap what a wallet holds, or lock coins that somebody
bought. Those need code that runs inside every transfer, and an SPL coin has none. A second
kind of coin on this template has that code, at a price: see "The strict coin" at the end
of this document. Everything before that section is about the plain coin. A buy limit is per trade, so
one wallet can split a large buy into several; it slows a sniper down and makes it pay the
sniper fee on each part. The creator lock holds exactly the coins that were put in the lock
account, which anyone can read; it says nothing about coins the launcher buys later with
another wallet.

Three more things a reader should know:

* The launcher's own first buy is a buy like any other. It pays the sniper fee of the first
  slot, in full, and it fails the whole launch when it is above the buy limit.
* The program cannot make a launcher lock anything. `creator_lock_seconds` in the config is
  what the launcher declared: the earliest date a lock may end. Whether coins are locked,
  and how many, is in the lock record and the lock vault. A client that launches puts the
  lock in the launch transaction; a page that shows a coin reads the lock, not the
  declaration.
* A holder earns rewards only on coins it staked, and staked coins cannot be taken out for
  about one hour after the last stake.

## Bounds

`init_pool_config` refuses values above the ceilings. The ceilings are constants of the
program. The policy column is what the launch form offers; a site may offer less.

| Number | Policy (the form) | Ceiling (the program) |
|---|---|---|
| Creator fee, per side | up to 2% | 5% (`MAX_CREATOR_BPS = 500`) |
| Holder rewards, per side | up to 2% | 5% (`MAX_HOLDERS_BPS = 500`) |
| Burn, per side | up to 1% | 5% (`MAX_BURN_BPS = 500`) |
| The three together, per side | up to 3% | 10% (`MAX_SIDE_BPS = 1000`) |
| Sniper fee at the start | up to 50% | 50% (`MAX_START_FEE_BPS = 5000`) |
| Sniper window | up to 5 minutes | 10,800 slots, about 72 minutes (`MAX_SNIPER_SLOTS`) |
| Buy limit window | up to 30 minutes | 9,000 slots, about one hour (`MAX_LIMIT_SLOTS`) |
| Creator lock | up to 90 days | 365 days (`MAX_LOCK_SECONDS`) |

Three more checks keep a config readable:

* A sniper fee needs both a window and a start fee. Both zero means off; one without the
  other is refused (`SniperIncomplete`).
* A buy limit needs both an amount and a window. Both zero means off; one without the other
  is refused (`LimitIncomplete`). There is no lower bound on the amount: a launcher can set
  a limit so small that hardly anybody can buy for up to an hour. It is in the config for
  everyone to read, and it binds the launcher's own first buy too.
* The `pool` argument must be the pool address of the two mints (`WrongPool`).

A sniper start fee that is not above the pool's own fee changes nothing: the pool charges
its own fee.

The pool also clamps the hook fee to the platform's cap (`max_hook_fee_bps`) and the sniper
fee to `max_fee_override_bps`, whatever a hook answers. If the platform lowers a cap below a
coin's rates, trades pay the cap and the shares are split in the same proportions.

## Accounts

All addresses are derived under the `hook_rules` program.

| Account | Seeds | What it is |
|---|---|---|
| Config | `["cfg", pool]` | The rules of one pool, and the running numbers. Created by the launcher before the pool exists. It also owns the two vaults below and signs when coins leave them. |
| Authority | `["hook-authority", pool]` | Owns the treasury and the burn account, and signs the pool's `hook_swap`. Holds no data. |
| Treasury | the authority's associated token account for the quote mint | Receives the hook fee of every trade. It is the pool's `hook_quote_treasury`. |
| Burn account | the authority's associated token account for the coin | Coins bought by `run_burn` land here and are burned in the same instruction. |
| Stake vault | `["stake-vault", pool]`, a token account of the coin owned by the config | Staked coins. |
| Stake record | `["stake", pool, wallet]` | One per staker: amount, reward snapshot, rewards owed, slot of the last stake. |
| Lock record | `["lock", pool]` | The creator lock: amount and unlock time. Created by the first `lock_creator`. |
| Lock vault | `["lock-vault", pool]`, a token account of the coin owned by the config | The locked coins. Created by the first `lock_creator`. |

Why two owners: the pool's `hook_swap` spends only from token accounts of the authority.
The stake vault and the lock vault belong to the config instead, so no trade the hook
starts can reach staked or locked coins, whatever accounts a caller passes.

Extra accounts of the callbacks (the list in `["extra-metas"]`): one, the config, writable.

The coin may be an SPL Token coin or a Token-2022 coin of the kind the pool accepts. Its
accounts (burn account, stake vault, lock vault) are then Token-2022 accounts.

### Config layout

`RulesConfig`, Anchor account, 414 bytes. Discriminator
`[187, 99, 136, 70, 234, 55, 67, 212]` in bytes 0 to 7. Numbers are little-endian.

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `bump` | u8 | |
| 9 | `authority_bump` | u8 | |
| 10 | `pool` | Pubkey | |
| 42 | `base_mint` | Pubkey | |
| 74 | `quote_mint` | Pubkey | |
| 106 | `treasury` | Pubkey | |
| 138 | `creator` | Pubkey | Who paid for the config. Must be the pool's creator. Receives the creator fee. |
| 170 | `sniper_slots` | u64 | Length of the sniper window. 0 = off. |
| 178 | `sniper_start_fee_bps` | u16 | Pool fee of a buy in the first slot. |
| 180 | `buy` | 3 x u16 | `creator_bps`, `holders_bps`, `burn_bps` on buys |
| 186 | `sell` | 3 x u16 | the same on sells |
| 192 | `max_buy_quote` | u64 | Largest SOL input of one buy inside the limit window. 0 = off. |
| 200 | `limit_slots` | u64 | Length of the buy limit window. |
| 208 | `creator_lock_seconds` | u64 | The lock the launcher declared. `lock_creator` refuses an unlock time earlier than the launch plus this. 0 = none declared. |
| 216 | `start_slot` | u64 | Slot of the pool's creation. Zero before. |
| 224 | `start_time` | i64 | Clock time of the pool's creation. Zero before. |
| 232 | `min_eligible` | u64 | 0.1% of the coin's supply at launch, at least 1. Stakers get the holders' share of a trade while at least this much is staked. Zero before the pool exists and never afterwards, so it also tells whether the pool was created. |
| 240 | `fees_seen` | u64 | The pool's hook fees paid to the treasury, as of the last settlement. |
| 248 | `last_split` | 3 x u16 | The three rates of the last trade's side, for settling it. |
| 254 | `creator_owed` | u64 | SOL (lamports of wrapped SOL) the creator may claim. |
| 262 | `burn_pot` | u64 | SOL waiting to buy and burn. |
| 270 | `acc_per_share` | u128 | Rewards per staked unit so far, times 10^12. |
| 286 | `reward_rem` | u64 | Remainder of the last division, carried forward. |
| 294 | `total_staked` | u64 | |
| 302 | `rewards_owed_total` | u64 | Sum of the `owed` of all stake records. |
| 310 | `total_creator_paid` | u64 | Counter. |
| 318 | `total_rewards_paid` | u64 | Counter. |
| 326 | `total_quote_burned` | u64 | Counter: SOL spent by `run_burn`. |
| 334 | `total_base_burned` | u64 | Counter: coins burned. |
| 342 | `burns` | u64 | Counter: runs that bought. |
| 350 | `obs_slot` | u64 | The burn's observation of the pool: the slot it was taken in. |
| 358 | `obs_reserve_base` | u64 | The observation, base side. `obs_reserve_quote / obs_reserve_base` is the observed price. A run writes the pool's base reserve here; a trade that lowers the observed price writes the base that goes with the quote side at the new price. Zero while there is no observation. |
| 366 | `obs_reserve_quote` | u64 | The observation, quote side: the observed depth, on which a run measures its cap. A run writes the pool's quote reserve here; a trade can only lower it. Zero while there is no observation. |
| 374 | the strict coin | 40 bytes | All zero on a plain coin. The fields of a strict coin are in "The strict coin". |

Bytes 8 to 239 never change once the pool exists.

### Stake record layout

`StakeRecord`, 113 bytes. Discriminator `[174, 163, 11, 208, 150, 236, 11, 205]`.

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `bump` | u8 | |
| 9 | `pool` | Pubkey | |
| 41 | `staker` | Pubkey | |
| 73 | `amount` | u64 | Coins staked. |
| 81 | `acc_snapshot` | u128 | `acc_per_share` when the record was last brought up to date. |
| 97 | `owed` | u64 | Rewards settled into the record and not paid yet. |
| 105 | `since_slot` | u64 | Slot of the last stake. |

### Lock record layout

`LockRecord`, 57 bytes. Discriminator `[157, 145, 17, 26, 171, 35, 61, 131]`.

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `bump` | u8 | |
| 9 | `pool` | Pubkey | |
| 41 | `amount` | u64 | Coins the creator put in and has not taken back. |
| 49 | `unlock_at` | i64 | Unix time from which `unlock_creator` works. Zero when nothing is locked. |

## How the money moves

1. On every trade the pool calls `before_swap`. The hook answers one hook fee: the sum of
   the three rates of that side, always all three. What a trader pays depends on the
   config and on the platform's caps, never on who staked. The hook writes the three
   rates into `last_split`.
2. The pool takes the fee in the quote token and pays it into the treasury, and adds it to
   its own counter `hook_fees_quote_total`.
3. The fee of a trade is settled the next time the program runs for that pool: at the next
   trade's `before_swap`, or at the start of `stake`, `unstake`, `claim_rewards`,
   `claim_creator` and `run_burn`. Settling takes what the treasury received and was not
   seen yet,

   `fresh = pool.hook_fees_quote_total - pool.hook_fees_owed_quote - cfg.fees_seen`,

   and splits it by `last_split` (rates `c`, `h`, `b`, sum `t`): `creator = fresh * c / t`,
   `holders = fresh * h / t`, both rounded down, and the burn pot takes the rest. The rest
   includes the unit or two that rounding leaves over, so a coin with no burn rate still
   collects a few lamports there. Where the holders' part goes is decided at that
   moment. When `total_staked >= min_eligible` it goes to the stakers, through the
   accumulator: `n = holders * 10^12 + reward_rem`, then `acc_per_share += n /
   total_staked` and `reward_rem = n % total_staked`. Otherwise it is added to the burn
   pot. Exactly one trade lies between two settlements, because the hook is called on
   every trade in both directions.
4. A stake record has earned `amount * (acc_per_share - acc_snapshot) / 10^12`, rounded
   down. `stake`, `unstake` and `claim_rewards` first move that into the record's `owed`,
   add it to `rewards_owed_total`, and set the snapshot to the current `acc_per_share`. A
   new stake therefore earns nothing of the trades before it.
5. `claim_creator` pays `creator_owed` to the creator. `claim_rewards` pays a staker what it
   is owed. `run_burn` spends from the burn pot. Each pays out of the treasury and lowers
   its number by what it paid.

`pool.hook_fees_owed_quote` is what the pool charged while the treasury account did not
exist. Here it is always zero: the treasury is created with the config and no instruction
closes it. The program subtracts it all the same, so that a fee is never promised to
anybody before the treasury holds it.

One case that cannot happen is still handled without losing money: a fee found while no
rate was recorded goes to the burn pot.

At every moment the treasury holds at least `creator_owed + burn_pot + rewards_owed_total`
plus the rewards not yet moved into stake records plus the fee not yet settled. All
rounding is in the treasury's favour. What rounding keeps stays in the treasury for good:
less than one unit each time a record is brought up to date, plus what `reward_rem` still
carries. In a test of 1,500 random steps that charged 21.7 SOL of fees it was 105 lamports.

Tokens that somebody sends to these accounts directly: quote sent to the treasury belongs
to nobody and stays there; coins sent to the stake vault are not staked and stay there;
coins sent to the burn account are burned by the next run; coins sent to the lock vault
come out with the next unlock.

## Instructions

Accounts are listed in order. `w` = writable, `s` = signer.

Callbacks, called by the pool only. Each starts with `verify_caller` and this program's
own id: the pool signs a callback with an address that belongs to the hook it calls,
`["caller", hook program]` under the pool program, so a call that another hook passes on
is refused (`HOOKS.md` section 3.1). For this program that address is
`G34yNuoVSXdpyhQg5V7h9PX8Qwq65RGZXWe4QiF8ozc7`. Accounts: the five fixed accounts of
`HOOKS.md` section 3.1, then the config (w).

* `on_pool_create(payload)`: checks that the config is this pool's, that the pool runs this
  hook (`WrongHook`), that the config's creator is the pool's creator (`WrongCreator`), that
  the mints match and that the pool's hook treasury is the config's treasury
  (`WrongTreasury`). The hook, the creator, the mints and the treasury are read from the
  Pool account, which only the pool program writes, not taken on the caller's word. Writes
  `start_slot`, `start_time` and `min_eligible = max(1, supply / 1000)`. Refuses a config
  whose pool already exists.
* `before_swap(payload)`: settles. On a buy inside the limit window, fails with
  `BuyTooLarge` when `amount_in > max_buy_quote`. Answers the hook fee of the side, and on a
  buy inside the sniper window a fee override of
  `start_fee - (start_fee - lp_fee) * elapsed / sniper_slots` (the pool's own fee once the
  window is over or when the start fee is not above it). `elapsed` is the trade's slot minus
  `start_slot`; a window of `n` slots covers `elapsed` 0 to `n - 1`. When the trade starts
  at a price below the burn's observation, it lowers the observed price to the price the
  trade starts at, never raises the observed depth, and leaves `obs_slot` as it is (see
  `run_burn`). `BuyTooLarge` is
  the only way this callback fails on a pool that runs this hook, so it can never refuse
  a sell.
* `before_add_liquidity(payload)`: fails with `LiquidityInSniperWindow` while the sniper
  window runs, that is when `sniper_slots > 0` and `payload.slot - start_slot <
  sniper_slots`. Writes nothing. The pool's own liquidity is not touched by this: it
  comes in with `create_pool`, which calls `on_pool_create` and not this callback, so a
  launch works as before. Taking liquidity out calls no callback and is never refused.

Setup:

* `init_manifest(uri)`: once, by the program's upgrade authority. Publishes the flags
  `BEFORE_SWAP | BEFORE_ADD_LIQ | ON_POOL_CREATE | OVERRIDE_FEE | TAKE_HOOK_FEE |
  CALL_ON_BUY | CALL_ON_SELL`, the number 13,125.
  Accounts: authority (w, s), the program's ProgramData, manifest (w), extra-metas (w),
  system program.
* `init_pool_config(pool, args)`: by the launcher, before the pool exists. Checks every
  bound. Creates the config, the treasury, the burn account and the stake vault. Fails when
  the config exists already. Anybody can send it; whoever pays becomes `cfg.creator`, and
  the pool then starts only when that wallet creates it. The treasury and the burn account
  are associated token accounts, which anyone can create for any owner: when somebody
  created one first, it is taken as it is.
  Accounts: payer (w, s), config (w), authority, base mint, quote mint, treasury (w), burn
  account (w), stake vault (w), base token program, quote token program, associated token
  program, system program.
  `args`, 46 bytes: `sniper_slots` u64, `sniper_start_fee_bps` u16, `buy` 3 x u16, `sell`
  3 x u16, `max_buy_quote` u64, `limit_slots` u64, `creator_lock_seconds` u64.

For everyone:

* `stake(amount)`: moves coins from the wallet to the stake vault. Opens the stake record
  the first time. Sets the record's `since_slot` to now, for all of its coins. Only the
  wallet itself can stake into its record. The pool must exist (`NotStarted`).
  Accounts: staker (w, s), config (w), pool, stake record (w), base mint, stake vault (w),
  the staker's coin account (w), base token program, system program.
* `unstake(amount)`: moves coins back. Refused until `UNSTAKE_DELAY_SLOTS` (9,000, about one
  hour) after the record's last stake (`UnstakeTooEarly`), so nobody stakes for one trade
  and leaves. An unstake does not restart the delay.
  Accounts: staker (s), config (w), pool, stake record (w), base mint, stake vault (w), the
  coin account that receives (w), base token program.
* `claim_rewards()`: pays the staker's rewards, in the quote token, to a token account the
  staker names. `NothingToClaim` when there is nothing.
  Accounts: staker (s), config (w), pool, stake record (w), authority, quote mint, treasury
  (w), the quote account that receives (w), quote token program.
* `run_burn(min_amount_out)`: buys the coin from the pool with the burn pot through the
  pool's `hook_swap` (no callback, no hook fee) and burns everything in the burn account.
  Anyone may send it and choose `min_amount_out`, so a run never buys at a price or on a
  depth its caller just made (`HOOKS.md` section 7). The config keeps an OBSERVATION of
  the pool for that: the two reserves, `obs_reserve_base` and `obs_reserve_quote`, and
  the slot they were taken in, `obs_slot`. A call goes through these steps in order:

  1. It settles the last trade. When the pot is empty it fails with `NothingToBurn`.
  2. No observation yet (one of its reserves is zero): it records the pool's reserves and
     the slot, buys nothing and returns Ok. Outcome 1.
  3. The observation is less than `BURN_INTERVAL_SLOTS` (25 slots, about ten seconds)
     old: it fails with `BurnTooSoon` and writes nothing.
  4. The price is above the observed price by more than `2 * cap_bps` basis points: it
     records the pool's reserves and the slot, buys nothing and returns Ok. Outcome 2.
  5. Otherwise it buys: it spends `spend`, burns what it bought, and records the pool's
     reserves after the buy and the slot. Outcome 3. `min_amount_out` applies to this buy
     only; a call that does not buy ignores it.

  ```
  burn_side(r) = 0 when r.creator_bps + r.holders_bps + r.burn_bps is 0, else
                 min(r.creator_bps + r.holders_bps + r.burn_bps, platform.max_hook_fee_bps)
                   * r.burn_bps / (r.creator_bps + r.holders_bps + r.burn_bps)
  sure     = platform.protocol_fee_bps + burn_side(buy) + burn_side(sell)
  soft     = platform.protocol_fee_bps + 2 * pool.lp_fee_bps
  cap_bps  = clamp((sure + min(sure, soft)) / 4, 1, 50)

  no_observation = obs_reserve_base == 0 or obs_reserve_quote == 0
  too_soon = slot < obs_slot + 25
  ran_away = reserve_quote * obs_reserve_base * 10000
               > obs_reserve_quote * reserve_base * (10000 + 2 * cap_bps)
  spend    = min(burn_pot, max(1, min(reserve_quote, obs_reserve_quote) * cap_bps / 10000))
  ```

  Whole numbers, divisions rounded down. `reserve_base` and `reserve_quote` are the pool's
  reserves when the call runs; `burn_pot` is the pot after step 1. The products of
  `ran_away` do not fit 64 bits: use 128-bit or arbitrary-size integers.

  Between two calls, `before_swap` lowers the observation when a trade starts at a price
  below the observed one. `reserve_base` and `reserve_quote` are here the reserves the
  trade starts from:

  ```
  lower when   obs_reserve_base != 0 and obs_reserve_quote != 0
           and reserve_base != 0 and reserve_quote != 0
           and reserve_quote * obs_reserve_base < obs_reserve_quote * reserve_base
  new_quote = min(reserve_quote, obs_reserve_quote)
  new_base  = ceil(new_quote * reserve_base / reserve_quote)
  obs_reserve_base, obs_reserve_quote = new_base, new_quote
  ```

  `obs_slot` stays, so this never postpones a run. The lowering moves the observed PRICE
  to the price the trade starts at and never raises the observed DEPTH: the quote side
  is the observed one, or the pool's when that is smaller. The base side is rounded up,
  so that the stored price is never above the price the trade started at; a second trade
  at the same price then changes nothing. When the pool is not deeper than the
  observation the division is exact and the observation is the pool's own two reserves.
  Neither side can become zero.

  Why each part is there:

  * The age of the observation. Whatever the caller did to the pool in its own
    transaction, a buy that pumps the price or liquidity that deepens the pool for a
    moment, is measured against a pool that was there at least 25 slots earlier.
  * The price check. A run does not buy at a price that is more than twice the cap above
    the observed one. Twice the cap is what one run at the cap moves the price by itself.
    A price that fell is no reason to wait.
  * The smaller of the two depths. Liquidity added a moment ago does not make the slice
    larger.
  * The lowering. Without it a wallet could pump, have a run record the pumped pool, sell
    back in the same transaction, and pump again 25 slots later against an observation
    that says the price did not move. The second pump is a buy that starts at the honest
    price, so it lowers the observation and the run waits again. A pumped price is
    bought at only when no trade started below it for the whole interval. It moves the
    price only: if it copied the pool's reserves, a wallet could add liquidity, nudge the
    price below the observation with one small sell, and have a second small sell write
    the deepened pool into the observation with its old slot. The run after it, in the
    same transaction, would spend a slice of the deepened pool.
  * The cap. `sure` is what a buy and a sell cost a position of any size and nobody gets
    back: the protocol fee of the buy and the burn share of both trades. The creator's
    rate is left out because the creator gets it back, and the holders' rate because the
    stakers do. `soft` is what a position much larger than the pool mostly gets back: the
    pool fee of both trades and the protocol fee of the sell. `burn_side` is the burn
    share of what the pool really charges when the platform's cap is below the three
    rates together.

  With the platform's protocol fee at launch (0.2%) the cap is 0.1% of the reserve on a
  coin with no burn rate. It reaches the ceiling of 0.5% once the burn rates of the two
  sides add up to 1.6% on a pool with no fee of its own, to 1% with a pool fee of 0.3%,
  and to 0.8% with a pool fee of 0.4% or more.

  Every call that returns Ok emits `BurnExecuted` and sets return data, 17 bytes: the
  outcome (one byte: 1, 2 or 3), then the quote spent and the coins burned, both u64
  little-endian and zero unless it bought. A client that simulates `run_burn` as the last
  instruction of a transaction reads there what a real call would do.

  Accounts: payer (s), config (w), authority, platform, pool (w), base mint (w), quote mint,
  the pool's base vault (w), the pool's quote vault (w), treasury (w), burn account (w),
  pool program, the pool program's event authority, base token program, quote token
  program, then this program's event authority and this program (the burn event is an
  event CPI). The platform account is read here: it must be the pool program's
  `["platform"]`.

For the creator (the signer must be `cfg.creator`, `NotCreator` otherwise):

* `claim_creator()`: pays `creator_owed` to a token account the creator names.
  Accounts: creator (s), config (w), pool, authority, quote mint, treasury (w), the quote
  account that receives (w), quote token program.
* `lock_creator(amount, unlock_at)`: moves coins from the creator's wallet to the lock
  vault. The first call creates the lock record and the lock vault. `amount` =
  18,446,744,073,709,551,615 (the largest u64, `LOCK_WHOLE_BALANCE`) means everything the
  creator's coin account holds when the instruction runs: a launch uses it to lock what
  the first buy bought without knowing the amount in advance. May be called again to
  add coins or to move the date later, never earlier (`UnlockEarlier`); `amount` may be
  zero then. `unlock_at` must be at least `start_time + creator_lock_seconds`
  (`UnlockBeforeDeclared`), in the future (`UnlockInPast`) and at most 365 days ahead
  (`UnlockTooFar`). The pool must exist (`NotStarted`).
  Accounts: creator (w, s), config, lock record (w), base mint, lock vault (w), the
  creator's coin account (w), base token program, system program.
* `unlock_creator()`: from `unlock_at` on, moves everything in the lock vault back to a
  coin account the creator names, and sets the record to zero. Before that `StillLocked`.
  A new lock may follow.
  Accounts: creator (s), config, lock record (w), base mint, lock vault (w), the coin
  account that receives (w), base token program.

There is no instruction that changes a rate, a window, the creator or the treasury.

A pause of the platform stops trades and deposits of liquidity, and with them the buy of
`run_burn`, which is a trade: a run that would buy fails. Stake, unstake, the two claims,
lock and unlock do not depend on it.

A payout cannot be pointed back at the account it leaves: Anchor refuses the same token
account in two writable places of one instruction (`ConstraintDuplicateMutableAccount`).

## Events

Every `run_burn` that returns Ok emits `BurnExecuted { pool, quote_spent, base_burned,
slot, outcome, obs_reserve_base, obs_reserve_quote }` through event CPI (`HOOKS.md`
section 11). `outcome` is a u8: 1 = it took the first observation, 2 = the price was above
the observation and it waited, 3 = it bought. The two amounts are zero unless it bought.
The two reserves are the observation the call left in the config. The others are plain
log events:

* `Staked { pool, staker, amount, staked, total_staked, slot }` and `Unstaked` with the
  same fields: `staked` is the record's amount afterwards.
* `RewardsClaimed { pool, staker, amount }`
* `CreatorClaimed { pool, creator, amount }`
* `CreatorLocked { pool, creator, amount, locked, unlock_at }`: `amount` is what this call
  added, `locked` what the record holds afterwards.
* `CreatorUnlocked { pool, creator, amount }`

The callbacks emit nothing. A trade is the pool's `Swapped` event; how its hook fee was
split is in the config after the next settlement.

## Errors

Anchor numbers them from 6000, like the pool and the interface crate do, so read the name.

| Number | Name | When |
|---|---|---|
| 6000 | `CreatorFeeTooHigh` | a creator rate above 500 |
| 6001 | `HoldersFeeTooHigh` | a holders' rate above 500 |
| 6002 | `BurnFeeTooHigh` | a burn rate above 500 |
| 6003 | `SideTooHigh` | the three rates of one side above 1,000 |
| 6004 | `StartFeeTooHigh` | sniper start fee above 5,000 |
| 6005 | `SniperWindowTooLong` | above 10,800 slots |
| 6006 | `SniperIncomplete` | a window without a start fee, or the reverse |
| 6007 | `LimitWindowTooLong` | above 9,000 slots |
| 6008 | `LimitIncomplete` | an amount without a window, or the reverse |
| 6009 | `LockTooLong` | declared lock above 365 days |
| 6010 | `WrongPool` | the pool is not the config's, or not the pool of the two mints |
| 6011 | `WrongHook` | a callback for a pool that does not run this hook (cannot happen: the pool calls a hook only for its own pools) |
| 6012 | `WrongCreator` | the pool's creator did not make the config |
| 6013 | `WrongMints` | a mint is not the config's |
| 6014 | `WrongTreasury` | a treasury is not the config's |
| 6015 | `AlreadyStarted` | `on_pool_create` for a config whose pool exists |
| 6016 | `NotStarted` | `stake`, `lock_creator` or `lock_creator_strict` before the pool exists |
| 6017 | `BuyTooLarge` | a buy above the limit, inside its window |
| 6018 | `ZeroAmount` | stake or unstake of nothing, or a first lock of nothing |
| 6019 | `UnstakeTooEarly` | less than 9,000 slots after the last stake |
| 6020 | `InsufficientStake` | more than the record holds |
| 6021 | `NothingToClaim` | |
| 6022 | `NotCreator` | |
| 6023 | `NothingToBurn` | the burn pot is empty |
| 6024 | `NothingBought` | the run bought nothing |
| 6025 | `UnlockEarlier` | the unlock time would move earlier |
| 6026 | `UnlockBeforeDeclared` | before the launch plus the declared lock |
| 6027 | `UnlockTooFar` | more than 365 days ahead |
| 6028 | `UnlockInPast` | the unlock time is not in the future |
| 6029 | `StillLocked` | |
| 6030 | `NothingLocked` | |
| 6031 | `MathOverflow` | arithmetic that cannot happen |
| 6032 | `BurnTooSoon` | `run_burn` or `run_burn_strict` while its observation of the pool is less than 25 slots old |
| 6033 | `LiquidityInSniperWindow` | `add_liquidity` while the sniper window runs |
| 6034 | `StrictCoin` | `lock_creator` on a strict coin (its lock is `lock_creator_strict`) |
| 6035 | `NotStrict` | an instruction of the strict coin on a plain coin |
| 6036 | `WrongKind` | the coin's transfer hook and the kind of its config do not agree |
| 6037 | `StrictNoBurn` | not returned any more. It was a burn rate on a strict coin; a strict coin has a burn now. The number stays so that the numbers after it do not move. |
| 6038 | `MaxWalletOutOfBounds` | share outside 10 to 5,000 bps, or window above 6,480,000 slots |
| 6039 | `MaxWalletIncomplete` | a share without a window, or the reverse |
| 6040 | `EarlyOutOfBounds` | window above 9,000 slots, unlock before the end of the window or above 1,512,000 slots |
| 6041 | `EarlyIncomplete` | a window without an unlock, or the reverse |
| 6042 | `NotATransfer` | `execute` outside a transfer of the coin by the token program |
| 6043 | `NotAssociatedAccount` | the receiving account is not the associated token account of its wallet |
| 6044 | `MaxWallet` | the transfer would leave the wallet above the max wallet |
| 6045 | `EarlyLocked` | coins bought early would leave the wallet before the unlock |
| 6046 | `CreatorLocked` | the creator's locked coins would leave the wallet before the date |
| 6047 | `HolderRecordRequired` | a buy in the early window by a wallet without a holder record |
| 6048 | `LiquidityInMaxWalletWindow` | `add_liquidity` on a strict coin while the max wallet runs |
| 6049 | `HolderNotEmpty` | `close_holder` on a record that holds, is owed or has locked something |
| 6050 | `WrongHolder` | not the associated token account of that wallet for that coin |
| 6051 | `LockAboveBalance` | a creator lock above what the wallet holds |

## Known limits

* **A burn never buys at a price its caller just made. A pump that stands for ten seconds
  is what is left.** Sequences of one transaction around a run lose money: buying before
  it and selling after it, with or without liquidity added for the moment, and also when
  the same transaction is sent again 25 slots later. Measured on chain
  (`the_five_instruction_sequence_finds_the_burn_waiting_and_ends_in_a_loss` and the
  tests after it) and over a grid of 62,000 sequences with the pool's own math
  (`no_transaction_around_the_burn_pays_at_any_fee_level_size_or_share_of_liquidity`):
  the best one gets back 50% of what its trades cost. What the rule does not stop is a
  wallet that pumps the price, has a run record the pumped pool, and LEAVES the pump and
  its liquidity in the pool for 25 slots. If no trade starts below that price in the
  meantime, the next run buys at it, mostly from that wallet's own liquidity. Measured
  (`a_pump_only_pays_when_it_stands_in_the_open_for_the_whole_interval`) on a pool of 100
  SOL with 12 SOL in the pot: a wallet that committed 2,306 SOL for 25 slots ended 2.06
  SOL up when nobody traded. When one holder sold a thousandth of the pool's coins into
  the pumped price, coins worth 0.1 SOL before, the holder received 2.38 SOL and the
  wallet ended 0.25 SOL down. What can be taken this way is never more than the pot, so
  a burn that is run regularly leaves little to take.
* **Nearly free pools.** On a pool where a buy and a sell cost next to nothing, a
  protocol fee of zero or one basis point and no burn rate to speak of, the cap is at its
  floor of 0.01% of the reserve and a sandwich inside the tolerance can break even or
  better. A wallet that simply holds the coin while burns run gains with every other
  holder; that is what the burn is for.
* **A burn is slow on purpose, and it waits while the price climbs.** A pot that grew
  large takes many runs, 25 slots apart. With the cap at 0.5% that is at most 3% of the
  quote reserve per minute. And a run buys only while the price is within twice the cap
  (0.2% to 1%) of the lowest price a trade started at since the observation: on a coin
  that is rising, or trading up and down, calls come back with outcome 2 and the pot
  waits for a calm stretch or a fall. In the random walks of the test suite, where a
  call comes every few minutes between trades of up to 6 SOL on a 100 SOL pool, two
  calls in three waited; the call 25 slots later, with no trade in between, bought.
  Whoever looks after a coin runs the burn on a timer, and again 25 slots after a call
  that waited.
* **Liquidity that is in the pool when a run buys sells the burn its share of the coins.**
  It does so at the pool's price and without the hook fee a sell pays, as liquidity does
  with any buy. A holder can leave some coins that way: add liquidity before a run, take
  it out after. A run spends a slice of the smaller of the pool now and the observed one,
  so liquidity added for one transaction does not make the slice larger, with or without
  small trades around it. Liquidity that was also there at the run before does: a run
  records the pool as it leaves it, with that liquidity in it, and the record keeps its
  depth until a trade starts below its price. Measured
  (`liquidity_added_for_one_transaction_does_not_raise_what_a_run_spends`): a wallet that
  made a 100 SOL pool twelve times deeper around two runs in a row, 25 slots apart, got
  an honest slice of 0.52 SOL at the first and twelve slices, 6.18 SOL, at the second.
  The price was the honest one both times. The coins burned per SOL spent are the same
  or more; what the holder saves is the sell fee on the coins the burn took from it,
  never more than the burn spends. What is lost is the pace: the pot goes faster.
* **The price check at the largest reserves.** The check adds in 128 bits and stops at
  the largest number when the sum would pass it, which needs both reserves near 2^64.
  The run then buys, and that is the exact answer: the other side of the comparison is a
  product of two 64-bit numbers and cannot reach that sum.
* **Somebody can make a run wait.** A buy that lifts the price above the tolerance right
  before a run makes that run wait one interval. So does a sell followed by any trade,
  which lowers the observation. It costs the fees of those trades each time, and the
  burn share of them feeds the pot.
* **Whoever is staked when a trade is settled gets its holders' share.** A wallet can
  stake 0.1% of the supply just before a large trade and receive the holders' share of
  it, which would otherwise go to the burn pot, or to the other stakers in proportion.
  The trader pays the same either way. The staker's coins then stay staked for about an
  hour.
* **`min_eligible` is fixed when the pool is created, from the supply at that moment.**
  Through the launchpad the whole supply exists by then and nobody can mint more. A coin
  made elsewhere whose mint authority is still alive can create its pool while the supply
  is tiny: `min_eligible` is then 1, a single staked unit makes the stakers eligible for
  ever, and whoever staked it takes the holders' share until others stake. Check the
  mint authority of a coin that was not launched through the launchpad.
* **The sniper fee goes to the liquidity the pool was created with, and a launch locks
  that liquidity.** A pool created directly with the pool program's `create_pool` leaves
  the LP tokens with its creator, who can take liquidity out during the window and
  afterwards, and its share of the fees with it.
* **A launcher who stakes is a holder too.** It receives its share of the holders' rate on
  top of the creator fee.
* **A declared lock is a declaration.** See "The rules" above.
* **Stake records, the lock record and the vaults are never closed**, so the rent paid for
  them does not come back.
* **Unstake and the two claims read the Pool account.** They work as long as the pool
  program keeps that account's layout, which the platform controls like the programs
  themselves.

## What a client does

* **Launch.** Transaction 1: create the coin, then `init_pool_config`. Transaction 2:
  `launch` with this hook and the config as the one extra account, then, when a creator
  lock was chosen, `lock_creator` for what the first buy bought. Both in one transaction,
  so the coins are never loose. Pass `amount` = the largest u64 there: it locks whatever
  the creator's coin account holds after the launch, which is exactly what the first buy
  bought when the whole supply went into the pool. (When the launcher kept coins out of
  the pool, they are in that account too and are locked with the rest; a client that
  wants to lock less computes the amount: the pool does not exist yet, so its reserves
  are the launch liquidity, the sniper fee is the start fee, all three rates of a buy
  are charged, and the pool's math gives the exact output.)
* **Trade.** A swap on the pool passes the config as the hook's one extra account,
  writable, the treasury as `hook_quote_treasury`, and as `hook_caller` the pool program's
  address for this hook (`["caller", this program's id]`). Nothing else differs from a
  swap on a tax pool.
* **Add liquidity.** `add_liquidity` on a pool with this hook calls the hook, so it takes
  what a swap takes: the hook program, its extra-accounts list, `hook_caller` and, after
  the fixed accounts, the config, writable. It fails with `LiquidityInSniperWindow`
  until slot `start_slot + sniper_slots`. About 63,000 compute units and 734 bytes
  without a lookup table. `remove_liquidity` calls nothing, needs no extra account and
  uses about 49,000 units.
* **Burn (a keeper).** Read the config, the pool and the platform account, and compute
  the pot as in "What can be claimed now" below. Then, with the formula of `run_burn`:
  1. Pot zero: nothing to do.
  2. No observation: send `run_burn(0)`. It records the observation and buys nothing.
     Come back 25 slots later.
  3. `slot < obs_slot + 25`: wait. A call before that fails with `BurnTooSoon`.
  4. `ran_away`: send `run_burn(0)` all the same. It records the pool as it is now, so
     that the next call can buy, and comes back with outcome 2. Come back 25 slots later.
  5. Otherwise send `run_burn(min_amount_out)`: it will spend `spend`. The minimum is the
     pool's quote for a buy of `spend` with no hook fee, less the slippage the keeper
     accepts.
  The outcome is in the event and in the return data. A keeper that prefers not to
  compute simulates the call first and reads the return data. A call costs about 24,000
  compute units when it does not buy and 77,000 when it does.
* **Quote.** The quote is exact and does not depend on who staked: read the config, take
  the three rates of the side, cap their sum at the platform's `max_hook_fee_bps`, and
  take the sniper fee of the slot. Inside the sniper window a trade that lands later pays
  less and gives more, as with the launch guard.
* **Show.** Everything a trader should know is in the config: the rates, the windows, what
  is staked, what was paid and burned. The lock is the lock record and the balance of the
  lock vault.
* **What can be claimed now.** The numbers in the accounts are one trade behind. To show
  the amount a claim would pay, do the settlement of "How the money moves", step 3, on a
  copy: compute `fresh` from the pool account and split it by `last_split`. When
  `total_staked >= min_eligible` the holders' part raises `acc_per_share`, and a staker
  is owed `amount * (new acc_per_share - acc_snapshot) / 10^12` on top of its `owed`.
  Otherwise the holders' part is added to the burn pot with the burn part.

## Costs

Measured in the test suite against the real programs (`compute_units_and_transaction_sizes`
in `tests/tests/rules.rs`). Compute units move by a few thousand from one coin to another,
with the addresses involved. On a local validator (Agave 4.3.0) the same instructions used
about 30 percent fewer units; `INTEGRATORS.md` sections 7 and 11 to 13 have those figures.

| What | Compute units | Size |
|---|---|---|
| `before_swap` alone | 8,000 to 9,000 | |
| A swap on a pool with this hook | 64,000 to 67,000 | 693 bytes |
| The same swap with no hook, and on a tax pool | about 41,500, and 64,000 to 67,000 | |
| Transaction 1 of a launch: coin and rules | 175,000 to 230,000 | 942 bytes |
| Transaction 2: launch with a first buy | 280,000 to 315,000 | 1,115 bytes |
| Transaction 2 with the creator lock as well | 305,000 to 340,000 | 1,215 bytes |
| `stake` | 26,000 to 38,000 | |
| `unstake` | 25,000 to 34,000 | |
| `claim_rewards`, `claim_creator` | about 25,000, about 20,500 | |
| `run_burn` that buys | 75,000 to 80,000 | 651 bytes |
| `run_burn` that takes an observation and buys nothing | 23,000 to 25,000 | 651 bytes |
| `add_liquidity`, of which `before_add_liquidity` | about 63,000, of which 6,700 | 734 bytes |
| `remove_liquidity` | about 49,000 | |
| `lock_creator`, first call and later calls | 32,000 to 40,000, and 21,000 to 29,000 | |
| `unlock_creator` | 19,000 to 24,000 | |

Sizes are legacy transactions without a lookup table, with a compute budget instruction
where a launch needs one; the limit is 1,232 bytes. Both launch transactions need more
than the default 200,000 units per instruction: ask for 400,000.

## The strict coin

A plain rules coin is an ordinary coin, so `hook_rules` runs only when the coin is traded in
its pool. Three rules need code that runs inside EVERY transfer of the coin: a cap per
wallet, a lock on coins bought early, and a share for every holder without staking. The
strict coin is a second kind of coin on this template that has that code.

A strict coin is a Token-2022 mint whose transfer hook is `hook_rules`, with no hook
authority, so the hook can never be changed or removed. It is created through the
launchpad's path for coins with a transfer hook (`create_pegged_mint` with `hook_program` =
this program, the token program's two metadata instructions, `finish_pegged_token`) and
launched with `launch`, like every coin. `hook_rules` is then both the pool's hook and the
coin's transfer hook. It is a launch option next to the plain coin, never a replacement:
nothing of this section runs for a plain coin, whose config says `kind = 0`.

A strict coin may use every rule of a plain coin except staking: the holders' share goes to
the wallets that hold the coin, without a stake. The burn works as on a plain coin, through
an instruction of its own, `run_burn_strict`. Everything is fixed at launch, as on a plain
coin.

A strict coin may also launch on the curve, with `launch_curve` in place of `launch`
(`INTEGRATORS.md` section 14); a pegged coin may not. Its rules do not change: the max
wallet, the early lock and the creator floor run for their windows from the launch,
whether or not the coin has graduated. Graduation itself calls no hook and touches no
wallet: it burns coins in the pool's own vault. The max wallet in coins and `min_eligible` are fixed from the supply
when the pool is created; graduation burns part of that supply, so after it they are a
slightly larger share of the coins that exist (a max wallet of 1% is about 1.07% after a
graduation at the target).

### What a launcher gives up for it

Say this to whoever switches one of the three rules on.

* **The coin is a Token-2022 coin with a transfer hook.** Wallets and services that do not
  support transfer hooks cannot move it. Every transfer names five more accounts (the
  config, the two holder records, the coin's account list and this program) and costs
  about 10,000 compute units more.
* **It trades only in its own pool here.** The pool program takes a coin with a transfer
  hook only when the hook is the pool's own. Another pool for the same coin, here or on
  another exchange that would have to hold the coin in an account of its own, does not
  work: a wallet receives the coin only in its associated token account.
* **One account per wallet.** A program that keeps coins in token accounts of its own (an
  escrow, a vault, another exchange) cannot receive a strict coin.
* **While the max wallet runs, nobody can add liquidity to the pool.** Taking liquidity out
  is never refused and never held to the max wallet.
* **The holders' share goes only to wallets that opened a holder record**, about 0.0018
  SOL of rent, which comes back when the record is closed. A buy in the early window
  needs the record too.
* **A wallet can buy right before a large trade, take a part of its holders' share and
  sell.** There is no unstake delay here. "Known limits of a strict coin" has the numbers.

### The three rules

| Rule | What it does |
|---|---|
| Max wallet | For a window after launch, a transfer is refused when it would leave the receiving wallet with more than a share of the supply. It holds a buy from the pool and a send from another wallet. It never holds a sell, a deposit of liquidity, or what the pool pays out when liquidity is taken out or when the protocol's fees are collected. |
| Early lock | A buy from the pool in the first slots after launch is an early buy. Until the unlock, a transfer out of a wallet is refused when it would leave the wallet with less than it bought early. Coins the wallet got in other ways stay free. |
| Holder rewards, without staking | The holders' share of every trade is paid to the wallets that hold the coin and have a holder record, in proportion to what they hold. Nothing is staked or locked. |

Bounds, checked by `init_strict_config`:

| Number | Policy (the form) | Ceiling (the program) |
|---|---|---|
| Max wallet, share of the supply | 0.5% to 5% | 0.1% to 50% (`max_wallet_bps` 10 to 5,000) |
| Max wallet window | up to 24 hours | 1 to 6,480,000 slots, about 30 days |
| Early window | up to 10 minutes | 1 to 9,000 slots, about one hour |
| Early unlock, after launch | up to 24 hours | from the end of the early window to 1,512,000 slots, about 7 days |

A rule is off when both of its numbers are zero. One without the other is refused. The max
wallet in units of the coin is fixed from the mint's supply when the pool is created, like
`min_eligible`. One person with several wallets passes a max wallet, on any chain.

### Accounts of a strict coin

| Account | Seeds (under `hook_rules`) | What it is |
|---|---|---|
| Config | `["cfg", pool]` | The same `RulesConfig` as a plain coin, with `kind = 1` and the strict numbers in what was its reserve. |
| Authority, Treasury | as on a plain coin | The treasury receives the hook fee of every trade. |
| Account list | `["extra-account-metas", mint]` | What Token-2022 reads on every transfer to know which accounts the hook takes. Written once by `init_strict_config`. Three entries: the config, the sender's holder record, the receiver's holder record. |
| Holder record | `["holder", pool, wallet]` | One per wallet that asked for its share. 129 bytes. |
| Lock record | `["lock", pool]` | The creator lock, the same `LockRecord` as a plain coin. |

A strict coin has no burn account, no stake vault and no lock vault. Its burn buys the coin
and burns it inside the pool's vault ("The burn of a strict coin" below). The creator's
locked coins stay in the creator's wallet ("The creator lock of a strict coin" below).

The strict part of `RulesConfig` (offsets 374 to 413; all zero on a plain coin):

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 374 | `kind` | u8 | 0 = plain coin, 1 = strict coin. Fixed when the config is created. |
| 375 | `buy_mark` | u8 | 1 between `before_swap` of a buy and the transfer that pays the buy out, inside one instruction. 0 whenever anybody can read the account. |
| 376 | `vault_bump` | u8 | Bump of the pool's vault of the coin. Written when the pool is created. |
| 377 | `max_wallet_bps` | u16 | Fixed at launch. 0 = no max wallet. |
| 379 | `early_slots` | u16 | Fixed at launch. 0 = no early lock. |
| 381 | `max_wallet_slots` | u32 | Fixed at launch. |
| 385 | `early_unlock_slots` | u32 | Fixed at launch. The unlock is `start_slot + early_unlock_slots`. |
| 389 | `max_wallet_amount` | u64 | `max(1, supply * max_wallet_bps / 10000)`, written when the pool is created. |
| 397 | `reserved` | [u8; 17] | Zero. (Bytes 397 to 404 were `holders_waiting` in a development version that was never deployed; nothing reads or writes them now.) |

Fixed once the pool exists: bytes 8 to 239 as on a plain coin, byte 374, and bytes 376 to
396. On a strict coin `total_staked` (294) is the sum of the balances in the holder
records. `burn_pot`, `burns`, the two burn counters and the observation work as on a plain
coin.

`HolderRecord`, 129 bytes. Discriminator `[215, 67, 31, 41, 155, 251, 178, 128]`.

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `bump` | u8 | |
| 9 | `pool` | Pubkey | |
| 41 | `owner` | Pubkey | The wallet. |
| 73 | `balance` | u64 | What the wallet's associated token account held after its last transfer. Rewards are paid on this. |
| 81 | `acc_snapshot` | u128 | `acc_per_share` when the record was last brought up to date. |
| 97 | `owed` | u64 | Rewards settled into the record and not paid yet. |
| 105 | `early_bought` | u64 | Coins bought from the pool inside the early window. |
| 113 | `locked` | u64 | The creator lock: only the creator's record has it. |
| 121 | `locked_until` | i64 | Unix time until which `locked` holds. |

### What the hook does in a transfer

Token-2022 calls `execute` on every transfer of the coin, after the balances moved. It
takes effect only then: both token accounts must carry the token program's "transferring"
flag, which only the token program sets while it calls the hook. A direct call, or a call
passed on by another program, fails with `NotATransfer`. The steps, in order:

1. Any transfer of the coin sets `buy_mark` back to 0 (step 4 uses the value it had).
2. The receiver. Unless it is the pool's vault, the receiving account must be the
   associated token account of the wallet that owns it (`NotAssociatedAccount`). Token-2022
   creates those with an owner that can never be changed. So every unit of the coin is in
   the pool's vault or in the one account of a wallet, and a wallet cannot hand an account
   with early coins to another owner.
3. The sender, when it is a wallet with a holder record. Until the early unlock its balance
   must stay at or above `early_bought` (`EarlyLocked`). Before `locked_until` it must stay
   at or above `locked` (`CreatorLocked`). The rule follows the wallet that owns the
   account, whoever signs: a delegate cannot move those coins either.
4. Is it a buy? Coins that leave the pool's vault are a buy when `before_swap` of a buy
   left the mark in this same instruction. Without the mark the pool is paying out
   liquidity that is taken out, or the protocol's fees: neither rule below applies, so
   liquidity can always leave.
5. The max wallet, while its window runs, on a buy and on a send from another wallet: the
   receiving wallet's balance must be at most `max_wallet_amount` (`MaxWallet`).
6. A buy inside the early window adds its amount to the receiving wallet's `early_bought`.
   That wallet needs a holder record (`HolderRecordRequired`). Outside the early window no
   record is ever needed to buy, hold, send or sell.
7. Rewards. For each side that is a wallet with a record: what its old balance earned goes
   into `owed`, then `balance` becomes what the wallet holds now.

Nothing is written when a rule refuses: the transfer fails as a whole.

The mark of step 4 is sound because the pool makes the payout of a buy inside the same
instruction that called `before_swap`, with no other program running in between (the
quote coin of a pool cannot have a transfer hook). It cannot be left behind: an
instruction that fails undoes it, and one that succeeds has made the payout.

While the max wallet runs, `before_add_liquidity` refuses deposits
(`LiquidityInMaxWalletWindow`). A removal is never refused, and the coins that come back
out of the pool with it are never held to the max wallet. If deposits were open, a wallet at the cap could deposit its
coins, buy up to the cap again and take the deposit back, as often as it liked.

### How the holders' share moves

The accounting of "How the money moves" is kept as it is, the burn pot included: one hook
fee per trade, split one trade late by `last_split`, the accumulator times 10^12,
`min_eligible`. One difference: what counts is not a stake but `total_staked`, the sum of
the balances in the holder records. A wallet without a record earns nothing and its part
goes to the wallets that have one. When less than `min_eligible` (0.1% of the supply) is
registered, the holders' part goes to the burn pot, as on a plain coin with too little
staked.

A token Burn does not call a transfer hook. After a burn a record stands above the real
balance until the wallet's next transfer, or until anybody sends `sync_holder`. Until then
that wallet is paid on coins that are gone, out of the other holders' part.

### The creator lock of a strict coin

The creator lock of a strict coin is a floor on the creator's own wallet. The coins stay in
the creator's associated token account. The transfer hook refuses any transfer that would
leave that wallet with less than `locked` before `locked_until` (`CreatorLocked`). No
instruction and no delegate moves those coins, so the lock is as hard as a vault. The
locked coins earn the holders' share like the coins of any wallet with a record.

The lock record is the same `LockRecord` as on a plain coin, at `["lock", pool]`: `amount`
is what is locked and `unlock_at` the date. A page reads the lock of a strict coin exactly
as it reads the lock of a plain coin. The creator's holder record carries the same two
numbers (`locked`, `locked_until`), which is what the transfer hook reads.

Why not a vault: an instruction of this program that moved the coin would make the token
program call `execute` of this same program while it runs, and the runtime refuses a
program that is entered again while it runs.

### The burn of a strict coin

`run_burn` buys the coin through the pool's `hook_swap`, which pays the coins out to the
burn account. On a strict coin that payout is a transfer of the coin: the token program
would call `execute` of this same program from inside `run_burn`, and the runtime refuses
that. So a strict coin burns with `run_burn_strict`, which buys through the pool's
`hook_buy_burn` (`HOOKS.md` section 7). That is the same buy as `hook_swap`, except that
the pool burns the coins bought straight from its own vault. No coin is transferred, so no
transfer hook runs, and no account outside the pool ever holds the coins being burned.

Everything else is `run_burn`: the observation, the 25 slots it needs, the tolerance, the
cap on the smaller depth, the lowering in `before_swap`, `BurnExecuted`, the 17 bytes of
return data and `min_amount_out`. The pool's reserves, its protocol fee and its counters
come out as for a `hook_swap` buy of the same size followed by a burn of what it bought.
The coin's supply falls by what was bought.

The attacks on the burn of a plain coin were run on a strict coin
(`the_attacks_on_the_burn_of_a_plain_coin_fail_on_a_strict_coin` in
`tests/tests/strict.rs`), on a pool of 100 SOL with a burn of 1% on buys and 2% on sells:

* BUY 400 SOL, every coin bought in as liquidity, the run, the liquidity out, SELL. The run
  waits, and the wallet ends 28.9 SOL down. The same 25 slots later: the run waits again,
  28.9 SOL down again. Nothing is ever bought at a pumped price.
* A buy of 0.1 SOL, inside the tolerance, with the same liquidity steps. The run spends a
  slice of the pool it observed, not of the deepened one, and the wallet ends 0.0069 SOL
  down.
* Liquidity that doubles the pool, then two small sells (the second lowers the
  observation). The run spends one slice of the observed pool.

Two windows close more of it. In the early window, coins bought cannot be sold before the
unlock, so a buy before a run cannot be sold after it. While the max wallet runs, a large
buy is refused and no liquidity comes in. Each attack ran as consecutive transactions in
one slot: the rule looks at slots, never at transactions, so one transaction ends the
same way. The limits of the burn of a plain coin in "Known limits" hold here as they are:
a pump that stands for the whole interval, and liquidity that is there at two runs in a
row. Those two were not run again on a strict coin.

### Instructions of a strict coin

Accounts in order. `w` = writable, `s` = signer.

* `init_strict_config(pool, args, strict)`: in place of `init_pool_config`. `args` is the
  46 bytes of a plain coin, `strict` is 12 bytes: `max_wallet_bps` u16, `max_wallet_slots`
  u32, `early_slots` u16, `early_unlock_slots` u32. Checks every bound of a plain coin (a
  burn rate included) and of the strict rules, and requires the coin to be a Token-2022
  mint whose transfer hook is this program with no authority (`WrongKind`). The coin signs, so only whoever creates
  the mint can bind it, and only once. Creates the config, the treasury and the account
  list. The plain `init_pool_config` refuses such a coin (`WrongKind`), and `on_pool_create`
  checks once more that the kind of the config and the coin agree.
  Accounts: payer (w, s), the coin's mint (s), quote mint, config (w), authority, treasury
  (w), account list (w), quote token program, associated token program, system program.
* `execute(amount)`: the transfer hook, called by Token-2022. Accounts: source token
  account, mint, destination token account, the signer of the transfer, account list,
  then config (w), the sender's holder record (w), the receiver's holder record (w).
  Either record may not exist.
* `open_holder()`: creates the wallet's holder record with what its associated token
  account holds now. Signed and paid by the wallet itself. Opening twice does nothing. It
  can be sent before the pool exists.
  Accounts: wallet (w, s), config (w), pool, holder record (w), the wallet's associated
  token account of the coin (it may not exist yet), system program.
* `claim_holder()`: pays what the record is owed, in the quote token.
  Accounts: wallet (s), config (w), pool, holder record (w), authority, quote mint,
  treasury (w), the quote account that receives (w), quote token program.
* `sync_holder()`: anyone. Lowers a record to what the wallet really holds. It never
  raises one.
  Accounts: config (w), pool, holder record (w), the associated token account of the
  record's wallet.
* `close_holder()`: closes a record that holds nothing and returns its rent: balance zero,
  nothing owed, nothing locked, and no early coins still under their lock
  (`HolderNotEmpty` otherwise).
  Accounts: wallet (w, s), config, holder record (w).
* `lock_creator_strict(amount, unlock_at)`: the creator lock. The creator needs a holder
  record. `amount` is added to what is locked; the largest u64 means everything the
  wallet holds. Not more than the wallet holds (`LockAboveBalance`). The date rules are
  those of `lock_creator`.
  Accounts: creator (w, s), config, lock record (w), the creator's holder record (w), the
  creator's associated token account of the coin, system program.
* `unlock_creator_strict()`: from `unlock_at` on, zeroes the lock. The coins were free from
  that moment already.
  Accounts: creator (s), config, lock record (w), the creator's holder record (w).
* `run_burn_strict(min_amount_out)`: anyone. The burn of a strict coin: `run_burn` in every
  respect, with the buy made by the pool's `hook_buy_burn` ("The burn of a strict coin").
  Discriminator `[159, 241, 149, 218, 41, 46, 171, 38]`.
  Accounts: payer (s), config (w), authority, platform, pool (w), the coin's mint (w), quote
  mint, the pool's coin vault (w), the pool's quote vault (w), treasury (w), pool program,
  the pool program's event authority, base token program (Token-2022), quote token
  program, event authority, this program. These are the accounts of `run_burn` without
  `authority_base`.

`claim_creator` is the one of a plain coin. `lock_creator` refuses a strict coin with
`StrictCoin`. `stake`, `unlock_creator` and `run_burn` fail on a strict coin before they
run, with Anchor's 3012 `AccountNotInitialized`: the stake vault, the lock vault and the
burn account they name do not exist on a strict coin. A strict coin burns with
`run_burn_strict`. The instructions above refuse a plain one (`NotStrict`).

Events, all plain log events: `HolderOpened { pool, owner, balance }`,
`HolderClaimed { pool, owner, amount }`, `HolderSynced { pool, owner, balance }`,
`HolderClosed { pool, owner }`. The creator lock emits `CreatorLocked` and
`CreatorUnlocked` as on a plain coin. `run_burn_strict` emits `BurnExecuted` with an event
CPI, as `run_burn` does. `execute` emits nothing.

### What a client does with a strict coin

* **Launch.** Transaction 1: `create_pegged_mint` with this program as the hook, the token
  program's metadata `Initialize` and `UpdateAuthority` to none, `finish_pegged_token`,
  `init_strict_config`, and `open_holder` for the launcher when there is a first buy in an
  early window or a creator lock. Transaction 2: `launch`, then `lock_creator_strict` when
  a lock was chosen. Measured with a first buy and a lock: 1,014 and 1,348 bytes as legacy
  transactions, 919 and 1,043 bytes with the platform's lookup table; transaction 2 without
  a lock is 1,283 bytes legacy and 947 with the table. Transaction 2 does NOT fit without
  the table, with or without a lock. 127,000 and 384,000 compute units: ask for 400,000
  and 600,000.
  The first buy is a buy like any other: above the max wallet, or early without the
  launcher's record, it fails the launch.
* **Trade.** A swap passes, after the pool's fixed accounts: the config (writable), the
  holder record of the wallet that owns the coin account in the swap (writable), the
  holder record address of the pool, `["holder", pool, pool]` (writable; it never exists),
  and the account list. Every one of them on a buy and on a sell, whether a record exists
  or not. The hook program is in the pool's fixed accounts already. An SDK swap is 944 to
  993 bytes legacy, 742 to 843 with the lookup table; 104,000 to 107,000 compute units.
* **Before a buy.** Read the config. In the early window (`slot < start_slot +
  early_slots`) put `open_holder` before the swap when the wallet has no record. While the
  max wallet runs, the buy fails when the wallet would end above `max_wallet_amount`.
* **Send.** A Token-2022 `TransferChecked` between two associated token accounts, with
  these accounts after its four: config (writable), the sender's holder record (writable),
  the receiver's holder record (writable), the account list, this program. A wallet that
  resolves transfer hooks the standard way finds them by itself. 445 bytes legacy, 30,000
  to 35,000 compute units.
* **Liquidity.** `add_liquidity` and `remove_liquidity` pass the same four accounts as a
  swap. Deposits are refused while the sniper fee or the max wallet runs.
* **Rewards.** `open_holder` once, `claim_holder` whenever. What a claim would pay now:
  settle on a copy exactly as for a plain coin, then `balance * (acc_per_share -
  acc_snapshot) / 10^12 + owed`.
* **Burn.** As for a plain coin ("What a client does"), with `run_burn_strict` in place of
  `run_burn` and its accounts. Read what it did from the return data or `BurnExecuted`.
* **Show.** `kind`, the two windows and their ends (`start_slot + max_wallet_slots`,
  `start_slot + early_slots`, `start_slot + early_unlock_slots`), `max_wallet_amount`, the
  wallet's `early_bought`, and the lock record.

### What can make a sell or a send fail

This is the full list for a strict coin. A page may show these sentences to buyers as they
are.

While a window runs, the coin's rules can hold coins back:

* **Early lock** (`EarlyLocked`). Coins bought from the pool in the early window cannot leave
  the wallet before the early unlock. The wallet's other coins can.
* **Max wallet** (`MaxWallet`). While the max wallet runs, a buy or a send fails when it
  would leave the receiving wallet above the cap. A sell is never held by it.
* **Record in the early window** (`HolderRecordRequired`). A buy in the early window needs
  the buyer's holder record. It holds a buy, never a sell or a send.
* **Creator lock** (`CreatorLocked`). The creator's locked coins cannot leave the creator's
  wallet before the date the creator chose. Each call that sets or extends the lock may
  put the date at most 365 days ahead, and may only move it later. It holds the creator
  only.

After the windows, coins outside the creator lock are held back by no rule of the coin. A
sell then fails only:

* when the platform is paused (`Paused`, from the pool program). The pause stops every
  trade on the platform. It never stops a send, and never taking liquidity out;
* when the sell would get less than the seller's own minimum (`Slippage`);
* when the amount is zero, or so small that nothing is left after the fees (`ZeroAmount`);
* when the wallet does not hold the amount (the token program's `InsufficientFunds`);
* when the client leaves out the accounts the coin's hook needs (an account error), or goes
  through more than one program in front of the pool ("Depth of calls" below). The
  platform's site passes the accounts and calls the pool directly.

A send then fails only:

* when the receiving account is not the receiver's associated token account
  (`NotAssociatedAccount`). A wallet app that sends to a wallet address uses that account;
* when that account does not exist yet and the sender does not create it in the same
  transaction, as wallet apps do;
* when the wallet does not hold the amount, or the client leaves out the hook's accounts,
  as for a sell.

What never happens. Nobody can freeze an account of the coin: it has no freeze authority,
and the pool refuses a coin that has one. Nobody can mint more: the launchpad removes the
mint authority. Nobody can point the coin at another transfer hook or remove it: the
extension has no authority. No instruction changes a rule after the launch. The
bookkeeping of a holder record cannot fail a transfer: it saturates instead of failing.

`after_the_windows_coins_that_are_not_locked_can_always_be_sold_and_sent` in
`tests/tests/strict.rs` checks this list. Inside the windows the early lock and the creator
lock hold. After them, every kind of wallet (one that bought early, one whose record is
above its balance after a burn, one whose record was closed, one that never had one, and
the creator after its date) sends to every kind of receiver and then sells everything it
holds. A pause stops a sell and not a send, and a send to an account that is not the
associated one is refused.

One thing sits outside the coin: the pool program and this program are upgradeable by the
platform (`HOOKS.md` section 9). An upgrade could change any of the above.

### Known limits of a strict coin

* **A wallet that buys just before large trades takes a part of their holders' share.**
  It opens a record, buys, and sells after the trades it saw coming. Nothing makes it
  wait: a strict coin has no warm-up rule, on purpose. Measured
  (`a_wallet_that_buys_just_before_a_large_trade_is_measured`) on a pool of 100 SOL with
  1% to holders on each side, with somebody buying 20 SOL and selling those coins back:
  with coins bought for 20 SOL registered before, a wallet that bought for 2 SOL ended
  0.044 SOL down; with 5 SOL registered it ended 0.037 SOL up; with 1 SOL registered,
  0.198 SOL up; with nothing registered, a wallet that bought for 1 SOL ended 0.367 SOL
  up. It pays when the volume that follows is more than about four times the value of the
  coins that are registered. Three things limit it in practice. The round trip pays every
  fee of the coin twice: the protocol fee, the pool fee, the creator fee, the holders'
  share and the burn. In the first minutes, when little is registered, the sniper fee and
  the early lock make the round trip expensive or impossible. And the platform's site puts
  `open_holder` in front of every wallet's first buy, so the registered coins are most of
  the coins in circulation, which is the case where it loses.
* **Only registered wallets are paid.** A holder who never opens a record gets nothing,
  and its part goes to the others. With less than 0.1% of the supply registered, the part
  goes to the burn pot.
* **A burn is paid until somebody syncs it.** See "How the holders' share moves".
* **A max wallet is per wallet**, and it is not held on what liquidity pays out. A pool
  made with `create_pool` directly leaves the LP tokens with its creator, who can take
  liquidity out during the window and receive coins above the cap. A launch locks that
  liquidity forever.
* **The creator's locked coins earn the holders' share** like any coins in a wallet with a
  record.
* **The burn has the limits of the burn of a plain coin** ("Known limits"): a pump that
  stands for the whole interval, and liquidity that is there at two runs in a row.
* **The cap and `min_eligible` are fixed from the supply when the pool is created.** A coin
  made outside the launchpad with a live mint authority can make them tiny, and can mint
  coins into any account afterwards, past every rule here. Check the mint authority.
* **Depth of calls.** A swap is the pool, the token program and this hook, three programs
  deep. One program in front of the pool (the launchpad, an aggregator) works. Two do not
  leave room for anything the innermost one calls.
* **The remainder of the accumulator** can be up to `total_staked / 10^12` lamports per
  settlement on a coin with a large supply. It is carried to the next settlement, not lost.

### Costs of a strict coin

Measured in `tests/tests/strict.rs`.

| What | Compute units | Size |
|---|---|---|
| `execute` alone | 9,900 to 10,500 | |
| `before_swap` on a strict coin | 8,500 to 9,200 | |
| A buy or a sell | 104,000 to 107,000 | an SDK swap: 944 to 993 bytes legacy, 742 to 843 with the lookup table |
| A send between two wallets | 30,000 to 35,000 | 445 bytes legacy |
| `add_liquidity` | about 101,000 | 865 bytes legacy |
| `open_holder` | about 18,500 | |
| `claim_holder` | about 26,500 | |
| `sync_holder` | about 12,300 | |
| `lock_creator_strict`, first call | about 22,800 | |
| `run_burn_strict` that buys | about 61,000 | 650 bytes legacy |
| `run_burn_strict` that observes or waits | 20,500 to 21,300 | 650 bytes legacy |
| Launch, transaction 1 | about 127,000 | 1,014 bytes legacy, 919 with the table |
| Launch, transaction 2 without a lock | | 1,283 bytes legacy (above the limit of 1,232), 947 with the table |
| Launch, transaction 2 with a first buy and a lock | about 384,000 | 1,348 bytes legacy, 1,043 with the table |
