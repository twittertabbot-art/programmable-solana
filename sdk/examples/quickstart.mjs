// The SDK in one file: launch a coin with a tax, quote, buy, sell, read the trades back;
// then launch a second coin on the curve (no SOL from the creator), buy it to graduation,
// and trade it afterwards.
// Runs against a local validator that has the programs and an initialised platform:
//
//   bash scripts/localnet.sh up                (in WSL or Linux, from the repository root)
//   node scripts/init-platform.mjs localnet
//   node sdk/examples/quickstart.mjs           (optional argument: an RPC URL)
//
// It makes a few throwaway wallets and asks the validator for airdrops (the curve part
// needs about 90 SOL of buys), so it works on a local validator only. Nothing here needs a
// private key of yours.
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { HookpoolClient, NATIVE_MINT, DIRECTION, PROGRAMS, eventsFromTransaction, isOnCurve, spotPrice } from "../dist/index.js";

const conn = new Connection(process.argv[2] ?? "http://127.0.0.1:8899", "confirmed");
const client = new HookpoolClient(conn);
const sol = (n) => BigInt(Math.round(n * LAMPORTS_PER_SOL));
const send = async (ixs, signers, label) => {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log("  sent  " + label);
  return sig;
};
const fund = async (wallet, amount) => conn.confirmTransaction(await conn.requestAirdrop(wallet.publicKey, Number(sol(amount))), "confirmed");

const platform = await client.platform();
if (!platform) throw new Error("no platform on this chain: run scripts/init-platform.mjs first");

// 1. Launch. Two transactions: the coin (and the hook's settings), then the pool.
const dev = Keypair.generate();
const mint = Keypair.generate();
await fund(dev, 5);
const plan = await client.launchInstructions({
  dev: dev.publicKey, mint,
  name: "Quickstart Coin", symbol: "QUICK", uri: "https://example.com/quick.json", decimals: 6,
  totalSupply: 1_000_000_000n * 1_000_000n,      // raw units: one billion coins at 6 decimals
  quoteMint: NATIVE_MINT,                        // the pool trades against SOL
  lpFeeBps: 100,                                 // the pool's own fee, 1%
  quoteAmount: sol(2),                           // SOL that seeds the pool, locked forever
  devBuyQuote: sol(0.1), minDevBuyOut: 1n,       // the dev's first buy, inside the launch
  template: "tax",
  tax: { buyBps: 300, sellBps: 500, maxBps: 1000 },   // 3% on buys, 5% on sells, never above 10%
});
await send(plan.createTx, [dev, ...plan.signers], "create the coin");
await send(plan.launchTx, [dev], "launch the pool");

// 2. Read it back.
const pool = await client.pool(plan.pool);
const hook = await client.hookInfo(pool);
console.log("pool " + pool.address.toBase58() + ", hook: " + hook.template + ". " + hook.summary.sentences.join(" "));
const launch = await client.launchForMint(mint.publicKey);
console.log("launch liquidity locked forever: " + launch.lpLocked + " LP units");

// 3. Quote and buy with another wallet.
const trader = Keypair.generate();
await fund(trader, 2);
const hookRef = await client.hookRef(pool, trader.publicKey);       // the hook's accounts for this wallet
const quote = await client.quoteLocal(pool, platform, DIRECTION.BUY, sol(0.5), hook);
const minOut = (quote.amountOut * 9900n) / 10000n;                   // 1% slippage
const buySig = await send(await client.swapInstructions(trader.publicKey, pool, hookRef, DIRECTION.BUY, sol(0.5), minOut), [trader], "buy for 0.5 SOL");
const coins = await client.tokenBalance(trader.publicKey, mint.publicKey);
console.log("quoted " + quote.amountOut + ", received " + coins + ", tax paid " + quote.hookFee + " lamports");
if (coins !== quote.amountOut) throw new Error("the quote was not exact");

// 4. The chain's own record of that trade.
const tx = await conn.getTransaction(buySig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
const swapped = eventsFromTransaction(tx, Object.values(PROGRAMS).map((p) => p.toBase58())).find((e) => e.kind === "Swapped");
console.log("event: in " + swapped.amountIn + ", out " + swapped.amountOut + ", pool fee " + swapped.lpFee + ", hook fee " + swapped.hookFee);

// 5. Sell it all back. The pool moved, so read it again before quoting.
const pool2 = await client.pool(plan.pool);
const sellQuote = await client.quoteLocal(pool2, platform, DIRECTION.SELL, coins, hook);
const before = await conn.getBalance(trader.publicKey);
await send(await client.swapInstructions(trader.publicKey, pool2, hookRef, DIRECTION.SELL, coins, sellQuote.amountOut), [trader], "sell everything");
console.log("sell quoted " + sellQuote.amountOut + " lamports, wallet moved by " + ((await conn.getBalance(trader.publicKey)) - before) + " (the quote minus the 5,000 lamport network fee)");

// 6. The dev takes the tax: it sits in the dev's wrapped SOL account, which stays open.
const waiting = await client.tokenBalance(dev.publicKey, NATIVE_MINT);
await send(client.unwrapInstructions(dev.publicKey), [dev], "the dev takes the tax");
console.log("the dev took " + waiting + " lamports of tax");

// 7. A launch on the curve: the creator puts no SOL in. The pool prices the coin as if it
//    held the platform's virtual SOL (30 by default), pays out real SOL only, and refuses
//    liquidity until it holds the graduation target of real SOL (85 by default).
if (!platform.curveEnabled) throw new Error("curve launches are switched off on this platform");
const dev2 = Keypair.generate();
const mint2 = Keypair.generate();
await fund(dev2, 1);                                                  // the launch fee and rents, nothing for the pool
const plan2 = await client.launchInstructions({
  dev: dev2.publicKey, mint: mint2,
  name: "Curve Coin", symbol: "CURVE", uri: "https://example.com/curve.json", decimals: 6,
  totalSupply: 1_000_000_000n * 1_000_000n,
  quoteMint: NATIVE_MINT, lpFeeBps: 100,
  curve: true,                                   // no quoteAmount: the curve stands in for it
  devBuyQuote: 0n, minDevBuyOut: 0n,
  template: "none",
});
await send(plan2.createTx, [dev2, ...plan2.signers], "create the curve coin");
await send(plan2.launchTx, [dev2], "open the curve");
let curvePool = await client.pool(plan2.pool);
let progress = await client.curveProgress(curvePool);
console.log("curve pool " + curvePool.address.toBase58() + ": on the curve " + isOnCurve(curvePool) + ", raised " + progress.raised + " of " + progress.target
  + " lamports, market cap " + progress.marketCapQuote + " lamports (" + plan2.curve.lpLocked + " LP units locked in the pool)");

// 8. Buyers take it to graduation. The quote says when a buy graduates the coin, and
//    swapInstructions then appends `graduate` to that buy: the virtual SOL is dropped and
//    enough coins are burned from the pool to keep the price.
const buyer = Keypair.generate();
await fund(buyer, 100);
const buyerRef = await client.hookRef(curvePool, buyer.publicKey);
for (;;) {
  curvePool = await client.pool(plan2.pool);
  const q = await client.quoteLocal(curvePool, platform, DIRECTION.BUY, sol(30), null);
  const priceBefore = spotPrice(curvePool, 6, 9);
  const sig = await send(await client.swapInstructions(buyer.publicKey, curvePool, buyerRef, DIRECTION.BUY, sol(30), q.amountOut), [buyer], "buy for 30 SOL" + (q.graduates ? " (this buy graduates the coin)" : ""));
  const after = await client.pool(plan2.pool);
  if (q.graduates) {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const g = eventsFromTransaction(tx, Object.values(PROGRAMS).map((p) => p.toBase58())).find((e) => e.kind === "Graduated");
    console.log("graduated: burned " + g.burnedBase + " units, fee " + g.feeQuote + " lamports; the pool holds " + after.reserveQuote + " lamports and " + after.reserveBase + " units");
    console.log("price before this buy " + priceBefore + ", after the buy and the graduation " + spotPrice(after, 6, 9) + " SOL per coin");
    if (isOnCurve(after)) throw new Error("the pool is still on the curve");
    break;
  }
  console.log("raised " + after.reserveQuote + " of " + after.graduationTarget + " lamports");
}

// 9. After graduation the pool is an ordinary pool: a buy is quoted with the real reserve
//    alone, and liquidity can be added.
curvePool = await client.pool(plan2.pool);
const q2 = await client.quoteLocal(curvePool, platform, DIRECTION.BUY, sol(1), null);
await send(await client.swapInstructions(buyer.publicKey, curvePool, buyerRef, DIRECTION.BUY, sol(1), q2.amountOut), [buyer], "buy for 1 SOL after graduation");
const held = await client.tokenBalance(buyer.publicKey, mint2.publicKey);
console.log("the buyer holds " + held + " units; the last buy was quoted " + q2.amountOut + " and graduates: " + q2.graduates);
console.log("quickstart passed");
