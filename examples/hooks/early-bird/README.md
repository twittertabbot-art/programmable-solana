# early_bird: a hook that changes the pool's fee

An example third-party hook for Programmable, written from `hook-template/`.

For the first `window_slots` slots after a pool is created, a buy pays only
`discount_bps` of the pool's own fee (5000 = half). After the window the hook answers
nothing and the pool charges its normal fee. Sells are never touched: the manifest has
no `CALL_ON_SELL`, so the pool never calls this program on a sell. The hook takes no
fee for itself and has no owner and no setter.

| | |
|---|---|
| Flags | `BEFORE_SWAP \| ON_POOL_CREATE \| OVERRIDE_FEE \| CALL_ON_BUY` (the number 4417) |
| Extra accounts | one: the pool's `Config`, at `["cfg", pool]` under the hook, writable |
| Its own instructions | `init_manifest(name, uri)`, `init_pool_config(pool, window_slots, discount_bps)` |
| What can change after the freeze | `Config.created_slot`, written once by `on_pool_create`. Nothing else |
| Treasury | none. A pool on this hook stores the all-zero key as its hook treasury |

The longest window a launcher can ask for is 216,000 slots, about one day. The discount is
at most the whole fee (`discount_bps` 0 = early buys pay the pool nothing). The pool cuts
any fee override down to the platform's cap, so the hook can never raise a fee above it.

## What it shows that the template does not

* a fee override instead of a hook fee: `HookReturn::fee_override(bps).set()`,
* returning nothing for "no opinion",
* a callback that WRITES its extra account: `per_pool_config_meta(CFG_SEED, true)`, and
  `#[account(mut)]` on the config in the callback's accounts,
* taking the creation slot from the clock, because `PoolCreatePayload` carries no slot,
* a pool with no hook treasury.

## Build, test, deploy frozen

From the root of the repository, with a local chain running (see
`hook-template/README.md`, "Run Programmable locally"):

```
bash examples/hooks/early-bird/scripts/test.sh
WALLET=~/my-wallet.json bash examples/hooks/early-bird/scripts/deploy-freeze.sh localnet
```

The scripts are the hook kit's own (`hook-template/scripts/`), run on this folder. The
build output goes to `~/targets/early-bird`. The program is 225,192 bytes; deploying and
freezing it cost 1.57 SOL on the local validator.

The four tests in `tests/tests/hook.rs` run the hook against the real pool program in
process: early buys pay half the fee and the first slot after the window pays all of it,
a sell needs none of the hook's accounts, the pool refuses the hook while it can be
upgraded, a pool cannot start without its config or on a stranger's, and a callback
called directly is refused.

Every callback starts with `verify_caller(&hook_caller, &crate::ID)`. The pool signs a
call to this hook with an address of its own for this program, `["caller", this
program's id]` under the pool program, and the check accepts that address only. The
signature another hook receives from the pool is worth nothing here.
`hook-template/README.md` says why under "Check the caller".

## Launch a coin on it and prove the effect

```
node examples/hooks/early-bird/prove.mjs
```

It takes an optional program id (default: the id the source declares, which the build
keeps equal to your deployed program) and an optional window in slots (default 150, about
a minute on a local validator, which the script waits out).

The script launches a coin through the launchpad with the SDK (`template: "custom"`, the
hook's `init_pool_config` as the setup instruction; the instruction is built in
`client.mjs`). A second wallet then buys and sells inside the window and again after it.
For each trade the script reads the fee twice, from the pool's own `Swapped` event and
recomputed from the pool's reserves before and after, and looks in the transaction's logs
for whether the hook program ran. On the local validator (Agave 4.3.0), in two runs:

| Trade | Pool fee charged | Hook called | Swap instruction, compute units |
|---|---|---|---|
| buy inside the window | 50 bps | yes | 45,172 and 49,672, of which the hook 8,045 |
| sell inside the window | 100 bps | no | 29,714 |
| buy after the window | 100 bps | yes | 44,854 and 49,354, of which the hook 7,872 |
| sell after the window | 100 bps | no | 29,714 |

The two runs differ by 4,500 units on a buy and by nothing on a sell. On every call to
the hook the pool derives the address of the hook's config for that pool, and a
derivation costs about 1,500 units for every try it needs. The launch transaction, the
one that creates the pool, used 173,011 compute units in one run and 180,511 in the
other. The number is different for every coin. The in-process tests count more units
than a validator for the same instructions.

## What a trader sees

* The SDK's `describeFlags` for this hook: "Runs on buys only. It is never called on a
  sell, so it cannot block or tax sells. Can change the pool fee per trade, up to the
  platform cap."
* `client.hookInfo(pool)` reports a custom hook, frozen, with no upgrade authority.
* `client.hookRef(pool, trader)` finds the config account by itself, as writable.
* `client.quoteOnChain` returns the real output of a buy, discount included. A quote
  computed without asking the chain assumes the pool's normal fee, so inside the window
  it is slightly too low. The reference site's trade API says so: a buy quote is marked
  not exact, a sell quote is exact because the hook is not called.
* A trade never fails because of this hook unless the pool's config is missing, which
  the pool-creation callback rules out.
