import { PublicKey } from "@solana/web3.js";
import { ATA_PROGRAM, BPF_LOADER_UPGRADEABLE, METAPLEX_METADATA, PROGRAMS, SEEDS, TOKEN_PROGRAM } from "./constants.js";

const P = PROGRAMS.hookpool;

export const pda = {
  platform: () => PublicKey.findProgramAddressSync([SEEDS.platform], P)[0],
  /// The address the pool program signs a hook's callbacks with: one per hook program,
  /// `["caller", hookProgram]`. Pass the pool's hook program, which is the system program
  /// for a pool without a hook (`pool.hookProgram` is right in both cases). There is no
  /// default on purpose: an address derived for the wrong hook fails on chain with
  /// ConstraintSeeds (2006).
  caller: (hookProgram: PublicKey) => {
    if (!hookProgram || typeof hookProgram.toBuffer !== "function") throw new Error("pda.caller needs the pool's hook program (the system program for a pool without a hook)");
    return PublicKey.findProgramAddressSync([SEEDS.caller, hookProgram.toBuffer()], P);
  },
  pool: (baseMint: PublicKey, quoteMint: PublicKey) =>
    PublicKey.findProgramAddressSync([SEEDS.pool, baseMint.toBuffer(), quoteMint.toBuffer()], P)[0],
  vault: (pool: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync([SEEDS.vault, pool.toBuffer(), mint.toBuffer()], P)[0],
  lpMint: (pool: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.lpMint, pool.toBuffer()], P)[0],
  lpLock: (pool: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.lpLock, pool.toBuffer()], P)[0],
  hookAuthority: (pool: PublicKey, hookProgram: PublicKey) =>
    PublicKey.findProgramAddressSync([SEEDS.hookAuthority, pool.toBuffer()], hookProgram),
  manifest: (hookProgram: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.manifest], hookProgram)[0],
  extraMetas: (hookProgram: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.extraMetas], hookProgram)[0],
  cfg: (hookProgram: PublicKey, pool: PublicKey) =>
    PublicKey.findProgramAddressSync([SEEDS.cfg, pool.toBuffer()], hookProgram)[0],
  launch: (baseMint: PublicKey) =>
    PublicKey.findProgramAddressSync([SEEDS.launch, baseMint.toBuffer()], PROGRAMS.hooklaunch)[0],
  eventAuthority: (programId: PublicKey) => PublicKey.findProgramAddressSync([SEEDS.eventAuthority], programId)[0],
  programData: (programId: PublicKey) =>
    PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0],
  metadata: (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([SEEDS.metadata, METAPLEX_METADATA.toBuffer(), mint.toBuffer()], METAPLEX_METADATA)[0],
  ata: (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM) =>
    PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0],
};
