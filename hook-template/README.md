# The hook kit: write, test, freeze and launch your own hook

A hook is a Solana program that a Programmable pool calls at fixed points of a trade. The pool
asks, the hook answers, and the pool carries out the answer inside limits the hook cannot
move. This folder is a complete hook you can copy, with the scripts that build it, test
it against the real pool, deploy it frozen, and the path to a coin launched on it.

The program in `programs/my_hook` takes a fixed fee from every buy and sell, in the quote
token (wrapped SOL in every example here). Two more hooks, built with this same kit, are
in `examples/hooks/`: one changes the pool's own fee, one keeps an account per trader.

`HOOKS.md` at the root of the repository is the specification. This page is the practice.

## The contract in one screen

* The pool calls your program by CPI with five fixed accounts (the pool, the caller PDA
  the pool program keeps for your hook, the trader, the quote mint, the coin's mint) and
  then the extra accounts your hook listed. All five are read-only. Only the caller PDA
  signs. It is one address per hook program: `["caller", your program id]` under the pool
  program. The pool never signs a call to your hook with the address of another hook.
* Your hook answers `before_swap` through return data (`HookReturn`): a fee for a
  treasury, another pool fee for this one trade, or nothing. Every answer is checked
  against the flags your hook declared and against the platform's caps.
* A hook that fails makes the whole trade fail. That is its power to refuse, and it only
  has it on the trades it is called for: a hook without the `CALL_ON_SELL` flag is never
  called on a sell and can never block one.
* **The pool takes a hook only when its program is frozen**: no upgrade authority, for
  ever. That is checked on chain when a pool is created.
* **On mainnet, Programmable reviews every outside hook before it can be used.** The pool
  program keeps an approved list, and while its rule is on, a frozen hook that is not on
  the list cannot open a pool. Programmable approves one frozen program, the verified build
  of the commit it reviewed. A change is a new program and a new review. "Release on
  mainnet" below has the steps.
* The trader never signs for your hook. It cannot spend from the trader's wallet and
  cannot create an account in the trader's name.

## What is in this folder

```
hook-template/
  README.md
  Anchor.toml  Cargo.toml  Cargo.lock
  hook.json                        the descriptor: what sites show about this hook
  programs/my_hook/src/lib.rs      the hook: manifest, per-pool config, callbacks
  tests/                           tests against the real pool program, in process
  scripts/build.sh                 build as SBPF v0
  scripts/test.sh                  build, then run the tests
  scripts/deploy-freeze.sh         build, deploy, publish the manifest, freeze
  scripts/freeze.sh                freeze a deployed hook (on mainnet: after the verified build)
  scripts/publish-manifest.mjs     the step of the deploy that runs in Node
  scripts/rename.sh                give the program its own name
  scripts/env.sh                   shared setup, read by the other scripts
```

## What you need

Linux, or WSL on Windows. Everything below runs in that one shell.

* Rust (the tests are built with your normal toolchain; 1.89 or newer)
* the Solana command line tools (Agave) 4.3, installed with the Solana installer
* Anchor 1.2.0 (`avm install 1.2.0`)
* Node 22 or newer, and the repository's packages: run `npm install` once at the root of
  the repository. The scripts under `scripts/` at the root, the proof scripts of the
  examples, and one step of the deploy script use them.
* The SDK built: if the folder `sdk/dist` is missing, run `npm run sdk` at the root.

The scripts use the newest Solana release they find under
`~/.local/share/solana/install/releases`, whatever your `PATH` says, because
`anchor build` changes which release the installer's "active" link points at. Set
`SOLANA_BIN=<folder with the solana binary>` to choose yourself.

## Run Programmable locally

Programmable is not deployed on devnet or on mainnet. Until it is, the only chain that has
the pool program is a local validator you start yourself. **A hook frozen on devnet or
mainnet today can be used by no pool, and the SOL that pays its rent is gone.** The
deploy script checks this and stops before it sends anything.

From the root of the repository:

```
bash build.sh build
bash scripts/localnet.sh up
node scripts/init-platform.mjs localnet
```

The first command builds the pool, the launchpad and the platform's own hooks. The second
starts a validator at `http://127.0.0.1:8899` with those programs already on it, at their
real addresses. The third creates the platform account, registers the platform's hooks
and creates the address lookup table. You do not need to bring any key: `up` creates a
throwaway deployer keypair in `~/sol-secrets` the first time, and the third command reads
it from there, so run both as the same user in the same kind of shell.
`bash scripts/localnet.sh stop` stops that validator; the next `up` starts an empty chain.

## From zero to a coin on your hook

Copy the folder next to this one, so every relative path keeps working, and give the
program a name:

```
cp -r hook-template my-hook
cd my-hook
bash scripts/rename.sh fee_split
```

Change `programs/fee_split/src/lib.rs`, then:

```
bash scripts/test.sh
WALLET=~/my-wallet.json bash scripts/deploy-freeze.sh localnet
```

`WALLET` is a keypair file that holds a little over the rent of the program (about 1.6 SOL
for this template). On the local validator you can make and fund one like this:

```
solana-keygen new --no-bip39-passphrase -o ~/my-wallet.json
solana airdrop 10 $(solana-keygen pubkey ~/my-wallet.json) -u http://127.0.0.1:8899 -k ~/my-wallet.json
```

The deploy script prints the program id. For the template as it ships, this launches a
coin on it and trades (from the root of the repository; it needs no key of yours):

```
node scripts/e2e-custom.mjs localnet <program id>
```

For a hook you changed, copy that script and change the part that builds the hook's own
instructions; the section "Launch a coin on your hook" below explains it.

## Building, and where the output goes

`bash scripts/build.sh` builds the program as SBPF v0 (`anchor build --arch v0`).

* The build output does not go into this folder. It goes to `~/targets/<name of this
  folder>`, about 1 GB. Set `HOOK_TARGET_DIR=<folder>` to put it somewhere else (a
  relative path is taken from the hook's folder). The scripts never use a build folder
  inherited from your shell (`CARGO_TARGET_DIR`).
* **The program id is the public key of `<build folder>/deploy/<program>-keypair.json`.**
  The first build creates that file. Every build writes the id into `declare_id!` in
  `src/lib.rs` and into `Anchor.toml` first, so the binary and its address always agree.
  Keep the file until the program is frozen; after that nobody needs it. Delete it and
  the next build is a new program with a new id.
* The build folder remembers which project it belongs to. If you copy your hook to a
  second folder with the same name, the copy refuses to build into the first one's output
  (it would deploy over it) and tells you to set `HOOK_TARGET_DIR`.
* The build also writes the IDL to `<build folder>/idl/<program>.json`.

## Test before you freeze

The pool refuses a hook that can still be upgraded, and freezing cannot be undone. So
you cannot try a hook on a real pool first and fix it afterwards: every fix after the
freeze is a new program at a new address, with its rent paid again. Test in process.

```
bash scripts/test.sh
```

This builds the hook and runs `tests/tests/hook.rs`: the hook's binary is loaded next to
the real pool program in LiteSVM (no validator, no deploy), a pool is created with the
hook, and the test buys, sells, checks that the fee reached the treasury to the unit,
calls a callback directly to see it refused, tries a pool on an upgradeable hook, on a
missing config and on a stranger's config, and moves the fee as the config's owner. Five
tests, under a second once built. Pass a test name to run one.

What it relies on:

* The repository's own test harness, the crate in `tests/` at the root, which loads the
  pool's binaries from the repository's build. Run `bash build.sh build` at the root
  once before the first test run.
* `tests/Cargo.toml` finds the harness and the interface crate by relative path, so the
  hook has to sit inside the repository (or see "Outside the repository" below).
* The test build goes to `~/targets/programmable-hook-tests` (about 2 GB, shared by all your
  hook projects; `HOOK_TEST_TARGET_DIR` changes it). The first run compiles the pool's
  programs and the harness, which takes a few minutes; later runs take seconds.
* LiteSVM loads every program without an upgrade authority. The test writes one into the
  program's data account before it publishes the manifest, and removes it again to
  "freeze": the same two states a real deploy goes through.

The test code names the hook `hook` (see the first dependency in `tests/Cargo.toml`), so
it does not change when you rename the program.

## Describe your hook: hook.json

The chain says what a hook MAY do: its flags. It cannot say what the hook does. For that
a hook has a descriptor, a small JSON file its author writes and hosts. The hook's
manifest links to it (`HOOK_URI`, see "Deploy and freeze"). The reference site reads it
and then shows the hook in its Custom hooks pages with a name, a summary and its rules, and offers
the hook's own settings on the launch form. `hook.json` in this folder is the descriptor
of the template. The "List your hook" page of the reference site builds one in a form.

Nobody checks a descriptor against the code. A site shows it as the author's words, next
to what the chain allows. A hook without a descriptor still works and is still listed,
from chain facts alone.

```json
{
  "programmable_hook": 1,
  "program": "6fbrMagH6iTQ1o1ktfr2KbkTrKdHK7kPUVhxuUnB4XFu",
  "name": "Fixed fee",
  "summary": "Takes a fixed share of every buy and every sell, in SOL, for a wallet the launcher names.",
  "rules": ["Every buy and every sell pays the fee the launcher set.", "..."],
  "source": "https://example.com/hook-template/programs/my_hook/src/lib.rs",
  "author": "The hook kit",
  "setup": {
    "instruction": "init_pool_config",
    "args": [
      { "name": "pool", "type": "pool" },
      { "name": "fee_bps", "type": "u16", "label": "Fee on every trade", "unit": "%", "decimals": 2, "min": 0, "max": 10, "default": 2.5, "help": "..." },
      { "name": "max_bps", "type": "u16", "label": "Ceiling", "unit": "%", "decimals": 2, "min": 0, "max": 10, "default": 5, "help": "..." }
    ],
    "accounts": [
      { "role": "launcher" },
      { "role": "launcher" },
      { "role": "pda", "seeds": ["cfg", { "key": "pool" }], "writable": true },
      { "role": "system_program" }
    ]
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `programmable_hook` | yes | the version of this format. It is `1` |
| `program` | yes | the hook's program id. A site refuses a descriptor that names another program than the one whose manifest led to it |
| `name` | yes | at most 48 characters |
| `summary` | yes | one or two sentences, at most 280 characters |
| `rules` | yes | 1 to 12 sentences in your own words, each at most 200 characters. Write what the hook does and what can still change after the freeze |
| `source` | no | an https link to the code, at most 200 characters |
| `author` | no | a name or an address, at most 80 characters |
| `setup` | no | how to build the instruction that creates your per-pool settings. Leave it out when the hook has none |

A site reads fields it knows and ignores others at the top level. Inside `setup` an
unknown field makes the whole descriptor invalid, because `setup` becomes an instruction
that a launcher signs. The file may be at most 16,384 bytes.

**`setup.instruction`** is the Anchor name of the instruction, in snake_case. The site
sends `sha256("global:<name>")`, the first 8 bytes, then the arguments in borsh, in the
order you list them.

**`setup.args`**, at most 12. Each has a `name` (the one in your Rust code) and a `type`:

| `type` | What the site sends |
|---|---|
| `pool`, `launcher`, `base_mint`, `quote_mint` | 32 bytes: the address of the pool that will exist, of the launching wallet, of the new coin's mint, of the quote token's mint. The site fills them in. They take no other field |
| `u8`, `u16`, `u32`, `u64`, `i64` | a number the launcher types |
| `bool` | yes or no, chosen by the launcher |
| `pubkey` | an address the launcher types. With `"default": "launcher"` an empty field means the launching wallet |

An argument the launcher chooses needs a `label`, and may have a `unit`, a `help`
sentence, `min`, `max` and `default`. With `decimals` (0 to 12) the launcher types a
decimal number and the site sends it times ten to that power: `"unit": "%", "decimals": 2`
turns a typed 2.5 into 250. `min`, `max` and `default` are in what the launcher types.
Write a number that needs more than 15 digits as a string. A site cannot check one
argument against another, for example a fee against its ceiling. Your program refuses
such a launch, the site sees that in its simulation, and shows your error message.

**`setup.accounts`**, at most 12, in the order of your accounts struct, each by `role`:

| `role` | The account |
|---|---|
| `launcher` | the launching wallet, as signer and payer. List it once for each place your struct takes it |
| `pda` | an account of YOUR program at `seeds`: 1 to 4 seeds, each a text of 1 to 32 bytes or `{ "key": "pool" }` (also `launcher`, `base_mint`, `quote_mint`). `"writable": true` when the instruction writes to it |
| `system_program`, `token_program`, `token_2022_program` | those programs |
| `pool`, `base_mint`, `quote_mint` | read-only. The pool does not exist yet when the setup runs |

There is no role for another address, another signer or a token account, and a site
refuses a descriptor that asks for one. The reason is the launcher: your setup runs with
the launcher's signature, and a program can take SOL from a wallet that signs for it.
So the reference site simulates the first launch transaction with and without your setup
before the launcher's wallet opens. It refuses a setup that takes more than the rent of
the accounts it creates plus 0.001 SOL, or more than 0.05 SOL in all, that changes an
account which is not one of its own `pda` accounts, or that changes the owner of the
launcher's account. It also ends the transaction with a check that fails on chain when
the wallet holds less than the simulation showed. A hook whose setup needs more than
that is launched with the SDK, not through the site's form.

**Hosting.** The site loads a descriptor only when the link in the manifest is an https
address that ends in `.json` (on a local chain also `http://localhost`). The host must
let other sites read the file. The link is written into the manifest once, so host the
file at an address that will not change.

**The pin.** The manifest holds the address of the file. With the address alone you
could put another text there later, and a site says so under your rules: "The author
can still change this text, and the code cannot change either way." To rule that out,
the link may end with `#s=` and a pin of 22 characters:

```
https://example.com/h/fee.json#s=xQoBW-tOeLo3wmm3cBp4pQ
```

The pin is the first 16 bytes of the SHA-256 of the file's bytes, written in base64url
without padding. A site hashes the bytes it fetched and refuses the descriptor when its
pin is another one. Under your rules it then says that the description is pinned. The
manifest is written once, so the pin of a hook never changes. This is the only way to
write a pin. Any other ending after `#` is not a pin, and a site reads such a link as
an address without one.

What a pin is worth. It proves that the file is the one you pinned. It is not a
signature, and it says nothing about the code: nobody checks your words against your
program. The pin has 128 bits because the whole link has 128 bytes. Nobody can make
another file for a pin that somebody else chose. An author who prepares two files with
the same pin before deploying needs about 2^64 tries, which a large budget can pay for,
and could later swap between those two texts and no others.

* `deploy-freeze.sh` does it for you. When `HOOK_URI` carries no pin and the script can
  read the hosted file, it adds the pin of that file and prints the link it writes.
  When `HOOK_URI` carries a pin, the hosted file has to match it, or the script stops.
* A manifest's link holds 128 bytes and the pin takes 25, so **an address of at most
  103 bytes can be pinned**. That is room for a raw file in a code repository and for
  the address a blob store gives. When the link with its pin is too long, the script
  stops before it builds and says by how many bytes. `DESCRIPTOR_PIN=no` deploys with
  the address alone.
* The pin is over the bytes of the file. A host that reformats JSON, or a file saved
  again with other line endings, breaks it. Host the file, then let the script read it.
* When the script cannot read the address from your machine it only warns, and it adds
  no pin. Pass the pinned link yourself. The "List your hook" page of the reference site
  reads your address and writes it. This command prints the pin of a file:

```
openssl dgst -sha256 -binary hook.json | head -c 16 | base64 | tr '+/' '-_' | tr -d '='
```

**The program id in it.** The id exists after the first build (`bash scripts/build.sh`
prints it). `deploy-freeze.sh` writes it into the `hook.json` of this folder, as the
build does with `declare_id!`, and reads the hosted file before it sends anything: when
that file names another program the script stops.

## Deploy and freeze

```
WALLET=~/my-wallet.json bash scripts/deploy-freeze.sh localnet
```

The cluster is `localnet` when you name none. `devnet` stops at once, because the pool
program is not there. `mainnet` works differently: it deploys the verifiable build you give
it and stops before the freeze ("Release on mainnet" below). What the script does:

1. Checks, before anything is built or sent: the wallet file exists, Node finds
   `@solana/web3.js`, the cluster answers, and the pool program is on it. When `HOOK_URI`
   is the address of a `.json` file, it reads that file and stops if it is not a
   descriptor of this program, or not the file the link pins. It adds the pin when the
   link has none ("The pin" above). It also stops when the link ends with `#` and
   something that is not a pin. A file it cannot reach from your machine only gets a
   warning.
2. Builds the hook (so a stale binary is never deployed).
3. Deploys it with your wallet as upgrade authority.
4. Calls the hook's `init_manifest(name, uri)`, which creates the manifest and the
   extra-accounts list. Only the upgrade authority may call it, so it must happen
   between the deploy and the freeze.
5. Removes the upgrade authority (`solana program set-upgrade-authority --final`) and
   checks that it is gone.

Settings, all through the environment:

| Variable | Meaning |
|---|---|
| `WALLET` | keypair file that pays and holds the upgrade authority until the freeze. Default `~/.config/solana/id.json` |
| `HOOK_NAME` | name written into the manifest, at most 32 bytes. Default: the program's name |
| `HOOK_URI` | the address of your hosted `hook.json`, with or without its pin. The link written into the manifest holds at most 128 bytes, so an address that is to be pinned has at most 103. Any other link works too and is shown as a plain link, without rules and without a settings form |
| `DESCRIPTOR_PIN` | `no` writes the address without the pin of the file. Sites then say that the author can still change the text |
| `DESCRIPTOR_CHECK` | `no` skips the reading of the file at `HOOK_URI`, and with it the pin the script would add. A pin you wrote yourself is still checked for its form |
| `FREEZE` | `ask` (default): asks on the terminal before step 5, and without a terminal stops before it. `yes`: freezes without asking. `no`: stops before step 5 (the default on mainnet, where `yes` is refused) |
| `SO_FILE` | deploy this program file instead of building one. Required on mainnet: the file `solana-verify build` wrote |

Running it again is safe. A program that is deployed but not frozen is deployed again in
place and then frozen; a manifest that exists is left alone; a frozen program is reported
as frozen and nothing is sent.

During the deploy the Solana tools print a 12-word phrase. It belongs to a temporary
account of that one deploy and only matters if the deploy is cut off halfway.

**What freezing does.** After step 5 the program's CODE can never change, and the program
can never be closed: the SOL that pays its rent does not come back. For this template
that was 1.618 SOL in all on the local validator, of which 1.612 is the rent of the
program's 231,472 bytes. Before the freeze, `solana program close` still returns the
program's rent. The pool refuses a hook that is not frozen, so every fix after this step
is a new deploy under a new program id.

**What freezing does not do.** The accounts the program owns can still change in every
way its code allows: per-pool configs, per-trader accounts, and the manifest and the
extra-accounts list too if you wrote an instruction that rewrites them. The pool copies
the manifest's flags once, when a pool is created, so a changed manifest only affects
pools created afterwards. The extra-accounts list is read again on every trade, so a
hook that rewrites its list changes all of its pools at once. This template has no such
instruction; what it does leave open is the fee, which the owner of a pool's config can
move between zero and the ceiling fixed when the config was created.

## Launch a coin on your hook

The launchpad creates the coin, its pool on your hook and the locked liquidity.

On the reference site, open the launch form, pick "Custom hook" and paste the program
id. With a `hook.json` behind your manifest the form shows your settings and builds your
setup instruction. The first coin lists your hook in the site's Custom hooks pages. Nobody
approves it.

With the SDK of this repository (`sdk/dist/index.js`; it is not published on npm):

```js
import { HookpoolClient, NATIVE_MINT, pda } from "../sdk/dist/index.js";

const client = new HookpoolClient(connection);
const mint = Keypair.generate();
const pool = pda.pool(mint.publicKey, NATIVE_MINT);     // known before the pool exists

const plan = await client.launchInstructions({
  dev: dev.publicKey, mint, name: "My Coin", symbol: "MINE", uri: "https://example.com/mine.json",
  decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
  quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: 2_000_000_000n,
  devBuyQuote: 0n, minDevBuyOut: 0n,
  template: "custom",
  custom: {
    program: hookProgramId,
    setup: [initPoolConfigInstruction],     // your hook's own instructions for this pool
    treasuryOwner: someWallet,              // optional: who receives the hook's fee
  },
});
// plan = { createTx, launchTx, pool, signers }
// `send` stands for your own function that puts instructions in a transaction, signs
// with the given keypairs and waits for it (scripts/e2e-custom.mjs has one).
await send(plan.createTx, [dev, ...plan.signers]);      // transaction 1
await send(plan.launchTx, [dev]);                        // transaction 2
```

* `createTx` and `launchTx` are lists of instructions for two transactions, in that order.
  The first creates the coin and runs your `setup` instructions; `plan.signers` (the mint
  keypair) signs it with the launching wallet. The second creates the pool and makes the
  dev buy.
* **The first transaction is not undone when the second is refused.** A coin whose
  launch failed stays created and paid for. So the SDK refuses, before it builds
  anything, a hook that has not published its manifest and list, that can still be
  upgraded, or that declares `OVERRIDE_CURVE` (the launchpad takes no hook that owns the
  price).
* `setup` holds the instructions that must run before the pool exists: your per-pool
  config. The SDK knows nothing about your hook's instructions, so you build them
  yourself. `scripts/e2e-custom.mjs` does it for this template by hand, in about ten
  lines; `examples/hooks/*/client.mjs` are two more.
* `treasuryOwner` matters only for a hook with `TAKE_HOOK_FEE`: the fee goes to that
  wallet's token account for the quote token, which the first transaction creates. The
  default is the launching wallet.
* Afterwards `client.hookRef(pool, trader)` resolves your extra accounts from the list
  on chain for any trader, `client.quoteOnChain(...)` simulates a trade and returns what
  it would pay out with your hook's answer included, and `client.swapInstructions(...)`
  builds the trade. `client.hookInfo(pool)` describes the hook: `template: "custom"`,
  the flags, the manifest, and `upgradeAuthority: null` for a frozen program.
* `eventsFromTransaction(tx, programIds)` decodes the pool's events from a confirmed
  transaction. Its second argument is required: the base58 ids of the programs whose
  events you want, for example `Object.values(PROGRAMS).map((k) => k.toBase58())`.

What people see about a pool on your hook comes from its flags. For this template the
SDK's `describeFlags` says: "Runs on buys and sells. Can take a fee in the quote token to
its treasury, up to the platform cap." The reference site's trade API marks its quotes
for such a pool as not exact and simulates the trade before it builds one.

## Writing the hook: what the pool does and what it leaves to you

**Check the caller, first, in every callback.** The first line of every callback is

```rust
verify_caller(&ctx.accounts.hook_caller.to_account_info(), &crate::ID)?;
```

It proves that the pool program is calling, and that it is calling YOUR hook. Without it
anyone can call your callbacks directly with made-up numbers. The second argument is
your own program id, and it is not optional. The pool signs with one address per hook
program, `["caller", hook program id]` under the pool program, and `verify_caller`
accepts only the address of the id you pass. The reason is a rule of the runtime: a
program that is called with a signer may pass that signer on in a call of its own. If
the pool signed every callback with one address, any hook the pool calls could call your
callback itself, with the pool's signature attached and a payload of its choosing. With
an address per hook, the signature another hook receives is worth nothing to yours.

`tests/tests/hook.rs` shows two refusals: a wallet signing in the caller's place
(`CallerMismatch`), and the caller's real address without its signature
(`AccountNotSigner`). `examples/hooks/loyalty-points` tests the third: another hook that
passes the pool's signature on is refused with `CallerMismatch`.

`verify_caller` does not prove which pool the call is about. A callback that writes
state for a pool should take what it can from the Pool account (account 0, which only the
pool program writes; `PoolData::read`) and not from the payload alone. The template's
`on_pool_create` reads the pool's creator there.

**Flags are powers, fixed per pool.** `HOOKS.md` section 5 lists them. This template
uses `BEFORE_SWAP | ON_POOL_CREATE | TAKE_HOOK_FEE | CALL_ON_BUY | CALL_ON_SELL`. An
answer that uses a power the flags do not grant fails the trade (`HookPowerNotGranted`).
A manifest with a flag bit the pool does not know is refused (`UnknownFlags`).
The liquidity flags work the same way. A hook that declares `BEFORE_ADD_LIQ` is called
when somebody adds liquidity, receives its extra accounts there too, and refuses the
deposit by failing. People read that as a sentence on every coin of the hook.

**The treasury is chosen by the pool's creator, not by you.** Whoever creates the pool
names the token account that receives the hook's fee (with the SDK: `custom.treasuryOwner`,
by default the launcher). The author of the hook gets nothing by default. If you want a
share, read `pool.hook_treasury_owner` in `on_pool_create` and refuse pools that pay
somebody else. A hook WITHOUT `TAKE_HOOK_FEE` gets the all-zero key as its treasury: if
you remove that flag, remove the `NoTreasury` check from `on_pool_create` too, or it
refuses every pool.

**The fee is not a share of what the trader sends.** On a buy the pool takes its protocol
fee first and your fee from what is left; on a sell your fee comes out of what the curve
pays, in the quote token. Every fee is rounded up. A fee above the platform's cap
(10% on a chain set up by `init-platform.mjs`) is cut down to the cap, not refused.
When the treasury account does not exist at the moment of a trade, the trade goes
through and the fee waits in the pool until the account is back.

**Per-pool configuration.** The pattern here: an account at `["cfg", pool]` under your
program, created by the launcher before the pool exists (the pool's address is
`["pool", coin mint, quote mint]` under the pool program, so it is known in advance), and
listed as your first extra account.

* A hook with a per-pool config must declare `ON_POOL_CREATE`. Without it the pool is
  created without calling your program at all: a pool with no config trades into an
  error, and whoever creates the config first owns its settings.
* Record who paid for the config and require that key to equal `payload.creator` in
  `on_pool_create`, and the `creator` written in the Pool account (`PoolData::read`), as
  the template does. The payload is what the caller says. The Pool account is what the
  pool program did. A pool then cannot start on parameters a stranger wrote.
* That check does not stop a stranger from creating the config first. The launch then
  fails, and because the address is taken, that coin can never launch on your hook. The
  SDK creates the coin and the config in one transaction, which leaves no time for it;
  do not make a mint address public before its config exists.

**Extra accounts.** Your hook lists them once, in `init_manifest`.

* Never mark one as a signer. The pool never passes an extra account as a signer.
* The space of the list account is `extra_metas_size(n)` for exactly `n` entries. Change
  both together.
* An entry's seeds are packed into 32 bytes: a literal costs its length plus 2, an
  account named by its position (0 the pool, 2 the trader, 3 the quote mint, 4 the
  coin's mint) costs 2. `per_pool_config_meta(seed, writable)` builds `[seed, pool]`,
  `per_user_meta(seed, writable)` builds `[seed, pool, trader]`.
* The pool derives each address from your list on every call and refuses the trade
  (`HookExtraAccounts`) when the client did not pass that account. Your hook receives
  exactly the listed accounts, in your order, whatever order the client used and however
  many more it passed. An account you listed as writable must be passed writable.
* The pool does not check that an extra account exists. One that the trader has to open
  first (the hook cannot create it: it has no signature of the trader) arrives as an
  empty account until then. Declare it `UncheckedAccount` and check its owner by hand.
  `examples/hooks/loyalty-points` does exactly this.
* On a trade your hook is not called for, clients need to pass none of them.

**Small facts that cost an hour each.**

* In `on_pool_create`, account 2 (`user`) and `payload.creator` are both the wallet that
  creates the pool; through the launchpad, the wallet that launches the coin. The Pool
  account is already written, reserves included.
* `PoolCreatePayload` has no slot. Use `Clock::get()` or `PoolData::created_slot`.
* Only `before_swap` answers. Return data from any other callback is ignored. Return
  data that is not a `HookReturn` of version 1 fails the trade with `BadHookReturn`.
  No return data at all means "no opinion".
* A fee override of 0 is accepted: that trade pays the pool nothing.
* In a trade your callback runs at call level 2 (pool, hook); in a launch at level 3
  (launchpad, pool, hook). The runtime allows 5, so a callback has room for calls of its
  own, and none of them may go back into the pool.
* Compute, measured on a local validator (Agave 4.3.0) with this template frozen on it:
  the pool's swap instruction used 29,100 to 29,200 units on a pool without a hook, and
  45,400 to 48,600 on five pools of this template, of which the template's callback was
  7,100. The spread between pools comes from addresses: on every call the pool derives
  the caller address of your program and the address of each extra account, and
  `verify_caller` derives the caller address once more, about 1,500 units for every try
  a derivation needs. The SDK asks for 250,000 per trade and 400,000 per launch. Three
  launches on this template with a dev buy used 220,500 to 229,500 in their second
  transaction, the one that creates the pool. A validator counts about 30% fewer units
  than the in-process tests for the same instructions. `HOOKS.md`, sections 4.1 and 12,
  has the in-process figures.
* Return data is at most 1,024 bytes. `HookReturn` is a handful.

**Error numbers collide; read names.** Anchor numbers every program's errors from 6000.
So do the pool, the launchpad and the interface crate: number 6001 alone could be the
pool's `NotAdmin` or the interface crate's `CallerMismatch`. The template starts its own
at 7000 (`#[error_code(offset = 7000)]`), so its numbers cannot be mistaken for theirs,
and `WrongCreator` shows in the logs as `Error Number: 7005`. Clients should still match
the error NAME and the program that failed.

## Renaming `my_hook`

`bash scripts/rename.sh <new_name>` changes every place the name is written. By hand,
they are:

| Place | What |
|---|---|
| `programs/my_hook/` | the folder |
| `programs/my_hook/Cargo.toml` | `name` under `[package]` and `name` under `[lib]` |
| `programs/my_hook/src/lib.rs` | `pub mod my_hook` under `#[program]` |
| `Anchor.toml` | the line under `[programs.localnet]` |
| `tests/Cargo.toml` | the `hook = { package = "my_hook", path = "../programs/my_hook", ... }` line |

The scripts need no change: they take the name from the one folder under `programs/`.
The names in comments and the error enum (`MyHookError`) are yours to change or keep.

## Outside the repository

A hook can live in a folder of its own. Three things then need the repository:

* **The interface crate.** It is not on crates.io. Copy `crates/hookpool-interface` from
  the repository into your project as `vendor/hookpool-interface`, and in your root
  `Cargo.toml` write `hookpool-interface = { path = "vendor/hookpool-interface" }`. That
  one line is the whole change: the crate names its own dependency versions. A copy is
  tied to the pool program id it declares, and to the pool it was copied with. The crate
  holds the address the pool signs callbacks with. A hook built with a copy from before
  that address became one per hook program compiles, deploys and freezes. Then the first
  call of today's pool to it fails with `CallerMismatch`: no pool can be created on it,
  and its rent is spent. Take the copy from the same version of the repository as the
  pool you deploy next to.
* **The deploy script.** One of its steps runs in Node and needs `@solana/web3.js`. Run
  `npm install @solana/web3.js` in your project's folder. The script checks this before
  it deploys.
* **The tests, the launch and the SDK.** They need a checkout of the repository, built.
  In `tests/Cargo.toml` point `hookpool-tests` at `<checkout>/tests` and
  `hookpool-interface` at `<checkout>/crates/hookpool-interface`, and point the hook's
  own `hookpool-interface` at that same folder while you test, not at the vendored copy:
  with two copies of the crate in one build cargo stops with "package collision in the
  lockfile".

## The two examples

`examples/hooks/early-bird` answers with a fee override instead of a hook fee, returns
nothing when it has no opinion, and writes its config from a callback.
`examples/hooks/loyalty-points` runs after the trade, takes nothing, and keeps an account
per trader that the trader opens. Each has its tests, its client code in JavaScript and
a script that launches a coin on it and proves the effect with numbers read from chain.
They are built, tested and deployed by the scripts of this folder.

## Release on mainnet

On mainnet a hook opens pools only once Programmable has reviewed it and put its program on
the approved list. Programmable approves the frozen program that is the verified build of
the commit it reviewed, and nothing else. The review rules, the fee and the request form are
on https://programmableonsol.com/review-hook.html. In short: you pay the Solana rent of your
program from your own wallet (this template needs about 1.2 SOL on mainnet), plus a review
fee of 25 USD in SOL, paid when you send the request.

1. **Finish and test locally.** `bash scripts/test.sh`, then deploy and freeze on your own
   local chain and launch a coin on it ("From zero to a coin on your hook").
2. **Fix the program id in the source.** `bash scripts/build.sh` creates the program keypair
   once and writes its id into `src/lib.rs` and `Anchor.toml`. Keep that keypair file
   until the program is frozen. Every later step uses this one id.
3. **Pin the Solana version** in the root `Cargo.toml` the way the verifiable build asks
   (https://solana.com/docs/programs/verified-builds), so that anyone rebuilds the same
   bytes.
4. **Commit and publish.** Push the hook to a public repository under a license that lets
   anyone read and build it. Note the full 40-character commit.
5. **Send the review request** on the review page with the repository and that commit, and
   pay the fee. Programmable reviews exactly that commit and answers through the contact you
   gave. Change nothing in the meantime: a new commit is a new request.
6. **Once the code has passed**, at that commit, with your wallet as the upgrade authority
   and as the Solana CLI's default keypair:

   ```
   solana-verify build --library-name my_hook
   SO_FILE=target/deploy/my_hook.so WALLET=<your wallet file> HOOK_URI=<your hook.json address> bash scripts/deploy-freeze.sh mainnet
   solana-verify verify-from-repo -u https://api.mainnet-beta.solana.com --program-id <program id> <repository url> --commit-hash <commit> --library-name my_hook
   solana-verify remote submit-job --program-id <program id> --uploader <your wallet address>
   ```

   The first line builds in Docker, the way anyone can repeat. The second deploys that file
   and publishes the manifest, and stops before the freeze. The third rebuilds from your
   repository, compares, and asks whether to upload the build record on chain: answer yes.
   Only the upgrade authority can upload it, which is why this comes before the freeze. The
   fourth asks the verification service to rebuild it too. Use your program's own name in
   place of `my_hook` when you renamed it.
7. **Freeze.** `WALLET=<your wallet file> bash scripts/freeze.sh mainnet`. It first
   reads https://verify.osec.io/status/<program id> and freezes only when the program is
   verified and the verified build is the program on chain.
8. **Give the program id** on your request page. Programmable checks on chain that the
   program is frozen and is the verified build of the reviewed commit, and puts it on the
   approved list. The hook then appears under Custom hooks with "Reviewed by Programmable",
   and anyone can launch a coin on it.

These scripts build SBPF v0 programs, and a cluster can refuse to deploy those (feature
`B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`; the local validator is started with it off).
`solana feature status -u https://api.mainnet-beta.solana.com` tells you whether mainnet does.
The verifiable build of step 6 chooses its own toolchain from the version you pinned.

What the review is and is not: Programmable reads the code at your commit against its
published rules and checks the program on chain. A review is not an audit and not a promise,
and the report says what was checked and what was not.
