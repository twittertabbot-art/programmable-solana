// Browser entry: the SDK plus the pieces of web3.js the site needs, in one module.
export * from "./index.js";
export {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction, VersionedTransaction, TransactionMessage, LAMPORTS_PER_SOL, SystemProgram, ComputeBudgetProgram,
  AddressLookupTableAccount,
} from "@solana/web3.js";
