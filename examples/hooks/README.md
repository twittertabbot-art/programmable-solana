# Two example hooks

Two third-party hooks for Programmable, written from `hook-template/` and built with its
scripts. Read `hook-template/README.md` first: it explains the contract, the local
chain, the build folder, testing before freezing, and what freezing means. This page
only says what these two add.

| | `hook-template` | `early-bird` | `loyalty-points` |
|---|---|---|---|
| What it does | fixed fee to a treasury | half the pool's fee for early buyers | points for every buy |
| Callback that does the work | `before_swap` | `before_swap` | `after_swap` |
| Answer to the pool | a hook fee | a fee override, or nothing | none (it only watches) |
| Called on sells | yes | no | no |
| Takes money | yes, to the treasury | never | never |
| Per-pool config | read-only in callbacks | written by `on_pool_create` | written on every buy |
| Extra accounts | 1 | 1, writable | 2, writable, one per trader |
| What changes after the freeze | the fee, by the config's owner | nothing after the pool starts | counters and points |

What they show that the template does not:

* **A fee override** (`early-bird`): `HookReturn::fee_override(bps)` replaces the pool's
  own fee for one trade, and returning nothing means "no opinion".
* **Writable per-pool state** (`early-bird`): `per_pool_config_meta(seed, true)`, and a
  callback that writes the config. The creation slot comes from the clock, because the
  pool-creation payload carries none.
* **`after_swap`** (`loyalty-points`): a callback that runs after the transfers, cannot
  change the trade, and must never fail for a reason the trader cannot fix.
* **An account per trader** (`loyalty-points`): `per_user_meta(seed, true)` lists an
  address derived from the pool and the trader. The trader opens the account with an
  ordinary instruction of the hook; until then the callback receives an empty account,
  declares it `UncheckedAccount`, and lets the buy through.
* **A hook with no `CALL_ON_SELL`** (both): the pool never calls it on a sell, so a sell
  needs none of its accounts and cannot be blocked by it.
* **A test for a signature passed on** (`loyalty-points`): a program the pool calls
  receives the pool's signature and may pass it on. The test builds a second hook that
  does, and aims it at this hook's callbacks with a made-up buy. It is refused with
  `CallerMismatch`, because the pool signs with one address per hook program
  (`["caller", hook program id]`) and every callback starts with
  `verify_caller(&hook_caller, &crate::ID)`. All three hooks of the kit check the caller
  this way.

## Layout of an example

```
early-bird/
  programs/early_bird/src/lib.rs   the hook
  hook.json                        the descriptor: name, rules and settings form for sites
  tests/tests/hook.rs              tests against the real pool program, in process
  client.mjs                       the hook's own instructions and account decoders, in JavaScript
  prove.mjs                        launches a coin on the deployed hook and proves the effect
  scripts/build.sh  test.sh  deploy-freeze.sh    run the kit's scripts on this folder
proof-lib.mjs                      shared by the two prove.mjs: wallets, sending, launch
```

Each example has a `hook.json`, the descriptor a site reads to show the hook with its
rules and to offer its settings on a launch form. The format is in
`hook-template/README.md`, "Describe your hook". The two here show what the template's
does not: `early-bird` has a `u64` argument in slots and a share written as a percent of
the pool fee, and takes the launcher once. `loyalty-points` has an amount in SOL with
nine decimals, whose smallest value is written as a string. To have a site read one,
host the file and pass its address as `HOOK_URI` when you deploy. The deploy script
reads the hosted file and adds its pin to the link, so the text a site shows is the
text you deployed with (`hook-template/README.md`, "The pin").

The three scripts in each `scripts/` folder are one line each: they call the script of
the same name in `hook-template/scripts/` with `HOOK_DIR` set to the example. To start a
hook of your own from an example, copy the example's folder next to it (so the relative
paths still hold) and rename the program:
`HOOK_DIR=examples/hooks/<your copy> bash hook-template/scripts/rename.sh <new_name>`.

## Run one, start to end

You need what `hook-template/README.md` lists under "What you need", and a local chain
with Programmable on it ("Run Programmable locally" there). Then, from the root of the
repository, for `early-bird` (the same three commands work for `loyalty-points`):

```
bash examples/hooks/early-bird/scripts/test.sh
WALLET=~/my-wallet.json bash examples/hooks/early-bird/scripts/deploy-freeze.sh localnet
node examples/hooks/early-bird/prove.mjs
```

1. `test.sh` builds the hook and runs its tests in process. Nothing is deployed.
2. `deploy-freeze.sh` deploys the hook, publishes its manifest and freezes it. `WALLET`
   is a keypair file with about 2 SOL on the local chain.
3. `prove.mjs` launches a coin on the frozen hook through the launchpad, trades, and
   checks every number against the chain. It ends with "all N checks passed" and exits
   with 0, or prints which check failed and exits with 1.

The proof scripts need no key of yours. They create their wallets when they run and fund
them by airdrop, which a local validator always grants. Set `WALLET_DIR=<a folder of
yours>` to keep the wallets between runs: a wallet named X is then read from
`<folder>/X.json` and created there the first time. `RPC=<url>` talks to another chain.

Without an argument a proof script takes the program id that the hook's source declares.
The build writes the id of the program keypair there, so after a deploy from your
machine that is your program. Pass a program id as the first argument to prove another
deployment.

## A frozen deploy is forever

Each `deploy-freeze.sh` run on a fresh chain costs the rent of one program, which a frozen
program never gives back: 1.57 SOL for `early-bird` and 1.71 SOL for `loyalty-points` on
the local validator. On a local chain that SOL is free. It is the reason the tests come
first.
