// The client side of the early_bird hook: its one setup instruction and the decoder of
// its Config account. A third-party hook ships something like this next to its program,
// because the Programmable SDK knows nothing about a custom hook's own instructions.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { sdk, disc, u16, u64 } from "../proof-lib.mjs";

const { pda } = sdk;

/// init_pool_config(pool, window_slots, discount_bps): accounts payer, cfg, system program.
/// It goes into transaction 1 of a launch, before the pool exists.
export function initPoolConfigIx(program, payer, pool, windowSlots, discountBps) {
  return new TransactionInstruction({
    programId: program,
    data: Buffer.concat([disc("init_pool_config"), pool.toBuffer(), u64(windowSlots), u16(discountBps)]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: pda.cfg(program, pool), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

/// Config after the 8-byte account discriminator:
/// bump u8 | pool 32 | creator 32 | window_slots u64 | discount_bps u16 | created_slot u64
export function decodeConfig(data) {
  const b = Buffer.from(data);
  let o = 8;
  const bump = b.readUInt8(o); o += 1;
  const pool = new PublicKey(b.subarray(o, o + 32)); o += 32;
  const creator = new PublicKey(b.subarray(o, o + 32)); o += 32;
  const windowSlots = b.readBigUInt64LE(o); o += 8;
  const discountBps = b.readUInt16LE(o); o += 2;
  const createdSlot = b.readBigUInt64LE(o);
  return { bump, pool, creator, windowSlots, discountBps, createdSlot };
}
