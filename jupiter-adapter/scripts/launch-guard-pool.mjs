// Launches a coin on the launch guard hook with the longest guard window (about 72
// minutes), so that a parity fixture can be snapshotted while the buy fee is still falling.
//   node jupiter-adapter/scripts/launch-guard-pool.mjs localnet
import { Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { HookpoolClient, NATIVE_MINT } from "../../sdk/dist/index.js";
import { clusterArg, connection, deployer } from "../../scripts/cluster.mjs";

const cluster = clusterArg();
const conn = connection(cluster);
const dev = deployer(cluster);
const client = new HookpoolClient(conn);
const mint = Keypair.generate();
const plan = await client.launchInstructions({
  dev: dev.publicKey, mint, name: "Guard Parity Coin", symbol: "GPC", uri: "https://example.com/meta/gpc.json", decimals: 6, totalSupply: 1_000_000_000n * 1_000_000n,
  quoteMint: NATIVE_MINT, lpFeeBps: 100, quoteAmount: BigInt(20 * LAMPORTS_PER_SOL), devBuyQuote: 0n, minDevBuyOut: 0n,
  template: "launch_guard",
  guard: { guardSlots: 10_800n, startFeeBps: 5000 },
});
const send = async (ixs, signers) => {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
};
await send(plan.createTx, [dev, mint]);
await send(plan.launchTx, [dev]);
const slot = await conn.getSlot("confirmed");
console.log(`guard pool ${plan.pool.toBase58()} base ${mint.publicKey.toBase58()} slot ${slot}`);
