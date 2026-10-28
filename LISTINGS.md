# Getting the pools listed: Jupiter, chart sites, trading terminals

A new pool program is only reachable through its own site on the day it launches. This
file says what each outside venue asks for before it adds a new DEX, what is already built
for that in this repository, and what is left for whoever operates the DEX.

Researched on 2026-10-04 from the public pages in "Sources". The venues change their
rules; read the pages again before you apply.

## Who has to add you, and what each one asks for

| Venue | What it unlocks | What they ask for | Self-serve? |
|---|---|---|---|
| Jupiter (Metis router) | Jupiter itself, the swap inside most wallets, and the Telegram bots that route through Jupiter | A Rust adapter for their `Amm` trait, proof that its quotes match the chain, a security audit, traction, a known team | Yes: a support form, then their review |
| Trading terminals and bots with their own integrations (Axiom, Photon, GMGN, BullX, Trojan) | Coins show up in their feeds at launch | No public process found. They add launchpads one by one, by their own choice, once there is volume | No |
| DexScreener | Charts, and the trust of being listed | Liquidity and daily volume, open-sourced and audited programs, an active community. Requested in their Discord | Request, their decision |
| GeckoTerminal | Charts, and the CoinGecko data feed | A data feed you host in their format, then an application form | Request, their decision |
| Explorers (Solscan, Solana Explorer) | Readable transactions | The program IDL published on chain, a verified build | Yes |

## What is ready in this repository

| Need | Where | State |
|---|---|---|
| A swap that pays out to any wallet (routers sign with one wallet and deliver to another) | the pool program | built, tested |
| Jupiter `Amm` adapter with quote parity on Jupiter's own test kit | `jupiter-adapter/` | built; 53 tests (31 unit, 22 parity); fixtures are local-chain pools. It routes pools without a hook and pools on the five platform templates, the launch rules template included, seeded or launched on the curve, before and after graduation, except coins with a transfer hook: pegged and strict coins |
| An HTTP API any bot can use without an adapter | `API.md`, `web/api/` | built, tested |
| A complete on-chain integration guide | `INTEGRATORS.md`, `scripts/raw-swap-example.mjs` | built, tested |
| A proof that the guide matches a deployment | `node scripts/check-integrators-doc.mjs <rpc url>` | built; it reads the cluster and simulates trades, buybacks, burns, stakes, claims and locks, the holder records and wallet-to-wallet sends of strict coins, and `graduate` on pools on the curve, and sends nothing |
| IDLs | `idl/` | built with the programs, seven of them |
| Events that indexers read | the programs | built. Pool creation, swaps, liquidity changes, launches, buybacks, the burns of rules coins, and the opening and the graduation of a pool on the curve are emitted as inner instructions, which a node never cuts. Fee collections, the events of collectible pieces, the stakes, claims and locks of rules coins, and the holder records of strict coins are written to the log |

## What is left for the operator

1. **A security audit.** Jupiter and DexScreener both ask for one. It costs money and
   weeks, and auditors have queues. It is the longest lead time here. The reviews recorded
   in `SECURITY.md` were done by the builders, not by an outside firm.
2. **Open source.** DexScreener asks for open-sourced programs, and Jupiter reviews the
   adapter repository.
3. **Mainnet, and traction.** Liquidity, volume and a community only exist after launch.
4. **IDLs on chain and verified builds**, at deploy (`anchor idl init`, `solana-verify`).
5. **The addresses of your deployment.** The program ids in the documents are the ids of
   this build. If you deploy at ids of your own, `scripts/rekey.mjs` rewrites them in the
   programs, the SDK, the adapter and the documents; rebuild everything it names
   afterwards. It rewrites program ids only. `INTEGRATORS.md` section 3 also prints six
   addresses that follow from the ids, the hook caller of a pool without a hook and of
   each template: after a change of ids the check script fails on that table and prints
   the six addresses to put there. The lookup table is created per deployment by
   `scripts/init-platform.mjs` and written to `web/deployments/<cluster>-alt.json`: give
   its address to integrators together with `INTEGRATORS.md`. Then run
   `scripts/check-integrators-doc.mjs <rpc url> --lookup-table <address>` against the
   cluster and send its output with the documents.
6. **Mainnet fixtures for the adapter.** Put mainnet pool addresses in
   `jupiter-adapter/tests/parity.rs` and run with `RPC` and `REFRESH`
   (`jupiter-adapter/README.md`), then submit through Jupiter's AMM integrators form with
   the audit and the traction numbers. Jupiter adds a swap variant for the program on its
   side, on its own schedule.
7. **The chart data feed.** DexScreener and GeckoTerminal ask a non-standard DEX for a
   small HTTP service: latest block, asset, pair, and events by slot range. It is not
   built. `INTEGRATORS.md` section 10 has every event it needs, and section 14 how to price
   a coin on the curve. Then the two listing requests.
8. **Direct contact with terminals and bots**, once coins trade. Point them at `API.md`:
   two HTTP calls.
9. **A keeper.** A router does not settle the pieces of a collectible coin after a sell,
   nobody is obliged to run the buyback of a buyback coin or the burn of a rules coin,
   and nobody is obliged to collect hook fees that wait for a closed treasury. All three
   are open to anyone and pay the sender nothing. Run `watcher/` so that somebody does
   the first two (`INTEGRATORS.md` sections 9 and 12), and tell the devs of tax coins
   about the third (`INTEGRATORS.md` section 6).

## Jupiter in detail

* Prerequisites, from their developer docs: code health, a security audit, traction, team
  and backers. No liquidity or volume number is given.
* The adapter implements `jupiter-amm-interface` (0.6.1). No network call is allowed in
  it; it quotes from the accounts Jupiter caches.
* The proof they ask for: `jupiter-amm-test-kit` snapshots a pool, runs the adapter's
  quote, executes the real swap in LiteSVM and requires the token amounts to match
  exactly. `jupiter-adapter/tests/parity.rs` is that suite.
* After integration a pool is routed when it passes one of two liquidity tests,
  re-checked every 30 minutes: buying 500 USD and selling it back loses under 30
  percent, or a 1,000 USD buy moves the price under 20 percent more than a 500 USD buy.
  On a constant-product pool the round trip costs only the fees: twice the platform's
  fee (0.2 percent on the test chain) and the pool's fee, plus the hook's fees. A tax,
  buyback or rules template takes at most 10 percent a side, so a pool with a 1 percent
  fee loses at most 22.4 percent on the round trip and passes the first test whatever
  its rates. A launch guard, and the sniper fee of a rules coin, start at up to 50
  percent on buys and fall for at most 10,800 slots (about 72 minutes): a pool can fail
  the test while its window runs. A rules coin may also limit one buy for at most 9,000
  slots (about one hour): while a limit below the size of the test's buy runs, that buy
  cannot be quoted at all.
* "Instant routing" of brand-new pools is reserved for 15 named DEXes. A new DEX is not
  one of them, so a freshly launched coin is on Jupiter after the next check, not in its
  first seconds.
* A coin launched on the curve is a constant-product pool on its effective reserves, so
  the round trip of the first test costs the fees, as on any pool, and a sell of what was
  bought is always paid. The second test measures depth: the curve starts with the
  platform's 30 virtual SOL as its quote side, so a young coin is shallow and may fail it
  until it has raised more.

## Coins launched on the curve: what a venue or a chart shows

A coin can be launched with no SOL from its creator: the pool prices it with a virtual
quote, SOL it does not hold, until it has raised its graduation target of real SOL. Then
anyone's `graduate` drops the virtual part and burns coins from the pool so that the price
stays where it was (`INTEGRATORS.md`, section 14). For a listing venue, a chart or a
terminal:

* **One pool for the coin's whole life.** The pool account and its address do not change at
  graduation. There is no new pair to list and no migration to follow. Keep listing the
  same pool.
* **The price** is `(reserve_quote + virtual_quote) / reserve_base`, pool offsets 376, 504
  and 368, adjusted for the decimals. `reserve_quote` alone is the real SOL; a price made
  from it alone is wrong by the whole virtual part while the coin is on the curve. After
  graduation `virtual_quote` is 0 and the formula is the usual one.
* **The market cap** is the coin's supply (the mint, offset 36) times that price. A coin
  starts at a market cap equal to its virtual quote: 30 SOL with the platform's defaults.
  Graduation burns coins, so the supply falls at that moment and the price does not.
* **A graduated mark.** Pool byte 522 is 0 for a seeded coin, 1 on the curve and 2
  graduated. Show the curve's progress while it is 1: raised `reserve_quote` of
  `graduation_target` (offset 512), 85 SOL with the defaults. Show "graduated" when it is 2.
  The `Graduated` event gives the moment, with the reserves before and after.
* **Candles from swaps.** The `Swapped` event carries the real reserves. Price a trade with
  the pool's virtual quote until the coin's `Graduated` event, and with 0 after it.
* **Liquidity** is refused while the coin is on the curve, and every LP share of the pool
  is locked from its creation. Nobody holds LP of a curve coin, so nobody can pull it.
* **Volume and trades** are the same events as on any pool.

The adapter routes these pools before and after graduation, and quotes them exactly
(`jupiter-adapter/README.md`, "Pools on the curve"). It never sends `graduate`; the
platform's keeper does.

## What will not be routed, and why

* **Pegged coins and strict coins** (Token-2022 with a transfer hook: the collectible
  hook on a pegged coin, the rules hook on a strict coin). Jupiter's own order features
  refuse transfer-hook mints unless whitelisted, and nothing in their docs says the
  router takes them. The adapter leaves them out. Pegged coins and strict coins trade on
  the DEX's own site and through the trade API. A strict coin also needs a holder record
  per wallet and can refuse a buy, a sell or a send while its windows run; the SDK, the
  trade API (which opens the holder record in front of a first buy and answers each
  refusal with a code of its own, `API.md`) and `scripts/raw-swap-example.mjs` add the
  accounts it needs (`INTEGRATORS.md`, section 9). Plain coins have no such limit.
* **Pools on a hook nobody can predict.** A third-party hook may answer any fee under the
  caps. The adapter offers such a pool only in the directions on which the pool never
  calls the hook. A wrong quote makes swaps fail on slippage, and aggregators drop
  sources that fail often. The trade API handles these pools by simulating each trade.
* **Pieces through a router.** A buy on a collectible coin earns pieces for the wallet
  that signs the swap, if it has a ticket. Where a router signs with its own authority,
  nobody earns. The trade itself is the same.
* **A buy above the buy limit of a rules coin, while the limit runs.** The chain fails
  such a buy whole, so the adapter answers it with an error. Smaller buys and every sell
  are routed, and the limit ends at most an hour after the launch.

## Sources

* Jupiter, Integrate AMM into Metis: https://developers.jup.ag/docs/routing/dex-integration
* Jupiter, market listing criteria: https://developers.jup.ag/docs/swap/routing/amm/market-listing
* `jupiter-amm-interface` and its test kit: https://github.com/jup-ag/jupiter-amm-interface
* Jupiter Trigger orders and transfer-hook mints: https://developers.jup.ag/docs/trigger
* DexScreener, DEX listing: https://docs.dexscreener.com/dex-listing
* GeckoTerminal, non-EVM DEX integration:
  https://support.coingecko.com/hc/en-us/articles/41889080628889-How-to-integrate-Non-EVM-Chain-DEX-on-GeckoTerminal
* Example of the data feed format: https://github.com/balancer/balancer-v3-dex-screener-api

Not verified: the exact fields of the DexScreener and GeckoTerminal feed (their spec pages
did not load; the endpoint names come from public adapters), whether Jupiter's router
accepts transfer-hook mints from a new DEX, and how each terminal chooses launchpads.
