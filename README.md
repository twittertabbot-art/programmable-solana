# Programmable

Pools with hooks on Solana. Every pool is a constant-product market that may name a
hook program. The pool calls the hook before and after swaps and liquidity changes, the
hook answers through return data, and the pool enforces hard limits on every answer.
A launchpad on top creates a coin, its pool and its hook in two transactions, and locks
the launch liquidity in the pool forever.

A coin launches in one of two ways. A seeded launch puts real SOL from its creator into
the pool next to the supply. A launch on the curve needs no SOL from the creator: the pool
prices the coin with virtual SOL it does not hold, pays sells from the real SOL buyers put
in, and refuses liquidity until it holds its graduation target. Then anyone's `graduate`
drops the virtual part and burns coins from the pool so that the price stays where it
was. It is the same pool, at the same address, for the coin's whole life.

New here? Read `HANDOFF.md` first.

## Documents

| File | For whom | What |
|---|---|---|
| `HANDOFF.md` | whoever takes this over | what is here, what was verified, how to run and deploy it, what is left |
| `HOOKS.md` | everyone | the specification: the pool, the callbacks, the flags, the caps, the collectible hook |
| `RULES.md` | everyone | the launch rules template (the site calls them modules): the rules a launcher switches on, their bounds, accounts, instructions, known limits; and the strict coin, a second kind of coin on the same template with a max wallet, an early lock and rewards for holders without staking |
| `SECURITY.md` | operators, auditors | what the pool guarantees, what it does not, and the log of every review finding |
| `hook-template/README.md` | hook authors | how to write, test, deploy and freeze a hook of your own, and how to describe it for the Custom hooks pages |
| `examples/hooks/README.md` | hook authors | two more hooks, with tests: a fee that favours early buyers, and points per trader |
| `sdk/README.md` | site and bot developers | the TypeScript SDK: reading, quoting, swapping, launching |
| `INTEGRATORS.md` | bots, aggregators, other DEXes, indexers | addresses, layouts, the quote, the swap instruction, events |
| `API.md` | bots and sites | the HTTP trade API: a quote, and a ready-to-sign transaction |
| `jupiter-adapter/README.md` | routing engineers | the Jupiter `Amm` adapter and its parity suite |
| `LISTINGS.md` | the operator | what Jupiter and the chart sites ask of a new DEX |
| `watcher/README.md` | the operator | the service that keeps collectibles in line, runs the buybacks and burns, and watches every hooked pool |

## What is in the repo

| Path | What |
|---|---|
| `programs/hookpool` | the AMM: platform config, pools, swaps, liquidity, hook dispatch, caps, and pools on the curve: `create_curve_pool` and the permissionless `graduate` |
| `programs/hooklaunch` | the launchpad: the coin (plain SPL with Metaplex metadata, or pegged Token-2022), pool with its launch liquidity locked, launch record, dev buy; `launch` for a seeded launch and `launch_curve` for a launch on the curve |
| `programs/hook_tax` | template hook: buy/sell tax in quote to a treasury, ceiling fixed at creation |
| `programs/hook_launch_guard` | template hook: high buy fee decaying over the first slots, paid to the pool |
| `programs/hook_buyback` | template hook: fees accrue to a PDA, anyone triggers buyback and burn, a slice at a time and never at a price the caller just made |
| `programs/hook_rules` | template hook: launch rules a launcher switches on and that are fixed at launch: sniper fee, creator fee, rewards for holders who stake, burn, separate buy and sell rates, buy limit, creator lock. Also the transfer hook of the strict coin, a Token-2022 coin that adds a max wallet, an early lock and rewards for every registered holder |
| `programs/hook_collectible` | template hook: every buy earns generated Metaplex Core NFTs, decided by a later block and pegged to the coin (one per unit held, a sell burns); also the transfer hook of pegged coins, where a transfer carries the piece or burns it |
| `programs/hook_evil` | TEST ONLY: a hostile hook that proves the pool polices every answer and that no hook can be reached through another. Never deployed. |
| `crates/hookpool-interface` | shared types for hooks and the pool: flags, payloads, return data, PDAs |
| `tests/` | LiteSVM integration tests with the real Token-2022 and Metaplex binaries |
| `sdk/` | TypeScript SDK: decoders, instruction builders, quotes, event parsing, browser bundle; `sdk/examples/quickstart.mjs` is the shortest complete use |
| `web/` | a reference website (static, no framework) in the look of programmable.market: Explore, Launch a token (Module Mode, Collectible, Custom hook), the coin page, liquidity, the hook checker, Custom hooks (hooks built by other people, each with its own page), docs. The site's name and mark are one setting in `web/config.js`, empty by default. Also the server functions under `web/api/` (trade API, art renderer and the resolver of a launcher's own art, metadata upload) |
| `watcher/` | the keeper and monitor: reveals, settles and upkeep for collectibles, the buybacks and burns of buyback, rules and strict coins, the holder records of strict coins that a token burn left too high, simulated trades and alerts for every hooked pool |
| `hook-template/` | the hook kit: a complete third-party hook, its tests against the real pool, the scripts that build, deploy and freeze it, and `hook.json`, the description the Custom hooks pages read |
| `examples/hooks/` | two more third-party hooks built with the kit: `early-bird` (a fee override for early buyers) and `loyalty-points` (an account per trader), each with tests and a proof script |
| `jupiter-adapter/` | Jupiter `Amm` adapter for the pools, with a parity suite. Its own Cargo workspace |
| `idl/` | the Anchor IDL of every program |
| `scripts/` | local chain, platform setup, end-to-end rehearsals, the no-SDK trading example, the check of `INTEGRATORS.md` against a chain, re-keying |
| `deploy.sh` | deploy to localnet, devnet, or mainnet (dry run by default on mainnet) |

## Program ids

| Program | Id |
|---|---|
| hookpool | `7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh` |
| hooklaunch | `9cDfF7wD6EirDZbb5DWCw3HZ3ZPQ1oeh87YyMGvbPRxi` |
| hook_tax | `jwdXDuSQ9pNV1pXj8BFvBb5fhqtTL3duQkwsTjXunhr` |
| hook_launch_guard | `G59xnMnbenifbGR1y6QjaTRa6wa1FFfqZB3KZBUyckPW` |
| hook_buyback | `3M824Hn8Z6S7r1t1zqpNQpioKFd31jrQwSN2oxV2ovo5` |
| hook_collectible | `3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m` |
| hook_rules | `3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr` |

A program id is the public key of a keypair file. To deploy at ids of your own, run
`node scripts/rekey.mjs` once before the first deploy: it makes seven keypairs and replaces
the ids everywhere in this repository. Keys never live in this folder. Every script reads
them from `$SOLHOOKS_SECRETS`, by default `~/sol-secrets`:

```
~/sol-secrets/program-keys/<program>.json    the program id keypairs (only a first deploy needs them)
~/sol-secrets/<cluster>-deployer.json        the wallet that pays and holds the upgrade authority
```

## Toolchain

Linux, macOS, or Windows with WSL. Verified with: Rust 1.99, Anchor 1.2.0 (through
`avm`), Solana CLI (Agave) 4.3.0, Node 22 and 24.

```
bash build.sh build       # all programs as SBPF v0, and the IDLs into idl/
bash build.sh test        # 322 tests: 58 unit tests and 264 LiteSVM integration tests
bash jupiter-adapter/test.sh   # the adapter: 31 unit tests and 22 parity tests
npm install               # once, at the root: the SDK's and the watcher's dependencies
npm run build -w sdk      # sdk/dist (with types), web/js/hookpool.js, web/api/_sdk.js
node web/serve.js         # the reference site and the trade API at http://localhost:8787
```

Rust build output goes to `~/targets/sol-hooks`, outside the repository, through the
`target` link that `build.sh` makes. Set `SOLHOOKS_TARGET_DIR` to put it elsewhere.

The count includes the reviews' own test files in `tests/tests/` (`review_*.rs`). A package
built without them runs fewer.

Five things about the toolchain cost a day each once and are handled by the scripts:

* **Never run `anchor keys sync` in this repository.** The program ids are the ones
  written in the source. Anchor makes throwaway keypairs in the build folder, sees that
  they differ, and suggests that command: it would overwrite the real ids in the programs
  while the SDK, the site and the documents keep the old ones. `build.sh` builds with
  `--ignore-keys` so the suggestion never appears. To change the ids, use
  `scripts/rekey.mjs`. (The hook kit is the opposite case: a hook's id IS the keypair in
  its build folder, and its own build script syncs it.)
* Programs are built as SBPF v0 (`anchor build --arch v0`). Anchor's default is v3, which
  the LiteSVM the tests run on cannot load.
* `anchor build` may re-point the active Solana release at an older one on every build.
  `scripts/localnet.sh` and `deploy.sh` therefore pick the newest installed release
  themselves (override with `SOLHOOKS_SOLANA_BIN`).
* The 3.0.0 test validator ships a Token-2022 that cannot write metadata into a mint. A
  pegged coin cannot be created on it. Use 4.3 or newer.
* The 4.3 test validator turns on SIMD-0500, which refuses deploys of SBPF v0 programs.
  `localnet.sh` starts it with that feature off. On 2026-10-12 the feature was inactive on
  mainnet, devnet and testnet. Before a public deploy, run
  `solana feature status B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g` on that cluster.
  Where it is active, the programs have to be built as SBPF v3, and the tests need a
  LiteSVM that loads v3.

## Local chain, end to end

No key is needed for this: `up` starts a chain that already has the seven programs on it.

```
npm install
bash build.sh build
npm run build -w sdk
bash scripts/localnet.sh up
node scripts/init-platform.mjs localnet
node sdk/examples/quickstart.mjs
node scripts/e2e.mjs localnet tax
node scripts/e2e.mjs localnet launch_guard
node scripts/e2e.mjs localnet buyback
node scripts/e2e.mjs localnet none
node scripts/e2e-rules.mjs localnet
node scripts/e2e-strict.mjs localnet
node scripts/e2e-collectible.mjs localnet
node scripts/e2e-pegged.mjs localnet
node scripts/e2e-curve.mjs localnet
node scripts/e2e-api.mjs localnet
```

| Script | What it rehearses |
|---|---|
| `sdk/examples/quickstart.mjs` | the SDK in one file: launch a coin with a tax, quote, buy, sell, read the trade back, take the tax |
| `e2e.mjs <template>` | creates a coin, launches it on that template against wrapped SOL, checks that the launch liquidity is locked, buys and sells from a second wallet, checks the local quote equals the on-chain one, reads the swaps back from the events. `tax` also closes the treasury and shows that the tax waits and is paid later; `buyback` takes the buyback through its steps: the first call that only records the pool, the call that comes too soon, the buy at its per-run limit |
| `e2e-rules.mjs` | the launch rules template, four coins: every share of the fee against a book kept by hand, staking and its rewards, the burn through all its steps (a pumped price makes it wait), the sniper fee and the buy limit inside and after their windows, a creator lock made in the launch transaction |
| `e2e-strict.mjs` | the strict coin: every bound refused by name, the first buy early and under the cap, buys and sends above the max wallet refused, early coins held until the unlock, the creator's floor, rewards to registered holders against a book kept by hand, the share that goes to the burn below 0.1% registered, a token burn and `sync_holder`, closing a record, the burn through its steps, deposits refused while the max wallet runs |
| `e2e-collectible.mjs` | the collectible hook on a plain coin: a buy that decides nothing, a stranger's reveal, a mint that matches the revealed seed, then the peg: a sell that burns the piece put last, a piece sent with its coins, a settle by a stranger, an art update, the lock |
| `e2e-pegged.mjs` | a pegged coin: a wallet-to-wallet transfer that carries the piece, one that burns it, one chosen piece sent with exactly its coins, a sell that burns in the swap |
| `e2e-curve.mjs` | the curve launch: a plain coin on the curve bought to its target by three wallets, a sell paid from real SOL only, liquidity refused before graduation, graduation by the buy that crosses the target at the kept price, a second `graduate` that changes nothing, liquidity and trades after; a rules coin left on the curve whose burn measures effective prices; a strict coin with a graduation fee the platform collects; a pool made with `create_curve_pool` directly; a seeded coin that cannot graduate; a pegged coin refused. Every trade is compared with the SDK's quote and the chain's simulation, to the unit |
| `e2e-custom.mjs <program id>` | the third-party path: a coin launched on a hook that is not one of the templates. Build and deploy `hook-template/` frozen first (its README) |
| `e2e-approvals.mjs <program id>` | the approved list (HOOKS.md section 6.1) on the same frozen hook: with the rule on, the SDK and the chain refuse it; approved, a coin launches on it and trades; revoked, new pools are refused and the coin keeps trading; the rule off again. Local chain only |
| `e2e-api.mjs` | the HTTP trade API against every kind of pool, rules coins, strict coins and a third-party hook included: quote, swap, sign, send, and the wallet's real balance change against the quote |
| `raw-swap-example.mjs` | trading, graduation and wallet-to-wallet sends without the SDK: `INTEGRATORS.md` as running code |
| `check-integrators-doc.mjs <rpc url>` | reads a chain and checks every layout, offset and formula that `INTEGRATORS.md` states |
| `check-hook-release.mjs <cluster> <program id> [<repo> <commit>]` | read-only: what the operator checks before approving an outside hook (frozen, manifest, accounts list, the verified build of the reviewed commit) |
| `hook-approval.mjs <cluster> status\|rule on\|rule off\|approve <id>\|revoke <id>` | the platform admin's approved list: checked, simulated, sent only after "yes" |
| `watcher/prove-settle.mjs`, `watcher/prove-upkeep.mjs`, `watcher/prove-burn.mjs` | the watcher's keeper jobs, live: it burns the pieces of a wallet whose coins left, makes the NFTs of a pegged coin follow its transfers, and runs the buyback of a buyback coin and the burns of a rules coin and a strict coin, and lowers a strict coin's holder record that a token burn left too high |

`bash scripts/localnet.sh start` starts an empty chain instead, and `bash deploy.sh
localnet` deploys to it with the program keypairs: that rehearses the real deploy.
`bash scripts/localnet.sh stop` stops the validator this script started.

## Devnet and mainnet

```
bash deploy.sh devnet              # asks the devnet faucet for funds
bash deploy.sh mainnet             # dry run: shows sizes, rent, deployer balance, sends nothing
bash deploy.sh mainnet broadcast   # the real thing
TREASURY=<address> HOOK_URI_BASE=<your site>/hooks node scripts/init-platform.mjs mainnet
```

The seven programs are about 3.0 MB together. Their rent is about 21 SOL, and a deploy
needs about the same again for a moment, for the upload buffer. Rent is recoverable
while you hold the upgrade authority. The platform's own programs stay upgradeable by
that authority. Third-party hooks must be frozen: the pool checks it on chain.

## Fees at launch

Set by `init-platform.mjs`, changeable by the platform admin inside hard bounds:

* protocol fee 0.2% of every swap input, to the platform treasury (cap 1%)
* pool fee set per pool, max 10%
* hook fee max 10%, always in the quote token
* fee override max 50% (launch guards)
* launch fee 0.01 SOL
* the curve: 30 virtual SOL, graduation at 85 real SOL, graduation fee 0 (at most 10% of
  the target). `init-platform.mjs` takes `CURVE_VIRTUAL_SOL`, `CURVE_TARGET_SOL` and
  `CURVE_FEE_BPS`; a pool keeps the settings it was created with

## The curve launch, in numbers

With the platform's defaults, a coin of 1,000,000,000 coins with 6 decimals, all of them
in the pool, and no fee:

* it starts at 0.00000003 SOL a coin, a market cap of 30 SOL, with no SOL from its creator;
* when buyers have put in 85 SOL, about 73.9% of the supply is sold and the pool holds
  260,869,565,217,391 raw units;
* graduation at exactly 85 SOL burns 68,052,930,056,711 units, about 6.8% of the supply,
  and leaves 85 SOL and 192,816,635,160,680 units in the pool; a later graduation burns
  less;
* the market cap at graduation is about 441 SOL, at the same price before and after it.

LP fees stay in the real reserve and move these a little. The SDK computes them from the
pool (`curveProgress`); `INTEGRATORS.md` section 14 has the formulas.

## Status

Everything runs on a local validator, end to end. Nothing is deployed to devnet or
mainnet. No outside audit has been done. See `HANDOFF.md`.

If a deploy is interrupted, the Solana CLI prints a 12-word phrase for the half-written
buffer account. Keep it private: it resumes the deploy, or takes back the SOL in the
buffer (`solana program close`).
