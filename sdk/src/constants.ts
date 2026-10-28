import { PublicKey } from "@solana/web3.js";

export const PROGRAMS = {
  hookpool: new PublicKey("7CL4KGeaZFsNYqEjErwTezMYuAE54185TieqLQnGjdgh"),
  hooklaunch: new PublicKey("9cDfF7wD6EirDZbb5DWCw3HZ3ZPQ1oeh87YyMGvbPRxi"),
  hook_tax: new PublicKey("jwdXDuSQ9pNV1pXj8BFvBb5fhqtTL3duQkwsTjXunhr"),
  hook_launch_guard: new PublicKey("G59xnMnbenifbGR1y6QjaTRa6wa1FFfqZB3KZBUyckPW"),
  hook_buyback: new PublicKey("3M824Hn8Z6S7r1t1zqpNQpioKFd31jrQwSN2oxV2ovo5"),
  hook_collectible: new PublicKey("3WCHK9zmFdndiUMZmFcn7vBbTSdssduN9zuR6vfSFr9m"),
  hook_rules: new PublicKey("3zSXfe6Wnt43h8ZZ1FkUmJo6rDqvQZX9sjYxHaHBTxAr"),
};

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
export const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");
/// The Clock sysvar: the slot and the Unix time the programs see (`client.chainTime`).
export const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");
export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const LOADER_V4 = new PublicKey("LoaderV411111111111111111111111111111111111");
export const METAPLEX_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export const SEEDS = {
  platform: Buffer.from("platform"),
  pool: Buffer.from("pool"),
  vault: Buffer.from("vault"),
  lpMint: Buffer.from("lp"),
  lpLock: Buffer.from("lp-lock"),
  caller: Buffer.from("caller"),
  hookAuthority: Buffer.from("hook-authority"),
  manifest: Buffer.from("manifest"),
  extraMetas: Buffer.from("extra-metas"),
  cfg: Buffer.from("cfg"),
  launch: Buffer.from("launch"),
  metadata: Buffer.from("metadata"),
  eventAuthority: Buffer.from("__event_authority"),
  // hook_rules
  stake: Buffer.from("stake"),
  stakeVault: Buffer.from("stake-vault"),
  lock: Buffer.from("lock"),
  lockVault: Buffer.from("lock-vault"),
  // hook_rules, strict coin
  holder: Buffer.from("holder"),
  transferHookMetas: Buffer.from("extra-account-metas"),
};
/// Anchor event-CPI: inner instruction data starts with this tag, then the event.
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export const FLAGS = {
  BEFORE_SWAP: 1 << 0,
  AFTER_SWAP: 1 << 1,
  BEFORE_ADD_LIQ: 1 << 2,
  AFTER_ADD_LIQ: 1 << 3,
  BEFORE_REMOVE_LIQ: 1 << 4,
  AFTER_REMOVE_LIQ: 1 << 5,
  ON_POOL_CREATE: 1 << 6,
  OVERRIDE_FEE: 1 << 8,
  TAKE_HOOK_FEE: 1 << 9,
  OVERRIDE_CURVE: 1 << 10,
  CALL_ON_BUY: 1 << 12,
  CALL_ON_SELL: 1 << 13,
} as const;

export const HOOK_KIND = { NONE: 0, FROZEN: 1, PLATFORM: 2 } as const;
export const DIRECTION = { BUY: 0, SELL: 1 } as const;
/// `Pool.curveState`: a seeded pool (0), a pool on the curve (1), a pool that graduated (2).
export const CURVE_NONE = 0;
export const CURVE_OPEN = 1;
export const CURVE_GRADUATED = 2;
/// `Launch.reserved[0]` (byte 201 of the record) on a launch made with `launch_curve`.
export const LAUNCH_KIND_CURVE = 1;
/// The platform's curve settings as `init_platform` writes them (the interface crate's
/// constants). The SDK never computes with these: it reads the platform account and the
/// pool, which carry the settings a pool was created with.
export const DEFAULT_CURVE_VIRTUAL_QUOTE = 30_000_000_000n;
export const DEFAULT_CURVE_GRADUATION_TARGET = 85_000_000_000n;
/// The most `update_platform` takes for the graduation fee (`FeeTooHigh` above).
export const HARD_MAX_GRADUATION_FEE_BPS = 1_000;
export const MINIMUM_LIQUIDITY = 1000n;
export const LP_DECIMALS = 6;
export const BPS = 10_000n;

/// Fixed account positions inside a hook callback (HOOKS.md 3.1).
export const CB_IDX = { POOL: 0, CALLER: 1, USER: 2, QUOTE_MINT: 3, BASE_MINT: 4 } as const;
