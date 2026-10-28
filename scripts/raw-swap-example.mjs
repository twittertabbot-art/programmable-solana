// Trade a pool with @solana/web3.js alone: no SDK, no HTTP API. This is the reference for
// INTEGRATORS.md: every address, offset and byte below is the one written there.
//
//   node scripts/raw-swap-example.mjs <rpc url> <coin mint> buy <lamports>
//   node scripts/raw-swap-example.mjs <rpc url> <coin mint> sell <raw coin units> --keypair <file>
//   node scripts/raw-swap-example.mjs <rpc url> <coin mint> roundtrip <lamports>     buy, then sell it all back
//   node scripts/raw-swap-example.mjs <rpc url> <coin mint> events                   the pool's latest swaps
//   node scripts/raw-swap-example.mjs <rpc url> <coin mint> collect                  pay the hook fees that wait
//   node scripts/raw-swap-example.mjs <rpc url> <coin mint> send <raw coin units> <receiver wallet> --keypair <file>
//                                                                                    a wallet-to-wallet transfer
//   node scripts/raw-swap-example.mjs <rpc url> <coin mint> graduate                 graduate a pool on the curve that
//                                                                                    stands at or past its target (below
//                                                                                    it, graduate does nothing)
//
// Without --keypair it makes a throwaway wallet and asks the cluster for an airdrop, which
// only works on a local validator or on devnet. It prints what it quoted and what the chain
// paid, and exits with an error when a quote it called exact was not.
//
// It quotes the five platform templates from their configs by hand: tax, buyback, launch
// guard, collectible and launch rules. Inside a launch guard window or the sniper window of
// a rules coin the fee of a buy falls with every slot, so the quote is "this amount or
// more". A pool on any other hook is quoted by simulation.
//
// It never opens a ticket, so on a collectible coin its buys earn no piece. The trade is the
// same either way (INTEGRATORS.md, "The kinds of coin").
//
// A pool launched on the curve (INTEGRATORS.md, "Pools on the curve") is quoted with its
// virtual quote, and a sell past its real SOL is refused here before anything is sent. On a
// pool that stands at or past its graduation target the trade carries `graduate` in front
// of it and is quoted on the pool as graduation leaves it; a buy that crosses the target
// carries `graduate` right after it. The minimum output is always the quote less the
// slippage. `graduate` sends the pool program's permissionless `graduate` alone and checks
// what it did.
//
// A strict coin (a Token-2022 coin whose transfer hook is the rules hook) needs three more
// accounts on every swap and on every send, opens the wallet's holder record before a buy in
// its early window, and is refused here before anything is sent when its rules would refuse
// the trade or the send on chain (INTEGRATORS.md, "The kinds of coin", "Strict coins").
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// ---- the addresses an integrator needs (INTEGRATORS.md, "Addresses") -------------------------
const HOOKPOOL = new PublicKey("7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh");
const HOOK = {
  tax: "jwdXDuSQ9pNV1pXj8BFvBb5fhqtTL3duQkwsTjXunhr",
  launch_guard: "G59xnMnbenifbGR1y6QjaTRa6wa1FFfqZB3KZBUyckPW",
  buyback: "3M824Hn8Z6S7r1t1zqpNQpioKFd31jrQwSN2oxV2ovo5",
  collectible: "3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m",
  rules: "3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr",
};
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

const POOL_DISC = [241, 154, 109, 4, 17, 177, 109, 188];          // sha256("account:Pool")[..8]
const SWAP_DISC = [248, 198, 158, 145, 225, 117, 135, 200];       // sha256("global:swap")[..8]
const COLLECT_HOOK_FEES_DISC = [161, 80, 95, 45, 41, 49, 96, 93]; // sha256("global:collect_hook_fees")[..8]
const SWAPPED_DISC = [217, 52, 52, 83, 147, 135, 96, 109];        // sha256("event:Swapped")[..8]
const EVENT_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]; // Anchor's event-CPI tag
const CALLBACK_LIST_DISC = [60, 167, 17, 250, 28, 149, 188, 66];  // key of a hook's extra-accounts list
const EXECUTE_DISC = [105, 37, 101, 197, 75, 251, 102, 26];       // sha256("spl-transfer-hook-interface:execute")[..8]
const OPEN_HOLDER_DISC = [138, 210, 211, 159, 140, 172, 28, 65];  // sha256("global:open_holder")[..8], rules hook
const HOOK_BUY_BURN_DISC = [8, 103, 173, 214, 106, 75, 167, 33];  // sha256("global:hook_buy_burn")[..8], pool program
const GRADUATE_DISC = [45, 235, 225, 181, 17, 218, 64, 130];       // sha256("global:graduate")[..8], pool program
const GRADUATED_DISC = [51, 241, 66, 50, 140, 245, 156, 192];      // sha256("event:Graduated")[..8]
const CURVE_OPEN = 1, CURVE_GRADUATED = 2;                         // pool offset 522; 0 is a seeded pool
const FLAG = { BEFORE_SWAP: 1 << 0, AFTER_SWAP: 1 << 1, CALL_ON_BUY: 1 << 12, CALL_ON_SELL: 1 << 13 };
const BUY = 0, SELL = 1;
/// Lamports of one signature: the network fee of the transactions sent here.
const SIGNATURE_FEE = 5000n;

const pdaOf = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
const ataOf = (owner, mint, tokenProgram) => pdaOf([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
const PLATFORM = pdaOf([Buffer.from("platform")], HOOKPOOL);
/// The hook caller: the address the pool signs its calls into a hook with. There is one per
/// hook program, derived from the hook program of the pool. A pool without a hook has the
/// system program in that field, so its caller is ["caller", 32 zero bytes].
const callerOf = (hookProgram) => pdaOf([Buffer.from("caller"), hookProgram.toBuffer()], HOOKPOOL);
const EVENT_AUTHORITY = pdaOf([Buffer.from("__event_authority")], HOOKPOOL);
/// The pool of a coin against SOL.
const poolOf = (coinMint) => pdaOf([Buffer.from("pool"), coinMint.toBuffer(), WSOL.toBuffer()], HOOKPOOL);

// ---- account layouts (INTEGRATORS.md, "The pool account and the platform account") ------------
const key = (d, at) => new PublicKey(d.subarray(at, at + 32));
function decodePool(d) {
  if (d.length !== 528 || !POOL_DISC.every((b, i) => d[i] === b)) throw new Error("not a pool account");
  return {
    baseMint: key(d, 9), quoteMint: key(d, 41), baseVault: key(d, 73), quoteVault: key(d, 105),
    baseTokenProgram: key(d, 201), quoteTokenProgram: key(d, 233), lpFeeBps: d.readUInt16LE(265),
    hookProgram: key(d, 267), hookFlags: d.readUInt32LE(299), hookExtraMetas: key(d, 303), hookQuoteTreasury: key(d, 335),
    hookKind: d[367], reserveBase: d.readBigUInt64LE(368), reserveQuote: d.readBigUInt64LE(376),
    // hook fees that wait for a treasury account that does not exist, and the wallet that account belongs to
    hookFeesOwed: d.readBigUInt64LE(464), hookTreasuryOwner: key(d, 472),
    // the curve: the quote counted in the price and not held, the real quote at which the pool
    // graduates, the platform's share at graduation, and the state (0 seeded, 1 on the curve, 2 graduated)
    virtualQuote: d.readBigUInt64LE(504), graduationTarget: d.readBigUInt64LE(512), graduationFeeBps: d.readUInt16LE(520), curveState: d[522],
  };
}
function decodePlatform(d) {
  return { protocolFeeBps: d.readUInt16LE(105), maxHookFeeBps: d.readUInt16LE(109), maxFeeOverrideBps: d.readUInt16LE(111), paused: d[121] !== 0 };
}
const hasHook = (pool) => !pool.hookProgram.equals(SystemProgram.programId);
/// Does the pool call the hook's `callback` on swaps in this direction?
const called = (pool, callback, isBuy) => hasHook(pool) && (pool.hookFlags & callback) !== 0 && (pool.hookFlags & (isBuy ? FLAG.CALL_ON_BUY : FLAG.CALL_ON_SELL)) !== 0;

// ---- the quote (INTEGRATORS.md, "Quoting") ---------------------------------------------------
const feeCeil = (amount, bps) => (bps === 0 || amount === 0n ? 0n : (amount * BigInt(bps) + 9999n) / 10000n);
function quoteSwap(pool, platform, isBuy, amountIn, hookFeeBps, feeOverrideBps) {
  // the quote side of the price: the real reserve, plus the virtual one while the pool is on the curve
  const quoteSide = pool.reserveQuote + pool.virtualQuote;
  const [rIn, rOut] = isBuy ? [quoteSide, pool.reserveBase] : [pool.reserveBase, quoteSide];
  const protocolFee = feeCeil(amountIn, platform.protocolFeeBps);
  let left = amountIn - protocolFee;
  const hookFeeIn = isBuy ? feeCeil(left, hookFeeBps) : 0n;
  left -= hookFeeIn;
  const lpFee = feeCeil(left, feeOverrideBps ?? pool.lpFeeBps);
  const netIn = left - lpFee;
  if (netIn <= 0n) throw new Error("the amount is too small: the fees take all of it");
  const gross = (rOut * netIn) / (rIn + netIn);
  if (gross <= 0n) throw new Error("the output rounds to zero: a dust trade, which the pool refuses with 6006");
  if (gross >= rOut) throw new Error("the output would take the whole reserve");
  // a sell is paid from the real SOL alone: the virtual quote is never paid out (6049)
  if (!isBuy && gross > pool.reserveQuote) throw new Error(`a sell of ${amountIn} would take ${gross} lamports and the pool holds ${pool.reserveQuote} real: it pays sells from real SOL only`);
  const hookFeeOut = isBuy ? 0n : feeCeil(gross, hookFeeBps);
  // the real reserves after the trade
  const reserveQuoteAfter = isBuy ? pool.reserveQuote + netIn + lpFee : pool.reserveQuote - gross;
  const reserveBaseAfter = isBuy ? pool.reserveBase - gross : pool.reserveBase + netIn + lpFee;
  return { out: gross - hookFeeOut, gross, protocolFee, lpFee, hookFee: hookFeeIn + hookFeeOut, reserveQuoteAfter, reserveBaseAfter };
}
/// What `graduate` leaves of a pool on the curve (INTEGRATORS.md, "graduate"): the fee for the
/// platform out of the real reserve, the virtual quote gone, and the coins that keep the price.
function graduation(pool) {
  const wanted = (pool.graduationTarget * BigInt(pool.graduationFeeBps)) / 10000n;
  const fee = wanted < pool.reserveQuote - 1n ? wanted : pool.reserveQuote - 1n;
  const reserveQuote = pool.reserveQuote - fee;
  const reserveBase = (reserveQuote * pool.reserveBase) / (pool.reserveQuote + pool.virtualQuote);
  return { fee, reserveQuote, reserveBase, burned: pool.reserveBase - reserveBase };
}
/// The pool as `graduate` would leave it: an ordinary pool at the same price.
const graduatedPool = (pool) => { const g = graduation(pool); return { ...pool, reserveQuote: g.reserveQuote, reserveBase: g.reserveBase, virtualQuote: 0n, graduationTarget: 0n, curveState: CURVE_GRADUATED }; };
const curveText = (pool) => pool.curveState === CURVE_OPEN ? `on the curve: raised ${pool.reserveQuote} of ${pool.graduationTarget} lamports, ${pool.virtualQuote} virtual`
  : pool.curveState === CURVE_GRADUATED ? "graduated" : "seeded";
/// The fee of a buy inside a launch window: a straight line from `startFee` in the slot the
/// pool was created to the pool's own fee `slots` later. null once the window is over, and
/// when the start fee is not above the pool's fee. The launch guard and the sniper fee of a
/// rules coin use the same line.
function windowFeeBps(slot, startSlot, slots, startFee, lpFeeBps) {
  const elapsed = BigInt(slot) > startSlot ? BigInt(slot) - startSlot : 0n;
  if (startFee <= lpFeeBps || slots === 0n || elapsed >= slots) return null;
  return startFee - Number((BigInt(startFee - lpFeeBps) * elapsed) / slots);
}
/// What the hook will answer in `before_swap`, for the five platform templates. A hook this
/// code does not know gives `exact: false`: simulate the swap to learn the real output.
async function hookAnswer(conn, poolKey, pool, platform, isBuy, amountIn, slot) {
  const answer = { hookFeeBps: 0, feeOverrideBps: null, exact: true };
  if (!called(pool, FLAG.BEFORE_SWAP, isBuy)) {
    // an unknown hook that only runs after the swap cannot change the amount, but it can refuse
    const known = !hasHook(pool) || Object.values(HOOK).includes(pool.hookProgram.toBase58());
    return { ...answer, exact: known || !called(pool, FLAG.AFTER_SWAP, isBuy) };
  }
  const id = pool.hookProgram.toBase58();
  const cfg = await conn.getAccountInfo(pdaOf([Buffer.from("cfg"), poolKey.toBuffer()], pool.hookProgram));
  if (id === HOOK.tax && cfg) {
    const bps = isBuy ? cfg.data.readUInt16LE(73) : cfg.data.readUInt16LE(75);
    return { ...answer, hookFeeBps: Math.min(bps, platform.maxHookFeeBps) };
  }
  if (id === HOOK.buyback && cfg) {
    const bps = isBuy ? cfg.data.readUInt16LE(138) : cfg.data.readUInt16LE(140);
    return { ...answer, hookFeeBps: Math.min(bps, platform.maxHookFeeBps) };
  }
  if (id === HOOK.launch_guard && cfg) {
    // buys only: a fee that replaces the pool fee and falls every slot until the window ends.
    // The chain uses the slot the transaction lands in, so a buy gets this amount or a little more.
    const start = cfg.data.readBigUInt64LE(41), slots = cfg.data.readBigUInt64LE(49), startFee = cfg.data.readUInt16LE(57);
    const fee = isBuy && start !== 0n ? windowFeeBps(slot, start, slots, startFee, pool.lpFeeBps) : null;
    if (fee === null) return answer;
    return { ...answer, feeOverrideBps: Math.min(fee, platform.maxFeeOverrideBps), exact: false, window: "launch guard" };
  }
  if (id === HOOK.rules && cfg) {
    // Launch rules. The hook fee is the sum of the three rates of the side (creator, holders,
    // burn), whoever is staked: buys at 180, sells at 186, three u16 each.
    const d = cfg.data, at = isBuy ? 180 : 186;
    const rates = d.readUInt16LE(at) + d.readUInt16LE(at + 2) + d.readUInt16LE(at + 4);
    const fees = { ...answer, hookFeeBps: Math.min(rates, platform.maxHookFeeBps) };
    if (!isBuy) return fees; // the two windows touch buys only
    const start = d.readBigUInt64LE(216);
    const elapsed = BigInt(slot) > start ? BigInt(slot) - start : 0n;
    // The buy limit: inside its window the hook refuses a buy that sends more than the limit
    // (error 6017 of the rules hook). Nothing is filled in part.
    const maxBuy = d.readBigUInt64LE(192), limitSlots = d.readBigUInt64LE(200);
    if (maxBuy > 0n && elapsed < limitSlots && amountIn > maxBuy)
      throw new Error(`this buy is above the coin's buy limit: at most ${maxBuy} lamports in one buy until slot ${start + limitSlots}`);
    // The sniper fee: replaces the pool fee and falls every slot until the window ends.
    const fee = windowFeeBps(slot, start, d.readBigUInt64LE(170), d.readUInt16LE(178), pool.lpFeeBps);
    if (fee === null) return fees;
    return { ...fees, feeOverrideBps: Math.min(fee, platform.maxFeeOverrideBps), exact: false, window: "sniper window" };
  }
  return { ...answer, exact: false };
}

// ---- the hook's extra accounts (INTEGRATORS.md, "Hook accounts") -----------------------------
/// Every hook publishes the accounts its callbacks need in one account, `pool.hookExtraMetas`,
/// in the format of Token-2022 transfer hooks. They follow the swap's seventeen fixed accounts.
async function hookExtraAccounts(conn, poolKey, pool, user) {
  if (!hasHook(pool)) return [];
  const info = await conn.getAccountInfo(pool.hookExtraMetas);
  if (!info) throw new Error("the hook's account list is missing");
  const d = info.data;
  let entries = [];
  for (let at = 0; at + 12 <= d.length; ) {
    const len = d.readUInt32LE(at + 8);
    if (CALLBACK_LIST_DISC.every((b, i) => d[at + i] === b)) {
      const count = d.readUInt32LE(at + 12);
      for (let i = 0; i < count; i++) entries.push(d.subarray(at + 16 + 35 * i, at + 16 + 35 * (i + 1)));
      break;
    }
    if (len === 0) break;
    at += 12 + len;
  }
  // An entry may point at the five accounts every callback gets, and at the entries before it.
  const known = [poolKey, callerOf(pool.hookProgram), user, pool.quoteMint, pool.baseMint];
  const metas = [];
  for (const e of entries) {
    const kind = e[0], config = e.subarray(1, 33), isWritable = e[34] !== 0;
    let pubkey;
    if (kind === 0) pubkey = new PublicKey(config);                       // a fixed address
    else {
      const program = kind === 1 ? pool.hookProgram : known[kind - 128];  // a PDA of the hook, or of account N
      const seeds = [];
      for (let i = 0; i < 32 && config[i] !== 0; ) {
        if (config[i] === 1) { const n = config[i + 1]; seeds.push(Buffer.from(config.subarray(i + 2, i + 2 + n))); i += 2 + n; }        // literal bytes
        else if (config[i] === 3) { seeds.push(known[config[i + 1]].toBuffer()); i += 2; }                                              // the key of account N
        else if (config[i] === 4) {                                                                                                     // bytes of account N's data
          const acc = await conn.getAccountInfo(known[config[i + 1]]);
          if (!acc) throw new Error("an account a hook seed reads does not exist");
          seeds.push(Buffer.from(acc.data.subarray(config[i + 2], config[i + 2] + config[i + 3]))); i += 4;
        } else throw new Error("this hook derives an account from the callback's instruction data: use the SDK");
      }
      pubkey = pdaOf(seeds, program);
    }
    known.push(pubkey);
    metas.push({ pubkey, isSigner: false, isWritable });
  }
  return metas;
}
/// A Token-2022 coin with a transfer hook runs that program inside every transfer, also the
/// one between the wallet and the pool. On this platform it is one of two: the collectible
/// hook (a "pegged" coin) or the rules hook (a "strict" coin). Three more accounts serve it.
function transferHookOf(mintData) {
  for (let at = 166; at + 4 <= mintData.length; ) {
    const type = mintData.readUInt16LE(at), len = mintData.readUInt16LE(at + 2);
    if (type === 0) break;
    if (type === 14 && len >= 64) { const p = key(mintData, at + 4 + 32); return p.equals(PublicKey.default) ? null : p; }
    at += 4 + len;
  }
  return null;
}
async function coinHookOf(conn, mint, tokenProgram) {
  if (!tokenProgram.equals(TOKEN_2022)) return null;
  const info = await conn.getAccountInfo(mint);
  return info ? transferHookOf(info.data) : null;
}
const holderOf = (poolKey, wallet) => pdaOf([Buffer.from("holder"), poolKey.toBuffer(), wallet.toBuffer()], new PublicKey(HOOK.rules));
const accountListOf = (mint, hook) => pdaOf([Buffer.from("extra-account-metas"), mint.toBuffer()], hook);
/// The accounts of the coin itself, after the hook's own accounts. `owner` is the wallet
/// that owns the coin account of the swap: the one paid on a buy, the one spent on a sell.
async function coinAccounts(conn, poolKey, pool, owner) {
  const hook = await coinHookOf(conn, pool.baseMint, pool.baseTokenProgram);
  if (!hook) return [];
  if (hook.equals(new PublicKey(HOOK.collectible))) return [
    rw(pdaOf([Buffer.from("ticket"), poolKey.toBuffer(), poolKey.toBuffer()], hook)),   // the pool's side of the transfer
    rw(pdaOf([Buffer.from("queue"), poolKey.toBuffer()], hook)),                         // the pool's burn queue
    ro(accountListOf(pool.baseMint, hook)),                                              // the coin's own account list
  ];
  if (hook.equals(new PublicKey(HOOK.rules))) return [
    // the rules config is already among the hook's accounts, writable
    rw(holderOf(poolKey, owner)),        // the wallet's holder record, whether it exists or not
    rw(holderOf(poolKey, poolKey)),      // the pool's side of the transfer: this record never exists
    ro(accountListOf(pool.baseMint, hook)),
  ];
  throw new Error("this coin's transfer hook is not one of the platform's");
}

// ---- a strict coin's rules (INTEGRATORS.md, "Strict coins") ---------------------------------
/// The windows of a strict coin, from the rules config. null for any other coin.
function strictOf(cfgData, slot) {
  if (!cfgData || cfgData.length < 414 || cfgData[374] !== 1) return null;
  const start = cfgData.readBigUInt64LE(216), elapsed = BigInt(slot) > start ? BigInt(slot) - start : 0n;
  const earlySlots = BigInt(cfgData.readUInt16LE(379)), maxWalletSlots = BigInt(cfgData.readUInt32LE(381)), unlockSlots = BigInt(cfgData.readUInt32LE(385));
  return {
    maxWalletRuns: elapsed < maxWalletSlots, maxWallet: cfgData.readBigUInt64LE(389), maxWalletEnds: start + maxWalletSlots,
    earlyRuns: elapsed < earlySlots, earlyLockRuns: elapsed < unlockSlots, earlyUnlock: start + unlockSlots,
  };
}
async function holderRecord(conn, poolKey, wallet) {
  const info = await conn.getAccountInfo(holderOf(poolKey, wallet));
  if (!info || info.data.length !== 129) return null;
  const d = info.data;
  return { balance: d.readBigUInt64LE(73), owed: d.readBigUInt64LE(97), earlyBought: d.readBigUInt64LE(105), locked: d.readBigUInt64LE(113), lockedUntil: d.readBigInt64LE(121) };
}
/// What the rules hook would refuse, before anything is sent. A sender left with `left`.
async function strictSenderCheck(conn, poolKey, st, wallet, left) {
  const rec = await holderRecord(conn, poolKey, wallet);
  if (!rec) return;
  if (st.earlyLockRuns && left < rec.earlyBought)
    throw new Error(`coins bought in the early window are locked until slot ${st.earlyUnlock}: this wallet must keep ${rec.earlyBought} (6045 EarlyLocked)`);
  if (rec.locked > 0n && BigInt(Math.floor(Date.now() / 1000)) < rec.lockedUntil && left < rec.locked)
    throw new Error(`the creator's coins are locked until ${new Date(Number(rec.lockedUntil) * 1000).toISOString()}: this wallet must keep ${rec.locked} (6046 CreatorLocked)`);
}
function strictReceiverCheck(st, after) {
  if (st.maxWalletRuns && after > st.maxWallet)
    throw new Error(`the receiving wallet would hold ${after}, above the coin's max wallet of ${st.maxWallet} until slot ${st.maxWalletEnds} (6044 MaxWallet)`);
}
const openHolder = (wallet, cfg, poolKey, walletBase) => new TransactionInstruction({
  programId: new PublicKey(HOOK.rules), data: Buffer.from(OPEN_HOLDER_DISC),
  keys: [{ pubkey: wallet, isSigner: true, isWritable: true }, rw(cfg), ro(poolKey), rw(holderOf(poolKey, wallet)), ro(walletBase), ro(SystemProgram.programId)],
});

// ---- a wallet-to-wallet transfer (INTEGRATORS.md, "Strict coins": a send) --------------------
/// The extra accounts of a Token-2022 transfer, resolved from the coin's account list the way
/// the SPL token libraries do it: the entries under the Execute key, each a fixed address or
/// an address derived from the transfer's accounts [source, mint, destination, owner, list,
/// then the entries before it]; then the hook program and the list itself. `pending` gives
/// the data of an account this transaction creates (the receiver's token account).
async function transferExtraAccounts(conn, hook, mint, source, destination, owner, amount, pending = new Map()) {
  const list = accountListOf(mint, hook);
  const info = await conn.getAccountInfo(list);
  if (!info) throw new Error("the coin's account list is missing");
  const d = info.data, entries = [];
  for (let at = 0; at + 12 <= d.length; ) {
    const len = d.readUInt32LE(at + 8);
    if (EXECUTE_DISC.every((b, i) => d[at + i] === b)) {
      const count = d.readUInt32LE(at + 12);
      for (let i = 0; i < count; i++) entries.push(d.subarray(at + 16 + 35 * i, at + 16 + 35 * (i + 1)));
      break;
    }
    if (len === 0) break;
    at += 12 + len;
  }
  const data = Buffer.alloc(16); Buffer.from(EXECUTE_DISC).copy(data, 0); data.writeBigUInt64LE(amount, 8);
  const accounts = [source, mint, destination, owner, list];
  const dataOf = async (k) => { const p = pending.get(k.toBase58()); if (p) return p; const a = await conn.getAccountInfo(k); if (!a) throw new Error("an account a seed reads does not exist: " + k.toBase58()); return a.data; };
  const metas = [];
  for (const e of entries) {
    const kind = e[0], config = e.subarray(1, 33), isWritable = e[34] !== 0;
    let pubkey;
    if (kind === 0) pubkey = new PublicKey(config);
    else {
      const seeds = [];
      for (let i = 0; i < 32 && config[i] !== 0; ) {
        if (config[i] === 1) { const n = config[i + 1]; seeds.push(Buffer.from(config.subarray(i + 2, i + 2 + n))); i += 2 + n; }      // literal bytes
        else if (config[i] === 2) { seeds.push(Buffer.from(data.subarray(config[i + 1], config[i + 1] + config[i + 2]))); i += 3; }   // bytes of the Execute data
        else if (config[i] === 3) { seeds.push(accounts[config[i + 1]].toBuffer()); i += 2; }                                         // the key of account N
        else if (config[i] === 4) { const b = await dataOf(accounts[config[i + 1]]); seeds.push(Buffer.from(b.subarray(config[i + 2], config[i + 2] + config[i + 3]))); i += 4; } // bytes of account N's data
        else throw new Error("a seed kind this example does not know: use the SPL token library");
      }
      pubkey = pdaOf(seeds, kind === 1 ? hook : accounts[kind - 128]);
    }
    accounts.push(pubkey);
    metas.push({ pubkey, isSigner: false, isWritable });
  }
  return [...metas, ro(hook), ro(list)];
}
async function send(conn, wallet, coinMint, amount, receiver) {
  const mintInfo = await conn.getAccountInfo(coinMint);
  if (!mintInfo) throw new Error("no such mint");
  const tokenProgram = mintInfo.owner, decimals = mintInfo.data[44];
  const owner = wallet.publicKey;
  const source = ataOf(owner, coinMint, tokenProgram), destination = ataOf(receiver, coinMint, tokenProgram);
  const hook = tokenProgram.equals(TOKEN_2022) ? transferHookOf(mintInfo.data) : null;
  const [held, receiverBefore, destInfo] = await Promise.all([tokenAmount(conn, source), tokenAmount(conn, destination), conn.getAccountInfo(destination)]);
  if (held < amount) throw new Error(`this wallet holds ${held} units, less than ${amount}`);
  let extra = [];
  if (hook) {
    if (hook.equals(new PublicKey(HOOK.rules))) {
      // a strict coin: refuse here what the hook would refuse on chain
      const poolKey = poolOf(coinMint);
      const cfg = await conn.getAccountInfo(pdaOf([Buffer.from("cfg"), poolKey.toBuffer()], hook));
      const st = strictOf(cfg && cfg.data, await conn.getSlot());
      if (st) { await strictSenderCheck(conn, poolKey, st, owner, held - amount); strictReceiverCheck(st, receiverBefore + amount); }
    }
    // The receiver's account is created in this same transaction: its owner, at bytes 32
    // to 64, is the receiver. That is all a seed reads from it.
    const pending = new Map();
    if (!destInfo) { const b = Buffer.alloc(165); coinMint.toBuffer().copy(b, 0); receiver.toBuffer().copy(b, 32); pending.set(destination.toBase58(), b); }
    extra = await transferExtraAccounts(conn, hook, coinMint, source, destination, owner, amount, pending);
  }
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = decimals; // TransferChecked
  const transfer = new TransactionInstruction({
    programId: tokenProgram, data,
    keys: [rw(source), ro(coinMint), rw(destination), { pubkey: owner, isSigner: true, isWritable: false }, ...extra],
  });
  // A strict coin is received only in the receiver's associated token account: create it first.
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), createAta(owner, receiver, coinMint, tokenProgram), transfer];
  const signature = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [wallet], { commitment: "confirmed" });
  const got = (await tokenAmount(conn, destination)) - receiverBefore;
  console.log(`send ${amount} units to ${receiver.toBase58()}  received ${got}  extra accounts ${extra.length}${hook ? " (transfer hook " + hook.toBase58().slice(0, 8) + ")" : ""}  ${signature.slice(0, 16)}`);
  if (got !== amount) throw new Error("the receiver did not get the amount sent");
}

// ---- the swap (INTEGRATORS.md, "The swap instruction") ---------------------------------------
const ro = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
function swapInstruction(poolKey, pool, user, userBase, userQuote, direction, amountIn, minOut, extra) {
  // The pool's treasury goes here whether or not that account exists. A pool whose hook
  // takes no fee has no treasury: any writable account stands in.
  const treasury = pool.hookQuoteTreasury.equals(PublicKey.default) ? userQuote : pool.hookQuoteTreasury;
  const keys = [
    { pubkey: user, isSigner: true, isWritable: false },   //  0 the wallet that may spend the input
    ro(PLATFORM),                                          //  1
    rw(poolKey),                                           //  2
    ro(pool.baseMint),                                     //  3 the coin
    ro(pool.quoteMint),                                    //  4 wrapped SOL
    rw(pool.baseVault),                                    //  5
    rw(pool.quoteVault),                                   //  6
    rw(userBase),                                          //  7 coin account: spent on a sell, paid on a buy
    rw(userQuote),                                         //  8 wrapped SOL account: spent on a buy, paid on a sell
    rw(treasury),                                          //  9
    ro(pool.hookProgram),                                  // 10 the system program when the pool has no hook
    ro(pool.hookExtraMetas),                               // 11 the same
    ro(callerOf(pool.hookProgram)),                        // 12 the hook caller of THIS pool's hook program
    ro(pool.baseTokenProgram),                             // 13
    ro(pool.quoteTokenProgram),                            // 14
    ro(EVENT_AUTHORITY),                                   // 15
    ro(HOOKPOOL),                                          // 16
    ...extra,                                              // 17.. the hook's accounts, in any order
  ];
  const data = Buffer.alloc(25);
  Buffer.from(SWAP_DISC).copy(data, 0);
  data.writeUInt8(direction, 8);
  data.writeBigUInt64LE(amountIn, 9);
  data.writeBigUInt64LE(minOut, 17);
  return new TransactionInstruction({ programId: HOOKPOOL, keys, data });
}
const createAta = (payer, owner, mint, tokenProgram) => new TransactionInstruction({
  programId: ATA_PROGRAM, data: Buffer.from([1]), // CreateIdempotent
  keys: [{ pubkey: payer, isSigner: true, isWritable: true }, rw(ataOf(owner, mint, tokenProgram)), ro(owner), ro(mint), ro(SystemProgram.programId), ro(tokenProgram)],
});
const syncNative = (account) => new TransactionInstruction({ programId: TOKEN, data: Buffer.from([17]), keys: [rw(account)] });
const closeAccount = (account, owner) => new TransactionInstruction({
  programId: TOKEN, data: Buffer.from([9]),
  keys: [rw(account), rw(owner), { pubkey: owner, isSigner: true, isWritable: false }],
});
async function tokenAmount(conn, account) {
  const info = await conn.getAccountInfo(account);
  return info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;
}

/// The pool program's `graduate` (INTEGRATORS.md, "graduate"): seven accounts, no signer of its
/// own, the discriminator alone as data. It fails only on a seeded pool, or while trading is paused.
const graduateInstruction = (poolKey, pool) => new TransactionInstruction({
  programId: HOOKPOOL, data: Buffer.from(GRADUATE_DISC),
  keys: [ro(PLATFORM), rw(poolKey), rw(pool.baseMint), rw(pool.baseVault), ro(pool.baseTokenProgram), ro(EVENT_AUTHORITY), ro(HOOKPOOL)],
});

async function trade(conn, wallet, coinMint, isBuy, amountIn, slippageBps = 100) {
  const poolKey = poolOf(coinMint);
  const [poolInfo, platformInfo, slot] = await Promise.all([conn.getAccountInfo(poolKey), conn.getAccountInfo(PLATFORM), conn.getSlot()]);
  if (!poolInfo) throw new Error("this coin has no pool against SOL");
  const pool = decodePool(poolInfo.data);
  const platform = decodePlatform(platformInfo.data);
  if (platform.paused) throw new Error("trading is paused");

  const answer = await hookAnswer(conn, poolKey, pool, platform, isBuy, amountIn, slot);
  // A pool on the curve at or past its target can be graduated by anyone before this trade
  // lands. So graduate it first, in this transaction, and quote the trade on the pool as
  // graduation leaves it: exact whoever graduates first. A buy that takes the pool across
  // its target is quoted on the curve and graduates the pool right after it. Nothing here
  // lowers the minimum: it is the quote less the slippage.
  const ready = pool.curveState === CURVE_OPEN && pool.reserveQuote >= pool.graduationTarget;
  const q = quoteSwap(ready ? graduatedPool(pool) : pool, platform, isBuy, amountIn, answer.hookFeeBps, answer.feeOverrideBps);
  const crosses = !ready && pool.curveState === CURVE_OPEN && isBuy && q.reserveQuoteAfter >= pool.graduationTarget;

  const user = wallet.publicKey;
  const userBase = ataOf(user, pool.baseMint, pool.baseTokenProgram);
  const userQuote = ataOf(user, WSOL, TOKEN);
  const extra = [...(await hookExtraAccounts(conn, poolKey, pool, user)), ...(await coinAccounts(conn, poolKey, pool, user))];

  // A strict coin: its rules can refuse the trade (never change its amount). Refuse here
  // what the chain would refuse, and open the holder record a buy in the early window needs.
  const rulesCfg = pdaOf([Buffer.from("cfg"), poolKey.toBuffer()], new PublicKey(HOOK.rules));
  const strict = pool.hookProgram.equals(new PublicKey(HOOK.rules)) ? strictOf((await conn.getAccountInfo(rulesCfg))?.data, slot) : null;
  let opensHolder = false;
  if (strict) {
    const held = await tokenAmount(conn, userBase);
    if (isBuy) {
      strictReceiverCheck(strict, held + q.out);
      opensHolder = strict.earlyRuns && !(await holderRecord(conn, poolKey, user));
    } else await strictSenderCheck(conn, poolKey, strict, user, held - amountIn);
  }
  const build = (minOut, probe = false) => {
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 450_000 }),
      createAta(user, user, pool.baseMint, pool.baseTokenProgram),
      createAta(user, user, WSOL, TOKEN),
    ];
    if (isBuy) ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userQuote, lamports: amountIn }), syncNative(userQuote)); // wrap
    // its rent (129 bytes at the chain's rent: 1,305,560 lamports on mainnet, 1,788,720 on a local validator) is the wallet's; the record also earns the holders' share
    if (opensHolder) ixs.push(openHolder(user, rulesCfg, poolKey, userBase));
    // in front of a trade on a pool at or past its target: it graduates the pool, or does nothing when somebody did first
    if (ready) ixs.push(graduateInstruction(poolKey, pool));
    ixs.push(swapInstruction(poolKey, pool, user, userBase, userQuote, isBuy ? BUY : SELL, amountIn, minOut, extra));
    // after a buy that crosses the target; left out of the probe, whose swap must be last
    if (crosses && !probe) ixs.push(graduateInstruction(poolKey, pool));
    return ixs;
  };

  // A simulated swap returns the exact output as return data (u64, little endian). The swap
  // must be the last instruction of the simulated transaction, and its minimum is zero here.
  // This is the quote to trust for a pool whose hook is not one of the five templates: such
  // a hook may take any fee up to the platform cap.
  const probe = new Transaction().add(...build(0n, true));
  probe.feePayer = user;
  probe.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(probe);
  if (sim.value.err) throw new Error("simulation failed: " + JSON.stringify(sim.value.err) + " | " + (sim.value.logs || []).slice(-6).join(" | "));
  const simulated = Buffer.from(sim.value.returnData.data[0], "base64").readBigUInt64LE(0);
  const expected = answer.exact ? q.out : simulated;
  const minOut = (expected * BigInt(10000 - slippageBps)) / 10000n;
  const ixs = build(minOut);

  // Unwrap what is left, and what a sell paid, by closing the wrapped SOL account. Only when
  // this transaction opened it: an account that was there before may be the fee treasury of
  // somebody's coin (a tax coin pays its dev into the dev's wrapped SOL account), and a
  // closed treasury makes the fees wait in the pool until someone reopens it.
  const wsolWasOpen = (await conn.getAccountInfo(userQuote)) !== null;
  if (!wsolWasOpen) ixs.push(closeAccount(userQuote, user));
  // Is the hook fee of this trade paid out, or does it wait? The trade is the same either way.
  const treasuryMissing = q.hookFee > 0n && (await conn.getAccountInfo(pool.hookQuoteTreasury)) === null;

  const coinsBefore = await tokenAmount(conn, userBase);
  const wrappedBefore = await tokenAmount(conn, userQuote);
  const lamportsBefore = BigInt(await conn.getBalance(user));
  const signature = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [wallet], { commitment: "confirmed" });
  // What the pool paid out. A buy: coins. A sell: SOL, or wrapped SOL when the wallet keeps
  // its wrapped account (the account opened here costs no rent in the end: it is closed again).
  let got;
  if (isBuy) got = (await tokenAmount(conn, userBase)) - coinsBefore;
  else if (wsolWasOpen) got = (await tokenAmount(conn, userQuote)) - wrappedBefore;
  else got = BigInt(await conn.getBalance(user)) - lamportsBefore + SIGNATURE_FEE;
  console.log(`${isBuy ? "buy " : "sell"} in ${amountIn}  quoted ${q.out}${answer.exact ? "" : answer.window ? ` (${answer.window}, fee ${answer.feeOverrideBps} bps at slot ${slot}: this or more)` : " (not exact)"}  simulated ${simulated}` +
    `  received ${got} ${isBuy ? "coin units" : wsolWasOpen ? "lamports, wrapped" : "lamports"}` +
    `  fees: protocol ${q.protocolFee}, pool ${q.lpFee}, hook ${q.hookFee}${treasuryMissing ? " (waits in the pool: its treasury account does not exist)" : ""}` +
    `${strict ? `  strict coin${opensHolder ? ", opened the holder record first (early window)" : ""}` : ""}` +
    `  pool ${curveText(pool)}${ready ? ", at or past its target: graduate sent in front, the trade quoted on the pool as graduation leaves it" : crosses ? ", this buy crosses the target: graduate sent right after it" : ""}  minimum ${minOut}  ${signature.slice(0, 16)}`);
  if (pool.curveState === CURVE_OPEN) {
    // the pool account carries the real reserves after the trade
    const after = decodePool((await conn.getAccountInfo(poolKey)).data);
    if (ready && after.curveState !== CURVE_GRADUATED) throw new Error("graduate was sent in front of the trade and the pool is not graduated");
    if (crosses && after.curveState !== CURVE_GRADUATED) console.log("  note: the pool is still on the curve: a sell landed between the buy and its graduate, which then did nothing");
    if (!ready && !crosses && answer.exact && (after.reserveQuote !== q.reserveQuoteAfter || after.reserveBase !== q.reserveBaseAfter || after.virtualQuote !== pool.virtualQuote))
      console.log("  note: the pool moved after the read (another trade, or a graduate): its reserves are not this trade's alone");
  }
  if (answer.exact && simulated !== q.out) throw new Error("the quote was called exact and the simulation disagrees");
  if (answer.exact && got !== q.out) throw new Error("the quote was called exact and the wallet received another amount");
  if (answer.window && got < q.out) throw new Error("inside a " + answer.window + " the wallet must receive the quoted amount or more");
  if (got < minOut) throw new Error("the wallet received less than the minimum");
  return got;
}

// ---- hook fees that wait (INTEGRATORS.md, "The hook fee and its treasury") --------------------
/// When the treasury account of a pool does not exist, the hook fee of every trade waits in
/// the pool. Anyone can recreate the account for its owner and pay what waited.
async function collectHookFees(conn, wallet, coinMint) {
  const poolKey = poolOf(coinMint);
  const info = await conn.getAccountInfo(poolKey);
  if (!info) throw new Error("this coin has no pool against SOL");
  const pool = decodePool(info.data);
  if (pool.hookFeesOwed === 0n) { console.log("no hook fee waits in this pool"); return; }
  const collect = new TransactionInstruction({
    programId: HOOKPOOL, data: Buffer.from(COLLECT_HOOK_FEES_DISC),
    keys: [rw(poolKey), ro(pool.quoteMint), rw(pool.quoteVault), rw(pool.hookQuoteTreasury), ro(pool.quoteTokenProgram)],
  });
  const ixs = [createAta(wallet.publicKey, pool.hookTreasuryOwner, pool.quoteMint, pool.quoteTokenProgram), collect];
  const signature = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [wallet], { commitment: "confirmed" });
  const after = decodePool((await conn.getAccountInfo(poolKey)).data);
  console.log(`collected ${pool.hookFeesOwed} lamports of hook fees for the treasury ${pool.hookQuoteTreasury.toBase58()} of ${pool.hookTreasuryOwner.toBase58()}; ${after.hookFeesOwed} still wait  ${signature.slice(0, 16)}`);
  if (after.hookFeesOwed !== 0n) throw new Error("fees still wait after the collection");
}

// ---- graduation (INTEGRATORS.md, "Pools on the curve", "graduate") ---------------------------
/// Anyone may graduate a pool on the curve that holds its target of real SOL. Below the target,
/// and on a pool that graduated already, it lands and does nothing: that is what makes it safe
/// to send with any trade. The pool's address does not change.
async function graduate(conn, wallet, coinMint) {
  const poolKey = poolOf(coinMint);
  const info = await conn.getAccountInfo(poolKey);
  if (!info) throw new Error("this coin has no pool against SOL");
  const before = decodePool(info.data);
  if (before.curveState !== CURVE_OPEN && before.curveState !== CURVE_GRADUATED) throw new Error("a seeded pool: graduate would fail with 6047 NotOnCurve");
  const supplyOf = async () => (await conn.getAccountInfo(before.baseMint)).data.readBigUInt64LE(36);
  const supplyBefore = await supplyOf();
  const signature = await sendAndConfirmTransaction(conn, new Transaction().add(graduateInstruction(poolKey, before)), [wallet], { commitment: "confirmed" });
  const after = decodePool((await conn.getAccountInfo(poolKey)).data);
  const supplyAfter = await supplyOf();
  const below = before.curveState === CURVE_OPEN && before.reserveQuote < before.graduationTarget;
  if (before.curveState === CURVE_GRADUATED || below) {
    // nothing changes: what a client that sends graduate with a trade relies on
    if (!(await conn.getAccountInfo(poolKey)).data.equals(info.data) || supplyAfter !== supplyBefore) throw new Error("a graduate that must do nothing changed something");
    console.log(`${below ? `raised ${before.reserveQuote} of ${before.graduationTarget} lamports, below the target` : "the pool had graduated already"}: graduate landed and changed nothing  ${signature.slice(0, 16)}`);
    return;
  }
  // the event, an inner instruction of the pool program: tag, discriminator, 88 bytes
  const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const e = (tx.meta.innerInstructions || []).flatMap((g) => g.instructions).filter((i) => keys.get(i.programIdIndex).equals(HOOKPOOL)).map((i) => base58(i.data))
    .filter((d) => d.length === 16 + 88 && EVENT_TAG.every((b, k) => d[k] === b) && GRADUATED_DISC.every((b, k) => d[8 + k] === b)).map((d) => d.subarray(16))[0];
  if (!e) throw new Error("no Graduated event in the transaction");
  const g = graduation(before);
  const event = { reserveQuoteBefore: e.readBigUInt64LE(32), reserveQuoteAfter: e.readBigUInt64LE(40), reserveBaseBefore: e.readBigUInt64LE(48), reserveBaseAfter: e.readBigUInt64LE(56), burned: e.readBigUInt64LE(64), fee: e.readBigUInt64LE(72), slot: e.readBigUInt64LE(80) };
  console.log(`graduated: ${before.reserveQuote} real lamports and ${before.virtualQuote} virtual on ${before.reserveBase} units became ${after.reserveQuote} lamports on ${after.reserveBase} units;`
    + ` ${event.burned} units burned, the supply ${supplyBefore} -> ${supplyAfter}, fee ${event.fee} for the platform; the pool keeps its address ${poolKey.toBase58()}  ${signature.slice(0, 16)}`);
  const kept = after.reserveQuote * before.reserveBase >= (before.reserveQuote + before.virtualQuote) * after.reserveBase
    && after.reserveQuote * before.reserveBase < (before.reserveQuote + before.virtualQuote) * (after.reserveBase + 1n);
  if (after.reserveQuote !== g.reserveQuote || after.reserveBase !== g.reserveBase || after.virtualQuote !== 0n || after.graduationTarget !== 0n || after.curveState !== CURVE_GRADUATED) throw new Error("the pool after graduate is not what the formula says");
  if (event.burned !== g.burned || event.fee !== g.fee || event.reserveQuoteAfter !== g.reserveQuote || event.reserveBaseAfter !== g.reserveBase || event.reserveBaseBefore !== before.reserveBase || event.reserveQuoteBefore !== before.reserveQuote) throw new Error("the Graduated event is not what the formula says");
  if (supplyAfter !== supplyBefore - g.burned) throw new Error("the supply did not fall by the coins burned");
  if (!kept) throw new Error("the price moved at graduation");
}

// ---- events (INTEGRATORS.md, "Events") -------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const out = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 0xffn));
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return Buffer.from(out);
}
/// Swaps are emitted as an inner instruction of the pool program to itself: the tag, the
/// event discriminator, then the fields. Logs can be cut; inner instructions never are.
async function latestSwaps(conn, coinMint, limit = 10) {
  const poolKey = poolOf(coinMint);
  const signatures = await conn.getSignaturesForAddress(poolKey, { limit });
  for (const s of signatures) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta.err) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    // The burn of a strict coin buys through the pool's hook_buy_burn: its Swapped is a buy by
    // the hook whose coins are burned in the pool's vault, not paid to anyone. Tell it by the
    // pool program's instruction.
    const all = [...tx.transaction.message.compiledInstructions.map((i) => ({ programIdIndex: i.programIdIndex, data: Buffer.from(i.data) })),
      ...(tx.meta.innerInstructions || []).flatMap((g) => g.instructions.map((i) => ({ programIdIndex: i.programIdIndex, data: base58(i.data) })))];
    const burnedByHook = all.some((i) => keys.get(i.programIdIndex).equals(HOOKPOOL) && HOOK_BUY_BURN_DISC.every((b, k) => i.data[k] === b));
    for (const group of tx.meta.innerInstructions || []) {
      for (const ins of group.instructions) {
        if (!keys.get(ins.programIdIndex).equals(HOOKPOOL)) continue;
        const d = base58(ins.data);
        if (d.length < 16 || !EVENT_TAG.every((b, i) => d[i] === b) || !SWAPPED_DISC.every((b, i) => d[8 + i] === b)) continue;
        const e = d.subarray(16);
        if (!key(e, 0).equals(poolKey)) continue;
        console.log(JSON.stringify({
          slot: Number(e.readBigUInt64LE(123)), user: key(e, 32).toBase58(), side: e[64] === BUY ? "buy" : "sell",
          amountIn: e.readBigUInt64LE(65).toString(), amountOut: e.readBigUInt64LE(73).toString(),
          protocolFee: e.readBigUInt64LE(81).toString(), hookFee: e.readBigUInt64LE(89).toString(), poolFee: e.readBigUInt64LE(97).toString(),
          feeBpsApplied: e.readUInt16LE(105), reserveBase: e.readBigUInt64LE(107).toString(), reserveQuote: e.readBigUInt64LE(115).toString(),
          byHook: e[131] !== 0, ...(burnedByHook && e[131] !== 0 ? { burned: true } : {}), signature: s.signature,
        }));
      }
    }
  }
}

// ---- main ------------------------------------------------------------------------------------
const [rpc, mintArg, action, amountArg] = process.argv.slice(2);
if (!rpc || !mintArg || !["buy", "sell", "roundtrip", "events", "collect", "send", "graduate"].includes(action)) {
  console.error("usage: node scripts/raw-swap-example.mjs <rpc url> <coin mint> <buy|sell|roundtrip|events|collect|send|graduate> [amount] [receiver wallet, for send] [--keypair file]");
  process.exit(1);
}
if (action === "send" && process.argv.indexOf("--keypair") < 0) { console.error("a send needs --keypair: a new wallet holds no coins"); process.exit(1); }
if (action === "send" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(process.argv[6] || "")) { console.error("a send needs the receiver's wallet address after the amount"); process.exit(1); }
const conn = new Connection(rpc, "confirmed");
const coinMint = new PublicKey(mintArg);
// Leave by the end of the script, not by process.exit(): exiting while the RPC's socket is still
// closing crashes Node 24 on Windows (a libuv assertion), after every event was printed.
const eventsOnly = action === "events";
if (eventsOnly) await latestSwaps(conn, coinMint);
if (!eventsOnly) {
  const at = process.argv.indexOf("--keypair");
  let wallet;
  if (at > 0) wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[at + 1], "utf8"))));
  else {
    wallet = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(wallet.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
  }
  if (action === "collect") { await collectHookFees(conn, wallet, coinMint); process.exit(0); }
  if (action === "graduate") {
    try { await graduate(conn, wallet, coinMint); } catch (e) { console.error("error: " + e.message); process.exitCode = 1; }
    process.exit();
  }
  if (!/^[1-9][0-9]*$/.test(amountArg || "")) { console.error("the amount is a whole number of raw units: lamports for a buy, coin units for a sell"); process.exit(1); }
  const amount = BigInt(amountArg);
  try {
    if (action === "buy") await trade(conn, wallet, coinMint, true, amount);
    if (action === "sell") await trade(conn, wallet, coinMint, false, amount);
    if (action === "roundtrip") { const got = await trade(conn, wallet, coinMint, true, amount); await trade(conn, wallet, coinMint, false, got); }
    if (action === "send") await send(conn, wallet, coinMint, amount, new PublicKey(process.argv[6]));
  } catch (e) {
    // a refusal before anything was sent (a buy above a coin's limit, a paused platform), or a
    // trade that did not do what was quoted
    console.error("error: " + e.message);
    process.exitCode = 1;
  }
}
