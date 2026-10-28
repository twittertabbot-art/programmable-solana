// Reading many transactions at once, paired by their own signature.
//
// web3.js `connection.getTransactions(signatures)` sends one JSON-RPC batch and pairs the
// answers with the signatures by POSITION. Some RPC providers answer a batch in any order
// (each answer carries the right id, but web3.js does not look at it), so a caller that pairs
// by position gets the wrong transaction for a signature. `getTransactionsBySignature` pairs
// every answer by the transaction's own signature instead.
//
// A transaction of a version the request does not support (mainnet carries version 1 now;
// the readers ask with `maxSupportedTransactionVersion: 0`) makes the node answer error
// -32015 for that one signature, and web3.js then throws the whole batch away. This helper
// asks such a batch again one signature at a time, lists the ones that answer -32015 as
// unreadable and keeps the others.
import type { Finality, VersionedTransactionResponse } from "@solana/web3.js";

/// The JSON-RPC error a node answers for a transaction whose version the request does not
/// support ("Transaction version (1) is not supported by the requesting client").
export const UNREADABLE_TRANSACTION_CODE = -32015;

/// True when `e` says this one transaction cannot be read: the node cannot give it in a version
/// the request supports (error -32015), or web3.js cannot take apart what the node gave for it
/// (its answer does not fit web3.js's shape, a `StructError`, or a message of an unknown
/// version). Any other error (network, rate limit, node behind) is false. The helper below asks
/// this only of an answer for one signature.
export function isUnreadableTransactionError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = (e as { code?: unknown }).code;
  if (code === UNREADABLE_TRANSACTION_CODE) return true;
  const message = String((e as { message?: unknown }).message ?? "");
  if ((e as { name?: unknown }).name === "StructError") return true;
  return /transaction version \(\d+\) is not supported|unknown message version/i.test(message);
}

/// A signature the node could not answer in a readable form. Its entry in `transactions` is null.
export interface UnreadableTransaction {
  signature: string;
  code: number | null;
  message: string;
}

export interface TransactionsBySignature {
  /// One entry per signature asked, in the same order as the signatures: the transaction whose
  /// own signature it is, or null (the node has no such transaction yet, or it is unreadable).
  transactions: (VersionedTransactionResponse | null)[];
  /// The signatures whose transaction the node cannot give in a supported version. A reader
  /// skips these for good; a null that is not listed here may still come later.
  unreadable: UnreadableTransaction[];
}

/// What the helper needs of a connection: web3.js `Connection` has both.
export interface TransactionReader {
  getTransactions(signatures: string[], config: any): Promise<(VersionedTransactionResponse | null)[]>;
  getTransaction(signature: string, config: any): Promise<VersionedTransactionResponse | null>;
}

export interface TransactionsBySignatureOptions {
  /// Default 0 (legacy and version 0 transactions).
  maxSupportedTransactionVersion?: number;
  /// Default: the connection's own.
  commitment?: Finality;
  /// Signatures per batched request. Default 100.
  perRequest?: number;
  /// A pause between two batched requests, in milliseconds. Default 0.
  pauseMs?: number;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/// A batch asked again one by one: this many single requests at a time.
const SINGLES_AT_ONCE = 4;

/// The signatures of a transaction answer (the first one names the transaction).
function signaturesOf(tx: any): string[] {
  const s = tx?.transaction?.signatures;
  return Array.isArray(s) ? s.filter((x: unknown): x is string => typeof x === "string") : [];
}

/// getTransaction for every signature, batched, each answer paired by the transaction's own
/// signature (`tx.transaction.signatures[0]`), never by its position in the answer. A
/// signature asked twice is fetched once. A batch the node refuses as a whole (one entry
/// answered with an error) is asked again one signature at a time: an entry that answers
/// -32015 goes to `unreadable`, any other error is thrown.
export async function getTransactionsBySignature(connection: TransactionReader, signatures: string[], opts: TransactionsBySignatureOptions = {}): Promise<TransactionsBySignature> {
  const config: { maxSupportedTransactionVersion: number; commitment?: Finality } = { maxSupportedTransactionVersion: opts.maxSupportedTransactionVersion ?? 0 };
  if (opts.commitment) config.commitment = opts.commitment;
  const perRequest = Math.max(1, Math.floor(opts.perRequest ?? 100));
  const pauseMs = opts.pauseMs ?? 0;
  const wanted = [...new Set(signatures)];
  const found = new Map<string, VersionedTransactionResponse>();
  const unreadable: UnreadableTransaction[] = [];
  const keep = (part: Set<string>, tx: VersionedTransactionResponse | null | undefined) => {
    if (!tx) return;
    for (const s of signaturesOf(tx)) if (part.has(s) && !found.has(s)) found.set(s, tx);
  };
  for (let i = 0; i < wanted.length; i += perRequest) {
    if (i > 0 && pauseMs > 0) await pause(pauseMs);
    const part = wanted.slice(i, i + perRequest);
    const inPart = new Set(part);
    let answers: (VersionedTransactionResponse | null)[] | null = null;
    try {
      answers = await connection.getTransactions(part, config);
    } catch {
      answers = null;
    }
    if (answers) {
      for (const tx of answers) keep(inPart, tx);
      continue;
    }
    // The batch failed as a whole: one signature a request (four at a time), so one unreadable
    // transaction does not take the others with it. A network error throws here.
    const one = async (s: string) => {
      try {
        keep(inPart, await connection.getTransaction(s, config));
      } catch (e) {
        if (!isUnreadableTransactionError(e)) throw e;
        const code = (e as { code?: unknown }).code;
        unreadable.push({ signature: s, code: typeof code === "number" ? code : null, message: String((e as { message?: unknown }).message ?? e) });
      }
    };
    for (let j = 0; j < part.length; j += SINGLES_AT_ONCE) await Promise.all(part.slice(j, j + SINGLES_AT_ONCE).map(one));
  }
  // in the order asked, whatever order the requests above finished in
  const order = new Map(wanted.map((s, i) => [s, i]));
  unreadable.sort((a, b) => (order.get(a.signature) ?? 0) - (order.get(b.signature) ?? 0));
  return { transactions: signatures.map((s) => found.get(s) ?? null), unreadable };
}
