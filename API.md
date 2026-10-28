# Programmable trade API

Buy and sell any Programmable coin with two HTTP calls. You do not need our SDK, our program
ids or our account layouts.

1. `GET /api/v1/quote` says what a trade gives.
2. `POST /api/v1/swap` answers one complete unsigned transaction. You sign it and you send it.

The API never sees a private key. It never sends a transaction.

## Conventions

* The base URL is the Programmable site. A local server is `http://localhost:8787`.
* JSON in, JSON out.
* Amounts are strings of whole numbers in raw units. SOL is in lamports: 1 SOL is
  `"1000000000"`. A coin is in its smallest unit, and `coin.decimals` says how many decimals
  it has. Never send a decimal point or a JSON number.
* Public keys are base58 strings.
* Every pool trades one coin against SOL. A `buy` spends SOL and gives coins. A `sell`
  spends coins and gives SOL.
* Trades are exact-input: you fix what goes in, and the smallest amount you accept back.
* Every answer carries `Access-Control-Allow-Origin: *`, so a browser app can call it.
  `OPTIONS` is answered with 204.
* No answer is cached.
* Unknown fields are refused, and so is a field given twice. A typo in a field name is an
  error, not a silent default. A field whose name looks like a private key (`secretKey`,
  `mnemonic` and the like) is refused with a warning and its value is never repeated.

## GET /api/v1/quote

The fields go in the query string.

| Field | Required | Meaning |
|---|---|---|
| `mint` | one of the two | The coin's mint. The pool is the coin against SOL. |
| `pool` | one of the two | The pool address, instead of `mint`. |
| `side` | yes | `buy` or `sell`. |
| `amount` | yes | What goes in, in raw units: lamports for a buy, coin units for a sell. 1 to 18446744073709551615. |
| `slippageBps` | no | How far the output may fall before the chain refuses, in basis points. A whole number, 0 to 5000. Default 100, which is 1%. |
| `userPublicKey` | no | A wallet. On a strict coin the quote then checks the coin's rules against that wallet, as `/swap` does, and says what its coins will be after the trade. It changes nothing on other coins. |

```
GET /api/v1/quote?mint=ATGcZdZWc42aXRXkMw9e1XkbDBHfLMCPLxdr8ShMN4oi&side=buy&amount=200000000
```

```json
{
  "pool": "EG2D8gTbEw5TP5NCmRoUVbkFyDPQKsK6ndZf2ft184Ce",
  "side": "buy",
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "ATGcZdZWc42aXRXkMw9e1XkbDBHfLMCPLxdr8ShMN4oi",
  "inAmount": "200000000",
  "outAmount": "79449219216402",
  "minOutAmount": "78654727024237",
  "slippageBps": 100,
  "priceBefore": "0.00000000221158929",
  "priceAfter": "0.00000000263400416",
  "priceImpactPct": "8.34",
  "fees": {
    "protocol": { "amount": "400000", "mint": "So11111111111111111111111111111111111111112", "bps": 20 },
    "pool": { "amount": "1936120", "mint": "So11111111111111111111111111111111111111112", "bps": 100 },
    "hook": { "amount": "5988000", "mint": "So11111111111111111111111111111111111111112", "bps": 300 }
  },
  "hook": {
    "program": "jwdXDuSQ9pNV1pXj8BFvBb5fhqtTL3duQkwsTjXunhr",
    "template": "tax",
    "kind": "platform",
    "runsOnBuys": true,
    "runsOnSells": true
  },
  "coin": {
    "mint": "ATGcZdZWc42aXRXkMw9e1XkbDBHfLMCPLxdr8ShMN4oi",
    "symbol": "QUICK",
    "name": "Quickstart Coin",
    "decimals": 6,
    "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "collectible": null
  },
  "mintDeposit": null,
  "curve": { "state": "none", "virtualQuote": "0", "raised": "0", "target": "0", "raisedBps": 0, "soldBps": 0, "graduates": false, "graduateFirst": false },
  "exact": true,
  "slot": 7431,
  "notes": [
    "This coin has a tax of 3% on buys and 5% on sells, taken in SOL for the coin's treasury. The quote includes it.",
    "The owner of the tax can change it, up to 10%."
  ]
}
```

The answers in this document were copied from a local test chain. A coin you launch
yourself has other addresses.

| Field | Type | Meaning |
|---|---|---|
| `pool` | string | The pool address. |
| `side` | string | `buy` or `sell`, as asked. |
| `inputMint`, `outputMint` | string | The mint that goes in and the mint that comes out. SOL is the wrapped SOL mint, `So11111111111111111111111111111111111111112`. |
| `inAmount` | string | What goes in, as asked. |
| `outAmount` | string | What comes out after every fee. |
| `minOutAmount` | string | `outAmount` less the slippage, rounded down. The swap carries this number and the chain enforces it. Nothing lowers it, on a coin on the curve neither. |
| `slippageBps` | number | The slippage used. |
| `priceBefore`, `priceAfter` | string | SOL for one whole coin, before and after this trade. Decimal strings, 9 significant digits, cut not rounded. On a coin on the curve the price counts the virtual SOL: it is `(real SOL + virtual SOL) / coins in the pool`. |
| `priceImpactPct` | string | How much worse the curve price of this trade is than `priceBefore`, in percent, two decimals. Fees are not in it. |
| `fees.protocol` | object | The platform's fee. `amount` (string) is in raw units of `mint` (string), `bps` (number) is the rate. It comes off the input. |
| `fees.pool` | object | The pool's fee, which stays in the pool. It comes off the input. `bps` is the rate of this trade: a launch guard raises it, and so does the sniper fee of a rules coin. |
| `fees.hook` | object | The hook's fee. Always in SOL: off the input of a buy, off the output of a sell. `amount` is what this trade pays and `bps` the rate it pays at. On a rules coin that is the coin's shares of this side together. Zero when the hook takes none, and zero for a custom hook, whose fee is not known in advance. |
| `hook` | object or null | `null` for a pool without a hook. Otherwise `program` (string), `template` (`tax`, `launch_guard`, `buyback`, `collectible`, `rules` or `custom`), `kind` and when it runs. |
| `hook.kind` | string | `platform`: one of our templates, which the platform can upgrade. `frozen`: a third-party program whose code nobody can change. Its own settings may still change if its code allows it. |
| `hook.runsOnBuys`, `hook.runsOnSells` | boolean | Whether hook code runs in a buy and in a sell. A hook that does not run on sells cannot block or tax them. |
| `hook.rules` | object | Only when `hook.template` is `rules`. `creatorBps`, `holdersBps`, `burnBps` (numbers): the three rates of this side, as the coin's rules set them. `sniperEndsAtSlot` (number or null): the first slot without the sniper fee, or `null` when no sniper fee touches this trade. `buyLimit` (object or null): `maxAmount` (string, lamports) and `endsAtSlot` (number) while a buy limit touches this trade. `strict` (object or null): `null` on a plain rules coin, the strict part on a strict coin. See "Kinds of coin". |
| `hook.rules.strict` | object or null | `maxWallet` (string or null): the most one wallet may hold while the max wallet runs, in raw units of the coin; `null` when the coin has no max wallet. `maxWalletEndsAtSlot`, `earlyEndsAtSlot`, `earlyUnlockSlot` (number or null): the first slot after the max wallet, after the early window, and from which early coins move; `null` for a rule the coin does not have. Compare them with `slot`. `wallet` (object or null): `null` unless the request named a wallet. Otherwise `address` (the wallet the rules were checked for: the receiver of a buy, the seller of a sell), `balance` (string: what its coin account holds now), `after` (string: what it holds after this trade; while the sniper fee falls, the most it can hold, at the pool's normal fee), `holderRecord` (boolean: it has a holder record now), `opensHolderRecord` (boolean: `/swap` puts `open_holder` in front of this buy), `locked` (string: its coins the early lock or the creator lock holds after this trade) and `creatorLockedUntil` (number or null: the Unix time of the creator lock, while it holds). |
| `coin` | object | The coin's `mint`, `symbol`, `name` (strings), `decimals` (number) and `tokenProgram` (string). Symbol and name come from the chain as the launcher wrote them, without control characters, cut to 16 and 40 characters: escape them before you show them. |
| `coin.collectible` | object or null | `null` for a coin without pieces. Otherwise `kind` (`plain` or `pegged`), `unit` (string: raw coin units behind one piece) and `maxPerBuy` (number). See "Kinds of coin". |
| `mintDeposit` | object or null | `null` unless this is a buy of a collectible coin. Otherwise `pieces` (number): the pieces the buy earns. `lamports` (string): the deposit for their NFTs that `/swap` adds to the buy, so that a keeper mints them into the wallet (see "One approval"). The quote counts it for a wallet with nothing waiting and no deposit; `/swap` answers the exact amount for its wallet, which can be less. `included` (boolean): the transaction carries it. |
| `curve` | object | Where the pool stands on the curve. `state` (string): `none` for a seeded pool, `open` for a pool on the curve, `graduated` for one that left it. `virtualQuote` (string, lamports): the virtual SOL counted in the price, `0` unless open. `raised` (string, lamports): the real SOL in the pool, `0` on a seeded pool. `target` (string, lamports): the real SOL the pool graduates at, `0` unless open. `raisedBps` (number): `raised` over `target` in basis points, at most 10000, and 10000 once graduated. `soldBps` (number or null): the share of the coin's supply out of the pool, in basis points, `0` on a seeded pool, null when the mint could not be read. `graduates` (boolean): this transaction sends `graduate`. `graduateFirst` (boolean): `true` when it comes right before the swap, on a pool that stands at or past its target, and the quote is the graduated pool's; `false` when it comes right after the swap, on a buy that takes the pool there, or when the transaction sends none. See "A coin on the curve". |
| `exact` | boolean | `true`: the chain gives exactly `outAmount` while nobody else trades first. `false`: see below. |
| `slot` | number | The slot the pool was read at. |
| `notes` | array of strings | Short sentences to show the person who trades. |

`exact` is `false` in three cases.

* A buy while a launch guard is running. The fee falls every slot, so the chain gives
  `outAmount` or more.
* A buy while the sniper fee of a rules coin is running. It is the same falling fee, so
  the chain gives `outAmount` or more.
* A custom hook that can change the amounts of this trade: the pool calls it before the
  swap in this direction, and it holds the power to take a fee, to replace the pool fee
  or to set the price. The quote assumes it takes nothing, so the chain may give less.
  `/swap` asks the chain instead, see "Custom hook" below.

In every other case the quote follows the pool's own arithmetic to the last unit. That
includes a custom hook the pool does not call in this direction, and one that only runs
after the swap: it cannot change the amounts, though it can refuse the trade.

A quote reserves nothing. Another trade can land before yours. `minOutAmount` is what
protects you.

## POST /api/v1/swap

The body is a JSON object. It takes the request fields of the quote (`mint` or `pool`,
`side`, `amount`, `slippageBps`), plus:

| Field | Required | Type | Meaning |
|---|---|---|---|
| `userPublicKey` | yes | string | The wallet that signs and pays. It is the only signer. |
| `recipient` | no | string | Another wallet that receives the output: the coins of a buy, the SOL of a sell. The signer still pays. See "Recipient". |
| `minOutAmount` | no | string | Your own floor in raw units, in place of the one computed from `slippageBps`. Send the `minOutAmount` of the quote your user saw. If the pool now gives less, the call answers `SLIPPAGE_EXCEEDED` and builds nothing. |
| `computeUnitPriceMicroLamports` | no | number | A priority fee, in micro-lamports per compute unit. 0 to 5000000. Default 0. |
| `simulate` | no | boolean | `true`: the server also runs the transaction on the chain's simulator before it answers. |
| `mintDeposit` | no | boolean | A buy of a collectible coin only. Default `true`: the buy pays the deposit for the NFTs of the pieces it earns, and a keeper mints them into the wallet a few seconds later, with no second signature. `false` leaves the deposit out: the wallet then mints its pieces itself, in a second transaction. See "One approval". |

`amount` and `minOutAmount` are strings, as in the quote. `slippageBps` and
`computeUnitPriceMicroLamports` are JSON numbers; a string of digits is accepted too.
`simulate` and `mintDeposit` must be the JSON value `true` or `false`, not a string. An
optional field may be left out or sent as `null`, except `mintDeposit`, which is left out
or sent as a boolean.

```json
{
  "mint": "ATGcZdZWc42aXRXkMw9e1XkbDBHfLMCPLxdr8ShMN4oi",
  "side": "buy",
  "amount": "200000000",
  "minOutAmount": "78654727024237",
  "userPublicKey": "<the wallet that signs>",
  "simulate": true
}
```

```json
{
  "transaction": "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "blockhash": "4hp4WHUpY4gG1LFEjGAuNpbDqZbfpPjjbcEELoNichuU",
  "lastValidBlockHeight": 7582,
  "userPublicKey": "<the wallet that signs>",
  "recipient": "<the wallet that signs>",
  "instructions": ["compute_unit_limit", "create_token_account", "create_token_account", "wrap_sol", "sync_wrapped_sol", "swap", "unwrap_sol"],
  "computeUnitLimit": 250000,
  "computeUnitPriceMicroLamports": 0,
  "quote": { "outAmount": "79449219216402", "minOutAmount": "78654727024237" },
  "simulation": { "outAmount": "79449219216402", "unitsConsumed": 75915, "slot": 7432 },
  "notes": [
    "This coin has a tax of 3% on buys and 5% on sells, taken in SOL for the coin's treasury. The quote includes it.",
    "The owner of the tax can change it, up to 10%.",
    "The transaction creates the wallet's token account for this coin. The wallet pays its rent, about 0.002 SOL."
  ]
}
```

The example is shortened in two places. `transaction` is cut: a real one is 700 to 1500
characters, this one 928. `quote` shows two fields: a real one has every field of `/quote`.

| Field | Type | Meaning |
|---|---|---|
| `transaction` | string | Base64 of an unsigned version 0 transaction. The fee payer is `userPublicKey`. |
| `blockhash`, `lastValidBlockHeight` | string, number | What you need to confirm it. The transaction is valid for about a minute. After that, ask again. |
| `userPublicKey` | string | The one wallet that must sign. |
| `recipient` | string | The wallet that receives the output. It is `userPublicKey` when you sent no `recipient`. |
| `instructions` | array of strings | The instructions of the transaction, in order, by name. |
| `computeUnitLimit`, `computeUnitPriceMicroLamports` | number | The compute budget of the transaction. The limit is 250000, 450000 for a sell of a collectible coin and 600000 for a buy of one, and 25000 more when the transaction sends `graduate`. The priority fee in lamports is their product divided by 1000000. |
| `quote` | object | The quote this transaction was built on, with every field of `/quote`. The server reads the pool again for a swap, so compare it with what your user saw, or send `minOutAmount`. Its `minOutAmount` is the floor inside the transaction. When you sent your own floor, `slippageBps` played no part. |
| `simulation` | object or null | `null` unless you sent `simulate: true`. Otherwise `outAmount` (string: what the chain's simulator paid out), `unitsConsumed` (number) and `slot` (number). |
| `notes` | array of strings | The notes of the quote, then notes about this wallet and this transaction. |

### What the transaction contains

Only these instructions, and the server refuses to answer if it built anything else:

| Name | What it does |
|---|---|
| `compute_unit_limit`, `compute_unit_price` | The compute budget. The second one is there only when you ask for a priority fee. |
| `create_token_account` | Creates a token account that does not exist yet: the coin's, or a wrapped SOL account. The signer pays the rent. |
| `wrap_sol`, `sync_wrapped_sol` | Moves the lamports of a buy into the signer's wrapped SOL account. |
| `swap` | The trade, with `minOutAmount` inside. |
| `unwrap_sol` | Closes the signer's wrapped SOL account, when this transaction opened it. Its SOL goes to the signer, or to `recipient` on a sell. |
| `open_ticket` | The first buy of a collectible coin: opens the signer's ticket for that coin. |
| `mint_deposit` | A buy of a collectible coin that earns pieces, right after the swap: a plain SOL transfer of `quote.mintDeposit.lamports` from the signer to its own ticket for that coin. It pays the NFTs of the pieces, which a keeper mints into the wallet. What is left stays the wallet's. Not there with `mintDeposit: false`, nor when the wallet's deposit already covers it. |
| `settle`, `reap` | A sell of a collectible coin: burns the pieces the wallet's coins no longer back. It also names the asset addresses of the waiting pieces the sell drops: if a keeper mints them before the sell lands, the sell burns them and their rent comes back to the seller. |
| `open_holder` | The first buy of a strict coin: opens the signer's holder record for that coin, right before the swap. The signer pays its rent (129 bytes: 1305560 lamports on mainnet, read from the chain), which comes back when the record is closed. |
| `graduate` | A coin on the curve. On a pool that stands at or past its graduation target it comes right before the swap: the coin graduates first and the trade runs on the graduated pool. On a buy that takes the pool to its target it comes right after the swap. It takes no signer and moves nothing of the wallet's. If somebody graduated the coin first, it lands and changes nothing. |

You can check this yourself before you sign. Decode the transaction, look up the platform's
lookup table and read the instructions. `scripts/e2e-api.mjs` does exactly that.

### The signer's wrapped SOL account

A pool takes and pays wrapped SOL, in the signer's associated wrapped SOL account.

* A signer without that account, the usual case: the transaction creates it and closes
  it again at the end (`unwrap_sol`). The wallet spends and receives plain SOL, and the
  rent of the account comes back in the same transaction.
* A signer that already has that account keeps it. The transaction never closes an
  account it did not open: it may be the fee treasury of a coin. A buy wraps exactly the
  amount and spends it, and what the account held does not move. A sell pays wrapped SOL
  into it, and a note says so. There is no `unwrap_sol` in such a transaction.
* The same holds for a signer whose wrapped SOL account is the treasury of the pool it
  trades, the dev of a tax coin for example, even if that account is closed at the
  moment: the transaction opens it and leaves it open.

### What a trade leaves behind

The API never closes the coin's token account or a ticket. After a sell of everything
the empty token account stays open with its rent (165 bytes: 1488440 lamports on mainnet;
175 bytes for a pegged coin: 1539240), and so does the ticket of a collectible coin (346
bytes: 2407920 lamports on mainnet). Every rent in this document is the chain's rent of the
account's size, which the server reads once an hour; mainnet charges 5080 lamports a byte of
account (over 128 bytes of overhead) and a local validator 6960, so the same accounts cost
2039280, 2108880 and 3299040 lamports in a rehearsal on the local chain. What is left of a
deposit stays in the ticket too, and stays the wallet's: it pays for the NFTs of its next
buy, and `withdraw_deposit` gives it back (the SDK's `collectibleWithdrawInstructions`, or
"Withdraw deposit" on the coin page).

### One approval

The pieces a buy of a collectible coin earns are decided by a block two slots after the
buy, so their NFTs cannot be minted inside the buy. A transaction from `/swap` pays their
rent instead, as a deposit: `mint_deposit`, a plain SOL transfer from the signer to its own
ticket, right after the swap. The program's permissionless `mint_for` then mints the
decided pieces into the wallet, and pays its sender back from that deposit: what it spent
on the NFTs, plus 10000 lamports. The operator's watcher sends it a few seconds after the
buy. The wallet signs once.

* The amount is the SDK's `mintDepositFor` of every piece the wallet will have waiting,
  less what its ticket already holds: per piece the NFT's rent at its largest size, the
  Metaplex Core fee (0.0015 SOL, kept in the NFT), 32 bytes of ticket (162560 lamports on
  mainnet) and the keeper's 10000 lamports. That is about 0.0036 SOL a piece on mainnet
  (3638520 lamports) while the collection is not locked (its owner may still lengthen the
  name and the address the NFTs carry), a little less once it is locked. The exact amount
  is read from the chain's rent, not taken from a constant: a local validator charges
  6960 lamports a byte against mainnet's 5080, so a rehearsal there shows about 0.0044 SOL
  for the same piece. What a mint does not use stays the wallet's deposit.
* The deposit belongs to the wallet. Only its own pieces' mints take from it, and
  `withdraw_deposit`, which the wallet alone signs, gives it back. The hook gets no right
  over the wallet.
* With `mintDeposit: false` there is no deposit. The wallet mints its pieces itself, in a
  second transaction, once their block is in (the SDK's `collectibleMintInstructions`).
  A wallet's own mint takes from its deposit first too.
* A buy never carries a mint. Pieces left from earlier buys are minted by the keeper, when
  the deposit covers them, or by the wallet.
* `INSUFFICIENT_FUNDS` counts the deposit as one more part of what a buy needs: `10915560
  for the deposit for the NFTs of its pieces, what is left of it stays the wallet's` (three
  pieces on mainnet).

### Simulation

With `simulate: true` the server runs the finished transaction through the chain's
simulator, without signatures. If it passes, `simulation.outAmount` is what the chain would
pay out right now. If it fails, the call answers an error with the reason in words:
`INSUFFICIENT_FUNDS`, `SLIPPAGE_EXCEEDED`, `TRADING_PAUSED`, `BUY_LIMIT_EXCEEDED`,
`CURVE_REAL_RESERVE` or `SIMULATION_FAILED`.

Without `simulate` the server still checks two things before it builds. A buy needs, in
the wallet, everything the transaction takes at its peak: the amount, the network fee of
5000 lamports, and the rent of every account the transaction creates, at the chain's rent
(on mainnet 1488440 lamports for the coin's token account, 1539240 for a Token-2022 coin,
1488440 for a wrapped SOL account that lives for the length of the transaction and comes
back at the end, and 1305560 for the holder record of a strict coin, which comes back when
the record is closed). A sell needs the coins, and 5000 lamports. With a priority fee, both
need that fee too: `computeUnitLimit` times `computeUnitPriceMicroLamports`, divided by
1000000 and rounded up. The `INSUFFICIENT_FUNDS` message lists each part: `The wallet holds
52981879 lamports. This buy needs 52981880: 50000000 for the buy, 5000 for the network fee,
1488440 for the rent of its token account for this coin, 1488440 for the rent of a wrapped
SOL account, which comes back at the end of the transaction.` A priority fee adds a part
such as `250000 for the priority fee of 250000 compute units at 1000000 micro-lamports`.
On a local validator the rents in these messages are larger (2039280, 2108880 and 1788720):
it charges 6960 lamports a byte of account, mainnet 5080.

### Recipient

* `recipient` must be a wallet: an address that holds nothing yet, or an account the
  system program owns. A token account, a mint or a program is refused with
  `INVALID_PARAMETER`, because the output would be stranded there.
* A buy puts the coins in the recipient's associated token account for the coin, under
  `coin.tokenProgram`. The transaction creates that account if needed, and the signer pays
  its rent.
* A sell sends the SOL to the recipient. It gets there when the signer's wrapped SOL account
  is closed, so the rent of that account (1488440 lamports on mainnet) goes to the recipient
  too.
* A signer that keeps a wrapped SOL account (see above) does not close it. The recipient
  of its sell then receives wrapped SOL, in the recipient's own associated wrapped SOL
  account, which the transaction creates if needed. A note says so.
* Pieces of a collectible coin belong to the wallet that signs. A buy for a recipient
  earns none.

## Worked example

`scripts/api-example.mjs` is this example as a file you can run:
`node scripts/api-example.mjs http://localhost:8787 <coin mint>`.

```js
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

const API = "http://localhost:8787";                                      // the Programmable site
const connection = new Connection("http://127.0.0.1:8899", "confirmed");  // your own RPC
const wallet = Keypair.fromSecretKey(loadMyKey());                        // stays on your side
const mint = "ATGcZdZWc42aXRXkMw9e1XkbDBHfLMCPLxdr8ShMN4oi";
const amount = "200000000";                                               // 0.2 SOL

async function call(path, init) {
  const res = await fetch(API + path, init);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error.code + ": " + json.error.message);
  return json;
}

// 1. The quote. Show outAmount, minOutAmount and the notes to your user.
const quote = await call("/api/v1/quote?" + new URLSearchParams({ mint, side: "buy", amount, slippageBps: "100" }));

// 2. The transaction, pinned to the floor of that quote and simulated first.
const swap = await call("/api/v1/swap", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ mint, side: "buy", amount, minOutAmount: quote.minOutAmount, userPublicKey: wallet.publicKey.toBase58(), simulate: true }),
});

// 3. Sign, send, confirm.
const tx = VersionedTransaction.deserialize(Buffer.from(swap.transaction, "base64"));
tx.sign([wallet]);
const signature = await connection.sendRawTransaction(tx.serialize());
const result = await connection.confirmTransaction(
  { signature, blockhash: swap.blockhash, lastValidBlockHeight: swap.lastValidBlockHeight }, "confirmed");
if (result.value.err) throw new Error("the transaction failed: " + JSON.stringify(result.value.err));
console.log("bought " + swap.simulation.outAmount + " units, signature " + signature);
```

A sell is the same with `side: "sell"` and `amount` in coin units. On a pool with a custom
hook whose quote is not exact, leave `minOutAmount` out of the swap call: the server then
takes the floor from its own simulation of the trade (see "Custom hook"). The script does
that.

## Errors

Every failure has one shape and a fitting HTTP status:

```json
{ "error": { "code": "POOL_NOT_FOUND", "message": "No Programmable pool trades this mint against SOL on localnet." } }
```

`message` is a sentence you can show. `INVALID_PARAMETER` adds `parameter`, the name of the
field. An error a program gave in a simulation adds `programError` with its `name` and
`number`. `BUY_LIMIT_EXCEEDED` adds `maxAmount` (string: the most one buy can spend, in
lamports) and `endsAtSlot` (number: the first slot without the limit):

```json
{ "error": { "code": "BUY_LIMIT_EXCEEDED", "message": "This coin has a buy limit. One buy can spend at most 200000000 lamports (0.2 SOL) until slot 8935, in about 597 seconds. This buy sends 300000000 lamports. Send a smaller amount, or wait until the limit ends.", "maxAmount": "200000000", "endsAtSlot": 8935 } }
```

The four refusals of a strict coin carry the numbers a caller needs to change its trade.
`MAX_WALLET_EXCEEDED` adds `maxWallet` (string: the cap, in raw units of the coin),
`walletBalance` (string: what the receiving wallet holds), `room` (string: how much more it
can receive), `maxAmount` (string: the largest buy, in lamports, whose coins still fit, or
`0` when no buy the pool takes fits) and `endsAtSlot` (number: the first slot without the
max wallet). While the sniper fee runs, a buy that lands later gives more coins than the
quote of the read slot, so `maxAmount` and the check behind it count the most a buy can
give, its output at the pool's normal fee, and the message says "would give it up to". A
price fall between the quote and the landing can still push a buy within a hair of the cap
over it: keep a margin. `EARLY_LOCKED` adds
`walletBalance`, `locked` (string: the wallet's coins bought in the early window), `free`
(string: the most it can sell now) and `unlockSlot` (number). `CREATOR_LOCKED` adds
`walletBalance`, `locked`, `free` and `unlockAt` (number: a Unix time).
`HOLDER_RECORD_REQUIRED` adds `recipient` (string) and `endsAtSlot` (number: the first slot
after the early window). The four are the same on a strict coin launched on the curve. Answers
copied from a local test chain:

```json
{ "error": { "code": "MAX_WALLET_EXCEEDED", "message": "This coin has a max wallet. Until slot 246044, in about 79 seconds, one wallet can hold at most 30000000000000 raw units of the coin. The receiving wallet holds 0, so it can receive 30000000000000 more, and this buy would give it 310851284189195. The largest buy it can make now is 67728653 lamports.", "maxWallet": "30000000000000", "walletBalance": "0", "room": "30000000000000", "maxAmount": "67728653", "endsAtSlot": 246044 } }
{ "error": { "code": "EARLY_LOCKED", "message": "Coins this wallet bought in the coin's first slots cannot leave it before slot 245994, in about 59 seconds. The wallet holds 23408746743331 raw units, 23408746743331 of them bought early, so it can sell at most 0 now.", "walletBalance": "23408746743331", "locked": "23408746743331", "free": "0", "unlockSlot": 245994 } }
{ "error": { "code": "CREATOR_LOCKED", "message": "This wallet is the coin's creator, and 4817972758122 raw units of its coins are locked until 2026-10-15T03:39:17Z (Unix time 1792035557). The wallet holds 4817972758122, so it can sell at most 0 now.", "walletBalance": "4817972758122", "locked": "4817972758122", "free": "0", "unlockAt": 1792035557 } }
{ "error": { "code": "HOLDER_RECORD_REQUIRED", "message": "A buy in this coin's first slots needs a holder record of the wallet that receives the coins, and only that wallet can open it. The recipient has none. Until slot 245919, in about 29 seconds, buy for a wallet that has one, or let the recipient buy for itself: the API opens a wallet's own record in front of its buy.", "recipient": "<the recipient>", "endsAtSlot": 245919 } }
```

A sell on a coin on the curve that would take more than the real SOL in its pool answers
`CURVE_REAL_RESERVE`. It adds `realReserve` (string: the lamports of real SOL in the pool)
and `maxAmount` (string: the largest sell, in raw units of the coin, that the pool pays now,
or `0` when it pays none). No wallet can hold such a sell: the coins that left the pool can
always be sold back for real SOL. So the code answers a sell larger than anything that ever
left the pool, on `/quote` or on `/swap`, before anything is built. An answer copied from a
local test chain:

```json
{ "error": { "code": "CURVE_REAL_RESERVE", "message": "This coin is on the curve. Its pool counts 30 SOL of virtual SOL in the price, but pays a sell from the real SOL it holds, 998000000 lamports. This sell would take more than that. The largest sell it pays now is 32596500555596 raw units of the coin.", "realReserve": "998000000", "maxAmount": "32596500555596" } }
```

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_JSON` | The body is not a JSON object. |
| 400 | `INVALID_PARAMETER` | A field is missing, malformed, out of bounds, given twice or unknown. Also a `recipient` that is not a wallet, and a request URL longer than 1024 characters (`parameter` is then `url`). |
| 404 | `NOT_FOUND` | No such endpoint. |
| 404 | `POOL_NOT_FOUND` | No pool trades this mint against SOL, or the address is not a pool. |
| 405 | `METHOD_NOT_ALLOWED` | `/quote` takes GET. `/swap` takes POST. The `Allow` header names the method. |
| 413 | `BODY_TOO_LARGE` | The body is larger than 4096 bytes. |
| 422 | `CANNOT_QUOTE` | The pool would refuse this amount, or the quote cannot be made: the fees take all of the amount, the output rounds to zero (the message then speaks of too little liquidity), a reserve would not fit in 64 bits, or the coin or the hook's settings could not be read. |
| 422 | `MAX_WALLET_EXCEEDED` | A strict coin, while its max wallet runs: the buy would leave the receiving wallet above the cap. Checked by `/swap`, and by `/quote` when it names a wallet. Buy at most `maxAmount`, or wait until slot `endsAtSlot`. |
| 422 | `EARLY_LOCKED` | A strict coin, while its early lock runs: the sell would take coins the wallet bought in the early window. Sell at most `free`, or wait until slot `unlockSlot`. |
| 422 | `CREATOR_LOCKED` | A strict coin: the sell would take the creator's locked coins before their date. Sell at most `free`, or wait until `unlockAt`. |
| 422 | `HOLDER_RECORD_REQUIRED` | A strict coin, in its early window: a buy for a `recipient` that has no holder record. Only the recipient can open it. |
| 422 | `BUY_LIMIT_EXCEEDED` | A buy above the buy limit of a rules coin, while that limit runs. Both `/quote` and `/swap` answer it, and `/swap` answers it before it builds anything. Send at most `maxAmount`, or wait until slot `endsAtSlot`. |
| 422 | `CURVE_REAL_RESERVE` | A coin on the curve: the sell would take more than the real SOL in the pool. Both `/quote` and `/swap` answer it, before anything is built. Sell at most `maxAmount`. |
| 422 | `UNSUPPORTED_POOL` | The pool does not trade against SOL, or its hook's accounts could not be resolved. |
| 422 | `INSUFFICIENT_FUNDS` | The wallet holds too little SOL or too few coins. |
| 422 | `SLIPPAGE_EXCEEDED` | The pool now gives less than your `minOutAmount`. |
| 422 | `SIMULATION_FAILED` | With `simulate: true`, or on a custom hook: the chain refused the transaction for another reason. |
| 422 | `TRANSACTION_TOO_LARGE` | The transaction does not fit in one packet. Only on a server set up without the platform's lookup table. |
| 429 | `RATE_LIMITED` | Too many calls from your address. `Retry-After` says how many seconds to wait. |
| 500 | `INTERNAL` | A fault on our side. |
| 502 | `RPC_UNAVAILABLE` | The Solana RPC behind the API did not answer. Try again. |
| 503 | `TRADING_PAUSED` | The platform paused trading. |
| 503 | `NOT_DEPLOYED` | Programmable is not set up on the cluster this server points at. |

An amount is refused only when the pool itself would refuse it. A very large amount is
quoted like any other: the output approaches the whole reserve and `priceImpactPct`
approaches 100.

A transaction can still fail on chain after a good answer. The usual reason is the pool's
own error 6008, `Slippage`: another trade landed first and the output fell below
`minOutAmount`. Nothing is traded then, and the wallet pays only the network fee. On a
coin on the curve that is also what happens to a buy quoted on the curve when another
trader reached the target and graduated the coin first: the price moved, and the minimum
holds. Ask for a new quote; it is priced on the graduated pool. The `graduate` a
transaction carries never fails it: below the target, or on a pool already graduated, it
does nothing.

## Limits

| What | Limit |
|---|---|
| Quote calls | 120 per minute per IP address |
| Swap calls | 30 per minute per IP address |
| Body | 4096 bytes |
| URL | 1024 characters |
| `amount`, `minOutAmount` | 1 to 18446744073709551615 |
| `slippageBps` | 0 to 5000 |
| `computeUnitPriceMicroLamports` | 0 to 5000000, which is at most 0.003 SOL on the largest transaction |

Every counted answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset`, the seconds until the window ends. A request refused for what it
asked (a 400, a 404 for a pool, a 422) counts too. A preflight, an unknown endpoint and
a wrong method do not. A 429 also carries `Retry-After`. Quote calls and swap calls are
counted apart. Callers that share one IP address share one count.

The server reads the chain once per quote. Reserves, the platform's fees, the hook's
settings and the wallet's accounts are fresh in every answer. The lookup table, a hook's
account list and a coin's symbol and decimals are kept for ten minutes. On a coin on the
curve the coin's mint, for its supply, is read in the same call as the pool. A quote costs 1 RPC
call, a swap 2, a simulated swap 3. A swap on a custom hook that can change the amounts
costs 2 more. The first call for a pool costs 1 more: one read of the pool account, and the
coin's mint and name then ride in the same call as the pool. The first swap after a start reads
the lookup table once, and the first swap on each hook reads that hook's account list
once. Each 200 answer says what it cost in `X-Rpc-Calls`.

Caching more would not lower these numbers. The platform account, the hook's settings and the
coin's mint already ride in the one call that reads the pool, and a paid RPC counts that call
once, however many accounts it carries. The blockhash of a swap is read fresh for every swap:
one shared for a few seconds would give two identical swaps of one wallet the same
signature, and the network would drop the second one.

## Kinds of coin

`hook.template` and `coin.collectible` say which kind a coin is, and `curve.state` whether it
launched on the curve. The trade is the same two calls for all of them. This is what differs.

**No hook.** `hook` is `null`. The quote is exact.

**Taxed coin** (`tax`). A share of every buy and every sell is taken in SOL for the coin's
treasury. It is `fees.hook`, and `outAmount` already has it taken off. If the treasury
account does not exist at the moment of the trade, the trader pays and receives exactly
the same, and the share waits in the pool until the account is back. The owner of the tax
can change it between quote and trade, up to a ceiling fixed at launch, unless the owner
renounced. The notes say which. `minOutAmount` covers you.

**Buyback coin** (`buyback`). The same as a tax in a quote, except that the fee is fixed
at launch: nobody can change it. The fee collects in a treasury that only the hook
controls. Anyone can run a buyback. A run spends a slice of the treasury on the coin, at
most 0.5% of the pool's SOL, never at a price its caller just made, and burns what it
bought. A large treasury takes several runs, at least 25 slots apart. The API does not
run buybacks.

**Launch rules** (`rules`). A coin whose launcher switched on rules at launch: up to three
shares of every trade, a sniper fee, a buy limit. Nobody can change them afterwards, the
launcher included. The trade is the same transaction as on a taxed coin.
* The shares. A trade pays up to three shares, in SOL: one for the coin's creator, one for
  holders who stake the coin, one that buys the coin back and burns it. Buys and sells
  have their own rates. `fees.hook` is the shares of this side together, and `outAmount`
  already has it taken off. `hook.rules` carries the three rates of the side you asked
  about, and the notes say them in words.
* What a trader pays does not depend on how much is staked. While less than 0.1% of the
  coin's supply is staked, the holders' share goes to the burn instead, and the trader
  pays the same. The quote says the rule and never the staking state.
* If the platform's cap on hook fees is below the shares together, the trade pays the cap.
  `fees.hook.bps` is then the cap, `hook.rules` still carries the rates of the rules, and
  a note says so.
* The sniper fee. For the first slots of the pool, buys pay a high pool fee that falls
  every slot down to the normal one, as with a launch guard. `fees.pool.bps` is the fee at
  `slot`, `exact` is `false`, and your trade gives the same amount or a little more.
  `hook.rules.sniperEndsAtSlot` is the first slot without it. Sells never pay it.
* The buy limit. For the first slots of the pool, one buy cannot spend more than a set
  amount of SOL. While it runs, `hook.rules.buyLimit` carries the amount and the slot it
  ends at, and a note says both. A buy above it is refused with `BUY_LIMIT_EXCEEDED` by
  `/quote` and by `/swap`, before a transaction is built. The limit is per buy: smaller
  buys go through, one after the other. Sells are never limited. The API judges the limit
  at the slot it read the pool at. A buy above the limit is refused as long as that slot
  is inside the window, even if your transaction would land after it: ask again once the
  window is over.
* Outside the two windows the quote is exact, and `sniperEndsAtSlot` and `buyLimit` are
  `null`. On a sell they are always `null`.
* The API does not stake, claim rewards, claim the creator fee, lock coins or run the
  burn. Those are other transactions, which the coin page and the SDK build.

A buy of 0.1 SOL on a rules coin, 9 slots after its launch, inside both windows. These are
the parts of the quote that differ from the example at the top:

```json
{
  "fees": {
    "protocol": { "amount": "200000", "mint": "So11111111111111111111111111111111111111112", "bps": 20 },
    "pool": { "amount": "29008667", "mint": "So11111111111111111111111111111111111111112", "bps": 2966 },
    "hook": { "amount": "1996000", "mint": "So11111111111111111111111111111111111111112", "bps": 200 }
  },
  "hook": {
    "program": "3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr",
    "template": "rules",
    "kind": "platform",
    "runsOnBuys": true,
    "runsOnSells": true,
    "rules": {
      "creatorBps": 50,
      "holdersBps": 100,
      "burnBps": 50,
      "sniperEndsAtSlot": 8185,
      "buyLimit": { "maxAmount": "200000000", "endsAtSlot": 8935 }
    }
  },
  "exact": false,
  "slot": 7444,
  "notes": [
    "A sniper fee is running on this coin. Buys pay a pool fee of 29.66% at slot 7444. Sells do not pay it.",
    "The fee falls every slot. It is back to 1% at slot 8185, in about 297 seconds.",
    "This quote uses the fee of slot 7444. A trade that lands later gives the same amount or more.",
    "A buy limit is running on this coin. One buy can spend at most 200000000 lamports (0.2 SOL). The limit ends at slot 8935, in about 597 seconds. Sells are never limited.",
    "This coin takes 2% of every buy, in SOL. The quote includes it.",
    "It is split in three: 0.5% for the coin's creator, 1% for holders who stake the coin and 0.5% to buy the coin back and burn it.",
    "While less than 0.1% of the coin's supply is staked, the holders' share goes to the burn instead.",
    "These rates were fixed at launch and can never change."
  ]
}
```

The other notes a rules coin can carry: `All of it goes to the coin's creator.` (or to
holders who stake the coin, or `All of it buys the coin back and burns it.`) when a side
has one share, `It is split in two: ...` when it has two, `The rules of this coin take
nothing from a buy.` (or from a sell) when a side has none, and a sentence about the
platform's cap when the cap is below the shares.

**Strict coin** (`rules`, and `hook.rules.strict` is not null). A coin of the launch rules
template whose own transfer hook is the rules program, so its rules run inside every
transfer of the coin, not only in this pool. It is a Token-2022 coin (`coin.tokenProgram`).
It can have every rule of a rules coin except staking, and three more, each for a window
after launch:
* A max wallet: no buy may leave the receiving wallet above `hook.rules.strict.maxWallet`
  raw units until slot `maxWalletEndsAtSlot`. A sell is never held by it.
* An early lock: coins bought before slot `earlyEndsAtSlot` cannot leave the wallet before
  slot `earlyUnlockSlot`. The wallet's other coins can.
* Holder rewards without staking: the holders' share goes to the wallets that hold the
  coin and opened a holder record, in proportion to what they hold. The share notes say
  "for holders with a holder record", and "While less than 0.1% of the coin's supply is in
  holder records, the holders' share goes to the burn instead."

A creator lock on a strict coin is a floor on the creator's own wallet: its locked coins
stay in it and cannot leave before the date.

The quote is exact as on a rules coin: the fees do not depend on the windows. The windows
decide whether a trade may happen. `/swap` checks them for the wallet that receives a buy
(the signer, or `recipient`) and for the wallet that makes a sell, before it builds
anything, and answers `MAX_WALLET_EXCEEDED`, `EARLY_LOCKED`, `CREATOR_LOCKED` or
`HOLDER_RECORD_REQUIRED` with the numbers to change the trade. `/quote` does the same when
it is given `userPublicKey`, and then `hook.rules.strict.wallet` says what that wallet's
coins will be after the trade.

A buy by a wallet that has no holder record gets `open_holder` in front of the swap, so
the wallet earns its part of the holders' share from this buy on. A buy in the early window
needs the record, so there it is always in front. The wallet pays the record's rent (129
bytes: 1305560 lamports on mainnet, read from the chain), which comes back when the record
is closed. A buy for a `recipient` without a
record cannot open it: only that wallet can. In the early window such a buy is refused
(`HOLDER_RECORD_REQUIRED`); after it, the recipient receives the coins and earns no share
until it opens its own record. The swap carries three more accounts than on a plain
rules coin, whose config is already there (the holder record of the wallet whose coins
move, the pool's holder address, the coin's account list), and with them a buy is 785 to 843 bytes with the platform's
lookup table and uses 100,000 to 145,000 compute units.

The notes of a strict coin, after the notes of a rules coin:
* Always: `This is a strict coin. Its rules run inside every transfer of the coin, not only in this pool.`
* A buy while the max wallet runs: `A max wallet is running on this coin. Until slot 246044, in about 79 seconds, one wallet can hold at most 30000000000000 raw units of the coin. A sell is never held by it.`
* A buy in the early window: `Coins bought until slot 245919, in about 29 seconds, are early coins. They cannot leave the wallet before slot 245994, in about 59 seconds.`
* A sell while the early lock runs: `Coins bought in the coin's first slots cannot be sold before slot 245994, in about 59 seconds. Other coins can.`
* A buy, with no wallet named, on a coin with a holders' share: `Only wallets with a holder record earn the holders' share. /api/v1/swap opens the buyer's record in front of its first buy. The record's rent, 1305560 lamports, comes back when the record is closed.` (the number is the chain's rent of the record: 1305560 on mainnet, 1788720 on a local validator)

* A buy while the max wallet and the sniper fee both run, after the max wallet note: `The sniper fee falls every slot, so a buy that lands later gives more coins than this quote. The max wallet check leaves room for that: it counts the most this buy can give, at the pool's normal fee. A price fall between the quote and the landing can still push a buy within a hair of the cap over it, so keep a margin.`

With a wallet (`/swap`, or `/quote` with `userPublicKey`):
* A buy while the max wallet runs: `After this buy the receiving wallet holds 23408746743331 raw units, 6591253256669 under the cap.` While the sniper fee falls the numbers are the most the buy can give: `After this buy the receiving wallet holds up to 23408746743331 raw units, at least 6591253256669 under the cap.`
* A buy in the early window: `The 23408746743331 raw units of this buy are early coins. They stay locked in the wallet until slot 245994.` While the sniper fee falls: `The coins of this buy, up to 23408746743331 raw units, are early coins. They stay locked in the wallet until slot 245994.`
* A buy, the receiver with a record: `The receiving wallet has a holder record, so its coins earn a part of the holders' share.`
* A buy, the signer without a record: `The receiving wallet has no holder record. /api/v1/swap opens it in front of the buy, so its coins earn a part of the holders' share. The record's rent, 1305560 lamports, is paid by the wallet that signs and comes back when the record is closed.`
* A buy for a recipient without a record, after the early window: `The receiving wallet has no holder record, so its coins earn no part of the holders' share until it opens one. Only that wallet can open it.`
* A sell by a wallet with coins held: `This wallet holds 900 raw units of the coin. 500 of them are locked until slot 245994, so it can sell at most 400 now.` (or the creator lock's date)

On a coin without a holders' share the two record notes leave out the words about the share.

A buy of 0.05 SOL in the early window, asked of `/quote` with `userPublicKey` of a wallet
that never traded the coin:

```json
{
  "outAmount": "23408746743331",
  "exact": true,
  "hook": {
    "program": "3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr",
    "template": "rules",
    "kind": "platform",
    "runsOnBuys": true,
    "runsOnSells": true,
    "rules": {
      "creatorBps": 50,
      "holdersBps": 100,
      "burnBps": 50,
      "sniperEndsAtSlot": null,
      "buyLimit": null,
      "strict": {
        "maxWallet": "30000000000000",
        "maxWalletEndsAtSlot": 246044,
        "earlyEndsAtSlot": 245919,
        "earlyUnlockSlot": 245994,
        "wallet": {
          "address": "3Btahr46D9EmWqAy8cUjtqFpVPP7i6ju5Rv9qwjoxrUX",
          "balance": "0",
          "after": "23408746743331",
          "holderRecord": false,
          "opensHolderRecord": true,
          "locked": "23408746743331",
          "creatorLockedUntil": null
        }
      }
    }
  },
  "coin": { "tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }
}
```

The API opens a holder record only in front of a buy. As a call of its own it does not
open, claim, sync or close one, and it does not send a strict coin from one wallet to
another. The SDK builds those transactions.

**Launch guard** (`launch_guard`). For the first slots of a pool, buys pay a high pool fee
that falls every slot down to the normal one. `fees.pool.bps` is the fee at `slot`. The
quote is not exact while the guard runs: your trade lands a slot or two later and gives the
same amount or a little more. The notes say when the guard ends. Sells never pay it. Once
it is over the pool behaves like one without a hook.

**Collectible coin, plain** (`collectible`, `coin.collectible.kind` is `plain`).
* A buy earns pieces: one for every `unit` coins received, at most `maxPerBuy` per buy.
  Each piece is an NFT. The notes say how many this buy can earn.
* Pieces go to the wallet that signs. The first buy opens that wallet's ticket for the
  coin, a small account, and the wallet pays its rent once. The API adds this.
* The buy does not mint the pieces: a block two slots later decides how they look. The buy
  pays a deposit for their NFTs instead (`mint_deposit`), and a keeper mints them into the
  wallet a few seconds later, paid from that deposit. See "One approval". With
  `mintDeposit: false` a second transaction of the wallet mints them: the coin page sends
  it, the SDK builds it with `collectibleMintInstructions`. The API never puts a mint into
  a buy: if pieces wait from earlier buys, the notes say so.
* A ticket holds four unminted batches. When all four are full, a new buy earns no piece
  until its pieces are minted.
* A wallet keeps at most one piece per `unit` coins it holds, and at most 200. A sell burns
  the pieces the remaining coins no longer back, the last piece of the wallet's list first.
  The sell built by the API burns them in the same transaction (`settle`), up to six. The
  notes say how many pieces a sell burns. The rent of each burned piece comes back to the
  wallet. A sell right after a buy may meet the keeper: if the keeper mints the waiting
  pieces before the sell lands, the sell burns those new NFTs too (it names their
  addresses), and their rent comes back, but not Metaplex Core's fee of 0.0015 SOL each.
* The hook takes no fee and never runs on a sell. The quote is exact.

**Collectible coin, pegged** (`coin.collectible.kind` is `pegged`). All of the above, and:
* The coin is a Token-2022 coin whose own transfer hook is the collectible program. That
  program runs inside every transfer of the coin, a sell included, so `hook.runsOnSells` is
  `true`.
* A sell burns its pieces inside the swap. The transaction then burns their NFTs (`reap`),
  up to six.
* Fewer wallets and apps handle such coins. Through this API they trade like any other.
* A plain transfer of the coin to a wallet that never bought it here burns the piece. That
  is outside this API. The site's docs page explains it.

**Custom hook** (`custom`, `hook.kind` is `frozen`). A hook written by someone else. Nobody
can change its code; its settings may change if its code allows it. The notes name what it
can do.
* Where it can change the amounts of a trade (it runs before the swap in that direction
  and may take a fee, replace the pool fee or set the price), `/quote` answers
  `exact: false` and assumes it takes nothing.
* `/swap` then asks the chain. It simulates the trade once with no floor, and the
  `quote` in its answer carries the real `outAmount` and a `minOutAmount` taken from it
  with your `slippageBps`. A note says that these come from a simulation. One call to
  `/swap` is enough. `exact` stays `false`: the hook may answer differently when your
  transaction lands, and `minOutAmount` covers you.
* When you send your own `minOutAmount`, the server still asks the chain. The `quote` in
  the answer carries the real `outAmount`, and your floor stays as you sent it. If the
  hook already takes more than your floor allows, the call answers `SLIPPAGE_EXCEEDED`
  instead of a transaction that would fail.
* Where the pool does not call the hook, or calls it only after the swap, the quote is
  exact. A hook that runs after the swap can still refuse a trade, and the notes say so.

**A coin on the curve** (`curve.state` is `open` or `graduated`). Every kind of coin above
can launch on the curve, except a pegged collectible coin. Such a launch needs no SOL from
its creator: the whole supply goes into the pool, which prices trades as if it held some SOL
that is not there, the virtual SOL (30 SOL with the platform's defaults). The pool pays a sell
from its real SOL only. Once it holds its graduation target of real SOL (85 SOL by default),
`graduate` drops the virtual SOL and burns coins from the pool, so that the price stays where
it is. From then on it is an ordinary pool, at the same address.
* The quote counts the virtual SOL. `priceBefore` and `priceAfter` are `(real SOL + virtual
  SOL) / coins in the pool`, and `outAmount` is what the pool pays on that price. `curve` says
  where the pool stands: the virtual SOL, the real SOL raised, the target, the share of the
  target raised and the share of the supply sold. The notes say it in words.
* A buy that takes the pool to its target is quoted on the curve, and the transaction ends
  with `graduate`, right after the swap: `curve.graduates` is `true`, `curve.graduateFirst` is
  `false`, and `computeUnitLimit` is 25000 higher.
* A trade on a pool that already stands at or past its target, a buy or a sell, graduates the
  pool FIRST: `curve.graduateFirst` is `true`, `graduate` comes right before the swap, and the
  trade is quoted on the pool as graduation leaves it, without the virtual SOL and with the
  coins burned that keep the price. Anyone may graduate such a pool at any moment. Whoever does
  it first, your trade runs on the graduated pool, so the quote is exact, and `priceBefore` is
  the price right after graduation, which is the price of the pool now.
* The floor is always `outAmount` less your slippage. Nothing lowers it, and a `minOutAmount`
  you send goes into the swap as you sent it. A `graduate` that comes after somebody else's
  lands and changes nothing, so it never fails your trade.
* A sell can never take more than the real SOL in the pool. The coins that left the pool can
  always be sold back, so no wallet meets this, but a larger sell is answered
  `CURVE_REAL_RESERVE` with the largest sell the pool pays (see "Errors").
* Liquidity opens at graduation: the pool refuses deposits and removals before it. The API has
  no liquidity call.
* After graduation `curve.state` is `graduated`, the virtual SOL and the target are `0`, and a
  trade is quoted like any pool of its kind. The notes say nothing about the curve.

A buy of 90 SOL on a fresh pool on the curve, 0.5 SOL raised, which graduates it. These are
the parts of the quote that differ from the example at the top:

```json
{
  "outAmount": "732697864639810",
  "minOutAmount": "725370885993411",
  "priceBefore": "0.0000000309968846",
  "priceAfter": "0.000000478743351",
  "curve": { "state": "open", "virtualQuote": "30000000000", "raised": "501744987", "target": "85000000000", "raisedBps": 59, "soldBps": 159, "graduates": true, "graduateFirst": false },
  "exact": true,
  "notes": [
    "This coin trades on the curve. Its price counts 30 SOL of virtual SOL that the pool does not hold.",
    "The pool holds 0.501744987 SOL of real SOL. It graduates at 85 SOL.",
    "This trade takes the pool to its graduation target, so the transaction ends with graduate.",
    "Graduation drops the virtual SOL and burns coins from the pool, so the price stays where it is. Liquidity opens after it."
  ]
}
```

A buy of 1 SOL on a pool that stands past its target, 86.999999999 SOL raised. The quote is
the graduated pool's, and the transaction sends `graduate` right before the swap:

```json
{
  "outAmount": "2157011251981",
  "minOutAmount": "2135441139461",
  "priceBefore": "0.000000452906999",
  "priceAfter": "0.000000463304879",
  "curve": { "state": "open", "virtualQuote": "30000000000", "raised": "86999999999", "target": "85000000000", "raisedBps": 10000, "soldBps": 7416, "graduates": true, "graduateFirst": true },
  "exact": true,
  "notes": [
    "This coin trades on the curve. Its price counts 30 SOL of virtual SOL that the pool does not hold.",
    "The pool holds 86.999999999 SOL of real SOL. It graduates at 85 SOL.",
    "The pool stands past its graduation target, so this transaction graduates it before the trade. The trade runs on the graduated pool, whoever graduates it first, and this quote is that pool's.",
    "Graduation drops the virtual SOL and burns coins from the pool, so the price stays where it is. Liquidity opens after it."
  ]
}
```

A sell on a pool under its target adds `A sell is paid from the real SOL only.` to the second
note. A `/swap` answer that sends `graduate` adds `The transaction sends graduate right
after the swap. Its compute limit is 25000 units higher for it.`, or "right before the swap".

## What the API does not do

* It does not sign, send or track transactions. It has no private key and takes none.
* It does not mint the pieces of a collectible buy. Its buy pays the deposit for them and a
  keeper mints them; with `mintDeposit: false` the wallet mints them in a second transaction.
* It does not move pieces, reorder them or send coins between wallets.
* It does not launch coins, add or remove liquidity, run buybacks or burns, or collect fees.
* It does not graduate a coin on the curve by itself. The trade that takes a pool to its
  target carries `graduate`, and the watcher graduates a pool that a trade built elsewhere
  left past its target.
* On a rules coin it does not stake, unstake, claim or lock. On a strict coin it opens the signer's holder record in front of a buy, and does nothing else with holder records.
* It does not close token accounts or tickets.
* It trades coins against SOL only. It does not route through other pools or other
  exchanges, and it has no exact-output mode.
* It has no list of coins, no price history and no websocket.
* A quote is not an order. Nothing is reserved between the quote and your transaction.

## Review requests of Custom hooks

A developer who wants a hook of their own listed under Custom hooks asks Programmable to
review it. The request page of the site calls the routes below. The review fee is 25 USD,
paid in SOL to the Programmable treasury in the same step. The fee pays for the review
whatever its outcome. A changed program is a new request with a new fee.

The conventions above hold, with one difference: amounts here are JSON numbers, not strings.
Every one of them is far below 2^53. Errors carry the same `{ "error": { "code", "message" } }`
shape. Only the owner's command line on the server changes a status. When the store holds
10,000 requests, a quote and a request answer 503 `REVIEWS_FULL`. While another process
writes the store for more than two seconds, a change answers 503 `BUSY`.

| Route | Limit per address |
|---|---|
| `GET /api/v1/hook-reviews/price` | 60 a minute |
| `POST /api/v1/hook-reviews/quote` | 10 a minute |
| `POST /api/v1/hook-reviews` | 10 a minute |
| `GET /api/v1/hook-reviews/<id>` | 60 a minute |
| `POST /api/v1/hook-reviews/<id>/program` | 10 a minute |
| `GET /api/v1/hooks/approved` | 60 a minute |

### GET /api/v1/hook-reviews/price

```
{ "usd": 25, "solUsd": 150.25, "lamports": 166390000, "treasury": "<base58>",
  "source": "coingecko", "at": "2026-10-24T12:00:00.000Z" }
```

`solUsd` is the price of one SOL in USD. It comes from CoinGecko's simple price endpoint, and
from Jupiter's price API when CoinGecko fails. Each source has 4 seconds. A price outside 1 to
10,000 USD is refused. The price is kept 60 seconds; `at` says when it was read and `source`
which source gave it (`fixed` on a local test chain with `REVIEW_SOL_USD`). `lamports` is
`usd` at that price, rounded up to a whole 1,000 lamports. `treasury` is the treasury of the
platform account, read from the chain. Both sources down: 503 `PRICE_UNAVAILABLE`.

### POST /api/v1/hook-reviews/quote

Body: `{ "wallet": "<base58>" }`, the wallet that will pay.

```
{ "id": "3f9a0c1b2d4e5f60", "wallet": "<base58>", "lamports": 166390000, "usd": 25,
  "solUsd": 150.25, "treasury": "<base58>", "memo": "programmable-review:3f9a0c1b2d4e5f60",
  "expiresAt": "2026-10-24T12:30:00.000Z" }
```

The quote binds the wallet and the amount for 30 minutes, and it is used once. Pay it with one
transaction signed by that wallet that holds:

1. a System Program transfer of at least `lamports` from `wallet` to `treasury`, and
2. an instruction of the SPL Memo program (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`, or
   version 1 `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`) whose data is exactly `memo`.

Both must be instructions of the transaction itself, not calls made by another program.

### POST /api/v1/hook-reviews

Body: `{ "id", "signature", "name", "repo", "commit", "description", "contact" }`. `id` is the
quote's id and `signature` the payment's transaction signature.

| Field | What it must be |
|---|---|
| `name` | 1 to 32 printable ASCII characters. |
| `repo` | The https address of a public repository on github.com, gitlab.com or codeberg.org: `https://github.com/<owner>/<repo>`, an optional `.git`, at most 200 characters. Nothing is ever fetched from it. |
| `commit` | The full commit id: exactly 40 characters of `0` to `9` and `a` to `f`. |
| `description` | What the hook does, 1 to 2,000 characters. Line breaks stay. |
| `contact` | How Programmable reaches you, 3 to 120 characters. It is never shown on the site. |

Control characters are taken out of every text field first. Unknown fields are refused. The
checks run in this order, each with its own code:

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_PARAMETER` | `id` is not 16 characters of hex. `parameter` names the field. |
| 409 | `QUOTE_USED` | The quote was used for a request already, with another payment. |
| 404 | `QUOTE_NOT_FOUND` | No quote has this id. |
| 400 | `INVALID_PARAMETER` | A field above is wrong, or `signature` is not 64 bytes of base58. |
| 409 | `SIGNATURE_USED` | This payment paid for another request already. |
| 409 | `NOT_CONFIRMED_YET` | The RPC does not have the transaction yet. Send the same request again after `Retry-After` (6 seconds). |
| 410 | `QUOTE_EXPIRED` | The payment's block time is more than 120 seconds after `expiresAt`, or the quote ended more than 3.5 minutes ago and no payment is on chain. |
| 422 | `PAYMENT_UNREADABLE` | The RPC's answer cannot be read as a transaction. |
| 422 | `TRANSACTION_FAILED` | The transaction failed on chain. |
| 422 | `WRONG_WALLET` | The quote's wallet is neither the fee payer nor a signer. |
| 422 | `PAYMENT_MISSING` | No transfer from the wallet to the treasury. |
| 422 | `UNDERPAID` | The transfer is smaller than `lamports`. The error carries `paid` and `lamports`. |
| 422 | `MEMO_MISSING` | No memo instruction. |
| 422 | `MEMO_MISMATCH` | The memo is not the quote's memo. |
| 502 | `RPC_UNAVAILABLE` | The RPC did not answer. |

The transaction is read with `getTransaction(signature, { commitment: "confirmed",
maxSupportedTransactionVersion: 0 })`. On success the answer is 201 `{ "id", "status":
"waiting", "statusText" }`. The same request sent again with the same signature answers 200
and the same body, so a page that lost the first answer can ask again.

### GET /api/v1/hook-reviews/<id>

```
{ "id", "name", "repo", "commit", "status", "statusText", "note", "program", "report",
  "createdAt", "updatedAt", "paid": { "signature", "lamports" } }
```

The public view of a request. It never holds the contact or the description. `note` is the
reviewer's note (`""` when there is none), `program` the program id once given (else `null`),
`report` the link to the review report once there is one (an https address or a path on the
site, else `null`). An id nobody has: 404 `REQUEST_NOT_FOUND`.

| `status` | `statusText` |
|---|---|
| `waiting` | Paid. Waiting for a reviewer. |
| `in-review` | A reviewer is reading the code. |
| `changes-needed` | The code needs changes before it can pass. See the note. |
| `passed` | The code passed the review. Deploy exactly this commit, freeze it, then give the program id below. |
| `checking` | Programmable is checking the program on chain. |
| `approved` | Approved. The hook is on the approved list and appears under Custom hooks. |
| `rejected` | Not approved. See the note. |

### POST /api/v1/hook-reviews/<id>/program

Body: `{ "program": "<base58>", "signature": "<base58>" }`. Once the code passed, the
developer deploys exactly the reviewed commit, freezes it and gives its program id here.
`signature` is the request wallet's ed25519 signature (Phantom's `signMessage`) of the UTF-8
bytes of exactly:

```
Programmable hook review <id>: my program is <program>
```

Allowed while the status is `passed` or `checking`. The answer is `{ "id", "status":
"checking", "statusText", "program" }`. Giving another program while `checking` replaces it.
Refusals: 403 `SIGNATURE_INVALID` (not that wallet's signature of that text), 409
`WRONG_STATUS`, 400 `INVALID_PARAMETER` (including one of Programmable's own program ids),
404 `REQUEST_NOT_FOUND`.

### GET /api/v1/hooks/approved

```
{ "required": true, "programs": ["<base58>", ...], "corrupt": false }
```

The platform's approved list as the chain holds it, read at most every 30 seconds.
`required` is the rule: while it is on, a pool can open on an outside hook only when its
program is in `programs`. `corrupt` is true when the list after the platform account cannot
be read; the pool program then refuses every outside hook that needs the list. No platform
on the cluster: 503 `NOT_DEPLOYED`.

### The store and the owner's command line

The requests and the open quotes live in one JSON file, `REVIEWS_FILE`, by default
`state/hook-reviews.json` in the folder above `web/` (never inside `web/`, which is served).
At most 5,000 quotes are kept, the oldest dropped first, and a quote is dropped a day after it
ended. At most 10,000 requests are stored. A file that is not JSON is kept aside as
`<file>.bad-<time>` and the store starts empty.

The server and `scripts/hook-reviews.mjs` both write the file. Every change takes a lock file
next to it (`<file>.lock`; a lock older than 10 seconds was left by a process that died),
reads the file again, changes one thing, writes a temporary file and renames it over the
store. A change by the owner is seen by the server at its next read.

```
node scripts/hook-reviews.mjs list
node scripts/hook-reviews.mjs show <id>
node scripts/hook-reviews.mjs set <id> <status> [note words...]
node scripts/hook-reviews.mjs report <id> <https address or /path on the site>
node scripts/hook-reviews.mjs program <id> <program>
```

Run it as the user the site runs as, with the same `REVIEWS_FILE`. `set ... approved` sets the
status only: the program goes on the approved list on chain with the platform admin's
`approve_hook`.

| Variable | Meaning | Default |
|---|---|---|
| `REVIEWS_FILE` | The store. | `state/hook-reviews.json` next to `web/` |
| `REVIEW_FEE_USD` | The review fee in USD, 1 to 1000. | 25 |
| `REVIEW_SOL_USD` | A fixed SOL price for tests. Read on `localnet` only. | unset |
| `REVIEW_TELEGRAM_BOT_TOKEN`, `REVIEW_TELEGRAM_CHAT_ID` | Both set: one plain-text Telegram message to the owner's chat on a new paid request and on a program id given, with the name, repository, commit, id, wallet, SOL paid and contact. Unset: one line in the server's log, without the contact. The token is never logged. A failed message never fails a request. | unset |

## Running the API

The code is `web/api/_trade.js` and `web/api/_trade-core.js`. It runs in two places.

**Your own server.** `node web/serve.js` serves the site and the API on port 8787
(`PORT` changes it). Environment variables, all optional:

| Variable | Meaning | Default |
|---|---|---|
| `PROGRAMMABLE_RPC` | The RPC URL. Put a private one here. It is never returned and never logged. | `web/config.js` |
| `PROGRAMMABLE_CLUSTER` | `localnet`, `devnet` or `mainnet`. | `web/config.js` |
| `PROGRAMMABLE_LOOKUP_TABLE` | The platform's lookup table, or `none`. | `web/deployments/<cluster>-alt.json` |
| `PROGRAMMABLE_API_QUOTE_LIMIT` | Quote calls per IP per window. 0 turns the limit off. | 120 |
| `PROGRAMMABLE_API_SWAP_LIMIT` | Swap calls per IP per window. 0 turns the limit off. | 30 |
| `PROGRAMMABLE_API_WINDOW_SECONDS` | The length of the window. | 60 |
| `PROGRAMMABLE_API_MAX_CU_PRICE` | The highest priority fee accepted. | 5000000 |
| `PROGRAMMABLE_RPC_TIMEOUT_MS` | How long one RPC call may take. | 8000 |
| `PROGRAMMABLE_TRUST_PROXY` | `1`: count callers by the last entry of `X-Forwarded-For`. | off |

The limit is kept in memory and counts by the address of the socket. Behind a reverse
proxy every caller has the proxy's address, so set `PROGRAMMABLE_TRUST_PROXY=1` there, and only
there: without a proxy that header is whatever the caller writes.

Without the lookup table (`PROGRAMMABLE_LOOKUP_TABLE=none`, or no deployment file) every
trade still fits in one transaction except the largest: a sell of a pegged coin that
burns six pieces is 1078 bytes with the table and too large without it.

**Vercel.** `web/api/v1/quote.js` and `web/api/v1/swap.js` are the same handlers as
serverless functions. A deployment needs this on top:

* `web/api/_sdk.js` must exist. It is the SDK bundled for Node. Build it with
  `npm run build -w sdk` at the repository root before you deploy.
* Set `PROGRAMMABLE_RPC` in the project's environment. The address in `web/config.js` is a
  local one and means nothing there.
* `web/vercel.json` ships `web/deployments/` with the functions, so they find the lookup
  table. Or set `PROGRAMMABLE_LOOKUP_TABLE`.
* The rate limit is per function instance there. Instances come and go and each has its own
  counters, so the numbers above are not a real ceiling. Add a rate limit rule in the Vercel
  Firewall on `/api/v1/`, or keep the counters in a shared store. On Vercel callers are
  counted by `X-Real-IP`, which Vercel sets.

## Tests

```
node --test "web/api/_test/*.test.mjs"     # 114 unit tests, no chain needed
node scripts/e2e-api.mjs localnet           # every kind of pool on the local chain, real trades
node scripts/e2e-reviews.mjs localnet       # a review request paid and followed on the local chain
```

The review rehearsal starts its own server on a free port with `REVIEW_SOL_USD=150` and a
store in a temporary folder. A fresh wallet pays a real fee with its memo, sends the request,
and follows it through the owner's command line to `passed`, signs the program message and
reaches `checking`. On the way it has the chain show `UNDERPAID`, `MEMO_MISMATCH`,
`SIGNATURE_USED`, `QUOTE_USED` and `WRONG_STATUS`.

The second one starts its own server on a free port. It trades from throwaway wallets and
sells back what it bought. It launches a rules coin with a short sniper window and a short
buy limit, and a strict coin with a short max wallet, early window and early lock. It
trades inside the windows, has each refusal answered by the API and then by the chain, and
waits for the windows to end. It launches four coins on the curve: one it trades from its opening to past its target, where
the API's buy graduates it on chain at the price the API said, then trades on the graduated
pool; two it leaves past their target, where the API's transaction graduates the pool first,
and where somebody else graduates it between the API's answer and the landing, and both fill
the quote to the unit; and a strict coin on the curve, where the four refusals of a strict
coin are answered as on a seeded one. Every swap it inspects carries a floor at or above its
quote less the slippage. It runs for about six minutes.
