// Review tool: coins for a measurement, made on the local validator only.
//   node web/review/make-pools.mjs <site origin> [count] [trades]
//   node web/review/make-pools.mjs http://localhost:8787 30 0     30 plain curve coins, no trades
//   node web/review/make-pools.mjs http://localhost:8787 1 240    one busy coin with 240 trades
//   node web/review/make-pools.mjs http://localhost:8787 0 240 <pool>   240 more trades on a coin made before
// Every coin is a curve launch with no hook and a first buy of 0.05 SOL. Its metadata address
// is a JSON file the site already serves (package.json), so the cards draw their monogram. With
// `trades`, two throwaway wallets then buy and sell on the last coin, small amounts, until it
// has that many trades. The wallets are made here, funded by airdrop and never written down.
// It prints one line per coin: the symbol and the pool address. Nothing is stopped or deployed.
import { readFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { HookpoolClient, DIRECTION, NATIVE_MINT } from "../../sdk/dist/index.js";

const [origin, countArg = "30", tradesArg = "0", onPool = ""] = process.argv.slice(2);
if (!origin) { console.error("usage: node web/review/make-pools.mjs <site origin> [count] [trades]"); process.exit(1); }
const RPC = "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const alt = JSON.parse(readFileSync(new URL("../deployments/localnet-alt.json", import.meta.url), "utf8")).lookupTable;
const client = new HookpoolClient(conn, { lookupTable: new PublicKey(alt) });
const SUPPLY = 1_000_000_000n * 1_000_000n;
const count = Math.max(0, Number(countArg)), trades = Math.max(0, Number(tradesArg));
const fund = async (kp, sol) => { for (let left = sol; left > 0; left -= 50) await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, Math.min(50, left) * LAMPORTS_PER_SOL), "confirmed"); };
async function send(payer, ixs, extra = []) {
  const { tx, blockhash, lastValidBlockHeight } = await client.buildTx(payer.publicKey, ixs);
  tx.sign([payer, ...extra]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (r.value.err) throw new Error("transaction failed: " + JSON.stringify(r.value.err));
  return sig;
}

const run = String(Math.floor(Math.random() * 9000) + 1000);
const dev = Keypair.generate();
if (count > 0) await fund(dev, Math.max(2, Math.ceil(count * 0.1) + 1));
const made = [];
for (let i = 0; i < count; i++) {
  const symbol = "M" + run.slice(0, 3) + String(i).padStart(2, "0");
  const mint = Keypair.generate();
  const plan = await client.launchInstructions({
    dev: dev.publicKey, mint, name: "Measure " + run + " " + i, symbol, uri: origin + "/package.json?coin=" + symbol.toLowerCase(), decimals: 6, totalSupply: SUPPLY,
    quoteMint: NATIVE_MINT, lpFeeBps: 100, devBuyQuote: 50_000_000n, minDevBuyOut: 0n, curve: true, template: "none",
  });
  await send(dev, plan.createTx, plan.signers);
  await send(dev, plan.launchTx);
  made.push({ symbol, pool: plan.pool });
  console.log(symbol + "  " + plan.pool.toBase58());
}
if (onPool) made.push({ symbol: "the coin", pool: new PublicKey(onPool) });
if (trades > 0 && made.length) {
  const target = made[made.length - 1];
  const a = Keypair.generate(), b = Keypair.generate();
  await Promise.all([fund(a, 30), fund(b, 30)]);
  let done = 0;
  for (let i = 0; done < trades; i++) {
    const who = i % 2 ? b : a;
    const pool = await client.pool(target.pool);
    const hook = await client.hookRef(pool, who.publicKey);
    // a buy of 0.02 SOL, and every third trade a sell of half of what the wallet holds
    if (i % 3 === 2) {
      const held = await client.tokenBalance(who.publicKey, pool.baseMint, pool.baseTokenProgram);
      if (held > 0n) { await send(who, await client.swapInstructions(who.publicKey, pool, hook, DIRECTION.SELL, held / 2n, 0n)); done++; continue; }
    }
    await send(who, await client.swapInstructions(who.publicKey, pool, hook, DIRECTION.BUY, 20_000_000n, 0n));
    done++;
    if (done % 40 === 0) console.log("  " + done + " trades on " + target.symbol);
  }
  console.log(target.symbol + " has " + done + " more trades: " + target.pool.toBase58());
}
console.log("pools on the chain now: " + (await client.allPools()).length);
