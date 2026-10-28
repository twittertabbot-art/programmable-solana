// Measures the compute units of the swap instruction alone, per kind of pool, by simulation.
//   node jupiter-adapter/scripts/measure-cu.mjs <pool> [<pool> ...]
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, PROGRAMS } from "../../sdk/dist/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const client = new HookpoolClient(conn);
const user = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(user.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
for (const address of process.argv.slice(2)) {
  const pool = await client.pool(new PublicKey(address));
  const hook = await client.hookRef(pool, user.publicKey);
  // the swap alone: no `graduate` after it, even on a pool on the curve past its target
  const ixs = await client.swapInstructions(user.publicKey, pool, hook, DIRECTION.BUY, BigInt(0.1 * LAMPORTS_PER_SOL), 0n, { graduate: false });
  const tx = new Transaction().add(...ixs);
  tx.feePayer = user.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx, undefined, false);
  // the units of the pool program's own top-level invocation
  const line = (sim.value.logs || []).filter((l) => l.startsWith(`Program ${PROGRAMS.hookpool.toBase58()} consumed`)).pop();
  console.log(address, sim.value.err ? "FAILED " + JSON.stringify(sim.value.err) : line);
}
