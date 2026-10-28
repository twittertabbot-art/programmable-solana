// The client side of the loyalty_points hook: its instructions, addresses and decoders.
// A third-party hook ships something like this next to its program, because the Programmable
// SDK knows nothing about a custom hook's own instructions or accounts.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { sdk, conn, disc, u64 } from "../proof-lib.mjs";

const { pda } = sdk;

/// A wallet's points account in one pool: PDA ["points", pool, wallet] of the hook program.
export const pointsAddress = (program, pool, wallet) =>
  PublicKey.findProgramAddressSync([Buffer.from("points"), pool.toBuffer(), wallet.toBuffer()], program)[0];

/// init_pool_config(pool, quote_per_point): accounts payer, cfg, system program.
/// It goes into transaction 1 of a launch, before the pool exists.
export function initPoolConfigIx(program, payer, pool, quotePerPoint) {
  return new TransactionInstruction({
    programId: program,
    data: Buffer.concat([disc("init_pool_config"), pool.toBuffer(), u64(quotePerPoint)]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: pda.cfg(program, pool), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

/// open_points(): accounts owner (signs and pays the rent), pool, points, system program.
/// A wallet sends it once per pool, alone or in front of its first buy.
export function openPointsIx(program, owner, pool) {
  return new TransactionInstruction({
    programId: program,
    data: Buffer.from(disc("open_points")),
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: pointsAddress(program, pool, owner), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

/// Config after the 8-byte account discriminator: bump u8 | pool 32 | creator 32 |
/// quote_per_point u64 | live bool | total_points u64 | buys_seen u64 | buys_rewarded u64
export function decodeConfig(data) {
  const b = Buffer.from(data);
  let o = 8 + 1;
  const pool = new PublicKey(b.subarray(o, o + 32)); o += 32;
  const creator = new PublicKey(b.subarray(o, o + 32)); o += 32;
  const quotePerPoint = b.readBigUInt64LE(o); o += 8;
  const live = b.readUInt8(o) === 1; o += 1;
  const totalPoints = b.readBigUInt64LE(o); o += 8;
  const buysSeen = b.readBigUInt64LE(o); o += 8;
  const buysRewarded = b.readBigUInt64LE(o);
  return { pool, creator, quotePerPoint, live, totalPoints, buysSeen, buysRewarded };
}

/// Points after the 8-byte account discriminator: bump u8 | pool 32 | owner 32 | points u64 | buys u64
export function decodePoints(data) {
  const b = Buffer.from(data);
  let o = 8 + 1;
  const pool = new PublicKey(b.subarray(o, o + 32)); o += 32;
  const owner = new PublicKey(b.subarray(o, o + 32)); o += 32;
  const points = b.readBigUInt64LE(o); o += 8;
  const buys = b.readBigUInt64LE(o);
  return { pool, owner, points, buys };
}

export async function readConfig(program, pool) {
  const a = await conn.getAccountInfo(pda.cfg(program, pool));
  return a ? decodeConfig(a.data) : null;
}
/// null = the wallet never opened a points account for this pool.
export async function readPoints(program, pool, wallet) {
  const a = await conn.getAccountInfo(pointsAddress(program, pool, wallet));
  return a && a.owner.equals(program) ? decodePoints(a.data) : null;
}
