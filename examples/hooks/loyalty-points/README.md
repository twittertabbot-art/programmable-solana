# loyalty_points: a hook that keeps an account per trader

An example third-party hook for Programmable, written from `hook-template/`.

It takes no fee and changes no price. AFTER every buy it adds points to the buyer's own
account and to a per-pool total: one point per `quote_per_point` units of the quote
token the buyer sent. The buyer opens the account once with `open_points`, an ordinary
instruction the buyer signs (a hook never gets the trader's signature, so it cannot
create anything for the trader). A buy by a wallet that never opened one goes through
and earns nothing. The pool never calls this hook on a sell.

| | |
|---|---|
| Flags | `AFTER_SWAP \| ON_POOL_CREATE \| CALL_ON_BUY` (the number 4162) |
| Extra account 5 | the pool's `Config`, at `["cfg", pool]` under the hook, writable |
| Extra account 6 | the trader's `Points`, at `["points", pool, trader]` under the hook, writable |
| Its own instructions | `init_manifest(name, uri)`, `init_pool_config(pool, quote_per_point)`, `open_points()` |
| What can change after the freeze | each pool's counters and each buyer's points, with every buy. Nothing else |
| Treasury | none |

The points are a number in an account. They are not a token and nothing in this hook
spends them; what they are worth is up to whoever reads them.

## What it shows that the template does not

* an `after_swap` callback, whose return data the pool ignores,
* a second extra account whose address depends on the TRADER: `per_user_meta(POINTS_SEED,
  true)` from the interface crate. The pool and the SDK derive it for whoever signs the
  swap,
* an extra account that may not exist: it is declared `UncheckedAccount` and checked by
  hand, so a missing account never blocks a buy,
* `extra_metas_size(2)`: the size of the list account follows the number of entries,
* an instruction of the hook that traders call themselves, alone or in front of a buy in
  the same transaction.

## Build, test, deploy frozen

From the root of the repository, with a local chain running (see
`hook-template/README.md`, "Run Programmable locally"):

```
bash examples/hooks/loyalty-points/scripts/test.sh
WALLET=~/my-wallet.json bash examples/hooks/loyalty-points/scripts/deploy-freeze.sh localnet
```

The scripts are the hook kit's own (`hook-template/scripts/`), run on this folder. The
build output goes to `~/targets/loyalty-points`. The program is 245,080 bytes; deploying
and freezing it cost 1.71 SOL on the local validator.

The five tests in `tests/tests/hook.rs` run the hook against the real pool program in
process:

* a buyer with an account earns points, a buyer without one still trades and earns
  nothing, a sell needs none of the hook's accounts, and opening the account and buying
  fit in one transaction;
* what the pool does with the list: it refuses a swap that leaves an extra account out
  or passes another wallet's points account (`HookExtraAccounts`), the runtime refuses
  one that passes a writable account read-only, and the order in which a client passes
  the accounts, or one account too many, makes no difference;
* a callback called directly is refused and changes nothing;
* points cannot be credited through another hook. A program the pool calls receives the
  pool's signature and may pass it on. The test builds a pool of an attacker's own whose
  hook does that, aimed at this hook's `after_swap` with a made-up buy of a million SOL,
  and then at its `on_pool_create`. Both are refused with `CallerMismatch`: the pool
  signs with one address per hook program, `["caller", hook program id]`, and every
  callback here starts with `verify_caller(&hook_caller, &crate::ID)`, which accepts
  only the address of this program;
* a pool cannot start on a config a stranger created, and nobody can open a points
  account for a pool that does not use this hook.

## Launch a coin on it and prove the effect

```
node examples/hooks/loyalty-points/prove.mjs
```

It takes an optional program id (default: the id the source declares, which the build
keeps equal to your deployed program).

The script launches a coin through the launchpad with a dev buy, then two wallets trade:
one opened a points account, one did not. After every trade it reads the hook's `Config`
and both `Points` accounts from chain. On the local validator, at 0.001 SOL per point:

| Step | Pool total | Buys seen / rewarded | trader | trader2 |
|---|---|---|---|---|
| after the launch (the dev bought 0.1 SOL and has no account) | 0 | 1 / 0 | no account | no account |
| trader opens an account | 0 | 1 / 0 | 0 | no account |
| trader buys for 0.5 SOL | 500 | 2 / 1 | 500 | no account |
| trader buys for 0.25 SOL | 750 | 3 / 2 | 750 | no account |
| trader2 buys for 0.3 SOL without an account | 750 | 4 / 2 | 750 | no account |
| trader sells half of its coins | 750 | 4 / 2 | 750 | no account |
| trader2 sells half of its coins | 750 | 4 / 2 | 750 | no account |
| trader2 opens an account and buys for 0.2 SOL in one transaction | 950 | 5 / 3 | 750 | 200 |

Every buy paid the pool's own 100 bps and no hook fee, and every trade paid out exactly
what its simulation had said. On the local validator (Agave 4.3.0) the swap instruction
used 49,664 compute units for a buy that earned points (the hook's callback 7,259 of
them), 49,242 for a buy without an account (the callback 6,837), and about 28,500 for a
sell. The launch transaction, the one that creates the pool, used 226,161 in one run
and 241,161 in another. The in-process tests count more units than a validator for the
same instructions.

## What a trader sees

* The SDK's `describeFlags` for this hook: "Runs on buys only. It is never called on a
  sell, so it cannot block or tax sells. Cannot take fees or change prices. It can only
  allow or refuse."
* `client.hookRef(pool, trader)` returns the two extra accounts for that trader. Nobody
  has to know how the points address is derived to trade.
* A wallet or a site that does nothing about the hook still trades normally: the buy
  goes through and earns no points. To earn, add the hook's `open_points` instruction
  once (`client.mjs` builds it), before the first buy or in front of it.
* Quotes are exact on both sides: the hook cannot change an amount. The reference
  site's trade API marks them so.
* Points earned by one wallet cannot be claimed by another: the pool derives the points
  address from the wallet that signs the swap, and refuses the swap if the client passes
  a different account.
