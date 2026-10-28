// Proves INTEGRATORS.md against a cluster, with @solana/web3.js alone: no SDK, no HTTP API.
//
//   node scripts/check-integrators-doc.mjs <rpc url> [--payer <public key>] [--per-kind <n>] [--lookup-table <address>]
//   node scripts/check-integrators-doc.mjs http://127.0.0.1:8899
//
// It finds the pools on the chain and checks what the document states: account sizes,
// every documented offset of the pool, the platform, the launch record, the template
// configs, the collectible config and tickets, the stake and lock records of the rules
// template, discriminators against sha256, PDA seeds, the hook caller of every hook
// program, the quote formula against a simulated swap for each kind of pool it finds
// (inside and outside a launch window), the state of the pool after a swap, events,
// liquidity, fee collection, the errors of the swap, the buy-and-burn rule against a
// simulated `execute_buyback` and `run_burn`, the other instructions of the rules
// template, and the pools on the curve: their fields, the quote with the virtual quote,
// the real-reserve bound, `graduate` simulated on a pool past its target and on a
// graduated one, the refusal of liquidity, and the graduation arithmetic of past
// `Graduated` events. It prints one line per check and exits with 1 when a check fails.
//
// It sends no transaction. Everything is simulated without signatures, so it needs no key:
// only the address of a wallet that holds about 2 SOL, to act as fee payer inside the
// simulations. Without --payer it makes a new address and asks the cluster for an airdrop,
// which works on a local validator and on devnet.
//
// --per-kind <n>        simulate trades on at most n pools of each kind (default 3). The
//                       account checks always cover every pool.
// --lookup-table <key>  also check that the deployment's address lookup table holds what
//                       the document says it holds.
//
// How it reads the document. When INTEGRATORS.md and idl/ sit next to this script's folder,
// as they do in the repository, the tables of the document are compared with the numbers
// used here and with the IDLs. A table is found by the HTML comment on the line before it:
//
//   <!-- layout:NAME size=N -->        rows of offset and size, the same rows as LAYOUT.NAME
//   <!-- errors:IDL -->                rows of number and name, the errors of idl/IDL.json
//   <!-- accounts:IDL.INSTRUCTION -->  one row per account, with its Signer and Writable cells
//   <!-- callers -->                   the hook caller of each hook program
//   <!-- flags -->                     the flags number of each platform template
//
// The comments are invisible in a rendered page. Keep them when you edit the document.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  VersionedMessage, VersionedTransaction,
} from "@solana/web3.js";

// ---- what the document states -----------------------------------------------------------------
const HOOKPOOL = new PublicKey("7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh");
const HOOKLAUNCH = new PublicKey("9cDfF7wD6EirDZbb5DWCw3HZ3ZPQ1oeh87YyMGvbPRxi");
const HOOK = {
  tax: new PublicKey("jwdXDuSQ9pNV1pXj8BFvBb5fhqtTL3duQkwsTjXunhr"),
  launch_guard: new PublicKey("G59xnMnbenifbGR1y6QjaTRa6wa1FFfqZB3KZBUyckPW"),
  buyback: new PublicKey("3M824Hn8Z6S7r1t1zqpNQpioKFd31jrQwSN2oxV2ovo5"),
  collectible: new PublicKey("3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m"),
  rules: new PublicKey("3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr"),
};
/// The flags each template publishes in its manifest, and every pool on it carries.
const TEMPLATE_FLAGS = { tax: 12865, launch_guard: 4421, buyback: 12865, collectible: 4162, rules: 13125 };
/// The IDL file of each program, for the tables of the document that name one.
const IDL_OF = { hookpool: HOOKPOOL, hooklaunch: HOOKLAUNCH, hook_tax: HOOK.tax, hook_launch_guard: HOOK.launch_guard, hook_buyback: HOOK.buyback, hook_collectible: HOOK.collectible, hook_rules: HOOK.rules };
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const SYSTEM = SystemProgram.programId;

/// Discriminators as written in the document, with the name each one is the sha256 of.
const DISC = {
  "account:Pool": [241, 154, 109, 4, 17, 177, 109, 188],
  "account:Platform": [77, 92, 204, 58, 187, 98, 91, 12],
  "account:Launch": [144, 51, 51, 163, 206, 85, 213, 38],
  "account:TaxConfig": [38, 187, 35, 231, 115, 102, 30, 82],
  "account:GuardConfig": [95, 175, 118, 50, 193, 113, 37, 250],
  "account:BuybackConfig": [226, 30, 39, 139, 66, 159, 153, 171],
  "account:CollectionConfig": [223, 110, 152, 160, 174, 157, 106, 255],
  "account:Ticket": [41, 228, 24, 165, 78, 90, 235, 200],
  "account:RulesConfig": [187, 99, 136, 70, 234, 55, 67, 212],
  "account:StakeRecord": [174, 163, 11, 208, 150, 236, 11, 205],
  "account:LockRecord": [157, 145, 17, 26, 171, 35, 61, 131],
  "account:HolderRecord": [215, 67, 31, 41, 155, 251, 178, 128],
  "global:hook_swap": [122, 98, 77, 213, 6, 114, 102, 250],
  "global:hook_buy_burn": [8, 103, 173, 214, 106, 75, 167, 33],
  "global:init_strict_config": [75, 34, 171, 72, 212, 105, 211, 38],
  "global:open_holder": [138, 210, 211, 159, 140, 172, 28, 65],
  "global:claim_holder": [155, 200, 53, 56, 103, 22, 12, 161],
  "global:sync_holder": [33, 218, 181, 194, 137, 165, 224, 210],
  "global:close_holder": [88, 22, 239, 228, 245, 64, 37, 78],
  "global:lock_creator_strict": [95, 63, 12, 246, 255, 133, 33, 131],
  "global:unlock_creator_strict": [165, 65, 106, 11, 205, 9, 40, 136],
  "global:run_burn_strict": [159, 241, 149, 218, 41, 46, 171, 38],
  /// the transfer hook's Execute instruction, and the key of a coin's account list
  "spl-transfer-hook-interface:execute": [105, 37, 101, 197, 75, 251, 102, 26],
  "global:execute_buyback": [47, 32, 19, 100, 184, 96, 144, 49],
  "global:run_burn": [28, 101, 229, 246, 103, 87, 18, 16],
  "global:stake": [206, 176, 202, 18, 200, 209, 179, 108],
  "global:unstake": [90, 95, 107, 42, 205, 124, 50, 225],
  "global:claim_rewards": [4, 144, 132, 71, 116, 23, 151, 80],
  "global:claim_creator": [231, 240, 197, 249, 244, 10, 21, 59],
  "global:lock_creator": [68, 25, 135, 252, 161, 20, 52, 207],
  "global:unlock_creator": [27, 121, 55, 205, 155, 241, 167, 230],
  "global:swap": [248, 198, 158, 145, 225, 117, 135, 200],
  "global:add_liquidity": [181, 157, 89, 67, 143, 182, 52, 72],
  "global:remove_liquidity": [80, 85, 209, 72, 24, 206, 177, 108],
  "global:collect_hook_fees": [161, 80, 95, 45, 41, 49, 96, 93],
  "global:open_ticket": [154, 120, 166, 69, 155, 111, 27, 207],
  "global:open_ticket_for": [207, 104, 147, 202, 15, 229, 57, 135],
  "global:settle": [175, 42, 185, 87, 144, 131, 102, 212],
  // the curve (section 14)
  "global:graduate": [45, 235, 225, 181, 17, 218, 64, 130],
  "global:create_curve_pool": [92, 46, 170, 252, 226, 105, 215, 157],
  "global:launch_curve": [109, 19, 238, 79, 112, 150, 113, 219],
  "event:CurveOpened": [222, 62, 115, 103, 123, 108, 79, 149],
  "event:Graduated": [51, 241, 66, 50, 140, 245, 156, 192],
  "event:Swapped": [217, 52, 52, 83, 147, 135, 96, 109],
  "event:PoolCreated": [202, 44, 41, 88, 104, 220, 157, 82],
  "event:LiquidityChanged": [132, 132, 193, 214, 12, 99, 40, 28],
  "event:Launched": [209, 127, 29, 152, 129, 212, 189, 183],
  "event:BuybackExecuted": [150, 109, 157, 10, 124, 24, 38, 189],
  "event:BurnExecuted": [148, 9, 16, 114, 196, 85, 217, 2],
  "event:Staked": [11, 146, 45, 205, 230, 58, 213, 240],
  "event:Unstaked": [27, 179, 156, 215, 47, 71, 195, 7],
  "event:RewardsClaimed": [75, 98, 88, 18, 219, 112, 88, 121],
  "event:CreatorClaimed": [118, 206, 30, 219, 62, 164, 54, 200],
  "event:CreatorLocked": [236, 6, 11, 225, 235, 131, 19, 250],
  "event:CreatorUnlocked": [123, 215, 182, 89, 245, 169, 75, 154],
  "event:HolderOpened": [133, 172, 228, 247, 214, 213, 195, 160],
  "event:HolderClaimed": [135, 192, 236, 75, 181, 166, 203, 87],
  "event:HolderSynced": [65, 47, 59, 202, 75, 82, 26, 121],
  "event:HolderClosed": [75, 130, 114, 152, 178, 171, 89, 93],
  "event:HookFeesCollected": [9, 60, 154, 77, 40, 27, 96, 111],
  "event:ProtocolFeesCollected": [165, 34, 125, 155, 15, 86, 99, 191],
  "event:TokenCreated": [236, 19, 41, 255, 130, 78, 147, 172],
  "event:PiecesEarned": [212, 211, 116, 170, 229, 104, 148, 129],
  "event:PiecesCancelled": [102, 58, 224, 15, 114, 161, 31, 151],
  "event:PiecesTransferred": [180, 181, 161, 207, 66, 8, 176, 169],
  "event:PieceBurned": [178, 48, 28, 62, 239, 160, 146, 227],
  "event:PieceMinted": [104, 29, 116, 162, 88, 116, 224, 25],
  // one approval: a mint that took from a wallet's deposit, and a withdrawal of it
  "event:DepositUsed": [61, 253, 173, 67, 126, 32, 170, 27],
  "event:DepositWithdrawn": [152, 139, 194, 204, 237, 235, 26, 134],
  /// the key of a hook's extra-accounts list
  "hookpool-interface:callback": [60, 167, 17, 250, 28, 149, 188, 66],
};
const EVENT_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const POOL_FILTER = "hQrXeCntzbV";    // base58 of the pool discriminator
const LAUNCH_FILTER = "R7vQE78exjo";  // base58 of the launch record discriminator

/// Layouts as [offset, size] rows, the same rows as the tables of the document. `idl` names
/// the IDL types the layout is a view of: [IDL file, type, bytes before the first field]
/// (8 for an account, whose discriminator comes first; 0 for an event's fields).
const LAYOUT = {
  pool: { size: 528, idl: [["hookpool", "Pool", 8]], rows: [[0, 8], [8, 1], [9, 32], [41, 32], [73, 32], [105, 32], [137, 32], [169, 32], [201, 32], [233, 32], [265, 2], [267, 32], [299, 4], [303, 32], [335, 32], [367, 1], [368, 8], [376, 8], [384, 8], [392, 8], [400, 8], [408, 8], [416, 8], [424, 8], [432, 32], [464, 8], [472, 32], [504, 8], [512, 8], [520, 2], [522, 1], [523, 5]] },
  platform: { size: 451, idl: [["hookpool", "Platform", 8]], rows: [[0, 8], [8, 1], [9, 32], [41, 32], [73, 32], [105, 2], [107, 2], [109, 2], [111, 2], [113, 8], [121, 1], [122, 1], [123, 256], [379, 8], [387, 8], [395, 8], [403, 2], [405, 1], [406, 45]] },
  launch: { size: 265, idl: [["hooklaunch", "Launch", 8]], rows: [[0, 8], [8, 1], [9, 32], [41, 32], [73, 32], [105, 32], [137, 32], [169, 8], [177, 8], [185, 8], [193, 8], [201, 64]] },
  tax_config: { size: 111, idl: [["hook_tax", "TaxConfig", 8]], rows: [[0, 8], [8, 1], [9, 32], [41, 32], [73, 2], [75, 2], [77, 2], [79, 32]] },
  guard_config: { size: 91, idl: [["hook_launch_guard", "GuardConfig", 8]], rows: [[0, 8], [8, 1], [9, 32], [41, 8], [49, 8], [57, 2], [59, 32]] },
  buyback_config: { size: 230, idl: [["hook_buyback", "BuybackConfig", 8]], rows: [[0, 8], [8, 1], [9, 1], [10, 32], [42, 32], [74, 32], [106, 32], [138, 2], [140, 2], [142, 8], [150, 8], [158, 8], [166, 8], [174, 32], [206, 8], [214, 8], [222, 8]] },
  rules_config: { size: 414, idl: [["hook_rules", "RulesConfig", 8]], rows: [[0, 8], [8, 1], [9, 1], [10, 32], [42, 32], [74, 32], [106, 32], [138, 32], [170, 8], [178, 2], [180, 6], [186, 6], [192, 8], [200, 8], [208, 8], [216, 8], [224, 8], [232, 8], [240, 8], [248, 6], [254, 8], [262, 8], [270, 16], [286, 8], [294, 8], [302, 8], [310, 8], [318, 8], [326, 8], [334, 8], [342, 8], [350, 8], [358, 8], [366, 8], [374, 1], [375, 1], [376, 1], [377, 2], [379, 2], [381, 4], [385, 4], [389, 8], [397, 17]] },
  holder_record: { size: 129, idl: [["hook_rules", "HolderRecord", 8]], rows: [[0, 8], [8, 1], [9, 32], [41, 32], [73, 8], [81, 16], [97, 8], [105, 8], [113, 8], [121, 8]] },
  strict_args: { size: 12, idl: [["hook_rules", "StrictArgs", 0]], rows: [[0, 2], [2, 4], [6, 2], [8, 4]] },
  hook_buy_burn_data: { size: 25, rows: [[0, 8], [8, 8], [16, 8], [24, 1]] },
  /// `HolderOpened`, `HolderSynced` and `HolderClaimed`
  holder_event: { size: 72, idl: [["hook_rules", "HolderOpened", 0], ["hook_rules", "HolderSynced", 0], ["hook_rules", "HolderClaimed", 0]], rows: [[0, 32], [32, 32], [64, 8]] },
  stake_record: { size: 113, idl: [["hook_rules", "StakeRecord", 8]], rows: [[0, 8], [8, 1], [9, 32], [41, 32], [73, 8], [81, 16], [97, 8], [105, 8]] },
  lock_record: { size: 57, idl: [["hook_rules", "LockRecord", 8]], rows: [[0, 8], [8, 1], [9, 32], [41, 8], [49, 8]] },
  collection_config: { size: 359, rows: [[0, 8], [8, 3], [11, 32], [43, 32], [75, 32], [107, 32], [139, 32], [171, 32], [203, 1], [204, 8], [212, 4], [216, 4], [220, 4], [224, 4], [228, 1], [229, 2], [231, 16], [247, 112]] },
  ticket: { size: 346, rows: [[0, 8], [8, 1], [9, 32], [41, 32], [73, 4], [77, 4], [81, 1], [82, 8], [90, 252], [342, 4], [346, 0]] },
  batch: { size: 63, rows: [[0, 1], [1, 1], [2, 1], [3, 4], [7, 8], [15, 32], [47, 16]] },
  swap_data: { size: 25, rows: [[0, 8], [8, 1], [9, 8], [17, 8]] },
  swapped: { size: 132, idl: [["hookpool", "Swapped", 0]], rows: [[0, 32], [32, 32], [64, 1], [65, 8], [73, 8], [81, 8], [89, 8], [97, 8], [105, 2], [107, 8], [115, 8], [123, 8], [131, 1]] },
  hook_fees_collected: { size: 72, idl: [["hookpool", "HookFeesCollected", 0]], rows: [[0, 32], [32, 32], [64, 8]] },
  curve_opened: { size: 58, idl: [["hookpool", "CurveOpened", 0]], rows: [[0, 32], [32, 8], [40, 8], [48, 2], [50, 8]] },
  graduated: { size: 88, idl: [["hookpool", "Graduated", 0]], rows: [[0, 32], [32, 8], [40, 8], [48, 8], [56, 8], [64, 8], [72, 8], [80, 8]] },
  /// `BuybackExecuted` of the buyback hook and `BurnExecuted` of the rules hook: the same fields
  burn_executed: { size: 73, idl: [["hook_buyback", "BuybackExecuted", 0], ["hook_rules", "BurnExecuted", 0]], rows: [[0, 32], [32, 8], [40, 8], [48, 8], [56, 1], [57, 8], [65, 8]] },
  /// the return data of `execute_buyback` and `run_burn`
  burn_result: { size: 17, rows: [[0, 1], [1, 8], [9, 8]] },
  /// `Staked` and `Unstaked`
  staked: { size: 96, idl: [["hook_rules", "Staked", 0], ["hook_rules", "Unstaked", 0]], rows: [[0, 32], [32, 32], [64, 8], [72, 8], [80, 8], [88, 8]] },
  creator_locked: { size: 88, idl: [["hook_rules", "CreatorLocked", 0]], rows: [[0, 32], [32, 32], [64, 8], [72, 8], [80, 8]] },
};
const FLAG = { BEFORE_SWAP: 1 << 0, AFTER_SWAP: 1 << 1, BEFORE_ADD_LIQ: 1 << 2, LIQUIDITY: (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5), ON_POOL_CREATE: 1 << 6, OVERRIDE_FEE: 1 << 8, TAKE_HOOK_FEE: 1 << 9, OVERRIDE_CURVE: 1 << 10, CALL_ON_BUY: 1 << 12, CALL_ON_SELL: 1 << 13 };
/// Errors of the pool program named in the document.
const ERR = { Paused: 6000, ZeroAmount: 6006, BadDirection: 6007, Slippage: 6008, InputAboveMax: 6009, MathOverflow: 6010, InsufficientLiquidity: 6011, MintExtensionNotAllowed: 6014, TokenProgramMismatch: 6015, HookProgramMismatch: 6023, HookExtraMetasAddress: 6025, HookExtraAccounts: 6027, HookTreasuryMismatch: 6029, BadHookReturn: 6032, HookPowerNotGranted: 6033, HookCurveInvalid: 6035, HookAuthorityMismatch: 6037, NoHook: 6038, NothingToCollect: 6040, BaseMintFreezable: 6042, HookNotApproved: 6052, HookAlreadyApproved: 6053, HookApprovalNotNeeded: 6054, TooManyApprovedHooks: 6055, ApprovedListCorrupt: 6056,
  CurveDisabled: 6043, CurveSupplyNotInPool: 6044, CurveOpen: 6045, CurveHook: 6046, NotOnCurve: 6047, GraduationNotReached: 6048, CurveRealReserve: 6049, CurvePegged: 6050, CurveSettingsOutOfBounds: 6051 };
/// Errors of the launchpad named in the document.
const LAUNCH_ERR = { CurvePegged: 6011 };
/// The curve (section 14): the states at pool offset 522, and the platform's bounds.
const CURVE_NONE = 0, CURVE_OPEN = 1, CURVE_GRADUATED = 2;
const MAX_GRADUATION_FEE_BPS = 1000, MAX_CURVE_VIRTUAL_QUOTE = ((1n << 64n) - 1n) / 4n;
/// Errors of the three hooks whose tables the document gives in full. Every program numbers
/// its errors from 6000, so a number means nothing without the program that failed.
const GUARD_ERR = { StartFeeTooHigh: 6000, WindowTooLong: 6001, WindowTooShort: 6002, WrongPool: 6003, AlreadyArmed: 6004, WrongCreator: 6005, WrongHook: 6006, LiquidityInGuardWindow: 6007 };
const BUYBACK_ERR = { TaxTooHigh: 6000, WrongPool: 6001, WrongTreasury: 6002, WrongMints: 6003, BelowThreshold: 6004, NothingBought: 6005, WrongCreator: 6006, TooSoon: 6007, MinQuoteTooHigh: 6008 };
const RULES_ERR = {
  CreatorFeeTooHigh: 6000, HoldersFeeTooHigh: 6001, BurnFeeTooHigh: 6002, SideTooHigh: 6003, StartFeeTooHigh: 6004, SniperWindowTooLong: 6005, SniperIncomplete: 6006, LimitWindowTooLong: 6007,
  LimitIncomplete: 6008, LockTooLong: 6009, WrongPool: 6010, WrongHook: 6011, WrongCreator: 6012, WrongMints: 6013, WrongTreasury: 6014, AlreadyStarted: 6015, NotStarted: 6016, BuyTooLarge: 6017,
  ZeroAmount: 6018, UnstakeTooEarly: 6019, InsufficientStake: 6020, NothingToClaim: 6021, NotCreator: 6022, NothingToBurn: 6023, NothingBought: 6024, UnlockEarlier: 6025, UnlockBeforeDeclared: 6026,
  UnlockTooFar: 6027, UnlockInPast: 6028, StillLocked: 6029, NothingLocked: 6030, MathOverflow: 6031, BurnTooSoon: 6032, LiquidityInSniperWindow: 6033,
  StrictCoin: 6034, NotStrict: 6035, WrongKind: 6036, StrictNoBurn: 6037, MaxWalletOutOfBounds: 6038, MaxWalletIncomplete: 6039, EarlyOutOfBounds: 6040, EarlyIncomplete: 6041, NotATransfer: 6042,
  NotAssociatedAccount: 6043, MaxWallet: 6044, EarlyLocked: 6045, CreatorLocked: 6046, HolderRecordRequired: 6047, LiquidityInMaxWalletWindow: 6048, HolderNotEmpty: 6049, WrongHolder: 6050, LockAboveBalance: 6051,
};
/// The strict coin's bounds (RULES.md, "The strict coin").
const STRICT = { maxWalletBpsMin: 10, maxWalletBpsMax: 5000, maxWalletSlots: 6_480_000n, earlySlots: 9000, earlyUnlockSlots: 1_512_000n };
const ERR_OF = { hookpool: ERR, hooklaunch: LAUNCH_ERR, hook_launch_guard: GUARD_ERR, hook_buyback: BUYBACK_ERR, hook_rules: RULES_ERR };
/// Tables of the document that list every error of their program, not a choice of them.
const FULL_ERROR_TABLES = ["hook_launch_guard", "hook_buyback", "hook_rules"];
/// Errors of the Anchor framework the document names.
const ANCHOR_ERR = { ConstraintMut: 2000, ConstraintHasOne: 2001, ConstraintSeeds: 2006, ConstraintTokenMint: 2014, ConstraintTokenOwner: 2015, ConstraintDuplicateMutableAccount: 2040, AccountNotEnoughKeys: 3005, AccountNotInitialized: 3012 };
/// The buy-and-burn rule (section 12 of the document).
const BURN_INTERVAL_SLOTS = 25n, MAX_BURN_CAP_BPS = 50n, MIN_BURN_CAP_BPS = 1n;
const BURN_OBSERVED = 1, BURN_WAITED = 2, BURN_BOUGHT = 3;
const UNSTAKE_DELAY_SLOTS = 9000n, ACC_SCALE = 10n ** 12n, MAX_LOCK_SECONDS = 365n * 86400n;
const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

// ---- reporting ------------------------------------------------------------------------------------
let checks = 0, failed = 0, notes = 0;
let held = null; // lines of a guarded block, waiting to know whether the pool moved meanwhile
function check(ok, text) { if (held) { held.push([ok, text]); return ok; } checks++; if (!ok) failed++; console.log((ok ? "ok    " : "FAIL  ") + text); return ok; }
function eq(a, b, text) { return check(a === b, text + (a === b ? "" : "  (got " + a + ", expected " + b + ")")); }
function note(text) { if (held) { held.push([null, text]); return; } notes++; console.log("note  " + text); }

// ---- small tools ------------------------------------------------------------------------------------
const sha8 = (s) => [...createHash("sha256").update(s).digest().subarray(0, 8)];
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const starts = (d, disc) => d.length >= disc.length && disc.every((x, i) => d[i] === x);
const key = (d, at) => new PublicKey(d.subarray(at, at + 32));
const u64 = (d, at) => d.readBigUInt64LE(at);
const u128 = (d, at) => d.readBigUInt64LE(at) | (d.readBigUInt64LE(at + 8) << 64n);
const zeros =(d, at, n) => d.subarray(at, at + n).every((b) => b === 0);
const pdaOf = (seeds, program) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s instanceof PublicKey ? s.toBuffer() : s)), program)[0];
const bumpOf = (seeds, program) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s instanceof PublicKey ? s.toBuffer() : s)), program)[1];
const ataOf = (owner, mint, tokenProgram = TOKEN) => pdaOf([owner, tokenProgram, mint], ATA_PROGRAM);
const short = (k) => k.toBase58().slice(0, 8);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes) { let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = "1" + s; else break; } return s; }
function b58decode(s) { let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c)); const o = []; for (; n > 0n; n >>= 8n) o.unshift(Number(n & 0xffn)); for (const c of s) { if (c === "1") o.unshift(0); else break; } return Buffer.from(o); }
const isqrt = (n) => { if (n < 2n) return n; let x = BigInt(Math.floor(Math.sqrt(Number(n)))); while (x * x > n) x--; while ((x + 1n) * (x + 1n) <= n) x++; return x; };

const PLATFORM = pdaOf(["platform"], HOOKPOOL);
/// The hook caller: one address per hook program. A pool without a hook has the system
/// program (32 zero bytes) in its hook field, so its caller is derived from that.
const callerOf = (hookProgram) => pdaOf(["caller", hookProgram], HOOKPOOL);
/// ["caller"] alone, without a hook program: the one address that would fit every pool if
/// there were such a thing. No pool accepts it.
const OLD_CALLER = pdaOf(["caller"], HOOKPOOL);
const EVENT_AUTHORITY = pdaOf(["__event_authority"], HOOKPOOL);
const eventAuthorityOf = (program) => pdaOf(["__event_authority"], program);
const hookAuthorityOf = (poolKey, hookProgram) => pdaOf(["hook-authority", poolKey], hookProgram);

/// The end of an IDL type that starts at `at`, or null when its size is not fixed. Every
/// offset a field starts at is added to `marks`.
function idlSpan(idl, type, at, marks) {
  if (typeof type === "string") {
    const n = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 }[type];
    if (!n) return null;
    marks.add(at);
    return at + n;
  }
  if (type.array) { marks.add(at); let end = at; for (let i = 0; i < type.array[1] && end !== null; i++) end = idlSpan(idl, type.array[0], end, new Set()); return end; }
  if (type.defined) {
    const t = (idl.types || []).find((x) => x.name === type.defined.name);
    if (!t || t.type.kind !== "struct") return null;
    let end = at;
    for (const f of t.type.fields) { end = idlSpan(idl, f.type, end, marks); if (end === null) return null; }
    return end;
  }
  return null;
}

function decodePool(d) {
  return {
    baseMint: key(d, 9), quoteMint: key(d, 41), baseVault: key(d, 73), quoteVault: key(d, 105), lpMint: key(d, 137), lpLock: key(d, 169),
    baseTokenProgram: key(d, 201), quoteTokenProgram: key(d, 233), lpFeeBps: d.readUInt16LE(265), hookProgram: key(d, 267), hookFlags: d.readUInt32LE(299),
    hookExtraMetas: key(d, 303), hookTreasury: key(d, 335), hookKind: d[367], reserveBase: u64(d, 368), reserveQuote: u64(d, 376),
    protocolFeesBase: u64(d, 384), protocolFeesQuote: u64(d, 392), hookFeesCharged: u64(d, 400), volume: u64(d, 408), swaps: u64(d, 416),
    createdSlot: u64(d, 424), creator: key(d, 432), hookFeesOwed: u64(d, 464), treasuryOwner: key(d, 472),
    virtualQuote: u64(d, 504), graduationTarget: u64(d, 512), graduationFeeBps: d.readUInt16LE(520), curveState: d[522],
  };
}
const decodePlatform = (d) => ({
  treasury: key(d, 73), protocolFeeBps: d.readUInt16LE(105), maxLpFeeBps: d.readUInt16LE(107), maxHookFeeBps: d.readUInt16LE(109), maxFeeOverrideBps: d.readUInt16LE(111), launchFee: u64(d, 113), paused: d[121] !== 0, whitelistLen: d[122], poolCount: u64(d, 379),
  curveVirtualQuote: u64(d, 387), curveGraduationTarget: u64(d, 395), curveGraduationFeeBps: d.readUInt16LE(403),
});
/// The quote reserve a price is made of (section 5): the real one plus, on the curve, the virtual one.
const effectiveQuote = (p) => p.reserveQuote + p.virtualQuote;
/// What `graduate` does to a pool's reserves (section 14). null below the target.
function graduationOf(reserveBase, reserveQuote, virtualQuote, target, feeBps) {
  if (reserveQuote < target || reserveQuote === 0n) return null;
  const wanted = (target * BigInt(feeBps)) / 10000n;
  const fee = wanted < reserveQuote - 1n ? wanted : reserveQuote - 1n;
  const quoteAfter = reserveQuote - fee;
  const baseAfter = (quoteAfter * reserveBase) / (reserveQuote + virtualQuote);
  return { fee, quoteAfter, baseAfter, burned: reserveBase - baseAfter };
}
/// Is the price kept, from (q1 / b1) to (q2 / b2): never down, up by less than one unit of the coin?
const priceKept = (q1, b1, q2, b2) => q2 * b1 >= q1 * b2 && q2 * b1 < q1 * (b2 + 1n);
const hasHook = (p) => !p.hookProgram.equals(SYSTEM);
const called = (p, cb, isBuy) => hasHook(p) && (p.hookFlags & cb) !== 0 && (p.hookFlags & (isBuy ? FLAG.CALL_ON_BUY : FLAG.CALL_ON_SELL)) !== 0;
const templateOf = (p) => !hasHook(p) ? "none" : Object.keys(HOOK).find((k) => HOOK[k].equals(p.hookProgram)) || "custom";

// ---- the quote of the document ------------------------------------------------------------------------
const fee = (amount, bps) => (bps === 0 || amount === 0n ? 0n : (amount * BigInt(bps) + 9999n) / 10000n);
/// `virtualQuote` is the pool's at offset 504: 0 off the curve. The quote side of the
/// product is `reserveQuote + virtualQuote`; the reserves returned are the real ones, and
/// `beyondReal` says that a sell would take more than the real quote reserve (6049).
function quote(reserveBase, reserveQuote, lpFeeBps, protocolFeeBps, isBuy, amountIn, hookFeeBps, feeOverrideBps, virtualQuote = 0n) {
  const quoteSide = reserveQuote + virtualQuote;
  const [rIn, rOut] = isBuy ? [quoteSide, reserveBase] : [reserveBase, quoteSide];
  const protocolFee = fee(amountIn, protocolFeeBps);
  let left = amountIn - protocolFee;
  const hookFeeIn = isBuy ? fee(left, hookFeeBps) : 0n;
  left -= hookFeeIn;
  const feeBps = feeOverrideBps ?? lpFeeBps;
  const lpFee = fee(left, feeBps);
  const netIn = left - lpFee;
  const gross = rIn + netIn > 0n ? (rOut * netIn) / (rIn + netIn) : 0n;
  const hookFeeOut = isBuy ? 0n : fee(gross, hookFeeBps);
  const out = gross - hookFeeOut;
  const [quoteAfter, baseAfter] = isBuy ? [reserveQuote + netIn + lpFee, reserveBase - gross] : [reserveQuote - gross, reserveBase + netIn + lpFee];
  return { out, gross, netIn, protocolFee, lpFee, hookFee: hookFeeIn + hookFeeOut, feeBps, reserveBase: baseAfter, reserveQuote: quoteAfter, beyondReal: !isBuy && gross > reserveQuote };
}
/// The fee of a buy inside a launch window: a straight line from the start fee in the slot
/// the pool was created to the pool's own fee `slots` later, clamped to the platform's cap.
/// null once the window is over. The launch guard and the sniper fee of a rules coin share it.
function windowFeeBps(start, slots, startFee, lpFeeBps, slot, maxOverride) {
  const elapsed = BigInt(slot) > start ? BigInt(slot) - start : 0n;
  if (start === 0n || startFee <= lpFeeBps || slots === 0n || elapsed >= slots) return null;
  return Math.min(startFee - Number((BigInt(startFee - lpFeeBps) * elapsed) / slots), maxOverride);
}
const guardFeeBps = (cfg, lpFeeBps, slot, maxOverride) => windowFeeBps(u64(cfg, 41), u64(cfg, 49), cfg.readUInt16LE(57), lpFeeBps, slot, maxOverride);
/// The config of a rules pool, at the offsets of the document.
function decodeRules(c) {
  const rates = (at) => ({ creator: c.readUInt16LE(at), holders: c.readUInt16LE(at + 2), burn: c.readUInt16LE(at + 4) });
  return {
    pool: key(c, 10), baseMint: key(c, 42), quoteMint: key(c, 74), treasury: key(c, 106), creator: key(c, 138),
    sniperSlots: u64(c, 170), sniperStartFeeBps: c.readUInt16LE(178), buy: rates(180), sell: rates(186), maxBuyQuote: u64(c, 192), limitSlots: u64(c, 200), creatorLockSeconds: u64(c, 208),
    startSlot: u64(c, 216), startTime: c.readBigInt64LE(224), minEligible: u64(c, 232), feesSeen: u64(c, 240), lastSplit: rates(248), creatorOwed: u64(c, 254), burnPot: u64(c, 262),
    accPerShare: u128(c, 270), rewardRem: u64(c, 286), totalStaked: u64(c, 294), rewardsOwedTotal: u64(c, 302), totalCreatorPaid: u64(c, 310), totalRewardsPaid: u64(c, 318),
    totalQuoteBurned: u64(c, 326), totalBaseBurned: u64(c, 334), burns: u64(c, 342), obsSlot: u64(c, 350), obsBase: u64(c, 358), obsQuote: u64(c, 366),
  };
}
const ratesSum = (r) => r.creator + r.holders + r.burn;
const sniperFeeBps = (r, lpFeeBps, slot, maxOverride) => windowFeeBps(r.startSlot, r.sniperSlots, r.sniperStartFeeBps, lpFeeBps, slot, maxOverride);
/// Is a buy of `amountIn` refused by the buy limit of a rules coin in this slot?
const aboveBuyLimit = (r, amountIn, slot) => r.maxBuyQuote > 0n && (BigInt(slot) > r.startSlot ? BigInt(slot) - r.startSlot : 0n) < r.limitSlots && amountIn > r.maxBuyQuote;
/// What a template hook answers. `exact: false` for a hook this script cannot predict.
/// `window`: the pool fee of this buy was replaced by a fee that depends on the slot.
function hookAnswer(pool, platform, cfg, isBuy, slot) {
  const a = { hookFeeBps: 0, feeOverrideBps: null, exact: true };
  const t = templateOf(pool);
  if (!called(pool, FLAG.BEFORE_SWAP, isBuy)) return { ...a, canRefuse: t === "custom" && called(pool, FLAG.AFTER_SWAP, isBuy) };
  if (t === "tax" && cfg) return { ...a, hookFeeBps: Math.min(cfg.readUInt16LE(isBuy ? 73 : 75), platform.maxHookFeeBps) };
  if (t === "buyback" && cfg) return { ...a, hookFeeBps: Math.min(cfg.readUInt16LE(isBuy ? 138 : 140), platform.maxHookFeeBps) };
  if (t === "launch_guard" && cfg) { const f = isBuy ? guardFeeBps(cfg, pool.lpFeeBps, slot, platform.maxFeeOverrideBps) : null; return { ...a, feeOverrideBps: f, window: f !== null }; }
  if (t === "rules" && cfg) {
    const r = decodeRules(cfg);
    const f = isBuy ? sniperFeeBps(r, pool.lpFeeBps, slot, platform.maxFeeOverrideBps) : null;
    return { ...a, hookFeeBps: Math.min(ratesSum(isBuy ? r.buy : r.sell), platform.maxHookFeeBps), feeOverrideBps: f, window: f !== null };
  }
  return { ...a, exact: false };
}

// ---- the buy-and-burn rule of the document (section 12) --------------------------------------------------
const minB = (a, b) => (a < b ? a : b), maxB = (a, b) => (a > b ? a : b);
/// The most one buy of a buyback or a burn may spend, in bps of the pool's quote reserve.
function burnCapBps(protocolFeeBps, lpFeeBps, buyFeeBps, sellFeeBps) {
  const sure = BigInt(protocolFeeBps + buyFeeBps + sellFeeBps), soft = BigInt(protocolFeeBps + 2 * lpFeeBps);
  return maxB(MIN_BURN_CAP_BPS, minB(MAX_BURN_CAP_BPS, (sure + minB(sure, soft)) / 4n));
}
/// The burn share of what one side of a rules pool really pays.
const burnSide = (r, maxHook) => { const t = ratesSum(r); return t === 0 ? 0 : Math.floor((Math.min(t, maxHook) * r.burn) / t); };
const rulesCapBps = (r, platform, lpFeeBps) => burnCapBps(platform.protocolFeeBps, lpFeeBps, burnSide(r.buy, platform.maxHookFeeBps), burnSide(r.sell, platform.maxHookFeeBps));
const buybackCapBps = (cfg, platform, lpFeeBps) => burnCapBps(platform.protocolFeeBps, lpFeeBps, Math.min(cfg.readUInt16LE(138), platform.maxHookFeeBps), Math.min(cfg.readUInt16LE(140), platform.maxHookFeeBps));
/// What a call of `execute_buyback` or `run_burn` does in `slot`, with `pot` to spend.
function burnStep(obs, reserveBase, reserveQuote, slot, capBps, pot) {
  if (obs.base === 0n || obs.quote === 0n) return { step: "observe", outcome: BURN_OBSERVED };
  if (BigInt(slot) < obs.slot + BURN_INTERVAL_SLOTS) return { step: "too soon" };
  if (reserveQuote * obs.base * 10000n > obs.quote * reserveBase * (10000n + 2n * capBps)) return { step: "wait", outcome: BURN_WAITED };
  return { step: "buy", outcome: BURN_BOUGHT, spend: minB(pot, maxB(1n, (minB(reserveQuote, obs.quote) * capBps) / 10000n)) };
}
/// Did a trade that starts at these reserves start below the observed price?
const burnPriceFell = (obs, reserveBase, reserveQuote) => obs.base !== 0n && obs.quote !== 0n && reserveQuote * obs.base < obs.quote * reserveBase;
/// What a swap that starts at these reserves makes of the observation, in the hook's
/// before_swap: null when the trade does not start below the observed price. The price
/// moves down to the price the trade starts at; the depth is never raised. The slot stays.
function burnLowered(obs, reserveBase, reserveQuote) {
  if (reserveBase === 0n || reserveQuote === 0n || !burnPriceFell(obs, reserveBase, reserveQuote)) return null;
  const quote = minB(reserveQuote, obs.quote);
  return { slot: obs.slot, base: (quote * reserveBase + reserveQuote - 1n) / reserveQuote, quote };
}
/// The settlement of a rules config, on a copy: what the next instruction of the hook does
/// first with the hook fee of the last trade.
function settleRules(r, pool) {
  const s = { ...r };
  const paid = pool.hookFeesCharged > pool.hookFeesOwed ? pool.hookFeesCharged - pool.hookFeesOwed : 0n;
  const fresh = paid > s.feesSeen ? paid - s.feesSeen : 0n;
  if (fresh === 0n) return s;
  s.feesSeen = paid;
  const c = BigInt(s.lastSplit.creator), h = BigInt(s.lastSplit.holders), t = c + h + BigInt(s.lastSplit.burn);
  const creator = t === 0n ? 0n : (fresh * c) / t, holders = t === 0n ? 0n : (fresh * h) / t;
  let burn = fresh - creator - holders;
  if (holders > 0n) {
    if (!(s.totalStaked > 0n && s.totalStaked >= s.minEligible)) burn += holders;
    else { const n = holders * ACC_SCALE + s.rewardRem; s.accPerShare += n / s.totalStaked; s.rewardRem = n % s.totalStaked; }
  }
  s.creatorOwed += creator;
  s.burnPot += burn;
  return s;
}

// ---- instructions -----------------------------------------------------------------------------------------
const ro = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey, w = false) => ({ pubkey, isSigner: true, isWritable: w });
function swapIx(poolKey, pool, user, userBase, userQuote, direction, amountIn, minOut, extra, over = {}) {
  const treasury = over.treasury ?? (pool.hookTreasury.equals(PublicKey.default) ? userQuote : pool.hookTreasury);
  const keys = [
    signer(user), ro(PLATFORM), rw(poolKey), ro(pool.baseMint), ro(pool.quoteMint), rw(pool.baseVault), rw(pool.quoteVault), rw(userBase), rw(userQuote), rw(treasury),
    ro(over.hookProgram ?? pool.hookProgram), ro(over.extraMetas ?? pool.hookExtraMetas), ro(over.caller ?? callerOf(pool.hookProgram)), ro(over.baseTokenProgram ?? pool.baseTokenProgram), ro(pool.quoteTokenProgram), ro(EVENT_AUTHORITY), ro(HOOKPOOL), ...extra,
  ];
  const data = Buffer.alloc(25);
  Buffer.from(DISC["global:swap"]).copy(data, 0);
  data.writeUInt8(direction, 8); data.writeBigUInt64LE(amountIn, 9); data.writeBigUInt64LE(minOut, 17);
  return new TransactionInstruction({ programId: HOOKPOOL, keys, data });
}
function liquidityIx(name, poolKey, pool, user, userBase, userQuote, userLp, lpAmount, a, b, extra) {
  const keys = [
    signer(user), ro(PLATFORM), rw(poolKey), ro(pool.baseMint), ro(pool.quoteMint), rw(pool.baseVault), rw(pool.quoteVault), rw(pool.lpMint), rw(userBase), rw(userQuote), rw(userLp),
    ro(pool.hookProgram), ro(pool.hookExtraMetas), ro(callerOf(pool.hookProgram)), ro(pool.baseTokenProgram), ro(pool.quoteTokenProgram), ro(TOKEN), ro(EVENT_AUTHORITY), ro(HOOKPOOL), ...extra,
  ];
  const data = Buffer.alloc(32);
  Buffer.from(DISC["global:" + name]).copy(data, 0);
  data.writeBigUInt64LE(lpAmount, 8); data.writeBigUInt64LE(a, 16); data.writeBigUInt64LE(b, 24);
  return new TransactionInstruction({ programId: HOOKPOOL, keys, data });
}
const collectHookFeesIx = (poolKey, pool) => new TransactionInstruction({ programId: HOOKPOOL, data: Buffer.from(DISC["global:collect_hook_fees"]), keys: [rw(poolKey), ro(pool.quoteMint), rw(pool.quoteVault), rw(pool.hookTreasury), ro(pool.quoteTokenProgram)] });
/// `graduate` of section 14: seven accounts, no signer, no argument.
const graduateIx = (poolKey, pool) => new TransactionInstruction({ programId: HOOKPOOL, data: Buffer.from(DISC["global:graduate"]), keys: [ro(PLATFORM), rw(poolKey), rw(pool.baseMint), rw(pool.baseVault), ro(pool.baseTokenProgram), ro(EVENT_AUTHORITY), ro(HOOKPOOL)] });
const createAta = (payer, owner, mint, tokenProgram = TOKEN) => new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [signer(payer, true), rw(ataOf(owner, mint, tokenProgram)), ro(owner), ro(mint), ro(SYSTEM), ro(tokenProgram)] });
const syncNative = (account) => new TransactionInstruction({ programId: TOKEN, data: Buffer.from([17]), keys: [rw(account)] });
const closeAccount = (account, dest, owner) => new TransactionInstruction({ programId: TOKEN, data: Buffer.from([9]), keys: [rw(account), rw(dest), signer(owner)] });
const approve = (account, delegate, owner, amount) => { const d = Buffer.alloc(9); d[0] = 4; d.writeBigUInt64LE(amount, 1); return new TransactionInstruction({ programId: TOKEN, data: d, keys: [rw(account), ro(delegate), signer(owner)] }); };
const wrap = (user, lamports) => [createAta(user, user, WSOL), SystemProgram.transfer({ fromPubkey: user, toPubkey: ataOf(user, WSOL), lamports }), syncNative(ataOf(user, WSOL))];
const ticketOf = (poolKey, wallet) => pdaOf(["ticket", poolKey, wallet], HOOK.collectible);
const openTicketIx = (user, poolKey) => new TransactionInstruction({ programId: HOOK.collectible, data: Buffer.concat([Buffer.from(DISC["global:open_ticket"]), poolKey.toBuffer()]), keys: [signer(user, true), rw(ticketOf(poolKey, user)), ro(SYSTEM)] });
const openTicketForIx = (payer, poolKey, wallet) => new TransactionInstruction({ programId: HOOK.collectible, data: Buffer.concat([Buffer.from(DISC["global:open_ticket_for"]), poolKey.toBuffer(), wallet.toBuffer()]), keys: [signer(payer, true), rw(ticketOf(poolKey, wallet)), ro(SYSTEM)] });
const settleIx = (payer, poolKey, wallet, coin, tokenProgram) => new TransactionInstruction({
  programId: HOOK.collectible, data: Buffer.from(DISC["global:settle"]),
  keys: [signer(payer, true), rw(pdaOf(["cfg", poolKey], HOOK.collectible)), rw(ticketOf(poolKey, wallet)), ro(ataOf(wallet, coin, tokenProgram)), rw(pdaOf(["collection", poolKey], HOOK.collectible)), ro(pdaOf(["authority", poolKey], HOOK.collectible)), ro(MPL_CORE), ro(SYSTEM)],
});

// ---- the buyback, the burn and the rules template (sections 12 and 13) -----------------------------------
const ixData = (name, ...u64s) => { const d = Buffer.alloc(8 + 8 * u64s.length); Buffer.from(DISC["global:" + name]).copy(d, 0); u64s.forEach((v, i) => d.writeBigUInt64LE(BigInt.asUintN(64, v), 8 + 8 * i)); return d; };
/// `execute_buyback` of the buyback hook and `run_burn` of the rules hook take the same accounts.
function burnIx(name, program, payer, poolKey, pool, minOut) {
  const authority = hookAuthorityOf(poolKey, program);
  return new TransactionInstruction({
    programId: program, data: ixData(name, minOut),
    keys: [
      signer(payer), rw(pdaOf(["cfg", poolKey], program)), ro(authority), ro(PLATFORM), rw(poolKey), rw(pool.baseMint), ro(pool.quoteMint), rw(pool.baseVault), rw(pool.quoteVault), rw(pool.hookTreasury),
      rw(ataOf(authority, pool.baseMint, pool.baseTokenProgram)), ro(HOOKPOOL), ro(EVENT_AUTHORITY), ro(pool.baseTokenProgram), ro(pool.quoteTokenProgram), ro(eventAuthorityOf(program)), ro(program),
    ],
  });
}
const rulesCfgOf = (poolKey) => pdaOf(["cfg", poolKey], HOOK.rules);
const stakeOf = (poolKey, wallet) => pdaOf(["stake", poolKey, wallet], HOOK.rules);
const stakeVaultOf = (poolKey) => pdaOf(["stake-vault", poolKey], HOOK.rules);
const lockOf = (poolKey) => pdaOf(["lock", poolKey], HOOK.rules);
const lockVaultOf = (poolKey) => pdaOf(["lock-vault", poolKey], HOOK.rules);
const rulesIx = (data, keys) => new TransactionInstruction({ programId: HOOK.rules, data, keys });
// the strict coin (sections 9 and 13)
const holderOf = (poolKey, wallet) => pdaOf(["holder", poolKey, wallet], HOOK.rules);
const validationOf = (mint) => pdaOf(["extra-account-metas", mint], HOOK.rules);
/// What a swap, a liquidity instruction or a launch passes for a strict coin after the hook's
/// own config: the holder record of the wallet whose coin account is used, the pool's own
/// holder record address, the coin's account list.
const strictPoolExtras = (poolKey, pool, wallet) => [rw(holderOf(poolKey, wallet)), rw(holderOf(poolKey, poolKey)), ro(validationOf(pool.baseMint))];
/// What a transfer of a strict coin from `from` to `to` (two wallets) needs after its four accounts.
const strictSendExtras = (poolKey, pool, from, to) => [rw(rulesCfgOf(poolKey)), rw(holderOf(poolKey, from)), rw(holderOf(poolKey, to)), ro(validationOf(pool.baseMint)), ro(HOOK.rules)];
const openHolderIx = (wallet, poolKey, pool) => rulesIx(ixData("open_holder"), [signer(wallet, true), rw(rulesCfgOf(poolKey)), ro(poolKey), rw(holderOf(poolKey, wallet)), ro(ataOf(wallet, pool.baseMint, pool.baseTokenProgram)), ro(SYSTEM)]);
const claimHolderIx = (wallet, poolKey, pool, to) => rulesIx(ixData("claim_holder"), [signer(wallet), rw(rulesCfgOf(poolKey)), ro(poolKey), rw(holderOf(poolKey, wallet)), ro(hookAuthorityOf(poolKey, HOOK.rules)), ro(pool.quoteMint), rw(pool.hookTreasury), rw(to), ro(pool.quoteTokenProgram)]);
const syncHolderIx = (poolKey, pool, wallet) => rulesIx(ixData("sync_holder"), [rw(rulesCfgOf(poolKey)), ro(poolKey), rw(holderOf(poolKey, wallet)), ro(ataOf(wallet, pool.baseMint, pool.baseTokenProgram))]);
const closeHolderIx = (wallet, poolKey) => rulesIx(ixData("close_holder"), [signer(wallet, true), ro(rulesCfgOf(poolKey)), rw(holderOf(poolKey, wallet))]);
const lockCreatorStrictIx = (creator, poolKey, pool, amount, unlockAt) => rulesIx(ixData("lock_creator_strict", amount, unlockAt), [signer(creator, true), ro(rulesCfgOf(poolKey)), rw(lockOf(poolKey)), rw(holderOf(poolKey, creator)), ro(ataOf(creator, pool.baseMint, pool.baseTokenProgram)), ro(SYSTEM)]);
const unlockCreatorStrictIx = (creator, poolKey) => rulesIx(ixData("unlock_creator_strict"), [signer(creator), ro(rulesCfgOf(poolKey)), rw(lockOf(poolKey)), rw(holderOf(poolKey, creator))]);
const runBurnStrictIx = (payer, poolKey, pool, minOut) => rulesIx(ixData("run_burn_strict", minOut), [
  signer(payer), rw(rulesCfgOf(poolKey)), ro(hookAuthorityOf(poolKey, HOOK.rules)), ro(PLATFORM), rw(poolKey), rw(pool.baseMint), ro(pool.quoteMint), rw(pool.baseVault), rw(pool.quoteVault), rw(pool.hookTreasury),
  ro(HOOKPOOL), ro(EVENT_AUTHORITY), ro(pool.baseTokenProgram), ro(pool.quoteTokenProgram), ro(eventAuthorityOf(HOOK.rules)), ro(HOOK.rules)]);
/// The pool's hook_buy_burn, built by hand only to see who may sign it.
const hookBuyBurnIx = (authority, poolKey, pool, hookQuote, amountIn, minOut, bump) => {
  const d = Buffer.alloc(25); Buffer.from(DISC["global:hook_buy_burn"]).copy(d, 0); d.writeBigUInt64LE(amountIn, 8); d.writeBigUInt64LE(minOut, 16); d[24] = bump;
  return new TransactionInstruction({ programId: HOOKPOOL, data: d, keys: [signer(authority), ro(PLATFORM), rw(poolKey), rw(pool.baseMint), ro(pool.quoteMint), rw(pool.baseVault), rw(pool.quoteVault), rw(hookQuote), ro(pool.baseTokenProgram), ro(pool.quoteTokenProgram), ro(EVENT_AUTHORITY), ro(HOOKPOOL)] });
};
/// Token-2022 TransferChecked (instruction 12) of a strict coin, with its extra accounts.
const transferCheckedIx = (from, mint, to, owner, amount, decimals, extra) => {
  const d = Buffer.alloc(10); d[0] = 12; d.writeBigUInt64LE(amount, 1); d[9] = decimals;
  return new TransactionInstruction({ programId: TOKEN_2022, data: d, keys: [rw(from), ro(mint), rw(to), signer(owner), ...extra] });
};
function decodeStrict(c) {
  return { kind: c[374], buyMark: c[375], vaultBump: c[376], maxWalletBps: c.readUInt16LE(377), earlySlots: c.readUInt16LE(379), maxWalletSlots: BigInt(c.readUInt32LE(381)), earlyUnlockSlots: BigInt(c.readUInt32LE(385)), maxWalletAmount: u64(c, 389), startSlot: u64(c, 216) };
}
const elapsedOf = (st, slot) => (BigInt(slot) > st.startSlot ? BigInt(slot) - st.startSlot : 0n);
const maxWalletRuns = (st, slot) => st.maxWalletBps > 0 && elapsedOf(st, slot) < st.maxWalletSlots;
const earlyRuns = (st, slot) => st.earlySlots > 0 && elapsedOf(st, slot) < BigInt(st.earlySlots);
const earlyLockRuns = (st, slot) => st.earlySlots > 0 && elapsedOf(st, slot) < st.earlyUnlockSlots;
const decodeHolder = (d) => ({ bump: d[8], pool: key(d, 9), owner: key(d, 41), balance: u64(d, 73), accSnapshot: u128(d, 81), owed: u64(d, 97), earlyBought: u64(d, 105), locked: u64(d, 113), lockedUntil: d.readBigInt64LE(121) });
const stakeIx = (staker, poolKey, pool, amount, from) => rulesIx(ixData("stake", amount), [signer(staker, true), rw(rulesCfgOf(poolKey)), ro(poolKey), rw(stakeOf(poolKey, staker)), ro(pool.baseMint), rw(stakeVaultOf(poolKey)), rw(from), ro(pool.baseTokenProgram), ro(SYSTEM)]);
const unstakeIx = (staker, poolKey, pool, amount, to) => rulesIx(ixData("unstake", amount), [signer(staker), rw(rulesCfgOf(poolKey)), ro(poolKey), rw(stakeOf(poolKey, staker)), ro(pool.baseMint), rw(stakeVaultOf(poolKey)), rw(to), ro(pool.baseTokenProgram)]);
const claimRewardsIx = (staker, poolKey, pool, to) => rulesIx(ixData("claim_rewards"), [signer(staker), rw(rulesCfgOf(poolKey)), ro(poolKey), rw(stakeOf(poolKey, staker)), ro(hookAuthorityOf(poolKey, HOOK.rules)), ro(pool.quoteMint), rw(pool.hookTreasury), rw(to), ro(pool.quoteTokenProgram)]);
const claimCreatorIx = (creator, poolKey, pool, to) => rulesIx(ixData("claim_creator"), [signer(creator), rw(rulesCfgOf(poolKey)), ro(poolKey), ro(hookAuthorityOf(poolKey, HOOK.rules)), ro(pool.quoteMint), rw(pool.hookTreasury), rw(to), ro(pool.quoteTokenProgram)]);
const lockCreatorIx = (creator, poolKey, pool, amount, unlockAt, from) => rulesIx(ixData("lock_creator", amount, unlockAt), [signer(creator, true), ro(rulesCfgOf(poolKey)), rw(lockOf(poolKey)), ro(pool.baseMint), rw(lockVaultOf(poolKey)), rw(from), ro(pool.baseTokenProgram), ro(SYSTEM)]);
const unlockCreatorIx = (creator, poolKey, pool, to) => rulesIx(ixData("unlock_creator"), [signer(creator), ro(rulesCfgOf(poolKey)), rw(lockOf(poolKey)), ro(pool.baseMint), rw(lockVaultOf(poolKey)), rw(to), ro(pool.baseTokenProgram)]);

// ---- the hook's extra accounts (section 8) -----------------------------------------------------------------------
function resolveExtras(listData, poolKey, pool, user, accountData) {
  const entries = [];
  for (let at = 0; at + 12 <= listData.length; ) {
    const len = listData.readUInt32LE(at + 8);
    if (starts(listData.subarray(at), DISC["hookpool-interface:callback"])) { const n = listData.readUInt32LE(at + 12); for (let i = 0; i < n; i++) entries.push(listData.subarray(at + 16 + 35 * i, at + 16 + 35 * (i + 1))); break; }
    if (len === 0) break;
    at += 12 + len;
  }
  const known = [poolKey, callerOf(pool.hookProgram), user, pool.quoteMint, pool.baseMint];
  const metas = [];
  for (const e of entries) {
    const kind = e[0], cfg = e.subarray(1, 33);
    let pubkey;
    if (kind === 0) pubkey = new PublicKey(cfg);
    else {
      const program = kind === 1 ? pool.hookProgram : known[kind - 128];
      const seeds = [];
      for (let i = 0; i < 32 && cfg[i] !== 0; ) {
        if (cfg[i] === 1) { const n = cfg[i + 1]; seeds.push(Buffer.from(cfg.subarray(i + 2, i + 2 + n))); i += 2 + n; }
        else if (cfg[i] === 3) { seeds.push(known[cfg[i + 1]].toBuffer()); i += 2; }
        else if (cfg[i] === 4) { const d = accountData(known[cfg[i + 1]]); if (!d) return null; seeds.push(Buffer.from(d.subarray(cfg[i + 2], cfg[i + 2] + cfg[i + 3]))); i += 4; }
        else return null; // a seed taken from the callback's instruction data
      }
      pubkey = PublicKey.findProgramAddressSync(seeds, program)[0];
    }
    known.push(pubkey);
    // the signer bit of an entry (byte 33) is ignored: these accounts never sign
    metas.push({ pubkey, isSigner: false, isWritable: e[34] !== 0, listedAsSigner: e[33] !== 0 });
  }
  return metas;
}
/// The authority of a Token-2022 mint's transfer hook extension, or null when it has none.
function transferHookAuthorityOf(mintData) {
  for (let at = 166; at + 4 <= mintData.length; ) {
    const type = mintData.readUInt16LE(at), len = mintData.readUInt16LE(at + 2);
    if (type === 0) break;
    if (type === 14 && len >= 64) { const a = key(mintData, at + 4); return a.equals(PublicKey.default) ? null : a; }
    at += 4 + len;
  }
  return null;
}
function transferHookOf(mintData) {
  for (let at = 166; at + 4 <= mintData.length; ) {
    const type = mintData.readUInt16LE(at), len = mintData.readUInt16LE(at + 2);
    if (type === 0) break;
    if (type === 14 && len >= 64) { const p = key(mintData, at + 4 + 32); return p.equals(PublicKey.default) ? null : p; }
    at += 4 + len;
  }
  return null;
}

// ---- the chain -----------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const rpc = args[0];
if (!rpc || rpc.startsWith("--")) { console.error("usage: node scripts/check-integrators-doc.mjs <rpc url> [--payer <public key>] [--per-kind <n>] [--lookup-table <address>]"); process.exit(2); }
const opt = (name) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : undefined; };
const perKind = Number(opt("--per-kind") ?? 3);
if (!Number.isInteger(perKind) || perKind < 1) { console.error("--per-kind takes a whole number, 1 or more"); process.exit(2); }
const conn = new Connection(rpc, "confirmed");
const many = async (keys) => { const out = []; for (let i = 0; i < keys.length; i += 100) out.push(...(await conn.getMultipleAccountsInfo(keys.slice(i, i + 100)))); return out; };

/// Simulate instructions with no signature. Returns the error, the logs, the pool program's
/// return data, the accounts asked for as they are after the simulation, and the events.
async function simulate(ixs, payer, addresses = []) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer;
  tx.recentBlockhash = PublicKey.default.toBase58();
  const message = tx.compileMessage();
  const size = message.serialize().length + 1 + 64 * message.header.numRequiredSignatures;
  if (size > 1232) return { tooLarge: true, err: "too large" };
  const vtx = new VersionedTransaction(VersionedMessage.deserialize(message.serialize()));
  const res = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true, accounts: { encoding: "base64", addresses: addresses.map((a) => a.toBase58()) } });
  const v = res.value;
  const rd = v.returnData && v.returnData.data && v.returnData.data[0] ? Buffer.from(v.returnData.data[0], "base64") : null;
  const accounts = (v.accounts || []).map((a) => (a ? { data: Buffer.from(a.data[0], "base64"), lamports: a.lamports, owner: new PublicKey(a.owner) } : null));
  const keys = message.accountKeys;
  const inner = [], rawInner = [];
  for (const group of v.innerInstructions || []) for (const ins of group.instructions || []) {
    const program = ins.programId ? new PublicKey(ins.programId) : keys[ins.programIdIndex];
    if (ins.parsed && program) { rawInner.push({ program, parsed: ins.parsed, data: Buffer.alloc(0), accounts: [], top: group.index }); continue; }
    if (typeof ins.data !== "string" || !program) continue;
    const d = b58decode(ins.data);
    rawInner.push({ program, data: d, accounts: (ins.accounts || []).map((i) => keys[i]), top: group.index });
    if (d.length >= 16 && starts(d, EVENT_TAG)) inner.push({ program, disc: [...d.subarray(8, 16)], body: d.subarray(16), top: group.index });
  }
  const logged = (v.logs || []).filter((l) => l.startsWith("Program data: ")).map((l) => Buffer.from(l.slice(14), "base64")).map((d) => ({ disc: [...d.subarray(0, 8)], body: d.subarray(8) }));
  const top = (v.logs || []).filter((l) => l.startsWith("Program " + HOOKPOOL.toBase58() + " consumed"));
  const units = top.length ? Number(/consumed (\d+) of/.exec(top[top.length - 1])[1]) : null;
  const depth = Math.max(0, ...(v.logs || []).map((l) => { const m = /invoke \[(\d+)\]/.exec(l); return m ? Number(m[1]) : 0; }));
  // the units of each top-level instruction of a program that logs them, in order
  const tops = [];
  let level = 0;
  for (const l of v.logs || []) {
    const inv = /^Program (\w+) invoke \[(\d+)\]/.exec(l);
    if (inv) { level = Number(inv[2]); continue; }
    const used = /^Program (\w+) consumed (\d+) of/.exec(l);
    if (used && level === 1) tops.push({ program: used[1], units: Number(used[2]) });
    if (/^Program \w+ (success|failed)/.test(l)) level = Math.max(0, level - 1);
  }
  return { rawInner, err: v.err, logs: v.logs || [], out: rd && rd.length >= 8 ? rd.readBigUInt64LE(0) : null, returnData: rd, returnProgram: v.returnData ? v.returnData.programId : null, accounts, inner, hasInner: v.innerInstructions !== undefined && v.innerInstructions !== null, logged, units, tops, depth, slot: res.context.slot };
}
/// The units of the last top-level instruction of `program` in a simulation.
const unitsOf = (sim, program) => { const t = sim.tops.filter((x) => x.program === program.toBase58()).pop(); return t ? t.units : null; };
/// Runs checks that compare simulations with an earlier read of a pool. This chain may be
/// shared: when somebody else traded on the pool while the checks ran, their results say
/// nothing about the document, so they are dropped and a note says so.
async function guarded(poolKey, before, tag, fn) {
  held = [];
  let lines;
  try { await fn(); } finally { lines = held; held = null; }
  const now = decodePool((await conn.getAccountInfo(poolKey)).data);
  if (now.swaps === before.swaps && now.reserveBase === before.reserveBase && now.reserveQuote === before.reserveQuote) { for (const [ok, text] of lines) ok === null ? note(text) : check(ok, text); }
  else note(tag + "somebody else traded on this pool while it was checked: " + lines.filter((l) => l[0] !== null).length + " checks were dropped");
}

/// The error of a simulation in the document's words: a custom code, or the runtime's name.
function errorOf(sim) {
  if (sim.tooLarge) return "too large";
  if (!sim.err) return "none";
  const ie = sim.err.InstructionError;
  if (!ie) return JSON.stringify(sim.err);
  return typeof ie[1] === "string" ? ie[1] : ie[1] && "Custom" in ie[1] ? String(ie[1].Custom) : JSON.stringify(ie[1]);
}
const failedIn = (sim, program) => (sim.logs || []).some((l) => l.startsWith("Program " + program.toBase58() + " failed"));
const eventsOf = (sim, name, program) => sim.inner.filter((e) => same(e.disc, DISC["event:" + name]) && (!program || e.program.equals(program)));
function decodeSwapped(e) {
  return { pool: key(e, 0), user: key(e, 32), direction: e[64], amountIn: u64(e, 65), amountOut: u64(e, 73), protocolFee: u64(e, 81), hookFee: u64(e, 89), lpFee: u64(e, 97), feeBps: e.readUInt16LE(105), reserveBase: u64(e, 107), reserveQuote: u64(e, 115), slot: u64(e, 123), byHook: e[131] };
}

// =====================================================================================================
// A. the document and the IDL against the numbers used here
// =====================================================================================================
console.log("# the document, the IDLs and sha256");
for (const [name, bytes] of Object.entries(DISC)) check(same(sha8(name), bytes), "discriminator [" + bytes.join(",") + "] is sha256(\"" + name + "\")[..8]");
eq(b58encode(DISC["account:Pool"]), POOL_FILTER, "the pool filter " + POOL_FILTER + " is the pool discriminator in base58");
eq(b58encode(DISC["account:Launch"]), LAUNCH_FILTER, "the launch record filter " + LAUNCH_FILTER + " is its discriminator in base58");
eq(Buffer.from(DISC["account:Pool"]).toString("hex"), "f19a6d0411b16dbc", "the pool discriminator in hex");
eq(Buffer.from(DISC["global:swap"]).toString("hex"), "f8c69e91e17587c8", "the swap discriminator in hex");
check(same(sha8("anchor:event").reverse(), EVENT_TAG), "the event tag e445a52e51cb9a1d is the first eight bytes of sha256(\"anchor:event\"), reversed");
for (const [name, l] of Object.entries(LAYOUT)) {
  let at = l.rows[0][0], ok = true;
  for (const [offset, size] of l.rows) { if (offset !== at) ok = false; at = offset + size; }
  check(ok && at === l.size, "layout " + name + ": the offsets follow each other without a gap and end at " + l.size + " bytes");
}
const BIT = { BEFORE_SWAP: 0, AFTER_SWAP: 1, BEFORE_ADD_LIQ: 2, AFTER_ADD_LIQ: 3, BEFORE_REMOVE_LIQ: 4, AFTER_REMOVE_LIQ: 5, ON_POOL_CREATE: 6, OVERRIDE_FEE: 8, TAKE_HOOK_FEE: 9, OVERRIDE_CURVE: 10, CALL_ON_BUY: 12, CALL_ON_SELL: 13 };
const bitsOf = (names) => names.reduce((a, n) => a | (1 << BIT[n]), 0);
const TEMPLATE_BITS = {
  tax: ["BEFORE_SWAP", "ON_POOL_CREATE", "TAKE_HOOK_FEE", "CALL_ON_BUY", "CALL_ON_SELL"],
  buyback: ["BEFORE_SWAP", "ON_POOL_CREATE", "TAKE_HOOK_FEE", "CALL_ON_BUY", "CALL_ON_SELL"],
  launch_guard: ["BEFORE_SWAP", "BEFORE_ADD_LIQ", "ON_POOL_CREATE", "OVERRIDE_FEE", "CALL_ON_BUY"],
  collectible: ["AFTER_SWAP", "ON_POOL_CREATE", "CALL_ON_BUY"],
  rules: ["BEFORE_SWAP", "BEFORE_ADD_LIQ", "ON_POOL_CREATE", "OVERRIDE_FEE", "TAKE_HOOK_FEE", "CALL_ON_BUY", "CALL_ON_SELL"],
};
for (const [t, names] of Object.entries(TEMPLATE_BITS)) eq(bitsOf(names), TEMPLATE_FLAGS[t], "the flags of the " + t + " template, " + TEMPLATE_FLAGS[t] + ", are " + names.join(" | "));
// the buy-and-burn rule of section 12 against the vectors of the programs' own unit tests
{
  const caps = [[20, 30, 100, 100, 50], [20, 0, 0, 5, 11], [20, 0, 0, 0, 10], [20, 0, 60, 0, 25], [20, 30, 0, 0, 10], [20, 1000, 0, 0, 10], [20, 30, 50, 50, 50], [20, 30, 50, 49, 49], [0, 0, 0, 0, 1], [1, 1000, 0, 0, 1], [0, 0, 3, 4, 1], [0, 0, 4, 4, 2], [65535, 65535, 65535, 65535, 50]];
  check(caps.every(([protocol, lp, buy, sell, want]) => burnCapBps(protocol, lp, buy, sell) === BigInt(want)), "the cap formula gives the " + caps.length + " values of the program's own tests (for example protocol 20, pool fee 30, hook fees 50 and 49: 49 bps)");
  const b = 1_000_000_000_000n, q = 100_000_000_000n, at = (base, quote, slot) => ({ base, quote, slot });
  const steps = [
    [burnStep(at(0n, 0n, 0n), b, q, 1000, 50n, q), "observe"], [burnStep(at(b, 0n, 990n), b, q, 1000, 50n, q), "observe"],
    [burnStep(at(b, q, 1000n), b, q, 1024, 50n, q), "too soon"], [burnStep(at(b, q, 1000n), b, q, 1025, 50n, q), "buy", q / 200n],
    [burnStep(at(b, q, 0n), b, q + q / 100n, 100, 50n, q), "buy", q / 200n], [burnStep(at(b, q, 0n), b, q + q / 100n + 1n, 100, 50n, q), "wait"],
    [burnStep(at(b, q, 0n), b * 2n, q / 2n, 100, 50n, q), "buy", q / 2n / 200n], [burnStep(at(b, q, 0n), b * 12n, q * 12n, 100, 50n, q), "buy", q / 200n], [burnStep(at(b * 12n, q * 12n, 0n), b, q, 100, 50n, q), "buy", q / 200n],
    [burnStep(at(b, q, 0n), b, q + (q * 22n) / 10000n, 100, 11n, q), "buy", (q * 11n) / 10000n], [burnStep(at(b, q, 0n), b, q + (q * 23n) / 10000n, 100, 11n, q), "wait"],
    [burnStep(at(1000n, 1000n, 0n), 1000n, 1000n, 100, 1n, 5n), "buy", 1n], [burnStep(at(b, q, 0n), b, q, 100, 50n, 7n), "buy", 7n],
  ];
  check(steps.every(([got, step, spend]) => got.step === step && (spend === undefined || got.spend === spend)), "the decision of a call (observe, too soon, wait, buy and how much) gives the " + steps.length + " cases of the program's own tests");
  const o = at(b, q, 0n);
  const low = (obs, rb, rq) => { const l = burnLowered(obs, rb, rq); return l ? l.base + "/" + l.quote : "none"; };
  check(low(o, b, q) === "none" && low(o, 12n * b, 12n * q) === "none" && low(o, b, q + 1n) === "none" && low(at(0n, 0n, 0n), b, q) === "none" && low(o, 0n, q) === "none" && low(o, b, 0n) === "none",
    "a trade leaves the observation alone when it starts at the observed price or above it, and when there is no observation");
  check(low(o, b, q - 1n) === b + "/" + (q - 1n) && low(o, b + 1n, q) === (b + 1n) + "/" + q && low(o, b / 2n + 7n, q / 4n) === (b / 2n + 7n) + "/" + q / 4n,
    "a trade that starts below the observed price, on a pool that is not deeper than the observation: the pool's own two reserves become the observation");
  check(low(o, 12n * b + 12n, 12n * q) === (b + 1n) + "/" + q, "a trade that starts below the observed price on a pool twelve times deeper: the observed depth stays, the base follows the pool's price, rounded up");
}

// ---- the IDLs ----
const idls = {};
for (const name of Object.keys(IDL_OF)) { const f = new URL("../idl/" + name + ".json", import.meta.url); if (existsSync(f)) idls[name] = JSON.parse(readFileSync(f, "utf8")); }
const haveIdls = Object.keys(idls).length === Object.keys(IDL_OF).length;
const idlFlags = (name, ixName) => { const i = idls[name] && idls[name].instructions.find((x) => x.name === ixName); return i ? i.accounts.map((a) => (a.signer ? "s" : "-") + (a.writable ? "w" : "-")) : null; };
if (!haveIdls) note("the seven IDLs are not next to this script (found " + Object.keys(idls).length + "): the comparisons with the IDLs are skipped");
else {
  for (const [name, id] of Object.entries(IDL_OF)) eq(idls[name].address, id.toBase58(), "idl/" + name + ".json is the IDL of the program id used here");
  let found = 0, wrong = [];
  for (const [name, bytes] of Object.entries(DISC)) {
    const [kind, n] = name.split(":");
    if (kind !== "global" && kind !== "account" && kind !== "event") continue;
    const hits = Object.values(idls).flatMap((idl) => (kind === "global" ? idl.instructions : kind === "account" ? idl.accounts || [] : idl.events || []).filter((x) => x.name === n));
    if (hits.length && hits.every((h) => same(h.discriminator, bytes))) found++; else wrong.push(name);
  }
  check(wrong.length === 0, "the IDLs give each of the " + found + " discriminators of instructions, accounts and events used here" + (wrong.length ? "  (not so: " + wrong.join(", ") + ")" : ""));
  for (const [name, table] of Object.entries(ERR_OF)) {
    const byName = Object.fromEntries(idls[name].errors.map((e) => [e.name, e.code]));
    check(Object.entries(table).every(([n, code]) => byName[n] === code), "idl/" + name + ".json gives every error of that program named here the same number (" + Object.keys(table).length + ")");
    if (FULL_ERROR_TABLES.includes(name)) eq(Object.keys(table).length, idls[name].errors.length, "idl/" + name + ".json has no error that is missing here");
  }
  for (const [name, l] of Object.entries(LAYOUT)) for (const [file, type, before] of l.idl || []) {
    const marks = new Set();
    const end = idlSpan(idls[file], { defined: { name: type } }, before, marks);
    const edges = new Set([...marks, end, ...(before ? [0] : [])]);
    check(end === l.size && l.rows.every(([offset, size]) => edges.has(offset) && edges.has(offset + size)), "layout " + name + ": " + l.size + " bytes, and every row starts and ends where a field of " + type + " in idl/" + file + ".json does");
  }
  // the instructions this script builds take the accounts of the IDL, with its signer and writable flags
  const dummy = Keypair.generate().publicKey;
  const blank = { baseMint: dummy, quoteMint: dummy, baseVault: dummy, quoteVault: dummy, lpMint: dummy, hookProgram: dummy, hookExtraMetas: dummy, hookTreasury: dummy, baseTokenProgram: TOKEN, quoteTokenProgram: TOKEN };
  const built = {
    "hookpool.swap": swapIx(dummy, blank, dummy, dummy, dummy, 0, 1n, 0n, []),
    "hookpool.add_liquidity": liquidityIx("add_liquidity", dummy, blank, dummy, dummy, dummy, dummy, 1n, 1n, 1n, []),
    "hookpool.remove_liquidity": liquidityIx("remove_liquidity", dummy, blank, dummy, dummy, dummy, dummy, 1n, 1n, 1n, []),
    "hookpool.collect_hook_fees": collectHookFeesIx(dummy, blank),
    "hookpool.graduate": graduateIx(dummy, blank),
    "hook_collectible.open_ticket": openTicketIx(dummy, dummy),
    "hook_collectible.open_ticket_for": openTicketForIx(dummy, dummy, dummy),
    "hook_collectible.settle": settleIx(dummy, dummy, dummy, dummy, TOKEN),
    "hook_buyback.execute_buyback": burnIx("execute_buyback", HOOK.buyback, dummy, dummy, blank, 0n),
    "hook_rules.run_burn": burnIx("run_burn", HOOK.rules, dummy, dummy, blank, 0n),
    "hook_rules.stake": stakeIx(dummy, dummy, blank, 1n, dummy),
    "hook_rules.unstake": unstakeIx(dummy, dummy, blank, 1n, dummy),
    "hook_rules.claim_rewards": claimRewardsIx(dummy, dummy, blank, dummy),
    "hook_rules.claim_creator": claimCreatorIx(dummy, dummy, blank, dummy),
    "hook_rules.lock_creator": lockCreatorIx(dummy, dummy, blank, 1n, 1n, dummy),
    "hook_rules.unlock_creator": unlockCreatorIx(dummy, dummy, blank, dummy),
    "hookpool.hook_buy_burn": hookBuyBurnIx(dummy, dummy, blank, dummy, 1n, 0n, 255),
    "hook_rules.open_holder": openHolderIx(dummy, dummy, blank),
    "hook_rules.claim_holder": claimHolderIx(dummy, dummy, blank, dummy),
    "hook_rules.sync_holder": syncHolderIx(dummy, blank, dummy),
    "hook_rules.close_holder": closeHolderIx(dummy, dummy),
    "hook_rules.lock_creator_strict": lockCreatorStrictIx(dummy, dummy, blank, 1n, 1n),
    "hook_rules.unlock_creator_strict": unlockCreatorStrictIx(dummy, dummy),
    "hook_rules.run_burn_strict": runBurnStrictIx(dummy, dummy, blank, 0n),
  };
  {
    // the transfer hook's Execute keeps the interface's discriminator, not an Anchor one
    const ex = idls.hook_rules.instructions.find((x) => x.name === "execute");
    check(!!ex && same(ex.discriminator, DISC["spl-transfer-hook-interface:execute"]) && ex.accounts.map((a) => (a.signer ? "s" : "-") + (a.writable ? "w" : "-")).join(" ") === "-- -- -- -- -- -w -w -w", "idl/hook_rules.json: execute has the discriminator of the transfer hook interface and takes source, mint, destination, authority, account list, then the config and the two holder records, writable");
    const init = idls.hook_rules.instructions.find((x) => x.name === "init_strict_config");
    check(!!init && same(init.discriminator, DISC["global:init_strict_config"]) && init.accounts.map((a) => (a.signer ? "s" : "-") + (a.writable ? "w" : "-")).join(" ") === "sw s- -- -w -- -w -w -- -- --", "idl/hook_rules.json: init_strict_config takes payer (w, s), the mint (s), quote mint, config (w), authority, treasury (w), account list (w), and three programs");
    // section 14: the two ways onto the curve take the accounts of the seeded way, in the same order
    const accountsOf = (idl, n) => { const i = idl.instructions.find((x) => x.name === n); return i ? i.accounts.map((a) => a.name + (a.signer ? ":s" : "") + (a.writable ? ":w" : "")).join(" ") : null; };
    const argsOf = (idl, n) => { const t = (idl.types || []).find((x) => x.name === n); return t ? t.type.fields.map((f) => f.name + " " + f.type).join(", ") : null; };
    const ccp = idls.hookpool.instructions.find((x) => x.name === "create_curve_pool"), lc = idls.hooklaunch.instructions.find((x) => x.name === "launch_curve");
    check(!!ccp && same(ccp.discriminator, DISC["global:create_curve_pool"]) && accountsOf(idls.hookpool, "create_curve_pool") === accountsOf(idls.hookpool, "create_pool") && ccp.accounts.length === 26 && argsOf(idls.hookpool, "CreateCurvePoolArgs") === "lp_fee_bps u16, base_amount u64",
      "idl/hookpool.json: create_curve_pool has the discriminator of the document, the 26 accounts of create_pool in the same order, and the arguments lp_fee_bps u16, base_amount u64");
    check(!!lc && same(lc.discriminator, DISC["global:launch_curve"]) && accountsOf(idls.hooklaunch, "launch_curve") === accountsOf(idls.hooklaunch, "launch") && lc.accounts.length === 29 && argsOf(idls.hooklaunch, "LaunchCurveArgs") === "lp_fee_bps u16, dev_buy_quote u64, min_dev_buy_out u64",
      "idl/hooklaunch.json: launch_curve has the discriminator of the document, the 29 accounts of launch in the same order, and the arguments lp_fee_bps u16, dev_buy_quote u64, min_dev_buy_out u64");
    const grad = idls.hookpool.instructions.find((x) => x.name === "graduate");
    check(!!grad && grad.args.length === 0 && grad.accounts.every((a) => !a.signer), "idl/hookpool.json: graduate takes no argument and no account signs it");
  }
  for (const [name, ix] of Object.entries(built)) {
    const [file, ixName] = name.split(".");
    const want = idlFlags(file, ixName), got = ix.keys.map((k) => (k.isSigner ? "s" : "-") + (k.isWritable ? "w" : "-"));
    check(!!want && same(want, got) && same(idls[file].instructions.find((x) => x.name === ixName).discriminator, [...ix.data.subarray(0, 8)]), "idl/" + file + ".json: " + ixName + " takes the " + got.length + " accounts built here, with the same signers and writable accounts, and has the discriminator used here");
  }
}

// ---- the document ----
const docFile = new URL("../INTEGRATORS.md", import.meta.url);
if (existsSync(docFile)) {
  const doc = readFileSync(docFile, "utf8");
  const lines = doc.split(/\r?\n/);
  /// The tables that follow a comment `<!-- kind -->`, `<!-- kind:arg -->` or `<!-- kind:arg size=N -->`.
  const tablesOf = (kind) => {
    const out = [];
    lines.forEach((line, at) => {
      const m = /^<!-- (\w+)(?::([\w.]+))?(?: size=(\d+))? -->$/.exec(line.trim());
      if (!m || m[1] !== kind) return;
      const rows = [];
      let first = at + 1;
      while (first < lines.length && /^<!-- .* -->$/.test(lines[first].trim())) first++; // one table may carry several marks
      for (let i = first; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim()));
      out.push({ arg: m[2] || "", size: m[3] ? Number(m[3]) : null, header: rows[0] || [], rows: rows.slice(1).filter((r) => !r.every((c) => /^:?-+:?$/.test(c))) });
    });
    return out;
  };
  const layouts = tablesOf("layout");
  for (const [name, l] of Object.entries(LAYOUT)) {
    const t = layouts.find((x) => x.arg === name && x.size === l.size);
    if (!t) { check(false, "INTEGRATORS.md has a table marked layout:" + name + " size=" + l.size); continue; }
    const rows = t.rows.filter((r) => /^\d+$/.test(r[0]) && /^\d+$/.test(r[1])).map((r) => [Number(r[0]), Number(r[1])]);
    check(JSON.stringify(rows) === JSON.stringify(l.rows), "INTEGRATORS.md, table " + name + ": its " + rows.length + " rows of offset and size are the ones checked here");
  }
  check(layouts.every((t) => t.arg in LAYOUT), "INTEGRATORS.md: every table marked layout: is one checked here" + (layouts.every((t) => t.arg in LAYOUT) ? "" : " (not known: " + layouts.filter((t) => !(t.arg in LAYOUT)).map((t) => t.arg).join(", ") + ")"));
  const known = Object.values(DISC).map((b) => b.join(","));
  const cited = [...doc.matchAll(/\[(\d{1,3}(?:,\d{1,3}){7})\]/g)].map((m) => m[1]);
  check(cited.length > 0 && cited.every((c) => known.includes(c)), "INTEGRATORS.md: each of its " + cited.length + " discriminators is one of the sha256 values above" + (cited.every((c) => known.includes(c)) ? "" : " (not known: " + cited.filter((c) => !known.includes(c)).join(" ; ") + ")"));
  for (const id of [HOOKPOOL, HOOKLAUNCH, ...Object.values(HOOK)]) check(doc.includes("`" + id.toBase58() + "`"), "INTEGRATORS.md names the program id " + id.toBase58());
  check(doc.includes(POOL_FILTER) && doc.includes(LAUNCH_FILTER), "INTEGRATORS.md gives the two filters " + POOL_FILTER + " and " + LAUNCH_FILTER);

  // error tables: each is marked with the IDL its numbers belong to
  const errorTables = tablesOf("errors");
  const marked = new Set();
  for (const t of errorTables) {
    const table = ERR_OF[t.arg];
    if (!table) { check(false, "INTEGRATORS.md: an error table is marked errors:" + t.arg + ", which is not a program whose errors are checked here"); continue; }
    const rows = t.rows.filter((r) => /^\d{4}$/.test(r[0])).map((r) => [Number(r[0]), r[1].replace(/`/g, "")]);
    rows.forEach(([code, name]) => marked.add(code + " " + name));
    const bad = rows.filter(([code, name]) => table[name] !== code);
    check(rows.length > 0 && bad.length === 0, "INTEGRATORS.md: each of the " + rows.length + " rows of a table of " + t.arg + " errors has the number used here" + (bad.length ? "  (not so: " + bad.map((b) => b.join(" ")).join(", ") + ")" : ""));
    if (FULL_ERROR_TABLES.includes(t.arg)) eq(rows.length, Object.keys(table).length, "INTEGRATORS.md: the table of " + t.arg + " errors lists every error of that program");
  }
  for (const name of Object.keys(ERR_OF)) check(errorTables.some((t) => t.arg === name), "INTEGRATORS.md has a table marked errors:" + name);
  const allRows = [...doc.matchAll(/^\|\s*(\d{4})\s*\|\s*`(\w+)`\s*\|/gm)].map((m) => m[1] + " " + m[2]);
  check(allRows.every((r) => marked.has(r)), "INTEGRATORS.md: every table row of an error number and name stands in a table marked errors:" + (allRows.every((r) => marked.has(r)) ? "" : " (not so: " + allRows.filter((r) => !marked.has(r)).join(", ") + ")"));
  // errors named in the text, as `6017 `BuyTooLarge``: the pair must exist in a program, or in Anchor
  {
    const pairs = [...doc.matchAll(/\b([236]\d{3}) `(\w+)`/g)].map((m) => [Number(m[1]), m[2]]);
    const real = ([code, name]) => ANCHOR_ERR[name] === code || Object.values(ERR_OF).some((t) => t[name] === code) || Object.values(idls).some((idl) => (idl.errors || []).some((e) => e.name === name && e.code === code));
    const bad = pairs.filter((p) => !real(p));
    check(pairs.length > 0 && bad.length === 0, "INTEGRATORS.md: each of the " + pairs.length + " errors named in its text by number and name is an error of one of the programs, or of Anchor, with that number" + (bad.length ? "  (not so: " + bad.map((b) => b.join(" ")).join(", ") + ")" : ""));
  }

  // account tables: one row per account of the IDL's instruction
  const accountTables = tablesOf("accounts");
  for (const t of accountTables) {
    const [file, ixName] = t.arg.split(".");
    const want = idlFlags(file, ixName);
    if (!haveIdls) continue;
    if (!want) { check(false, "INTEGRATORS.md: a table is marked accounts:" + t.arg + ", which is not an instruction of an IDL"); continue; }
    const col = (name) => t.header.findIndex((h) => h.toLowerCase() === name);
    const sCol = col("signer"), wCol = col("writable");
    const rows = t.rows.filter((r) => /^\d+$/.test(r[0]));
    const got = rows.map((r) => (sCol >= 0 && /^yes\b/.test(r[sCol]) ? "s" : "-") + (wCol >= 0 && /^yes\b/.test(r[wCol]) ? "w" : "-"));
    const numbered = rows.every((r, i) => Number(r[0]) === i);
    check(numbered && same(got, want), "INTEGRATORS.md, accounts of " + ixName + ": its " + rows.length + " rows are the accounts of idl/" + file + ".json in order, with the same signers and writable accounts" + (numbered && same(got, want) ? "" : "  (document " + got.join(" ") + ", IDL " + want.join(" ") + ")"));
  }
  for (const name of ["hookpool.swap", "hookpool.collect_hook_fees", "hookpool.hook_buy_burn", "hookpool.graduate", "hook_collectible.settle", "hook_buyback.execute_buyback", "hook_rules.run_burn", "hook_rules.stake", "hook_rules.unstake", "hook_rules.claim_rewards", "hook_rules.claim_creator", "hook_rules.lock_creator", "hook_rules.unlock_creator",
    "hook_rules.open_holder", "hook_rules.claim_holder", "hook_rules.sync_holder", "hook_rules.close_holder", "hook_rules.lock_creator_strict", "hook_rules.unlock_creator_strict", "hook_rules.run_burn_strict"])
    check(accountTables.some((t) => t.arg === name), "INTEGRATORS.md has a table marked accounts:" + name);

  // the hook caller of each hook program
  {
    const t = tablesOf("callers")[0];
    const rows = t ? t.rows.map((r) => [...r.join(" | ").matchAll(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/g)].map((m) => m[1])).filter((a) => a.length >= 2) : [];
    const bad = rows.filter((a) => callerOf(new PublicKey(a[0])).toBase58() !== a[a.length - 1]);
    const programs = rows.map((a) => a[0]);
    check(!!t && bad.length === 0 && [SYSTEM, ...Object.values(HOOK)].every((p) => programs.includes(p.toBase58())), "INTEGRATORS.md, table of hook callers: each of its " + rows.length + " addresses is [\"caller\", hook program] of the pool program, for no hook and for the five templates" + (bad.length ? "  (not so for " + bad.map((a) => a[0] + ": its caller is " + callerOf(new PublicKey(a[0])).toBase58()).join("; ") + ")" : ""));
    if (!t || bad.length) note("the hook callers for the program ids used here: " + [["no hook", SYSTEM], ...Object.entries(HOOK)].map(([n, p]) => n + " " + callerOf(p).toBase58()).join(", "));
    check(!doc.includes(OLD_CALLER.toBase58()), "INTEGRATORS.md does not give [\"caller\"] alone as an address, " + OLD_CALLER.toBase58());
  }
  // the flags of each template
  {
    const t = tablesOf("flags")[0];
    const nameOf = { tax: "tax", "launch guard": "launch_guard", buyback: "buyback", collectible: "collectible", rules: "rules" };
    const rows = t ? t.rows.map((r) => ({ template: nameOf[r[0].replace(/`/g, "").toLowerCase()], flags: Number(r[1].replace(/[,`]/g, "")), bits: [...r[2].matchAll(/`(\w+)`/g)].map((m) => m[1]) })) : [];
    check(!!t && rows.length === 5 && rows.every((r) => r.template && TEMPLATE_FLAGS[r.template] === r.flags && r.bits.every((b) => b in BIT) && bitsOf(r.bits) === r.flags), "INTEGRATORS.md, table of template flags: five rows, each number the one used here and the sum of the bits it names");
  }
} else note("INTEGRATORS.md is not next to this script: the comparison with its tables is skipped");

// =====================================================================================================
// B. programs, platform, pools: every account against the layouts
// =====================================================================================================
console.log("# programs and platform on " + rpc);
const slotNow = await conn.getSlot("confirmed");
{
  const ids = [HOOKPOOL, HOOKLAUNCH, ...Object.values(HOOK)];
  const infos = await many(ids);
  ids.forEach((id, i) => check(!!infos[i] && infos[i].executable, "program " + id.toBase58() + " is deployed"));
  if (!infos[0]) { console.error("the pool program is not on this cluster: nothing more can be checked"); process.exit(1); }
}
const platformInfo = await conn.getAccountInfo(PLATFORM);
if (!check(!!platformInfo && platformInfo.owner.equals(HOOKPOOL), "the platform account is at [\"platform\"] of the pool program")) process.exit(1);
// the fixed part is 451 bytes; the approved list (HOOKS.md section 6.1) may follow it: a u32
// count at 451, then 32 bytes a program
{
  const len = platformInfo.data.length;
  if (len === LAYOUT.platform.size) check(true, "platform: size 451, no approved list after it");
  else {
    const n = len >= 455 ? platformInfo.data.readUInt32LE(451) : -1;
    check(n >= 0 && n <= 256 && len === 455 + 32 * n, "platform: size " + len + " = 451 + the approved list's count at 451 (" + n + ") and 32 bytes for each of its programs");
  }
}
check(starts(platformInfo.data, DISC["account:Platform"]), "platform: discriminator");
const platform = decodePlatform(platformInfo.data);
check(platform.protocolFeeBps <= 100 && platform.maxLpFeeBps <= 2000 && platform.maxHookFeeBps <= 2000 && platform.maxFeeOverrideBps <= 9000, "platform: the four rates at 105, 107, 109, 111 are within the program's hard ceilings (" + [platform.protocolFeeBps, platform.maxLpFeeBps, platform.maxHookFeeBps, platform.maxFeeOverrideBps].join(", ") + " bps)");
check(platformInfo.data[121] <= 1 && platform.whitelistLen <= 8, "platform: the paused byte at 121 is 0 or 1, the whitelist length at 122 is at most 8");
check(platformInfo.data[8] === bumpOf(["platform"], HOOKPOOL) && !key(platformInfo.data, 9).equals(PublicKey.default), "platform: the bump at 8 is the bump of its address, the admin at 9 is set");
{
  // a template hook is upgradeable by a key on the whitelist at 123: read each template's upgrade authority
  const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const whitelist = Array.from({ length: platform.whitelistLen }, (_, i) => key(platformInfo.data, 123 + 32 * i).toBase58());
  const datas = await many(Object.values(HOOK).map((id) => pdaOf([id], LOADER)));
  const authorities = datas.map((a) => (a && a.data.length >= 45 && a.data[12] === 1 ? key(a.data, 13).toBase58() : null));
  if (authorities.every((a) => a === null)) note("the five template hooks have no upgrade authority on this cluster: the whitelist at 123 is not checked against them");
  else check(authorities.every((a) => a === null || whitelist.includes(a)), "platform: the upgrade authority of each template hook is one of the " + whitelist.length + " keys of the whitelist at 123");
  // each template publishes its flags in its manifest, [\"manifest\"] of the hook program: a u32 at offset 9
  const manifests = await many(Object.values(HOOK).map((id) => pdaOf(["manifest"], id)));
  Object.keys(HOOK).forEach((t, i) => check(!!manifests[i] && manifests[i].owner.equals(HOOK[t]) && manifests[i].data.readUInt32LE(9) === TEMPLATE_FLAGS[t], "the manifest of the " + t + " template publishes the flags " + TEMPLATE_FLAGS[t]));
}
if (opt("--lookup-table")) {
  // section 3: what the deployment's lookup table holds
  const table = await conn.getAddressLookupTable(new PublicKey(opt("--lookup-table")));
  const have = new Set(table.value ? table.value.state.addresses.map((k) => k.toBase58()) : []);
  const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const want = {
    "the seven program ids": [HOOKPOOL, HOOKLAUNCH, ...Object.values(HOOK)],
    "the platform account and its treasury": [PLATFORM, key(platformInfo.data, 73)],
    "the hook caller of a pool without a hook and of each template": [callerOf(SYSTEM), ...Object.values(HOOK).map(callerOf)],
    "the event authorities of the pool program, the launchpad, the buyback hook and the rules hook": [HOOKPOOL, HOOKLAUNCH, HOOK.buyback, HOOK.rules].map(eventAuthorityOf),
    "the manifest, the extra-accounts list and the program data account of each template": Object.values(HOOK).flatMap((id) => [pdaOf(["manifest"], id), pdaOf(["extra-metas"], id), pdaOf([id], LOADER)]),
    "the wrapped SOL mint and the rent sysvar": [WSOL, new PublicKey("SysvarRent111111111111111111111111111111111")],
    "the token, Token-2022, associated token, system and compute budget programs, Metaplex Token Metadata and Metaplex Core": [TOKEN, TOKEN_2022, ATA_PROGRAM, SYSTEM, ComputeBudgetProgram.programId, new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"), MPL_CORE],
  };
  if (!table.value) check(false, "the lookup table " + opt("--lookup-table") + " exists");
  else {
    for (const [what, keys] of Object.entries(want)) check(keys.every((k) => have.has(k.toBase58())), "the lookup table holds " + what);
    eq(have.size, new Set(Object.values(want).flat().map((k) => k.toBase58())).size, "the lookup table holds nothing else: its number of addresses");
  }
}
check(zeros(platformInfo.data, 123 + 32 * platform.whitelistLen, 32 * (8 - platform.whitelistLen)) && zeros(platformInfo.data, 406, 45) && platformInfo.data[405] <= 1, "platform: the unused whitelist entries and the reserved bytes at 406 are zeros, the approved-list rule at 405 is 0 or 1");
{
  // section 5: the settings a new pool on the curve copies
  const v = platform.curveVirtualQuote, t = platform.curveGraduationTarget;
  check(platform.curveGraduationFeeBps <= MAX_GRADUATION_FEE_BPS && v <= MAX_CURVE_VIRTUAL_QUOTE && (v === 0n || t === 0n || t >= v / 1000n),
    "platform: the curve settings at 387, 395 and 403 are within the program's bounds (a fee of at most 1,000 bps, a virtual quote of at most u64::MAX / 4, a target of at least a thousandth of it)");
  note("platform: new pools on the curve get " + v + " lamports of virtual quote, a graduation target of " + t + " lamports and a fee of " + platform.curveGraduationFeeBps + " bps" + (v === 0n || t === 0n ? ": curve launches are off" : ""));
}
if (platform.paused) note("the platform is paused: every simulated trade will fail with 6000");

console.log("# pools");
const poolAccounts = await conn.getProgramAccounts(HOOKPOOL, { filters: [{ memcmp: { offset: 0, bytes: POOL_FILTER } }] });
check(poolAccounts.length > 0, "getProgramAccounts with memcmp(0, " + POOL_FILTER + ") finds " + poolAccounts.length + " pools");
check(poolAccounts.every((a) => a.account.data.length === LAYOUT.pool.size), "every pool account is " + LAYOUT.pool.size + " bytes");
{
  const countAfter = decodePlatform((await conn.getAccountInfo(PLATFORM)).data).poolCount;
  const found = BigInt(poolAccounts.length);
  check(found >= platform.poolCount && found <= countAfter, "the platform's pool count at 379 is the number of pools found (" + found + (countAfter === platform.poolCount ? "" : "; it went from " + platform.poolCount + " to " + countAfter + " while the list was read") + ")");
}
const launchAccounts = await conn.getProgramAccounts(HOOKLAUNCH, { filters: [{ memcmp: { offset: 0, bytes: LAUNCH_FILTER } }] });
check(launchAccounts.every((a) => a.account.data.length === LAYOUT.launch.size), "getProgramAccounts with memcmp(0, " + LAUNCH_FILTER + ") finds " + launchAccounts.length + " launch records, each " + LAYOUT.launch.size + " bytes");
const launchByPool = new Map(launchAccounts.map((a) => [key(a.account.data, 41).toBase58(), a]));
if (launchAccounts.length) {
  const newest = launchAccounts.reduce((a, b) => (u64(b.account.data, 193) > u64(a.account.data, 193) ? b : a));
  eq(u64(newest.account.data, 177), platform.launchFee, "the newest launch record paid the launch fee at platform offset 113");
}
if (poolAccounts.length === 0) { console.log("no pool on this cluster: nothing more to check"); process.exit(failed ? 1 : 0); }
{
  const sample = poolAccounts[0];
  const one = await conn.getProgramAccounts(HOOKPOOL, { filters: [{ memcmp: { offset: 0, bytes: POOL_FILTER } }, { memcmp: { offset: 9, bytes: key(sample.account.data, 9).toBase58() } }] });
  check(one.length >= 1 && one.some((a) => a.pubkey.equals(sample.pubkey)), "adding memcmp(9, coin mint) finds that coin's pool");
  const hooked = poolAccounts.find((a) => !key(a.account.data, 267).equals(SYSTEM));
  if (hooked) {
    const h = key(hooked.account.data, 267);
    const got = await conn.getProgramAccounts(HOOKPOOL, { filters: [{ memcmp: { offset: 0, bytes: POOL_FILTER } }, { memcmp: { offset: 267, bytes: h.toBase58() } }] });
    eq(got.length, poolAccounts.filter((a) => key(a.account.data, 267).equals(h)).length, "adding memcmp(267, hook program) finds the pools of that hook");
  }
}

/// Every pool: the static facts of sections 3, 5 and 11, read in one consistent call.
const pools = [];
const tally = new Map(); // assertion text -> { pass, fail: [pool] }
const perPool = (ok, poolKey, text) => { const t = tally.get(text) || { pass: 0, fail: [] }; if (ok) t.pass++; else t.fail.push(short(poolKey)); tally.set(text, t); return ok; };
for (const a of poolAccounts) {
  const poolKey = a.pubkey;
  const first = decodePool(a.account.data);
  const cfgKey = hasHook(first) ? pdaOf(["cfg", poolKey], first.hookProgram) : null;
  const launchKey = pdaOf(["launch", first.baseMint], HOOKLAUNCH);
  const keys = [poolKey, first.baseVault, first.quoteVault, first.lpMint, first.lpLock, first.baseMint, first.quoteMint, launchKey, ...(cfgKey ? [cfgKey, first.hookExtraMetas, pdaOf(["manifest"], first.hookProgram)] : []), ...(first.hookTreasury.equals(PublicKey.default) ? [] : [first.hookTreasury])];
  const got = await many(keys);
  const [poolInfo, baseVault, quoteVault, lpMint, lpLock, baseMint, quoteMint, launch] = got;
  const d = poolInfo.data;
  const p = decodePool(d);
  const cfg = cfgKey ? got[8] : null, extraMetas = cfgKey ? got[9] : null, manifest = cfgKey ? got[10] : null;
  const treasury = p.hookTreasury.equals(PublicKey.default) ? null : got[cfgKey ? 11 : 8];
  const t = templateOf(p);
  const P = (ok, text) => perPool(ok, poolKey, text);
  // a rules pool has four more accounts of its own; a buyback pool one
  const authority = t === "rules" || t === "buyback" ? hookAuthorityOf(poolKey, p.hookProgram) : null;
  const [burnAccount, stakeVault, lockRecord, lockVault, validation, creatorHolder] = authority ? await many([ataOf(authority, p.baseMint, p.baseTokenProgram), ...(t === "rules" ? [stakeVaultOf(poolKey), lockOf(poolKey), lockVaultOf(poolKey), validationOf(p.baseMint), holderOf(poolKey, p.creator)] : [])]) : [];
  P(starts(d, DISC["account:Pool"]) && poolInfo.owner.equals(HOOKPOOL), "discriminator and owner");
  P(poolKey.equals(pdaOf(["pool", p.baseMint, p.quoteMint], HOOKPOOL)) && d[8] === bumpOf(["pool", p.baseMint, p.quoteMint], HOOKPOOL), "its address is [\"pool\", base mint at 9, quote mint at 41], with the bump at 8");
  P(p.baseVault.equals(pdaOf(["vault", poolKey, p.baseMint], HOOKPOOL)) && p.quoteVault.equals(pdaOf(["vault", poolKey, p.quoteMint], HOOKPOOL)), "the vaults at 73 and 105 are [\"vault\", pool, mint]");
  P(p.lpMint.equals(pdaOf(["lp", poolKey], HOOKPOOL)) && p.lpLock.equals(pdaOf(["lp-lock", poolKey], HOOKPOOL)), "the LP mint at 137 is [\"lp\", pool] and the lock account at 169 is [\"lp-lock\", pool]");
  P(!!baseMint && baseMint.owner.equals(p.baseTokenProgram) && !!quoteMint && quoteMint.owner.equals(p.quoteTokenProgram), "the token programs at 201 and 233 own the two mints");
  P(p.baseTokenProgram.equals(TOKEN) || p.baseTokenProgram.equals(TOKEN_2022), "the base token program is SPL Token or Token-2022");
  P(p.lpFeeBps <= platform.maxLpFeeBps || p.lpFeeBps <= 2000, "the pool fee at 265 is a rate");
  P(p.createdSlot > 0n && p.createdSlot <= BigInt(slotNow) && !p.creator.equals(PublicKey.default), "the creation slot at 424 is in the past and the creator at 432 is set");
  // section 5 and 14: the curve fields
  P(p.curveState <= CURVE_GRADUATED && zeros(d, 523, 5), "the curve state at 522 is 0, 1 or 2, and the reserved bytes at 523 are zeros");
  if (p.curveState === CURVE_NONE) P(zeros(d, 504, 19), "a seeded pool: 504 to 522 are zeros, no virtual quote, no target");
  else {
    P(baseMint.data.readUInt32LE(0) === 0 && (p.hookFlags & FLAG.OVERRIDE_CURVE) === 0, "a pool on the curve or graduated: the mint can never mint again and no hook owns the curve");
    P(p.graduationFeeBps <= MAX_GRADUATION_FEE_BPS, "a pool on the curve or graduated: the graduation fee at 520 is at most 1,000 bps");
    P(!(p.baseTokenProgram.equals(TOKEN_2022) && p.hookProgram.equals(HOOK.collectible) && transferHookOf(baseMint.data)), "a pool on the curve or graduated: not a pegged coin");
  }
  if (p.curveState === CURVE_OPEN) {
    P(p.virtualQuote > 0n && p.graduationTarget > 0n && p.virtualQuote <= MAX_CURVE_VIRTUAL_QUOTE, "on the curve: a virtual quote at 504 and a graduation target at 512");
  }
  if (p.curveState === CURVE_GRADUATED) P(p.virtualQuote === 0n && p.graduationTarget === 0n, "graduated: the virtual quote at 504 and the target at 512 are zero");
  if (!hasHook(p)) P(p.hookFlags === 0 && p.hookKind === 0 && p.hookExtraMetas.equals(PublicKey.default) && p.hookTreasury.equals(PublicKey.default) && p.treasuryOwner.equals(PublicKey.default) && p.hookFeesCharged === 0n && p.hookFeesOwed === 0n, "no hook: flags, kind, list, treasury, treasury owner and hook fees are all zero");
  else {
    P(p.hookKind === 1 || p.hookKind === 2, "the hook kind at 367 is 1 or 2");
    P(t === "custom" || p.hookKind === 2, "a platform template has kind 2");
    const has = (bits) => (p.hookFlags & bits) === bits, none = (bits) => (p.hookFlags & bits) === 0;
    if (t === "tax" || t === "buyback") P(has(FLAG.BEFORE_SWAP | FLAG.TAKE_HOOK_FEE | FLAG.CALL_ON_BUY | FLAG.CALL_ON_SELL) && none(FLAG.AFTER_SWAP | FLAG.OVERRIDE_FEE | FLAG.OVERRIDE_CURVE), "tax and buyback pools: flags BEFORE_SWAP, TAKE_HOOK_FEE, CALL_ON_BUY and CALL_ON_SELL, no other power");
    if (t === "launch_guard") P(has(FLAG.BEFORE_SWAP | FLAG.OVERRIDE_FEE | FLAG.CALL_ON_BUY) && none(FLAG.AFTER_SWAP | FLAG.TAKE_HOOK_FEE | FLAG.OVERRIDE_CURVE | FLAG.CALL_ON_SELL), "launch guard pools: flags BEFORE_SWAP, OVERRIDE_FEE and CALL_ON_BUY, never called on sells");
    if (t === "collectible") P(has(FLAG.AFTER_SWAP | FLAG.CALL_ON_BUY) && none(FLAG.BEFORE_SWAP | FLAG.TAKE_HOOK_FEE | FLAG.OVERRIDE_FEE | FLAG.OVERRIDE_CURVE | FLAG.CALL_ON_SELL), "collectible pools: flags AFTER_SWAP and CALL_ON_BUY, no fee, no power, never called on sells");
    if (t === "rules") P(has(FLAG.BEFORE_SWAP | FLAG.OVERRIDE_FEE | FLAG.TAKE_HOOK_FEE | FLAG.CALL_ON_BUY | FLAG.CALL_ON_SELL) && none(FLAG.AFTER_SWAP | FLAG.OVERRIDE_CURVE), "rules pools: flags BEFORE_SWAP, OVERRIDE_FEE, TAKE_HOOK_FEE, CALL_ON_BUY and CALL_ON_SELL, never the curve");
    if (t !== "custom") P(p.hookFlags === TEMPLATE_FLAGS[t], "a pool on a platform template carries the flags of its template's manifest (tax and buyback 12865, launch guard 4421, collectible 4162, rules 13125)");
    if (t !== "custom") P((p.hookFlags & FLAG.LIQUIDITY) === (t === "launch_guard" || t === "rules" ? FLAG.BEFORE_ADD_LIQ : 0), "of the liquidity bits, the launch guard and the rules template set BEFORE_ADD_LIQ and nothing else; tax, buyback and collectible set none");
    P(p.hookExtraMetas.equals(pdaOf(["extra-metas"], p.hookProgram)) && !!extraMetas && extraMetas.owner.equals(p.hookProgram), "the list at 303 is [\"extra-metas\"] of the hook program, and that program owns it");
    P(!!manifest && manifest.owner.equals(p.hookProgram), "the hook has a manifest at [\"manifest\"]");
    P((p.hookFlags & FLAG.OVERRIDE_CURVE) === 0 || !launch, "a launched coin has no hook that owns the curve");
    const takesFee = (p.hookFlags & FLAG.TAKE_HOOK_FEE) !== 0;
    P(takesFee === !p.hookTreasury.equals(PublicKey.default), "a treasury at 335 exactly when the flags carry TAKE_HOOK_FEE");
    if (takesFee) P(p.hookTreasury.equals(ataOf(p.treasuryOwner, p.quoteMint, p.quoteTokenProgram)), "the treasury at 335 is the associated token account of the wallet at 472 for the quote mint");
    else P(p.treasuryOwner.equals(PublicKey.default) && p.hookFeesOwed === 0n, "no fee: treasury owner and fees owed are zero");
    P(p.hookFeesOwed <= p.hookFeesCharged, "hook fees owed (464) never exceed hook fees charged (400)");
  }
  const amount = (info) => (info && info.data.length >= 72 ? u64(info.data, 64) : null);
  P(amount(baseVault) === p.reserveBase + p.protocolFeesBase, "base vault balance = reserve_base + protocol fees owed");
  P(amount(quoteVault) === p.reserveQuote + p.protocolFeesQuote + p.hookFeesOwed, "quote vault balance = reserve_quote + protocol fees owed + hook_fees_owed_quote");
  P(key(baseVault.data, 32).equals(poolKey) && key(quoteVault.data, 32).equals(poolKey), "the pool owns both vaults");
  P(!!lpMint && lpMint.owner.equals(TOKEN) && lpMint.data[44] === 6 && lpMint.data.readUInt32LE(0) === 1 && key(lpMint.data, 4).equals(poolKey), "the LP mint is an SPL Token mint with 6 decimals whose authority is the pool");
  P(!!lpLock && lpLock.owner.equals(TOKEN) && key(lpLock.data, 0).equals(p.lpMint) && key(lpLock.data, 32).equals(poolKey), "the lock account is an SPL Token account of the LP mint, owned by the pool");
  const lpSupply = lpMint ? u64(lpMint.data, 36) : 0n, locked = amount(lpLock) ?? 0n;
  P(locked >= 1000n && locked <= lpSupply, "the lock account holds at least the first 1,000 LP units");
  if (p.curveState === CURVE_OPEN) P(lpSupply === locked, "on the curve: every LP share is in the lock account, nobody else holds any");
  P(baseMint.data.readUInt32LE(46) === 0, "the coin has no freeze authority");
  const hook2022 = p.baseTokenProgram.equals(TOKEN_2022) ? transferHookOf(baseMint.data) : null;
  if (hook2022) P(hook2022.equals(p.hookProgram) && p.hookKind === 2, "a coin with a transfer hook points it at the pool's own platform hook");
  const isStrict = !!hook2022 && t === "rules";
  if (hook2022) P(transferHookAuthorityOf(baseMint.data) === null, "a coin with a transfer hook: the hook has no authority, so it can never be changed or removed");
  if (launch) {
    const l = launch.data;
    P(starts(l, DISC["account:Launch"]) && l.length === LAYOUT.launch.size && launch.owner.equals(HOOKLAUNCH) && l[8] === bumpOf(["launch", p.baseMint], HOOKLAUNCH), "launch record: discriminator, size, owner, bump at 8");
    P(key(l, 41).equals(poolKey) && key(l, 73).equals(p.baseMint) && key(l, 105).equals(p.quoteMint) && key(l, 137).equals(p.hookProgram), "launch record: pool 41, base mint 73, quote mint 105, hook program 137");
    P(key(l, 9).equals(p.creator) && u64(l, 193) === p.createdSlot, "launch record: the dev at 9 is the pool's creator, the slot at 193 is the pool's creation slot");
    if (p.curveState === CURVE_NONE) {
      P(locked >= u64(l, 169) + 1000n, "launch record of a seeded launch: the lock account holds the LP locked at 169 and the pool's own 1,000");
      P(l[201] === 0 && zeros(l, 202, 63), "launch record of a seeded launch: byte 201 is 0, the reserved bytes after it are zeros");
    } else {
      P(locked >= u64(l, 169) && (p.curveState !== CURVE_OPEN || u64(l, 169) === lpSupply), "launch record of a launch on the curve: the LP locked at 169 is the pool's whole LP supply at launch, and it is all in the lock account");
      P(l[201] === 1 && zeros(l, 202, 63), "launch record of a launch on the curve: byte 201 is 1, the reserved bytes after it are zeros");
    }
    P(baseMint.data.readUInt32LE(0) === 0, "a launched coin has no mint authority");
    P(u64(l, 185) === 0n || p.swaps >= 1n, "launch record: a dev buy at 185 means at least one swap");
  }
  if (cfgKey && t !== "custom") {
    const name = { tax: "tax_config", launch_guard: "guard_config", buyback: "buyback_config", collectible: "collection_config", rules: "rules_config" }[t];
    const disc = DISC["account:" + { tax: "TaxConfig", launch_guard: "GuardConfig", buyback: "BuybackConfig", collectible: "CollectionConfig", rules: "RulesConfig" }[t]];
    if (P(!!cfg && cfg.owner.equals(p.hookProgram), "its config is at [\"cfg\", pool] of the hook program")) {
      const c = cfg.data;
      P(c.length === LAYOUT[name].size && starts(c, disc), t + " config: size " + LAYOUT[name].size + " and discriminator");
      P(key(c, t === "buyback" || t === "rules" ? 10 : t === "collectible" ? 11 : 9).equals(poolKey) && c[8] === bumpOf(["cfg", poolKey], p.hookProgram), t + " config: its pool field is this pool, its bump is at 8");
      if (t === "buyback") P(c[9] === bumpOf(["hook-authority", poolKey], HOOK.buyback), "buyback config: the bump of the hook authority at 9");
      if (t === "buyback") {
        const obs = { slot: u64(c, 206), base: u64(c, 214), quote: u64(c, 222) };
        P(u64(c, 142) <= 1_000_000_000n, "buyback config: the smallest balance a buyback runs on, at 142, is at most 1 SOL");
        P((obs.base === 0n) === (obs.quote === 0n) && obs.slot <= BigInt(slotNow) + 2n && (obs.base !== 0n || obs.slot === 0n), "buyback config: the observation at 206, 214 and 222 is all zeros, or a slot in the past with two reserves");
        P(!!burnAccount && burnAccount.owner.equals(p.baseTokenProgram) && key(burnAccount.data, 32).equals(authority), "buyback: the hook authority has an associated token account for the coin, where a buyback lands before it is burned");
      }
      if (t === "rules") {
        const r = decodeRules(c);
        const supply = u64(baseMint.data, 36);
        const held = (info) => (info && info.data.length >= 72 ? u64(info.data, 64) : null);
        P(c[9] === bumpOf(["hook-authority", poolKey], HOOK.rules) && r.baseMint.equals(p.baseMint) && r.quoteMint.equals(p.quoteMint) && r.treasury.equals(p.hookTreasury) && r.creator.equals(p.creator), "rules config: authority bump 9, base mint 42, quote mint 74, treasury 106 = the pool's treasury, creator 138 = the pool's creator");
        P(p.treasuryOwner.equals(authority), "rules: the treasury owner at pool offset 472 is [\"hook-authority\", pool] of the rules hook");
        P([r.buy, r.sell].every((s) => s.creator <= 500 && s.holders <= 500 && s.burn <= 500 && ratesSum(s) <= 1000), "rules config: the three rates of buys at 180 and of sells at 186 are within the program's ceilings (500 each, 1,000 a side)");
        P(r.sniperSlots <= 10800n && r.sniperStartFeeBps <= 5000 && (r.sniperSlots === 0n) === (r.sniperStartFeeBps === 0), "rules config: sniper window 170 and start fee 178 are within the ceilings, and both zero or both set");
        P(r.limitSlots <= 9000n && (r.maxBuyQuote === 0n) === (r.limitSlots === 0n), "rules config: buy limit 192 and its window 200 are both zero or both set, the window at most 9,000 slots");
        P(r.creatorLockSeconds <= MAX_LOCK_SECONDS, "rules config: the declared lock at 208 is at most 365 days");
        P(r.startSlot === p.createdSlot && r.startTime > 0n, "rules config: start slot 216 is the pool's creation slot, start time 224 is set");
        // burns lower the supply after launch: the rules hook's own, and graduation (section 14)
        P(r.minEligible >= maxB(1n, supply / 1000n) && (r.totalBaseBurned > 0n || p.curveState === CURVE_GRADUATED || r.minEligible === maxB(1n, supply / 1000n)), "rules config: the smallest stake that earns, at 232, is a thousandth of the coin's supply at launch");
        P(r.feesSeen <= p.hookFeesCharged - p.hookFeesOwed, "rules config: the fees settled so far, at 240, never exceed what the pool paid the treasury (pool offsets 400 minus 464)");
        P((r.obsBase === 0n) === (r.obsQuote === 0n) && r.obsSlot <= BigInt(slotNow) + 2n && (r.obsBase !== 0n || r.obsSlot === 0n), "rules config: the observation at 350, 358 and 366 is all zeros, or a slot in the past with two reserves");
        if (!isStrict) P(zeros(c, 374, 40), "rules config of a plain coin: bytes 374 to 413 are zeros, so its kind at 374 is 0");
        else {
          const st = decodeStrict(c), supplyNow = u64(baseMint.data, 36);
          P(st.kind === 1 && st.buyMark === 0 && zeros(c, 397, 17), "rules config of a strict coin: kind 1 at 374, the mark at 375 is 0 between instructions, the reserve at 397 is zeros");
          P(st.vaultBump === bumpOf(["vault", poolKey, p.baseMint], HOOKPOOL), "rules config of a strict coin: 376 is the bump of the pool's vault of the coin");
          P((st.maxWalletBps === 0) === (st.maxWalletSlots === 0n) && (st.maxWalletBps === 0 || (st.maxWalletBps >= STRICT.maxWalletBpsMin && st.maxWalletBps <= STRICT.maxWalletBpsMax && st.maxWalletSlots <= STRICT.maxWalletSlots)), "rules config of a strict coin: the max wallet at 377 and its window at 381 are both zero or both set, inside the program's bounds");
          P((st.earlySlots === 0) === (st.earlyUnlockSlots === 0n) && (st.earlySlots === 0 || (st.earlySlots <= STRICT.earlySlots && st.earlyUnlockSlots >= BigInt(st.earlySlots) && st.earlyUnlockSlots <= STRICT.earlyUnlockSlots)), "rules config of a strict coin: the early window at 379 and the unlock at 385 are both zero or both set, the unlock not before the end of the window");
          P(st.maxWalletBps === 0 ? st.maxWalletAmount === 0n : st.maxWalletAmount >= maxB(1n, (supplyNow * BigInt(st.maxWalletBps)) / 10000n), "rules config of a strict coin: the max wallet in coins at 389 is max(1, supply at the pool's creation * 377 / 10000), zero without a max wallet");
          const list = validation && validation.owner.equals(HOOK.rules) ? validation.data : null;
          const entry = (i) => list.subarray(16 + 35 * i, 16 + 35 * (i + 1));
          const holderSeeds = (n) => Buffer.from([1, 6, ...Buffer.from("holder"), 4, 5, 10, 32, 4, n, 32, 32]);
          P(!!list && starts(list, DISC["spl-transfer-hook-interface:execute"]) && list.readUInt32LE(12) === 3 && entry(0)[0] === 0 && key(entry(0), 1).equals(cfgKey) && entry(0)[34] === 1
            && [1, 2].every((i) => entry(i)[0] === 1 && entry(i).subarray(1, 1 + 16).equals(holderSeeds(i === 1 ? 0 : 2)) && zeros(entry(i), 17, 16) && entry(i)[33] === 0 && entry(i)[34] === 1),
            "strict coin: its account list [\"extra-account-metas\", mint] has three entries: the config (writable), [\"holder\", config bytes 10..42, source bytes 32..64] and the same with the destination (writable)");
          if (lockRecord) P(!!creatorHolder && u64(creatorHolder.data, 113) === u64(lockRecord.data, 41) && creatorHolder.data.readBigInt64LE(121) === lockRecord.data.readBigInt64LE(49), "strict coin with a creator lock: the creator's holder record carries the lock record's amount (113) and date (121)");
        }
        P(held(treasury) !== null && held(treasury) >= r.creatorOwed + r.burnPot + r.rewardsOwedTotal, "rules: the treasury holds at least what the config owes the creator (254), the burn pot (262) and the rewards owed (302)");
        if (!isStrict) P(!!burnAccount && burnAccount.owner.equals(p.baseTokenProgram) && key(burnAccount.data, 32).equals(authority), "rules: the burn account is the associated token account of the hook authority for the coin");
        else P(!burnAccount && !stakeVault && !lockVault, "strict coin: no burn account, no stake vault and no lock vault exist");
        if (!isStrict) P(!!stakeVault && key(stakeVault.data, 0).equals(p.baseMint) && key(stakeVault.data, 32).equals(cfgKey) && held(stakeVault) >= r.totalStaked, "rules: the stake vault [\"stake-vault\", pool] is a token account of the coin owned by the config, and holds what is staked (294)");
        if (lockRecord) {
          const l = lockRecord.data;
          P(l.length === LAYOUT.lock_record.size && starts(l, DISC["account:LockRecord"]) && lockRecord.owner.equals(HOOK.rules) && l[8] === bumpOf(["lock", poolKey], HOOK.rules) && key(l, 9).equals(poolKey), "rules: the lock record [\"lock\", pool] is 57 bytes: discriminator, bump 8, pool 9");
          if (!isStrict) P(!!lockVault && key(lockVault.data, 0).equals(p.baseMint) && key(lockVault.data, 32).equals(cfgKey) && held(lockVault) >= u64(l, 41) && (u64(l, 41) === 0n) === (l.readBigInt64LE(49) === 0n), "rules: the lock vault [\"lock-vault\", pool] is a token account of the coin owned by the config and holds the amount at 41; amount and unlock time at 49 are both zero or both set");
        }
      }
      if (t === "collectible") P(c[9] === bumpOf(["authority", poolKey], HOOK.collectible) && c[10] === bumpOf(["collection", poolKey], HOOK.collectible), "collection config: the bumps of the collection authority and of the collection at 9 and 10");
      if (t === "tax") P(c.readUInt16LE(73) <= c.readUInt16LE(77) && c.readUInt16LE(75) <= c.readUInt16LE(77) && c.readUInt16LE(77) <= 1000 && key(c, 79).equals(p.creator), "tax config: buy 73 and sell 75 are within the ceiling at 77, the creator at 79 is the pool's creator");
      if (t === "launch_guard") P(u64(c, 41) === p.createdSlot && u64(c, 49) >= 1n && u64(c, 49) <= 10800n && c.readUInt16LE(57) <= 5000 && key(c, 59).equals(p.creator), "guard config: start slot 41 is the pool's creation slot, window 49, start fee 57, creator 59");
      if (t === "buyback") {
        const authority = pdaOf(["hook-authority", poolKey], HOOK.buyback);
        P(key(c, 42).equals(p.baseMint) && key(c, 74).equals(p.quoteMint) && key(c, 106).equals(p.hookTreasury) && key(c, 174).equals(p.creator), "buyback config: base mint 42, quote mint 74, treasury 106 = the pool's treasury, creator 174");
        P(p.treasuryOwner.equals(authority), "buyback: the treasury owner at pool offset 472 is [\"hook-authority\", pool] of the buyback hook");
      }
      if (t === "collectible") {
        P(key(c, 107).equals(pdaOf(["collection", poolKey], HOOK.collectible)) && key(c, 139).equals(p.baseMint) && key(c, 171).equals(p.baseTokenProgram) && key(c, 43).equals(p.creator), "collection config: collection 107 is [\"collection\", pool], coin 139, token program 171, creator 43");
        P((c[203] === 1) === !!hook2022 && c[203] <= 1, "collection config: the pegged byte at 203 is set exactly when the mint carries a transfer hook");
        P(u64(c, 204) > 0n && c.readUInt32LE(212) > 0 && c[228] >= 1 && c[228] <= 5 && c.readUInt32LE(220) <= c.readUInt32LE(216), "collection config: unit 204, most pieces 212, pieces now 220 <= ever minted 216, max per buy 228 between 1 and 5");
        const nameLen = c.readUInt32LE(247);
        P(nameLen >= 1 && nameLen <= 24 && c.readUInt32LE(251 + nameLen) <= 80, "collection config: two strings from 247, a name of at most 24 bytes and an address of at most 80");
      }
    }
  }
  pools.push({ lock: lockRecord && lockRecord.data.length === LAYOUT.lock_record.size && lockVault && lockVault.data.length >= 72 ? { amount: u64(lockRecord.data, 41), unlockAt: lockRecord.data.readBigInt64LE(49), inVault: u64(lockVault.data, 64) } : null, poolKey, pool: p, template: t, pegged: !!hook2022 && t === "collectible", strict: !!hook2022 && t === "rules", cfgKey, cfg: cfg ? cfg.data : null, extraMetas: extraMetas ? extraMetas.data : null, launched: !!launch, treasuryAlive: p.hookTreasury.equals(PublicKey.default) ? null : !!treasury && treasury.lamports > 0 && treasury.owner.equals(p.quoteTokenProgram) && treasury.data.length >= 165, lpSupply, locked, baseMintData: baseMint.data });
}
for (const [text, t] of tally) check(t.fail.length === 0, (t.fail.length ? t.fail.length + " of " : "all ") + (t.pass + t.fail.length) + " pools: " + text + (t.fail.length ? "  (fails on " + t.fail.slice(0, 5).join(", ") + ")" : ""));
const baseKindOf = (x) => x.template === "collectible" && x.pegged ? "pegged" : x.template === "launch_guard" ? (x.cfg && guardFeeBps(x.cfg, x.pool.lpFeeBps, slotNow, 10000) !== null ? "launch guard, window running" : "launch guard, window over")
  : x.template === "rules" && x.strict ? (x.cfg && (maxWalletRuns(decodeStrict(x.cfg), slotNow) || earlyLockRuns(decodeStrict(x.cfg), slotNow)) ? "strict, windows running" : "strict")
  : x.template === "rules" ? (x.cfg && x.cfg.length === LAYOUT.rules_config.size && sniperFeeBps(decodeRules(x.cfg), x.pool.lpFeeBps, slotNow, 10000) !== null ? "rules, sniper window running" : "rules")
  : x.template === "none" && x.pool.baseTokenProgram.equals(TOKEN_2022) ? "no hook, Token-2022 coin" : x.template === "none" ? "no hook" : x.template;
/// The kind of a pool, with how it was launched: seeded (nothing added), on the curve, graduated (section 14).
const kindOf = (x) => baseKindOf(x) + (x.pool.curveState === CURVE_OPEN ? (x.pool.reserveQuote >= x.pool.graduationTarget ? ", on the curve past its target" : ", on the curve") : x.pool.curveState === CURVE_GRADUATED ? ", graduated" : "");
{
  const count = {};
  for (const x of pools) count[kindOf(x)] = (count[kindOf(x)] || 0) + 1;
  note("kinds of pool found: " + Object.entries(count).map(([k, v]) => v + " " + k).join(", "));
  const waiting = pools.filter((x) => x.pool.hookFeesOwed > 0n);
  const closed = pools.filter((x) => x.treasuryAlive === false);
  note(closed.length + " pools have a treasury account that does not exist, " + waiting.length + " hold hook fees that wait");
  const untouched = pools.filter((x) => x.launched && x.lpSupply === x.locked && x.pool.swaps === 0n);
  const seededUntouched = untouched.find((x) => x.pool.curveState === CURVE_NONE), curveUntouched = untouched.find((x) => x.pool.curveState === CURVE_OPEN);
  if (seededUntouched) {
    const x = seededUntouched;
    eq(x.lpSupply, isqrt(x.pool.reserveBase * x.pool.reserveQuote), "a seeded launch nobody traded yet (" + short(x.poolKey) + "): LP supply = floor(sqrt(base amount * quote amount)), all of it in the lock account");
  } else note("no seeded launch without a trade: LP supply = sqrt(base * quote) is not checked");
  // section 11 and 14: a pool on the curve mints floor(sqrt(supply * virtual_quote)), all of it locked
  const curveFresh = pools.filter((x) => x.pool.curveState === CURVE_OPEN && x.pool.swaps === 0n && x.pool.reserveQuote === 0n);
  if (curveFresh.length) check(curveFresh.every((x) => x.lpSupply === isqrt(x.pool.reserveBase * x.pool.virtualQuote) && x.locked === x.lpSupply && u64(x.baseMintData, 36) === x.pool.reserveBase),
    curveFresh.length + " pools on the curve nobody traded yet" + (curveUntouched ? ", launched or created directly" : "") + ": the pool holds the whole supply, and LP supply = floor(sqrt(supply * virtual_quote)), all of it in the lock account (" + curveFresh[0].lpSupply + " for " + curveFresh[0].pool.reserveBase + " units and " + curveFresh[0].pool.virtualQuote + " lamports)");
  else note("no pool on the curve without a trade: LP supply = sqrt(supply * virtual_quote) is not checked");
  {
    // section 4: the filters on byte 522
    const find = (bytes) => conn.getProgramAccounts(HOOKPOOL, { dataSlice: { offset: 522, length: 1 }, filters: [{ memcmp: { offset: 0, bytes: POOL_FILTER } }, { memcmp: { offset: 522, bytes } }] });
    const open = await find("2"), graduated = await find("3");
    const keys = (list) => new Set(list.map((a) => a.pubkey.toBase58()));
    const openKeys = keys(open), gradKeys = keys(graduated);
    // a pool may graduate between the two reads; a graduated pool never changes state again
    const covered = pools.every((x) => x.pool.curveState === CURVE_GRADUATED ? gradKeys.has(x.poolKey.toBase58()) : x.pool.curveState === CURVE_OPEN ? openKeys.has(x.poolKey.toBase58()) || gradKeys.has(x.poolKey.toBase58()) : !openKeys.has(x.poolKey.toBase58()) && !gradKeys.has(x.poolKey.toBase58()));
    check(open.every((a) => a.account.data[0] === CURVE_OPEN) && graduated.every((a) => a.account.data[0] === CURVE_GRADUATED) && covered,
      "memcmp(522, \"2\") finds the " + open.length + " pools on the curve and memcmp(522, \"3\") the " + graduated.length + " graduated ones, and no seeded pool");
  }
  const direct = pools.filter((x) => !x.launched);
  if (direct.length) check(direct.every((x) => x.locked >= 1000n), direct.length + " pools were created without the launchpad: their lock accounts hold the first 1,000 LP units");
}

// ---- tickets and burn queues ---------------------------------------------------------------------------------
console.log("# tickets");
{
  const tickets = await conn.getProgramAccounts(HOOK.collectible, { filters: [{ memcmp: { offset: 0, bytes: b58encode(DISC["account:Ticket"]) } }] });
  let bad = 0;
  for (const t of tickets) {
    const d = t.account.data;
    const count = d.length >= 346 ? d.readUInt32LE(342) : -1;
    let ok = d.length >= 346 && d.length >= 346 + 32 * count && t.pubkey.equals(ticketOf(key(d, 9), key(d, 41))) && d[8] === bumpOf(["ticket", key(d, 9), key(d, 41)], HOOK.collectible);
    for (let i = 0; ok && i < 4; i++) { const at = 90 + 63 * i; if (d[at] > 3 || (d[at] === 0 && !zeros(d, at, 63))) ok = false; }
    if (!ok) { bad++; check(false, "ticket " + short(t.pubkey) + ": size 346 + 32 for each piece in its list, address [\"ticket\", pool at 9, wallet at 41], batches of 63 bytes from 90"); }
  }
  if (tickets.length) check(bad === 0, "all " + tickets.length + " tickets: size, address from pool at 9 and wallet at 41, four batches from 90, list count at 342");
  else note("no ticket exists yet on this cluster: the ticket layout is checked on a simulated one below");
  for (const x of pools.filter((y) => y.pegged)) {
    const [own, queue, list] = await many([ticketOf(x.poolKey, x.poolKey), pdaOf(["queue", x.poolKey], HOOK.collectible), pdaOf(["extra-account-metas", x.pool.baseMint], HOOK.collectible)]);
    check(!!queue && queue.owner.equals(HOOK.collectible) && key(queue.data, 8).equals(x.poolKey) && queue.data.length >= 44 + 32 * queue.data.readUInt32LE(40) && !!list && list.owner.equals(HOOK.collectible),
      "pegged pool " + short(x.poolKey) + ": the burn queue [\"queue\", pool] (count at 40, " + (queue ? queue.data.readUInt32LE(40) : "?") + " waiting) and the coin's account list [\"extra-account-metas\", mint] belong to the collectible program" + (own ? "" : "; the pool's own ticket is not opened"));
  }
}

// ---- stake records of the rules template (section 13) ---------------------------------------------------------
console.log("# stake records");
{
  const records = await conn.getProgramAccounts(HOOK.rules, { filters: [{ memcmp: { offset: 0, bytes: b58encode(DISC["account:StakeRecord"]) } }] });
  if (!records.length) note("no stake record exists yet on this cluster: the layout is checked on a simulated one below");
  else {
    const bad = records.filter((t) => { const d = t.account.data; return !(d.length === LAYOUT.stake_record.size && t.pubkey.equals(stakeOf(key(d, 9), key(d, 41))) && d[8] === bumpOf(["stake", key(d, 9), key(d, 41)], HOOK.rules)); });
    check(bad.length === 0, "all " + records.length + " stake records: 113 bytes, address [\"stake\", pool at 9, wallet at 41] of the rules hook, bump at 8" + (bad.length ? "  (fails on " + bad.slice(0, 3).map((b) => short(b.pubkey)).join(", ") + ")" : ""));
    // the amounts of a pool's records add up to the config's total, read together
    const byPool = new Map();
    for (const t of records) { const k = key(t.account.data, 9).toBase58(); byPool.set(k, [...(byPool.get(k) || []), t.pubkey]); }
    let agree = 0, moved = 0;
    for (const [poolText, keys] of byPool) {
      const got = await many([rulesCfgOf(new PublicKey(poolText)), ...keys]);
      if (!got[0] || got.some((g) => !g)) { moved++; continue; }
      const sum = got.slice(1).reduce((a, g) => a + u64(g.data, 73), 0n);
      if (sum === u64(got[0].data, 294)) agree++; else if (keys.length !== (await conn.getProgramAccounts(HOOK.rules, { filters: [{ memcmp: { offset: 0, bytes: b58encode(DISC["account:StakeRecord"]) } }, { memcmp: { offset: 9, bytes: poolText } }] })).length) moved++;
    }
    check(agree + moved === byPool.size, "on each of the " + byPool.size + " pools with stakers, the amounts at 73 of its stake records add up to the config's total at 294" + (moved ? "  (" + moved + " changed while they were read)" : ""));
  }
}

// ---- holder records of strict coins (section 13) -----------------------------------------------------------
console.log("# holder records");
{
  const records = await conn.getProgramAccounts(HOOK.rules, { filters: [{ memcmp: { offset: 0, bytes: b58encode(DISC["account:HolderRecord"]) } }] });
  const strictPools = pools.filter((x) => x.strict);
  note(strictPools.length + " strict coins and " + records.length + " holder records on this cluster");
  if (records.length) {
    const bad = records.filter((t) => { const d = t.account.data; return !(d.length === LAYOUT.holder_record.size && t.pubkey.equals(holderOf(key(d, 9), key(d, 41))) && d[8] === bumpOf(["holder", key(d, 9), key(d, 41)], HOOK.rules)); });
    check(bad.length === 0, "all " + records.length + " holder records: 129 bytes, address [\"holder\", pool at 9, wallet at 41] of the rules hook, bump at 8" + (bad.length ? "  (fails on " + bad.slice(0, 3).map((b) => short(b.pubkey)).join(", ") + ")" : ""));
    const byPool = new Map();
    for (const t of records) { const k = key(t.account.data, 9).toBase58(); byPool.set(k, [...(byPool.get(k) || []), t.pubkey]); }
    let agree = 0, moved = 0;
    for (const [poolText, ks] of byPool) {
      const got = await many([rulesCfgOf(new PublicKey(poolText)), ...ks]);
      if (!got[0] || got.some((g) => !g)) { moved++; continue; }
      const sum = got.slice(1).reduce((a, g) => a + u64(g.data, 73), 0n);
      if (sum === u64(got[0].data, 294)) agree++; else moved++;
    }
    check(moved === 0 || agree > 0, "on " + agree + " of the " + byPool.size + " strict coins with holder records, the balances at 73 add up to the config's total at 294" + (moved ? "  (" + moved + " changed while they were read)" : ""));
  }
}

// =====================================================================================================
// C. simulated trades
// =====================================================================================================
console.log("# simulated trades");
let payer;
if (opt("--payer")) payer = new PublicKey(opt("--payer"));
else {
  payer = Keypair.generate().publicKey;
  try {
    const sig = await conn.requestAirdrop(payer, 3 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, "confirmed");
  } catch (e) { console.error("this cluster gives no airdrop: pass --payer <public key of a wallet that holds 2 SOL>. No key is needed, nothing is sent."); process.exit(2); }
}
if ((await conn.getBalance(payer)) < 1.5 * LAMPORTS_PER_SOL) { console.error("the payer " + payer.toBase58() + " holds less than 1.5 SOL"); process.exit(2); }
note("fee payer inside the simulations: " + payer.toBase58() + " (no signature is made, nothing is sent)");

/// The newest pools of each kind, and every pool whose treasury is missing or owed.
const chosen = [];
{
  const byKind = new Map();
  for (const x of [...pools].sort((a, b) => Number(b.pool.createdSlot - a.pool.createdSlot))) {
    const k = kindOf(x) + (x.treasuryAlive === false ? ", treasury account missing" : "");
    if (!x.pool.quoteMint.equals(WSOL)) continue;
    const list = byKind.get(k) || [];
    if (list.length < perKind) { list.push(x); byKind.set(k, list); }
  }
  for (const list of byKind.values()) chosen.push(...list);
  const skipped = pools.filter((x) => !x.pool.quoteMint.equals(WSOL)).length;
  if (skipped) note(skipped + " pools are not quoted in wrapped SOL: their trades are not simulated");
}
const cu = new Map();
const addCu = (kind, side, units) => { const k = kind + " | " + side; const v = cu.get(k) || []; v.push(units); cu.set(k, v); };
const userQuote = ataOf(payer, WSOL);

async function simulatedTrades(x) {
  const { poolKey } = x;
  const kind = kindOf(x) + (x.treasuryAlive === false ? ", treasury account missing" : "");
  const tag = kind + " " + short(poolKey) + ": ";
  const accountCache = new Map();
  const extrasFor = (pool, user) => {
    if (!hasHook(pool)) return [];
    const metas = resolveExtras(x.extraMetas, poolKey, pool, user, (k) => accountCache.get(k.toBase58()) || null);
    if (!metas) return null;
    if (x.pegged) metas.push(rw(ticketOf(poolKey, poolKey)), rw(pdaOf(["queue", poolKey], HOOK.collectible)), ro(pdaOf(["extra-account-metas", pool.baseMint], HOOK.collectible)));
    if (x.strict) metas.push(...strictPoolExtras(poolKey, pool, user));
    return metas;
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    // one consistent read of what the quote needs
    const keys = [poolKey, ...(x.cfgKey ? [x.cfgKey] : []), ...(x.pool.hookTreasury.equals(PublicKey.default) ? [] : [x.pool.hookTreasury])];
    const read = await conn.getMultipleAccountsInfoAndContext(keys, "confirmed");
    const pool = decodePool(read.value[0].data);
    const cfg = x.cfgKey && read.value[1] ? read.value[1].data : null;
    const tInfo = pool.hookTreasury.equals(PublicKey.default) ? null : read.value[x.cfgKey ? 2 : 1];
    const treasuryAlive = tInfo ? tInfo.lamports > 0 && tInfo.owner.equals(pool.quoteTokenProgram) && tInfo.data.length >= 165 : false;
    const treasuryBefore = tInfo && treasuryAlive ? u64(tInfo.data, 64) : 0n;
    accountCache.set(poolKey.toBase58(), read.value[0].data);
    const extra = extrasFor(pool, payer);
    if (!extra) { note(tag + "its hook derives an account from the callback's instruction data: not simulated"); return; }
    if (attempt === 0) {
      if (extra.some((m) => m.listedAsSigner)) note(tag + "the hook's list marks an account as signer; it is passed as a non-signer, as the pool does");
      else if (x.template !== "custom" && x.template !== "none") check(true, tag + "the template's list marks no account as signer (" + extra.length + " accounts after the seventeen)");
      if (x.template === "tax") check(extra.length === 1 && extra[0].pubkey.equals(x.cfgKey) && !extra[0].isWritable, tag + "the list resolves to the config, read-only");
      if (x.template === "buyback" || x.template === "launch_guard" || (x.template === "rules" && !x.strict)) check(extra.length === 1 && extra[0].pubkey.equals(x.cfgKey) && extra[0].isWritable, tag + "the list resolves to the config, writable");
      if (x.strict) check(extra.length === 4 && extra[0].pubkey.equals(x.cfgKey) && extra[0].isWritable && extra[1].pubkey.equals(holderOf(poolKey, payer)) && extra[1].isWritable && extra[2].pubkey.equals(holderOf(poolKey, poolKey)) && extra[2].isWritable && extra[3].pubkey.equals(validationOf(x.pool.baseMint)) && !extra[3].isWritable,
        tag + "the hook's list resolves to the config (writable); then the coin's own accounts: the signer's holder record (writable), the pool's holder record address (writable), the account list");
      if (x.template === "collectible") check(extra.length === (x.pegged ? 6 : 3) && extra[0].pubkey.equals(x.cfgKey) && extra[0].isWritable && extra[1].pubkey.equals(ticketOf(poolKey, payer)) && extra[1].isWritable && extra[2].pubkey.equals(SLOT_HASHES) && !extra[2].isWritable, tag + "the list resolves to the config (writable), the signer's ticket (writable) and SlotHashes" + (x.pegged ? ", then the three accounts of a pegged coin" : ""));
    }
    const userBase = ataOf(payer, pool.baseMint, pool.baseTokenProgram);
    // a twentieth of the quote side, at most 0.1 SOL: on a pool on the curve that just opened the real reserve is 0
    let amountIn = effectiveQuote(pool) / 20n < 100_000_000n ? effectiveQuote(pool) / 20n : 100_000_000n;
    if (x.template === "collectible" && cfg) {
      // enough to buy a little more than one unit, so that the buy can earn a piece
      const unit = u64(cfg, 204);
      const needed = unit * 3n < pool.reserveBase ? (pool.reserveQuote * unit) / (pool.reserveBase - unit) : 0n;
      const withFees = (needed * 108n) / 100n;
      if (withFees > amountIn && withFees <= 1_200_000_000n) amountIn = withFees;
    }
    const rules = x.template === "rules" && cfg && cfg.length === LAYOUT.rules_config.size ? decodeRules(cfg) : null;
    // a rules coin may limit one buy for its first slots: stay at or under the limit here
    if (rules && rules.maxBuyQuote > 0n && rules.maxBuyQuote < amountIn && BigInt(read.context.slot) < rules.startSlot + rules.limitSlots + 5n) amountIn = rules.maxBuyQuote;
    const st = x.strict && cfg ? decodeStrict(cfg) : null;
    const early = !!st && earlyRuns(st, read.context.slot + 3);
    if (st && maxWalletRuns(st, read.context.slot)) {
      // stay well under the max wallet: half of it at most
      while (amountIn > 1000n && quote(pool.reserveBase, pool.reserveQuote, pool.lpFeeBps, platform.protocolFeeBps, true, amountIn, 0, null, pool.virtualQuote).out > st.maxWalletAmount / 2n) amountIn /= 2n;
    }
    // in the early window a buy needs the buyer's holder record: open it first
    const pre = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...(early ? [openHolderIx(payer, poolKey, pool)] : []), createAta(payer, payer, pool.baseMint, pool.baseTokenProgram), ...wrap(payer, amountIn)];
    const buy = swapIx(poolKey, pool, payer, userBase, userQuote, 0, amountIn, 0n, extra);
    const hasTreasury = !pool.hookTreasury.equals(PublicKey.default);
    const watch = [poolKey, userBase, ...(hasTreasury ? [pool.hookTreasury] : []), ...(x.cfgKey ? [x.cfgKey] : [])];
    const sim = await simulate([...pre, buy], payer, watch);
    const treasuryAfter = hasTreasury ? sim.accounts[2] : null;
    const cfgAfter = x.cfgKey && sim.accounts[watch.length - 1] ? sim.accounts[watch.length - 1].data : null;
    // somebody else may have traded between the read and the simulation: read again, retry
    const again = decodePool((await conn.getAccountInfo(poolKey)).data);
    if (again.swaps !== pool.swaps || again.reserveBase !== pool.reserveBase || again.reserveQuote !== pool.reserveQuote) continue;
    if (sim.err) { check(false, tag + "a simulated buy of " + amountIn + " lamports succeeds  (error " + errorOf(sim) + ": " + sim.logs.slice(-3).join(" / ").slice(0, 200) + ")"); return; }

    // ---- the buy ----
    eq(sim.returnProgram, HOOKPOOL.toBase58(), tag + "the return data of a simulated buy is set by the pool program");
    const after = sim.accounts[0] ? decodePool(sim.accounts[0].data) : null;
    const received = sim.accounts[1] ? u64(sim.accounts[1].data, 64) : null;
    eq(received, sim.out, tag + "the return data is what reached the token account");
    const ev = sim.hasInner ? eventsOf(sim, "Swapped", HOOKPOOL).map((e) => decodeSwapped(e.body))[0] : null;
    const answer = hookAnswer(pool, platform, cfg, true, ev ? Number(ev.slot) : sim.slot);
    const q = quote(pool.reserveBase, pool.reserveQuote, pool.lpFeeBps, platform.protocolFeeBps, true, amountIn, answer.hookFeeBps, answer.feeOverrideBps, pool.virtualQuote);
    if (!answer.exact) {
      note(tag + "a hook this script cannot predict runs before buys: simulated output " + sim.out + ", formula without the hook " + q.out);
    } else if (answer.window && !ev) {
      // without the event the slot of the simulation is not known exactly: accept the slots around it
      const candidates = [-1, 0, 1, 2].map((d) => { const a = hookAnswer(pool, platform, cfg, true, sim.slot + d); return quote(pool.reserveBase, pool.reserveQuote, pool.lpFeeBps, platform.protocolFeeBps, true, amountIn, a.hookFeeBps, a.feeOverrideBps, pool.virtualQuote).out; });
      check(candidates.includes(sim.out), tag + "the buy pays the formula amount at the slot of the simulation (" + sim.out + ")");
    } else {
      eq(sim.out, q.out, tag + "a buy of " + amountIn + " lamports pays the formula amount" + (answer.window ? " with the " + (rules ? "sniper fee" : "launch guard's fee") + " of slot " + ev.slot + ", " + q.feeBps + " bps" : "") + (answer.hookFeeBps ? " after a hook fee of " + answer.hookFeeBps + " bps" : "") + (pool.virtualQuote ? ", on the curve: priced with " + pool.reserveQuote + " real and " + pool.virtualQuote + " virtual lamports" : ""));
    }
    if (answer.window) {
      const a = hookAnswer(pool, platform, cfg, true, read.context.slot);
      const atRead = quote(pool.reserveBase, pool.reserveQuote, pool.lpFeeBps, platform.protocolFeeBps, true, amountIn, a.hookFeeBps, a.feeOverrideBps, pool.virtualQuote);
      check(sim.out >= atRead.out, tag + "inside the " + (rules ? "sniper" : "guard") + " window a later slot gives the quoted amount or more (" + sim.out + " >= " + atRead.out + " quoted at slot " + read.context.slot + ")");
    }
    if (rules && cfgAfter) {
      // what before_swap wrote in the config: the settlement of the trade before, the rates of this one
      const want = settleRules(rules, pool), got = decodeRules(cfgAfter);
      check(same(Object.values(got.lastSplit), Object.values(rules.buy)), tag + "the config after the buy: the three rates at 248 are the rates of a buy, for the next settlement");
      check(got.feesSeen === want.feesSeen && got.creatorOwed === want.creatorOwed && got.burnPot === want.burnPot && got.accPerShare === want.accPerShare && got.rewardRem === want.rewardRem,
        tag + "the config after the buy: the fee of the trade before was settled as the document says (creator " + (want.creatorOwed - rules.creatorOwed) + ", burn pot " + (want.burnPot - rules.burnPot) + ", stakers " + (want.accPerShare !== rules.accPerShare ? "paid" : "none") + ")");
      check(cfgAfter.subarray(8, 240).equals(cfg.subarray(8, 240)), tag + "the config after the buy: bytes 8 to 239, the rules, did not change");
    }
    if ((rules || x.template === "buyback") && cfgAfter) {
      // the observation of the buyback or the burn: a trade that starts below it lowers it, and never moves its slot
      const at = rules ? 350 : 206;
      const obs = { slot: u64(cfg, at), base: u64(cfg, at + 8), quote: u64(cfg, at + 16) };
      // the observation is made of the quote side of the price, real plus virtual (section 12)
      const low = burnLowered(obs, pool.reserveBase, effectiveQuote(pool));
      const deeper = effectiveQuote(pool) > obs.quote;
      check(u64(cfgAfter, at) === obs.slot && u64(cfgAfter, at + 8) === (low ? low.base : obs.base) && u64(cfgAfter, at + 16) === (low ? low.quote : obs.quote),
        tag + "the config after the buy: " + (obs.base === 0n ? "no observation yet, none is written by a trade"
          : !low ? "the trade did not start below the observed price: the observation did not move"
          : deeper ? "the trade started below the observed price on a pool deeper than the observation: the observed quote reserve stays (" + obs.quote + ", the pool has " + effectiveQuote(pool) + "), the base reserve becomes ceil(quote * reserve_base / reserve_quote); the slot stays"
          : "the trade started below the observed price: the observation is now the pool's two reserves at the start of the trade; its slot stays"));
    }
    if (after && answer.exact) {
      const hookFee = q.hookFee;
      check(after.reserveQuote === q.reserveQuote && after.reserveBase === q.reserveBase, tag + "after the buy: reserve_quote += net_in + lp_fee, reserve_base -= gross" + (pool.virtualQuote ? " (the real reserves)" : ""));
      if (pool.curveState !== CURVE_NONE) check(after.virtualQuote === pool.virtualQuote && after.graduationTarget === pool.graduationTarget && after.curveState === pool.curveState, tag + "after the buy: the curve fields at 504 to 522 did not move; a trade never graduates a pool" + (pool.curveState === CURVE_OPEN && q.reserveQuote >= pool.graduationTarget ? ", also one that leaves it past its target" : ""));
      check(after.protocolFeesQuote === pool.protocolFeesQuote + q.protocolFee && after.protocolFeesBase === pool.protocolFeesBase, tag + "after the buy: protocol fees owed in quote (392) grew by the protocol fee");
      check(after.hookFeesCharged === pool.hookFeesCharged + hookFee && after.volume === pool.volume + amountIn && after.swaps === pool.swaps + 1n, tag + "after the buy: hook fees charged (400), volume (408) and swap count (416) moved as documented");
      if (hookFee > 0n && treasuryAlive) {
        check(after.hookFeesOwed === 0n && !!treasuryAfter && u64(treasuryAfter.data, 64) === treasuryBefore + pool.hookFeesOwed + hookFee, tag + "the treasury is alive: it received the fee" + (pool.hookFeesOwed > 0n ? " and the " + pool.hookFeesOwed + " that waited" : "") + ", nothing is owed");
      } else if (hookFee > 0n) {
        check(after.hookFeesOwed === pool.hookFeesOwed + hookFee && (!treasuryAfter || treasuryAfter.lamports === 0 || treasuryAfter.data.length === 0), tag + "the treasury account is missing: the trade goes through, the fee waits at 464 (" + after.hookFeesOwed + " lamports now), outside reserve_quote");
      } else check(after.hookFeesOwed === pool.hookFeesOwed, tag + "no hook fee on this buy: fees owed (464) did not move");
    }
    if (ev) {
      check(ev.pool.equals(poolKey) && ev.user.equals(payer) && ev.direction === 0 && ev.amountIn === amountIn && ev.amountOut === sim.out && ev.byHook === 0, tag + "Swapped: pool, signer, direction, amount_in, amount_out at the documented offsets");
      if (after) check(ev.reserveBase === after.reserveBase && ev.reserveQuote === after.reserveQuote, tag + "Swapped: the reserves at 107 and 115 are the pool account's after the swap");
      if (answer.exact) check(ev.protocolFee === q.protocolFee && ev.hookFee === q.hookFee && ev.lpFee === q.lpFee && ev.feeBps === q.feeBps, tag + "Swapped: protocol fee 81, hook fee 89, pool fee 97 and fee bps 105 are the formula's");
      eq(eventsOf(sim, "Swapped").length, 1, tag + "one Swapped inner instruction, emitted by the pool program");
    } else if (attempt === 0 && !sim.hasInner) note(tag + "this RPC node returns no inner instructions for a simulation: the Swapped event is checked on past transactions only");
    eq(sim.depth, x.pegged || x.strict ? 3 : 2, tag + "call depth of the swap as a top-level instruction: " + (x.pegged || x.strict ? "pool, token program, hook" : "two levels"));
    check(sim.units < (x.template === "collectible" ? 450_000 : 250_000), tag + "the buy uses " + sim.units + " compute units, under the budget the document recommends");
    addCu(kind, "buy", sim.units);

    // ---- a sell, simulated after the buy in the same transaction ----
    let unitsOfSell = null;
    const base0 = ev ? ev.reserveBase : q.reserveBase, quote0 = ev ? ev.reserveQuote : q.reserveQuote;
    if (answer.exact || ev) {
      const sellIn = sim.out / 2n;
      const sellAnswer = hookAnswer(pool, platform, cfg, false, sim.slot);
      const sim2 = await simulate([...pre, buy, swapIx(poolKey, pool, payer, userBase, userQuote, 1, sellIn, 0n, extra)], payer, [poolKey]);
      // The sell trades on what the buy of this same simulation left. Inside a launch window
      // that buy may have landed a slot later than the first one, at a lower fee: take its
      // reserves from its own event when the node returns it.
      const buyAgain = sim2.hasInner ? eventsOf(sim2, "Swapped", HOOKPOOL).map((e) => decodeSwapped(e.body)).find((e) => e.direction === 0) : null;
      if (answer.window && !buyAgain && !sim2.err) { note(tag + "this RPC node returns no inner instructions for a simulation: the sell after a buy inside the window is not checked"); return { pool, cfg, extra, userBase, amountIn, pre, buy, out: sim.out, q, answer, treasuryAlive, readSlot: read.context.slot, units: sim.units, unitsOfSell }; }
      const sq = quote(buyAgain ? buyAgain.reserveBase : base0, buyAgain ? buyAgain.reserveQuote : quote0, pool.lpFeeBps, platform.protocolFeeBps, false, sellIn, sellAnswer.hookFeeBps, sellAnswer.feeOverrideBps, pool.virtualQuote);
      const again2 = decodePool((await conn.getAccountInfo(poolKey)).data);
      if (again2.swaps !== pool.swaps) continue;
      if (early && st) { check(errorOf(sim2) === String(RULES_ERR.EarlyLocked) && failedIn(sim2, HOOK.rules), tag + "the coins of a buy in the early window cannot be sold before the early unlock: " + RULES_ERR.EarlyLocked + " EarlyLocked from the rules hook, inside the token program"); return { pool, cfg, extra, userBase, amountIn, pre, buy, out: sim.out, q, answer, treasuryAlive, readSlot: read.context.slot, units: sim.units, unitsOfSell, early }; }
      if (sim2.err) check(false, tag + "a sell after the buy succeeds  (error " + errorOf(sim2) + ")");
      else if (!sellAnswer.exact) note(tag + "a hook this script cannot predict runs before sells: simulated output " + sim2.out + ", formula without the hook " + sq.out);
      else {
        eq(sim2.out, sq.out, tag + "a sell of " + sellIn + " units pays the formula amount on the reserves the buy left" + (sellAnswer.hookFeeBps ? ", after a hook fee of " + sellAnswer.hookFeeBps + " bps on the output" : ""));
        const a2 = sim2.accounts[0] ? decodePool(sim2.accounts[0].data) : null;
        if (a2) check(a2.reserveBase === sq.reserveBase && a2.reserveQuote === sq.reserveQuote && a2.protocolFeesBase === pool.protocolFeesBase + sq.protocolFee && a2.volume === pool.volume + amountIn + sq.gross, tag + "after the sell: reserve_base += net_in + lp_fee, reserve_quote -= gross, protocol fee owed in base, volume += gross");
        const sells = sim2.hasInner ? eventsOf(sim2, "Swapped", HOOKPOOL).map((e) => decodeSwapped(e.body)).filter((e) => e.direction === 1) : [];
        if (sells.length) check(sells[0].amountOut === sq.out && sells[0].hookFee === sq.hookFee && sells[0].amountOut + sells[0].hookFee === sq.gross, tag + "Swapped of the sell: amount_out plus the hook fee is the gross output, the quote volume of a sell");
        const sellUnits = (sim2.logs.filter((l) => l.startsWith("Program " + HOOKPOOL.toBase58() + " consumed")).pop() || "").match(/consumed (\d+)/);
        if (sellUnits) { unitsOfSell = Number(sellUnits[1]); addCu(kind, "sell", unitsOfSell); }
      }
    }
    return { pool, cfg, extra, userBase, amountIn, pre, buy, out: sim.out, q, answer, treasuryAlive, readSlot: read.context.slot, units: sim.units, unitsOfSell, early };
  }
  note(tag + "other trades kept landing on this pool between the read and the simulation: not checked");
}

const done = new Map();
for (const x of chosen) { const r = await simulatedTrades(x); if (r) done.set(x, r); }

// ---- section 6: quoting by simulation, the rules --------------------------------------------------------------
console.log("# rules of the swap and of quoting by simulation");
const plain = [...done.keys()].find((x) => x.template === "none" && x.pool.baseTokenProgram.equals(TOKEN) && x.pool.curveState === CURVE_NONE) || [...done.keys()].find((x) => x.template === "none");
if (plain) {
  const r = done.get(plain);
  const { poolKey } = plain;
  const tag = "no hook " + short(poolKey) + ": ";
  await guarded(poolKey, r.pool, tag, async () => {
  const swapWith = (over = {}, direction = 0, amount = r.amountIn, minOut = 0n, mod = (k) => k) => { const ix = swapIx(poolKey, r.pool, over.user ?? payer, over.userBase ?? r.userBase, over.userQuote ?? userQuote, direction, amount, minOut, [], over); mod(ix.keys); return ix; };
  let sim = await simulate([...r.pre, r.buy, closeAccount(userQuote, payer, payer)], payer);
  check(!sim.err && sim.out === null, tag + "an instruction after the swap clears the return data: the swap must be last");
  if (await conn.getAccountInfo(userQuote)) note(tag + "the fee payer already has a wrapped SOL account: the check of a missing input account is skipped");
  else {
    sim = await simulate([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), createAta(payer, payer, r.pool.baseMint, r.pool.baseTokenProgram), r.buy], payer);
    eq(errorOf(sim), "3012", tag + "without the wrap instructions the input account does not exist: Anchor 3012");
  }
  // payout to another wallet, a non-associated source is not needed here: a delegate signs
  const other = Keypair.generate().publicKey, delegate = Keypair.generate().publicKey;
  const otherBase = ataOf(other, r.pool.baseMint, r.pool.baseTokenProgram);
  sim = await simulate([...r.pre, createAta(payer, other, r.pool.baseMint, r.pool.baseTokenProgram), swapWith({ userBase: otherBase })], payer, [otherBase]);
  check(!sim.err && sim.out === r.out && sim.accounts[0] && u64(sim.accounts[0].data, 64) === r.out, tag + "a buy can pay out to a token account of another wallet");
  sim = await simulate([...r.pre, approve(userQuote, delegate, payer, r.amountIn), swapWith({ user: delegate })], payer);
  check(!sim.err && sim.out === r.out, tag + "a delegate of the input account can sign the swap");
  sim = await simulate([...r.pre, swapWith({ user: delegate })], payer);
  check(errorOf(sim) === "4" && failedIn(sim, TOKEN), tag + "a signer that is neither owner nor delegate: custom 4 from the token program");
  // errors of section 7
  const expect = async (ixs, want, text) => { const s = await simulate(ixs, payer); eq(errorOf(s), String(want), tag + text + ": " + want); return s; };
  await expect([...r.pre, swapWith({}, 0, 0n)], ERR.ZeroAmount, "amount_in zero");
  await expect([...r.pre, swapWith({}, 0, 1n)], ERR.ZeroAmount, "an amount the fees take whole");
  await expect([...r.pre, swapWith({}, 2)], ERR.BadDirection, "direction byte 2");
  await expect([...r.pre, swapWith({}, 0, r.amountIn, r.out + 1n)], ERR.Slippage, "a minimum one unit above the output");
  sim = await simulate([...r.pre, swapWith({}, 0, r.amountIn, r.out)], payer);
  check(!sim.err, tag + "a minimum equal to the output passes");
  {
    const v = r.pool.virtualQuote;
    const tiny = quote(r.q.reserveBase, r.q.reserveQuote, r.pool.lpFeeBps, platform.protocolFeeBps, false, 1n, 0, null, v);
    let n = 1n; // the smallest sell whose net input is above zero while its output still rounds to zero
    while (n < 10n ** 12n && quote(r.q.reserveBase, r.q.reserveQuote, r.pool.lpFeeBps, platform.protocolFeeBps, false, n, 0, null, v).netIn <= 0n) n *= 2n;
    const g = quote(r.q.reserveBase, r.q.reserveQuote, r.pool.lpFeeBps, platform.protocolFeeBps, false, n, 0, null, v);
    if (tiny.netIn <= 0n) await expect([...r.pre, r.buy, swapWith({}, 1, 1n)], ERR.ZeroAmount, "a sell of 1 unit, which the fees take whole");
    if (g.gross === 0n) await expect([...r.pre, r.buy, swapWith({}, 1, n)], ERR.ZeroAmount, "a sell of " + n + " units, whose output rounds to zero, on a pool without a hook: a dust trade, ZeroAmount, not the hook's 6035");
    else note(tag + "this pool is too small for a sell whose output rounds to zero: the dust trade is not checked");
  }
  await expect([...r.pre, swapWith({ userBase: r.pool.baseVault })], 2040, "a buy paid into the pool's own base vault");
  await expect([...r.pre, r.buy, swapWith({ userQuote: r.pool.quoteVault }, 1, r.out)], 2040, "a sell paid into the pool's own quote vault");
  const strange = pools.find((y) => !y.poolKey.equals(poolKey) && y.pool.baseTokenProgram.equals(TOKEN));
  if (strange) {
    await expect([...r.pre, createAta(payer, payer, strange.pool.baseMint), swapWith({ userBase: ataOf(payer, strange.pool.baseMint) })], 2014, "a base token account of another mint");
    await expect([...r.pre, swapWith({}, 0, r.amountIn, 0n, (k) => { k[5] = rw(strange.pool.baseVault); })], 2001, "account 5 is another pool's vault");
  }
  await expect([...r.pre, swapWith({ userBase: otherBase })], 3012, "a token account that does not exist");
  sim = await simulate([...r.pre, r.buy, swapWith({}, 1, r.out + 1n)], payer);
  check(errorOf(sim) === "1" && failedIn(sim, r.pool.baseTokenProgram), tag + "a sell of more than the wallet holds: custom 1 from the token program");
  await expect([...r.pre, swapWith({ baseTokenProgram: r.pool.baseTokenProgram.equals(TOKEN) ? TOKEN_2022 : TOKEN })], ERR.TokenProgramMismatch, "the other token program at account 13");
  await expect([...r.pre, swapWith({}, 0, r.amountIn, 0n, (k) => { k[12] = ro(PLATFORM); })], 2006, "account 12 is not the hook caller");
  await expect([...r.pre, swapWith({ caller: callerOf(HOOK.tax) })], 2006, "account 12 is the hook caller of another hook program (the tax hook's, on a pool without a hook)");
  await expect([...r.pre, swapWith({ caller: OLD_CALLER })], 2006, "account 12 is [\"caller\"] alone, derived without a hook program");
  sim = await simulate([...r.pre, swapWith({ caller: callerOf(SYSTEM) })], payer);
  check(!sim.err && sim.out === r.out, tag + "account 12 of a pool without a hook is [\"caller\", 32 zero bytes]");
  await expect([...r.pre, swapWith({}, 0, r.amountIn, 0n, (k) => { k[1] = ro(callerOf(SYSTEM)); })], 3012, "account 1 is not the platform");
  await expect([...r.pre, swapWith({}, 0, r.amountIn, 0n, (k) => { k[2] = ro(poolKey); })], 2000, "the pool passed read-only");
  });
} else note("no pool without a hook was simulated: the rules of the swap and its errors are not checked");

// errors that need a hook
for (const [x, r] of done) {
  if (x.template === "none" || x.template === "custom") continue;
  const tag = kindOf(x) + " " + short(x.poolKey) + ": ";
  await guarded(x.poolKey, r.pool, tag, async () => {
  const mk = (extra, over = {}, direction = 0) => swapIx(x.poolKey, r.pool, payer, r.userBase, userQuote, direction, direction === 0 ? r.amountIn : r.out / 2n, 0n, extra, over);
  let sim = await simulate([...r.pre, mk([...r.extra].reverse())], payer);
  if (sim.err) check(false, tag + "the hook's accounts in reverse order are accepted  (error " + errorOf(sim) + ")");
  else if (r.answer.exact && !r.answer.window) eq(sim.out, r.out, tag + "the hook's accounts in reverse order give the same swap");
  else check(true, tag + "the hook's accounts in reverse order are accepted");
  sim = await simulate([...r.pre, mk([...r.extra, ro(PLATFORM)])], payer);
  check(!sim.err, tag + "an account the hook does not need is ignored");
  sim = await simulate([...r.pre, mk(x.pegged ? r.extra.slice(3) : [])], payer);
  eq(errorOf(sim), String(ERR.HookExtraAccounts), tag + "a buy without the hook's accounts: " + ERR.HookExtraAccounts);
  if (!x.pegged) {
    const other = x.template === "tax" ? HOOK.buyback : HOOK.tax;
    sim = await simulate([...r.pre, mk(r.extra, { hookProgram: other })], payer);
    eq(errorOf(sim), "2006", tag + "another program at account 10, with this pool's hook caller at account 12: 2006, the caller is derived from account 10");
    sim = await simulate([...r.pre, mk(r.extra, { hookProgram: other, caller: callerOf(other) })], payer);
    eq(errorOf(sim), String(ERR.HookProgramMismatch), tag + "another program at account 10, with that program's own hook caller at account 12: " + ERR.HookProgramMismatch);
    sim = await simulate([...r.pre, mk(r.extra, { caller: callerOf(SYSTEM) })], payer);
    eq(errorOf(sim), "2006", tag + "the hook caller of a pool without a hook at account 12: 2006");
    sim = await simulate([...r.pre, mk(r.extra, { caller: OLD_CALLER })], payer);
    eq(errorOf(sim), "2006", tag + "[\"caller\"] alone, derived without a hook program, at account 12: 2006");
    sim = await simulate([...r.pre, mk(r.extra, { extraMetas: pdaOf(["extra-metas"], x.template === "tax" ? HOOK.buyback : HOOK.tax) })], payer);
    eq(errorOf(sim), String(ERR.HookExtraMetasAddress), tag + "another hook's list at account 11: " + ERR.HookExtraMetasAddress);
  }
  if (!r.pool.hookTreasury.equals(PublicKey.default)) {
    sim = await simulate([...r.pre, mk(r.extra, { treasury: userQuote })], payer);
    eq(errorOf(sim), String(ERR.HookTreasuryMismatch), tag + "another account in place of the treasury" + (r.treasuryAlive ? "" : " (which does not exist)") + ": " + ERR.HookTreasuryMismatch);
  }
  if (r.extra.some((m) => m.isWritable) && called(r.pool, FLAG.BEFORE_SWAP | FLAG.AFTER_SWAP, true) && !r.early) {
    sim = await simulate([...r.pre, mk(r.extra.map((m) => (m.pubkey.equals(x.cfgKey) ? ro(m.pubkey) : m)))], payer);
    eq(errorOf(sim), "PrivilegeEscalation", tag + "the config passed read-only where the list says writable: PrivilegeEscalation");
  }
  if (!called(r.pool, FLAG.BEFORE_SWAP | FLAG.AFTER_SWAP, false) && !x.pegged) {
    sim = await simulate([...r.pre, r.buy, mk([], {}, 1)], payer);
    check(!sim.err, tag + "the pool does not call this hook on sells: a sell passes without the hook's accounts");
  }
  if (x.strict) {
    sim = await simulate([...r.pre, mk(r.extra.slice(0, 1))], payer);
    check(errorOf(sim) === "3005" && failedIn(sim, TOKEN_2022), tag + "a strict coin's buy with the config but without the coin's three accounts: 3005 AccountNotEnoughKeys from the token program");
    const other = Keypair.generate().publicKey;
    const otherBase = ataOf(other, r.pool.baseMint, r.pool.baseTokenProgram);
    const to = [...r.pre, createAta(payer, other, r.pool.baseMint, r.pool.baseTokenProgram)];
    sim = await simulate([...to, swapIx(x.poolKey, r.pool, payer, otherBase, userQuote, 0, r.amountIn, 0n, r.extra)], payer);
    eq(errorOf(sim), String(ERR.HookExtraAccounts), tag + "a buy paid to another wallet with the signer's holder record and not the receiver's: " + ERR.HookExtraAccounts + " HookExtraAccounts of the pool program, which resolves the coin's accounts itself");
    sim = await simulate([...to, ...(r.early ? [SystemProgram.transfer({ fromPubkey: payer, toPubkey: other, lamports: 10_000_000 }), openHolderIx(other, x.poolKey, r.pool)] : []), swapIx(x.poolKey, r.pool, payer, otherBase, userQuote, 0, r.amountIn, 0n, [...r.extra.slice(0, 1), rw(holderOf(x.poolKey, other)), ...r.extra.slice(2)])], payer);
    check(!sim.err && sim.out === r.out, tag + "a buy paid to another wallet passes with that wallet's holder record address in place of the signer's" + (r.early ? " (opened first: the early window runs)" : "") + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
  }
  if (x.pegged) {
    sim = await simulate([...r.pre, mk(r.extra.slice(0, 3))], payer);
    check(errorOf(sim) === "3005" && failedIn(sim, HOOK.collectible), tag + "without the three accounts of a pegged coin: 3005 from the collectible program");
    const other = Keypair.generate().publicKey;
    const otherBase = ataOf(other, r.pool.baseMint, r.pool.baseTokenProgram);
    const to = [...r.pre, createAta(payer, other, r.pool.baseMint, r.pool.baseTokenProgram)];
    sim = await simulate([...to, swapIx(x.poolKey, r.pool, payer, otherBase, userQuote, 0, r.amountIn, 0n, r.extra)], payer);
    eq(errorOf(sim), String(ERR.HookExtraAccounts), tag + "a buy paid to another wallet without that wallet's ticket address: " + ERR.HookExtraAccounts);
    sim = await simulate([...to, swapIx(x.poolKey, r.pool, payer, otherBase, userQuote, 0, r.amountIn, 0n, [rw(ticketOf(x.poolKey, other)), ...r.extra])], payer);
    check(!sim.err && sim.out === r.out, tag + "with that wallet's ticket address, anywhere after the seventeen, the buy pays out to it");
  }
  });
}

// ---- sections 6 and 13: the buy limit, staking, the claims and the creator lock of a rules pool ---------------
console.log("# the rules template");
const chainClock = async () => { const info = await conn.getAccountInfo(CLOCK_SYSVAR); return { slot: u64(info.data, 0), time: info.data.readBigInt64LE(32) }; };
const logEvent = (sim, name) => sim.logged.find((e) => same(e.disc, DISC["event:" + name]));
const notInner = (sim, name) => !sim.hasInner || !sim.inner.some((e) => same(e.disc, DISC["event:" + name]));
const MAX_U64 = (1n << 64n) - 1n;
const LAMPORTS_PER_SOL_N = BigInt(LAMPORTS_PER_SOL);
const heldAt = async (account) => { const info = await conn.getAccountInfo(account); return info && info.data.length >= 72 ? u64(info.data, 64) : 0n; };
const wsolBefore = await heldAt(userQuote);
for (const [x, r] of done) {
  if (x.template !== "rules" || x.strict) continue;
  const { poolKey } = x;
  const tag = kindOf(x) + " " + short(poolKey) + ": ";
  const read = await conn.getMultipleAccountsInfoAndContext([poolKey, x.cfgKey, stakeOf(poolKey, payer), lockOf(poolKey), lockVaultOf(poolKey)], "confirmed");
  if (!read.value[0] || !read.value[1]) continue;
  const pool = decodePool(read.value[0].data), cfg = read.value[1].data, rules = decodeRules(cfg);
  const slot = BigInt(read.context.slot);
  await guarded(poolKey, pool, tag, async () => {
  const userBase = r.userBase;
  const coinsBefore = await heldAt(userBase);
  const buyIx = (amount) => swapIx(poolKey, pool, payer, userBase, userQuote, 0, amount, 0n, r.extra);
  const head = (lamports) => [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), createAta(payer, payer, pool.baseMint, pool.baseTokenProgram), ...wrap(payer, lamports)];
  let sim;

  // ---- the buy limit (section 6) ----
  if (rules.maxBuyQuote > 0n) {
    const until = rules.startSlot + rules.limitSlots;
    const over = rules.maxBuyQuote + 1n;
    if (over + 100_000_000n > BigInt(await conn.getBalance(payer))) note(tag + "its buy limit of " + rules.maxBuyQuote + " lamports is more than the fee payer holds: the limit is not simulated");
    else if (slot + 3n < until) {
      sim = await simulate([...head(over), buyIx(over)], payer);
      check(errorOf(sim) === String(RULES_ERR.BuyTooLarge) && failedIn(sim, HOOK.rules), tag + "inside the limit window (it ends at slot " + until + ") a buy of one lamport more than the limit of " + rules.maxBuyQuote + ": " + RULES_ERR.BuyTooLarge + " from the rules hook");
      sim = await simulate([...head(rules.maxBuyQuote), buyIx(rules.maxBuyQuote)], payer);
      check(!sim.err, tag + "a buy of exactly the limit passes");
      // sells are never limited: buy at the limit twice, sell it all in one trade
      sim = await simulate([...head(2n * rules.maxBuyQuote), buyIx(rules.maxBuyQuote), buyIx(rules.maxBuyQuote)], payer, [userBase]);
      if (!sim.err && sim.accounts[0]) {
        const coins = u64(sim.accounts[0].data, 64);
        sim = await simulate([...head(2n * rules.maxBuyQuote), buyIx(rules.maxBuyQuote), buyIx(rules.maxBuyQuote), swapIx(poolKey, pool, payer, userBase, userQuote, 1, coins, 0n, r.extra)], payer);
        check(!sim.err, tag + "the limit is per buy and never touches a sell: two buys at the limit pass, and one sell of everything they bought");
      }
    } else if (slot >= until) {
      sim = await simulate([...head(over), buyIx(over)], payer);
      check(!sim.err, tag + "its limit window is over (since slot " + until + "): a buy above the limit of " + rules.maxBuyQuote + " lamports passes");
    }
  }

  // ---- stake, unstake, claim_rewards (section 13) ----
  if (read.value[2]) note(tag + "the fee payer already has a stake record here: the staking checks are skipped");
  else {
    // The stake has to be named before the buy lands: quote the buy at the slot of the read.
    // Inside the sniper window a later slot gives the same or more, so this much is there.
    const a0 = hookAnswer(pool, platform, cfg, true, read.context.slot);
    const stakeAmount = quote(pool.reserveBase, pool.reserveQuote, pool.lpFeeBps, platform.protocolFeeBps, true, r.amountIn, a0.hookFeeBps, a0.feeOverrideBps, pool.virtualQuote).out;
    const record = stakeOf(poolKey, payer), vault = stakeVaultOf(poolKey);
    const steps = [...head(2n * r.amountIn), buyIx(r.amountIn), stakeIx(payer, poolKey, pool, stakeAmount, userBase), buyIx(r.amountIn)];
    const before = await conn.getAccountInfo(vault);
    sim = await simulate(steps, payer, [record, x.cfgKey, vault]);
    const swaps = sim.hasInner ? eventsOf(sim, "Swapped", HOOKPOOL).map((e) => decodeSwapped(e.body)) : [];
    if (sim.tooLarge) note(tag + "two buys and a stake do not fit one transaction without a lookup table: staking is not checked on this pool");
    else if (sim.err) check(false, tag + "a buy, a stake of what it bought and another buy succeed  (error " + errorOf(sim) + ": " + sim.logs.slice(-2).join(" / ").slice(0, 160) + ")");
    else if (swaps.length !== 2) note(tag + "this RPC node returns no inner instructions for a simulation: the staking amounts are not checked");
    else {
      const rec = sim.accounts[0].data, c = decodeRules(sim.accounts[1].data);
      // the config, step by step: the first buy settles the trade before it; the stake settles
      // the first buy, with what was staked BEFORE it; the second buy finds nothing new
      const fee1 = swaps[0].hookFee, fee2 = swaps[1].hookFee;
      const s1 = { ...settleRules(rules, pool), lastSplit: rules.buy };
      const s2 = settleRules(s1, { hookFeesCharged: pool.hookFeesCharged + fee1, hookFeesOwed: 0n });
      const staked = { ...s2, totalStaked: s2.totalStaked + stakeAmount };
      eq(rec.length, LAYOUT.stake_record.size, tag + "stake (wallet, config, pool, record, coin, stake vault, the wallet's coin account, token program, system program) opens a stake record of 113 bytes");
      check(starts(rec, DISC["account:StakeRecord"]) && rec[8] === bumpOf(["stake", poolKey, payer], HOOK.rules) && key(rec, 9).equals(poolKey) && key(rec, 41).equals(payer) && u64(rec, 73) === stakeAmount && u128(rec, 81) === s2.accPerShare && u64(rec, 97) === 0n && u64(rec, 105) === swaps[0].slot,
        tag + "the new stake record: discriminator, bump 8, pool 9, wallet 41, amount 73, the config's rewards per unit at 81, nothing owed at 97, the slot of the stake at 105");
      check(c.totalStaked === staked.totalStaked && c.creatorOwed === staked.creatorOwed && c.burnPot === staked.burnPot && c.accPerShare === staked.accPerShare && c.rewardRem === staked.rewardRem && c.feesSeen === staked.feesSeen,
        tag + "the config after the stake: the total at 294 grew by the stake, and the first buy's hook fee of " + fee1 + " was settled with what was staked before it (" + (rules.totalStaked >= rules.minEligible && rules.totalStaked > 0n ? "enough for the stakers to earn" : "under the minimum at 232, so the holders' share went to the burn pot") + ")");
      eq(u64(sim.accounts[2].data, 64), u64(before.data, 64) + stakeAmount, tag + "the stake vault received the coins");
      const ev = logEvent(sim, "Staked");
      check(!!ev && ev.body.length === LAYOUT.staked.size && key(ev.body, 0).equals(poolKey) && key(ev.body, 32).equals(payer) && u64(ev.body, 64) === stakeAmount && u64(ev.body, 72) === stakeAmount && u64(ev.body, 80) === staked.totalStaked && u64(ev.body, 88) === swaps[0].slot && notInner(sim, "Staked"),
        tag + "Staked is in the log, not an inner instruction: pool, wallet, amount, the record's amount, the config's total, slot; 96 bytes");
      const stakeUnits = unitsOf(sim, HOOK.rules);
      if (stakeUnits) addCu("rules: stake, the first of a wallet", "", stakeUnits);
      // unstake: refused for 9,000 slots after the stake
      sim = await simulate([...steps, unstakeIx(payer, poolKey, pool, 1n, userBase)], payer);
      check(errorOf(sim) === String(RULES_ERR.UnstakeTooEarly) && failedIn(sim, HOOK.rules), tag + "unstake right after the stake: " + RULES_ERR.UnstakeTooEarly + " from the rules hook");
      sim = await simulate([...head(r.amountIn), buyIx(r.amountIn), stakeIx(payer, poolKey, pool, 0n, userBase)], payer);
      check(errorOf(sim) === String(RULES_ERR.ZeroAmount) && failedIn(sim, HOOK.rules), tag + "a stake of nothing: " + RULES_ERR.ZeroAmount + " from the rules hook");
      // claim_rewards: settles the second buy, whose holders' share goes to the stakers when enough is staked
      const s3 = settleRules({ ...staked, lastSplit: rules.buy }, { hookFeesCharged: pool.hookFeesCharged + fee1 + fee2, hookFeesOwed: 0n });
      const earned = (stakeAmount * (s3.accPerShare - s2.accPerShare)) / ACC_SCALE;
      sim = await simulate([...steps, claimRewardsIx(payer, poolKey, pool, userQuote)], payer, [userQuote, record, x.cfgKey]);
      if (sim.tooLarge) note(tag + "two buys, a stake and a claim do not fit one transaction without a lookup table: claim_rewards is not checked on this pool");
      else if (earned === 0n) check(errorOf(sim) === String(RULES_ERR.NothingToClaim) && failedIn(sim, HOOK.rules), tag + "claim_rewards with nothing earned (" + (rules.buy.holders === 0 ? "buys pay no holders' share on this coin" : "the stake is under the minimum at 232, or too small to earn a lamport") + "): " + RULES_ERR.NothingToClaim);
      else {
        const paid = logEvent(sim, "RewardsClaimed");
        const c3 = !sim.err && sim.accounts[2] ? decodeRules(sim.accounts[2].data) : null;
        check(!sim.err && u64(sim.accounts[0].data, 64) === wsolBefore + earned && !!c3 && c3.totalRewardsPaid === rules.totalRewardsPaid + earned && c3.rewardsOwedTotal === s3.rewardsOwedTotal && u64(sim.accounts[1].data, 97) === 0n && u128(sim.accounts[1].data, 81) === s3.accPerShare,
          tag + "claim_rewards after a second buy pays stake * (rewards per unit now - at the stake) / 10^12 = " + earned + " lamports of wrapped SOL to the account the staker names, out of a holders' share of " + (fee2 * BigInt(rules.buy.holders)) / BigInt(ratesSum(rules.buy)) + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
        check(!!paid && paid.body.length === 72 && key(paid.body, 0).equals(poolKey) && key(paid.body, 32).equals(payer) && u64(paid.body, 64) === earned && notInner(sim, "RewardsClaimed"), tag + "RewardsClaimed is in the log: pool, staker, amount; 72 bytes");
        const u = unitsOf(sim, HOOK.rules);
        if (u) addCu("rules: claim_rewards", "", u);
      }
    }
  }

  // ---- claim_creator: anyone can read what it pays; only the creator can send it ----
  {
    const s = settleRules(rules, pool);
    const claim = (who) => [createAta(payer, payer, WSOL), claimCreatorIx(who, poolKey, pool, userQuote)];
    sim = await simulate(claim(rules.creator), payer, [userQuote, x.cfgKey]);
    if (s.creatorOwed === 0n) check(errorOf(sim) === String(RULES_ERR.NothingToClaim) && failedIn(sim, HOOK.rules), tag + "claim_creator with nothing owed: " + RULES_ERR.NothingToClaim);
    else {
      const ev = logEvent(sim, "CreatorClaimed");
      const c = !sim.err && sim.accounts[1] ? decodeRules(sim.accounts[1].data) : null;
      check(!sim.err && u64(sim.accounts[0].data, 64) === wsolBefore + s.creatorOwed && !!c && c.creatorOwed === 0n && c.totalCreatorPaid === rules.totalCreatorPaid + s.creatorOwed,
        tag + "claim_creator, signed by the creator at 138, pays what the config owes after settling (254: " + rules.creatorOwed + ", settled: " + s.creatorOwed + " lamports) to the account the creator names" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
      check(!!ev && ev.body.length === 72 && key(ev.body, 0).equals(poolKey) && key(ev.body, 32).equals(rules.creator) && u64(ev.body, 64) === s.creatorOwed && notInner(sim, "CreatorClaimed"), tag + "CreatorClaimed is in the log: pool, creator, amount; 72 bytes");
      const u = unitsOf(sim, HOOK.rules);
      if (u) addCu("rules: claim_creator", "", u);
    }
    sim = await simulate(claim(payer), payer);
    check(errorOf(sim) === String(RULES_ERR.NotCreator) && failedIn(sim, HOOK.rules), tag + "claim_creator signed by another wallet: " + RULES_ERR.NotCreator);
  }

  // ---- the creator lock ----
  {
    const clock = await chainClock();
    const lock = read.value[3] ? { amount: u64(read.value[3].data, 41), unlockAt: read.value[3].data.readBigInt64LE(49) } : { amount: 0n, unlockAt: 0n };
    const inVault = read.value[4] && read.value[4].data.length >= 72 ? u64(read.value[4].data, 64) : 0n;
    const declared = rules.startTime + BigInt.asIntN(64, rules.creatorLockSeconds);
    const a0 = hookAnswer(pool, platform, cfg, true, read.context.slot);
    const amount = quote(pool.reserveBase, pool.reserveQuote, pool.lpFeeBps, platform.protocolFeeBps, true, r.amountIn, a0.hookFeeBps, a0.feeOverrideBps, pool.virtualQuote).out;
    // The creator's signature is not made here, and the coins are the fee payer's: it buys
    // them and names the creator as delegate of its coin account, so that the creator can lock them.
    const steps = (unlockAt, who = rules.creator) => [...head(r.amountIn), buyIx(r.amountIn), approve(userBase, who, payer, amount), SystemProgram.transfer({ fromPubkey: payer, toPubkey: who, lamports: 10_000_000 }), lockCreatorIx(who, poolKey, pool, amount, unlockAt, userBase)];
    const laterOf = (...v) => v.reduce((m, y) => (y > m ? y : m));
    const unlockAt = laterOf(clock.time + 3600n, declared, lock.unlockAt);
    if (unlockAt > clock.time + MAX_LOCK_SECONDS - 60n) note(tag + "its lock already ends at the 365-day ceiling: a further lock is not simulated");
    else {
      sim = await simulate(steps(unlockAt), payer, [lockOf(poolKey), lockVaultOf(poolKey)]);
      if (sim.tooLarge) note(tag + "a buy and a lock do not fit one transaction without a lookup table: lock_creator is not checked on this pool");
      else {
        const ev = logEvent(sim, "CreatorLocked");
        const l = !sim.err && sim.accounts[0] ? sim.accounts[0].data : null;
        check(!!l && l.length === LAYOUT.lock_record.size && starts(l, DISC["account:LockRecord"]) && key(l, 9).equals(poolKey) && u64(l, 41) === lock.amount + amount && l.readBigInt64LE(49) === unlockAt && u64(sim.accounts[1].data, 64) === inVault + amount,
          tag + "lock_creator, signed by the creator, moves the coins into the lock vault and writes the lock record (57 bytes): amount 41 = " + (lock.amount + amount) + ", unlock time 49" + (sim.err ? "  (error " + errorOf(sim) + ": " + sim.logs.slice(-2).join(" / ").slice(0, 160) + ")" : ""));
        check(!!ev && ev.body.length === LAYOUT.creator_locked.size && key(ev.body, 0).equals(poolKey) && key(ev.body, 32).equals(rules.creator) && u64(ev.body, 64) === amount && u64(ev.body, 72) === lock.amount + amount && ev.body.readBigInt64LE(80) === unlockAt && notInner(sim, "CreatorLocked"),
          tag + "CreatorLocked is in the log: pool, creator, the amount added, the amount locked now, the unlock time; 88 bytes");
        const u = unitsOf(sim, HOOK.rules);
        if (u) addCu("rules: lock_creator" + (read.value[3] ? ", a later call" : ", the first call"), "", u);
        // the same lock, and right after it an unlock: refused until the time at 49
        sim = await simulate([...steps(unlockAt), createAta(payer, rules.creator, pool.baseMint, pool.baseTokenProgram), unlockCreatorIx(rules.creator, poolKey, pool, ataOf(rules.creator, pool.baseMint, pool.baseTokenProgram))], payer);
        if (!sim.tooLarge) check(errorOf(sim) === String(RULES_ERR.StillLocked) && failedIn(sim, HOOK.rules), tag + "unlock_creator before the unlock time: " + RULES_ERR.StillLocked);
      }
      sim = await simulate(steps(clock.time + MAX_LOCK_SECONDS + 3600n), payer);
      if (!sim.tooLarge) check(errorOf(sim) === String(RULES_ERR.UnlockTooFar) && failedIn(sim, HOOK.rules), tag + "a lock that would end more than 365 days from now: " + RULES_ERR.UnlockTooFar);
      // an unlock time that is too early: which refusal comes first depends on the lock and the declaration
      const earliest = laterOf(declared, lock.unlockAt);
      const expected = earliest - 1n < lock.unlockAt ? "UnlockEarlier" : "UnlockBeforeDeclared";
      sim = await simulate(steps(earliest - 1n), payer);
      if (!sim.tooLarge) check(errorOf(sim) === String(RULES_ERR[expected]) && failedIn(sim, HOOK.rules), tag + "an unlock time one second before " + (expected === "UnlockEarlier" ? "the lock's present one" : "the launch plus the lock declared at 208 (" + rules.creatorLockSeconds + " seconds)") + ": " + RULES_ERR[expected] + " " + expected);
      if (earliest + 30n < clock.time) {
        sim = await simulate(steps(earliest), payer);
        if (!sim.tooLarge) check(errorOf(sim) === String(RULES_ERR.UnlockInPast) && failedIn(sim, HOOK.rules), tag + "the earliest unlock time the config and the lock allow, which is in the past: " + RULES_ERR.UnlockInPast);
      }
      sim = await simulate(steps(unlockAt, payer), payer);
      if (!sim.tooLarge) check(errorOf(sim) === String(RULES_ERR.NotCreator) && failedIn(sim, HOOK.rules), tag + "lock_creator signed by another wallet: " + RULES_ERR.NotCreator);
    }
    // unlock_creator on the lock as it stands on the chain
    const to = ataOf(payer, pool.baseMint, pool.baseTokenProgram);
    const unlock = [createAta(payer, payer, pool.baseMint, pool.baseTokenProgram), unlockCreatorIx(rules.creator, poolKey, pool, to)];
    if (!read.value[3]) {
      sim = await simulate(unlock, payer);
      eq(errorOf(sim), "3012", tag + "unlock_creator on a coin whose creator never locked anything: Anchor 3012, the lock record does not exist");
    } else if (inVault === 0n) {
      sim = await simulate(unlock, payer);
      check(errorOf(sim) === String(RULES_ERR.NothingLocked) && failedIn(sim, HOOK.rules), tag + "unlock_creator with an empty lock vault: " + RULES_ERR.NothingLocked);
    } else if (clock.time + 30n < lock.unlockAt) {
      sim = await simulate(unlock, payer);
      check(errorOf(sim) === String(RULES_ERR.StillLocked) && failedIn(sim, HOOK.rules), tag + "unlock_creator on the lock of this coin, " + inVault + " units until " + lock.unlockAt + ": " + RULES_ERR.StillLocked);
    } else if (clock.time > lock.unlockAt + 30n) {
      sim = await simulate(unlock, payer, [to, lockOf(poolKey)]);
      const ev = logEvent(sim, "CreatorUnlocked");
      check(!sim.err && u64(sim.accounts[0].data, 64) === coinsBefore + inVault && u64(sim.accounts[1].data, 41) === 0n && sim.accounts[1].data.readBigInt64LE(49) === 0n, tag + "unlock_creator after the unlock time pays everything in the lock vault (" + inVault + " units) to the coin account the creator names and sets the record to zero" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
      check(!!ev && ev.body.length === 72 && key(ev.body, 0).equals(poolKey) && key(ev.body, 32).equals(rules.creator) && u64(ev.body, 64) === inVault && notInner(sim, "CreatorUnlocked"), tag + "CreatorUnlocked is in the log: pool, creator, amount; 72 bytes");
      const u = unitsOf(sim, HOOK.rules);
      if (u) addCu("rules: unlock_creator", "", u);
    }
  }
  });
}
// a creator lock that is over, on any rules pool of the chain: unlock it as its creator (no signature is made)
{
  const clock = await chainClock();
  const over = pools.filter((x) => x.template === "rules" && x.lock && x.lock.inVault > 0n && clock.time > x.lock.unlockAt + 30n && x.cfg && x.cfg.length === LAYOUT.rules_config.size);
  if (!over.length) note("no rules pool on this cluster has a creator lock that is over: a real unlock is not simulated");
  for (const x of over.slice(0, perKind)) {
    const tag = "rules " + short(x.poolKey) + ": ";
    const got = await conn.getMultipleAccountsInfo([lockOf(x.poolKey), lockVaultOf(x.poolKey)]);
    if (!got[0] || !got[1]) continue;
    const inVault = u64(got[1].data, 64), unlockAt = got[0].data.readBigInt64LE(49), creator = key(x.cfg, 138);
    if (inVault === 0n || clock.time <= unlockAt + 30n) continue;
    const to = ataOf(payer, x.pool.baseMint, x.pool.baseTokenProgram);
    const before = await heldAt(to);
    const sim = await simulate([createAta(payer, payer, x.pool.baseMint, x.pool.baseTokenProgram), unlockCreatorIx(creator, x.poolKey, x.pool, to)], payer, [to, lockOf(x.poolKey), lockVaultOf(x.poolKey)]);
    const ev = logEvent(sim, "CreatorUnlocked");
    check(!sim.err && u64(sim.accounts[0].data, 64) === before + inVault && u64(sim.accounts[1].data, 41) === 0n && sim.accounts[1].data.readBigInt64LE(49) === 0n && u64(sim.accounts[2].data, 64) === 0n,
      tag + "its creator lock ended at " + unlockAt + ": unlock_creator, signed by the creator, pays everything in the lock vault (" + inVault + " units) to the coin account the creator names and sets the record to zero" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
    check(!!ev && ev.body.length === 72 && key(ev.body, 0).equals(x.poolKey) && key(ev.body, 32).equals(creator) && u64(ev.body, 64) === inVault && notInner(sim, "CreatorUnlocked"), tag + "CreatorUnlocked is in the log: pool, creator, amount; 72 bytes");
    const u = unitsOf(sim, HOOK.rules);
    if (u && !sim.err) addCu("rules: unlock_creator", "", u);
    const other = await simulate([createAta(payer, payer, x.pool.baseMint, x.pool.baseTokenProgram), unlockCreatorIx(payer, x.poolKey, x.pool, to)], payer);
    check(errorOf(other) === String(RULES_ERR.NotCreator) && failedIn(other, HOOK.rules), tag + "unlock_creator signed by another wallet: " + RULES_ERR.NotCreator);
  }
}
// a stake that is old enough: unstake it, and claim what it earned, as its own wallet (no signature is made)
{
  const records = await conn.getProgramAccounts(HOOK.rules, { filters: [{ memcmp: { offset: 0, bytes: b58encode(DISC["account:StakeRecord"]) } }] });
  const clock = await chainClock();
  const open = records.filter((t) => t.account.data.length === LAYOUT.stake_record.size && u64(t.account.data, 73) > 0n && clock.slot >= u64(t.account.data, 105) + UNSTAKE_DELAY_SLOTS + 3n);
  const locked = records.filter((t) => t.account.data.length === LAYOUT.stake_record.size && u64(t.account.data, 73) > 0n && clock.slot + 3n < u64(t.account.data, 105) + UNSTAKE_DELAY_SLOTS);
  for (const t of locked.slice(0, perKind)) {
    const poolKey = key(t.account.data, 9), staker = key(t.account.data, 41);
    const tag = "stake record " + short(t.pubkey) + " on pool " + short(poolKey) + ": ";
    const read = await conn.getMultipleAccountsInfo([poolKey, rulesCfgOf(poolKey), t.pubkey]);
    if (read.some((v) => !v)) continue;
    const pool = decodePool(read[0].data), rules = decodeRules(read[1].data), rec = read[2].data;
    await guarded(poolKey, pool, tag, async () => {
    const to = ataOf(payer, pool.baseMint, pool.baseTokenProgram);
    let sim = await simulate([createAta(payer, payer, pool.baseMint, pool.baseTokenProgram), unstakeIx(staker, poolKey, pool, 1n, to)], payer);
    check(errorOf(sim) === String(RULES_ERR.UnstakeTooEarly) && failedIn(sim, HOOK.rules), tag + "staked in slot " + u64(rec, 105) + ": unstake before slot " + (u64(rec, 105) + UNSTAKE_DELAY_SLOTS) + " is refused with " + RULES_ERR.UnstakeTooEarly);
    // what it earned can be claimed at any time
    const s = settleRules(rules, pool);
    const owed = u64(rec, 97) + (u64(rec, 73) * (s.accPerShare - u128(rec, 81))) / ACC_SCALE;
    sim = await simulate([createAta(payer, payer, WSOL), claimRewardsIx(staker, poolKey, pool, userQuote)], payer, [userQuote]);
    if (owed === 0n) check(errorOf(sim) === String(RULES_ERR.NothingToClaim) && failedIn(sim, HOOK.rules), tag + "claim_rewards with nothing earned: " + RULES_ERR.NothingToClaim);
    else {
      const paid = logEvent(sim, "RewardsClaimed");
      check(!sim.err && u64(sim.accounts[0].data, 64) === wsolBefore + owed && !!paid && u64(paid.body, 64) === owed && key(paid.body, 32).equals(staker), tag + "claim_rewards, signed by the staker, pays what the record is owed after settling: the amount at 97 (" + u64(rec, 97) + ") plus stake * (rewards per unit now - the record's at 81) / 10^12 = " + owed + " lamports" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
      const u = unitsOf(sim, HOOK.rules);
      if (u && !sim.err) addCu("rules: claim_rewards", "", u);
    }
    });
  }
  if (!open.length) note("no stake record on this cluster is 9,000 slots old (the oldest was staked in slot " + (records.length ? records.reduce((m, t) => (u64(t.account.data, 105) < m ? u64(t.account.data, 105) : m), MAX_U64) : "-") + ", the chain is at " + clock.slot + "): a real unstake is not simulated");
  for (const t of open.slice(0, perKind)) {
    const poolKey = key(t.account.data, 9), staker = key(t.account.data, 41);
    const tag = "stake record " + short(t.pubkey) + " on pool " + short(poolKey) + ": ";
    const read = await conn.getMultipleAccountsInfo([poolKey, rulesCfgOf(poolKey), t.pubkey, stakeVaultOf(poolKey)]);
    const pool = decodePool(read[0].data), rules = decodeRules(read[1].data), rec = read[2].data;
    await guarded(poolKey, pool, tag, async () => {
    const amount = u64(rec, 73);
    const to = ataOf(payer, pool.baseMint, pool.baseTokenProgram);
    const coinsBefore = await heldAt(to);
    const s = settleRules(rules, pool);
    const owed = u64(rec, 97) + (amount * (s.accPerShare - u128(rec, 81))) / ACC_SCALE;
    let sim = await simulate([createAta(payer, payer, pool.baseMint, pool.baseTokenProgram), unstakeIx(staker, poolKey, pool, amount, to)], payer, [to, t.pubkey, rulesCfgOf(poolKey)]);
    const ev = logEvent(sim, "Unstaked");
    check(!sim.err && u64(sim.accounts[0].data, 64) === coinsBefore + amount && u64(sim.accounts[1].data, 73) === 0n && u64(sim.accounts[1].data, 97) === owed && decodeRules(sim.accounts[2].data).totalStaked === rules.totalStaked - amount,
      tag + "9,000 slots after its last stake, unstake pays the coins back to the account the staker names, and keeps what the record earned (" + owed + " lamports) at 97" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
    check(!!ev && ev.body.length === LAYOUT.staked.size && key(ev.body, 0).equals(poolKey) && key(ev.body, 32).equals(staker) && u64(ev.body, 64) === amount && u64(ev.body, 72) === 0n && u64(ev.body, 80) === rules.totalStaked - amount && notInner(sim, "Unstaked"), tag + "Unstaked is in the log: pool, wallet, amount, what the record still holds, the config's total, slot; 96 bytes");
    let u = unitsOf(sim, HOOK.rules);
    if (u) addCu("rules: unstake", "", u);
    sim = await simulate([createAta(payer, payer, pool.baseMint, pool.baseTokenProgram), unstakeIx(staker, poolKey, pool, amount + 1n, to)], payer);
    check(errorOf(sim) === String(RULES_ERR.InsufficientStake) && failedIn(sim, HOOK.rules), tag + "unstake of more than the record holds: " + RULES_ERR.InsufficientStake);
    sim = await simulate([createAta(payer, payer, WSOL), claimRewardsIx(staker, poolKey, pool, userQuote)], payer, [userQuote]);
    if (owed === 0n) check(errorOf(sim) === String(RULES_ERR.NothingToClaim) && failedIn(sim, HOOK.rules), tag + "claim_rewards with nothing earned: " + RULES_ERR.NothingToClaim);
    else {
      const paid = logEvent(sim, "RewardsClaimed");
      check(!sim.err && u64(sim.accounts[0].data, 64) === wsolBefore + owed && !!paid && u64(paid.body, 64) === owed, tag + "claim_rewards pays what the record is owed after settling: the amount at 97 plus stake * (rewards per unit now - the record's at 81) / 10^12 = " + owed + " lamports" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
      u = unitsOf(sim, HOOK.rules);
      if (u) addCu("rules: claim_rewards", "", u);
    }
    });
  }
}

// ---- section 9 and 13: the strict coin, its holder records, its sends and what it refuses ---------------------
console.log("# the strict coin");
{
  const T22 = TOKEN_2022;
  const clock = await chainClock();
  for (const [x, r] of done) {
    if (!x.strict) continue;
    const { poolKey } = x;
    const tag = kindOf(x) + " " + short(poolKey) + ": ";
    const read = await conn.getMultipleAccountsInfoAndContext([poolKey, x.cfgKey, holderOf(poolKey, payer), lockOf(poolKey)], "confirmed");
    const pool = decodePool(read.value[0].data), cfg = read.value[1].data, st = decodeStrict(cfg), rules = decodeRules(cfg);
    const slot = read.context.slot;
    const early = earlyRuns(st, slot + 3), capRuns = maxWalletRuns(st, slot + 3), earlyLock = earlyLockRuns(st, slot + 3);
    if (read.value[2]) { note(tag + "the fee payer already has a holder record here: the strict checks are skipped"); continue; }
    await guarded(poolKey, pool, tag, async () => {
    const userBase = r.userBase, me = holderOf(poolKey, payer);
    const head = (lamports) => [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), createAta(payer, payer, pool.baseMint, T22), ...wrap(payer, lamports)];
    const buyIx = (amount) => swapIx(poolKey, pool, payer, userBase, userQuote, 0, amount, 0n, r.extra);
    // open_holder, then a buy: the record follows the wallet's coin account
    let sim = await simulate([...head(r.amountIn), openHolderIx(payer, poolKey, pool), buyIx(r.amountIn)], payer, [me, userBase, x.cfgKey]);
    if (sim.err) { check(false, tag + "open_holder, then a buy, succeed  (error " + errorOf(sim) + ": " + sim.logs.slice(-2).join(" / ").slice(0, 160) + ")"); return; }
    const rec = decodeHolder(sim.accounts[0].data), coins = u64(sim.accounts[1].data, 64);
    const opened = sim.logged.find((e) => same(e.disc, DISC["event:HolderOpened"]));
    check(sim.accounts[0].data.length === LAYOUT.holder_record.size && starts(sim.accounts[0].data, DISC["account:HolderRecord"]) && rec.pool.equals(poolKey) && rec.owner.equals(payer) && rec.balance === coins && rec.earlyBought === (early ? coins : 0n) && rec.locked === 0n,
      tag + "open_holder (wallet, config, pool, record, the wallet's coin account, system program) makes a record of 129 bytes; after a buy its balance at 73 is what the wallet holds" + (early ? " and the early coins at 105 are the whole buy" : ", and nothing at 105 outside the early window"));
    check(!!opened && opened.body.length === LAYOUT.holder_event.size && key(opened.body, 0).equals(poolKey) && key(opened.body, 32).equals(payer) && u64(opened.body, 64) === 0n && !sim.inner.some((e) => same(e.disc, DISC["event:HolderOpened"])), tag + "HolderOpened is in the log: pool, wallet, what the wallet held when it opened; 72 bytes");
    const u0 = unitsOf(sim, HOOK.rules); if (u0) addCu("strict: open_holder", "", u0);
    addCu("strict | buy", "", unitsOf(sim, HOOKPOOL));
    // the refusals of the windows
    if (early) {
      sim = await simulate([...head(r.amountIn), buyIx(r.amountIn)], payer);
      check(errorOf(sim) === String(RULES_ERR.HolderRecordRequired) && failedIn(sim, HOOK.rules), tag + "in the early window a buy by a wallet without a holder record: " + RULES_ERR.HolderRecordRequired + " HolderRecordRequired");
    }
    if (capRuns) {
      // the cheapest buy that leaves the wallet above the cap
      let big = r.amountIn;
      while (quote(pool.reserveBase, pool.reserveQuote, pool.lpFeeBps, platform.protocolFeeBps, true, big, 0, null, pool.virtualQuote).out <= st.maxWalletAmount && big < 50n * LAMPORTS_PER_SOL_N) big *= 2n;
      if (big + 100_000_000n < BigInt(await conn.getBalance(payer))) {
        sim = await simulate([...head(big), openHolderIx(payer, poolKey, pool), buyIx(big)], payer);
        check(errorOf(sim) === String(RULES_ERR.MaxWallet) && failedIn(sim, HOOK.rules), tag + "while the max wallet runs (until slot " + (st.startSlot + st.maxWalletSlots) + ") a buy that would leave the wallet above " + st.maxWalletAmount + " units: " + RULES_ERR.MaxWallet + " MaxWallet");
      }
    }
    // a send: Token-2022 TransferChecked with the coin's five accounts
    const friend = Keypair.generate().publicKey, friendBase = ataOf(friend, pool.baseMint, T22);
    const part = coins / 3n;
    const send = (amount, extra = strictSendExtras(poolKey, pool, payer, friend), to = friendBase) => transferCheckedIx(userBase, pool.baseMint, to, payer, amount, 6, extra);
    const base = [...head(r.amountIn), openHolderIx(payer, poolKey, pool), buyIx(r.amountIn), createAta(payer, friend, pool.baseMint, T22)];
    sim = await simulate([...base, send(part)], payer, [friendBase, me, holderOf(poolKey, friend)]);
    const boughtEarly = earlyRuns(st, slot);
    if (earlyLock && boughtEarly) check(errorOf(sim) === String(RULES_ERR.EarlyLocked) && failedIn(sim, HOOK.rules), tag + "a send of coins bought in the early window, before the early unlock (slot " + (st.startSlot + st.earlyUnlockSlots) + "): " + RULES_ERR.EarlyLocked + " EarlyLocked" + (errorOf(sim) === String(RULES_ERR.EarlyLocked) ? "" : "  (got " + errorOf(sim) + ": " + sim.logs.filter((l) => /Error|failed/.test(l)).slice(-2).join(" / ").slice(0, 300) + ")"));
    else if (earlyLock) note(tag + "the early window ended while the early lock still runs: the send of early coins is not checked here");
    else {
      check(!sim.err && u64(sim.accounts[0].data, 64) === part && decodeHolder(sim.accounts[1].data).balance === coins - part && (!sim.accounts[2] || sim.accounts[2].lamports === 0), tag + "a send between two wallets: TransferChecked (source, mint, destination, owner), then the config, the two holder record addresses, the account list and the hook program; the sender's record follows its balance, the receiver needs no record" + (sim.err ? "  (error " + errorOf(sim) + ": " + sim.logs.slice(-4).join(" / ").slice(0, 300) + ")" : ""));
      const u = unitsOf(sim, T22); if (u && !sim.err) addCu("strict: a send (TransferChecked)", "", u);
      const reordered = [...strictSendExtras(poolKey, pool, payer, friend)].reverse();
      const s2 = await simulate([...base, send(part, reordered)], payer);
      check(!s2.err, tag + "the five accounts of a send are found in any order");
      const s3 = await simulate([...base, send(part, strictSendExtras(poolKey, pool, payer, friend).slice(0, 4))], payer);
      check(!!s3.err && failedIn(s3, T22), tag + "a send without the hook program among its accounts fails in the token program (" + errorOf(s3) + ")");
      // a token account of the coin that is not the receiver's associated one
      const odd = Keypair.generate().publicKey;
      const space = 171; // a Token-2022 account with the TransferHookAccount extension
      const init = new TransactionInstruction({ programId: T22, data: Buffer.concat([Buffer.from([18]), friend.toBuffer()]), keys: [rw(odd), ro(pool.baseMint)] });
      const s4 = await simulate([...head(r.amountIn), openHolderIx(payer, poolKey, pool), buyIx(r.amountIn), SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: odd, lamports: await conn.getMinimumBalanceForRentExemption(space), space, programId: T22 }), init, send(part, strictSendExtras(poolKey, pool, payer, friend), odd)], payer);
      if (s4.tooLarge) note(tag + "a send to an account that is not associated does not fit one transaction with the buy: not checked");
      else check(errorOf(s4) === String(RULES_ERR.NotAssociatedAccount) && failedIn(s4, HOOK.rules), tag + "a send to a token account of the receiver that is not its associated one: " + RULES_ERR.NotAssociatedAccount + " NotAssociatedAccount" + (errorOf(s4) === String(RULES_ERR.NotAssociatedAccount) ? "" : "  (got " + errorOf(s4) + ")"));
    }
    // close_holder: refused while the record holds coins; a record that holds nothing closes and returns its rent
    sim = await simulate([...head(r.amountIn), openHolderIx(payer, poolKey, pool), buyIx(r.amountIn), closeHolderIx(payer, poolKey)], payer);
    check(errorOf(sim) === String(RULES_ERR.HolderNotEmpty) && failedIn(sim, HOOK.rules), tag + "close_holder on a record that holds coins: " + RULES_ERR.HolderNotEmpty + " HolderNotEmpty");
    sim = await simulate([openHolderIx(payer, poolKey, pool), closeHolderIx(payer, poolKey)], payer, [me]);
    const closed = sim.logged.find((e) => same(e.disc, DISC["event:HolderClosed"]));
    check(!sim.err && (!sim.accounts[0] || sim.accounts[0].lamports === 0) && !!closed && closed.body.length === 64 && key(closed.body, 32).equals(payer), tag + "close_holder (wallet, config, record) closes an empty record; HolderClosed is in the log: pool, wallet; 64 bytes" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
    // what the plain instructions answer on a strict coin
    const to = ataOf(payer, pool.baseMint, T22);
    sim = await simulate([...head(r.amountIn), openHolderIx(payer, poolKey, pool), buyIx(r.amountIn), stakeIx(payer, poolKey, pool, 1n, userBase)], payer);
    eq(errorOf(sim), "3012", tag + "stake on a strict coin: Anchor 3012, its stake vault does not exist");
    sim = await simulate([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), burnIx("run_burn", HOOK.rules, payer, poolKey, pool, 0n)], payer);
    eq(errorOf(sim), "3012", tag + "run_burn on a strict coin: Anchor 3012, its burn account does not exist");
    sim = await simulate([lockCreatorIx(rules.creator, poolKey, pool, 1n, clock.time + 86_400n, ataOf(rules.creator, pool.baseMint, T22))], payer);
    check(errorOf(sim) === String(RULES_ERR.StrictCoin) && failedIn(sim, HOOK.rules), tag + "lock_creator on a strict coin: " + RULES_ERR.StrictCoin + " StrictCoin" + (errorOf(sim) === String(RULES_ERR.StrictCoin) ? "" : "  (got " + errorOf(sim) + ")"));
    sim = await simulate([unlockCreatorIx(rules.creator, poolKey, pool, ataOf(rules.creator, pool.baseMint, T22))], payer);
    eq(errorOf(sim), "3012", tag + "unlock_creator on a strict coin: Anchor 3012, the lock vault does not exist");
    // lock_creator_strict: never more than the wallet holds
    const creatorHolds = await heldAt(ataOf(rules.creator, pool.baseMint, T22));
    sim = await simulate([lockCreatorStrictIx(rules.creator, poolKey, pool, creatorHolds + 1n, clock.time + 86_400n * 400n)], payer);
    const creatorRecord = await conn.getAccountInfo(holderOf(poolKey, rules.creator));
    if (creatorRecord) check(errorOf(sim) === String(RULES_ERR.LockAboveBalance) && failedIn(sim, HOOK.rules), tag + "lock_creator_strict of one unit more than the creator holds: " + RULES_ERR.LockAboveBalance + " LockAboveBalance" + (errorOf(sim) === String(RULES_ERR.LockAboveBalance) ? "" : "  (got " + errorOf(sim) + ")"));
    else eq(errorOf(sim), "3012", tag + "lock_creator_strict by a creator without a holder record: Anchor 3012, the record must exist first");
    // the creator lock, in the creator's wallet
    if (read.value[3]) {
      const lock = { amount: u64(read.value[3].data, 41), unlockAt: read.value[3].data.readBigInt64LE(49) };
      if (lock.amount > 0n && clock.time + 30n < lock.unlockAt && creatorHolds > 0n) {
        const ch = await conn.getAccountInfo(holderOf(poolKey, rules.creator));
        const earlyFirst = earlyLock && !!ch && decodeHolder(ch.data).earlyBought > 0n;
        sim = await simulate([createAta(payer, friend, pool.baseMint, T22), transferCheckedIx(ataOf(rules.creator, pool.baseMint, T22), pool.baseMint, friendBase, rules.creator, 1n, 6, strictSendExtras(poolKey, pool, rules.creator, friend))], payer);
        const wantErr = earlyFirst ? RULES_ERR.EarlyLocked : RULES_ERR.CreatorLocked;
        check(errorOf(sim) === String(wantErr) && failedIn(sim, HOOK.rules), tag + "a send of one unit of the creator's locked coins before the unlock time: " + wantErr + (earlyFirst ? " EarlyLocked (they are early coins too, and the early lock is tested first)" : " CreatorLocked") + (errorOf(sim) === String(wantErr) ? "" : "  (got " + errorOf(sim) + ")"));
        sim = await simulate([lockCreatorStrictIx(rules.creator, poolKey, pool, 0n, clock.time + 86_400n * 400n)], payer);
        check(errorOf(sim) === String(RULES_ERR.UnlockTooFar) && failedIn(sim, HOOK.rules), tag + "lock_creator_strict more than 365 days ahead: " + RULES_ERR.UnlockTooFar);
        sim = await simulate([unlockCreatorStrictIx(rules.creator, poolKey)], payer);
        check(errorOf(sim) === String(RULES_ERR.StillLocked) && failedIn(sim, HOOK.rules), tag + "unlock_creator_strict before the unlock time: " + RULES_ERR.StillLocked);
      }
    }
    // claim_holder and sync_holder on the records of this coin
    const recs = await conn.getProgramAccounts(HOOK.rules, { filters: [{ memcmp: { offset: 0, bytes: b58encode(DISC["account:HolderRecord"]) } }, { memcmp: { offset: 9, bytes: poolKey.toBase58() } }] });
    const settled = settleRules(rules, pool);
    for (const t of recs.slice(0, 2)) {
      const h = decodeHolder(t.account.data);
      const owed = h.owed + (h.balance * (settled.accPerShare - h.accSnapshot)) / ACC_SCALE;
      sim = await simulate([createAta(payer, payer, WSOL), claimHolderIx(h.owner, poolKey, pool, userQuote)], payer, [userQuote]);
      if (owed === 0n) check(errorOf(sim) === String(RULES_ERR.NothingToClaim) && failedIn(sim, HOOK.rules), tag + "claim_holder of a record that is owed nothing: " + RULES_ERR.NothingToClaim);
      else {
        const ev = sim.logged.find((e) => same(e.disc, DISC["event:HolderClaimed"]));
        check(!sim.err && u64(sim.accounts[0].data, 64) - (await heldAt(userQuote)) === owed && !!ev && ev.body.length === 72 && u64(ev.body, 64) === owed, tag + "claim_holder, signed by the record's wallet, pays owed (97) + balance (73) * (rewards per unit after settling - the snapshot at 81) / 10^12 = " + owed + " lamports; HolderClaimed is in the log, 72 bytes" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
        const u = unitsOf(sim, HOOK.rules); if (u && !sim.err) addCu("strict: claim_holder", "", u);
      }
      const holds = await heldAt(ataOf(h.owner, pool.baseMint, T22));
      sim = await simulate([syncHolderIx(poolKey, pool, h.owner)], payer, [t.pubkey]);
      check(!sim.err && decodeHolder(sim.accounts[0].data).balance === minB(h.balance, holds), tag + "sync_holder, sent by anyone (config, pool, record, the wallet's coin account), sets the balance at 73 to " + minB(h.balance, holds) + ": what the wallet holds, never more than the record had" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
      const u = unitsOf(sim, HOOK.rules); if (u && !sim.err) addCu("strict: sync_holder", "", u);
    }
    });
  }
  // open_holder on a plain rules coin
  const plain = pools.find((x) => x.template === "rules" && !x.strict);
  if (plain) {
    const sim = await simulate([openHolderIx(payer, plain.poolKey, plain.pool)], payer);
    check(errorOf(sim) === String(RULES_ERR.NotStrict) && failedIn(sim, HOOK.rules), "open_holder on a plain rules coin: " + RULES_ERR.NotStrict + " NotStrict" + (errorOf(sim) === String(RULES_ERR.NotStrict) ? "" : "  (got " + errorOf(sim) + ")"));
  }
}

// ---- section 12: buy and burn. What a call of execute_buyback or run_burn does -------------------------------
console.log("# buy and burn");
{
  /// Everything a keeper reads, in one consistent call.
  const readBurn = async (x) => {
    const program = x.pool.hookProgram, authority = hookAuthorityOf(x.poolKey, program);
    const burnAccount = ataOf(authority, x.pool.baseMint, x.pool.baseTokenProgram);
    const got = await conn.getMultipleAccountsInfoAndContext([x.poolKey, x.cfgKey, x.pool.hookTreasury, burnAccount], "confirmed");
    if (got.value.slice(0, 3).some((v) => !v)) return null;
    const pool = decodePool(got.value[0].data), cfg = got.value[1].data, isRules = x.template === "rules";
    const rules = isRules ? decodeRules(cfg) : null;
    const at = isRules ? 350 : 206;
    const obs = { slot: u64(cfg, at), base: u64(cfg, at + 8), quote: u64(cfg, at + 16) };
    const treasury = u64(got.value[2].data, 64);
    // the pot: the settled burn pot of a rules pool; the whole treasury of a buyback pool
    const pot = isRules ? settleRules(rules, pool).burnPot : treasury;
    const capBps = isRules ? rulesCapBps(rules, platform, pool.lpFeeBps) : buybackCapBps(cfg, platform, pool.lpFeeBps);
    const empty = isRules ? pot === 0n : treasury === 0n || treasury < u64(cfg, 142);
    return { program, authority, burnAccount, pool, cfg, rules, isRules, obs, pot, capBps, empty, waiting: got.value[3] && got.value[3].data.length >= 72 ? u64(got.value[3].data, 64) : 0n, slot: got.context.slot };
  };
  // the quote reserve of the rule is the quote side of the price: real plus virtual (section 12)
  const stepAt = (s, slot) => (s.empty ? { step: "nothing to spend" } : burnStep(s.obs, s.pool.reserveBase, effectiveQuote(s.pool), slot, s.capBps, s.pot));
  // pools by what a call would do now, at most --per-kind of each
  const candidates = pools.filter((x) => (x.template === "buyback" || x.template === "rules") && x.pool.quoteMint.equals(WSOL)).sort((a, b) => Number(b.pool.createdSlot - a.pool.createdSlot)).slice(0, 80);
  const byStep = new Map();
  for (const x of candidates) {
    const s = await readBurn(x);
    if (!s) continue;
    const k = x.template + " | " + stepAt(s, s.slot).step;
    const list = byStep.get(k) || [];
    if (list.length < perKind) { list.push(x); byStep.set(k, list); }
  }
  if (!candidates.length) note("no buyback pool and no rules pool on this cluster: the buy-and-burn rule is not checked");
  else note("buyback and rules pools by what a call would do now: " + [...byStep.entries()].map(([k, v]) => v.length + " " + k).sort().join(", "));
  for (const [, list] of [...byStep.entries()].sort()) for (const x of list) {
    const { poolKey } = x;
    const s = await readBurn(x);
    if (!s) continue;
    const name = x.strict ? "run_burn_strict" : s.isRules ? "run_burn" : "execute_buyback";
    const E = s.isRules ? { empty: RULES_ERR.NothingToBurn, soon: RULES_ERR.BurnTooSoon, event: "BurnExecuted" } : { empty: BUYBACK_ERR.BelowThreshold, soon: BUYBACK_ERR.TooSoon, event: "BuybackExecuted" };
    const tag = x.template + " " + short(poolKey) + ": ";
    await guarded(poolKey, s.pool, tag, async () => {
    const call = (minOut = 0n) => (x.strict ? runBurnStrictIx(payer, poolKey, s.pool, minOut) : burnIx(name, s.program, payer, poolKey, s.pool, minOut));
    const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    let sim = await simulate([budget, call()], payer, [x.cfgKey, poolKey, s.pool.baseMint]);
    // the chain decides in the slot of the simulation, which is the slot of the read or a little later
    const event = sim.hasInner ? sim.inner.find((e) => same(e.disc, DISC["event:" + E.event]) && e.program.equals(s.program)) : null;
    const slot = event ? Number(u64(event.body, 48)) : sim.slot;
    const want = stepAt(s, slot);
    const text = name + " with " + (s.isRules ? "a burn pot of " + s.pot + " lamports after settling (262: " + s.rules.burnPot + ")" : "a treasury of " + s.pot + " lamports") + ", a cap of " + s.capBps + " bps and " + (s.obs.base === 0n ? "no observation" : "an observation of slot " + s.obs.slot) + ", in slot " + slot + ": ";
    if (want.step === "nothing to spend") { check(errorOf(sim) === String(E.empty) && failedIn(sim, s.program), tag + name + " with nothing to spend" + (s.isRules ? "" : " (the treasury holds " + s.pot + ", the config asks for " + u64(s.cfg, 142) + ")") + ": " + E.empty); return; }
    if (want.step === "too soon" || (!event && sim.err)) {
      const near = [slot - 1, slot, slot + 1, slot + 2].some((n) => stepAt(s, n).step === "too soon");
      check(near && errorOf(sim) === String(E.soon) && failedIn(sim, s.program), tag + text + "the observation is less than 25 slots old, the call fails with " + E.soon + (near && errorOf(sim) === String(E.soon) ? "" : "  (got " + errorOf(sim) + ", the rule says " + want.step + ")"));
      return;
    }
    if (sim.err || !event) { check(false, tag + text + "the rule says " + want.step + "  (error " + errorOf(sim) + ", " + (sim.hasInner ? "no event" : "this RPC node returns no inner instructions") + ")"); return; }
    const e = event.body, rd = sim.returnData;
    const cfgAfter = sim.accounts[0].data, poolAfter = decodePool(sim.accounts[1].data);
    const at = s.isRules ? 350 : 206;
    const obsAfter = { slot: u64(cfgAfter, at), base: u64(cfgAfter, at + 8), quote: u64(cfgAfter, at + 16) };
    eq(e[56], want.outcome, tag + text + "the rule says " + want.step + ", the outcome in the event at 56 is " + want.outcome);
    check(!!rd && rd.length === LAYOUT.burn_result.size && sim.returnProgram === s.program.toBase58() && rd[0] === e[56] && rd.readBigUInt64LE(1) === u64(e, 32) && rd.readBigUInt64LE(9) === u64(e, 40), tag + "the return data is 17 bytes set by the hook: the outcome, the quote spent, the coins burned, the same as in the event" + (rd ? "" : "  (no return data)"));
    check(e.length === LAYOUT.burn_executed.size && key(e, 0).equals(poolKey) && u64(e, 57) === obsAfter.base && u64(e, 65) === obsAfter.quote && obsAfter.slot === u64(e, 48), tag + E.event + " is an inner instruction of the hook, 73 bytes: pool, quote spent, coins burned, slot, outcome, and the observation the call left in the config (slot at " + at + ", reserves at " + (at + 8) + " and " + (at + 16) + ")");
    const u = unitsOf(sim, s.program);
    if (u) addCu(name + ", " + want.step, "", u);
    if (want.step === "buy") eq(sim.depth, 3, tag + "call depth of a call that buys, as a top-level instruction: hook, pool, token program");
    if (want.step !== "buy") {
      check(u64(e, 32) === 0n && u64(e, 40) === 0n && obsAfter.base === s.pool.reserveBase && obsAfter.quote === effectiveQuote(s.pool) && poolAfter.reserveBase === s.pool.reserveBase && poolAfter.swaps === s.pool.swaps,
        tag + "it bought nothing and recorded the pool's reserves as they are" + (s.pool.virtualQuote ? " (the quote reserve with the virtual " + s.pool.virtualQuote + " in it)" : "") + ": " + (want.step === "observe" ? "the first observation" : "the price was more than " + 2n * s.capBps + " bps above the observed price"));
    } else {
      const q = quote(s.pool.reserveBase, s.pool.reserveQuote, s.pool.lpFeeBps, platform.protocolFeeBps, true, want.spend, 0, null, s.pool.virtualQuote);
      const burned = q.out + (x.strict ? 0n : s.waiting);
      if (x.strict) {
        // hook_buy_burn: the pool burns what it bought in its own vault; the coin is not transferred
        const supplyBefore = u64((await conn.getAccountInfo(s.pool.baseMint)).data, 36), supplyAfter = u64(sim.accounts[2].data, 36);
        // the node may hand token instructions back parsed, or as raw bytes
        const tok = sim.rawInner.filter((i) => i.program.equals(TOKEN_2022)).map((i) => (i.parsed ? { type: i.parsed.type, account: i.parsed.info && (i.parsed.info.account || i.parsed.info.source), amount: i.parsed.info && BigInt(i.parsed.info.amount ?? (i.parsed.info.tokenAmount ? i.parsed.info.tokenAmount.amount : 0)) }
          : { type: { 8: "burn", 15: "burnChecked", 12: "transferChecked", 3: "transfer" }[i.data[0]] || "other", account: i.accounts[0] && i.accounts[0].toBase58(), amount: i.data.length >= 9 ? i.data.readBigUInt64LE(1) : 0n }));
        const burns = tok.filter((i) => i.type === "burn" || i.type === "burnChecked").map((i) => ({ accounts: [new PublicKey(i.account)], data: (() => { const b = Buffer.alloc(9); b[0] = i.type === "burn" ? 8 : 15; b.writeBigUInt64LE(i.amount, 1); return b; })() }));
        const moves = tok.filter((i) => (i.type === "transferChecked" || i.type === "transfer") && i.account === s.pool.baseVault.toBase58());
        const byPool = sim.rawInner.find((i) => i.program.equals(HOOKPOOL) && starts(i.data, DISC["global:hook_buy_burn"]));
        check(!!byPool && byPool.data.length === LAYOUT.hook_buy_burn_data.size && byPool.data.readBigUInt64LE(8) === want.spend && byPool.data[24] === bumpOf(["hook-authority", poolKey], HOOK.rules), tag + "run_burn_strict calls the pool's hook_buy_burn (25 bytes: amount in, minimum out, the bump of the hook authority)");
        check(burns.length === 1 && burns[0].accounts[0].equals(s.pool.baseVault) && burns[0].data.readBigUInt64LE(1) === q.out && moves.length === 0 && supplyAfter === supplyBefore - q.out,
          tag + "hook_buy_burn burns the " + q.out + " coins it bought in the pool's base vault (a token Burn, instruction " + (burns[0] ? burns[0].data[0] : "?") + "), moves no coin out of the vault, and the supply falls by them");
      }
      check(u64(e, 32) === want.spend && u64(e, 40) === burned, tag + "it spent min(pot, max(1, min(reserve_quote, observed reserve_quote) * cap / 10000)) = " + want.spend + " lamports and burned " + burned + " units: the pool's quote for that buy with no hook fee" + (s.waiting ? ", and the " + s.waiting + " units that waited in the burn account" : ""));
      check(poolAfter.reserveBase === q.reserveBase && poolAfter.reserveQuote === q.reserveQuote && obsAfter.base === q.reserveBase && obsAfter.quote === q.reserveQuote + s.pool.virtualQuote && poolAfter.hookFeesCharged === s.pool.hookFeesCharged, tag + "the pool after the buy: the reserves of the formula, no hook fee; they are the new observation" + (s.pool.virtualQuote ? ", its quote reserve with the virtual " + s.pool.virtualQuote + " added" : ""));
      const c = cfgAfter;
      if (s.isRules) { const a = decodeRules(c); check(a.burnPot === s.pot - want.spend && a.totalQuoteBurned === s.rules.totalQuoteBurned + want.spend && a.totalBaseBurned === s.rules.totalBaseBurned + burned && a.burns === s.rules.burns + 1n, tag + "the config after the buy: burn pot 262 less the spend, quote burned 326, coins burned 334, runs that bought 342"); }
      else check(u64(c, 150) === u64(s.cfg, 150) + want.spend && u64(c, 158) === u64(s.cfg, 158) + burned && u64(c, 166) === u64(s.cfg, 166) + 1n, tag + "the config after the buy: quote spent 150, coins burned 158, buybacks that bought 166");
      const sw = eventsOf(sim, "Swapped", HOOKPOOL).map((b) => decodeSwapped(b.body))[0];
      check(!!sw && sw.byHook === 1 && sw.user.equals(s.authority) && sw.hookFee === 0n && sw.amountIn === want.spend && sw.amountOut === q.out && sw.direction === 0, tag + "the buy is a Swapped of the pool with byte 131 set, no hook fee, and the hook's authority [\"hook-authority\", pool] as signer");
      sim = await simulate([budget, call(q.out)], payer);
      check(!sim.err, tag + "min_amount_out equal to the pool's quote for the spend passes");
      sim = await simulate([budget, call(q.out + 1n)], payer);
      check(errorOf(sim) === String(ERR.Slippage) && failedIn(sim, HOOKPOOL), tag + "min_amount_out one unit above it: " + ERR.Slippage + " from the pool program");
    }
    // a second call in the same transaction finds an observation of this slot
    const left = want.step === "buy" ? s.pot - want.spend : s.pot;
    const spent = s.isRules ? left === 0n : left === 0n || left < u64(s.cfg, 142);
    sim = await simulate([budget, call(), call()], payer);
    check(errorOf(sim) === String(spent ? E.empty : E.soon) && failedIn(sim, s.program), tag + "a second call right after it: " + (spent ? E.empty + ", the first call left nothing to spend" : E.soon + ", the observation it left is less than 25 slots old"));
    });
  }
}

// ---- section 9: tickets, earning, settle ----------------------------------------------------------------------
console.log("# collectible and pegged coins");
for (const [x, r] of done) {
  if (x.template !== "collectible") continue;
  const { poolKey } = x;
  const tag = kindOf(x) + " " + short(poolKey) + ": ";
  const ticket = ticketOf(poolKey, payer);
  if (await conn.getAccountInfo(ticket)) { note(tag + "the fee payer already has a ticket here: the ticket checks are skipped"); continue; }
  const read = await conn.getMultipleAccountsInfo([poolKey, x.cfgKey]);
  const pool = decodePool(read[0].data), cfg = read[1].data;
  await guarded(poolKey, pool, tag, async () => {
  const unit = u64(cfg, 204), maxPerBuy = cfg[228];
  const left = BigInt(Math.max(0, cfg.readUInt32LE(212) - cfg.readUInt32LE(220) - cfg.readUInt32LE(224)));
  const buyIx = swapIx(poolKey, pool, payer, r.userBase, userQuote, 0, r.amountIn, 0n, r.extra);
  // without a ticket: the buy goes through, nothing is earned (simulated above); now with one
  let sim = await simulate([openTicketIx(payer, poolKey), ...r.pre, buyIx], payer, [ticket, x.cfgKey, poolKey]);
  if (sim.err) { check(false, tag + "open_ticket then a buy succeeds  (error " + errorOf(sim) + ": " + sim.logs.slice(-2).join(" / ").slice(0, 160) + ")"); return; }
  const t = sim.accounts[0].data, c = sim.accounts[1].data;
  const out = sim.out;
  addCu(kindOf(x) + ", more for a signer with a ticket", "buy", sim.units - r.units);
  const want = [out / unit, BigInt(maxPerBuy), left, 200n].reduce((a, b) => (a < b ? a : b));
  eq(t.length, LAYOUT.ticket.size, tag + "open_ticket (wallet, ticket writable, system program) makes a ticket of 346 bytes");
  eq(sim.accounts[0].lamports, await conn.getMinimumBalanceForRentExemption(346), tag + "the ticket holds the rent of 346 bytes at this chain's rent (2,407,920 lamports on mainnet, 3,299,040 on a local validator)");
  check(starts(t, DISC["account:Ticket"]) && key(t, 9).equals(poolKey) && key(t, 41).equals(payer) && t.readUInt32LE(73) === 0 && t.readUInt32LE(342) === 0, tag + "new ticket: discriminator, pool 9, wallet 41, minted 73 zero, list count 342 zero");
  eq(BigInt(t.readUInt32LE(77)), want, tag + "a buy of " + out + " units with a unit of " + unit + " earns min(coins / unit, max per buy, pieces left): the count at 77");
  if (want > 0n) {
    const ev = sim.logged.find((e) => same(e.disc, DISC["event:PiecesEarned"]));
    const slot = ev ? u64(ev.body, 68) : null;
    check(t[90] === 1 && BigInt(t[91]) === want && t[92] === 0 && t.readUInt32LE(93) === 0 && zeros(t, 105, 32) && t.subarray(137, 153).equals(cfg.subarray(231, 247)) && (slot === null || u64(t, 97) === slot + 2n), tag + "the first batch at 90: state 1, the pieces, none minted, first number 0, target slot = the buy's slot + 2, seed zeros, the collection's art bytes");
    eq(c.readUInt32LE(224), cfg.readUInt32LE(224) + Number(want), tag + "the config's count of waiting pieces at 224 rose by the pieces");
    check(!!ev && ev.body.length === 84 && key(ev.body, 0).equals(poolKey) && key(ev.body, 32).equals(payer) && BigInt(ev.body.readUInt32LE(64)) === want && u64(ev.body, 76) === u64(ev.body, 68) + 2n, tag + "PiecesEarned is in the log: pool, wallet, pieces, slot, target slot, 84 bytes");
    check(!sim.hasInner || !sim.inner.some((e) => same(e.disc, DISC["event:PiecesEarned"])), tag + "PiecesEarned is not an inner instruction");
  } else note(tag + "a buy of " + r.amountIn + " lamports buys less than one unit here: the batch is not checked");
  check(r.answer.exact && out === quote(pool.reserveBase, pool.reserveQuote, pool.lpFeeBps, platform.protocolFeeBps, true, r.amountIn, 0, null, pool.virtualQuote).out, tag + "with or without a ticket the buy pays the same formula amount");
  // two buys before the target slot share one batch
  sim = await simulate([openTicketIx(payer, poolKey), ...r.pre.slice(0, 2), ...wrap(payer, 2n * r.amountIn), buyIx, buyIx], payer, [ticket]);
  if (want > 0n && !sim.err && sim.accounts[0]) {
    const t2 = sim.accounts[0].data;
    check(t2[90] === 1 && t2[90 + 63] === 0 && t2.readUInt32LE(77) === t2[91] && t2[91] >= t[91], tag + "a second buy before the target slot adds its pieces to the same batch (" + t2[91] + " waiting in one batch)");
  }
  // opening an open ticket is a no-op, and anyone can open a ticket for a wallet
  sim = await simulate([openTicketIx(payer, poolKey), openTicketIx(payer, poolKey)], payer, [ticket]);
  check(!sim.err && sim.accounts[0] && sim.accounts[0].data.length === 346, tag + "opening a ticket that is already open does nothing and does not fail");
  const friend = Keypair.generate().publicKey;
  sim = await simulate([openTicketForIx(payer, poolKey, friend)], payer, [ticketOf(poolKey, friend)]);
  check(!sim.err && sim.accounts[0] && key(sim.accounts[0].data, 41).equals(friend), tag + "open_ticket_for opens the ticket of another wallet");
  // settle: accounts and discriminator
  sim = await simulate([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), openTicketIx(payer, poolKey), settleIx(payer, poolKey, payer, pool.baseMint, pool.baseTokenProgram)], payer);
  check(!sim.err, tag + "settle with its eight accounts and no piece account passes on a backed wallet");
  // a waiting piece is dropped by settle once the coins are gone
  if (want > 0n && !x.pegged) {
    sim = await simulate([openTicketIx(payer, poolKey), ...r.pre, buyIx, swapIx(poolKey, pool, payer, r.userBase, userQuote, 1, out, 0n, r.extra)], payer, [ticket]);
    if (!sim.tooLarge) check(!sim.err && BigInt(sim.accounts[0].data[91]) === want && !sim.logged.some((e) => same(e.disc, DISC["event:PiecesTransferred"]) || same(e.disc, DISC["event:PiecesCancelled"])), tag + "on a plain collectible coin a sell of everything leaves the waiting pieces on the ticket");
    sim = await simulate([openTicketIx(payer, poolKey), ...r.pre, buyIx, swapIx(poolKey, pool, payer, r.userBase, userQuote, 1, out, 0n, r.extra), settleIx(payer, poolKey, payer, pool.baseMint, pool.baseTokenProgram)], payer, [ticket, x.cfgKey]);
    if (sim.tooLarge) note(tag + "buy, sell and settle do not fit one transaction without a lookup table: not checked");
    else {
      const ev = sim.logged.find((e) => same(e.disc, DISC["event:PiecesCancelled"]));
      check(!sim.err && sim.accounts[0].data.readUInt32LE(77) === Number(want) && sim.accounts[0].data[91] === 0 && sim.accounts[1].data.readUInt32LE(224) === cfg.readUInt32LE(224) && !!ev && ev.body.length === 68 && BigInt(ev.body.readUInt32LE(64)) === want, tag + "on a plain collectible coin a sell leaves the waiting pieces; settle drops them and logs PiecesCancelled (68 bytes)");
    }
  }
  if (x.pegged) {
    sim = await simulate([openTicketIx(payer, poolKey), ...r.pre, buyIx, swapIx(poolKey, pool, payer, r.userBase, userQuote, 1, out, 0n, r.extra)], payer, [ticket]);
    if (sim.tooLarge) note(tag + "ticket, buy and sell do not fit one transaction without a lookup table: not checked");
    else {
      const ev = sim.logged.find((e) => same(e.disc, DISC["event:PiecesTransferred"]));
      if (!sim.err && r.unitsOfSell) addCu(kindOf(x) + ", more for a signer with a ticket", "sell", sim.units - r.unitsOfSell);
      check(!sim.err && sim.accounts[0].data[91] === 0 && (want === 0n || (!!ev && ev.body.length === 108 && BigInt(ev.body.readUInt32LE(96)) === want && key(ev.body, 32).equals(payer) && key(ev.body, 64).equals(poolKey))), tag + "on a pegged coin the sell itself drops the pieces the coins no longer back, and logs PiecesTransferred (108 bytes)");
    }
  }
  });
}

// ---- section 6: hook fees that wait ----------------------------------------------------------------------------
console.log("# hook fees and their treasury");
{
  const waiting = pools.filter((x) => x.pool.hookFeesOwed > 0n && x.pool.quoteMint.equals(WSOL));
  if (!waiting.length) note("no pool holds hook fees that wait: collect_hook_fees is checked for its refusal only");
  for (const x of waiting.slice(0, 2)) {
    const tag = kindOf(x) + " " + short(x.poolKey) + ": ";
    const read = await conn.getMultipleAccountsInfo([x.poolKey, x.pool.hookTreasury]);
    const pool = decodePool(read[0].data);
    if (pool.hookFeesOwed === 0n) continue;
    const before = read[1] && read[1].data.length >= 72 ? u64(read[1].data, 64) : 0n;
    if (!read[1]) {
      const s = await simulate([collectHookFeesIx(x.poolKey, pool)], payer);
      eq(errorOf(s), "3012", tag + "collect_hook_fees while the treasury does not exist: Anchor 3012");
    }
    const sim = await simulate([createAta(payer, pool.treasuryOwner, pool.quoteMint, pool.quoteTokenProgram), collectHookFeesIx(x.poolKey, pool)], payer, [x.poolKey, pool.hookTreasury]);
    if ((await conn.getAccountInfo(x.poolKey)).data.readBigUInt64LE(464) !== pool.hookFeesOwed) { note(tag + "the fees moved during the check: skipped"); continue; }
    const a = !sim.err && sim.accounts[0] ? decodePool(sim.accounts[0].data) : null;
    if (!sim.err && unitsOf(sim, HOOKPOOL)) addCu("collect_hook_fees", "", unitsOf(sim, HOOKPOOL));
    check(!!a && a.hookFeesOwed === 0n && a.reserveQuote === pool.reserveQuote && a.reserveBase === pool.reserveBase && u64(sim.accounts[1].data, 64) === before + pool.hookFeesOwed, tag + "anyone can recreate the treasury for the wallet at 472 and send collect_hook_fees: the " + pool.hookFeesOwed + " lamports that waited reach it, 464 is zero, the reserves do not move" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
    {
      // or no collection at all: once the treasury exists again, the next swap that charges a hook fee pays it and what waited
      const r = done.get(x);
      if (r && !read[1]) {
        const back = await simulate([r.pre[0], createAta(payer, pool.treasuryOwner, pool.quoteMint, pool.quoteTokenProgram), ...r.pre.slice(1), swapIx(x.poolKey, pool, payer, r.userBase, userQuote, 0, r.amountIn, 0n, r.extra)], payer, [x.poolKey, pool.hookTreasury]);
        const p2 = !back.err && back.accounts[0] ? decodePool(back.accounts[0].data) : null;
        const fee2 = p2 ? p2.hookFeesCharged - pool.hookFeesCharged : 0n;
        if ((await conn.getAccountInfo(x.poolKey)).data.readBigUInt64LE(464) === pool.hookFeesOwed) {
          check(!!p2 && fee2 > 0n && p2.hookFeesOwed === 0n && u64(back.accounts[1].data, 64) === pool.hookFeesOwed + fee2, tag + "once the treasury account exists again, the next buy pays its own hook fee of " + fee2 + " and the " + pool.hookFeesOwed + " lamports that waited, and 464 is zero" + (back.err ? "  (error " + errorOf(back) + ")" : ""));
          if (!back.err && r.units) addCu(kindOf(x) + ", fewer when the fee waits for a missing treasury", "buy", back.units - r.units);
        }
      }
    }
    const ev = sim.logged.find((e) => same(e.disc, DISC["event:HookFeesCollected"]));
    check(!!ev && ev.body.length === LAYOUT.hook_fees_collected.size && key(ev.body, 0).equals(x.poolKey) && key(ev.body, 32).equals(pool.hookTreasury) && u64(ev.body, 64) === pool.hookFeesOwed, tag + "HookFeesCollected is in the log: pool, treasury, amount, 72 bytes");
    check(!sim.hasInner || !sim.inner.some((e) => same(e.disc, DISC["event:HookFeesCollected"])), tag + "HookFeesCollected is not an inner instruction");
  }
  const feePool = pools.find((x) => !x.pool.hookTreasury.equals(PublicKey.default) && x.pool.hookFeesOwed === 0n && x.treasuryAlive);
  if (feePool) {
    const pool = decodePool((await conn.getAccountInfo(feePool.poolKey)).data);
    if (pool.hookFeesOwed === 0n) {
      const tag = kindOf(feePool) + " " + short(feePool.poolKey) + ": ";
      let s = await simulate([collectHookFeesIx(feePool.poolKey, pool)], payer);
      eq(errorOf(s), String(ERR.NothingToCollect), tag + "collect_hook_fees with nothing waiting: " + ERR.NothingToCollect);
      const ix = collectHookFeesIx(feePool.poolKey, pool);
      ix.keys[3] = rw(userQuote);
      s = await simulate([...wrap(payer, 1000n), ix], payer);
      eq(errorOf(s), String(ERR.HookTreasuryMismatch), tag + "collect_hook_fees to another token account: " + ERR.HookTreasuryMismatch);
    }
  }
  // the platform treasury at offset 73 receives the protocol fees
  for (const owing of [pools.find((x) => (x.pool.protocolFeesBase > 0n || x.pool.protocolFeesQuote > 0n) && !x.pegged && !x.strict && x.pool.quoteMint.equals(WSOL)), pools.find((x) => x.pool.protocolFeesBase > 0n && x.strict && x.pool.quoteMint.equals(WSOL))].filter(Boolean)) {
    const p = owing.pool;
    const tb = ataOf(platform.treasury, p.baseMint, p.baseTokenProgram), tq = ataOf(platform.treasury, p.quoteMint, p.quoteTokenProgram);
    const ix = new TransactionInstruction({ programId: HOOKPOOL, data: Buffer.from(sha8("global:collect_protocol_fees")), keys: [signer(payer, true), ro(PLATFORM), rw(owing.poolKey), ro(p.baseMint), ro(p.quoteMint), rw(p.baseVault), rw(p.quoteVault), ro(platform.treasury), rw(tb), rw(tq), ro(p.baseTokenProgram), ro(p.quoteTokenProgram), ro(ATA_PROGRAM), ro(SYSTEM)] });
    // a strict coin: the coins go from the vault to the platform treasury's account, a transfer with the coin's accounts
    if (owing.strict) ix.keys.push(rw(rulesCfgOf(owing.poolKey)), rw(holderOf(owing.poolKey, owing.poolKey)), rw(holderOf(owing.poolKey, platform.treasury)), ro(validationOf(p.baseMint)), ro(HOOK.rules));
    if (owing.strict) { const bare = new TransactionInstruction({ programId: HOOKPOOL, data: ix.data, keys: ix.keys.slice(0, 14) }); const b = await simulate([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), bare], payer); eq(errorOf(b), String(ERR.HookExtraAccounts), "collect_protocol_fees on a strict coin without the coin's accounts: " + ERR.HookExtraAccounts + " HookExtraAccounts of the pool program"); }
    const sim = await simulate([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], payer, [owing.poolKey]);
    const a = !sim.err && sim.accounts[0] ? decodePool(sim.accounts[0].data) : null;
    const ev = sim.logged.find((e) => same(e.disc, DISC["event:ProtocolFeesCollected"]));
    if (owing.strict && unitsOf(sim, HOOKPOOL)) addCu("strict: collect_protocol_fees", "", unitsOf(sim, HOOKPOOL));
    check(!!a && a.protocolFeesBase === 0n && a.protocolFeesQuote === 0n && !!ev && ev.body.length === 48, (owing.strict ? "a strict coin, with the config, the pool's and the treasury wallet's holder record addresses, the account list and the hook program after the fourteen: " : "") + "collect_protocol_fees, sent by anyone, pays the wallet at platform offset 73 and logs ProtocolFeesCollected (48 bytes); offsets 384 and 392 return to zero" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
  }
}

// ---- section 11: liquidity ---------------------------------------------------------------------------------------
console.log("# liquidity");
for (const [x, r] of done) {
  // a pool on the curve refuses liquidity: its own checks are in the section of the curve below
  if (x.pool.curveState === CURVE_OPEN) continue;
  if (!["no hook", "no hook, Token-2022 coin", "tax", "buyback", "collectible", "pegged"].includes(baseKindOf(x)) && x.template !== "launch_guard" && x.template !== "rules") continue;
  const { poolKey } = x;
  const tag = kindOf(x) + " " + short(poolKey) + ": ";
  const got = await conn.getMultipleAccountsInfoAndContext([poolKey, x.pool.lpMint, ...(x.cfgKey ? [x.cfgKey] : [])], "confirmed");
  const read = got.value;
  const pool = decodePool(read[0].data);
  const supply = u64(read[1].data, 36);
  await guarded(poolKey, pool, tag, async () => {
  const userLp = ataOf(payer, pool.lpMint);
  const buyQ = quote(pool.reserveBase, pool.reserveQuote, pool.lpFeeBps, platform.protocolFeeBps, true, r.amountIn, r.answer.hookFeeBps, r.answer.feeOverrideBps, pool.virtualQuote);
  if (x.template === "launch_guard" || x.template === "rules") {
    // These two hooks are asked before liquidity is added, and refuse while their window runs.
    const cfg = read[2].data, isRules = x.template === "rules";
    const sniperOpens = isRules ? (u64(cfg, 170) === 0n ? 0n : u64(cfg, 216) + u64(cfg, 170)) : u64(cfg, 41) + u64(cfg, 49);
    const st = x.strict ? decodeStrict(cfg) : null;
    const walletOpens = st && st.maxWalletBps > 0 ? st.startSlot + st.maxWalletSlots : 0n;
    const opens = maxB(sniperOpens, walletOpens);
    const refusal = isRules ? (BigInt(got.context.slot) + 3n < sniperOpens ? RULES_ERR.LiquidityInSniperWindow : RULES_ERR.LiquidityInMaxWalletWindow) : GUARD_ERR.LiquidityInGuardWindow;
    const slot = BigInt(got.context.slot);
    if (slot + 3n < opens) {
      const most = (1n << 62n);
      const pre = [...r.pre, r.buy, ...wrap(payer, 1_000_000n), createAta(payer, payer, pool.lpMint)];
      let sim = await simulate([...pre, liquidityIx("add_liquidity", poolKey, pool, payer, r.userBase, userQuote, userLp, 1000n, most, most, r.extra)], payer);
      check(errorOf(sim) === String(refusal) && failedIn(sim, pool.hookProgram), tag + "add_liquidity while the " + (refusal === RULES_ERR.LiquidityInMaxWalletWindow ? "max wallet" : isRules ? "sniper" : "guard") + " window runs (until slot " + opens + "): " + refusal + " from the hook");
      sim = await simulate([...pre, liquidityIx("add_liquidity", poolKey, pool, payer, r.userBase, userQuote, userLp, 1000n, most, most, [])], payer);
      eq(errorOf(sim), String(ERR.HookExtraAccounts), tag + "add_liquidity without the hook's account, the config: " + ERR.HookExtraAccounts);
      return;
    }
    if (slot < opens + 3n) { note(tag + "its window ends in this very slot: liquidity is not checked on this pool"); return; }
  }
  if (!r.answer.exact || r.answer.window) return;
  // deposit a share worth about a tenth of what the buy bought
  const lp = (buyQ.out / 10n) * supply / buyQ.reserveBase;
  if (lp === 0n) { note(tag + "too small to test liquidity"); return; }
  const ceil = (a, b, c) => (a * b + c - 1n) / c;
  const needBase = ceil(lp, buyQ.reserveBase, supply), needQuote = ceil(lp, buyQ.reserveQuote, supply);
  const liqExtra = (pool.hookFlags & FLAG.LIQUIDITY) !== 0 || x.pegged ? r.extra : [];
  const pre = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), createAta(payer, payer, pool.baseMint, pool.baseTokenProgram), ...wrap(payer, r.amountIn + needQuote), r.buy];
  const add = (lpAmount, a, b, lpAccount = userLp) => liquidityIx("add_liquidity", poolKey, pool, payer, r.userBase, userQuote, lpAccount, lpAmount, a, b, liqExtra);
  let sim = await simulate([...pre, createAta(payer, payer, pool.lpMint), add(lp, needBase, needQuote)], payer, [poolKey, userLp, pool.lpMint]);
  if (sim.tooLarge) { note(tag + "a buy and a deposit do not fit one transaction without a lookup table: liquidity is not checked on this pool"); return; }
  const a = !sim.err && sim.accounts[0] ? decodePool(sim.accounts[0].data) : null;
  check(!!a && a.reserveBase === buyQ.reserveBase + needBase && a.reserveQuote === buyQ.reserveQuote + needQuote && u64(sim.accounts[1].data, 64) === lp && u64(sim.accounts[2].data, 36) === supply + lp,
    tag + "add_liquidity of " + lp + " raw LP units takes ceil(lp * reserve / supply) of each token and mints exactly lp" + (liqExtra.length ? " (with the hook's accounts)" : " (without the hook's accounts)") + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
  const lc = sim.hasInner ? eventsOf(sim, "LiquidityChanged", HOOKPOOL)[0] : null;
  if (lc) check(lc.body.length === 113 && key(lc.body, 0).equals(poolKey) && key(lc.body, 32).equals(payer) && lc.body[64] === 1 && u64(lc.body, 65) === needBase && u64(lc.body, 73) === needQuote && u64(lc.body, 81) === lp && u64(lc.body, 89) === a.reserveBase && u64(lc.body, 97) === a.reserveQuote, tag + "LiquidityChanged, an inner instruction of 113 bytes: pool, user, added, base, quote, lp, reserves, slot");
  const expectL = async (ixs, want, text) => { const s = await simulate(ixs, payer); if (s.tooLarge) return; eq(errorOf(s), String(want), tag + text + ": " + want); };
  await expectL([...pre, add(lp, needBase, needQuote)], 3012, "adding without an LP token account");
  await expectL([...pre, createAta(payer, payer, pool.lpMint), add(0n, needBase, needQuote)], ERR.ZeroAmount, "adding an LP amount of zero");
  await expectL([...pre, createAta(payer, payer, pool.lpMint), add(lp, needBase - 1n, needQuote)], ERR.InputAboveMax, "max_base one unit short");
  await expectL([...pre, createAta(payer, payer, pool.lpMint), add(lp, needBase, needQuote - 1n)], ERR.InputAboveMax, "max_quote one lamport short");
  if (x.strict) await expectL([...pre, createAta(payer, payer, pool.lpMint), liquidityIx("add_liquidity", poolKey, pool, payer, r.userBase, userQuote, userLp, lp, needBase, needQuote, r.extra.slice(0, 1))], 3005, "adding to a strict coin with the config but without the coin's three accounts");
  if (x.pegged) await expectL([...pre, createAta(payer, payer, pool.lpMint), liquidityIx("add_liquidity", poolKey, pool, payer, r.userBase, userQuote, userLp, lp, needBase, needQuote, [])], 3005, "adding to a pegged coin without the hook's accounts");
  if ((pool.hookFlags & FLAG.BEFORE_ADD_LIQ) !== 0 && !x.pegged && !x.strict) {
    await expectL([...pre, createAta(payer, payer, pool.lpMint), liquidityIx("add_liquidity", poolKey, pool, payer, r.userBase, userQuote, userLp, lp, needBase, needQuote, [])], ERR.HookExtraAccounts, "this hook is asked before liquidity is added: adding without the hook's account, the config");
    const s = await simulate([...pre, createAta(payer, payer, pool.lpMint), add(lp, needBase, needQuote), liquidityIx("remove_liquidity", poolKey, pool, payer, r.userBase, userQuote, userLp, lp, 0n, 0n, [])], payer);
    if (!s.tooLarge) check(!s.err, tag + "remove_liquidity calls no hook here: it passes without the hook's account");
  }
  { const u = unitsOf(sim, HOOKPOOL); if (u && !sim.err) addCu("add_liquidity: " + kindOf(x), "", u); }
  {
    // account 13, the hook caller, is checked as in a swap
    const wrong = add(lp, needBase, needQuote);
    wrong.keys[13] = ro(hasHook(pool) ? callerOf(SYSTEM) : callerOf(HOOK.tax));
    await expectL([...pre, createAta(payer, payer, pool.lpMint), wrong], 2006, "add_liquidity with the hook caller of another hook program at account 13");
  }
  // remove what was added, in the same simulated transaction
  const supply2 = supply + lp;
  const rb = buyQ.reserveBase + needBase, rq = buyQ.reserveQuote + needQuote;
  const outBase = (lp * rb) / supply2, outQuote = (lp * rq) / supply2;
  const rem = (lpAmount, mb, mq) => liquidityIx("remove_liquidity", poolKey, pool, payer, r.userBase, userQuote, userLp, lpAmount, mb, mq, liqExtra);
  sim = await simulate([...pre, createAta(payer, payer, pool.lpMint), add(lp, needBase, needQuote), rem(lp, outBase, outQuote)], payer, [poolKey, pool.lpMint, pool.lpLock]);
  if (sim.tooLarge) { note(tag + "buy, deposit and withdrawal do not fit one transaction without a lookup table: remove_liquidity is not checked on this pool"); return; }
  const b = !sim.err && sim.accounts[0] ? decodePool(sim.accounts[0].data) : null;
  check(!!b && b.reserveBase === rb - outBase && b.reserveQuote === rq - outQuote && u64(sim.accounts[1].data, 36) === supply && u64(sim.accounts[2].data, 64) === x.locked, tag + "remove_liquidity pays floor(lp * reserve / supply), the supply is back and the lock account did not move" + (sim.err ? "  (error " + errorOf(sim) + ")" : ""));
  { const u = unitsOf(sim, HOOKPOOL); if (u && !sim.err) addCu("remove_liquidity: " + kindOf(x), "", u); }
  await expectL([...pre, createAta(payer, payer, pool.lpMint), add(lp, needBase, needQuote), rem(lp, outBase + 1n, outQuote)], ERR.Slippage, "min_base one unit above what removing pays");
  });
}

// ---- section 14: pools on the curve ---------------------------------------------------------------------------------
console.log("# pools on the curve");
{
  const curvePools = pools.filter((x) => x.pool.curveState !== CURVE_NONE && x.pool.quoteMint.equals(WSOL));
  note(pools.filter((x) => x.pool.curveState === CURVE_OPEN).length + " pools on the curve (" + pools.filter((x) => x.pool.curveState === CURVE_OPEN && x.pool.reserveQuote >= x.pool.graduationTarget).length + " of them past their target), "
    + pools.filter((x) => x.pool.curveState === CURVE_GRADUATED).length + " graduated, " + pools.filter((x) => x.pool.curveState === CURVE_NONE).length + " seeded");
  // the invariant: every coin outside a pool on the curve sold back at once is paid from the real reserve
  {
    const open = pools.filter((x) => x.pool.curveState === CURVE_OPEN);
    let sold = 0, fresh = 0;
    const bad = [];
    for (const x of open) {
      const supply = u64(x.baseMintData, 36), outside = supply - x.pool.reserveBase;
      if (outside <= 0n) { fresh++; continue; }
      sold++;
      const q = quote(x.pool.reserveBase, x.pool.reserveQuote, x.pool.lpFeeBps, platform.protocolFeeBps, false, outside, 0, null, x.pool.virtualQuote);
      if (q.beyondReal) bad.push(short(x.poolKey));
    }
    if (open.length) check(bad.length === 0, "on each of the " + sold + " pools on the curve with coins outside, selling every one of them back in one trade pays at most reserve_quote, by the formula of section 6: the virtual quote is never owed (" + fresh + " more hold the whole supply)" + (bad.length ? "  (not so on " + bad.join(", ") + ")" : ""));
    // progress, for a page (section 14)
    for (const x of open.slice(0, 3)) {
      const supply = u64(x.baseMintData, 36);
      note("on the curve " + short(x.poolKey) + ": raised " + Number(x.pool.reserveQuote) / 1e9 + " of " + Number(x.pool.graduationTarget) / 1e9 + " SOL, " + Number(((supply - x.pool.reserveBase) * 10000n) / supply) / 100 + " percent of the supply sold, price " + (Number(effectiveQuote(x.pool)) / Number(x.pool.reserveBase)).toExponential(4) + " lamports per unit");
    }
  }
  const fresh = async (x) => decodePool((await conn.getAccountInfo(x.poolKey)).data);
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  // graduate on a seeded pool, and on a pool on the curve below its target
  {
    const seeded = pools.find((x) => x.pool.curveState === CURVE_NONE);
    if (seeded) { const s = await simulate([graduateIx(seeded.poolKey, seeded.pool)], payer); check(errorOf(s) === String(ERR.NotOnCurve) && failedIn(s, HOOKPOOL), "graduate on a seeded pool (" + short(seeded.poolKey) + "): " + ERR.NotOnCurve + " NotOnCurve"); }
    const below = pools.find((x) => x.pool.curveState === CURVE_OPEN && x.pool.reserveQuote < x.pool.graduationTarget);
    if (below) {
      // below the target graduate lands and does nothing; 6048 GraduationNotReached is returned by nothing
      const read = await conn.getMultipleAccountsInfo([below.poolKey, below.pool.baseMint]);
      const s = await simulate([graduateIx(below.poolKey, below.pool)], payer, [below.poolKey, below.pool.baseMint]);
      check(!s.err && s.accounts[0].data.equals(read[0].data) && s.accounts[1].data.equals(read[1].data) && (!s.hasInner || eventsOf(s, "Graduated", HOOKPOOL).length === 0),
        "graduate on a pool on the curve below its target (" + short(below.poolKey) + ", " + below.pool.reserveQuote + " of " + below.pool.graduationTarget + " lamports) succeeds and does nothing: the same pool bytes, the same mint, no event" + (s.err ? "  (error " + errorOf(s) + ")" : ""));
    } else note("no pool on the curve below its target: graduate below the target is not checked");
  }
  // graduate on a pool past its target: what it does, by simulation (nothing is sent)
  const past = curvePools.filter((x) => x.pool.curveState === CURVE_OPEN && x.pool.reserveQuote >= x.pool.graduationTarget);
  for (const x of past.slice(0, perKind)) {
    const tag = "past its target " + short(x.poolKey) + ": ";
    const read = await conn.getMultipleAccountsInfoAndContext([x.poolKey, x.pool.baseMint, x.pool.baseVault, x.pool.quoteVault], "confirmed");
    const before = decodePool(read.value[0].data);
    if (before.curveState !== CURVE_OPEN) { note(tag + "somebody graduated it meanwhile"); continue; }
    const supply = u64(read.value[1].data, 36), baseVault = u64(read.value[2].data, 64), quoteVault = u64(read.value[3].data, 64);
    await guarded(x.poolKey, before, tag, async () => {
    const g = graduationOf(before.reserveBase, before.reserveQuote, before.virtualQuote, before.graduationTarget, before.graduationFeeBps);
    const watch = [x.poolKey, x.pool.baseMint, x.pool.baseVault, x.pool.quoteVault];
    const sim = await simulate([graduateIx(x.poolKey, before)], payer, watch);
    if (sim.err) { check(false, tag + "graduate, sent by a wallet that never touched the pool, succeeds  (error " + errorOf(sim) + ")"); return; }
    const after = decodePool(sim.accounts[0].data);
    check(after.reserveBase === g.baseAfter && after.reserveQuote === g.quoteAfter && after.protocolFeesQuote === before.protocolFeesQuote + g.fee && after.virtualQuote === 0n && after.graduationTarget === 0n && after.curveState === CURVE_GRADUATED && after.graduationFeeBps === before.graduationFeeBps && after.swaps === before.swaps,
      tag + "graduate, sent by a wallet that never touched the pool: fee = min(target * bps / 10000, R - 1) = " + g.fee + ", R2 = R - fee, B2 = floor(R2 * B / (R + V)) = " + g.baseAfter + "; the pool then holds B2 and R2, no virtual quote, no target, state 2, the fee in protocol fees owed (392)");
    check(u64(sim.accounts[1].data, 36) === supply - g.burned && u64(sim.accounts[2].data, 64) === baseVault - g.burned && u64(sim.accounts[3].data, 64) === quoteVault, tag + "it burns B - B2 = " + g.burned + " coins from the base vault, the mint's supply falls by them, the quote vault does not move");
    check(priceKept(effectiveQuote(before), before.reserveBase, after.reserveQuote, after.reserveBase), tag + "the price is kept: R2 / B2 is not below (R + V) / B, and above it by less than one unit of the coin");
    check(sim.returnData === null, tag + "graduate sets no return data");
    if (sim.hasInner) {
      const evs = eventsOf(sim, "Graduated", HOOKPOOL);
      const e = evs.length === 1 ? evs[0].body : null;
      check(!!e && e.length === LAYOUT.graduated.size && key(e, 0).equals(x.poolKey) && u64(e, 32) === before.reserveQuote && u64(e, 40) === g.quoteAfter && u64(e, 48) === before.reserveBase && u64(e, 56) === g.baseAfter && u64(e, 64) === g.burned && u64(e, 72) === g.fee,
        tag + "one Graduated, an inner instruction of the pool program, 88 bytes: pool, reserve_quote before and after, reserve_base before and after, coins burned, fee, slot");
    }
    const u = unitsOf(sim, HOOKPOOL);
    if (u) { addCu("graduate", "", u); check(u < 200_000, tag + "graduate uses " + u + " compute units: the default budget is enough"); }
    // a second graduate in the same transaction lands and changes nothing
    const twice = await simulate([graduateIx(x.poolKey, before), graduateIx(x.poolKey, before)], payer, [x.poolKey, x.pool.baseMint]);
    check(!twice.err && twice.accounts[0].data.equals(sim.accounts[0].data) && u64(twice.accounts[1].data, 36) === supply - g.burned && (!twice.hasInner || eventsOf(twice, "Graduated", HOOKPOOL).length === 1),
      tag + "a second graduate right after the first succeeds and changes nothing: the same pool bytes, the same supply, one Graduated");
    // section 14: a trade on a pool at or past its target sends graduate in front of it and
    // is quoted on the pool as graduation leaves it, exact whoever graduates first
    const userBase = ataOf(payer, before.baseMint, before.baseTokenProgram);
    const amountIn = 100_000_000n;
    const pre = [budget, createAta(payer, payer, before.baseMint, before.baseTokenProgram), ...wrap(payer, amountIn)];
    const onCurve = quote(before.reserveBase, before.reserveQuote, before.lpFeeBps, platform.protocolFeeBps, true, amountIn, 0, null, before.virtualQuote);
    const onGraduated = quote(g.baseAfter, g.quoteAfter, before.lpFeeBps, platform.protocolFeeBps, true, amountIn, 0, null, 0n);
    const buy = swapIx(x.poolKey, before, payer, userBase, userQuote, 0, amountIn, 0n, []);
    if (hasHook(before)) { note(tag + "a pool with a hook: the trades around a graduation are checked on pools without one"); return; }
    let s = await simulate([...pre, graduateIx(x.poolKey, before), buy], payer, [userBase, x.poolKey]);
    check(!s.err && s.out === onGraduated.out && u64(s.accounts[0].data, 64) === onGraduated.out && decodePool(s.accounts[1].data).curveState === CURVE_GRADUATED,
      tag + "graduate in front of a buy: the pool graduates, and the buy is paid what the formula gives on the pool as graduation leaves it (B2, R2, no virtual quote): " + onGraduated.out + " units (" + onCurve.out + " on the curve)" + (s.err ? "  (error " + errorOf(s) + ")" : ""));
    s = await simulate([...pre, graduateIx(x.poolKey, before), graduateIx(x.poolKey, before), buy], payer, [userBase]);
    check(!s.err && u64(s.accounts[0].data, 64) === onGraduated.out, tag + "the same buy when somebody else's graduate landed first: its own graduate does nothing and it is paid the same " + onGraduated.out + " units: the quote is exact whoever graduates first" + (s.err ? "  (error " + errorOf(s) + ")" : ""));
    });
  }
  if (!past.length) note("no pool on the curve stands past its target: graduate is not simulated (the graduation arithmetic is still checked on the events of graduated pools below)");
  // a buy that crosses the target from below: quoted on the curve, graduate right after it
  {
    const balance = BigInt(await conn.getBalance(payer));
    const crossing = (x) => ((x.pool.graduationTarget - x.pool.reserveQuote) * 10000n) / BigInt(10000 - platform.protocolFeeBps) + 1_000_000n;
    const near = curvePools.filter((x) => x.pool.curveState === CURVE_OPEN && !hasHook(x.pool) && x.pool.baseTokenProgram.equals(TOKEN) && x.pool.reserveQuote < x.pool.graduationTarget && crossing(x) + 500_000_000n < balance)
      .sort((a, b) => Number(b.pool.reserveQuote - a.pool.reserveQuote));
    for (const x of near.slice(0, 1)) {
      const tag = "a buy that crosses the target " + short(x.poolKey) + ": ";
      const before = decodePool((await conn.getAccountInfo(x.poolKey)).data);
      if (before.curveState !== CURVE_OPEN || before.reserveQuote >= before.graduationTarget) { note(tag + "the pool moved meanwhile"); continue; }
      await guarded(x.poolKey, before, tag, async () => {
      const amountIn = crossing({ pool: before });
      const userBase = ataOf(payer, before.baseMint, before.baseTokenProgram);
      const pre = [budget, createAta(payer, payer, before.baseMint, before.baseTokenProgram), ...wrap(payer, amountIn)];
      const q = quote(before.reserveBase, before.reserveQuote, before.lpFeeBps, platform.protocolFeeBps, true, amountIn, 0, null, before.virtualQuote);
      const g = graduationOf(q.reserveBase, q.reserveQuote, before.virtualQuote, before.graduationTarget, before.graduationFeeBps);
      const buy = swapIx(x.poolKey, before, payer, userBase, userQuote, 0, amountIn, q.out, []);
      let s = await simulate([...pre, buy, graduateIx(x.poolKey, before)], payer, [userBase, x.poolKey]);
      const after = s.accounts && s.accounts[1] ? decodePool(s.accounts[1].data) : null;
      check(!s.err && u64(s.accounts[0].data, 64) === q.out && !!after && !!g && after.curveState === CURVE_GRADUATED && after.reserveBase === g.baseAfter && after.reserveQuote === g.quoteAfter,
        tag + "a buy of " + amountIn + " lamports from " + before.reserveQuote + " raised, with its minimum at the curve's own quote (" + q.out + " units) and graduate after it: the buy is paid that quote, then the pool graduates on the reserves the buy left" + (s.err ? "  (error " + errorOf(s) + ")" : ""));
      // a sell that takes the pool back under its target lands in between: the graduate does nothing, nothing fails
      const sell = swapIx(x.poolKey, before, payer, userBase, userQuote, 1, q.out, 0n, []);
      s = await simulate([...pre, buy, sell, graduateIx(x.poolKey, before)], payer, [x.poolKey]);
      const mid = s.accounts && s.accounts[0] ? decodePool(s.accounts[0].data) : null;
      check(!s.err && !!mid && mid.curveState === CURVE_OPEN && mid.reserveQuote < mid.graduationTarget && (!s.hasInner || eventsOf(s, "Graduated", HOOKPOOL).length === 0),
        tag + "the same buy, then a sell of what it bought back under the target, then graduate, in one transaction: all land, the graduate does nothing, the pool is still on the curve" + (s.err ? "  (error " + errorOf(s) + ")" : ""));
      });
    }
    if (!near.length) note("no pool on the curve without a hook is close enough to its target for the fee payer to cross it: the crossing buy is not simulated");
  }
  // graduate on a pool that graduated already: nothing happens
  {
    const grad = curvePools.find((x) => x.pool.curveState === CURVE_GRADUATED);
    if (grad) {
      const read = await conn.getMultipleAccountsInfo([grad.poolKey, grad.pool.baseMint]);
      const s = await simulate([graduateIx(grad.poolKey, grad.pool)], payer, [grad.poolKey, grad.pool.baseMint]);
      check(!s.err && s.accounts[0].data.equals(read[0].data) && s.accounts[1].data.equals(read[1].data) && (!s.hasInner || eventsOf(s, "Graduated", HOOKPOOL).length === 0),
        "graduate on a graduated pool (" + short(grad.poolKey) + ") succeeds and does nothing: the same pool bytes, the same mint, no event" + (s.err ? "  (error " + errorOf(s) + ")" : ""));
    } else note("no graduated pool on this cluster: a second graduate is not checked");
  }
  // liquidity is refused while the pool is on the curve, whatever the amounts
  {
    const open = curvePools.find((x) => x.pool.curveState === CURVE_OPEN && !hasHook(x.pool) && x.pool.baseTokenProgram.equals(TOKEN));
    if (open) {
      const p = await fresh(open);
      const most = 1n << 62n;
      const pre = [budget, createAta(payer, payer, p.baseMint, p.baseTokenProgram), ...wrap(payer, 1_000_000n), createAta(payer, payer, p.lpMint)];
      const userLp = ataOf(payer, p.lpMint);
      for (const [name, a, b] of [["add_liquidity", most, most], ["remove_liquidity", 0n, 0n]]) {
        const s = await simulate([...pre, liquidityIx(name, open.poolKey, p, payer, ataOf(payer, p.baseMint, p.baseTokenProgram), userQuote, userLp, 1000n, a, b, [])], payer);
        check(errorOf(s) === String(ERR.CurveOpen) && failedIn(s, HOOKPOOL), "on the curve (" + short(open.poolKey) + "): " + name + " is refused with " + ERR.CurveOpen + " CurveOpen: liquidity opens at graduation");
      }
    } else note("no pool on the curve without a hook: the refusal of liquidity is not simulated");
  }
  // the events of past transactions: CurveOpened at creation, Graduated at graduation, and its arithmetic
  {
    const sample = [...curvePools.filter((x) => x.pool.curveState === CURVE_GRADUATED).slice(0, 6), ...curvePools.filter((x) => x.pool.curveState === CURVE_OPEN).slice(0, 3)];
    let opened = 0, graduated = 0;
    for (const x of sample) {
      const sigs = (await conn.getSignaturesForAddress(x.poolKey, { limit: 1000 })).filter((s) => !s.err).reverse();
      let open = null, grad = null;
      for (const s of sigs.slice(0, 80)) {
        const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        if (!tx || !tx.meta) continue;
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
        const inner = [];
        for (const group of tx.meta.innerInstructions || []) for (const ins of group.instructions) inner.push({ program: keys.get(ins.programIdIndex), accounts: (ins.accounts || []).map((i) => keys.get(i)), data: b58decode(ins.data) });
        const events = inner.filter((i) => i.data.length >= 16 && starts(i.data, EVENT_TAG)).map((i) => ({ program: i.program, disc: [...i.data.subarray(8, 16)], body: i.data.subarray(16) }));
        const at = (name) => events.findIndex((e) => same(e.disc, DISC["event:" + name]) && key(e.body, 0).equals(x.poolKey));
        if (!open && at("CurveOpened") >= 0) open = { slot: BigInt(tx.slot), ev: events[at("CurveOpened")], created: at("PoolCreated") >= 0 ? events[at("PoolCreated")] : null, rightAfter: at("CurveOpened") === at("PoolCreated") + 1 };
        if (!grad && at("Graduated") >= 0) {
          const burns = inner.filter((i) => i.program.equals(x.pool.baseTokenProgram) && (i.data[0] === 8 || i.data[0] === 15) && i.accounts[0] && i.accounts[0].equals(x.pool.baseVault)).map((i) => i.data.readBigUInt64LE(1));
          grad = { slot: BigInt(tx.slot), ev: events[at("Graduated")], burns };
        }
        if (open && (grad || x.pool.curveState === CURVE_OPEN)) break;
      }
      const tag = (x.pool.curveState === CURVE_GRADUATED ? "graduated " : "on the curve ") + short(x.poolKey) + ": ";
      if (!open) { note(tag + "its creation is no longer in the node's history: CurveOpened is not checked"); continue; }
      opened++;
      const o = open.ev.body, v = u64(o, 32), t = u64(o, 40), bps = o.readUInt16LE(48);
      const pc = open.created ? open.created.body : null;
      check(open.ev.program.equals(HOOKPOOL) && o.length === LAYOUT.curve_opened.size && u64(o, 50) === open.slot && open.rightAfter && !!pc && u64(pc, 175) === 0n && u64(pc, 183) === 0n
        && (x.pool.curveState === CURVE_OPEN ? v === x.pool.virtualQuote && t === x.pool.graduationTarget : true) && bps === x.pool.graduationFeeBps
        && (x.pool.curveState === CURVE_OPEN ? x.lpSupply === isqrt(u64(pc, 167) * v) : x.lpSupply >= isqrt(u64(pc, 167) * v)),
        tag + "CurveOpened (58 bytes: pool, virtual quote, target, fee, slot) right after its PoolCreated, whose quote amount and lp minted are 0; its numbers are the pool's; the LP of the creation is floor(sqrt(base amount * virtual quote)) = " + isqrt(u64(pc ? pc : Buffer.alloc(199), 167) * v));
      if (x.pool.curveState !== CURVE_GRADUATED) continue;
      if (!grad) { note(tag + "its graduation is not among the first 80 transactions of its history: the arithmetic is not checked"); continue; }
      graduated++;
      const e = grad.ev.body;
      const rb = u64(e, 32), ra = u64(e, 40), bb = u64(e, 48), ba = u64(e, 56), burned = u64(e, 64), feeQ = u64(e, 72);
      const g = graduationOf(bb, rb, v, t, bps);
      check(grad.ev.program.equals(HOOKPOOL) && e.length === LAYOUT.graduated.size && u64(e, 80) === grad.slot && !!g && g.fee === feeQ && g.quoteAfter === ra && g.baseAfter === ba && g.burned === burned && burned === bb - ba,
        tag + "Graduated (88 bytes): with the CurveOpened numbers, fee = min(" + t + " * " + bps + " / 10000, R - 1) = " + feeQ + ", R2 = " + ra + ", B2 = floor(R2 * " + bb + " / (" + rb + " + " + v + ")) = " + ba + ", burned " + burned + " = B - B2");
      check(priceKept(rb + v, bb, ra, ba) && rb >= t, tag + "its graduation came at or past the target (" + rb + " of " + t + " lamports) and kept the price to one unit of the coin");
      check(grad.burns.length === 1 && grad.burns[0] === burned, tag + "the graduation's transaction burns exactly those " + burned + " units from the pool's base vault (a token Burn, inner instruction of the pool program)");
      check(key(e, 0).equals(x.poolKey) && key(o, 0).equals(x.poolKey) && x.poolKey.equals(pdaOf(["pool", x.pool.baseMint, x.pool.quoteMint], HOOKPOOL)), tag + "CurveOpened and Graduated name the same pool, the address of [\"pool\", base mint, quote mint]: the pool never changes at graduation");
    }
    if (!opened) note("no CurveOpened found in the history of the pools on the curve checked");
    if (curvePools.some((x) => x.pool.curveState === CURVE_GRADUATED) && !graduated) note("no Graduated found in the history of the graduated pools checked");
  }
}

// =====================================================================================================
// D. events of past transactions
// =====================================================================================================
console.log("# events of past transactions");
{
  let seen = 0, bad = 0, launches = 0, liquidity = 0, burns = 0, logged = 0, badLogs = 0;
  // pools whose hook bought at least once: a buyback counts them at 166, a rules pool at 342
  const ran = pools.filter((x) => ((x.template === "buyback" && x.cfg && x.cfg.length === LAYOUT.buyback_config.size && u64(x.cfg, 166) > 0n) || (x.template === "rules" && x.cfg && x.cfg.length === LAYOUT.rules_config.size && u64(x.cfg, 342) > 0n)) && !chosen.includes(x));
  const LOG_SIZES = { Staked: 96, Unstaked: 96, RewardsClaimed: 72, CreatorClaimed: 72, CreatorLocked: 88, CreatorUnlocked: 72, HolderOpened: 72, HolderClaimed: 72, HolderSynced: 72, HolderClosed: 64 };
  for (const x of [...chosen, ...ran.slice(0, 3)]) {
    const sigs = (await conn.getSignaturesForAddress(x.poolKey, { limit: ran.includes(x) ? 40 : 10 })).filter((s) => !s.err);
    for (const s of sigs) {
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!tx || !tx.meta) continue;
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
      const events = [];
      for (const group of tx.meta.innerInstructions || []) for (const ins of group.instructions) {
        const d = b58decode(ins.data);
        if (d.length >= 16 && starts(d, EVENT_TAG)) events.push({ program: keys.get(ins.programIdIndex), disc: [...d.subarray(8, 16)], body: d.subarray(16) });
      }
      for (const e of events) {
        if (same(e.disc, DISC["event:Swapped"]) && key(e.body, 0).equals(x.poolKey)) {
          const ev = decodeSwapped(e.body);
          seen++;
          const afterProtocol = ev.amountIn - ev.protocolFee;
          const ok = e.program.equals(HOOKPOOL) && e.body.length === LAYOUT.swapped.size && ev.direction <= 1 && ev.byHook <= 1 && ev.slot === BigInt(tx.slot) && ev.protocolFee === fee(ev.amountIn, platform.protocolFeeBps)
            && ev.lpFee === fee(ev.direction === 0 ? afterProtocol - ev.hookFee : afterProtocol, ev.feeBps) && ev.reserveBase > 0n && ev.reserveQuote > 0n;
          if (!ok) { bad++; check(false, "Swapped in " + s.signature.slice(0, 12) + ": 132 bytes, slot at 123 = the transaction's slot, protocol fee = fee(amount_in), pool fee = fee(what is left, the bps at 105)"); }
          if (ev.byHook === 1) {
            const name = x.template === "rules" ? "BurnExecuted" : "BuybackExecuted";
            const own = events.find((b) => same(b.disc, DISC["event:" + name]) && b.program.equals(x.pool.hookProgram) && key(b.body, 0).equals(x.poolKey));
            // the observation's quote reserve is the event's real one plus the pool's virtual quote at the time:
            // the pool's now while it is on the curve; a graduated pool had one before its graduation
            const obsQuote = own ? u64(own.body, 65) : -1n;
            const quoteOk = obsQuote === ev.reserveQuote + x.pool.virtualQuote || (x.pool.curveState === CURVE_GRADUATED && obsQuote >= ev.reserveQuote);
            check(ev.user.equals(hookAuthorityOf(x.poolKey, x.pool.hookProgram)) && ev.hookFee === 0n && ev.direction === 0 && !!own && own.body.length === LAYOUT.burn_executed.size && own.body[56] === BURN_BOUGHT && u64(own.body, 32) === ev.amountIn && u64(own.body, 40) >= ev.amountOut && u64(own.body, 48) === BigInt(tx.slot) && u64(own.body, 57) === ev.reserveBase && quoteOk,
              "a " + (x.template === "rules" ? "burn" : "buyback") + " in " + s.signature.slice(0, 12) + ": Swapped has byte 131 set, no hook fee, the hook's authority as signer; " + name + " (73 bytes, outcome 3) is an inner instruction of the hook, spent what the swap took in, and its observation is the reserves the swap left");
          }
        }
        for (const name of ["BuybackExecuted", "BurnExecuted"]) if (same(e.disc, DISC["event:" + name]) && key(e.body, 0).equals(x.poolKey)) {
          burns++;
          const o = e.body[56];
          if (o !== BURN_BOUGHT) check(e.body.length === LAYOUT.burn_executed.size && e.program.equals(x.pool.hookProgram) && (o === BURN_OBSERVED || o === BURN_WAITED) && u64(e.body, 32) === 0n && u64(e.body, 40) === 0n && u64(e.body, 48) === BigInt(tx.slot) && u64(e.body, 57) > 0n && u64(e.body, 65) > 0n,
            name + " in " + s.signature.slice(0, 12) + ": outcome " + o + " (" + (o === BURN_OBSERVED ? "the first observation" : "it waited") + "), nothing spent, nothing burned, the reserves it recorded; 73 bytes");
        }
        if (same(e.disc, DISC["event:LiquidityChanged"]) && key(e.body, 0).equals(x.poolKey)) { liquidity++; check(e.body.length === 113 && e.program.equals(HOOKPOOL) && e.body[64] <= 1 && u64(e.body, 105) === BigInt(tx.slot), "LiquidityChanged in " + s.signature.slice(0, 12) + ": 113 bytes, slot last"); }
      }
      if (x.template === "rules") for (const l of tx.meta.logMessages || []) {
        if (!l.startsWith("Program data: ")) continue;
        const d = Buffer.from(l.slice(14), "base64");
        const name = Object.keys(LOG_SIZES).find((n) => starts(d, DISC["event:" + n]));
        if (!name || d.length < 40 || !key(d, 8).equals(x.poolKey)) continue;
        logged++;
        if (d.length !== 8 + LOG_SIZES[name]) badLogs++;
      }
      const created = events.findIndex((e) => same(e.disc, DISC["event:PoolCreated"]) && key(e.body, 0).equals(x.poolKey));
      const launched = events.findIndex((e) => same(e.disc, DISC["event:Launched"]));
      if (created >= 0 && launched >= 0) {
        launches++;
        const pc = events[created].body, la = events[launched].body;
        const p = x.pool;
        const between = events.slice(created + 1, launched).filter((e) => same(e.disc, DISC["event:Swapped"])).length;
        // a launch on the curve: CurveOpened right after PoolCreated, nothing minted to the creator, the whole LP locked (section 10)
        const opened = events.findIndex((e) => same(e.disc, DISC["event:CurveOpened"]) && key(e.body, 0).equals(x.poolKey));
        const lpOk = opened >= 0
          ? opened === created + 1 && u64(pc, 175) === 0n && u64(pc, 183) === 0n && u64(la, 192) === isqrt(u64(pc, 167) * u64(events[opened].body, 32))
          : u64(pc, 183) === isqrt(u64(pc, 167) * u64(pc, 175)) - 1000n && u64(la, 192) === u64(pc, 183);
        check(pc.length === 199 && la.length === 224 && events[created].program.equals(HOOKPOOL) && events[launched].program.equals(HOOKLAUNCH) && created < launched
          && key(pc, 32).equals(p.baseMint) && key(pc, 64).equals(p.quoteMint) && key(pc, 96).equals(p.creator) && key(pc, 128).equals(p.hookProgram) && pc.readUInt32LE(160) === p.hookFlags && pc[164] === p.hookKind && pc.readUInt16LE(165) === p.lpFeeBps
          && lpOk && u64(pc, 191) === p.createdSlot
          && key(la, 0).equals(pdaOf(["launch", p.baseMint], HOOKLAUNCH)) && key(la, 32).equals(x.poolKey) && key(la, 64).equals(p.creator) && key(la, 96).equals(p.baseMint) && u64(la, 216) === p.createdSlot && between === (u64(la, 208) > 0n ? 1 : 0),
          "launch of " + short(x.poolKey) + ": PoolCreated (199 bytes), " + (opened >= 0 ? "CurveOpened, " : "") + (between ? "the dev buy's Swapped, " : "") + "then Launched (224 bytes); "
            + (opened >= 0 ? "on the curve: quote amount and lp minted 0, lp locked = floor(sqrt(base amount * virtual quote))" : "lp minted = floor(sqrt(base * quote)) - 1000 = lp locked"));
      }
    }
  }
  if (seen) check(bad === 0, seen + " Swapped events found with getSignaturesForAddress(pool) and read from inner instructions: layout, slot and both fee formulas hold");
  else note("no past swap found on the pools checked");
  if (!launches) note("no launch transaction is still in the node's history for the pools checked: PoolCreated and Launched are not checked");
  if (!liquidity) note("no past liquidity change found on the pools checked: LiquidityChanged is checked by simulation only");
  if (!burns) note("no past buyback or burn found on the pools checked: BuybackExecuted and BurnExecuted are checked by simulation only");
  if (logged) check(badLogs === 0, logged + " log events of the rules hook found in past transactions (stakes, claims, locks): each has the size the document gives");
  else note("no past stake, claim or lock found on the rules pools checked: those events are checked by simulation only");
}

// ---- compute units, for the tables of sections 7, 11, 12 and 13 -------------------------------------------------
console.log("# compute units of one instruction alone, as simulated here");
for (const [k, v] of [...cu.entries()].sort()) note((k.endsWith(" | ") ? k.slice(0, -3) : k).padEnd(56) + (Math.min(...v) === Math.max(...v) ? String(v[0]) : Math.min(...v) + " to " + Math.max(...v)) + "   (" + v.length + (v.length === 1 ? " simulation)" : " simulations)"));

console.log("");
console.log(checks + " checks, " + failed + " failed, " + notes + " notes");
process.exit(failed ? 1 : 0);
