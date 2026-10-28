# Programmable: pool-level hooks on Solana

Working name. This document is the contract between the pool program, the hooks that
plug into it, the SDK and the website. If something here changes, everything changes.

## 1. What a hook is

A hook is a Solana program chosen at pool creation. The pool program calls it by CPI at
fixed points of a swap or a liquidity change. The hook answers through return data.
The pool executes the answer inside hard limits. The hook never touches the vaults and
can never call the pool back during a callback (the Solana runtime forbids indirect
reentrancy, so this is enforced for free).

Differences from Uniswap v4 that the design has to live with:

| Constraint | Value | Consequence |
|---|---|---|
| Indirect reentrancy | forbidden | hooks return instructions, the pool executes them |
| Call depth | 5 levels, counting the instruction in the transaction as the first (9 where SIMD-0268 is active) | in a swap the pool is level 1 and the hook level 2; through the launchpad or a router the hook runs at level 3. Every call a callback makes itself (a token transfer, an event) takes one more level |
| Return data | 1,024 bytes | the hook answer is a small struct |
| Accounts | all declared up front | hooks publish an extra-accounts list, the SDK resolves it |
| Program upgrades | on by default | the pool refuses upgradeable third-party hooks |

## 2. Pool model (v1)

* Constant product `x * y = k`, exact-input swaps, `min_amount_out` slippage.
* Two mints: `base` (the launched coin) and `quote` (wrapped SOL or another SPL mint).
  `buy` = quote to base. `sell` = base to quote.
* SPL Token or Token-2022 mints. A Token-2022 mint is accepted only with extensions from
  a short allow-list: the metadata pointer and the token metadata, that is, the coin's own
  name. Every other extension is refused, including any that Token-2022 adds later: no
  transfer fee (the accounting would lie), nothing that lets someone else move, freeze or
  pause the vault's balance, nothing that rescales the amounts a wallet shows. One more
  is accepted under conditions, a transfer hook: the BASE coin of a pool may carry one
  when that hook is the pool's own hook program, the platform runs that program (hook
  kind `platform`), and the extension has no authority, so nobody can ever point the coin
  at another program. The quote mint never has one. Two templates make such coins: the
  pegged coin of the collectible template ("The pegged coin" in section 13) and the
  strict coin of the rules template (`RULES.md`, "The strict coin").
* The base coin must have no freeze authority (`BaseMintFreezable` otherwise): a freeze
  authority could freeze the pool's own vault. The quote mint is not checked for one, so
  a pool against a token whose issuer can freeze accounts depends on that issuer; wrapped
  SOL has none. The mint authority is the launchpad's business: section 8.
* LP token: an SPL mint whose authority is the pool PDA.
* Pool PDA: `["pool", base_mint, quote_mint]` under the pool program, so the address is
  known before the pool exists (hooks can prepare per-pool state in the same transaction).
* Fees, all in basis points (bps):
  * `lp_fee_bps`: pool-level, set at creation, `<= platform.max_lp_fee_bps`. Stays in the pool.
  * `protocol_fee_bps`: platform-level, taken from swap input, owed to the platform treasury.
  * `hook_fee_bps`: returned by the hook per swap, `<= platform.max_hook_fee_bps`,
    always denominated in **quote** (taken from input on buys, from output on sells),
    transferred to `pool.hook_quote_treasury`, which is fixed at pool creation. When
    that account does not exist at the moment of a swap, the fee waits in the pool and
    is paid later (section 3.3).

Swap order of operations (exact-in). Each fee is taken from what the fee before it left,
and each one is rounded UP to a whole unit:

```
amount_in
  - protocol_fee                   ceil(amount_in * protocol_fee_bps / 10,000)
  - hook_fee if buy                ceil(what is left * hook_fee_bps / 10,000), quote
  - lp_fee                         ceil(what is left after both * fee_bps / 10,000), where
                                   fee_bps = the hook's fee_override_bps if it returned
                                   one, else the pool's lp_fee_bps
  = net_in                         must be > 0
amount_out_gross = curve(net_in)   x*y=k rounded down, or the hook's CurveOut if OVERRIDE_CURVE
  - hook_fee if sell               ceil(amount_out_gross * hook_fee_bps / 10,000), quote
  = amount_out                     must be >= min_amount_out
reserve_in  += net_in + lp_fee
reserve_out -= amount_out_gross
```

A trade whose gross output rounds to zero fails with `ZeroAmount`, on every pool, with or
without a hook. A hook's `CurveOut` of zero, or not below the reserve it is paid from,
fails with `HookCurveInvalid`.

So a hook fee of 3% on a buy is not 3% of what the buyer sends. With a protocol fee of
0.2%, a pool fee of 1% and a buy of 100,000,000 units: the protocol takes 200,000, the hook
2,994,000 (3% of 99,800,000), the pool 968,060 (1% of 96,806,000), and 95,837,940 reach
the curve. On a sell the protocol fee and the pool fee are taken in the coin, and the
hook fee in the quote token, from what the curve pays out.

### A pool on the curve

A pool can be created in two ways. `create_pool` is the seeded pool above: the creator
puts coins and quote in, and gets LP for it. `create_curve_pool` (the same accounts, the
arguments `CreateCurvePoolArgs { lp_fee_bps: u16, base_amount: u64 }`) is the curve
launch: the creator puts the WHOLE supply of the coin in and no quote at all. The pool
then counts a quote reserve that is not there, the platform's `virtual_quote` (30 SOL by
default), in its price:

```
effective quote  = reserve_quote + virtual_quote      (the price is effective / reserve_base)
a buy            = constant product on (effective quote, reserve_base); net_in and the
                   pool fee go to the REAL reserve_quote
a sell           = constant product on (reserve_base, effective quote); the payout comes
                   from the REAL reserve_quote, and amount_out_gross <= reserve_quote
                   (CurveRealReserve otherwise)
```

Why nobody is ever owed the virtual part: the pool holds the whole supply when it opens
and the mint is closed (`create_curve_pool` requires `base_mint.supply == base_amount`
and no mint authority, error `CurveSupplyNotInPool`), so no wallet can ever sell coins
into the pool that did not come out of it; nothing but trades moves the reserves
(`add_liquidity` and `remove_liquidity` fail with `CurveOpen` while the curve is open;
protocol fees and hook fees are outside the reserves as always); and no hook that owns the
price curve runs such a pool (`CurveHook`). A pegged coin, a Token-2022 coin whose transfer
hook is the collectible template (section 13), does not open a pool on the curve either
(`CurvePegged`, held by the pool program and by the launchpad alike); a strict coin does.
Then `(reserve_quote + virtual_quote) *
reserve_base` never falls, and a sell of every coin outside the pool stops short of the
real reserve. The check on the payout stays as a belt. Tokens or quote sent straight to a
vault change nothing: the pool reads its reserve fields, never the vault balances, and no
instruction syncs the two.

The LP of a curve pool is `isqrt(base_amount * virtual_quote)`, all of it minted into the
pool's own lock account, none to the creator: the quote in the pool is the buyers'. The
pool copies the platform's `curve_virtual_quote`, `curve_graduation_target` and
`curve_graduation_fee_bps` at creation (section 8); a later change of the platform does
not touch a running curve. Curve launches are off when the platform's virtual quote or
target is 0 (`CurveDisabled`).

`graduate` is permissionless and takes the platform, the pool, the base mint, the base
vault, the base token program and the two event accounts; no hook callback runs and
nothing is paid to anyone. It graduates an open pool once `reserve_quote >=
graduation_target`. On an open pool still under its target, and on a pool that already
graduated, it succeeds and does nothing: no write, no event. It fails only on a seeded pool
(`NotOnCurve`) and, on a pool that has not graduated, while the platform is paused
(`Paused`). A client may therefore append `graduate` to any trade on a pool on the curve:
the first to land at the target graduates the pool, and no other one fails the trade it
travels with, also when a sell in between took the pool back under the target. It does
this:

```
fee  = graduation_target * graduation_fee_bps / 10_000, floored, at most reserve_quote - 1
R2   = reserve_quote - fee                 protocol_fees_quote += fee (collected as usual)
B2   = floor(R2 * reserve_base / (reserve_quote + virtual_quote))
burn = reserve_base - B2                   burned from the vault, signed by the pool
reserve_base = B2, reserve_quote = R2, virtual_quote = 0, graduation_target = 0,
curve_state = CURVE_GRADUATED
```

The price is the same before and after: flooring `B2` can move it up by less than one
unit of the coin, never down. From then on the pool is an ordinary pool: liquidity opens,
`virtual_quote` is 0, the hook keeps running, the address does not change. Trades keep
going between the moment the target is reached and the moment somebody calls `graduate`,
on the curve, with the virtual part still in; the SDK appends `graduate` to the buy that
crosses the target, and the watcher cranks it.

`PoolData.curve_state` says which pool it is: `CURVE_NONE` (0, seeded), `CURVE_OPEN`
(1), `CURVE_GRADUATED` (2). Section 10 has the fields. Two things for hooks: the
`SwapPayload` keeps the REAL reserve (section 3.2), and a hook that compares prices or
measures a depth must use the effective quote. The two platform templates that do
(`hook_rules`, `hook_buyback`) store `(reserve_base, reserve_quote + virtual_quote)` as
their observation and hand `burn_step` and `burn_lowered` effective values (section 7).

## 3. Callbacks

The pool calls the hook with an Anchor-style instruction. Discriminator = first 8 bytes of
`sha256("global:<name>")`, so a hook written in Anchor implements them as ordinary
instructions with these exact names:

| Name | When | Flag required |
|---|---|---|
| `on_pool_create` | once, inside `create_pool` | `ON_POOL_CREATE` |
| `before_swap` | before the curve runs | `BEFORE_SWAP` |
| `after_swap` | after transfers are done | `AFTER_SWAP` |
| `before_add_liquidity` | before LP mint | `BEFORE_ADD_LIQ` |
| `after_add_liquidity` | after LP mint | `AFTER_ADD_LIQ` |
| `before_remove_liquidity` | before LP burn | `BEFORE_REMOVE_LIQ` |
| `after_remove_liquidity` | after LP burn | `AFTER_REMOVE_LIQ` |

A callback is **only** invoked when its flag is set. Swap callbacks are additionally
skipped when the direction's flag is missing: a hook without `CALL_ON_SELL` is never
called on a sell, so it cannot block or tax sells. This is the only honeypot guarantee
that holds on Solana, because a failed CPI fails the whole transaction and the pool
cannot catch it.

### 3.1 Accounts passed to every callback

```
0  pool                 readonly   the Pool account (layout in the interface crate)
1  hook_caller          signer     PDA ["caller", hook program] of the pool program: the
                                   address the pool signs with when it calls THIS hook, and
                                   no other. Hooks MUST check that it signed and that it is
                                   their own (verify_caller), otherwise anyone can call the
                                   hook directly.
2  user                 readonly   the wallet doing the swap / liquidity change
3  quote_mint           readonly
4  base_mint            readonly
5..                     the hook's extra accounts, in the order of its ExtraAccountMetaList
```

The five fixed accounts are read-only and only `hook_caller` signs. The trader (account
2) is never a signer inside a callback, so a hook cannot spend from the trader's wallet
or create an account in the trader's name.

**One caller address per hook program.** `hook_caller` is derived from the hook being
called: `["caller", hook_program]` under the pool program. The reason is a rule of the
runtime: a program that is called with a signer may pass that signer on in a call of its
own. If the pool signed every callback with one address, any hook the pool calls could
call a second hook's callback itself, with the pool's signature attached and with
accounts and a payload of its choosing: arm another hook's config before its pool
exists, or report a buy that never happened. With an address per hook program, the
signature a hook receives is worth nothing to any other hook. `verify_caller` takes the
hook's own program id for that reason: `verify_caller(&hook_caller, &crate::ID)`.

Every pool instruction that carries `hook_caller` (`create_pool`, `swap`, `add_liquidity`,
`remove_liquidity`) derives it from the `hook_program` account it is given, also when no
callback runs. A pool without a hook is given the system program there, so its
`hook_caller` is `["caller", <32 zero bytes>]`; nothing is ever signed with it.

What `verify_caller` does not prove is which pool the call is about: a hook program can
pass the signature it received on to itself. A callback that writes state for the pool
in account 0 should therefore take what it can from that Pool account, which only the
pool program writes (`PoolData::read`: the hook program, the creator, the mints, the
treasury, the slot of creation), and not from the payload alone. All five platform
templates do it in `on_pool_create`: `hook_tax` and `hook_buyback` read the creator
there (and the buyback the mints and the treasury), `hook_launch_guard`,
`hook_collectible` and `hook_rules` read the hook program and the creator (`hook_rules`
also the mints and the treasury). So do the
hook of `hook-template/` and the two of `examples/hooks/`.

In `on_pool_create`, account 2 is the wallet that creates the pool, the same key as
`payload.creator`. Through the launchpad that is the wallet that launches the coin. The
Pool account (account 0) is already written when the callback runs, with the initial
liquidity as its reserves. `PoolCreatePayload` carries no slot: take it from the clock or
from `PoolData.created_slot`.

What the pool guarantees about the extra accounts (5 and up):

* It derives every address from the hook's list, on every call, and looks each one up
  among the accounts the client passed after the fixed ones. When one is missing, or
  another account was passed in its place, the call fails with `HookExtraAccounts`.
* The hook receives exactly the listed accounts, in the order of the list. The client may
  pass them in any order and may pass more accounts than the list names.
* An entry the list marks writable must be passed writable by the client. Otherwise the
  runtime stops the transaction ("Cross-program invocation with unauthorized signer or
  writable account").
* No extra account is ever passed as a signer (section 3.3).
* The pool does not check that an extra account exists or holds anything. An account that
  may not exist yet, such as one per trader that the trader has to open, reaches the hook
  as an empty account owned by the system program. Declare it as an unchecked account and
  check its owner by hand, or every trade by a wallet without one fails.
* On a trade the hook is not called for (a sell, for a hook without `CALL_ON_SELL`) the
  client does not have to pass any extra account.

### 3.2 Payloads (borsh)

```rust
pub struct SwapPayload {
    pub direction: u8,        // 0 = buy (quote -> base), 1 = sell (base -> quote)
    pub amount_in: u64,       // what the user sends, before any fee
    pub net_in: u64,          // after protocol + hook + lp fees (after_swap only, else 0)
    pub amount_out: u64,      // after_swap only, else 0
    pub reserve_base: u64,    // reserves at the moment of the callback: before the swap in
    pub reserve_quote: u64,   // before_swap, after it in after_swap (the pool account is
                              // rewritten before after_* callbacks, so account 0 agrees).
                              // reserve_quote is the REAL reserve. On a pool on the curve
                              // the price is (reserve_quote + virtual_quote) / reserve_base:
                              // read virtual_quote from account 0 (PoolData) and add it.
    pub lp_fee_bps: u16,      // the pool's fee, so the hook can decide an override
    pub slot: u64,
}
pub struct LiquidityPayload {
    pub base_amount: u64,
    pub quote_amount: u64,
    pub lp_amount: u64,       // after_* only, else 0
    pub reserve_base: u64,
    pub reserve_quote: u64,
    pub slot: u64,
}
pub struct PoolCreatePayload {
    pub lp_fee_bps: u16,
    pub base_amount: u64,
    pub quote_amount: u64,    // 0 for a pool on the curve
    pub creator: Pubkey,
}
```

The payloads did not change for the curve launch. A hook that wants a price takes
`virtual_quote` from the Pool account it receives as account 0 and adds it to the
payload's `reserve_quote` (`PoolData::effective_quote()` does the sum on the account's
own fields); on a seeded pool and after graduation that adds 0. A hook that only takes a
fee, limits a buy or counts trades needs nothing of this: the kit hooks and the examples
read no price and are unchanged.

### 3.3 Return data (hook to pool, borsh, read with `get_return_data`)

Only `before_swap` is read. Other callbacks may set return data; it is ignored.

```rust
pub struct HookReturn {
    pub version: u8,                      // 1
    pub fee_override_bps: Option<u16>,    // needs OVERRIDE_FEE, else must be None
    pub hook_fee_bps: u16,                // needs TAKE_HOOK_FEE, else must be 0
    pub curve: Option<CurveOut>,          // needs OVERRIDE_CURVE, else must be None
}
pub struct CurveOut {
    pub amount_out_gross: u64,            // for the given net_in. Pool checks it against reserves.
}
```

Pool-side rules, applied regardless of what the hook says:

* `fee_override_bps` is clamped to `platform.max_fee_override_bps`. An override of 0 is
  accepted: that swap pays no pool fee.
* `hook_fee_bps` is clamped to `platform.max_hook_fee_bps`.
  Clamped, not rejected: a rejection would let a hook (or an admin lowering a cap) turn
  the cap into a kill switch for one trade direction.
* A field used without its flag fails the swap with `HookPowerNotGranted`. Hooks cannot
  grow powers after creation.
* Return data that does not decode as a `HookReturn`, or whose `version` is not 1, fails
  the swap with `BadHookReturn`.
* `curve.amount_out_gross` must be `> 0` and `< reserve_out`. A curve hook can hand the
  reserves to anyone, so the launchpad refuses `OVERRIDE_CURVE` hooks and the website
  labels such pools in strong words.
* Empty return data = "no opinion" (fee as pool, no hook fee, pool curve).
* The hook treasury is chosen by whoever creates the pool, not by the hook's author. It
  must be the associated token account of its owner for the quote mint (so anyone can
  recreate it) and never the pool's vault. The pool stores it in `hook_quote_treasury`
  and its owner in `hook_treasury_owner`; a hook that wants to constrain either reads
  them in `on_pool_create`. A pool whose hook has no `TAKE_HOOK_FEE` stores the all-zero
  key in both.
* When the treasury account does not exist at the moment a swap owes it a fee, the trade
  still goes through and the fee is not lost. It stays in the quote vault, outside the
  reserves, counted in `pool.hook_fees_owed_quote`. The next swap that finds the treasury
  pays everything owed, and anyone can pay it with the pool instruction
  `collect_hook_fees` once the account exists again.
* The pool never passes an extra account to a hook as a signer, whatever the hook's list
  says. Never set `is_signer` in a list: it gives nothing on chain, and a client that
  copied the bit would build a swap nobody can sign (the SDK ignores it). If a list names
  the trader's own wallet, it reaches the hook read-only and unsigned, like account 2.

## 4. Hook manifest and extra accounts

Every hook program publishes two accounts, both PDAs under the **hook** program:

* `["manifest"]`: `HookManifest`
  ```rust
  pub struct HookManifest {
      pub version: u8,            // 1
      pub flags: u32,             // section 5
      pub admin: Option<Pubkey>,  // declared operator key, or None. A declaration for
                                  // people to read: nothing on chain checks it.
      pub name: [u8; 32],         // utf-8, zero padded
      pub uri: [u8; 128],         // docs / source, zero padded
  }
  ```
* `["extra-metas"]`: an `ExtraAccountMetaList` (the same TLV format Token-2022 transfer
  hooks use, crate `spl-tlv-account-resolution`), keyed by the discriminator of
  `hookpool-interface:callback`. One list serves every callback. Seeds may reference the
  fixed accounts by index (0 = pool, 2 = user, ...), so per-pool state such as
  `["cfg", pool]` resolves without the pool knowing about it.

The pool reads the manifest once, at `create_pool`: it copies `flags` into the Pool
account and stores the `extra-metas` address. A manifest changed later changes nothing
for existing pools; every pool created afterwards copies the new flags. A manifest with a
flag bit the pool does not know is refused (`UnknownFlags`); a manifest with no flag at
all is accepted, and its hook is never called.

The extra-accounts list is different. The pool reads it again on every call, so a hook
that rewrites its list changes all of its pools at once: an emptied list makes every
trade the hook is called for fail. Freezing a hook prevents neither change. A frozen
program's code can never change, but the program can still write the accounts it owns,
the manifest and the list included, when its code has an instruction that does. The
template and the two example hooks in this repository write both once, in
`init_manifest`, and have no instruction that writes them again.

The SDK resolves the extra accounts itself (`sdk/src/extraMetas.ts`). `INTEGRATORS.md`
gives the format byte by byte for clients that do not use the SDK.

### 4.1 Rules for hook authors

* **Freeze before use.** The pool takes a third-party hook only once its upgrade
  authority is removed (section 6), and nothing undoes that. So a hook cannot be tried on
  a real pool before it is final: test it in process first. `hook-template/` has such a
  test and the script that deploys and freezes.
* **What freezing fixes.** The code, forever. The program can also never be closed, so
  the SOL that pays its rent never comes back. The accounts the program owns can still
  change in every way its code allows: per-pool configs, per-trader accounts, and the
  manifest and the list as described above.
* **A hook with a per-pool config must declare `ON_POOL_CREATE`.** Without that flag the
  pool is created without calling the hook, even when no config exists: the first trade
  the hook is called for then fails on the missing account, and whoever creates the
  config first owns that pool's settings.
* **Verify the caller with your own program id.** The first line of every callback is
  `verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?`. It accepts
  only the address the pool signs with for your program (section 3.1). A hook that
  compared against a fixed address, or skipped the check, could be called by anybody.
* **Check who made the config.** Pool addresses are predictable, so anyone can create the
  config of a pool that does not exist yet. Record who paid for the config and require
  that key to equal `payload.creator` in `on_pool_create`, and, better, the `creator`
  written in the Pool account (`PoolData::read`): a pool then fails to start
  instead of starting on a stranger's parameters. The check does not stop the stranger
  from taking the address. The launch fails and that coin can never launch on that hook,
  so the coin and its config belong in one transaction (the SDK's launch does this) and
  a mint address should not be public before its config exists.
* **Extra accounts.** Never a signer. An entry's seeds are packed into 32 bytes: a
  literal costs its length plus 2, an account named by its index costs 2. The size of the
  list account is `extra_metas_size(n)` for exactly `n` entries. The interface crate
  builds the two usual entries: `per_pool_config_meta(seed, writable)` for
  `[seed, pool]` and `per_user_meta(seed, writable)` for `[seed, pool, trader]`.
* **Error numbers collide.** Anchor numbers every program's errors from 6000, and the
  pool, the launchpad, the interface crate and a hook all do: 6001 is the pool's
  `NotAdmin`, the interface crate's `CallerMismatch` and whatever a hook declared second.
  Read the error NAME in the logs, never the number alone. A hook can move its own
  numbers out of the way with `#[error_code(offset = 7000)]`, as the template does.
* **Compute.** Measured on a local validator: the pool's swap instruction uses about
  29,000 units on a trade it calls no hook for, and 43,000 to 50,000 with one callback
  of the template or of an example hook, of which the hook's own code is 6,800 to 8,100.
  Part of that depends on the hook's program id: the caller address is derived once by
  the pool and once by `verify_caller`, about 1,500 units for every try the derivation
  needs. Most ids need one or two tries.
  A whole launch transaction with a custom hook used 173,000 to 241,000 of the 400,000
  the SDK asks for.
  `create_pool` alone can pass the default limit of 200,000 units when the pool has a
  hook, and comes close to it without one: it derives eight addresses, and what that
  costs depends on the addresses (measured in the test suite: 126,000 to 153,000 without
  a hook, up to 203,000 with a template hook; a local validator counted 85,000 to
  115,000 without a hook). A transaction that creates a pool must ask for more with a compute budget
  instruction; 400,000 is enough for every case measured.

## 5. Flags

```
BEFORE_SWAP        = 1 << 0
AFTER_SWAP         = 1 << 1
BEFORE_ADD_LIQ     = 1 << 2
AFTER_ADD_LIQ      = 1 << 3
BEFORE_REMOVE_LIQ  = 1 << 4
AFTER_REMOVE_LIQ   = 1 << 5
ON_POOL_CREATE     = 1 << 6

OVERRIDE_FEE       = 1 << 8     may return fee_override_bps
TAKE_HOOK_FEE      = 1 << 9     may return hook_fee_bps
OVERRIDE_CURVE     = 1 << 10    may return CurveOut (pool skips x*y=k)

CALL_ON_BUY        = 1 << 12    swap callbacks run on buys
CALL_ON_SELL       = 1 << 13    swap callbacks run on sells
```

The website turns these into one sentence per pool, for example:
"Runs on buys and sells. Can take up to 5% to its treasury. Cannot change the curve."

## 6. Upgradeability rule (enforced on-chain)

At `create_pool` the pool program receives the hook program account and its loader state
and accepts the hook only if one of these holds:

1. BPF Loader Upgradeable: `ProgramData.upgrade_authority_address == None`, **or** the
   authority is in `platform.whitelist`.
2. Loader v4: status `Finalized`, **or** the authority is in `platform.whitelist`.
3. Non-upgradeable loader (BPFLoader2): always immutable, accepted.

Everything else is rejected and the pool is never created. `pool.hook_kind` records
which case matched: `1 = frozen`, `2 = platform (whitelisted authority)`. The website
shows the kind. The whitelist lives in the Platform account and only the admin can edit
it; the watcher logs every edit.

The check happens at creation. A frozen hook stays frozen forever. A whitelisted
authority is one of our keys, so its later behaviour is our responsibility, same as the
pool program itself.

### 6.1 The approved list (enforced on-chain)

On top of section 6, the platform can require that an outside hook was reviewed. While
`platform.hook_approval_required` is true, `create_pool` and `create_curve_pool` (and so the
launchpad's `launch` and `launch_curve`) accept a hook of kind `1 = frozen` only when its
program id is on the platform's approved list. Otherwise the pool is never created:
`HookNotApproved` (6052). Kind `2 = platform` hooks (a whitelisted authority: the templates)
and pools without a hook need no approval.

* The list lives in the Platform account itself, after its fixed part, so that every client
  that already passes the platform carries it with no new account. Byte 451 holds a u32
  little-endian count, then come 32 bytes per program id, in no particular order. A platform
  account of exactly 451 bytes has no list. The rule is byte 405, the first of the old
  reserved bytes, so every platform written before it reads false.
* `approve_hook` (admin) adds a program. It must be frozen (`classify_hook` returns kind 1),
  and the admin pays the rent of the account's growth by 32 bytes. A program of the
  platform's own (kind 2) is refused with `HookApprovalNotNeeded` (6054), a listed one with
  `HookAlreadyApproved` (6053), a full list (256) with `TooManyApprovedHooks` (6055).
* `revoke_hook(program)` (admin) removes it. The last entry takes its place, the account
  shrinks, and the admin gets the freed rent, together with any lamports someone else sent
  to the platform account: it is left holding exactly the rent of its new length. Pools already open on that hook keep it and
  keep trading, because a pool's hook never changes after its creation. Only new pools are
  refused.
* `update_platform` switches the rule with its eleventh optional field,
  `hook_approval_required`.
* Events: `HookApprovalChanged { program, approved, count }` and
  `HookApprovalRequiredChanged { required }`.
* A count the account cannot hold is `ApprovedListCorrupt` (6056) while the rule is on: the
  pool refuses rather than guess.

What the list means is decided off chain. On the reference deployment it is Programmable's
review of one frozen program, the verified build of one reviewed commit: the review rules and
the request form are on the site's review page, and `scripts/check-hook-release.mjs` and
`scripts/hook-approval.mjs` are the operator's two tools. A review is not an audit.

## 7. Hook-initiated swaps

A hook may want to trade on its pool outside a callback (buyback and burn). It cannot
call `swap`, because the pool would call the hook back and the runtime rejects
`hook -> pool -> hook`. Instead the pool exposes `hook_swap`, identical to `swap` but:

* no callbacks are invoked,
* the signer must be the PDA `["hook-authority", pool]` of `pool.hook_program`.

Fees (protocol, lp) still apply. The hook fee does not (it would pay itself).

A hook that is also the TRANSFER hook of its coin cannot use `hook_swap` to buy that
coin, and cannot move the coin in any instruction of its own. The payout of the purchase
is a transfer of the coin, so the token program would call the hook program's `execute`
while that same program is still running further up, and the runtime refuses a program
that is entered again while it runs (only a program calling itself directly is allowed).
`hook_swap` also passes no accounts for a transfer hook. For a buy whose coins are to be
burned, the pool has a second instruction, `hook_buy_burn`:

* the same buy as `hook_swap` in the buy direction: the same signer, the same check of it,
  the quote taken from the hook's own account, the protocol fee and the pool fee, no hook
  fee, no callbacks;
* except that the coins bought are BURNED by the pool, straight from its own vault, and
  never transferred. No transfer hook runs.

`hook_buy_burn(amount_in: u64, min_amount_out: u64, authority_bump: u8)`, discriminator
`[8, 103, 173, 214, 106, 75, 167, 33]`. Accounts in order: the hook authority (s), the
platform, the pool (w), the base mint (w), the quote mint, the base vault (w), the quote
vault (w), the hook's quote account (w; mint = the quote mint, owner = the hook
authority), the base token program, the quote token program, then the event authority and
the pool program. These are the accounts of `hook_swap` without `hook_base`.

The pool's reserves, its protocol fee, its volume, its swap count and its `Swapped` event
come out exactly as for a `hook_swap` buy of the same size followed by a burn of what it
bought: `by_hook` is true, `hook_fee` is zero, `user` is the hook authority. Return data is
`amount_out`, as for a swap. A client tells the two apart by the instruction (its
discriminator) and by its inner instructions: a token `Burn` from the base vault in place
of a transfer to the hook. The pool refuses it as it refuses `hook_swap`: `Paused`,
`NoHook` on a pool without a hook, `HookAuthorityMismatch` for any other signer,
`ZeroAmount`, `Slippage`. It is open to every hook, as `hook_swap` is: the caller receives
nothing, so it can do strictly less with it than with `hook_swap`. The vault accounting
is the same for an SPL coin and a Token-2022 coin (`tests/tests/buy_burn.rs`). The strict
coin of the rules template burns through it (`RULES.md`, "The burn of a strict coin"). The
strict coin keeps its creator lock in the creator's own wallet for the same reason: no
instruction of the hook may move the coin.

**A buy that anyone may trigger can be gamed.** A buyback or a burn is an instruction
anybody may send, with a `min_amount_out` of the sender's choosing. Three ways to take
part of the money that was meant to buy and burn:

1. Buy the coin first, trigger the buy at the price that trade made, and sell into the
   price the buy pushed further.
2. Also deepen the pool with liquidity for that one transaction. Liquidity costs no
   trading fee, makes "a share of the reserve" a much larger amount, and takes most of
   the buy onto the sender's own liquidity at the pumped price.
3. Pump once so that the hook records the pumped pool, sell back in the same
   transaction, and pump again later against a record that says the price did not move.

The two platform templates that buy (`hook_buyback`, `hook_rules`) keep the rules below,
and a hook of your own that buys through `hook_swap` should keep them too. All of it is in
the interface crate: `burn_cap_bps`, `burn_step`, `burn_lowered`, `set_burn_result`.

The rules below hold for a buy through `hook_swap` and through `hook_buy_burn` alike.

* **An observation.** The hook's config keeps the pool's two reserves as they were at
  some earlier moment, and the slot: `obs_reserve_base`, `obs_reserve_quote`, `obs_slot`.
  The buy instruction is the only one that writes the slot.
* **A buy needs an observation at least `BURN_INTERVAL_SLOTS` (25) old.** A call that
  finds none records the pool as it is and buys nothing. A call that comes too soon fails
  and writes nothing, so nobody can postpone a buy by calling. Each buy records the pool
  as it left it, so buys are at least 25 slots apart and cannot be stacked.
* **A buy needs a price that did not run away.** When the price now is above the observed
  price by more than `2 * cap_bps` basis points, the call buys nothing, records the pool
  as it is and returns Ok. Twice the cap is what one buy at the cap moves the price by
  itself. The comparison is `reserve_quote * obs_reserve_base * 10000 > obs_reserve_quote
  * reserve_base * (10000 + 2 * cap_bps)`, in 128 bits, with no division by a reserve. A
  price that fell is fine.
* **The cap is measured on the smaller depth**: `min(reserve_quote, obs_reserve_quote) *
  cap_bps / 10000`, at least one unit. Liquidity added a moment ago does not count.
* **A trade that starts below the observed price lowers the observed price, and never
  raises the observed depth.** In `before_swap`, when `burn_lowered(obs_reserve_base,
  obs_reserve_quote, payload.reserve_base, payload.reserve_quote)` returns a pair, the
  hook writes it over the two reserves of the observation and leaves `obs_slot`. The
  pair is `quote = min(payload.reserve_quote, obs_reserve_quote)` and `base = ceil(quote
  * payload.reserve_base / payload.reserve_quote)`: the price the trade starts at, on the
  observed depth or on the pool's when that is smaller. The base is rounded up so that
  the stored price is never above the price the trade started at. This is what stops the
  third way: the second pump is a buy that starts at the honest price. It must not copy
  the pool's reserves: a wallet could then add liquidity, nudge the price down with one
  small sell, and have a second small sell write the deepened pool into the observation
  with its old slot, all before a buy in the same transaction. It needs the config
  writable in every swap, and a hook that is called on buys and on sells.
* **A cap per buy that follows the pool's fees**, `burn_cap_bps`, in basis points,
  between 1 and 50:

  ```
  sure = protocol_fee_bps + buy_fee_bps + sell_fee_bps
  soft = protocol_fee_bps + 2 * lp_fee_bps
  cap  = clamp((sure + min(sure, soft)) / 4, 1, 50)
  ```

  `buy_fee_bps` and `sell_fee_bps` are the hook fees a buy and a sell always pay and
  nobody gets back, each bounded by the platform's `max_hook_fee_bps`. A hook that pays
  part of its fee out again, to a creator or to stakers, leaves that part out: whoever
  receives it trades at a discount. `sure` is what a position of any size pays in full on
  a buy and a sell: the protocol fee of the buy and the hook fee of both, all taken in
  the quote token. `soft` is what a position much larger than the pool mostly gets back:
  the pool fee of both trades, which stays in the reserves it sells back into, and the
  protocol fee of the sell, which is taken in the coin. A buy of a share `c` of the
  reserve is worth about `2c` of a small position and about `c` of a huge one. With this
  cap it is worth at most about half of what the wallet's own two trades cost, at every
  size.

A buy instruction that returns Ok says what it did: an event with an `outcome` field, and
return data of 17 bytes (`set_burn_result`: the outcome byte, then the quote spent and
the coins burned, u64 little-endian). `BURN_OBSERVED` = 1, `BURN_WAITED` = 2,
`BURN_BOUGHT` = 3. Set the return data after the event: an event CPI clears it.

Checked with the pool's own math over a grid of fee levels, position sizes and shares of
liquidity, each sequence made twice 25 slots apart
(`no_transaction_around_the_burn_pays_at_any_fee_level_size_or_share_of_liquidity` in
`tests/tests/rules.rs`, 62,000 sequences): none pays, and the best one gets back 50% of
what its trades cost. The cap alone is checked in
`the_cap_makes_a_one_run_sandwich_lose_at_every_fee_level_and_every_size`. The same
sequences run on chain against both templates (`tests/tests/rules.rs`,
`tests/tests/buyback.rs`). The exception is a pool where `sure + min(sure, soft)` is
under 4 bps, which needs a protocol fee of zero or one basis point: there the floor of 1
bps applies and a sandwich can break even or better.

What these rules do not stop:

* A pump that really stands. A wallet that pumps, has the hook record the pumped pool,
  and leaves the pump and its liquidity in the pool for the whole interval gets a buy at
  that price if no trade starts below it in the meantime. For those 25 slots the pumped
  price is open to every holder. `RULES.md`, "Known limits", has it measured: 2.06 SOL
  gained with 2,306 SOL committed when nobody traded, a loss when one holder sold a
  thousandth of the pool's coins into it. What can be taken is never more than what the
  hook holds to spend, so buy regularly.
* Liquidity that is there at two buys in a row. A buy records the pool as it leaves it.
  Liquidity that is in the pool at that moment, taken out, and put back for the next buy
  25 slots later makes that next buy a slice of the deeper pool, at an honest price,
  unless a trade started below the recorded price in between. Nothing is taken beyond
  the sell fee on the coins the buy took from that liquidity; the pace is lost.
  `RULES.md`, "Known limits", has it measured. Closing it needs a callback on
  `remove_liquidity`, which these templates do not have on purpose.
* Waiting. A buy happens only while the price is within twice the cap of the lowest price
  a trade started at since the observation. On a coin that is rising, calls return
  `BURN_WAITED` until the price stands still for an interval or falls.
* A wallet that holds the coin while buys run gains with every other holder. That is what
  a buyback is for.

## 8. Platform account

PDA `["platform"]` under the pool program.

```rust
pub struct Platform {
    pub admin: Pubkey,
    pub treasury: Pubkey,            // wallet; fee token accounts are its ATAs
    pub protocol_fee_bps: u16,       // <= 100
    pub max_lp_fee_bps: u16,         // 1000 at launch
    pub max_hook_fee_bps: u16,       // 1000 at launch
    pub max_fee_override_bps: u16,   // 5000 at launch (launch-guard needs high early fees)
    pub launch_fee_lamports: u64,    // paid to treasury by hooklaunch
    pub paused: bool,                // blocks create_pool and swaps, never remove_liquidity
    pub whitelist: Vec<Pubkey>,      // <= 8 upgrade authorities allowed on hooks
    pub pool_count: u64,
    pub curve_virtual_quote: u64,    // the curve launch (section 2): 30 SOL at init
    pub curve_graduation_target: u64,// real quote at which a curve pool graduates: 85 SOL
    pub curve_graduation_fee_bps: u16,// share of the target for the platform: 0, <= 1000
}
```

The three curve settings are written by `init_platform` with the defaults above and
changed with `update_platform`, whose `UpdatePlatformArgs` has `curve_virtual_quote`,
`curve_graduation_target` and `curve_graduation_fee_bps` appended as options (an
encoding that stops before them, as the first clients wrote it, leaves them unchanged).
A virtual quote or a target of 0 switches curve launches off. The fee has a hard
ceiling of 10% (`HARD_MAX_GRADUATION_FEE_BPS`). The virtual quote is at most `u64::MAX /
4`, and when both are on the target is at least a thousandth of the virtual quote
(`CurveSettingsOutOfBounds` otherwise), so that no pool can be created that overflows a
price or can never graduate. Each curve pool copies the three at its creation; a change
never reaches a running curve.

`remove_liquidity` can never be paused by the platform. A hook with `BEFORE_REMOVE_LIQ`
or `AFTER_REMOVE_LIQ` may still refuse removals; that flag is shown before anyone adds.
On a pool on the curve both liquidity instructions fail with `CurveOpen` until it
graduates; `graduate` itself is held by the pause.

Template rules the pool does not enforce but the templates do: a per-pool config must be
paid for by the pool creator (`cfg.creator == payload.creator`, checked in
`on_pool_create`), so a pool never starts on a config that somebody else wrote (what
this check does not stop is in section 4.1); template ceilings equal the platform hook-fee cap; a buyback or a burn
buys against an observation of the pool at least 25 slots old, at most once every 25
slots, and spends a share of the quote reserve that follows the pool's fees, at most
0.5%, so that buying before it and selling after it loses money (section 7), and on a
pool on the curve it measures prices and depths on the effective quote,
`reserve_quote + virtual_quote` (a buy's price impact follows the effective depth, and an
observation taken before graduation still compares right after it, since graduation
keeps the price);
`hook_launch_guard` and `hook_rules` refuse `add_liquidity` while their high buy fee
runs, so that the fee goes to the liquidity the pool was created with; `hook_buyback`
refuses a `min_quote` above 1 SOL, which could keep the buyback from ever running. The launchpad requires
the coin's mint and freeze authority to be gone before it creates the pool.

## 9. Programs in this repo

| Program | Upgradeable | Role |
|---|---|---|
| `hookpool` | yes (ours) | pools, swaps, liquidity, hook dispatch, platform config, the hook's own buys (`hook_swap`, `hook_buy_burn`, section 7) |
| `hooklaunch` | yes (ours) | coin launch: mint + metadata + pool + launch liquidity locked forever + template hook; plain SPL coin or pegged Token-2022 coin |
| `hook_tax` | yes (ours, whitelisted) | template: buy/sell tax in quote to a treasury, ceiling fixed at launch |
| `hook_launch_guard` | yes (ours, whitelisted) | template: high buy fee decaying over the first N slots, goes to the pool; nobody can add liquidity while it runs |
| `hook_buyback` | yes (ours, whitelisted) | template: accrues quote, anyone triggers buyback + burn through `hook_swap`, under the limits of section 7 |
| `hook_rules` | yes (ours, whitelisted) | template: launch rules a launcher switches on and that are fixed at launch: sniper fee, creator fee, rewards for stakers, burn, separate buy and sell rates, buy limit, creator lock; and the strict coin, a Token-2022 coin with this program as its transfer hook (max wallet, early lock, rewards without staking). `RULES.md` is its reference |
| `hook_collectible` | yes (ours, whitelisted) | template: every buy earns Metaplex Core NFTs decided by a later block and pegged to the coin (one per `unit` held, a sell burns); also the transfer hook of pegged coins (a transfer carries the piece or burns it); launcher can update future art, or lock |
| `hook-template/` | frozen by its author | the hook kit: a complete third-party hook, its tests against the real pool, and the scripts that build, deploy and freeze it |
| `examples/hooks/` | frozen by their author | two more third-party hooks built with the kit: a fee override for early buyers, and an account per trader |
| `hook_evil` | never deployed | TEST ONLY: returns every forbidden answer so the tests prove the pool polices hooks |

Out of v1: concentrated liquidity, exact-output swaps, the long/short market hook.

## 10. Reading a pool from a hook

The interface crate exposes `PoolData` with `PoolData::read(account_info)` so a hook can
read reserves, mints and fee from account 0 without depending on the pool program crate.
The last 24 bytes of `PoolData`, reserved until the curve launch, are now (offsets in the
account, after the 8-byte discriminator; every field before them kept its offset):

| Offset | Field | Meaning |
|---|---|---|
| 504 | `virtual_quote: u64` | quote counted in the price while the curve is open, not in the vault; 0 otherwise |
| 512 | `graduation_target: u64` | real quote reserve at which `graduate` is allowed; 0 on a seeded or graduated pool |
| 520 | `graduation_fee_bps: u16` | share of the target taken for the platform at graduation |
| 522 | `curve_state: u8` | `CURVE_NONE` 0 (seeded), `CURVE_OPEN` 1, `CURVE_GRADUATED` 2 |
| 523 | `reserved: [u8; 5]` | zeros |

`PoolData::effective_quote()` returns `reserve_quote + virtual_quote` (checked;
`InterfaceError::QuoteOverflow` when the sum does not fit) and `PoolData::on_curve()` is
`curve_state == CURVE_OPEN`. The price of any pool is `effective_quote() /
reserve_base`; the `SwapPayload` carries the real reserve (section 3.2). The constants
`CURVE_NONE`, `CURVE_OPEN`, `CURVE_GRADUATED`, `DEFAULT_CURVE_VIRTUAL_QUOTE`
(30,000,000,000) and `DEFAULT_CURVE_GRADUATION_TARGET` (85,000,000,000) are in the crate.
A hook compiled against the previous crate reads the same bytes: the tail was zero on
every seeded pool and still is.
The crate also provides `caller_address(hook_program)`,
`verify_caller(hook_caller: &AccountInfo, hook_program: &Pubkey) -> Result<()>` (pass
`&crate::ID`), `burn_cap_bps`, `burn_step`, `burn_lowered`, `set_burn_result` and
`BURN_INTERVAL_SLOTS` (section 7),
`HookReturn::set()`, `HookManifestData`, `require_upgrade_authority`, the payload
structs, the extra-metas helpers and the PDA helpers. The SDK mirrors all of it.

## 11. Events

Swaps, pool creation, liquidity changes, launches and buybacks are emitted with Anchor's
event CPI: the program invokes itself with instruction data
`EVENT_IX_TAG (e445a52e51cb9a1d) | event discriminator | borsh event`. They live in the
transaction's inner instructions and are never cut by the 10 KB log limit (a launch with
a hook and a dev buy produces more logs than that). Platform updates and fee collection
use plain log events. Every instruction that emits through CPI carries two extra accounts
at the end of its fixed list: `event_authority` (PDA `["__event_authority"]` of the
emitting program) and the program itself. The SDK appends them.

`swap`, `hook_swap` and `hook_buy_burn` set `amount_out` as return data after the event,
so a simulated swap quotes exactly. The swap must be the last instruction of the simulated transaction.

The curve launch adds two events, both by event CPI. `create_curve_pool` emits the usual
`PoolCreated` (`quote_amount` 0, `lp_minted` 0: the creator receives no LP) and then
`CurveOpened { pool, virtual_quote: u64, graduation_target: u64, graduation_fee_bps: u16,
slot: u64 }`. `graduate` emits `Graduated { pool, reserve_quote_before: u64,
reserve_quote_after: u64, reserve_base_before: u64, reserve_base_after: u64, burned_base:
u64, fee_quote: u64, slot: u64 }` and sets no return data. The `Swapped` event keeps the
real reserves; a price from it needs `virtual_quote` from the pool account.

## 12. Client conventions

* The two token accounts of a swap need not belong to the signer. The token program
  checks that the signer may spend the account the coins leave, as its owner or as a
  delegate. The account that receives may belong to anyone, so an aggregator or a bot
  signs with one wallet and pays out to another. Never the pool's own vault. On a pegged
  coin the receiving wallet's ticket address goes in the remaining accounts, because the
  coin's own hook looks it up in every transfer. Pieces of a collectible coin are earned
  by the wallet that signs, and kept only for coins that wallet itself holds.
* `hook_quote_treasury` in `swap` is writable. For a pool without a hook fee, clients
  pass the user's own quote token account there; the pool ignores it unless a fee is due,
  and then it must equal `pool.hook_quote_treasury`.
* Compute budgets the SDK asks for: swaps 250k (450k to 600k on a collectible pool), pool
  creation 400k, launch 400k (500k with the collectible template, 600k for a strict coin,
  700k for a pegged coin).
  A pool creation with a hook can pass the default 200k, so always ask. Measured in the
  test suite: the swap instruction alone uses about 41k without a hook and 64k to 67k
  with a fee hook; a launch with a hook callback and a dev buy uses 164k to 249k. A local
  validator counts about 30% fewer units for the same instructions (a swap: 29k without
  a hook, 45k to 53k with a fee hook); `INTEGRATORS.md` has those figures.
* A launch is two transactions. First: Metaplex token plus the hook's per-pool config.
  Second: wrap SOL, create the pool, lock the launch LP in the pool's lock account,
  optional dev buy. The second is about 1,150 bytes with one extra hook account. After
  it the LP supply is `sqrt(base * quote)` raw units, all of it in the lock account
  (`["lp-lock", pool]`), which no instruction can move. A launch on the rules template
  with a creator lock carries one more instruction and is 1,251 bytes without the lookup
  table: it needs the table (977 bytes with it).
* The hook caller in `swap`, `create_pool` and the liquidity instructions is
  `["caller", the pool's hook program]` under the pool program (the system program's id
  for a pool without a hook). Section 3.1 says why it is one address per hook.
* Adding liquidity to a pool whose hook declares `BEFORE_ADD_LIQ` (the launch guard and
  the rules template) passes the hook's extra accounts and is refused while that hook's
  window runs (on a strict coin, also while its max wallet runs). Removing liquidity never
  calls a hook of the templates and is never refused.
* A strict coin (a Token-2022 coin whose transfer hook is `hook_rules`) needs four hook
  accounts in every instruction that moves it, a swap included: the config that every
  rules coin passes, and three of its own: the holder record of the wallet that owns the
  coin account, the holder address of the pool, and the mint's account list. A plain wallet-to-wallet send is a Token-2022 transfer with
  the same accounts resolved the standard way. `RULES.md`, "The strict coin", and
  `INTEGRATORS.md` section 9 list them in order; the SDK adds them by itself.
* Wrapped SOL is the usual quote. A client wraps before a buy and unwraps after a swap by
  closing the wrapped SOL account, but ONLY when its own transaction opened that account.
  A wrapped SOL account that was there before is left open: it may be the treasury of a
  coin's hook fee (the default treasury of a tax coin is its dev's wrapped SOL account).
  The SDK follows this rule in every builder.
* A hook fee whose treasury account is missing waits in the pool
  (`pool.hook_fees_owed_quote`). Anyone can pay it out: create the treasury's associated
  token account for `pool.hook_treasury_owner`, then call `collect_hook_fees`. The SDK's
  `hookFeesInstructions` does both.
* Transactions are v0 and compiled with the platform's address lookup table
  (`web/deployments/<cluster>-alt.json`, created by `scripts/init-platform.mjs`). Fixed
  addresses then cost one byte instead of 32. A launch with the collectible template and a
  dev buy is 1,094 bytes with the table and does not fit without it.
* A pegged coin launches in the same two transactions. The first carries four
  instructions for the coin (`create_pegged_mint`, the Token-2022 metadata `Initialize`
  and `UpdateAuthority` to none, `finish_pegged_token`), then the hook's config and
  `init_peg`: 974 bytes in the rehearsal. The token program writes metadata only when
  called at the top level, which is why the launchpad does not do it by CPI.
* Swaps and liquidity on a pegged coin pass three more accounts after the hook's own:
  the pool's own ticket address, the burn queue and the coin's account list.
  `hookRef` in the SDK returns them.
* Pools are addressed by `["pool", base, quote]`. The same two mints in the other order
  make a different pool with reversed buy/sell semantics; the website always treats the
  launched coin as base and wSOL as quote.

## 13. The collectible template: no buyer signature, rarity nobody can predict, pieces pegged to the coin

The pool passes the trader to every callback as a read-only, non-signing account. A hook
therefore cannot spend from the trader's wallet, cannot create accounts on the trader's
behalf, and cannot be turned into a drainer. Anything a hook wants the trader to pay for
has to be a separate instruction the trader signs at the top level.

`hook_collectible` shows the pattern, and adds unpredictable outcomes on top:

1. `open_ticket`: once per wallet and pool, the buyer creates a ticket account. Opening a
   ticket that is already open does nothing.
2. `swap`: the pool calls `after_swap`. The hook writes into the ticket how many pieces
   the buy earned (`floor(amount_out / unit)`, at most `max_per_buy`, never beyond
   `max_supply`), the roll numbers of those pieces, and a target slot `S + 2`. It writes
   NO seed. Nothing about the pieces' look exists yet.
3. `reveal` (permissionless, any wallet, any ticket) or `mint` (the buyer), once the
   chain is past the target slot: the seed becomes
   `sha256(hash of the first block at or after the target, pool, wallet, target, first roll)`
   read from the SlotHashes sysvar. `mint` then creates the Metaplex Core assets and the
   buyer pays their rent, out of its deposit first. A buyer that paid a deposit in its buy
   signs nothing more: anyone's `mint_for` mints the pieces into the buyer's wallet and is
   paid back from that deposit ("One approval" below).

Why this cannot be gamed by a buyer:

* **No prediction.** The block hash does not exist when the buy is signed, so a simulation
  of the buy shows no seed.
* **No grinding at mint time.** A piece's seed is `sha256(batch seed, roll)`. The roll was
  fixed at buy time. The mint slot, the order of mints and the global counter do not enter
  it; the "#N" in the name is cosmetic.
* **No sitting on a bad result.** Anyone can reveal anyone's ticket and the watcher does it
  every 20 seconds for all of them, so the outcome is fixed whether the holder likes it or
  not. A piece its holder then does not back with coins is dropped by the next settle,
  which frees its place in the supply.
* **No change of the odds after the buy.** A batch stores the collection's art bytes as
  they were when it was bought, and `mint` draws its pieces with those. The collection's
  owner can change the art for later buys only.
* **No waiting it out.** SlotHashes keeps 512 slots (about 3.5 minutes). A batch not
  revealed in that window expires: its seed is a fixed fallback and its pieces are forced
  to the common tier. The program never falls back to a later block, which would be a
  free re-roll.
* **No re-roll by buying again.** `after_swap` first locks in every batch whose block has
  passed, then adds new pieces only to a batch whose block has not been produced yet, or
  to a fresh batch. A ticket holds four batches; when all are occupied a buy earns nothing
  until the holder mints.

What remains. The validator that produces the target block could bias its hash by
choosing what to include, or skip its own slot to move the roll to the next block. A
leader produces four slots in a row, so the validator that includes a buy often produces
the deciding block too. That is one validator biasing its own buys, at the cost of a
block. A buyer also still chooses how many rolls to pay for, and a roll costs the fees of
a round trip, not a holding: the pieces of a buy are recorded for the wallet that signs
even when the coins are sold again in the same transaction, the wallet sees the result
two slots later, and it can then buy the coins that back the pieces, or not. Nothing is
ever minted for coins a wallet does not hold.

A buy without a ticket earns nothing and never fails because of the hook. The pool never
calls the hook on a sell (`CALL_ON_BUY` only). On a pegged coin the token program does
call it inside the sell's transfer; see "The pegged coin" below for why that call cannot
refuse one.

### One approval: the deposit

A buy cannot mint its own pieces, because a block two slots later decides how they look.
So a wallet that wants its NFTs without a second approval pays their rent in the buy, as a
deposit, and anyone mints them into the wallet afterwards. The hook still gets no right
over the wallet: the wallet pays the deposit itself, with an instruction it signs.

* **The deposit is what a ticket holds above its rent.** Every lamport a ticket holds above
  the rent-exempt minimum of its size belongs to its wallet. The SDK pays it in with a plain
  SOL transfer from the wallet to its own ticket, after the swap, in the buy transaction
  (`depositTransfer`, or `swapInstructions` with `mintDeposit`). There is no deposit
  instruction and no new field. A ticket made before this existed holds a deposit of 0 and
  works as before.
* **`mint_for`: anyone mints, into the wallet.** It takes the accounts of `mint`, with a
  payer that signs in front and the wallet as a plain account. It reveals what can be
  revealed, drops the waiting pieces the wallet's coins no longer back, and mints every
  decided piece, up to four, into the WALLET. The pieces are exactly the ones `mint` would
  make: the seed comes from the batch and the roll. The payer, the slot and the order of
  mints do not enter it.
* **The payer is paid back exactly.** It pays the Metaplex rent and Metaplex Core's own
  create fee (0.0015 SOL an asset today, kept in the asset). The program then pays it back,
  out of the deposit, what its own balance went down by in the call, plus `KEEPER_FEE`
  (10,000 lamports a call: one signature and a little for a priority fee). The ticket's
  growth, 32 bytes a piece, stays in the ticket, paid by the deposit. A deposit that does
  not cover all of it is refused with `DepositTooSmall`: checked against the rent before the
  first asset, and against what the payer really spent after. The transaction then fails
  and nothing exists.
* **One fee per four pieces.** `mint_for` mints every decided piece up to four and refuses
  fewer asset addresses (`TooFewAssets`), so the pieces of one buy cannot be split into
  more fees. With nothing decided it is refused (`NothingToMint`).
* **The wallet's own mint takes from the deposit first.** `mint` grows the ticket to hold
  exactly the pieces it minted, out of the deposit first, and pays the wallet back what
  the assets cost, as far as the deposit goes. A wallet that deposited and then mints
  itself pays only its signature.
* **`withdraw_deposit`.** The wallet alone, signing, takes its whole deposit back to itself,
  after shrinking its ticket to its list.
* **No other instruction moves a deposit.** `settle`, `reap`, `reorder`, `stage`,
  `deliver`, `reveal` and opening a ticket leave a ticket's lamports alone. `send_pieces`
  and the pegged coin's transfer hook pay a receiver's growth in full from the sender (the
  transfer hook from the rent the sender's ticket frees), so neither wallet's deposit pays
  for the other. Lamports sent to a ticket's address before it opens first pay the
  ticket's rent when it opens; what is left above the rent is that wallet's deposit.
* **A ticket gives back the rent of pieces it no longer holds.** Each piece in a wallet's
  list takes 32 bytes of its ticket, 162,560 lamports of rent on mainnet. When pieces leave
  the list, the ticket shrinks to exactly its list and keeps its lamports, so the rent of
  those bytes becomes the wallet's deposit: in `settle` (whoever sends it), in the sender's
  `send_pieces`, and in a pegged coin's transfer (which first pays with it the place the
  pieces take at the receiver or in the burn queue). `withdraw_deposit` shrinks the ticket
  first too, so a ticket an earlier version of the program left longer than its list gives
  that rent back at its next withdraw. The wallet's next mint pays the 32 bytes again out
  of the deposit. Rent a ticket frees is a deposit like any other: `settle` is
  permissionless, so anyone may shrink a wallet's ticket, and any keeper may then
  `mint_for` the wallet's own decided pieces from it (one KEEPER_FEE per call, the pieces
  always to the wallet). A wallet that does not want that withdraws the deposit.
* **What a buy deposits.** `mintDepositFor(rent, cfg, pieces)` in the SDK sizes each asset at
  the largest it can be when it is minted, whenever that is: its number at ten digits (the
  most a u32 has, so pieces other wallets mint first never make it longer), and while the
  collection is not locked, the 24-byte name and 80-byte address its owner may still change
  it to (a locked collection at its real ones). Then Core's fee, the ticket's 32 bytes and
  one keeper fee a piece. A buy adds what all of the wallet's waiting pieces need, less the
  deposit it already has (`mintDepositTopUp`). What is left after the mint stays for the
  next buy or the withdraw. It comes to about 0.0036 SOL a piece on mainnet while the
  collection is not locked (3,638,520 lamports); the exact amount is read from the chain's
  rent (`rentFrom`, or the client's `rent()`), never taken from a constant. Mainnet charges
  5,080 lamports a byte of account and a local validator 6,960, so a rehearsal on the local
  chain shows about 0.0044 SOL for the same piece. `depositOf` and `ticketDeposit` read a
  deposit at the same rent; `STANDARD_RENT` in the SDK is the local chain's number only.
  `depositOf` reads it at the ticket's current length, which is what a mint can use;
  `withdrawableDeposit` and `ticketDeposit` read it at the length of the list, which is what
  `withdraw_deposit` pays.
* **A buy never mints.** A `mint` of earlier pieces inside a buy would name the wallet's
  next asset address as it was read; anyone's `mint_for` landing first moves it, and the
  whole buy would fail with `WrongAsset`. The SDK, the site and the trade API put no `mint`
  into a buy: earlier pieces are minted by a keeper or by the wallet on its own.
* **A sell right after a buy.** A sell drops the waiting pieces its coins no longer back.
  When a keeper mints them before the sell lands, they are minted pieces by then and the
  sell burns them instead. The SDK's sells name the wallet's next asset addresses
  (`nextAssets`, from `ticket.minted`) in their `settle` (a pegged coin: their `reap`), so
  the seller burns those NFTs itself and their rent comes back to it. Metaplex Core's fee
  does not come back.
* **A keeper is never out of pocket.** What it spends comes back in the same instruction,
  and every refusal shows in a simulation, so a keeper that simulates first pays nothing for
  a wallet that sold, withdrew or deposited too little. One race remains: a wallet that
  withdraws between the keeper's simulation and its transaction makes that transaction
  fail. That costs the keeper one signature and the wallet at least as much.

`mint_for` accounts: payer (signer, writable), the wallet, config (writable), the wallet's
ticket (writable), the wallet's associated token account for the coin, the collection
(writable), the collection authority, Metaplex Core, the system program, SlotHashes, then
the wallet's next asset addresses `["asset", pool, wallet, index]` from index
`ticket.minted`, writable. `withdraw_deposit` accounts: the wallet (signer, writable), its
ticket (writable). Events: `DepositUsed { pool, user, by, pieces, paid, left }` whenever a
mint takes from a deposit, `DepositWithdrawn { pool, user, lamports }`.

### The peg

Pieces are pegged to the coin. The rule is the one of Unipeg (uPEG) on Ethereum, read from
its verified contract: a wallet never holds more pieces than whole units of the coin.

* **Invariant.** For every wallet: minted pieces + waiting pieces <=
  `floor(balance of its associated token account / unit)`. Coins kept in any other token
  account back nothing.
* **A buy mints.** One piece per `unit` coins bought, as above.
* **Coins leaving burn.** `settle(wallet)` removes what the wallet's coins no longer back,
  newest first: waiting pieces are dropped (newest batch, last roll first), then minted
  pieces are burned from the END of the wallet's list. The caller names the pieces that
  may go, in any order; the program burns the last piece of the list while it finds it
  among them and the wallet is above the peg, and stops otherwise. Nothing else is ever
  burned, so a backed piece cannot be burned by anyone.
* **What counts as held.** The wallet's associated token account, and only while it
  belongs to the coin's token program, holds this coin and is still owned by the wallet.
  An account handed to another owner, or one that does not exist, backs nothing.
* **`settle` is permissionless.** The SDK puts it in the same transaction as every sell.
  For coins that leave another way (a plain wallet transfer, another client) the watcher
  settles the wallet within seconds, and so can anyone else: whoever sends `settle`
  receives the rent of the pieces' assets it burns, so the crank pays for itself (the rent
  of their entries in the ticket stays the wallet's deposit, as above). The hook is not
  involved, which keeps the promise that it never sees a sell.
* **The wallet orders its list.** `reorder(from, to)`. New pieces join the end. A holder
  who wants to keep a piece through a sell moves it to the front first. Only a wallet
  whose coins back all its pieces may reorder, so a wallet above the peg cannot shuffle
  its list to dodge a settle.
* **At most 200 pieces per wallet and pool**, minted and waiting together. A full wallet
  earns nothing on a buy and cannot be sent more. The list is read into the program's
  heap on every call; the ceiling keeps six burns or four mints per call far from it.
* **A piece moves only with its coins.** `send_pieces` transfers `unit` coins per piece to
  the receiving wallet and moves up to four pieces, opening the receiver's ticket if it
  has none. This is uPEG's `transferUpeg`. Like `reorder`, it is refused while the wallet is above
  the peg: what such a wallet loses is decided by its list as it stands.
* **Frozen in Metaplex Core.** The collection is created with three permanent plugins held
  by the program's authority PDA: freeze (holders cannot move or burn a piece themselves,
  so no marketplace sale can separate a piece from its coins), transfer and burn (only the
  program can, and only as above).
* **`mint` and `mint_for` drop unbacked waiting pieces first**, so nothing unbacked is
  ever minted.
* **Nobody can block an address.** Lamports sent to the address of a wallet's next piece
  or of a pool's future collection would make its creation fail. The program hands them
  to the minter or the creator first.
* **Supply is what exists now.** `max_supply` bounds `live + reserved_pending`. A burned
  piece frees its slot; `minted` only numbers the pieces. A burned asset keeps its address
  with a single zero byte, so it can never be minted again.

There are two kinds of coin. On a **plain coin** (an SPL token with no code of its own)
the rule above is kept by `settle`: a plain wallet transfer does not carry the piece, the
sender's piece becomes unbacked and the next `settle` burns it. To move a piece, use
`send_pieces`. On a **pegged coin** the rule lives in the coin itself, as on uPEG: the
next part.

### The pegged coin

Chosen at launch. A pegged coin is a Token-2022 mint whose transfer hook is
`hook_collectible`, so the token program calls the hook inside every transfer of the
coin, after the balances moved. This is uPEG's `_afterTokenTransfer`.

* **A transfer carries the piece or burns it.** The pieces the sender's coins no longer
  back leave the sender in that same transfer, from the END of its list. Waiting pieces
  are dropped. Minted pieces MOVE to the receiver's list when the receiver has a ticket
  for this pool and received the coins in its associated token account: one piece per
  whole unit the transfer SENDS (`floor(amount / unit)`), within what the receiver's
  coins back and the cap of 200. The rest BURN.
* **Nobody fills another wallet's list.** Coins a wallet held before a transfer stay free
  for its own pieces. A piece reaches a wallet only together with a whole unit of coins
  sent in that same transfer, so a dust transfer carries nothing, also when the dust
  completes a unit in the receiver's balance, and the receiver's own waiting pieces keep
  their backing.
* **A buy moves nothing.** Coins leaving the pool are a buy or liquidity coming back.
  The buy still earns pieces through `after_swap`, as on a plain coin.
* **A sell burns in the swap.** Coins reaching the pool burn the pieces they backed. No
  `settle` is involved.
* **Only the associated token account counts**, on both sides. A transfer out of any
  other account of the sender touches nothing. Coins that arrive in any other account of
  the receiver carry no piece: the sender's unbacked pieces burn.
* **The lists are the truth; the Metaplex assets follow.** `execute` makes no CPI. It
  moves 32-byte entries between the two tickets, or into the pool's burn queue
  (`["queue", pool]`), together with the rent of those bytes. Two permissionless
  instructions then bring Metaplex Core in line: `deliver(ticket, assets)` hands a moved
  piece's asset to the wallet whose list holds it, and `reap(assets)` burns the asset of
  a queued piece and pays its rent to whoever sends it. The SDK appends them to the
  transactions it builds (a sell carries its `reap`, a send carries its `deliver`). For
  transfers made anywhere else the watcher sends them within seconds, and so can anyone.
  Until then a wallet app may show a piece with its previous holder; no instruction
  lets that holder use it.
* **A wallet needs a ticket to receive.** Every wallet that bought on the pool has one.
  `open_ticket_for(pool, wallet)` opens one for any wallet, paid by the sender; the SDK
  adds it to a send when the receiver has none. A plain send from a wallet app to a
  wallet without a ticket burns the piece.
* **Sending one chosen piece.** `stage(count)` marks the last `count` pieces of the
  holder's list to travel with its next transfer in the same slot even though its coins
  would still back them (uPEG's `transferUpeg`). One staged piece travels per whole unit
  sent. The SDK builds one transaction: reorder the chosen pieces to the end, `stage`,
  transfer `unit` coins per piece, `deliver`. `stage` names its pieces (remaining
  accounts, in list order) and fails when the end of the list is not exactly them, so a
  piece that reached the list in the meantime never travels in place of the chosen one.
  A stage is spent by the wallet's first transfer of any kind (a sell, or a transfer out
  of another of its token accounts, included), is cleared whenever the list under it
  changes (a piece arrives, a mint, a reorder), never applies to a transfer into the
  pool, and never burns a piece: a staged piece that finds no room stays where its coins
  are, and the sender's waiting pieces keep the backing of the coins that stay.
  `send_pieces` is refused on a pegged coin.
* **Only the token program can run it.** `execute` requires both token accounts to
  belong to Token-2022, to hold this coin, and to carry the `transferring` flag, which
  the token program sets only for the length of a transfer. A direct call fails. An
  account of a multisig's length (355 bytes, free-form) is never read as a token account
  or a mint, as in the token program itself.
* **The burn queue has a ceiling** of 4,096 entries (`MAX_QUEUE`). A transfer that would
  go past it leaves its unbacked pieces on the sender's list, above the peg, and anyone's
  `settle` burns them. The transfer itself goes through. Reaping pays the reaper, so the
  queue empties by itself.
* **It answers `Ok` to every real transfer.** A missing ticket, a full receiver, an
  account that is not the associated one: the transfer goes through and the rule above
  decides what the pieces do. It never refuses a sell.
* **Bound once, by its creator.** `init_peg` needs the mint's own signature and the
  config's creator, checks that the pool address is the one of this mint, and that the
  mint's transfer hook is this program with no authority left to change it. It writes
  the account list Token-2022 reads (`["extra-account-metas", mint]`: the config, the
  sender's ticket, the receiver's ticket, the burn queue) and creates the queue.
* **One pool.** The pool program accepts a mint with a transfer hook only as the base
  coin of a pool whose hook is that same program, run by the platform (section 2). The
  hook accepts a pegged mint only in the pool it was bound to. A pegged coin therefore
  trades in exactly one pool and cannot be listed in a second one.
* **`settle` stays as a backstop.** Burning coins with the token program's `Burn` is not
  a transfer, so the hook does not run. `settle` and the watcher's settle crank cover it,
  as on a plain coin.
* **Name and symbol live in the mint** (Token-2022 metadata, update authority none).
  Metaplex Token Metadata refuses mints with a transfer hook.

What a launcher gives up by choosing a pegged coin:

* The collectible program runs inside every transfer of the coin, sells included. On a
  plain coin no hook code runs on a sell. The program is ours and upgradeable, like every
  platform program.
* Fewer wallets, exchanges and other protocols handle Token-2022 coins with a transfer
  hook. A client has to pass the hook's accounts; the standard token library does it,
  and our SDK does it for swaps and liquidity.
* The receiver's ticket is found from the owner written in the destination token
  account. The standard token library reads that account when it builds the transfer and
  refuses when it does not exist yet (`TokenTransferHookAccountDataNotFound`, checked on
  localnet 2026-10-04). A wallet app therefore may fail to send the coin to a wallet that
  never held it. The SDK creates the token account and the ticket first.
* A plain send to a wallet that never held the coin on Programmable burns the piece.
* Every transfer of the coin writes the same config account, so transfers of one coin
  do not run in parallel.

Measured on LiteSVM with the real Token-2022 and Metaplex Core binaries: a plain wallet
transfer that moves one piece uses about 40,000 compute units; a sell that burns two
pieces, with its `reap`, about 81,000. Worst cases measured by the review at the default
200,000 budget of a wallet: 200 pieces moving in one plain transfer about 63,000, 200
burning about 55,000, a sell that burns 200 about 105,000.

What the peg does not stop, as on uPEG: buying, looking at what was minted, selling what
is not wanted and buying again. Every round costs the trading fees both ways.

Each piece's metadata URI is `<uri_base>/p/<art>/<seed>`: the 16 art bytes and 16 seed
bytes it was minted under, in hex. The launcher may change the collection name, the
renderer base and the art bytes until they lock the collection, and those changes apply
only to pieces minted afterwards. No instruction changes the look of an existing piece.
`unit`, `max_supply` and `max_per_buy` have no setter.

### Errors of the collectible program

Anchor numbers every program's errors from 6000 (section 4), so read the name in the logs.

| Number | Name | When |
|---|---|---|
| 6000 | `BadName` | name is empty or longer than 24 bytes |
| 6001 | `BadUriBase` | renderer base address is empty or longer than 80 bytes |
| 6002 | `BadUnit` | unit is zero |
| 6003 | `BadSupply` | max supply is zero |
| 6004 | `BadMaxPerBuy` | max per buy is not between 1 and 5 |
| 6005 | `WrongPool` | the config does not belong to this pool |
| 6006 | `WrongCreator` | the config was not created by the pool's creator |
| 6007 | `NotOwner` | only the collection's owner can do this |
| 6008 | `Locked` | the collection is locked |
| 6009 | `WrongTicket` | the ticket does not belong to this wallet and pool |
| 6010 | `WrongAsset` | an asset account is not the wallet's next asset address |
| 6011 | `SlotHashes` | the SlotHashes sysvar could not be read |
| 6012 | `WrongCoins` | not the wallet's associated token account for this coin |
| 6013 | `NotHeld` | the wallet does not hold this piece |
| 6014 | `BadIndex` | no such position in the wallet's list |
| 6015 | `BadCount` | a send of fewer than 1 or more than 4 pieces |
| 6016 | `SameWallet` | a wallet sends pieces to itself |
| 6017 | `ListFull` | the receiving wallet's list is full |
| 6018 | `AboveThePeg` | the wallet holds more pieces than its coins back: settle it first |
| 6019 | `NotATransfer` | `execute` called outside a transfer of this coin |
| 6020 | `BadPegMint` | the coin is not a Token-2022 mint whose transfer hook is this program, with no hook authority |
| 6021 | `AlreadyPegged` | the config is already bound to a coin |
| 6022 | `NotPegged` | a pegged coin in a pool it was not bound to |
| 6023 | `UseTransfer` | `send_pieces` on a pegged coin: its pieces travel in a plain transfer |
| 6024 | `WrongQueue` | the burn queue does not belong to this pool |
| 6025 | `NotPeggedCoin` | `stage` on a plain coin |
| 6026 | `NotStaged` | the end of the wallet's list is not the pieces named |
| 6027 | `WrongHook` | the pool does not run this hook |
| 6028 | `DepositTooSmall` | the deposit does not cover a `mint_for`: the pieces' rent, the ticket's growth and the keeper fee |
| 6029 | `NothingToMint` | `mint_for` with no decided piece |
| 6030 | `TooFewAssets` | `mint_for` given fewer asset addresses than the pieces it must mint |
| 6031 | `NoDeposit` | `withdraw_deposit` on a ticket with no deposit |

### A launcher's own art

By default the site draws each piece from its art and seed bytes (`/art/p/...`). A launcher
can bring a whole collection instead: finished pictures, each with its own name, traits
and weight, or layers (backgrounds, bodies, hats...) with a weight per option. Nothing on
chain changes. The pieces are the same Metaplex Core assets; only their JSON and image come
from the launcher's files.

* **Storage, paid by the launcher.** Before the launch the page uploads one folder to
  permanent storage: `collection.json` and the image files, paid in SOL from the connected
  wallet. The folder is named by the id of its path manifest (43 characters of base64url
  on Arweave, 43 or 44 of base58 on Irys). Files are read at `<gateway>/<id>/<path>`.
* **The coin's settings.** `uri_base` = `<site>/art/u/<folder id>` (79 bytes on
  `https://programmableonsol.com` with an Arweave id, 80 with a 44-character Irys id). The
  program allows 80 bytes, so the site's address, `https://` included, may have at most 30
  characters (29 for Irys ids); `artUriBase` refuses a longer one with a sentence. `art` = the first 16 bytes of
  the SHA-256 of `collection.json` exactly as uploaded. The resolver answers a piece only
  when the folder's `collection.json` hashes to the art bytes in the piece's address, so a
  piece always shows the collection it was minted under. Switching to new art means a new
  folder, a new `uri_base` and new art bytes, for later pieces only.
* **Rarity is a chance.** A piece's seed is decided by a later block, so a picture cannot
  be given to an exact number of pieces. A weight is a relative chance, two pieces can show
  the same picture, and burned pieces free their place, so more pieces than the max supply
  are minted over a coin's life.
* **No royalties.** `seller_fee_basis_points` and `creators` are kept as information only.
  The program enforces no royalty, and the pieces are frozen to their coins anyway.

`collection.json`, version 1 (the SDK's `checkCollection` checks it, `encodeCollection`
gives the exact bytes to upload):

```json
{ "version": 1, "kind": "pictures", "name": "Cards", "symbol": "CRD", "description": "...",
  "external_url": "https://...", "cover": "cover.png",
  "attributes": [{ "trait_type": "Power", "value": 7, "display_type": "number" }],
  "items": [{ "image": "images/0.png", "name": "Red card", "description": "...",
              "attributes": [{ "trait_type": "Colour", "value": "Red" }], "weight": 1 }] }

{ "version": 1, "kind": "layers", "name": "Mix", "symbol": "MIX", "description": "",
  "cover": "cover.png", "width": 1000, "height": 1000,
  "layers": [{ "name": "Background", "options": [{ "value": "Night", "weight": 1, "image": "layers/Background/Night.png" }] },
             { "name": "Hat", "options": [{ "value": "None", "weight": 2, "none": true },
                                          { "value": "Cap", "weight": 1, "image": "layers/Hat/Cap.png" }] }] }
```

* `attributes` at the top are common to every piece (stats or skills that do not depend on
  the draw), for both kinds. `layers` are in draw order: the first is drawn first, at the
  bottom. A layer's name is the trait type; an option with `"none": true` leaves the layer
  out of the piece (it has no image, its value is still listed). Every layer is a PNG of
  exactly `width` by `height` pixels.
* Paths: parts of letters, digits, dot, dash and underscore joined by `/`, no part starting
  with a dot, at most 120 bytes, never `collection.json`. Images are png, jpg, gif or webp;
  layers png only. `safeArtPath` makes any file name into one.
* Limits (`ART_LIMITS` in `sdk/src/artpack.ts`): 10,000 pictures; 16 layers, 100 options a
  layer, 600 in all; 32 attributes a piece; names 64 bytes, symbol 10, descriptions 2,000,
  trait types and values 64; weights whole numbers 0 to 1,000,000, a list's sum at most
  2^32 - 1; a picture or the cover 20 MB, a layer PNG 4 MB, layers at most 2048 pixels a
  side and 4,194,304 pixels; `collection.json` 4 MB; 10,001 files and 1 GB a folder.

**The draw** (`pickPiece(collection, seedHex)` in the SDK; the browser preview, the
resolver and anyone else run the same code). For draw number `i`:

    roll(i) = first 6 bytes, big-endian, of sha256("programmable-art-v1:" || seed || i)

with the seed's 16 bytes and `i` as one byte. Pictures use `roll(0)` over `items`; layers
use `roll(i)` for layer `i`, one independent roll per layer. In each list: `pick = roll mod
(sum of the weights)`, then walk the list in order; the first entry whose running sum of
weights is above `pick` is drawn. A weight of 0 is never drawn. Test vector: seed
`00112233445566778899aabbccddeeff` gives rolls 31474065579687, 157154941731317 and
247093959500929; with layers Background (Night 1, Day 3), Hat (None 1, Cap 1) and Eyes
(Round 1, Round 1, Slit 2) it draws options 1, 1 and 1 (Day, Cap, the second Round).
`traitOdds` gives the chance of every trait value and `pickPiece(...).chance` the chance of
the exact piece. The chances are not written into the piece's JSON (wallets may not expect
extra fields); pages compute them.

**The resolver** (`web/api/_art.js`, served by `web/serve.js`):

| Route | Answer |
|---|---|
| `GET /art/u/<id>/p/<art>/<seed>` | the piece's Metaplex JSON: `name` (the item's, or the collection's for layers), `symbol`, `description`, `image`, `attributes` (the item's, or one per layer, then the common ones), `properties.category` "image", `properties.files` |
| `GET /art/u/<id>/p/<art>/<seed>.png` | layers: the piece drawn, all layers in order, cached on disk (pieces that drew the same options share one file); pictures: a redirect to the picture |
| `GET /art/u/<id>/c/<pool>` | the collection's JSON: name (read from the chain), description, `image` = the cover, `external_url` = the coin page |
| `GET /art/u/<id>/collection.json` | the folder's `collection.json` as stored, its hash in the `x-art` header; `?art=<hex>` answers 409 when it does not match |
| `GET /art/settings` | where the launch page uploads and reads: store, network, node, gateways, the `uri_base` prefix |

A picture's `image` is the file on the first gateway of the site's list; a layers piece's
`image` is the `.png` route. `collection.json` is fetched with a time limit and a size cap,
checked, and kept in memory and on disk; the layer files and the drawings are kept on disk
under a size cap, the least recently used going first. A failure answers JSON with a plain
sentence and a code, never a crash: 409 `ART_MISMATCH`, 404 `NOT_FOUND` (the gateway does
not have the folder or file), 502 `GATEWAY` (no gateway answered; remembered 20 seconds),
422 `BAD_COLLECTION` (an invalid `collection.json` or a layer that is not a PNG of the right
size), 422 `TOO_LARGE`, 503 `BUSY` (more than 16 drawings waiting).

**The operator's hide switch.** A text file lists hidden folder ids, one a line
(`ART_HIDDEN_FILE`). `node scripts/art-hide.mjs add <folder id or a piece's address> [note]`,
`remove <id>` and `list` edit it, and the site reads it again within seconds. A hidden
folder's pieces answer a plain grey image and the description "Hidden by the site
operator."; its `collection.json` answers 410. The files stay on permanent storage
(nobody can delete them there); the chain is not touched.

**The upload** (`web/js/art-store.js`, loaded by the launch page only when it is needed).
`openStore({ wallet, settings, session })` returns `price(bytes, files)` (lamports, the
folder's own list included), `balance()`, `fund(lamports, pay)` and `uploadFolder(files,
{ onProgress, already })`. The page pays only the shortfall, `price - balance`, with its own
SOL transfer, so a retry never pays twice; a failed upload throws with the receipts of the
files that landed, and passing them back sends only the rest.

* **Arweave through ArDrive Turbo** (`ART_STORE=turbo`, `web/js/art-store-turbo.js`,
  @ardrive/turbo-sdk 2.1.2). The store makes a throwaway upload key in the browser; the
  wallet's one SOL transfer carries a Memo `turboCreditDestinationAddress=<that key>`, so
  Turbo credits the key, and the key signs every file. The wallet signs nothing else. The
  page keeps the key (`store.session`) until the coin is launched; Turbo cannot send credit
  back, so the key only ever holds the price of the upload.
* **Irys** (`ART_STORE=irys`, `web/js/art-store-irys.js`, @irys/web-upload 0.0.15 with
  @irys/web-upload-solana 0.1.8). Since October 2026 `uploader.irys.xyz` keeps files on
  Irys's own chain, not on Arweave, read at `gateway.irys.xyz`. The wallet's balance at
  Irys pays; the folder goes as one bundle the wallet signs with one message. A failed
  upload sends the whole folder again (the balance is kept).
* **The local stand-in** (`ART_STORE=local`, `web/review/art-standin.mjs`) for tests on the
  local chain: the same flow, and it also speaks Turbo's and Irys's protocols so the real
  stores run against it. No public network is touched.
