// The worked example of API.md as a runnable file: buy a Programmable coin with two HTTP calls,
// then sell it back the same way. It needs nothing of Programmable, only @solana/web3.js.
//   node scripts/api-example.mjs <API base URL> <coin mint> [lamports to spend]
//   node scripts/api-example.mjs http://localhost:8787 ATGcZdZWc42aXRXkMw9e1XkbDBHfLMCPLxdr8ShMN4oi 100000000
// Environment:
//   RPC_URL   the RPC the signed transaction is sent through. Default http://127.0.0.1:8899.
//   KEYPAIR   path of a Solana keypair file. Without it the script makes a new wallet and
//             asks the RPC for an airdrop, which works on a local chain and on devnet only.
// The private key never leaves this process: the API only ever sees the public key.
// It works for every kind of coin. Where a custom hook can change the amounts of a trade,
// the floor comes from the server's own simulation instead of from the quote. A rules coin
// may limit what one buy spends for its first slots: a buy above that limit stops here
// with BUY_LIMIT_EXCEEDED and the sentence the API answers, which says the limit. A strict
// coin checks its rules against the wallet: a buy above its max wallet, or a sell of coins
// its early lock or creator lock holds, stops here with the code and the sentence that say
// how much the wallet can trade now. The first buy of a strict coin also opens the wallet's
// holder record (open_holder), whose rent the wallet pays (129 bytes at the chain's rent:
// 1305560 lamports on mainnet, 1788720 on a local validator).
import { readFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";

const [api, mint, spend = "100000000"] = process.argv.slice(2);
if (!api || !mint) { console.error("usage: node scripts/api-example.mjs <API base URL> <coin mint> [lamports to spend]"); process.exit(1); }
const API = api.replace(/\/+$/, "");
const connection = new Connection(process.env.RPC_URL || "http://127.0.0.1:8899", "confirmed");

// ---- the wallet ----------------------------------------------------------------------------------
let wallet;
if (process.env.KEYPAIR) {
  wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR, "utf8"))));
} else {
  wallet = Keypair.generate();
  const sig = await connection.requestAirdrop(wallet.publicKey, 1 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, "confirmed");
}
console.log("wallet " + wallet.publicKey.toBase58());

// ---- the two calls --------------------------------------------------------------------------------
async function api_(path, init) {
  const res = await fetch(API + path, init);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error.code + ": " + json.error.message);
  return json;
}
const getQuote = (side, amount) => api_("/api/v1/quote?" + new URLSearchParams({ mint, side, amount, slippageBps: "100" }));
const getSwap = (side, amount, minOutAmount) => api_("/api/v1/swap", {
  method: "POST",
  headers: { "content-type": "application/json" },
  // minOutAmount pins the floor of the quote the user saw; simulate asks the chain first
  body: JSON.stringify({ mint, side, amount, minOutAmount, userPublicKey: wallet.publicKey.toBase58(), simulate: true }),
});

async function trade(side, amount) {
  // 1. the quote: show it to the user
  const quote = await getQuote(side, amount);
  console.log(`\n${side} ${quote.inAmount} of ${quote.inputMint}`);
  console.log(`  quote: ${quote.outAmount} out, at least ${quote.minOutAmount}, price impact ${quote.priceImpactPct}%, exact: ${quote.exact}`);
  for (const note of quote.notes) console.log("  note: " + note);

  // 2. the transaction, built on that quote. One case is different: a custom hook that can
  //    change the amounts (hook.template "custom" with exact false). The quote assumes that
  //    hook takes nothing, so its floor is a guess. Leave minOutAmount out there: the server
  //    simulates the trade and takes the floor from what the chain really gives.
  const guess = !!quote.hook && quote.hook.template === "custom" && !quote.exact;
  const swap = await getSwap(side, amount, guess ? undefined : quote.minOutAmount);
  if (guess) console.log(`  the server simulated the trade: ${swap.quote.outAmount} out, at least ${swap.quote.minOutAmount}`);
  for (const note of swap.notes.slice(quote.notes.length)) console.log("  note: " + note);
  console.log(`  simulated: ${swap.simulation.outAmount} out, ${swap.simulation.unitsConsumed} compute units`);

  // 3. sign and send it yourself
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.transaction, "base64"));
  tx.sign([wallet]);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const result = await connection.confirmTransaction({ signature, blockhash: swap.blockhash, lastValidBlockHeight: swap.lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error("the transaction failed: " + JSON.stringify(result.value.err));
  console.log("  confirmed " + signature);
}

async function coinBalance() {
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
  return accounts.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

try {
  await trade("buy", spend);
  const coins = await coinBalance();
  console.log("  the wallet now holds " + coins + " units of the coin");
  await trade("sell", coins.toString());
  console.log("  the wallet now holds " + (await coinBalance()) + " units of the coin and " + (await connection.getBalance(wallet.publicKey)) + " lamports");
} catch (e) {
  console.error("stopped: " + e.message);
  process.exit(1);
}
