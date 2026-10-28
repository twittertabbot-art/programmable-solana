// Unit tests for the pure parts of the trade API (web/api/_trade-core.js). No chain needed.
//   node --test "web/api/_test/*.test.mjs"        (from the project folder)
// The folder name starts with an underscore so Vercel does not turn these files into routes.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiError, DEFAULT_SLIPPAGE_BPS, MAX_CU_PRICE, U64_MAX, base58Decode, clientIp, createRateLimiter, envInt, errorResponse, explainSimulationError,
  formatUnits, isPublicKey, minOutAfterSlippage, parseJsonBody, parseQuoteParams, parseSwapParams, pctOfBps, queryObject, quoteError, ratioDecimal,
} from "../_trade-core.js";

const MINT = "2dGDKhB8nCGeZNXXpUiQReHo9x7J5r2H4F4s5aJVzYdV";
const POOL = "85RatGe9BAaKCTzuhGa4x8gwaXXbAFNTCUifMPxYVeLJ";
const USER = "ALjPBZ7pzjTRmLddcExo8e7Edk3yvVGsrjHsu1u5dhkZ";
const OTHER = "7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh";
const good = { mint: MINT, side: "buy", amount: "500000000" };

/// Runs f and returns the ApiError it throws.
function thrown(f) {
  try { f(); } catch (e) { assert.ok(e instanceof ApiError, "an ApiError, got " + e); return e; }
  assert.fail("did not throw");
}
const invalid = (f, parameter) => {
  const e = thrown(f);
  assert.equal(e.status, 400); assert.equal(e.code, "INVALID_PARAMETER"); assert.equal(e.extra.parameter, parameter);
  return e;
};

// ---- public keys --------------------------------------------------------------------------------

test("base58: decodes known keys to 32 bytes", () => {
  assert.equal(base58Decode("11111111111111111111111111111111").length, 32);
  assert.ok(base58Decode("11111111111111111111111111111111").every((b) => b === 0));
  assert.equal(base58Decode("So11111111111111111111111111111111111111112").length, 32);
  assert.equal(base58Decode(MINT).length, 32);
  assert.deepEqual([...base58Decode("2g")], [0x61]);
});

test("base58: refuses characters outside the alphabet and oversized input", () => {
  for (const s of ["0", "O", "I", "l", "abc def", "abc+", "", "\u00e9"]) assert.equal(base58Decode(s), null, JSON.stringify(s));
  assert.equal(base58Decode("1".repeat(129)), null);
  assert.equal(base58Decode("1".repeat(129), 200).length, 129);
  assert.equal(base58Decode(123), null);
});

test("isPublicKey: exactly 32 bytes of base58", () => {
  for (const k of [MINT, POOL, USER, OTHER, "11111111111111111111111111111111", "So11111111111111111111111111111111111111112"]) assert.equal(isPublicKey(k), true, k);
  assert.equal(isPublicKey("1111111111111111111111111111111"), false, "31 bytes");
  assert.equal(isPublicKey("111111111111111111111111111111111"), false, "33 bytes");
  assert.equal(isPublicKey(MINT.slice(0, -1) + "0"), false, "bad character");
  assert.equal(isPublicKey(MINT + MINT), false);
  for (const v of [undefined, null, 5, {}, [], "", "abc"]) assert.equal(isPublicKey(v), false);
});

// ---- quote fields ---------------------------------------------------------------------------------

test("quote: a valid request by mint, defaults filled in", () => {
  const p = parseQuoteParams({ ...good });
  assert.deepEqual(p, { mint: MINT, pool: null, side: "buy", amount: 500000000n, slippageBps: DEFAULT_SLIPPAGE_BPS });
  assert.equal(DEFAULT_SLIPPAGE_BPS, 100);
});

test("quote: a valid request by pool, slippage given", () => {
  const p = parseQuoteParams({ pool: POOL, side: "sell", amount: "1", slippageBps: "250" });
  assert.deepEqual(p, { mint: null, pool: POOL, side: "sell", amount: 1n, slippageBps: 250 });
});

test("quote: mint or pool, exactly one", () => {
  invalid(() => parseQuoteParams({ side: "buy", amount: "1" }), "mint");
  invalid(() => parseQuoteParams({ ...good, pool: POOL }), "pool");
  invalid(() => parseQuoteParams({ ...good, mint: "nope" }), "mint");
  invalid(() => parseQuoteParams({ pool: "nope", side: "buy", amount: "1" }), "pool");
  invalid(() => parseQuoteParams({ ...good, mint: 5 }), "mint");
});

test("quote: side is buy or sell, nothing else", () => {
  for (const side of ["BUY", "Buy", "long", "", " buy", undefined, 0, null]) invalid(() => parseQuoteParams({ ...good, side }), "side");
});

test("quote: amount is a string of digits within 64 bits", () => {
  for (const amount of ["0", "00", "01", "1.5", "-1", "1e9", " 1", "1 ", "0x10", "", "abc", "1,000", "+5", 5, 5n, 1.5, null, true, ["1"], "9".repeat(21)]) {
    invalid(() => parseQuoteParams({ ...good, amount }), "amount");
  }
  invalid(() => parseQuoteParams({ mint: MINT, side: "buy" }), "amount");
  assert.equal(parseQuoteParams({ ...good, amount: U64_MAX.toString() }).amount, 18446744073709551615n);
  invalid(() => parseQuoteParams({ ...good, amount: (U64_MAX + 1n).toString() }), "amount");
  assert.equal(parseQuoteParams({ ...good, amount: "1" }).amount, 1n);
});

test("quote: slippageBps from 0 to 5000", () => {
  assert.equal(parseQuoteParams({ ...good, slippageBps: "0" }).slippageBps, 0);
  assert.equal(parseQuoteParams({ ...good, slippageBps: "5000" }).slippageBps, 5000);
  assert.equal(parseQuoteParams({ ...good, slippageBps: 75 }).slippageBps, 75);
  for (const slippageBps of ["5001", "-1", "1.5", "abc", "", "050", 5001, -1, 0.5, NaN, Infinity, null, true, "99999999999"]) {
    invalid(() => parseQuoteParams({ ...good, slippageBps }), "slippageBps");
  }
});

test("quote: unknown fields are refused, swap fields included", () => {
  invalid(() => parseQuoteParams({ ...good, slippage: "50" }), "slippage");
  invalid(() => parseQuoteParams({ ...good, recipient: USER }), "recipient");
  invalid(() => parseQuoteParams({ ...good, minOutAmount: "5" }), "minOutAmount");
  const e = invalid(() => parseQuoteParams({ ...good, ["x".repeat(500)]: "1" }), "x".repeat(40));
  assert.ok(e.message.includes("mint, pool, side, amount, slippageBps, userPublicKey"));
});

test("quote: userPublicKey is optional, and checked like the swap's", () => {
  assert.equal(parseQuoteParams({ ...good, userPublicKey: USER }).userPublicKey, USER);
  assert.equal("userPublicKey" in parseQuoteParams({ ...good }), false, "left out: the quote names no wallet");
  invalid(() => parseQuoteParams({ ...good, userPublicKey: "not-a-key" }), "userPublicKey");
});

test("simulation: the four rules of a strict coin get their own codes, from the rules program only", () => {
  const line = (name, n) => "Program log: AnchorError thrown in programs/hook_rules/src/lib.rs:1200. Error Code: " + name + ". Error Number: " + n + ". Error Message: x.";
  for (const [name, n, code] of [["MaxWallet", 6044, "MAX_WALLET_EXCEEDED"], ["EarlyLocked", 6045, "EARLY_LOCKED"], ["CreatorLocked", 6046, "CREATOR_LOCKED"], ["HolderRecordRequired", 6047, "HOLDER_RECORD_REQUIRED"]]) {
    const r = explainSimulationError({ InstructionError: [5, { Custom: n }] }, [line(name, n)]);
    assert.equal(r.code, code, name); assert.deepEqual(r.programError, { name, number: n });
    const other = explainSimulationError({ InstructionError: [5, { Custom: n }] }, [line(name, n).replace("hook_rules", "some_hook")]);
    assert.equal(other.code, "SIMULATION_FAILED", name + " of another program");
  }
  assert.equal(explainSimulationError({ InstructionError: [5, { Custom: 6044 }] }, [line("NotMaxWallet", 6044)]).code, "SIMULATION_FAILED", "the name must match the number");
});

test("simulation: the curve's two refusals of a trade, from the pool program only", () => {
  const line = (program, name, n) => "Program log: AnchorError thrown in programs/" + program + "/src/math.rs:120. Error Code: " + name + ". Error Number: " + n + ". Error Message: x.";
  const real = explainSimulationError({ InstructionError: [5, { Custom: 6049 }] }, [line("hookpool", "CurveRealReserve", 6049)]);
  assert.equal(real.code, "CURVE_REAL_RESERVE"); assert.deepEqual(real.programError, { name: "CurveRealReserve", number: 6049 });
  assert.match(real.message, /^This coin is on the curve\. Its pool pays a sell from the real SOL it holds/);
  const late = explainSimulationError({ InstructionError: [6, { Custom: 6048 }] }, [line("hookpool", "GraduationNotReached", 6048)]);
  assert.equal(late.code, "SIMULATION_FAILED"); assert.deepEqual(late.programError, { name: "GraduationNotReached", number: 6048 });
  assert.equal(late.message, "The pool fell back under its graduation target before this trade, so the graduate at the end of the transaction was refused. Ask for a new quote.");
  // the same numbers of another program are that program's own
  assert.equal(explainSimulationError({ InstructionError: [5, { Custom: 6049 }] }, [line("hook_rules", "CurveRealReserve", 6049)]).message, "The program refused the trade: x (CurveRealReserve).");
  assert.equal(explainSimulationError({ InstructionError: [5, { Custom: 6049 }] }, [line("hookpool", "Other", 6049)]).code, "SIMULATION_FAILED", "the name must match the number");
});

test("a private key is never accepted, and its value is never echoed", () => {
  for (const name of ["privateKey", "private_key", "secretKey", "secret", "keypair", "seed", "seedPhrase", "mnemonic", "PRIVATEKEY"]) {
    const e = invalid(() => parseSwapParams({ ...good, userPublicKey: USER, [name]: "5JTopSecretValue" }), name);
    assert.match(e.message, /Never send a private key/);
    assert.ok(!JSON.stringify(errorResponse(e)).includes("5JTopSecretValue"));
  }
  invalid(() => parseQuoteParams({ ...good, secretKey: "x" }), "secretKey");
});

test("input that is not an object", () => {
  for (const v of [null, undefined, "x", 5, [], [good]]) {
    const e = thrown(() => parseQuoteParams(v));
    assert.equal(e.code, "INVALID_JSON"); assert.equal(e.status, 400);
  }
});

// ---- swap fields ----------------------------------------------------------------------------------

test("swap: a valid request, defaults filled in", () => {
  const p = parseSwapParams({ ...good, userPublicKey: USER });
  assert.deepEqual(p, { mint: MINT, pool: null, side: "buy", amount: 500000000n, slippageBps: 100, userPublicKey: USER, recipient: null, minOutAmount: null, computeUnitPriceMicroLamports: 0, simulate: false, mintDeposit: true });
});

test("swap: every optional field", () => {
  const p = parseSwapParams({ pool: POOL, side: "sell", amount: "7", slippageBps: 0, userPublicKey: USER, recipient: OTHER, minOutAmount: "6", computeUnitPriceMicroLamports: 20000, simulate: true, mintDeposit: false });
  assert.deepEqual(p, { mint: null, pool: POOL, side: "sell", amount: 7n, slippageBps: 0, userPublicKey: USER, recipient: OTHER, minOutAmount: 6n, computeUnitPriceMicroLamports: 20000, simulate: true, mintDeposit: false });
});

test("swap: mintDeposit is true unless the caller sends false", () => {
  assert.equal(parseSwapParams({ ...good, userPublicKey: USER }).mintDeposit, true);
  assert.equal(parseSwapParams({ ...good, userPublicKey: USER, mintDeposit: true }).mintDeposit, true);
  assert.equal(parseSwapParams({ ...good, userPublicKey: USER, mintDeposit: false }).mintDeposit, false);
  for (const mintDeposit of ["false", 0, 1, null, {}]) invalid(() => parseSwapParams({ ...good, userPublicKey: USER, mintDeposit }), "mintDeposit");
});

test("swap: userPublicKey is required and must be a key", () => {
  invalid(() => parseSwapParams({ ...good }), "userPublicKey");
  for (const userPublicKey of ["x", "", 5, null, MINT + "1"]) invalid(() => parseSwapParams({ ...good, userPublicKey }), "userPublicKey");
});

test("swap: recipient is optional; the signer itself counts as none", () => {
  assert.equal(parseSwapParams({ ...good, userPublicKey: USER, recipient: USER }).recipient, null);
  assert.equal(parseSwapParams({ ...good, userPublicKey: USER, recipient: null }).recipient, null);
  for (const recipient of ["x", "", 5, {}, "A".repeat(5000)]) invalid(() => parseSwapParams({ ...good, userPublicKey: USER, recipient }), "recipient");
});

test("swap: the priority fee is bounded", () => {
  const at = (v, opts) => parseSwapParams({ ...good, userPublicKey: USER, computeUnitPriceMicroLamports: v }, opts).computeUnitPriceMicroLamports;
  assert.equal(MAX_CU_PRICE, 5_000_000);
  assert.equal(at(0), 0); assert.equal(at(MAX_CU_PRICE), MAX_CU_PRICE); assert.equal(at("1000"), 1000);
  for (const v of [MAX_CU_PRICE + 1, -1, 1.5, "abc", "1e3", true, {}, Number.MAX_SAFE_INTEGER]) invalid(() => at(v), "computeUnitPriceMicroLamports");
  assert.equal(at(100, { maxCuPrice: 100 }), 100);
  invalid(() => at(101, { maxCuPrice: 100 }), "computeUnitPriceMicroLamports");
});

test("swap: simulate is a boolean, minOutAmount is an amount", () => {
  assert.equal(parseSwapParams({ ...good, userPublicKey: USER, simulate: false }).simulate, false);
  for (const simulate of ["true", "yes", 1, 0, null, {}]) invalid(() => parseSwapParams({ ...good, userPublicKey: USER, simulate }), "simulate");
  for (const minOutAmount of ["0", "1.5", 5, "-1", "", (U64_MAX + 1n).toString()]) invalid(() => parseSwapParams({ ...good, userPublicKey: USER, minOutAmount }), "minOutAmount");
  assert.equal(parseSwapParams({ ...good, userPublicKey: USER, minOutAmount: U64_MAX.toString() }).minOutAmount, U64_MAX);
});

test("swap: unknown fields are refused", () => {
  invalid(() => parseSwapParams({ ...good, userPublicKey: USER, feeAccount: OTHER }), "feeAccount");
  invalid(() => parseSwapParams({ ...good, userPublicKey: USER, slippage: 5 }), "slippage");
});

// ---- query and body ---------------------------------------------------------------------------------

test("query: one value per field", () => {
  assert.deepEqual({ ...queryObject(new URLSearchParams("mint=a&side=buy&amount=5")) }, { mint: "a", side: "buy", amount: "5" });
  invalid(() => queryObject(new URLSearchParams("amount=5&amount=6")), "amount");
  assert.deepEqual(Object.keys(queryObject(new URLSearchParams(""))), []);
  // a field named like an object method or the prototype is still just a field
  assert.deepEqual(Object.keys(queryObject(new URLSearchParams("toString=1&__proto__=2"))), ["toString", "__proto__"]);
  invalid(() => queryObject(new URLSearchParams("toString=1&toString=2")), "toString");
  invalid(() => parseQuoteParams(queryObject(new URLSearchParams("mint=" + MINT + "&side=buy&amount=5&__proto__=1"))), "__proto__");
});

test("body: JSON objects only", () => {
  assert.deepEqual(parseJsonBody('{"a":1}'), { a: 1 });
  for (const t of ["", "not json", "{", "[1,2]", "5", "null", '"x"', "true"]) {
    const e = thrown(() => parseJsonBody(t));
    assert.equal(e.code, "INVALID_JSON"); assert.equal(e.status, 400);
  }
});

// ---- slippage -----------------------------------------------------------------------------------------

test("slippage: floor(out * (10000 - bps) / 10000)", () => {
  assert.equal(minOutAfterSlippage(1000n, 100), 990n);
  assert.equal(minOutAfterSlippage(999n, 100), 989n, "989.01 rounds down");
  assert.equal(minOutAfterSlippage(139673423448977n, 100), 138276689214487n, "the number the server gave on localnet");
  assert.equal(minOutAfterSlippage(1n, 1), 0n);
  assert.equal(minOutAfterSlippage(12345n, 0), 12345n, "0 bps keeps the amount");
  assert.equal(minOutAfterSlippage(1001n, 5000), 500n);
  assert.equal(minOutAfterSlippage(0n, 100), 0n);
  assert.equal(minOutAfterSlippage(U64_MAX, 1), (U64_MAX * 9999n) / 10000n, "no overflow at 64 bits");
});

test("slippage: never above the quote, never negative, falls as bps rise", () => {
  let prev = null;
  for (let bps = 0; bps <= 5000; bps += 125) {
    const m = minOutAfterSlippage(987654321987n, bps);
    assert.ok(m >= 0n && m <= 987654321987n);
    if (prev !== null) assert.ok(m < prev);
    prev = m;
  }
});

test("slippage: bad arguments throw", () => {
  assert.throws(() => minOutAfterSlippage(1000, 100));
  assert.throws(() => minOutAfterSlippage(-1n, 100));
  assert.throws(() => minOutAfterSlippage(1000n, -1));
  assert.throws(() => minOutAfterSlippage(1000n, 10001));
  assert.throws(() => minOutAfterSlippage(1000n, 1.5));
});

// ---- decimals ---------------------------------------------------------------------------------------------

test("ratioDecimal: plain decimal strings, cut to 9 significant digits", () => {
  assert.equal(ratioDecimal(1n, 2n), "0.5");
  assert.equal(ratioDecimal(1n, 3n), "0.333333333");
  assert.equal(ratioDecimal(2n, 3n), "0.666666666", "cut, not rounded");
  assert.equal(ratioDecimal(10n, 1n), "10");
  assert.equal(ratioDecimal(123456789012n, 1000n), "123456789");
  assert.equal(ratioDecimal(12345678901n, 1000n), "12345678.9");
  assert.equal(ratioDecimal(1n, 1000000000000n), "0.000000000001");
  assert.equal(ratioDecimal(0n, 5n), "0");
  assert.equal(ratioDecimal(5n, 0n), "0");
  assert.equal(ratioDecimal(1n, 10n ** 40n), "0", "below 36 decimals");
  // a real pool: 2.429091960 SOL against 826,460,310.203470 coins of 6 decimals
  const price = ratioDecimal(2429091960n * 10n ** 6n, 826460310203470n * 10n ** 9n);
  assert.equal(price, "0.00000000293915137");
  assert.ok(Math.abs(Number(price) - 2.42909196 / 826460310.20347) < 1e-17);
  assert.ok(!/e/i.test(ratioDecimal(1n, 10n ** 30n)), "never exponent form");
});

test("formatUnits and pctOfBps", () => {
  assert.equal(formatUnits(50000000000000n, 6), "50000000");
  assert.equal(formatUnits(1500000n, 6), "1.5");
  assert.equal(formatUnits(1n, 6), "0.000001");
  assert.equal(formatUnits(0n, 6), "0");
  assert.equal(formatUnits(42n, 0), "42");
  assert.equal(pctOfBps(100), "1");
  assert.equal(pctOfBps(250), "2.5");
  assert.equal(pctOfBps(3723), "37.23");
  assert.equal(pctOfBps(0), "0");
  assert.equal(pctOfBps(5000), "50");
  assert.equal(pctOfBps(20), "0.2");
});

// ---- errors -------------------------------------------------------------------------------------------------

test("error shape: one object, code and message", () => {
  const r = errorResponse(new ApiError(404, "POOL_NOT_FOUND", "No pool."));
  assert.deepEqual(r, { status: 404, body: { error: { code: "POOL_NOT_FOUND", message: "No pool." } } });
  const p = errorResponse(new ApiError(400, "INVALID_PARAMETER", "Bad.", { parameter: "amount" }));
  assert.deepEqual(p.body, { error: { code: "INVALID_PARAMETER", message: "Bad.", parameter: "amount" } });
});

test("error shape: anything unexpected becomes INTERNAL and leaks nothing", () => {
  const boom = new Error("ENOENT: no such file C:\\Users\\someone\\secret\\key.json at http://rpc.example/?api-key=abc");
  boom.stack = "Error: boom\n    at handler (C:\\srv\\web\\api\\_trade.js:10:5)";
  for (const e of [boom, new TypeError("x is not a function"), "a string", null, undefined, { status: 418, code: "FAKE", message: "not ours" }]) {
    const r = errorResponse(e);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: { code: "INTERNAL", message: "Something went wrong on our side. Try again." } });
    assert.ok(!/secret|api-key|_trade\.js|C:\\/.test(JSON.stringify(r)));
  }
});

test("quote errors of the SDK in words", () => {
  for (const [text, expect] of [["amount too small", /too small/], ["amount must be greater than zero", /too small/], ["not enough liquidity", /liquidity/], ["something else", /cannot be quoted/]]) {
    const e = quoteError(new Error(text));
    assert.equal(e.status, 422); assert.equal(e.code, "CANNOT_QUOTE"); assert.match(e.message, expect);
  }
  assert.equal(quoteError(null).code, "CANNOT_QUOTE");
});

// ---- simulation errors in words ---------------------------------------------------------------------------------

test("simulation: a wallet with too little SOL", () => {
  for (const err of ["AccountNotFound", "InsufficientFundsForFee", { InsufficientFundsForRent: { account_index: 0 } }]) {
    const r = explainSimulationError(err, []);
    assert.equal(r.code, "INSUFFICIENT_FUNDS"); assert.match(r.message, /SOL/);
  }
  // logs of a buy by a wallet that holds the amount but not the rent, as the local validator wrote them
  const logs = [
    "Program ComputeBudget111111111111111111111111111111 invoke [1]", "Program ComputeBudget111111111111111111111111111111 success",
    "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [1]", "Program log: CreateIdempotent",
    "Program 11111111111111111111111111111111 invoke [2]", "Transfer: insufficient lamports 95000, need 2039280",
    "Program 11111111111111111111111111111111 failed: custom program error: 0x1",
    "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL failed: custom program error: 0x1",
  ];
  const r = explainSimulationError({ InstructionError: [2, { Custom: 1 }] }, logs);
  assert.equal(r.code, "INSUFFICIENT_FUNDS"); assert.match(r.message, /too little SOL/);
});

test("simulation: the pool's slippage error, as logged on chain", () => {
  const logs = [
    "Program 7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh invoke [1]", "Program log: Instruction: Swap",
    "Program log: AnchorError thrown in programs/hookpool/src/instructions/swap.rs:125. Error Code: Slippage. Error Number: 6008. Error Message: output below min_amount_out.",
    "Program 7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh consumed 21003 of 249550 compute units",
    "Program 7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh failed: custom program error: 0x1778",
  ];
  const r = explainSimulationError({ InstructionError: [5, { Custom: 6008 }] }, logs);
  assert.equal(r.code, "SLIPPAGE_EXCEEDED");
  assert.deepEqual(r.programError, { name: "Slippage", number: 6008 });
  assert.ok(!/programs\/|\.rs/.test(r.message), "no source path in the message");
});

test("simulation: paused, and any other program error", () => {
  const paused = explainSimulationError({ InstructionError: [5, { Custom: 6000 }] }, ["Program log: AnchorError thrown in programs/hookpool/src/instructions/swap.rs:64. Error Code: Paused. Error Number: 6000. Error Message: platform is paused."]);
  assert.equal(paused.code, "TRADING_PAUSED");
  // the launch rules template refuses a buy above the coin's buy limit: its own code, and only from that program
  const limit = explainSimulationError({ InstructionError: [5, { Custom: 6017 }] }, ["Program log: AnchorError thrown in programs/hook_rules/src/lib.rs:654. Error Code: BuyTooLarge. Error Number: 6017. Error Message: this buy is above the limit of the launch window."]);
  assert.equal(limit.code, "BUY_LIMIT_EXCEEDED"); assert.deepEqual(limit.programError, { name: "BuyTooLarge", number: 6017 }); assert.match(limit.message, /buy limit/);
  const namesake = explainSimulationError({ InstructionError: [5, { Custom: 6017 }] }, ["Program log: AnchorError thrown in programs/some_hook/src/lib.rs:9. Error Code: BuyTooLarge. Error Number: 6017. Error Message: no."]);
  assert.equal(namesake.code, "SIMULATION_FAILED", "another program's error of the same name keeps the general code");
  const other = explainSimulationError({ InstructionError: [5, { Custom: 6032 }] }, ["Program log: AnchorError occurred. Error Code: HookPowerNotGranted. Error Number: 6033. Error Message: hook used a power its flags do not grant."]);
  assert.equal(other.code, "SIMULATION_FAILED");
  assert.equal(other.message, "The program refused the trade: hook used a power its flags do not grant (HookPowerNotGranted).");
  assert.deepEqual(other.programError, { name: "HookPowerNotGranted", number: 6033 });
});

test("simulation: too few coins, compute, and errors without a log", () => {
  const coins = explainSimulationError({ InstructionError: [3, { Custom: 1 }] }, ["Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]", "Program log: Instruction: TransferChecked", "Program log: Error: insufficient funds"]);
  assert.equal(coins.code, "INSUFFICIENT_FUNDS"); assert.match(coins.message, /token it sends/);
  assert.match(explainSimulationError({ InstructionError: [5, "ProgramFailedToComplete"] }, ["Program X failed: exceeded CUs meter at BPF instruction"]).message, /compute units/);
  assert.match(explainSimulationError({ InstructionError: [5, "ComputationalBudgetExceeded"] }, null).message, /compute units/);
  // the answer of the local validator to a sell whose SOL would go to a program
  const ro = explainSimulationError({ InstructionError: [3, "ReadonlyLamportChange"] }, ["Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]", "Program log: Instruction: CloseAccount"]);
  assert.deepEqual(ro, { code: "SIMULATION_FAILED", message: "The chain refused the transaction. Instruction 3 failed with ReadonlyLamportChange." });
  assert.equal(explainSimulationError({ InstructionError: [4, { Custom: 12 }] }, []).message, "The chain refused the transaction. Instruction 4 failed with custom error 12.");
  assert.equal(explainSimulationError("BlockhashNotFound", []).message, "The chain refused the transaction: BlockhashNotFound.");
  assert.equal(explainSimulationError({ Weird: 1 }, undefined).message, "The chain refused the transaction.");
});

test("simulation: text from a program log is cut down to plain words", () => {
  const r = explainSimulationError({ InstructionError: [1, { Custom: 6999 }] }, ["Program log: AnchorError occurred. Error Code: Evil. Error Number: 6999. Error Message: <script>alert(1)</script> caf\u00e9 \u2014 \"x\" " + "y".repeat(400) + "."]);
  assert.equal(r.code, "SIMULATION_FAILED");
  assert.ok(!/[<>"\\]/.test(r.message) && !/[^\x20-\x7E]/.test(r.message));
  assert.ok(r.message.length < 260);
});

// ---- the limiter ---------------------------------------------------------------------------------------------------

test("limiter: counts per key inside a window", () => {
  let t = 1_000_000;
  const lim = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => lim.check("1.2.3.4").ok), [true, true, true, false, false]);
  assert.equal(lim.check("5.6.7.8").ok, true, "another address has its own count");
  const r = lim.check("1.2.3.4");
  assert.equal(r.ok, false); assert.equal(r.remaining, 0); assert.equal(r.limit, 3); assert.equal(r.retryAfterSeconds, 60);
  t += 59_000;
  assert.equal(lim.check("1.2.3.4").ok, false);
  assert.equal(lim.check("1.2.3.4").retryAfterSeconds, 1);
  t += 1_000;
  const again = lim.check("1.2.3.4");
  assert.equal(again.ok, true, "a new window"); assert.equal(again.remaining, 2);
});

test("limiter: remaining counts down, 0 turns it off", () => {
  const lim = createRateLimiter({ limit: 2, windowMs: 1000, now: () => 0 });
  assert.equal(lim.check("a").remaining, 1); assert.equal(lim.check("a").remaining, 0); assert.equal(lim.check("a").remaining, 0);
  const off = createRateLimiter({ limit: 0, windowMs: 1000 });
  for (let i = 0; i < 1000; i++) assert.equal(off.check("a").ok, true);
  assert.equal(off.size(), 0);
});

test("limiter: memory stays bounded under a flood of addresses", () => {
  let t = 0;
  const lim = createRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 100, now: () => t });
  for (let i = 0; i < 10_000; i++) lim.check("ip-" + i);
  assert.ok(lim.size() <= 100, "size " + lim.size());
  t += 2000;
  lim.check("late");
  assert.ok(lim.size() <= 100);
  // expired keys go first, so a patient flood cannot push out a live count
  const lim2 = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10, now: () => t });
  for (let i = 0; i < 10; i++) lim2.check("old-" + i);
  t += 1500;
  lim2.check("fresh"); lim2.check("fresh");
  assert.equal(lim2.size(), 1);
  assert.equal(lim2.check("fresh").ok, false);
});

test("clientIp: headers are trusted only when the mode says so", () => {
  const h = { "x-forwarded-for": "9.9.9.9, 10.0.0.1", "x-real-ip": "8.8.8.8" };
  assert.equal(clientIp(h, "127.0.0.1"), "127.0.0.1", "direct: a caller cannot pick its own address");
  assert.equal(clientIp(h, "127.0.0.1", "direct"), "127.0.0.1");
  assert.equal(clientIp(h, "127.0.0.1", "proxy"), "10.0.0.1", "proxy: the entry our own proxy appended");
  assert.equal(clientIp({}, "127.0.0.1", "proxy"), "127.0.0.1");
  assert.equal(clientIp(h, "127.0.0.1", "vercel"), "8.8.8.8");
  assert.equal(clientIp({ "x-forwarded-for": "7.7.7.7, 1.1.1.1" }, "127.0.0.1", "vercel"), "7.7.7.7");
  assert.equal(clientIp({}, undefined), "unknown");
  assert.equal(clientIp({ "x-real-ip": "x".repeat(500) }, "a", "vercel").length, 64);
  assert.equal(clientIp({ "x-forwarded-for": ["3.3.3.3", "4.4.4.4"] }, "a", "proxy"), "3.3.3.3");
});

test("envInt: a whole number in range, or the default", () => {
  assert.equal(envInt(undefined, 120, 0, 1000), 120);
  assert.equal(envInt("", 120, 0, 1000), 120);
  assert.equal(envInt("5", 120, 0, 1000), 5);
  assert.equal(envInt("0", 120, 0, 1000), 0);
  for (const v of ["-5", "5.5", "abc", "1e3", "1001", " 5", "9".repeat(13)]) assert.equal(envInt(v, 120, 0, 1000), 120, v);
});
